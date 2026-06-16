const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateEventSignal,
  normalizeEventModelConfig,
} = require("../../utils/copy-trading-event-model");

test("accepts strong entry events with full size", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        isEntryEvent: true,
        eventType: "open_long",
        activeContributors: 4,
        activeEffectiveN: 3.2,
        walletResolvedCount: 6,
        symbolResolvedCount: 4,
        walletQualityScore: 0.82,
        symbolSideQualityScore: 0.78,
        regimeReady: true,
        regimeAvailable: true,
        sideAlignedWithRecentReturn: true,
        trendStrength: 2.4,
        snapshotBacked: true,
        fillInferred: false,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.32,
        maxClusterWeightShare: 0.4,
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, "normal");
  assert.equal(result.sizeFraction, 1);
  assert.equal(result.score > 0.76, true);
});

test("rejects stale and concentrated events explicitly", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        isEntryEvent: true,
        eventType: "open_long",
        activeContributors: 3,
        activeEffectiveN: 1.5,
        walletResolvedCount: 5,
        symbolResolvedCount: 4,
        walletQualityScore: 0.8,
        symbolSideQualityScore: 0.72,
        regimeReady: true,
        regimeAvailable: true,
        sideAlignedWithRecentReturn: true,
        trendStrength: 1.8,
        snapshotBacked: false,
        fillInferred: true,
        staleStateDistanceMs: 10 * 60 * 60 * 1000,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.91,
        maxClusterWeightShare: 0.92,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.decision, "ignore");
  assert.deepEqual(result.reasons, [
    "state_too_stale",
    "concentration_hard_cap",
    "cluster_hard_cap",
  ]);
});

test("downweights acceptable but concentrated events", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        isEntryEvent: true,
        eventType: "flip_to_short",
        activeContributors: 2,
        activeEffectiveN: 1.8,
        walletResolvedCount: 3,
        symbolResolvedCount: 2,
        walletQualityScore: 0.66,
        symbolSideQualityScore: 0.63,
        regimeReady: false,
        regimeAvailable: true,
        sideAlignedWithRecentReturn: null,
        trendStrength: 0.7,
        snapshotBacked: true,
        fillInferred: false,
        staleStateDistanceMs: 30 * 60 * 1000,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.62,
        maxClusterWeightShare: 0.55,
      },
    },
    config: {
      eventRequireRegimeReady: false,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, "small");
  assert.equal(result.reasons.includes("soft_concentration_limit"), true);
  assert.equal(result.sizeFraction <= 0.5, true);
});

test("normalizes event slice allowlists from csv-style config", () => {
  const config = normalizeEventModelConfig({
    eventAllowedWallets: "0xabc, 0xdef ,0xabc",
    eventAllowedSymbols: "BTC, ETH ,BTC",
    eventAllowedSides: "short,long,short",
    eventAllowedEventTypes: "open_short,flip_to_short",
    eventAllowedRegimeBuckets: "up/low,flat/low",
  });

  assert.deepEqual(config.allowedWallets, ["0xabc", "0xdef"]);
  assert.deepEqual(config.allowedSymbols, ["BTC", "ETH"]);
  assert.deepEqual(config.allowedSides, ["short", "long"]);
  assert.deepEqual(config.allowedEventTypes, ["open_short", "flip_to_short"]);
  assert.deepEqual(config.allowedRegimeBuckets, ["up/low", "flat/low"]);
});

test("rejects events outside configured wallet filters", () => {
  const result = evaluateEventSignal({
    event: {
      wallet: "0xwallet_b",
      features: {
        wallet: "0xwallet_b",
        symbol: "BTC",
        side: "short",
        eventType: "open_short",
        isEntryEvent: true,
        activeContributors: 4,
        activeEffectiveN: 3,
        walletResolvedCount: 6,
        symbolResolvedCount: 4,
        walletQualityScore: 0.9,
        symbolSideQualityScore: 0.8,
        regimeReady: true,
        regimeAvailable: true,
        recentReturnBucket: "up",
        realizedVolBucket: "low",
        sideAlignedWithRecentReturn: false,
        trendStrength: 1.2,
        snapshotBacked: true,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.2,
        maxClusterWeightShare: 0.2,
      },
    },
    config: {
      eventAllowedWallets: ["0xwallet_a"],
      eventAllowedSymbols: ["BTC"],
      eventAllowedSides: ["short"],
      eventAllowedEventTypes: ["open_short"],
      eventAllowedRegimeBuckets: ["up/low"],
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["wallet_not_allowed"]);
});

test("rejects events outside configured slice filters", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        symbol: "BTC",
        side: "long",
        eventType: "open_long",
        isEntryEvent: true,
        activeContributors: 4,
        activeEffectiveN: 3,
        walletResolvedCount: 6,
        symbolResolvedCount: 4,
        walletQualityScore: 0.9,
        symbolSideQualityScore: 0.8,
        regimeReady: true,
        regimeAvailable: true,
        recentReturnBucket: "down",
        realizedVolBucket: "low",
        sideAlignedWithRecentReturn: false,
        trendStrength: 1.2,
        snapshotBacked: true,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.2,
        maxClusterWeightShare: 0.2,
      },
    },
    config: {
      eventAllowedSymbols: ["BTC"],
      eventAllowedSides: ["short"],
      eventAllowedEventTypes: ["open_short"],
      eventAllowedRegimeBuckets: ["up/low"],
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [
    "side_not_allowed",
    "event_type_not_allowed",
    "regime_bucket_not_allowed",
  ]);
});

test("rejects events when required market confluence is missing or misaligned", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        symbol: "ETH",
        side: "long",
        eventType: "open_long",
        isEntryEvent: true,
        activeContributors: 4,
        activeEffectiveN: 3,
        walletResolvedCount: 6,
        symbolResolvedCount: 4,
        walletQualityScore: 0.9,
        symbolSideQualityScore: 0.8,
        regimeReady: true,
        regimeAvailable: true,
        recentReturnBucket: "up",
        realizedVolBucket: "low",
        sideAlignedWithRecentReturn: true,
        trendStrength: 1.2,
        snapshotBacked: true,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.2,
        maxClusterWeightShare: 0.2,
        marketConfluenceAvailable: true,
        marketConfluenceAbsConsensus: 0.32,
        marketConfluenceContributors: 5,
        marketConfluenceEffectiveN: 2.4,
        marketConfluenceAligned: false,
      },
    },
    config: {
      eventRequireMarketConfluence: true,
      eventRequireMarketConfluenceAlignment: true,
      eventMinMarketConfluenceAbs: 0.1,
      eventMinMarketConfluenceContributors: 2,
      eventMinMarketConfluenceEffectiveN: 1,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["market_confluence_not_aligned"]);
});

test("incorporates aligned market confluence into accepted event scoring", () => {
  const withoutConfluence = evaluateEventSignal({
    event: {
      features: {
        isEntryEvent: true,
        eventType: "open_short",
        activeContributors: 4,
        activeEffectiveN: 3.2,
        walletResolvedCount: 6,
        symbolResolvedCount: 4,
        walletQualityScore: 0.82,
        symbolSideQualityScore: 0.78,
        regimeReady: true,
        regimeAvailable: true,
        sideAlignedWithRecentReturn: true,
        trendStrength: 2.4,
        snapshotBacked: true,
        fillInferred: false,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.32,
        maxClusterWeightShare: 0.4,
      },
    },
    config: {
      eventMarketConfluenceWeight: 0.2,
    },
  });
  const withConfluence = evaluateEventSignal({
    event: {
      features: {
        isEntryEvent: true,
        eventType: "open_short",
        activeContributors: 4,
        activeEffectiveN: 3.2,
        walletResolvedCount: 6,
        symbolResolvedCount: 4,
        walletQualityScore: 0.82,
        symbolSideQualityScore: 0.78,
        regimeReady: true,
        regimeAvailable: true,
        sideAlignedWithRecentReturn: true,
        trendStrength: 2.4,
        snapshotBacked: true,
        fillInferred: false,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.32,
        maxClusterWeightShare: 0.4,
        marketConfluenceAvailable: true,
        marketConfluenceAbsConsensus: 0.35,
        marketConfluenceContributors: 4,
        marketConfluenceEffectiveN: 2.2,
        marketConfluenceAligned: true,
      },
    },
    config: {
      eventRequireMarketConfluence: true,
      eventRequireMarketConfluenceAlignment: true,
      eventMinMarketConfluenceAbs: 0.1,
      eventMinMarketConfluenceContributors: 2,
      eventMinMarketConfluenceEffectiveN: 1,
      eventMarketConfluenceWeight: 0.2,
    },
  });

  assert.equal(withConfluence.ok, true);
  assert.equal(withConfluence.score > withoutConfluence.score, true);
});

test("rejects events when required cluster confluence is missing or misaligned", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        symbol: "BTC",
        side: "short",
        eventType: "open_short",
        isEntryEvent: true,
        activeContributors: 4,
        activeEffectiveN: 3,
        walletResolvedCount: 6,
        symbolResolvedCount: 4,
        walletQualityScore: 0.9,
        symbolSideQualityScore: 0.8,
        regimeReady: true,
        regimeAvailable: true,
        recentReturnBucket: "up",
        realizedVolBucket: "low",
        sideAlignedWithRecentReturn: false,
        trendStrength: 1.2,
        snapshotBacked: true,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.2,
        maxClusterWeightShare: 0.2,
        clusterConfluenceAvailable: true,
        clusterConfluenceAbsConsensus: 0.4,
        clusterConfluenceContributors: 2,
        clusterConfluenceEffectiveN: 1.5,
        clusterConfluenceAligned: false,
      },
    },
    config: {
      eventRequireClusterConfluence: true,
      eventRequireClusterConfluenceAlignment: true,
      eventMinClusterConfluenceAbs: 0.1,
      eventMinClusterConfluenceContributors: 2,
      eventMinClusterConfluenceEffectiveN: 1,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["cluster_confluence_not_aligned"]);
});

test("rejects low-copyability events when copyability filtering is enabled", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        symbol: "BTC",
        side: "long",
        eventType: "add_long",
        isEntryEvent: true,
        activeContributors: 2,
        activeEffectiveN: 1.2,
        walletResolvedCount: 6,
        symbolResolvedCount: 4,
        walletQualityScore: 0.9,
        symbolSideQualityScore: 0.8,
        regimeReady: true,
        regimeAvailable: true,
        recentReturnBucket: "up",
        realizedVolBucket: "low",
        sideAlignedWithRecentReturn: true,
        trendStrength: 1.2,
        snapshotBacked: false,
        fillInferred: true,
        referencePriceAvailable: false,
        staleStateDistanceMs: 5 * 60 * 60 * 1000,
        totalTradingCostBps: 14,
        activeMaxWeightShare: 0.8,
        maxClusterWeightShare: 0.85,
      },
    },
    config: {
      eventMinCopyabilityScore: 0.65,
      eventRequireRegimeReady: true,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["copyability_below_min"]);
});

test("rejects events without ex-source cluster confirmation when required", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        symbol: "BTC",
        side: "long",
        eventType: "open_long",
        isEntryEvent: true,
        activeContributors: 3,
        activeEffectiveN: 2.2,
        walletResolvedCount: 5,
        symbolResolvedCount: 4,
        walletQualityScore: 0.8,
        symbolSideQualityScore: 0.75,
        regimeReady: true,
        regimeAvailable: true,
        recentReturnBucket: "up",
        realizedVolBucket: "low",
        sideAlignedWithRecentReturn: true,
        trendStrength: 1.4,
        snapshotBacked: true,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 12,
        activeMaxWeightShare: 0.3,
        maxClusterWeightShare: 0.35,
        clusterConfluenceAvailable: true,
        clusterConfluenceAbsConsensus: 1,
        clusterConfluenceContributors: 1,
        clusterConfluenceEffectiveN: 1,
        clusterConfluenceAligned: true,
        clusterConfluenceExSourceAvailable: false,
        clusterConfluenceExSourceContributors: 0,
      },
    },
    config: {
      eventRequireClusterConfluence: true,
      eventRequireClusterExSourceAlignment: true,
      eventMinClusterPeerContributors: 1,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [
    "cluster_peer_contributors_below_min",
    "missing_cluster_peer_confluence",
  ]);
});

test("rejects stale peer copy lag and reference drift when configured", () => {
  const result = evaluateEventSignal({
    event: {
      features: {
        symbol: "BTC",
        side: "short",
        eventType: "open_short",
        isEntryEvent: true,
        activeContributors: 3,
        activeEffectiveN: 2.1,
        walletResolvedCount: 5,
        symbolResolvedCount: 4,
        walletQualityScore: 0.82,
        symbolSideQualityScore: 0.76,
        regimeReady: true,
        regimeAvailable: true,
        recentReturnBucket: "down",
        realizedVolBucket: "low",
        sideAlignedWithRecentReturn: true,
        trendStrength: 1.2,
        snapshotBacked: true,
        referencePriceAvailable: true,
        referenceDriftBps: 42,
        peerStateLagMs: 90 * 60 * 1000,
        sourceEventGapMs: 15 * 60 * 1000,
        clusterConfluenceAvailable: true,
        clusterConfluenceAbsConsensus: 0.7,
        clusterConfluenceContributors: 3,
        clusterConfluenceEffectiveN: 1.8,
        clusterConfluenceAligned: true,
        clusterConfluenceExSourceAvailable: true,
        clusterConfluenceExSourceAbsConsensus: 0.65,
        clusterConfluenceExSourceContributors: 2,
        clusterConfluenceExSourceEffectiveN: 1.4,
        clusterConfluenceExSourceAligned: true,
        staleStateDistanceMs: 0,
        totalTradingCostBps: 12,
        activeMaxWeightShare: 0.24,
        maxClusterWeightShare: 0.3,
      },
    },
    config: {
      eventMaxCopyLagMs: 30 * 60 * 1000,
      eventMaxReferenceDriftBps: 20,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["copy_lag_above_max", "reference_drift_above_max"]);
});
