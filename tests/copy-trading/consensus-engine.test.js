const test = require("node:test");
const assert = require("node:assert/strict");

const { createCopyTradingConsensusEngine } = require("../../utils/copy-trading-consensus-engine");

function approx(x, y, eps = 1e-6) {
  assert(Math.abs(x - y) <= eps, `expected ${x} ≈ ${y}`);
}

test("consensus reflects weighted directions with staleness gating", () => {
  const engine = createCopyTradingConsensusEngine({
    staleMs: 60_000,
    minLeaders: 1,
    minEffectiveN: 0,
    convictionNotionalCapUsd: 50_000,
    convictionMinMult: 1,
    convictionMaxMult: 1,
    eliteEnabled: true,
    targetCoins: ["BTC", "ETH", "SOL"],
  });

  const topK = ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
  const weights = { [topK[0]]: 0.2 };
  const nowMs = 1700000000000;

  engine.ingestClearinghouseState(
    topK[0],
    {
      assetPositions: [
        { position: { coin: "BTC", szi: 1, positionValue: 10_000 } },
        { position: { coin: "ETH", szi: -1, positionValue: 8_000 } },
        { position: { coin: "SOL", szi: 1, positionValue: 5_000 } },
      ],
    },
    nowMs
  );

  const btc = engine.computeConsensusForSymbol({ coin: "BTC", topK, weights, nowMs, eliteSet: new Set([topK[0]]) });
  approx(btc.consensus, 1);
  assert.equal(btc.contributors, 1);
  assert.equal(btc.ok, true);

  const eth = engine.computeConsensusForSymbol({ coin: "ETH", topK, weights, nowMs, eliteSet: new Set([topK[0]]) });
  approx(eth.consensus, -1);
  assert.equal(eth.contributors, 1);

  const sol = engine.computeConsensusForSymbol({ coin: "SOL", topK, weights, nowMs, eliteSet: new Set([topK[0]]) });
  approx(sol.consensus, 1);
  assert.equal(sol.contributors, 1);

  // Make it stale -> excluded -> ok should fail.
  const staleNow = nowMs + 10 * 60_000;
  const btcStale = engine.computeConsensusForSymbol({ coin: "BTC", topK, weights, nowMs: staleNow, eliteSet: new Set([topK[0]]) });
  approx(btcStale.consensus, 0);
  assert.equal(btcStale.ok, false);
  assert.equal(btcStale.excluded.stale, 1);
});

test("elite path can be eligible when elite strong and not dominating", () => {
  const engine = createCopyTradingConsensusEngine({
    staleMs: 60_000,
    minLeaders: 3,
    minEffectiveN: 0,
    convictionMinMult: 1,
    convictionMaxMult: 1,
    eliteEnabled: true,
    eliteMinLeaders: 1,
    eliteMinConsensusAbs: 0.65,
    eliteMaxWeightShare: 0.6,
    targetCoins: ["BTC"],
  });

  const eliteUser = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const otherUser = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const now = 1700000000000;
  engine.ingestClearinghouseState(eliteUser, { assetPositions: [{ position: { coin: "BTC", szi: 1, positionValue: 10_000 } }] }, now);
  engine.ingestClearinghouseState(otherUser, { assetPositions: [{ position: { coin: "BTC", szi: -1, positionValue: 10_000 } }] }, now);

  const topK = [eliteUser, otherUser];
  const weights = { [eliteUser]: 0.2, [otherUser]: 0.4 }; // elite share = 0.33 <= 0.6
  const eliteSet = new Set([eliteUser]);

  const r = engine.computeConsensusForSymbol({ coin: "BTC", topK, weights, eliteSet, nowMs: now });
  assert.equal(r.ok, false); // minLeaders=3 not met
  assert.equal(r.elite.ok, true);
  approx(r.elite.consensus, 1);
});

test("consensus engine exposes concentration metrics for active leaders", () => {
  const engine = createCopyTradingConsensusEngine({
    staleMs: 60_000,
    minLeaders: 1,
    minEffectiveN: 0,
    convictionMinMult: 1,
    convictionMaxMult: 1,
    eliteEnabled: false,
    targetCoins: ["BTC"],
  });

  const now = 1700000000000;
  const leaderA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const leaderB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  engine.ingestClearinghouseState(
    leaderA,
    { assetPositions: [{ position: { coin: "BTC", szi: 1, positionValue: 10_000 } }] },
    now
  );
  engine.ingestClearinghouseState(
    leaderB,
    { assetPositions: [{ position: { coin: "BTC", szi: 1, positionValue: 10_000 } }] },
    now
  );

  const r = engine.computeConsensusForSymbol({
    coin: "BTC",
    topK: [leaderA, leaderB],
    weights: { [leaderA]: 0.8, [leaderB]: 0.2 },
    nowMs: now,
  });
  approx(r.maxWeightShare, 0.8);
  approx(r.hhi, 0.68);
  approx(r.longWeightShare, 1);
  approx(r.shortWeightShare, 0);
});

test("consensus engine exposes cluster and family metadata when available", () => {
  const engine = createCopyTradingConsensusEngine({
    staleMs: 60_000,
    minLeaders: 1,
    minEffectiveN: 0,
    convictionMinMult: 1,
    convictionMaxMult: 1,
    eliteEnabled: true,
    targetCoins: ["BTC"],
  });

  const now = 1700000000000;
  const leaderA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const leaderB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const leaderC = "0xcccccccccccccccccccccccccccccccccccccccc";
  for (const leader of [leaderA, leaderB, leaderC]) {
    engine.ingestClearinghouseState(
      leader,
      { assetPositions: [{ position: { coin: "BTC", szi: 1, positionValue: 10_000 } }] },
      now
    );
  }

  const r = engine.computeConsensusForSymbol({
    coin: "BTC",
    topK: [leaderA, leaderB, leaderC],
    weights: { [leaderA]: 0.6, [leaderB]: 0.3, [leaderC]: 0.1 },
    eliteSet: new Set([leaderA, leaderB]),
    leaderMetadata: {
      [leaderA]: { clusterId: "cluster-a", familyId: "family-a" },
      [leaderB]: { clusterId: "cluster-a", familyId: "family-a" },
      [leaderC]: { clusterId: "cluster-b", familyId: "family-b" },
    },
    nowMs: now,
  });

  assert.equal(r.clusterCount, 2);
  assert.equal(r.familyCount, 2);
  assert.equal(r.dominantCluster, "cluster-a");
  assert.equal(r.dominantFamily, "family-a");
  approx(r.maxClusterWeightShare, 0.9);
  approx(r.maxFamilyWeightShare, 0.9);
  assert.equal(r.elite.clusterCount, 1);
  assert.equal(r.elite.familyCount, 1);
  assert.equal(r.elite.dominantCluster, "cluster-a");
  assert.equal(r.elite.dominantFamily, "family-a");
  approx(r.elite.maxClusterWeightShare, 1);
  approx(r.elite.maxFamilyWeightShare, 1);
});

test("clearinghouse snapshots fully replace tracked symbol state", () => {
  const engine = createCopyTradingConsensusEngine({
    staleMs: 60_000,
    minLeaders: 1,
    minEffectiveN: 0,
    convictionMinMult: 1,
    convictionMaxMult: 1,
    eliteEnabled: false,
    targetCoins: ["BTC"],
  });

  const now = 1700000000000;
  const leader = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  engine.ingestClearinghouseState(
    leader,
    { assetPositions: [{ position: { coin: "BTC", szi: 1, positionValue: 10_000 } }] },
    now
  );
  assert.equal(engine.getWalletPosition(leader, "BTC")?.szi, 1);

  engine.ingestClearinghouseState(leader, { assetPositions: [] }, now + 5_000);
  assert.equal(engine.getWalletPosition(leader, "BTC"), null);
});
