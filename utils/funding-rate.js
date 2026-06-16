// Funding rate monitoring utility
const axios = require('axios');
const warned451 = new Set(); // track per-symbol 451 warnings to avoid noise

// Rate limiting for Binance API
let lastBinanceCall = 0;
const binanceMinMs = Number(process.env.BINANCE_API_MIN_MS) || 2000;

async function respectBinanceRateLimit() {
  const elapsed = Date.now() - lastBinanceCall;
  const wait = binanceMinMs - elapsed;
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastBinanceCall = Date.now();
}

/**
 * Fetch funding rate for a perpetual futures market from Binance
 * @param {string} symbol - Market symbol (e.g., 'SOLUSDC' for Binance)
 * @param {number} timestamp - Optional timestamp to get historical funding rate
 * @returns {Promise<number>} Funding rate per 8h period (as decimal, e.g., 0.0002 = 0.02%)
 */
async function fetchFundingRate(symbol, timestamp = null) {
  try {
    // Binance funding rate endpoint: /fapi/v1/fundingRate
    // Returns funding rate per 8h period
    const symbolMap = {
      'SOL-PERP': 'SOLUSDT',
      'SOLUSDC': 'SOLUSDT',
      'ETH-PERP': 'ETHUSDT',
      'ETHUSDC': 'ETHUSDT',
      'BTC-PERP': 'BTCUSDT',
      'BTCUSDC': 'BTCUSDT',
    };
    
    const binanceSymbol = symbolMap[symbol] || symbol.replace('USDC', 'USDT');
    const url = 'https://fapi.binance.com/fapi/v1/fundingRate';
    
    const params = new URLSearchParams();
    params.set('symbol', binanceSymbol);
    params.set('limit', '1'); // Get most recent funding rate
    
    if (timestamp) {
      // For historical funding rates, we need to find the closest funding rate
      // Binance funding rates are every 8 hours at 00:00, 08:00, 16:00 UTC
      const fundingTimes = [];
      const periodStart = new Date(timestamp);
      periodStart.setUTCHours(Math.floor(periodStart.getUTCHours() / 8) * 8, 0, 0, 0);
      
      // Get funding rate for the period containing this timestamp
      const fundingTime = periodStart.getTime();
      params.set('startTime', String(fundingTime - 8 * 3600 * 1000)); // 8h before
      params.set('endTime', String(fundingTime + 8 * 3600 * 1000)); // 8h after
    }
    
    // Respect rate limit before calling Binance
    await respectBinanceRateLimit();
    
    const response = await axios.get(`${url}?${params.toString()}`, { timeout: 10000 });
    
    if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
      // No funding rate data available, return 0
      return 0;
    }
    
    // Get the most recent funding rate
    const fundingData = response.data[response.data.length - 1];
    const fundingRate = parseFloat(fundingData.fundingRate); // Already as decimal (e.g., 0.0001 = 0.01%)
    
    return fundingRate || 0;
  } catch (error) {
    // If fetching fails, return 0 (treat as neutral) and de-noise geo-restricted 451s
    const status = error?.response?.status;
    if (status === 451) {
      if (!warned451.has(symbol)) {
        warned451.add(symbol);
        console.warn(`Failed to fetch funding rate for ${symbol}: HTTP 451 (geo-restricted). Suppressing further warnings.`);
      }
      return 0;
    }
    console.warn(`Failed to fetch funding rate for ${symbol}: ${error.message}`);
    return 0;
  }
}

/**
 * Fetch historical funding rates for backtesting
 * @param {string} symbol - Market symbol (e.g., 'SOLUSDC')
 * @param {number} startTime - Start timestamp
 * @param {number} endTime - End timestamp
 * @returns {Promise<Map<number, number>>} Map of timestamp -> funding rate
 */
async function fetchHistoricalFundingRates(symbol, startTime, endTime) {
  try {
    const symbolMap = {
      'SOL-PERP': 'SOLUSDT',
      'SOLUSDC': 'SOLUSDT',
      'ETH-PERP': 'ETHUSDT',
      'ETHUSDC': 'ETHUSDT',
      'BTC-PERP': 'BTCUSDT',
      'BTCUSDC': 'BTCUSDT',
    };
    
    const binanceSymbol = symbolMap[symbol] || symbol.replace('USDC', 'USDT');
    const url = 'https://fapi.binance.com/fapi/v1/fundingRate';
    
    const params = new URLSearchParams();
    params.set('symbol', binanceSymbol);
    params.set('startTime', String(startTime));
    params.set('endTime', String(endTime));
    params.set('limit', '1000'); // Max per request
    
    const fundingRates = new Map();
    let currentStart = startTime;
    
    while (currentStart < endTime) {
      params.set('startTime', String(currentStart));
      
      const response = await axios.get(`${url}?${params.toString()}`, { timeout: 10000 });
      
      if (!response.data || !Array.isArray(response.data)) {
        break;
      }
      
      for (const item of response.data) {
        const timestamp = parseInt(item.fundingTime);
        const rate = parseFloat(item.fundingRate);
        fundingRates.set(timestamp, rate);
      }
      
      if (response.data.length < 1000) {
        break; // No more data
      }
      
      // Get next batch
      const lastTimestamp = response.data[response.data.length - 1].fundingTime;
      currentStart = parseInt(lastTimestamp) + 1;
      
      // Rate limit protection
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return fundingRates;
  } catch (error) {
    console.warn(`Failed to fetch historical funding rates for ${symbol}: ${error.message}`);
    return new Map(); // Return empty map on error
  }
}

/**
 * Monitor funding rates for positions
 */
class FundingRateMonitor {
  constructor(options = {}) {
    this.cache = new Map(); // symbol -> { rate, timestamp }
    this.cacheTTL = options.cacheTTL || 60 * 1000; // 1 minute
    this.apiUrl = options.apiUrl || 'https://api.jup.ag/price/v1';
  }

  /**
   * Get current funding rate for a symbol
   */
  async getFundingRate(symbol) {
    const cached = this.cache.get(symbol);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < this.cacheTTL) {
      return cached.rate;
    }

    try {
      const rate = await fetchFundingRate(symbol, this.apiUrl);
      this.cache.set(symbol, { rate, timestamp: now });
      return rate;
    } catch (error) {
      // Return cached value if available, even if expired
      if (cached) {
        return cached.rate;
      }
      throw error;
    }
  }

  /**
   * Check if funding rate is acceptable for a position
   */
  async checkFundingRate(position, maxFundingRatePercent) {
    try {
      const symbol = position.market || 'SOL-PERP';
      const rate = await this.getFundingRate(symbol);
      const ratePercent = rate * 100;

      // Check if funding is unfavorable
      let unfavorable = false;
      if (position.side === 'long' && rate > maxFundingRatePercent / 100) {
        unfavorable = true;
      } else if (position.side === 'short' && rate < -maxFundingRatePercent / 100) {
        unfavorable = true;
      }

      return {
        rate,
        ratePercent,
        unfavorable,
        shouldExit: unfavorable,
      };
    } catch (error) {
      // Return neutral result on error to avoid false positives
      return {
        rate: 0,
        ratePercent: 0,
        unfavorable: false,
        shouldExit: false,
        error: error.message,
      };
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }
}

/**
 * Get funding rate for backtest (historical or simulated)
 * @param {Object} fundingCfg - Funding configuration from backtest
 * @param {number} ts - Current timestamp
 * @param {string} market - Market symbol (optional, for future use)
 * @param {Map<number, number>} historicalRates - Optional map of timestamp -> funding rate from historical data
 * @returns {number} Funding rate per 8h period (as decimal, e.g., 0.0002 = 0.02%)
 */
function getBacktestFundingRate(fundingCfg, ts, market = null, historicalRates = null) {
  if (!fundingCfg) return 0;
  
  // First, try to use historical funding rates if available
  if (historicalRates && historicalRates.size > 0) {
    // Find the closest funding rate timestamp (funding rates are every 8h)
    const fundingPeriodMs = 8 * 3600 * 1000; // 8 hours
    const alignedTs = Math.floor(ts / fundingPeriodMs) * fundingPeriodMs;
    
    // Look for funding rate at or before this timestamp
    let closestRate = null;
    let closestTs = null;
    
    for (const [fundingTs, rate] of historicalRates.entries()) {
      if (fundingTs <= alignedTs && (!closestTs || fundingTs > closestTs)) {
        closestTs = fundingTs;
        closestRate = rate;
      }
    }
    
    if (closestRate !== null) {
      return closestRate;
    }
  }
  
  // Fall back to simulated funding rate
  // Use ratePerCadence if available (funding rate per 8h period)
  let ratePer8h = fundingCfg.ratePerCadence || 0;
  
  // If ratePerCadence is 0 and we have wobble configured, simulate realistic funding
  // Typical funding rates range from -0.1% to +0.1% per 8h, with most around 0.01-0.03%
  if (ratePer8h === 0 && fundingCfg.wobbleStdBps && fundingCfg.wobbleStdBps > 0) {
    try {
      // Try to get gaussian from backtest utils (for backtest context)
      const { gaussian } = require('../backtest/utils/math-utils');
      if (gaussian) {
        // Use wobble to simulate funding rate around mean
        // Default mean: 0.01% (0.0001) per 8h if not specified
        const meanBps = fundingCfg.wobbleMeanBps !== undefined ? fundingCfg.wobbleMeanBps : 1.0; // 1 bps = 0.01%
        const wobble = gaussian(meanBps, fundingCfg.wobbleStdBps || 0.75);
        ratePer8h = wobble / 10000; // Convert bps to decimal
      }
    } catch (e) {
      // If backtest utils not available, skip wobble (for live trading context)
    }
  }
  
  return ratePer8h;
}

/**
 * Check if funding rate is acceptable for opening a new position (backtest)
 * @param {string} side - Position side ('long' or 'short')
 * @param {Object} fundingCfg - Funding configuration
 * @param {number} ts - Current timestamp
 * @param {number} maxFundingRatePercent - Maximum funding rate threshold (per 8h, e.g., 0.02 = 0.02%)
 * @param {string} market - Market symbol (optional)
 * @param {Map<number, number>} historicalRates - Optional historical funding rates map
 * @returns {Object} Check result with rate, ratePercent, adverse, and shouldBlock
 */
function checkFundingForEntry(side, fundingCfg, ts, maxFundingRatePercent, market = null, historicalRates = null) {
  if (!maxFundingRatePercent || maxFundingRatePercent <= 0) {
    // No threshold set, allow entry
    return {
      rate: 0,
      ratePercent: 0,
      adverse: false,
      shouldBlock: false,
    };
  }
  
  const rate = getBacktestFundingRate(fundingCfg, ts, market, historicalRates);
  const ratePercent = rate * 100; // Convert to percentage
  
  // Check if funding is adverse for the position side
  // For longs: adverse if funding > maxFundingRatePercent (paying too much)
  // For shorts: adverse if funding < -maxFundingRatePercent (paying too much, negative funding means shorts pay)
  let adverse = false;
  const sideLower = side?.toLowerCase();
  
  if (sideLower === 'long' && rate > maxFundingRatePercent / 100) {
    adverse = true;
  } else if (sideLower === 'short' && rate < -maxFundingRatePercent / 100) {
    adverse = true;
  }
  
  return {
    rate,
    ratePercent,
    adverse,
    shouldBlock: adverse,
  };
}

module.exports = {
  fetchFundingRate,
  fetchHistoricalFundingRates,
  FundingRateMonitor,
  getBacktestFundingRate,
  checkFundingForEntry,
};

