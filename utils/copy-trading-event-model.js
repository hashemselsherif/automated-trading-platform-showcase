"use strict";

const { normalizeSymbol } = require("./copy-trading-event-dataset");

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function normalizePercent(value, scale) {
  const denom = Math.max(1e-9, num(scale, 1));
  return clamp(num(value, 0) / denom, 0, 1);
}

function normalizeInverse(value, scale) {
  const denom = Math.max(1e-9, num(scale, 1));
  return clamp(1 - Math.tanh(Math.max(0, num(value, 0)) / denom), 0, 1);
}

function normalizeEventActionScore(features) {
  const eventType = String(features?.eventType || "");
  if (eventType === "open_long" || eventType === "open_short") return 1;
  if (eventType === "flip_to_long" || eventType === "flip_to_short") return 0.85;
  if (eventType === "add_long" || eventType === "add_short") return 0.6;
  if (eventType === "reduce_long" || eventType === "reduce_short") return 0.35;
  return 0;
}

function normalizeStringList(values, mapper = (value) => String(value || "").trim()) {
  const rawValues = Array.isArray(values)
    ? values
    : String(values || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  const normalized = rawValues.map(mapper).filter(Boolean);
  return normalized.filter((value, index) => normalized.indexOf(value) === index);
}

function normalizeSide(value) {
  const side = String(value || "")
    .trim()
    .toLowerCase();
  return side === "long" || side === "short" ? side : null;
}

function normalizeWallet(value) {
  const wallet = String(value || "")
    .trim()
    .toLowerCase();
  return wallet.startsWith("0x") ? wallet : null;
}

function getRegimeBucket(features = {}) {
  const trend = String(features.recentReturnBucket || "unknown");
  const vol = String(features.realizedVolBucket || "unknown");
  return `${trend}/${vol}`;
}

function normalizeEventModelConfig(options = {}) {
  const maxCopyLagMsRaw = num(options.eventMaxCopyLagMs, 0);
  const maxReferenceDriftBpsRaw = num(options.eventMaxReferenceDriftBps, 0);
  return {
    followScoreMin: clamp(num(options.eventFollowScoreMin, 0.56), 0, 1),
    fullSizeScoreMin: clamp(num(options.eventFullSizeScoreMin, 0.76), 0, 1),
    minActiveContributors: Math.max(1, num(options.eventMinActiveContributors, 2)),
    targetContributors: Math.max(1, num(options.eventTargetContributors, 4)),
    targetEffectiveN: Math.max(1, num(options.eventTargetEffectiveN, 2)),
    minWalletResolvedCount: Math.max(0, num(options.eventMinWalletResolvedCount, 1)),
    minSymbolResolvedCount: Math.max(0, num(options.eventMinSymbolResolvedCount, 1)),
    minWalletQualityScore: clamp(num(options.eventMinWalletQualityScore, 0.45), 0, 1),
    minSymbolQualityScore: clamp(num(options.eventMinSymbolQualityScore, 0.45), 0, 1),
    maxStaleStateMs: Math.max(1_000, num(options.eventMaxStaleStateMs, 6 * 60 * 60 * 1000)),
    requireRegimeReady: options.eventRequireRegimeReady === true,
    concentrationSoftCap: clamp(num(options.eventConcentrationSoftCap, 0.55), 0, 1),
    concentrationHardCap: clamp(num(options.eventConcentrationHardCap, 0.85), 0, 1),
    clusterSoftCap: clamp(num(options.eventClusterSoftCap, 0.7), 0, 1),
    clusterHardCap: clamp(num(options.eventClusterHardCap, 0.9), 0, 1),
    costScaleBps: Math.max(1, num(options.eventCostScaleBps, 20)),
    trendScale: Math.max(0.1, num(options.eventTrendScale, 2)),
    requireMarketConfluence: options.eventRequireMarketConfluence === true,
    requireMarketConfluenceAlignment: options.eventRequireMarketConfluenceAlignment === true,
    minMarketConfluenceAbs: clamp(num(options.eventMinMarketConfluenceAbs, 0), 0, 1),
    minMarketConfluenceContributors: Math.max(
      0,
      num(options.eventMinMarketConfluenceContributors, 0)
    ),
    minMarketConfluenceEffectiveN: Math.max(0, num(options.eventMinMarketConfluenceEffectiveN, 0)),
    requireClusterConfluence: options.eventRequireClusterConfluence === true,
    requireClusterConfluenceAlignment: options.eventRequireClusterConfluenceAlignment === true,
    requireClusterExSourceAlignment: options.eventRequireClusterExSourceAlignment === true,
    minClusterConfluenceAbs: clamp(num(options.eventMinClusterConfluenceAbs, 0), 0, 1),
    minClusterConfluenceContributors: Math.max(
      0,
      num(options.eventMinClusterConfluenceContributors, 0)
    ),
    minClusterPeerContributors: Math.max(0, num(options.eventMinClusterPeerContributors, 0)),
    minClusterConfluenceEffectiveN: Math.max(
      0,
      num(options.eventMinClusterConfluenceEffectiveN, 0)
    ),
    minCopyabilityScore: clamp(num(options.eventMinCopyabilityScore, 0), 0, 1),
    requireReferencePrice: options.eventRequireReferencePrice === true,
    maxCopyLagMs: maxCopyLagMsRaw > 0 ? Math.max(1_000, maxCopyLagMsRaw) : null,
    maxReferenceDriftBps:
      maxReferenceDriftBpsRaw > 0 ? Math.max(0.1, maxReferenceDriftBpsRaw) : null,
    allowedSymbols: normalizeStringList(options.eventAllowedSymbols, normalizeSymbol),
    allowedWallets: normalizeStringList(options.eventAllowedWallets, normalizeWallet),
    allowedSides: normalizeStringList(options.eventAllowedSides, normalizeSide),
    allowedEventTypes: normalizeStringList(options.eventAllowedEventTypes),
    allowedRegimeBuckets: normalizeStringList(options.eventAllowedRegimeBuckets),
    positiveWeights: {
      action: Math.max(0, num(options.eventActionWeight, 0.08)),
      walletQuality: Math.max(0, num(options.eventWalletQualityWeight, 0.22)),
      symbolQuality: Math.max(0, num(options.eventSymbolQualityWeight, 0.18)),
      breadth: Math.max(0, num(options.eventBreadthWeight, 0.12)),
      effectiveN: Math.max(0, num(options.eventEffectiveNWeight, 0.1)),
      regime: Math.max(0, num(options.eventRegimeWeight, 0.1)),
      trend: Math.max(0, num(options.eventTrendWeight, 0.08)),
      marketConfluence: Math.max(0, num(options.eventMarketConfluenceWeight, 0.12)),
      clusterConfluence: Math.max(0, num(options.eventClusterConfluenceWeight, 0.1)),
      copyability: Math.max(0, num(options.eventCopyabilityWeight, 0.08)),
      snapshot: Math.max(0, num(options.eventSnapshotWeight, 0.06)),
      stale: Math.max(0, num(options.eventStaleWeight, 0.04)),
      cost: Math.max(0, num(options.eventCostWeight, 0.02)),
    },
    penaltyWeights: {
      concentration: Math.max(0, num(options.eventConcentrationPenalty, 0.18)),
      cluster: Math.max(0, num(options.eventClusterPenalty, 0.1)),
    },
  };
}

function buildEventSignalFeatures(features = {}, config = {}) {
  const cfg = normalizeEventModelConfig(config);
  const actionScore = normalizeEventActionScore(features);
  const walletQualityScore = clamp(num(features.walletQualityScore, 0.5), 0, 1);
  const symbolQualityScore = clamp(
    num(
      features.symbolSideQualityScore,
      features.symbolQualityScore == null ? 0.5 : features.symbolQualityScore
    ),
    0,
    1
  );
  const breadthScore = normalizePercent(
    Math.min(num(features.activeContributors, 0), cfg.targetContributors),
    cfg.targetContributors
  );
  const effectiveNScore = normalizePercent(
    Math.min(num(features.activeEffectiveN, 0), cfg.targetEffectiveN),
    cfg.targetEffectiveN
  );
  const regimeReady = features.regimeReady === true;
  const trendStrengthScore = normalizePercent(num(features.trendStrength, 0), cfg.trendScale);
  const sideAligned = features.sideAlignedWithRecentReturn;
  const regimeScore =
    features.regimeAvailable === false
      ? 0.5
      : regimeReady
        ? sideAligned === false
          ? 0
          : sideAligned === true
            ? 0.5 + 0.5 * trendStrengthScore
            : 0.5
        : 0.25;
  const marketConfluenceAvailable = features.marketConfluenceAvailable === true;
  const marketConfluenceAbs = clamp(num(features.marketConfluenceAbsConsensus, 0), 0, 1);
  const marketConfluenceContributors = Math.max(0, num(features.marketConfluenceContributors, 0));
  const marketConfluenceEffectiveN = Math.max(0, num(features.marketConfluenceEffectiveN, 0));
  const marketConfluenceAligned =
    features.marketConfluenceAligned == null ? null : !!features.marketConfluenceAligned;
  const marketConfluenceScore = !marketConfluenceAvailable
    ? 0.5
    : marketConfluenceAligned === false
      ? 0
      : clamp(
          0.6 * marketConfluenceAbs +
            0.2 *
              normalizePercent(
                Math.min(marketConfluenceContributors, cfg.targetContributors),
                cfg.targetContributors
              ) +
            0.2 *
              normalizePercent(
                Math.min(marketConfluenceEffectiveN, cfg.targetEffectiveN),
                cfg.targetEffectiveN
              ),
          0,
          1
        );
  const clusterConfluenceAvailable = features.clusterConfluenceAvailable === true;
  const clusterConfluenceAbs = clamp(num(features.clusterConfluenceAbsConsensus, 0), 0, 1);
  const clusterConfluenceContributors = Math.max(0, num(features.clusterConfluenceContributors, 0));
  const clusterConfluenceEffectiveN = Math.max(0, num(features.clusterConfluenceEffectiveN, 0));
  const clusterConfluenceAligned =
    features.clusterConfluenceAligned == null ? null : !!features.clusterConfluenceAligned;
  const clusterConfluenceBaseScore = !clusterConfluenceAvailable
    ? 0.5
    : clusterConfluenceAligned === false
      ? 0
      : clamp(
          0.6 * clusterConfluenceAbs +
            0.2 *
              normalizePercent(
                Math.min(clusterConfluenceContributors, cfg.targetContributors),
                cfg.targetContributors
              ) +
            0.2 *
              normalizePercent(
                Math.min(clusterConfluenceEffectiveN, cfg.targetEffectiveN),
                cfg.targetEffectiveN
              ),
          0,
          1
        );
  const clusterPeerAvailable = features.clusterConfluenceExSourceAvailable === true;
  const clusterPeerAbs = clamp(num(features.clusterConfluenceExSourceAbsConsensus, 0), 0, 1);
  const clusterPeerContributors = Math.max(
    0,
    num(features.clusterConfluenceExSourceContributors, 0)
  );
  const clusterPeerEffectiveN = Math.max(0, num(features.clusterConfluenceExSourceEffectiveN, 0));
  const clusterPeerAligned =
    features.clusterConfluenceExSourceAligned == null
      ? null
      : !!features.clusterConfluenceExSourceAligned;
  const clusterPeerScore = !clusterPeerAvailable
    ? 0.05
    : clusterPeerAligned === false
      ? 0
      : clamp(
          0.6 * clusterPeerAbs +
            0.2 *
              normalizePercent(
                Math.min(clusterPeerContributors, cfg.targetContributors),
                cfg.targetContributors
              ) +
            0.2 *
              normalizePercent(
                Math.min(clusterPeerEffectiveN, cfg.targetEffectiveN),
                cfg.targetEffectiveN
              ),
          0,
          1
        );
  const clusterConfluenceScore = clusterConfluenceAvailable
    ? clamp(0.3 * clusterConfluenceBaseScore + 0.7 * clusterPeerScore, 0, 1)
    : clusterConfluenceBaseScore;
  const snapshotScore =
    features.snapshotBacked === true ? 1 : features.fillInferred === true ? 0.45 : 0.6;
  const staleScore =
    features.staleStateDistanceMs == null
      ? 0.5
      : normalizeInverse(num(features.staleStateDistanceMs, 0), cfg.maxStaleStateMs);
  const costScore = normalizeInverse(num(features.totalTradingCostBps, 0), cfg.costScaleBps);
  const referencePriceScore =
    features.referencePriceAvailable !== true
      ? 0
      : features.referenceDriftBps == null
        ? 0.55
        : clamp(
            0.35 +
              0.65 *
                normalizeInverse(
                  num(features.referenceDriftBps, 0),
                  cfg.maxReferenceDriftBps || Math.max(10, cfg.costScaleBps * 2)
                ),
            0,
            1
          );
  const stateQualityScore =
    features.snapshotBacked === true ? 1 : features.fillInferred === true ? 0.7 : 0.5;
  const crowdingScore = clamp(
    1 -
      0.5 * clamp(num(features.activeMaxWeightShare, 0), 0, 1) -
      0.5 * clamp(num(features.maxClusterWeightShare, 0), 0, 1),
    0,
    1
  );
  const peerLagScore =
    features.peerStateLagMs == null
      ? 0.45
      : normalizeInverse(num(features.peerStateLagMs, 0), cfg.maxCopyLagMs || cfg.maxStaleStateMs);
  const sourceCadenceScaleMs = 60 * 60 * 1000;
  const sourceCadenceScore =
    features.sourceEventGapMs == null
      ? 0.55
      : normalizePercent(
          Math.min(num(features.sourceEventGapMs, 0), sourceCadenceScaleMs),
          sourceCadenceScaleMs
        );
  const copyabilityScore = clamp(
    0.22 * referencePriceScore +
      0.18 * stateQualityScore +
      0.12 * staleScore +
      0.14 * crowdingScore +
      0.18 * clusterPeerScore +
      0.1 * peerLagScore +
      0.06 * sourceCadenceScore,
    0,
    1
  );
  const concentrationPenalty = normalizePercent(
    Math.max(0, num(features.activeMaxWeightShare, 0) - cfg.concentrationSoftCap),
    Math.max(1e-9, 1 - cfg.concentrationSoftCap)
  );
  const clusterPenalty = normalizePercent(
    Math.max(0, num(features.maxClusterWeightShare, 0) - cfg.clusterSoftCap),
    Math.max(1e-9, 1 - cfg.clusterSoftCap)
  );

  return {
    actionScore,
    walletQualityScore,
    symbolQualityScore,
    breadthScore,
    effectiveNScore,
    regimeScore,
    trendStrengthScore,
    marketConfluenceScore,
    clusterConfluenceScore,
    clusterPeerScore,
    copyabilityScore,
    snapshotScore,
    staleScore,
    costScore,
    concentrationPenalty,
    clusterPenalty,
  };
}

function scoreEventSignal(features = {}, config = {}) {
  const cfg = normalizeEventModelConfig(config);
  const normalized = buildEventSignalFeatures(features, cfg);
  const pw = cfg.positiveWeights;
  const nw = cfg.penaltyWeights;

  const positive =
    normalized.actionScore * pw.action +
    normalized.walletQualityScore * pw.walletQuality +
    normalized.symbolQualityScore * pw.symbolQuality +
    normalized.breadthScore * pw.breadth +
    normalized.effectiveNScore * pw.effectiveN +
    normalized.regimeScore * pw.regime +
    normalized.trendStrengthScore * pw.trend +
    normalized.marketConfluenceScore * pw.marketConfluence +
    normalized.clusterConfluenceScore * pw.clusterConfluence +
    normalized.copyabilityScore * pw.copyability +
    normalized.snapshotScore * pw.snapshot +
    normalized.staleScore * pw.stale +
    normalized.costScore * pw.cost;
  const penalty =
    normalized.concentrationPenalty * nw.concentration + normalized.clusterPenalty * nw.cluster;
  const maxPositive = Object.values(pw).reduce((sum, value) => sum + value, 0);

  return {
    score: maxPositive > 0 ? clamp((positive - penalty) / maxPositive, 0, 1) : 0,
    normalized,
  };
}

function evaluateEventSignal({ event, config = {} }) {
  const cfg = normalizeEventModelConfig(config);
  const features =
    event?.features && typeof event.features === "object" ? event.features : event || {};
  const reasons = [];
  const symbol = normalizeSymbol(features.symbol || event?.symbol || event?.coin);
  const wallet = normalizeWallet(features.wallet || event?.wallet || event?.user);
  const side = normalizeSide(features.side || event?.side);
  const eventType = String(features.eventType || event?.eventType || "");
  const regimeBucket = getRegimeBucket(features);

  if (features.isEntryEvent === false) reasons.push("non_entry_event");
  if (cfg.allowedSymbols.length && !cfg.allowedSymbols.includes(symbol)) {
    reasons.push("symbol_not_allowed");
  }
  if (cfg.allowedWallets.length && !cfg.allowedWallets.includes(wallet)) {
    reasons.push("wallet_not_allowed");
  }
  if (cfg.allowedSides.length && !cfg.allowedSides.includes(side)) {
    reasons.push("side_not_allowed");
  }
  if (cfg.allowedEventTypes.length && !cfg.allowedEventTypes.includes(eventType)) {
    reasons.push("event_type_not_allowed");
  }
  if (cfg.allowedRegimeBuckets.length && !cfg.allowedRegimeBuckets.includes(regimeBucket)) {
    reasons.push("regime_bucket_not_allowed");
  }
  if (num(features.activeContributors, 0) < cfg.minActiveContributors) {
    reasons.push("min_active_contributors");
  }
  if (num(features.walletResolvedCount, 0) < cfg.minWalletResolvedCount) {
    reasons.push("min_wallet_history");
  }
  if (num(features.symbolResolvedCount, 0) < cfg.minSymbolResolvedCount) {
    reasons.push("min_symbol_history");
  }
  if (num(features.walletQualityScore, 0) < cfg.minWalletQualityScore) {
    reasons.push("wallet_quality_below_min");
  }
  if (
    num(features.symbolSideQualityScore ?? features.symbolQualityScore, 0) <
    cfg.minSymbolQualityScore
  ) {
    reasons.push("symbol_quality_below_min");
  }
  if (
    features.staleStateDistanceMs != null &&
    num(features.staleStateDistanceMs, 0) > cfg.maxStaleStateMs
  ) {
    reasons.push("state_too_stale");
  }
  if (
    Number.isFinite(num(features.activeMaxWeightShare, null)) &&
    num(features.activeMaxWeightShare, 0) > cfg.concentrationHardCap
  ) {
    reasons.push("concentration_hard_cap");
  }
  if (
    Number.isFinite(num(features.maxClusterWeightShare, null)) &&
    num(features.maxClusterWeightShare, 0) > cfg.clusterHardCap
  ) {
    reasons.push("cluster_hard_cap");
  }
  if (cfg.requireRegimeReady && features.regimeReady !== true) {
    reasons.push("regime_not_ready");
  }
  if (cfg.requireReferencePrice && features.referencePriceAvailable !== true) {
    reasons.push("missing_reference_price");
  }
  if (cfg.requireMarketConfluence && features.marketConfluenceAvailable !== true) {
    reasons.push("missing_market_confluence");
  }
  if (
    features.marketConfluenceAvailable === true &&
    num(features.marketConfluenceAbsConsensus, 0) < cfg.minMarketConfluenceAbs
  ) {
    reasons.push("market_confluence_below_min");
  }
  if (
    features.marketConfluenceAvailable === true &&
    num(features.marketConfluenceContributors, 0) < cfg.minMarketConfluenceContributors
  ) {
    reasons.push("market_confluence_contributors_below_min");
  }
  if (
    features.marketConfluenceAvailable === true &&
    num(features.marketConfluenceEffectiveN, 0) < cfg.minMarketConfluenceEffectiveN
  ) {
    reasons.push("market_confluence_effective_n_below_min");
  }
  if (
    cfg.requireMarketConfluenceAlignment &&
    features.marketConfluenceAvailable === true &&
    features.marketConfluenceAligned === false
  ) {
    reasons.push("market_confluence_not_aligned");
  }
  if (cfg.requireClusterConfluence && features.clusterConfluenceAvailable !== true) {
    reasons.push("missing_cluster_confluence");
  }
  if (
    features.clusterConfluenceAvailable === true &&
    num(features.clusterConfluenceAbsConsensus, 0) < cfg.minClusterConfluenceAbs
  ) {
    reasons.push("cluster_confluence_below_min");
  }
  if (
    features.clusterConfluenceAvailable === true &&
    num(features.clusterConfluenceContributors, 0) < cfg.minClusterConfluenceContributors
  ) {
    reasons.push("cluster_confluence_contributors_below_min");
  }
  if (
    features.clusterConfluenceAvailable === true &&
    num(features.clusterConfluenceEffectiveN, 0) < cfg.minClusterConfluenceEffectiveN
  ) {
    reasons.push("cluster_confluence_effective_n_below_min");
  }
  if (
    num(features.clusterConfluenceExSourceContributors ?? features.clusterConfluencePeerCount, 0) <
    cfg.minClusterPeerContributors
  ) {
    reasons.push("cluster_peer_contributors_below_min");
  }
  if (
    cfg.requireClusterConfluenceAlignment &&
    features.clusterConfluenceAvailable === true &&
    features.clusterConfluenceAligned === false
  ) {
    reasons.push("cluster_confluence_not_aligned");
  }
  if (cfg.requireClusterExSourceAlignment && features.clusterConfluenceExSourceAvailable !== true) {
    reasons.push("missing_cluster_peer_confluence");
  }
  if (
    cfg.requireClusterExSourceAlignment &&
    features.clusterConfluenceExSourceAvailable === true &&
    features.clusterConfluenceExSourceAligned !== true
  ) {
    reasons.push("cluster_peer_confluence_not_aligned");
  }
  if (
    cfg.maxCopyLagMs != null &&
    features.peerStateLagMs != null &&
    num(features.peerStateLagMs, 0) > cfg.maxCopyLagMs
  ) {
    reasons.push("copy_lag_above_max");
  }
  if (
    cfg.maxReferenceDriftBps != null &&
    features.referenceDriftBps != null &&
    num(features.referenceDriftBps, 0) > cfg.maxReferenceDriftBps
  ) {
    reasons.push("reference_drift_above_max");
  }

  const { score, normalized } = scoreEventSignal(features, cfg);
  if (normalized.copyabilityScore < cfg.minCopyabilityScore) {
    reasons.push("copyability_below_min");
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      decision: "ignore",
      score,
      sizeFraction: 0,
      reasons,
      normalized,
      features,
    };
  }

  if (score < cfg.followScoreMin) {
    return {
      ok: false,
      decision: "ignore",
      score,
      sizeFraction: 0,
      reasons: ["score_below_follow_min"],
      normalized,
      features,
    };
  }

  const softLimited =
    num(features.activeMaxWeightShare, 0) > cfg.concentrationSoftCap ||
    num(features.maxClusterWeightShare, 0) > cfg.clusterSoftCap;

  if (score >= cfg.fullSizeScoreMin && !softLimited) {
    return {
      ok: true,
      decision: "normal",
      score,
      sizeFraction: 1,
      reasons: [],
      normalized,
      features,
    };
  }

  const span = Math.max(1e-9, cfg.fullSizeScoreMin - cfg.followScoreMin);
  const progress = clamp((score - cfg.followScoreMin) / span, 0, 1);
  const baseFraction = 0.35 + 0.45 * progress;
  return {
    ok: true,
    decision: "small",
    score,
    sizeFraction: softLimited ? Math.min(baseFraction, 0.5) : baseFraction,
    reasons: softLimited ? ["soft_concentration_limit"] : [],
    normalized,
    features,
  };
}

module.exports = {
  buildEventSignalFeatures,
  evaluateEventSignal,
  getRegimeBucket,
  normalizeEventModelConfig,
  scoreEventSignal,
};
