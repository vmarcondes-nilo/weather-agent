// ============================================================================
// INTELLIGENT PORTFOLIO BUILDER WORKFLOW
// ============================================================================
// End-to-end orchestration workflow that runs the complete 3-tier funnel:
//
// PIPELINE:
// 1. Tier 1: Quantitative Screening (500 → ~50-80 candidates)
// 2. Tier 2: Intelligent Triage (~50-80 → ~20-25 finalists)
// 3. Tier 3: Deep Analysis (~20-25 → 10-12 holdings)
// 4. Portfolio Construction (final allocation and execution)
//
// INPUT: Strategy (value/growth/balanced) + optional config
// OUTPUT: Fully constructed portfolio with holdings and transactions
//
// TIME: ~20-30 minutes for full run
// ============================================================================

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import {
  createPortfolio,
  getPortfolio,
  deletePortfolio,
  addHolding,
  recordTransaction,
  createSnapshot,
  updateHoldingConviction,
} from '../db/portfolio-repository';
import {
  createScreeningRun,
  completeScreeningRun,
  failScreeningRun,
  updateScreeningRunPortfolio,
} from '../db/analysis-repository';
import { optimizePortfolioAllocationTool } from '../tools/portfolio-construction-tools';
import { HoldingSnapshot, ConvictionLevel } from '../db/schema';

// Import tier workflows
import { tier1ScreeningWorkflow } from './tier1-screening-workflow';
import { tier2TriageWorkflow } from './tier2-triage-workflow';
import { tier3ResearchWorkflow } from './tier3-research-workflow';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG = {
  // Portfolio config
  portfolioId: 'intelligent-portfolio-1',
  portfolioName: 'Intelligent S&P 500 Portfolio',
  initialCapital: 100000,
  targetHoldings: 12,
  cashReservePct: 5,
  maxSectorPct: 25,
  maxPositionPct: 10,
  minPositionPct: 2,

  // Tier 1 config
  tier1MinScore: 50,
  tier1MaxCandidates: 80,

  // Tier 2 config
  tier2MaxFinalists: 25,
  tier2FastTrackMinScore: 70,

  // Tier 3 config
  tier3MaxHoldings: 12,
  tier3MinConviction: 50,
};

// ============================================================================
// SCHEMAS
// ============================================================================

const pipelineInputSchema = z.object({
  strategy: z.enum(['value', 'growth', 'balanced']).default('balanced'),
  config: z
    .object({
      portfolioId: z.string().optional(),
      portfolioName: z.string().optional(),
      initialCapital: z.number().optional(),
      targetHoldings: z.number().optional(),
      cashReservePct: z.number().optional(),
      maxSectorPct: z.number().optional(),
      maxPositionPct: z.number().optional(),
      minPositionPct: z.number().optional(),
      tier1MinScore: z.number().optional(),
      tier1MaxCandidates: z.number().optional(),
      tier2MaxFinalists: z.number().optional(),
      tier3MinConviction: z.number().optional(),
      // Testing options
      testMode: z.boolean().optional(),
      tier1SampleSize: z.number().optional(),
      tier2SampleSize: z.number().optional(),
      tier3SampleSize: z.number().optional(),
    })
    .optional(),
});

const pipelineOutputSchema = z.object({
  success: z.boolean(),
  screeningRunId: z.string(),
  portfolioId: z.string(),
  strategy: z.enum(['value', 'growth', 'balanced']),

  // Pipeline summary
  pipeline: z.object({
    tier1: z.object({
      inputCount: z.number(),
      outputCount: z.number(),
      executionTimeSeconds: z.number(),
    }),
    tier2: z.object({
      inputCount: z.number(),
      outputCount: z.number(),
      fastTrackedCount: z.number(),
      executionTimeSeconds: z.number(),
    }),
    tier3: z.object({
      inputCount: z.number(),
      outputCount: z.number(),
      executionTimeSeconds: z.number(),
    }),
    totalExecutionTimeSeconds: z.number(),
  }),

  // Portfolio summary
  portfolio: z.object({
    holdingsCount: z.number(),
    totalValue: z.number(),
    cashValue: z.number(),
    averageConviction: z.number(),
    averageUpside: z.number().nullable(),
    sectorBreakdown: z.record(
      z.object({
        count: z.number(),
        weight: z.number(),
        tickers: z.array(z.string()),
      })
    ),
  }),

  // Holdings detail
  holdings: z.array(
    z.object({
      ticker: z.string(),
      companyName: z.string(),
      sector: z.string().nullable(),
      shares: z.number(),
      price: z.number(),
      value: z.number(),
      weight: z.number(),
      convictionScore: z.number(),
      convictionLevel: z.string(),
      compositeUpside: z.number().nullable(),
    })
  ),

  errorMessage: z.string().nullable(),
});

export type IntelligentPortfolioOutput = z.infer<typeof pipelineOutputSchema>;

// ============================================================================
// STEP 1: INITIALIZE PIPELINE
// ============================================================================

const initializePipelineStep = createStep({
  id: 'initialize-pipeline',
  inputSchema: pipelineInputSchema,
  outputSchema: z.object({
    screeningRunId: z.string(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
  }),

  execute: async ({ inputData }) => {
    const strategy = inputData.strategy || 'balanced';
    const userConfig = inputData.config || {};

    const config = {
      ...DEFAULT_CONFIG,
      ...userConfig,
    };

    // Generate unique screening run ID
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const screeningRunId = `IPB-${strategy.toUpperCase()}-${timestamp}`;

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('🚀 INTELLIGENT PORTFOLIO BUILDER');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`Run ID: ${screeningRunId}`);
    console.log(`Strategy: ${strategy.toUpperCase()}`);
    console.log(`Initial Capital: $${config.initialCapital.toLocaleString()}`);
    console.log(`Target Holdings: ${config.targetHoldings}`);
    console.log(`Test Mode: ${config.testMode || false}`);
    console.log('════════════════════════════════════════════════════════════\n');

    // Create screening run record
    // Note: portfolioId is null here because the portfolio doesn't exist yet
    // It will be created in the constructPortfolio step
    await createScreeningRun({
      id: screeningRunId,
      portfolioId: null, // Portfolio doesn't exist yet - will be linked after construction
      runType: 'CONSTRUCTION',
      strategy,
      // Tier results - will be filled in as pipeline progresses
      tier1InputCount: null,
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
      errorMessage: null,
      config: {
        tier1MinScore: config.tier1MinScore,
        tier1MaxCandidates: config.tier1MaxCandidates,
        tier2MaxCandidates: config.tier2MaxFinalists,
        tier3MinConviction: config.tier3MinConviction,
        maxSectorPct: config.maxSectorPct,
        minPositionPct: config.minPositionPct,
        maxPositionPct: config.maxPositionPct,
        targetHoldings: config.targetHoldings,
        cashReservePct: config.cashReservePct,
      },
    });

    return {
      screeningRunId,
      strategy,
      config,
      startTime: Date.now(),
    };
  },
});

// ============================================================================
// STEP 2: RUN TIER 1 SCREENING
// ============================================================================

const runTier1Step = createStep({
  id: 'run-tier1-screening',
  inputSchema: z.object({
    screeningRunId: z.string(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    tier1Output: z.any(),
    tier1Time: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, strategy, config, startTime } = inputData;

    console.log('\n┌────────────────────────────────────────────────────────────┐');
    console.log('│ TIER 1: QUANTITATIVE SCREENING                             │');
    console.log('└────────────────────────────────────────────────────────────┘\n');

    const tier1StartTime = Date.now();

    const tier1Run = await tier1ScreeningWorkflow.createRunAsync();
    const tier1Result = await tier1Run.start({
      inputData: {
        screeningRunId,
        strategy,
        config: {
          minScore: config.tier1MinScore,
          maxCandidates: config.tier1MaxCandidates,
        },
      },
    });

    if (tier1Result.status !== 'success') {
      throw new Error(`Tier 1 failed: ${tier1Result.status}`);
    }

    const tier1Output = tier1Result.result;
    const tier1Time = Math.round((Date.now() - tier1StartTime) / 1000);

    console.log(`\n✓ Tier 1 complete in ${tier1Time}s`);
    console.log(`  Screened: ${(tier1Output as any).totalScreened}`);
    console.log(`  Passed: ${(tier1Output as any).passedCount}`);

    return {
      screeningRunId,
      strategy,
      config,
      startTime,
      tier1Output,
      tier1Time,
    };
  },
});

// ============================================================================
// STEP 3: RUN TIER 2 TRIAGE
// ============================================================================

const runTier2Step = createStep({
  id: 'run-tier2-triage',
  inputSchema: z.object({
    screeningRunId: z.string(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    tier1Output: z.any(),
    tier1Time: z.number(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    tier1Output: z.any(),
    tier1Time: z.number(),
    tier2Output: z.any(),
    tier2Time: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, strategy, config, startTime, tier1Output, tier1Time } = inputData;

    console.log('\n┌────────────────────────────────────────────────────────────┐');
    console.log('│ TIER 2: INTELLIGENT TRIAGE                                 │');
    console.log('└────────────────────────────────────────────────────────────┘\n');

    const tier2StartTime = Date.now();

    // Limit candidates for testing if specified
    let tier2Input = tier1Output;
    if (config.tier2SampleSize && tier1Output.candidates) {
      tier2Input = {
        ...tier1Output,
        candidates: tier1Output.candidates.slice(0, config.tier2SampleSize),
        passedCount: Math.min(tier1Output.passedCount, config.tier2SampleSize),
      };
    }

    const tier2Run = await tier2TriageWorkflow.createRunAsync();
    const tier2Result = await tier2Run.start({
      inputData: {
        ...tier2Input,
        config: {
          maxFinalists: config.tier2MaxFinalists,
          fastTrackMinScore: config.tier2FastTrackMinScore || 70,
        },
      },
    });

    if (tier2Result.status !== 'success') {
      throw new Error(`Tier 2 failed: ${tier2Result.status}`);
    }

    const tier2Output = tier2Result.result;
    const tier2Time = Math.round((Date.now() - tier2StartTime) / 1000);

    console.log(`\n✓ Tier 2 complete in ${tier2Time}s`);
    console.log(`  Finalists: ${(tier2Output as any).finalistCount}`);
    console.log(`  Fast-tracked: ${(tier2Output as any).fastTrackedCount}`);
    console.log(`  Rejected: ${(tier2Output as any).rejectedCount}`);

    return {
      screeningRunId,
      strategy,
      config,
      startTime,
      tier1Output,
      tier1Time,
      tier2Output,
      tier2Time,
    };
  },
});

// ============================================================================
// STEP 4: RUN TIER 3 DEEP ANALYSIS
// ============================================================================

const runTier3Step = createStep({
  id: 'run-tier3-analysis',
  inputSchema: z.object({
    screeningRunId: z.string(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    tier1Output: z.any(),
    tier1Time: z.number(),
    tier2Output: z.any(),
    tier2Time: z.number(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    tier1Output: z.any(),
    tier1Time: z.number(),
    tier2Output: z.any(),
    tier2Time: z.number(),
    tier3Output: z.any(),
    tier3Time: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, strategy, config, startTime, tier1Output, tier1Time, tier2Output, tier2Time } = inputData;

    console.log('\n┌────────────────────────────────────────────────────────────┐');
    console.log('│ TIER 3: DEEP ANALYSIS                                      │');
    console.log('└────────────────────────────────────────────────────────────┘\n');

    const tier3StartTime = Date.now();

    // Limit finalists for testing if specified
    let tier3Input = tier2Output;
    if (config.tier3SampleSize && tier2Output.finalists) {
      tier3Input = {
        ...tier2Output,
        finalists: tier2Output.finalists.slice(0, config.tier3SampleSize),
        finalistCount: Math.min(tier2Output.finalistCount, config.tier3SampleSize),
      };
    }

    const tier3Run = await tier3ResearchWorkflow.createRunAsync();
    const tier3Result = await tier3Run.start({
      inputData: {
        ...tier3Input,
        config: {
          maxHoldings: config.tier3MaxHoldings || config.targetHoldings,
          minConviction: config.tier3MinConviction,
          maxPositionWeight: config.maxPositionPct,
          runDCF: !config.testMode, // Skip DCF in test mode for speed
          runComparables: !config.testMode,
          runSentiment: true,
          runRisk: true,
          runEarnings: !config.testMode,
        },
      },
    });

    if (tier3Result.status !== 'success') {
      throw new Error(`Tier 3 failed: ${tier3Result.status}`);
    }

    const tier3Output = tier3Result.result;
    const tier3Time = Math.round((Date.now() - tier3StartTime) / 1000);

    console.log(`\n✓ Tier 3 complete in ${tier3Time}s`);
    console.log(`  Portfolio candidates: ${(tier3Output as any).portfolioCount}`);
    console.log(`  Average conviction: ${(tier3Output as any).averageConviction}/100`);

    return {
      screeningRunId,
      strategy,
      config,
      startTime,
      tier1Output,
      tier1Time,
      tier2Output,
      tier2Time,
      tier3Output,
      tier3Time,
    };
  },
});

// ============================================================================
// STEP 5: CONSTRUCT FINAL PORTFOLIO
// ============================================================================

const constructPortfolioStep = createStep({
  id: 'construct-portfolio',
  inputSchema: z.object({
    screeningRunId: z.string(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    tier1Output: z.any(),
    tier1Time: z.number(),
    tier2Output: z.any(),
    tier2Time: z.number(),
    tier3Output: z.any(),
    tier3Time: z.number(),
  }),
  outputSchema: pipelineOutputSchema,

  execute: async ({ inputData }) => {
    const {
      screeningRunId,
      strategy,
      config,
      startTime,
      tier1Output,
      tier1Time,
      tier2Output,
      tier2Time,
      tier3Output,
      tier3Time,
    } = inputData;

    console.log('\n┌────────────────────────────────────────────────────────────┐');
    console.log('│ PORTFOLIO CONSTRUCTION                                     │');
    console.log('└────────────────────────────────────────────────────────────┘\n');

    try {
      // Optimize allocation using Tier 3 portfolio results
      const portfolioCandidates = tier3Output.portfolio.map((h: any) => ({
        ticker: h.ticker,
        companyName: h.companyName,
        sector: h.sector,
        currentPrice: h.currentPrice,
        convictionScore: h.convictionScore,
        convictionLevel: h.convictionLevel,
        suggestedWeight: h.suggestedWeight,
        maxWeight: h.maxWeight,
        compositeUpside: h.compositeUpside,
        tier1Score: h.tier1Score,
        bullFactors: h.bullFactors,
        bearFactors: h.bearFactors,
        keyRisks: h.keyRisks,
      }));

      const optimizationResult = await optimizePortfolioAllocationTool.execute({
        context: {
          candidates: portfolioCandidates,
          config: {
            totalCapital: config.initialCapital,
            maxHoldings: config.targetHoldings,
            cashReservePct: config.cashReservePct,
            maxSectorPct: config.maxSectorPct,
            maxPositionPct: config.maxPositionPct,
            minPositionPct: config.minPositionPct,
            minConviction: config.tier3MinConviction,
          },
          strategy,
        },
        runtimeContext: {} as any,
      });

      // Delete existing portfolio if it exists
      const existingPortfolio = await getPortfolio(config.portfolioId);
      if (existingPortfolio) {
        console.log(`Replacing existing portfolio: ${config.portfolioId}`);
        await deletePortfolio(config.portfolioId);
      }

      // Create new portfolio
      const portfolio = await createPortfolio({
        id: config.portfolioId,
        name: config.portfolioName,
        strategy,
        initialCapital: config.initialCapital,
        currentCash: config.initialCapital,
        targetHoldings: config.targetHoldings,
        maxPositionPct: config.maxPositionPct / 100,
        minPositionPct: config.minPositionPct / 100,
        maxSectorPct: config.maxSectorPct / 100,
        maxMonthlyTurnover: 10,
      });

      // Link the screening run to the newly created portfolio
      await updateScreeningRunPortfolio(screeningRunId, portfolio.id);

      // Execute allocations
      let remainingCash = config.initialCapital;
      const holdings: any[] = [];

      for (const allocation of optimizationResult.allocations) {
        if (allocation.shares <= 0) continue;

        const totalCost = allocation.shares * allocation.currentPrice;
        remainingCash -= totalCost;

        // Add holding
        const holding = await addHolding({
          portfolioId: portfolio.id,
          ticker: allocation.ticker,
          shares: allocation.shares,
          avgCost: allocation.currentPrice,
          currentPrice: allocation.currentPrice,
          sector: allocation.sector,
          convictionScore: allocation.convictionScore,
          convictionLevel: allocation.convictionLevel as ConvictionLevel,
          lastAnalysisId: null,
          lastAnalysisDate: new Date().toISOString(),
        });

        // Record transaction
        await recordTransaction({
          portfolioId: portfolio.id,
          ticker: allocation.ticker,
          action: 'BUY',
          shares: allocation.shares,
          price: allocation.currentPrice,
          totalValue: totalCost,
          reason: `IPB Construction - Conviction: ${allocation.convictionLevel} (${allocation.convictionScore}/100)`,
          scoreAtTrade: allocation.convictionScore,
          analysisId: null,
          screeningRunId,
        });

        holdings.push({
          ticker: allocation.ticker,
          companyName: allocation.companyName,
          sector: allocation.sector,
          shares: allocation.shares,
          price: allocation.currentPrice,
          value: totalCost,
          weight: allocation.weight,
          convictionScore: allocation.convictionScore,
          convictionLevel: allocation.convictionLevel,
          compositeUpside: allocation.compositeUpside,
        });
      }

      // Calculate final values
      const holdingsValue = holdings.reduce((sum, h) => sum + h.value, 0);
      const totalValue = holdingsValue + remainingCash;

      // Create initial snapshot
      const holdingsData: HoldingSnapshot[] = holdings.map((h) => ({
        ticker: h.ticker,
        shares: h.shares,
        price: h.price,
        value: h.value,
        weight: h.value / totalValue,
        sector: h.sector || 'Unknown',
        gainPct: 0,
      }));

      await createSnapshot({
        portfolioId: portfolio.id,
        snapshotDate: new Date().toISOString().split('T')[0],
        totalValue,
        cashValue: remainingCash,
        holdingsValue,
        holdingsCount: holdings.length,
        periodReturnPct: 0,
        cumulativeReturnPct: 0,
        spyPeriodReturnPct: 0,
        spyCumulativeReturnPct: 0,
        alphaPct: 0,
        holdingsData,
      });

      // Mark screening run as completed
      await completeScreeningRun(screeningRunId, holdings.length);

      const totalExecutionTime = Math.round((Date.now() - startTime) / 1000);

      // Print final summary
      console.log('\n════════════════════════════════════════════════════════════');
      console.log('✅ INTELLIGENT PORTFOLIO BUILDER COMPLETE');
      console.log('════════════════════════════════════════════════════════════');
      console.log(`\nScreening Run: ${screeningRunId}`);
      console.log(`Portfolio: ${portfolio.id}`);
      console.log(`Strategy: ${strategy.toUpperCase()}`);
      console.log(`\nPIPELINE SUMMARY:`);
      console.log(`  Tier 1: ${tier1Output.totalScreened} → ${tier1Output.passedCount} (${tier1Time}s)`);
      console.log(`  Tier 2: ${tier2Output.finalistCount + tier2Output.rejectedCount} → ${tier2Output.finalistCount} (${tier2Time}s)`);
      console.log(`  Tier 3: ${tier3Output.portfolioCount + tier3Output.rejectedCount} → ${tier3Output.portfolioCount} (${tier3Time}s)`);
      console.log(`  Total Time: ${totalExecutionTime}s`);
      console.log(`\nPORTFOLIO:`);
      console.log(`  Holdings: ${holdings.length}`);
      console.log(`  Value: $${holdingsValue.toLocaleString()}`);
      console.log(`  Cash: $${remainingCash.toLocaleString()}`);
      console.log(`  Avg Conviction: ${optimizationResult.portfolioStats.averageConviction}/100`);
      console.log(`\nHOLDINGS:`);
      holdings.forEach((h, i) => {
        const upside = h.compositeUpside !== null ? `${h.compositeUpside > 0 ? '+' : ''}${h.compositeUpside.toFixed(1)}%` : 'N/A';
        console.log(`  ${i + 1}. ${h.ticker.padEnd(6)} | ${h.weight.toFixed(1)}% | ${h.convictionLevel.padEnd(9)} | Upside: ${upside}`);
      });
      console.log('════════════════════════════════════════════════════════════\n');

      return {
        success: true,
        screeningRunId,
        portfolioId: portfolio.id,
        strategy,
        pipeline: {
          tier1: {
            inputCount: tier1Output.totalScreened,
            outputCount: tier1Output.passedCount,
            executionTimeSeconds: tier1Time,
          },
          tier2: {
            inputCount: tier2Output.finalistCount + tier2Output.rejectedCount,
            outputCount: tier2Output.finalistCount,
            fastTrackedCount: tier2Output.fastTrackedCount,
            executionTimeSeconds: tier2Time,
          },
          tier3: {
            inputCount: tier3Output.portfolioCount + tier3Output.rejectedCount,
            outputCount: tier3Output.portfolioCount,
            executionTimeSeconds: tier3Time,
          },
          totalExecutionTimeSeconds: totalExecutionTime,
        },
        portfolio: {
          holdingsCount: holdings.length,
          totalValue,
          cashValue: remainingCash,
          averageConviction: optimizationResult.portfolioStats.averageConviction,
          averageUpside: optimizationResult.portfolioStats.averageUpside,
          sectorBreakdown: optimizationResult.sectorBreakdown,
        },
        holdings,
        errorMessage: null,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await failScreeningRun(screeningRunId, errorMessage);

      return {
        success: false,
        screeningRunId,
        portfolioId: config.portfolioId,
        strategy,
        pipeline: {
          tier1: {
            inputCount: tier1Output?.totalScreened || 0,
            outputCount: tier1Output?.passedCount || 0,
            executionTimeSeconds: tier1Time || 0,
          },
          tier2: {
            inputCount: tier2Output?.finalistCount + tier2Output?.rejectedCount || 0,
            outputCount: tier2Output?.finalistCount || 0,
            fastTrackedCount: tier2Output?.fastTrackedCount || 0,
            executionTimeSeconds: tier2Time || 0,
          },
          tier3: {
            inputCount: tier3Output?.portfolioCount + tier3Output?.rejectedCount || 0,
            outputCount: tier3Output?.portfolioCount || 0,
            executionTimeSeconds: tier3Time || 0,
          },
          totalExecutionTimeSeconds: Math.round((Date.now() - startTime) / 1000),
        },
        portfolio: {
          holdingsCount: 0,
          totalValue: 0,
          cashValue: 0,
          averageConviction: 0,
          averageUpside: null,
          sectorBreakdown: {},
        },
        holdings: [],
        errorMessage,
      };
    }
  },
});

// ============================================================================
// WORKFLOW DEFINITION
// ============================================================================

export const intelligentPortfolioWorkflow = createWorkflow({
  id: 'intelligent-portfolio-builder',
  inputSchema: pipelineInputSchema,
  outputSchema: pipelineOutputSchema,
})
  .then(initializePipelineStep)
  .then(runTier1Step)
  .then(runTier2Step)
  .then(runTier3Step)
  .then(constructPortfolioStep);

intelligentPortfolioWorkflow.commit();
