// ============================================================================
// S&P 500 STOCK UNIVERSE
// ============================================================================
// Complete list of S&P 500 constituents organized by GICS sector.
// This list is used by the Portfolio Optimizer Agent for screening and
// portfolio construction.
//
// Note: S&P 500 composition changes quarterly. This list should be
// periodically updated to reflect additions/removals.
//
// Last updated: December 2024
// Removed defunct/acquired: SIVB, FRC, ATVI, NLSN, DISH (acquired/delisted)
// Fixed ticker formats: BRK.B -> BRK-B, BF.B -> BF-B (Yahoo Finance format)
// ============================================================================

export const SP500_STOCKS: Record<string, string[]> = {
  // ============================================================================
  // INFORMATION TECHNOLOGY (~70 stocks)
  // ============================================================================
  'Information Technology': [
    // Mega-cap tech
    'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'AMD', 'CSCO', 'ACN',
    'IBM', 'INTC', 'INTU', 'TXN', 'QCOM', 'NOW', 'AMAT', 'ADI', 'LRCX', 'MU',
    'KLAC', 'SNPS', 'CDNS', 'PANW', 'MCHP', 'MSI', 'APH', 'ADSK', 'FTNT', 'NXPI',
    'MPWR', 'ON', 'FSLR', 'KEYS', 'CDW', 'TYL', 'ANSS', 'HPQ', 'HPE', 'NTAP',
    'WDC', 'STX', 'AKAM', 'SWKS', 'QRVO', 'TER', 'ZBRA', 'PTC', 'EPAM',
    'IT', 'CTSH', 'VRSN', 'FFIV', 'GLW', 'GEN', 'TRMB', 'ENPH', 'SEDG', 'ANET',
    'CRWD', 'DDOG', 'ZS', 'TEAM', 'SNOW', 'PLTR', 'NET', 'MDB', 'OKTA', 'HUBS',
  ],

  // ============================================================================
  // HEALTH CARE (~65 stocks)
  // ============================================================================
  'Health Care': [
    // Pharma & Biotech
    'LLY', 'UNH', 'JNJ', 'MRK', 'ABBV', 'TMO', 'ABT', 'PFE', 'DHR', 'BMY',
    'AMGN', 'GILD', 'VRTX', 'REGN', 'MDT', 'ISRG', 'SYK', 'BSX', 'ELV', 'CI',
    'CVS', 'MCK', 'ZTS', 'BDX', 'HCA', 'MRNA', 'BIIB', 'ILMN', 'IDXX', 'A',
    'DXCM', 'MTD', 'IQV', 'EW', 'RMD', 'ZBH', 'GEHC', 'CAH', 'HOLX', 'BAX',
    'COO', 'ALGN', 'TECH', 'WAT', 'STE', 'VTRS', 'CRL', 'RVTY', 'HSIC', 'XRAY',
    'DGX', 'LH', 'TFX', 'PODD', 'INCY', 'MOH', 'HUM', 'CNC', 'UHS', 'DVA',
    'OGN', 'SOLV', 'JAZZ', 'BIO',
  ],

  // ============================================================================
  // FINANCIALS (~70 stocks)
  // ============================================================================
  Financials: [
    // Banks
    'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'USB', 'PNC', 'TFC', 'SCHW',
    'COF', 'BK', 'STT', 'FITB', 'HBAN', 'RF', 'CFG', 'KEY', 'NTRS', 'MTB',
    'ZION', 'CMA',
    // Insurance
    'BRK-B', 'V', 'MA', 'AXP', 'SPGI', 'BLK', 'MMC', 'CB', 'AON', 'PGR',
    'CME', 'ICE', 'MCO', 'MET', 'AIG', 'PRU', 'MSCI', 'AFL', 'TRV', 'ALL',
    'AJG', 'NDAQ', 'WTW', 'HIG', 'CINF', 'L', 'EG', 'RJF', 'BRO', 'TROW',
    'FDS', 'GL', 'AIZ', 'LNC', 'IVZ', 'BEN',
    // Financial Services
    'PYPL', 'FIS', 'FISV', 'AMP', 'SYF', 'CBOE',
  ],

  // ============================================================================
  // CONSUMER DISCRETIONARY (~55 stocks)
  // ============================================================================
  'Consumer Discretionary': [
    // Retail
    'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'CMG',
    'MAR', 'ORLY', 'AZO', 'ROST', 'DHI', 'YUM', 'HLT', 'LEN', 'EBAY', 'GM',
    'F', 'BBY', 'ULTA', 'DRI', 'PHM', 'NVR', 'GRMN', 'APTV', 'LKQ', 'GPC',
    'POOL', 'CCL', 'RCL', 'WYNN', 'CZR', 'MGM', 'LVS', 'HAS', 'DPZ', 'DECK',
    'TPR', 'BWA', 'MHK', 'EXPE', 'NCLH', 'WHR', 'RL', 'PVH', 'VFC', 'GNRC',
    'PENN', 'AAP', 'BBWI', 'KMX', 'ETSY',
  ],

  // ============================================================================
  // COMMUNICATION SERVICES (~25 stocks)
  // ============================================================================
  'Communication Services': [
    'GOOGL', 'GOOG', 'META', 'NFLX', 'DIS', 'CMCSA', 'VZ', 'T', 'TMUS', 'CHTR',
    'EA', 'WBD', 'TTWO', 'OMC', 'IPG', 'MTCH', 'LYV', 'FOXA',
    'FOX', 'NWS', 'NWSA', 'LUMN',
  ],

  // ============================================================================
  // INDUSTRIALS (~75 stocks)
  // ============================================================================
  Industrials: [
    // Aerospace & Defense
    'RTX', 'HON', 'UPS', 'BA', 'CAT', 'DE', 'LMT', 'GE', 'UNP', 'ADP',
    'NOC', 'ETN', 'ITW', 'WM', 'GD', 'CSX', 'NSC', 'EMR', 'FDX', 'PH',
    'TT', 'CTAS', 'JCI', 'PCAR', 'CARR', 'CMI', 'AME', 'OTIS', 'RSG', 'FAST',
    'VRSK', 'GWW', 'ROK', 'CPRT', 'IR', 'LHX', 'DOV', 'HWM', 'ODFL', 'PWR',
    'XYL', 'TDG', 'PAYX', 'EFX', 'WAB', 'FTV', 'URI', 'EXPD', 'J', 'SNA',
    'AXON', 'IEX', 'BR', 'TXT', 'LDOS', 'JBHT', 'CHRW', 'DAL', 'UAL', 'LUV',
    'AAL', 'ALK', 'ROL', 'NDSN', 'RHI', 'PNR', 'MAS', 'AOS', 'ALLE',
    'HII', 'GNRC', 'PAYC', 'CSGP',
  ],

  // ============================================================================
  // CONSUMER STAPLES (~40 stocks)
  // ============================================================================
  'Consumer Staples': [
    'PG', 'KO', 'PEP', 'COST', 'WMT', 'PM', 'MO', 'MDLZ', 'CL', 'TGT',
    'ADM', 'STZ', 'SYY', 'GIS', 'KMB', 'HSY', 'KHC', 'KDP', 'KR', 'WBA',
    'EL', 'MNST', 'MKC', 'CHD', 'CLX', 'K', 'CAG', 'SJM', 'HRL', 'TSN',
    'BF-B', 'TAP', 'CPB', 'LW', 'BG', 'COTY',
  ],

  // ============================================================================
  // ENERGY (~25 stocks)
  // ============================================================================
  Energy: [
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY',
    'WMB', 'HAL', 'DVN', 'KMI', 'BKR', 'FANG', 'CTRA', 'OKE', 'TRGP',
    'APA', 'EQT',
  ],

  // ============================================================================
  // UTILITIES (~30 stocks)
  // ============================================================================
  Utilities: [
    'NEE', 'SO', 'DUK', 'SRE', 'AEP', 'D', 'EXC', 'XEL', 'ED', 'PCG',
    'WEC', 'PEG', 'AWK', 'ES', 'DTE', 'EIX', 'ETR', 'FE', 'AEE', 'PPL',
    'CMS', 'CNP', 'EVRG', 'ATO', 'NI', 'LNT', 'NRG', 'PNW',
  ],

  // ============================================================================
  // REAL ESTATE (~30 stocks)
  // ============================================================================
  'Real Estate': [
    'PLD', 'AMT', 'EQIX', 'CCI', 'PSA', 'O', 'WELL', 'DLR', 'SPG', 'VICI',
    'AVB', 'EQR', 'SBAC', 'WY', 'ARE', 'VTR', 'MAA', 'EXR', 'IRM', 'ESS',
    'INVH', 'UDR', 'KIM', 'REG', 'CPT', 'HST', 'BXP', 'DOC', 'FRT', 'AIV',
  ],

  // ============================================================================
  // MATERIALS (~30 stocks)
  // ============================================================================
  Materials: [
    'LIN', 'APD', 'SHW', 'ECL', 'FCX', 'NEM', 'NUE', 'DOW', 'DD', 'PPG',
    'CTVA', 'VMC', 'MLM', 'ALB', 'IFF', 'CF', 'MOS', 'LYB', 'CE', 'FMC',
    'PKG', 'IP', 'EMN', 'AVY', 'SEE', 'BALL', 'AMCR',
  ],
};

// ============================================================================
// HELPER EXPORTS
// ============================================================================

// Flatten all tickers into a single array
export const ALL_SP500_TICKERS: string[] = Object.values(SP500_STOCKS).flat();

// Get all sector names
export const SP500_SECTORS: string[] = Object.keys(SP500_STOCKS);

// Get tickers for a specific sector
export function getTickersBySector(sector: string): string[] {
  return SP500_STOCKS[sector] || [];
}

// Get sector for a ticker
export function getSectorForTicker(ticker: string): string | null {
  for (const [sector, tickers] of Object.entries(SP500_STOCKS)) {
    if (tickers.includes(ticker.toUpperCase())) {
      return sector;
    }
  }
  return null;
}

// Get count by sector
export function getCountBySector(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [sector, tickers] of Object.entries(SP500_STOCKS)) {
    counts[sector] = tickers.length;
  }
  return counts;
}

// Total count
export const SP500_TOTAL_COUNT = ALL_SP500_TICKERS.length;

// ============================================================================
// END OF S&P 500 STOCK UNIVERSE
// ============================================================================
