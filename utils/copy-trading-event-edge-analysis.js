"use strict";

const { normalizeSymbol } = require("./copy-trading-event-dataset");
const { evaluateEventSignal, normalizeEventModelConfig } = require("./copy-trading-event-model");

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function parseScoreBins(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const bins = raw
    .map((entry) => Number(entry))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (bins.length >= 2) {
    const deduped = bins.filter((entry, index) => index === 0 || entry !== bins[index - 1]);
    if (deduped[0] > 0) deduped.unshift(0);
    if (deduped[deduped.length - 1] < 1) deduped.push(1);
    return deduped.map((entry) => clamp(entry, 0, 1));
  }
  return [0, 0.4, 0.5, 0.6, 0.7, 0.8, 1];
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

function mean(values) {
  const xs = (Array.isArray(values) ? values : []).filter(Number.isFinite);
  if (!xs.length) return null;
  return xs.reduce((sum, value) => sum + value, 0) / xs.length;
}

function groupBy(items, keyFn) {
  const out = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(keyFn(item) || "unknown");
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

function buildScoreBinLabel(lower, upper, isLast) {
  const lo = lower.toFixed(2);
  const hi = upper.toFixed(2);
  return isLast ? `[${lo}, ${hi}]` : `[${lo}, ${hi})`;
}

function summarizeEvaluatedRows(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const accepted = all.filter((row) => row.accepted);
  const rejected = all.filter((row) => !row.accepted);
  const totalNetPnlUsd = all.reduce((sum, row) => sum + num(row.netPnlUsd, 0), 0);
  const acceptedNetPnlUsd = accepted.reduce((sum, row) => sum + num(row.netPnlUsd, 0), 0);
  return {
    eventCount: all.length,
    accepted: accepted.length,
    rejected: rejected.length,
    acceptanceRate: all.length ? accepted.length / all.length : 0,
    avgScore: mean(all.map((row) => row.score)),
    avgNetPnlUsd: mean(all.map((row) => row.netPnlUsd)),
    avgAcceptedNetPnlUsd: mean(accepted.map((row) => row.netPnlUsd)),
    avgAcceptedGrossPnlUsd: mean(accepted.map((row) => row.grossPnlUsd)),
    totalNetPnlUsd,
    totalAcceptedNetPnlUsd: acceptedNetPnlUsd,
    acceptedWinRate: accepted.length
      ? accepted.filter((row) => num(row.netPnlUsd, 0) > 0).length / accepted.length
      : null,
  };
}

function summarizeCohorts(rows, cohortFn, { minCount = 1, topN = 10 } = {}) {
  const summaries = [];
  for (const [key, items] of groupBy(rows, cohortFn).entries()) {
    if (items.length < minCount) continue;
    summaries.push({
      cohort: key,
      ...summarizeEvaluatedRows(items),
    });
  }
  summaries.sort((a, b) => {
    const pnlDiff = num(b.avgAcceptedNetPnlUsd, -Infinity) - num(a.avgAcceptedNetPnlUsd, -Infinity);
    if (pnlDiff !== 0) return pnlDiff;
    return b.accepted - a.accepted;
  });
  return summaries.slice(0, Math.max(1, topN));
}

function summarizeScoreBins(rows, scoreBins) {
  const bins = parseScoreBins(scoreBins);
  const out = [];
  for (let index = 0; index < bins.length - 1; index += 1) {
    const lower = bins[index];
    const upper = bins[index + 1];
    const isLast = index === bins.length - 2;
    const members = (Array.isArray(rows) ? rows : []).filter((row) => {
      const score = num(row.score, null);
      if (!Number.isFinite(score)) return false;
      if (isLast) return score >= lower && score <= upper;
      return score >= lower && score < upper;
    });
    out.push({
      bin: buildScoreBinLabel(lower, upper, isLast),
      lower,
      upper,
      ...summarizeEvaluatedRows(members),
    });
  }
  return out;
}

function summarizeSlices(
  baseRows,
  higherCostRows,
  tighterFreshnessRows,
  sliceFn,
  { minCount = 1, minAccepted = 1, topN = 10 } = {}
) {
  const higherCostBySlice = groupBy(higherCostRows, sliceFn);
  const tighterFreshnessBySlice = groupBy(tighterFreshnessRows, sliceFn);
  const out = [];

  for (const [slice, rows] of groupBy(baseRows, sliceFn).entries()) {
    const summary = summarizeEvaluatedRows(rows);
    if (summary.eventCount < minCount || summary.accepted < minAccepted) continue;
    const higherCostSummary = summarizeEvaluatedRows(higherCostBySlice.get(slice) || []);
    const tighterFreshnessSummary = summarizeEvaluatedRows(
      tighterFreshnessBySlice.get(slice) || []
    );
    out.push({
      slice,
      ...summary,
      higherCost: higherCostSummary,
      tighterFreshness: tighterFreshnessSummary,
      robustPositive:
        num(summary.avgAcceptedNetPnlUsd, -Infinity) > 0 &&
        num(higherCostSummary.avgAcceptedNetPnlUsd, -Infinity) > 0 &&
        num(tighterFreshnessSummary.avgAcceptedNetPnlUsd, -Infinity) > 0,
    });
  }

  out.sort((a, b) => {
    const robustDiff = Number(b.robustPositive) - Number(a.robustPositive);
    if (robustDiff !== 0) return robustDiff;
    const higherCostDiff =
      num(b.higherCost.avgAcceptedNetPnlUsd, -Infinity) -
      num(a.higherCost.avgAcceptedNetPnlUsd, -Infinity);
    if (higherCostDiff !== 0) return higherCostDiff;
    const baseDiff =
      num(b.avgAcceptedNetPnlUsd, -Infinity) - num(a.avgAcceptedNetPnlUsd, -Infinity);
    if (baseDiff !== 0) return baseDiff;
    return b.accepted - a.accepted;
  });
  return out.slice(0, Math.max(1, topN));
}

function getRegimeBucket(features = {}) {
  const trend = String(features.recentReturnBucket || "unknown");
  const vol = String(features.realizedVolBucket || "unknown");
  return `${trend}/${vol}`;
}

function getStressConfig(baseConfigRaw, tighterFreshnessMs) {
  if (!Number.isFinite(tighterFreshnessMs) || !(tighterFreshnessMs > 0)) return baseConfigRaw;
  return {
    ...baseConfigRaw,
    eventMaxStaleStateMs: Math.max(1_000, Math.floor(tighterFreshnessMs)),
  };
}

function computeStressedNetPnlUsd({ label, notionalUsd, feeBps, slippageBps, costMult = 1 }) {
  if (!label || !label.available) return null;
  const grossPnlUsd = num(label.grossPnlUsd, null);
  if (!Number.isFinite(grossPnlUsd)) return num(label.netPnlUsd, null);
  const roundTripCostRate =
    (2 * (num(feeBps, 0) + num(slippageBps, 0)) * Math.max(1, costMult)) / 10_000;
  return grossPnlUsd - num(notionalUsd, 100) * roundTripCostRate;
}

function evaluateDatasetRows(
  events,
  {
    horizon,
    modelConfigRaw,
    symbols = null,
    sides = null,
    eventTypes = null,
    regimeBuckets = null,
    costStressMult = 1,
    tighterFreshnessMs = null,
    notionalUsd = 100,
    feeBps = 6,
    slippageBps = 8,
  } = {}
) {
  const allowedSymbols = Array.isArray(symbols) && symbols.length ? new Set(symbols) : null;
  const allowedSides = Array.isArray(sides) && sides.length ? new Set(sides) : null;
  const allowedEventTypes =
    Array.isArray(eventTypes) && eventTypes.length ? new Set(eventTypes) : null;
  const allowedRegimeBuckets =
    Array.isArray(regimeBuckets) && regimeBuckets.length ? new Set(regimeBuckets) : null;
  const configRaw = getStressConfig(modelConfigRaw, tighterFreshnessMs);

  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.features && event?.labels?.[horizon]?.available)
    .filter((event) => event.features?.isEntryEvent !== false)
    .filter((event) => {
      const symbol = normalizeSymbol(event.symbol || event.coin);
      const side = String(event.side || "").toLowerCase();
      const eventType = String(event.eventType || "");
      const regimeBucket = getRegimeBucket(event.features);
      if (allowedSymbols && !allowedSymbols.has(symbol)) return false;
      if (allowedSides && !allowedSides.has(side)) return false;
      if (allowedEventTypes && !allowedEventTypes.has(eventType)) return false;
      if (allowedRegimeBuckets && !allowedRegimeBuckets.has(regimeBucket)) return false;
      return true;
    })
    .map((event) => {
      const features =
        costStressMult > 1
          ? {
              ...event.features,
              totalTradingCostBps: num(event.features?.totalTradingCostBps, 0) * costStressMult,
            }
          : event.features;
      const decision = evaluateEventSignal({
        event: { ...event, features },
        config: configRaw,
      });
      const label = event.labels[horizon];
      return {
        ts: num(event.ts ?? event.time, null),
        wallet: event.wallet || event.user || null,
        symbol: normalizeSymbol(event.symbol || event.coin),
        side: String(event.side || "").toLowerCase(),
        eventType: String(event.eventType || ""),
        regimeBucket: getRegimeBucket(event.features),
        score: num(decision.score, null),
        accepted: decision.ok === true,
        decision: decision.decision || "ignore",
        reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
        sizeFraction: num(decision.sizeFraction, 0),
        grossPnlUsd: num(label.grossPnlUsd, null),
        netPnlUsd: computeStressedNetPnlUsd({
          label,
          notionalUsd,
          feeBps,
          slippageBps,
          costMult: costStressMult,
        }),
        netReturnPct:
          costStressMult > 1
            ? (computeStressedNetPnlUsd({
                label,
                notionalUsd,
                feeBps,
                slippageBps,
                costMult: costStressMult,
              }) /
                Math.max(1e-9, notionalUsd)) *
              100
            : num(label.netReturnPct, null),
      };
    });
}

function analyzeEventEdge(dataset, options = {}) {
  const labelConfig = dataset?.labelConfig || {};
  const featureConfig = dataset?.featureConfig || {};
  const horizon =
    String(
      options.horizon ||
        options.eventPrimaryHorizon ||
        featureConfig.primaryHorizon ||
        labelConfig.horizons?.[0] ||
        "6h"
    ).trim() || "6h";
  const symbols = (Array.isArray(options.symbols) ? options.symbols : [])
    .map((value) => normalizeSymbol(value))
    .filter(Boolean);
  const sides = (Array.isArray(options.sides) ? options.sides : [])
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  const eventTypes = (Array.isArray(options.eventTypes) ? options.eventTypes : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const regimeBuckets = normalizeStringList(options.regimeBuckets);
  const topN = Math.max(1, num(options.topN, 10));
  const minCount = Math.max(1, num(options.minCount, 3));
  const sliceTopN = Math.max(1, num(options.sliceTopN, topN));
  const sliceMinCount = Math.max(1, num(options.sliceMinCount, minCount));
  const sliceMinAccepted = Math.max(1, num(options.sliceMinAccepted, 1));
  const modelConfigRaw = {
    ...options,
    eventPrimaryHorizon: horizon,
  };
  const normalizedModelConfig = normalizeEventModelConfig(modelConfigRaw);
  const notionalUsd = num(labelConfig.notionalUsd, 100);
  const feeBps = num(labelConfig.feeBps, 6);
  const slippageBps = num(labelConfig.slippageBps, 8);
  const feeStressMult = Math.max(1, num(options.feeStressMult, 2));
  const defaultTighterFreshnessMs = Math.max(
    1_000,
    Math.min(num(normalizedModelConfig.maxStaleStateMs, 6 * 60 * 60 * 1000), 6 * 60 * 60 * 1000)
  );
  const tighterFreshnessMs = Math.max(
    1_000,
    num(options.tighterFreshnessMs, defaultTighterFreshnessMs)
  );

  const baseRows = evaluateDatasetRows(dataset?.events, {
    horizon,
    modelConfigRaw,
    symbols,
    sides,
    eventTypes,
    regimeBuckets,
    notionalUsd,
    feeBps,
    slippageBps,
  });
  const higherCostRows = evaluateDatasetRows(dataset?.events, {
    horizon,
    modelConfigRaw,
    symbols,
    sides,
    eventTypes,
    regimeBuckets,
    costStressMult: feeStressMult,
    notionalUsd,
    feeBps,
    slippageBps,
  });
  const tighterFreshnessRows = evaluateDatasetRows(dataset?.events, {
    horizon,
    modelConfigRaw,
    symbols,
    sides,
    eventTypes,
    regimeBuckets,
    tighterFreshnessMs,
    notionalUsd,
    feeBps,
    slippageBps,
  });

  return {
    config: {
      horizon,
      topN,
      minCount,
      symbols,
      sides,
      eventTypes,
      regimeBuckets,
      feeStressMult,
      tighterFreshnessMs,
      model: normalizedModelConfig,
    },
    summary: summarizeEvaluatedRows(baseRows),
    bySymbolSide: summarizeCohorts(baseRows, (row) => `${row.symbol}:${row.side}`, {
      minCount,
      topN,
    }),
    byRegime: summarizeCohorts(baseRows, (row) => row.regimeBucket, { minCount, topN }),
    byEventType: summarizeCohorts(baseRows, (row) => row.eventType, { minCount, topN }),
    scoreBins: summarizeScoreBins(baseRows, options.scoreBins),
    topSlices: summarizeSlices(
      baseRows,
      higherCostRows,
      tighterFreshnessRows,
      (row) => `${row.symbol}:${row.side}:${row.eventType}:${row.regimeBucket}`,
      { minCount: sliceMinCount, minAccepted: sliceMinAccepted, topN: sliceTopN }
    ),
    stress: {
      higherCost: {
        costMult: feeStressMult,
        summary: summarizeEvaluatedRows(higherCostRows),
      },
      tighterFreshness: {
        tighterFreshnessMs,
        summary: summarizeEvaluatedRows(tighterFreshnessRows),
      },
    },
  };
}

module.exports = {
  analyzeEventEdge,
  _evaluateDatasetRows: evaluateDatasetRows,
  _summarizeEvaluatedRows: summarizeEvaluatedRows,
  _summarizeScoreBins: summarizeScoreBins,
  _summarizeSlices: summarizeSlices,
};
