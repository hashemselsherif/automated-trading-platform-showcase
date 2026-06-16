"use strict";

const fs = require("fs");
const path = require("path");

const { normalizeSnapshots, readJsonl } = require("./hyperliquid-ws-cache");

const DEFAULT_EPSILON = 1e-9;

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function approxZero(value, epsilon = DEFAULT_EPSILON) {
  return Math.abs(num(value, 0)) <= epsilon;
}

function normalizeWallet(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeSymbol(value) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

function normalizeSymbolSet(symbols) {
  const normalized = (Array.isArray(symbols) ? symbols : []).map(normalizeSymbol).filter(Boolean);
  return normalized.length ? new Set(normalized) : null;
}

function normalizeSide(value) {
  if (typeof value === "number") {
    if (value > 0) return 1;
    if (value < 0) return -1;
    return 0;
  }
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return 0;
  if (["b", "buy", "long", "bid"].includes(normalized)) return 1;
  if (["a", "ask", "sell", "short"].includes(normalized)) return -1;
  return 0;
}

function sideFromPositionSize(size) {
  if (size > DEFAULT_EPSILON) return "long";
  if (size < -DEFAULT_EPSILON) return "short";
  return null;
}

function isEntryEventType(eventType) {
  return (
    eventType === "open_long" ||
    eventType === "open_short" ||
    eventType === "flip_to_long" ||
    eventType === "flip_to_short"
  );
}

function isExitEventType(eventType) {
  return eventType === "close_long" || eventType === "close_short";
}

function isFlipEventType(eventType) {
  return eventType === "flip_to_long" || eventType === "flip_to_short";
}

function classifyPositionTransition(prevPos, nextPos, epsilon = DEFAULT_EPSILON) {
  const prev = approxZero(prevPos, epsilon) ? 0 : num(prevPos, 0);
  const next = approxZero(nextPos, epsilon) ? 0 : num(nextPos, 0);

  if (prev === next) return null;
  if (prev === 0 && next > 0) return "open_long";
  if (prev === 0 && next < 0) return "open_short";
  if (prev > 0 && next === 0) return "close_long";
  if (prev < 0 && next === 0) return "close_short";
  if (prev > 0 && next < 0) return "flip_to_short";
  if (prev < 0 && next > 0) return "flip_to_long";
  if (prev > 0 && next > prev) return "add_long";
  if (prev > 0 && next < prev) return "reduce_long";
  if (prev < 0 && next < prev) return "add_short";
  if (prev < 0 && next > prev) return "reduce_short";
  return null;
}

function mapPositionsBySymbol(positions) {
  const out = new Map();
  for (const position of Array.isArray(positions) ? positions : []) {
    const symbol = normalizeSymbol(position?.coin || position?.symbol);
    if (!symbol) continue;
    out.set(symbol, {
      coin: symbol,
      szi: num(position?.szi, 0),
      entryPx: position?.entryPx == null ? null : num(position.entryPx, null),
      positionValue: position?.positionValue == null ? null : num(position.positionValue, null),
      unrealizedPnl: position?.unrealizedPnl == null ? null : num(position.unrealizedPnl, null),
      leverage: position?.leverage == null ? null : num(position.leverage, null),
    });
  }
  return out;
}

function buildLeaderEvent({
  ts,
  wallet,
  symbol,
  eventType,
  prevPos,
  nextPos,
  prevEntryPx = null,
  nextEntryPx = null,
  price = null,
  stateSource,
  source = null,
  metadata = {},
} = {}) {
  const prev = approxZero(prevPos) ? 0 : num(prevPos, 0);
  const next = approxZero(nextPos) ? 0 : num(nextPos, 0);
  const prevAbs = Math.abs(prev);
  const nextAbs = Math.abs(next);
  const deltaPos = next - prev;
  const deltaAbs = Math.abs(deltaPos);
  const exposureDelta = nextAbs - prevAbs;
  const side = sideFromPositionSize(next !== 0 ? next : prev);

  return {
    kind: "leader_position_event",
    time: ts,
    ts,
    wallet,
    user: wallet,
    symbol,
    coin: symbol,
    eventType,
    side,
    prevPos: prev,
    nextPos: next,
    prevAbs,
    nextAbs,
    deltaPos,
    deltaAbs,
    exposureDelta,
    deltaPctOfPrevAbs: prevAbs > DEFAULT_EPSILON ? (deltaAbs / prevAbs) * 100 : null,
    prevEntryPx,
    nextEntryPx,
    price: Number.isFinite(price) ? price : null,
    stateSource,
    source,
    isEntryEvent: isEntryEventType(eventType),
    isExitEvent: isExitEventType(eventType),
    isFlipEvent: isFlipEventType(eventType),
    isTradedEvent: isEntryEventType(eventType),
    ...metadata,
  };
}

function buildLeaderEventsFromSnapshots(
  snapshots,
  { symbols = null, emitInitialEvents = false, epsilon = DEFAULT_EPSILON } = {}
) {
  const allowedSymbols = normalizeSymbolSet(symbols);
  const normalized = normalizeSnapshots(snapshots, {
    symbols: allowedSymbols ? Array.from(allowedSymbols) : null,
  });
  const priorStateByWallet = new Map();
  const seenWallets = new Set();
  const events = [];

  for (const snapshot of normalized) {
    const wallet = normalizeWallet(snapshot?.user);
    if (!wallet) continue;
    const nextPositions = mapPositionsBySymbol(snapshot.positions);
    const prevPositions = priorStateByWallet.get(wallet) || new Map();
    const symbolsForWallet = new Set([...prevPositions.keys(), ...nextPositions.keys()]);

    if (!seenWallets.has(wallet) && !emitInitialEvents) {
      seenWallets.add(wallet);
      priorStateByWallet.set(wallet, nextPositions);
      continue;
    }

    for (const symbol of symbolsForWallet) {
      if (allowedSymbols && !allowedSymbols.has(symbol)) continue;
      const prev = prevPositions.get(symbol) || null;
      const next = nextPositions.get(symbol) || null;
      const prevPos = num(prev?.szi, 0);
      const nextPos = num(next?.szi, 0);
      if (approxZero(nextPos - prevPos, epsilon)) continue;
      const eventType = classifyPositionTransition(prevPos, nextPos, epsilon);
      if (!eventType) continue;
      events.push(
        buildLeaderEvent({
          ts: snapshot.ts,
          wallet,
          symbol,
          eventType,
          prevPos,
          nextPos,
          prevEntryPx: prev?.entryPx ?? null,
          nextEntryPx: next?.entryPx ?? null,
          price: null,
          stateSource: "snapshots",
          source: snapshot?.source || "snapshot",
        })
      );
    }

    seenWallets.add(wallet);
    priorStateByWallet.set(wallet, nextPositions);
  }

  return events.sort(sortEvents);
}

function weightedEntryPx(prevPos, prevEntryPx, fillSide, fillSize, fillPx, nextPos) {
  const prev = num(prevPos, 0);
  const next = num(nextPos, 0);
  const price = num(fillPx, null);
  const prevSide = Math.sign(prev);
  const nextSide = Math.sign(next);
  const signedFill = fillSide * fillSize;

  if (nextSide === 0) return null;
  if (prevSide === 0) return price;
  if (prevSide !== nextSide) return price;

  const isAdd = Math.sign(signedFill) === prevSide && Math.abs(next) > Math.abs(prev);
  if (!isAdd) return Number.isFinite(prevEntryPx) ? prevEntryPx : price;

  const prevAbs = Math.abs(prev);
  const fillAbs = Math.abs(signedFill);
  if (!(prevAbs > 0) || !(fillAbs > 0)) return Number.isFinite(prevEntryPx) ? prevEntryPx : price;
  if (!Number.isFinite(prevEntryPx)) return price;
  if (!Number.isFinite(price)) return prevEntryPx;
  return (prevEntryPx * prevAbs + price * fillAbs) / (prevAbs + fillAbs);
}

function normalizeRawFill(raw, { symbols = null } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const wallet = normalizeWallet(raw.wallet || raw.user || raw.address);
  const symbol = normalizeSymbol(raw.symbol || raw.coin);
  const allowedSymbols = normalizeSymbolSet(symbols);
  if (!wallet || !symbol || (allowedSymbols && !allowedSymbols.has(symbol))) return null;

  const side = normalizeSide(raw.side);
  const ts = num(raw.time ?? raw.ts, null);
  const px = num(raw.px ?? raw.price, null);
  const sz = num(raw.sz ?? raw.size, null);
  if (!Number.isFinite(ts) || side === 0 || !Number.isFinite(px) || !(sz > 0)) return null;

  const isLiquidation =
    raw.isLiquidation === true ||
    raw.liquidation === true ||
    raw.liquidated === true ||
    (typeof raw.type === "string" && raw.type.toLowerCase().includes("liquid"));

  return {
    ts,
    time: ts,
    wallet,
    user: wallet,
    symbol,
    coin: symbol,
    side,
    px,
    sz,
    fee: raw.fee == null ? null : num(raw.fee, null),
    closedPnl: raw.closedPnl == null ? null : num(raw.closedPnl, null),
    isLiquidation: !!isLiquidation,
  };
}

function buildLeaderEventsFromFills(
  fills,
  {
    symbols = null,
    assumeFlatStart = false,
    requireReadyReset = true,
    epsilon = DEFAULT_EPSILON,
  } = {}
) {
  const normalized = (Array.isArray(fills) ? fills : [])
    .map((fill) => normalizeRawFill(fill, { symbols }))
    .filter(Boolean)
    .sort(
      (a, b) => a.ts - b.ts || a.wallet.localeCompare(b.wallet) || a.symbol.localeCompare(b.symbol)
    );

  const stateByWalletSymbol = new Map();
  const events = [];

  for (const fill of normalized) {
    const key = `${fill.wallet}:${fill.symbol}`;
    let state = stateByWalletSymbol.get(key);
    if (!state) {
      state = {
        ready: assumeFlatStart || !requireReadyReset,
        bootstrapPos: 0,
        pos: 0,
        entryPx: null,
      };
    }

    const signedFill = fill.side * fill.sz;
    if (!state.ready) {
      const bootstrapPos = state.bootstrapPos + signedFill;
      state.bootstrapPos = approxZero(bootstrapPos, epsilon) ? 0 : bootstrapPos;
      if (state.bootstrapPos === 0) {
        state.ready = true;
        state.pos = 0;
        state.entryPx = null;
      }
      stateByWalletSymbol.set(key, state);
      continue;
    }

    const prevPos = state.pos;
    const nextPosRaw = prevPos + signedFill;
    const nextPos = approxZero(nextPosRaw, epsilon) ? 0 : nextPosRaw;
    const eventType = classifyPositionTransition(prevPos, nextPos, epsilon);
    const nextEntryPx = weightedEntryPx(
      prevPos,
      state.entryPx,
      fill.side,
      fill.sz,
      fill.px,
      nextPos
    );

    if (eventType) {
      events.push(
        buildLeaderEvent({
          ts: fill.ts,
          wallet: fill.wallet,
          symbol: fill.symbol,
          eventType,
          prevPos,
          nextPos,
          prevEntryPx: state.entryPx,
          nextEntryPx,
          price: fill.px,
          stateSource: "fills",
          source: "fill",
          metadata: {
            fee: fill.fee,
            closedPnl: fill.closedPnl,
            isLiquidation: fill.isLiquidation,
          },
        })
      );
    }

    state.pos = nextPos;
    state.entryPx = nextEntryPx;
    if (state.pos === 0) state.entryPx = null;
    stateByWalletSymbol.set(key, state);
  }

  return events.sort(sortEvents);
}

function sortEvents(a, b) {
  return (
    num(a?.ts, 0) - num(b?.ts, 0) ||
    String(a?.wallet || "").localeCompare(String(b?.wallet || "")) ||
    String(a?.symbol || "").localeCompare(String(b?.symbol || "")) ||
    String(a?.eventType || "").localeCompare(String(b?.eventType || ""))
  );
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyFn(item);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function buildLeaderEventDataset({
  events,
  symbols = null,
  stateSource = null,
  source = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const allowedSymbols = normalizeSymbolSet(symbols);
  const normalizedEvents = (Array.isArray(events) ? events : [])
    .filter((event) => {
      const symbol = normalizeSymbol(event?.symbol || event?.coin);
      return allowedSymbols ? allowedSymbols.has(symbol) : true;
    })
    .map((event) => ({
      ...event,
      symbol: normalizeSymbol(event?.symbol || event?.coin),
      coin: normalizeSymbol(event?.symbol || event?.coin),
      wallet: normalizeWallet(event?.wallet || event?.user),
      user: normalizeWallet(event?.wallet || event?.user),
      ts: num(event?.ts ?? event?.time, null),
      time: num(event?.ts ?? event?.time, null),
    }))
    .filter((event) => event.wallet && event.symbol && Number.isFinite(event.ts))
    .sort(sortEvents);

  const uniqueWallets = new Set(normalizedEvents.map((event) => event.wallet));
  const uniqueSymbols = new Set(normalizedEvents.map((event) => event.symbol));

  return {
    format: "copy-trading-leader-event-dataset/v1",
    generatedAt,
    stateSource: stateSource || (normalizedEvents[0]?.stateSource ?? null),
    source,
    symbols: Array.from(uniqueSymbols),
    summary: {
      eventCount: normalizedEvents.length,
      tradedEventCount: normalizedEvents.filter((event) => event.isTradedEvent).length,
      wallets: uniqueWallets.size,
      symbols: uniqueSymbols.size,
      startMs: normalizedEvents.length ? normalizedEvents[0].ts : null,
      endMs: normalizedEvents.length ? normalizedEvents[normalizedEvents.length - 1].ts : null,
      bySymbol: countBy(normalizedEvents, (event) => event.symbol),
      byEventType: countBy(normalizedEvents, (event) => event.eventType),
      bySide: countBy(normalizedEvents, (event) => event.side),
      byStateSource: countBy(normalizedEvents, (event) => event.stateSource),
    },
    events: normalizedEvents,
  };
}

function loadLeaderEventDataset(
  filePath,
  { symbols = null, startMs = null, endMs = null, eventTypes = null } = {}
) {
  if (!fs.existsSync(filePath)) {
    return { dataset: null, events: [] };
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const allowedSymbols = normalizeSymbolSet(symbols);
  const allowedTypes = Array.isArray(eventTypes) && eventTypes.length ? new Set(eventTypes) : null;
  const events = (Array.isArray(raw?.events) ? raw.events : Array.isArray(raw) ? raw : [])
    .filter((event) => {
      const ts = num(event?.ts ?? event?.time, null);
      const symbol = normalizeSymbol(event?.symbol || event?.coin);
      if (!Number.isFinite(ts) || !symbol) return false;
      if (Number.isFinite(startMs) && ts < startMs) return false;
      if (Number.isFinite(endMs) && ts > endMs) return false;
      if (allowedSymbols && !allowedSymbols.has(symbol)) return false;
      if (allowedTypes && !allowedTypes.has(event?.eventType)) return false;
      return true;
    })
    .sort(sortEvents);
  return { dataset: raw, events };
}

function loadRawFillsFromFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  if (filePath.endsWith(".jsonl")) return readJsonl(filePath);

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.fills)) return raw.fills;
  if (Array.isArray(raw?.events)) return raw.events;
  if (raw?.walletFills && typeof raw.walletFills === "object") {
    const out = [];
    for (const [wallet, fills] of Object.entries(raw.walletFills)) {
      for (const fill of Array.isArray(fills) ? fills : []) {
        out.push({ wallet, ...fill });
      }
    }
    return out;
  }
  return [];
}

function buildFillDedupKey(fill, walletFallback = null) {
  const wallet = normalizeWallet(fill?.wallet || fill?.user || walletFallback);
  const symbol = normalizeSymbol(fill?.symbol || fill?.coin);
  const ts = num(fill?.time ?? fill?.ts, null);
  const side = normalizeSide(fill?.side);
  const px = num(fill?.px ?? fill?.price, null);
  const sz = num(fill?.sz ?? fill?.size, null);
  const hash = fill?.hash != null ? String(fill.hash) : "";
  const oid = fill?.oid != null ? String(fill.oid) : "";
  const tid = fill?.tid != null ? String(fill.tid) : "";
  return [wallet || "", symbol || "", ts ?? "", side, px ?? "", sz ?? "", hash, oid, tid].join("|");
}

function loadRawFillsFromCacheDir(cacheDir, { wallets = null } = {}) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return [];
  const walletFilter =
    Array.isArray(wallets) && wallets.length
      ? new Set(wallets.map((wallet) => normalizeWallet(wallet)).filter(Boolean))
      : null;
  const walletDirs = fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .map((wallet) => normalizeWallet(wallet))
    .filter(Boolean)
    .filter((wallet) => !walletFilter || walletFilter.has(wallet))
    .sort();

  const seen = new Set();
  const fills = [];

  for (const wallet of walletDirs) {
    const walletDir = path.join(cacheDir, wallet);
    const files = fs
      .readdirSync(walletDir)
      .filter((name) => name.endsWith(".json") || name.endsWith(".jsonl"))
      .sort();
    for (const fileName of files) {
      const filePath = path.join(walletDir, fileName);
      const rows = loadRawFillsFromFile(filePath);
      for (const row of rows) {
        const fill = { wallet, ...row };
        const dedupKey = buildFillDedupKey(fill, wallet);
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        fills.push(fill);
      }
    }
  }

  return fills.sort(
    (a, b) =>
      num(a?.time ?? a?.ts, 0) - num(b?.time ?? b?.ts, 0) ||
      String(a?.wallet || "").localeCompare(String(b?.wallet || "")) ||
      String(a?.coin || a?.symbol || "").localeCompare(String(b?.coin || b?.symbol || ""))
  );
}

function findLatestSnapshotDataset(
  rootDir = path.join(process.cwd(), "results", "json", "hyperliquid-position-snapshots")
) {
  const latest = path.join(rootDir, "latest.json");
  if (fs.existsSync(latest)) return latest;
  if (!fs.existsSync(rootDir)) return null;
  const files = fs
    .readdirSync(rootDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(rootDir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.length ? path.join(rootDir, files[0].name) : null;
}

module.exports = {
  DEFAULT_EPSILON,
  buildLeaderEvent,
  buildLeaderEventDataset,
  buildLeaderEventsFromFills,
  buildLeaderEventsFromSnapshots,
  classifyPositionTransition,
  findLatestSnapshotDataset,
  isEntryEventType,
  isExitEventType,
  isFlipEventType,
  loadLeaderEventDataset,
  loadRawFillsFromCacheDir,
  loadRawFillsFromFile,
  normalizeRawFill,
  normalizeSide,
  normalizeSymbol,
  normalizeWallet,
  sideFromPositionSize,
};
