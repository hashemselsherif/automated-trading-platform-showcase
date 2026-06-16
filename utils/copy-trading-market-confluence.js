"use strict";

const {
  buildWeights,
  calcConsensusStatsPhase6,
} = require("../scripts/backtest/backtest-copy-trading");
const { normalizeWalletAddress } = require("./copy-trading-cohort");
const { normalizeSymbol } = require("./copy-trading-event-dataset");

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSymbolList(values) {
  const raw = Array.isArray(values)
    ? values
    : String(values || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  const normalized = raw.map((value) => normalizeSymbol(value)).filter(Boolean);
  return normalized.filter((value, index) => normalized.indexOf(value) === index);
}

function buildCandidateWeightMap(
  candidates,
  { weightMode = "hybrid", minWeight = 0.05, maxWeight = 1 } = {}
) {
  const rows = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const address = normalizeWalletAddress(candidate?.address || candidate?.wallet);
      if (!address) return null;
      return {
        wallet: { address },
        score: num(candidate?.score, 0),
        winRateLB: num(candidate?.winRateLB ?? candidate?.winRateLb, 0.5),
        trades: Math.max(1, Math.round(num(candidate?.trades, 1))),
      };
    })
    .filter(Boolean);
  return buildWeights(
    rows,
    {
      weightMode,
      minWeight: Math.max(0, num(minWeight, 0.05)),
      maxWeight: Math.max(0.01, num(maxWeight, 1)),
    },
    { forceInclude: [], blocklist: [], weightMultipliers: {} }
  );
}

function applyFillToWalletStates(walletStates, lastUpdateByWallet, lastPriceBySymbol, fill) {
  const wallet = normalizeWalletAddress(fill?.wallet || fill?.user);
  const symbol = normalizeSymbol(fill?.coin || fill?.symbol);
  const ts = num(fill?.time ?? fill?.ts, null);
  const side = num(fill?.side, 0);
  const size = Math.abs(num(fill?.sz, 0));
  const price = num(fill?.px ?? fill?.price, null);
  if (!wallet || !symbol || !Number.isFinite(ts) || !Number.isFinite(side) || !(size > 0)) return;

  if (!walletStates.has(wallet)) walletStates.set(wallet, new Map());
  const perWallet = walletStates.get(wallet);
  const nextPos = num(perWallet.get(symbol), 0) + side * size;
  if (Math.abs(nextPos) <= 1e-9) perWallet.delete(symbol);
  else perWallet.set(symbol, nextPos);

  lastUpdateByWallet.set(wallet, ts);
  if (Number.isFinite(price) && price > 0) lastPriceBySymbol.set(symbol, price);
}

function summarizeMarketConfluence({
  eventSide,
  walletStates,
  weightMap,
  lastUpdateByWallet,
  lastPriceBySymbol,
  confluenceSymbols,
  staleMs,
  nowMs,
}) {
  const statsBySymbol = [];
  for (const symbol of confluenceSymbols) {
    const stats = calcConsensusStatsPhase6(symbol, walletStates, weightMap, {
      nowMs,
      staleMs,
      lastUpdateByWallet,
      lastPriceBySymbol,
      minLeaders: 1,
      minEffectiveN: 0,
      eliteEnabled: false,
    });
    if (num(stats?.weightSum, 0) <= 0 && num(stats?.contributors, 0) <= 0) continue;
    statsBySymbol.push({ symbol, ...stats });
  }

  if (!statsBySymbol.length) {
    return {
      marketConfluenceAvailable: false,
      marketConfluenceSymbols: confluenceSymbols.slice(),
      marketConfluencePrimarySymbol: confluenceSymbols[0] || null,
      marketConfluenceConsensus: null,
      marketConfluenceAbsConsensus: null,
      marketConfluenceContributors: 0,
      marketConfluenceEffectiveN: 0,
      marketConfluenceMaxWeightShare: null,
      marketConfluenceDirection: "neutral",
      marketConfluenceAligned: null,
    };
  }

  let weightedConsensus = 0;
  let weightedEffectiveN = 0;
  let weightSum = 0;
  let contributors = 0;
  let maxWeightShare = 0;
  let primary = statsBySymbol[0];

  for (const stats of statsBySymbol) {
    const symbolWeight = Math.max(1e-9, num(stats.weightSum, 0));
    weightedConsensus += num(stats.consensus, 0) * symbolWeight;
    weightedEffectiveN += num(stats.effectiveN, 0) * symbolWeight;
    weightSum += symbolWeight;
    contributors += Math.max(0, num(stats.contributors, 0));
    maxWeightShare = Math.max(maxWeightShare, num(stats.maxWeightShare, 0));
    if (num(stats.weightSum, 0) > num(primary?.weightSum, 0)) primary = stats;
  }

  const consensus = weightSum > 0 ? weightedConsensus / weightSum : 0;
  const effectiveN = weightSum > 0 ? weightedEffectiveN / weightSum : 0;
  const absConsensus = Math.abs(consensus);
  const direction = consensus > 0 ? "long" : consensus < 0 ? "short" : "neutral";
  const aligned =
    eventSide === "long" ? consensus > 0 : eventSide === "short" ? consensus < 0 : null;

  return {
    marketConfluenceAvailable: true,
    marketConfluenceSymbols: statsBySymbol.map((stats) => stats.symbol),
    marketConfluencePrimarySymbol: primary?.symbol || confluenceSymbols[0] || null,
    marketConfluenceConsensus: consensus,
    marketConfluenceAbsConsensus: absConsensus,
    marketConfluenceContributors: contributors,
    marketConfluenceEffectiveN: effectiveN,
    marketConfluenceMaxWeightShare: maxWeightShare,
    marketConfluenceDirection: direction,
    marketConfluenceAligned: aligned,
  };
}

function enrichSignalEventsWithMarketConfluence({
  signalEvents,
  fillEvents,
  candidates,
  confluenceSymbols,
  staleMs = 6 * 60 * 60 * 1000,
  weightMode = "hybrid",
  minWeight = 0.05,
  maxWeight = 1,
}) {
  const normalizedConfluenceSymbols = parseSymbolList(confluenceSymbols);
  const baseEvents = Array.isArray(signalEvents) ? signalEvents : [];
  if (!baseEvents.length || !normalizedConfluenceSymbols.length) return baseEvents.slice();

  const sortedSignals = baseEvents
    .slice()
    .sort(
      (a, b) =>
        num(a?.ts ?? a?.time, 0) - num(b?.ts ?? b?.time, 0) ||
        String(a?.wallet || a?.user || "").localeCompare(String(b?.wallet || b?.user || ""))
    );
  const sortedFills = (Array.isArray(fillEvents) ? fillEvents : [])
    .slice()
    .filter((fill) =>
      normalizedConfluenceSymbols.includes(normalizeSymbol(fill?.coin || fill?.symbol))
    )
    .sort((a, b) => num(a?.time ?? a?.ts, 0) - num(b?.time ?? b?.ts, 0));

  const weightMap = buildCandidateWeightMap(candidates, { weightMode, minWeight, maxWeight });
  const walletStates = new Map();
  const lastUpdateByWallet = new Map();
  const lastPriceBySymbol = new Map();
  const enriched = [];
  let fillIndex = 0;

  for (const event of sortedSignals) {
    const eventTs = num(event?.ts ?? event?.time, null);
    if (!Number.isFinite(eventTs)) continue;
    while (fillIndex < sortedFills.length && num(sortedFills[fillIndex]?.time, 0) < eventTs) {
      applyFillToWalletStates(
        walletStates,
        lastUpdateByWallet,
        lastPriceBySymbol,
        sortedFills[fillIndex]
      );
      fillIndex += 1;
    }
    const eventSide = String(event?.side || event?.features?.side || "")
      .trim()
      .toLowerCase();
    const marketConfluence = summarizeMarketConfluence({
      eventSide,
      walletStates,
      weightMap,
      lastUpdateByWallet,
      lastPriceBySymbol,
      confluenceSymbols: normalizedConfluenceSymbols,
      staleMs: Math.max(1_000, num(staleMs, 6 * 60 * 60 * 1000)),
      nowMs: eventTs,
    });
    enriched.push({
      ...event,
      features: {
        ...(event.features && typeof event.features === "object" ? event.features : {}),
        ...marketConfluence,
      },
    });
  }

  return enriched;
}

module.exports = {
  buildCandidateWeightMap,
  enrichSignalEventsWithMarketConfluence,
};
