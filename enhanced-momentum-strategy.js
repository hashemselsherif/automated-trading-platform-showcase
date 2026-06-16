// enhanced-momentum-strategy.js
//
// ENHANCED Momentum Breakout Strategy
// Incorporates techniques from top traders:
//   - Turtle Trading (Donchian channels, ATR stops)
//   - Wilder's ADX (trend strength filtering)
//   - Volume Profile (institutional levels)
//   - Dynamic position sizing (confidence-based)
//
// Original: EMA + VWAP + RSI confluence
// Enhanced: + ADX + Donchian + ATR + Volume Analysis
//
// Public methods:
//   - update({ price, close, volume=0, high, low, ts=Date.now() })
//   - getSignal(price, positions)  -> { action: 'open'|'close'|'hold', side?, confidence, reason }
//   - shouldOpenLong(price)        -> boolean
//   - shouldOpenShort(price)       -> boolean
//   - shouldClose(position, price) -> boolean
//   - reset()
//   - getRecommendedPositionSize(price, side) -> number (0-1, percentage of capital)
//
// Config overrides (all optional) via config.strategy:
//   {
//     // Original params
//     emaFast: 21,
//     emaSlow: 55,
//     rsiPeriod: 14,
//     rsiLong: 55,
//     rsiShort: 45,
//     vwapSessionMs: 4 * 60 * 60 * 1000,
//     minBars: 60,
//     zFilter: 2.0,
//     slopeMinFast: 0.0,
//     bandPct: 0.0015,
//     cooldownMs: 60_000,
//     flipCooldownMs: 180_000,
//     maxHoldMs: 6 * 60 * 60 * 1000,
//     closeOnCross: true,
//
//     // NEW: ADX parameters
//     adxPeriod: 14,
//     adxMinTrend: 20,           // Minimum ADX for trend strength (require > 20)
//     adxExitWeak: 20,           // Exit if ADX drops below this
//
//     // NEW: Donchian channel parameters
//     donchianPeriod: 20,        // 20-bar Donchian channel for breakouts
//     donchianConfirm: 1,        // Require price to break by N bars
//
//     // NEW: ATR parameters
//     atrPeriod: 14,
//     atrStopMultiplier: 3.0,   // Stop loss: entry ± (ATR × multiplier)
//     atrTakeProfitMultiplier: 3.0,  // Take profit: entry ± (ATR × multiplier)
//
//     // NEW: Volume analysis
//     volumeLookback: 20,        // Bars to calculate volume average
//     volumeSpikeThreshold: 1.5, // Volume spike = avg × threshold
//     volumeProfilePeriod: 100,  // Bars for volume profile
//     requireVolumeSpike: false, // Enforce spike confirmation when true
//
//     // NEW: Dynamic position sizing
//     basePositionSize: 0.10,    // 10% base size
//     minPositionSize: 0.05,     // 5% minimum
//     maxPositionSize: 0.15,     // 15% maximum
//     volatilityAdjustment: true, // Adjust size based on ATR
//
//     verbose: false
//   }

class EnhancedMomentumBreakoutStrategy {
  constructor(config = {}) {
    const s = (config.strategy || {});
    this.cfg = {
      // Original parameters
      emaFast: s.emaFast ?? 21,
      emaSlow: s.emaSlow ?? 55,
      rsiPeriod: s.rsiPeriod ?? 12, // 5m: 9-12 for faster turns (was 14)
      rsiLong: s.rsiLong ?? 55, // Read from config.strategy.rsiLong (env: RSI_LONG)
      rsiShort: s.rsiShort ?? 45, // Read from config.strategy.rsiShort (env: RSI_SHORT)
      vwapSessionMs: s.vwapSessionMs ?? 4 * 60 * 60 * 1000,
      minBars: s.minBars,
      zFilter: s.zFilter ?? 8.0, // 5m: 6-8 to filter noise (was 2.0)
      slopeMinFast: s.slopeMinFast ?? 0.0,
      bandPct: s.bandPct ?? 0.0015, // 5m: 0.0010-0.0018 (already optimal)
      cooldownMs: s.cooldownMs ?? 30_000, // 5m: 20-45s (was 60s)
      flipCooldownMs: s.flipCooldownMs ?? 90_000, // 5m: 60-120s (was 180s)
      flipCooldownBars: s.flipCooldownBars ?? 8, // Bar-based flip cooldown (not just time)
      maxHoldMs: s.maxHoldMs ?? 6 * 60 * 60 * 1000,
      closeOnCross: s.closeOnCross ?? true,
      
      // NEW: ADX parameters - optimized for 5m
      adxPeriod: s.adxPeriod ?? 12, // 5m: 10-14 (was 14)
      adxMinTrend: s.adxMinTrend ?? 15, // Read from config.strategy.adxMinTrend (env: ADX_MIN_TREND)
      adxExitWeak: s.adxExitWeak ?? 15, // Read from config.strategy.adxExitWeak (env: ADX_EXIT_WEAK)
      
      // NEW: Donchian parameters - optimized for 5m
      enableDonchianGate: s.enableDonchianGate ?? true, // Require Donchian breakout for entries (default: true)
      donchianPeriod: s.donchianPeriod ?? 15, // Optimized from heatmap analysis: best performance at 15 (was 30)
      donchianConfirm: s.donchianConfirm ?? 1,
      minDist: s.minDist ?? 0.0012, // Minimum distance from MA (0.12% = 12 bps) to avoid micro-pops
      maxEntryDistAtr: s.maxEntryDistAtr ?? null, // Maximum entry distance from Donchian break in ATR (null = disabled)
      requireRetest: s.requireRetest ?? false, // Require retest-and-hold after breakout
      retestBars: s.retestBars ?? 5, // Number of bars to check for retest
      
      // NEW: MA/SMA parameters - optimized for 5m
      maPeriod: s.maPeriod ?? 70, // 5m: 60-80 for smoother signals (was 50)
      crossLookback: s.crossLookback ?? 3, // 5m: 3-5, keep recent cross detection
      slopeMinNorm: s.slopeMinNorm ?? 0.0, // Normalized slope minimum (per-bar % change)
      adxStrong: s.adxStrong ?? 25, // Strong trend threshold for slope override
      requireAdxSlopeUp: s.requireAdxSlopeUp ?? false, // Require ADX slope >= 0 for entries (null = disabled)
      requireMaSlopeLong: s.requireMaSlopeLong ?? true, // Require MA slope >= threshold for longs
      requireMaSlopeShort: s.requireMaSlopeShort ?? true, // Require MA slope <= threshold for shorts
      maSlopeUpMin: s.maSlopeUpMin ?? 0, // Minimum MA slope for longs (% per bar, e.g., 0.01 = 0.01%/bar)
      maSlopeDownMax: s.maSlopeDownMax ?? 0, // Maximum MA slope for shorts (% per bar, e.g., -0.01 = -0.01%/bar)
      maSlopeLookback: s.maSlopeLookback ?? 10, // Lookback period for slope calculation (bars)
      
      // NEW: ATR parameters - optimized for 5m
      atrPeriod: s.atrPeriod ?? 21, // 5m: 21 to reduce noise (was 14)
      atrStopMultiplier: s.atrStopMultiplier ?? 2.0, // Optimized from heatmap analysis: best performance at 2.0 (was 3.0)
      atrTakeProfitMultiplier: s.atrTakeProfitMultiplier ?? 3.0,
      
      // NEW: Partial take and trailing stop parameters
      partialAtR: s.partialAtR ?? 1.0, // Take 50% at +1.0R
      trailATR: s.trailATR ?? 1.5, // Trail at 1.5×ATR
      timeStopBars: s.timeStopBars ?? 36, // Time stop after 36 bars (~3h on 5m)
      minRToHold: s.minRToHold ?? 0.5, // Minimum R to hold past time stop
      enablePartialTake: s.enablePartialTake ?? true,
      enableTrailingStop: s.enableTrailingStop ?? true,
      enableTimeStop: s.enableTimeStop ?? true,
      
      // NEW: Volume parameters
      volumeLookback: s.volumeLookback ?? 20,
      volumeSpikeThreshold: s.volumeSpikeThreshold ?? 1.5,
      volumeProfilePeriod: s.volumeProfilePeriod ?? 100,
      requireVolumeSpike: s.requireVolumeSpike ?? false,
      
      // NEW: HTF (Higher Timeframe) trend filter
      htfInterval: s.htfInterval ?? '1h', // Higher timeframe (1h, 4h, etc.)
      htfMaPeriod: s.htfMaPeriod ?? 72, // MA period on HTF (72 = ~3 days on 1h)
      enableHTFTrend: s.enableHTFTrend ?? true, // Enable HTF trend filter
      
      // NEW: Side-specific gating (kill the losing side)
      longStrictHTF: s.longStrictHTF ?? false, // Force LONG: htfTrendOK + ADX≥20 required
      shortStrictHTF: s.shortStrictHTF ?? false, // Force SHORT: htfTrendOK + ADX≥20 required
      strictAdxMin: s.strictAdxMin ?? 20, // ADX minimum for strict side (default 20)
      
      // NEW: Volatility filter (min ATR/price to avoid chop)
      vMin: s.vMin ?? 0.0035, // Minimum volatility (0.35% of price = 35 bps)
      vMinQuiet: s.vMinQuiet ?? 0.0040, // Higher volatility threshold during quiet sessions
      vMinActive: s.vMinActive ?? 0.0035, // Lower volatility threshold during active sessions
      enableVolatilityFilter: s.enableVolatilityFilter ?? true, // Enable volatility filter
      enableSessionAwareness: s.enableSessionAwareness ?? true, // Enable session-based volatility filtering
      enableGreenDayVeto: s.enableGreenDayVeto ?? false, // Enable green day veto for shorts (default: false)
      
      // NEW: Time gate (UTC trading hours)
      enableTimeGate: s.enableTimeGate ?? false, // Enable time gate (default: disabled)
      timeGateAdxThreshold: s.timeGateAdxThreshold ?? 25, // ADX threshold for UTC 20:00-23:00 window
      
      // NEW: Position sizing
      basePositionSize: s.basePositionSize ?? 0.10,
      minPositionSize: s.minPositionSize ?? 0.05,
      maxPositionSize: s.maxPositionSize ?? 0.15,
      volatilityAdjustment: s.volatilityAdjustment ?? true,
      
      // NEW: Pyramiding winners
      pyramidEnable: s.pyramidEnable ?? false, // Enable pyramiding
      pyramidTriggerAtr: s.pyramidTriggerAtr ?? 0.7, // Trigger at +0.7×ATR profit
      pyramidAddPct: s.pyramidAddPct ?? 50, // Add +50% of initial size
      pyramidTrailATR: s.pyramidTrailATR ?? 1.8, // Trail at 1.8×ATR for add
      
      verbose: s.verbose ?? false,
    };

    // Calculate minBars based on warm-up requirements
    // For 5m: ADX(12) + SMA(70) + Donchian(30) needs sufficient warm-up
    if (this.cfg.minBars == null || this.cfg.minBars === undefined) {
      const need = Math.max(
        100,
        2 * (this.cfg.adxPeriod ?? 12),
        (this.cfg.donchianPeriod ?? 30) + 5,
        this.cfg.maPeriod ?? 70
      );
      this.cfg.minBars = need;
    }

    // Bar counter for warm-up
    this._barCount = 0;
    this._ready = false; // Will be set in update() based on warm-up requirement
    
    // Cached MA slope (calculated at bar completion, used during intra-bar updates)
    this._cachedMaSlope = 0;

    // Ring buffers
    this.prices = [];
    this.volumes = [];
    this.times = [];
    this.highs = [];  // Track highs for Donchian
    this.lows = [];   // Track lows for Donchian
    this._closes = []; // Track closes separately
    this._ma = []; // Track MA values for cross detection
    
    // HTF cache: resampled 1h candles
    this._htfCandles = []; // [{close, ts} for 1h bars]
    this._htfLastHour = null; // Last hour bucket processed
    this._htfMa = null; // Cached HTF SMA value

    // Original indicators
    this.emaF = null;
    this.emaS = null;
    this.rsi = null;
    this.vwap = null;

    // RSI state
    this._rsiAvgGain = null;
    this._rsiAvgLoss = null;

    // VWAP accumulators
    this._pvSum = 0;
    this._vSum = 0;

    // EMA slow history for stddev
    this._emaSHistory = [];
    this._emaSMax = 500;

    // NEW: ADX state
    this.adx = null;
    this._adxHistory = []; // Track ADX history for slope calculation
    this._dx = null;  // Directional index
    this._plusDI = null;
    this._minusDI = null;
    this._trSmoothing = null;
    this._plusDISmoothing = null;
    this._minusDISmoothing = null;
    this._prevHigh = null;
    this._prevLow = null;
    this._prevClose = null;

    // NEW: Donchian channels
    this.donchianHigh = null;
    this.donchianLow = null;
    this._donchianHighBreakCount = 0;
    this._donchianLowBreakCount = 0;

    // NEW: ATR
    this.atr = null;
    this._trueRanges = [];

    // NEW: Volume analysis
    this.volumeAvg = null;
    this.volumeSpike = false;
    this.volumeProfile = new Map(); // price -> volume

    // Cooldowns
    this._lastEntryTs = 0;
    this._lastFlipTs = 0;
    this._lastSide = null;

    // Anti-flip tracking: bar-based exit tracking
    this._currentBarIndex = 0; // Track current bar index for bar-based cooldowns (incremented on strategy.update())
    this._currentTickIndex = 0; // Track current tick index for debugging/logging (incremented on every getSignal call)
    this._lastExitBarLong = null; // Bar index when last long exit occurred
    this._lastExitBarShort = null; // Bar index when last short exit occurred
    this._lastExitPriceLong = null; // Price when last long exit occurred
    this._lastExitPriceShort = null; // Price when last short exit occurred
    
    // FIXED: Edge-triggered signals (only emit on rising edge)
    this._lastLongOK = false;
    this._lastShortOK = false;
    this._lastSignalTs = 0;
    this._lastOpenBarIndex = null;
    this._lastOpenSide = null;
    this._lastClosedBarIndex = null;
    this._lastClosedSide = null;
    this._lastShortBarIndex = null; // Track last short entry bar for throttle
    
    // FIXED: Session tracking for intraday volatility
    this._sessionDayKey = null; // UTC date key for session
    this._sessionOpen = null;
    this._sessionHigh = null;
    this._sessionLow = null;
    this._sessionClose = null;
    
    // FIXED: Breakout tracking for retest logic
    this._lastBreakUpBar = null; // Bar index of last upside Donchian break
    this._lastBreakDownBar = null; // Bar index of last downside Donchian break
    this._lastBreakUpPrice = null;
    this._lastBreakDownPrice = null;

    // synthetic clock
    this._nowTs = null;
  }

  reset() {
    this.prices = [];
    this.volumes = [];
    this.times = [];
    this.highs = [];
    this.lows = [];
    this._closes = [];
    this._ma = [];
    
    // HTF cache reset
    this._htfCandles = [];
    this._htfLastHour = null;
    this._htfMa = null;
    this.emaF = this.emaS = this.rsi = this.vwap = null;
    this._rsiAvgGain = this._rsiAvgLoss = null;
    this._pvSum = this._vSum = 0;
    this._emaSHistory = [];
    this.adx = this._dx = null;
    this._adxHistory = [];
    this._plusDI = this._minusDI = null;
    this._trSmoothing = this._plusDISmoothing = this._minusDISmoothing = null;
    this._prevHigh = this._prevLow = this._prevClose = null;
    this.donchianHigh = this.donchianLow = null;
    this._donchianHighBreakCount = 0;
    this._donchianLowBreakCount = 0;
    this.atr = null;
    this._trueRanges = [];
    this.volumeAvg = null;
    this.volumeSpike = false;
    this.volumeProfile.clear();
    this._lastEntryTs = 0;
    this._lastFlipTs = 0;
    this._lastSide = null;
    this._nowTs = null;
    this._barCount = 0;
    this._ready = false;
    this._cachedMaSlope = 0;
    
    // Anti-flip tracking reset
    this._currentBarIndex = 0;
    this._currentTickIndex = 0;
    this._lastExitBarLong = null;
    this._lastExitBarShort = null;
    this._lastExitPriceLong = null;
    this._lastExitPriceShort = null;
    
    // Edge-triggered signals reset
    this._lastLongOK = false;
    this._lastShortOK = false;
    this._lastSignalTs = 0;
    this._lastOpenBarIndex = null;
    this._lastOpenSide = null;
    this._lastClosedBarIndex = null;
    this._lastClosedSide = null;
    this._lastShortBarIndex = null;
    
    // Session tracking reset
    this._sessionDayKey = null;
    this._sessionOpen = null;
    this._sessionHigh = null;
    this._sessionLow = null;
    this._sessionClose = null;
    
    // Breakout tracking reset
    this._lastBreakUpBar = null;
    this._lastBreakDownBar = null;
    this._lastBreakUpPrice = null;
    this._lastBreakDownPrice = null;
  }

  /**
   * Update the last bar with new OHLCV data from rolling window
   * This allows indicators to update dynamically within a bar
   * WITHOUT incrementing bar count
   */
  recalculateLastBar({ close, high, low, volume }) {
    // IMPORTANT (production parity): do NOT mutate the historical series intra-bar.
    // We want RSI (and other bar-based indicators) to update only on CLOSED candles
    // (via update()). Mutating `this.prices[lastIdx]` with rolling-window closes will
    // corrupt the next bar-close calculations.
    //
    // Keep a lightweight snapshot for UI/debug if needed.
    this._lastIntraBar = {
      close,
      high,
      low,
      volume,
      ts: this._now(),
    };
    return;
  }

  // ---------------- Core computations ----------------

  // Helper to check if all values are finite
  _ok(...xs) {
    return xs.every(v => Number.isFinite(v));
  }

  update({ price, close, volume = 0, high, low, ts = Date.now() }) {
    // Prefer close over price for indicators that need close
    const closePrice = close ?? price;
    if (closePrice <= 0 || !isFinite(closePrice)) return;

    // Warm-up: increment bar count
    this._barCount++;
    this._currentBarIndex++; // Track bar index for bar-based cooldowns

    this._nowTs = ts;

    // Use provided high/low or fall back to close price
    const highValue = Number.isFinite(high) ? high : closePrice;
    const lowValue = Number.isFinite(low) ? low : closePrice;

    // Append to buffers - always push same number to keep arrays synchronized
    this.prices.push(closePrice);
    this.volumes.push(volume);
    this.times.push(ts);
    this.highs.push(highValue);
    this.lows.push(lowValue);
    this._closes.push(closePrice);
    
    if (this.prices.length > 5000) {
      this.prices.shift();
      this.volumes.shift();
      this.times.shift();
      if (this.highs.length > 5000) this.highs.shift();
      if (this.lows.length > 5000) this.lows.shift();
      if (this._closes.length > 5000) this._closes.shift();
      if (this._ma.length > 5000) this._ma.shift();
    }

    // Original indicators - use close for consistency
    this.emaF = this._emaNext(this.emaF, closePrice, this.cfg.emaFast);
    this.emaS = this._emaNext(this.emaS, closePrice, this.cfg.emaSlow);
    
    if (this.emaS != null) {
      this._emaSHistory.push(this.emaS);
      if (this._emaSHistory.length > this._emaSMax) this._emaSHistory.shift();
    }

    this.rsi = this._rsiNext(closePrice);
    
    // VWAP
    this._rollSession(ts);
    const vol = Math.max(0, volume);
    this._pvSum += closePrice * vol;
    this._vSum += vol;
    if (this._vSum > 0) this.vwap = this._pvSum / this._vSum;

    // NEW: ADX calculation - use close
    if (this.prices.length >= 2) {
      this._updateADX(highValue, lowValue, closePrice);
    }

    // NEW: Donchian channels
    this._updateDonchian();
    
    // FIXED: Track breakout events for retest logic
    if (this.donchianHigh != null && closePrice > this.donchianHigh) {
      if (this._lastBreakUpBar === null || this._barsSince(this._lastBreakUpBar) > 0) {
        this._lastBreakUpBar = this._currentBarIndex;
        this._lastBreakUpPrice = closePrice;
      }
    }
    if (this.donchianLow != null && closePrice < this.donchianLow) {
      if (this._lastBreakDownBar === null || this._barsSince(this._lastBreakDownBar) > 0) {
        this._lastBreakDownBar = this._currentBarIndex;
        this._lastBreakDownPrice = closePrice;
      }
    }
    
    // FIXED: Cache MA slope at bar completion to avoid intra-bar fluctuations
    // This matches backtest behavior where slope is only calculated on completed bars
    this._cachedMaSlope = this._calculateMaSlopeFromCompletedBars();

    // NEW: Track MA for cross detection
    const ma = this._sma(this.cfg.maPeriod ?? 70);
    if (Number.isFinite(ma)) {
      this._ma.push(ma);
      if (this._ma.length > 5000) this._ma.shift();
    }

    // NEW: Resample to HTF (1h) and update HTF cache
    if (this.cfg.enableHTFTrend) {
      this._updateHTF(closePrice, ts);
    }
    
    // FIXED: Session tracking for intraday volatility and trend detection
    this._updateSession(ts, highValue, lowValue, closePrice);

    // NEW: ATR
    if (this.prices.length >= 2) {
      this._updateATR(highValue, lowValue);
    }

    // NEW: Volume analysis
    this._updateVolumeAnalysis(price, volume);

    // Calculate warm-up requirement: For 5m: ADX(12) + SMA(70) + Donchian(30) needs sufficient warm-up
    const need = Math.max(
      100,
      2 * (this.cfg.adxPeriod ?? 12),
      (this.cfg.donchianPeriod ?? 30) + 5,
      this.cfg.maPeriod ?? 70
    );
    this._ready = this._barCount >= need;
  }

  _emaNext(prev, price, period) {
    const k = 2 / (period + 1);
    if (prev == null) return price;
    return prev + k * (price - prev);
  }

  _rsiNext(price) {
    const n = this.prices.length;
    if (n < 2) return null;
    const change = price - this.prices[n - 2];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    if (this._rsiAvgGain == null || this._rsiAvgLoss == null) {
      if (n < this.cfg.rsiPeriod + 1) return null;
      let g = 0, l = 0;
      for (let i = n - this.cfg.rsiPeriod; i < n; i++) {
        const d = this.prices[i] - this.prices[i - 1];
        if (d > 0) g += d;
        else l += -d;
      }
      this._rsiAvgGain = g / this.cfg.rsiPeriod;
      this._rsiAvgLoss = l / this.cfg.rsiPeriod;
    } else {
      this._rsiAvgGain = (this._rsiAvgGain * (this.cfg.rsiPeriod - 1) + gain) / this.cfg.rsiPeriod;
      this._rsiAvgLoss = (this._rsiAvgLoss * (this.cfg.rsiPeriod - 1) + loss) / this.cfg.rsiPeriod;
    }

    // Edge cases:
    // - Flat series (avgGain=0 and avgLoss=0) → RSI should be 50 (neutral), not 100.
    // - Gains only (avgLoss=0 and avgGain>0) → RSI = 100.
    if (this._rsiAvgLoss === 0) return this._rsiAvgGain === 0 ? 50 : 100;
    const rs = this._rsiAvgGain / this._rsiAvgLoss;
    return 100 - 100 / (1 + rs);
  }

  _rollSession(ts) {
    const cutoff = ts - this.cfg.vwapSessionMs;
    // Keep at least max of Donchian and MA periods for calculations
    const minBars = Math.max(
      (this.cfg.donchianPeriod ?? 30) + 1,
      this.cfg.maPeriod ?? 70
    );
    
    for (let i = 0; i < this.times.length; i++) {
      if (this.times[i] >= cutoff) {
        // Don't slice if it would leave fewer than minBars
        const keepIndex = Math.max(0, Math.min(i, this.times.length - minBars));
        if (keepIndex > 0) {
          for (let j = 0; j < keepIndex; j++) {
            const p = this.prices[j], v = Math.max(0, this.volumes[j]);
            this._pvSum -= p * v;
            this._vSum -= v;
          }
          this.prices = this.prices.slice(keepIndex);
          this.volumes = this.volumes.slice(keepIndex);
          this.times = this.times.slice(keepIndex);
          this.highs = this.highs.slice(keepIndex);
          this.lows = this.lows.slice(keepIndex);
          this._closes = this._closes.slice(keepIndex);
          this._ma = this._ma.slice(keepIndex);
        }
        break;
      }
    }
  }

  // ---------------- NEW: ADX calculation ----------------

  _updateADX(high, low, close) {
    if (this._prevHigh == null) {
      this._prevHigh = high;
      this._prevLow = low;
      this._prevClose = close;
      return;
    }

    // True Range
    const tr1 = high - low;
    const tr2 = Math.abs(high - this._prevClose);
    const tr3 = Math.abs(low - this._prevClose);
    const tr = Math.max(tr1, tr2, tr3);

    // Directional Movement
    // According to Wilder's ADX: if both +DM and -DM occur, use only the larger one
    const plusDMRaw = high > this._prevHigh ? (high - this._prevHigh) : 0;
    const minusDMRaw = low < this._prevLow ? (this._prevLow - low) : 0;
    
    let plusDM = 0;
    let minusDM = 0;
    
    if (plusDMRaw > minusDMRaw) {
      plusDM = plusDMRaw;
      minusDM = 0;
    } else if (minusDMRaw > plusDMRaw) {
      plusDM = 0;
      minusDM = minusDMRaw;
    } else {
      // If equal or both zero, both are zero
      plusDM = 0;
      minusDM = 0;
    }

    // Smoothing (Wilder's smoothing)
    if (this._trSmoothing == null) {
      // First time: need to accumulate initial period
      if (!this._trSmoothingAccum) {
        this._trSmoothingAccum = [];
        this._plusDMAccum = [];
        this._minusDMAccum = [];
      }
      this._trSmoothingAccum.push(tr);
      this._plusDMAccum.push(plusDM);
      this._minusDMAccum.push(minusDM);

      if (this._trSmoothingAccum.length >= this.cfg.adxPeriod) {
        this._trSmoothing = this._trSmoothingAccum.reduce((a, b) => a + b, 0) / this.cfg.adxPeriod;
        this._plusDISmoothing = this._plusDMAccum.reduce((a, b) => a + b, 0) / this.cfg.adxPeriod;
        this._minusDISmoothing = this._minusDMAccum.reduce((a, b) => a + b, 0) / this.cfg.adxPeriod;
      }
    } else {
      this._trSmoothing = (this._trSmoothing * (this.cfg.adxPeriod - 1) + tr) / this.cfg.adxPeriod;
      this._plusDISmoothing = (this._plusDISmoothing * (this.cfg.adxPeriod - 1) + plusDM) / this.cfg.adxPeriod;
      this._minusDISmoothing = (this._minusDISmoothing * (this.cfg.adxPeriod - 1) + minusDM) / this.cfg.adxPeriod;
    }

    if (this._trSmoothing == null || this._trSmoothing === 0) {
      this._prevHigh = high;
      this._prevLow = low;
      this._prevClose = close;
      return;
    }

    // +DI and -DI
    this._plusDI = 100 * (this._plusDISmoothing / this._trSmoothing);
    this._minusDI = 100 * (this._minusDISmoothing / this._trSmoothing);

    // DX
    const diSum = this._plusDI + this._minusDI;
    if (diSum === 0) {
      this._dx = 0;
    } else {
      const diDiff = Math.abs(this._plusDI - this._minusDI);
      this._dx = 100 * (diDiff / diSum);
    }

    // ADX (smoothed DX)
    if (this.adx == null) {
      if (!this._dxAccum) this._dxAccum = [];
      this._dxAccum.push(this._dx);
      if (this._dxAccum.length >= this.cfg.adxPeriod) {
        this.adx = this._dxAccum.reduce((a, b) => a + b, 0) / this.cfg.adxPeriod;
        // Start tracking ADX history once initialized
        this._adxHistory.push(this.adx);
      }
    } else {
      this.adx = (this.adx * (this.cfg.adxPeriod - 1) + this._dx) / this.cfg.adxPeriod;
      // Track ADX history for slope calculation
      this._adxHistory.push(this.adx);
      if (this._adxHistory.length > 100) this._adxHistory.shift();
    }

    this._prevHigh = high;
    this._prevLow = low;
    this._prevClose = close;
  }

  // ---------------- NEW: Donchian channels ----------------

  _donchianUpper(period) {
    const n = this.highs.length;
    // Need at least period+1 bars to have period previous bars (excluding current)
    if (n < period + 1) return undefined;
    // **exclude current bar**: use previous `period` highs
    // Current bar is at index n-1, we want indices (n-1-period) to (n-2)
    const start = Math.max(0, n - 1 - period);
    const end = n - 1; // Exclude current bar (index n-1)
    const window = this.highs.slice(start, end);
    if (window.length < period) return undefined;
    return Math.max(...window);
  }

  _donchianLower(period) {
    const n = this.lows.length;
    // Need at least period+1 bars to have period previous bars (excluding current)
    if (n < period + 1) return undefined;
    // **exclude current bar**: use previous `period` lows
    // Current bar is at index n-1, we want indices (n-1-period) to (n-2)
    const start = Math.max(0, n - 1 - period);
    const end = n - 1; // Exclude current bar (index n-1)
    const window = this.lows.slice(start, end);
    if (window.length < period) return undefined;
    return Math.min(...window);
  }

  _sma(period) {
    const n = this._closes.length;
    if (n < period) return undefined;
    const slice = this._closes.slice(n - period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // Helper: check proximity within basis points (e.g., 0.002 = 20 bps)
  _near(value, target, bps = 0.002) {
    if (!Number.isFinite(value) || !Number.isFinite(target) || value <= 0) return false;
    const diff = Math.abs(value - target) / value;
    return diff <= bps;
  }

  // Helper: detect micro-range compression over last N bars
  _isCompressed(bars = 6, threshold = null) {
    const n = this.highs.length;
    if (n < bars + 1) return false;
    const highs = this.highs.slice(-bars);
    const lows = this.lows.slice(-bars);
    const maxH = Math.max(...highs);
    const minL = Math.min(...lows);
    const lastClose = this._closes[this._closes.length - 1];
    if (!Number.isFinite(maxH) || !Number.isFinite(minL) || !Number.isFinite(lastClose) || lastClose <= 0) return false;
    const rng = (maxH - minL) / lastClose;
    const th = threshold ?? (this.cfg.bandPct ?? 0.0015);
    return rng <= th;
  }

  // HTF (Higher Timeframe) resampling: aggregate 5m bars into 1h candles
  _updateHTF(closePrice, ts) {
    const hourMs = 60 * 60 * 1000; // 1 hour in milliseconds
    const currentHour = Math.floor(ts / hourMs) * hourMs; // Round down to hour boundary

    if (this._htfLastHour === null || currentHour > this._htfLastHour) {
      // New hour started
      if (this._htfLastHour !== null && this._htfCandles.length > 0) {
        // Previous hour is complete - finalize its close with the last 5m close of that hour
        // The closePrice we just received is from the last 5m bar of the previous hour
        const prevHourCandle = this._htfCandles[this._htfCandles.length - 1];
        prevHourCandle.close = closePrice; // Finalize previous hour with last 5m close
        
        // Recalculate HTF SMA after finalizing previous hour (if we have enough candles)
        if (this._htfCandles.length >= (this.cfg.htfMaPeriod ?? 72)) {
          this._htfMa = this._smaHTF(this.cfg.htfMaPeriod ?? 72);
        }
      }

      // Start new hour candle with current close (will be updated as we get more 5m bars)
      this._htfCandles.push({
        close: closePrice, // Initial close (will update throughout the hour)
        ts: currentHour,
      });
      this._htfLastHour = currentHour;

      // Keep only enough for HTF MA calculation (htfMaPeriod + buffer)
      const maxCandles = (this.cfg.htfMaPeriod ?? 72) + 10;
      if (this._htfCandles.length > maxCandles) {
        this._htfCandles.shift();
      }
    } else {
      // Same hour: update current hour's close with latest 5m close
      if (this._htfCandles.length > 0) {
        this._htfCandles[this._htfCandles.length - 1].close = closePrice;
      }
    }
  }

  // Compute HTF SMA from cached 1h candles
  _smaHTF(period) {
    if (!this._htfCandles || this._htfCandles.length < period) {
      return undefined;
    }
    const slice = this._htfCandles.slice(-period);
    const sum = slice.reduce((a, b) => a + (b.close || 0), 0);
    return sum / period;
  }

  // Helper: get highest high from previous N bars (excluding current)
  _highPrevN(n) {
    const len = this.highs.length;
    if (len < n + 1) return undefined; // Need at least n+1 bars
    const start = len - n - 1; // Start before current bar
    const end = len - 1; // Exclude current bar
    const window = this.highs.slice(start, end);
    if (window.length === 0) return undefined;
    return Math.max(...window);
  }

  // Helper: get lowest low from previous N bars (excluding current)
  _lowPrevN(n) {
    const len = this.lows.length;
    if (len < n + 1) return undefined; // Need at least n+1 bars
    const start = len - n - 1; // Start before current bar
    const end = len - 1; // Exclude current bar
    const window = this.lows.slice(start, end);
    if (window.length === 0) return undefined;
    return Math.min(...window);
  }

  // Helper: get number of bars since a given bar index
  _barsSince(barIndex) {
    if (barIndex == null) return Infinity; // No exit recorded yet
    return this._currentBarIndex - barIndex;
  }

  // Helper: get last exit bar index for a side
  _lastExitBarSide(side) {
    if (side === 'long') return this._lastExitBarLong;
    if (side === 'short') return this._lastExitBarShort;
    return null;
  }

  // Helper: get last exit price for a side
  _lastExitPriceSide(side) {
    if (side === 'long') return this._lastExitPriceLong;
    if (side === 'short') return this._lastExitPriceShort;
    return null;
  }

  // Helper: get last swing low/high for trailing stop
  _lastSwing(side) {
    // Look back for swing: last local low for long, last local high for short
    const lookback = Math.min(20, this.highs.length, this.lows.length);
    if (lookback < 5) return undefined;
    
    if (side === 'long') {
      // For longs, find last swing low (support)
      const lowsWindow = this.lows.slice(-lookback);
      // Find the lowest point in the window
      return Math.min(...lowsWindow);
    } else {
      // For shorts, find last swing high (resistance)
      const highsWindow = this.highs.slice(-lookback);
      // Find the highest point in the window
      return Math.max(...highsWindow);
    }
  }

  _recentCrossUp(lookback = 3) {
    const n = this._closes.length;
    if (n < 2 || !this._ma || this._ma.length < 2) return false;
    const lkb = Math.min(lookback, n - 1, this._ma.length - 1);
    for (let i = 1; i <= lkb; i++) {
      const c0 = this._closes[n - 1 - i];
      const c1 = this._closes[n - i];
      const m0 = this._ma[this._ma.length - 1 - i];
      const m1 = this._ma[this._ma.length - 1];
      if (Number.isFinite(c0) && Number.isFinite(c1) && Number.isFinite(m0) && Number.isFinite(m1)) {
        if (c0 <= m0 && c1 > m1) return true; // crossed above within lookback
      }
    }
    return false;
  }

  _recentCrossDown(lookback = 3) {
    const n = this._closes.length;
    if (n < 2 || !this._ma || this._ma.length < 2) return false;
    const lkb = Math.min(lookback, n - 1, this._ma.length - 1);
    for (let i = 1; i <= lkb; i++) {
      const c0 = this._closes[n - 1 - i];
      const c1 = this._closes[n - i];
      const m0 = this._ma[this._ma.length - 1 - i];
      const m1 = this._ma[this._ma.length - 1];
      if (Number.isFinite(c0) && Number.isFinite(c1) && Number.isFinite(m0) && Number.isFinite(m1)) {
        if (c0 >= m0 && c1 < m1) return true; // crossed below within lookback
      }
    }
    return false;
  }
  
  // FIXED: Session tracking for intraday volatility and trend detection
  _updateSession(ts, high, low, close) {
    // Get UTC day key
    const now = new Date(ts);
    const dayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    
    // New day - reset session
    if (this._sessionDayKey !== dayKey) {
      this._sessionDayKey = dayKey;
      this._sessionOpen = close;
      this._sessionHigh = high;
      this._sessionLow = low;
      this._sessionClose = close;
    } else {
      // Same day - update session high/low/close
      if (high > this._sessionHigh) this._sessionHigh = high;
      if (low < this._sessionLow) this._sessionLow = low;
      this._sessionClose = close;
    }
  }
  
  // Helper: compute MA slope over N bars
  _maSlope(maArray, lookback = 12) {
    if (!maArray || maArray.length < lookback + 1) return 0;
    const n = maArray.length;
    const ma0 = maArray[n - 1 - lookback];
    const ma1 = maArray[n - 1];
    if (!Number.isFinite(ma0) || !Number.isFinite(ma1)) return 0;
    return ma1 - ma0; // Slope over lookback bars
  }
  
  // Helper: compute HTF MA slope (for HTF trend detection)
  _htfMaSlope(lookback = 8) {
    if (!this._htfCandles || this._htfCandles.length < lookback + 1) return 0;
    const n = this._htfCandles.length;
    const close0 = this._htfCandles[n - 1 - lookback].close;
    const close1 = this._htfCandles[n - 1].close;
    if (!Number.isFinite(close0) || !Number.isFinite(close1)) return 0;
    return close1 - close0; // HTF slope over lookback HTF bars
  }
  
  // Helper: compute ADX slope (for trend quality detection)
  _adxSlope(lookback = 12) {
    if (!this._adxHistory || this._adxHistory.length < lookback + 1) return 0;
    const n = this._adxHistory.length;
    const adx0 = this._adxHistory[n - 1 - lookback];
    const adx1 = this._adxHistory[n - 1];
    if (!Number.isFinite(adx0) || !Number.isFinite(adx1)) return 0;
    return adx1 - adx0; // ADX slope over lookback bars
  }

  _updateDonchian() {
    const period = this.cfg.donchianPeriod;

    // Use helper methods to compute Donchian bands from previous bars
    this.donchianHigh = this._donchianUpper(period);
    this.donchianLow = this._donchianLower(period);

    if (this.donchianHigh == null || this.donchianLow == null) {
      this._donchianHighBreakCount = 0;
      this._donchianLowBreakCount = 0;
      return;
    }

    // Track breakout confirmation, ensuring we only start counting when
    // price actually pushes through the prior band.
    const n = this.prices.length;
    const currentPrice = n > 0 ? this.prices[n - 1] : null;
    const prevPrice = n > 1 ? this.prices[n - 2] : null;

    if (currentPrice != null && Number.isFinite(currentPrice)) {
    if (currentPrice > this.donchianHigh) {
        const breachedFromBelow = !Number.isFinite(prevPrice) || prevPrice <= this.donchianHigh;
        this._donchianHighBreakCount = breachedFromBelow
          ? 1
          : Math.min((this._donchianHighBreakCount ?? 0) + 1, this.cfg.donchianConfirm);
    } else {
      this._donchianHighBreakCount = 0;
    }

    if (currentPrice < this.donchianLow) {
        const breachedFromAbove = !Number.isFinite(prevPrice) || prevPrice >= this.donchianLow;
        this._donchianLowBreakCount = breachedFromAbove
          ? 1
          : Math.min((this._donchianLowBreakCount ?? 0) + 1, this.cfg.donchianConfirm);
    } else {
      this._donchianLowBreakCount = 0;
      }
    }
  }

  // ---------------- NEW: ATR calculation ----------------

  _updateATR(high, low) {
    if (this._prevClose == null) {
      this._prevClose = this.prices[this.prices.length - 1];
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

    if (this._trueRanges.length < this.cfg.atrPeriod) {
      return;
    }

    // ATR is smoothed average of true ranges
    if (this.atr == null) {
      this.atr = this._trueRanges.slice(-this.cfg.atrPeriod).reduce((a, b) => a + b, 0) / this.cfg.atrPeriod;
    } else {
      // Wilder's smoothing
      this.atr = (this.atr * (this.cfg.atrPeriod - 1) + tr) / this.cfg.atrPeriod;
    }
  }

  // ---------------- NEW: Volume analysis ----------------

  _updateVolumeAnalysis(price, volume) {
    // Volume moving average
    const n = this.volumes.length;
    if (n >= this.cfg.volumeLookback) {
      const recentVolumes = this.volumes.slice(-this.cfg.volumeLookback);
      const volSum = recentVolumes.reduce((a, b) => a + Math.max(0, b), 0);
      this.volumeAvg = volSum / this.cfg.volumeLookback;

      // Detect volume spike
      const currentVol = Math.max(0, volume);
      this.volumeSpike = this.volumeAvg > 0 && 
                         currentVol >= (this.volumeAvg * this.cfg.volumeSpikeThreshold);
    }

    // Simple volume profile (price buckets)
    if (n >= 2) {
      const priceBucket = Math.round(price * 100) / 100; // 0.01 precision
      this.volumeProfile.set(priceBucket, (this.volumeProfile.get(priceBucket) || 0) + volume);
      
      // Keep only recent period
      if (this.volumeProfile.size > this.cfg.volumeProfilePeriod) {
        const oldestBucket = Array.from(this.volumeProfile.keys()).sort()[0];
        this.volumeProfile.delete(oldestBucket);
      }
    }
  }

  // ---------------- Anti-chop filters (original) ----------------

  _stddev(arr) {
    if (!arr || arr.length < 2) return 0;
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    const v = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
    return Math.sqrt(v);
  }

  _emaFastSlope() {
    // FIXED: Return cached slope value calculated at bar completion
    // This avoids intra-bar fluctuations and matches backtest behavior
    return this._cachedMaSlope ?? 0;
  }
  
  _calculateMaSlopeFromCompletedBars() {
    const n = this.prices.length;
    if (n < 2 || this.emaF == null) return 0;
    
    const lookback = this.cfg.maSlopeLookback ?? 3;
    const look = Math.min(lookback, n - 1);

    const prev = this._emaBack(this.cfg.emaFast, look);
    if (prev == null) return 0;

    // Slope: raw point change per bar
    return (this.emaF - prev) / look;
  }

  _emaBack(period, look) {
    const len = this.prices.length;
    if (len <= look) return null;
    let e = this.prices[len - look - 1];
    const k = 2 / (period + 1);
    for (let i = len - look; i < len; i++) {
      e = e + k * (this.prices[i] - e);
    }
    return e;
  }

  _zDistance(price) {
    if (!this._emaSHistory.length) return 0;
    const sd = this._stddev(this._emaSHistory);
    if (sd === 0) return 0;
    const lastES = this._emaSHistory[this._emaSHistory.length - 1];
    return (price - lastES) / sd;
  }

  _bandOKLong(price) {
    if (this.vwap == null) return true;
    if (!this._ok(price, this.vwap)) return false;
    return price >= this.vwap * (1 + this.cfg.bandPct);
  }

  _bandOKShort(price) {
    if (this.vwap == null) return true;
    if (!this._ok(price, this.vwap)) return false;
    return price <= this.vwap * (1 - this.cfg.bandPct);
  }

  _now() {
    return this._nowTs ?? Date.now();
  }

  _cooldownOK(side) {
    // Check if cooldown is enabled
    if (this.cfg.enableCooldown === false) {
      return true; // Cooldown disabled - always pass
    }
    
    // FIXED: Symmetric cooldown - applies to BOTH sides equally
    const now = this._now();
    const cooldownMs = this.cfg.cooldownMs ?? 0;
    const flipCooldownMs = this.cfg.flipCooldownMs ?? 0;
    
    // Basic entry cooldown (applies to any entry)
    const basicOK = cooldownMs === 0 || (now - this._lastEntryTs >= cooldownMs);
    if (!basicOK) return false;
    
    // Flip cooldown (only applies when flipping direction)
    const flipped = this._lastSide && this._lastSide !== side;
    if (flipped && flipCooldownMs > 0) {
      const flipOK = now - this._lastFlipTs >= flipCooldownMs;
      if (!flipOK) return false;
    }
    
    return true;
  }

  _timeGateOK(verbose = false) {
    // Time gate: Trade only UTC 08:00-20:00 (profitable window)
    // Optional: allow UTC 20:00-23:00 only on ADX≥25
    if (!this.cfg.enableTimeGate) {
      if (verbose) console.log(`[TIME-GATE] Disabled - allowing trade`);
      return true; // Time gate disabled by default
    }
    
    const now = this._now();
    const hour = new Date(now).getUTCHours();
    const timestamp = new Date(now).toISOString();
    
    // Always allow UTC 08:00-20:00
    if (hour >= 8 && hour < 20) {
      if (verbose) console.log(`[TIME-GATE] ${timestamp} UTC ${hour}:00 - ALLOWED (profitable window 08:00-20:00)`);
      return true;
    }
    
    // Optional: allow UTC 20:00-23:00 only if ADX >= 25
    if (hour >= 20 && hour < 23) {
      const adxThreshold = this.cfg.timeGateAdxThreshold ?? 25;
      const currentAdx = this._ok(this.adx) ? this.adx : null;
      if (currentAdx != null && currentAdx >= adxThreshold) {
        if (verbose) console.log(`[TIME-GATE] ${timestamp} UTC ${hour}:00 - ALLOWED (extended window 20:00-23:00, ADX=${currentAdx.toFixed(1)} >= ${adxThreshold})`);
        return true;
      } else {
        if (verbose) console.log(`[TIME-GATE] ${timestamp} UTC ${hour}:00 - BLOCKED (extended window 20:00-23:00, ADX=${currentAdx?.toFixed(1) ?? 'N/A'} < ${adxThreshold})`);
        return false;
      }
    }
    
    // Block all other hours (UTC 23:00-08:00)
    if (verbose) console.log(`[TIME-GATE] ${timestamp} UTC ${hour}:00 - BLOCKED (outside trading hours, blocked window 23:00-08:00)`);
    return false;
  }

  // ---------------- Signal logic ----------------

  _ready() {
    // Return the warm-up ready flag
    // Also check that required indicators are initialized
    return (
      this._ready &&
      this.prices.length >= this.cfg.minBars &&
      this.emaF != null &&
      this.emaS != null &&
      this.rsi != null &&
      this.adx != null && // NEW: require ADX
      this.donchianHigh != null && // NEW: require Donchian
      this.atr != null // NEW: require ATR
    );
  }

  shouldOpenLong(price) {
    if (!this._ready) return false;

    // Relaxed cross detection: recent cross OR already above MA
    const ma = this._sma(this.cfg.maPeriod ?? 70);
    const crossUpRecent = this._recentCrossUp(this.cfg.crossLookback ?? 3);
    const aboveMA = Number.isFinite(ma) && Number.isFinite(price) && price > ma;
    const crossOK = crossUpRecent || aboveMA;

    // Relaxed slope: normalized slope OR ADX override when trend is strong
    const slope = this._ok(this._emaFastSlope()) ? this._emaFastSlope() : 0;
    const slopeOK = slope >= (this.cfg.slopeMinFast ?? 0.0);
    const trendStrong = this._ok(this.adx) && this.adx >= (this.cfg.adxStrong ?? 25);
    const slopeGate = slopeOK || trendStrong; // ADX override

    const rsiOK = this._ok(this.rsi) && this.rsi >= this.cfg.rsiLong;
    const bandOK = this._bandOKLong(price);
    const zOK = this._ok(price) && Math.abs(this._zDistance(price)) <= this.cfg.zFilter;

    // NEW: ADX trend strength filter
    // For strict LONG gating: require higher ADX threshold (htfTrendOK + ADX≥20)
    const adxMinForLong = this.cfg.longStrictHTF 
      ? Math.max(this.cfg.adxMinTrend ?? 15, this.cfg.strictAdxMin ?? 20)
      : (this.cfg.adxMinTrend ?? 15);
    const adxOK = this._ok(this.adx) && this.adx >= adxMinForLong;

    // NEW: Donchian breakout confirmation (symmetric)
    // Distance calculations
    const donH = this.donchianHigh;
    const donL = this.donchianLow;
    const distFromHigh = this._ok(donH, price) ? (price / donH) - 1 : 0;
    const distFromLow = this._ok(donL, price) ? 1 - (price / donL) : 0;
    const bandPct = this.cfg.bandPct ?? 0.0015;
    const minDist = this.cfg.minDist ?? 0.0012;
    
    // Breakout checks (symmetric)
    const donBreakUp = this._ok(donH, price) && price > donH * (1 + bandPct) && distFromHigh >= minDist;
    const donBreakDown = this._ok(donL, price) && price < donL * (1 - bandPct) && distFromLow >= minDist;
    
    // Donchian OK: either breakout confirmed OR relaxed mode without confirmation
    let donchianOK = false;
    if (donBreakUp && this._donchianHighBreakCount >= this.cfg.donchianConfirm) {
      donchianOK = true;
    } else if (!this.cfg.donchianConfirm && this._ok(donH, price) && price > donH) {
      // Relaxed mode: just need price above donchianHigh
      donchianOK = true;
    }
    
    // NEW: Optional retest after a breakout (within last N bars) - for longs
    if (donchianOK && this.cfg.requireRetest && this._ok(ma, price)) {
      const N = this.cfg.retestBars ?? 5;
      const brokeUp = this._highPrevN(N);
      const heldUp = this._lowPrevN(N);
      
      if (this._ok(brokeUp, heldUp, donH)) {
        const brokeAbove = brokeUp > donH;
        const heldAbove = heldUp > donH;
        if (!(brokeAbove && heldAbove)) {
          donchianOK = false;
        }
      } else {
        // Not enough data for retest
        donchianOK = false;
      }
    }

    // NEW: Volume spike confirmation (optional)
    const volumeOK = !this.cfg.requireVolumeSpike || this.volumeSpike || this.volumeAvg === null;

    // NEW: HTF trend filter - only allow longs when 1h trend is up
    // For strict LONG gating: require htfTrendOK + ADX≥20
    let htfTrendOK = !this.cfg.enableHTFTrend || (() => {
      const htfMA = this._htfMa ?? this._smaHTF?.(this.cfg.htfMaPeriod ?? 72);
      if (!Number.isFinite(htfMA) || !Number.isFinite(price)) return true; // Pass if HTF not ready
      const htfUp = price > htfMA;
      return htfUp;
    })();
    
    // NEW: Side-specific strict gating for LONG
    if (this.cfg.longStrictHTF && !htfTrendOK) {
      // If strict LONG gating enabled and HTF trend is down, block entry
      htfTrendOK = false;
    }
    if (this.cfg.longStrictHTF) {
      // For strict LONG: also require ADX≥20 (checked later in adxOK)
      // This is handled by checking adxOK with higher threshold
    }

    // NEW: Volatility filter - filter out chop (min ATR/price)
    // Symmetric: same for both sides. Disable when vMin=0 or zFilter=0
    const useVolRegime = this.cfg.enableVolatilityFilter && 
                        (this.cfg.vMin ?? 0.0035) > 0 && 
                        (this.cfg.zFilter ?? 8.0) > 0;
    
    const volOK = !useVolRegime || (() => {
      const atr21 = this.atr;
      if (!Number.isFinite(atr21) || !Number.isFinite(price) || price <= 0) return true; // Pass if not ready
      const volRatio = atr21 / price;
      
      // Session-aware volatility threshold
      let vMinThreshold = this.cfg.vMin ?? 0.0035;
      if (this.cfg.enableSessionAwareness) {
        const now = this._now();
        const hour = new Date(now).getUTCHours();
        // Quiet session: UTC 0-8 (late night/early morning)
        // Active session: UTC 8-20 (overlapping EU/US hours)
        const isQuietSession = hour >= 0 && hour < 8;
        vMinThreshold = isQuietSession 
          ? (this.cfg.vMinQuiet ?? 0.0040) // 0.40% during quiet hours
          : (this.cfg.vMinActive ?? 0.0035); // 0.35% during active hours
      }
      
      return volRatio >= vMinThreshold;
    })();

    // NEW: Anti-flip protection - block immediate opposite entries
    let flipOK = true;
    const flipBars = this.cfg.flipCooldownBars ?? 8;
    const side = 'long';
    const oppositeSide = 'short';
    
    // Check bar-based flip cooldown: block long if we just exited short
    if (this._barsSince(this._lastExitBarSide(oppositeSide)) < flipBars) {
      flipOK = false;
    } else if (this._lastExitBarSide(oppositeSide) != null) {
      // Check impulse requirement: need ≥ 0.6×ATR move from last exit
      const atr21 = this.atr;
      const lastExitPrice = this._lastExitPriceSide(oppositeSide);
      if (Number.isFinite(lastExitPrice) && Number.isFinite(atr21) && atr21 > 0) {
        const impulseOK = Math.abs(price - lastExitPrice) >= 0.6 * atr21;
        if (!impulseOK) {
          flipOK = false;
        }
      }
    }

    // Time gate check
    const timeGateOK = this._timeGateOK(this.cfg.verbose);
    if (!timeGateOK && this.cfg.enableTimeGate) {
      // Log when time gate blocks a trade
      const now = this._now();
      const hour = new Date(now).getUTCHours();
      const timestamp = new Date(now).toISOString();
      console.log(`[TIME-GATE-BLOCK] ${timestamp} UTC ${hour}:00 - BLOCKED LONG entry (all other conditions passed)`);
    }
    
    // NOTE: Cooldown check removed - now handled in getSignal() after same-bar guard
    return crossOK && slopeGate && rsiOK && bandOK && zOK && adxOK && donchianOK && volumeOK && 
           htfTrendOK && volOK && flipOK && timeGateOK;
  }

  shouldOpenShort(price) {
    if (!this._ready) return false;

    // Relaxed cross detection: recent cross OR already below MA
    const ma = this._sma(this.cfg.maPeriod ?? 70);
    const crossDownRecent = this._recentCrossDown(this.cfg.crossLookback ?? 3);
    const belowMA = Number.isFinite(ma) && Number.isFinite(price) && price < ma;
    const crossOK = crossDownRecent || belowMA;

    // Relaxed slope: normalized slope OR ADX override when trend is strong
    const slope = this._ok(this._emaFastSlope()) ? this._emaFastSlope() : 0;
    const slopeOK = slope <= -(this.cfg.slopeMinFast ?? 0.0);
    const trendStrong = this._ok(this.adx) && this.adx >= (this.cfg.adxStrong ?? 25);
    const slopeGate = slopeOK || trendStrong; // ADX override

    const rsiOK = this._ok(this.rsi) && this.rsi <= this.cfg.rsiShort;
    const bandOK = this._bandOKShort(price);
    const zOK = this._ok(price) && Math.abs(this._zDistance(price)) <= this.cfg.zFilter;

    // NEW: ADX trend strength filter
    // For strict SHORT gating: require higher ADX threshold
    const adxMinForShort = this.cfg.shortStrictHTF 
      ? Math.max(this.cfg.adxMinTrend ?? 15, this.cfg.strictAdxMin ?? 20)
      : (this.cfg.adxMinTrend ?? 15);
    const adxOK = this._ok(this.adx) && this.adx >= adxMinForShort;

    // NEW: Donchian breakout confirmation (symmetric)
    // Distance calculations
    const donH = this.donchianHigh;
    const donL = this.donchianLow;
    const distFromHigh = this._ok(donH, price) ? (price / donH) - 1 : 0;
    const distFromLow = this._ok(donL, price) ? 1 - (price / donL) : 0;
    const bandPct = this.cfg.bandPct ?? 0.0015;
    const minDist = this.cfg.minDist ?? 0.0012;
    
    // Breakout checks (symmetric)
    const donBreakUp = this._ok(donH, price) && price > donH * (1 + bandPct) && distFromHigh >= minDist;
    const donBreakDown = this._ok(donL, price) && price < donL * (1 - bandPct) && distFromLow >= minDist;
    
    // Donchian OK for SHORT: either breakout confirmed OR relaxed mode without confirmation
    let donchianOK = false;
    if (donBreakDown && this._donchianLowBreakCount >= this.cfg.donchianConfirm) {
      donchianOK = true;
    } else if (!this.cfg.donchianConfirm && this._ok(donL, price) && price < donL) {
      // Relaxed mode: just need price below donchianLow
      donchianOK = true;
    }
    
    // NEW: Optional retest after a breakout (within last N bars) - for shorts
    if (donchianOK && this.cfg.requireRetest && this._ok(ma, price)) {
      const N = this.cfg.retestBars ?? 5;
      const brokeDown = this._lowPrevN(N);
      const heldDown = this._highPrevN(N);
      
      if (this._ok(brokeDown, heldDown, donL)) {
        const brokeBelow = brokeDown < donL;
        const heldBelow = heldDown < donL;
        if (!(brokeBelow && heldBelow)) {
          donchianOK = false;
        }
      } else {
        // Not enough data for retest
        donchianOK = false;
      }
    }

    // NEW: Volume spike confirmation
    const volumeOK = !this.cfg.requireVolumeSpike || this.volumeSpike || this.volumeAvg === null;

    // NEW: HTF trend filter - only allow shorts when 1h trend is down
    // For strict SHORT gating: require htfTrendOK + ADX≥20
    let htfTrendOK = !this.cfg.enableHTFTrend || (() => {
      const htfMA = this._htfMa ?? this._smaHTF?.(this.cfg.htfMaPeriod ?? 72);
      if (!Number.isFinite(htfMA) || !Number.isFinite(price)) return true; // Pass if HTF not ready
      const htfDown = price < htfMA;
      return htfDown;
    })();
    
    // NEW: Side-specific strict gating for SHORT
    if (this.cfg.shortStrictHTF && !htfTrendOK) {
      // If strict SHORT gating enabled and HTF trend is up, block entry
      htfTrendOK = false;
    }
    if (this.cfg.shortStrictHTF) {
      // For strict SHORT: also require ADX≥20 (checked earlier in adxOK)
    }

    // NEW: Volatility filter - filter out chop (min ATR/price)
    // Symmetric: same for both sides. Disable when vMin=0 or zFilter=0
    const useVolRegime = this.cfg.enableVolatilityFilter && 
                        (this.cfg.vMin ?? 0.0035) > 0 && 
                        (this.cfg.zFilter ?? 8.0) > 0;
    
    const volOK = !useVolRegime || (() => {
      const atr21 = this.atr;
      if (!Number.isFinite(atr21) || !Number.isFinite(price) || price <= 0) return true; // Pass if not ready
      const volRatio = atr21 / price;
      
      // Session-aware volatility threshold
      let vMinThreshold = this.cfg.vMin ?? 0.0035;
      if (this.cfg.enableSessionAwareness) {
        const now = this._now();
        const hour = new Date(now).getUTCHours();
        // Quiet session: UTC 0-8 (late night/early morning)
        // Active session: UTC 8-20 (overlapping EU/US hours)
        const isQuietSession = hour >= 0 && hour < 8;
        vMinThreshold = isQuietSession 
          ? (this.cfg.vMinQuiet ?? 0.0040) // 0.40% during quiet hours
          : (this.cfg.vMinActive ?? 0.0035); // 0.35% during active hours
      }
      
      return volRatio >= vMinThreshold;
    })();

    // NEW: Anti-flip protection - block immediate opposite entries
    let flipOK = true;
    const flipBars = this.cfg.flipCooldownBars ?? 8;
    const side = 'short';
    const oppositeSide = 'long';
    
    // Check bar-based flip cooldown: block short if we just exited long
    if (this._barsSince(this._lastExitBarSide(oppositeSide)) < flipBars) {
      flipOK = false;
    } else if (this._lastExitBarSide(oppositeSide) != null) {
      // Check impulse requirement: need ≥ 0.6×ATR move from last exit
      const atr21 = this.atr;
      const lastExitPrice = this._lastExitPriceSide(oppositeSide);
      if (Number.isFinite(lastExitPrice) && Number.isFinite(atr21) && atr21 > 0) {
        const impulseOK = Math.abs(price - lastExitPrice) >= 0.6 * atr21;
        if (!impulseOK) {
          flipOK = false;
        }
      }
    }

    // Time gate check
    const timeGateOK = this._timeGateOK(this.cfg.verbose);
    if (!timeGateOK && this.cfg.enableTimeGate) {
      // Log when time gate blocks a trade
      const now = this._now();
      const hour = new Date(now).getUTCHours();
      const timestamp = new Date(now).toISOString();
      console.log(`[TIME-GATE-BLOCK] ${timestamp} UTC ${hour}:00 - BLOCKED SHORT entry (all other conditions passed)`);
    }
    
    // NOTE: Cooldown check removed - now handled in getSignal() after same-bar guard
    return crossOK && slopeGate && rsiOK && bandOK && zOK && adxOK && donchianOK && volumeOK && 
           htfTrendOK && volOK && flipOK && timeGateOK;
  }

  // Record exit for anti-flip tracking
  recordExit(side, price) {
    if (side === 'long') {
      this._lastExitBarLong = this._currentBarIndex;
      this._lastExitPriceLong = price;
    } else if (side === 'short') {
      this._lastExitBarShort = this._currentBarIndex;
      this._lastExitPriceShort = price;
    }
    
    // CRITICAL FIX: Reset same-bar guard when position closes
    // This allows re-entry on same bar after stop loss (e.g., quick stop → new valid signal)
    // The _lastClosedSide and cooldown logic will still prevent flip-flopping
    // Only reset if the closed side matches the last opened side (i.e., we're closing what we opened)
    if (this._lastOpenSide && this._lastOpenSide.toLowerCase() === side.toLowerCase()) {
      this._lastOpenBarIndex = null;
      this._lastOpenSide = null;
    }
  }

  /**
   * Confirm that a trade was actually executed (called by bot after successful execution)
   * This sets the same-bar guard to prevent multiple entries on the same bar
   * CRITICAL: Only call this when a trade is ACTUALLY executed, not just when a signal is generated
   * @param {string} side - 'long' or 'short'
   */
  confirmTradeExecution(side) {
    const s = side?.toLowerCase();
    this._lastOpenBarIndex = this._currentBarIndex;
    this._lastOpenSide = s;
    if (s === 'short') {
      this._lastShortBarIndex = this._currentBarIndex;
    }
    if (this.cfg.verbose) {
      console.log(`[MOMENTUM] Trade confirmed: ${s} at bar ${this._currentBarIndex}, same-bar guard set`);
    }
  }

  shouldClose(position, price) {
    if (!position) return false;
    if (!this._ready) return false;

    const side = position.side?.toLowerCase();
    const entry = position.entryPrice;
    if (!Number.isFinite(entry) || !Number.isFinite(price)) return false;

    // Compute R on the fly (stopDistance saved at entry = ATR*mult)
    const stopDistance = position.stopDistance || (this.atr && this._ok(this.atr) ? this.atr * this.cfg.atrStopMultiplier : null);
    if (!stopDistance || stopDistance <= 0) {
      // Fallback to original logic if stopDistance not available
      if (this._now() - (position.openTime || 0) > this.cfg.maxHoldMs) return true;
      if (this.cfg.closeOnCross) {
        if (side === 'long') {
          const crossDown = this._ok(this.emaF, this.emaS) && this.emaF < this.emaS;
          if (crossDown) return true;
        } else {
          const crossUp = this._ok(this.emaF, this.emaS) && this.emaF > this.emaS;
          if (crossUp) return true;
        }
      }
      if (this._ok(this.adx) && this.adx < this.cfg.adxExitWeak) return true;
      return false;
    }

    const unrealizedR = side === 'long' 
      ? (price - entry) / stopDistance 
      : (entry - price) / stopDistance;

    // FIXED: Early panic-cut (fast adverse move) - within 3 bars, exit if adverse ≥ 1.2×ATR
    if (position.openBarIndex != null && this._ok(this.atr)) {
      const barsSinceEntry = this._barsSince(position.openBarIndex);
      if (barsSinceEntry <= 3) {
        const atr21 = this.atr;
        const adverse = side === 'short' ? (price - entry) : (entry - price);
        if (adverse >= 1.2 * atr21) {
          return true; // Panic-cut exit
        }
      }
    }

    // NEW: Partial take at +1.0R (check if not already taken)
    if (this.cfg.enablePartialTake && !position.tookHalf) {
      if (unrealizedR >= (this.cfg.partialAtR ?? 1.0)) {
        // Signal to take partial (handled by caller)
        position.shouldTakePartial = true;
        position.stopDistance = stopDistance; // Ensure stopDistance is set
        // Don't return true here - let the position update handle partial take
      }
    }

    // NEW: After partial take, move stop to breakeven
    if (position.tookHalf && !position.stopMovedToBreakeven) {
      position.stopMovedToBreakeven = true;
      position.stopPrice = entry; // Move stop to entry price
    }

    // NEW: Trailing stop (after partial or always if enabled)
    if (this.cfg.enableTrailingStop && this._ok(this.atr)) {
      const atr21 = this.atr;
      const lastSwing = this._lastSwing(side);
      
      let trailDistance;
      if (Number.isFinite(lastSwing)) {
        // Trail at max(1.5×ATR, lastSwing)
        const trailATR = atr21 * (this.cfg.trailATR ?? 1.5);
        if (side === 'long') {
          const swingDist = entry - lastSwing;
          trailDistance = Math.max(trailATR, swingDist);
        } else {
          const swingDist = lastSwing - entry;
          trailDistance = Math.max(trailATR, swingDist);
        }
      } else {
        trailDistance = atr21 * (this.cfg.trailATR ?? 1.5);
      }

      const trailingStopPrice = side === 'long'
        ? price - trailDistance
        : price + trailDistance;

      // Update stop price if trailing stop is better
      if (position.stopPrice == null || 
          (side === 'long' && trailingStopPrice > position.stopPrice) ||
          (side === 'short' && trailingStopPrice < position.stopPrice)) {
        position.stopPrice = trailingStopPrice;
      }

      // Check if price hit trailing stop
      if (side === 'long' && price <= position.stopPrice) {
        return true;
      }
      if (side === 'short' && price >= position.stopPrice) {
        return true;
      }
    } else if (position.stopPrice != null) {
      // Check fixed stop (breakeven or initial stop)
      if (side === 'long' && price <= position.stopPrice) {
        return true;
      }
      if (side === 'short' && price >= position.stopPrice) {
        return true;
      }
    }

    // NEW: Time stop - exit if < +0.5R after 36 bars
    if (this.cfg.enableTimeStop && position.openBarIndex != null) {
      const barsHeld = this._currentBarIndex - position.openBarIndex;
      if (barsHeld >= (this.cfg.timeStopBars ?? 36)) {
        if (unrealizedR < (this.cfg.minRToHold ?? 0.5)) {
          return true; // Time stop exit
        }
      }
    }

    // Original: Time-based exit (max hold)
    if (this._now() - (position.openTime || 0) > this.cfg.maxHoldMs) return true;

    // Original: EMA cross exit
    if (this.cfg.closeOnCross) {
      if (side === 'long') {
        const crossDown = this._ok(this.emaF, this.emaS) && this.emaF < this.emaS;
        const vwapFail = this._ok(this.vwap, price) && this.vwap != null && price < this.vwap * (1 - this.cfg.bandPct);
        if (crossDown || vwapFail) return true;
      } else {
        const crossUp = this._ok(this.emaF, this.emaS) && this.emaF > this.emaS;
        const vwapFail = this._ok(this.vwap, price) && this.vwap != null && price > this.vwap * (1 + this.cfg.bandPct);
        if (crossUp || vwapFail) return true;
      }
    }

    // NEW: ADX weakening exit
    if (this._ok(this.adx) && this.adx < this.cfg.adxExitWeak) return true;

    // NEW: ATR-based stop loss (initial stop, before trailing)
    if (!position.stopPrice && this._ok(this.atr)) {
      const stopDistance = this.atr * this.cfg.atrStopMultiplier;
      if (side === 'long' && price <= entry - stopDistance) return true;
      if (side === 'short' && price >= entry + stopDistance) return true;
    }

    return false;
  }

  // FIXED: Symmetric predicate evaluation - compute both sides together
  _evaluateGates(price, printGates = false) {
    if (!this._ready) return { longOK: false, shortOK: false };
    
    // Shared signals (symmetric)
    const ma = this._sma(this.cfg.maPeriod ?? 70);
    const aboveMA = Number.isFinite(ma) && Number.isFinite(price) && price > ma;
    const belowMA = !aboveMA; // Exact complement
    
    const trendOK = this._ok(this.adx) && this.adx >= (this.cfg.adxMinTrend ?? 15);
    
    // Donchian (symmetric) - optional gate
    const donH = this.donchianHigh;
    const donL = this.donchianLow;
    const bandPct = this.cfg.bandPct ?? 0.0015;
    const minDist = this.cfg.minDist ?? 0.0012;
    const donchianConfirm = this.cfg.donchianConfirm ?? 1;
    const enableDonchianGate = this.cfg.enableDonchianGate ?? true; // Optional gate (default: enabled)
    
    const distFromHigh = this._ok(donH, price) ? (price / donH) - 1 : 0;
    const distFromLow = this._ok(donL, price) ? 1 - (price / donL) : 0;
    const donBreakUp = this._ok(donH, price) && price > donH * (1 + bandPct) && distFromHigh >= minDist;
    const donBreakDn = this._ok(donL, price) && price < donL * (1 - bandPct) && distFromLow >= minDist;
    
    const donUpOK = !enableDonchianGate ? true : (donchianConfirm 
      ? (donBreakUp && this._donchianHighBreakCount >= donchianConfirm)
      : (this._ok(donH, price) && price > donH));
    const donDnOK = !enableDonchianGate ? true : (donchianConfirm
      ? (donBreakDn && this._donchianLowBreakCount >= donchianConfirm)
      : (this._ok(donL, price) && price < donL));
    
    // Vol regime (symmetric, disable if zFilter=0 or vMin=0)
    const zFilter = this.cfg.zFilter ?? 8.0;
    const vMin = this.cfg.vMin ?? 0.0035;
    const useVolRegime = this.cfg.enableVolatilityFilter && zFilter > 0 && vMin > 0;
    const regimeLongOK = !useVolRegime || (() => {
      const zOK = this._ok(price) && Math.abs(this._zDistance(price)) <= zFilter;
      const atr21 = this.atr;
      if (!Number.isFinite(atr21) || !Number.isFinite(price) || price <= 0) return true;
      const volRatio = atr21 / price;
      let vMinThreshold = vMin;
      if (this.cfg.enableSessionAwareness) {
        const now = this._now();
        const hour = new Date(now).getUTCHours();
        const isQuietSession = hour >= 0 && hour < 8;
        vMinThreshold = isQuietSession ? (this.cfg.vMinQuiet ?? 0.0040) : (this.cfg.vMinActive ?? 0.0035);
      }
      return zOK && volRatio >= vMinThreshold;
    })();
    const regimeShortOK = regimeLongOK; // Same for both sides
    
    // HTF gating (symmetric)
    const htfTrendOK = !this.cfg.enableHTFTrend || (() => {
      const htfMA = this._htfMa ?? this._smaHTF?.(this.cfg.htfMaPeriod ?? 72);
      if (!Number.isFinite(htfMA) || !Number.isFinite(price)) return true;
      return price > htfMA; // HTF up trend
    })();
    // HTF gating: LONG needs HTF up, SHORT needs HTF down
    const longHTFOK = !this.cfg.longStrictHTF || htfTrendOK; // LONG: price > HTF MA
    const shortHTFOK = !this.cfg.shortStrictHTF || !htfTrendOK; // SHORT: price < HTF MA (inverse of htfTrendOK)
    
    // RSI (symmetric)
    const rsiLongOK = this._ok(this.rsi) && this.rsi >= (this.cfg.rsiLong ?? 55);
    const rsiShortOK = this._ok(this.rsi) && this.rsi <= (this.cfg.rsiShort ?? 45);
    
    // ADX (symmetric)
    const adxMinForLong = this.cfg.longStrictHTF 
      ? Math.max(this.cfg.adxMinTrend ?? 15, this.cfg.strictAdxMin ?? 20)
      : (this.cfg.adxMinTrend ?? 15);
    const adxMinForShort = this.cfg.shortStrictHTF
      ? Math.max(this.cfg.adxMinTrend ?? 15, this.cfg.strictAdxMin ?? 20)
      : (this.cfg.adxMinTrend ?? 15);
    const adxLongOK = this._ok(this.adx) && this.adx >= adxMinForLong;
    const adxShortOK = this._ok(this.adx) && this.adx >= adxMinForShort;
    
    // Band/Z (symmetric)
    const bandLongOK = this._bandOKLong(price);
    const bandShortOK = this._bandOKShort(price);
    
    // Volume (optional)
    const volumeOK = !this.cfg.requireVolumeSpike || this.volumeSpike || this.volumeAvg === null;
    
    // NOTE: Cooldown is NOT checked here in gate evaluation
    // It's checked separately AFTER same-bar guard in getSignal()
    // This prevents false "Cooldown:❌" display on same-bar re-evaluations
    const cooldownLongOK = true;  // Always pass in gate evaluation
    const cooldownShortOK = true; // Always pass in gate evaluation
    
    // Anti-flip (symmetric)
    const flipLongOK = (() => {
      const flipBars = this.cfg.flipCooldownBars ?? 8;
      const oppositeSide = 'short';
      if (this._barsSince(this._lastExitBarSide(oppositeSide)) < flipBars) return false;
      const atr21 = this.atr;
      const lastExitPrice = this._lastExitPriceSide(oppositeSide);
      if (Number.isFinite(lastExitPrice) && Number.isFinite(atr21) && atr21 > 0) {
        const impulseOK = Math.abs(price - lastExitPrice) >= 0.6 * atr21;
        return impulseOK;
      }
      return true;
    })();
    const flipShortOK = (() => {
      const flipBars = this.cfg.flipCooldownBars ?? 8;
      const oppositeSide = 'long';
      if (this._barsSince(this._lastExitBarSide(oppositeSide)) < flipBars) return false;
      const atr21 = this.atr;
      const lastExitPrice = this._lastExitPriceSide(oppositeSide);
      if (Number.isFinite(lastExitPrice) && Number.isFinite(atr21) && atr21 > 0) {
        const impulseOK = Math.abs(price - lastExitPrice) >= 0.6 * atr21;
        return impulseOK;
      }
      return true;
    })();
    
    // FIXED: MA slope requirement - percentage-based with inclusive thresholds
    // Now uses normalized percentage change per bar (industry standard)
    // Allows flat MA (slope = 0) to pass when threshold is 0
    // Example: 0.01% per bar = 0.2% per 5min candle (20 bars)
    const maSlope = this._emaFastSlope ? (this._ok(this._emaFastSlope()) ? this._emaFastSlope() : 0) : 0;
    const maSlopeUp = this.cfg.requireMaSlopeLong
      ? maSlope > (this.cfg.maSlopeUpMin ?? 0)
      : true;
    const maSlopeDn = this.cfg.requireMaSlopeShort
      ? maSlope < (this.cfg.maSlopeDownMax ?? 0)
      : true;
    
    // NEW: ADX slope check (optional, for quality gate)
    const adxSlopeOK = !this.cfg.requireAdxSlopeUp || (() => {
      const adxSlope = this._adxSlope(12);
      return adxSlope >= 0; // Require ADX slope >= 0 (trending up/stable, not weakening)
    })();
    
    // NEW: ATR-based entry distance gate (optional, to avoid late entries)
    const entryDistLongOK = this.cfg.maxEntryDistAtr == null || !this._ok(this.atr, donH, price) || (() => {
      const atr21 = this.atr;
      const maxDistAtr = this.cfg.maxEntryDistAtr;
      const distFromDonH = Math.abs(price - donH);
      const maxDistLong = atr21 * maxDistAtr;
      return distFromDonH <= maxDistLong; // Only allow entries within maxEntryDistAtr × ATR of Donchian high
    })();
    
    const entryDistShortOK = this.cfg.maxEntryDistAtr == null || !this._ok(this.atr, donL, price) || (() => {
      const atr21 = this.atr;
      const maxDistAtr = this.cfg.maxEntryDistAtr;
      const distFromDonL = Math.abs(price - donL);
      const maxDistShort = atr21 * maxDistAtr;
      return distFromDonL <= maxDistShort; // Only allow entries within maxEntryDistAtr × ATR of Donchian low
    })();
    
    // DI bias check for longs (DI+ > DI-)
    const diPlus = this._plusDI ?? 0;
    const diMinus = this._minusDI ?? 0;
    const diLongOK = (diPlus + diMinus) > 1e-6 ? (diPlus > diMinus) : true; // Prefer DI+ > DI- for longs
    const diShortOK = (diPlus + diMinus) > 1e-6 ? (diMinus > diPlus) : true; // SHORT requires DI- > DI+
    
    // Retest check (for longs with requireRetest)
    let retestOKlong = true;
    if (this.cfg.requireRetest && donUpOK && this._ok(ma, price, donH)) {
      const N = this.cfg.retestBars ?? 6;
      const brokeUp = this._highPrevN(N);
      const heldUp = this._lowPrevN(N);
      if (this._ok(brokeUp, heldUp, donH)) {
        const brokeAbove = brokeUp > donH;
        const heldAbove = heldUp > donH;
        retestOKlong = brokeAbove && heldAbove;
      } else {
        retestOKlong = false; // Not enough data for retest
      }
    }
    
    // FIXED: SHORT pullback retest check - only if requireRetest is true (consistent with long retest)
    let retestOKshort = true;
    if (this.cfg.requireRetest && donDnOK && this._ok(price, donL)) {
      // Check if broke down and held below within retestBars
      const N = this.cfg.retestBars ?? 6;
      const brokeDn = this._lowPrevN(N);
      const heldDn = this._highPrevN(N);
      if (this._ok(brokeDn, heldDn, donL)) {
        const brokeBelow = brokeDn < donL;
        const heldBelow = heldDn < donL;
        retestOKshort = brokeBelow && heldBelow;
      } else {
        retestOKshort = false; // Not enough data for retest
      }
    }
    
    // FIXED: HTF slope check for shorts (require negative HTF slope) - only if HTF enabled
    const htfSlopeNegative = !this.cfg.enableHTFTrend || (() => {
      const htfSlope = this._htfMaSlope?.(8) ?? 0;
      return htfSlope < 0;
    })();
    
    // FIXED: Veto shorts when day is green & trending (session-aware)
    // Only applies when enableGreenDayVeto is true (default: false)
    let vetoShortsGreenDay = false;
    if (this.cfg.enableGreenDayVeto && this._sessionOpen != null && this._sessionClose != null && this._ok(this.atr)) {
      const dayUp = this._sessionClose > this._sessionOpen;
      const dayRange = this._sessionHigh - this._sessionLow;
      const atrDay = this.atr ? this.atr * 24 : 0; // Approximate daily ATR from 5m ATR
      const trendyDay = this.adx >= 22 || (dayRange > 3 * atrDay);
      vetoShortsGreenDay = dayUp && trendyDay;
    }
    
    // Time gate check (symmetric for both sides)
    const timeGateOK = this._timeGateOK(this.cfg.verbose);
    if (!timeGateOK && this.cfg.enableTimeGate) {
      // Log when time gate blocks a trade
      const now = this._now();
      const hour = new Date(now).getUTCHours();
      const timestamp = new Date(now).toISOString();
      if (printGates) {
        console.log(`[TIME-GATE-BLOCK] ${timestamp} UTC ${hour}:00 - BLOCKED entry (all other conditions passed)`);
      }
    }
    
    // FINAL predicates - LONG stricter, SHORT moderate
    // NOTE: cooldown is NOT included here - it's checked separately in getSignal() after same-bar guard
    const longOK = aboveMA && maSlopeUp && trendOK && donUpOK && regimeLongOK && longHTFOK && rsiLongOK && 
                   adxLongOK && bandLongOK && volumeOK && flipLongOK && diLongOK && retestOKlong &&
                   adxSlopeOK && entryDistLongOK && timeGateOK;
    const shortOK = belowMA && maSlopeDn && trendOK && donDnOK && regimeShortOK && shortHTFOK && rsiShortOK && 
                    adxShortOK && bandShortOK && volumeOK && flipShortOK && diShortOK && 
                    retestOKshort && htfSlopeNegative && !vetoShortsGreenDay &&
                    adxSlopeOK && entryDistShortOK && timeGateOK;
    
    // DEBUG: print gates if requested
    if (printGates) {
      const ts = new Date(this._now()).toISOString();
      const htfMA = this._htfMa ?? this._smaHTF?.(this.cfg.htfMaPeriod ?? 72);
      const htfSlope = this._htfMaSlope?.(8) ?? 0;
      const fastSlope = maSlope;
      const diPlus = this._plusDI ?? 0;
      const diMinus = this._minusDI ?? 0;
      const brokeUp = this._lastBreakUpBar != null ? 1 : 0;
      const brokeDn = this._lastBreakDownBar != null ? 1 : 0;
      console.log(`[GATES] ${ts} longOK=${+longOK} shortOK=${+shortOK} enableDonchianGate=${+enableDonchianGate} `,
        `aboveMA=${+aboveMA} belowMA=${+belowMA} trendOK=${+trendOK} `,
        `donUpOK=${+donUpOK} donDnOK=${+donDnOK} donBreakUp=${+donBreakUp} donBreakDn=${+donBreakDn} `,
        `regimeOK=${+regimeLongOK} `,
        `longHTFOK=${+longHTFOK} shortHTFOK=${+shortHTFOK} `,
        `rsiLongOK=${+rsiLongOK} rsiShortOK=${+rsiShortOK} `,
        `adxLongOK=${+adxLongOK} adxShortOK=${+adxShortOK} `,
        `bandLongOK=${+bandLongOK} bandShortOK=${+bandShortOK} `,
        `volumeOK=${+volumeOK} cooldownLongOK=${+cooldownLongOK} cooldownShortOK=${+cooldownShortOK} `,
        `flipLongOK=${+flipLongOK} flipShortOK=${+flipShortOK} `,
        `htfMA=${htfMA?.toFixed(2) ?? 'NA'} htfSlope=${htfSlope.toFixed(2)} fastSlope=${fastSlope.toFixed(2)} `,
        `ADX=${this.adx?.toFixed(1) ?? 'NA'} DI+=${diPlus.toFixed(2)} DI-=${diMinus.toFixed(2)} `,
        `brokeUp=${brokeUp} brokeDn=${brokeDn} `,
        `rsi=${this.rsi?.toFixed(2) ?? 'NA'} donH=${donH?.toFixed(4) ?? 'NA'} donL=${donL?.toFixed(4) ?? 'NA'} ma=${ma?.toFixed(4) ?? 'NA'}`
      );
    }
    
    // Return detailed gate status for analytics
    const gateStatus = {
      // Long gates
      aboveMA,
      maSlopeUp,
      trendOK,
      donUpOK,
      regimeLongOK,
      longHTFOK,
      rsiLongOK,
      adxLongOK,
      bandLongOK,
      volumeOK,
      cooldownLongOK,
      flipLongOK,
      diLongOK,
      retestOKlong,
      adxSlopeOK,
      entryDistLongOK,
      timeGateOK,
      // Short gates
      belowMA,
      maSlopeDn,
      donDnOK,
      regimeShortOK,
      shortHTFOK,
      rsiShortOK,
      adxShortOK,
      bandShortOK,
      cooldownShortOK,
      flipShortOK,
      diShortOK,
      retestOKshort,
      htfSlopeNegative,
      vetoShortsGreenDay,
      entryDistShortOK,
    };
    
    return { longOK, shortOK, gateStatus };
  }

  // Expose gate state for analytics without generating a trade signal
  getGateState(price, printGates = false) {
    const { longOK, shortOK, gateStatus } = this._evaluateGates(price, printGates);
    return { longOK, shortOK, ...gateStatus };
  }

  getSignal(price, positions = [], printGates = false, barIndexOrTickIndex = null, allowPyramids = true) {
    // FIXED: Differentiate between tick index (from bot.js loop) and bar index (from backtest candle index)
    // Production (bot.js): passes this._ticks (tick counter, increments every loop ~5s)
    // Backtest: passes idx (candle index, increments every 5m bar)
    // Strategy needs bar index for "bars since" logic, so we track our own barIndex via update() calls
    
    // Increment tick counter for debugging/logging
    this._currentTickIndex++;
    
    // Use internal barIndex for all "bars since" logic
    // barIndexOrTickIndex is kept for backward compatibility but not used for cooldowns
    const barIndex = this._currentBarIndex;
    
    const hasLong = positions.some(p => p.side?.toLowerCase() === 'long' && !p.exitTime);
    const hasShort = positions.some(p => p.side?.toLowerCase() === 'short' && !p.exitTime);
    const inPos = hasLong || hasShort;

    // NEW: Check pyramiding opportunities before exits
    if (this.cfg.pyramidEnable && allowPyramids && inPos) {
      const longPos = hasLong ? positions.find(p => p.side?.toLowerCase() === 'long' && !p.exitTime) : null;
      const shortPos = hasShort ? positions.find(p => p.side?.toLowerCase() === 'short' && !p.exitTime) : null;
      
      if (longPos && !longPos.pyramidAdded) {
        // Check if we should add to long
        const unrealizedR = longPos.stopDistance ? (price - longPos.entryPrice) / longPos.stopDistance : 0;
        const adxSlope = this._adxSlope(12);
        const atr21 = this.atr;
        
        if (unrealizedR >= this.cfg.pyramidTriggerAtr && adxSlope >= 0 && this._ok(atr21)) {
    const conf = this._confidence(price);
          return { action: 'pyramid', side: 'long', confidence: conf, reason: 'long_pyramid_trigger' };
        }
      }
      
      if (shortPos && !shortPos.pyramidAdded) {
        // Check if we should add to short
        const unrealizedR = shortPos.stopDistance ? (shortPos.entryPrice - price) / shortPos.stopDistance : 0;
        const adxSlope = this._adxSlope(12);
        const atr21 = this.atr;
        
        if (unrealizedR >= this.cfg.pyramidTriggerAtr && adxSlope >= 0 && this._ok(atr21)) {
          const conf = this._confidence(price);
          return { action: 'pyramid', side: 'short', confidence: conf, reason: 'short_pyramid_trigger' };
        }
      }
    }

    // FIXED: Check exits first
    if (hasLong) {
      const close = this.shouldClose(positions.find(p => p.side.toLowerCase() === 'long' && !p.exitTime), price);
      if (close) {
        const conf = this._confidence(price);
        // Always record exit on internal barIndex (not dependent on external parameter)
        this._lastClosedBarIndex = this._currentBarIndex;
        this._lastClosedSide = 'long';
        return { action: 'close', side: 'long', confidence: conf, reason: 'long_exit_rule' };
      }
    }
    if (hasShort) {
      const close = this.shouldClose(positions.find(p => p.side.toLowerCase() === 'short' && !p.exitTime), price);
      if (close) {
        const conf = this._confidence(price);
        // Always record exit on internal barIndex (not dependent on external parameter)
        this._lastClosedBarIndex = this._currentBarIndex;
        this._lastClosedSide = 'short';
        return { action: 'close', side: 'short', confidence: conf, reason: 'short_exit_rule' };
      }
    }

    // FIXED: Suppress signals when in position (unless pyramids allowed)
    if (inPos && !allowPyramids) {
      // Still evaluate gates to update lastLongOK/lastShortOK for edge detection
      const { longOK, shortOK, gateStatus } = this._evaluateGates(price, printGates);
      this._lastLongOK = longOK;
      this._lastShortOK = shortOK;
      const conf = this._confidence(price);
      return { action: 'hold', confidence: conf, reason: 'already_in_position', longOK, shortOK, gateStatus };
    }

    // FIXED: Use symmetric gate evaluation
    const { longOK, shortOK, gateStatus } = this._evaluateGates(price, printGates);
    
    // Store gate results for analytics (lightweight - just boolean flags)
    const gateResults = { longOK, shortOK, gateStatus };
    
    // FIXED: Edge-triggered signals (only emit on rising edge: false → true)
    // Can be disabled via ENABLE_EDGE_TRIGGER=false for immediate signal response
    const useEdgeTrigger = this.cfg.enableEdgeTrigger !== false;
    const longEdge = useEdgeTrigger ? (longOK && !this._lastLongOK) : longOK;
    const shortEdge = useEdgeTrigger ? (shortOK && !this._lastShortOK) : shortOK;
    this._lastLongOK = longOK;
    this._lastShortOK = shortOK;
    
    // Guard: only one open per bar per side (use internal barIndex)
    // Can be disabled via ENABLE_SAME_BAR_GUARD=false (not recommended)
    if (this.cfg.enableSameBarGuard !== false && this._lastOpenBarIndex === this._currentBarIndex) {
      const conf = this._confidence(price);
      return { action: 'hold', confidence: conf, reason: 'already_opened_this_bar', ...gateResults };
    }
    
    // FIXED: Check cooldown AFTER same-bar guard to prevent false "Cooldown:❌" on same-bar re-evaluations
    // Cooldown applies to actual entry attempts, not gate evaluations
    if (longEdge && !this._cooldownOK('long')) {
      const conf = this._confidence(price);
      if (printGates) {
        const timeSince = this._now() - this._lastEntryTs;
        console.log(`[COOLDOWN-BLOCK] LONG blocked: ${(timeSince/1000).toFixed(1)}s since last entry (need ${(this.cfg.cooldownMs/1000).toFixed(0)}s)`);
      }
      return { action: 'hold', confidence: conf, reason: 'cooldown_long', ...gateResults };
    }
    if (shortEdge && !this._cooldownOK('short')) {
      const conf = this._confidence(price);
      if (printGates) {
        const timeSince = this._now() - this._lastEntryTs;
        console.log(`[COOLDOWN-BLOCK] SHORT blocked: ${(timeSince/1000).toFixed(1)}s since last entry (need ${(this.cfg.cooldownMs/1000).toFixed(0)}s)`);
      }
      return { action: 'hold', confidence: conf, reason: 'cooldown_short', ...gateResults };
    }
    
    // Guard: re-entry only after position fully closed (prevent same-side re-entry too soon)
    // Note: This check applies to edge signals only. Pullback/squeeze entries will be checked separately below.
    // Configurable via MIN_BARS_SAME_SIDE_REENTRY (default: 3 bars = 15min on 5m)
    const minBarsReentry = this.cfg.minBarsSameSideReentry ?? 3;
    if (this._lastClosedBarIndex != null && this._lastClosedSide != null && minBarsReentry > 0) {
      const barsSinceClose = this._currentBarIndex - this._lastClosedBarIndex;
      if (barsSinceClose < minBarsReentry) {
        // Still need to check which side we're trying to enter
        let tryingSameSide = false;
        if ((longEdge || longOK) && this._lastClosedSide === 'long') tryingSameSide = true;
        if ((shortEdge || shortOK) && this._lastClosedSide === 'short') tryingSameSide = true;
        if (tryingSameSide) {
          const conf = this._confidence(price);
          if (printGates) {
            console.log(`[REENTRY-BLOCK] Same-side reentry cooldown: barsSinceClose=${barsSinceClose}/${minBarsReentry} side=${this._lastClosedSide}`);
          }
          return { action: 'hold', confidence: conf, reason: 'same_side_reentry_cooldown', ...gateResults };
        }
      }
    }
    
    // FIXED: One-side-per-hour throttle for shorts (use internal barIndex)
    if (shortEdge && this._lastShortBarIndex != null) {
      const barsSinceLastShort = this._currentBarIndex - this._lastShortBarIndex;
      if (barsSinceLastShort < 12) { // 12×5m = 1h
        const conf = this._confidence(price);
        return { action: 'hold', confidence: conf, reason: 'short_hour_throttle', ...gateResults };
      }
    }
    
    // Side selection + confidence (only on edge)
    let side = null;
    let confidence = 0;
    
    if (longEdge && !shortEdge) {
      side = 'long';
      const conf = this._confidence(price);
      confidence = Math.max(0.01, Math.abs(conf)); // Ensure positive
    } else if (shortEdge && !longEdge) {
      side = 'short';
      const conf = this._confidence(price);
      confidence = -Math.abs(conf); // Ensure negative
    } else if (longEdge && shortEdge) {
      // Tie-breaker by confidence score
      const conf = this._confidence(price);
      side = conf >= 0 ? 'long' : 'short';
      confidence = side === 'long' ? Math.max(0.01, Math.abs(conf)) : -Math.abs(conf);
    }
    
    // Frequency-boosting entries: try variants when no edge signal
    if (!side) {
      // 1) Pullback entry to breakout (smaller size 0.5x)
      if (this.cfg.enablePullbackEntry) {
        const touchBps = this.cfg.pullbackTouchBps ?? 0.002;
        const lookbackBars = this.cfg.pullbackLookbackBars ?? 5;
        const recentBreakUp = this._lastBreakUpBar != null && this._barsSince(this._lastBreakUpBar) <= lookbackBars;
        const recentBreakDn = this._lastBreakDownBar != null && this._barsSince(this._lastBreakDownBar) <= lookbackBars;
        const emaF = this.emaF;
        const vwap = this.vwap;
        const adxOK = this._ok(this.adx) && this.adx >= (this.cfg.adxMinTrend ?? 15);
        const ma = this._sma(this.cfg.maPeriod ?? 70);

        // Long pullback
        const rsiRegimeLong = this._ok(this.rsi) && this.rsi >= 50;
        const nearSupportLong = (Number.isFinite(emaF) && this._near(price, emaF, touchBps)) ||
                                (Number.isFinite(vwap) && this._near(price, vwap, touchBps));
        
        // Enhanced logging for pullback conditions
        if (printGates) {
          const barsSinceUp = this._lastBreakUpBar != null ? this._barsSince(this._lastBreakUpBar) : null;
          const barsSinceDn = this._lastBreakDownBar != null ? this._barsSince(this._lastBreakDownBar) : null;
          const distEma = Number.isFinite(emaF) ? Math.abs(price - emaF) / price : null;
          const distVwap = Number.isFinite(vwap) ? Math.abs(price - vwap) / price : null;
          console.log(`[PULLBACK-CHECK] long: recentBreakUp=${+recentBreakUp} (barsSince=${barsSinceUp}/${lookbackBars}) adxOK=${+adxOK} (ADX=${this.adx?.toFixed(1)}) rsiRegimeLong=${+rsiRegimeLong} (RSI=${this.rsi?.toFixed(1)}) nearSupportLong=${+nearSupportLong} (emaDist=${distEma?.toFixed(4)} vwapDist=${distVwap?.toFixed(4)}) price>ma=${+(Number.isFinite(ma) && price > ma)} cooldownOK=${+this._cooldownOK('long')}`);
          console.log(`[PULLBACK-CHECK] short: recentBreakDn=${+recentBreakDn} (barsSince=${barsSinceDn}/${lookbackBars}) adxOK=${+adxOK} (ADX=${this.adx?.toFixed(1)}) rsiRegimeShort=${+rsiRegimeShort} (RSI=${this.rsi?.toFixed(1)}) nearResistanceShort=${+nearResistanceShort} (emaDist=${distEma?.toFixed(4)} vwapDist=${distVwap?.toFixed(4)}) price<ma=${+(Number.isFinite(ma) && price < ma)} cooldownOK=${+this._cooldownOK('short')}`);
        }
        
        // Check same-side reentry cooldown for pullback entries (use internal barIndex)
        let pullbackLongBlocked = false;
        let pullbackShortBlocked = false;
        const minBarsReentry = this.cfg.minBarsSameSideReentry ?? 3;
        if (this._lastClosedBarIndex != null && this._lastClosedSide != null && minBarsReentry > 0) {
          const barsSinceClose = this._currentBarIndex - this._lastClosedBarIndex;
          if (barsSinceClose < minBarsReentry) {
            if (this._lastClosedSide === 'long') pullbackLongBlocked = true;
            if (this._lastClosedSide === 'short') pullbackShortBlocked = true;
            if (printGates && (pullbackLongBlocked || pullbackShortBlocked)) {
              console.log(`[PULLBACK-BLOCK] Same-side reentry cooldown: barsSinceClose=${barsSinceClose}/${minBarsReentry} side=${this._lastClosedSide}`);
            }
          }
        }
        
        if (recentBreakUp && adxOK && rsiRegimeLong && nearSupportLong && Number.isFinite(ma) && price > ma && this._cooldownOK('long') && !pullbackLongBlocked) {
          const conf = this._confidence(price);
          if (printGates) {
            console.log(`[PULLBACK-ENTRY] LONG triggered: price=${price.toFixed(4)} sizeMult=${this.cfg.pullbackSizeMultiplier ?? 0.5}`);
          }
          this._markEntry('long');
          // NOTE: _lastOpenBarIndex set in confirmTradeExecution() when trade actually executes
          return {
            action: 'open', side: 'long', confidence: Math.max(0.01, Math.abs(conf)), reason: 'pullback_reentry',
            sizeMultiplier: this.cfg.pullbackSizeMultiplier ?? 0.5
          };
        }

        // Short pullback
        const rsiRegimeShort = this._ok(this.rsi) && this.rsi <= 50;
        const nearResistanceShort = (Number.isFinite(emaF) && this._near(price, emaF, touchBps)) ||
                                    (Number.isFinite(vwap) && this._near(price, vwap, touchBps));
        if (recentBreakDn && adxOK && rsiRegimeShort && nearResistanceShort && Number.isFinite(ma) && price < ma && this._cooldownOK('short') && !pullbackShortBlocked) {
          const conf = this._confidence(price);
          if (printGates) {
            console.log(`[PULLBACK-ENTRY] SHORT triggered: price=${price.toFixed(4)} sizeMult=${this.cfg.pullbackSizeMultiplier ?? 0.5}`);
          }
          this._markEntry('short');
          // NOTE: _lastOpenBarIndex set in confirmTradeExecution() when trade actually executes
          return {
            action: 'open', side: 'short', confidence: -Math.abs(conf), reason: 'pullback_reentry',
            sizeMultiplier: this.cfg.pullbackSizeMultiplier ?? 0.5
          };
        }
      }

      // 2) Micro-range squeeze early entry
      if (this.cfg.enableSqueezeEntry) {
        const barsN = this.cfg.squeezeBarsN ?? 6;
        const compressed = this._isCompressed(barsN, this.cfg.bandPct ?? 0.0015);
        const adxStart = this.cfg.squeezeAdxStart ?? 15;
        const adxTarget = this.cfg.squeezeAdxTarget ?? 18;
        const adxSlopeUp = this._adxSlope(12) > 0;
        const adxRisingBand = this._ok(this.adx) && this.adx >= adxStart && this.adx <= (adxTarget + 5);
        const ma = this._sma(this.cfg.maPeriod ?? 70);

        // Enhanced logging for squeeze conditions
        if (printGates) {
          const donH = this.donchianHigh, donL = this.donchianLow;
          const mid = (this._ok(donH, donL) ? (donH + donL) / 2 : ma);
          const adxSlope = this._adxSlope(12);
          const range = this.highs.length >= barsN && this.lows.length >= barsN 
            ? (Math.max(...this.highs.slice(-barsN)) - Math.min(...this.lows.slice(-barsN))) / price 
            : null;
          console.log(`[SQUEEZE-CHECK] compressed=${+compressed} (range=${range?.toFixed(4)} threshold=${this.cfg.bandPct ?? 0.0015}) adxSlopeUp=${+adxSlopeUp} (slope=${adxSlope?.toFixed(2)}) adxRisingBand=${+adxRisingBand} (ADX=${this.adx?.toFixed(1)} range=[${adxStart}-${adxTarget + 5}]) price>=mid=${+(Number.isFinite(mid) && price >= mid)} price>ma=${+(Number.isFinite(ma) && price > ma)} cooldownOK=${+this._cooldownOK('long')}`);
          console.log(`[SQUEEZE-CHECK] compressed=${+compressed} adxSlopeUp=${+adxSlopeUp} adxRisingBand=${+adxRisingBand} price<=mid=${+(Number.isFinite(mid) && price <= mid)} price<ma=${+(Number.isFinite(ma) && price < ma)} cooldownOK=${+this._cooldownOK('short')}`);
        }

        // Check same-side reentry cooldown for squeeze entries (use internal barIndex)
        let squeezeLongBlocked = false;
        let squeezeShortBlocked = false;
        const minBarsReentry = this.cfg.minBarsSameSideReentry ?? 3;
        if (this._lastClosedBarIndex != null && this._lastClosedSide != null && minBarsReentry > 0) {
          const barsSinceClose = this._currentBarIndex - this._lastClosedBarIndex;
          if (barsSinceClose < minBarsReentry) {
            if (this._lastClosedSide === 'long') squeezeLongBlocked = true;
            if (this._lastClosedSide === 'short') squeezeShortBlocked = true;
            if (printGates && (squeezeLongBlocked || squeezeShortBlocked)) {
              console.log(`[SQUEEZE-BLOCK] Same-side reentry cooldown: barsSinceClose=${barsSinceClose}/${minBarsReentry} side=${this._lastClosedSide}`);
            }
          }
        }

        if (compressed && adxSlopeUp && adxRisingBand) {
          // Long-biased squeeze inside band near upper half
          const donH = this.donchianHigh, donL = this.donchianLow;
          const mid = (this._ok(donH, donL) ? (donH + donL) / 2 : ma);
          if (Number.isFinite(mid) && Number.isFinite(ma)) {
            if (price >= mid && price > ma && this._cooldownOK('long') && !squeezeLongBlocked) {
              const conf = this._confidence(price);
              if (printGates) {
                console.log(`[SQUEEZE-ENTRY] LONG triggered: price=${price.toFixed(4)} stopATR=${this.cfg.squeezeInitialStopATR ?? 2.3}`);
              }
              this._markEntry('long');
              this._lastOpenBarIndex = this._currentBarIndex;
              return {
                action: 'open', side: 'long', confidence: Math.max(0.01, Math.abs(conf)), reason: 'squeeze_entry',
                atrStopMultiplier: this.cfg.squeezeInitialStopATR ?? 2.3,
                stopWidenAtR: this.cfg.squeezeWidenAtR ?? 0.5,
                stopWidenTo: this.cfg.squeezeWidenToATR ?? 2.8
              };
            }
            // Short-biased squeeze inside band near lower half
            if (price <= mid && price < ma && this._cooldownOK('short') && !squeezeShortBlocked) {
              const conf = this._confidence(price);
              if (printGates) {
                console.log(`[SQUEEZE-ENTRY] SHORT triggered: price=${price.toFixed(4)} stopATR=${this.cfg.squeezeInitialStopATR ?? 2.3}`);
              }
              this._markEntry('short');
              this._lastOpenBarIndex = this._currentBarIndex;
              this._lastShortBarIndex = this._currentBarIndex;
              return {
                action: 'open', side: 'short', confidence: -Math.abs(conf), reason: 'squeeze_entry',
                atrStopMultiplier: this.cfg.squeezeInitialStopATR ?? 2.3,
                stopWidenAtR: this.cfg.squeezeWidenAtR ?? 0.5,
                stopWidenTo: this.cfg.squeezeWidenToATR ?? 2.8
              };
            }
          }
        }
      }

      const conf = this._confidence(price);
      return { action: 'hold', confidence: conf, reason: 'no_edge_signal', ...gateResults };
    }
    
    // Debounce: avoid double emit within same bar/second
    const nowMs = this._now();
    if (nowMs - this._lastSignalTs < 2000) {
      const conf = this._confidence(price);
      return { action: 'hold', confidence: conf, reason: 'debounce', ...gateResults };
    }
    this._lastSignalTs = nowMs;
    
    // NOTE: _lastOpenBarIndex is now set in confirmTradeExecution() when trade is ACTUALLY executed
    // This prevents the same-bar guard from blocking entries when signals are generated but blocked by allocator/guard
    
    // Guard-rail assert
    if (printGates && longOK && side !== 'long' && !shortOK) {
      console.warn(`[ASSERT] longOK=true but side=${side} (should be long); check flip/cooldown/maxPositions flow`);
    }
    
    this._markEntry(side);
    return { action: 'open', side, confidence, reason: 'enhanced_confluence', longOK, shortOK, gateStatus };
  }

  _markEntry(side) {
    const now = this._now();
    if (this._lastSide && this._lastSide !== side) {
      this._lastFlipTs = now;
    }
    this._lastSide = side;
    this._lastEntryTs = now;
  }

  _confidence(price) {
    if (!this._ready) return 0;
    
    // FIXED: Sign-correct confidence scoring (positive = long, negative = short)
    // Components: all normalized to ~[-1, +1]
    
    // DI bias (directional indicator)
    const diPlus = this._plusDI ?? 0;
    const diMinus = this._minusDI ?? 0;
    const diBias = (diPlus + diMinus) > 1e-6 
      ? (diPlus - diMinus) / (diPlus + diMinus) 
      : 0; // +long, -short
    
    // Slope bias (MA slope, normalized)
    const slope = this._emaFastSlope();
    const slopeBias = Math.tanh(slope * 1000); // Clamp to [-1, +1], +long, -short
    
    // RSI bias
    const rsiBias = (this.rsi - 50) / 50; // Normalize: +long (RSI>50), -short (RSI<50)
    
    // Breakout bias
    let breakoutBias = 0;
    if (this.donchianHigh != null && this.donchianLow != null) {
      const bandPct = this.cfg.bandPct ?? 0.0015;
      const donBreakUp = this._ok(this.donchianHigh, price) && price > this.donchianHigh * (1 + bandPct);
      const donBreakDown = this._ok(this.donchianLow, price) && price < this.donchianLow * (1 - bandPct);
      if (donBreakUp) breakoutBias = +1;
      else if (donBreakDown) breakoutBias = -1;
    }

    // Weighted score
    const score = 0.35 * diBias + 0.25 * slopeBias + 0.20 * rsiBias + 0.20 * breakoutBias;
    
    // Clamp to [-1, +1] for normalized confidence
    const clamped = Math.max(-1, Math.min(1, score));
    return Number(clamped.toFixed(3));
  }

  // ---------------- NEW: Dynamic position sizing ----------------

  getRecommendedPositionSize(price, side) {
    if (!this._ready) return this.cfg.basePositionSize;

    const conf = Math.abs(this._confidence(price));
    let size = this.cfg.basePositionSize;

    // Scale by confidence
    if (conf >= 2.5) {
      size = this.cfg.maxPositionSize; // High confidence
    } else if (conf >= 1.5) {
      size = this.cfg.basePositionSize; // Medium confidence
    } else {
      size = this.cfg.minPositionSize; // Low confidence
    }

    // Volatility adjustment
    if (this.cfg.volatilityAdjustment && this.atr != null && price > 0) {
      const atrPercent = (this.atr / price) * 100;
      
      if (atrPercent > 2.0) {
        // High volatility: reduce size
        size *= 0.7;
      } else if (atrPercent < 1.0) {
        // Low volatility: increase size slightly
        size *= 1.2;
      }
    }

    // Ensure within bounds
    size = Math.max(this.cfg.minPositionSize, Math.min(size, this.cfg.maxPositionSize));
    
    return Number(size.toFixed(4));
  }

  // ---------------- NEW: Get ATR-based stop/target levels ----------------

  getStopLossLevel(entryPrice, side) {
    if (!this.atr || !entryPrice) return null;
    const stopDistance = this.atr * this.cfg.atrStopMultiplier;
    return side === 'long' 
      ? entryPrice - stopDistance 
      : entryPrice + stopDistance;
  }

  getTakeProfitLevel(entryPrice, side) {
    if (!this.atr || !entryPrice) return null;
    const targetDistance = this.atr * this.cfg.atrTakeProfitMultiplier;
    return side === 'long' 
      ? entryPrice + targetDistance 
      : entryPrice - targetDistance;
  }
}

module.exports = EnhancedMomentumBreakoutStrategy;

