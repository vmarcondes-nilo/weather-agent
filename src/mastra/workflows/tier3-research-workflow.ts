// ============================================================================
// TIER 3 DEEP RESEARCH WORKFLOW
// ============================================================================
// Final stage of the Intelligent Portfolio Builder funnel.
// Performs comprehensive deep analysis on Tier 2 finalists to produce:
// - Final conviction scores
// - Position sizing recommendations
// - Portfolio-ready stock selections (10-12 holdings)
//
// INPUT: ~20-25 finalists from Tier 2 triage
// OUTPUT: 10-12 portfolio holdings with weights
// TIME: ~10-15 minutes for full analysis
//
// ANALYSIS PERFORMED:
// - DCF Valuation (intrinsic value)
// - Comparable Analysis (peer valuation)
// - Sentiment Analysis (market perception)
// - Risk Assessment (comprehensive risk)
// - Earnings Analysis (quality/consistency)
// ============================================================================

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import {
  updateScreeningRunTier3,
  updateTier3Results,
  completeScreeningRun,
} from '../db/analysis-repository';
import {
  calculateConvictionScoreTool,
  parseIntrinsicValueFromText,
  parseComparableImpliedValueFromText,
  parseRiskScoreFromText,
} from '../tools/conviction-tools';

// Import specialist workflows for deep analysis
import { dcfValuationWorkflow } from './dcf-workflow';
import { comparableAnalysisWorkflow } from './comparable-workflow';
import { sentimentAnalysisWorkflow } from './sentiment-workflow';
import { riskAssessmentWorkflow } from './risk-workflow';
import { earningsEventWorkflow } from './earnings-workflow';

import { Tier2Finalist } from './tier2-triage-workflow';

// ============================================================================
// SECTOR TO PEERS MAPPING
// ============================================================================

const SECTOR_PEERS: Record<string, string[]> = {
  Technology: ['AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA', 'AVGO', 'CRM'],
  'Financial Services': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK'],
  Healthcare: ['JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'LLY', 'TMO'],
  'Consumer Cyclical': ['AMZN', 'TSLA', 'HD', 'NKE', 'MCD', 'SBUX', 'TJX'],
  'Consumer Defensive': ['PG', 'KO', 'PEP', 'WMT', 'COST', 'PM', 'CL'],
  'Communication Services': ['GOOGL', 'META', 'NFLX', 'DIS', 'CMCSA', 'T', 'VZ'],
  Industrials: ['CAT', 'DE', 'UNP', 'HON', 'GE', 'BA', 'LMT'],
  Energy: ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC'],
  Utilities: ['NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE'],
  'Real Estate': ['PLD', 'AMT', 'EQIX', 'SPG', 'O', 'WELL', 'PSA'],
  'Basic Materials': ['LIN', 'APD', 'SHW', 'ECL', 'NEM', 'FCX', 'DD'],
};

const DEFAULT_PEERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA'];

// ============================================================================
// SCHEMAS
// ============================================================================

const tier3InputSchema = z.object({
  // From Tier 2 output
  screeningRunId: z.string(),
  finalists: z.array(
    z.object({
      ticker: z.string(),
      companyName: z.string(),
      sector: z.string().nullable(),
      tier1Score: z.number(),
      price: z.number(),
      marketCap: z.number(),
      metrics: z.any(),
      componentScores: z.any(),
      triageDecision: z.enum(['PASS', 'FAST_TRACK']),
      triageReasoning: z.string(),
      redFlags: z.array(z.string()),
      greenFlags: z.array(z.string()),
      analystConsensus: z.string().nullable(),
      targetUpside: z.number().nullable(),
      shortRisk: z.string().nullable(),
      earningsSentiment: z.string().nullable(),
      beta: z.number().nullable(),
    })
  ),
  finalistCount: z.number(),
  rejectedCount: z.number(),
  fastTrackedCount: z.number(),
  executionTimeSeconds: z.number(),
  strategy: z.enum(['value', 'growth', 'balanced']),

  // Tier 3 config
  config: z
    .object({
      maxHoldings: z.number().default(12),
      minConviction: z.number().default(50),
      maxPositionWeight: z.number().default(10),
      runDCF: z.boolean().default(true),
      runComparables: z.boolean().default(true),
      runSentiment: z.boolean().default(true),
      runRisk: z.boolean().default(true),
      runEarnings: z.boolean().default(true),
    })
    .optional(),
});

const portfolioHoldingSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  sector: z.string().nullable(),
  currentPrice: z.number(),

  // Scores
  tier1Score: z.number(),
  tier2Decision: z.enum(['PASS', 'FAST_TRACK']),
  convictionScore: z.number(),
  convictionLevel: z.enum(['VERY_HIGH', 'HIGH', 'MODERATE', 'LOW', 'VERY_LOW']),

  // Position
  suggestedWeight: z.number(),
  maxWeight: z.number(),

  // Analysis summaries
  valuationSummary: z.string().nullable(),
  riskSummary: z.string().nullable(),

  // Upside
  dcfUpside: z.number().nullable(),
  peerUpside: z.number().nullable(),
  compositeUpside: z.number().nullable(),

  // Factors
  bullFactors: z.array(z.string()),
  bearFactors: z.array(z.string()),
  keyRisks: z.array(z.string()),
});

export type PortfolioHolding = z.infer<typeof portfolioHoldingSchema>;

const tier3OutputSchema = z.object({
  screeningRunId: z.string(),
  strategy: z.enum(['value', 'growth', 'balanced']),

  // Portfolio
  portfolio: z.array(portfolioHoldingSchema),
  portfolioCount: z.number(),
  totalWeight: z.number(),

  // Rejected from Tier 3
  rejected: z.array(
    z.object({
      ticker: z.string(),
      reason: z.string(),
      convictionScore: z.number().nullable(),
    })
  ),
  rejectedCount: z.number(),

  // Statistics
  averageConviction: z.number(),
  averageUpside: z.number().nullable(),

  executionTimeSeconds: z.number(),
});

export type Tier3Output = z.infer<typeof tier3OutputSchema>;

// ============================================================================
// STEP 1: INITIALIZE DEEP RESEARCH
// ============================================================================

const stepConfigSchema = z.object({
  maxHoldings: z.number(),
  minConviction: z.number(),
  maxPositionWeight: z.number(),
  runDCF: z.boolean(),
  runComparables: z.boolean(),
  runSentiment: z.boolean(),
  runRisk: z.boolean(),
  runEarnings: z.boolean(),
});

const initializeResearchStep = createStep({
  id: 'initialize-research',
  inputSchema: tier3InputSchema,
  outputSchema: z.object({
    screeningRunId: z.string(),
    finalists: z.array(z.any()),
    config: stepConfigSchema,
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),

  execute: async ({ inputData }) => {
    const config = {
      maxHoldings: inputData.config?.maxHoldings ?? 12,
      minConviction: inputData.config?.minConviction ?? 50,
      maxPositionWeight: inputData.config?.maxPositionWeight ?? 10,
      runDCF: inputData.config?.runDCF ?? true,
      runComparables: inputData.config?.runComparables ?? true,
      runSentiment: inputData.config?.runSentiment ?? true,
      runRisk: inputData.config?.runRisk ?? true,
      runEarnings: inputData.config?.runEarnings ?? true,
    };

    console.log('\n============================================================');
    console.log('TIER 3 DEEP RESEARCH INITIALIZED');
    console.log('============================================================');
    console.log(`Run ID: ${inputData.screeningRunId}`);
    console.log(`Finalists to analyze: ${inputData.finalists.length}`);
    console.log(`Fast-tracked: ${inputData.fastTrackedCount}`);
    console.log(`Max holdings: ${config.maxHoldings}`);
    console.log(`Min conviction: ${config.minConviction}`);
    console.log('Workflows enabled:');
    console.log(`  - DCF Valuation: ${config.runDCF}`);
    console.log(`  - Comparable Analysis: ${config.runComparables}`);
    console.log(`  - Sentiment Analysis: ${config.runSentiment}`);
    console.log(`  - Risk Assessment: ${config.runRisk}`);
    console.log(`  - Earnings Analysis: ${config.runEarnings}`);
    console.log('============================================================\n');

    return {
      screeningRunId: inputData.screeningRunId,
      finalists: inputData.finalists,
      config,
      strategy: inputData.strategy,
      startTime: Date.now(),
    };
  },
});

// ============================================================================
// STEP 2: RUN DEEP ANALYSIS WORKFLOWS
// ============================================================================

interface DeepAnalysisResult {
  ticker: string;
  finalist: Tier2Finalist;
  dcfValuation: string | null;
  comparableAnalysis: string | null;
  sentimentAnalysis: string | null;
  riskAssessment: string | null;
  earningsAnalysis: string | null;
  errors: string[];
}

const runDeepAnalysisStep = createStep({
  id: 'run-deep-analysis',
  inputSchema: z.object({
    screeningRunId: z.string(),
    finalists: z.array(z.any()),
    config: stepConfigSchema,
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    analysisResults: z.array(z.any()),
    config: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, finalists, config, strategy, startTime } = inputData;

    console.log(`\nRunning deep analysis on ${finalists.length} finalists...`);
    console.log('This may take 10-15 minutes...\n');

    const analysisResults: DeepAnalysisResult[] = [];

    // Process stocks sequentially to manage API rate limits
    // (each stock runs its workflows in parallel)
    for (let i = 0; i < finalists.length; i++) {
      const finalist = finalists[i] as Tier2Finalist;
      const ticker = finalist.ticker;

      console.log(`\n[${i + 1}/${finalists.length}] Analyzing ${ticker}...`);

      const result: DeepAnalysisResult = {
        ticker,
        finalist,
        dcfValuation: null,
        comparableAnalysis: null,
        sentimentAnalysis: null,
        riskAssessment: null,
        earningsAnalysis: null,
        errors: [],
      };

      // Get peers for comparable analysis
      const sector = finalist.sector || '';
      let peers = SECTOR_PEERS[sector] || DEFAULT_PEERS;
      peers = peers.filter((p) => p.toUpperCase() !== ticker.toUpperCase()).slice(0, 4);

      // Run enabled workflows in parallel
      const workflowPromises: Promise<void>[] = [];

      // DCF Valuation
      if (config.runDCF) {
        workflowPromises.push(
          (async () => {
            try {
              const run = await dcfValuationWorkflow.createRunAsync();
              const workflowResult = await run.start({ inputData: { ticker } });
              if (workflowResult.status === 'success' && workflowResult.result) {
                result.dcfValuation = (workflowResult.result as { valuation: string }).valuation;
              }
            } catch (error) {
              result.errors.push(`DCF: ${error instanceof Error ? error.message : 'Unknown'}`);
            }
          })()
        );
      }

      // Comparable Analysis
      if (config.runComparables) {
        workflowPromises.push(
          (async () => {
            try {
              const run = await comparableAnalysisWorkflow.createRunAsync();
              const workflowResult = await run.start({ inputData: { ticker, peers } });
              if (workflowResult.status === 'success' && workflowResult.result) {
                result.comparableAnalysis = (workflowResult.result as { analysis: string }).analysis;
              }
            } catch (error) {
              result.errors.push(`Comparable: ${error instanceof Error ? error.message : 'Unknown'}`);
            }
          })()
        );
      }

      // Sentiment Analysis
      if (config.runSentiment) {
        workflowPromises.push(
          (async () => {
            try {
              const run = await sentimentAnalysisWorkflow.createRunAsync();
              const workflowResult = await run.start({ inputData: { ticker } });
              if (workflowResult.status === 'success' && workflowResult.result) {
                result.sentimentAnalysis = (workflowResult.result as { analysis: string }).analysis;
              }
            } catch (error) {
              result.errors.push(`Sentiment: ${error instanceof Error ? error.message : 'Unknown'}`);
            }
          })()
        );
      }

      // Risk Assessment
      if (config.runRisk) {
        workflowPromises.push(
          (async () => {
            try {
              const run = await riskAssessmentWorkflow.createRunAsync();
              const workflowResult = await run.start({ inputData: { ticker } });
              if (workflowResult.status === 'success' && workflowResult.result) {
                result.riskAssessment = (workflowResult.result as { riskAssessment: string }).riskAssessment;
              }
            } catch (error) {
              result.errors.push(`Risk: ${error instanceof Error ? error.message : 'Unknown'}`);
            }
          })()
        );
      }

      // Earnings Analysis
      if (config.runEarnings) {
        workflowPromises.push(
          (async () => {
            try {
              const run = await earningsEventWorkflow.createRunAsync();
              const workflowResult = await run.start({ inputData: { ticker } });
              if (workflowResult.status === 'success' && workflowResult.result) {
                result.earningsAnalysis = (workflowResult.result as { earningsAnalysis: string }).earningsAnalysis;
              }
            } catch (error) {
              result.errors.push(`Earnings: ${error instanceof Error ? error.message : 'Unknown'}`);
            }
          })()
        );
      }

      // Wait for all workflows to complete
      await Promise.all(workflowPromises);

      // Log progress
      const completedWorkflows =
        [result.dcfValuation, result.comparableAnalysis, result.sentimentAnalysis, result.riskAssessment, result.earningsAnalysis].filter(
          Boolean
        ).length;
      console.log(`  Completed ${completedWorkflows}/5 workflows for ${ticker}`);
      if (result.errors.length > 0) {
        console.log(`  Errors: ${result.errors.join(', ')}`);
      }

      analysisResults.push(result);

      // Small delay between stocks to avoid rate limiting
      if (i < finalists.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log('\n\nDeep analysis complete!');

    return {
      screeningRunId,
      analysisResults,
      config,
      strategy,
      startTime,
    };
  },
});

// ============================================================================
// STEP 3: CALCULATE CONVICTION SCORES
// ============================================================================

const calculateConvictionStep = createStep({
  id: 'calculate-conviction',
  inputSchema: z.object({
    screeningRunId: z.string(),
    analysisResults: z.array(z.any()),
    config: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    scoredCandidates: z.array(z.any()),
    config: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, analysisResults, config, strategy, startTime } = inputData;

    console.log('\nCalculating conviction scores...');

    const scoredCandidates: {
      analysisResult: DeepAnalysisResult;
      convictionResult: Awaited<ReturnType<typeof calculateConvictionScoreTool.execute>>;
    }[] = [];

    for (const analysisResult of analysisResults as DeepAnalysisResult[]) {
      const { ticker, finalist, dcfValuation, comparableAnalysis, sentimentAnalysis, riskAssessment, earningsAnalysis } = analysisResult;

      try {
        const convictionResult = await calculateConvictionScoreTool.execute({
          context: {
            ticker,
            companyName: finalist.companyName,
            sector: finalist.sector,
            currentPrice: finalist.price,
            tier1Score: finalist.tier1Score,
            tier2Decision: finalist.triageDecision,
            dcfValuation,
            comparableAnalysis,
            sentimentAnalysis,
            riskAssessment,
            earningsAnalysis,
            strategy,
            dcfUpside: null,
            peerUpside: null,
            riskScore: null,
          },
          runtimeContext: {} as any,
        });

        scoredCandidates.push({
          analysisResult,
          convictionResult,
        });

        const level = convictionResult.convictionLevel;
        const score = convictionResult.convictionScore;
        console.log(`  ${ticker}: ${level} (${score}/100)`);
      } catch (error) {
        console.warn(`  Failed to score ${ticker}: ${error}`);
        // Create a minimal result for failed scoring
        scoredCandidates.push({
          analysisResult,
          convictionResult: {
            ticker,
            companyName: finalist.companyName,
            sector: finalist.sector,
            currentPrice: finalist.price,
            valuationScore: 50,
            sentimentScore: 50,
            riskScore: 50,
            earningsScore: 50,
            qualityScore: finalist.tier1Score,
            dcfUpside: null,
            peerUpside: null,
            compositeUpside: null,
            convictionScore: finalist.tier1Score, // Fall back to tier1 score
            convictionLevel: 'MODERATE' as const,
            convictionReasoning: 'Conviction scoring failed; using Tier 1 score as fallback',
            suggestedWeight: 4,
            maxWeight: 6,
            bullFactors: [],
            bearFactors: ['Analysis incomplete'],
            keyRisks: ['Data quality issues'],
          },
        });
      }
    }

    // Sort by conviction score descending
    scoredCandidates.sort((a, b) => b.convictionResult.convictionScore - a.convictionResult.convictionScore);

    return {
      screeningRunId,
      scoredCandidates,
      config,
      strategy,
      startTime,
    };
  },
});

// ============================================================================
// STEP 4: BUILD PORTFOLIO & PERSIST
// ============================================================================

const buildPortfolioStep = createStep({
  id: 'build-portfolio',
  inputSchema: z.object({
    screeningRunId: z.string(),
    scoredCandidates: z.array(z.any()),
    config: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    startTime: z.number(),
  }),
  outputSchema: tier3OutputSchema,

  execute: async ({ inputData }) => {
    const { screeningRunId, scoredCandidates, config, strategy, startTime } = inputData;

    console.log('\nBuilding final portfolio...');

    const portfolio: PortfolioHolding[] = [];
    const rejected: { ticker: string; reason: string; convictionScore: number | null }[] = [];

    // Select top candidates up to maxHoldings
    for (const { analysisResult, convictionResult } of scoredCandidates) {
      const { finalist, dcfValuation, riskAssessment } = analysisResult as DeepAnalysisResult;

      // Check if meets minimum conviction
      if (convictionResult.convictionScore < config.minConviction) {
        rejected.push({
          ticker: convictionResult.ticker,
          reason: `Below minimum conviction (${convictionResult.convictionScore} < ${config.minConviction})`,
          convictionScore: convictionResult.convictionScore,
        });
        continue;
      }

      // Check if portfolio is full
      if (portfolio.length >= config.maxHoldings) {
        rejected.push({
          ticker: convictionResult.ticker,
          reason: `Portfolio full (${config.maxHoldings} holdings)`,
          convictionScore: convictionResult.convictionScore,
        });
        continue;
      }

      // Add to portfolio
      portfolio.push({
        ticker: convictionResult.ticker,
        companyName: convictionResult.companyName,
        sector: convictionResult.sector,
        currentPrice: convictionResult.currentPrice,
        tier1Score: finalist.tier1Score,
        tier2Decision: finalist.triageDecision,
        convictionScore: convictionResult.convictionScore,
        convictionLevel: convictionResult.convictionLevel,
        suggestedWeight: convictionResult.suggestedWeight,
        maxWeight: convictionResult.maxWeight,
        valuationSummary: dcfValuation ? dcfValuation.substring(0, 500) + '...' : null,
        riskSummary: riskAssessment ? riskAssessment.substring(0, 500) + '...' : null,
        dcfUpside: convictionResult.dcfUpside,
        peerUpside: convictionResult.peerUpside,
        compositeUpside: convictionResult.compositeUpside,
        bullFactors: convictionResult.bullFactors,
        bearFactors: convictionResult.bearFactors,
        keyRisks: convictionResult.keyRisks,
      });
    }

    // Normalize weights to sum to 100%
    const totalSuggestedWeight = portfolio.reduce((sum, h) => sum + h.suggestedWeight, 0);
    if (totalSuggestedWeight > 0 && totalSuggestedWeight !== 100) {
      const scaleFactor = 100 / totalSuggestedWeight;
      for (const holding of portfolio) {
        holding.suggestedWeight = Math.round(holding.suggestedWeight * scaleFactor * 10) / 10;
        // Ensure doesn't exceed max
        holding.suggestedWeight = Math.min(holding.suggestedWeight, holding.maxWeight);
      }
    }

    const totalWeight = portfolio.reduce((sum, h) => sum + h.suggestedWeight, 0);

    // Calculate statistics
    const averageConviction =
      portfolio.length > 0 ? Math.round(portfolio.reduce((sum, h) => sum + h.convictionScore, 0) / portfolio.length) : 0;

    const upsides = portfolio.filter((h) => h.compositeUpside !== null).map((h) => h.compositeUpside as number);
    const averageUpside = upsides.length > 0 ? Math.round(upsides.reduce((sum, u) => sum + u, 0) / upsides.length * 10) / 10 : null;

    // Persist results - include full analysis data from scoredCandidates
    console.log('\nPersisting Tier 3 results to database...');

    // Create a map of portfolio tickers for quick lookup
    const portfolioTickers = new Set(portfolio.map((h) => h.ticker));

    // Persist ALL scored candidates (both selected and rejected) with full analysis data
    for (const { analysisResult, convictionResult } of scoredCandidates) {
      const { ticker, dcfValuation, comparableAnalysis, sentimentAnalysis, riskAssessment, earningsAnalysis } =
        analysisResult as DeepAnalysisResult;

      const isInPortfolio = portfolioTickers.has(ticker);
      const holding = portfolio.find((h) => h.ticker === ticker);
      const rejection = rejected.find((r) => r.ticker === ticker);

      try {
        // Determine earnings sentiment from conviction scoring
        let earningsSentiment: 'beat' | 'inline' | 'miss' | null = null;
        if (convictionResult.earningsScore >= 65) {
          earningsSentiment = 'beat';
        } else if (convictionResult.earningsScore >= 45) {
          earningsSentiment = 'inline';
        } else if (convictionResult.earningsScore < 45) {
          earningsSentiment = 'miss';
        }

        // Parse numeric values from analysis text
        const dcfIntrinsicValue = dcfValuation ? parseIntrinsicValueFromText(dcfValuation) : null;
        const comparableImpliedValue = comparableAnalysis ? parseComparableImpliedValueFromText(comparableAnalysis) : null;
        const rawRiskScore = riskAssessment ? parseRiskScoreFromText(riskAssessment) : null;

        await updateTier3Results(screeningRunId, ticker, {
          // Full analysis text from deep analysis workflows
          dcfAnalysis: dcfValuation ?? undefined,
          comparableAnalysis: comparableAnalysis ?? undefined,
          sentimentAnalysis: sentimentAnalysis ?? undefined,
          riskAnalysis: riskAssessment ?? undefined,
          earningsAnalysis: earningsAnalysis ?? undefined,

          // Numeric extracted values from analysis text and conviction scoring
          dcfIntrinsicValue: dcfIntrinsicValue ?? undefined,
          comparableImpliedValue: comparableImpliedValue ?? undefined,
          sentimentScore: convictionResult.sentimentScore ?? undefined,
          riskScore: rawRiskScore ?? undefined,  // Use the raw 1-10 score from risk assessment
          earningsSentiment: earningsSentiment ?? undefined,

          // Conviction scoring
          convictionScore: convictionResult.convictionScore,
          convictionLevel: convictionResult.convictionLevel,
          dcfUpsidePct: convictionResult.dcfUpside ?? undefined,

          // Research summary based on selection status
          researchSummary: isInPortfolio
            ? `Selected for portfolio with ${convictionResult.convictionLevel} conviction (${convictionResult.convictionScore}/100)`
            : rejection?.reason ?? 'Not selected',

          // Investment thesis from bull/bear factors
          investmentThesis: isInPortfolio
            ? `Bull: ${convictionResult.bullFactors.slice(0, 3).join('; ')}. Bear: ${convictionResult.bearFactors.slice(0, 2).join('; ')}`
            : undefined,

          // Conviction breakdown - use actual component scores from conviction calculation
          convictionBreakdown: {
            valuationScore: convictionResult.valuationScore ?? 0,
            sentimentScore: convictionResult.sentimentScore ?? 0,
            riskScore: convictionResult.riskScore ?? 0,
            earningsScore: convictionResult.earningsScore ?? 0,
            qualityScore: convictionResult.qualityScore ?? 0,
            weights: { valuation: 0.25, sentiment: 0.15, risk: 0.2, earnings: 0.2, quality: 0.2 },
          },

          // Metadata
          workflowsRun: [
            dcfValuation ? 'dcf' : null,
            comparableAnalysis ? 'comparable' : null,
            sentimentAnalysis ? 'sentiment' : null,
            riskAssessment ? 'risk' : null,
            earningsAnalysis ? 'earnings' : null,
          ].filter(Boolean) as string[],
        });

        console.log(`  ✓ Persisted ${ticker} (${isInPortfolio ? 'portfolio' : 'rejected'})`);
      } catch (error) {
        console.warn(`  ✗ Failed to persist ${ticker}: ${error}`);
      }
    }

    // Update screening run summary
    await updateScreeningRunTier3(
      screeningRunId,
      scoredCandidates.length, // inputCount
      portfolio.length // outputCount
    );

    // Mark the screening run as completed
    await completeScreeningRun(screeningRunId, portfolio.length);

    const executionTimeSeconds = Math.round((Date.now() - startTime) / 1000);

    // Print summary
    console.log('\n============================================================');
    console.log('TIER 3 DEEP RESEARCH COMPLETE');
    console.log('============================================================');
    console.log(`Run ID: ${screeningRunId}`);
    console.log(`Strategy: ${strategy}`);
    console.log(`\nPortfolio: ${portfolio.length} holdings`);
    console.log(`Total Weight: ${totalWeight.toFixed(1)}%`);
    console.log(`Average Conviction: ${averageConviction}/100`);
    console.log(`Average Upside: ${averageUpside !== null ? averageUpside + '%' : 'N/A'}`);
    console.log(`\nExecution Time: ${executionTimeSeconds}s`);

    console.log('\n--- FINAL PORTFOLIO ---');
    portfolio.forEach((h, i) => {
      const upside = h.compositeUpside !== null ? `${h.compositeUpside > 0 ? '+' : ''}${h.compositeUpside.toFixed(1)}%` : 'N/A';
      console.log(`${i + 1}. ${h.ticker.padEnd(6)} | ${h.convictionLevel.padEnd(9)} (${h.convictionScore}) | ${h.suggestedWeight.toFixed(1)}% | Upside: ${upside}`);
    });

    if (rejected.length > 0) {
      console.log('\n--- REJECTED ---');
      rejected.slice(0, 5).forEach((r, i) => {
        console.log(`${i + 1}. ${r.ticker} - ${r.reason}`);
      });
      if (rejected.length > 5) {
        console.log(`   ... and ${rejected.length - 5} more`);
      }
    }

    console.log('============================================================\n');

    return {
      screeningRunId,
      strategy,
      portfolio,
      portfolioCount: portfolio.length,
      totalWeight,
      rejected,
      rejectedCount: rejected.length,
      averageConviction,
      averageUpside,
      executionTimeSeconds,
    };
  },
});

// ============================================================================
// WORKFLOW DEFINITION
// ============================================================================

export const tier3ResearchWorkflow = createWorkflow({
  id: 'tier3-research',
  inputSchema: tier3InputSchema,
  outputSchema: tier3OutputSchema,
})
  .then(initializeResearchStep)
  .then(runDeepAnalysisStep)
  .then(calculateConvictionStep)
  .then(buildPortfolioStep);

tier3ResearchWorkflow.commit();
