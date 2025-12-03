// ============================================================================
// TRIAGE TOOLS
// ============================================================================
// Tools for Tier 2 intelligent triage of stock candidates.
// These tools provide quick checks to decide PASS/REJECT/FAST_TRACK.
//
// The main tool bundles multiple checks for efficiency:
// - Analyst ratings (consensus, target price)
// - Short interest (bearish sentiment indicator)
// - Earnings sentiment (beat/miss history)
// - Beta/volatility (risk level)
// - Upgrade/downgrade history
//
// This tool is designed to be called by the Triage Coordinator agent
// to make routing decisions in the intelligent portfolio builder.
// ============================================================================

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ============================================================================
// TYPES
// ============================================================================

export type TriageRecommendation = 'PASS' | 'REJECT' | 'FAST_TRACK' | 'NEEDS_REVIEW';

export interface TriageCheckResult {
  ticker: string;
  companyName: string;
  sector: string | null;

  // Analyst data
  analystConsensus: string | null;
  analystCount: number;
  targetPrice: number | null;
  targetUpside: number | null;

  // Short interest
  shortPercentOfFloat: number | null;
  shortRisk: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME' | null;

  // Earnings
  lastEarningsSurprise: number | null;
  earningsSentiment: 'BEAT' | 'MISS' | 'INLINE' | null;

  // Risk metrics
  beta: number | null;
  riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH' | null;

  // Upgrade/downgrade
  recentUpgrades: number;
  recentDowngrades: number;
  ratingTrend: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';

  // Aggregated flags
  redFlags: string[];
  greenFlags: string[];

  // Recommendation
  recommendation: TriageRecommendation;
  reasoning: string;
}

// ============================================================================
// QUICK TRIAGE CHECK TOOL
// ============================================================================

export const quickTriageCheckTool = createTool({
  id: 'quick-triage-check',
  description: `
    Run quick sentiment, risk, and earnings checks for triage decisions.
    Returns analyst ratings, short interest, earnings sentiment, beta, and upgrade/downgrade history.
    Also provides aggregated red/green flags and a recommendation (PASS, REJECT, FAST_TRACK, NEEDS_REVIEW).
  `,

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
    tier1Score: z.number().describe('Tier 1 quantitative score (0-100)'),
    sector: z.string().nullable().optional().describe('Stock sector'),
    checks: z
      .array(
        z.enum(['analyst_ratings', 'short_interest', 'earnings_sentiment', 'beta_volatility', 'upgrade_downgrade'])
      )
      .optional()
      .describe('Specific checks to run (default: all)'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    sector: z.string().nullable(),

    analystConsensus: z.string().nullable(),
    analystCount: z.number(),
    targetPrice: z.number().nullable(),
    targetUpside: z.number().nullable(),

    shortPercentOfFloat: z.number().nullable(),
    shortRisk: z.enum(['LOW', 'MODERATE', 'HIGH', 'EXTREME']).nullable(),

    lastEarningsSurprise: z.number().nullable(),
    earningsSentiment: z.enum(['BEAT', 'MISS', 'INLINE']).nullable(),

    beta: z.number().nullable(),
    riskLevel: z.enum(['LOW', 'MODERATE', 'HIGH', 'VERY_HIGH']).nullable(),

    recentUpgrades: z.number(),
    recentDowngrades: z.number(),
    ratingTrend: z.enum(['POSITIVE', 'NEGATIVE', 'NEUTRAL']),

    redFlags: z.array(z.string()),
    greenFlags: z.array(z.string()),

    recommendation: z.enum(['PASS', 'REJECT', 'FAST_TRACK', 'NEEDS_REVIEW']),
    reasoning: z.string(),
  }),

  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    const tier1Score = context.tier1Score;
    const checksToRun = context.checks || [
      'analyst_ratings',
      'short_interest',
      'earnings_sentiment',
      'beta_volatility',
      'upgrade_downgrade',
    ];

    const redFlags: string[] = [];
    const greenFlags: string[] = [];

    // Initialize result with defaults
    const result: TriageCheckResult = {
      ticker,
      companyName: ticker,
      sector: context.sector || null,
      analystConsensus: null,
      analystCount: 0,
      targetPrice: null,
      targetUpside: null,
      shortPercentOfFloat: null,
      shortRisk: null,
      lastEarningsSurprise: null,
      earningsSentiment: null,
      beta: null,
      riskLevel: null,
      recentUpgrades: 0,
      recentDowngrades: 0,
      ratingTrend: 'NEUTRAL',
      redFlags: [],
      greenFlags: [],
      recommendation: 'NEEDS_REVIEW',
      reasoning: '',
    };

    try {
      // Fetch all data in parallel for efficiency
      const [quote, summary] = await Promise.all([
        yf.quote(ticker),
        yf.quoteSummary(ticker, {
          modules: [
            'recommendationTrend',
            'financialData',
            'upgradeDowngradeHistory',
            'earningsHistory',
            'defaultKeyStatistics',
          ],
        }),
      ]);

      result.companyName = quote.longName || quote.shortName || ticker;
      const currentPrice = quote.regularMarketPrice || 0;

      // ========================================
      // ANALYST RATINGS
      // ========================================
      if (checksToRun.includes('analyst_ratings')) {
        const trends = summary.recommendationTrend?.trend || [];
        const latestTrend = trends[0];

        if (latestTrend) {
          const strongBuy = latestTrend.strongBuy || 0;
          const buy = latestTrend.buy || 0;
          const hold = latestTrend.hold || 0;
          const sell = latestTrend.sell || 0;
          const strongSell = latestTrend.strongSell || 0;
          const total = strongBuy + buy + hold + sell + strongSell;

          result.analystCount = total;

          if (total > 0) {
            const bullish = strongBuy + buy;
            const bearish = sell + strongSell;
            const bullishPct = (bullish / total) * 100;
            const bearishPct = (bearish / total) * 100;

            if (bullishPct >= 70) {
              result.analystConsensus = 'Strong Buy';
              greenFlags.push('Strong analyst consensus (70%+ bullish)');
            } else if (bullishPct >= 50) {
              result.analystConsensus = 'Buy';
              greenFlags.push('Positive analyst consensus');
            } else if (bearishPct >= 40) {
              result.analystConsensus = 'Sell';
              redFlags.push('Negative analyst consensus (40%+ bearish)');
            } else {
              result.analystConsensus = 'Hold';
            }
          }
        }

        // Target price
        const targetPrice = summary.financialData?.targetMeanPrice;
        if (targetPrice && currentPrice > 0) {
          result.targetPrice = targetPrice;
          result.targetUpside = ((targetPrice - currentPrice) / currentPrice) * 100;

          if (result.targetUpside > 20) {
            greenFlags.push(`High target upside (${result.targetUpside.toFixed(0)}%)`);
          } else if (result.targetUpside < -10) {
            redFlags.push(`Negative target upside (${result.targetUpside.toFixed(0)}%)`);
          }
        }
      }

      // ========================================
      // SHORT INTEREST
      // ========================================
      if (checksToRun.includes('short_interest')) {
        const keyStats = summary.defaultKeyStatistics;
        const shortPctFloat = keyStats?.shortPercentOfFloat;

        if (shortPctFloat !== undefined && shortPctFloat !== null) {
          result.shortPercentOfFloat = shortPctFloat * 100; // Convert to percentage

          if (result.shortPercentOfFloat > 25) {
            result.shortRisk = 'EXTREME';
            redFlags.push(`Extreme short interest (${result.shortPercentOfFloat.toFixed(1)}%)`);
          } else if (result.shortPercentOfFloat > 15) {
            result.shortRisk = 'HIGH';
            redFlags.push(`High short interest (${result.shortPercentOfFloat.toFixed(1)}%)`);
          } else if (result.shortPercentOfFloat > 8) {
            result.shortRisk = 'MODERATE';
          } else {
            result.shortRisk = 'LOW';
          }
        }
      }

      // ========================================
      // EARNINGS SENTIMENT
      // ========================================
      if (checksToRun.includes('earnings_sentiment')) {
        const earningsHistory = summary.earningsHistory?.history || [];

        if (earningsHistory.length > 0) {
          const latestEarnings = earningsHistory[0] as {
            epsActual?: number;
            epsEstimate?: number;
            epsDifference?: number;
          };
          const epsActual = latestEarnings.epsActual;
          const epsEstimate = latestEarnings.epsEstimate;

          if (epsActual !== undefined && epsEstimate !== undefined && epsEstimate !== 0) {
            result.lastEarningsSurprise = ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100;

            if (result.lastEarningsSurprise > 5) {
              result.earningsSentiment = 'BEAT';
              greenFlags.push(`Earnings beat (+${result.lastEarningsSurprise.toFixed(1)}%)`);
            } else if (result.lastEarningsSurprise < -5) {
              result.earningsSentiment = 'MISS';
              redFlags.push(`Earnings miss (${result.lastEarningsSurprise.toFixed(1)}%)`);
            } else {
              result.earningsSentiment = 'INLINE';
            }
          }

          // Check for consecutive misses (stronger red flag)
          if (earningsHistory.length >= 2) {
            const recentMisses = earningsHistory.slice(0, 2).filter((e: any) => {
              const actual = e.epsActual;
              const estimate = e.epsEstimate;
              return actual !== undefined && actual !== null && estimate !== undefined && estimate !== null && actual < estimate;
            }).length;

            if (recentMisses >= 2) {
              redFlags.push('Two consecutive earnings misses');
            }
          }
        }
      }

      // ========================================
      // BETA & VOLATILITY
      // ========================================
      if (checksToRun.includes('beta_volatility')) {
        const beta = quote.beta || summary.defaultKeyStatistics?.beta;

        if (beta !== undefined && beta !== null) {
          result.beta = beta;

          if (beta > 2.0) {
            result.riskLevel = 'VERY_HIGH';
            redFlags.push(`Very high beta (${beta.toFixed(2)})`);
          } else if (beta > 1.5) {
            result.riskLevel = 'HIGH';
            redFlags.push(`High beta (${beta.toFixed(2)})`);
          } else if (beta > 1.0) {
            result.riskLevel = 'MODERATE';
          } else {
            result.riskLevel = 'LOW';
            greenFlags.push(`Low beta (${beta.toFixed(2)})`);
          }
        }
      }

      // ========================================
      // UPGRADE/DOWNGRADE
      // ========================================
      if (checksToRun.includes('upgrade_downgrade')) {
        const history = summary.upgradeDowngradeHistory?.history || [];

        // Look at last 90 days of upgrades/downgrades
        const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

        for (const event of history.slice(0, 20)) {
          const eventAny = event as any;
          const epochDate = eventAny.epochGradeDate;
          // epochGradeDate can be a Date object or a number (epoch seconds)
          const eventTime = epochDate instanceof Date ? epochDate.getTime() : (typeof epochDate === 'number' ? epochDate * 1000 : 0);
          if (eventTime > ninetyDaysAgo) {
            const action = (eventAny.action || '').toLowerCase();
            if (action.includes('up') || action.includes('init')) {
              result.recentUpgrades++;
            } else if (action.includes('down')) {
              result.recentDowngrades++;
            }
          }
        }

        if (result.recentUpgrades > result.recentDowngrades + 2) {
          result.ratingTrend = 'POSITIVE';
          greenFlags.push(`Recent upgrades (${result.recentUpgrades} up vs ${result.recentDowngrades} down)`);
        } else if (result.recentDowngrades > result.recentUpgrades + 2) {
          result.ratingTrend = 'NEGATIVE';
          redFlags.push(`Recent downgrades (${result.recentDowngrades} down vs ${result.recentUpgrades} up)`);
        }
      }

      // ========================================
      // MAKE RECOMMENDATION
      // ========================================
      result.redFlags = redFlags;
      result.greenFlags = greenFlags;

      // Decision logic
      const majorRedFlags = redFlags.filter(
        (f) =>
          f.includes('Extreme short') ||
          f.includes('Very high beta') ||
          f.includes('consecutive earnings misses') ||
          f.includes('Negative analyst consensus')
      );

      const majorGreenFlags = greenFlags.filter(
        (f) => f.includes('Strong analyst consensus') || f.includes('High target upside') || f.includes('Earnings beat')
      );

      if (majorRedFlags.length >= 2) {
        // Multiple major red flags = REJECT
        result.recommendation = 'REJECT';
        result.reasoning = `Rejected due to major red flags: ${majorRedFlags.join('; ')}`;
      } else if (majorRedFlags.length === 1 && majorGreenFlags.length === 0) {
        // Single major red flag with no offsetting green flags
        result.recommendation = 'REJECT';
        result.reasoning = `Rejected due to: ${majorRedFlags[0]}`;
      } else if (tier1Score >= 70 && majorGreenFlags.length >= 2 && majorRedFlags.length === 0) {
        // High score + multiple green flags + no major red flags = FAST_TRACK
        result.recommendation = 'FAST_TRACK';
        result.reasoning = `Fast-tracked: High Tier 1 score (${tier1Score}) with positive signals: ${majorGreenFlags.join('; ')}`;
      } else if (tier1Score >= 55 && majorRedFlags.length === 0) {
        // Decent score, no major red flags = PASS
        result.recommendation = 'PASS';
        result.reasoning = `Passed: Score ${tier1Score} with ${greenFlags.length} positive signals and no major concerns`;
      } else if (redFlags.length > greenFlags.length + 2) {
        // More red flags than green = lean toward REJECT
        result.recommendation = 'REJECT';
        result.reasoning = `Rejected: Too many concerns (${redFlags.length} red flags vs ${greenFlags.length} green flags)`;
      } else {
        // Mixed signals = NEEDS_REVIEW
        result.recommendation = 'NEEDS_REVIEW';
        result.reasoning = `Mixed signals: ${redFlags.length} concerns, ${greenFlags.length} positives. Manual review recommended.`;
      }

      return result;
    } catch (error) {
      // If we can't fetch data, mark for review
      result.recommendation = 'NEEDS_REVIEW';
      result.reasoning = `Unable to complete triage checks: ${error instanceof Error ? error.message : 'Unknown error'}`;
      result.redFlags = [`Data fetch error: ${error instanceof Error ? error.message : 'Unknown'}`];
      return result;
    }
  },
});

// ============================================================================
// BATCH TRIAGE TOOL
// ============================================================================

export const batchTriageCheckTool = createTool({
  id: 'batch-triage-check',
  description: 'Run quick triage checks on multiple stocks in parallel with rate limiting',

  inputSchema: z.object({
    candidates: z
      .array(
        z.object({
          ticker: z.string(),
          tier1Score: z.number(),
          sector: z.string().nullable(),
        })
      )
      .describe('Array of Tier 1 candidates to triage'),
  }),

  outputSchema: z.object({
    results: z.array(
      z.object({
        ticker: z.string(),
        recommendation: z.enum(['PASS', 'REJECT', 'FAST_TRACK', 'NEEDS_REVIEW']),
        reasoning: z.string(),
        redFlagsCount: z.number(),
        greenFlagsCount: z.number(),
      })
    ),
    summary: z.object({
      total: z.number(),
      passed: z.number(),
      rejected: z.number(),
      fastTracked: z.number(),
      needsReview: z.number(),
    }),
  }),

  execute: async ({ context }) => {
    const { candidates } = context;
    const results: {
      ticker: string;
      recommendation: TriageRecommendation;
      reasoning: string;
      redFlagsCount: number;
      greenFlagsCount: number;
    }[] = [];

    // Process in batches of 5 to avoid rate limiting
    const batchSize = 5;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (candidate) => {
          try {
            const triageResult = await quickTriageCheckTool.execute({
              context: {
                ticker: candidate.ticker,
                tier1Score: candidate.tier1Score,
                sector: candidate.sector,
              },
              runtimeContext: {} as any,
            });

            return {
              ticker: candidate.ticker,
              recommendation: triageResult.recommendation,
              reasoning: triageResult.reasoning,
              redFlagsCount: triageResult.redFlags.length,
              greenFlagsCount: triageResult.greenFlags.length,
            };
          } catch (error) {
            return {
              ticker: candidate.ticker,
              recommendation: 'NEEDS_REVIEW' as TriageRecommendation,
              reasoning: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
              redFlagsCount: 1,
              greenFlagsCount: 0,
            };
          }
        })
      );

      results.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < candidates.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // Calculate summary
    const summary = {
      total: results.length,
      passed: results.filter((r) => r.recommendation === 'PASS').length,
      rejected: results.filter((r) => r.recommendation === 'REJECT').length,
      fastTracked: results.filter((r) => r.recommendation === 'FAST_TRACK').length,
      needsReview: results.filter((r) => r.recommendation === 'NEEDS_REVIEW').length,
    };

    return { results, summary };
  },
});

// ============================================================================
// EXPORTS
// ============================================================================

export const triageTools = [quickTriageCheckTool, batchTriageCheckTool];
