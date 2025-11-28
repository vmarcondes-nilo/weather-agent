# Intelligent Portfolio Builder - Implementation Plan

## Executive Summary

This plan outlines the implementation of an **Intelligent Tiered Portfolio Builder** that leverages all existing analysis tools and workflows through a hybrid architecture combining deterministic workflows with LLM-powered agent networks for intelligent decision-making.

### Current Gap
The existing `portfolioConstructionWorkflow` scores stocks using multi-factor quantitative analysis but **never runs** the deep analysis workflows (DCF, Comparable, Sentiment, Risk, Earnings) that we've built. This results in portfolio decisions based solely on surface-level metrics.

### Solution
A 3-tier funnel that progressively filters 500 stocks down to ~10 portfolio holdings, using intelligent agent networks to decide which analyses to run and how to interpret results.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     INTELLIGENT PORTFOLIO BUILDER                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TIER 1: QUANTITATIVE SCREENING (Workflow)                                  │
│  ├── Input: S&P 500 (~500 stocks)                                          │
│  ├── Process: scoreStocksBatchTool + basic filtering                       │
│  ├── Output: ~50-80 candidates                                             │
│  └── Time: ~2-3 minutes                                                    │
│                                                                             │
│                              ↓                                              │
│                                                                             │
│  TIER 2: INTELLIGENT TRIAGE (Agent Network)                                │
│  ├── Routing Agent: "Triage Coordinator"                                   │
│  ├── Available Tools: Quick sentiment, risk flags, earnings checks         │
│  ├── Decisions: Pass / Reject / Request more info                          │
│  ├── Output: ~20-25 finalists + rejection log                              │
│  └── Time: ~3-5 minutes                                                    │
│                                                                             │
│                              ↓                                              │
│                                                                             │
│  TIER 3: DEEP ANALYSIS (Agent Network)                                     │
│  ├── Routing Agent: "Research Coordinator"                                 │
│  ├── Available Workflows: DCF, Comparable, Sentiment, Risk, Earnings       │
│  ├── Decisions: Which workflows per stock based on characteristics         │
│  ├── Output: Full analysis + conviction score for each finalist            │
│  └── Time: ~15-25 minutes                                                  │
│                                                                             │
│                              ↓                                              │
│                                                                             │
│  FINAL: PORTFOLIO CONSTRUCTION (Workflow)                                  │
│  ├── Input: Analyzed finalists with conviction scores                      │
│  ├── Process: Rank by conviction, apply constraints, allocate              │
│  ├── Output: Portfolio of ~10-12 stocks                                    │
│  └── Time: ~1 minute                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Total Estimated Time: ~25-35 minutes
Total Estimated Cost: ~$8-15
```

---

## Technical Architecture: How Tiers Connect

### Mastra Integration Patterns

The Intelligent Portfolio Builder uses a **Master Workflow** that chains all tiers together. Each tier is implemented as a workflow step that internally calls either:
- **Another workflow** via `workflow.createRunAsync()` + `run.start()`
- **An agent network** via `agent.network("prompt")`

This hybrid approach gives us deterministic control flow with intelligent routing at key decision points.

### Master Workflow Structure

```typescript
// File: src/mastra/workflows/intelligent-portfolio-builder-workflow.ts

export const intelligentPortfolioBuilderWorkflow = createWorkflow({
  id: 'intelligent-portfolio-builder',
  inputSchema: masterInputSchema,
  outputSchema: masterOutputSchema,
})
  .then(tier1ScreeningStep)        // Workflow → Workflow
  .then(tier2TriageStep)           // Workflow → Agent Network
  .then(tier3ResearchStep)         // Workflow → Agent Network
  .then(portfolioConstructionStep) // Pure computation + DB
  .then(generateReportStep);       // AI synthesis

intelligentPortfolioBuilderWorkflow.commit();
```

### Pattern 1: Workflow Step Calling Another Workflow (Tier 1)

Tier 1 is a pure workflow that scores all stocks. The master workflow calls it via a step:

```typescript
const tier1ScreeningStep = createStep({
  id: 'tier1-screening',
  inputSchema: z.object({
    universe: z.array(z.string()).optional(),
    strategy: z.enum(['value', 'growth', 'balanced']),
    config: configSchema,
  }),
  outputSchema: tier1OutputSchema,

  execute: async ({ inputData, runtimeContext }) => {
    // Call the Tier 1 workflow
    const workflowRun = await tier1ScreeningWorkflow.createRunAsync();
    const result = await workflowRun.start({
      inputData: {
        universe: inputData.universe,
        strategy: inputData.strategy,
        minScore: inputData.config.tier1MinScore,
        maxCandidates: inputData.config.tier1MaxCandidates,
      }
    });

    if (result.status !== 'success') {
      throw new Error(`Tier 1 screening failed: ${result.error}`);
    }

    // Return output to pass to next step
    return result.result;
  },
});
```

### Pattern 2: Workflow Step Calling Agent Network (Tier 2)

Tier 2 uses an agent network for intelligent triage. The step iterates through candidates and routes each through the network:

```typescript
const tier2TriageStep = createStep({
  id: 'tier2-triage',
  inputSchema: tier1OutputSchema,
  outputSchema: tier2OutputSchema,

  execute: async ({ inputData }) => {
    const { screeningRunId, candidates } = inputData;
    const finalists: TriagedCandidate[] = [];
    const rejected: RejectedCandidate[] = [];

    // Process candidates through triage network
    for (const candidate of candidates) {
      const prompt = `
        Evaluate stock candidate for portfolio inclusion:
        - Ticker: ${candidate.ticker}
        - Tier 1 Score: ${candidate.score}
        - Sector: ${candidate.sector}
        - Key Metrics: P/E ${candidate.metrics.pe}, Beta ${candidate.metrics.beta}

        Run quick checks and decide: PASS, REJECT, or FAST_TRACK.
        Explain your reasoning.
      `;

      // Call the triage network
      const networkResult = await triageCoordinator.network(prompt);

      // Process streaming result
      let decision = null;
      for await (const chunk of networkResult) {
        if (chunk.type === 'network-execution-event-step-finish') {
          decision = parseTriageDecision(chunk.payload.result);
        }
      }

      // Route based on decision
      if (decision.action === 'PASS' || decision.action === 'FAST_TRACK') {
        finalists.push({
          ...candidate,
          triageDecision: decision.action,
          triageReasoning: decision.reasoning,
        });
      } else {
        rejected.push({
          ticker: candidate.ticker,
          reason: decision.reasoning,
        });
      }

      // Persist decision for transparency
      await logTriageDecision({
        screeningRunId,
        ticker: candidate.ticker,
        tier: 2,
        decision: decision.action,
        reasoning: decision.reasoning,
      });
    }

    return { screeningRunId, finalists, rejected };
  },
});
```

### Pattern 3: Agent Network Calling Workflows (Tier 3)

Tier 3's research network has access to all analysis workflows. The routing agent decides which to run:

```typescript
const tier3ResearchStep = createStep({
  id: 'tier3-research',
  inputSchema: tier2OutputSchema,
  outputSchema: tier3OutputSchema,

  execute: async ({ inputData }) => {
    const { screeningRunId, finalists } = inputData;
    const analyzedStocks: AnalyzedStock[] = [];

    // Process finalists through research network (with parallelism)
    const batchSize = 3; // Process 3 stocks concurrently
    for (let i = 0; i < finalists.length; i += batchSize) {
      const batch = finalists.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (finalist) => {
          const prompt = `
            Conduct deep analysis on ${finalist.ticker}:
            - Sector: ${finalist.sector}
            - Tier 1 Score: ${finalist.score}
            - Triage Decision: ${finalist.triageDecision}

            Based on stock characteristics, select and run appropriate workflows:
            - DCF Valuation (if positive FCF, stable business)
            - Comparable Analysis (if clear peer group)
            - Sentiment Analysis (for news-sensitive stocks)
            - Risk Assessment (always recommended)
            - Earnings Analysis (if recent earnings)

            After running analyses, calculate a conviction score (0-100).
          `;

          const networkResult = await researchCoordinator.network(prompt);

          // Extract analysis results from network
          let analysis = null;
          for await (const chunk of networkResult) {
            if (chunk.type === 'network-execution-event-step-finish') {
              analysis = parseResearchResult(chunk.payload.result);
            }
          }

          return {
            ...finalist,
            ...analysis,
          };
        })
      );

      analyzedStocks.push(...batchResults);
    }

    return { screeningRunId, analyzedStocks };
  },
});
```

### Data Flow Between Tiers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DATA FLOW DIAGRAM                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  INPUT                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ { universe: string[], strategy: string, config: {...} }             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  TIER 1 OUTPUT                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ {                                                                   │   │
│  │   screeningRunId: "run-123",                                        │   │
│  │   candidates: [                                                     │   │
│  │     { ticker: "AAPL", score: 72, sector: "Technology", metrics },   │   │
│  │     { ticker: "JNJ", score: 68, sector: "Healthcare", metrics },    │   │
│  │     ...                                                             │   │
│  │   ],                                                                │   │
│  │   totalScreened: 500,                                               │   │
│  │   passedCount: 65                                                   │   │
│  │ }                                                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  TIER 2 OUTPUT                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ {                                                                   │   │
│  │   screeningRunId: "run-123",                                        │   │
│  │   finalists: [                                                      │   │
│  │     { ticker: "AAPL", score: 72, triageDecision: "FAST_TRACK",     │   │
│  │       triageReasoning: "Strong fundamentals, positive sentiment" }, │   │
│  │     { ticker: "JNJ", score: 68, triageDecision: "PASS",            │   │
│  │       triageReasoning: "Stable dividend stock, low risk" },         │   │
│  │     ...                                                             │   │
│  │   ],                                                                │   │
│  │   rejected: [                                                       │   │
│  │     { ticker: "XYZ", reason: "High short interest, sell rating" }  │   │
│  │   ]                                                                 │   │
│  │ }                                                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  TIER 3 OUTPUT                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ {                                                                   │   │
│  │   screeningRunId: "run-123",                                        │   │
│  │   analyzedStocks: [                                                 │   │
│  │     {                                                               │   │
│  │       ticker: "AAPL",                                               │   │
│  │       tier1Score: 72,                                               │   │
│  │       convictionScore: 81,                                          │   │
│  │       convictionLevel: "HIGH",                                      │   │
│  │       dcfUpside: 15.2,                                              │   │
│  │       sentimentScore: 8,                                            │   │
│  │       riskScore: 7,                                                 │   │
│  │       workflowsRun: ["dcf", "sentiment", "risk"],                   │   │
│  │       investmentThesis: "Strong cash flows, AI tailwinds..."        │   │
│  │     },                                                              │   │
│  │     ...                                                             │   │
│  │   ]                                                                 │   │
│  │ }                                                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  FINAL OUTPUT                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ {                                                                   │   │
│  │   portfolioId: "portfolio-456",                                     │   │
│  │   holdings: [                                                       │   │
│  │     { ticker: "AAPL", shares: 45, allocation: 0.11, conviction: 81 }│   │
│  │   ],                                                                │   │
│  │   constructionReport: "Portfolio built with 10 high-conviction..."  │   │
│  │ }                                                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Memory Configuration for Networks

Agent networks require memory to track task completion. Both triage and research networks share a memory store:

```typescript
// File: src/mastra/networks/network-memory.ts

import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

export const networkMemory = new Memory({
  storage: new LibSQLStore({
    url: 'file:./data/network-memory.db'
  })
});

// Used by both networks
export const triageCoordinator = new Agent({
  name: 'Triage Coordinator',
  model: llm,
  instructions: triageInstructions,
  tools: triageTools,
  memory: networkMemory,  // Required for .network() calls
});

export const researchCoordinator = new Agent({
  name: 'Research Coordinator',
  model: llm,
  instructions: researchInstructions,
  tools: researchTools,
  workflows: researchWorkflows,
  memory: networkMemory,  // Required for .network() calls
});
```

### Error Handling & Graceful Degradation

Each tier handles failures gracefully:

```typescript
// In tier steps, use try/catch with fallbacks
execute: async ({ inputData }) => {
  const results = await Promise.allSettled(
    candidates.map(async (candidate) => {
      try {
        return await processCandidate(candidate);
      } catch (error) {
        // Log error but don't fail entire tier
        console.error(`Failed to process ${candidate.ticker}:`, error);
        return {
          ticker: candidate.ticker,
          status: 'failed',
          error: error.message,
        };
      }
    })
  );

  // Filter successful results
  const successful = results
    .filter(r => r.status === 'fulfilled' && r.value.status !== 'failed')
    .map(r => r.value);

  return { processed: successful, failed: results.length - successful.length };
};
```

---

## Database Schema Modifications

### New Tables Required

```sql
-- ============================================================================
-- SCREENING RUNS: Track each portfolio construction/review run
-- ============================================================================
CREATE TABLE IF NOT EXISTS screening_runs (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT,                          -- NULL for initial construction
  run_type TEXT NOT NULL CHECK (run_type IN ('CONSTRUCTION', 'MONTHLY_REVIEW')),
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

  -- Configuration used
  config TEXT,                                -- JSON with strategy, thresholds, etc.

  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
);

-- ============================================================================
-- STOCK ANALYSES: Store deep analysis results for each stock
-- ============================================================================
CREATE TABLE IF NOT EXISTS stock_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screening_run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,

  -- Tier progression
  tier1_score REAL,                           -- From scoreStocksBatch
  tier1_passed INTEGER DEFAULT 0,             -- 1 = passed to tier 2

  tier2_passed INTEGER DEFAULT 0,             -- 1 = passed to tier 3
  tier2_rejection_reason TEXT,                -- Why rejected (if applicable)
  tier2_quick_checks TEXT,                    -- JSON with quick check results

  tier3_completed INTEGER DEFAULT 0,          -- 1 = deep analysis done

  -- Deep analysis results (Tier 3)
  dcf_analysis TEXT,                          -- Full DCF analysis text
  dcf_intrinsic_value REAL,
  dcf_upside_pct REAL,

  comparable_analysis TEXT,                   -- Full comparable analysis text
  comparable_implied_value REAL,

  sentiment_analysis TEXT,                    -- Full sentiment analysis text
  sentiment_score REAL,                       -- 1-10 scale

  risk_analysis TEXT,                         -- Full risk analysis text
  risk_score REAL,                            -- 1-10 scale (10 = lowest risk)

  earnings_analysis TEXT,                     -- Earnings event analysis
  earnings_sentiment TEXT,                    -- beat/miss/inline

  -- Final synthesis
  research_summary TEXT,                      -- AI-generated summary
  investment_thesis TEXT,                     -- Bull/bear case

  -- Conviction scoring
  conviction_score REAL,                      -- Final score 0-100
  conviction_breakdown TEXT,                  -- JSON with component weights
  conviction_level TEXT CHECK (conviction_level IN ('HIGH', 'MEDIUM', 'LOW')),

  -- Metadata
  workflows_run TEXT,                         -- JSON array of workflow names run
  analysis_time_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (screening_run_id) REFERENCES screening_runs(id),
  UNIQUE(screening_run_id, ticker)
);

-- ============================================================================
-- TRIAGE DECISIONS: Log routing agent decisions for transparency
-- ============================================================================
CREATE TABLE IF NOT EXISTS triage_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screening_run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (2, 3)),

  decision TEXT NOT NULL CHECK (decision IN ('PASS', 'REJECT', 'FAST_TRACK', 'MORE_INFO')),
  reasoning TEXT NOT NULL,                    -- LLM's explanation

  -- For MORE_INFO decisions
  additional_checks_requested TEXT,           -- JSON array of tool names
  additional_checks_results TEXT,             -- JSON with results
  final_decision TEXT,                        -- After additional checks

  decided_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (screening_run_id) REFERENCES screening_runs(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_screening_runs_portfolio ON screening_runs(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_stock_analyses_run ON stock_analyses(screening_run_id);
CREATE INDEX IF NOT EXISTS idx_stock_analyses_ticker ON stock_analyses(ticker);
CREATE INDEX IF NOT EXISTS idx_triage_decisions_run ON triage_decisions(screening_run_id);
```

### Modifications to Existing Tables

```sql
-- Add conviction data to holdings table
ALTER TABLE holdings ADD COLUMN conviction_score REAL;
ALTER TABLE holdings ADD COLUMN conviction_level TEXT;
ALTER TABLE holdings ADD COLUMN last_analysis_id INTEGER REFERENCES stock_analyses(id);
ALTER TABLE holdings ADD COLUMN last_analysis_date TEXT;

-- Add analysis reference to transactions
ALTER TABLE transactions ADD COLUMN analysis_id INTEGER REFERENCES stock_analyses(id);
```

---

## Component Implementation Details

### Phase 1: Database & Repository Layer

#### 1.1 Schema Updates
**File:** `src/mastra/db/schema.ts`

Add new table definitions and types:
- `ScreeningRun` interface
- `StockAnalysis` interface
- `TriageDecision` interface
- Updated `Holding` interface with conviction fields
- Updated `Transaction` interface with analysis reference

#### 1.2 Repository Functions
**File:** `src/mastra/db/analysis-repository.ts` (NEW)

```typescript
// Screening run operations
createScreeningRun(run: ScreeningRun): Promise<ScreeningRun>
updateScreeningRunTier(id: string, tier: 1|2|3, results: TierResults): Promise<void>
completeScreeningRun(id: string, status: 'completed'|'failed'): Promise<void>
getScreeningRun(id: string): Promise<ScreeningRun | null>
getLatestScreeningRun(portfolioId?: string): Promise<ScreeningRun | null>

// Stock analysis operations
saveStockAnalysis(analysis: StockAnalysis): Promise<StockAnalysis>
updateStockAnalysisTier2(runId: string, ticker: string, data: Tier2Data): Promise<void>
updateStockAnalysisTier3(runId: string, ticker: string, data: Tier3Data): Promise<void>
getStockAnalyses(runId: string, tier?: number): Promise<StockAnalysis[]>
getLatestAnalysis(ticker: string): Promise<StockAnalysis | null>

// Triage decision operations
logTriageDecision(decision: TriageDecision): Promise<TriageDecision>
getTriageDecisions(runId: string, tier?: number): Promise<TriageDecision[]>
```

---

### Phase 2: Tier 1 - Quantitative Screening Workflow

#### 2.1 Screening Workflow
**File:** `src/mastra/workflows/tier1-screening-workflow.ts` (NEW)

**Purpose:** Deterministic batch scoring of entire stock universe

**Steps:**
1. `initializeScreeningRun` - Create screening run record, load universe
2. `batchScoreStocks` - Run `scoreStocksBatchTool` on all stocks
3. `filterCandidates` - Apply minimum thresholds
4. `persistTier1Results` - Save to database

**Input:**
```typescript
{
  universe?: string[];        // Default: S&P 500
  strategy?: 'value' | 'growth' | 'balanced';
  minScore?: number;          // Default: 45
  maxCandidates?: number;     // Default: 80
  portfolioId?: string;       // For monthly reviews
}
```

**Output:**
```typescript
{
  screeningRunId: string;
  candidateCount: number;
  candidates: Array<{
    ticker: string;
    score: number;
    sector: string;
    metrics: StockMetrics;
  }>;
  rejectedCount: number;
  executionTimeMs: number;
}
```

**Filtering Criteria (configurable):**
- `totalScore >= 45` (or configured minimum)
- `freeCashFlow > 0` (required for DCF)
- `peRatio > 0 && peRatio < 100` (exclude unprofitable or extreme)
- `marketCap > 1_000_000_000` (min $1B market cap)

---

### Phase 3: Tier 2 - Intelligent Triage Network

#### 3.1 Triage Coordinator Agent
**File:** `src/mastra/agents/triage-coordinator.ts` (NEW)

**Role:** Routing agent that decides which candidates pass to deep analysis

**Instructions:**
```
You are a Portfolio Triage Coordinator responsible for filtering stock candidates.

For each candidate, you will:
1. Review their quantitative score from Tier 1
2. Run quick checks (sentiment flags, risk flags, earnings status)
3. Decide: PASS, REJECT, FAST_TRACK, or request MORE_INFO

Decision Guidelines:
- FAST_TRACK: Score > 70, positive sentiment, low risk → Skip detailed checks
- PASS: Score > 55, no major red flags → Proceed to Tier 3
- REJECT: Consensus "Sell", extreme short interest, recent earnings miss, beta > 2.0
- MORE_INFO: Mixed signals → Request additional specific checks

Always explain your reasoning for transparency.
```

**Available Tools:**
- `getAnalystRatings` - Check consensus rating
- `getShortInterest` - Check squeeze risk / bearish sentiment
- `getEarningsSentiment` - Check recent earnings performance
- `getBetaVolatility` - Check risk level
- `getUpgradeDowngrade` - Check recent rating changes

#### 3.2 Quick Check Tool
**File:** `src/mastra/tools/triage-tools.ts` (NEW)

**Tool:** `quickTriageCheckTool`

**Purpose:** Batch quick checks for triage decisions

```typescript
{
  name: 'quickTriageCheck',
  description: 'Run quick sentiment, risk, and earnings checks for triage',
  inputSchema: z.object({
    ticker: z.string(),
    checks: z.array(z.enum([
      'analyst_ratings',
      'short_interest',
      'earnings_sentiment',
      'beta_volatility',
      'upgrade_downgrade'
    ])).optional()  // Default: all checks
  }),
  outputSchema: z.object({
    ticker: z.string(),
    analystConsensus: z.string().nullable(),
    shortRisk: z.string().nullable(),
    earningsSentiment: z.string().nullable(),
    beta: z.number().nullable(),
    recentUpgrades: z.number().nullable(),
    recentDowngrades: z.number().nullable(),
    redFlags: z.array(z.string()),
    greenFlags: z.array(z.string()),
    recommendation: z.enum(['PASS', 'REJECT', 'NEEDS_REVIEW'])
  })
}
```

#### 3.3 Triage Network Configuration
**File:** `src/mastra/networks/triage-network.ts` (NEW)

```typescript
const triageNetwork = new AgentNetwork({
  name: 'Portfolio Triage Network',
  routingAgent: triageCoordinatorAgent,
  agents: [],  // No sub-agents needed
  workflows: [],
  tools: [
    quickTriageCheckTool,
    getAnalystRatingsTool,
    getShortInterestTool,
    getEarningsSentimentTool,
    getBetaVolatilityTool,
    getUpgradeDowngradeTool
  ],
  memory: triageMemory  // Required for network
});
```

#### 3.4 Tier 2 Orchestration Workflow
**File:** `src/mastra/workflows/tier2-triage-workflow.ts` (NEW)

**Purpose:** Orchestrate triage network for all Tier 1 candidates

**Steps:**
1. `loadTier1Candidates` - Get candidates from screening run
2. `runTriageNetwork` - Process each candidate through network
3. `collectDecisions` - Aggregate pass/reject decisions
4. `persistTier2Results` - Save to database with reasoning

**Batch Processing:**
- Process candidates in batches of 10 (parallel)
- Rate limit to avoid API throttling
- Log each decision with reasoning

---

### Phase 4: Tier 3 - Deep Analysis Network

#### 4.1 Research Coordinator Agent
**File:** `src/mastra/agents/research-coordinator.ts` (NEW)

**Role:** Routing agent that selects appropriate analysis workflows per stock

**Instructions:**
```
You are a Research Coordinator responsible for conducting deep analysis on stock candidates.

For each stock, you will:
1. Review its characteristics (sector, growth profile, volatility, etc.)
2. Select which analysis workflows to run based on the stock's nature
3. Synthesize results into a conviction score

Workflow Selection Guidelines:

DCF Valuation:
- RUN if: Positive FCF, stable business, predictable cash flows
- SKIP if: Negative FCF, high-growth unprofitable, cyclical commodities
- ALWAYS for: Dividend stocks, value plays, mature companies

Comparable Analysis:
- RUN if: Clear peer group exists, relative valuation matters
- SKIP if: Unique business model, no good comps
- ALWAYS for: Banks, REITs, retail, any sector with clear peers

Sentiment Analysis:
- RUN if: News-driven stock, recent events, meme stock history
- LIGHTER for: Stable blue chips with less news sensitivity
- ALWAYS for: Tech, consumer discretionary, any stock with high retail interest

Risk Assessment:
- RUN if: High beta, volatile history, concentrated exposure
- LIGHTER for: Utilities, consumer staples, low-beta defensives
- ALWAYS for: Any stock being considered for significant position

Earnings Analysis:
- RUN if: Recent earnings (within 2 weeks), guidance changes, surprises
- SKIP if: No recent earnings event
- ALWAYS for: Stocks with earnings in last 30 days

After analysis, synthesize a conviction score (0-100) with breakdown.
```

**Available Workflows:**
- `dcfValuationWorkflow`
- `comparableAnalysisWorkflow`
- `sentimentAnalysisWorkflow`
- `riskAssessmentWorkflow`
- `earningsEventWorkflow`

#### 4.2 Conviction Scoring Tool
**File:** `src/mastra/tools/conviction-tools.ts` (NEW)

**Tool:** `calculateConvictionScoreTool`

**Purpose:** Synthesize all analyses into final conviction score

```typescript
{
  name: 'calculateConvictionScore',
  description: 'Calculate conviction score from deep analysis results',
  inputSchema: z.object({
    ticker: z.string(),
    tier1Score: z.number(),
    dcfResult: z.object({
      intrinsicValue: z.number().nullable(),
      currentPrice: z.number(),
      upsidePct: z.number().nullable()
    }).nullable(),
    sentimentResult: z.object({
      score: z.number(),  // 1-10
      consensus: z.string()
    }).nullable(),
    riskResult: z.object({
      score: z.number(),  // 1-10 (10 = lowest risk)
      level: z.string()
    }).nullable(),
    comparableResult: z.object({
      vspeers: z.string(),  // 'undervalued', 'fairly_valued', 'overvalued'
      impliedUpside: z.number().nullable()
    }).nullable(),
    earningsResult: z.object({
      sentiment: z.string(),  // 'beat', 'miss', 'inline'
      surprisePct: z.number().nullable()
    }).nullable()
  }),
  outputSchema: z.object({
    ticker: z.string(),
    convictionScore: z.number(),  // 0-100
    convictionLevel: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    breakdown: z.object({
      quantitativeScore: z.number(),      // 30% weight
      valuationScore: z.number(),         // 25% weight
      sentimentScore: z.number(),         // 20% weight
      riskAdjustedScore: z.number(),      // 15% weight
      catalystScore: z.number()           // 10% weight
    }),
    summary: z.string()
  })
}
```

**Scoring Formula:**
```
convictionScore =
  (tier1Score * 0.30) +                    // Quantitative foundation
  (valuationScore * 0.25) +                // DCF + Comparable upside
  (sentimentScore * 0.20) +                // Analyst + news sentiment
  (riskAdjustedScore * 0.15) +             // Risk score (inverted)
  (catalystScore * 0.10)                   // Earnings momentum

Where:
- valuationScore = normalize(avg(dcfUpside, comparableUpside))
- sentimentScore = sentiment.score * 10
- riskAdjustedScore = risk.score * 10
- catalystScore = based on earnings beat/miss + upgrades
```

#### 4.3 Research Network Configuration
**File:** `src/mastra/networks/research-network.ts` (NEW)

```typescript
const researchNetwork = new AgentNetwork({
  name: 'Deep Research Network',
  routingAgent: researchCoordinatorAgent,
  agents: [
    fundamentalAnalyst,
    sentimentAnalyst,
    riskAnalyst
  ],
  workflows: [
    dcfValuationWorkflow,
    comparableAnalysisWorkflow,
    sentimentAnalysisWorkflow,
    riskAssessmentWorkflow,
    earningsEventWorkflow
  ],
  tools: [
    calculateConvictionScoreTool,
    getSectorExposureTool
  ],
  memory: researchMemory
});
```

#### 4.4 Tier 3 Orchestration Workflow
**File:** `src/mastra/workflows/tier3-research-workflow.ts` (NEW)

**Purpose:** Orchestrate research network for all Tier 2 finalists

**Steps:**
1. `loadTier2Finalists` - Get passed candidates from triage
2. `enrichWithContext` - Add sector, peer info for routing decisions
3. `runResearchNetwork` - Process each finalist through network
4. `calculateConviction` - Compute final conviction scores
5. `persistTier3Results` - Save full analysis to database

**Parallel Processing:**
- Process 3-5 stocks concurrently
- Each stock takes ~60-90 seconds
- Total: ~15-25 minutes for 20-25 finalists

---

### Phase 5: Final Portfolio Construction Workflow

#### 5.1 Portfolio Construction Workflow
**File:** `src/mastra/workflows/intelligent-portfolio-construction.ts` (NEW)

**Purpose:** Build optimal portfolio from analyzed finalists

**Steps:**
1. `loadAnalyzedFinalists` - Get Tier 3 results with conviction scores
2. `rankByConviction` - Sort by conviction, apply minimum threshold
3. `applySectorConstraints` - Enforce max 25% per sector
4. `selectPortfolioHoldings` - Pick top 10-12 diversified holdings
5. `allocateCapital` - Weight by conviction (min 5%, max 12% per position)
6. `createPortfolioRecords` - Save portfolio, holdings, transactions
7. `generateConstructionReport` - AI summary of selections

**Allocation Formula:**
```
For each selected stock:
  rawWeight = convictionScore / sum(allConvictionScores)
  adjustedWeight = clamp(rawWeight, minPositionPct, maxPositionPct)

Normalize weights to sum to (1 - cashReserve)
```

**Output:**
```typescript
{
  portfolioId: string;
  holdings: Array<{
    ticker: string;
    shares: number;
    allocation: number;
    convictionScore: number;
    convictionLevel: string;
    investmentThesis: string;
  }>;
  sectorBreakdown: Record<string, number>;
  totalInvested: number;
  cashReserve: number;
  constructionReport: string;
}
```

---

### Phase 6: Master Orchestration

#### 6.1 Intelligent Portfolio Builder Agent
**File:** `src/mastra/agents/intelligent-portfolio-builder.ts` (NEW)

**Role:** Top-level agent that orchestrates the entire process

**Instructions:**
```
You are the Intelligent Portfolio Builder, responsible for constructing
high-conviction portfolios through comprehensive analysis.

Your process:
1. Run Tier 1 screening on the stock universe
2. Coordinate Tier 2 triage to filter candidates
3. Orchestrate Tier 3 deep research on finalists
4. Construct the final portfolio with conviction-weighted allocations

Provide status updates at each tier transition.
Report any issues or anomalies encountered.
Generate a final construction report summarizing the process.
```

#### 6.2 Master Workflow
**File:** `src/mastra/workflows/intelligent-portfolio-builder-workflow.ts` (NEW)

**Purpose:** Chain all tiers together

```typescript
export const intelligentPortfolioBuilderWorkflow = createWorkflow({
  id: 'intelligent-portfolio-builder',
  inputSchema: z.object({
    universe: z.array(z.string()).optional(),
    strategy: z.enum(['value', 'growth', 'balanced']).default('value'),
    initialCapital: z.number().default(100000),
    targetHoldings: z.number().default(10),
    config: z.object({
      tier1MinScore: z.number().default(45),
      tier2MaxCandidates: z.number().default(25),
      tier3MinConviction: z.number().default(60),
      maxSectorPct: z.number().default(0.25),
      minPositionPct: z.number().default(0.05),
      maxPositionPct: z.number().default(0.12)
    }).optional()
  }),
  outputSchema: portfolioConstructionOutputSchema
})
  .then(tier1ScreeningStep)
  .then(tier2TriageStep)
  .then(tier3ResearchStep)
  .then(portfolioConstructionStep)
  .then(generateReportStep);
```

---

### Phase 7: Monthly Review Workflow

#### 7.1 Intelligent Monthly Review Workflow
**File:** `src/mastra/workflows/intelligent-monthly-review-workflow.ts` (NEW)

**Purpose:** Re-evaluate portfolio and identify trades

**Steps:**
1. `loadCurrentPortfolio` - Get holdings with last analysis dates
2. `reanalyzeHoldings` - Run Tier 3 on all current holdings
3. `identifyWeakHoldings` - Flag holdings with declining conviction
4. `screenReplacements` - Run Tier 1+2 on same-sector candidates
5. `analyzeReplacements` - Run Tier 3 on top replacement candidates
6. `compareAndDecide` - Compare current vs replacement conviction
7. `executeTradesifApproved` - Swap positions (max 3-5 trades/month)
8. `createMonthlySnapshot` - Record performance and decisions

**Trade Decision Logic:**
```
For each holding:
  if currentConviction < 50:
    FLAG as SELL candidate
  elif currentConviction dropped > 15 points:
    FLAG as REVIEW candidate

For flagged holdings:
  Find same-sector replacements with conviction > current + 10
  Recommend swap if replacement significantly better

Limit to max 5 trades per month for low turnover
```

---

## File Structure Summary

```
src/mastra/
├── agents/
│   ├── triage-coordinator.ts          (NEW)
│   ├── research-coordinator.ts        (NEW)
│   └── intelligent-portfolio-builder.ts (NEW)
│
├── networks/
│   ├── triage-network.ts              (NEW)
│   └── research-network.ts            (NEW)
│
├── tools/
│   ├── triage-tools.ts                (NEW)
│   └── conviction-tools.ts            (NEW)
│
├── workflows/
│   ├── tier1-screening-workflow.ts    (NEW)
│   ├── tier2-triage-workflow.ts       (NEW)
│   ├── tier3-research-workflow.ts     (NEW)
│   ├── intelligent-portfolio-construction.ts (NEW)
│   ├── intelligent-portfolio-builder-workflow.ts (NEW)
│   └── intelligent-monthly-review-workflow.ts (NEW)
│
└── db/
    ├── schema.ts                      (MODIFY - add new tables)
    └── analysis-repository.ts         (NEW)
```

---

## Implementation Order

The implementation follows a **bottom-up approach**: build each tier independently, test it, then connect them via the master workflow at the end.

### Phase 1: Foundation (Database Layer)
| # | Task | File | Dependencies |
|---|------|------|--------------|
| 1 | Database schema updates | `src/mastra/db/schema.ts` | None |
| 2 | Analysis repository functions | `src/mastra/db/analysis-repository.ts` | #1 |
| 3 | Network memory configuration | `src/mastra/networks/network-memory.ts` | None |

**Deliverable:** Database ready to persist screening runs, stock analyses, and triage decisions.

---

### Phase 2: Tier 1 - Quantitative Screening
| # | Task | File | Dependencies |
|---|------|------|--------------|
| 4 | Tier 1 screening workflow | `src/mastra/workflows/tier1-screening-workflow.ts` | #1, #2 |

**Deliverable:** Standalone workflow that screens S&P 500 and outputs ~50-80 candidates.

**Test:** Run `tier1ScreeningWorkflow.execute({ universe: ALL_SP500_TICKERS })` and verify:
- Candidates are scored and filtered
- Results persist to `screening_runs` and `stock_analyses` tables

---

### Phase 3: Tier 2 - Intelligent Triage
| # | Task | File | Dependencies |
|---|------|------|--------------|
| 5 | Quick triage check tool | `src/mastra/tools/triage-tools.ts` | None |
| 6 | Triage coordinator agent | `src/mastra/agents/triage-coordinator.ts` | #3, #5 |
| 7 | Tier 2 triage step (standalone test) | `src/mastra/workflows/tier2-triage-step.ts` | #5, #6 |

**Deliverable:** Agent network that evaluates candidates and makes PASS/REJECT/FAST_TRACK decisions.

**Test:** Feed mock Tier 1 output to triage network and verify:
- Decisions are logged with reasoning
- ~25 finalists pass to Tier 3
- Rejections include explanations

---

### Phase 4: Tier 3 - Deep Analysis
| # | Task | File | Dependencies |
|---|------|------|--------------|
| 8 | Conviction scoring tool | `src/mastra/tools/conviction-tools.ts` | None |
| 9 | Research coordinator agent | `src/mastra/agents/research-coordinator.ts` | #3, #8, existing workflows |
| 10 | Tier 3 research step (standalone test) | `src/mastra/workflows/tier3-research-step.ts` | #8, #9 |

**Deliverable:** Agent network that runs appropriate analysis workflows and calculates conviction scores.

**Test:** Feed mock Tier 2 finalists to research network and verify:
- Appropriate workflows run per stock type
- Conviction scores calculated
- Analysis results persist to database

---

### Phase 5: Portfolio Construction
| # | Task | File | Dependencies |
|---|------|------|--------------|
| 11 | Portfolio construction step | `src/mastra/workflows/portfolio-construction-step.ts` | #1, #2 |

**Deliverable:** Workflow step that ranks analyzed stocks and creates portfolio.

**Test:** Feed mock Tier 3 output and verify:
- Stocks ranked by conviction
- Sector constraints applied
- Portfolio created in database

---

### Phase 6: Master Workflow Integration
| # | Task | File | Dependencies |
|---|------|------|--------------|
| 12 | Master workflow | `src/mastra/workflows/intelligent-portfolio-builder-workflow.ts` | #4, #7, #10, #11 |
| 13 | Register in Mastra index | `src/mastra/index.ts` | #12 |

**Deliverable:** Complete workflow that chains Tier 1 → Tier 2 → Tier 3 → Construction.

**Test:** Run full workflow with small sample (20 stocks) and verify:
- All tiers execute in sequence
- Data flows correctly between tiers
- Final portfolio created with analyzed holdings

---

### Phase 7: Monthly Review
| # | Task | File | Dependencies |
|---|------|------|--------------|
| 14 | Monthly review workflow | `src/mastra/workflows/intelligent-monthly-review-workflow.ts` | #7, #10, #11 |

**Deliverable:** Workflow that re-analyzes holdings and identifies trades.

**Test:** Run on existing portfolio and verify:
- Current holdings re-analyzed
- Weak holdings flagged
- Replacement candidates evaluated
- Trades recommended (not executed without approval)

---

### Phase 8: Testing & Refinement
| # | Task | Description |
|---|------|-------------|
| 15 | End-to-end test | Full construction with 100-stock sample |
| 16 | Performance tuning | Optimize batch sizes, parallelism |
| 17 | Cost monitoring | Track API calls and LLM tokens |
| 18 | Documentation | Usage guide and examples |

---

### Implementation Dependency Graph

```
                    ┌─────────────────┐
                    │  1. DB Schema   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
      ┌───────────┐  ┌───────────┐  ┌───────────────┐
      │ 2. Repo   │  │ 3. Memory │  │ 5. Triage     │
      │ Functions │  │   Config  │  │    Tools      │
      └─────┬─────┘  └─────┬─────┘  └───────┬───────┘
            │              │                │
            ▼              │                ▼
      ┌───────────┐        │        ┌───────────────┐
      │ 4. Tier 1 │        │        │ 6. Triage     │
      │ Workflow  │        │        │    Agent      │
      └─────┬─────┘        │        └───────┬───────┘
            │              │                │
            │              └────────┬───────┘
            │                       │
            │               ┌───────▼───────┐
            │               │ 7. Tier 2     │
            │               │    Step       │
            │               └───────┬───────┘
            │                       │
            │    ┌──────────────────┘
            │    │
            │    │  ┌───────────────┐
            │    │  │ 8. Conviction │
            │    │  │    Tool       │
            │    │  └───────┬───────┘
            │    │          │
            │    │  ┌───────▼───────┐
            │    │  │ 9. Research   │
            │    │  │    Agent      │
            │    │  └───────┬───────┘
            │    │          │
            │    │  ┌───────▼───────┐
            │    │  │ 10. Tier 3    │
            │    │  │     Step      │
            │    │  └───────┬───────┘
            │    │          │
            │    └──────────┼──────────┐
            │               │          │
            ▼               ▼          ▼
      ┌─────────────────────────────────────┐
      │  11. Portfolio Construction Step    │
      └──────────────────┬──────────────────┘
                         │
                         ▼
      ┌─────────────────────────────────────┐
      │  12. MASTER WORKFLOW                │
      │  (Chains all tiers together)        │
      └──────────────────┬──────────────────┘
                         │
                         ▼
      ┌─────────────────────────────────────┐
      │  14. Monthly Review Workflow        │
      └─────────────────────────────────────┘
```

---

## Configuration Defaults

```typescript
const DEFAULT_CONFIG = {
  // Tier 1 - Screening
  tier1: {
    minScore: 45,
    maxCandidates: 80,
    requirePositiveFCF: true,
    maxPE: 100,
    minMarketCap: 1_000_000_000
  },

  // Tier 2 - Triage
  tier2: {
    fastTrackMinScore: 70,
    passMinScore: 55,
    maxBeta: 2.0,
    rejectOnSellConsensus: true,
    rejectOnExtremeShortInterest: true,
    rejectOnEarningsMiss: true,  // 2 consecutive misses
    maxCandidates: 25
  },

  // Tier 3 - Research
  tier3: {
    minConviction: 60,
    parallelAnalyses: 3,
    timeoutPerStock: 120_000  // 2 minutes
  },

  // Portfolio Construction
  portfolio: {
    targetHoldings: 10,
    minPositionPct: 0.05,
    maxPositionPct: 0.12,
    maxSectorPct: 0.25,
    cashReservePct: 0.05
  },

  // Monthly Review
  review: {
    maxTradesPerMonth: 5,
    sellThreshold: 50,        // Conviction below this = sell candidate
    convictionDropThreshold: 15,  // Drop this much = review
    replacementMinDelta: 10   // Replacement must be 10+ points better
  }
};
```

---

## Estimated Costs & Times

| Phase | Time | API Calls | Est. Cost |
|-------|------|-----------|-----------|
| Tier 1 Screening | 2-3 min | ~1000 (batch YF) | ~$0.10-0.20 |
| Tier 2 Triage | 3-5 min | ~400 (quick checks) + LLM routing | ~$0.50-1.00 |
| Tier 3 Research | 15-25 min | ~500-800 (deep analysis) + LLM | ~$5-10 |
| Portfolio Construction | 1 min | ~10 + LLM | ~$0.20 |
| **Total Construction** | **~25-35 min** | **~2000** | **~$6-12** |
| Monthly Review | 10-15 min | ~300-500 | ~$2-5 |

---

## Success Metrics

1. **Conviction Accuracy**: Track if high-conviction picks outperform low-conviction
2. **Triage Efficiency**: % of Tier 2 rejects that would have failed Tier 3
3. **Analysis Coverage**: % of finalists with complete analysis (all workflows run)
4. **Portfolio Performance**: Returns vs SPY benchmark
5. **Turnover Efficiency**: Performance impact per trade

---

## Open Questions / Future Enhancements

1. **Caching**: Should we cache Tier 1 scores for 24h to speed up re-runs?
2. **Partial Re-analysis**: On monthly review, skip workflows if data unchanged?
3. **User Preferences**: Allow users to adjust conviction weights?
4. **Alerts**: Trigger re-analysis on significant news/earnings events?
5. **Backtest Mode**: Run historical simulations with this methodology?

---

## Next Steps

1. Review and approve this plan
2. Clarify any open questions
3. Begin implementation with Phase 1 (Database)
4. Iterate based on testing results

---

## Summary: Files to Create/Modify

### New Files (14 total)

| File | Type | Purpose |
|------|------|---------|
| `src/mastra/db/analysis-repository.ts` | Repository | CRUD for screening_runs, stock_analyses, triage_decisions |
| `src/mastra/networks/network-memory.ts` | Config | Shared memory for agent networks |
| `src/mastra/tools/triage-tools.ts` | Tool | Quick triage check tool |
| `src/mastra/tools/conviction-tools.ts` | Tool | Conviction score calculator |
| `src/mastra/agents/triage-coordinator.ts` | Agent | Tier 2 routing agent |
| `src/mastra/agents/research-coordinator.ts` | Agent | Tier 3 routing agent |
| `src/mastra/workflows/tier1-screening-workflow.ts` | Workflow | Quantitative screening |
| `src/mastra/workflows/tier2-triage-step.ts` | Step | Triage network integration |
| `src/mastra/workflows/tier3-research-step.ts` | Step | Research network integration |
| `src/mastra/workflows/portfolio-construction-step.ts` | Step | Final portfolio construction |
| `src/mastra/workflows/intelligent-portfolio-builder-workflow.ts` | **Master** | Chains all tiers |
| `src/mastra/workflows/intelligent-monthly-review-workflow.ts` | Workflow | Monthly review |

### Modified Files (2 total)

| File | Changes |
|------|---------|
| `src/mastra/db/schema.ts` | Add 3 new tables, modify holdings/transactions |
| `src/mastra/index.ts` | Register new workflows and agents |

### Directory to Create

```
src/mastra/networks/    # New directory for network configurations
```

---

*Plan Version: 1.1*
*Created: November 2024*
*Updated: November 2024 - Added technical architecture section*
*Author: AI Assistant with Human Collaboration*
