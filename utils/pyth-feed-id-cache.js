/**
 * Daily Pyth Feed ID Resolver (deterministic per UTC day)
 *
 * Goal:
 * - Ensure we always subscribe to the correct Pyth instrument for each market
 *   (e.g., Crypto.SUI/USD, NOT staked/derivative/redemption-rate feeds).
 * - Make the mapping deterministic per day by caching to results/json/.
 * - Source: Hermes price feed metadata (same source as WS feed IDs).
 *
 * This is intentionally lightweight and dependency-free (uses https + fs).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

function utcDayString(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

function canonicalBase(baseSymbol) {
  const b = String(baseSymbol || '').toUpperCase();
  if (b.startsWith('1M') && b.length > 2) return b.slice(2);
  if (b.startsWith('1K') && b.length > 2) return b.slice(2);
  return b;
}

let hermesFeedCache = null;
let hermesFeedCacheAt = 0;

async function fetchHermesFeedList() {
  const now = Date.now();
  if (hermesFeedCache && now - hermesFeedCacheAt < 10 * 60 * 1000) {
    return hermesFeedCache;
  }

  const url = 'https://hermes.pyth.network/v2/price_feeds';
  const r = await httpsGet(url);
  if (r.status !== 200) return null;

  let list;
  try {
    list = JSON.parse(r.body);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;

  hermesFeedCache = list;
  hermesFeedCacheAt = now;
  return list;
}

async function resolveUsdSpotFeedIdForBase(base) {
  const b = canonicalBase(base);
  if (!b) return null;

  const list = await fetchHermesFeedList();
  if (!Array.isArray(list)) return null;
  const wanted = `Crypto.${b}/USD`;
  const match = list.find((x) => x?.attributes?.symbol === wanted);
  const id = match?.id || null;
  return isHex64(id) ? id : null;
}

/**
 * Resolve feed IDs for a set of markets, cache per UTC day.
 *
 * @param {string[]} markets - Market symbols, e.g. ['SOL-PERP','SUI-PERP']
 * @param {object} opts
 * @param {string} opts.cacheDir - defaults to results/json
 * @param {boolean} opts.forceRefresh - ignore cache
 * @returns {Promise<object>} mapping { [marketOrAlias]: feedId }
 */
async function getDailyPythFeedIdsForMarkets(markets, opts = {}) {
  const cacheDir = opts.cacheDir || path.join(process.cwd(), 'results', 'json');
  const day = utcDayString();
  const cachePath = path.join(cacheDir, `pyth-feed-ids-${day}.json`);

  if (!opts.forceRefresh && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached?.day === day && cached?.feedIds && typeof cached.feedIds === 'object') {
        return cached.feedIds;
      }
    } catch (_) {
      // fall through to rebuild
    }
  }

  // Load Drift registry for baseSymbol lookups (this is deterministic repo config)
  let driftLookup = null;
  try {
    driftLookup = require('./drift-market-lookup');
  } catch (_) {}

  const baseByMarket = new Map();
  const uniqueBases = new Set();

  for (const m of markets || []) {
    const market = String(m);
    const info = driftLookup?.getMarketInfo ? driftLookup.getMarketInfo(market) : null;
    const base = info?.baseSymbol || market.replace(/-PERP$/, '');
    baseByMarket.set(market, base);
    uniqueBases.add(canonicalBase(base));
  }

  // Resolve per base (sequential to be gentle)
  const baseToFeedId = {};
  for (const base of uniqueBases) {
    if (!base) continue;
    baseToFeedId[base] = await resolveUsdSpotFeedIdForBase(base);
  }

  // Build mapping with aliases
  const feedIds = {};
  for (const [market, baseRaw] of baseByMarket.entries()) {
    const base = canonicalBase(baseRaw);
    const id = baseToFeedId[base];
    if (!id) continue;
    feedIds[market] = id;
    feedIds[base] = id;
    feedIds[`${base}/USD`] = id;
  }

  ensureDir(cacheDir);
  const payload = {
    day,
    generatedAt: new Date().toISOString(),
    markets: markets || [],
    source: 'hermes.pyth.network',
    feedIds,
    baseToFeedId,
  };
  try {
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2) + '\n');
  } catch (_) {}

  return feedIds;
}

module.exports = {
  getDailyPythFeedIdsForMarkets,
  resolveUsdSpotFeedIdForBase,
  canonicalBase,
  utcDayString,
};
