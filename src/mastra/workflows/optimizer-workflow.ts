// ============================================================================
// PORTFOLIO OPTIMIZER WORKFLOWS
// ============================================================================
// Two main workflows for the Portfolio Optimizer Agent:
//
// 1. portfolioConstructionWorkflow: Initial portfolio construction
//    - Screens S&P 500 universe
//    - Scores all stocks
//    - Selects top 20 with sector diversification
//    - Allocates $100K initial capital
//    - Creates portfolio and records transactions
//
// 2. monthlyReviewWorkflow: Monthly portfolio review and rebalancing
//    - Updates holdings prices
//    - Calculates performance vs SPY
//    - Re-scores current holdings
//    - Re-scores potential replacements
//    - Identifies buy/sell candidates
//    - Executes up to 10 trades
//    - Creates monthly snapshot
//
// CONFIGURATION:
// - Initial Capital: $100,000
// - Holdings: 20 stocks
// - Strategy: Value (40% value, 30% quality, 15% risk, 10% growth, 5% momentum)
// - Max Turnover: 10 stocks/month
// - Position Size: 2-10% per stock
// - Max Sector: 25%
// ============================================================================

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

import { ALL_SP500_TICKERS, getSectorForTicker } from '../data/sp500-stocks';
import { scoreStocksBatchTool, rankStocksTool, StockScoreOutput } from '../tools/optimizer-tools';
import {
  createPortfolio,
  getPortfolio,
  deletePortfolio,
  getHoldings,
  addHolding,
  updateHoldingPrice,
  updateHoldingShares,
  removeHolding,
  updatePortfolioCash,
  recordTransaction,
  createSnapshot,
  getLatestSnapshot,
  getPortfolioSummary,
  getMonthlyTransactionCount,
} from '../db/portfolio-repository';
import { Portfolio, Holding, HoldingSnapshot } from '../db/schema';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const llm = openai('gpt-4o');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORTFOLIO_CONFIG = {
  id: 'value-portfolio-1',
  name: 'S&P 500 Value Portfolio',
  strategy: 'value' as const,
  initialCapital: 100000,
  targetHoldings: 20,
  maxPositionPct: 0.10, // 10%
  minPositionPct: 0.02, // 2%
  maxSectorPct: 0.25, // 25%
  maxMonthlyTurnover: 10,
};

// ============================================================================
// SYNTHESIS AGENTS
// ============================================================================

const portfolioConstructionAgent = new Agent({
  name: 'Portfolio Constructor',
  model: llm,
  instructions: `
    You are a portfolio construction specialist. Your job is to analyze stock screening results
    and provide a summary of the initial portfolio construction.

    Format your response as:

    📊 **PORTFOLIO CONSTRUCTION SUMMARY**
    ═══════════════════════════════════════════

    💰 **CAPITAL ALLOCATION**
    • Initial Capital: $100,000
    • Positions: [Number of stocks]
    • Average Position Size: [Amount]

    📈 **TOP HOLDINGS**
    [List top 5 holdings with ticker, name, weight, and brief reason]

    📊 **SECTOR ALLOCATION**
    [Show sector breakdown with percentages]

    🎯 **PORTFOLIO CHARACTERISTICS**
    • Average Value Score: [X]
    • Average Quality Score: [X]
    • Average Total Score: [X]
    • Portfolio Beta: [X]

    💡 **STRATEGY NOTES**
    [Brief note on why these stocks were selected based on value criteria]
  `,
});

const monthlyReviewAgent = new Agent({
  name: 'Monthly Review Analyst',
  model: llm,
  instructions: `
    You are a portfolio review analyst. Your job is to analyze monthly performance
    and provide insights on rebalancing decisions.

    Format your response as:

    📈 **MONTHLY PORTFOLIO REVIEW**
    ═══════════════════════════════════════════

    📅 **PERIOD**: [Month/Year]

    💰 **PERFORMANCE**
    • Portfolio Return: [X%]
    • SPY Return: [X%]
    • Alpha: [X%]
    • Current Value: $[X]

    📊 **PORTFOLIO CHANGES**

    **SELLS** (if any)
    [List stocks sold with reason]

    **BUYS** (if any)
    [List stocks bought with reason]

    📈 **TOP PERFORMERS**
    [Top 3 performing stocks this month]

    📉 **UNDERPERFORMERS**
    [Bottom 3 performing stocks]

    🎯 **FORWARD OUTLOOK**
    [Brief notes on portfolio positioning]

    ⚠️ **RISK NOTES**
    [Any concentration or risk concerns]
  `,
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function fetchCurrentPrice(ticker: string): Promise<number> {
  const quote = await yf.quote(ticker);
  return quote.regularMarketPrice || 0;
}

async function fetchSPYReturn(startDate: string, endDate: string): Promise<number> {
  try {
    const history = await yf.chart('SPY', {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    if (history.quotes && history.quotes.length >= 2) {
      const startPrice = history.quotes[0].close || 0;
      const endPrice = history.quotes[history.quotes.length - 1].close || 0;
      return startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
    }
  } catch (error) {
    console.warn('Failed to fetch SPY return:', error);
  }
  return 0;
}

// ============================================================================
// PORTFOLIO CONSTRUCTION WORKFLOW
// ============================================================================

const screenAndScoreStocks = createStep({
  id: 'screen-and-score-stocks',
  description: 'Screen S&P 500 and score all stocks',

  inputSchema: z.object({
    universe: z.array(z.string()).optional(),
    sampleSize: z.number().optional().describe('For testing: limit to sample size'),
  }),

  outputSchema: z.object({
    scores: z.array(z.any()),
    totalProcessed: z.number(),
    processingTimeSeconds: z.number(),
  }),

  execute: async ({ inputData, runtimeContext }) => {
    const universe = inputData?.universe || ALL_SP500_TICKERS;
    const sampleSize = inputData?.sampleSize;

    // Use sample for testing, full universe for production
    const tickersToProcess = sampleSize ? universe.slice(0, sampleSize) : universe;

    console.log(`\nScreening ${tickersToProcess.length} stocks...`);

    const result = await scoreStocksBatchTool.execute({
      context: {
        tickers: tickersToProcess,
        strategy: 'value',
        saveToDb: true,
      },
      runtimeContext,
    });

    return {
      scores: result.scores,
      totalProcessed: result.totalProcessed,
      processingTimeSeconds: result.processingTimeSeconds,
    };
  },
});

const selectPortfolioStocks = createStep({
  id: 'select-portfolio-stocks',
  description: 'Select top stocks with diversification constraints',

  inputSchema: z.object({
    scores: z.array(z.any()),
    totalProcessed: z.number(),
    processingTimeSeconds: z.number(),
  }),

  outputSchema: z.object({
    selectedStocks: z.array(z.any()),
    sectorBreakdown: z.record(z.number()),
  }),

  execute: async ({ inputData, runtimeContext }) => {
    if (!inputData || inputData.scores.length === 0) {
      throw new Error('No scores provided');
    }

    const result = await rankStocksTool.execute({
      context: {
        scores: inputData.scores as StockScoreOutput[],
        targetCount: PORTFOLIO_CONFIG.targetHoldings,
        maxSectorPct: PORTFOLIO_CONFIG.maxSectorPct,
        minScore: 40, // Minimum score threshold
      },
      runtimeContext,
    });

    return {
      selectedStocks: result.rankedStocks,
      sectorBreakdown: result.sectorBreakdown,
    };
  },
});

const createInitialPortfolio = createStep({
  id: 'create-initial-portfolio',
  description: 'Create portfolio and allocate capital',

  inputSchema: z.object({
    selectedStocks: z.array(z.any()),
    sectorBreakdown: z.record(z.number()),
  }),

  outputSchema: z.object({
    portfolioId: z.string(),
    holdings: z.array(z.any()),
    transactions: z.array(z.any()),
    selectedStocks: z.array(z.any()),
    summary: z.object({
      totalValue: z.number(),
      holdingsCount: z.number(),
      cashRemaining: z.number(),
    }),
  }),

  execute: async ({ inputData }) => {
    if (!inputData || inputData.selectedStocks.length === 0) {
      throw new Error('No stocks selected');
    }

    const { selectedStocks } = inputData;

    // Delete existing portfolio if it exists (allows re-running the workflow)
    const existingPortfolio = await getPortfolio(PORTFOLIO_CONFIG.id);
    if (existingPortfolio) {
      console.log(`\nDeleting existing portfolio: ${PORTFOLIO_CONFIG.id}`);
      await deletePortfolio(PORTFOLIO_CONFIG.id);
    }

    // Create portfolio
    const portfolio = await createPortfolio({
      id: PORTFOLIO_CONFIG.id,
      name: PORTFOLIO_CONFIG.name,
      strategy: PORTFOLIO_CONFIG.strategy,
      initialCapital: PORTFOLIO_CONFIG.initialCapital,
      currentCash: PORTFOLIO_CONFIG.initialCapital,
      targetHoldings: PORTFOLIO_CONFIG.targetHoldings,
      maxPositionPct: PORTFOLIO_CONFIG.maxPositionPct,
      minPositionPct: PORTFOLIO_CONFIG.minPositionPct,
      maxSectorPct: PORTFOLIO_CONFIG.maxSectorPct,
      maxMonthlyTurnover: PORTFOLIO_CONFIG.maxMonthlyTurnover,
    });

    let remainingCash = PORTFOLIO_CONFIG.initialCapital;
    const holdings: Holding[] = [];
    const transactions: { ticker: string; shares: number; price: number; totalValue: number }[] = [];

    // Allocate capital based on suggested weights
    for (const stock of selectedStocks) {
      const targetValue = PORTFOLIO_CONFIG.initialCapital * stock.suggestedWeight;
      const price = stock.price;
      const shares = Math.floor(targetValue / price); // Buy whole shares

      if (shares > 0) {
        const totalValue = shares * price;
        remainingCash -= totalValue;

        // Add holding
        const holding = await addHolding({
          portfolioId: portfolio.id,
          ticker: stock.ticker,
          shares,
          avgCost: price,
          currentPrice: price,
          sector: stock.sector,
          convictionScore: null,
          convictionLevel: null,
          lastAnalysisId: null,
          lastAnalysisDate: null,
        });
        holdings.push(holding);

        // Record transaction
        await recordTransaction({
          portfolioId: portfolio.id,
          ticker: stock.ticker,
          action: 'BUY',
          shares,
          price,
          totalValue,
          reason: `Initial portfolio construction - Score: ${stock.totalScore}`,
          scoreAtTrade: stock.totalScore,
          analysisId: null,
          screeningRunId: null,
        });

        transactions.push({ ticker: stock.ticker, shares, price, totalValue });
      }
    }

    // Update remaining cash
    await updatePortfolioCash(portfolio.id, remainingCash);

    // Create initial snapshot
    const holdingsValue = transactions.reduce((sum, t) => sum + t.totalValue, 0);
    await createSnapshot({
      portfolioId: portfolio.id,
      snapshotDate: new Date().toISOString().split('T')[0],
      totalValue: holdingsValue + remainingCash,
      cashValue: remainingCash,
      holdingsValue,
      holdingsCount: holdings.length,
      periodReturnPct: 0,
      cumulativeReturnPct: 0,
      spyPeriodReturnPct: 0,
      spyCumulativeReturnPct: 0,
      alphaPct: 0,
      holdingsData: holdings.map((h) => ({
        ticker: h.ticker,
        shares: h.shares,
        price: h.currentPrice || h.avgCost,
        value: h.shares * (h.currentPrice || h.avgCost),
        weight: (h.shares * (h.currentPrice || h.avgCost)) / (holdingsValue + remainingCash),
        sector: h.sector || 'Unknown',
        gainPct: 0,
      })),
    });

    return {
      portfolioId: portfolio.id,
      holdings,
      transactions,
      selectedStocks,
      summary: {
        totalValue: holdingsValue + remainingCash,
        holdingsCount: holdings.length,
        cashRemaining: remainingCash,
      },
    };
  },
});

const synthesizeConstruction = createStep({
  id: 'synthesize-construction',
  description: 'AI generates portfolio construction summary',

  inputSchema: z.object({
    portfolioId: z.string(),
    holdings: z.array(z.any()),
    transactions: z.array(z.any()),
    selectedStocks: z.array(z.any()),
    summary: z.object({
      totalValue: z.number(),
      holdingsCount: z.number(),
      cashRemaining: z.number(),
    }),
  }),

  outputSchema: z.object({
    report: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('No input data');
    }

    const portfolioSummary = await getPortfolioSummary(inputData.portfolioId);
    const { selectedStocks } = inputData;

    // Calculate portfolio characteristics from selectedStocks
    const purchasedTickers = new Set(inputData.holdings.map((h: Holding) => h.ticker));
    const purchasedStocks = selectedStocks.filter((s: { ticker: string }) => purchasedTickers.has(s.ticker));

    const avgValueScore = purchasedStocks.length > 0
      ? (purchasedStocks.reduce((sum: number, s: { valueScore: number }) => sum + s.valueScore, 0) / purchasedStocks.length).toFixed(1)
      : 'N/A';
    const avgQualityScore = purchasedStocks.length > 0
      ? (purchasedStocks.reduce((sum: number, s: { qualityScore: number }) => sum + s.qualityScore, 0) / purchasedStocks.length).toFixed(1)
      : 'N/A';
    const avgTotalScore = purchasedStocks.length > 0
      ? (purchasedStocks.reduce((sum: number, s: { totalScore: number }) => sum + s.totalScore, 0) / purchasedStocks.length).toFixed(1)
      : 'N/A';
    const avgBeta = purchasedStocks.length > 0
      ? (purchasedStocks.reduce((sum: number, s: { metrics?: { beta: number | null } }) => sum + (s.metrics?.beta || 1), 0) / purchasedStocks.length).toFixed(2)
      : 'N/A';

    const prompt = `Analyze this newly constructed portfolio:

Portfolio: ${PORTFOLIO_CONFIG.name}
Strategy: ${PORTFOLIO_CONFIG.strategy}
Initial Capital: $${PORTFOLIO_CONFIG.initialCapital.toLocaleString()}

Holdings (${inputData.holdings.length} stocks):
${inputData.holdings
  .map((h: Holding) => {
    const value = h.shares * (h.currentPrice || h.avgCost);
    const weight = ((value / inputData.summary.totalValue) * 100).toFixed(1);
    const stockScore = purchasedStocks.find((s: { ticker: string }) => s.ticker === h.ticker);
    const scoreInfo = stockScore ? ` | Score: ${stockScore.totalScore}` : '';
    return `- ${h.ticker}: ${h.shares} shares @ $${h.avgCost.toFixed(2)} = $${value.toFixed(0)} (${weight}%) [${h.sector}]${scoreInfo}`;
  })
  .join('\n')}

Sector Breakdown:
${
  portfolioSummary
    ? Object.entries(portfolioSummary.sectorBreakdown)
        .sort((a, b) => b[1].value - a[1].value)
        .map(([sector, data]) => `- ${sector}: ${data.count} stocks, ${data.weight.toFixed(1)}%`)
        .join('\n')
    : 'N/A'
}

Portfolio Characteristics:
- Average Value Score: ${avgValueScore}
- Average Quality Score: ${avgQualityScore}
- Average Total Score: ${avgTotalScore}
- Portfolio Beta: ${avgBeta}

Cash Remaining: $${inputData.summary.cashRemaining.toFixed(2)}
Total Portfolio Value: $${inputData.summary.totalValue.toFixed(2)}

Provide a summary of this portfolio construction.`;

    const response = await portfolioConstructionAgent.streamLegacy([
      { role: 'user', content: prompt },
    ]);

    let report = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      report += chunk;
    }

    return { report };
  },
});

// ============================================================================
// MONTHLY REVIEW WORKFLOW
// ============================================================================

const updatePricesAndPerformance = createStep({
  id: 'update-prices-and-performance',
  description: 'Update holding prices and calculate performance',

  inputSchema: z.object({
    portfolioId: z.string().optional(),
  }),

  outputSchema: z.object({
    portfolioId: z.string(),
    currentHoldings: z.array(z.any()),
    totalValue: z.number(),
    periodReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
  }),

  execute: async ({ inputData }) => {
    const portfolioId = inputData?.portfolioId || PORTFOLIO_CONFIG.id;

    const portfolio = await getPortfolio(portfolioId);
    if (!portfolio) {
      throw new Error(`Portfolio ${portfolioId} not found`);
    }

    const holdings = await getHoldings(portfolioId);
    const lastSnapshot = await getLatestSnapshot(portfolioId);

    // Update prices for all holdings
    let holdingsValue = 0;
    for (const holding of holdings) {
      try {
        const price = await fetchCurrentPrice(holding.ticker);
        await updateHoldingPrice(portfolioId, holding.ticker, price);
        holding.currentPrice = price;
        holdingsValue += holding.shares * price;
      } catch (error) {
        console.warn(`Failed to update price for ${holding.ticker}`);
        holdingsValue += holding.shares * (holding.currentPrice || holding.avgCost);
      }
    }

    const totalValue = holdingsValue + portfolio.currentCash;
    const previousValue = lastSnapshot?.totalValue || portfolio.initialCapital;
    const periodReturn = ((totalValue - previousValue) / previousValue) * 100;

    // Get SPY return for comparison
    const startDate = lastSnapshot?.snapshotDate || portfolio.createdAt.split('T')[0];
    const endDate = new Date().toISOString().split('T')[0];
    const spyReturn = await fetchSPYReturn(startDate, endDate);

    const alpha = periodReturn - spyReturn;

    return {
      portfolioId,
      currentHoldings: holdings,
      totalValue,
      periodReturn,
      spyReturn,
      alpha,
    };
  },
});

const scoreCurrentAndCandidates = createStep({
  id: 'score-current-and-candidates',
  description: 'Re-score current holdings and potential replacements',

  inputSchema: z.object({
    portfolioId: z.string(),
    currentHoldings: z.array(z.any()),
    totalValue: z.number(),
    periodReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
  }),

  outputSchema: z.object({
    portfolioId: z.string(),
    currentHoldings: z.array(z.any()),
    totalValue: z.number(),
    periodReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
    holdingScores: z.array(z.any()),
    candidateScores: z.array(z.any()),
  }),

  execute: async ({ inputData, runtimeContext }) => {
    if (!inputData) {
      throw new Error('No input data');
    }

    const currentTickers = inputData.currentHoldings.map((h: Holding) => h.ticker);

    // Score current holdings
    console.log('\nScoring current holdings...');
    const holdingsResult = await scoreStocksBatchTool.execute({
      context: {
        tickers: currentTickers,
        strategy: 'value',
        saveToDb: true,
      },
      runtimeContext,
    });

    // Score potential replacement candidates (non-held S&P 500 stocks)
    // For efficiency, only score a subset of candidates
    const nonHeldTickers = ALL_SP500_TICKERS.filter((t) => !currentTickers.includes(t));
    const candidateSample = nonHeldTickers.slice(0, 50); // Score 50 candidates for efficiency

    console.log('\nScoring replacement candidates...');
    const candidatesResult = await scoreStocksBatchTool.execute({
      context: {
        tickers: candidateSample,
        strategy: 'value',
        limit: 30, // Keep top 30
        saveToDb: true,
      },
      runtimeContext,
    });

    return {
      ...inputData,
      holdingScores: holdingsResult.scores,
      candidateScores: candidatesResult.scores,
    };
  },
});

const identifyTrades = createStep({
  id: 'identify-trades',
  description: 'Identify stocks to buy and sell',

  inputSchema: z.object({
    portfolioId: z.string(),
    currentHoldings: z.array(z.any()),
    totalValue: z.number(),
    periodReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
    holdingScores: z.array(z.any()),
    candidateScores: z.array(z.any()),
  }),

  outputSchema: z.object({
    portfolioId: z.string(),
    totalValue: z.number(),
    periodReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
    sellCandidates: z.array(z.any()),
    buyCandidates: z.array(z.any()),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('No input data');
    }

    const { portfolioId, currentHoldings, holdingScores, candidateScores, totalValue } = inputData;

    // Check monthly transaction count
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthlyTrades = await getMonthlyTransactionCount(portfolioId, currentMonth);
    const remainingTrades = PORTFOLIO_CONFIG.maxMonthlyTurnover - monthlyTrades;

    if (remainingTrades <= 0) {
      console.log('Monthly trade limit reached');
      return {
        portfolioId,
        totalValue: inputData.totalValue,
        periodReturn: inputData.periodReturn,
        spyReturn: inputData.spyReturn,
        alpha: inputData.alpha,
        sellCandidates: [],
        buyCandidates: [],
      };
    }

    // Create score map for current holdings
    const holdingScoreMap = new Map<string, number>();
    for (const score of holdingScores as StockScoreOutput[]) {
      holdingScoreMap.set(score.ticker, score.totalScore);
    }

    // Identify weak holdings (score below threshold or significantly underperforming)
    const scoreThreshold = 45; // Minimum acceptable score
    const sellCandidates: {
      ticker: string;
      shares: number;
      currentPrice: number;
      reason: string;
      score: number;
    }[] = [];

    for (const holding of currentHoldings as Holding[]) {
      const score = holdingScoreMap.get(holding.ticker) || 50;

      if (score < scoreThreshold) {
        sellCandidates.push({
          ticker: holding.ticker,
          shares: holding.shares,
          currentPrice: holding.currentPrice || holding.avgCost,
          reason: `Low score (${score}) below threshold (${scoreThreshold})`,
          score,
        });
      }
    }

    // Sort sells by score (lowest first)
    sellCandidates.sort((a, b) => a.score - b.score);

    // Limit sells based on remaining trades
    const maxSells = Math.min(Math.floor(remainingTrades / 2), sellCandidates.length);
    const finalSells = sellCandidates.slice(0, maxSells);

    // Identify buy candidates from high-scoring non-held stocks
    const currentTickers = new Set((currentHoldings as Holding[]).map((h) => h.ticker));
    const portfolio = await getPortfolio(portfolioId);
    const availableCash =
      (portfolio?.currentCash || 0) + finalSells.reduce((sum, s) => sum + s.shares * s.currentPrice, 0);

    const buyCandidates: {
      ticker: string;
      targetShares: number;
      price: number;
      reason: string;
      score: number;
    }[] = [];

    // Get sector counts for diversification
    const sectorCounts: Record<string, number> = {};
    for (const holding of currentHoldings as Holding[]) {
      const sector = holding.sector || 'Unknown';
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
    }

    // Remove sold stocks from sector counts
    for (const sell of finalSells) {
      const holding = (currentHoldings as Holding[]).find((h) => h.ticker === sell.ticker);
      if (holding?.sector) {
        sectorCounts[holding.sector] = (sectorCounts[holding.sector] || 1) - 1;
      }
    }

    const maxPerSector = Math.ceil(PORTFOLIO_CONFIG.targetHoldings * PORTFOLIO_CONFIG.maxSectorPct);

    for (const candidate of candidateScores as StockScoreOutput[]) {
      if (currentTickers.has(candidate.ticker)) continue;
      if (buyCandidates.length >= finalSells.length) break;

      const sector = candidate.sector || 'Unknown';
      if ((sectorCounts[sector] || 0) >= maxPerSector) continue;

      const targetValue = totalValue * 0.05; // 5% position
      const shares = Math.floor(targetValue / candidate.price);

      if (shares > 0 && shares * candidate.price <= availableCash) {
        buyCandidates.push({
          ticker: candidate.ticker,
          targetShares: shares,
          price: candidate.price,
          reason: `High score (${candidate.totalScore}) - Value: ${candidate.valueScore}, Quality: ${candidate.qualityScore}`,
          score: candidate.totalScore,
        });

        sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
      }
    }

    return {
      portfolioId,
      totalValue: inputData.totalValue,
      periodReturn: inputData.periodReturn,
      spyReturn: inputData.spyReturn,
      alpha: inputData.alpha,
      sellCandidates: finalSells,
      buyCandidates,
    };
  },
});

const executeTrades = createStep({
  id: 'execute-trades',
  description: 'Execute buy and sell orders',

  inputSchema: z.object({
    portfolioId: z.string(),
    totalValue: z.number(),
    periodReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
    sellCandidates: z.array(z.any()),
    buyCandidates: z.array(z.any()),
  }),

  outputSchema: z.object({
    portfolioId: z.string(),
    totalValue: z.number(),
    periodReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
    executedSells: z.array(z.any()),
    executedBuys: z.array(z.any()),
    newCash: z.number(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('No input data');
    }

    const { portfolioId, sellCandidates, buyCandidates } = inputData;

    const portfolio = await getPortfolio(portfolioId);
    if (!portfolio) {
      throw new Error(`Portfolio ${portfolioId} not found`);
    }

    let cash = portfolio.currentCash;
    const executedSells: { ticker: string; shares: number; price: number; proceeds: number }[] = [];
    const executedBuys: { ticker: string; shares: number; price: number; cost: number }[] = [];

    // Execute sells first
    for (const sell of sellCandidates as {
      ticker: string;
      shares: number;
      currentPrice: number;
      reason: string;
      score: number;
    }[]) {
      const proceeds = sell.shares * sell.currentPrice;

      await recordTransaction({
        portfolioId,
        ticker: sell.ticker,
        action: 'SELL',
        shares: sell.shares,
        price: sell.currentPrice,
        totalValue: proceeds,
        reason: sell.reason,
        scoreAtTrade: sell.score,
        analysisId: null,
        screeningRunId: null,
      });

      await removeHolding(portfolioId, sell.ticker);

      cash += proceeds;
      executedSells.push({
        ticker: sell.ticker,
        shares: sell.shares,
        price: sell.currentPrice,
        proceeds,
      });
    }

    // Execute buys
    for (const buy of buyCandidates as {
      ticker: string;
      targetShares: number;
      price: number;
      reason: string;
      score: number;
    }[]) {
      const cost = buy.targetShares * buy.price;

      if (cost > cash) {
        console.warn(`Insufficient cash for ${buy.ticker}, skipping`);
        continue;
      }

      await recordTransaction({
        portfolioId,
        ticker: buy.ticker,
        action: 'BUY',
        shares: buy.targetShares,
        price: buy.price,
        totalValue: cost,
        reason: buy.reason,
        scoreAtTrade: buy.score,
        analysisId: null,
        screeningRunId: null,
      });

      await addHolding({
        portfolioId,
        ticker: buy.ticker,
        shares: buy.targetShares,
        avgCost: buy.price,
        currentPrice: buy.price,
        sector: getSectorForTicker(buy.ticker),
        convictionScore: null,
        convictionLevel: null,
        lastAnalysisId: null,
        lastAnalysisDate: null,
      });

      cash -= cost;
      executedBuys.push({
        ticker: buy.ticker,
        shares: buy.targetShares,
        price: buy.price,
        cost,
      });
    }

    // Update portfolio cash
    await updatePortfolioCash(portfolioId, cash);

    return {
      portfolioId,
      totalValue: inputData.totalValue,
      periodReturn: inputData.periodReturn,
      spyReturn: inputData.spyReturn,
      alpha: inputData.alpha,
      executedSells,
      executedBuys,
      newCash: cash,
    };
  },
});

const createMonthlySnapshot = createStep({
  id: 'create-monthly-snapshot',
  description: 'Create monthly performance snapshot',

  inputSchema: z.object({
    portfolioId: z.string(),
    totalValue: z.number(),
    periodReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
    executedSells: z.array(z.any()),
    executedBuys: z.array(z.any()),
    newCash: z.number(),
  }),

  outputSchema: z.object({
    portfolioId: z.string(),
    snapshotDate: z.string(),
    totalValue: z.number(),
    periodReturn: z.number(),
    cumulativeReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
    tradesExecuted: z.number(),
    report: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('No input data');
    }

    const { portfolioId, periodReturn, spyReturn, alpha, executedSells, executedBuys, newCash } = inputData;

    const portfolio = await getPortfolio(portfolioId);
    const holdings = await getHoldings(portfolioId);
    const lastSnapshot = await getLatestSnapshot(portfolioId);

    if (!portfolio) {
      throw new Error(`Portfolio ${portfolioId} not found`);
    }

    // Calculate holdings value
    let holdingsValue = 0;
    const holdingsData: HoldingSnapshot[] = [];

    for (const holding of holdings) {
      const value = holding.shares * (holding.currentPrice || holding.avgCost);
      holdingsValue += value;

      const gainPct = ((holding.currentPrice || holding.avgCost) - holding.avgCost) / holding.avgCost * 100;

      holdingsData.push({
        ticker: holding.ticker,
        shares: holding.shares,
        price: holding.currentPrice || holding.avgCost,
        value,
        weight: 0, // Will calculate after total
        sector: holding.sector || 'Unknown',
        gainPct,
      });
    }

    const totalValue = holdingsValue + newCash;

    // Update weights
    for (const h of holdingsData) {
      h.weight = h.value / totalValue;
    }

    // Calculate cumulative return
    const cumulativeReturn = ((totalValue - portfolio.initialCapital) / portfolio.initialCapital) * 100;
    const spyCumulativeReturn = (lastSnapshot?.spyCumulativeReturnPct || 0) + spyReturn;

    const snapshotDate = new Date().toISOString().split('T')[0];

    await createSnapshot({
      portfolioId,
      snapshotDate,
      totalValue,
      cashValue: newCash,
      holdingsValue,
      holdingsCount: holdings.length,
      periodReturnPct: periodReturn,
      cumulativeReturnPct: cumulativeReturn,
      spyPeriodReturnPct: spyReturn,
      spyCumulativeReturnPct: spyCumulativeReturn,
      alphaPct: cumulativeReturn - spyCumulativeReturn,
      holdingsData,
    });

    // Generate report
    const prompt = `Generate monthly review report:

Portfolio: ${portfolio.name}
Date: ${snapshotDate}

Performance:
- Period Return: ${periodReturn.toFixed(2)}%
- Cumulative Return: ${cumulativeReturn.toFixed(2)}%
- SPY Period Return: ${spyReturn.toFixed(2)}%
- Alpha: ${alpha.toFixed(2)}%

Portfolio Value: $${totalValue.toFixed(2)}
Cash: $${newCash.toFixed(2)}
Holdings: ${holdings.length}

Trades This Month:
Sells (${executedSells.length}):
${executedSells.map((s: { ticker: string; shares: number; price: number; proceeds: number }) => `- ${s.ticker}: ${s.shares} shares @ $${s.price.toFixed(2)} = $${s.proceeds.toFixed(2)}`).join('\n') || 'None'}

Buys (${executedBuys.length}):
${executedBuys.map((b: { ticker: string; shares: number; price: number; cost: number }) => `- ${b.ticker}: ${b.shares} shares @ $${b.price.toFixed(2)} = $${b.cost.toFixed(2)}`).join('\n') || 'None'}

Current Holdings:
${holdingsData.slice(0, 10).map((h) => `- ${h.ticker}: $${h.value.toFixed(0)} (${(h.weight * 100).toFixed(1)}%) ${h.gainPct >= 0 ? '+' : ''}${h.gainPct.toFixed(1)}%`).join('\n')}
${holdingsData.length > 10 ? `... and ${holdingsData.length - 10} more` : ''}`;

    const response = await monthlyReviewAgent.streamLegacy([
      { role: 'user', content: prompt },
    ]);

    let report = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      report += chunk;
    }

    return {
      portfolioId,
      snapshotDate,
      totalValue,
      periodReturn,
      cumulativeReturn,
      spyReturn,
      alpha,
      tradesExecuted: executedSells.length + executedBuys.length,
      report,
    };
  },
});

// ============================================================================
// WORKFLOW DEFINITIONS
// ============================================================================

export const portfolioConstructionWorkflow = createWorkflow({
  id: 'portfolio-construction-workflow',

  inputSchema: z.object({
    universe: z.array(z.string()).optional().describe('Stock universe to screen (defaults to S&P 500)'),
    sampleSize: z.number().optional().describe('For testing: limit screening to sample size'),
  }),

  outputSchema: z.object({
    report: z.string(),
  }),
})
  .then(screenAndScoreStocks)
  .then(selectPortfolioStocks)
  .then(createInitialPortfolio)
  .then(synthesizeConstruction);

portfolioConstructionWorkflow.commit();

export const monthlyReviewWorkflow = createWorkflow({
  id: 'monthly-review-workflow',

  inputSchema: z.object({
    portfolioId: z.string().optional().describe('Portfolio ID to review (defaults to main portfolio)'),
  }),

  outputSchema: z.object({
    portfolioId: z.string(),
    snapshotDate: z.string(),
    totalValue: z.number(),
    periodReturn: z.number(),
    cumulativeReturn: z.number(),
    spyReturn: z.number(),
    alpha: z.number(),
    tradesExecuted: z.number(),
    report: z.string(),
  }),
})
  .then(updatePricesAndPerformance)
  .then(scoreCurrentAndCandidates)
  .then(identifyTrades)
  .then(executeTrades)
  .then(createMonthlySnapshot);

monthlyReviewWorkflow.commit();

// ============================================================================
// END OF OPTIMIZER WORKFLOWS
// ============================================================================
