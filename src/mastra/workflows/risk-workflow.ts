// ============================================================================
// RISK ASSESSMENT WORKFLOW
// ============================================================================
// This file contains the comprehensive risk assessment workflow that combines
// all risk metrics into a unified risk analysis.
//
// The workflow gathers:
// 1. Beta and volatility metrics (market risk)
// 2. Historical drawdown analysis (downside risk)
// 3. Sector and market cap exposure (concentration risk)
// 4. Short interest data (sentiment risk)
//
// Then synthesizes all data into a comprehensive risk report with an
// overall risk rating and actionable recommendations.
// ============================================================================

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

// Import risk tools
import {
  getBetaVolatilityTool,
  getDrawdownAnalysisTool,
  getSectorExposureTool,
  getShortInterestTool,
} from '../tools/risk-tools';

// Initialize OpenAI model for AI-powered synthesis
const llm = openai('gpt-4o');

// ============================================================================
// RISK SYNTHESIS AGENT
// ============================================================================
// This specialized agent handles the synthesis of all risk data into a
// coherent risk assessment report.
// ============================================================================
const riskSynthesisAgent = new Agent({
  name: 'Risk Synthesis Specialist',
  model: llm,
  instructions: `
    You are a risk assessment specialist who synthesizes multiple risk metrics
    into comprehensive risk reports.

    Your analysis should:
    - Assign an overall risk score (1-10)
    - Identify the most significant risk factors
    - Highlight any risk mitigants
    - Provide guidance on suitable investor profiles
    - Suggest position sizing considerations
    - Be data-driven and objective

    Format your response clearly with sections for each risk category
    and an executive summary at the end.
  `,
});

// ============================================================================
// STEP 1: FETCH ALL RISK DATA
// ============================================================================
// This step gathers all risk metrics by calling the four risk tools in parallel.
// ============================================================================
const fetchRiskData = createStep({
  id: 'fetch-risk-data',
  description: 'Fetches all risk metrics using risk tools',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    betaVolatility: z.any(),
    drawdownAnalysis: z.any(),
    sectorExposure: z.any(),
    shortInterest: z.any(),
  }),

  execute: async ({ inputData, runtimeContext }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker.toUpperCase();

    try {
      // Fetch all risk data in parallel for efficiency
      const [betaVolatility, drawdownAnalysis, sectorExposure, shortInterest] = await Promise.all([
        getBetaVolatilityTool.execute({
          context: { ticker },
          runtimeContext,
        }),
        getDrawdownAnalysisTool.execute({
          context: { ticker, period: '1y' },
          runtimeContext,
        }),
        getSectorExposureTool.execute({
          context: { ticker },
          runtimeContext,
        }),
        getShortInterestTool.execute({
          context: { ticker },
          runtimeContext,
        }),
      ]);

      return {
        ticker,
        betaVolatility,
        drawdownAnalysis,
        sectorExposure,
        shortInterest,
      };
    } catch (error) {
      throw new Error(`Failed to fetch risk data for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// STEP 2: SYNTHESIZE RISK ASSESSMENT
// ============================================================================
// This step takes all the risk data and produces a comprehensive risk report.
// ============================================================================
const synthesizeRiskAssessment = createStep({
  id: 'synthesize-risk-assessment',
  description: 'Synthesizes all risk data into a comprehensive risk assessment',

  inputSchema: z.object({
    ticker: z.string(),
    betaVolatility: z.any(),
    drawdownAnalysis: z.any(),
    sectorExposure: z.any(),
    shortInterest: z.any(),
  }),

  outputSchema: z.object({
    riskAssessment: z.string(),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const { ticker, betaVolatility, drawdownAnalysis, sectorExposure, shortInterest } = inputData;

    // Build comprehensive prompt with all risk data
    const prompt = `Provide a comprehensive risk assessment for ${ticker} based on the following data:

=== BETA & VOLATILITY DATA ===
Company: ${betaVolatility.companyName}
Current Price: $${betaVolatility.currentPrice?.toFixed(2)}
Beta: ${betaVolatility.beta?.toFixed(2) || 'N/A'}
52-Week Range: ${betaVolatility.fiftyTwoWeekRange || 'N/A'}
% From 52-Week High: ${betaVolatility.percentFromHigh?.toFixed(2)}%
% From 52-Week Low: ${betaVolatility.percentFromLow?.toFixed(2)}%
50-Day MA: $${betaVolatility.fiftyDayMA?.toFixed(2) || 'N/A'}
200-Day MA: $${betaVolatility.twoHundredDayMA?.toFixed(2) || 'N/A'}
Price vs 50-Day MA: ${betaVolatility.priceVs50DayMA?.toFixed(2)}%
Price vs 200-Day MA: ${betaVolatility.priceVs200DayMA?.toFixed(2)}%
Trend Signal: ${betaVolatility.trendSignal || 'N/A'}

=== DRAWDOWN ANALYSIS (1 Year) ===
Period Return: ${drawdownAnalysis.periodReturn?.toFixed(2)}%
Period High: $${drawdownAnalysis.periodHigh?.toFixed(2)}
Period Low: $${drawdownAnalysis.periodLow?.toFixed(2)}
Max Drawdown: ${drawdownAnalysis.maxDrawdown?.toFixed(2)}%
Current Drawdown from Period High: ${drawdownAnalysis.currentDrawdownFromPeriodHigh?.toFixed(2)}%
Price Range as % of High: ${drawdownAnalysis.rangeAsPercentOfHigh?.toFixed(2)}%
Recovery from Low: ${drawdownAnalysis.recoveryFromLow?.toFixed(2)}%

=== SECTOR EXPOSURE ===
Sector: ${sectorExposure.sector || 'N/A'}
Industry: ${sectorExposure.industry || 'N/A'}
Market Cap: ${sectorExposure.marketCapFormatted || 'N/A'}
Market Cap Category: ${sectorExposure.marketCapCategory || 'N/A'}
Average Volume: ${sectorExposure.averageVolume?.toLocaleString() || 'N/A'}
Float %: ${sectorExposure.floatPercent?.toFixed(2) || 'N/A'}%
Exchange: ${sectorExposure.exchange || 'N/A'}

=== SHORT INTEREST DATA ===
Shares Short: ${shortInterest.sharesShortFormatted || 'N/A'}
Short Ratio (Days to Cover): ${shortInterest.shortRatio?.toFixed(2) || 'N/A'}
Short % of Float: ${shortInterest.shortPercentOfFloat?.toFixed(2) || 'N/A'}%
Short Interest Trend: ${shortInterest.shortInterestTrend || 'N/A'}
Short Squeeze Risk: ${shortInterest.shortSqueezeRisk || 'N/A'}
Sentiment Indicator: ${shortInterest.sentimentIndicator || 'N/A'}

=== YOUR TASK ===
Based on this data, provide a comprehensive risk assessment that includes:

1. **OVERALL RISK SCORE** (1-10, where 1 is lowest risk and 10 is highest)
   - Justify the score based on the data

2. **MARKET RISK ANALYSIS**
   - Interpret the beta value
   - Assess volatility based on 52-week range
   - Evaluate trend risk from moving averages

3. **DOWNSIDE RISK ANALYSIS**
   - Interpret the max drawdown
   - Assess current drawdown status
   - Evaluate potential further downside

4. **SECTOR & CONCENTRATION RISK**
   - Assess sector-specific risks
   - Consider market cap implications
   - Evaluate liquidity risk

5. **SENTIMENT RISK**
   - Interpret short interest levels
   - Assess squeeze potential
   - Evaluate bearish sentiment

6. **RISK SUMMARY**
   - Top 3 risk factors
   - Top 3 risk mitigants
   - Suitable investor profile (conservative/moderate/aggressive)
   - Position sizing recommendation
   - Key levels to watch

Format your response clearly with headers and bullet points.`;

    // Get AI synthesis
    const response = await riskSynthesisAgent.streamLegacy([
      {
        role: 'user',
        content: prompt,
      },
    ]);

    // Collect the streamed response
    let assessmentText = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      assessmentText += chunk;
    }

    return {
      riskAssessment: assessmentText,
    };
  },
});

// ============================================================================
// RISK ASSESSMENT WORKFLOW DEFINITION
// ============================================================================
// This workflow chains together the two steps:
// 1. fetchRiskData - Gathers all risk metrics from Yahoo Finance
// 2. synthesizeRiskAssessment - AI analyzes and produces risk report
//
// USAGE:
//   const result = await riskAssessmentWorkflow.execute({ ticker: 'AAPL' });
//   console.log(result.riskAssessment); // Full risk assessment report
// ============================================================================
export const riskAssessmentWorkflow = createWorkflow({
  id: 'risk-assessment-workflow',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol to assess'),
  }),

  outputSchema: z.object({
    riskAssessment: z.string(),
  }),
})
  .then(fetchRiskData)
  .then(synthesizeRiskAssessment);

// Commit the workflow to make it executable
riskAssessmentWorkflow.commit();

// ============================================================================
// END OF RISK WORKFLOW
// ============================================================================
// This workflow provides comprehensive risk assessment by combining:
// - Market risk (beta, volatility)
// - Downside risk (drawdowns, support levels)
// - Concentration risk (sector, market cap)
// - Sentiment risk (short interest)
//
// The output is a synthesized risk report with an overall risk score
// and actionable recommendations for different investor profiles.
// ============================================================================
