function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function toUser(x) {
  const s = String(x || "").toLowerCase().trim();
  return s.startsWith("0x") ? s : null;
}

function toCoin(x) {
  return String(x || "").toUpperCase().trim();
}

function safeLog1p(x) {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.log1p(x);
}

function computeConvictionMultiplier(positionValueUsd, cfg) {
  const pv = Math.abs(num(positionValueUsd, 0));
  if (pv <= 0) return 0;
  const cap = Math.max(1, num(cfg.convictionNotionalCapUsd, 50_000));
  const x = safeLog1p(pv) / safeLog1p(cap);
  const scaled = clamp(x, 0, 1);
  const minMult = clamp(num(cfg.convictionMinMult, 0.25), 0, 1);
  const maxMult = Math.max(minMult, num(cfg.convictionMaxMult, 1.0));
  return minMult + (maxMult - minMult) * scaled;
}

function computeEffectiveSampleSize(weights) {
  // ESS = (sum w)^2 / sum(w^2)
  let sum = 0;
  let sumSq = 0;
  for (const w of weights) {
    const x = num(w, 0);
    if (x <= 0) continue;
    sum += x;
    sumSq += x * x;
  }
  if (sumSq <= 0) return 0;
  return (sum * sum) / sumSq;
}

function computeWeightConcentration(weights) {
  let sum = 0;
  let sumSq = 0;
  let maxW = 0;
  for (const w of weights) {
    const x = num(w, 0);
    if (x <= 0) continue;
    sum += x;
    sumSq += x * x;
    if (x > maxW) maxW = x;
  }
  if (sum <= 0) return { hhi: 1, maxWeightShare: 1 };
  return {
    hhi: sumSq / (sum * sum),
    maxWeightShare: maxW / sum,
  };
}

function normalizeMetaId(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function toLeaderMetadataMap(source) {
  if (!source) return null;
  if (source instanceof Map) return source;
  if (typeof source !== "object") return null;
  return new Map(
    Object.entries(source)
      .map(([user, meta]) => [toUser(user), meta && typeof meta === "object" ? meta : null])
      .filter(([user]) => user)
  );
}

function summarizeWeightedGroups(groupWeights, totalWeight) {
  if (!(groupWeights instanceof Map) || groupWeights.size === 0 || !(totalWeight > 0)) {
    return {
      count: 0,
      maxWeightShare: 0,
      dominant: null,
    };
  }

  let dominant = null;
  let dominantWeight = 0;
  for (const [id, weight] of groupWeights.entries()) {
    const w = num(weight, 0);
    if (w <= dominantWeight) continue;
    dominantWeight = w;
    dominant = id;
  }

  return {
    count: groupWeights.size,
    maxWeightShare: dominantWeight / totalWeight,
    dominant,
  };
}

function extractPositionsFromClearinghouseState(state, { targetCoins = null } = {}) {
  const positionsRaw = Array.isArray(state?.assetPositions) ? state.assetPositions : [];
  const out = [];
  for (const row of positionsRaw) {
    const p = row?.position || row;
    const coin = toCoin(p?.coin);
    if (!coin) continue;
    if (targetCoins && !targetCoins.has(coin)) continue;
    out.push({
      coin,
      szi: num(p?.szi, 0),
      positionValue: num(p?.positionValue, num(p?.positionValueUsd, null)),
      entryPx: num(p?.entryPx, null),
      marginUsed: num(p?.marginUsed, null),
      leverage: num(p?.leverage?.value, null),
    });
  }
  return out;
}

function createCopyTradingConsensusEngine(config = {}) {
  const cfg = {
    staleMs: Math.max(5_000, num(config.staleMs, 120_000)),
    minLeaders: Math.max(1, num(config.minLeaders, 3)),
    minEffectiveN: Math.max(0, num(config.minEffectiveN, 2.0)),

    convictionNotionalCapUsd: Math.max(1, num(config.convictionNotionalCapUsd, 50_000)),
    convictionMinMult: clamp(num(config.convictionMinMult, 0.25), 0, 1),
    convictionMaxMult: Math.max(0, num(config.convictionMaxMult, 1.0)),

    eliteEnabled: config.eliteEnabled !== false,
    eliteMinLeaders: Math.max(1, num(config.eliteMinLeaders, 1)),
    eliteMinConsensusAbs: clamp(num(config.eliteMinConsensusAbs, 0.65), 0, 1),
    eliteMaxWeightShare: clamp(num(config.eliteMaxWeightShare, 0.6), 0, 1),

    targetCoins: Array.isArray(config.targetCoins) ? new Set(config.targetCoins.map(toCoin)) : null,
    leaderMetadata: toLeaderMetadataMap(
      config.leaderMetadata ||
        config.leaderMetadataByUser ||
        config.leaderMetaByUser ||
        null
    ),
  };

  // wallet -> { lastUpdateMs, positions: Map(coin -> { szi, positionValue, ... }) }
  const walletState = new Map();

  function upsertWallet(user) {
    const u = toUser(user);
    if (!u) return null;
    if (!walletState.has(u)) walletState.set(u, { lastUpdateMs: 0, positions: new Map() });
    return walletState.get(u);
  }

  function ingestClearinghouseState(user, clearinghouseState, receivedAtMs) {
    const u = toUser(user);
    if (!u) return;
    const ws = upsertWallet(u);
    if (!ws) return;
    const ts = Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now();
    ws.lastUpdateMs = ts;

    const positions = extractPositionsFromClearinghouseState(clearinghouseState, { targetCoins: cfg.targetCoins });
    // Hyperliquid clearinghouse snapshots are authoritative. For tracked coins,
    // an omitted symbol means the wallet is flat on that symbol.
    if (cfg.targetCoins && cfg.targetCoins.size) {
      for (const coin of cfg.targetCoins) {
        ws.positions.delete(coin);
      }
    } else {
      ws.positions.clear();
    }
    for (const p of positions) {
      ws.positions.set(p.coin, p);
    }
  }

  function ingestWsMessage(msg, receivedAtMs) {
    const channel =
      msg?.channel || msg?.type || msg?.data?.type || msg?.subscription?.type || msg?.result?.type || null;
    if (channel !== "webData2" && channel !== "clearinghouseState") return;

    // webData2 has nested clearinghouseState; clearinghouseState has data.clearinghouseState
    const user =
      (typeof msg?.data?.user === "string" && msg.data.user) ||
      (typeof msg?.user === "string" && msg.user) ||
      (typeof msg?.data?.data?.user === "string" && msg.data.data.user) ||
      (typeof msg?.data?.data?.clearinghouseState?.user === "string" && msg.data.data.clearinghouseState.user) ||
      null;

    const clearinghouseState =
      msg?.data?.clearinghouseState ||
      msg?.data?.data?.clearinghouseState ||
      msg?.data?.data?.clearinghouseState?.clearinghouseState ||
      msg?.data?.data?.clearinghouseState ||
      null;

    if (!user || !clearinghouseState) return;
    ingestClearinghouseState(user, clearinghouseState, receivedAtMs);
  }

  function getWalletPosition(user, coin) {
    const u = toUser(user);
    if (!u) return null;
    const c = toCoin(coin);
    const ws = walletState.get(u);
    if (!ws) return null;
    return ws.positions.get(c) || null;
  }

  function computeConsensusForSymbol({
    coin,
    topK,
    weights,
    eliteSet = null,
    nowMs,
    leaderMetadata = null,
  }) {
    const c = toCoin(coin);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const top = Array.isArray(topK) ? topK.map(toUser).filter(Boolean) : [];

    const wMap = weights instanceof Map ? weights : new Map(Object.entries(weights || {}).map(([k, v]) => [toUser(k), num(v, 0)]));
    const elite = eliteSet ? new Set(Array.from(eliteSet).map(toUser).filter(Boolean)) : null;
    const metaMap = toLeaderMetadataMap(leaderMetadata) || cfg.leaderMetadata;

    let sumW = 0;
    let sumSigned = 0;
    let longWeight = 0;
    let shortWeight = 0;
    let longs = 0;
    let shorts = 0;
    let flats = 0;
    let stale = 0;
    let missing = 0;
    let zeroW = 0;

    const perWallet = [];
    const levValues = [];
    const usedWeights = [];
    const clusterWeights = new Map();
    const familyWeights = new Map();

    // Elite sub-consensus (optional)
    let eliteSumW = 0;
    let eliteSumSigned = 0;
    let eliteLongWeight = 0;
    let eliteShortWeight = 0;
    let eliteContrib = 0;
    const eliteWeights = [];
    let eliteLongs = 0;
    let eliteShorts = 0;
    const eliteClusterWeights = new Map();
    const eliteFamilyWeights = new Map();

    for (const u of top) {
      const w0 = num(wMap.get(u), 0);
      if (w0 <= 0) {
        zeroW += 1;
        continue;
      }

      const ws = walletState.get(u);
      if (!ws) {
        missing += 1;
        continue;
      }

      if (now - num(ws.lastUpdateMs, 0) > cfg.staleMs) {
        stale += 1;
        continue;
      }

      const pos = ws.positions.get(c) || null;
      const szi = num(pos?.szi, 0);
      const dir = szi > 0 ? 1 : szi < 0 ? -1 : 0;
      if (dir === 0) {
        flats += 1;
        continue;
      }

      const convictionMult = computeConvictionMultiplier(pos?.positionValue, cfg);
      if (convictionMult <= 0) continue;
      const w = w0 * convictionMult;
      const leaderMeta = metaMap?.get(u) || null;
      const clusterId = normalizeMetaId(
        leaderMeta?.clusterId ?? leaderMeta?.cluster ?? leaderMeta?.similarityCluster
      );
      const familyId = normalizeMetaId(
        leaderMeta?.familyId ?? leaderMeta?.family ?? leaderMeta?.strategyFamily
      );

      sumW += w;
      sumSigned += w * dir;
      usedWeights.push(w);

      if (dir > 0) longs += 1;
      else shorts += 1;
      if (dir > 0) longWeight += w;
      else shortWeight += w;
      if (clusterId) clusterWeights.set(clusterId, num(clusterWeights.get(clusterId), 0) + w);
      if (familyId) familyWeights.set(familyId, num(familyWeights.get(familyId), 0) + w);

      const isElite = elite ? elite.has(u) : false;
      if (cfg.eliteEnabled && isElite) {
        eliteSumW += w;
        eliteSumSigned += w * dir;
        eliteContrib += 1;
        eliteWeights.push(w);
        if (dir > 0) {
          eliteLongWeight += w;
          eliteLongs += 1;
        } else {
          eliteShortWeight += w;
          eliteShorts += 1;
        }
        if (clusterId) {
          eliteClusterWeights.set(clusterId, num(eliteClusterWeights.get(clusterId), 0) + w);
        }
        if (familyId) {
          eliteFamilyWeights.set(familyId, num(eliteFamilyWeights.get(familyId), 0) + w);
        }
      }

      perWallet.push({
        user: u,
        dir,
        weightBase: w0,
        convictionMult,
        weightEffective: w,
        positionValue: pos?.positionValue ?? null,
        leverage: pos?.leverage ?? null,
        clusterId,
        familyId,
      });

      const lev = num(pos?.leverage, null);
      if (Number.isFinite(lev) && lev > 0) {
        levValues.push(lev);
      }
    }

    const contributors = longs + shorts;
    const consensus = sumW > 0 ? sumSigned / sumW : 0;
    const dispersion = contributors > 0 ? 1 - Math.abs(longs - shorts) / contributors : 1;
    const effectiveN = computeEffectiveSampleSize(usedWeights);

    const eliteConsensus = eliteSumW > 0 ? eliteSumSigned / eliteSumW : 0;
    const eliteEffectiveN = computeEffectiveSampleSize(eliteWeights);
    const { hhi, maxWeightShare } = computeWeightConcentration(usedWeights);
    const {
      hhi: eliteHhi,
      maxWeightShare: eliteMaxWeightShare,
    } = computeWeightConcentration(eliteWeights);
    const clusterMeta = summarizeWeightedGroups(clusterWeights, sumW);
    const familyMeta = summarizeWeightedGroups(familyWeights, sumW);
    const eliteClusterMeta = summarizeWeightedGroups(eliteClusterWeights, eliteSumW);
    const eliteFamilyMeta = summarizeWeightedGroups(eliteFamilyWeights, eliteSumW);

    // Confidence is deliberately conservative: magnitude * sqrt(ESS / minEffectiveN), clamped.
    const conf = clamp(Math.abs(consensus) * Math.sqrt(effectiveN / Math.max(cfg.minEffectiveN, 1e-9)), 0, 1);
    const eliteConf = clamp(
      Math.abs(eliteConsensus) *
        Math.sqrt(eliteEffectiveN / Math.max(Math.min(cfg.minEffectiveN, 1), 1e-9)),
      0,
      1
    );
    let leaderLeverage = null;
    let leaderLeverageSamples = levValues.length;
    if (leaderLeverageSamples > 0) {
      levValues.sort((a, b) => a - b);
      const mid = Math.floor(leaderLeverageSamples / 2);
      leaderLeverage =
        leaderLeverageSamples % 2 === 1
          ? levValues[mid]
          : (levValues[mid - 1] + levValues[mid]) / 2;
    }

    // Default gate: need enough contributors and ESS to act.
    const ok = contributors >= cfg.minLeaders && effectiveN >= cfg.minEffectiveN && sumW > 0;

    // Elite path gate: allows action when overall confluence is weak but elite is strong.
    // We still cap elite dominance by requiring that elite weight share is not extreme.
    const eliteWeightShare = sumW > 0 ? eliteSumW / sumW : 0;
    const eliteOk =
      cfg.eliteEnabled &&
      elite &&
      eliteContrib >= cfg.eliteMinLeaders &&
      eliteEffectiveN >= Math.min(cfg.minEffectiveN, 1) &&
      Math.abs(eliteConsensus) >= cfg.eliteMinConsensusAbs &&
      eliteWeightShare <= cfg.eliteMaxWeightShare;

    return {
      coin: c,
      consensus,
      contributors,
      longs,
      shorts,
      flats,
      sumWeight: sumW,
      effectiveN,
      dispersion,
      confidence: conf,
      hhi,
      maxWeightShare,
      clusterCount: clusterMeta.count,
      maxClusterWeightShare: clusterMeta.maxWeightShare,
      dominantCluster: clusterMeta.dominant,
      familyCount: familyMeta.count,
      maxFamilyWeightShare: familyMeta.maxWeightShare,
      dominantFamily: familyMeta.dominant,
      longWeightShare: sumW > 0 ? longWeight / sumW : 0,
      shortWeightShare: sumW > 0 ? shortWeight / sumW : 0,
      leaderLeverage,
      leaderLeverageSamples,
      excluded: { stale, missing, zeroWeight: zeroW },
      elite: {
        enabled: !!elite,
        contributors: eliteContrib,
        sumWeight: eliteSumW,
        weightShare: eliteWeightShare,
        consensus: eliteConsensus,
        effectiveN: eliteEffectiveN,
        confidence: eliteConf,
        hhi: eliteHhi,
        maxWeightShare: eliteMaxWeightShare,
        clusterCount: eliteClusterMeta.count,
        maxClusterWeightShare: eliteClusterMeta.maxWeightShare,
        dominantCluster: eliteClusterMeta.dominant,
        familyCount: eliteFamilyMeta.count,
        maxFamilyWeightShare: eliteFamilyMeta.maxWeightShare,
        dominantFamily: eliteFamilyMeta.dominant,
        longWeightShare: eliteSumW > 0 ? eliteLongWeight / eliteSumW : 0,
        shortWeightShare: eliteSumW > 0 ? eliteShortWeight / eliteSumW : 0,
        dispersion:
          eliteContrib > 0 ? 1 - Math.abs(eliteLongs - eliteShorts) / eliteContrib : 1,
        ok: eliteOk,
      },
      ok,
      perWallet,
    };
  }

  return {
    config: cfg,
    ingestWsMessage,
    ingestClearinghouseState,
    getWalletPosition,
    computeConsensusForSymbol,
    _state: walletState,
  };
}

module.exports = {
  createCopyTradingConsensusEngine,
  extractPositionsFromClearinghouseState,
  computeConvictionMultiplier,
  computeEffectiveSampleSize,
};
