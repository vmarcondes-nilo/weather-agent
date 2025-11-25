// ============================================================================
// FUNDAMENTAL ANALYSIS TOOLS
// ============================================================================
// This file provides specialized tools for deep fundamental analysis of stocks.
// These tools are used by the Fundamental Analyst Agent to analyze:
// - Income statement metrics (revenue, margins, profitability)
// - Balance sheet data (assets, liabilities, cash, debt)
// - Cash flow statements (operating CF, free CF, capex)
// - Comprehensive financial ratios (profitability, liquidity, leverage, valuation)
//
// NOTE: Due to Yahoo Finance API changes (Nov 2024), these tools fetch the
// LATEST financial period data (most recent fiscal year/quarter) rather than
// multi-year historical data.
// ============================================================================

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import YahooFinance from 'yahoo-finance2';

// Initialize Yahoo Finance API client
// suppressNotices: Suppresses the Yahoo Finance survey notice in console
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// Re-export the basic financials tool from equity-tools for convenience
// This provides quick access to key metrics (P/E, EPS, margins, debt ratios)
export { getFinancialsTool } from './equity-tools';

// ============================================================================
// TOOL 1: GET LATEST FINANCIALS (DETAILED)
// ============================================================================
// This tool provides a detailed breakdown of the income statement and margins.
// It replaces the historical income statement tool (which is no longer available
// due to Yahoo Finance API limitations).
//
// USE THIS WHEN YOU NEED:
// - Detailed revenue and profitability analysis
// - Margin analysis (gross, EBITDA, operating, net)
// - Growth rates (revenue and earnings)
// - EBITDA and gross profit figures
// ============================================================================
export const getLatestFinancialsDetailedTool = createTool({
  id: 'get-latest-financials-detailed',
  description: 'Get detailed current financial data including revenue, cash flow, margins, and profitability metrics',
  
  // INPUT: Just a ticker symbol
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  
  // OUTPUT: Structured financial data with three main sections
  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    
    // Financial period context (when is this data from?)
    financialPeriod: z.object({
      lastFiscalYear: z.string(),        // Date of last fiscal year end
      mostRecentQuarter: z.string(),     // Date of most recent quarter
    }),
    
    // Income statement metrics (profitability)
    incomeMetrics: z.object({
      totalRevenue: z.number().nullable(),      // Top line (all sales)
      grossProfit: z.number().nullable(),       // Revenue - COGS
      ebitda: z.number().nullable(),            // Earnings Before Interest, Tax, Depreciation, Amortization
      netIncome: z.number().nullable(),         // Bottom line (profit after everything)
      eps: z.number().nullable(),               // Earnings Per Share
      earningsGrowth: z.number().nullable(),    // YoY earnings growth %
      revenueGrowth: z.number().nullable(),     // YoY revenue growth %
    }),
    
    // Margin analysis (profitability as % of revenue)
    margins: z.object({
      grossMargin: z.number().nullable(),       // (Gross Profit / Revenue) * 100
      ebitdaMargin: z.number().nullable(),      // (EBITDA / Revenue) * 100
      operatingMargin: z.number().nullable(),   // (Operating Income / Revenue) * 100
      profitMargin: z.number().nullable(),      // (Net Income / Revenue) * 100
    }),
  }),
  
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    
    try {
      // Fetch basic quote data for company name
      const quote = await yf.quote(ticker);
      
      // Fetch detailed financial data from two modules:
      // - financialData: Revenue, profit, EBITDA, margins, growth rates
      // - defaultKeyStatistics: EPS, net income, fiscal dates
      const summary = await yf.quoteSummary(ticker, { 
        modules: ['financialData', 'defaultKeyStatistics'] 
      });
      
      const financialData = summary.financialData || ({} as any);
      const keyStats = summary.defaultKeyStatistics || ({} as any);
      
      // Build and return the structured output
      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        
        // Convert Unix timestamps to readable dates
        financialPeriod: {
          lastFiscalYear: keyStats.lastFiscalYearEnd ? new Date(keyStats.lastFiscalYearEnd).toLocaleDateString() : 'N/A',
          mostRecentQuarter: keyStats.mostRecentQuarter ? new Date(keyStats.mostRecentQuarter).toLocaleDateString() : 'N/A',
        },
        
        // Income metrics (all in absolute dollar amounts)
        incomeMetrics: {
          totalRevenue: financialData.totalRevenue || null,
          grossProfit: financialData.grossProfits || null,
          ebitda: financialData.ebitda || null,
          netIncome: keyStats.netIncomeToCommon || null,
          eps: keyStats.trailingEps || null,
          earningsGrowth: financialData.earningsGrowth ? financialData.earningsGrowth * 100 : null,  // Convert decimal to %
          revenueGrowth: financialData.revenueGrowth ? financialData.revenueGrowth * 100 : null,     // Convert decimal to %
        },
        
        // Margins (all converted from decimals to percentages)
        margins: {
          grossMargin: financialData.grossMargins ? financialData.grossMargins * 100 : null,
          ebitdaMargin: financialData.ebitdaMargins ? financialData.ebitdaMargins * 100 : null,
          operatingMargin: financialData.operatingMargins ? financialData.operatingMargins * 100 : null,
          profitMargin: financialData.profitMargins ? financialData.profitMargins * 100 : null,
        },
      };
    } catch (error) {
      throw new Error(`Failed to fetch detailed financials for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// TOOL 2: GET BALANCE SHEET DATA
// ============================================================================
// This tool provides balance sheet analysis - the company's financial position
// at a point in time. Think of it as a "snapshot" of what the company owns
// (assets) and what it owes (liabilities).
//
// USE THIS WHEN YOU NEED:
// - Cash position and liquidity analysis
// - Debt levels and leverage ratios
// - Financial health assessment (current ratio, quick ratio)
// - Share structure and short interest data
// - Book value and price-to-book valuation
//
// KEY RATIOS EXPLAINED:
// - Current Ratio = Current Assets / Current Liabilities (should be > 1.0)
// - Quick Ratio = (Current Assets - Inventory) / Current Liabilities (more conservative)
// - Debt-to-Equity = Total Debt / Shareholder Equity (lower is generally safer)
// ============================================================================
export const getBalanceSheetTool = createTool({
  id: 'get-balance-sheet',
  description: 'Get current balance sheet data including assets, liabilities, cash, and debt',
  
  // INPUT: Just a ticker symbol
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  
  // OUTPUT: Two main sections - balance sheet metrics and share data
  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    
    // Balance sheet metrics (financial position)
    balanceSheet: z.object({
      totalCash: z.number().nullable(),           // Cash and cash equivalents
      cashPerShare: z.number().nullable(),        // Cash divided by shares outstanding
      totalDebt: z.number().nullable(),           // All short-term + long-term debt
      debtToEquity: z.number().nullable(),        // Debt / Equity (leverage ratio)
      quickRatio: z.number().nullable(),          // (Current Assets - Inventory) / Current Liabilities
      currentRatio: z.number().nullable(),        // Current Assets / Current Liabilities
      bookValue: z.number().nullable(),           // Book value per share (equity / shares)
      priceToBook: z.number().nullable(),         // Price / Book Value (valuation metric)
    }),
    
    // Share structure and short interest
    shares: z.object({
      sharesOutstanding: z.number().nullable(),   // Total shares issued
      floatShares: z.number().nullable(),         // Shares available for public trading
      sharesShort: z.number().nullable(),         // Shares currently sold short
      shortRatio: z.number().nullable(),          // Days to cover (short interest / avg volume)
    }),
  }),
  
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    
    try {
      // Fetch basic quote data for company name
      const quote = await yf.quote(ticker);
      
      // Fetch detailed balance sheet data from two modules:
      // - financialData: Cash, debt, liquidity ratios
      // - defaultKeyStatistics: Book value, share data, short interest
      const summary = await yf.quoteSummary(ticker, { 
        modules: ['financialData', 'defaultKeyStatistics'] 
      });
      
      const financialData = summary.financialData || ({} as any);
      const keyStats = summary.defaultKeyStatistics || ({} as any);
      
      // Build and return the structured output
      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        
        // Balance sheet metrics
        balanceSheet: {
          totalCash: financialData.totalCash || null,
          cashPerShare: financialData.totalCashPerShare || null,
          totalDebt: financialData.totalDebt || null,
          debtToEquity: financialData.debtToEquity || null,
          quickRatio: financialData.quickRatio || null,
          currentRatio: financialData.currentRatio || null,
          bookValue: keyStats.bookValue || null,
          priceToBook: keyStats.priceToBook || null,
        },
        
        // Share structure
        shares: {
          sharesOutstanding: keyStats.sharesOutstanding || null,
          floatShares: keyStats.floatShares || null,
          sharesShort: keyStats.sharesShort || null,
          shortRatio: keyStats.shortRatio || null,
        },
      };
    } catch (error) {
      throw new Error(`Failed to fetch balance sheet for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// TOOL 3: GET CASH FLOW DATA
// ============================================================================
// This tool provides cash flow analysis - how cash moves in and out of the
// business. Cash flow is often considered more reliable than earnings because
// it's harder to manipulate with accounting tricks.
//
// USE THIS WHEN YOU NEED:
// - Operating cash flow (cash from business operations)
// - Free cash flow (cash available after maintaining/expanding the business)
// - Capital expenditure analysis (how much is invested in growth)
// - Cash flow quality assessment
//
// KEY CONCEPTS:
// - Operating Cash Flow (OCF) = Cash generated from core business operations
// - Free Cash Flow (FCF) = Operating CF - Capital Expenditures
// - Capital Expenditures (CapEx) = Money spent on assets (equipment, buildings, etc.)
// - FCF is what's left to pay dividends, buy back stock, or pay down debt
//
// QUALITY CHECKS:
// - Positive FCF = Good (company generates cash)
// - FCF > Net Income = Very good (earnings are "real" cash)
// - Negative FCF = Concerning (unless it's a growth-stage company investing heavily)
// ============================================================================
export const getCashFlowTool = createTool({
  id: 'get-cash-flow',
  description: 'Get cash flow data including operating cash flow, free cash flow, and capital expenditures',
  
  // INPUT: Just a ticker symbol
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  
  // OUTPUT: Cash flow metrics in both total and per-share formats
  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    cashFlow: z.object({
      operatingCashFlow: z.number().nullable(),     // Cash from operations (total)
      freeCashFlow: z.number().nullable(),          // Cash after capex (total)
      capitalExpenditures: z.number().nullable(),   // CapEx = OCF - FCF
      fcfPerShare: z.number().nullable(),           // FCF divided by shares
      ocfPerShare: z.number().nullable(),           // OCF divided by shares
    }),
  }),
  
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    
    try {
      // Fetch basic quote data for company name and shares outstanding
      const quote = await yf.quote(ticker);
      
      // Fetch cash flow data from financialData module
      const summary = await yf.quoteSummary(ticker, { 
        modules: ['financialData'] 
      });
      
      const financialData = summary.financialData || ({} as any);
      const sharesOutstanding = quote.sharesOutstanding || 1;  // Avoid division by zero
      
      // Extract cash flow values
      const operatingCF = financialData.operatingCashflow || null;
      const freeCF = financialData.freeCashflow || null;
      
      // Calculate capital expenditures (CapEx = Operating CF - Free CF)
      // This is the cash spent on maintaining and growing the business
      const capex = operatingCF && freeCF ? operatingCF - freeCF : null;
      
      // Build and return the structured output
      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        cashFlow: {
          operatingCashFlow: operatingCF,
          freeCashFlow: freeCF,
          capitalExpenditures: capex,
          fcfPerShare: freeCF ? freeCF / sharesOutstanding : null,    // Per-share metrics
          ocfPerShare: operatingCF ? operatingCF / sharesOutstanding : null,
        },
      };
    } catch (error) {
      throw new Error(`Failed to fetch cash flow for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// TOOL 4: GET FINANCIAL RATIOS (COMPREHENSIVE)
// ============================================================================
// This is the MOST COMPREHENSIVE tool - it provides all key financial ratios
// organized into 5 categories. Use this when you need a complete financial
// health assessment or want to compare a company to industry benchmarks.
//
// THE 5 CATEGORIES:
//
// 1. PROFITABILITY - How efficiently does the company make money?
//    - Margins: What % of revenue becomes profit at each stage?
//    - ROE/ROA: How well does the company use its equity/assets?
//    - Growth: Is revenue and earnings growing?
//
// 2. LIQUIDITY - Can the company pay its short-term bills?
//    - Current Ratio: Short-term assets vs short-term liabilities
//    - Quick Ratio: Like current ratio but excludes inventory (more conservative)
//    - Cash Ratio: Only cash vs liabilities (most conservative)
//
// 3. LEVERAGE - How much debt does the company have?
//    - Debt-to-Equity: Total debt / shareholder equity
//    - Interest Coverage: Can the company afford its interest payments?
//
// 4. EFFICIENCY - How well does the company use its resources?
//    - Revenue Per Share: How much revenue per share
//    - Cash Per Share: How much cash per share
//
// 5. VALUATION - Is the stock price reasonable?
//    - P/E: Price / Earnings (most common valuation metric)
//    - P/B: Price / Book Value (for asset-heavy companies)
//    - P/S: Price / Sales (for unprofitable but growing companies)
//    - PEG: P/E / Growth Rate (accounts for growth)
//    - EV/EBITDA: Enterprise Value / EBITDA (accounts for debt)
//
// USE THIS WHEN YOU NEED:
// - Complete financial health assessment
// - Comparing company to industry peers
// - Identifying strengths and weaknesses
// - All-in-one ratio analysis
// ============================================================================
export const getFinancialRatiosTool = createTool({
  id: 'get-financial-ratios',
  description: 'Get comprehensive financial ratios including profitability, liquidity, leverage, efficiency, and valuation ratios',
  
  // INPUT: Just a ticker symbol
  inputSchema: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  
  // OUTPUT: Five categories of financial ratios
  outputSchema: z.object({
    ticker: z.string(),
    companyName: z.string(),
    
    // CATEGORY 1: Profitability Ratios
    profitability: z.object({
      grossMargin: z.number().nullable(),          // (Gross Profit / Revenue) * 100
      operatingMargin: z.number().nullable(),      // (Operating Income / Revenue) * 100
      netMargin: z.number().nullable(),            // (Net Income / Revenue) * 100
      roe: z.number().nullable(),                  // Return on Equity (Net Income / Equity) * 100
      roa: z.number().nullable(),                  // Return on Assets (Net Income / Assets) * 100
      earningsGrowth: z.number().nullable(),       // YoY earnings growth %
      revenueGrowth: z.number().nullable(),        // YoY revenue growth %
    }),
    
    // CATEGORY 2: Liquidity Ratios (ability to pay short-term debts)
    liquidity: z.object({
      currentRatio: z.number().nullable(),         // Current Assets / Current Liabilities
      quickRatio: z.number().nullable(),           // (Current Assets - Inventory) / Current Liabilities
      cashRatio: z.number().nullable(),            // Cash / Total Debt (custom calculation)
    }),
    
    // CATEGORY 3: Leverage Ratios (debt levels)
    leverage: z.object({
      debtToEquity: z.number().nullable(),         // Total Debt / Shareholder Equity
      interestCoverage: z.number().nullable(),     // EBIT / Interest Expense
    }),
    
    // CATEGORY 4: Efficiency Ratios (resource utilization)
    efficiency: z.object({
      revenuePerShare: z.number().nullable(),      // Revenue / Shares Outstanding
      cashPerShare: z.number().nullable(),         // Cash / Shares Outstanding
    }),
    
    // CATEGORY 5: Valuation Ratios (is the stock price reasonable?)
    valuation: z.object({
      peRatio: z.number().nullable(),              // Price / Earnings (trailing)
      forwardPE: z.number().nullable(),            // Price / Forward Earnings Estimate
      pbRatio: z.number().nullable(),              // Price / Book Value
      psRatio: z.number().nullable(),              // Price / Sales
      pegRatio: z.number().nullable(),             // P/E Ratio / Growth Rate
      evToEbitda: z.number().nullable(),           // Enterprise Value / EBITDA
      evToRevenue: z.number().nullable(),          // Enterprise Value / Revenue
    }),
  }),
  
  execute: async ({ context }) => {
    const ticker = context.ticker.toUpperCase();
    
    try {
      // Fetch basic quote data for company name
      const quote = await yf.quote(ticker);
      
      // Fetch comprehensive financial data from three modules:
      // - financialData: Margins, ROE, ROA, liquidity, leverage, efficiency
      // - defaultKeyStatistics: Forward P/E, P/B, PEG, EV/EBITDA
      // - summaryDetail: Trailing P/E, P/S
      const summary = await yf.quoteSummary(ticker, {
        modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail']
      });

      const financialData = summary.financialData || ({} as any);
      const keyStats = summary.defaultKeyStatistics || ({} as any);
      const summaryDetail = summary.summaryDetail || ({} as any);

      // Fetch EBIT and Interest Expense from fundamentalsTimeSeries
      // (incomeStatementHistory has been returning incomplete data since Nov 2024)
      const now = new Date();
      const twoYearsAgo = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
      let interestCoverage: number | null = null;
      try {
        const timeSeries = await yf.fundamentalsTimeSeries(ticker, {
          period1: twoYearsAgo.toISOString().split('T')[0],
          period2: now.toISOString().split('T')[0],
          type: 'annual',
          module: 'all'
        });
        const latest = timeSeries[timeSeries.length - 1] as any;
        const ebit = latest?.EBIT;
        const interestExpense = latest?.interestExpense;
        if (ebit && interestExpense && interestExpense !== 0) {
          interestCoverage = Math.abs(ebit / interestExpense);
        }
      } catch {
        // fundamentalsTimeSeries may not be available for all tickers
      }

      // Calculate cash ratio (custom metric not provided by API)
      // Cash Ratio = Cash / Total Debt (how much cash vs debt)
      const cashRatio = financialData.totalCash && financialData.totalDebt
        ? financialData.totalCash / financialData.totalDebt
        : null;

      // Calculate PEG ratio (Yahoo Finance no longer provides this directly)
      // PEG = P/E Ratio / Earnings Growth Rate (as percentage)
      const trailingPE = summaryDetail.trailingPE;
      const earningsGrowth = financialData.earningsGrowth;
      const pegRatio = trailingPE && earningsGrowth && earningsGrowth > 0
        ? trailingPE / (earningsGrowth * 100)
        : null;
      
      // Build and return all 5 categories of ratios
      return {
        ticker,
        companyName: quote.longName || quote.shortName || ticker,
        
        // CATEGORY 1: Profitability (convert decimals to percentages)
        profitability: {
          grossMargin: financialData.grossMargins ? financialData.grossMargins * 100 : null,
          operatingMargin: financialData.operatingMargins ? financialData.operatingMargins * 100 : null,
          netMargin: financialData.profitMargins ? financialData.profitMargins * 100 : null,
          roe: financialData.returnOnEquity ? financialData.returnOnEquity * 100 : null,
          roa: financialData.returnOnAssets ? financialData.returnOnAssets * 100 : null,
          earningsGrowth: financialData.earningsGrowth ? financialData.earningsGrowth * 100 : null,
          revenueGrowth: financialData.revenueGrowth ? financialData.revenueGrowth * 100 : null,
        },
        
        // CATEGORY 2: Liquidity (ability to pay short-term debts)
        liquidity: {
          currentRatio: financialData.currentRatio || null,
          quickRatio: financialData.quickRatio || null,
          cashRatio,  // Custom calculation from above
        },
        
        // CATEGORY 3: Leverage (debt levels)
        leverage: {
          debtToEquity: financialData.debtToEquity ?? null,
          interestCoverage,  // Calculated from EBIT / Interest Expense
        },
        
        // CATEGORY 4: Efficiency (per-share metrics)
        efficiency: {
          revenuePerShare: financialData.revenuePerShare || null,
          cashPerShare: financialData.totalCashPerShare || null,
        },
        
        // CATEGORY 5: Valuation (is the stock price reasonable?)
        valuation: {
          peRatio: summaryDetail.trailingPE ?? null,                        // From summaryDetail
          forwardPE: keyStats.forwardPE ?? null,                            // From keyStats
          pbRatio: keyStats.priceToBook ?? null,                            // From keyStats
          psRatio: summaryDetail.priceToSalesTrailing12Months ?? null,     // From summaryDetail
          pegRatio,                                                         // Calculated: P/E / Earnings Growth %
          evToEbitda: keyStats.enterpriseToEbitda ?? null,                  // From keyStats
          evToRevenue: keyStats.enterpriseToRevenue ?? null,                // From keyStats
        },
      };
    } catch (error) {
      throw new Error(`Failed to fetch financial ratios for ${ticker}: ${error}`);
    }
  },
});

// ============================================================================
// END OF FUNDAMENTAL TOOLS
// ============================================================================
// Summary of all 5 tools:
// 1. getFinancialsTool (re-exported) - Quick key metrics
// 2. getLatestFinancialsDetailedTool - Income statement & margins
// 3. getBalanceSheetTool - Assets, liabilities, cash, debt
// 4. getCashFlowTool - Operating CF, Free CF, CapEx
// 5. getFinancialRatiosTool - Complete ratio analysis (5 categories)
//
// These tools work together to provide complete fundamental analysis coverage.
// The Fundamental Analyst Agent uses these tools to build comprehensive
// financial assessments and investment recommendations.
// ============================================================================
