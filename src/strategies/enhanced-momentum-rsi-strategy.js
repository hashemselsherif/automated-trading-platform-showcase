// enhanced-momentum-rsi-strategy.js
//
// RSI Mean-Reversion Strategy
// 
// Entry: RSI extreme → recovery pattern
//   - Long: RSI drops to ≤20, then recovers to ≥25 within maxBars
//   - Short: RSI rises to ≥80, then declines to ≤75 within maxBars
//
// Exit: RSI-based targets (NOT ATR-based like momentum)
//   - Primary: RSI reaches target (direction-specific: long=63, short=37, or neutral=50 if not set)
//   - Partial: RSI reaches 35 (long) or 65 (short) - take 50%
//   - Failure: RSI drops to ≤22 (long) or rises to ≥78 (short) - stop loss
//   - Time: Exit after N bars if target not reached
//   - Hard: Emergency 2x ATR stop (catastrophic protection only)
//
// Key differences from momentum strategy:
//   - Counter-trend entries (buys oversold, sells overbought)
//   - RSI-based exits instead of ATR-based TP/SL
//   - Tick-based RSI updates for responsive signals
//   - Smaller position sizes (higher risk)
//   - No trend filter requirement (works in ranging markets)
//
// Public methods (compatible with bot.js and backtest):
//   - update({ price, close, volume, high, low, ts }) - Bar completion
//   - updateTick({ price, volume, ts }) - Tick update
//   - recalculateLastBar({ close, high, low, volume }) - Intra-bar update
//   - getSignal(price, positions) - Signal generation
//   - shouldClose(position, price) - Exit check
//   - reset() - Clear state
//   - getRecommendedPositionSize(price, side, capital) - Position sizing
//   - recordTrade(trade) - Performance tracking
//   - getStats() - Statistics

class RsiMeanReversionStrategy {
  constructor(config = {}) {
    // Prefer rsiStrategy (set by strategy factory) over generic strategy
    const s = config.rsiStrategy || config.strategy || {};
    
    // Helper to safely parse number from env with fallback
    const num = (envVal, fallback) => {
      if (envVal === undefined || envVal === '') return fallback;
      const n = Number(envVal);
      return Number.isFinite(n) ? n : fallback;
    };
    
    this.cfg = {
      // Market
      market: config.market || 'UNKNOWN',
      
      // RSI Calculation
      rsiPeriod: s.rsiPeriod ?? num(process.env.RSI_PERIOD, 14),
      rsiUseSma: s.rsiUseSma ?? (process.env.RSI_USE_SMA !== 'false'), // Default true to match TradingView
      
      // Entry thresholds
      rsiOversoldExtreme: s.rsiOversoldExtreme ?? num(process.env.RSI_OVERSOLD_EXTREME, 20),
      rsiOversoldRecovery: s.rsiOversoldRecovery ?? num(process.env.RSI_OVERSOLD_RECOVERY, 25),
      rsiOverboughtExtreme: s.rsiOverboughtExtreme ?? num(process.env.RSI_OVERBOUGHT_EXTREME, 80),
      rsiOverboughtRecovery: s.rsiOverboughtRecovery ?? num(process.env.RSI_OVERBOUGHT_RECOVERY, 75),
      rsiEntryMaxBars: s.rsiEntryMaxBars ?? num(process.env.RSI_ENTRY_MAX_BARS, 5),
      rsiEntryMaxDeviation: s.rsiEntryMaxDeviation ?? num(process.env.RSI_ENTRY_MAX_DEVIATION, 10), // Max RSI points past recovery for entry
      
      // Entry gate: require RSI to have crossed recovery level (strict crossover check)
      // When false (default), allows entry as long as RSI is within recovery+deviation range
      // When true, requires RSI to have crossed from below/above recovery in the lookback window
      rsiRequireCrossover: s.rsiRequireCrossover ?? (process.env.RSI_REQUIRE_CROSSOVER === 'true'), // Default: false (relaxed)
      
      // Exit thresholds (RSI-based)
      rsiTargetNeutral: s.rsiTargetNeutral ?? num(process.env.RSI_TARGET_NEUTRAL, 50),
      // Direction-specific targets (fallback to neutral if not set)
      rsiTargetLong: s.rsiTargetLong ?? num(process.env.RSI_TARGET_LONG, null),
      rsiTargetShort: s.rsiTargetShort ?? num(process.env.RSI_TARGET_SHORT, null),
      // Partial exit - disable by setting target to 0 (long) or 100 (short), or use explicit enable flag
      rsiPartialEnabled: s.rsiPartialEnabled ?? (process.env.RSI_PARTIAL_ENABLED !== 'false'), // Default: enabled
      rsiPartialTargetLong: s.rsiPartialTargetLong ?? num(process.env.RSI_PARTIAL_TARGET_LONG, 35),
      rsiPartialTargetShort: s.rsiPartialTargetShort ?? num(process.env.RSI_PARTIAL_TARGET_SHORT, 65),
      rsiPartialPercent: s.rsiPartialPercent ?? num(process.env.RSI_PARTIAL_PERCENT, 50),
      
      // Failure exit - disable by setting to 0 (long) or 100 (short), or use explicit enable flag
      rsiFailureEnabled: s.rsiFailureEnabled ?? (process.env.RSI_FAILURE_ENABLED !== 'false'), // Default: enabled
      rsiFailureLong: s.rsiFailureLong ?? num(process.env.RSI_FAILURE_LONG, 22),
      rsiFailureShort: s.rsiFailureShort ?? num(process.env.RSI_FAILURE_SHORT, 78),
      
      // Time stops - two different configs:
      // rsiTimeStopBars: RSI-related time stop (e.g., exit if RSI hasn't reached target in N bars)
      // rsiHardTimeStopBars: Unconditional time stop (exit regardless of RSI after N bars) - 0 = disabled
      rsiTimeStopBars: s.rsiTimeStopBars ?? num(process.env.RSI_TIME_STOP_BARS, 20),
      rsiHardTimeStopBars: s.rsiHardTimeStopBars ?? num(process.env.RSI_HARD_TIME_STOP_BARS, 0), // 0 = disabled
      rsiHardStopEnabled: s.rsiHardStopEnabled ?? (process.env.RSI_HARD_STOP_ENABLED !== 'false'), // Default: enabled
      rsiHardStopAtr: s.rsiHardStopAtr ?? num(process.env.RSI_HARD_STOP_ATR, 2.0),
      rsiHardStopPercent: s.rsiHardStopPercent ?? num(process.env.RSI_HARD_STOP_PERCENT, 0), // Percentage-based stop (0 = use ATR)
      rsiRequireProfitForTarget: s.rsiRequireProfitForTarget ?? (process.env.RSI_REQUIRE_PROFIT_FOR_TARGET === 'true'), // If true, only exit at RSI target when profitable
      atrPeriod: s.atrPeriod ?? num(process.env.ATR_PERIOD, 14),
      
      // Trailing Stop Configuration
      // Two systems: percentage-based trailing OR ATR-based trailing (can enable both)
      // Percentage trailing: trails by fixed % from high water mark
      // ATR trailing: trails by ATR multiplier from high water mark
      rsiEnableTrailingStop: s.rsiEnableTrailingStop ?? (process.env.RSI_ENABLE_TRAILING_STOP === 'true'), // Default: disabled
      rsiTrailingStopPercent: s.rsiTrailingStopPercent ?? num(process.env.RSI_TRAILING_STOP_PERCENT, 0), // % trailing (0 = disabled)
      rsiTrailingAtrMult: s.rsiTrailingAtrMult ?? num(process.env.RSI_TRAILING_ATR_MULT, 0), // ATR trailing multiplier (0 = disabled)
      // Activation threshold: only start trailing after position is in profit by this %
      rsiTrailingActivationPct: s.rsiTrailingActivationPct ?? num(process.env.RSI_TRAILING_ACTIVATION_PCT, 0), // 0 = immediate activation
      
      // Position sizing
      rsiPositionSizeMultiplier: s.rsiPositionSizeMultiplier ?? num(process.env.RSI_POSITION_SIZE_MULTIPLIER, 0.5),
      positionSizePercent: s.positionSizePercent ?? num(process.env.POSITION_SIZE_PERCENT, 30),
      riskPerTradePercent: s.riskPerTradePercent ?? num(process.env.RISK_PER_TRADE_PERCENT, 1.0),
      
      // Filters
      rsiRequireTrendFilter: s.rsiRequireTrendFilter ?? (process.env.RSI_REQUIRE_TREND_FILTER === 'true'),
      // ADX filter for mean-reversion: avoid strong trends (high ADX)
      // RSI_ADX_PERIOD controls the ADX smoothing/lookback window (default 14)
      rsiAdxPeriod: s.rsiAdxPeriod ?? num(process.env.RSI_ADX_PERIOD, 14),
      // MIN_ADX = 0 means no minimum (allow dead chop)
      // MAX_ADX = 100 means no maximum (disabled), < 100 filters out strong trends
      rsiMinAdx: s.rsiMinAdx ?? num(process.env.RSI_MIN_ADX, 0),
      rsiMaxAdx: s.rsiMaxAdx ?? num(process.env.RSI_MAX_ADX, 100), // 100 = disabled
      rsiMinVolatilityPct: s.rsiMinVolatilityPct ?? num(process.env.RSI_MIN_VOLATILITY_PCT, 0.2),
      rsiMaxVolatilityPct: s.rsiMaxVolatilityPct ?? num(process.env.RSI_MAX_VOLATILITY_PCT, 3.0),
      
      // Circuit breaker
      maxConsecutiveLosses: s.maxConsecutiveLosses ?? num(process.env.RSI_MAX_CONSECUTIVE_LOSSES, 3),
      circuitBreakerCooldownMs: s.circuitBreakerCooldownMs ?? num(process.env.RSI_CIRCUIT_BREAKER_COOLDOWN_MS, 1800000),
      
      // Dynamic confidence (for allocator scoring)
      // When enabled, confidence varies based on how extreme the RSI was at signal generation
      // More extreme RSI = higher confidence = better allocator score
      rsiDynamicConfidence: s.rsiDynamicConfidence ?? (process.env.RSI_DYNAMIC_CONFIDENCE !== 'false'), // Default: enabled
      rsiDynamicConfidenceBase: s.rsiDynamicConfidenceBase ?? num(process.env.RSI_DYNAMIC_CONFIDENCE_BASE, 0.5), // Base confidence
      rsiDynamicConfidenceScale: s.rsiDynamicConfidenceScale ?? num(process.env.RSI_DYNAMIC_CONFIDENCE_SCALE, 20), // RSI deviation divisor
      
      // Cooldowns - global and per-side options
      enableCooldown: s.enableCooldown ?? (process.env.ENABLE_COOLDOWN !== 'false'), // Default: enabled
      cooldownMs: s.cooldownMs ?? num(process.env.COOLDOWN_MS, 30000),
      // Per-side cooldowns (0 = use global cooldownMs, >0 = side-specific cooldown)
      cooldownLongMs: s.cooldownLongMs ?? num(process.env.COOLDOWN_LONG_MS, 0),
      cooldownShortMs: s.cooldownShortMs ?? num(process.env.COOLDOWN_SHORT_MS, 0),
      
      // Regime filter - avoid mean-reversion in strong trends
      // Uses EMA slope to detect trending vs ranging markets
      rsiRegimeFilterEnabled: s.rsiRegimeFilterEnabled ?? (process.env.RSI_REGIME_FILTER_ENABLED === 'true'), // Default: disabled
      rsiRegimeEmaPeriod: s.rsiRegimeEmaPeriod ?? num(process.env.RSI_REGIME_EMA_PERIOD, 50),
      // Slope threshold in % per bar - if EMA slope exceeds this, block entries against the trend
      // For 5m candles: 0.1% per bar = ~2.88% per day = moderate trend
      rsiRegimeSlopeThreshold: s.rsiRegimeSlopeThreshold ?? num(process.env.RSI_REGIME_SLOPE_THRESHOLD, 0.1),
      
      // Time-of-day filters (UTC)
      // Parse comma-separated disabled hour(s): "00,01,02,03,04,05" disables 00:00-05:59 UTC
      tradingDisabledHoursUtc: this._parseHourList(s.tradingDisabledHoursUtc ?? process.env.TRADING_DISABLED_HOURS_UTC, ''),
      // If allowed hours specified, disabled hours are ignored
      tradingAllowedHoursUtc: this._parseHourList(s.tradingAllowedHoursUtc ?? process.env.TRADING_ALLOWED_HOURS_UTC, ''),
      
      // Warmup
      minBars: s.minBars ?? 50,
      
      // Position size limits (read from config to prevent bleeding between strategies)
      minPositionSize: s.minPositionSize ?? 50,
      maxPositionSize: s.maxPositionSize ?? 5000,
      
      // Debug
      verbose: s.verbose ?? (process.env.DEBUG_RSI_STRATEGY === 'true'),
      quiet: config.quiet ?? false, // Suppress per-trade logging
    };
    
    // Signal event ring buffer for API debugging (keeps last 100 events)
    this._signalEventLog = [];
    this._signalEventLogMax = 100;
    
    // Price/indicator buffers
    this.prices = [];
    this.highs = [];
    this.lows = [];
    this.volumes = [];
    this.timestamps = [];
    
    // RSI state
    this.rsi = null;
    this._rsiAvgGain = null;
    this._rsiAvgLoss = null;
    this._rsiHistory = []; // Track RSI values with bar index
    
    // RSI extreme tracking (for reversal detection)
    this._lastOversoldBar = null;      // Bar index when RSI hit oversold extreme
    this._lastOversoldRsi = null;      // RSI value at oversold extreme
    this._lastOverboughtBar = null;    // Bar index when RSI hit overbought extreme
    this._lastOverboughtRsi = null;    // RSI value at overbought extreme
    this._oversoldConsumed = true;     // Reset after entry
    this._overboughtConsumed = true;   // Reset after entry
    
    // ATR (for hard stop only)
    this.atr = null;
    this._trueRanges = [];
    this._prevClose = null;
    
    // ADX (Average Directional Index) for trend filter
    this.adx = null;
    this._plusDM = [];    // +DM values
    this._minusDM = [];   // -DM values
    this._smoothPlusDM = null;
    this._smoothMinusDM = null;
    this._smoothTR = null;
    this._dxValues = [];
    // Standard ADX period is 14; configurable via RSI_ADX_PERIOD
    this._adxPeriod = Math.max(2, Math.floor(this.cfg.rsiAdxPeriod ?? 14));
    this._prevHigh = null;
    this._prevLow = null;
    
    // Bar/tick tracking
    this._barCount = 0;
    this._currentBarIndex = 0;
    this._tickCount = 0;
    this._nowTs = null;
    
    // Cooldowns
    this._lastEntryTs = 0;
    this._lastEntryBar = null;
    this._lastEntrySide = null;
    // Per-side cooldown tracking
    this._lastLongEntryTs = 0;
    this._lastShortEntryTs = 0;

    // Entry diagnostics (for loop log / debugging)
    // Populated only when an extreme is pending and entry is blocked.
    this._entryDebug = { long: null, short: null };
    
    // Regime filter (EMA for trend detection)
    this._ema = null;
    this._emaSlope = null; // % change per bar
    
    // Circuit breaker
    this.consecutiveLosses = 0;
    this.circuitBreakerActive = false;
    this.circuitBreakerUntil = null;
    // Circuit breaker aggregation (for backtest summary)
    this.circuitBreakerActivations = 0;
    this.circuitBreakerCooldownExpirations = 0;
    
    // Performance tracking
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.totalPnL = 0;
    this.tradeHistory = [];
    this.maxTradeHistory = 100;
    
    // Resolve direction-specific targets (use neutral as fallback)
    const targetLong = this.cfg.rsiTargetLong ?? this.cfg.rsiTargetNeutral;
    const targetShort = this.cfg.rsiTargetShort ?? this.cfg.rsiTargetNeutral;
    this._resolvedTargetLong = targetLong;
    this._resolvedTargetShort = targetShort;
    
    console.log(`[RSI-Reversion] Initialized for ${this.cfg.market}`);
    console.log(`[RSI-Reversion] Entry: oversold=${this.cfg.rsiOversoldExtreme}→${this.cfg.rsiOversoldRecovery}, overbought=${this.cfg.rsiOverboughtExtreme}→${this.cfg.rsiOverboughtRecovery}, maxDeviation=${this.cfg.rsiEntryMaxDeviation}`);
    console.log(`[RSI-Reversion] Exit: target_long=${targetLong}, target_short=${targetShort}, partial=${this.cfg.rsiPartialTargetLong}/${this.cfg.rsiPartialTargetShort}, failure=${this.cfg.rsiFailureLong}/${this.cfg.rsiFailureShort}`);
    console.log(`[RSI-Reversion] Hard Stop: enabled=${this.cfg.rsiHardStopEnabled}, percent=${this.cfg.rsiHardStopPercent}%, ATR=${this.cfg.rsiHardStopAtr}x`);
    console.log(`[RSI-Reversion] Trailing Stop: enabled=${this.cfg.rsiEnableTrailingStop}, percent=${this.cfg.rsiTrailingStopPercent}%, ATR=${this.cfg.rsiTrailingAtrMult}x, activation=${this.cfg.rsiTrailingActivationPct}%`);
    console.log(`[RSI-Reversion] Filters: ADX(period=${this._adxPeriod})=${this.cfg.rsiMinAdx}-${this.cfg.rsiMaxAdx}${this.cfg.rsiMaxAdx >= 100 ? ' (disabled)' : ''} | Volatility=${this.cfg.rsiMinVolatilityPct}-${this.cfg.rsiMaxVolatilityPct}%`);
    
    // Debug: Show config source to help diagnose per-market override issues
    const configSource = config.rsiStrategy ? 'rsiStrategy' : (config.strategy ? 'strategy' : 'env/defaults');
    console.log(`[RSI-Reversion] Config source: ${configSource}, received keys: ${Object.keys(config.rsiStrategy || config.strategy || {}).join(', ') || 'none'}`);
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Lightweight per-side "why no entry" tracking.
   * Keep payload small and JSON-safe (for UI/log consumption).
   */
  _setEntryDebug(side, reason, details = {}) {
    const s = side === 'short' ? 'short' : 'long';
    this._entryDebug[s] = {
      side: s,
      reason,
      ...(details && typeof details === 'object' ? details : {}),
    };
  }

  _clearEntryDebug(side) {
    const s = side === 'short' ? 'short' : 'long';
    this._entryDebug[s] = null;
  }

  /**
   * Compute cooldown remaining (ms). 0 means "ready now".
   */
  _cooldownRemainingMs(side) {
    const now = this._now();

    // Per-side cooldown first
    if (side === 'long' && (this.cfg.cooldownLongMs || 0) > 0) {
      const remaining = this.cfg.cooldownLongMs - (now - this._lastLongEntryTs);
      return Math.max(0, remaining);
    }
    if (side === 'short' && (this.cfg.cooldownShortMs || 0) > 0) {
      const remaining = this.cfg.cooldownShortMs - (now - this._lastShortEntryTs);
      return Math.max(0, remaining);
    }

    // Global cooldown
    const cooldown = this.cfg.cooldownMs || 0;
    if (cooldown === 0) return 0;
    const remaining = cooldown - (now - this._lastEntryTs);
    return Math.max(0, remaining);
  }
  
  _parseHourList(hourStr, defaultVal) {
    if (!hourStr || typeof hourStr !== 'string') return defaultVal;
    const trimmed = hourStr.trim();
    if (!trimmed) return defaultVal;
    try {
      const hours = trimmed.split(',').map(h => {
        const n = parseInt(h.trim(), 10);
        return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
      }).filter(h => h !== null);
      return hours.length > 0 ? hours : defaultVal;
    } catch {
      return defaultVal;
    }
  }
  
  _isAllowedHourUtc(ts) {
    // Get UTC hour (0-23)
    const d = new Date(ts);
    const hour = d.getUTCHours();
    
    // If allowed hours specified, check inclusion
    if (this.cfg.tradingAllowedHoursUtc && this.cfg.tradingAllowedHoursUtc.length > 0) {
      return this.cfg.tradingAllowedHoursUtc.includes(hour);
    }
    
    // If disabled hours specified, check exclusion
    if (this.cfg.tradingDisabledHoursUtc && this.cfg.tradingDisabledHoursUtc.length > 0) {
      return !this.cfg.tradingDisabledHoursUtc.includes(hour);
    }
    
    // Default: allow all hours
    return true;
  }
  
  _ok(...xs) {
    return xs.every(v => Number.isFinite(v));
  }
  
  _now() {
    // In backtests, `_nowTs` advances deterministically from candle/tick timestamps.
    // In live trading, fall back to wall clock if `_nowTs` isn't set yet.
    return Number.isFinite(this._nowTs) ? this._nowTs : Date.now();
  }
  
  // ============================================================
  // UPDATE METHODS (Bar-level and Tick-level)
  // ============================================================
  
  /**
   * Bar completion update (called once per candle close)
   */
  update({ price, close, volume = 0, high, low, ts = Date.now() }) {
    const closePrice = close ?? price;
    if (!Number.isFinite(closePrice) || closePrice <= 0) return;
    
    this._barCount++;
    this._currentBarIndex++;
    this._nowTs = ts;
    
    const highValue = Number.isFinite(high) ? high : closePrice;
    const lowValue = Number.isFinite(low) ? low : closePrice;
    
    // Update buffers
    this.prices.push(closePrice);
    this.highs.push(highValue);
    this.lows.push(lowValue);
    this.volumes.push(volume);
    this.timestamps.push(ts);
    
    // Keep last 500 bars
    if (this.prices.length > 500) {
      this.prices.shift();
      this.highs.shift();
      this.lows.shift();
      this.volumes.shift();
      this.timestamps.shift();
    }
    
    // Calculate RSI
    this._updateRsi(closePrice);
    
    // Calculate ATR (for hard stop only)
    this._updateAtr(highValue, lowValue, closePrice);
    
    // Calculate EMA (for regime filter)
    this._updateEma(closePrice);
    
    // Track RSI extremes (for entry detection)
    this._trackRsiExtremes();
  }
  
  /**
   * Tick-level update (called every bot loop)
   * Used for real-time sweep detection (like scalping strategy)
   */
  updateTick({ price, volume = 0, ts = Date.now() }) {
    if (!Number.isFinite(price) || price <= 0) return;
    
    this._tickCount++;
    this._nowTs = ts;
    
    // For RSI-reversion, tick updates are mainly for tracking.
    // IMPORTANT (parity with majors): RSI should be computed ONLY from CLOSED candles
    // (updated on bar completion via update()).
  }
  
  /**
   * Intra-bar RSI recalculation (called every tick for responsive signals)
   * Note: ATR is NOT recalculated intra-bar - it only updates on bar close (industry standard)
   */
  recalculateLastBar({ close, high, low, volume }) {
    // IMPORTANT (production parity): do NOT mutate the historical close series intra-bar.
    // If we overwrite `this.prices[lastIdx]` with rolling-window closes, the NEXT bar-close RSI
    // will use a corrupted previous close (and can produce stuck 50 / spurious 100).
    //
    // We keep a lightweight snapshot for UI/debug only.
    this._lastIntraBar = {
      close,
      high,
      low,
      volume,
      ts: this._now(),
    };
    return;
  }
  
  // ============================================================
  // RSI CALCULATION
  // ============================================================
  
  _updateRsi(price) {
    const n = this.prices.length;
    if (n < 2) {
      this.rsi = null;
      return;
    }
    
    const period = this.cfg.rsiPeriod;
    
    // Check if we have enough data
    if (n < period + 1) {
      this.rsi = null;
      return;
    }
    
    // Use SMA-based RSI (matches TradingView/Jupiter Perps) or Wilder's
    const useSmaRsi = this.cfg.rsiUseSma ?? true; // Default to SMA to match TradingView
    
    if (useSmaRsi) {
      // SMA-based RSI: Calculate gains/losses over the lookback period (no smoothing)
      // This produces more extreme values, matching TradingView's display
      let totalGain = 0;
      let totalLoss = 0;
      
      for (let i = n - period; i < n; i++) {
        const change = this.prices[i] - this.prices[i - 1];
        if (change > 0) totalGain += change;
        else totalLoss += Math.abs(change);
      }
      
      const avgGain = totalGain / period;
      const avgLoss = totalLoss / period;
      
      // Edge cases:
      // - Flat series (avgGain=0 and avgLoss=0) → RSI should be 50 (neutral), not 100.
      // - Gains only (avgLoss=0 and avgGain>0) → RSI = 100.
      // - Losses only (avgGain=0 and avgLoss>0) → RSI = 0 (formula yields 0 anyway).
      if (avgLoss === 0) {
        this.rsi = avgGain === 0 ? 50 : 100;
      } else {
        const rs = avgGain / avgLoss;
        this.rsi = 100 - 100 / (1 + rs);
      }
    } else {
      // Wilder's smoothed RSI (original method)
      const change = price - this.prices[n - 2];
      const gain = Math.max(0, change);
      const loss = Math.max(0, -change);
      
      // Initialize Wilder's smoothing
      if (this._rsiAvgGain === null || this._rsiAvgLoss === null) {
        let g = 0, l = 0;
        for (let i = n - period; i < n; i++) {
          const d = this.prices[i] - this.prices[i - 1];
          if (d > 0) g += d;
          else l += -d;
        }
        this._rsiAvgGain = g / period;
        this._rsiAvgLoss = l / period;
      } else {
        // Wilder's smoothing update
        this._rsiAvgGain = (this._rsiAvgGain * (period - 1) + gain) / period;
        this._rsiAvgLoss = (this._rsiAvgLoss * (period - 1) + loss) / period;
      }
      
      // Calculate RSI
      // Edge cases:
      // - Flat series (avgGain=0 and avgLoss=0) → RSI should be 50.
      // - Gains only (avgLoss=0 and avgGain>0) → RSI = 100.
      if (this._rsiAvgLoss === 0) {
        this.rsi = this._rsiAvgGain === 0 ? 50 : 100;
      } else {
        const rs = this._rsiAvgGain / this._rsiAvgLoss;
        this.rsi = 100 - 100 / (1 + rs);
      }
    }
    
    // Track RSI history
    this._rsiHistory.push({
      rsi: this.rsi,
      bar: this._currentBarIndex,
      ts: this._now(),
    });
    if (this._rsiHistory.length > 100) {
      this._rsiHistory.shift();
    }
  }
  
  // ============================================================
  // RSI EXTREME TRACKING (for entry detection)
  // ============================================================
  
  _trackRsiExtremes() {
    if (!Number.isFinite(this.rsi)) return;
    
    // Track oversold extreme
    if (this.rsi <= this.cfg.rsiOversoldExtreme) {
      this._lastOversoldBar = this._currentBarIndex;
      this._lastOversoldRsi = this.rsi;
      this._oversoldConsumed = false;
      
      if (!this.cfg.quiet) {
        console.log(`[RSI-EXTREME] ${this.cfg.market} OVERSOLD: RSI=${this.rsi.toFixed(1)} (extreme=${this.cfg.rsiOversoldExtreme}) at bar ${this._currentBarIndex}`);
      }
    }
    
    // Track overbought extreme
    if (this.rsi >= this.cfg.rsiOverboughtExtreme) {
      this._lastOverboughtBar = this._currentBarIndex;
      this._lastOverboughtRsi = this.rsi;
      this._overboughtConsumed = false;
      
      if (!this.cfg.quiet) {
        console.log(`[RSI-EXTREME] ${this.cfg.market} OVERBOUGHT: RSI=${this.rsi.toFixed(1)} (extreme=${this.cfg.rsiOverboughtExtreme}) at bar ${this._currentBarIndex}`);
      }
    }
  }
  
  // ============================================================
  // ATR CALCULATION (for hard stop only)
  // ============================================================
  
  _updateAtr(high, low, close) {
    if (this._prevClose === null) {
      this._prevClose = close;
      return;
    }
    
    const tr1 = high - low;
    const tr2 = Math.abs(high - this._prevClose);
    const tr3 = Math.abs(low - this._prevClose);
    const tr = Math.max(tr1, tr2, tr3);
    
    this._trueRanges.push(tr);
    if (this._trueRanges.length > this.cfg.atrPeriod * 2) {
      this._trueRanges.shift();
    }
    
    if (this._trueRanges.length >= this.cfg.atrPeriod) {
      if (this.atr === null) {
        this.atr = this._trueRanges.slice(-this.cfg.atrPeriod).reduce((a, b) => a + b, 0) / this.cfg.atrPeriod;
      } else {
        // Wilder's smoothing
        this.atr = (this.atr * (this.cfg.atrPeriod - 1) + tr) / this.cfg.atrPeriod;
      }
    }
    
    this._prevClose = close;
    
    // Update ADX using the same true range
    this._updateAdx(high, low, tr);
  }
  
  // ============================================================
  // ADX CALCULATION (for trend strength filter)
  // ADX < 25 = weak/no trend (good for mean-reversion)
  // ADX > 25 = strong trend (avoid mean-reversion)
  // ============================================================
  
  _updateAdx(high, low, tr) {
    const period = this._adxPeriod;
    
    if (this._prevHigh === null || this._prevLow === null) {
      this._prevHigh = high;
      this._prevLow = low;
      return;
    }
    
    // Calculate +DM and -DM
    const upMove = high - this._prevHigh;
    const downMove = this._prevLow - low;
    
    let plusDM = 0;
    let minusDM = 0;
    
    if (upMove > downMove && upMove > 0) {
      plusDM = upMove;
    }
    if (downMove > upMove && downMove > 0) {
      minusDM = downMove;
    }
    
    this._plusDM.push(plusDM);
    this._minusDM.push(minusDM);
    
    // Keep buffer size reasonable
    if (this._plusDM.length > period * 3) {
      this._plusDM.shift();
      this._minusDM.shift();
    }
    
    // Need enough data for ADX calculation
    if (this._plusDM.length < period) {
      this._prevHigh = high;
      this._prevLow = low;
      return;
    }
    
    // Calculate smoothed values using Wilder's smoothing
    if (this._smoothPlusDM === null) {
      // Initial: sum of first period values
      this._smoothPlusDM = this._plusDM.slice(-period).reduce((a, b) => a + b, 0);
      this._smoothMinusDM = this._minusDM.slice(-period).reduce((a, b) => a + b, 0);
      this._smoothTR = this._trueRanges.slice(-period).reduce((a, b) => a + b, 0);
    } else {
      // Wilder's smoothing: prev - (prev/period) + current
      this._smoothPlusDM = this._smoothPlusDM - (this._smoothPlusDM / period) + plusDM;
      this._smoothMinusDM = this._smoothMinusDM - (this._smoothMinusDM / period) + minusDM;
      this._smoothTR = this._smoothTR - (this._smoothTR / period) + tr;
    }
    
    // Calculate +DI and -DI
    const plusDI = this._smoothTR > 0 ? (this._smoothPlusDM / this._smoothTR) * 100 : 0;
    const minusDI = this._smoothTR > 0 ? (this._smoothMinusDM / this._smoothTR) * 100 : 0;
    
    // Calculate DX
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    
    this._dxValues.push(dx);
    if (this._dxValues.length > period * 2) {
      this._dxValues.shift();
    }
    
    // Calculate ADX (smoothed DX)
    if (this._dxValues.length >= period) {
      if (this.adx === null) {
        // Initial ADX is SMA of DX values
        this.adx = this._dxValues.slice(-period).reduce((a, b) => a + b, 0) / period;
      } else {
        // Wilder's smoothing for ADX
        this.adx = ((this.adx * (period - 1)) + dx) / period;
      }
    }
    
    this._prevHigh = high;
    this._prevLow = low;
  }
  
  // ============================================================
  // ADX FILTER CHECK
  // Returns true if ADX is within acceptable range for mean-reversion
  // ============================================================
  
  _adxOK() {
    // If ADX not yet calculated, allow (don't block during warmup)
    if (!Number.isFinite(this.adx)) {
      return true;
    }
    
    const minAdx = this.cfg.rsiMinAdx || 0;
    const maxAdx = this.cfg.rsiMaxAdx || 100;
    
    // Check minimum (avoid dead chop)
    if (minAdx > 0 && this.adx < minAdx) {
      return false;
    }
    
    // Check maximum (avoid strong trends)
    if (maxAdx < 100 && this.adx > maxAdx) {
      return false;
    }
    
    return true;
  }
  
  // ============================================================
  // EMA CALCULATION (for regime filter)
  // ============================================================
  
  _updateEma(close) {
    const period = this.cfg.rsiRegimeEmaPeriod;
    if (!Number.isFinite(period) || period <= 0) return;
    
    const n = this.prices.length;
    if (n < period) {
      this._ema = null;
      this._emaSlope = null;
      return;
    }
    
    const prevEma = this._ema;
    
    // Initialize EMA with SMA on first calculation
    if (prevEma === null) {
      let sum = 0;
      for (let i = n - period; i < n; i++) {
        sum += this.prices[i];
      }
      this._ema = sum / period;
      this._emaSlope = null;
      return;
    }
    
    // EMA = (Close - EMA_prev) * k + EMA_prev, where k = 2 / (period + 1)
    const k = 2 / (period + 1);
    this._ema = (close - prevEma) * k + prevEma;
    
    // Calculate slope as % change per bar
    if (prevEma > 0) {
      this._emaSlope = ((this._ema - prevEma) / prevEma) * 100;
    }
  }
  
  // NOTE: Intra-bar ATR recalculation removed
  // ATR should only update on bar completion (industry standard)
  // True Range requires complete bar data which isn't finalized until bar close
  // This prevents stop levels from shifting unexpectedly during the bar
  
  // ============================================================
  // ENTRY LOGIC
  // ============================================================
  
  /**
   * Check for oversold reversal entry (LONG)
   * Condition: RSI dropped to ≤20, then CROSSED recovery level (25) within maxBars
   * Entry only triggers when RSI crosses FROM below recovery TO at/above recovery
   */
  _checkOversoldReversalEntry(price) {
    // Check if we have an unconsumed oversold extreme
    if (this._lastOversoldBar === null || this._oversoldConsumed) {
      return null;
    }
    
    // Check if within maxBars window
    const barsSinceExtreme = this._currentBarIndex - this._lastOversoldBar;
    if (barsSinceExtreme > this.cfg.rsiEntryMaxBars) {
      // Expired - clear the extreme
      this._oversoldConsumed = true;
      this._setEntryDebug('long', 'expired_window', {
        barsSinceExtreme,
        maxBars: this.cfg.rsiEntryMaxBars,
        extremeRsi: this._lastOversoldRsi,
      });
      return null;
    }
    
    // Check if RSI is at/above recovery level
    if (!Number.isFinite(this.rsi) || this.rsi < this.cfg.rsiOversoldRecovery) {
      this._setEntryDebug('long', 'waiting_recovery', {
        barsSinceExtreme,
        rsi: Number.isFinite(this.rsi) ? this.rsi : null,
        recovery: this.cfg.rsiOversoldRecovery,
        extremeRsi: this._lastOversoldRsi,
      });
      return null;
    }
    
    // IMPORTANT: RSI must be CLOSE to recovery level, not far past it
    // This prevents entering at RSI 40+ when we should enter near 25
    // Max deviation: allow up to X points above recovery (e.g., 25-35 for long with 10pt deviation)
    const maxEntryRsi = this.cfg.rsiOversoldRecovery + this.cfg.rsiEntryMaxDeviation;
    if (this.rsi > maxEntryRsi) {
      // RSI too far past recovery - entry too late
      this._setEntryDebug('long', 'late_entry_rsi_too_high', {
        barsSinceExtreme,
        rsi: this.rsi,
        maxEntryRsi,
        recovery: this.cfg.rsiOversoldRecovery,
        deviation: this.cfg.rsiEntryMaxDeviation,
        extremeRsi: this._lastOversoldRsi,
      });
      return null;
    }
    
    // Optional strict crossover check
    // When enabled, requires RSI to have crossed from below to at/above recovery
    const prevRsi = this._rsiHistory.length >= 2 
      ? this._rsiHistory[this._rsiHistory.length - 2]?.rsi 
      : null;
    
    if (this.cfg.rsiRequireCrossover && !this._checkCrossover('long')) {
      if (this.cfg.verbose) {
        console.log(`[RSI-LONG-CHECK] BLOCKED: crossover not detected (requires RSI to cross ${this.cfg.rsiOversoldRecovery})`);
      }
      this._setEntryDebug('long', 'crossover_required', {
        barsSinceExtreme,
        prevRsi: Number.isFinite(prevRsi) ? prevRsi : null,
        rsi: Number.isFinite(this.rsi) ? this.rsi : null,
        recovery: this.cfg.rsiOversoldRecovery,
      });
      return null;
    }
    
    // Check cooldown
    if (!this._cooldownOK('long')) {
      this._setEntryDebug('long', 'cooldown', {
        barsSinceExtreme,
        cooldownRemainingMs: this._cooldownRemainingMs('long'),
      });
      return null;
    }
    
    // Check volatility filter
    if (!this._volatilityOK(price)) {
      const atrPct = (Number.isFinite(this.atr) && Number.isFinite(price) && price > 0)
        ? (this.atr / price) * 100
        : null;
      this._setEntryDebug('long', 'volatility', {
        barsSinceExtreme,
        atrPct,
        minVolatilityPct: this.cfg.rsiMinVolatilityPct,
        maxVolatilityPct: this.cfg.rsiMaxVolatilityPct,
      });
      return null;
    }
    
    // Check ADX filter (avoid entries during strong trends)
    if (!this._adxOK()) {
      this._setEntryDebug('long', 'adx', {
        barsSinceExtreme,
        adx: Number.isFinite(this.adx) ? this.adx : null,
        minAdx: this.cfg.rsiMinAdx,
        maxAdx: this.cfg.rsiMaxAdx,
      });
      return null;
    }

    // Check regime filter (avoid long entries in strong downtrends)
    if (!this._regimeFilterOK('long')) {
      this._setEntryDebug('long', 'regime', {
        barsSinceExtreme,
        emaSlope: Number.isFinite(this._emaSlope) ? this._emaSlope : null,
        slopeThreshold: this.cfg.rsiRegimeSlopeThreshold,
      });
      return null;
    }
    
    // Entry conditions met! RSI recovered from oversold extreme
    if (!this.cfg.quiet) {
      console.log(`[RSI-ENTRY-OK] LONG ${this.cfg.market}: RSI=${this.rsi?.toFixed(1)} in range [${this.cfg.rsiOversoldRecovery}-${this.cfg.rsiOversoldRecovery + this.cfg.rsiEntryMaxDeviation}] | extreme=${this._lastOversoldRsi?.toFixed(1)} | bars=${barsSinceExtreme}`);
    }
    this._clearEntryDebug('long');
    return {
      side: 'long',
      extremeBar: this._lastOversoldBar,
      extremeRsi: this._lastOversoldRsi,
      recoveryRsi: this.rsi,
      prevRsi: prevRsi,
      barsSinceExtreme,
      emaSlope: this._emaSlope, // Include for debugging
    };
  }
  
  /**
   * Check for overbought reversal entry (SHORT)
   * Condition: RSI rose to ≥80, then CROSSED recovery level (75) within maxBars
   * Entry only triggers when RSI crosses FROM above recovery TO at/below recovery
   */
  _checkOverboughtReversalEntry(price) {
    // Check if we have an unconsumed overbought extreme
    if (this._lastOverboughtBar === null || this._overboughtConsumed) {
      return null;
    }
    
    // Check if within maxBars window
    const barsSinceExtreme = this._currentBarIndex - this._lastOverboughtBar;
    if (barsSinceExtreme > this.cfg.rsiEntryMaxBars) {
      // Expired - clear the extreme
      this._overboughtConsumed = true;
      if (this.cfg.verbose) {
        console.log(`[RSI-SHORT-CHECK] BLOCKED: bars since extreme (${barsSinceExtreme}) > max (${this.cfg.rsiEntryMaxBars})`);
      }
      this._setEntryDebug('short', 'expired_window', {
        barsSinceExtreme,
        maxBars: this.cfg.rsiEntryMaxBars,
        extremeRsi: this._lastOverboughtRsi,
      });
      return null;
    }
    
    // Check if RSI is at/below recovery level
    if (!Number.isFinite(this.rsi) || this.rsi > this.cfg.rsiOverboughtRecovery) {
      if (this.cfg.verbose) {
        console.log(`[RSI-SHORT-CHECK] BLOCKED: RSI (${this.rsi?.toFixed(1)}) > recovery (${this.cfg.rsiOverboughtRecovery})`);
      }
      this._setEntryDebug('short', 'waiting_recovery', {
        barsSinceExtreme,
        rsi: Number.isFinite(this.rsi) ? this.rsi : null,
        recovery: this.cfg.rsiOverboughtRecovery,
        extremeRsi: this._lastOverboughtRsi,
      });
      return null;
    }
    
    // IMPORTANT: RSI must be CLOSE to recovery level, not far past it
    // This prevents entering at RSI 50 when we should enter near 75
    // Max deviation: allow up to X points below recovery (e.g., 65-75 for short with 10pt deviation)
    const minEntryRsi = this.cfg.rsiOverboughtRecovery - this.cfg.rsiEntryMaxDeviation;
    if (this.rsi < minEntryRsi) {
      // RSI too far past recovery - entry too late
      this._setEntryDebug('short', 'late_entry_rsi_too_low', {
        barsSinceExtreme,
        rsi: this.rsi,
        minEntryRsi,
        recovery: this.cfg.rsiOverboughtRecovery,
        deviation: this.cfg.rsiEntryMaxDeviation,
        extremeRsi: this._lastOverboughtRsi,
      });
      return null;
    }
    
    // Optional strict crossover check
    // When enabled, requires RSI to have crossed from above to at/below recovery
    const prevRsi = this._rsiHistory.length >= 2 
      ? this._rsiHistory[this._rsiHistory.length - 2]?.rsi 
      : null;
    
    if (this.cfg.rsiRequireCrossover && !this._checkCrossover('short')) {
      if (this.cfg.verbose) {
        console.log(`[RSI-SHORT-CHECK] BLOCKED: crossover not detected (requires RSI to cross ${this.cfg.rsiOverboughtRecovery})`);
      }
      this._setEntryDebug('short', 'crossover_required', {
        barsSinceExtreme,
        prevRsi: Number.isFinite(prevRsi) ? prevRsi : null,
        rsi: Number.isFinite(this.rsi) ? this.rsi : null,
        recovery: this.cfg.rsiOverboughtRecovery,
      });
      return null;
    }
    
    // Check cooldown
    if (!this._cooldownOK('short')) {
      if (this.cfg.verbose) {
        console.log(`[RSI-SHORT-CHECK] BLOCKED: cooldown active`);
      }
      this._setEntryDebug('short', 'cooldown', {
        barsSinceExtreme,
        cooldownRemainingMs: this._cooldownRemainingMs('short'),
      });
      return null;
    }
    
    // Check volatility filter
    if (!this._volatilityOK(price)) {
      const atrPct = this.atr && price > 0 ? (this.atr / price) * 100 : 0;
      if (this.cfg.verbose) {
        console.log(`[RSI-SHORT-CHECK] BLOCKED: volatility filter failed - ATR%=${atrPct.toFixed(3)}, min=${this.cfg.rsiMinVolatilityPct}, max=${this.cfg.rsiMaxVolatilityPct}`);
      }
      this._setEntryDebug('short', 'volatility', {
        barsSinceExtreme,
        atrPct: Number.isFinite(atrPct) ? atrPct : null,
        minVolatilityPct: this.cfg.rsiMinVolatilityPct,
        maxVolatilityPct: this.cfg.rsiMaxVolatilityPct,
      });
      return null;
    }
    
    // Check ADX filter (avoid entries during strong trends)
    if (!this._adxOK()) {
      if (this.cfg.verbose) {
        console.log(`[RSI-SHORT-CHECK] BLOCKED: ADX filter failed - ADX=${this.adx?.toFixed(1)}, min=${this.cfg.rsiMinAdx}, max=${this.cfg.rsiMaxAdx}`);
      }
      this._setEntryDebug('short', 'adx', {
        barsSinceExtreme,
        adx: Number.isFinite(this.adx) ? this.adx : null,
        minAdx: this.cfg.rsiMinAdx,
        maxAdx: this.cfg.rsiMaxAdx,
      });
      return null;
    }
    
    // Check regime filter (avoid short entries in strong uptrends)
    if (!this._regimeFilterOK('short')) {
      this._setEntryDebug('short', 'regime', {
        barsSinceExtreme,
        emaSlope: Number.isFinite(this._emaSlope) ? this._emaSlope : null,
        slopeThreshold: this.cfg.rsiRegimeSlopeThreshold,
      });
      return null;
    }
    
    // Entry conditions met! RSI recovered from overbought extreme
    if (!this.cfg.quiet) {
      console.log(`[RSI-ENTRY-OK] SHORT ${this.cfg.market}: RSI=${this.rsi?.toFixed(1)} in range [${this.cfg.rsiOverboughtRecovery - this.cfg.rsiEntryMaxDeviation}-${this.cfg.rsiOverboughtRecovery}] | extreme=${this._lastOverboughtRsi?.toFixed(1)} | bars=${barsSinceExtreme}`);
    }
    this._clearEntryDebug('short');
    return {
      side: 'short',
      extremeBar: this._lastOverboughtBar,
      extremeRsi: this._lastOverboughtRsi,
      recoveryRsi: this.rsi,
      prevRsi: prevRsi,
      barsSinceExtreme,
      emaSlope: this._emaSlope, // Include for debugging
    };
  }
  
  _cooldownOK(side) {
    // Check if cooldown is enabled (master toggle)
    if (this.cfg.enableCooldown === false) {
      return true; // Cooldown disabled - always pass
    }
    
    const now = this._now();
    
    // Check per-side cooldown first (if configured)
    if (side === 'long' && this.cfg.cooldownLongMs > 0) {
      return now - this._lastLongEntryTs >= this.cfg.cooldownLongMs;
    }
    if (side === 'short' && this.cfg.cooldownShortMs > 0) {
      return now - this._lastShortEntryTs >= this.cfg.cooldownShortMs;
    }
    
    // Fall back to global cooldown
    const cooldown = this.cfg.cooldownMs || 0;
    if (cooldown === 0) return true;
    
    return now - this._lastEntryTs >= cooldown;
  }
  
  _volatilityOK(price) {
    if (!Number.isFinite(this.atr) || !Number.isFinite(price) || price <= 0) {
      return true; // Pass if can't calculate
    }
    
    const atrPct = (this.atr / price) * 100;
    
    if (atrPct < this.cfg.rsiMinVolatilityPct) {
      return false; // Too quiet
    }
    
    if (atrPct > this.cfg.rsiMaxVolatilityPct) {
      return false; // Too wild
    }
    
    return true;
  }
  
  /**
   * Regime filter - avoid mean-reversion entries against strong trends.
   * Uses EMA slope to detect trending vs ranging markets.
   * 
   * For LONG entries: block if EMA slope is strongly negative (price falling)
   * For SHORT entries: block if EMA slope is strongly positive (price rising)
   * 
   * @param {string} side - 'long' or 'short'
   * @returns {boolean} true if regime allows entry
   */
  _regimeFilterOK(side) {
    if (!this.cfg.rsiRegimeFilterEnabled) {
      return true; // Regime filter disabled
    }
    
    if (!Number.isFinite(this._emaSlope)) {
      return true; // Can't calculate, allow entry
    }
    
    const threshold = this.cfg.rsiRegimeSlopeThreshold;
    
    if (side === 'long' && this._emaSlope < -threshold) {
      // Strong downtrend - block long entry (mean-reversion into falling knife)
      if (this.cfg.verbose) {
        console.log(`[RSI-REGIME] BLOCKED long: EMA slope ${this._emaSlope.toFixed(3)}% < -${threshold}%`);
      }
      return false;
    }
    
    if (side === 'short' && this._emaSlope > threshold) {
      // Strong uptrend - block short entry (mean-reversion against rally)
      if (this.cfg.verbose) {
        console.log(`[RSI-REGIME] BLOCKED short: EMA slope ${this._emaSlope.toFixed(3)}% > ${threshold}%`);
      }
      return false;
    }
    
    return true;
  }
  
  /**
   * Check if RSI has crossed the recovery level (strict crossover detection).
   * Used when rsiRequireCrossover is enabled.
   * 
   * @param {string} side - 'long' or 'short'
   * @returns {boolean} true if crossover detected
   */
  _checkCrossover(side) {
    if (this._rsiHistory.length < 2) return false;
    
    const currentRsi = this.rsi;
    const prevRsi = this._rsiHistory[this._rsiHistory.length - 2]?.rsi;
    
    if (!Number.isFinite(currentRsi) || !Number.isFinite(prevRsi)) return false;
    
    if (side === 'long') {
      // Long crossover: RSI crossed from below to at/above oversold recovery
      const recovery = this.cfg.rsiOversoldRecovery;
      return prevRsi < recovery && currentRsi >= recovery;
    } else {
      // Short crossover: RSI crossed from above to at/below overbought recovery
      const recovery = this.cfg.rsiOverboughtRecovery;
      return prevRsi > recovery && currentRsi <= recovery;
    }
  }
  
  // ============================================================
  // EXIT LOGIC (RSI-Based)
  // ============================================================
  
  /**
   * Check trailing stop exit condition.
   * Supports both percentage-based and ATR-based trailing.
   * Uses the tighter (smaller) trail distance if both are configured.
   * 
   * For LONG: exits if price drops below highWaterMark - trailDistance
   * For SHORT: exits if price rises above lowWaterMark + trailDistance
   * 
   * @param {object} position - Current position with highWaterMark/lowWaterMark
   * @param {number} price - Current price
   * @param {number} pnlPct - Current P&L percentage
   * @returns {object|false} Exit signal or false
   */
  _checkTrailingStop(position, price, pnlPct) {
    if (!position) return false;
    
    const side = position.side?.toLowerCase();
    const entryPrice = position.entryPrice;
    
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false;
    
    // Check activation threshold: only start trailing after position is in profit
    const activationPct = this.cfg.rsiTrailingActivationPct || 0;
    if (activationPct > 0 && pnlPct < (activationPct / 100)) {
      return false; // Not yet in enough profit to activate trailing
    }
    
    // Calculate trail distances from both methods
    let percentTrailDistance = 0;
    let atrTrailDistance = 0;
    
    // Percentage-based trailing
    if (this.cfg.rsiTrailingStopPercent > 0) {
      // Trail by fixed % from high/low water mark
      const referencePrice = side === 'long' ? position.highWaterMark : position.lowWaterMark;
      if (Number.isFinite(referencePrice) && referencePrice > 0) {
        percentTrailDistance = referencePrice * (this.cfg.rsiTrailingStopPercent / 100);
      }
    }
    
    // ATR-based trailing  
    if (this.cfg.rsiTrailingAtrMult > 0 && Number.isFinite(this.atr) && this.atr > 0) {
      atrTrailDistance = this.atr * this.cfg.rsiTrailingAtrMult;
    }
    
    // Use the tighter (smaller non-zero) trail distance if both are set
    let trailDistance = 0;
    let trailMethod = 'none';
    if (percentTrailDistance > 0 && atrTrailDistance > 0) {
      if (percentTrailDistance <= atrTrailDistance) {
        trailDistance = percentTrailDistance;
        trailMethod = 'percent';
      } else {
        trailDistance = atrTrailDistance;
        trailMethod = 'atr';
      }
    } else if (percentTrailDistance > 0) {
      trailDistance = percentTrailDistance;
      trailMethod = 'percent';
    } else if (atrTrailDistance > 0) {
      trailDistance = atrTrailDistance;
      trailMethod = 'atr';
    }
    
    if (trailDistance <= 0) return false;
    
    // Check trailing stop trigger
    if (side === 'long') {
      const hwm = position.highWaterMark;
      if (Number.isFinite(hwm) && hwm > 0) {
        const trailStopPrice = hwm - trailDistance;
        if (price <= trailStopPrice) {
          return {
            close: true,
            reason: 'rsi_trailing_stop',
            trailingStop: true,
            trailMethod,
            highWaterMark: hwm,
            trailDistance,
            trailStopPrice,
            pnlPct,
          };
        }
      }
    } else if (side === 'short') {
      const lwm = position.lowWaterMark;
      if (Number.isFinite(lwm) && lwm > 0) {
        const trailStopPrice = lwm + trailDistance;
        if (price >= trailStopPrice) {
          return {
            close: true,
            reason: 'rsi_trailing_stop',
            trailingStop: true,
            trailMethod,
            lowWaterMark: lwm,
            trailDistance,
            trailStopPrice,
            pnlPct,
          };
        }
      }
    }
    
    return false;
  }
  
  /**
   * Check if position should be closed.
   * 
   * Exit Precedence (strategy evaluation order):
   *   1. Hard Time Stop (unconditional max bars - highest priority)
   *   2. RSI Time Stop (max bars without reaching RSI target)
   *   3. Trailing Stop (price-based profit protection - checked before RSI exits)
   *   4. RSI Target (direction-specific: targetLong/targetShort)
   *   5. Partial Exit (RSI intermediate level)
   *   6. Failure Exit (RSI reversed back to extreme)
   *   7. Hard Stop (ATR/% price-based - catastrophic protection)
   * 
   * Note: In the backtest, hard stops AND trailing stops (price-based) are also
   * evaluated per-tick with higher priority. Trailing stops are checked BEFORE
   * RSI signal-based exits to protect accumulated profits from reversals.
   * 
   * Returns: { close: boolean, partial?: boolean, reason: string, ... }
   */
  shouldClose(position, price, currentBarIndex = null) {
    if (!position) return false;
    
    const side = position.side?.toLowerCase();
    const entryPrice = position.entryPrice;
    const entryRsi = position.entryRsi;
    const openBarIndex = position.openBarIndex ?? this._currentBarIndex;
    // Use provided currentBarIndex if available (for backtest timing accuracy),
    // otherwise fall back to internal _currentBarIndex
    const effectiveBarIndex = currentBarIndex !== null ? currentBarIndex : this._currentBarIndex;
    
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false;
    
    // Calculate P&L for reporting
    const pnlPct = side === 'long'
      ? (price - entryPrice) / entryPrice
      : (entryPrice - price) / entryPrice;
    
    // Calculate bars held (for time stops)
    const barsHeld = effectiveBarIndex - openBarIndex;
    
    // ============================================================================
    // TIME STOPS: Checked FIRST, before RSI guard, because they work regardless of RSI state
    // ============================================================================
    
    // 1. HARD TIME STOP: Unconditional exit after N bars (HIGHEST PRIORITY)
    // This is checked FIRST because it's a hard limit regardless of RSI
    const hardTimeStopBars = this.cfg.rsiHardTimeStopBars;
    if (hardTimeStopBars > 0 && barsHeld >= hardTimeStopBars) {
      return {
        close: true,
        reason: 'rsi_hard_time_stop',
        timeOut: true,
        hardTimeStop: true,
        barsHeld,
        rsi: this.rsi,
        pnlPct,
      };
    }
    
    // 2. RSI TIME STOP: Too many bars without reaching RSI target
    // Checked before RSI-based exits to enforce time limit
    const rsiTimeStopBars = this.cfg.rsiTimeStopBars;
    if (rsiTimeStopBars > 0 && barsHeld >= rsiTimeStopBars) {
      return {
        close: true,
        reason: 'rsi_time_stop',
        timeOut: true,
        barsHeld,
        rsi: this.rsi,
        pnlPct,
      };
    }
    
    // ============================================================================
    // PRICE-BASED STOPS: Checked BEFORE RSI exits (protect profits/limit losses)
    // ============================================================================
    
    // 3. TRAILING STOP: Lock in profits by trailing from high/low water mark
    // This is a PRICE-BASED exit and takes priority over RSI signal exits.
    // Trailing stops protect accumulated profits from reversals.
    // Supports both percentage-based and ATR-based trailing (uses tighter of both)
    if (this.cfg.rsiEnableTrailingStop) {
      const trailingResult = this._checkTrailingStop(position, price, pnlPct);
      if (trailingResult) return trailingResult;
    }
    
    // ============================================================================
    // RSI-BASED EXITS: Require valid RSI to proceed
    // ============================================================================
    
    // Guard: RSI must be valid for all remaining exit checks
    if (!Number.isFinite(this.rsi)) return false;
    
    // 4. PRIMARY EXIT: RSI reached target (direction-specific)
    // Option A: Exit regardless of profit (current behavior with better labeling)
    // Option B: Only exit if profitable, otherwise wait for hard stop or reversal
    const requireProfitForTarget = this.cfg.rsiRequireProfitForTarget;
    
    // Use direction-specific targets (fallback to neutral)
    const targetLong = this._resolvedTargetLong ?? this.cfg.rsiTargetNeutral;
    const targetShort = this._resolvedTargetShort ?? this.cfg.rsiTargetNeutral;
    
    if (side === 'long' && this.rsi >= targetLong) {
      if (pnlPct > 0) {
        return {
          close: true,
          reason: 'rsi_target_reached',
          takeProfit: true,
          rsi: this.rsi,
          pnlPct,
        };
      }
      // RSI at target but not profitable
      if (!requireProfitForTarget) {
        // Exit anyway but mark as loss
        return {
          close: true,
          reason: pnlPct >= -0.001 ? 'rsi_target_breakeven' : 'rsi_target_loss',
          takeProfit: false,
          rsi: this.rsi,
          pnlPct,
        };
      }
      // If requireProfitForTarget, don't exit - let other exits handle it
    }
    if (side === 'short' && this.rsi <= targetShort) {
      if (pnlPct > 0) {
        return {
          close: true,
          reason: 'rsi_target_reached',
          takeProfit: true,
          rsi: this.rsi,
          pnlPct,
        };
      }
      // RSI at target but not profitable
      if (!requireProfitForTarget) {
        // Exit anyway but mark as loss
        return {
          close: true,
          reason: pnlPct >= -0.001 ? 'rsi_target_breakeven' : 'rsi_target_loss',
          takeProfit: false,
          rsi: this.rsi,
          pnlPct,
        };
      }
      // If requireProfitForTarget, don't exit - let other exits handle it
    }
    
    // 5. PARTIAL EXIT: RSI reached intermediate level (only if making progress toward target)
    // Skip if: explicit disable flag, OR partialTarget at extreme values (0 or 100)
    const partialGlobalDisabled = !this.cfg.rsiPartialEnabled;
    const partialLongDisabled = partialGlobalDisabled || this.cfg.rsiPartialTargetLong <= 0 || this.cfg.rsiPartialTargetLong >= 100;
    const partialShortDisabled = partialGlobalDisabled || this.cfg.rsiPartialTargetShort <= 0 || this.cfg.rsiPartialTargetShort >= 100;
    
    if (!position.tookPartial) {
      // For LONG: Partial only if RSI has risen toward target (50)
      // Skip partial if entry RSI was already above partial target
      if (side === 'long' && !partialLongDisabled) {
        const entryRsi = position.entryRsi;
        const partialTarget = this.cfg.rsiPartialTargetLong; // 35
        
        // Only take partial if entryRsi is known AND was below partial target
        // Don't use fallback logic when entryRsi is unknown - safer to skip partial
        const shouldTakePartial = (
          Number.isFinite(entryRsi) && entryRsi < partialTarget && this.rsi >= partialTarget
        );
        
        if (shouldTakePartial) {
          return {
            partial: true,
            percent: this.cfg.rsiPartialPercent,
            reason: 'rsi_partial_target',
            rsi: this.rsi,
            pnlPct,
          };
        }
      }
      
      // For SHORT: Partial only if RSI has fallen toward target (50)
      // Skip partial if entry RSI was already below partial target
      if (side === 'short' && !partialShortDisabled) {
        const entryRsi = position.entryRsi;
        const partialTarget = this.cfg.rsiPartialTargetShort; // 65
        
        // Only take partial if entryRsi is known AND was above partial target
        // Don't use fallback logic when entryRsi is unknown - safer to skip partial
        const shouldTakePartial = (
          Number.isFinite(entryRsi) && entryRsi > partialTarget && this.rsi <= partialTarget
        );
        
        if (shouldTakePartial) {
          return {
            partial: true,
            percent: this.cfg.rsiPartialPercent,
            reason: 'rsi_partial_target',
            rsi: this.rsi,
            pnlPct,
          };
        }
      }
    }
    
    // 6. FAILURE EXIT: RSI reversed back to extreme
    // Skip if explicitly disabled OR failureLong=0 (long) / failureShort=100 (short)
    const failureEnabled = this.cfg.rsiFailureEnabled;
    const failureLongDisabled = !failureEnabled || this.cfg.rsiFailureLong <= 0;
    const failureShortDisabled = !failureEnabled || this.cfg.rsiFailureShort >= 100;
    
    if (!failureLongDisabled && side === 'long' && this.rsi <= this.cfg.rsiFailureLong) {
      return {
        close: true,
        reason: 'rsi_failure_exit',
        stopLoss: true,
        rsi: this.rsi,
        pnlPct,
      };
    }
    if (!failureShortDisabled && side === 'short' && this.rsi >= this.cfg.rsiFailureShort) {
      return {
        close: true,
        reason: 'rsi_failure_exit',
        stopLoss: true,
        rsi: this.rsi,
        pnlPct,
      };
    }
    
    // 7. HARD STOP: Emergency stop (catastrophic protection)
    // RSI_HARD_STOP_PERCENT is % of COLLATERAL loss, not price movement
    // With leverage, price stop = collateral_stop% / leverage
    if (this.cfg.rsiHardStopEnabled) {
      let hardStopDistance = 0;
      const positionLeverage = position.leverage || 1;
      
      // Calculate both stop distances if configured, use the TIGHTER one
      let percentStopDistance = 0;
      let atrStopDistance = 0;
      
      // Percentage-based stop (collateral loss divided by leverage)
      if (this.cfg.rsiHardStopPercent > 0) {
        // 3% collateral stop with 5x leverage = 0.6% price movement
        percentStopDistance = entryPrice * (this.cfg.rsiHardStopPercent / 100) / positionLeverage;
      }
      
      // ATR-based stop
      if (this.cfg.rsiHardStopAtr > 0 && Number.isFinite(this.atr) && this.atr > 0) {
        atrStopDistance = this.atr * this.cfg.rsiHardStopAtr;
      }
      
      // Use the tighter (smaller) of the two stops if both are configured
      if (percentStopDistance > 0 && atrStopDistance > 0) {
        hardStopDistance = Math.min(percentStopDistance, atrStopDistance);
      } else {
        // Only one is configured, use whichever is set
        hardStopDistance = percentStopDistance > 0 ? percentStopDistance : atrStopDistance;
      }
      
      if (hardStopDistance > 0) {
        if (side === 'long' && price <= entryPrice - hardStopDistance) {
          return {
            close: true,
            reason: 'rsi_hard_stop',
            stopLoss: true,
            hardStop: true,
            stopPrice: entryPrice - hardStopDistance,
            pnlPct,
          };
        }
        if (side === 'short' && price >= entryPrice + hardStopDistance) {
          return {
            close: true,
            reason: 'rsi_hard_stop',
            stopLoss: true,
            hardStop: true,
            stopPrice: entryPrice + hardStopDistance,
            pnlPct,
          };
        }
      }
    }
    
    return false;
  }
  
  // ============================================================
  // SIGNAL GENERATION
  // ============================================================
  
  /**
   * Get trading signal
   */
  getSignal(price, positions = [], printGates = false, tickIndex = null) {
    this._tickCount++;

    // Reset per-tick entry debug (will be repopulated only if an extreme is pending)
    this._entryDebug.long = null;
    this._entryDebug.short = null;
    
    // Circuit breaker check
    if (this._isCircuitBreakerActive()) {
      const now = this._now();
      return {
        action: 'hold',
        reason: 'circuit_breaker_active',
        cooldownRemaining: this.circuitBreakerUntil - now,
      };
    }
    
    // Warmup check
    if (this._barCount < this.cfg.minBars) {
      return {
        action: 'hold',
        reason: 'warmup',
        barsRemaining: this.cfg.minBars - this._barCount,
      };
    }
    
    // RSI not ready
    if (!Number.isFinite(this.rsi)) {
      return {
        action: 'hold',
        reason: 'rsi_not_ready',
      };
    }
    
    // Check for existing position exits
    const hasLong = positions.some(p => p.side?.toLowerCase() === 'long' && !p.exitTime);
    const hasShort = positions.some(p => p.side?.toLowerCase() === 'short' && !p.exitTime);
    
    if (hasLong) {
      const longPos = positions.find(p => p.side?.toLowerCase() === 'long' && !p.exitTime);
      const closeSignal = this.shouldClose(longPos, price);
      if (closeSignal && (closeSignal.close || closeSignal.partial)) {
        return {
          action: closeSignal.partial ? 'partial_close' : 'close',
          side: 'long',
          ...closeSignal,
        };
      }
    }
    
    if (hasShort) {
      const shortPos = positions.find(p => p.side?.toLowerCase() === 'short' && !p.exitTime);
      const closeSignal = this.shouldClose(shortPos, price);
      if (closeSignal && (closeSignal.close || closeSignal.partial)) {
        return {
          action: closeSignal.partial ? 'partial_close' : 'close',
          side: 'short',
          ...closeSignal,
        };
      }
    }
    
    // Already in position - hold
    if (hasLong || hasShort) {
      return {
        action: 'hold',
        reason: 'already_in_position',
        rsi: this.rsi,
      };
    }
    
    // Time-of-day filter (UTC) - block entries during weak periods
    const nowTs = this._now();
    if (!this._isAllowedHourUtc(nowTs)) {
      const d = new Date(nowTs);
      const hour = d.getUTCHours();
      return {
        action: 'hold',
        reason: 'trading_disabled_hour_utc',
        disabledHourUtc: hour,
      };
    }
    
    // Check entry signals
    const oversoldEntry = this._checkOversoldReversalEntry(price);
    const overboughtEntry = this._checkOverboughtReversalEntry(price);
    
    // Log gate status if requested
    if (printGates) {
      console.log(`[RSI-Reversion] Gates: RSI=${this.rsi?.toFixed(1)} | ` +
        `oversold_extreme=${this._lastOversoldBar !== null && !this._oversoldConsumed ? 'YES' : 'NO'} | ` +
        `overbought_extreme=${this._lastOverboughtBar !== null && !this._overboughtConsumed ? 'YES' : 'NO'} | ` +
        `oversold_entry=${oversoldEntry ? 'YES' : 'NO'} | ` +
        `overbought_entry=${overboughtEntry ? 'YES' : 'NO'}`);
    }
    
    // Prioritize based on RSI extremity
    if (oversoldEntry && !overboughtEntry) {
      this._markEntry('long');
      // Don't consume setup until trade is confirmed - allows retry if allocator rejects
      // Setup will expire naturally via maxBars check
      
      // Calculate dynamic confidence based on how extreme the RSI was
      const confidence = this._calculateDynamicConfidence('long', this._lastOversoldRsi);
      
      return {
        action: 'open',
        side: 'long',
        confidence,
        reason: 'rsi_oversold_reversal',
        strategyType: 'rsi-reversion',
        entryRsi: this.rsi,
        extremeRsi: this._lastOversoldRsi, // Include for allocator debugging
        ...oversoldEntry,
      };
    }
    
    if (overboughtEntry && !oversoldEntry) {
      this._markEntry('short');
      // Don't consume setup until trade is confirmed - allows retry if allocator rejects
      // Setup will expire naturally via maxBars check
      
      // Calculate dynamic confidence based on how extreme the RSI was
      const confidence = this._calculateDynamicConfidence('short', this._lastOverboughtRsi);
      
      return {
        action: 'open',
        side: 'short',
        confidence,
        reason: 'rsi_overbought_reversal',
        strategyType: 'rsi-reversion',
        entryRsi: this.rsi,
        extremeRsi: this._lastOverboughtRsi, // Include for allocator debugging
        ...overboughtEntry,
      };
    }
    
    // Both signals (rare) - prefer the one with more extreme RSI
    if (oversoldEntry && overboughtEntry) {
      // This shouldn't happen often, but handle it
      const oversoldStrength = this.cfg.rsiOversoldRecovery - (this._lastOversoldRsi ?? 50);
      const overboughtStrength = (this._lastOverboughtRsi ?? 50) - this.cfg.rsiOverboughtRecovery;
      
      if (oversoldStrength >= overboughtStrength) {
        this._markEntry('long');
        // Don't consume setup until trade is confirmed
        const confidence = this._calculateDynamicConfidence('long', this._lastOversoldRsi);
        return {
          action: 'open',
          side: 'long',
          confidence,
          reason: 'rsi_oversold_reversal',
          strategyType: 'rsi-reversion',
          entryRsi: this.rsi,
          extremeRsi: this._lastOversoldRsi,
          ...oversoldEntry,
        };
      } else {
        this._markEntry('short');
        // Don't consume setup until trade is confirmed
        const confidence = this._calculateDynamicConfidence('short', this._lastOverboughtRsi);
        return {
          action: 'open',
          side: 'short',
          confidence,
          reason: 'rsi_overbought_reversal',
          strategyType: 'rsi-reversion',
          entryRsi: this.rsi,
          extremeRsi: this._lastOverboughtRsi,
          ...overboughtEntry,
        };
      }
    }
    
    // No entry signal
    return {
      action: 'hold',
      reason: 'no_rsi_reversal',
      rsi: this.rsi,
      oversoldPending: !this._oversoldConsumed && this._lastOversoldBar !== null,
      overboughtPending: !this._overboughtConsumed && this._lastOverboughtBar !== null,
      entryDebug: this._entryDebug,
    };
  }
  
  _markEntry(side) {
    const now = this._now();
    this._lastEntryTs = now;
    this._lastEntryBar = this._currentBarIndex;
    this._lastEntrySide = side;
    
    // Track per-side cooldowns
    if (side === 'long') {
      this._lastLongEntryTs = now;
    } else if (side === 'short') {
      this._lastShortEntryTs = now;
    }
  }
  
  /**
   * Confirm that a trade was executed (called by bot after successful execution)
   * This consumes the setup so it won't trigger again
   * @param {string} side - 'long' or 'short'
   */
  confirmTradeExecution(side) {
    const s = side?.toLowerCase();
    if (s === 'long') {
      this._oversoldConsumed = true;
      if (this.cfg.verbose) {
        console.log(`[RSI-Reversion] Long trade confirmed, oversold setup consumed`);
      }
    } else if (s === 'short') {
      this._overboughtConsumed = true;
      if (this.cfg.verbose) {
        console.log(`[RSI-Reversion] Short trade confirmed, overbought setup consumed`);
      }
    }
  }
  
  // ============================================================
  // LEGACY INTERFACE METHODS (for compatibility)
  // ============================================================
  
  shouldOpenLong(price) {
    const signal = this.getSignal(price);
    return signal.action === 'open' && signal.side === 'long';
  }
  
  shouldOpenShort(price) {
    const signal = this.getSignal(price);
    return signal.action === 'open' && signal.side === 'short';
  }
  
  // ============================================================
  // POSITION SIZING
  // ============================================================
  
  getRecommendedPositionSize(price, side, capital, opts = {}) {
    if (!Number.isFinite(price) || price <= 0) return 0;
    if (!Number.isFinite(capital) || capital <= 0) return 0;
    
    // Base position size
    const positionSizePercent = this.cfg.positionSizePercent / 100;
    let baseSize = capital * positionSizePercent;
    
    // Apply RSI-specific multiplier (smaller for counter-trend)
    baseSize *= this.cfg.rsiPositionSizeMultiplier;
    
    // Apply min/max constraints (read from config, not process.env to prevent bleeding)
    const minSize = this.cfg.minPositionSize ?? 50;
    const maxSize = this.cfg.maxPositionSize ?? 5000;
    
    baseSize = Math.max(minSize, Math.min(baseSize, maxSize));
    
    return baseSize;
  }
  
  // ============================================================
  // CIRCUIT BREAKER
  // ============================================================
  
  _isCircuitBreakerActive() {
    if (!this.circuitBreakerActive) return false;
    
    const now = this._now();
    if (now >= this.circuitBreakerUntil) {
      this.circuitBreakerActive = false;
      this.circuitBreakerUntil = null;
      this.consecutiveLosses = 0;
      this.circuitBreakerCooldownExpirations++;
      // Only log individual events if not in quiet mode (backtests use quiet mode)
      if (!this.cfg.quiet) {
        console.log('[RSI-Reversion] Circuit breaker cooldown expired, resuming');
      }
      return false;
    }
    
    return true;
  }
  
  // ============================================================
  // DYNAMIC CONFIDENCE CALCULATION
  // ============================================================
  
  /**
   * Calculate dynamic confidence based on RSI extremeness.
   * More extreme RSI = higher confidence = better allocator score.
   * 
   * For longs: confidence = base + (extreme - current_rsi) / scale
   *   - RSI at extreme (26) → base confidence
   *   - RSI below extreme (20) → higher confidence
   * 
   * For shorts: confidence = base + (current_rsi - extreme) / scale
   *   - RSI at extreme (70) → base confidence
   *   - RSI above extreme (80) → higher confidence
   * 
   * @param {string} side - 'long' or 'short'
   * @param {number} extremeRsi - The RSI value when extreme was hit (optional, uses last tracked)
   * @returns {number} Confidence value (0.5 to 1.0 typically)
   */
  _calculateDynamicConfidence(side, extremeRsi = null) {
    if (!this.cfg.rsiDynamicConfidence) {
      // Dynamic confidence disabled, return fixed value
      return side === 'long' ? 0.7 : -0.7;
    }
    
    const base = this.cfg.rsiDynamicConfidenceBase;
    const scale = this.cfg.rsiDynamicConfidenceScale;
    
    let deviation = 0;
    
    if (side === 'long') {
      // For longs, use the extreme RSI that triggered the setup
      const oversoldExtreme = extremeRsi ?? this._lastOversoldRsi ?? this.cfg.rsiOversoldExtreme;
      // More extreme (lower) RSI = higher confidence
      // Deviation = how far below the recovery level the extreme was
      deviation = this.cfg.rsiOversoldRecovery - oversoldExtreme;
    } else {
      // For shorts, use the extreme RSI that triggered the setup
      const overboughtExtreme = extremeRsi ?? this._lastOverboughtRsi ?? this.cfg.rsiOverboughtExtreme;
      // More extreme (higher) RSI = higher confidence
      // Deviation = how far above the recovery level the extreme was
      deviation = overboughtExtreme - this.cfg.rsiOverboughtRecovery;
    }
    
    // Calculate confidence: base + (deviation / scale), clamped to [0.3, 1.0]
    const rawConfidence = base + (deviation / scale);
    const clampedConfidence = Math.max(0.3, Math.min(1.0, rawConfidence));
    
    // Return with sign convention: positive for longs, negative for shorts
    return side === 'long' ? clampedConfidence : -clampedConfidence;
  }
  
  // ============================================================
  // PERFORMANCE TRACKING
  // ============================================================
  
  recordTrade(trade) {
    if (!trade || typeof trade !== 'object') return;
    
    const { pnlUsd = 0, pnlPercent = 0, exitReason = 'unknown' } = trade;
    const now = this._now();
    
    this.totalTrades++;
    
    if (pnlUsd > 0) {
      this.winningTrades++;
      this.consecutiveLosses = 0;
    } else if (pnlUsd < 0) {
      this.losingTrades++;
      this.consecutiveLosses++;
      
      if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        this.circuitBreakerActive = true;
        this.circuitBreakerUntil = now + this.cfg.circuitBreakerCooldownMs;
        this.circuitBreakerActivations++;
        // Only log individual events if not in quiet mode (backtests use quiet mode)
        if (!this.cfg.quiet) {
          console.warn(`[RSI-Reversion] Circuit breaker activated after ${this.consecutiveLosses} consecutive losses`);
        }
      }
    }
    
    this.totalPnL += pnlUsd;
    
    this.tradeHistory.push({
      ...trade,
      tradeNumber: this.totalTrades,
      recordedAt: now,
    });
    
    if (this.tradeHistory.length > this.maxTradeHistory) {
      this.tradeHistory.shift();
    }
    
    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0;
    if (!this.cfg.quiet) {
      console.log(`[RSI-Reversion] Trade #${this.totalTrades}: ${exitReason} | PnL: $${pnlUsd.toFixed(2)} | Win rate: ${(winRate * 100).toFixed(1)}%`);
    }
  }
  
  // ============================================================
  // STATISTICS
  // ============================================================
  
  /**
   * Log circuit breaker summary (useful for backtest aggregation)
   */
  logCircuitBreakerSummary() {
    if (this.circuitBreakerActivations > 0 || this.circuitBreakerCooldownExpirations > 0) {
      console.log(`[RSI-Reversion] Circuit breaker summary: ${this.circuitBreakerActivations} activation(s), ${this.circuitBreakerCooldownExpirations} cooldown expiration(s)`);
    }
  }
  
  getStats() {
    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0;
    
    return {
      market: this.cfg.market,
      strategyType: 'rsi-reversion',
      barCount: this._barCount,
      tickCount: this._tickCount,
      currentRsi: this.rsi,
      currentAtr: this.atr,
      currentEma: this._ema,
      currentEmaSlope: this._emaSlope,
      regimeFilterEnabled: this.cfg.rsiRegimeFilterEnabled,
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      winRate,
      totalPnL: this.totalPnL,
      consecutiveLosses: this.consecutiveLosses,
      circuitBreakerActive: this.circuitBreakerActive,
      circuitBreakerActivations: this.circuitBreakerActivations,
      circuitBreakerCooldownExpirations: this.circuitBreakerCooldownExpirations,
      pendingOversold: !this._oversoldConsumed && this._lastOversoldBar !== null,
      pendingOverbought: !this._overboughtConsumed && this._lastOverboughtBar !== null,
      config: {
        rsiOversoldExtreme: this.cfg.rsiOversoldExtreme,
        rsiOversoldRecovery: this.cfg.rsiOversoldRecovery,
        rsiOverboughtExtreme: this.cfg.rsiOverboughtExtreme,
        rsiOverboughtRecovery: this.cfg.rsiOverboughtRecovery,
        rsiTargetNeutral: this.cfg.rsiTargetNeutral,
        rsiTargetLong: this._resolvedTargetLong ?? this.cfg.rsiTargetNeutral,
        rsiTargetShort: this._resolvedTargetShort ?? this.cfg.rsiTargetNeutral,
      },
    };
  }
  
  // ============================================================
  // RESET
  // ============================================================
  
  reset() {
    this.prices = [];
    this.highs = [];
    this.lows = [];
    this.volumes = [];
    this.timestamps = [];
    
    this.rsi = null;
    this._rsiAvgGain = null;
    this._rsiAvgLoss = null;
    this._rsiHistory = [];
    
    this._lastOversoldBar = null;
    this._lastOversoldRsi = null;
    this._lastOverboughtBar = null;
    this._lastOverboughtRsi = null;
    this._oversoldConsumed = true;
    this._overboughtConsumed = true;
    
    this.atr = null;
    this._trueRanges = [];
    this._prevClose = null;
    
    // Reset EMA state (regime filter)
    this._ema = null;
    this._emaSlope = null;
    
    this._barCount = 0;
    this._currentBarIndex = 0;
    this._tickCount = 0;
    this._nowTs = null;
    
    this._lastEntryTs = 0;
    this._lastEntryBar = null;
    this._lastEntrySide = null;
    // Reset per-side cooldowns
    this._lastLongEntryTs = 0;
    this._lastShortEntryTs = 0;

    this._entryDebug = { long: null, short: null };
    
    this.consecutiveLosses = 0;
    this.circuitBreakerActive = false;
    this.circuitBreakerUntil = null;
    this.circuitBreakerActivations = 0;
    this.circuitBreakerCooldownExpirations = 0;
    
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.totalPnL = 0;
    this.tradeHistory = [];
    
    console.log('[RSI-Reversion] Strategy reset');
  }
}

module.exports = RsiMeanReversionStrategy;

