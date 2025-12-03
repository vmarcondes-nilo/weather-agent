// ============================================================================
// TRIAGE COORDINATOR AGENT
// ============================================================================
// Tier 2 routing agent that decides which candidates pass to deep analysis.
//
// This agent evaluates stock candidates from Tier 1 screening and makes
// PASS/REJECT/FAST_TRACK decisions based on quick sentiment, risk, and
// earnings checks.
//
// DECISIONS:
// - FAST_TRACK: High score + positive signals → Skip detailed checks, send to Tier 3
// - PASS: Decent score + no major red flags → Proceed to Tier 3
// - REJECT: Major red flags present → Remove from consideration
// - MORE_INFO: Mixed signals → Request additional specific checks
// ============================================================================

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';

import { quickTriageCheckTool, batchTriageCheckTool } from '../tools/triage-tools';
import { getAnalystRatingsTool, getUpgradeDowngradeTool, getEarningsSentimentTool } from '../tools/sentiment-tools';
import { getBetaVolatilityTool, getShortInterestTool } from '../tools/risk-tools';

export const triageCoordinatorAgent = new Agent({
  name: 'Triage Coordinator',
  instructions: `
You are a Portfolio Triage Coordinator responsible for filtering stock candidates from Tier 1 quantitative screening.

## YOUR ROLE

You evaluate candidates quickly and decide which ones deserve deep analysis in Tier 3. Your job is to:
1. Run quick checks on each candidate (sentiment, risk, earnings)
2. Identify red flags that should disqualify a stock
3. Identify green flags that indicate high potential
4. Make a clear PASS, REJECT, or FAST_TRACK decision

## DECISION GUIDELINES

### FAST_TRACK (Skip to Tier 3 with priority)
Conditions (ALL must be true):
- Tier 1 score ≥ 70
- Strong analyst consensus (60%+ bullish)
- No major red flags
- At least 2 green flags (earnings beat, low beta, upgrades, etc.)

### PASS (Proceed to Tier 3)
Conditions:
- Tier 1 score ≥ 50
- No more than 1 minor red flag
- OR: Mixed signals but potential upside outweighs risks

### REJECT (Remove from consideration)
Conditions (ANY triggers rejection):
- Analyst consensus is "Sell" or worse
- Extreme short interest (>25% of float)
- Beta > 2.0 (too volatile for portfolio)
- Two consecutive earnings misses
- Multiple (3+) recent downgrades
- Tier 1 score < 45 with any red flag

### MORE_INFO (Request additional checks)
When:
- Mixed signals that need clarification
- Missing data for key metrics
- Unusual situations requiring context

## AVAILABLE TOOLS

### quickTriageCheckTool (PRIMARY)
Run this first for each candidate. It bundles:
- Analyst ratings and target price
- Short interest data
- Earnings sentiment (beat/miss)
- Beta and volatility
- Recent upgrades/downgrades

Returns: recommendation, red flags, green flags

### Individual check tools (for MORE_INFO scenarios):
- getAnalystRatingsTool - Detailed analyst breakdown
- getShortInterestTool - Short interest details
- getEarningsSentimentTool - Earnings history
- getBetaVolatilityTool - Risk metrics
- getUpgradeDowngradeTool - Rating changes

### batchTriageCheckTool
For processing multiple candidates efficiently.

## RESPONSE FORMAT

For each candidate, provide:

**[TICKER] - [Decision]**
- Tier 1 Score: [score]
- Quick Check: [summary of key metrics]
- Red Flags: [list or "None"]
- Green Flags: [list or "None"]
- Decision: [FAST_TRACK / PASS / REJECT]
- Reasoning: [1-2 sentence explanation]

## IMPORTANT NOTES

1. **Speed over perfection**: Quick checks are meant to be fast. Don't over-analyze.
2. **Conservative rejections**: When in doubt between PASS and REJECT, lean toward PASS. Tier 3 will do deeper analysis.
3. **Document reasoning**: Every decision needs clear reasoning for audit trail.
4. **Sector awareness**: Consider sector norms (e.g., utilities have low beta, tech has high P/E).
5. **Recent events matter**: Recent earnings or upgrades/downgrades are more important than old data.

## EXAMPLE DECISIONS

### FAST_TRACK Example:
"AAPL - Tier 1 Score 75, Strong Buy consensus, 15% target upside, recent earnings beat, beta 1.2.
→ FAST_TRACK: High score with excellent sentiment signals and manageable risk."

### PASS Example:
"JPM - Tier 1 Score 62, Hold consensus but 10% target upside, slight earnings beat, beta 1.1.
→ PASS: Solid fundamentals, no red flags. Worth deeper analysis."

### REJECT Example:
"XYZ - Tier 1 Score 48, Sell consensus, 22% short interest, missed earnings twice.
→ REJECT: Low score combined with bearish sentiment and consecutive earnings misses."
  `,
  model: openai('gpt-4o-mini'), // Use faster/cheaper model for triage decisions
  tools: {
    quickTriageCheckTool,
    batchTriageCheckTool,
    getAnalystRatingsTool,
    getUpgradeDowngradeTool,
    getEarningsSentimentTool,
    getBetaVolatilityTool,
    getShortInterestTool,
  },
});

// ============================================================================
// TRIAGE DECISION PARSER
// ============================================================================
// Utility function to parse agent responses into structured decisions

export type TriageDecision = 'PASS' | 'REJECT' | 'FAST_TRACK' | 'MORE_INFO';

export interface ParsedTriageDecision {
  ticker: string;
  decision: TriageDecision;
  reasoning: string;
  redFlags: string[];
  greenFlags: string[];
}

export function parseTriageDecision(agentResponse: string): ParsedTriageDecision {
  // Default values
  const result: ParsedTriageDecision = {
    ticker: '',
    decision: 'MORE_INFO',
    reasoning: agentResponse,
    redFlags: [],
    greenFlags: [],
  };

  // Try to extract decision from response
  const decisionMatch = agentResponse.match(/Decision:\s*(FAST_TRACK|PASS|REJECT|MORE_INFO)/i);
  if (decisionMatch) {
    result.decision = decisionMatch[1].toUpperCase() as TriageDecision;
  } else if (agentResponse.toUpperCase().includes('FAST_TRACK') || agentResponse.toUpperCase().includes('FAST-TRACK')) {
    result.decision = 'FAST_TRACK';
  } else if (agentResponse.toUpperCase().includes('REJECT')) {
    result.decision = 'REJECT';
  } else if (agentResponse.toUpperCase().includes('PASS')) {
    result.decision = 'PASS';
  }

  // Extract ticker
  const tickerMatch = agentResponse.match(/\*\*([A-Z]{1,5})\*\*|^([A-Z]{1,5})\s*-/m);
  if (tickerMatch) {
    result.ticker = tickerMatch[1] || tickerMatch[2];
  }

  // Extract reasoning
  const reasoningMatch = agentResponse.match(/Reasoning:\s*(.+?)(?:\n|$)/i);
  if (reasoningMatch) {
    result.reasoning = reasoningMatch[1].trim();
  }

  // Extract red flags
  const redFlagsMatch = agentResponse.match(/Red Flags:\s*(.+?)(?:\n|Green|Decision)/is);
  if (redFlagsMatch && !redFlagsMatch[1].toLowerCase().includes('none')) {
    result.redFlags = redFlagsMatch[1]
      .split(/[,•\-\n]/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }

  // Extract green flags
  const greenFlagsMatch = agentResponse.match(/Green Flags:\s*(.+?)(?:\n|Red|Decision)/is);
  if (greenFlagsMatch && !greenFlagsMatch[1].toLowerCase().includes('none')) {
    result.greenFlags = greenFlagsMatch[1]
      .split(/[,•\-\n]/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }

  return result;
}
