/**
 * Scalping Strategy (High-Frequency 1-Minute Trading)
 * 
 * PRIMARY EDGE: Smart Levels (session pivots, liquidity pools, FVGs, sweeps)
 * CONFIRMATION: Conventional indicators (EMA, Hull MA, Donchian, ADX, ATR)
 * 
 * Dual-Speed Design:
 * - updateTick(): Called every bot loop (1s) - Real-time sweep detection
 * - updateBar(): Called per 1-min bar - Form indicators, pivots, pools, FVGs
 * 
 * Public methods (matches momentum strategy interface):
 * - updateTick({ price, volume, ts })
 * - updateBar({ open, high, low, close, volume, ts })
 * - getSignal(price, positions)
 * - shouldOpenLong(price)
 * - shouldOpenShort(price)
 * - shouldClose(position, price)
 * - reset()
 * - getRecommendedPositionSize(price, side, capital)
 */

const SmartLevelsTracker = require('./utils/smart-levels');
const marketDataProvider = require('./utils/market-data');

// Simple indicator calculations
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = values[0];
  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function atr(highs, lows, closes, period) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const h = highs[i];
    const l = lows[i];
    const c = closes[i - 1];
    const tr = Math.max(h - l, Math.abs(h - c), Math.abs(l - c));
    trs.push(tr);
  }
  return ema(trs.slice(-period), period);
}

class ScalpingStrategy {
  constructor(config = {}) {
    const s = config.scalpingStrategy || {};
    const r = config.scalpingRisk || {};
    
    this.cfg = {
      // Market
      market: config.market || 'UNKNOWN',
      
      // Smart Levels configuration
      swingLookback: s.swingLookback || 5,
      equalThresholdPct: s.equalThresholdPct || 0.0005,
      minPoolTouches: s.minPoolTouches || 2,
      minFVGSizePct: s.minFVGSizePct || 0.002,
      maxFVGAgeBars: s.maxFVGAgeBars || 20,
      sweepWickPct: s.sweepWickPct || 0.0005,
      proximityPct: s.proximityPct || 0.001,
      
      // Conventional indicators (confirmation only)
      emaFast: s.emaFast || 9,
      emaSlow: s.emaSlow || 21,
      ema200: s.ema200 || 50, // Longer-term bias
      hullMaPeriod: s.hullMaPeriod || 15,
      donchianPeriod: s.donchianPeriod || 20,
      adxPeriod: s.adxPeriod || 10, // Faster for 1-min
      atrPeriod: s.atrPeriod || 10, // Faster for 1-min
      
      // Entry filters
      minADX: s.minADX || 15, // Minimum trend strength
      maxADX: s.maxADX || 60, // Too choppy/wild
      minVolatilityPct: r.minVolatilityPercent || 0.30, // 0.3% min (stored as %)
      maxVolatilityPct: r.maxVolatilityPercent || 3.0, // 3.0% max (stored as %)
      
      // Volume & OI
      volumeSpikeThreshold: s.volumeSpikeThreshold || 1.8,
      oiSpikeThreshold: s.oiSpikeThreshold || 0.05, // 5%
      
      // ENTRY PATTERNS (Phase 3) - Each can be toggled independently
      // Pattern 1: Continuation Scalp (breakout + volume + CVD)
      enableContinuationPattern: s.enableContinuationPattern !== false, // Default: true
      continuationVolumeMultiplier: s.continuationVolumeMultiplier || 1.5, // 1.5x avg volume
      continuationCVDThreshold: s.continuationCVDThreshold || 0.6, // 60% buy pressure
      continuationDonchianBreakPct: s.continuationDonchianBreakPct || 0.001, // 0.1% break
      
      // Pattern 2: Sweep Reversal (liquidity sweep + CVD divergence)
      enableSweepReversal: s.enableSweepReversal !== false, // Default: true
      sweepReversalMaxAge: s.sweepReversalMaxAge || 30000, // 30s max age
      sweepReversalCVDFlip: s.sweepReversalCVDFlip || 0.5, // 50% flip threshold
      sweepReversalConfirmBars: s.sweepReversalConfirmBars || 2, // 2 bars confirmation
      
      // Pattern 3: Pullback Entry (EMA tap + CVD + low volatility)
      enablePullbackPattern: s.enablePullbackPattern !== false, // Default: true
      pullbackEMAProximity: s.pullbackEMAProximity || 0.002, // 0.2% from EMA
      pullbackCVDThreshold: s.pullbackCVDThreshold || 0.55, // 55% buy pressure
      pullbackMaxATRMultiplier: s.pullbackMaxATRMultiplier || 0.8, // 80% of avg ATR
      
      // Pattern 4: Triple Threat (OI + CVD + Sweep - HIGHEST PRIORITY)
      enableTripleThreat: s.enableTripleThreat !== false, // Default: true
      tripleThreatOIThreshold: s.tripleThreatOIThreshold || 0.03, // 3% OI spike
      tripleThreatCVDThreshold: s.tripleThreatCVDThreshold || 0.65, // 65% buy pressure
      tripleThreatSweepMaxAge: s.tripleThreatSweepMaxAge || 60000, // 60s max age
      
      // Risk model (TIGHT CONTROLS)
      stopLossPercent: r.stopLossPercent || 0.15, // 0.15% (stored as %)
      takeProfitPercent: r.takeProfitPercent || 1.20, // 1.20% (stored as %, increased for fee profitability)
      riskPerTradePercent: r.riskPerTradePercent || 1.5, // 1.5% risk (stored as %)
      positionSizePercent: r.positionSizePercent || 20, // 20% max (stored as %)
      maxConsecutiveLosses: r.maxConsecutiveLosses || 3,
      circuitBreakerCooldownMs: r.circuitBreakerCooldownMs || 60 * 60 * 1000, // 1 hour
      maxHoldBars: r.maxHoldBars || 10, // 10 minutes
      
      // EXIT LOGIC (Phase 4) - HARD STOPS ONLY
      // No time-based exit needed - tight stops resolve positions fast
      
      // Min R:R
      minRiskReward: s.minRiskReward || 1.0, // 1:1 minimum
      
      // Win rate tracking
      targetWinRate: s.targetWinRate || 0.35, // >35%
      reducePositionOnLowWinRate: s.reducePositionOnLowWinRate || false,
      
      // Minimum warmup bars
      minBars: s.minBars || 50,
    };
    
    // Convert percentages to decimals for internal use
    this.stopLossPct = this.cfg.stopLossPercent / 100; // 0.15 -> 0.0015
    this.takeProfitPct = this.cfg.takeProfitPercent / 100; // 1.20 -> 0.0120
    this.riskPerTrade = this.cfg.riskPerTradePercent / 100; // 1.5 -> 0.015
    this.maxPositionPct = this.cfg.positionSizePercent / 100; // 20 -> 0.20
    this.minVolatilityPct = this.cfg.minVolatilityPct / 100; // 0.30 -> 0.0030
    this.maxVolatilityPct = this.cfg.maxVolatilityPct / 100; // 3.0 -> 0.030
    
    // Smart Levels tracker
    this.smartLevels = new SmartLevelsTracker({
      market: this.cfg.market,
      swingLookback: this.cfg.swingLookback,
      equalThresholdPct: this.cfg.equalThresholdPct,
      minPoolTouches: this.cfg.minPoolTouches,
      minFVGSizePct: this.cfg.minFVGSizePct,
      maxFVGAgeBars: this.cfg.maxFVGAgeBars,
      sweepWickPct: this.cfg.sweepWickPct,
      proximityPct: this.cfg.proximityPct,
    });
    
    // Buffers for indicators (bar-level)
    this.prices = []; // Close prices
    this.highs = [];
    this.lows = [];
    this.volumes = [];
    this.timestamps = [];
    
    // CVD (Cumulative Volume Delta) tracking
    this.buyVolumes = []; // Buy volume per bar
    this.sellVolumes = []; // Sell volume per bar
    this.cvd = 0; // Cumulative volume delta
    this.cvdHistory = []; // CVD per bar for divergence detection
    
    // Calculated indicators (updated per bar)
    this.emaFastVal = null;
    this.emaSlowVal = null;
    this.ema200Val = null;
    this.atr = null;
    this.adx = null;
    this.donchianHigh = null;
    this.donchianLow = null;
    
    // Tick-level state
    this.currentPrice = null;
    this.prevPrice = null;
    this.tickCount = 0;
    
    // Circuit breaker state
    this.consecutiveLosses = 0;
    this.circuitBreakerActive = false;
    this.circuitBreakerUntil = null;
    
    // Win rate tracking (Phase 11.1: Permanent fix for root cause 3)
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.breakEvenTrades = 0;
    this.totalPnL = 0;
    this.totalPnLPercent = 0;
    this.tradeHistory = []; // Last 100 trades for detailed analysis
    this.maxTradeHistory = 100;
    this.positionSizeMultiplier = 1.0; // Reduced on low win rate
    
    // Bar count
    this.barCount = 0;
    
    console.log(`[Scalping Strategy] Initialized for ${this.cfg.market}`);
  }
  
  /**
   * Update tick-level state (called every bot loop - 1s)
   * - Updates Smart Levels tick state
   * - Tracks current price for sweep detection
   * - Updates tick count
   */
  updateTick({ price, volume = 0, ts = Date.now() }) {
    if (!Number.isFinite(price) || price <= 0) return;
    
    this.prevPrice = this.currentPrice;
    this.currentPrice = price;
    this.tickCount++;
    
    // Update Smart Levels tracker (sweep detection happens here)
    this.smartLevels.updateTick(price, ts);
  }
  
  /**
   * Update bar-level state (called once per 1-min bar completion)
   * - Forms indicators (EMA, ATR, ADX, Donchian)
   * - Updates Smart Levels bar state (pivots, pools, FVGs)
   * - Maintains price/volume buffers
   */
  // Alias for backtest compatibility (backtest uses 'update', live uses 'updateBar')
  update({ price, close, volume = 0, high, low, ts = Date.now() }) {
    return this.updateBar({ 
      open: price || close, 
      high: high || price || close, 
      low: low || price || close, 
      close: close || price, 
      volume, 
      ts 
    });
  }

  updateBar({ open, high, low, close, volume = 0, ts = Date.now() }) {
    const price = close || open;
    if (!Number.isFinite(price) || price <= 0) return;
    
    // Update buffers
    this.prices.push(price);
    this.highs.push(high || price);
    this.lows.push(low || price);
    this.volumes.push(volume);
    this.timestamps.push(ts);
    
    // Calculate CVD (Cumulative Volume Delta)
    // Estimate buy/sell volume from price action
    const buyVolume = this._estimateBuyVolume(open, high, low, close, volume);
    const sellVolume = volume - buyVolume;
    
    this.buyVolumes.push(buyVolume);
    this.sellVolumes.push(sellVolume);
    
    // Update cumulative delta
    const delta = buyVolume - sellVolume;
    this.cvd += delta;
    this.cvdHistory.push(this.cvd);
    
    // Keep last 200 bars
    const maxBars = 200;
    if (this.prices.length > maxBars) {
      this.prices.shift();
      this.highs.shift();
      this.lows.shift();
      this.volumes.shift();
      this.timestamps.shift();
      this.buyVolumes.shift();
      this.sellVolumes.shift();
      this.cvdHistory.shift();
    }
    
    this.barCount++;
    
    // Calculate indicators
    if (this.prices.length >= this.cfg.emaFast) {
      this.emaFastVal = ema(this.prices, this.cfg.emaFast);
    }
    if (this.prices.length >= this.cfg.emaSlow) {
      this.emaSlowVal = ema(this.prices, this.cfg.emaSlow);
    }
    if (this.prices.length >= this.cfg.ema200) {
      this.ema200Val = ema(this.prices, this.cfg.ema200);
    }
    
    // ATR
    if (this.prices.length >= this.cfg.atrPeriod + 1) {
      this.atr = atr(
        this.highs.slice(-this.cfg.atrPeriod - 1),
        this.lows.slice(-this.cfg.atrPeriod - 1),
        this.prices.slice(-this.cfg.atrPeriod - 1),
        this.cfg.atrPeriod
      );
    }
    
    // Donchian channels
    if (this.prices.length >= this.cfg.donchianPeriod) {
      const recentHighs = this.highs.slice(-this.cfg.donchianPeriod);
      const recentLows = this.lows.slice(-this.cfg.donchianPeriod);
      this.donchianHigh = Math.max(...recentHighs);
      this.donchianLow = Math.min(...recentLows);
    }
    
    // ADX (simplified - full implementation would use +DI/-DI)
    // For now, use a proxy based on price volatility and trend consistency
    if (this.atr && this.ema200Val) {
      const atrPct = this.atr / price;
      const trendStrength = Math.abs(price - this.ema200Val) / price;
      this.adx = Math.min(60, (trendStrength / atrPct) * 20); // Proxy ADX
    }
    
    // Update Smart Levels (pivots, pools, FVGs formation)
    // Build candles array for Smart Levels
    const candles = [];
    for (let i = 0; i < this.prices.length; i++) {
      candles.push({
        open: i > 0 ? this.prices[i - 1] : this.prices[i],
        high: this.highs[i],
        low: this.lows[i],
        close: this.prices[i],
        volume: this.volumes[i],
        timestamp: this.timestamps[i],
      });
    }
    this.smartLevels.updateBar(candles);
  }
  
  /**
   * Get trading signal
   * @param {number} price - Current price
   * @param {Array} positions - Current open positions
   * @returns {Object} Signal object { action, side, confidence, reason, urgent }
   */
  getSignal(price, positions = []) {
    // Circuit breaker check
    if (this.isCircuitBreakerActive()) {
      return {
        action: 'hold',
        reason: 'circuit_breaker_active',
        cooldownRemaining: this.circuitBreakerUntil - Date.now(),
      };
    }
    
    // Warmup check
    if (this.barCount < this.cfg.minBars) {
      return {
        action: 'hold',
        reason: 'warmup',
        barsRemaining: this.cfg.minBars - this.barCount,
      };
    }
    
    // Volatility filter
    if (!this._checkVolatilityFilter(price)) {
      return {
        action: 'hold',
        reason: 'volatility_filter',
        atrPct: this.atr ? this.atr / price : null,
      };
    }
    
    // Check entry patterns (Phase 3)
    // Priority order: Triple Threat > Sweep Reversal > Continuation > Pullback
    
    // Pattern 4: Triple Threat (HIGHEST PRIORITY)
    // Note: This is async, so we check synchronously available data first
    // Full async implementation will be in Phase 5 (Execution Optimizations)
    if (this.cfg.enableTripleThreat) {
      const tripleThreat = this._checkTripleThreatSync(price);
      if (tripleThreat) {
        return {
          action: 'open',
          side: tripleThreat.side,
          confidence: 0.95, // Highest confidence
          reason: 'triple_threat',
          pattern: 'triple_threat',
          details: tripleThreat,
        };
      }
    }
    
    // Pattern 2: Sweep Reversal
    if (this.cfg.enableSweepReversal) {
      const sweepReversal = this._checkSweepReversal(price);
      if (sweepReversal) {
        return {
          action: 'open',
          side: sweepReversal.side,
          confidence: 0.85,
          reason: 'sweep_reversal',
          pattern: 'sweep_reversal',
          details: sweepReversal,
        };
      }
    }
    
    // Pattern 1: Continuation Scalp
    if (this.cfg.enableContinuationPattern) {
      const continuation = this._checkContinuationScalp(price);
      if (continuation) {
        return {
          action: 'open',
          side: continuation.side,
          confidence: 0.75,
          reason: 'continuation_scalp',
          pattern: 'continuation',
          details: continuation,
        };
      }
    }
    
    // Pattern 3: Pullback Entry
    if (this.cfg.enablePullbackPattern) {
      const pullback = this._checkPullbackEntry(price);
      if (pullback) {
        return {
          action: 'open',
          side: pullback.side,
          confidence: 0.70,
          reason: 'pullback_entry',
          pattern: 'pullback',
          details: pullback,
        };
      }
    }
    
    // No entry signal
    return {
      action: 'hold',
      reason: 'no_entry_pattern',
    };
  }
  
  /**
   * Check volatility filter (ATR-based gate)
   */
  _checkVolatilityFilter(price) {
    if (!this.atr || !Number.isFinite(this.atr) || this.atr <= 0) {
      return false; // Can't calculate, block trade
    }
    
    const atrPct = this.atr / price;
    
    // Too quiet (chop)
    if (atrPct < this.minVolatilityPct) {
      return false;
    }
    
    // Too wild (slippage risk)
    if (atrPct > this.maxVolatilityPct) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Circuit breaker check
   */
  isCircuitBreakerActive() {
    if (!this.circuitBreakerActive) return false;
    
    // Check if cooldown expired
    if (Date.now() >= this.circuitBreakerUntil) {
      this.circuitBreakerActive = false;
      this.circuitBreakerUntil = null;
      this.consecutiveLosses = 0;
      console.log('[Scalping] Circuit breaker cooldown expired, resuming');
      return false;
    }
    
    return true;
  }
  
  /**
   * Record trade outcome (for circuit breaker and win rate tracking)
   */
  recordTradeOutcome(trade) {
    const pnl = trade.pnl || 0;
    
    // Circuit breaker logic
    if (pnl < 0) {
      this.consecutiveLosses++;
      
      if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        this.circuitBreakerActive = true;
        this.circuitBreakerUntil = Date.now() + this.cfg.circuitBreakerCooldownMs;
        
        console.error(`[Scalping] 🛑 CIRCUIT BREAKER: ${this.consecutiveLosses} consecutive losses`);
        console.error(`   Cooldown: ${this.cfg.circuitBreakerCooldownMs / 1000 / 60} minutes`);
      }
    } else {
      this.consecutiveLosses = 0; // Reset on win
    }
    
    // Track trade history
    this.tradeHistory.unshift({ pnl, timestamp: Date.now() });
    if (this.tradeHistory.length > 20) {
      this.tradeHistory.pop();
    }
    
    // Win rate tracking
    this._trackWinRate();
  }
  
  /**
   * Track win rate and adjust position sizing if needed
   */
  _trackWinRate() {
    if (this.tradeHistory.length < 10) return; // Need at least 10 trades
    
    const wins = this.tradeHistory.filter(t => t.pnl > 0).length;
    const winRate = wins / this.tradeHistory.length;
    
    if (winRate < this.cfg.targetWinRate) {
      console.warn(`[Scalping] ⚠️  Win rate ${(winRate * 100).toFixed(1)}% < target ${(this.cfg.targetWinRate * 100).toFixed(1)}%`);
      
      if (this.cfg.reducePositionOnLowWinRate) {
        this.positionSizeMultiplier = 0.5; // 50% size until recovery
      }
    } else {
      this.positionSizeMultiplier = 1.0; // Full size
    }
  }
  
  /**
   * Get recommended position size
   * 
   * Integrates with existing risk-manager.js position sizing system.
   * Supports both 'percent' and 'risk' (equal-risk) methods.
   * 
   * @param {number} price - Current price
   * @param {string} side - 'long' or 'short'
   * @param {number} capital - Available capital
   * @param {Object} opts - Additional options
   * @param {string} opts.sizingMethod - 'percent' or 'risk' (overrides config)
   * @param {number} opts.leverage - Expected leverage (for risk calculations)
   * @returns {number} Position size in USD (base size before leverage)
   */
  getRecommendedPositionSize(price, side, capital, opts = {}) {
    if (!Number.isFinite(price) || price <= 0) return 0;
    if (!Number.isFinite(capital) || capital <= 0) return 0;
    
    // Determine sizing method (opts > env > default)
    const sizingMethod = opts.sizingMethod 
      || process.env.POSITION_SIZING_METHOD 
      || 'risk'; // Default to risk-based for scalping
    
    let baseSize = 0;
    
    if (sizingMethod === 'percent') {
      // PERCENT-BASED: Fixed percentage of capital
      // Uses POSITION_SIZE_PERCENT from config (default 20% for scalping)
      const positionSizePercent = this.cfg.positionSizePercent / 100; // Convert to decimal
      baseSize = capital * positionSizePercent;
      
    } else {
      // RISK-BASED (Equal-Risk): Calculate from stop distance
      // This is the recommended method for scalping (tight stops)
      
      // Calculate stop distance in USD
      const stopDistance = price * this.stopLossPct; // e.g., 100 * 0.0015 = $0.15
      
      if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
        console.warn('[Scalping] Cannot calculate risk-based size: invalid stop distance');
        return 0;
      }
      
      // Risk amount per trade (e.g., 1.5% of capital)
      const riskAmount = capital * this.riskPerTrade;
      
      // Calculate position size needed to risk riskAmount at stopDistance
      // Formula: positionSize = riskAmount / (stopDistance / price)
      // Simplified: positionSize = riskAmount * (price / stopDistance)
      const targetSize = riskAmount / (stopDistance / price);
      
      // Apply max position constraint (e.g., 20% of capital)
      const maxSize = capital * this.maxPositionPct;
      
      baseSize = Math.min(targetSize, maxSize);
    }
    
    // Apply win rate multiplier (reduces size if win rate < target)
    baseSize *= this.positionSizeMultiplier;
    
    // Apply min/max constraints from config
    const minSize = Number(process.env.MIN_POSITION_SIZE) || 0;
    const maxSize = Number(process.env.MAX_POSITION_SIZE) || Infinity;
    
    baseSize = Math.max(minSize, Math.min(baseSize, maxSize));
    
    return baseSize;
  }
  
  /**
   * Estimate buy volume from price action (for CVD calculation)
   * Uses candle body and wick analysis
   */
  _estimateBuyVolume(open, high, low, close, totalVolume) {
    if (!Number.isFinite(totalVolume) || totalVolume <= 0) return 0;
    
    // Bullish candle (close > open)
    if (close > open) {
      const bodyRange = close - open;
      const totalRange = high - low;
      
      if (totalRange === 0) return totalVolume * 0.5; // Doji
      
      // Buy volume proportional to body size
      const bodyRatio = bodyRange / totalRange;
      return totalVolume * (0.5 + bodyRatio * 0.5); // 50-100% buy volume
    }
    
    // Bearish candle (close < open)
    else if (close < open) {
      const bodyRange = open - close;
      const totalRange = high - low;
      
      if (totalRange === 0) return totalVolume * 0.5; // Doji
      
      // Buy volume inversely proportional to body size
      const bodyRatio = bodyRange / totalRange;
      return totalVolume * (0.5 - bodyRatio * 0.5); // 0-50% buy volume
    }
    
    // Doji (close === open)
    return totalVolume * 0.5;
  }
  
  /**
   * Get current CVD ratio (buy pressure)
   * Returns 0-1 where 0.5 = neutral, >0.5 = bullish, <0.5 = bearish
   */
  _getCurrentCVDRatio() {
    if (this.buyVolumes.length === 0) return 0.5;
    
    // Look at last N bars
    const lookback = Math.min(5, this.buyVolumes.length);
    const recentBuyVol = this.buyVolumes.slice(-lookback).reduce((sum, v) => sum + v, 0);
    const recentSellVol = this.sellVolumes.slice(-lookback).reduce((sum, v) => sum + v, 0);
    const totalVol = recentBuyVol + recentSellVol;
    
    if (totalVol === 0) return 0.5;
    
    return recentBuyVol / totalVol;
  }
  
  /**
   * Pattern 1: Continuation Scalp
   * Entry: Breakout + Rising Volume + CVD Trend
   */
  _checkContinuationScalp(price) {
    // Need indicators
    if (!this.donchianHigh || !this.donchianLow || !this.emaFastVal || !this.ema200Val) {
      return null;
    }
    
    // Need volume data
    if (this.volumes.length < 20) return null;
    
    // Check for Donchian breakout
    const breakDistanceHigh = price - this.donchianHigh;
    const breakDistanceLow = this.donchianLow - price;
    const breakPct = this.cfg.continuationDonchianBreakPct;
    
    const breakingHigh = breakDistanceHigh > 0 && (breakDistanceHigh / price) >= breakPct;
    const breakingLow = breakDistanceLow > 0 && (breakDistanceLow / price) >= breakPct;
    
    if (!breakingHigh && !breakingLow) return null;
    
    // Check volume spike
    const avgVolume = this.volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20;
    const currentVolume = this.volumes[this.volumes.length - 1] || 0;
    const volumeRatio = currentVolume / (avgVolume || 1);
    
    if (volumeRatio < this.cfg.continuationVolumeMultiplier) return null;
    
    // Check CVD trend
    const cvdRatio = this._getCurrentCVDRatio();
    
    // Long: Breaking high + bullish CVD + price above EMA200
    if (breakingHigh && cvdRatio >= this.cfg.continuationCVDThreshold && price > this.ema200Val) {
      return {
        side: 'long',
        breakDistance: breakDistanceHigh,
        volumeRatio,
        cvdRatio,
        ema200: this.ema200Val,
      };
    }
    
    // Short: Breaking low + bearish CVD + price below EMA200
    if (breakingLow && cvdRatio <= (1 - this.cfg.continuationCVDThreshold) && price < this.ema200Val) {
      return {
        side: 'short',
        breakDistance: breakDistanceLow,
        volumeRatio,
        cvdRatio,
        ema200: this.ema200Val,
      };
    }
    
    return null;
  }
  
  /**
   * Pattern 2: Sweep Reversal
   * Entry: Liquidity Sweep + CVD Flip + Reversal Confirmation
   */
  _checkSweepReversal(price) {
    // Check for recent sweep
    const sweep = this.smartLevels.getRecentSweep(this.cfg.sweepReversalMaxAge);
    if (!sweep) return null;
    
    // Need CVD data
    if (this.cvdHistory.length < this.cfg.sweepReversalConfirmBars + 1) return null;
    
    // Check CVD flip (divergence from sweep direction)
    const cvdRatio = this._getCurrentCVDRatio();
    const cvdFlipThreshold = this.cfg.sweepReversalCVDFlip;
    
    // High sweep (stop hunt above) → Expect reversal down, but CVD shows buying
    if (sweep.type === 'high') {
      // Look for bullish CVD (buyers stepping in after sweep)
      if (cvdRatio >= cvdFlipThreshold) {
        return {
          side: 'long',
          sweepPrice: sweep.price,
          sweepLevel: sweep.level,
          cvdRatio,
          sweepAge: Date.now() - sweep.timestamp,
        };
      }
    }
    
    // Low sweep (stop hunt below) → Expect reversal up, but CVD shows selling
    if (sweep.type === 'low') {
      // Look for bearish CVD (sellers stepping in after sweep)
      if (cvdRatio <= (1 - cvdFlipThreshold)) {
        return {
          side: 'short',
          sweepPrice: sweep.price,
          sweepLevel: sweep.level,
          cvdRatio,
          sweepAge: Date.now() - sweep.timestamp,
        };
      }
    }
    
    return null;
  }
  
  /**
   * Pattern 3: Pullback Entry
   * Entry: EMA Tap + Bullish CVD + Low Volatility
   */
  _checkPullbackEntry(price) {
    // Need indicators
    if (!this.emaFastVal || !this.emaSlowVal || !this.ema200Val || !this.atr) {
      return null;
    }
    
    // Check EMA proximity
    const proximityPct = this.cfg.pullbackEMAProximity;
    const distanceToFast = Math.abs(price - this.emaFastVal) / price;
    const distanceToSlow = Math.abs(price - this.emaSlowVal) / price;
    
    const nearFast = distanceToFast <= proximityPct;
    const nearSlow = distanceToSlow <= proximityPct;
    
    if (!nearFast && !nearSlow) return null;
    
    // Check volatility (should be compressing)
    const avgATR = this.atr;
    const recentHighs = this.highs.slice(-5);
    const recentLows = this.lows.slice(-5);
    const recentRange = Math.max(...recentHighs) - Math.min(...recentLows);
    const recentATR = recentRange / 5;
    
    const atrRatio = recentATR / (avgATR || 1);
    if (atrRatio > this.cfg.pullbackMaxATRMultiplier) return null; // Too volatile
    
    // Check CVD
    const cvdRatio = this._getCurrentCVDRatio();
    
    // Long: Price near EMA + bullish CVD + uptrend (EMA fast > EMA slow)
    if (this.emaFastVal > this.emaSlowVal && cvdRatio >= this.cfg.pullbackCVDThreshold) {
      return {
        side: 'long',
        emaDistance: nearFast ? distanceToFast : distanceToSlow,
        emaLevel: nearFast ? 'fast' : 'slow',
        cvdRatio,
        atrRatio,
      };
    }
    
    // Short: Price near EMA + bearish CVD + downtrend (EMA fast < EMA slow)
    if (this.emaFastVal < this.emaSlowVal && cvdRatio <= (1 - this.cfg.pullbackCVDThreshold)) {
      return {
        side: 'short',
        emaDistance: nearFast ? distanceToFast : distanceToSlow,
        emaLevel: nearFast ? 'fast' : 'slow',
        cvdRatio,
        atrRatio,
      };
    }
    
    return null;
  }
  
  /**
   * Pattern 4: Triple Threat (HIGHEST PRIORITY) - Synchronous Version
   * Entry: OI Spike + CVD Alignment + Recent Sweep
   * 
   * Note: This is a synchronous version for Phase 3.
   * Full async OI spike detection will be implemented in Phase 5.
   */
  _checkTripleThreatSync(price) {
    // Check for recent sweep
    const sweep = this.smartLevels.getRecentSweep(this.cfg.tripleThreatSweepMaxAge);
    if (!sweep) return null;
    
    // Check CVD alignment (simplified without OI for now)
    const cvdRatio = this._getCurrentCVDRatio();
    
    // Long: High sweep + bullish CVD
    if (sweep.type === 'high' && cvdRatio >= this.cfg.tripleThreatCVDThreshold) {
      return {
        side: 'long',
        sweepPrice: sweep.price,
        sweepLevel: sweep.level,
        cvdRatio,
        sweepAge: Date.now() - sweep.timestamp,
        note: 'OI spike detection pending Phase 5',
      };
    }
    
    // Short: Low sweep + bearish CVD
    if (sweep.type === 'low' && cvdRatio <= (1 - this.cfg.tripleThreatCVDThreshold)) {
      return {
        side: 'short',
        sweepPrice: sweep.price,
        sweepLevel: sweep.level,
        cvdRatio,
        sweepAge: Date.now() - sweep.timestamp,
        note: 'OI spike detection pending Phase 5',
      };
    }
    
    return null;
  }
  
  /**
   * Pattern 4: Triple Threat (HIGHEST PRIORITY) - Async Version
   * Entry: OI Spike + CVD Alignment + Recent Sweep
   * 
   * Note: This will be used in Phase 5 when async signal generation is implemented.
   */
  async _checkTripleThreat(price) {
    // Check for recent sweep
    const sweep = this.smartLevels.getRecentSweep(this.cfg.tripleThreatSweepMaxAge);
    if (!sweep) return null;
    
    // Check OI spike
    try {
      const oiSpike = marketDataProvider.detectOISpike(
        this.cfg.market,
        this.cfg.tripleThreatOIThreshold
      );
      
      if (!oiSpike.spiked) return null;
      
      // Check CVD alignment
      const cvdRatio = this._getCurrentCVDRatio();
      
      // Long: High sweep + OI spike + bullish CVD
      if (sweep.type === 'high' && cvdRatio >= this.cfg.tripleThreatCVDThreshold) {
        return {
          side: 'long',
          sweepPrice: sweep.price,
          sweepLevel: sweep.level,
          oiChange: oiSpike.changePct,
          cvdRatio,
          sweepAge: Date.now() - sweep.timestamp,
        };
      }
      
      // Short: Low sweep + OI spike + bearish CVD
      if (sweep.type === 'low' && cvdRatio <= (1 - this.cfg.tripleThreatCVDThreshold)) {
        return {
          side: 'short',
          sweepPrice: sweep.price,
          sweepLevel: sweep.level,
          oiChange: oiSpike.changePct,
          cvdRatio,
          sweepAge: Date.now() - sweep.timestamp,
        };
      }
    } catch (error) {
      // OI data not available, skip this pattern
      return null;
    }
    
    return null;
  }
  
  /**
   * Check if should open long
   */
  shouldOpenLong(price) {
    const signal = this.getSignal(price);
    return signal.action === 'open' && signal.side === 'long';
  }
  
  /**
   * Check if should open short
   */
  shouldOpenShort(price) {
    const signal = this.getSignal(price);
    return signal.action === 'open' && signal.side === 'short';
  }
  
  /**
   * Check if should close position (Phase 4: Exit Logic - HARD STOPS ONLY)
   * 
   * @param {Object} position - Position object with entryPrice, side, size, timestamp, etc.
   * @param {number} price - Current price
   * @returns {Object|false} Exit signal or false
   */
  shouldClose(position, price) {
    if (!position || !Number.isFinite(price) || price <= 0) {
      return false;
    }
    
    const { entryPrice, side, timestamp, size } = position;
    
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return false;
    }
    
    // Calculate P&L
    const pnlPct = side === 'long'
      ? (price - entryPrice) / entryPrice
      : (entryPrice - price) / entryPrice;
    
    const pnlUsd = pnlPct * entryPrice * (size || 0);
    
    // 1. HARD STOP LOSS (HIGHEST PRIORITY)
    const stopLossDistance = -this.stopLossPct; // Negative for loss
    if (pnlPct <= stopLossDistance) {
      return {
        action: 'close',
        reason: 'stop_loss',
        pnlPct,
        pnlUsd,
        stopPrice: entryPrice * (1 + stopLossDistance * (side === 'long' ? 1 : -1)),
        urgent: true, // Execute immediately
      };
    }
    
    // 2. HARD TAKE PROFIT (FULL POSITION)
    const takeProfitDistance = this.takeProfitPct; // Positive for profit
    if (pnlPct >= takeProfitDistance) {
      return {
        action: 'close',
        reason: 'take_profit',
        pnlPct,
        pnlUsd,
        targetPrice: entryPrice * (1 + takeProfitDistance * (side === 'long' ? 1 : -1)),
        urgent: false,
      };
    }
    
    // No exit signal (tight stops resolve positions fast, no time exit needed)
    return false;
  }
  
  /**
   * Record trade result for win rate tracking
   * @param {Object} trade - Trade result
   * @param {string} trade.side - 'long' or 'short'
   * @param {number} trade.entryPrice - Entry price
   * @param {number} trade.exitPrice - Exit price
   * @param {number} trade.pnlUsd - P&L in USD
   * @param {number} trade.pnlPercent - P&L as percentage
   * @param {string} trade.exitReason - 'stop_loss', 'take_profit', etc.
   * @param {number} trade.holdTimeMs - Time held in milliseconds
   * @param {number} trade.timestamp - Exit timestamp
   */
  recordTrade(trade) {
    if (!trade || typeof trade !== 'object') {
      console.warn('[Scalping] Invalid trade object passed to recordTrade');
      return;
    }
    
    const { pnlUsd = 0, pnlPercent = 0, exitReason = 'unknown' } = trade;
    
    // Update counters
    this.totalTrades++;
    
    if (pnlUsd > 0) {
      this.winningTrades++;
      this.consecutiveLosses = 0; // Reset on win
    } else if (pnlUsd < 0) {
      this.losingTrades++;
      this.consecutiveLosses++;
      
      // Check circuit breaker
      if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        this.circuitBreakerActive = true;
        this.circuitBreakerUntil = Date.now() + this.cfg.circuitBreakerCooldownMs;
        console.warn(`[Scalping] Circuit breaker activated after ${this.consecutiveLosses} consecutive losses. Cooldown: ${this.cfg.circuitBreakerCooldownMs / 1000}s`);
      }
    } else {
      this.breakEvenTrades++;
      // Don't reset consecutive losses on break-even
    }
    
    // Update totals
    this.totalPnL += pnlUsd;
    this.totalPnLPercent += pnlPercent;
    
    // Add to history (keep last N trades)
    this.tradeHistory.push({
      ...trade,
      tradeNumber: this.totalTrades,
      recordedAt: Date.now(),
    });
    
    if (this.tradeHistory.length > this.maxTradeHistory) {
      this.tradeHistory.shift(); // Remove oldest
    }
    
    // Calculate current win rate
    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0;
    
    // Adjust position sizing if win rate is below target
    if (this.cfg.reducePositionOnLowWinRate && this.totalTrades >= 10) {
      if (winRate < this.cfg.targetWinRate) {
        // Reduce position size by 50% when below target win rate
        this.positionSizeMultiplier = 0.5;
        console.warn(`[Scalping] Win rate ${(winRate * 100).toFixed(1)}% below target ${(this.cfg.targetWinRate * 100).toFixed(1)}%. Reducing position size by 50%.`);
      } else {
        // Restore full position size when above target
        this.positionSizeMultiplier = 1.0;
      }
    }
    
    // Log trade result
    const winRateStr = (winRate * 100).toFixed(1);
    const avgPnL = this.totalTrades > 0 ? this.totalPnL / this.totalTrades : 0;
    
    console.log(`[Scalping] Trade #${this.totalTrades} closed: ${exitReason} | PnL: $${pnlUsd.toFixed(2)} (${(pnlPercent * 100).toFixed(2)}%) | Win rate: ${winRateStr}% (${this.winningTrades}W/${this.losingTrades}L) | Avg PnL: $${avgPnL.toFixed(2)}`);
  }
  
  /**
   * Get current performance statistics
   * @returns {Object} Performance stats
   */
  getPerformanceStats() {
    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0;
    const avgPnL = this.totalTrades > 0 ? this.totalPnL / this.totalTrades : 0;
    const avgPnLPercent = this.totalTrades > 0 ? this.totalPnLPercent / this.totalTrades : 0;
    
    return {
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      breakEvenTrades: this.breakEvenTrades,
      winRate,
      winRatePercent: winRate * 100,
      consecutiveLosses: this.consecutiveLosses,
      totalPnL: this.totalPnL,
      totalPnLPercent: this.totalPnLPercent,
      avgPnL,
      avgPnLPercent,
      circuitBreakerActive: this.circuitBreakerActive,
      circuitBreakerUntil: this.circuitBreakerUntil,
      positionSizeMultiplier: this.positionSizeMultiplier,
      recentTrades: this.tradeHistory.slice(-10), // Last 10 trades
    };
  }
  
  /**
   * Reset strategy state
   */
  reset() {
    this.prices = [];
    this.highs = [];
    this.lows = [];
    this.volumes = [];
    this.timestamps = [];
    
    this.buyVolumes = [];
    this.sellVolumes = [];
    this.cvd = 0;
    this.cvdHistory = [];
    
    this.emaFastVal = null;
    this.emaSlowVal = null;
    this.ema200Val = null;
    this.atr = null;
    this.adx = null;
    this.donchianHigh = null;
    this.donchianLow = null;
    
    this.currentPrice = null;
    this.prevPrice = null;
    this.tickCount = 0;
    
    this.consecutiveLosses = 0;
    this.circuitBreakerActive = false;
    this.circuitBreakerUntil = null;
    
    // Reset win rate tracking
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.breakEvenTrades = 0;
    this.totalPnL = 0;
    this.totalPnLPercent = 0;
    this.tradeHistory = [];
    this.positionSizeMultiplier = 1.0;
    
    this.barCount = 0;
    
    this.smartLevels.reset();
    
    console.log('[Scalping] Strategy reset');
  }
  
  /**
   * Get strategy statistics
   */
  getStats() {
    const smartLevelsStats = this.smartLevels.getStats();
    
    return {
      market: this.cfg.market,
      barCount: this.barCount,
      tickCount: this.tickCount,
      consecutiveLosses: this.consecutiveLosses,
      circuitBreakerActive: this.circuitBreakerActive,
      winRate: this.tradeHistory.length >= 10
        ? this.tradeHistory.filter(t => t.pnl > 0).length / this.tradeHistory.length
        : null,
      positionSizeMultiplier: this.positionSizeMultiplier,
      smartLevels: smartLevelsStats,
      indicators: {
        emaFast: this.emaFastVal,
        emaSlow: this.emaSlowVal,
        ema200: this.ema200Val,
        atr: this.atr,
        adx: this.adx,
        donchianHigh: this.donchianHigh,
        donchianLow: this.donchianLow,
      },
      cvd: {
        current: this.cvd,
        ratio: this._getCurrentCVDRatio(),
        historyLength: this.cvdHistory.length,
      },
      patterns: {
        continuationEnabled: this.cfg.enableContinuationPattern,
        sweepReversalEnabled: this.cfg.enableSweepReversal,
        pullbackEnabled: this.cfg.enablePullbackPattern,
        tripleThreatEnabled: this.cfg.enableTripleThreat,
      },
    };
  }
}

module.exports = ScalpingStrategy;

