"use strict";

const fs = require("fs");
const path = require("path");

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWalletAddress(value) {
  if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  if (value && typeof value === "object") {
    return normalizeWalletAddress(
      value.address || value.wallet?.address || value.wallet || value.user
    );
  }
  return null;
}

function normalizeStringList(values, { upper = false, lower = false } = {}) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string" || !value.trim()) continue;
    let normalized = value.trim();
    if (upper) normalized = normalized.toUpperCase();
    if (lower) normalized = normalized.toLowerCase();
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function extractWalletsFromAnalysisData(raw, { walletSource = "ranked", walletLimit = 150 } = {}) {
  const addWallets = (target, rows) => {
    for (const value of Array.isArray(rows) ? rows : []) {
      const normalized = normalizeWalletAddress(value);
      if (normalized && !target.includes(normalized)) target.push(normalized);
    }
  };

  const limit = Math.max(0, num(walletLimit, 150));
  const source = String(walletSource || "ranked")
    .trim()
    .toLowerCase();
  const wallets = [];

  const collections = {
    ranked: raw?.ranked,
    eligible: raw?.eligible,
    elite: raw?.elite,
    eliteeligible: raw?.eliteEligible,
    walletuniverse: raw?.walletUniverse,
    universe: raw?.walletUniverse,
  };

  if (source === "all") {
    addWallets(wallets, raw?.eliteEligible);
    addWallets(wallets, raw?.elite);
    addWallets(wallets, raw?.eligible);
    addWallets(wallets, raw?.ranked);
    addWallets(wallets, raw?.walletUniverse);
  } else {
    addWallets(wallets, collections[source]);
  }

  if (!wallets.length && source === "ranked") {
    addWallets(wallets, raw?.eligible);
    addWallets(wallets, raw?.elite);
    addWallets(wallets, raw?.walletUniverse);
  }

  return limit > 0 ? wallets.slice(0, limit) : wallets;
}

function extractWalletsFromAnalysisFile(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return extractWalletsFromAnalysisData(raw, options);
}

function normalizeCohortRole(value) {
  return String(value || "research")
    .trim()
    .toLowerCase() === "live"
    ? "live"
    : "research";
}

function emptyCohortManifest() {
  return {
    version: 1,
    activeResearchCohort: null,
    activeLiveCohort: null,
    cohorts: {},
  };
}

function normalizeCohortEntry(name, raw = {}) {
  const walletSet = normalizeStringList(raw.wallets, { lower: true });
  return {
    name,
    role: normalizeCohortRole(raw.role),
    description: raw.description == null ? null : String(raw.description),
    thesis: raw.thesis == null ? null : String(raw.thesis),
    cycleId: raw.cycleId == null ? null : String(raw.cycleId),
    notes: raw.notes == null ? null : String(raw.notes),
    wallets: walletSet,
    symbols: normalizeStringList(raw.symbols, { upper: true }),
    confluenceSymbols: normalizeStringList(raw.confluenceSymbols, { upper: true }),
    sides: normalizeStringList(raw.sides, { lower: true }),
    eventTypes: normalizeStringList(raw.eventTypes, { lower: true }),
    regimeBuckets: normalizeStringList(raw.regimeBuckets, { lower: true }),
    source: raw.source && typeof raw.source === "object" ? raw.source : null,
    createdAt: raw.createdAt || null,
    refreshedAt: raw.refreshedAt || null,
  };
}

function normalizeCohortManifest(raw) {
  const base = emptyCohortManifest();
  const manifest = raw && typeof raw === "object" ? raw : {};
  const entries = manifest.cohorts && typeof manifest.cohorts === "object" ? manifest.cohorts : {};
  const cohorts = {};
  for (const [name, value] of Object.entries(entries)) {
    if (typeof name !== "string" || !name.trim()) continue;
    cohorts[name] = normalizeCohortEntry(name, value);
  }

  const activeResearchCohort =
    typeof manifest.activeResearchCohort === "string" &&
    Object.prototype.hasOwnProperty.call(cohorts, manifest.activeResearchCohort)
      ? manifest.activeResearchCohort
      : null;
  const activeLiveCohort =
    typeof manifest.activeLiveCohort === "string" &&
    Object.prototype.hasOwnProperty.call(cohorts, manifest.activeLiveCohort)
      ? manifest.activeLiveCohort
      : null;

  return {
    ...base,
    version: Math.max(1, Math.floor(num(manifest.version, 1))),
    activeResearchCohort,
    activeLiveCohort,
    cohorts,
  };
}

function resolveCohortManifestPath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function loadCohortManifest(filePath, { allowMissing = true } = {}) {
  const resolved = resolveCohortManifestPath(filePath);
  if (!resolved || !fs.existsSync(resolved)) {
    if (allowMissing) return null;
    throw new Error(`Missing cohort manifest: ${resolved || String(filePath)}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return normalizeCohortManifest(raw);
}

function resolveCohort(manifest, { cohortName = null, cohortRole = "research" } = {}) {
  const normalized = normalizeCohortManifest(manifest);
  const role = normalizeCohortRole(cohortRole);
  const names = Object.keys(normalized.cohorts);
  if (!names.length) return null;

  let resolvedName = null;
  let selectionSource = null;
  if (typeof cohortName === "string" && cohortName.trim()) {
    resolvedName = cohortName.trim();
    selectionSource = "explicit";
  } else if (role === "live" && normalized.activeLiveCohort) {
    resolvedName = normalized.activeLiveCohort;
    selectionSource = "active_live";
  } else if (role === "research" && normalized.activeResearchCohort) {
    resolvedName = normalized.activeResearchCohort;
    selectionSource = "active_research";
  } else if (names.length === 1) {
    resolvedName = names[0];
    selectionSource = "sole_manifest_entry";
  }

  if (!resolvedName) return null;
  const cohort = normalized.cohorts[resolvedName];
  if (!cohort) {
    throw new Error(`Cohort '${resolvedName}' not found in manifest.`);
  }
  return {
    ...cohort,
    selectionSource,
  };
}

function upsertCohortManifest(
  manifest,
  {
    cohortName,
    cohortRole = "research",
    wallets = [],
    description = null,
    thesis = null,
    cycleId = null,
    notes = null,
    symbols = [],
    confluenceSymbols = [],
    sides = [],
    eventTypes = [],
    regimeBuckets = [],
    source = null,
    activate = true,
    refreshedAt = new Date().toISOString(),
  } = {}
) {
  const name = typeof cohortName === "string" ? cohortName.trim() : "";
  if (!name) throw new Error("cohortName is required");

  const normalized = normalizeCohortManifest(manifest);
  const existing = normalized.cohorts[name] || null;
  const role = normalizeCohortRole(cohortRole);

  normalized.cohorts[name] = normalizeCohortEntry(name, {
    ...existing,
    role,
    description: description ?? existing?.description ?? null,
    thesis: thesis ?? existing?.thesis ?? null,
    cycleId: cycleId ?? existing?.cycleId ?? null,
    notes: notes ?? existing?.notes ?? null,
    wallets,
    symbols,
    confluenceSymbols,
    sides,
    eventTypes,
    regimeBuckets,
    source: source ?? existing?.source ?? null,
    createdAt: existing?.createdAt || refreshedAt,
    refreshedAt,
  });

  if (activate) {
    if (role === "live") normalized.activeLiveCohort = name;
    else normalized.activeResearchCohort = name;
  }

  return normalized;
}

function writeCohortManifest(filePath, manifest) {
  const resolved = resolveCohortManifestPath(filePath);
  if (!resolved) throw new Error("cohort manifest file path is required");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(normalizeCohortManifest(manifest), null, 2));
  return resolved;
}

module.exports = {
  normalizeWalletAddress,
  normalizeCohortRole,
  extractWalletsFromAnalysisData,
  extractWalletsFromAnalysisFile,
  emptyCohortManifest,
  normalizeCohortManifest,
  loadCohortManifest,
  resolveCohortManifestPath,
  resolveCohort,
  upsertCohortManifest,
  writeCohortManifest,
};
