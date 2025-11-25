// ============================================================================
// FULL RESEARCH WORKFLOW
// ============================================================================
// This workflow orchestrates comprehensive equity research by combining
// outputs from all specialist workflows:
//
// 1. Equity Analysis - Basic company overview (price, financials, news)
// 2. DCF Valuation - Intrinsic value calculation
// 3. Comparable Analysis - Peer comparison valuation
// 4. Sentiment Analysis - News, analyst ratings, insider activity
// 5. Risk Assessment - Beta, volatility, drawdowns, risk score
//
// The workflow then synthesizes all findings into a unified research report
// and investment thesis.
// ============================================================================

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

// Import all specialist workflows
import { equityAnalysisWorkflow } from './equity-workflow';
import { dcfValuationWorkflow } from './dcf-workflow';
import { comparableAnalysisWorkflow } from './comparable-workflow';
import { sentimentAnalysisWorkflow } from './sentiment-workflow';
import { riskAssessmentWorkflow } from './risk-workflow';

// Import sector exposure tool for peer selection
import { getSectorExposureTool } from '../tools/risk-tools';

// Initialize OpenAI model
const llm = openai('gpt-4o');

// ============================================================================
// SECTOR TO PEERS MAPPING
// ============================================================================
// Maps sectors to representative peer companies for comparable analysis.
// These are major companies that serve as good benchmarks within each sector.
// ============================================================================
const SECTOR_PEERS: Record<string, string[]> = {
  'Technology': ['AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA', 'AVGO', 'CRM'],
  'Financial Services': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK'],
  'Healthcare': ['JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'LLY', 'TMO'],
  'Consumer Cyclical': ['AMZN', 'TSLA', 'HD', 'NKE', 'MCD', 'SBUX', 'TJX'],
  'Consumer Defensive': ['PG', 'KO', 'PEP', 'WMT', 'COST', 'PM', 'CL'],
  'Communication Services': ['GOOGL', 'META', 'NFLX', 'DIS', 'CMCSA', 'T', 'VZ'],
  'Industrials': ['CAT', 'DE', 'UNP', 'HON', 'GE', 'BA', 'LMT'],
  'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PXD', 'MPC'],
  'Utilities': ['NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE'],
  'Real Estate': ['PLD', 'AMT', 'EQIX', 'SPG', 'O', 'WELL', 'PSA'],
  'Basic Materials': ['LIN', 'APD', 'SHW', 'ECL', 'NEM', 'FCX', 'DD'],
};

// Default peers if sector not found
const DEFAULT_PEERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA'];

// ============================================================================
// MASTER SYNTHESIS AGENT
// ============================================================================
// This agent synthesizes all specialist workflow outputs into a unified
// research report and generates the final investment thesis.
// ============================================================================
const masterSynthesisAgent = new Agent({
  name: 'Master Research Synthesizer',
  model: llm,
  instructions: `
    You are a senior equity research analyst who synthesizes findings from
    multiple specialist analyses into comprehensive investment research reports.

    Your synthesis should:
    - Weigh all perspectives (fundamental, valuation, sentiment, risk) appropriately
    - Identify where the analyses agree or conflict
    - Provide clear, actionable investment recommendations
    - Be objective and data-driven
    - Acknowledge uncertainties and limitations

    Format your output professionally as you would for institutional investors.
  `,
});

// ============================================================================
// STEP 1: FETCH COMPANY OVERVIEW
// ============================================================================
// Runs the equity analysis workflow to get basic company context,
// plus fetches sector info for peer selection.
// ============================================================================
const fetchCompanyOverview = createStep({
  id: 'fetch-company-overview',
  description: 'Fetches basic company overview and determines sector for peer selection',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    sector: z.string().nullable(),
    peers: z.array(z.string()),
    equityAnalysis: z.string(),
  }),

  execute: async ({ inputData, runtimeContext }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker.toUpperCase();

    try {
      // Run equity analysis workflow and get sector in parallel
      // Note: createRunAsync() is the new API (createRun is deprecated)
      const [equityRun, sectorData] = await Promise.all([
        equityAnalysisWorkflow.createRunAsync(),
        getSectorExposureTool.execute({ context: { ticker }, runtimeContext }),
      ]);
      const equityResult = await equityRun.start({ inputData: { ticker } });

      // Get sector and determine peers
      const sector = sectorData.sector || null;
      let peers = sector ? (SECTOR_PEERS[sector] || DEFAULT_PEERS) : DEFAULT_PEERS;

      // Remove the ticker itself from peers list
      peers = peers.filter(p => p.toUpperCase() !== ticker);

      // Limit to 4 peers for efficiency
      peers = peers.slice(0, 4);

      // Extract analysis from workflow result
      // Mastra WorkflowResult: on success, 'result' contains the final output
      let equityAnalysis = 'Equity analysis not available';
      if (equityResult.status === 'success' && equityResult.result) {
        equityAnalysis = (equityResult.result as { analysis: string }).analysis || equityAnalysis;
      }

      return {
        ticker,
        sector,
        peers,
        equityAnalysis,
      };
    } catch (error) {
      throw new Error(`Failed to fetch company overview for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// STEP 2: RUN SPECIALIST WORKFLOWS IN PARALLEL
// ============================================================================
// Executes DCF, Comparable, Sentiment, and Risk workflows simultaneously.
// ============================================================================
const runSpecialistWorkflows = createStep({
  id: 'run-specialist-workflows',
  description: 'Runs DCF, Comparable, Sentiment, and Risk workflows in parallel',

  inputSchema: z.object({
    ticker: z.string(),
    sector: z.string().nullable(),
    peers: z.array(z.string()),
    equityAnalysis: z.string(),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    sector: z.string().nullable(),
    equityAnalysis: z.string(),
    dcfValuation: z.string(),
    comparableAnalysis: z.string(),
    sentimentAnalysis: z.string(),
    riskAssessment: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const { ticker, sector, peers, equityAnalysis } = inputData;

    try {
      // Run all 4 specialist workflows in parallel
      // Note: createRunAsync() is the new API (createRun is deprecated)
      const [dcfRun, comparableRun, sentimentRun, riskRun] = await Promise.all([
        dcfValuationWorkflow.createRunAsync(),
        comparableAnalysisWorkflow.createRunAsync(),
        sentimentAnalysisWorkflow.createRunAsync(),
        riskAssessmentWorkflow.createRunAsync(),
      ]);

      // Start all workflows in parallel and use allSettled for graceful error handling
      const [dcfResult, comparableResult, sentimentResult, riskResult] = await Promise.allSettled([
        dcfRun.start({ inputData: { ticker } }),
        comparableRun.start({ inputData: { ticker, peers } }),
        sentimentRun.start({ inputData: { ticker } }),
        riskRun.start({ inputData: { ticker } }),
      ]);

      // Helper function to extract result from workflow
      const extractResult = (
        settledResult: PromiseSettledResult<any>,
        fieldName: string,
        fallbackMessage: string
      ): string => {
        if (settledResult.status === 'rejected') {
          return `${fallbackMessage}: ${settledResult.reason}`;
        }
        const workflowResult = settledResult.value;
        if (workflowResult.status === 'success' && workflowResult.result) {
          return (workflowResult.result as Record<string, any>)[fieldName] || fallbackMessage;
        }
        return fallbackMessage;
      };

      // Extract results, handling failures gracefully
      const dcfValuation = extractResult(
        dcfResult,
        'valuation',
        'DCF analysis not available - company may have negative free cash flow'
      );

      const comparableAnalysis = extractResult(
        comparableResult,
        'analysis',
        'Comparable analysis not available'
      );

      const sentimentAnalysis = extractResult(
        sentimentResult,
        'analysis',
        'Sentiment analysis not available'
      );

      const riskAssessment = extractResult(
        riskResult,
        'riskAssessment',
        'Risk assessment not available'
      );

      return {
        ticker,
        sector,
        equityAnalysis,
        dcfValuation,
        comparableAnalysis,
        sentimentAnalysis,
        riskAssessment,
      };
    } catch (error) {
      throw new Error(`Failed to run specialist workflows for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// STEP 3: SYNTHESIZE FULL RESEARCH REPORT & INVESTMENT THESIS
// ============================================================================
// Combines all workflow outputs into a unified research report and
// generates the final investment thesis with ratings and targets.
// ============================================================================
const synthesizeFullReport = createStep({
  id: 'synthesize-full-report',
  description: 'Synthesizes all workflow outputs into research report and investment thesis',

  inputSchema: z.object({
    ticker: z.string(),
    sector: z.string().nullable(),
    equityAnalysis: z.string(),
    dcfValuation: z.string(),
    comparableAnalysis: z.string(),
    sentimentAnalysis: z.string(),
    riskAssessment: z.string(),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    currentPrice: z.number(),
    researchReport: z.string(),
    investmentThesis: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const { ticker, sector, equityAnalysis, dcfValuation, comparableAnalysis, sentimentAnalysis, riskAssessment } = inputData;

    // Build comprehensive prompt with all workflow outputs
    const prompt = `You are synthesizing a comprehensive equity research report for ${ticker}.

You have received analysis from 5 specialist workflows. Your task is to synthesize ALL of this information into:
1. A unified RESEARCH REPORT
2. A final INVESTMENT THESIS

=== EQUITY OVERVIEW ===
${equityAnalysis}

=== DCF VALUATION ===
${dcfValuation}

=== COMPARABLE COMPANY ANALYSIS ===
${comparableAnalysis}

=== SENTIMENT ANALYSIS ===
${sentimentAnalysis}

=== RISK ASSESSMENT ===
${riskAssessment}

=== YOUR TASK ===

**PART 1: RESEARCH REPORT**

Create a comprehensive research report with:

1. **EXECUTIVE SUMMARY** (3-4 sentences)
   - What the company does
   - Current investment case in brief
   - Overall recommendation preview

2. **SCORES** (1-10 scale with brief justification)
   | Category | Score | Justification |
   |----------|-------|---------------|
   | Fundamental Quality | X/10 | [Brief] |
   | Valuation | X/10 | [Brief - 10 = very undervalued] |
   | Sentiment | X/10 | [Brief] |
   | Risk | X/10 | [Brief - 10 = lowest risk] |
   | **OVERALL** | X/10 | [Weighted assessment] |

3. **VALUATION SUMMARY**
   - DCF Intrinsic Value: $X (X% upside/downside)
   - Comparable Implied Value: $X
   - Valuation Verdict: [Undervalued / Fairly Valued / Overvalued]

4. **KEY STRENGTHS** (4-5 bullet points from across all analyses)

5. **KEY RISKS & WEAKNESSES** (4-5 bullet points from across all analyses)

6. **CATALYSTS TO WATCH** (upcoming events that could move the stock)

7. **AREAS OF AGREEMENT** (where multiple analyses align)

8. **AREAS OF CONFLICT** (where analyses diverge - and your interpretation)

---

**PART 2: INVESTMENT THESIS**

1. **RATING**: Strong Buy / Buy / Hold / Sell / Strong Sell

2. **CONFIDENCE LEVEL**: High / Medium / Low (with explanation)

3. **TARGET PRICE RANGE**
   - Bear Case: $X (explanation)
   - Base Case: $X (explanation)
   - Bull Case: $X (explanation)

4. **INVESTMENT HORIZON**: Short-term (<6 months) / Medium-term (6-18 months) / Long-term (>18 months)

5. **BULL CASE** (3 key points supporting upside)

6. **BEAR CASE** (3 key points supporting downside)

7. **KEY METRICS TO WATCH** (4-5 specific metrics/events to monitor)

8. **POSITION SIZING RECOMMENDATION**
   - Conservative investors: X% of portfolio
   - Moderate investors: X% of portfolio
   - Aggressive investors: X% of portfolio

---

Be specific, cite numbers from the analyses, and maintain objectivity.
Clearly separate PART 1 (Research Report) from PART 2 (Investment Thesis) with headers.`;

    const response = await masterSynthesisAgent.streamLegacy([
      { role: 'user', content: prompt },
    ]);

    let fullReport = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      fullReport += chunk;
    }

    // Split the report into research report and investment thesis
    // Look for "PART 2" or "INVESTMENT THESIS" as separator
    let researchReport = fullReport;
    let investmentThesis = '';

    const part2Markers = ['**PART 2:', 'PART 2:', '## INVESTMENT THESIS', '**INVESTMENT THESIS'];
    for (const marker of part2Markers) {
      const splitIndex = fullReport.indexOf(marker);
      if (splitIndex !== -1) {
        researchReport = fullReport.substring(0, splitIndex).trim();
        investmentThesis = fullReport.substring(splitIndex).trim();
        break;
      }
    }

    // If no clear split, put everything in research report
    if (!investmentThesis) {
      researchReport = fullReport;
      investmentThesis = 'See research report above for investment thesis.';
    }

    // Extract company name and price from equity analysis (basic parsing)
    // These are approximations - the full data is in the analyses
    const companyName = ticker; // Could parse from equityAnalysis if needed
    const currentPrice = 0; // Could parse from equityAnalysis if needed

    return {
      ticker,
      companyName,
      currentPrice,
      researchReport,
      investmentThesis,
    };
  },
});

// ============================================================================
// FULL RESEARCH WORKFLOW DEFINITION
// ============================================================================
// Chains all 3 steps together into a complete research pipeline:
// 1. Fetch company overview (equity analysis + sector/peers)
// 2. Run 4 specialist workflows in parallel
// 3. Synthesize into unified report + thesis
//
// USAGE:
//   const result = await fullResearchWorkflow.execute({ ticker: 'AAPL' });
//   console.log(result.researchReport);
//   console.log(result.investmentThesis);
// ============================================================================
export const fullResearchWorkflow = createWorkflow({
  id: 'full-research-workflow',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol to research'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    currentPrice: z.number(),
    researchReport: z.string(),
    investmentThesis: z.string(),
  }),
})
  .then(fetchCompanyOverview)
  .then(runSpecialistWorkflows)
  .then(synthesizeFullReport);

// Commit the workflow
fullResearchWorkflow.commit();

// ============================================================================
// END OF FULL RESEARCH WORKFLOW
// ============================================================================
