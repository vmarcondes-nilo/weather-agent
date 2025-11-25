import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const llm = openai('gpt-4o');

const sentimentSynthesisAgent = new Agent({
  name: 'Sentiment Synthesizer',
  model: llm,
  instructions: `
    You are an expert sentiment analyst synthesizing market sentiment data into clear, actionable insights.

    Analyze the provided sentiment data and create a comprehensive sentiment analysis.

    Structure your response as follows:

    📰 SENTIMENT ANALYSIS: [TICKER]
    ═══════════════════════════════════

    🗞️ NEWS SENTIMENT
    • Recent Headlines: [List 2-3 key headlines]
    • News Flow: [Positive/Neutral/Negative]
    • Key Themes: [Major narratives emerging from news]
    • Impact Assessment: [High/Medium/Low]

    🏦 ANALYST CONSENSUS
    • Current Ratings: X Buy, Y Hold, Z Sell
    • Consensus: [Strong Buy/Buy/Hold/Sell]
    • Average Price Target: $X (X% upside/downside from current price)
    • Recent Changes: [Summary of upgrades/downgrades]
    • Momentum: [Improving/Stable/Deteriorating]

    👔 INSIDER ACTIVITY
    • Recent Transactions: X buys, Y sells (last 3 months)
    • Net Sentiment: [Bullish/Neutral/Bearish]
    • Notable Transactions: [Any significant insider moves]
    • Interpretation: [What insider activity signals]

    📊 EARNINGS SENTIMENT
    • Latest Report: [Beat/Met/Missed] estimates by X%
    • Revenue Performance: [Beat/Met/Missed] by X%
    • Guidance: [Raised/Maintained/Lowered/NA]
    • Market Reaction: [Positive/Neutral/Negative]

    🎯 OVERALL SENTIMENT SCORE
    • Current Sentiment: [Very Bullish/Bullish/Neutral/Bearish/Very Bearish]
    • Sentiment Trend: [Improving/Stable/Deteriorating]
    • Confidence Level: [High/Medium/Low]
    • Time Horizon: [This sentiment applies to short/medium/long term]

    💡 KEY TAKEAWAYS
    **Bullish Signals:**
    • [2-3 positive sentiment indicators]

    **Bearish Signals:**
    • [2-3 negative sentiment indicators]

    **Upcoming Catalysts:**
    • [Events that could shift sentiment]

    **Sentiment vs Price:**
    • [Note any divergence between sentiment and price action]

    🔮 SENTIMENT OUTLOOK
    [Your assessment of whether sentiment is likely to improve, remain stable, or deteriorate in the near term,
    and what key factors could drive sentiment changes. Be specific and actionable.]

    ⚠️ Disclaimer: Sentiment analysis captures market perception, which may differ from fundamental reality. Always combine sentiment with fundamental analysis.

    Guidelines:
    - Be data-driven and cite specific numbers
    - Distinguish between meaningful signals and noise
    - Weight recent data more heavily
    - Consider sentiment extremes (overly bullish/bearish can reverse)
    - Explain the significance of each sentiment indicator
    - Keep analysis concise but comprehensive
    - Use clear, professional language
    - Highlight divergences between different sentiment indicators
  `,
});

// Step 1: Fetch Company News
const fetchNews = createStep({
  id: 'fetch-news-sentiment',
  description: 'Fetches recent company news and press releases',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.object({
      title: z.string(),
      publisher: z.string(),
      publishedDate: z.string(),
      summary: z.string().optional(),
    })),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker.toUpperCase();

    try {
      const result = await yf.search(ticker, { newsCount: 10 });

      const news = (result.news || []).slice(0, 10).map((item: any) => ({
        title: item.title || 'No title',
        publisher: item.publisher || 'Unknown',
        publishedDate: item.providerPublishTime
          ? new Date(item.providerPublishTime * 1000).toLocaleDateString()
          : new Date().toLocaleDateString(),
        summary: item.summary || undefined,
      }));

      return {
        ticker,
        news,
      };
    } catch (error) {
      console.warn(`Failed to fetch news for ${ticker}:`, error);
      return {
        ticker,
        news: [],
      };
    }
  },
});

// Step 2: Fetch Analyst Ratings
const fetchAnalystRatings = createStep({
  id: 'fetch-analyst-ratings',
  description: 'Fetches analyst ratings and recommendations',
  inputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.object({
      title: z.string(),
      publisher: z.string(),
      publishedDate: z.string(),
      summary: z.string().optional(),
    })),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.object({
      title: z.string(),
      publisher: z.string(),
      publishedDate: z.string(),
      summary: z.string().optional(),
    })),
    analystRatings: z.object({
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
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker;

    try {
      const result = await yf.quoteSummary(ticker, {
        modules: ['recommendationTrend', 'financialData'],
      });

      const trends = result.recommendationTrend?.trend || [];
      const latestTrend = trends[0];

      const strongBuy = latestTrend?.strongBuy || 0;
      const buy = latestTrend?.buy || 0;
      const hold = latestTrend?.hold || 0;
      const sell = latestTrend?.sell || 0;
      const strongSell = latestTrend?.strongSell || 0;
      const total = strongBuy + buy + hold + sell + strongSell;

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
        ticker: inputData.ticker,
        news: inputData.news,
        analystRatings: {
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
        },
      };
    } catch (error) {
      console.warn(`Failed to fetch analyst ratings for ${ticker}:`, error);
      return {
        ticker: inputData.ticker,
        news: inputData.news,
        analystRatings: {
          currentRating: undefined,
          targetPrice: null,
          numberOfAnalysts: 0,
          ratings: {
            strongBuy: 0,
            buy: 0,
            hold: 0,
            sell: 0,
            strongSell: 0,
          },
          consensus: 'Unknown',
        },
      };
    }
  },
});

// Step 3: Fetch Insider Trading
const fetchInsiderTrading = createStep({
  id: 'fetch-insider-trading',
  description: 'Fetches insider trading activity',
  inputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.any()),
    analystRatings: z.any(),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.any()),
    analystRatings: z.any(),
    insiderTrading: z.object({
      transactions: z.array(z.object({
        name: z.string(),
        position: z.string(),
        transactionType: z.string(),
        shares: z.number(),
        date: z.string(),
      })),
      summary: z.object({
        totalBuys: z.number(),
        totalSells: z.number(),
        netSentiment: z.string(),
      }),
    }),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker;

    try {
      const result = await yf.quoteSummary(ticker, {
        modules: ['insiderTransactions'],
      });

      if (!result || !result.insiderTransactions?.transactions) {
        return {
          ...inputData,
          insiderTrading: {
            transactions: [],
            summary: {
              totalBuys: 0,
              totalSells: 0,
              netSentiment: 'Neutral',
            },
          },
        };
      }

      const transactions = result.insiderTransactions.transactions.map((tx: any) => ({
        name: tx.filerName || 'Unknown',
        position: tx.filerRelation || 'Unknown',
        transactionType: tx.transactionText || 'Unknown',
        shares: tx.shares?.raw || 0,
        date: tx.startDate?.fmt || new Date().toISOString(),
      }));

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
        ...inputData,
        insiderTrading: {
          transactions: transactions.slice(0, 10),
          summary: {
            totalBuys,
            totalSells,
            netSentiment,
          },
        },
      };
    } catch (error) {
      console.warn(`Failed to fetch insider trading for ${ticker}:`, error);
      return {
        ...inputData,
        insiderTrading: {
          transactions: [],
          summary: {
            totalBuys: 0,
            totalSells: 0,
            netSentiment: 'Neutral',
          },
        },
      };
    }
  },
});

// Step 4: Fetch Upgrade/Downgrade History
const fetchUpgradeDowngrade = createStep({
  id: 'fetch-upgrade-downgrade',
  description: 'Fetches analyst upgrade and downgrade history',
  inputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.any()),
    analystRatings: z.any(),
    insiderTrading: z.any(),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.any()),
    analystRatings: z.any(),
    insiderTrading: z.any(),
    upgradeDowngrade: z.object({
      events: z.array(z.object({
        firm: z.string(),
        action: z.string(),
        toGrade: z.string(),
        date: z.string(),
      })),
      recentSentiment: z.string(),
    }),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker;

    try {
      const result = await yf.quoteSummary(ticker, {
        modules: ['upgradeDowngradeHistory'],
      });

      if (!result || !result.upgradeDowngradeHistory?.history) {
        return {
          ...inputData,
          upgradeDowngrade: {
            events: [],
            recentSentiment: 'Neutral',
          },
        };
      }

      const events = result.upgradeDowngradeHistory.history
        .slice(0, 10)
        .map((event: any) => ({
          firm: event.firm || 'Unknown',
          action: event.action || 'Unknown',
          toGrade: event.toGrade || 'Unknown',
          date: event.epochGradeDate
            ? new Date(event.epochGradeDate * 1000).toLocaleDateString()
            : new Date().toLocaleDateString(),
        }));

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
        ...inputData,
        upgradeDowngrade: {
          events,
          recentSentiment,
        },
      };
    } catch (error) {
      console.warn(`Failed to fetch upgrade/downgrade history for ${ticker}:`, error);
      return {
        ...inputData,
        upgradeDowngrade: {
          events: [],
          recentSentiment: 'Neutral',
        },
      };
    }
  },
});

// Step 5: Fetch Earnings Sentiment
const fetchEarningsSentiment = createStep({
  id: 'fetch-earnings-sentiment',
  description: 'Fetches earnings performance vs estimates',
  inputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.any()),
    analystRatings: z.any(),
    insiderTrading: z.any(),
    upgradeDowngrade: z.any(),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.any()),
    analystRatings: z.any(),
    insiderTrading: z.any(),
    upgradeDowngrade: z.any(),
    earnings: z.object({
      reportDate: z.string(),
      epsActual: z.number().nullable(),
      epsEstimate: z.number().nullable(),
      epsSurprisePercent: z.number().nullable(),
      sentiment: z.string(),
    }),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker;

    try {
      const result = await yf.quoteSummary(ticker, {
        modules: ['earnings', 'earningsHistory'],
      });

      const earningsHistory = result.earningsHistory?.history || [];
      const latestEarnings = earningsHistory[0];

      const epsActual = latestEarnings?.epsActual?.raw || null;
      const epsEstimate = latestEarnings?.epsEstimate?.raw || null;
      const epsSurprisePercent = latestEarnings?.surprisePercent?.raw || null;

      let sentiment = 'Neutral';
      if (epsSurprisePercent !== null) {
        if (epsSurprisePercent > 5) {
          sentiment = 'Very Positive (Beat Estimates)';
        } else if (epsSurprisePercent > 0) {
          sentiment = 'Positive (Beat Estimates)';
        } else if (epsSurprisePercent < -5) {
          sentiment = 'Very Negative (Missed Estimates)';
        } else if (epsSurprisePercent < 0) {
          sentiment = 'Negative (Missed Estimates)';
        }
      }

      return {
        ...inputData,
        earnings: {
          reportDate: latestEarnings?.quarterEnd?.fmt || 'Unknown',
          epsActual,
          epsEstimate,
          epsSurprisePercent,
          sentiment,
        },
      };
    } catch (error) {
      console.warn(`Failed to fetch earnings sentiment for ${ticker}:`, error);
      return {
        ...inputData,
        earnings: {
          reportDate: 'Unknown',
          epsActual: null,
          epsEstimate: null,
          epsSurprisePercent: null,
          sentiment: 'Unknown',
        },
      };
    }
  },
});

// Step 6: Synthesize Sentiment Analysis
const synthesizeSentiment = createStep({
  id: 'synthesize-sentiment',
  description: 'Synthesizes all sentiment data into comprehensive analysis',
  inputSchema: z.object({
    ticker: z.string(),
    news: z.array(z.any()),
    analystRatings: z.any(),
    insiderTrading: z.any(),
    upgradeDowngrade: z.any(),
    earnings: z.any(),
  }),
  outputSchema: z.object({
    analysis: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    // Fetch current price for context
    const quote = await yf.quote(inputData.ticker);
    const currentPrice = quote.regularMarketPrice || 0;

    const prompt = `Analyze the following sentiment data and provide a comprehensive sentiment analysis for ${inputData.ticker}:

CURRENT PRICE: $${currentPrice}

NEWS DATA:
${JSON.stringify(inputData.news, null, 2)}

ANALYST RATINGS:
${JSON.stringify(inputData.analystRatings, null, 2)}

INSIDER TRADING:
${JSON.stringify(inputData.insiderTrading, null, 2)}

UPGRADE/DOWNGRADE HISTORY:
${JSON.stringify(inputData.upgradeDowngrade, null, 2)}

EARNINGS SENTIMENT:
${JSON.stringify(inputData.earnings, null, 2)}

Provide a structured sentiment analysis following the format in your instructions.`;

    const response = await sentimentSynthesisAgent.streamLegacy([
      {
        role: 'user',
        content: prompt,
      },
    ]);

    let analysisText = '';

    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      analysisText += chunk;
    }

    return {
      analysis: analysisText,
    };
  },
});

// Create the workflow
const sentimentAnalysisWorkflow = createWorkflow({
  id: 'sentiment-analysis-workflow',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol to analyze'),
  }),
  outputSchema: z.object({
    analysis: z.string(),
  }),
})
  .then(fetchNews)
  .then(fetchAnalystRatings)
  .then(fetchInsiderTrading)
  .then(fetchUpgradeDowngrade)
  .then(fetchEarningsSentiment)
  .then(synthesizeSentiment);

sentimentAnalysisWorkflow.commit();

export { sentimentAnalysisWorkflow };
