// utils/improved-multi-price-feed.js
//
// IMPROVED Multi-source price feed with better backups for Render environment
//
// Key improvements:
// 1. Jupiter Swap API (primary) - optimized with longer timeout
// 2. Coinbase API (fallback 1) - no geo-blocking, reliable
// 3. Pyth Network (fallback 2) - on-chain oracle, always accessible
// 4. CoinGecko with API key option (fallback 3) - higher rate limits
//
// Binance removed - geo-blocked on Render (HTTP 451)

const axios = require('axios');
const fs = require('fs');
const path = require('path');

let _dailyPythFeedCache = null;
let _dailyPythFeedCacheDay = null;

function _utcDayString(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _readDailyPythFeedId(symbol) {
  if ((process.env.PYTH_FEED_IDS_MODE || '').toLowerCase() !== 'daily') return null;

  const day = _utcDayString();
  if (_dailyPythFeedCacheDay !== day) {
    _dailyPythFeedCacheDay = day;
    _dailyPythFeedCache = null;
    try {
      const cachePath = path.join(process.cwd(), 'results', 'json', `pyth-feed-ids-${day}.json`);
      if (fs.existsSync(cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        _dailyPythFeedCache = parsed?.feedIds && typeof parsed.feedIds === 'object' ? parsed.feedIds : null;
      }
    } catch {
      _dailyPythFeedCache = null;
    }
  }

  if (!_dailyPythFeedCache) return null;
  const key = String(symbol || '').toUpperCase();
  const id = _dailyPythFeedCache[key] || _dailyPythFeedCache[key.replace(/-PERP$/, '')] || null;
  return typeof id === 'string' && id.length >= 64 ? id : null;
}

// Environment configuration
const BOT_LOOP_MS = Number(process.env.BOT_LOOP_MS || 15_000);
const PRICE_STALE_ALERT_SLACK_MS = Number(process.env.PRICE_STALE_ALERT_SLACK_MS || 500);
const PRICE_STALE_ALERT_COOLDOWN_MS = Number(process.env.PRICE_STALE_ALERT_COOLDOWN_MS || 0);

// Calculate optimal cache TTL: slightly less than loop duration to guarantee fresh fetches
const loopDurationMs = Number.isFinite(BOT_LOOP_MS) && BOT_LOOP_MS > 0 ? BOT_LOOP_MS : 15_000;
const DEFAULT_PRICE_CACHE_TTL_MS = Math.max(100, loopDurationMs - 500); // 500ms buffer for timing jitter

const rawPriceCacheTtl = Number(
  process.env.PRICE_CACHE_TTL_MS === undefined
    ? DEFAULT_PRICE_CACHE_TTL_MS
    : process.env.PRICE_CACHE_TTL_MS
);

const cacheUpperBound = Math.max(100, loopDurationMs - 500); // keep cache below loop duration
let PRICE_CACHE_TTL_MS = Number.isFinite(rawPriceCacheTtl) && rawPriceCacheTtl > 0
  ? rawPriceCacheTtl
  : DEFAULT_PRICE_CACHE_TTL_MS;

// Force cache TTL below loop duration to ensure fresh fetches every loop
if (PRICE_CACHE_TTL_MS >= loopDurationMs || PRICE_CACHE_TTL_MS > cacheUpperBound) {
  let forcedTtlCandidate;
  if (loopDurationMs > 200) {
    forcedTtlCandidate = loopDurationMs - 500; // 500ms buffer
  } else {
    forcedTtlCandidate = Math.max(10, Math.floor(loopDurationMs * 0.6));
  }
  let forcedTtl = Math.max(50, Math.min(cacheUpperBound, forcedTtlCandidate));
  if (forcedTtl >= loopDurationMs) {
    forcedTtl = Math.max(10, loopDurationMs - 10);
  }
  console.warn(
    `[PRICE_FEED] PRICE_CACHE_TTL_MS (${PRICE_CACHE_TTL_MS}ms) ` +
    `is too high relative to BOT_LOOP_MS (${loopDurationMs}ms). ` +
    `Forcing cache TTL to ${forcedTtl}ms to ensure fresh price fetch each loop.`
  );
  PRICE_CACHE_TTL_MS = forcedTtl;
}

console.log(
  `[PRICE_FEED] Cache TTL: ${PRICE_CACHE_TTL_MS}ms (${(PRICE_CACHE_TTL_MS/1000).toFixed(1)}s), ` +
  `Loop: ${loopDurationMs}ms (${(loopDurationMs/1000).toFixed(1)}s) ` +
  `→ Fresh fetch every loop: ${PRICE_CACHE_TTL_MS < loopDurationMs ? 'YES ✅' : 'NO ⚠️'}`
);
const PRICE_FETCH_TIMEOUT_MS = Number(process.env.PRICE_FETCH_TIMEOUT_MS || 10_000); // Increased from 8s
const ENABLE_JUPITER_PRICE = process.env.ENABLE_JUPITER_PRICE !== 'false';
const ENABLE_COINBASE_PRICE = process.env.ENABLE_COINBASE_PRICE !== 'false';
const ENABLE_PYTH_PRICE = process.env.ENABLE_PYTH_PRICE !== 'false';
const ENABLE_COINGECKO_PRICE = process.env.ENABLE_COINGECKO_PRICE !== 'false';

// Optional API keys for higher rate limits
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || null;
const JUP_PRICE_API_URL = process.env.JUP_PRICE_API_URL || 'https://lite-api.jup.ag/price/v3';
const JUP_API_KEY = process.env.JUP_API_KEY || null;

// Try to load drift-market-lookup for dynamic symbol expansion
let driftLookup = null;
try {
  driftLookup = require('./drift-market-lookup');
} catch (e) {
  // Expected on older setups without registry
}

// Base symbol mappings for majors (always available)
const SYMBOL_MAPS = {
  jupiter: {
    // Jupiter v3 requires token mint addresses
    'SOL': 'So11111111111111111111111111111111111111112',
    'BTC': '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    'WBTC': '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    'ETH': '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  },
  coinbase: {
    'SOL': 'SOL-USD',
    'BTC': 'BTC-USD',
    'WBTC': 'BTC-USD', // Use BTC as proxy for WBTC
    'ETH': 'ETH-USD',
  },
  pyth: {
    // Pyth price feed IDs (mainnet)
    'SOL': '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    'BTC': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    'WBTC': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', // Same as BTC
    'ETH': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  },
  coingecko: {
    'SOL': 'solana',
    'BTC': 'bitcoin',
    'WBTC': 'wrapped-bitcoin',
    'ETH': 'ethereum',
  },
};

// Dynamically expand SYMBOL_MAPS from drift-market-registry (for alts)
if (driftLookup) {
  try {
    const registry = driftLookup.loadRegistry();
    for (const [symbol, info] of Object.entries(registry.markets)) {
      const baseSymbol = info.baseSymbol || symbol.replace('-PERP', '');
      
      // Add Pyth feed IDs for all tradeable markets
      if (info.pythFeedId && info.tradeable && !SYMBOL_MAPS.pyth[baseSymbol]) {
        const feedId = info.pythFeedId.startsWith('0x') 
          ? info.pythFeedId 
          : `0x${info.pythFeedId}`;
        SYMBOL_MAPS.pyth[baseSymbol] = feedId;
      }
      
      // Add CoinGecko IDs
      if (info.coingeckoId && !SYMBOL_MAPS.coingecko[baseSymbol]) {
        SYMBOL_MAPS.coingecko[baseSymbol] = info.coingeckoId;
      }
      
      // Add Coinbase pairs for symbols that have standard USD pairs
      if (!SYMBOL_MAPS.coinbase[baseSymbol] && baseSymbol.match(/^[A-Z]{2,10}$/)) {
        SYMBOL_MAPS.coinbase[baseSymbol] = `${baseSymbol}-USD`;
      }
    }
  } catch (e) {
    console.warn('[MultiFeed] Failed to expand SYMBOL_MAPS from registry:', e.message);
  }
}

// Reverse mapping: mint address -> symbol (for Jupiter v3 responses)
const MINT_TO_SYMBOL = {};
for (const [symbol, mint] of Object.entries(SYMBOL_MAPS.jupiter)) {
  if (!MINT_TO_SYMBOL[mint]) {
    MINT_TO_SYMBOL[mint] = [];
  }
  MINT_TO_SYMBOL[mint].push(symbol);
}

// Price validation ranges (majors only; alts use dynamic bounds)
// Alts without explicit ranges will use a permissive fallback
const PRICE_RANGES = {
  'SOL': { min: 5, max: 2000 },
  'BTC': { min: 10000, max: 500000 },
  'WBTC': { min: 10000, max: 500000 },
  'ETH': { min: 200, max: 30000 },
};

/**
 * Get price range for a symbol (dynamic for alts)
 */
function getPriceRange(symbol) {
  if (PRICE_RANGES[symbol]) {
    return PRICE_RANGES[symbol];
  }
  // Default permissive range for alts: $0.00001 to $100,000
  return { min: 0.00001, max: 100000 };
}

/**
 * Health status for each price source
 */
class SourceHealth {
  constructor(name, telegram = null) {
    this.name = name;
    this.enabled = true;
    this.successCount = 0;
    this.failureCount = 0;
    this.consecutiveFailures = 0;
    this.lastSuccess = null;
    this.lastFailure = null;
    this.lastError = null;
    this.lastLatency = null;
    this.circuitBreakerTripped = false;
    this.circuitBreakerUntil = 0;
    this.totalRequests = 0;
    this.telegram = telegram; // Optional Telegram instance for alerts
  }

  recordSuccess(latencyMs) {
    this.successCount++;
    this.totalRequests++;
    this.consecutiveFailures = 0;
    this.lastSuccess = Date.now();
    this.lastLatency = latencyMs;
    
    // Reset backoff multiplier on success
    if (this.feed && this.feed.backoffMultiplier > 1) {
      this.feed.backoffMultiplier = Math.max(1, this.feed.backoffMultiplier * 0.5); // Gradually reduce backoff
      if (this.feed.backoffMultiplier === 1) {
        console.log(`✅ ${this.name} backoff reset to normal`);
      }
    }
    
    if (this.circuitBreakerTripped) {
      console.log(`✅ ${this.name} circuit breaker reset`);
      this.circuitBreakerTripped = false;
      this.circuitBreakerUntil = 0;
      
      // Alert recovery
      if (this.telegram && this.telegram.alertCircuitBreakerRecovery) {
        this.telegram.alertCircuitBreakerRecovery(this.name).catch(() => {});
      }
    }
  }

  recordFailure(error) {
    this.failureCount++;
    this.totalRequests++;
    this.consecutiveFailures++;
    this.lastFailure = Date.now();
    this.lastError = error.message || String(error);
    
    // If it's a 429, trip circuit breaker immediately and increase backoff
    if (error.response?.status === 429 && !this.circuitBreakerTripped) {
      // Increase backoff multiplier (up to 4x)
      if (this.feed) {
        this.feed.backoffMultiplier = Math.min(4, this.feed.backoffMultiplier * 2);
        console.warn(`⚠️  ${this.name} rate limited! Increasing backoff to ${this.feed.backoffMultiplier}x (${(this.feed.jupApiMinMs * this.feed.backoffMultiplier / 1000).toFixed(1)}s between calls)`);
      }
      
      this.circuitBreakerTripped = true;
      this.circuitBreakerUntil = Date.now() + 120 * 1000; // 2 minutes
      console.warn(`⚠️  ${this.name} circuit breaker tripped due to 429 (rate limit). Cooling down for 2 minutes.`);
      if (this.telegram) {
        this.telegram.alert429(this.name, 'rate_limit', {
          action: 'Circuit breaker activated',
          cooldown: '2 minutes',
          backoff: this.feed ? `${this.feed.backoffMultiplier}x` : 'N/A'
        }).catch(() => {});
      }
      return;
    }
    
    // Trip after 20 consecutive failures (non-429 errors)
    if (this.consecutiveFailures >= 20 && !this.circuitBreakerTripped) {
      this.circuitBreakerTripped = true;
      this.circuitBreakerUntil = Date.now() + 90 * 1000;
      console.warn(`🔴 ${this.name} circuit breaker tripped (${this.consecutiveFailures} failures, recovery in 90s)`);
      
      // Alert circuit breaker trip
      if (this.telegram && this.telegram.alertCircuitBreaker) {
        this.telegram.alertCircuitBreaker(this.name, this.consecutiveFailures, 90).catch(() => {});
      }
    }
  }

  isAvailable() {
    if (!this.enabled) return false;
    if (this.circuitBreakerTripped && Date.now() < this.circuitBreakerUntil) {
      return false;
    }
    if (this.circuitBreakerTripped && Date.now() >= this.circuitBreakerUntil) {
      console.log(`🟡 ${this.name} attempting recovery`);
    }
    return true;
  }

  getStatus() {
    return {
      name: this.name,
      enabled: this.enabled,
      available: this.isAvailable(),
      successRate: this.totalRequests > 0 ? (this.successCount / this.totalRequests * 100).toFixed(2) + '%' : 'N/A',
      consecutiveFailures: this.consecutiveFailures,
      lastSuccess: this.lastSuccess ? new Date(this.lastSuccess).toISOString() : 'Never',
      lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : 'Never',
      lastError: this.lastError || 'None',
      lastLatency: this.lastLatency ? `${this.lastLatency}ms` : 'N/A',
      circuitBreaker: this.circuitBreakerTripped ? 'TRIPPED' : 'OK',
    };
  }
}

/**
 * Improved multi-source price feed manager
 */
class ImprovedMultiPriceFeed {
  constructor(jupiterClient, telegram = null) {
    this.jupiterClient = jupiterClient;
    this.telegram = telegram; // Optional Telegram instance for alerts
    
    // HTTP client with longer timeout for reliability
    this.http = axios.create({
      timeout: PRICE_FETCH_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Jupiter-Perps-Bot/2.0',
      },
    });
    
    this.cache = new Map();
    this.cacheTtlMs = PRICE_CACHE_TTL_MS;
    this.loopDurationMs = loopDurationMs;
    this.staleAlertSlackMs = PRICE_STALE_ALERT_SLACK_MS;
    const loopThreshold = Number.isFinite(this.loopDurationMs) && this.loopDurationMs > 0
      ? this.loopDurationMs - this.staleAlertSlackMs
      : null;
    const cacheThreshold = Number.isFinite(this.cacheTtlMs)
      ? this.cacheTtlMs - Math.max(50, this.staleAlertSlackMs / 2)
      : null;
    let candidateThreshold = loopThreshold;
    if (Number.isFinite(cacheThreshold) && cacheThreshold > 0) {
      candidateThreshold = Number.isFinite(candidateThreshold)
        ? Math.min(candidateThreshold, cacheThreshold)
        : cacheThreshold;
    }
    this.staleAlertThresholdMs = Math.max(100, candidateThreshold || 0);
    this.staleAlertCooldownMs = Math.max(0, PRICE_STALE_ALERT_COOLDOWN_MS);
    this._lastStaleAlert = new Map();
    
    // Rate limiting for Jupiter Price API
    // Default to 20 seconds to avoid 429s (increased from 15s due to persistent rate limits)
    this.jupApiMinMs = Number(process.env.JUP_API_MIN_MS) || 20000;
    // Initialize to enforce minimum delay even on first call (prevents 429s from shared IP rate limits)
    this.lastJupApiCall = Date.now() - this.jupApiMinMs; // Allow first call after configured delay
    this.backoffMultiplier = 1; // Exponential backoff on 429s
    
    // Log the actual rate limit being used (helps debug env var issues)
    console.log(`🔧 Jupiter rate limit: ${this.jupApiMinMs}ms (${(this.jupApiMinMs/1000).toFixed(1)}s between calls)`);
    if (!process.env.JUP_API_MIN_MS) {
      console.warn(`⚠️  JUP_API_MIN_MS not set in environment, using default: ${this.jupApiMinMs}ms`);
    }
    
    // Health tracking per source
    this.sourceHealth = {
      jupiter: new SourceHealth('Jupiter', telegram),
      coinbase: new SourceHealth('Coinbase', telegram),
      pyth: new SourceHealth('Pyth', telegram),
      coingecko: new SourceHealth('CoinGecko', telegram),
    };
    
    // Pass feed reference to Jupiter health for backoff control
    this.sourceHealth.jupiter.feed = this;
    
    this.sourceHealth.jupiter.enabled = ENABLE_JUPITER_PRICE;
    this.sourceHealth.coinbase.enabled = ENABLE_COINBASE_PRICE;
    this.sourceHealth.pyth.enabled = ENABLE_PYTH_PRICE;
    this.sourceHealth.coingecko.enabled = ENABLE_COINGECKO_PRICE;
    
    this.lastHealthReport = 0;
    this.healthReportInterval = 5 * 60 * 1000;

    this.logPriceSources = process.env.LOG_PRICE_SOURCES === 'true';
    this.priceSourceLogInterval = Number(process.env.PRICE_SOURCE_LOG_INTERVAL_MS || 60_000);
    this.lastSourceLog = new Map();
  }

  /**
   * Fetch prices for multiple symbols from the Jupiter Price API v3 in a single request.
   * Applies rate limiting/backoff and updates local cache plus health metrics.
   */
  async _fetchJupiterBatch(symbols = []) {
    const requested = Array.isArray(symbols)
      ? symbols
          .map(sym => (typeof sym === 'string' ? sym.trim().toUpperCase() : ''))
          .filter(Boolean)
      : [];

    if (requested.length === 0) {
      return {};
    }

    // Respect Jupiter rate limit with exponential backoff support
    const elapsed = Date.now() - this.lastJupApiCall;
    const baseWait = this.jupApiMinMs * this.backoffMultiplier;
    const wait = baseWait - elapsed;
    if (wait > 0) {
      if (this.backoffMultiplier > 1) {
        console.log(
          `⏳ Backing off Jupiter API: waiting ${(wait / 1000).toFixed(1)}s (${this.backoffMultiplier}x multiplier)`
        );
      }
      await new Promise(resolve => setTimeout(resolve, wait));
    }

    const mintList = requested
      .map(sym => SYMBOL_MAPS.jupiter[sym])
      .filter(Boolean);

    if (mintList.length === 0) {
      console.warn('⚠️  No valid Jupiter mint addresses found for symbols:', requested);
      return {};
    }

    const params = { ids: mintList.join(',') };
    const config = { params };
    if (JUP_API_KEY) {
      config.headers = { 'X-API-KEY': JUP_API_KEY };
    }

    const startTime = Date.now();
    const response = await this.http.get(JUP_PRICE_API_URL, config);
    this.lastJupApiCall = Date.now();
    const latency = Date.now() - startTime;

    const result = {};
    const requestedSet = new Set(requested);
    const payload = response.data;
    let recordedSuccess = false;

    if (payload && typeof payload === 'object') {
      for (const [mint, priceData] of Object.entries(payload)) {
        const symbolsForMint = MINT_TO_SYMBOL[mint];
        if (!symbolsForMint || symbolsForMint.length === 0) {
          continue;
        }
        const price = Number(priceData?.usdPrice);
        if (!Number.isFinite(price) || price <= 0) {
          continue;
        }

        if (!recordedSuccess) {
          this.sourceHealth.jupiter.recordSuccess(latency);
          recordedSuccess = true;
        }

        for (const sym of symbolsForMint) {
          if (!requestedSet.has(sym)) {
            continue;
          }
          this._validatePrice(sym, price, 'jupiter');
          const cacheKey = sym.toUpperCase();
          this.cache.set(cacheKey, {
            price,
            source: 'jupiter',
            timestamp: Date.now(),
          });
          result[sym] = { price, source: 'jupiter', latency, cached: false };
        }
      }
    }

    return result;
  }

  /**
   * Fetch prices for multiple symbols, trying Pyth first (1st priority), then Jupiter batch, then per-symbol fallback.
   */
  async getPricesBatch(symbols = []) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return {};
    }

    const normalized = symbols
      .map(sym => (typeof sym === 'string' ? sym.trim().toUpperCase() : ''))
      .filter(Boolean);

    const result = {};
    const missing = [];
    const now = Date.now();

    for (const sym of normalized) {
      const cacheKey = sym.toUpperCase();
      const cached = this.cache.get(cacheKey);
      const cacheAge = cached ? now - cached.timestamp : Infinity;

      // Only use cache if it's still valid (within TTL)
      if (cached && cacheAge < this.cacheTtlMs) {
        // Check if we should force refresh despite valid cache
        const shouldForceRefresh = this._shouldForceRefreshFromCache(sym, cacheAge);
        if (!shouldForceRefresh) {
        result[sym] = {
          price: cached.price,
          source: cached.source,
          cached: true,
          age: cacheAge,
        };
      } else {
          missing.push(sym);
        }
      } else {
        // Cache is stale or missing - fetch fresh
        missing.push(sym);
      }
    }

    // Try Pyth first (1st priority) for missing symbols
    const pythHealth = this.sourceHealth?.pyth;
    const canUsePyth = pythHealth?.isAvailable ? pythHealth.isAvailable() : true;
    const stillMissing = [];
    
    if (missing.length > 0 && canUsePyth) {
      // Fetch Pyth prices individually (Pyth doesn't have a batch API)
      for (const sym of missing) {
        try {
          const pythResult = await this._fetchFromPyth(sym);
          this._validatePrice(sym, pythResult.price, pythResult.source);
          pythHealth.recordSuccess(pythResult.latency);
          
          const cacheKey = sym.toUpperCase();
          this.cache.set(cacheKey, {
            price: pythResult.price,
            source: pythResult.source,
            timestamp: Date.now(),
          });
          
          result[sym] = {
            price: pythResult.price,
            source: pythResult.source,
            cached: false,
            latency: pythResult.latency,
            age: 0,
          };
        } catch (error) {
          pythHealth.recordFailure(error);
          stillMissing.push(sym);
        }
      }
    } else {
      stillMissing.push(...missing);
    }

    // Fall back to Jupiter batch for any symbols still missing
    const jupiterHealth = this.sourceHealth?.jupiter;
    const canUseJupiter = jupiterHealth?.isAvailable ? jupiterHealth.isAvailable() : true;

    if (stillMissing.length > 0 && canUseJupiter) {
      try {
        const batch = await this._fetchJupiterBatch(stillMissing);
        for (const [sym, payload] of Object.entries(batch)) {
          result[sym] = { ...payload, age: 0 };
        }
      } catch (error) {
        if (jupiterHealth?.recordFailure) {
          jupiterHealth.recordFailure(error);
        }
        console.warn(`⚠️  Jupiter batch fetch failed: ${error.message}`);
      }
    } else if (stillMissing.length > 0 && !canUseJupiter) {
      console.warn('⚠️  Skipping Jupiter batch fetch (circuit breaker active or feed disabled)');
    }

    // Final fallback: use getPrice() for any symbols still missing (tries Coinbase, then CoinGecko)
    for (const sym of normalized) {
      if (!result[sym]) {
        try {
          const single = await this.getPrice(sym);
          result[sym] = {
            price: single.price,
            source: single.source,
            cached: single.cached,
            age: typeof single.age === 'number' ? single.age : 0,
          };
        } catch (error) {
          console.warn(`⚠️  Failed to fetch price for ${sym} in batch fallback: ${error.message}`);
        }
      }
    }

    return result;
  }

  /**
   * Fetch price from Jupiter Swap API
   */
  async _fetchFromJupiter(symbol) {
    if (!this.jupiterClient) {
      throw new Error('Jupiter client not configured');
    }
    if (typeof this.jupiterClient._getMarketPriceJupiterOnly !== 'function') {
      throw new Error('Jupiter client missing _getMarketPriceJupiterOnly method');
    }
    const startTime = Date.now();
    const price = await this.jupiterClient._getMarketPriceJupiterOnly(symbol);
    const latency = Date.now() - startTime;
    return { price, source: 'jupiter', latency };
  }

  /**
   * Fetch price from Coinbase API (no geo-blocking, very reliable)
   */
  async _fetchFromCoinbase(symbol) {
    const coinbaseSymbol = SYMBOL_MAPS.coinbase[symbol];
    if (!coinbaseSymbol) {
      throw new Error(`No Coinbase mapping for ${symbol}`);
    }
    
    const startTime = Date.now();
    const response = await this.http.get(`https://api.coinbase.com/v2/prices/${coinbaseSymbol}/spot`);
    const latency = Date.now() - startTime;
    
    const price = Number(response.data.data.amount);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid price from Coinbase: ${price}`);
    }
    
    return { price, source: 'coinbase', latency };
  }

  /**
   * Fetch price from Pyth Network (on-chain oracle, always accessible)
   */
  async _fetchFromPyth(symbol) {
    // Prefer deterministic daily mapping when enabled (prevents wrong-instrument feeds)
    const dailyId = _readDailyPythFeedId(symbol);
    const pythFeedId = dailyId ? `0x${dailyId.replace(/^0x/i, '')}` : SYMBOL_MAPS.pyth[symbol];
    if (!pythFeedId) {
      throw new Error(`No Pyth mapping for ${symbol}`);
    }
    
    const startTime = Date.now();
    // Use Pyth's HTTP API for latest price
    const response = await this.http.get(`https://hermes.pyth.network/api/latest_price_feeds`, {
      params: {
        ids: [pythFeedId],
      },
    });
    const latency = Date.now() - startTime;
    
    if (!response.data || !response.data[0] || !response.data[0].price) {
      throw new Error('Invalid response from Pyth Network');
    }
    
    const priceData = response.data[0].price;
    const price = Number(priceData.price) * Math.pow(10, priceData.expo);
    
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid price from Pyth: ${price}`);
    }
    
    return { price, source: 'pyth', latency };
  }

  /**
   * Fetch price from CoinGecko (with optional API key for higher limits)
   */
  async _fetchFromCoinGecko(symbol) {
    const coingeckoId = SYMBOL_MAPS.coingecko[symbol];
    if (!coingeckoId) {
      throw new Error(`No CoinGecko mapping for ${symbol}`);
    }
    
    const startTime = Date.now();
    const config = {
      params: {
        ids: coingeckoId,
        vs_currencies: 'usd',
      },
    };
    
    // Add API key if provided (for higher rate limits)
    if (COINGECKO_API_KEY) {
      config.headers = { 'x-cg-pro-api-key': COINGECKO_API_KEY };
    }
    
    const response = await this.http.get(`https://api.coingecko.com/api/v3/simple/price`, config);
    const latency = Date.now() - startTime;
    
    const price = Number(response.data[coingeckoId]?.usd);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid price from CoinGecko: ${price}`);
    }
    
    return { price, source: 'coingecko', latency };
  }

  /**
   * Validate price is within reasonable range
   */
  _validatePrice(symbol, price, source) {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid price: ${price}`);
    }
    
    // Use dynamic range lookup (supports alts via registry)
    const range = getPriceRange(symbol);
    if (price < range.min || price > range.max) {
      throw new Error(
        `Price $${price.toFixed(2)} from ${source} is outside expected range [$${range.min}, $${range.max}] for ${symbol}`
      );
    }
    
    return true;
  }

  /**
   * Fetch price with improved fallback strategy
   */
  async getPrice(symbol) {
    const cacheKey = symbol.toUpperCase();
    
    // Check cache first
    const cached = this.cache.get(cacheKey);
    const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
    
    // Only use cache if it's still valid (within TTL)
    if (cached && cacheAge < this.cacheTtlMs) {
      // Check if we should force refresh despite valid cache
      const shouldForceRefresh = this._shouldForceRefreshFromCache(symbol, cacheAge);
      if (!shouldForceRefresh) {
      return {
        price: cached.price,
        source: cached.source,
        cached: true,
        age: cacheAge,
      };
      }
      // If shouldForceRefresh is true, fall through to fetch fresh
    }
    
    // Define source priority (Jupiter Swap Quote API REMOVED - causes 429s)
    // Using: Pyth (1st priority) + Coinbase + CoinGecko
    const sources = [
      { name: 'pyth', fn: () => this._fetchFromPyth(symbol), health: this.sourceHealth.pyth },
      { name: 'coinbase', fn: () => this._fetchFromCoinbase(symbol), health: this.sourceHealth.coinbase },
      { name: 'coingecko', fn: () => this._fetchFromCoinGecko(symbol), health: this.sourceHealth.coingecko },
    ];
    
    const errors = [];
    
    // Try each source in order
    for (const source of sources) {
      // Skip unavailable sources (no emergency recovery needed without Jupiter Swap API)
      if (!source.health.isAvailable()) {
        continue;
      }
      
      try {
        const result = await source.fn();
        this._validatePrice(symbol, result.price, result.source);
        
        source.health.recordSuccess(result.latency);
        
        this.cache.set(cacheKey, {
          price: result.price,
          source: result.source,
          timestamp: Date.now(),
        });
        
        const previousSource = cached?.source;
        let logReason = 'heartbeat';
        if (!cached) {
          logReason = 'initial';
        } else if (previousSource !== result.source) {
          logReason = 'source-change';
        }
        this._logPriceSource(symbol, result, logReason, previousSource);
        
        return {
          price: result.price,
          source: result.source,
          cached: false,
          latency: result.latency,
        };
      } catch (error) {
        source.health.recordFailure(error);
        errors.push({ source: source.name, error: error.message });
      }
    }
    
    // All sources failed - use stale cache if available
    if (cached) {
      const age = Date.now() - cached.timestamp;
      const ageMinutes = (age / 60000).toFixed(1);
      console.warn(`⚠️  All sources failed for ${symbol}, using stale cache (${ageMinutes}min old)`);
      
      this._maybeEmitHealthReport();
      
      return {
        price: cached.price,
        source: cached.source,
        cached: true,
        stale: true,
        age,
      };
    }
    
    // Total failure - no cache available
    const errorSummary = errors.map(e => `${e.source}: ${e.error}`).join('; ');
    throw new Error(`All price sources failed for ${symbol}. Errors: ${errorSummary}`);
  }

  getHealthStatus() {
    return {
      jupiter: this.sourceHealth.jupiter.getStatus(),
      coinbase: this.sourceHealth.coinbase.getStatus(),
      pyth: this.sourceHealth.pyth.getStatus(),
      coingecko: this.sourceHealth.coingecko.getStatus(),
      cacheSize: this.cache.size,
      cacheTtlMs: this.cacheTtlMs,
    };
  }

  _shouldForceRefreshFromCache(symbol, cacheAge) {
    if (!Number.isFinite(cacheAge)) {
      return false;
    }
    if (cacheAge >= this.cacheTtlMs) {
      this._logStaleCache(symbol, cacheAge, 'cache_ttl');
      return true;
    }
    if (!Number.isFinite(this.staleAlertThresholdMs) || this.staleAlertThresholdMs <= 0) {
      return false;
    }
    if (cacheAge >= this.staleAlertThresholdMs) {
      this._logStaleCache(symbol, cacheAge, 'loop_threshold');
      return true;
    }
    return false;
  }

  _logStaleCache(symbol, ageMs, reason) {
    const now = Date.now();
    const lastAlertTs = this._lastStaleAlert.get(symbol) || 0;
    if (this.staleAlertCooldownMs > 0 && now - lastAlertTs < this.staleAlertCooldownMs) {
      return;
    }
    this._lastStaleAlert.set(symbol, now);

    const ageSeconds = (ageMs / 1000).toFixed(2);
    const ttlSeconds = (this.cacheTtlMs / 1000).toFixed(2);
    const loopSeconds = this.loopDurationMs ? (this.loopDurationMs / 1000).toFixed(2) : 'unknown';
    let detail = '';
    if (reason === 'cache_ttl') {
      detail = `exceeded cache TTL (${ttlSeconds}s, bot loop ${loopSeconds}s)`;
    } else if (reason === 'loop_threshold') {
      const thresholdSeconds = (this.staleAlertThresholdMs / 1000).toFixed(2);
      detail = `exceeded freshness threshold (${thresholdSeconds}s, bot loop ${loopSeconds}s)`;
    }
    console.warn(`⚠️  ${symbol} price cache is ${ageSeconds}s old${detail ? ` – ${detail}` : ''}. Fetching live price.`);
  }

  _logPriceSource(symbol, result, reason, previousSource) {
    if (!this.logPriceSources) {
      return;
    }

    const now = Date.now();
    const key = `${symbol}:${result.source}`;
    const lastLog = this.lastSourceLog.get(key) || 0;
    const intervalExceeded = now - lastLog >= this.priceSourceLogInterval;
    const criticalReason = ['initial', 'source-change', 'forced'].includes(reason);

    if (!criticalReason && !intervalExceeded) {
      return;
    }

    this.lastSourceLog.set(key, now);

    const notes = [];
    if (reason === 'initial') {
      notes.push('initial fetch');
    } else if (reason === 'source-change' && previousSource && previousSource !== result.source) {
      notes.push(`switched from ${previousSource}`);
    } else if (reason === 'forced') {
      notes.push('forced recovery');
    }

    if (!criticalReason && intervalExceeded) {
      notes.push('heartbeat');
    }

    const noteSuffix = notes.length ? ` (${notes.join(', ')})` : '';

    console.log(`✅ ${symbol}: $${result.price.toFixed(2)} via ${result.source}${noteSuffix}`);
  }

  _maybeEmitHealthReport() {
    const now = Date.now();
    if (now - this.lastHealthReport > this.healthReportInterval) {
      this.lastHealthReport = now;
      console.log('\n📊 Price Feed Health Report:');
      const status = this.getHealthStatus();
      for (const [source, health] of Object.entries(status)) {
        if (source === 'cacheSize' || source === 'cacheTtlMs') continue;
        console.log(`   ${health.name}: ${health.available ? '✅' : '🔴'} ${health.successRate} success rate, ${health.consecutiveFailures} consecutive failures`);
        if (health.lastError !== 'None') {
          console.log(`      Last error: ${health.lastError}`);
        }
      }
      console.log('');
    }
  }

  resetHealth() {
    for (const health of Object.values(this.sourceHealth)) {
      health.successCount = 0;
      health.failureCount = 0;
      health.consecutiveFailures = 0;
      health.circuitBreakerTripped = false;
      health.circuitBreakerUntil = 0;
      health.totalRequests = 0;
    }
    console.log('✅ Price feed health statistics reset');
  }
}

module.exports = ImprovedMultiPriceFeed;
module.exports.SYMBOL_MAPS = SYMBOL_MAPS;
module.exports.getPriceRange = getPriceRange;

