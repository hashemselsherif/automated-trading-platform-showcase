"use strict";

const fs = require("fs");

const { normalizeSnapshots } = require("./hyperliquid-ws-cache");
const { normalizeSymbol, normalizeWallet } = require("./copy-trading-event-dataset");

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function getSessionBucket(ts) {
  const time = Number(ts);
  if (!Number.isFinite(time)) return "unknown";
  const hour = new Date(time).getUTCHours();
  if (hour < 8) return "asia";
  if (hour < 16) return "europe";
  return "us";
}

function normalizeSymbolSet(symbols) {
  const normalized = (Array.isArray(symbols) ? symbols : []).map(normalizeSymbol).filter(Boolean);
  return normalized.length ? new Set(normalized) : null;
}

function normalizeSide(side) {
  const normalized = String(side || "")
    .trim()
    .toLowerCase();
  if (normalized === "long") return "long";
  if (normalized === "short") return "short";
  return null;
}

function normalizeHorizonKey(value, fallback = "6h") {
  const text = String(value || fallback).trim();
  return text || fallback;
}

function ensureStats(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      resolvedCount: 0,
      positiveCount: 0,
      netPnlUsdSum: 0,
      netReturnPctSum: 0,
    });
  }
  return map.get(key);
}

function updateStats(stats, label) {
  if (!stats || !label) return stats;
  stats.resolvedCount += 1;
  stats.netPnlUsdSum += num(label.netPnlUsd, 0);
  stats.netReturnPctSum += num(label.netReturnPct, 0);
  if (num(label.netPnlUsd, 0) > 0) stats.positiveCount += 1;
  return stats;
}

function finalizeStats(stats) {
  const resolvedCount = num(stats?.resolvedCount, 0);
  const positiveCount = num(stats?.positiveCount, 0);
  const meanNetPnlUsd = resolvedCount > 0 ? num(stats?.netPnlUsdSum, 0) / resolvedCount : null;
  const meanNetReturnPct =
    resolvedCount > 0 ? num(stats?.netReturnPctSum, 0) / resolvedCount : null;
  const winRate = resolvedCount > 0 ? positiveCount / resolvedCount : null;
  const countScore = clamp(Math.tanh(resolvedCount / 8), 0, 1);
  const pnlScore =
    meanNetPnlUsd == null ? 0.5 : clamp(0.5 + 0.5 * Math.tanh(meanNetPnlUsd / 10), 0, 1);
  const winScore = winRate == null ? 0.5 : clamp(winRate, 0, 1);
  return {
    resolvedCount,
    positiveCount,
    winRate,
    meanNetPnlUsd,
    meanNetReturnPct,
    qualityScore: clamp(0.4 * pnlScore + 0.4 * winScore + 0.2 * countScore, 0, 1),
    available: resolvedCount > 0,
  };
}

function summarizeWeights(weights) {
  let sum = 0;
  let sumSq = 0;
  let maxWeight = 0;
  for (const weight of weights) {
    const w = num(weight, 0);
    if (!(w > 0)) continue;
    sum += w;
    sumSq += w * w;
    if (w > maxWeight) maxWeight = w;
  }
  if (!(sum > 0)) {
    return {
      effectiveN: 0,
      hhi: null,
      maxWeightShare: null,
    };
  }
  return {
    effectiveN: sumSq > 0 ? (sum * sum) / sumSq : 0,
    hhi: sumSq / (sum * sum),
    maxWeightShare: maxWeight / sum,
  };
}

function buildEmptyClusterConfluenceContext(sourceClusterId = null) {
  return {
    clusterConfluenceAvailable: false,
    clusterConfluenceSourceClusterId: sourceClusterId,
    clusterConfluenceContributors: 0,
    clusterConfluencePeerCount: 0,
    clusterConfluenceEffectiveN: 0,
    clusterConfluenceConsensus: null,
    clusterConfluenceAbsConsensus: null,
    clusterConfluenceDirection: "neutral",
    clusterConfluenceAligned: null,
    clusterConfluenceWeightShare: null,
    clusterConfluenceExSourceAvailable: false,
    clusterConfluenceExSourceContributors: 0,
    clusterConfluenceExSourceEffectiveN: 0,
    clusterConfluenceExSourceConsensus: null,
    clusterConfluenceExSourceAbsConsensus: null,
    clusterConfluenceExSourceDirection: "neutral",
    clusterConfluenceExSourceAligned: null,
    clusterConfluenceExSourceWeightShare: null,
  };
}

function summarizeConfluenceEntries(entries, normalizedSide, knownWeight) {
  if (!Array.isArray(entries) || !entries.length) {
    return {
      available: false,
      contributors: 0,
      effectiveN: 0,
      consensus: null,
      absConsensus: null,
      direction: "neutral",
      aligned: null,
      weightShare: null,
    };
  }
  const totalWeight = entries.reduce((sum, entry) => sum + num(entry.weight, 0), 0);
  const signedWeight = entries.reduce(
    (sum, entry) => sum + Math.sign(num(entry.szi, 0)) * num(entry.weight, 0),
    0
  );
  const consensus = totalWeight > 0 ? clamp(signedWeight / totalWeight, -1, 1) : null;
  const absConsensus = consensus == null ? null : Math.abs(consensus);
  const direction = consensus > 0 ? "long" : consensus < 0 ? "short" : "neutral";
  return {
    available: true,
    contributors: entries.length,
    effectiveN: summarizeWeights(entries.map((entry) => entry.weight)).effectiveN,
    consensus,
    absConsensus,
    direction,
    aligned:
      normalizedSide && direction !== "neutral"
        ? direction === normalizedSide
        : normalizedSide
          ? false
          : null,
    weightShare: knownWeight > 0 ? totalWeight / knownWeight : null,
  };
}

function loadLeaderMetadataFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const raw =
    parsed && parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : parsed;
  const entries = [];
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const wallet = normalizeWallet(row?.wallet || row?.user || row?.address);
      if (!wallet) continue;
      entries.push([wallet, row]);
    }
  } else if (raw && typeof raw === "object") {
    for (const [walletRaw, value] of Object.entries(raw)) {
      const wallet = normalizeWallet(walletRaw);
      if (!wallet || !value || typeof value !== "object") continue;
      entries.push([wallet, value]);
    }
  }
  return entries.length ? new Map(entries) : null;
}

function normalizeLeaderMetadata(source) {
  if (!source) return null;
  if (source instanceof Map) return source;
  if (typeof source !== "object") return null;
  return loadLeaderMetadataObject(source);
}

function loadLeaderMetadataObject(raw) {
  const entries = [];
  for (const [walletRaw, value] of Object.entries(raw || {})) {
    const wallet = normalizeWallet(walletRaw);
    if (!wallet || !value || typeof value !== "object") continue;
    entries.push([wallet, value]);
  }
  return entries.length ? new Map(entries) : null;
}

function buildSnapshotContextTracker(snapshots, symbols = null) {
  const normalized = normalizeSnapshots(snapshots, {
    symbols: symbols ? Array.from(normalizeSymbolSet(symbols) || []) : null,
  });
  const walletPositions = new Map();
  const activeBySymbol = new Map();
  const lastUpdateByWallet = new Map();
  let index = 0;

  function setSymbolState(wallet, symbol, position) {
    if (!activeBySymbol.has(symbol)) activeBySymbol.set(symbol, new Map());
    const perSymbol = activeBySymbol.get(symbol);
    if (!position || Math.abs(num(position.szi, 0)) <= 1e-9) {
      perSymbol.delete(wallet);
      if (!perSymbol.size) activeBySymbol.delete(symbol);
      return;
    }
    perSymbol.set(wallet, {
      wallet,
      symbol,
      szi: num(position.szi, 0),
      entryPx: position.entryPx == null ? null : num(position.entryPx, null),
      positionValue:
        position.positionValue == null
          ? Math.abs(num(position.szi, 0) * num(position.entryPx, 0))
          : Math.abs(num(position.positionValue, 0)),
    });
  }

  function applySnapshot(snapshot) {
    const wallet = normalizeWallet(snapshot?.user);
    if (!wallet) return;
    const previous = walletPositions.get(wallet) || new Map();
    const next = new Map();
    for (const position of Array.isArray(snapshot?.positions) ? snapshot.positions : []) {
      const symbol = normalizeSymbol(position?.coin || position?.symbol);
      if (!symbol) continue;
      const normalizedPosition = {
        szi: num(position?.szi, 0),
        entryPx: position?.entryPx == null ? null : num(position.entryPx, null),
        positionValue:
          position?.positionValue == null ? null : Math.abs(num(position.positionValue, 0)),
      };
      next.set(symbol, normalizedPosition);
    }

    const affectedSymbols = new Set([...previous.keys(), ...next.keys()]);
    for (const symbol of affectedSymbols) {
      setSymbolState(wallet, symbol, next.get(symbol) || null);
    }

    walletPositions.set(wallet, next);
    lastUpdateByWallet.set(wallet, num(snapshot.ts, 0));
  }

  return {
    advanceTo(ts) {
      while (index < normalized.length && num(normalized[index].ts, 0) <= ts) {
        applySnapshot(normalized[index]);
        index += 1;
      }
    },
    getSymbolState(symbol) {
      return activeBySymbol.get(normalizeSymbol(symbol)) || new Map();
    },
    getLastUpdate(wallet) {
      return lastUpdateByWallet.get(normalizeWallet(wallet)) ?? null;
    },
  };
}

function buildEventContextTracker() {
  const activeBySymbol = new Map();
  const lastUpdateByWallet = new Map();

  function applyEvent(event) {
    const wallet = normalizeWallet(event?.wallet || event?.user);
    const symbol = normalizeSymbol(event?.symbol || event?.coin);
    if (!wallet || !symbol) return;
    if (!activeBySymbol.has(symbol)) activeBySymbol.set(symbol, new Map());
    const perSymbol = activeBySymbol.get(symbol);
    const nextPos = num(event?.nextPos, 0);
    if (Math.abs(nextPos) <= 1e-9) {
      perSymbol.delete(wallet);
      if (!perSymbol.size) activeBySymbol.delete(symbol);
    } else {
      const entryPx =
        event?.nextEntryPx == null ? num(event?.price, null) : num(event.nextEntryPx, null);
      perSymbol.set(wallet, {
        wallet,
        symbol,
        szi: nextPos,
        entryPx,
        positionValue: Math.abs(nextPos) * Math.abs(num(entryPx, 0)),
      });
    }
    lastUpdateByWallet.set(wallet, num(event?.ts ?? event?.time, 0));
  }

  return {
    applyEvent,
    getSymbolState(symbol) {
      return activeBySymbol.get(normalizeSymbol(symbol)) || new Map();
    },
    getLastUpdate(wallet) {
      return lastUpdateByWallet.get(normalizeWallet(wallet)) ?? null;
    },
  };
}

function buildMetadataContext(activeEntries, leaderMetadata) {
  if (!(leaderMetadata instanceof Map)) {
    return {
      clusterCount: null,
      maxClusterWeightShare: null,
      familyCount: null,
      maxFamilyWeightShare: null,
      clusterCoverageRatio: 0,
      familyCoverageRatio: 0,
      clusterContextAvailable: false,
      familyContextAvailable: false,
    };
  }

  const clusterWeights = new Map();
  const familyWeights = new Map();
  let totalWeight = 0;
  let clusterKnown = 0;
  let familyKnown = 0;

  for (const entry of activeEntries) {
    const wallet = normalizeWallet(entry.wallet);
    const weight = num(entry.weight, 0);
    if (!(weight > 0)) continue;
    totalWeight += weight;
    const meta = leaderMetadata.get(wallet) || {};
    const clusterId =
      meta.clusterId != null && meta.clusterId !== ""
        ? String(meta.clusterId)
        : `unknown:${wallet}`;
    const familyId =
      meta.familyId != null && meta.familyId !== "" ? String(meta.familyId) : `unknown:${wallet}`;
    if (!String(clusterId).startsWith("unknown:")) clusterKnown += 1;
    if (!String(familyId).startsWith("unknown:")) familyKnown += 1;
    clusterWeights.set(clusterId, num(clusterWeights.get(clusterId), 0) + weight);
    familyWeights.set(familyId, num(familyWeights.get(familyId), 0) + weight);
  }

  const maxClusterWeightShare =
    totalWeight > 0
      ? Math.max(...Array.from(clusterWeights.values()).map((value) => value / totalWeight))
      : null;
  const maxFamilyWeightShare =
    totalWeight > 0
      ? Math.max(...Array.from(familyWeights.values()).map((value) => value / totalWeight))
      : null;

  return {
    clusterCount: clusterWeights.size || null,
    maxClusterWeightShare,
    familyCount: familyWeights.size || null,
    maxFamilyWeightShare,
    clusterCoverageRatio: activeEntries.length ? clusterKnown / activeEntries.length : 0,
    familyCoverageRatio: activeEntries.length ? familyKnown / activeEntries.length : 0,
    clusterContextAvailable: activeEntries.length > 0,
    familyContextAvailable: activeEntries.length > 0,
  };
}

function buildClusterConfluenceContext(activeEntries, leaderMetadata, sourceWallet, eventSide) {
  const normalizedWallet = normalizeWallet(sourceWallet);
  const normalizedSide = normalizeSide(eventSide);
  if (!(leaderMetadata instanceof Map) || !normalizedWallet) {
    return buildEmptyClusterConfluenceContext();
  }

  const sourceClusterIdRaw = leaderMetadata.get(normalizedWallet)?.clusterId;
  const sourceClusterId =
    sourceClusterIdRaw != null && sourceClusterIdRaw !== "" ? String(sourceClusterIdRaw) : null;
  if (!sourceClusterId) {
    return buildEmptyClusterConfluenceContext();
  }

  let knownWeight = 0;
  const sourceClusterEntries = [];
  for (const entry of Array.isArray(activeEntries) ? activeEntries : []) {
    const wallet = normalizeWallet(entry?.wallet);
    const weight = num(entry?.weight, 0);
    if (!wallet || !(weight > 0)) continue;
    const clusterIdRaw = leaderMetadata.get(wallet)?.clusterId;
    const clusterId = clusterIdRaw != null && clusterIdRaw !== "" ? String(clusterIdRaw) : null;
    if (!clusterId) continue;
    knownWeight += weight;
    if (clusterId !== sourceClusterId) continue;
    sourceClusterEntries.push({
      wallet,
      weight,
      szi: num(entry?.szi, 0),
    });
  }

  if (!sourceClusterEntries.length) {
    return buildEmptyClusterConfluenceContext(sourceClusterId);
  }
  const peerEntries = sourceClusterEntries.filter((entry) => entry.wallet !== normalizedWallet);
  const allMetrics = summarizeConfluenceEntries(sourceClusterEntries, normalizedSide, knownWeight);
  const peerMetrics = summarizeConfluenceEntries(peerEntries, normalizedSide, knownWeight);
  return {
    clusterConfluenceAvailable: allMetrics.available,
    clusterConfluenceSourceClusterId: sourceClusterId,
    clusterConfluenceContributors: allMetrics.contributors,
    clusterConfluencePeerCount: peerEntries.length,
    clusterConfluenceEffectiveN: allMetrics.effectiveN,
    clusterConfluenceConsensus: allMetrics.consensus,
    clusterConfluenceAbsConsensus: allMetrics.absConsensus,
    clusterConfluenceDirection: allMetrics.direction,
    clusterConfluenceAligned: allMetrics.aligned,
    clusterConfluenceWeightShare: allMetrics.weightShare,
    clusterConfluenceExSourceAvailable: peerMetrics.available,
    clusterConfluenceExSourceContributors: peerMetrics.contributors,
    clusterConfluenceExSourceEffectiveN: peerMetrics.effectiveN,
    clusterConfluenceExSourceConsensus: peerMetrics.consensus,
    clusterConfluenceExSourceAbsConsensus: peerMetrics.absConsensus,
    clusterConfluenceExSourceDirection: peerMetrics.direction,
    clusterConfluenceExSourceAligned: peerMetrics.aligned,
    clusterConfluenceExSourceWeightShare: peerMetrics.weightShare,
  };
}

function getLatestCloseBeforeTs(candlesBySymbol, symbol, ts) {
  const candles = candlesBySymbol.get(symbol) || [];
  if (!candles.length) return null;
  let lo = 0;
  let hi = candles.length - 1;
  let lastIndex = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (num(candles[mid].ts, 0) <= ts) {
      lastIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return lastIndex >= 0 ? num(candles[lastIndex].close, null) : null;
}

function computeRegimeFeatures(candlesBySymbol, symbol, ts, lookbackBars) {
  const candles = candlesBySymbol.get(symbol) || [];
  if (!candles.length) {
    return {
      regimeReady: false,
      regimeAvailable: false,
      recentReturnPct: null,
      realizedVolPct: null,
      trendStrength: null,
      recentReturnBucket: null,
      realizedVolBucket: null,
    };
  }

  let lo = 0;
  let hi = candles.length - 1;
  let lastIndex = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (num(candles[mid].ts, 0) <= ts) {
      lastIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (lastIndex < 0) {
    return {
      regimeReady: false,
      regimeAvailable: false,
      recentReturnPct: null,
      realizedVolPct: null,
      trendStrength: null,
      recentReturnBucket: null,
      realizedVolBucket: null,
    };
  }

  const startIndex = Math.max(0, lastIndex - Math.max(1, lookbackBars) + 1);
  const window = candles.slice(startIndex, lastIndex + 1);
  const closes = window.map((candle) => num(candle.close, null)).filter(Number.isFinite);
  const regimeReady = closes.length >= Math.max(2, lookbackBars);
  if (closes.length < 2) {
    return {
      regimeReady,
      regimeAvailable: true,
      recentReturnPct: null,
      realizedVolPct: null,
      trendStrength: null,
      recentReturnBucket: null,
      realizedVolBucket: null,
    };
  }

  const startClose = closes[0];
  const endClose = closes[closes.length - 1];
  const recentReturnPct = ((endClose - startClose) / startClose) * 100;
  const logReturns = [];
  for (let index = 1; index < closes.length; index += 1) {
    const prev = closes[index - 1];
    const current = closes[index];
    if (!(prev > 0) || !(current > 0)) continue;
    logReturns.push(Math.log(current / prev));
  }
  const realizedVolPct =
    logReturns.length > 0
      ? Math.sqrt(logReturns.reduce((sum, value) => sum + value * value, 0) / logReturns.length) *
        100
      : 0;
  const trendStrength =
    realizedVolPct > 0 ? Math.abs(recentReturnPct) / realizedVolPct : Math.abs(recentReturnPct);
  return {
    regimeReady,
    regimeAvailable: true,
    recentReturnPct,
    realizedVolPct,
    trendStrength,
    recentReturnBucket: recentReturnPct > 0.5 ? "up" : recentReturnPct < -0.5 ? "down" : "flat",
    realizedVolBucket: realizedVolPct > 2 ? "high" : realizedVolPct > 0.75 ? "medium" : "low",
  };
}

function createCandleIndex(candles) {
  const out = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const symbol = normalizeSymbol(candle?.symbol || candle?.coin);
    if (!symbol) continue;
    if (!out.has(symbol)) out.set(symbol, []);
    out.get(symbol).push({
      ts: num(candle?.ts ?? candle?.time, 0),
      close: num(candle?.close ?? candle?.px, null),
    });
  }
  for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
  return out;
}

function summarizeFeatureAvailability(events) {
  const all = Array.isArray(events) ? events : [];
  return {
    eventCount: all.length,
    leaderHistoryAvailable: all.filter((event) => event.features?.leaderHistoryAvailable).length,
    symbolHistoryAvailable: all.filter((event) => event.features?.symbolHistoryAvailable).length,
    regimeReady: all.filter((event) => event.features?.regimeReady).length,
    snapshotBacked: all.filter((event) => event.features?.snapshotBacked).length,
    clusterContextAvailable: all.filter((event) => event.features?.clusterContextAvailable).length,
    familyContextAvailable: all.filter((event) => event.features?.familyContextAvailable).length,
    clusterConfluenceAvailable: all.filter((event) => event.features?.clusterConfluenceAvailable)
      .length,
    referencePriceAvailable: all.filter((event) => event.features?.referencePriceAvailable).length,
  };
}

function buildFeaturedLeaderEventDataset(
  dataset,
  {
    snapshots = null,
    candles = null,
    primaryHorizon = "6h",
    regimeLookbackBars = 24,
    feeBps = 6,
    slippageBps = 8,
    leaderMetadata = null,
  } = {}
) {
  const events = Array.isArray(dataset?.events)
    ? dataset.events
        .map((event) => ({
          ...event,
          wallet: normalizeWallet(event?.wallet || event?.user),
          user: normalizeWallet(event?.wallet || event?.user),
          symbol: normalizeSymbol(event?.symbol || event?.coin),
          coin: normalizeSymbol(event?.symbol || event?.coin),
          ts: num(event?.ts ?? event?.time, null),
          time: num(event?.ts ?? event?.time, null),
          side: normalizeSide(event?.side),
        }))
        .filter((event) => event.wallet && event.symbol && Number.isFinite(event.ts))
        .sort(
          (a, b) =>
            a.ts - b.ts || a.wallet.localeCompare(b.wallet) || a.symbol.localeCompare(b.symbol)
        )
    : [];

  const horizonKey = normalizeHorizonKey(primaryHorizon);
  const candleIndex = createCandleIndex(candles);
  const metadataMap = normalizeLeaderMetadata(leaderMetadata);
  const snapshotTracker =
    Array.isArray(snapshots) && snapshots.length ? buildSnapshotContextTracker(snapshots) : null;
  const eventTracker = snapshotTracker ? null : buildEventContextTracker();

  const walletStats = new Map();
  const walletSymbolStats = new Map();
  const walletSideStats = new Map();
  const walletSymbolSideStats = new Map();
  const pendingResolved = [];

  function resolvePending(currentTs) {
    pendingResolved.sort((a, b) => a.resolveTs - b.resolveTs);
    while (pendingResolved.length && num(pendingResolved[0].resolveTs, Infinity) <= currentTs) {
      const item = pendingResolved.shift();
      updateStats(ensureStats(walletStats, item.wallet), item.label);
      updateStats(ensureStats(walletSymbolStats, `${item.wallet}:${item.symbol}`), item.label);
      updateStats(ensureStats(walletSideStats, `${item.wallet}:${item.side}`), item.label);
      updateStats(
        ensureStats(walletSymbolSideStats, `${item.wallet}:${item.symbol}:${item.side}`),
        item.label
      );
    }
  }

  const featuredEvents = [];
  const lastEventTsByWalletSymbol = new Map();

  for (const event of events) {
    resolvePending(event.ts);

    const walletHistory = finalizeStats(walletStats.get(event.wallet));
    const symbolHistory = finalizeStats(walletSymbolStats.get(`${event.wallet}:${event.symbol}`));
    const sideHistory = finalizeStats(walletSideStats.get(`${event.wallet}:${event.side}`));
    const symbolSideHistory = finalizeStats(
      walletSymbolSideStats.get(`${event.wallet}:${event.symbol}:${event.side}`)
    );

    const tracker = snapshotTracker || eventTracker;
    const priorWalletUpdateTs = tracker ? tracker.getLastUpdate(event.wallet) : null;
    const priorWalletSymbolEventTs =
      lastEventTsByWalletSymbol.get(`${event.wallet}:${event.symbol}`) ?? null;
    if (snapshotTracker) snapshotTracker.advanceTo(event.ts);
    if (eventTracker) eventTracker.applyEvent(event);
    const activeState = tracker ? Array.from(tracker.getSymbolState(event.symbol).values()) : [];
    const weightedActive = activeState.map((position) => {
      const history = finalizeStats(walletStats.get(position.wallet));
      const historyWeight = history.available ? Math.max(0.25, history.qualityScore) : 0.5;
      const positionWeight = Math.max(
        1e-6,
        Math.abs(num(position.positionValue, Math.abs(num(position.szi, 0))))
      );
      return {
        ...position,
        historyQualityScore: history.qualityScore,
        weight: historyWeight * positionWeight,
      };
    });

    const contributors = weightedActive.length;
    const longContributors = weightedActive.filter((position) => num(position.szi, 0) > 0).length;
    const shortContributors = weightedActive.filter((position) => num(position.szi, 0) < 0).length;
    const weightSummary = summarizeWeights(weightedActive.map((position) => position.weight));
    const metadataContext = buildMetadataContext(weightedActive, metadataMap);
    const clusterConfluence = buildClusterConfluenceContext(
      weightedActive,
      metadataMap,
      event.wallet,
      event.side
    );
    const regimeFeatures = computeRegimeFeatures(
      candleIndex,
      event.symbol,
      event.ts,
      Math.max(2, num(regimeLookbackBars, 24))
    );
    const recentReturnPct = regimeFeatures.recentReturnPct;
    const sideAligned =
      recentReturnPct == null
        ? null
        : event.side === "long"
          ? recentReturnPct >= 0
          : event.side === "short"
            ? recentReturnPct <= 0
            : null;
    const lastUpdateTs = tracker ? tracker.getLastUpdate(event.wallet) : null;
    const staleStateDistanceMs =
      Number.isFinite(lastUpdateTs) && Number.isFinite(event.ts) ? event.ts - lastUpdateTs : null;
    const sourceEventGapMs =
      Number.isFinite(priorWalletSymbolEventTs) && Number.isFinite(event.ts)
        ? Math.max(0, event.ts - priorWalletSymbolEventTs)
        : null;
    const marketPrice = getLatestCloseBeforeTs(candleIndex, event.symbol, event.ts);
    const referencePrice = Number.isFinite(num(event?.price, null))
      ? num(event.price, null)
      : Number.isFinite(num(event?.nextEntryPx, null))
        ? num(event.nextEntryPx, null)
        : Number.isFinite(num(event?.prevEntryPx, null))
          ? num(event.prevEntryPx, null)
          : null;
    const referencePriceAvailable = Number.isFinite(referencePrice);
    const referenceDriftBps =
      Number.isFinite(referencePrice) && Number.isFinite(marketPrice) && marketPrice > 0
        ? (Math.abs(referencePrice - marketPrice) / marketPrice) * 10_000
        : null;
    const peerLatestUpdateTs = weightedActive.reduce((best, position) => {
      const wallet = normalizeWallet(position.wallet);
      if (!wallet || wallet === event.wallet) return best;
      const updateTs = tracker ? tracker.getLastUpdate(wallet) : null;
      if (!Number.isFinite(updateTs)) return best;
      if (!Number.isFinite(best)) return updateTs;
      return Math.max(best, updateTs);
    }, null);
    const peerStateLagMs =
      Number.isFinite(peerLatestUpdateTs) && Number.isFinite(event.ts)
        ? Math.max(0, event.ts - peerLatestUpdateTs)
        : null;
    const sourcePriorUpdateGapMs =
      Number.isFinite(priorWalletUpdateTs) && Number.isFinite(event.ts)
        ? Math.max(0, event.ts - priorWalletUpdateTs)
        : null;

    const features = {
      eventType: event.eventType,
      symbol: event.symbol,
      side: event.side,
      eventDeltaAbs: Math.abs(num(event.deltaAbs, Math.abs(num(event.deltaPos, 0)))),
      eventDeltaPctOfPrevAbs:
        event.deltaPctOfPrevAbs == null ? null : num(event.deltaPctOfPrevAbs, null),
      isFlipEvent: event.isFlipEvent === true,
      isEntryEvent: event.isEntryEvent === true,
      snapshotBacked: event.stateSource === "snapshots",
      fillInferred: event.stateSource === "fills",
      leaderHistoryAvailable: walletHistory.available,
      symbolHistoryAvailable: symbolHistory.available,
      walletResolvedCount: walletHistory.resolvedCount,
      walletMeanNetPnlUsd: walletHistory.meanNetPnlUsd,
      walletWinRate: walletHistory.winRate,
      walletQualityScore: walletHistory.qualityScore,
      symbolResolvedCount: symbolHistory.resolvedCount,
      symbolMeanNetPnlUsd: symbolHistory.meanNetPnlUsd,
      symbolWinRate: symbolHistory.winRate,
      symbolQualityScore: symbolHistory.qualityScore,
      sideResolvedCount: sideHistory.resolvedCount,
      sideMeanNetPnlUsd: sideHistory.meanNetPnlUsd,
      sideQualityScore: sideHistory.qualityScore,
      symbolSideResolvedCount: symbolSideHistory.resolvedCount,
      symbolSideMeanNetPnlUsd: symbolSideHistory.meanNetPnlUsd,
      symbolSideQualityScore: symbolSideHistory.qualityScore,
      activeContributors: contributors,
      activeLongContributors: longContributors,
      activeShortContributors: shortContributors,
      activeEffectiveN: weightSummary.effectiveN,
      activeHhi: weightSummary.hhi,
      activeMaxWeightShare: weightSummary.maxWeightShare,
      clusterCount: metadataContext.clusterCount,
      maxClusterWeightShare: metadataContext.maxClusterWeightShare,
      familyCount: metadataContext.familyCount,
      maxFamilyWeightShare: metadataContext.maxFamilyWeightShare,
      clusterCoverageRatio: metadataContext.clusterCoverageRatio,
      familyCoverageRatio: metadataContext.familyCoverageRatio,
      clusterContextAvailable: metadataContext.clusterContextAvailable,
      familyContextAvailable: metadataContext.familyContextAvailable,
      clusterConfluenceAvailable: clusterConfluence.clusterConfluenceAvailable,
      clusterConfluenceSourceClusterId: clusterConfluence.clusterConfluenceSourceClusterId,
      clusterConfluenceContributors: clusterConfluence.clusterConfluenceContributors,
      clusterConfluencePeerCount: clusterConfluence.clusterConfluencePeerCount,
      clusterConfluenceEffectiveN: clusterConfluence.clusterConfluenceEffectiveN,
      clusterConfluenceConsensus: clusterConfluence.clusterConfluenceConsensus,
      clusterConfluenceAbsConsensus: clusterConfluence.clusterConfluenceAbsConsensus,
      clusterConfluenceDirection: clusterConfluence.clusterConfluenceDirection,
      clusterConfluenceAligned: clusterConfluence.clusterConfluenceAligned,
      clusterConfluenceWeightShare: clusterConfluence.clusterConfluenceWeightShare,
      clusterConfluenceExSourceAvailable: clusterConfluence.clusterConfluenceExSourceAvailable,
      clusterConfluenceExSourceContributors:
        clusterConfluence.clusterConfluenceExSourceContributors,
      clusterConfluenceExSourceEffectiveN: clusterConfluence.clusterConfluenceExSourceEffectiveN,
      clusterConfluenceExSourceConsensus: clusterConfluence.clusterConfluenceExSourceConsensus,
      clusterConfluenceExSourceAbsConsensus:
        clusterConfluence.clusterConfluenceExSourceAbsConsensus,
      clusterConfluenceExSourceDirection: clusterConfluence.clusterConfluenceExSourceDirection,
      clusterConfluenceExSourceAligned: clusterConfluence.clusterConfluenceExSourceAligned,
      clusterConfluenceExSourceWeightShare: clusterConfluence.clusterConfluenceExSourceWeightShare,
      regimeReady: regimeFeatures.regimeReady,
      regimeAvailable: regimeFeatures.regimeAvailable,
      recentReturnPct: regimeFeatures.recentReturnPct,
      realizedVolPct: regimeFeatures.realizedVolPct,
      trendStrength: regimeFeatures.trendStrength,
      sessionBucket: getSessionBucket(event.ts),
      recentReturnBucket: regimeFeatures.recentReturnBucket,
      realizedVolBucket: regimeFeatures.realizedVolBucket,
      sideAlignedWithRecentReturn: sideAligned,
      feeDragBps: num(feeBps, 0),
      slippageDragBps: num(slippageBps, 0),
      totalTradingCostBps: num(feeBps, 0) + num(slippageBps, 0),
      staleStateDistanceMs,
      peerStateLagMs,
      sourcePriorUpdateGapMs,
      sourceEventGapMs,
      referencePriceAvailable,
      referenceDriftBps,
      contextStateSource: snapshotTracker ? "snapshots" : "event_reconstruction",
      primaryHorizon: horizonKey,
    };

    featuredEvents.push({ ...event, features });
    lastEventTsByWalletSymbol.set(`${event.wallet}:${event.symbol}`, event.ts);

    const label = event?.labels?.[horizonKey];
    if (label?.available && Number.isFinite(num(label.exitTs, null))) {
      pendingResolved.push({
        resolveTs: num(label.exitTs, null),
        wallet: event.wallet,
        symbol: event.symbol,
        side: event.side,
        label,
      });
    }
  }

  return {
    ...dataset,
    featureConfig: {
      primaryHorizon: horizonKey,
      regimeLookbackBars: Math.max(2, num(regimeLookbackBars, 24)),
      feeBps: num(feeBps, 0),
      slippageBps: num(slippageBps, 0),
      snapshotContextEnabled: !!snapshotTracker,
      leaderMetadataEnabled: metadataMap instanceof Map,
    },
    featureSummary: summarizeFeatureAvailability(featuredEvents),
    events: featuredEvents,
  };
}

module.exports = {
  buildFeaturedLeaderEventDataset,
  getSessionBucket,
  loadLeaderMetadataFile,
};
