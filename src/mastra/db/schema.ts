// ============================================================================
// DATABASE SCHEMA FOR PORTFOLIO OPTIMIZER & INTELLIGENT PORTFOLIO BUILDER
// ============================================================================
// Defines the database tables for persisting portfolio data:
// - portfolios: Main portfolio configuration
// - holdings: Current stock holdings (with conviction tracking)
// - transactions: Buy/sell history (with analysis references)
// - snapshots: Monthly portfolio snapshots for performance tracking
// - stock_scores: Stock scoring history for analysis
//
// INTELLIGENT PORTFOLIO BUILDER TABLES:
// - screening_runs: Track each portfolio construction/review run
// - stock_analyses: Store deep analysis results for each stock
// - triage_decisions: Log agent routing decisions for transparency
// ============================================================================

import { homedir } from 'os';
import { join } from 'path';

// Use dynamic import for @libsql/client since it's a transitive dependency
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbClient: any = null;

// Persistent database location in user's home directory
const DB_DIR = join(homedir(), 'equity-research-agent', 'data');
const DB_PATH = join(DB_DIR, 'portfolio.db');

// ============================================================================
// DATABASE CLIENT
// ============================================================================

export async function getDbClient(): Promise<any> {
  if (!dbClient) {
    // Ensure data directory exists
    const { mkdir } = await import('fs/promises');
    await mkdir(DB_DIR, { recursive: true });

    // Dynamic import to work with the transitive dependency
    const { createClient } = await import('@libsql/client');
    dbClient = createClient({
      url: `file:${DB_PATH}`,
    });
  }
  return dbClient;
}

// ============================================================================
// SCHEMA DEFINITIONS (SQL)
// ============================================================================

export const SCHEMA_SQL = `
-- Portfolio configuration
CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'value',
  initial_capital REAL NOT NULL,
  current_cash REAL NOT NULL,
  target_holdings INTEGER NOT NULL DEFAULT 20,
  max_position_pct REAL NOT NULL DEFAULT 0.10,
  min_position_pct REAL NOT NULL DEFAULT 0.02,
  max_sector_pct REAL NOT NULL DEFAULT 0.25,
  max_monthly_turnover INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Current holdings (with conviction tracking for intelligent portfolio builder)
CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  shares REAL NOT NULL,
  avg_cost REAL NOT NULL,
  current_price REAL,
  sector TEXT,
  conviction_score REAL,
  conviction_level TEXT CHECK (conviction_level IN ('VERY_HIGH', 'HIGH', 'MODERATE', 'LOW', 'VERY_LOW') OR conviction_level IS NULL),
  last_analysis_id INTEGER,
  last_analysis_date TEXT,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id),
  FOREIGN KEY (last_analysis_id) REFERENCES stock_analyses(id),
  UNIQUE(portfolio_id, ticker)
);

-- Transaction history (with analysis reference for intelligent portfolio builder)
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
  shares REAL NOT NULL,
  price REAL NOT NULL,
  total_value REAL NOT NULL,
  reason TEXT,
  score_at_trade REAL,
  analysis_id INTEGER,
  screening_run_id TEXT,
  executed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id),
  FOREIGN KEY (analysis_id) REFERENCES stock_analyses(id),
  FOREIGN KEY (screening_run_id) REFERENCES screening_runs(id)
);

-- Monthly portfolio snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  total_value REAL NOT NULL,
  cash_value REAL NOT NULL,
  holdings_value REAL NOT NULL,
  holdings_count INTEGER NOT NULL,
  period_return_pct REAL,
  cumulative_return_pct REAL,
  spy_period_return_pct REAL,
  spy_cumulative_return_pct REAL,
  alpha_pct REAL,
  holdings_data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
);

-- Stock scores for analysis
CREATE TABLE IF NOT EXISTS stock_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  score_date TEXT NOT NULL,
  total_score REAL NOT NULL,
  value_score REAL,
  quality_score REAL,
  growth_score REAL,
  momentum_score REAL,
  risk_score REAL,
  pe_ratio REAL,
  pb_ratio REAL,
  dividend_yield REAL,
  revenue_growth REAL,
  profit_margin REAL,
  beta REAL,
  market_cap REAL,
  sector TEXT,
  raw_data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- INTELLIGENT PORTFOLIO BUILDER TABLES
-- ============================================================================

-- Screening runs: Track each portfolio construction/review run
CREATE TABLE IF NOT EXISTS screening_runs (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT,
  run_type TEXT NOT NULL CHECK (run_type IN ('CONSTRUCTION', 'MONTHLY_REVIEW')),
  strategy TEXT NOT NULL DEFAULT 'value',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),

  -- Tier 1 results
  tier1_input_count INTEGER,
  tier1_output_count INTEGER,
  tier1_completed_at TEXT,

  -- Tier 2 results
  tier2_input_count INTEGER,
  tier2_output_count INTEGER,
  tier2_rejected_count INTEGER,
  tier2_completed_at TEXT,

  -- Tier 3 results
  tier3_input_count INTEGER,
  tier3_output_count INTEGER,
  tier3_completed_at TEXT,

  -- Final results
  final_portfolio_count INTEGER,

  -- Configuration used (JSON)
  config TEXT,

  -- Error message if failed
  error_message TEXT,

  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
);

-- Stock analyses: Store deep analysis results for each stock
CREATE TABLE IF NOT EXISTS stock_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screening_run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,

  -- Tier 1 results
  tier1_score REAL,
  tier1_passed INTEGER DEFAULT 0,

  -- Tier 2 results
  tier2_passed INTEGER DEFAULT 0,
  tier2_decision TEXT CHECK (tier2_decision IN ('PASS', 'REJECT', 'FAST_TRACK', 'MORE_INFO') OR tier2_decision IS NULL),
  tier2_rejection_reason TEXT,
  tier2_quick_checks TEXT,

  -- Tier 3 results
  tier3_completed INTEGER DEFAULT 0,

  -- Deep analysis results (Tier 3)
  dcf_analysis TEXT,
  dcf_intrinsic_value REAL,
  dcf_upside_pct REAL,

  comparable_analysis TEXT,
  comparable_implied_value REAL,

  sentiment_analysis TEXT,
  sentiment_score REAL,

  risk_analysis TEXT,
  risk_score REAL,

  earnings_analysis TEXT,
  earnings_sentiment TEXT CHECK (earnings_sentiment IN ('beat', 'miss', 'inline') OR earnings_sentiment IS NULL),

  -- Final synthesis
  research_summary TEXT,
  investment_thesis TEXT,

  -- Conviction scoring
  conviction_score REAL,
  conviction_breakdown TEXT,
  conviction_level TEXT CHECK (conviction_level IN ('VERY_HIGH', 'HIGH', 'MODERATE', 'LOW', 'VERY_LOW') OR conviction_level IS NULL),

  -- Metadata
  workflows_run TEXT,
  analysis_time_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (screening_run_id) REFERENCES screening_runs(id),
  UNIQUE(screening_run_id, ticker)
);

-- Triage decisions: Log routing agent decisions for transparency
CREATE TABLE IF NOT EXISTS triage_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screening_run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (2, 3)),

  decision TEXT NOT NULL CHECK (decision IN ('PASS', 'REJECT', 'FAST_TRACK', 'MORE_INFO')),
  reasoning TEXT NOT NULL,

  -- For MORE_INFO decisions
  additional_checks_requested TEXT,
  additional_checks_results TEXT,
  final_decision TEXT CHECK (final_decision IN ('PASS', 'REJECT', 'FAST_TRACK') OR final_decision IS NULL),

  decided_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (screening_run_id) REFERENCES screening_runs(id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Existing indexes
CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON holdings(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_holdings_ticker ON holdings(ticker);
CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(executed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_portfolio ON snapshots(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_scores_ticker ON stock_scores(ticker);
CREATE INDEX IF NOT EXISTS idx_scores_date ON stock_scores(score_date);

-- Intelligent portfolio builder indexes
CREATE INDEX IF NOT EXISTS idx_screening_runs_portfolio ON screening_runs(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_screening_runs_status ON screening_runs(status);
CREATE INDEX IF NOT EXISTS idx_stock_analyses_run ON stock_analyses(screening_run_id);
CREATE INDEX IF NOT EXISTS idx_stock_analyses_ticker ON stock_analyses(ticker);
CREATE INDEX IF NOT EXISTS idx_stock_analyses_conviction ON stock_analyses(conviction_score);
CREATE INDEX IF NOT EXISTS idx_triage_decisions_run ON triage_decisions(screening_run_id);
CREATE INDEX IF NOT EXISTS idx_triage_decisions_ticker ON triage_decisions(ticker);
`;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface Portfolio {
  id: string;
  name: string;
  strategy: 'value' | 'growth' | 'balanced';
  initialCapital: number;
  currentCash: number;
  targetHoldings: number;
  maxPositionPct: number;
  minPositionPct: number;
  maxSectorPct: number;
  maxMonthlyTurnover: number;
  createdAt: string;
  updatedAt: string;
}

export interface Holding {
  id?: number;
  portfolioId: string;
  ticker: string;
  shares: number;
  avgCost: number;
  currentPrice: number | null;
  sector: string | null;
  convictionScore: number | null;
  convictionLevel: ConvictionLevel | null;
  lastAnalysisId: number | null;
  lastAnalysisDate: string | null;
  acquiredAt: string;
  updatedAt: string;
}

export interface Transaction {
  id?: number;
  portfolioId: string;
  ticker: string;
  action: 'BUY' | 'SELL';
  shares: number;
  price: number;
  totalValue: number;
  reason: string | null;
  scoreAtTrade: number | null;
  analysisId: number | null;
  screeningRunId: string | null;
  executedAt: string;
}

export interface Snapshot {
  id?: number;
  portfolioId: string;
  snapshotDate: string;
  totalValue: number;
  cashValue: number;
  holdingsValue: number;
  holdingsCount: number;
  periodReturnPct: number | null;
  cumulativeReturnPct: number | null;
  spyPeriodReturnPct: number | null;
  spyCumulativeReturnPct: number | null;
  alphaPct: number | null;
  holdingsData: HoldingSnapshot[];
  createdAt: string;
}

export interface HoldingSnapshot {
  ticker: string;
  shares: number;
  price: number;
  value: number;
  weight: number;
  sector: string;
  gainPct: number;
}

export interface StockScore {
  id?: number;
  ticker: string;
  scoreDate: string;
  totalScore: number;
  valueScore: number | null;
  qualityScore: number | null;
  growthScore: number | null;
  momentumScore: number | null;
  riskScore: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  dividendYield: number | null;
  revenueGrowth: number | null;
  profitMargin: number | null;
  beta: number | null;
  marketCap: number | null;
  sector: string | null;
  rawData: Record<string, unknown> | null;
  createdAt: string;
}

// ============================================================================
// INTELLIGENT PORTFOLIO BUILDER TYPE DEFINITIONS
// ============================================================================

export type ScreeningRunType = 'CONSTRUCTION' | 'MONTHLY_REVIEW';
export type ScreeningRunStatus = 'running' | 'completed' | 'failed';
export type TriageDecision = 'PASS' | 'REJECT' | 'FAST_TRACK' | 'MORE_INFO';
export type ConvictionLevel = 'VERY_HIGH' | 'HIGH' | 'MODERATE' | 'LOW' | 'VERY_LOW';
export type EarningsSentiment = 'beat' | 'miss' | 'inline';

export interface ScreeningRunConfig {
  tier1MinScore: number;
  tier1MaxCandidates: number;
  tier2MaxCandidates: number;
  tier3MinConviction: number;
  maxSectorPct: number;
  minPositionPct: number;
  maxPositionPct: number;
  targetHoldings: number;
  cashReservePct: number;
}

export interface ScreeningRun {
  id: string;
  portfolioId: string | null;
  runType: ScreeningRunType;
  strategy: 'value' | 'growth' | 'balanced';
  startedAt: string;
  completedAt: string | null;
  status: ScreeningRunStatus;

  // Tier 1 results
  tier1InputCount: number | null;
  tier1OutputCount: number | null;
  tier1CompletedAt: string | null;

  // Tier 2 results
  tier2InputCount: number | null;
  tier2OutputCount: number | null;
  tier2RejectedCount: number | null;
  tier2CompletedAt: string | null;

  // Tier 3 results
  tier3InputCount: number | null;
  tier3OutputCount: number | null;
  tier3CompletedAt: string | null;

  // Final results
  finalPortfolioCount: number | null;

  // Configuration
  config: ScreeningRunConfig | null;

  // Error if failed
  errorMessage: string | null;
}

export interface ConvictionBreakdown {
  valuationScore: number;
  sentimentScore: number;
  riskScore: number;
  earningsScore: number;
  qualityScore: number;
  weights: {
    valuation: number;
    sentiment: number;
    risk: number;
    earnings: number;
    quality: number;
  };
}

export interface StockAnalysis {
  id?: number;
  screeningRunId: string;
  ticker: string;

  // Tier 1 results
  tier1Score: number | null;
  tier1Passed: boolean;

  // Tier 2 results
  tier2Passed: boolean;
  tier2Decision: TriageDecision | null;
  tier2RejectionReason: string | null;
  tier2QuickChecks: Record<string, unknown> | null;

  // Tier 3 results
  tier3Completed: boolean;

  // Deep analysis results
  dcfAnalysis: string | null;
  dcfIntrinsicValue: number | null;
  dcfUpsidePct: number | null;

  comparableAnalysis: string | null;
  comparableImpliedValue: number | null;

  sentimentAnalysis: string | null;
  sentimentScore: number | null;

  riskAnalysis: string | null;
  riskScore: number | null;

  earningsAnalysis: string | null;
  earningsSentiment: EarningsSentiment | null;

  // Final synthesis
  researchSummary: string | null;
  investmentThesis: string | null;

  // Conviction scoring
  convictionScore: number | null;
  convictionBreakdown: ConvictionBreakdown | null;
  convictionLevel: ConvictionLevel | null;

  // Metadata
  workflowsRun: string[] | null;
  analysisTimeSeconds: number | null;
  createdAt: string;
}

export interface TriageDecisionRecord {
  id?: number;
  screeningRunId: string;
  ticker: string;
  tier: 2 | 3;

  decision: TriageDecision;
  reasoning: string;

  // For MORE_INFO decisions
  additionalChecksRequested: string[] | null;
  additionalChecksResults: Record<string, unknown> | null;
  finalDecision: Exclude<TriageDecision, 'MORE_INFO'> | null;

  decidedAt: string;
}

// ============================================================================
// INITIALIZE DATABASE
// ============================================================================

// Migration SQL to add new columns to existing tables
const MIGRATIONS_SQL = `
-- Add conviction tracking columns to holdings if they don't exist
ALTER TABLE holdings ADD COLUMN conviction_score REAL;
ALTER TABLE holdings ADD COLUMN conviction_level TEXT CHECK (conviction_level IN ('VERY_HIGH', 'HIGH', 'MODERATE', 'LOW', 'VERY_LOW') OR conviction_level IS NULL);
ALTER TABLE holdings ADD COLUMN last_analysis_id INTEGER REFERENCES stock_analyses(id);
ALTER TABLE holdings ADD COLUMN last_analysis_date TEXT;

-- Add analysis reference columns to transactions if they don't exist
ALTER TABLE transactions ADD COLUMN analysis_id INTEGER REFERENCES stock_analyses(id);
ALTER TABLE transactions ADD COLUMN screening_run_id TEXT REFERENCES screening_runs(id);
`;

export async function initializeDatabase(): Promise<void> {
  const client = await getDbClient();

  // Split schema into individual statements and execute
  const statements = SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await client.execute(statement);
  }

  // Run migrations for existing tables (these will fail silently if columns exist)
  const migrations = MIGRATIONS_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const migration of migrations) {
    try {
      await client.execute(migration);
    } catch (error: unknown) {
      // Ignore "duplicate column" errors - this is expected for existing databases
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('duplicate column')) {
        console.warn(`Migration warning: ${errorMessage}`);
      }
    }
  }

  console.log('Portfolio database initialized successfully');
}

// ============================================================================
// END OF SCHEMA
// ============================================================================
