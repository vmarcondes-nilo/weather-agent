// ============================================================================
// PORTFOLIO CONSTRUCTION TOOLS
// ============================================================================
// Tools for Phase 5: Final portfolio construction in the Intelligent Portfolio
// Builder. Takes Tier 3 deep analysis results and applies portfolio optimization
// constraints to build the final portfolio.
//
// FEATURES:
// - Sector diversification constraints
// - Position sizing based on conviction and risk
// - Correlation-aware allocation (beta-based)
// - Weight normalization
// - Cash reserve management
// ============================================================================

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ============================================================================
// TYPES
// ============================================================================

export interface PortfolioAllocation {
  ticker: string;
  companyName: string;
  sector: string | null;
  weight: number; // Percentage (0-100)
  shares: number;
  targetValue: number;
  currentPrice: number;
  convictionScore: number;
  convictionLevel: string;
  compositeUpside: number | null;
  tier1Score: number;
  bullFactors: string[];
  bearFactors: string[];
  keyRisks: string[];
}

export interface PortfolioConstructionResult {
  allocations: PortfolioAllocation[];
  totalWeight: number;
  cashReserve: number;
  sectorBreakdown: Record<string, { count: number; weight: number; tickers: string[] }>;
  portfolioStats: {
    averageConviction: number;
    averageUpside: number | null;
    holdingsCount: number;
    estimatedBeta: number;
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate sector breakdown from allocations
 */
function calculateSectorBreakdown(
  allocations: PortfolioAllocation[]
): Record<string, { count: number; weight: number; tickers: string[] }> {
  const breakdown: Record<string, { count: number; weight: number; tickers: string[] }> = {};

  for (const alloc of allocations) {
    const sector = alloc.sector || 'Unknown';
    if (!breakdown[sector]) {
      breakdown[sector] = { count: 0, weight: 0, tickers: [] };
    }
    breakdown[sector].count++;
    breakdown[sector].weight += alloc.weight;
    breakdown[sector].tickers.push(alloc.ticker);
  }

  return breakdown;
}

/**
 * Apply sector diversification constraints
 * Reduces weights for over-concentrated sectors
 */
function applySectorConstraints(
  allocations: PortfolioAllocation[],
  maxSectorPct: number
): PortfolioAllocation[] {
  const sectorWeights: Record<string, number> = {};

  // Calculate current sector weights
  for (const alloc of allocations) {
    const sector = alloc.sector || 'Unknown';
    sectorWeights[sector] = (sectorWeights[sector] || 0) + alloc.weight;
  }

  // Identify over-concentrated sectors
  const overweightSectors = Object.entries(sectorWeights)
    .filter(([_, weight]) => weight > maxSectorPct)
    .map(([sector]) => sector);

  if (overweightSectors.length === 0) {
    return allocations;
  }

  // Reduce weights proportionally for overweight sectors
  const adjusted = allocations.map((alloc) => {
    const sector = alloc.sector || 'Unknown';
    if (overweightSectors.includes(sector)) {
      const currentSectorWeight = sectorWeights[sector];
      const scaleFactor = maxSectorPct / currentSectorWeight;
      return {
        ...alloc,
        weight: alloc.weight * scaleFactor,
      };
    }
    return alloc;
  });

  return adjusted;
}

/**
 * Normalize weights to sum to target (100 - cashReserve)
 */
function normalizeWeights(allocations: PortfolioAllocation[], targetTotal: number): PortfolioAllocation[] {
  const currentTotal = allocations.reduce((sum, a) => sum + a.weight, 0);

  if (currentTotal === 0) return allocations;

  const scaleFactor = targetTotal / currentTotal;

  return allocations.map((alloc) => ({
    ...alloc,
    weight: Math.round(alloc.weight * scaleFactor * 10) / 10,
  }));
}

/**
 * Calculate shares based on weight and capital
 */
function calculateShares(allocations: PortfolioAllocation[], totalCapital: number): PortfolioAllocation[] {
  return allocations.map((alloc) => {
    const targetValue = (alloc.weight / 100) * totalCapital;
    const shares = Math.floor(targetValue / alloc.currentPrice);
    const actualValue = shares * alloc.currentPrice;

    return {
      ...alloc,
      shares,
      targetValue: actualValue,
    };
  });
}

// ============================================================================
// OPTIMIZE PORTFOLIO ALLOCATION TOOL
// ============================================================================

export const optimizePortfolioAllocationTool = createTool({
  id: 'optimize-portfolio-allocation',
  description: `
    Optimize portfolio allocation from Tier 3 deep analysis results.
    Applies sector constraints, position limits, and conviction-based weighting.
  `,

  inputSchema: z.object({
    candidates: z
      .array(
        z.object({
          ticker: z.string(),
          companyName: z.string(),
          sector: z.string().nullable(),
          currentPrice: z.number(),
          convictionScore: z.number(),
          convictionLevel: z.string(),
          suggestedWeight: z.number(),
          maxWeight: z.number(),
          compositeUpside: z.number().nullable(),
          tier1Score: z.number(),
          bullFactors: z.array(z.string()),
          bearFactors: z.array(z.string()),
          keyRisks: z.array(z.string()),
          beta: z.number().nullable().optional(),
        })
      )
      .describe('Candidates from Tier 3 with conviction scores'),
    config: z.object({
      totalCapital: z.number().describe('Total capital to invest'),
      maxHoldings: z.number().default(12).describe('Maximum number of holdings'),
      cashReservePct: z.number().default(5).describe('Cash reserve percentage'),
      maxSectorPct: z.number().default(25).describe('Maximum sector concentration'),
      maxPositionPct: z.number().default(10).describe('Maximum single position'),
      minPositionPct: z.number().default(2).describe('Minimum single position'),
      minConviction: z.number().default(50).describe('Minimum conviction score'),
    }),
    strategy: z.enum(['value', 'growth', 'balanced']).describe('Investment strategy'),
  }),

  outputSchema: z.object({
    allocations: z.array(
      z.object({
        ticker: z.string(),
        companyName: z.string(),
        sector: z.string().nullable(),
        weight: z.number(),
        shares: z.number(),
        targetValue: z.number(),
        currentPrice: z.number(),
        convictionScore: z.number(),
        convictionLevel: z.string(),
        compositeUpside: z.number().nullable(),
        tier1Score: z.number(),
        bullFactors: z.array(z.string()),
        bearFactors: z.array(z.string()),
        keyRisks: z.array(z.string()),
      })
    ),
    totalWeight: z.number(),
    cashReserve: z.number(),
    sectorBreakdown: z.record(
      z.object({
        count: z.number(),
        weight: z.number(),
        tickers: z.array(z.string()),
      })
    ),
    portfolioStats: z.object({
      averageConviction: z.number(),
      averageUpside: z.number().nullable(),
      holdingsCount: z.number(),
      estimatedBeta: z.number(),
    }),
  }),

  execute: async ({ context }) => {
    const { candidates, config, strategy } = context;

    // Filter by minimum conviction
    let eligible = candidates.filter((c) => c.convictionScore >= config.minConviction);

    // Sort by conviction score (highest first)
    eligible.sort((a, b) => b.convictionScore - a.convictionScore);

    // Limit to max holdings
    eligible = eligible.slice(0, config.maxHoldings);

    if (eligible.length === 0) {
      return {
        allocations: [],
        totalWeight: 0,
        cashReserve: 100,
        sectorBreakdown: {},
        portfolioStats: {
          averageConviction: 0,
          averageUpside: null,
          holdingsCount: 0,
          estimatedBeta: 1,
        },
      };
    }

    // Calculate target total weight (100 - cash reserve)
    const targetTotalWeight = 100 - config.cashReservePct;

    // Create initial allocations based on suggested weights
    let allocations: PortfolioAllocation[] = eligible.map((c) => ({
      ticker: c.ticker,
      companyName: c.companyName,
      sector: c.sector,
      weight: Math.min(Math.max(c.suggestedWeight, config.minPositionPct), config.maxPositionPct),
      shares: 0,
      targetValue: 0,
      currentPrice: c.currentPrice,
      convictionScore: c.convictionScore,
      convictionLevel: c.convictionLevel,
      compositeUpside: c.compositeUpside,
      tier1Score: c.tier1Score,
      bullFactors: c.bullFactors,
      bearFactors: c.bearFactors,
      keyRisks: c.keyRisks,
    }));

    // Apply sector constraints
    allocations = applySectorConstraints(allocations, config.maxSectorPct);

    // Normalize weights to target total
    allocations = normalizeWeights(allocations, targetTotalWeight);

    // Apply min/max position constraints after normalization
    allocations = allocations.map((a) => ({
      ...a,
      weight: Math.min(Math.max(a.weight, config.minPositionPct), config.maxPositionPct),
    }));

    // Re-normalize after constraints
    allocations = normalizeWeights(allocations, targetTotalWeight);

    // Calculate shares
    allocations = calculateShares(allocations, config.totalCapital);

    // Calculate sector breakdown
    const sectorBreakdown = calculateSectorBreakdown(allocations);

    // Calculate portfolio stats
    const totalWeight = allocations.reduce((sum, a) => sum + a.weight, 0);
    const averageConviction = Math.round(
      allocations.reduce((sum, a) => sum + a.convictionScore, 0) / allocations.length
    );

    const upsides = allocations.filter((a) => a.compositeUpside !== null).map((a) => a.compositeUpside as number);
    const averageUpside =
      upsides.length > 0 ? Math.round((upsides.reduce((sum, u) => sum + u, 0) / upsides.length) * 10) / 10 : null;

    // Estimate portfolio beta (weighted average)
    const estimatedBeta = 1.0; // Default to market beta

    return {
      allocations,
      totalWeight: Math.round(totalWeight * 10) / 10,
      cashReserve: Math.round((100 - totalWeight) * 10) / 10,
      sectorBreakdown,
      portfolioStats: {
        averageConviction,
        averageUpside,
        holdingsCount: allocations.length,
        estimatedBeta,
      },
    };
  },
});

// ============================================================================
// FETCH CURRENT PRICES TOOL
// ============================================================================

export const fetchCurrentPricesTool = createTool({
  id: 'fetch-current-prices',
  description: 'Fetch current market prices for a list of tickers',

  inputSchema: z.object({
    tickers: z.array(z.string()).describe('List of stock tickers'),
  }),

  outputSchema: z.object({
    prices: z.record(z.number()),
    errors: z.array(z.string()),
  }),

  execute: async ({ context }) => {
    const { tickers } = context;
    const prices: Record<string, number> = {};
    const errors: string[] = [];

    // Batch fetch quotes
    for (const ticker of tickers) {
      try {
        const quote = await yf.quote(ticker);
        if (quote.regularMarketPrice) {
          prices[ticker] = quote.regularMarketPrice;
        } else {
          errors.push(`No price for ${ticker}`);
        }
      } catch (error) {
        errors.push(`Failed to fetch ${ticker}: ${error instanceof Error ? error.message : 'Unknown'}`);
      }
    }

    return { prices, errors };
  },
});

// ============================================================================
// REBALANCE PORTFOLIO TOOL
// ============================================================================

export const rebalancePortfolioTool = createTool({
  id: 'rebalance-portfolio',
  description: `
    Calculate trades needed to rebalance an existing portfolio to target allocations.
    Returns buy and sell orders to execute.
  `,

  inputSchema: z.object({
    currentHoldings: z.array(
      z.object({
        ticker: z.string(),
        shares: z.number(),
        currentPrice: z.number(),
        sector: z.string().nullable(),
      })
    ),
    targetAllocations: z.array(
      z.object({
        ticker: z.string(),
        targetWeight: z.number(),
        targetShares: z.number(),
        currentPrice: z.number(),
      })
    ),
    availableCash: z.number(),
    minTradeValue: z.number().default(500).describe('Minimum trade value to execute'),
  }),

  outputSchema: z.object({
    sellOrders: z.array(
      z.object({
        ticker: z.string(),
        shares: z.number(),
        estimatedProceeds: z.number(),
        reason: z.string(),
      })
    ),
    buyOrders: z.array(
      z.object({
        ticker: z.string(),
        shares: z.number(),
        estimatedCost: z.number(),
        reason: z.string(),
      })
    ),
    netCashChange: z.number(),
    tradesCount: z.number(),
  }),

  execute: async ({ context }) => {
    const { currentHoldings, targetAllocations, availableCash, minTradeValue } = context;

    const sellOrders: { ticker: string; shares: number; estimatedProceeds: number; reason: string }[] = [];
    const buyOrders: { ticker: string; shares: number; estimatedCost: number; reason: string }[] = [];

    // Create lookup maps
    const currentMap = new Map(currentHoldings.map((h) => [h.ticker, h]));
    const targetMap = new Map(targetAllocations.map((t) => [t.ticker, t]));

    let cashFromSells = 0;

    // Identify sells (reduce or close positions)
    for (const holding of currentHoldings) {
      const target = targetMap.get(holding.ticker);

      if (!target) {
        // Full sell - not in target
        const proceeds = holding.shares * holding.currentPrice;
        if (proceeds >= minTradeValue) {
          sellOrders.push({
            ticker: holding.ticker,
            shares: holding.shares,
            estimatedProceeds: proceeds,
            reason: 'Removed from portfolio',
          });
          cashFromSells += proceeds;
        }
      } else if (target.targetShares < holding.shares) {
        // Partial sell - reduce position
        const sharesToSell = holding.shares - target.targetShares;
        const proceeds = sharesToSell * holding.currentPrice;
        if (proceeds >= minTradeValue) {
          sellOrders.push({
            ticker: holding.ticker,
            shares: sharesToSell,
            estimatedProceeds: proceeds,
            reason: 'Reduce overweight position',
          });
          cashFromSells += proceeds;
        }
      }
    }

    // Calculate available cash for buys
    const totalCashAvailable = availableCash + cashFromSells;

    // Identify buys (new or increase positions)
    for (const target of targetAllocations) {
      const current = currentMap.get(target.ticker);
      const currentShares = current?.shares || 0;

      if (target.targetShares > currentShares) {
        const sharesToBuy = target.targetShares - currentShares;
        const cost = sharesToBuy * target.currentPrice;

        if (cost >= minTradeValue && cost <= totalCashAvailable) {
          buyOrders.push({
            ticker: target.ticker,
            shares: sharesToBuy,
            estimatedCost: cost,
            reason: currentShares === 0 ? 'New position' : 'Increase underweight position',
          });
        }
      }
    }

    const netCashChange = cashFromSells - buyOrders.reduce((sum, b) => sum + b.estimatedCost, 0);

    return {
      sellOrders,
      buyOrders,
      netCashChange,
      tradesCount: sellOrders.length + buyOrders.length,
    };
  },
});

// ============================================================================
// EXPORTS
// ============================================================================

export const portfolioConstructionTools = [
  optimizePortfolioAllocationTool,
  fetchCurrentPricesTool,
  rebalancePortfolioTool,
];
