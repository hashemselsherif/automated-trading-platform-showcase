// utils/market-data.js
//
// Lightweight market data helper focused on supplying recent traded
// volume so that strategies relying on volume signals can operate with
// real inputs (instead of defaulting to zero).
//
// Implementation notes:
//   - PRIMARY: Coinbase WebSocket (candles + market_trades channels)
//     - No geo-restrictions, no rate limits (WebSocket)
//     - Real-time 5-minute candles with volume
//     - Buy/sell volume tracking for CVD calculation
//   - FALLBACK: Binance REST API (klines)
//     - Used when Coinbase is unavailable or data is stale
//     - Subject to geo-restrictions and rate limits
//   - Results are cached briefly to respect rate limits while still
//     keeping the data fresh enough for a ~5s bot loop.
//   - Consumers can override the upstream symbol with environment
//     variables: `VOLUME_SYMBOL_<BASE>` (e.g. VOLUME_SYMBOL_SOL=SOLUSDC).

const axios = require('axios');
const { getInstance: getCoinbaseWS, SYMBOL_TO_PRODUCT } = require('./coinbase-volume-ws');

const DEFAULT_CACHE_TTL_MS = Number(process.env.VOLUME_CACHE_TTL_MS || 15_000);
const DEFAULT_INTERVAL = process.env.VOLUME_INTERVAL || '1m';

function resolveSymbol(baseSymbol) {
  if (!baseSymbol) return null;
  const upper = baseSymbol.toUpperCase();
  const envKey = `VOLUME_SYMBOL_${upper}`;
  if (process.env[envKey]) return process.env[envKey].toUpperCase();

  const defaultQuote = process.env.VOLUME_DEFAULT_QUOTE || 'USDC';
  return `${upper}${defaultQuote.toUpperCase()}`;
}

async function fetchBinanceKline(symbol, interval = DEFAULT_INTERVAL) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1`;
  const { data } = await axios.get(url, { timeout: 5_000 });

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No kline data returned for ${symbol}`);
  }

  const [
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime,
    quoteVolume,
    tradeCount,
    takerBase,
    takerQuote,
  ] = data[0];

  return {
    openTime: Number(openTime),
    closeTime: Number(closeTime),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    baseVolume: Number(volume),
    quoteVolume: Number(quoteVolume),
    tradeCount: Number(tradeCount),
    takerBaseVolume: Number(takerBase),
    takerQuoteVolume: Number(takerQuote),
    source: 'binance',
    interval,
    symbol,
  };
}

class MarketDataProvider {
  constructor() {
    this.cache = new Map();
    this.cacheTtlMs = DEFAULT_CACHE_TTL_MS;
    this.lastBinanceCall = 0;
    this.binanceMinMs = Number(process.env.BINANCE_API_MIN_MS) || 2000; // Rate limit Binance calls
    
    // Coinbase WebSocket client (primary volume source)
    this.coinbaseWS = null;
    this.coinbaseInitialized = false;
    this.coinbaseInitPromise = null;
    
    // Volume source preference
    // Options: 'coinbase' (primary), 'binance' (fallback), 'auto' (Coinbase first, Binance fallback)
    this.volumeSource = (process.env.VOLUME_SOURCE || 'auto').toLowerCase();
    
    // Stats for monitoring
    this.volumeStats = {
      coinbaseHits: 0,
      coinbaseMisses: 0,
      binanceHits: 0,
      binanceErrors: 0,
      fallbackCount: 0,
    };
    
    // Open Interest & Funding Rate tracking (Jupiter Perps API)
    this.oiCache = new Map(); // market -> { oi, timestamp }
    this.oiCacheTtlMs = Number(process.env.OI_CACHE_TTL_MS || 60_000); // 60s cache for OI
    this.fundingCache = new Map(); // market -> { fundingRate, timestamp }
    this.fundingCacheTtlMs = Number(process.env.FUNDING_CACHE_TTL_MS || 300_000); // 5min cache for funding
    this.lastJupiterCall = 0;
    this.jupiterMinMs = Number(process.env.JUP_API_MIN_MS) || 2000; // Rate limit Jupiter calls
    this.jupiterApiUrl = process.env.JUPITER_PERPS_API_URL || 'https://perp-api.jup.ag';
    
    // OI spike detection
    this.oiHistory = new Map(); // market -> Array of {oi, timestamp}
    this.maxOIHistoryLength = 20; // Keep last 20 OI readings
  }
  
  /**
   * Initialize Coinbase WebSocket connection (call once at startup)
   * @returns {Promise<boolean>} True if connected successfully
   */
  async initializeCoinbaseWS() {
    if (this.coinbaseInitialized) {
      return true;
    }
    
    // Prevent multiple initialization attempts
    if (this.coinbaseInitPromise) {
      return this.coinbaseInitPromise;
    }
    
    this.coinbaseInitPromise = (async () => {
      try {
        console.log('[MarketData] Initializing Coinbase WebSocket for volume data...');
        this.coinbaseWS = getCoinbaseWS();
        await this.coinbaseWS.connect();
        this.coinbaseInitialized = true;
        console.log('[MarketData] ✅ Coinbase WebSocket connected (primary volume source)');
        return true;
      } catch (error) {
        console.warn(`[MarketData] ⚠️ Coinbase WebSocket failed: ${error.message}`);
        console.warn('[MarketData] Will use Binance REST API as fallback');
        this.coinbaseInitialized = false;
        return false;
      }
    })();
    
    return this.coinbaseInitPromise;
  }
  
  /**
   * Get volume from Coinbase WebSocket (if available)
   * @param {string} baseSymbol - Symbol (SOL, BTC, ETH)
   * @returns {Object|null} Volume data or null if not available
   */
  _getCoinbaseVolume(baseSymbol) {
    if (!this.coinbaseWS || !this.coinbaseWS.isHealthy()) {
      return null;
    }
    
    const volumeData = this.coinbaseWS.getVolume(baseSymbol);
    if (!volumeData || volumeData.isStale) {
      return null;
    }
    
    return volumeData;
  }

  setCacheTtl(ms) {
    if (Number.isFinite(ms) && ms > 0) this.cacheTtlMs = ms;
  }
  
  async _respectBinanceRateLimit() {
    const elapsed = Date.now() - this.lastBinanceCall;
    const wait = this.binanceMinMs - elapsed;
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }
    this.lastBinanceCall = Date.now();
  }

  async getLatestVolume(baseSymbol, priceHint, options = {}) {
    const upstreamSymbol = resolveSymbol(baseSymbol);
    if (!upstreamSymbol) {
      return null;
    }

    const interval = String(options.interval || DEFAULT_INTERVAL).trim().toLowerCase();
    const cacheKey = `${upstreamSymbol}:${interval}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    // Try Coinbase WebSocket first (primary source - no rate limits, no geo-restrictions)
    if (this.volumeSource !== 'binance') {
      const coinbaseData = this._getCoinbaseVolume(baseSymbol);
      if (coinbaseData) {
        this.volumeStats.coinbaseHits++;
        
        const result = {
          openTime: coinbaseData.windowStart,
          closeTime: now,
          open: coinbaseData.open,
          high: coinbaseData.high,
          low: coinbaseData.low,
          close: coinbaseData.close,
          baseVolume: coinbaseData.baseVolume,
          quoteVolume: coinbaseData.quoteVolume,
          takerBaseVolume: coinbaseData.takerBuyBaseVolume, // For CVD calculation
          takerQuoteVolume: coinbaseData.takerBuyBaseVolume * (coinbaseData.close || priceHint || 0),
          source: 'coinbase',
          interval: interval || '5m',
          symbol: SYMBOL_TO_PRODUCT[baseSymbol.toUpperCase()],
          meta: {
            source: 'coinbase_live',
            fetchedAt: now,
            upstreamSymbol,
            primarySource: 'coinbase',
          },
        };
        
        // Cache for consistency
        this.cache.set(cacheKey, { timestamp: now, data: result });
        return result;
      } else {
        this.volumeStats.coinbaseMisses++;
      }
    }

    // Cache is primarily for Binance (rate limit / bans) and "Coinbase-only" fallback.
    if (cached && now - cached.timestamp < this.cacheTtlMs) {
      return {
        ...cached.data,
        meta: {
          ...(cached.data.meta || {}),
          source: 'cache_fresh',
          cachedAt: cached.timestamp,
          upstreamSymbol,
        },
      };
    }

    // Fallback to Binance REST API
    if (this.volumeSource === 'coinbase') {
      // If Coinbase-only mode and Coinbase failed, return cached or null
      if (cached) {
        return {
          ...cached.data,
          meta: {
            ...(cached.data.meta || {}),
            source: 'cache_stale',
            cachedAt: cached.timestamp,
            upstreamSymbol,
            error: 'Coinbase unavailable',
          },
        };
      }
      return null;
    }

    // Use Binance as fallback
    try {
      this.volumeStats.fallbackCount++;
      
      // Respect rate limit before calling Binance
      await this._respectBinanceRateLimit();
      
      const kline = await fetchBinanceKline(upstreamSymbol, interval || DEFAULT_INTERVAL);
      this.volumeStats.binanceHits++;
      
      const result = {
        ...kline,
        meta: {
          source: 'binance_fallback',
          fetchedAt: now,
          upstreamSymbol,
          primarySource: 'binance',
          fallbackReason: this.coinbaseInitialized ? 'coinbase_stale' : 'coinbase_not_initialized',
        },
      };

      if (!Number.isFinite(result.quoteVolume) && Number.isFinite(result.baseVolume) && Number.isFinite(priceHint)) {
        result.quoteVolume = result.baseVolume * priceHint;
      }

      this.cache.set(cacheKey, { timestamp: now, data: result });
      return result;
    } catch (error) {
      this.volumeStats.binanceErrors++;
      
      if (cached) {
        return {
          ...cached.data,
          meta: {
            ...(cached.data.meta || {}),
            source: 'cache_stale',
            cachedAt: cached.timestamp,
            upstreamSymbol,
            error: error.message,
          },
        };
      }

      throw error;
    }
  }
  
  /**
   * Respect Jupiter API rate limit
   */
  async _respectJupiterRateLimit() {
    const elapsed = Date.now() - this.lastJupiterCall;
    const wait = this.jupiterMinMs - elapsed;
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }
    this.lastJupiterCall = Date.now();
  }
  
  /**
   * Get Open Interest for a market (with caching)
   * @param {string} market - Market symbol (e.g., 'SOL-PERP')
   * @returns {Promise<{oi: number, timestamp: number, source: string}>}
   */
  async getOpenInterest(market) {
    if (!market) return null;
    
    const cacheKey = market;
    const cached = this.oiCache.get(cacheKey);
    const now = Date.now();
    
    // Return fresh cache
    if (cached && now - cached.timestamp < this.oiCacheTtlMs) {
      return {
        oi: cached.oi,
        timestamp: cached.timestamp,
        source: 'cache_fresh',
        age: now - cached.timestamp,
      };
    }
    
    try {
      // Respect rate limit before calling Jupiter
      await this._respectJupiterRateLimit();
      
      // Fetch from Jupiter Perps API
      // Note: This is a placeholder - actual endpoint may vary
      // Jupiter Perps API structure needs to be verified
      const symbol = market.split('-')[0]; // SOL-PERP -> SOL
      const url = `${this.jupiterApiUrl}/stats?market=${symbol}`;
      
      const { data } = await axios.get(url, { timeout: 5_000 });
      
      // Extract OI from response (structure may vary)
      const oi = data?.openInterest || data?.oi || null;
      
      if (!Number.isFinite(oi)) {
        throw new Error(`Invalid OI data for ${market}`);
      }
      
      const result = {
        oi,
        timestamp: now,
        source: 'live',
        age: 0,
      };
      
      // Cache result
      this.oiCache.set(cacheKey, { oi, timestamp: now });
      
      // Track OI history for spike detection
      this._trackOIHistory(market, oi, now);
      
      return result;
    } catch (error) {
      // Return stale cache if available
      if (cached) {
        return {
          oi: cached.oi,
          timestamp: cached.timestamp,
          source: 'cache_stale',
          age: now - cached.timestamp,
          error: error.message,
        };
      }
      
      throw error;
    }
  }
  
  /**
   * Track OI history for spike detection
   */
  _trackOIHistory(market, oi, timestamp) {
    if (!this.oiHistory.has(market)) {
      this.oiHistory.set(market, []);
    }
    
    const history = this.oiHistory.get(market);
    history.push({ oi, timestamp });
    
    // Keep only recent history
    if (history.length > this.maxOIHistoryLength) {
      history.shift();
    }
  }
  
  /**
   * Detect OI spike (significant increase in short time)
   * @param {string} market - Market symbol
   * @param {number} thresholdPct - Spike threshold as % (e.g., 0.05 = 5%)
   * @param {number} lookbackMs - Time window to check (default: 5 minutes)
   * @returns {{spiked: boolean, change: number, changePct: number}}
   */
  detectOISpike(market, thresholdPct = 0.05, lookbackMs = 300_000) {
    const history = this.oiHistory.get(market);
    if (!history || history.length < 2) {
      return { spiked: false, change: 0, changePct: 0, reason: 'insufficient_data' };
    }
    
    const now = Date.now();
    const latest = history[history.length - 1];
    
    // Find earliest reading within lookback window
    let earliest = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const reading = history[i];
      const age = now - reading.timestamp;
      
      if (age <= lookbackMs) {
        earliest = reading;
      } else {
        break;
      }
    }
    
    if (!earliest || earliest === latest) {
      return { spiked: false, change: 0, changePct: 0, reason: 'no_baseline' };
    }
    
    // Calculate change
    const change = latest.oi - earliest.oi;
    const changePct = change / earliest.oi;
    
    const spiked = Math.abs(changePct) >= thresholdPct;
    
    return {
      spiked,
      change,
      changePct,
      from: earliest.oi,
      to: latest.oi,
      timespan: latest.timestamp - earliest.timestamp,
    };
  }
  
  /**
   * Get Funding Rate for a market (with caching)
   * @param {string} market - Market symbol (e.g., 'SOL-PERP')
   * @returns {Promise<{fundingRate: number, timestamp: number, source: string}>}
   */
  async getFundingRate(market) {
    if (!market) return null;
    
    const cacheKey = market;
    const cached = this.fundingCache.get(cacheKey);
    const now = Date.now();
    
    // Return fresh cache
    if (cached && now - cached.timestamp < this.fundingCacheTtlMs) {
      return {
        fundingRate: cached.fundingRate,
        timestamp: cached.timestamp,
        source: 'cache_fresh',
        age: now - cached.timestamp,
      };
    }
    
    try {
      // Respect rate limit before calling Jupiter
      await this._respectJupiterRateLimit();
      
      // Fetch from Jupiter Perps API
      const symbol = market.split('-')[0]; // SOL-PERP -> SOL
      const url = `${this.jupiterApiUrl}/funding?market=${symbol}`;
      
      const { data } = await axios.get(url, { timeout: 5_000 });
      
      // Extract funding rate from response (structure may vary)
      const fundingRate = data?.fundingRate || data?.rate || null;
      
      if (!Number.isFinite(fundingRate)) {
        throw new Error(`Invalid funding rate data for ${market}`);
      }
      
      const result = {
        fundingRate,
        timestamp: now,
        source: 'live',
        age: 0,
      };
      
      // Cache result
      this.fundingCache.set(cacheKey, { fundingRate, timestamp: now });
      
      return result;
    } catch (error) {
      // Return stale cache if available
      if (cached) {
        return {
          fundingRate: cached.fundingRate,
          timestamp: cached.timestamp,
          source: 'cache_stale',
          age: now - cached.timestamp,
          error: error.message,
        };
      }
      
      throw error;
    }
  }
  
  /**
   * Get all market data at once (for efficiency)
   * @param {string} market - Market symbol
   * @param {number} priceHint - Current price (for volume calculation)
   * @returns {Promise<{volume: Object, oi: Object, funding: Object}>}
   */
  async getAllMarketData(market, priceHint) {
    const baseSymbol = market.split('-')[0]; // SOL-PERP -> SOL
    
    // Fetch all data in parallel
    const [volume, oi, funding] = await Promise.allSettled([
      this.getLatestVolume(baseSymbol, priceHint),
      this.getOpenInterest(market),
      this.getFundingRate(market),
    ]);
    
    return {
      volume: volume.status === 'fulfilled' ? volume.value : null,
      oi: oi.status === 'fulfilled' ? oi.value : null,
      funding: funding.status === 'fulfilled' ? funding.value : null,
    };
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      volumeCacheSize: this.cache.size,
      oiCacheSize: this.oiCache.size,
      fundingCacheSize: this.fundingCache.size,
      oiHistoryMarkets: this.oiHistory.size,
      volumeSource: this.volumeSource,
      coinbase: {
        initialized: this.coinbaseInitialized,
        healthy: this.coinbaseWS?.isHealthy() || false,
        stats: this.coinbaseWS?.getStats() || null,
      },
      volumeStats: this.volumeStats,
    };
  }
  
  /**
   * Disconnect from all WebSocket connections
   */
  disconnect() {
    if (this.coinbaseWS) {
      this.coinbaseWS.disconnect();
      this.coinbaseWS = null;
      this.coinbaseInitialized = false;
    }
  }
}

module.exports = new MarketDataProvider();

