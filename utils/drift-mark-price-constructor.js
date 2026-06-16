/**
 * Drift Mark Price Constructor
 * 
 * Constructs mark price from DLOB WebSocket orderbook data with:
 * - Instant mark: (bestBid + bestAsk) / 2
 * - 5-minute TWAP using time-based EMA (τ=300s)
 * - 1-hour TWAP using time-based EMA (τ=3600s)
 * - Oracle divergence guardrails (10% band around oracle 5m TWAP)
 * - Fallback chain: orderbook → lastValidMark → SDK
 * 
 * Reference: Drift protocol mark price definition
 */

const EventEmitter = require('events');

class DriftMarkPriceConstructor extends EventEmitter {
  constructor(dlobClient, options = {}) {
    super();
    
    // DLOB WebSocket client
    this.dlobClient = dlobClient;
    
    // TWAP time constants (in seconds)
    this.tau5m = options.tau5m || parseFloat(process.env.MARK_TWAP_5M_TAU) || 300;
    this.tau1h = options.tau1h || parseFloat(process.env.MARK_TWAP_1H_TAU) || 3600;
    
    // Divergence threshold (default 10%)
    this.divergenceThreshold = options.divergenceThreshold || 
      parseFloat(process.env.MARK_DIVERGENCE_THRESHOLD) || 0.10;
    
    // Staleness timeout (default 5 seconds)
    this.stalenessTimeoutMs = options.stalenessTimeoutMs || 
      parseInt(process.env.MARK_STALENESS_TIMEOUT_MS) || 5000;
    
    // State storage
    this.lastValidMark = new Map();   // market -> { price, timestamp }
    this.twaps = new Map();           // market -> { bid5m, ask5m, bid1h, ask1h, lastUpdate }
    this.oracleTwap5m = new Map();    // market -> { twap, lastUpdate }
    this.divergenceState = new Map(); // market -> { diverged, percent, frozen, timestamp }
    
    // Logging
    this.debug = options.debug || false;
    this.logger = options.logger || console;
    
    // Auto-update TWAPs on orderbook updates
    this._setupOrderbookListener();
  }

  /**
   * Get mark price for a market
   * @param {string} market - Market name (e.g., 'SOL-PERP')
   * @returns {number|null} - Mark price or null if unavailable
   */
  getMarkPrice(market) {
    // Check if frozen due to divergence
    const divergenceState = this.divergenceState.get(market);
    if (divergenceState?.frozen) {
      return this._getDivergedMarkPrice(market, divergenceState);
    }
    
    // Get BBO from DLOB client
    const bbo = this.dlobClient.getBestBidAsk(market);
    
    // Validate BBO
    if (!bbo || !bbo.bestBid || !bbo.bestAsk || bbo.bestBid <= 0 || bbo.bestAsk <= 0) {
      return this._fallbackMarkPrice(market, 'missing_bbo');
    }
    
    // Check for stale data
    if (bbo.stale) {
      return this._fallbackMarkPrice(market, 'stale');
    }
    
    // Check for crossed book
    if (bbo.bestBid >= bbo.bestAsk) {
      this._log(`Crossed book for ${market}: bid=${bbo.bestBid}, ask=${bbo.bestAsk}`, 'warn');
      return this._fallbackMarkPrice(market, 'crossed');
    }
    
    // Compute mark price
    const mark = (bbo.bestBid + bbo.bestAsk) / 2;
    
    // Check divergence if oracle TWAP available
    const diverged = this._checkDivergence(market, mark);
    if (diverged) {
      return this._getDivergedMarkPrice(market, this.divergenceState.get(market));
    }
    
    // Update last valid mark
    this.lastValidMark.set(market, { price: mark, timestamp: Date.now() });
    
    return mark;
  }

  /**
   * Get 5-minute mark TWAP for a market
   * @param {string} market - Market name
   * @returns {number|null} - 5m TWAP or null
   */
  getMarkTwap5m(market) {
    const twap = this.twaps.get(market);
    if (!twap || twap.bid5m === undefined || twap.ask5m === undefined) return null;
    return (twap.bid5m + twap.ask5m) / 2;
  }

  /**
   * Get 1-hour mark TWAP for a market
   * @param {string} market - Market name
   * @returns {number|null} - 1h TWAP or null
   */
  getMarkTwap1h(market) {
    const twap = this.twaps.get(market);
    if (!twap || twap.bid1h === undefined || twap.ask1h === undefined) return null;
    return (twap.bid1h + twap.ask1h) / 2;
  }

  /**
   * Get oracle 5-minute TWAP for a market
   * @param {string} market - Market name
   * @returns {number|null} - Oracle 5m TWAP or null
   */
  getOracleTwap5m(market) {
    const otwap = this.oracleTwap5m.get(market);
    return otwap?.twap || null;
  }

  /**
   * Update oracle price and its TWAP
   * Called externally when oracle price is fetched
   * @param {string} market - Market name
   * @param {number} oraclePrice - Oracle price
   * @param {number} timestamp - Timestamp (ms)
   */
  updateOraclePrice(market, oraclePrice, timestamp = Date.now()) {
    if (!oraclePrice || oraclePrice <= 0) return;
    
    const existing = this.oracleTwap5m.get(market);
    
    if (!existing) {
      // Initialize oracle TWAP
      this.oracleTwap5m.set(market, {
        twap: oraclePrice,
        lastUpdate: timestamp,
        currentPrice: oraclePrice,
      });
      return;
    }
    
    // Update oracle TWAP using time-based EMA
    const dt = (timestamp - existing.lastUpdate) / 1000; // seconds
    if (dt > 0) {
      const alpha = 1 - Math.exp(-dt / this.tau5m);
      existing.twap = existing.twap + alpha * (oraclePrice - existing.twap);
      existing.lastUpdate = timestamp;
      existing.currentPrice = oraclePrice;
      this.oracleTwap5m.set(market, existing);
    }
  }

  /**
   * Get divergence state for a market
   * @param {string} market - Market name
   * @returns {Object|null} - Divergence state or null
   */
  getDivergenceState(market) {
    return this.divergenceState.get(market) || null;
  }

  /**
   * Get all divergence states
   * @returns {Map} - Map of market -> divergence state
   */
  getAllDivergenceStates() {
    return this.divergenceState;
  }

  /**
   * Get price analysis for a market (for monitoring)
   * @param {string} market - Market name
   * @returns {Object} - Price analysis data
   */
  getPriceAnalysis(market) {
    const bbo = this.dlobClient.getBestBidAsk(market);
    const markTwap5m = this.getMarkTwap5m(market);
    const markTwap1h = this.getMarkTwap1h(market);
    const oracleTwap5m = this.getOracleTwap5m(market);
    const lastValidMark = this.lastValidMark.get(market);
    const divergence = this.divergenceState.get(market);
    const twapState = this.twaps.get(market);
    
    return {
      market,
      bbo: bbo ? {
        bestBid: bbo.bestBid,
        bestAsk: bbo.bestAsk,
        spread: bbo.spread,
        spreadPercent: bbo.spreadPercent,
        stale: bbo.stale,
        timestamp: bbo.timestamp,
      } : null,
      markPrice: bbo && !bbo.stale ? (bbo.bestBid + bbo.bestAsk) / 2 : null,
      markTwap5m,
      markTwap1h,
      oracleTwap5m,
      lastValidMark: lastValidMark?.price,
      lastValidMarkAge: lastValidMark ? Date.now() - lastValidMark.timestamp : null,
      divergence: divergence ? {
        percent: divergence.percent,
        frozen: divergence.frozen,
        timestamp: divergence.timestamp,
      } : null,
      twapLastUpdate: twapState?.lastUpdate,
    };
  }

  // ========== PRIVATE METHODS ==========

  _setupOrderbookListener() {
    if (!this.dlobClient) return;
    
    this.dlobClient.on('orderbook', (market, state, previousState) => {
      this._updateTwaps(market, state.bestBid, state.bestAsk, Date.now());
    });
  }

  /**
   * Update TWAPs on orderbook change
   * Uses time-based EMA: α = 1 - e^(-dt/τ)
   */
  _updateTwaps(market, bestBid, bestAsk, timestamp) {
    if (!bestBid || !bestAsk || bestBid <= 0 || bestAsk <= 0) return;
    
    const existing = this.twaps.get(market);
    
    if (!existing) {
      // Initialize TWAPs with current prices
      this.twaps.set(market, {
        bid5m: bestBid,
        ask5m: bestAsk,
        bid1h: bestBid,
        ask1h: bestAsk,
        lastUpdate: timestamp,
      });
      return;
    }
    
    const dt = (timestamp - existing.lastUpdate) / 1000; // seconds
    
    if (dt > 0) {
      // Update 5m TWAPs
      const alpha5m = 1 - Math.exp(-dt / this.tau5m);
      existing.bid5m = existing.bid5m + alpha5m * (bestBid - existing.bid5m);
      existing.ask5m = existing.ask5m + alpha5m * (bestAsk - existing.ask5m);
      
      // Update 1h TWAPs
      const alpha1h = 1 - Math.exp(-dt / this.tau1h);
      existing.bid1h = existing.bid1h + alpha1h * (bestBid - existing.bid1h);
      existing.ask1h = existing.ask1h + alpha1h * (bestAsk - existing.ask1h);
      
      existing.lastUpdate = timestamp;
      this.twaps.set(market, existing);
    }
  }

  /**
   * Check divergence between mark and oracle TWAP
   * @returns {boolean} - True if diverged beyond threshold
   */
  _checkDivergence(market, markPrice) {
    const oracleTwap = this.oracleTwap5m.get(market);
    if (!oracleTwap || !oracleTwap.twap) {
      // No oracle TWAP, can't check divergence
      return false;
    }
    
    const divergence = Math.abs(markPrice - oracleTwap.twap);
    const divergencePercent = divergence / oracleTwap.twap;
    const diverged = divergencePercent > this.divergenceThreshold;
    
    const state = {
      diverged,
      divergence,
      percent: divergencePercent * 100,
      frozen: diverged,
      timestamp: Date.now(),
      markPrice,
      oracleTwap: oracleTwap.twap,
    };
    
    // Log on state change
    const prevState = this.divergenceState.get(market);
    if (diverged && !prevState?.frozen) {
      this._log(`[Divergence] ${market}: mark=${markPrice.toFixed(4)}, oracleTwap=${oracleTwap.twap.toFixed(4)}, divergence=${(divergencePercent * 100).toFixed(2)}% FROZEN`, 'warn');
      this.emit('divergence', market, state);
    } else if (!diverged && prevState?.frozen) {
      this._log(`[Divergence] ${market}: divergence=${(divergencePercent * 100).toFixed(2)}% UNFROZEN`, 'info');
      this.emit('divergenceCleared', market, state);
    }
    
    this.divergenceState.set(market, state);
    return diverged;
  }

  /**
   * Get mark price when diverged (clamped to band edge)
   */
  _getDivergedMarkPrice(market, divergenceState) {
    const oracleTwap = this.oracleTwap5m.get(market);
    if (!oracleTwap || !oracleTwap.twap) {
      return this._fallbackMarkPrice(market, 'diverged_no_oracle');
    }
    
    // Get mark TWAP or last valid mark
    const markTwap5m = this.getMarkTwap5m(market);
    const reference = markTwap5m || this.lastValidMark.get(market)?.price;
    
    if (!reference) {
      // Can't determine direction, use oracle TWAP
      return oracleTwap.twap;
    }
    
    // Clamp to band edge
    const direction = reference > oracleTwap.twap ? 1 : -1;
    const bandEdge = oracleTwap.twap * (1 + direction * this.divergenceThreshold);
    
    this._log(`[Divergence] ${market}: clamping to band edge ${bandEdge.toFixed(4)}`, 'debug');
    return bandEdge;
  }

  /**
   * Fallback mark price when BBO unavailable
   */
  _fallbackMarkPrice(market, reason) {
    // Try last valid mark (if not too stale)
    const lastValid = this.lastValidMark.get(market);
    if (lastValid && (Date.now() - lastValid.timestamp) < this.stalenessTimeoutMs) {
      this._log(`[Fallback] ${market}: using lastValidMark (reason: ${reason})`, 'debug');
      return lastValid.price;
    }
    
    // Try 5m mark TWAP
    const markTwap = this.getMarkTwap5m(market);
    if (markTwap) {
      this._log(`[Fallback] ${market}: using markTwap5m (reason: ${reason})`, 'debug');
      return markTwap;
    }
    
    // Return null to trigger SDK fallback at caller
    this._log(`[Fallback] ${market}: no local fallback available (reason: ${reason})`, 'warn');
    return null;
  }

  _log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = `[MarkPriceConstructor ${timestamp}]`;
    
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

module.exports = DriftMarkPriceConstructor;

