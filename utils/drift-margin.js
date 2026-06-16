/**
 * Drift per-market margin parameters + IMF adjustment helpers.
 *
 * Margin table source (updated hourly from on-chain PerpMarketAccount):
 * https://docs.drift.trade/trading/margin
 *
 * We generate `config/drift-margin-params.json` via:
 *   node scripts/analysis/generate-drift-margin-params.js
 *
 * Notes on IMF:
 * Drift's docs state IMF affects leverage at higher notional sizes.
 * The exact on-chain IMF math is non-trivial; here we use a conservative approximation:
 *   effectiveRatio = baseRatio + imfFactor * sqrt(notionalUsd)
 * and clamp to >= baseRatio.
 *
 * If you want to disable IMF adjustment (baseline), set DRIFT_ENABLE_IMF=false.
 */

const path = require('path');

function normalizePerpMarket(market) {
  if (!market) return null;
  const m = String(market).toUpperCase().trim();
  if (m.endsWith('-PERP')) return m;
  return `${m}-PERP`;
}

let _cache = null;
function loadParams() {
  if (_cache) return _cache;
  try {
    // Resolve from repo root at runtime
    // eslint-disable-next-line global-require
    _cache = require(path.join(process.cwd(), 'config', 'drift-margin-params.json'));
    return _cache;
  } catch {
    _cache = { markets: {} };
    return _cache;
  }
}

function getPerpMarginParams(market) {
  const m = normalizePerpMarket(market);
  const data = loadParams();
  const params = data?.markets?.[m];
  return params || null;
}

function computeImfAdjustedRatio(baseRatio, imfFactor, notionalUsd) {
  const enableImf = String(process.env.DRIFT_ENABLE_IMF || 'true').toLowerCase() !== 'false';
  const base = Number(baseRatio);
  if (!enableImf) return Number.isFinite(base) ? base : 0;

  const imf = Number(imfFactor);
  const n = Number(notionalUsd);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(imf) || imf <= 0) return base;
  if (!Number.isFinite(n) || n <= 0) return base;

  // Approximation: scale margin ratio up with sqrt(notional)
  const adj = imf * Math.sqrt(n);
  const out = base + adj;
  // Clamp to [base, 1]
  return Math.min(1, Math.max(base, out));
}

function getEffectiveMarginRatios(market, notionalUsd) {
  const p = getPerpMarginParams(market);
  const initialBase = p?.initialMarginRatio ?? null;
  const maintBase = p?.maintenanceMarginRatio ?? null;
  const imf = p?.imfFactor ?? 0;

  const initialRatio = initialBase != null ? computeImfAdjustedRatio(initialBase, imf, notionalUsd) : null;
  const maintenanceRatio = maintBase != null ? computeImfAdjustedRatio(maintBase, imf, notionalUsd) : null;

  return {
    market: normalizePerpMarket(market),
    marketIndex: p?.marketIndex ?? null,
    imfFactor: imf,
    initialMarginRatio: initialRatio,
    maintenanceMarginRatio: maintenanceRatio,
    source: p ? 'docs_table' : 'missing',
  };
}

module.exports = {
  normalizePerpMarket,
  getPerpMarginParams,
  computeImfAdjustedRatio,
  getEffectiveMarginRatios,
};


