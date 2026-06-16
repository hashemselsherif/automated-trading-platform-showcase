// ichimoku-cloud-breakout-strategy.js
//
// Ichimoku Cloud Breakout Strategy (15m)
// - Bar-based entries and strategy exits (evaluated on completed bars)
// - Tick-based hard stops and ATR trailing (evaluated every tick)

class IchimokuCloudBreakoutStrategy {
  constructor(config = {}) {
    const s = config.ichimokuStrategy || config.strategy || {};

    const num = (val, fallback) => {
      if (val === undefined || val === null || val === "") return fallback;
      const n = Number(val);
      return Number.isFinite(n) ? n : fallback;
    };
    const bool = (val, fallback) => {
      if (val === undefined || val === null || val === "") return fallback;
      if (typeof val === "boolean") return val;
      const str = String(val).toLowerCase();
      return str === "1" || str === "true" || str === "yes" || str === "y";
    };
    const str = (val, fallback) => {
      if (val === undefined || val === null || val === "") return fallback;
      return String(val);
    };

    this.cfg = {
      market: config.market || "UNKNOWN",

      // Ichimoku parameters
      tenkanPeriod: num(s.tenkanPeriod, num(process.env.ICHIMOKU_TENKAN_PERIOD, 9)),
      kijunPeriod: num(s.kijunPeriod, num(process.env.ICHIMOKU_KIJUN_PERIOD, 26)),
      senkouBPeriod: num(s.senkouBPeriod, num(process.env.ICHIMOKU_SENKOU_B_PERIOD, 52)),
      shift: num(s.shift, num(process.env.ICHIMOKU_SHIFT, 26)),

      // Trend strength
      adxPeriod: num(s.adxPeriod, num(process.env.ICHIMOKU_ADX_PERIOD, 14)),
      adxMinTrend: num(s.adxMinTrend, num(process.env.ICHIMOKU_ADX_MIN_TREND, 20)),

      // ATR / risk sizing
      atrPeriod: num(s.atrPeriod, num(process.env.ICHIMOKU_ATR_PERIOD, 14)),
      atrStopMultiplier: num(
        s.atrStopMultiplier,
        num(process.env.ICHIMOKU_ATR_STOP_MULTIPLIER, 2.8)
      ),

      // Entry break buffer
      breakBufferBps: num(s.breakBufferBps, num(process.env.ICHIMOKU_BREAK_BUFFER_BPS, 0)),
      breakBufferAtr: num(s.breakBufferAtr, num(process.env.ICHIMOKU_BREAK_BUFFER_ATR, 0.1)),

      // Overextension veto
      maxEntryDistAtr: num(s.maxEntryDistAtr, num(process.env.ICHIMOKU_MAX_ENTRY_DIST_ATR, 1.5)),

      // Alignment
      requireTenkanKijunAlign: bool(
        s.requireTenkanKijunAlign,
        bool(process.env.ICHIMOKU_REQUIRE_TENKAN_KIJUN_ALIGN, true)
      ),
      // Chikou confirmation (optional)
      // Industry-standard confirmation (variation 2):
      // Chikou Span value is the *current* close, plotted `shift` bars back at `anchor = i - shift`.
      // Confirm by requiring current close to clear the candle(s) at the anchor time window:
      //   long: close[i] > max(high[anchor-lookback+1 .. anchor]) (+ optional buffer)
      //   short: close[i] < min(low[anchor-lookback+1 .. anchor]) (- optional buffer)
      requireChikouBreakout: bool(
        s.requireChikouBreakout,
        bool(
          // Support both names to avoid config drift across environments.
          process.env.ICHIMOKU_REQUIRE_CHIKOU_BREAKOUT ??
            process.env.ICHIMOKU_REQUIRE_CHIKOU_CLEAR,
          false
        )
      ),
      // Default to 26 (standard Ichimoku displacement) when not explicitly configured.
      chikouLookback: num(s.chikouLookback, num(process.env.ICHIMOKU_CHIKOU_LOOKBACK, 26)),
      chikouCompare: str(
        s.chikouCompare,
        process.env.ICHIMOKU_CHIKOU_COMPARE || "hilo"
      ).toLowerCase(),
      chikouBufferBps: num(s.chikouBufferBps, num(process.env.ICHIMOKU_CHIKOU_BUFFER_BPS, 0)),
      chikouBufferAtr: num(s.chikouBufferAtr, num(process.env.ICHIMOKU_CHIKOU_BUFFER_ATR, 0)),
      // Optional: require Chikou (current close shifted back) to be above/below cloud at anchor time.
      requireChikouAboveCloud: bool(
        s.requireChikouAboveCloud,
        bool(process.env.ICHIMOKU_CHIKOU_REQUIRE_ABOVE_CLOUD, false)
      ),
      // Optional: when requiring above/below cloud, use a lookback window ending at the anchor.
      // 0 => 1 bar (anchor only).
      chikouCloudLookback: num(
        s.chikouCloudLookback,
        num(process.env.ICHIMOKU_CHIKOU_CLOUD_LOOKBACK, 0)
      ),

      // VWAP confirmation (optional)
      // Note: bot/backtest volume is typically quote-volume (USD/USDT). We use it consistently as weights.
      requireVwapConfirm: bool(
        s.requireVwapConfirm,
        bool(process.env.ICHIMOKU_REQUIRE_VWAP_CONFIRM, false)
      ),
      // Rolling window in ms (24h default). This avoids timezone/session ambiguity for 24/7 crypto.
      vwapSessionMs: num(
        s.vwapSessionMs,
        num(process.env.ICHIMOKU_VWAP_SESSION_MS, 24 * 60 * 60 * 1000)
      ),
      // Require price to be beyond VWAP by this band (bps).
      vwapBandBps: num(s.vwapBandBps, num(process.env.ICHIMOKU_VWAP_BAND_BPS, 0)),
      // Optional: require an actual cross of the VWAP band (previous close on the other side).
      vwapRequireCross: bool(
        s.vwapRequireCross,
        bool(process.env.ICHIMOKU_VWAP_REQUIRE_CROSS, false)
      ),

      // HTF regime (optional)
      enableHtfRegime: bool(s.enableHtfRegime, bool(process.env.ICHIMOKU_ENABLE_HTF_REGIME, false)),
      htfMultiplier: num(s.htfMultiplier, num(process.env.ICHIMOKU_HTF_MULTIPLIER, 4)),
      htfAdxPeriod: num(s.htfAdxPeriod, num(process.env.ICHIMOKU_HTF_ADX_PERIOD, 14)),
      htfAdxMinTrend: num(s.htfAdxMinTrend, num(process.env.ICHIMOKU_HTF_ADX_MIN_TREND, 25)),
      htfUseChop: bool(s.htfUseChop, bool(process.env.ICHIMOKU_HTF_USE_CHOP, false)),
      htfChopPeriod: num(s.htfChopPeriod, num(process.env.ICHIMOKU_HTF_CHOP_PERIOD, 14)),
      htfChopRanging: num(s.htfChopRanging, num(process.env.ICHIMOKU_HTF_CHOP_RANGING, 61.8)),
      htfChopTrending: num(s.htfChopTrending, num(process.env.ICHIMOKU_HTF_CHOP_TRENDING, 38.2)),

      // Volume confirmation (optional)
      requireVolumeSpike: bool(
        s.requireVolumeSpike,
        bool(process.env.ICHIMOKU_REQUIRE_VOLUME_SPIKE, false)
      ),
      volumeLookback: num(s.volumeLookback, num(process.env.ICHIMOKU_VOLUME_LOOKBACK, 20)),
      volumeSpikeThreshold: num(
        s.volumeSpikeThreshold,
        num(process.env.ICHIMOKU_VOLUME_SPIKE_THRESHOLD, 1.5)
      ),

      // Ichimoku-native exits (bar-based)
      exitOnKijunBreak: bool(
        s.exitOnKijunBreak,
        bool(process.env.ICHIMOKU_EXIT_ON_KIJUN_BREAK, true)
      ),
      kijunBreakBufferBps: num(
        s.kijunBreakBufferBps,
        num(process.env.ICHIMOKU_KIJUN_BREAK_BUFFER_BPS, 0)
      ),
      kijunBreakBufferAtr: num(
        s.kijunBreakBufferAtr,
        num(process.env.ICHIMOKU_KIJUN_BREAK_BUFFER_ATR, 0.05)
      ),
      exitOnTenkanKijunCross: bool(
        s.exitOnTenkanKijunCross,
        bool(process.env.ICHIMOKU_EXIT_ON_TENKAN_KIJUN_CROSS, false)
      ),
      exitOnCloudReentry: bool(
        s.exitOnCloudReentry,
        bool(process.env.ICHIMOKU_EXIT_ON_CLOUD_REENTRY, true)
      ),
      exitOnCloudFlip: bool(
        s.exitOnCloudFlip,
        bool(process.env.ICHIMOKU_EXIT_ON_CLOUD_FLIP, false)
      ),
      timeStopBars: num(s.timeStopBars, num(process.env.ICHIMOKU_TIME_STOP_BARS, 0)),

      // Tick-based hard stops / trailing
      hardStopEnabled: bool(s.hardStopEnabled, bool(process.env.ICHIMOKU_HARD_STOP_ENABLED, false)),
      hardStopPercent: num(s.hardStopPercent, num(process.env.ICHIMOKU_HARD_STOP_PERCENT, 20)),
      hardStopAtrMult: num(s.hardStopAtrMult, num(process.env.ICHIMOKU_HARD_STOP_ATR_MULT, 0)),
      enableAtrTrail: bool(s.enableAtrTrail, bool(process.env.ICHIMOKU_ENABLE_ATR_TRAIL, false)),
      trailAtrMult: num(s.trailAtrMult, num(process.env.ICHIMOKU_TRAIL_ATR_MULT, 1.5)),

      // Momentum oscillator exit
      exitOscillator: str(
        s.exitOscillator,
        process.env.ICHIMOKU_EXIT_OSCILLATOR || "none"
      ).toLowerCase(),
      exitRsiPeriod: num(s.exitRsiPeriod, num(process.env.ICHIMOKU_EXIT_RSI_PERIOD, 14)),
      exitRsiLong: num(s.exitRsiLong, num(process.env.ICHIMOKU_EXIT_RSI_LONG, 50)),
      exitRsiShort: num(s.exitRsiShort, num(process.env.ICHIMOKU_EXIT_RSI_SHORT, 50)),
      exitMacdFast: num(s.exitMacdFast, num(process.env.ICHIMOKU_EXIT_MACD_FAST, 12)),
      exitMacdSlow: num(s.exitMacdSlow, num(process.env.ICHIMOKU_EXIT_MACD_SLOW, 26)),
      exitMacdSignal: num(s.exitMacdSignal, num(process.env.ICHIMOKU_EXIT_MACD_SIGNAL, 9)),

      // Direction control
      allowLongs: bool(s.allowLongs, bool(process.env.ALLOW_LONGS, true)),
      allowShorts: bool(s.allowShorts, bool(process.env.ALLOW_SHORTS, true)),

      // Time-of-day filters (UTC)
      // Parse comma-separated disabled hour(s): "00,01,02,03,04,05" disables 00:00-05:59 UTC
      tradingDisabledHoursUtc: this._parseHourList(
        s.tradingDisabledHoursUtc ?? process.env.TRADING_DISABLED_HOURS_UTC,
        ""
      ),
      // If allowed hours specified, disabled hours are ignored
      tradingAllowedHoursUtc: this._parseHourList(
        s.tradingAllowedHoursUtc ?? process.env.TRADING_ALLOWED_HOURS_UTC,
        ""
      ),

      // Debug
      verbose: bool(s.verbose, bool(process.env.DEBUG_ICHIMOKU_STRATEGY, false)),
    };

    // Normalize config where we accept a small fixed set of values.
    if (!["hilo", "close"].includes(this.cfg.chikouCompare)) {
      this.cfg.chikouCompare = "hilo";
    }

    const autoMinBars = Math.max(
      this.cfg.senkouBPeriod + this.cfg.shift + 5,
      this.cfg.adxPeriod * 2,
      this.cfg.atrPeriod * 2,
      this.cfg.exitRsiPeriod + 2,
      this.cfg.exitMacdSlow + this.cfg.exitMacdSignal + 5
    );
    this.cfg.minBars = num(s.minBars, num(process.env.ICHIMOKU_MIN_BARS, autoMinBars));

    // Bar buffers
    this.prices = [];
    this.highs = [];
    this.lows = [];
    this.volumes = [];
    this.timestamps = [];

    // Ichimoku arrays (aligned to bar index)
    this._tenkan = [];
    this._kijun = [];
    this._senkouA = [];
    this._senkouB = [];

    // Current values (for debugging/UI)
    this.tenkan = null;
    this.kijun = null;
    this.senkouA = null;
    this.senkouB = null;
    this.cloudTop = null;
    this.cloudBottom = null;
    this.cloudBullish = null;
    this.chikouLag = null;

    // Indicators
    this.adx = null;
    this.atr = null;
    this.rsi = null;
    this._macdHist = null;

    // Volume
    this.volumeAvg = null;
    this.volumeSpike = false;
    this._lastBarVolume = null;

    // VWAP (rolling window)
    this.vwap = null;
    this._prevVwap = null;
    this._vwapPvSum = 0;
    this._vwapVSum = 0;
    this._vwapPVs = [];
    this._vwapVs = [];
    this._vwapTs = [];

    // ADX/ATR state
    this._adxState = this._createAdxState();
    this._atrState = this._createAtrState();

    // RSI state
    this._rsiAvgGain = null;
    this._rsiAvgLoss = null;
    this._prevRsi = null;

    // MACD state
    this._macdEmaFast = null;
    this._macdEmaSlow = null;
    this._macdSignal = null;
    this._prevMacdHist = null;

    // HTF state (optional)
    this._htfBuffer = null;
    this._htfHighs = [];
    this._htfLows = [];
    this._htfCloses = [];
    this._htfTenkan = [];
    this._htfKijun = [];
    this._htfSenkouA = [];
    this._htfSenkouB = [];
    this._htfAdxState = this._createAdxState();
    this._htfAtrState = this._createAtrState();
    this._htfAdx = null;
    this._htfChop = null;
    this._htfBias = null;

    // Bar tracking
    this._barCount = 0;
    this._tickCount = 0;
    this._currentBarIndex = 0;
    this._lastSignalBarIndex = null;
    this._lastExitEvalBarIndex = null;
    this._ready = false;
    this._nowTs = null;
    this._lastBarClose = null;

    // Trade stats (used by backtests)
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.totalPnL = 0;
    this.consecutiveLosses = 0;
    this.maxConsecutiveLosses = 0;
  }

  // ============================================================
  // Helpers
  // ============================================================

  _ok(...xs) {
    return xs.every((v) => Number.isFinite(v));
  }

  _now() {
    return Number.isFinite(this._nowTs) ? this._nowTs : Date.now();
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

    // If allowed hours specified, check inclusion
    if (this.cfg.tradingAllowedHoursUtc && this.cfg.tradingAllowedHoursUtc.length > 0) {
      return this.cfg.tradingAllowedHoursUtc.includes(hour);
    }

    // If disabled hours specified, check exclusion
    if (this.cfg.tradingDisabledHoursUtc && this.cfg.tradingDisabledHoursUtc.length > 0) {
      return !this.cfg.tradingDisabledHoursUtc.includes(hour);
    }

    return true;
  }

  _createAdxState() {
    return {
      prevHigh: null,
      prevLow: null,
      prevClose: null,
      trSmoothing: null,
      plusDISmoothing: null,
      minusDISmoothing: null,
      dxAccum: [],
      adx: null,
      trAccum: [],
      plusDMAccum: [],
      minusDMAccum: [],
    };
  }

  _createAtrState() {
    return {
      prevClose: null,
      trueRanges: [],
      atr: null,
    };
  }

  _updateAdxState(state, high, low, close, period) {
    if (state.prevHigh == null) {
      state.prevHigh = high;
      state.prevLow = low;
      state.prevClose = close;
      return null;
    }

    const tr1 = high - low;
    const tr2 = Math.abs(high - state.prevClose);
    const tr3 = Math.abs(low - state.prevClose);
    const tr = Math.max(tr1, tr2, tr3);

    const plusDMRaw = high > state.prevHigh ? high - state.prevHigh : 0;
    const minusDMRaw = low < state.prevLow ? state.prevLow - low : 0;

    let plusDM = 0;
    let minusDM = 0;
    if (plusDMRaw > minusDMRaw) {
      plusDM = plusDMRaw;
      minusDM = 0;
    } else if (minusDMRaw > plusDMRaw) {
      plusDM = 0;
      minusDM = minusDMRaw;
    }

    if (state.trSmoothing == null) {
      state.trAccum.push(tr);
      state.plusDMAccum.push(plusDM);
      state.minusDMAccum.push(minusDM);

      if (state.trAccum.length >= period) {
        state.trSmoothing = state.trAccum.reduce((a, b) => a + b, 0) / period;
        state.plusDISmoothing = state.plusDMAccum.reduce((a, b) => a + b, 0) / period;
        state.minusDISmoothing = state.minusDMAccum.reduce((a, b) => a + b, 0) / period;
      }
    } else {
      state.trSmoothing = (state.trSmoothing * (period - 1) + tr) / period;
      state.plusDISmoothing = (state.plusDISmoothing * (period - 1) + plusDM) / period;
      state.minusDISmoothing = (state.minusDISmoothing * (period - 1) + minusDM) / period;
    }

    if (state.trSmoothing == null || state.trSmoothing === 0) {
      state.prevHigh = high;
      state.prevLow = low;
      state.prevClose = close;
      return null;
    }

    const plusDI = 100 * (state.plusDISmoothing / state.trSmoothing);
    const minusDI = 100 * (state.minusDISmoothing / state.trSmoothing);
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;

    if (state.adx == null) {
      state.dxAccum.push(dx);
      if (state.dxAccum.length >= period) {
        state.adx = state.dxAccum.reduce((a, b) => a + b, 0) / period;
      }
    } else {
      state.adx = (state.adx * (period - 1) + dx) / period;
    }

    state.prevHigh = high;
    state.prevLow = low;
    state.prevClose = close;
    return state.adx;
  }

  _updateAtrState(state, high, low, close, period) {
    if (state.prevClose == null) {
      state.prevClose = close;
      return null;
    }

    const tr1 = high - low;
    const tr2 = Math.abs(high - state.prevClose);
    const tr3 = Math.abs(low - state.prevClose);
    const tr = Math.max(tr1, tr2, tr3);

    state.trueRanges.push(tr);
    if (state.trueRanges.length > period * 2) state.trueRanges.shift();

    if (state.trueRanges.length < period) {
      state.prevClose = close;
      return null;
    }

    if (state.atr == null) {
      state.atr = state.trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
    } else {
      state.atr = (state.atr * (period - 1) + tr) / period;
    }

    state.prevClose = close;
    return state.atr;
  }

  _midpoint(period, highs, lows) {
    const n = highs.length;
    if (n < period) return null;
    const h = Math.max(...highs.slice(n - period));
    const l = Math.min(...lows.slice(n - period));
    return (h + l) / 2;
  }

  _updateIchimoku() {
    const tenkan = this._midpoint(this.cfg.tenkanPeriod, this.highs, this.lows);
    const kijun = this._midpoint(this.cfg.kijunPeriod, this.highs, this.lows);
    const senkouB = this._midpoint(this.cfg.senkouBPeriod, this.highs, this.lows);
    const senkouA = this._ok(tenkan, kijun) ? (tenkan + kijun) / 2 : null;

    this._tenkan.push(tenkan);
    this._kijun.push(kijun);
    this._senkouA.push(senkouA);
    this._senkouB.push(senkouB);

    this.tenkan = tenkan;
    this.kijun = kijun;
    this.senkouA = senkouA;
    this.senkouB = senkouB;

    const idx = this._tenkan.length - 1;
    const cloudIdx = idx - this.cfg.shift;
    const cloudA = cloudIdx >= 0 ? this._senkouA[cloudIdx] : null;
    const cloudB = cloudIdx >= 0 ? this._senkouB[cloudIdx] : null;
    if (this._ok(cloudA, cloudB)) {
      this.cloudTop = Math.max(cloudA, cloudB);
      this.cloudBottom = Math.min(cloudA, cloudB);
      this.cloudBullish = cloudA >= cloudB;
    } else {
      this.cloudTop = null;
      this.cloudBottom = null;
      this.cloudBullish = null;
    }
  }

  _updateVolumeAnalysis(volume) {
    const n = this.volumes.length;
    if (n >= this.cfg.volumeLookback) {
      const recent = this.volumes.slice(-this.cfg.volumeLookback);
      const sum = recent.reduce((a, b) => a + Math.max(0, b), 0);
      this.volumeAvg = sum / this.cfg.volumeLookback;
      const cur = Math.max(0, volume);
      this.volumeSpike =
        this.volumeAvg > 0 && cur >= this.volumeAvg * this.cfg.volumeSpikeThreshold;
    }
  }

  _updateRsi(closePrice) {
    const n = this.prices.length;
    if (n < 2) {
      this.rsi = null;
      return;
    }

    const period = this.cfg.exitRsiPeriod;
    if (n < period + 1) {
      this.rsi = null;
      return;
    }

    const change = closePrice - this.prices[n - 2];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    if (this._rsiAvgGain == null || this._rsiAvgLoss == null) {
      let g = 0;
      let l = 0;
      for (let i = n - period; i < n; i++) {
        const d = this.prices[i] - this.prices[i - 1];
        if (d > 0) g += d;
        else l += -d;
      }
      this._rsiAvgGain = g / period;
      this._rsiAvgLoss = l / period;
    } else {
      this._rsiAvgGain = (this._rsiAvgGain * (period - 1) + gain) / period;
      this._rsiAvgLoss = (this._rsiAvgLoss * (period - 1) + loss) / period;
    }

    if (this._rsiAvgLoss === 0) {
      this.rsi = this._rsiAvgGain === 0 ? 50 : 100;
    } else {
      const rs = this._rsiAvgGain / this._rsiAvgLoss;
      this.rsi = 100 - 100 / (1 + rs);
    }
  }

  _updateMacd(closePrice) {
    const kFast = 2 / (this.cfg.exitMacdFast + 1);
    const kSlow = 2 / (this.cfg.exitMacdSlow + 1);
    const kSignal = 2 / (this.cfg.exitMacdSignal + 1);

    this._macdEmaFast =
      this._macdEmaFast == null
        ? closePrice
        : this._macdEmaFast + kFast * (closePrice - this._macdEmaFast);
    this._macdEmaSlow =
      this._macdEmaSlow == null
        ? closePrice
        : this._macdEmaSlow + kSlow * (closePrice - this._macdEmaSlow);

    if (this._macdEmaFast != null && this._macdEmaSlow != null) {
      const macdLine = this._macdEmaFast - this._macdEmaSlow;
      this._macdSignal =
        this._macdSignal == null
          ? macdLine
          : this._macdSignal + kSignal * (macdLine - this._macdSignal);
      this._macdHist = macdLine - this._macdSignal;
    }
  }

  _updateHtf(bar) {
    if (!this.cfg.enableHtfRegime || !Number.isFinite(bar.close)) return;

    if (!this._htfBuffer) {
      this._htfBuffer = {
        count: 0,
        open: bar.close,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
      };
    }

    this._htfBuffer.count += 1;
    this._htfBuffer.high = Math.max(this._htfBuffer.high, bar.high);
    this._htfBuffer.low = Math.min(this._htfBuffer.low, bar.low);
    this._htfBuffer.close = bar.close;
    this._htfBuffer.volume += bar.volume || 0;

    if (this._htfBuffer.count < this.cfg.htfMultiplier) return;

    // Complete HTF bar
    const htfBar = {
      open: this._htfBuffer.open,
      high: this._htfBuffer.high,
      low: this._htfBuffer.low,
      close: this._htfBuffer.close,
      volume: this._htfBuffer.volume,
    };

    this._htfHighs.push(htfBar.high);
    this._htfLows.push(htfBar.low);
    this._htfCloses.push(htfBar.close);

    const tenkan = this._midpoint(this.cfg.tenkanPeriod, this._htfHighs, this._htfLows);
    const kijun = this._midpoint(this.cfg.kijunPeriod, this._htfHighs, this._htfLows);
    const senkouB = this._midpoint(this.cfg.senkouBPeriod, this._htfHighs, this._htfLows);
    const senkouA = this._ok(tenkan, kijun) ? (tenkan + kijun) / 2 : null;

    this._htfTenkan.push(tenkan);
    this._htfKijun.push(kijun);
    this._htfSenkouA.push(senkouA);
    this._htfSenkouB.push(senkouB);

    const htfIdx = this._htfTenkan.length - 1;
    const cloudIdx = htfIdx - this.cfg.shift;
    const cloudA = cloudIdx >= 0 ? this._htfSenkouA[cloudIdx] : null;
    const cloudB = cloudIdx >= 0 ? this._htfSenkouB[cloudIdx] : null;
    const cloudTop = this._ok(cloudA, cloudB) ? Math.max(cloudA, cloudB) : null;
    const cloudBottom = this._ok(cloudA, cloudB) ? Math.min(cloudA, cloudB) : null;

    this._htfAdx = this._updateAdxState(
      this._htfAdxState,
      htfBar.high,
      htfBar.low,
      htfBar.close,
      this.cfg.htfAdxPeriod
    );
    const htfAtr = this._updateAtrState(
      this._htfAtrState,
      htfBar.high,
      htfBar.low,
      htfBar.close,
      this.cfg.htfAdxPeriod
    );

    if (this.cfg.htfUseChop && Number.isFinite(htfAtr)) {
      this._htfChop = this._calculateChop(
        this._htfHighs,
        this._htfLows,
        htfAtr,
        this.cfg.htfChopPeriod
      );
    } else {
      this._htfChop = null;
    }

    this._htfBias = this._classifyHtfBias(
      htfBar.close,
      cloudTop,
      cloudBottom,
      this._htfAdx,
      this._htfChop
    );

    // Reset buffer
    this._htfBuffer = null;
  }

  _calculateChop(highs, lows, atr, period) {
    if (highs.length < period || lows.length < period) return null;
    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    const range = Math.max(...recentHighs) - Math.min(...recentLows);
    if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(atr)) return null;
    const atrSum = atr * period;
    const ratio = atrSum / range;
    return (100 * Math.log10(ratio)) / Math.log10(period);
  }

  _classifyHtfBias(close, cloudTop, cloudBottom, adx, chop) {
    if (!Number.isFinite(close) || !Number.isFinite(adx)) return null;

    if (this.cfg.htfUseChop && Number.isFinite(chop)) {
      if (chop >= this.cfg.htfChopRanging) return "choppy";
      if (chop <= this.cfg.htfChopTrending && adx < this.cfg.htfAdxMinTrend) return "choppy";
    }

    if (Number.isFinite(cloudTop) && Number.isFinite(cloudBottom)) {
      if (close > cloudTop && adx >= this.cfg.htfAdxMinTrend) return "bullish";
      if (close < cloudBottom && adx >= this.cfg.htfAdxMinTrend) return "bearish";
      if (close >= cloudBottom && close <= cloudTop) return "neutral";
    }

    return adx >= this.cfg.htfAdxMinTrend ? "neutral" : "choppy";
  }

  _breakBuffer(price) {
    if (Number.isFinite(this.atr) && this.cfg.breakBufferAtr > 0) {
      return this.atr * this.cfg.breakBufferAtr;
    }
    if (Number.isFinite(price) && this.cfg.breakBufferBps > 0) {
      return price * (this.cfg.breakBufferBps / 10000);
    }
    return 0;
  }

  _kijunBreakBuffer(price) {
    if (Number.isFinite(this.atr) && this.cfg.kijunBreakBufferAtr > 0) {
      return this.atr * this.cfg.kijunBreakBufferAtr;
    }
    if (Number.isFinite(price) && this.cfg.kijunBreakBufferBps > 0) {
      return price * (this.cfg.kijunBreakBufferBps / 10000);
    }
    return 0;
  }

  _chikouBreakoutBuffer(price) {
    // Same precedence as other buffers in this repo: ATR buffer overrides bps buffer.
    if (Number.isFinite(this.atr) && this.cfg.chikouBufferAtr > 0) {
      return this.atr * this.cfg.chikouBufferAtr;
    }
    if (Number.isFinite(price) && this.cfg.chikouBufferBps > 0) {
      return price * (this.cfg.chikouBufferBps / 10000);
    }
    return 0;
  }

  _updateVwap(price, volume, ts) {
    this._prevVwap = this.vwap;

    const p = Number(price);
    const v = Number(volume);
    const t = Number(ts);
    if (!Number.isFinite(t)) return;

    // Keep arrays aligned with bars even if volume is missing.
    let pv = 0;
    let vv = 0;
    if (Number.isFinite(p) && p > 0 && Number.isFinite(v) && v > 0) {
      pv = p * v;
      vv = v;
      this._vwapPvSum += pv;
      this._vwapVSum += vv;
    }
    this._vwapPVs.push(pv);
    this._vwapVs.push(vv);
    this._vwapTs.push(t);

    const sessionMs = Number(this.cfg.vwapSessionMs);
    if (Number.isFinite(sessionMs) && sessionMs > 0) {
      const cutoff = t - sessionMs;
      while (this._vwapTs.length > 0 && this._vwapTs[0] < cutoff) {
        const oldPv = this._vwapPVs.shift() ?? 0;
        const oldV = this._vwapVs.shift() ?? 0;
        this._vwapTs.shift();
        if (Number.isFinite(oldPv)) this._vwapPvSum -= oldPv;
        if (Number.isFinite(oldV)) this._vwapVSum -= oldV;
      }
    }

    this.vwap =
      Number.isFinite(this._vwapVSum) && this._vwapVSum > 0 && Number.isFinite(this._vwapPvSum)
        ? this._vwapPvSum / this._vwapVSum
        : null;
  }

  _vwapBandPct() {
    const bps = Number(this.cfg.vwapBandBps);
    return Number.isFinite(bps) && bps > 0 ? bps / 10000 : 0;
  }

  _isVwapConfirmOk(side, refPrice) {
    if (!this.cfg.requireVwapConfirm) return true;
    if (!Number.isFinite(refPrice) || refPrice <= 0) return false;
    if (!Number.isFinite(this.vwap) || this.vwap <= 0) return false;

    const bandPct = this._vwapBandPct();
    const s = String(side || "").toLowerCase();
    const upper = this.vwap * (1 + bandPct);
    const lower = this.vwap * (1 - bandPct);

    if (!this.cfg.vwapRequireCross) {
      if (s === "long") return refPrice >= upper;
      if (s === "short") return refPrice <= lower;
      return false;
    }

    // Cross confirmation: last close must be on the other side of the previous VWAP band.
    const prevClose = this.prices.length > 1 ? this.prices[this.prices.length - 2] : null;
    const prevVwap = this._prevVwap;
    if (!Number.isFinite(prevClose) || !Number.isFinite(prevVwap) || prevVwap <= 0) return false;
    const prevUpper = prevVwap * (1 + bandPct);
    const prevLower = prevVwap * (1 - bandPct);
    if (s === "long") return prevClose <= prevUpper && refPrice > upper;
    if (s === "short") return prevClose >= prevLower && refPrice < lower;
    return false;
  }

  _getCloudAtIndex(barIndex) {
    const i = Number(barIndex);
    const shift = Number(this.cfg.shift);
    if (!Number.isFinite(i) || !Number.isFinite(shift) || shift <= 0) return null;
    const cloudIdx = i - shift;
    const cloudA = cloudIdx >= 0 ? this._senkouA[cloudIdx] : null;
    const cloudB = cloudIdx >= 0 ? this._senkouB[cloudIdx] : null;
    if (!this._ok(cloudA, cloudB)) return null;
    return {
      cloudTop: Math.max(cloudA, cloudB),
      cloudBottom: Math.min(cloudA, cloudB),
      cloudA,
      cloudB,
      cloudIdx,
    };
  }

  _getChikouCloudLevelsAtAnchor() {
    const i = this.prices.length - 1;
    const shift = Number(this.cfg.shift);
    if (!Number.isFinite(i) || i < 0 || !Number.isFinite(shift) || shift <= 0) return null;

    const anchor = i - shift;
    if (anchor < 0) return null;

    const lbRaw = Number(this.cfg.chikouCloudLookback);
    const lookback = Number.isFinite(lbRaw) && lbRaw > 0 ? Math.floor(lbRaw) : 1;
    if (!Number.isFinite(lookback) || lookback <= 0) return null;

    const start = anchor - lookback + 1;
    const end = anchor;
    if (start < 0 || end < start) return null;

    let maxTop = -Infinity;
    let minBottom = Infinity;
    let count = 0;
    for (let j = start; j <= end; j++) {
      const cloud = this._getCloudAtIndex(j);
      if (!cloud) continue;
      if (Number.isFinite(cloud.cloudTop)) maxTop = Math.max(maxTop, cloud.cloudTop);
      if (Number.isFinite(cloud.cloudBottom)) minBottom = Math.min(minBottom, cloud.cloudBottom);
      count += 1;
    }
    if (count !== lookback) return null; // Require full window for deterministic gating.
    if (!Number.isFinite(maxTop) || !Number.isFinite(minBottom)) return null;
    return { anchorIdx: anchor, startIdx: start, endIdx: end, lookback, cloudTop: maxTop, cloudBottom: minBottom };
  }

  _getChikouBreakoutLevels() {
    // For current bar index i, the Chikou span is the current close plotted at i-shift.
    // A common confirmation is that it's clear of recent price action:
    //   long: close[t] above the highs (or closes) of the bar(s) at the Chikou plot location (i-shift)
    //   short: close[t] below the lows (or closes) of the bar(s) at the Chikou plot location (i-shift)
    const i = this.prices.length - 1;
    const lookbackRaw = Number(this.cfg.chikouLookback);
    const shift = Number(this.cfg.shift);
    const lookback = Number.isFinite(lookbackRaw) && lookbackRaw > 0 ? Math.floor(lookbackRaw) : 1;
    if (!Number.isFinite(i) || i < 1) return null;
    if (!Number.isFinite(shift) || shift <= 0) return null;
    if (!Number.isFinite(lookback) || lookback <= 0) return null;

    const anchor = i - shift;
    const start = anchor - lookback + 1;
    const end = anchor;
    if (anchor < 0) return null;
    if (start < 0 || end < start) return null;

    const compare = this.cfg.chikouCompare;
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let j = start; j <= end; j++) {
      if (compare === "close") {
        const c = this.prices[j];
        if (Number.isFinite(c)) {
          highestHigh = Math.max(highestHigh, c);
          lowestLow = Math.min(lowestLow, c);
        }
      } else {
        const h = this.highs[j];
        const l = this.lows[j];
        if (Number.isFinite(h)) highestHigh = Math.max(highestHigh, h);
        if (Number.isFinite(l)) lowestLow = Math.min(lowestLow, l);
      }
    }
    if (!Number.isFinite(highestHigh) || !Number.isFinite(lowestLow)) return null;

    return { highestHigh, lowestLow, startIdx: start, endIdx: end, lookback, compare, anchorIdx: anchor };
  }

  _isChikouAboveCloudClear(side, refPrice) {
    if (!this.cfg.requireChikouAboveCloud) return true;
    if (!Number.isFinite(refPrice)) return false;
    const cloud = this._getChikouCloudLevelsAtAnchor();
    if (!cloud) return false;

    const buf = this._chikouBreakoutBuffer(refPrice);
    const s = String(side || "").toLowerCase();
    if (s === "long") return refPrice > cloud.cloudTop + buf;
    if (s === "short") return refPrice < cloud.cloudBottom - buf;
    return false;
  }

  _isChikouBreakoutClear(side, refPrice) {
    if (!this.cfg.requireChikouBreakout) return true;
    const levels = this._getChikouBreakoutLevels();
    if (!levels || !Number.isFinite(refPrice)) return false;
    const buf = this._chikouBreakoutBuffer(refPrice);
    const s = String(side || "").toLowerCase();
    if (s === "long") return refPrice > levels.highestHigh + buf;
    if (s === "short") return refPrice < levels.lowestLow - buf;
    return false;
  }

  // ============================================================
  // Updates
  // ============================================================

  update({ price, close, high, low, volume = 0, ts = Date.now() }) {
    const closePrice = close ?? price;
    if (!Number.isFinite(closePrice) || closePrice <= 0) return;

    this._barCount += 1;
    this._currentBarIndex += 1;
    this._nowTs = ts;

    const highValue = Number.isFinite(high) ? high : closePrice;
    const lowValue = Number.isFinite(low) ? low : closePrice;
    const volumeValue = Number.isFinite(volume) ? volume : 0;

    this.prices.push(closePrice);
    this.highs.push(highValue);
    this.lows.push(lowValue);
    this.volumes.push(volumeValue);
    this.timestamps.push(ts);
    this._lastBarClose = closePrice;
    this._lastBarVolume = volumeValue;

    this.adx = this._updateAdxState(
      this._adxState,
      highValue,
      lowValue,
      closePrice,
      this.cfg.adxPeriod
    );
    this.atr = this._updateAtrState(
      this._atrState,
      highValue,
      lowValue,
      closePrice,
      this.cfg.atrPeriod
    );

    this._updateIchimoku();
    this._updateVwap(closePrice, volumeValue, ts);
    const chikouIdx = this.prices.length - 1 - this.cfg.shift;
    this.chikouLag = chikouIdx >= 0 ? this.prices[chikouIdx] : null;
    this._updateVolumeAnalysis(volumeValue);

    // Keep oscillator values updated for visibility/diagnostics, regardless of which one is used for exits.
    // Exit logic still respects `cfg.exitOscillator` inside `shouldClose()`.
    this._prevRsi = this.rsi;
    this._prevMacdHist = this._macdHist;
    this._updateRsi(closePrice);
    this._updateMacd(closePrice);

    if (this.cfg.enableHtfRegime) {
      this._updateHtf({
        close: closePrice,
        high: highValue,
        low: lowValue,
        volume: volumeValue,
      });
    }

    // Keep all bar-aligned arrays in sync. If we only trim prices/highs/lows without trimming
    // the Ichimoku arrays, cloud/chikou anchoring becomes incorrect after enough bars (~2000).
    const MAX_BARS = 2000;
    while (this.prices.length > MAX_BARS) {
      this.prices.shift();
      this.highs.shift();
      this.lows.shift();
      this.volumes.shift();
      this.timestamps.shift();
      this._tenkan.shift();
      this._kijun.shift();
      this._senkouA.shift();
      this._senkouB.shift();
      const pv = this._vwapPVs.shift();
      const v = this._vwapVs.shift();
      this._vwapTs.shift();
      if (Number.isFinite(pv)) this._vwapPvSum -= pv;
      if (Number.isFinite(v)) this._vwapVSum -= v;
    }

    this._ready = this._barCount >= this.cfg.minBars;
  }

  updateTick({ price, ts = Date.now() }) {
    if (!Number.isFinite(price) || price <= 0) return;
    this._tickCount += 1;
    this._nowTs = ts;
  }

  recalculateLastBar({ close, high, low, volume }) {
    this._lastIntraBar = {
      close,
      high,
      low,
      volume,
      ts: this._now(),
    };
  }

  // ============================================================
  // Signal generation
  // ============================================================

  getSignal(price, positions = []) {
    const inPos = positions.some((p) => p.side && !p.exitTime);
    const refPrice = Number.isFinite(this._lastBarClose) ? this._lastBarClose : price;
    const mkHold = (reason, extra = {}) => ({ action: "hold", reason, confidence: 0, ...extra });

    if (!Number.isFinite(refPrice) || refPrice <= 0) {
      return mkHold("invalid_price", {
        entryDebug: { kind: "ichimoku", note: "invalid_price", refPrice },
      });
    }

    // Enforce bar-based entries: evaluate once per completed bar
    if (this._lastSignalBarIndex === this._currentBarIndex) {
      const lastEval =
        this._lastEvaluatedSignal && this._lastEvaluatedSignal.barIndex === this._currentBarIndex
          ? this._lastEvaluatedSignal
          : null;
      return mkHold("already_evaluated_bar", {
        entryDebug: {
          kind: "ichimoku",
          note: "evaluate_once_per_bar",
          barIndex: this._currentBarIndex,
          lastEval,
        },
      });
    }
    this._lastSignalBarIndex = this._currentBarIndex;

    const record = (signal) => {
      this._lastEvaluatedSignal = {
        barIndex: this._currentBarIndex,
        action: signal?.action || null,
        side: signal?.side || null,
        reason: signal?.reason || null,
        disabledHourUtc: signal?.disabledHourUtc ?? null,
        entryDebug: signal?.entryDebug || null,
      };
      return signal;
    };

    if (!this._ready) {
      return record(
        mkHold("warming_up", {
        entryDebug: {
          kind: "ichimoku",
          note: "warming_up",
          barCount: this._barCount,
          minBars: this.cfg.minBars,
        },
        })
      );
    }

    if (inPos) {
      return record(
        mkHold("already_in_position", {
        entryDebug: { kind: "ichimoku", note: "already_in_position" },
        })
      );
    }

    // Time-of-day filter (UTC) - block entries during weak/erratic periods
    const nowTs = this._now();
    if (!this._isAllowedHourUtc(nowTs)) {
      const disabledHourUtc = new Date(nowTs).getUTCHours();
      return record(
        mkHold("trading_disabled_hour_utc", {
        disabledHourUtc,
        entryDebug: {
          kind: "ichimoku",
          note: "trading_disabled_hour_utc",
          disabledHourUtc,
        },
        })
      );
    }

    const cloudTop = this.cloudTop;
    const cloudBottom = this.cloudBottom;
    if (!this._ok(cloudTop, cloudBottom)) {
      return record(
        mkHold("cloud_not_ready", {
        entryDebug: { kind: "ichimoku", note: "cloud_not_ready" },
        })
      );
    }

    const buffer = this._breakBuffer(refPrice);
    const prevClose = this.prices.length > 1 ? this.prices[this.prices.length - 2] : null;
    const prevIdx = this._tenkan.length - 2;
    const prevCloudIdx = prevIdx - this.cfg.shift;
    const prevCloudA = prevCloudIdx >= 0 ? this._senkouA[prevCloudIdx] : null;
    const prevCloudB = prevCloudIdx >= 0 ? this._senkouB[prevCloudIdx] : null;
    const prevCloudTop = this._ok(prevCloudA, prevCloudB) ? Math.max(prevCloudA, prevCloudB) : null;
    const prevCloudBottom = this._ok(prevCloudA, prevCloudB)
      ? Math.min(prevCloudA, prevCloudB)
      : null;

    const longBreak = refPrice > cloudTop + buffer;
    const shortBreak = refPrice < cloudBottom - buffer;
    const prevLongBreak =
      Number.isFinite(prevClose) && Number.isFinite(prevCloudTop)
        ? prevClose > prevCloudTop + buffer
        : false;
    const prevShortBreak =
      Number.isFinite(prevClose) && Number.isFinite(prevCloudBottom)
        ? prevClose < prevCloudBottom - buffer
        : false;

    const longBreakEdge = longBreak && !prevLongBreak;
    const shortBreakEdge = shortBreak && !prevShortBreak;

    const alignLong =
      !this.cfg.requireTenkanKijunAlign ||
      (this._ok(this.tenkan, this.kijun) && this.tenkan >= this.kijun && refPrice >= this.kijun);
    const alignShort =
      !this.cfg.requireTenkanKijunAlign ||
      (this._ok(this.tenkan, this.kijun) && this.tenkan <= this.kijun && refPrice <= this.kijun);

    const adxOk =
      !Number.isFinite(this.cfg.adxMinTrend) || !Number.isFinite(this.adx)
        ? false
        : this.adx >= this.cfg.adxMinTrend;

    const distOk =
      !Number.isFinite(this.atr) || this.cfg.maxEntryDistAtr <= 0 || !Number.isFinite(this.kijun)
        ? true
        : Math.abs(refPrice - this.kijun) <= this.atr * this.cfg.maxEntryDistAtr;

    const volumeOk = !this.cfg.requireVolumeSpike || this.volumeSpike === true;

    const chikouBreakoutOkLong = this._isChikouBreakoutClear("long", refPrice);
    const chikouBreakoutOkShort = this._isChikouBreakoutClear("short", refPrice);
    const chikouAboveCloudOkLong = this._isChikouAboveCloudClear("long", refPrice);
    const chikouAboveCloudOkShort = this._isChikouAboveCloudClear("short", refPrice);
    const vwapOkLong = this._isVwapConfirmOk("long", refPrice);
    const vwapOkShort = this._isVwapConfirmOk("short", refPrice);

    let htfLongOk = true;
    let htfShortOk = true;
    if (this.cfg.enableHtfRegime) {
      if (!this._htfBias) {
        htfLongOk = false;
        htfShortOk = false;
      } else if (this._htfBias === "choppy") {
        htfLongOk = false;
        htfShortOk = false;
      } else {
        htfLongOk = this._htfBias !== "bearish";
        htfShortOk = this._htfBias !== "bullish";
      }
    }

    const longOK =
      this.cfg.allowLongs &&
      longBreakEdge &&
      alignLong &&
      chikouBreakoutOkLong &&
      chikouAboveCloudOkLong &&
      vwapOkLong &&
      adxOk &&
      distOk &&
      volumeOk &&
      htfLongOk;
    const shortOK =
      this.cfg.allowShorts &&
      shortBreakEdge &&
      alignShort &&
      chikouBreakoutOkShort &&
      chikouAboveCloudOkShort &&
      vwapOkShort &&
      adxOk &&
      distOk &&
      volumeOk &&
      htfShortOk;

    const atr = Number.isFinite(this.atr) && this.atr > 0 ? this.atr : null;
    const kijun = Number.isFinite(this.kijun) ? this.kijun : null;
    const kijunDistAtr =
      atr && kijun !== null ? Math.abs(refPrice - kijun) / atr : null;
    const volumeRatio =
      Number.isFinite(this._lastBarVolume) &&
      Number.isFinite(this.volumeAvg) &&
      this.volumeAvg > 0
        ? this._lastBarVolume / this.volumeAvg
        : null;

    const entryDebug = {
      kind: "ichimoku",
      barIndex: this._currentBarIndex,
      refPrice,
      buffer,
      cloudTop,
      cloudBottom,
      long: {
        allow: this.cfg.allowLongs === true,
        breakoutNow: longBreak === true,
        prevBreakout: prevLongBreak === true,
        edge: longBreakEdge === true,
        align: alignLong === true,
        chikouBreakoutEnabled: this.cfg.requireChikouBreakout === true,
        chikouBreakoutOk: chikouBreakoutOkLong === true,
        chikouAboveCloudEnabled: this.cfg.requireChikouAboveCloud === true,
        chikouAboveCloudOk: chikouAboveCloudOkLong === true,
        vwapConfirmEnabled: this.cfg.requireVwapConfirm === true,
        vwapConfirmOk: vwapOkLong === true,
        adxEnabled: Number.isFinite(this.cfg.adxMinTrend),
        adxOk: adxOk === true,
        adx: Number.isFinite(this.adx) ? this.adx : null,
        adxMin: Number.isFinite(this.cfg.adxMinTrend) ? this.cfg.adxMinTrend : null,
        distEnabled: Number.isFinite(this.cfg.maxEntryDistAtr) && this.cfg.maxEntryDistAtr > 0,
        distOk: distOk === true,
        kijunDistAtr,
        maxEntryDistAtr: Number.isFinite(this.cfg.maxEntryDistAtr) ? this.cfg.maxEntryDistAtr : null,
        requireVolumeSpike: this.cfg.requireVolumeSpike === true,
        volumeOk: volumeOk === true,
        volumeSpike: this.volumeSpike === true,
        volumeRatio,
        volumeSpikeThreshold: this.cfg.volumeSpikeThreshold ?? null,
        htfEnabled: this.cfg.enableHtfRegime === true,
        htfOk: htfLongOk === true,
        htfBias: this._htfBias || null,
      },
      short: {
        allow: this.cfg.allowShorts === true,
        breakoutNow: shortBreak === true,
        prevBreakout: prevShortBreak === true,
        edge: shortBreakEdge === true,
        align: alignShort === true,
        chikouBreakoutEnabled: this.cfg.requireChikouBreakout === true,
        chikouBreakoutOk: chikouBreakoutOkShort === true,
        chikouAboveCloudEnabled: this.cfg.requireChikouAboveCloud === true,
        chikouAboveCloudOk: chikouAboveCloudOkShort === true,
        vwapConfirmEnabled: this.cfg.requireVwapConfirm === true,
        vwapConfirmOk: vwapOkShort === true,
        adxEnabled: Number.isFinite(this.cfg.adxMinTrend),
        adxOk: adxOk === true,
        adx: Number.isFinite(this.adx) ? this.adx : null,
        adxMin: Number.isFinite(this.cfg.adxMinTrend) ? this.cfg.adxMinTrend : null,
        distEnabled: Number.isFinite(this.cfg.maxEntryDistAtr) && this.cfg.maxEntryDistAtr > 0,
        distOk: distOk === true,
        kijunDistAtr,
        maxEntryDistAtr: Number.isFinite(this.cfg.maxEntryDistAtr) ? this.cfg.maxEntryDistAtr : null,
        requireVolumeSpike: this.cfg.requireVolumeSpike === true,
        volumeOk: volumeOk === true,
        volumeSpike: this.volumeSpike === true,
        volumeRatio,
        volumeSpikeThreshold: this.cfg.volumeSpikeThreshold ?? null,
        htfEnabled: this.cfg.enableHtfRegime === true,
        htfOk: htfShortOk === true,
        htfBias: this._htfBias || null,
      },
    };

    if (longOK && shortOK) {
      return record(mkHold("both_sides", { entryDebug }));
    }

    const buildSignalIndicators = (side) => {
      const atr = Number.isFinite(this.atr) && this.atr > 0 ? this.atr : null;
      const kijun = Number.isFinite(this.kijun) ? this.kijun : null;
      const tk = Number.isFinite(this.tenkan) ? this.tenkan : null;
      const clTop = Number.isFinite(this.cloudTop) ? this.cloudTop : null;
      const clBot = Number.isFinite(this.cloudBottom) ? this.cloudBottom : null;
      const atrPct =
        atr && Number.isFinite(refPrice) && refPrice > 0 ? (atr / refPrice) * 100 : null;

      const cloudThickness = this._ok(clTop, clBot) ? Math.abs(clTop - clBot) : null;
      const cloudThicknessAtr = atr && cloudThickness !== null ? cloudThickness / atr : null;

      // Positive when beyond breakout threshold. 0 means just barely broke.
      const breakoutDist = (() => {
        if (!atr) return null;
        if (!Number.isFinite(buffer)) return null;
        if (side === "long" && clTop !== null) return refPrice - (clTop + buffer);
        if (side === "short" && clBot !== null) return clBot - buffer - refPrice;
        return null;
      })();
      const breakoutDistAtr = atr && breakoutDist !== null ? breakoutDist / atr : null;

      const kijunDistAtr = atr && kijun !== null ? Math.abs(refPrice - kijun) / atr : null;
      const chikouLevels = this._getChikouBreakoutLevels();
      const chikouBreakoutLevel =
        side === "long" ? chikouLevels?.highestHigh ?? null : chikouLevels?.lowestLow ?? null;
      const chikouBreakoutOk = this._isChikouBreakoutClear(side, refPrice);
      const chikouBreakoutLookback = chikouLevels?.lookback ?? null;
      const chikouAnchorIdx = chikouLevels?.anchorIdx ?? null;
      const chikouCompare = this.cfg.chikouCompare;
      const chikouBreakoutBuffer = this._chikouBreakoutBuffer(refPrice);
      const chikouAboveCloudEnabled = this.cfg.requireChikouAboveCloud === true;
      const chikouAboveCloudOk = this._isChikouAboveCloudClear(side, refPrice);
      const chikouCloudLevels = this._getChikouCloudLevelsAtAnchor();
      const chikouCloudLookback =
        Number.isFinite(this.cfg.chikouCloudLookback) && this.cfg.chikouCloudLookback > 0
          ? Math.floor(this.cfg.chikouCloudLookback)
          : 1;
      const vwap = Number.isFinite(this.vwap) ? this.vwap : null;
      const vwapOk = this._isVwapConfirmOk(side, refPrice);
      const vwapBandBps = Number.isFinite(this.cfg.vwapBandBps) ? this.cfg.vwapBandBps : 0;
      const vwapSessionMs = Number.isFinite(this.cfg.vwapSessionMs) ? this.cfg.vwapSessionMs : null;

      return {
        // Core bar-based state (for allocator / logging / backtest diagnostics)
        price: refPrice,
        adx: Number.isFinite(this.adx) ? this.adx : null,
        atr,
        atrPct,
        tenkan: tk,
        kijun,
        cloudTop: clTop,
        cloudBottom: clBot,
        cloudBullish: this.cloudBullish,
        chikouLag: Number.isFinite(this.chikouLag) ? this.chikouLag : null,
        chikouBreakoutEnabled: this.cfg.requireChikouBreakout === true,
        chikouBreakoutOk: chikouBreakoutOk === true,
        chikouBreakoutLevel,
        chikouBreakoutLookback,
        chikouAnchorIdx,
        chikouCompare,
        chikouBreakoutBuffer,
        chikouAboveCloudEnabled,
        chikouAboveCloudOk: chikouAboveCloudOk === true,
        chikouCloudLookback,
        chikouCloudTopAtAnchor: chikouCloudLevels?.cloudTop ?? null,
        chikouCloudBottomAtAnchor: chikouCloudLevels?.cloudBottom ?? null,
        vwap,
        vwapConfirmEnabled: this.cfg.requireVwapConfirm === true,
        vwapConfirmOk: vwapOk === true,
        vwapBandBps,
        vwapRequireCross: this.cfg.vwapRequireCross === true,
        vwapSessionMs,
        buffer,
        cloudThicknessAtr,
        breakoutDistAtr,
        kijunDistAtr,
        volume: Number.isFinite(this._lastBarVolume) ? this._lastBarVolume : null,
        volumeSpike: this.volumeSpike === true,
        volumeAvg: Number.isFinite(this.volumeAvg) ? this.volumeAvg : null,
        volumeRatio:
          Number.isFinite(this._lastBarVolume) &&
          Number.isFinite(this.volumeAvg) &&
          this.volumeAvg > 0
            ? this._lastBarVolume / this.volumeAvg
            : null,
        volumeSpikeThreshold: this.cfg.volumeSpikeThreshold,
        htf: {
          bias: this._htfBias || null,
          adx: Number.isFinite(this._htfAdx) ? this._htfAdx : null,
          chop: Number.isFinite(this._htfChop) ? this._htfChop : null,
        },
      };
    };

    if (longOK) {
      const confidence = Math.min(1, Math.max(0.4, (this.adx || 0) / 50));
      return record({
        action: "open",
        side: "long",
        confidence,
        reason: "ichimoku_breakout_long",
        entryDebug,
        indicators: buildSignalIndicators("long"),
      });
    }
    if (shortOK) {
      const confidence = Math.min(1, Math.max(0.4, (this.adx || 0) / 50));
      return record({
        action: "open",
        side: "short",
        confidence,
        reason: "ichimoku_breakout_short",
        entryDebug,
        indicators: buildSignalIndicators("short"),
      });
    }

    return record(mkHold("no_signal", { entryDebug }));
  }

  shouldClose(position, price) {
    if (!position || !Number.isFinite(price) || price <= 0) return false;
    if (!this._ready) return false;

    const side = position.side?.toLowerCase();
    const entry = Number(position.entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) return false;

    // ------------------------------------------------------------
    // Tick-based hard stops / trailing
    // ------------------------------------------------------------

    const hardStopPercentOverride = Number(position.stopLossPercentOverride);
    const hardStopPct =
      Number.isFinite(hardStopPercentOverride) && hardStopPercentOverride > 0
        ? hardStopPercentOverride
        : this.cfg.hardStopPercent;
    if (this.cfg.hardStopEnabled && Number.isFinite(hardStopPct) && hardStopPct > 0) {
      const lev = Number(position.leverage);
      const leverage = Number.isFinite(lev) && lev > 0 ? lev : 1;
      // Leverage-adjusted: hardStopPercent is collateral PnL%, convert to price %.
      const pricePct = hardStopPct / 100 / leverage;
      if (side === "long" && price <= entry * (1 - pricePct)) {
        return { close: true, reason: "ichimoku_hard_stop_percent" };
      }
      if (side === "short" && price >= entry * (1 + pricePct)) {
        return { close: true, reason: "ichimoku_hard_stop_percent" };
      }
    }

    const atrMultOverride = Number(position.hardStopAtrMultOverride);
    const hardStopAtrMult =
      Number.isFinite(atrMultOverride) && atrMultOverride > 0
        ? atrMultOverride
        : this.cfg.hardStopAtrMult;
    if (Number.isFinite(hardStopAtrMult) && hardStopAtrMult > 0) {
      const atrAtEntry = Number(position.atrAtEntry);
      const atr = Number.isFinite(atrAtEntry) && atrAtEntry > 0 ? atrAtEntry : this.atr;
      if (Number.isFinite(atr) && atr > 0) {
        const adverse = side === "short" ? price - entry : entry - price;
        if (adverse >= atr * hardStopAtrMult) {
          return { close: true, reason: "ichimoku_hard_stop_atr" };
        }
      }
    }

    if (this.cfg.enableAtrTrail && Number.isFinite(this.atr) && this.atr > 0) {
      const trailDistance = this.atr * this.cfg.trailAtrMult;
      if (side === "long" && Number.isFinite(position.highWaterMark)) {
        if (price <= position.highWaterMark - trailDistance) {
          return { close: true, reason: "ichimoku_atr_trail" };
        }
      }
      if (side === "short" && Number.isFinite(position.lowWaterMark)) {
        if (price >= position.lowWaterMark + trailDistance) {
          return { close: true, reason: "ichimoku_atr_trail" };
        }
      }
    }

    // ------------------------------------------------------------
    // Bar-based strategy exits (evaluate once per bar)
    // ------------------------------------------------------------

    if (this._lastExitEvalBarIndex === this._currentBarIndex) {
      return false;
    }
    this._lastExitEvalBarIndex = this._currentBarIndex;

    const refPrice = Number.isFinite(this._lastBarClose) ? this._lastBarClose : price;
    const openBarIndex = position.openBarIndex ?? this._currentBarIndex;
    const barsHeld = this._currentBarIndex - openBarIndex;

    if (this.cfg.timeStopBars > 0 && barsHeld >= this.cfg.timeStopBars) {
      return { close: true, reason: "ichimoku_time_stop", barsHeld };
    }

    if (
      this.cfg.exitOscillator === "rsi" &&
      Number.isFinite(this.rsi) &&
      Number.isFinite(this._prevRsi)
    ) {
      if (
        side === "long" &&
        this._prevRsi >= this.cfg.exitRsiLong &&
        this.rsi < this.cfg.exitRsiLong
      ) {
        return { close: true, reason: "ichimoku_rsi_exit", rsi: this.rsi };
      }
      if (
        side === "short" &&
        this._prevRsi <= this.cfg.exitRsiShort &&
        this.rsi > this.cfg.exitRsiShort
      ) {
        return { close: true, reason: "ichimoku_rsi_exit", rsi: this.rsi };
      }
    }

    if (
      this.cfg.exitOscillator === "macd" &&
      Number.isFinite(this._macdHist) &&
      Number.isFinite(this._prevMacdHist)
    ) {
      if (side === "long" && this._prevMacdHist >= 0 && this._macdHist < 0) {
        return { close: true, reason: "ichimoku_macd_exit", macd: this._macdHist };
      }
      if (side === "short" && this._prevMacdHist <= 0 && this._macdHist > 0) {
        return { close: true, reason: "ichimoku_macd_exit", macd: this._macdHist };
      }
    }

    const tenkan = this.tenkan;
    const kijun = this.kijun;
    const prevTenkan = this._tenkan.length > 1 ? this._tenkan[this._tenkan.length - 2] : null;
    const prevKijun = this._kijun.length > 1 ? this._kijun[this._kijun.length - 2] : null;

    if (this.cfg.exitOnTenkanKijunCross && this._ok(prevTenkan, prevKijun, tenkan, kijun)) {
      if (side === "long" && prevTenkan >= prevKijun && tenkan < kijun) {
        return { close: true, reason: "ichimoku_tenkan_kijun_cross" };
      }
      if (side === "short" && prevTenkan <= prevKijun && tenkan > kijun) {
        return { close: true, reason: "ichimoku_tenkan_kijun_cross" };
      }
    }

    if (this.cfg.exitOnKijunBreak && this._ok(kijun, refPrice)) {
      const buffer = this._kijunBreakBuffer(refPrice);
      if (side === "long" && refPrice < kijun - buffer) {
        return { close: true, reason: "ichimoku_kijun_break" };
      }
      if (side === "short" && refPrice > kijun + buffer) {
        return { close: true, reason: "ichimoku_kijun_break" };
      }
    }

    if (this.cfg.exitOnCloudReentry && this._ok(this.cloudTop, this.cloudBottom)) {
      if (side === "long" && refPrice < this.cloudTop) {
        return { close: true, reason: "ichimoku_cloud_reentry" };
      }
      if (side === "short" && refPrice > this.cloudBottom) {
        return { close: true, reason: "ichimoku_cloud_reentry" };
      }
    }

    if (this.cfg.exitOnCloudFlip && this.cloudBullish !== null) {
      if (side === "long" && this.cloudBullish === false) {
        return { close: true, reason: "ichimoku_cloud_flip" };
      }
      if (side === "short" && this.cloudBullish === true) {
        return { close: true, reason: "ichimoku_cloud_flip" };
      }
    }

    return false;
  }

  recordTrade({ pnlUsd } = {}) {
    const pnl = Number.isFinite(pnlUsd) ? pnlUsd : 0;
    this.totalTrades += 1;
    this.totalPnL += pnl;

    if (pnl >= 0) {
      this.winningTrades += 1;
      this.consecutiveLosses = 0;
    } else {
      this.losingTrades += 1;
      this.consecutiveLosses += 1;
      this.maxConsecutiveLosses = Math.max(this.maxConsecutiveLosses, this.consecutiveLosses);
    }
  }

  getStats() {
    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0;
    return {
      market: this.cfg.market,
      strategyType: "ichimoku-cloud",
      barCount: this._barCount,
      tickCount: this._tickCount,
      tenkan: this.tenkan,
      kijun: this.kijun,
      senkouA: this.senkouA,
      senkouB: this.senkouB,
      cloudBullish: this.cloudBullish,
      adx: this.adx,
      atr: this.atr,
      exitOscillator: this.cfg.exitOscillator,
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      winRate,
      totalPnL: this.totalPnL,
      consecutiveLosses: this.consecutiveLosses,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
    };
  }

  reset() {
    this.prices = [];
    this.highs = [];
    this.lows = [];
    this.volumes = [];
    this.timestamps = [];

    this._tenkan = [];
    this._kijun = [];
    this._senkouA = [];
    this._senkouB = [];

    this.tenkan = null;
    this.kijun = null;
    this.senkouA = null;
    this.senkouB = null;
    this.cloudTop = null;
    this.cloudBottom = null;
    this.cloudBullish = null;
    this.chikouLag = null;

    this.adx = null;
    this.atr = null;
    this.rsi = null;
    this._macdHist = null;

    this.volumeAvg = null;
    this.volumeSpike = false;

    this.vwap = null;
    this._prevVwap = null;
    this._vwapPvSum = 0;
    this._vwapVSum = 0;
    this._vwapPVs = [];
    this._vwapVs = [];
    this._vwapTs = [];

    this._adxState = this._createAdxState();
    this._atrState = this._createAtrState();
    this._rsiAvgGain = null;
    this._rsiAvgLoss = null;
    this._prevRsi = null;

    this._macdEmaFast = null;
    this._macdEmaSlow = null;
    this._macdSignal = null;
    this._prevMacdHist = null;

    this._htfBuffer = null;
    this._htfHighs = [];
    this._htfLows = [];
    this._htfCloses = [];
    this._htfTenkan = [];
    this._htfKijun = [];
    this._htfSenkouA = [];
    this._htfSenkouB = [];
    this._htfAdxState = this._createAdxState();
    this._htfAtrState = this._createAtrState();
    this._htfAdx = null;
    this._htfChop = null;
    this._htfBias = null;

    this._barCount = 0;
    this._tickCount = 0;
    this._currentBarIndex = 0;
    this._lastSignalBarIndex = null;
    this._lastExitEvalBarIndex = null;
    this._ready = false;
    this._nowTs = null;
    this._lastBarClose = null;

    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.totalPnL = 0;
    this.consecutiveLosses = 0;
    this.maxConsecutiveLosses = 0;
  }
}

module.exports = IchimokuCloudBreakoutStrategy;
