// ============================================================================
// INTELLIGENT REBALANCE WORKFLOW
// ============================================================================
// Monthly review workflow for the Intelligent Portfolio Builder.
// Analyzes existing portfolio and makes rebalancing recommendations:
//
// PIPELINE:
// 1. Analyze Current Holdings - Re-run conviction scoring on existing positions
// 2. Identify Sell Candidates - Holdings with declining conviction or red flags
// 3. Screen Replacement Candidates - Find potential new additions from S&P 500
// 4. Generate Rebalancing Plan - Specific buy/sell recommendations
//
// INPUT: Portfolio ID + optional config
// OUTPUT: Rebalancing recommendations with analysis
//
// TIME: ~15-20 minutes for full analysis
// ============================================================================

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import {
  getPortfolio,
  getHoldings,
  getPortfolioSummary,
  updateHoldingPrice,
  updateHoldingConviction,
  removeHolding,
  addHolding,
  recordTransaction,
  createSnapshot,
  updatePortfolioCash,
} from '../db/portfolio-repository';
import {
  createScreeningRun,
  completeScreeningRun,
  failScreeningRun,
  updateScreeningRunPortfolio,
  createStockAnalysesBatch,
  updateTier3Results,
} from '../db/analysis-repository';
import { getStockPriceTool } from '../tools/equity-tools';
import { calculateConvictionScoreTool } from '../tools/conviction-tools';
import { HoldingSnapshot, ConvictionLevel } from '../db/schema';

// Import analysis workflows
import { dcfValuationWorkflow } from './dcf-workflow';
import { comparableAnalysisWorkflow } from './comparable-workflow';
import { sentimentAnalysisWorkflow } from './sentiment-workflow';
import { riskAssessmentWorkflow } from './risk-workflow';
import { earningsEventWorkflow } from './earnings-workflow';

// Import tier workflows for screening new candidates
import { tier1ScreeningWorkflow } from './tier1-screening-workflow';
import { tier2TriageWorkflow } from './tier2-triage-workflow';
import { tier3ResearchWorkflow } from './tier3-research-workflow';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG = {
  // Conviction thresholds
  sellConvictionThreshold: 40, // Sell if conviction drops below this
  holdConvictionThreshold: 50, // Hold if conviction is between sell and this
  buyConvictionThreshold: 60, // Only buy if conviction is above this

  // Rebalancing limits
  maxSellsPerReview: 3, // Maximum positions to sell in one review
  maxBuysPerReview: 3, // Maximum new positions to add
  maxTurnoverPct: 20, // Maximum portfolio turnover as % of value

  // Position sizing
  minPositionPct: 2,
  maxPositionPct: 10,
  targetCashPct: 5,

  // Analysis options
  runFullAnalysis: true, // Run all 5 analysis workflows on holdings
  screenNewCandidates: true, // Look for new opportunities
  newCandidateLimit: 10, // Max new candidates to analyze
};

// ============================================================================
// SCHEMAS
// ============================================================================

const rebalanceInputSchema = z.object({
  portfolioId: z.string(),
  strategy: z.enum(['value', 'growth', 'balanced']).optional(),
  config: z
    .object({
      sellConvictionThreshold: z.number().optional(),
      holdConvictionThreshold: z.number().optional(),
      buyConvictionThreshold: z.number().optional(),
      maxSellsPerReview: z.number().optional(),
      maxBuysPerReview: z.number().optional(),
      maxTurnoverPct: z.number().optional(),
      minPositionPct: z.number().optional(),
      maxPositionPct: z.number().optional(),
      targetCashPct: z.number().optional(),
      runFullAnalysis: z.boolean().optional(),
      screenNewCandidates: z.boolean().optional(),
      newCandidateLimit: z.number().optional(),
      // Execute trades automatically or just recommend
      executeRecommendations: z.boolean().optional(),
    })
    .optional(),
});

const holdingAnalysisSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  sector: z.string().nullable(),
  shares: z.number(),
  avgCost: z.number(),
  currentPrice: z.number(),
  marketValue: z.number(),
  unrealizedGainPct: z.number(),
  weight: z.number(),

  // Previous conviction
  previousConviction: z.number().nullable(),
  previousConvictionLevel: z.string().nullable(),

  // Updated conviction
  newConviction: z.number(),
  newConvictionLevel: z.string(),
  convictionChange: z.number(),

  // Analysis
  dcfUpside: z.number().nullable(),
  recommendation: z.enum(['HOLD', 'TRIM', 'SELL', 'ADD']),
  reasoning: z.string(),
  redFlags: z.array(z.string()),
  greenFlags: z.array(z.string()),
});

type HoldingAnalysis = z.infer<typeof holdingAnalysisSchema>;

const rebalanceRecommendationSchema = z.object({
  action: z.enum(['BUY', 'SELL', 'TRIM', 'ADD']),
  ticker: z.string(),
  companyName: z.string(),
  shares: z.number(),
  price: z.number(),
  value: z.number(),
  reason: z.string(),
  conviction: z.number(),
  convictionLevel: z.string(),
  priority: z.number(), // 1 = highest priority
});

type RebalanceRecommendation = z.infer<typeof rebalanceRecommendationSchema>;

const rebalanceOutputSchema = z.object({
  success: z.boolean(),
  screeningRunId: z.string(),
  portfolioId: z.string(),

  // Pre-rebalance state
  preRebalance: z.object({
    totalValue: z.number(),
    holdingsValue: z.number(),
    cashValue: z.number(),
    holdingsCount: z.number(),
    averageConviction: z.number(),
  }),

  // Holdings analysis
  holdingsAnalysis: z.array(holdingAnalysisSchema),
  holdingsToSell: z.array(z.string()),
  holdingsToTrim: z.array(z.string()),
  holdingsToAdd: z.array(z.string()),

  // New candidate analysis
  newCandidatesAnalyzed: z.number(),
  newCandidatesQualified: z.array(
    z.object({
      ticker: z.string(),
      companyName: z.string(),
      conviction: z.number(),
      convictionLevel: z.string(),
      suggestedWeight: z.number(),
    })
  ),

  // Recommendations
  recommendations: z.array(rebalanceRecommendationSchema),
  recommendedTurnover: z.number(),
  recommendedTurnoverPct: z.number(),

  // Execution (if executeRecommendations was true)
  executedTrades: z.array(
    z.object({
      action: z.enum(['BUY', 'SELL']),
      ticker: z.string(),
      shares: z.number(),
      price: z.number(),
      value: z.number(),
    })
  ),

  // Post-rebalance state (if executed)
  postRebalance: z
    .object({
      totalValue: z.number(),
      holdingsValue: z.number(),
      cashValue: z.number(),
      holdingsCount: z.number(),
      averageConviction: z.number(),
    })
    .nullable(),

  executionTimeSeconds: z.number(),
  errorMessage: z.string().nullable(),
});

export type RebalanceOutput = z.infer<typeof rebalanceOutputSchema>;

// ============================================================================
// SECTOR TO PEERS MAPPING (copied from tier3)
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
// STEP 1: INITIALIZE REBALANCE
// ============================================================================

const initializeRebalanceStep = createStep({
  id: 'initialize-rebalance',
  inputSchema: rebalanceInputSchema,
  outputSchema: z.object({
    screeningRunId: z.string(),
    portfolioId: z.string(),
    portfolio: z.any(),
    holdings: z.array(z.any()),
    portfolioSummary: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { portfolioId } = inputData;
    const userConfig = inputData.config || {};

    const config = {
      ...DEFAULT_CONFIG,
      ...userConfig,
    };

    // Get portfolio
    const portfolio = await getPortfolio(portfolioId);
    if (!portfolio) {
      throw new Error(`Portfolio not found: ${portfolioId}`);
    }

    const strategy = inputData.strategy || portfolio.strategy;
    const holdings = await getHoldings(portfolioId);
    const portfolioSummary = await getPortfolioSummary(portfolioId);

    if (!portfolioSummary) {
      throw new Error(`Could not get portfolio summary for: ${portfolioId}`);
    }

    // Generate screening run ID
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const screeningRunId = `REBAL-${portfolioId.slice(0, 10)}-${timestamp}`;

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('🔄 INTELLIGENT PORTFOLIO REBALANCER');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`Run ID: ${screeningRunId}`);
    console.log(`Portfolio: ${portfolioId}`);
    console.log(`Strategy: ${strategy.toUpperCase()}`);
    console.log(`Current Holdings: ${holdings.length}`);
    console.log(`Portfolio Value: $${portfolioSummary.totalValue.toLocaleString()}`);
    console.log(`Cash: $${portfolioSummary.cashValue.toLocaleString()}`);
    console.log('════════════════════════════════════════════════════════════\n');

    // Create screening run record
    await createScreeningRun({
      id: screeningRunId,
      portfolioId,
      runType: 'MONTHLY_REVIEW',
      strategy,
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
        tier1MinScore: 50,
        tier1MaxCandidates: 30,
        tier2MaxCandidates: 25,
        tier3MinConviction: config.buyConvictionThreshold,
        maxSectorPct: 25,
        minPositionPct: config.minPositionPct,
        maxPositionPct: config.maxPositionPct,
        targetHoldings: holdings.length,
        cashReservePct: config.targetCashPct,
      },
    });

    return {
      screeningRunId,
      portfolioId,
      portfolio,
      holdings,
      portfolioSummary,
      strategy,
      config,
      startTime: Date.now(),
    };
  },
});

// ============================================================================
// STEP 2: ANALYZE CURRENT HOLDINGS
// ============================================================================

const analyzeHoldingsStep = createStep({
  id: 'analyze-holdings',
  inputSchema: z.object({
    screeningRunId: z.string(),
    portfolioId: z.string(),
    portfolio: z.any(),
    holdings: z.array(z.any()),
    portfolioSummary: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    portfolioId: z.string(),
    portfolio: z.any(),
    portfolioSummary: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    holdingsAnalysis: z.array(holdingAnalysisSchema),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, portfolioId, portfolio, holdings, portfolioSummary, strategy, config, startTime } = inputData;

    console.log('\n┌────────────────────────────────────────────────────────────┐');
    console.log('│ STEP 1: ANALYZING CURRENT HOLDINGS                         │');
    console.log('└────────────────────────────────────────────────────────────┘\n');

    const holdingsAnalysis: HoldingAnalysis[] = [];

    // Create stock_analyses records for holdings
    const analysisRecords = holdings.map((h: any) => ({
      screeningRunId,
      ticker: h.ticker,
      tier1Score: h.convictionScore || 50,
      tier1Passed: true,
    }));
    await createStockAnalysesBatch(analysisRecords);

    for (let i = 0; i < holdings.length; i++) {
      const holding = holdings[i];
      const ticker = holding.ticker;

      console.log(`\n[${i + 1}/${holdings.length}] Analyzing ${ticker}...`);

      // Get current price
      let currentPrice = holding.currentPrice || holding.avgCost;
      try {
        const priceResult = await getStockPriceTool.execute({
          context: { ticker },
          runtimeContext: {} as any,
        });
        if (priceResult.price) {
          currentPrice = priceResult.price;
          await updateHoldingPrice(portfolioId, ticker, currentPrice);
        }
      } catch (error) {
        console.warn(`  Could not fetch price for ${ticker}, using last known`);
      }

      const marketValue = holding.shares * currentPrice;
      const unrealizedGainPct = ((currentPrice - holding.avgCost) / holding.avgCost) * 100;
      const weight = (marketValue / portfolioSummary.totalValue) * 100;

      // Run analysis workflows if configured
      let dcfValuation: string | null = null;
      let comparableAnalysis: string | null = null;
      let sentimentAnalysis: string | null = null;
      let riskAssessment: string | null = null;
      let earningsAnalysis: string | null = null;

      if (config.runFullAnalysis) {
        // Get peers for comparable analysis
        const sector = holding.sector || '';
        let peers = SECTOR_PEERS[sector] || DEFAULT_PEERS;
        peers = peers.filter((p: string) => p.toUpperCase() !== ticker.toUpperCase()).slice(0, 4);

        // Run workflows in parallel
        const workflowPromises: Promise<void>[] = [];

        workflowPromises.push(
          (async () => {
            try {
              const run = await dcfValuationWorkflow.createRunAsync();
              const result = await run.start({ inputData: { ticker } });
              if (result.status === 'success' && result.result) {
                dcfValuation = (result.result as { valuation: string }).valuation;
              }
            } catch (e) {
              /* ignore */
            }
          })()
        );

        workflowPromises.push(
          (async () => {
            try {
              const run = await comparableAnalysisWorkflow.createRunAsync();
              const result = await run.start({ inputData: { ticker, peers } });
              if (result.status === 'success' && result.result) {
                comparableAnalysis = (result.result as { analysis: string }).analysis;
              }
            } catch (e) {
              /* ignore */
            }
          })()
        );

        workflowPromises.push(
          (async () => {
            try {
              const run = await sentimentAnalysisWorkflow.createRunAsync();
              const result = await run.start({ inputData: { ticker } });
              if (result.status === 'success' && result.result) {
                sentimentAnalysis = (result.result as { analysis: string }).analysis;
              }
            } catch (e) {
              /* ignore */
            }
          })()
        );

        workflowPromises.push(
          (async () => {
            try {
              const run = await riskAssessmentWorkflow.createRunAsync();
              const result = await run.start({ inputData: { ticker } });
              if (result.status === 'success' && result.result) {
                riskAssessment = (result.result as { riskAssessment: string }).riskAssessment;
              }
            } catch (e) {
              /* ignore */
            }
          })()
        );

        workflowPromises.push(
          (async () => {
            try {
              const run = await earningsEventWorkflow.createRunAsync();
              const result = await run.start({ inputData: { ticker } });
              if (result.status === 'success' && result.result) {
                earningsAnalysis = (result.result as { earningsAnalysis: string }).earningsAnalysis;
              }
            } catch (e) {
              /* ignore */
            }
          })()
        );

        await Promise.all(workflowPromises);

        const completedWorkflows = [dcfValuation, comparableAnalysis, sentimentAnalysis, riskAssessment, earningsAnalysis].filter(Boolean).length;
        console.log(`  Completed ${completedWorkflows}/5 analysis workflows`);
      }

      // Calculate new conviction score
      const convictionResult = await calculateConvictionScoreTool.execute({
        context: {
          ticker,
          companyName: holding.companyName || ticker,
          sector: holding.sector,
          currentPrice,
          tier1Score: holding.convictionScore || 50,
          tier2Decision: 'PASS' as const,
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

      const previousConviction = holding.convictionScore;
      const convictionChange = previousConviction ? convictionResult.convictionScore - previousConviction : 0;

      // Determine recommendation
      let recommendation: 'HOLD' | 'TRIM' | 'SELL' | 'ADD';
      let reasoning: string;

      if (convictionResult.convictionScore < config.sellConvictionThreshold) {
        recommendation = 'SELL';
        reasoning = `Conviction dropped to ${convictionResult.convictionScore} (below ${config.sellConvictionThreshold} threshold)`;
      } else if (convictionResult.convictionScore < config.holdConvictionThreshold) {
        recommendation = 'TRIM';
        reasoning = `Low conviction (${convictionResult.convictionScore}), consider reducing position`;
      } else if (weight > config.maxPositionPct && convictionResult.convictionScore < 70) {
        recommendation = 'TRIM';
        reasoning = `Position oversized (${weight.toFixed(1)}%) with moderate conviction`;
      } else if (weight < config.minPositionPct && convictionResult.convictionScore >= 70) {
        recommendation = 'ADD';
        reasoning = `Undersized position (${weight.toFixed(1)}%) with high conviction`;
      } else {
        recommendation = 'HOLD';
        reasoning = `Conviction ${convictionResult.convictionScore}/100 - maintain position`;
      }

      // Persist analysis results
      await updateTier3Results(screeningRunId, ticker, {
        dcfAnalysis: dcfValuation ?? undefined,
        comparableAnalysis: comparableAnalysis ?? undefined,
        sentimentAnalysis: sentimentAnalysis ?? undefined,
        riskAnalysis: riskAssessment ?? undefined,
        earningsAnalysis: earningsAnalysis ?? undefined,
        convictionScore: convictionResult.convictionScore,
        convictionLevel: convictionResult.convictionLevel,
        dcfUpsidePct: convictionResult.dcfUpside ?? undefined,
        researchSummary: `Rebalance Review: ${recommendation} - ${reasoning}`,
      });

      // Sync new conviction score back to holdings table
      try {
        await updateHoldingConviction(
          portfolioId,
          ticker,
          convictionResult.convictionScore,
          convictionResult.convictionLevel as ConvictionLevel,
          null // Analysis ID - not directly available from conviction calculation
        );
        console.log(`  Updated holding conviction for ${ticker}: ${convictionResult.convictionScore}`);
      } catch (error) {
        console.warn(`  Failed to update holding conviction for ${ticker}: ${error}`);
      }

      holdingsAnalysis.push({
        ticker,
        companyName: holding.companyName || ticker,
        sector: holding.sector,
        shares: holding.shares,
        avgCost: holding.avgCost,
        currentPrice,
        marketValue,
        unrealizedGainPct,
        weight,
        previousConviction,
        previousConvictionLevel: holding.convictionLevel,
        newConviction: convictionResult.convictionScore,
        newConvictionLevel: convictionResult.convictionLevel,
        convictionChange,
        dcfUpside: convictionResult.dcfUpside,
        recommendation,
        reasoning,
        redFlags: convictionResult.bearFactors,
        greenFlags: convictionResult.bullFactors,
      });

      console.log(`  ${ticker}: ${convictionResult.convictionLevel} (${convictionResult.convictionScore}/100) → ${recommendation}`);
    }

    console.log('\n✓ Holdings analysis complete');

    return {
      screeningRunId,
      portfolioId,
      portfolio,
      portfolioSummary,
      strategy,
      config,
      startTime,
      holdingsAnalysis,
    };
  },
});

// ============================================================================
// STEP 3: SCREEN NEW CANDIDATES (Full Tier 1 → Tier 2 → Tier 3 Pipeline)
// ============================================================================

const screenNewCandidatesStep = createStep({
  id: 'screen-new-candidates',
  inputSchema: z.object({
    screeningRunId: z.string(),
    portfolioId: z.string(),
    portfolio: z.any(),
    portfolioSummary: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    holdingsAnalysis: z.array(holdingAnalysisSchema),
  }),
  outputSchema: z.object({
    screeningRunId: z.string(),
    portfolioId: z.string(),
    portfolio: z.any(),
    portfolioSummary: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    holdingsAnalysis: z.array(holdingAnalysisSchema),
    newCandidates: z.array(z.any()),
  }),

  execute: async ({ inputData }) => {
    const { screeningRunId, portfolioId, portfolio, portfolioSummary, strategy, config, startTime, holdingsAnalysis } = inputData;

    if (!config.screenNewCandidates) {
      console.log('\n[Skipping new candidate screening as per config]');
      return {
        screeningRunId,
        portfolioId,
        portfolio,
        portfolioSummary,
        strategy,
        config,
        startTime,
        holdingsAnalysis,
        newCandidates: [],
      };
    }

    console.log('\n┌────────────────────────────────────────────────────────────┐');
    console.log('│ STEP 2: SCREENING NEW CANDIDATES (Full Pipeline)           │');
    console.log('└────────────────────────────────────────────────────────────┘\n');

    // Get current holdings tickers to exclude
    const currentTickers = new Set(holdingsAnalysis.map((h) => h.ticker.toUpperCase()));

    // Create a screening run for new candidates (required for foreign key constraints)
    const newCandidateRunId = `${screeningRunId}-NEW`;
    try {
      await createScreeningRun({
        id: newCandidateRunId,
        portfolioId,
        runType: 'MONTHLY_REVIEW',
        strategy,
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
          tier1MinScore: 55,
          tier1MaxCandidates: 50,
          tier2MaxCandidates: config.newCandidateLimit * 2,
          tier3MinConviction: config.buyConvictionThreshold,
          maxSectorPct: 25,
          minPositionPct: config.minPositionPct,
          maxPositionPct: config.maxPositionPct,
          targetHoldings: config.maxBuysPerReview,
          cashReservePct: config.targetCashPct,
        },
      });
      console.log(`Created screening run for new candidates: ${newCandidateRunId}`);
    } catch (error) {
      console.warn(`  Note: Screening run may already exist: ${error}`);
    }

    // ========================================================================
    // TIER 1: Quantitative Screening
    // ========================================================================
    console.log('Running Tier 1 quantitative screening...');
    const tier1Run = await tier1ScreeningWorkflow.createRunAsync();
    const tier1Result = await tier1Run.start({
      inputData: {
        screeningRunId: newCandidateRunId,
        strategy,
        config: {
          minScore: 55, // Higher bar for replacements
          maxCandidates: 50, // Get more candidates to filter through
        },
      },
    });

    if (tier1Result.status !== 'success' || !tier1Result.result) {
      console.log('  Tier 1 screening failed, skipping new candidates');
      return {
        screeningRunId,
        portfolioId,
        portfolio,
        portfolioSummary,
        strategy,
        config,
        startTime,
        holdingsAnalysis,
        newCandidates: [],
      };
    }

    const tier1Output = tier1Result.result as any;
    const tier1Candidates = tier1Output.candidates || [];

    // Filter out current holdings
    const filteredCandidates = tier1Candidates.filter(
      (c: any) => !currentTickers.has(c.ticker.toUpperCase())
    );

    console.log(`  Tier 1 passed: ${tier1Candidates.length}`);
    console.log(`  After filtering holdings: ${filteredCandidates.length}`);

    if (filteredCandidates.length === 0) {
      console.log('  No new candidates after filtering, skipping Tier 2/3');
      return {
        screeningRunId,
        portfolioId,
        portfolio,
        portfolioSummary,
        strategy,
        config,
        startTime,
        holdingsAnalysis,
        newCandidates: [],
      };
    }

    // ========================================================================
    // TIER 2: Intelligent Triage
    // ========================================================================
    console.log('\nRunning Tier 2 intelligent triage...');

    // Prepare tier2 input with filtered candidates
    const tier2Input = {
      screeningRunId: newCandidateRunId,
      candidates: filteredCandidates.slice(0, 30), // Limit to 30 for triage
      totalScreened: tier1Output.totalScreened,
      passedCount: filteredCandidates.length,
      rejectedCount: tier1Output.rejectedCount,
      rejectionBreakdown: tier1Output.rejectionBreakdown,
      executionTimeSeconds: tier1Output.executionTimeSeconds,
      strategy,
      config: {
        maxFinalists: config.newCandidateLimit * 2, // Get more finalists to have options after Tier 3
        fastTrackMinScore: 70,
        passMinScore: 55,
      },
    };

    const tier2Run = await tier2TriageWorkflow.createRunAsync();
    const tier2Result = await tier2Run.start({ inputData: tier2Input });

    if (tier2Result.status !== 'success' || !tier2Result.result) {
      console.log('  Tier 2 triage failed, skipping new candidates');
      return {
        screeningRunId,
        portfolioId,
        portfolio,
        portfolioSummary,
        strategy,
        config,
        startTime,
        holdingsAnalysis,
        newCandidates: [],
      };
    }

    const tier2Output = tier2Result.result as any;
    const tier2Finalists = tier2Output.finalists || [];

    console.log(`  Tier 2 finalists: ${tier2Finalists.length}`);
    console.log(`  Fast-tracked: ${tier2Output.fastTrackedCount}`);

    if (tier2Finalists.length === 0) {
      console.log('  No finalists after Tier 2, skipping Tier 3');
      return {
        screeningRunId,
        portfolioId,
        portfolio,
        portfolioSummary,
        strategy,
        config,
        startTime,
        holdingsAnalysis,
        newCandidates: [],
      };
    }

    // ========================================================================
    // TIER 3: Deep Analysis
    // ========================================================================
    console.log('\nRunning Tier 3 deep analysis...');
    console.log(`  Analyzing ${Math.min(tier2Finalists.length, config.newCandidateLimit)} candidates...`);

    // Prepare tier3 input - limit to newCandidateLimit
    const tier3Input = {
      screeningRunId: newCandidateRunId,
      finalists: tier2Finalists.slice(0, config.newCandidateLimit),
      rejected: tier2Output.rejected || [],
      finalistCount: Math.min(tier2Finalists.length, config.newCandidateLimit),
      rejectedCount: tier2Output.rejectedCount,
      fastTrackedCount: tier2Output.fastTrackedCount,
      executionTimeSeconds: tier2Output.executionTimeSeconds,
      strategy,
      config: {
        maxHoldings: config.maxBuysPerReview, // Only select up to maxBuysPerReview
        minConviction: config.buyConvictionThreshold,
        maxPositionWeight: config.maxPositionPct,
        runDCF: config.runFullAnalysis,
        runComparables: config.runFullAnalysis,
        runSentiment: true,
        runRisk: true,
        runEarnings: config.runFullAnalysis,
      },
    };

    const tier3Run = await tier3ResearchWorkflow.createRunAsync();
    const tier3Result = await tier3Run.start({ inputData: tier3Input });

    if (tier3Result.status !== 'success' || !tier3Result.result) {
      console.log('  Tier 3 analysis failed, skipping new candidates');
      return {
        screeningRunId,
        portfolioId,
        portfolio,
        portfolioSummary,
        strategy,
        config,
        startTime,
        holdingsAnalysis,
        newCandidates: [],
      };
    }

    const tier3Output = tier3Result.result as any;
    const tier3Portfolio = tier3Output.portfolio || [];

    console.log(`  Tier 3 qualified: ${tier3Portfolio.length}`);
    console.log(`  Average conviction: ${tier3Output.averageConviction}/100`);

    // Map tier3 portfolio to the format expected by generateRecommendationsStep
    const qualifiedCandidates = tier3Portfolio.map((candidate: any) => ({
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      sector: candidate.sector,
      price: candidate.currentPrice,
      tier1Score: candidate.tier1Score,
      convictionScore: candidate.convictionScore,
      convictionLevel: candidate.convictionLevel,
      compositeUpside: candidate.compositeUpside,
      suggestedWeight: candidate.suggestedWeight,
      bullFactors: candidate.bullFactors,
      bearFactors: candidate.bearFactors,
      keyRisks: candidate.keyRisks,
      // Flag that this went through full analysis
      fullAnalysisComplete: true,
    }));

    console.log(`\n✓ ${qualifiedCandidates.length} candidates passed full analysis pipeline`);
    qualifiedCandidates.forEach((c: any, i: number) => {
      console.log(`  ${i + 1}. ${c.ticker} - ${c.convictionLevel} (${c.convictionScore}/100)`);
    });

    return {
      screeningRunId,
      portfolioId,
      portfolio,
      portfolioSummary,
      strategy,
      config,
      startTime,
      holdingsAnalysis,
      newCandidates: qualifiedCandidates,
    };
  },
});

// ============================================================================
// STEP 4: GENERATE RECOMMENDATIONS
// ============================================================================

const generateRecommendationsStep = createStep({
  id: 'generate-recommendations',
  inputSchema: z.object({
    screeningRunId: z.string(),
    portfolioId: z.string(),
    portfolio: z.any(),
    portfolioSummary: z.any(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: z.any(),
    startTime: z.number(),
    holdingsAnalysis: z.array(holdingAnalysisSchema),
    newCandidates: z.array(z.any()),
  }),
  outputSchema: rebalanceOutputSchema,

  execute: async ({ inputData }) => {
    const { screeningRunId, portfolioId, portfolio, portfolioSummary, strategy, config, startTime, holdingsAnalysis, newCandidates } = inputData;

    console.log('\n┌────────────────────────────────────────────────────────────┐');
    console.log('│ STEP 3: GENERATING RECOMMENDATIONS                         │');
    console.log('└────────────────────────────────────────────────────────────┘\n');

    const recommendations: RebalanceRecommendation[] = [];
    let priority = 1;

    // 1. Generate SELL recommendations
    const sellCandidates = holdingsAnalysis
      .filter((h) => h.recommendation === 'SELL')
      .sort((a, b) => a.newConviction - b.newConviction)
      .slice(0, config.maxSellsPerReview);

    for (const holding of sellCandidates) {
      recommendations.push({
        action: 'SELL',
        ticker: holding.ticker,
        companyName: holding.companyName,
        shares: holding.shares,
        price: holding.currentPrice,
        value: holding.marketValue,
        reason: holding.reasoning,
        conviction: holding.newConviction,
        convictionLevel: holding.newConvictionLevel,
        priority: priority++,
      });
    }

    // 2. Generate TRIM recommendations
    const trimCandidates = holdingsAnalysis
      .filter((h) => h.recommendation === 'TRIM')
      .sort((a, b) => a.newConviction - b.newConviction);

    for (const holding of trimCandidates) {
      // Trim to target weight (e.g., if overweight, reduce to max position %)
      const targetWeight = config.maxPositionPct * 0.8; // Trim to 80% of max
      const targetValue = (portfolioSummary.totalValue * targetWeight) / 100;
      const sharesToSell = Math.floor((holding.marketValue - targetValue) / holding.currentPrice);

      if (sharesToSell > 0) {
        recommendations.push({
          action: 'TRIM',
          ticker: holding.ticker,
          companyName: holding.companyName,
          shares: sharesToSell,
          price: holding.currentPrice,
          value: sharesToSell * holding.currentPrice,
          reason: holding.reasoning,
          conviction: holding.newConviction,
          convictionLevel: holding.newConvictionLevel,
          priority: priority++,
        });
      }
    }

    // 3. Calculate available cash after sells
    const cashFromSells = recommendations.filter((r) => r.action === 'SELL' || r.action === 'TRIM').reduce((sum, r) => sum + r.value, 0);
    const availableCash = portfolioSummary.cashValue + cashFromSells;
    const targetCash = (portfolioSummary.totalValue * config.targetCashPct) / 100;
    const investableCash = Math.max(0, availableCash - targetCash);

    // 4. Generate ADD recommendations for undersized positions
    const addCandidates = holdingsAnalysis.filter((h) => h.recommendation === 'ADD').sort((a, b) => b.newConviction - a.newConviction);

    let remainingCash = investableCash;
    for (const holding of addCandidates) {
      const targetWeight = config.minPositionPct * 1.5; // Add to 150% of min
      const targetValue = (portfolioSummary.totalValue * targetWeight) / 100;
      const additionalValue = targetValue - holding.marketValue;
      const sharesToBuy = Math.floor(Math.min(additionalValue, remainingCash) / holding.currentPrice);

      if (sharesToBuy > 0 && remainingCash >= sharesToBuy * holding.currentPrice) {
        recommendations.push({
          action: 'ADD',
          ticker: holding.ticker,
          companyName: holding.companyName,
          shares: sharesToBuy,
          price: holding.currentPrice,
          value: sharesToBuy * holding.currentPrice,
          reason: holding.reasoning,
          conviction: holding.newConviction,
          convictionLevel: holding.newConvictionLevel,
          priority: priority++,
        });
        remainingCash -= sharesToBuy * holding.currentPrice;
      }
    }

    // 5. Generate BUY recommendations for new candidates (fully analyzed through Tier 3)
    const qualifiedNewCandidates: any[] = [];

    if (newCandidates.length > 0 && remainingCash > 0) {
      // Sort by conviction score (from full Tier 3 analysis)
      const sortedNew = [...newCandidates].sort((a, b) => b.convictionScore - a.convictionScore);

      let buysAdded = 0;
      for (const candidate of sortedNew) {
        if (buysAdded >= config.maxBuysPerReview || remainingCash < portfolioSummary.totalValue * (config.minPositionPct / 100)) {
          break;
        }

        // Only buy if conviction meets threshold
        if (candidate.convictionScore < config.buyConvictionThreshold) {
          console.log(`  Skipping ${candidate.ticker}: conviction ${candidate.convictionScore} below threshold ${config.buyConvictionThreshold}`);
          continue;
        }

        // Calculate position size based on suggested weight from Tier 3
        const targetWeight = candidate.suggestedWeight || (config.minPositionPct + config.maxPositionPct) / 2;
        const targetValue = (portfolioSummary.totalValue * targetWeight) / 100;
        const buyValue = Math.min(targetValue, remainingCash);
        const sharesToBuy = Math.floor(buyValue / candidate.price);

        if (sharesToBuy > 0) {
          const upside = candidate.compositeUpside !== null ? `${candidate.compositeUpside > 0 ? '+' : ''}${candidate.compositeUpside.toFixed(1)}%` : 'N/A';

          recommendations.push({
            action: 'BUY',
            ticker: candidate.ticker,
            companyName: candidate.companyName,
            shares: sharesToBuy,
            price: candidate.price,
            value: sharesToBuy * candidate.price,
            reason: `Full analysis: ${candidate.convictionLevel} conviction (${candidate.convictionScore}/100), Upside: ${upside}`,
            conviction: candidate.convictionScore,
            convictionLevel: candidate.convictionLevel,
            priority: priority++,
          });

          qualifiedNewCandidates.push({
            ticker: candidate.ticker,
            companyName: candidate.companyName,
            conviction: candidate.convictionScore,
            convictionLevel: candidate.convictionLevel,
            suggestedWeight: targetWeight,
            compositeUpside: candidate.compositeUpside,
          });

          remainingCash -= sharesToBuy * candidate.price;
          buysAdded++;
        }
      }
    }

    // Calculate turnover
    const totalTurnover = recommendations.reduce((sum, r) => sum + r.value, 0);
    const turnoverPct = (totalTurnover / portfolioSummary.totalValue) * 100;

    // Execute recommendations if configured
    const executedTrades: any[] = [];
    let postRebalance = null;

    if (config.executeRecommendations) {
      console.log('\n┌────────────────────────────────────────────────────────────┐');
      console.log('│ EXECUTING RECOMMENDATIONS                                   │');
      console.log('└────────────────────────────────────────────────────────────┘\n');

      let currentCash = portfolioSummary.cashValue;

      for (const rec of recommendations) {
        try {
          if (rec.action === 'SELL' || rec.action === 'TRIM') {
            // Sell/trim position
            const holding = await getHolding(portfolioId, rec.ticker);
            if (holding) {
              const newShares = rec.action === 'SELL' ? 0 : holding.shares - rec.shares;

              if (newShares <= 0) {
                await removeHolding(portfolioId, rec.ticker);
              } else {
                await updateHoldingShares(portfolioId, rec.ticker, newShares);
              }

              await recordTransaction({
                portfolioId,
                ticker: rec.ticker,
                action: 'SELL',
                shares: rec.shares,
                price: rec.price,
                totalValue: rec.value,
                reason: `Rebalance ${rec.action}: ${rec.reason}`,
                scoreAtTrade: rec.conviction,
                analysisId: null,
                screeningRunId,
              });

              currentCash += rec.value;
              executedTrades.push({
                action: 'SELL',
                ticker: rec.ticker,
                shares: rec.shares,
                price: rec.price,
                value: rec.value,
              });

              console.log(`  ✓ ${rec.action} ${rec.ticker}: ${rec.shares} shares @ $${rec.price.toFixed(2)}`);
            }
          } else if (rec.action === 'BUY' || rec.action === 'ADD') {
            // Buy/add position
            if (currentCash >= rec.value) {
              // Look for sector in holdings analysis (for ADD) or new candidates (for BUY)
              const analysisEntry = holdingsAnalysis.find((h) => h.ticker === rec.ticker);
              const newCandidate = newCandidates.find((c: any) => c.ticker === rec.ticker);
              const sector = analysisEntry?.sector || newCandidate?.sector || null;

              await addHolding({
                portfolioId,
                ticker: rec.ticker,
                shares: rec.shares,
                avgCost: rec.price,
                currentPrice: rec.price,
                sector,
                convictionScore: rec.conviction,
                convictionLevel: rec.convictionLevel as ConvictionLevel,
                lastAnalysisId: null,
                lastAnalysisDate: new Date().toISOString(),
              });

              await recordTransaction({
                portfolioId,
                ticker: rec.ticker,
                action: 'BUY',
                shares: rec.shares,
                price: rec.price,
                totalValue: rec.value,
                reason: `Rebalance ${rec.action}: ${rec.reason}`,
                scoreAtTrade: rec.conviction,
                analysisId: null,
                screeningRunId,
              });

              currentCash -= rec.value;
              executedTrades.push({
                action: 'BUY',
                ticker: rec.ticker,
                shares: rec.shares,
                price: rec.price,
                value: rec.value,
              });

              console.log(`  ✓ ${rec.action} ${rec.ticker}: ${rec.shares} shares @ $${rec.price.toFixed(2)}`);
            }
          }
        } catch (error) {
          console.warn(`  ✗ Failed to execute ${rec.action} for ${rec.ticker}: ${error}`);
        }
      }

      // Update portfolio cash
      await updatePortfolioCash(portfolioId, currentCash);

      // Get post-rebalance summary
      const postSummary = await getPortfolioSummary(portfolioId);
      if (postSummary) {
        const postHoldings = await getHoldings(portfolioId);
        const avgConviction =
          postHoldings.length > 0
            ? postHoldings.reduce((sum, h) => sum + (h.convictionScore || 0), 0) / postHoldings.length
            : 0;

        postRebalance = {
          totalValue: postSummary.totalValue,
          holdingsValue: postSummary.holdingsValue,
          cashValue: postSummary.cashValue,
          holdingsCount: postSummary.holdingsCount,
          averageConviction: Math.round(avgConviction),
        };

        // Create snapshot
        const holdingsData: HoldingSnapshot[] = postHoldings.map((h) => ({
          ticker: h.ticker,
          shares: h.shares,
          price: h.currentPrice || h.avgCost,
          value: h.shares * (h.currentPrice || h.avgCost),
          weight: (h.shares * (h.currentPrice || h.avgCost)) / postSummary.totalValue,
          sector: h.sector || 'Unknown',
          gainPct: ((h.currentPrice || h.avgCost) - h.avgCost) / h.avgCost * 100,
        }));

        await createSnapshot({
          portfolioId,
          snapshotDate: new Date().toISOString().split('T')[0],
          totalValue: postSummary.totalValue,
          cashValue: postSummary.cashValue,
          holdingsValue: postSummary.holdingsValue,
          holdingsCount: postSummary.holdingsCount,
          periodReturnPct: null,
          cumulativeReturnPct: null,
          spyPeriodReturnPct: null,
          spyCumulativeReturnPct: null,
          alphaPct: null,
          holdingsData,
        });
      }
    }

    // Mark screening run as complete
    await completeScreeningRun(screeningRunId, holdingsAnalysis.length);

    const executionTimeSeconds = Math.round((Date.now() - startTime) / 1000);

    // Calculate pre-rebalance average conviction
    const preAvgConviction =
      holdingsAnalysis.length > 0
        ? Math.round(holdingsAnalysis.reduce((sum, h) => sum + h.newConviction, 0) / holdingsAnalysis.length)
        : 0;

    // Print summary
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('✅ REBALANCE ANALYSIS COMPLETE');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`\nScreening Run: ${screeningRunId}`);
    console.log(`Execution Time: ${executionTimeSeconds}s`);
    console.log(`\nHOLDINGS ANALYSIS:`);
    console.log(`  Analyzed: ${holdingsAnalysis.length}`);
    console.log(`  Sell: ${holdingsAnalysis.filter((h) => h.recommendation === 'SELL').length}`);
    console.log(`  Trim: ${holdingsAnalysis.filter((h) => h.recommendation === 'TRIM').length}`);
    console.log(`  Hold: ${holdingsAnalysis.filter((h) => h.recommendation === 'HOLD').length}`);
    console.log(`  Add: ${holdingsAnalysis.filter((h) => h.recommendation === 'ADD').length}`);
    console.log(`\nNEW CANDIDATES:`);
    console.log(`  Screened: ${newCandidates.length}`);
    console.log(`  Qualified: ${qualifiedNewCandidates.length}`);
    console.log(`\nRECOMMENDATIONS:`);
    recommendations.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.action} ${r.ticker}: ${r.shares} shares ($${r.value.toLocaleString()})`);
    });
    console.log(`\nTURNOVER: $${totalTurnover.toLocaleString()} (${turnoverPct.toFixed(1)}%)`);
    if (executedTrades.length > 0) {
      console.log(`\nEXECUTED: ${executedTrades.length} trades`);
    }
    console.log('════════════════════════════════════════════════════════════\n');

    return {
      success: true,
      screeningRunId,
      portfolioId,

      preRebalance: {
        totalValue: portfolioSummary.totalValue,
        holdingsValue: portfolioSummary.holdingsValue,
        cashValue: portfolioSummary.cashValue,
        holdingsCount: portfolioSummary.holdingsCount,
        averageConviction: preAvgConviction,
      },

      holdingsAnalysis,
      holdingsToSell: holdingsAnalysis.filter((h) => h.recommendation === 'SELL').map((h) => h.ticker),
      holdingsToTrim: holdingsAnalysis.filter((h) => h.recommendation === 'TRIM').map((h) => h.ticker),
      holdingsToAdd: holdingsAnalysis.filter((h) => h.recommendation === 'ADD').map((h) => h.ticker),

      newCandidatesAnalyzed: newCandidates.length,
      newCandidatesQualified: qualifiedNewCandidates,

      recommendations,
      recommendedTurnover: totalTurnover,
      recommendedTurnoverPct: turnoverPct,

      executedTrades,
      postRebalance,

      executionTimeSeconds,
      errorMessage: null,
    };
  },
});

// Helper function
async function getHolding(portfolioId: string, ticker: string) {
  const holdings = await getHoldings(portfolioId);
  return holdings.find((h) => h.ticker === ticker);
}

async function updateHoldingShares(portfolioId: string, ticker: string, shares: number) {
  const { getDbClient, initializeDatabase } = await import('../db/schema');
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE holdings SET shares = ?, updated_at = datetime('now') WHERE portfolio_id = ? AND ticker = ?`,
    args: [shares, portfolioId, ticker],
  });
}

// ============================================================================
// WORKFLOW DEFINITION
// ============================================================================

export const intelligentRebalanceWorkflow = createWorkflow({
  id: 'intelligent-rebalance',
  inputSchema: rebalanceInputSchema,
  outputSchema: rebalanceOutputSchema,
})
  .then(initializeRebalanceStep)
  .then(analyzeHoldingsStep)
  .then(screenNewCandidatesStep)
  .then(generateRecommendationsStep);

intelligentRebalanceWorkflow.commit();
