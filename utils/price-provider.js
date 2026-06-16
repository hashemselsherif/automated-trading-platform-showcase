/**
 * Unified Price Provider
 * 
 * Integrates multiple price sources with intelligent fallback:
 * 1. PRIMARY: Pyth WebSocket (real-time, 400ms updates, no rate limits)
 * 2. FALLBACK: Jupiter Price API (batched, 1-2s cache, rate limited)
 * 3. CACHE: Last known good prices (stale fallback)
 * 
 * Features:
 * - Automatic failover between sources
 * - Batched fetching for all markets
 * - Staleness detection
 * - Performance metrics
 * - Health monitoring
 * 
 * Usage:
 *   const provider = new PriceProvider({ markets: ['SOL-PERP', 'BTC-PERP'], jupiterClient });
 *   await provider.start();
 *   const prices = await provider.getAllPrices(); // { 'SOL-PERP': { price, source, age, ... }, ... }
 *   const price = provider.getPrice('SOL-PERP'); // Single market
 */

const PythWebSocketClient = require('./pyth-websocket-client');
const { getDailyPythFeedIdsForMarkets } = require('./pyth-feed-id-cache');

class PriceProvider {
  constructor(options = {}) {
    this.markets = options.markets || [];
    this.jupiterClient = options.jupiterClient; // Jupiter Price API client
    
    // Pyth WebSocket (primary source)
    this.pythWS = null;
    this.pythWSEnabled = options.enablePythWS !== false; // Default: enabled
    
    // Price cache (all sources)
    this.priceCache = new Map(); // market -> { price, source, timestamp, metadata }
    
    // Source priority
    this.sourcePriority = ['pyth-ws', 'jupiter-batch', 'jupiter-single', 'cache-stale'];
    
    // Staleness thresholds (ms)
    this.freshnessThresholds = {
      'pyth-ws': 2000,        // 2s (Pyth updates every 400ms, so 2s is very stale)
      'jupiter-batch': 5000,   // 5s (Jupiter cache is typically 1-2s)
      'jupiter-single': 5000,  // 5s
      'cache-stale': 30000,    // 30s (emergency fallback)
    };
    
    // Metrics
    this.stats = {
      totalFetches: 0,
      sourceUsage: {
        'pyth-ws': 0,
        'jupiter-batch': 0,
        'jupiter-single': 0,
        'cache-stale': 0,
      },
      errors: {
        pythWS: 0,
        jupiter: 0,
      },
      avgLatency: {
        'pyth-ws': 0,
        'jupiter-batch': 0,
        'jupiter-single': 0,
      },
      latencySamples: {
        'pyth-ws': [],
        'jupiter-batch': [],
        'jupiter-single': [],
      },
      maxLatencySamples: 100,
    };
    
    // Health tracking
    this.health = {
      pythWS: { available: false, lastCheck: null, consecutiveFailures: 0 },
      jupiter: { available: true, lastCheck: null, consecutiveFailures: 0 },
    };
    
    // Configuration
    this.maxConsecutiveFailures = 5;
    this.healthCheckIntervalMs = 60000; // 1 minute
    this.healthCheckTimer = null;
  }
  
  /**
   * Start the price provider (connect to Pyth WebSocket)
   */
  async start() {
    console.log('[PriceProvider] Starting...');
    console.log(`   Markets: ${this.markets.join(', ')}`);
    console.log(`   Pyth WebSocket: ${this.pythWSEnabled ? 'ENABLED' : 'DISABLED'}`);
    
    if (this.pythWSEnabled && this.markets.length > 0) {
      try {
        // Optional: deterministic per-day feed ID mapping (prevents wrong-instrument feeds)
        let feedIdsOverride = null;
        if ((process.env.PYTH_FEED_IDS_MODE || '').toLowerCase() === 'daily') {
          try {
            feedIdsOverride = await getDailyPythFeedIdsForMarkets(this.markets);
            const keys = Object.keys(feedIdsOverride || {});
            console.log(`[PriceProvider] Pyth feed IDs: daily cache enabled (keys=${keys.length})`);
          } catch (e) {
            console.warn('[PriceProvider] Pyth feed ID daily resolver failed, falling back to registry:', e?.message || e);
            feedIdsOverride = null;
          }
        }

        this.pythWS = new PythWebSocketClient({
          ...(feedIdsOverride ? { feedIds: feedIdsOverride } : {}),
          onPriceUpdate: (market, price, metadata) => {
            this._handlePythUpdate(market, price, metadata);
          },
          onError: (error) => {
            console.error('[PriceProvider] Pyth WS error:', error.message);
            this.stats.errors.pythWS++;
            this.health.pythWS.consecutiveFailures++;
            
            // Mark as unavailable after too many failures
            if (this.health.pythWS.consecutiveFailures >= this.maxConsecutiveFailures) {
              this.health.pythWS.available = false;
              console.warn('[PriceProvider] ⚠️  Pyth WS marked as unavailable after repeated failures');
            }
          },
          onConnect: () => {
            console.log('[PriceProvider] ✅ Pyth WebSocket connected');
            this.health.pythWS.available = true;
            this.health.pythWS.consecutiveFailures = 0;
            this.health.pythWS.lastCheck = Date.now();
          },
          onDisconnect: (code, reason) => {
            console.warn(`[PriceProvider] Pyth WebSocket disconnected (code: ${code})`);
            this.health.pythWS.available = false;
          },
        });
        
        // Connect to Pyth WebSocket
        this.pythWS.connect(this.markets);
        
        console.log('[PriceProvider] ✅ Pyth WebSocket initialized');
      } catch (error) {
        console.error('[PriceProvider] Failed to initialize Pyth WebSocket:', error);
        this.pythWSEnabled = false;
        this.health.pythWS.available = false;
      }
    }
    
    // Start health check timer
    this._startHealthCheck();
    
    console.log('[PriceProvider] ✅ Started');
  }
  
  /**
   * Stop the price provider
   */
  async stop() {
    console.log('[PriceProvider] Stopping...');
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    if (this.pythWS) {
      // Set shutdown flag to prevent reconnection
      this.pythWS.isShuttingDown = true;
      
      // Disconnect cleanly
      this.pythWS.disconnect(true);
      
      // Wait a bit for clean disconnect
      await new Promise(resolve => setTimeout(resolve, 100));
      
      this.pythWS = null;
    }
    
    console.log('[PriceProvider] ✅ Stopped');
  }
  
  /**
   * Get all prices for all markets (batched when possible)
   * @returns {Map<string, Object>} Map of market -> price data
   */
  async getAllPrices() {
    const startTime = Date.now();
    this.stats.totalFetches++;
    
    const priceMap = new Map();
    const fetchMeta = {
      markets: this.markets.length,
      sources: {},
      missing: [],
    };
    
    // 1. Try Pyth WebSocket first (fastest, most reliable)
    const pythMarkets = [];
    if (this.pythWS && this.health.pythWS.available) {
      for (const market of this.markets) {
        const pythData = this._getPythPrice(market);
        if (pythData && this._isFresh(pythData)) {
          priceMap.set(market, pythData);
          pythMarkets.push(market);
          this.stats.sourceUsage['pyth-ws']++;
          fetchMeta.sources[market] = 'pyth-ws';
        }
      }
      
      if (pythMarkets.length > 0) {
        const latency = Date.now() - startTime;
        this._recordLatency('pyth-ws', latency);
        console.log(`[PriceProvider] Pyth WS: ${pythMarkets.length}/${this.markets.length} markets (${latency}ms)`);
      }
    }
    
    // 2. Try Jupiter batched API for missing markets
    const toFetchBatch = this.markets.filter(m => !priceMap.has(m));
    if (toFetchBatch.length > 0 && this.jupiterClient) {
      try {
        const batchStartTime = Date.now();
        const batch = await this._fetchJupiterBatch(toFetchBatch);
        const batchLatency = Date.now() - batchStartTime;
        
        let successCount = 0;
        for (const [market, priceData] of batch.entries()) {
          if (priceData && Number.isFinite(priceData.price)) {
            priceMap.set(market, priceData);
            successCount++;
            this.stats.sourceUsage['jupiter-batch']++;
            fetchMeta.sources[market] = 'jupiter-batch';
          }
        }
        
        if (successCount > 0) {
          this._recordLatency('jupiter-batch', batchLatency);
          console.log(`[PriceProvider] Jupiter Batch: ${successCount}/${toFetchBatch.length} markets (${batchLatency}ms)`);
          this.health.jupiter.available = true;
          this.health.jupiter.consecutiveFailures = 0;
        }
      } catch (error) {
        console.error('[PriceProvider] Jupiter batch fetch failed:', error.message);
        this.stats.errors.jupiter++;
        this.health.jupiter.consecutiveFailures++;
        
        if (this.health.jupiter.consecutiveFailures >= this.maxConsecutiveFailures) {
          this.health.jupiter.available = false;
        }
      }
    }
    
    // 3. Try cache for still-missing markets
    const toFetchCache = this.markets.filter(m => !priceMap.has(m));
    if (toFetchCache.length > 0) {
      for (const market of toFetchCache) {
        const cachedData = this.priceCache.get(market);
        if (cachedData) {
          // Mark as stale
          priceMap.set(market, {
            ...cachedData,
            source: 'cache-stale',
            age: Date.now() - cachedData.timestamp,
          });
          this.stats.sourceUsage['cache-stale']++;
          fetchMeta.sources[market] = 'cache-stale';
          console.warn(`[PriceProvider] Using stale cache for ${market} (age: ${Math.round((Date.now() - cachedData.timestamp) / 1000)}s)`);
        } else {
          fetchMeta.missing.push(market);
        }
      }
    }
    
    // Log missing markets
    if (fetchMeta.missing.length > 0) {
      console.error(`[PriceProvider] ❌ Missing prices for: ${fetchMeta.missing.join(', ')}`);
    }
    
    const totalLatency = Date.now() - startTime;
    console.log(`[PriceProvider] Fetched ${priceMap.size}/${this.markets.length} prices in ${totalLatency}ms`);
    
    return priceMap;
  }
  
  /**
   * Get price for a single market
   * @param {string} market - Market symbol
   * @returns {Object|null} Price data or null
   */
  getPrice(market) {
    // Try Pyth WebSocket first
    if (this.pythWS && this.health.pythWS.available) {
      const pythData = this._getPythPrice(market);
      if (pythData && this._isFresh(pythData)) {
        return pythData;
      }
    }
    
    // Try cache
    const cachedData = this.priceCache.get(market);
    if (cachedData) {
      return {
        ...cachedData,
        age: Date.now() - cachedData.timestamp,
      };
    }
    
    return null;
  }

  /**
   * Get fresh Pyth WS price data for a market (no fallback).
   * @param {string} market - Market symbol
   * @returns {Object|null} Pyth price data or null if unavailable/stale
   */
  getPythPriceData(market) {
    if (!this.pythWS || !this.health.pythWS.available) return null;
    const pythData = this._getPythPrice(market);
    if (!pythData || !this._isFresh(pythData)) return null;
    return {
      ...pythData,
      age: Date.now() - pythData.timestamp,
    };
  }
  
  /**
   * Handle Pyth WebSocket price update
   */
  _handlePythUpdate(market, price, metadata) {
    const priceData = {
      price,
      source: 'pyth-ws',
      timestamp: Date.now(),
      volume: 0, // Volume not available from Pyth
      rawVolume: null,
      metadata: {
        conf: metadata.conf,
        emaPrice: metadata.emaPrice,
        publishTime: metadata.publishTime,
      },
    };
    
    // Update cache
    this.priceCache.set(market, priceData);
    
    // Reset failure counter on successful update
    if (this.health.pythWS.consecutiveFailures > 0) {
      this.health.pythWS.consecutiveFailures = 0;
      this.health.pythWS.available = true;
    }
  }
  
  /**
   * Get price from Pyth WebSocket
   */
  _getPythPrice(market) {
    if (!this.pythWS) return null;
    
    const priceData = this.pythWS.getPriceData(market);
    if (!priceData) return null;
    
    return {
      price: priceData.price,
      source: priceData.source,
      timestamp: priceData.ts,
      volume: 0,
      rawVolume: null,
      metadata: {
        conf: priceData.conf,
        emaPrice: priceData.emaPrice,
        publishTime: priceData.publishTime,
      },
    };
  }
  
  /**
   * Fetch prices from Jupiter API (batched)
   */
  async _fetchJupiterBatch(markets) {
    const priceMap = new Map();
    
    if (!this.jupiterClient || typeof this.jupiterClient.getMarketPricesBatch !== 'function') {
      console.warn('[PriceProvider] Jupiter batch API not available');
      return priceMap;
    }
    
    try {
      const symbols = markets.map(m => m.split('-')[0]); // SOL-PERP -> SOL
      const batch = await this.jupiterClient.getMarketPricesBatch(symbols);
      
      for (const market of markets) {
        const symbol = market.split('-')[0];
        const price = batch[symbol];
        
        if (Number.isFinite(price) && price > 0) {
          const priceData = {
            price,
            source: 'jupiter-batch',
            timestamp: Date.now(),
            volume: 0,
            rawVolume: null,
          };
          
          priceMap.set(market, priceData);
          this.priceCache.set(market, priceData);
        }
      }
    } catch (error) {
      console.error('[PriceProvider] Jupiter batch error:', error.message);
      throw error;
    }
    
    return priceMap;
  }
  
  /**
   * Check if price data is fresh
   */
  _isFresh(priceData) {
    if (!priceData) return false;
    
    const age = Date.now() - priceData.timestamp;
    const threshold = this.freshnessThresholds[priceData.source] || 5000;
    
    return age <= threshold;
  }
  
  /**
   * Record latency for a source
   */
  _recordLatency(source, latency) {
    const samples = this.stats.latencySamples[source];
    if (!samples) return;
    
    samples.push(latency);
    
    // Keep only recent samples
    if (samples.length > this.stats.maxLatencySamples) {
      samples.shift();
    }
    
    // Calculate average
    const sum = samples.reduce((a, b) => a + b, 0);
    this.stats.avgLatency[source] = sum / samples.length;
  }
  
  /**
   * Start health check timer
   */
  _startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this._performHealthCheck();
    }, this.healthCheckIntervalMs);
  }
  
  /**
   * Perform health check
   */
  _performHealthCheck() {
    const now = Date.now();
    
    // Check Pyth WebSocket
    if (this.pythWS) {
      const stats = this.pythWS.getStats();
      const isConnected = this.pythWS.isConnected();
      const hasRecentUpdate = stats.lastUpdate && (now - stats.lastUpdate) < 10000; // 10s
      
      this.health.pythWS.available = isConnected && hasRecentUpdate;
      this.health.pythWS.lastCheck = now;
      
      if (!this.health.pythWS.available) {
        console.warn('[PriceProvider] Health Check: Pyth WS unhealthy', {
          connected: isConnected,
          hasRecentUpdate,
          lastUpdate: stats.lastUpdate,
          age: stats.lastUpdate ? now - stats.lastUpdate : null,
        });
      }
    }
    
    // Check Jupiter API (based on recent errors)
    this.health.jupiter.lastCheck = now;
    
    // Log health status
    console.log('[PriceProvider] Health Check:', {
      pythWS: this.health.pythWS.available ? '✅' : '❌',
      jupiter: this.health.jupiter.available ? '✅' : '❌',
    });
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const pythStats = this.pythWS ? this.pythWS.getStats() : null;
    
    return {
      totalFetches: this.stats.totalFetches,
      sourceUsage: { ...this.stats.sourceUsage },
      errors: { ...this.stats.errors },
      avgLatency: { ...this.stats.avgLatency },
      health: {
        pythWS: { ...this.health.pythWS },
        jupiter: { ...this.health.jupiter },
      },
      pythWSStats: pythStats,
      cacheSize: this.priceCache.size,
    };
  }
  
  /**
   * Get health status
   */
  getHealth() {
    return {
      pythWS: this.health.pythWS.available,
      jupiter: this.health.jupiter.available,
      overall: this.health.pythWS.available || this.health.jupiter.available,
    };
  }
}

module.exports = PriceProvider;
