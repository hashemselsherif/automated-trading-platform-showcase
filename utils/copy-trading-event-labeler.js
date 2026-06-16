"use strict";

const fs = require("fs");
const path = require("path");

const { normalizeSymbol, sideFromPositionSize } = require("./copy-trading-event-dataset");

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSymbols(symbols) {
  const normalized = (Array.isArray(symbols) ? symbols : []).map(normalizeSymbol).filter(Boolean);
  return normalized.length ? new Set(normalized) : null;
}

function parseDurationMs(value) {
  if (Number.isFinite(value)) return Math.max(1, Number(value));
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|m|h|d)$/);
  if (!match) {
    const raw = Number(text);
    return Number.isFinite(raw) ? Math.max(1, raw) : null;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const mult = unit === "ms" ? 1 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.max(1, amount * mult);
}

function normalizeHorizonSpec(horizon) {
  const ms = parseDurationMs(horizon);
  if (!Number.isFinite(ms) || !(ms > 0)) return null;
  return { key: String(horizon), ms };
}

function normalizeCandle(record, symbolFallback = null) {
  if (!record || typeof record !== "object") return null;
  const symbol = normalizeSymbol(record.symbol || record.coin || symbolFallback);
  const ts = num(record.ts ?? record.time, null);
  const close = num(record.close ?? record.px ?? record.price, null);
  if (!symbol || !Number.isFinite(ts) || !Number.isFinite(close)) return null;
  const open = num(record.open, close);
  const high = num(record.high, Math.max(open, close));
  const low = num(record.low, Math.min(open, close));
  return {
    symbol,
    coin: symbol,
    ts,
    time: ts,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    px: close,
  };
}

function normalizePriceCandles(
  raw,
  { symbols = null, startMs = null, endMs = null, symbolFallback = null } = {}
) {
  const allowedSymbols = normalizeSymbols(symbols);
  let source = raw;
  let inheritedSymbol = symbolFallback;

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Array.isArray(raw.candles)) {
      source = raw.candles;
      inheritedSymbol = raw?.meta?.symbol || symbolFallback;
    } else if (Array.isArray(raw.events)) {
      source = raw.events;
    }
  }

  return (Array.isArray(source) ? source : [])
    .map((record) => normalizeCandle(record, inheritedSymbol))
    .filter(Boolean)
    .filter((candle) => {
      if (allowedSymbols && !allowedSymbols.has(candle.symbol)) return false;
      if (Number.isFinite(startMs) && candle.ts < startMs) return false;
      if (Number.isFinite(endMs) && candle.ts > endMs) return false;
      return true;
    })
    .sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
}

function inferSymbolFromFilename(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/pythhist_([^_]+)/i);
  return match ? normalizeSymbol(match[1]) : null;
}

function dedupeCandles(candles) {
  const seen = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    seen.set(`${candle.symbol}:${candle.ts}`, candle);
  }
  return Array.from(seen.values()).sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
}

function loadPythCandlesFromFile(filePath, { symbols = null, startMs = null, endMs = null } = {}) {
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizePriceCandles(raw, {
    symbols,
    startMs,
    endMs,
    symbolFallback: raw?.meta?.symbol || inferSymbolFromFilename(filePath),
  });
}

function loadPythCandlesFromDir(dir, { symbols = null, startMs = null, endMs = null } = {}) {
  if (!fs.existsSync(dir)) return [];
  const allowedSymbols = normalizeSymbols(symbols);
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => {
      if (!allowedSymbols) return true;
      const inferred = inferSymbolFromFilename(name);
      return inferred ? allowedSymbols.has(inferred) : true;
    })
    .map((name) => path.join(dir, name));

  const candles = [];
  for (const filePath of files) {
    candles.push(...loadPythCandlesFromFile(filePath, { symbols, startMs, endMs }));
  }
  return dedupeCandles(candles);
}

function indexCandlesBySymbol(candles) {
  const out = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const symbol = normalizeSymbol(candle.symbol || candle.coin);
    if (!symbol) continue;
    if (!out.has(symbol)) out.set(symbol, []);
    out.get(symbol).push(candle);
  }
  for (const perSymbol of out.values()) {
    perSymbol.sort((a, b) => a.ts - b.ts);
  }
  return out;
}

function findFirstCandleAtOrAfter(candles, ts) {
  if (!Array.isArray(candles) || !candles.length) return -1;
  let lo = 0;
  let hi = candles.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].ts >= ts) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

function getEventSideSign(event) {
  const side = String(event?.side || "").toLowerCase();
  if (side === "long") return 1;
  if (side === "short") return -1;
  const nextSide = sideFromPositionSize(num(event?.nextPos, 0));
  if (nextSide === "long") return 1;
  if (nextSide === "short") return -1;
  const prevSide = sideFromPositionSize(num(event?.prevPos, 0));
  if (prevSide === "long") return 1;
  if (prevSide === "short") return -1;
  return 0;
}

function buildUnavailableLabel(horizon) {
  return {
    available: false,
    horizonMs: horizon.ms,
    entryTs: null,
    exitTs: null,
    entryPx: null,
    exitPx: null,
    grossReturnPct: null,
    netReturnPct: null,
    grossPnlUsd: null,
    netPnlUsd: null,
    maxAdverseExcursionPct: null,
    maxFavorableExcursionPct: null,
    survivesAdverseMove: null,
  };
}

function labelLeaderEvents(
  events,
  candles,
  {
    horizons = ["30m", "2h", "6h", "24h"],
    feeBps = 6,
    slippageBps = 8,
    notionalUsd = 100,
    adverseMoveStopPct = 4,
  } = {}
) {
  const horizonSpecs = (Array.isArray(horizons) ? horizons : [])
    .map(normalizeHorizonSpec)
    .filter(Boolean);
  const candlesBySymbol = indexCandlesBySymbol(candles);
  const costRate = (2 * (num(feeBps, 0) + num(slippageBps, 0))) / 10_000;

  return (Array.isArray(events) ? events : []).map((event) => {
    const symbol = normalizeSymbol(event?.symbol || event?.coin);
    const sideSign = getEventSideSign(event);
    const perSymbol = candlesBySymbol.get(symbol) || [];
    const labels = {};

    if (!symbol || sideSign === 0 || !perSymbol.length) {
      for (const horizon of horizonSpecs) labels[horizon.key] = buildUnavailableLabel(horizon);
      return { ...event, labels };
    }

    const eventTs = num(event?.ts ?? event?.time, null);
    const entryIndex = findFirstCandleAtOrAfter(perSymbol, eventTs);
    if (entryIndex < 0) {
      for (const horizon of horizonSpecs) labels[horizon.key] = buildUnavailableLabel(horizon);
      return { ...event, labels };
    }

    const entryCandle = perSymbol[entryIndex];
    const entryPx = num(entryCandle.close, null);
    if (!Number.isFinite(entryPx) || !(entryPx > 0)) {
      for (const horizon of horizonSpecs) labels[horizon.key] = buildUnavailableLabel(horizon);
      return { ...event, labels };
    }

    for (const horizon of horizonSpecs) {
      const exitIndex = findFirstCandleAtOrAfter(perSymbol, eventTs + horizon.ms);
      if (exitIndex < 0) {
        labels[horizon.key] = buildUnavailableLabel(horizon);
        continue;
      }

      const exitCandle = perSymbol[exitIndex];
      const window = perSymbol.slice(entryIndex, exitIndex + 1);
      const maxHigh = window.reduce(
        (value, candle) => Math.max(value, num(candle.high, candle.close)),
        Number.NEGATIVE_INFINITY
      );
      const minLow = window.reduce(
        (value, candle) => Math.min(value, num(candle.low, candle.close)),
        Number.POSITIVE_INFINITY
      );
      const exitPx = num(exitCandle.close, null);
      const grossReturn = sideSign * ((exitPx - entryPx) / entryPx);
      const netReturn = grossReturn - costRate;
      const adverseMove =
        sideSign > 0
          ? Math.max(0, (entryPx - minLow) / entryPx)
          : Math.max(0, (maxHigh - entryPx) / entryPx);
      const favorableMove =
        sideSign > 0
          ? Math.max(0, (maxHigh - entryPx) / entryPx)
          : Math.max(0, (entryPx - minLow) / entryPx);

      labels[horizon.key] = {
        available: true,
        horizonMs: horizon.ms,
        entryTs: entryCandle.ts,
        exitTs: exitCandle.ts,
        entryPx,
        exitPx,
        grossReturnPct: grossReturn * 100,
        netReturnPct: netReturn * 100,
        grossPnlUsd: num(notionalUsd, 100) * grossReturn,
        netPnlUsd: num(notionalUsd, 100) * netReturn,
        maxAdverseExcursionPct: adverseMove * 100,
        maxFavorableExcursionPct: favorableMove * 100,
        survivesAdverseMove: adverseMove * 100 <= num(adverseMoveStopPct, 4),
      };
    }

    return { ...event, labels };
  });
}

function summarizeLabeledEvents(events, horizons) {
  const summary = {};
  for (const horizon of horizons) {
    const labels = (Array.isArray(events) ? events : [])
      .map((event) => event?.labels?.[horizon])
      .filter((label) => label && label.available);
    const totalNetPnlUsd = labels.reduce((sum, label) => sum + num(label.netPnlUsd, 0), 0);
    summary[horizon] = {
      available: labels.length,
      positive: labels.filter((label) => num(label.netPnlUsd, 0) > 0).length,
      avgNetPnlUsd: labels.length ? totalNetPnlUsd / labels.length : null,
      avgNetReturnPct: labels.length
        ? labels.reduce((sum, label) => sum + num(label.netReturnPct, 0), 0) / labels.length
        : null,
    };
  }
  return summary;
}

function buildLabeledLeaderEventDataset(dataset, candles, options = {}) {
  const horizons = (Array.isArray(options.horizons) ? options.horizons : ["30m", "2h", "6h", "24h"])
    .map(normalizeHorizonSpec)
    .filter(Boolean)
    .map((horizon) => horizon.key);
  const labeledEvents = labelLeaderEvents(dataset?.events || [], candles, options);
  return {
    ...dataset,
    labelConfig: {
      horizons,
      feeBps: num(options.feeBps, 6),
      slippageBps: num(options.slippageBps, 8),
      notionalUsd: num(options.notionalUsd, 100),
      adverseMoveStopPct: num(options.adverseMoveStopPct, 4),
    },
    labelSummary: summarizeLabeledEvents(labeledEvents, horizons),
    events: labeledEvents,
  };
}

module.exports = {
  buildLabeledLeaderEventDataset,
  dedupeCandles,
  findFirstCandleAtOrAfter,
  indexCandlesBySymbol,
  labelLeaderEvents,
  loadPythCandlesFromDir,
  loadPythCandlesFromFile,
  normalizePriceCandles,
  normalizeHorizonSpec,
  parseDurationMs,
};
