#!/usr/bin/env node

const assert = require("node:assert/strict");

const BtcBreakoutStrategy = require("../../src/strategies/btc-breakout-strategy");

const EPS = 1e-9;

function approxEqual(actual, expected, tolerance = EPS) {
  return (
    Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance
  );
}

function withSilencedConsole(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function createStrategy(overrides = {}) {
  return withSilencedConsole(
    () =>
      new BtcBreakoutStrategy({
        market: "BTC-PERP",
        quiet: true,
        breakoutStrategy: {
          trendEmaPeriod: 3,
          trendSlopeLookback: 1,
          trendSlopeThreshold: 0,
          regimeEmaPeriod: 3,
          regimeSlopeLookback: 1,
          regimeSlopeThreshold: 0,
          entryChannel: 2,
          exitChannel: 1,
          entryMode: "breakout",
          confirmCloseOnly: true,
          requireVolumeConfirmation: false,
          volumeLookback: 2,
          volumeSpikeThreshold: 1.5,
          entryBufferBps: 0,
          maxEntryDistAtr: 0,
          pullbackRetestAtr: 0.75,
          pullbackSetupExpiryBars: 3,
          fibRetraceLevel: 0.618,
          fibPocketLowerLevel: 0.65,
          fibZoneShallowLevel: 0.382,
          fibZoneMidLevel: 0.5,
          fibZoneDeepLevel: 0.618,
          fibInvalidationLevel: 0.786,
          fibRetraceConfirmCloseLocation: 0.5,
          fibSwingLookbackBars: 40,
          fibSwingPivotStrength: 2,
          fibMinSwingRangeAtr: 0,
          fibRequireConfirmedSwing: false,
          fibMinConfluenceCount: 0,
          fibConfluenceToleranceAtr: 0.35,
          fibUseBreakoutLevelConfluence: false,
          fibUseEmaConfluence: false,
          fibUseAnchoredVwapConfluence: false,
          fibAnchoredVwapSource: "swing",
          enableOppositeChannelExit: true,
          enableRegimeFailureExit: false,
          regimeFailureMode: "ema_cross",
          enableAtrTrail: false,
          atrTrailMult: 3,
          timeStopBars: 0,
          staleTimeStopEnabled: false,
          staleTimeStopMinProfitAtr: 0.5,
          staleTimeStopRequireTrendFailure: false,
          hardStopEnabled: true,
          hardStopPercent: 0,
          atrStopMult: 2.25,
          atrPeriod: 2,
          minVolatilityPct: 0,
          maxVolatilityPct: 20,
          regimeFilterEnabled: true,
          allowLongs: true,
          allowShorts: true,
          enableCooldown: false,
          maxConsecutiveLosses: 3,
          circuitBreakerCooldownMs: 60_000,
          dynamicConfidence: false,
          positionSizePercent: 50,
          volatilityScaleBase: 0.02,
          minPositionSize: 50,
          maxPositionSize: 5_000,
          minBars: 3,
          maxBufferBars: 200,
          ...overrides,
        },
      })
  );
}

function updateBars(strategy, bars) {
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    strategy.update({
      price: bar.close,
      close: bar.close,
      high: bar.high,
      low: bar.low,
      volume: bar.volume ?? 1,
      ts: bar.ts ?? (i + 1) * 60_000,
    });
  }
}

const breakoutStrategyTestCases = [
  {
    name: "strategy exposes the required lifecycle methods",
    fn() {
      const strategy = createStrategy();
      assert.equal(typeof strategy.update, "function");
      assert.equal(typeof strategy.updateTick, "function");
      assert.equal(typeof strategy.recalculateLastBar, "function");
      assert.equal(typeof strategy.getSignal, "function");
      assert.equal(typeof strategy.shouldClose, "function");
      assert.equal(typeof strategy.reset, "function");
      assert.equal(typeof strategy.getRecommendedPositionSize, "function");
      assert.equal(typeof strategy.recordTrade, "function");
      assert.equal(typeof strategy.getStats, "function");
    },
  },
  {
    name: "warmup gating returns hold until minBars is reached",
    fn() {
      const strategy = createStrategy({ minBars: 5 });
      updateBars(strategy, [
        { close: 100, high: 101, low: 99 },
        { close: 101, high: 102, low: 100 },
      ]);

      const signal = strategy.getSignal(150, []);
      assert.equal(signal.action, "hold");
      assert.equal(signal.reason, "warmup");
      assert.equal(signal.barsRemaining, 3);
    },
  },
  {
    name: "ATR seeds from completed true ranges and then applies Wilder smoothing",
    fn() {
      const strategy = createStrategy({ atrPeriod: 3, minBars: 1 });

      updateBars(strategy, [
        { close: 10, high: 10, low: 10 },
        { close: 11, high: 12, low: 9 },
        { close: 12, high: 13, low: 10 },
      ]);

      assert.equal(
        strategy.atr,
        null,
        "ATR should remain null until period true ranges are available"
      );

      strategy.update({ close: 15, high: 16, low: 11, volume: 1, ts: 4 * 60_000 });
      assert(approxEqual(strategy.atr, 11 / 3), `Expected seeded ATR of 11/3, got ${strategy.atr}`);

      strategy.update({ close: 16, high: 17, low: 14, volume: 1, ts: 5 * 60_000 });
      const expectedAtr = (11 / 3) * (2 / 3) + 3 / 3;
      assert(
        approxEqual(strategy.atr, expectedAtr, 1e-12),
        `Expected Wilder ATR ${expectedAtr}, got ${strategy.atr}`
      );
    },
  },
  {
    name: "EMA seeds from the SMA of completed bars and slope uses past EMA values only",
    fn() {
      const strategy = createStrategy({
        regimeEmaPeriod: 3,
        regimeSlopeLookback: 2,
        minBars: 1,
      });

      strategy.update({ close: 10, high: 10, low: 10, volume: 1, ts: 60_000 });
      assert.equal(strategy._ema, null);
      assert.equal(strategy._emaSlope, null);

      strategy.update({ close: 11, high: 11, low: 11, volume: 1, ts: 120_000 });
      assert.equal(strategy._ema, null);
      assert.equal(strategy._emaSlope, null);

      strategy.update({ close: 12, high: 12, low: 12, volume: 1, ts: 180_000 });
      assert(approxEqual(strategy._ema, 11));
      assert.equal(strategy._emaSlope, null);

      strategy.update({ close: 13, high: 13, low: 13, volume: 1, ts: 240_000 });
      assert(approxEqual(strategy._ema, 12));
      assert.equal(strategy._emaSlope, null);

      strategy.update({ close: 14, high: 14, low: 14, volume: 1, ts: 300_000 });
      const expectedSlope = ((13 - 11) / 11) * 100;
      assert(approxEqual(strategy._ema, 13));
      assert(approxEqual(strategy._emaSlope, expectedSlope, 1e-12));
    },
  },
  {
    name: "Donchian channels exclude the current bar high and low",
    fn() {
      const strategy = createStrategy({
        entryChannel: 3,
        exitChannel: 2,
        regimeEmaPeriod: 2,
        regimeSlopeLookback: 1,
        minBars: 1,
      });

      updateBars(strategy, [
        { close: 9, high: 10, low: 5 },
        { close: 10, high: 12, low: 6 },
        { close: 10.5, high: 11, low: 7 },
        { close: 11.5, high: 50, low: 4 },
      ]);

      assert.equal(strategy.entryChannelHigh, 12);
      assert.equal(strategy.entryChannelLow, 5);
    },
  },
  {
    name: "volume average excludes the current bar and flags spikes from the completed bar",
    fn() {
      const strategy = createStrategy({
        volumeLookback: 2,
        volumeSpikeThreshold: 1.5,
        minBars: 1,
      });

      updateBars(strategy, [
        { close: 100, high: 100, low: 99, volume: 10 },
        { close: 101, high: 101, low: 100, volume: 20 },
        { close: 102, high: 102, low: 101, volume: 45 },
      ]);

      assert.equal(strategy.volumeAvg, 15);
      assert.equal(strategy.volumeSpike, true);
    },
  },
  {
    name: "volatility percent reflects ATR divided by the latest close",
    fn() {
      const strategy = createStrategy({ minBars: 1 });
      strategy.atr = 2.5;
      strategy.prices = [125];

      assert.equal(strategy._volatilityPct(), 2);
    },
  },
  {
    name: "close-confirmed breakout ignores tick price until the breakout bar is completed",
    fn() {
      const strategy = createStrategy({
        regimeEmaPeriod: 2,
        regimeSlopeLookback: 1,
        atrPeriod: 2,
        entryChannel: 2,
        exitChannel: 1,
        allowShorts: false,
        minBars: 2,
      });

      updateBars(strategy, [
        { close: 100, high: 100, low: 99 },
        { close: 101, high: 101, low: 100 },
      ]);

      const preCloseSignal = strategy.getSignal(150, []);
      assert.equal(preCloseSignal.action, "hold");
      assert.equal(preCloseSignal.reason, "no_breakout_signal");

      strategy.update({ close: 102, high: 102, low: 101, volume: 1, ts: 180_000 });
      const postCloseSignal = strategy.getSignal(102, []);
      assert.equal(postCloseSignal.action, "open");
      assert.equal(postCloseSignal.side, "long");
      assert.equal(postCloseSignal.reason, "breakout_long_entry");
    },
  },
  {
    name: "EMA slope gating blocks long breakouts when the regime slope is negative",
    fn() {
      const strategy = createStrategy({ allowShorts: false, minBars: 1 });
      strategy._ema = 100;
      strategy._emaSlope = -0.25;
      strategy.atr = 1;
      strategy.entryChannelHigh = 101;
      strategy.entryChannelLow = 99;
      strategy.prices = [100, 102];
      strategy.highs = [100, 102];
      strategy.lows = [99, 100];
      strategy.volumes = [1, 1];

      const entry = strategy._checkLongBreakoutEntry();
      assert.equal(entry, null);
      assert.equal(strategy._entryDebug.long.reason, "regime_blocked");
    },
  },
  {
    name: "breakout quality filter rejects long breakouts with weak close location",
    fn() {
      const strategy = createStrategy({
        allowShorts: false,
        minBars: 1,
        breakoutMinCloseLocation: 0.8,
      });
      strategy._ema = 100;
      strategy._emaSlope = 0.25;
      strategy.atr = 4;
      strategy.entryChannelHigh = 101;
      strategy.entryChannelLow = 99;
      strategy.prices = [100, 102];
      strategy.highs = [100, 104];
      strategy.lows = [99, 100];
      strategy.volumes = [10, 20];

      const entry = strategy._checkLongBreakoutEntry();
      assert.equal(entry, null);
      assert.equal(strategy._entryDebug.long.reason, "breakout_close_quality_too_weak");
    },
  },
  {
    name: "breakout quality filter rejects long breakouts with too little bar range versus ATR",
    fn() {
      const strategy = createStrategy({
        allowShorts: false,
        minBars: 1,
        breakoutMinBarRangeAtr: 0.5,
      });
      strategy._ema = 100;
      strategy._emaSlope = 0.25;
      strategy.atr = 4;
      strategy.entryChannelHigh = 101;
      strategy.entryChannelLow = 99;
      strategy.prices = [100, 102];
      strategy.highs = [100, 102];
      strategy.lows = [99, 101];
      strategy.volumes = [10, 20];

      const entry = strategy._checkLongBreakoutEntry();
      assert.equal(entry, null);
      assert.equal(strategy._entryDebug.long.reason, "breakout_range_too_small");
    },
  },
  {
    name: "breakout quality filter rejects long breakouts with low volume ratio",
    fn() {
      const strategy = createStrategy({
        allowShorts: false,
        minBars: 1,
        breakoutMinVolumeRatio: 1.5,
      });
      strategy._ema = 100;
      strategy._emaSlope = 0.25;
      strategy.atr = 2;
      strategy.entryChannelHigh = 101;
      strategy.entryChannelLow = 99;
      strategy.volumeAvg = 10;
      strategy.prices = [100, 102];
      strategy.highs = [100, 103];
      strategy.lows = [99, 101];
      strategy.volumes = [10, 12];

      const entry = strategy._checkLongBreakoutEntry();
      assert.equal(entry, null);
      assert.equal(strategy._entryDebug.long.reason, "breakout_volume_ratio_too_low");
    },
  },
  {
    name: "breakout quality filter also blocks pullback setup seeding from weak breakout bars",
    fn() {
      const strategy = createStrategy({
        allowShorts: false,
        minBars: 1,
        breakoutMinBreakDistanceAtr: 0.6,
      });
      strategy._ema = 100;
      strategy._emaSlope = 0.25;
      strategy.atr = 4;
      strategy.entryChannelHigh = 101;
      strategy.entryChannelLow = 98;
      strategy.prices = [100, 101.8];
      strategy.highs = [100, 102];
      strategy.lows = [99, 100];
      strategy.volumes = [10, 20];
      strategy._currentBarIndex = 5;

      const setup = strategy._detectLongBreakoutSetup();
      assert.equal(setup, null);
    },
  },
  {
    name: "hard stop uses the tighter of ATR and percent stop distances",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: true,
        hardStopPercent: 10,
        atrStopMult: 2.25,
        minBars: 1,
      });
      strategy.atr = 10;

      const result = strategy._checkHardStop(
        {
          side: "long",
          entryPrice: 100,
          leverage: 5,
        },
        98,
        -0.02
      );

      assert.equal(result.reason, "breakout_hard_stop");
      assert.equal(result.stopPrice, 98);
    },
  },
  {
    name: "hard stop uses entry ATR instead of drifting current ATR after entry",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: true,
        hardStopPercent: 0,
        atrStopMult: 2.25,
        minBars: 1,
      });

      strategy.atr = 20;

      const result = strategy._checkHardStop(
        {
          side: "long",
          entryPrice: 100,
          leverage: 3,
          atrAtEntry: 4,
        },
        91,
        -0.09
      );

      assert.equal(result.reason, "breakout_hard_stop");
      assert.equal(result.stopPrice, 91);
    },
  },
  {
    name: "skipHardStop prevents the catastrophic stop from closing the position",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: true,
        hardStopPercent: 10,
        atrStopMult: 2.25,
        enableAtrTrail: false,
        enableOppositeChannelExit: false,
        enableRegimeFailureExit: false,
        timeStopBars: 0,
        minBars: 1,
      });
      strategy.atr = 10;

      const result = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          leverage: 5,
          openBarIndex: 0,
        },
        98,
        null,
        { skipHardStop: true }
      );

      assert.equal(result, false);
    },
  },
  {
    name: "closePriceOverride drives close-based opposite-channel exits",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: false,
        enableAtrTrail: false,
        enableOppositeChannelExit: true,
        enableRegimeFailureExit: false,
        timeStopBars: 0,
        minBars: 1,
      });
      strategy.prices = [100];
      strategy.exitChannelLow = 99;

      const result = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          openBarIndex: 0,
        },
        105,
        null,
        { closePriceOverride: 98 }
      );

      assert.equal(result.reason, "breakout_opposite_channel");
      assert.equal(result.closePrice, 98);
    },
  },
  {
    name: "regime failure takes precedence over opposite-channel exits when both are true",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: false,
        enableAtrTrail: false,
        enableOppositeChannelExit: true,
        enableRegimeFailureExit: true,
        timeStopBars: 0,
        minBars: 1,
      });
      strategy.prices = [100];
      strategy._ema = 99;
      strategy.exitChannelLow = 100;

      const result = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          openBarIndex: 0,
        },
        101,
        null,
        { closePriceOverride: 98 }
      );

      assert.equal(result.reason, "breakout_regime_failure");
    },
  },
  {
    name: "breakout setup seeds fib swings from the latest confirmed pivot low when available",
    fn() {
      const strategy = createStrategy({
        fibSwingPivotStrength: 1,
        fibSwingLookbackBars: 12,
        allowShorts: false,
        minBars: 1,
      });

      strategy._ema = 106;
      strategy._emaSlope = 0.25;
      strategy.atr = 2;
      strategy.entryChannelHigh = 108;
      strategy.entryChannelLow = 101;
      strategy._currentBarIndex = 7;
      strategy.prices = [100, 99, 102, 104, 106, 107, 109];
      strategy.highs = [101, 100, 103, 105, 107, 108, 110];
      strategy.lows = [100, 98, 99, 101, 103, 105, 107];
      strategy.volumes = [1, 1, 1, 1, 1, 1, 1];
      strategy.timestamps = [1, 2, 3, 4, 5, 6, 7].map((n) => n * 60_000);

      const setup = strategy._detectLongBreakoutSetup();
      assert.equal(setup.swingAnchorSource, "confirmed_pivot_low");
      assert.equal(setup.swingAnchorArrayIndex, 1);
      assert.equal(setup.impulseLow, 98);
      assert.equal(setup.impulseHigh, 110);
      assert(approxEqual(setup.swingRangeAtr, 6, 1e-9));
    },
  },
  {
    name: "fib pullback entry triggers after a golden-pocket reclaim in an uptrend",
    fn() {
      const strategy = createStrategy({
        entryMode: "fib_pullback",
        allowShorts: false,
        minBars: 1,
      });

      strategy._ema = 102;
      strategy._emaSlope = 0.2;
      strategy.atr = 2;
      strategy.entryChannelHigh = 110;
      strategy.entryChannelLow = 100;
      strategy._currentBarIndex = 6;
      strategy.prices = [103, 104.2];
      strategy.highs = [110, 105];
      strategy.lows = [101, 103.7];
      strategy.volumes = [1, 1];
      strategy._setPullbackSetup("long", {
        breakoutBarIndex: 5,
        breakoutLevel: 110,
        impulseLow: 100,
        impulseHigh: 110,
        expiresBarIndex: 10,
      });

      const entry = strategy._checkLongFibPullbackEntry();
      assert.equal(entry.entryMode, "fib_pullback");
      assert(approxEqual(entry.fibPocketUpper, 103.82, 1e-6));
      assert(approxEqual(entry.fibPocketLower, 103.5, 1e-6));
      assert.equal(entry.close, 104.2);
    },
  },
  {
    name: "fib pullback invalidates setup when retrace pierces below the golden pocket",
    fn() {
      const strategy = createStrategy({
        entryMode: "fib_pullback",
        allowShorts: false,
        minBars: 1,
      });

      strategy._ema = 102;
      strategy._emaSlope = 0.2;
      strategy.atr = 2;
      strategy.entryChannelHigh = 110;
      strategy.entryChannelLow = 100;
      strategy._currentBarIndex = 6;
      strategy.prices = [103, 104];
      strategy.highs = [110, 105];
      strategy.lows = [101, 103.4];
      strategy.volumes = [1, 1];
      strategy._setPullbackSetup("long", {
        breakoutBarIndex: 5,
        breakoutLevel: 110,
        impulseLow: 100,
        impulseHigh: 110,
        expiresBarIndex: 10,
      });

      const entry = strategy._checkLongFibPullbackEntry();
      assert.equal(entry, null);
      assert.equal(strategy._entryDebug.long.reason, "fib_pullback_too_deep");
      assert.equal(strategy._getPullbackSetup("long"), null);
    },
  },
  {
    name: "fib retrace confluence accepts EMA and breakout support clustered inside the retrace zone",
    fn() {
      const strategy = createStrategy({
        entryMode: "fib_retrace",
        allowShorts: false,
        minBars: 1,
        fibMinConfluenceCount: 2,
        fibConfluenceToleranceAtr: 0.2,
        fibUseBreakoutLevelConfluence: true,
        fibUseEmaConfluence: true,
      });

      strategy._ema = 104.7;
      strategy._emaSlope = 0.2;
      strategy.atr = 2;
      strategy.entryChannelHigh = 110;
      strategy.entryChannelLow = 100;
      strategy._currentBarIndex = 6;
      strategy.prices = [110, 105.6];
      strategy.highs = [111, 106.2];
      strategy.lows = [109, 103.6];
      strategy.volumes = [1, 1];
      strategy._setPullbackSetup("long", {
        breakoutBarIndex: 5,
        breakoutLevel: 104.4,
        breakoutArrayIndex: 0,
        impulseLow: 100,
        impulseHigh: 110,
        swingAnchorSource: "confirmed_pivot_low",
        swingAnchorArrayIndex: 0,
        swingRangeAtr: 5,
        expiresBarIndex: 10,
      });

      const entry = strategy._checkLongFibRetraceEntry();
      assert.equal(entry.entryMode, "fib_retrace");
      assert.equal(entry.fibConfluenceCount, 2);
      assert.deepEqual(entry.fibConfluenceMatched, ["breakout_level", "ema"]);
    },
  },
  {
    name: "fib retrace confluence rejects entries when the enabled support cluster is missing",
    fn() {
      const strategy = createStrategy({
        entryMode: "fib_retrace",
        allowShorts: false,
        minBars: 1,
        fibMinConfluenceCount: 2,
        fibConfluenceToleranceAtr: 0.2,
        fibUseBreakoutLevelConfluence: true,
        fibUseEmaConfluence: true,
      });

      strategy._ema = 103.0;
      strategy._emaSlope = 0.2;
      strategy.atr = 2;
      strategy.entryChannelHigh = 110;
      strategy.entryChannelLow = 100;
      strategy._currentBarIndex = 6;
      strategy.prices = [110, 105.6];
      strategy.highs = [111, 106.2];
      strategy.lows = [109, 103.6];
      strategy.volumes = [1, 1];
      strategy._setPullbackSetup("long", {
        breakoutBarIndex: 5,
        breakoutLevel: 109.4,
        breakoutArrayIndex: 0,
        impulseLow: 100,
        impulseHigh: 110,
        swingAnchorSource: "confirmed_pivot_low",
        swingAnchorArrayIndex: 0,
        swingRangeAtr: 5,
        expiresBarIndex: 10,
      });

      const entry = strategy._checkLongFibRetraceEntry();
      assert.equal(entry, null);
      assert.equal(strategy._entryDebug.long.reason, "fib_confluence_missing");
    },
  },
  {
    name: "fib retrace can use anchored VWAP confluence from the swing anchor",
    fn() {
      const strategy = createStrategy({
        entryMode: "fib_retrace",
        allowShorts: false,
        minBars: 1,
        fibMinConfluenceCount: 1,
        fibConfluenceToleranceAtr: 0.2,
        fibUseAnchoredVwapConfluence: true,
        fibAnchoredVwapSource: "swing",
      });

      strategy._ema = 103;
      strategy._emaSlope = 0.2;
      strategy.atr = 2;
      strategy.entryChannelHigh = 110;
      strategy.entryChannelLow = 100;
      strategy._currentBarIndex = 6;
      strategy.prices = [99, 104.5, 105.0, 105.6];
      strategy.highs = [100, 105.0, 105.8, 106.2];
      strategy.lows = [98, 104.0, 104.4, 103.6];
      strategy.volumes = [1, 4, 3, 2];
      strategy._setPullbackSetup("long", {
        breakoutBarIndex: 5,
        breakoutLevel: 110,
        breakoutArrayIndex: 1,
        impulseLow: 100,
        impulseHigh: 110,
        swingAnchorSource: "confirmed_pivot_low",
        swingAnchorArrayIndex: 1,
        swingRangeAtr: 5,
        expiresBarIndex: 10,
      });

      const entry = strategy._checkLongFibRetraceEntry();
      assert.equal(entry.entryMode, "fib_retrace");
      assert.equal(entry.fibConfluenceCount, 1);
      assert.deepEqual(entry.fibConfluenceMatched, ["anchored_vwap"]);
    },
  },
  {
    name: "fib retrace entry triggers after a 38.2-61.8 retrace reclaims the 50% level",
    fn() {
      const strategy = createStrategy({
        entryMode: "fib_retrace",
        allowShorts: false,
        minBars: 1,
      });

      strategy._ema = 104;
      strategy._emaSlope = 0.2;
      strategy.atr = 2;
      strategy.entryChannelHigh = 110;
      strategy.entryChannelLow = 100;
      strategy._currentBarIndex = 6;
      strategy.prices = [110, 105.6];
      strategy.highs = [111, 106.2];
      strategy.lows = [109, 103.6];
      strategy.volumes = [1, 1];
      strategy._setPullbackSetup("long", {
        breakoutBarIndex: 5,
        breakoutLevel: 110,
        impulseLow: 100,
        impulseHigh: 110,
        expiresBarIndex: 10,
      });

      const entry = strategy._checkLongFibRetraceEntry();
      assert.equal(entry.entryMode, "fib_retrace");
      assert.equal(entry.fibTouchedDepth, "deep");
      assert(approxEqual(entry.fibRetraceShallow, 106.18, 1e-6));
      assert(approxEqual(entry.fibRetraceMid, 105, 1e-6));
      assert(approxEqual(entry.fibRetraceDeep, 103.82, 1e-6));
      assert(approxEqual(entry.fibRetraceInvalidation, 102.14, 1e-6));
      assert.equal(entry.close, 105.6);
    },
  },
  {
    name: "fib retrace entry rejects bars that touch the zone but fail to reclaim confirmation level",
    fn() {
      const strategy = createStrategy({
        entryMode: "fib_retrace",
        allowShorts: false,
        minBars: 1,
      });

      strategy._ema = 104;
      strategy._emaSlope = 0.2;
      strategy.atr = 2;
      strategy.entryChannelHigh = 110;
      strategy.entryChannelLow = 100;
      strategy._currentBarIndex = 6;
      strategy.prices = [110, 104.7];
      strategy.highs = [111, 105.5];
      strategy.lows = [109, 103.7];
      strategy.volumes = [1, 1];
      strategy._setPullbackSetup("long", {
        breakoutBarIndex: 5,
        breakoutLevel: 110,
        impulseLow: 100,
        impulseHigh: 110,
        expiresBarIndex: 10,
      });

      const entry = strategy._checkLongFibRetraceEntry();
      assert.equal(entry, null);
      assert.equal(strategy._entryDebug.long.reason, "fib_retrace_not_reclaimed");
    },
  },
  {
    name: "fib retrace invalidates setup when pullback breaches the 78.6 level",
    fn() {
      const strategy = createStrategy({
        entryMode: "fib_retrace",
        allowShorts: false,
        minBars: 1,
      });

      strategy._ema = 102;
      strategy._emaSlope = 0.2;
      strategy.atr = 2;
      strategy.entryChannelHigh = 110;
      strategy.entryChannelLow = 100;
      strategy._currentBarIndex = 6;
      strategy.prices = [110, 103];
      strategy.highs = [111, 104.2];
      strategy.lows = [109, 101.9];
      strategy.volumes = [1, 1];
      strategy._setPullbackSetup("long", {
        breakoutBarIndex: 5,
        breakoutLevel: 110,
        impulseLow: 100,
        impulseHigh: 110,
        expiresBarIndex: 10,
      });

      const entry = strategy._checkLongFibRetraceEntry();
      assert.equal(entry, null);
      assert.equal(strategy._entryDebug.long.reason, "fib_retrace_invalidated");
      assert.equal(strategy._getPullbackSetup("long"), null);
    },
  },
  {
    name: "regime failure mode two_closes_beyond_ema waits for a second adverse close",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: false,
        enableAtrTrail: false,
        enableOppositeChannelExit: false,
        enableRegimeFailureExit: true,
        regimeFailureMode: "two_closes_beyond_ema",
        timeStopBars: 0,
        minBars: 1,
      });

      strategy.prices = [105, 98];
      strategy._ema = 99;
      strategy._emaHistory = [100, 99];

      const firstCross = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          openBarIndex: 0,
        },
        98,
        null,
        { closePriceOverride: 98 }
      );
      assert.equal(firstCross, false);

      strategy.prices = [98, 97];
      strategy._ema = 98;
      strategy._emaHistory = [99, 98];

      const secondCross = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          openBarIndex: 0,
        },
        97,
        null,
        { closePriceOverride: 97 }
      );
      assert.equal(secondCross.reason, "breakout_regime_failure");
      assert.equal(secondCross.regimeFailureMode, "two_closes_beyond_ema");
    },
  },
  {
    name: "regime failure mode ema_cross_negative_slope requires adverse EMA slope",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: false,
        enableAtrTrail: false,
        enableOppositeChannelExit: false,
        enableRegimeFailureExit: true,
        regimeFailureMode: "ema_cross_negative_slope",
        timeStopBars: 0,
        minBars: 1,
      });

      strategy.prices = [101];
      strategy._ema = 100;
      strategy._emaHistory = [100];
      strategy._emaSlope = 0.05;

      const blocked = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          openBarIndex: 0,
        },
        99,
        null,
        { closePriceOverride: 99 }
      );
      assert.equal(blocked, false);

      strategy._emaSlope = -0.05;

      const triggered = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          openBarIndex: 0,
        },
        99,
        null,
        { closePriceOverride: 99 }
      );
      assert.equal(triggered.reason, "breakout_regime_failure");
      assert.equal(triggered.regimeFailureMode, "ema_cross_negative_slope");
    },
  },
  {
    name: "partial take profit triggers once price reaches the configured R multiple",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: true,
        hardStopPercent: 0,
        atrStopMult: 2,
        enableAtrTrail: false,
        enablePartialExit: true,
        partialAtR: 1,
        partialExitPercent: 50,
        enableOppositeChannelExit: false,
        enableRegimeFailureExit: false,
        timeStopBars: 0,
        minBars: 1,
      });

      const result = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          entryAtr: 5,
          atrAtEntry: 5,
          leverage: 1,
          tookPartial: false,
          openBarIndex: 0,
        },
        111,
        1,
        { closePriceOverride: 110 }
      );

      assert.equal(result.partial, true);
      assert.equal(result.reason, "breakout_partial_take_profit");
      assert.equal(result.percent, 50);
      assert(approxEqual(result.openProfitR, 1));
    },
  },
  {
    name: "partial take profit does not trigger before the configured R multiple",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: true,
        hardStopPercent: 0,
        atrStopMult: 2,
        enableAtrTrail: false,
        enablePartialExit: true,
        partialAtR: 1.5,
        partialExitPercent: 50,
        enableOppositeChannelExit: false,
        enableRegimeFailureExit: false,
        timeStopBars: 0,
        minBars: 1,
      });

      const result = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          entryAtr: 5,
          atrAtEntry: 5,
          leverage: 1,
          tookPartial: false,
          openBarIndex: 0,
        },
        108,
        1,
        { closePriceOverride: 108 }
      );

      assert.equal(result, false);
    },
  },
  {
    name: "skip flags suppress close-based strategy exits when lower-timeframe checkpoints own them",
    fn() {
      const strategy = createStrategy({
        hardStopEnabled: false,
        enableAtrTrail: false,
        enableOppositeChannelExit: true,
        enableRegimeFailureExit: true,
        regimeFailureMode: "ema_cross",
        timeStopBars: 1,
        minBars: 1,
      });
      strategy.prices = [100];
      strategy._ema = 99;
      strategy.exitChannelLow = 100;

      const result = strategy.shouldClose(
        {
          side: "long",
          entryPrice: 100,
          openBarIndex: 0,
        },
        101,
        2,
        {
          closePriceOverride: 98,
          skipTimeStop: true,
          skipRegimeFailure: true,
          skipOppositeChannel: true,
        }
      );

      assert.equal(result, false);
    },
  },
];

function runAllBtcBreakoutStrategyTests(options = {}) {
  const logger = options.logger ?? console.log;
  let passed = 0;

  for (const testCase of breakoutStrategyTestCases) {
    testCase.fn();
    passed++;
    if (logger) logger(`✅ ${testCase.name}`);
  }

  return { passed, total: breakoutStrategyTestCases.length };
}

if (require.main === module) {
  try {
    console.log("============================================================");
    console.log("BTC BREAKOUT STRATEGY - DETERMINISTIC TESTS");
    console.log("============================================================");
    const summary = runAllBtcBreakoutStrategyTests();
    console.log(
      `\n[OK] BTC breakout deterministic tests passed (${summary.passed}/${summary.total})`
    );
  } catch (error) {
    console.error(`\n[FAIL] BTC breakout deterministic tests failed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

module.exports = {
  breakoutStrategyTestCases,
  runAllBtcBreakoutStrategyTests,
};
