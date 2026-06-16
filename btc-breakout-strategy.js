// btc-breakout-strategy.js
//
// BTC Breakout Strategy
//
// Entry:
//   - Long: close-confirmed breakout above prior entry channel high
//   - Short: close-confirmed breakdown below prior entry channel low
//   - Regime: price must align with trend EMA and slope filter
//
// Exit:
//   - Primary: opposite exit-channel break
//   - Secondary: ATR trailing stop
//   - Catastrophic: ATR / percent hard stop
//   - Optional: time stop
//
// Public methods (compatible with bot.js and backtest):
//   - update({ price, close, volume, high, low, ts }) - Bar completion
//   - updateTick({ price, volume, ts }) - Tick update
//   - recalculateLastBar({ close, high, low, volume }) - Intra-bar snapshot
//   - getSignal(price, positions) - Signal generation
//   - shouldClose(position, price) - Exit check
//   - reset() - Clear state
//   - getRecommendedPositionSize(price, side, capital) - Position sizing
//   - recordTrade(trade) - Performance tracking
//   - getStats() - Statistics

class BtcBreakoutStrategy {
  constructor(config = {}) {
    const compatibilityRsiConfig = config.rsiStrategy || null;
    const mapCompatRsiConfig = (src) => {
      if (!src || typeof src !== "object") return null;
      return {
        atrPeriod: src.atrPeriod,
        hardStopEnabled: src.rsiHardStopEnabled,
        hardStopPercent: src.rsiHardStopPercent,
        atrStopMult: src.rsiHardStopAtr,
        timeStopBars: src.rsiTimeStopBars,
        minVolatilityPct: src.rsiMinVolatilityPct,
        maxVolatilityPct: src.rsiMaxVolatilityPct,
      };
    };
    const s =
      config.breakoutStrategy || config.strategy || mapCompatRsiConfig(compatibilityRsiConfig) || {};

    const num = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      const n = Number(envVal);
      return Number.isFinite(n) ? n : fallback;
    };

    const bool = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      if (typeof envVal === "boolean") return envVal;
      const normalized = String(envVal).trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
      return fallback;
    };

    const trendEmaPeriod = s.trendEmaPeriod ?? num(process.env.BREAKOUT_TREND_EMA_PERIOD, 200);
    const trendSlopeLookback =
      s.trendSlopeLookback ?? num(process.env.BREAKOUT_TREND_SLOPE_LOOKBACK, 20);
    const atrPeriod = s.atrPeriod ?? num(process.env.BREAKOUT_ATR_PERIOD, num(process.env.ATR_PERIOD, 20));
    const entryChannel = s.entryChannel ?? num(process.env.BREAKOUT_ENTRY_CHANNEL, 20);
    const exitChannel = s.exitChannel ?? num(process.env.BREAKOUT_EXIT_CHANNEL, 10);

    this.cfg = {
      market: config.market || "UNKNOWN",

      trendEmaPeriod,
      trendSlopeLookback,
      trendSlopeThreshold:
        s.trendSlopeThreshold ?? num(process.env.BREAKOUT_TREND_SLOPE_THRESHOLD, 0),

      entryChannel,
      exitChannel,
      entryMode:
        s.entryMode ?? String(process.env.BREAKOUT_ENTRY_MODE || "breakout").trim().toLowerCase(),
      confirmCloseOnly:
        s.confirmCloseOnly ?? bool(process.env.BREAKOUT_CONFIRM_CLOSE_ONLY, true),
      requireVolumeConfirmation:
        s.requireVolumeConfirmation ??
        bool(process.env.BREAKOUT_REQUIRE_VOLUME_CONFIRMATION, false),
      volumeLookback: s.volumeLookback ?? num(process.env.BREAKOUT_VOLUME_LOOKBACK, 20),
      volumeSpikeThreshold:
        s.volumeSpikeThreshold ?? num(process.env.BREAKOUT_VOLUME_SPIKE_THRESHOLD, 1.5),
      entryBufferBps: s.entryBufferBps ?? num(process.env.BREAKOUT_ENTRY_BUFFER_BPS, 0),
      maxEntryDistAtr: s.maxEntryDistAtr ?? num(process.env.BREAKOUT_MAX_ENTRY_DIST_ATR, 0),
      breakoutMinBarRangeAtr:
        s.breakoutMinBarRangeAtr ?? num(process.env.BREAKOUT_MIN_BAR_RANGE_ATR, 0),
      breakoutMinCloseLocation:
        s.breakoutMinCloseLocation ?? num(process.env.BREAKOUT_MIN_CLOSE_LOCATION, 0),
      breakoutMinVolumeRatio:
        s.breakoutMinVolumeRatio ?? num(process.env.BREAKOUT_MIN_VOLUME_RATIO, 0),
      breakoutMinBreakDistanceAtr:
        s.breakoutMinBreakDistanceAtr ??
        num(process.env.BREAKOUT_MIN_BREAK_DISTANCE_ATR, 0),
      pullbackRetestAtr:
        s.pullbackRetestAtr ?? num(process.env.BREAKOUT_PULLBACK_RETEST_ATR, 0.75),
      pullbackSetupExpiryBars:
        s.pullbackSetupExpiryBars ??
        num(
          process.env.BREAKOUT_PULLBACK_SETUP_EXPIRY_BARS,
          Math.max(3, Math.min(exitChannel, 10))
        ),
      fibRetraceLevel:
        s.fibRetraceLevel ?? num(process.env.BREAKOUT_FIB_RETRACE_LEVEL, 0.618),
      fibPocketLowerLevel:
        s.fibPocketLowerLevel ?? num(process.env.BREAKOUT_FIB_POCKET_LOWER_LEVEL, 0.65),
      fibZoneShallowLevel:
        s.fibZoneShallowLevel ?? num(process.env.BREAKOUT_FIB_ZONE_SHALLOW_LEVEL, 0.382),
      fibZoneMidLevel:
        s.fibZoneMidLevel ?? num(process.env.BREAKOUT_FIB_ZONE_MID_LEVEL, 0.5),
      fibZoneDeepLevel:
        s.fibZoneDeepLevel ?? num(process.env.BREAKOUT_FIB_ZONE_DEEP_LEVEL, 0.618),
      fibInvalidationLevel:
        s.fibInvalidationLevel ?? num(process.env.BREAKOUT_FIB_INVALIDATION_LEVEL, 0.786),
      fibRetraceConfirmCloseLocation:
        s.fibRetraceConfirmCloseLocation ??
        num(process.env.BREAKOUT_FIB_CONFIRM_CLOSE_LOCATION, 0.5),
      fibSwingLookbackBars:
        s.fibSwingLookbackBars ?? num(process.env.BREAKOUT_FIB_SWING_LOOKBACK_BARS, 40),
      fibSwingPivotStrength:
        s.fibSwingPivotStrength ?? num(process.env.BREAKOUT_FIB_SWING_PIVOT_STRENGTH, 2),
      fibMinSwingRangeAtr:
        s.fibMinSwingRangeAtr ?? num(process.env.BREAKOUT_FIB_MIN_SWING_RANGE_ATR, 0),
      fibRequireConfirmedSwing:
        s.fibRequireConfirmedSwing ??
        bool(process.env.BREAKOUT_FIB_REQUIRE_CONFIRMED_SWING, false),
      fibMinConfluenceCount:
        s.fibMinConfluenceCount ?? num(process.env.BREAKOUT_FIB_MIN_CONFLUENCE_COUNT, 0),
      fibConfluenceToleranceAtr:
        s.fibConfluenceToleranceAtr ??
        num(process.env.BREAKOUT_FIB_CONFLUENCE_TOLERANCE_ATR, 0.35),
      fibUseBreakoutLevelConfluence:
        s.fibUseBreakoutLevelConfluence ??
        bool(process.env.BREAKOUT_FIB_USE_BREAKOUT_LEVEL_CONFLUENCE, false),
      fibUseEmaConfluence:
        s.fibUseEmaConfluence ??
        bool(process.env.BREAKOUT_FIB_USE_EMA_CONFLUENCE, false),
      fibUseAnchoredVwapConfluence:
        s.fibUseAnchoredVwapConfluence ??
        bool(process.env.BREAKOUT_FIB_USE_ANCHORED_VWAP_CONFLUENCE, false),
      fibAnchoredVwapSource:
        s.fibAnchoredVwapSource ??
        String(process.env.BREAKOUT_FIB_ANCHORED_VWAP_SOURCE || "swing")
          .trim()
          .toLowerCase(),

      enableOppositeChannelExit:
        s.enableOppositeChannelExit ??
        bool(process.env.BREAKOUT_ENABLE_OPPOSITE_CHANNEL_EXIT, true),
      enableRegimeFailureExit:
        s.enableRegimeFailureExit ??
        bool(process.env.BREAKOUT_ENABLE_REGIME_FAILURE_EXIT, false),
      regimeFailureMode:
        s.regimeFailureMode ??
        String(process.env.BREAKOUT_REGIME_FAILURE_MODE || "ema_cross")
          .trim()
          .toLowerCase(),
      enableAtrTrail:
        s.enableAtrTrail ?? bool(process.env.BREAKOUT_ENABLE_ATR_TRAIL, true),
      atrTrailMult: s.atrTrailMult ?? num(process.env.BREAKOUT_ATR_TRAIL_MULT, 3.0),
      timeStopBars: s.timeStopBars ?? num(process.env.BREAKOUT_TIME_STOP_BARS, 0),
      staleTimeStopEnabled:
        s.staleTimeStopEnabled ?? bool(process.env.BREAKOUT_STALE_TIME_STOP_ENABLED, false),
      staleTimeStopMinProfitAtr:
        s.staleTimeStopMinProfitAtr ??
        num(process.env.BREAKOUT_STALE_TIME_STOP_MIN_PROFIT_ATR, 0.5),
      staleTimeStopRequireTrendFailure:
        s.staleTimeStopRequireTrendFailure ??
        bool(process.env.BREAKOUT_STALE_TIME_STOP_REQUIRE_TREND_FAILURE, false),
      // Backtest/research-only for now: not wired into live env selection yet.
      runnerEnabled: bool(s.runnerEnabled, false),
      runnerSizeFraction: num(s.runnerSizeFraction, 0.25),
      runnerMinProfitAtr: num(s.runnerMinProfitAtr, 0.75),
      enablePartialExit:
        s.enablePartialExit ?? bool(process.env.BREAKOUT_ENABLE_PARTIAL_EXIT, false),
      partialAtR: s.partialAtR ?? num(process.env.BREAKOUT_PARTIAL_AT_R, 0),
      partialExitPercent:
        s.partialExitPercent ?? num(process.env.BREAKOUT_PARTIAL_EXIT_PERCENT, 50),
      requireProfitForExit:
        s.requireProfitForExit ?? bool(process.env.BREAKOUT_REQUIRE_PROFIT_FOR_EXIT, false),

      hardStopEnabled:
        s.hardStopEnabled ?? bool(process.env.BREAKOUT_HARD_STOP_ENABLED, true),
      hardStopPercent: s.hardStopPercent ?? num(process.env.BREAKOUT_HARD_STOP_PERCENT, 0),
      atrStopMult: s.atrStopMult ?? num(process.env.BREAKOUT_ATR_STOP_MULT, 2.5),
      atrPeriod,

      minVolatilityPct:
        s.minVolatilityPct ?? num(process.env.BREAKOUT_MIN_VOLATILITY_PCT, 0),
      maxVolatilityPct:
        s.maxVolatilityPct ?? num(process.env.BREAKOUT_MAX_VOLATILITY_PCT, 20),

      regimeFilterEnabled:
        s.regimeFilterEnabled ?? bool(process.env.BREAKOUT_REGIME_FILTER_ENABLED, true),
      regimeEmaPeriod:
        s.regimeEmaPeriod ?? num(process.env.BREAKOUT_REGIME_EMA_PERIOD, trendEmaPeriod),
      regimeSlopeLookback:
        s.regimeSlopeLookback ??
        num(process.env.BREAKOUT_REGIME_SLOPE_LOOKBACK, trendSlopeLookback),
      regimeSlopeThreshold:
        s.regimeSlopeThreshold ?? num(process.env.BREAKOUT_REGIME_SLOPE_THRESHOLD, 0),

      allowLongs: s.allowLongs ?? bool(process.env.ALLOW_LONGS, true),
      allowShorts: s.allowShorts ?? bool(process.env.ALLOW_SHORTS, true),

      maxConsecutiveLosses:
        s.maxConsecutiveLosses ?? num(process.env.BREAKOUT_MAX_CONSECUTIVE_LOSSES, 3),
      circuitBreakerCooldownMs:
        s.circuitBreakerCooldownMs ??
        num(process.env.BREAKOUT_CIRCUIT_BREAKER_COOLDOWN_MS, 4 * 60 * 60 * 1000),

      dynamicConfidence:
        s.dynamicConfidence ?? bool(process.env.BREAKOUT_DYNAMIC_CONFIDENCE, true),
      dynamicConfidenceBase:
        s.dynamicConfidenceBase ?? num(process.env.BREAKOUT_DYNAMIC_CONFIDENCE_BASE, 0.5),
      dynamicConfidenceScale:
        s.dynamicConfidenceScale ?? num(process.env.BREAKOUT_DYNAMIC_CONFIDENCE_SCALE, 1.0),

      enableCooldown: s.enableCooldown ?? bool(process.env.ENABLE_COOLDOWN, true),
      cooldownMs: s.cooldownMs ?? num(process.env.COOLDOWN_MS, 5 * 60 * 1000),
      cooldownLongMs: s.cooldownLongMs ?? num(process.env.COOLDOWN_LONG_MS, 0),
      cooldownShortMs: s.cooldownShortMs ?? num(process.env.COOLDOWN_SHORT_MS, 0),
      flipCooldownMs: s.flipCooldownMs ?? num(process.env.FLIP_COOLDOWN_MS, 4 * 60 * 60 * 1000),
      minBarsSameSideReentry:
        s.minBarsSameSideReentry ?? num(process.env.MIN_BARS_SAME_SIDE_REENTRY, 1),

      tradingDisabledHoursUtc: this._parseHourList(
        s.tradingDisabledHoursUtc ?? process.env.TRADING_DISABLED_HOURS_UTC,
        ""
      ),
      tradingAllowedHoursUtc: this._parseHourList(
        s.tradingAllowedHoursUtc ?? process.env.TRADING_ALLOWED_HOURS_UTC,
        ""
      ),

      positionSizePercent: s.positionSizePercent ?? num(process.env.POSITION_SIZE_PERCENT, 25),
      volatilityScaleBase: s.volatilityScaleBase ?? num(process.env.VOLATILITY_SCALE_BASE, 0.02),
      riskPerTradePercent: s.riskPerTradePercent ?? num(process.env.RISK_PER_TRADE_PERCENT, 0.5),
      minPositionSize: s.minPositionSize ?? num(process.env.MIN_POSITION_SIZE, 50),
      maxPositionSize: s.maxPositionSize ?? num(process.env.MAX_POSITION_SIZE, 5000),

      minBars:
        s.minBars ??
        num(
          process.env.MIN_BARS,
          Math.max(250, trendEmaPeriod + trendSlopeLookback + 5, atrPeriod * 3, entryChannel + 5)
        ),

      maxBufferBars:
        s.maxBufferBars ??
        Math.max(2000, trendEmaPeriod + trendSlopeLookback + 250, entryChannel + 250, atrPeriod * 10),

      verbose: s.verbose ?? bool(process.env.DEBUG_BREAKOUT_STRATEGY, false),
      quiet: config.quiet ?? false,
    };

    // Compatibility aliases so mirrored RSI-oriented backtest/reporting code can
    // pass breakout settings through existing field names without breaking.
    this.cfg.rsiHardStopEnabled = this.cfg.hardStopEnabled;
    this.cfg.rsiHardStopPercent = this.cfg.hardStopPercent;
    this.cfg.rsiHardStopAtr = this.cfg.atrStopMult;
    this.cfg.rsiTimeStopBars = this.cfg.timeStopBars;
    this.cfg.rsiEnableTrailingStop = this.cfg.enableAtrTrail;

    this.prices = [];
    this.highs = [];
    this.lows = [];
    this.volumes = [];
    this.timestamps = [];

    this.atr = null;
    this._trueRanges = [];
    this._prevClose = null;

    this._ema = null;
    this._emaSlope = null;
    this._emaHistory = [];

    this.entryChannelHigh = null;
    this.entryChannelLow = null;
    this.exitChannelHigh = null;
    this.exitChannelLow = null;
    this.volumeAvg = null;
    this.volumeSpike = false;

    this._barCount = 0;
    this._currentBarIndex = 0;
    this._tickCount = 0;
    this._nowTs = null;

    this._lastEntryTs = 0;
    this._lastEntryBar = null;
    this._lastEntrySide = null;
    this._lastLongEntryTs = 0;
    this._lastShortEntryTs = 0;
    this._entryDebug = { long: null, short: null };
    this._pendingPullbackSetup = { long: null, short: null };

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
    this.maxTradeHistory = 100;

    if (!this.cfg.quiet) {
      console.log(`[BTC-Breakout] Initialized for ${this.cfg.market}`);
      console.log(
        `[BTC-Breakout] Entry: EMA=${this.cfg.trendEmaPeriod}, slopeLookback=${this.cfg.trendSlopeLookback}, channel=${this.cfg.entryChannel}, mode=${this.cfg.entryMode}, closeOnly=${this.cfg.confirmCloseOnly}`
      );
      console.log(
        `[BTC-Breakout] Exit: oppositeChannel=${this.cfg.enableOppositeChannelExit ? this.cfg.exitChannel : "off"}, regimeFail=${this.cfg.enableRegimeFailureExit ? this.cfg.regimeFailureMode : "off"}, atrTrail=${this.cfg.enableAtrTrail ? this.cfg.atrTrailMult + "x" : "off"}, timeStop=${this.cfg.timeStopBars || 0}${this.cfg.staleTimeStopEnabled ? ` stale<${this.cfg.staleTimeStopMinProfitAtr}ATR${this.cfg.staleTimeStopRequireTrendFailure ? "+trendFail" : ""}` : ""}${this.cfg.runnerEnabled ? ` runner=${this.cfg.runnerSizeFraction}@${this.cfg.runnerMinProfitAtr}ATR` : ""}`
      );
      console.log(
        `[BTC-Breakout] Hard Stop: enabled=${this.cfg.hardStopEnabled}, percent=${this.cfg.hardStopPercent}%, ATR=${this.cfg.atrStopMult}x`
      );
      console.log(
        `[BTC-Breakout] Filters: volatility=${this.cfg.minVolatilityPct}-${this.cfg.maxVolatilityPct}% | regime=${this.cfg.regimeFilterEnabled ? "on" : "off"} | dirs=${this.cfg.allowLongs ? "L" : "-"}${this.cfg.allowShorts ? "S" : "-"}`
      );
    }
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  _ok(...xs) {
    return xs.every((v) => Number.isFinite(v));
  }

  _now() {
    return Number.isFinite(this._nowTs) ? this._nowTs : Date.now();
  }

  _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  _setEntryDebug(side, reason, details = {}) {
    const key = side === "short" ? "short" : "long";
    this._entryDebug[key] = {
      side: key,
      reason,
      ...(details && typeof details === "object" ? details : {}),
    };
  }

  _clearEntryDebug(side) {
    const key = side === "short" ? "short" : "long";
    this._entryDebug[key] = null;
  }

  _getPullbackSetup(side) {
    const key = side === "short" ? "short" : "long";
    const setup = this._pendingPullbackSetup[key];
    if (!setup) return null;
    if (
      Number.isFinite(setup.expiresBarIndex) &&
      Number.isFinite(this._currentBarIndex) &&
      this._currentBarIndex > setup.expiresBarIndex
    ) {
      this._pendingPullbackSetup[key] = null;
      return null;
    }
    return setup;
  }

  _setPullbackSetup(side, setup) {
    const key = side === "short" ? "short" : "long";
    if (!setup || typeof setup !== "object") {
      this._pendingPullbackSetup[key] = null;
      return;
    }
    this._pendingPullbackSetup[key] = {
      ...setup,
      side: key,
    };
  }

  _clearPullbackSetup(side) {
    const key = side === "short" ? "short" : "long";
    this._pendingPullbackSetup[key] = null;
  }

  _entryUsesAnchoredPullbackSetup(entryMode) {
    return ["pullback", "fib_pullback", "fib_retrace"].includes(
      String(entryMode || "").trim().toLowerCase()
    );
  }

  _cooldownRemainingMs(side) {
    if (this.cfg.enableCooldown === false) return 0;

    const now = this._now();

    if (side === "long" && (this.cfg.cooldownLongMs || 0) > 0) {
      return Math.max(0, this.cfg.cooldownLongMs - (now - this._lastLongEntryTs));
    }
    if (side === "short" && (this.cfg.cooldownShortMs || 0) > 0) {
      return Math.max(0, this.cfg.cooldownShortMs - (now - this._lastShortEntryTs));
    }

    return Math.max(0, (this.cfg.cooldownMs || 0) - (now - this._lastEntryTs));
  }

  _parseHourList(hourStr, defaultVal) {
    if (!hourStr || typeof hourStr !== "string") return defaultVal;
    const trimmed = hourStr.trim();
    if (!trimmed) return defaultVal;
    try {
      const hours = trimmed
        .split(",")
        .map((h) => {
          const n = parseInt(h.trim(), 10);
          return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
        })
        .filter((h) => h !== null);
      return hours.length > 0 ? hours : defaultVal;
    } catch {
      return defaultVal;
    }
  }

  _isAllowedHourUtc(ts) {
    const d = new Date(ts);
    const hour = d.getUTCHours();

    if (this.cfg.tradingAllowedHoursUtc && this.cfg.tradingAllowedHoursUtc.length > 0) {
      return this.cfg.tradingAllowedHoursUtc.includes(hour);
    }
    if (this.cfg.tradingDisabledHoursUtc && this.cfg.tradingDisabledHoursUtc.length > 0) {
      return !this.cfg.tradingDisabledHoursUtc.includes(hour);
    }
    return true;
  }

  _markEntry(side) {
    const now = this._now();
    this._lastEntryTs = now;
    this._lastEntryBar = this._currentBarIndex;
    this._lastEntrySide = side;
    if (side === "long") this._lastLongEntryTs = now;
    if (side === "short") this._lastShortEntryTs = now;
  }

  _reentryBlocked(side) {
    if (!Number.isFinite(this._lastEntryBar) || this._lastEntrySide == null) return null;

    const barsSinceLastEntry = this._currentBarIndex - this._lastEntryBar;
    if (
      this._lastEntrySide === side &&
      barsSinceLastEntry < (this.cfg.minBarsSameSideReentry || 0)
    ) {
      return {
        reason: "same_side_reentry_blocked",
        barsSinceLastEntry,
        minBarsSameSideReentry: this.cfg.minBarsSameSideReentry,
      };
    }

    if (
      this._lastEntrySide !== side &&
      (this.cfg.flipCooldownMs || 0) > 0 &&
      this._now() - this._lastEntryTs < this.cfg.flipCooldownMs
    ) {
      return {
        reason: "flip_cooldown_active",
        cooldownRemainingMs: this.cfg.flipCooldownMs - (this._now() - this._lastEntryTs),
      };
    }

    return null;
  }

  confirmTradeExecution(side) {
    if (this.cfg.verbose) {
      console.log(`[BTC-Breakout] Trade confirmed for ${String(side || "").toLowerCase()}`);
    }
  }

  // ============================================================
  // UPDATE METHODS
  // ============================================================

  update({ price, close, volume = 0, high, low, ts = Date.now() }) {
    const closePrice = close ?? price;
    if (!Number.isFinite(closePrice) || closePrice <= 0) return;

    const highValue = Number.isFinite(high) ? high : closePrice;
    const lowValue = Number.isFinite(low) ? low : closePrice;

    this._barCount++;
    this._currentBarIndex++;
    this._nowTs = ts;

    this.prices.push(closePrice);
    this.highs.push(highValue);
    this.lows.push(lowValue);
    this.volumes.push(Number.isFinite(volume) ? volume : 0);
    this.timestamps.push(ts);

    while (this.prices.length > this.cfg.maxBufferBars) {
      this.prices.shift();
      this.highs.shift();
      this.lows.shift();
      this.volumes.shift();
      this.timestamps.shift();
    }

    this._updateAtr(highValue, lowValue, closePrice);
    this._updateEma(closePrice);
    this._updateChannels();
    this._updateVolumeStats();
  }

  updateTick(payload, volume = 0, ts = Date.now()) {
    if (typeof payload === "number") {
      if (!Number.isFinite(payload) || payload <= 0) return;
      this._tickCount++;
      this._nowTs = ts;
      return;
    }

    const price = payload?.price;
    const nowTs = payload?.ts ?? ts;
    if (!Number.isFinite(price) || price <= 0) return;

    this._tickCount++;
    this._nowTs = nowTs;
  }

  recalculateLastBar({ close, high, low, volume }) {
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
  // INDICATORS
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
    if (this._trueRanges.length > this.cfg.atrPeriod * 3) {
      this._trueRanges.shift();
    }

    if (this._trueRanges.length >= this.cfg.atrPeriod) {
      if (this.atr === null) {
        this.atr =
          this._trueRanges.slice(-this.cfg.atrPeriod).reduce((a, b) => a + b, 0) /
          this.cfg.atrPeriod;
      } else {
        this.atr = (this.atr * (this.cfg.atrPeriod - 1) + tr) / this.cfg.atrPeriod;
      }
    }

    this._prevClose = close;
  }

  _updateEma(close) {
    const period = this.cfg.regimeEmaPeriod;
    if (!Number.isFinite(period) || period <= 0) return;

    const n = this.prices.length;
    if (n < period) {
      this._ema = null;
      this._emaSlope = null;
      return;
    }

    const prevEma = this._ema;

    if (prevEma === null) {
      let sum = 0;
      for (let i = n - period; i < n; i++) sum += this.prices[i];
      this._ema = sum / period;
    } else {
      const k = 2 / (period + 1);
      this._ema = (close - prevEma) * k + prevEma;
    }

    this._emaHistory.push(this._ema);
    if (this._emaHistory.length > this.cfg.maxBufferBars) {
      this._emaHistory.shift();
    }

    const lookback = Math.max(1, Math.floor(this.cfg.regimeSlopeLookback || 1));
    if (this._emaHistory.length > lookback) {
      const priorEma = this._emaHistory[this._emaHistory.length - 1 - lookback];
      this._emaSlope =
        Number.isFinite(priorEma) && priorEma > 0
          ? ((this._ema - priorEma) / priorEma) * 100
          : null;
    } else {
      this._emaSlope = null;
    }
  }

  _donchianUpper(period) {
    const n = this.highs.length;
    if (!Number.isFinite(period) || period <= 0 || n <= period) return null;

    let maxHigh = -Infinity;
    for (let i = n - period - 1; i < n - 1; i++) {
      if (Number.isFinite(this.highs[i])) maxHigh = Math.max(maxHigh, this.highs[i]);
    }
    return Number.isFinite(maxHigh) ? maxHigh : null;
  }

  _donchianLower(period) {
    const n = this.lows.length;
    if (!Number.isFinite(period) || period <= 0 || n <= period) return null;

    let minLow = Infinity;
    for (let i = n - period - 1; i < n - 1; i++) {
      if (Number.isFinite(this.lows[i])) minLow = Math.min(minLow, this.lows[i]);
    }
    return Number.isFinite(minLow) ? minLow : null;
  }

  _updateChannels() {
    this.entryChannelHigh = this._donchianUpper(this.cfg.entryChannel);
    this.entryChannelLow = this._donchianLower(this.cfg.entryChannel);
    this.exitChannelHigh = this._donchianUpper(this.cfg.exitChannel);
    this.exitChannelLow = this._donchianLower(this.cfg.exitChannel);
  }

  _updateVolumeStats() {
    const lookback = Math.max(1, Math.floor(this.cfg.volumeLookback || 1));
    const n = this.volumes.length;
    if (n <= lookback) {
      this.volumeAvg = null;
      this.volumeSpike = false;
      return;
    }

    let sum = 0;
    for (let i = n - lookback - 1; i < n - 1; i++) {
      sum += Math.max(0, Number(this.volumes[i] || 0));
    }
    this.volumeAvg = sum / lookback;

    const currentVol = Math.max(0, Number(this.volumes[n - 1] || 0));
    this.volumeSpike =
      Number.isFinite(this.volumeAvg) &&
      this.volumeAvg > 0 &&
      currentVol >= this.volumeAvg * this.cfg.volumeSpikeThreshold;
  }

  _findLowestIndex(values, startIndex, endIndex) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const start = Math.max(0, Math.floor(startIndex || 0));
    const end = Math.min(values.length - 1, Math.floor(endIndex || values.length - 1));
    if (end < start) return null;

    let bestIndex = null;
    let bestValue = Infinity;
    for (let i = start; i <= end; i++) {
      const value = Number(values[i]);
      if (!Number.isFinite(value)) continue;
      if (value < bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    return Number.isFinite(bestIndex) ? bestIndex : null;
  }

  _findHighestIndex(values, startIndex, endIndex) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const start = Math.max(0, Math.floor(startIndex || 0));
    const end = Math.min(values.length - 1, Math.floor(endIndex || values.length - 1));
    if (end < start) return null;

    let bestIndex = null;
    let bestValue = -Infinity;
    for (let i = start; i <= end; i++) {
      const value = Number(values[i]);
      if (!Number.isFinite(value)) continue;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    return Number.isFinite(bestIndex) ? bestIndex : null;
  }

  _isConfirmedPivotLowAt(index, strength) {
    if (!Number.isFinite(index) || !Number.isFinite(strength)) return false;
    const k = Math.max(1, Math.floor(strength));
    if (index - k < 0 || index + k >= this.lows.length) return false;

    const candidate = Number(this.lows[index]);
    if (!Number.isFinite(candidate)) return false;

    for (let i = index - k; i <= index + k; i++) {
      if (i === index) continue;
      const compare = Number(this.lows[i]);
      if (!Number.isFinite(compare) || compare < candidate) return false;
    }
    return true;
  }

  _isConfirmedPivotHighAt(index, strength) {
    if (!Number.isFinite(index) || !Number.isFinite(strength)) return false;
    const k = Math.max(1, Math.floor(strength));
    if (index - k < 0 || index + k >= this.highs.length) return false;

    const candidate = Number(this.highs[index]);
    if (!Number.isFinite(candidate)) return false;

    for (let i = index - k; i <= index + k; i++) {
      if (i === index) continue;
      const compare = Number(this.highs[i]);
      if (!Number.isFinite(compare) || compare > candidate) return false;
    }
    return true;
  }

  _resolveLongFibSwing(breakoutArrayIndex) {
    if (!Number.isFinite(breakoutArrayIndex) || breakoutArrayIndex <= 0) return null;

    const strength = Math.max(1, Math.floor(this.cfg.fibSwingPivotStrength || 2));
    const lookback = Math.max(
      strength * 2 + 1,
      Math.floor(this.cfg.fibSwingLookbackBars || Math.max(this.cfg.entryChannel * 4, 20))
    );
    const latestPivotIndex = breakoutArrayIndex - strength;
    const earliestPivotIndex = Math.max(strength, breakoutArrayIndex - lookback);

    let anchorIndex = null;
    let anchorSource = null;
    for (let i = latestPivotIndex; i >= earliestPivotIndex; i--) {
      if (this._isConfirmedPivotLowAt(i, strength)) {
        anchorIndex = i;
        anchorSource = "confirmed_pivot_low";
        break;
      }
    }

    if (!Number.isFinite(anchorIndex)) {
      anchorIndex = this._findLowestIndex(
        this.lows,
        Math.max(0, breakoutArrayIndex - lookback),
        Math.max(0, breakoutArrayIndex - 1)
      );
      anchorSource = "fallback_lowest_low";
    }

    if (!Number.isFinite(anchorIndex) || anchorIndex >= breakoutArrayIndex) return null;

    const impulseHighIndex = this._findHighestIndex(this.highs, anchorIndex, breakoutArrayIndex);
    if (!Number.isFinite(impulseHighIndex)) return null;

    const impulseLow = Number(this.lows[anchorIndex]);
    const impulseHigh = Number(this.highs[impulseHighIndex]);
    if (!Number.isFinite(impulseLow) || !Number.isFinite(impulseHigh) || impulseHigh <= impulseLow) {
      return null;
    }

    const range = impulseHigh - impulseLow;
    const rangeAtr = Number.isFinite(this.atr) && this.atr > 0 ? range / this.atr : null;

    return {
      anchorIndex,
      anchorTs: Number(this.timestamps[anchorIndex]) || null,
      anchorPrice: impulseLow,
      anchorSource,
      impulseLow,
      impulseHigh,
      impulseHighIndex,
      range,
      rangeAtr,
    };
  }

  _resolveShortFibSwing(breakoutArrayIndex) {
    if (!Number.isFinite(breakoutArrayIndex) || breakoutArrayIndex <= 0) return null;

    const strength = Math.max(1, Math.floor(this.cfg.fibSwingPivotStrength || 2));
    const lookback = Math.max(
      strength * 2 + 1,
      Math.floor(this.cfg.fibSwingLookbackBars || Math.max(this.cfg.entryChannel * 4, 20))
    );
    const latestPivotIndex = breakoutArrayIndex - strength;
    const earliestPivotIndex = Math.max(strength, breakoutArrayIndex - lookback);

    let anchorIndex = null;
    let anchorSource = null;
    for (let i = latestPivotIndex; i >= earliestPivotIndex; i--) {
      if (this._isConfirmedPivotHighAt(i, strength)) {
        anchorIndex = i;
        anchorSource = "confirmed_pivot_high";
        break;
      }
    }

    if (!Number.isFinite(anchorIndex)) {
      anchorIndex = this._findHighestIndex(
        this.highs,
        Math.max(0, breakoutArrayIndex - lookback),
        Math.max(0, breakoutArrayIndex - 1)
      );
      anchorSource = "fallback_highest_high";
    }

    if (!Number.isFinite(anchorIndex) || anchorIndex >= breakoutArrayIndex) return null;

    const impulseLowIndex = this._findLowestIndex(this.lows, anchorIndex, breakoutArrayIndex);
    if (!Number.isFinite(impulseLowIndex)) return null;

    const impulseHigh = Number(this.highs[anchorIndex]);
    const impulseLow = Number(this.lows[impulseLowIndex]);
    if (!Number.isFinite(impulseLow) || !Number.isFinite(impulseHigh) || impulseHigh <= impulseLow) {
      return null;
    }

    const range = impulseHigh - impulseLow;
    const rangeAtr = Number.isFinite(this.atr) && this.atr > 0 ? range / this.atr : null;

    return {
      anchorIndex,
      anchorTs: Number(this.timestamps[anchorIndex]) || null,
      anchorPrice: impulseHigh,
      anchorSource,
      impulseLow,
      impulseHigh,
      impulseLowIndex,
      range,
      rangeAtr,
    };
  }

  _computeAnchoredVwapFromIndex(anchorIndex) {
    if (!Number.isFinite(anchorIndex)) return null;
    const start = Math.max(0, Math.floor(anchorIndex));
    const end = this.prices.length - 1;
    if (end < start) return null;

    let volumeSum = 0;
    let priceVolumeSum = 0;
    for (let i = start; i <= end; i++) {
      const volume = Math.max(0, Number(this.volumes[i] || 0));
      if (!(volume > 0)) continue;

      const close = Number(this.prices[i]);
      const high = Number(this.highs[i]);
      const low = Number(this.lows[i]);
      const typicalPrice =
        Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)
          ? (high + low + close) / 3
          : Number.isFinite(close)
            ? close
            : null;
      if (!Number.isFinite(typicalPrice)) continue;

      priceVolumeSum += typicalPrice * volume;
      volumeSum += volume;
    }

    return volumeSum > 0 ? priceVolumeSum / volumeSum : null;
  }

  _distanceAtrToZone(level, zoneLow, zoneHigh) {
    if (
      !Number.isFinite(level) ||
      !Number.isFinite(zoneLow) ||
      !Number.isFinite(zoneHigh) ||
      !Number.isFinite(this.atr) ||
      !(this.atr > 0)
    ) {
      return null;
    }

    const lower = Math.min(zoneLow, zoneHigh);
    const upper = Math.max(zoneLow, zoneHigh);
    if (level >= lower && level <= upper) return 0;
    return Math.min(Math.abs(level - lower), Math.abs(level - upper)) / this.atr;
  }

  _evaluateFibConfluence(setup, zoneLow, zoneHigh) {
    const toleranceAtr = Math.max(0, Number(this.cfg.fibConfluenceToleranceAtr || 0));
    const required = Math.max(0, Math.floor(this.cfg.fibMinConfluenceCount || 0));
    const enabledChecks = [];

    if (this.cfg.fibUseBreakoutLevelConfluence) {
      enabledChecks.push({
        name: "breakout_level",
        level: Number(setup?.breakoutLevel),
      });
    }

    if (this.cfg.fibUseEmaConfluence) {
      enabledChecks.push({
        name: "ema",
        level: Number(this._ema),
      });
    }

    if (this.cfg.fibUseAnchoredVwapConfluence) {
      const avwapSource = String(this.cfg.fibAnchoredVwapSource || "swing")
        .trim()
        .toLowerCase();
      const anchorIndex =
        avwapSource === "breakout"
          ? Number(setup?.breakoutArrayIndex)
          : Number.isFinite(Number(setup?.swingAnchorArrayIndex))
            ? Number(setup.swingAnchorArrayIndex)
            : Number(setup?.breakoutArrayIndex);
      enabledChecks.push({
        name: "anchored_vwap",
        level: this._computeAnchoredVwapFromIndex(anchorIndex),
        anchorIndex,
        anchorSource: avwapSource,
      });
    }

    const levels = {};
    const distances = {};
    const matched = [];
    const missing = [];

    for (const check of enabledChecks) {
      levels[check.name] = Number.isFinite(check.level) ? check.level : null;
      const distanceAtr = this._distanceAtrToZone(check.level, zoneLow, zoneHigh);
      distances[check.name] = Number.isFinite(distanceAtr) ? distanceAtr : null;
      if (Number.isFinite(distanceAtr) && distanceAtr <= toleranceAtr) matched.push(check.name);
      else if (!Number.isFinite(distanceAtr)) missing.push(check.name);
    }

    return {
      ok: required <= 0 || matched.length >= required,
      required,
      toleranceAtr,
      enabled: enabledChecks.map((check) => check.name),
      matched,
      count: matched.length,
      levels,
      distances,
      missing,
    };
  }

  _volatilityPct() {
    const close = this.prices.length > 0 ? this.prices[this.prices.length - 1] : null;
    if (!this._ok(this.atr, close) || close <= 0) return null;
    return (this.atr / close) * 100;
  }

  // ============================================================
  // ENTRY LOGIC
  // ============================================================

  _regimeOk(side, closePrice) {
    if (!this.cfg.regimeFilterEnabled) return true;
    if (!this._ok(this._ema, this._emaSlope) || !Number.isFinite(closePrice)) return false;

    if (side === "long") {
      return (
        closePrice > this._ema &&
        this._emaSlope >= (this.cfg.regimeSlopeThreshold ?? this.cfg.trendSlopeThreshold ?? 0)
      );
    }

    return (
      closePrice < this._ema &&
      this._emaSlope <= -(this.cfg.regimeSlopeThreshold ?? this.cfg.trendSlopeThreshold ?? 0)
    );
  }

  _volatilityOk() {
    const atrPct = this._volatilityPct();
    if (!Number.isFinite(atrPct)) return false;
    if (atrPct < (this.cfg.minVolatilityPct || 0)) return false;
    if (atrPct > (this.cfg.maxVolatilityPct || 100)) return false;
    return true;
  }

  _computeLongCloseLocation(high, low, close) {
    if (![high, low, close].every(Number.isFinite)) return null;
    const range = high - low;
    if (range <= 0) return close >= high ? 1 : 0;
    return (close - low) / range;
  }

  _computeShortCloseLocation(high, low, close) {
    if (![high, low, close].every(Number.isFinite)) return null;
    const range = high - low;
    if (range <= 0) return close <= low ? 1 : 0;
    return (high - close) / range;
  }

  _buildBreakoutQualityMetrics(side, closePrice, threshold) {
    const n = this.prices.length;
    const high = Number.isFinite(this.highs[n - 1]) ? this.highs[n - 1] : closePrice;
    const low = Number.isFinite(this.lows[n - 1]) ? this.lows[n - 1] : closePrice;
    const currentVolume = Number.isFinite(this.volumes[n - 1]) ? this.volumes[n - 1] : null;
    const barRange = Number.isFinite(high) && Number.isFinite(low) ? Math.max(0, high - low) : null;
    const barRangeAtr =
      Number.isFinite(barRange) && Number.isFinite(this.atr) && this.atr > 0 ? barRange / this.atr : null;
    const closeLocation =
      side === "short"
        ? this._computeShortCloseLocation(high, low, closePrice)
        : this._computeLongCloseLocation(high, low, closePrice);
    const volumeRatio =
      Number.isFinite(currentVolume) && Number.isFinite(this.volumeAvg) && this.volumeAvg > 0
        ? currentVolume / this.volumeAvg
        : null;
    const breakoutDistanceAtr =
      Number.isFinite(this.atr) && this.atr > 0
        ? side === "short"
          ? (threshold - closePrice) / this.atr
          : (closePrice - threshold) / this.atr
        : null;

    return {
      barHigh: high,
      barLow: low,
      barRange,
      barRangeAtr,
      closeLocation,
      volumeRatio,
      breakoutDistanceAtr,
    };
  }

  _checkBreakoutQuality(side, closePrice, threshold) {
    const metrics = this._buildBreakoutQualityMetrics(side, closePrice, threshold);

    if (
      (this.cfg.breakoutMinBarRangeAtr || 0) > 0 &&
      !(Number.isFinite(metrics.barRangeAtr) && metrics.barRangeAtr >= this.cfg.breakoutMinBarRangeAtr)
    ) {
      return { ok: false, reason: "breakout_range_too_small", metrics };
    }

    if (
      (this.cfg.breakoutMinCloseLocation || 0) > 0 &&
      !(
        Number.isFinite(metrics.closeLocation) &&
        metrics.closeLocation >= this.cfg.breakoutMinCloseLocation
      )
    ) {
      return { ok: false, reason: "breakout_close_quality_too_weak", metrics };
    }

    if (
      (this.cfg.breakoutMinVolumeRatio || 0) > 0 &&
      !(Number.isFinite(metrics.volumeRatio) && metrics.volumeRatio >= this.cfg.breakoutMinVolumeRatio)
    ) {
      return { ok: false, reason: "breakout_volume_ratio_too_low", metrics };
    }

    if (
      (this.cfg.breakoutMinBreakDistanceAtr || 0) > 0 &&
      !(
        Number.isFinite(metrics.breakoutDistanceAtr) &&
        metrics.breakoutDistanceAtr >= this.cfg.breakoutMinBreakDistanceAtr
      )
    ) {
      return { ok: false, reason: "breakout_impulse_too_small", metrics };
    }

    return { ok: true, reason: null, metrics };
  }

  _detectLongBreakoutSetup() {
    if (!this.cfg.allowLongs) return null;
    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelHigh)) return null;

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const prevClose = n > 1 ? this.prices[n - 2] : null;
    const threshold = this.entryChannelHigh * (1 + (this.cfg.entryBufferBps || 0) / 10000);

    if (!this._regimeOk("long", closePrice)) return null;
    if (!this._volatilityOk()) return null;
    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) return null;
    if (!Number.isFinite(prevClose) || !(closePrice > threshold && prevClose <= threshold)) return null;
    const quality = this._checkBreakoutQuality("long", closePrice, threshold);
    if (!quality.ok) return null;

    const breakoutArrayIndex = n - 1;
    const swing = this._resolveLongFibSwing(breakoutArrayIndex);
    const impulseLow =
      Number.isFinite(swing?.impulseLow) ? swing.impulseLow : this.entryChannelLow;
    const impulseHigh =
      Number.isFinite(swing?.impulseHigh)
        ? swing.impulseHigh
        : Number.isFinite(this.highs[n - 1])
          ? this.highs[n - 1]
          : closePrice;
    const fibPocket = this._computeLongFibPocket(impulseLow, impulseHigh);

    return {
      breakoutLevel: threshold,
      breakoutDistanceAtr: quality.metrics.breakoutDistanceAtr,
      breakoutBarRangeAtr: quality.metrics.barRangeAtr,
      breakoutCloseLocation: quality.metrics.closeLocation,
      breakoutVolumeRatio: quality.metrics.volumeRatio,
      breakoutBarIndex: this._currentBarIndex,
      breakoutTs: this._now(),
      breakoutArrayIndex,
      breakoutClose: closePrice,
      breakoutAtr: this.atr,
      impulseLow,
      impulseHigh,
      swingAnchorArrayIndex: Number.isFinite(swing?.anchorIndex) ? swing.anchorIndex : null,
      swingAnchorTs: swing?.anchorTs ?? null,
      swingAnchorPrice: swing?.anchorPrice ?? null,
      swingAnchorSource: swing?.anchorSource ?? "channel_low_fallback",
      swingRange: swing?.range ?? (impulseHigh - impulseLow),
      swingRangeAtr:
        swing?.rangeAtr ??
        (Number.isFinite(this.atr) && this.atr > 0 ? (impulseHigh - impulseLow) / this.atr : null),
      fibPocketUpper: fibPocket?.pocketUpper ?? null,
      fibPocketLower: fibPocket?.pocketLower ?? null,
      expiresBarIndex:
        this._currentBarIndex + Math.max(1, Math.floor(this.cfg.pullbackSetupExpiryBars || 1)),
    };
  }

  _detectShortBreakoutSetup() {
    if (!this.cfg.allowShorts) return null;
    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelLow)) return null;

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const prevClose = n > 1 ? this.prices[n - 2] : null;
    const threshold = this.entryChannelLow * (1 - (this.cfg.entryBufferBps || 0) / 10000);

    if (!this._regimeOk("short", closePrice)) return null;
    if (!this._volatilityOk()) return null;
    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) return null;
    if (!Number.isFinite(prevClose) || !(closePrice < threshold && prevClose >= threshold)) return null;
    const quality = this._checkBreakoutQuality("short", closePrice, threshold);
    if (!quality.ok) return null;

    const breakoutArrayIndex = n - 1;
    const swing = this._resolveShortFibSwing(breakoutArrayIndex);
    const impulseHigh =
      Number.isFinite(swing?.impulseHigh) ? swing.impulseHigh : this.entryChannelHigh;
    const impulseLow =
      Number.isFinite(swing?.impulseLow)
        ? swing.impulseLow
        : Number.isFinite(this.lows[n - 1])
          ? this.lows[n - 1]
          : closePrice;
    const fibPocket = this._computeShortFibPocket(impulseHigh, impulseLow);

    return {
      breakoutLevel: threshold,
      breakoutDistanceAtr: quality.metrics.breakoutDistanceAtr,
      breakoutBarRangeAtr: quality.metrics.barRangeAtr,
      breakoutCloseLocation: quality.metrics.closeLocation,
      breakoutVolumeRatio: quality.metrics.volumeRatio,
      breakoutBarIndex: this._currentBarIndex,
      breakoutTs: this._now(),
      breakoutArrayIndex,
      breakoutClose: closePrice,
      breakoutAtr: this.atr,
      impulseHigh,
      impulseLow,
      swingAnchorArrayIndex: Number.isFinite(swing?.anchorIndex) ? swing.anchorIndex : null,
      swingAnchorTs: swing?.anchorTs ?? null,
      swingAnchorPrice: swing?.anchorPrice ?? null,
      swingAnchorSource: swing?.anchorSource ?? "channel_high_fallback",
      swingRange: swing?.range ?? (impulseHigh - impulseLow),
      swingRangeAtr:
        swing?.rangeAtr ??
        (Number.isFinite(this.atr) && this.atr > 0 ? (impulseHigh - impulseLow) / this.atr : null),
      fibPocketLower: fibPocket?.pocketLower ?? null,
      fibPocketUpper: fibPocket?.pocketUpper ?? null,
      expiresBarIndex:
        this._currentBarIndex + Math.max(1, Math.floor(this.cfg.pullbackSetupExpiryBars || 1)),
    };
  }

  _computeLongFibPocket(impulseLow, impulseHigh) {
    if (!Number.isFinite(impulseLow) || !Number.isFinite(impulseHigh) || impulseHigh <= impulseLow) {
      return null;
    }

    const retraceLevel = Number(this.cfg.fibRetraceLevel || 0.618);
    const pocketLowerLevel = Number(this.cfg.fibPocketLowerLevel || 0.65);
    const range = impulseHigh - impulseLow;
    const pocketUpper = impulseHigh - range * retraceLevel;
    const pocketLower = impulseHigh - range * pocketLowerLevel;

    if (!Number.isFinite(pocketUpper) || !Number.isFinite(pocketLower) || pocketUpper <= pocketLower) {
      return null;
    }

    return {
      impulseLow,
      impulseHigh,
      pocketUpper,
      pocketLower,
      range,
    };
  }

  _computeShortFibPocket(impulseHigh, impulseLow) {
    if (!Number.isFinite(impulseLow) || !Number.isFinite(impulseHigh) || impulseHigh <= impulseLow) {
      return null;
    }

    const retraceLevel = Number(this.cfg.fibRetraceLevel || 0.618);
    const pocketLowerLevel = Number(this.cfg.fibPocketLowerLevel || 0.65);
    const range = impulseHigh - impulseLow;
    const pocketLower = impulseLow + range * retraceLevel;
    const pocketUpper = impulseLow + range * pocketLowerLevel;

    if (!Number.isFinite(pocketUpper) || !Number.isFinite(pocketLower) || pocketUpper <= pocketLower) {
      return null;
    }

    return {
      impulseLow,
      impulseHigh,
      pocketUpper,
      pocketLower,
      range,
    };
  }

  _computeLongFibRetraceLevels(impulseLow, impulseHigh) {
    if (!Number.isFinite(impulseLow) || !Number.isFinite(impulseHigh) || impulseHigh <= impulseLow) {
      return null;
    }

    const shallowRatio = Number(this.cfg.fibZoneShallowLevel || 0.382);
    const midRatio = Number(this.cfg.fibZoneMidLevel || 0.5);
    const deepRatio = Number(this.cfg.fibZoneDeepLevel || 0.618);
    const invalidationRatio = Number(this.cfg.fibInvalidationLevel || 0.786);
    const range = impulseHigh - impulseLow;
    const shallow = impulseHigh - range * shallowRatio;
    const mid = impulseHigh - range * midRatio;
    const deep = impulseHigh - range * deepRatio;
    const invalidation = impulseHigh - range * invalidationRatio;

    if (
      ![shallow, mid, deep, invalidation].every(Number.isFinite) ||
      !(impulseHigh > shallow && shallow >= mid && mid >= deep && deep > invalidation && invalidation > impulseLow)
    ) {
      return null;
    }

    return {
      impulseLow,
      impulseHigh,
      shallow,
      mid,
      deep,
      invalidation,
      range,
    };
  }

  _computeShortFibRetraceLevels(impulseHigh, impulseLow) {
    if (!Number.isFinite(impulseLow) || !Number.isFinite(impulseHigh) || impulseHigh <= impulseLow) {
      return null;
    }

    const shallowRatio = Number(this.cfg.fibZoneShallowLevel || 0.382);
    const midRatio = Number(this.cfg.fibZoneMidLevel || 0.5);
    const deepRatio = Number(this.cfg.fibZoneDeepLevel || 0.618);
    const invalidationRatio = Number(this.cfg.fibInvalidationLevel || 0.786);
    const range = impulseHigh - impulseLow;
    const shallow = impulseLow + range * shallowRatio;
    const mid = impulseLow + range * midRatio;
    const deep = impulseLow + range * deepRatio;
    const invalidation = impulseLow + range * invalidationRatio;

    if (
      ![shallow, mid, deep, invalidation].every(Number.isFinite) ||
      !(impulseLow < shallow && shallow <= mid && mid <= deep && deep < invalidation && invalidation < impulseHigh)
    ) {
      return null;
    }

    return {
      impulseLow,
      impulseHigh,
      shallow,
      mid,
      deep,
      invalidation,
      range,
    };
  }

  _refreshPullbackSetups() {
    this._getPullbackSetup("long");
    this._getPullbackSetup("short");
  }

  _seedPullbackSetupsFromCurrentBar() {
    const longSetup = this._detectLongBreakoutSetup();
    if (longSetup) this._setPullbackSetup("long", longSetup);

    const shortSetup = this._detectShortBreakoutSetup();
    if (shortSetup) this._setPullbackSetup("short", shortSetup);
  }

  _checkLongBreakoutEntry() {
    this._clearEntryDebug("long");

    if (!this.cfg.allowLongs) {
      this._setEntryDebug("long", "longs_disabled");
      return null;
    }

    if (this._cooldownRemainingMs("long") > 0) {
      this._setEntryDebug("long", "cooldown_active", {
        cooldownRemainingMs: this._cooldownRemainingMs("long"),
      });
      return null;
    }

    const reentryBlock = this._reentryBlocked("long");
    if (reentryBlock) {
      this._setEntryDebug("long", reentryBlock.reason, reentryBlock);
      return null;
    }

    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelHigh)) {
      this._setEntryDebug("long", "indicators_not_ready", {
        emaReady: Number.isFinite(this._ema),
        slopeReady: Number.isFinite(this._emaSlope),
        atrReady: Number.isFinite(this.atr),
        channelReady: Number.isFinite(this.entryChannelHigh),
      });
      return null;
    }

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const prevClose = n > 1 ? this.prices[n - 2] : null;
    const threshold = this.entryChannelHigh * (1 + (this.cfg.entryBufferBps || 0) / 10000);

    if (!this._regimeOk("long", closePrice)) {
      this._setEntryDebug("long", "regime_blocked", {
        close: closePrice,
        ema: this._ema,
        emaSlope: this._emaSlope,
      });
      return null;
    }

    if (!this._volatilityOk()) {
      this._setEntryDebug("long", "volatility_blocked", {
        atrPct: this._volatilityPct(),
      });
      return null;
    }

    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) {
      this._setEntryDebug("long", "volume_confirmation_failed", {
        volumeAvg: this.volumeAvg,
        volumeSpike: this.volumeSpike,
      });
      return null;
    }

    if (!Number.isFinite(prevClose) || !(closePrice > threshold && prevClose <= threshold)) {
      this._setEntryDebug("long", "no_breakout", {
        close: closePrice,
        prevClose,
        threshold,
      });
      return null;
    }

    const quality = this._checkBreakoutQuality("long", closePrice, threshold);
    if (!quality.ok) {
      this._setEntryDebug("long", quality.reason, quality.metrics);
      return null;
    }

    const breakoutDistanceAtr = quality.metrics.breakoutDistanceAtr;
    if ((this.cfg.maxEntryDistAtr || 0) > 0 && breakoutDistanceAtr > this.cfg.maxEntryDistAtr) {
      this._setEntryDebug("long", "entry_too_extended", {
        breakoutDistanceAtr,
        maxEntryDistAtr: this.cfg.maxEntryDistAtr,
      });
      return null;
    }

    return {
      breakoutLevel: threshold,
      breakoutDistanceAtr,
      entryMode: "breakout",
      atr: this.atr,
      ema: this._ema,
      emaSlope: this._emaSlope,
      channelHigh: this.entryChannelHigh,
      channelLow: this.entryChannelLow,
      close: closePrice,
      breakoutBarRangeAtr: quality.metrics.barRangeAtr,
      breakoutCloseLocation: quality.metrics.closeLocation,
      breakoutVolumeRatio: quality.metrics.volumeRatio,
      volumeSpike: this.volumeSpike,
    };
  }

  _checkShortBreakoutEntry() {
    this._clearEntryDebug("short");

    if (!this.cfg.allowShorts) {
      this._setEntryDebug("short", "shorts_disabled");
      return null;
    }

    if (this._cooldownRemainingMs("short") > 0) {
      this._setEntryDebug("short", "cooldown_active", {
        cooldownRemainingMs: this._cooldownRemainingMs("short"),
      });
      return null;
    }

    const reentryBlock = this._reentryBlocked("short");
    if (reentryBlock) {
      this._setEntryDebug("short", reentryBlock.reason, reentryBlock);
      return null;
    }

    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelLow)) {
      this._setEntryDebug("short", "indicators_not_ready", {
        emaReady: Number.isFinite(this._ema),
        slopeReady: Number.isFinite(this._emaSlope),
        atrReady: Number.isFinite(this.atr),
        channelReady: Number.isFinite(this.entryChannelLow),
      });
      return null;
    }

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const prevClose = n > 1 ? this.prices[n - 2] : null;
    const threshold = this.entryChannelLow * (1 - (this.cfg.entryBufferBps || 0) / 10000);

    if (!this._regimeOk("short", closePrice)) {
      this._setEntryDebug("short", "regime_blocked", {
        close: closePrice,
        ema: this._ema,
        emaSlope: this._emaSlope,
      });
      return null;
    }

    if (!this._volatilityOk()) {
      this._setEntryDebug("short", "volatility_blocked", {
        atrPct: this._volatilityPct(),
      });
      return null;
    }

    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) {
      this._setEntryDebug("short", "volume_confirmation_failed", {
        volumeAvg: this.volumeAvg,
        volumeSpike: this.volumeSpike,
      });
      return null;
    }

    if (!Number.isFinite(prevClose) || !(closePrice < threshold && prevClose >= threshold)) {
      this._setEntryDebug("short", "no_breakout", {
        close: closePrice,
        prevClose,
        threshold,
      });
      return null;
    }

    const quality = this._checkBreakoutQuality("short", closePrice, threshold);
    if (!quality.ok) {
      this._setEntryDebug("short", quality.reason, quality.metrics);
      return null;
    }

    const breakoutDistanceAtr = quality.metrics.breakoutDistanceAtr;
    if ((this.cfg.maxEntryDistAtr || 0) > 0 && breakoutDistanceAtr > this.cfg.maxEntryDistAtr) {
      this._setEntryDebug("short", "entry_too_extended", {
        breakoutDistanceAtr,
        maxEntryDistAtr: this.cfg.maxEntryDistAtr,
      });
      return null;
    }

    return {
      breakoutLevel: threshold,
      breakoutDistanceAtr,
      entryMode: "breakout",
      atr: this.atr,
      ema: this._ema,
      emaSlope: this._emaSlope,
      channelHigh: this.entryChannelHigh,
      channelLow: this.entryChannelLow,
      close: closePrice,
      breakoutBarRangeAtr: quality.metrics.barRangeAtr,
      breakoutCloseLocation: quality.metrics.closeLocation,
      breakoutVolumeRatio: quality.metrics.volumeRatio,
      volumeSpike: this.volumeSpike,
    };
  }

  _checkLongPullbackEntry() {
    this._clearEntryDebug("long");

    if (!this.cfg.allowLongs) {
      this._setEntryDebug("long", "longs_disabled");
      return null;
    }

    if (this._cooldownRemainingMs("long") > 0) {
      this._setEntryDebug("long", "cooldown_active", {
        cooldownRemainingMs: this._cooldownRemainingMs("long"),
      });
      return null;
    }

    const reentryBlock = this._reentryBlocked("long");
    if (reentryBlock) {
      this._setEntryDebug("long", reentryBlock.reason, reentryBlock);
      return null;
    }

    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelHigh)) {
      this._setEntryDebug("long", "indicators_not_ready", {
        emaReady: Number.isFinite(this._ema),
        slopeReady: Number.isFinite(this._emaSlope),
        atrReady: Number.isFinite(this.atr),
        channelReady: Number.isFinite(this.entryChannelHigh),
      });
      return null;
    }

    const setup = this._getPullbackSetup("long");
    if (!setup) {
      this._setEntryDebug("long", "no_pullback_setup");
      return null;
    }

    if (
      (this.cfg.fibMinSwingRangeAtr || 0) > 0 &&
      !(Number.isFinite(setup.swingRangeAtr) && setup.swingRangeAtr >= this.cfg.fibMinSwingRangeAtr)
    ) {
      this._setEntryDebug("long", "fib_swing_too_small", {
        swingRangeAtr: setup.swingRangeAtr,
        minSwingRangeAtr: this.cfg.fibMinSwingRangeAtr,
        swingAnchorSource: setup.swingAnchorSource,
      });
      return null;
    }
    if (
      this.cfg.fibRequireConfirmedSwing &&
      !String(setup.swingAnchorSource || "").startsWith("confirmed_pivot")
    ) {
      this._setEntryDebug("long", "fib_swing_unconfirmed", {
        swingAnchorSource: setup.swingAnchorSource,
      });
      return null;
    }

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const currentLow = this.lows[n - 1];
    const threshold = setup.breakoutLevel;

    if (!this._regimeOk("long", closePrice)) {
      this._setEntryDebug("long", "regime_blocked", {
        close: closePrice,
        ema: this._ema,
        emaSlope: this._emaSlope,
      });
      return null;
    }

    if (!this._volatilityOk()) {
      this._setEntryDebug("long", "volatility_blocked", {
        atrPct: this._volatilityPct(),
      });
      return null;
    }

    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) {
      this._setEntryDebug("long", "volume_confirmation_failed", {
        volumeAvg: this.volumeAvg,
        volumeSpike: this.volumeSpike,
      });
      return null;
    }

    if (this._currentBarIndex <= (setup.breakoutBarIndex ?? -Infinity)) {
      this._setEntryDebug("long", "awaiting_pullback_bar", {
        breakoutBarIndex: setup.breakoutBarIndex,
        currentBarIndex: this._currentBarIndex,
      });
      return null;
    }

    if (!Number.isFinite(currentLow)) {
      this._setEntryDebug("long", "pullback_inputs_missing", {
        currentLow,
        threshold,
      });
      return null;
    }

    if (closePrice < threshold) {
      this._clearPullbackSetup("long");
      this._setEntryDebug("long", "pullback_lost_level", {
        close: closePrice,
        currentLow,
        threshold,
      });
      return null;
    }

    const pullbackRetestDistanceAtr =
      this.atr > 0 ? Math.abs(currentLow - threshold) / this.atr : null;
    if (
      (this.cfg.pullbackRetestAtr || 0) > 0 &&
      pullbackRetestDistanceAtr > this.cfg.pullbackRetestAtr
    ) {
      this._setEntryDebug("long", "pullback_too_far_from_level", {
        currentLow,
        threshold,
        pullbackRetestDistanceAtr,
        maxPullbackRetestAtr: this.cfg.pullbackRetestAtr,
      });
      return null;
    }

    const breakoutDistanceAtr = this.atr > 0 ? (closePrice - threshold) / this.atr : null;
    if ((this.cfg.maxEntryDistAtr || 0) > 0 && breakoutDistanceAtr > this.cfg.maxEntryDistAtr) {
      this._setEntryDebug("long", "entry_too_extended", {
        breakoutDistanceAtr,
        maxEntryDistAtr: this.cfg.maxEntryDistAtr,
      });
      return null;
    }

    return {
      breakoutLevel: threshold,
      breakoutDistanceAtr,
      pullbackRetestDistanceAtr,
      pullbackSetupAgeBars: this._currentBarIndex - (setup.breakoutBarIndex ?? this._currentBarIndex),
      breakoutSetupBarIndex: setup.breakoutBarIndex,
      entryMode: "pullback",
      atr: this.atr,
      ema: this._ema,
      emaSlope: this._emaSlope,
      channelHigh: setup.breakoutLevel,
      channelLow: this.entryChannelLow,
      close: closePrice,
      low: currentLow,
      volumeSpike: this.volumeSpike,
    };
  }

  _checkShortPullbackEntry() {
    this._clearEntryDebug("short");

    if (!this.cfg.allowShorts) {
      this._setEntryDebug("short", "shorts_disabled");
      return null;
    }

    if (this._cooldownRemainingMs("short") > 0) {
      this._setEntryDebug("short", "cooldown_active", {
        cooldownRemainingMs: this._cooldownRemainingMs("short"),
      });
      return null;
    }

    const reentryBlock = this._reentryBlocked("short");
    if (reentryBlock) {
      this._setEntryDebug("short", reentryBlock.reason, reentryBlock);
      return null;
    }

    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelLow)) {
      this._setEntryDebug("short", "indicators_not_ready", {
        emaReady: Number.isFinite(this._ema),
        slopeReady: Number.isFinite(this._emaSlope),
        atrReady: Number.isFinite(this.atr),
        channelReady: Number.isFinite(this.entryChannelLow),
      });
      return null;
    }

    const setup = this._getPullbackSetup("short");
    if (!setup) {
      this._setEntryDebug("short", "no_pullback_setup");
      return null;
    }

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const currentHigh = this.highs[n - 1];
    const threshold = setup.breakoutLevel;

    if (!this._regimeOk("short", closePrice)) {
      this._setEntryDebug("short", "regime_blocked", {
        close: closePrice,
        ema: this._ema,
        emaSlope: this._emaSlope,
      });
      return null;
    }

    if (!this._volatilityOk()) {
      this._setEntryDebug("short", "volatility_blocked", {
        atrPct: this._volatilityPct(),
      });
      return null;
    }

    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) {
      this._setEntryDebug("short", "volume_confirmation_failed", {
        volumeAvg: this.volumeAvg,
        volumeSpike: this.volumeSpike,
      });
      return null;
    }

    if (this._currentBarIndex <= (setup.breakoutBarIndex ?? -Infinity)) {
      this._setEntryDebug("short", "awaiting_pullback_bar", {
        breakoutBarIndex: setup.breakoutBarIndex,
        currentBarIndex: this._currentBarIndex,
      });
      return null;
    }

    if (!Number.isFinite(currentHigh)) {
      this._setEntryDebug("short", "pullback_inputs_missing", {
        currentHigh,
        threshold,
      });
      return null;
    }

    if (closePrice > threshold) {
      this._clearPullbackSetup("short");
      this._setEntryDebug("short", "pullback_lost_level", {
        close: closePrice,
        currentHigh,
        threshold,
      });
      return null;
    }

    const pullbackRetestDistanceAtr =
      this.atr > 0 ? Math.abs(currentHigh - threshold) / this.atr : null;
    if (
      (this.cfg.pullbackRetestAtr || 0) > 0 &&
      pullbackRetestDistanceAtr > this.cfg.pullbackRetestAtr
    ) {
      this._setEntryDebug("short", "pullback_too_far_from_level", {
        currentHigh,
        threshold,
        pullbackRetestDistanceAtr,
        maxPullbackRetestAtr: this.cfg.pullbackRetestAtr,
      });
      return null;
    }

    const breakoutDistanceAtr = this.atr > 0 ? (threshold - closePrice) / this.atr : null;
    if ((this.cfg.maxEntryDistAtr || 0) > 0 && breakoutDistanceAtr > this.cfg.maxEntryDistAtr) {
      this._setEntryDebug("short", "entry_too_extended", {
        breakoutDistanceAtr,
        maxEntryDistAtr: this.cfg.maxEntryDistAtr,
      });
      return null;
    }

    return {
      breakoutLevel: threshold,
      breakoutDistanceAtr,
      pullbackRetestDistanceAtr,
      pullbackSetupAgeBars: this._currentBarIndex - (setup.breakoutBarIndex ?? this._currentBarIndex),
      breakoutSetupBarIndex: setup.breakoutBarIndex,
      entryMode: "pullback",
      atr: this.atr,
      ema: this._ema,
      emaSlope: this._emaSlope,
      channelHigh: this.entryChannelHigh,
      channelLow: setup.breakoutLevel,
      close: closePrice,
      high: currentHigh,
      volumeSpike: this.volumeSpike,
    };
  }

  _checkLongFibPullbackEntry() {
    this._clearEntryDebug("long");

    if (!this.cfg.allowLongs) {
      this._setEntryDebug("long", "longs_disabled");
      return null;
    }

    if (this._cooldownRemainingMs("long") > 0) {
      this._setEntryDebug("long", "cooldown_active", {
        cooldownRemainingMs: this._cooldownRemainingMs("long"),
      });
      return null;
    }

    const reentryBlock = this._reentryBlocked("long");
    if (reentryBlock) {
      this._setEntryDebug("long", reentryBlock.reason, reentryBlock);
      return null;
    }

    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelHigh)) {
      this._setEntryDebug("long", "indicators_not_ready", {
        emaReady: Number.isFinite(this._ema),
        slopeReady: Number.isFinite(this._emaSlope),
        atrReady: Number.isFinite(this.atr),
        channelReady: Number.isFinite(this.entryChannelHigh),
      });
      return null;
    }

    const setup = this._getPullbackSetup("long");
    if (!setup) {
      this._setEntryDebug("long", "no_pullback_setup");
      return null;
    }

    const fibPocket = this._computeLongFibPocket(setup.impulseLow, setup.impulseHigh);
    if (!fibPocket) {
      this._setEntryDebug("long", "fib_setup_invalid", {
        impulseLow: setup.impulseLow,
        impulseHigh: setup.impulseHigh,
      });
      return null;
    }

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const currentLow = this.lows[n - 1];

    if (!this._regimeOk("long", closePrice)) {
      this._setEntryDebug("long", "regime_blocked", {
        close: closePrice,
        ema: this._ema,
        emaSlope: this._emaSlope,
      });
      return null;
    }

    if (!this._volatilityOk()) {
      this._setEntryDebug("long", "volatility_blocked", {
        atrPct: this._volatilityPct(),
      });
      return null;
    }

    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) {
      this._setEntryDebug("long", "volume_confirmation_failed", {
        volumeAvg: this.volumeAvg,
        volumeSpike: this.volumeSpike,
      });
      return null;
    }

    if (this._currentBarIndex <= (setup.breakoutBarIndex ?? -Infinity)) {
      this._setEntryDebug("long", "awaiting_pullback_bar", {
        breakoutBarIndex: setup.breakoutBarIndex,
        currentBarIndex: this._currentBarIndex,
      });
      return null;
    }

    if (!Number.isFinite(currentLow)) {
      this._setEntryDebug("long", "fib_inputs_missing", {
        currentLow,
        pocketUpper: fibPocket.pocketUpper,
        pocketLower: fibPocket.pocketLower,
      });
      return null;
    }

    if (closePrice < fibPocket.pocketLower || currentLow < fibPocket.pocketLower) {
      this._clearPullbackSetup("long");
      this._setEntryDebug("long", "fib_pullback_too_deep", {
        close: closePrice,
        currentLow,
        pocketUpper: fibPocket.pocketUpper,
        pocketLower: fibPocket.pocketLower,
      });
      return null;
    }

    if (!(currentLow <= fibPocket.pocketUpper && closePrice >= fibPocket.pocketUpper)) {
      this._setEntryDebug("long", "fib_pocket_not_confirmed", {
        close: closePrice,
        currentLow,
        pocketUpper: fibPocket.pocketUpper,
        pocketLower: fibPocket.pocketLower,
      });
      return null;
    }

    const fibRetestDistanceAtr =
      this.atr > 0 ? Math.abs(currentLow - fibPocket.pocketUpper) / this.atr : null;
    const breakoutDistanceAtr =
      this.atr > 0 ? (closePrice - fibPocket.pocketUpper) / this.atr : null;
    if ((this.cfg.maxEntryDistAtr || 0) > 0 && breakoutDistanceAtr > this.cfg.maxEntryDistAtr) {
      this._setEntryDebug("long", "entry_too_extended", {
        breakoutDistanceAtr,
        maxEntryDistAtr: this.cfg.maxEntryDistAtr,
      });
      return null;
    }

    const confluence = this._evaluateFibConfluence(
      setup,
      fibPocket.pocketLower,
      fibPocket.pocketUpper
    );
    if (!confluence.ok) {
      this._setEntryDebug("long", "fib_confluence_missing", {
        swingAnchorSource: setup.swingAnchorSource,
        confluence,
      });
      return null;
    }

    return {
      breakoutLevel: fibPocket.pocketUpper,
      breakoutDistanceAtr,
      fibRetestDistanceAtr,
      fibPocketUpper: fibPocket.pocketUpper,
      fibPocketLower: fibPocket.pocketLower,
      fibImpulseLow: fibPocket.impulseLow,
      fibImpulseHigh: fibPocket.impulseHigh,
      fibSwingAnchorSource: setup.swingAnchorSource,
      fibSwingAnchorPrice: setup.swingAnchorPrice,
      fibSwingRangeAtr: setup.swingRangeAtr,
      fibConfluenceCount: confluence.count,
      fibConfluenceMatched: confluence.matched,
      fibConfluenceLevels: confluence.levels,
      fibConfluenceDistances: confluence.distances,
      pullbackSetupAgeBars: this._currentBarIndex - (setup.breakoutBarIndex ?? this._currentBarIndex),
      breakoutSetupBarIndex: setup.breakoutBarIndex,
      entryMode: "fib_pullback",
      atr: this.atr,
      ema: this._ema,
      emaSlope: this._emaSlope,
      channelHigh: fibPocket.pocketUpper,
      channelLow: this.entryChannelLow,
      close: closePrice,
      low: currentLow,
      volumeSpike: this.volumeSpike,
    };
  }

  _checkShortFibPullbackEntry() {
    this._clearEntryDebug("short");

    if (!this.cfg.allowShorts) {
      this._setEntryDebug("short", "shorts_disabled");
      return null;
    }

    if (this._cooldownRemainingMs("short") > 0) {
      this._setEntryDebug("short", "cooldown_active", {
        cooldownRemainingMs: this._cooldownRemainingMs("short"),
      });
      return null;
    }

    const reentryBlock = this._reentryBlocked("short");
    if (reentryBlock) {
      this._setEntryDebug("short", reentryBlock.reason, reentryBlock);
      return null;
    }

    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelLow)) {
      this._setEntryDebug("short", "indicators_not_ready", {
        emaReady: Number.isFinite(this._ema),
        slopeReady: Number.isFinite(this._emaSlope),
        atrReady: Number.isFinite(this.atr),
        channelReady: Number.isFinite(this.entryChannelLow),
      });
      return null;
    }

    const setup = this._getPullbackSetup("short");
    if (!setup) {
      this._setEntryDebug("short", "no_pullback_setup");
      return null;
    }

    if (
      (this.cfg.fibMinSwingRangeAtr || 0) > 0 &&
      !(Number.isFinite(setup.swingRangeAtr) && setup.swingRangeAtr >= this.cfg.fibMinSwingRangeAtr)
    ) {
      this._setEntryDebug("short", "fib_swing_too_small", {
        swingRangeAtr: setup.swingRangeAtr,
        minSwingRangeAtr: this.cfg.fibMinSwingRangeAtr,
        swingAnchorSource: setup.swingAnchorSource,
      });
      return null;
    }
    if (
      this.cfg.fibRequireConfirmedSwing &&
      !String(setup.swingAnchorSource || "").startsWith("confirmed_pivot")
    ) {
      this._setEntryDebug("short", "fib_swing_unconfirmed", {
        swingAnchorSource: setup.swingAnchorSource,
      });
      return null;
    }

    const fibPocket = this._computeShortFibPocket(setup.impulseHigh, setup.impulseLow);
    if (!fibPocket) {
      this._setEntryDebug("short", "fib_setup_invalid", {
        impulseLow: setup.impulseLow,
        impulseHigh: setup.impulseHigh,
      });
      return null;
    }

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const currentHigh = this.highs[n - 1];

    if (!this._regimeOk("short", closePrice)) {
      this._setEntryDebug("short", "regime_blocked", {
        close: closePrice,
        ema: this._ema,
        emaSlope: this._emaSlope,
      });
      return null;
    }

    if (!this._volatilityOk()) {
      this._setEntryDebug("short", "volatility_blocked", {
        atrPct: this._volatilityPct(),
      });
      return null;
    }

    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) {
      this._setEntryDebug("short", "volume_confirmation_failed", {
        volumeAvg: this.volumeAvg,
        volumeSpike: this.volumeSpike,
      });
      return null;
    }

    if (this._currentBarIndex <= (setup.breakoutBarIndex ?? -Infinity)) {
      this._setEntryDebug("short", "awaiting_pullback_bar", {
        breakoutBarIndex: setup.breakoutBarIndex,
        currentBarIndex: this._currentBarIndex,
      });
      return null;
    }

    if (!Number.isFinite(currentHigh)) {
      this._setEntryDebug("short", "fib_inputs_missing", {
        currentHigh,
        pocketUpper: fibPocket.pocketUpper,
        pocketLower: fibPocket.pocketLower,
      });
      return null;
    }

    if (closePrice > fibPocket.pocketUpper || currentHigh > fibPocket.pocketUpper) {
      this._clearPullbackSetup("short");
      this._setEntryDebug("short", "fib_pullback_too_deep", {
        close: closePrice,
        currentHigh,
        pocketUpper: fibPocket.pocketUpper,
        pocketLower: fibPocket.pocketLower,
      });
      return null;
    }

    if (!(currentHigh >= fibPocket.pocketLower && closePrice <= fibPocket.pocketLower)) {
      this._setEntryDebug("short", "fib_pocket_not_confirmed", {
        close: closePrice,
        currentHigh,
        pocketUpper: fibPocket.pocketUpper,
        pocketLower: fibPocket.pocketLower,
      });
      return null;
    }

    const fibRetestDistanceAtr =
      this.atr > 0 ? Math.abs(currentHigh - fibPocket.pocketLower) / this.atr : null;
    const breakoutDistanceAtr =
      this.atr > 0 ? (fibPocket.pocketLower - closePrice) / this.atr : null;
    if ((this.cfg.maxEntryDistAtr || 0) > 0 && breakoutDistanceAtr > this.cfg.maxEntryDistAtr) {
      this._setEntryDebug("short", "entry_too_extended", {
        breakoutDistanceAtr,
        maxEntryDistAtr: this.cfg.maxEntryDistAtr,
      });
      return null;
    }

    const confluence = this._evaluateFibConfluence(
      setup,
      fibPocket.pocketLower,
      fibPocket.pocketUpper
    );
    if (!confluence.ok) {
      this._setEntryDebug("short", "fib_confluence_missing", {
        swingAnchorSource: setup.swingAnchorSource,
        confluence,
      });
      return null;
    }

    return {
      breakoutLevel: fibPocket.pocketLower,
      breakoutDistanceAtr,
      fibRetestDistanceAtr,
      fibPocketUpper: fibPocket.pocketUpper,
      fibPocketLower: fibPocket.pocketLower,
      fibImpulseLow: fibPocket.impulseLow,
      fibImpulseHigh: fibPocket.impulseHigh,
      fibSwingAnchorSource: setup.swingAnchorSource,
      fibSwingAnchorPrice: setup.swingAnchorPrice,
      fibSwingRangeAtr: setup.swingRangeAtr,
      fibConfluenceCount: confluence.count,
      fibConfluenceMatched: confluence.matched,
      fibConfluenceLevels: confluence.levels,
      fibConfluenceDistances: confluence.distances,
      pullbackSetupAgeBars: this._currentBarIndex - (setup.breakoutBarIndex ?? this._currentBarIndex),
      breakoutSetupBarIndex: setup.breakoutBarIndex,
      entryMode: "fib_pullback",
      atr: this.atr,
      ema: this._ema,
      emaSlope: this._emaSlope,
      channelHigh: this.entryChannelHigh,
      channelLow: fibPocket.pocketLower,
      close: closePrice,
      high: currentHigh,
      volumeSpike: this.volumeSpike,
    };
  }

  _checkLongFibRetraceEntry() {
    this._clearEntryDebug("long");

    if (!this.cfg.allowLongs) {
      this._setEntryDebug("long", "longs_disabled");
      return null;
    }

    if (this._cooldownRemainingMs("long") > 0) {
      this._setEntryDebug("long", "cooldown_active", {
        cooldownRemainingMs: this._cooldownRemainingMs("long"),
      });
      return null;
    }

    const reentryBlock = this._reentryBlocked("long");
    if (reentryBlock) {
      this._setEntryDebug("long", reentryBlock.reason, reentryBlock);
      return null;
    }

    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelHigh)) {
      this._setEntryDebug("long", "indicators_not_ready", {
        emaReady: Number.isFinite(this._ema),
        slopeReady: Number.isFinite(this._emaSlope),
        atrReady: Number.isFinite(this.atr),
        channelReady: Number.isFinite(this.entryChannelHigh),
      });
      return null;
    }

    const setup = this._getPullbackSetup("long");
    if (!setup) {
      this._setEntryDebug("long", "no_pullback_setup");
      return null;
    }

    if (
      (this.cfg.fibMinSwingRangeAtr || 0) > 0 &&
      !(Number.isFinite(setup.swingRangeAtr) && setup.swingRangeAtr >= this.cfg.fibMinSwingRangeAtr)
    ) {
      this._setEntryDebug("long", "fib_swing_too_small", {
        swingRangeAtr: setup.swingRangeAtr,
        minSwingRangeAtr: this.cfg.fibMinSwingRangeAtr,
        swingAnchorSource: setup.swingAnchorSource,
      });
      return null;
    }
    if (
      this.cfg.fibRequireConfirmedSwing &&
      !String(setup.swingAnchorSource || "").startsWith("confirmed_pivot")
    ) {
      this._setEntryDebug("long", "fib_swing_unconfirmed", {
        swingAnchorSource: setup.swingAnchorSource,
      });
      return null;
    }

    const fib = this._computeLongFibRetraceLevels(setup.impulseLow, setup.impulseHigh);
    if (!fib) {
      this._setEntryDebug("long", "fib_setup_invalid", {
        impulseLow: setup.impulseLow,
        impulseHigh: setup.impulseHigh,
      });
      return null;
    }

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const currentLow = this.lows[n - 1];
    const currentHigh = this.highs[n - 1];

    if (!this._regimeOk("long", closePrice)) {
      this._setEntryDebug("long", "regime_blocked", {
        close: closePrice,
        ema: this._ema,
        emaSlope: this._emaSlope,
      });
      return null;
    }

    if (!this._volatilityOk()) {
      this._setEntryDebug("long", "volatility_blocked", {
        atrPct: this._volatilityPct(),
      });
      return null;
    }

    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) {
      this._setEntryDebug("long", "volume_confirmation_failed", {
        volumeAvg: this.volumeAvg,
        volumeSpike: this.volumeSpike,
      });
      return null;
    }

    if (this._currentBarIndex <= (setup.breakoutBarIndex ?? -Infinity)) {
      this._setEntryDebug("long", "awaiting_pullback_bar", {
        breakoutBarIndex: setup.breakoutBarIndex,
        currentBarIndex: this._currentBarIndex,
      });
      return null;
    }

    if (!Number.isFinite(currentLow) || !Number.isFinite(currentHigh)) {
      this._setEntryDebug("long", "fib_inputs_missing", {
        currentLow,
        currentHigh,
      });
      return null;
    }

    if (closePrice < fib.invalidation || currentLow < fib.invalidation) {
      this._clearPullbackSetup("long");
      this._setEntryDebug("long", "fib_retrace_invalidated", {
        close: closePrice,
        currentLow,
        invalidation: fib.invalidation,
      });
      return null;
    }

    if (currentLow > fib.shallow) {
      this._setEntryDebug("long", "fib_zone_not_touched", {
        currentLow,
        shallow: fib.shallow,
        mid: fib.mid,
        deep: fib.deep,
      });
      return null;
    }

    const touchedDepth =
      currentLow <= fib.deep ? "deep" : currentLow <= fib.mid ? "mid" : "shallow";
    const reclaimLevel = touchedDepth === "shallow" ? fib.shallow : fib.mid;
    if (closePrice < reclaimLevel) {
      this._setEntryDebug("long", "fib_retrace_not_reclaimed", {
        close: closePrice,
        currentLow,
        touchedDepth,
        reclaimLevel,
        shallow: fib.shallow,
        mid: fib.mid,
        deep: fib.deep,
      });
      return null;
    }

    const closeLocation = this._computeLongCloseLocation(currentHigh, currentLow, closePrice);
    if (
      (this.cfg.fibRetraceConfirmCloseLocation || 0) > 0 &&
      (!Number.isFinite(closeLocation) ||
        closeLocation < this.cfg.fibRetraceConfirmCloseLocation)
    ) {
      this._setEntryDebug("long", "fib_retrace_close_too_weak", {
        closeLocation,
        minCloseLocation: this.cfg.fibRetraceConfirmCloseLocation,
        touchedDepth,
      });
      return null;
    }

    const fibRetestDistanceAtr =
      this.atr > 0 ? Math.abs(currentLow - reclaimLevel) / this.atr : null;
    const breakoutDistanceAtr =
      this.atr > 0 ? (closePrice - reclaimLevel) / this.atr : null;
    if ((this.cfg.maxEntryDistAtr || 0) > 0 && breakoutDistanceAtr > this.cfg.maxEntryDistAtr) {
      this._setEntryDebug("long", "entry_too_extended", {
        breakoutDistanceAtr,
        maxEntryDistAtr: this.cfg.maxEntryDistAtr,
      });
      return null;
    }

    const confluenceZoneLow = touchedDepth === "shallow" ? fib.mid : fib.deep;
    const confluenceZoneHigh = touchedDepth === "shallow" ? fib.shallow : fib.mid;
    const confluence = this._evaluateFibConfluence(
      setup,
      confluenceZoneLow,
      confluenceZoneHigh
    );
    if (!confluence.ok) {
      this._setEntryDebug("long", "fib_confluence_missing", {
        touchedDepth,
        swingAnchorSource: setup.swingAnchorSource,
        confluence,
      });
      return null;
    }

    return {
      breakoutLevel: reclaimLevel,
      breakoutDistanceAtr,
      fibRetestDistanceAtr,
      fibRetraceShallow: fib.shallow,
      fibRetraceMid: fib.mid,
      fibRetraceDeep: fib.deep,
      fibRetraceInvalidation: fib.invalidation,
      fibTouchedDepth: touchedDepth,
      fibImpulseLow: fib.impulseLow,
      fibImpulseHigh: fib.impulseHigh,
      fibSwingAnchorSource: setup.swingAnchorSource,
      fibSwingAnchorPrice: setup.swingAnchorPrice,
      fibSwingRangeAtr: setup.swingRangeAtr,
      fibConfluenceCount: confluence.count,
      fibConfluenceMatched: confluence.matched,
      fibConfluenceLevels: confluence.levels,
      fibConfluenceDistances: confluence.distances,
      pullbackSetupAgeBars: this._currentBarIndex - (setup.breakoutBarIndex ?? this._currentBarIndex),
      breakoutSetupBarIndex: setup.breakoutBarIndex,
      entryMode: "fib_retrace",
      atr: this.atr,
      ema: this._ema,
      emaSlope: this._emaSlope,
      channelHigh: reclaimLevel,
      channelLow: this.entryChannelLow,
      close: closePrice,
      low: currentLow,
      closeLocation,
      volumeSpike: this.volumeSpike,
    };
  }

  _checkShortFibRetraceEntry() {
    this._clearEntryDebug("short");

    if (!this.cfg.allowShorts) {
      this._setEntryDebug("short", "shorts_disabled");
      return null;
    }

    if (this._cooldownRemainingMs("short") > 0) {
      this._setEntryDebug("short", "cooldown_active", {
        cooldownRemainingMs: this._cooldownRemainingMs("short"),
      });
      return null;
    }

    const reentryBlock = this._reentryBlocked("short");
    if (reentryBlock) {
      this._setEntryDebug("short", reentryBlock.reason, reentryBlock);
      return null;
    }

    if (!this._ok(this._ema, this._emaSlope, this.atr, this.entryChannelLow)) {
      this._setEntryDebug("short", "indicators_not_ready", {
        emaReady: Number.isFinite(this._ema),
        slopeReady: Number.isFinite(this._emaSlope),
        atrReady: Number.isFinite(this.atr),
        channelReady: Number.isFinite(this.entryChannelLow),
      });
      return null;
    }

    const setup = this._getPullbackSetup("short");
    if (!setup) {
      this._setEntryDebug("short", "no_pullback_setup");
      return null;
    }

    if (
      (this.cfg.fibMinSwingRangeAtr || 0) > 0 &&
      !(Number.isFinite(setup.swingRangeAtr) && setup.swingRangeAtr >= this.cfg.fibMinSwingRangeAtr)
    ) {
      this._setEntryDebug("short", "fib_swing_too_small", {
        swingRangeAtr: setup.swingRangeAtr,
        minSwingRangeAtr: this.cfg.fibMinSwingRangeAtr,
        swingAnchorSource: setup.swingAnchorSource,
      });
      return null;
    }
    if (
      this.cfg.fibRequireConfirmedSwing &&
      !String(setup.swingAnchorSource || "").startsWith("confirmed_pivot")
    ) {
      this._setEntryDebug("short", "fib_swing_unconfirmed", {
        swingAnchorSource: setup.swingAnchorSource,
      });
      return null;
    }

    const fib = this._computeShortFibRetraceLevels(setup.impulseHigh, setup.impulseLow);
    if (!fib) {
      this._setEntryDebug("short", "fib_setup_invalid", {
        impulseLow: setup.impulseLow,
        impulseHigh: setup.impulseHigh,
      });
      return null;
    }

    const n = this.prices.length;
    const closePrice = this.prices[n - 1];
    const currentHigh = this.highs[n - 1];
    const currentLow = this.lows[n - 1];

    if (!this._regimeOk("short", closePrice)) {
      this._setEntryDebug("short", "regime_blocked", {
        close: closePrice,
        ema: this._ema,
        emaSlope: this._emaSlope,
      });
      return null;
    }

    if (!this._volatilityOk()) {
      this._setEntryDebug("short", "volatility_blocked", {
        atrPct: this._volatilityPct(),
      });
      return null;
    }

    if (this.cfg.requireVolumeConfirmation && !this.volumeSpike) {
      this._setEntryDebug("short", "volume_confirmation_failed", {
        volumeAvg: this.volumeAvg,
        volumeSpike: this.volumeSpike,
      });
      return null;
    }

    if (this._currentBarIndex <= (setup.breakoutBarIndex ?? -Infinity)) {
      this._setEntryDebug("short", "awaiting_pullback_bar", {
        breakoutBarIndex: setup.breakoutBarIndex,
        currentBarIndex: this._currentBarIndex,
      });
      return null;
    }

    if (!Number.isFinite(currentHigh) || !Number.isFinite(currentLow)) {
      this._setEntryDebug("short", "fib_inputs_missing", {
        currentHigh,
        currentLow,
      });
      return null;
    }

    if (closePrice > fib.invalidation || currentHigh > fib.invalidation) {
      this._clearPullbackSetup("short");
      this._setEntryDebug("short", "fib_retrace_invalidated", {
        close: closePrice,
        currentHigh,
        invalidation: fib.invalidation,
      });
      return null;
    }

    if (currentHigh < fib.shallow) {
      this._setEntryDebug("short", "fib_zone_not_touched", {
        currentHigh,
        shallow: fib.shallow,
        mid: fib.mid,
        deep: fib.deep,
      });
      return null;
    }

    const touchedDepth =
      currentHigh >= fib.deep ? "deep" : currentHigh >= fib.mid ? "mid" : "shallow";
    const reclaimLevel = touchedDepth === "shallow" ? fib.shallow : fib.mid;
    if (closePrice > reclaimLevel) {
      this._setEntryDebug("short", "fib_retrace_not_reclaimed", {
        close: closePrice,
        currentHigh,
        touchedDepth,
        reclaimLevel,
        shallow: fib.shallow,
        mid: fib.mid,
        deep: fib.deep,
      });
      return null;
    }

    const closeLocation = this._computeShortCloseLocation(currentHigh, currentLow, closePrice);
    if (
      (this.cfg.fibRetraceConfirmCloseLocation || 0) > 0 &&
      (!Number.isFinite(closeLocation) ||
        closeLocation < this.cfg.fibRetraceConfirmCloseLocation)
    ) {
      this._setEntryDebug("short", "fib_retrace_close_too_weak", {
        closeLocation,
        minCloseLocation: this.cfg.fibRetraceConfirmCloseLocation,
        touchedDepth,
      });
      return null;
    }

    const fibRetestDistanceAtr =
      this.atr > 0 ? Math.abs(currentHigh - reclaimLevel) / this.atr : null;
    const breakoutDistanceAtr =
      this.atr > 0 ? (reclaimLevel - closePrice) / this.atr : null;
    if ((this.cfg.maxEntryDistAtr || 0) > 0 && breakoutDistanceAtr > this.cfg.maxEntryDistAtr) {
      this._setEntryDebug("short", "entry_too_extended", {
        breakoutDistanceAtr,
        maxEntryDistAtr: this.cfg.maxEntryDistAtr,
      });
      return null;
    }

    const confluenceZoneLow = touchedDepth === "shallow" ? fib.shallow : fib.mid;
    const confluenceZoneHigh = touchedDepth === "shallow" ? fib.mid : fib.deep;
    const confluence = this._evaluateFibConfluence(
      setup,
      confluenceZoneLow,
      confluenceZoneHigh
    );
    if (!confluence.ok) {
      this._setEntryDebug("short", "fib_confluence_missing", {
        touchedDepth,
        swingAnchorSource: setup.swingAnchorSource,
        confluence,
      });
      return null;
    }

    return {
      breakoutLevel: reclaimLevel,
      breakoutDistanceAtr,
      fibRetestDistanceAtr,
      fibRetraceShallow: fib.shallow,
      fibRetraceMid: fib.mid,
      fibRetraceDeep: fib.deep,
      fibRetraceInvalidation: fib.invalidation,
      fibTouchedDepth: touchedDepth,
      fibImpulseLow: fib.impulseLow,
      fibImpulseHigh: fib.impulseHigh,
      fibSwingAnchorSource: setup.swingAnchorSource,
      fibSwingAnchorPrice: setup.swingAnchorPrice,
      fibSwingRangeAtr: setup.swingRangeAtr,
      fibConfluenceCount: confluence.count,
      fibConfluenceMatched: confluence.matched,
      fibConfluenceLevels: confluence.levels,
      fibConfluenceDistances: confluence.distances,
      pullbackSetupAgeBars: this._currentBarIndex - (setup.breakoutBarIndex ?? this._currentBarIndex),
      breakoutSetupBarIndex: setup.breakoutBarIndex,
      entryMode: "fib_retrace",
      atr: this.atr,
      ema: this._ema,
      emaSlope: this._emaSlope,
      channelHigh: this.entryChannelHigh,
      channelLow: reclaimLevel,
      close: closePrice,
      high: currentHigh,
      closeLocation,
      volumeSpike: this.volumeSpike,
    };
  }

  _calculateDynamicConfidence(side, breakoutDistanceAtr = 0) {
    if (!this.cfg.dynamicConfidence) {
      return side === "long" ? 0.7 : -0.7;
    }

    const scale = this.cfg.dynamicConfidenceScale || 1;
    const base = this.cfg.dynamicConfidenceBase || 0.5;
    const magnitude = this._clamp(base + Math.max(0, breakoutDistanceAtr || 0) / scale, 0.3, 1.0);
    return side === "long" ? magnitude : -magnitude;
  }

  _getHardStopDistance(position, leverageOverride = null) {
    if (!position) return 0;

    const entryPrice = Number(position.entryPrice);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;

    const leverage =
      Number.isFinite(leverageOverride) && leverageOverride > 0
        ? leverageOverride
        : Number(position.leverage || 1);
    const atrStopMultOverride = Number(position.hardStopAtrMultOverride);
    const atrStopMult =
      Number.isFinite(atrStopMultOverride) && atrStopMultOverride > 0
        ? atrStopMultOverride
        : this.cfg.atrStopMult;
    const atrAtEntry = Number(position.atrAtEntry ?? position.entryAtr);
    const atrRef = Number.isFinite(atrAtEntry) && atrAtEntry > 0 ? atrAtEntry : this.atr;

    let percentStopDistance = 0;
    let atrStopDistance = 0;

    if ((this.cfg.hardStopPercent || 0) > 0 && leverage > 0) {
      percentStopDistance = (entryPrice * (this.cfg.hardStopPercent / 100)) / leverage;
    }
    if ((atrStopMult || 0) > 0 && Number.isFinite(atrRef) && atrRef > 0) {
      atrStopDistance = atrRef * atrStopMult;
    }

    if (percentStopDistance > 0 && atrStopDistance > 0) {
      return Math.min(percentStopDistance, atrStopDistance);
    }
    return percentStopDistance > 0 ? percentStopDistance : atrStopDistance;
  }

  _computeOpenProfitR(position, price) {
    if (!position || !Number.isFinite(price) || price <= 0) return null;
    const stopDistance = this._getHardStopDistance(position, Number(position.leverage || 1));
    if (!Number.isFinite(stopDistance) || stopDistance <= 0) return null;

    const side = String(position.side || "").toLowerCase();
    const entryPrice = Number(position.entryPrice);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

    const favorableMove =
      side === "long" ? price - entryPrice : side === "short" ? entryPrice - price : null;
    if (!Number.isFinite(favorableMove)) return null;
    return favorableMove / stopDistance;
  }

  // ============================================================
  // EXIT LOGIC
  // ============================================================

  _checkHardStop(position, price, pnlPct) {
    if (!this.cfg.hardStopEnabled || !position) return false;

    const side = position.side?.toLowerCase();
    const entryPrice = position.entryPrice;
    const stopDistance = this._getHardStopDistance(position, Number(position.leverage || 1));

    if (stopDistance <= 0) return false;

    if (side === "long" && price <= entryPrice - stopDistance) {
      return {
        close: true,
        reason: "breakout_hard_stop",
        stopLoss: true,
        hardStop: true,
        stopPrice: entryPrice - stopDistance,
        pnlPct,
      };
    }

    if (side === "short" && price >= entryPrice + stopDistance) {
      return {
        close: true,
        reason: "breakout_hard_stop",
        stopLoss: true,
        hardStop: true,
        stopPrice: entryPrice + stopDistance,
        pnlPct,
      };
    }

    return false;
  }

  _checkPartialTakeProfit(position, closePrice, pnlPct) {
    if (!this.cfg.enablePartialExit || !position || position.tookPartial) return false;
    if (!Number.isFinite(closePrice) || closePrice <= 0) return false;

    const partialAtR = Number(this.cfg.partialAtR || 0);
    const partialExitPercent = Number(this.cfg.partialExitPercent || 0);
    if (partialAtR <= 0 || partialExitPercent <= 0 || partialExitPercent >= 100) return false;

    const openProfitR = this._computeOpenProfitR(position, closePrice);
    if (!Number.isFinite(openProfitR) || openProfitR < partialAtR) return false;

    if (this.cfg.requireProfitForExit && !(pnlPct > 0)) return false;

    return {
      partial: true,
      percent: partialExitPercent,
      reason: "breakout_partial_take_profit",
      partialTakeProfit: true,
      targetR: partialAtR,
      openProfitR,
      pnlPct,
    };
  }

  _checkAtrTrail(position, price, pnlPct) {
    if (!this.cfg.enableAtrTrail || !Number.isFinite(this.atr) || this.atr <= 0 || !position) {
      return false;
    }

    const side = position.side?.toLowerCase();
    const trailDistance = this.atr * this.cfg.atrTrailMult;

    if (side === "long") {
      const highWaterMark = Number.isFinite(position.highWaterMark)
        ? position.highWaterMark
        : price;
      const trailPrice = highWaterMark - trailDistance;
      if (price <= trailPrice) {
        return {
          close: true,
          reason: "breakout_atr_trailing_stop",
          trailingStop: true,
          trailPrice,
          pnlPct,
        };
      }
    }

    if (side === "short") {
      const lowWaterMark = Number.isFinite(position.lowWaterMark) ? position.lowWaterMark : price;
      const trailPrice = lowWaterMark + trailDistance;
      if (price >= trailPrice) {
        return {
          close: true,
          reason: "breakout_atr_trailing_stop",
          trailingStop: true,
          trailPrice,
          pnlPct,
        };
      }
    }

    return false;
  }

  _computeOpenProfitAtr(position, price) {
    if (!position) return null;
    const side = position.side?.toLowerCase();
    const entryPrice = Number(position.entryPrice);
    const atrRef = Number(position.atrAtEntry ?? position.entryAtr ?? this.atr);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
    if (!Number.isFinite(atrRef) || atrRef <= 0) return null;
    const priceMove = side === "long" ? price - entryPrice : entryPrice - price;
    return priceMove / atrRef;
  }

  _wouldOppositeChannelExit(position, pnlPct, closePriceOverride = null) {
    if (!this.cfg.enableOppositeChannelExit || !position || this.prices.length === 0) {
      return false;
    }

    const side = position.side?.toLowerCase();
    const closePrice = Number.isFinite(closePriceOverride)
      ? closePriceOverride
      : this.prices[this.prices.length - 1];
    if (!Number.isFinite(closePrice)) return false;

    if (side === "long" && Number.isFinite(this.exitChannelLow) && closePrice < this.exitChannelLow) {
      return !this.cfg.requireProfitForExit || pnlPct > 0;
    }

    if (
      side === "short" &&
      Number.isFinite(this.exitChannelHigh) &&
      closePrice > this.exitChannelHigh
    ) {
      return !this.cfg.requireProfitForExit || pnlPct > 0;
    }

    return false;
  }

  _checkRegimeFailureExit(position, closePrice, pnlPct) {
    if (!this.cfg.enableRegimeFailureExit || !position) return false;
    if (!Number.isFinite(closePrice) || !Number.isFinite(this._ema)) return false;

    const side = position.side?.toLowerCase();
    const regimeFailure = this._isRegimeFailure(side, closePrice);
    if (regimeFailure && side === "long") {
      if (!this.cfg.requireProfitForExit || pnlPct > 0) {
        return {
          close: true,
          reason: "breakout_regime_failure",
          regimeFailure: true,
          regimeFailureMode: this.cfg.regimeFailureMode,
          exitLevel: this._ema,
          closePrice,
          pnlPct,
        };
      }
    }

    if (regimeFailure && side === "short") {
      if (!this.cfg.requireProfitForExit || pnlPct > 0) {
        return {
          close: true,
          reason: "breakout_regime_failure",
          regimeFailure: true,
          regimeFailureMode: this.cfg.regimeFailureMode,
          exitLevel: this._ema,
          closePrice,
          pnlPct,
        };
      }
    }

    return false;
  }

  _normalizeRegimeFailureMode(mode) {
    const normalized = String(mode || "ema_cross")
      .trim()
      .toLowerCase();
    if (
      [
        "two_closes_beyond_ema",
        "two_closes",
        "two_closes_beyond",
        "2_closes_beyond_ema",
      ].includes(normalized)
    ) {
      return "two_closes_beyond_ema";
    }
    if (
      [
        "ema_cross_negative_slope",
        "ema_cross_plus_negative_slope",
        "ema_cross_plus_adverse_slope",
        "ema_cross_slope",
      ].includes(normalized)
    ) {
      return "ema_cross_negative_slope";
    }
    return "ema_cross";
  }

  _isRegimeFailure(side, closePrice) {
    if (!Number.isFinite(closePrice) || !Number.isFinite(this._ema)) return false;

    const adverseCross =
      side === "long" ? closePrice <= this._ema : side === "short" ? closePrice >= this._ema : false;
    if (!adverseCross) return false;

    const mode = this._normalizeRegimeFailureMode(this.cfg.regimeFailureMode);

    if (mode === "two_closes_beyond_ema") {
      const n = this.prices.length;
      const emaHistoryLen = this._emaHistory.length;
      if (n < 2 || emaHistoryLen < 2) return false;

      const prevClose = Number(this.prices[n - 2]);
      const prevEma = Number(this._emaHistory[emaHistoryLen - 2]);
      if (!Number.isFinite(prevClose) || !Number.isFinite(prevEma)) return false;

      return side === "long" ? prevClose <= prevEma : prevClose >= prevEma;
    }

    if (mode === "ema_cross_negative_slope") {
      const slopeThreshold = Math.abs(
        Number(this.cfg.regimeSlopeThreshold ?? this.cfg.trendSlopeThreshold ?? 0)
      );
      if (!Number.isFinite(this._emaSlope)) return false;
      return side === "long"
        ? this._emaSlope <= -slopeThreshold
        : this._emaSlope >= slopeThreshold;
    }

    return true;
  }

  _checkTimeStop(position, price, pnlPct, effectiveBarIndex) {
    const timeStopBars = this.cfg.timeStopBars || 0;
    if (timeStopBars <= 0 || !position) return false;
    if (this.cfg.runnerEnabled && position.tookPartial) return false;

    const openBarIndex = position.openBarIndex ?? this._currentBarIndex;
    const barsHeld = effectiveBarIndex - openBarIndex;
    if (barsHeld < timeStopBars) return false;

    let baseTimeStopResult = null;
    if (this.cfg.staleTimeStopEnabled) {
      const side = position.side?.toLowerCase();
      const openProfitAtr = this._computeOpenProfitAtr(position, price);
      const minProfitAtr = Number(this.cfg.staleTimeStopMinProfitAtr || 0);
      const staleOnProfit =
        !Number.isFinite(openProfitAtr) || openProfitAtr < minProfitAtr;

      let staleOnTrend = true;
      if (this.cfg.staleTimeStopRequireTrendFailure && Number.isFinite(this._ema)) {
        if (side === "long") staleOnTrend = price <= this._ema;
        else if (side === "short") staleOnTrend = price >= this._ema;
      }

      if (!staleOnProfit || !staleOnTrend) return false;

      baseTimeStopResult = {
        close: true,
        reason: "breakout_time_stop",
        timeOut: true,
        staleTimeStop: true,
        barsHeld,
        pnlPct,
        openProfitAtr,
      };
    } else {
      baseTimeStopResult = {
        close: true,
        reason: "breakout_time_stop",
        timeOut: true,
        barsHeld,
        pnlPct,
      };
    }

    if (!baseTimeStopResult) return false;

    if (this.cfg.runnerEnabled) {
      const runnerSizeFraction = this._clamp(Number(this.cfg.runnerSizeFraction || 0), 0, 1);
      const closePercent = (1 - runnerSizeFraction) * 100;
      const openProfitAtr = this._computeOpenProfitAtr(position, price);
      const minRunnerProfitAtr = Number(this.cfg.runnerMinProfitAtr || 0);
      const runnerEligible =
        runnerSizeFraction > 0 &&
        runnerSizeFraction < 1 &&
        closePercent > 0 &&
        closePercent < 100 &&
        Number.isFinite(openProfitAtr) &&
        openProfitAtr >= minRunnerProfitAtr;

      if (runnerEligible && !this._wouldOppositeChannelExit(position, pnlPct)) {
        return {
          partial: true,
          reason: "breakout_runner_partial_time_stop",
          timeOut: true,
          runnerPartial: true,
          percent: closePercent,
          barsHeld,
          pnlPct,
          openProfitAtr,
          runnerSizeFraction,
        };
      }
    }

    return baseTimeStopResult;
  }

  shouldClose(position, price, currentBarIndex = null, context = {}) {
    if (!position) return false;

    const side = position.side?.toLowerCase();
    const entryPrice = position.entryPrice;
    const effectiveBarIndex =
      currentBarIndex !== null ? currentBarIndex : this._currentBarIndex;
    const closePrice = Number.isFinite(context?.closePriceOverride)
      ? Number(context.closePriceOverride)
      : this.prices[this.prices.length - 1];
    const skipHardStop = context?.skipHardStop === true;
    const skipAtrTrail = context?.skipAtrTrail === true;
    const skipPartialTakeProfit = context?.skipPartialTakeProfit === true;
    const skipTimeStop = context?.skipTimeStop === true;
    const skipRegimeFailure = context?.skipRegimeFailure === true;
    const skipOppositeChannel = context?.skipOppositeChannel === true;

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false;

    const pnlPct =
      side === "long" ? (price - entryPrice) / entryPrice : (entryPrice - price) / entryPrice;

    if (!skipHardStop) {
      const hardStopResult = this._checkHardStop(position, price, pnlPct);
      if (hardStopResult) return hardStopResult;
    }

    if (!skipAtrTrail) {
      const trailResult = this._checkAtrTrail(position, price, pnlPct);
      if (trailResult) return trailResult;
    }

    if (!skipPartialTakeProfit) {
      const partialTakeProfitResult = this._checkPartialTakeProfit(position, closePrice, pnlPct);
      if (partialTakeProfitResult) return partialTakeProfitResult;
    }

    if (!skipTimeStop) {
      const timeStopResult = this._checkTimeStop(position, price, pnlPct, effectiveBarIndex);
      if (timeStopResult) return timeStopResult;
    }

    if (!skipRegimeFailure) {
      const regimeFailureResult = this._checkRegimeFailureExit(position, closePrice, pnlPct);
      if (regimeFailureResult) return regimeFailureResult;
    }

    if (skipOppositeChannel || !this.cfg.enableOppositeChannelExit || !Number.isFinite(closePrice)) {
      return false;
    }

    if (side === "long" && Number.isFinite(this.exitChannelLow) && closePrice < this.exitChannelLow) {
      if (!this.cfg.requireProfitForExit || pnlPct > 0) {
        return {
          close: true,
          reason: "breakout_opposite_channel",
          oppositeBreakout: true,
          exitLevel: this.exitChannelLow,
          closePrice,
          pnlPct,
        };
      }
    }

    if (side === "short" && Number.isFinite(this.exitChannelHigh) && closePrice > this.exitChannelHigh) {
      if (!this.cfg.requireProfitForExit || pnlPct > 0) {
        return {
          close: true,
          reason: "breakout_opposite_channel",
          oppositeBreakout: true,
          exitLevel: this.exitChannelHigh,
          closePrice,
          pnlPct,
        };
      }
    }

    return false;
  }

  // ============================================================
  // SIGNAL GENERATION
  // ============================================================

  getSignal(price, positions = [], printGates = false, tickIndex = null) {
    this._tickCount++;
    this._entryDebug.long = null;
    this._entryDebug.short = null;

    if (this._isCircuitBreakerActive()) {
      return {
        action: "hold",
        reason: "circuit_breaker_active",
        cooldownRemaining: this.circuitBreakerUntil - this._now(),
      };
    }

    if (this._barCount < this.cfg.minBars) {
      return {
        action: "hold",
        reason: "warmup",
        barsRemaining: this.cfg.minBars - this._barCount,
      };
    }

    this._refreshPullbackSetups();
    this._seedPullbackSetupsFromCurrentBar();

    const hasLong = positions.some((p) => p.side?.toLowerCase() === "long" && !p.exitTime);
    const hasShort = positions.some((p) => p.side?.toLowerCase() === "short" && !p.exitTime);

    if (hasLong) {
      const longPos = positions.find((p) => p.side?.toLowerCase() === "long" && !p.exitTime);
      const closeSignal = this.shouldClose(longPos, price);
      if (closeSignal && (closeSignal.close || closeSignal.partial)) {
        return {
          action: closeSignal.partial ? "partial_close" : "close",
          side: "long",
          ...closeSignal,
        };
      }
    }

    if (hasShort) {
      const shortPos = positions.find((p) => p.side?.toLowerCase() === "short" && !p.exitTime);
      const closeSignal = this.shouldClose(shortPos, price);
      if (closeSignal && (closeSignal.close || closeSignal.partial)) {
        return {
          action: closeSignal.partial ? "partial_close" : "close",
          side: "short",
          ...closeSignal,
        };
      }
    }

    if (hasLong || hasShort) {
      return {
        action: "hold",
        reason: "already_in_position",
        ema: this._ema,
        emaSlope: this._emaSlope,
      };
    }

    const nowTs = this._now();
    if (!this._isAllowedHourUtc(nowTs)) {
      return {
        action: "hold",
        reason: "trading_disabled_hour_utc",
        disabledHourUtc: new Date(nowTs).getUTCHours(),
      };
    }

    const entryMode = String(this.cfg.entryMode || "breakout").trim().toLowerCase();
    const longEntry =
      entryMode === "pullback"
        ? this._checkLongPullbackEntry()
        : entryMode === "fib_pullback"
          ? this._checkLongFibPullbackEntry()
          : entryMode === "fib_retrace"
            ? this._checkLongFibRetraceEntry()
          : entryMode === "hybrid_fib"
            ? this._checkLongBreakoutEntry() || this._checkLongFibPullbackEntry()
          : entryMode === "hybrid_fib_retrace"
            ? this._checkLongBreakoutEntry() || this._checkLongFibRetraceEntry()
        : entryMode === "hybrid"
          ? this._checkLongBreakoutEntry() || this._checkLongPullbackEntry()
          : this._checkLongBreakoutEntry();
    const shortEntry =
      entryMode === "pullback"
        ? this._checkShortPullbackEntry()
        : entryMode === "fib_pullback"
          ? this._checkShortFibPullbackEntry()
          : entryMode === "fib_retrace"
            ? this._checkShortFibRetraceEntry()
          : entryMode === "hybrid_fib"
            ? this._checkShortBreakoutEntry() || this._checkShortFibPullbackEntry()
          : entryMode === "hybrid_fib_retrace"
            ? this._checkShortBreakoutEntry() || this._checkShortFibRetraceEntry()
        : entryMode === "hybrid"
          ? this._checkShortBreakoutEntry() || this._checkShortPullbackEntry()
          : this._checkShortBreakoutEntry();

    if (printGates) {
      console.log(
        `[BTC-Breakout] Gates: ema=${this._ema?.toFixed?.(2) ?? "--"} slope=${this._emaSlope?.toFixed?.(4) ?? "--"} atr=${this.atr?.toFixed?.(4) ?? "--"} long=${longEntry ? "YES" : "NO"} short=${shortEntry ? "YES" : "NO"}`
      );
    }

    if (longEntry && !shortEntry) {
      if (this._entryUsesAnchoredPullbackSetup(longEntry.entryMode)) this._clearPullbackSetup("long");
      this._markEntry("long");
      const confidence = this._calculateDynamicConfidence("long", longEntry.breakoutDistanceAtr);
      return {
        action: "open",
        side: "long",
        confidence,
        reason:
          longEntry.entryMode === "pullback"
            ? "breakout_long_pullback_entry"
            : longEntry.entryMode === "fib_pullback"
              ? "breakout_long_fib_pullback_entry"
              : longEntry.entryMode === "fib_retrace"
                ? "breakout_long_fib_retrace_entry"
              : "breakout_long_entry",
        strategyType: "btc-breakout",
        entryAtr: this.atr,
        entryChannelHigh: this.entryChannelHigh,
        entryChannelLow: this.entryChannelLow,
        ...longEntry,
      };
    }

    if (shortEntry && !longEntry) {
      if (this._entryUsesAnchoredPullbackSetup(shortEntry.entryMode))
        this._clearPullbackSetup("short");
      this._markEntry("short");
      const confidence = this._calculateDynamicConfidence("short", shortEntry.breakoutDistanceAtr);
      return {
        action: "open",
        side: "short",
        confidence,
        reason:
          shortEntry.entryMode === "pullback"
            ? "breakout_short_pullback_entry"
            : shortEntry.entryMode === "fib_pullback"
              ? "breakout_short_fib_pullback_entry"
              : shortEntry.entryMode === "fib_retrace"
                ? "breakout_short_fib_retrace_entry"
            : "breakout_short_entry",
        strategyType: "btc-breakout",
        entryAtr: this.atr,
        entryChannelHigh: this.entryChannelHigh,
        entryChannelLow: this.entryChannelLow,
        ...shortEntry,
      };
    }

    if (longEntry && shortEntry) {
      const longDistance = Number(longEntry.breakoutDistanceAtr || 0);
      const shortDistance = Number(shortEntry.breakoutDistanceAtr || 0);
      if (longDistance >= shortDistance) {
        if (this._entryUsesAnchoredPullbackSetup(longEntry.entryMode))
          this._clearPullbackSetup("long");
        this._markEntry("long");
        return {
          action: "open",
          side: "long",
          confidence: this._calculateDynamicConfidence("long", longEntry.breakoutDistanceAtr),
          reason:
            longEntry.entryMode === "pullback"
              ? "breakout_long_pullback_entry"
              : longEntry.entryMode === "fib_pullback"
                ? "breakout_long_fib_pullback_entry"
                : longEntry.entryMode === "fib_retrace"
                  ? "breakout_long_fib_retrace_entry"
              : "breakout_long_entry",
          strategyType: "btc-breakout",
          entryAtr: this.atr,
          entryChannelHigh: this.entryChannelHigh,
          entryChannelLow: this.entryChannelLow,
          ...longEntry,
        };
      }

      if (this._entryUsesAnchoredPullbackSetup(shortEntry.entryMode))
        this._clearPullbackSetup("short");
      this._markEntry("short");
      return {
        action: "open",
        side: "short",
        confidence: this._calculateDynamicConfidence("short", shortEntry.breakoutDistanceAtr),
        reason:
          shortEntry.entryMode === "pullback"
            ? "breakout_short_pullback_entry"
            : shortEntry.entryMode === "fib_pullback"
              ? "breakout_short_fib_pullback_entry"
              : shortEntry.entryMode === "fib_retrace"
                ? "breakout_short_fib_retrace_entry"
            : "breakout_short_entry",
        strategyType: "btc-breakout",
        entryAtr: this.atr,
        entryChannelHigh: this.entryChannelHigh,
        entryChannelLow: this.entryChannelLow,
        ...shortEntry,
      };
    }

    return {
      action: "hold",
      reason: "no_breakout_signal",
      ema: this._ema,
      emaSlope: this._emaSlope,
      atr: this.atr,
      entryChannelHigh: this.entryChannelHigh,
      entryChannelLow: this.entryChannelLow,
      exitChannelHigh: this.exitChannelHigh,
      exitChannelLow: this.exitChannelLow,
      entryDebug: this._entryDebug,
    };
  }

  shouldOpenLong(price) {
    const signal = this.getSignal(price);
    return signal.action === "open" && signal.side === "long";
  }

  shouldOpenShort(price) {
    const signal = this.getSignal(price);
    return signal.action === "open" && signal.side === "short";
  }

  // ============================================================
  // POSITION SIZING
  // ============================================================

  getRecommendedPositionSize(price, side, capital, opts = {}) {
    if (!Number.isFinite(price) || price <= 0) return 0;
    if (!Number.isFinite(capital) || capital <= 0) return 0;

    let size = capital * (this.cfg.positionSizePercent / 100);

    if (Number.isFinite(this.atr) && this.atr > 0 && (this.cfg.volatilityScaleBase || 0) > 0) {
      const atrPct = this.atr / price;
      if (atrPct > 0) {
        const scale = this._clamp(this.cfg.volatilityScaleBase / atrPct, 0.25, 2.0);
        size *= scale;
      }
    }

    size = Math.max(this.cfg.minPositionSize, Math.min(size, this.cfg.maxPositionSize));
    return size;
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
      if (!this.cfg.quiet) {
        console.log("[BTC-Breakout] Circuit breaker cooldown expired, resuming");
      }
      return false;
    }

    return true;
  }

  // ============================================================
  // PERFORMANCE TRACKING
  // ============================================================

  recordTrade(trade) {
    if (!trade || typeof trade !== "object") return;

    const pnlUsd = Number(trade.pnlUsd || 0);
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
        if (!this.cfg.quiet) {
          console.warn(
            `[BTC-Breakout] Circuit breaker activated after ${this.consecutiveLosses} consecutive losses`
          );
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

    if (!this.cfg.quiet) {
      const winRate =
        this.totalTrades > 0 ? (this.winningTrades / this.totalTrades) * 100 : 0;
      console.log(
        `[BTC-Breakout] Trade #${this.totalTrades}: ${trade.exitReason || "unknown"} | PnL: $${pnlUsd.toFixed(2)} | Win rate: ${winRate.toFixed(1)}%`
      );
    }
  }

  logCircuitBreakerSummary() {
    if (this.circuitBreakerActivations > 0 || this.circuitBreakerCooldownExpirations > 0) {
      console.log(
        `[BTC-Breakout] Circuit breaker summary: ${this.circuitBreakerActivations} activation(s), ${this.circuitBreakerCooldownExpirations} cooldown expiration(s)`
      );
    }
  }

  // ============================================================
  // STATS / RESET
  // ============================================================

  getStats() {
    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0;

    return {
      market: this.cfg.market,
      strategyType: "btc-breakout",
      barCount: this._barCount,
      tickCount: this._tickCount,
      currentAtr: this.atr,
      currentEma: this._ema,
      currentEmaSlope: this._emaSlope,
      entryChannelHigh: this.entryChannelHigh,
      entryChannelLow: this.entryChannelLow,
      exitChannelHigh: this.exitChannelHigh,
      exitChannelLow: this.exitChannelLow,
      pendingPullbackSetupLong: this._getPullbackSetup("long"),
      pendingPullbackSetupShort: this._getPullbackSetup("short"),
      volumeAvg: this.volumeAvg,
      volumeSpike: this.volumeSpike,
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      winRate,
      totalPnL: this.totalPnL,
      consecutiveLosses: this.consecutiveLosses,
      circuitBreakerActive: this.circuitBreakerActive,
      circuitBreakerActivations: this.circuitBreakerActivations,
      circuitBreakerCooldownExpirations: this.circuitBreakerCooldownExpirations,
      config: {
        trendEmaPeriod: this.cfg.trendEmaPeriod,
        entryChannel: this.cfg.entryChannel,
        exitChannel: this.cfg.exitChannel,
        entryMode: this.cfg.entryMode,
        breakoutMinBarRangeAtr: this.cfg.breakoutMinBarRangeAtr,
        breakoutMinCloseLocation: this.cfg.breakoutMinCloseLocation,
        breakoutMinVolumeRatio: this.cfg.breakoutMinVolumeRatio,
        breakoutMinBreakDistanceAtr: this.cfg.breakoutMinBreakDistanceAtr,
        pullbackRetestAtr: this.cfg.pullbackRetestAtr,
        pullbackSetupExpiryBars: this.cfg.pullbackSetupExpiryBars,
        fibRetraceLevel: this.cfg.fibRetraceLevel,
        fibPocketLowerLevel: this.cfg.fibPocketLowerLevel,
        fibZoneShallowLevel: this.cfg.fibZoneShallowLevel,
        fibZoneMidLevel: this.cfg.fibZoneMidLevel,
        fibZoneDeepLevel: this.cfg.fibZoneDeepLevel,
        fibInvalidationLevel: this.cfg.fibInvalidationLevel,
        fibRetraceConfirmCloseLocation: this.cfg.fibRetraceConfirmCloseLocation,
        fibSwingLookbackBars: this.cfg.fibSwingLookbackBars,
        fibSwingPivotStrength: this.cfg.fibSwingPivotStrength,
        fibMinSwingRangeAtr: this.cfg.fibMinSwingRangeAtr,
        fibRequireConfirmedSwing: this.cfg.fibRequireConfirmedSwing,
        fibMinConfluenceCount: this.cfg.fibMinConfluenceCount,
        fibConfluenceToleranceAtr: this.cfg.fibConfluenceToleranceAtr,
        fibUseBreakoutLevelConfluence: this.cfg.fibUseBreakoutLevelConfluence,
        fibUseEmaConfluence: this.cfg.fibUseEmaConfluence,
        fibUseAnchoredVwapConfluence: this.cfg.fibUseAnchoredVwapConfluence,
        fibAnchoredVwapSource: this.cfg.fibAnchoredVwapSource,
        atrPeriod: this.cfg.atrPeriod,
        atrStopMult: this.cfg.atrStopMult,
        atrTrailMult: this.cfg.atrTrailMult,
        allowLongs: this.cfg.allowLongs,
        allowShorts: this.cfg.allowShorts,
      },
    };
  }

  reset() {
    this.prices = [];
    this.highs = [];
    this.lows = [];
    this.volumes = [];
    this.timestamps = [];

    this.atr = null;
    this._trueRanges = [];
    this._prevClose = null;

    this._ema = null;
    this._emaSlope = null;
    this._emaHistory = [];

    this.entryChannelHigh = null;
    this.entryChannelLow = null;
    this.exitChannelHigh = null;
    this.exitChannelLow = null;
    this.volumeAvg = null;
    this.volumeSpike = false;

    this._barCount = 0;
    this._currentBarIndex = 0;
    this._tickCount = 0;
    this._nowTs = null;

    this._lastEntryTs = 0;
    this._lastEntryBar = null;
    this._lastEntrySide = null;
    this._lastLongEntryTs = 0;
    this._lastShortEntryTs = 0;
    this._entryDebug = { long: null, short: null };
    this._pendingPullbackSetup = { long: null, short: null };

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

    console.log("[BTC-Breakout] Strategy reset");
  }
}

module.exports = BtcBreakoutStrategy;
