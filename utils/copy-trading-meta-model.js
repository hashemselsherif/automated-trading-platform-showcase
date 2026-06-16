"use strict";

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function normalizePercent(value, divisor) {
  if (!Number.isFinite(value) || !(divisor > 0)) return 0;
  return clamp(value / divisor, 0, 1);
}

function normalizeExpectancy(expectancyUsd, scaleUsd) {
  const scale = Math.max(1e-9, num(scaleUsd, 10));
  const raw = num(expectancyUsd, 0) / scale;
  return clamp(0.5 + Math.atan(raw) / Math.PI, 0, 1);
}

function normalizeMetaDecisionConfig(options = {}) {
  const positiveWeights = {
    consensus: Math.max(0, num(options.metaConsensusWeight, 0.18)),
    quality: Math.max(0, num(options.metaQualityWeight, 0.16)),
    freshness: Math.max(0, num(options.metaFreshnessWeight, 0.14)),
    relevance: Math.max(0, num(options.metaRelevanceWeight, 0.12)),
    persistence: Math.max(0, num(options.metaPersistenceWeight, 0.12)),
    breadth: Math.max(0, num(options.metaBreadthWeight, 0.1)),
    effectiveN: Math.max(0, num(options.metaEffectiveNWeight, 0.1)),
    expectancy: Math.max(0, num(options.metaExpectancyWeight, 0.08)),
    regime: Math.max(0, num(options.metaRegimeWeight, 0.08)),
  };
  const penaltyWeights = {
    maxWeightShare: Math.max(0, num(options.metaMaxWeightSharePenalty, 0.18)),
    clusterWeightShare: Math.max(0, num(options.metaClusterWeightSharePenalty, 0.12)),
    hhi: Math.max(0, num(options.metaHhiPenalty, 0.08)),
  };
  return {
    followScoreMin: clamp(num(options.metaFollowScoreMin, 0.5), 0, 1),
    fullSizeScoreMin: clamp(num(options.metaFullSizeScoreMin, 0.7), 0, 1),
    exitScoreMin: clamp(num(options.metaExitScoreMin, 0.42), 0, 1),
    smallSizeFraction: clamp(num(options.metaSmallSizeFraction, 0.55), 0.05, 1),
    downweightSizeFraction: clamp(num(options.metaDownweightSizeFraction, 0.3), 0.01, 1),
    targetContributors: Math.max(1, num(options.metaTargetContributors, 4)),
    targetEffectiveN: Math.max(1, num(options.metaTargetEffectiveN, 3)),
    freshnessDays: Math.max(1, num(options.metaFreshnessDays, 14)),
    expectancyScaleUsd: Math.max(0.1, num(options.metaExpectancyScaleUsd, 10)),
    concentrationSoftCap: clamp(num(options.metaConcentrationSoftCap, 0.35), 0, 1),
    concentrationHardCap: clamp(num(options.metaConcentrationHardCap, 0.75), 0, 1),
    clusterSoftCap: clamp(num(options.metaClusterSoftCap, 0.5), 0, 1),
    clusterHardCap: clamp(num(options.metaClusterHardCap, 0.85), 0, 1),
    requireLeaderSummary: options.metaRequireLeaderSummary === true,
    positiveWeights,
    penaltyWeights,
  };
}

function extractLeaderSummary(consensus) {
  const meta = consensus?.meta && typeof consensus.meta === "object" ? consensus.meta : {};
  const summary =
    meta.leaderSummary && typeof meta.leaderSummary === "object" ? meta.leaderSummary : {};
  return {
    qualityScoreAvg: clamp(
      num(summary.qualityScoreAvg, num(meta.leaderQualityAvg, 0.5)),
      0,
      1
    ),
    freshnessDaysAvg: Math.max(
      0,
      num(summary.freshnessDaysAvg, num(meta.leaderFreshnessDaysAvg, 0))
    ),
    targetFillRatioAvg: clamp(
      num(summary.targetFillRatioAvg, num(meta.leaderTargetFillRatioAvg, 0)),
      0,
      1
    ),
    marketFillShareAvg: clamp(
      num(summary.marketFillShareAvg, num(meta.leaderMarketShareAvg, 0)),
      0,
      1
    ),
    persistenceScoreAvg: clamp(
      num(summary.persistenceScoreAvg, num(meta.leaderPersistenceAvg, 0)),
      0,
      1
    ),
    expectancyUsdAvg: num(summary.expectancyUsdAvg, num(meta.leaderExpectancyUsdAvg, 0)),
    clusterCount: Math.max(0, num(summary.clusterCount, num(meta.clusterCount, 0))),
    maxClusterWeightShare: clamp(
      num(summary.maxClusterWeightShare, num(meta.maxClusterWeightShare, 0)),
      0,
      1
    ),
    available:
      summary.available === true ||
      Object.keys(summary).length > 0 ||
      meta.leaderSummaryAvailable === true,
  };
}

function buildMetaSignalFeatures({ side, consensus, regime = null, config = {} }) {
  const cfg = normalizeMetaDecisionConfig(config);
  const meta = consensus?.meta && typeof consensus.meta === "object" ? consensus.meta : {};
  const leaderSummary = extractLeaderSummary(consensus);
  const regimeReady = regime && regime.ready === true;
  const contributors = Math.max(0, num(meta.contributors, num(consensus?.kTop, 0)));
  const effectiveN = Math.max(0, num(meta.effectiveN, 0));
  const features = {
    side: side === "short" ? "short" : "long",
    consensusAbs: clamp(Math.abs(num(consensus?.cTop, 0)), 0, 1),
    contributors,
    effectiveN,
    maxWeightShare: clamp(num(meta.maxWeightShare, 0), 0, 1),
    hhi: clamp(num(meta.hhi, 0), 0, 1),
    quality: leaderSummary.qualityScoreAvg,
    freshness: 1 - normalizePercent(leaderSummary.freshnessDaysAvg, cfg.freshnessDays),
    relevance:
      0.5 * leaderSummary.targetFillRatioAvg + 0.5 * leaderSummary.marketFillShareAvg,
    persistence: leaderSummary.persistenceScoreAvg,
    expectancy: normalizeExpectancy(leaderSummary.expectancyUsdAvg, cfg.expectancyScaleUsd),
    breadth: normalizePercent(Math.min(contributors, Math.max(1, cfg.targetContributors)), cfg.targetContributors),
    breadthRaw: contributors,
    effectiveNScore: normalizePercent(Math.min(effectiveN, Math.max(1, cfg.targetEffectiveN)), cfg.targetEffectiveN),
    regime: regime == null ? 0.5 : regimeReady ? clamp(num(regime.trendStrength, 0.5), 0, 1) : 0,
    regimeReady,
    clusterCount: leaderSummary.clusterCount,
    maxClusterWeightShare: leaderSummary.maxClusterWeightShare,
    leaderSummaryAvailable: leaderSummary.available,
  };
  return features;
}

function scoreMetaSignal(features, config = {}) {
  const cfg = normalizeMetaDecisionConfig(config);
  const pw = cfg.positiveWeights;
  const nw = cfg.penaltyWeights;
  const positive =
    features.consensusAbs * pw.consensus +
    features.quality * pw.quality +
    features.freshness * pw.freshness +
    features.relevance * pw.relevance +
    features.persistence * pw.persistence +
    features.breadth * pw.breadth +
    features.effectiveNScore * pw.effectiveN +
    features.expectancy * pw.expectancy +
    features.regime * pw.regime;
  const maxWeightSharePenalty = normalizePercent(
    Math.max(0, features.maxWeightShare - cfg.concentrationSoftCap),
    Math.max(1e-9, 1 - cfg.concentrationSoftCap)
  );
  const clusterWeightSharePenalty = normalizePercent(
    Math.max(0, features.maxClusterWeightShare - cfg.clusterSoftCap),
    Math.max(1e-9, 1 - cfg.clusterSoftCap)
  );
  const hhiPenalty = normalizePercent(Math.max(0, features.hhi - 0.25), 0.75);
  const penalty =
    maxWeightSharePenalty * nw.maxWeightShare +
    clusterWeightSharePenalty * nw.clusterWeightShare +
    hhiPenalty * nw.hhi;
  const maxPositive = Object.values(pw).reduce((sum, value) => sum + value, 0);
  if (!(maxPositive > 0)) return 0;
  return clamp((positive - penalty) / maxPositive, 0, 1);
}

function evaluateMetaSignal({ side, consensus, regime = null, config = {} }) {
  const cfg = normalizeMetaDecisionConfig(config);
  const features = buildMetaSignalFeatures({ side, consensus, regime, config: cfg });
  const reasons = [];
  if (cfg.requireLeaderSummary && !features.leaderSummaryAvailable) {
    reasons.push("leader_summary_missing");
  }
  if (features.maxWeightShare > cfg.concentrationHardCap) {
    reasons.push("concentration_hard_cap");
  }
  if (features.maxClusterWeightShare > cfg.clusterHardCap) {
    reasons.push("cluster_hard_cap");
  }
  const score = scoreMetaSignal(features, cfg);
  if (score < cfg.followScoreMin) reasons.push("score_below_follow_min");
  if (reasons.length) {
    return {
      ok: false,
      decision: "ignore",
      score,
      sizeFraction: 0,
      reasons,
      features,
    };
  }

  let decision = "small";
  let sizeFraction = cfg.smallSizeFraction;
  const softPenalty =
    features.maxWeightShare > cfg.concentrationSoftCap ||
    features.maxClusterWeightShare > cfg.clusterSoftCap;

  if (score >= cfg.fullSizeScoreMin && !softPenalty) {
    decision = "normal";
    sizeFraction = 1;
  } else if (softPenalty) {
    decision = "downweight";
    sizeFraction = cfg.downweightSizeFraction;
  } else {
    const span = Math.max(1e-9, cfg.fullSizeScoreMin - cfg.followScoreMin);
    const progress = clamp((score - cfg.followScoreMin) / span, 0, 1);
    sizeFraction = clamp(
      cfg.smallSizeFraction + progress * (1 - cfg.smallSizeFraction),
      cfg.smallSizeFraction,
      1
    );
  }

  return {
    ok: true,
    decision,
    score,
    sizeFraction,
    reasons,
    features,
  };
}

module.exports = {
  normalizeMetaDecisionConfig,
  buildMetaSignalFeatures,
  scoreMetaSignal,
  evaluateMetaSignal,
};
