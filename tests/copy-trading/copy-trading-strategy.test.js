const test = require("node:test");
const assert = require("node:assert/strict");

const CopyTradingStrategy = require("../../copy-trading-strategy");

test("elite-used consensus bypasses strategy minLeaders gating", () => {
  const consensusProvider = () => ({
    cTop: 0.9,
    kTop: 1,
    cWorst: 0,
    kWorst: 0,
    meta: { ok: true, eliteUsed: true },
  });

  const strat = new CopyTradingStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.55,
    minLeaders: 7,
    confirmMs: 0,
    signalIntervalMs: 0,
    safeModeOnStale: true,
  });

  const ctx = { ts: 1700000000000 };
  const s1 = strat.getSignal(100, [], true, 0, ctx);
  assert.equal(s1.action, "hold");
  assert.equal(s1.reason, "confirming");

  const s2 = strat.getSignal(100, [], true, 0, ctx);
  assert.equal(s2.action, "open");
  assert.equal(s2.side, "long");
  assert.equal(s2.reason, "follow_top_elite");
});

test("non-elite consensus still respects strategy minLeaders gating", () => {
  const consensusProvider = () => ({
    cTop: 0.9,
    kTop: 1,
    cWorst: 0,
    kWorst: 0,
    meta: { ok: true, eliteUsed: false },
  });

  const strat = new CopyTradingStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.55,
    minLeaders: 7,
    confirmMs: 0,
    signalIntervalMs: 0,
    safeModeOnStale: true,
  });

  const ctx = { ts: 1700000000000 };
  const s = strat.getSignal(100, [], true, 0, ctx);
  assert.equal(s.action, "hold");
  assert.equal(s.reason, "leaders_below_min");
});

test("fade worst is disabled by default", () => {
  const consensusProvider = () => ({
    cTop: 0.2,
    kTop: 3,
    cWorst: -0.9,
    kWorst: 5,
    meta: { ok: true, eliteUsed: false, contributors: 3, effectiveN: 3, maxWeightShare: 0.2 },
  });

  const strat = new CopyTradingStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.55,
    minLeaders: 2,
    confirmMs: 0,
    signalIntervalMs: 0,
  });

  const out = strat.getSignal(100, [], true, 0, { ts: 1700000000000 });
  assert.equal(out.action, "hold");
  assert.equal(out.reason, "no_edge");
});

test("side-specific gates and concentration veto apply before entry", () => {
  let direction = "long";
  const consensusProvider = () => ({
    cTop: direction === "long" ? 0.8 : -0.8,
    kTop: direction === "long" ? 4 : 2,
    cWorst: 0,
    kWorst: 0,
    meta: {
      ok: true,
      eliteUsed: false,
      contributors: direction === "long" ? 4 : 2,
      effectiveN: direction === "long" ? 3.5 : 1.5,
      maxWeightShare: direction === "long" ? 0.75 : 0.45,
    },
  });

  const strat = new CopyTradingStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    longEnterThreshold: 0.7,
    shortEnterThreshold: 0.7,
    longMinLeaders: 3,
    shortMinLeaders: 2,
    longMinEffectiveN: 2,
    shortMinEffectiveN: 1,
    longSignalMaxActiveWeightShare: 0.6,
    shortSignalMaxActiveWeightShare: 0.5,
    confirmMs: 0,
    signalIntervalMs: 0,
    safeModeOnStale: true,
  });

  const blocked = strat.getSignal(100, [], true, 0, { ts: 1700000000000 });
  assert.equal(blocked.action, "hold");
  assert.equal(blocked.reason, "leader_concentration");

  direction = "short";
  const s1 = strat.getSignal(100, [], true, 0, { ts: 1700000001000 });
  const s2 = strat.getSignal(100, [], true, 0, { ts: 1700000001000 });
  assert.equal(s1.action, "hold");
  assert.equal(s1.reason, "confirming");
  assert.equal(s2.action, "open");
  assert.equal(s2.side, "short");
});

test("cluster and family concentration gates veto consensus even when wallet concentration is acceptable", () => {
  let mode = "cluster";
  const consensusProvider = () => ({
    cTop: 0.84,
    kTop: 3,
    cWorst: 0,
    kWorst: 0,
    meta: {
      ok: true,
      eliteUsed: false,
      contributors: 3,
      effectiveN: 2.4,
      maxWeightShare: 0.46,
      maxClusterWeightShare: mode === "cluster" ? 0.74 : 0.42,
      maxFamilyWeightShare: mode === "family" ? 0.81 : 0.44,
    },
  });

  const strat = new CopyTradingStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.4,
    minLeaders: 2,
    minEffectiveN: 1,
    signalMaxActiveWeightShare: 0.6,
    signalMaxClusterWeightShare: 0.7,
    maxLeaderFamilyWeightShare: 0.75,
    confirmMs: 0,
    signalIntervalMs: 0,
  });

  const clusterBlocked = strat.getSignal(100, [], true, 0, { ts: 1700000000000 });
  assert.equal(clusterBlocked.action, "hold");
  assert.equal(clusterBlocked.reason, "leader_cluster_concentration");

  mode = "family";
  const familyBlocked = strat.getSignal(100, [], true, 0, { ts: 1700000001000 });
  assert.equal(familyBlocked.action, "hold");
  assert.equal(familyBlocked.reason, "leader_family_concentration");
});

test("regime filter blocks misaligned longs and closes positions when regime breaks", () => {
  let direction = "long";
  const consensusProvider = () => ({
    cTop: direction === "long" ? 0.9 : -0.9,
    kTop: 3,
    cWorst: 0,
    kWorst: 0,
    meta: {
      ok: true,
      eliteUsed: false,
      contributors: 3,
      effectiveN: 2.5,
      maxWeightShare: 0.3,
    },
  });

  const strat = new CopyTradingStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.4,
    minLeaders: 2,
    minEffectiveN: 1,
    confirmMs: 0,
    signalIntervalMs: 0,
    regimeFilterEnabled: true,
    regimeRequireReady: true,
    regimeLookbackBars: 5,
    regimeMinTrendStrength: 0.1,
    longMinTrendReturnPct: 0.1,
    shortMinTrendReturnPct: 0.1,
    regimeMinVolPct: 0,
    regimeMaxVolPct: 10,
  });

  [100, 99, 98, 97, 96, 95].forEach((close) => {
    strat.update({ high: close + 1, low: close - 1, close });
  });

  const blocked = strat.getSignal(95, [], true, 0, { ts: 1700000000000 });
  assert.equal(blocked.action, "hold");
  assert.equal(blocked.reason, "regime_long_misaligned");

  direction = "short";
  const s1 = strat.getSignal(95, [], true, 0, { ts: 1700000001000 });
  const s2 = strat.getSignal(95, [], true, 0, { ts: 1700000001000 });
  assert.equal(s1.action, "hold");
  assert.equal(s1.reason, "confirming");
  assert.equal(s2.action, "open");
  assert.equal(s2.side, "short");

  [96, 97, 98, 99, 100, 101].forEach((close) => {
    strat.update({ high: close + 1, low: close - 1, close });
  });

  direction = "short";
  const close = strat.shouldClose({ side: "short", entryPrice: 95, leverage: 1 }, 101, {
    ts: 1700000002000,
    price: 101,
  });
  assert.equal(close.shouldClose, true);
  assert.equal(close.reason, "regime_short_misaligned");
});

test("time stop and adverse move stop close positions before consensus exits", () => {
  const consensusProvider = () => ({
    cTop: 0.9,
    kTop: 3,
    cWorst: 0,
    kWorst: 0,
    meta: {
      ok: true,
      eliteUsed: false,
      contributors: 3,
      effectiveN: 3,
      maxWeightShare: 0.2,
    },
  });

  const strat = new CopyTradingStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.4,
    minLeaders: 2,
    confirmMs: 0,
    signalIntervalMs: 0,
    maxHoldHours: 1,
    adverseMoveStopPercent: 5,
  });

  const adverse = strat.shouldClose(
    { side: "long", entryPrice: 100, leverage: 1, openTime: 0 },
    94,
    { ts: 1_000, price: 94 }
  );
  assert.equal(adverse.shouldClose, true);
  assert.equal(adverse.reason, "copy_adverse_move_stop");

  const timed = strat.shouldClose(
    { side: "short", entryPrice: 100, leverage: 1, openTime: 0 },
    99,
    { ts: 3_600_000 + 1, price: 99 }
  );
  assert.equal(timed.shouldClose, true);
  assert.equal(timed.reason, "copy_time_stop");
});

test("follower-owned exits support breakeven and armed trailing stop", () => {
  const strat = new CopyTradingStrategy({
    symbol: "BTC-PERP",
    followerOwnedExitMode: true,
    trailingStopPercent: 10,
    trailActivateAfterProfitPercent: 5,
    breakevenAfterHours: 1,
  });

  const notArmed = strat.shouldClose(
    {
      side: "long",
      entryPrice: 100,
      leverage: 1,
      openTime: 0,
      highWaterMark: 103,
      lowWaterMark: 100,
    },
    92,
    { ts: 1_000, price: 92 }
  );
  assert.equal(notArmed.shouldClose, false);

  const trailing = strat.shouldClose(
    {
      side: "long",
      entryPrice: 100,
      leverage: 1,
      openTime: 0,
      highWaterMark: 120,
      lowWaterMark: 100,
    },
    107,
    { ts: 2_000, price: 107 }
  );
  assert.equal(trailing.shouldClose, true);
  assert.equal(trailing.reason, "copy_trailing_stop");

  const breakeven = strat.shouldClose(
    {
      side: "short",
      entryPrice: 100,
      leverage: 1,
      openTime: 0,
      highWaterMark: 100,
      lowWaterMark: 90,
    },
    101,
    { ts: 3_600_000 + 1, price: 101 }
  );
  assert.equal(breakeven.shouldClose, true);
  assert.equal(breakeven.reason, "copy_breakeven_stop");
});
