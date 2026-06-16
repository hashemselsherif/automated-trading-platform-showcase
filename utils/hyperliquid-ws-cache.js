const fs = require("fs");
const path = require("path");

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function readJsonl(filePath, limit = Infinity, maxBytes = Infinity) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  const useChunked = Number.isFinite(maxBytes) && maxBytes !== Infinity;

  if (!useChunked) {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      if (out.length >= limit) break;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    return out;
  }

  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  let leftover = "";
  try {
    while (offset < maxBytes && out.length < limit) {
      const toRead = Math.min(buffer.length, maxBytes - offset);
      const bytes = fs.readSync(fd, buffer, 0, toRead, offset);
      if (bytes <= 0) break;
      offset += bytes;
      const chunk = buffer.toString("utf8", 0, bytes);
      const lines = (leftover + chunk).split("\n");
      leftover = lines.pop() || "";
      for (const line of lines) {
        if (out.length >= limit) break;
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // skip
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return out;
}

function extractClearinghouseState(record) {
  if (!record || typeof record !== "object") return null;
  const data = record.data || record;
  return data?.data?.clearinghouseState || data?.clearinghouseState || null;
}

function normalizePosition(pos) {
  const p = pos?.position || pos;
  if (!p || !p.coin) return null;
  return {
    coin: String(p.coin).toUpperCase(),
    szi: num(p.szi, 0),
    entryPx: num(p.entryPx, null),
    positionValue: num(p.positionValue, null),
    unrealizedPnl: num(p.unrealizedPnl, null),
    marginUsed: num(p.marginUsed, null),
    leverage: num(p?.leverage?.value, null),
  };
}

function normalizeSnapshotPositions(positions, { symbols = null } = {}) {
  const target =
    symbols && symbols.length ? new Set(symbols.map((s) => String(s).toUpperCase())) : null;
  return (Array.isArray(positions) ? positions : [])
    .map(normalizePosition)
    .filter(Boolean)
    .filter((p) => (!target ? true : target.has(p.coin)))
    .sort((a, b) => a.coin.localeCompare(b.coin));
}

function buildSnapshots(records, { symbols = null } = {}) {
  const out = [];
  for (const rec of records) {
    const state = extractClearinghouseState(rec);
    if (!state) continue;
    const positionsRaw = Array.isArray(state.assetPositions) ? state.assetPositions : [];
    const positions = normalizeSnapshotPositions(positionsRaw, { symbols });
    const ts = num(state.time, num(rec.ts, null));
    const user = rec?.user || rec?.data?.user || null;
    out.push({
      ts,
      user: typeof user === "string" ? user.toLowerCase() : null,
      positions,
      source: rec.channel || rec?.data?.channel || null,
    });
  }
  return out;
}

function normalizeSnapshots(
  snapshots,
  { symbols = null, startMs = null, endMs = null, collapseUnchanged = true } = {}
) {
  const out = [];
  const sorted = (Array.isArray(snapshots) ? snapshots : [])
    .map((snap) => {
      const ts = num(snap?.ts, null);
      const user = typeof snap?.user === "string" ? snap.user.toLowerCase() : null;
      if (!Number.isFinite(ts) || !user) return null;
      if (Number.isFinite(startMs) && ts < startMs) return null;
      if (Number.isFinite(endMs) && ts > endMs) return null;
      return {
        ts,
        user,
        source: snap?.source || null,
        positions: normalizeSnapshotPositions(snap?.positions, { symbols }),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.ts - b.ts) || a.user.localeCompare(b.user));

  const lastKeyByUser = new Map();
  for (const snap of sorted) {
    const positionsKey = JSON.stringify(
      snap.positions.map((p) => [p.coin, p.szi, p.entryPx, p.positionValue, p.unrealizedPnl, p.leverage])
    );
    if (collapseUnchanged && lastKeyByUser.get(snap.user) === positionsKey) continue;
    lastKeyByUser.set(snap.user, positionsKey);
    out.push(snap);
  }
  return out;
}

function buildPositionEvents(snapshots) {
  const events = [];
  for (const snap of snapshots) {
    if (!snap || !Array.isArray(snap.positions)) continue;
    for (const pos of snap.positions) {
      events.push({
        ts: snap.ts,
        user: snap.user,
        coin: pos.coin,
        szi: pos.szi,
        entryPx: pos.entryPx,
        positionValue: pos.positionValue,
        unrealizedPnl: pos.unrealizedPnl,
        leverage: pos.leverage,
      });
    }
  }
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return events;
}

function buildSnapshotStateEvents(snapshots) {
  return normalizeSnapshots(snapshots).map((snap) => ({
    kind: "position_snapshot",
    time: snap.ts,
    ts: snap.ts,
    user: snap.user,
    positions: snap.positions,
    source: snap.source || "snapshot",
  }));
}

function buildSnapshotDataset({
  snapshots,
  symbols = null,
  source = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedSnapshots = normalizeSnapshots(snapshots, { symbols });
  const events = buildPositionEvents(normalizedSnapshots);
  const users = Array.from(new Set(normalizedSnapshots.map((snap) => snap.user)));
  return {
    format: "hyperliquid-position-snapshot-dataset/v1",
    generatedAt,
    source,
    symbols:
      symbols && symbols.length
        ? symbols.map((s) => String(s).toUpperCase())
        : Array.from(
            new Set(
              normalizedSnapshots.flatMap((snap) =>
                snap.positions.map((position) => String(position.coin).toUpperCase())
              )
            )
          ),
    summary: {
      snapshotCount: normalizedSnapshots.length,
      eventCount: events.length,
      users: users.length,
      startMs: normalizedSnapshots.length ? normalizedSnapshots[0].ts : null,
      endMs: normalizedSnapshots.length
        ? normalizedSnapshots[normalizedSnapshots.length - 1].ts
        : null,
    },
    snapshots: normalizedSnapshots,
    events,
  };
}

function loadSnapshotDataset(
  filePath,
  { symbols = null, startMs = null, endMs = null, collapseUnchanged = true } = {}
) {
  if (!fs.existsSync(filePath)) {
    return { dataset: null, snapshots: [], events: [], snapshotEvents: [] };
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rawSnapshots = Array.isArray(raw?.snapshots) ? raw.snapshots : Array.isArray(raw) ? raw : [];
  const snapshots = normalizeSnapshots(rawSnapshots, {
    symbols,
    startMs,
    endMs,
    collapseUnchanged,
  });
  return {
    dataset: raw,
    snapshots,
    events: buildPositionEvents(snapshots),
    snapshotEvents: buildSnapshotStateEvents(snapshots),
  };
}

function loadWsCache(
  dir,
  {
    symbols = null,
    limitPerFile = Infinity,
    maxBytes = Infinity,
    includeWebData2 = true,
    includeClearinghouseState = true,
  } = {}
) {
  const webData2 = includeWebData2
    ? readJsonl(path.join(dir, "webData2.jsonl"), limitPerFile, maxBytes)
    : [];
  const clearinghouseState = includeClearinghouseState
    ? readJsonl(path.join(dir, "clearinghouseState.jsonl"), limitPerFile, maxBytes)
    : [];
  const combined = webData2.concat(clearinghouseState);
  const snapshots = normalizeSnapshots(buildSnapshots(combined, { symbols }), { symbols });
  return {
    snapshots,
    events: buildPositionEvents(snapshots),
    snapshotEvents: buildSnapshotStateEvents(snapshots),
  };
}

function findLatestRunDir(rootDir) {
  if (!fs.existsSync(rootDir)) return null;
  const entries = fs
    .readdirSync(rootDir)
    .map((name) => ({ name, stat: fs.statSync(path.join(rootDir, name)) }))
    .filter((x) => x.stat.isDirectory())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return entries.length ? path.join(rootDir, entries[0].name) : null;
}

module.exports = {
  readJsonl,
  loadWsCache,
  buildSnapshots,
  normalizeSnapshots,
  buildPositionEvents,
  buildSnapshotStateEvents,
  buildSnapshotDataset,
  loadSnapshotDataset,
  findLatestRunDir,
};
