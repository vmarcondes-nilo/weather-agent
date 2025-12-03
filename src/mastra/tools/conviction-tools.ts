// ============================================================================
// CONVICTION SCORING TOOLS
// ============================================================================
// Tools for Tier 3 deep analysis conviction scoring in the Intelligent
// Portfolio Builder.
//
// These tools calculate final conviction scores based on:
// - DCF valuation (intrinsic value vs market price)
// - Comparable analysis (peer relative valuation)
// - Sentiment analysis (market perception)
// - Risk assessment (volatility, drawdown risk)
// - Earnings analysis (quality, consistency, guidance)
//
// The conviction score determines final portfolio inclusion and position sizing.
// ============================================================================

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ============================================================================
// TYPES
// ============================================================================

export type ConvictionLevel = 'VERY_HIGH' | 'HIGH' | 'MODERATE' | 'LOW' | 'VERY_LOW';

export interface ConvictionScoreResult {
  ticker: string;
  companyName: string;
  sector: string | null;
  currentPrice: number;

  // Component scores (0-100)
  valuationScore: number;
  sentimentScore: number;
  riskScore: number; // Higher = lower risk (inverted)
  earningsScore: number;
  qualityScore: number;

  // Derived metrics
  dcfUpside: number | null;
  peerUpside: number | null;
  compositeUpside: number | null;

  // Final conviction
  convictionScore: number; // 0-100
  convictionLevel: ConvictionLevel;
  convictionReasoning: string;

  // Position sizing suggestion
  suggestedWeight: number; // % of portfolio (0-10)
  maxWeight: number; // Risk-adjusted max

  // Key factors
  bullFactors: string[];
  bearFactors: string[];
  keyRisks: string[];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalize a score to 0-100 range
 */
function normalizeScore(value: number, min: number, max: number, invert = false): number {
  const normalized = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return invert ? 100 - normalized : normalized;
}

/**
 * Parse intrinsic value from DCF analysis text
 * Looks for patterns like "INTRINSIC VALUE PER SHARE: $123.45"
 */
export function parseIntrinsicValueFromText(text: string): number | null {
  const patterns = [
    /INTRINSIC VALUE PER SHARE:\s*\$?([\d,]+\.?\d*)/i,
    /intrinsic value[:\s]+\$?([\d,]+\.?\d*)/i,
    /fair value[:\s]+\$?([\d,]+\.?\d*)/i,
    /intrinsic value per share[:\s]+\$?([\d,]+\.?\d*)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(value) && value > 0) {
        return value;
      }
    }
  }

  return null;
}

/**
 * Parse implied value from comparable analysis text
 * Looks for patterns like "implied value: $123.45" or "peer-implied price: $123"
 */
export function parseComparableImpliedValueFromText(text: string): number | null {
  const patterns = [
    /implied\s+(?:fair\s+)?value[:\s]+\$?([\d,]+\.?\d*)/i,
    /peer[- ]implied\s+(?:price|value)[:\s]+\$?([\d,]+\.?\d*)/i,
    /comparable\s+value[:\s]+\$?([\d,]+\.?\d*)/i,
    /target\s+price[:\s]+\$?([\d,]+\.?\d*)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(value) && value > 0) {
        return value;
      }
    }
  }

  return null;
}

/**
 * Parse upside percentage from analysis text
 * Looks for patterns like "+25%", "25% upside", etc.
 */
function parseUpsideFromText(text: string): number | null {
  // Try multiple patterns
  const patterns = [
    /(\+|-)?\d+(\.\d+)?%\s*(upside|downside|potential)/i,
    /(upside|downside|potential)[:\s]+(\+|-)?\d+(\.\d+)?%/i,
    /fair value[^.]*(\+|-)?\d+(\.\d+)?%/i,
    /intrinsic value[^.]*(\+|-)?\d+(\.\d+)?%/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/(\+|-)?\d+(\.\d+)?/);
      if (numMatch) {
        const value = parseFloat(numMatch[0]);
        // Check if it's downside (negative)
        if (match[0].toLowerCase().includes('downside') || match[0].includes('-')) {
          return -Math.abs(value);
        }
        return value;
      }
    }
  }

  return null;
}

/**
 * Parse risk score from risk assessment text
 * Looks for "Overall Risk Score: X/10" pattern
 */
export function parseRiskScoreFromText(text: string): number | null {
  const patterns = [
    /(?:overall\s+)?risk\s+score[:\s]+(\d+(?:\.\d+)?)\s*\/\s*10/i,
    /(\d+(?:\.\d+)?)\s*\/\s*10\s*(?:risk|score)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseFloat(match[1]);
    }
  }

  return null;
}

/**
 * Parse sentiment level from sentiment analysis text
 */
function parseSentimentFromText(text: string): string | null {
  const sentimentPatterns = [
    { pattern: /very\s+bullish/i, value: 'VERY_BULLISH' },
    { pattern: /bullish/i, value: 'BULLISH' },
    { pattern: /very\s+bearish/i, value: 'VERY_BEARISH' },
    { pattern: /bearish/i, value: 'BEARISH' },
    { pattern: /neutral/i, value: 'NEUTRAL' },
  ];

  for (const { pattern, value } of sentimentPatterns) {
    if (pattern.test(text)) {
      return value;
    }
  }

  return null;
}

// ============================================================================
// CALCULATE CONVICTION SCORE TOOL
// ============================================================================

export const calculateConvictionScoreTool = createTool({
  id: 'calculate-conviction-score',
  description: `
    Calculate final conviction score for Tier 3 deep analysis.
    Takes outputs from DCF, comparable, sentiment, risk, and earnings workflows
    and produces a weighted conviction score with position sizing recommendation.
  `,

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
    companyName: z.string().describe('Company name'),
    sector: z.string().nullable().describe('Stock sector'),
    currentPrice: z.number().describe('Current stock price'),
    tier1Score: z.number().describe('Tier 1 quantitative score'),
    tier2Decision: z.enum(['PASS', 'FAST_TRACK']).describe('Tier 2 triage decision'),

    // Workflow outputs (text analysis)
    dcfValuation: z.string().nullable().describe('DCF valuation analysis text'),
    comparableAnalysis: z.string().nullable().describe('Comparable analysis text'),
    sentimentAnalysis: z.string().nullable().describe('Sentiment analysis text'),
    riskAssessment: z.string().nullable().describe('Risk assessment text'),
    earningsAnalysis: z.string().nullable().describe('Earnings analysis text'),

    // Optional structured data overrides
    dcfUpside: z.number().nullable().optional().describe('DCF upside % if known'),
    peerUpside: z.number().nullable().optional().describe('Peer implied upside % if known'),
    riskScore: z.number().nullable().optional().describe('Risk score (1-10) if known'),

    // Strategy context
    strategy: z.enum(['value', 'growth', 'balanced']).describe('Investment strategy'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    sector: z.string().nullable(),
    currentPrice: z.number(),

    valuationScore: z.number(),
    sentimentScore: z.number(),
    riskScore: z.number(),
    earningsScore: z.number(),
    qualityScore: z.number(),

    dcfUpside: z.number().nullable(),
    peerUpside: z.number().nullable(),
    compositeUpside: z.number().nullable(),

    convictionScore: z.number(),
    convictionLevel: z.enum(['VERY_HIGH', 'HIGH', 'MODERATE', 'LOW', 'VERY_LOW']),
    convictionReasoning: z.string(),

    suggestedWeight: z.number(),
    maxWeight: z.number(),

    bullFactors: z.array(z.string()),
    bearFactors: z.array(z.string()),
    keyRisks: z.array(z.string()),
  }),

  execute: async ({ context }) => {
    const {
      ticker,
      companyName,
      sector,
      currentPrice,
      tier1Score,
      tier2Decision,
      dcfValuation,
      comparableAnalysis,
      sentimentAnalysis,
      riskAssessment,
      earningsAnalysis,
      strategy,
    } = context;

    const bullFactors: string[] = [];
    const bearFactors: string[] = [];
    const keyRisks: string[] = [];

    // ========================================
    // PARSE DCF VALUATION
    // ========================================
    let dcfUpside = context.dcfUpside ?? null;
    if (dcfUpside === null && dcfValuation) {
      dcfUpside = parseUpsideFromText(dcfValuation);
    }

    let valuationScore = 50; // Default neutral
    if (dcfUpside !== null) {
      // Map upside to score: -50% = 0, 0% = 50, +50% = 100
      valuationScore = normalizeScore(dcfUpside, -50, 50);
      if (dcfUpside > 20) {
        bullFactors.push(`Strong DCF upside (${dcfUpside.toFixed(0)}%)`);
      } else if (dcfUpside < -10) {
        bearFactors.push(`DCF shows overvaluation (${dcfUpside.toFixed(0)}%)`);
      }
    }

    // ========================================
    // PARSE COMPARABLE ANALYSIS
    // ========================================
    let peerUpside = context.peerUpside ?? null;
    if (peerUpside === null && comparableAnalysis) {
      peerUpside = parseUpsideFromText(comparableAnalysis);
    }

    if (peerUpside !== null) {
      // Blend peer upside into valuation score
      const peerScore = normalizeScore(peerUpside, -50, 50);
      valuationScore = (valuationScore * 0.6 + peerScore * 0.4); // Weight DCF more
      if (peerUpside > 15) {
        bullFactors.push(`Trading below peers (${peerUpside.toFixed(0)}% discount)`);
      } else if (peerUpside < -15) {
        bearFactors.push(`Trading above peers (${Math.abs(peerUpside).toFixed(0)}% premium)`);
      }
    }

    // Calculate composite upside
    let compositeUpside: number | null = null;
    if (dcfUpside !== null && peerUpside !== null) {
      compositeUpside = dcfUpside * 0.6 + peerUpside * 0.4;
    } else if (dcfUpside !== null) {
      compositeUpside = dcfUpside;
    } else if (peerUpside !== null) {
      compositeUpside = peerUpside;
    }

    // ========================================
    // PARSE SENTIMENT ANALYSIS
    // ========================================
    let sentimentScore = 50; // Default neutral
    if (sentimentAnalysis) {
      const sentiment = parseSentimentFromText(sentimentAnalysis);
      if (sentiment === 'VERY_BULLISH') {
        sentimentScore = 90;
        bullFactors.push('Very bullish market sentiment');
      } else if (sentiment === 'BULLISH') {
        sentimentScore = 70;
        bullFactors.push('Positive market sentiment');
      } else if (sentiment === 'VERY_BEARISH') {
        sentimentScore = 10;
        bearFactors.push('Very bearish market sentiment');
        keyRisks.push('Negative sentiment may persist');
      } else if (sentiment === 'BEARISH') {
        sentimentScore = 30;
        bearFactors.push('Negative market sentiment');
      }

      // Check for specific positive/negative signals
      if (/strong buy/i.test(sentimentAnalysis)) {
        sentimentScore = Math.min(sentimentScore + 10, 100);
        bullFactors.push('Strong analyst buy rating');
      }
      if (/sell/i.test(sentimentAnalysis) && !/strong buy/i.test(sentimentAnalysis)) {
        sentimentScore = Math.max(sentimentScore - 15, 0);
        bearFactors.push('Analyst sell ratings present');
      }
      if (/insider.*buy/i.test(sentimentAnalysis)) {
        sentimentScore = Math.min(sentimentScore + 5, 100);
        bullFactors.push('Recent insider buying');
      }
    }

    // ========================================
    // PARSE RISK ASSESSMENT
    // ========================================
    let riskScoreRaw = context.riskScore ?? null;
    if (riskScoreRaw === null && riskAssessment) {
      riskScoreRaw = parseRiskScoreFromText(riskAssessment);
    }

    // Convert risk score (1-10, where 10 is highest risk) to inverted score (0-100, where 100 is lowest risk)
    let riskScore = 50; // Default moderate
    if (riskScoreRaw !== null) {
      riskScore = normalizeScore(riskScoreRaw, 1, 10, true); // Invert: low risk = high score

      if (riskScoreRaw <= 3) {
        bullFactors.push('Low risk profile');
      } else if (riskScoreRaw >= 7) {
        bearFactors.push('High risk profile');
        keyRisks.push(`High overall risk score (${riskScoreRaw}/10)`);
      }
    }

    // Check for specific risk factors in text
    if (riskAssessment) {
      if (/high beta/i.test(riskAssessment)) {
        keyRisks.push('High beta (market sensitivity)');
      }
      if (/max drawdown.*-?[3-9]\d%/i.test(riskAssessment)) {
        keyRisks.push('History of large drawdowns');
      }
      if (/short interest.*high/i.test(riskAssessment)) {
        keyRisks.push('Elevated short interest');
      }
    }

    // ========================================
    // PARSE EARNINGS ANALYSIS
    // ========================================
    let earningsScore = 50; // Default neutral
    if (earningsAnalysis) {
      // Check for beats/misses
      const beatMatch = earningsAnalysis.match(/beat.*(\d+)/i);
      const missMatch = earningsAnalysis.match(/miss.*(\d+)/i);

      if (beatMatch) {
        earningsScore += 15;
        bullFactors.push('Recent earnings beat');
      }
      if (missMatch) {
        earningsScore -= 15;
        bearFactors.push('Recent earnings miss');
      }

      // Check for guidance
      if (/raised.*guidance/i.test(earningsAnalysis)) {
        earningsScore += 10;
        bullFactors.push('Raised forward guidance');
      } else if (/lowered.*guidance/i.test(earningsAnalysis)) {
        earningsScore -= 10;
        bearFactors.push('Lowered forward guidance');
        keyRisks.push('Management lowered expectations');
      }

      // Check for growth
      if (/\+\d+%.*growth/i.test(earningsAnalysis) || /growth.*\+\d+%/i.test(earningsAnalysis)) {
        earningsScore += 5;
      }

      earningsScore = Math.max(0, Math.min(100, earningsScore));
    }

    // ========================================
    // CALCULATE QUALITY SCORE
    // ========================================
    // Quality is derived from consistency and fundamentals
    let qualityScore = tier1Score; // Start with Tier 1 fundamentals

    // Adjust based on Tier 2 decision
    if (tier2Decision === 'FAST_TRACK') {
      qualityScore = Math.min(qualityScore + 10, 100);
      bullFactors.push('Fast-tracked in Tier 2 triage');
    }

    // ========================================
    // CALCULATE FINAL CONVICTION SCORE
    // ========================================
    // Strategy-weighted scoring
    let weights: { valuation: number; sentiment: number; risk: number; earnings: number; quality: number };

    switch (strategy) {
      case 'value':
        weights = { valuation: 0.35, sentiment: 0.10, risk: 0.20, earnings: 0.15, quality: 0.20 };
        break;
      case 'growth':
        weights = { valuation: 0.20, sentiment: 0.15, risk: 0.15, earnings: 0.25, quality: 0.25 };
        break;
      case 'balanced':
      default:
        weights = { valuation: 0.25, sentiment: 0.15, risk: 0.20, earnings: 0.20, quality: 0.20 };
    }

    const convictionScore = Math.round(
      valuationScore * weights.valuation +
      sentimentScore * weights.sentiment +
      riskScore * weights.risk +
      earningsScore * weights.earnings +
      qualityScore * weights.quality
    );

    // Determine conviction level
    let convictionLevel: ConvictionLevel;
    if (convictionScore >= 80) {
      convictionLevel = 'VERY_HIGH';
    } else if (convictionScore >= 65) {
      convictionLevel = 'HIGH';
    } else if (convictionScore >= 50) {
      convictionLevel = 'MODERATE';
    } else if (convictionScore >= 35) {
      convictionLevel = 'LOW';
    } else {
      convictionLevel = 'VERY_LOW';
    }

    // ========================================
    // POSITION SIZING
    // ========================================
    // Base weight on conviction, adjusted for risk
    let suggestedWeight = 0;
    let maxWeight = 0;

    if (convictionLevel === 'VERY_HIGH') {
      suggestedWeight = 8;
      maxWeight = 10;
    } else if (convictionLevel === 'HIGH') {
      suggestedWeight = 6;
      maxWeight = 8;
    } else if (convictionLevel === 'MODERATE') {
      suggestedWeight = 4;
      maxWeight = 6;
    } else if (convictionLevel === 'LOW') {
      suggestedWeight = 2;
      maxWeight = 4;
    } else {
      suggestedWeight = 0;
      maxWeight = 2;
    }

    // Reduce weight for high-risk stocks
    if (riskScoreRaw !== null && riskScoreRaw >= 7) {
      suggestedWeight = Math.max(0, suggestedWeight - 2);
      maxWeight = Math.max(2, maxWeight - 2);
    }

    // ========================================
    // BUILD REASONING
    // ========================================
    const convictionReasoning = buildConvictionReasoning({
      convictionScore,
      convictionLevel,
      valuationScore,
      sentimentScore,
      riskScore,
      earningsScore,
      qualityScore,
      compositeUpside,
      bullFactors,
      bearFactors,
      strategy,
    });

    return {
      ticker,
      companyName,
      sector,
      currentPrice,
      valuationScore: Math.round(valuationScore),
      sentimentScore: Math.round(sentimentScore),
      riskScore: Math.round(riskScore),
      earningsScore: Math.round(earningsScore),
      qualityScore: Math.round(qualityScore),
      dcfUpside,
      peerUpside,
      compositeUpside,
      convictionScore,
      convictionLevel,
      convictionReasoning,
      suggestedWeight,
      maxWeight,
      bullFactors,
      bearFactors,
      keyRisks,
    };
  },
});

/**
 * Build human-readable conviction reasoning
 */
function buildConvictionReasoning(params: {
  convictionScore: number;
  convictionLevel: ConvictionLevel;
  valuationScore: number;
  sentimentScore: number;
  riskScore: number;
  earningsScore: number;
  qualityScore: number;
  compositeUpside: number | null;
  bullFactors: string[];
  bearFactors: string[];
  strategy: string;
}): string {
  const {
    convictionScore,
    convictionLevel,
    valuationScore,
    sentimentScore,
    riskScore,
    earningsScore,
    qualityScore,
    compositeUpside,
    bullFactors,
    bearFactors,
    strategy,
  } = params;

  const parts: string[] = [];

  // Overall conviction
  parts.push(`${convictionLevel} conviction (${convictionScore}/100) for ${strategy} strategy.`);

  // Upside summary
  if (compositeUpside !== null) {
    const direction = compositeUpside >= 0 ? 'upside' : 'downside';
    parts.push(`Composite ${direction}: ${Math.abs(compositeUpside).toFixed(1)}%.`);
  }

  // Score breakdown
  const scoreAnalysis: string[] = [];
  if (valuationScore >= 70) scoreAnalysis.push('strong valuation');
  else if (valuationScore <= 30) scoreAnalysis.push('weak valuation');

  if (sentimentScore >= 70) scoreAnalysis.push('positive sentiment');
  else if (sentimentScore <= 30) scoreAnalysis.push('negative sentiment');

  if (riskScore >= 70) scoreAnalysis.push('low risk');
  else if (riskScore <= 30) scoreAnalysis.push('high risk');

  if (earningsScore >= 70) scoreAnalysis.push('strong earnings');
  else if (earningsScore <= 30) scoreAnalysis.push('weak earnings');

  if (qualityScore >= 70) scoreAnalysis.push('high quality');

  if (scoreAnalysis.length > 0) {
    parts.push(`Key factors: ${scoreAnalysis.join(', ')}.`);
  }

  // Bull/bear summary
  if (bullFactors.length > 0) {
    parts.push(`Positives: ${bullFactors.slice(0, 3).join('; ')}.`);
  }
  if (bearFactors.length > 0) {
    parts.push(`Concerns: ${bearFactors.slice(0, 2).join('; ')}.`);
  }

  return parts.join(' ');
}

// ============================================================================
// BATCH CONVICTION SCORING TOOL
// ============================================================================

export const batchConvictionScoreTool = createTool({
  id: 'batch-conviction-score',
  description: 'Calculate conviction scores for multiple stocks',

  inputSchema: z.object({
    candidates: z.array(
      z.object({
        ticker: z.string(),
        companyName: z.string(),
        sector: z.string().nullable(),
        currentPrice: z.number(),
        tier1Score: z.number(),
        tier2Decision: z.enum(['PASS', 'FAST_TRACK']),
        dcfValuation: z.string().nullable(),
        comparableAnalysis: z.string().nullable(),
        sentimentAnalysis: z.string().nullable(),
        riskAssessment: z.string().nullable(),
        earningsAnalysis: z.string().nullable(),
      })
    ),
    strategy: z.enum(['value', 'growth', 'balanced']),
  }),

  outputSchema: z.object({
    results: z.array(
      z.object({
        ticker: z.string(),
        convictionScore: z.number(),
        convictionLevel: z.enum(['VERY_HIGH', 'HIGH', 'MODERATE', 'LOW', 'VERY_LOW']),
        suggestedWeight: z.number(),
        compositeUpside: z.number().nullable(),
      })
    ),
    summary: z.object({
      total: z.number(),
      veryHigh: z.number(),
      high: z.number(),
      moderate: z.number(),
      low: z.number(),
      veryLow: z.number(),
      averageConviction: z.number(),
    }),
  }),

  execute: async ({ context }) => {
    const { candidates, strategy } = context;

    const results = await Promise.all(
      candidates.map(async (candidate) => {
        const result = await calculateConvictionScoreTool.execute({
          context: {
            ...candidate,
            strategy,
            dcfUpside: null,
            peerUpside: null,
            riskScore: null,
          },
          runtimeContext: {} as any,
        });

        return {
          ticker: result.ticker,
          convictionScore: result.convictionScore,
          convictionLevel: result.convictionLevel,
          suggestedWeight: result.suggestedWeight,
          compositeUpside: result.compositeUpside,
        };
      })
    );

    // Sort by conviction score descending
    results.sort((a, b) => b.convictionScore - a.convictionScore);

    const summary = {
      total: results.length,
      veryHigh: results.filter((r) => r.convictionLevel === 'VERY_HIGH').length,
      high: results.filter((r) => r.convictionLevel === 'HIGH').length,
      moderate: results.filter((r) => r.convictionLevel === 'MODERATE').length,
      low: results.filter((r) => r.convictionLevel === 'LOW').length,
      veryLow: results.filter((r) => r.convictionLevel === 'VERY_LOW').length,
      averageConviction: Math.round(
        results.reduce((sum, r) => sum + r.convictionScore, 0) / results.length
      ),
    };

    return { results, summary };
  },
});

// ============================================================================
// EXPORTS
// ============================================================================

export const convictionTools = [calculateConvictionScoreTool, batchConvictionScoreTool];
