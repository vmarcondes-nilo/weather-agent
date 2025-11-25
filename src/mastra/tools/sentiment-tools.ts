import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// Tool 1: Get Analyst Ratings
export const getAnalystRatingsTool = createTool({
  id: 'get-analyst-ratings',
  description: 'Get analyst ratings and recommendations (buy/hold/sell) for a stock',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)'),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    currentRating: z.string().optional(),
    targetPrice: z.number().nullable(),
    numberOfAnalysts: z.number(),
    ratings: z.object({
      strongBuy: z.number(),
      buy: z.number(),
      hold: z.number(),
      sell: z.number(),
      strongSell: z.number(),
    }),
    consensus: z.string(),
  }),
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();

    try {
      const result = await yf.quoteSummary(ticker, {
        modules: ['recommendationTrend', 'financialData'],
      });

      if (!result) {
        throw new Error(`Analyst ratings not found for ${ticker}`);
      }

      // Get the most recent recommendation trend
      const trends = result.recommendationTrend?.trend || [];
      const latestTrend = trends[0];

      const strongBuy = latestTrend?.strongBuy || 0;
      const buy = latestTrend?.buy || 0;
      const hold = latestTrend?.hold || 0;
      const sell = latestTrend?.sell || 0;
      const strongSell = latestTrend?.strongSell || 0;
      const total = strongBuy + buy + hold + sell + strongSell;

      // Determine consensus
      let consensus = 'Hold';
      const bullish = strongBuy + buy;
      const bearish = sell + strongSell;

      if (total > 0) {
        const bullishPercent = (bullish / total) * 100;
        const bearishPercent = (bearish / total) * 100;

        if (bullishPercent >= 60) {
          consensus = 'Strong Buy';
        } else if (bullishPercent >= 40) {
          consensus = 'Buy';
        } else if (bearishPercent >= 40) {
          consensus = 'Sell';
        } else {
          consensus = 'Hold';
        }
      }

      const targetPrice = result.financialData?.targetMeanPrice || null;
      const currentRating = result.financialData?.recommendationKey || undefined;

      return {
        ticker,
        currentRating,
        targetPrice,
        numberOfAnalysts: total,
        ratings: {
          strongBuy,
          buy,
          hold,
          sell,
          strongSell,
        },
        consensus,
      };
    } catch (error) {
      throw new Error(`Failed to fetch analyst ratings for ${ticker}: ${error}`);
    }
  },
});

// Tool 2: Get Insider Trading Activity
export const getInsiderTradingTool = createTool({
  id: 'get-insider-trading',
  description: 'Get recent insider trading activity (buys and sells by company executives)',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    transactions: z.array(z.object({
      name: z.string(),
      position: z.string(),
      transactionType: z.string(),
      shares: z.number(),
      value: z.number().optional(),
      date: z.string(),
    })),
    summary: z.object({
      totalBuys: z.number(),
      totalSells: z.number(),
      netSentiment: z.string(),
    }),
  }),
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();

    try {
      const result = await yf.quoteSummary(ticker, {
        modules: ['insiderTransactions'],
      });

      if (!result || !result.insiderTransactions?.transactions) {
        return {
          ticker,
          transactions: [],
          summary: {
            totalBuys: 0,
            totalSells: 0,
            netSentiment: 'Neutral',
          },
        };
      }

      const transactions = result.insiderTransactions.transactions.map((tx: any) => ({
        name: tx.filerName || 'Unknown',
        position: tx.filerRelation || 'Unknown',
        transactionType: tx.transactionText || 'Unknown',
        shares: tx.shares ?? 0,
        value: tx.value ?? undefined,
        date: tx.startDate instanceof Date ? tx.startDate.toISOString() : new Date().toISOString(),
      }));

      // Calculate buy/sell sentiment
      let totalBuys = 0;
      let totalSells = 0;

      transactions.forEach((tx: any) => {
        const txType = tx.transactionType.toLowerCase();
        if (txType.includes('buy') || txType.includes('purchase')) {
          totalBuys++;
        } else if (txType.includes('sell') || txType.includes('sale')) {
          totalSells++;
        }
      });

      let netSentiment = 'Neutral';
      if (totalBuys > totalSells * 1.5) {
        netSentiment = 'Bullish';
      } else if (totalSells > totalBuys * 1.5) {
        netSentiment = 'Bearish';
      }

      return {
        ticker,
        transactions: transactions.slice(0, 10), // Limit to 10 most recent
        summary: {
          totalBuys,
          totalSells,
          netSentiment,
        },
      };
    } catch (error) {
      throw new Error(`Failed to fetch insider trading for ${ticker}: ${error}`);
    }
  },
});

// Tool 3: Get Upgrade/Downgrade History
export const getUpgradeDowngradeTool = createTool({
  id: 'get-upgrade-downgrade',
  description: 'Get recent analyst upgrade and downgrade history for a stock',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    events: z.array(z.object({
      firm: z.string(),
      action: z.string(),
      fromGrade: z.string().optional(),
      toGrade: z.string(),
      date: z.string(),
    })),
    recentSentiment: z.string(),
  }),
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();

    try {
      const result = await yf.quoteSummary(ticker, {
        modules: ['upgradeDowngradeHistory'],
      });

      if (!result || !result.upgradeDowngradeHistory?.history) {
        return {
          ticker,
          events: [],
          recentSentiment: 'Neutral',
        };
      }

      const events = result.upgradeDowngradeHistory.history
        .slice(0, 10) // Most recent 10
        .map((event: any) => ({
          firm: event.firm || 'Unknown',
          action: event.action || 'Unknown',
          fromGrade: event.fromGrade || undefined,
          toGrade: event.toGrade || 'Unknown',
          date: event.epochGradeDate
            ? new Date(event.epochGradeDate * 1000).toISOString()
            : new Date().toISOString(),
        }));

      // Calculate recent sentiment
      let upgrades = 0;
      let downgrades = 0;

      events.forEach((event: any) => {
        const action = event.action.toLowerCase();
        if (action.includes('up') || action.includes('init') || action.includes('reit')) {
          upgrades++;
        } else if (action.includes('down') || action.includes('lower')) {
          downgrades++;
        }
      });

      let recentSentiment = 'Neutral';
      if (upgrades > downgrades) {
        recentSentiment = 'Positive';
      } else if (downgrades > upgrades) {
        recentSentiment = 'Negative';
      }

      return {
        ticker,
        events,
        recentSentiment,
      };
    } catch (error) {
      throw new Error(`Failed to fetch upgrade/downgrade history for ${ticker}: ${error}`);
    }
  },
});

// Tool 4: Get Earnings Sentiment (from earnings data)
export const getEarningsSentimentTool = createTool({
  id: 'get-earnings-sentiment',
  description: 'Get earnings performance vs estimates to gauge market sentiment',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    latestEarnings: z.object({
      reportDate: z.string(),
      epsActual: z.number().nullable(),
      epsEstimate: z.number().nullable(),
      epsSurprise: z.number().nullable(),
      epsSurprisePercent: z.number().nullable(),
      revenueActual: z.number().nullable(),
      revenueEstimate: z.number().nullable(),
    }),
    sentiment: z.string(),
  }),
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();

    try {
      const result = await yf.quoteSummary(ticker, {
        modules: ['earnings', 'earningsHistory'],
      });

      if (!result) {
        throw new Error(`Earnings data not found for ${ticker}`);
      }

      // Get latest earnings from history
      const earningsHistory = result.earningsHistory?.history || [];
      const latestEarnings = earningsHistory[0];

      const epsActual = latestEarnings?.epsActual ?? null;
      const epsEstimate = latestEarnings?.epsEstimate ?? null;
      const epsSurprise = latestEarnings?.surprisePercent ?? null;

      // Get revenue from earnings
      const financialsQuarterly = result.earnings?.financialsChart?.quarterly || [];
      const latestQuarter = financialsQuarterly[financialsQuarterly.length - 1];
      const revenueActual = latestQuarter?.revenue ?? null;
      // Note: Yahoo Finance API doesn't provide revenue estimates in this module
      const revenueEstimate = null;

      // Determine sentiment
      let sentiment = 'Neutral';
      if (epsSurprise !== null) {
        if (epsSurprise > 5) {
          sentiment = 'Very Positive (Beat Estimates)';
        } else if (epsSurprise > 0) {
          sentiment = 'Positive (Beat Estimates)';
        } else if (epsSurprise < -5) {
          sentiment = 'Very Negative (Missed Estimates)';
        } else if (epsSurprise < 0) {
          sentiment = 'Negative (Missed Estimates)';
        }
      }

      return {
        ticker,
        latestEarnings: {
          reportDate: latestEarnings?.quarter instanceof Date ? latestEarnings.quarter.toISOString() : 'Unknown',
          epsActual,
          epsEstimate,
          epsSurprise,
          epsSurprisePercent: epsSurprise,
          revenueActual,
          revenueEstimate,
        },
        sentiment,
      };
    } catch (error) {
      throw new Error(`Failed to fetch earnings sentiment for ${ticker}: ${error}`);
    }
  },
});
