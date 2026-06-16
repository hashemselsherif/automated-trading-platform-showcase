/**
 * Drift Historical Data Fetcher
 * 
 * Fetches historical data from Drift's S3 API for backtesting:
 * - Funding rates (hourly)
 * - Trade records
 * - Candles
 * 
 * API Sources:
 * - V1: https://docs.drift.trade/historical-data/historical-data-v1
 * - V2: https://docs.drift.trade/historical-data/historical-data-v2
 */

const fs = require('fs');
const path = require('path');

// Drift V2 program ID
const DRIFT_V2_PROGRAM = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
const BASE_URL_V2 = `https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com/program/${DRIFT_V2_PROGRAM}`;

// Cache configuration - consistent with backtest cache settings
const BACKTEST_CACHE_DISABLED_RAW = String(process.env.BACKTEST_DISABLE_CACHE || '').toLowerCase();
const BACKTEST_CACHE_ENABLED = !['1', 'true', 'yes', 'on'].includes(BACKTEST_CACHE_DISABLED_RAW);
const DRIFT_FUNDING_CACHE_ENABLED = BACKTEST_CACHE_ENABLED && process.env.DRIFT_FUNDING_CACHE_DISABLED !== 'true';

// Cache directory - uses same base as Pyth historical data
const DEFAULT_CACHE_BASE = process.env.DRIFT_HIST_CACHE_DIR
  || process.env.BACKTEST_CACHE_DIR
  || path.join(process.cwd(), 'backtest-results', 'cache');
const CACHE_DIR = path.join(DEFAULT_CACHE_BASE, 'drift-funding');

// Cache TTL (optional - if set, cache files older than this will be refreshed)
const rawCacheTtlMs = Number(process.env.DRIFT_FUNDING_CACHE_TTL_MS || process.env.BACKTEST_CACHE_TTL_MS);
const CACHE_TTL_MS = Number.isFinite(rawCacheTtlMs) && rawCacheTtlMs > 0 ? rawCacheTtlMs : null;

// Performance knobs:
// - Cache cleanup can be expensive (directory scans). Default: off.
const DRIFT_FUNDING_CACHE_CLEANUP_ENABLED =
  String(process.env.DRIFT_FUNDING_CACHE_CLEANUP || '').toLowerCase() === 'true';
// - Store compact cache files (no pretty printing + minimal fields). Default: on.
const DRIFT_FUNDING_CACHE_COMPACT =
  String(process.env.DRIFT_FUNDING_CACHE_COMPACT || 'true').toLowerCase() !== 'false';

// Probing "latest available" can be very slow (hundreds of network requests). Default: off.
const DRIFT_FUNDING_PROBE_LATEST_ENABLED =
  String(process.env.DRIFT_FUNDING_PROBE_LATEST || '').toLowerCase() === 'true';

/**
 * Ensure cache directory exists
 */
function ensureCacheDir() {
  if (!DRIFT_FUNDING_CACHE_ENABLED) return;
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Check if cache file is stale (if TTL is configured)
 */
function isCacheStale(cachePath) {
  if (!CACHE_TTL_MS) return false;
  try {
    const stat = fs.statSync(cachePath);
    return Date.now() - stat.mtimeMs > CACHE_TTL_MS;
  } catch {
    return true;
  }
}

/**
 * Clean up overlapping/redundant cache files for a market
 * Keeps only the widest coverage cache to save disk space
 */
function cleanupOverlappingFundingCaches(market, primaryCachePath) {
  if (!DRIFT_FUNDING_CACHE_ENABLED) return;
  if (!DRIFT_FUNDING_CACHE_CLEANUP_ENABLED) return;
  
  try {
    ensureCacheDir();
    const prefix = `drift_funding_${market}_`;
    const entries = fs.readdirSync(CACHE_DIR);
    
    const cacheFiles = entries
      .filter(e => e.startsWith(prefix) && e.endsWith('.json'))
      .map(e => {
        const match = e.match(/_(\d{8})_(\d{8})\.json$/);
        if (!match) return null;
        const startBucket = parseInt(match[1], 10);
        const endBucket = parseInt(match[2], 10);
        return { path: path.join(CACHE_DIR, e), startBucket, endBucket, range: endBucket - startBucket };
      })
      .filter(Boolean);
    
    if (cacheFiles.length <= 1) return;
    
    // Sort by range (widest first)
    cacheFiles.sort((a, b) => b.range - a.range);
    const widest = cacheFiles[0];
    
    // Delete caches fully covered by the widest
    for (let i = 1; i < cacheFiles.length; i++) {
      const cache = cacheFiles[i];
      if (cache.startBucket >= widest.startBucket && cache.endBucket <= widest.endBucket) {
        try {
          if (cache.path !== primaryCachePath) fs.unlinkSync(cache.path);
        } catch {}
      }
    }
  } catch {}
}

function compactFundingRecord(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    ts: r.ts,
    marketIndex: r.marketIndex,
    fundingRate: r.fundingRate,
    fundingRateLong: r.fundingRateLong,
    fundingRateShort: r.fundingRateShort,
  };
}

function safeJsonParseFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw || !raw.trim()) return null;
  return JSON.parse(raw);
}

/**
 * Format date as YYYYMMDD for V2 API
 */
function formatDateV2(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Normalize market symbol for Drift API
 * Drift uses formats like "SOL-PERP", "BTC-PERP"
 */
function normalizeMarket(market) {
  let normalized = market.toUpperCase().trim();
  if (!normalized.endsWith('-PERP')) {
    normalized = `${normalized}-PERP`;
  }
  return normalized;
}

function fundingRateUrlForDate(normalizedMarket, dateObj) {
  const dateStr = formatDateV2(dateObj);
  const year = dateObj.getUTCFullYear();
  // Per Drift docs (Historical Data v2): market/{marketSymbol}/fundingRateRecords/{year}/{yyyymmdd}
  // https://docs.drift.trade/historical-data/historical-data-v2
  return `${BASE_URL_V2}/market/${normalizedMarket}/fundingRateRecords/${year}/${dateStr}`;
}

async function urlExists(url) {
  // Prefer a tiny GET over HEAD for maximum S3 compatibility.
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    return !!res.ok;
  } catch {
    return false;
  }
}

async function findLatestAvailableFundingDate(normalizedMarket, endDate, maxDaysBack = 400) {
  const end = new Date(endDate);
  for (let i = 0; i <= maxDaysBack; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const url = fundingRateUrlForDate(normalizedMarket, d);
    // eslint-disable-next-line no-await-in-loop
    const ok = await urlExists(url);
    if (ok) return d;
  }
  return null;
}

/**
 * Parse CSV text into array of objects
 * @param {string} csvText - CSV text with header row
 * @returns {Array} Array of objects
 */
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',');
  const records = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length !== headers.length) continue;
    
    const record = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j].trim();
      const value = values[j]?.trim();
      
      // Parse numeric values
      if (['ts', 'slot', 'recordId', 'marketIndex'].includes(key)) {
        record[key] = parseInt(value, 10);
      } else if (['fundingRate', 'fundingRateLong', 'fundingRateShort', 
                  'cumulativeFundingRateLong', 'cumulativeFundingRateShort',
                  'oraclePriceTwap', 'markPriceTwap', 'periodRevenue',
                  'baseAssetAmountWithAmm', 'baseAssetAmountWithUnsettledLp'].includes(key)) {
        record[key] = parseFloat(value);
      } else {
        record[key] = value;
      }
    }
    records.push(record);
  }
  
  return records;
}

/**
 * Fetch funding rates for a specific date
 * @param {string} market - Market symbol (e.g., 'SOL-PERP')
 * @param {Date|string} date - Date to fetch
 * @param {Object} options - Options { verbose: false }
 * @returns {Promise<Array>} Funding rate records
 */
async function fetchFundingRatesForDate(market, date, options = {}) {
  const { verbose = false } = options;
  const normalizedMarket = normalizeMarket(market);
  const dateObj = new Date(date);
  const dateStr = formatDateV2(dateObj);
  
  // Check if date is in the future
  const now = new Date();
  if (dateObj > now) {
    if (verbose) {
      console.warn(`[DRIFT FUNDING] ⚠️  Date ${dateStr} is in the future for ${normalizedMarket}, skipping`);
    }
    return [];
  }
  
  const url = fundingRateUrlForDate(normalizedMarket, dateObj);
  
  try {
    if (verbose) {
      console.log(`[DRIFT FUNDING] Fetching ${normalizedMarket} ${dateStr}...`);
    }
    
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 404) {
        // No data for this date (weekend, holiday, or market not active)
        if (verbose) {
          console.log(`[DRIFT FUNDING]   404 for ${normalizedMarket} on ${dateStr} (no data available)`);
        }
        return [];
      }
      
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${response.statusText}${errorText ? ` - ${errorText.substring(0, 100)}` : ''}`);
    }
    
    const text = await response.text();
    if (!text.trim()) {
      if (verbose) {
        console.log(`[DRIFT FUNDING]   Empty response for ${normalizedMarket} on ${dateStr}`);
      }
      return [];
    }
    
    // Parse CSV format
    const records = parseCSV(text);
    
    if (verbose && records.length > 0) {
      console.log(`[DRIFT FUNDING]   ✓ Got ${records.length} records for ${normalizedMarket} on ${dateStr}`);
    } else if (verbose && records.length === 0) {
      console.log(`[DRIFT FUNDING]   ⚠️  Parsed 0 records from response for ${normalizedMarket} on ${dateStr}`);
    }
    
    return records;
  } catch (error) {
    // Don't silently swallow network errors - log them
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('404') || errorMsg.includes('Not Found')) {
      if (verbose) {
        console.log(`[DRIFT FUNDING]   404 for ${normalizedMarket} on ${dateStr} (not found)`);
      }
      return [];
    }
    
    // Log other errors with more detail
    console.error(`[DRIFT FUNDING] ❌ Error fetching ${normalizedMarket} on ${dateStr}: ${errorMsg}`);
    if (verbose) {
      console.error(`[DRIFT FUNDING]   URL: ${url}`);
    }
    return [];
  }
}

/**
 * Generate cache filename for a market and date range
 */
function getCacheFilename(market, startDate, endDate) {
  return `drift_funding_${market}_${formatDateV2(startDate)}_${formatDateV2(endDate)}.json`;
}

// Backwards-compat: older cache format without "drift_funding_" prefix.
function getLegacyCacheFilename(market, startDate, endDate) {
  return `${market}_${formatDateV2(startDate)}_${formatDateV2(endDate)}.json`;
}

/**
 * Find the best existing cache file for a market that overlaps with requested range
 * PRIORITIZES superset caches (caches that fully contain the requested range)
 * Returns { path, data, startDate, endDate } or null if no suitable cache exists
 */
function findExistingCache(market, requestedStart, requestedEnd) {
  ensureCacheDir();
  
  const prefixes = [`drift_funding_${market}_`, `${market}_`];
  const reqStartTs = new Date(requestedStart).getTime();
  const reqEndTs = new Date(requestedEnd).getTime();
  
  let supersetCache = null; // Cache that fully contains requested range (preferred)
  let bestPartialCache = null; // Best partial overlap cache (fallback)
  let bestCoverage = 0;
  let bestPath = null;
  let bestStart = null;
  let bestEnd = null;
  
  try {
    const entries = fs.readdirSync(CACHE_DIR);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      if (!prefixes.some((p) => entry.startsWith(p))) continue;
      
      // Parse dates from filename: drift_funding_SOL-PERP_20240101_20240131.json
      const match = entry.match(/_(\d{8})_(\d{8})\.json$/);
      if (!match) continue;
      
      const cacheStart = new Date(`${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}`);
      const cacheEnd = new Date(`${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}`);
      const cacheStartTs = cacheStart.getTime();
      const cacheEndTs = cacheEnd.getTime();
      
      // Check if this cache is a SUPERSET (fully contains requested range)
      const isSuperset = cacheStartTs <= reqStartTs && cacheEndTs >= reqEndTs;
      
      if (isSuperset) {
        // Prefer the smallest superset (most efficient)
        if (!supersetCache || (cacheEndTs - cacheStartTs) < (supersetCache.endDate.getTime() - supersetCache.startDate.getTime())) {
          supersetCache = { path: path.join(CACHE_DIR, entry), startDate: cacheStart, endDate: cacheEnd };
        }
      } else {
        // Check for partial overlap (fallback)
        const overlapStart = Math.max(reqStartTs, cacheStartTs);
        const overlapEnd = Math.min(reqEndTs, cacheEndTs);
        const coverage = Math.max(0, overlapEnd - overlapStart);
        
        if (coverage > bestCoverage) {
          bestCoverage = coverage;
          bestPath = path.join(CACHE_DIR, entry);
          bestStart = cacheStart;
          bestEnd = cacheEnd;
        }
      }
    }
  } catch (e) {
    // Cache dir doesn't exist or read error
  }
  
  // Prefer superset cache if available
  const cacheToUse = supersetCache || (bestPath ? { path: bestPath, startDate: bestStart, endDate: bestEnd } : null);
  
  // Parse only ONE cache file. Parsing many large JSON files is slow.
  if (cacheToUse) {
    try {
      const data = safeJsonParseFile(cacheToUse.path);
      if (Array.isArray(data)) {
        return { path: cacheToUse.path, data, startDate: cacheToUse.startDate, endDate: cacheToUse.endDate, isSuperset: !!supersetCache };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Fetch funding rates for a date range with incremental caching
 * @param {string} market - Market symbol
 * @param {Date|string} startDate - Start date
 * @param {Date|string} endDate - End date
 * @param {Object} options - Options { useCache: true, verbose: false }
 * @returns {Promise<Array>} All funding rate records
 */
async function fetchFundingRates(market, startDate, endDate, options = {}) {
  const {
    useCache = true,
    verbose = false,
    // When true, do NOT silently fall back to estimated funding; require real Drift records.
    requireHistorical = false,
    // Minimum ok-day coverage (0-1) if requireHistorical is true.
    minDayCoverage = 0.9,
    // How far back to probe for "latest available" when missing (diagnostics)
    probeMaxDaysBack = 400,
  } = options;
  const normalizedMarket = normalizeMarket(market);
  
  // Respect global cache disable setting
  const effectiveUseCache = useCache && DRIFT_FUNDING_CACHE_ENABLED;
  
  if (effectiveUseCache) {
    ensureCacheDir();
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  // Check for exact cache match first
  const exactCacheKey = getCacheFilename(normalizedMarket, start, end);
  const exactCachePath = path.join(CACHE_DIR, exactCacheKey);
  const legacyExactCacheKey = getLegacyCacheFilename(normalizedMarket, start, end);
  const legacyExactCachePath = path.join(CACHE_DIR, legacyExactCacheKey);
  
  if (effectiveUseCache && fs.existsSync(exactCachePath) && !isCacheStale(exactCachePath)) {
    try {
      const cached = safeJsonParseFile(exactCachePath);
      if (verbose) console.log(`[DRIFT FUNDING] ✓ Cache hit: ${cached.length} records for ${normalizedMarket}`);
      return cached;
    } catch (e) {
      // Cache corrupted, refetch
      if (verbose) console.log(`[DRIFT FUNDING] Cache corrupted for ${normalizedMarket}, refetching...`);
    }
  }

  // Backwards-compat: try legacy exact cache filename too
  if (effectiveUseCache && fs.existsSync(legacyExactCachePath) && !isCacheStale(legacyExactCachePath)) {
    try {
      const cached = safeJsonParseFile(legacyExactCachePath);
      if (verbose) console.log(`[DRIFT FUNDING] ✓ Cache hit (legacy): ${cached.length} records for ${normalizedMarket}`);
      return cached;
    } catch (e) {
      if (verbose) console.log(`[DRIFT FUNDING] Legacy cache corrupted for ${normalizedMarket}, refetching...`);
    }
  }
  
  // Check for partial cache to extend (or superset cache for fast-path)
  const existingCache = effectiveUseCache ? findExistingCache(normalizedMarket, start, end) : null;
  let cachedRecords = [];
  let fetchStart = start;
  let fetchEnd = end;
  
  if (existingCache && existingCache.data.length > 0) {
    cachedRecords = existingCache.data;
    const cacheStartTs = existingCache.startDate.getTime();
    const cacheEndTs = existingCache.endDate.getTime();
    const reqStartTs = start.getTime();
    const reqEndTs = end.getTime();
    
    // FAST-PATH: If cache is a superset (fully contains requested range), return immediately
    // This prevents any network requests for shorter lookbacks when a longer cache exists
    if (existingCache.isSuperset || (cacheStartTs <= reqStartTs && cacheEndTs >= reqEndTs)) {
      if (verbose) {
        const cacheDays = Math.round((cacheEndTs - cacheStartTs) / (24 * 60 * 60 * 1000));
        const reqDays = Math.round((reqEndTs - reqStartTs) / (24 * 60 * 60 * 1000));
        console.log(`[DRIFT FUNDING] ✓ Superset cache hit: ${cachedRecords.length} records (${cacheDays}d cache covers ${reqDays}d request) for ${normalizedMarket}`);
      }
      return cachedRecords.filter(r => {
        const ts = r.ts * 1000;
        return ts >= reqStartTs && ts <= reqEndTs + 86400000;
      });
    }
    
    if (verbose) {
      console.log(`[DRIFT FUNDING] ◐ Partial cache for ${normalizedMarket} (${formatDateV2(existingCache.startDate)}-${formatDateV2(existingCache.endDate)}), extending...`);
    }
    
    // Will need to merge with fetched data
    fetchStart = cacheEndTs >= reqEndTs ? start : new Date(Math.min(reqStartTs, cacheStartTs));
    fetchEnd = cacheStartTs <= reqStartTs ? end : new Date(Math.max(reqEndTs, cacheEndTs));
  }
  
  // Check if dates are in the future
  const now = new Date();
  if (fetchStart > now) {
    if (verbose) {
      console.warn(`[DRIFT FUNDING] ⚠️  Start date ${formatDateV2(fetchStart)} is in the future for ${normalizedMarket}`);
    }
    return [];
  }
  
  // Clamp end date to today if it's in the future
  const effectiveEnd = fetchEnd > now ? now : fetchEnd;
  if (fetchEnd > now && verbose) {
    console.warn(`[DRIFT FUNDING] ⚠️  End date ${formatDateV2(fetchEnd)} is in the future, clamping to ${formatDateV2(effectiveEnd)}`);
  }
  
  if (verbose) console.log(`[DRIFT FUNDING] ⬇ Fetching ${normalizedMarket} from ${formatDateV2(fetchStart)} to ${formatDateV2(effectiveEnd)}...`);

  // Fast existence probe to avoid scanning 365+ daily keys for markets/ranges with no data.
  // This is critical for performance in repeated workflows.
  // - If requireHistorical=false: return [] quickly (caller will fall back to estimate).
  // - If requireHistorical=true: throw quickly (with guidance).
  if ((!cachedRecords || cachedRecords.length === 0) && fetchStart <= effectiveEnd) {
    const probeDates = [
      new Date(fetchStart),
      new Date(effectiveEnd),
      new Date((fetchStart.getTime() + effectiveEnd.getTime()) / 2),
    ];
    try {
      const probeOk = [];
      for (const d of probeDates) {
        // eslint-disable-next-line no-await-in-loop
        probeOk.push(await urlExists(fundingRateUrlForDate(normalizedMarket, d)));
      }
      const anyOk = probeOk.some(Boolean);
      if (!anyOk) {
        const msg = `[DRIFT FUNDING] No v2 funding files found for ${normalizedMarket} in ${formatDateV2(fetchStart)}-${formatDateV2(effectiveEnd)} (probe)`;
        if (requireHistorical) {
          throw new Error(`${msg}. If you want the backtest to proceed, set DRIFT_FUNDING_ALLOW_ESTIMATE=true.`);
        }
        if (verbose) console.warn(`${msg}. Returning 0 records (will fall back to estimated funding if enabled).`);
        return [];
      }
    } catch (e) {
      // If probe itself fails (network), continue to the slower path so we can surface actual errors.
      if (verbose) console.warn(`[DRIFT FUNDING] Probe failed for ${normalizedMarket}: ${e.message || e}`);
    }
  }
  
  const allRecords = [];
  const current = new Date(fetchStart);
  let fetchCount = 0;
  let newRecords = 0;
  let okDays = 0;
  let missingDays = 0;
  const missingDates = [];
  let errorCount = 0;
  const errors = [];
  
  // Speed: avoid scanning the entire cachedRecords array for every day.
  // We just need to know whether the cache contains ANY record for the day.
  let cachedDays = null;
  if (cachedRecords && cachedRecords.length) {
    cachedDays = new Set();
    for (const r of cachedRecords) {
      if (!r || !Number.isFinite(r.ts)) continue;
      cachedDays.add(formatDateV2(new Date(r.ts * 1000)));
    }
  }

  while (current <= effectiveEnd) {
    const dateStr = formatDateV2(current);
    
    // Skip future dates
    if (current > now) {
      if (verbose) {
        console.log(`[DRIFT FUNDING]   Skipping future date ${dateStr}`);
      }
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }
    
    // Check if we already have this day in cache (fast set membership).
    if (cachedDays && cachedDays.has(dateStr)) {
      // We'll add cachedRecords once at the end (dedupe will handle overlaps).
    } else {
      try {
        // We intentionally fetch here (instead of calling fetchFundingRatesForDate) so we can
        // track per-day coverage for strict historical mode.
        const url = fundingRateUrlForDate(normalizedMarket, current);
        const response = await fetch(url);
        if (!response.ok) {
          if (response.status === 404) {
            missingDays++;
            missingDates.push(dateStr);
            if (verbose) {
              console.log(`[DRIFT FUNDING]   404 for ${normalizedMarket} on ${dateStr} (missing key)`);
            }
            fetchCount++;
          } else {
            const errorText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${response.statusText}${errorText ? ` - ${errorText.substring(0, 120)}` : ''}`);
          }
        } else {
          okDays++;
          const text = await response.text();
          const records = text && text.trim() ? parseCSV(text) : [];
          allRecords.push(...records);
          newRecords += records.length;
          fetchCount++;
        }
        
        // Rate limiting - be nice to Drift's S3
        if (fetchCount % 10 === 0) {
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (err) {
        errorCount++;
        const errMsg = err.message || String(err);
        errors.push(`${dateStr}: ${errMsg}`);
        if (verbose) {
          console.error(`[DRIFT FUNDING]   Error fetching ${dateStr}: ${errMsg}`);
        }
      }
    }
    
    current.setUTCDate(current.getUTCDate() + 1);
  }

  // Add cached records once (instead of per-day). Deduplication happens below anyway.
  if (cachedRecords && cachedRecords.length) {
    allRecords.push(...cachedRecords);
  }
  
  // Report errors if any occurred
  if (errorCount > 0 && verbose) {
    console.warn(`[DRIFT FUNDING] ⚠️  ${errorCount} date(s) failed to fetch for ${normalizedMarket}`);
    if (errors.length <= 5) {
      errors.forEach(e => console.warn(`[DRIFT FUNDING]   - ${e}`));
    } else {
      errors.slice(0, 3).forEach(e => console.warn(`[DRIFT FUNDING]   - ${e}`));
      console.warn(`[DRIFT FUNDING]   ... and ${errors.length - 3} more errors`);
    }
  }
  
  // Sort by timestamp and dedupe
  allRecords.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const uniqueRecords = [];
  const seen = new Set();
  for (const r of allRecords) {
    if (!seen.has(r.ts)) {
      seen.add(r.ts);
      uniqueRecords.push(r);
    }
  }
  
  // Filter to requested range
  const filteredRecords = uniqueRecords.filter(r => {
    const ts = r.ts * 1000;
    return ts >= start.getTime() && ts <= end.getTime() + 86400000;
  });

  // Strict mode: require real historical coverage (no estimated fallback).
  const requestedDays = Math.max(1, Math.floor((effectiveEnd.getTime() - fetchStart.getTime()) / 86400000) + 1);
  const dayCoverage = requestedDays > 0 ? (okDays / requestedDays) : 0;
  if (requireHistorical) {
    if (filteredRecords.length === 0 || dayCoverage < minDayCoverage) {
      const latestStr = DRIFT_FUNDING_PROBE_LATEST_ENABLED
        ? (() => { /* computed below */ })()
        : 'disabled (set DRIFT_FUNDING_PROBE_LATEST=true)';
      let latestComputed = null;
      if (DRIFT_FUNDING_PROBE_LATEST_ENABLED) {
        latestComputed = await findLatestAvailableFundingDate(normalizedMarket, effectiveEnd, probeMaxDaysBack);
      }
      const latestOut = latestComputed ? formatDateV2(latestComputed) : latestStr;
      const missingSample = missingDates.slice(0, 8).join(', ');
      throw new Error(
        `[DRIFT FUNDING] Historical funding missing for ${normalizedMarket}: ` +
        `requested ${formatDateV2(start)}-${formatDateV2(end)}. ` +
        `Coverage ${(dayCoverage * 100).toFixed(1)}% (okDays=${okDays}/${requestedDays}), missingDays=${missingDays}` +
        `${missingSample ? ` (e.g. ${missingSample}${missingDates.length > 8 ? ', ...' : ''})` : ''}. ` +
        `Latest available in v2 bucket: ${latestOut}. ` +
        `See Drift v2 docs: https://docs.drift.trade/historical-data/historical-data-v2`
      );
    }
  }
  
  // Cache the complete fetched range for future use
  if (effectiveUseCache && uniqueRecords.length > 0 && newRecords > 0) {
    try {
      ensureCacheDir();
      
      // Save with the full range we now have
      const fullStart = new Date(Math.min(start.getTime(), existingCache?.startDate?.getTime() || start.getTime()));
      const fullEnd = new Date(Math.max(end.getTime(), existingCache?.endDate?.getTime() || end.getTime()));
      const fullCacheKey = getCacheFilename(normalizedMarket, fullStart, fullEnd);
      const fullCachePath = path.join(CACHE_DIR, fullCacheKey);
      
      const toWrite = DRIFT_FUNDING_CACHE_COMPACT
        ? uniqueRecords.map(compactFundingRecord).filter(Boolean)
        : uniqueRecords;
      fs.writeFileSync(fullCachePath, JSON.stringify(toWrite));
      if (verbose) console.log(`[DRIFT FUNDING] ✓ Cached ${uniqueRecords.length} records (${newRecords} new) for ${normalizedMarket}`);
      
      // Also save the exact requested range for quick lookups
      if (exactCachePath !== fullCachePath) {
        const toWriteExact = DRIFT_FUNDING_CACHE_COMPACT
          ? filteredRecords.map(compactFundingRecord).filter(Boolean)
          : filteredRecords;
        fs.writeFileSync(exactCachePath, JSON.stringify(toWriteExact));
      }
      
      // Clean up overlapping cache files to save disk space
      cleanupOverlappingFundingCaches(normalizedMarket, fullCachePath);
    } catch (e) {
      if (verbose) console.warn(`[DRIFT FUNDING] Failed to cache: ${e.message}`);
    }
  }
  
  if (verbose) {
    const cacheStatus = effectiveUseCache ? (newRecords > 0 ? 'fetched' : 'from cache') : 'cache disabled';
    const statusIcon = filteredRecords.length > 0 ? '✓' : '⚠️';
    console.log(`[DRIFT FUNDING] ${statusIcon} Got ${filteredRecords.length} records for ${normalizedMarket} (${cacheStatus})`);
    
    if (filteredRecords.length === 0) {
      if (fetchCount > 0) {
        console.warn(`[DRIFT FUNDING] ⚠️  No records returned for ${normalizedMarket} despite fetching ${fetchCount} date(s)`);
      } else {
        console.warn(`[DRIFT FUNDING] ⚠️  No records returned for ${normalizedMarket} (no dates fetched)`);
      }
      console.warn(`[DRIFT FUNDING]    Date range: ${formatDateV2(start)} to ${formatDateV2(end)}`);
      console.warn(`[DRIFT FUNDING]    Possible reasons:`);
      if (start > now || end > now) {
        console.warn(`[DRIFT FUNDING]    - ⚠️  Dates are in the future (no data available yet)`);
      }
      console.warn(`[DRIFT FUNDING]    - Market ${normalizedMarket} may not have funding rate data for this period`);
      console.warn(`[DRIFT FUNDING]    - Data may not be available yet (Drift updates with delay)`);
      console.warn(`[DRIFT FUNDING]    - API endpoint: ${BASE_URL_V2}/market/${normalizedMarket}/fundingRateRecords/`);
      console.warn(`[DRIFT FUNDING]    → Falling back to estimated average funding rate`);
    }
    if (fetchCount > 0) {
      const requestedDays = Math.max(1, Math.floor((effectiveEnd.getTime() - fetchStart.getTime()) / 86400000) + 1);
      const dayCoverage = requestedDays > 0 ? (okDays / requestedDays) : 0;
      console.log(`[DRIFT FUNDING] Coverage: ${(dayCoverage * 100).toFixed(1)}% (okDays=${okDays}/${requestedDays}, missingDays=${missingDays})`);
    }
  }
  
  return filteredRecords;
}

/**
 * Convert funding rate records to a lookup map by timestamp
 * @param {Array} records - Funding rate records from API
 * @returns {Map} Map of timestamp -> funding rate info
 */
function buildFundingRateMap(records) {
  const map = new Map();
  
  for (const record of records) {
    // Drift funding rate records (CSV format):
    // - ts: timestamp in seconds
    // - fundingRate: raw value (needs /100 to get percentage, /10000 for decimal)
    //   e.g., 0.0137 raw → 0.000137 decimal → 0.0137% per hour
    // - fundingRateLong: rate for longs
    // - fundingRateShort: rate for shorts
    // - oraclePriceTwap: TWAP oracle price in USD
    // - markPriceTwap: Mark price TWAP
    
    const ts = record.ts * 1000; // Convert to milliseconds
    
    // Raw API value needs /100 to get percentage
    // 0.0137 raw → 0.0137% = 0.000137 as decimal
    // Positive = longs pay shorts, Negative = shorts pay longs
    const rawRate = record.fundingRate || 0;
    const fundingRate = rawRate / 100; // Convert to decimal (0.0137 → 0.000137)
    const fundingRateLong = (record.fundingRateLong || rawRate) / 100;
    const fundingRateShort = (record.fundingRateShort || rawRate) / 100;
    
    map.set(ts, {
      ts,
      fundingRate,           // As decimal (multiply by 100 for %)
      fundingRateLong,
      fundingRateShort,
      fundingRatePct: rawRate, // Original % value for display
      oraclePriceTwap: record.oraclePriceTwap || null,
      markPriceTwap: record.markPriceTwap || null,
      raw: record,
    });
  }
  
  return map;
}

/**
 * Calculate funding payment for a position
 * @param {Object} position - Position { side, sizeUsd, entryPrice, quantity }
 * @param {number} fundingRate - Funding rate for this period
 * @param {string} side - 'long' or 'short'
 * @returns {number} Funding payment (negative = you pay, positive = you receive)
 */
function calculateFundingPayment(position, fundingRate, side = null) {
  const positionSide = side || position.side;
  const notional = position.sizeUsd || (position.quantity * position.entryPrice);
  
  if (!Number.isFinite(notional) || notional <= 0) return 0;
  if (!Number.isFinite(fundingRate)) return 0;
  
  // Funding payment = notional * funding rate
  // Positive funding rate: longs pay shorts
  // Negative funding rate: shorts pay longs
  
  if (positionSide === 'long') {
    // Longs pay when rate is positive, receive when negative
    return -notional * fundingRate;
  } else {
    // Shorts receive when rate is positive, pay when negative
    return notional * fundingRate;
  }
}

/**
 * Find the nearest funding rate for a given timestamp
 * @param {Map} fundingRateMap - Map from buildFundingRateMap
 * @param {number} ts - Timestamp in milliseconds
 * @param {number} maxDelta - Max time difference in ms (default 1 hour)
 * @returns {Object|null} Funding rate info or null
 */
function getNearestFundingRate(fundingRateMap, ts, maxDelta = 3600000) {
  // Funding rates are typically hourly
  // Round to nearest hour
  const hourTs = Math.floor(ts / 3600000) * 3600000;
  
  // Try exact match first
  if (fundingRateMap.has(hourTs)) {
    return fundingRateMap.get(hourTs);
  }
  
  // Try +/- 1 hour
  for (const delta of [3600000, -3600000, 7200000, -7200000]) {
    const checkTs = hourTs + delta;
    if (fundingRateMap.has(checkTs)) {
      return fundingRateMap.get(checkTs);
    }
  }
  
  // Find nearest within maxDelta
  let nearest = null;
  let minDiff = maxDelta;
  
  for (const [rateTs, rate] of fundingRateMap) {
    const diff = Math.abs(rateTs - ts);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = rate;
    }
  }
  
  return nearest;
}

/**
 * Calculate cumulative funding for a position held over a period
 * @param {Map} fundingRateMap - Funding rate map
 * @param {string} side - 'long' or 'short'
 * @param {number} notional - Position notional value
 * @param {number} openTs - Position open timestamp (ms)
 * @param {number} closeTs - Position close timestamp (ms)
 * @returns {Object} { totalFunding, payments: [] }
 */
function calculateCumulativeFunding(fundingRateMap, side, notional, openTs, closeTs) {
  if (!Number.isFinite(notional) || notional <= 0) {
    return { totalFunding: 0, payments: [] };
  }
  
  const payments = [];
  let totalFunding = 0;
  
  // Get all funding rates in the period
  const sortedRates = Array.from(fundingRateMap.values())
    .filter(r => r.ts >= openTs && r.ts <= closeTs)
    .sort((a, b) => a.ts - b.ts);
  
  for (const rate of sortedRates) {
    const payment = calculateFundingPayment({ sizeUsd: notional }, rate.fundingRate, side);
    totalFunding += payment;
    payments.push({
      ts: rate.ts,
      rate: rate.fundingRate,
      payment,
    });
  }
  
  return { totalFunding, payments };
}

/**
 * Estimate average funding rate from historical data
 * @param {Array} records - Funding rate records (raw from API)
 * @returns {Object} { avgRate, avgRateAnnualized, positiveCount, negativeCount }
 */
function estimateAverageFundingRate(records) {
  if (!records || records.length === 0) {
    return { avgRate: 0, avgRateAnnualized: 0, avgRatePctPerHour: 0, positiveCount: 0, negativeCount: 0 };
  }
  
  let sum = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  
  for (const record of records) {
    // Raw rate needs /100 to get percentage (0.0137 raw → 0.0137%)
    const rawRate = record.fundingRate || 0;
    sum += rawRate;
    if (rawRate > 0) positiveCount++;
    else if (rawRate < 0) negativeCount++;
  }
  
  const avgRawRate = sum / records.length;
  // Raw rate of 0.0137 = 0.0137% per hour = 0.000137 decimal
  const avgRatePctPerHour = avgRawRate; // Already in % (0.0137 = 0.0137%)
  const avgRateDecimal = avgRawRate / 100; // As decimal for calculations
  const avgRateAnnualized = avgRatePctPerHour * 24 * 365; // % per year
  
  return {
    avgRate: avgRateDecimal,       // Decimal for calculations
    avgRatePctPerHour,             // % per hour for display (e.g., 0.0137%)
    avgRateAnnualized,             // % per year (e.g., 120%)
    positiveCount,
    negativeCount,
    totalRecords: records.length,
  };
}

/**
 * Prefetch funding rates for multiple markets
 * @param {Array<string>} markets - Market symbols
 * @param {Date|string} startDate - Start date
 * @param {Date|string} endDate - End date
 * @param {Object} options - Options
 * @returns {Promise<Map>} Map of market -> fundingRateMap
 */
async function prefetchFundingRatesMultiMarket(markets, startDate, endDate, options = {}) {
  const { verbose = false, parallel = 3 } = options;
  
  const result = new Map();
  let totalRecords = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  
  if (verbose) {
    console.log(`[DRIFT FUNDING] Prefetching ${markets.length} markets (cache: ${DRIFT_FUNDING_CACHE_ENABLED ? 'enabled' : 'disabled'})`);
  }
  
  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < markets.length; i += parallel) {
    const batch = markets.slice(i, i + parallel);
    
    const promises = batch.map(async (market) => {
      const normalizedMarket = normalizeMarket(market);
      
      // Check for cache (exact match or superset)
      let wasInCache = false;
      if (DRIFT_FUNDING_CACHE_ENABLED) {
        const exactCacheKey = getCacheFilename(normalizedMarket, new Date(startDate), new Date(endDate));
        const exactCachePath = path.join(CACHE_DIR, exactCacheKey);
        const exactExists = fs.existsSync(exactCachePath) && !isCacheStale(exactCachePath);
        
        // Also check for superset cache (e.g., 360d cache covering a 7d request)
        const supersetCache = findExistingCache(normalizedMarket, startDate, endDate);
        wasInCache = exactExists || (supersetCache && supersetCache.isSuperset);
      }

      // If historical funding is enabled, default to strict mode (no estimates) unless explicitly allowed.
      const requireHistorical =
        options.requireHistorical ??
        (String(process.env.DRIFT_FUNDING_ALLOW_ESTIMATE || '').toLowerCase() === 'true' ? false : true);

      const records = await fetchFundingRates(market, startDate, endDate, { ...options, verbose: false, requireHistorical });
      const map = buildFundingRateMap(records);
      return { market: normalizedMarket, map, records, wasInCache };
    });
    
    const results = await Promise.all(promises);
    
    for (const { market, map, records, wasInCache } of results) {
      result.set(market, { map, records });
      totalRecords += records.length;
      if (wasInCache) cacheHits++;
      else cacheMisses++;
      
      if (verbose && records.length > 0) {
        const stats = estimateAverageFundingRate(records);
        const cacheIcon = wasInCache ? '✓' : '⬇';
        console.log(`   ${cacheIcon} ${market}: ${records.length} records, avg: ${(stats.avgRate * 100).toFixed(4)}%/hr (${stats.avgRateAnnualized.toFixed(1)}% APR)`);
      }
    }
    
    // Small delay between batches
    if (i + parallel < markets.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  if (verbose) {
    console.log(`[DRIFT FUNDING] Total: ${totalRecords} records | Cache: ${cacheHits}/${markets.length} hits, ${cacheMisses} fetched`);
  }
  
  return result;
}

/**
 * Clear funding rate cache for a specific market or all markets
 * @param {string|null} market - Market to clear (null = all markets)
 */
function clearFundingCache(market = null) {
  try {
    ensureCacheDir();
    const entries = fs.readdirSync(CACHE_DIR);
    
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      // Support both naming schemes:
      // - drift_funding_<MARKET>_YYYYMMDD_YYYYMMDD.json
      // - <MARKET>_YYYYMMDD_YYYYMMDD.json
      if (!(entry.startsWith('drift_funding_') || entry.includes('-PERP_'))) continue;
      if (market) {
        const normalizedMarket = normalizeMarket(market);
        if (!entry.includes(normalizedMarket)) continue;
      }
      
      try {
        fs.unlinkSync(path.join(CACHE_DIR, entry));
      } catch {}
    }
  } catch {}
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  try {
    ensureCacheDir();
    const entries = fs.readdirSync(CACHE_DIR);
    const cacheFiles = entries.filter(e => e.endsWith('.json') && (e.startsWith('drift_funding_') || e.includes('-PERP_')));
    
    let totalSize = 0;
    let oldestFile = Date.now();
    let newestFile = 0;
    
    for (const entry of cacheFiles) {
      try {
        const stat = fs.statSync(path.join(CACHE_DIR, entry));
        totalSize += stat.size;
        oldestFile = Math.min(oldestFile, stat.mtimeMs);
        newestFile = Math.max(newestFile, stat.mtimeMs);
      } catch {}
    }
    
    return {
      enabled: DRIFT_FUNDING_CACHE_ENABLED,
      directory: CACHE_DIR,
      fileCount: cacheFiles.length,
      totalSizeBytes: totalSize,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
      oldestFile: cacheFiles.length > 0 ? new Date(oldestFile).toISOString() : null,
      newestFile: cacheFiles.length > 0 ? new Date(newestFile).toISOString() : null,
      ttlMs: CACHE_TTL_MS,
      cleanupEnabled: DRIFT_FUNDING_CACHE_CLEANUP_ENABLED,
      compactCache: DRIFT_FUNDING_CACHE_COMPACT,
    };
  } catch {
    return { enabled: DRIFT_FUNDING_CACHE_ENABLED, fileCount: 0 };
  }
}

module.exports = {
  // Fetching
  fetchFundingRatesForDate,
  fetchFundingRates,
  prefetchFundingRatesMultiMarket,
  
  // Processing
  buildFundingRateMap,
  getNearestFundingRate,
  calculateFundingPayment,
  calculateCumulativeFunding,
  estimateAverageFundingRate,
  
  // Cache management
  clearFundingCache,
  getCacheStats,
  
  // Helpers
  normalizeMarket,
  formatDateV2,
  
  // Constants & Config
  DRIFT_V2_PROGRAM,
  BASE_URL_V2,
  CACHE_DIR,
  DRIFT_FUNDING_CACHE_ENABLED,
};

