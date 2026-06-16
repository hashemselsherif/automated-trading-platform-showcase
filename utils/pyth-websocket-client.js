/**
 * Pyth Hermes WebSocket Client
 * 
 * Provides real-time price updates via WebSocket for scalping strategy.
 * - Push-based (no polling, instant updates)
 * - 400ms update frequency (Pyth standard)
 * - No rate limits (persistent WebSocket connection)
 * - Low latency (<100ms from exchange to bot)
 * - Free (no API key needed)
 * - Auto-reconnect on disconnect
 * 
 * Data Source: https://hermes.pyth.network/docs/
 * WebSocket Endpoint: wss://hermes.pyth.network/ws
 */

const WebSocket = require('ws');

// Try to load drift-market-lookup for dynamic feed ID resolution
let driftLookup = null;
try {
  driftLookup = require('./drift-market-lookup');
} catch (e) {
  console.warn('[Pyth WS] drift-market-lookup not available, using default feed IDs');
}

/**
 * Build dynamic feed IDs from drift-market-registry
 * Falls back to hardcoded majors if registry not available
 */
function buildDynamicFeedIds() {
  // Hardcoded fallbacks for majors (used if registry unavailable)
  // NOTE: Pyth API expects feed IDs WITHOUT '0x' prefix
  const defaults = {
    'SOL-PERP': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    'BTC-PERP': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    'ETH-PERP': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    'SOL/USD': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    'BTC/USD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    'ETH/USD': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  };
  
  if (!driftLookup) {
    return defaults;
  }
  
  try {
    const registry = driftLookup.loadRegistry();
    const feedIds = { ...defaults };
    
    // Add all markets from registry that have pythFeedId
    for (const [symbol, info] of Object.entries(registry.markets)) {
      if (info.pythFeedId && info.tradeable) {
        // Pyth API expects feed IDs WITHOUT 0x prefix - strip it if present
        const feedId = info.pythFeedId.startsWith('0x') 
          ? info.pythFeedId.slice(2) 
          : info.pythFeedId;
        feedIds[symbol] = feedId;
        
        // Also add base symbol alias (e.g., 'SOL' -> same feed as 'SOL-PERP')
        if (info.baseSymbol) {
          feedIds[info.baseSymbol] = feedId;
          feedIds[`${info.baseSymbol}/USD`] = feedId;
        }
      }
    }

    // Debug: how many feed IDs did we end up with?
    try {
      const tradeableCount = Object.values(registry.markets).filter(m => m && m.tradeable).length;
      const withPythCount = Object.values(registry.markets).filter(m => m && m.tradeable && m.pythFeedId).length;
      console.log(`[Pyth WS] Loaded Drift registry feed IDs: tradeable=${tradeableCount}, withPythFeedId=${withPythCount}, totalKeys=${Object.keys(feedIds).length}`);
    } catch {
      // ignore debug issues
    }

    return feedIds;
  } catch (e) {
    console.warn('[Pyth WS] Failed to load registry for feed IDs:', e.message);
    return defaults;
  }
}

class PythWebSocketClient {
  constructor(options = {}) {
    // Pyth Hermes WebSocket endpoint
    this.wsUrl = options.wsUrl || 'wss://hermes.pyth.network/ws';
    
    // Price feed IDs: dynamically built from registry, with option override
    // Source: drift-market-registry.json or fallback to pyth.network/developers/price-feed-ids
    this.feedIds = options.feedIds || buildDynamicFeedIds();
    
    // Latest prices (updated in real-time)
    this.prices = new Map(); // market -> { price, conf, expo, ts, publishTime }
    
    // Callbacks
    this.onPriceUpdate = options.onPriceUpdate || null;
    this.onError = options.onError || null;
    this.onConnect = options.onConnect || null;
    this.onDisconnect = options.onDisconnect || null;
    
    // Connection state
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 5000; // 5s
    this.reconnectTimer = null;
    
    // Subscribed markets
    this.subscribedMarkets = new Set();

    // Reverse index: feedId -> preferred subscribed market.
    // Prevents "alias bleed" where updates get stored under base symbol aliases (e.g., 'PAXG')
    // instead of the subscribed market key (e.g., 'PAXG-PERP'), which would force downstream
    // fallbacks to non-perp spot sources.
    this._subscribedFeedIdIndex = new Map(); // normalizedFeedId -> { market, score }
    
    // Stats
    this.stats = {
      updateCount: 0,
      lastUpdate: null,
      totalReconnects: 0,
      errors: 0,
      connectionUptime: 0,
      connectionStartTime: null,
    };
    
    // Heartbeat
    this.heartbeatInterval = null;
    this.heartbeatTimeout = options.heartbeatTimeout || 60000; // 60s (increased from 30s)
    this.lastHeartbeat = null;
    this.isShuttingDown = false; // Flag to prevent reconnection during shutdown
  }
  
  /**
   * Connect to Pyth WebSocket and subscribe to markets
   * @param {Array<string>} markets - Market symbols to subscribe (e.g., ['SOL-PERP', 'BTC-PERP'])
   */
  connect(markets) {
    if (this.ws && this.connected) {
      console.warn('[Pyth WS] Already connected');
      return;
    }
    
    console.log(`[Pyth WS] Connecting to ${this.wsUrl}...`);
    
    try {
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.on('open', () => this._handleOpen(markets));
      this.ws.on('message', (data) => this._handleMessage(data));
      this.ws.on('error', (error) => this._handleError(error));
      this.ws.on('close', (code, reason) => this._handleClose(code, reason));
      
    } catch (error) {
      console.error('[Pyth WS] Connection error:', error);
      this._scheduleReconnect(markets);
    }
  }
  
  /**
   * Disconnect from WebSocket
   * @param {boolean} intentional - If true, suppress reconnection attempts
   */
  disconnect(intentional = true) {
    console.log('[Pyth WS] Disconnecting...');
    
    // Clear timers first
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Close WebSocket connection
    if (this.ws) {
      this.connected = false;
      
      // Remove event listeners to prevent reconnection on close
      if (intentional) {
        this.ws.removeAllListeners();
      }
      
      // Send proper close frame (code 1000 = normal closure)
      try {
        this.ws.close(1000, 'Intentional disconnect');
      } catch (err) {
        // Ignore close errors
      }
      
      this.ws = null;
    }
    
    this.subscribedMarkets.clear();
  }
  
  /**
   * Handle WebSocket open
   */
  _handleOpen(markets) {
    console.log('[Pyth WS] ✅ Connected');
    
    this.connected = true;
    this.reconnectAttempts = 0;
    this.stats.connectionStartTime = Date.now();
    
    // Subscribe to price feeds
    this._subscribe(markets);
    
    // Start heartbeat monitor
    this._startHeartbeat();
    
    // Callback
    if (this.onConnect) {
      this.onConnect();
    }
  }
  
  /**
   * Subscribe to price feeds
   */
  _subscribe(markets) {
    if (!markets || markets.length === 0) {
      console.warn('[Pyth WS] No markets to subscribe');
      return;
    }

    // Build reverse index for subscribed markets so incoming updates map to the exact keys
    // requested by the bot (typically '-PERP' symbols).
    this._indexSubscribedFeedIds(markets);

    // Get feed IDs for markets (and explicitly log missing mappings)
    const missing = [];
    const feedIds = [];
    for (const market of markets) {
      const id = this.feedIds[market];
      if (!id) {
        missing.push(market);
        continue;
      }
      feedIds.push(id);
    }
    // De-duplicate feed IDs (multiple aliases can point to same feed)
    const uniqueFeedIds = Array.from(new Set(feedIds));
    if (missing.length > 0) {
      console.warn(`[Pyth WS] Missing feed IDs for ${missing.length}/${markets.length} markets: ${missing.join(', ')}`);
    }
    
    if (uniqueFeedIds.length === 0) {
      console.error('[Pyth WS] No valid feed IDs for markets:', markets);
      return;
    }
    
    // Subscribe message format
    const subscribeMsg = {
      type: 'subscribe',
      ids: uniqueFeedIds,
    };
    
    console.log(`[Pyth WS] Subscribing to ${uniqueFeedIds.length} price feeds for ${markets.length} markets: ${markets.join(', ')}`);
    this.ws.send(JSON.stringify(subscribeMsg));
    
    // Track subscriptions
    markets.forEach(market => this.subscribedMarkets.add(market));
  }
  
  /**
   * Handle incoming WebSocket message
   */
  _handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      
      // Handle price update
      if (message.type === 'price_update') {
        this._processPriceUpdate(message);
      }
      
      // Update heartbeat
      this.lastHeartbeat = Date.now();
      
    } catch (error) {
      console.error('[Pyth WS] Message parsing error:', error);
      this.stats.errors++;
    }
  }
  
  /**
   * Process price update message
   */
  _processPriceUpdate(message) {
    if (!message.price_feed) return;
    
    const feed = message.price_feed;
    const feedId = feed.id;
    
    // Find market for this feed ID
    const market = this._getSubscribedMarketForFeedId(feedId) || this._getMarketForFeedId(feedId);
    if (!market) {
      // Unknown feed ID, skip
      return;
    }
    
    // Extract price data
    const priceData = feed.price || {};
    const emagData = feed.ema_price || {};
    
    // Convert price from Pyth format (price * 10^expo)
    const price = Number(priceData.price || 0) * Math.pow(10, priceData.expo || 0);
    const conf = Number(priceData.conf || 0) * Math.pow(10, priceData.expo || 0);
    const emaPrice = Number(emagData.price || 0) * Math.pow(10, emagData.expo || 0);
    
    const publishTime = Number(priceData.publish_time || 0) * 1000; // Convert to ms
    const ts = Date.now();
    
    // Validate price
    if (!Number.isFinite(price) || price <= 0) {
      console.warn(`[Pyth WS] Invalid price for ${market}:`, price);
      return;
    }
    
    // Store price
    const priceObj = {
      price,
      conf,
      emaPrice,
      expo: priceData.expo,
      publishTime,
      ts,
      source: 'pyth-ws',
    };
    
    this.prices.set(market, priceObj);
    
    // Update stats
    this.stats.updateCount++;
    this.stats.lastUpdate = ts;
    
    // Callback
    if (this.onPriceUpdate) {
      this.onPriceUpdate(market, price, {
        conf,
        emaPrice,
        publishTime,
        ts,
      });
    }
  }
  
  /**
   * Find market symbol for feed ID
   */
  _getMarketForFeedId(feedId) {
    // Normalize feedId - strip 0x prefix if present
    const normalizedFeedId = feedId.startsWith('0x') ? feedId.slice(2) : feedId;
    for (const [market, id] of Object.entries(this.feedIds)) {
      const normalizedId = id.startsWith('0x') ? id.slice(2) : id;
      if (normalizedId === normalizedFeedId) {
        return market;
      }
    }
    return null;
  }

  _marketKeyScore(market) {
    const m = String(market || '');
    if (!m) return 0;
    if (m.endsWith('-PERP')) return 3;
    if (m.includes('/')) return 2;
    return 1;
  }

  _indexSubscribedFeedIds(markets) {
    this._subscribedFeedIdIndex = new Map();
    for (const market of markets || []) {
      const id = this.feedIds[market];
      if (!id) continue;
      const normalizedId = String(id).startsWith('0x') ? String(id).slice(2) : String(id);
      const score = this._marketKeyScore(market);
      const prev = this._subscribedFeedIdIndex.get(normalizedId);
      if (!prev || score > prev.score) {
        this._subscribedFeedIdIndex.set(normalizedId, { market, score });
      }
    }
  }

  _getSubscribedMarketForFeedId(feedId) {
    const normalizedFeedId = String(feedId || '').startsWith('0x')
      ? String(feedId).slice(2)
      : String(feedId || '');
    if (!normalizedFeedId) return null;
    const hit = this._subscribedFeedIdIndex.get(normalizedFeedId);
    return hit ? hit.market : null;
  }
  
  /**
   * Handle WebSocket error
   */
  _handleError(error) {
    console.error('[Pyth WS] Error:', error.message || error);
    this.stats.errors++;
    
    if (this.onError) {
      this.onError(error);
    }
  }
  
  /**
   * Handle WebSocket close
   */
  _handleClose(code, reason) {
    console.warn(`[Pyth WS] Disconnected (code: ${code}, reason: ${reason || 'unknown'})`);
    
    this.connected = false;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Update uptime
    if (this.stats.connectionStartTime) {
      this.stats.connectionUptime += Date.now() - this.stats.connectionStartTime;
      this.stats.connectionStartTime = null;
    }
    
    // Callback
    if (this.onDisconnect) {
      this.onDisconnect(code, reason);
    }
    
    // Auto-reconnect if not manually disconnected and not shutting down
    if (code !== 1000 && !this.isShuttingDown) { // 1000 = normal close
      const markets = Array.from(this.subscribedMarkets);
      this._scheduleReconnect(markets);
    }
  }
  
  /**
   * Schedule reconnection attempt
   */
  _scheduleReconnect(markets) {
    // Don't reconnect if shutting down
    if (this.isShuttingDown) {
      return;
    }
    
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Pyth WS] Max reconnect attempts reached, giving up');
      this.isShuttingDown = true; // Prevent further reconnection
      return;
    }
    
    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts; // Exponential backoff
    
    console.log(`[Pyth WS] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    this.reconnectTimer = setTimeout(() => {
      this.stats.totalReconnects++;
      this.connect(markets);
    }, delay);
  }
  
  /**
   * Start heartbeat monitor
   */
  _startHeartbeat() {
    this.lastHeartbeat = Date.now();
    
    // Clear existing heartbeat if any
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeat;
      
      if (timeSinceLastHeartbeat > this.heartbeatTimeout) {
        console.warn(`[Pyth WS] Heartbeat timeout (${Math.round(timeSinceLastHeartbeat / 1000)}s since last message), reconnecting...`);
        const markets = Array.from(this.subscribedMarkets);
        
        // Disconnect without triggering reconnection
        this.disconnect(false);
        
        // Reconnect with exponential backoff
        this._scheduleReconnect(markets);
      }
    }, this.heartbeatTimeout / 2);
  }
  
  /**
   * Get latest price for market
   * @param {string} market - Market symbol
   * @returns {number|null} Latest price or null if unavailable
   */
  getPrice(market) {
    const priceData = this.prices.get(market);
    return priceData ? priceData.price : null;
  }
  
  /**
   * Get full price data for market
   * @param {string} market - Market symbol
   * @returns {Object|null} Price data or null
   */
  getPriceData(market) {
    return this.prices.get(market) || null;
  }
  
  /**
   * Get all current prices
   * @returns {Map<string, Object>} Map of market -> price data
   */
  getAllPrices() {
    return new Map(this.prices);
  }
  
  /**
   * Check if price is fresh (recently updated)
   * @param {string} market - Market symbol
   * @param {number} maxAgeMs - Max age in milliseconds (default: 5000)
   * @returns {boolean} True if price is fresh
   */
  isPriceFresh(market, maxAgeMs = 5000) {
    const priceData = this.prices.get(market);
    if (!priceData) return false;
    
    const age = Date.now() - priceData.ts;
    return age <= maxAgeMs;
  }
  
  /**
   * Get connection statistics
   * @returns {Object} Connection stats
   */
  getStats() {
    const uptime = this.stats.connectionStartTime
      ? this.stats.connectionUptime + (Date.now() - this.stats.connectionStartTime)
      : this.stats.connectionUptime;
    
    return {
      connected: this.connected,
      updateCount: this.stats.updateCount,
      lastUpdate: this.stats.lastUpdate,
      totalReconnects: this.stats.totalReconnects,
      errors: this.stats.errors,
      connectionUptime: uptime,
      uptimeSeconds: Math.floor(uptime / 1000),
      subscribedMarkets: Array.from(this.subscribedMarkets),
      priceCount: this.prices.size,
    };
  }
  
  /**
   * Check if connected
   * @returns {boolean} True if connected
   */
  isConnected() {
    return this.connected;
  }
}

module.exports = PythWebSocketClient;
