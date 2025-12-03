// ============================================================================
// PORTFOLIO OPTIMIZER TOOLS
// ============================================================================
// Tools for scoring and ranking stocks based on multi-factor analysis.
// Uses a weighted scoring system optimized for value investing.
//
// SCORING WEIGHTS (Value Strategy):
// - Value:    40% (P/E, P/B, dividend yield)
// - Quality:  30% (profit margin, ROE, current ratio)
// - Risk:     15% (beta, volatility)
// - Growth:   10% (revenue growth, earnings growth)
// - Momentum:  5% (52-week performance)
//
// TOOLS:
// - scoreStockTool: Score a single stock
// - scoreStocksBatchTool: Score multiple stocks with rate limiting
// - rankStocksTool: Rank stocks by their scores
// ============================================================================

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

import { RateLimiter, yahooFinanceRateLimiter } from '../lib/rate-limiter';
import { getSectorForTicker } from '../data/sp500-stocks';
import { saveStockScore, saveStockScoresBatch } from '../db/portfolio-repository';
import { StockScore } from '../db/schema';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ============================================================================
// SCORING CONFIGURATION
// ============================================================================

export interface ScoringWeights {
  value: number;
  quality: number;
  risk: number;
  growth: number;
  momentum: number;
}

export const VALUE_STRATEGY_WEIGHTS: ScoringWeights = {
  value: 0.4, // 40%
  quality: 0.3, // 30%
  risk: 0.15, // 15%
  growth: 0.1, // 10%
  momentum: 0.05, // 5%
};

export const GROWTH_STRATEGY_WEIGHTS: ScoringWeights = {
  value: 0.15, // 15%
  quality: 0.2, // 20%
  risk: 0.1, // 10%
  growth: 0.4, // 40%
  momentum: 0.15, // 15%
};

export const BALANCED_STRATEGY_WEIGHTS: ScoringWeights = {
  value: 0.25, // 25%
  quality: 0.25, // 25%
  risk: 0.2, // 20%
  growth: 0.2, // 20%
  momentum: 0.1, // 10%
};

// ============================================================================
// SCORING HELPER FUNCTIONS
// ============================================================================

/**
 * Normalize a value to 0-100 scale based on percentile ranking
 * Lower is better for: P/E, P/B, beta (inverted)
 * Higher is better for: dividend yield, margins, growth
 */
function normalizeScore(value: number | null, min: number, max: number, invert: boolean = false): number {
  if (value === null || value === undefined || isNaN(value)) {
    return 50; // Neutral score for missing data
  }

  // Clamp value to range
  const clamped = Math.max(min, Math.min(max, value));

  // Calculate position in range (0-1)
  let normalized = (clamped - min) / (max - min);

  // Invert if lower is better
  if (invert) {
    normalized = 1 - normalized;
  }

  return Math.round(normalized * 100);
}

/**
 * Calculate value score (lower P/E, P/B = better value)
 * Note: Companies with losses (NULL or negative P/E) are penalized
 * as they don't have traditional "value" characteristics.
 */
function calculateValueScore(peRatio: number | null, pbRatio: number | null, dividendYield: number | null): number {
  // P/E scoring:
  // - NULL P/E (loss-making company): Score 20 (penalized - no earnings)
  // - Negative P/E: Score 10 (heavily penalized)
  // - P/E 5-50 range: normalized, lower is better
  // - P/E > 50: Score approaches 0 (overvalued)
  let peScore: number;
  if (peRatio === null || peRatio === undefined || isNaN(peRatio)) {
    peScore = 20; // Loss-making companies get low value score
  } else if (peRatio <= 0) {
    peScore = 10; // Negative P/E is worse
  } else {
    peScore = normalizeScore(peRatio, 5, 50, true);
  }

  // P/B: 0.5-10 range, lower is better
  const pbScore = normalizeScore(pbRatio, 0.5, 10, true);

  // Dividend yield: 0-6% range, higher is better
  const divScore = normalizeScore(dividendYield, 0, 6, false);

  // Weight: P/E most important for value
  return Math.round(peScore * 0.5 + pbScore * 0.3 + divScore * 0.2);
}

/**
 * Calculate quality score (profitability and financial health)
 */
function calculateQualityScore(
  profitMargin: number | null,
  roe: number | null,
  currentRatio: number | null
): number {
  // Profit margin: 0-30% range, higher is better
  const marginScore = normalizeScore(profitMargin, 0, 30, false);

  // ROE: 0-30% range, higher is better
  const roeScore = normalizeScore(roe, 0, 30, false);

  // Current ratio: 0.5-3 range, higher is better (but too high is also bad)
  // Sweet spot around 1.5-2.0
  let currentRatioScore = 50;
  if (currentRatio !== null && !isNaN(currentRatio)) {
    if (currentRatio >= 1.0 && currentRatio <= 3.0) {
      currentRatioScore = normalizeScore(currentRatio, 0.5, 2.5, false);
    } else if (currentRatio < 1.0) {
      currentRatioScore = normalizeScore(currentRatio, 0, 1.0, false) * 0.5; // Penalize low
    } else {
      currentRatioScore = 70; // Too high is inefficient but not terrible
    }
  }

  return Math.round(marginScore * 0.4 + roeScore * 0.4 + currentRatioScore * 0.2);
}

/**
 * Calculate risk score (lower beta, lower volatility = better)
 */
function calculateRiskScore(beta: number | null): number {
  // Beta: 0-2 range, lower is better for risk-adjusted returns
  // Beta 1 = market risk, < 1 = less volatile, > 1 = more volatile
  return normalizeScore(beta, 0.5, 2.0, true);
}

/**
 * Calculate growth score
 */
function calculateGrowthScore(revenueGrowth: number | null, earningsGrowth: number | null): number {
  // Revenue growth: -10% to 50% range
  const revScore = normalizeScore(revenueGrowth, -10, 50, false);

  // Earnings growth: -20% to 100% range
  const epsScore = normalizeScore(earningsGrowth, -20, 100, false);

  return Math.round(revScore * 0.5 + epsScore * 0.5);
}

/**
 * Calculate momentum score
 */
function calculateMomentumScore(fiftyTwoWeekChange: number | null): number {
  // 52-week change: -50% to 100% range
  return normalizeScore(fiftyTwoWeekChange, -50, 100, false);
}

/**
 * Calculate total weighted score
 */
function calculateTotalScore(
  valueScore: number,
  qualityScore: number,
  riskScore: number,
  growthScore: number,
  momentumScore: number,
  weights: ScoringWeights = VALUE_STRATEGY_WEIGHTS
): number {
  return Math.round(
    valueScore * weights.value +
      qualityScore * weights.quality +
      riskScore * weights.risk +
      growthScore * weights.growth +
      momentumScore * weights.momentum
  );
}

// ============================================================================
// DATA FETCHING
// ============================================================================

interface StockData {
  ticker: string;
  companyName: string;
  sector: string | null;
  price: number;
  marketCap: number;
  peRatio: number | null;
  pbRatio: number | null;
  psRatio: number | null;
  dividendYield: number | null;
  profitMargin: number | null;
  roe: number | null;
  currentRatio: number | null;
  debtToEquity: number | null;
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  beta: number | null;
  fiftyTwoWeekChange: number | null;
}

async function fetchStockData(ticker: string): Promise<StockData> {
  const [quote, summary] = await Promise.all([
    yf.quote(ticker),
    yf.quoteSummary(ticker, { modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail'] }),
  ]);

  const financialData = summary.financialData || ({} as Record<string, unknown>);
  const keyStats = summary.defaultKeyStatistics || ({} as Record<string, unknown>);
  const summaryDetail = summary.summaryDetail || ({} as Record<string, unknown>);

  return {
    ticker,
    companyName: (quote.longName || quote.shortName || ticker) as string,
    sector: getSectorForTicker(ticker),
    price: (quote.regularMarketPrice as number) || 0,
    marketCap: (quote.marketCap as number) || 0,
    peRatio: (quote.trailingPE as number) ?? null,
    pbRatio: (keyStats.priceToBook as number) ?? null,
    psRatio: (summaryDetail.priceToSalesTrailing12Months as number) ?? null,
    dividendYield: quote.dividendYield ? (quote.dividendYield as number) * 100 : null,
    profitMargin: (financialData as Record<string, unknown>).profitMargins
      ? ((financialData as Record<string, number>).profitMargins as number) * 100
      : null,
    roe: (financialData as Record<string, number>).returnOnEquity
      ? ((financialData as Record<string, number>).returnOnEquity as number) * 100
      : null,
    currentRatio: ((financialData as Record<string, number>).currentRatio as number) ?? null,
    debtToEquity: ((financialData as Record<string, number>).debtToEquity as number) ?? null,
    revenueGrowth: (financialData as Record<string, number>).revenueGrowth
      ? ((financialData as Record<string, number>).revenueGrowth as number) * 100
      : null,
    earningsGrowth: (financialData as Record<string, number>).earningsGrowth
      ? ((financialData as Record<string, number>).earningsGrowth as number) * 100
      : null,
    beta: ((quote.beta as number) || (keyStats.beta as number)) ?? null,
    fiftyTwoWeekChange: (quote.fiftyTwoWeekChangePercent as number)
      ? (quote.fiftyTwoWeekChangePercent as number) * 100
      : null,
  };
}

// ============================================================================
// SCORE STOCK TOOL
// ============================================================================

const stockScoreOutputSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  sector: z.string().nullable(),
  price: z.number(),
  marketCap: z.number(),

  // Component scores (0-100)
  valueScore: z.number(),
  qualityScore: z.number(),
  riskScore: z.number(),
  growthScore: z.number(),
  momentumScore: z.number(),

  // Weighted total score (0-100)
  totalScore: z.number(),

  // Raw metrics used for scoring
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
});

export type StockScoreOutput = z.infer<typeof stockScoreOutputSchema>;

export const scoreStockTool = createTool({
  id: 'score-stock',
  description:
    'Score a single stock using multi-factor analysis (value, quality, risk, growth, momentum). Returns component scores and weighted total score.',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
    strategy: z
      .enum(['value', 'growth', 'balanced'])
      .optional()
      .default('value')
      .describe('Scoring strategy to use'),
    saveToDb: z.boolean().optional().default(false).describe('Save score to database'),
  }),

  outputSchema: stockScoreOutputSchema,

  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    const strategy = context.strategy || 'value';
    const saveToDb = context.saveToDb || false;

    // Select weights based on strategy
    const weights =
      strategy === 'growth'
        ? GROWTH_STRATEGY_WEIGHTS
        : strategy === 'balanced'
          ? BALANCED_STRATEGY_WEIGHTS
          : VALUE_STRATEGY_WEIGHTS;

    // Fetch stock data
    const data = await fetchStockData(ticker);

    // Calculate component scores
    const valueScore = calculateValueScore(data.peRatio, data.pbRatio, data.dividendYield);
    const qualityScore = calculateQualityScore(data.profitMargin, data.roe, data.currentRatio);
    const riskScore = calculateRiskScore(data.beta);
    const growthScore = calculateGrowthScore(data.revenueGrowth, data.earningsGrowth);
    const momentumScore = calculateMomentumScore(data.fiftyTwoWeekChange);

    // Calculate total weighted score
    const totalScore = calculateTotalScore(valueScore, qualityScore, riskScore, growthScore, momentumScore, weights);

    const result: StockScoreOutput = {
      ticker,
      companyName: data.companyName,
      sector: data.sector,
      price: data.price,
      marketCap: data.marketCap,
      valueScore,
      qualityScore,
      riskScore,
      growthScore,
      momentumScore,
      totalScore,
      metrics: {
        peRatio: data.peRatio,
        pbRatio: data.pbRatio,
        psRatio: data.psRatio,
        dividendYield: data.dividendYield,
        profitMargin: data.profitMargin,
        roe: data.roe,
        currentRatio: data.currentRatio,
        debtToEquity: data.debtToEquity,
        revenueGrowth: data.revenueGrowth,
        earningsGrowth: data.earningsGrowth,
        beta: data.beta,
        fiftyTwoWeekChange: data.fiftyTwoWeekChange,
      },
    };

    // Save to database if requested
    if (saveToDb) {
      const scoreDate = new Date().toISOString().split('T')[0];
      await saveStockScore({
        ticker,
        scoreDate,
        totalScore,
        valueScore,
        qualityScore,
        growthScore,
        momentumScore,
        riskScore,
        peRatio: data.peRatio,
        pbRatio: data.pbRatio,
        dividendYield: data.dividendYield,
        revenueGrowth: data.revenueGrowth,
        profitMargin: data.profitMargin,
        beta: data.beta,
        marketCap: data.marketCap,
        sector: data.sector,
        rawData: data as unknown as Record<string, unknown>,
      });
    }

    return result;
  },
});

// ============================================================================
// SCORE STOCKS BATCH TOOL
// ============================================================================

export const scoreStocksBatchTool = createTool({
  id: 'score-stocks-batch',
  description:
    'Score multiple stocks with rate limiting. Returns ranked list of scores. Use this for screening large universes.',

  inputSchema: z.object({
    tickers: z.array(z.string()).describe('Array of stock ticker symbols'),
    strategy: z
      .enum(['value', 'growth', 'balanced'])
      .optional()
      .default('value')
      .describe('Scoring strategy'),
    limit: z.number().optional().describe('Maximum number of results to return'),
    saveToDb: z.boolean().optional().default(false).describe('Save scores to database'),
  }),

  outputSchema: z.object({
    scores: z.array(stockScoreOutputSchema),
    totalProcessed: z.number(),
    successCount: z.number(),
    failedTickers: z.array(z.string()),
    processingTimeSeconds: z.number(),
  }),

  execute: async ({ context }) => {
    const tickers = context.tickers.map((t) => t.toUpperCase());
    const strategy = context.strategy || 'value';
    const saveToDb = context.saveToDb || false;

    const weights =
      strategy === 'growth'
        ? GROWTH_STRATEGY_WEIGHTS
        : strategy === 'balanced'
          ? BALANCED_STRATEGY_WEIGHTS
          : VALUE_STRATEGY_WEIGHTS;

    const startTime = Date.now();
    const scores: StockScoreOutput[] = [];
    const failedTickers: string[] = [];
    const scoresToSave: Omit<StockScore, 'id' | 'createdAt'>[] = [];
    const scoreDate = new Date().toISOString().split('T')[0];

    console.log(`Scoring ${tickers.length} stocks with ${strategy} strategy...`);

    // Process with rate limiting
    const results = await yahooFinanceRateLimiter.executeBatch(
      tickers,
      async (ticker) => {
        const data = await fetchStockData(ticker);

        const valueScore = calculateValueScore(data.peRatio, data.pbRatio, data.dividendYield);
        const qualityScore = calculateQualityScore(data.profitMargin, data.roe, data.currentRatio);
        const riskScore = calculateRiskScore(data.beta);
        const growthScore = calculateGrowthScore(data.revenueGrowth, data.earningsGrowth);
        const momentumScore = calculateMomentumScore(data.fiftyTwoWeekChange);
        const totalScore = calculateTotalScore(valueScore, qualityScore, riskScore, growthScore, momentumScore, weights);

        return {
          ticker,
          companyName: data.companyName,
          sector: data.sector,
          price: data.price,
          marketCap: data.marketCap,
          valueScore,
          qualityScore,
          riskScore,
          growthScore,
          momentumScore,
          totalScore,
          metrics: {
            peRatio: data.peRatio,
            pbRatio: data.pbRatio,
            psRatio: data.psRatio,
            dividendYield: data.dividendYield,
            profitMargin: data.profitMargin,
            roe: data.roe,
            currentRatio: data.currentRatio,
            debtToEquity: data.debtToEquity,
            revenueGrowth: data.revenueGrowth,
            earningsGrowth: data.earningsGrowth,
            beta: data.beta,
            fiftyTwoWeekChange: data.fiftyTwoWeekChange,
          },
          _rawData: data,
        };
      },
      {
        onProgress: (completed, total) => {
          process.stdout.write(`\rProgress: ${completed}/${total} (${Math.round((completed / total) * 100)}%)`);
        },
        onError: (ticker, error) => {
          console.warn(`\nFailed to score ${ticker}: ${error.message}`);
          failedTickers.push(ticker);
        },
      }
    );

    console.log('\n');

    // Process results
    for (const [ticker, result] of results) {
      if (!(result instanceof Error)) {
        const { _rawData, ...scoreOutput } = result as StockScoreOutput & { _rawData: StockData };
        scores.push(scoreOutput);

        if (saveToDb) {
          scoresToSave.push({
            ticker,
            scoreDate,
            totalScore: scoreOutput.totalScore,
            valueScore: scoreOutput.valueScore,
            qualityScore: scoreOutput.qualityScore,
            growthScore: scoreOutput.growthScore,
            momentumScore: scoreOutput.momentumScore,
            riskScore: scoreOutput.riskScore,
            peRatio: scoreOutput.metrics.peRatio,
            pbRatio: scoreOutput.metrics.pbRatio,
            dividendYield: scoreOutput.metrics.dividendYield,
            revenueGrowth: scoreOutput.metrics.revenueGrowth,
            profitMargin: scoreOutput.metrics.profitMargin,
            beta: scoreOutput.metrics.beta,
            marketCap: scoreOutput.marketCap,
            sector: scoreOutput.sector,
            rawData: _rawData as unknown as Record<string, unknown>,
          });
        }
      }
    }

    // Save to database if requested
    if (saveToDb && scoresToSave.length > 0) {
      await saveStockScoresBatch(scoresToSave);
      console.log(`Saved ${scoresToSave.length} scores to database`);
    }

    // Sort by total score descending
    scores.sort((a, b) => b.totalScore - a.totalScore);

    // Apply limit if specified
    const limitedScores = context.limit ? scores.slice(0, context.limit) : scores;

    const processingTimeSeconds = Math.round((Date.now() - startTime) / 1000);

    return {
      scores: limitedScores,
      totalProcessed: tickers.length,
      successCount: scores.length,
      failedTickers,
      processingTimeSeconds,
    };
  },
});

// ============================================================================
// RANK STOCKS TOOL
// ============================================================================

export const rankStocksTool = createTool({
  id: 'rank-stocks',
  description:
    'Rank pre-scored stocks by total score and apply sector diversification constraints.',

  inputSchema: z.object({
    scores: z.array(stockScoreOutputSchema).describe('Array of stock scores to rank'),
    targetCount: z.number().default(20).describe('Target number of stocks to select'),
    maxSectorPct: z.number().default(0.25).describe('Maximum weight per sector (0.25 = 25%)'),
    minScore: z.number().default(50).describe('Minimum total score to consider'),
  }),

  outputSchema: z.object({
    rankedStocks: z.array(
      stockScoreOutputSchema.extend({
        rank: z.number(),
        suggestedWeight: z.number(),
      })
    ),
    sectorBreakdown: z.record(z.number()),
    excludedCount: z.number(),
    excludedReasons: z.record(z.number()),
  }),

  execute: async ({ context }) => {
    const { scores, targetCount, maxSectorPct, minScore } = context;

    // Filter by minimum score
    const qualifiedStocks = scores.filter((s) => s.totalScore >= minScore);
    const excludedLowScore = scores.length - qualifiedStocks.length;

    // Sort by total score
    qualifiedStocks.sort((a, b) => b.totalScore - a.totalScore);

    // Apply sector constraints
    const sectorCounts: Record<string, number> = {};
    const maxPerSector = Math.ceil(targetCount * maxSectorPct);
    const selectedStocks: (StockScoreOutput & { rank: number; suggestedWeight: number })[] = [];
    let excludedSectorLimit = 0;

    for (const stock of qualifiedStocks) {
      if (selectedStocks.length >= targetCount) break;

      const sector = stock.sector || 'Unknown';
      const currentSectorCount = sectorCounts[sector] || 0;

      if (currentSectorCount >= maxPerSector) {
        excludedSectorLimit++;
        continue;
      }

      sectorCounts[sector] = currentSectorCount + 1;
      selectedStocks.push({
        ...stock,
        rank: selectedStocks.length + 1,
        suggestedWeight: 0, // Will calculate below
      });
    }

    // Calculate suggested weights (equal weight adjusted by score)
    if (selectedStocks.length > 0) {
      const totalScoreSum = selectedStocks.reduce((sum, s) => sum + s.totalScore, 0);
      for (const stock of selectedStocks) {
        // Base equal weight with slight adjustment for score
        const baseWeight = 1 / selectedStocks.length;
        const scoreAdjustment = (stock.totalScore / totalScoreSum) * 0.2; // 20% score-based adjustment
        stock.suggestedWeight = Math.round((baseWeight + scoreAdjustment) * 1000) / 1000;
      }

      // Normalize weights to sum to 1
      const totalWeight = selectedStocks.reduce((sum, s) => sum + s.suggestedWeight, 0);
      for (const stock of selectedStocks) {
        stock.suggestedWeight = Math.round((stock.suggestedWeight / totalWeight) * 1000) / 1000;
      }
    }

    return {
      rankedStocks: selectedStocks,
      sectorBreakdown: sectorCounts,
      excludedCount: excludedLowScore + excludedSectorLimit,
      excludedReasons: {
        lowScore: excludedLowScore,
        sectorLimit: excludedSectorLimit,
      },
    };
  },
});

// ============================================================================
// END OF OPTIMIZER TOOLS
// ============================================================================
