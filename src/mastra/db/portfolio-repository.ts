// ============================================================================
// PORTFOLIO REPOSITORY
// ============================================================================
// Data access layer for portfolio management operations.
// Provides CRUD operations for portfolios, holdings, transactions, and snapshots.
// ============================================================================

import {
  getDbClient,
  initializeDatabase,
  Portfolio,
  Holding,
  Transaction,
  Snapshot,
  StockScore,
  HoldingSnapshot,
  ConvictionLevel,
} from './schema';

// Row type for database results
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

// ============================================================================
// PORTFOLIO OPERATIONS
// ============================================================================

export async function createPortfolio(portfolio: Omit<Portfolio, 'createdAt' | 'updatedAt'>): Promise<Portfolio> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO portfolios (
      id, name, strategy, initial_capital, current_cash,
      target_holdings, max_position_pct, min_position_pct,
      max_sector_pct, max_monthly_turnover, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      portfolio.id,
      portfolio.name,
      portfolio.strategy,
      portfolio.initialCapital,
      portfolio.currentCash,
      portfolio.targetHoldings,
      portfolio.maxPositionPct,
      portfolio.minPositionPct,
      portfolio.maxSectorPct,
      portfolio.maxMonthlyTurnover,
      now,
      now,
    ],
  });

  return {
    ...portfolio,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getPortfolio(id: string): Promise<Portfolio | null> {
  await initializeDatabase();
  const client = await getDbClient();

  const result = await client.execute({
    sql: 'SELECT * FROM portfolios WHERE id = ?',
    args: [id],
  });

  if (result.rows.length === 0) return null;

  const row: DbRow = result.rows[0];
  return {
    id: row.id as string,
    name: row.name as string,
    strategy: row.strategy as Portfolio['strategy'],
    initialCapital: row.initial_capital as number,
    currentCash: row.current_cash as number,
    targetHoldings: row.target_holdings as number,
    maxPositionPct: row.max_position_pct as number,
    minPositionPct: row.min_position_pct as number,
    maxSectorPct: row.max_sector_pct as number,
    maxMonthlyTurnover: row.max_monthly_turnover as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function updatePortfolioCash(id: string, newCash: number): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE portfolios SET current_cash = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [newCash, id],
  });
}

export async function listPortfolios(): Promise<Portfolio[]> {
  await initializeDatabase();
  const client = await getDbClient();

  const result = await client.execute('SELECT * FROM portfolios ORDER BY created_at DESC');

  return result.rows.map((row: DbRow) => ({
    id: row.id as string,
    name: row.name as string,
    strategy: row.strategy as Portfolio['strategy'],
    initialCapital: row.initial_capital as number,
    currentCash: row.current_cash as number,
    targetHoldings: row.target_holdings as number,
    maxPositionPct: row.max_position_pct as number,
    minPositionPct: row.min_position_pct as number,
    maxSectorPct: row.max_sector_pct as number,
    maxMonthlyTurnover: row.max_monthly_turnover as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export async function deletePortfolio(id: string): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  // Delete all related data in correct order (foreign key constraints)
  await client.execute({ sql: 'DELETE FROM snapshots WHERE portfolio_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM transactions WHERE portfolio_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM holdings WHERE portfolio_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM portfolios WHERE id = ?', args: [id] });
}

// ============================================================================
// HOLDINGS OPERATIONS
// ============================================================================

export async function addHolding(holding: Omit<Holding, 'id' | 'acquiredAt' | 'updatedAt'>): Promise<Holding> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  const result = await client.execute({
    sql: `INSERT INTO holdings (
      portfolio_id, ticker, shares, avg_cost, current_price, sector,
      conviction_score, conviction_level, last_analysis_id, last_analysis_date,
      acquired_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portfolio_id, ticker) DO UPDATE SET
      shares = shares + excluded.shares,
      avg_cost = (avg_cost * shares + excluded.avg_cost * excluded.shares) / (shares + excluded.shares),
      conviction_score = COALESCE(excluded.conviction_score, conviction_score),
      conviction_level = COALESCE(excluded.conviction_level, conviction_level),
      last_analysis_id = COALESCE(excluded.last_analysis_id, last_analysis_id),
      last_analysis_date = COALESCE(excluded.last_analysis_date, last_analysis_date),
      updated_at = excluded.updated_at
    RETURNING id`,
    args: [
      holding.portfolioId,
      holding.ticker,
      holding.shares,
      holding.avgCost,
      holding.currentPrice,
      holding.sector,
      holding.convictionScore,
      holding.convictionLevel,
      holding.lastAnalysisId,
      holding.lastAnalysisDate,
      now,
      now,
    ],
  });

  return {
    ...holding,
    id: result.rows[0]?.id as number,
    acquiredAt: now,
    updatedAt: now,
  };
}

export async function getHoldings(portfolioId: string): Promise<Holding[]> {
  await initializeDatabase();
  const client = await getDbClient();

  const result = await client.execute({
    sql: 'SELECT * FROM holdings WHERE portfolio_id = ? ORDER BY ticker',
    args: [portfolioId],
  });

  return result.rows.map((row: DbRow) => ({
    id: row.id as number,
    portfolioId: row.portfolio_id as string,
    ticker: row.ticker as string,
    shares: row.shares as number,
    avgCost: row.avg_cost as number,
    currentPrice: row.current_price as number | null,
    sector: row.sector as string | null,
    convictionScore: row.conviction_score as number | null,
    convictionLevel: row.conviction_level as ConvictionLevel | null,
    lastAnalysisId: row.last_analysis_id as number | null,
    lastAnalysisDate: row.last_analysis_date as string | null,
    acquiredAt: row.acquired_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export async function getHolding(portfolioId: string, ticker: string): Promise<Holding | null> {
  await initializeDatabase();
  const client = await getDbClient();

  const result = await client.execute({
    sql: 'SELECT * FROM holdings WHERE portfolio_id = ? AND ticker = ?',
    args: [portfolioId, ticker],
  });

  if (result.rows.length === 0) return null;

  const row: DbRow = result.rows[0];
  return {
    id: row.id as number,
    portfolioId: row.portfolio_id as string,
    ticker: row.ticker as string,
    shares: row.shares as number,
    avgCost: row.avg_cost as number,
    currentPrice: row.current_price as number | null,
    sector: row.sector as string | null,
    convictionScore: row.conviction_score as number | null,
    convictionLevel: row.conviction_level as ConvictionLevel | null,
    lastAnalysisId: row.last_analysis_id as number | null,
    lastAnalysisDate: row.last_analysis_date as string | null,
    acquiredAt: row.acquired_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function updateHoldingPrice(portfolioId: string, ticker: string, price: number): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE holdings SET current_price = ?, updated_at = datetime('now') WHERE portfolio_id = ? AND ticker = ?`,
    args: [price, portfolioId, ticker],
  });
}

export async function updateHoldingShares(portfolioId: string, ticker: string, shares: number): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  if (shares <= 0) {
    // Remove holding if shares go to zero or negative
    await client.execute({
      sql: 'DELETE FROM holdings WHERE portfolio_id = ? AND ticker = ?',
      args: [portfolioId, ticker],
    });
  } else {
    await client.execute({
      sql: `UPDATE holdings SET shares = ?, updated_at = datetime('now') WHERE portfolio_id = ? AND ticker = ?`,
      args: [shares, portfolioId, ticker],
    });
  }
}

export async function removeHolding(portfolioId: string, ticker: string): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: 'DELETE FROM holdings WHERE portfolio_id = ? AND ticker = ?',
    args: [portfolioId, ticker],
  });
}

export async function updateHoldingConviction(
  portfolioId: string,
  ticker: string,
  convictionScore: number,
  convictionLevel: 'HIGH' | 'MEDIUM' | 'LOW',
  analysisId: number
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  await client.execute({
    sql: `UPDATE holdings SET
      conviction_score = ?,
      conviction_level = ?,
      last_analysis_id = ?,
      last_analysis_date = ?,
      updated_at = datetime('now')
    WHERE portfolio_id = ? AND ticker = ?`,
    args: [convictionScore, convictionLevel, analysisId, now, portfolioId, ticker],
  });
}

// ============================================================================
// TRANSACTION OPERATIONS
// ============================================================================

export async function recordTransaction(transaction: Omit<Transaction, 'id' | 'executedAt'>): Promise<Transaction> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  const result = await client.execute({
    sql: `INSERT INTO transactions (
      portfolio_id, ticker, action, shares, price, total_value, reason, score_at_trade,
      analysis_id, screening_run_id, executed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      transaction.portfolioId,
      transaction.ticker,
      transaction.action,
      transaction.shares,
      transaction.price,
      transaction.totalValue,
      transaction.reason,
      transaction.scoreAtTrade,
      transaction.analysisId,
      transaction.screeningRunId,
      now,
    ],
  });

  return {
    ...transaction,
    id: result.rows[0]?.id as number,
    executedAt: now,
  };
}

export async function getTransactions(
  portfolioId: string,
  options: { limit?: number; startDate?: string; endDate?: string } = {}
): Promise<Transaction[]> {
  await initializeDatabase();
  const client = await getDbClient();

  let sql = 'SELECT * FROM transactions WHERE portfolio_id = ?';
  const args: (string | number)[] = [portfolioId];

  if (options.startDate) {
    sql += ' AND executed_at >= ?';
    args.push(options.startDate);
  }
  if (options.endDate) {
    sql += ' AND executed_at <= ?';
    args.push(options.endDate);
  }

  sql += ' ORDER BY executed_at DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    args.push(options.limit);
  }

  const result = await client.execute({ sql, args });

  return result.rows.map((row: DbRow) => ({
    id: row.id as number,
    portfolioId: row.portfolio_id as string,
    ticker: row.ticker as string,
    action: row.action as 'BUY' | 'SELL',
    shares: row.shares as number,
    price: row.price as number,
    totalValue: row.total_value as number,
    reason: row.reason as string | null,
    scoreAtTrade: row.score_at_trade as number | null,
    analysisId: row.analysis_id as number | null,
    screeningRunId: row.screening_run_id as string | null,
    executedAt: row.executed_at as string,
  }));
}

export async function getMonthlyTransactionCount(portfolioId: string, month: string): Promise<number> {
  await initializeDatabase();
  const client = await getDbClient();

  // month format: 'YYYY-MM'
  const result = await client.execute({
    sql: `SELECT COUNT(*) as count FROM transactions
          WHERE portfolio_id = ?
          AND strftime('%Y-%m', executed_at) = ?`,
    args: [portfolioId, month],
  });

  return (result.rows[0]?.count as number) || 0;
}

// ============================================================================
// SNAPSHOT OPERATIONS
// ============================================================================

export async function createSnapshot(snapshot: Omit<Snapshot, 'id' | 'createdAt'>): Promise<Snapshot> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  const result = await client.execute({
    sql: `INSERT INTO snapshots (
      portfolio_id, snapshot_date, total_value, cash_value, holdings_value,
      holdings_count, period_return_pct, cumulative_return_pct,
      spy_period_return_pct, spy_cumulative_return_pct, alpha_pct,
      holdings_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      snapshot.portfolioId,
      snapshot.snapshotDate,
      snapshot.totalValue,
      snapshot.cashValue,
      snapshot.holdingsValue,
      snapshot.holdingsCount,
      snapshot.periodReturnPct,
      snapshot.cumulativeReturnPct,
      snapshot.spyPeriodReturnPct,
      snapshot.spyCumulativeReturnPct,
      snapshot.alphaPct,
      JSON.stringify(snapshot.holdingsData),
      now,
    ],
  });

  return {
    ...snapshot,
    id: result.rows[0]?.id as number,
    createdAt: now,
  };
}

export async function getSnapshots(portfolioId: string, limit?: number): Promise<Snapshot[]> {
  await initializeDatabase();
  const client = await getDbClient();

  let sql = 'SELECT * FROM snapshots WHERE portfolio_id = ? ORDER BY snapshot_date DESC';
  const args: (string | number)[] = [portfolioId];

  if (limit) {
    sql += ' LIMIT ?';
    args.push(limit);
  }

  const result = await client.execute({ sql, args });

  return result.rows.map((row: DbRow) => ({
    id: row.id as number,
    portfolioId: row.portfolio_id as string,
    snapshotDate: row.snapshot_date as string,
    totalValue: row.total_value as number,
    cashValue: row.cash_value as number,
    holdingsValue: row.holdings_value as number,
    holdingsCount: row.holdings_count as number,
    periodReturnPct: row.period_return_pct as number | null,
    cumulativeReturnPct: row.cumulative_return_pct as number | null,
    spyPeriodReturnPct: row.spy_period_return_pct as number | null,
    spyCumulativeReturnPct: row.spy_cumulative_return_pct as number | null,
    alphaPct: row.alpha_pct as number | null,
    holdingsData: JSON.parse(row.holdings_data as string) as HoldingSnapshot[],
    createdAt: row.created_at as string,
  }));
}

export async function getLatestSnapshot(portfolioId: string): Promise<Snapshot | null> {
  const snapshots = await getSnapshots(portfolioId, 1);
  return snapshots.length > 0 ? snapshots[0] : null;
}

// ============================================================================
// STOCK SCORE OPERATIONS
// ============================================================================

export async function saveStockScore(score: Omit<StockScore, 'id' | 'createdAt'>): Promise<StockScore> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  const result = await client.execute({
    sql: `INSERT INTO stock_scores (
      ticker, score_date, total_score, value_score, quality_score,
      growth_score, momentum_score, risk_score, pe_ratio, pb_ratio,
      dividend_yield, revenue_growth, profit_margin, beta, market_cap,
      sector, raw_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      score.ticker,
      score.scoreDate,
      score.totalScore,
      score.valueScore,
      score.qualityScore,
      score.growthScore,
      score.momentumScore,
      score.riskScore,
      score.peRatio,
      score.pbRatio,
      score.dividendYield,
      score.revenueGrowth,
      score.profitMargin,
      score.beta,
      score.marketCap,
      score.sector,
      score.rawData ? JSON.stringify(score.rawData) : null,
      now,
    ],
  });

  return {
    ...score,
    id: result.rows[0]?.id as number,
    createdAt: now,
  };
}

export async function saveStockScoresBatch(scores: Omit<StockScore, 'id' | 'createdAt'>[]): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  // Use a transaction for batch inserts
  const batch = scores.map((score) => ({
    sql: `INSERT INTO stock_scores (
      ticker, score_date, total_score, value_score, quality_score,
      growth_score, momentum_score, risk_score, pe_ratio, pb_ratio,
      dividend_yield, revenue_growth, profit_margin, beta, market_cap,
      sector, raw_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      score.ticker,
      score.scoreDate,
      score.totalScore,
      score.valueScore,
      score.qualityScore,
      score.growthScore,
      score.momentumScore,
      score.riskScore,
      score.peRatio,
      score.pbRatio,
      score.dividendYield,
      score.revenueGrowth,
      score.profitMargin,
      score.beta,
      score.marketCap,
      score.sector,
      score.rawData ? JSON.stringify(score.rawData) : null,
      now,
    ],
  }));

  await client.batch(batch);
}

export async function getStockScores(
  ticker: string,
  options: { limit?: number; startDate?: string } = {}
): Promise<StockScore[]> {
  await initializeDatabase();
  const client = await getDbClient();

  let sql = 'SELECT * FROM stock_scores WHERE ticker = ?';
  const args: (string | number)[] = [ticker];

  if (options.startDate) {
    sql += ' AND score_date >= ?';
    args.push(options.startDate);
  }

  sql += ' ORDER BY score_date DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    args.push(options.limit);
  }

  const result = await client.execute({ sql, args });

  return result.rows.map((row: DbRow) => ({
    id: row.id as number,
    ticker: row.ticker as string,
    scoreDate: row.score_date as string,
    totalScore: row.total_score as number,
    valueScore: row.value_score as number | null,
    qualityScore: row.quality_score as number | null,
    growthScore: row.growth_score as number | null,
    momentumScore: row.momentum_score as number | null,
    riskScore: row.risk_score as number | null,
    peRatio: row.pe_ratio as number | null,
    pbRatio: row.pb_ratio as number | null,
    dividendYield: row.dividend_yield as number | null,
    revenueGrowth: row.revenue_growth as number | null,
    profitMargin: row.profit_margin as number | null,
    beta: row.beta as number | null,
    marketCap: row.market_cap as number | null,
    sector: row.sector as string | null,
    rawData: row.raw_data ? JSON.parse(row.raw_data as string) : null,
    createdAt: row.created_at as string,
  }));
}

export async function getLatestScores(date: string, limit?: number): Promise<StockScore[]> {
  await initializeDatabase();
  const client = await getDbClient();

  let sql = `SELECT * FROM stock_scores WHERE score_date = ? ORDER BY total_score DESC`;
  const args: (string | number)[] = [date];

  if (limit) {
    sql += ' LIMIT ?';
    args.push(limit);
  }

  const result = await client.execute({ sql, args });

  return result.rows.map((row: DbRow) => ({
    id: row.id as number,
    ticker: row.ticker as string,
    scoreDate: row.score_date as string,
    totalScore: row.total_score as number,
    valueScore: row.value_score as number | null,
    qualityScore: row.quality_score as number | null,
    growthScore: row.growth_score as number | null,
    momentumScore: row.momentum_score as number | null,
    riskScore: row.risk_score as number | null,
    peRatio: row.pe_ratio as number | null,
    pbRatio: row.pb_ratio as number | null,
    dividendYield: row.dividend_yield as number | null,
    revenueGrowth: row.revenue_growth as number | null,
    profitMargin: row.profit_margin as number | null,
    beta: row.beta as number | null,
    marketCap: row.market_cap as number | null,
    sector: row.sector as string | null,
    rawData: row.raw_data ? JSON.parse(row.raw_data as string) : null,
    createdAt: row.created_at as string,
  }));
}

// ============================================================================
// PORTFOLIO SUMMARY HELPERS
// ============================================================================

export interface PortfolioSummary {
  portfolio: Portfolio;
  holdings: Holding[];
  totalValue: number;
  holdingsValue: number;
  cashValue: number;
  holdingsCount: number;
  sectorBreakdown: Record<string, { count: number; value: number; weight: number }>;
  unrealizedGainLoss: number;
  unrealizedGainLossPct: number;
}

export async function getPortfolioSummary(portfolioId: string): Promise<PortfolioSummary | null> {
  const portfolio = await getPortfolio(portfolioId);
  if (!portfolio) return null;

  const holdings = await getHoldings(portfolioId);

  let holdingsValue = 0;
  let totalCost = 0;
  const sectorBreakdown: Record<string, { count: number; value: number; weight: number }> = {};

  for (const holding of holdings) {
    const value = holding.shares * (holding.currentPrice || holding.avgCost);
    const cost = holding.shares * holding.avgCost;
    holdingsValue += value;
    totalCost += cost;

    const sector = holding.sector || 'Unknown';
    if (!sectorBreakdown[sector]) {
      sectorBreakdown[sector] = { count: 0, value: 0, weight: 0 };
    }
    sectorBreakdown[sector].count++;
    sectorBreakdown[sector].value += value;
  }

  const totalValue = holdingsValue + portfolio.currentCash;

  // Calculate weights
  for (const sector of Object.keys(sectorBreakdown)) {
    sectorBreakdown[sector].weight = totalValue > 0 ? (sectorBreakdown[sector].value / totalValue) * 100 : 0;
  }

  const unrealizedGainLoss = holdingsValue - totalCost;
  const unrealizedGainLossPct = totalCost > 0 ? (unrealizedGainLoss / totalCost) * 100 : 0;

  return {
    portfolio,
    holdings,
    totalValue,
    holdingsValue,
    cashValue: portfolio.currentCash,
    holdingsCount: holdings.length,
    sectorBreakdown,
    unrealizedGainLoss,
    unrealizedGainLossPct,
  };
}

// ============================================================================
// END OF REPOSITORY
// ============================================================================
