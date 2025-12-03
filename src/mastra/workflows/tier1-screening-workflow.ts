// ============================================================================
// TIER 1 SCREENING WORKFLOW
// ============================================================================
// Quantitative screening workflow for the Intelligent Portfolio Builder.
// Scores all stocks in the universe using multi-factor analysis and filters
// down to top candidates for further analysis.
//
// INPUT: Stock universe (default: S&P 500), strategy, config
// OUTPUT: ~50-80 candidates with scores and metrics
// TIME: ~2-3 minutes for full S&P 500
//
// STEPS:
// 1. Initialize screening run and load universe
// 2. Batch score all stocks using scoreStocksBatchTool
// 3. Filter candidates by minimum thresholds
// 4. Persist results to database
// ============================================================================

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import { ALL_SP500_TICKERS, getSectorForTicker } from '../data/sp500-stocks';
import {
  createScreeningRun,
  updateScreeningRunTier1,
  createStockAnalysesBatch,
  failScreeningRun,
} from '../db/analysis-repository';
import {
  scoreStocksBatchTool,
  StockScoreOutput,
  VALUE_STRATEGY_WEIGHTS,
  GROWTH_STRATEGY_WEIGHTS,
  BALANCED_STRATEGY_WEIGHTS,
} from '../tools/optimizer-tools';

// ============================================================================
// SCHEMAS
// ============================================================================

const tier1InputSchema = z.object({
  // Optional screening run ID (if provided, reuses existing run)
  screeningRunId: z.string().optional(),

  // Stock universe to screen (default: S&P 500)
  universe: z.array(z.string()).optional(),

  // Screening strategy
  strategy: z.enum(['value', 'growth', 'balanced']).default('value'),

  // Portfolio ID if this is a monthly review (null for initial construction)
  portfolioId: z.string().nullable().optional(),

  // Configuration
  config: z
    .object({
      minScore: z.number().default(45),
      maxCandidates: z.number().default(80),
      requirePositiveFCF: z.boolean().default(true),
      maxPE: z.number().default(100),
      minMarketCap: z.number().default(1_000_000_000),
    })
    .optional(),
});

const tier1CandidateSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  sector: z.string().nullable(),
  tier1Score: z.number(),
  price: z.number(),
  marketCap: z.number(),
  metrics: z.object({
    peRatio: z.number().nullable(),
    pbRatio: z.number().nullable(),
    psRatio: z.number().nullable(),
    dividendYield: z.number().nullable(),
    profitMargin: z.number().nullable(),
    roe: z.number().nullable(),
    currentRatio: z.number().nullable(),
    debtToEquity: z.number().nullable(),
    revenueGrowth: z.number().nullable(),
    earningsGrowth: z.number().nullable(),
    beta: z.number().nullable(),
    fiftyTwoWeekChange: z.number().nullable(),
  }),
  componentScores: z.object({
    valueScore: z.number(),
    qualityScore: z.number(),
    riskScore: z.number(),
    growthScore: z.number(),
    momentumScore: z.number(),
  }),
});

export type Tier1Candidate = z.infer<typeof tier1CandidateSchema>;

const tier1OutputSchema = z.object({
  screeningRunId: z.string(),
  candidates: z.array(tier1CandidateSchema),
  totalScreened: z.number(),
  passedCount: z.number(),
  rejectedCount: z.number(),
  rejectionBreakdown: z.object({
    lowScore: z.number(),
    negativeFCF: z.number(),
    highPE: z.number(),
    lowMarketCap: z.number(),
    dataError: z.number(),
  }),
  executionTimeMs: z.number(),
  strategy: z.enum(['value', 'growth', 'balanced']),
});

export type Tier1Output = z.infer<typeof tier1OutputSchema>;

// ============================================================================
// STEP 1: INITIALIZE SCREENING RUN
// ============================================================================

const initializeScreeningRunStep = createStep({
  id: 'initialize-screening-run',
  inputSchema: tier1InputSchema,
  outputSchema: z.object({
    screeningRunId: z.string(),
    universe: z.array(z.string()),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.object({
      minScore: z.number(),
      maxCandidates: z.number(),
      requirePositiveFCF: z.boolean(),
      maxPE: z.number(),
      minMarketCap: z.number(),
    }),
    portfolioId: z.string().nullable(),
  }),

  execute: async ({ inputData }) => {
    const universe = inputData.universe || ALL_SP500_TICKERS;
    const strategy = inputData.strategy || 'value';
    const portfolioId = inputData.portfolioId || null;
    const config = {
      minScore: inputData.config?.minScore ?? 45,
      maxCandidates: inputData.config?.maxCandidates ?? 80,
      requirePositiveFCF: inputData.config?.requirePositiveFCF ?? true,
      maxPE: inputData.config?.maxPE ?? 100,
      minMarketCap: inputData.config?.minMarketCap ?? 1_000_000_000,
    };

    // Use provided run ID or generate a new one
    const screeningRunId = inputData.screeningRunId || `run-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // Only create screening run if not provided (i.e., standalone run)
    if (!inputData.screeningRunId) {
      await createScreeningRun({
        id: screeningRunId,
        portfolioId,
        runType: portfolioId ? 'MONTHLY_REVIEW' : 'CONSTRUCTION',
        strategy,
        tier1InputCount: universe.length,
        tier1OutputCount: null,
        tier1CompletedAt: null,
        tier2InputCount: null,
        tier2OutputCount: null,
        tier2RejectedCount: null,
        tier2CompletedAt: null,
        tier3InputCount: null,
        tier3OutputCount: null,
        tier3CompletedAt: null,
        finalPortfolioCount: null,
        config: {
          tier1MinScore: config.minScore,
          tier1MaxCandidates: config.maxCandidates,
          tier2MaxCandidates: 25,
          tier3MinConviction: 60,
          maxSectorPct: 0.25,
          minPositionPct: 0.05,
          maxPositionPct: 0.12,
          targetHoldings: 12,
          cashReservePct: 0.05,
        },
        errorMessage: null,
      });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`TIER 1 SCREENING INITIALIZED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Run ID: ${screeningRunId}`);
    console.log(`Universe: ${universe.length} stocks`);
    console.log(`Strategy: ${strategy}`);
    console.log(`Min Score: ${config.minScore}`);
    console.log(`Max Candidates: ${config.maxCandidates}`);
    console.log(`${'='.repeat(60)}\n`);

    return {
      screeningRunId,
      universe,
      strategy,
      config,
      portfolioId,
    };
  },
});

// ============================================================================
// STEP 2: BATCH SCORE ALL STOCKS
// ============================================================================

const batchScoreStocksStep = createStep({
  id: 'batch-score-stocks',
  inputSchema: z.object({
    screeningRunId: z.string(),
    universe: z.array(z.string()),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.object({
      minScore: z.number(),
      maxCandidates: z.number(),
      requirePositiveFCF: z.boolean(),
      maxPE: z.number(),
      minMarketCap: z.number(),
    }),
    portfolioId: z.string().nullable(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    allScores: z.array(z.any()), // StockScoreOutput[]
    failedTickers: z.array(z.string()),
    processingTimeSeconds: z.number(),
    config: z.object({
      minScore: z.number(),
      maxCandidates: z.number(),
      requirePositiveFCF: z.boolean(),
      maxPE: z.number(),
      minMarketCap: z.number(),
    }),
    strategy: z.enum(['value', 'growth', 'balanced']),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, universe, strategy, config } = inputData;

    console.log(`\nScoring ${universe.length} stocks with ${strategy} strategy...`);
    console.log(`This may take 2-3 minutes...\n`);

    const startTime = Date.now();

    try {
      // Call the batch scoring tool directly using its execute function
      // We need to pass the proper context structure
      const result = await scoreStocksBatchTool.execute({
        context: {
          tickers: universe,
          strategy,
          saveToDb: true, // Save raw scores to stock_scores table
        },
        runtimeContext: {} as any,
      });

      const processingTimeSeconds = Math.round((Date.now() - startTime) / 1000);

      console.log(`\nScoring complete!`);
      console.log(`- Processed: ${result.totalProcessed} stocks`);
      console.log(`- Successful: ${result.successCount}`);
      console.log(`- Failed: ${result.failedTickers.length}`);
      console.log(`- Time: ${processingTimeSeconds}s`);

      return {
        screeningRunId,
        allScores: result.scores,
        failedTickers: result.failedTickers,
        processingTimeSeconds,
        config,
        strategy,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await failScreeningRun(screeningRunId, `Tier 1 scoring failed: ${errorMessage}`);
      throw error;
    }
  },
});

// ============================================================================
// STEP 3: FILTER CANDIDATES
// ============================================================================

const filterCandidatesStep = createStep({
  id: 'filter-candidates',
  inputSchema: z.object({
    screeningRunId: z.string(),
    allScores: z.array(z.any()),
    failedTickers: z.array(z.string()),
    processingTimeSeconds: z.number(),
    config: z.object({
      minScore: z.number(),
      maxCandidates: z.number(),
      requirePositiveFCF: z.boolean(),
      maxPE: z.number(),
      minMarketCap: z.number(),
    }),
    strategy: z.enum(['value', 'growth', 'balanced']),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    candidates: z.array(tier1CandidateSchema),
    rejectionBreakdown: z.object({
      lowScore: z.number(),
      negativeFCF: z.number(),
      highPE: z.number(),
      lowMarketCap: z.number(),
      dataError: z.number(),
    }),
    totalScreened: z.number(),
    processingTimeSeconds: z.number(),
    strategy: z.enum(['value', 'growth', 'balanced']),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, allScores, failedTickers, config, processingTimeSeconds, strategy } = inputData;

    console.log(`\nFiltering candidates...`);
    console.log(`- Min Score: ${config.minScore}`);
    console.log(`- Max P/E: ${config.maxPE}`);
    console.log(`- Min Market Cap: $${(config.minMarketCap / 1_000_000_000).toFixed(1)}B`);

    const candidates: Tier1Candidate[] = [];
    const rejectionBreakdown = {
      lowScore: 0,
      negativeFCF: 0,
      highPE: 0,
      lowMarketCap: 0,
      dataError: failedTickers.length,
    };

    for (const score of allScores as StockScoreOutput[]) {
      // Check minimum score
      if (score.totalScore < config.minScore) {
        rejectionBreakdown.lowScore++;
        continue;
      }

      // Check P/E ratio (skip extreme values, but allow NULL for loss-making companies)
      // NULL P/E companies are not filtered here - they're penalized in scoring instead
      const pe = score.metrics.peRatio;
      if (pe !== null && pe > 0 && pe > config.maxPE) {
        rejectionBreakdown.highPE++;
        continue;
      }

      // Check market cap
      if (score.marketCap < config.minMarketCap) {
        rejectionBreakdown.lowMarketCap++;
        continue;
      }

      // Check for negative profit margin as proxy for FCF issues
      if (config.requirePositiveFCF && score.metrics.profitMargin !== null && score.metrics.profitMargin < 0) {
        rejectionBreakdown.negativeFCF++;
        continue;
      }

      // Passed all filters
      candidates.push({
        ticker: score.ticker,
        companyName: score.companyName,
        sector: score.sector,
        tier1Score: score.totalScore,
        price: score.price,
        marketCap: score.marketCap,
        metrics: score.metrics,
        componentScores: {
          valueScore: score.valueScore,
          qualityScore: score.qualityScore,
          riskScore: score.riskScore,
          growthScore: score.growthScore,
          momentumScore: score.momentumScore,
        },
      });
    }

    // Sort by score descending and limit
    candidates.sort((a, b) => b.tier1Score - a.tier1Score);
    const limitedCandidates = candidates.slice(0, config.maxCandidates);

    console.log(`\nFiltering complete!`);
    console.log(`- Passed: ${limitedCandidates.length} candidates`);
    console.log(`- Rejected: ${allScores.length - limitedCandidates.length}`);
    console.log(`  - Low score: ${rejectionBreakdown.lowScore}`);
    console.log(`  - High P/E: ${rejectionBreakdown.highPE}`);
    console.log(`  - Low market cap: ${rejectionBreakdown.lowMarketCap}`);
    console.log(`  - Negative FCF: ${rejectionBreakdown.negativeFCF}`);
    console.log(`  - Data errors: ${rejectionBreakdown.dataError}`);

    return {
      screeningRunId,
      candidates: limitedCandidates,
      rejectionBreakdown,
      totalScreened: allScores.length + failedTickers.length,
      processingTimeSeconds,
      strategy,
    };
  },
});

// ============================================================================
// STEP 4: PERSIST RESULTS
// ============================================================================

const persistTier1ResultsStep = createStep({
  id: 'persist-tier1-results',
  inputSchema: z.object({
    screeningRunId: z.string(),
    candidates: z.array(tier1CandidateSchema),
    rejectionBreakdown: z.object({
      lowScore: z.number(),
      negativeFCF: z.number(),
      highPE: z.number(),
      lowMarketCap: z.number(),
      dataError: z.number(),
    }),
    totalScreened: z.number(),
    processingTimeSeconds: z.number(),
    strategy: z.enum(['value', 'growth', 'balanced']),
  }),
  outputSchema: tier1OutputSchema,

  execute: async ({ inputData }) => {
    const { screeningRunId, candidates, rejectionBreakdown, totalScreened, processingTimeSeconds, strategy } =
      inputData;

    console.log(`\nPersisting Tier 1 results to database...`);

    // Create stock analysis records for all candidates
    const analyses = candidates.map((candidate) => ({
      screeningRunId,
      ticker: candidate.ticker,
      tier1Score: candidate.tier1Score,
      tier1Passed: true,
    }));

    await createStockAnalysesBatch(analyses);

    // Update screening run with Tier 1 results
    await updateScreeningRunTier1(screeningRunId, totalScreened, candidates.length);

    const rejectedCount = Object.values(rejectionBreakdown).reduce((a, b) => a + b, 0);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`TIER 1 SCREENING COMPLETE`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Run ID: ${screeningRunId}`);
    console.log(`Total Screened: ${totalScreened}`);
    console.log(`Candidates Passed: ${candidates.length}`);
    console.log(`Rejected: ${rejectedCount}`);
    console.log(`Execution Time: ${processingTimeSeconds}s`);
    console.log(`\nTop 10 Candidates:`);
    candidates.slice(0, 10).forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.ticker.padEnd(6)} | Score: ${c.tier1Score} | ${c.sector || 'N/A'}`);
    });
    console.log(`${'='.repeat(60)}\n`);

    return {
      screeningRunId,
      candidates,
      totalScreened,
      passedCount: candidates.length,
      rejectedCount,
      rejectionBreakdown,
      executionTimeMs: processingTimeSeconds * 1000,
      strategy,
    };
  },
});

// ============================================================================
// WORKFLOW DEFINITION
// ============================================================================

export const tier1ScreeningWorkflow = createWorkflow({
  id: 'tier1-screening',
  inputSchema: tier1InputSchema,
  outputSchema: tier1OutputSchema,
})
  .then(initializeScreeningRunStep)
  .then(batchScoreStocksStep)
  .then(filterCandidatesStep)
  .then(persistTier1ResultsStep);

tier1ScreeningWorkflow.commit();

// ============================================================================
// CONVENIENCE FUNCTION FOR DIRECT EXECUTION
// ============================================================================

export async function runTier1Screening(options?: {
  universe?: string[];
  strategy?: 'value' | 'growth' | 'balanced';
  portfolioId?: string | null;
  minScore?: number;
  maxCandidates?: number;
}): Promise<Tier1Output> {
  const run = tier1ScreeningWorkflow.createRun();

  const result = await run.start({
    inputData: {
      universe: options?.universe,
      strategy: options?.strategy || 'value',
      portfolioId: options?.portfolioId || null,
      config: {
        minScore: options?.minScore ?? 45,
        maxCandidates: options?.maxCandidates ?? 80,
        requirePositiveFCF: true,
        maxPE: 100,
        minMarketCap: 1_000_000_000,
      },
    },
  });

  if (result.status !== 'success') {
    throw new Error(`Tier 1 screening failed: ${JSON.stringify(result)}`);
  }

  return result.result as Tier1Output;
}

// ============================================================================
// END OF TIER 1 SCREENING WORKFLOW
// ============================================================================
