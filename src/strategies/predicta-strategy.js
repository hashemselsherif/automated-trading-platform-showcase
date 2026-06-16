/**
 * Predicta V4 Strategy
 *
 * Port of "Predicta Futures - Next Candle Predictor V4" Pine Script
 *
 * Features:
 * - Custom Supertrend (trend direction)
 * - Volume Delta (leading indicator)
 * - 8-Point Confluence System
 * - Weighted Scoring Model (0-100%)
 * - Dual-tier signals: BUY/SELL (basic) + PERFECT (high confidence)
 * - Dynamic threshold based on ADX
 * - Volatility regime multipliers
 *
 * Signal Logic:
 * - BUY: EMA cross up + bullish Supertrend + positive delta momentum
 * - SELL: EMA cross down + bearish Supertrend + negative delta momentum
 * - PERFECT LONG: All conditions + score >= threshold + confluence >= min
 * - PERFECT SHORT: All conditions + score >= threshold + confluence >= min
 *
 * Exit Priority (same as RSI-reversion pattern):
 * 1. Time stop - Hard limit on bars held
 * 2. Supertrend flip - Primary strategy exit
 * 3. EMA cross exit - Trend reversal (optional, configurable periods)
 * 4. Opposite PERFECT signal - Signal reversal
 * 5. Trailing stop - Profit protection
 * 6. Hard stop - Emergency protection
 */

"use strict";

class PredictaStrategy {
  constructor(config) {
    const s = config.predictaStrategy || config.strategy || {};
    const market = (config.market || "UNKNOWN").toUpperCase().replace("-PERP", "");

    // Helper to get per-market override or fallback to global
    const getMarketEnv = (param) => {
      const marketKey = `STRATEGY_${market}_PERP_PREDICTA_${param}`;
      const globalKey = `PREDICTA_${param}`;
      return process.env[marketKey] !== undefined ? process.env[marketKey] : process.env[globalKey];
    };

    // Helper to safely parse number from env/config with fallback
    const num = (envVal, fallback) => {
      if (envVal === undefined || envVal === "" || envVal === null) return fallback;
      const n = Number(envVal);
      return Number.isFinite(n) ? n : fallback;
    };

    const bool = (envVal, fallback) => {
      if (envVal === undefined || envVal === "" || envVal === null) return fallback;
      return String(envVal).toLowerCase() === "true";
    };

    this.cfg = {
      // Market
      market: config.market || "UNKNOWN",
      quiet: config.quiet || false,
      verbose: s.verbose ?? bool(process.env.PREDICTA_VERBOSE, false),

      // Supertrend
      stFactor: s.stFactor ?? num(process.env.PREDICTA_ST_FACTOR, 3.0),
      stPeriod: s.stPeriod ?? num(process.env.PREDICTA_ST_PERIOD, 10),

      // Confluence
      minConfluence: s.minConfluence ?? num(process.env.PREDICTA_MIN_CONFLUENCE, 5),
      minVolumeRatio: s.minVolumeRatio ?? num(process.env.PREDICTA_MIN_VOLUME_RATIO, 0.8),
      adxThreshold: s.adxThreshold ?? num(process.env.PREDICTA_ADX_THRESHOLD, 25),

      // Dynamic threshold levels
      adxStrong: s.adxStrong ?? num(process.env.PREDICTA_ADX_STRONG, 30),
      adxOk: s.adxOk ?? num(process.env.PREDICTA_ADX_OK, 25),
      adxWeak: s.adxWeak ?? num(process.env.PREDICTA_ADX_WEAK, 20),
      thresholdStrong: s.thresholdStrong ?? num(process.env.PREDICTA_THRESHOLD_STRONG, 55),
      thresholdOk: s.thresholdOk ?? num(process.env.PREDICTA_THRESHOLD_OK, 60),
      thresholdWeak: s.thresholdWeak ?? num(process.env.PREDICTA_THRESHOLD_WEAK, 65),
      thresholdDefault: s.thresholdDefault ?? num(process.env.PREDICTA_THRESHOLD_DEFAULT, 70),

      // Indicator periods
      atrPeriod: s.atrPeriod ?? num(process.env.PREDICTA_ATR_PERIOD, 14),
      atrPercentileLookback:
        s.atrPercentileLookback ?? num(process.env.PREDICTA_ATR_PERCENTILE_LOOKBACK, 100),
      emaFast: s.emaFast ?? num(process.env.PREDICTA_EMA_FAST, 8),
      emaMid: s.emaMid ?? num(process.env.PREDICTA_EMA_MID, 21),
      emaSlow: s.emaSlow ?? num(process.env.PREDICTA_EMA_SLOW, 50),
      // Exit EMA periods (if not set, use entry EMAs)
      emaExitFast: s.emaExitFast ?? num(getMarketEnv("EMA_EXIT_FAST"), null),
      emaExitSlow: s.emaExitSlow ?? num(getMarketEnv("EMA_EXIT_SLOW"), null),
      rsiPeriod: s.rsiPeriod ?? num(process.env.PREDICTA_RSI_PERIOD, 14),
      rsiUseSma: s.rsiUseSma ?? bool(process.env.PREDICTA_RSI_USE_SMA, true),
      macdFast: s.macdFast ?? num(process.env.PREDICTA_MACD_FAST, 12),
      macdSlow: s.macdSlow ?? num(process.env.PREDICTA_MACD_SLOW, 26),
      macdSignal: s.macdSignal ?? num(process.env.PREDICTA_MACD_SIGNAL, 9),
      stochPeriod: s.stochPeriod ?? num(process.env.PREDICTA_STOCH_PERIOD, 14),
      stochSmooth: s.stochSmooth ?? num(process.env.PREDICTA_STOCH_SMOOTH, 3),
      adxPeriod: s.adxPeriod ?? num(process.env.PREDICTA_ADX_PERIOD, 14),
      volumeLookback: s.volumeLookback ?? num(process.env.PREDICTA_VOLUME_LOOKBACK, 20),
      deltaEmaPeriod: s.deltaEmaPeriod ?? num(process.env.PREDICTA_DELTA_EMA_PERIOD, 10),

      // Scoring weights (must sum to 1.0)
      weightTrend: s.weightTrend ?? num(process.env.PREDICTA_WEIGHT_TREND, 0.23),
      weightMacd: s.weightMacd ?? num(process.env.PREDICTA_WEIGHT_MACD, 0.18),
      weightDelta: s.weightDelta ?? num(process.env.PREDICTA_WEIGHT_DELTA, 0.15),
      weightRsi: s.weightRsi ?? num(process.env.PREDICTA_WEIGHT_RSI, 0.12),
      weightStoch: s.weightStoch ?? num(process.env.PREDICTA_WEIGHT_STOCH, 0.12),
      weightAdx: s.weightAdx ?? num(process.env.PREDICTA_WEIGHT_ADX, 0.1),
      weightVolume: s.weightVolume ?? num(process.env.PREDICTA_WEIGHT_VOLUME, 0.1),

      // Confluence gate toggles (for indicator isolation)
      enableGateSupertrend:
        s.enableGateSupertrend ?? bool(process.env.PREDICTA_ENABLE_GATE_SUPERTREND, true),
      enableGateEmaCross:
        s.enableGateEmaCross ?? bool(process.env.PREDICTA_ENABLE_GATE_EMA_CROSS, true),
      enableGateEmaTrend:
        s.enableGateEmaTrend ?? bool(process.env.PREDICTA_ENABLE_GATE_EMA_TREND, true),
      enableGateMacd: s.enableGateMacd ?? bool(process.env.PREDICTA_ENABLE_GATE_MACD, true),
      enableGateStoch: s.enableGateStoch ?? bool(process.env.PREDICTA_ENABLE_GATE_STOCH, true),
      enableGateRsi: s.enableGateRsi ?? bool(process.env.PREDICTA_ENABLE_GATE_RSI, true),
      enableGateAdx: s.enableGateAdx ?? bool(process.env.PREDICTA_ENABLE_GATE_ADX, true),
      enableGateVolume: s.enableGateVolume ?? bool(process.env.PREDICTA_ENABLE_GATE_VOLUME, true),

      // Score component toggles (for indicator isolation)
      enableScoreTrend: s.enableScoreTrend ?? bool(process.env.PREDICTA_ENABLE_SCORE_TREND, true),
      enableScoreMacd: s.enableScoreMacd ?? bool(process.env.PREDICTA_ENABLE_SCORE_MACD, true),
      enableScoreDelta: s.enableScoreDelta ?? bool(process.env.PREDICTA_ENABLE_SCORE_DELTA, true),
      enableScoreRsi: s.enableScoreRsi ?? bool(process.env.PREDICTA_ENABLE_SCORE_RSI, true),
      enableScoreStoch: s.enableScoreStoch ?? bool(process.env.PREDICTA_ENABLE_SCORE_STOCH, true),
      enableScoreAdx: s.enableScoreAdx ?? bool(process.env.PREDICTA_ENABLE_SCORE_ADX, true),
      enableScoreVolume:
        s.enableScoreVolume ?? bool(process.env.PREDICTA_ENABLE_SCORE_VOLUME, true),

      // Relax perfect signal direction requirement (for isolation testing)
      relaxPerfectDirection:
        s.relaxPerfectDirection ?? bool(process.env.PREDICTA_RELAX_PERFECT_DIRECTION, false),

      // Volatility regime
      volHighPercentile: s.volHighPercentile ?? num(process.env.PREDICTA_VOL_HIGH_PERCENTILE, 75),
      volLowPercentile: s.volLowPercentile ?? num(process.env.PREDICTA_VOL_LOW_PERCENTILE, 25),
      volHighMult: s.volHighMult ?? num(process.env.PREDICTA_VOL_HIGH_MULT, 0.85),
      volLowMult: s.volLowMult ?? num(process.env.PREDICTA_VOL_LOW_MULT, 1.15),
      volMedMult: s.volMedMult ?? num(process.env.PREDICTA_VOL_MED_MULT, 1.0),

      // Signals
      enablePerfectSignals:
        s.enablePerfectSignals ?? bool(process.env.PREDICTA_ENABLE_PERFECT_SIGNALS, true),
      enableBuySellSignals:
        s.enableBuySellSignals ?? bool(process.env.PREDICTA_ENABLE_BUY_SELL_SIGNALS, true),
      perfectConfidence: s.perfectConfidence ?? num(process.env.PREDICTA_PERFECT_CONFIDENCE, 2.5),
      buySellConfidence: s.buySellConfidence ?? num(process.env.PREDICTA_BUY_SELL_CONFIDENCE, 1.5),
      buySellEntryTrigger:
        s.buySellEntryTrigger ??
        String(process.env.PREDICTA_BUY_SELL_ENTRY_TRIGGER || "st_flip_or_ema_cross"),
      buySellRequireDelta:
        s.buySellRequireDelta ?? bool(process.env.PREDICTA_BUY_SELL_REQUIRE_DELTA, true),
      buySellUseConfluenceFilter:
        s.buySellUseConfluenceFilter ??
        bool(process.env.PREDICTA_BUY_SELL_USE_CONFLUENCE_FILTER, false),
      buySellMinConfluence:
        s.buySellMinConfluence ?? num(process.env.PREDICTA_BUY_SELL_MIN_CONFLUENCE, 0),
      buySellUseScoreFilter:
        s.buySellUseScoreFilter ?? bool(process.env.PREDICTA_BUY_SELL_USE_SCORE_FILTER, false),
      buySellScoreThresholdOffset:
        s.buySellScoreThresholdOffset ??
        num(process.env.PREDICTA_BUY_SELL_SCORE_THRESHOLD_OFFSET, 0),

      // Exits
      supertrendExit: s.supertrendExit ?? bool(process.env.PREDICTA_SUPERTREND_EXIT, true),
      emaCrossExit: s.emaCrossExit ?? bool(getMarketEnv("EMA_CROSS_EXIT"), false),
      oppositePerfectExit:
        s.oppositePerfectExit ?? bool(process.env.PREDICTA_OPPOSITE_PERFECT_EXIT, true),
      enableAtrStop: s.enableAtrStop ?? bool(process.env.PREDICTA_ENABLE_ATR_STOP, true),
      atrStopMult: s.atrStopMult ?? num(process.env.PREDICTA_ATR_STOP_MULT, 2.0),
      enableTimeStop: s.enableTimeStop ?? bool(process.env.PREDICTA_ENABLE_TIME_STOP, false),
      timeStopBars: s.timeStopBars ?? num(process.env.PREDICTA_TIME_STOP_BARS, 72),
      enableTrailingStop:
        s.enableTrailingStop ?? bool(process.env.PREDICTA_ENABLE_TRAILING_STOP, false),
      trailingAtrMult: s.trailingAtrMult ?? num(process.env.PREDICTA_TRAILING_ATR_MULT, 1.5),
      hardStopEnabled: s.hardStopEnabled ?? bool(process.env.PREDICTA_HARD_STOP_ENABLED, true),
      hardStopPercent: s.hardStopPercent ?? num(process.env.PREDICTA_HARD_STOP_PERCENT, 15),
      hardStopAtr: s.hardStopAtr ?? num(process.env.PREDICTA_HARD_STOP_ATR, 2.0),

      // Cooldowns
      enableCooldown: s.enableCooldown ?? bool(process.env.ENABLE_COOLDOWN, true),
      cooldownMs: s.cooldownMs ?? num(process.env.COOLDOWN_MS, 30000),
      flipCooldownMs: s.flipCooldownMs ?? num(process.env.FLIP_COOLDOWN_MS, 60000),
      flipCooldownBars: s.flipCooldownBars ?? num(process.env.FLIP_COOLDOWN_BARS, 4),
      minBarsSameSideReentry:
        s.minBarsSameSideReentry ?? num(process.env.MIN_BARS_SAME_SIDE_REENTRY, 2),
      enableSameBarGuard: s.enableSameBarGuard ?? bool(process.env.ENABLE_SAME_BAR_GUARD, true),
      enableEdgeTrigger: s.enableEdgeTrigger ?? bool(process.env.ENABLE_EDGE_TRIGGER, true),

      // Circuit breaker
      maxConsecutiveLosses:
        s.maxConsecutiveLosses ?? num(process.env.PREDICTA_MAX_CONSECUTIVE_LOSSES, 3),
      circuitBreakerCooldownMs:
        s.circuitBreakerCooldownMs ??
        num(process.env.PREDICTA_CIRCUIT_BREAKER_COOLDOWN_MS, 1800000),

      // Position sizing
      perfectSizeMult: s.perfectSizeMult ?? num(process.env.PREDICTA_PERFECT_SIZE_MULT, 1.5),
      buySellSizeMult: s.buySellSizeMult ?? num(process.env.PREDICTA_BUY_SELL_SIZE_MULT, 1.0),

      // Trade direction
      allowLongs: s.allowLongs ?? bool(process.env.ALLOW_LONGS, true),
      allowShorts: s.allowShorts ?? bool(process.env.ALLOW_SHORTS, true),

      // Warmup
      minBars: s.minBars ?? num(process.env.PREDICTA_MIN_BARS, 100),
    };

    this._initializeState();

    // Initialization logging
    if (!this.cfg.quiet) {
      console.log(
        `[Predicta] Initialized: ${this.cfg.market} | ST(${this.cfg.stFactor}/${this.cfg.stPeriod}) | Conf>=${this.cfg.minConfluence}/8 | ADX>=${this.cfg.adxThreshold}`
      );
      console.log(
        `[Predicta] Signals: perfect=${this.cfg.enablePerfectSignals} (conf=${this.cfg.perfectConfidence}) buySell=${this.cfg.enableBuySellSignals} (conf=${this.cfg.buySellConfidence})`
      );
      if (this.cfg.enableBuySellSignals) {
        console.log(
          `[Predicta] BUY/SELL entry: trigger=${this.cfg.buySellEntryTrigger} requireDelta=${this.cfg.buySellRequireDelta}`
        );
        console.log(
          `[Predicta] BUY/SELL filters: confluence=${this.cfg.buySellUseConfluenceFilter ? (this.cfg.buySellMinConfluence > 0 ? this.cfg.buySellMinConfluence : this.cfg.minConfluence) : "OFF"} score=${this.cfg.buySellUseScoreFilter ? `threshold+${this.cfg.buySellScoreThresholdOffset}` : "OFF"}`
        );
      }
      if (this.cfg.emaCrossExit) {
        const fastPeriod = this.cfg.emaExitFast !== null && Number.isFinite(this.cfg.emaExitFast)
          ? this.cfg.emaExitFast
          : this.cfg.emaFast;
        const slowPeriod = this.cfg.emaExitSlow !== null && Number.isFinite(this.cfg.emaExitSlow)
          ? this.cfg.emaExitSlow
          : this.cfg.emaMid;
        console.log(
          `[Predicta] EMA cross exit: ENABLED | fast=${fastPeriod} slow=${slowPeriod}`
        );
      }
    }
  }

  _initializeState() {
    // Price/OHLCV buffers
    this.prices = [];
    this.highs = [];
    this.lows = [];
    this.closes = [];
    this.volumes = [];
    // Binance-enhanced CVD inputs (optional): taker-buy base volume per bar
    // If available, we can compute a much more accurate delta: (2*takerBuyBase - totalBase)
    this.takerBuyBaseVolumes = [];

    // Supertrend state
    this._trendDirection = 0; // -1 = bullish (uptrend), +1 = bearish (downtrend)
    this._upperBand = null;
    this._lowerBand = null;
    this._prevUpperBand = null;
    this._prevLowerBand = null;
    this._prevTrendDirection = 0;
    this._supertrendFlippedBullish = false; // Flip detected this bar
    this._supertrendFlippedBearish = false;

    // EMA values
    this._emaFast = null;
    this._emaMid = null;
    this._emaSlow = null;
    this._prevEmaFast = null;
    this._prevEmaMid = null;

    // Exit EMA values (for EMA cross exit)
    this._emaExitFast = null;
    this._emaExitSlow = null;
    this._prevEmaExitFast = null;
    this._prevEmaExitSlow = null;

    // MACD
    this._macdLine = null;
    this._macdSignal = null;
    this._macdHist = null;
    this._macdEmaFast = null;
    this._macdEmaSlow = null;

    // Stochastic
    this._stochK = null;
    this._stochD = null;
    this._stochKBuffer = [];

    // RSI
    this.rsi = null;
    this._rsiGainEma = null;
    this._rsiLossEma = null;
    this._prevClose = null;

    // ADX
    this.adx = null;
    this._plusDI = null;
    this._minusDI = null;
    this._trBuffer = [];
    this._plusDMBuffer = [];
    this._minusDMBuffer = [];
    this._dxBuffer = [];

    // ATR
    this.atr = null;
    this._atrBuffer = [];

    // Volume Delta (CVD - critical indicator)
    this._volumeDelta = null;
    this._deltaEma = null;
    this._deltaMomentum = false;
    this._volumeWarningShown = false;

    // Volume average
    this._volumeAvg = null;

    // Confluence and scores
    this._confluenceLong = 0;
    this._confluenceShort = 0;
    this._longPct = 0;
    this._shortPct = 0;
    this._volMultiplier = 1.0;

    // Gate states (for pretty log)
    this._stGateLong = false;
    this._stGateShort = false;
    this._emaCrossOK = false;
    this._emaTrendOK = false;
    this._macdGateOK = false;
    this._stochGateOK = false;
    this._rsiGateOK = false;
    this._adxTrending = false;
    this._volumeOK = false;

    // Signal conditions
    this._buyCondition = false;
    this._sellCondition = false;
    this._perfectLongCondition = false;
    this._perfectShortCondition = false;
    this._prevBuyCondition = false;
    this._prevSellCondition = false;
    this._prevPerfectLong = false;
    this._prevPerfectShort = false;

    // Bar tracking
    this._currentBarIndex = 0;
    // Current (simulated) timestamp; used for backtests to avoid Date.now() artifacts
    this._currentTs = 0;
    this._lastOpenBarIndex = null;
    this._lastClosedBarIndex = null;
    this._lastClosedSide = null;
    this._lastEntryTs = 0;
    this._lastFlipBarIndex = null;
    this._lastReason = "initializing";

    // Edge trigger tracking
    this._lastLongOK = false;
    this._lastShortOK = false;

    // Performance tracking
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.totalPnL = 0;
    this.consecutiveLosses = 0;
    this.circuitBreakerUntil = 0;
    this.tradeHistory = [];

    // Volume data validation (CVD requires real volume)
    this._zeroVolumeBars = 0;
    this._totalVolumeBars = 0;
    this._volumeAlertShown = false;
    this._volumeAlertThreshold = 20; // Alert after 20 consecutive zero-volume bars

    // Ready flag
    this._ready = false;
  }

  // ============================================================
  // INDICATOR CALCULATIONS
  // ============================================================

  /**
   * Calculate EMA
   */
  _calcEma(values, period, prevEma = null) {
    if (values.length < period) return null;

    const k = 2 / (period + 1);

    if (prevEma === null) {
      // Initialize with SMA
      let sum = 0;
      for (let i = values.length - period; i < values.length; i++) {
        sum += values[i];
      }
      return sum / period;
    }

    return values[values.length - 1] * k + prevEma * (1 - k);
  }

  /**
   * Calculate SMA
   */
  _sma(values, period) {
    if (values.length < period) return null;
    let sum = 0;
    for (let i = values.length - period; i < values.length; i++) {
      sum += values[i];
    }
    return sum / period;
  }

  /**
   * Calculate ATR (Average True Range)
   */
  _updateAtr() {
    if (this.highs.length < 2) return;

    const high = this.highs[this.highs.length - 1];
    const low = this.lows[this.lows.length - 1];
    const prevClose =
      this.closes.length > 1
        ? this.closes[this.closes.length - 2]
        : this.closes[this.closes.length - 1];

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));

    this._atrBuffer.push(tr);
    if (this._atrBuffer.length > this.cfg.atrPeriod * 2) {
      this._atrBuffer.shift();
    }

    if (this._atrBuffer.length >= this.cfg.atrPeriod) {
      if (this.atr === null) {
        // Initialize with SMA
        this.atr = this._sma(this._atrBuffer, this.cfg.atrPeriod);
      } else {
        // Use EMA smoothing (Wilder's method)
        const k = 1 / this.cfg.atrPeriod;
        this.atr = tr * k + this.atr * (1 - k);
      }
    }
  }

  /**
   * Update Supertrend
   * Pine Script: trendDirection == -1 means UPTREND (bullish), +1 means DOWNTREND (bearish)
   */
  _updateSupertrend() {
    if (this.atr === null || this.closes.length < 2) return;

    const close = this.closes[this.closes.length - 1];
    const high = this.highs[this.highs.length - 1];
    const low = this.lows[this.lows.length - 1];
    const hl2 = (high + low) / 2;

    // Calculate bands
    const basicUpperBand = hl2 + this.cfg.stFactor * this.atr;
    const basicLowerBand = hl2 - this.cfg.stFactor * this.atr;

    // Band ratcheting logic (from Pine Script)
    // Upper band can only go down (tighter), lower band can only go up (tighter)
    if (this._prevUpperBand === null) {
      this._upperBand = basicUpperBand;
    } else {
      const prevClose = this.closes[this.closes.length - 2];
      this._upperBand =
        basicUpperBand < this._prevUpperBand || prevClose > this._prevUpperBand
          ? basicUpperBand
          : this._prevUpperBand;
    }

    if (this._prevLowerBand === null) {
      this._lowerBand = basicLowerBand;
    } else {
      const prevClose = this.closes[this.closes.length - 2];
      this._lowerBand =
        basicLowerBand > this._prevLowerBand || prevClose < this._prevLowerBand
          ? basicLowerBand
          : this._prevLowerBand;
    }

    // Trend direction logic
    // -1 = uptrend (bullish), +1 = downtrend (bearish)
    if (this._prevTrendDirection === 0) {
      // Initialize based on close position relative to bands
      this._trendDirection = close > this._upperBand ? -1 : close < this._lowerBand ? 1 : -1;
    } else if (this._prevTrendDirection === -1) {
      // Was in uptrend
      this._trendDirection = close < this._lowerBand ? 1 : -1;
    } else {
      // Was in downtrend
      this._trendDirection = close > this._upperBand ? -1 : 1;
    }

    // Detect Supertrend flip BEFORE updating previous direction
    // This is critical for signal detection
    this._supertrendFlippedBullish = this._prevTrendDirection > 0 && this._trendDirection < 0;
    this._supertrendFlippedBearish = this._prevTrendDirection < 0 && this._trendDirection > 0;

    // Store previous values for next iteration
    this._prevUpperBand = this._upperBand;
    this._prevLowerBand = this._lowerBand;
    this._prevTrendDirection = this._trendDirection;
  }

  /**
   * Update Volume Delta (leading indicator) - CRITICAL for this strategy
   * buyVolume = volume * (close - low) / (high - low)
   * sellVolume = volume * (high - close) / (high - low)
   * delta = buyVolume - sellVolume
   *
   * CVD (Cumulative Volume Delta) is essential - requires real volume data.
   * Use Binance data source which provides volume, not Pyth.
   */
  _updateVolumeDelta() {
    if (this.volumes.length < 1) return;

    const high = this.highs[this.highs.length - 1];
    const low = this.lows[this.lows.length - 1];
    const close = this.closes[this.closes.length - 1];
    const volume = this.volumes[this.volumes.length - 1];
    const takerBuyBase =
      this.takerBuyBaseVolumes.length > 0
        ? this.takerBuyBaseVolumes[this.takerBuyBaseVolumes.length - 1]
        : null;

    const range = high - low;

    // Warn once if no volume data (CVD is critical)
    if (volume === 0 && !this._volumeWarningShown) {
      this._volumeWarningShown = true;
      if (!this.cfg.quiet) {
        console.warn(
          `[Predicta] ⚠️ ${this.cfg.market} No volume data - CVD indicator will not work properly. Use Binance data source.`
        );
      }
    }

    if (range <= 0 || volume === 0) {
      this._volumeDelta = 0;
    } else {
      // Prefer Binance taker-buy base volume when available (more accurate proxy for aggressor delta)
      // Binance klines provide taker buy base volume; then:
      //   sellBase = totalBase - takerBuyBase
      //   deltaBase = buyBase - sellBase = 2*buyBase - totalBase
      if (Number.isFinite(takerBuyBase) && takerBuyBase >= 0) {
        const buyBase = Math.max(0, Math.min(volume, takerBuyBase));
        const sellBase = Math.max(0, volume - buyBase);
        this._volumeDelta = buyBase - sellBase; // == 2*buyBase - volume
      } else {
        // Fallback: close-in-range allocation (less accurate than taker-buy based delta)
        const buyVolume = (volume * (close - low)) / range;
        const sellVolume = (volume * (high - close)) / range;
        this._volumeDelta = buyVolume - sellVolume;
      }
    }

    // Calculate Delta EMA
    if (this._deltaEma === null) {
      this._deltaEma = this._volumeDelta;
    } else {
      const k = 2 / (this.cfg.deltaEmaPeriod + 1);
      this._deltaEma = this._volumeDelta * k + this._deltaEma * (1 - k);
    }

    // Delta momentum: positive when delta > deltaEMA
    // This indicates buying pressure is increasing
    this._deltaMomentum = this._volumeDelta > this._deltaEma;
  }

  /**
   * Get exit EMA periods (with fallback to entry EMAs if not configured)
   */
  _getExitEmaPeriods() {
    const fastPeriod = this.cfg.emaExitFast !== null && Number.isFinite(this.cfg.emaExitFast)
      ? this.cfg.emaExitFast
      : this.cfg.emaFast;
    const slowPeriod = this.cfg.emaExitSlow !== null && Number.isFinite(this.cfg.emaExitSlow)
      ? this.cfg.emaExitSlow
      : this.cfg.emaMid;
    return { fastPeriod, slowPeriod };
  }

  /**
   * Update EMAs
   */
  _updateEmas() {
    this._prevEmaFast = this._emaFast;
    this._prevEmaMid = this._emaMid;

    this._emaFast = this._calcEma(this.closes, this.cfg.emaFast, this._emaFast);
    this._emaMid = this._calcEma(this.closes, this.cfg.emaMid, this._emaMid);
    this._emaSlow = this._calcEma(this.closes, this.cfg.emaSlow, this._emaSlow);

    // Update exit EMAs if EMA cross exit is enabled
    if (this.cfg.emaCrossExit) {
      this._prevEmaExitFast = this._emaExitFast;
      this._prevEmaExitSlow = this._emaExitSlow;

      const { fastPeriod, slowPeriod } = this._getExitEmaPeriods();
      this._emaExitFast = this._calcEma(this.closes, fastPeriod, this._emaExitFast);
      this._emaExitSlow = this._calcEma(this.closes, slowPeriod, this._emaExitSlow);
    }
  }

  /**
   * Update MACD
   */
  _updateMacd() {
    this._macdEmaFast = this._calcEma(this.closes, this.cfg.macdFast, this._macdEmaFast);
    this._macdEmaSlow = this._calcEma(this.closes, this.cfg.macdSlow, this._macdEmaSlow);

    if (this._macdEmaFast !== null && this._macdEmaSlow !== null) {
      this._macdLine = this._macdEmaFast - this._macdEmaSlow;

      // Signal line is EMA of MACD line - need to track it separately
      if (this._macdSignal === null) {
        this._macdSignal = this._macdLine;
      } else {
        const k = 2 / (this.cfg.macdSignal + 1);
        this._macdSignal = this._macdLine * k + this._macdSignal * (1 - k);
      }

      this._macdHist = this._macdLine - this._macdSignal;
    }
  }

  /**
   * Update Stochastic
   */
  _updateStochastic() {
    if (this.closes.length < this.cfg.stochPeriod) return;

    const period = this.cfg.stochPeriod;
    const highs = this.highs.slice(-period);
    const lows = this.lows.slice(-period);
    const close = this.closes[this.closes.length - 1];

    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const range = highestHigh - lowestLow;

    const rawK = range > 0 ? ((close - lowestLow) / range) * 100 : 50;

    // Smooth K with SMA
    this._stochKBuffer.push(rawK);
    if (this._stochKBuffer.length > this.cfg.stochSmooth) {
      this._stochKBuffer.shift();
    }

    if (this._stochKBuffer.length >= this.cfg.stochSmooth) {
      this._stochK = this._sma(this._stochKBuffer, this.cfg.stochSmooth);

      // D is SMA of K (we just use K for simplicity, matching Pine Script behavior)
      if (this._stochD === null) {
        this._stochD = this._stochK;
      } else {
        const k = 2 / (this.cfg.stochSmooth + 1);
        this._stochD = this._stochK * k + this._stochD * (1 - k);
      }
    }
  }

  /**
   * Update RSI
   */
  _updateRsi() {
    if (this.closes.length < 2) return;

    const close = this.closes[this.closes.length - 1];
    const prevClose = this.closes[this.closes.length - 2];
    const change = close - prevClose;

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    const period = this.cfg.rsiPeriod;

    if (this._rsiGainEma === null) {
      // Initialize with SMA of gains/losses
      if (this.closes.length >= period + 1) {
        let sumGain = 0,
          sumLoss = 0;
        for (let i = this.closes.length - period; i < this.closes.length; i++) {
          const c = this.closes[i] - this.closes[i - 1];
          if (c > 0) sumGain += c;
          else sumLoss += -c;
        }
        this._rsiGainEma = sumGain / period;
        this._rsiLossEma = sumLoss / period;
      }
    } else {
      // Wilder's smoothing
      const k = 1 / period;
      this._rsiGainEma = gain * k + this._rsiGainEma * (1 - k);
      this._rsiLossEma = loss * k + this._rsiLossEma * (1 - k);
    }

    if (this._rsiGainEma !== null && this._rsiLossEma !== null) {
      if (this._rsiLossEma === 0) {
        this.rsi = 100;
      } else {
        const rs = this._rsiGainEma / this._rsiLossEma;
        this.rsi = 100 - 100 / (1 + rs);
      }
    }
  }

  /**
   * Update ADX
   */
  _updateAdx() {
    if (this.highs.length < 2) return;

    const high = this.highs[this.highs.length - 1];
    const low = this.lows[this.lows.length - 1];
    const prevHigh = this.highs[this.highs.length - 2];
    const prevLow = this.lows[this.lows.length - 2];
    const prevClose =
      this.closes.length > 1
        ? this.closes[this.closes.length - 2]
        : this.closes[this.closes.length - 1];

    // True Range
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));

    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

    this._trBuffer.push(tr);
    this._plusDMBuffer.push(plusDM);
    this._minusDMBuffer.push(minusDM);

    const period = this.cfg.adxPeriod;
    const maxLen = period * 2;

    if (this._trBuffer.length > maxLen) this._trBuffer.shift();
    if (this._plusDMBuffer.length > maxLen) this._plusDMBuffer.shift();
    if (this._minusDMBuffer.length > maxLen) this._minusDMBuffer.shift();

    if (this._trBuffer.length >= period) {
      // Calculate smoothed TR, +DM, -DM using Wilder's method
      const smoothedTR = this._wilderSmooth(this._trBuffer, period);
      const smoothedPlusDM = this._wilderSmooth(this._plusDMBuffer, period);
      const smoothedMinusDM = this._wilderSmooth(this._minusDMBuffer, period);

      if (smoothedTR > 0) {
        this._plusDI = (smoothedPlusDM / smoothedTR) * 100;
        this._minusDI = (smoothedMinusDM / smoothedTR) * 100;

        const diSum = this._plusDI + this._minusDI;
        const dx = diSum > 0 ? (Math.abs(this._plusDI - this._minusDI) / diSum) * 100 : 0;

        this._dxBuffer.push(dx);
        if (this._dxBuffer.length > period) this._dxBuffer.shift();

        if (this._dxBuffer.length >= period) {
          // ADX is smoothed DX
          if (this.adx === null) {
            this.adx = this._sma(this._dxBuffer, period);
          } else {
            const k = 1 / period;
            this.adx = dx * k + this.adx * (1 - k);
          }
        }
      }
    }
  }

  _wilderSmooth(values, period) {
    if (values.length < period) return null;

    // Simple sum for Wilder's smoothing
    let sum = 0;
    for (let i = values.length - period; i < values.length; i++) {
      sum += values[i];
    }
    return sum;
  }

  /**
   * Update volume average
   */
  _updateVolumeAvg() {
    if (this.volumes.length >= this.cfg.volumeLookback) {
      this._volumeAvg = this._sma(this.volumes, this.cfg.volumeLookback);
    }
  }

  /**
   * Get volatility multiplier based on ATR percentile
   */
  _getVolatilityMultiplier() {
    if (this._atrBuffer.length < this.cfg.atrPercentileLookback) {
      return this.cfg.volMedMult;
    }

    // Calculate percentrank of current ATR
    const currentAtr = this.atr;
    const lookback = Math.min(this._atrBuffer.length, this.cfg.atrPercentileLookback);
    const slice = this._atrBuffer.slice(-lookback);

    let countBelow = 0;
    for (const val of slice) {
      if (val < currentAtr) countBelow++;
    }

    const percentile = (countBelow / lookback) * 100;

    if (percentile >= this.cfg.volHighPercentile) {
      return this.cfg.volHighMult; // High volatility - reduce signal strength
    } else if (percentile <= this.cfg.volLowPercentile) {
      return this.cfg.volLowMult; // Low volatility - increase signal strength
    }
    return this.cfg.volMedMult;
  }

  /**
   * Get dynamic threshold based on ADX
   */
  _getDynamicThreshold() {
    if (this.adx === null) return this.cfg.thresholdDefault;

    if (this.adx > this.cfg.adxStrong) return this.cfg.thresholdStrong;
    if (this.adx > this.cfg.adxOk) return this.cfg.thresholdOk;
    if (this.adx > this.cfg.adxWeak) return this.cfg.thresholdWeak;
    return this.cfg.thresholdDefault;
  }

  // ============================================================
  // CONFLUENCE & SCORING
  // ============================================================

  /**
   * Calculate 8-point confluence (respects gate toggles for isolation testing)
   */
  _calculateConfluence() {
    let longConf = 0;
    let shortConf = 0;

    // Count enabled gates for dynamic minConfluence scaling
    this._enabledGateCount = 0;

    // 1. Supertrend
    if (this.cfg.enableGateSupertrend) {
      this._enabledGateCount++;
      this._stGateLong = this._trendDirection < 0;
      this._stGateShort = this._trendDirection > 0;
      if (this._stGateLong) longConf++;
      if (this._stGateShort) shortConf++;
    } else {
      this._stGateLong = true; // Pass through when disabled
      this._stGateShort = true;
    }

    // 2. EMA Cross (fast vs mid)
    if (this.cfg.enableGateEmaCross) {
      this._enabledGateCount++;
      const emaCrossUp =
        this._emaFast !== null && this._emaMid !== null && this._emaFast > this._emaMid;
      const emaCrossDn =
        this._emaFast !== null && this._emaMid !== null && this._emaFast < this._emaMid;
      this._emaCrossOK = emaCrossUp || emaCrossDn;
      if (emaCrossUp) longConf++;
      if (emaCrossDn) shortConf++;
    } else {
      this._emaCrossOK = true;
    }

    // 3. EMA Trend (mid vs slow)
    if (this.cfg.enableGateEmaTrend) {
      this._enabledGateCount++;
      const emaTrendUp =
        this._emaMid !== null && this._emaSlow !== null && this._emaMid > this._emaSlow;
      const emaTrendDn =
        this._emaMid !== null && this._emaSlow !== null && this._emaMid < this._emaSlow;
      this._emaTrendOK = emaTrendUp || emaTrendDn;
      if (emaTrendUp) longConf++;
      if (emaTrendDn) shortConf++;
    } else {
      this._emaTrendOK = true;
    }

    // 4. MACD
    if (this.cfg.enableGateMacd) {
      this._enabledGateCount++;
      const macdBull = this._macdHist !== null && this._macdHist > 0;
      const macdBear = this._macdHist !== null && this._macdHist < 0;
      this._macdGateOK = macdBull || macdBear;
      if (macdBull) longConf++;
      if (macdBear) shortConf++;
    } else {
      this._macdGateOK = true;
    }

    // 5. Stochastic
    if (this.cfg.enableGateStoch) {
      this._enabledGateCount++;
      const stochBull = this._stochK !== null && this._stochK > 50;
      const stochBear = this._stochK !== null && this._stochK < 50;
      this._stochGateOK = stochBull || stochBear;
      if (stochBull) longConf++;
      if (stochBear) shortConf++;
    } else {
      this._stochGateOK = true;
    }

    // 6. RSI
    if (this.cfg.enableGateRsi) {
      this._enabledGateCount++;
      const rsiBull = this.rsi !== null && this.rsi > 50;
      const rsiBear = this.rsi !== null && this.rsi < 50;
      this._rsiGateOK = rsiBull || rsiBear;
      if (rsiBull) longConf++;
      if (rsiBear) shortConf++;
    } else {
      this._rsiGateOK = true;
    }

    // 7. ADX (trending - same for both sides)
    if (this.cfg.enableGateAdx) {
      this._enabledGateCount++;
      this._adxTrending = this.adx !== null && this.adx >= this.cfg.adxThreshold;
      if (this._adxTrending) {
        longConf++;
        shortConf++;
      }
    } else {
      this._adxTrending = true;
    }

    // 8. Volume (above average - same for both sides)
    if (this.cfg.enableGateVolume) {
      this._enabledGateCount++;
      const currentVol = this.volumes.length > 0 ? this.volumes[this.volumes.length - 1] : 0;
      this._volumeOK = this._volumeAvg !== null && currentVol > this._volumeAvg;
      if (this._volumeOK) {
        longConf++;
        shortConf++;
      }
    } else {
      this._volumeOK = true;
    }

    this._confluenceLong = longConf;
    this._confluenceShort = shortConf;
  }

  /**
   * Normalize weights when some score components are disabled.
   * Returns an object with effective weights that sum to 1.0.
   */
  _getNormalizedWeights() {
    const components = [
      { key: "trend", weight: this.cfg.weightTrend, enabled: this.cfg.enableScoreTrend },
      { key: "macd", weight: this.cfg.weightMacd, enabled: this.cfg.enableScoreMacd },
      { key: "delta", weight: this.cfg.weightDelta, enabled: this.cfg.enableScoreDelta },
      { key: "rsi", weight: this.cfg.weightRsi, enabled: this.cfg.enableScoreRsi },
      { key: "stoch", weight: this.cfg.weightStoch, enabled: this.cfg.enableScoreStoch },
      { key: "adx", weight: this.cfg.weightAdx, enabled: this.cfg.enableScoreAdx },
      { key: "volume", weight: this.cfg.weightVolume, enabled: this.cfg.enableScoreVolume },
    ];

    // Sum of enabled weights
    let enabledSum = 0;
    for (const c of components) {
      if (c.enabled) enabledSum += c.weight;
    }

    // If no components enabled, return uniform weights
    if (enabledSum <= 0) {
      const n = components.length;
      const uniform = 1 / n;
      return Object.fromEntries(components.map((c) => [c.key, uniform]));
    }

    // Normalize weights
    const normalized = {};
    for (const c of components) {
      normalized[c.key] = c.enabled ? c.weight / enabledSum : 0;
    }
    return normalized;
  }

  /**
   * Calculate weighted scores (0-100%)
   * Respects score component toggles and normalizes weights.
   */
  _calculateScores() {
    // Update volatility multiplier
    this._volMultiplier = this._getVolatilityMultiplier();

    // Get normalized weights (handles disabled components)
    const w = this._getNormalizedWeights();

    // Long scores - only calculate enabled components
    const longTrend = this.cfg.enableScoreTrend
      ? (this._stGateLong ? 1 : 0) * (this._emaCrossOK && this._emaFast > this._emaMid ? 1 : 0.5)
      : 0;
    const longMacd = this.cfg.enableScoreMacd
      ? this._macdHist !== null && this._macdHist > 0
        ? Math.min((Math.abs(this._macdHist) / (this.atr || 1)) * 10, 1)
        : 0
      : 0;
    const longDelta = this.cfg.enableScoreDelta ? (this._deltaMomentum ? 1 : 0) : 0;
    const longRsi = this.cfg.enableScoreRsi
      ? this.rsi !== null
        ? Math.max(0, (this.rsi - 30) / 40)
        : 0.5
      : 0;
    const longStoch = this.cfg.enableScoreStoch
      ? this._stochK !== null
        ? Math.max(0, (this._stochK - 20) / 60)
        : 0.5
      : 0;
    const longAdx = this.cfg.enableScoreAdx
      ? this.adx !== null
        ? Math.min(this.adx / 50, 1)
        : 0
      : 0;
    const longVol = this.cfg.enableScoreVolume ? (this._volumeOK ? 1 : 0.5) : 0;

    this._longPct =
      (longTrend * w.trend +
        longMacd * w.macd +
        longDelta * w.delta +
        longRsi * w.rsi +
        longStoch * w.stoch +
        longAdx * w.adx +
        longVol * w.volume) *
      this._volMultiplier *
      100;

    // Short scores - only calculate enabled components
    const shortTrend = this.cfg.enableScoreTrend
      ? (this._stGateShort ? 1 : 0) * (this._emaCrossOK && this._emaFast < this._emaMid ? 1 : 0.5)
      : 0;
    const shortMacd = this.cfg.enableScoreMacd
      ? this._macdHist !== null && this._macdHist < 0
        ? Math.min((Math.abs(this._macdHist) / (this.atr || 1)) * 10, 1)
        : 0
      : 0;
    const shortDelta = this.cfg.enableScoreDelta ? (!this._deltaMomentum ? 1 : 0) : 0;
    const shortRsi = this.cfg.enableScoreRsi
      ? this.rsi !== null
        ? Math.max(0, (70 - this.rsi) / 40)
        : 0.5
      : 0;
    const shortStoch = this.cfg.enableScoreStoch
      ? this._stochK !== null
        ? Math.max(0, (80 - this._stochK) / 60)
        : 0.5
      : 0;
    const shortAdx = this.cfg.enableScoreAdx
      ? this.adx !== null
        ? Math.min(this.adx / 50, 1)
        : 0
      : 0;
    const shortVol = this.cfg.enableScoreVolume ? (this._volumeOK ? 1 : 0.5) : 0;

    this._shortPct =
      (shortTrend * w.trend +
        shortMacd * w.macd +
        shortDelta * w.delta +
        shortRsi * w.rsi +
        shortStoch * w.stoch +
        shortAdx * w.adx +
        shortVol * w.volume) *
      this._volMultiplier *
      100;
  }

  /**
   * Check signal conditions
   *
   * Signal Types:
   * 1. BUY/SELL: Triggered on Supertrend flip with EMA alignment and delta confirmation
   * 2. PERFECT: High-conviction signal with score >= threshold and all gates passing
   *
   * Note: Prev states are updated in getSignal() to preserve edges when in position
   */
  _checkSignalConditions() {
    // NOTE: We do NOT update prev states here - that happens in getSignal()
    // This ensures edge triggers aren't consumed when in a position

    // Use pre-computed Supertrend flip flags (calculated in _updateSupertrend before _prevTrendDirection is updated)
    const supertrendFlipBullish = this._supertrendFlippedBullish;
    const supertrendFlipBearish = this._supertrendFlippedBearish;

    // EMA cross detection (additional confirmation)
    const emaCrossUp =
      this._prevEmaFast !== null &&
      this._prevEmaMid !== null &&
      this._prevEmaFast <= this._prevEmaMid &&
      this._emaFast > this._emaMid;
    const emaCrossDn =
      this._prevEmaFast !== null &&
      this._prevEmaMid !== null &&
      this._prevEmaFast >= this._prevEmaMid &&
      this._emaFast < this._emaMid;

    // EMA alignment (not requiring cross, just current state)
    const emaAlignedBullish = this._emaFast > this._emaMid;
    const emaAlignedBearish = this._emaFast < this._emaMid;

    const triggerMode = String(this.cfg.buySellEntryTrigger || "st_flip_or_ema_cross")
      .trim()
      .toLowerCase();
    const useFlipOnly = triggerMode === "st_flip_only" || triggerMode === "st_flip";
    const triggerLongOk = useFlipOnly
      ? supertrendFlipBullish
      : supertrendFlipBullish || (emaCrossUp && emaAlignedBullish);
    const triggerShortOk = useFlipOnly
      ? supertrendFlipBearish
      : supertrendFlipBearish || (emaCrossDn && emaAlignedBearish);

    const requireDelta = this.cfg.buySellRequireDelta !== false;
    const deltaLongOk = requireDelta ? this._deltaMomentum : true;
    const deltaShortOk = requireDelta ? !this._deltaMomentum : true;

    // BUY signal: Supertrend flip (and optionally EMA cross), optionally with delta confirmation
    this._buyCondition =
      this.cfg.enableBuySellSignals &&
      this._trendDirection < 0 && // Bullish Supertrend
      triggerLongOk &&
      deltaLongOk;

    // SELL signal: Supertrend flip (and optionally EMA cross), optionally with delta confirmation
    this._sellCondition =
      this.cfg.enableBuySellSignals &&
      this._trendDirection > 0 && // Bearish Supertrend
      triggerShortOk &&
      deltaShortOk;

    // PERFECT LONG signal - relaxed volumeRatio, focus on score and confluence
    const threshold = this._getDynamicThreshold();
    const currentVolume = this.volumes.length > 0 ? this.volumes[this.volumes.length - 1] : 0;
    const volumeRatio = this._volumeAvg > 0 ? currentVolume / this._volumeAvg : 1.0; // Default to 1.0 if no avg
    const volumeOK = volumeRatio >= this.cfg.minVolumeRatio || this._volumeAvg === 0;

    // Scale minConfluence based on enabled gates when in isolation mode
    const effectiveMinConf =
      this._enabledGateCount < 8
        ? Math.max(1, Math.floor((this.cfg.minConfluence * this._enabledGateCount) / 8))
        : this.cfg.minConfluence;

    // Direction check can be relaxed for isolation testing
    const longDirOK = this.cfg.relaxPerfectDirection || this._trendDirection < 0;
    const shortDirOK = this.cfg.relaxPerfectDirection || this._trendDirection > 0;

    // ADX trending check can be bypassed if gate is disabled
    const adxOK = !this.cfg.enableGateAdx || this._adxTrending;

    // Delta momentum check can be bypassed if score component is disabled
    const deltaLongOK = !this.cfg.enableScoreDelta || this._deltaMomentum;
    const deltaShortOK = !this.cfg.enableScoreDelta || !this._deltaMomentum;

    this._perfectLongCondition =
      this.cfg.enablePerfectSignals &&
      this._longPct >= threshold &&
      this._confluenceLong >= effectiveMinConf &&
      longDirOK &&
      volumeOK &&
      adxOK &&
      deltaLongOK;

    // PERFECT SHORT signal
    this._perfectShortCondition =
      this.cfg.enablePerfectSignals &&
      this._shortPct >= threshold &&
      this._confluenceShort >= effectiveMinConf &&
      shortDirOK &&
      volumeOK &&
      adxOK &&
      deltaShortOK;
  }

  // ============================================================
  // PUBLIC METHODS
  // ============================================================

  /**
   * Update on bar completion
   */
  update({ price, close, volume, high, low, ts, takerBuyBaseVolume }) {
    // Use candle timestamp when provided (backtests), otherwise fall back to wall-clock (live)
    this._currentTs = Number.isFinite(ts) ? ts : Date.now();

    const closePrice = close ?? price;
    const highPrice = high ?? closePrice;
    const lowPrice = low ?? closePrice;
    const vol = volume ?? 0;
    const takerBuy = takerBuyBaseVolume ?? null;

    // Add to buffers
    this.prices.push(closePrice);
    this.closes.push(closePrice);
    this.highs.push(highPrice);
    this.lows.push(lowPrice);
    this.volumes.push(vol);
    this.takerBuyBaseVolumes.push(Number.isFinite(Number(takerBuy)) ? Number(takerBuy) : null);

    // Limit buffer sizes
    const maxLen =
      Math.max(this.cfg.emaSlow, this.cfg.atrPercentileLookback, this.cfg.minBars) + 50;
    if (this.prices.length > maxLen) {
      this.prices.shift();
      this.closes.shift();
      this.highs.shift();
      this.lows.shift();
      this.volumes.shift();
      this.takerBuyBaseVolumes.shift();
    }

    // Update indicators
    this._updateAtr();
    this._updateSupertrend();
    this._updateVolumeDelta();
    this._updateEmas();
    this._updateMacd();
    this._updateStochastic();
    this._updateRsi();
    this._updateAdx();
    this._updateVolumeAvg();

    // Calculate confluence and scores
    this._calculateConfluence();
    this._calculateScores();

    // Check signal conditions
    this._checkSignalConditions();

    // Update bar index
    this._currentBarIndex++;

    // Volume data validation - CVD is critical for Predicta strategy
    this._totalVolumeBars++;
    if (vol === 0 || !Number.isFinite(vol)) {
      this._zeroVolumeBars++;

      // Alert after threshold of consecutive zero-volume bars
      if (!this._volumeAlertShown && this._zeroVolumeBars >= this._volumeAlertThreshold) {
        this._volumeAlertShown = true;
        console.error(
          `🚨 [Predicta] ${this.cfg.market} CRITICAL: No volume data detected for ${this._zeroVolumeBars} bars!`
        );
        console.error(`   CVD indicator is BROKEN - delta momentum will be inaccurate`);
        console.error(`   FIX: Set ENABLE_VOLUME_FETCH=true in your environment`);
      }
    } else {
      // Reset counter when we get real volume
      if (this._zeroVolumeBars > 0 && this._volumeAlertShown) {
        console.log(
          `✅ [Predicta] ${this.cfg.market} Volume data restored (was missing for ${this._zeroVolumeBars} bars)`
        );
      }
      this._zeroVolumeBars = 0;
    }

    // Check if ready
    if (!this._ready && this._currentBarIndex >= this.cfg.minBars) {
      this._ready = true;

      // Check volume health when becoming ready
      const zeroVolPct =
        this._totalVolumeBars > 0 ? (this._zeroVolumeBars / this._totalVolumeBars) * 100 : 0;
      if (zeroVolPct > 50) {
        console.warn(
          `⚠️  [Predicta] ${this.cfg.market} WARNING: ${zeroVolPct.toFixed(0)}% of warmup bars had zero volume`
        );
        console.warn(`   CVD/Delta indicators may be unreliable until live volume data flows`);
      }

      if (!this.cfg.quiet) {
        console.log(`[Predicta] ${this.cfg.market} Ready after ${this._currentBarIndex} bars`);
      }
    }

    // Verbose logging
    if (this.cfg.verbose && this._ready) {
      const stArrow = this._trendDirection < 0 ? "↑" : "↓";
      console.log(
        `[Predicta-DBG] ${this.cfg.market} Bar#${this._currentBarIndex}: ` +
          `ST=${stArrow} EMA=${this._emaFast?.toFixed(2)}/${this._emaMid?.toFixed(2)}/${this._emaSlow?.toFixed(2)} ` +
          `RSI=${this.rsi?.toFixed(1)} Stoch=${this._stochK?.toFixed(1)} ADX=${this.adx?.toFixed(1)} ` +
          `MACD=${this._macdHist?.toFixed(4)} Δ=${this._volumeDelta?.toFixed(0)}/${this._deltaEma?.toFixed(0)}`
      );
    }
  }

  /**
   * Recalculate on intra-bar update
   *
   * NOTE: Predicta strategy is BAR-BASED ONLY. All indicators use smoothing
   * (Wilder's smoothing for RSI/ADX, EMA smoothing for MACD/EMAs) that should
   * only be applied ONCE per completed bar.
   *
   * Calling indicator updates every tick would corrupt the smoothing calculations:
   * - RSI: Wilder's smoothing applied multiple times per bar = wrong values
   * - ADX: Wilder's smoothing for TR/DM = wrong values
   * - MACD: EMA smoothing applied multiple times = wrong values
   * - VolumeDelta: CVD uses bar's total volume, not tick volume
   *
   * This method is intentionally a NO-OP for Predicta.
   * Use update() on bar completion only.
   */
  recalculateLastBar({ close, high, low, volume, takerBuyBaseVolume }) {
    // NO-OP: Predicta indicators are bar-based only
    // Intra-bar updates would corrupt Wilder's smoothing calculations
    // All indicators updated in update() method on bar completion
  }

  /**
   * Update on tick (optional)
   */
  updateTick({ price, volume, ts }) {
    // Currently no tick-level processing needed
    // Can be extended for real-time adjustments
  }

  /**
   * Get trading signal
   */
  getSignal(price, positions = [], printGates = false, tickIndex = null) {
    if (!this._ready) {
      this._lastReason = "warming_up";
      return { action: "hold", confidence: 0, reason: "warming_up", strategyType: "predicta" };
    }

    // Check circuit breaker
    const now = this._now();
    if (now < this.circuitBreakerUntil) {
      this._lastReason = "circuit_breaker";
      return { action: "hold", confidence: 0, reason: "circuit_breaker", strategyType: "predicta" };
    }

    // Check if already in position
    const inPos = positions.some((p) => !p.exitTime);

    // Print gates if requested
    if (printGates) {
      this._printGates();
    }

    // Check for exits first
    if (inPos) {
      for (const pos of positions) {
        if (pos.exitTime) continue;
        const closeSignal = this.shouldClose(pos, price);
        if (closeSignal && closeSignal.close) {
          this._lastReason = closeSignal.reason;
          return {
            action: "close",
            side: pos.side,
            confidence: this.cfg.perfectConfidence,
            reason: closeSignal.reason,
            strategyType: "predicta",
            ...closeSignal,
          };
        }
      }
      // In position but no exit - DON'T update prev states (preserve edges)
      this._lastReason = "in_pos";
      return { action: "hold", confidence: 0, reason: "in_position", strategyType: "predicta" };
    }

    // NOT in position - check for entry signals
    // First, calculate edge triggers BEFORE updating prev states
    const useEdge = this.cfg.enableEdgeTrigger;

    // Check PERFECT signals first (higher priority)
    const perfectLongEdge = useEdge
      ? this._perfectLongCondition && !this._prevPerfectLong
      : this._perfectLongCondition;
    const perfectShortEdge = useEdge
      ? this._perfectShortCondition && !this._prevPerfectShort
      : this._perfectShortCondition;

    if (perfectLongEdge && this.cfg.allowLongs) {
      if (this._checkCooldowns("long")) {
        this._markEntry("long");
        this._updatePrevStates(); // Consume edge
        this._lastReason = "perfect_long";
        if (!this.cfg.quiet) {
          console.log(
            `[Predicta] ${this.cfg.market} ★ PERFECT LONG: score=${this._longPct.toFixed(1)}% conf=${this._confluenceLong}/8`
          );
        }
        return {
          action: "open",
          side: "long",
          confidence: this.cfg.perfectConfidence,
          reason: "perfect_long",
          strategyType: "predicta",
          signalType: "perfect",
          confluence: this._confluenceLong,
          score: this._longPct,
        };
      }
    }

    if (perfectShortEdge && this.cfg.allowShorts) {
      if (this._checkCooldowns("short")) {
        this._markEntry("short");
        this._updatePrevStates(); // Consume edge
        this._lastReason = "perfect_short";
        if (!this.cfg.quiet) {
          console.log(
            `[Predicta] ${this.cfg.market} ★ PERFECT SHORT: score=${this._shortPct.toFixed(1)}% conf=${this._confluenceShort}/8`
          );
        }
        return {
          action: "open",
          side: "short",
          confidence: -this.cfg.perfectConfidence,
          reason: "perfect_short",
          strategyType: "predicta",
          signalType: "perfect",
          confluence: this._confluenceShort,
          score: this._shortPct,
        };
      }
    }

    // Check BUY/SELL signals
    const buyEdge = useEdge ? this._buyCondition && !this._prevBuyCondition : this._buyCondition;
    const sellEdge = useEdge
      ? this._sellCondition && !this._prevSellCondition
      : this._sellCondition;

    const buySellFiltersOk = (side) => {
      if (!this.cfg.enableBuySellSignals) return false;
      const s = String(side || "").toLowerCase();
      const isLong = s === "long";
      const confluence = isLong ? this._confluenceLong : this._confluenceShort;
      const score = isLong ? this._longPct : this._shortPct;

      // Dynamic minConfluence scaling based on enabled gates (prevents "8-gate default" from suppressing isolation).
      const baseMinConfRaw = Number(this.cfg.buySellMinConfluence || 0);
      const baseMinConf = baseMinConfRaw > 0 ? baseMinConfRaw : Number(this.cfg.minConfluence || 0);
      const enabledGates = Number(this._enabledGateCount || 0);
      const effectiveMinConf =
        enabledGates > 0 ? Math.max(1, Math.floor((baseMinConf * enabledGates) / 8)) : baseMinConf;

      const thresholdBase = this._getDynamicThreshold();
      const threshold = Math.max(
        0,
        Math.min(100, thresholdBase + Number(this.cfg.buySellScoreThresholdOffset || 0))
      );

      if (this.cfg.buySellUseConfluenceFilter) {
        if (!(confluence >= effectiveMinConf)) return false;
      }
      if (this.cfg.buySellUseScoreFilter) {
        if (!(score >= threshold)) return false;
      }
      return true;
    };

    if (buyEdge && this.cfg.allowLongs && buySellFiltersOk("long")) {
      if (this._checkCooldowns("long")) {
        this._markEntry("long");
        this._updatePrevStates(); // Consume edge
        this._lastReason = "buy_signal";
        if (!this.cfg.quiet) {
          console.log(
            `[Predicta] ${this.cfg.market} BUY: trigger=${this.cfg.buySellEntryTrigger} delta=${this.cfg.buySellRequireDelta ? "ON" : "OFF"} | conf=${this._confluenceLong}/8 score=${this._longPct.toFixed(1)}%`
          );
        }
        return {
          action: "open",
          side: "long",
          confidence: this.cfg.buySellConfidence,
          reason: "buy_signal",
          strategyType: "predicta",
          signalType: "buy_sell",
          confluence: this._confluenceLong,
          score: this._longPct,
        };
      }
    }

    if (sellEdge && this.cfg.allowShorts && buySellFiltersOk("short")) {
      if (this._checkCooldowns("short")) {
        this._markEntry("short");
        this._updatePrevStates(); // Consume edge
        this._lastReason = "sell_signal";
        if (!this.cfg.quiet) {
          console.log(
            `[Predicta] ${this.cfg.market} SELL: trigger=${this.cfg.buySellEntryTrigger} delta=${this.cfg.buySellRequireDelta ? "ON" : "OFF"} | conf=${this._confluenceShort}/8 score=${this._shortPct.toFixed(1)}%`
          );
        }
        return {
          action: "open",
          side: "short",
          confidence: -this.cfg.buySellConfidence,
          reason: "sell_signal",
          strategyType: "predicta",
          signalType: "buy_sell",
          confluence: this._confluenceShort,
          score: this._shortPct,
        };
      }
    }

    // No signal - update prev states for next check
    this._updatePrevStates();
    this._lastReason = "no_signal";
    return { action: "hold", confidence: 0, reason: "no_signal", strategyType: "predicta" };
  }

  /**
   * Update previous states for edge detection
   * Called after signal check to consume edges only when we could have acted
   */
  _updatePrevStates() {
    this._prevBuyCondition = this._buyCondition;
    this._prevSellCondition = this._sellCondition;
    this._prevPerfectLong = this._perfectLongCondition;
    this._prevPerfectShort = this._perfectShortCondition;
  }

  /**
   * Print gate status for debugging
   */
  _printGates() {
    const stArrow = this._trendDirection < 0 ? "↑" : "↓";
    console.log(`[Predicta] ${this.cfg.market} Confluence Gates:`);
    console.log(
      `  ST:${this._stGateLong ? "✅L" : ""}${this._stGateShort ? "✅S" : ""} | ` +
        `EMA:${this._emaCrossOK ? "✅" : "❌"} | Trend:${this._emaTrendOK ? "✅" : "❌"} | ` +
        `MACD:${this._macdGateOK ? "✅" : "❌"} | Stoch:${this._stochGateOK ? "✅" : "❌"} | ` +
        `RSI:${this._rsiGateOK ? "✅" : "❌"} | ADX:${this._adxTrending ? "✅" : "❌"} | ` +
        `Vol:${this._volumeOK ? "✅" : "❌"}`
    );
    console.log(
      `  L:${this._confluenceLong}/8 S:${this._confluenceShort}/8 | ` +
        `Score L:${this._longPct.toFixed(1)}% S:${this._shortPct.toFixed(1)}% | ` +
        `Threshold:${this._getDynamicThreshold()}%`
    );
  }

  /**
   * Check if position should be closed
   * Exit priority: time > supertrend > ema_cross > opposite_perfect > trailing > hard_stop
   */
  shouldClose(position, price, currentBarIndex = null) {
    if (!position) return false;

    const side = position.side?.toLowerCase();
    const entryPrice = position.entryPrice;
    const openBarIndex = position.openBarIndex ?? this._currentBarIndex;
    const effectiveBarIndex = currentBarIndex !== null ? currentBarIndex : this._currentBarIndex;
    const barsHeld = effectiveBarIndex - openBarIndex;

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false;

    // Calculate P&L
    const pnlPct =
      side === "long" ? (price - entryPrice) / entryPrice : (entryPrice - price) / entryPrice;

    // 1. TIME STOP
    if (this.cfg.enableTimeStop && barsHeld >= this.cfg.timeStopBars) {
      return { close: true, reason: "predicta_time_stop", timeOut: true, barsHeld, pnlPct };
    }

    // 2. SUPERTREND FLIP
    if (this.cfg.supertrendExit) {
      if (side === "long" && this._trendDirection > 0) {
        return { close: true, reason: "supertrend_flip", trendReversal: true, pnlPct };
      }
      if (side === "short" && this._trendDirection < 0) {
        return { close: true, reason: "supertrend_flip", trendReversal: true, pnlPct };
      }
    }

    // 3. EMA CROSS EXIT (edge-triggered)
    if (this.cfg.emaCrossExit) {
      // Use exit EMAs if configured, otherwise fallback to entry EMAs
      const emaFast = this._emaExitFast !== null ? this._emaExitFast : this._emaFast;
      const emaSlow = this._emaExitSlow !== null ? this._emaExitSlow : this._emaMid;
      const prevEmaFast = this._prevEmaExitFast !== null ? this._prevEmaExitFast : this._prevEmaFast;
      const prevEmaSlow = this._prevEmaExitSlow !== null ? this._prevEmaExitSlow : this._prevEmaMid;

      // Detect EMA cross in opposite direction
      // Long exit: fast crosses below slow (bearish cross)
      if (side === "long" && 
          prevEmaFast !== null && prevEmaSlow !== null &&
          emaFast !== null && emaSlow !== null &&
          prevEmaFast >= prevEmaSlow && 
          emaFast < emaSlow) {
        return { close: true, reason: "ema_cross_exit", emaCrossReversal: true, pnlPct };
      }
      // Short exit: fast crosses above slow (bullish cross)
      if (side === "short" && 
          prevEmaFast !== null && prevEmaSlow !== null &&
          emaFast !== null && emaSlow !== null &&
          prevEmaFast <= prevEmaSlow && 
          emaFast > emaSlow) {
        return { close: true, reason: "ema_cross_exit", emaCrossReversal: true, pnlPct };
      }
    }

    // 4. OPPOSITE PERFECT SIGNAL (edge-triggered)
    if (this.cfg.oppositePerfectExit) {
      if (side === "long" && this._perfectShortCondition && !this._prevPerfectShort) {
        return { close: true, reason: "opposite_perfect_short", signalReversal: true, pnlPct };
      }
      if (side === "short" && this._perfectLongCondition && !this._prevPerfectLong) {
        return { close: true, reason: "opposite_perfect_long", signalReversal: true, pnlPct };
      }
    }

    // 4. TRAILING STOP
    if (this.cfg.enableTrailingStop && position.highWaterMark && this.atr) {
      const trailDistance = this.atr * this.cfg.trailingAtrMult;
      if (side === "long" && price <= position.highWaterMark - trailDistance) {
        return { close: true, reason: "predicta_trailing_stop", trailingStop: true, pnlPct };
      }
      if (
        side === "short" &&
        position.lowWaterMark &&
        price >= position.lowWaterMark + trailDistance
      ) {
        return { close: true, reason: "predicta_trailing_stop", trailingStop: true, pnlPct };
      }
    }

    // 5. HARD STOP
    if (this.cfg.hardStopEnabled) {
      const positionLeverage = position.leverage || 1;
      let percentStopDistance = 0;
      let atrStopDistance = 0;

      if (this.cfg.hardStopPercent > 0) {
        percentStopDistance = (entryPrice * (this.cfg.hardStopPercent / 100)) / positionLeverage;
      }

      if (this.cfg.hardStopAtr > 0 && Number.isFinite(this.atr) && this.atr > 0) {
        atrStopDistance = this.atr * this.cfg.hardStopAtr;
      }

      const hardStopDistance =
        percentStopDistance > 0 && atrStopDistance > 0
          ? Math.min(percentStopDistance, atrStopDistance)
          : percentStopDistance || atrStopDistance;

      if (hardStopDistance > 0) {
        if (side === "long" && price <= entryPrice - hardStopDistance) {
          return {
            close: true,
            reason: "predicta_hard_stop",
            stopLoss: true,
            hardStop: true,
            pnlPct,
          };
        }
        if (side === "short" && price >= entryPrice + hardStopDistance) {
          return {
            close: true,
            reason: "predicta_hard_stop",
            stopLoss: true,
            hardStop: true,
            pnlPct,
          };
        }
      }
    }

    return false;
  }

  /**
   * Check open conditions
   */
  shouldOpenLong(price) {
    return this._perfectLongCondition || this._buyCondition;
  }

  shouldOpenShort(price) {
    return this._perfectShortCondition || this._sellCondition;
  }

  /**
   * Check cooldowns
   */
  _checkCooldowns(side) {
    const now = this._now();

    // Basic cooldown
    if (this.cfg.enableCooldown && now - this._lastEntryTs < this.cfg.cooldownMs) {
      return false;
    }

    // Same-bar guard
    if (this.cfg.enableSameBarGuard && this._lastOpenBarIndex === this._currentBarIndex) {
      return false;
    }

    // Flip cooldown
    if (this._lastFlipBarIndex !== null) {
      const barsSinceFlip = this._currentBarIndex - this._lastFlipBarIndex;
      if (barsSinceFlip < this.cfg.flipCooldownBars) {
        return false;
      }
    }

    // Same-side reentry
    if (this._lastClosedBarIndex !== null && this._lastClosedSide === side) {
      const barsSinceClose = this._currentBarIndex - this._lastClosedBarIndex;
      if (barsSinceClose < this.cfg.minBarsSameSideReentry) {
        return false;
      }
    }

    return true;
  }

  /**
   * Mark entry
   */
  _markEntry(side) {
    this._lastEntryTs = this._now();
    this._lastOpenBarIndex = this._currentBarIndex;

    // Track flip
    if (this._lastClosedSide && this._lastClosedSide !== side) {
      this._lastFlipBarIndex = this._currentBarIndex;
    }
  }

  /**
   * Get recommended position size multiplier
   */
  getRecommendedPositionSize(price, side, capital) {
    if (this._perfectLongCondition || this._perfectShortCondition) {
      return this.cfg.perfectSizeMult;
    }
    return this.cfg.buySellSizeMult;
  }

  /**
   * Record trade for performance tracking
   */
  recordTrade(trade) {
    if (!trade || typeof trade !== "object") return;

    const { pnlUsd = 0, pnlPercent = 0, exitReason = "unknown" } = trade;

    this.totalTrades++;

    if (pnlUsd > 0) {
      this.winningTrades++;
      this.consecutiveLosses = 0;
    } else if (pnlUsd < 0) {
      this.losingTrades++;
      this.consecutiveLosses++;

      // Check circuit breaker
      if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        this.circuitBreakerUntil = this._now() + this.cfg.circuitBreakerCooldownMs;
        if (!this.cfg.quiet) {
          console.log(
            `[Predicta] ${this.cfg.market} Circuit breaker triggered: ${this.consecutiveLosses} consecutive losses`
          );
        }
      }
    }

    this.totalPnL += pnlUsd;

    // Track closed position
    this._lastClosedBarIndex = this._currentBarIndex;
    this._lastClosedSide = trade.side;

    // Store in history
    this.tradeHistory.push({
      ts: this._now(),
      pnlUsd,
      pnlPercent,
      exitReason,
      side: trade.side,
    });
    if (this.tradeHistory.length > 100) {
      this.tradeHistory.shift();
    }

    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0;
    if (!this.cfg.quiet) {
      console.log(
        `[Predicta] Trade #${this.totalTrades}: ${exitReason} | PnL: $${pnlUsd.toFixed(2)} (${(pnlPercent * 100).toFixed(2)}%) | Win rate: ${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      winRate: this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0,
      totalPnL: this.totalPnL,
      consecutiveLosses: this.consecutiveLosses,
      circuitBreakerActive: this._now() < this.circuitBreakerUntil,
      volumeHealth: this.getVolumeHealth(),
    };
  }

  /**
   * Reset state
   */
  reset() {
    this._initializeState();
  }

  /**
   * Get data for pretty log formatting
   */
  getPrettyLogData(price) {
    const stArrow = this._trendDirection < 0 ? "↑" : "↓";

    const longIcon = this._perfectLongCondition
      ? "✅"
      : this._buyCondition
        ? "⚡"
        : this._confluenceLong >= this.cfg.minConfluence
          ? "❌"
          : "🚫";
    const shortIcon = this._perfectShortCondition
      ? "✅"
      : this._sellCondition
        ? "⚡"
        : this._confluenceShort >= this.cfg.minConfluence
          ? "❌"
          : "🚫";

    const deltaIcon = this._deltaMomentum ? "+" : "-";

    const gates = {
      st: this._stGateLong || this._stGateShort,
      ema: this._emaCrossOK,
      trend: this._emaTrendOK,
      macd: this._macdGateOK,
      stoch: this._stochGateOK,
      rsi: this._rsiGateOK,
      adx: this._adxTrending,
      vol: this._volumeOK,
    };

    return {
      stArrow,
      confluenceLong: this._confluenceLong,
      confluenceShort: this._confluenceShort,
      maxConfluence: 8,
      longPct: this._longPct,
      shortPct: this._shortPct,
      adx: this.adx,
      deltaIcon,
      longIcon,
      shortIcon,
      reason: this._lastReason || "no_signal",
      gates,
      gateStr: Object.entries(gates)
        .map(([k, v]) => `${k.toUpperCase()}=${v ? "✅" : "❌"}`)
        .join(" "),
      confGateOK: Math.max(this._confluenceLong, this._confluenceShort) >= this.cfg.minConfluence,
      minConfluence: this.cfg.minConfluence,
      adxGateOK: this.adx >= this.cfg.adxThreshold,
      adxThreshold: this.cfg.adxThreshold,
      deltaMomentum: this._deltaMomentum,
      rsi: this.rsi,
      stochK: this._stochK,
      atrPct: this.atr && price ? (this.atr / price) * 100 : 0,
      threshold: this._getDynamicThreshold(),
      volMultiplier: this._volMultiplier,
      volumeHealth: this.getVolumeHealth(),
    };
  }

  /**
   * Get volume data health status
   * CVD is critical for Predicta - this helps diagnose configuration issues
   */
  getVolumeHealth() {
    const zeroVolPct =
      this._totalVolumeBars > 0 ? (this._zeroVolumeBars / this._totalVolumeBars) * 100 : 0;

    return {
      totalBars: this._totalVolumeBars,
      zeroVolumeBars: this._zeroVolumeBars,
      zeroVolumePercent: zeroVolPct,
      hasVolumeData: this._zeroVolumeBars < this._totalVolumeBars,
      alertTriggered: this._volumeAlertShown,
      status:
        this._zeroVolumeBars === 0
          ? "healthy"
          : zeroVolPct > 90
            ? "critical"
            : zeroVolPct > 50
              ? "degraded"
              : "recovering",
    };
  }

  /**
   * Get current timestamp
   */
  _now() {
    // Prefer simulated candle timestamp for backtests; fall back to wall-clock in live
    return this._currentTs || Date.now();
  }
}

module.exports = PredictaStrategy;
