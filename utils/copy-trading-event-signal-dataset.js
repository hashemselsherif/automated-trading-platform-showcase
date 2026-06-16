"use strict";

const fs = require("fs");
const path = require("path");

const { normalizeWalletAddress } = require("./copy-trading-cohort");
const { normalizeSymbol } = require("./copy-trading-event-dataset");

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringList(values, mapper = (value) => String(value || "").trim()) {
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

function getRegimeBucket(features = {}) {
  const trend = String(features.recentReturnBucket || "unknown")
    .trim()
    .toLowerCase();
  const vol = String(features.realizedVolBucket || "unknown")
    .trim()
    .toLowerCase();
  return `${trend}/${vol}`;
}

function normalizeEventSignalFilter(filter = {}) {
  return {
    wallets: parseStringList(filter.wallets, normalizeWalletAddress),
    symbols: parseStringList(filter.symbols, normalizeSymbol),
    sides: parseStringList(filter.sides, normalizeSide),
    eventTypes: parseStringList(filter.eventTypes, (value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    ),
    regimeBuckets: parseStringList(filter.regimeBuckets, (value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    ),
  };
}

function compactEventSignalFeatures(features = {}) {
  return {
    wallet: normalizeWalletAddress(features.wallet),
    eventType: features.eventType == null ? null : String(features.eventType).trim().toLowerCase(),
    symbol: normalizeSymbol(features.symbol),
    side: normalizeSide(features.side),
    isEntryEvent: features.isEntryEvent === true,
    isFlipEvent: features.isFlipEvent === true,
    snapshotBacked: features.snapshotBacked === true,
    fillInferred: features.fillInferred === true,
    walletResolvedCount: Math.max(0, num(features.walletResolvedCount, 0)),
    symbolResolvedCount: Math.max(0, num(features.symbolResolvedCount, 0)),
    walletQualityScore:
      features.walletQualityScore == null ? null : num(features.walletQualityScore, 0),
    symbolQualityScore:
      features.symbolQualityScore == null ? null : num(features.symbolQualityScore, 0),
    symbolSideQualityScore:
      features.symbolSideQualityScore == null ? null : num(features.symbolSideQualityScore, 0),
    activeContributors: Math.max(0, num(features.activeContributors, 0)),
    activeEffectiveN: features.activeEffectiveN == null ? null : num(features.activeEffectiveN, 0),
    activeMaxWeightShare:
      features.activeMaxWeightShare == null ? null : num(features.activeMaxWeightShare, 0),
    maxClusterWeightShare:
      features.maxClusterWeightShare == null ? null : num(features.maxClusterWeightShare, 0),
    clusterConfluenceAvailable: features.clusterConfluenceAvailable === true,
    clusterConfluenceContributors: Math.max(0, num(features.clusterConfluenceContributors, 0)),
    clusterConfluencePeerCount: Math.max(0, num(features.clusterConfluencePeerCount, 0)),
    clusterConfluenceEffectiveN:
      features.clusterConfluenceEffectiveN == null
        ? null
        : num(features.clusterConfluenceEffectiveN, 0),
    clusterConfluenceConsensus:
      features.clusterConfluenceConsensus == null
        ? null
        : num(features.clusterConfluenceConsensus, 0),
    clusterConfluenceAbsConsensus:
      features.clusterConfluenceAbsConsensus == null
        ? null
        : num(features.clusterConfluenceAbsConsensus, 0),
    clusterConfluenceAligned:
      features.clusterConfluenceAligned == null ? null : !!features.clusterConfluenceAligned,
    clusterConfluenceWeightShare:
      features.clusterConfluenceWeightShare == null
        ? null
        : num(features.clusterConfluenceWeightShare, 0),
    clusterConfluenceExSourceAvailable: features.clusterConfluenceExSourceAvailable === true,
    clusterConfluenceExSourceContributors: Math.max(
      0,
      num(features.clusterConfluenceExSourceContributors, 0)
    ),
    clusterConfluenceExSourceEffectiveN:
      features.clusterConfluenceExSourceEffectiveN == null
        ? null
        : num(features.clusterConfluenceExSourceEffectiveN, 0),
    clusterConfluenceExSourceConsensus:
      features.clusterConfluenceExSourceConsensus == null
        ? null
        : num(features.clusterConfluenceExSourceConsensus, 0),
    clusterConfluenceExSourceAbsConsensus:
      features.clusterConfluenceExSourceAbsConsensus == null
        ? null
        : num(features.clusterConfluenceExSourceAbsConsensus, 0),
    clusterConfluenceExSourceAligned:
      features.clusterConfluenceExSourceAligned == null
        ? null
        : !!features.clusterConfluenceExSourceAligned,
    clusterConfluenceExSourceWeightShare:
      features.clusterConfluenceExSourceWeightShare == null
        ? null
        : num(features.clusterConfluenceExSourceWeightShare, 0),
    regimeReady: features.regimeReady === true,
    regimeAvailable: features.regimeAvailable !== false,
    sessionBucket:
      features.sessionBucket == null ? null : String(features.sessionBucket).trim().toLowerCase(),
    recentReturnBucket:
      features.recentReturnBucket == null
        ? null
        : String(features.recentReturnBucket).trim().toLowerCase(),
    realizedVolBucket:
      features.realizedVolBucket == null
        ? null
        : String(features.realizedVolBucket).trim().toLowerCase(),
    sideAlignedWithRecentReturn:
      features.sideAlignedWithRecentReturn == null ? null : !!features.sideAlignedWithRecentReturn,
    trendStrength: features.trendStrength == null ? null : num(features.trendStrength, 0),
    totalTradingCostBps:
      features.totalTradingCostBps == null ? null : num(features.totalTradingCostBps, 0),
    staleStateDistanceMs:
      features.staleStateDistanceMs == null ? null : num(features.staleStateDistanceMs, 0),
    peerStateLagMs: features.peerStateLagMs == null ? null : num(features.peerStateLagMs, 0),
    sourcePriorUpdateGapMs:
      features.sourcePriorUpdateGapMs == null ? null : num(features.sourcePriorUpdateGapMs, 0),
    sourceEventGapMs: features.sourceEventGapMs == null ? null : num(features.sourceEventGapMs, 0),
    referencePriceAvailable: features.referencePriceAvailable === true,
    referenceDriftBps:
      features.referenceDriftBps == null ? null : num(features.referenceDriftBps, 0),
  };
}

function compactEventSignalEvent(event = {}) {
  const features = compactEventSignalFeatures(event.features || {});
  const wallet = normalizeWalletAddress(event.wallet || event.user || features.wallet);
  const symbol = normalizeSymbol(event.symbol || event.coin || features.symbol);
  return {
    time: num(event.ts ?? event.time, null),
    ts: num(event.ts ?? event.time, null),
    wallet,
    user: wallet,
    symbol,
    coin: symbol,
    eventType:
      event.eventType == null ? features.eventType : String(event.eventType).trim().toLowerCase(),
    side: normalizeSide(event.side || features.side),
    stateSource: event.stateSource == null ? null : String(event.stateSource).trim().toLowerCase(),
    price: event.price == null ? null : num(event.price, null),
    prevEntryPx: event.prevEntryPx == null ? null : num(event.prevEntryPx, null),
    nextEntryPx: event.nextEntryPx == null ? null : num(event.nextEntryPx, null),
    isEntryEvent: event.isEntryEvent === true || features.isEntryEvent === true,
    features,
  };
}

function eventMatchesFilter(event, filter = {}) {
  const normalizedFilter = normalizeEventSignalFilter(filter);
  const features = event.features && typeof event.features === "object" ? event.features : event;
  const wallet = normalizeWalletAddress(event.wallet || event.user || features.wallet);
  const symbol = normalizeSymbol(event.symbol || event.coin || features.symbol);
  const side = normalizeSide(event.side || features.side);
  const eventType = String(event.eventType || features.eventType || "")
    .trim()
    .toLowerCase();
  const regimeBucket = getRegimeBucket(features);
  if (normalizedFilter.wallets.length && !normalizedFilter.wallets.includes(wallet)) return false;
  if (normalizedFilter.symbols.length && !normalizedFilter.symbols.includes(symbol)) return false;
  if (normalizedFilter.sides.length && !normalizedFilter.sides.includes(side)) return false;
  if (normalizedFilter.eventTypes.length && !normalizedFilter.eventTypes.includes(eventType))
    return false;
  if (
    normalizedFilter.regimeBuckets.length &&
    !normalizedFilter.regimeBuckets.includes(regimeBucket)
  ) {
    return false;
  }
  return true;
}

function filterEventSignalEvents(events, filter = {}) {
  return (Array.isArray(events) ? events : []).filter((event) => eventMatchesFilter(event, filter));
}

function summarizeEventSignalEvents(events) {
  const bySymbol = new Map();
  const byEventType = new Map();
  const bySide = new Map();
  const wallets = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const wallet = normalizeWalletAddress(event.wallet || event.user);
    const symbol = normalizeSymbol(event.symbol || event.coin);
    const eventType = String(event.eventType || "")
      .trim()
      .toLowerCase();
    const side = normalizeSide(event.side);
    if (wallet) wallets.add(wallet);
    if (symbol) bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + 1);
    if (eventType) byEventType.set(eventType, (byEventType.get(eventType) || 0) + 1);
    if (side) bySide.set(side, (bySide.get(side) || 0) + 1);
  }
  return {
    eventCount: events.length,
    tradedEventCount: events.filter((event) => event.isEntryEvent === true).length,
    wallets: wallets.size,
    symbols: bySymbol.size,
    startMs: events.length ? num(events[0].ts ?? events[0].time, null) : null,
    endMs: events.length
      ? num(events[events.length - 1].ts ?? events[events.length - 1].time, null)
      : null,
    bySymbol: Object.fromEntries(bySymbol.entries()),
    byEventType: Object.fromEntries(byEventType.entries()),
    bySide: Object.fromEntries(bySide.entries()),
  };
}

function buildCompactEventSignalDataset(rawDataset, filter = {}) {
  const filteredEvents = filterEventSignalEvents(rawDataset?.events || rawDataset || [], filter)
    .map((event) => compactEventSignalEvent(event))
    .filter((event) => event.wallet && event.symbol && Number.isFinite(event.ts))
    .sort(
      (a, b) => a.ts - b.ts || a.wallet.localeCompare(b.wallet) || a.symbol.localeCompare(b.symbol)
    );
  const normalizedFilter = normalizeEventSignalFilter(filter);
  return {
    format: "copy-trading-event-signal-dataset/v1",
    generatedAt: new Date().toISOString(),
    sourceFormat: rawDataset?.format || null,
    sourceSummary:
      rawDataset?.summary && typeof rawDataset.summary === "object" ? rawDataset.summary : null,
    filter: normalizedFilter,
    summary: summarizeEventSignalEvents(filteredEvents),
    events: filteredEvents,
  };
}

function loadEventSignalDatasetFile(filePath) {
  const resolved = path.resolve(String(filePath));
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

module.exports = {
  buildCompactEventSignalDataset,
  compactEventSignalEvent,
  compactEventSignalFeatures,
  filterEventSignalEvents,
  getRegimeBucket,
  loadEventSignalDatasetFile,
  normalizeEventSignalFilter,
  summarizeEventSignalEvents,
};
