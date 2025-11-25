// ============================================================================
// COMPARABLE COMPANY ANALYSIS WORKFLOW
// ============================================================================
// This workflow values a company relative to its industry peers using
// valuation multiples like P/E, P/B, P/S, PEG, and EV/EBITDA.
//
// Key concept: If similar companies trade at 20x earnings, and our company
// has the same quality metrics, it should also trade at 20x earnings.
// ============================================================================

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

// Import existing tools instead of duplicating API calls
import { getFinancialRatiosTool } from '../tools/fundamental-tools';
import { getStockPriceTool, getFinancialsTool } from '../tools/equity-tools';

// Initialize OpenAI model for AI-powered analysis
const llm = openai('gpt-4o');

// ============================================================================
// VALUATION AGENT
// ============================================================================
// This specialized agent handles the analytical synthesis of comparable data.
// ============================================================================
const comparableAgent = new Agent({
  name: 'Comparable Analysis Specialist',
  model: llm,
  instructions: `
    You are a valuation expert specializing in comparable company analysis.

    Provide clear, data-driven valuation analysis with:
    - Peer group averages for all valuation multiples
    - Comparison of target company vs peer averages
    - Identification of premium/discount to peers
    - Implied fair value using peer multiples
    - Investment recommendation based on relative valuation

    Always explain your methodology and be transparent about limitations.
  `,
});

// ============================================================================
// ZOD SCHEMAS
// ============================================================================
// Define schemas for type safety and validation

// Schema for the target company's data (the company we're valuing)
const companyDataSchema = z.object({
  name: z.string(),                            // Company name
  price: z.number(),                           // Current stock price
  marketCap: z.number(),                       // Market capitalization
  peRatio: z.number().nullable(),              // Price-to-Earnings ratio
  pbRatio: z.number().nullable(),              // Price-to-Book ratio
  psRatio: z.number().nullable(),              // Price-to-Sales ratio
  pegRatio: z.number().nullable(),             // PEG ratio (P/E divided by growth)
  evToEbitda: z.number().nullable(),           // Enterprise Value to EBITDA
  revenueGrowth: z.number().nullable(),        // Revenue growth % (for context)
  profitMargin: z.number().nullable(),         // Profit margin % (for quality assessment)
});

// Schema for peer company data (competitors/similar companies)
const peerDataSchema = z.object({
  ticker: z.string(),                          // Peer ticker symbol
  name: z.string(),                            // Peer company name
  peRatio: z.number().nullable(),              // Peer P/E ratio
  pbRatio: z.number().nullable(),              // Peer P/B ratio
  psRatio: z.number().nullable(),              // Peer P/S ratio
  pegRatio: z.number().nullable(),             // Peer PEG ratio
  evToEbitda: z.number().nullable(),           // Peer EV/EBITDA
});

// ============================================================================
// STEP 1: FETCH DATA
// ============================================================================
// This step fetches valuation multiples for the target company and peers
// by calling existing tools instead of duplicating API calls.
//
// TOOLS USED:
// - getStockPriceTool: Current price, market cap
// - getFinancialRatiosTool: All valuation multiples (P/E, P/B, P/S, PEG, EV/EBITDA)
// - getFinancialsTool: Revenue growth and profit margins
// ============================================================================
const fetchComparables = createStep({
  id: 'fetch-comparables',
  description: 'Fetches valuation metrics for company and peers using existing tools',

  // INPUT: Target ticker + optional list of peer tickers
  // Example: { ticker: 'AAPL', peers: ['MSFT', 'GOOGL', 'META'] }
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
    peers: z.array(z.string()).optional().describe('Peer company tickers'),
  }),

  // OUTPUT: Company data + array of peer data
  outputSchema: z.object({
    ticker: z.string(),
    companyData: companyDataSchema,      // Full data for target company
    peerData: z.array(peerDataSchema),   // Valuation multiples for each peer
  }),

  execute: async ({ inputData, runtimeContext }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker.toUpperCase();
    const peers = inputData.peers || [];

    try {
      // ========== FETCH TARGET COMPANY DATA ==========
      // Call existing tools to get comprehensive data
      // runtimeContext is passed from the step's execute parameters (Mastra pattern)

      // Get price and market cap
      const priceData = await getStockPriceTool.execute({
        context: { ticker },
        runtimeContext,
      });

      // Get all financial ratios (includes valuation multiples)
      const ratiosData = await getFinancialRatiosTool.execute({
        context: { ticker },
        runtimeContext,
      });

      // Get revenue growth and profit margins
      const financialsData = await getFinancialsTool.execute({
        context: { ticker },
        runtimeContext,
      });

      // Build the company data object with all valuation multiples
      const companyData = {
        name: financialsData.companyName,
        price: priceData.price,
        marketCap: parseFloat(priceData.marketCap.replace(/[$BTM]/g, '')) *
                  (priceData.marketCap.includes('T') ? 1e12 :
                   priceData.marketCap.includes('B') ? 1e9 :
                   priceData.marketCap.includes('M') ? 1e6 : 1),
        peRatio: ratiosData.valuation.peRatio,
        pbRatio: ratiosData.valuation.pbRatio,
        psRatio: ratiosData.valuation.psRatio,
        pegRatio: ratiosData.valuation.pegRatio,
        evToEbitda: ratiosData.valuation.evToEbitda,
        revenueGrowth: financialsData.revenueGrowth,
        profitMargin: financialsData.profitMargin,
      };

      // ========== FETCH PEER COMPANY DATA ==========
      // Use Promise.all to fetch all peer data in parallel (faster)
      const peerData = await Promise.all(
        peers.map(async (peerTicker) => {
          try {
            // Fetch ratios data for each peer using the tool
            const peerRatiosData = await getFinancialRatiosTool.execute({
              context: { ticker: peerTicker },
              runtimeContext,
            });

            // Build peer data object (only valuation multiples needed)
            return {
              ticker: peerTicker,
              name: peerRatiosData.companyName,
              peRatio: peerRatiosData.valuation.peRatio,
              pbRatio: peerRatiosData.valuation.pbRatio,
              psRatio: peerRatiosData.valuation.psRatio,
              pegRatio: peerRatiosData.valuation.pegRatio,
              evToEbitda: peerRatiosData.valuation.evToEbitda,
            };
          } catch (error) {
            // If a peer fails to load, log warning but don't crash the workflow
            console.warn(`Failed to fetch data for peer ${peerTicker}:`, error);
            return null;
          }
        })
      );

      // Return company data + peer data (filtering out any null peers)
      return {
        ticker,
        companyData,
        peerData: peerData.filter((peer): peer is NonNullable<typeof peer> => peer !== null),
      };
    } catch (error) {
      throw new Error(`Failed to fetch comparable data for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// STEP 2: ANALYZE & COMPARE
// ============================================================================
// This step takes the company and peer data and uses AI to:
// 1. Calculate peer group averages for all valuation multiples
// 2. Compare the target company to peer averages
// 3. Determine if the company is overvalued or undervalued
// 4. Explain any premium/discount based on growth and quality metrics
// 5. Calculate implied fair value using peer multiples
// 6. Provide investment recommendation
// ============================================================================
const analyzeComparables = createStep({
  id: 'analyze-comparables',
  description: 'Analyzes valuation vs peers',

  // INPUT: All the data from the previous step
  inputSchema: z.object({
    ticker: z.string(),
    companyData: companyDataSchema,
    peerData: z.array(peerDataSchema),
  }),

  // OUTPUT: Comprehensive comparable analysis as text
  outputSchema: z.object({
    analysis: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    // Build a detailed prompt for the AI valuation agent
    // Format company data clearly, then list all peer companies
    const prompt = `Perform a comparable company analysis for ${inputData.ticker}:

COMPANY: ${inputData.companyData.name}
- Price: $${inputData.companyData.price}
- Market Cap: $${(inputData.companyData.marketCap / 1e9).toFixed(2)}B
- P/E Ratio: ${inputData.companyData.peRatio?.toFixed(2) || 'N/A'}
- P/B Ratio: ${inputData.companyData.pbRatio?.toFixed(2) || 'N/A'}
- P/S Ratio: ${inputData.companyData.psRatio?.toFixed(2) || 'N/A'}
- PEG Ratio: ${inputData.companyData.pegRatio?.toFixed(2) || 'N/A'}
- EV/EBITDA: ${inputData.companyData.evToEbitda?.toFixed(2) || 'N/A'}
- Revenue Growth: ${inputData.companyData.revenueGrowth?.toFixed(2) || 'N/A'}%
- Profit Margin: ${inputData.companyData.profitMargin?.toFixed(2) || 'N/A'}%

PEER COMPANIES:
${inputData.peerData.map((peer: any, idx: number) => `
${idx + 1}. ${peer.name} (${peer.ticker})
   P/E: ${peer.peRatio?.toFixed(2) || 'N/A'} | P/B: ${peer.pbRatio?.toFixed(2) || 'N/A'} | P/S: ${peer.psRatio?.toFixed(2) || 'N/A'} | PEG: ${peer.pegRatio?.toFixed(2) || 'N/A'} | EV/EBITDA: ${peer.evToEbitda?.toFixed(2) || 'N/A'}
`).join('')}

Provide a comprehensive comparable company analysis:
1. Calculate peer group averages for each metric
2. Compare company metrics to peer averages
3. Identify if company is overvalued or undervalued vs peers
4. Explain any premium/discount (growth, quality, market position)
5. Calculate implied fair value using peer multiples
6. Provide valuation recommendation

Format clearly with specific numbers and insights.`;

    // Send the prompt to the valuation agent and stream the response
    const response = await comparableAgent.streamLegacy([
      {
        role: 'user',
        content: prompt,
      },
    ]);

    // Collect the streamed response chunks into full text
    let analysisText = '';

    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);  // Display in real-time
      analysisText += chunk;         // Build the full response
    }

    // Return the complete comparable analysis
    return {
      analysis: analysisText,
    };
  },
});

// ============================================================================
// COMPARABLE ANALYSIS WORKFLOW DEFINITION
// ============================================================================
// This workflow chains together the two steps above:
// 1. fetchComparables - Gets valuation multiples for target company and peers
// 2. analyzeComparables - AI compares multiples and determines relative value
//
// USAGE:
//   const result = await comparableAnalysisWorkflow.execute({
//     ticker: 'AAPL',
//     peers: ['MSFT', 'GOOGL', 'META']
//   });
//   console.log(result.analysis); // Full peer comparison analysis
//
// NOTE: Peers should be companies in the same industry/sector for accurate
// comparison. For example:
// - Tech: AAPL, MSFT, GOOGL, META, NVDA
// - Retail: WMT, TGT, COST, AMZN
// - Banks: JPM, BAC, WFC, C
// ============================================================================
export const comparableAnalysisWorkflow = createWorkflow({
  id: 'comparable-analysis-workflow',

  // INPUT: Target ticker + array of peer tickers
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol to analyze'),
    peers: z.array(z.string()).optional().describe('Peer company tickers for comparison'),
  }),

  // OUTPUT: Complete peer comparison analysis as text
  outputSchema: z.object({
    analysis: z.string(),
  }),
})
  .then(fetchComparables)      // Step 1: Fetch company + peer data
  .then(analyzeComparables);    // Step 2: Compare and analyze

// Commit the workflow to make it executable
comparableAnalysisWorkflow.commit();
