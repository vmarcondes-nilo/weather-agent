// ============================================================================
// TIER 2 TRIAGE WORKFLOW
// ============================================================================
// Intelligent triage workflow for the Intelligent Portfolio Builder.
// Evaluates Tier 1 candidates using quick sentiment, risk, and earnings checks
// to decide which stocks pass to Tier 3 deep analysis.
//
// INPUT: Tier 1 candidates with scores
// OUTPUT: ~20-25 finalists + rejection log
// TIME: ~3-5 minutes for 50-80 candidates
//
// DECISIONS:
// - FAST_TRACK: High potential → Priority for Tier 3
// - PASS: No red flags → Proceed to Tier 3
// - REJECT: Major concerns → Remove from consideration
// ============================================================================

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import {
  updateScreeningRunTier2,
  recordTriageDecision,
  updateTier2Results,
} from '../db/analysis-repository';
import { quickTriageCheckTool } from '../tools/triage-tools';
import { Tier1Candidate } from './tier1-screening-workflow';

// ============================================================================
// SCHEMAS
// ============================================================================

const tier2InputSchema = z.object({
  // From Tier 1 output
  screeningRunId: z.string(),
  candidates: z.array(
    z.object({
      ticker: z.string(),
      companyName: z.string(),
      sector: z.string().nullable(),
      tier1Score: z.number(),
      price: z.number(),
      marketCap: z.number(),
      metrics: z.any(),
      componentScores: z.any(),
    })
  ),
  totalScreened: z.number(),
  passedCount: z.number(),
  rejectedCount: z.number(),
  rejectionBreakdown: z.any(),
  executionTimeSeconds: z.number(),
  strategy: z.enum(['value', 'growth', 'balanced']),

  // Tier 2 config
  config: z
    .object({
      maxFinalists: z.number().default(25),
      fastTrackMinScore: z.number().default(70),
      passMinScore: z.number().default(50),
      maxBeta: z.number().default(2.0),
      rejectOnSellConsensus: z.boolean().default(true),
      rejectOnExtremeShortInterest: z.boolean().default(true),
    })
    .optional(),
});

const tier2FinalistSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  sector: z.string().nullable(),
  tier1Score: z.number(),
  price: z.number(),
  marketCap: z.number(),
  metrics: z.any(),
  componentScores: z.any(),

  // Triage results
  triageDecision: z.enum(['PASS', 'FAST_TRACK']),
  triageReasoning: z.string(),
  redFlags: z.array(z.string()),
  greenFlags: z.array(z.string()),

  // Quick check data
  analystConsensus: z.string().nullable(),
  targetUpside: z.number().nullable(),
  shortRisk: z.string().nullable(),
  earningsSentiment: z.string().nullable(),
  beta: z.number().nullable(),
});

export type Tier2Finalist = z.infer<typeof tier2FinalistSchema>;

const tier2RejectedSchema = z.object({
  ticker: z.string(),
  tier1Score: z.number(),
  decision: z.literal('REJECT'),
  reason: z.string(),
  redFlags: z.array(z.string()),
});

export type Tier2Rejected = z.infer<typeof tier2RejectedSchema>;

const tier2OutputSchema = z.object({
  screeningRunId: z.string(),
  finalists: z.array(tier2FinalistSchema),
  rejected: z.array(tier2RejectedSchema),
  finalistCount: z.number(),
  rejectedCount: z.number(),
  fastTrackedCount: z.number(),
  executionTimeSeconds: z.number(),
  strategy: z.enum(['value', 'growth', 'balanced']),
});

export type Tier2Output = z.infer<typeof tier2OutputSchema>;

// ============================================================================
// STEP 1: INITIALIZE TRIAGE
// ============================================================================

// Config schema used across steps
const stepConfigSchema = z.object({
  maxFinalists: z.number(),
  fastTrackMinScore: z.number(),
  passMinScore: z.number(),
  maxBeta: z.number(),
  rejectOnSellConsensus: z.boolean(),
  rejectOnExtremeShortInterest: z.boolean(),
});

const initializeTriageStep = createStep({
  id: 'initialize-triage',
  inputSchema: tier2InputSchema,
  outputSchema: z.object({
    screeningRunId: z.string(),
    candidates: z.array(z.any()),
    config: stepConfigSchema,
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),

  execute: async ({ inputData }) => {
    const config = {
      maxFinalists: inputData.config?.maxFinalists ?? 25,
      fastTrackMinScore: inputData.config?.fastTrackMinScore ?? 70,
      passMinScore: inputData.config?.passMinScore ?? 50,
      maxBeta: inputData.config?.maxBeta ?? 2.0,
      rejectOnSellConsensus: inputData.config?.rejectOnSellConsensus ?? true,
      rejectOnExtremeShortInterest: inputData.config?.rejectOnExtremeShortInterest ?? true,
    };

    console.log('\n============================================================');
    console.log('TIER 2 TRIAGE INITIALIZED');
    console.log('============================================================');
    console.log(`Run ID: ${inputData.screeningRunId}`);
    console.log(`Candidates to triage: ${inputData.candidates.length}`);
    console.log(`Max finalists: ${config.maxFinalists}`);
    console.log(`Fast-track threshold: ${config.fastTrackMinScore}`);
    console.log('============================================================\n');

    return {
      screeningRunId: inputData.screeningRunId,
      candidates: inputData.candidates,
      config,
      strategy: inputData.strategy,
      startTime: Date.now(),
    };
  },
});

// ============================================================================
// STEP 2: RUN TRIAGE CHECKS
// ============================================================================

const runTriageChecksStep = createStep({
  id: 'run-triage-checks',
  inputSchema: z.object({
    screeningRunId: z.string(),
    candidates: z.array(z.any()),
    config: stepConfigSchema,
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    triageResults: z.array(z.any()),
    config: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, candidates, config, strategy, startTime } = inputData;

    console.log(`\nRunning triage checks on ${candidates.length} candidates...`);
    console.log('This may take 2-3 minutes...\n');

    const triageResults: { ticker: string; candidate: Tier1Candidate; triageCheck: any }[] = [];

    // Process in batches of 5 to avoid rate limiting
    const batchSize = 5;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (candidate: Tier1Candidate) => {
          try {
            const triageCheck = await quickTriageCheckTool.execute({
              context: {
                ticker: candidate.ticker,
                tier1Score: candidate.tier1Score,
                sector: candidate.sector,
              },
              runtimeContext: {} as any,
            });

            return {
              ticker: candidate.ticker,
              candidate,
              triageCheck,
            };
          } catch (error) {
            console.warn(`  Failed to triage ${candidate.ticker}: ${error}`);
            // Return a minimal result for failed checks
            return {
              ticker: candidate.ticker,
              candidate,
              triageCheck: {
                ticker: candidate.ticker,
                companyName: candidate.companyName,
                sector: candidate.sector,
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
                redFlags: ['Data fetch error'],
                greenFlags: [],
                recommendation: 'NEEDS_REVIEW',
                reasoning: 'Unable to complete triage checks due to data error',
              },
            };
          }
        })
      );

      triageResults.push(...batchResults);

      // Progress update
      const completed = Math.min(i + batchSize, candidates.length);
      process.stdout.write(`\rProgress: ${completed}/${candidates.length} (${Math.round((completed / candidates.length) * 100)}%)`);

      // Small delay between batches
      if (i + batchSize < candidates.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log('\n\nTriage checks complete!');

    return {
      screeningRunId,
      triageResults,
      config,
      strategy,
      startTime,
    };
  },
});

// ============================================================================
// STEP 3: MAKE DECISIONS
// ============================================================================

const makeDecisionsStep = createStep({
  id: 'make-decisions',
  inputSchema: z.object({
    screeningRunId: z.string(),
    triageResults: z.array(z.any()),
    config: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    finalists: z.array(tier2FinalistSchema),
    rejected: z.array(tier2RejectedSchema),
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, triageResults, config, strategy, startTime } = inputData;

    console.log('\nMaking triage decisions...');

    const finalists: Tier2Finalist[] = [];
    const rejected: Tier2Rejected[] = [];

    for (const result of triageResults) {
      const { candidate, triageCheck } = result;
      const recommendation = triageCheck.recommendation;

      if (recommendation === 'FAST_TRACK' || recommendation === 'PASS') {
        finalists.push({
          ticker: candidate.ticker,
          companyName: candidate.companyName,
          sector: candidate.sector,
          tier1Score: candidate.tier1Score,
          price: candidate.price,
          marketCap: candidate.marketCap,
          metrics: candidate.metrics,
          componentScores: candidate.componentScores,
          triageDecision: recommendation as 'PASS' | 'FAST_TRACK',
          triageReasoning: triageCheck.reasoning,
          redFlags: triageCheck.redFlags,
          greenFlags: triageCheck.greenFlags,
          analystConsensus: triageCheck.analystConsensus,
          targetUpside: triageCheck.targetUpside,
          shortRisk: triageCheck.shortRisk,
          earningsSentiment: triageCheck.earningsSentiment,
          beta: triageCheck.beta,
        });
      } else {
        rejected.push({
          ticker: candidate.ticker,
          tier1Score: candidate.tier1Score,
          decision: 'REJECT',
          reason: triageCheck.reasoning,
          redFlags: triageCheck.redFlags,
        });
      }
    }

    // Sort finalists: FAST_TRACK first, then by tier1Score
    finalists.sort((a, b) => {
      if (a.triageDecision === 'FAST_TRACK' && b.triageDecision !== 'FAST_TRACK') return -1;
      if (b.triageDecision === 'FAST_TRACK' && a.triageDecision !== 'FAST_TRACK') return 1;
      return b.tier1Score - a.tier1Score;
    });

    // Limit to maxFinalists
    const limitedFinalists = finalists.slice(0, config.maxFinalists);
    const overflowRejected = finalists.slice(config.maxFinalists).map((f) => ({
      ticker: f.ticker,
      tier1Score: f.tier1Score,
      decision: 'REJECT' as const,
      reason: `Exceeded max finalists limit (${config.maxFinalists})`,
      redFlags: [],
    }));

    rejected.push(...overflowRejected);

    const fastTrackedCount = limitedFinalists.filter((f) => f.triageDecision === 'FAST_TRACK').length;

    console.log(`\nDecisions complete:`);
    console.log(`- Finalists: ${limitedFinalists.length}`);
    console.log(`  - Fast-tracked: ${fastTrackedCount}`);
    console.log(`  - Passed: ${limitedFinalists.length - fastTrackedCount}`);
    console.log(`- Rejected: ${rejected.length}`);

    return {
      screeningRunId,
      finalists: limitedFinalists,
      rejected,
      strategy,
      startTime,
    };
  },
});

// ============================================================================
// STEP 4: PERSIST RESULTS
// ============================================================================

const persistTier2ResultsStep = createStep({
  id: 'persist-tier2-results',
  inputSchema: z.object({
    screeningRunId: z.string(),
    finalists: z.array(tier2FinalistSchema),
    rejected: z.array(tier2RejectedSchema),
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),
  outputSchema: tier2OutputSchema,

  execute: async ({ inputData }) => {
    const { screeningRunId, finalists, rejected, strategy, startTime } = inputData;

    console.log('\nPersisting Tier 2 results to database...');

    // Record triage decisions for transparency
    for (const finalist of finalists) {
      try {
        await recordTriageDecision({
          screeningRunId,
          ticker: finalist.ticker,
          tier: 2,
          decision: finalist.triageDecision,
          reasoning: finalist.triageReasoning,
          additionalChecksRequested: null,
          additionalChecksResults: null,
          finalDecision: null,
        });

        // Update stock analysis with tier 2 results
        await updateTier2Results(
          screeningRunId,
          finalist.ticker,
          true, // tier2Passed
          finalist.triageDecision,
          null, // tier2RejectionReason
          {
            analystConsensus: finalist.analystConsensus,
            targetUpside: finalist.targetUpside,
            shortRisk: finalist.shortRisk,
            earningsSentiment: finalist.earningsSentiment,
            beta: finalist.beta,
            redFlags: finalist.redFlags,
            greenFlags: finalist.greenFlags,
          }
        );
      } catch (error) {
        console.warn(`  Failed to persist decision for ${finalist.ticker}: ${error}`);
      }
    }

    for (const reject of rejected) {
      try {
        await recordTriageDecision({
          screeningRunId,
          ticker: reject.ticker,
          tier: 2,
          decision: 'REJECT',
          reasoning: reject.reason,
          additionalChecksRequested: null,
          additionalChecksResults: null,
          finalDecision: null,
        });

        await updateTier2Results(
          screeningRunId,
          reject.ticker,
          false, // tier2Passed
          'REJECT',
          reject.reason, // tier2RejectionReason
          null // tier2QuickChecks
        );
      } catch (error) {
        // Stock might not exist if it wasn't in Tier 1
        console.warn(`  Failed to persist rejection for ${reject.ticker}: ${error}`);
      }
    }

    // Update screening run with Tier 2 summary
    await updateScreeningRunTier2(
      screeningRunId,
      finalists.length + rejected.length, // inputCount
      finalists.length, // outputCount
      rejected.length // rejectedCount
    );

    const executionTimeSeconds = Math.round((Date.now() - startTime) / 1000);
    const fastTrackedCount = finalists.filter((f) => f.triageDecision === 'FAST_TRACK').length;

    console.log('\n============================================================');
    console.log('TIER 2 TRIAGE COMPLETE');
    console.log('============================================================');
    console.log(`Run ID: ${screeningRunId}`);
    console.log(`Total Triaged: ${finalists.length + rejected.length}`);
    console.log(`Finalists: ${finalists.length}`);
    console.log(`  - Fast-tracked: ${fastTrackedCount}`);
    console.log(`  - Passed: ${finalists.length - fastTrackedCount}`);
    console.log(`Rejected: ${rejected.length}`);
    console.log(`Execution Time: ${executionTimeSeconds}s`);
    console.log('\nTop 10 Finalists:');
    finalists.slice(0, 10).forEach((f, i) => {
      const decision = f.triageDecision === 'FAST_TRACK' ? '⚡' : '✓';
      console.log(`  ${i + 1}. ${f.ticker.padEnd(6)} | Score: ${f.tier1Score} | ${decision} ${f.triageDecision}`);
    });
    console.log('============================================================\n');

    return {
      screeningRunId,
      finalists,
      rejected,
      finalistCount: finalists.length,
      rejectedCount: rejected.length,
      fastTrackedCount,
      executionTimeSeconds,
      strategy,
    };
  },
});

// ============================================================================
// WORKFLOW DEFINITION
// ============================================================================

export const tier2TriageWorkflow = createWorkflow({
  id: 'tier2-triage',
  inputSchema: tier2InputSchema,
  outputSchema: tier2OutputSchema,
})
  .then(initializeTriageStep)
  .then(runTriageChecksStep)
  .then(makeDecisionsStep)
  .then(persistTier2ResultsStep);

tier2TriageWorkflow.commit();
