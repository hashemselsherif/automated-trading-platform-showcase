const fs = require("fs");
const path = require("path");

const db = require("../db");
const { HyperliquidWebSocketClient } = require("./hyperliquid-ws-client");
const {
  createCopyTradingConsensusEngine,
  extractPositionsFromClearinghouseState,
} = require("./copy-trading-consensus-engine");

function num(v, d) {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function bool(v, d = false) {
  if (v === undefined || v === null || v === "") return d;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return d;
}

function normalizeUser(x) {
  const s = String(x || "")
    .trim()
    .toLowerCase();
  return s.startsWith("0x") ? s : null;
}

function normalizeSymbol(x) {
  const s = String(x || "")
    .trim()
    .toUpperCase()
    .replace(/-PERP$/i, "");
  return s || null;
}

function safeReadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadOverrides(filePath) {
  const overrides = safeReadJson(filePath) || {};
  const forceInclude = new Set((overrides.forceInclude || []).map(normalizeUser).filter(Boolean));
  const blocklist = new Set((overrides.blocklist || []).map(normalizeUser).filter(Boolean));
  const weightMultipliers = {};
  if (overrides.weightMultipliers && typeof overrides.weightMultipliers === "object") {
    for (const [k, v] of Object.entries(overrides.weightMultipliers)) {
      const u = normalizeUser(k);
      if (!u) continue;
      weightMultipliers[u] = v;
    }
  }
  const perWallet = {};
  if (overrides.perWallet && typeof overrides.perWallet === "object") {
    for (const [k, v] of Object.entries(overrides.perWallet)) {
      const u = normalizeUser(k);
      if (!u) continue;
      perWallet[u] = v;
    }
  }
  return { forceInclude, blocklist, weightMultipliers, perWallet };
}

function parseWalletArray(value) {
  return Array.isArray(value) ? value.map(normalizeUser).filter(Boolean) : [];
}

function parseWeightsObject(value) {
  const weights = new Map();
  if (!value || typeof value !== "object") return weights;
  for (const [k, v] of Object.entries(value)) {
    const u = normalizeUser(k);
    if (!u) continue;
    weights.set(u, num(v, 0));
  }
  return weights;
}

function loadTopK(topkFile) {
  const data = safeReadJson(topkFile);
  if (!data) {
    return {
      coreTopK: [],
      watchTopK: [],
      topK: [],
      coreWeights: new Map(),
      watchWeights: new Map(),
      weights: new Map(),
      snapshotFile: null,
      leaderMetadata: new Map(),
      perWallet: {},
      sourceInfo: {
        file: topkFile || null,
        type: null,
        name: null,
        generatedAt: null,
        symbol: null,
        targetSymbols: [],
        meta: {},
      },
    };
  }
  const topK = parseWalletArray(data.topK);
  const watchTopK = parseWalletArray(data.watchTopK);
  const coreTopK = parseWalletArray(data.coreTopK);
  const resolvedWatchTopK = watchTopK.length ? watchTopK : topK;
  const resolvedCoreTopK = coreTopK.length
    ? coreTopK
    : resolvedWatchTopK.slice(
        0,
        Math.max(1, Math.min(resolvedWatchTopK.length, num(data?.meta?.coreTopKRequested, 3)))
      );
  const watchWeights = parseWeightsObject(data.watchWeights && typeof data.watchWeights === "object" ? data.watchWeights : data.weights);
  const coreWeights = parseWeightsObject(data.coreWeights && typeof data.coreWeights === "object" ? data.coreWeights : data.weights);
  const leaderMetadata = new Map();
  for (const src of [
    data.leaderMetadataByUser,
    data.leaderMetaByUser,
    data.leaderMetadata,
    data.walletMetadata,
    data.metadataByWallet,
  ]) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      const u = normalizeUser(k);
      if (!u || !v || typeof v !== "object") continue;
      leaderMetadata.set(u, v);
    }
  }
  for (const row of [
    ...(Array.isArray(data.coreWatchlist) ? data.coreWatchlist : []),
    ...(Array.isArray(data.watchlist) ? data.watchlist : []),
  ]) {
    const u = normalizeUser(row?.wallet || row?.address || row?.user);
    if (!u || !row || typeof row !== "object") continue;
    const prev = leaderMetadata.get(u) || {};
    leaderMetadata.set(u, {
      ...prev,
      ...row,
    });
  }
  const perWallet = {};
  if (data.perWallet && typeof data.perWallet === "object") {
    for (const [k, v] of Object.entries(data.perWallet)) {
      const u = normalizeUser(k);
      if (!u || !v || typeof v !== "object") continue;
      perWallet[u] = v;
    }
  }
  const sourceSymbol = normalizeSymbol(data.symbol || data.targetSymbol || data.targetCoin);
  const sourceTargetSymbols = Array.isArray(data.targetSymbols)
    ? data.targetSymbols.map(normalizeSymbol).filter(Boolean)
    : sourceSymbol
      ? [sourceSymbol]
      : [];
  return {
    coreTopK: resolvedCoreTopK,
    watchTopK: resolvedWatchTopK,
    topK: resolvedWatchTopK,
    coreWeights,
    watchWeights,
    weights: watchWeights,
    snapshotFile: data.snapshotFile || null,
    leaderMetadata,
    perWallet,
    sourceInfo: {
      file: topkFile || null,
      type:
        data.sourceType ||
        data.sourceKind ||
        (String(topkFile || "").includes("copy-trading-watchlist")
          ? "wallet-following-watchlist"
          : "copy-trading-topk"),
      name: data.sourceName || data.sourceMethod || null,
      generatedAt: data.generatedAt || null,
      symbol: sourceSymbol,
      targetSymbols: sourceTargetSymbols,
      meta: data.meta && typeof data.meta === "object" ? data.meta : {},
    },
  };
}

function loadEliteSet(snapshotFile, fallbackFile) {
  const data = safeReadJson(snapshotFile || fallbackFile);
  if (!data || !data.outputs || !Array.isArray(data.outputs.wallets)) return new Set();
  const elite = new Set();
  for (const w of data.outputs.wallets) {
    if (!w || !w.address) continue;
    if (w.elite === true) {
      const u = normalizeUser(w.address);
      if (u) elite.add(u);
    }
  }
  return elite;
}

function buildWeightMap(topK, baseWeights, overrides, cfg) {
  const weights = new Map();
  const minWeight = num(cfg.weightCapMin, 0.05);
  const maxWeight = num(cfg.weightCapMax, 0.25);

  const avgWeight =
    topK.length > 0
      ? topK.reduce((s, u) => s + num(baseWeights.get(u), 0), 0) / topK.length
      : minWeight;

  for (const u of topK) {
    let w = num(baseWeights.get(u), avgWeight || minWeight);

    const perWallet = overrides.perWallet?.[u];
    const multRaw =
      overrides.weightMultipliers?.[u] ??
      (perWallet && Number.isFinite(perWallet.weightMult) ? perWallet.weightMult : null);
    if (Number.isFinite(multRaw)) w *= multRaw;

    w = Math.max(minWeight, Math.min(maxWeight, w));
    weights.set(u, w);
  }

  return weights;
}

function normalizePerWalletConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const normalized = {};
  if (cfg.enabled === false) normalized.enabled = false;
  if (Number.isFinite(cfg.weightMult)) normalized.weightMult = cfg.weightMult;
  if (Array.isArray(cfg.symbolsAllow)) {
    const allow = cfg.symbolsAllow.map(normalizeSymbol).filter(Boolean);
    if (allow.length) normalized.symbolsAllow = allow;
  }
  if (Array.isArray(cfg.symbolsDeny)) {
    const deny = cfg.symbolsDeny.map(normalizeSymbol).filter(Boolean);
    if (deny.length) normalized.symbolsDeny = deny;
  }
  if (cfg.clusterId != null) normalized.clusterId = cfg.clusterId;
  if (cfg.familyId != null) normalized.familyId = cfg.familyId;
  return normalized;
}

function mergePerWalletConfig(base = {}, overlay = {}) {
  const merged = {
    ...base,
    ...overlay,
  };
  if (overlay.symbolsAllow == null && base.symbolsAllow) merged.symbolsAllow = base.symbolsAllow;
  if (overlay.symbolsDeny == null && base.symbolsDeny) merged.symbolsDeny = base.symbolsDeny;
  return normalizePerWalletConfig(merged) || {};
}

function applyOverridesToTopK(topK, overrides) {
  const out = new Set(topK);
  for (const u of overrides.forceInclude || []) {
    if (!u) continue;
    out.add(u);
  }
  for (const u of overrides.blocklist || []) {
    if (!u) continue;
    out.delete(u);
  }
  for (const [addr, cfg] of Object.entries(overrides.perWallet || {})) {
    const u = normalizeUser(addr);
    if (!u || !cfg) continue;
    if (cfg.enabled === false) out.delete(u);
  }
  return Array.from(out);
}

function normalizeOverrideArray(value) {
  if (!value) return [];
  const arr = value instanceof Set ? Array.from(value) : Array.isArray(value) ? value : [];
  return arr.map(normalizeUser).filter(Boolean).sort();
}

function normalizeWeightMultipliers(weightMultipliers = {}) {
  return Object.entries(weightMultipliers || {})
    .map(([k, v]) => [normalizeUser(k), num(v, 0)])
    .filter(([k]) => k)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function normalizePerWallet(perWallet = {}) {
  return Object.entries(perWallet || {})
    .map(([k, v]) => {
      const u = normalizeUser(k);
      const payload = normalizePerWalletConfig(v);
      if (!u || !payload) return null;
      return [u, payload];
    })
    .filter(Boolean)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function fingerprintOverrides(overrides) {
  return JSON.stringify({
    forceInclude: normalizeOverrideArray(overrides?.forceInclude),
    blocklist: normalizeOverrideArray(overrides?.blocklist),
    weightMultipliers: normalizeWeightMultipliers(overrides?.weightMultipliers),
    perWallet: normalizePerWallet(overrides?.perWallet),
  });
}

function fingerprintTopK(topK, weights) {
  const top = normalizeOverrideArray(topK);
  const weightEntries =
    weights instanceof Map
      ? Array.from(weights.entries())
          .map(([k, v]) => [normalizeUser(k), num(v, 0)])
          .filter(([k]) => k)
          .sort((a, b) => a[0].localeCompare(b[0]))
      : [];
  return JSON.stringify({ topK: top, weights: weightEntries });
}

function fingerprintLeaderMetadata(leaderMetadata) {
  const entries =
    leaderMetadata instanceof Map
      ? Array.from(leaderMetadata.entries())
          .map(([user, meta]) => [normalizeUser(user), meta || null])
          .filter(([user]) => user)
          .sort((a, b) => a[0].localeCompare(b[0]))
      : [];
  return JSON.stringify({ leaderMetadata: entries });
}

function fingerprintElite(eliteSet) {
  const elite = normalizeOverrideArray(eliteSet);
  return JSON.stringify({ elite });
}

class CopyTradingConsensusProvider {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.enabled =
      options.enabled !== undefined
        ? options.enabled !== false
        : bool(process.env.COPY_HL_WS_ENABLED, true);

    this.topkFile =
      options.topkFile ||
      process.env.COPY_TOPK_FILE ||
      path.join(process.cwd(), "results", "json", "copy-trading-topk", "latest.json");
    this.watchlistFile =
      options.watchlistFile ||
      process.env.COPY_WATCHLIST_FILE ||
      path.join(process.cwd(), "results", "json", "copy-trading-watchlist", "latest.json");
    this.snapshotFallback =
      options.snapshotFallback ||
      path.join(process.cwd(), "results", "json", "hyperliquid-leader-snapshots", "latest.json");
    this.overridesFile =
      options.overridesFile ||
      process.env.COPY_OVERRIDES_FILE ||
      path.join(process.cwd(), "config", "copy-trading-overrides.json");

    this.reloadMs = Math.max(
      10_000,
      num(
        options.reloadMs,
        num(process.env.COPY_OVERRIDES_RELOAD_MS, num(process.env.COPY_TOPK_RELOAD_MS, 120_000))
      )
    );
    this.summaryIntervalMs = Math.max(
      15_000,
      num(options.summaryIntervalMs, num(process.env.COPY_TRACKER_LOG_INTERVAL_MS, 60_000))
    );
    this.logChanges = bool(options.logChanges, bool(process.env.COPY_TRACKER_LOG_CHANGES, true));

    this.targetSymbols = String(
      options.targetSymbols || process.env.COPY_TARGET_SYMBOLS || "BTC,ETH,SOL"
    )
      .split(",")
      .map((s) => normalizeSymbol(s))
      .filter(Boolean);
    this.configuredTargetSymbols = [...this.targetSymbols];

    this.engine = createCopyTradingConsensusEngine({
      staleMs: Math.max(5_000, num(options.staleMs, num(process.env.COPY_WS_STALE_MS, 120_000))),
      minLeaders: Math.max(
        1,
        num(
          options.minLeaders,
          num(process.env.COPY_ENGINE_MIN_LEADERS, num(process.env.COPY_MIN_LEADERS, 3))
        )
      ),
      minEffectiveN: Math.max(
        0,
        num(options.minEffectiveN, num(process.env.COPY_MIN_EFFECTIVE_N, 2.0))
      ),
      convictionNotionalCapUsd: Math.max(
        1,
        num(options.convictionCapUsd, num(process.env.COPY_CONVICTION_NOTIONAL_CAP_USD, 50_000))
      ),
      convictionMinMult: Math.max(
        0,
        num(options.convictionMinMult, num(process.env.COPY_CONVICTION_MIN_MULT, 0.25))
      ),
      convictionMaxMult: Math.max(
        0,
        num(options.convictionMaxMult, num(process.env.COPY_CONVICTION_MAX_MULT, 1.0))
      ),
      eliteEnabled: bool(options.eliteEnabled, bool(process.env.COPY_ELITE_PATH_ENABLED, true)),
      eliteMinLeaders: Math.max(
        1,
        num(options.eliteMinLeaders, num(process.env.COPY_ELITE_MIN_LEADERS, 1))
      ),
      eliteMinConsensusAbs: Math.max(
        0,
        Math.min(
          1,
          num(options.eliteMinConsensusAbs, num(process.env.COPY_ELITE_MIN_CONSENSUS_ABS, 0.65))
        )
      ),
      eliteMaxWeightShare: Math.max(
        0,
        Math.min(
          1,
          num(options.eliteMaxWeightShare, num(process.env.COPY_ELITE_MAX_WEIGHT_SHARE, 0.6))
        )
      ),
      targetCoins: this.targetSymbols,
    });

    this.weightCapMin = num(options.weightCapMin, num(process.env.COPY_WEIGHT_CAP_MIN, 0.05));
    this.weightCapMax = num(options.weightCapMax, num(process.env.COPY_WEIGHT_CAP_MAX, 0.25));
    this.alertRelativeSizeThreshold = Math.max(
      0.05,
      num(options.alertRelativeSizeThreshold, num(process.env.COPY_ALERT_RELATIVE_SIZE_THRESHOLD, 0.35))
    );
    this.alertAbsoluteSizeFloorUsd = Math.max(
      0,
      num(options.alertAbsoluteSizeFloorUsd, num(process.env.COPY_ALERT_ABSOLUTE_SIZE_FLOOR_USD, 2_500))
    );
    this.alertNormalSizeFloorPct = Math.max(
      0.01,
      num(options.alertNormalSizeFloorPct, num(process.env.COPY_ALERT_NORMAL_SIZE_FLOOR_PCT, 0.2))
    );
    this.alertNormalSizeEwmaAlpha = Math.min(
      1,
      Math.max(0.01, num(options.alertNormalSizeEwmaAlpha, num(process.env.COPY_ALERT_NORMAL_SIZE_EWMA_ALPHA, 0.2)))
    );

    this.coreTopK = [];
    this.watchTopK = [];
    this.topK = [];
    this.coreWeights = new Map();
    this.watchWeights = new Map();
    this.weights = new Map();
    this.eliteSet = new Set();
    this.leaderMetadata = new Map();
    this.overrides = loadOverrides(this.overridesFile);
    this.sourceInfo = {
      file: null,
      type: null,
      name: null,
      generatedAt: null,
      symbol: null,
      targetSymbols: [],
      meta: {},
    };

    this._summaryTimer = null;
    this._reloadTimer = null;
    this._trackedPositions = new Map();
    this._lastSnapshotByUser = new Map();
    this._awaitingFreshSnapshots = new Set();
    this._normalSizeByUser = new Map();
    this._lastConsensus = new Map();
    this._overridesFingerprint = null;
    this._topkFingerprint = null;
    this._eliteFingerprint = null;
    this._leaderMetadataFingerprint = null;
    this._lastSummary = null;

    this.ws = new HyperliquidWebSocketClient({
      wsUrl: options.wsUrl || process.env.HYPERLIQUID_WS_URL || "wss://api.hyperliquid.xyz/ws",
      reconnectDelayMs: num(options.reconnectDelayMs, 5_000),
      maxReconnectAttempts: num(options.maxReconnectAttempts, 100),
      shouldReconnect: options.shouldReconnect !== false,
      logger: this.logger,
    });
  }

  start() {
    if (!this.enabled) {
      this.logger.warn("[CopyTradingConsensus] Disabled (COPY_HL_WS_ENABLED=false)");
      return;
    }

    this._loadState(true);
    this._bindWs();

    this.ws.connect();

    this._reloadTimer = setInterval(() => this._loadState(false), this.reloadMs);
    this._summaryTimer = setInterval(() => this._logSummary(), this.summaryIntervalMs);
  }

  stop() {
    if (this._reloadTimer) clearInterval(this._reloadTimer);
    if (this._summaryTimer) clearInterval(this._summaryTimer);
    this._reloadTimer = null;
    this._summaryTimer = null;
    this.ws.disconnect();
  }

  getConsensus({ symbol, ts } = {}) {
    const coin = normalizeSymbol(symbol);
    if (!coin) return null;

    const topK = this._filterTopKForSymbol(coin);
    if (!topK.length) return null;

    const weights = buildWeightMap(topK, this.weights, this.overrides, {
      weightCapMin: this.weightCapMin,
      weightCapMax: this.weightCapMax,
    });

    const res = this.engine.computeConsensusForSymbol({
      coin,
      topK,
      weights,
      eliteSet: this.eliteSet,
      leaderMetadata: this.leaderMetadata,
      nowMs: Number.isFinite(ts) ? ts : Date.now(),
    });

    if (!res) return null;
    const eliteOk = res?.elite?.ok === true;
    const ok = res?.ok === true;
    const activePath = ok
      ? {
          contributors: res.contributors,
          confidence: res.confidence,
          effectiveN: res.effectiveN,
          dispersion: res.dispersion,
          maxWeightShare: res.maxWeightShare,
          maxClusterWeightShare: res.maxClusterWeightShare,
          maxFamilyWeightShare: res.maxFamilyWeightShare,
          hhi: res.hhi,
          longWeightShare: res.longWeightShare,
          shortWeightShare: res.shortWeightShare,
          clusterCount: res.clusterCount,
          familyCount: res.familyCount,
          dominantCluster: res.dominantCluster,
          dominantFamily: res.dominantFamily,
        }
      : eliteOk
        ? {
            contributors: res.elite.contributors,
            confidence: res.elite.confidence,
            effectiveN: res.elite.effectiveN,
            dispersion: res.elite.dispersion,
            maxWeightShare: res.elite.maxWeightShare,
            maxClusterWeightShare: res.elite.maxClusterWeightShare,
            maxFamilyWeightShare: res.elite.maxFamilyWeightShare,
            hhi: res.elite.hhi,
            longWeightShare: res.elite.longWeightShare,
            shortWeightShare: res.elite.shortWeightShare,
            clusterCount: res.elite.clusterCount,
            familyCount: res.elite.familyCount,
            dominantCluster: res.elite.dominantCluster,
            dominantFamily: res.elite.dominantFamily,
          }
        : {
            contributors: res.contributors,
            confidence: res.confidence,
            effectiveN: res.effectiveN,
            dispersion: res.dispersion,
            maxWeightShare: res.maxWeightShare,
            maxClusterWeightShare: res.maxClusterWeightShare,
            maxFamilyWeightShare: res.maxFamilyWeightShare,
            hhi: res.hhi,
            longWeightShare: res.longWeightShare,
            shortWeightShare: res.shortWeightShare,
            clusterCount: res.clusterCount,
            familyCount: res.familyCount,
            dominantCluster: res.dominantCluster,
            dominantFamily: res.dominantFamily,
          };
    if (!ok && !eliteOk) {
      return {
        cTop: 0,
        kTop: 0,
        cWorst: 0,
        kWorst: 0,
        meta: {
          ok: false,
          reason: "insufficient_leaders_or_stale",
          contributors: activePath.contributors,
          confidence: activePath.confidence,
          effectiveN: activePath.effectiveN,
          dispersion: activePath.dispersion,
          maxWeightShare: activePath.maxWeightShare,
          maxClusterWeightShare: activePath.maxClusterWeightShare,
          maxFamilyWeightShare: activePath.maxFamilyWeightShare,
          hhi: activePath.hhi,
          longWeightShare: activePath.longWeightShare,
          shortWeightShare: activePath.shortWeightShare,
          clusterCount: activePath.clusterCount,
          familyCount: activePath.familyCount,
          dominantCluster: activePath.dominantCluster,
          dominantFamily: activePath.dominantFamily,
          excluded: res.excluded,
          leaderLeverage: res.leaderLeverage ?? null,
          leaderLeverageSamples: res.leaderLeverageSamples ?? 0,
        },
      };
    }

    const consensus = ok ? res.consensus : res.elite.consensus;
    const contributors = ok ? res.contributors : res.elite.contributors;

    return {
      cTop: consensus,
      kTop: contributors,
      cWorst: 0,
      kWorst: 0,
      meta: {
        ok: ok || eliteOk,
        eliteUsed: !ok && eliteOk,
        reason: !ok && eliteOk ? "elite_override" : "consensus_ok",
        confidence: activePath.confidence,
        effectiveN: activePath.effectiveN,
        dispersion: activePath.dispersion,
        maxWeightShare: activePath.maxWeightShare,
        maxClusterWeightShare: activePath.maxClusterWeightShare,
        maxFamilyWeightShare: activePath.maxFamilyWeightShare,
        hhi: activePath.hhi,
        longWeightShare: activePath.longWeightShare,
        shortWeightShare: activePath.shortWeightShare,
        clusterCount: activePath.clusterCount,
        familyCount: activePath.familyCount,
        dominantCluster: activePath.dominantCluster,
        dominantFamily: activePath.dominantFamily,
        excluded: res.excluded,
        contributors: activePath.contributors,
        leaderLeverage: res.leaderLeverage ?? null,
        leaderLeverageSamples: res.leaderLeverageSamples ?? 0,
      },
    };
  }

  _bindWs() {
    this.ws.on("message", ({ raw }) => {
      const ts = Date.now();
      this.engine.ingestWsMessage(raw, ts);
      this._trackPositions(raw, ts);
    });

    this.ws.on("hl_error", (msg) => {
      const data = msg?.data || msg;
      const err = data?.data || data?.error || data;
      this.logger.warn("[CopyTradingConsensus] WS provider error:", err);
    });

    this.ws.on("connected", () => {
      this._subscribeAll();
    });
  }

  _resolveSourceFile() {
    const candidates = [this.watchlistFile, this.topkFile].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return candidates[0] || null;
  }

  _loadState(log = false) {
    const overrides = loadOverrides(this.overridesFile);
    const sourceFile = this._resolveSourceFile();
    const {
      coreTopK,
      watchTopK,
      coreWeights,
      watchWeights,
      snapshotFile,
      leaderMetadata,
      perWallet,
      sourceInfo,
    } = loadTopK(sourceFile);
    const mergedPerWallet = {};
    for (const [user, cfg] of Object.entries(perWallet || {})) {
      const u = normalizeUser(user);
      const normalized = normalizePerWalletConfig(cfg);
      if (!u || !normalized) continue;
      mergedPerWallet[u] = normalized;
    }
    for (const [user, cfg] of Object.entries(overrides.perWallet || {})) {
      const u = normalizeUser(user);
      const normalized = normalizePerWalletConfig(cfg);
      if (!u || !normalized) continue;
      mergedPerWallet[u] = mergePerWalletConfig(mergedPerWallet[u], normalized);
    }
    const mergedOverrides = {
      ...overrides,
      perWallet: mergedPerWallet,
    };
    this.overrides = mergedOverrides;

    const mergedWatchTopK = applyOverridesToTopK(watchTopK, mergedOverrides);
    const mergedCoreTopK = applyOverridesToTopK(coreTopK, mergedOverrides).filter((u) =>
      mergedWatchTopK.includes(u)
    );
    const eliteSet = loadEliteSet(snapshotFile, this.snapshotFallback);
    const watchWeightMap = buildWeightMap(mergedWatchTopK, watchWeights, mergedOverrides, {
      weightCapMin: this.weightCapMin,
      weightCapMax: this.weightCapMax,
    });
    const mergedLeaderMetadata = new Map(leaderMetadata);
    for (const [user, cfg] of Object.entries(mergedOverrides.perWallet || {})) {
      const u = normalizeUser(user);
      if (!u || !cfg) continue;
      const clusterId = cfg.clusterId ?? cfg.cluster ?? null;
      const familyId = cfg.familyId ?? cfg.family ?? cfg.strategyFamily ?? null;
      if (clusterId == null && familyId == null) continue;
      const prev = mergedLeaderMetadata.get(u) || {};
      mergedLeaderMetadata.set(u, {
        ...prev,
        ...(clusterId != null ? { clusterId } : {}),
        ...(familyId != null ? { familyId } : {}),
      });
    }

    const overridesFingerprint = fingerprintOverrides(mergedOverrides);
    const topkFingerprint = JSON.stringify({
      coreTopK: mergedCoreTopK,
      watchTopK: mergedWatchTopK,
      coreWeights: Array.from(coreWeights.entries()).sort((a, b) => a[0].localeCompare(b[0])),
      watchWeights: Array.from(watchWeights.entries()).sort((a, b) => a[0].localeCompare(b[0])),
    });
    const eliteFingerprint = fingerprintElite(eliteSet);
    const leaderMetadataFingerprint = fingerprintLeaderMetadata(mergedLeaderMetadata);

    const overridesChanged =
      this._overridesFingerprint !== null && this._overridesFingerprint !== overridesFingerprint;
    const topkChanged = this._topkFingerprint !== null && this._topkFingerprint !== topkFingerprint;
    const eliteChanged =
      this._eliteFingerprint !== null && this._eliteFingerprint !== eliteFingerprint;
    const leaderMetadataChanged =
      this._leaderMetadataFingerprint !== null &&
      this._leaderMetadataFingerprint !== leaderMetadataFingerprint;

    const sourceTargetSymbols =
      Array.isArray(sourceInfo?.targetSymbols) && sourceInfo.targetSymbols.length
        ? sourceInfo.targetSymbols.map(normalizeSymbol).filter(Boolean)
        : [...this.configuredTargetSymbols];

    this.coreTopK = mergedCoreTopK;
    this.watchTopK = mergedWatchTopK;
    this.topK = mergedWatchTopK;
    this.coreWeights = coreWeights;
    this.watchWeights = watchWeights;
    this.weights = watchWeights;
    this.eliteSet = eliteSet;
    this.leaderMetadata = mergedLeaderMetadata;
    this.targetSymbols = sourceTargetSymbols;
    this.engine.config.targetCoins = new Set(this.targetSymbols);
    this.sourceInfo = {
      ...this.sourceInfo,
      ...(sourceInfo || {}),
      file: sourceInfo?.file || sourceFile || null,
    };
    this._overridesFingerprint = overridesFingerprint;
    this._topkFingerprint = topkFingerprint;
    this._eliteFingerprint = eliteFingerprint;
    this._leaderMetadataFingerprint = leaderMetadataFingerprint;

    if (log) {
      this.logger.log("[CopyTradingConsensus] Loaded TopK", {
        coreTopK: this.coreTopK.length,
        watchTopK: this.watchTopK.length,
        elite: this.eliteSet.size,
        sourceType: this.sourceInfo.type,
        sourceFile: this.sourceInfo.file,
      });
    } else {
      if (overridesChanged) {
        this.logger.log("[COPY_TRACKER] overrides_reload", {
          forceInclude: mergedOverrides.forceInclude?.size || 0,
          blocklist: mergedOverrides.blocklist?.size || 0,
          perWallet: Object.keys(mergedOverrides.perWallet || {}).length,
        });
      }
      if (topkChanged) {
        this.logger.log("[COPY_TRACKER] topk_reload", {
          coreTopK: this.coreTopK.length,
          watchTopK: this.watchTopK.length,
          sourceType: this.sourceInfo.type,
          sourceFile: this.sourceInfo.file,
        });
      }
      if (eliteChanged) {
        this.logger.log("[COPY_TRACKER] elite_reload", {
          elite: this.eliteSet.size,
        });
      }
      if (leaderMetadataChanged) {
        this.logger.log("[COPY_TRACKER] leader_metadata_reload", {
          wallets: this.leaderMetadata.size,
        });
      }
    }

    this._logTopkSnapshot({
      ts: Date.now(),
      topK: mergedWatchTopK,
      weightMap: watchWeightMap,
      eliteSet,
      overrides: mergedOverrides,
      snapshotFile,
    });

    this._subscribeAll();
  }

  _subscribeAll() {
    const useWebData2 = bool(process.env.COPY_HL_WS_SUB_WEB_DATA2, true);
    const useClearinghouse = bool(process.env.COPY_HL_WS_SUB_CLEARINGHOUSE, true);
    const useTrades = bool(process.env.COPY_HL_WS_SUB_TRADES, false);
    this._awaitingFreshSnapshots = new Set(this.watchTopK);

    if (useTrades) {
      for (const s of this.targetSymbols) {
        this.ws.subscribeTrades(s);
      }
    }

    for (const u of this.watchTopK) {
      if (useWebData2) this.ws.subscribeWebData2(u);
      if (useClearinghouse) this.ws.subscribeClearinghouseState(u);
    }
  }

  _getTierTopK(kind = "watch") {
    return kind === "core" ? this.coreTopK : this.watchTopK;
  }

  _filterTopKForSymbol(symbol, kind = "watch") {
    const coin = normalizeSymbol(symbol);
    if (!coin) return [];
    const out = [];
    for (const u of this._getTierTopK(kind)) {
      const cfg = this.overrides.perWallet?.[u];
      if (!cfg) {
        out.push(u);
        continue;
      }
      if (cfg.enabled === false) continue;
      const allow = Array.isArray(cfg.symbolsAllow)
        ? cfg.symbolsAllow.map(normalizeSymbol).filter(Boolean)
        : null;
      const deny = Array.isArray(cfg.symbolsDeny)
        ? cfg.symbolsDeny.map(normalizeSymbol).filter(Boolean)
        : null;

      if (allow && allow.length && !allow.includes(coin)) continue;
      if (deny && deny.length && deny.includes(coin)) continue;
      out.push(u);
    }
    return out;
  }

  _getNormalSizeBaseline(user, coin) {
    const walletMap = this._normalSizeByUser.get(user);
    if (!walletMap) return 0;
    return num(walletMap.get(coin)?.ewmaNotional, 0);
  }

  _updateNormalSizeBaseline(user, coin, positionValue) {
    const notional = Math.abs(num(positionValue, 0));
    if (!(notional > 0)) return;
    if (!this._normalSizeByUser.has(user)) this._normalSizeByUser.set(user, new Map());
    const walletMap = this._normalSizeByUser.get(user);
    const prev = walletMap.get(coin) || { ewmaNotional: 0, samples: 0 };
    const nextValue =
      prev.samples > 0
        ? prev.ewmaNotional * (1 - this.alertNormalSizeEwmaAlpha) +
          notional * this.alertNormalSizeEwmaAlpha
        : notional;
    walletMap.set(coin, {
      ewmaNotional: nextValue,
      samples: prev.samples + 1,
    });
  }

  _shouldPromoteTrackedChange({ user, before, after, isBootstrap, staleGap }) {
    if (!this.coreTopK.includes(user)) return { ok: false, reason: "watch_only" };
    if (isBootstrap) return { ok: false, reason: "bootstrap" };
    if (staleGap) return { ok: false, reason: "reconnect_gap" };

    const beforeNotional = Math.abs(num(before?.positionValue, 0));
    const afterNotional = Math.abs(num(after?.positionValue, 0));
    const beforeSize = Math.abs(num(before?.szi, 0));
    const afterSize = Math.abs(num(after?.szi, 0));
    const deltaSize = Math.abs(afterSize - beforeSize);
    const beforeUnitNotional = beforeSize > 0 ? beforeNotional / beforeSize : 0;
    const afterUnitNotional = afterSize > 0 ? afterNotional / afterSize : 0;
    const referenceUnitNotional = Math.max(beforeUnitNotional, afterUnitNotional, 0);
    const deltaNotional =
      deltaSize > 0 && referenceUnitNotional > 0
        ? deltaSize * referenceUnitNotional
        : Math.abs(afterNotional - beforeNotional);
    const normalNotional = this._getNormalSizeBaseline(user, before?.coin || after?.coin);
    const absoluteFloor = Math.max(
      this.alertAbsoluteSizeFloorUsd,
      normalNotional * this.alertNormalSizeFloorPct
    );
    const relativeBase =
      beforeNotional === 0 || afterNotional === 0
        ? Math.max(beforeNotional, afterNotional, normalNotional, 1)
        : Math.max(beforeSize, afterSize, 1e-9);
    const relativeChange =
      beforeNotional === 0 || afterNotional === 0
        ? deltaNotional / relativeBase
        : deltaSize / relativeBase;

    if (beforeNotional === 0 && afterNotional > 0) {
      return {
        ok: afterNotional >= absoluteFloor,
        reason: afterNotional >= absoluteFloor ? "promote" : "below_notional_floor",
        absoluteFloor,
        relativeChange,
        deltaNotional,
        normalNotional,
      };
    }

    if (beforeNotional > 0 && afterNotional === 0) {
      return {
        ok: beforeNotional >= absoluteFloor,
        reason: beforeNotional >= absoluteFloor ? "promote" : "below_notional_floor",
        absoluteFloor,
        relativeChange,
        deltaNotional,
        normalNotional,
      };
    }

    if (deltaSize <= 1e-9) {
      return {
        ok: false,
        reason: "no_size_delta",
        absoluteFloor,
        relativeChange: 0,
        deltaNotional: 0,
        normalNotional,
      };
    }

    const passesRelative = relativeChange >= this.alertRelativeSizeThreshold;
    const passesAbsolute = deltaNotional >= absoluteFloor;

    return {
      ok: passesRelative && passesAbsolute,
      reason: passesRelative && passesAbsolute ? "promote" : "below_resize_threshold",
      absoluteFloor,
      relativeChange,
      deltaNotional,
      normalNotional,
    };
  }

  _trackPositions(msg, ts) {
    const channel =
      msg?.channel ||
      msg?.type ||
      msg?.data?.type ||
      msg?.subscription?.type ||
      msg?.result?.type ||
      null;
    if (channel !== "webData2" && channel !== "clearinghouseState") return;

    const user =
      (typeof msg?.data?.user === "string" && msg.data.user) ||
      (typeof msg?.user === "string" && msg.user) ||
      (typeof msg?.data?.data?.user === "string" && msg.data.data.user) ||
      (typeof msg?.data?.data?.clearinghouseState?.user === "string" &&
        msg.data.data.clearinghouseState.user) ||
      null;
    const u = normalizeUser(user);
    if (!u) return;

    const clearinghouseState =
      msg?.data?.clearinghouseState ||
      msg?.data?.data?.clearinghouseState ||
      msg?.data?.data?.clearinghouseState?.clearinghouseState ||
      msg?.data?.data?.clearinghouseState ||
      null;
    if (!clearinghouseState) return;

    const positions = extractPositionsFromClearinghouseState(clearinghouseState, {
      targetCoins: new Set(this.targetSymbols),
    });

    if (!this._trackedPositions.has(u)) this._trackedPositions.set(u, new Map());
    const prev = this._trackedPositions.get(u);
    const previousSnapshotTs = this._lastSnapshotByUser.get(u);
    const staleGap =
      Number.isFinite(previousSnapshotTs) &&
      previousSnapshotTs > 0 &&
      ts - previousSnapshotTs > (this.engine?.config?.staleMs || 120_000);
    const isBootstrap = this._awaitingFreshSnapshots.has(u);

    const next = new Map();
    for (const p of positions) {
      const dir = p.szi > 0 ? 1 : p.szi < 0 ? -1 : 0;
      next.set(p.coin, { dir, szi: p.szi, positionValue: p.positionValue, ts });
    }

    if (this.logChanges) {
      const coins = new Set([...prev.keys(), ...next.keys()]);
      for (const coin of coins) {
        const before = prev.get(coin);
        const after = next.get(coin);
        const beforeDir = before ? before.dir : 0;
        const afterDir = after ? after.dir : 0;
        const sizeDelta = Math.abs(num(after?.szi, 0) - num(before?.szi, 0));
        if (beforeDir === afterDir && afterDir !== 0 && sizeDelta <= 1e-9) continue;
        const promoted = this._shouldPromoteTrackedChange({
          user: u,
          before: before ? { ...before, coin } : { coin, positionValue: 0 },
          after: after ? { ...after, coin } : { coin, positionValue: 0 },
          isBootstrap,
          staleGap,
        });

        if (beforeDir === afterDir && afterDir !== 0) {
          if (!promoted.ok) continue;
          this.logger.log("[COPY_TRACKER] leader_size_change", {
            user: u,
            tier: "core",
            coin,
            dir: afterDir > 0 ? "long" : "short",
            szi: after?.szi ?? null,
            notional: after?.positionValue ?? null,
            deltaNotionalUsd: promoted.deltaNotional,
            relativeChange: promoted.relativeChange,
            absoluteFloorUsd: promoted.absoluteFloor,
            normalNotionalUsd: promoted.normalNotional,
            ts,
          });
          continue;
        }
        if (beforeDir === afterDir) continue;
        if (!promoted.ok) continue;
        if (beforeDir === 0 && afterDir !== 0) {
          this.logger.log("[COPY_TRACKER] leader_entry", {
            user: u,
            tier: "core",
            coin,
            dir: afterDir > 0 ? "long" : "short",
            szi: after?.szi ?? null,
            notional: after?.positionValue ?? null,
            absoluteFloorUsd: promoted.absoluteFloor,
            normalNotionalUsd: promoted.normalNotional,
            ts,
          });
        } else if (beforeDir !== 0 && afterDir === 0) {
          this.logger.log("[COPY_TRACKER] leader_exit", {
            user: u,
            tier: "core",
            coin,
            dir: beforeDir > 0 ? "long" : "short",
            absoluteFloorUsd: promoted.absoluteFloor,
            normalNotionalUsd: promoted.normalNotional,
            ts,
          });
        } else {
          this.logger.log("[COPY_TRACKER] leader_flip", {
            user: u,
            tier: "core",
            coin,
            from: beforeDir > 0 ? "long" : "short",
            to: afterDir > 0 ? "long" : "short",
            absoluteFloorUsd: promoted.absoluteFloor,
            normalNotionalUsd: promoted.normalNotional,
            ts,
          });
        }
      }
    }

    this._trackedPositions.set(u, next);
    this._lastSnapshotByUser.set(u, ts);
    this._awaitingFreshSnapshots.delete(u);
    for (const [coin, position] of next.entries()) {
      this._updateNormalSizeBaseline(u, coin, position?.positionValue);
    }
  }

  _buildSummary() {
    const now = Date.now();
    const staleMs = this.engine?.config?.staleMs || 120_000;
    const summarizeTier = (users) => {
      let missing = 0;
      let stale = 0;
      let active = 0;
      let positions = 0;

      for (const u of users) {
        const ws = this.engine?._state?.get(u);
        if (!ws) {
          missing += 1;
          continue;
        }
        if (now - num(ws.lastUpdateMs, 0) > staleMs) {
          stale += 1;
        } else {
          active += 1;
        }
        for (const pos of ws.positions?.values?.() || []) {
          if (num(pos?.szi, 0) !== 0) positions += 1;
        }
      }

      return {
        total: users.length,
        active,
        stale,
        missing,
        positions,
      };
    };

    const watchSummary = summarizeTier(this.watchTopK);
    const coreSummary = summarizeTier(this.coreTopK);

    return {
      ts: now,
      product: this.sourceInfo?.meta?.product || null,
      mode: this.sourceInfo?.meta?.mode || "read_only",
      topK: this.watchTopK.length,
      watchTopK: this.watchTopK.length,
      coreTopK: this.coreTopK.length,
      active: watchSummary.active,
      stale: watchSummary.stale,
      missing: watchSummary.missing,
      positions: watchSummary.positions,
      core: coreSummary,
      watch: watchSummary,
      wsConnected: this.ws?.isConnected?.() === true,
      targetSymbols:
        Array.isArray(this.sourceInfo?.targetSymbols) && this.sourceInfo.targetSymbols.length
          ? [...this.sourceInfo.targetSymbols]
          : [...this.targetSymbols],
      alertPolicy: {
        scope: "core_only",
        relativeSizeThreshold: this.alertRelativeSizeThreshold,
        absoluteNotionalFloorUsd: this.alertAbsoluteSizeFloorUsd,
        leaderNormalSizeFloorPct: this.alertNormalSizeFloorPct,
        bootstrapSuppressed: true,
      },
      source: {
        file: this.sourceInfo?.file || null,
        type: this.sourceInfo?.type || null,
        name: this.sourceInfo?.name || null,
        generatedAt: this.sourceInfo?.generatedAt || null,
        symbol: this.sourceInfo?.symbol || null,
        targetSymbols: Array.isArray(this.sourceInfo?.targetSymbols)
          ? [...this.sourceInfo.targetSymbols]
          : [],
        meta: this.sourceInfo?.meta || {},
      },
    };
  }

  _logSummary() {
    const summary = this._buildSummary();
    this._lastSummary = summary;
    this.logger.log("[COPY_TRACKER] summary", summary);
    return summary;
  }

  getTrackerSummary() {
    if (this._lastSummary && Date.now() - this._lastSummary.ts < this.summaryIntervalMs * 2) {
      return this._lastSummary;
    }
    const summary = this._buildSummary();
    this._lastSummary = summary;
    return summary;
  }

  getTrackedLeaders({ symbol, kind = "watch" } = {}) {
    const coin =
      normalizeSymbol(symbol) ||
      this.sourceInfo?.symbol ||
      (Array.isArray(this.targetSymbols) ? this.targetSymbols[0] : null);
    const tier = kind === "core" ? "core" : "watch";
    const scopedTopK = coin
      ? this._filterTopKForSymbol(coin, tier)
      : [...this._getTierTopK(tier)];
    const baseWeights = tier === "core" ? this.coreWeights : this.watchWeights;
    const effectiveWeights = buildWeightMap(scopedTopK, baseWeights, this.overrides, {
      weightCapMin: this.weightCapMin,
      weightCapMax: this.weightCapMax,
    });
    const now = Date.now();
    const staleMs = this.engine?.config?.staleMs || 120_000;

    return scopedTopK.map((user, index) => {
      const wsState = this.engine?._state?.get(user);
      const lastUpdateMs = Number.isFinite(num(wsState?.lastUpdateMs, NaN))
        ? num(wsState?.lastUpdateMs, NaN)
        : null;
      const status =
        lastUpdateMs == null ? "missing" : now - lastUpdateMs > staleMs ? "stale" : "active";
      const tracked = coin ? this._trackedPositions.get(user)?.get(coin) : null;
      const meta = this.leaderMetadata.get(user) || {};

      return {
        wallet: user,
        tier: this.coreTopK.includes(user) ? "core" : "watch",
        rank: index + 1,
        symbol: coin || null,
        weight: num(effectiveWeights.get(user), 0),
        status,
        lastUpdateMs,
        lastUpdateAgeMs: lastUpdateMs == null ? null : Math.max(0, now - lastUpdateMs),
        positionDir: tracked ? (tracked.dir > 0 ? "long" : tracked.dir < 0 ? "short" : "flat") : "flat",
        positionSize: tracked?.szi ?? 0,
        positionNotional: tracked?.positionValue ?? 0,
        metadata: {
          score: num(meta.score, 0),
          rankValue: num(meta.rankValue, 0),
          investableScore: num(meta.investableScore, 0),
          trades: num(meta.trades, 0),
          winRateLB: num(meta.winRateLB, 0),
          pnlNet: num(meta.pnlNet, 0),
          expectancyUsd: meta.expectancyUsd == null ? null : num(meta.expectancyUsd, 0),
          persistenceScore: meta.persistenceScore == null ? null : num(meta.persistenceScore, 0),
          activityDays: num(meta.activityDays, 0),
          lastFillAgeDays: meta.lastFillAgeDays == null ? null : num(meta.lastFillAgeDays, 0),
          clusterId: meta.clusterId == null ? null : String(meta.clusterId),
          familyId: meta.familyId == null ? null : String(meta.familyId),
          symbol: normalizeSymbol(meta.symbol) || coin || null,
        },
      };
    });
  }

  _logTopkSnapshot({ ts, topK, weightMap, eliteSet, overrides, snapshotFile }) {
    if (!db || typeof db.logCopyTopKSnapshot !== "function") return;
    const ranked = Array.from(weightMap.entries())
      .map(([u, w]) => [normalizeUser(u), num(w, 0)])
      .filter(([u]) => u)
      .sort((a, b) => b[1] - a[1]);
    const topWallet = ranked[0]?.[0] || null;
    const topWalletWeight = ranked[0]?.[1] ?? null;
    const topWallets = ranked.slice(0, 10).map(([u, w]) => ({ user: u, weight: w }));
    const overridesPayload = {
      forceInclude: Array.from(overrides?.forceInclude || []),
      blocklist: Array.from(overrides?.blocklist || []),
      weightMultipliers: overrides?.weightMultipliers || {},
      perWallet: overrides?.perWallet || {},
    };

    db.logCopyTopKSnapshot({
      ts,
      topkCount: Array.isArray(topK) ? topK.length : 0,
      topWallet,
      topWalletWeight,
      topWalletsJson: JSON.stringify(topWallets),
      topkJson: JSON.stringify(topK || []),
      weightsJson: JSON.stringify(ranked),
      eliteJson: JSON.stringify(Array.from(eliteSet || [])),
      overridesJson: JSON.stringify(overridesPayload),
      snapshotFile,
    });
  }
}

let singleton = null;

function getCopyTradingConsensusProvider(options = {}) {
  if (singleton) return singleton;
  singleton = new CopyTradingConsensusProvider(options);
  singleton.start();
  return singleton;
}

module.exports = {
  CopyTradingConsensusProvider,
  getCopyTradingConsensusProvider,
};
