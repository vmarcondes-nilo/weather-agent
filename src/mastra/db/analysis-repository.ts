// ============================================================================
// ANALYSIS REPOSITORY
// ============================================================================
// Data access layer for intelligent portfolio builder operations.
// Provides CRUD operations for screening runs, stock analyses, and triage decisions.
// ============================================================================

import {
  getDbClient,
  initializeDatabase,
  ScreeningRun,
  ScreeningRunConfig,
  ScreeningRunType,
  ScreeningRunStatus,
  StockAnalysis,
  TriageDecisionRecord,
  TriageDecision,
  ConvictionBreakdown,
  ConvictionLevel,
  EarningsSentiment,
} from './schema';

// Row type for database results
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

// ============================================================================
// SCREENING RUN OPERATIONS
// ============================================================================

export async function createScreeningRun(
  run: Omit<ScreeningRun, 'startedAt' | 'completedAt' | 'status'>
): Promise<ScreeningRun> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO screening_runs (
      id, portfolio_id, run_type, strategy, started_at, status, config
    ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    args: [
      run.id,
      run.portfolioId,
      run.runType,
      run.strategy,
      now,
      run.config ? JSON.stringify(run.config) : null,
    ],
  });

  return {
    ...run,
    startedAt: now,
    completedAt: null,
    status: 'running',
  };
}

export async function getScreeningRun(id: string): Promise<ScreeningRun | null> {
  await initializeDatabase();
  const client = await getDbClient();

  const result = await client.execute({
    sql: 'SELECT * FROM screening_runs WHERE id = ?',
    args: [id],
  });

  if (result.rows.length === 0) return null;

  return rowToScreeningRun(result.rows[0]);
}

export async function updateScreeningRunTier1(
  id: string,
  inputCount: number,
  outputCount: number
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE screening_runs SET
      tier1_input_count = ?,
      tier1_output_count = ?,
      tier1_completed_at = datetime('now')
    WHERE id = ?`,
    args: [inputCount, outputCount, id],
  });
}

export async function updateScreeningRunTier2(
  id: string,
  inputCount: number,
  outputCount: number,
  rejectedCount: number
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE screening_runs SET
      tier2_input_count = ?,
      tier2_output_count = ?,
      tier2_rejected_count = ?,
      tier2_completed_at = datetime('now')
    WHERE id = ?`,
    args: [inputCount, outputCount, rejectedCount, id],
  });
}

export async function updateScreeningRunTier3(
  id: string,
  inputCount: number,
  outputCount: number
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE screening_runs SET
      tier3_input_count = ?,
      tier3_output_count = ?,
      tier3_completed_at = datetime('now')
    WHERE id = ?`,
    args: [inputCount, outputCount, id],
  });
}

export async function completeScreeningRun(
  id: string,
  finalPortfolioCount: number
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE screening_runs SET
      final_portfolio_count = ?,
      completed_at = datetime('now'),
      status = 'completed'
    WHERE id = ?`,
    args: [finalPortfolioCount, id],
  });
}

export async function failScreeningRun(id: string, errorMessage: string): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE screening_runs SET
      completed_at = datetime('now'),
      status = 'failed',
      error_message = ?
    WHERE id = ?`,
    args: [errorMessage, id],
  });
}

export async function updateScreeningRunPortfolio(id: string, portfolioId: string): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE screening_runs SET portfolio_id = ? WHERE id = ?`,
    args: [portfolioId, id],
  });
}

export async function listScreeningRuns(
  portfolioId?: string,
  options: { limit?: number; status?: ScreeningRunStatus } = {}
): Promise<ScreeningRun[]> {
  await initializeDatabase();
  const client = await getDbClient();

  let sql = 'SELECT * FROM screening_runs WHERE 1=1';
  const args: (string | number)[] = [];

  if (portfolioId) {
    sql += ' AND portfolio_id = ?';
    args.push(portfolioId);
  }

  if (options.status) {
    sql += ' AND status = ?';
    args.push(options.status);
  }

  sql += ' ORDER BY started_at DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    args.push(options.limit);
  }

  const result = await client.execute({ sql, args });

  return result.rows.map(rowToScreeningRun);
}

export async function getLatestScreeningRun(portfolioId: string): Promise<ScreeningRun | null> {
  const runs = await listScreeningRuns(portfolioId, { limit: 1 });
  return runs.length > 0 ? runs[0] : null;
}

// ============================================================================
// STOCK ANALYSIS OPERATIONS
// ============================================================================

export async function createStockAnalysis(
  analysis: Pick<StockAnalysis, 'screeningRunId' | 'ticker' | 'tier1Score' | 'tier1Passed'>
): Promise<StockAnalysis> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  const result = await client.execute({
    sql: `INSERT INTO stock_analyses (
      screening_run_id, ticker, tier1_score, tier1_passed, created_at
    ) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    args: [
      analysis.screeningRunId,
      analysis.ticker,
      analysis.tier1Score,
      analysis.tier1Passed ? 1 : 0,
      now,
    ],
  });

  return {
    id: result.rows[0]?.id as number,
    screeningRunId: analysis.screeningRunId,
    ticker: analysis.ticker,
    tier1Score: analysis.tier1Score,
    tier1Passed: analysis.tier1Passed,
    tier2Passed: false,
    tier2Decision: null,
    tier2RejectionReason: null,
    tier2QuickChecks: null,
    tier3Completed: false,
    dcfAnalysis: null,
    dcfIntrinsicValue: null,
    dcfUpsidePct: null,
    comparableAnalysis: null,
    comparableImpliedValue: null,
    sentimentAnalysis: null,
    sentimentScore: null,
    riskAnalysis: null,
    riskScore: null,
    earningsAnalysis: null,
    earningsSentiment: null,
    researchSummary: null,
    investmentThesis: null,
    convictionScore: null,
    convictionBreakdown: null,
    convictionLevel: null,
    workflowsRun: null,
    analysisTimeSeconds: null,
    createdAt: now,
  };
}

export async function createStockAnalysesBatch(
  analyses: Pick<StockAnalysis, 'screeningRunId' | 'ticker' | 'tier1Score' | 'tier1Passed'>[]
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  const batch = analyses.map((analysis) => ({
    sql: `INSERT INTO stock_analyses (
      screening_run_id, ticker, tier1_score, tier1_passed, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
    args: [
      analysis.screeningRunId,
      analysis.ticker,
      analysis.tier1Score,
      analysis.tier1Passed ? 1 : 0,
      now,
    ],
  }));

  await client.batch(batch);
}

export async function getStockAnalysis(
  screeningRunId: string,
  ticker: string
): Promise<StockAnalysis | null> {
  await initializeDatabase();
  const client = await getDbClient();

  const result = await client.execute({
    sql: 'SELECT * FROM stock_analyses WHERE screening_run_id = ? AND ticker = ?',
    args: [screeningRunId, ticker],
  });

  if (result.rows.length === 0) return null;

  return rowToStockAnalysis(result.rows[0]);
}

export async function getStockAnalysisById(id: number): Promise<StockAnalysis | null> {
  await initializeDatabase();
  const client = await getDbClient();

  const result = await client.execute({
    sql: 'SELECT * FROM stock_analyses WHERE id = ?',
    args: [id],
  });

  if (result.rows.length === 0) return null;

  return rowToStockAnalysis(result.rows[0]);
}

export async function updateTier2Results(
  screeningRunId: string,
  ticker: string,
  tier2Passed: boolean,
  tier2Decision: TriageDecision,
  tier2RejectionReason: string | null,
  tier2QuickChecks: Record<string, unknown> | null
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE stock_analyses SET
      tier2_passed = ?,
      tier2_decision = ?,
      tier2_rejection_reason = ?,
      tier2_quick_checks = ?
    WHERE screening_run_id = ? AND ticker = ?`,
    args: [
      tier2Passed ? 1 : 0,
      tier2Decision,
      tier2RejectionReason,
      tier2QuickChecks ? JSON.stringify(tier2QuickChecks) : null,
      screeningRunId,
      ticker,
    ],
  });
}

export async function updateTier3Results(
  screeningRunId: string,
  ticker: string,
  results: {
    dcfAnalysis?: string;
    dcfIntrinsicValue?: number;
    dcfUpsidePct?: number;
    comparableAnalysis?: string;
    comparableImpliedValue?: number;
    sentimentAnalysis?: string;
    sentimentScore?: number;
    riskAnalysis?: string;
    riskScore?: number;
    earningsAnalysis?: string;
    earningsSentiment?: EarningsSentiment;
    researchSummary?: string;
    investmentThesis?: string;
    convictionScore?: number;
    convictionBreakdown?: ConvictionBreakdown;
    convictionLevel?: ConvictionLevel;
    workflowsRun?: string[];
    analysisTimeSeconds?: number;
  }
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE stock_analyses SET
      tier3_completed = 1,
      dcf_analysis = COALESCE(?, dcf_analysis),
      dcf_intrinsic_value = COALESCE(?, dcf_intrinsic_value),
      dcf_upside_pct = COALESCE(?, dcf_upside_pct),
      comparable_analysis = COALESCE(?, comparable_analysis),
      comparable_implied_value = COALESCE(?, comparable_implied_value),
      sentiment_analysis = COALESCE(?, sentiment_analysis),
      sentiment_score = COALESCE(?, sentiment_score),
      risk_analysis = COALESCE(?, risk_analysis),
      risk_score = COALESCE(?, risk_score),
      earnings_analysis = COALESCE(?, earnings_analysis),
      earnings_sentiment = COALESCE(?, earnings_sentiment),
      research_summary = COALESCE(?, research_summary),
      investment_thesis = COALESCE(?, investment_thesis),
      conviction_score = COALESCE(?, conviction_score),
      conviction_breakdown = COALESCE(?, conviction_breakdown),
      conviction_level = COALESCE(?, conviction_level),
      workflows_run = COALESCE(?, workflows_run),
      analysis_time_seconds = COALESCE(?, analysis_time_seconds)
    WHERE screening_run_id = ? AND ticker = ?`,
    args: [
      results.dcfAnalysis ?? null,
      results.dcfIntrinsicValue ?? null,
      results.dcfUpsidePct ?? null,
      results.comparableAnalysis ?? null,
      results.comparableImpliedValue ?? null,
      results.sentimentAnalysis ?? null,
      results.sentimentScore ?? null,
      results.riskAnalysis ?? null,
      results.riskScore ?? null,
      results.earningsAnalysis ?? null,
      results.earningsSentiment ?? null,
      results.researchSummary ?? null,
      results.investmentThesis ?? null,
      results.convictionScore ?? null,
      results.convictionBreakdown ? JSON.stringify(results.convictionBreakdown) : null,
      results.convictionLevel ?? null,
      results.workflowsRun ? JSON.stringify(results.workflowsRun) : null,
      results.analysisTimeSeconds ?? null,
      screeningRunId,
      ticker,
    ],
  });
}

export async function getAnalysesForRun(
  screeningRunId: string,
  options: {
    tier1Passed?: boolean;
    tier2Passed?: boolean;
    tier3Completed?: boolean;
    minConvictionScore?: number;
    orderBy?: 'tier1_score' | 'conviction_score';
    limit?: number;
  } = {}
): Promise<StockAnalysis[]> {
  await initializeDatabase();
  const client = await getDbClient();

  let sql = 'SELECT * FROM stock_analyses WHERE screening_run_id = ?';
  const args: (string | number)[] = [screeningRunId];

  if (options.tier1Passed !== undefined) {
    sql += ' AND tier1_passed = ?';
    args.push(options.tier1Passed ? 1 : 0);
  }

  if (options.tier2Passed !== undefined) {
    sql += ' AND tier2_passed = ?';
    args.push(options.tier2Passed ? 1 : 0);
  }

  if (options.tier3Completed !== undefined) {
    sql += ' AND tier3_completed = ?';
    args.push(options.tier3Completed ? 1 : 0);
  }

  if (options.minConvictionScore !== undefined) {
    sql += ' AND conviction_score >= ?';
    args.push(options.minConvictionScore);
  }

  if (options.orderBy === 'conviction_score') {
    sql += ' ORDER BY conviction_score DESC NULLS LAST';
  } else {
    sql += ' ORDER BY tier1_score DESC NULLS LAST';
  }

  if (options.limit) {
    sql += ' LIMIT ?';
    args.push(options.limit);
  }

  const result = await client.execute({ sql, args });

  return result.rows.map(rowToStockAnalysis);
}

export async function getTopConvictionStocks(
  screeningRunId: string,
  limit: number = 20
): Promise<StockAnalysis[]> {
  return getAnalysesForRun(screeningRunId, {
    tier3Completed: true,
    orderBy: 'conviction_score',
    limit,
  });
}

// ============================================================================
// TRIAGE DECISION OPERATIONS
// ============================================================================

export async function recordTriageDecision(
  decision: Omit<TriageDecisionRecord, 'id' | 'decidedAt'>
): Promise<TriageDecisionRecord> {
  await initializeDatabase();
  const client = await getDbClient();

  const now = new Date().toISOString();

  const result = await client.execute({
    sql: `INSERT INTO triage_decisions (
      screening_run_id, ticker, tier, decision, reasoning,
      additional_checks_requested, additional_checks_results, final_decision, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      decision.screeningRunId,
      decision.ticker,
      decision.tier,
      decision.decision,
      decision.reasoning,
      decision.additionalChecksRequested ? JSON.stringify(decision.additionalChecksRequested) : null,
      decision.additionalChecksResults ? JSON.stringify(decision.additionalChecksResults) : null,
      decision.finalDecision,
      now,
    ],
  });

  return {
    ...decision,
    id: result.rows[0]?.id as number,
    decidedAt: now,
  };
}

export async function updateTriageDecisionFinal(
  id: number,
  additionalChecksResults: Record<string, unknown>,
  finalDecision: Exclude<TriageDecision, 'MORE_INFO'>
): Promise<void> {
  await initializeDatabase();
  const client = await getDbClient();

  await client.execute({
    sql: `UPDATE triage_decisions SET
      additional_checks_results = ?,
      final_decision = ?
    WHERE id = ?`,
    args: [JSON.stringify(additionalChecksResults), finalDecision, id],
  });
}

export async function getTriageDecisionsForRun(
  screeningRunId: string,
  tier?: 2 | 3
): Promise<TriageDecisionRecord[]> {
  await initializeDatabase();
  const client = await getDbClient();

  let sql = 'SELECT * FROM triage_decisions WHERE screening_run_id = ?';
  const args: (string | number)[] = [screeningRunId];

  if (tier !== undefined) {
    sql += ' AND tier = ?';
    args.push(tier);
  }

  sql += ' ORDER BY decided_at DESC';

  const result = await client.execute({ sql, args });

  return result.rows.map(rowToTriageDecision);
}

export async function getTriageDecisionForTicker(
  screeningRunId: string,
  ticker: string,
  tier: 2 | 3
): Promise<TriageDecisionRecord | null> {
  await initializeDatabase();
  const client = await getDbClient();

  const result = await client.execute({
    sql: 'SELECT * FROM triage_decisions WHERE screening_run_id = ? AND ticker = ? AND tier = ?',
    args: [screeningRunId, ticker, tier],
  });

  if (result.rows.length === 0) return null;

  return rowToTriageDecision(result.rows[0]);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function rowToScreeningRun(row: DbRow): ScreeningRun {
  return {
    id: row.id as string,
    portfolioId: row.portfolio_id as string | null,
    runType: row.run_type as ScreeningRunType,
    strategy: row.strategy as 'value' | 'growth' | 'balanced',
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | null,
    status: row.status as ScreeningRunStatus,
    tier1InputCount: row.tier1_input_count as number | null,
    tier1OutputCount: row.tier1_output_count as number | null,
    tier1CompletedAt: row.tier1_completed_at as string | null,
    tier2InputCount: row.tier2_input_count as number | null,
    tier2OutputCount: row.tier2_output_count as number | null,
    tier2RejectedCount: row.tier2_rejected_count as number | null,
    tier2CompletedAt: row.tier2_completed_at as string | null,
    tier3InputCount: row.tier3_input_count as number | null,
    tier3OutputCount: row.tier3_output_count as number | null,
    tier3CompletedAt: row.tier3_completed_at as string | null,
    finalPortfolioCount: row.final_portfolio_count as number | null,
    config: row.config ? JSON.parse(row.config as string) : null,
    errorMessage: row.error_message as string | null,
  };
}

function rowToStockAnalysis(row: DbRow): StockAnalysis {
  return {
    id: row.id as number,
    screeningRunId: row.screening_run_id as string,
    ticker: row.ticker as string,
    tier1Score: row.tier1_score as number | null,
    tier1Passed: Boolean(row.tier1_passed),
    tier2Passed: Boolean(row.tier2_passed),
    tier2Decision: row.tier2_decision as TriageDecision | null,
    tier2RejectionReason: row.tier2_rejection_reason as string | null,
    tier2QuickChecks: row.tier2_quick_checks ? JSON.parse(row.tier2_quick_checks as string) : null,
    tier3Completed: Boolean(row.tier3_completed),
    dcfAnalysis: row.dcf_analysis as string | null,
    dcfIntrinsicValue: row.dcf_intrinsic_value as number | null,
    dcfUpsidePct: row.dcf_upside_pct as number | null,
    comparableAnalysis: row.comparable_analysis as string | null,
    comparableImpliedValue: row.comparable_implied_value as number | null,
    sentimentAnalysis: row.sentiment_analysis as string | null,
    sentimentScore: row.sentiment_score as number | null,
    riskAnalysis: row.risk_analysis as string | null,
    riskScore: row.risk_score as number | null,
    earningsAnalysis: row.earnings_analysis as string | null,
    earningsSentiment: row.earnings_sentiment as EarningsSentiment | null,
    researchSummary: row.research_summary as string | null,
    investmentThesis: row.investment_thesis as string | null,
    convictionScore: row.conviction_score as number | null,
    convictionBreakdown: row.conviction_breakdown ? JSON.parse(row.conviction_breakdown as string) : null,
    convictionLevel: row.conviction_level as ConvictionLevel | null,
    workflowsRun: row.workflows_run ? JSON.parse(row.workflows_run as string) : null,
    analysisTimeSeconds: row.analysis_time_seconds as number | null,
    createdAt: row.created_at as string,
  };
}

function rowToTriageDecision(row: DbRow): TriageDecisionRecord {
  return {
    id: row.id as number,
    screeningRunId: row.screening_run_id as string,
    ticker: row.ticker as string,
    tier: row.tier as 2 | 3,
    decision: row.decision as TriageDecision,
    reasoning: row.reasoning as string,
    additionalChecksRequested: row.additional_checks_requested
      ? JSON.parse(row.additional_checks_requested as string)
      : null,
    additionalChecksResults: row.additional_checks_results
      ? JSON.parse(row.additional_checks_results as string)
      : null,
    finalDecision: row.final_decision as Exclude<TriageDecision, 'MORE_INFO'> | null,
    decidedAt: row.decided_at as string,
  };
}

// ============================================================================
// SUMMARY HELPERS
// ============================================================================

export interface ScreeningRunSummary {
  run: ScreeningRun;
  tier1PassedCount: number;
  tier2PassedCount: number;
  tier3CompletedCount: number;
  highConvictionCount: number;
  mediumConvictionCount: number;
  lowConvictionCount: number;
  avgConvictionScore: number | null;
  topStocks: Pick<StockAnalysis, 'ticker' | 'convictionScore' | 'convictionLevel' | 'investmentThesis'>[];
}

export async function getScreeningRunSummary(runId: string): Promise<ScreeningRunSummary | null> {
  const run = await getScreeningRun(runId);
  if (!run) return null;

  const analyses = await getAnalysesForRun(runId);

  const tier1Passed = analyses.filter((a) => a.tier1Passed);
  const tier2Passed = analyses.filter((a) => a.tier2Passed);
  const tier3Completed = analyses.filter((a) => a.tier3Completed);

  const withConviction = tier3Completed.filter((a) => a.convictionScore !== null);
  const highConviction = withConviction.filter((a) => a.convictionLevel === 'VERY_HIGH' || a.convictionLevel === 'HIGH');
  const mediumConviction = withConviction.filter((a) => a.convictionLevel === 'MODERATE');
  const lowConviction = withConviction.filter((a) => a.convictionLevel === 'LOW' || a.convictionLevel === 'VERY_LOW');

  const avgConviction =
    withConviction.length > 0
      ? withConviction.reduce((sum, a) => sum + (a.convictionScore || 0), 0) / withConviction.length
      : null;

  const topStocks = tier3Completed
    .filter((a) => a.convictionScore !== null)
    .sort((a, b) => (b.convictionScore || 0) - (a.convictionScore || 0))
    .slice(0, 10)
    .map((a) => ({
      ticker: a.ticker,
      convictionScore: a.convictionScore,
      convictionLevel: a.convictionLevel,
      investmentThesis: a.investmentThesis,
    }));

  return {
    run,
    tier1PassedCount: tier1Passed.length,
    tier2PassedCount: tier2Passed.length,
    tier3CompletedCount: tier3Completed.length,
    highConvictionCount: highConviction.length,
    mediumConvictionCount: mediumConviction.length,
    lowConvictionCount: lowConviction.length,
    avgConvictionScore: avgConviction,
    topStocks,
  };
}

// ============================================================================
// END OF REPOSITORY
// ============================================================================
