function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function nullableNum(v, d = null) {
  if (v === undefined || v === null || v === "") return d;
  const s = String(v).trim().toLowerCase();
  if (s === "null" || s === "none" || s === "off") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function toAddress(x) {
  const s = String(x || "").toLowerCase().trim();
  return s.startsWith("0x") ? s : null;
}

function bool(v, d = false) {
  if (v === undefined || v === null || v === "") return d;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return d;
}

function daysToMs(days) {
  return Math.max(0, num(days, 0)) * 24 * 60 * 60 * 1000;
}

function normalizeCentered(value, scale = 1) {
  const denom = Math.max(1e-9, Math.abs(num(scale, 1)));
  return clamp(0.5 + 0.5 * Math.tanh(num(value, 0) / denom), 0, 1);
}

function normalizeInverse(value, scale = 1) {
  const denom = Math.max(1e-9, Math.abs(num(scale, 1)));
  return clamp(1 - Math.tanh(Math.max(0, num(value, 0)) / denom), 0, 1);
}

function getPersistenceScore(m) {
  return clamp(num(m?.persistenceScore, num(m?.persistence?.score, 0)), 0, 1);
}

function getPositiveHalves(m) {
  return clamp(num(m?.positiveHalves, num(m?.persistence?.positiveHalves, 0)), 0, 2);
}

function getTargetDrawdownPct(m) {
  return Math.max(0, num(m?.targetDrawdownPct, num(m?.target?.maxDrawdownPct, 0)));
}

function getTradePnlConcentration(m) {
  return clamp(
    num(m?.tradePnlConcentration, num(m?.target?.tradePnlConcentration, 0)),
    0,
    1
  );
}

function getTradeDayConcentration(m) {
  return clamp(
    num(m?.tradeDayConcentration, num(m?.target?.tradeDayConcentration, 0)),
    0,
    1
  );
}

function computeQualityMetric(m) {
  const win = clamp(num(m?.winRateLB, 0.5), 0, 1);
  const score01 = clamp(0.5 + 0.5 * Math.tanh(num(m?.score, 0) * 2.0), 0, 1);
  const expectancy01 = normalizeCentered(num(m?.expectancyUsd, 0), 25);
  const downside01 = normalizeInverse(num(m?.downsideDeviationUsd, 0), 40);
  const persistence01 = getPersistenceScore(m);
  const drawdown01 = normalizeInverse(getTargetDrawdownPct(m), 60);
  const activity01 = clamp(num(m?.targetActivityDays, 0) / 21, 0, 1);
  const positiveHalves01 = clamp(getPositiveHalves(m) / 2, 0, 1);
  const tradeConc01 = 1 - getTradePnlConcentration(m);
  const dayConc01 = 1 - getTradeDayConcentration(m);

  return clamp(
    0.22 * win +
      0.16 * score01 +
      0.18 * expectancy01 +
      0.14 * persistence01 +
      0.1 * downside01 +
      0.08 * drawdown01 +
      0.05 * activity01 +
      0.04 * positiveHalves01 +
      0.02 * tradeConc01 +
      0.01 * dayConc01,
    0,
    1
  );
}

function capWeightShares(weights, maxShare) {
  const entries = Array.from(weights?.entries?.() || []).filter(
    ([, w]) => Number.isFinite(w) && w > 0
  );
  if (!entries.length) return new Map();

  const requestedCap = clamp(num(maxShare, 1), 0, 1);
  if (!(requestedCap > 0) || requestedCap >= 1) return new Map(entries);

  const minFeasibleCap = 1 / entries.length;
  const effectiveCap = Math.max(requestedCap, minFeasibleCap);

  const baseWeights = new Map(entries);
  const fixedShares = new Map();
  const remaining = new Set(entries.map(([address]) => address));

  while (remaining.size > 0) {
    const fixedBudget = Array.from(fixedShares.values()).reduce((sum, x) => sum + x, 0);
    const remainingBudget = Math.max(0, 1 - fixedBudget);
    const remainingWeight = Array.from(remaining).reduce(
      (sum, address) => sum + num(baseWeights.get(address), 0),
      0
    );
    if (!(remainingWeight > 0) || !(remainingBudget > 0)) break;

    const violating = [];
    for (const address of remaining) {
      const share = (num(baseWeights.get(address), 0) / remainingWeight) * remainingBudget;
      if (share > effectiveCap + 1e-9) violating.push(address);
    }
    if (!violating.length) break;

    for (const address of violating) {
      fixedShares.set(address, effectiveCap);
      remaining.delete(address);
    }
  }

  const fixedBudget = Array.from(fixedShares.values()).reduce((sum, x) => sum + x, 0);
  const remainingBudget = Math.max(0, 1 - fixedBudget);
  const remainingWeight = Array.from(remaining).reduce(
    (sum, address) => sum + num(baseWeights.get(address), 0),
    0
  );

  const capped = new Map();
  for (const [address, share] of fixedShares.entries()) capped.set(address, share);
  for (const address of remaining) {
    const share =
      remainingWeight > 0 ? (num(baseWeights.get(address), 0) / remainingWeight) * remainingBudget : 0;
    capped.set(address, share);
  }

  return capped;
}

function toDailyPnlMap(series) {
  if (!series) return null;
  if (series instanceof Map) return series;
  if (Array.isArray(series)) {
    const out = new Map();
    for (const row of series) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const day = Number(row[0]);
      const pnl = Number(row[1]);
      if (!Number.isFinite(day) || !Number.isFinite(pnl)) continue;
      out.set(day, pnl);
    }
    return out.size ? out : null;
  }
  if (typeof series === "object") {
    const out = new Map();
    for (const [dayRaw, pnlRaw] of Object.entries(series)) {
      const day = Number(dayRaw);
      const pnl = Number(pnlRaw);
      if (!Number.isFinite(day) || !Number.isFinite(pnl)) continue;
      out.set(day, pnl);
    }
    return out.size ? out : null;
  }
  return null;
}

function pearsonCorrelation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    const x = num(xs[i], 0);
    const y = num(ys[i], 0);
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }
  const cov = n * sumXY - sumX * sumY;
  const varX = n * sumXX - sumX * sumX;
  const varY = n * sumYY - sumY * sumY;
  if (!(varX > 0) || !(varY > 0)) return null;
  return cov / Math.sqrt(varX * varY);
}

function computeSeriesCorrelation(aSeries, bSeries, minOverlapDays = 5) {
  const aMap = toDailyPnlMap(aSeries);
  const bMap = toDailyPnlMap(bSeries);
  if (!aMap || !bMap) return { corr: null, overlapDays: 0 };
  const days = Array.from(new Set([...aMap.keys(), ...bMap.keys()])).sort((x, y) => x - y);
  if (days.length < Math.max(2, minOverlapDays)) return { corr: null, overlapDays: days.length };
  const xs = days.map((day) => num(aMap.get(day), 0));
  const ys = days.map((day) => num(bMap.get(day), 0));
  const corr = pearsonCorrelation(xs, ys);
  return { corr, overlapDays: days.length };
}

function computeBaseWeight(m, cfg) {
  const win = clamp(num(m.winRateLB, 0.5), 0, 1);
  const score = num(m.score, 0);
  // Convert score into [0..1] smoothly; win-rate stays the main reliability anchor.
  const score01 = clamp(0.5 + 0.5 * Math.tanh(score * 2.0), 0, 1);
  const quality = computeQualityMetric(m);

  const mode = String(cfg?.weightMode || "hybrid").toLowerCase();
  if (mode === "quality") return quality;
  if (mode === "expectancy") return normalizeCentered(num(m?.expectancyUsd, 0), 25);
  if (mode === "persistence") return getPersistenceScore(m);
  if (mode === "winrate") return win;
  if (mode === "score") return score01;
  return clamp(0.45 * quality + 0.35 * win + 0.2 * score01, 0, 1);
}

function computeRankMetric(m, cfg) {
  const mode = String(cfg?.rankMode || "score")
    .trim()
    .toLowerCase();
  if (mode === "quality") return computeQualityMetric(m);
  if (mode === "expectancy") return normalizeCentered(num(m?.expectancyUsd, 0), 25);
  if (mode === "persistence") return getPersistenceScore(m);
  if (mode === "winrate") return clamp(num(m?.winRateLB, 0.5), 0, 1);
  if (mode === "hybrid") return computeBaseWeight(m, { ...cfg, weightMode: "hybrid" });
  // Default: raw score (keeps backward compatibility with existing configs).
  return num(m?.score, 0);
}

function isFailing(m, cfg) {
  if (!m) return true;
  if (num(m.liquidationCount, 0) > 0) return true;
  if (num(m.lastFillAgeDays, Infinity) > cfg.maxLastFillAgeDays) return true;
  if (computeRankMetric(m, cfg) <= cfg.dropThreshold) return true;
  return false;
}

function isEligible(m, cfg) {
  if (!m) return false;
  if (cfg.eliteOnly && !m.elite) return false;
  const trades = Math.max(0, num(m.trades, (num(m.wins, 0) + num(m.losses, 0))));
  if (trades < cfg.minTrades) return false;
  if (num(m.targetFillRatio, num(m.target?.fillRatio, 0)) < cfg.minTargetFillRatio) return false;
  if (num(m.targetActivityDays, num(m.target?.activityDays, 0)) < cfg.minTargetActiveDays) return false;
  if (cfg.minMarketFillShareWithinTargets > 0) {
    const share = clamp(num(m.marketFillShareWithinTargets, 0), 0, 1);
    if (share < cfg.minMarketFillShareWithinTargets) return false;
  }
  if (num(m.expectancyUsd, 0) < cfg.minExpectancyUsd) return false;
  if (getPersistenceScore(m) < cfg.minPersistenceScore) return false;
  if (getPositiveHalves(m) < cfg.minPositiveHalves) return false;
  if (
    Number.isFinite(cfg.maxTargetDrawdownPct) &&
    getTargetDrawdownPct(m) > cfg.maxTargetDrawdownPct
  )
    return false;
  if (
    Number.isFinite(cfg.maxTradePnlConcentration) &&
    getTradePnlConcentration(m) > cfg.maxTradePnlConcentration
  )
    return false;
  if (
    Number.isFinite(cfg.maxTradeDayConcentration) &&
    getTradeDayConcentration(m) > cfg.maxTradeDayConcentration
  )
    return false;
  if (num(m.lastFillAgeDays, Infinity) > cfg.maxLastFillAgeDays) return false;
  return true;
}

function computeEffectiveScore(m, state, cfg) {
  const base = computeRankMetric(m, cfg);
  const incumbentBonus =
    state && (state.status === "active" || state.status === "probation" || state.status === "forced")
      ? cfg.incumbentScoreBonus
      : 0;
  const eliteBonus = m.elite ? cfg.eliteScoreBonus : 0;
  return base + incumbentBonus + eliteBonus;
}

function ensureStateShape(state) {
  const out = state && typeof state === "object" ? state : {};
  if (!out.version) out.version = 1;
  if (!out.wallets || typeof out.wallets !== "object") out.wallets = {};
  if (!Array.isArray(out.lastTopK)) out.lastTopK = [];
  return out;
}

function createLeaderSelector(config = {}, overrides = {}, initialState = null) {
  const safeConfig = config && typeof config === "object" ? config : {};
  const rankModeRaw = String(safeConfig.rankMode || "score").trim().toLowerCase();
  const weightModeRaw = String(safeConfig.weightMode || "hybrid").trim().toLowerCase();
  const cfg = {
    rankMode: ["score", "winrate", "hybrid", "quality", "expectancy", "persistence"].includes(
      rankModeRaw
    )
      ? rankModeRaw
      : "score",
    eliteOnly: bool(safeConfig.eliteOnly, false),
    topKSize: Math.max(1, num(safeConfig.topKSize, 10)),
    promoteThreshold: num(safeConfig.promoteThreshold, 0.55),
    dropThreshold: num(safeConfig.dropThreshold, 0.45),
    dropPersistenceRuns: Math.max(1, num(safeConfig.dropPersistenceRuns, 3)),
    maxChurnPerUpdate: Math.max(0, num(safeConfig.maxChurnPerUpdate, 2)),
    cooldownDays: Math.max(0, num(safeConfig.cooldownDays, 7)),

    minTrades: Math.max(1, num(safeConfig.minTrades, 40)),
    minTargetFillRatio: clamp(num(safeConfig.minTargetFillRatio, 0.5), 0, 1),
    minTargetActiveDays: Math.max(0, num(safeConfig.minTargetActiveDays, 3)),
    minMarketFillShareWithinTargets: clamp(
      num(safeConfig.minMarketFillShareWithinTargets, 0),
      0,
      1
    ),
    minExpectancyUsd: num(safeConfig.minExpectancyUsd, -Infinity),
    minPersistenceScore: clamp(num(safeConfig.minPersistenceScore, 0), 0, 1),
    minPositiveHalves: clamp(num(safeConfig.minPositiveHalves, 0), 0, 2),
    maxTargetDrawdownPct: (() => {
      const raw = nullableNum(safeConfig.maxTargetDrawdownPct, null);
      return raw == null ? null : Math.max(0, raw);
    })(),
    maxTradePnlConcentration: (() => {
      const raw = nullableNum(safeConfig.maxTradePnlConcentration, null);
      return raw == null ? null : clamp(raw, 0, 1);
    })(),
    maxTradeDayConcentration: (() => {
      const raw = nullableNum(safeConfig.maxTradeDayConcentration, null);
      return raw == null ? null : clamp(raw, 0, 1);
    })(),
    clusterCorrThreshold: (() => {
      const raw = nullableNum(safeConfig.clusterCorrThreshold, null);
      return raw == null ? null : clamp(raw, -1, 1);
    })(),
    clusterMinOverlapDays: Math.max(2, num(safeConfig.clusterMinOverlapDays, 10)),
    maxClusterMembers: (() => {
      const raw = nullableNum(safeConfig.maxClusterMembers, null);
      return raw == null ? null : Math.max(1, Math.floor(raw));
    })(),
    maxClusterWeightShare: (() => {
      const raw = nullableNum(safeConfig.maxClusterWeightShare, null);
      return raw == null ? null : clamp(raw, 0, 1);
    })(),
    maxLastFillAgeDays: Math.max(0, num(safeConfig.maxLastFillAgeDays, 7)),

    incumbentScoreBonus: num(safeConfig.incumbentScoreBonus, 0.03),
    eliteScoreBonus: num(safeConfig.eliteScoreBonus, 0.05),
    eliteDropPersistenceMult: Math.max(1, num(safeConfig.eliteDropPersistenceMult, 2)),
    eliteCooldownDays: Math.max(0, num(safeConfig.eliteCooldownDays, 14)),

    minWeight: clamp(num(safeConfig.minWeight, 0.05), 0, 1),
    maxWeight: clamp(num(safeConfig.maxWeight, 0.25), 0, 1),
    maxActiveWeightShare: clamp(num(safeConfig.maxActiveWeightShare, 1), 0, 1),
    probationWeightMult: clamp(num(safeConfig.probationWeightMult, 0.35), 0, 1),
    forcedRespectGates: safeConfig.forcedRespectGates !== false,
    eliteWeightMult: Math.max(0, num(safeConfig.eliteWeightMult, 1.5)),
    weightMode: ["hybrid", "winrate", "score", "quality", "expectancy", "persistence"].includes(
      weightModeRaw
    )
      ? weightModeRaw
      : "hybrid",
  };

  const forceInclude = new Set(
    (overrides.forceInclude || [])
      .map(toAddress)
      .filter(Boolean)
  );
  const blocklist = new Set(
    (overrides.blocklist || [])
      .map(toAddress)
      .filter(Boolean)
  );
  const weightMultipliers =
    overrides.weightMultipliers && typeof overrides.weightMultipliers === "object"
      ? overrides.weightMultipliers
      : {};

  const state = ensureStateShape(initialState);

  function getOrInitWalletState(address) {
    const a = toAddress(address);
    if (!a) return null;
    if (!state.wallets[a]) {
      state.wallets[a] = {
        status: "candidate",
        failStreak: 0,
        cooldownUntilMs: 0,
        lastSeenMs: 0,
        lastScore: null,
        lastReason: null,
        activeSinceMs: null,
      };
    }
    return state.wallets[a];
  }

  function computeWeight(m, ws) {
    const addr = toAddress(m.address);
    if (!addr) return 0;
    if (blocklist.has(addr)) return 0;

    const eligible = isEligible(m, cfg);
    if (!eligible && (cfg.forcedRespectGates || !forceInclude.has(addr))) return 0;

    let w = computeBaseWeight(m, cfg);

    if (ws && ws.status === "probation") w *= cfg.probationWeightMult;
    if (m.elite) w *= cfg.eliteWeightMult;

    const mult = weightMultipliers[addr];
    if (Number.isFinite(num(mult, null))) w *= num(mult, 1);

    return clamp(w, cfg.minWeight, cfg.maxWeight);
  }

  function update({ candidates = [], nowMs }) {
    const ts = Number.isFinite(nowMs) ? nowMs : Date.now();

    const prevTopK = new Set((state.lastTopK || []).map(toAddress).filter(Boolean));

    const byAddr = new Map();
    for (const raw of candidates || []) {
      const addr = toAddress(raw.address || raw.wallet?.address || raw.wallet);
      if (!addr) continue;
      if (blocklist.has(addr)) continue;

      const m = {
        address: addr,
        score: num(raw.score, 0),
        winRateLB: num(raw.winRateLB, 0.5),
        trades: Math.max(0, num(raw.trades, num(raw.wins, 0) + num(raw.losses, 0))),
        targetFillRatio: num(raw.targetFillRatio, num(raw.target?.fillRatio, 0)),
        targetActivityDays: Math.max(0, num(raw.targetActivityDays, num(raw.target?.activityDays, 0))),
        marketFillShareWithinTargets: clamp(num(raw.marketFillShareWithinTargets, 1), 0, 1),
        expectancyUsd: num(raw.expectancyUsd, 0),
        downsideDeviationUsd: Math.max(0, num(raw.downsideDeviationUsd, 0)),
        tradePnlConcentration: clamp(num(raw.tradePnlConcentration, 0), 0, 1),
        tradeDayConcentration: clamp(num(raw.tradeDayConcentration, 0), 0, 1),
        dailyPnlSeries: raw.dailyPnlSeries ?? raw.target?.dailyPnlSeries ?? null,
        targetDrawdownPct: nullableNum(raw.targetDrawdownPct, null),
        persistenceScore: clamp(num(raw.persistenceScore, 0), 0, 1),
        positiveHalves: clamp(num(raw.positiveHalves, 0), 0, 2),
        lastFillAgeDays: num(raw.lastFillAgeDays, Infinity),
        liquidationCount: Math.max(0, num(raw.liquidationCount, 0)),
        elite: !!raw.elite,
      };
      byAddr.set(addr, m);
      const ws = getOrInitWalletState(addr);
      ws.lastSeenMs = ts;
      ws.lastScore = computeRankMetric(m, cfg);
    }

    // Apply overrides presence into state
    for (const addr of forceInclude) {
      if (blocklist.has(addr)) continue;
      getOrInitWalletState(addr);
    }

    // Update lifecycle statuses
    for (const [addr, ws] of Object.entries(state.wallets)) {
      const a = toAddress(addr);
      if (!a) continue;

      if (blocklist.has(a)) {
        ws.status = "blocked";
        ws.failStreak = 0;
        ws.cooldownUntilMs = 0;
        ws.lastReason = "blocked";
        continue;
      }

      if (ws.cooldownUntilMs && ts < ws.cooldownUntilMs) {
        ws.status = "dropped";
        ws.lastReason = "cooldown";
        continue;
      }

      if (forceInclude.has(a)) {
        ws.status = "forced";
        ws.failStreak = 0;
        ws.lastReason = "forced";
        if (ws.activeSinceMs == null) ws.activeSinceMs = ws.activeSinceMs ?? ts;
        continue;
      }

      const m = byAddr.get(a) || null;
      if (!m) {
        // Missing metrics -> probation; repeated misses drop.
        ws.failStreak = (ws.failStreak || 0) + 1;
        ws.status = ws.failStreak >= cfg.dropPersistenceRuns ? "dropped" : "probation";
        ws.lastReason = "missing_metrics";
        if (ws.status === "dropped") {
          ws.cooldownUntilMs = ts + daysToMs(cfg.cooldownDays);
          ws.failStreak = 0;
        }
        continue;
      }

      const eligible = isEligible(m, cfg);
      const failing = isFailing(m, cfg);

      if (!eligible) {
        ws.failStreak = (ws.failStreak || 0) + 1;
        ws.status = ws.failStreak >= cfg.dropPersistenceRuns ? "dropped" : "probation";
        ws.lastReason = "ineligible";
        if (ws.status === "dropped") {
          ws.cooldownUntilMs = ts + daysToMs(cfg.cooldownDays);
          ws.failStreak = 0;
        }
        continue;
      }

      if (failing) {
        const persistence =
          cfg.dropPersistenceRuns * (m.elite ? cfg.eliteDropPersistenceMult : 1);
        ws.failStreak = (ws.failStreak || 0) + 1;
        ws.status = ws.failStreak >= persistence ? "dropped" : "probation";
        ws.lastReason = num(m.liquidationCount, 0) > 0 ? "liquidation" : "underperform_or_stale";
        if (ws.status === "dropped") {
          const cd = m.elite ? cfg.eliteCooldownDays : cfg.cooldownDays;
          ws.cooldownUntilMs = ts + daysToMs(cd);
          ws.failStreak = 0;
        }
        continue;
      }

      // Healthy + eligible: clear probation
      ws.failStreak = 0;
      if (ws.status !== "active") ws.activeSinceMs = ws.activeSinceMs ?? ts;
      ws.status = "active";
      ws.lastReason =
        computeRankMetric(m, cfg) >= cfg.promoteThreshold ? "promoted_or_retained" : "retained";
    }

    // Build proposed TopK set using effective score + churn limits
    const forced = Array.from(forceInclude)
      .filter((a) => !blocklist.has(a))
      .slice(0, cfg.topKSize);

    const scored = Array.from(byAddr.values())
      .filter((m) => !blocklist.has(m.address))
      .filter((m) => !cfg.eliteOnly || !!m.elite)
      // Meaningful hysteresis:
      // - Incumbents can remain if they stay above the *drop* threshold (handled in lifecycle updates).
      // - New entrants must clear the *promote* threshold to avoid churny "best-of-noise" selection.
      .filter((m) => {
        const addr = toAddress(m.address);
        if (!addr) return false;
        if (prevTopK.has(addr)) return true;
        return computeRankMetric(m, cfg) >= cfg.promoteThreshold;
      })
      .filter((m) => {
        const ws = state.wallets[m.address];
        if (!ws) return true;
        if (ws.status === "dropped" || ws.status === "blocked") return false;
        if (ws.cooldownUntilMs && ts < ws.cooldownUntilMs) return false;
        return true;
      })
      .map((m) => ({
        ...m,
        eff: computeEffectiveScore(m, state.wallets[m.address], cfg),
      }))
      .sort((a, b) => (b.eff ?? 0) - (a.eff ?? 0));

    const proposed = [];
    const proposedSet = new Set();
    const selectedRows = [];
    const clusterState = [];
    const clusterIndexByAddress = new Map();
    let selectedRawWeightSum = 0;

    const maybeFindCluster = (row) => {
      if (!Number.isFinite(cfg.clusterCorrThreshold)) return { clusterIndex: -1, corr: null };
      for (let i = 0; i < clusterState.length; i++) {
        const cluster = clusterState[i];
        let bestCorr = null;
        for (const member of cluster.members) {
          const { corr, overlapDays } = computeSeriesCorrelation(
            row.dailyPnlSeries,
            member.dailyPnlSeries,
            cfg.clusterMinOverlapDays
          );
          if (overlapDays < cfg.clusterMinOverlapDays || !Number.isFinite(corr)) continue;
          if (bestCorr == null || corr > bestCorr) bestCorr = corr;
        }
        if (bestCorr != null && bestCorr >= cfg.clusterCorrThreshold) {
          return { clusterIndex: i, corr: bestCorr };
        }
      }
      return { clusterIndex: -1, corr: null };
    };

    const canAdmitClusteredRow = (row, rawWeight) => {
      const { clusterIndex, corr } = maybeFindCluster(row);
      if (clusterIndex < 0) return { ok: true, clusterIndex: -1, corr: null };
      const cluster = clusterState[clusterIndex];
      if (Number.isFinite(cfg.maxClusterMembers) && cluster.members.length >= cfg.maxClusterMembers) {
        return { ok: false, clusterIndex, corr };
      }
      if (
        Number.isFinite(cfg.maxClusterWeightShare) &&
        cfg.maxClusterWeightShare > 0 &&
        selectedRawWeightSum > 0 &&
        clusterState.length > 0
      ) {
        const projectedClusterWeight = cluster.rawWeightSum + rawWeight;
        const projectedTotalWeight = selectedRawWeightSum + rawWeight;
        const projectedShare =
          projectedTotalWeight > 0 ? projectedClusterWeight / projectedTotalWeight : 0;
        if (projectedShare > cfg.maxClusterWeightShare + 1e-9) {
          return { ok: false, clusterIndex, corr };
        }
      }
      return { ok: true, clusterIndex, corr };
    };

    const registerSelectedRow = (row, rawWeight) => {
      if (!row) return;
      const { clusterIndex } = maybeFindCluster(row);
      if (clusterIndex < 0) {
        clusterState.push({
          members: [row],
          rawWeightSum: rawWeight,
        });
        clusterIndexByAddress.set(row.address, clusterState.length - 1);
      } else {
        clusterState[clusterIndex].members.push(row);
        clusterState[clusterIndex].rawWeightSum += rawWeight;
        clusterIndexByAddress.set(row.address, clusterIndex);
      }
      selectedRows.push(row);
      selectedRawWeightSum += rawWeight;
    };

    for (const a of forced) {
      if (proposedSet.size >= cfg.topKSize) break;
      proposed.push(a);
      proposedSet.add(a);
      const forcedRow = byAddr.get(a);
      if (forcedRow) {
        registerSelectedRow(forcedRow, computeWeight(forcedRow, state.wallets[a]));
      }
    }

    for (const row of scored) {
      if (proposedSet.size >= cfg.topKSize) break;
      if (proposedSet.has(row.address)) continue;
      const rawWeight = computeWeight(row, state.wallets[row.address]);
      const clusterDecision = canAdmitClusteredRow(row, rawWeight);
      if (!clusterDecision.ok) continue;
      proposed.push(row.address);
      proposedSet.add(row.address);
      registerSelectedRow(row, rawWeight);
    }

    // Enforce churn: limit replacements per update.
    const adds = proposed.filter((a) => !prevTopK.has(a));
    const drops = Array.from(prevTopK).filter((a) => !proposedSet.has(a));
    const replacements = Math.min(adds.length, drops.length);
    const maxRep = cfg.maxChurnPerUpdate;

    if (maxRep >= 0 && replacements > maxRep) {
      const keepAddCount = maxRep;
      const keptAdds = new Set(adds.slice(0, keepAddCount));

      // Remove extra additions
      const trimmed = proposed.filter((a) => prevTopK.has(a) || keptAdds.has(a));

      // Backfill with best incumbents not in trimmed
      const trimmedSet = new Set(trimmed);
      const incumbentsByScore = Array.from(prevTopK)
        .filter((a) => !trimmedSet.has(a))
        .map((a) => {
          const m = byAddr.get(a);
          const eff = m ? computeEffectiveScore(m, state.wallets[a], cfg) : -Infinity;
          return { a, eff };
        })
        .sort((x, y) => (y.eff ?? -Infinity) - (x.eff ?? -Infinity));

      for (const { a } of incumbentsByScore) {
        if (trimmed.length >= cfg.topKSize) break;
        trimmed.push(a);
        trimmedSet.add(a);
      }

      proposed.length = 0;
      for (const a of trimmed.slice(0, cfg.topKSize)) proposed.push(a);
    }

    // Compute weights map for TopK
    const weights = new Map();
    for (const a of proposed) {
      const m = byAddr.get(a);
      const ws = state.wallets[a];
      if (!m) {
        weights.set(a, 0);
        continue;
      }
      weights.set(a, computeWeight(m, ws));
    }
    const cappedWeights =
      cfg.maxActiveWeightShare < 1 ? capWeightShares(weights, cfg.maxActiveWeightShare) : weights;
    let maxClusterWeightShare = 0;
    if (clusterState.length && cappedWeights.size) {
      const clusterWeightSums = new Map();
      let totalWeight = 0;
      for (const [address, weight] of cappedWeights.entries()) {
        const normalizedAddress = toAddress(address);
        const w = num(weight, 0);
        if (!normalizedAddress || !(w > 0)) continue;
        totalWeight += w;
        const clusterIndex = clusterIndexByAddress.get(normalizedAddress);
        if (clusterIndex == null || clusterIndex < 0) continue;
        clusterWeightSums.set(clusterIndex, num(clusterWeightSums.get(clusterIndex), 0) + w);
      }
      if (totalWeight > 0) {
        for (const clusterWeight of clusterWeightSums.values()) {
          maxClusterWeightShare = Math.max(maxClusterWeightShare, clusterWeight / totalWeight);
        }
      }
    }

    state.updatedAt = new Date(ts).toISOString();
    state.lastTopK = proposed.slice(0, cfg.topKSize);

    return {
      topK: proposed,
      weights: cappedWeights,
      meta: {
        nowMs: ts,
        topKSize: cfg.topKSize,
        prevTopKCount: prevTopK.size,
        churnAdds: proposed.filter((a) => !prevTopK.has(a)).length,
        churnDrops: Array.from(prevTopK).filter((a) => !new Set(proposed).has(a)).length,
        clusterCount: clusterState.length,
        maxClusterWeightShare,
      },
      state,
    };
  }

  return {
    config: cfg,
    overrides: { forceInclude: Array.from(forceInclude), blocklist: Array.from(blocklist) },
    update,
    getState: () => state,
  };
}

module.exports = {
  createLeaderSelector,
};
