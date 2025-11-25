// ============================================================================
// FULL RESEARCH WORKFLOW
// ============================================================================
// This workflow orchestrates comprehensive equity research by combining:
// 1. Company Overview - Basic context (price, sector, news)
// 2. Parallel Specialist Analysis - Fundamental, Sentiment, Risk
// 3. Research Synthesis - Combine all findings into unified report
// 4. Investment Thesis - Final recommendation with rating & target
//
// This is the main workflow used by the Master Research Analyst to produce
// complete investment research reports.
// ============================================================================

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

// Import tools from all specialist areas
import { getStockPriceTool, getFinancialsTool, getCompanyNewsTool } from '../tools/equity-tools';
import { getFinancialRatiosTool, getBalanceSheetTool, getCashFlowTool } from '../tools/fundamental-tools';
import { getAnalystRatingsTool, getInsiderTradingTool, getUpgradeDowngradeTool } from '../tools/sentiment-tools';
import { getBetaVolatilityTool, getDrawdownAnalysisTool, getSectorExposureTool, getShortInterestTool } from '../tools/risk-tools';

// Initialize OpenAI model
const llm = openai('gpt-4o');

// ============================================================================
// MASTER SYNTHESIS AGENT
// ============================================================================
// This agent synthesizes all specialist findings into a unified research report
// and generates the final investment thesis.
// ============================================================================
const masterSynthesisAgent = new Agent({
  name: 'Master Research Synthesizer',
  model: llm,
  instructions: `
    You are a senior equity research analyst who synthesizes findings from
    fundamental analysis, sentiment analysis, and risk assessment into
    comprehensive investment research reports.

    Your synthesis should:
    - Weigh all three perspectives (fundamental, sentiment, risk) appropriately
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
// Gathers basic company context needed for all subsequent analysis.
// ============================================================================
const fetchCompanyOverview = createStep({
  id: 'fetch-company-overview',
  description: 'Fetches basic company info, price, sector, and recent news',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    currentPrice: z.number(),
    marketCap: z.string(),
    sector: z.string().nullable(),
    industry: z.string().nullable(),
    marketCapCategory: z.string().nullable(),
    recentNews: z.array(z.object({
      title: z.string(),
      publisher: z.string(),
      publishedDate: z.string(),
    })),
  }),

  execute: async ({ inputData, runtimeContext }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker.toUpperCase();

    try {
      // Fetch price, sector, and news in parallel
      const [priceData, sectorData, newsData] = await Promise.all([
        getStockPriceTool.execute({ context: { ticker }, runtimeContext }),
        getSectorExposureTool.execute({ context: { ticker }, runtimeContext }),
        getCompanyNewsTool.execute({ context: { ticker, limit: 5 }, runtimeContext }),
      ]);

      return {
        ticker,
        companyName: sectorData.companyName,
        currentPrice: priceData.price,
        marketCap: priceData.marketCap,
        sector: sectorData.sector,
        industry: sectorData.industry,
        marketCapCategory: sectorData.marketCapCategory,
        recentNews: newsData.articles.map(a => ({
          title: a.title,
          publisher: a.publisher,
          publishedDate: a.publishedDate,
        })),
      };
    } catch (error) {
      throw new Error(`Failed to fetch company overview for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// STEP 2: PARALLEL SPECIALIST ANALYSIS
// ============================================================================
// Runs fundamental, sentiment, and risk analysis in parallel for efficiency.
// ============================================================================
const runSpecialistAnalysis = createStep({
  id: 'run-specialist-analysis',
  description: 'Runs fundamental, sentiment, and risk analysis in parallel',

  inputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    currentPrice: z.number(),
    marketCap: z.string(),
    sector: z.string().nullable(),
    industry: z.string().nullable(),
    marketCapCategory: z.string().nullable(),
    recentNews: z.array(z.object({
      title: z.string(),
      publisher: z.string(),
      publishedDate: z.string(),
    })),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyOverview: z.any(),
    fundamentalData: z.any(),
    sentimentData: z.any(),
    riskData: z.any(),
  }),

  execute: async ({ inputData, runtimeContext }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker;

    try {
      // Run all specialist analyses in parallel
      const [
        // Fundamental data
        financialRatios,
        balanceSheet,
        cashFlow,
        // Sentiment data
        analystRatings,
        insiderTrading,
        upgradeDowngrade,
        // Risk data
        betaVolatility,
        drawdownAnalysis,
        shortInterest,
      ] = await Promise.all([
        // Fundamental
        getFinancialRatiosTool.execute({ context: { ticker }, runtimeContext }),
        getBalanceSheetTool.execute({ context: { ticker }, runtimeContext }),
        getCashFlowTool.execute({ context: { ticker }, runtimeContext }),
        // Sentiment
        getAnalystRatingsTool.execute({ context: { ticker }, runtimeContext }),
        getInsiderTradingTool.execute({ context: { ticker }, runtimeContext }),
        getUpgradeDowngradeTool.execute({ context: { ticker }, runtimeContext }),
        // Risk
        getBetaVolatilityTool.execute({ context: { ticker }, runtimeContext }),
        getDrawdownAnalysisTool.execute({ context: { ticker, period: '1y' }, runtimeContext }),
        getShortInterestTool.execute({ context: { ticker }, runtimeContext }),
      ]);

      return {
        ticker,
        companyOverview: inputData,
        fundamentalData: {
          ratios: financialRatios,
          balanceSheet,
          cashFlow,
        },
        sentimentData: {
          analystRatings,
          insiderTrading,
          upgradeDowngrade,
        },
        riskData: {
          betaVolatility,
          drawdownAnalysis,
          shortInterest,
        },
      };
    } catch (error) {
      throw new Error(`Failed to run specialist analysis for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// STEP 3: SYNTHESIZE RESEARCH REPORT
// ============================================================================
// Combines all specialist findings into a unified research report.
// ============================================================================
const synthesizeResearchReport = createStep({
  id: 'synthesize-research-report',
  description: 'Synthesizes all specialist findings into a unified research report',

  inputSchema: z.object({
    ticker: z.string(),
    companyOverview: z.any(),
    fundamentalData: z.any(),
    sentimentData: z.any(),
    riskData: z.any(),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyOverview: z.any(),
    fundamentalData: z.any(),
    sentimentData: z.any(),
    riskData: z.any(),
    researchReport: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const { ticker, companyOverview, fundamentalData, sentimentData, riskData } = inputData;

    // Build comprehensive prompt with all data
    const prompt = `You are synthesizing a comprehensive equity research report for ${ticker} (${companyOverview.companyName}).

=== COMPANY OVERVIEW ===
Current Price: $${companyOverview.currentPrice}
Market Cap: ${companyOverview.marketCap}
Sector: ${companyOverview.sector || 'N/A'}
Industry: ${companyOverview.industry || 'N/A'}
Market Cap Category: ${companyOverview.marketCapCategory || 'N/A'}

Recent News Headlines:
${companyOverview.recentNews.map((n: any) => `- ${n.title} (${n.publisher})`).join('\n')}

=== FUNDAMENTAL ANALYSIS ===
Profitability:
- Gross Margin: ${fundamentalData.ratios.profitability?.grossMargin?.toFixed(2) || 'N/A'}%
- Operating Margin: ${fundamentalData.ratios.profitability?.operatingMargin?.toFixed(2) || 'N/A'}%
- Net Margin: ${fundamentalData.ratios.profitability?.netMargin?.toFixed(2) || 'N/A'}%
- ROE: ${fundamentalData.ratios.profitability?.roe?.toFixed(2) || 'N/A'}%
- ROA: ${fundamentalData.ratios.profitability?.roa?.toFixed(2) || 'N/A'}%
- Revenue Growth: ${fundamentalData.ratios.profitability?.revenueGrowth?.toFixed(2) || 'N/A'}%
- Earnings Growth: ${fundamentalData.ratios.profitability?.earningsGrowth?.toFixed(2) || 'N/A'}%

Valuation:
- P/E Ratio: ${fundamentalData.ratios.valuation?.peRatio?.toFixed(2) || 'N/A'}
- Forward P/E: ${fundamentalData.ratios.valuation?.forwardPE?.toFixed(2) || 'N/A'}
- P/B Ratio: ${fundamentalData.ratios.valuation?.pbRatio?.toFixed(2) || 'N/A'}
- P/S Ratio: ${fundamentalData.ratios.valuation?.psRatio?.toFixed(2) || 'N/A'}
- PEG Ratio: ${fundamentalData.ratios.valuation?.pegRatio?.toFixed(2) || 'N/A'}
- EV/EBITDA: ${fundamentalData.ratios.valuation?.evToEbitda?.toFixed(2) || 'N/A'}

Balance Sheet:
- Total Cash: $${(fundamentalData.balanceSheet.balanceSheet?.totalCash / 1e9)?.toFixed(2) || 'N/A'}B
- Total Debt: $${(fundamentalData.balanceSheet.balanceSheet?.totalDebt / 1e9)?.toFixed(2) || 'N/A'}B
- Debt-to-Equity: ${fundamentalData.balanceSheet.balanceSheet?.debtToEquity?.toFixed(2) || 'N/A'}
- Current Ratio: ${fundamentalData.balanceSheet.balanceSheet?.currentRatio?.toFixed(2) || 'N/A'}
- Quick Ratio: ${fundamentalData.balanceSheet.balanceSheet?.quickRatio?.toFixed(2) || 'N/A'}

Cash Flow:
- Operating Cash Flow: $${(fundamentalData.cashFlow.cashFlow?.operatingCashFlow / 1e9)?.toFixed(2) || 'N/A'}B
- Free Cash Flow: $${(fundamentalData.cashFlow.cashFlow?.freeCashFlow / 1e9)?.toFixed(2) || 'N/A'}B

=== SENTIMENT ANALYSIS ===
Analyst Ratings:
- Strong Buy: ${sentimentData.analystRatings.ratings?.strongBuy || 0}
- Buy: ${sentimentData.analystRatings.ratings?.buy || 0}
- Hold: ${sentimentData.analystRatings.ratings?.hold || 0}
- Sell: ${sentimentData.analystRatings.ratings?.sell || 0}
- Strong Sell: ${sentimentData.analystRatings.ratings?.strongSell || 0}
- Average Price Target: $${sentimentData.analystRatings.priceTarget?.average?.toFixed(2) || 'N/A'}
- Price Target Range: $${sentimentData.analystRatings.priceTarget?.low?.toFixed(2) || 'N/A'} - $${sentimentData.analystRatings.priceTarget?.high?.toFixed(2) || 'N/A'}

Insider Trading:
- Net Insider Sentiment: ${sentimentData.insiderTrading.summary?.netSentiment || 'N/A'}
- Recent Transactions: ${sentimentData.insiderTrading.transactions?.length || 0}

Recent Upgrades/Downgrades:
${sentimentData.upgradeDowngrade.events?.slice(0, 3).map((e: any) => `- ${e.firm}: ${e.action} to ${e.toGrade}`).join('\n') || 'None recent'}

=== RISK ASSESSMENT ===
Market Risk:
- Beta: ${riskData.betaVolatility.beta?.toFixed(2) || 'N/A'}
- 52-Week Range: ${riskData.betaVolatility.fiftyTwoWeekRange || 'N/A'}
- % From 52-Week High: ${riskData.betaVolatility.percentFromHigh?.toFixed(2) || 'N/A'}%
- Trend Signal: ${riskData.betaVolatility.trendSignal || 'N/A'}

Drawdown Analysis (1Y):
- Max Drawdown: ${riskData.drawdownAnalysis.maxDrawdown?.toFixed(2) || 'N/A'}%
- Current Drawdown: ${riskData.drawdownAnalysis.currentDrawdownFromPeriodHigh?.toFixed(2) || 'N/A'}%
- Period Return: ${riskData.drawdownAnalysis.periodReturn?.toFixed(2) || 'N/A'}%

Short Interest:
- Short % of Float: ${riskData.shortInterest.shortPercentOfFloat?.toFixed(2) || 'N/A'}%
- Short Ratio (Days to Cover): ${riskData.shortInterest.shortRatio?.toFixed(2) || 'N/A'}
- Short Squeeze Risk: ${riskData.shortInterest.shortSqueezeRisk || 'N/A'}
- Sentiment Indicator: ${riskData.shortInterest.sentimentIndicator || 'N/A'}

=== YOUR TASK ===
Synthesize all this data into a comprehensive research report with:

1. **EXECUTIVE SUMMARY** (2-3 sentences)

2. **SCORES** (1-10 scale with brief justification)
   - Fundamental Score: X/10
   - Sentiment Score: X/10
   - Risk Score: X/10 (higher = more risk)

3. **KEY STRENGTHS** (3-4 bullet points)

4. **KEY WEAKNESSES / RISKS** (3-4 bullet points)

5. **CATALYSTS TO WATCH** (upcoming events that could move the stock)

6. **AREAS OF AGREEMENT** (where fundamental, sentiment, and risk analyses align)

7. **AREAS OF CONFLICT** (where the analyses diverge)

Be specific, cite numbers, and maintain objectivity.`;

    const response = await masterSynthesisAgent.streamLegacy([
      { role: 'user', content: prompt },
    ]);

    let reportText = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      reportText += chunk;
    }

    return {
      ...inputData,
      researchReport: reportText,
    };
  },
});

// ============================================================================
// STEP 4: GENERATE INVESTMENT THESIS
// ============================================================================
// Produces the final investment recommendation with rating and target price.
// ============================================================================
const generateInvestmentThesis = createStep({
  id: 'generate-investment-thesis',
  description: 'Generates final investment thesis with rating and target',

  inputSchema: z.object({
    ticker: z.string(),
    companyOverview: z.any(),
    fundamentalData: z.any(),
    sentimentData: z.any(),
    riskData: z.any(),
    researchReport: z.string(),
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

    const { ticker, companyOverview, sentimentData, riskData, researchReport } = inputData;

    const prompt = `Based on the research report below, generate a final investment thesis for ${ticker}.

=== RESEARCH REPORT ===
${researchReport}

=== ADDITIONAL CONTEXT ===
Current Price: $${companyOverview.currentPrice}
Analyst Average Price Target: $${sentimentData.analystRatings.priceTarget?.average?.toFixed(2) || 'N/A'}
Beta: ${riskData.betaVolatility.beta?.toFixed(2) || 'N/A'}

=== YOUR TASK ===
Generate a final investment thesis with:

1. **RATING**: Strong Buy / Buy / Hold / Sell / Strong Sell

2. **CONFIDENCE LEVEL**: High / Medium / Low (with brief explanation)

3. **TARGET PRICE RANGE**
   - Bear Case: $X (explanation)
   - Base Case: $X (explanation)
   - Bull Case: $X (explanation)

4. **INVESTMENT HORIZON**: Short-term (<6 months) / Medium-term (6-18 months) / Long-term (>18 months)

5. **BULL CASE** (3 key points supporting upside)

6. **BEAR CASE** (3 key points supporting downside)

7. **KEY METRICS TO WATCH** (3-4 specific metrics/events to monitor)

8. **POSITION SIZING RECOMMENDATION** (based on risk profile)
   - Conservative investors: X% of portfolio
   - Moderate investors: X% of portfolio
   - Aggressive investors: X% of portfolio

Be decisive but acknowledge uncertainty. Provide specific numbers where possible.`;

    const response = await masterSynthesisAgent.streamLegacy([
      { role: 'user', content: prompt },
    ]);

    let thesisText = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      thesisText += chunk;
    }

    return {
      ticker,
      companyName: companyOverview.companyName,
      currentPrice: companyOverview.currentPrice,
      researchReport,
      investmentThesis: thesisText,
    };
  },
});

// ============================================================================
// FULL RESEARCH WORKFLOW DEFINITION
// ============================================================================
// Chains all 4 steps together into a complete research pipeline.
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
  .then(runSpecialistAnalysis)
  .then(synthesizeResearchReport)
  .then(generateInvestmentThesis);

// Commit the workflow
fullResearchWorkflow.commit();

// ============================================================================
// END OF FULL RESEARCH WORKFLOW
// ============================================================================
