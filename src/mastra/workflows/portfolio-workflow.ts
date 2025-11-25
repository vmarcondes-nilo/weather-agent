// ============================================================================
// PORTFOLIO ANALYSIS WORKFLOW
// ============================================================================
// This workflow analyzes a user's portfolio of holdings, calculating:
// 1. Portfolio metrics (total value, gain/loss, weights)
// 2. Risk metrics (weighted beta, sector allocation, concentration)
// 3. AI-synthesized recommendations (rebalancing, diversification)
//
// USAGE:
//   const result = await portfolioAnalysisWorkflow.execute({
//     holdings: [
//       { ticker: 'AAPL', shares: 50, costBasis: 150 },
//       { ticker: 'MSFT', shares: 30, costBasis: 280 },
//     ]
//   });
// ============================================================================

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const llm = openai('gpt-4o');

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

const holdingInputSchema = z.object({
  ticker: z.string().describe('Stock ticker symbol'),
  shares: z.number().describe('Number of shares held'),
  costBasis: z.number().optional().describe('Average cost per share'),
});

const holdingDetailSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  shares: z.number(),
  costBasis: z.number().nullable(),
  currentPrice: z.number(),
  marketValue: z.number(),
  weight: z.number(),
  gainLoss: z.number().nullable(),
  gainLossPercent: z.number().nullable(),
  beta: z.number().nullable(),
  sector: z.string(),
  industry: z.string(),
  peRatio: z.number().nullable(),
  dividendYield: z.number().nullable(),
  fiftyTwoWeekHigh: z.number(),
  fiftyTwoWeekLow: z.number(),
});

const portfolioMetricsSchema = z.object({
  totalValue: z.number(),
  totalCost: z.number().nullable(),
  totalGainLoss: z.number().nullable(),
  totalGainLossPercent: z.number().nullable(),
  numberOfHoldings: z.number(),
});

const riskMetricsSchema = z.object({
  weightedBeta: z.number(),
  sectorAllocation: z.record(z.number()),
  topHoldingsConcentration: z.number(),
  diversificationScore: z.number(),
  riskLevel: z.string(),
});

// ============================================================================
// PORTFOLIO SYNTHESIS AGENT
// ============================================================================

const portfolioSynthesisAgent = new Agent({
  name: 'Portfolio Synthesis Specialist',
  model: llm,
  instructions: `
    You are an expert portfolio analyst who synthesizes portfolio data into actionable insights.

    Your analysis should cover:
    - Portfolio health assessment
    - Risk evaluation based on concentration and sector exposure
    - Performance attribution
    - Specific rebalancing recommendations
    - Diversification suggestions

    Structure your response as follows:

    📊 **PORTFOLIO OVERVIEW**
    ═══════════════════════════════════
    • Total Value: $XXX,XXX
    • Total Gain/Loss: +$XX,XXX (+XX.X%)
    • Number of Holdings: X
    • Portfolio Beta: X.XX

    📈 **HOLDINGS BREAKDOWN**
    [Table or list of holdings with weights and performance]

    ⚖️ **ALLOCATION ANALYSIS**
    • **Sector Breakdown:**
      - Technology: XX%
      - Healthcare: XX%
      - [etc.]
    • **Concentration Risk:** [Low/Medium/High]
      - Top 3 holdings represent XX% of portfolio
    • **Diversification Score:** X/10

    📉 **RISK ASSESSMENT**
    • **Portfolio Beta:** X.XX
      - [Interpretation: more/less volatile than market]
    • **Risk Level:** [Conservative/Moderate/Aggressive/Speculative]
    • **Key Risk Factors:**
      - [List 2-3 main risks]

    🏆 **TOP PERFORMERS**
    1. [TICKER]: +XX.X% ($X,XXX gain)
    2. [TICKER]: +XX.X% ($X,XXX gain)

    📉 **UNDERPERFORMERS**
    1. [TICKER]: -XX.X% ($X,XXX loss)
    2. [TICKER]: -XX.X% ($X,XXX loss)

    🔄 **REBALANCING RECOMMENDATIONS**
    Based on the analysis, here are specific actions to consider:
    1. **[Action]:** [Specific recommendation with rationale]
    2. **[Action]:** [Specific recommendation with rationale]
    3. **[Action]:** [Specific recommendation with rationale]

    💡 **STRATEGIC INSIGHTS**
    • **Strengths:** [What's working well]
    • **Weaknesses:** [Areas of concern]
    • **Opportunities:** [Potential improvements]
    • **Threats:** [External risks to monitor]

    🎯 **ACTION ITEMS**
    - [ ] [Specific actionable item]
    - [ ] [Specific actionable item]
    - [ ] [Specific actionable item]

    ⚠️ Disclaimer: This analysis is for informational purposes only and does not constitute investment advice.

    Guidelines:
    - Be specific with numbers and percentages
    - Provide actionable recommendations, not generic advice
    - Consider tax implications when suggesting sells
    - Account for correlation between holdings
    - Weight recommendations by portfolio impact
  `,
});

// ============================================================================
// STEP 1: FETCH PORTFOLIO DATA
// ============================================================================
// Fetches current prices and metrics for all holdings in parallel

const fetchPortfolioData = createStep({
  id: 'fetch-portfolio-data',
  description: 'Fetches current prices and metrics for all holdings',

  inputSchema: z.object({
    holdings: z.array(holdingInputSchema),
  }),

  outputSchema: z.object({
    holdings: z.array(holdingInputSchema),
    holdingDetails: z.array(holdingDetailSchema),
    portfolioMetrics: portfolioMetricsSchema,
  }),

  execute: async ({ inputData }) => {
    if (!inputData || !inputData.holdings || inputData.holdings.length === 0) {
      throw new Error('No holdings provided');
    }

    const holdings = inputData.holdings;

    // Fetch data for all holdings in parallel
    const holdingDataPromises = holdings.map(async (holding) => {
      const ticker = holding.ticker.toUpperCase();

      try {
        const [quote, summary] = await Promise.all([
          yf.quote(ticker),
          yf.quoteSummary(ticker, {
            modules: ['summaryDetail', 'financialData', 'summaryProfile'],
          }),
        ]);

        const currentPrice = quote.regularMarketPrice || 0;
        const marketValue = currentPrice * holding.shares;
        const costBasis = holding.costBasis ?? null;
        const totalCost = costBasis ? costBasis * holding.shares : null;
        const gainLoss = totalCost ? marketValue - totalCost : null;
        const gainLossPercent = totalCost && totalCost > 0 ? ((marketValue - totalCost) / totalCost) * 100 : null;

        return {
          ticker,
          companyName: quote.longName || quote.shortName || ticker,
          shares: holding.shares,
          costBasis,
          currentPrice,
          marketValue,
          weight: 0, // Will be calculated after we have total
          gainLoss: gainLoss ? parseFloat(gainLoss.toFixed(2)) : null,
          gainLossPercent: gainLossPercent ? parseFloat(gainLossPercent.toFixed(2)) : null,
          beta: summary.summaryDetail?.beta ?? null,
          sector: summary.summaryProfile?.sector || 'Unknown',
          industry: summary.summaryProfile?.industry || 'Unknown',
          peRatio: quote.trailingPE ?? null,
          dividendYield: quote.dividendYield ? quote.dividendYield * 100 : null,
          fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh || currentPrice,
          fiftyTwoWeekLow: quote.fiftyTwoWeekLow || currentPrice,
        };
      } catch (error) {
        console.warn(`Failed to fetch data for ${ticker}:`, error);
        // Return minimal data for failed fetches
        return {
          ticker,
          companyName: ticker,
          shares: holding.shares,
          costBasis: holding.costBasis ?? null,
          currentPrice: 0,
          marketValue: 0,
          weight: 0,
          gainLoss: null,
          gainLossPercent: null,
          beta: null,
          sector: 'Unknown',
          industry: 'Unknown',
          peRatio: null,
          dividendYield: null,
          fiftyTwoWeekHigh: 0,
          fiftyTwoWeekLow: 0,
        };
      }
    });

    const holdingDetails = await Promise.all(holdingDataPromises);

    // Calculate total portfolio value
    const totalValue = holdingDetails.reduce((sum, h) => sum + h.marketValue, 0);

    // Calculate weights
    holdingDetails.forEach((h) => {
      h.weight = totalValue > 0 ? parseFloat(((h.marketValue / totalValue) * 100).toFixed(2)) : 0;
    });

    // Sort by weight descending
    holdingDetails.sort((a, b) => b.weight - a.weight);

    // Calculate portfolio-level metrics
    const totalCost = holdingDetails.reduce((sum, h) => {
      if (h.costBasis !== null) {
        return sum + h.costBasis * h.shares;
      }
      return sum;
    }, 0);

    const hasCostBasis = holdingDetails.some((h) => h.costBasis !== null);
    const totalGainLoss = hasCostBasis ? totalValue - totalCost : null;
    const totalGainLossPercent = hasCostBasis && totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : null;

    return {
      holdings: inputData.holdings,
      holdingDetails,
      portfolioMetrics: {
        totalValue: parseFloat(totalValue.toFixed(2)),
        totalCost: hasCostBasis ? parseFloat(totalCost.toFixed(2)) : null,
        totalGainLoss: totalGainLoss ? parseFloat(totalGainLoss.toFixed(2)) : null,
        totalGainLossPercent: totalGainLossPercent ? parseFloat(totalGainLossPercent.toFixed(2)) : null,
        numberOfHoldings: holdingDetails.length,
      },
    };
  },
});

// ============================================================================
// STEP 2: ASSESS PORTFOLIO RISK
// ============================================================================
// Calculates portfolio-level risk metrics

const assessPortfolioRisk = createStep({
  id: 'assess-portfolio-risk',
  description: 'Calculates portfolio-level risk metrics including weighted beta and sector allocation',

  inputSchema: z.object({
    holdings: z.array(holdingInputSchema),
    holdingDetails: z.array(holdingDetailSchema),
    portfolioMetrics: portfolioMetricsSchema,
  }),

  outputSchema: z.object({
    holdings: z.array(holdingInputSchema),
    holdingDetails: z.array(holdingDetailSchema),
    portfolioMetrics: portfolioMetricsSchema,
    riskMetrics: riskMetricsSchema,
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const { holdingDetails, portfolioMetrics } = inputData;

    // Calculate weighted beta
    let weightedBeta = 0;
    let totalWeightWithBeta = 0;

    holdingDetails.forEach((h) => {
      if (h.beta !== null) {
        weightedBeta += (h.weight / 100) * h.beta;
        totalWeightWithBeta += h.weight / 100;
      }
    });

    // Normalize if not all holdings have beta
    if (totalWeightWithBeta > 0 && totalWeightWithBeta < 1) {
      weightedBeta = weightedBeta / totalWeightWithBeta;
    }

    // Calculate sector allocation
    const sectorAllocation: Record<string, number> = {};
    holdingDetails.forEach((h) => {
      const sector = h.sector || 'Unknown';
      sectorAllocation[sector] = (sectorAllocation[sector] || 0) + h.weight;
    });

    // Round sector allocations
    Object.keys(sectorAllocation).forEach((sector) => {
      sectorAllocation[sector] = parseFloat(sectorAllocation[sector].toFixed(2));
    });

    // Calculate top holdings concentration (top 3)
    const topHoldingsConcentration = holdingDetails.slice(0, 3).reduce((sum, h) => sum + h.weight, 0);

    // Calculate diversification score (0-10)
    // Based on: number of sectors, concentration, and number of holdings
    const numberOfSectors = Object.keys(sectorAllocation).length;
    const numberOfHoldings = holdingDetails.length;

    let diversificationScore = 0;

    // Sector diversity (max 4 points)
    diversificationScore += Math.min(numberOfSectors, 8) * 0.5;

    // Number of holdings (max 3 points)
    diversificationScore += Math.min(numberOfHoldings, 15) * 0.2;

    // Concentration penalty (max 3 points deducted)
    if (topHoldingsConcentration > 80) {
      diversificationScore -= 3;
    } else if (topHoldingsConcentration > 60) {
      diversificationScore -= 2;
    } else if (topHoldingsConcentration > 40) {
      diversificationScore -= 1;
    } else {
      diversificationScore += 1;
    }

    diversificationScore = Math.max(1, Math.min(10, Math.round(diversificationScore)));

    // Determine risk level
    let riskLevel = 'Moderate';
    if (weightedBeta > 1.5 || topHoldingsConcentration > 70) {
      riskLevel = 'Aggressive';
    } else if (weightedBeta > 1.2 || topHoldingsConcentration > 50) {
      riskLevel = 'Moderately Aggressive';
    } else if (weightedBeta < 0.8 && numberOfSectors >= 5) {
      riskLevel = 'Conservative';
    } else if (weightedBeta < 0.6) {
      riskLevel = 'Very Conservative';
    }

    return {
      ...inputData,
      riskMetrics: {
        weightedBeta: parseFloat(weightedBeta.toFixed(2)),
        sectorAllocation,
        topHoldingsConcentration: parseFloat(topHoldingsConcentration.toFixed(2)),
        diversificationScore,
        riskLevel,
      },
    };
  },
});

// ============================================================================
// STEP 3: SYNTHESIZE PORTFOLIO ANALYSIS
// ============================================================================
// AI generates comprehensive portfolio report with recommendations

const synthesizePortfolioAnalysis = createStep({
  id: 'synthesize-portfolio-analysis',
  description: 'AI generates comprehensive portfolio analysis with recommendations',

  inputSchema: z.object({
    holdings: z.array(holdingInputSchema),
    holdingDetails: z.array(holdingDetailSchema),
    portfolioMetrics: portfolioMetricsSchema,
    riskMetrics: riskMetricsSchema,
  }),

  outputSchema: z.object({
    portfolioAnalysis: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const { holdingDetails, portfolioMetrics, riskMetrics } = inputData;

    // Build holdings table for prompt
    const holdingsTable = holdingDetails
      .map(
        (h) =>
          `- ${h.ticker} (${h.companyName}): ${h.shares} shares @ $${h.currentPrice.toFixed(2)} = $${h.marketValue.toFixed(2)} (${h.weight}% of portfolio)` +
          (h.gainLossPercent !== null ? ` | P/L: ${h.gainLossPercent >= 0 ? '+' : ''}${h.gainLossPercent}%` : '') +
          ` | Beta: ${h.beta?.toFixed(2) || 'N/A'} | Sector: ${h.sector}`
      )
      .join('\n');

    // Build sector breakdown
    const sectorBreakdown = Object.entries(riskMetrics.sectorAllocation)
      .sort((a, b) => b[1] - a[1])
      .map(([sector, weight]) => `- ${sector}: ${weight}%`)
      .join('\n');

    // Identify top performers and underperformers
    const withGainLoss = holdingDetails.filter((h) => h.gainLossPercent !== null);
    const topPerformers = [...withGainLoss].sort((a, b) => (b.gainLossPercent || 0) - (a.gainLossPercent || 0)).slice(0, 3);
    const underperformers = [...withGainLoss].sort((a, b) => (a.gainLossPercent || 0) - (b.gainLossPercent || 0)).slice(0, 3);

    const prompt = `Analyze the following portfolio and provide comprehensive investment analysis with specific recommendations:

=== PORTFOLIO SUMMARY ===
Total Value: $${portfolioMetrics.totalValue.toLocaleString()}
${portfolioMetrics.totalCost ? `Total Cost Basis: $${portfolioMetrics.totalCost.toLocaleString()}` : 'Cost Basis: Not provided'}
${portfolioMetrics.totalGainLoss !== null ? `Total Gain/Loss: $${portfolioMetrics.totalGainLoss.toLocaleString()} (${portfolioMetrics.totalGainLossPercent?.toFixed(2)}%)` : ''}
Number of Holdings: ${portfolioMetrics.numberOfHoldings}

=== HOLDINGS DETAILS ===
${holdingsTable}

=== SECTOR ALLOCATION ===
${sectorBreakdown}

=== RISK METRICS ===
Weighted Portfolio Beta: ${riskMetrics.weightedBeta}
Top 3 Holdings Concentration: ${riskMetrics.topHoldingsConcentration}%
Diversification Score: ${riskMetrics.diversificationScore}/10
Risk Level: ${riskMetrics.riskLevel}

=== PERFORMANCE HIGHLIGHTS ===
Top Performers:
${topPerformers.map((h) => `- ${h.ticker}: ${h.gainLossPercent! >= 0 ? '+' : ''}${h.gainLossPercent}% ($${h.gainLoss?.toLocaleString()})`).join('\n') || 'N/A (no cost basis provided)'}

Underperformers:
${underperformers.map((h) => `- ${h.ticker}: ${h.gainLossPercent! >= 0 ? '+' : ''}${h.gainLossPercent}% ($${h.gainLoss?.toLocaleString()})`).join('\n') || 'N/A (no cost basis provided)'}

=== YOUR TASK ===
Provide a comprehensive portfolio analysis following the format in your instructions. Be specific with recommendations and consider:
1. Concentration risk (is any single holding or sector too dominant?)
2. Beta/volatility alignment with typical investor profiles
3. Diversification opportunities
4. Rebalancing suggestions with specific percentages
5. Any red flags or concerns`;

    const response = await portfolioSynthesisAgent.streamLegacy([
      {
        role: 'user',
        content: prompt,
      },
    ]);

    let analysisText = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      analysisText += chunk;
    }

    return {
      portfolioAnalysis: analysisText,
    };
  },
});

// ============================================================================
// PORTFOLIO ANALYSIS WORKFLOW DEFINITION
// ============================================================================

export const portfolioAnalysisWorkflow = createWorkflow({
  id: 'portfolio-analysis-workflow',

  inputSchema: z.object({
    holdings: z.array(holdingInputSchema).describe('Array of portfolio holdings with ticker, shares, and optional cost basis'),
  }),

  outputSchema: z.object({
    portfolioAnalysis: z.string(),
  }),
})
  .then(fetchPortfolioData)
  .then(assessPortfolioRisk)
  .then(synthesizePortfolioAnalysis);

portfolioAnalysisWorkflow.commit();

// ============================================================================
// END OF PORTFOLIO WORKFLOW
// ============================================================================
