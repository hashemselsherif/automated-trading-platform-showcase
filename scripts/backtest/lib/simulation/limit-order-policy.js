/**
 * Limit Order Execution Policy Simulator
 * 
 * Simulates limit order execution for backtesting maker strategies on Drift.
 * Models the state machine: IDLE → WORKING_ENTRY → FILLED → OPEN → WORKING_EXIT → CLOSED
 * 
 * Features:
 * - Fill probability based on price distance from limit
 * - Replace cadence and max replaces
 * - Timeout handling
 * - Partial fills
 * - Fallback to taker logic
 * - Signal cancellation
 */

/**
 * Order states in the execution lifecycle
 */
const OrderState = {
  IDLE: 'IDLE',
  WORKING_ENTRY: 'WORKING_ENTRY',
  REPLACING: 'REPLACING',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  FALLBACK_TAKER: 'FALLBACK_TAKER',
  OPEN: 'OPEN',
  WORKING_EXIT: 'WORKING_EXIT',
  CLOSED: 'CLOSED',
};

/**
 * Default policy configuration
 */
const DEFAULT_POLICY = {
  // Price selection
  refPriceSource: 'oracle',     // 'mid', 'mark', 'oracle', 'last'
  entryOffsetBps: 10,           // How far from ref price to place entry limit
  exitOffsetBps: 10,            // For limit exits (lower = more aggressive)
  postOnly: true,               // Enforce post-only
  
  // Lifecycle
  entryTimeoutMs: 60000,        // Max time to wait for entry fill
  exitTimeoutMs: 30000,         // Max time to wait for exit fill
  openOrderAppearMs: 15000,     // Grace period for order to appear on-chain
  replaceEveryMs: 15000,        // Replace cadence
  maxReplaces: 3,               // Max replace attempts
  cancelIfSignalInvalid: true,  // Cancel if signal flips
  signalGraceTicks: 0,          // Debounce before cancellation
  
  // Fallback to taker (ENTRY)
  fallbackToTaker: true,        // Enable fallback for entries (default true for backtesting)
  fallbackAfterMs: 45000,       // When to trigger fallback
  fallbackConfirmMs: 15000,     // Grace window to wait for taker confirmation
  fallbackMinConfidence: 0.7,   // Min signal confidence
  fallbackMaxSlippageBps: 30,   // Max slippage for fallback
  
  // Exit-specific settings (more aggressive than entry)
  exitAsMaker: true,            // Enable maker mode for exits
  exitFallbackImmediate: true,  // Fall back to taker immediately on timeout
  exitMaxSlippageBps: 50,       // Max slippage for exit taker fallback
  exitReplaceEveryMs: 10000,    // Replace cadence for exits (faster than entries)
  exitMaxReplaces: 1,           // Fewer replaces for exits (prioritize speed)
  
  // Partial fills
  allowPartial: false,          // Enable partial fill handling
  partialMinFillPct: 25,        // Min fill % to treat as opened
  
  // Fill simulation parameters
  fillProbabilityModel: 'exponential', // 'exponential', 'linear', 'fixed'
  baseFillProbability: 0.3,     // Base probability per tick when at limit price
  fillDecayPerBps: 0.05,        // Probability decay per bps away from market
  volatilityFillBoost: 1.0,     // Multiplier based on volatility (1.0 = no boost)
};

/**
 * Limit Order Policy Simulator
 */
class LimitOrderPolicySimulator {
  constructor(policy = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.reset();
  }

  /**
   * Reset simulator state
   */
  reset() {
    this.state = OrderState.IDLE;
    this.workingOrder = null;
    this.position = null;
    this.stats = {
      ordersPlaced: 0,
      ordersFilled: 0,
      ordersReplaced: 0,
      ordersCancelled: 0,
      ordersTimedOut: 0,
      fallbacksToTaker: 0,
      partialFills: 0,
      makerFills: 0,
      takerFills: 0,
      totalWaitTimeMs: 0,
      avgFillTimeMs: 0,
    };
  }

  /**
   * Get current state
   */
  getState() {
    return {
      state: this.state,
      workingOrder: this.workingOrder,
      position: this.position,
      stats: { ...this.stats },
    };
  }

  /**
   * Calculate limit price from reference price
   * @param {number} refPrice - Reference price
   * @param {string} side - 'long' or 'short'
   * @param {string} type - 'entry' or 'exit'
   * @returns {number} Limit price
   * 
   * Offset interpretation:
   * - Positive offset: Place limit in our favor (better price, lower fill prob)
   * - Negative offset: Place limit against us (worse price, higher fill prob)
   * 
   * For entries (positive offset = patient):
   *   Long:  limit = market - offset (buy below market)
   *   Short: limit = market + offset (sell above market)
   * 
   * For exits (negative offset = aggressive, ensure fills):
   *   Long exit (sell):  limit = market - |offset| (sell slightly below market)
   *   Short exit (buy):  limit = market + |offset| (buy slightly above market)
   */
  calculateLimitPrice(refPrice, side, type = 'entry') {
    const offsetBps = type === 'entry' ? this.policy.entryOffsetBps : this.policy.exitOffsetBps;
    const offsetMultiplier = offsetBps / 10000;
    
    if (type === 'entry') {
      // For entry: longs buy below market, shorts sell above market
      // Positive offset = better price for us
      return side === 'long' 
        ? refPrice * (1 - offsetMultiplier)
        : refPrice * (1 + offsetMultiplier);
    } else {
      // For exit: Apply offset in the direction that favors fills
      // Positive offset: wait for better price (sell higher / buy lower)
      // Negative offset: accept worse price for faster fill (sell lower / buy higher)
      return side === 'long'
        ? refPrice * (1 + offsetMultiplier)  // Sell: +offset = higher, -offset = lower
        : refPrice * (1 - offsetMultiplier); // Buy: -offset = higher (worse for us but fills faster)
    }
  }

  /**
   * Calculate fill probability based on market conditions
   * @param {number} limitPrice - Limit order price
   * @param {number} marketPrice - Current market price
   * @param {string} side - 'long' or 'short'
   * @param {Object} conditions - Market conditions { volatility, volume, spread }
   * @returns {number} Fill probability (0-1)
   */
  calculateFillProbability(limitPrice, marketPrice, side, conditions = {}) {
    const { volatility = 0.01, volume = 1.0, spread = 0 } = conditions;
    
    // Calculate distance from market in bps
    const distanceBps = Math.abs(limitPrice - marketPrice) / marketPrice * 10000;
    
    // Check if limit price is "in the money"
    const isInMoney = side === 'long' 
      ? limitPrice >= marketPrice  // Long limit at or above market = immediate fill
      : limitPrice <= marketPrice; // Short limit at or below market = immediate fill
    
    if (isInMoney) {
      // Would fill as taker (or very quickly as maker)
      return 0.95;
    }
    
    // Apply fill probability model
    let probability = this.policy.baseFillProbability;
    
    switch (this.policy.fillProbabilityModel) {
      case 'exponential':
        // Probability decays exponentially with distance
        probability *= Math.exp(-distanceBps * this.policy.fillDecayPerBps);
        break;
        
      case 'linear':
        // Probability decays linearly
        probability *= Math.max(0, 1 - distanceBps * this.policy.fillDecayPerBps);
        break;
        
      case 'fixed':
      default:
        // Fixed probability regardless of distance
        break;
    }
    
    // Apply volatility boost (higher volatility = more fills)
    probability *= (1 + (volatility - 0.01) * this.policy.volatilityFillBoost * 10);
    
    // Apply volume factor
    probability *= Math.min(1.5, 0.5 + volume * 0.5);
    
    // Clamp to valid range
    return Math.max(0, Math.min(1, probability));
  }

  /**
   * Attempt to place an entry order
   * @param {Object} signal - Trading signal { side, price, confidence, timestamp }
   * @param {number} sizeUsd - Position size in USD
   * @returns {Object} Order result { success, order, reason }
   */
  placeEntryOrder(signal, sizeUsd) {
    if (this.state !== OrderState.IDLE) {
      return { success: false, reason: `Cannot place entry from state: ${this.state}` };
    }

    const limitPrice = this.calculateLimitPrice(signal.price, signal.side, 'entry');
    
    this.workingOrder = {
      type: 'entry',
      side: signal.side,
      limitPrice,
      sizeUsd,
      originalSignal: signal,
      placedAt: signal.timestamp,
      replaceCount: 0,
      filledQty: 0,
      lastReplaceAt: signal.timestamp,
    };
    
    this.state = OrderState.WORKING_ENTRY;
    this.stats.ordersPlaced++;
    
    return { 
      success: true, 
      order: { ...this.workingOrder },
      limitPrice,
    };
  }

  /**
   * Process a tick update for working order
   * @param {Object} tick - Market tick { price, timestamp, high, low, volume, volatility }
   * @param {Object} currentSignal - Current signal state (null if signal invalid)
   * @returns {Object} Tick result { event, order, position, fees }
   */
  processTick(tick, currentSignal = null) {
    const result = {
      event: null,
      order: null,
      position: null,
      fees: null,
      execMode: 'maker',
    };

    if (this.state === OrderState.IDLE || this.state === OrderState.CLOSED) {
      return result;
    }

    // Handle working entry
    if (this.state === OrderState.WORKING_ENTRY || this.state === OrderState.REPLACING) {
      return this._processWorkingEntry(tick, currentSignal);
    }

    // Handle open position waiting for exit
    if (this.state === OrderState.OPEN) {
      return result; // Position is open, waiting for exit signal
    }

    // Handle working exit
    if (this.state === OrderState.WORKING_EXIT) {
      return this._processWorkingExit(tick, currentSignal);
    }

    return result;
  }

  /**
   * Process working entry order
   */
  _processWorkingEntry(tick, currentSignal) {
    const result = {
      event: null,
      order: null,
      position: null,
      fees: null,
      execMode: 'maker',
    };

    const order = this.workingOrder;
    const elapsed = tick.timestamp - order.placedAt;
    const sinceLastReplace = tick.timestamp - order.lastReplaceAt;

    // 1. Check for signal invalidation
    if (this.policy.cancelIfSignalInvalid && !currentSignal) {
      this.state = OrderState.CANCELLED;
      this.stats.ordersCancelled++;
      result.event = 'cancelled';
      result.order = { ...order, cancelReason: 'signal_invalid' };
      this.workingOrder = null;
      return result;
    }

    // 2. Check for timeout
    if (elapsed >= this.policy.entryTimeoutMs) {
      // Check if fallback to taker is enabled
      if (this.policy.fallbackToTaker && 
          elapsed >= this.policy.fallbackAfterMs &&
          (currentSignal?.confidence || 0) >= this.policy.fallbackMinConfidence) {
        return this._executeFallbackTaker(tick, order);
      }
      
      this.state = OrderState.CANCELLED;
      this.stats.ordersTimedOut++;
      result.event = 'timeout';
      result.order = { ...order, cancelReason: 'timeout' };
      this.workingOrder = null;
      return result;
    }

    // 3. Check for replace
    if (sinceLastReplace >= this.policy.replaceEveryMs && 
        order.replaceCount < this.policy.maxReplaces) {
      // Replace with new price
      const newLimitPrice = this.calculateLimitPrice(tick.price, order.side, 'entry');
      order.limitPrice = newLimitPrice;
      order.replaceCount++;
      order.lastReplaceAt = tick.timestamp;
      this.state = OrderState.WORKING_ENTRY;
      this.stats.ordersReplaced++;
      result.event = 'replaced';
      result.order = { ...order };
      return result;
    }

    // 4. Check for fill
    const fillProb = this.calculateFillProbability(
      order.limitPrice,
      tick.price,
      order.side,
      { volatility: tick.volatility, volume: tick.volume }
    );

    // Check if price crossed through limit (guaranteed fill)
    const priceCrossed = order.side === 'long'
      ? tick.low <= order.limitPrice
      : tick.high >= order.limitPrice;

    if (priceCrossed || Math.random() < fillProb) {
      // Filled as maker
      const fillPrice = priceCrossed ? order.limitPrice : tick.price;
      const waitTime = tick.timestamp - order.placedAt;
      
      this.position = {
        side: order.side,
        entryPrice: fillPrice,
        sizeUsd: order.sizeUsd,
        openedAt: tick.timestamp,
        execMode: 'maker',
        signal: order.originalSignal,
      };
      
      this.state = OrderState.OPEN;
      this.stats.ordersFilled++;
      this.stats.makerFills++;
      this.stats.totalWaitTimeMs += waitTime;
      this.stats.avgFillTimeMs = this.stats.totalWaitTimeMs / this.stats.ordersFilled;
      
      result.event = 'filled';
      result.order = { ...order, filledAt: tick.timestamp, fillPrice };
      result.position = { ...this.position };
      result.execMode = 'maker';
      
      this.workingOrder = null;
      return result;
    }

    // Still working
    result.event = 'working';
    result.order = { ...order };
    return result;
  }

  /**
   * Execute fallback to taker order
   */
  _executeFallbackTaker(tick, order) {
    const result = {
      event: 'fallback_taker',
      order: null,
      position: null,
      fees: null,
      execMode: 'taker',
    };

    // Check slippage
    const slippageBps = Math.abs(tick.price - order.limitPrice) / order.limitPrice * 10000;
    
    if (slippageBps > this.policy.fallbackMaxSlippageBps) {
      // Slippage too high, cancel instead
      this.state = OrderState.CANCELLED;
      this.stats.ordersCancelled++;
      result.event = 'cancelled';
      result.order = { ...order, cancelReason: 'slippage_exceeded' };
      this.workingOrder = null;
      return result;
    }

    // Execute as taker
    const waitTime = tick.timestamp - order.placedAt;
    
    this.position = {
      side: order.side,
      entryPrice: tick.price,
      sizeUsd: order.sizeUsd,
      openedAt: tick.timestamp,
      execMode: 'taker',
      signal: order.originalSignal,
    };
    
    this.state = OrderState.OPEN;
    this.stats.ordersFilled++;
    this.stats.takerFills++;
    this.stats.fallbacksToTaker++;
    this.stats.totalWaitTimeMs += waitTime;
    this.stats.avgFillTimeMs = this.stats.totalWaitTimeMs / this.stats.ordersFilled;
    
    result.order = { ...order, filledAt: tick.timestamp, fillPrice: tick.price };
    result.position = { ...this.position };
    
    this.workingOrder = null;
    return result;
  }

  /**
   * Place exit order for open position
   * @param {number} currentPrice - Current market price
   * @param {number} timestamp - Current timestamp
   * @returns {Object} Order result
   */
  placeExitOrder(currentPrice, timestamp) {
    if (this.state !== OrderState.OPEN || !this.position) {
      return { success: false, reason: `Cannot place exit from state: ${this.state}` };
    }

    const limitPrice = this.calculateLimitPrice(currentPrice, this.position.side, 'exit');
    
    this.workingOrder = {
      type: 'exit',
      side: this.position.side === 'long' ? 'short' : 'long', // Opposite side
      limitPrice,
      sizeUsd: this.position.sizeUsd,
      placedAt: timestamp,
      replaceCount: 0,
      filledQty: 0,
      lastReplaceAt: timestamp,
    };
    
    this.state = OrderState.WORKING_EXIT;
    this.stats.ordersPlaced++;
    
    return { success: true, order: { ...this.workingOrder } };
  }

  /**
   * Process working exit order
   * Uses exit-specific settings for more aggressive fills
   */
  _processWorkingExit(tick, currentSignal) {
    const result = {
      event: null,
      order: null,
      position: null,
      fees: null,
      execMode: 'maker',
    };

    const order = this.workingOrder;
    const elapsed = tick.timestamp - order.placedAt;
    const sinceLastReplace = tick.timestamp - order.lastReplaceAt;

    // Use exit-specific settings (fallback to regular settings)
    const exitReplaceEveryMs = this.policy.exitReplaceEveryMs ?? this.policy.replaceEveryMs;
    const exitMaxReplaces = this.policy.exitMaxReplaces ?? this.policy.maxReplaces;
    const exitMaxSlippageBps = this.policy.exitMaxSlippageBps ?? this.policy.fallbackMaxSlippageBps;

    // 1. Check for timeout → immediate taker fallback for exits
    if (elapsed >= this.policy.exitTimeoutMs) {
      // For exits, we always force close on timeout (prioritize closing position)
      return this._forceMarketClose(tick, order, exitMaxSlippageBps);
    }

    // 2. Check for replace (use exit-specific cadence)
    if (sinceLastReplace >= exitReplaceEveryMs && 
        order.replaceCount < exitMaxReplaces) {
      const newLimitPrice = this.calculateLimitPrice(tick.price, this.position.side, 'exit');
      order.limitPrice = newLimitPrice;
      order.replaceCount++;
      order.lastReplaceAt = tick.timestamp;
      this.stats.ordersReplaced++;
      result.event = 'replaced';
      result.order = { ...order };
      return result;
    }

    // 3. Check for fill (exits have higher fill probability due to urgency)
    // Boost fill probability for exits - we're more willing to trade at market
    const fillProb = this.calculateFillProbability(
      order.limitPrice,
      tick.price,
      order.side,
      { volatility: tick.volatility, volume: tick.volume }
    ) * 1.2; // 20% boost for exit fills

    const priceCrossed = order.side === 'long'
      ? tick.low <= order.limitPrice
      : tick.high >= order.limitPrice;

    if (priceCrossed || Math.random() < fillProb) {
      const fillPrice = priceCrossed ? order.limitPrice : tick.price;
      
      const closedPosition = {
        ...this.position,
        exitPrice: fillPrice,
        closedAt: tick.timestamp,
        exitExecMode: 'maker',
        pnl: this._calculatePnl(this.position.entryPrice, fillPrice, this.position.side, this.position.sizeUsd),
      };
      
      this.state = OrderState.CLOSED;
      this.stats.ordersFilled++;
      this.stats.makerFills++;
      
      result.event = 'closed';
      result.order = { ...order, filledAt: tick.timestamp, fillPrice };
      result.position = closedPosition;
      result.execMode = 'maker';
      
      this.position = null;
      this.workingOrder = null;
      return result;
    }

    result.event = 'working';
    result.order = { ...order };
    return result;
  }

  /**
   * Force market close (taker exit on timeout)
   * @param {Object} tick - Market tick
   * @param {Object} order - Working order
   * @param {number} maxSlippageBps - Max allowed slippage (optional, for validation only)
   */
  _forceMarketClose(tick, order, maxSlippageBps = 50) {
    // Calculate actual slippage from limit price
    const slippageBps = Math.abs(tick.price - order.limitPrice) / order.limitPrice * 10000;
    
    // For exits, we always close even with slippage (can't leave positions open)
    // Just track the slippage for analytics
    const closedPosition = {
      ...this.position,
      exitPrice: tick.price,
      closedAt: tick.timestamp,
      exitExecMode: 'taker',
      exitSlippageBps: slippageBps,
      exitSlippageExceeded: slippageBps > maxSlippageBps,
      pnl: this._calculatePnl(this.position.entryPrice, tick.price, this.position.side, this.position.sizeUsd),
    };
    
    this.state = OrderState.CLOSED;
    this.stats.ordersFilled++;
    this.stats.takerFills++;
    this.stats.fallbacksToTaker++;
    
    const result = {
      event: 'force_closed',
      order: { ...order, filledAt: tick.timestamp, fillPrice: tick.price, slippageBps },
      position: closedPosition,
      execMode: 'taker',
    };
    
    this.position = null;
    this.workingOrder = null;
    return result;
  }

  /**
   * Calculate P&L
   */
  _calculatePnl(entryPrice, exitPrice, side, sizeUsd) {
    const priceChange = (exitPrice - entryPrice) / entryPrice;
    const direction = side === 'long' ? 1 : -1;
    return sizeUsd * priceChange * direction;
  }

  /**
   * Reset to idle state (e.g., after position closed)
   */
  toIdle() {
    this.state = OrderState.IDLE;
    this.workingOrder = null;
    this.position = null;
  }
}

module.exports = {
  OrderState,
  DEFAULT_POLICY,
  LimitOrderPolicySimulator,
};
