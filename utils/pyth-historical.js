/**
 * Pyth Historical Data Fetcher
 * High-quality oracle data from Pyth Network
 * Secure, reliable, designed for DeFi - no API key required
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PYTH_BENCHMARKS_API = 'https://benchmarks.pyth.network/v1/shims/tradingview';
const DEFAULT_CACHE_DIR = process.env.PYTH_HIST_CACHE_DIR
  || process.env.BACKTEST_CACHE_DIR
  || path.join(process.cwd(), 'backtest-results', 'cache');

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function intervalToMs(resolutionMinutes) {
  const m = Number(resolutionMinutes);
  const minutes = Number.isFinite(m) && m > 0 ? m : 5;
  return minutes * 60_000;
}

function normalizePythSymbol(symbol) {
  const upper = String(symbol || '').toUpperCase().replace(/-PERP$/, '');
  if (upper.startsWith('1M') && upper.length > 2) return upper.slice(2);
  if (upper.startsWith('1K') && upper.length > 2) return upper.slice(2);
  return upper;
}

function alignToCandleOpenMs(t, intervalMs) {
  return Math.floor(Number(t) / intervalMs) * intervalMs;
}

function alignToCandleCloseMs(t, intervalMs) {
  const open = alignToCandleOpenMs(t, intervalMs);
  return open + intervalMs - 1;
}

function stableStringify(value) {
  const seen = new WeakSet();
  const stringify = (val) => {
    if (val === null || typeof val !== 'object') return JSON.stringify(val);
    if (seen.has(val)) return '"[Circular]"';
    seen.add(val);
    if (Array.isArray(val)) return `[${val.map(stringify).join(',')}]`;
    const keys = Object.keys(val).sort();
    return `{${keys.map(k => JSON.stringify(k) + ':' + stringify(val[k])).join(',')}}`;
  };
  return stringify(value);
}

function cacheName({ symbol, resolution, startBucket, endBucket }) {
  const sym = String(symbol || '').toUpperCase();
  const res = String(resolution || '5');
  return `pythhist_${sym}_${res}m_${startBucket}_${endBucket}.json`;
}

function parseCandlesFromTradingView(data) {
  if (!data || data.s !== 'ok' || !Array.isArray(data.t) || !Array.isArray(data.c)) return [];
  const { t, o, h, l, c, v } = data;
  const candles = [];
  for (let i = 0; i < t.length; i++) {
    const ts = Number(t[i]) * 1000;
    const open = Number(o?.[i]);
    const high = Number(h?.[i]);
    const low = Number(l?.[i]);
    const close = Number(c?.[i]);
    const vol = Number(v?.[i] || 0);
    if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) continue;
    candles.push({ ts, open, high, low, close, volume: vol });
  }
  return candles.sort((a, b) => a.ts - b.ts);
}

class PythHistoricalFetcher {
  constructor() {
    this.rateLimit = 1000; // 1 second between calls (conservative)
    this.lastCall = 0;
    this.cacheDir = DEFAULT_CACHE_DIR;
    this.disablePartialCache = false;
  }

  async _respectRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastCall;
    if (elapsed < this.rateLimit) {
      await new Promise(r => setTimeout(r, this.rateLimit - elapsed));
    }
    this.lastCall = Date.now();
  }

  /**
   * Fetch historical OHLCV data from Pyth Network
   * @param {string} symbol - Token symbol (SOL, BTC, ETH)
   * @param {number} barsNeeded - Number of bars to fetch (default 100)
   * @param {string} resolution - Timeframe in minutes (default '5' for 5min)
   * @param {number} [endTimeMs] - Optional end time (ms since epoch). Defaults to now.
   * @returns {Promise<Array>} Array of candles with {ts, open, high, low, close, volume}
   */
  async fetchHistoricalData(symbol, barsNeeded = 100, resolution = '5', endTimeMs) {
    try {
      await this._respectRateLimit();

      // Calculate time range
      const endMs = Number.isFinite(endTimeMs) ? endTimeMs : Date.now();
      const now = Math.floor(endMs / 1000);
      const minutesPerBar = parseInt(resolution, 10);
      const secondsPerBar = minutesPerBar * 60;
      const from = now - (barsNeeded * secondsPerBar);

      // Align to candle boundaries so cache keys are stable across runs.
      const intervalMs = intervalToMs(minutesPerBar);
      const startAlignedMs = alignToCandleOpenMs(from * 1000, intervalMs);
      const endAlignedMs = alignToCandleCloseMs(endMs, intervalMs);
      const startBucket = Math.floor(startAlignedMs / intervalMs);
      const endBucket = Math.floor(endAlignedMs / intervalMs);

      const url = `${PYTH_BENCHMARKS_API}/history`;
      const requestSymbol = normalizePythSymbol(symbol);
      const params = {
        symbol: `Crypto.${requestSymbol}/USD`,
        resolution: resolution, // '5' for 5min, '15' for 15min, etc
        from: Math.floor(startAlignedMs / 1000),
        to: Math.floor(endAlignedMs / 1000),
      };

      // ----------------------------
      // Cache (incremental)
      // ----------------------------
      ensureDir(this.cacheDir);
      const sym = String(symbol || '').toUpperCase();
      const prefix = `pythhist_${sym}_${String(resolution)}m_`;
      const primaryPath = path.join(this.cacheDir, cacheName({ symbol: sym, resolution, startBucket, endBucket }));

      let bestPartial = null;
      let bestPartialPath = null;
      if (this.disablePartialCache) {
        try {
          if (fs.existsSync(primaryPath)) {
            const raw = fs.readFileSync(primaryPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed?.candles)) {
              const filtered = parsed.candles.filter(c => Number(c.ts) >= startAlignedMs && Number(c.ts) <= endAlignedMs);
              if (filtered.length > 0) {
                console.log(`[PYTH-HIST][CACHE] Using cached ${filtered.length} candles for ${sym} @ ${resolution}m [${path.basename(primaryPath)}]`);
                return filtered.sort((a, b) => a.ts - b.ts);
              }
            }
          }
        } catch (_) {
          // ignore cache read issues
        }
      } else {
        try {
          const entries = fs.readdirSync(this.cacheDir);
          for (const entry of entries) {
            if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
            const full = path.join(this.cacheDir, entry);
            const raw = fs.readFileSync(full, 'utf8');
            const parsed = JSON.parse(raw);
            const meta = parsed?.meta || {};
            if (!Array.isArray(parsed?.candles)) continue;

            const metaStartBucket = meta.startBucket ?? (meta.startTimeMs ? Math.floor(Number(meta.startTimeMs) / intervalMs) : null);
            const metaEndBucket = meta.endBucket ?? (meta.endTimeMs ? Math.floor(Number(meta.endTimeMs) / intervalMs) : null);
            if (!Number.isFinite(metaStartBucket) || !Number.isFinite(metaEndBucket)) continue;

            // must cover start
            if (metaStartBucket > startBucket) continue;

            // full coverage?
            if (metaEndBucket >= endBucket) {
              const filtered = parsed.candles.filter(c => Number(c.ts) >= startAlignedMs && Number(c.ts) <= endAlignedMs);
              if (filtered.length > 0) {
                console.log(`[PYTH-HIST][CACHE] Using cached ${filtered.length} candles for ${sym} @ ${resolution}m [${entry}]`);
                return filtered.sort((a, b) => a.ts - b.ts);
              }
              continue;
            }

            // partial: track the one with the furthest end
            if (!bestPartial || metaEndBucket > (bestPartial.meta?.endBucket ?? -Infinity)) {
              bestPartial = parsed;
              bestPartialPath = full;
            }
          }
        } catch (_) {
          // ignore cache read issues
        }
      }

      // incremental update if partial exists
      if (bestPartial && bestPartialPath) {
        const meta = bestPartial.meta || {};
        const cachedEndMs = Number(meta.endTimeMs);
        if (Number.isFinite(cachedEndMs) && cachedEndMs < endAlignedMs) {
          const gapFrom = Math.floor((cachedEndMs + 1) / 1000);
          const gapTo = Math.floor(endAlignedMs / 1000);
          console.log(`[PYTH-HIST][CACHE] Partial hit - updating ${path.basename(bestPartialPath)} (${sym} @ ${resolution}m)`);
          const gapResp = await axios.get(url, { params: { ...params, from: gapFrom, to: gapTo }, timeout: 15000 });
          const gapCandles = parseCandlesFromTradingView(gapResp.data);
          const merged = [...(bestPartial.candles || []), ...gapCandles]
            .filter(c => Number.isFinite(c.ts))
            .sort((a, b) => a.ts - b.ts);
          // dedupe by ts
          const uniq = [];
          const seen = new Set();
          for (let i = merged.length - 1; i >= 0; i--) {
            const ts = merged[i].ts;
            if (seen.has(ts)) continue;
            seen.add(ts);
            uniq.unshift(merged[i]);
          }

          const actualStartMs = uniq.length ? uniq[0].ts : startAlignedMs;
          const actualEndMs = uniq.length ? uniq[uniq.length - 1].ts : endAlignedMs;
          const payload = {
            meta: {
              symbol: sym,
              resolutionMinutes: Number(minutesPerBar),
              startTimeMs: actualStartMs,
              endTimeMs: actualEndMs,
              startBucket: Math.floor(actualStartMs / intervalMs),
              endBucket: Math.floor(actualEndMs / intervalMs),
              intervalMs,
              updatedAt: Date.now(),
              source: 'pyth_tradingview',
              count: uniq.length,
            },
            candles: uniq,
          };
          fs.writeFileSync(primaryPath, stableStringify(payload));
          if (bestPartialPath !== primaryPath && fs.existsSync(bestPartialPath)) {
            try { fs.unlinkSync(bestPartialPath); } catch (_) {}
          }
          const filtered = uniq.filter(c => c.ts >= startAlignedMs && c.ts <= endAlignedMs);
          console.log(`[PYTH-HIST][CACHE] Updated ${path.basename(primaryPath)} (${filtered.length} candles)`);
          return filtered.sort((a, b) => a.ts - b.ts);
        }
      }

      console.log(`📡 Fetching ${barsNeeded} bars of ${resolution}min data for ${sym} from Pyth...`);

      const response = await axios.get(url, {
        params,
        timeout: 15000,
      });

      // Pyth TradingView format: s='ok', t=timestamps, o/h/l/c=OHLC, v=volume
      if (response.data?.s === 'ok' && response.data?.t && response.data?.c) {
        const validCandles = parseCandlesFromTradingView(response.data)
          .filter(c => c.ts >= startAlignedMs && c.ts <= endAlignedMs);

        // Write cache
        try {
          const payload = {
            meta: {
              symbol: sym,
              resolutionMinutes: Number(minutesPerBar),
              startTimeMs: startAlignedMs,
              endTimeMs: endAlignedMs,
              startBucket,
              endBucket,
              intervalMs,
              createdAt: Date.now(),
              source: 'pyth_tradingview',
              count: validCandles.length,
            },
            candles: validCandles,
          };
          fs.writeFileSync(primaryPath, stableStringify(payload));
          console.log(`[PYTH-HIST][CACHE] Saved ${validCandles.length} candles to ${path.basename(primaryPath)}`);
        } catch (_) {}

        console.log(`✅ Fetched ${validCandles.length} valid candles for ${sym} from Pyth`);
        return validCandles;
      } else if (response.data?.s === 'no_data') {
        console.warn(`⚠️  Pyth returned no data for ${symbol} (symbol may not have history at this resolution)`);
        return [];
      } else if (response.data?.s === 'error') {
        const msg = response.data?.errmsg || response.data?.message || response.data?.error || 'error';
        console.warn(`⚠️  Pyth returned error for ${symbol}: ${msg}`);
        return [];
      } else {
        console.warn(`⚠️  Pyth returned unexpected response for ${symbol}:`, response.data?.s || 'unknown status');
        return [];
      }
    } catch (error) {
      if (error.response?.status === 429) {
        console.warn(`⚠️  Pyth rate limited for ${symbol} - backing off`);
      } else if (error.response?.status === 404) {
        console.warn(`⚠️  Pyth historical data not available for ${symbol}`);
      } else {
        console.warn(`⚠️  Pyth failed for ${symbol}: ${error.message}`);
      }
      return [];
    }
  }
}

module.exports = { PythHistoricalFetcher };
