// ============================================================================
// DCF VALUATION WORKFLOW
// ============================================================================
// This workflow calculates intrinsic value using the Discounted Cash Flow model.
//
// It leverages existing tools from fundamental-tools.ts and equity-tools.ts
// to fetch data, avoiding code duplication and ensuring consistency.
// ============================================================================

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

// Import existing tools instead of duplicating API calls
import { getCashFlowTool, getBalanceSheetTool } from '../tools/fundamental-tools';
import { getStockPriceTool, getFinancialsTool } from '../tools/equity-tools';

// Import the quantitative DCF calculator
import { calculateDCF, assessValuation, formatDCFResults } from '../lib/dcf-calculator';

// Initialize OpenAI model for AI-powered analysis
const llm = openai('gpt-4o');

// ============================================================================
// VALUATION AGENT
// ============================================================================
// This specialized agent handles the analytical synthesis of valuation data.
// It takes raw financial data and produces human-readable valuation reports.
// ============================================================================
const valuationAgent = new Agent({
  name: 'DCF Valuation Specialist',
  model: llm,
  instructions: `
    You are a valuation expert specializing in DCF models.

    Provide clear, data-driven valuation analysis with:
    - Intrinsic value estimates
    - Key assumptions and their impact
    - Sensitivity analysis
    - Fair value range (conservative, base, optimistic)
    - Comparison to current market price

    Always explain your methodology and be transparent about limitations.
  `,
});

// ============================================================================
// STEP 1: FETCH DATA
// ============================================================================
// This step gathers all the financial data needed to perform a DCF valuation
// by calling existing tools instead of duplicating API calls.
//
// TOOLS USED:
// - getStockPriceTool: Current price, market cap, shares outstanding
// - getCashFlowTool: Free cash flow, operating cash flow
// - getBalanceSheetTool: Total debt, cash, shares outstanding
// - getFinancialsTool: Revenue growth and other key metrics
// ============================================================================
const fetchDCFData = createStep({
  id: 'fetch-dcf-data',
  description: 'Fetches financial data needed for DCF valuation using existing tools',

  // INPUT: Just needs a ticker symbol (e.g., "AAPL")
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),

  // OUTPUT: All the financial metrics needed for DCF calculation
  outputSchema: z.object({
    ticker: z.string(),
    currentPrice: z.number(),                    // Current stock price (for comparison)
    freeCashFlow: z.number().nullable(),         // FCF is core to DCF model
    totalDebt: z.number().nullable(),            // Debt (to calculate equity value)
    cash: z.number().nullable(),                 // Cash (to calculate equity value)
    sharesOutstanding: z.number().nullable(),    // Shares (to get per-share value)
    revenueGrowth: z.number().nullable(),        // Growth rate (to project future FCF)
    marketCap: z.string(),                       // Market cap (for context)
  }),

  execute: async ({ inputData, runtimeContext }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker.toUpperCase();

    try {
      // Call existing tools to fetch data (avoiding code duplication)
      // Each tool returns structured, validated data
      // runtimeContext is passed from the step's execute parameters (Mastra pattern)

      // 1. Get price data (current price, market cap, shares)
      const priceData = await getStockPriceTool.execute({
        context: { ticker },
        runtimeContext,
      });

      // 2. Get cash flow data (free cash flow - the key DCF input)
      const cashFlowData = await getCashFlowTool.execute({
        context: { ticker },
        runtimeContext,
      });

      // 3. Get balance sheet data (debt, cash)
      const balanceSheetData = await getBalanceSheetTool.execute({
        context: { ticker },
        runtimeContext,
      });

      // 4. Get financial metrics (revenue growth for projections)
      const financialsData = await getFinancialsTool.execute({
        context: { ticker },
        runtimeContext,
      });

      // Combine data from all tools into the format needed for DCF
      return {
        ticker,
        currentPrice: priceData.price,
        freeCashFlow: cashFlowData.cashFlow.freeCashFlow,
        totalDebt: balanceSheetData.balanceSheet.totalDebt,
        cash: balanceSheetData.balanceSheet.totalCash,
        sharesOutstanding: balanceSheetData.shares.sharesOutstanding,
        revenueGrowth: financialsData.revenueGrowth,
        marketCap: priceData.marketCap,
      };
    } catch (error) {
      throw new Error(`Failed to fetch DCF data for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// STEP 2: CALCULATE & ANALYZE
// ============================================================================
// This step performs REAL quantitative DCF analysis using mathematical formulas:
// 1. Project future free cash flows for 5 years
// 2. Calculate terminal value (value beyond projection period)
// 3. Discount all cash flows to present value using WACC
// 4. Adjust for net debt to get equity value
// 5. Divide by shares to get intrinsic value per share
// 6. Provide Bear/Base/Bull scenarios via sensitivity analysis
//
// This uses the quantitative DCF calculator instead of AI guessing!
// ============================================================================
const calculateDCFStep = createStep({
  id: 'calculate-dcf',
  description: 'Calculates intrinsic value using quantitative DCF model',

  // INPUT: All the financial data from the previous step
  inputSchema: z.object({
    ticker: z.string(),
    currentPrice: z.number(),
    freeCashFlow: z.number().nullable(),
    totalDebt: z.number().nullable(),
    cash: z.number().nullable(),
    sharesOutstanding: z.number().nullable(),
    revenueGrowth: z.number().nullable(),
    marketCap: z.string(),
  }),

  // OUTPUT: A comprehensive valuation analysis as text
  outputSchema: z.object({
    valuation: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    // ========== VALIDATE INPUT DATA ==========
    // DCF requires certain core data points to work
    if (!inputData.freeCashFlow || inputData.freeCashFlow <= 0) {
      throw new Error(
        `Cannot perform DCF for ${inputData.ticker}: Free Cash Flow data is missing or negative. ` +
        `DCF requires positive free cash flow to project future values.`
      );
    }

    if (!inputData.sharesOutstanding || inputData.sharesOutstanding <= 0) {
      throw new Error(
        `Cannot perform DCF for ${inputData.ticker}: Shares outstanding data is missing or invalid.`
      );
    }

    // Parse market cap string to number
    // Format is like "$2.5T" or "$850.2B" or "$5.3M"
    const marketCapNum = parseFloat(inputData.marketCap.replace(/[$,]/g, '')) *
      (inputData.marketCap.includes('T') ? 1e12 :
       inputData.marketCap.includes('B') ? 1e9 :
       inputData.marketCap.includes('M') ? 1e6 : 1);

    // ========== PERFORM QUANTITATIVE DCF CALCULATION ==========
    // This uses real mathematical formulas, not AI estimation
    const dcfResults = calculateDCF({
      freeCashFlow: inputData.freeCashFlow,
      totalDebt: inputData.totalDebt || 0,
      cash: inputData.cash || 0,
      sharesOutstanding: inputData.sharesOutstanding,
      marketCap: marketCapNum,
      revenueGrowth: inputData.revenueGrowth || undefined,
      // Use defaults for discount rate and terminal growth
      // (calculator will determine appropriate WACC based on market cap)
    });

    // Add current price comparison and recommendation
    const valuation = assessValuation(dcfResults.intrinsicValue, inputData.currentPrice);
    Object.assign(dcfResults, valuation);

    // ========== FORMAT RESULTS FOR DISPLAY ==========
    // Convert calculation results into human-readable format
    const formattedResults = formatDCFResults(dcfResults);

    // ========== USE AI TO PROVIDE INTERPRETATION ==========
    // Now that we have real numbers, ask AI to interpret and explain them
    const prompt = `You are a valuation expert. A DCF (Discounted Cash Flow) analysis has been completed for ${inputData.ticker}.

Below are the ACTUAL CALCULATED RESULTS from a quantitative DCF model using real financial formulas:

${formattedResults}

Your task is to:
1. Explain what these numbers mean in plain language
2. Highlight the key insights (is it undervalued/overvalued? by how much?)
3. Discuss the reliability of the valuation (are the assumptions reasonable?)
4. Explain what would need to change for the bull/bear scenarios to play out
5. Provide investment guidance based on the quantitative results

IMPORTANT: These are REAL CALCULATED values, not estimates. Don't recalculate - instead, interpret and explain the results.`;

    // Get AI interpretation of the quantitative results
    const response = await valuationAgent.streamLegacy([
      {
        role: 'user',
        content: prompt,
      },
    ]);

    // Collect the interpretation
    let interpretation = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);  // Display in real-time
      interpretation += chunk;       // Build the full response
    }

    // ========== COMBINE QUANTITATIVE RESULTS + AI INTERPRETATION ==========
    const fullAnalysis = `
=== DCF VALUATION FOR ${inputData.ticker} ===

${formattedResults}

=== ANALYSIS & INTERPRETATION ===

${interpretation}
`;

    // Return the complete valuation analysis
    return {
      valuation: fullAnalysis,
    };
  },
});

// ============================================================================
// DCF WORKFLOW DEFINITION
// ============================================================================
// This workflow chains together the two steps above:
// 1. fetchDCFData - Gets financial data from Yahoo Finance
// 2. calculateDCF - AI analyzes data and produces DCF valuation
//
// USAGE:
//   const result = await dcfValuationWorkflow.execute({ ticker: 'AAPL' });
//   console.log(result.valuation); // Full DCF analysis with intrinsic value
// ============================================================================
export const dcfValuationWorkflow = createWorkflow({
  id: 'dcf-valuation-workflow',

  // INPUT: Just a ticker symbol
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol to value'),
  }),

  // OUTPUT: Complete valuation analysis as text
  outputSchema: z.object({
    valuation: z.string(),
  }),
})
  .then(fetchDCFData)         // Step 1: Fetch financial data
  .then(calculateDCFStep);    // Step 2: Calculate DCF using real math + AI interpretation

// Commit the workflow to make it executable
dcfValuationWorkflow.commit();
