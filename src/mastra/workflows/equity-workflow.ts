import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance();

const llm = openai('gpt-4o');

const analysisAgent = new Agent({
  name: 'Analysis Synthesizer',
  model: llm,
  instructions: `
    You are an expert equity analyst synthesizing research data into clear, actionable insights.
    
    Analyze the provided stock data and create a comprehensive but concise investment analysis.
    
    Structure your response as follows:
    
    📊 QUICK ANALYSIS: [TICKER]
    ═══════════════════════════
    
    💼 COMPANY OVERVIEW
    • Current Price: $X.XX (±Y.Y%)
    • Market Cap: $XB
    • 52-Week Range: $XX - $XX
    
    📈 KEY METRICS
    • P/E Ratio: X.X
    • EPS: $X.XX
    • Profit Margin: X.X%
    • Revenue Growth: X.X%
    • Debt-to-Equity: X.X
    • Dividend Yield: X.X%
    • Beta: X.X
    
    📰 RECENT NEWS HIGHLIGHTS
    • [Brief summary of top 3 news items]
    
    🎯 INVESTMENT THESIS
    **Bull Case:**
    • [2-3 positive factors]
    
    **Bear Case:**
    • [2-3 risk factors]
    
    **Valuation Assessment:**
    [Is it overvalued, fairly valued, or undervalued based on metrics?]
    
    **Rating:** [BUY / HOLD / SELL - with brief justification]
    
    ⚠️ RISK CONSIDERATIONS
    • [Key risks to monitor]
    
    ⚠️ Disclaimer: This is not financial advice. Conduct your own research before investing.
    
    Guidelines:
    - Be data-driven and cite specific numbers
    - Provide balanced perspective
    - Keep analysis concise but comprehensive
    - Highlight most important insights
    - Use clear, professional language
  `,
});

// Step 1: Fetch Stock Price
const fetchStockPrice = createStep({
  id: 'fetch-stock-price',
  description: 'Fetches current stock price and trading data',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    price: z.number(),
    change: z.number(),
    changePercent: z.number(),
    volume: z.number(),
    marketCap: z.string(),
    dayHigh: z.number(),
    dayLow: z.number(),
    fiftyTwoWeekHigh: z.number(),
    fiftyTwoWeekLow: z.number(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker.toUpperCase();
    
    try {
      const quote = await yf.quote(ticker);
      
      if (!quote) {
        throw new Error(`Ticker ${ticker} not found`);
      }
      
      const currentPrice = quote.regularMarketPrice || 0;
      const previousClose = quote.regularMarketPreviousClose || currentPrice;
      const change = currentPrice - previousClose;
      const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;
      
      return {
        ticker,
        price: currentPrice,
        change: parseFloat(change.toFixed(2)),
        changePercent: parseFloat(changePercent.toFixed(2)),
        volume: quote.regularMarketVolume || 0,
        marketCap: formatMarketCap(quote.marketCap || 0),
        dayHigh: quote.regularMarketDayHigh || currentPrice,
        dayLow: quote.regularMarketDayLow || currentPrice,
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh || currentPrice,
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow || currentPrice,
      };
    } catch (error) {
      throw new Error(`Failed to fetch stock price for ${ticker}: ${error}`);
    }
  },
});

// Step 2: Fetch Financial Metrics
const fetchFinancials = createStep({
  id: 'fetch-financials',
  description: 'Fetches key financial metrics and ratios',
  inputSchema: z.object({
    ticker: z.string(),
    price: z.number(),
    change: z.number(),
    changePercent: z.number(),
    volume: z.number(),
    marketCap: z.string(),
    dayHigh: z.number(),
    dayLow: z.number(),
    fiftyTwoWeekHigh: z.number(),
    fiftyTwoWeekLow: z.number(),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    priceData: z.object({
      price: z.number(),
      change: z.number(),
      changePercent: z.number(),
      volume: z.number(),
      marketCap: z.string(),
      dayHigh: z.number(),
      dayLow: z.number(),
      fiftyTwoWeekHigh: z.number(),
      fiftyTwoWeekLow: z.number(),
    }),
    financials: z.object({
      companyName: z.string(),
      peRatio: z.number().nullable(),
      eps: z.number().nullable(),
      dividendYield: z.number().nullable(),
      profitMargin: z.number().nullable(),
      debtToEquity: z.number().nullable(),
      revenueGrowth: z.number().nullable(),
      beta: z.number().nullable(),
    }),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker;
    
    try {
      const quote = await yf.quote(ticker);
      
      if (!quote) {
        throw new Error(`Financial data not found for ${ticker}`);
      }
      
      return {
        ticker,
        priceData: {
          price: inputData.price,
          change: inputData.change,
          changePercent: inputData.changePercent,
          volume: inputData.volume,
          marketCap: inputData.marketCap,
          dayHigh: inputData.dayHigh,
          dayLow: inputData.dayLow,
          fiftyTwoWeekHigh: inputData.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: inputData.fiftyTwoWeekLow,
        },
        financials: {
          companyName: quote.longName || quote.shortName || ticker,
          peRatio: quote.trailingPE || null,
          eps: quote.epsTrailingTwelveMonths || null,
          dividendYield: quote.dividendYield ? quote.dividendYield * 100 : null,
          profitMargin: quote.profitMargins ? quote.profitMargins * 100 : null,
          debtToEquity: (quote as any).debtToEquity || null,
          revenueGrowth: quote.revenueGrowth ? quote.revenueGrowth * 100 : null,
          beta: quote.beta || null,
        },
      };
    } catch (error) {
      throw new Error(`Failed to fetch financial data for ${ticker}: ${error}`);
    }
  },
});

// Define reusable schemas
const priceDataSchema = z.object({
  price: z.number(),
  change: z.number(),
  changePercent: z.number(),
  volume: z.number(),
  marketCap: z.string(),
  dayHigh: z.number(),
  dayLow: z.number(),
  fiftyTwoWeekHigh: z.number(),
  fiftyTwoWeekLow: z.number(),
});

const financialsSchema = z.object({
  companyName: z.string(),
  peRatio: z.number().nullable(),
  eps: z.number().nullable(),
  dividendYield: z.number().nullable(),
  profitMargin: z.number().nullable(),
  debtToEquity: z.number().nullable(),
  revenueGrowth: z.number().nullable(),
  beta: z.number().nullable(),
});

const newsItemSchema = z.object({
  title: z.string(),
  publisher: z.string(),
  publishedDate: z.string(),
  summary: z.string().optional(),
});

// Step 3: Fetch Company News
const fetchNews = createStep({
  id: 'fetch-news',
  description: 'Fetches recent company news and press releases',
  inputSchema: z.object({
    ticker: z.string(),
    priceData: priceDataSchema,
    financials: financialsSchema,
  }),
  outputSchema: z.object({
    ticker: z.string(),
    priceData: priceDataSchema,
    financials: financialsSchema,
    news: z.array(newsItemSchema),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const ticker = inputData.ticker;
    
    try {
      const result = await yf.search(ticker, { newsCount: 5 });
      
      const news = (result.news || []).slice(0, 5).map((item: any) => ({
        title: item.title || 'No title',
        publisher: item.publisher || 'Unknown',
        publishedDate: item.providerPublishTime 
          ? new Date(item.providerPublishTime * 1000).toLocaleDateString()
          : new Date().toLocaleDateString(),
        summary: item.summary || undefined,
      }));
      
      return {
        ticker: inputData.ticker,
        priceData: inputData.priceData,
        financials: inputData.financials,
        news,
      };
    } catch (error) {
      // If news fetch fails, return empty news array
      console.warn(`Failed to fetch news for ${ticker}:`, error);
      return {
        ticker: inputData.ticker,
        priceData: inputData.priceData,
        financials: inputData.financials,
        news: [],
      };
    }
  },
});

// Step 4: Synthesize Analysis
const synthesizeAnalysis = createStep({
  id: 'synthesize-analysis',
  description: 'Synthesizes all data into comprehensive investment analysis',
  inputSchema: z.object({
    ticker: z.string(),
    priceData: priceDataSchema,
    financials: financialsSchema,
    news: z.array(newsItemSchema),
  }),
  outputSchema: z.object({
    analysis: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const prompt = `Analyze the following stock data and provide a comprehensive investment analysis for ${inputData.ticker}:
    
PRICE DATA:
${JSON.stringify(inputData.priceData, null, 2)}

FINANCIAL METRICS:
${JSON.stringify(inputData.financials, null, 2)}

RECENT NEWS:
${JSON.stringify(inputData.news, null, 2)}

Provide a structured analysis following the format in your instructions.`;

    const response = await analysisAgent.streamLegacy([
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
const equityAnalysisWorkflow = createWorkflow({
  id: 'equity-analysis-workflow',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol to analyze'),
  }),
  outputSchema: z.object({
    analysis: z.string(),
  }),
})
  .then(fetchStockPrice)
  .then(fetchFinancials)
  .then(fetchNews)
  .then(synthesizeAnalysis);

equityAnalysisWorkflow.commit();

export { equityAnalysisWorkflow };

// Helper function
function formatMarketCap(value: number): string {
  if (value >= 1e12) {
    return `$${(value / 1e12).toFixed(2)}T`;
  } else if (value >= 1e9) {
    return `$${(value / 1e9).toFixed(2)}B`;
  } else if (value >= 1e6) {
    return `$${(value / 1e6).toFixed(2)}M`;
  } else {
    return `$${value.toFixed(0)}`;
  }
}

