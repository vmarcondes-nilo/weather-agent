import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance();

// Tool 1: Get Stock Price
export const getStockPriceTool = createTool({
  id: 'get-stock-price',
  description: 'Get current stock price, change, and basic trading data for a ticker symbol',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)'),
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
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    
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

// Tool 2: Get Financial Metrics
export const getFinancialsTool = createTool({
  id: 'get-financials',
  description: 'Get key financial metrics and ratios for a company',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    peRatio: z.number().nullable(),
    eps: z.number().nullable(),
    dividendYield: z.number().nullable(),
    profitMargin: z.number().nullable(),
    debtToEquity: z.number().nullable(),
    revenueGrowth: z.number().nullable(),
    beta: z.number().nullable(),
  }),
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    
    try {
      const quote = await yf.quote(ticker);
      
      if (!quote) {
        throw new Error(`Financial data not found for ${ticker}`);
      }
      
      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        peRatio: quote.trailingPE || null,
        eps: quote.epsTrailingTwelveMonths || null,
        dividendYield: quote.dividendYield ? quote.dividendYield * 100 : null,
        profitMargin: quote.profitMargins ? quote.profitMargins * 100 : null,
        debtToEquity: (quote as any).debtToEquity || null,
        revenueGrowth: quote.revenueGrowth ? quote.revenueGrowth * 100 : null,
        beta: quote.beta || null,
      };
    } catch (error) {
      throw new Error(`Failed to fetch financials for ${ticker}: ${error}`);
    }
  },
});

// Tool 3: Get Company News
export const getCompanyNewsTool = createTool({
  id: 'get-company-news',
  description: 'Get recent news articles and press releases about a company',
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
    limit: z.number().optional().describe('Number of news articles to retrieve (default: 5)'),
  }),
  outputSchema: z.object({
    ticker: z.string(),
    articles: z.array(z.object({
      title: z.string(),
      publisher: z.string(),
      link: z.string(),
      publishedDate: z.string(),
      summary: z.string().optional(),
    })),
  }),
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    const limit = context.limit || 5;
    
    try {
      const result = await yf.search(ticker, { newsCount: limit });
      
      if (!result.news || result.news.length === 0) {
        return {
          ticker,
          articles: [],
        };
      }
      
      const articles = result.news.slice(0, limit).map((item: any) => ({
        title: item.title || 'No title',
        publisher: item.publisher || 'Unknown',
        link: item.link || '',
        publishedDate: item.providerPublishTime 
          ? new Date(item.providerPublishTime * 1000).toISOString()
          : new Date().toISOString(),
        summary: item.summary || undefined,
      }));
      
      return {
        ticker,
        articles,
      };
    } catch (error) {
      throw new Error(`Failed to fetch news for ${ticker}: ${error}`);
    }
  },
});

// Helper function to format market cap
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
