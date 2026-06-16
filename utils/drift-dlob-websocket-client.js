/**
 * Drift DLOB WebSocket Client
 * 
 * Real-time orderbook data client for Drift's DLOB server.
 * Reference: https://github.com/drift-labs/dlob-server/blob/master/example/wsClient.ts
 * 
 * Features:
 * - Connect to DLOB server WebSocket
 * - Subscribe to orderbook channels for perp markets
 * - Maintain best bid/ask state per market
 * - Auto-reconnect with exponential backoff
 * - Event emission for orderbook updates
 * 
 * Message Format (based on Phase 0 test):
 * - Subscribe: { type: 'subscribe', marketType: 'perp', channel: 'orderbook', market: 'SOL-PERP' }
 * - Response channel: 'orderbook_perp_{marketIndex}_grouped_1'
 * - Data field is a JSON string containing orderbook with bestBidPrice, bestAskPrice, markPrice, etc.
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

// Drift uses 6 decimal precision for prices (PRICE_PRECISION = 1e6)
const PRICE_PRECISION = 1e6;

class DriftDlobWebSocketClient extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // WebSocket configuration
    this.wsUrl = options.wsUrl || process.env.DRIFT_DLOB_WS_URL || 'wss://dlob.drift.trade/ws';
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    
    // Reconnection settings
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.maxReconnectDelay = options.maxReconnectDelay || 30000;
    this.currentReconnectDelay = this.reconnectDelay;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 100;
    this.shouldReconnect = true;
    
    // Orderbook state: market -> { bestBid, bestAsk, markPrice, lastUpdate, slot }
    this.orderbooks = new Map();
    
    // Market subscriptions
    this.subscribedMarkets = new Set();
    this.pendingSubscriptions = new Set();
    
    // Connection health
    this.lastMessageTime = null;
    this.healthCheckInterval = null;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs || 10000;
    this.staleThresholdMs = options.staleThresholdMs || 30000;
    
    // Logging
    this.debug = options.debug || false;
    this.logger = options.logger || console;
  }

  /**
   * Connect to DLOB server
   */
  connect() {
    if (this.isConnected || this.isConnecting) {
      this._log('Already connected or connecting');
      return;
    }

    this.isConnecting = true;
    this._log(`Connecting to ${this.wsUrl}...`);

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', (data) => this._onMessage(data));
      this.ws.on('close', (code, reason) => this._onClose(code, reason));
      this.ws.on('error', (error) => this._onError(error));
    } catch (error) {
      this._log(`Connection error: ${error.message}`, 'error');
      this.isConnecting = false;
      this._scheduleReconnect();
    }
  }

  /**
   * Disconnect from DLOB server
   */
  disconnect() {
    this.shouldReconnect = false;
    this._stopHealthCheck();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
    this.isConnecting = false;
    this._log('Disconnected');
  }

  /**
   * Subscribe to orderbook for a market
   * @param {string} market - Market name (e.g., 'SOL-PERP')
   * @param {string} marketType - 'perp' or 'spot' (default: 'perp')
   */
  subscribe(market, marketType = 'perp') {
    const key = `${marketType}:${market}`;
    
    if (this.subscribedMarkets.has(key)) {
      this._log(`Already subscribed to ${key}`);
      return;
    }

    if (!this.isConnected) {
      this.pendingSubscriptions.add({ market, marketType });
      this._log(`Queued subscription for ${key} (not connected)`);
      return;
    }

    this._sendSubscription(market, marketType);
  }

  /**
   * Subscribe to multiple markets
   * @param {string[]} markets - Array of market names
   * @param {string} marketType - 'perp' or 'spot'
   */
  subscribeMarkets(markets, marketType = 'perp') {
    markets.forEach(market => this.subscribe(market, marketType));
  }

  /**
   * Unsubscribe from orderbook for a market
   * @param {string} market - Market name
   * @param {string} marketType - 'perp' or 'spot'
   */
  unsubscribe(market, marketType = 'perp') {
    const key = `${marketType}:${market}`;
    
    if (!this.subscribedMarkets.has(key)) {
      return;
    }

    if (this.isConnected && this.ws) {
      const message = JSON.stringify({
        type: 'unsubscribe',
        marketType,
        channel: 'orderbook',
        market,
      });
      this.ws.send(message);
    }

    this.subscribedMarkets.delete(key);
    this.orderbooks.delete(market);
    this._log(`Unsubscribed from ${key}`);
  }

  /**
   * Get best bid/ask for a market
   * @param {string} market - Market name (e.g., 'SOL-PERP')
   * @returns {Object|null} - { bestBid, bestAsk, markPrice, spread, timestamp, slot } or null
   */
  getBestBidAsk(market) {
    const ob = this.orderbooks.get(market);
    if (!ob) return null;
    
    return {
      bestBid: ob.bestBid,
      bestAsk: ob.bestAsk,
      markPrice: ob.markPrice,
      spread: ob.bestAsk - ob.bestBid,
      spreadPercent: ob.bestAsk > 0 ? ((ob.bestAsk - ob.bestBid) / ((ob.bestBid + ob.bestAsk) / 2)) * 100 : 0,
      timestamp: ob.lastUpdate,
      slot: ob.slot,
      stale: this._isStale(ob.lastUpdate),
    };
  }

  /**
   * Get mark price for a market (constructed from BBO)
   * @param {string} market - Market name
   * @returns {number|null} - Mark price or null if unavailable
   */
  getMarkPrice(market) {
    const ob = this.orderbooks.get(market);
    if (!ob || !ob.bestBid || !ob.bestAsk) return null;
    
    // Check for stale data
    if (this._isStale(ob.lastUpdate)) {
      this._log(`Stale data for ${market} (last update: ${ob.lastUpdate})`, 'warn');
      return null;
    }
    
    // Check for crossed book
    if (ob.bestBid >= ob.bestAsk) {
      this._log(`Crossed book for ${market}: bid=${ob.bestBid}, ask=${ob.bestAsk}`, 'warn');
      return null;
    }
    
    return (ob.bestBid + ob.bestAsk) / 2;
  }

  /**
   * Get exchange mark price for a market (from DLOB data)
   * @param {string} market - Market name
   * @returns {number|null} - Exchange mark price or null if unavailable
   */
  getExchangeMarkPrice(market) {
    const ob = this.orderbooks.get(market);
    return ob?.markPrice || null;
  }

  /**
   * Get all orderbook states
   * @returns {Map} - Map of market -> orderbook state
   */
  getOrderbooks() {
    return this.orderbooks;
  }

  /**
   * Check if connected
   * @returns {boolean}
   */
  isConnectedAndHealthy() {
    return this.isConnected && !this._isConnectionStale();
  }

  // ========== PRIVATE METHODS ==========

  _onOpen() {
    this.isConnected = true;
    this.isConnecting = false;
    this.currentReconnectDelay = this.reconnectDelay;
    this.reconnectAttempts = 0;
    this.lastMessageTime = Date.now();
    
    this._log('Connected to DLOB server');
    this.emit('connected');
    
    // Process pending subscriptions
    for (const { market, marketType } of this.pendingSubscriptions) {
      this._sendSubscription(market, marketType);
    }
    this.pendingSubscriptions.clear();
    
    // Re-subscribe to previously subscribed markets after reconnect
    for (const key of this.subscribedMarkets) {
      const [marketType, market] = key.split(':');
      this._sendSubscription(market, marketType, true);
    }
    
    // Start health check
    this._startHealthCheck();
  }

  _onMessage(data) {
    this.lastMessageTime = Date.now();
    
    try {
      const message = JSON.parse(data.toString());
      
      // Handle subscription confirmation
      if (message.message && message.message.includes('Subscribe received')) {
        this._log(`Subscription confirmed: ${message.message}`, 'debug');
        return;
      }
      
      // Handle orderbook data
      // Channel format: 'orderbook_perp_{marketIndex}_grouped_1'
      if (message.channel && message.channel.startsWith('orderbook_')) {
        this._handleOrderbookMessage(message);
        return;
      }
      
      // Handle trades (if we subscribe to them in the future)
      if (message.channel && message.channel.startsWith('trades_')) {
        this._handleTradesMessage(message);
        return;
      }
      
      // Unknown message
      if (this.debug) {
        this._log(`Unknown message: ${JSON.stringify(message)}`, 'debug');
      }
    } catch (error) {
      this._log(`Message parse error: ${error.message}`, 'error');
    }
  }

  _handleOrderbookMessage(message) {
    try {
      // Data field is a JSON string
      const orderbook = typeof message.data === 'string' 
        ? JSON.parse(message.data) 
        : message.data;
      
      const market = orderbook.marketName;
      if (!market) {
        this._log('Orderbook message missing marketName', 'warn');
        return;
      }
      
      // Extract prices (they are strings in base units with 6 decimal precision)
      // Divide by PRICE_PRECISION (1e6) to get USD
      const bestBid = parseFloat(orderbook.bestBidPrice) / PRICE_PRECISION;
      const bestAsk = parseFloat(orderbook.bestAskPrice) / PRICE_PRECISION;
      const markPrice = parseFloat(orderbook.markPrice) / PRICE_PRECISION;
      const slot = orderbook.slot;
      const ts = orderbook.ts || Date.now();
      
      // Update orderbook state
      const state = {
        bestBid,
        bestAsk,
        markPrice,
        slot,
        lastUpdate: Date.now(),
        serverTs: ts,
        oracle: orderbook.oracle ? parseFloat(orderbook.oracle) / PRICE_PRECISION : null,
        oracleTwap: orderbook.oracleData?.twap ? parseFloat(orderbook.oracleData.twap) / PRICE_PRECISION : null,
      };
      
      const previousState = this.orderbooks.get(market);
      this.orderbooks.set(market, state);
      
      // Emit update event with market name and state
      this.emit('orderbook', market, state, previousState);
      
      if (this.debug) {
        this._log(`Orderbook update: ${market} bid=${bestBid} ask=${bestAsk} mark=${markPrice}`, 'debug');
      }
    } catch (error) {
      this._log(`Orderbook parse error: ${error.message}`, 'error');
    }
  }

  _handleTradesMessage(message) {
    try {
      const trades = typeof message.data === 'string'
        ? JSON.parse(message.data)
        : message.data;
      
      this.emit('trades', trades);
    } catch (error) {
      this._log(`Trades parse error: ${error.message}`, 'error');
    }
  }

  _onClose(code, reason) {
    this.isConnected = false;
    this.isConnecting = false;
    this._stopHealthCheck();
    
    this._log(`Connection closed: code=${code}, reason=${reason}`);
    this.emit('disconnected', code, reason);
    
    if (this.shouldReconnect) {
      this._scheduleReconnect();
    }
  }

  _onError(error) {
    this._log(`WebSocket error: ${error.message}`, 'error');
    this.emit('error', error);
  }

  _sendSubscription(market, marketType, isResubscribe = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this._log(`Cannot subscribe to ${market}: not connected`);
      return;
    }
    
    const message = JSON.stringify({
      type: 'subscribe',
      marketType,
      channel: 'orderbook',
      market,
    });
    
    this.ws.send(message);
    this.subscribedMarkets.add(`${marketType}:${market}`);
    
    if (!isResubscribe) {
      this._log(`Subscribed to ${marketType}:${market}`);
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._log(`Max reconnect attempts (${this.maxReconnectAttempts}) reached`, 'error');
      this.emit('maxReconnectAttemptsReached');
      return;
    }
    
    this.reconnectAttempts++;
    this._log(`Reconnecting in ${this.currentReconnectDelay}ms (attempt ${this.reconnectAttempts})...`);
    
    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, this.currentReconnectDelay);
    
    // Exponential backoff
    this.currentReconnectDelay = Math.min(
      this.currentReconnectDelay * 2,
      this.maxReconnectDelay
    );
  }

  _startHealthCheck() {
    this._stopHealthCheck();
    
    this.healthCheckInterval = setInterval(() => {
      if (this._isConnectionStale()) {
        this._log('Connection appears stale, reconnecting...', 'warn');
        this.ws?.close();
      }
    }, this.healthCheckIntervalMs);
  }

  _stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  _isStale(timestamp) {
    return (Date.now() - timestamp) > this.staleThresholdMs;
  }

  _isConnectionStale() {
    return this.lastMessageTime && (Date.now() - this.lastMessageTime) > this.staleThresholdMs;
  }

  _log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = `[DriftDlobWS ${timestamp}]`;
    
    if (level === 'error') {
      this.logger.error(`${prefix} ${message}`);
    } else if (level === 'warn') {
      this.logger.warn(`${prefix} ${message}`);
    } else if (level === 'debug' && this.debug) {
      this.logger.log(`${prefix} [DEBUG] ${message}`);
    } else if (level === 'info') {
      this.logger.log(`${prefix} ${message}`);
    }
  }
}

module.exports = DriftDlobWebSocketClient;

