/**
 * Limited Live Mode Controller
 * 
 * Enables gradual rollout of Drift trading with safety controls:
 * - Strict per-market position caps
 * - Rollback gates for automatic fallback to Jupiter
 * - Monitoring integration
 * - Progressive market enablement
 */

const EventEmitter = require('events');
const driftLookup = require('./drift-market-lookup');

// Live mode states
const LiveState = {
  DISABLED: 'disabled',
  SHADOW_ONLY: 'shadow_only',
  LIMITED_LIVE: 'limited_live',
  FULL_LIVE: 'full_live',
};

class LimitedLiveController extends EventEmitter {
  constructor(config = {}) {
    super();
    
    // Current state
    this.state = config.initialState ?? LiveState.SHADOW_ONLY;
    
    // Enabled markets for live trading
    this.enabledMarkets = new Set(config.enabledMarkets ?? []);
    
    // Position caps per market (USD)
    this.positionCaps = {
      default: config.defaultPositionCap ?? 100, // $100 default
      perMarket: config.perMarketCaps ?? {},
    };
    
    // Total exposure cap for Drift
    this.totalExposureCap = config.totalExposureCap ?? 500; // $500 default
    
    // Current exposure tracking
    this.currentExposure = {
      total: 0,
      byMarket: {},
    };
    
    // Rollback gates
    this.rollbackGates = {
      maxLossPerTrade: config.maxLossPerTrade ?? 25, // $25
      maxLossPerDay: config.maxLossPerDay ?? 100,    // $100
      maxConsecutiveLosses: config.maxConsecutiveLosses ?? 3,
      maxSlippageBps: config.maxSlippageBps ?? 50,
      enabled: config.rollbackEnabled ?? true,
    };
    
    // Rollback tracking
    this.rollbackMetrics = {
      dailyLoss: 0,
      dailyLossResetAt: Date.now(),
      consecutiveLosses: 0,
      rollbackTriggered: false,
      rollbackReason: null,
      rollbackAt: null,
    };
    
    // Trade history for monitoring
    this.tradeHistory = [];
    this.maxHistoryLength = 1000;
    
    // Monitoring callbacks
    this.onRollback = config.onRollback ?? null;
    this.onMarketEnabled = config.onMarketEnabled ?? null;
  }

  /**
   * Initialize from environment variables
   */
  static fromEnv() {
    const rawMarkets = process.env.DRIFT_ENABLED_MARKETS || '';
    const enabledMarkets = rawMarkets ? rawMarkets.split(',').map(m => m.trim()) : [];
    
    console.log(`[LimitedLive] Loading from env: DRIFT_ENABLED_MARKETS="${rawMarkets}"`);
    console.log(`[LimitedLive] Parsed enabled markets: [${enabledMarkets.join(', ')}]`);
    
    const config = {
      initialState: process.env.DRIFT_LIVE_STATE ?? LiveState.SHADOW_ONLY,
      enabledMarkets,
      defaultPositionCap: parseFloat(process.env.DRIFT_DEFAULT_POSITION_CAP ?? '100'),
      totalExposureCap: parseFloat(process.env.DRIFT_TOTAL_EXPOSURE_CAP ?? '500'),
      maxLossPerTrade: parseFloat(process.env.DRIFT_MAX_LOSS_PER_TRADE ?? '25'),
      maxLossPerDay: parseFloat(process.env.DRIFT_MAX_LOSS_PER_DAY ?? '100'),
      maxConsecutiveLosses: parseInt(process.env.DRIFT_MAX_CONSECUTIVE_LOSSES ?? '3'),
      rollbackEnabled: process.env.DRIFT_ROLLBACK_ENABLED !== 'false',
    };
    
    return new LimitedLiveController(config);
  }

  /**
   * Check if live trading is allowed for a market
   */
  canTradeLive(market) {
    // Check state
    if (this.state === LiveState.DISABLED || this.state === LiveState.SHADOW_ONLY) {
      return { allowed: false, reason: `State is ${this.state}` };
    }
    
    // Check rollback
    if (this.rollbackMetrics.rollbackTriggered) {
      return { allowed: false, reason: `Rollback triggered: ${this.rollbackMetrics.rollbackReason}` };
    }
    
    // Check if market is enabled
    if (this.state === LiveState.LIMITED_LIVE && !this.enabledMarkets.has(market)) {
      console.log(`[LimitedLive] Market check FAILED: "${market}" not in enabled set: [${[...this.enabledMarkets].join(', ')}]`);
      return { allowed: false, reason: `Market ${market} not in enabled list` };
    }
    
    return { allowed: true };
  }

  /**
   * Check if a position can be opened (size limits)
   */
  canOpenPosition(market, sizeUsd) {
    const canTrade = this.canTradeLive(market);
    if (!canTrade.allowed) return canTrade;
    
    // Check per-market cap (applies in both LIMITED_LIVE and FULL_LIVE)
    const marketCap = this.positionCaps.perMarket[market] ?? this.positionCaps.default;
    const currentMarketExposure = this.currentExposure.byMarket[market] ?? 0;
    
    if (currentMarketExposure + sizeUsd > marketCap) {
      return {
        allowed: false,
        reason: `Would exceed market cap: ${currentMarketExposure + sizeUsd} > ${marketCap}`,
        cap: marketCap,
        current: currentMarketExposure,
      };
    }
    
    // Check total exposure cap (only for LIMITED_LIVE, skipped in FULL_LIVE)
    if (this.state !== LiveState.FULL_LIVE) {
      if (this.currentExposure.total + sizeUsd > this.totalExposureCap) {
        return {
          allowed: false,
          reason: `Would exceed total cap: ${this.currentExposure.total + sizeUsd} > ${this.totalExposureCap}`,
          cap: this.totalExposureCap,
          current: this.currentExposure.total,
        };
      }
    }
    
    return {
      allowed: true,
      remainingMarketCap: marketCap - currentMarketExposure,
      remainingTotalCap: this.state === LiveState.FULL_LIVE ? Infinity : this.totalExposureCap - this.currentExposure.total,
    };
  }

  /**
   * Record a position opened
   */
  recordPositionOpened(market, sizeUsd) {
    this.currentExposure.total += sizeUsd;
    this.currentExposure.byMarket[market] = (this.currentExposure.byMarket[market] ?? 0) + sizeUsd;
    
    this.emit('positionOpened', { market, sizeUsd, exposure: this.currentExposure });
  }

  /**
   * Record a position closed and check rollback gates
   */
  recordPositionClosed(market, sizeUsd, pnl) {
    // Update exposure
    this.currentExposure.total = Math.max(0, this.currentExposure.total - sizeUsd);
    this.currentExposure.byMarket[market] = Math.max(0, (this.currentExposure.byMarket[market] ?? 0) - sizeUsd);
    
    // Record trade
    const trade = {
      timestamp: Date.now(),
      market,
      sizeUsd,
      pnl,
      isLoss: pnl < 0,
    };
    
    this.tradeHistory.push(trade);
    if (this.tradeHistory.length > this.maxHistoryLength) {
      this.tradeHistory.shift();
    }
    
    // Check rollback gates
    if (this.rollbackGates.enabled) {
      this._checkRollbackGates(trade);
    }
    
    this.emit('positionClosed', { market, sizeUsd, pnl, exposure: this.currentExposure });
  }

  /**
   * Enable a market for live trading
   */
  enableMarket(market) {
    // Validate market exists
    const marketInfo = driftLookup.getMarketInfo(market);
    if (!marketInfo) {
      throw new Error(`Unknown market: ${market}`);
    }
    
    if (!marketInfo.tradeable) {
      throw new Error(`Market ${market} is not tradeable`);
    }
    
    this.enabledMarkets.add(market);
    console.log(`[LimitedLive] Enabled market: ${market}`);
    
    if (this.onMarketEnabled) {
      this.onMarketEnabled(market);
    }
    
    this.emit('marketEnabled', { market, enabledCount: this.enabledMarkets.size });
  }

  /**
   * Disable a market
   */
  disableMarket(market) {
    this.enabledMarkets.delete(market);
    console.log(`[LimitedLive] Disabled market: ${market}`);
    this.emit('marketDisabled', { market });
  }

  /**
   * Set position cap for a market
   */
  setMarketCap(market, capUsd) {
    this.positionCaps.perMarket[market] = capUsd;
    console.log(`[LimitedLive] Set ${market} cap to $${capUsd}`);
  }

  /**
   * Transition state
   */
  setState(newState) {
    const oldState = this.state;
    this.state = newState;
    console.log(`[LimitedLive] State: ${oldState} → ${newState}`);
    this.emit('stateChange', { oldState, newState });
    
    // Reset rollback on state change
    if (newState !== LiveState.DISABLED) {
      this._resetRollback();
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      state: this.state,
      enabledMarkets: [...this.enabledMarkets],
      currentExposure: this.currentExposure,
      positionCaps: this.positionCaps,
      totalExposureCap: this.totalExposureCap,
      rollbackGates: this.rollbackGates,
      rollbackMetrics: this.rollbackMetrics,
      recentTrades: this.tradeHistory.slice(-10),
    };
  }

  /**
   * Progressive rollout: increase caps after successful trading
   */
  progressiveIncrease(multiplier = 1.5) {
    if (this.rollbackMetrics.rollbackTriggered) {
      console.log('[LimitedLive] Cannot increase - rollback is active');
      return false;
    }
    
    // Increase caps
    this.positionCaps.default *= multiplier;
    this.totalExposureCap *= multiplier;
    
    for (const market of Object.keys(this.positionCaps.perMarket)) {
      this.positionCaps.perMarket[market] *= multiplier;
    }
    
    console.log(`[LimitedLive] Progressive increase ${multiplier}x - new default cap: $${this.positionCaps.default}`);
    this.emit('capsIncreased', { multiplier, newDefaultCap: this.positionCaps.default });
    
    return true;
  }

  // Private methods

  _checkRollbackGates(trade) {
    // Reset daily loss if new day
    const now = Date.now();
    if (now - this.rollbackMetrics.dailyLossResetAt > 24 * 60 * 60 * 1000) {
      this.rollbackMetrics.dailyLoss = 0;
      this.rollbackMetrics.dailyLossResetAt = now;
    }
    
    if (trade.isLoss) {
      const loss = Math.abs(trade.pnl);
      
      // Check per-trade loss
      if (loss > this.rollbackGates.maxLossPerTrade) {
        this._triggerRollback(`Single trade loss ($${loss.toFixed(2)}) exceeded max ($${this.rollbackGates.maxLossPerTrade})`);
        return;
      }
      
      // Update daily loss
      this.rollbackMetrics.dailyLoss += loss;
      if (this.rollbackMetrics.dailyLoss > this.rollbackGates.maxLossPerDay) {
        this._triggerRollback(`Daily loss ($${this.rollbackMetrics.dailyLoss.toFixed(2)}) exceeded max ($${this.rollbackGates.maxLossPerDay})`);
        return;
      }
      
      // Track consecutive losses
      this.rollbackMetrics.consecutiveLosses++;
      if (this.rollbackMetrics.consecutiveLosses >= this.rollbackGates.maxConsecutiveLosses) {
        this._triggerRollback(`${this.rollbackMetrics.consecutiveLosses} consecutive losses`);
        return;
      }
    } else {
      // Reset consecutive losses on win
      this.rollbackMetrics.consecutiveLosses = 0;
    }
  }

  _triggerRollback(reason) {
    console.log(`[LimitedLive] ⚠️ ROLLBACK TRIGGERED: ${reason}`);
    
    this.rollbackMetrics.rollbackTriggered = true;
    this.rollbackMetrics.rollbackReason = reason;
    this.rollbackMetrics.rollbackAt = Date.now();
    
    // Switch to shadow mode
    this.state = LiveState.SHADOW_ONLY;
    
    if (this.onRollback) {
      this.onRollback(reason);
    }
    
    this.emit('rollback', {
      reason,
      metrics: { ...this.rollbackMetrics },
      exposure: { ...this.currentExposure },
    });
  }

  _resetRollback() {
    this.rollbackMetrics.rollbackTriggered = false;
    this.rollbackMetrics.rollbackReason = null;
    this.rollbackMetrics.rollbackAt = null;
    this.rollbackMetrics.consecutiveLosses = 0;
    this.rollbackMetrics.dailyLoss = 0;
    this.rollbackMetrics.dailyLossResetAt = Date.now();
  }
}

// Singleton instance
let instance = null;

function getLimitedLiveController(config) {
  if (!instance) {
    instance = config ? new LimitedLiveController(config) : LimitedLiveController.fromEnv();
  }
  return instance;
}

module.exports = {
  LimitedLiveController,
  getLimitedLiveController,
  LiveState,
};

