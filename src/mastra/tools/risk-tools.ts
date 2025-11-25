// ============================================================================
// RISK ASSESSMENT TOOLS
// ============================================================================
// This file provides specialized tools for risk analysis of stocks.
// These tools are used by the Risk Assessment Agent to analyze:
// - Beta and volatility metrics (systematic vs idiosyncratic risk)
// - Historical price performance and drawdowns
// - Sector exposure and market correlation
// - Short interest and market sentiment risk indicators
//
// NOTE: Uses Yahoo Finance 2 API for all data fetching.
// ============================================================================

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

// Initialize Yahoo Finance API client
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ============================================================================
// TOOL 1: GET BETA & VOLATILITY METRICS
// ============================================================================
// This tool provides key risk metrics that measure how volatile a stock is
// and how it moves relative to the overall market.
//
// KEY CONCEPTS:
// - Beta: Measures sensitivity to market movements
//   - Beta = 1.0: Moves with the market
//   - Beta > 1.0: More volatile than market (amplifies moves)
//   - Beta < 1.0: Less volatile than market (defensive)
//   - Beta < 0: Moves opposite to market (rare)
//
// - 52-Week Range: Shows price volatility over the past year
// - 50-Day vs 200-Day Moving Average: Trend indicators
//
// USE THIS WHEN YOU NEED:
// - Systematic risk assessment (beta)
// - Price volatility analysis
// - Trend analysis (moving averages)
// ============================================================================
export const getBetaVolatilityTool = createTool({
  id: 'get-beta-volatility',
  description: 'Get beta, volatility metrics, and moving averages for risk assessment',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),

    // Current price context
    currentPrice: z.number(),

    // Beta and market sensitivity
    beta: z.number().nullable(),                    // Market sensitivity (vs S&P 500)

    // 52-week range (annual volatility context)
    fiftyTwoWeekHigh: z.number().nullable(),
    fiftyTwoWeekLow: z.number().nullable(),
    fiftyTwoWeekRange: z.string().nullable(),       // "Low - High" formatted
    percentFromHigh: z.number().nullable(),         // How far below 52-week high
    percentFromLow: z.number().nullable(),          // How far above 52-week low

    // Moving averages (trend indicators)
    fiftyDayMA: z.number().nullable(),              // 50-day moving average
    twoHundredDayMA: z.number().nullable(),         // 200-day moving average
    priceVs50DayMA: z.number().nullable(),          // % above/below 50-day MA
    priceVs200DayMA: z.number().nullable(),         // % above/below 200-day MA

    // Trend assessment
    trendSignal: z.string().nullable(),             // Bullish/Bearish based on MAs
  }),

  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();

    try {
      // Fetch quote data and summaryDetail (which contains beta)
      const [quote, summary] = await Promise.all([
        yf.quote(ticker),
        yf.quoteSummary(ticker, { modules: ['summaryDetail'] }),
      ]);

      const summaryDetail = summary?.summaryDetail;

      const currentPrice = quote.regularMarketPrice || 0;
      const high52 = quote.fiftyTwoWeekHigh || null;
      const low52 = quote.fiftyTwoWeekLow || null;
      const ma50 = quote.fiftyDayAverage || null;
      const ma200 = quote.twoHundredDayAverage || null;

      // Calculate percent from 52-week high/low
      const percentFromHigh = high52 ? ((currentPrice - high52) / high52) * 100 : null;
      const percentFromLow = low52 ? ((currentPrice - low52) / low52) * 100 : null;

      // Calculate price vs moving averages
      const priceVs50DayMA = ma50 ? ((currentPrice - ma50) / ma50) * 100 : null;
      const priceVs200DayMA = ma200 ? ((currentPrice - ma200) / ma200) * 100 : null;

      // Determine trend signal based on moving average crossovers
      let trendSignal: string | null = null;
      if (ma50 && ma200) {
        if (currentPrice > ma50 && ma50 > ma200) {
          trendSignal = 'BULLISH - Price above both MAs, 50-day above 200-day (Golden Cross territory)';
        } else if (currentPrice < ma50 && ma50 < ma200) {
          trendSignal = 'BEARISH - Price below both MAs, 50-day below 200-day (Death Cross territory)';
        } else if (currentPrice > ma200 && currentPrice < ma50) {
          trendSignal = 'NEUTRAL-BEARISH - Price above 200-day but below 50-day (potential pullback)';
        } else if (currentPrice < ma200 && currentPrice > ma50) {
          trendSignal = 'NEUTRAL-BULLISH - Price below 200-day but above 50-day (potential recovery)';
        } else {
          trendSignal = 'MIXED - Conflicting signals from moving averages';
        }
      }

      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        currentPrice,
        beta: summaryDetail?.beta ?? null,
        fiftyTwoWeekHigh: high52,
        fiftyTwoWeekLow: low52,
        fiftyTwoWeekRange: high52 && low52 ? `$${low52.toFixed(2)} - $${high52.toFixed(2)}` : null,
        percentFromHigh,
        percentFromLow,
        fiftyDayMA: ma50,
        twoHundredDayMA: ma200,
        priceVs50DayMA,
        priceVs200DayMA,
        trendSignal,
      };
    } catch (error) {
      throw new Error(`Failed to fetch beta/volatility for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// TOOL 2: GET HISTORICAL DRAWDOWN ANALYSIS
// ============================================================================
// This tool analyzes historical price data to calculate drawdown metrics.
// Drawdown = decline from peak to trough (measures downside risk).
//
// KEY CONCEPTS:
// - Max Drawdown: Largest peak-to-trough decline (worst-case loss)
// - Current Drawdown: How far below the all-time/period high
// - Recovery: Whether price has recovered from drawdowns
//
// USE THIS WHEN YOU NEED:
// - Historical worst-case scenario analysis
// - Downside risk assessment
// - Understanding price volatility patterns
// ============================================================================
export const getDrawdownAnalysisTool = createTool({
  id: 'get-drawdown-analysis',
  description: 'Get historical drawdown analysis including max drawdown and recovery metrics',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
    period: z.enum(['3mo', '6mo', '1y', '2y', '5y']).default('1y').describe('Analysis period'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    period: z.string(),

    // Price performance over period
    periodStartPrice: z.number(),
    periodEndPrice: z.number(),
    periodReturn: z.number(),                       // % return over period

    // Drawdown metrics
    periodHigh: z.number(),                         // Highest price in period
    periodLow: z.number(),                          // Lowest price in period
    maxDrawdown: z.number(),                        // Max peak-to-trough decline %
    currentDrawdownFromPeriodHigh: z.number(),      // Current price vs period high %

    // Volatility metrics
    priceRange: z.number(),                         // High - Low
    rangeAsPercentOfHigh: z.number(),               // Range as % of high (volatility proxy)

    // Recovery analysis
    hasRecoveredFromLow: z.boolean(),               // Is current price above period low?
    recoveryFromLow: z.number(),                    // % recovery from period low
  }),

  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    const period = context.period || '1y';

    try {
      // Fetch historical data
      const quote = await yf.quote(ticker);
      const historical = await yf.chart(ticker, { period1: getPeriodStartDate(period), period2: new Date() });

      if (!historical.quotes || historical.quotes.length === 0) {
        throw new Error(`No historical data available for ${ticker}`);
      }

      const quotes = historical.quotes;
      const prices = quotes.map(q => q.close).filter((p): p is number => p !== null && p !== undefined);

      if (prices.length === 0) {
        throw new Error(`No valid price data for ${ticker}`);
      }

      const periodStartPrice = prices[0];
      const periodEndPrice = prices[prices.length - 1];
      const periodHigh = Math.max(...prices);
      const periodLow = Math.min(...prices);

      // Calculate max drawdown (largest peak-to-trough decline)
      let maxDrawdown = 0;
      let runningMax = prices[0];

      for (const price of prices) {
        if (price > runningMax) {
          runningMax = price;
        }
        const drawdown = ((price - runningMax) / runningMax) * 100;
        if (drawdown < maxDrawdown) {
          maxDrawdown = drawdown;
        }
      }

      const periodReturn = ((periodEndPrice - periodStartPrice) / periodStartPrice) * 100;
      const currentDrawdownFromPeriodHigh = ((periodEndPrice - periodHigh) / periodHigh) * 100;
      const priceRange = periodHigh - periodLow;
      const rangeAsPercentOfHigh = (priceRange / periodHigh) * 100;
      const recoveryFromLow = ((periodEndPrice - periodLow) / periodLow) * 100;

      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        period,
        periodStartPrice,
        periodEndPrice,
        periodReturn,
        periodHigh,
        periodLow,
        maxDrawdown,
        currentDrawdownFromPeriodHigh,
        priceRange,
        rangeAsPercentOfHigh,
        hasRecoveredFromLow: periodEndPrice > periodLow,
        recoveryFromLow,
      };
    } catch (error) {
      throw new Error(`Failed to fetch drawdown analysis for ${ticker}: ${error}`);
    }
  },
});

// Helper function to calculate period start date
function getPeriodStartDate(period: string): Date {
  const now = new Date();
  switch (period) {
    case '3mo':
      return new Date(now.setMonth(now.getMonth() - 3));
    case '6mo':
      return new Date(now.setMonth(now.getMonth() - 6));
    case '1y':
      return new Date(now.setFullYear(now.getFullYear() - 1));
    case '2y':
      return new Date(now.setFullYear(now.getFullYear() - 2));
    case '5y':
      return new Date(now.setFullYear(now.getFullYear() - 5));
    default:
      return new Date(now.setFullYear(now.getFullYear() - 1));
  }
}

// ============================================================================
// TOOL 3: GET SECTOR & MARKET EXPOSURE
// ============================================================================
// This tool provides sector classification and market exposure data.
// Understanding sector exposure is crucial for portfolio diversification
// and understanding how macro events might affect the stock.
//
// KEY CONCEPTS:
// - Sector: Broad industry category (Technology, Healthcare, etc.)
// - Industry: More specific classification within sector
// - Market Cap Category: Large-cap, Mid-cap, Small-cap (affects volatility)
//
// USE THIS WHEN YOU NEED:
// - Sector diversification analysis
// - Understanding macro risk exposure
// - Comparing stocks across industries
// ============================================================================
export const getSectorExposureTool = createTool({
  id: 'get-sector-exposure',
  description: 'Get sector classification, industry, and market cap category for risk contextualization',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),

    // Sector and industry classification
    sector: z.string().nullable(),                  // e.g., "Technology"
    industry: z.string().nullable(),                // e.g., "Consumer Electronics"

    // Market cap classification
    marketCap: z.number().nullable(),
    marketCapFormatted: z.string().nullable(),      // e.g., "$2.5T"
    marketCapCategory: z.string().nullable(),       // Large/Mid/Small/Micro cap

    // Trading characteristics
    averageVolume: z.number().nullable(),           // Average daily volume
    averageVolume10Day: z.number().nullable(),      // Recent 10-day average
    volumeRatio: z.number().nullable(),             // Current vs average volume

    // Institutional ownership (stability indicator)
    sharesOutstanding: z.number().nullable(),
    floatShares: z.number().nullable(),
    floatPercent: z.number().nullable(),            // Float as % of outstanding

    // Exchange info
    exchange: z.string().nullable(),
    currency: z.string().nullable(),
  }),

  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();

    try {
      const quote = await yf.quote(ticker);
      const summary = await yf.quoteSummary(ticker, {
        modules: ['summaryProfile', 'summaryDetail', 'defaultKeyStatistics']
      });

      const profile = summary.summaryProfile || ({} as any);
      const summaryDetail = summary.summaryDetail || ({} as any);
      const keyStats = summary.defaultKeyStatistics || ({} as any);

      const marketCap = quote.marketCap || null;

      // Determine market cap category
      let marketCapCategory: string | null = null;
      if (marketCap) {
        if (marketCap >= 200e9) marketCapCategory = 'Mega Cap (>$200B)';
        else if (marketCap >= 10e9) marketCapCategory = 'Large Cap ($10B-$200B)';
        else if (marketCap >= 2e9) marketCapCategory = 'Mid Cap ($2B-$10B)';
        else if (marketCap >= 300e6) marketCapCategory = 'Small Cap ($300M-$2B)';
        else marketCapCategory = 'Micro Cap (<$300M)';
      }

      // Format market cap
      let marketCapFormatted: string | null = null;
      if (marketCap) {
        if (marketCap >= 1e12) marketCapFormatted = `$${(marketCap / 1e12).toFixed(2)}T`;
        else if (marketCap >= 1e9) marketCapFormatted = `$${(marketCap / 1e9).toFixed(2)}B`;
        else if (marketCap >= 1e6) marketCapFormatted = `$${(marketCap / 1e6).toFixed(2)}M`;
        else marketCapFormatted = `$${marketCap.toFixed(0)}`;
      }

      // Calculate float percentage
      const floatPercent = keyStats.floatShares && keyStats.sharesOutstanding
        ? (keyStats.floatShares / keyStats.sharesOutstanding) * 100
        : null;

      // Get volume data from summaryDetail (averageVolume) and quote (current volume)
      const averageVolume = summaryDetail.averageVolume ?? null;
      const averageVolume10Day = summaryDetail.averageVolume10days ?? null;
      const currentVolume = quote.regularMarketVolume ?? null;

      // Calculate volume ratio (current vs average)
      const volumeRatio = currentVolume && averageVolume
        ? currentVolume / averageVolume
        : null;

      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        sector: profile.sector || null,
        industry: profile.industry || null,
        marketCap,
        marketCapFormatted,
        marketCapCategory,
        averageVolume,
        averageVolume10Day,
        volumeRatio,
        sharesOutstanding: keyStats.sharesOutstanding || null,
        floatShares: keyStats.floatShares || null,
        floatPercent,
        exchange: quote.exchange || null,
        currency: quote.currency || null,
      };
    } catch (error) {
      throw new Error(`Failed to fetch sector exposure for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// TOOL 4: GET SHORT INTEREST & SENTIMENT RISK
// ============================================================================
// This tool provides short interest data which indicates bearish sentiment
// and potential squeeze risk.
//
// KEY CONCEPTS:
// - Short Interest: Number of shares sold short (betting on decline)
// - Short Ratio (Days to Cover): Short interest / avg daily volume
//   - High ratio (>5): Many shorts, takes long to cover, squeeze potential
//   - Low ratio (<2): Few shorts, less squeeze risk
// - Short % of Float: What percentage of tradeable shares are shorted
//   - >20%: Very high, significant bearish sentiment
//   - 10-20%: Elevated, notable short interest
//   - <5%: Low, minimal short pressure
//
// USE THIS WHEN YOU NEED:
// - Short squeeze risk assessment
// - Market sentiment analysis
// - Contrarian indicator analysis
// ============================================================================
export const getShortInterestTool = createTool({
  id: 'get-short-interest',
  description: 'Get short interest data including shares short, short ratio, and short percent of float',

  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),

  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),

    // Short interest metrics
    sharesShort: z.number().nullable(),             // Total shares sold short
    sharesShortFormatted: z.string().nullable(),    // e.g., "15.2M shares"
    shortRatio: z.number().nullable(),              // Days to cover
    shortPercentOfFloat: z.number().nullable(),     // Short interest as % of float
    shortPercentOfSharesOut: z.number().nullable(), // Short interest as % of total shares

    // Prior month comparison (trend)
    sharesShortPriorMonth: z.number().nullable(),
    shortInterestChange: z.number().nullable(),     // % change from prior month
    shortInterestTrend: z.string().nullable(),      // Increasing/Decreasing/Stable

    // Risk assessment
    shortSqueezeRisk: z.string().nullable(),        // Low/Medium/High/Very High
    sentimentIndicator: z.string().nullable(),      // Bullish/Neutral/Bearish based on shorts
  }),

  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();

    try {
      const quote = await yf.quote(ticker);
      const summary = await yf.quoteSummary(ticker, {
        modules: ['defaultKeyStatistics']
      });

      const keyStats = summary.defaultKeyStatistics || ({} as any);

      const sharesShort = keyStats.sharesShort || null;
      const sharesShortPriorMonth = keyStats.sharesShortPriorMonth || null;
      const shortRatio = keyStats.shortRatio || null;
      const floatShares = keyStats.floatShares || null;
      const sharesOutstanding = keyStats.sharesOutstanding || null;

      // Calculate short percent of float
      const shortPercentOfFloat = sharesShort && floatShares
        ? (sharesShort / floatShares) * 100
        : null;

      // Calculate short percent of shares outstanding
      const shortPercentOfSharesOut = sharesShort && sharesOutstanding
        ? (sharesShort / sharesOutstanding) * 100
        : null;

      // Format shares short
      let sharesShortFormatted: string | null = null;
      if (sharesShort) {
        if (sharesShort >= 1e9) sharesShortFormatted = `${(sharesShort / 1e9).toFixed(2)}B shares`;
        else if (sharesShort >= 1e6) sharesShortFormatted = `${(sharesShort / 1e6).toFixed(2)}M shares`;
        else if (sharesShort >= 1e3) sharesShortFormatted = `${(sharesShort / 1e3).toFixed(2)}K shares`;
        else sharesShortFormatted = `${sharesShort} shares`;
      }

      // Calculate short interest change
      const shortInterestChange = sharesShort && sharesShortPriorMonth
        ? ((sharesShort - sharesShortPriorMonth) / sharesShortPriorMonth) * 100
        : null;

      // Determine short interest trend
      let shortInterestTrend: string | null = null;
      if (shortInterestChange !== null) {
        if (shortInterestChange > 10) shortInterestTrend = 'Significantly Increasing';
        else if (shortInterestChange > 2) shortInterestTrend = 'Increasing';
        else if (shortInterestChange < -10) shortInterestTrend = 'Significantly Decreasing';
        else if (shortInterestChange < -2) shortInterestTrend = 'Decreasing';
        else shortInterestTrend = 'Stable';
      }

      // Assess short squeeze risk
      let shortSqueezeRisk: string | null = null;
      if (shortRatio !== null && shortPercentOfFloat !== null) {
        if (shortRatio > 10 && shortPercentOfFloat > 20) shortSqueezeRisk = 'Very High';
        else if (shortRatio > 5 || shortPercentOfFloat > 15) shortSqueezeRisk = 'High';
        else if (shortRatio > 3 || shortPercentOfFloat > 10) shortSqueezeRisk = 'Medium';
        else shortSqueezeRisk = 'Low';
      }

      // Determine sentiment indicator based on short interest
      let sentimentIndicator: string | null = null;
      if (shortPercentOfFloat !== null) {
        if (shortPercentOfFloat > 20) sentimentIndicator = 'Very Bearish - High short interest indicates significant negative sentiment';
        else if (shortPercentOfFloat > 10) sentimentIndicator = 'Bearish - Elevated short interest suggests negative sentiment';
        else if (shortPercentOfFloat > 5) sentimentIndicator = 'Neutral - Moderate short interest, no strong signal';
        else sentimentIndicator = 'Neutral-Bullish - Low short interest, limited bearish bets';
      }

      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        sharesShort,
        sharesShortFormatted,
        shortRatio,
        shortPercentOfFloat,
        shortPercentOfSharesOut,
        sharesShortPriorMonth,
        shortInterestChange,
        shortInterestTrend,
        shortSqueezeRisk,
        sentimentIndicator,
      };
    } catch (error) {
      throw new Error(`Failed to fetch short interest for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// END OF RISK TOOLS
// ============================================================================
// Summary of all 4 tools:
// 1. getBetaVolatilityTool - Beta, moving averages, trend signals
// 2. getDrawdownAnalysisTool - Historical drawdowns, max drawdown, recovery
// 3. getSectorExposureTool - Sector, industry, market cap category
// 4. getShortInterestTool - Short interest, squeeze risk, sentiment
//
// These tools work together to provide complete risk analysis coverage.
// The Risk Assessment Agent uses these tools to build comprehensive
// risk profiles and investment risk assessments.
// ============================================================================
