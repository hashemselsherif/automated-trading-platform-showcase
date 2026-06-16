const test = require("node:test");
const assert = require("node:assert/strict");

const { createLeaderSelector } = require("../../utils/copy-trading-leader-selector");

function cand(address, score, extra = {}) {
  return {
    address,
    score,
    winRateLB: 0.6,
    trades: 50,
    targetFillRatio: 1,
    targetActivityDays: 10,
    expectancyUsd: 5,
    downsideDeviationUsd: 5,
    tradePnlConcentration: 0.2,
    tradeDayConcentration: 0.2,
    targetDrawdownPct: 15,
    persistenceScore: 0.7,
    positiveHalves: 2,
    lastFillAgeDays: 1,
    liquidationCount: 0,
    elite: false,
    ...extra,
  };
}

test("selector respects forceInclude and blocklist", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 3,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 999,
      maxChurnPerUpdate: 10,
    },
    {
      forceInclude: ["0xaaa"],
      blocklist: ["0xbbb"],
      weightMultipliers: {},
    }
  );

  const res = selector.update({
    nowMs: 1,
    candidates: [cand("0xaaa", 0.1), cand("0xbbb", 10), cand("0xccc", 0.9), cand("0xddd", 0.8)],
  });

  assert(res.topK.includes("0xaaa"));
  assert(!res.topK.includes("0xbbb"));
  assert.equal(res.topK.length, 3);
});

test("drop requires persistence runs and enforces cooldown", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 2,
      promoteThreshold: 0.55,
      dropThreshold: 0.45,
      dropPersistenceRuns: 2,
      cooldownDays: 7,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 999,
      maxChurnPerUpdate: 10,
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );

  // Start healthy -> active
  selector.update({ nowMs: 1, candidates: [cand("0xaaa", 0.8), cand("0xbbb", 0.7)] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "active");

  // First fail -> probation (not dropped yet)
  selector.update({ nowMs: 2, candidates: [cand("0xaaa", 0.4), cand("0xbbb", 0.7)] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "probation");

  // Second fail -> dropped + cooldown
  selector.update({ nowMs: 3, candidates: [cand("0xaaa", 0.4), cand("0xbbb", 0.7)] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "dropped");
  assert(selector.getState().wallets["0xaaa"].cooldownUntilMs > 3);

  // During cooldown, should remain dropped even if score recovers
  selector.update({ nowMs: 4, candidates: [cand("0xaaa", 0.9), cand("0xbbb", 0.7)] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "dropped");
});

test("maxChurnPerUpdate limits replacements", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 3,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 999,
      maxChurnPerUpdate: 1,
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );

  const r1 = selector.update({
    nowMs: 1,
    candidates: [cand("0xaaa", 0.9), cand("0xbbb", 0.8), cand("0xccc", 0.7)],
  });
  assert.deepEqual(new Set(r1.topK), new Set(["0xaaa", "0xbbb", "0xccc"]));

  // Many new candidates want to enter; churn limit should allow at most 1 replacement.
  const r2 = selector.update({
    nowMs: 2,
    candidates: [cand("0xddd", 1.0), cand("0xeee", 0.95), cand("0xfff", 0.9), cand("0xaaa", 0.9), cand("0xbbb", 0.8), cand("0xccc", 0.7)],
  });

  const prev = new Set(r1.topK);
  const next = new Set(r2.topK);
  const adds = [...next].filter((a) => !prev.has(a));
  const drops = [...prev].filter((a) => !next.has(a));
  assert(adds.length <= 1);
  assert(drops.length <= 1);
});

test("missing metrics transitions probation → dropped after persistence", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 2,
      dropPersistenceRuns: 2,
      cooldownDays: 7,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 999,
      maxChurnPerUpdate: 10,
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );

  selector.update({ nowMs: 1, candidates: [cand("0xaaa", 0.8), cand("0xbbb", 0.7)] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "active");

  // Wallet disappears from candidate set -> missing_metrics
  selector.update({ nowMs: 2, candidates: [cand("0xbbb", 0.7)] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "probation");
  assert.equal(selector.getState().wallets["0xaaa"].lastReason, "missing_metrics");

  // Missing again -> dropped + cooldown
  selector.update({ nowMs: 3, candidates: [cand("0xbbb", 0.7)] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "dropped");
  assert(selector.getState().wallets["0xaaa"].cooldownUntilMs > 3);
});

test("stale candidates become ineligible and can be dropped", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 1,
      dropPersistenceRuns: 2,
      cooldownDays: 7,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 7,
      maxChurnPerUpdate: 10,
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );

  selector.update({ nowMs: 1, candidates: [cand("0xaaa", 0.8, { lastFillAgeDays: 1 })] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "active");

  // Same wallet becomes stale -> ineligible -> probation.
  selector.update({ nowMs: 2, candidates: [cand("0xaaa", 0.8, { lastFillAgeDays: 999 })] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "probation");
  assert.equal(selector.getState().wallets["0xaaa"].lastReason, "ineligible");

  // Persist stale -> dropped.
  selector.update({ nowMs: 3, candidates: [cand("0xaaa", 0.8, { lastFillAgeDays: 999 })] });
  assert.equal(selector.getState().wallets["0xaaa"].status, "dropped");
});

test("rankMode=winrate selects by winRateLB (not raw score)", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 1,
      rankMode: "winrate",
      promoteThreshold: 0.55,
      dropThreshold: 0.45,
      dropPersistenceRuns: 2,
      cooldownDays: 0,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 999,
      maxChurnPerUpdate: 10,
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );

  const res = selector.update({
    nowMs: 1,
    candidates: [
      // Higher raw score but mediocre win-rate
      cand("0xaaa", 0.9, { winRateLB: 0.55 }),
      // Lower raw score but strong win-rate
      cand("0xbbb", 0.1, { winRateLB: 0.9 }),
    ],
  });

  assert.deepEqual(res.topK, ["0xbbb"]);
});

test("rankMode=quality downranks bursty concentrated candidates", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 1,
      rankMode: "quality",
      weightMode: "quality",
      promoteThreshold: 0.2,
      dropThreshold: 0.1,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 999,
      maxChurnPerUpdate: 10,
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );

  const res = selector.update({
    nowMs: 1,
    candidates: [
      cand("0xaaa", 0.95, {
        winRateLB: 0.92,
        expectancyUsd: 40,
        persistenceScore: 0.1,
        positiveHalves: 1,
        tradePnlConcentration: 0.92,
        tradeDayConcentration: 0.8,
        targetDrawdownPct: 110,
        downsideDeviationUsd: 80,
      }),
      cand("0xbbb", 0.55, {
        winRateLB: 0.74,
        expectancyUsd: 18,
        persistenceScore: 0.85,
        positiveHalves: 2,
        tradePnlConcentration: 0.2,
        tradeDayConcentration: 0.2,
        targetDrawdownPct: 18,
        downsideDeviationUsd: 12,
      }),
    ],
  });

  assert.deepEqual(res.topK, ["0xbbb"]);
});

test("selector enforces maxActiveWeightShare by capping dominant weights", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 3,
      rankMode: "quality",
      weightMode: "quality",
      promoteThreshold: 0,
      dropThreshold: 0,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 999,
      maxChurnPerUpdate: 10,
      maxActiveWeightShare: 0.4,
      minWeight: 0.01,
      maxWeight: 1,
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );

  const res = selector.update({
    nowMs: 1,
    candidates: [
      cand("0xaaa", 0.95, { expectancyUsd: 80, persistenceScore: 0.9 }),
      cand("0xbbb", 0.6, { expectancyUsd: 12, persistenceScore: 0.8 }),
      cand("0xccc", 0.55, { expectancyUsd: 10, persistenceScore: 0.75 }),
    ],
  });

  const weights = Array.from(res.weights.values());
  const maxShare = Math.max(...weights);
  const sum = weights.reduce((acc, value) => acc + value, 0);

  assert.equal(res.topK.length, 3);
  assert(Math.abs(sum - 1) < 1e-9);
  assert(maxShare <= 0.4000001);
});

test("selector skips highly correlated leaders when cluster caps are enabled", () => {
  const selector = createLeaderSelector(
    {
      topKSize: 2,
      rankMode: "quality",
      weightMode: "quality",
      promoteThreshold: 0,
      dropThreshold: 0,
      minTrades: 1,
      minTargetFillRatio: 0,
      minTargetActiveDays: 0,
      maxLastFillAgeDays: 999,
      maxChurnPerUpdate: 10,
      clusterCorrThreshold: 0.8,
      clusterMinOverlapDays: 4,
      maxClusterMembers: 1,
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );

  const res = selector.update({
    nowMs: 1,
    candidates: [
      cand("0xaaa", 0.9, {
        dailyPnlSeries: { 1: 10, 2: 8, 3: 12, 4: 9 },
      }),
      cand("0xbbb", 0.85, {
        dailyPnlSeries: { 1: 11, 2: 9, 3: 13, 4: 10 },
      }),
      cand("0xccc", 0.7, {
        dailyPnlSeries: { 1: -5, 2: 3, 3: -2, 4: 4 },
      }),
    ],
  });

  assert.deepEqual(res.topK, ["0xaaa", "0xccc"]);
});
