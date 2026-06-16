const test = require("node:test");
const assert = require("node:assert/strict");

const CopyTradingMetaStrategy = require("../../src/strategies/copy-trading-meta-strategy");

test("meta strategy opens when consensus and leader summary both qualify", () => {
  const consensusProvider = () => ({
    cTop: 0.82,
    kTop: 6,
    cWorst: 0,
    kWorst: 0,
    meta: {
      ok: true,
      contributors: 6,
      effectiveN: 4.5,
      maxWeightShare: 0.24,
      hhi: 0.19,
      leaderSummary: {
        available: true,
        qualityScoreAvg: 0.78,
        freshnessDaysAvg: 1,
        targetFillRatioAvg: 0.8,
        marketFillShareAvg: 0.75,
        persistenceScoreAvg: 0.74,
        expectancyUsdAvg: 8,
        clusterCount: 3,
        maxClusterWeightShare: 0.3,
      },
    },
  });

  const strat = new CopyTradingMetaStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.4,
    minLeaders: 2,
    minEffectiveN: 1,
    confirmMs: 0,
    signalIntervalMs: 0,
  });

  const s1 = strat.getSignal(100, [], true, 0, { ts: 1700000000000 });
  const s2 = strat.getSignal(100, [], true, 0, { ts: 1700000000000 });

  assert.equal(s1.action, "hold");
  assert.equal(s1.reason, "confirming");
  assert.equal(s2.action, "open");
  assert.equal(s2.side, "long");
  assert.equal(s2.reason, "meta_normal");
  assert.equal(s2.sizeFraction, 1);
});

test("meta strategy blocks entries when meta filter rejects the leader set", () => {
  const consensusProvider = () => ({
    cTop: 0.8,
    kTop: 3,
    cWorst: 0,
    kWorst: 0,
    meta: {
      ok: true,
      contributors: 3,
      effectiveN: 1.4,
      maxWeightShare: 0.82,
      hhi: 0.76,
      leaderSummary: {
        available: true,
        qualityScoreAvg: 0.45,
        freshnessDaysAvg: 24,
        targetFillRatioAvg: 0.22,
        marketFillShareAvg: 0.18,
        persistenceScoreAvg: 0.1,
        expectancyUsdAvg: -3,
        clusterCount: 1,
        maxClusterWeightShare: 0.86,
      },
    },
  });

  const strat = new CopyTradingMetaStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.4,
    minLeaders: 2,
    minEffectiveN: 1,
    confirmMs: 0,
    signalIntervalMs: 0,
  });

  const signal = strat.getSignal(100, [], true, 0, { ts: 1700000000000 });
  assert.equal(signal.action, "hold");
  assert.match(signal.reason, /^meta_/);
});

test("meta strategy exits when follow score degrades below exit floor", () => {
  let stale = false;
  const consensusProvider = () => ({
    cTop: 0.72,
    kTop: 4,
    cWorst: 0,
    kWorst: 0,
    meta: {
      ok: true,
      contributors: 4,
      effectiveN: stale ? 1.1 : 3.2,
      maxWeightShare: stale ? 0.74 : 0.28,
      hhi: stale ? 0.7 : 0.2,
      leaderSummary: {
        available: true,
        qualityScoreAvg: stale ? 0.4 : 0.7,
        freshnessDaysAvg: stale ? 20 : 2,
        targetFillRatioAvg: stale ? 0.2 : 0.7,
        marketFillShareAvg: stale ? 0.2 : 0.65,
        persistenceScoreAvg: stale ? 0.15 : 0.68,
        expectancyUsdAvg: stale ? -2 : 6,
        clusterCount: 2,
        maxClusterWeightShare: stale ? 0.72 : 0.32,
      },
    },
  });

  const strat = new CopyTradingMetaStrategy({
    symbol: "BTC-PERP",
    consensusProvider,
    enterThreshold: 0.65,
    exitThreshold: 0.4,
    minLeaders: 2,
    minEffectiveN: 1,
    confirmMs: 0,
    signalIntervalMs: 0,
    metaExitScoreMin: 0.45,
  });

  stale = false;
  strat.getSignal(100, [], true, 0, { ts: 1700000000000 });
  strat.getSignal(100, [], true, 0, { ts: 1700000000000 });

  stale = true;
  const close = strat.shouldClose(
    { side: "long", entryPrice: 100, leverage: 1, openTime: 0 },
    101,
    { ts: 1700000001000, price: 101 }
  );

  assert.equal(close.shouldClose, true);
  assert.equal(close.reason, "meta_filter_exit");
});
