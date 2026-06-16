// utils/multi-price-feed.js
//
// Multi-source price feed with automatic fallback and health monitoring
//
// Features:
//   - Multiple price sources (Jupiter, Binance, CoinGecko, Pyth)
//   - Automatic fallback on source failure
//   - Price validation and sanity checks
//   - Health monitoring and diagnostics
//   - Exponential backoff and circuit breaker per source
//   - Detailed logging for debugging production issues

const axios = require('axios');

// Environment configuration
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || 5_000);
const PRICE_FETCH_TIMEOUT_MS = Number(process.env.PRICE_FETCH_TIMEOUT_MS || 8_000);
const ENABLE_BINANCE_PRICE = process.env.ENABLE_BINANCE_PRICE !== 'false'; // enabled by default
const ENABLE_COINGECKO_PRICE = process.env.ENABLE_COINGECKO_PRICE !== 'false'; // enabled by default
const ENABLE_JUPITER_PRICE = process.env.ENABLE_JUPITER_PRICE !== 'false'; // enabled by default

// Symbol mapping for different exchanges
const SYMBOL_MAPS = {
  binance: {
    'SOL': 'SOLUSDC',
    'BTC': 'BTCUSDC',
    'WBTC': 'BTCUSDC',
    'ETH': 'ETHUSDC',
  },
  coingecko: {
    'SOL': 'solana',
    'BTC': 'bitcoin',
    'WBTC': 'wrapped-bitcoin',
    'ETH': 'ethereum',
  },
};

// Price validation ranges (helps catch API errors)
const PRICE_RANGES = {
  'SOL': { min: 5, max: 2000 },
  'BTC': { min: 10000, max: 300000 },
  'WBTC': { min: 10000, max: 300000 },
  'ETH': { min: 500, max: 20000 },
};

/**
 * Health status for each price source
 */
class SourceHealth {
  constructor(name) {
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
  }

  recordSuccess(latencyMs) {
    this.successCount++;
    this.totalRequests++;
    this.consecutiveFailures = 0;
    this.lastSuccess = Date.now();
    this.lastLatency = latencyMs;
    
    // Reset circuit breaker on success
    if (this.circuitBreakerTripped) {
      console.log(`✅ Circuit breaker reset for ${this.name} after successful request`);
      this.circuitBreakerTripped = false;
      this.circuitBreakerUntil = 0;
    }
  }

  recordFailure(error) {
    this.failureCount++;
    this.totalRequests++;
    this.consecutiveFailures++;
    this.lastFailure = Date.now();
    this.lastError = error.message || String(error);
    
    // RELAXED: Trip circuit breaker after 15 consecutive failures (was 5)
    // Shorter cooldown: 2 minutes (was 5)
    // This prevents all sources from being blocked simultaneously
    if (this.consecutiveFailures >= 15 && !this.circuitBreakerTripped) {
      this.circuitBreakerTripped = true;
      this.circuitBreakerUntil = Date.now() + 2 * 60 * 1000; // 2 minute cooldown
      console.warn(`🔴 Circuit breaker TRIPPED for ${this.name} after ${this.consecutiveFailures} consecutive failures`);
      console.warn(`   Last error: ${this.lastError}`);
      console.warn(`   Will attempt recovery in 2 minutes`);
    }
  }

  isAvailable() {
    if (!this.enabled) return false;
    if (this.circuitBreakerTripped && Date.now() < this.circuitBreakerUntil) {
      return false;
    }
    // Allow half-open state after circuit breaker timeout
    if (this.circuitBreakerTripped && Date.now() >= this.circuitBreakerUntil) {
      console.log(`🟡 Attempting ${this.name} recovery (half-open state)`);
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
 * Multi-source price feed manager
 */
class MultiPriceFeed {
  constructor(jupiterClient) {
    this.jupiterClient = jupiterClient; // Optional Jupiter perps client for primary source
    
    // HTTP client with reasonable timeouts
    this.http = axios.create({
      timeout: PRICE_FETCH_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Jupiter-Perps-Bot/1.0',
      },
    });
    
    // Price cache
    this.cache = new Map();
    this.cacheTtlMs = PRICE_CACHE_TTL_MS;
    
    // Health tracking per source
    this.sourceHealth = {
      jupiter: new SourceHealth('Jupiter'),
      binance: new SourceHealth('Binance'),
      coingecko: new SourceHealth('CoinGecko'),
    };
    
    this.sourceHealth.jupiter.enabled = ENABLE_JUPITER_PRICE;
    this.sourceHealth.binance.enabled = ENABLE_BINANCE_PRICE;
    this.sourceHealth.coingecko.enabled = ENABLE_COINGECKO_PRICE;
    
    // Track overall health
    this.lastHealthReport = 0;
    this.healthReportInterval = 5 * 60 * 1000; // Report every 5 minutes

    this.logPriceSources = process.env.LOG_PRICE_SOURCES !== 'false';
    this.priceSourceLogInterval = Number(process.env.PRICE_SOURCE_LOG_INTERVAL_MS || 60_000);
    this.lastSourceLog = new Map();
  }

  /**
   * DEPRECATED: Jupiter Swap Quote API - DISABLED
   * This uses the rate-limited Swap Quote API which causes 429 errors
   * Removed from all source priority lists
   */
  async _fetchFromJupiter(symbol) {
    console.error(`❌ DEPRECATED: _fetchFromJupiter called for ${symbol}`);
    console.error(`   This would use the rate-limited Jupiter Swap Quote API`);
    console.error(`   Stack trace:`, new Error().stack);
    throw new Error(`DEPRECATED: Jupiter Swap Quote API disabled to prevent 429 errors.`);
  }

  /**
   * Fetch price from Binance spot market
   */
  async _fetchFromBinance(symbol) {
    const binanceSymbol = SYMBOL_MAPS.binance[symbol];
    if (!binanceSymbol) {
      throw new Error(`No Binance mapping for ${symbol}`);
    }
    
    const startTime = Date.now();
    try {
      const response = await this.http.get(`https://api.binance.com/api/v3/ticker/price`, {
        params: { symbol: binanceSymbol },
      });
      const latency = Date.now() - startTime;
      
      const price = Number(response.data.price);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price from Binance: ${price}`);
      }
      
      return { price, source: 'binance', latency };
    } catch (error) {
      // Handle geo-blocking (451) and other HTTP errors with more context
      if (error.response?.status === 451) {
        throw new Error(`Binance unavailable (geo-blocked): HTTP 451`);
      }
      throw error;
    }
  }

  /**
   * Fetch price from CoinGecko
   */
  async _fetchFromCoinGecko(symbol) {
    const coingeckoId = SYMBOL_MAPS.coingecko[symbol];
    if (!coingeckoId) {
      throw new Error(`No CoinGecko mapping for ${symbol}`);
    }
    
    const startTime = Date.now();
    const response = await this.http.get(`https://api.coingecko.com/api/v3/simple/price`, {
      params: {
        ids: coingeckoId,
        vs_currencies: 'usd',
      },
    });
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
    
    const range = PRICE_RANGES[symbol];
    if (range) {
      if (price < range.min || price > range.max) {
        throw new Error(
          `Price $${price.toFixed(2)} from ${source} is outside expected range [$${range.min}, $${range.max}] for ${symbol}`
        );
      }
    }
    
    return true;
  }

  /**
   * Fetch price with fallback through multiple sources
   */
  async getPrice(symbol) {
    const cacheKey = symbol.toUpperCase();
    
    // Check cache first (fresh cache only, stale handled below)
    const cached = this.cache.get(cacheKey);
    const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
    if (cached && cacheAge < this.cacheTtlMs) {
      return {
        price: cached.price,
        source: cached.source,
        cached: true,
      };
    }
    
    // Define source priority (Jupiter Swap Quote API REMOVED - causes 429s)
    // Note: This file is likely deprecated in favor of improved-multi-price-feed.js
    const sources = [
      { name: 'binance', fn: () => this._fetchFromBinance(symbol), health: this.sourceHealth.binance },
      { name: 'coingecko', fn: () => this._fetchFromCoinGecko(symbol), health: this.sourceHealth.coingecko },
    ];
    
    const errors = [];
    
    // Try each source in order
    for (const source of sources) {
      // CRITICAL FIX: If all circuit breakers are tripped, force try at least Jupiter
      // This prevents total system failure when all sources trip simultaneously
      const forceJupiterIfAllDown = source.name === 'jupiter' && 
        !this.sourceHealth.jupiter.isAvailable() &&
        !this.sourceHealth.binance.isAvailable() &&
        !this.sourceHealth.coingecko.isAvailable();
      
      if (!source.health.isAvailable() && !forceJupiterIfAllDown) {
        console.log(`⏭️  Skipping ${source.name} for ${symbol} (unavailable)`);
        continue;
      }
      
      if (forceJupiterIfAllDown) {
        console.warn(`🚨 EMERGENCY: All circuit breakers tripped, forcing Jupiter attempt for ${symbol}`);
      }
      
      try {
        const result = await source.fn();
        this._validatePrice(symbol, result.price, result.source);
        
        // Success - record and cache
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
        } else if (forceJupiterIfAllDown) {
          logReason = 'forced';
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
        
        console.warn(`⚠️  Failed to fetch ${symbol} price from ${source.name}: ${error.message}`);
      }
    }
    
    // All sources failed - check if we have stale cache
    if (cached) {
      const age = Date.now() - cached.timestamp;
      const ageMinutes = (age / 60000).toFixed(1);
      console.warn(`⚠️  All price sources failed for ${symbol}, using stale cache (${ageMinutes}min old)`);
      console.warn(`   Errors: ${JSON.stringify(errors)}`);
      
      // Emit health report if it's been a while
      this._maybeEmitHealthReport();
      
      return {
        price: cached.price,
        source: cached.source,
        cached: true,
        stale: true,
        age,
      };
    }
    
    // No cache available - total failure
    const errorSummary = errors.map(e => `${e.source}: ${e.error}`).join('; ');
    throw new Error(`All price sources failed for ${symbol}. Errors: ${errorSummary}`);
  }

  /**
   * Get health status for all sources
   */
  getHealthStatus() {
    return {
      jupiter: this.sourceHealth.jupiter.getStatus(),
      binance: this.sourceHealth.binance.getStatus(),
      coingecko: this.sourceHealth.coingecko.getStatus(),
      cacheSize: this.cache.size,
      cacheTtlMs: this.cacheTtlMs,
    };
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

    const noteSuffix = notes.length ? ` • ${notes.join(' | ')}` : '';

    console.log(`✅ Price for ${symbol}: $${result.price.toFixed(2)} from ${result.source} (${result.latency}ms)${noteSuffix}`);
  }

  /**
   * Emit health report if interval has passed
   */
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

  /**
   * Reset health statistics (useful for testing/debugging)
   */
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

module.exports = MultiPriceFeed;

