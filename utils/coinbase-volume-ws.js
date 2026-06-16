/**
 * Coinbase Advanced Trade WebSocket Client for Volume Data
 * 
 * Uses Coinbase WebSocket API as primary volume data source:
 * - Candles channel: 5-minute OHLCV bars
 * - Market trades channel: Real-time trades for buy/sell volume tracking
 * 
 * Features:
 * - No authentication required for public channels
 * - Heartbeats to keep connection alive
 * - Automatic reconnection on disconnect
 * - Buy/sell volume tracking for CVD calculation
 * 
 * Reference: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

// Coinbase Advanced Trade WebSocket URL
const COINBASE_WS_URL = 'wss://advanced-trade-ws.coinbase.com';

// Map our symbols to Coinbase product IDs
const SYMBOL_TO_PRODUCT = {
  'SOL': 'SOL-USD',
  'BTC': 'BTC-USD',
  'ETH': 'ETH-USD',
};

class CoinbaseVolumeWS extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.ws = null;
    this.connected = false;
    this.subscribed = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelayMs = options.reconnectDelayMs || 5000;
    this.heartbeatInterval = null;
    this.lastHeartbeat = null;
    
    // Volume data storage (per product)
    // Stores latest 5-minute candle data
    this.candles = new Map(); // productId -> { volume, open, high, low, close, start, timestamp }
    
    // Trade volume tracking for CVD calculation
    // Accumulates buy/sell volume within current 5-minute window
    this.tradeVolume = new Map(); // productId -> { buyVolume, sellVolume, totalVolume, windowStart }
    
    // Products to subscribe to
    this.products = options.products || Object.values(SYMBOL_TO_PRODUCT);
    
    // Stats
    this.stats = {
      messagesReceived: 0,
      candleUpdates: 0,
      tradeUpdates: 0,
      reconnects: 0,
      errors: 0,
      lastError: null,
    };
  }
  
  /**
   * Connect to Coinbase WebSocket
   */
  async connect() {
    if (this.connected) {
      console.log('[CoinbaseVolumeWS] Already connected');
      return;
    }
    
    return new Promise((resolve, reject) => {
      try {
        console.log('[CoinbaseVolumeWS] Connecting to Coinbase Advanced Trade WebSocket...');
        this.ws = new WebSocket(COINBASE_WS_URL);
        
        this.ws.on('open', () => {
          console.log('[CoinbaseVolumeWS] ✅ Connected to Coinbase WebSocket');
          this.connected = true;
          this.reconnectAttempts = 0;
          this._subscribe();
          this._startHeartbeatMonitor();
          this.emit('connected');
          resolve();
        });
        
        this.ws.on('message', (data) => {
          this._handleMessage(data);
        });
        
        this.ws.on('error', (error) => {
          console.error('[CoinbaseVolumeWS] ❌ WebSocket error:', error.message);
          this.stats.errors++;
          this.stats.lastError = error.message;
          this.emit('error', error);
        });
        
        this.ws.on('close', (code, reason) => {
          console.log(`[CoinbaseVolumeWS] Connection closed: ${code} - ${reason || 'No reason'}`);
          this.connected = false;
          this.subscribed = false;
          this._stopHeartbeatMonitor();
          this.emit('disconnected', { code, reason });
          this._attemptReconnect();
        });
        
        // Connection timeout
        setTimeout(() => {
          if (!this.connected) {
            this.ws.terminate();
            reject(new Error('Connection timeout'));
          }
        }, 10000);
        
      } catch (error) {
        console.error('[CoinbaseVolumeWS] Failed to connect:', error.message);
        reject(error);
      }
    });
  }
  
  /**
   * Subscribe to channels
   */
  _subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[CoinbaseVolumeWS] Cannot subscribe - not connected');
      return;
    }
    
    // Subscribe to heartbeats (keeps connection alive)
    this._send({
      type: 'subscribe',
      channel: 'heartbeats',
    });
    
    // Subscribe to candles channel for 5-minute OHLCV
    this._send({
      type: 'subscribe',
      product_ids: this.products,
      channel: 'candles',
    });
    
    // Subscribe to market_trades for buy/sell volume tracking (CVD)
    this._send({
      type: 'subscribe',
      product_ids: this.products,
      channel: 'market_trades',
    });
    
    console.log(`[CoinbaseVolumeWS] Subscribed to candles and market_trades for: ${this.products.join(', ')}`);
    this.subscribed = true;
  }
  
  /**
   * Send message to WebSocket
   */
  _send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
  
  /**
   * Handle incoming WebSocket message
   */
  _handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      this.stats.messagesReceived++;
      
      switch (message.channel) {
        case 'heartbeats':
          this._handleHeartbeat(message);
          break;
        case 'candles':
          this._handleCandles(message);
          break;
        case 'market_trades':
          this._handleMarketTrades(message);
          break;
        default:
          // Ignore other messages (subscriptions confirmations, etc.)
          break;
      }
    } catch (error) {
      console.error('[CoinbaseVolumeWS] Failed to parse message:', error.message);
    }
  }
  
  /**
   * Handle heartbeat messages
   */
  _handleHeartbeat(message) {
    this.lastHeartbeat = Date.now();
    // Heartbeats keep connection alive - no action needed
  }
  
  /**
   * Handle candles messages (5-minute OHLCV)
   */
  _handleCandles(message) {
    if (!message.events || !Array.isArray(message.events)) return;
    
    for (const event of message.events) {
      if (!event.candles || !Array.isArray(event.candles)) continue;
      
      for (const candle of event.candles) {
        const productId = candle.product_id;
        if (!productId) continue;
        
        // Store candle data
        this.candles.set(productId, {
          open: parseFloat(candle.open),
          high: parseFloat(candle.high),
          low: parseFloat(candle.low),
          close: parseFloat(candle.close),
          volume: parseFloat(candle.volume), // Base volume
          start: parseInt(candle.start) * 1000, // Convert to ms
          timestamp: Date.now(),
          source: 'coinbase',
        });
        
        this.stats.candleUpdates++;
        this.emit('candle', { productId, candle: this.candles.get(productId) });
      }
    }
  }
  
  /**
   * Handle market trades messages (for buy/sell volume tracking)
   */
  _handleMarketTrades(message) {
    if (!message.events || !Array.isArray(message.events)) return;
    
    for (const event of message.events) {
      if (!event.trades || !Array.isArray(event.trades)) continue;
      
      for (const trade of event.trades) {
        const productId = trade.product_id;
        if (!productId) continue;
        
        const size = parseFloat(trade.size);
        const side = trade.side; // BUY or SELL (maker side)
        
        // Initialize tracking for this product if needed
        if (!this.tradeVolume.has(productId)) {
          this._resetTradeWindow(productId);
        }
        
        const volumeData = this.tradeVolume.get(productId);
        
        // Check if we need to start a new 5-minute window
        const now = Date.now();
        const windowDuration = 5 * 60 * 1000; // 5 minutes
        if (now - volumeData.windowStart >= windowDuration) {
          this._resetTradeWindow(productId);
        }
        
        // Accumulate volume
        // Note: side indicates maker side, so:
        // - BUY means taker sold (maker bought)
        // - SELL means taker bought (maker sold)
        // For CVD, we want taker buy volume
        if (side === 'SELL') {
          // Taker bought (filled a sell order)
          volumeData.buyVolume += size;
        } else {
          // Taker sold (filled a buy order)
          volumeData.sellVolume += size;
        }
        volumeData.totalVolume += size;
        volumeData.lastUpdate = now;
        
        this.stats.tradeUpdates++;
      }
    }
  }
  
  /**
   * Reset trade volume window for a product
   */
  _resetTradeWindow(productId) {
    const now = Date.now();
    const windowStart = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
    
    this.tradeVolume.set(productId, {
      buyVolume: 0,
      sellVolume: 0,
      totalVolume: 0,
      windowStart,
      lastUpdate: now,
    });
  }
  
  /**
   * Start heartbeat monitor
   */
  _startHeartbeatMonitor() {
    this._stopHeartbeatMonitor();
    
    // Check for heartbeats every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.lastHeartbeat && Date.now() - this.lastHeartbeat > 60000) {
        console.warn('[CoinbaseVolumeWS] No heartbeat for 60s, reconnecting...');
        this.ws?.terminate();
      }
    }, 30000);
  }
  
  /**
   * Stop heartbeat monitor
   */
  _stopHeartbeatMonitor() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  /**
   * Attempt to reconnect
   */
  _attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[CoinbaseVolumeWS] Max reconnect attempts reached, giving up');
      this.emit('maxReconnectAttemptsReached');
      return;
    }
    
    this.reconnectAttempts++;
    this.stats.reconnects++;
    
    const delay = this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1);
    console.log(`[CoinbaseVolumeWS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      this.connect().catch(err => {
        console.error('[CoinbaseVolumeWS] Reconnect failed:', err.message);
      });
    }, delay);
  }
  
  /**
   * Get latest volume data for a symbol
   * @param {string} symbol - Symbol (SOL, BTC, ETH)
   * @returns {Object|null} Volume data or null if not available
   */
  getVolume(symbol) {
    const productId = SYMBOL_TO_PRODUCT[symbol.toUpperCase()];
    if (!productId) return null;
    
    const candle = this.candles.get(productId);
    const tradeVol = this.tradeVolume.get(productId);
    
    if (!candle) return null;
    
    // Check if data is stale (older than 2 minutes)
    const isStale = Date.now() - candle.timestamp > 120000;
    
    return {
      baseVolume: candle.volume,
      quoteVolume: candle.volume * candle.close, // Approximate
      takerBuyBaseVolume: tradeVol?.buyVolume || 0,
      takerSellBaseVolume: tradeVol?.sellVolume || 0,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      timestamp: candle.timestamp,
      windowStart: candle.start,
      source: 'coinbase',
      isStale,
      meta: {
        source: isStale ? 'coinbase_stale' : 'coinbase_live',
        productId,
        lastUpdate: candle.timestamp,
        tradeWindowStart: tradeVol?.windowStart,
      },
    };
  }
  
  /**
   * Check if connected and receiving data
   */
  isHealthy() {
    if (!this.connected) return false;
    if (!this.lastHeartbeat) return false;
    if (Date.now() - this.lastHeartbeat > 60000) return false;
    return true;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      connected: this.connected,
      subscribed: this.subscribed,
      productsTracked: this.candles.size,
      lastHeartbeat: this.lastHeartbeat ? new Date(this.lastHeartbeat).toISOString() : null,
      isHealthy: this.isHealthy(),
    };
  }
  
  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    console.log('[CoinbaseVolumeWS] Disconnecting...');
    this._stopHeartbeatMonitor();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this.connected = false;
    this.subscribed = false;
  }
}

// Singleton instance
let instance = null;

/**
 * Get singleton instance
 */
function getInstance(options = {}) {
  if (!instance) {
    instance = new CoinbaseVolumeWS(options);
  }
  return instance;
}

module.exports = {
  CoinbaseVolumeWS,
  getInstance,
  SYMBOL_TO_PRODUCT,
};
