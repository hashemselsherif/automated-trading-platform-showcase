#!/usr/bin/env node

/**
 * RSI Mean-Reversion Strategy Backtest
 *
 * This backtest script is specifically designed for the RSI Mean-Reversion strategy.
 * It uses the same fee structure and analysis as the main backtest.js but implements
 * RSI-specific entry/exit logic.
 *
 * Entry Logic:
 * - Long: RSI drops to oversold extreme (20), then recovers above recovery level (25)
 * - Short: RSI rises to overbought extreme (80), then drops below recovery level (75)
 *
 * Exit Logic:
 * - RSI Target: Exit when RSI reaches neutral (50)
 * - Partial Exit: Take 50% when RSI reaches 35 (long) or 65 (short)
 * - Failure Exit: Cut losses when RSI drops back to 22 (long) or rises to 78 (short)
 * - Time Stop: Exit after max bars held (20)
 * - Hard Stop: Emergency ATR-based stop (2.0x ATR)
 *
 * Usage:
 *   node scripts/backtest/backtest-rsi-reversion.js [options]
 *
 * Memory Optimization:
 *   For long backtests (e.g., 360 days with walk-forward analysis), increase Node.js heap size:
 *   node --max-old-space-size=8192 scripts/backtest/backtest-rsi-reversion.js --days=360
 *   Or with expose-gc for manual garbage collection:
 *   node --max-old-space-size=8192 --expose-gc scripts/backtest/backtest-rsi-reversion.js --days=360
 *
 * Options:
 *   --days=N             Number of days to backtest (default: 30)
 *   --symbol=SYMBOL      Trading symbol (default: SOL)
 *   --positionSize=N     Position size in USD (default: 1000)
 *   --debug              Enable debug logging
 *   --verbose            Enable verbose logging
 *   --rsiPeriod=N        RSI period (default: 14)
 *   --oversoldExtreme=N  RSI oversold extreme level (default: 20)
 *   --oversoldRecovery=N RSI oversold recovery level (default: 25)
 *   --overboughtExtreme=N RSI overbought extreme level (default: 80)
 *   --overboughtRecovery=N RSI overbought recovery level (default: 75)
 *   --targetNeutral=N    RSI target for full exit (default: 50)
 *   --timeStopBars=N     Max bars to hold position (default: 20)
 */

// Load strategy-specific env file FIRST with override to ensure RSI config takes precedence
// Path must be absolute for dotenv to find it reliably
const envPath = require("path");
const envFile = process.env.ENV_FILE || envPath.join(__dirname, "..", "..", ".env.rsi-reversion");
require("dotenv").config({ path: envFile, override: true });
if (require.main === module) console.log(`[ENV] Loaded from ${envFile}`);

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// NOTE: env already loaded above via ENV_FILE (respects .env.rsi-reversion-alts for alt strategy)

// Import the RSI Mean-Reversion Strategy
const RsiMeanReversionStrategy = require("../../src/strategies/enhanced-momentum-rsi-strategy");

// Import shared utilities from main backtest
const db = require("../../db");
const RiskManager = require("../../risk-manager");
const MarketAllocator = require("../../utils/market-allocator");
const {
  mean,
  std,
  computeTailMetrics,
  computeSampleConfidence,
  clamp,
} = require("../../utils/scoring-stats");

// Import memory optimization utilities
const {
  createTypedCandleArray,
  isTypedCandleArray,
  getMemoryUsage,
  formatMemory,
  tryGC,
  estimateMemoryRequirements,
} = require("./lib");

// ============================================================
// BOT RUNTIME EVENT MODEL (SOURCE-OF-TRUTH PARITY)
// ============================================================
// This is the sequencing implemented in bot.js (tick loop), simplified:
// 1) Every LOOP_MS tick:
//    - Add tick to BarAggregator (may return completedBar)
//    - Add tick to TickBuffer (rolling window, currentWindow)
//    - For each strategy instance:
//        a) If completedBar: strategy.update({ close/high/low/volume, ts: completedBar.timestamp })
//        b) If currentWindow and strategy.prices.length>0: strategy.recalculateLastBar({ close/high/low/volume })
//        c) If updateTick exists: strategy.updateTick({ price, volume, ts })
//    - Evaluate signal: strategy.getSignal(price, positions, ...)
//    - Allocator ranks/selects; opens are executed immediately at current tick price
//    - Exits: evaluated each tick with explicit precedence; close at tickPrice
//
// Reference: /Users/hashemelsherif/jupiter-perps-bot/bot.js around tick processing (barAggregator/tickBuffer/update/recalculateLastBar/getSignal/shouldClose).
const BOT_RUNTIME_EVENT_MODEL = [
  {
    step: 1,
    name: "tick_ingest",
    notes: "Fetch price, add to bar aggregator + rolling window buffer",
  },
  {
    step: 2,
    name: "bar_close_update",
    notes: "If a discrete 5m bar completes, call strategy.update() with completed bar OHLCV",
  },
  {
    step: 3,
    name: "intra_bar_recalc",
    notes:
      "Update last bar with rolling window OHLCV via recalculateLastBar(); RSI may change intra-bar",
  },
  { step: 4, name: "tick_update", notes: "Call strategy.updateTick() if implemented" },
  {
    step: 5,
    name: "signal_eval",
    notes: "Call strategy.getSignal(currentPrice, positions) each tick",
  },
  {
    step: 6,
    name: "allocator_select",
    notes: "Rank/select opportunities; execute opens at current tick price",
  },
  {
    step: 7,
    name: "exit_eval",
    notes:
      "Evaluate exits each tick; execute at tick price. Precedence: hard_stop (price) > time/guard exits > RSI exits (target/partial/failure)",
  },
];

// Explicit exit precedence used by the bot loop (highest priority first).
// Note: within RSI exits, strategy decides partial vs full close based on its own rules.
const BOT_RUNTIME_EXIT_PRECEDENCE = [
  "rsi_hard_stop", // price-based stop (per tick)
  "time_stop", // max bars held / time guards (if enabled)
  "rsi_target_reached",
  "rsi_partial_exit",
  "rsi_failure_exit",
];

function printBotRuntimeEventModel() {
  console.log("\n🧭 BOT RUNTIME EVENT MODEL (for parity)");
  console.log("-".repeat(60));
  for (const s of BOT_RUNTIME_EVENT_MODEL) {
    console.log(`  ${String(s.step).padStart(2)}. ${s.name} — ${s.notes}`);
  }
  console.log("\n🧷 EXIT PRECEDENCE (highest priority first)");
  console.log("-".repeat(60));
  for (const r of BOT_RUNTIME_EXIT_PRECEDENCE) console.log(`  - ${r}`);
}

// ============================================================
// CACHE CONFIGURATION (same as backtest.js)
// ============================================================
const BACKTEST_CACHE_DISABLED = String(process.env.BACKTEST_DISABLE_CACHE || "").toLowerCase();
const BACKTEST_CACHE_ENABLED = !["1", "true", "yes", "on"].includes(BACKTEST_CACHE_DISABLED);
const BACKTEST_CACHE_DIR =
  process.env.BACKTEST_CACHE_DIR || path.join(process.cwd(), "backtest-results", "cache");
const rawCacheTtlMs = Number(process.env.BACKTEST_CACHE_TTL_MS);
const BACKTEST_CACHE_TTL_MS =
  Number.isFinite(rawCacheTtlMs) && rawCacheTtlMs > 0 ? rawCacheTtlMs : null;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Clean up redundant/overlapping cache files to save disk space.
 * Keeps only the cache with the widest coverage for each symbol+interval+source.
 *
 * @param {string} cachePrefix - e.g. "pyth_SUI_1m_"
 * @param {string} primaryCachePath - The newly created/updated cache file to keep
 * @param {number} intervalMs - Interval in milliseconds for tolerance calculations
 */
/**
 * Parse bucket range from filename without reading the file.
 * Filename pattern: <prefix>_<startBucket>_<endBucket>.json
 * Returns { startBucket, endBucket } or null if parsing fails.
 */
function parseBucketRangeFromFilename(filename) {
  const m = filename.match(/_(\d+)_(\d+)\.json$/);
  if (m) {
    const startBucket = Number(m[1]);
    const endBucket = Number(m[2]);
    if (Number.isFinite(startBucket) && Number.isFinite(endBucket)) {
      return { startBucket, endBucket };
    }
  }
  return null;
}

function cleanupOverlappingCaches(cachePrefix, primaryCachePath, intervalMs) {
  try {
    if (!BACKTEST_CACHE_ENABLED) return;

    ensureDir(BACKTEST_CACHE_DIR);
    const entries = fs.readdirSync(BACKTEST_CACHE_DIR);

    // Find all cache files with the same prefix
    const samePrefixFiles = entries
      .filter((entry) => entry.startsWith(cachePrefix) && entry.endsWith(".json"))
      .map((entry) => path.join(BACKTEST_CACHE_DIR, entry))
      .filter((fullPath) => fs.existsSync(fullPath));

    if (samePrefixFiles.length <= 1) {
      return; // Only one cache file, nothing to clean up
    }

    // MEMORY FIX: Parse bucket range from FILENAME only (no file reads!)
    const cacheInfos = [];
    for (const cachePath of samePrefixFiles) {
      const base = path.basename(cachePath);
      const parsed = parseBucketRangeFromFilename(base);
      if (parsed) {
        cacheInfos.push({
          path: cachePath,
          startBucket: parsed.startBucket,
          endBucket: parsed.endBucket,
          range: parsed.endBucket - parsed.startBucket,
        });
      }
    }

    if (cacheInfos.length <= 1) return;

    // Sort by range (descending) - widest coverage first
    cacheInfos.sort((a, b) => b.range - a.range);

    // Keep the widest cache
    const widestCache = cacheInfos[0];
    const filesToDelete = [];

    // Check all other caches to see if they're fully covered by the widest
    for (let i = 1; i < cacheInfos.length; i++) {
      const cache = cacheInfos[i];

      // Check if this cache is fully covered by the widest cache
      const isCoveredByWidest =
        cache.startBucket >= widestCache.startBucket && cache.endBucket <= widestCache.endBucket;

      if (isCoveredByWidest) {
        filesToDelete.push(cache.path);
      }
    }

    // Delete redundant caches (batch log instead of per-file)
    if (filesToDelete.length > 0) {
      let deletedCount = 0;
      let freedSpace = 0;

      for (const cachePath of filesToDelete) {
        try {
          const stats = fs.statSync(cachePath);
          fs.unlinkSync(cachePath);
          deletedCount++;
          freedSpace += stats.size;
        } catch (err) {
          // Silently continue on individual file errors
        }
      }

      if (deletedCount > 0) {
        const freedMB = (freedSpace / 1024 / 1024).toFixed(1);
        console.log(
          `[CACHE-CLEANUP] Removed ${deletedCount} overlapping caches, freed ${freedMB} MB. Kept: ${path.basename(widestCache.path)} (${widestCache.range} buckets)`
        );
      }
    }
  } catch (err) {
    console.warn(`[CACHE-CLEANUP] Cleanup failed: ${err.message}`);
  }
}

function stableStringify(value) {
  const seen = new WeakSet();
  const stringify = (val) => {
    if (val === null || val === undefined) return JSON.stringify(val);
    if (typeof val !== "object") return JSON.stringify(val);
    if (seen.has(val)) return '"[Circular]"';
    seen.add(val);
    if (Array.isArray(val)) {
      return "[" + val.map(stringify).join(",") + "]";
    }
    const keys = Object.keys(val).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + stringify(val[k]));
    return "{" + pairs.join(",") + "}";
  };
  return stringify(value);
}

// ============================================================
// TRACE (PARITY AUDIT TOOLING)
// ============================================================
function createTraceCollector(options, meta = {}) {
  const maxEvents = Number.isFinite(options.traceMaxEvents) ? options.traceMaxEvents : 0;
  const events = [];
  const startedAt = Date.now();

  const push = (ev) => {
    if (!options.trace) return;
    if (!ev || typeof ev !== "object") return;
    if (maxEvents > 0 && events.length >= maxEvents) return;
    // Ensure stable keys for deterministic diffs
    events.push({
      ts: ev.ts ?? null,
      model: ev.model ?? options.traceModel ?? "backtest",
      market: ev.market ?? null,
      kind: ev.kind ?? null,
      // Common fields
      barIndex: ev.barIndex ?? null,
      tickIndex: ev.tickIndex ?? null,
      price: ev.price ?? null,
      rsi: ev.rsi ?? null,
      atr: ev.atr ?? null,
      // Signal / execution fields
      action: ev.action ?? null,
      side: ev.side ?? null,
      confidence: ev.confidence ?? null,
      reason: ev.reason ?? null,
      positionId: ev.positionId ?? null,
      fillPrice: ev.fillPrice ?? null,
      stopPrice: ev.stopPrice ?? null,
      // Extra payload (kept small; prefer primitives)
      extra: ev.extra ?? null,
    });
  };

  const toJSON = () => ({
    meta: {
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      symbols: options.symbols,
      days: options.days,
      interval: options.interval,
      traceModel: options.traceModel,
      traceMaxEvents: options.traceMaxEvents,
      eventModel: BOT_RUNTIME_EVENT_MODEL,
      exitPrecedence: BOT_RUNTIME_EXIT_PRECEDENCE,
      ...meta,
    },
    events,
  });

  const write = (outputFile) => {
    if (!options.trace) return null;
    const outDir = path.dirname(outputFile);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(toJSON(), null, 2));
    return outputFile;
  };

  return { push, write, toJSON, events };
}

function filterTraceEvents(events, allowedKinds) {
  if (!Array.isArray(events)) return [];
  const set = new Set(allowedKinds || []);
  if (set.size === 0) return events.slice();
  return events.filter((e) => set.has(e.kind));
}

function sortTraceEvents(events) {
  return (events || []).slice().sort((a, b) => {
    // Primary: timestamp
    const ta = Number.isFinite(a.ts) ? a.ts : 0;
    const tb = Number.isFinite(b.ts) ? b.ts : 0;
    if (ta !== tb) return ta - tb;
    // Secondary: barIndex/tickIndex for deterministic ordering
    const ba = Number.isFinite(a.barIndex) ? a.barIndex : -1;
    const bb = Number.isFinite(b.barIndex) ? b.barIndex : -1;
    if (ba !== bb) return ba - bb;
    const xa = Number.isFinite(a.tickIndex) ? a.tickIndex : -1;
    const xb = Number.isFinite(b.tickIndex) ? b.tickIndex : -1;
    if (xa !== xb) return xa - xb;
    // Tertiary: market/kind
    const ma = String(a.market || "");
    const mb = String(b.market || "");
    if (ma !== mb) return ma < mb ? -1 : 1;
    const ka = String(a.kind || "");
    const kb = String(b.kind || "");
    if (ka !== kb) return ka < kb ? -1 : 1;
    return 0;
  });
}

function diffTraceModels(traceA, traceB, opts = {}) {
  const kinds = opts.kinds || ["bar_close_update", "entry", "exit"];
  const a = sortTraceEvents(filterTraceEvents(traceA?.events, kinds));
  const b = sortTraceEvents(filterTraceEvents(traceB?.events, kinds));

  const max = Math.max(a.length, b.length);
  const mismatches = [];

  const eq = (x, y) => x === y || (x == null && y == null);
  const priceTol = Number.isFinite(opts.priceTolerance) ? opts.priceTolerance : 1e-9;
  const tsTolMs = Number.isFinite(opts.tsToleranceMs) ? opts.tsToleranceMs : 0;

  for (let i = 0; i < max; i++) {
    const ea = a[i];
    const eb = b[i];
    if (!ea || !eb) {
      mismatches.push({
        index: i,
        reason: !ea ? "missing_in_A" : "missing_in_B",
        a: ea || null,
        b: eb || null,
      });
      break;
    }

    const fields = ["kind", "market", "side", "action", "reason"];
    for (const f of fields) {
      if (!eq(ea[f], eb[f])) {
        mismatches.push({ index: i, reason: `field_mismatch:${f}`, a: ea, b: eb });
        i = max; // break outer
        break;
      }
    }
    if (mismatches.length) break;

    // Bar index parity: allow consistent +/-1 offset (different definitions of bar index boundary).
    if (Number.isFinite(ea.barIndex) && Number.isFinite(eb.barIndex)) {
      const dBar = Math.abs(ea.barIndex - eb.barIndex);
      const barTol = Number.isFinite(opts.barIndexTolerance) ? opts.barIndexTolerance : 1;
      if (dBar > barTol) {
        mismatches.push({
          index: i,
          reason: `barIndex_delta>${barTol}`,
          a: ea,
          b: eb,
          delta: dBar,
        });
        break;
      }
    }

    // tickIndex may legitimately differ between models; treat as informational.
    // Compare timestamps within tolerance (optional)
    if (Number.isFinite(ea.ts) && Number.isFinite(eb.ts) && tsTolMs >= 0) {
      const dt = Math.abs(ea.ts - eb.ts);
      if (dt > tsTolMs) {
        mismatches.push({
          index: i,
          reason: `timestamp_delta>${tsTolMs}ms`,
          a: ea,
          b: eb,
          deltaMs: dt,
        });
        break;
      }
    }

    // Compare fills only for hard-stop exits (parity-critical); other fills may differ by design
    const isHardStopA =
      String(ea.reason || "").includes("hard_stop") ||
      (String(ea.kind || "") === "exit" && String(ea.reason || "").includes("hard"));
    const isHardStopB =
      String(eb.reason || "").includes("hard_stop") ||
      (String(eb.kind || "") === "exit" && String(eb.reason || "").includes("hard"));
    if (
      isHardStopA &&
      isHardStopB &&
      Number.isFinite(ea.stopPrice) &&
      Number.isFinite(eb.stopPrice)
    ) {
      const dp = Math.abs(ea.stopPrice - eb.stopPrice);
      if (dp > priceTol) {
        mismatches.push({
          index: i,
          reason: `stopPrice_delta>${priceTol}`,
          a: ea,
          b: eb,
          delta: dp,
        });
        break;
      }
    }
  }

  return {
    kindsCompared: kinds,
    counts: { a: a.length, b: b.length },
    firstMismatch: mismatches[0] || null,
  };
}

// ============================================================
// HARD STOP HELPERS (match enhanced-momentum-rsi-strategy.js behavior)
// ============================================================
function computeHardStopDistance({
  entryPrice,
  side,
  leverage = 1,
  hardStopEnabled = true,
  hardStopPercent = 0,
  hardStopAtrMult = 0,
  atr = null,
}) {
  if (!hardStopEnabled) return null;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const lev = Math.max(1, Number.isFinite(leverage) ? leverage : 1);

  // Strategy behavior: if both percent and ATR are configured, use the tighter (smaller) stop.
  let percentDist = null;
  let atrDist = null;

  if (Number.isFinite(hardStopPercent) && hardStopPercent > 0) {
    const dist = (entryPrice * (hardStopPercent / 100)) / lev;
    if (Number.isFinite(dist) && dist > 0) percentDist = dist;
  }

  if (Number.isFinite(atr) && atr > 0 && Number.isFinite(hardStopAtrMult) && hardStopAtrMult > 0) {
    const dist = atr * hardStopAtrMult; // not leverage-adjusted (matches strategy)
    if (Number.isFinite(dist) && dist > 0) atrDist = dist;
  }

  if (percentDist && atrDist) return Math.min(percentDist, atrDist);
  if (percentDist) return percentDist;
  if (atrDist) return atrDist;
  return null;
}

// ============================================================
// SIMULATION CONSTANTS (copied from backtest.js for consistency)
// ============================================================
const SIMULATION_CONSTANTS = {
  // Price impact model parameters
  PRICE_IMPACT_A: 15,
  PRICE_IMPACT_B: 0.3,

  // Execution simulation
  BASE_LATENCY_MS: 50,
  MAX_LATENCY_MS: 250,
  DEFAULT_REJECT_RATE: 0.001,
  DEFAULT_TIMEOUT_RATE: 0.001,
  DEFAULT_STALE_RATE: 0.001,
  DEFAULT_POST_ONLY_MISS_RATE: 0.5,
  MIN_SLICE_ADV: 0.005,
  MAX_SLICE_ADV: 0.02,

  // Fee model configuration (from env)
  // - jupiter: Flat 6bps open/close (default)
  // - drift: Tiered taker/maker with rebates
  FEE_MODEL: process.env.FEE_MODEL || "jupiter",
  EXEC_MODE: process.env.EXEC_MODE || "taker", // 'taker' or 'maker' (only affects Drift)
  DRIFT_TIER: process.env.DRIFT_TIER || "rookie", // Drift tier

  // Fee defaults (Jupiter Perps)
  DEFAULT_OPEN_FEE_BPS: 6, // 0.06% per side - total ~14 bps with swap/impact
  DEFAULT_CLOSE_FEE_BPS: 6, // 0.06% per side - total ~14 bps with swap/impact
  DEFAULT_BORROW_RATE_BPS: 1, // 0.01% per hour
  DEFAULT_POOL_UTILIZATION: 0.2, // ~20% typical pool utilization

  // ═══════════════════════════════════════════════════════════════
  // JUPITER PRICE IMPACT FEE (Linear component)
  // Formula: feeUsd = tradeSizeUsd² / scalar
  // Scalar values from Jupiter custody accounts (after /10,000 scaling):
  //   SOL: 1,250,000,000,000,000 / 10,000 = 125,000,000,000
  //   ETH: ~125,000,000,000
  //   BTC: ~125,000,000,000
  // Example: $10,000 trade → 10,000² / 125B = $0.0008
  // Ref: https://solscan.io/account/7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz
  // ═══════════════════════════════════════════════════════════════
  DEFAULT_PRICE_IMPACT_FEE_SCALAR: 125_000_000_000, // SOL scalar (scaled)

  // Swap fees (USDC ↔ Asset on entry/exit)
  // IMPORTANT: Swap fee applies to COLLATERAL, not notional!
  // Jupiter swap fees are typically 2-3 bps on collateral
  // At 2x leverage: 3 bps on collateral = 1.5 bps on notional per swap
  // Total swap fees (entry + exit) = ~3 bps on notional at 2x leverage
  // Target: 6 open + 6 close + 2 swap/impact = ~14 bps total
  DEFAULT_SWAP_FEE_BPS: 3, // 0.03% on collateral - ~1.5 bps on notional at 2x per swap
  DEFAULT_STABLE_SWAP_FEE_BPS: 2, // 0.02% for stables

  // Solana transaction fees
  DEFAULT_BASE_TX_FEE_LAMPORTS: 5000,
  DEFAULT_PRIORITY_FEE_LAMPORTS: 100000,
  LAMPORTS_PER_SOL: 1_000_000_000,
  DEFAULT_SOLANA_TX_FEE_USD: 0.024, // ~$0.024 per transaction at ~$230 SOL price
};

// Centralized fee config + Drift limit policy parser (used to simulate maker fill → taker fallback)
const { buildFeeCfg } = require("./lib/utils/fee-config");
const { parseLimitOrderConfig } = require("./lib/utils/drift-limit-config");
const { getOtherPerpFees } = require("./lib/utils/drift-other-fees");
const { getEffectiveMarginRatios } = require("../../utils/drift-margin");
// Drift historical data for funding rates
const {
  fetchFundingRates,
  buildFundingRateMap,
  calculateCumulativeFunding,
  estimateAverageFundingRate,
  prefetchFundingRatesMultiMarket,
} = require("../../utils/drift-historical");
// Market microstructure constraints (Fix #2, #3, #5 from audit)
const {
  calculateDynamicSlippage,
  estimateMakerFillProbability,
  simulateMakerFill,
  checkLiquidityConstraint,
  getCapppedPositionSize,
  shouldSkipTrade,
  getMarketConstraints,
} = require("./lib/utils/market-microstructure");

// ============================================================
// FEE CALCULATION FUNCTIONS (Jupiter Perps exact formulas)
// ============================================================

/**
 * Calculate Jupiter Linear Price Impact Fee
 *
 * Jupiter has two price impact models:
 *
 * 1. LINEAR PRICE IMPACT (what we implement here):
 *    Ref: https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing/blob/main/src/examples/get-price-impact-fee.ts
 *    Formula:
 *      feeBps = tradeSizeUsd * BPS_POWER / tradeImpactFeeScalar
 *      feeUsd = tradeSizeUsd * feeBps / BPS_POWER
 *             = tradeSizeUsd² / tradeImpactFeeScalar
 *
 * 2. ADDITIVE PRICE IMPACT (NOT implemented - requires real-time custody data):
 *    Ref: https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing/blob/main/src/examples/price-impact-fee.ts
 *    Tracks open interest imbalance over 60-second rolling window.
 *    Applies exponential scaling when delta imbalance exceeds threshold.
 *    Cannot be accurately simulated without historical custody.priceImpactBuffer data.
 *
 * NOTE: Price impact is charged on BOTH entry AND exit (each market order pays impact).
 *
 * @param {number} tradeSizeUsd - Trade size in USD (notional)
 * @param {number} scalar - Price impact fee scalar (default: 125B for SOL/ETH/BTC)
 * @returns {number} Price impact fee in USD
 */
function calculatePriceImpactFee(
  tradeSizeUsd,
  scalar = SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR
) {
  // Drift: do not apply Jupiter price impact fee model
  if (String(process.env.FEE_MODEL || "").toLowerCase() === "drift") return 0;
  // Jupiter Linear Price Impact: feeUsd = tradeSizeUsd² / scalar
  // Example: $10,000 trade with 125B scalar → 100,000,000 / 125,000,000,000 = $0.0008
  // Example: $100,000 trade → 10,000,000,000 / 125,000,000,000 = $0.08
  // Example: $50,000 trade → 2,500,000,000 / 125,000,000,000 = $0.02
  if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) return 0;
  if (!Number.isFinite(scalar) || scalar <= 0) return 0;

  return (tradeSizeUsd * tradeSizeUsd) / scalar;
}

function calculateSolanaTransactionFees(solPrice, feeCfg = {}) {
  // Note: solPrice should be the SOL token price in USD, not the asset price
  // Using a fixed SOL price estimate since we don't have real-time SOL price in backtest
  const FIXED_SOL_PRICE = 230; // Approximate SOL price for fee calculation
  const baseFee = feeCfg.baseTxFeeLamports ?? SIMULATION_CONSTANTS.DEFAULT_BASE_TX_FEE_LAMPORTS;
  const priorityFee =
    feeCfg.priorityFeeLamports ?? SIMULATION_CONSTANTS.DEFAULT_PRIORITY_FEE_LAMPORTS;
  const totalLamports = baseFee + priorityFee;
  const solAmount = totalLamports / SIMULATION_CONSTANTS.LAMPORTS_PER_SOL;
  return solAmount * FIXED_SOL_PRICE; // ~$0.024 per transaction
}

/**
 * Calculate swap fee for USDC ↔ Asset swaps
 * IMPORTANT: Apply to COLLATERAL, not notional!
 * @param {number} collateralUsd - Collateral amount (not notional!)
 * @param {object} cfg - Configuration
 */
function calculateSwapFee(collateralUsd, cfg = {}) {
  // Drift perps: no per-trade "swap fee" unless you explicitly model swaps to acquire collateral.
  if (String(process.env.FEE_MODEL || "").toLowerCase() === "drift") return 0;
  const feeBps = cfg.swapFeeBps ?? SIMULATION_CONSTANTS.DEFAULT_SWAP_FEE_BPS;
  return (collateralUsd * feeBps) / 10000;
}

/**
 * Calculate borrow fee for leveraged position
 * @param {number} notionalUsd - Notional position size
 * @param {number} holdMs - Hold duration in milliseconds
 * @param {object} cfg - Configuration
 */
function calculateBorrowFeeUsd(notionalUsd, holdMs, cfg = {}) {
  // Drift perps: this borrow-fee model is Jupiter-specific; Drift uses funding.
  if (String(process.env.FEE_MODEL || "").toLowerCase() === "drift") return 0;
  const hourlyBps = cfg.borrowRateBps ?? SIMULATION_CONSTANTS.DEFAULT_BORROW_RATE_BPS;
  const utilization = cfg.poolUtilization ?? SIMULATION_CONSTANTS.DEFAULT_POOL_UTILIZATION;
  const holdHours = holdMs / (1000 * 60 * 60);
  // Hourly Borrow Fee = Utilization × Hourly Borrow Rate × Position Size
  return (notionalUsd * hourlyBps * utilization * holdHours) / 10000;
}

/**
 * Determine if an exit reason should use taker (immediate) or can try maker first
 *
 * TAKER (immediate, emergency):
 * - rsi_hard_stop: Hard stop loss hit - MUST exit immediately
 * - rsi_hard_time_stop: Hard time-based stop
 * - max_loss_cap: Maximum loss reached - emergency
 * - circuit_breaker_active: Circuit breaker triggered
 * - end_of_backtest: Force close at end
 * - liquidation: Position liquidated
 *
 * MAKER (can try maker first with fallback):
 * - rsi_target_reached: RSI hit target - can wait for better fill
 * - rsi_target_breakeven: RSI breakeven exit
 * - rsi_target_loss: RSI target but losing
 * - rsi_partial_target: Partial profit taking
 * - rsi_time_stop: Regular time stop (not hard)
 * - rsi_failure_exit: Signal failure - can use maker
 */
const EXIT_REASON_EXEC_MODE = {
  // Taker exits (immediate)
  rsi_hard_stop: "taker",
  rsi_trailing_stop: "taker",
  rsi_hard_time_stop: "taker",
  max_loss_cap: "taker",
  circuit_breaker_active: "taker",
  end_of_backtest: "taker",
  liquidation: "taker",
  stop_loss: "taker",
  hard_stop: "taker",

  // Maker exits (can try maker first)
  rsi_target_reached: "maker",
  rsi_target_breakeven: "maker",
  rsi_target_loss: "maker",
  rsi_partial_target: "maker",
  rsi_time_stop: "maker",
  rsi_failure_exit: "maker",
  take_profit: "maker",
  time_stop: "maker",
};

/**
 * Get preferred execution mode for an exit reason
 * @param {string} reason - Exit reason
 * @param {string} defaultMode - Default mode if reason not found
 * @returns {'maker' | 'taker'} Preferred execution mode
 */
function getExitExecModeForReason(reason, defaultMode = "taker") {
  if (!reason) return defaultMode;
  const normalized = String(reason).toLowerCase().trim();

  // Check direct match first
  if (EXIT_REASON_EXEC_MODE[normalized]) {
    return EXIT_REASON_EXEC_MODE[normalized];
  }

  // Check for partial matches (e.g., 'rsi_hard_stop_triggered' → 'taker')
  if (normalized.includes("hard_stop") || normalized.includes("hard_time")) return "taker";
  if (normalized.includes("trailing_stop") || normalized.includes("trailing")) return "taker";
  if (normalized.includes("max_loss") || normalized.includes("circuit_breaker")) return "taker";
  if (normalized.includes("liquidat") || normalized.includes("emergency")) return "taker";
  if (normalized.includes("target") || normalized.includes("profit")) return "maker";
  if (normalized.includes("failure") || normalized.includes("time_stop")) return "maker";

  return defaultMode;
}

/**
 * Drift maker entry fill simulator (coarse, per-bar):
 * - Place a post-only-ish entry limit at `entryOffsetBps` from refPrice.
 * - If bar crosses the limit, treat as maker fill at limit.
 * - Otherwise, optionally fall back to taker based on DRIFT_LIMIT_* config.
 *
 * AUDIT FIX: Now includes position-size-based fill probability degradation.
 * Large positions have lower probability of maker fills even if price crosses.
 */
function simulateDriftMakerEntryFill({
  market,
  strategyKey,
  side,
  refPrice,
  candle,
  positionSizeUsd = 0,
  volatility = 0.02,
}) {
  const cfg = parseLimitOrderConfig({ market, strategy: strategyKey });
  const entryOffsetBps = Number.isFinite(cfg.entryOffsetBps) ? cfg.entryOffsetBps : 10;
  const offset = entryOffsetBps / 10000;
  const limitPrice = side === "long" ? refPrice * (1 - offset) : refPrice * (1 + offset);

  // Fixed-ratio mode: ignore candle crossing and simulate a stable maker/taker mix.
  // This is intentionally simple: it only decides maker vs taker based on configured probabilities.
  // Config:
  // - DRIFT_MAKER_SIM_MODE=fixed_ratio
  // - MAKER_ENTRY_FILL_RATE (global 0..1) OR per-market MAKER_ENTRY_FILL_RATE_<SYMBOL>
  // - DRIFT_MAKER_PRICE_IMPROVEMENT_BPS (optional, default 0)
  const makerSimMode = String(process.env.DRIFT_MAKER_SIM_MODE || "")
    .toLowerCase()
    .trim();
  const marketKey = String(market || "")
    .toUpperCase()
    .replace(/-PERP$/i, "");
  const perMarketEntryRate = Number(process.env[`MAKER_ENTRY_FILL_RATE_${marketKey}`]);
  const entryFillRate = Number.isFinite(perMarketEntryRate)
    ? perMarketEntryRate
    : Number(process.env.MAKER_ENTRY_FILL_RATE) || 0.85;
  // NOTE: in fixed_ratio mode, treat maker fills as fills at the configured limit price
  // (entryOffsetBps), so entry/exit policy differences show up in execution costs.

  if (makerSimMode === "fixed_ratio") {
    // Deterministic: hash refPrice+market+side into 0..0.99.
    // IMPORTANT: use the SAME RNG scheme as exits so exitFillRate < entryFillRate
    // actually results in worse execution mix on exits (as expected).
    const priceInt = Math.floor(refPrice * 1e6);
    const salt = marketKey.length * 17 + (side === "long" ? 3 : 7);
    const rand = ((priceInt + salt) % 100) / 100; // 0.00..0.99

    if (rand < entryFillRate) {
      return { execMode: "maker", fillPrice: limitPrice, limitPrice, outcome: "maker_fill" };
    }
    if (cfg.fallbackToTaker) {
      return {
        execMode: "taker",
        fillPrice: refPrice,
        limitPrice,
        outcome: "taker_fallback",
        reason: "fixed_ratio",
      };
    }
    return {
      execMode: null,
      fillPrice: null,
      limitPrice,
      outcome: "no_fill",
      reason: "fixed_ratio",
    };
  }

  // Simple fixed maker fill probability for entries (no size degradation)
  const getSimpleMakerFillProb = () => {
    return Number(process.env.MAKER_ENTRY_FILL_RATE) || 0.85;
  };

  // Detect stub candles (high=low=refPrice) - can't simulate crossing, just use fill degradation
  const isStubCandle =
    !candle || (candle.high === candle.low && Math.abs(candle.high - refPrice) < refPrice * 0.0001);

  const crossed =
    !isStubCandle &&
    (side === "long"
      ? Number.isFinite(candle?.low) && candle.low <= limitPrice
      : Number.isFinite(candle?.high) && candle.high >= limitPrice);

  // For stub candles OR when price crossed, apply fixed fill probability
  if (isStubCandle || crossed) {
    const fillProb = getSimpleMakerFillProb(); // 0.85 for entries
    // Deterministic: use price mantissa for reproducible pseudo-random
    const priceInt = Math.floor(refPrice * 1000000);
    const rand = (priceInt % 100) / 100; // 0.00 to 0.99

    if (rand >= fillProb) {
      // Taker fallback (15% of entries with default 0.85 fill rate)
      if (cfg.fallbackToTaker) {
        // Slippage is applied centrally for taker fills (see applyTakerEntrySlippage)
        return {
          execMode: "taker",
          fillPrice: refPrice,
          limitPrice,
          outcome: "taker_fallback",
          reason: "queue_position",
        };
      }
      return {
        execMode: null,
        fillPrice: null,
        limitPrice,
        outcome: "no_fill",
        reason: "queue_position",
      };
    }
    // Maker fill at limit price (better than market)
    return { execMode: "maker", fillPrice: limitPrice, limitPrice, outcome: "maker_fill" };
  }

  // Price didn't cross limit - fallback to taker
  if (cfg.fallbackToTaker) {
    // Slippage is applied centrally for taker fills (see applyTakerEntrySlippage)
    return { execMode: "taker", fillPrice: refPrice, limitPrice, outcome: "taker_fallback" };
  }

  return { execMode: null, fillPrice: null, limitPrice, outcome: "no_fill" };
}

/**
 * Simulate Drift maker exit fill
 *
 * For exits, we're MORE aggressive (negative offset = worse price for us but higher fill prob):
 * - Long exit (sell): limit placed at market - offset (below market if offset negative)
 * - Short exit (buy): limit placed at market + offset (above market if offset negative)
 *
 * With negative offset (e.g., -2 bps), we place limit slightly worse than market,
 * which has very high fill probability. If price still doesn't cross, we fallback to taker.
 *
 * Includes position-size-based fill probability degradation and configurable slippage.
 */
function simulateDriftMakerExitFill({
  market,
  strategyKey,
  side,
  refPrice,
  candle,
  ticks,
  tickTimestamps,
  startTickIndex = 0,
  tickIntervalMs = TICK_INTERVAL_MS,
  positionSizeUsd = 0,
  volatility = 0.02,
}) {
  const cfg = parseLimitOrderConfig({ market, strategy: strategyKey });
  // NOTE: slippage for taker exits is applied centrally (see applyTakerExitSlippage)

  // Simple fixed maker fill probability for exits (lower due to aggressive constraints)
  const getSimpleMakerFillProb = () => {
    return Number(process.env.MAKER_EXIT_FILL_RATE) || 0.65;
  };

  // Fixed-ratio mode: ignore tick/candle crossing and simulate a stable maker/taker mix.
  // Config:
  // - DRIFT_MAKER_SIM_MODE=fixed_ratio
  // - MAKER_EXIT_FILL_RATE (global 0..1) OR per-market MAKER_EXIT_FILL_RATE_<SYMBOL>
  // - DRIFT_MAKER_PRICE_IMPROVEMENT_BPS (optional, default 0)
  const makerSimMode = String(process.env.DRIFT_MAKER_SIM_MODE || "")
    .toLowerCase()
    .trim();
  const marketKey = String(market || "")
    .toUpperCase()
    .replace(/-PERP$/i, "");
  const perMarketExitRate = Number(process.env[`MAKER_EXIT_FILL_RATE_${marketKey}`]);
  const exitFillRate = Number.isFinite(perMarketExitRate)
    ? perMarketExitRate
    : Number(process.env.MAKER_EXIT_FILL_RATE) || 0.65;
  const offsetBps = Number.isFinite(cfg.exitOffsetBps) ? cfg.exitOffsetBps : 2;
  const offset = offsetBps / 10000;
  const limitPrice =
    side === "long"
      ? refPrice * (1 + offset) // sell: +offset higher, -offset lower
      : refPrice * (1 - offset); // buy:  +offset lower, -offset higher

  if (makerSimMode === "fixed_ratio") {
    const priceInt = Math.floor(refPrice * 1e6);
    // IMPORTANT: use the SAME RNG scheme as entries (same salt pattern),
    // so exitFillRate < entryFillRate reliably produces more taker on exits.
    const salt = marketKey.length * 17 + (side === "long" ? 3 : 7);
    const rand = ((priceInt + salt) % 100) / 100; // 0.00..0.99

    if (rand < exitFillRate) {
      return {
        execMode: "maker",
        fillPrice: limitPrice,
        limitPrice,
        outcome: "maker_fill",
        reason: "fixed_ratio",
      };
    }
    return {
      execMode: "taker",
      fillPrice: refPrice,
      limitPrice,
      outcome: "taker_fallback",
      reason: "fixed_ratio",
    };
  }

  // Exit limit price MUST respect signed offset semantics (parity with LimitOrderPolicySimulator):
  // - Positive: more patient (better price, lower fill prob)
  // - Negative: more aggressive (worse price, higher fill prob)
  // (limitPrice already computed above)

  // If the limit is marketable (would cross the book), it will NOT be a maker/post-only fill.
  // In production, post-only would reject; in simulation treat it as immediate taker.
  const isMarketable =
    side === "long"
      ? limitPrice <= refPrice // selling at/below market
      : limitPrice >= refPrice; // buying at/above market
  if (isMarketable) {
    return {
      execMode: "taker",
      fillPrice: refPrice,
      limitPrice,
      outcome: "taker_fallback",
      reason: "marketable_limit",
    };
  }

  // How long do we wait before failing over to taker?
  const fallbackAfterMs = Number.isFinite(cfg.exitFallbackAfterMs) ? cfg.exitFallbackAfterMs : 5000;

  // Tick-aware simulation (used in bot-parity tick loops)
  if (Array.isArray(ticks) && ticks.length > 0) {
    const start = Math.max(0, Math.min(startTickIndex, ticks.length - 1));
    const ticksToWait = Math.max(1, Math.ceil(fallbackAfterMs / Math.max(1, tickIntervalMs)));
    const end = Math.min(ticks.length - 1, start + ticksToWait);

    let fillIndex = null;
    if (side === "long") {
      // sell fills if price reaches our limit
      for (let i = start; i <= end; i++) {
        if (Number.isFinite(ticks[i]) && ticks[i] >= limitPrice) {
          fillIndex = i;
          break;
        }
      }
    } else {
      // buy fills if price falls to our limit
      for (let i = start; i <= end; i++) {
        if (Number.isFinite(ticks[i]) && ticks[i] <= limitPrice) {
          fillIndex = i;
          break;
        }
      }
    }

    if (fillIndex !== null) {
      const fillTs =
        Array.isArray(tickTimestamps) && Number.isFinite(tickTimestamps[fillIndex])
          ? tickTimestamps[fillIndex]
          : null;

      // Apply fixed fill probability for exits (lower than entries due to aggressive constraints)
      const fillProb = getSimpleMakerFillProb(); // 0.65 for exits
      const priceInt = Math.floor(refPrice * 1000000) + fillIndex;
      const rand = (priceInt % 100) / 100;
      if (rand >= fillProb) {
        // Taker fallback (35% of exits with default 0.65 fill rate)
        const fallbackIdx = fillIndex;
        const basePrice = Number.isFinite(ticks[fallbackIdx]) ? ticks[fallbackIdx] : refPrice;
        return {
          execMode: "taker",
          fillPrice: basePrice,
          limitPrice,
          outcome: "taker_fallback",
          reason: "queue_position",
          fillIndex: fallbackIdx,
          fillTs,
        };
      }

      return {
        execMode: "maker",
        fillPrice: limitPrice,
        limitPrice,
        outcome: "maker_fill",
        fillIndex,
        fillTs,
      };
    }

    // Not filled within fallback window → taker at the fallback time with slippage.
    const fallbackIndex = end;
    const basePrice = Number.isFinite(ticks[fallbackIndex]) ? ticks[fallbackIndex] : refPrice;
    const takerPrice = basePrice;
    const fillTs =
      Array.isArray(tickTimestamps) && Number.isFinite(tickTimestamps[fallbackIndex])
        ? tickTimestamps[fallbackIndex]
        : null;
    return {
      execMode: "taker",
      fillPrice: takerPrice,
      limitPrice,
      outcome: "taker_fallback",
      fillIndex: fallbackIndex,
      fillTs,
    };
  }

  // Bar-level fallback (when we don't have ticks): assume the order can sit for the whole bar.
  const crossed =
    side === "long"
      ? Number.isFinite(candle?.high) && candle.high >= limitPrice
      : Number.isFinite(candle?.low) && candle.low <= limitPrice;

  if (crossed) {
    // Apply fixed fill probability for exits (lower than entries)
    const fillProb = getSimpleMakerFillProb(); // 0.65 for exits
    const priceInt = Math.floor(refPrice * 1000000);
    const rand = (priceInt % 100) / 100;
    if (rand >= fillProb) {
      return {
        execMode: "taker",
        fillPrice: refPrice,
        limitPrice,
        outcome: "taker_fallback",
        reason: "queue_position",
      };
    }
    return { execMode: "maker", fillPrice: limitPrice, limitPrice, outcome: "maker_fill" };
  }

  return { execMode: "taker", fillPrice: refPrice, limitPrice, outcome: "taker_fallback" };
}

// ============================================================
// EXECUTION SIMULATION (from backtest.js)
// ============================================================
function estimateSpreadBps(candle) {
  const range = candle.high - candle.low;
  const mid = (candle.high + candle.low) / 2;
  if (mid <= 0) return 2; // fallback
  return Math.min(10, Math.max(1, (range / mid) * 10000 * 0.1));
}

function estimateADVusd(candles, idx, lookback = 20) {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, idx - lookback + 1); i <= idx; i++) {
    if (candles[i] && Number.isFinite(candles[i].quoteVolume)) {
      sum += candles[i].quoteVolume;
      count++;
    }
  }
  return count > 0 ? sum / count : 1_000_000;
}

function estimateVolBps(candle) {
  const range = candle.high - candle.low;
  const mid = (candle.high + candle.low) / 2;
  if (mid <= 0) return 50;
  return Math.min(200, Math.max(10, (range / mid) * 10000));
}

function applyImpactBps(sizeUsd, advUsd, volBps, a = 15, b = 0.3) {
  if (!Number.isFinite(advUsd) || advUsd <= 0) return 0;
  const ratio = sizeUsd / advUsd;
  return a * Math.pow(ratio, b) * (volBps / 50);
}

function simulateExecution({ side, sizeUsd, refPrice, candle, candles, idx, cfg = {} }) {
  // Parity mode: when comparing sequencing vs production, disable micro-slippage/jitter.
  if (cfg.parityNoSlippage) {
    return { filledUsd: sizeUsd, avgPrice: refPrice, fillRatio: 1 };
  }
  const spreadBps = estimateSpreadBps(candle);
  const advUsd = estimateADVusd(candles, idx, cfg.advLookback || 20);
  const volBps = estimateVolBps(candle);
  const a = cfg.impactA ?? SIMULATION_CONSTANTS.PRICE_IMPACT_A;
  const b = cfg.impactB ?? SIMULATION_CONSTANTS.PRICE_IMPACT_B;
  const baseLatency =
    cfg.latencyMs ??
    SIMULATION_CONSTANTS.BASE_LATENCY_MS + Math.random() * SIMULATION_CONSTANTS.MAX_LATENCY_MS;

  const sideSign = side === "long" ? 1 : -1;
  const impactBps = applyImpactBps(sizeUsd, advUsd, volBps, a, b);
  const microJitterBps = (baseLatency / (cfg.intervalMs || 300_000)) * volBps;
  const totalBps = spreadBps / 2 + impactBps + microJitterBps;
  const priceAdj = refPrice * (totalBps / 10_000) * sideSign;
  const execPrice = refPrice + priceAdj;

  return { filledUsd: sizeUsd, avgPrice: execPrice, fillRatio: 1 };
}

// ============================================================
// POSITION MANAGEMENT (from backtest.js)
// ============================================================
function openPosition({ id, side, price, ts, sizeUsd, leverage = 1 }) {
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return null;

  const rawQty = sizeUsd / price;
  const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 0;
  if (qty <= 0) return null;

  const lev = Math.max(1, leverage);
  const m = 1 / lev;
  const d = price * m;
  const liquidationPrice = side === "long" ? Math.max(0.0001, price - d) : price + d;

  const collateral = sizeUsd / lev;

  return {
    positionId: id,
    side,
    entryPrice: price,
    entryRsi: null, // Will be set by caller
    entryAtr: null, // Will be set by caller (for ATR hard stops)
    openTime: ts,
    openBarIndex: null, // Will be set by caller
    sizeUsd,
    quantity: qty,
    leverage: lev,
    collateral,
    liquidationPrice,
    tookPartial: false,
    highWaterMark: price,
    lowWaterMark: price,
    fills: [],
  };
}

function updateTrailingWatermarks(position, price) {
  if (!position || !Number.isFinite(price) || price <= 0) return;
  const entry = Number(position.entryPrice);
  if (!Number.isFinite(position.highWaterMark)) {
    position.highWaterMark = Number.isFinite(entry) && entry > 0 ? entry : price;
  }
  if (!Number.isFinite(position.lowWaterMark)) {
    position.lowWaterMark = Number.isFinite(entry) && entry > 0 ? entry : price;
  }
  const side = String(position.side || "").toLowerCase();
  if (side === "long") {
    if (price > position.highWaterMark) position.highWaterMark = price;
  } else if (side === "short") {
    if (price < position.lowWaterMark) position.lowWaterMark = price;
  }
}

function exitPosition(position, price, ts, meta = {}) {
  const qty = position.quantity;
  const dir = position.side === "long" ? 1 : -1;
  const pnlUsd = dir * (price - position.entryPrice) * qty;
  const pnlPct = (pnlUsd / position.collateral) * 100;
  const holdMs = Math.max(0, ts - position.openTime);

  return {
    ...position,
    exitPrice: price,
    exitTime: ts,
    pnlUsd,
    pnlPct,
    holdMs,
    exitReason: meta.reason || "",
  };
}

/**
 * Apply slippage to taker prices (fixed or dynamic)
 *
 * @param {number} refPrice - Reference exit price (mid/mark)
 * @param {string} side - Position side ('long' or 'short')
 * @param {number} sizeUsd - Position size in USD (notional)
 * @param {string} market - Market symbol
 * @param {number} atr - ATR value for volatility
 * @param {number} entryPrice - Entry price for volatility estimate
 * @returns {number} Filled exit price after slippage
 */
function applyTakerExitSlippage(refPrice, side, sizeUsd, market, atr, entryPrice) {
  const enableFixedSlippage = process.env.ENABLE_FIXED_SLIPPAGE === "true";
  const fixedSlippageBps = Number(process.env.FIXED_SLIPPAGE_BPS) || 0;
  const enableDynamicSlippage = process.env.ENABLE_DYNAMIC_SLIPPAGE === "true";

  let slippagePct = 0;
  if (enableFixedSlippage && fixedSlippageBps > 0) {
    const mode = String(process.env.FIXED_SLIPPAGE_MODE || "")
      .toLowerCase()
      .trim();
    const scalar = (() => {
      const s = Number(process.env.FIXED_SLIPPAGE_SCALAR);
      return Number.isFinite(s) && s > 0 ? s : 1;
    })();
    if (mode === "by_size") {
      const spec = String(process.env.FIXED_SLIPPAGE_BPS_BUCKETS || "").trim();
      const bps = pickBucketBps(spec, sizeUsd, fixedSlippageBps);
      slippagePct = (bps * scalar) / 10000;
    } else {
      slippagePct = (fixedSlippageBps * scalar) / 10000;
    }
  } else if (enableDynamicSlippage) {
    // Estimate volatility from ATR (fallback ~2%)
    const atrPct = atr && refPrice ? atr / refPrice : 0.02;
    slippagePct = calculateDynamicSlippage(sizeUsd, market, atrPct, {
      baseSlippageBps: 2,
      maxSlippageBps: 100,
    });
  }

  if (!slippagePct) return refPrice;

  // Taker pays slippage (worse fill price)
  // Closing long (sell): sell lower. Closing short (buy): buy higher.
  return side === "long" ? refPrice * (1 - slippagePct) : refPrice * (1 + slippagePct);
}

// Parse bucket spec like "1000:25,5000:35,10000:45" meaning:
// choose first threshold >= sizeUsd and return its bps; fallback to defaultBps.
// NOTE: sizeUsd here is notional (USD).
function pickBucketBps(spec, sizeUsd, defaultBps) {
  if (!spec) return defaultBps;
  const n = Number(sizeUsd);
  if (!Number.isFinite(n) || n <= 0) return defaultBps;

  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const buckets = [];
  for (const p of parts) {
    const [k, v] = p.split(":").map((x) => x.trim());
    const maxNotional = Number(k);
    const bps = Number(v);
    if (Number.isFinite(maxNotional) && Number.isFinite(bps)) {
      buckets.push({ maxNotional, bps });
    }
  }
  buckets.sort((a, b) => a.maxNotional - b.maxNotional);
  for (const b of buckets) {
    if (n <= b.maxNotional) return b.bps;
  }
  return buckets.length ? buckets[buckets.length - 1].bps : defaultBps;
}

/**
 * Apply slippage to taker ENTRY prices (fixed or dynamic)
 *
 * @param {number} refPrice - Reference entry price
 * @param {string} side - 'long' | 'short'
 * @param {number} sizeUsd - Position notional
 * @param {string} market - Market symbol
 * @param {number} atr - ATR for volatility estimate (optional)
 * @returns {number} Filled entry price after slippage
 */
function applyTakerEntrySlippage(refPrice, side, sizeUsd, market, atr) {
  const enableFixedSlippage = process.env.ENABLE_FIXED_SLIPPAGE === "true";
  const fixedSlippageBps = Number(process.env.FIXED_SLIPPAGE_BPS) || 0;
  const enableDynamicSlippage = process.env.ENABLE_DYNAMIC_SLIPPAGE === "true";

  let slippagePct = 0;
  if (enableFixedSlippage && fixedSlippageBps > 0) {
    // Optional: size-bucketed fixed slippage (bps) based on historical data
    // Env: FIXED_SLIPPAGE_MODE=by_size and FIXED_SLIPPAGE_BPS_BUCKETS="1000:25,5000:35,10000:45,25000:65,50000:120,100000:180"
    const mode = String(process.env.FIXED_SLIPPAGE_MODE || "")
      .toLowerCase()
      .trim();
    const scalar = (() => {
      const s = Number(process.env.FIXED_SLIPPAGE_SCALAR);
      return Number.isFinite(s) && s > 0 ? s : 1;
    })();
    if (mode === "by_size") {
      const spec = String(process.env.FIXED_SLIPPAGE_BPS_BUCKETS || "").trim();
      const bps = pickBucketBps(spec, sizeUsd, fixedSlippageBps);
      slippagePct = (bps * scalar) / 10000;
    } else {
      slippagePct = (fixedSlippageBps * scalar) / 10000;
    }
  } else if (enableDynamicSlippage) {
    const atrPct = atr && refPrice ? atr / refPrice : 0.02;
    slippagePct = calculateDynamicSlippage(sizeUsd, market, atrPct, {
      baseSlippageBps: 2,
      maxSlippageBps: 100,
    });
  }

  if (!slippagePct) return refPrice;

  // Entering long (buy): buy higher. Entering short (sell): sell lower.
  return side === "long" ? refPrice * (1 + slippagePct) : refPrice * (1 - slippagePct);
}

// ============================================================
// ANALYSIS FUNCTIONS (from backtest.js)
// ============================================================
function summarise(trades) {
  if (!trades.length) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: 0,
      pnlUsd: 0,
      pnlPctAvg: 0,
      maxWin: 0,
      maxLoss: 0,
      avgHoldMs: 0,
    };
  }

  const getPnl = (t) => t?.totalPnlUsd ?? t?.pnlUsd ?? t?.pnl ?? 0;
  const wins = trades.filter((t) => getPnl(t) > 0).length;
  const losses = trades.filter((t) => getPnl(t) < 0).length;
  const breakeven = trades.length - wins - losses;
  const pnlUsd = trades.reduce((acc, t) => acc + getPnl(t), 0);
  const pnlPctAvg = trades.reduce((acc, t) => acc + (Number(t?.pnlPct) || 0), 0) / trades.length;
  const maxWin = Math.max(...trades.map((t) => getPnl(t)));
  const maxLoss = Math.min(...trades.map((t) => getPnl(t)));
  const avgHoldMs = trades.reduce((acc, t) => acc + t.holdMs, 0) / trades.length;

  return {
    count: trades.length,
    wins,
    losses,
    breakeven,
    winRate: (wins / trades.length) * 100,
    pnlUsd,
    pnlPctAvg,
    maxWin,
    maxLoss,
    avgHoldMs,
  };
}

function summariseBySide(trades) {
  const longs = trades.filter((t) => t.side === "long");
  const shorts = trades.filter((t) => t.side === "short");
  return {
    long: summarise(longs),
    short: summarise(shorts),
  };
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "0.00%";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function summariseByExitReason(trades) {
  const reasons = {};
  for (const trade of trades) {
    const reason = trade.exitReason || "unknown";
    if (!reasons[reason]) {
      reasons[reason] = [];
    }
    reasons[reason].push(trade);
  }

  const result = {};
  for (const [reason, reasonTrades] of Object.entries(reasons)) {
    result[reason] = summarise(reasonTrades);
  }
  return result;
}

function calculateMaxDrawdown(equitySeries) {
  if (!equitySeries || equitySeries.length === 0) return 0;

  let peak = equitySeries[0];
  let maxDD = 0;

  for (const equity of equitySeries) {
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return maxDD * 100;
}

function calculateSharpeRatio(returns, riskFreeRate = 0) {
  if (!returns || returns.length < 2) return 0;

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const excessReturns = returns.map((r) => r - riskFreeRate);
  const avgExcess = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;

  const variance =
    excessReturns.reduce((acc, r) => acc + Math.pow(r - avgExcess, 2), 0) /
    (excessReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  return (avgExcess / stdDev) * Math.sqrt(252); // Annualized
}

function calculateSortinoRatio(returns, riskFreeRate = 0) {
  if (!returns || returns.length < 2) return 0;
  const excess = returns.map((r) => r - riskFreeRate);
  const avgExcess = excess.reduce((a, b) => a + b, 0) / excess.length;
  const downside = excess.filter((r) => r < 0);
  if (downside.length < 2) return avgExcess > 0 ? 10 : 0;
  const downsideVariance =
    downside.reduce((acc, r) => acc + Math.pow(r, 2), 0) / (downside.length - 1);
  const downsideStd = Math.sqrt(downsideVariance);
  if (downsideStd === 0) return 0;
  return (avgExcess / downsideStd) * Math.sqrt(252);
}

function getTradePnlUsd(trade) {
  const p = Number(trade?.pnlUsd ?? trade?.totalPnlUsd ?? trade?.pnl ?? trade?.totalPnl ?? 0);
  return Number.isFinite(p) ? p : 0;
}

function sqnRating(sqn) {
  if (!Number.isFinite(sqn)) return "N/A";
  if (sqn >= 7.0) return "Holy Grail";
  if (sqn >= 5.0) return "Superb";
  if (sqn >= 3.0) return "Excellent";
  if (sqn >= 2.5) return "Good";
  if (sqn >= 2.0) return "Average";
  if (sqn >= 1.6) return "Below Avg";
  return "Poor";
}

function computePayoffRatio(trades) {
  const pnls = (trades || []).map(getTradePnlUsd);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLossAbs = losses.length ? Math.abs(mean(losses)) : 0;
  const payoffRatio = avgLossAbs > 0 ? avgWin / avgLossAbs : 0;
  return { payoffRatio, avgWin, avgLossAbs };
}

function computeProfitFactor(trades) {
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades || []) {
    const p = getTradePnlUsd(t);
    if (p > 0) grossProfit += p;
    if (p < 0) grossLoss += Math.abs(p);
  }
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
  return grossProfit / grossLoss;
}

function computeStreaks(trades) {
  let maxWinStreak = 0;
  let maxLoseStreak = 0;
  let winStreak = 0;
  let loseStreak = 0;
  for (const t of trades || []) {
    const p = getTradePnlUsd(t);
    if (p > 0) {
      winStreak += 1;
      loseStreak = 0;
    } else if (p < 0) {
      loseStreak += 1;
      winStreak = 0;
    } else {
      // Breakeven breaks both streaks
      winStreak = 0;
      loseStreak = 0;
    }
    if (winStreak > maxWinStreak) maxWinStreak = winStreak;
    if (loseStreak > maxLoseStreak) maxLoseStreak = loseStreak;
  }
  return { maxWinStreak, maxLoseStreak };
}

function calculateSQN(trades) {
  const pnls = (trades || []).map(getTradePnlUsd);
  const n = pnls.length;
  if (n < 2) return { sqn: 0, expectancy: 0, tradeStdDev: 0 };
  const expectancy = mean(pnls);
  const tradeStdDev = std(pnls);
  if (tradeStdDev === 0) return { sqn: 0, expectancy, tradeStdDev };
  const sqn = Math.sqrt(n) * (expectancy / tradeStdDev);
  return { sqn: Number.isFinite(sqn) ? sqn : 0, expectancy, tradeStdDev };
}

function computeRobustScoreV2(m, options = {}) {
  const sqn = Number.isFinite(m.sqn) ? m.sqn : 0;
  const sharpe = Number.isFinite(m.sharpe) ? m.sharpe : 0;
  const recoveryFactor = Number.isFinite(m.recoveryFactor) ? m.recoveryFactor : 0;
  const ddPct = Number.isFinite(m.maxDD)
    ? m.maxDD
    : Number.isFinite(m.maxDrawdown)
      ? m.maxDrawdown
      : 20;
  const profitFactor = Number.isFinite(m.profitFactor) ? m.profitFactor : 0;
  const trades = Number.isFinite(m.trades) ? m.trades : 0;
  const days = Number.isFinite(m.days)
    ? m.days
    : Number.isFinite(options.days)
      ? options.days
      : 180;
  const winRate = Number.isFinite(m.winRate) ? m.winRate : 0; // 0..1

  const payoffRatio = Number.isFinite(m.payoffRatio) ? m.payoffRatio : 0;
  const pnlSkewness = Number.isFinite(m.pnlSkewness) ? m.pnlSkewness : 0;
  const lossTailToAvgWin = Number.isFinite(m.lossTailToAvgWin) ? m.lossTailToAvgWin : 0;
  const worstTrade = Number.isFinite(m.worstTrade) ? m.worstTrade : 0; // 0..1 return
  const pnlConcentrationTop5 = Number.isFinite(m.pnlConcentrationTop5) ? m.pnlConcentrationTop5 : 0;

  const ddDecimal = ddPct > 1 ? ddPct / 100 : ddPct;

  // Hard disqualification: max drawdown > 20%
  const MAX_DRAWDOWN_THRESHOLD = 20; // 20% maximum allowed
  const isDisqualified = ddPct > MAX_DRAWDOWN_THRESHOLD;
  const disqualifyReason = isDisqualified
    ? `maxDrawdown ${ddPct.toFixed(2)}% > ${MAX_DRAWDOWN_THRESHOLD}%`
    : null;

  const sqnBase = sqn / 2.0;
  const sharpeMultiplier =
    sharpe >= 0
      ? clamp(1.0 + Math.log1p(sharpe) * 0.3, 0.7, 1.6)
      : Math.max(0.5, 1.0 + sharpe * 0.1);
  const rfMultiplier = clamp(0.8 + Math.log1p(Math.max(0, recoveryFactor)) / 2, 0.6, 1.5);
  const ddExcess = Math.max(0, ddDecimal - 0.1);
  const ddPenalty = clamp(Math.exp(-6 * ddExcess), 0.02, 1.0);
  const pfMultiplier =
    profitFactor >= 1 ? clamp(Math.log1p(profitFactor), 0.7, 1.6) : clamp(profitFactor, 0.1, 1.0);
  const sampleMult = computeSampleConfidence(trades, days, 0.5);

  // Steamroller penalty: high WR + low payoff + bad tail
  let steamrollerPenalty = 1.0;
  const steamrollerSignature = winRate > 0.55 && payoffRatio > 0 && payoffRatio < 0.8;
  const badTail = pnlSkewness < -1.5 || lossTailToAvgWin > 3.0 || worstTrade < -0.1;
  if (steamrollerSignature && badTail) {
    const payoffFactor = clamp(payoffRatio / 0.8, 0.25, 1.0);
    const tailFactor = lossTailToAvgWin > 0 ? clamp(3.0 / lossTailToAvgWin, 0.25, 1.0) : 1.0;
    const skewFactor = pnlSkewness < 0 ? clamp(1 + (pnlSkewness + 1.5) * 0.15, 0.25, 1.0) : 1.0;
    steamrollerPenalty = payoffFactor * tailFactor * skewFactor;
  }

  // Concentration penalty: too much PnL in top 5 trades
  let concentrationPenalty = 1.0;
  if (pnlConcentrationTop5 > 0.35) {
    concentrationPenalty = clamp(0.35 / pnlConcentrationTop5, 0.4, 1.0);
  }

  // Hard gate: drawdowns above 20% are non-viable → negative score
  if (isDisqualified) {
    const base = Math.max(Math.abs(sqnBase), 0.5);
    return {
      score: -base,
      disqualified: true,
      disqualifyReason: disqualifyReason,
      components: {
        sqnBase,
        sharpeMultiplier,
        rfMultiplier,
        ddPenalty: 0,
        pfMultiplier,
        sampleMult,
        steamrollerPenalty,
        concentrationPenalty,
      },
    };
  }

  const score =
    sqnBase *
    sharpeMultiplier *
    rfMultiplier *
    ddPenalty *
    pfMultiplier *
    sampleMult *
    steamrollerPenalty *
    concentrationPenalty;

  return {
    score: Number.isFinite(score) ? score : 0,
    disqualified: isDisqualified,
    disqualifyReason: disqualifyReason,
    components: {
      sqnBase,
      sharpeMultiplier,
      rfMultiplier,
      ddPenalty,
      pfMultiplier,
      sampleMult,
      steamrollerPenalty,
      concentrationPenalty,
    },
  };
}

function tradesToDailyReturns(trades, initialCapital) {
  if (!trades || trades.length === 0 || !initialCapital) return [];

  const dailyPnL = new Map();
  for (const trade of trades) {
    const day = new Date(trade.exitTime).toISOString().slice(0, 10);
    dailyPnL.set(day, (dailyPnL.get(day) || 0) + trade.pnlUsd);
  }

  let equity = initialCapital;
  const returns = [];
  for (const [day, pnl] of [...dailyPnL.entries()].sort()) {
    const ret = pnl / equity;
    returns.push(ret);
    equity += pnl;
  }

  return returns;
}

// ============================================================
// DATA FETCHING (with caching like backtest.js)
// ============================================================
function intervalToMs(interval) {
  const map = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  };
  return map[interval] || 300_000;
}

// ============================================================
// DATA FETCHING (single-source per run)
// - source='pyth': Pyth TradingView shim ONLY (no Binance fallback)
// - source='binance': Binance klines ONLY (no Pyth calls)
// This prevents mixed sources across markets/timeframes within a run.
// ============================================================
async function fetchCandles(symbol, interval = "1m", startTime, endTime, source = "pyth") {
  const symbolUpper = symbol.toUpperCase();
  const normalizedSymbol = normalizePythSymbol(symbolUpper);
  const binanceSymbol = normalizedSymbol === "SOL" ? "SOLUSDT" : `${normalizedSymbol}USDT`;
  const intervalMs = intervalToMs(interval);
  const startAligned = alignToCandleOpenMs(startTime, intervalMs);
  const endAligned = alignToCandleCloseMs(endTime, intervalMs);

  // IMPORTANT: DB is intentionally NOT used here.
  // The DB can contain mixed candle sources from previous runs (Pyth/Binance),
  // which breaks reproducibility and "single-source" guarantees.

  // PRIORITY 1: Check JSON file cache (source-scoped with incremental updates)
  const startBucket = Math.floor(startAligned / intervalMs);
  const endBucket = Math.floor(endAligned / intervalMs);
  const src = (source || "pyth").toLowerCase() === "binance" ? "binance" : "pyth";
  const cacheKeySymbol = src === "pyth" ? symbolUpper : binanceSymbol;
  const cachePrefix = `${src}_${cacheKeySymbol}_${interval}_`;
  const primaryCacheName = `${cachePrefix}${startBucket}_${endBucket}.json`;
  const primaryCachePath = path.join(BACKTEST_CACHE_DIR, primaryCacheName);

  const normalizeCandles = (candles) => {
    if (!Array.isArray(candles)) return [];
    return candles
      .map((c) => ({
        openTime: Number(c.openTime),
        closeTime: Number(c.closeTime),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume ?? c.baseVolume ?? 0),
        quoteVolume: Number(c.quoteVolume ?? 0),
      }))
      .filter((c) => Number.isFinite(c.openTime) && Number.isFinite(c.closeTime));
  };

  const sliceToRequest = (candles) => {
    const sliced = (candles || [])
      .filter((c) => c.openTime >= startAligned && c.closeTime <= endAligned)
      .sort((a, b) => a.openTime - b.openTime);
    return sliced;
  };

  const dedupeByOpenTimeKeepLast = (candlesSortedAsc) => {
    const unique = [];
    const seen = new Set();
    for (let i = (candlesSortedAsc || []).length - 1; i >= 0; i--) {
      const c = candlesSortedAsc[i];
      const ot = Number(c?.openTime);
      if (!Number.isFinite(ot)) continue;
      if (!seen.has(ot)) {
        seen.add(ot);
        unique.unshift(c);
      }
    }
    return unique;
  };

  const boundaryCovers = (candlesSliced) => {
    if (!candlesSliced || candlesSliced.length === 0) return false;
    const first = candlesSliced[0];
    const last = candlesSliced[candlesSliced.length - 1];
    const boundarySlackMs = intervalMs * 2;
    const coversStart =
      Number.isFinite(first?.openTime) && first.openTime <= startAligned + boundarySlackMs;
    const coversEnd =
      Number.isFinite(last?.closeTime) && last.closeTime >= endAligned - boundarySlackMs;
    return coversStart && coversEnd;
  };

  const fetchFromSelectedSource = async (rangeStartMs, rangeEndMs) => {
    if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeStartMs > rangeEndMs)
      return [];
    const rStart = alignToCandleOpenMs(rangeStartMs, intervalMs);
    const rEnd = alignToCandleCloseMs(rangeEndMs, intervalMs);
    if (rStart > rEnd) return [];

    if (src === "pyth") {
      const out = await fetchFromPyth(symbolUpper, rStart, rEnd, interval);
      return normalizeCandles(out);
    }

    // Binance
    const out = [];
    let currentStart = rStart;
    while (currentStart < rEnd) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&startTime=${currentStart}&endTime=${rEnd}&limit=1000`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Binance API error: ${resp.status}`);
      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) break;
      const candles = data.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
        quoteVolume: parseFloat(k[7]),
      }));
      out.push(...normalizeCandles(candles));
      const lastCandle = candles[candles.length - 1];
      currentStart = Number(lastCandle?.closeTime) + 1;
      if (data.length < 1000) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return out;
  };

  const readCandleCacheFile = (candidatePath) => {
    try {
      if (!fs.existsSync(candidatePath)) return null;
      if (BACKTEST_CACHE_TTL_MS) {
        try {
          const stats = fs.statSync(candidatePath);
          const stale = !stats || Date.now() - stats.mtimeMs > BACKTEST_CACHE_TTL_MS;
          if (stale) return null;
        } catch (_) {
          return null;
        }
      }
      const raw = fs.readFileSync(candidatePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.candles)) return null;

      const candles = normalizeCandles(parsed.candles).sort((a, b) => a.openTime - b.openTime);
      if (candles.length === 0) return null;

      const meta = parsed.meta || {};
      const first = candles[0];
      const last = candles[candles.length - 1];
      const startBucketFromCandles = Math.floor(Number(first.openTime) / intervalMs);
      const endBucketFromCandles = Math.floor(Number(last.closeTime) / intervalMs);
      const startBucketMeta = Number.isFinite(Number(meta.startBucket))
        ? Number(meta.startBucket)
        : startBucketFromCandles;
      const endBucketMeta = Number.isFinite(Number(meta.endBucket))
        ? Number(meta.endBucket)
        : endBucketFromCandles;

      return {
        path: candidatePath,
        meta,
        candles,
        startBucket: startBucketMeta,
        endBucket: endBucketMeta,
        startTime: Number(first.openTime),
        endTime: Number(last.closeTime),
      };
    } catch (_) {
      return null;
    }
  };

  const listCacheFiles = () => {
    const paths = [];
    try {
      ensureDir(BACKTEST_CACHE_DIR);
      const entries = fs.readdirSync(BACKTEST_CACHE_DIR);
      for (const entry of entries) {
        if (!entry.startsWith(cachePrefix) || !entry.endsWith(".json")) continue;
        paths.push(path.join(BACKTEST_CACHE_DIR, entry));
      }
    } catch (_) {}
    // Always include primary path first (if it exists) for fast exact hits.
    if (!paths.includes(primaryCachePath)) paths.unshift(primaryCachePath);
    return paths;
  };

  if (BACKTEST_CACHE_ENABLED) {
    const cacheCandidates = [];
    const seenPaths = new Set();
    for (const p of listCacheFiles()) {
      if (seenPaths.has(p)) continue;
      seenPaths.add(p);
      const info = readCandleCacheFile(p);
      if (!info) continue;
      const covers = info.startBucket <= startBucket && info.endBucket >= endBucket;
      const overlaps = info.endBucket >= startBucket && info.startBucket <= endBucket;
      cacheCandidates.push({
        ...info,
        covers,
        overlaps,
        span: info.endBucket - info.startBucket,
      });
    }

    // 1) Strong HIT: any cache that truly covers requested buckets (superset OK).
    const full = cacheCandidates
      .filter((c) => c.covers)
      .sort((a, b) => {
        // Prefer smallest superset (least span). Tie-breaker: more recently updated.
        if (a.span !== b.span) return a.span - b.span;
        const au = Number(a.meta?.updatedAt || a.meta?.createdAt || 0);
        const bu = Number(b.meta?.updatedAt || b.meta?.createdAt || 0);
        return bu - au;
      });

    for (const c of full) {
      const sliced = sliceToRequest(c.candles);
      if (sliced.length === 0) continue;
      const expectedCandles = Math.max(1, Math.floor((endAligned - startAligned) / intervalMs));
      const coverageRatio = sliced.length / expectedCandles;
      const okBoundaries = boundaryCovers(sliced);
      if (okBoundaries) {
        console.log(
          `[CACHE] SUPERSET HIT - Using ${sliced.length} cached candles for ${symbolUpper} @ ${interval} ` +
            `[${path.basename(c.path)}] (coverage≈${(coverageRatio * 100).toFixed(1)}%)`
        );
        if (coverageRatio < 0.95) {
          console.warn(
            `[CACHE] WARNING - Cache coverage below 95% (${(coverageRatio * 100).toFixed(1)}%)\n` +
              `  Expected: ${expectedCandles}, Got: ${sliced.length}\n` +
              `  Continuing with cache but results may be incomplete.`
          );
        }
        return sliced;
      }
    }

    // 2) Incremental: pick the best overlapping cache (max overlap) and fetch missing sides.
    const overlapping = cacheCandidates
      .filter((c) => c.overlaps)
      .sort((a, b) => {
        const overlapA = Math.max(
          0,
          Math.min(endBucket, a.endBucket) - Math.max(startBucket, a.startBucket)
        );
        const overlapB = Math.max(
          0,
          Math.min(endBucket, b.endBucket) - Math.max(startBucket, b.startBucket)
        );
        if (overlapA !== overlapB) return overlapB - overlapA;
        // Prefer wider cache when overlap is equal (reduces total fetching).
        if (a.span !== b.span) return b.span - a.span;
        const au = Number(a.meta?.updatedAt || a.meta?.createdAt || 0);
        const bu = Number(b.meta?.updatedAt || b.meta?.createdAt || 0);
        return bu - au;
      });

    const base = overlapping[0] || null;
    if (base) {
      const needBefore = startBucket < base.startBucket;
      const needAfter = endBucket > base.endBucket;
      if (needBefore || needAfter) {
        const cacheDays = ((base.endTime - base.startTime) / 86400000).toFixed(1);
        const requestDays = ((endAligned - startAligned) / 86400000).toFixed(1);
        const parts = [];
        if (needBefore) parts.push("prepend");
        if (needAfter) parts.push("append");
        console.log(
          `[CACHE] INCREMENTAL (${parts.join("+")}) - Have ${cacheDays}d cache, need ${requestDays}d ` +
            `(${symbolUpper} @ ${interval}) via ${path.basename(base.path)}`
        );

        try {
          const beforeStart = startAligned;
          const beforeEnd = Math.min(endAligned, base.startTime - 1);
          const afterStart = Math.max(startAligned, base.endTime + 1);
          const afterEnd = endAligned;

          const fetchedBefore = needBefore
            ? await fetchFromSelectedSource(beforeStart, beforeEnd)
            : [];
          const fetchedAfter = needAfter ? await fetchFromSelectedSource(afterStart, afterEnd) : [];

          const mergedSorted = [...base.candles, ...fetchedBefore, ...fetchedAfter]
            .filter((c) => Number.isFinite(c?.openTime) && Number.isFinite(c?.closeTime))
            .sort((a, b) => a.openTime - b.openTime);
          const merged = dedupeByOpenTimeKeepLast(mergedSorted);

          const mergedFirst = merged[0];
          const mergedLast = merged[merged.length - 1];
          const mergedStartTime = Number(mergedFirst?.openTime);
          const mergedEndTime = Number(mergedLast?.closeTime);
          const mergedStartBucket = Math.floor(mergedStartTime / intervalMs);
          const mergedEndBucket = Math.floor(mergedEndTime / intervalMs);
          const targetCacheName = `${cachePrefix}${mergedStartBucket}_${mergedEndBucket}.json`;
          const targetCachePath = path.join(BACKTEST_CACHE_DIR, targetCacheName);

          const updatedPayload = {
            meta: {
              symbol: cacheKeySymbol,
              interval,
              startTime: mergedStartTime,
              endTime: mergedEndTime,
              startBucket: mergedStartBucket,
              endBucket: mergedEndBucket,
              intervalMs,
              createdAt: base.meta?.createdAt || Date.now(),
              updatedAt: Date.now(),
              count: merged.length,
              source: src === "pyth" ? "pyth_tradingview" : "binance_klines",
            },
            candles: merged,
          };

          ensureDir(BACKTEST_CACHE_DIR);
          fs.writeFileSync(targetCachePath, stableStringify(updatedPayload));
          console.log(
            `[CACHE] Updated ${path.basename(targetCachePath)} (${merged.length} total candles)`
          );

          if (base.path !== targetCachePath && fs.existsSync(base.path)) {
            try {
              fs.unlinkSync(base.path);
              console.log(`[CACHE] Removed old cache: ${path.basename(base.path)}`);
            } catch (_) {}
          }

          cleanupOverlappingCaches(cachePrefix, targetCachePath, intervalMs);

          const finalSliced = sliceToRequest(merged);
          const expectedCandles = Math.max(1, Math.floor((endAligned - startAligned) / intervalMs));
          const coverageRatio = finalSliced.length / expectedCandles;
          if (boundaryCovers(finalSliced)) {
            if (coverageRatio < 0.95) {
              console.warn(
                `[CACHE] WARNING - Incremental merged coverage below 95% (${(coverageRatio * 100).toFixed(1)}%) ` +
                  `(${finalSliced.length}/${expectedCandles}). Continuing anyway.`
              );
            }
            return finalSliced;
          }
        } catch (err) {
          console.warn(
            `[CACHE] Incremental update failed: ${err.message}. Falling back to full fetch.`
          );
        }
      }
    }
  }

  // PRIORITY 2: Fetch from selected source (no mixing / no per-symbol fallback here)
  let allCandles = [];
  if (src === "pyth") {
    const pythCandles = await fetchFromPyth(symbolUpper, startAligned, endAligned, interval);
    if (pythCandles && pythCandles.length > 0) {
      allCandles = pythCandles;
      console.log(`[PYTH] Fetched ${allCandles.length} candles for ${symbolUpper} @ ${interval}`);
    } else {
      allCandles = [];
    }
  } else {
    console.log(
      `[BINANCE] Fetching ${symbolUpper} @ ${interval} from ${new Date(startAligned).toISOString()} to ${new Date(endAligned).toISOString()}`
    );

    let currentStart = startAligned;

    while (currentStart < endAligned) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&startTime=${currentStart}&endTime=${endAligned}&limit=1000`;

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Binance API error: ${resp.status}`);

      const data = await resp.json();
      if (data.length === 0) break;

      const candles = data.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
        quoteVolume: parseFloat(k[7]),
      }));

      allCandles.push(...candles);

      // Move to next page
      const lastCandle = candles[candles.length - 1];
      currentStart = lastCandle.closeTime + 1;

      if (data.length < 1000) break;

      // Rate limiting
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const filteredCandles = allCandles
    .filter((c) => Number.isFinite(c?.openTime) && Number.isFinite(c?.closeTime))
    .filter((c) => c.openTime >= startAligned && c.closeTime <= endAligned)
    .sort((a, b) => a.openTime - b.openTime);
  console.log(`[${src.toUpperCase()}] Received ${filteredCandles.length} candles total`);

  // CRITICAL: Validate data coverage before accepting
  const expectedCandles = Math.max(1, Math.floor((endAligned - startAligned) / intervalMs));
  const coverageRatio = filteredCandles.length / expectedCandles;
  const minAcceptableCoverage = 0.95; // Must have 95%+ of expected candles

  if (filteredCandles.length === 0) {
    throw new Error(
      `[${src.toUpperCase()}] FETCH FAILED - No candles returned for ${symbolUpper} @ ${interval}\n` +
        `  Range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}\n` +
        `  Expected: ${expectedCandles} candles, Got: 0`
    );
  }

  if (coverageRatio < minAcceptableCoverage) {
    // Check boundary coverage for better diagnostics
    const first = filteredCandles[0];
    const last = filteredCandles[filteredCandles.length - 1];
    const actualStartDate = first ? new Date(first.openTime).toISOString() : "N/A";
    const actualEndDate = last ? new Date(last.closeTime).toISOString() : "N/A";
    const requestedStartDate = new Date(startAligned).toISOString();
    const requestedEndDate = new Date(endAligned).toISOString();

    const missingAtStart = first && first.openTime > startAligned + intervalMs * 2;
    const missingAtEnd = last && last.closeTime < endAligned - intervalMs * 2;

    throw new Error(
      `[${src.toUpperCase()}] INSUFFICIENT DATA - Coverage too low for ${symbolUpper} @ ${interval}\n` +
        `  Requested: ${requestedStartDate} to ${requestedEndDate}\n` +
        `  Actual:    ${actualStartDate} to ${actualEndDate}\n` +
        `  Expected:  ${expectedCandles} candles\n` +
        `  Received:  ${filteredCandles.length} candles (${(coverageRatio * 100).toFixed(1)}% coverage)\n` +
        `  Missing:   ${missingAtStart ? "START " : ""}${missingAtEnd ? "END" : ""}\n` +
        `\n` +
        `  This likely means:\n` +
        `  - Cache has partial data (${filteredCandles.length} candles)\n` +
        `  - API fetch failed or returned incomplete data\n` +
        `  - Data not available for full lookback period\n` +
        `\n` +
        `  Solutions:\n` +
        `  - Reduce lookback period (currently ${((endTime - startTime) / 86400000).toFixed(0)} days)\n` +
        `  - Clear cache and retry: rm -f ${BACKTEST_CACHE_DIR}/${src}_${cacheKeySymbol}_${interval}_*.json\n` +
        `  - Check if data source has historical data for this period\n` +
        `  - For Pyth, try BACKTEST_USE_PYTH=false to use Binance instead`
    );
  }

  console.log(
    `[${src.toUpperCase()}] ✓ Data validation passed - ` +
      `${filteredCandles.length}/${expectedCandles} candles (${(coverageRatio * 100).toFixed(1)}% coverage)`
  );

  // Store in JSON file cache
  if (BACKTEST_CACHE_ENABLED && filteredCandles.length > 0) {
    try {
      ensureDir(BACKTEST_CACHE_DIR);
      const payload = {
        meta: {
          symbol: cacheKeySymbol,
          interval,
          // Store aligned boundaries so future incremental requests can extend safely on either side.
          startTime: startAligned,
          endTime: endAligned,
          startBucket,
          endBucket,
          intervalMs,
          createdAt: Date.now(),
          count: filteredCandles.length,
          source: src === "pyth" ? "pyth_tradingview" : "binance_klines",
        },
        candles: filteredCandles,
      };
      fs.writeFileSync(primaryCachePath, stableStringify(payload));
      console.log(
        `[CACHE] Saved ${filteredCandles.length} candles to ${path.basename(primaryCachePath)}`
      );

      // Clean up overlapping/redundant caches
      cleanupOverlappingCaches(cachePrefix, primaryCachePath, intervalMs);
    } catch (cacheErr) {
      console.warn(`[CACHE] Write failed: ${cacheErr.message}`);
    }
  }

  return filteredCandles;
}

// ============================================================
// PYTH DATA FETCHING (same source as Jupiter Perps)
// ============================================================

function normalizePythSymbol(symbol) {
  const upper = String(symbol || "").toUpperCase().replace(/-PERP$/, "");
  if (upper.startsWith("1M") && upper.length > 2) return upper.slice(2);
  if (upper.startsWith("1K") && upper.length > 2) return upper.slice(2);
  return upper;
}

function getPythMarketId(symbol) {
  const mapping = {
    SOL: "Crypto.SOL/USD",
    BTC: "Crypto.BTC/USD",
    ETH: "Crypto.ETH/USD",
  };
  const normalized = normalizePythSymbol(symbol);
  return mapping[normalized] || `Crypto.${normalized}/USD`;
}

async function fetchFromPyth(symbol, startTime, endTime, interval) {
  const pythMarketId = getPythMarketId(symbol);
  const resolution = interval === "1m" ? "1" : "5";

  // Pyth limit: ~6 days for 1m, ~150 days for 5m
  // Use 5-day chunks for 1m to stay safe, 120-day chunks for 5m
  const PYTH_MAX_CHUNK_MS =
    interval === "1m"
      ? 5 * 24 * 60 * 60 * 1000 // 5 days for 1m
      : 120 * 24 * 60 * 60 * 1000; // 120 days for 5m

  const totalDuration = endTime - startTime;
  const needsChunking = totalDuration > PYTH_MAX_CHUNK_MS;

  if (needsChunking) {
    console.log(
      `[PYTH] Large request (${Math.round(totalDuration / (24 * 60 * 60 * 1000))} days) - chunking into ${Math.ceil(totalDuration / PYTH_MAX_CHUNK_MS)} parts`
    );

    const allCandles = [];
    let chunkStart = startTime;
    let chunkNum = 0;

    while (chunkStart < endTime) {
      const chunkEnd = Math.min(chunkStart + PYTH_MAX_CHUNK_MS, endTime);
      chunkNum++;

      console.log(
        `[PYTH] Chunk ${chunkNum}: ${new Date(chunkStart).toISOString().slice(0, 10)} to ${new Date(chunkEnd).toISOString().slice(0, 10)}`
      );

      const chunkCandles = await fetchFromPythSingleRequest(
        pythMarketId,
        resolution,
        chunkStart,
        chunkEnd,
        interval
      );
      allCandles.push(...chunkCandles);

      chunkStart = chunkEnd;

      // Delay to avoid rate limits (increased from 100ms to 250ms for safety)
      if (chunkStart < endTime) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    console.log(
      `[PYTH] Fetched ${allCandles.length} total candles for ${pythMarketId} @ ${resolution}min`
    );
    return allCandles;
  } else {
    console.log(`[PYTH] Fetching: ${pythMarketId} @ ${resolution}min`);
    return await fetchFromPythSingleRequest(pythMarketId, resolution, startTime, endTime, interval);
  }
}

async function fetchFromPythSingleRequest(
  pythMarketId,
  resolution,
  startTime,
  endTime,
  interval,
  retries = 3
) {
  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=${encodeURIComponent(pythMarketId)}&resolution=${resolution}&from=${Math.floor(startTime / 1000)}&to=${Math.floor(endTime / 1000)}`;

  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, { timeout: 30000 });

      if (!resp.ok) {
        // Retry on 5xx errors (server errors), but not on 4xx (client errors)
        if (resp.status >= 500 && attempt < retries - 1) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 5000);
          console.log(
            `[PYTH] Got ${resp.status}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})`
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw new Error(`Pyth API error: ${resp.status}`);
      }

      const data = await resp.json();

      if (!data || data.s !== "ok" || !data.t || data.t.length === 0) {
        const errmsg = data?.errmsg || data?.s || "no_status";
        throw new Error(`Pyth returned status: ${errmsg}`);
      }

      // Convert to our candle format
      const candles = [];
      const intervalMs = interval === "1m" ? 60000 : 300000;

      for (let i = 0; i < data.t.length; i++) {
        const timestamp = data.t[i] * 1000;
        const open = Number(data.o?.[i]);
        const high = Number(data.h?.[i]);
        const low = Number(data.l?.[i]);
        const close = Number(data.c?.[i]);
        const volume = Number(data.v?.[i] ?? 0);
        if (![open, high, low, close].every(Number.isFinite)) continue;
        candles.push({
          openTime: timestamp,
          closeTime: timestamp + intervalMs - 1,
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) ? volume : 0,
          quoteVolume: 0,
        });
      }

      return candles;
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 5000);
        console.log(
          `[PYTH] Request failed: ${err.message}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw lastError;
}

// ============================================================
// TICK SIMULATION (15-second ticks from 1-minute candles - MORE ACCURATE)
// ============================================================
// Bot runs on 15-second loops with 5-minute RSI bars
// Strategy: Fetch 1-minute candles, interpolate 4 ticks per minute
// This gives REAL price data every minute instead of guessing from 5-min OHLC
//
// 5-minute period = 5 x 1-minute candles
// Each 1-minute candle = 4 ticks (15 sec intervals)
// Total = 20 ticks per 5-minute period with REAL 1-min data

const TICKS_PER_1MIN_CANDLE = 4; // 4 ticks per 1-minute candle = 15-second intervals
const TICKS_PER_5MIN_CANDLE = 20; // 20 ticks per 5-minute period
const TICK_INTERVAL_MS = 15000; // 15 seconds

/**
 * Tick timestamp helpers (anti-mismatch guardrails)
 *
 * For 5m bars with tick simulation enabled, this repo's source-of-truth model is:
 * - exactly 20 ticks per 5m candle
 * - exactly 15,000ms spacing between ticks
 *
 * We enforce this strictly to prevent "price from tick i" being paired with a different timestamp.
 */
function getTickStepMsOrThrow(interval, ticksPerCandle, { simulateTicks = true } = {}) {
  const intervalMs = intervalToMs(interval || "5m");
  if (simulateTicks && intervalMs === 300_000) {
    if (ticksPerCandle !== TICKS_PER_5MIN_CANDLE) {
      throw new Error(
        `[TICK-TS] Invalid ticksPerCandle for 5m tick simulation: got ${ticksPerCandle}, expected ${TICKS_PER_5MIN_CANDLE}`
      );
    }
    return TICK_INTERVAL_MS;
  }
  // Generic fallback for other intervals (keep integer ms to avoid fractional timestamps).
  const step = Math.floor(intervalMs / Math.max(1, ticksPerCandle || 1));
  return Math.max(1, step);
}

function tickTsFromBarOpen(
  barOpenTime,
  tickIndex,
  interval,
  ticksPerCandle,
  { simulateTicks = true } = {}
) {
  const base = Number(barOpenTime);
  if (!Number.isFinite(base)) return null;
  const idx = Number(tickIndex);
  if (!Number.isFinite(idx)) return null;
  const step = getTickStepMsOrThrow(interval, ticksPerCandle, { simulateTicks });
  return base + idx * step;
}

// ============================================================
// TICK CACHE (15s ticks derived from 1m candles)
// - No interpolation / no look-ahead: ticks are generated only from 1m OHLC
// - Cached on disk to avoid rebuilding every run
// ============================================================
const BACKTEST_TICK_CACHE_ENABLED = process.env.BACKTEST_TICK_CACHE_ENABLED !== "false";

function tickCacheKey({ source, symbol, startTime, endTime }) {
  const src = (source || "pyth").toLowerCase() === "binance" ? "binance" : "pyth";
  const startBucket5m = Math.floor(alignToCandleOpenMs(startTime, 300_000) / 300_000);
  const endBucket5m = Math.floor(alignToCandleCloseMs(endTime, 300_000) / 300_000);
  return `${src}_${symbol.toUpperCase()}_ticks15s_5m_${startBucket5m}_${endBucket5m}.json`;
}

function tickCachePrefix({ source, symbol }) {
  const src = (source || "pyth").toLowerCase() === "binance" ? "binance" : "pyth";
  return `${src}_${symbol.toUpperCase()}_ticks15s_5m_`;
}

function sliceTicksByBucketRange(byBar, startBucket5m, endBucket5m) {
  if (!byBar) return null;
  const out = new Map();
  const startOpen = startBucket5m * 300_000;
  const endOpen = endBucket5m * 300_000;
  for (const [barOpen, ticks] of byBar.entries()) {
    const t = Number(barOpen);
    if (!Number.isFinite(t)) continue;
    if (t < startOpen || t > endOpen) continue;
    out.set(t, ticks);
  }
  return out;
}

function buildTicksFor5mBucketsFrom1m(oneMinCandles, bucketOpens) {
  // Build ticks only for the requested 5m buckets (no need to rebuild the whole map).
  const out = new Map();
  if (!Array.isArray(oneMinCandles) || oneMinCandles.length === 0) return out;
  const ONE_MIN_MS = 60_000;
  const FIVE_MIN_MS = 300_000;

  const byOpen = new Map();
  for (const c of oneMinCandles) {
    const ot = Number(c?.openTime);
    if (!Number.isFinite(ot)) continue;
    byOpen.set(ot, c);
  }

  for (const bucket of bucketOpens || []) {
    const bucketOpen = Number(bucket);
    if (!Number.isFinite(bucketOpen)) continue;
    if (bucketOpen % FIVE_MIN_MS !== 0) continue;
    const group = [];
    for (let i = 0; i < 5; i++) {
      const c = byOpen.get(bucketOpen + i * ONE_MIN_MS);
      if (!c) {
        group.length = 0;
        break;
      }
      group.push(c);
    }
    if (group.length !== 5) continue;
    const tickObjs = [];
    let tsCursor = bucketOpen;
    for (const oneMin of group) {
      const minTicks = generateTicksFrom1MinCandle(oneMin);
      for (const p of minTicks) {
        tickObjs.push({ price: p, ts: tsCursor });
        tsCursor += TICK_INTERVAL_MS;
      }
    }
    if (tickObjs.length === TICKS_PER_5MIN_CANDLE) {
      out.set(bucketOpen, tickObjs);
    }
  }

  return out;
}

function buildTicksByBarOpenTimeFrom1m(oneMinCandles) {
  // Output: Map<barOpenTimeMs, Array<{price:number, ts:number}>>
  // Each 5m bar has 20 ticks: 5 x (4 ticks per 1m candle).
  const byBar = new Map();
  if (!Array.isArray(oneMinCandles) || oneMinCandles.length === 0) return byBar;

  // Ensure sorted by openTime (copy to avoid mutating caller)
  const sorted = oneMinCandles.slice().sort((a, b) => Number(a.openTime) - Number(b.openTime));
  const ONE_MIN_MS = 60_000;
  const FIVE_MIN_MS = 300_000;

  // Group by true 5m boundaries
  const buckets = new Map(); // bucketOpenTime -> 1m candles[]
  for (const c of sorted) {
    const ot = Number(c?.openTime);
    if (!Number.isFinite(ot)) continue;
    const bucket = Math.floor(ot / FIVE_MIN_MS) * FIVE_MIN_MS;
    const arr = buckets.get(bucket) || [];
    arr.push(c);
    buckets.set(bucket, arr);
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  for (const bucket of keys) {
    const group = (buckets.get(bucket) || []).sort(
      (a, b) => Number(a.openTime) - Number(b.openTime)
    );
    if (group.length !== 5) continue;
    // Require contiguity (exact 1m spacing)
    let contiguous = true;
    for (let i = 0; i < 5; i++) {
      if (Number(group[i].openTime) !== bucket + i * ONE_MIN_MS) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;

    const tickObjs = [];
    let tsCursor = bucket;
    for (const oneMin of group) {
      const minTicks = generateTicksFrom1MinCandle(oneMin); // 4 prices
      for (const p of minTicks) {
        tickObjs.push({ price: p, ts: tsCursor });
        tsCursor += TICK_INTERVAL_MS;
      }
    }
    if (tickObjs.length === TICKS_PER_5MIN_CANDLE) {
      byBar.set(bucket, tickObjs);
    }
  }
  return byBar;
}

function readTickCacheFile(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.barOpenTimes) || !Array.isArray(parsed.tickPricesFlat))
      return null;
    const barOpenTimes = parsed.barOpenTimes.map(Number);
    const tickPricesFlat = parsed.tickPricesFlat.map(Number);
    const ticksPerBar = Number(parsed.ticksPerBar || TICKS_PER_5MIN_CANDLE);
    const tickIntervalMs = Number(parsed.tickIntervalMs || TICK_INTERVAL_MS);
    // Hard guardrails: refuse to load caches that could produce mismatched tick timestamps.
    if (ticksPerBar !== TICKS_PER_5MIN_CANDLE) return null;
    if (tickIntervalMs !== TICK_INTERVAL_MS) return null;
    if (!Number.isFinite(ticksPerBar) || ticksPerBar <= 0) return null;
    if (tickPricesFlat.length !== barOpenTimes.length * ticksPerBar) return null;

    const byBar = new Map();
    for (let i = 0; i < barOpenTimes.length; i++) {
      const barOpen = barOpenTimes[i];
      const startIdx = i * ticksPerBar;
      const tickObjs = [];
      for (let j = 0; j < ticksPerBar; j++) {
        tickObjs.push({ price: tickPricesFlat[startIdx + j], ts: barOpen + j * TICK_INTERVAL_MS });
      }
      byBar.set(barOpen, tickObjs);
    }
    const meta = parsed.meta || {};
    // Ensure we always have bucket ranges for cleanup + superset reuse.
    const firstBar = barOpenTimes[0];
    const lastBar = barOpenTimes[barOpenTimes.length - 1];
    const startBucket = Number.isFinite(Number(meta.startBucket))
      ? Number(meta.startBucket)
      : Math.floor(firstBar / 300_000);
    const endBucket = Number.isFinite(Number(meta.endBucket))
      ? Number(meta.endBucket)
      : Math.floor(lastBar / 300_000);
    return { meta, byBar, startBucket, endBucket };
  } catch (_) {
    return null;
  }
}

function loadTickCache(cachePath) {
  const parsed = readTickCacheFile(cachePath);
  return parsed ? parsed.byBar : null;
}

function saveTickCache(cachePath, meta, ticksByBar, bucketRange = null) {
  try {
    ensureDir(BACKTEST_CACHE_DIR);
    const barOpenTimes = [...ticksByBar.keys()].sort((a, b) => a - b);
    const tickPricesFlat = [];
    for (const barOpen of barOpenTimes) {
      const ticks = ticksByBar.get(barOpen) || [];
      for (const t of ticks) tickPricesFlat.push(t.price);
    }
    const startBucket =
      bucketRange?.startBucket ??
      (barOpenTimes.length ? Math.floor(barOpenTimes[0] / 300_000) : null);
    const endBucket =
      bucketRange?.endBucket ??
      (barOpenTimes.length ? Math.floor(barOpenTimes[barOpenTimes.length - 1] / 300_000) : null);
    const startTime = Number.isFinite(startBucket) ? startBucket * 300_000 : meta?.startTime;
    const endTime = Number.isFinite(endBucket) ? endBucket * 300_000 + 300_000 - 1 : meta?.endTime;
    const payload = {
      meta: {
        ...meta,
        startBucket,
        endBucket,
        intervalMs: 300_000,
        startTime,
        endTime,
        createdAt: meta?.createdAt || Date.now(),
        updatedAt: Date.now(),
      },
      ticksPerBar: TICKS_PER_5MIN_CANDLE,
      tickIntervalMs: TICK_INTERVAL_MS,
      barOpenTimes,
      tickPricesFlat,
    };
    fs.writeFileSync(cachePath, stableStringify(payload));
  } catch (_) {
    // Best-effort cache
  }
}

async function getOrBuildTicksByBarOpenTime({ source, symbol, startTime, endTime, oneMinCandles }) {
  const src = (source || "pyth").toLowerCase() === "binance" ? "binance" : "pyth";
  const symbolUpper = String(symbol || "").toUpperCase();
  const startBucket5m = Math.floor(alignToCandleOpenMs(startTime, 300_000) / 300_000);
  const endBucket5m = Math.floor(alignToCandleCloseMs(endTime, 300_000) / 300_000);
  const cachePrefix = tickCachePrefix({ source: src, symbol: symbolUpper });
  const primaryName = tickCacheKey({ source: src, symbol: symbolUpper, startTime, endTime });
  const primaryPath = path.join(BACKTEST_CACHE_DIR, primaryName);

  const listPaths = () => {
    const out = [];
    try {
      ensureDir(BACKTEST_CACHE_DIR);
      const entries = fs.readdirSync(BACKTEST_CACHE_DIR);
      for (const entry of entries) {
        if (!entry.startsWith(cachePrefix) || !entry.endsWith(".json")) continue;
        out.push(path.join(BACKTEST_CACHE_DIR, entry));
      }
    } catch (_) {}
    if (!out.includes(primaryPath)) out.unshift(primaryPath);
    return out;
  };

  if (BACKTEST_TICK_CACHE_ENABLED) {
    // MEMORY FIX: Two-phase loading
    // Phase 1: Parse bucket ranges from FILENAMES only (no file reads!)
    const candidateMeta = [];
    const seen = new Set();
    for (const p of listPaths()) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (!fs.existsSync(p)) continue;

      const base = path.basename(p);
      const parsed = parseBucketRangeFromFilename(base);
      if (!parsed) continue;

      const { startBucket, endBucket } = parsed;
      const covers = startBucket <= startBucket5m && endBucket >= endBucket5m;
      const overlaps = endBucket >= startBucket5m && startBucket <= endBucket5m;
      const span = endBucket - startBucket;

      candidateMeta.push({ path: p, startBucket, endBucket, covers, overlaps, span });
    }

    // Find best SUPERSET (covers entire range) - prefer smallest span (tightest fit)
    const fullCandidates = candidateMeta.filter((c) => c.covers).sort((a, b) => a.span - b.span);

    if (fullCandidates[0]) {
      // Phase 2: Load ONLY the best matching cache
      const best = fullCandidates[0];
      const loaded = readTickCacheFile(best.path);
      if (loaded && loaded.byBar) {
        const sliced = sliceTicksByBucketRange(loaded.byBar, startBucket5m, endBucket5m);
        console.log(
          `   [TICK-CACHE] SUPERSET HIT: ${path.basename(best.path)} → ${sliced.size} bars`
        );
        return sliced;
      }
    }

    // Find best OVERLAPPING cache for incremental extension
    const overlappingCandidates = candidateMeta
      .filter((c) => c.overlaps && !c.covers)
      .sort((a, b) => {
        const overlapA = Math.max(
          0,
          Math.min(endBucket5m, a.endBucket) - Math.max(startBucket5m, a.startBucket)
        );
        const overlapB = Math.max(
          0,
          Math.min(endBucket5m, b.endBucket) - Math.max(startBucket5m, b.startBucket)
        );
        if (overlapA !== overlapB) return overlapB - overlapA;
        return b.span - a.span;
      });

    const bestOverlap = overlappingCandidates[0] || null;
    if (bestOverlap) {
      // Phase 2: Load ONLY this one cache for extension
      const loaded = readTickCacheFile(bestOverlap.path);
      if (loaded && loaded.byBar) {
        const needBefore = startBucket5m < bestOverlap.startBucket;
        const needAfter = endBucket5m > bestOverlap.endBucket;

        console.log(
          `   [TICK-CACHE] INCREMENTAL (${needBefore ? "prepend" : ""}${needBefore && needAfter ? "+" : ""}${needAfter ? "append" : ""}) ` +
            `via ${path.basename(bestOverlap.path)}`
        );

        const missingBuckets = [];
        for (let b = startBucket5m; b <= endBucket5m; b++) {
          const barOpen = b * 300_000;
          if (!loaded.byBar.has(barOpen)) missingBuckets.push(barOpen);
        }
        const built = buildTicksFor5mBucketsFrom1m(oneMinCandles, missingBuckets);
        for (const [k, v] of built.entries()) loaded.byBar.set(k, v);

        // Write merged cache under its true bucket range
        const keys = [...loaded.byBar.keys()].sort((a, b) => a - b);
        const mergedStartBucket = keys.length ? Math.floor(keys[0] / 300_000) : startBucket5m;
        const mergedEndBucket = keys.length
          ? Math.floor(keys[keys.length - 1] / 300_000)
          : endBucket5m;
        const targetName = `${cachePrefix}${mergedStartBucket}_${mergedEndBucket}.json`;
        const targetPath = path.join(BACKTEST_CACHE_DIR, targetName);

        saveTickCache(
          targetPath,
          { source: src, symbol: symbolUpper, createdAt: loaded.meta?.createdAt || Date.now() },
          loaded.byBar,
          { startBucket: mergedStartBucket, endBucket: mergedEndBucket }
        );

        if (bestOverlap.path !== targetPath && fs.existsSync(bestOverlap.path)) {
          try {
            fs.unlinkSync(bestOverlap.path);
          } catch (_) {}
        }

        cleanupOverlappingCaches(cachePrefix, targetPath, 300_000);
        const sliced = sliceTicksByBucketRange(loaded.byBar, startBucket5m, endBucket5m);
        return sliced;
      }
    }

    // No useful cache: fall through to build fresh.
  }

  const builtAll = buildTicksByBarOpenTimeFrom1m(oneMinCandles);
  const sliced = sliceTicksByBucketRange(builtAll, startBucket5m, endBucket5m);
  if (BACKTEST_TICK_CACHE_ENABLED) {
    const keys = [...builtAll.keys()].sort((a, b) => a - b);
    const bStart = keys.length ? Math.floor(keys[0] / 300_000) : startBucket5m;
    const bEnd = keys.length ? Math.floor(keys[keys.length - 1] / 300_000) : endBucket5m;
    saveTickCache(primaryPath, { source: src, symbol: symbolUpper }, builtAll, {
      startBucket: bStart,
      endBucket: bEnd,
    });
    cleanupOverlappingCaches(cachePrefix, primaryPath, 300_000);
    console.log(`   [TICK-CACHE] Saved: ${path.basename(primaryPath)} (${builtAll.size} bars)`);
  }
  return sliced;
}

/**
 * Generate tick prices from a 1-minute candle (4 ticks = 15 sec each)
 * More accurate than interpolating from 5-minute candles
 */
function generateTicksFrom1MinCandle(candle) {
  const { open, high, low, close } = candle;
  const ticks = [];

  // 4 ticks per 1-minute candle
  // Realistic path: O → extreme → extreme → C
  const isBullish = close >= open;

  if (isBullish) {
    // Bullish: O → L → H → C
    ticks.push(open);
    ticks.push(low);
    ticks.push(high);
    ticks.push(close);
  } else {
    // Bearish: O → H → L → C
    ticks.push(open);
    ticks.push(high);
    ticks.push(low);
    ticks.push(close);
  }

  return ticks;
}

/**
 * Aggregate 5 x 1-minute candles into 1 x 5-minute candle
 */
function aggregate1MinTo5Min(oneMinCandles) {
  if (!oneMinCandles || oneMinCandles.length === 0) return null;

  return {
    openTime: oneMinCandles[0].openTime,
    closeTime: oneMinCandles[oneMinCandles.length - 1].closeTime,
    open: oneMinCandles[0].open,
    high: Math.max(...oneMinCandles.map((c) => c.high)),
    low: Math.min(...oneMinCandles.map((c) => c.low)),
    close: oneMinCandles[oneMinCandles.length - 1].close,
    volume: oneMinCandles.reduce((sum, c) => sum + (c.volume || 0), 0),
    quoteVolume: oneMinCandles.reduce((sum, c) => sum + (c.quoteVolume || 0), 0),
  };
}

/**
 * Deterministically aggregate 1m candles into timestamp-aligned 5m candles.
 * This avoids "slice-in-5s" bar drift when the requested startTime isn't on a 5m boundary.
 *
 * Rules:
 * - Group by real 5m boundaries (bucket = floor(openTime/5m)*5m)
 * - Only emit a 5m candle when all 5 constituent 1m candles are present and contiguous
 */
function aggregate1MinTo5MinAligned(oneMinCandles) {
  if (!oneMinCandles || oneMinCandles.length === 0) return [];
  const ONE_MIN_MS = 60_000;
  const FIVE_MIN_MS = 300_000;

  const byBucket = new Map();
  for (const c of oneMinCandles) {
    if (!c) continue;
    const openTime = Number(c.openTime);
    if (!Number.isFinite(openTime)) continue;
    const bucket = Math.floor(openTime / FIVE_MIN_MS) * FIVE_MIN_MS;
    const arr = byBucket.get(bucket) || [];
    arr.push(c);
    byBucket.set(bucket, arr);
  }

  const buckets = [...byBucket.keys()].sort((a, b) => a - b);
  const out = [];
  for (const bucket of buckets) {
    const group = byBucket.get(bucket) || [];
    group.sort((a, b) => Number(a.openTime) - Number(b.openTime));
    if (group.length !== 5) continue;
    let contiguous = true;
    for (let i = 0; i < 5; i++) {
      const expectedOpen = bucket + i * ONE_MIN_MS;
      if (Number(group[i].openTime) !== expectedOpen) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const agg = aggregate1MinTo5Min(group);
    if (agg) out.push(agg);
  }
  return out;
}

/**
 * Generate all ticks from 5 x 1-minute candles (20 ticks total)
 * Each 1-minute candle provides 4 real-data-based ticks
 */
function generateTicksFrom1MinCandles(oneMinCandles) {
  const allTicks = [];

  for (const candle of oneMinCandles) {
    const ticks = generateTicksFrom1MinCandle(candle);
    for (const tick of ticks) {
      allTicks.push({
        price: tick,
        ts: candle.openTime + (allTicks.length % 4) * TICK_INTERVAL_MS,
        high: candle.high,
        low: candle.low,
      });
    }
  }

  return allTicks;
}

/**
 * Legacy function for backward compatibility (5-min candle interpolation)
 * Used when 1-minute data is not available
 */
function generateIntraBarTicks(candle, numTicks = TICKS_PER_5MIN_CANDLE) {
  const { open, high, low, close } = candle;
  const ticks = [];

  // Determine if bullish or bearish candle
  const isBullish = close >= open;

  // Create realistic price path through OHLC
  const waypoints = isBullish ? [open, low, high, close] : [open, high, low, close];

  // Distribute ticks across 3 segments
  const segmentTicks = Math.floor(numTicks / 3);

  for (let seg = 0; seg < 3; seg++) {
    const start = waypoints[seg];
    const end = waypoints[seg + 1];
    const ticksInSeg = seg === 2 ? numTicks - 2 * segmentTicks : segmentTicks;

    for (let t = 0; t < ticksInSeg; t++) {
      const progress = ticksInSeg > 1 ? t / (ticksInSeg - 1) : 1;
      const price = start + (end - start) * progress;
      ticks.push(price);
    }
  }

  while (ticks.length < numTicks) {
    ticks.push(close);
  }

  return ticks.slice(0, numTicks);
}

/**
 * Shared intra-bar tick path helper used by multi-market simulators.
 * Ensures the path visits BOTH high and low (important for stop triggering),
 * without using candle.high/low directly as a look-ahead condition (ticks embody the path).
 */
function generateTickPrices(candle, numTicks = TICKS_PER_5MIN_CANDLE) {
  return generateIntraBarTicks(candle, numTicks);
}

/**
 * Generate tick objects from 5m candle OHLC (fallback when 1m data is incomplete)
 * Returns array of {price, ts} objects matching the format from 1m-derived ticks.
 * This is used for graceful degradation at fold boundaries in walk-forward analysis.
 */
function generateTicksFromOHLC(candle, numTicks = TICKS_PER_5MIN_CANDLE) {
  const prices = generateIntraBarTicks(candle, numTicks);
  const ticks = [];
  const barStart = Number(candle.openTime);

  for (let i = 0; i < prices.length; i++) {
    ticks.push({
      price: prices[i],
      ts: barStart + i * TICK_INTERVAL_MS,
    });
  }

  return ticks;
}

// ============================================================
// RSI MEAN-REVERSION SIMULATION
// ============================================================
function simulateRsiMeanReversion(strategy, candles, options = {}) {
  const {
    positionSizeUsd = 1000,
    leverage = 3,
    debug = false,
    verbose = false,
    allowLongs = true,
    allowShorts = true,
    simulateTicks = true, // Enable 15-second tick simulation (matches bot loop)
    ticksPerCandle = TICKS_PER_5MIN_CANDLE, // 20 ticks per 5-min candle
    maxPositions = 1, // Allow multiple concurrent positions (1 = single position)
  } = options;

  const trace = options._trace;
  const traceModel = options._traceModel || "backtest";
  const marketName = strategy?.cfg?.market || (options.symbol ? `${options.symbol}-PERP` : null);
  const parityChecks = !!options.parityChecks;
  let lastBarCloseUpdatedIdx = -1; // idx of last strategy.update() call (bar-close update)

  // Fee configuration - uses FEE_MODEL env var (jupiter or drift)
  const feeCfg = buildFeeCfg();

  // ============================================================
  // HISTORICAL FUNDING RATE SUPPORT
  // ============================================================
  // If historical funding rate maps are provided, use actual hourly rates
  // Otherwise fall back to estimated average funding rate
  const fundingRateMaps = options.fundingRateMaps || null;
  // Only consider "used historical" if at least one market actually has records (non-empty map).
  const marketsWithFundingRecords = (() => {
    if (!fundingRateMaps || fundingRateMaps.size === 0) return 0;
    let n = 0;
    for (const v of fundingRateMaps.values()) {
      const m = v?.map;
      if (m && typeof m.size === "number" && m.size > 0) n++;
    }
    return n;
  })();
  const useHistoricalFunding = !!fundingRateMaps && marketsWithFundingRecords > 0;
  const fundingStats = {
    enabled: process.env.DRIFT_ENABLE_FUNDING === "true" && feeCfg.model === "drift",
    requestedHistorical: !!options.enableHistoricalFunding,
    usedHistorical: useHistoricalFunding,
    marketsRequested: fundingRateMaps ? fundingRateMaps.size : 0,
    marketsWithRecords: marketsWithFundingRecords,
  };

  // Drift funding rate estimation (enabled with DRIFT_ENABLE_FUNDING=true)
  // Uses estimated average funding rate per hour (configurable via env vars)
  // Default: 0.005% per hour = ~44% APR (typical for SOL, can be higher during rallies)
  const enableFunding = process.env.DRIFT_ENABLE_FUNDING === "true" && feeCfg.model === "drift";
  const fundingRatePctPerHour = Number(process.env.DRIFT_AVG_FUNDING_RATE_PCT_HR) || 0.005; // 0.005% default

  // Market-specific overrides: DRIFT_FUNDING_SOL=0.01 sets SOL-PERP to 0.01%/hr
  const getMarketFundingRate = (market) => {
    const normalizedMarket = market.toUpperCase().replace("-PERP", "");
    const envKey = `DRIFT_FUNDING_${normalizedMarket}`;
    const override = Number(process.env[envKey]);
    return Number.isFinite(override) ? override : fundingRatePctPerHour;
  };

  /**
   * Calculate funding cost for a position using historical data or estimated average
   * @param {string} market - Market symbol (e.g., 'SOL' or 'SOL-PERP')
   * @param {string} side - 'long' or 'short'
   * @param {number} notional - Position size in USD
   * @param {number} openTs - Position open timestamp (ms)
   * @param {number} closeTs - Position close timestamp (ms)
   * @returns {number} Funding payment (negative = paid, positive = received)
   */
  const calculateFundingCostForPosition = (market, side, notional, openTs, closeTs) => {
    if (!enableFunding) return 0;

    // Normalize market name for lookup
    const normalizedMarket = market.toUpperCase().replace("-PERP", "") + "-PERP";

    // Try to use historical funding rates if available
    if (useHistoricalFunding) {
      const marketFundingData = fundingRateMaps.get(normalizedMarket);
      if (marketFundingData && marketFundingData.map && marketFundingData.map.size > 0) {
        // Use actual historical funding rate calculation
        const result = calculateCumulativeFunding(
          marketFundingData.map,
          side,
          notional,
          openTs,
          closeTs
        );
        return result.totalFunding || 0;
      }
    }

    // Fall back to estimated average funding rate
    const durationMs = closeTs - openTs;
    const hours = durationMs / (1000 * 60 * 60);
    const fundingPeriods = Math.ceil(hours); // Funding is hourly
    const marketFundingRate = getMarketFundingRate(market);
    const rateDecimal = marketFundingRate / 100; // Convert % to decimal

    // Longs pay when rate is positive (typical), shorts receive
    // This is a simplification - in reality direction flips based on perp premium
    if (side === "long") {
      return -notional * rateDecimal * fundingPeriods; // Negative = paying
    } else {
      return notional * rateDecimal * fundingPeriods; // Positive = receiving (shorts get paid)
    }
  };

  // Legacy wrapper for backwards compatibility
  const estimateFundingCost = (side, notional, durationMs, fundingRate) => {
    if (!enableFunding) return 0;
    const hours = durationMs / (1000 * 60 * 60);
    const fundingPeriods = Math.ceil(hours); // Funding is hourly
    const rateDecimal = fundingRate / 100; // Convert % to decimal

    if (side === "long") {
      return -notional * rateDecimal * fundingPeriods; // Negative = paying
    } else {
      return notional * rateDecimal * fundingPeriods; // Positive = receiving (shorts get paid)
    }
  };

  // State
  const trades = [];
  const positions = [];
  const equitySeries = [];
  let realisedPnl = 0;
  let totalFees = 0;
  let tradeCounter = 0;
  const initialCapital = options.initialCapital || positionSizeUsd;

  // Maker fill simulation stats (Drift only)
  // attempts = tried maker simulation
  // takerFallbacks = maker simulation timed out / failed → fallback to taker
  // forcedTaker = emergency exits that never try maker (hard stops, etc.)
  const makerEntryStats = { attempts: 0, makerFills: 0, takerFallbacks: 0, noFills: 0 };
  const makerExitStats = {
    attempts: 0,
    makerFills: 0,
    takerFallbacks: 0,
    forcedTaker: 0,
    noFills: 0,
  };

  // Note: No look-ahead bias because RSI is updated at bar START (from previous bar's close)
  // and entries happen at current bar's OPEN - matching live bot behavior

  // Compounding support
  const enableCompounding = options.enableCompounding ?? false;
  const positionSizePercent = options.positionSizePercent ?? 100; // % of equity to use
  let currentEquity = initialCapital;

  // Calculate used margin (collateral locked in open positions)
  const getUsedMargin = () => {
    return positions.reduce((sum, pos) => sum + (pos.collateral || pos.sizeUsd / leverage), 0);
  };

  // Track current price for capital calculations
  let currentPrice = candles[0]?.close || 0;

  // Calculate available capital for new positions (FIXED: use current price, not last candle)
  const getAvailableCapital = () => {
    const usedMargin = getUsedMargin();
    // IMPORTANT: Compounding is REALISED-only.
    // We do NOT increase available capital based on unrealised PnL from open positions.
    // This matches "no intratrade compounding" (position sizes remain fixed until closed).
    const realisedEquity = enableCompounding ? initialCapital + realisedPnl : initialCapital;
    return Math.max(0, realisedEquity - usedMargin);
  };

  // Calculate current position size based on compounding and available capital
  const getPositionSize = (forEntry = false) => {
    let baseSize;
    if (enableCompounding) {
      baseSize = currentEquity * (positionSizePercent / 100);
      baseSize = Math.max(baseSize, options.minPositionSize || 50);
    } else {
      baseSize = positionSizeUsd;
    }

    // Cap at max position size
    const maxPosSize = options.maxPositionSize || 5000;
    baseSize = Math.min(baseSize, maxPosSize);

    // If checking for entry, STRICTLY limit to available capital
    if (forEntry) {
      const available = getAvailableCapital();
      // For leveraged positions, we only need collateral = position / leverage
      const requiredCollateral = baseSize; // This is the collateral, not notional
      if (requiredCollateral > available) {
        // Use 95% of available to leave buffer, but ensure it's positive
        const adjustedSize = Math.max(0, available * 0.95);
        if (debug) {
          console.log(
            `[CAPITAL] Requested $${baseSize.toFixed(0)} but only $${available.toFixed(0)} available. Using $${adjustedSize.toFixed(0)}`
          );
        }
        return adjustedSize;
      }
    }

    return baseSize;
  };

  // Detailed fee tracking
  const feeBreakdown = {
    openFees: 0, // Entry fees (bps-based)
    closeFees: 0, // Exit fees (bps-based)
    impactFees: 0, // Price impact fees
    swapFees: 0, // USDC ↔ Asset swap fees (on collateral)
    borrowFees: 0, // Borrow/funding fees (hourly)
    slippageUsd: 0, // Execution slippage cost (USD). NOT a protocol fee; computed from fill vs ref.
    slippageEntryUsd: 0,
    slippageExitUsd: 0,
    txFees: 0, // Solana transaction fees
    // Drift other fees (typically on liquidation events)
    liquidatorFees: 0,
    insuranceFees: 0,
    totalTrades: 0,
  };

  // Capital tracking for validation
  let maxEquity = initialCapital;
  let minEquity = initialCapital;
  let capitalViolations = 0; // Track if we ever exceed available capital

  // Track RSI indicator values
  const indicatorLog = [];

  const has1MinData = options.oneMinCandles && options.oneMinCandles.length > 0;
  console.log(`\n📊 Starting RSI Mean-Reversion Simulation`);
  console.log(`   Candles: ${candles.length} (5-minute)`);
  console.log(
    `   Tick Simulation: ${simulateTicks ? (has1MinData ? "1-min OHLC based (accurate)" : "interpolated (legacy)") : "disabled"}`
  );
  if (has1MinData) {
    console.log(
      `   1-min Data: ${options.oneMinCandles.length} candles → 4 ticks each → more accurate entries`
    );
  }
  console.log(`   Entry Timing: BAR OPEN (RSI from prev bar, entry at open - no look-ahead)`);
  console.log(`   Initial Capital: $${initialCapital}`);
  console.log(
    `   Position Size: $${getPositionSize().toFixed(0)} (${enableCompounding ? `${positionSizePercent}% compounding` : "fixed"})`
  );
  console.log(`   Leverage: ${leverage}x`);
  console.log(
    `   RSI Config: oversold=${strategy.cfg.rsiOversoldExtreme}→${strategy.cfg.rsiOversoldRecovery}, overbought=${strategy.cfg.rsiOverboughtExtreme}→${strategy.cfg.rsiOverboughtRecovery}`
  );
  console.log(`   Max Entry Deviation: ${strategy.cfg.rsiEntryMaxDeviation} RSI points`);
  console.log(
    `   Exit Targets: neutral=${strategy.cfg.rsiTargetNeutral}, partial=${strategy.cfg.rsiPartialTargetLong}/${strategy.cfg.rsiPartialTargetShort}`
  );
  console.log(`   Time Stop: ${strategy.cfg.rsiTimeStopBars} bars\n`);

  // Warmup period (need at least rsiPeriod + 1 bars)
  const warmupBars = strategy.cfg.rsiPeriod + 10;

  for (let idx = 0; idx < candles.length; idx++) {
    const candle = candles[idx];
    const ts = candle.closeTime;
    const price = candle.close;
    const markPrice = price; // Simplified for backtest
    currentPrice = price; // Update for capital calculations

    if (trace) {
      trace.push({
        model: traceModel,
        kind: "bar_open",
        ts: candle.openTime,
        market: marketName,
        barIndex: idx,
        tickIndex: 0,
        price: candle.open,
        rsi: strategy.rsi,
        atr: strategy.atr,
        extra: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
      });
    }

    // ============================================================
    // RSI EXITS AT BAR OPEN (production parity)
    // - RSI is updated only at prior bar close
    // - RSI-based exits are evaluated only at bar boundaries
    // - execution price is bar OPEN
    // ============================================================
    if (idx > 0 && positions.length > 0 && Number.isFinite(strategy.rsi)) {
      // Hard stop is handled per tick (including the open tick), so skip rsi_hard_stop here.
      for (const pos of [...positions]) {
        const exitSignal = strategy.shouldClose(pos, candle.open);
        if (!exitSignal) continue;
        if (exitSignal.reason === "rsi_hard_stop") continue;

        const tsOpen = candle.openTime;
        const pxOpen = candle.open;

        if (exitSignal.partial) {
          const percent = Math.max(0, Math.min(100, Number(exitSignal.percent || 0)));
          if (percent <= 0) continue;
          const fraction = percent / 100;
          const qtyToClose = pos.quantity * fraction;
          if (!Number.isFinite(qtyToClose) || qtyToClose <= 0) continue;

          const dir = pos.side === "long" ? 1 : -1;
          const grossPnl = dir * (pxOpen - pos.entryPrice) * qtyToClose;
          const notional = qtyToClose * pxOpen;

          const closeExecMode = feeCfg.model === "drift" ? "taker" : "taker";
          const closeRes = feeCfg.calculateCloseFee
            ? feeCfg.calculateCloseFee(notional, { execMode: closeExecMode })
            : {
                fee: notional * (feeCfg.closeFeeBps / 10_000),
                breakdown: { baseFee: notional * (feeCfg.closeFeeBps / 10_000), priceImpactFee: 0 },
              };
          const closeFee = closeRes.breakdown?.baseFee ?? 0;
          const impactFee = closeRes.breakdown?.priceImpactFee ?? 0;
          const swapFee = calculateSwapFee(pos.collateral * fraction);
          const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
          const borrowFee = calculateBorrowFeeUsd(
            pos.sizeUsd * fraction,
            Math.max(0, tsOpen - lastBorrowTs)
          );
          const txFee = calculateSolanaTransactionFees(pxOpen, feeCfg);
          const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;

          const netPnl = grossPnl - totalExitFees;
          realisedPnl += netPnl;
          totalFees += totalExitFees;

          feeBreakdown.closeFees += closeFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.swapFees += swapFee;
          feeBreakdown.borrowFees += borrowFee;
          feeBreakdown.txFees += txFee;
          feeBreakdown.totalTrades++;

          pos.quantity -= qtyToClose;
          pos.sizeUsd -= pos.sizeUsd * fraction;
          pos.collateral -= pos.collateral * fraction;
          pos.tookPartial = true;
          pos.lastBorrowTs = tsOpen;
          pos.fills.push({
            ts: tsOpen,
            price: pxOpen,
            qty: qtyToClose,
            pnlUsd: netPnl,
            reason: exitSignal.reason,
          });

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "exit",
              ts: tsOpen,
              market: marketName,
              barIndex: idx,
              tickIndex: 0,
              price: pxOpen,
              rsi: strategy.rsi,
              atr: strategy.atr,
              action: "partial_close",
              side: pos.side,
              reason: exitSignal.reason,
              positionId: pos.positionId || pos.id,
              fillPrice: pxOpen,
            });
          }
          continue;
        }

        if (exitSignal.close) {
          const exitReason = exitSignal.reason;

          // Determine exit mode based on reason
          const preferredExitMode = getExitExecModeForReason(exitReason, feeCfg.execMode);
          let exitExecMode = preferredExitMode;
          let filledExitPrice = pxOpen;

          // Track exit stats and simulate maker exit if applicable
          if (
            feeCfg.model === "drift" &&
            feeCfg.execMode === "maker" &&
            preferredExitMode === "maker" &&
            process.env.ENABLE_MAKER_FILL_SIM === "true"
          ) {
            makerExitStats.attempts++;
            const exitSim = simulateDriftMakerExitFill({
              market: marketName || "UNKNOWN",
              strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
              side: pos.side,
              refPrice: pxOpen,
              candle,
              positionSizeUsd: pos.sizeUsd || 0, // AUDIT FIX: Pass size for degradation
            });
            exitExecMode = exitSim.execMode;
            filledExitPrice = exitSim.fillPrice || pxOpen;
            if (exitSim.outcome === "maker_fill") makerExitStats.makerFills++;
            if (exitSim.outcome === "taker_fallback") makerExitStats.takerFallbacks++;
          } else if (preferredExitMode === "taker" && feeCfg.execMode === "maker") {
            makerExitStats.forcedTaker++; // Emergency exit - never tries maker
          }

          // Apply taker slippage consistently (fixed or dynamic) for ANY taker exit
          if (exitExecMode === "taker") {
            const refExitPrice = filledExitPrice;
            const approxNotional = pos.quantity * filledExitPrice;
            filledExitPrice = applyTakerExitSlippage(
              filledExitPrice,
              pos.side,
              approxNotional,
              marketName || "UNKNOWN",
              Number.isFinite(pos.entryAtr)
                ? pos.entryAtr
                : Number.isFinite(strategy.atr)
                  ? strategy.atr
                  : null,
              pos.entryPrice
            );
            if (
              Number.isFinite(refExitPrice) &&
              refExitPrice > 0 &&
              Number.isFinite(filledExitPrice)
            ) {
              const notional = pos.quantity * refExitPrice;
              const slipUsd = notional * Math.abs(filledExitPrice / refExitPrice - 1);
              if (Number.isFinite(slipUsd) && slipUsd > 0) {
                feeBreakdown.slippageUsd += slipUsd;
                feeBreakdown.slippageExitUsd += slipUsd;
              }
            }
          }

          const pnl = exitPosition(pos, filledExitPrice, tsOpen, { reason: exitReason });
          const currentNotional = pos.quantity * filledExitPrice;
          const closeRes = feeCfg.calculateCloseFee
            ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
            : {
                fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                breakdown: {
                  baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                  priceImpactFee: 0,
                },
              };
          const closeFee = closeRes.breakdown?.baseFee ?? 0;
          const impactFee =
            feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
          const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
          const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
          const borrowFee =
            feeCfg.model === "drift"
              ? 0
              : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, tsOpen - lastBorrowTs));
          const txFee = calculateSolanaTransactionFees(filledExitPrice, feeCfg);
          const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;

          pnl.pnlUsd -= totalExitFees;
          pnl.fees = { closeFee, impactFee, swapFee, borrowFee, txFee, exitExecMode };
          pnl.exitRsi = strategy.rsi;
          pnl.exitReason = exitReason;

          trades.push(pnl);
          realisedPnl += pnl.pnlUsd;

          totalFees += totalExitFees;
          feeBreakdown.closeFees += closeFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.swapFees += swapFee;
          feeBreakdown.borrowFees += borrowFee;
          feeBreakdown.txFees += txFee;
          feeBreakdown.totalTrades++;

          const idxPos = positions.indexOf(pos);
          if (idxPos >= 0) positions.splice(idxPos, 1);

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "exit",
              ts: tsOpen,
              market: marketName,
              barIndex: idx,
              tickIndex: 0,
              price: pxOpen,
              rsi: strategy.rsi,
              atr: strategy.atr,
              action: "close",
              side: pnl.side,
              reason: pnl.exitReason,
              positionId: pnl.positionId || pnl.id,
              fillPrice: filledExitPrice,
            });
          }
        }
      }
    }

    // ============================================================
    // ENTRY CHECK AT BAR OPEN (using RSI from PREVIOUS bar - no look-ahead)
    // This matches live bot behavior:
    //   1. Previous bar closes → RSI updated
    //   2. Signal check happens immediately
    //   3. Entry at current bar's OPEN price
    // ============================================================
    if (idx > 0 && positions.length < maxPositions && Number.isFinite(strategy.rsi)) {
      // Guardrail: at bar open for idx, RSI must come from previous completed bar (idx-1)
      if (parityChecks && lastBarCloseUpdatedIdx !== idx - 1) {
        throw new Error(
          `[PARITY] Illegal entry sequencing at bar ${idx}: expected last bar-close update idx=${idx - 1}, got ${lastBarCloseUpdatedIdx}`
        );
      }
      const entryPrice = candle.open;
      const entryTime = candle.openTime;

      // Get entry signal using current RSI (from previous bar - no look-ahead)
      const signal = strategy.getSignal(entryPrice, positions, false, idx);
      if (trace) {
        trace.push({
          model: traceModel,
          kind: "signal",
          ts: entryTime,
          market: marketName,
          barIndex: idx,
          tickIndex: 0,
          price: entryPrice,
          rsi: strategy.rsi,
          atr: strategy.atr,
          action: signal?.action ?? null,
          side: signal?.side ?? null,
          confidence: signal?.confidence ?? null,
          reason: signal?.reason ?? null,
        });
      }

      if (signal && signal.action === "open") {
        const side = signal.side?.toLowerCase();

        // Check direction filters
        if (!((side === "long" && !allowLongs) || (side === "short" && !allowShorts))) {
          let currentPositionSize = getPositionSize(true);
          if (currentPositionSize > 0) {
            let requestedSizeUsd = currentPositionSize * leverage;

            // AUDIT FIX: Apply liquidity constraint / position size cap before execution
            // Disabled by default - enable with ENABLE_LIQUIDITY_CAPS=true
            if (process.env.ENABLE_LIQUIDITY_CAPS === "true") {
              const tradeCheck = shouldSkipTrade(marketName, requestedSizeUsd, { strict: false });
              if (tradeCheck.skip) {
                // Trade skipped due to liquidity constraint
                continue;
              }
              if (tradeCheck.capped) {
                requestedSizeUsd = tradeCheck.cappedSize;
                currentPositionSize = requestedSizeUsd / leverage;
              }
            }

            const exec = simulateExecution({
              side,
              sizeUsd: requestedSizeUsd,
              refPrice: entryPrice,
              candle,
              candles,
              idx,
              cfg: {
                intervalMs: intervalToMs(options.interval || "5m"),
                parityNoSlippage: !!options.parityChecks,
              },
            });

            if (exec.filledUsd > 0) {
              // Simulate maker entry fill (Drift only)
              let entryExecMode = feeCfg.execMode;
              let filledEntryPrice = exec.avgPrice;
              if (
                feeCfg.model === "drift" &&
                feeCfg.execMode === "maker" &&
                process.env.ENABLE_MAKER_FILL_SIM === "true"
              ) {
                makerEntryStats.attempts++;
                const entrySim = simulateDriftMakerEntryFill({
                  market: marketName || (options.symbol ? `${options.symbol}-PERP` : null),
                  strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
                  side,
                  refPrice: exec.avgPrice,
                  candle,
                  positionSizeUsd: exec.filledUsd, // AUDIT FIX: Pass size for degradation
                });
                entryExecMode = entrySim.execMode;
                filledEntryPrice = entrySim.fillPrice || exec.avgPrice;
                if (entrySim.outcome === "maker_fill") makerEntryStats.makerFills++;
                if (entrySim.outcome === "taker_fallback") makerEntryStats.takerFallbacks++;
              }

              // Apply taker slippage consistently (fixed or dynamic) for ANY taker entry
              if (entryExecMode === "taker") {
                const refEntryPrice = filledEntryPrice;
                filledEntryPrice = applyTakerEntrySlippage(
                  filledEntryPrice,
                  side,
                  exec.filledUsd,
                  marketName || (options.symbol ? `${options.symbol}-PERP` : "UNKNOWN"),
                  Number.isFinite(strategy.atr) ? strategy.atr : null
                );
                // Track slippage as execution cost (USD), separate from protocol fees
                // IMPORTANT: Use actual filled quantity * fill price, not exec.filledUsd (which is pre-slippage notional)
                if (
                  Number.isFinite(refEntryPrice) &&
                  refEntryPrice > 0 &&
                  Number.isFinite(filledEntryPrice)
                ) {
                  const actualQty = exec.filledUsd / refEntryPrice; // quantity at reference price
                  const actualNotional = actualQty * filledEntryPrice; // actual notional after slippage
                  const slipUsd = actualNotional * Math.abs(filledEntryPrice / refEntryPrice - 1);
                  if (Number.isFinite(slipUsd) && slipUsd > 0) {
                    feeBreakdown.slippageUsd += slipUsd;
                    feeBreakdown.slippageEntryUsd += slipUsd;
                  }
                }
              }

              const position = openPosition({
                id: `rsi-${++tradeCounter}`,
                side,
                price: filledEntryPrice,
                ts: entryTime,
                sizeUsd: exec.filledUsd,
                leverage,
              });

              if (position) {
                // Apply entry fees based on actual exec mode
                const openRes = feeCfg.calculateOpenFee
                  ? feeCfg.calculateOpenFee(position.sizeUsd, { execMode: entryExecMode })
                  : { fee: position.sizeUsd * (feeCfg.openFeeBps / 10_000), breakdown: {} };
                const openFee =
                  openRes.breakdown?.baseFee ??
                  openRes.fee ??
                  position.sizeUsd * (feeCfg.openFeeBps / 10_000);
                const impactFee =
                  feeCfg.model === "drift"
                    ? 0
                    : calculatePriceImpactFee(position.sizeUsd, feeCfg.priceImpactFeeScalar);
                const txFee = calculateSolanaTransactionFees(entryPrice, feeCfg);
                totalFees += openFee + impactFee + txFee;
                realisedPnl -= openFee + impactFee + txFee;

                feeBreakdown.openFees += openFee;
                feeBreakdown.impactFees += impactFee;
                feeBreakdown.txFees += txFee;

                position.entryFees = {
                  openFee,
                  impactFee,
                  txFee,
                  total: openFee + impactFee + txFee,
                  execMode: entryExecMode,
                };
                position.entryRsi = strategy.rsi; // RSI from previous bar
                position.entryAtr = Number.isFinite(strategy.atr) ? strategy.atr : null;
                position.openBarIndex = idx;
                position.entryReason = signal.reason || "rsi_signal";

                positions.push(position);

                if (trace) {
                  trace.push({
                    model: traceModel,
                    kind: "entry",
                    ts: entryTime,
                    market: marketName,
                    barIndex: idx,
                    tickIndex: 0,
                    price: entryPrice,
                    rsi: position.entryRsi,
                    atr: position.entryAtr,
                    action: "open",
                    side: position.side,
                    confidence: signal?.confidence ?? null,
                    reason: position.entryReason,
                    positionId: position.positionId || position.id,
                    fillPrice: filledEntryPrice,
                  });
                }

                if (debug) {
                  console.log(
                    `🎯 [ENTRY @ OPEN] ${side.toUpperCase()} @ $${exec.avgPrice.toFixed(2)} | RSI=${strategy.rsi?.toFixed(1)}`
                  );
                }
              }
            }
          }
        }
      }
    }

    // NOTE (production parity): do NOT update RSI/ATR for this bar until BAR CLOSE.
    // strategy.update() is performed at the end of the loop after per-tick processing.

    // Track equity (cap unrealised loss at collateral - can't lose more than you put in)
    let unrealisedPnl = 0;
    for (const pos of positions) {
      const dir = pos.side === "long" ? 1 : -1;
      const rawPnl = dir * (price - pos.entryPrice) * pos.quantity;
      const collateral = pos.collateral || pos.sizeUsd / leverage;
      // Cap loss at collateral (would be liquidated before losing more)
      unrealisedPnl += Math.max(rawPnl, -collateral);
    }
    equitySeries.push(Math.max(0, initialCapital + realisedPnl + unrealisedPnl));

    // Log indicators periodically
    if (idx >= warmupBars && idx % 50 === 0 && verbose) {
      console.log(
        `[${idx}] RSI=${strategy.rsi?.toFixed(1)} | ATR=${strategy.atr?.toFixed(4)} | Price=${price.toFixed(2)}`
      );
    }

    // Skip trading during warmup, but still run BAR CLOSE updates below to build indicators.
    const inWarmup = idx < warmupBars;

    // ============================================================
    // TICK SIMULATION (for precise RSI crossover detection)
    // ============================================================
    // Instead of just checking at bar close, simulate 5-second ticks
    // within the 1-minute candle to catch RSI crossovers at realistic levels

    let tickEntryExecuted = false;

    if (!inWarmup && simulateTicks && positions.length < maxPositions) {
      // Use 1-minute candles for more accurate tick simulation if available
      const oneMinCandles = options.oneMinCandles;
      let intraBarTicks;
      let tickInterval;

      if (oneMinCandles && oneMinCandles.length > 0) {
        // Find the 5 x 1-minute candles that make up this 5-minute bar
        const barStart = candle.openTime;
        const barEnd = candle.closeTime;
        // Fast path: use cached ticks if available
        const cachedTicks = options.ticksByBarOpenTime?.get?.(barStart);
        if (cachedTicks && cachedTicks.length > 0) {
          intraBarTicks = cachedTicks;
          tickInterval = null; // tick objects carry their own ts
        } else {
          const matchingOneMin = oneMinCandles.filter(
            (c) => c.openTime >= barStart && c.openTime < barEnd
          );
          if (matchingOneMin.length >= 4) {
            // Generate ticks from real 1-minute data (4 ticks per minute)
            intraBarTicks = [];
            for (const oneMin of matchingOneMin) {
              const minTicks = generateTicksFrom1MinCandle(oneMin);
              intraBarTicks.push(...minTicks);
            }
            tickInterval = TICK_INTERVAL_MS; // 15 seconds
            if (debug && idx === warmupBars) {
              console.log(
                `[TICK-SIM] Using ${matchingOneMin.length} x 1-min candles → ${intraBarTicks.length} ticks`
              );
            }
          } else {
            // No-lookahead rule: do NOT synthesize intra-bar ticks from 5m OHLC.
            intraBarTicks = null;
            tickInterval = null;
          }
        }
      } else {
        // No-lookahead rule: require real 1m candles for tick simulation.
        intraBarTicks = null;
        tickInterval = null;
      }

      // Track running high/low for intra-bar recalculation
      let tickHigh = candle.open;
      let tickLow = candle.open;

      if (!intraBarTicks || intraBarTicks.length === 0) {
        // Can't simulate ticks without real 1m candles.
        // Proceed with bar-close indicator update below (safe, no look-ahead).
        // Note: hard stops won't trigger intra-bar for this bar.
      } else
        for (let tickIdx = 0; tickIdx < intraBarTicks.length; tickIdx++) {
          // Handle both formats: simple price array or object with {price, ts, high, low}
          const tick = intraBarTicks[tickIdx];
          const tickPrice = typeof tick === "number" ? tick : tick.price;
          const tickTs =
            typeof tick === "number" ? candle.openTime + tickIdx * tickInterval : tick.ts;

          // Update running high/low for intra-bar tracking
          tickHigh = Math.max(tickHigh, tickPrice);
          tickLow = Math.min(tickLow, tickPrice);

          // NOTE: RSI is STATIC (bar close only) - no intra-bar recalculation
          // This matches live trading where RSI is calculated from closed bars only
          // Tick simulation is for:
          // 1. Entry price detection (get better fill after RSI signal)
          // 2. Hard stop price checks (check on every tick for existing positions)

          // ===========================================
          // HARD STOP CHECK (checked FIRST - takes priority)
          // If price has gapped past the hard stop, we still exit at the stop level.
          // This prevents "gapping through" stops where max_loss_cap would otherwise apply.
          // ===========================================
          const MAX_COLLATERAL_LOSS_PCT = 50; // 50% max loss = fallback safety cap
          const positionsToCloseOnTick = [];

          for (const pos of positions) {
            const posLeverage = pos.leverage || leverage;
            const collateral = pos.collateral || pos.sizeUsd / posLeverage;

            updateTrailingWatermarks(pos, tickPrice);

            // Calculate current unrealised PnL (for max_loss_cap fallback)
            const dir = pos.side === "long" ? 1 : -1;
            const unrealisedPnl = dir * (tickPrice - pos.entryPrice) * pos.quantity;
            const lossPct = (-unrealisedPnl / collateral) * 100;

            // ===== HARD STOP CHECK FIRST (priority over max_loss_cap) =====
            // Even if price has gapped way past the stop, exit at stop level
            if (strategy.cfg.rsiHardStopEnabled) {
              const atrForStop = Number.isFinite(pos.entryAtr) ? pos.entryAtr : strategy.atr;
              const stopDistance = computeHardStopDistance({
                entryPrice: pos.entryPrice,
                side: pos.side,
                leverage: posLeverage,
                hardStopEnabled: true,
                hardStopPercent: strategy.cfg.rsiHardStopPercent,
                hardStopAtrMult: strategy.cfg.rsiHardStopAtr,
                atr: atrForStop,
              });

              if (stopDistance) {
                if (pos.side === "short" && tickPrice >= pos.entryPrice + stopDistance) {
                  // Hard stop hit (or gapped through) - exit at WORSE of (stop level, tick price)
                  // In reality, if price gaps through your stop, you get filled at market price
                  const stopLevel = pos.entryPrice + stopDistance;
                  const realisticExitPrice = Math.max(stopLevel, tickPrice); // For shorts, higher = worse
                  positionsToCloseOnTick.push({
                    pos,
                    stopLevel,
                    realisticExitPrice,
                    tickPrice,
                    reason: "rsi_hard_stop",
                  });
                  continue; // Skip max_loss_cap check - hard stop takes priority
                } else if (pos.side === "long" && tickPrice <= pos.entryPrice - stopDistance) {
                  // Hard stop hit (or gapped through) - exit at WORSE of (stop level, tick price)
                  const stopLevel = pos.entryPrice - stopDistance;
                  const realisticExitPrice = Math.min(stopLevel, tickPrice); // For longs, lower = worse
                  positionsToCloseOnTick.push({
                    pos,
                    stopLevel,
                    realisticExitPrice,
                    tickPrice,
                    reason: "rsi_hard_stop",
                  });
                  continue; // Skip max_loss_cap check - hard stop takes priority
                }
              }
            }

            // ===== TRAILING STOP (per-tick, after hard stop) =====
            if (strategy?.cfg?.rsiEnableTrailingStop) {
              const trailingSignal = strategy.shouldClose(pos, tickPrice, idx);
              if (trailingSignal && trailingSignal.reason === "rsi_trailing_stop") {
                const trailStopPrice = Number.isFinite(trailingSignal.trailStopPrice)
                  ? trailingSignal.trailStopPrice
                  : tickPrice;
                const realisticExitPrice =
                  pos.side === "long"
                    ? Math.min(trailStopPrice, tickPrice)
                    : Math.max(trailStopPrice, tickPrice);
                positionsToCloseOnTick.push({
                  pos,
                  stopLevel: trailStopPrice,
                  realisticExitPrice,
                  tickPrice,
                  reason: "rsi_trailing_stop",
                  trailMethod: trailingSignal.trailMethod,
                });
                continue; // Skip max_loss_cap check - trailing stop takes priority
              }
            }

            // ===== MAX LOSS CAP FALLBACK (only if hard stop didn't trigger) =====
            // This is a SAFETY MECHANISM for positions WITHOUT hard stops configured,
            // or for extreme cases where hard stop wasn't set properly.
            if (lossPct >= MAX_COLLATERAL_LOSS_PCT) {
              positionsToCloseOnTick.push({
                pos,
                stopLevel: tickPrice,
                reason: "max_loss_cap",
                lossPct,
              });
            }
          }

          // Close positions that hit hard stop on this tick
          for (const {
            pos,
            stopLevel,
            realisticExitPrice,
            tickPrice: exitTickPrice,
            reason,
            trailMethod,
          } of positionsToCloseOnTick) {
            // Use realistic exit price (actual tick price if it gapped through the stop)
            // For max_loss_cap, realisticExitPrice is not set, so fall back to stopLevel (which is tickPrice)
            const actualExitPrice = realisticExitPrice ?? stopLevel;
            const exitPnl = exitPosition(pos, actualExitPrice, tickTs, { reason });

            // Hard stop = always taker (emergency exit)
            const exitExecMode = "taker";
            if (feeCfg.execMode === "maker") makerExitStats.forcedTaker++; // Emergency exit - never tries maker

            // Apply fees - use current notional value (quantity * exit price), not entry-based sizeUsd
            const currentNotional = pos.quantity * actualExitPrice;
            const closeRes = feeCfg.calculateCloseFee
              ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
              : {
                  fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                  breakdown: {
                    baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                    priceImpactFee: 0,
                  },
                };
            const closeFee = closeRes.breakdown?.baseFee ?? 0;
            const impactFee =
              feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
            const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
            const lastBorrowTs = Number.isFinite(pos.lastBorrowTs)
              ? pos.lastBorrowTs
              : pos.openTime;
            const borrowFee =
              feeCfg.model === "drift"
                ? 0
                : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, tickTs - lastBorrowTs));
            const txFee = calculateSolanaTransactionFees(tickPrice, feeCfg);
            const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;
            exitPnl.pnlUsd -= totalExitFees;
            exitPnl.fees = { closeFee, impactFee, swapFee, borrowFee, txFee, exitExecMode };
            exitPnl.exitRsi = strategy.rsi;

            if (trace) {
              trace.push({
                model: traceModel,
                kind: "exit",
                ts: tickTs,
                market: marketName,
                barIndex: idx,
                tickIndex: tickIdx,
                price: exitTickPrice ?? tickPrice,
                rsi: strategy.rsi,
                atr: strategy.atr,
                action: "close",
                side: pos.side,
                reason,
                positionId: pos.positionId || pos.id,
                fillPrice: actualExitPrice,
                stopPrice: stopLevel,
                extra: {
                  tickPrice: exitTickPrice ?? tickPrice,
                  stopLevel,
                  realisticExitPrice: actualExitPrice,
                  trailMethod: trailMethod ?? null,
                },
              });
            }
            trades.push(exitPnl);
            realisedPnl += exitPnl.pnlUsd;
            totalFees += totalExitFees;
            feeBreakdown.closeFees += closeFee;
            feeBreakdown.impactFees += impactFee;
            feeBreakdown.swapFees += swapFee;
            feeBreakdown.borrowFees += borrowFee;
            feeBreakdown.txFees += txFee;
            feeBreakdown.totalTrades++;
            const posIdx = positions.indexOf(pos);
            if (posIdx >= 0) positions.splice(posIdx, 1);
            if (debug) {
              const slippage =
                actualExitPrice !== stopLevel ? ` (slipped from $${stopLevel.toFixed(2)})` : "";
              console.log(
                `[TICK-HARD-STOP] ${pos.side} @ $${actualExitPrice.toFixed(2)}${slippage} | PnL: $${exitPnl.pnlUsd.toFixed(2)}`
              );
            }
          }

          // NOTE (production parity): RSI-based exits are NOT evaluated per tick.
          // Only hard stops can trigger intra-bar.
        }
    }

    // BAR CLOSE: update indicators for this bar (feeds next bar's decisions)
    if (parityChecks && lastBarCloseUpdatedIdx === idx) {
      throw new Error(`[PARITY] strategy.update called twice for bar idx=${idx}`);
    }
    strategy.update({
      price,
      close: candle.close,
      high: candle.high,
      low: candle.low,
      volume: candle.quoteVolume || candle.volume || 0,
      ts,
    });
    lastBarCloseUpdatedIdx = idx;

    if (trace) {
      trace.push({
        model: traceModel,
        kind: "bar_close_update",
        ts,
        market: marketName,
        barIndex: idx,
        tickIndex: ticksPerCandle - 1,
        price: candle.close,
        rsi: strategy.rsi,
        atr: strategy.atr,
        extra: { close: candle.close, high: candle.high, low: candle.low },
      });
    }

    // Check existing positions for bookkeeping only (production parity).
    // RSI exits are handled at bar open; hard stops are handled per-tick.
    for (const pos of [...positions]) {
      pos.openBarIndex = pos.openBarIndex ?? idx;
      pos.barsHeld = idx - pos.openBarIndex;

      // Update trailing stop watermarks using bar extremes (fallback when tick sim is unavailable)
      if (pos.side === "long") {
        updateTrailingWatermarks(pos, candle.high);
      } else if (pos.side === "short") {
        updateTrailingWatermarks(pos, candle.low);
      }

      // Track max favorable excursion (MFE) and max adverse excursion (MAE)
      const dir = pos.side === "long" ? 1 : -1;
      const currentPnlPct = ((dir * (price - pos.entryPrice)) / pos.entryPrice) * 100;
      pos.maxPnlPct = Math.max(pos.maxPnlPct || currentPnlPct, currentPnlPct);
      pos.minPnlPct = Math.min(pos.minPnlPct || currentPnlPct, currentPnlPct);

      // INTRA-BAR HARD STOP CHECK: Use candle high/low to detect if stop was hit
      // This ensures stop-loss orders execute at the stop price, not candle close
      // Stop is based on % of COLLATERAL, so divide by leverage for price distance
      // NOTE: When tick simulation is enabled, hard stops are checked per-tick in the tick loop above.
      // This intra-bar check is a FALLBACK for when tick simulation is disabled.
      let intraBarStopTriggered = false;
      let intraBarStopPrice = null;

      // Only check intra-bar stop if:
      // 1. Hard stop is enabled in strategy config
      // 2. Tick simulation is NOT enabled (otherwise tick loop handles it)
      const tickSimEnabled =
        options.simulateTicks !== false &&
        options.oneMinCandles &&
        options.oneMinCandles.length > 0;
      if (strategy.cfg.rsiHardStopEnabled && !tickSimEnabled) {
        const posLeverage = pos.leverage || leverage;
        const atrForStop = Number.isFinite(pos.entryAtr) ? pos.entryAtr : strategy.atr;
        const stopDistance = computeHardStopDistance({
          entryPrice: pos.entryPrice,
          side: pos.side,
          leverage: posLeverage,
          hardStopEnabled: true,
          hardStopPercent: strategy.cfg.rsiHardStopPercent,
          hardStopAtrMult: strategy.cfg.rsiHardStopAtr,
          atr: atrForStop,
        });

        if (stopDistance) {
          if (pos.side === "short") {
            const stopLevel = pos.entryPrice + stopDistance;
            if (candle.high >= stopLevel) {
              intraBarStopTriggered = true;
              intraBarStopPrice = stopLevel;
            }
          } else if (pos.side === "long") {
            const stopLevel = pos.entryPrice - stopDistance;
            if (candle.low <= stopLevel) {
              intraBarStopTriggered = true;
              intraBarStopPrice = stopLevel;
            }
          }
        }
      }

      // Production parity: ONLY hard stop exits may occur intra-bar.
      // RSI-based exits are handled at BAR OPEN only.
      if (!intraBarStopTriggered) {
        continue;
      }

      const exitSignal = {
        close: true,
        reason: "rsi_hard_stop",
        stopLoss: true,
        hardStop: true,
        stopPrice: intraBarStopPrice,
        intraBar: true,
      };

      if (exitSignal && (exitSignal.close || exitSignal.partial)) {
        if (exitSignal.partial && !pos.tookPartial) {
          // Partial exit - take 50%
          const partialQty = pos.quantity * (exitSignal.percent / 100);
          const dir = pos.side === "long" ? 1 : -1;
          const partialPnl = dir * (price - pos.entryPrice) * partialQty;

          // Apply fees
          const partialSizeUsd = partialQty * price;
          const closeExecMode = feeCfg.model === "drift" ? "taker" : "taker";
          const closeRes = feeCfg.calculateCloseFee
            ? feeCfg.calculateCloseFee(partialSizeUsd, { execMode: closeExecMode })
            : {
                fee: partialSizeUsd * (feeCfg.closeFeeBps / 10_000),
                breakdown: {
                  baseFee: partialSizeUsd * (feeCfg.closeFeeBps / 10_000),
                  priceImpactFee: 0,
                },
              };
          const closeFee = closeRes.breakdown?.baseFee ?? 0;
          const impactFee = closeRes.breakdown?.priceImpactFee ?? 0;
          const txFee = calculateSolanaTransactionFees(price, feeCfg);
          totalFees += (closeRes.fee ?? 0) + txFee;

          // Track fee breakdown
          feeBreakdown.closeFees += closeFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.txFees += txFee;

          const netPartialPnl = partialPnl - (closeRes.fee ?? 0) - txFee;
          realisedPnl += netPartialPnl;

          // Update position
          pos.quantity -= partialQty;
          pos.sizeUsd = pos.quantity * pos.entryPrice;
          pos.tookPartial = true;

          pos.fills.push({
            ts,
            price,
            quantity: partialQty,
            sizeUsd: partialSizeUsd,
            pnlUsd: netPartialPnl,
            type: "partial",
            reason: exitSignal.reason,
            rsi: strategy.rsi,
          });

          if (debug) {
            console.log(
              `[PARTIAL] ${pos.side} @ RSI=${strategy.rsi?.toFixed(1)} | PnL: $${netPartialPnl.toFixed(2)}`
            );
          }
        } else if (exitSignal.close) {
          // Full exit - use stop price if this is an intra-bar hard stop
          const exitReason = exitSignal.reason;
          let exitPrice = price;

          // For intra-bar hard stops, use the stop level instead of candle close
          // This accurately simulates a stop-loss order execution
          if (exitSignal.intraBar && exitSignal.stopPrice) {
            exitPrice = exitSignal.stopPrice;
          }

          // Determine exit mode based on reason
          const preferredExitMode = getExitExecModeForReason(exitReason, feeCfg.execMode);
          let exitExecMode = preferredExitMode;
          let filledExitPrice = exitPrice;

          // Track exit stats and simulate maker exit if applicable
          if (
            feeCfg.model === "drift" &&
            feeCfg.execMode === "maker" &&
            preferredExitMode === "maker" &&
            process.env.ENABLE_MAKER_FILL_SIM === "true"
          ) {
            makerExitStats.attempts++;
            const exitSim = simulateDriftMakerExitFill({
              market: marketName || "UNKNOWN",
              strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
              side: pos.side,
              refPrice: exitPrice,
              candle,
              positionSizeUsd: pos.sizeUsd || 0, // AUDIT FIX: Pass size for degradation
            });
            exitExecMode = exitSim.execMode;
            filledExitPrice = exitSim.fillPrice || exitPrice;
            if (exitSim.outcome === "maker_fill") makerExitStats.makerFills++;
            if (exitSim.outcome === "taker_fallback") makerExitStats.takerFallbacks++;
          } else if (preferredExitMode === "taker" && feeCfg.execMode === "maker") {
            makerExitStats.forcedTaker++; // Emergency exit - never tries maker
          }

          const pnl = exitPosition(pos, filledExitPrice, ts, { reason: exitReason });

          // Apply fees - use current notional value (quantity * exit price), not entry-based sizeUsd
          const currentNotional = pos.quantity * filledExitPrice;
          const entryNotional = pos.sizeUsd; // For comparison/debugging
          const closeRes = feeCfg.calculateCloseFee
            ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
            : {
                fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                breakdown: {
                  baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                  baseFeesBps: feeCfg.closeFeeBps,
                  priceImpactFee: 0,
                },
              };
          const closeFee = closeRes.breakdown?.baseFee ?? 0;
          const impactFee =
            feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
          const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
          const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
          const borrowFee =
            feeCfg.model === "drift"
              ? 0
              : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, ts - lastBorrowTs));
          const txFee = calculateSolanaTransactionFees(filledExitPrice, feeCfg);
          const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;
          totalFees += totalExitFees;

          // Debug: Log fee calculation if there's a significant difference
          if (debug && Math.abs(currentNotional - entryNotional) > entryNotional * 0.01) {
            const feeBps = closeRes.breakdown?.baseFeesBps ?? feeCfg.closeFeeBps;
            const feeDiff = (currentNotional - entryNotional) * (feeBps / 10_000);
            console.log(
              `[FEE-DEBUG] ${pos.side} exit: entryNotional=$${entryNotional.toFixed(2)}, currentNotional=$${currentNotional.toFixed(2)}, feeDiff=$${feeDiff.toFixed(2)}`
            );
          }

          // Track fee breakdown
          feeBreakdown.closeFees += closeFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.swapFees += swapFee;
          feeBreakdown.borrowFees += borrowFee;
          feeBreakdown.txFees += txFee;
          feeBreakdown.totalTrades++;

          pnl.pnlUsd -= totalExitFees;
          pnl.fees = { closeFee, impactFee, swapFee, borrowFee, txFee, exitExecMode };
          pnl.entryFees = pos.entryFees || { total: 0 };

          // Store exit RSI and bars held for reporting
          pnl.exitRsi = strategy.rsi;
          pnl.fills = pos.fills || [];
          pnl.barsHeld = pos.barsHeld || 0;
          pnl.maxPnlPct = pos.maxPnlPct;
          pnl.minPnlPct = pos.minPnlPct;

          // Include partial fills in total PnL
          const partialPnl = pos.fills.reduce((sum, f) => sum + (f.pnlUsd || 0), 0);
          pnl.totalPnlUsd = pnl.pnlUsd + partialPnl;

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "exit",
              ts,
              market: marketName,
              barIndex: idx,
              tickIndex: null,
              price,
              rsi: strategy.rsi,
              atr: strategy.atr,
              action: "close",
              side: pos.side,
              reason: exitSignal.reason,
              positionId: pos.positionId || pos.id,
              fillPrice: exitPrice,
              stopPrice: exitSignal?.stopPrice ?? null,
              extra: { intraBar: !!exitSignal.intraBar },
            });
          }

          realisedPnl += pnl.pnlUsd;
          positions.splice(positions.indexOf(pos), 1);
          trades.push(pnl);

          // Update equity for compounding
          currentEquity = initialCapital + realisedPnl;
          pnl.equityAfterTrade = currentEquity;
          pnl.positionSizeUsed = pos.collateral || pos.sizeUsd / leverage;

          // Track equity high/low watermarks
          maxEquity = Math.max(maxEquity, currentEquity);
          minEquity = Math.min(minEquity, currentEquity);

          if (debug || verbose) {
            const emoji = exitSignal.takeProfit ? "✅" : exitSignal.stopLoss ? "❌" : "⏰";
            console.log(
              `${emoji} [EXIT] ${pnl.side} | Reason: ${pnl.exitReason} | RSI=${strategy.rsi?.toFixed(1)} | PnL: $${pnl.totalPnlUsd?.toFixed(2) || pnl.pnlUsd.toFixed(2)}${enableCompounding ? ` | Equity: $${currentEquity.toFixed(0)}` : ""}`
            );
          }

          // Record trade in strategy
          strategy.recordTrade({
            pnlUsd: pnl.totalPnlUsd || pnl.pnlUsd,
            pnlPercent: pnl.pnlPct / 100,
            exitReason: pnl.exitReason,
          });
        }
      }
    }

    // Note: Entries are checked at bar OPEN (top of loop), not at bar close
    // This eliminates look-ahead bias while matching live bot behavior
  }

  // Force close any remaining positions at end
  for (const pos of [...positions]) {
    const lastCandle = candles[candles.length - 1];
    const price = lastCandle.close;
    const ts = lastCandle.closeTime;
    const exitReason = "end_of_backtest";

    const pnl = exitPosition(pos, price, ts, { reason: exitReason });

    // End of backtest = taker (forced close)
    const exitExecMode = getExitExecModeForReason(exitReason, "taker");
    // Track forced taker in exit stats (end of backtest = emergency close)
    if (feeCfg.execMode === "maker") makerExitStats.forcedTaker++;

    // Apply fees - use current notional value (quantity * exit price), not entry-based sizeUsd
    const currentNotional = pos.quantity * price;
    const closeRes = feeCfg.calculateCloseFee
      ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
      : { fee: currentNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
    const closeFee =
      closeRes.breakdown?.baseFee ??
      closeRes.fee ??
      currentNotional * (feeCfg.closeFeeBps / 10_000);
    const impactFee =
      feeCfg.model === "drift"
        ? 0
        : calculatePriceImpactFee(currentNotional, feeCfg.priceImpactFeeScalar);
    const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral); // Swap applies to collateral
    const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
    const borrowFee =
      feeCfg.model === "drift"
        ? 0
        : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, ts - lastBorrowTs));
    const txFee = calculateSolanaTransactionFees(price, feeCfg);

    // Funding fee (Drift only) - uses historical rates if available
    const fundingFee = calculateFundingCostForPosition(
      pos.market || marketName,
      pos.side,
      pos.sizeUsd,
      pos.openTime,
      ts
    );

    const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;
    totalFees += totalExitFees;

    // Track fee breakdown
    feeBreakdown.closeFees += closeFee;
    feeBreakdown.impactFees += impactFee;
    feeBreakdown.swapFees += swapFee;
    feeBreakdown.borrowFees += borrowFee;
    feeBreakdown.fundingFees += fundingFee;
    feeBreakdown.txFees += txFee;
    feeBreakdown.totalTrades++;

    pnl.pnlUsd -= totalExitFees;
    pnl.fees = { closeFee, impactFee, swapFee, borrowFee, fundingFee, txFee, exitExecMode };
    pnl.entryFees = pos.entryFees || { total: 0 };
    pnl.exitRsi = strategy.rsi;
    pnl.fills = pos.fills || [];

    // Include partial fills in total PnL
    const partialPnl = pos.fills.reduce((sum, f) => sum + (f.pnlUsd || 0), 0);
    pnl.totalPnlUsd = pnl.pnlUsd + partialPnl;

    realisedPnl += pnl.pnlUsd;
    trades.push(pnl);
    positions.splice(positions.indexOf(pos), 1);

    console.log(
      `⚠️  [FORCED EXIT] ${pnl.side} at end of backtest | RSI=${strategy.rsi?.toFixed(1)} | PnL: $${pnl.totalPnlUsd?.toFixed(2) || pnl.pnlUsd.toFixed(2)}`
    );
  }

  return {
    trades,
    realisedPnl,
    totalFees,
    feeBreakdown,
    equitySeries,
    initialCapital,
    makerEntryStats, // Drift maker entry fill simulation stats
    makerExitStats, // Drift maker exit fill simulation stats
    capitalStats: {
      maxEquity: isNaN(maxEquity) ? initialCapital : maxEquity,
      minEquity: isNaN(minEquity) ? initialCapital : minEquity,
      capitalViolations,
      // Use equitySeries last value if available, otherwise currentEquity, fallback to initialCapital + realisedPnl
      finalEquity:
        equitySeries.length > 0
          ? equitySeries[equitySeries.length - 1]
          : isNaN(currentEquity)
            ? initialCapital + realisedPnl
            : currentEquity,
    },
  };
}

// ============================================================
// MULTI-MARKET SHARED CAPITAL SIMULATION
// Same approach as backtest.js - unified timeline with shared capital pool
// ============================================================
function simulateMultiMarketSharedCapital(strategiesMap, candlesMap, options = {}) {
  const {
    initialCapital = 1000,
    leverage = 5,
    positionSizePercent = 75,
    enableCompounding = true,
    debug = false,
    allowLongs = true,
    allowShorts = true,
    maxPositions = 1, // Max positions across ALL markets
    ticksPerCandle = TICKS_PER_5MIN_CANDLE,
    simulateTicks = true,
    rsiHardStopAtr = 0,
    // Advanced sizing methods
    positionSizingMethod = "percent",
    riskPerTradePercent = 2, // For equal-risk: % of capital to risk per trade
    kellyFraction = 0.25, // For Kelly: use quarter-Kelly
    volatilityScaleBase = 0.02, // For volatility-scaled: target ATR %
    qualitySizeMultMin = 0.5, // For quality-weighted: min multiplier
    qualitySizeMultMax = 1.5, // For quality-weighted: max multiplier
    rsiHardStopPercent = 0, // For equal-risk sizing calculation
  } = options;

  const trace = options._trace;
  const traceModel = options._traceModel || "backtest";
  const traceMarketName = (m) => (m ? `${m}-PERP` : null);
  const parityChecks = !!options.parityChecks;
  const lastBarCloseUpdatedIdxByMarket = new Map(); // market -> last idx where strategy.update() ran

  // Optional: use the same allocator scoring model as the bot for deterministic selection.
  // Include riskRecommendation config so allocator.recommendRisk() can adjust size/leverage/stops
  const allocator =
    options.allocatorUseBotScoring !== false
      ? new MarketAllocator({
          markets: Array.from(candlesMap.keys()).map((m) => `${m}-PERP`),
          exploreProbability: options.allocatorExploreProbability ?? 0,
          riskRecommendation: {
            enabled: options.allocatorRiskEnabled ?? false,
            neutral: options.allocatorRiskNeutral ?? false,
          },
        })
      : null;

  // Fee configuration - uses FEE_MODEL env var (jupiter or drift)
  const feeCfg = buildFeeCfg();

  // ============================================================
  // HISTORICAL FUNDING RATE SUPPORT
  // ============================================================
  // If historical funding rate maps are provided, use actual hourly rates
  // Otherwise fall back to estimated average funding rate
  const fundingRateMaps = options.fundingRateMaps || null;
  // Only consider "used historical" if at least one market actually has records (non-empty map).
  const marketsWithFundingRecords = (() => {
    if (!fundingRateMaps || fundingRateMaps.size === 0) return 0;
    let n = 0;
    for (const v of fundingRateMaps.values()) {
      const m = v?.map;
      if (m && typeof m.size === "number" && m.size > 0) n++;
    }
    return n;
  })();
  const useHistoricalFunding = !!fundingRateMaps && marketsWithFundingRecords > 0;
  const fundingStats = {
    enabled: process.env.DRIFT_ENABLE_FUNDING === "true" && feeCfg.model === "drift",
    requestedHistorical: !!options.enableHistoricalFunding,
    usedHistorical: useHistoricalFunding,
    marketsRequested: fundingRateMaps ? fundingRateMaps.size : 0,
    marketsWithRecords: marketsWithFundingRecords,
  };

  // Drift funding rate estimation (enabled with DRIFT_ENABLE_FUNDING=true)
  // Uses estimated average funding rate per hour (configurable via env vars)
  // Default: 0.005% per hour = ~44% APR (typical for SOL, can be higher during rallies)
  const enableFunding = process.env.DRIFT_ENABLE_FUNDING === "true" && feeCfg.model === "drift";
  const fundingRatePctPerHour = Number(process.env.DRIFT_AVG_FUNDING_RATE_PCT_HR) || 0.005; // 0.005% default

  // Market-specific overrides: DRIFT_FUNDING_SOL=0.01 sets SOL-PERP to 0.01%/hr
  const getMarketFundingRate = (market) => {
    const normalizedMarket = market.toUpperCase().replace("-PERP", "");
    const envKey = `DRIFT_FUNDING_${normalizedMarket}`;
    const override = Number(process.env[envKey]);
    return Number.isFinite(override) ? override : fundingRatePctPerHour;
  };

  /**
   * Calculate funding cost for a position using historical data or estimated average
   * @param {string} market - Market symbol (e.g., 'SOL' or 'SOL-PERP')
   * @param {string} side - 'long' or 'short'
   * @param {number} notional - Position size in USD
   * @param {number} openTs - Position open timestamp (ms)
   * @param {number} closeTs - Position close timestamp (ms)
   * @returns {number} Funding payment (negative = paid, positive = received)
   */
  const calculateFundingCostForPosition = (market, side, notional, openTs, closeTs) => {
    if (!enableFunding) return 0;

    // Normalize market name for lookup
    const normalizedMarket = market.toUpperCase().replace("-PERP", "") + "-PERP";

    // Try to use historical funding rates if available
    if (useHistoricalFunding) {
      const marketFundingData = fundingRateMaps.get(normalizedMarket);
      if (marketFundingData && marketFundingData.map && marketFundingData.map.size > 0) {
        // Use actual historical funding rate calculation
        const result = calculateCumulativeFunding(
          marketFundingData.map,
          side,
          notional,
          openTs,
          closeTs
        );
        return result.totalFunding || 0;
      }
    }

    // Fall back to estimated average funding rate
    const durationMs = closeTs - openTs;
    const hours = durationMs / (1000 * 60 * 60);
    const fundingPeriods = Math.ceil(hours); // Funding is hourly
    const marketFundingRate = getMarketFundingRate(market);
    const rateDecimal = marketFundingRate / 100; // Convert % to decimal

    // Longs pay when rate is positive (typical), shorts receive
    // This is a simplification - in reality direction flips based on perp premium
    if (side === "long") {
      return -notional * rateDecimal * fundingPeriods; // Negative = paying
    } else {
      return notional * rateDecimal * fundingPeriods; // Positive = receiving (shorts get paid)
    }
  };

  // Legacy wrapper for backwards compatibility
  const estimateFundingCost = (side, notional, durationMs, fundingRate) => {
    if (!enableFunding) return 0;
    const hours = durationMs / (1000 * 60 * 60);
    const fundingPeriods = Math.ceil(hours); // Funding is hourly
    const rateDecimal = fundingRate / 100; // Convert % to decimal

    if (side === "long") {
      return -notional * rateDecimal * fundingPeriods; // Negative = paying
    } else {
      return notional * rateDecimal * fundingPeriods; // Positive = receiving (shorts get paid)
    }
  };

  // ============================================================
  // MARGIN/LIQUIDATION SIMULATION
  // ============================================================
  // Drift liquidation is based on per-market maintenance margin ratios, and an IMF factor that
  // increases margin requirements as notional gets larger (reducing effective max leverage).
  // Source table (updated hourly from on-chain state): https://docs.drift.trade/trading/margin
  const enableLiquidationCheck = options.enableLiquidationCheck !== false;
  const DEFAULT_MAINT_RATIO_FALLBACK =
    (Number(process.env.DRIFT_MAINTENANCE_MARGIN_PCT) || 5) / 100;

  const getMaintRatio = (market, notionalUsd) => {
    const eff = getEffectiveMarginRatios(market, notionalUsd);
    const r = eff?.maintenanceMarginRatio;
    return Number.isFinite(r) && r > 0 ? r : DEFAULT_MAINT_RATIO_FALLBACK;
  };

  const getInitRatio = (market, notionalUsd) => {
    const eff = getEffectiveMarginRatios(market, notionalUsd);
    const r = eff?.initialMarginRatio;
    // Fallback: initial ratio ≈ 1/leverage if doc params missing
    if (Number.isFinite(r) && r > 0) return r;
    const lev = Math.max(1, Number.isFinite(options.leverage) ? options.leverage : leverage);
    return Math.min(1, 1 / lev);
  };

  /**
   * Check if position would be liquidated at current price
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @returns {boolean} True if position would be liquidated
   */
  const isPositionLiquidated = (position, currentPrice) => {
    if (!enableLiquidationCheck) return false;
    if (!position || !Number.isFinite(currentPrice) || currentPrice <= 0) return false;

    const qty = Number(position.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return false;
    const notional = qty * currentPrice;

    const dir = position.side === "long" ? 1 : -1;
    const rawPnl = dir * (currentPrice - position.entryPrice) * qty;
    const collateral = Number.isFinite(position.collateral)
      ? position.collateral
      : Number.isFinite(position.sizeUsd)
        ? position.sizeUsd / (position.leverage || leverage)
        : 0;
    const equity = Math.max(0, collateral + rawPnl); // Drift liquidates before equity goes negative

    const maintRatio = getMaintRatio(
      position.market ||
        position.marketKey ||
        position.symbol ||
        position.marketIndex ||
        position.marketName ||
        position.market,
      notional
    );
    const maintReq = maintRatio * notional;
    return equity < maintReq;
  };

  // Track liquidation events
  let liquidationCount = 0;
  let liquidationLoss = 0;
  let liquidationOtherFees = 0;
  let partialLiquidationCount = 0;
  let partialLiquidationNotionalUsd = 0;
  let partialLiquidationFeesUsd = 0;

  // Global state - shared across all markets
  const allTrades = [];
  const allPositions = []; // Positions across ALL markets
  const equitySeries = [];
  let realisedPnl = 0;
  let totalFees = 0;
  let tradeCounter = 0;

  // Detailed fee tracking
  const feeBreakdown = {
    openFees: 0,
    closeFees: 0,
    impactFees: 0,
    swapFees: 0, // USDC ↔ Asset swap fees (on collateral)
    borrowFees: 0, // Borrow/funding fees (hourly) - Jupiter
    fundingFees: 0, // Funding rate fees (hourly) - Drift perps
    slippageUsd: 0, // Execution slippage cost (USD). NOT a protocol fee; computed from fill vs ref.
    slippageEntryUsd: 0,
    slippageExitUsd: 0,
    txFees: 0,
    // Drift other fees (typically on liquidation events)
    liquidatorFees: 0,
    insuranceFees: 0,
    totalTrades: 0,
  };

  // Drift maker realism: track maker fills vs taker fallbacks vs no-fills
  const makerEntryStats = { attempts: 0, makerFills: 0, takerFallbacks: 0, noFills: 0 };
  const makerExitStats = {
    attempts: 0,
    makerFills: 0,
    takerFallbacks: 0,
    forcedTaker: 0,
    noFills: 0,
  };

  // Circuit breaker state - track consecutive losses and cooldown per market
  // MUST be defined before the market loop that initializes it
  const circuitBreakerState = new Map(); // market -> { consecutiveLosses, cooldownUntil, triggered }
  const cbMaxLosses = options.circuitBreakerMaxLosses || 3;
  const cbCooldownMs = options.circuitBreakerCooldownMs || 180000;
  const cbEnabled = options.circuitBreakerEnabled !== false;
  let cbTriggeredCount = 0; // Total times circuit breaker was triggered
  let cbSkippedEntries = 0; // Entries skipped due to circuit breaker
  // Aggregate circuit breaker logs to reduce noise
  const cbActivationCounts = new Map(); // market -> count
  const cbExpirationCounts = new Map(); // market -> count

  // Allocator stats tracking
  const allocatorStats = {
    totalSignalsGenerated: 0, // Total open signals across all ticks
    totalSignalsAccepted: 0, // Signals that resulted in trades
    totalSignalsRejected: 0, // Signals rejected by allocator
    totalSignalsBlockedCB: 0, // Signals blocked by circuit breaker
    totalSignalsBlockedCapacity: 0, // Signals blocked by max positions
    concurrentSignalTicks: 0, // Ticks where >1 signal was present
    maxConcurrentSignals: 0, // Maximum signals at any tick
    concurrentSignalHist: {}, // Histogram: { count: occurrences }
    rejectedSignalsPnL: [], // Track hypothetical P&L of rejected signals
    selectedVsRejectedWins: { selectedWins: 0, rejectedWouldWin: 0 }, // Quality tracking
    byMarket: new Map(), // Per-market signal stats
  };

  // Per-market results tracking
  const marketResults = new Map();
  for (const market of candlesMap.keys()) {
    marketResults.set(market, {
      trades: [],
      totalPnL: 0,
      totalFees: 0,
    });
    // Initialize circuit breaker state for each market
    circuitBreakerState.set(market, {
      consecutiveLosses: 0,
      cooldownUntil: 0,
      triggered: false,
    });
  }

  // Capital tracking
  let maxEquity = initialCapital;
  let minEquity = initialCapital;
  // Counts times we would have exceeded available capital if we didn't enforce clamps/skips.
  // This should ideally stay at 0 after the sizing rules below (min-size skip + % of available sizing).
  let capitalViolations = 0;

  // Concurrent position tracking
  let maxConcurrentPositions = 0;
  let maxCollateralInUse = 0;
  let concurrentPositionCounts = []; // Track counts over time

  // Note: No look-ahead bias because RSI is updated at bar START (from previous bar's close)
  // and entries happen at current bar's OPEN - matching live bot behavior

  // Get locked collateral (across ALL markets)
  const getLockedCollateral = () => {
    return allPositions.reduce((sum, pos) => sum + (pos.collateral || 0), 0);
  };

  // Calculate available capital (shared pool)
  const getAvailableCapital = (currentPrices) => {
    const lockedCollateral = getLockedCollateral();
    const baseCapital = enableCompounding ? initialCapital + realisedPnl : initialCapital;
    // IMPORTANT: Compounding is REALISED-only.
    // Available collateral increases only after trades are CLOSED and PnL is realised.
    // We do NOT use unrealised PnL to fund new entries.
    return Math.max(0, baseCapital - lockedCollateral);
  };

  // ============================================================
  // POSITION SIZING METHODS
  // ============================================================
  // Supports: 'percent' | 'equal-risk' | 'kelly' | 'volatility-scaled' | 'quality-weighted'
  //
  // Each method calculates collateral (not notional) to allocate per trade.
  // The sizing context includes market data for adaptive sizing.

  /**
   * Calculate position size using the configured sizing method
   * @param {number} availableCapital - Available capital for new positions
   * @param {Object} context - Sizing context with market-specific data
   * @param {number} context.atr - Current ATR for the market
   * @param {number} context.price - Current price
   * @param {number} context.hardStopPct - Hard stop % for equal-risk calculation
   * @param {number} context.confidence - Signal confidence (0-1)
   * @param {number} context.winRate - Historical win rate for Kelly
   * @param {number} context.avgWin - Average win $ for Kelly
   * @param {number} context.avgLoss - Average loss $ for Kelly
   * @param {number} context.leverage - Leverage multiplier
   * @returns {number} Position size (collateral) in USD
   */
  const getPositionSize = (availableCapital, context = {}) => {
    const method = positionSizingMethod;
    const minSize = options.minPositionSize || 50;
    const maxSize = options.maxPositionSize || 5000;
    const effectiveLeverage = context.leverage || leverage;

    // For most methods: use allocator-adjusted sizePct directly (avoids post-multiply overshoot).
    // For volatility-scaled: use BASE percent for volatility calc, then post-multiply by allocator factor.
    const allocatorSizePctOverride = context.positionSizePercentOverride;
    const hasAllocatorOverride =
      Number.isFinite(allocatorSizePctOverride) && allocatorSizePctOverride > 0;

    // For volatility-scaled, we want: volatility_size × allocator_multiplier
    // So we calculate the multiplier as (allocator sizePct / base sizePct)
    const allocatorMultiplier =
      hasAllocatorOverride && positionSizePercent > 0
        ? allocatorSizePctOverride / positionSizePercent
        : 1.0;

    // For non-volatility methods, use the override directly
    const sizingPct = hasAllocatorOverride ? allocatorSizePctOverride : positionSizePercent;

    let baseSize;

    switch (method) {
      case "equal-risk": {
        // Equal-Risk Sizing: Risk a fixed % of capital per trade
        // Size = (Capital × RiskPct) / (StopDistance × Leverage)
        // This ensures each trade risks the same dollar amount
        const riskAmount = availableCapital * (riskPerTradePercent / 100);

        // Determine stop distance
        // Priority: 1) ATR-based if configured, 2) percent-based, 3) fallback 5%
        let stopDistancePct = 5; // Fallback
        let stopSource = "fallback";

        // Check for ATR-based stop first (preferred for volatility-adaptive sizing)
        const atrStopMult = options.rsiHardStopAtr || rsiHardStopAtr || 0;
        if (atrStopMult > 0 && context.atr && context.price && context.atr > 0) {
          const atrStopPct = ((context.atr * atrStopMult) / context.price) * 100;
          if (atrStopPct > 0) {
            stopDistancePct = atrStopPct;
            stopSource = `ATR(${atrStopMult}x)`;
          }
        }

        // If no ATR stop, use percent-based
        if (stopSource === "fallback") {
          const pctStop = context.hardStopPct || rsiHardStopPercent || 0;
          if (pctStop > 0) {
            stopDistancePct = pctStop;
            stopSource = "percent";
          }
        }

        // Calculate collateral needed to risk exactly riskAmount
        // If stop is hit: loss = collateral × stopDistancePct% × leverage
        // So: riskAmount = collateral × (stopDistancePct/100) × leverage
        // Therefore: collateral = riskAmount / (stopDistancePct/100 × leverage)
        const stopFactor = (stopDistancePct / 100) * effectiveLeverage;
        baseSize = stopFactor > 0 ? riskAmount / stopFactor : availableCapital * (sizingPct / 100);

        if (debug || process.env.DEBUG_SIZING === "true") {
          console.log(
            `[SIZING] equal-risk: risk=$${riskAmount.toFixed(0)}, stop=${stopDistancePct.toFixed(1)}% (${stopSource}), lev=${effectiveLeverage}x → size=$${baseSize.toFixed(0)}`
          );
        }
        break;
      }

      case "kelly": {
        // Kelly Criterion: Optimal sizing based on edge
        // Full Kelly: f* = (p × b - q) / b
        // Where: p = win rate, q = 1-p, b = avg_win / avg_loss
        // We use fractional Kelly (typically 1/4) for safety

        // Use historical stats if available, otherwise estimate from config
        const winRate = context.winRate || 0.65; // Default 65% WR
        const avgWin = context.avgWin || 100;
        const avgLoss = context.avgLoss || 80;

        const p = winRate;
        const q = 1 - p;
        const b = avgLoss > 0 ? avgWin / avgLoss : 1;

        // Kelly fraction
        let kellyF = (p * b - q) / b;
        kellyF = Math.max(0, Math.min(kellyF, 1)); // Clamp 0-1

        // Apply fractional Kelly for safety
        const effectiveKelly = kellyF * kellyFraction;
        baseSize = availableCapital * effectiveKelly;

        if (debug) {
          console.log(
            `[SIZING] kelly: WR=${(p * 100).toFixed(0)}%, b=${b.toFixed(2)}, f*=${(kellyF * 100).toFixed(1)}% → ${(effectiveKelly * 100).toFixed(1)}% → size=$${baseSize.toFixed(0)}`
          );
        }
        break;
      }

      case "volatility-scaled": {
        // Volatility-Scaled: Size inversely proportional to ATR
        // In calm markets (low ATR) → larger positions
        // In volatile markets (high ATR) → smaller positions
        // Target: base position when ATR% = volatilityScaleBase
        //
        // IMPORTANT: Use BASE positionSizePercent for volatility calculation,
        // then apply allocator multiplier as POST-MULTIPLY (user requirement).
        // Final result is still capped at availableCapital.

        const basePercent = positionSizePercent / 100; // Use config base, NOT allocator-adjusted

        if (context.atr && context.price && context.atr > 0) {
          const atrPercent = context.atr / context.price;
          const scaleFactor = volatilityScaleBase / Math.max(atrPercent, 0.001);

          // Clamp scale factor to reasonable range (0.5x to 2x)
          const clampedScale = Math.max(0.5, Math.min(2.0, scaleFactor));

          // Calculate volatility-scaled size, then apply allocator multiplier as post-multiply
          const volScaledSize = availableCapital * basePercent * clampedScale;
          baseSize = volScaledSize * allocatorMultiplier;

          if (debug || process.env.DEBUG_SIZING === "true") {
            console.log(
              `[SIZING] volatility-scaled: ATR%=${(atrPercent * 100).toFixed(2)}%, volScale=${clampedScale.toFixed(2)}, allocMult=${allocatorMultiplier.toFixed(2)} → size=$${baseSize.toFixed(0)}`
            );
          }
        } else {
          // Fallback to percent-based if no ATR (still apply allocator multiplier)
          baseSize = availableCapital * basePercent * allocatorMultiplier;
        }
        break;
      }

      case "quality-weighted": {
        // Quality-Weighted: Scale size by signal confidence
        // High confidence signals → larger positions
        // Low confidence signals → smaller positions

        const basePercent = sizingPct / 100;
        const confidence = context.confidence || 0.5; // Default to neutral

        // Map confidence (0-1) to size multiplier range
        const multRange = qualitySizeMultMax - qualitySizeMultMin;
        const sizeMult = qualitySizeMultMin + confidence * multRange;

        baseSize = availableCapital * basePercent * sizeMult;

        if (debug) {
          console.log(
            `[SIZING] quality-weighted: conf=${(confidence * 100).toFixed(0)}%, mult=${sizeMult.toFixed(2)} → size=$${baseSize.toFixed(0)}`
          );
        }
        break;
      }

      case "percent":
      default: {
        // Standard percent-of-capital sizing
        baseSize = availableCapital * (sizingPct / 100);
        break;
      }
    }

    // Apply min/max constraints
    baseSize = Math.max(baseSize, minSize);
    baseSize = Math.min(baseSize, maxSize);

    // Final check - never exceed available capital
    if (baseSize > availableCapital) {
      capitalViolations++;
      baseSize = Math.max(0, availableCapital * 0.95);
    }

    return baseSize;
  };

  // Get unified timeline from all markets
  const allTimestamps = new Set();
  for (const [market, candles] of candlesMap.entries()) {
    for (const candle of candles) {
      allTimestamps.add(candle.closeTime);
    }
  }
  const timestamps = Array.from(allTimestamps).sort((a, b) => a - b);

  // Create index maps for fast candle lookup
  const candleIndexMaps = new Map();
  for (const [market, candles] of candlesMap.entries()) {
    const indexMap = new Map();
    candles.forEach((candle, idx) => indexMap.set(candle.closeTime, idx));
    candleIndexMaps.set(market, indexMap);
  }

  // Tick simulation settings - ticksPerCandle already extracted from options above
  const effectiveTicksPerCandle = simulateTicks ? ticksPerCandle : 1;

  // Sizing method description
  const sizingDesc = {
    percent: `${positionSizePercent}% of available capital`,
    "equal-risk": `${riskPerTradePercent}% risk per trade (stop=${rsiHardStopPercent}%)`,
    kelly: `Kelly criterion (${(kellyFraction * 100).toFixed(0)}% fraction)`,
    "volatility-scaled": `volatility-scaled (target ${(volatilityScaleBase * 100).toFixed(1)}% ATR)`,
    "quality-weighted": `quality-weighted (${qualitySizeMultMin.toFixed(1)}x-${qualitySizeMultMax.toFixed(1)}x)`,
  };

  // Debug: verify sizing params are received
  if (process.env.DEBUG_SIZING === "true") {
    console.log(
      `[DEBUG_SIZING] method=${positionSizingMethod}, pct=${positionSizePercent}%, risk=${riskPerTradePercent}%, kelly=${kellyFraction}, volBase=${volatilityScaleBase}, hardStop=${rsiHardStopPercent}%`
    );
  }

  console.log(`\n📊 Multi-Market Shared Capital Simulation`);
  console.log(`   Markets: ${Array.from(candlesMap.keys()).join(", ")}`);
  console.log(`   Timeline: ${timestamps.length} unified timestamps`);
  console.log(
    `   Tick Simulation: ${simulateTicks ? `${effectiveTicksPerCandle} ticks/candle` : "disabled"}`
  );
  console.log(`   Entry Timing: BAR OPEN (RSI from prev bar, entry at open - no look-ahead)`);
  console.log(`   Initial Capital: $${initialCapital} (SHARED across all markets)`);
  console.log(
    `   Sizing Method: ${positionSizingMethod} - ${sizingDesc[positionSizingMethod] || sizingDesc["percent"]}`
  );
  console.log(`   Leverage: ${leverage}x`);
  console.log(`   Max Positions: ${maxPositions} (across all markets)\n`);

  // Track current prices for all markets
  const currentPrices = new Map();

  // Main loop: iterate through unified timeline
  for (let idx = 0; idx < timestamps.length; idx++) {
    const ts = timestamps[idx];

    // Get candles for all markets at this timestamp
    const marketCandles = new Map();
    for (const [market, candles] of candlesMap.entries()) {
      const indexMap = candleIndexMaps.get(market);
      if (!indexMap.has(ts)) continue;
      const candleIdx = indexMap.get(ts);
      const candle = candles[candleIdx];
      if (candle) marketCandles.set(market, candle);
    }

    // ============================================================
    // RSI EXITS AT BAR OPEN (production parity)
    // - RSI updated from previous bar close
    // - Execute RSI exits at bar open price
    // ============================================================
    if (idx > 0 && allPositions.length > 0) {
      const toClose = [];
      for (const pos of allPositions) {
        const candle = marketCandles.get(pos.market);
        const strategy = strategiesMap.get(pos.market);
        if (!candle || !strategy) continue;
        if (!Number.isFinite(strategy.rsi)) continue;

        const sig = strategy.shouldClose(pos, candle.open);
        if (!sig) continue;
        if (sig.reason === "rsi_hard_stop") continue; // per-tick only
        if (!sig.close) continue; // partial is disabled in current configs

        toClose.push({ pos, market: pos.market, candle, strategy, reason: sig.reason });
      }

      for (const { pos, market, candle, strategy, reason } of toClose) {
        const posIdx = allPositions.indexOf(pos);
        if (posIdx === -1) continue;
        allPositions.splice(posIdx, 1);

        const exitTs = candle.openTime;
        const exitPrice = candle.open;
        const marketLeverage = options.perMarketLeverage?.get(market) || leverage;
        const dir = pos.side === "long" ? 1 : -1;
        // NOTE: grossPnl will be recalculated after slippage is applied to filledExitPrice

        // Determine exit exec mode based on reason
        const preferredExitMode = getExitExecModeForReason(reason, feeCfg.execMode);
        let exitExecMode = preferredExitMode;
        let filledExitPrice = exitPrice;

        // Simulate maker exit if applicable
        if (
          feeCfg.model === "drift" &&
          feeCfg.execMode === "maker" &&
          preferredExitMode === "maker" &&
          process.env.ENABLE_MAKER_FILL_SIM === "true"
        ) {
          makerExitStats.attempts++;
          const exitSim = simulateDriftMakerExitFill({
            market: `${market}-PERP`,
            strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
            side: pos.side,
            refPrice: exitPrice,
            candle: candle || { high: exitPrice, low: exitPrice, close: exitPrice },
            positionSizeUsd: pos.sizeUsd || 0, // AUDIT FIX: Pass size for degradation
          });
          exitExecMode = exitSim.execMode;
          filledExitPrice = exitSim.fillPrice || exitPrice;
          if (exitSim.outcome === "maker_fill") makerExitStats.makerFills++;
          if (exitSim.outcome === "taker_fallback") {
            makerExitStats.takerFallbacks++;
            // Apply and track slippage for taker fallback
            const refExitPrice = filledExitPrice;
            filledExitPrice = applyTakerExitSlippage(
              filledExitPrice,
              pos.side,
              pos.quantity * filledExitPrice,
              market,
              strategy?.atr || pos.entryAtr,
              pos.entryPrice
            );
            if (
              Number.isFinite(refExitPrice) &&
              refExitPrice > 0 &&
              Number.isFinite(filledExitPrice)
            ) {
              const notional = pos.quantity * refExitPrice;
              const slipUsd = notional * Math.abs(filledExitPrice / refExitPrice - 1);
              if (Number.isFinite(slipUsd) && slipUsd > 0) {
                feeBreakdown.slippageUsd += slipUsd;
                feeBreakdown.slippageExitUsd += slipUsd;
              }
            }
          }
        } else if (preferredExitMode === "taker" && feeCfg.execMode === "maker") {
          makerExitStats.takerFallbacks++;
          // Apply and track slippage for forced taker exit
          const refExitPrice = filledExitPrice;
          filledExitPrice = applyTakerExitSlippage(
            filledExitPrice,
            pos.side,
            pos.quantity * filledExitPrice,
            market,
            strategy?.atr || pos.entryAtr,
            pos.entryPrice
          );
          if (
            Number.isFinite(refExitPrice) &&
            refExitPrice > 0 &&
            Number.isFinite(filledExitPrice)
          ) {
            const notional = pos.quantity * refExitPrice;
            const slipUsd = notional * Math.abs(filledExitPrice / refExitPrice - 1);
            if (Number.isFinite(slipUsd) && slipUsd > 0) {
              feeBreakdown.slippageUsd += slipUsd;
              feeBreakdown.slippageExitUsd += slipUsd;
            }
          }
        } else if (preferredExitMode === "taker") {
          // Pure taker mode - apply and track slippage
          exitExecMode = "taker";
          const refExitPrice = filledExitPrice;
          filledExitPrice = applyTakerExitSlippage(
            filledExitPrice,
            pos.side,
            pos.quantity * filledExitPrice,
            market,
            strategy?.atr || pos.entryAtr,
            pos.entryPrice
          );
          if (
            Number.isFinite(refExitPrice) &&
            refExitPrice > 0 &&
            Number.isFinite(filledExitPrice)
          ) {
            const notional = pos.quantity * refExitPrice;
            const slipUsd = notional * Math.abs(filledExitPrice / refExitPrice - 1);
            if (Number.isFinite(slipUsd) && slipUsd > 0) {
              feeBreakdown.slippageUsd += slipUsd;
              feeBreakdown.slippageExitUsd += slipUsd;
            }
          }
        }

        // Calculate gross P&L using the SLIPPED exit price (filledExitPrice includes slippage)
        const grossPnl = dir * (filledExitPrice - pos.entryPrice) * pos.quantity;

        const currentNotional = pos.quantity * filledExitPrice;
        const closeRes = feeCfg.calculateCloseFee
          ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
          : { fee: (currentNotional * feeCfg.closeFeeBps) / 10000, breakdown: {} };
        const closeFee =
          closeRes.breakdown?.baseFee ??
          closeRes.fee ??
          (currentNotional * feeCfg.closeFeeBps) / 10000;
        // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
        const impactFee = feeCfg.model === "drift" ? 0 : calculatePriceImpactFee(currentNotional);
        const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
        const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
        const borrowFee =
          feeCfg.model === "drift"
            ? 0
            : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, exitTs - lastBorrowTs));
        const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;

        // Funding fee (Drift only) - uses historical rates if available
        const fundingFee = calculateFundingCostForPosition(
          market,
          pos.side,
          pos.sizeUsd,
          pos.openTime,
          exitTs
        );

        const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;

        const netPnl = grossPnl - totalExitFees;
        realisedPnl += netPnl;
        feeBreakdown.fundingFees += fundingFee;
        totalFees += totalExitFees;
        feeBreakdown.closeFees += closeFee;
        feeBreakdown.impactFees += impactFee;
        feeBreakdown.swapFees += swapFee;
        feeBreakdown.borrowFees += borrowFee;
        feeBreakdown.txFees += txFee;
        feeBreakdown.totalTrades++;

        const balanceAfterClose = initialCapital + realisedPnl;

        const trade = {
          id: pos.id,
          market,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: filledExitPrice, // Use slipped exit price
          entryRsi: pos.entryRsi,
          exitRsi: strategy.rsi,
          openTime: pos.openTime,
          exitTime: exitTs,
          sizeUsd: pos.sizeUsd,
          quantity: pos.quantity,
          leverage: marketLeverage,
          collateral: pos.collateral,
          grossPnl,
          pnlUsd: netPnl,
          totalPnlUsd: netPnl,
          pnlPct: (netPnl / pos.collateral) * 100,
          exitReason: reason,
          entryFee: pos.entryFee || 0,
          exitFee: totalExitFees,
          balanceAfterClose,
        };

        if (trace) {
          trace.push({
            model: traceModel,
            kind: "exit",
            ts: exitTs,
            market: traceMarketName(market),
            barIndex: idx,
            tickIndex: 0,
            price: exitPrice,
            rsi: strategy.rsi,
            atr: strategy.atr,
            action: "close",
            side: pos.side,
            reason,
            positionId: pos.id,
            fillPrice: exitPrice,
          });
        }

        allTrades.push(trade);
        marketResults.get(market).trades.push(trade);
        marketResults.get(market).totalPnL += netPnl;
        marketResults.get(market).totalFees += totalExitFees;
        strategy.recordTrade(trade);
      }
    }

    // Generate tick prices for all markets (NO LOOK-AHEAD):
    // Use real 1m candles → 15s ticks. Never synthesize from 5m OHLC.
    const marketTicks = new Map();
    const oneMinCandlesMap = options.oneMinCandlesMap;
    const ticksByBarOpenTimeMap = options.ticksByBarOpenTimeMap;
    if (simulateTicks) {
      if (!oneMinCandlesMap || !(oneMinCandlesMap instanceof Map)) {
        throw new Error("[NO-LOOKAHEAD] simulateTicks requested but oneMinCandlesMap not provided");
      }
      for (const [market, candle] of marketCandles.entries()) {
        const barStart = candle.openTime;
        const cached =
          ticksByBarOpenTimeMap instanceof Map
            ? ticksByBarOpenTimeMap.get(market)?.get(barStart)
            : null;
        if (cached && cached.length > 0) {
          marketTicks.set(market, cached);
          continue;
        }
        // Fallback (slower): derive from 1m candles in-memory
        const oneMin = oneMinCandlesMap.get(market) || [];
        const matchingOneMin = oneMin.filter(
          (c) => c.openTime >= candle.openTime && c.openTime < candle.closeTime
        );
        if (matchingOneMin.length >= 4) {
          marketTicks.set(market, generateTicksFrom1MinCandles(matchingOneMin));
        } else {
          // Graceful fallback for incomplete 1m data (e.g., at fold boundaries)
          // Use OHLC interpolation instead of failing
          marketTicks.set(market, generateTicksFromOHLC(candle));
        }
      }
    } else {
      for (const [market, candle] of marketCandles.entries()) {
        marketTicks.set(market, [{ price: candle.close, ts: candle.closeTime }]);
      }
    }

    // ============================================================
    // ENTRY CHECK AT BAR OPEN (using RSI from PREVIOUS bar - no look-ahead)
    // This matches live bot behavior:
    //   1. Previous bar closes → RSI updated
    //   2. Signal check happens immediately
    //   3. Entry at current bar's OPEN price
    // ============================================================
    if (allPositions.length < maxPositions && idx > 0) {
      // Collect all eligible signals first, then apply deterministic ranking/tie-breaks.
      const candidates = [];

      for (const [market, candle] of marketCandles.entries()) {
        const strategy = strategiesMap.get(market);
        if (!strategy) continue;

        // RSI was updated from PREVIOUS bar (in previous iteration)
        if (!Number.isFinite(strategy.rsi)) continue;

        if (parityChecks) {
          const lastIdx = lastBarCloseUpdatedIdxByMarket.get(market);
          if (Number.isFinite(lastIdx) && lastIdx !== idx - 1) {
            throw new Error(
              `[PARITY] Illegal entry sequencing for ${market} at bar ${idx}: expected last bar-close update idx=${idx - 1}, got ${lastIdx}`
            );
          }
        }

        // Skip if already have a position in this market
        const hasPositionInMarket = allPositions.some((p) => p.market === market);
        if (hasPositionInMarket) continue;

        const entryPrice = candle.open;
        const entryTime = candle.openTime;

        const signal = strategy.getSignal(entryPrice, []);
        if (trace) {
          trace.push({
            model: traceModel,
            kind: "signal",
            ts: entryTime,
            market: traceMarketName(market),
            barIndex: idx,
            tickIndex: 0,
            price: entryPrice,
            rsi: strategy.rsi,
            atr: strategy.atr,
            action: signal?.action ?? null,
            side: signal?.side ?? null,
            confidence: signal?.confidence ?? null,
            reason: signal?.reason ?? null,
          });
        }
        if (!signal || signal.action !== "open") continue;

        const marketAllowLongs = options.perMarketAllowLongs?.get(market) ?? allowLongs;
        const marketAllowShorts = options.perMarketAllowShorts?.get(market) ?? allowShorts;
        if (signal.side === "long" && !marketAllowLongs) continue;
        if (signal.side === "short" && !marketAllowShorts) continue;

        candidates.push({ market, candle, strategy, entryPrice, entryTime, signal });
      }

      if (candidates.length > 0) {
        // Track concurrent signals stats
        allocatorStats.totalSignalsGenerated += candidates.length;
        if (candidates.length > 1) {
          allocatorStats.concurrentSignalTicks++;
          allocatorStats.maxConcurrentSignals = Math.max(
            allocatorStats.maxConcurrentSignals,
            candidates.length
          );
          allocatorStats.concurrentSignalHist[candidates.length] =
            (allocatorStats.concurrentSignalHist[candidates.length] || 0) + 1;
        }
        // Track per-market signal generation
        for (const cand of candidates) {
          const mkt = traceMarketName(cand.market);
          if (!allocatorStats.byMarket.has(mkt)) {
            allocatorStats.byMarket.set(mkt, {
              generated: 0,
              accepted: 0,
              rejected: 0,
              blockedCB: 0,
              blockedCapacity: 0,
            });
          }
          allocatorStats.byMarket.get(mkt).generated++;
        }

        // Rank candidates deterministically
        let ordered = candidates.slice();
        let rejectedCandidates = []; // Track rejected for opportunity cost analysis

        if (allocator) {
          const positionsForAllocator = allPositions.map((p) => ({
            ...p,
            market: traceMarketName(p.market),
          }));
          const allMarketSignals = candidates.map((c) => ({
            market: traceMarketName(c.market),
            signal: { ...c.signal, strategyType: "rsi-reversion" },
            priceData: { price: c.entryPrice, atr: c.strategy?.atr },
          }));

          const ranked = allocator.evaluateOpportunities(
            allMarketSignals,
            positionsForAllocator,
            {},
            new Map()
          );
          ranked.sort((a, b) => {
            const ds = (b.score ?? 0) - (a.score ?? 0);
            if (ds !== 0) return ds;
            const dm = String(a.market).localeCompare(String(b.market));
            if (dm !== 0) return dm;
            return String(a.signal?.side).localeCompare(String(b.signal?.side));
          });

          const selected = allocator.selectBestOpportunities(
            ranked,
            maxPositions,
            positionsForAllocator
          );
          const selectedMarkets = new Set(selected.map((s) => s.market));

          // Identify rejected candidates (ranked but not selected)
          for (const r of ranked) {
            if (!selectedMarkets.has(r.market)) {
              const cand = candidates.find((c) => traceMarketName(c.market) === r.market);
              if (cand) {
                rejectedCandidates.push({
                  ...cand,
                  _allocatorScore: r.score,
                  _rejectionReason: "outranked",
                });
                allocatorStats.totalSignalsRejected++;
                const mkt = traceMarketName(cand.market);
                if (allocatorStats.byMarket.has(mkt)) allocatorStats.byMarket.get(mkt).rejected++;
              }
            }
          }

          ordered = selected
            .map((s) => {
              const cand = candidates.find((c) => traceMarketName(c.market) === s.market);
              if (cand) cand._allocatorScore = s.score; // Preserve allocator score for risk recommendation
              return cand;
            })
            .filter(Boolean);
        } else {
          ordered.sort((a, b) => {
            const ca = Number.isFinite(a.signal?.confidence) ? a.signal.confidence : 0;
            const cb = Number.isFinite(b.signal?.confidence) ? b.signal.confidence : 0;
            const dc = cb - ca;
            if (dc !== 0) return dc;
            const dm = String(a.market).localeCompare(String(b.market));
            if (dm !== 0) return dm;
            return String(a.signal?.side).localeCompare(String(b.signal?.side));
          });
        }

        for (const cand of ordered) {
          if (allPositions.length >= maxPositions) break;

          const { market, candle, strategy, entryPrice, entryTime, signal } = cand;

          // Circuit breaker check - skip entry if market is in cooldown
          if (cbEnabled) {
            const cbState = circuitBreakerState.get(market);
            if (cbState && cbState.triggered) {
              if (entryTime < cbState.cooldownUntil) {
                // Still in cooldown - skip this entry
                cbSkippedEntries++;
                allocatorStats.totalSignalsBlockedCB++;
                const mkt = traceMarketName(market);
                if (allocatorStats.byMarket.has(mkt)) allocatorStats.byMarket.get(mkt).blockedCB++;
                if (debug) {
                  const cooldownRemaining = Math.round((cbState.cooldownUntil - entryTime) / 1000);
                  console.log(
                    `⏸️ [${market}] CIRCUIT BREAKER: Skipping entry, ${cooldownRemaining}s remaining in cooldown`
                  );
                }
                continue;
              } else {
                // Cooldown expired - reset circuit breaker
                cbState.triggered = false;
                cbState.consecutiveLosses = 0;
                // Aggregate expiration logs
                cbExpirationCounts.set(market, (cbExpirationCounts.get(market) || 0) + 1);
              }
            }
          }

          const availableCapital = getAvailableCapital(currentPrices);
          const minCollateral = options.minPositionSize || 50;
          if (availableCapital < minCollateral) continue;

          // Base values from config/per-market overrides
          const baseSizePct = positionSizePercent;
          const baseLeverage = options.perMarketLeverage?.get(market) || leverage;
          const baseHardStopPct = strategy?.cfg?.rsiHardStopPercent ?? 0;
          const baseHardStopAtr = strategy?.cfg?.rsiHardStopAtr ?? 0;

          // === ALLOCATOR RISK RECOMMENDATION ===
          // When enabled, dynamically adjust size/leverage/stops based on signal quality
          let effectiveSizePct = baseSizePct;
          let effectiveLeverage = baseLeverage;
          let effectiveHardStopPct = baseHardStopPct;
          let effectiveHardStopAtr = baseHardStopAtr;
          let allocatorRiskApplied = null;

          if (allocator && typeof allocator.recommendRisk === "function") {
            try {
              const allocatorScore = cand._allocatorScore ?? 0;
              const riskRec = allocator.recommendRisk({
                market: traceMarketName(market),
                signal: signal,
                priceData: { price: entryPrice, atr: strategy?.atr },
                score: allocatorScore,
                strategyType: "rsi-reversion",
                base: {
                  sizePct: baseSizePct,
                  leverage: baseLeverage,
                  hardStopPercent: baseHardStopPct,
                  hardStopAtrMult: baseHardStopAtr,
                },
              });
              if (riskRec) {
                effectiveSizePct = Number.isFinite(riskRec.sizePct) ? riskRec.sizePct : baseSizePct;
                effectiveLeverage = Number.isFinite(riskRec.leverage)
                  ? riskRec.leverage
                  : baseLeverage;
                effectiveHardStopPct = Number.isFinite(riskRec.hardStopPercent)
                  ? riskRec.hardStopPercent
                  : baseHardStopPct;
                effectiveHardStopAtr = Number.isFinite(riskRec.hardStopAtrMult)
                  ? riskRec.hardStopAtrMult
                  : baseHardStopAtr;
                allocatorRiskApplied = {
                  quality: riskRec.quality,
                  sizePct: { base: baseSizePct, effective: effectiveSizePct },
                  leverage: { base: baseLeverage, effective: effectiveLeverage },
                  hardStopPct: { base: baseHardStopPct, effective: effectiveHardStopPct },
                  hardStopAtr: { base: baseHardStopAtr, effective: effectiveHardStopAtr },
                };
                if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
                  console.log(
                    `[ALLOCATOR_RISK] ${market} score=${allocatorScore.toFixed(2)} q=${riskRec.quality?.toFixed(2)} | size=${baseSizePct.toFixed(0)}→${effectiveSizePct.toFixed(0)}% lev=${baseLeverage.toFixed(1)}→${effectiveLeverage.toFixed(1)}x`
                  );
                }
              }
            } catch (e) {
              if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
                console.warn(
                  `[ALLOCATOR_RISK] recommendRisk failed for ${market}:`,
                  e?.message || e
                );
              }
            }
          }

          // Calculate position size using effective values
          // Build sizing context with market-specific data for advanced sizing methods
          const sizingContext = {
            atr: strategy?.atr,
            price: entryPrice,
            hardStopPct: effectiveHardStopPct,
            confidence: signal?.confidence ?? 0.5,
            leverage: effectiveLeverage,
            // For volatility-scaled: allocator multiplier is applied as POST-MULTIPLY after volatility calc.
            // For other methods: sizePct is applied directly as the sizing percent.
            // Either way, final result is capped at availableCapital.
            positionSizePercentOverride: effectiveSizePct,
            // Historical stats for Kelly (could be populated from running stats)
            winRate: options.historicalWinRate || 0.65,
            avgWin: options.historicalAvgWin || 100,
            avgLoss: options.historicalAvgLoss || 80,
          };
          const basePositionSize = getPositionSize(availableCapital, sizingContext);
          let positionSize = Math.max(0, basePositionSize);
          if (positionSize < minCollateral) continue;
          // If allocator risk boosts sizing above available collateral, clamp rather than skipping the trade.
          // This keeps behavior realistic (size down) and prevents "0 trades" edge cases.
          if (positionSize > availableCapital + 0.01) {
            capitalViolations++;
            positionSize = Math.max(0, availableCapital * 0.95);
          }
          if (positionSize < minCollateral) continue;

          const marketLeverage = effectiveLeverage;
          let sizeUsd = positionSize * marketLeverage;
          let collateral = positionSize;

          // === FIX #2: POSITION SIZE CAPS ===
          // Apply per-market position caps (prevents unrealistic mega-positions)
          // Disabled by default - enable with ENABLE_LIQUIDITY_CAPS=true
          if (process.env.ENABLE_LIQUIDITY_CAPS === "true") {
            const liquidityCheck = shouldSkipTrade(market, sizeUsd, { strict: false });
            if (liquidityCheck.skip) {
              // Skip this trade entirely (strict mode or severe violation)
              if (trace) {
                trace.push({
                  model: traceModel,
                  kind: "trade_skip",
                  ts: entryTime,
                  market: traceMarketName(market),
                  reason: liquidityCheck.reason,
                  requestedSize: liquidityCheck.requestedSize,
                });
              }
              continue;
            }
            if (liquidityCheck.capped) {
              // Cap to max size and continue
              sizeUsd = liquidityCheck.cappedSize;
              collateral = sizeUsd / marketLeverage;
              if (trace) {
                trace.push({
                  model: traceModel,
                  kind: "position_capped",
                  ts: entryTime,
                  market: traceMarketName(market),
                  requestedSize: liquidityCheck.requestedSize,
                  cappedSize: liquidityCheck.cappedSize,
                  reason: liquidityCheck.reason,
                });
              }
            }
          }

          // Maker fill simulation (Drift only): limit-maker attempt → optional taker fallback.
          // IMPORTANT: taker slippage is applied consistently via applyTakerEntrySlippage,
          // and MUST NOT be hard-coded here (otherwise makerSim changes PnL vs taker baseline).
          let entryExecMode = feeCfg.execMode;
          let filledEntryPrice = entryPrice;
          const refEntryPriceForSlippage = entryPrice; // always measure execution vs the true reference
          if (
            feeCfg.model === "drift" &&
            feeCfg.execMode === "maker" &&
            process.env.ENABLE_MAKER_FILL_SIM === "true"
          ) {
            makerEntryStats.attempts++;
            const entrySim = simulateDriftMakerEntryFill({
              market: traceMarketName(market),
              strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
              side: signal.side,
              refPrice: entryPrice,
              candle,
              positionSizeUsd: sizeUsd,
              volatility: strategy?.atr && entryPrice ? strategy.atr / entryPrice : 0.02,
            });
            entryExecMode = entrySim.execMode;
            filledEntryPrice = entrySim.fillPrice ?? entryPrice;
            if (entrySim.outcome === "maker_fill") makerEntryStats.makerFills++;
            if (entrySim.outcome === "taker_fallback") makerEntryStats.takerFallbacks++;
            if (entrySim.outcome === "no_fill") {
              makerEntryStats.noFills++;
              continue; // skip opening this position
            }
          }

          if (entryExecMode === "taker") {
            const refPriceBeforeSlippage = filledEntryPrice;
            filledEntryPrice = applyTakerEntrySlippage(
              filledEntryPrice,
              signal.side,
              sizeUsd,
              market,
              strategy?.atr
            );
            // Track slippage ONLY for taker fills (maker fills have price improvement, not slippage)
            if (
              Number.isFinite(refPriceBeforeSlippage) &&
              refPriceBeforeSlippage > 0 &&
              Number.isFinite(filledEntryPrice)
            ) {
              const slipUsd = sizeUsd * Math.abs(filledEntryPrice / refPriceBeforeSlippage - 1);
              if (Number.isFinite(slipUsd) && slipUsd > 0) {
                feeBreakdown.slippageUsd += slipUsd;
                feeBreakdown.slippageEntryUsd += slipUsd;
              }
            }
          }

          const quantity = sizeUsd / filledEntryPrice;

          const openRes = feeCfg.calculateOpenFee
            ? feeCfg.calculateOpenFee(sizeUsd, { execMode: entryExecMode })
            : {
                fee: (sizeUsd * feeCfg.openFeeBps) / 10000,
                breakdown: { baseFee: (sizeUsd * feeCfg.openFeeBps) / 10000, priceImpactFee: 0 },
              };
          const openFee = openRes.breakdown?.baseFee ?? 0;
          const impactFee = openRes.breakdown?.priceImpactFee ?? 0;
          const swapFee = feeCfg.enableSwapFee ? calculateSwapFee(collateral) : 0;
          const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;
          const totalEntryFees = (openRes.fee ?? 0) + swapFee + txFee;

          realisedPnl -= totalEntryFees;
          totalFees += totalEntryFees;
          feeBreakdown.openFees += openFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.swapFees += swapFee;
          feeBreakdown.txFees += txFee;

          marketResults.get(market).totalPnL -= totalEntryFees;
          marketResults.get(market).totalFees += totalEntryFees;

          const position = {
            id: `sim-${++tradeCounter}`,
            market,
            side: signal.side,
            // Store both mark (ref) and fill for transparency
            entryMarkPrice: entryPrice,
            entryPrice: filledEntryPrice,
            entryFillPrice: filledEntryPrice,
            entryRsi: strategy.rsi,
            entryAtr: Number.isFinite(strategy.atr) ? strategy.atr : null,
            openTime: entryTime,
            lastBorrowTs: entryTime,
            sizeUsd,
            quantity,
            collateral,
            leverage: marketLeverage,
            entryFee: totalEntryFees,
            entryExecMode,
            allocatorRiskApplied, // Track if/how allocator adjusted risk
            highWaterMark: filledEntryPrice,
            lowWaterMark: filledEntryPrice,
          };

          // Fixed hard stop level from ENTRY ATR (used for per-tick stops)
          // Use EFFECTIVE hard stop values (may be adjusted by allocator)
          if (
            strategy?.cfg?.rsiHardStopEnabled &&
            (Number.isFinite(effectiveHardStopPct) || Number.isFinite(effectiveHardStopAtr))
          ) {
            const dist = computeHardStopDistance({
              entryPrice: position.entryPrice,
              side: position.side,
              leverage: position.leverage || marketLeverage,
              hardStopEnabled: true,
              hardStopPercent: effectiveHardStopPct,
              hardStopAtrMult: effectiveHardStopAtr,
              atr: position.entryAtr,
            });
            if (Number.isFinite(dist) && dist > 0) {
              position._hardStopLevel =
                position.side === "long" ? position.entryPrice - dist : position.entryPrice + dist;
            }
          }

          allPositions.push(position);

          // Track accepted signal
          allocatorStats.totalSignalsAccepted++;
          const mktAccepted = traceMarketName(market);
          if (allocatorStats.byMarket.has(mktAccepted))
            allocatorStats.byMarket.get(mktAccepted).accepted++;

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "entry",
              ts: entryTime,
              market: traceMarketName(market),
              barIndex: idx,
              tickIndex: 0,
              price: entryPrice,
              rsi: position.entryRsi,
              atr: position.entryAtr,
              action: "open",
              side: position.side,
              confidence: signal?.confidence ?? null,
              reason: signal?.reason ?? null,
              positionId: position.id,
              fillPrice: filledEntryPrice,
            });
          }

          if (debug) {
            console.log(
              `🎯 [${market}] ENTRY @ OPEN: ${String(signal.side).toUpperCase()} @ $${entryPrice.toFixed(2)} | RSI=${strategy.rsi?.toFixed(1)} | Collateral: $${collateral.toFixed(0)}`
            );
          }
        }
      }
    }

    // Process each tick
    for (let tickIdx = 0; tickIdx < effectiveTicksPerCandle; tickIdx++) {
      // Update current prices for this tick
      for (const [market, ticks] of marketTicks.entries()) {
        const t = ticks[tickIdx] || ticks[ticks.length - 1];
        const px = typeof t === "number" ? t : t?.price;
        currentPrices.set(market, px);
      }

      // Tick timestamp (shared bar cadence). Use the bar's openTime as base.
      // Note: timestamps[] is keyed by candle.closeTime; openTime is on the candle.
      const intervalMs = intervalToMs(options.interval || "5m");
      const anyCandle = marketCandles.values().next().value;
      const tickTsBase = anyCandle?.openTime ?? ts;
      const tickTs = tickTsBase + tickIdx * (intervalMs / effectiveTicksPerCandle);

      // Track equity at each tick
      const lockedCollateral = getLockedCollateral();
      let unrealisedPnl = 0;
      for (const pos of allPositions) {
        const currentPrice = currentPrices.get(pos.market) || pos.entryPrice;
        const dir = pos.side === "long" ? 1 : -1;
        const rawPnl = dir * (currentPrice - pos.entryPrice) * pos.quantity;
        const collateral = Number.isFinite(pos.collateral)
          ? pos.collateral
          : pos.leverage > 0
            ? pos.sizeUsd / pos.leverage
            : 0;
        // Cap loss at collateral (would be liquidated before losing more)
        unrealisedPnl += Math.max(rawPnl, -collateral);
      }
      // Equity can never go below 0 (worst case: all positions liquidated)
      const currentEquity = Math.max(0, initialCapital + realisedPnl + unrealisedPnl);
      if (tickIdx === effectiveTicksPerCandle - 1) {
        equitySeries.push(currentEquity);
        concurrentPositionCounts.push(allPositions.length);
      }
      maxEquity = Math.max(maxEquity, currentEquity);
      minEquity = Math.min(minEquity, currentEquity);

      // Track concurrent position and collateral peaks
      maxConcurrentPositions = Math.max(maxConcurrentPositions, allPositions.length);
      maxCollateralInUse = Math.max(maxCollateralInUse, lockedCollateral);

      // Process PRICE-BASED exits (hard stops) for all open positions at this tick.
      // IMPORTANT: RSI-based exits must be evaluated at bar close after RSI is updated from this bar's close.
      // ===========================================
      // HARD STOP CHECK FIRST (priority over max_loss_cap)
      // If price has gapped past the hard stop, we still exit at the stop level.
      // This prevents "gapping through" stops.
      // ===========================================
      const MAX_COLLATERAL_LOSS_PCT = 50; // 50% max loss = fallback safety cap
      const positionsToClose = [];

      for (const pos of allPositions) {
        const market = pos.market;
        const strategy = strategiesMap.get(market);
        const candle = marketCandles.get(market);

        if (!strategy || !candle) continue;

        const price = currentPrices.get(market);
        updateTrailingWatermarks(pos, price);
        const posTickTs =
          (candle?.openTime ?? tickTsBase) + tickIdx * (intervalMs / effectiveTicksPerCandle);
        const posLeverage = Number.isFinite(pos.leverage)
          ? pos.leverage
          : options.perMarketLeverage?.get(market) || leverage;
        const collateral = Number.isFinite(pos.collateral)
          ? pos.collateral
          : posLeverage > 0
            ? pos.sizeUsd / posLeverage
            : 0;

        // ===== HARD STOP CHECK FIRST (priority over max_loss_cap) =====
        // Even if price has gapped way past the stop, exit at stop level
        const hardStopPercent = options.perMarketHardStop?.has(market)
          ? options.perMarketHardStop.get(market)
          : (options.rsiHardStopPercent ?? 3);
        const hardStopAtrMult = options.perMarketHardStopAtr?.has(market)
          ? options.perMarketHardStopAtr.get(market)
          : (options.rsiHardStopAtr ?? rsiHardStopAtr ?? 0);

        const atrForStop = Number.isFinite(pos.entryAtr) ? pos.entryAtr : strategy.atr;
        const hardStopDistance = computeHardStopDistance({
          entryPrice: pos.entryPrice,
          side: pos.side,
          leverage: posLeverage,
          hardStopEnabled: true,
          hardStopPercent,
          hardStopAtrMult,
          atr: atrForStop,
        });

        let stopTriggered = false;
        let stopPrice = price;
        let stopLevel = null;

        // TICK-LEVEL HARD STOP: Only use tick price, not candle high/low (no look-ahead)
        // Use WORSE of (stop level, tick price) for realistic gap-through behavior
        if (hardStopDistance) {
          if (pos.side === "short") {
            stopLevel = pos.entryPrice + hardStopDistance;
            if (price >= stopLevel) {
              stopTriggered = true;
              // For shorts, higher price = worse. Use actual tick price if it gapped through
              stopPrice = Math.max(stopLevel, price);
            }
          } else if (pos.side === "long") {
            stopLevel = pos.entryPrice - hardStopDistance;
            if (price <= stopLevel) {
              stopTriggered = true;
              // For longs, lower price = worse. Use actual tick price if it gapped through
              stopPrice = Math.min(stopLevel, price);
            }
          }
        }

        if (stopTriggered) {
          positionsToClose.push({
            pos,
            reason: "rsi_hard_stop",
            price: stopPrice,
            stopPrice,
            stopLevel, // Original stop level for logging
            tickPrice: price, // Actual tick price for reference
            exitTs: posTickTs,
            candle,
            market,
            strategy,
          });
          continue; // Skip max_loss_cap check - hard stop takes priority
        }

        // ===== TRAILING STOP (per-tick, after hard stop) =====
        if (strategy?.cfg?.rsiEnableTrailingStop) {
          const trailingSignal = strategy.shouldClose(pos, price, idx);
          if (trailingSignal && trailingSignal.reason === "rsi_trailing_stop") {
            const trailStopPrice = Number.isFinite(trailingSignal.trailStopPrice)
              ? trailingSignal.trailStopPrice
              : price;
            const realisticExitPrice =
              pos.side === "long" ? Math.min(trailStopPrice, price) : Math.max(trailStopPrice, price);
            positionsToClose.push({
              pos,
              reason: "rsi_trailing_stop",
              price: realisticExitPrice,
              stopPrice: trailStopPrice,
              stopLevel: trailStopPrice,
              tickPrice: price,
              exitTs: posTickTs,
              candle,
              market,
              strategy,
              trailMethod: trailingSignal.trailMethod,
            });
            continue; // Skip max_loss_cap check - trailing stop takes priority
          }
        }

        // ===== MAX LOSS CAP FALLBACK (only if hard stop didn't trigger) =====
        // This is a SAFETY MECHANISM for positions WITHOUT hard stops configured.
        const dir = pos.side === "long" ? 1 : -1;
        const unrealisedPnl = dir * (price - pos.entryPrice) * pos.quantity;
        const lossPct = (-unrealisedPnl / collateral) * 100;

        if (lossPct >= MAX_COLLATERAL_LOSS_PCT) {
          positionsToClose.push({
            pos,
            reason: "max_loss_cap",
            price,
            stopPrice: price,
            exitTs: posTickTs,
            candle,
            market,
            strategy,
            lossPct,
          });
        }
      }

      // Close positions
      for (const {
        pos,
        reason,
        price,
        stopPrice,
        exitTs,
        candle,
        market,
        strategy,
        trailMethod,
      } of positionsToClose) {
        const posIdx = allPositions.indexOf(pos);
        if (posIdx === -1) continue;
        allPositions.splice(posIdx, 1);

        const dir = pos.side === "long" ? 1 : -1;
        // NOTE: grossPnl will be calculated AFTER slippage is applied to filledExitPrice

        // Determine if exit should be maker or taker based on reason
        // Hard stops and emergency exits → immediate taker
        // RSI targets and failure exits → can try maker
        const preferredExitMode = getExitExecModeForReason(reason, feeCfg.execMode);
        let exitExecMode = preferredExitMode;
        let filledExitPrice = price;
        const refExitPriceForSlippage = price; // always measure execution vs the true reference

        // Only simulate maker if preferred AND Drift maker mode is enabled
        if (
          feeCfg.model === "drift" &&
          feeCfg.execMode === "maker" &&
          preferredExitMode === "maker" &&
          process.env.ENABLE_MAKER_FILL_SIM === "true"
        ) {
          makerExitStats.attempts++;
          const exitSim = simulateDriftMakerExitFill({
            market: traceMarketName(market),
            strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
            side: pos.side,
            refPrice: price,
            candle: candle || { high: price, low: price, close: price },
            positionSizeUsd: pos.sizeUsd || 0, // AUDIT FIX: Pass size for degradation
          });
          exitExecMode = exitSim.execMode;
          filledExitPrice = exitSim.fillPrice ?? price;
          if (exitSim.outcome === "maker_fill") makerExitStats.makerFills++;
          if (exitSim.outcome === "taker_fallback") {
            makerExitStats.takerFallbacks++;
          }
          // Track slippage ONLY for taker fills (maker fills have price improvement, not slippage)
          if (exitExecMode === "taker") {
            const refExitPrice = filledExitPrice;
            filledExitPrice = applyTakerExitSlippage(
              filledExitPrice,
              pos.side,
              pos.quantity * filledExitPrice,
              market,
              strategy?.atr || pos.entryAtr,
              pos.entryPrice
            );
            if (
              Number.isFinite(refExitPrice) &&
              refExitPrice > 0 &&
              Number.isFinite(filledExitPrice)
            ) {
              const notional = pos.quantity * refExitPrice;
              const slipUsd = notional * Math.abs(filledExitPrice / refExitPrice - 1);
              if (Number.isFinite(slipUsd) && slipUsd > 0) {
                feeBreakdown.slippageUsd += slipUsd;
                feeBreakdown.slippageExitUsd += slipUsd;
              }
            }
          }
        } else if (preferredExitMode === "taker") {
          // Emergency exit - use taker immediately with dynamic slippage
          exitExecMode = "taker";
          const refExitPrice = price;
          filledExitPrice = applyTakerExitSlippage(
            price,
            pos.side,
            pos.quantity * price,
            market,
            strategy?.atr || pos.entryAtr,
            pos.entryPrice
          );
          // Track slippage for emergency taker exits
          if (
            Number.isFinite(refExitPrice) &&
            refExitPrice > 0 &&
            Number.isFinite(filledExitPrice)
          ) {
            const notional = pos.quantity * refExitPrice;
            const slipUsd = notional * Math.abs(filledExitPrice / refExitPrice - 1);
            if (Number.isFinite(slipUsd) && slipUsd > 0) {
              feeBreakdown.slippageUsd += slipUsd;
              feeBreakdown.slippageExitUsd += slipUsd;
            }
          }
          // Only count in makerExitStats if we're in maker mode (otherwise it's expected behavior)
          if (feeCfg.execMode === "maker") {
            makerExitStats.forcedTaker++; // Emergency exit - never tries maker
          }
        }

        // Calculate gross P&L using the SLIPPED exit price (filledExitPrice includes slippage)
        const grossPnl = dir * (filledExitPrice - pos.entryPrice) * pos.quantity;

        // Calculate fees - use current notional value (quantity * exit price), not entry-based sizeUsd
        const currentNotional = pos.quantity * filledExitPrice;
        const closeRes = feeCfg.calculateCloseFee
          ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
          : {
              fee: (currentNotional * feeCfg.closeFeeBps) / 10000,
              breakdown: {
                baseFee: (currentNotional * feeCfg.closeFeeBps) / 10000,
                priceImpactFee: 0,
              },
            };
        const closeFee = closeRes.breakdown?.baseFee ?? closeRes.fee ?? 0;
        // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
        const impactFee = feeCfg.model === "drift" ? 0 : calculatePriceImpactFee(currentNotional);
        const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
        const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
        const borrowFee =
          feeCfg.model === "drift"
            ? 0
            : calculateBorrowFeeUsd(
                pos.sizeUsd,
                Math.max(0, (exitTs ?? candle.closeTime) - lastBorrowTs)
              );
        const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;

        // Drift funding fee - uses historical rates if available
        // Note: fundingFee is negative if you're paying, positive if receiving
        const fundingFee = calculateFundingCostForPosition(
          market,
          pos.side,
          pos.sizeUsd,
          pos.openTime,
          exitTs ?? candle.closeTime
        );

        const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee; // Subtract because fundingFee is already signed

        const netPnl = grossPnl - totalExitFees;
        realisedPnl += netPnl;
        // Only add exit fees here - entry fees were already added when position was opened
        totalFees += totalExitFees;

        feeBreakdown.closeFees += closeFee;
        feeBreakdown.impactFees += impactFee;
        feeBreakdown.swapFees += swapFee;
        feeBreakdown.borrowFees += borrowFee;
        feeBreakdown.fundingFees += fundingFee; // negative = paid, positive = received
        feeBreakdown.txFees += txFee;
        feeBreakdown.totalTrades++;

        const balanceAfterClose = initialCapital + realisedPnl;

        const posLeverage = Number.isFinite(pos.leverage)
          ? pos.leverage
          : options.perMarketLeverage?.get(market) || leverage;
        const trade = {
          id: pos.id,
          market,
          side: pos.side,
          entryPrice: pos.entryPrice,
          // Store both mark (ref) and fill for transparency
          exitMarkPrice: price,
          exitPrice: filledExitPrice,
          exitFillPrice: filledExitPrice,
          entryRsi: pos.entryRsi,
          exitRsi: strategy.rsi,
          openTime: pos.openTime,
          exitTime: exitTs ?? candle.closeTime,
          sizeUsd: pos.sizeUsd,
          quantity: pos.quantity,
          leverage: posLeverage,
          collateral: pos.collateral,
          grossPnl,
          pnlUsd: netPnl,
          totalPnlUsd: netPnl,
          pnlPct: (netPnl / pos.collateral) * 100,
          exitReason: reason,
          entryFee: pos.entryFee || 0,
          exitFee: totalExitFees,
          balanceAfterClose,
        };

        if (trace) {
          trace.push({
            model: traceModel,
            kind: "exit",
            ts: exitTs ?? candle.closeTime,
            market: traceMarketName(market),
            barIndex: idx,
            tickIndex: tickIdx,
            price,
            rsi: strategy.rsi,
            atr: strategy.atr,
            action: "close",
            side: pos.side,
            reason,
            positionId: pos.id,
            fillPrice: price,
            stopPrice:
              reason === "rsi_hard_stop" || reason === "rsi_trailing_stop"
                ? (stopPrice ?? price)
                : null,
            extra:
              reason === "rsi_hard_stop" || reason === "rsi_trailing_stop"
                ? {
                    tickPrice: currentPrices.get(market),
                    stopLevel: stopPrice ?? price,
                    trailMethod: reason === "rsi_trailing_stop" ? trailMethod ?? null : null,
                  }
                : null,
          });
        }

        allTrades.push(trade);
        marketResults.get(market).trades.push(trade);
        marketResults.get(market).totalPnL += netPnl;
        // Only add exit fees here - entry fees were already added when position was opened
        marketResults.get(market).totalFees += totalExitFees;

        // Update circuit breaker state
        if (cbEnabled) {
          const cbState = circuitBreakerState.get(market);
          if (cbState) {
            if (netPnl < 0) {
              // Loss - increment consecutive losses
              cbState.consecutiveLosses++;
              if (cbState.consecutiveLosses >= cbMaxLosses) {
                // Trigger circuit breaker
                cbState.cooldownUntil = (exitTs ?? candle.closeTime) + cbCooldownMs;
                cbState.triggered = true;
                cbTriggeredCount++;
                // Aggregate activation logs
                cbActivationCounts.set(market, (cbActivationCounts.get(market) || 0) + 1);
              }
            } else {
              // Win - reset consecutive losses
              cbState.consecutiveLosses = 0;
            }
          }
        }

        if (debug) {
          const emoji = netPnl >= 0 ? "✅" : "❌";
          console.log(
            `${emoji} [${market}] ${pos.side} closed | ${reason} | PnL: $${netPnl.toFixed(2)} | Equity: $${(initialCapital + realisedPnl).toFixed(0)}`
          );
        }

        strategy.recordTrade(trade);
      }
    } // End of tick loop

    // ============================================================
    // BAR CLOSE: update indicators + evaluate RSI-based exits at candle close
    // ============================================================
    for (const [market, candle] of marketCandles.entries()) {
      const strategy = strategiesMap.get(market);
      if (!strategy) continue;
      strategy.update({
        price: candle.close,
        close: candle.close,
        high: candle.high,
        low: candle.low,
        volume: candle.quoteVolume || candle.volume || 0,
        ts: candle.closeTime,
      });

      // Guardrail: ensure we update exactly once per bar per market
      if (parityChecks) {
        const prevIdx = lastBarCloseUpdatedIdxByMarket.get(market);
        if (prevIdx === idx) {
          throw new Error(`[PARITY] strategy.update called twice for ${market} at bar idx=${idx}`);
        }
      }
      lastBarCloseUpdatedIdxByMarket.set(market, idx);

      if (trace) {
        trace.push({
          model: traceModel,
          kind: "bar_close_update",
          ts: candle.closeTime,
          market: traceMarketName(market),
          barIndex: idx,
          tickIndex: effectiveTicksPerCandle - 1,
          price: candle.close,
          rsi: strategy.rsi,
          atr: strategy.atr,
          extra: { close: candle.close, high: candle.high, low: candle.low },
        });
      }
    }

    // NOTE (production parity): RSI exits are evaluated at BAR OPEN only.
    // We do not evaluate RSI exits at candle close here.
  } // End of timestamp loop

  // Close any remaining positions at last prices
  for (const pos of [...allPositions]) {
    const price = currentPrices.get(pos.market) || pos.entryPrice;
    const strategy = strategiesMap.get(pos.market);
    const marketLeverage = options.perMarketLeverage?.get(pos.market) || leverage;
    const exitTs = timestamps[timestamps.length - 1];
    const exitReason = "end_of_backtest";

    const dir = pos.side === "long" ? 1 : -1;
    const grossPnl = dir * (price - pos.entryPrice) * pos.quantity;

    // End of backtest = taker (forced close)
    const exitExecMode = getExitExecModeForReason(exitReason, "taker");

    // Calculate fees - use current notional value (quantity * exit price), not entry-based sizeUsd
    const currentNotional = pos.quantity * price;
    const closeRes = feeCfg.calculateCloseFee
      ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
      : { fee: (currentNotional * feeCfg.closeFeeBps) / 10000, breakdown: {} };
    const closeFee =
      closeRes.breakdown?.baseFee ?? closeRes.fee ?? (currentNotional * feeCfg.closeFeeBps) / 10000;
    // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
    const impactFee = feeCfg.model === "drift" ? 0 : calculatePriceImpactFee(currentNotional);
    const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
    const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
    const borrowFee =
      feeCfg.model === "drift"
        ? 0
        : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, exitTs - lastBorrowTs));
    const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;

    // Funding fee (Drift only) - uses historical rates if available
    const fundingFee = calculateFundingCostForPosition(
      pos.market,
      pos.side,
      pos.sizeUsd,
      pos.openTime,
      exitTs
    );

    const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;
    const netPnl = grossPnl - totalExitFees;

    realisedPnl += netPnl;
    // Only add exit fees here - entry fees were already added when position was opened
    totalFees += totalExitFees;
    feeBreakdown.closeFees += closeFee;
    feeBreakdown.impactFees += impactFee;
    feeBreakdown.swapFees += swapFee;
    feeBreakdown.borrowFees += borrowFee;
    feeBreakdown.fundingFees += fundingFee;
    feeBreakdown.txFees += txFee;

    const balanceAfterClose = initialCapital + realisedPnl;

    const trade = {
      id: pos.id,
      market: pos.market,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      entryRsi: pos.entryRsi,
      exitRsi: strategy?.rsi,
      openTime: pos.openTime,
      exitTime: timestamps[timestamps.length - 1],
      sizeUsd: pos.sizeUsd,
      quantity: pos.quantity,
      leverage: marketLeverage,
      collateral: pos.collateral,
      grossPnl,
      pnlUsd: netPnl,
      totalPnlUsd: netPnl,
      pnlPct: (netPnl / pos.collateral) * 100,
      exitReason: "end_of_backtest",
      entryFee: pos.entryFee || 0,
      exitFee: totalExitFees,
      balanceAfterClose,
    };

    allTrades.push(trade);
    marketResults.get(pos.market).trades.push(trade);
    marketResults.get(pos.market).totalPnL += netPnl;
    // ✅ Correctness: include end-of-backtest exit fees (can be negative if funding is received).
    // Without this, per-market fee totals and the aggregated TOTAL FEES become inconsistent with trade-level fees.
    marketResults.get(pos.market).totalFees += totalExitFees;
  }

  return {
    trades: allTrades,
    realisedPnl,
    totalPnL: realisedPnl,
    totalFees,
    feeBreakdown,
    equitySeries,
    initialCapital,
    marketResults,
    capitalStats: {
      maxEquity,
      minEquity,
      capitalViolations,
      finalEquity:
        equitySeries.length > 0
          ? equitySeries[equitySeries.length - 1]
          : initialCapital + realisedPnl,
      maxConcurrentPositions,
      maxCollateralInUse,
      concurrentPositionCounts,
    },
    makerEntryStats, // Drift maker entry fill simulation stats
    makerExitStats, // Drift maker exit fill simulation stats
    circuitBreakerStats: cbEnabled
      ? {
          enabled: true,
          maxLosses: cbMaxLosses,
          cooldownMs: cbCooldownMs,
          triggeredCount: cbTriggeredCount,
          skippedEntries: cbSkippedEntries,
          activationsByMarket: Object.fromEntries(cbActivationCounts),
          expirationsByMarket: Object.fromEntries(cbExpirationCounts),
        }
      : { enabled: false },
    allocatorStats: {
      totalSignalsGenerated: allocatorStats.totalSignalsGenerated,
      totalSignalsAccepted: allocatorStats.totalSignalsAccepted,
      totalSignalsRejected: allocatorStats.totalSignalsRejected,
      totalSignalsBlockedCB: allocatorStats.totalSignalsBlockedCB,
      totalSignalsBlockedCapacity: allocatorStats.totalSignalsBlockedCapacity,
      concurrentSignalTicks: allocatorStats.concurrentSignalTicks,
      maxConcurrentSignals: allocatorStats.maxConcurrentSignals,
      concurrentSignalHist: allocatorStats.concurrentSignalHist,
      acceptanceRate:
        allocatorStats.totalSignalsGenerated > 0
          ? (
              (allocatorStats.totalSignalsAccepted / allocatorStats.totalSignalsGenerated) *
              100
            ).toFixed(1) + "%"
          : "N/A",
      byMarket: Object.fromEntries(allocatorStats.byMarket),
    },
  };
}

// ============================================================
// BOT RUNTIME PARITY SIMULATORS (TRACE MODEL = 'bot')
// These simulate the sequencing used in bot.js:
// - strategy.update() only on completed bars (fed at the boundary before the next bar starts)
// - strategy.recalculateLastBar() on every tick using rolling bar OHLC
// - getSignal() and shouldClose() evaluated every tick
// - closes executed at tick price (bot passes tick price into closePosition)
// ============================================================

function simulateBotRuntimeSingleMarket(strategy, candles, options = {}) {
  const {
    positionSizeUsd = 1000,
    leverage = 3,
    debug = false,
    verbose = false,
    allowLongs = true,
    allowShorts = true,
    simulateTicks = true,
    ticksPerCandle = TICKS_PER_5MIN_CANDLE,
    maxPositions = 1,
  } = options;

  const trace = options._trace;
  const traceModel = "bot";
  const marketName = strategy?.cfg?.market || (options.symbol ? `${options.symbol}-PERP` : null);

  // Fee configuration - uses FEE_MODEL env var (jupiter or drift)
  const feeCfg = buildFeeCfg();

  const trades = [];
  const positions = [];
  const equitySeries = [];
  let realisedPnl = 0;
  let totalFees = 0;
  let tradeCounter = 0;
  const initialCapital = options.initialCapital || positionSizeUsd;
  const enableCompounding = options.enableCompounding ?? false;
  const positionSizePercent = options.positionSizePercent ?? 100;
  let currentEquity = initialCapital;

  const feeBreakdown = {
    openFees: 0,
    closeFees: 0,
    impactFees: 0,
    swapFees: 0,
    borrowFees: 0,
    slippageUsd: 0,
    slippageEntryUsd: 0,
    slippageExitUsd: 0,
    txFees: 0,
    liquidatorFees: 0,
    insuranceFees: 0,
    totalTrades: 0,
  };

  // Maker fill simulation stats (Drift only)
  // attempts = tried maker simulation
  // takerFallbacks = maker simulation timed out / failed → fallback to taker
  // forcedTaker = emergency exits that never try maker (hard stops, etc.)
  const makerEntryStats = { attempts: 0, makerFills: 0, takerFallbacks: 0, noFills: 0 };
  const makerExitStats = {
    attempts: 0,
    makerFills: 0,
    takerFallbacks: 0,
    forcedTaker: 0,
    noFills: 0,
  };

  const getUsedMargin = () =>
    positions.reduce((s, p) => s + (p.collateral || p.sizeUsd / leverage), 0);
  const getAvailableCapital = () => {
    const used = getUsedMargin();
    const realisedEquity = enableCompounding ? initialCapital + realisedPnl : initialCapital;
    return Math.max(0, realisedEquity - used);
  };
  const getPositionSize = () => {
    let base = enableCompounding ? currentEquity * (positionSizePercent / 100) : positionSizeUsd;
    base = Math.max(base, options.minPositionSize || 50);
    base = Math.min(base, options.maxPositionSize || 5000);
    return base;
  };

  const warmupBars = strategy.cfg.rsiPeriod + 10;
  let globalTick = 0;

  const oneMinCandles = options.oneMinCandles;

  for (let barIndex = 0; barIndex < candles.length; barIndex++) {
    const candle = candles[barIndex];

    // Feed completed previous bar into strategy.update() at the boundary
    if (barIndex > 0) {
      const prev = candles[barIndex - 1];
      strategy.update({
        price: prev.close,
        close: prev.close,
        high: prev.high,
        low: prev.low,
        volume: prev.quoteVolume || prev.volume || 0,
        ts: prev.closeTime,
      });
      if (trace) {
        trace.push({
          model: traceModel,
          kind: "bar_close_update",
          ts: prev.closeTime,
          market: marketName,
          barIndex: barIndex - 1,
          tickIndex: ticksPerCandle - 1,
          price: prev.close,
          rsi: strategy.rsi,
          atr: strategy.atr,
        });
      }
    }

    // Build tick stream for this bar
    let intraBarTicks = [];
    let tickTimestamps = [];

    if (simulateTicks) {
      const barStart = candle.openTime;
      const cached = options.ticksByBarOpenTime?.get?.(barStart);
      if (cached && cached.length > 0) {
        for (const t of cached) {
          intraBarTicks.push(t.price);
          tickTimestamps.push(t.ts);
        }
      } else if (oneMinCandles && oneMinCandles.length > 0) {
        const barEnd = candle.closeTime;
        const matchingOneMin = oneMinCandles.filter(
          (c) => c.openTime >= barStart && c.openTime < barEnd
        );
        if (matchingOneMin.length === 5) {
          let tsCursor = barStart;
          for (const oneMin of matchingOneMin) {
            const minTicks = generateTicksFrom1MinCandle(oneMin);
            for (const p of minTicks) {
              intraBarTicks.push(p);
              tickTimestamps.push(tsCursor);
              tsCursor += TICK_INTERVAL_MS;
            }
          }
        }
      }
    }

    if (intraBarTicks.length === 0) {
      // Graceful fallback when 1m data is incomplete (e.g., at fold boundaries)
      // Use OHLC interpolation to keep simulation running
      const fallbackTicks = generateTicksFromOHLC(candle);
      intraBarTicks = fallbackTicks.map((t) => t.price);
      tickTimestamps = fallbackTicks.map((t) => t.ts);
    }

    // Tick loop (bot LOOP_MS cadence)
    let windowOpen = intraBarTicks[0] ?? candle.open;
    let windowHigh = windowOpen;
    let windowLow = windowOpen;

    for (let tickIndex = 0; tickIndex < intraBarTicks.length; tickIndex++) {
      const tickPrice = intraBarTicks[tickIndex];
      const tickTs = tickTimestamps[tickIndex] ?? candle.openTime + tickIndex * TICK_INTERVAL_MS;
      globalTick++;

      // Rolling window OHLC within this bar (for potential future use).
      // Production parity mode: RSI updates only on bar close, so we DO NOT call recalculateLastBar().
      windowHigh = Math.max(windowHigh, tickPrice);
      windowLow = Math.min(windowLow, tickPrice);
      if (typeof strategy.updateTick === "function") {
        strategy.updateTick({ price: tickPrice, volume: 0, ts: tickTs });
      }

      if (trace && tickIndex === 0) {
        trace.push({
          model: traceModel,
          kind: "bar_open",
          ts: candle.openTime,
          market: marketName,
          barIndex,
          tickIndex: 0,
          price: candle.open,
          rsi: strategy.rsi,
          atr: strategy.atr,
        });
      }

      // Exits:
      // - Liquidation checks happen on every tick (margin breach)
      // - Hard stops can happen on any tick (per tick).
      // - RSI-based exits are evaluated only at BAR OPEN (tickIndex=0) using RSI from previous bar close.
      for (const pos of [...positions]) {
        // ============================================================
        // LIQUIDATION CHECK (before hard stop - liquidation takes precedence)
        // ============================================================
        if (enableLiquidationCheck && isPositionLiquidated(pos, tickPrice)) {
          // Drift uses partial liquidations. We approximate:
          // - If equity is below maintenance requirement: liquidate enough notional to restore initial margin.
          // - Fees are charged on the liquidated notional (taker + liquidator + insurance).
          const qty = Number(pos.quantity);
          const notional = Number.isFinite(qty) && Number.isFinite(tickPrice) ? qty * tickPrice : 0;
          const dir = pos.side === "long" ? 1 : -1;
          const rawPnl = dir * (tickPrice - pos.entryPrice) * qty;
          const collateral = Number.isFinite(pos.collateral)
            ? pos.collateral
            : Number.isFinite(pos.sizeUsd)
              ? pos.sizeUsd / (pos.leverage || leverage)
              : 0;
          const equity = Math.max(0, collateral + rawPnl);

          // If no equity, treat as full liquidation (collateral wiped)
          const exitExecMode = "taker";
          if (feeCfg.execMode === "maker") makerExitStats.forcedTaker++;

          // Determine target remaining notional such that equity >= initialMarginRatio * remainingNotional
          let remainingNotional = notional;
          if (equity > 0 && notional > 0) {
            for (let i = 0; i < 6; i++) {
              const initRatio = getInitRatio(pos.market || marketName, remainingNotional);
              const allowed = equity / Math.max(1e-9, initRatio);
              const next = Math.max(0, Math.min(remainingNotional, allowed));
              if (
                remainingNotional > 0 &&
                Math.abs(next - remainingNotional) / remainingNotional < 0.01
              ) {
                remainingNotional = next;
                break;
              }
              remainingNotional = next;
            }
          }

          const liquidatedNotional = Math.max(0, notional - remainingNotional);
          const frac = notional > 0 ? liquidatedNotional / notional : 1;

          // If we can't save it (or nearly full), do full liquidation
          const doFull = equity <= 0 || frac >= 0.999;
          if (doFull) {
            const exitPrice = tickPrice;
            const exitReason = "liquidation";

            // For full liquidation, conservatively assume collateral wiped
            const grossPnl = -collateral;
            liquidationCount++;
            liquidationLoss += collateral;

            const currentNotional = notional;
            const closeRes = feeCfg.calculateCloseFee
              ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
              : { fee: currentNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
            const closeFee =
              closeRes.breakdown?.baseFee ??
              closeRes.fee ??
              currentNotional * (feeCfg.closeFeeBps / 10_000);

            const other =
              feeCfg.model === "drift"
                ? getOtherPerpFees(pos.market || marketName)
                : { liquidatorFee: 0, insuranceFee: 0 };
            const liquidatorFeeUsd =
              feeCfg.model === "drift" ? currentNotional * (other.liquidatorFee || 0) : 0;
            const insuranceFeeUsd =
              feeCfg.model === "drift" ? currentNotional * (other.insuranceFee || 0) : 0;

            const fundingFee = calculateFundingCostForPosition(
              pos.market,
              pos.side,
              pos.sizeUsd,
              pos.openTime,
              tickTs
            );
            const txFee = calculateSolanaTransactionFees(exitPrice, feeCfg);
            const totalExitFees =
              closeFee + liquidatorFeeUsd + insuranceFeeUsd + txFee - fundingFee;

            totalFees += totalExitFees;
            feeBreakdown.closeFees += closeFee;
            feeBreakdown.fundingFees += fundingFee;
            feeBreakdown.txFees += txFee;
            feeBreakdown.liquidatorFees += liquidatorFeeUsd;
            feeBreakdown.insuranceFees += insuranceFeeUsd;
            feeBreakdown.totalTrades++;

            const netPnl = grossPnl - totalExitFees;
            realisedPnl += netPnl;

            const pnl = {
              id: pos.id,
              market: pos.market,
              symbol: pos.market?.replace("-PERP", "") || market,
              side: pos.side,
              quantity: qty,
              entryPrice: pos.entryPrice,
              exitPrice,
              openTime: pos.openTime,
              exitTime: tickTs,
              grossPnl,
              pnlUsd: netPnl,
              fees: {
                closeFee,
                fundingFee,
                liquidatorFeeUsd,
                insuranceFeeUsd,
                txFee,
                exitExecMode,
              },
              exitReason,
              sizeUsd: pos.sizeUsd,
              collateral,
              leverage: pos.leverage,
              entryFee: pos.entryFees?.total || 0,
              exitFee: totalExitFees,
              exitRsi: strategy.rsi,
              liquidationPrice: null,
              liquidationType: "full",
            };

            if (trace) {
              trace.push({
                model: traceModel,
                kind: "exit",
                ts: tickTs,
                market: marketName,
                barIndex,
                tickIndex,
                price: tickPrice,
                rsi: strategy.rsi,
                atr: strategy.atr,
                action: "close",
                side: pos.side,
                reason: "liquidation",
                positionId: pos.positionId || pos.id,
                fillPrice: exitPrice,
                stopPrice: null,
                extra: { tickPrice, collateralLost: collateral, liquidationType: "full" },
              });
            }

            positions.splice(positions.indexOf(pos), 1);
            trades.push(pnl);
            currentEquity = initialCapital + realisedPnl;
            continue;
          }

          // Partial liquidation: reduce notional/qty to restore initial margin health
          partialLiquidationCount++;
          partialLiquidationNotionalUsd += liquidatedNotional;

          const closeRes = feeCfg.calculateCloseFee
            ? feeCfg.calculateCloseFee(liquidatedNotional, { execMode: exitExecMode })
            : { fee: liquidatedNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
          const closeFee =
            closeRes.breakdown?.baseFee ??
            closeRes.fee ??
            liquidatedNotional * (feeCfg.closeFeeBps / 10_000);

          const other =
            feeCfg.model === "drift"
              ? getOtherPerpFees(pos.market || marketName)
              : { liquidatorFee: 0, insuranceFee: 0 };
          const liquidatorFeeUsd =
            feeCfg.model === "drift" ? liquidatedNotional * (other.liquidatorFee || 0) : 0;
          const insuranceFeeUsd =
            feeCfg.model === "drift" ? liquidatedNotional * (other.insuranceFee || 0) : 0;
          const txFee = calculateSolanaTransactionFees(tickPrice, feeCfg);
          const liqFees = closeFee + liquidatorFeeUsd + insuranceFeeUsd + txFee;
          partialLiquidationFeesUsd += liqFees;

          // Fees reduce account equity (realised PnL), but PnL from mark doesn’t change by reducing size.
          realisedPnl -= liqFees;
          totalFees += liqFees;
          feeBreakdown.closeFees += closeFee;
          feeBreakdown.txFees += txFee;
          feeBreakdown.liquidatorFees += liquidatorFeeUsd;
          feeBreakdown.insuranceFees += insuranceFeeUsd;

          // Resize position
          const remainingFrac = remainingNotional / Math.max(1e-9, notional);
          pos.quantity = qty * remainingFrac;
          pos.sizeUsd = (Number.isFinite(pos.sizeUsd) ? pos.sizeUsd : notional) * remainingFrac;
          const initRatioAfter = getInitRatio(pos.market || marketName, remainingNotional);
          const newCollateral = remainingNotional * initRatioAfter;
          pos.collateral = Math.max(0, Math.min(collateral, newCollateral));
          pos.leverage =
            pos.collateral > 0 ? remainingNotional / pos.collateral : pos.leverage || leverage;
          pos.partialLiquidations = (pos.partialLiquidations || 0) + 1;

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "liquidation_partial",
              ts: tickTs,
              market: marketName,
              barIndex,
              tickIndex,
              price: tickPrice,
              rsi: strategy.rsi,
              atr: strategy.atr,
              action: "reduce",
              side: pos.side,
              reason: "partial_liquidation",
              positionId: pos.positionId || pos.id,
              fillPrice: tickPrice,
              extra: {
                liquidatedNotionalUsd: liquidatedNotional,
                remainingNotionalUsd: remainingNotional,
                feesUsd: liqFees,
              },
            });
          }

          currentEquity = initialCapital + realisedPnl;
          continue; // Skip other exit checks for this position
        }

        if (trace) {
          trace.push({
            model: traceModel,
            kind: "exit",
            ts: tickTs,
            market: marketName,
            barIndex,
            tickIndex,
            price: tickPrice,
            rsi: strategy.rsi,
            atr: strategy.atr,
            action: "close",
            side: pos.side,
            reason: "liquidation",
            positionId: pos.positionId || pos.id,
            fillPrice: exitPrice,
            stopPrice: liqPrice,
            extra: { liquidationPrice: liqPrice, tickPrice, collateralLost: pos.collateral },
          });
        }

        positions.splice(positions.indexOf(pos), 1);
        trades.push(pnl);

        currentEquity = initialCapital + realisedPnl;
        continue; // Skip other exit checks for this position
      }

      // Hard stop per tick (fixed stop level from entry ATR).
      const hardStopLevel = Number.isFinite(pos._hardStopLevel) ? pos._hardStopLevel : null;
      if (hardStopLevel) {
        const hit =
          (pos.side === "long" && tickPrice <= hardStopLevel) ||
          (pos.side === "short" && tickPrice >= hardStopLevel);
        if (hit) {
          // Use WORSE of (stop level, tick price) for realistic gap-through behavior
          // In reality, if price gaps through your stop, you get filled at market price
          const exitPrice =
            pos.side === "long"
              ? Math.min(hardStopLevel, tickPrice) // For longs, lower = worse
              : Math.max(hardStopLevel, tickPrice); // For shorts, higher = worse
          const exitReason = "rsi_hard_stop";
          const pnl = exitPosition(pos, exitPrice, tickTs, { reason: exitReason });

          // Hard stop = always taker (emergency exit)
          const exitExecMode = "taker";
          if (feeCfg.execMode === "maker") makerExitStats.forcedTaker++;

          const currentNotional = pos.quantity * exitPrice;
          const closeRes = feeCfg.calculateCloseFee
            ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
            : { fee: currentNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
          const closeFee =
            closeRes.breakdown?.baseFee ??
            closeRes.fee ??
            currentNotional * (feeCfg.closeFeeBps / 10_000);
          // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
          const impactFee =
            feeCfg.model === "drift"
              ? 0
              : calculatePriceImpactFee(currentNotional, feeCfg.priceImpactFeeScalar);
          const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
          const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
          const borrowFee =
            feeCfg.model === "drift"
              ? 0
              : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, tickTs - lastBorrowTs));
          const txFee = calculateSolanaTransactionFees(exitPrice, feeCfg);

          // Funding fee (Drift only) - uses historical rates if available
          const fundingFee = calculateFundingCostForPosition(
            pos.market,
            pos.side,
            pos.sizeUsd,
            pos.openTime,
            tickTs
          );

          const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;

          totalFees += totalExitFees;
          feeBreakdown.closeFees += closeFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.swapFees += swapFee;
          feeBreakdown.borrowFees += borrowFee;
          feeBreakdown.fundingFees += fundingFee;
          feeBreakdown.txFees += txFee;
          feeBreakdown.totalTrades++;

          pnl.pnlUsd -= totalExitFees;
          pnl.fees = { closeFee, impactFee, swapFee, borrowFee, fundingFee, txFee, exitExecMode };
          pnl.exitRsi = strategy.rsi;
          pnl.exitReason = exitReason;

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "exit",
              ts: tickTs,
              market: marketName,
              barIndex,
              tickIndex,
              price: tickPrice,
              rsi: strategy.rsi,
              atr: strategy.atr,
              action: "close",
              side: pos.side,
              reason: "rsi_hard_stop",
              positionId: pos.positionId || pos.id,
              fillPrice: exitPrice,
              stopPrice: hardStopLevel,
              extra: { stopLevel: hardStopLevel, tickPrice, realisticExitPrice: exitPrice },
            });
          }

          realisedPnl += pnl.pnlUsd;
          positions.splice(positions.indexOf(pos), 1);
          trades.push(pnl);

          currentEquity = initialCapital + realisedPnl;
          const slippageInfo =
            exitPrice !== hardStopLevel ? ` (slipped from $${hardStopLevel.toFixed(2)})` : "";
          if (debug)
            console.log(
              `[HARD-STOP] ${pos.side} @ $${exitPrice.toFixed(2)}${slippageInfo} | PnL: $${pnl.pnlUsd.toFixed(2)}`
            );
          strategy.recordTrade({
            pnlUsd: pnl.pnlUsd,
            pnlPercent: pnl.pnlPct / 100,
            exitReason: "rsi_hard_stop",
          });
          continue;
        }
      }

      // Trailing stop per tick (price-based profit protection)
      if (strategy?.cfg?.rsiEnableTrailingStop) {
        updateTrailingWatermarks(pos, tickPrice);
        const trailingSignal = strategy.shouldClose(pos, tickPrice, barIndex);
        if (trailingSignal && trailingSignal.reason === "rsi_trailing_stop") {
          const trailStopPrice = Number.isFinite(trailingSignal.trailStopPrice)
            ? trailingSignal.trailStopPrice
            : tickPrice;
          const exitPrice =
            pos.side === "long"
              ? Math.min(trailStopPrice, tickPrice)
              : Math.max(trailStopPrice, tickPrice);
          const exitReason = "rsi_trailing_stop";
          const pnl = exitPosition(pos, exitPrice, tickTs, { reason: exitReason });

          // Trailing stop = taker (emergency exit)
          const exitExecMode = "taker";
          if (feeCfg.execMode === "maker") makerExitStats.forcedTaker++;

          const currentNotional = pos.quantity * exitPrice;
          const closeRes = feeCfg.calculateCloseFee
            ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
            : { fee: currentNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
          const closeFee =
            closeRes.breakdown?.baseFee ??
            closeRes.fee ??
            currentNotional * (feeCfg.closeFeeBps / 10_000);
          // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
          const impactFee =
            feeCfg.model === "drift"
              ? 0
              : calculatePriceImpactFee(currentNotional, feeCfg.priceImpactFeeScalar);
          const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
          const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
          const borrowFee =
            feeCfg.model === "drift"
              ? 0
              : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, tickTs - lastBorrowTs));
          const txFee = calculateSolanaTransactionFees(exitPrice, feeCfg);

          // Funding fee (Drift only) - uses historical rates if available
          const fundingFee = calculateFundingCostForPosition(
            pos.market,
            pos.side,
            pos.sizeUsd,
            pos.openTime,
            tickTs
          );

          const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;

          totalFees += totalExitFees;
          feeBreakdown.closeFees += closeFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.swapFees += swapFee;
          feeBreakdown.borrowFees += borrowFee;
          feeBreakdown.fundingFees += fundingFee;
          feeBreakdown.txFees += txFee;
          feeBreakdown.totalTrades++;

          pnl.pnlUsd -= totalExitFees;
          pnl.fees = { closeFee, impactFee, swapFee, borrowFee, fundingFee, txFee, exitExecMode };
          pnl.exitRsi = strategy.rsi;
          pnl.exitReason = exitReason;

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "exit",
              ts: tickTs,
              market: marketName,
              barIndex,
              tickIndex,
              price: tickPrice,
              rsi: strategy.rsi,
              atr: strategy.atr,
              action: "close",
              side: pos.side,
              reason: "rsi_trailing_stop",
              positionId: pos.positionId || pos.id,
              fillPrice: exitPrice,
              stopPrice: trailStopPrice,
              extra: {
                stopLevel: trailStopPrice,
                tickPrice,
                trailMethod: trailingSignal.trailMethod ?? null,
              },
            });
          }

          realisedPnl += pnl.pnlUsd;
          positions.splice(positions.indexOf(pos), 1);
          trades.push(pnl);

          currentEquity = initialCapital + realisedPnl;
          if (debug)
            console.log(
              `[TRAILING-STOP] ${pos.side} @ $${exitPrice.toFixed(2)} | PnL: $${pnl.pnlUsd.toFixed(2)}`
            );
          strategy.recordTrade({
            pnlUsd: pnl.pnlUsd,
            pnlPercent: pnl.pnlPct / 100,
            exitReason: "rsi_trailing_stop",
          });
          continue;
        }
      }

      // RSI exits only at bar open (excluding hard stop).
      if (tickIndex !== 0) continue;
      const exit = strategy.shouldClose(pos, tickPrice);
      if (exit?.close && exit.reason !== "rsi_hard_stop") {
        const exitReason = exit.reason;
        const exitRefPrice = tickPrice;

        // Determine exit mode based on reason (RSI exits can use maker)
        const preferredExitMode = getExitExecModeForReason(exitReason, feeCfg.execMode);
        let exitExecMode = preferredExitMode;
        let filledExitPrice = exitRefPrice;
        let filledExitTs = tickTs;

        // Use intra-bar tick path + fallback timeout to decide if maker exit fills.
        if (
          feeCfg.model === "drift" &&
          feeCfg.execMode === "maker" &&
          preferredExitMode === "maker" &&
          process.env.ENABLE_MAKER_FILL_SIM === "true"
        ) {
          makerExitStats.attempts++;
          const exitSim = simulateDriftMakerExitFill({
            market: `${pos.market}-PERP`,
            strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
            side: pos.side,
            refPrice: exitRefPrice,
            candle, // used only if ticks not provided
            ticks: intraBarTicks,
            tickTimestamps,
            startTickIndex: tickIndex,
            tickIntervalMs: TICK_INTERVAL_MS,
            positionSizeUsd: pos.sizeUsd || 0, // AUDIT FIX: Pass size for degradation
          });
          exitExecMode = exitSim.execMode;
          filledExitPrice = exitSim.fillPrice ?? exitRefPrice;
          if (Number.isFinite(exitSim.fillTs)) filledExitTs = exitSim.fillTs;
          if (exitSim.outcome === "maker_fill") makerExitStats.makerFills++;
          if (exitSim.outcome === "taker_fallback") makerExitStats.takerFallbacks++;
        } else if (preferredExitMode === "taker" && feeCfg.execMode === "maker") {
          // Emergency exit - never tries maker
          makerExitStats.forcedTaker++;
          exitExecMode = "taker";
        }

        const pnl = exitPosition(pos, filledExitPrice, filledExitTs, { reason: exitReason });

        const currentNotional = pos.quantity * filledExitPrice;
        const closeRes = feeCfg.calculateCloseFee
          ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
          : { fee: currentNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
        const closeFee =
          closeRes.breakdown?.baseFee ??
          closeRes.fee ??
          currentNotional * (feeCfg.closeFeeBps / 10_000);
        // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
        const impactFee =
          feeCfg.model === "drift"
            ? 0
            : calculatePriceImpactFee(currentNotional, feeCfg.priceImpactFeeScalar);
        const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
        const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
        const borrowFee =
          feeCfg.model === "drift"
            ? 0
            : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, tickTs - lastBorrowTs));
        const txFee = calculateSolanaTransactionFees(filledExitPrice, feeCfg);

        // Funding fee (Drift only)
        const holdDurationMs = filledExitTs - pos.openTime;
        const fundingFee =
          typeof estimateFundingCost === "function"
            ? estimateFundingCost(
                pos.side,
                pos.sizeUsd,
                holdDurationMs,
                getMarketFundingRate(pos.market)
              )
            : 0;

        const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;

        totalFees += totalExitFees;
        feeBreakdown.closeFees += closeFee;
        feeBreakdown.impactFees += impactFee;
        feeBreakdown.swapFees += swapFee;
        feeBreakdown.borrowFees += borrowFee;
        feeBreakdown.fundingFees += fundingFee;
        feeBreakdown.txFees += txFee;
        feeBreakdown.totalTrades++;

        pnl.pnlUsd -= totalExitFees;
        pnl.fees = { closeFee, impactFee, swapFee, borrowFee, fundingFee, txFee, exitExecMode };
        pnl.exitRsi = strategy.rsi;
        pnl.exitReason = exit.reason;

        if (trace) {
          trace.push({
            model: traceModel,
            kind: "exit",
            ts: filledExitTs,
            market: marketName,
            barIndex,
            tickIndex,
            price: tickPrice,
            rsi: strategy.rsi,
            atr: strategy.atr,
            action: "close",
            side: pos.side,
            reason: exit.reason,
            positionId: pos.positionId || pos.id,
            fillPrice: filledExitPrice,
            stopPrice: null,
            extra: null,
          });
        }

        realisedPnl += pnl.pnlUsd;
        positions.splice(positions.indexOf(pos), 1);
        trades.push(pnl);

        currentEquity = initialCapital + realisedPnl;
        strategy.recordTrade({
          pnlUsd: pnl.pnlUsd,
          pnlPercent: pnl.pnlPct / 100,
          exitReason: exit.reason,
        });
      }
    }

    // Skip entries during warmup
    if (barIndex < warmupBars) continue;

    // Evaluate entry only at BAR OPEN (tickIndex=0) using RSI from previous bar close.
    if (tickIndex === 0 && positions.length < maxPositions && Number.isFinite(strategy.rsi)) {
      const signal = strategy.getSignal(candle.open, positions, false, globalTick);
      if (trace) {
        trace.push({
          model: traceModel,
          kind: "signal",
          ts: candle.openTime,
          market: marketName,
          barIndex,
          tickIndex: 0,
          price: candle.open,
          rsi: strategy.rsi,
          atr: strategy.atr,
          action: signal?.action ?? null,
          side: signal?.side ?? null,
          confidence: signal?.confidence ?? null,
          reason: signal?.reason ?? null,
        });
      }

      if (signal?.action === "open") {
        const side = String(signal.side || "").toLowerCase();
        if ((side === "long" && !allowLongs) || (side === "short" && !allowShorts)) continue;

        const available = getAvailableCapital();
        let collateral = Math.min(getPositionSize(), available);
        if (collateral <= 0) continue;

        let sizeUsd = collateral * leverage;

        // AUDIT FIX: Apply liquidity constraint / position size cap
        // Disabled by default - enable with ENABLE_LIQUIDITY_CAPS=true
        if (process.env.ENABLE_LIQUIDITY_CAPS === "true") {
          const tradeCheck = shouldSkipTrade(marketName, sizeUsd, { strict: false });
          if (tradeCheck.skip) continue;
          if (tradeCheck.capped) {
            sizeUsd = tradeCheck.cappedSize;
            collateral = sizeUsd / leverage;
          }
        }

        const qty = sizeUsd / candle.open;

        // Simulate maker entry fill (Drift only)
        let entryExecMode = feeCfg.execMode;
        let filledEntryPrice = candle.open;
        if (
          feeCfg.model === "drift" &&
          feeCfg.execMode === "maker" &&
          process.env.ENABLE_MAKER_FILL_SIM === "true"
        ) {
          makerEntryStats.attempts++;
          const entrySim = simulateDriftMakerEntryFill({
            market: marketName,
            strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
            side,
            refPrice: candle.open,
            candle,
            positionSizeUsd: sizeUsd, // AUDIT FIX: Pass size for degradation
          });
          entryExecMode = entrySim.execMode;
          filledEntryPrice = entrySim.fillPrice || candle.open;
          if (entrySim.outcome === "maker_fill") makerEntryStats.makerFills++;
          if (entrySim.outcome === "taker_fallback") makerEntryStats.takerFallbacks++;
        }

        const position = openPosition({
          id: `bot-${++tradeCounter}`,
          side,
          price: filledEntryPrice,
          ts: candle.openTime,
          sizeUsd,
          leverage,
        });
        if (!position) continue;

        // Entry fees based on actual exec mode
        const openRes = feeCfg.calculateOpenFee
          ? feeCfg.calculateOpenFee(sizeUsd, { execMode: entryExecMode })
          : { fee: sizeUsd * (feeCfg.openFeeBps / 10_000), breakdown: {} };
        const openFee =
          openRes.breakdown?.baseFee ?? openRes.fee ?? sizeUsd * (feeCfg.openFeeBps / 10_000);
        const impactFee =
          feeCfg.model === "drift"
            ? 0
            : calculatePriceImpactFee(sizeUsd, feeCfg.priceImpactFeeScalar);
        const txFee = calculateSolanaTransactionFees(filledEntryPrice, feeCfg);
        totalFees += openFee + impactFee + txFee;
        realisedPnl -= openFee + impactFee + txFee;
        feeBreakdown.openFees += openFee;
        feeBreakdown.impactFees += impactFee;
        feeBreakdown.txFees += txFee;

        position.entryFees = {
          openFee,
          impactFee,
          txFee,
          total: openFee + impactFee + txFee,
          execMode: entryExecMode,
        };
        position.entryRsi = strategy.rsi;
        position.entryAtr = Number.isFinite(strategy.atr) ? strategy.atr : null;
        position.openBarIndex = barIndex;
        position.entryReason = signal.reason || "rsi_signal";
        // Fixed hard stop level from ENTRY (used for per-tick stops)
        // NOTE: Percent-based stops work without ATR; ATR-based stops need ATR.
        // We must set _hardStopLevel here for per-tick stop checks to work.
        const hasPercentStop =
          strategy.cfg?.rsiHardStopEnabled &&
          Number.isFinite(strategy.cfg.rsiHardStopPercent) &&
          strategy.cfg.rsiHardStopPercent > 0;
        const hasAtrStop =
          strategy.cfg?.rsiHardStopEnabled &&
          Number.isFinite(strategy.cfg.rsiHardStopAtr) &&
          strategy.cfg.rsiHardStopAtr > 0 &&
          Number.isFinite(position.entryAtr);
        if (hasPercentStop || hasAtrStop) {
          const dist = computeHardStopDistance({
            entryPrice: position.entryPrice,
            side: position.side,
            leverage: position.leverage || leverage,
            hardStopEnabled: true,
            hardStopPercent: strategy.cfg.rsiHardStopPercent,
            hardStopAtrMult: strategy.cfg.rsiHardStopAtr,
            atr: position.entryAtr,
          });
          if (Number.isFinite(dist) && dist > 0) {
            position._hardStopLevel =
              position.side === "long" ? position.entryPrice - dist : position.entryPrice + dist;
          }
        }
        positions.push(position);

        if (trace) {
          trace.push({
            model: traceModel,
            kind: "entry",
            ts: candle.openTime,
            market: marketName,
            barIndex,
            tickIndex: 0,
            price: candle.open,
            rsi: position.entryRsi,
            atr: position.entryAtr,
            action: "open",
            side: position.side,
            confidence: signal?.confidence ?? null,
            reason: position.entryReason,
            positionId: position.positionId || position.id,
            fillPrice: candle.open,
          });
        }
      }
    }

    // Equity snapshot at bar close
    const closePrice = candle.close;
    let unrealised = 0;
    for (const pos of positions) {
      const dir = pos.side === "long" ? 1 : -1;
      unrealised += dir * (closePrice - pos.entryPrice) * pos.quantity;
    }
    equitySeries.push(initialCapital + realisedPnl + unrealised);

    if (verbose && barIndex % 50 === 0) {
      console.log(
        `[BOT-MODEL ${barIndex}] RSI=${strategy.rsi?.toFixed(1)} ATR=${strategy.atr?.toFixed(4)} price=${closePrice.toFixed(2)}`
      );
    }
  }

  // Force close remaining
  for (const pos of [...positions]) {
    const last = candles[candles.length - 1];
    const exitPrice = last.close;
    const ts = last.closeTime;
    const pnl = exitPosition(pos, exitPrice, ts, { reason: "end_of_backtest" });
    trades.push(pnl);
    positions.splice(positions.indexOf(pos), 1);
  }

  return {
    trades,
    realisedPnl,
    totalFees,
    feeBreakdown,
    makerEntryStats,
    makerExitStats,
    equitySeries,
    initialCapital,
  };
}

function simulateBotRuntimeMultiMarket(strategiesMap, candlesMap, options = {}) {
  const {
    initialCapital = 1000,
    leverage = 5,
    positionSizePercent = 75,
    enableCompounding = true,
    debug = false,
    allowLongs = true,
    allowShorts = true,
    maxPositions = 1,
    ticksPerCandle = TICKS_PER_5MIN_CANDLE,
    simulateTicks = true,
  } = options;

  const trace = options._trace;
  const traceModel = "bot";

  // Deterministic allocator config for backtests
  // Include riskRecommendation config so allocator.recommendRisk() can adjust size/leverage/stops
  const allocator =
    options.allocatorUseBotScoring !== false
      ? new MarketAllocator({
          markets: Array.from(candlesMap.keys()).map((m) => `${m}-PERP`),
          exploreProbability: options.allocatorExploreProbability ?? 0,
          riskRecommendation: {
            enabled: options.allocatorRiskEnabled ?? false,
            neutral: options.allocatorRiskNeutral ?? false,
          },
        })
      : null;

  // Fee configuration - uses FEE_MODEL env var (jupiter or drift)
  const feeCfg = buildFeeCfg();

  const allTrades = [];
  const allPositions = [];
  const equitySeries = [];
  let realisedPnl = 0;
  let totalFees = 0;
  let tradeCounter = 0;

  const feeBreakdown = {
    openFees: 0,
    closeFees: 0,
    impactFees: 0,
    swapFees: 0,
    borrowFees: 0,
    fundingFees: 0,
    slippageUsd: 0,
    slippageEntryUsd: 0,
    slippageExitUsd: 0,
    liquidatorFees: 0,
    insuranceFees: 0,
    txFees: 0,
    totalTrades: 0,
  };
  const makerEntryStats = { attempts: 0, makerFills: 0, takerFallbacks: 0, noFills: 0 };
  const makerExitStats = {
    attempts: 0,
    makerFills: 0,
    takerFallbacks: 0,
    forcedTaker: 0,
    noFills: 0,
  };
  const marketResults = new Map();
  for (const m of candlesMap.keys())
    marketResults.set(m, { trades: [], totalPnL: 0, totalFees: 0 });

  const getLockedCollateral = () => allPositions.reduce((s, p) => s + (p.collateral || 0), 0);
  const getAvailableCapital = () => {
    const locked = getLockedCollateral();
    const base = enableCompounding ? initialCapital + realisedPnl : initialCapital;
    return Math.max(0, base - locked);
  };
  const getPositionCollateral = () => {
    const base = getAvailableCapital() * (positionSizePercent / 100);
    return Math.max(0, Math.min(base, options.maxPositionSize || 5000));
  };

  // Build unified timestamp set (5m bar opens)
  const allTimestamps = new Set();
  const candleIndexMaps = new Map();
  for (const [market, candles] of candlesMap.entries()) {
    const idxMap = new Map();
    for (let i = 0; i < candles.length; i++) {
      idxMap.set(candles[i].openTime, i);
      allTimestamps.add(candles[i].openTime);
    }
    candleIndexMaps.set(market, idxMap);
  }
  const timestamps = Array.from(allTimestamps).sort((a, b) => a - b);

  const currentPrices = new Map();
  let globalTick = 0;

  // Liquidation simulation (Drift): per-market maintenance ratios + IMF (approx), with partial liquidations.
  // Source table: https://docs.drift.trade/trading/margin
  const enableLiquidationCheck = options.enableLiquidationCheck !== false;
  const DEFAULT_MAINT_RATIO_FALLBACK =
    (Number(process.env.DRIFT_MAINTENANCE_MARGIN_PCT) || 5) / 100;
  let liquidationCount = 0;
  let liquidationLoss = 0;
  let partialLiquidationCount = 0;
  let partialLiquidationNotionalUsd = 0;
  let partialLiquidationFeesUsd = 0;

  const getMaintRatio = (marketSym, notionalUsd) => {
    const eff = getEffectiveMarginRatios(marketSym, notionalUsd);
    const r = eff?.maintenanceMarginRatio;
    return Number.isFinite(r) && r > 0 ? r : DEFAULT_MAINT_RATIO_FALLBACK;
  };
  const getInitRatio = (marketSym, notionalUsd, levFallback) => {
    const eff = getEffectiveMarginRatios(marketSym, notionalUsd);
    const r = eff?.initialMarginRatio;
    if (Number.isFinite(r) && r > 0) return r;
    const lev = Math.max(1, Number.isFinite(levFallback) ? levFallback : leverage);
    return Math.min(1, 1 / lev);
  };

  const isLiquidated = (pos, px) => {
    if (!enableLiquidationCheck) return false;
    if (!pos || !Number.isFinite(px) || px <= 0) return false;
    const qty = Number(pos.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return false;
    const notional = qty * px;
    const dir = pos.side === "long" ? 1 : -1;
    const rawPnl = dir * (px - pos.entryPrice) * qty;
    const collateral = Number.isFinite(pos.collateral) ? pos.collateral : 0;
    const equity = Math.max(0, collateral + rawPnl);
    const maintReq = getMaintRatio(pos.market || `${pos.marketKey}-PERP`, notional) * notional;
    return equity < maintReq;
  };

  for (let tIdx = 0; tIdx < timestamps.length; tIdx++) {
    const ts = timestamps[tIdx];

    // Current candles for markets at this bar open
    const marketCandles = new Map();
    for (const [market, candles] of candlesMap.entries()) {
      const idxMap = candleIndexMaps.get(market);
      const cIdx = idxMap.get(ts);
      if (cIdx === undefined) continue;
      marketCandles.set(market, candles[cIdx]);

      // Feed completed previous bar into strategy.update at boundary
      if (cIdx > 0) {
        const prev = candles[cIdx - 1];
        const strategy = strategiesMap.get(market);
        if (strategy) {
          strategy.update({
            price: prev.close,
            close: prev.close,
            high: prev.high,
            low: prev.low,
            volume: prev.quoteVolume || prev.volume || 0,
            ts: prev.closeTime,
          });
          if (trace) {
            trace.push({
              model: traceModel,
              kind: "bar_close_update",
              ts: prev.closeTime,
              market: `${market}-PERP`,
              barIndex: cIdx - 1,
              tickIndex: ticksPerCandle - 1,
              price: prev.close,
              rsi: strategy.rsi,
              atr: strategy.atr,
            });
          }
        }
      }
    }

    // Generate ticks for each market candle (NO LOOK-AHEAD):
    // Use real 1m candles → 15s ticks. Never synthesize from 5m OHLC.
    const marketTicks = new Map();
    const oneMinCandlesMap = options.oneMinCandlesMap;
    const ticksByBarOpenTimeMap = options.ticksByBarOpenTimeMap;
    for (const [market, candle] of marketCandles.entries()) {
      if (simulateTicks) {
        if (!oneMinCandlesMap || !(oneMinCandlesMap instanceof Map)) {
          throw new Error(
            "[NO-LOOKAHEAD] simulateTicks requested but oneMinCandlesMap not provided"
          );
        }
        const barStart = candle.openTime;
        const cached =
          ticksByBarOpenTimeMap instanceof Map
            ? ticksByBarOpenTimeMap.get(market)?.get(barStart)
            : null;
        if (cached && cached.length > 0) {
          marketTicks.set(market, cached);
        } else {
          const oneMin = oneMinCandlesMap.get(market) || [];
          const matching = oneMin.filter(
            (c) => c.openTime >= candle.openTime && c.openTime < candle.closeTime
          );
          if (matching.length >= 4) {
            marketTicks.set(market, generateTicksFrom1MinCandles(matching));
          } else {
            // Graceful fallback for incomplete 1m data (e.g., at fold boundaries)
            marketTicks.set(market, generateTicksFromOHLC(candle));
          }
        }
      } else {
        marketTicks.set(market, [{ price: candle.close, ts: candle.closeTime }]);
      }
      if (!currentPrices.has(market)) currentPrices.set(market, candle.open);
    }

    // Bar-open traces
    if (trace) {
      for (const [market, candle] of marketCandles.entries()) {
        const strategy = strategiesMap.get(market);
        trace.push({
          model: traceModel,
          kind: "bar_open",
          ts: candle.openTime,
          market: `${market}-PERP`,
          barIndex: candleIndexMaps.get(market).get(ts),
          tickIndex: 0,
          price: candle.open,
          rsi: strategy?.rsi ?? null,
          atr: strategy?.atr ?? null,
        });
      }
    }

    // Tick loop
    for (let tickIndex = 0; tickIndex < ticksPerCandle; tickIndex++) {
      globalTick++;

      // Update current prices
      for (const [market, ticks] of marketTicks.entries()) {
        const t = ticks[tickIndex] ?? ticks[ticks.length - 1];
        const px = typeof t === "number" ? t : t?.price;
        currentPrices.set(market, px);
      }

      // Production parity mode: RSI updates only on bar close, so no intra-bar recalc.
      // updateTick can still run for other indicators/metrics but should not mutate RSI.
      for (const [market, candle] of marketCandles.entries()) {
        const strategy = strategiesMap.get(market);
        if (!strategy) continue;
        const tickPrice = currentPrices.get(market);
        const tickTs =
          candle.openTime + tickIndex * (intervalToMs(options.interval || "5m") / ticksPerCandle);

        if (typeof strategy.updateTick === "function") {
          strategy.updateTick({ price: tickPrice, volume: 0, ts: tickTs });
        }
      }

      // Exits:
      // - Liquidation checks happen on every tick (margin breach)
      // - Hard stops can happen on any tick (per tick).
      // - RSI-based exits are evaluated only at BAR OPEN (tickIndex=0).
      for (const pos of [...allPositions]) {
        const market = pos.marketKey;
        const strategy = strategiesMap.get(market);
        const tickPrice = currentPrices.get(market) || pos.entryPrice;
        const candle = marketCandles.get(market);
        const tickTs = candle
          ? candle.openTime + tickIndex * (intervalToMs(options.interval || "5m") / ticksPerCandle)
          : ts;

        updateTrailingWatermarks(pos, tickPrice);

        // ============================================================
        // LIQUIDATION CHECK (before hard stop - liquidation takes precedence)
        // ============================================================
        if (enableLiquidationCheck && isLiquidated(pos, tickPrice)) {
          const qty = Number(pos.quantity);
          const notional = Number.isFinite(qty) && Number.isFinite(tickPrice) ? qty * tickPrice : 0;
          const dir = pos.side === "long" ? 1 : -1;
          const rawPnl = dir * (tickPrice - pos.entryPrice) * qty;
          const collateral = Number.isFinite(pos.collateral) ? pos.collateral : 0;
          const equity = Math.max(0, collateral + rawPnl);

          const exitExecMode = "taker";
          if (feeCfg.execMode === "maker") makerExitStats.forcedTaker++;

          // Compute remaining notional to restore initial margin health
          let remainingNotional = notional;
          if (equity > 0 && notional > 0) {
            for (let i = 0; i < 6; i++) {
              const initRatio = getInitRatio(
                pos.market || `${market}-PERP`,
                remainingNotional,
                pos.leverage || leverage
              );
              const allowed = equity / Math.max(1e-9, initRatio);
              const next = Math.max(0, Math.min(remainingNotional, allowed));
              if (
                remainingNotional > 0 &&
                Math.abs(next - remainingNotional) / remainingNotional < 0.01
              ) {
                remainingNotional = next;
                break;
              }
              remainingNotional = next;
            }
          }

          const liquidatedNotional = Math.max(0, notional - remainingNotional);
          const frac = notional > 0 ? liquidatedNotional / notional : 1;
          const doFull = equity <= 0 || frac >= 0.999;

          if (doFull) {
            const exitPrice = tickPrice;
            const exitReason = "liquidation";
            const grossPnl = -collateral; // conservative: collateral wiped

            liquidationCount++;
            liquidationLoss += collateral;

            const currentNotional = notional;
            const closeRes = feeCfg.calculateCloseFee
              ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
              : { fee: currentNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
            const closeFee =
              closeRes.breakdown?.baseFee ??
              closeRes.fee ??
              currentNotional * (feeCfg.closeFeeBps / 10_000);

            const other =
              feeCfg.model === "drift"
                ? getOtherPerpFees(pos.market || `${market}-PERP`)
                : { liquidatorFee: 0, insuranceFee: 0 };
            const liquidatorFeeUsd =
              feeCfg.model === "drift" ? currentNotional * (other.liquidatorFee || 0) : 0;
            const insuranceFeeUsd =
              feeCfg.model === "drift" ? currentNotional * (other.insuranceFee || 0) : 0;

            const fundingFee = calculateFundingCostForPosition(
              pos.market,
              pos.side,
              pos.sizeUsd,
              pos.openTime,
              tickTs
            );

            const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;
            const totalExitFees =
              closeFee + liquidatorFeeUsd + insuranceFeeUsd + txFee - fundingFee;

            totalFees += totalExitFees;
            feeBreakdown.closeFees += closeFee;
            feeBreakdown.fundingFees += fundingFee;
            feeBreakdown.txFees += txFee;
            feeBreakdown.liquidatorFees += liquidatorFeeUsd;
            feeBreakdown.insuranceFees += insuranceFeeUsd;
            feeBreakdown.totalTrades++;

            const netPnl = grossPnl - totalExitFees;
            realisedPnl += netPnl;

            const pnl = {
              id: pos.id,
              market: pos.market,
              symbol: market,
              side: pos.side,
              quantity: qty,
              entryPrice: pos.entryPrice,
              exitPrice,
              openTime: pos.openTime,
              exitTime: tickTs,
              grossPnl,
              pnlUsd: netPnl,
              fees: {
                closeFee,
                fundingFee,
                liquidatorFeeUsd,
                insuranceFeeUsd,
                txFee,
                exitExecMode,
              },
              exitReason,
              sizeUsd: pos.sizeUsd,
              collateral,
              leverage: pos.leverage,
              entryFee: pos.entryFee || 0,
              exitFee: totalExitFees,
              exitRsi: strategy?.rsi ?? null,
              liquidationPrice: null,
              liquidationType: "full",
            };

            marketResults.get(market).trades.push(pnl);
            marketResults.get(market).totalPnL += netPnl;
            marketResults.get(market).totalFees += totalExitFees;
            allTrades.push(pnl);

            if (trace) {
              trace.push({
                model: traceModel,
                kind: "exit",
                ts: tickTs,
                market: `${market}-PERP`,
                barIndex: candleIndexMaps.get(market).get(ts),
                tickIndex,
                price: tickPrice,
                rsi: strategy?.rsi ?? null,
                atr: strategy?.atr ?? null,
                action: "close",
                side: pos.side,
                reason: "liquidation",
                positionId: pos.id,
                fillPrice: exitPrice,
                stopPrice: null,
                extra: { tickPrice, collateralLost: collateral, liquidationType: "full" },
              });
            }

            // Remove the position
            const idxPos = allPositions.indexOf(pos);
            if (idxPos !== -1) allPositions.splice(idxPos, 1);
            continue;
          }

          // Partial liquidation
          partialLiquidationCount++;
          partialLiquidationNotionalUsd += liquidatedNotional;

          const closeRes = feeCfg.calculateCloseFee
            ? feeCfg.calculateCloseFee(liquidatedNotional, { execMode: exitExecMode })
            : { fee: liquidatedNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
          const closeFee =
            closeRes.breakdown?.baseFee ??
            closeRes.fee ??
            liquidatedNotional * (feeCfg.closeFeeBps / 10_000);

          const other =
            feeCfg.model === "drift"
              ? getOtherPerpFees(pos.market || `${market}-PERP`)
              : { liquidatorFee: 0, insuranceFee: 0 };
          const liquidatorFeeUsd =
            feeCfg.model === "drift" ? liquidatedNotional * (other.liquidatorFee || 0) : 0;
          const insuranceFeeUsd =
            feeCfg.model === "drift" ? liquidatedNotional * (other.insuranceFee || 0) : 0;
          const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;
          const liqFees = closeFee + liquidatorFeeUsd + insuranceFeeUsd + txFee;
          partialLiquidationFeesUsd += liqFees;

          // Apply fee impact
          realisedPnl -= liqFees;
          totalFees += liqFees;
          feeBreakdown.closeFees += closeFee;
          feeBreakdown.txFees += txFee;
          feeBreakdown.liquidatorFees += liquidatorFeeUsd;
          feeBreakdown.insuranceFees += insuranceFeeUsd;
          marketResults.get(market).totalPnL -= liqFees;
          marketResults.get(market).totalFees += liqFees;

          // Resize position
          const remainingFrac = remainingNotional / Math.max(1e-9, notional);
          pos.quantity = qty * remainingFrac;
          pos.sizeUsd = (Number.isFinite(pos.sizeUsd) ? pos.sizeUsd : notional) * remainingFrac;
          const initRatioAfter = getInitRatio(
            pos.market || `${market}-PERP`,
            remainingNotional,
            pos.leverage || leverage
          );
          pos.collateral = Math.max(0, remainingNotional * initRatioAfter);
          pos.leverage =
            pos.collateral > 0 ? remainingNotional / pos.collateral : pos.leverage || leverage;
          pos.partialLiquidations = (pos.partialLiquidations || 0) + 1;

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "liquidation_partial",
              ts: tickTs,
              market: `${market}-PERP`,
              barIndex: candleIndexMaps.get(market).get(ts),
              tickIndex,
              price: tickPrice,
              rsi: strategy?.rsi ?? null,
              atr: strategy?.atr ?? null,
              action: "reduce",
              side: pos.side,
              reason: "partial_liquidation",
              positionId: pos.id,
              fillPrice: tickPrice,
              extra: {
                liquidatedNotionalUsd: liquidatedNotional,
                remainingNotionalUsd: remainingNotional,
                feesUsd: liqFees,
              },
            });
          }
          continue;
        }

        // Hard stop per tick (fixed stop level from entry ATR).
        const hardStopLevel = Number.isFinite(pos._hardStopLevel) ? pos._hardStopLevel : null;
        if (hardStopLevel) {
          const hit =
            (pos.side === "long" && tickPrice <= hardStopLevel) ||
            (pos.side === "short" && tickPrice >= hardStopLevel);
          if (hit) {
            // Use WORSE of (stop level, tick price) for realistic gap-through behavior
            // In reality, if price gaps through your stop, you get filled at market price
            const exitPrice =
              pos.side === "long"
                ? Math.min(hardStopLevel, tickPrice) // For longs, lower = worse
                : Math.max(hardStopLevel, tickPrice); // For shorts, higher = worse
            const exitReason = "rsi_hard_stop";

            // Hard stop = always taker (emergency exit)
            const exitExecMode = "taker";
            if (feeCfg.execMode === "maker") makerExitStats.forcedTaker++;

            const dir = pos.side === "long" ? 1 : -1;
            const grossPnl = dir * (exitPrice - pos.entryPrice) * pos.quantity;
            const currentNotional = pos.quantity * exitPrice;
            const closeRes = feeCfg.calculateCloseFee
              ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
              : { fee: (currentNotional * feeCfg.closeFeeBps) / 10000, breakdown: {} };
            const closeFee =
              closeRes.breakdown?.baseFee ??
              closeRes.fee ??
              (currentNotional * feeCfg.closeFeeBps) / 10000;
            // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
            const impactFee =
              feeCfg.model === "drift" ? 0 : calculatePriceImpactFee(currentNotional);
            const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
            const lastBorrowTs = Number.isFinite(pos.lastBorrowTs)
              ? pos.lastBorrowTs
              : pos.openTime;
            const borrowFee =
              feeCfg.model === "drift"
                ? 0
                : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, tickTs - lastBorrowTs));
            const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;

            // Funding fee (Drift only)
            const holdDurationMs = tickTs - pos.openTime;
            const fundingFee =
              typeof estimateFundingCost === "function"
                ? estimateFundingCost(
                    pos.side,
                    pos.sizeUsd,
                    holdDurationMs,
                    getMarketFundingRate(market)
                  )
                : 0;

            const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;
            const netPnl = grossPnl - totalExitFees;

            realisedPnl += netPnl;
            totalFees += totalExitFees;
            feeBreakdown.closeFees += closeFee;
            feeBreakdown.impactFees += impactFee;
            feeBreakdown.swapFees += swapFee;
            feeBreakdown.borrowFees += borrowFee;
            feeBreakdown.fundingFees += fundingFee;
            feeBreakdown.txFees += txFee;
            feeBreakdown.totalTrades++;

            const trade = {
              id: pos.id,
              market: `${market}-PERP`,
              side: pos.side,
              entryPrice: pos.entryPrice,
              exitPrice,
              entryRsi: pos.entryRsi,
              exitRsi: strategy?.rsi ?? null,
              openTime: pos.openTime,
              exitTime: tickTs,
              sizeUsd: pos.sizeUsd,
              quantity: pos.quantity,
              leverage: pos.leverage,
              collateral: pos.collateral,
              grossPnl,
              pnlUsd: netPnl,
              totalPnlUsd: netPnl,
              pnlPct: (netPnl / pos.collateral) * 100,
              exitReason: "rsi_hard_stop",
            };

            if (trace) {
              trace.push({
                model: traceModel,
                kind: "exit",
                ts: tickTs,
                market: `${market}-PERP`,
                barIndex: candleIndexMaps.get(market)?.get(ts) ?? null,
                tickIndex,
                price: tickPrice,
                rsi: strategy?.rsi ?? null,
                atr: strategy?.atr ?? null,
                action: "close",
                side: pos.side,
                reason: "rsi_hard_stop",
                positionId: pos.id,
                fillPrice: exitPrice,
                stopPrice: hardStopLevel,
                extra: { stopLevel: hardStopLevel, tickPrice },
              });
            }

            const idxPos = allPositions.indexOf(pos);
            if (idxPos >= 0) allPositions.splice(idxPos, 1);
            allTrades.push(trade);
            marketResults.get(market).trades.push(trade);
            marketResults.get(market).totalPnL += netPnl;
            // Keep strategy internal state consistent with backtest model (circuit breaker, stats)
            if (strategy && typeof strategy.recordTrade === "function") {
              strategy.recordTrade({
                pnlUsd: netPnl,
                pnlPercent: netPnl / pos.collateral,
                exitReason: trade.exitReason,
              });
            }
            continue;
          }
        }

        // Trailing stop per tick (price-based profit protection)
        if (strategy?.cfg?.rsiEnableTrailingStop) {
          const trailingSignal = strategy.shouldClose(pos, tickPrice, idx);
          if (trailingSignal && trailingSignal.reason === "rsi_trailing_stop") {
            const trailStopPrice = Number.isFinite(trailingSignal.trailStopPrice)
              ? trailingSignal.trailStopPrice
              : tickPrice;
            const exitPrice =
              pos.side === "long"
                ? Math.min(trailStopPrice, tickPrice)
                : Math.max(trailStopPrice, tickPrice);
            const exitReason = "rsi_trailing_stop";

            // Trailing stop = taker (emergency exit)
            const exitExecMode = "taker";
            if (feeCfg.execMode === "maker") makerExitStats.forcedTaker++;

            const dir = pos.side === "long" ? 1 : -1;
            const grossPnl = dir * (exitPrice - pos.entryPrice) * pos.quantity;
            const currentNotional = pos.quantity * exitPrice;
            const closeRes = feeCfg.calculateCloseFee
              ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
              : { fee: (currentNotional * feeCfg.closeFeeBps) / 10000, breakdown: {} };
            const closeFee =
              closeRes.breakdown?.baseFee ??
              closeRes.fee ??
              (currentNotional * feeCfg.closeFeeBps) / 10000;
            // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
            const impactFee =
              feeCfg.model === "drift" ? 0 : calculatePriceImpactFee(currentNotional);
            const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
            const lastBorrowTs = Number.isFinite(pos.lastBorrowTs)
              ? pos.lastBorrowTs
              : pos.openTime;
            const borrowFee =
              feeCfg.model === "drift"
                ? 0
                : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, tickTs - lastBorrowTs));
            const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;

            // Funding fee (Drift only)
            const holdDurationMs = tickTs - pos.openTime;
            const fundingFee =
              typeof estimateFundingCost === "function"
                ? estimateFundingCost(
                    pos.side,
                    pos.sizeUsd,
                    holdDurationMs,
                    getMarketFundingRate(market)
                  )
                : 0;

            const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;
            const netPnl = grossPnl - totalExitFees;

            realisedPnl += netPnl;
            totalFees += totalExitFees;
            feeBreakdown.closeFees += closeFee;
            feeBreakdown.impactFees += impactFee;
            feeBreakdown.swapFees += swapFee;
            feeBreakdown.borrowFees += borrowFee;
            feeBreakdown.fundingFees += fundingFee;
            feeBreakdown.txFees += txFee;
            feeBreakdown.totalTrades++;

            const trade = {
              id: pos.id,
              market: `${market}-PERP`,
              side: pos.side,
              entryPrice: pos.entryPrice,
              exitPrice,
              entryRsi: pos.entryRsi,
              exitRsi: strategy?.rsi ?? null,
              openTime: pos.openTime,
              exitTime: tickTs,
              sizeUsd: pos.sizeUsd,
              quantity: pos.quantity,
              leverage: pos.leverage,
              collateral: pos.collateral,
              grossPnl,
              pnlUsd: netPnl,
              totalPnlUsd: netPnl,
              pnlPct: (netPnl / pos.collateral) * 100,
              exitReason: "rsi_trailing_stop",
            };

            if (trace) {
              trace.push({
                model: traceModel,
                kind: "exit",
                ts: tickTs,
                market: `${market}-PERP`,
                barIndex: candleIndexMaps.get(market)?.get(ts) ?? null,
                tickIndex,
                price: tickPrice,
                rsi: strategy?.rsi ?? null,
                atr: strategy?.atr ?? null,
                action: "close",
                side: pos.side,
                reason: "rsi_trailing_stop",
                positionId: pos.id,
                fillPrice: exitPrice,
                stopPrice: trailStopPrice,
                extra: {
                  stopLevel: trailStopPrice,
                  tickPrice,
                  trailMethod: trailingSignal.trailMethod ?? null,
                },
              });
            }

            const idxPos = allPositions.indexOf(pos);
            if (idxPos >= 0) allPositions.splice(idxPos, 1);
            allTrades.push(trade);
            marketResults.get(market).trades.push(trade);
            marketResults.get(market).totalPnL += netPnl;
            if (strategy && typeof strategy.recordTrade === "function") {
              strategy.recordTrade({
                pnlUsd: netPnl,
                pnlPercent: netPnl / pos.collateral,
                exitReason: trade.exitReason,
              });
            }
            continue;
          }
        }

        // RSI exits at bar open only (excluding hard stop)
        if (tickIndex !== 0) continue;
        const exit = strategy?.shouldClose(pos, tickPrice);
        if (!exit?.close || exit.reason === "rsi_hard_stop") continue;

        const exitReason = exit.reason;
        const exitRefPrice = tickPrice;
        let filledExitTs = tickTs;

        // Determine exit mode based on reason (RSI exits can use maker)
        const preferredExitMode = getExitExecModeForReason(exitReason, feeCfg.execMode);
        let exitExecMode = preferredExitMode;
        let filledExitPrice = exitRefPrice;

        if (
          feeCfg.model === "drift" &&
          feeCfg.execMode === "maker" &&
          preferredExitMode === "maker" &&
          process.env.ENABLE_MAKER_FILL_SIM === "true"
        ) {
          makerExitStats.attempts++;
          // Tick-aware maker exit fill simulation needs the current market's tick stream.
          // marketTicks may contain either numeric prices or {price, ts} objects.
          const rawTicksForMarket = marketTicks.get(market) || [];
          const ticksForMarket = rawTicksForMarket.map((t) =>
            typeof t === "number" ? t : Number(t?.price)
          );
          const tickIntervalMs = intervalToMs(options.interval || "5m") / ticksPerCandle;
          const tickTimestampsForMarket = rawTicksForMarket.map((t, i) => {
            const tsVal = typeof t === "object" && t && Number.isFinite(t.ts) ? t.ts : null;
            if (Number.isFinite(tsVal)) return tsVal;
            // Derive timestamp if not provided by tick source
            return candle ? candle.openTime + i * tickIntervalMs : null;
          });
          const exitSim = simulateDriftMakerExitFill({
            market: `${market}-PERP`,
            strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
            side: pos.side,
            refPrice: exitRefPrice,
            candle, // used only if ticks not provided
            ticks: ticksForMarket,
            tickTimestamps: tickTimestampsForMarket,
            startTickIndex: tickIndex,
            tickIntervalMs,
            positionSizeUsd: pos.sizeUsd || 0, // AUDIT FIX: Pass size for degradation
          });
          exitExecMode = exitSim.execMode;
          filledExitPrice = exitSim.fillPrice ?? exitRefPrice;
          if (exitSim.outcome === "maker_fill") makerExitStats.makerFills++;
          if (exitSim.outcome === "taker_fallback") makerExitStats.takerFallbacks++;
          if (Number.isFinite(exitSim.fillIndex)) {
            filledExitTs =
              candle.openTime +
              exitSim.fillIndex * (intervalToMs(options.interval || "5m") / ticksPerCandle);
          }
        } else if (preferredExitMode === "taker" && feeCfg.execMode === "maker") {
          makerExitStats.forcedTaker++;
          exitExecMode = "taker";
        }

        const dir = pos.side === "long" ? 1 : -1;
        const grossPnl = dir * (filledExitPrice - pos.entryPrice) * pos.quantity;
        const currentNotional = pos.quantity * filledExitPrice;
        const closeRes = feeCfg.calculateCloseFee
          ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
          : { fee: (currentNotional * feeCfg.closeFeeBps) / 10000, breakdown: {} };
        const closeFee =
          closeRes.breakdown?.baseFee ??
          closeRes.fee ??
          (currentNotional * feeCfg.closeFeeBps) / 10000;
        // Drift: no swap/borrow/priceImpact fees (Jupiter-only)
        const impactFee = feeCfg.model === "drift" ? 0 : calculatePriceImpactFee(currentNotional);
        const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
        const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
        const borrowFee =
          feeCfg.model === "drift"
            ? 0
            : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, filledExitTs - lastBorrowTs));
        const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;

        // Funding fee (Drift only)
        const holdDurationMs = filledExitTs - pos.openTime;
        const fundingFee =
          typeof estimateFundingCost === "function"
            ? estimateFundingCost(
                pos.side,
                pos.sizeUsd,
                holdDurationMs,
                getMarketFundingRate(market)
              )
            : 0;

        const totalExitFees = closeFee + impactFee + swapFee + borrowFee + txFee - fundingFee;
        const netPnl = grossPnl - totalExitFees;

        realisedPnl += netPnl;
        totalFees += totalExitFees;
        feeBreakdown.closeFees += closeFee;
        feeBreakdown.impactFees += impactFee;
        feeBreakdown.swapFees += swapFee;
        feeBreakdown.borrowFees += borrowFee;
        feeBreakdown.fundingFees += fundingFee;
        feeBreakdown.txFees += txFee;
        feeBreakdown.totalTrades++;

        const trade = {
          id: pos.id,
          market: `${market}-PERP`,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: filledExitPrice,
          entryRsi: pos.entryRsi,
          exitRsi: strategy?.rsi ?? null,
          openTime: pos.openTime,
          exitTime: filledExitTs,
          sizeUsd: pos.sizeUsd,
          quantity: pos.quantity,
          leverage: pos.leverage,
          collateral: pos.collateral,
          grossPnl,
          pnlUsd: netPnl,
          totalPnlUsd: netPnl,
          pnlPct: (netPnl / pos.collateral) * 100,
          exitReason: exit.reason,
        };

        if (trace) {
          trace.push({
            model: traceModel,
            kind: "exit",
            ts: filledExitTs,
            market: `${market}-PERP`,
            barIndex: candleIndexMaps.get(market)?.get(ts) ?? null,
            tickIndex,
            price: tickPrice,
            rsi: strategy?.rsi ?? null,
            atr: strategy?.atr ?? null,
            action: "close",
            side: pos.side,
            reason: exit.reason,
            positionId: pos.id,
            fillPrice: filledExitPrice,
            stopPrice: null,
            extra: null,
          });
        }

        const idxPos = allPositions.indexOf(pos);
        if (idxPos >= 0) allPositions.splice(idxPos, 1);
        allTrades.push(trade);
        marketResults.get(market).trades.push(trade);
        marketResults.get(market).totalPnL += netPnl;
        if (strategy && typeof strategy.recordTrade === "function") {
          strategy.recordTrade({
            pnlUsd: netPnl,
            pnlPercent: netPnl / pos.collateral,
            exitReason: trade.exitReason,
          });
        }
      }

      // Signals + allocator (BAR OPEN only)
      if (tickIndex !== 0) continue;
      const signals = [];
      for (const [market, candle] of marketCandles.entries()) {
        const strategy = strategiesMap.get(market);
        if (!strategy) continue;
        const tickPrice = currentPrices.get(market);
        if (!Number.isFinite(strategy.rsi)) continue;

        // Only consider opens if we have capacity and no position in market (bot allocator enforces max per market)
        const hasPosInMarket = allPositions.some((p) => p.marketKey === market);
        if (hasPosInMarket) continue;

        const sig = strategy.getSignal(candle.open, [], false, globalTick);
        if (trace) {
          trace.push({
            model: traceModel,
            kind: "signal",
            ts: candle.openTime,
            market: `${market}-PERP`,
            barIndex: candleIndexMaps.get(market).get(ts),
            tickIndex: 0,
            price: candle.open,
            rsi: strategy.rsi,
            atr: strategy.atr,
            action: sig?.action ?? null,
            side: sig?.side ?? null,
            confidence: sig?.confidence ?? null,
            reason: sig?.reason ?? null,
          });
        }

        if (sig?.action === "open") {
          const side = String(sig.side || "").toLowerCase();
          if ((side === "long" && !allowLongs) || (side === "short" && !allowShorts)) continue;
          signals.push({
            market: `${market}-PERP`,
            strategyType: "rsi-reversion",
            signal: sig,
            priceData: { price: tickPrice },
          });
        }
      }

      if (signals.length > 0 && allocator && allPositions.length < maxPositions) {
        const ranked = allocator.evaluateOpportunities(signals, allPositions, {}, new Map());
        // Deterministic tie-break (score desc, then market asc, then side)
        ranked.sort((a, b) => {
          const ds = (b.score ?? 0) - (a.score ?? 0);
          if (ds !== 0) return ds;
          const dm = String(a.market).localeCompare(String(b.market));
          if (dm !== 0) return dm;
          return String(a.signal?.side).localeCompare(String(b.signal?.side));
        });
        const selected = allocator.selectBestOpportunities(ranked, maxPositions, allPositions);

        for (const opp of selected) {
          if (allPositions.length >= maxPositions) break;
          const marketKey = String(opp.market || "").replace("-PERP", "");
          const candle = marketCandles.get(marketKey);
          const entryPrice = candle?.open;
          if (!Number.isFinite(entryPrice)) continue;
          const available = getAvailableCapital();

          // Base values from config/per-market overrides
          const strategy = strategiesMap.get(marketKey);
          const baseSizePct = positionSizePercent;
          const baseLeverage = options.perMarketLeverage?.get(marketKey) || leverage;
          const baseHardStopPct = strategy?.cfg?.rsiHardStopPercent ?? 0;
          const baseHardStopAtr = strategy?.cfg?.rsiHardStopAtr ?? 0;

          // === ALLOCATOR RISK RECOMMENDATION ===
          // When enabled, dynamically adjust size/leverage/stops based on signal quality
          let effectiveSizePct = baseSizePct;
          let effectiveLeverage = baseLeverage;
          let effectiveHardStopPct = baseHardStopPct;
          let effectiveHardStopAtr = baseHardStopAtr;
          let allocatorRiskApplied = null;

          if (allocator && typeof allocator.recommendRisk === "function") {
            try {
              const riskRec = allocator.recommendRisk({
                market: `${marketKey}-PERP`,
                signal: opp.signal,
                priceData: { price: entryPrice, atr: strategy?.atr },
                score: opp.score ?? 0,
                strategyType: "rsi-reversion",
                base: {
                  sizePct: baseSizePct,
                  leverage: baseLeverage,
                  hardStopPercent: baseHardStopPct,
                  hardStopAtrMult: baseHardStopAtr,
                },
              });
              if (riskRec) {
                effectiveSizePct = Number.isFinite(riskRec.sizePct) ? riskRec.sizePct : baseSizePct;
                effectiveLeverage = Number.isFinite(riskRec.leverage)
                  ? riskRec.leverage
                  : baseLeverage;
                effectiveHardStopPct = Number.isFinite(riskRec.hardStopPercent)
                  ? riskRec.hardStopPercent
                  : baseHardStopPct;
                effectiveHardStopAtr = Number.isFinite(riskRec.hardStopAtrMult)
                  ? riskRec.hardStopAtrMult
                  : baseHardStopAtr;
                allocatorRiskApplied = {
                  quality: riskRec.quality,
                  sizePct: { base: baseSizePct, effective: effectiveSizePct },
                  leverage: { base: baseLeverage, effective: effectiveLeverage },
                  hardStopPct: { base: baseHardStopPct, effective: effectiveHardStopPct },
                  hardStopAtr: { base: baseHardStopAtr, effective: effectiveHardStopAtr },
                };
                if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
                  console.log(
                    `[ALLOCATOR_RISK] ${marketKey} score=${(opp.score ?? 0).toFixed(2)} q=${riskRec.quality?.toFixed(2)} | size=${baseSizePct.toFixed(0)}→${effectiveSizePct.toFixed(0)}% lev=${baseLeverage.toFixed(1)}→${effectiveLeverage.toFixed(1)}x`
                  );
                }
              }
            } catch (e) {
              if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
                console.warn(
                  `[ALLOCATOR_RISK] recommendRisk failed for ${marketKey}:`,
                  e?.message || e
                );
              }
            }
          }

          // Calculate collateral using effective size percent
          const baseCollateral = available * (effectiveSizePct / 100);
          let collateral = Math.min(
            Math.max(0, baseCollateral),
            options.maxPositionSize || 5000,
            available
          );
          if (collateral <= 0) continue;

          const marketLev = effectiveLeverage;
          let sizeUsd = collateral * marketLev;

          // AUDIT FIX: Apply liquidity constraint / position size cap
          // Disabled by default - enable with ENABLE_LIQUIDITY_CAPS=true
          if (process.env.ENABLE_LIQUIDITY_CAPS === "true") {
            const marketSymbol = `${marketKey}-PERP`;
            const tradeCheck = shouldSkipTrade(marketSymbol, sizeUsd, { strict: false });
            if (tradeCheck.skip) {
              // Trade skipped due to liquidity constraint
              continue;
            }
            if (tradeCheck.capped) {
              // Cap position to max allowed size
              sizeUsd = tradeCheck.cappedSize;
              collateral = sizeUsd / marketLev;
            }
          }

          // Simulate maker fill (Drift only): maker attempt → optional taker fallback
          let entryExecMode = feeCfg.execMode;
          let filledEntryPrice = entryPrice;
          if (
            feeCfg.model === "drift" &&
            feeCfg.execMode === "maker" &&
            process.env.ENABLE_MAKER_FILL_SIM === "true"
          ) {
            makerEntryStats.attempts++;
            const sim = simulateDriftMakerEntryFill({
              market: `${marketKey}-PERP`,
              strategyKey: process.env.STRATEGY_TYPE || "rsi-reversion",
              side: opp.signal.side,
              refPrice: entryPrice,
              candle: candle || { high: entryPrice, low: entryPrice },
              positionSizeUsd: sizeUsd, // AUDIT FIX: Pass size for degradation
            });
            // Always fill - if no maker fill, fallback to taker (never skip trades)
            if (sim.execMode) {
              entryExecMode = sim.execMode;
              filledEntryPrice = sim.fillPrice;
              if (sim.outcome === "maker_fill") makerEntryStats.makerFills++;
              if (sim.outcome === "taker_fallback") makerEntryStats.takerFallbacks++;
            } else {
              // Fallback to taker if maker sim returned no_fill
              entryExecMode = "taker";
              filledEntryPrice = entryPrice;
              makerEntryStats.takerFallbacks++;
            }
          }

          const quantity = sizeUsd / filledEntryPrice;

          const openRes = feeCfg.calculateOpenFee
            ? feeCfg.calculateOpenFee(sizeUsd, { execMode: entryExecMode })
            : {
                fee: (sizeUsd * feeCfg.openFeeBps) / 10000,
                breakdown: { baseFee: (sizeUsd * feeCfg.openFeeBps) / 10000, priceImpactFee: 0 },
              };
          const openFee = openRes.breakdown?.baseFee ?? 0;
          const impactFee = openRes.breakdown?.priceImpactFee ?? 0;
          const swapFee = feeCfg.enableSwapFee ? calculateSwapFee(collateral) : 0;
          const txFee = SIMULATION_CONSTANTS.DEFAULT_SOLANA_TX_FEE_USD;
          const totalEntryFees = (openRes.fee ?? 0) + swapFee + txFee;

          realisedPnl -= totalEntryFees;
          totalFees += totalEntryFees;
          feeBreakdown.openFees += openFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.swapFees += swapFee;
          feeBreakdown.txFees += txFee;

          const entryTime = candle ? candle.openTime : ts;

          const position = {
            id: `bot-${++tradeCounter}`,
            market: `${marketKey}-PERP`,
            marketKey,
            side: opp.signal.side,
            entryPrice: filledEntryPrice,
            entryRsi: strategy?.rsi ?? null,
            entryAtr: Number.isFinite(strategy?.atr) ? strategy.atr : null,
            openTime: entryTime,
            lastBorrowTs: entryTime,
            sizeUsd,
            quantity,
            collateral,
            leverage: marketLev,
            entryFee: totalEntryFees,
            entryExecMode,
            allocatorRiskApplied, // Track if/how allocator adjusted risk
            highWaterMark: filledEntryPrice,
            lowWaterMark: filledEntryPrice,
          };

          // Fixed hard stop level from ENTRY ATR (used for per-tick stops)
          // Use EFFECTIVE hard stop values (may be adjusted by allocator)
          if (
            strategy?.cfg?.rsiHardStopEnabled &&
            (Number.isFinite(effectiveHardStopPct) || Number.isFinite(effectiveHardStopAtr))
          ) {
            const dist = computeHardStopDistance({
              entryPrice: position.entryPrice,
              side: position.side,
              leverage: position.leverage || marketLev,
              hardStopEnabled: true,
              hardStopPercent: effectiveHardStopPct,
              hardStopAtrMult: effectiveHardStopAtr,
              atr: position.entryAtr,
            });
            if (Number.isFinite(dist) && dist > 0) {
              position._hardStopLevel =
                position.side === "long" ? position.entryPrice - dist : position.entryPrice + dist;
            }
          }

          allPositions.push(position);
          marketResults.get(marketKey).totalPnL -= totalEntryFees;
          marketResults.get(marketKey).totalFees += totalEntryFees;

          if (trace) {
            trace.push({
              model: traceModel,
              kind: "entry",
              ts: entryTime,
              market: `${marketKey}-PERP`,
              barIndex: candleIndexMaps.get(marketKey).get(ts),
              tickIndex: 0,
              price: entryPrice,
              rsi: position.entryRsi,
              atr: position.entryAtr,
              action: "open",
              side: position.side,
              confidence: opp.signal?.confidence ?? null,
              reason: opp.signal?.reason ?? null,
              positionId: position.id,
              fillPrice: filledEntryPrice,
            });
          }
        }
      }
    }

    // Equity snapshot at bar close
    const locked = getLockedCollateral();
    let unrealised = 0;
    for (const pos of allPositions) {
      const p = currentPrices.get(pos.marketKey) || pos.entryPrice;
      const dir = pos.side === "long" ? 1 : -1;
      unrealised += dir * (p - pos.entryPrice) * pos.quantity;
    }
    equitySeries.push(initialCapital + realisedPnl + unrealised);
  }

  return {
    trades: allTrades,
    realisedPnl,
    totalPnL: realisedPnl,
    totalFees,
    feeBreakdown,
    equitySeries,
    initialCapital,
    marketResults,
    capitalStats: {
      finalEquity: equitySeries.length
        ? equitySeries[equitySeries.length - 1]
        : initialCapital + realisedPnl,
    },
    makerEntryStats, // Drift maker entry fill simulation stats
    makerExitStats, // Drift maker exit fill simulation stats
    fundingStats, // Funding data/source summary (historical vs estimated)
    // Liquidation tracking (Drift margin simulation)
    liquidationStats: {
      enabled: enableLiquidationCheck,
      count: liquidationCount,
      totalLoss: liquidationLoss,
      maintenanceMode: "per_market_imf",
      fallbackMaintenanceMarginPct: DEFAULT_MAINT_RATIO_FALLBACK * 100,
      partialCount: partialLiquidationCount,
      partialNotionalUsd: partialLiquidationNotionalUsd,
      partialFeesUsd: partialLiquidationFeesUsd,
      // Kept for backwards-compat with older print blocks; prefer result.fundingStats
      useHistoricalFunding,
    },
  };
}

// ============================================================
// STATISTICAL ROBUSTNESS & STABILITY TESTING
// ============================================================

/**
 * Calculate turnover-adjusted MAR (Maximum Adverse Excursion Ratio)
 */
function calculateTurnoverAdjustedMAR(trades, equitySeries, initialCapital, days) {
  const years = days / 365.25 || 0;
  const finalEquity =
    equitySeries && equitySeries.length > 0
      ? equitySeries[equitySeries.length - 1]?.equity ||
        equitySeries[equitySeries.length - 1] ||
        initialCapital
      : initialCapital;
  const totalReturn = (finalEquity - initialCapital) / initialCapital;

  if (!trades || trades.length === 0 || !equitySeries || equitySeries.length === 0) {
    return {
      mar: 0,
      cagr: 0,
      maxDD: 0,
      maxDDPct: 0,
      finalEquity,
      totalReturn,
      years,
    };
  }

  // Calculate CAGR (with all costs baked in)
  if (years <= 0) {
    return {
      mar: 0,
      cagr: 0,
      maxDD: 0,
      maxDDPct: 0,
      finalEquity,
      totalReturn,
      years,
    };
  }

  // Only annualize if period >= 1 year, otherwise CAGR can be misleading for short periods
  const cagr = years >= 1 ? Math.pow(1 + totalReturn, 1 / years) - 1 : totalReturn; // For periods < 1 year, use total return (not annualized)

  // Calculate maximum drawdown (with all costs included)
  let maxDD = 0;
  let maxDDPct = 0;
  let peakEquity = initialCapital;

  for (const point of equitySeries) {
    const equity = point.equity || point || initialCapital;
    if (equity > peakEquity) {
      peakEquity = equity;
    }
    const drawdown = peakEquity - equity;
    const drawdownPct = peakEquity > 0 ? drawdown / peakEquity : 0;

    if (drawdown > maxDD) {
      maxDD = drawdown;
      maxDDPct = drawdownPct;
    }
  }

  // MAR = CAGR / MaxDD (higher is better)
  const mar = maxDDPct > 0 ? cagr / maxDDPct : 0;

  return {
    mar,
    cagr,
    maxDD,
    maxDDPct,
    finalEquity,
    totalReturn,
    years,
  };
}

function normalizeTradesForDailyReturns(trades) {
  if (!Array.isArray(trades)) return [];
  return trades.map((t) => {
    const pnlUsd = Number.isFinite(t?.pnlUsd)
      ? t.pnlUsd
      : Number.isFinite(t?.totalPnlUsd)
        ? t.totalPnlUsd
        : Number.isFinite(t?.pnl)
          ? t.pnl
          : 0;
    return { ...t, pnlUsd };
  });
}

function cloneJson(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

function withRsiOverridesOnStrategyConfig(strategyConfig, overrides) {
  const cfg = cloneJson(strategyConfig || {});
  cfg.quiet = true;
  cfg.rsiStrategy = cfg.rsiStrategy || {};
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined || v === null) continue;
    cfg.rsiStrategy[k] = v;
  }
  return cfg;
}

function buildStrategyConfigsMapWithGlobalOverrides(strategyConfigsMap, overrides) {
  const out = new Map();
  for (const [symbol, cfg] of strategyConfigsMap.entries()) {
    out.set(symbol, withRsiOverridesOnStrategyConfig(cfg, overrides));
  }
  return out;
}

/**
 * UNIFIED PARAMETER GRID BUILDER
 * Shared between heatmaps and walk-forward optimization
 * Returns array of parameter pairs with their value ranges
 */
function buildUnifiedParameterGrid(baseline, options = {}) {
  const {
    mode = "full", // 'full' (all 10 dimensions), 'fast' (top 5), 'minimal' (top 3)
    coarseGrid = false, // Use coarser grid for speed (3 values per dim instead of 5)
    exclude = null, // array or comma-separated string of tokens to exclude (pair name or param key)
  } = options;

  const excludeTokens = new Set(
    String(exclude || process.env.ROBUST_GRID_EXCLUDE || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.toLowerCase())
  );

  // Helper to generate range around baseline
  const genRange = (base, offsets, min, max) => {
    return offsets
      .map((o) => Math.max(min, Math.min(max, base + o)))
      .filter((v, i, a) => a.indexOf(v) === i);
  };

  // Coarse vs fine offsets
  const rsiOffsets = coarseGrid ? [-4, 0, 4] : [-6, -3, 0, 3, 6];
  const targetOffsets = coarseGrid ? [-8, 0, 8] : [-10, -5, 0, 5, 10];
  const periodOffsets = coarseGrid ? [0, 3] : [-2, 0, 2, 4];
  const atrPeriodOffsets = coarseGrid ? [0, 4] : [-3, 0, 3, 6];
  const leverageOffsets = coarseGrid ? [-3, 0, 3] : [-4, -2, 0, 2, 4];
  const stopOffsets = coarseGrid ? [-4, 0, 4] : [-5, -2, 0, 3, 7];

  const allPairs = [
    // Top priority (most impactful on P&L based on previous analysis)
    {
      name: "Leverage × Hard Stop %",
      param1: "leverage",
      param2: "hardStopPercent",
      range1: genRange(baseline.leverage, leverageOffsets, 1, 20),
      range2: genRange(baseline.hardStopPercent, stopOffsets, 1, 30),
      validator: () => true,
      isRsiConfig: false,
      priority: 1,
    },
    {
      name: "Oversold Extreme × Recovery",
      param1: "rsiOversoldExtreme",
      param2: "rsiOversoldRecovery",
      range1: genRange(baseline.rsiOversoldExtreme, rsiOffsets, 10, 40),
      range2: genRange(baseline.rsiOversoldRecovery, rsiOffsets, 15, 50),
      validator: (v1, v2) => v1 < v2,
      isRsiConfig: true,
      priority: 1,
    },
    {
      name: "Overbought Extreme × Recovery",
      param1: "rsiOverboughtExtreme",
      param2: "rsiOverboughtRecovery",
      range1: genRange(baseline.rsiOverboughtExtreme, rsiOffsets, 60, 90),
      range2: genRange(baseline.rsiOverboughtRecovery, rsiOffsets, 55, 85),
      validator: (v1, v2) => v2 < v1,
      isRsiConfig: true,
      priority: 1,
    },
    // Medium priority
    {
      name: "Target Long × Target Short",
      param1: "rsiTargetLong",
      param2: "rsiTargetShort",
      range1: genRange(baseline.rsiTargetLong, targetOffsets, 40, 80),
      range2: genRange(baseline.rsiTargetShort, targetOffsets, 20, 60),
      validator: () => true,
      isRsiConfig: true,
      priority: 2,
    },
    {
      name: "ADX Min × ADX Max",
      param1: "rsiMinAdx",
      param2: "rsiMaxAdx",
      range1: coarseGrid ? [0, 15, 25] : [0, 10, 15, 20, 25],
      range2: coarseGrid ? [30, 50, 100] : [30, 40, 50, 60, 100],
      validator: (v1, v2) => v1 < v2,
      isRsiConfig: true,
      priority: 2,
    },
    {
      name: "Position Size % × Time Stop Bars",
      param1: "positionSizePercent",
      param2: "rsiTimeStopBars",
      range1: coarseGrid ? [50, 80, 100] : [30, 50, 70, 80, 90, 100],
      range2: coarseGrid ? [40, 100, 9999] : [20, 40, 60, 100, 200, 9999],
      validator: () => true,
      isRsiConfig: false,
      priority: 2,
    },
    // Lower priority (less impactful or slower to optimize)
    {
      name: "RSI Period × ATR Period",
      param1: "rsiPeriod",
      param2: "atrPeriod",
      range1: genRange(baseline.rsiPeriod, periodOffsets, 8, 21),
      range2: genRange(baseline.atrPeriod, atrPeriodOffsets, 10, 28),
      validator: () => true,
      isRsiConfig: true,
      priority: 3,
    },
    {
      name: "Volatility Min × Volatility Max",
      param1: "rsiMinVolatilityPct",
      param2: "rsiMaxVolatilityPct",
      range1: coarseGrid ? [0.1, 0.3, 0.7] : [0.1, 0.2, 0.3, 0.5, 0.7],
      range2: coarseGrid ? [3.0, 5.0, 10.0] : [3.0, 4.0, 5.0, 7.0, 10.0],
      validator: (v1, v2) => v1 < v2,
      isRsiConfig: true,
      priority: 3,
    },
    {
      name: "Failure Long × Failure Short",
      param1: "rsiFailureLong",
      param2: "rsiFailureShort",
      range1: coarseGrid ? [0, 18, 25] : [0, 15, 18, 20, 22, 25],
      range2: coarseGrid ? [75, 82, 100] : [75, 78, 80, 82, 85, 100],
      validator: () => true,
      isRsiConfig: true,
      priority: 3,
    },
  ];

  // Filter by mode
  let maxPriority = 3;
  if (mode === "fast") maxPriority = 2;
  if (mode === "minimal") maxPriority = 1;

  return allPairs
    .filter((p) => p.priority <= maxPriority)
    .filter((p) => {
      if (excludeTokens.size === 0) return true;
      const name = String(p.name || "").toLowerCase();
      const p1 = String(p.param1 || "").toLowerCase();
      const p2 = String(p.param2 || "").toLowerCase();
      for (const tok of excludeTokens) {
        if (!tok) continue;
        if (name.includes(tok)) return false;
        if (p1 === tok || p2 === tok) return false;
      }
      return true;
    });
}

/**
 * Generate flat parameter combinations from grid pairs
 * Used for walk-forward optimization (tests all combinations)
 */
function generateParameterCombinations(paramPairs, maxCombinations = 500) {
  const combinations = [];

  for (const pair of paramPairs) {
    const { param1, param2, range1, range2, validator, isRsiConfig } = pair;

    for (const val1 of range1) {
      for (const val2 of range2) {
        if (validator && !validator(val1, val2)) continue;

        combinations.push({
          pairName: pair.name,
          params: { [param1]: val1, [param2]: val2 },
          isRsiConfig,
          priority: pair.priority,
        });

        if (combinations.length >= maxCombinations) {
          return combinations;
        }
      }
    }
  }

  return combinations;
}

/**
 * Run parameter optimization on a training window
 * Returns best parameters and performance metrics
 */
function runWalkForwardOptimization(
  trainCandlesMap,
  strategyConfigsMap,
  options,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  baseline,
  paramPairs,
  trainOneMinCandlesMap = null,
  trainTicksByBarOpenTimeMap = null
) {
  const isBotModel = String(options._traceModel || "backtest").toLowerCase() === "bot";
  const simFn = isBotModel ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;
  const interval = options.interval || "5m";
  const tickSimEnabled = interval === "5m" || interval === "1m";

  // Generate all parameter combinations
  const maxCombos = parseInt(process.env.WF_MAX_COMBINATIONS || "200", 10);
  const combinations = generateParameterCombinations(paramPairs, maxCombos);

  console.log(`    🔧 Testing ${combinations.length} parameter combinations...`);

  let bestResult = null;
  let bestParams = {};
  let bestPnL = -Infinity;
  let bestSharpe = -Infinity;
  let testedCount = 0;

  for (const combo of combinations) {
    try {
      // Build modified strategy configs
      let modifiedConfigsMap = strategyConfigsMap;
      let modifiedOptions = { ...options };

      if (combo.isRsiConfig) {
        // RSI strategy parameters - apply to all markets
        modifiedConfigsMap = buildStrategyConfigsMapWithGlobalOverrides(
          strategyConfigsMap,
          combo.params
        );
      } else {
        // Simulation parameters (leverage, hardStop, positionSizePercent)
        modifiedOptions = { ...options };
        if (combo.params.leverage !== undefined) modifiedOptions.leverage = combo.params.leverage;
        if (combo.params.hardStopPercent !== undefined)
          modifiedOptions.rsiHardStopPercent = combo.params.hardStopPercent;
        if (combo.params.positionSizePercent !== undefined)
          modifiedOptions.positionSizePercent = combo.params.positionSizePercent;
      }

      // Build strategies
      const strategiesMap = new Map();
      for (const [symbol, cfg] of modifiedConfigsMap.entries()) {
        const modCfg = cloneJson(cfg);
        modCfg.quiet = true;
        strategiesMap.set(symbol, new RsiMeanReversionStrategy(modCfg));
      }

      // Run simulation
      const result = simFn(strategiesMap, trainCandlesMap, {
        initialCapital: modifiedOptions.initialCapital,
        leverage: modifiedOptions.leverage,
        positionSizePercent: modifiedOptions.positionSizePercent,
        enableCompounding: modifiedOptions.enableCompounding,
        allowLongs: modifiedOptions.allowLongs,
        allowShorts: modifiedOptions.allowShorts,
        maxPositions: modifiedOptions.maxPositions,
        ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : 1,
        simulateTicks: tickSimEnabled,
        rsiHardStopPercent: modifiedOptions.rsiHardStopPercent,
        rsiHardStopAtr: modifiedOptions.rsiHardStopAtr,
        perMarketLeverage,
        perMarketHardStop,
        perMarketHardStopAtr,
        minPositionSize: modifiedOptions.minPositionSize,
        maxPositionSize: modifiedOptions.maxPositionSize,
        oneMinCandlesMap: trainOneMinCandlesMap,
        ticksByBarOpenTimeMap: trainTicksByBarOpenTimeMap,
      });

      const trades = normalizeTradesForDailyReturns(
        Array.from(result.marketResults?.values?.() || []).flatMap((m) => m.trades || [])
      );
      const pnl = result.realisedPnl ?? result.totalPnL ?? 0;
      const dailyReturns = tradesToDailyReturns(trades, options.initialCapital);
      const sharpe = dailyReturns.length > 0 ? calculateSharpeRatio(dailyReturns) : 0;
      const tradesCount = trades.length;

      testedCount++;

      // MEMORY OPTIMIZATION: Clear result immediately after extracting metrics
      if (result.marketResults) {
        result.marketResults.clear();
        result.marketResults = null;
      }
      result = null;
      trades.length = 0;
      dailyReturns.length = 0;

      // Track best by Sharpe (risk-adjusted) - use P&L as tiebreaker
      if (sharpe > bestSharpe || (sharpe === bestSharpe && pnl > bestPnL)) {
        bestSharpe = sharpe;
        bestPnL = pnl;
        bestParams = { ...combo.params };
        bestResult = {
          pnl,
          sharpe,
          trades: tradesCount,
          pairName: combo.pairName,
          isRsiConfig: combo.isRsiConfig,
        };
      }
    } catch (err) {
      // Skip failed combinations silently
    }
  }

  console.log(
    `    ✅ Tested ${testedCount} combinations, best Sharpe: ${bestSharpe.toFixed(2)}, P&L: $${bestPnL.toFixed(2)}`
  );

  return {
    bestParams,
    bestResult,
    testedCount,
  };
}

/**
 * Apply optimized parameters to strategy configs and options
 */
function applyOptimizedParams(
  strategyConfigsMap,
  options,
  optimizedParams,
  perMarketLeverage,
  perMarketHardStop
) {
  const modifiedConfigsMap = new Map();
  const modifiedOptions = { ...options };
  const modifiedLeverage = new Map(perMarketLeverage || []);
  const modifiedHardStop = new Map(perMarketHardStop || []);

  for (const [symbol, cfg] of strategyConfigsMap.entries()) {
    const modCfg = cloneJson(cfg);
    modCfg.quiet = true;
    modCfg.rsiStrategy = modCfg.rsiStrategy || {};

    // Apply RSI strategy params
    for (const [key, value] of Object.entries(optimizedParams)) {
      if (value === undefined || value === null) continue;

      if (key === "leverage") {
        modifiedOptions.leverage = value;
        // Also apply per-market if not already overridden
        for (const sym of strategyConfigsMap.keys()) {
          if (!perMarketLeverage?.has(sym)) modifiedLeverage.set(sym, value);
        }
      } else if (key === "hardStopPercent") {
        modifiedOptions.rsiHardStopPercent = value;
        for (const sym of strategyConfigsMap.keys()) {
          if (!perMarketHardStop?.has(sym)) modifiedHardStop.set(sym, value);
        }
      } else if (key === "positionSizePercent") {
        modifiedOptions.positionSizePercent = value;
      } else {
        // RSI strategy param
        modCfg.rsiStrategy[key] = value;
      }
    }

    modifiedConfigsMap.set(symbol, modCfg);
  }

  return { modifiedConfigsMap, modifiedOptions, modifiedLeverage, modifiedHardStop };
}

function runRobustnessResim({
  options,
  candlesMap,
  strategyConfigsMap,
  multiTokenMode,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  oneMinCandlesMap,
}) {
  if (!candlesMap || !strategyConfigsMap || strategyConfigsMap.size === 0) {
    throw new Error("Missing candles/config maps required for re-simulation");
  }

  const isBotModel =
    String(options._traceModel || options.traceModel || "backtest").toLowerCase() === "bot";

  if (!multiTokenMode) {
    const symbol = options.symbols?.[0];
    const candles = candlesMap.get(symbol);
    const strategyConfig = strategyConfigsMap.get(symbol);
    if (!candles || !strategyConfig)
      throw new Error(`Missing candles/strategyConfig for ${symbol}`);

    const strategy = new RsiMeanReversionStrategy(strategyConfig);
    const interval = options.interval || "5m";
    const tickSimEnabled = interval === "5m" || interval === "1m";
    const leverage = perMarketLeverage?.get(symbol) ?? options.leverage;
    const hardStopPercent = perMarketHardStop?.get(symbol) ?? options.rsiHardStopPercent;

    const simFn = isBotModel ? simulateBotRuntimeSingleMarket : simulateRsiMeanReversion;
    const simResult = simFn(strategy, candles, {
      positionSizeUsd: options.positionSize,
      leverage,
      hardStopPercent,
      debug: false,
      verbose: false,
      allowLongs: options.allowLongs,
      allowShorts: options.allowShorts,
      maxPositions: options.maxPositions,
      simulateTicks: tickSimEnabled,
      ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : 1,
      oneMinCandles: oneMinCandlesMap?.get(symbol) || null,
      symbol,
      enableEarlyExits: options.enableEarlyExits,
      maxDrawdownPct: options.maxDrawdownPct,
      trailingAfterPartialPct: options.trailingAfterPartialPct,
      enableCompounding: options.enableCompounding,
      initialCapital: options.initialCapital,
      positionSizePercent: options.positionSizePercent,
      minPositionSize: options.minPositionSize,
      extendedExit: options.extendedExit,
      extendedExitReversal: options.extendedExitReversal,
      parityChecks: options.parityChecks,
      _trace: null,
      _traceModel: isBotModel ? "bot" : options._traceModel || "backtest",
    });

    const trades = normalizeTradesForDailyReturns(simResult.trades || []);
    const totalPnL = simResult.realisedPnl ?? simResult.totalPnL ?? 0;
    const dailyReturns = tradesToDailyReturns(trades, options.initialCapital);
    const sharpe = calculateSharpeRatio(dailyReturns);
    const marObj = calculateTurnoverAdjustedMAR(
      trades,
      simResult.equitySeries || [],
      options.initialCapital,
      options.days
    );
    const mar = marObj?.mar ?? 0;

    return { totalPnL, trades, equitySeries: simResult.equitySeries || [], sharpe, mar };
  }

  const strategiesMap = new Map();
  for (const [symbol, cfg] of strategyConfigsMap.entries()) {
    strategiesMap.set(symbol, new RsiMeanReversionStrategy(cfg));
  }

  const simFn = isBotModel ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;
  const simResult = simFn(strategiesMap, candlesMap, {
    initialCapital: options.initialCapital,
    leverage: options.leverage,
    positionSizePercent: options.positionSizePercent,
    enableCompounding: options.enableCompounding,
    debug: false,
    allowLongs: options.allowLongs,
    allowShorts: options.allowShorts,
    maxPositions: options.maxPositions,
    ticksPerCandle: options.ticksPerCandle,
    simulateTicks: options.simulateTicks,
    rsiHardStopPercent: options.rsiHardStopPercent,
    rsiHardStopAtr: options.rsiHardStopAtr,
    // Advanced sizing methods
    positionSizingMethod: options.positionSizingMethod,
    riskPerTradePercent: options.riskPerTradePercent,
    kellyFraction: options.kellyFraction,
    volatilityScaleBase: options.volatilityScaleBase,
    qualitySizeMultMin: options.qualitySizeMultMin,
    qualitySizeMultMax: options.qualitySizeMultMax,
    perMarketLeverage,
    perMarketHardStop,
    perMarketHardStopAtr,
    minPositionSize: options.minPositionSize,
    maxPositionSize: options.maxPositionSize,
    allocatorExploreProbability: options.allocatorExploreProbability,
    allocatorUseBotScoring: options.allocatorUseBotScoring,
    allocatorRiskEnabled: options.allocatorRiskEnabled,
    allocatorRiskNeutral: options.allocatorRiskNeutral,
    _trace: null,
    _traceModel: isBotModel ? "bot" : options._traceModel || "backtest",
  });

  const trades = normalizeTradesForDailyReturns(
    Array.from(simResult.marketResults?.values?.() || []).flatMap((m) => m.trades || [])
  );
  const totalPnL = simResult.realisedPnl ?? simResult.totalPnL ?? 0;
  const dailyReturns = tradesToDailyReturns(trades, options.initialCapital);
  const sharpe = calculateSharpeRatio(dailyReturns);
  const marObj = calculateTurnoverAdjustedMAR(
    trades,
    simResult.equitySeries || [],
    options.initialCapital,
    options.days
  );
  const mar = marObj?.mar ?? 0;

  return { totalPnL, trades, equitySeries: simResult.equitySeries || [], sharpe, mar };
}

/**
 * Run jitter robustness suite: perturb key RSI parameters and re-simulate (no placeholders).
 */
function runJitterTest(
  originalResult,
  options,
  candlesMap,
  strategyConfigsMap,
  multiTokenMode,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  oneMinCandlesMap
) {
  if (
    !originalResult ||
    !Array.isArray(originalResult.trades) ||
    originalResult.trades.length === 0
  ) {
    return { passed: true, jitterResults: [], message: "No trades in baseline result" };
  }
  if (!candlesMap || !strategyConfigsMap) {
    return {
      passed: false,
      jitterResults: [],
      message: "Missing candles/config maps for re-simulation",
    };
  }

  const baselinePnL = originalResult.realisedPnl || originalResult.totalPnL || 0;
  const collapseThreshold = 0.5; // Flag if PnL drops >50%

  const jitterTests = [
    { name: "RSI Period +1", overrides: { rsiPeriod: (options.rsiPeriod || 14) + 1 } },
    { name: "RSI Period -1", overrides: { rsiPeriod: Math.max(2, (options.rsiPeriod || 14) - 1) } },
    { name: "ATR Period +1", overrides: { atrPeriod: (options.atrPeriod || 14) + 1 } },
    { name: "ATR Period -1", overrides: { atrPeriod: Math.max(2, (options.atrPeriod || 14) - 1) } },
    {
      name: "Oversold Extreme -2",
      overrides: { rsiOversoldExtreme: (options.rsiOversoldExtreme || 20) - 2 },
    },
    {
      name: "Oversold Extreme +2",
      overrides: { rsiOversoldExtreme: (options.rsiOversoldExtreme || 20) + 2 },
    },
    {
      name: "Oversold Recovery -2",
      overrides: { rsiOversoldRecovery: (options.rsiOversoldRecovery || 25) - 2 },
    },
    {
      name: "Oversold Recovery +2",
      overrides: { rsiOversoldRecovery: (options.rsiOversoldRecovery || 25) + 2 },
    },
    {
      name: "Overbought Extreme -2",
      overrides: { rsiOverboughtExtreme: (options.rsiOverboughtExtreme || 80) - 2 },
    },
    {
      name: "Overbought Extreme +2",
      overrides: { rsiOverboughtExtreme: (options.rsiOverboughtExtreme || 80) + 2 },
    },
    {
      name: "Overbought Recovery -2",
      overrides: { rsiOverboughtRecovery: (options.rsiOverboughtRecovery || 75) - 2 },
    },
    {
      name: "Overbought Recovery +2",
      overrides: { rsiOverboughtRecovery: (options.rsiOverboughtRecovery || 75) + 2 },
    },
  ];

  const jitterResults = [];

  for (const test of jitterTests) {
    try {
      const cfgMap = buildStrategyConfigsMapWithGlobalOverrides(strategyConfigsMap, test.overrides);
      const sim = runRobustnessResim({
        options,
        candlesMap,
        strategyConfigsMap: cfgMap,
        multiTokenMode,
        perMarketLeverage,
        perMarketHardStop,
        perMarketHardStopAtr,
        oneMinCandlesMap,
      });

      const jitterPnL = sim.totalPnL;
      const pnlChange = baselinePnL !== 0 ? (jitterPnL - baselinePnL) / Math.abs(baselinePnL) : 0;
      const collapsed = pnlChange < -collapseThreshold;

      jitterResults.push({
        test: test.name,
        pnl: jitterPnL,
        pnlChange,
        collapsed,
        sharpe: sim.sharpe,
        mar: sim.mar,
        trades: sim.trades.length,
        overrides: test.overrides,
      });
    } catch (err) {
      jitterResults.push({
        test: test.name,
        error: err.message,
        collapsed: true,
        overrides: test.overrides,
      });
    }
  }

  const collapsedCount = jitterResults.filter((r) => r.collapsed).length;
  return {
    passed: collapsedCount === 0,
    collapsedCount,
    totalTests: jitterResults.length,
    jitterResults,
    baselinePnL,
  };
}

/**
 * Run bootstrap CI on trades to get confidence intervals for Sharpe/MAR
 * Uses improved methods to narrow CI (bias-corrected and accelerated bootstrap, more iterations)
 */
function runBootstrapCI(trades, equitySeries, initialCapital, days, numBootstrap = 5000) {
  if (!trades || trades.length === 0 || !equitySeries || equitySeries.length === 0) {
    return { sharpeCI: [0, 0], marCI: [0, 0], message: "Insufficient data for bootstrap" };
  }

  // Convert trades to daily returns for better statistical properties
  const dailyReturns = tradesToDailyReturns(trades, initialCapital);

  if (dailyReturns.length === 0) {
    return { sharpeCI: [0, 0], marCI: [0, 0], message: "No daily returns for bootstrap" };
  }

  const bootstrapSharpe = [];
  const bootstrapMAR = [];
  const bootstrapMaxDD = [];

  // Calculate baseline metrics for bias correction
  const baselineSharpe = calculateSharpeRatio(dailyReturns);
  const baselineMAR = calculateTurnoverAdjustedMAR(trades, equitySeries, initialCapital, days);

  // Block bootstrap for time series (preserves temporal structure)
  // Use block size = sqrt(n) for optimal block length
  const blockSize = Math.max(1, Math.floor(Math.sqrt(dailyReturns.length)));
  const numBlocks = Math.ceil(dailyReturns.length / blockSize);

  // Bootstrap: resample with block bootstrap for time series
  for (let i = 0; i < numBootstrap; i++) {
    // Block bootstrap: resample blocks of consecutive returns
    const resampledReturns = [];
    for (let j = 0; j < dailyReturns.length; j++) {
      // Randomly select a block starting position
      const blockStart = Math.floor(
        Math.random() * Math.max(1, dailyReturns.length - blockSize + 1)
      );
      // Add all returns from this block
      for (let k = 0; k < blockSize && resampledReturns.length < dailyReturns.length; k++) {
        if (blockStart + k < dailyReturns.length) {
          resampledReturns.push(dailyReturns[blockStart + k]);
        }
      }
    }

    // Truncate to original length
    resampledReturns.splice(dailyReturns.length);

    if (resampledReturns.length > 1) {
      // Calculate Sharpe on resampled returns
      const sharpe = calculateSharpeRatio(resampledReturns);
      bootstrapSharpe.push(sharpe);

      // For MAR, we need to reconstruct equity series from returns
      // Approximate: calculate cumulative returns and find maxDD
      let cumulativeCapital = initialCapital;
      let peakCapital = initialCapital;
      let maxDD = 0;

      for (const ret of resampledReturns) {
        cumulativeCapital *= 1 + ret;
        if (cumulativeCapital > peakCapital) {
          peakCapital = cumulativeCapital;
        }
        const drawdown = (peakCapital - cumulativeCapital) / peakCapital;
        if (drawdown > maxDD) {
          maxDD = drawdown;
        }
      }

      const resampledTotalReturn = (cumulativeCapital - initialCapital) / initialCapital;
      const years = days / 365.25;
      const resampledCAGR =
        years >= 1 ? Math.pow(1 + resampledTotalReturn, 1 / years) - 1 : resampledTotalReturn;

      const resampledMAR = maxDD > 0 ? resampledCAGR / maxDD : 0;
      bootstrapMAR.push(resampledMAR);
      bootstrapMaxDD.push(maxDD);
    }
  }

  // Filter out invalid values
  const validSharpe = bootstrapSharpe.filter((s) => Number.isFinite(s) && !Number.isNaN(s));
  const validMAR = bootstrapMAR.filter((m) => Number.isFinite(m) && !Number.isNaN(m));

  if (validSharpe.length === 0 || validMAR.length === 0) {
    return {
      sharpeCI: [0, 0],
      marCI: [0, 0],
      message: "Bootstrap failed to generate valid samples",
    };
  }

  // Sort for percentile calculation
  const sortedSharpe = [...validSharpe].sort((a, b) => a - b);
  const sortedMAR = [...validMAR].sort((a, b) => a - b);

  // Calculate 95% CI using percentile method (2.5th and 97.5th percentiles)
  const sharpeCI = [
    sortedSharpe[Math.floor(sortedSharpe.length * 0.025)],
    sortedSharpe[Math.floor(sortedSharpe.length * 0.975)],
  ];

  const marCI = [
    sortedMAR[Math.floor(sortedMAR.length * 0.025)],
    sortedMAR[Math.floor(sortedMAR.length * 0.975)],
  ];

  // Bias-corrected and accelerated (BCa) adjustment (simplified)
  // Calculate bias correction factor
  const sharpeBias =
    validSharpe.filter((s) => s < (baselineSharpe.sharpe || baselineSharpe || 0)).length /
    validSharpe.length;
  const marBias = validMAR.filter((m) => m < (baselineMAR.mar || 0)).length / validMAR.length;

  // Adjust CI using bias correction (simplified BCa)
  const sharpeCIAdjusted = [
    sharpeCI[0] - (sharpeBias - 0.5) * (sharpeCI[1] - sharpeCI[0]) * 0.2,
    sharpeCI[1] + (sharpeBias - 0.5) * (sharpeCI[1] - sharpeCI[0]) * 0.2,
  ];

  const marCIAdjusted = [
    marCI[0] - (marBias - 0.5) * (marCI[1] - marCI[0]) * 0.2,
    marCI[1] + (marBias - 0.5) * (marCI[1] - marCI[0]) * 0.2,
  ];

  // Calculate CI width reduction
  const originalSharpeWidth = sharpeCI[1] - sharpeCI[0];
  const adjustedSharpeWidth = sharpeCIAdjusted[1] - sharpeCIAdjusted[0];
  const originalMARWidth = marCI[1] - marCI[0];
  const adjustedMARWidth = marCIAdjusted[1] - marCIAdjusted[0];

  return {
    sharpeCI: sharpeCIAdjusted,
    marCI: marCIAdjusted,
    numBootstrap,
    baselineSharpe: baselineSharpe.sharpe || baselineSharpe || 0,
    baselineMAR: baselineMAR.mar || 0,
    originalCI: { sharpe: sharpeCI, mar: marCI },
    widthReduction: {
      sharpe:
        originalSharpeWidth > 0
          ? ((originalSharpeWidth - adjustedSharpeWidth) / originalSharpeWidth) * 100
          : 0,
      mar:
        originalMARWidth > 0 ? ((originalMARWidth - adjustedMARWidth) / originalMARWidth) * 100 : 0,
    },
  };
}

/**
 * Generate range around a baseline value for sensitivity testing
 * @param {number} baseline - Current value
 * @param {number[]} offsets - Array of offsets to apply (e.g., [-4, -2, 0, 2, 4])
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number[]} Array of values to test
 */
function generateRangeAroundBaseline(baseline, offsets, min = 0, max = 100) {
  const values = offsets.map((off) => baseline + off).filter((v) => v >= min && v <= max);
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Run MULTI-MARKET simulation with parameter overrides for a SINGLE market
 * This properly tests parameter changes in the context of shared capital allocation
 *
 * @param {string} targetSymbol - The symbol whose parameters are being overridden
 * @param {Object} overrides - RSI strategy parameter overrides for targetSymbol
 * @param {Object} simOverrides - Simulation parameter overrides (leverage, hardStop, positionSizePercent)
 * @param {Object} options - Global options
 * @param {Map} candlesMap - All markets' candles
 * @param {Map} strategyConfigsMap - Baseline configs for all markets
 * @param {Map} perMarketLeverage - Per-market leverage map
 * @param {Map} perMarketHardStop - Per-market hard stop map
 * @param {Map} perMarketHardStopAtr - Per-market ATR stop map
 * @returns {Object} { portfolioPnL, perMarketPnL: Map, trades, sharpe }
 */
function runMultiMarketResimWithOverride(
  targetSymbol,
  overrides,
  simOverrides,
  options,
  candlesMap,
  strategyConfigsMap,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  oneMinCandlesMap = null,
  ticksByBarOpenTimeMap = null
) {
  if (!candlesMap || !strategyConfigsMap || strategyConfigsMap.size === 0) {
    throw new Error("Missing candles/config maps for multi-market resim");
  }

  const isBotModel =
    String(options._traceModel || options.traceModel || "backtest").toLowerCase() === "bot";

  // Build strategy configs map with overrides for target symbol only
  const modifiedConfigsMap = new Map();
  for (const [symbol, baseConfig] of strategyConfigsMap.entries()) {
    if (symbol === targetSymbol && overrides && Object.keys(overrides).length > 0) {
      // Apply RSI strategy overrides to target market
      modifiedConfigsMap.set(symbol, withRsiOverridesOnStrategyConfig(baseConfig, overrides));
    } else {
      modifiedConfigsMap.set(symbol, baseConfig);
    }
  }

  // Build strategies from configs
  const strategiesMap = new Map();
  for (const [symbol, cfg] of modifiedConfigsMap.entries()) {
    strategiesMap.set(symbol, new RsiMeanReversionStrategy(cfg));
  }

  // Handle simulation-level overrides (leverage, hardStop, positionSizePercent)
  const modifiedLeverage = new Map(perMarketLeverage || []);
  const modifiedHardStop = new Map(perMarketHardStop || []);
  let modifiedPositionSizePercent = options.positionSizePercent;

  if (simOverrides) {
    if (simOverrides.leverage !== undefined) {
      modifiedLeverage.set(targetSymbol, simOverrides.leverage);
    }
    if (simOverrides.hardStopPercent !== undefined) {
      modifiedHardStop.set(targetSymbol, simOverrides.hardStopPercent);
    }
    if (simOverrides.positionSizePercent !== undefined) {
      // Position size is global, not per-market
      modifiedPositionSizePercent = simOverrides.positionSizePercent;
    }
  }

  const simFn = isBotModel ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;
  const interval = options.interval || "5m";
  const tickSimEnabled = interval === "5m" || interval === "1m";

  const simResult = simFn(strategiesMap, candlesMap, {
    initialCapital: options.initialCapital,
    leverage: options.leverage,
    positionSizePercent: modifiedPositionSizePercent,
    enableCompounding: options.enableCompounding,
    debug: false,
    allowLongs: options.allowLongs,
    allowShorts: options.allowShorts,
    maxPositions: options.maxPositions,
    ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : 1,
    simulateTicks: tickSimEnabled,
    rsiHardStopPercent: options.rsiHardStopPercent,
    rsiHardStopAtr: options.rsiHardStopAtr,
    perMarketLeverage: modifiedLeverage,
    perMarketHardStop: modifiedHardStop,
    perMarketHardStopAtr,
    minPositionSize: options.minPositionSize,
    maxPositionSize: options.maxPositionSize,
    allocatorExploreProbability: 0, // Deterministic for testing
    allocatorUseBotScoring: options.allocatorUseBotScoring,
    allocatorRiskEnabled: false, // Disable dynamic risk for consistent testing
    _trace: null,
    oneMinCandlesMap,
    ticksByBarOpenTimeMap,
  });

  // Extract per-market P&L
  const perMarketPnL = new Map();
  if (simResult.marketResults) {
    for (const [sym, mktResult] of simResult.marketResults.entries()) {
      perMarketPnL.set(sym, mktResult.netPnL ?? mktResult.realisedPnl ?? 0);
    }
  }

  const allTrades = normalizeTradesForDailyReturns(
    Array.from(simResult.marketResults?.values?.() || []).flatMap((m) => m.trades || [])
  );
  const portfolioPnL = simResult.realisedPnl ?? simResult.totalPnL ?? 0;
  const dailyReturns = tradesToDailyReturns(allTrades, options.initialCapital);
  const sharpe = calculateSharpeRatio(dailyReturns);

  return {
    portfolioPnL,
    perMarketPnL,
    targetMarketPnL: perMarketPnL.get(targetSymbol) ?? 0,
    trades: allTrades,
    sharpe: sharpe?.sharpe ?? sharpe ?? 0,
  };
}

/**
 * Run single-market simulation for sensitivity testing (LEGACY - kept for compatibility)
 * @param {Object} overrideParams - Optional overrides for leverage, hardStopPercent, etc.
 */
function runSingleMarketResim(
  symbol,
  options,
  candles,
  strategyConfig,
  oneMinCandles,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  overrideParams = {}
) {
  const isBotModel =
    String(options._traceModel || options.traceModel || "backtest").toLowerCase() === "bot";
  const strategy = new RsiMeanReversionStrategy(strategyConfig);
  const interval = options.interval || "5m";
  const tickSimEnabled = interval === "5m" || interval === "1m";
  // Allow override of leverage, hardStop, and positionSizePercent for sensitivity testing
  const leverage = overrideParams.leverage ?? perMarketLeverage?.get(symbol) ?? options.leverage;
  const hardStopPercent =
    overrideParams.hardStopPercent ?? perMarketHardStop?.get(symbol) ?? options.rsiHardStopPercent;
  const positionSizePercent = overrideParams.positionSizePercent ?? options.positionSizePercent;

  const simFn = isBotModel ? simulateBotRuntimeSingleMarket : simulateRsiMeanReversion;
  const simResult = simFn(strategy, candles, {
    positionSizeUsd: options.positionSize,
    leverage,
    hardStopPercent,
    debug: false,
    verbose: false,
    allowLongs: options.allowLongs,
    allowShorts: options.allowShorts,
    maxPositions: options.maxPositions,
    simulateTicks: tickSimEnabled,
    ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : 1,
    oneMinCandles: oneMinCandles || null,
    symbol,
    enableEarlyExits: options.enableEarlyExits,
    maxDrawdownPct: options.maxDrawdownPct,
    trailingAfterPartialPct: options.trailingAfterPartialPct,
    enableCompounding: options.enableCompounding,
    initialCapital: options.initialCapital,
    positionSizePercent,
    minPositionSize: options.minPositionSize,
    extendedExit: options.extendedExit,
    extendedExitReversal: options.extendedExitReversal,
    parityChecks: options.parityChecks,
    _trace: null,
    _traceModel: isBotModel ? "bot" : options._traceModel || "backtest",
  });

  const trades = normalizeTradesForDailyReturns(simResult.trades || []);
  const totalPnL = simResult.realisedPnl ?? simResult.totalPnL ?? 0;
  const dailyReturns = tradesToDailyReturns(trades, options.initialCapital);
  const sharpe = calculateSharpeRatio(dailyReturns);
  const marObj = calculateTurnoverAdjustedMAR(
    trades,
    simResult.equitySeries || [],
    options.initialCapital,
    options.days
  );
  const mar = marObj?.mar ?? 0;

  return { totalPnL, trades, equitySeries: simResult.equitySeries || [], sharpe, mar };
}

/**
 * Generate per-market sensitivity heatmaps
 * Tests perturbations around each market's current baseline parameters
 * Includes ADX filter testing
 */
function generatePerMarketSensitivityHeatmap(
  options,
  candlesMap,
  strategyConfigsMap,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  oneMinCandlesMap
) {
  if (!candlesMap || !strategyConfigsMap || strategyConfigsMap.size === 0) {
    return { perMarket: [], recommendations: [] };
  }

  const maxRunsPerMarket = parseInt(process.env.ROBUST_HEATMAP_MAX_RUNS_PER_MARKET || "100", 10);
  const perMarketResults = [];
  const allRecommendations = [];

  for (const [symbol, baseConfig] of strategyConfigsMap.entries()) {
    const candles = candlesMap.get(symbol);
    const oneMinCandles = oneMinCandlesMap?.get(symbol);

    if (!candles || candles.length === 0) {
      console.log(`\n  ⚠️  Skipping ${symbol}: No candle data`);
      continue;
    }

    console.log(`\n  📊 Generating sensitivity surfaces for ${symbol}...`);

    // Extract baseline parameters from market config
    const rsiCfg = baseConfig.rsiStrategy || {};
    const marketLeverage = perMarketLeverage?.get(symbol) ?? options.leverage ?? 1;
    const marketHardStopPct = perMarketHardStop?.get(symbol) ?? options.rsiHardStopPercent ?? 3;
    const baseline = {
      rsiPeriod: rsiCfg.rsiPeriod ?? options.rsiPeriod ?? 14,
      atrPeriod: rsiCfg.atrPeriod ?? options.atrPeriod ?? 14,
      rsiOversoldExtreme: rsiCfg.rsiOversoldExtreme ?? options.rsiOversoldExtreme ?? 20,
      rsiOversoldRecovery: rsiCfg.rsiOversoldRecovery ?? options.rsiOversoldRecovery ?? 25,
      rsiOverboughtExtreme: rsiCfg.rsiOverboughtExtreme ?? options.rsiOverboughtExtreme ?? 80,
      rsiOverboughtRecovery: rsiCfg.rsiOverboughtRecovery ?? options.rsiOverboughtRecovery ?? 75,
      rsiFailureLong: rsiCfg.rsiFailureLong ?? options.rsiFailureLong ?? 0,
      rsiFailureShort: rsiCfg.rsiFailureShort ?? options.rsiFailureShort ?? 100,
      rsiTargetLong: rsiCfg.rsiTargetLong ?? options.rsiTargetLong ?? 50,
      rsiTargetShort: rsiCfg.rsiTargetShort ?? options.rsiTargetShort ?? 50,
      rsiMinAdx: rsiCfg.rsiMinAdx ?? 0,
      rsiMaxAdx: rsiCfg.rsiMaxAdx ?? 100,
      rsiMinVolatilityPct: rsiCfg.rsiMinVolatilityPct ?? options.rsiMinVolatilityPct ?? 0.2,
      rsiMaxVolatilityPct: rsiCfg.rsiMaxVolatilityPct ?? options.rsiMaxVolatilityPct ?? 5.0,
      rsiTimeStopBars: rsiCfg.rsiTimeStopBars ?? options.rsiTimeStopBars ?? 9999,
      // Leverage and risk parameters
      leverage: marketLeverage,
      hardStopPercent: marketHardStopPct,
      positionSizePercent: options.positionSizePercent ?? 80,
    };

    console.log(
      `     Baseline: oversold=${baseline.rsiOversoldExtreme}→${baseline.rsiOversoldRecovery}, overbought=${baseline.rsiOverboughtExtreme}→${baseline.rsiOverboughtRecovery}`
    );
    console.log(
      `     ADX filter: ${baseline.rsiMinAdx}-${baseline.rsiMaxAdx}, targets: long=${baseline.rsiTargetLong}, short=${baseline.rsiTargetShort}`
    );
    console.log(
      `     Volatility filter: ${baseline.rsiMinVolatilityPct}-${baseline.rsiMaxVolatilityPct}%, failure: long=${baseline.rsiFailureLong}, short=${baseline.rsiFailureShort}`
    );
    console.log(
      `     Leverage: ${baseline.leverage}x, Hard Stop: ${baseline.hardStopPercent}%, Time Stop: ${baseline.rsiTimeStopBars} bars`
    );
    console.log(`     Position Size: ${baseline.positionSizePercent}%`);

    // Use UNIFIED parameter grid (shared with WF optimization)
    const paramPairs = buildUnifiedParameterGrid(baseline, {
      mode: "full", // Heatmaps use full grid (all 10 dimensions)
      coarseGrid: false, // Fine grid for detailed heatmaps
    });

    let runCount = 0;
    const marketHeatmaps = [];
    const marketRecommendations = [];

    // First, run MULTI-MARKET baseline simulation (shared capital across all markets)
    let baselinePortfolioPnL = 0;
    let baselineMarketPnL = 0;

    // Build ticksByBarOpenTimeMap for all symbols (for tick simulation)
    const ticksByBarOpenTimeMap = new Map();
    if (oneMinCandlesMap) {
      for (const [sym, oneMin] of oneMinCandlesMap.entries()) {
        if (oneMin && oneMin.length > 0) {
          ticksByBarOpenTimeMap.set(sym, buildTicksByBarOpenTimeFrom1m(oneMin));
        }
      }
    }

    try {
      const baseResult = runMultiMarketResimWithOverride(
        symbol,
        {},
        {}, // No overrides for baseline
        options,
        candlesMap,
        strategyConfigsMap,
        perMarketLeverage,
        perMarketHardStop,
        perMarketHardStopAtr,
        oneMinCandlesMap,
        ticksByBarOpenTimeMap
      );
      baselinePortfolioPnL = baseResult.portfolioPnL;
      baselineMarketPnL = baseResult.targetMarketPnL;
      console.log(
        `     Portfolio Baseline: $${baselinePortfolioPnL.toFixed(2)} (${symbol}: $${baselineMarketPnL.toFixed(2)})`
      );
    } catch (err) {
      console.log(`     ⚠️  Baseline simulation failed: ${err.message}`);
    }

    for (const pair of paramPairs) {
      if (runCount >= maxRunsPerMarket) break;

      const { name, param1, param2, range1, range2, validator, isRsiConfig } = pair;
      const heatmap = [];
      let bestCell = null;

      console.log(`     🔄 ${name}... (multi-market mode)`);

      for (const val1 of range1) {
        for (const val2 of range2) {
          if (runCount >= maxRunsPerMarket) break;

          // Validate parameter combination
          if (validator && !validator(val1, val2)) {
            heatmap.push({
              [param1]: val1,
              [param2]: val2,
              portfolioPnl: Number.NaN,
              invalid: true,
            });
            continue;
          }

          try {
            // Build RSI strategy overrides (applied to this market only)
            let rsiOverrides = {};
            let simOverrides = {};

            if (isRsiConfig !== false) {
              // RSI strategy parameters - applied to this market's strategy config
              rsiOverrides = { [param1]: val1, [param2]: val2 };
            } else {
              // Simulation parameters (leverage, hardStop, positionSizePercent)
              simOverrides = { [param1]: val1, [param2]: val2 };
            }

            // Special case: if one param is rsiTimeStopBars (strategy config) and other is positionSizePercent (sim param)
            if (param1 === "rsiTimeStopBars" || param2 === "rsiTimeStopBars") {
              const timeStopVal = param1 === "rsiTimeStopBars" ? val1 : val2;
              const otherParam = param1 === "rsiTimeStopBars" ? param2 : param1;
              const otherVal = param1 === "rsiTimeStopBars" ? val2 : val1;
              rsiOverrides = { rsiTimeStopBars: timeStopVal };
              if (otherParam === "positionSizePercent") {
                simOverrides = { positionSizePercent: otherVal };
              }
            }

            // Run MULTI-MARKET simulation with only this market's parameters overridden
            const sim = runMultiMarketResimWithOverride(
              symbol,
              rsiOverrides,
              simOverrides,
              options,
              candlesMap,
              strategyConfigsMap,
              perMarketLeverage,
              perMarketHardStop,
              perMarketHardStopAtr,
              oneMinCandlesMap,
              ticksByBarOpenTimeMap
            );

            runCount++;
            const cell = {
              [param1]: val1,
              [param2]: val2,
              portfolioPnl: sim.portfolioPnL, // Portfolio-level P&L (what actually matters)
              marketPnl: sim.targetMarketPnL, // This market's P&L contribution
              sharpe: sim.sharpe,
              trades: sim.trades.length,
              isBaseline: val1 === baseline[param1] && val2 === baseline[param2],
            };
            heatmap.push(cell);

            // Track best cell by PORTFOLIO P&L (not single-market)
            if (
              !bestCell ||
              (Number.isFinite(cell.portfolioPnl) &&
                cell.portfolioPnl > (bestCell.portfolioPnl || -Infinity))
            ) {
              bestCell = cell;
            }
          } catch (err) {
            heatmap.push({
              [param1]: val1,
              [param2]: val2,
              portfolioPnl: Number.NaN,
              error: err.message,
            });
          }
        }
        if (runCount >= maxRunsPerMarket) break;
      }

      marketHeatmaps.push({
        name,
        param1,
        param2,
        heatmap,
        range1,
        range2,
        baseline: { [param1]: baseline[param1], [param2]: baseline[param2] },
        best: bestCell,
      });

      // Generate recommendation if best differs significantly from baseline
      // Now uses PORTFOLIO P&L as the optimization target (shared capital mode)
      if (bestCell && Number.isFinite(bestCell.portfolioPnl)) {
        const baselineVal1 = baseline[param1];
        const baselineVal2 = baseline[param2];
        const improvement = bestCell.portfolioPnl - baselinePortfolioPnL;
        const improvementPct =
          baselinePortfolioPnL !== 0 ? (improvement / Math.abs(baselinePortfolioPnL)) * 100 : 0;

        // Only recommend if improvement > 10% and not already at baseline
        if (
          improvement > 0 &&
          improvementPct > 10 &&
          (bestCell[param1] !== baselineVal1 || bestCell[param2] !== baselineVal2)
        ) {
          marketRecommendations.push({
            surface: name,
            param1,
            param2,
            currentVal1: baselineVal1,
            currentVal2: baselineVal2,
            recommendedVal1: bestCell[param1],
            recommendedVal2: bestCell[param2],
            baselinePortfolioPnL,
            recommendedPortfolioPnL: bestCell.portfolioPnl,
            baselineMarketPnL,
            recommendedMarketPnL: bestCell.marketPnl,
            improvement,
            improvementPct,
            sharpe: bestCell.sharpe,
            trades: bestCell.trades,
          });
        }
      }

      if (runCount >= maxRunsPerMarket) {
        console.log(`     ⚠️  Max runs (${maxRunsPerMarket}) reached for ${symbol}`);
        break;
      }
    }

    perMarketResults.push({
      symbol,
      baseline,
      baselinePortfolioPnL,
      baselineMarketPnL,
      heatmaps: marketHeatmaps,
      recommendations: marketRecommendations,
      totalRuns: runCount,
    });

    if (marketRecommendations.length > 0) {
      allRecommendations.push({ symbol, recommendations: marketRecommendations });
    }
  }

  return { perMarket: perMarketResults, recommendations: allRecommendations };
}

/**
 * Legacy wrapper for backward compatibility (calls per-market version)
 */
function generateSensitivityHeatmap(
  options,
  candlesMap,
  strategyConfigsMap,
  multiTokenMode,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  oneMinCandlesMap
) {
  // Delegate to per-market implementation
  return generatePerMarketSensitivityHeatmap(
    options,
    candlesMap,
    strategyConfigsMap,
    perMarketLeverage,
    perMarketHardStop,
    perMarketHardStopAtr,
    oneMinCandlesMap
  );
}

/**
 * Optimize parameters on training data using focused grid search
 * Returns best parameter set found on training data
 */
function optimizeParamsOnTrainingData(
  trainCandlesMap,
  strategyConfigsMap,
  options,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  oneMinCandlesMap
) {
  const maxOptimizationRuns = parseInt(process.env.WF_OPTIMIZE_MAX_RUNS || "50", 10);
  let bestOverall = null;
  let bestScore = -Infinity;
  let runCount = 0;

  // Focus on key parameters that have shown sensitivity in heatmaps
  const optimizationParams = [
    { name: "Target Long", param: "rsiTargetLong", values: [60, 65, 70, 75, 80] },
    { name: "Target Short", param: "rsiTargetShort", values: [25, 30, 35, 40, 45] },
    { name: "Oversold Recovery", param: "rsiOversoldRecovery", values: [22, 25, 28, 32, 35] },
    { name: "Overbought Recovery", param: "rsiOverboughtRecovery", values: [70, 74, 76, 78, 80] },
    { name: "ADX Max", param: "rsiMaxAdx", values: [30, 40, 50, 100] },
  ];

  // Try combinations of top parameters (not full grid to limit runs)
  for (const targetLong of optimizationParams[0].values) {
    for (const targetShort of optimizationParams[1].values) {
      if (runCount >= maxOptimizationRuns) break;

      try {
        // Create optimized configs for all markets
        const optimizedConfigsMap = new Map();
        for (const [symbol, baseConfig] of strategyConfigsMap.entries()) {
          const optimizedConfig = withRsiOverridesOnStrategyConfig(baseConfig, {
            rsiTargetLong: targetLong,
            rsiTargetShort: targetShort,
          });
          optimizedConfigsMap.set(symbol, optimizedConfig);
        }

        // Run simulation on training data
        const isBotModel = String(options._traceModel || "backtest").toLowerCase() === "bot";
        const simFn = isBotModel ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;

        const result = simFn(
          new Map(
            Array.from(optimizedConfigsMap.entries()).map(([s, cfg]) => [
              s,
              new RsiMeanReversionStrategy(cfg),
            ])
          ),
          trainCandlesMap,
          {
            initialCapital: options.initialCapital,
            leverage: options.leverage,
            positionSizePercent: options.positionSizePercent,
            enableCompounding: options.enableCompounding,
            allowLongs: options.allowLongs,
            allowShorts: options.allowShorts,
            maxPositions: options.maxPositions,
            ticksPerCandle: options.ticksPerCandle,
            simulateTicks: options.simulateTicks,
            rsiHardStopPercent: options.rsiHardStopPercent,
            rsiHardStopAtr: options.rsiHardStopAtr,
            perMarketLeverage,
            perMarketHardStop,
            perMarketHardStopAtr,
            minPositionSize: options.minPositionSize,
            maxPositionSize: options.maxPositionSize,
          }
        );

        const trades = normalizeTradesForDailyReturns(
          Array.from(result.marketResults?.values?.() || []).flatMap((m) => m.trades || [])
        );
        const pnl = result.realisedPnl ?? result.totalPnL ?? 0;
        const dailyReturns = tradesToDailyReturns(trades, options.initialCapital);
        const sharpe = calculateSharpeRatio(dailyReturns);

        // Use Sharpe-adjusted PnL as score (favors risk-adjusted returns)
        const score = sharpe > 0 ? pnl * sharpe : pnl;

        if (score > bestScore) {
          bestScore = score;
          bestOverall = {
            rsiTargetLong: targetLong,
            rsiTargetShort: targetShort,
            pnl,
            sharpe,
            trades: trades.length,
            score,
          };
        }

        runCount++;
      } catch (err) {
        // Skip failed combinations
        continue;
      }
    }
    if (runCount >= maxOptimizationRuns) break;
  }

  // If we found a good combination, try optimizing other params around it
  if (bestOverall && runCount < maxOptimizationRuns) {
    for (const oversoldRecovery of optimizationParams[2].values) {
      for (const overboughtRecovery of optimizationParams[3].values) {
        if (runCount >= maxOptimizationRuns) break;

        try {
          const optimizedConfigsMap = new Map();
          for (const [symbol, baseConfig] of strategyConfigsMap.entries()) {
            const optimizedConfig = withRsiOverridesOnStrategyConfig(baseConfig, {
              rsiTargetLong: bestOverall.rsiTargetLong,
              rsiTargetShort: bestOverall.rsiTargetShort,
              rsiOversoldRecovery: oversoldRecovery,
              rsiOverboughtRecovery: overboughtRecovery,
            });
            optimizedConfigsMap.set(symbol, optimizedConfig);
          }

          const isBotModel = String(options._traceModel || "backtest").toLowerCase() === "bot";
          const simFn = isBotModel
            ? simulateBotRuntimeMultiMarket
            : simulateMultiMarketSharedCapital;

          const result = simFn(
            new Map(
              Array.from(optimizedConfigsMap.entries()).map(([s, cfg]) => [
                s,
                new RsiMeanReversionStrategy(cfg),
              ])
            ),
            trainCandlesMap,
            {
              initialCapital: options.initialCapital,
              leverage: options.leverage,
              positionSizePercent: options.positionSizePercent,
              enableCompounding: options.enableCompounding,
              allowLongs: options.allowLongs,
              allowShorts: options.allowShorts,
              maxPositions: options.maxPositions,
              ticksPerCandle: options.ticksPerCandle,
              simulateTicks: options.simulateTicks,
              rsiHardStopPercent: options.rsiHardStopPercent,
              rsiHardStopAtr: options.rsiHardStopAtr,
              perMarketLeverage,
              perMarketHardStop,
              perMarketHardStopAtr,
              minPositionSize: options.minPositionSize,
              maxPositionSize: options.maxPositionSize,
            }
          );

          const trades = normalizeTradesForDailyReturns(
            Array.from(result.marketResults?.values?.() || []).flatMap((m) => m.trades || [])
          );
          const pnl = result.realisedPnl ?? result.totalPnL ?? 0;
          const dailyReturns = tradesToDailyReturns(trades, options.initialCapital);
          const sharpe = calculateSharpeRatio(dailyReturns);
          const score = sharpe > 0 ? pnl * sharpe : pnl;

          if (score > bestScore) {
            bestScore = score;
            bestOverall = {
              rsiTargetLong: bestOverall.rsiTargetLong,
              rsiTargetShort: bestOverall.rsiTargetShort,
              rsiOversoldRecovery: oversoldRecovery,
              rsiOverboughtRecovery: overboughtRecovery,
              pnl,
              sharpe,
              trades: trades.length,
              score,
            };
          }

          runCount++;
        } catch (err) {
          continue;
        }
      }
      if (runCount >= maxOptimizationRuns) break;
    }
  }

  return bestOverall;
}

/**
 * Walk-Forward Analysis (Anchored & Rolling)
 * Industry-standard method to test out-of-sample performance
 * With optional parameter optimization on training set
 */
async function runWalkForwardAnalysis(
  options,
  candlesMap,
  strategyConfigsMap,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  startTime,
  endTime,
  config = {},
  oneMinCandlesMap = null
) {
  const {
    trainDays = 60, // Training window in days
    testDays = 30, // Test window in days
    stepDays = 30, // Step forward in days (rolling) or 0 for anchored
    mode = "rolling", // 'rolling' or 'anchored'
    optimizeParams = false, // Whether to optimize params on training set
  } = config;

  const trainMs = trainDays * 24 * 60 * 60 * 1000;
  const testMs = testDays * 24 * 60 * 60 * 1000;
  const stepMs = stepDays * 24 * 60 * 60 * 1000;
  const stepMsEff = stepMs > 0 ? stepMs : testMs;

  const folds = [];
  const parameterHistory = []; // Track optimized params across folds
  let foldNum = 0;

  // Build baseline parameter values for comparison
  const baselineBaseline = {};
  const firstConfig = strategyConfigsMap.values().next().value;
  if (firstConfig) {
    const rsiCfg = firstConfig.rsiStrategy || {};
    baselineBaseline.rsiOversoldExtreme =
      rsiCfg.rsiOversoldExtreme ?? options.rsiOversoldExtreme ?? 20;
    baselineBaseline.rsiOversoldRecovery =
      rsiCfg.rsiOversoldRecovery ?? options.rsiOversoldRecovery ?? 25;
    baselineBaseline.rsiOverboughtExtreme =
      rsiCfg.rsiOverboughtExtreme ?? options.rsiOverboughtExtreme ?? 80;
    baselineBaseline.rsiOverboughtRecovery =
      rsiCfg.rsiOverboughtRecovery ?? options.rsiOverboughtRecovery ?? 75;
    baselineBaseline.rsiTargetLong = rsiCfg.rsiTargetLong ?? options.rsiTargetLong ?? 50;
    baselineBaseline.rsiTargetShort = rsiCfg.rsiTargetShort ?? options.rsiTargetShort ?? 50;
    baselineBaseline.leverage = options.leverage ?? 10;
    baselineBaseline.hardStopPercent = options.rsiHardStopPercent ?? 3;
    baselineBaseline.positionSizePercent = options.positionSizePercent ?? 80;
    baselineBaseline.rsiPeriod = rsiCfg.rsiPeriod ?? options.rsiPeriod ?? 14;
    baselineBaseline.atrPeriod = rsiCfg.atrPeriod ?? options.atrPeriod ?? 14;
    baselineBaseline.rsiMinAdx = rsiCfg.rsiMinAdx ?? 0;
    baselineBaseline.rsiMaxAdx = rsiCfg.rsiMaxAdx ?? 100;
    baselineBaseline.rsiMinVolatilityPct = rsiCfg.rsiMinVolatilityPct ?? 0.2;
    baselineBaseline.rsiMaxVolatilityPct = rsiCfg.rsiMaxVolatilityPct ?? 5.0;
    baselineBaseline.rsiFailureLong = rsiCfg.rsiFailureLong ?? 0;
    baselineBaseline.rsiFailureShort = rsiCfg.rsiFailureShort ?? 100;
    baselineBaseline.rsiTimeStopBars = rsiCfg.rsiTimeStopBars ?? 9999;
  }

  console.log(
    `\n🔄 Walk-Forward Analysis: ${mode} mode${optimizeParams ? " WITH OPTIMIZATION" : ""}`
  );
  console.log(`   Train: ${trainDays}d, Test: ${testDays}d, Step: ${stepDays}d`);
  if (optimizeParams) {
    console.log(`   🔧 Parameter Optimization: ENABLED (grid search on training window)`);
    console.log(
      `   Optimized params will be applied to test window, then compared to fixed baseline.`
    );
  } else {
    console.log(
      `   How to read this: each fold trains on earlier history and evaluates on a later, unseen window.`
    );
  }
  console.log(
    `   Degradation = (TestPnL - TrainPnL) / |TrainPnL|. Large negative values imply overfitting/regime dependence.`
  );

  // Build parameter grid for optimization (if enabled)
  const paramPairs = optimizeParams
    ? buildUnifiedParameterGrid(baselineBaseline, {
        mode: process.env.WF_GRID_MODE || "fast",
        coarseGrid: process.env.WF_COARSE_GRID === "1",
      })
    : [];

  for (let k = 0; ; k++) {
    const trainStart = mode === "anchored" ? startTime : startTime + k * stepMsEff;
    const trainEnd =
      mode === "anchored" ? startTime + trainMs + k * stepMsEff : trainStart + trainMs;
    const testStart = trainEnd;
    const testEnd = testStart + testMs;
    if (testEnd > endTime) break;

    foldNum = k + 1;
    console.log(
      `\n  📊 Fold ${foldNum}: Train [${new Date(trainStart).toISOString().slice(0, 10)} to ${new Date(trainEnd).toISOString().slice(0, 10)}], Test [${new Date(testStart).toISOString().slice(0, 10)} to ${new Date(testEnd).toISOString().slice(0, 10)}]`
    );

    try {
      // Run training period
      const trainCandlesMap = new Map();
      for (const [symbol, candles] of candlesMap.entries()) {
        const trainCandles = candles.filter(
          (c) => c.openTime >= trainStart && c.openTime < trainEnd
        );
        if (trainCandles.length > 0) {
          trainCandlesMap.set(symbol, trainCandles);
        }
      }

      if (trainCandlesMap.size === 0) {
        console.log(`    ⚠️  Skipping fold ${foldNum}: No training data`);
        continue;
      }

      const isBotModel = String(options._traceModel || "backtest").toLowerCase() === "bot";
      const simFn = isBotModel ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;
      const interval = options.interval || "5m";
      const tickSimEnabled = interval === "5m" || interval === "1m";

      // Build 1m candles and ticks for training period (if tick sim enabled)
      const trainOneMinCandlesMap = new Map();
      const trainTicksByBarOpenTimeMap = new Map();
      if (tickSimEnabled && oneMinCandlesMap) {
        for (const [symbol, oneMin] of oneMinCandlesMap.entries()) {
          const trainOneMin = oneMin.filter(
            (c) => c.openTime >= trainStart && c.openTime < trainEnd
          );
          if (trainOneMin.length > 0) {
            trainOneMinCandlesMap.set(symbol, trainOneMin);
            trainTicksByBarOpenTimeMap.set(symbol, buildTicksByBarOpenTimeFrom1m(trainOneMin));
          }
        }
      }

      // ===== RUN FIXED BASELINE ON TRAINING =====
      const trainStrategiesMap = new Map();
      for (const [symbol, cfg] of strategyConfigsMap.entries()) {
        const trainCfg = cloneJson(cfg);
        trainCfg.quiet = true;
        trainStrategiesMap.set(symbol, new RsiMeanReversionStrategy(trainCfg));
      }

      let trainResult = simFn(trainStrategiesMap, trainCandlesMap, {
        initialCapital: options.initialCapital,
        leverage: options.leverage,
        positionSizePercent: options.positionSizePercent,
        enableCompounding: options.enableCompounding,
        allowLongs: options.allowLongs,
        allowShorts: options.allowShorts,
        maxPositions: options.maxPositions,
        ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : 1,
        simulateTicks: tickSimEnabled,
        rsiHardStopPercent: options.rsiHardStopPercent,
        rsiHardStopAtr: options.rsiHardStopAtr,
        perMarketLeverage,
        perMarketHardStop,
        perMarketHardStopAtr,
        minPositionSize: options.minPositionSize,
        maxPositionSize: options.maxPositionSize,
        oneMinCandlesMap: trainOneMinCandlesMap,
        ticksByBarOpenTimeMap: trainTicksByBarOpenTimeMap,
      });

      const trainTrades = normalizeTradesForDailyReturns(
        Array.from(trainResult.marketResults.values()).flatMap((m) => m.trades)
      );
      const trainPnL = trainResult.realisedPnl || trainResult.totalPnL || 0;
      const trainDailyReturns = tradesToDailyReturns(trainTrades, options.initialCapital);
      const trainSharpe =
        trainDailyReturns.length > 0 ? calculateSharpeRatio(trainDailyReturns) : 0;
      const trainTradesCount = trainTrades.length; // Store count before clearing

      // MEMORY OPTIMIZATION: Clear large result objects after extracting metrics
      trainResult.marketResults?.clear();
      trainResult.marketResults = null;
      trainResult = null;
      trainTrades.length = 0;
      trainDailyReturns.length = 0;

      // ===== RUN OPTIMIZATION IF ENABLED =====
      let optimizedParams = null;
      let optimizedTrainPnL = 0;
      let optimizedTrainSharpe = 0;

      if (optimizeParams && paramPairs.length > 0) {
        const optResult = runWalkForwardOptimization(
          trainCandlesMap,
          strategyConfigsMap,
          options,
          perMarketLeverage,
          perMarketHardStop,
          perMarketHardStopAtr,
          baselineBaseline,
          paramPairs,
          trainOneMinCandlesMap,
          trainTicksByBarOpenTimeMap
        );

        if (optResult.bestParams && Object.keys(optResult.bestParams).length > 0) {
          optimizedParams = optResult.bestParams;
          optimizedTrainPnL = optResult.bestResult?.pnl ?? 0;
          optimizedTrainSharpe = optResult.bestResult?.sharpe ?? 0;

          parameterHistory.push({
            fold: foldNum,
            params: { ...optimizedParams },
            trainPnL: optimizedTrainPnL,
            trainSharpe: optimizedTrainSharpe,
          });

          console.log(
            `    🔧 Optimized: ${Object.entries(optimizedParams)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`
          );
          console.log(
            `    🔧 Opt Train: Sharpe ${optimizedTrainSharpe.toFixed(2)}, PnL ${formatUsd(optimizedTrainPnL)}`
          );
        }
      }

      // ===== RUN TEST PERIOD (OUT-OF-SAMPLE) =====
      const testCandlesMap = new Map();
      for (const [symbol, candles] of candlesMap.entries()) {
        const testCandles = candles.filter((c) => c.openTime >= testStart && c.openTime < testEnd);
        if (testCandles.length > 0) {
          testCandlesMap.set(symbol, testCandles);
        }
      }

      if (testCandlesMap.size === 0) {
        console.log(`    ⚠️  Skipping fold ${foldNum}: No test data`);
        continue;
      }

      // Build 1m candles and ticks for test period (if tick sim enabled)
      const testOneMinCandlesMap = new Map();
      const testTicksByBarOpenTimeMap = new Map();
      if (tickSimEnabled && oneMinCandlesMap) {
        for (const [symbol, oneMin] of oneMinCandlesMap.entries()) {
          const testOneMin = oneMin.filter((c) => c.openTime >= testStart && c.openTime < testEnd);
          if (testOneMin.length > 0) {
            testOneMinCandlesMap.set(symbol, testOneMin);
            testTicksByBarOpenTimeMap.set(symbol, buildTicksByBarOpenTimeFrom1m(testOneMin));
          }
        }
      }

      // --- Fixed params test ---
      const testStrategiesMap = new Map();
      for (const [symbol, cfg] of strategyConfigsMap.entries()) {
        const testCfg = cloneJson(cfg);
        testCfg.quiet = true;
        testStrategiesMap.set(symbol, new RsiMeanReversionStrategy(testCfg));
      }

      let testResult = simFn(testStrategiesMap, testCandlesMap, {
        initialCapital: options.initialCapital,
        leverage: options.leverage,
        positionSizePercent: options.positionSizePercent,
        enableCompounding: options.enableCompounding,
        allowLongs: options.allowLongs,
        allowShorts: options.allowShorts,
        maxPositions: options.maxPositions,
        ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : 1,
        simulateTicks: tickSimEnabled,
        rsiHardStopPercent: options.rsiHardStopPercent,
        rsiHardStopAtr: options.rsiHardStopAtr,
        perMarketLeverage,
        perMarketHardStop,
        perMarketHardStopAtr,
        minPositionSize: options.minPositionSize,
        maxPositionSize: options.maxPositionSize,
        oneMinCandlesMap: testOneMinCandlesMap,
        ticksByBarOpenTimeMap: testTicksByBarOpenTimeMap,
      });

      const testTrades = normalizeTradesForDailyReturns(
        Array.from(testResult.marketResults.values()).flatMap((m) => m.trades)
      );
      const testPnL = testResult.realisedPnl || testResult.totalPnL || 0;
      const testDailyReturns = tradesToDailyReturns(testTrades, options.initialCapital);
      const testSharpe = testDailyReturns.length > 0 ? calculateSharpeRatio(testDailyReturns) : 0;

      // --- Optimized params test (if optimization enabled) ---
      let optimizedTestPnL = 0;
      let optimizedTestSharpe = 0;
      let optimizedTestTrades = 0;

      if (optimizeParams && optimizedParams && Object.keys(optimizedParams).length > 0) {
        const { modifiedConfigsMap, modifiedOptions, modifiedLeverage, modifiedHardStop } =
          applyOptimizedParams(
            strategyConfigsMap,
            options,
            optimizedParams,
            perMarketLeverage,
            perMarketHardStop
          );

        const optTestStrategiesMap = new Map();
        for (const [symbol, cfg] of modifiedConfigsMap.entries()) {
          optTestStrategiesMap.set(symbol, new RsiMeanReversionStrategy(cfg));
        }

        let optTestResult = simFn(optTestStrategiesMap, testCandlesMap, {
          initialCapital: modifiedOptions.initialCapital,
          leverage: modifiedOptions.leverage,
          positionSizePercent: modifiedOptions.positionSizePercent,
          enableCompounding: modifiedOptions.enableCompounding,
          allowLongs: modifiedOptions.allowLongs,
          allowShorts: modifiedOptions.allowShorts,
          maxPositions: modifiedOptions.maxPositions,
          ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : 1,
          simulateTicks: tickSimEnabled,
          rsiHardStopPercent: modifiedOptions.rsiHardStopPercent,
          rsiHardStopAtr: modifiedOptions.rsiHardStopAtr,
          perMarketLeverage: modifiedLeverage,
          perMarketHardStop: modifiedHardStop,
          perMarketHardStopAtr,
          minPositionSize: modifiedOptions.minPositionSize,
          maxPositionSize: modifiedOptions.maxPositionSize,
          oneMinCandlesMap: testOneMinCandlesMap,
          ticksByBarOpenTimeMap: testTicksByBarOpenTimeMap,
        });

        const optTestTrades = normalizeTradesForDailyReturns(
          Array.from(optTestResult.marketResults.values()).flatMap((m) => m.trades)
        );
        optimizedTestPnL = optTestResult.realisedPnl || optTestResult.totalPnL || 0;
        const optTestDailyReturns = tradesToDailyReturns(optTestTrades, options.initialCapital);
        optimizedTestSharpe =
          optTestDailyReturns.length > 0 ? calculateSharpeRatio(optTestDailyReturns) : 0;
        optimizedTestTrades = optTestTrades.length;

        // MEMORY OPTIMIZATION: Clear optimized test result
        optTestResult.marketResults?.clear();
        optTestResult.marketResults = null;
        optTestResult = null;
        optTestTrades.length = 0;
        optTestDailyReturns.length = 0;
      }

      const foldData = {
        fold: foldNum,
        trainStart,
        trainEnd,
        testStart,
        testEnd,
        // Fixed params results
        trainPnL,
        trainTrades: trainTradesCount,
        trainSharpe,
        testPnL,
        testTrades: testTrades.length,
        testSharpe,
        degradation: trainPnL !== 0 ? (testPnL - trainPnL) / Math.abs(trainPnL) : 0,
      };

      // Add optimization results if enabled
      if (optimizeParams && optimizedParams) {
        foldData.optimizedParams = optimizedParams;
        foldData.optimizedTrainPnL = optimizedTrainPnL;
        foldData.optimizedTrainSharpe = optimizedTrainSharpe;
        foldData.optimizedTestPnL = optimizedTestPnL;
        foldData.optimizedTestSharpe = optimizedTestSharpe;
        foldData.optimizedTestTrades = optimizedTestTrades;
        foldData.optimizedDegradation =
          optimizedTrainPnL !== 0
            ? (optimizedTestPnL - optimizedTrainPnL) / Math.abs(optimizedTrainPnL)
            : 0;
        foldData.optimizationLift =
          testPnL !== 0 ? (optimizedTestPnL - testPnL) / Math.abs(testPnL) : 0;
      }

      folds.push(foldData);

      console.log(
        `    Fixed:     Train ${formatUsd(trainPnL)} (${foldData.trainTrades} trades, Sharpe ${trainSharpe.toFixed(2)}) → Test ${formatUsd(testPnL)} (${foldData.testTrades} trades, Sharpe ${testSharpe.toFixed(2)})`
      );
      if (optimizeParams && optimizedParams) {
        const lift = foldData.optimizationLift * 100;
        const liftStr = lift >= 0 ? `+${lift.toFixed(1)}%` : `${lift.toFixed(1)}%`;
        console.log(
          `    Optimized: Train ${formatUsd(optimizedTrainPnL)} (Sharpe ${optimizedTrainSharpe.toFixed(2)}) → Test ${formatUsd(optimizedTestPnL)} (${optimizedTestTrades} trades, Sharpe ${optimizedTestSharpe.toFixed(2)}) [Lift: ${liftStr}]`
        );
      }

      // MEMORY OPTIMIZATION: Clear test result and intermediate data structures after fold completes
      if (testResult && testResult.marketResults) {
        testResult.marketResults.clear();
        testResult.marketResults = null;
      }
      testResult = null;
      testTrades.length = 0;
      testDailyReturns.length = 0;

      // Clear intermediate Maps (only if they were created)
      trainCandlesMap.clear();
      testCandlesMap.clear();
      if (trainOneMinCandlesMap) trainOneMinCandlesMap.clear();
      if (testOneMinCandlesMap) testOneMinCandlesMap.clear();
      if (trainTicksByBarOpenTimeMap) trainTicksByBarOpenTimeMap.clear();
      if (testTicksByBarOpenTimeMap) testTicksByBarOpenTimeMap.clear();
      trainStrategiesMap.clear();
      testStrategiesMap.clear();

      // Force garbage collection hint if available (requires --expose-gc flag)
      if (global.gc && foldNum % 2 === 0) {
        global.gc();
      }
    } catch (err) {
      console.warn(`    ⚠️  Fold ${foldNum} failed: ${err.message}`);
    }
  }

  if (folds.length === 0) {
    return { folds: [], message: "No valid folds generated" };
  }

  // Calculate aggregate metrics
  const avgTrainPnL = folds.reduce((sum, f) => sum + f.trainPnL, 0) / folds.length;
  const avgTestPnL = folds.reduce((sum, f) => sum + f.testPnL, 0) / folds.length;
  const avgDegradation = folds.reduce((sum, f) => sum + f.degradation, 0) / folds.length;
  const positiveFolds = folds.filter((f) => f.testPnL > 0).length;
  const consistency = (positiveFolds / folds.length) * 100;

  const result = {
    folds,
    avgTrainPnL,
    avgTestPnL,
    avgDegradation,
    consistency,
    totalFolds: folds.length,
    positiveFolds,
  };

  // Add optimization metrics if enabled
  if (optimizeParams && parameterHistory.length > 0) {
    const optimizedFolds = folds.filter((f) => f.optimizedParams);

    result.optimization = {
      enabled: true,
      parameterHistory,
      avgOptimizedTrainPnL:
        optimizedFolds.length > 0
          ? optimizedFolds.reduce((sum, f) => sum + (f.optimizedTrainPnL || 0), 0) /
            optimizedFolds.length
          : 0,
      avgOptimizedTestPnL:
        optimizedFolds.length > 0
          ? optimizedFolds.reduce((sum, f) => sum + (f.optimizedTestPnL || 0), 0) /
            optimizedFolds.length
          : 0,
      avgOptimizedDegradation:
        optimizedFolds.length > 0
          ? optimizedFolds.reduce((sum, f) => sum + (f.optimizedDegradation || 0), 0) /
            optimizedFolds.length
          : 0,
      avgOptimizationLift:
        optimizedFolds.length > 0
          ? optimizedFolds.reduce((sum, f) => sum + (f.optimizationLift || 0), 0) /
            optimizedFolds.length
          : 0,
      positiveOptimizedFolds: optimizedFolds.filter((f) => f.optimizedTestPnL > 0).length,
      consistencyOptimized:
        optimizedFolds.length > 0
          ? (optimizedFolds.filter((f) => f.optimizedTestPnL > 0).length / optimizedFolds.length) *
            100
          : 0,
    };

    // Calculate parameter stability (variance across folds)
    const paramKeys = Object.keys(parameterHistory[0]?.params || {});
    const paramStability = {};
    for (const key of paramKeys) {
      const values = parameterHistory.map((h) => h.params[key]).filter((v) => v !== undefined);
      if (values.length > 1) {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
        const stdDev = Math.sqrt(variance);
        const cv = mean !== 0 ? stdDev / Math.abs(mean) : 0; // Coefficient of variation
        paramStability[key] = { mean, stdDev, cv, values };
      }
    }
    result.optimization.parameterStability = paramStability;

    // Generate recommendations
    result.optimization.recommendations = generateWFRecommendations(
      result.optimization,
      avgTestPnL,
      (avgOptimizedTestPnL) => result.optimization.avgOptimizedTestPnL
    );
  }

  return result;
}

/**
 * Generate parameter recommendations from WF optimization results
 */
function generateWFRecommendations(optimizationResult, fixedTestPnL, optimizedTestPnL) {
  const recommendations = [];
  const { parameterHistory, parameterStability, avgOptimizationLift } = optimizationResult;

  if (!parameterHistory || parameterHistory.length === 0) return recommendations;

  // Check if optimization provides significant lift
  if (avgOptimizationLift > 0.1) {
    recommendations.push({
      type: "OPTIMIZATION_BENEFICIAL",
      message: `Optimization improves OOS performance by ${(avgOptimizationLift * 100).toFixed(1)}% on average`,
      action: "Consider enabling periodic parameter re-tuning in production",
    });
  } else if (avgOptimizationLift < -0.1) {
    recommendations.push({
      type: "FIXED_PARAMS_BETTER",
      message: `Fixed params outperform optimized by ${(Math.abs(avgOptimizationLift) * 100).toFixed(1)}%`,
      action: "Current fixed parameters are robust - no frequent re-tuning needed",
    });
  } else {
    recommendations.push({
      type: "MARGINAL_DIFFERENCE",
      message: "Optimization provides minimal lift over fixed parameters",
      action: "Parameters are relatively stable across regimes",
    });
  }

  // Check parameter stability
  for (const [param, stats] of Object.entries(parameterStability || {})) {
    if (stats.cv > 0.3) {
      recommendations.push({
        type: "UNSTABLE_PARAM",
        param,
        message: `${param} varies significantly across folds (CV=${(stats.cv * 100).toFixed(1)}%)`,
        values: stats.values,
        action: `Consider making ${param} adaptive or regime-dependent`,
      });
    } else if (stats.cv < 0.1 && stats.values.length > 1) {
      // Parameter is stable - suggest using the mean
      recommendations.push({
        type: "STABLE_PARAM",
        param,
        message: `${param} is stable across folds (mean=${stats.mean.toFixed(2)}, CV=${(stats.cv * 100).toFixed(1)}%)`,
        suggestedValue: stats.mean,
        action: `Consider setting ${param}=${Math.round(stats.mean)}`,
      });
    }
  }

  // Most common optimal parameters across folds
  const paramCounts = {};
  for (const { params } of parameterHistory) {
    for (const [key, value] of Object.entries(params)) {
      const paramKey = `${key}=${value}`;
      paramCounts[paramKey] = (paramCounts[paramKey] || 0) + 1;
    }
  }

  const mostCommon = Object.entries(paramCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .filter(([_, count]) => count >= 2);

  if (mostCommon.length > 0) {
    recommendations.push({
      type: "MOST_COMMON_OPTIMAL",
      message: "Most frequently optimal parameters across folds",
      params: mostCommon.map(([param, count]) => ({
        param,
        occurrences: count,
        pctFolds: ((count / parameterHistory.length) * 100).toFixed(0) + "%",
      })),
    });
  }

  return recommendations;
}

/**
 * Print robustness test results and recommendations
 */
function printRobustnessResults({
  jitterResult,
  bootstrapResult,
  heatmapResult,
  walkForwardResult,
  robustnessConfig,
  originalResult,
  formatUsd,
  formatPct,
}) {
  console.log("\n===== Parameter Robustness & Stability =====");

  // Light jitter tests (default ON)
  if (robustnessConfig.enableJitter && jitterResult) {
    console.log(`\n📊 Jitter Robustness Suite (re-simulated parameter perturbations):`);
    console.log(`  Baseline PnL: ${formatUsd(jitterResult.baselinePnL)}`);
    console.log(
      `  Tests Passed: ${jitterResult.totalTests - jitterResult.collapsedCount}/${jitterResult.totalTests}`
    );

    if (jitterResult.collapsedCount > 0) {
      console.log(
        `  ⚠️  WARNING: ${jitterResult.collapsedCount} test(s) collapsed (>50% PnL drop)`
      );
      for (const test of jitterResult.jitterResults) {
        if (test.collapsed) {
          const change = Number.isFinite(test.pnlChange)
            ? formatPct(test.pnlChange * 100)
            : "ERROR";
          console.log(
            `    ❌ ${test.test}: PnL ${formatUsd(test.pnl || 0)} (${change} vs baseline)`
          );
        }
      }
    } else {
      console.log(`  ✅ All jitter tests passed - parameters are robust`);
    }

    console.log(`  Detailed Results:`);
    for (const test of jitterResult.jitterResults) {
      if (test.error) {
        console.log(`    ${test.test}: ERROR - ${test.error}`);
      } else {
        const change = formatPct(test.pnlChange * 100);
        const status = test.collapsed ? "❌" : "✅";
        const sharpe = Number.isFinite(test.sharpe) ? test.sharpe.toFixed(2) : "n/a";
        const mar = Number.isFinite(test.mar) ? test.mar.toFixed(2) : "n/a";
        console.log(
          `    ${status} ${test.test}: ${formatUsd(test.pnl)} (${change}) | trades=${test.trades ?? "n/a"} | sharpe=${sharpe} | mar=${mar}`
        );
      }
    }
  }

  // Bootstrap CI (default OFF, show if enabled)
  if (robustnessConfig.enableBootstrap && bootstrapResult) {
    console.log(
      `\n📊 Bootstrap Confidence Intervals (${bootstrapResult.numBootstrap} resamples, block bootstrap with BCa adjustment):`
    );
    console.log(
      `  Sharpe 95% CI: [${bootstrapResult.sharpeCI[0].toFixed(3)}, ${bootstrapResult.sharpeCI[1].toFixed(3)}]`
    );
    console.log(
      `  MAR 95% CI: [${bootstrapResult.marCI[0].toFixed(3)}, ${bootstrapResult.marCI[1].toFixed(3)}]`
    );

    if (bootstrapResult.baselineSharpe !== undefined) {
      console.log(`  Baseline Sharpe: ${bootstrapResult.baselineSharpe.toFixed(3)}`);
    }
    if (bootstrapResult.baselineMAR !== undefined) {
      console.log(`  Baseline MAR: ${bootstrapResult.baselineMAR.toFixed(3)}`);
    }

    if (bootstrapResult.widthReduction) {
      console.log(
        `  CI Width Reduction: Sharpe ${bootstrapResult.widthReduction.sharpe.toFixed(1)}%, MAR ${bootstrapResult.widthReduction.mar.toFixed(1)}%`
      );
    }

    // Check if CI overlaps zero or benchmark
    if (bootstrapResult.sharpeCI[1] <= 0) {
      console.log(`  ⚠️  WARNING: Sharpe CI overlaps zero - may not be statistically significant`);
    } else if (bootstrapResult.sharpeCI[0] > 0) {
      console.log(`  ✅ Sharpe CI is entirely positive - statistically significant`);
    }
    if (bootstrapResult.marCI[1] <= 0) {
      console.log(`  ⚠️  WARNING: MAR CI overlaps zero - may not be statistically significant`);
    } else if (bootstrapResult.marCI[0] > 0) {
      console.log(`  ✅ MAR CI is entirely positive - statistically significant`);
    }
  }

  // Heatmap (default OFF, show if enabled) - now per-market with MULTI-MARKET simulation
  if (robustnessConfig.enableHeatmap && heatmapResult) {
    const { perMarket, recommendations } = heatmapResult;

    if (perMarket && perMarket.length > 0) {
      console.log(`\n📊 Per-Market Sensitivity Surfaces (MULTI-MARKET MODE - shared capital):`);
      console.log(`  Legend: ██=top 25%, ▓▓=50-75%, ▒▒=25-50%, ░░=bottom 25%, *=baseline, ★=best`);
      console.log(
        `  Note: Values show PORTFOLIO P&L (not single-market) when only ${perMarket.map((m) => m.symbol).join("/")} params change`
      );

      for (const marketResult of perMarket) {
        const portfolioBase = marketResult.baselinePortfolioPnL ?? marketResult.baselinePnL ?? 0;
        const marketBase = marketResult.baselineMarketPnL ?? 0;
        console.log(`\n  ═══════════════════════════════════════════════════════════════`);
        console.log(
          `  📈 ${marketResult.symbol} (Portfolio: ${formatUsd(portfolioBase)}, ${marketResult.symbol}: ${formatUsd(marketBase)})`
        );
        console.log(`  ═══════════════════════════════════════════════════════════════`);

        for (const heatmap of marketResult.heatmaps) {
          console.log(`\n    ${heatmap.name}:`);
          console.log(
            `    Current: ${heatmap.param1}=${heatmap.baseline[heatmap.param1]}, ${heatmap.param2}=${heatmap.baseline[heatmap.param2]}`
          );

          // Find min/max for scaling (use portfolioPnl if available, fallback to pnl)
          const pnlValues = heatmap.heatmap
            .map((h) => h.portfolioPnl ?? h.pnl)
            .filter((v) => Number.isFinite(v));
          if (pnlValues.length === 0) {
            console.log(`      (no valid points computed)`);
            continue;
          }
          const minPnL = Math.min(...pnlValues);
          const maxPnL = Math.max(...pnlValues);
          const rangePnL = maxPnL - minPnL;

          // Print heatmap as table
          console.log(`      ${heatmap.param1} ↓ / ${heatmap.param2} →`);
          const header = ["        "].concat(heatmap.range2.map((v) => String(v).padStart(8)));
          console.log(`      ${header.join(" ")}`);

          for (const val1 of heatmap.range1) {
            const row = [String(val1).padStart(7)];
            for (const val2 of heatmap.range2) {
              const point = heatmap.heatmap.find(
                (h) => h[heatmap.param1] === val1 && h[heatmap.param2] === val2
              );
              if (point) {
                if (point.invalid) {
                  row.push("  INV  ");
                  continue;
                }
                if (point.error) {
                  row.push("  ERR  ");
                  continue;
                }
                const pointPnl = point.portfolioPnl ?? point.pnl;
                if (!Number.isFinite(pointPnl)) {
                  row.push("  N/A  ");
                  continue;
                }
                // Normalize to 0-1, then map to symbol
                const normalized = rangePnL > 0 ? (pointPnl - minPnL) / rangePnL : 0.5;
                let sym =
                  normalized > 0.75
                    ? "██"
                    : normalized > 0.5
                      ? "▓▓"
                      : normalized > 0.25
                        ? "▒▒"
                        : "░░";

                // Mark baseline and best cells
                const isBaseline =
                  val1 === heatmap.baseline[heatmap.param1] &&
                  val2 === heatmap.baseline[heatmap.param2];
                const isBest =
                  heatmap.best &&
                  val1 === heatmap.best[heatmap.param1] &&
                  val2 === heatmap.best[heatmap.param2];
                if (isBest && isBaseline) {
                  sym = "★*";
                } else if (isBest) {
                  sym = "★ ";
                } else if (isBaseline) {
                  sym = "* ";
                }

                row.push(`${sym}${String(Math.round(pointPnl)).padStart(6)}`);
              } else {
                row.push("  N/A  ");
              }
            }
            console.log(`      ${row.join(" ")}`);
          }

          // Show best cell info (portfolio-level)
          const bestPnl = heatmap.best?.portfolioPnl ?? heatmap.best?.pnl;
          if (heatmap.best && Number.isFinite(bestPnl)) {
            const improvementVsBaseline = bestPnl - portfolioBase;
            console.log(
              `      Best: ${heatmap.param1}=${heatmap.best[heatmap.param1]}, ${heatmap.param2}=${heatmap.best[heatmap.param2]} → Portfolio ${formatUsd(bestPnl)} (${improvementVsBaseline >= 0 ? "+" : ""}${formatUsd(improvementVsBaseline)} vs baseline)`
            );

            // Plateau vs needle heuristic:
            // - Plateau: many nearby points close to best (less sensitive)
            // - Needle: only a few points close to best (high sensitivity / overfitting risk)
            const validPnLs = heatmap.heatmap
              .map((h) => h.portfolioPnl ?? h.pnl)
              .filter((v) => Number.isFinite(v));
            const validCount = validPnLs.length;
            if (validCount > 0) {
              const best = bestPnl;
              const threshold = best >= 0 ? best * 0.9 : best * 1.1; // within 10% of best (direction-aware)
              const plateauCount = validPnLs.filter((v) =>
                best >= 0 ? v >= threshold : v >= threshold
              ).length;
              const plateauPct = (plateauCount / validCount) * 100;
              const sensitivityLabel =
                plateauPct >= 25 ? "PLATEAU ✅" : plateauPct <= 10 ? "NEEDLE ⚠️" : "MODERATE";
              console.log(
                `      Stability: ${sensitivityLabel} | Near-best cells: ${plateauCount}/${validCount} (${plateauPct.toFixed(1)}% within 10% of best)`
              );
            }
          }
        }
      }

      // Print consolidated recommendations (now based on PORTFOLIO improvement)
      if (recommendations && recommendations.length > 0) {
        console.log(`\n  ═══════════════════════════════════════════════════════════════`);
        console.log(`  💡 PARAMETER RECOMMENDATIONS (>10% PORTFOLIO improvement)`);
        console.log(`  ═══════════════════════════════════════════════════════════════`);
        console.log(`  Note: Recommendations based on total portfolio P&L with shared capital`);

        for (const { symbol, recommendations: recs } of recommendations) {
          console.log(`\n    ${symbol}:`);
          for (const rec of recs) {
            const basePortfolio = rec.baselinePortfolioPnL ?? rec.currentPnL ?? 0;
            const recPortfolio = rec.recommendedPortfolioPnL ?? rec.recommendedPnL ?? 0;
            console.log(`      📌 ${rec.surface}:`);
            console.log(
              `         Current: ${rec.param1}=${rec.currentVal1}, ${rec.param2}=${rec.currentVal2} → Portfolio ${formatUsd(basePortfolio)}`
            );
            console.log(
              `         Suggest: ${rec.param1}=${rec.recommendedVal1}, ${rec.param2}=${rec.recommendedVal2} → Portfolio ${formatUsd(recPortfolio)}`
            );
            console.log(
              `         Improvement: ${formatUsd(rec.improvement)} (${formatPct(rec.improvementPct)}), Sharpe: ${rec.sharpe?.toFixed(2) || "n/a"}, Trades: ${rec.trades}`
            );
          }
        }

        // Generate env file snippet
        console.log(`\n    📋 Suggested .env changes:`);
        for (const { symbol, recommendations: recs } of recommendations) {
          const marketKey = `${symbol}_PERP`.toUpperCase();
          for (const rec of recs) {
            // Map internal param names to env var names
            const envMappings = {
              rsiOversoldExtreme: `STRATEGY_${marketKey}_RSI_OVERSOLD_EXTREME`,
              rsiOversoldRecovery: `STRATEGY_${marketKey}_RSI_OVERSOLD_RECOVERY`,
              rsiOverboughtExtreme: `STRATEGY_${marketKey}_RSI_OVERBOUGHT_EXTREME`,
              rsiOverboughtRecovery: `STRATEGY_${marketKey}_RSI_OVERBOUGHT_RECOVERY`,
              rsiTargetLong: `STRATEGY_${marketKey}_RSI_TARGET_LONG`,
              rsiTargetShort: `STRATEGY_${marketKey}_RSI_TARGET_SHORT`,
              rsiMinAdx: `STRATEGY_${marketKey}_MIN_ADX`,
              rsiMaxAdx: `STRATEGY_${marketKey}_MAX_ADX`,
              rsiFailureLong: `STRATEGY_${marketKey}_RSI_FAILURE_LONG`,
              rsiFailureShort: `STRATEGY_${marketKey}_RSI_FAILURE_SHORT`,
              rsiMinVolatilityPct: `STRATEGY_${marketKey}_MIN_VOLATILITY_PCT`,
              rsiMaxVolatilityPct: `STRATEGY_${marketKey}_MAX_VOLATILITY_PCT`,
              rsiTimeStopBars: `STRATEGY_${marketKey}_TIME_STOP_BARS`,
              // Leverage and risk management
              leverage: `STRATEGY_${marketKey}_LEVERAGE`,
              hardStopPercent: `STRATEGY_${marketKey}_HARD_STOP_PERCENT`,
              // Position sizing (global, not per-market)
              positionSizePercent: `POSITION_SIZE_PERCENT`,
            };

            const env1 = envMappings[rec.param1];
            const env2 = envMappings[rec.param2];
            if (env1) console.log(`       ${env1}=${rec.recommendedVal1}`);
            if (env2) console.log(`       ${env2}=${rec.recommendedVal2}`);
          }
        }
      } else {
        console.log(`\n  ✅ No significant parameter improvements found (>10% vs baseline)`);
        console.log(`     Current parameters appear to be near-optimal for the test period.`);
      }
    }
  }

  // Walk-forward analysis
  if (
    robustnessConfig.enableWalkForward &&
    walkForwardResult &&
    walkForwardResult.folds.length > 0
  ) {
    const hasOptimization = walkForwardResult.optimization?.enabled;

    console.log(
      `\n📊 Walk-Forward Analysis (${walkForwardResult.totalFolds} folds)${hasOptimization ? " WITH OPTIMIZATION" : ""}:`
    );
    console.log(
      `  Each fold trains on an earlier window and evaluates on a later, unseen test window.`
    );
    console.log(
      `  Consistency = % folds with positive Test PnL. Degradation < 0 means OOS underperformed IS.`
    );

    console.log(`\n  ── FIXED PARAMS (baseline .env configuration) ──`);
    console.log(`  Average Train PnL: ${formatUsd(walkForwardResult.avgTrainPnL)}`);
    console.log(`  Average Test PnL:  ${formatUsd(walkForwardResult.avgTestPnL)}`);
    console.log(`  Average Degradation: ${formatPct(walkForwardResult.avgDegradation * 100)}`);
    console.log(
      `  Consistency: ${walkForwardResult.consistency.toFixed(1)}% (${walkForwardResult.positiveFolds}/${walkForwardResult.totalFolds} folds profitable)`
    );

    if (walkForwardResult.avgDegradation < -0.3) {
      console.log(`  ⚠️  WARNING: Significant degradation (>30%) in out-of-sample performance`);
    } else if (walkForwardResult.avgDegradation < 0) {
      console.log(`  ⚠️  CAUTION: Some degradation in out-of-sample performance`);
    } else {
      console.log(`  ✅ Test performance matches or exceeds training performance`);
    }

    // Show optimization results if enabled
    if (hasOptimization) {
      const opt = walkForwardResult.optimization;

      console.log(`\n  ── OPTIMIZED PARAMS (grid search per fold) ──`);
      console.log(`  Average Opt Train PnL: ${formatUsd(opt.avgOptimizedTrainPnL)}`);
      console.log(`  Average Opt Test PnL:  ${formatUsd(opt.avgOptimizedTestPnL)}`);
      console.log(`  Average Opt Degradation: ${formatPct(opt.avgOptimizedDegradation * 100)}`);
      console.log(
        `  Opt Consistency: ${opt.consistencyOptimized.toFixed(1)}% (${opt.positiveOptimizedFolds}/${walkForwardResult.totalFolds} folds profitable)`
      );

      const liftPct = opt.avgOptimizationLift * 100;
      const liftStr = liftPct >= 0 ? `+${liftPct.toFixed(1)}%` : `${liftPct.toFixed(1)}%`;
      console.log(`  📈 Optimization Lift: ${liftStr} (avg improvement over fixed params)`);

      if (opt.avgOptimizationLift > 0.1) {
        console.log(`  ✅ Optimization provides meaningful lift - consider periodic re-tuning`);
      } else if (opt.avgOptimizationLift < -0.1) {
        console.log(`  ⚠️  Fixed params outperform optimized - current config is robust`);
      } else {
        console.log(`  ➖ Marginal difference - parameters are stable across regimes`);
      }

      // Parameter stability analysis
      if (opt.parameterStability && Object.keys(opt.parameterStability).length > 0) {
        console.log(`\n  ── PARAMETER STABILITY ANALYSIS ──`);
        console.log(`  (CV = Coefficient of Variation: <10% = stable, >30% = unstable)`);

        const stableParams = [];
        const unstableParams = [];

        for (const [param, stats] of Object.entries(opt.parameterStability)) {
          const cvPct = (stats.cv * 100).toFixed(1);
          const meanVal = typeof stats.mean === "number" ? stats.mean.toFixed(2) : stats.mean;

          if (stats.cv > 0.3) {
            unstableParams.push({ param, cvPct, meanVal, values: stats.values });
            console.log(
              `    ⚠️  ${param}: CV=${cvPct}% (UNSTABLE) - values: [${stats.values.join(", ")}]`
            );
          } else if (stats.cv < 0.1) {
            stableParams.push({ param, cvPct, meanVal });
            console.log(`    ✅ ${param}: CV=${cvPct}% (stable) - mean=${meanVal}`);
          } else {
            console.log(`    ➖ ${param}: CV=${cvPct}% (moderate) - mean=${meanVal}`);
          }
        }
      }

      // Recommendations
      if (opt.recommendations && opt.recommendations.length > 0) {
        console.log(`\n  ── OPTIMIZATION RECOMMENDATIONS ──`);

        for (const rec of opt.recommendations) {
          if (rec.type === "OPTIMIZATION_BENEFICIAL") {
            console.log(`  📈 ${rec.message}`);
            console.log(`     → ${rec.action}`);
          } else if (rec.type === "FIXED_PARAMS_BETTER") {
            console.log(`  🔒 ${rec.message}`);
            console.log(`     → ${rec.action}`);
          } else if (rec.type === "STABLE_PARAM") {
            console.log(
              `  💡 Stable: ${rec.param} → suggest value: ${Math.round(rec.suggestedValue)}`
            );
          } else if (rec.type === "UNSTABLE_PARAM") {
            console.log(`  ⚠️  Unstable: ${rec.param} - ${rec.message}`);
          } else if (rec.type === "MOST_COMMON_OPTIMAL") {
            console.log(`  📊 Most frequently optimal params:`);
            for (const p of rec.params || []) {
              console.log(`      ${p.param} (${p.pctFolds} of folds)`);
            }
          }
        }

        // Generate .env snippet for stable params
        const envSnippet = [];
        for (const rec of opt.recommendations) {
          if (rec.type === "STABLE_PARAM" && rec.suggestedValue !== undefined) {
            const envMappings = {
              rsiOversoldExtreme: "RSI_OVERSOLD_EXTREME",
              rsiOversoldRecovery: "RSI_OVERSOLD_RECOVERY",
              rsiOverboughtExtreme: "RSI_OVERBOUGHT_EXTREME",
              rsiOverboughtRecovery: "RSI_OVERBOUGHT_RECOVERY",
              rsiTargetLong: "RSI_TARGET_LONG",
              rsiTargetShort: "RSI_TARGET_SHORT",
              rsiMinAdx: "MIN_ADX",
              rsiMaxAdx: "MAX_ADX",
              leverage: "LEVERAGE",
              hardStopPercent: "HARD_STOP_PERCENT",
              positionSizePercent: "POSITION_SIZE_PERCENT",
            };
            const envKey = envMappings[rec.param];
            if (envKey) {
              envSnippet.push(`${envKey}=${Math.round(rec.suggestedValue)}`);
            }
          }
        }

        if (envSnippet.length > 0) {
          console.log(`\n  📋 Suggested .env updates (from WF optimization):`);
          for (const line of envSnippet) {
            console.log(`     ${line}`);
          }
        }
      }
    }

    console.log(`\n  ── FOLD-BY-FOLD RESULTS ──`);
    for (const fold of walkForwardResult.folds) {
      const trainDate = new Date(fold.trainStart).toISOString().slice(0, 10);
      const testDate = new Date(fold.testStart).toISOString().slice(0, 10);
      const deg = formatPct(fold.degradation * 100);

      let foldLine = `    Fold ${fold.fold}: Fixed → Train ${formatUsd(fold.trainPnL)} / Test ${formatUsd(fold.testPnL)} (${deg})`;

      if (hasOptimization && fold.optimizedParams) {
        const optDeg = formatPct((fold.optimizedDegradation || 0) * 100);
        const lift = ((fold.optimizationLift || 0) * 100).toFixed(1);
        const liftStr = fold.optimizationLift >= 0 ? `+${lift}%` : `${lift}%`;
        foldLine += `\n           Opt   → Train ${formatUsd(fold.optimizedTrainPnL || 0)} / Test ${formatUsd(fold.optimizedTestPnL || 0)} (${optDeg}) [Lift: ${liftStr}]`;
        foldLine += `\n           Params: ${Object.entries(fold.optimizedParams)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`;
      }

      console.log(foldLine);
    }
  }

  // Recommendations for default=OFF metrics
  if (
    !robustnessConfig.enableBootstrap ||
    !robustnessConfig.enableHeatmap ||
    !robustnessConfig.enableWalkForward
  ) {
    console.log(`\n💡 Recommendations for Periodic Deep Analysis:`);

    if (!robustnessConfig.enableBootstrap) {
      console.log(`  📊 Bootstrap CI: Enable with ROBUST_BOOTSTRAP=1 to get confidence intervals`);
      console.log(`     → Checks if Sharpe/MAR CI overlaps benchmark (decline promotion if yes)`);
    }

    if (!robustnessConfig.enableHeatmap) {
      console.log(
        `  📊 Sensitivity Heatmaps: Enable with ROBUST_HEATMAP=1 for parameter robustness`
      );
      console.log(`     → Shows wide plateaus vs needle peaks in parameter space`);
      console.log(`     → Identifies stable parameter ranges`);
    }

    if (!robustnessConfig.enableWalkForward) {
      console.log(
        `  📊 Walk-Forward Analysis: Enable with ROBUST_WALK_FORWARD=1 for out-of-sample validation`
      );
      console.log(`     → Tests strategy performance on unseen data (industry standard)`);
      console.log(`     → Configure with WF_TRAIN_DAYS, WF_TEST_DAYS, WF_STEP_DAYS, WF_MODE`);
    }

    console.log(`  💡 Run these periodically (weekly/monthly) to validate parameter stability`);
  }
}

// ============================================================
// RESULTS PRINTING
// ============================================================
function printResults(result, days, config) {
  const { trades, realisedPnl, totalFees, equitySeries, initialCapital } = result;

  // Print per-trade details first
  console.log("\n" + "=".repeat(100));
  console.log("                              PER-TRADE DETAILS");
  console.log("=".repeat(100));

  console.log("\n" + "-".repeat(100));
  console.log(
    "  #  | Side  | Entry Time          | Entry Price | Entry RSI | Exit Time           | Exit Price | Exit RSI | Exit Reason              | P&L USD   | P&L %"
  );
  console.log("-".repeat(100));

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const entryTime = new Date(t.openTime).toISOString().slice(0, 19).replace("T", " ");
    const exitTime = new Date(t.exitTime).toISOString().slice(0, 19).replace("T", " ");
    const entryPrice = t.entryPrice?.toFixed(2) || "N/A";
    const exitPrice = t.exitPrice?.toFixed(2) || "N/A";
    const entryRsi = t.entryRsi?.toFixed(1) || "N/A";
    const exitRsi = t.exitRsi?.toFixed(1) || "N/A";
    const totalPnl = t.totalPnlUsd ?? t.pnlUsd ?? 0;
    const pnlUsd = totalPnl.toFixed(2);
    const pnlPct = t.pnlPct?.toFixed(2) || "0.00";
    const reason = (t.exitReason || "unknown").padEnd(24);
    const side = (t.side || "N/A").padEnd(5);
    const emoji = totalPnl >= 0 ? "✅" : "❌";

    console.log(
      `${emoji} ${String(i + 1).padStart(2)} | ${side} | ${entryTime} | $${entryPrice.padStart(9)} | ${String(entryRsi).padStart(9)} | ${exitTime} | $${exitPrice.padStart(8)} | ${String(exitRsi).padStart(8)} | ${reason} | $${pnlUsd.padStart(8)} | ${pnlPct.padStart(6)}%`
    );

    // Show partial fills if any
    if (t.fills && t.fills.length > 0) {
      for (const fill of t.fills) {
        const fillTime = new Date(fill.ts).toISOString().slice(0, 19).replace("T", " ");
        const fillReason = (fill.reason || fill.type || "unknown").padEnd(24);
        const fillPnl = fill.pnlUsd?.toFixed(2) || "0.00";
        console.log(
          `   ↳ PARTIAL | ${fillTime} | $${fill.price?.toFixed(2).padStart(9)} | RSI: ${fill.rsi?.toFixed(1) || "N/A"} | ${fillReason} | Qty: ${fill.quantity?.toFixed(4)} | P&L: $${fillPnl}`
        );
      }
    }
  }

  console.log("-".repeat(100));

  console.log("\n" + "=".repeat(70));
  console.log("                 RSI MEAN-REVERSION BACKTEST RESULTS");
  console.log("=".repeat(70));

  // Overall summary
  const summary = summarise(trades);
  const bySide = summariseBySide(trades);
  const byReason = summariseByExitReason(trades);
  const maxDD = calculateMaxDrawdown(equitySeries);
  const dailyReturns = tradesToDailyReturns(trades, initialCapital);
  const sharpe = calculateSharpeRatio(dailyReturns);

  console.log("\n📊 OVERALL PERFORMANCE");
  console.log("-".repeat(40));
  console.log(`  Total Trades:      ${summary.count}`);
  console.log(`  Winning Trades:    ${summary.wins} (${summary.winRate.toFixed(1)}%)`);
  console.log(`  Losing Trades:     ${summary.losses}`);
  console.log(`  Breakeven:         ${summary.breakeven}`);
  console.log(`  `);
  console.log(
    `  Total P&L:         $${realisedPnl.toFixed(2)} (${((realisedPnl / initialCapital) * 100).toFixed(2)}%)`
  );
  console.log(`  Total Fees:        $${totalFees.toFixed(2)}`);
  console.log(`  Net P&L:           $${realisedPnl.toFixed(2)}`);
  console.log(`  `);
  console.log(`  Max Win:           $${summary.maxWin.toFixed(2)}`);
  console.log(`  Max Loss:          $${summary.maxLoss.toFixed(2)}`);
  console.log(`  Avg P&L:           $${(summary.pnlUsd / summary.count || 0).toFixed(2)}`);
  console.log(`  Avg P&L %:         ${summary.pnlPctAvg.toFixed(2)}%`);
  console.log(`  `);
  console.log(`  Max Drawdown:      ${maxDD.toFixed(2)}%`);
  console.log(`  Sharpe Ratio:      ${sharpe.toFixed(2)}`);
  console.log(`  Avg Hold Time:     ${(summary.avgHoldMs / 3600000).toFixed(1)} hours`);

  // By side
  console.log("\n📈 PERFORMANCE BY SIDE");
  console.log("-".repeat(40));
  console.log(
    `  LONG:  ${bySide.long.count} trades | Win Rate: ${bySide.long.winRate.toFixed(1)}% | P&L: $${bySide.long.pnlUsd.toFixed(2)}`
  );
  console.log(
    `  SHORT: ${bySide.short.count} trades | Win Rate: ${bySide.short.winRate.toFixed(1)}% | P&L: $${bySide.short.pnlUsd.toFixed(2)}`
  );

  // By exit reason
  console.log("\n🚪 PERFORMANCE BY EXIT REASON");
  console.log("-".repeat(40));
  for (const [reason, stats] of Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)) {
    const emoji = reason.includes("target")
      ? "✅"
      : reason.includes("max_loss")
        ? "🛑"
        : reason.includes("failure") || reason.includes("hard")
          ? "❌"
          : reason.includes("time")
            ? "⏰"
            : reason.includes("partial")
              ? "📊"
              : "📌";
    console.log(
      `  ${emoji} ${reason.padEnd(25)} ${String(stats.count).padStart(3)} trades | Win: ${stats.winRate.toFixed(0).padStart(3)}% | P&L: $${stats.pnlUsd.toFixed(2)}`
    );
  }

  // Configuration summary
  console.log("\n⚙️  CONFIGURATION");
  console.log("-".repeat(40));
  console.log(`  RSI Period:           ${config.rsiPeriod}`);
  console.log(`  Oversold Extreme:     ${config.rsiOversoldExtreme}`);
  console.log(`  Oversold Recovery:    ${config.rsiOversoldRecovery}`);
  console.log(`  Overbought Extreme:   ${config.rsiOverboughtExtreme}`);
  console.log(`  Overbought Recovery:  ${config.rsiOverboughtRecovery}`);
  console.log(`  Target Neutral:       ${config.rsiTargetNeutral}`);
  console.log(`  Partial Long:         ${config.rsiPartialTargetLong}`);
  console.log(`  Partial Short:        ${config.rsiPartialTargetShort}`);
  console.log(`  Time Stop Bars:       ${config.rsiTimeStopBars}`);
  console.log(`  Hard Stop ATR:        ${config.rsiHardStopAtr}x`);

  // Trades per day
  const tradesPerDay = summary.count / days;
  const profitFactor =
    summary.wins > 0 && summary.losses > 0
      ? trades.filter((t) => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0) /
        Math.abs(trades.filter((t) => t.pnlUsd < 0).reduce((s, t) => s + t.pnlUsd, 0))
      : 0;

  console.log("\n📅 FREQUENCY");
  console.log("-".repeat(40));
  console.log(`  Backtest Period:      ${days} days`);
  console.log(`  Trades per Day:       ${tradesPerDay.toFixed(2)}`);
  console.log(`  Profit Factor:        ${profitFactor.toFixed(2)}`);

  console.log("\n" + "=".repeat(70));

  return { summary, bySide, byReason, maxDD, sharpe, profitFactor, tradesPerDay };
}

// ============================================================
// CLI ARGUMENT PARSING (reads from env with CLI overrides)
// ============================================================

// Helper to safely parse numbers from env
function envNum(key, fallback) {
  const val = parseFloat(process.env[key]);
  return Number.isFinite(val) ? val : fallback;
}

function envInt(key, fallback) {
  const val = parseInt(process.env[key], 10);
  return Number.isFinite(val) ? val : fallback;
}

function envBool(key, fallback) {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  return val === "true" || val === "1" || val === "yes";
}

function parseNumberList(v) {
  if (v === undefined || v === null) return [];
  const s = String(v).trim();
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

function parseTimeArg(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function getMarketFailureBaseline(strategyConfigsMap, symbol, options) {
  const cfg = strategyConfigsMap?.get(symbol);
  const rsiCfg = cfg?.rsiStrategy || {};
  return {
    long: Number.isFinite(rsiCfg.rsiFailureLong)
      ? rsiCfg.rsiFailureLong
      : (options?.rsiFailureLong ?? 0),
    short: Number.isFinite(rsiCfg.rsiFailureShort)
      ? rsiCfg.rsiFailureShort
      : (options?.rsiFailureShort ?? 100),
  };
}

function runRsiFailureGridSweepMultiMarket({
  options,
  candlesMap,
  strategyConfigsMap,
  perMarketLeverage,
  perMarketHardStop,
  perMarketHardStopAtr,
  oneMinCandlesMap,
  ticksByBarOpenTimeMap,
  startTime,
  endTime,
}) {
  if (!candlesMap || !strategyConfigsMap || strategyConfigsMap.size === 0) {
    throw new Error("Missing candles/config maps for failure grid sweep");
  }
  if (!options || !Array.isArray(options.symbols) || options.symbols.length < 2) {
    throw new Error("Failure grid sweep requires multi-market mode (2+ markets)");
  }

  const defaultLongValues = [0, 15, 18, 20, 22, 25];
  const defaultShortValues = [75, 78, 80, 82, 85, 100];
  const longValues = parseNumberList(process.env.RSI_FAILURE_GRID_LONG_VALUES);
  const shortValues = parseNumberList(process.env.RSI_FAILURE_GRID_SHORT_VALUES);
  const gridLong = longValues.length > 0 ? longValues : defaultLongValues;
  const gridShort = shortValues.length > 0 ? shortValues : defaultShortValues;

  const marketsOverride = (process.env.RSI_FAILURE_GRID_MARKETS || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const markets =
    marketsOverride.length > 0
      ? options.symbols.filter((s) => marketsOverride.includes(String(s).toUpperCase()))
      : options.symbols;

  const maxRunsPerMarket = parseInt(process.env.RSI_FAILURE_GRID_MAX_RUNS_PER_MARKET || "0", 10);

  console.log("\n🧪 RSI FAILURE GRID SWEEP (multi-market; per-market overrides)");
  console.log("-".repeat(60));
  console.log(`  Markets:             ${markets.join(", ")}`);
  console.log(`  Long values:         ${gridLong.join(", ")}`);
  console.log(`  Short values:        ${gridShort.join(", ")}`);
  if (maxRunsPerMarket > 0) console.log(`  Max runs/market:     ${maxRunsPerMarket}`);
  console.log(
    `  Time range:          ${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()}`
  );

  const out = {
    meta: {
      kind: "rsi_failure_grid_sweep",
      symbols: options.symbols,
      marketsSwept: markets,
      days: options.days,
      startTime,
      endTime,
      longValues: gridLong,
      shortValues: gridShort,
      traceModel: String(options._traceModel || options.traceModel || "backtest"),
      timestamp: Date.now(),
    },
    perMarket: [],
  };

  // Baseline portfolio run (no overrides) using the SAME simulation settings as main()
  const runBaselineSim = () => {
    const interval = options.interval || "5m";
    const use1MinTicks = options.use1MinTicks !== false;
    const tickSimEnabled = interval === "5m" && use1MinTicks;
    const isBotModel =
      String(options._traceModel || options.traceModel || "backtest").toLowerCase() === "bot";
    const simFn = isBotModel ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;

    // Build strategies from baseline configs
    const strategiesMap = new Map();
    for (const [sym, cfg] of strategyConfigsMap.entries()) {
      strategiesMap.set(sym, new RsiMeanReversionStrategy(cfg));
    }

    const simResult = simFn(strategiesMap, candlesMap, {
      initialCapital: options.initialCapital,
      leverage: options.leverage,
      positionSizePercent: options.positionSizePercent,
      enableCompounding: options.enableCompounding,
      debug: false,
      allowLongs: options.allowLongs,
      allowShorts: options.allowShorts,
      maxPositions: options.maxPositions,
      oneMinCandlesMap,
      ticksByBarOpenTimeMap,
      ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : options.ticksPerCandle || 1,
      simulateTicks: tickSimEnabled,
      rsiHardStopPercent: options.rsiHardStopPercent,
      rsiHardStopAtr: options.rsiHardStopAtr,
      perMarketLeverage,
      perMarketHardStop,
      perMarketHardStopAtr,
      minPositionSize: options.minPositionSize,
      maxPositionSize: options.maxPositionSize,
      allocatorExploreProbability: options.allocatorExploreProbability,
      allocatorUseBotScoring: options.allocatorUseBotScoring,
      allocatorRiskEnabled: options.allocatorRiskEnabled,
      allocatorRiskNeutral: options.allocatorRiskNeutral,
      _trace: null,
      _traceModel: isBotModel ? "bot" : options._traceModel || "backtest",
    });

    const perMarketPnL = new Map();
    if (simResult.marketResults) {
      for (const [sym, mktResult] of simResult.marketResults.entries()) {
        perMarketPnL.set(sym, mktResult.netPnL ?? mktResult.realisedPnl ?? mktResult.totalPnL ?? 0);
      }
    }

    const allTrades = normalizeTradesForDailyReturns(
      Array.from(simResult.marketResults?.values?.() || []).flatMap((m) => m.trades || [])
    );
    const portfolioPnL = simResult.realisedPnl ?? simResult.totalPnL ?? 0;
    const dailyReturns = tradesToDailyReturns(allTrades, options.initialCapital);
    const sharpe = calculateSharpeRatio(dailyReturns);

    return {
      portfolioPnL,
      perMarketPnL,
      sharpe: sharpe?.sharpe ?? sharpe ?? 0,
      tradesCount: allTrades.length,
    };
  };

  const runOverrideSimForSymbol = (targetSymbol, overrides) => {
    const interval = options.interval || "5m";
    const use1MinTicks = options.use1MinTicks !== false;
    const tickSimEnabled = interval === "5m" && use1MinTicks;
    const isBotModel =
      String(options._traceModel || options.traceModel || "backtest").toLowerCase() === "bot";
    const simFn = isBotModel ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;

    // Apply overrides to target symbol only
    const strategiesMap = new Map();
    for (const [sym, baseCfg] of strategyConfigsMap.entries()) {
      const cfg =
        sym === targetSymbol && overrides && Object.keys(overrides).length > 0
          ? withRsiOverridesOnStrategyConfig(baseCfg, overrides)
          : baseCfg;
      strategiesMap.set(sym, new RsiMeanReversionStrategy(cfg));
    }

    const simResult = simFn(strategiesMap, candlesMap, {
      initialCapital: options.initialCapital,
      leverage: options.leverage,
      positionSizePercent: options.positionSizePercent,
      enableCompounding: options.enableCompounding,
      debug: false,
      allowLongs: options.allowLongs,
      allowShorts: options.allowShorts,
      maxPositions: options.maxPositions,
      oneMinCandlesMap,
      ticksByBarOpenTimeMap,
      ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : options.ticksPerCandle || 1,
      simulateTicks: tickSimEnabled,
      rsiHardStopPercent: options.rsiHardStopPercent,
      rsiHardStopAtr: options.rsiHardStopAtr,
      perMarketLeverage,
      perMarketHardStop,
      perMarketHardStopAtr,
      minPositionSize: options.minPositionSize,
      maxPositionSize: options.maxPositionSize,
      allocatorExploreProbability: options.allocatorExploreProbability,
      allocatorUseBotScoring: options.allocatorUseBotScoring,
      allocatorRiskEnabled: options.allocatorRiskEnabled,
      allocatorRiskNeutral: options.allocatorRiskNeutral,
      _trace: null,
      _traceModel: isBotModel ? "bot" : options._traceModel || "backtest",
    });

    const perMarketPnL = new Map();
    if (simResult.marketResults) {
      for (const [sym, mktResult] of simResult.marketResults.entries()) {
        perMarketPnL.set(sym, mktResult.netPnL ?? mktResult.realisedPnl ?? mktResult.totalPnL ?? 0);
      }
    }

    const allTrades = normalizeTradesForDailyReturns(
      Array.from(simResult.marketResults?.values?.() || []).flatMap((m) => m.trades || [])
    );
    const portfolioPnL = simResult.realisedPnl ?? simResult.totalPnL ?? 0;
    const dailyReturns = tradesToDailyReturns(allTrades, options.initialCapital);
    const sharpe = calculateSharpeRatio(dailyReturns);

    return {
      portfolioPnL,
      perMarketPnL,
      sharpe: sharpe?.sharpe ?? sharpe ?? 0,
      tradesCount: allTrades.length,
    };
  };

  const baselineSim = runBaselineSim();

  for (const symbol of markets) {
    const baseline = getMarketFailureBaseline(strategyConfigsMap, symbol, options);
    console.log(
      `\n  📌 ${symbol} baseline failure: long=${baseline.long}, short=${baseline.short}`
    );

    const baselinePortfolioPnL = baselineSim.portfolioPnL;
    const baselineMarketPnL = baselineSim.perMarketPnL.get(symbol) ?? Number.NaN;

    const rows = [];
    let best = null;
    let runs = 0;

    for (const fLong of gridLong) {
      for (const fShort of gridShort) {
        if (maxRunsPerMarket > 0 && runs >= maxRunsPerMarket) break;
        runs++;
        try {
          const sim = runOverrideSimForSymbol(symbol, {
            rsiFailureLong: fLong,
            rsiFailureShort: fShort,
          });
          const row = {
            rsiFailureLong: fLong,
            rsiFailureShort: fShort,
            portfolioPnl: sim.portfolioPnL,
            marketPnl: sim.perMarketPnL.get(symbol) ?? 0,
            sharpe: sim.sharpe,
            trades: sim.tradesCount ?? 0,
            deltaPortfolioPnL: Number.isFinite(baselinePortfolioPnL)
              ? sim.portfolioPnL - baselinePortfolioPnL
              : null,
            deltaMarketPnL: Number.isFinite(baselineMarketPnL)
              ? (sim.perMarketPnL.get(symbol) ?? 0) - baselineMarketPnL
              : null,
            isBaseline: fLong === baseline.long && fShort === baseline.short,
          };
          rows.push(row);
          if (
            !best ||
            (Number.isFinite(row.portfolioPnl) &&
              row.portfolioPnl > (best.portfolioPnl ?? -Infinity))
          ) {
            best = row;
          }
        } catch (err) {
          rows.push({ rsiFailureLong: fLong, rsiFailureShort: fShort, error: err.message });
        }
      }
      if (maxRunsPerMarket > 0 && runs >= maxRunsPerMarket) break;
    }

    const top10 = rows
      .filter((r) => Number.isFinite(r.portfolioPnl))
      .sort((a, b) => b.portfolioPnl - a.portfolioPnl)
      .slice(0, 10);

    if (best && Number.isFinite(best.portfolioPnl)) {
      const delta = Number.isFinite(baselinePortfolioPnL)
        ? best.portfolioPnl - baselinePortfolioPnL
        : NaN;
      console.log(
        `  ✅ Best for ${symbol}: failure=${best.rsiFailureLong}/${best.rsiFailureShort} | portfolioPnL=$${best.portfolioPnl.toFixed(2)} (Δ $${Number.isFinite(delta) ? delta.toFixed(2) : "NaN"}) | sharpe=${Number(best.sharpe || 0).toFixed(2)}`
      );
    } else {
      console.log(`  ⚠️  No valid results for ${symbol}`);
    }

    out.perMarket.push({
      symbol,
      baseline: {
        rsiFailureLong: baseline.long,
        rsiFailureShort: baseline.short,
        portfolioPnl: baselinePortfolioPnL,
        marketPnl: baselineMarketPnL,
        sharpe: baselineSim.sharpe,
        trades: baselineSim.tradesCount,
      },
      best,
      top10,
      grid: rows,
    });
  }

  return out;
}

function alignToCandleOpenMs(t, intervalMs) {
  return Math.floor(t / intervalMs) * intervalMs;
}

function alignToCandleCloseMs(t, intervalMs) {
  const open = alignToCandleOpenMs(t, intervalMs);
  return open + intervalMs - 1;
}

// Default markets for RSI mean-reversion (fallback only).
// Note: We intentionally do NOT hard-filter markets anymore — alts are supported
// via STRATEGY_MARKETS / --symbol and per-market overrides.
const DEFAULT_MARKETS = ["BTC", "ETH", "SOL"];

// Get default markets from env or fallback to supported
function getDefaultMarkets() {
  const envMarkets = process.env.STRATEGY_MARKETS;
  if (envMarkets) {
    const markets = envMarkets
      .toUpperCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (markets.length > 0) return markets;
  }
  return [...DEFAULT_MARKETS];
}

function parseArgs(args = process.argv.slice(2)) {
  // Read ALL config from env vars (from .env.rsi-reversion)
  const options = {
    // General
    days: 30,
    symbols: getDefaultMarkets(), // Read from STRATEGY_MARKETS env var
    symbol: null, // Single symbol mode (overrides symbols array)
    startTime: null, // Optional override (ms epoch or ISO string via CLI)
    endTime: null, // Optional override (ms epoch or ISO string via CLI)
    aggregation: "aligned", // 'aligned' (timestamp-aligned 5m) | 'legacy' (chunk-by-5)
    // Output controls (to keep workflow/sweep runs fast)
    outputMode: String(process.env.BACKTEST_OUTPUT_MODE || "")
      .trim()
      .toLowerCase(),
    minimalOutput:
      ["workflow", "minimal", "quiet"].includes(
        String(process.env.BACKTEST_OUTPUT_MODE || "")
          .trim()
          .toLowerCase()
      ) ||
      ["1", "true", "yes", "on"].includes(
        String(process.env.BACKTEST_MINIMAL_OUTPUT || "")
          .trim()
          .toLowerCase()
      ),

    // Position sizing - read from env
    // Methods: 'percent' | 'equal-risk' | 'kelly' | 'volatility-scaled' | 'quality-weighted'
    positionSizingMethod: process.env.POSITION_SIZING_METHOD || "percent",
    positionSizePercent: envNum("POSITION_SIZE_PERCENT", 75),
    positionSize: envNum("MIN_POSITION_SIZE", 100), // Minimum position size
    minPositionSize: envNum("MIN_POSITION_SIZE", 100), // For compounding
    maxPositionSize: envNum("MAX_POSITION_SIZE", 5000),
    initialCapital: envNum("INITIAL_CAPITAL", 1000), // For percent-based sizing
    enableCompounding: envBool("ENABLE_COMPOUNDING", true), // Compound gains/losses

    // Equal-risk sizing: risk a fixed % of capital per trade based on stop distance
    riskPerTradePercent: envNum("RISK_PER_TRADE_PERCENT", 2), // 2% risk per trade

    // Kelly criterion: optimal f based on win rate and reward/risk
    kellyFraction: envNum("KELLY_FRACTION", 0.25), // Use quarter-Kelly for safety

    // Volatility-scaled: size inversely proportional to ATR (larger in calm markets)
    volatilityScaleBase: envNum("VOLATILITY_SCALE_BASE", 0.02), // Target 2% ATR as base

    // Quality-weighted: scale by signal confidence
    qualitySizeMultMin: envNum("ALLOCATOR_RISK_SIZE_MULT_MIN", 0.5),
    qualitySizeMultMax: envNum("ALLOCATOR_RISK_SIZE_MULT_MAX", 1.5),

    // Leverage - read from env
    leverage: envNum("LEVERAGE_BASE", 3),

    // Debug
    debug: envBool("DEBUG_RSI_STRATEGY", false),
    verbose: false,

    // RSI config - ALL from env
    rsiPeriod: envInt("RSI_PERIOD", 14),
    rsiUseSma: process.env.RSI_USE_SMA !== "false", // true = SMA (less accurate), false = Wilder's (TradingView standard)
    rsiOversoldExtreme: envNum("RSI_OVERSOLD_EXTREME", 20),
    rsiOversoldRecovery: envNum("RSI_OVERSOLD_RECOVERY", 25),
    rsiOverboughtExtreme: envNum("RSI_OVERBOUGHT_EXTREME", 80),
    rsiOverboughtRecovery: envNum("RSI_OVERBOUGHT_RECOVERY", 75),
    rsiEntryMaxDeviation: envNum("RSI_ENTRY_MAX_DEVIATION", 10),
    rsiEntryMaxBars: envInt("RSI_ENTRY_MAX_BARS", 5), // Max bars after extreme to enter
    rsiTargetNeutral: envNum("RSI_TARGET_NEUTRAL", 50),
    rsiTargetLong: envNum("RSI_TARGET_LONG", 0), // 0 = use rsiTargetNeutral
    rsiTargetShort: envNum("RSI_TARGET_SHORT", 0), // 0 = use rsiTargetNeutral
    rsiPartialTargetLong: envNum("RSI_PARTIAL_TARGET_LONG", 35),
    rsiPartialTargetShort: envNum("RSI_PARTIAL_TARGET_SHORT", 65),
    rsiPartialPercent: envNum("RSI_PARTIAL_PERCENT", 50),
    rsiFailureLong: envNum("RSI_FAILURE_LONG", 22),
    rsiFailureShort: envNum("RSI_FAILURE_SHORT", 78),
    rsiTimeStopBars: envInt("RSI_TIME_STOP_BARS", 20),

    // Hard stop config - from env
    rsiHardStopEnabled: process.env.RSI_HARD_STOP_ENABLED !== "false",
    rsiHardStopAtr: envNum("RSI_HARD_STOP_ATR", 2.0),
    rsiHardStopPercent: envNum("RSI_HARD_STOP_PERCENT", 0),
    atrPeriod: envInt("ATR_PERIOD", 14),

    // Filters - read from env
    allowLongs: envBool("ALLOW_LONGS", true),
    allowShorts: envBool("ALLOW_SHORTS", true),
    maxPositions: envInt("MAX_POSITIONS", 1),

    // Early exit parameters
    maxDrawdownPct: envNum("MAX_DRAWDOWN_PCT", 2.0), // Exit if loss exceeds this %
    trailingAfterPartialPct: envNum("TRAILING_AFTER_PARTIAL_PCT", 0.5), // Trailing stop after partial
    enableEarlyExits: envBool("ENABLE_EARLY_EXITS", true), // Master switch for early exits

    // Extended exit logic - wait for RSI reversal instead of immediate exit at target
    extendedExit: envBool("EXTENDED_EXIT", false), // If true, wait for RSI to reverse back to target
    extendedExitReversal: envNum("EXTENDED_EXIT_REVERSAL", 5), // RSI must reverse by this many points before exit

    // Circuit breaker - pause trading after consecutive losses
    circuitBreakerMaxLosses: envInt("RSI_MAX_CONSECUTIVE_LOSSES", 3), // Pause after N consecutive losses
    circuitBreakerCooldownMs: envInt("RSI_CIRCUIT_BREAKER_COOLDOWN_MS", 180000), // Cooldown duration (ms)
    circuitBreakerEnabled: envBool("RSI_CIRCUIT_BREAKER_ENABLED", true), // Master switch

    // Candle interval - from env
    interval: process.env.TRADING_INTERVAL || "5m",

    // Parity / audit tooling
    printEventModel: false,
    trace: envBool("BACKTEST_TRACE", false),
    traceModel: process.env.BACKTEST_TRACE_MODEL || "backtest", // 'backtest' | 'bot'
    traceMaxEvents: envInt("BACKTEST_TRACE_MAX_EVENTS", 0), // 0 = unlimited
    // When enabled, run BOTH trace models and emit a diff summary.
    traceCompare: envBool("BACKTEST_TRACE_COMPARE", false),
    // Guardrails: fail fast on illegal sequencing / look-ahead
    parityChecks: envBool("BACKTEST_PARITY_CHECKS", false),
    // Make allocator deterministic in backtests by default (bot may explore randomly)
    allocatorExploreProbability: envNum("BACKTEST_ALLOCATOR_EXPLORE_PROB", 0),
    allocatorUseBotScoring: envBool("BACKTEST_ALLOCATOR_USE_BOT_SCORING", true),
    // Allocator-driven dynamic risk (size/leverage/stops based on signal quality)
    // When enabled, calls allocator.recommendRisk() to adjust base values
    allocatorRiskEnabled: envBool(
      "BACKTEST_ALLOCATOR_RISK_ENABLED",
      envBool("ALLOCATOR_RISK_ENABLED", false)
    ),
    allocatorRiskNeutral: envBool(
      "BACKTEST_ALLOCATOR_RISK_NEUTRAL",
      envBool("ALLOCATOR_RISK_NEUTRAL", false)
    ),

    // Analysis helpers
    rsiFailureGridSweep: envBool("RSI_FAILURE_GRID_SWEEP", false),

    // Memory optimization flags
    useTypedArrays: envBool("BACKTEST_USE_TYPED_ARRAYS", true), // Use Float64Array for candle storage
    release1mAfterTicks: envBool("BACKTEST_RELEASE_1M", true), // Free 1m candles after tick cache
    batchMarketLoading: envBool("BACKTEST_BATCH_LOADING", true), // Load markets in batches for GC
    batchSize: envInt("BACKTEST_BATCH_SIZE", 4), // Markets per batch
    gcBetweenBatches: envBool("BACKTEST_GC_BETWEEN_BATCHES", true), // Force GC between batches
  };

  // Calculate position size based on method
  if (options.positionSizingMethod === "percent") {
    const calculatedSize = (options.positionSizePercent / 100) * options.initialCapital;
    options.positionSize = Math.min(
      Math.max(calculatedSize, options.positionSize),
      options.maxPositionSize
    );
    console.log(
      `[CONFIG] Position sizing: ${options.positionSizePercent}% of $${options.initialCapital} = $${options.positionSize.toFixed(0)}`
    );
  }

  // CLI arguments override env values
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      if (key === "debug") options.debug = true;
      else if (key === "verbose") options.verbose = true;
      else if (key === "output") {
        options.outputMode = String(value || "")
          .trim()
          .toLowerCase();
        options.minimalOutput = ["workflow", "minimal", "quiet"].includes(options.outputMode);
      } else if (key === "printEventModel") options.printEventModel = true;
      else if (key === "trace") options.trace = true;
      else if (key === "traceModel") options.traceModel = String(value || "").toLowerCase();
      else if (key === "traceMaxEvents") options.traceMaxEvents = parseInt(value);
      else if (key === "traceCompare") options.traceCompare = true;
      else if (key === "parityChecks") options.parityChecks = true;
      else if (key === "days") options.days = parseInt(value);
      else if (key === "startTime" || key === "start") options.startTime = parseTimeArg(value);
      else if (key === "endTime" || key === "end") options.endTime = parseTimeArg(value);
      else if (key === "aggregation" || key === "agg")
        options.aggregation = String(value || "").toLowerCase();
      else if (key === "symbol") {
        options.symbol = value.toUpperCase();
        options.symbols = [value.toUpperCase()]; // Single symbol mode
      } else if (key === "symbols") {
        options.symbols = value
          .toUpperCase()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (options.symbols.length === 0) options.symbols = [...DEFAULT_MARKETS];
      }
      // ------------------------------------------------------------
      // Fee / execution overrides (dotenv is loaded with override:true)
      // ------------------------------------------------------------
      else if (key === "execMode") {
        const v = String(value || "").toLowerCase();
        if (v === "maker" || v === "taker") {
          options.execMode = v;
          process.env.EXEC_MODE = v;
        }
      } else if (key === "makerFillSim" || key === "makerSim") {
        const v = String(value || "").toLowerCase();
        const enabled = ["1", "true", "yes", "on"].includes(v)
          ? "true"
          : ["0", "false", "no", "off"].includes(v)
            ? "false"
            : null;
        if (enabled !== null) {
          options.enableMakerFillSim = enabled === "true";
          process.env.ENABLE_MAKER_FILL_SIM = enabled;
        }
      } else if (key === "fixedSlippageBps") {
        const bps = Number(value);
        if (Number.isFinite(bps) && bps >= 0) {
          process.env.ENABLE_FIXED_SLIPPAGE = bps > 0 ? "true" : "false";
          process.env.FIXED_SLIPPAGE_BPS = String(bps);
        }
      } else if (key === "positionSize") {
        options.positionSize = parseFloat(value);
        options.positionSizingMethod = "fixed";
      } else if (key === "initialCapital") options.initialCapital = parseFloat(value);
      else if (key === "leverage") options.leverage = parseFloat(value);
      // Per-market leverage CLI overrides (bypass dotenv override issue)
      // Usage: --btcLev=5 or --ethLev=7 or --solLev=3 or --marketLev=BTC:5,ETH:7
      else if (key === "btcLev") {
        options.cliMarketLeverage = options.cliMarketLeverage || new Map();
        options.cliMarketLeverage.set("BTC", parseFloat(value));
      } else if (key === "ethLev") {
        options.cliMarketLeverage = options.cliMarketLeverage || new Map();
        options.cliMarketLeverage.set("ETH", parseFloat(value));
      } else if (key === "solLev") {
        options.cliMarketLeverage = options.cliMarketLeverage || new Map();
        options.cliMarketLeverage.set("SOL", parseFloat(value));
      } else if (key === "marketLev") {
        options.cliMarketLeverage = options.cliMarketLeverage || new Map();
        for (const pair of value.split(",")) {
          const [sym, lev] = pair.split(":");
          if (sym && lev) options.cliMarketLeverage.set(sym.toUpperCase(), parseFloat(lev));
        }
      } else if (key === "rsiPeriod") options.rsiPeriod = parseInt(value);
      else if (key === "rsiUseSma") options.rsiUseSma = value !== "false";
      else if (key === "wilder")
        options.rsiUseSma = false; // Shorthand: --wilder to use Wilder's RSI
      else if (key === "sma")
        options.rsiUseSma = true; // Shorthand: --sma to use SMA-based RSI
      else if (key === "oversoldExtreme") options.rsiOversoldExtreme = parseFloat(value);
      else if (key === "oversoldRecovery") options.rsiOversoldRecovery = parseFloat(value);
      else if (key === "overboughtExtreme") options.rsiOverboughtExtreme = parseFloat(value);
      else if (key === "overboughtRecovery") options.rsiOverboughtRecovery = parseFloat(value);
      else if (key === "targetNeutral") options.rsiTargetNeutral = parseFloat(value);
      else if (key === "partialLong") options.rsiPartialTargetLong = parseFloat(value);
      else if (key === "partialShort") options.rsiPartialTargetShort = parseFloat(value);
      else if (key === "partialPercent") options.rsiPartialPercent = parseFloat(value);
      else if (key === "failureLong") options.rsiFailureLong = parseFloat(value);
      else if (key === "failureShort") options.rsiFailureShort = parseFloat(value);
      else if (key === "timeStopBars") options.rsiTimeStopBars = parseInt(value);
      else if (key === "hardStopAtr") options.rsiHardStopAtr = parseFloat(value);
      else if (key === "hardStopPercent") options.rsiHardStopPercent = parseFloat(value);
      else if (key === "noFailureExit") {
        options.rsiFailureLong = 0;
        options.rsiFailureShort = 100;
      } else if (key === "noHardStop") options.rsiHardStopEnabled = false;
      else if (key === "longsOnly") options.allowShorts = false;
      else if (key === "shortsOnly") options.allowLongs = false;
      else if (key === "maxPositions") options.maxPositions = parseInt(value);
      else if (key === "interval") options.interval = value;
      // Early exit parameters
      else if (key === "maxDrawdown") options.maxDrawdownPct = parseFloat(value);
      else if (key === "trailingAfterPartial") options.trailingAfterPartialPct = parseFloat(value);
      else if (key === "noEarlyExits") options.enableEarlyExits = false;
      // Extended exit parameters
      else if (key === "extendedExit") options.extendedExit = true;
      else if (key === "extendedExitReversal") options.extendedExitReversal = parseFloat(value);
      // Position sizing parameters
      else if (key === "positionSizePercent") options.positionSizePercent = parseFloat(value);
      else if (key === "compounding" || key === "enableCompounding")
        options.enableCompounding = value !== "false";
      else if (key === "noCompounding") options.enableCompounding = false;
      // Circuit breaker CLI overrides (bypass dotenv override issue)
      else if (key === "cbMaxLosses" || key === "maxConsecutiveLosses")
        options.circuitBreakerMaxLosses = parseInt(value);
      else if (key === "cbCooldown" || key === "cbCooldownMs")
        options.circuitBreakerCooldownMs = parseInt(value);
      else if (key === "cbEnabled" || key === "circuitBreaker")
        options.circuitBreakerEnabled = value !== "false" && value !== "0";
      else if (key === "noCb" || key === "noCircuitBreaker") options.circuitBreakerEnabled = false;
      // Analysis helpers
      else if (key === "rsiFailureGridSweep" || key === "failureGridSweep")
        options.rsiFailureGridSweep = true;
      // Memory optimization flags
      else if (key === "useTypedArrays")
        options.useTypedArrays = value !== "false" && value !== "0";
      else if (key === "noTypedArrays") options.useTypedArrays = false;
      else if (key === "release1m" || key === "release1mAfterTicks")
        options.release1mAfterTicks = value !== "false" && value !== "0";
      else if (key === "noRelease1m") options.release1mAfterTicks = false;
      else if (key === "batchLoading" || key === "batchMarketLoading")
        options.batchMarketLoading = value !== "false" && value !== "0";
      else if (key === "noBatchLoading") options.batchMarketLoading = false;
      else if (key === "batchSize") options.batchSize = parseInt(value);
      else if (key === "gcBetweenBatches")
        options.gcBetweenBatches = value !== "false" && value !== "0";
      else if (key === "noGcBatches") options.gcBetweenBatches = false;
    }
  }

  // If we're tracing, enable guardrails by default (can be disabled via env if needed)
  if (options.trace || options.traceCompare) {
    options.parityChecks = true;
  }

  return options;
}

function getMarketOverride(marketOverrides, symbol) {
  if (!marketOverrides) return null;
  const key = String(symbol || "").toUpperCase();
  if (!key) return null;
  if (marketOverrides instanceof Map) return marketOverrides.get(key) || null;
  if (typeof marketOverrides === "object")
    return marketOverrides[key] || marketOverrides[key.toLowerCase()] || null;
  return null;
}

async function prefetchSingleMarketData({ symbol, options, startTime, endTime }) {
  const interval = options?.interval || "5m";
  const use1MinTicks = options?.use1MinTicks !== false;
  const preferredSource = process.env.BACKTEST_USE_PYTH === "false" ? "binance" : "pyth";

  let candles;
  let oneMinCandles = null;
  let ticksByBarOpenTime = null;

  if (use1MinTicks && interval === "5m") {
    try {
      oneMinCandles = await fetchCandles(symbol, "1m", startTime, endTime, preferredSource);
    } catch (_) {
      oneMinCandles = null;
    }
    if ((!oneMinCandles || oneMinCandles.length === 0) && preferredSource === "pyth") {
      oneMinCandles = await fetchCandles(symbol, "1m", startTime, endTime, "binance");
    }
    if (!oneMinCandles || oneMinCandles.length === 0) {
      throw new Error(`No 1m candles available for ${symbol}`);
    }

    const expectedOneMinCandles = Math.max(1, Math.floor((endTime - startTime) / 60_000));
    const oneMinCoverageRatio = oneMinCandles.length / expectedOneMinCandles;
    if (oneMinCoverageRatio < 0.95) {
      throw new Error(
        `Insufficient 1m candle coverage for ${symbol}: ${(oneMinCoverageRatio * 100).toFixed(1)}%`
      );
    }

    ticksByBarOpenTime = await getOrBuildTicksByBarOpenTime({
      source: preferredSource === "pyth" ? "pyth" : "binance",
      symbol,
      startTime,
      endTime,
      oneMinCandles,
    });

    if ((options?.aggregation || "aligned") === "legacy") {
      candles = [];
      for (let i = 0; i < oneMinCandles.length; i += 5) {
        const group = oneMinCandles.slice(i, i + 5);
        if (group.length === 5) candles.push(aggregate1MinTo5Min(group));
      }
    } else {
      candles = aggregate1MinTo5MinAligned(oneMinCandles);
    }
  } else {
    try {
      candles = await fetchCandles(symbol, interval, startTime, endTime, preferredSource);
    } catch (_) {
      candles = null;
    }
    if ((!candles || candles.length === 0) && preferredSource === "pyth") {
      candles = await fetchCandles(symbol, interval, startTime, endTime, "binance");
    }
  }

  if (!candles || candles.length === 0) {
    throw new Error(`No ${interval} candles available for ${symbol}`);
  }

  return {
    symbol: String(symbol || "").toUpperCase(),
    interval,
    startTime,
    endTime,
    candles,
    oneMinCandles,
    ticksByBarOpenTime,
  };
}

function summarizeRsiBacktestForWorkflow({ trades, equitySeries, days, initialCapital }) {
  const t = Array.isArray(trades) ? trades : [];
  const totalTrades = t.length;
  const totalPnL = t.reduce((s, x) => s + getTradePnlUsd(x), 0);
  const wins = t.filter((x) => getTradePnlUsd(x) > 0).length;
  const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const returnPct = initialCapital > 0 ? (totalPnL / initialCapital) * 100 : 0;

  const maxDD = calculateMaxDrawdown(equitySeries || []);
  const dailyReturns = tradesToDailyReturns(t, initialCapital);
  const sharpe = dailyReturns.length > 0 ? calculateSharpeRatio(dailyReturns) : 0;
  const sortino = dailyReturns.length > 0 ? calculateSortinoRatio(dailyReturns) : 0;
  const profitFactor = computeProfitFactor(t);
  const expectedValue = totalTrades > 0 ? totalPnL / totalTrades : 0;

  const { sqn, expectancy } = calculateSQN(t);
  const expectancyPct = initialCapital > 0 ? expectancy / initialCapital : 0;
  const recoveryFactor = maxDD > 0 ? returnPct / maxDD : 0;
  const { payoffRatio } = computePayoffRatio(t);
  const winProb = totalTrades > 0 ? wins / totalTrades : 0;
  const kelly = payoffRatio > 0 ? (winProb * payoffRatio - (1 - winProb)) / payoffRatio : 0;
  const kellyPct = clamp(kelly, 0, 1) * 100;
  const { maxWinStreak, maxLoseStreak } = computeStreaks(t);
  const tail = computeTailMetrics(t, initialCapital);

  const robust = computeRobustScoreV2(
    {
      sqn,
      sharpe,
      recoveryFactor,
      maxDD,
      profitFactor,
      trades: totalTrades,
      days,
      winRate: winProb,
      payoffRatio,
      pnlSkewness: tail.pnlSkewness,
      lossTailToAvgWin: tail.lossTailToAvgWin,
      worstTrade: tail.worstTrade,
      pnlConcentrationTop5: tail.pnlConcentrationTop5,
    },
    { days }
  );

  const byExit = new Map();
  for (const tr of t) {
    const k = String(tr?.exitReason || "unknown");
    const p = getTradePnlUsd(tr);
    const prev = byExit.get(k) || { count: 0, pnl: 0 };
    prev.count += 1;
    prev.pnl += p;
    byExit.set(k, prev);
  }

  const exitBreakdown = {};
  for (const [reason, v] of byExit.entries()) exitBreakdown[reason] = v;

  const sumExitByPrefix = (prefix) => {
    let count = 0;
    let pnl = 0;
    for (const [reason, v] of byExit.entries()) {
      if (!String(reason).startsWith(prefix)) continue;
      count += Number(v?.count || 0);
      pnl += Number(v?.pnl || 0);
    }
    return count > 0 ? { count, pnl } : null;
  };

  const sumExitByExact = (reason) => {
    const v = byExit.get(reason);
    return v && v.count > 0 ? { count: v.count, pnl: v.pnl } : null;
  };

  return {
    returnPct,
    pnlUsd: totalPnL,
    trades: totalTrades,
    winRate: winRatePct,
    profitFactor,
    expectedValue,
    maxDD,
    sharpe,
    // Robust metrics
    sqn,
    sqnRating: sqnRating(sqn),
    sortino,
    recoveryFactor,
    expectancy,
    expectancyPct,
    payoffRatio,
    kellyPct,
    robustScore: robust.score,
    disqualified: robust.disqualified,
    disqualifyReason: robust.disqualifyReason,
    // Tail risk metrics (used by sweeps/workflows)
    pnlSkewness: tail.pnlSkewness,
    pnlExcessKurtosis: tail.pnlExcessKurtosis,
    cvar95: tail.cvar95,
    worstTrade: tail.worstTrade,
    avgWin: tail.avgWin,
    avgLoss: tail.avgLoss,
    lossTailToAvgWin: tail.lossTailToAvgWin,
    pnlConcentrationTop5: tail.pnlConcentrationTop5,
    exits: {
      target: sumExitByExact("rsi_target_reached"),
      failure: sumExitByExact("rsi_failure_exit"),
      hardStop: sumExitByPrefix("rsi_hard_stop"),
      timeStop: sumExitByExact("rsi_time_stop"),
      trailingStop: sumExitByExact("rsi_trailing_stop"),
      byReason: exitBreakdown,
    },
    streaks: { maxWinStreak, maxLoseStreak },
  };
}

// ============================================================
// RUN BACKTEST FOR A SINGLE SYMBOL
// ============================================================
async function runBacktestForSymbol(symbol, options, startTime, endTime) {
  const interval = options.interval || "5m";
  const use1MinTicks = options.use1MinTicks !== false; // Default: use 1-min candles for accurate ticks

  // Enable tick simulation for 5m candles with 15s intervals (matches bot behavior)
  const tickSimEnabled = interval === "5m" || interval === "1m";
  const preferredSource = process.env.BACKTEST_USE_PYTH === "false" ? "binance" : "pyth";

  let candles;
  let oneMinCandles = null;

  // Tick cache (built from 1m candles). Used by all simulation models (single+multi).
  let ticksByBarOpenTime = null;

  const prefetched = (() => {
    const p = options?.prefetchedData;
    if (!p) return null;
    const k = String(symbol || "").toUpperCase();
    if (!k) return null;
    if (p instanceof Map) return p.get(k) || null;
    if (typeof p === "object") return p[k] || p[k.toLowerCase()] || null;
    return null;
  })();

  if (prefetched?.candles && Array.isArray(prefetched.candles) && prefetched.candles.length > 0) {
    candles = prefetched.candles;
    oneMinCandles = prefetched.oneMinCandles || null;
    ticksByBarOpenTime = prefetched.ticksByBarOpenTime || null;
  } else if (use1MinTicks && interval === "5m") {
    // Fetch 1-minute candles for accurate tick simulation
    console.log(`\n📥 Fetching ${symbol} 1m candles (for accurate tick simulation)...`);
    try {
      oneMinCandles = await fetchCandles(symbol, "1m", startTime, endTime, preferredSource);
    } catch (e) {
      oneMinCandles = null;
    }
    // Run-level failover for single-market: if Pyth fails, redo using Binance only.
    if ((!oneMinCandles || oneMinCandles.length === 0) && preferredSource === "pyth") {
      console.warn(
        `   ⚠️  Pyth 1m fetch failed for ${symbol}. Falling back to Binance for this run.`
      );
      oneMinCandles = await fetchCandles(symbol, "1m", startTime, endTime, "binance");
    }

    if (oneMinCandles && oneMinCandles.length > 0) {
      console.log(`   ${oneMinCandles.length} 1-minute candles loaded`);

      // CRITICAL: Validate 1-minute data coverage
      const oneMinIntervalMs = 60000;
      const expectedOneMinCandles = Math.max(
        1,
        Math.floor((endTime - startTime) / oneMinIntervalMs)
      );
      const oneMinCoverageRatio = oneMinCandles.length / expectedOneMinCandles;

      if (oneMinCoverageRatio < 0.95) {
        const first = oneMinCandles[0];
        const last = oneMinCandles[oneMinCandles.length - 1];
        console.error(
          `❌ INSUFFICIENT 1m DATA for ${symbol}\n` +
            `   Expected: ${expectedOneMinCandles} candles\n` +
            `   Received: ${oneMinCandles.length} candles (${(oneMinCoverageRatio * 100).toFixed(1)}% coverage)\n` +
            `   Range: ${first ? new Date(first.openTime).toISOString() : "N/A"} to ${last ? new Date(last.closeTime).toISOString() : "N/A"}\n` +
            `\n` +
            `   Cannot run tick simulation with incomplete 1m data.`
        );
        return null;
      }

      console.log(
        `   ✓ 1m data validated: ${oneMinCandles.length}/${expectedOneMinCandles} candles (${(oneMinCoverageRatio * 100).toFixed(1)}%)`
      );

      // Build/load tick cache for this range (15s ticks), with superset reuse + incremental extension.
      ticksByBarOpenTime = await getOrBuildTicksByBarOpenTime({
        source: preferredSource === "pyth" ? "pyth" : "binance",
        symbol,
        startTime,
        endTime,
        oneMinCandles,
      });

      // Aggregate to 5-minute candles for RSI calculation
      if ((options.aggregation || "aligned") === "legacy") {
        candles = [];
        for (let i = 0; i < oneMinCandles.length; i += 5) {
          const group = oneMinCandles.slice(i, i + 5);
          if (group.length === 5) candles.push(aggregate1MinTo5Min(group));
        }
      } else {
        candles = aggregate1MinTo5MinAligned(oneMinCandles);
      }
      console.log(
        `   Aggregated to ${candles.length} 5-minute candles (${options.aggregation || "aligned"})`
      );
    } else {
      // No 1-minute data => disable tick simulation to avoid 5m look-ahead ticks.
      console.error(
        `❌ 1-minute data unavailable for ${symbol} - refusing 5m look-ahead tick simulation.`
      );
      console.error(
        `   Fix: enable Pyth/Binance access for 1m candles (BACKTEST_USE_PYTH=true recommended).`
      );
      return null;
    }
  } else {
    console.log(`\n📥 Fetching ${symbol} ${interval} candles...`);
    try {
      candles = await fetchCandles(symbol, interval, startTime, endTime, preferredSource);
    } catch {
      candles = null;
    }
    if ((!candles || candles.length === 0) && preferredSource === "pyth") {
      console.warn(
        `   ⚠️  Pyth fetch failed for ${symbol} ${interval}. Falling back to Binance for this run.`
      );
      candles = await fetchCandles(symbol, interval, startTime, endTime, "binance");
    }
  }

  if (!candles || candles.length === 0) {
    console.error(`❌ No candle data available for ${symbol}`);
    return null;
  }

  console.log(`   ${candles.length} candles loaded`);

  // CRITICAL: Validate we have sufficient data for the requested lookback period
  const intervalMs = intervalToMs(interval);
  const requestedDays = (endTime - startTime) / 86400000;
  const expectedCandles = Math.max(1, Math.floor((endTime - startTime) / intervalMs));
  const coverageRatio = candles.length / expectedCandles;

  if (coverageRatio < 0.95) {
    const first = candles[0];
    const last = candles[candles.length - 1];
    const actualStartDate = first ? new Date(first.openTime).toISOString() : "N/A";
    const actualEndDate = last ? new Date(last.closeTime).toISOString() : "N/A";
    const actualDays =
      first && last ? ((last.closeTime - first.openTime) / 86400000).toFixed(1) : 0;

    console.error(
      `❌ INSUFFICIENT DATA for ${symbol}\n` +
        `   Requested lookback: ${requestedDays.toFixed(0)} days (${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()})\n` +
        `   Actual data:        ${actualDays} days (${actualStartDate} to ${actualEndDate})\n` +
        `   Expected candles:   ${expectedCandles}\n` +
        `   Received candles:   ${candles.length} (${(coverageRatio * 100).toFixed(1)}% coverage)\n` +
        `\n` +
        `   BACKTEST ABORTED - Cannot run with incomplete data.\n` +
        `\n` +
        `   Solutions:\n` +
        `   1. Reduce lookback: Set BACKTEST_DAYS to a smaller value (e.g., ${Math.floor(actualDays)})\n` +
        `   2. Clear cache: rm -f ${BACKTEST_CACHE_DIR}/*${symbol}*\n` +
        `   3. Switch data source: BACKTEST_USE_PYTH=false (try Binance)\n` +
        `   4. Check data availability at source for this time period`
    );
    return null;
  }

  console.log(
    `   ✓ Data coverage validated: ${candles.length}/${expectedCandles} candles (${(coverageRatio * 100).toFixed(1)}%)`
  );

  const marketOverride = getMarketOverride(options?.marketOverrides, symbol) || null;
  const overrideNum = (k) => {
    if (
      !marketOverride ||
      marketOverride[k] === undefined ||
      marketOverride[k] === null ||
      String(marketOverride[k]).trim() === ""
    )
      return null;
    const n = Number(marketOverride[k]);
    return Number.isFinite(n) ? n : null;
  };
  const overrideBool = (k) => {
    if (
      !marketOverride ||
      marketOverride[k] === undefined ||
      marketOverride[k] === null ||
      String(marketOverride[k]).trim() === ""
    )
      return null;
    if (typeof marketOverride[k] === "boolean") return marketOverride[k];
    const s = String(marketOverride[k]).trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
    return null;
  };

  // Check for per-market RSI overrides from environment variables
  const marketKey = `${symbol}_PERP`.toUpperCase();
  const perMarketOverboughtExtreme = process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_EXTREME`];
  const perMarketOverboughtRecovery = process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_RECOVERY`];
  const perMarketOversoldExtreme = process.env[`STRATEGY_${marketKey}_RSI_OVERSOLD_EXTREME`];
  const perMarketOversoldRecovery = process.env[`STRATEGY_${marketKey}_RSI_OVERSOLD_RECOVERY`];
  const perMarketLeverage = process.env[`STRATEGY_${marketKey}_LEVERAGE`];
  const perMarketHardStopPercent = process.env[`STRATEGY_${marketKey}_HARD_STOP_PERCENT`];
  const perMarketHardStopAtr = process.env[`STRATEGY_${marketKey}_HARD_STOP_ATR`];
  // Per-market failure exit and target configs (optimized from grid search)
  const perMarketFailureLong = process.env[`STRATEGY_${marketKey}_RSI_FAILURE_LONG`];
  const perMarketFailureShort = process.env[`STRATEGY_${marketKey}_RSI_FAILURE_SHORT`];
  const perMarketTargetLong = process.env[`STRATEGY_${marketKey}_RSI_TARGET_LONG`];
  const perMarketTargetShort = process.env[`STRATEGY_${marketKey}_RSI_TARGET_SHORT`];
  // Per-market entry timing configs
  const perMarketEntryMaxBars = process.env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_BARS`];
  const perMarketEntryMaxDeviation = process.env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_DEVIATION`];
  // Per-market volatility filter configs
  const perMarketMinVolatilityPct = process.env[`STRATEGY_${marketKey}_MIN_VOLATILITY_PCT`];
  const perMarketMaxVolatilityPct = process.env[`STRATEGY_${marketKey}_MAX_VOLATILITY_PCT`];
  // Per-market ADX filter configs
  const perMarketMinAdx = process.env[`STRATEGY_${marketKey}_MIN_ADX`];
  const perMarketMaxAdx = process.env[`STRATEGY_${marketKey}_MAX_ADX`];
  // Per-market ATR period (for stop calculations)
  const perMarketAtrPeriod = process.env[`STRATEGY_${marketKey}_ATR_PERIOD`];
  // Per-market direction gates (ALLOW_LONGS / ALLOW_SHORTS)
  const perMarketAllowLongs = process.env[`STRATEGY_${marketKey}_ALLOW_LONGS`];
  const perMarketAllowShorts = process.env[`STRATEGY_${marketKey}_ALLOW_SHORTS`];

  // Use per-market settings if available, otherwise use global defaults
  // NOTE: must treat "0" as a valid override (e.g., HARD_STOP_PERCENT=0 forces ATR-based stop)
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const effectiveOverboughtExtreme =
    overrideNum("rsiOverboughtExtreme") ??
    (has(perMarketOverboughtExtreme)
      ? parseFloat(perMarketOverboughtExtreme)
      : options.rsiOverboughtExtreme);
  const effectiveOverboughtRecovery =
    overrideNum("rsiOverboughtRecovery") ??
    (has(perMarketOverboughtRecovery)
      ? parseFloat(perMarketOverboughtRecovery)
      : options.rsiOverboughtRecovery);
  const effectiveOversoldExtreme =
    overrideNum("rsiOversoldExtreme") ??
    (has(perMarketOversoldExtreme)
      ? parseFloat(perMarketOversoldExtreme)
      : options.rsiOversoldExtreme);
  const effectiveOversoldRecovery =
    overrideNum("rsiOversoldRecovery") ??
    (has(perMarketOversoldRecovery)
      ? parseFloat(perMarketOversoldRecovery)
      : options.rsiOversoldRecovery);
  const effectiveLeverage =
    overrideNum("leverage") ??
    (has(perMarketLeverage) ? parseFloat(perMarketLeverage) : options.leverage);
  const effectiveHardStopPercent =
    overrideNum("rsiHardStopPercent") ??
    (has(perMarketHardStopPercent)
      ? parseFloat(perMarketHardStopPercent)
      : options.rsiHardStopPercent);
  const effectiveHardStopAtr =
    overrideNum("rsiHardStopAtr") ??
    (has(perMarketHardStopAtr) ? parseFloat(perMarketHardStopAtr) : options.rsiHardStopAtr);
  // Per-market failure and target overrides (0/100 means disabled, so use has() to check)
  const effectiveFailureLong =
    overrideNum("rsiFailureLong") ??
    (has(perMarketFailureLong) ? parseFloat(perMarketFailureLong) : options.rsiFailureLong);
  const effectiveFailureShort =
    overrideNum("rsiFailureShort") ??
    (has(perMarketFailureShort) ? parseFloat(perMarketFailureShort) : options.rsiFailureShort);
  // Priority: per-market override > global RSI_TARGET_LONG/SHORT > rsiTargetNeutral
  const effectiveTargetLong =
    overrideNum("rsiTargetLong") ??
    (has(perMarketTargetLong)
      ? parseFloat(perMarketTargetLong)
      : options.rsiTargetLong > 0
        ? options.rsiTargetLong
        : options.rsiTargetNeutral);
  const effectiveTargetShort =
    overrideNum("rsiTargetShort") ??
    (has(perMarketTargetShort)
      ? parseFloat(perMarketTargetShort)
      : options.rsiTargetShort > 0
        ? options.rsiTargetShort
        : options.rsiTargetNeutral);
  // Per-market entry timing overrides
  const effectiveEntryMaxBars =
    overrideNum("rsiEntryMaxBars") ??
    (has(perMarketEntryMaxBars) ? parseInt(perMarketEntryMaxBars) : options.rsiEntryMaxBars);
  const effectiveEntryMaxDeviation =
    overrideNum("rsiEntryMaxDeviation") ??
    (has(perMarketEntryMaxDeviation)
      ? parseFloat(perMarketEntryMaxDeviation)
      : options.rsiEntryMaxDeviation);
  // Per-market volatility filter overrides (defaults from env: RSI_MIN_VOLATILITY_PCT=0.2, RSI_MAX_VOLATILITY_PCT=5.0)
  const globalMinVol = parseFloat(process.env.RSI_MIN_VOLATILITY_PCT || "0.2");
  const globalMaxVol = parseFloat(process.env.RSI_MAX_VOLATILITY_PCT || "5.0");
  const effectiveMinVolatilityPct =
    overrideNum("rsiMinVolatilityPct") ??
    (has(perMarketMinVolatilityPct) ? parseFloat(perMarketMinVolatilityPct) : globalMinVol);
  const effectiveMaxVolatilityPct =
    overrideNum("rsiMaxVolatilityPct") ??
    (has(perMarketMaxVolatilityPct) ? parseFloat(perMarketMaxVolatilityPct) : globalMaxVol);
  // Per-market ADX filter overrides (defaults from env: RSI_MIN_ADX=0, RSI_MAX_ADX=100)
  const globalMinAdx = parseFloat(process.env.RSI_MIN_ADX || "0");
  const globalMaxAdx = parseFloat(process.env.RSI_MAX_ADX || "100");
  const effectiveMinAdx =
    overrideNum("rsiMinAdx") ?? (has(perMarketMinAdx) ? parseFloat(perMarketMinAdx) : globalMinAdx);
  const effectiveMaxAdx =
    overrideNum("rsiMaxAdx") ?? (has(perMarketMaxAdx) ? parseFloat(perMarketMaxAdx) : globalMaxAdx);
  // Per-market ATR period override (for stop distance calculations)
  const effectiveAtrPeriod =
    overrideNum("atrPeriod") ??
    (has(perMarketAtrPeriod) ? parseInt(perMarketAtrPeriod) : options.atrPeriod);
  // Per-market direction gates (ALLOW_LONGS / ALLOW_SHORTS)
  const effectiveAllowLongs =
    overrideBool("allowLongs") ??
    (has(perMarketAllowLongs)
      ? perMarketAllowLongs === "true" || perMarketAllowLongs === "1"
      : options.allowLongs);
  const effectiveAllowShorts =
    overrideBool("allowShorts") ??
    (has(perMarketAllowShorts)
      ? perMarketAllowShorts === "true" || perMarketAllowShorts === "1"
      : options.allowShorts);

  // Log per-market settings if different from global
  if (
    marketOverride ||
    perMarketOverboughtExtreme ||
    perMarketOverboughtRecovery ||
    perMarketLeverage ||
    perMarketHardStopPercent ||
    perMarketHardStopAtr ||
    perMarketFailureLong ||
    perMarketFailureShort ||
    perMarketAllowLongs ||
    perMarketAllowShorts
  ) {
    const dirsLabel =
      effectiveAllowLongs !== options.allowLongs || effectiveAllowShorts !== options.allowShorts
        ? `, dirs=${effectiveAllowLongs ? "L" : "-"}${effectiveAllowShorts ? "S" : "-"}`
        : "";
    console.log(
      `[${symbol}] Using per-market settings: overbought=${effectiveOverboughtExtreme}→${effectiveOverboughtRecovery}, leverage=${effectiveLeverage}x, hardStop=${effectiveHardStopPercent}%/ATR=${effectiveHardStopAtr}x, failure=${effectiveFailureLong}/${effectiveFailureShort}${dirsLabel}`
    );
  }

  // Create strategy with config (using per-market overrides where available)
  const strategyConfig = {
    market: `${symbol}-PERP`,
    quiet: !options.verbose, // Suppress per-trade logging unless verbose mode
    rsiStrategy: {
      rsiPeriod: options.rsiPeriod,
      rsiUseSma: options.rsiUseSma, // true = SMA, false = Wilder's smoothed (TradingView default)
      rsiOversoldExtreme: effectiveOversoldExtreme,
      rsiOversoldRecovery: effectiveOversoldRecovery,
      rsiOverboughtExtreme: effectiveOverboughtExtreme,
      rsiOverboughtRecovery: effectiveOverboughtRecovery,
      rsiEntryMaxDeviation: effectiveEntryMaxDeviation,
      rsiEntryMaxBars: effectiveEntryMaxBars, // Max bars after extreme to enter
      rsiTargetNeutral: options.rsiTargetNeutral,
      // Per-market target overrides
      rsiTargetLong: effectiveTargetLong,
      rsiTargetShort: effectiveTargetShort,
      rsiPartialTargetLong: options.rsiPartialTargetLong,
      rsiPartialTargetShort: options.rsiPartialTargetShort,
      rsiPartialPercent: options.rsiPartialPercent,
      // Per-market failure exit overrides (critical for optimized configs)
      rsiFailureLong: effectiveFailureLong,
      rsiFailureShort: effectiveFailureShort,
      rsiTimeStopBars: options.rsiTimeStopBars,
      rsiHardStopEnabled: options.rsiHardStopEnabled,
      rsiHardStopAtr: effectiveHardStopAtr,
      rsiHardStopPercent: effectiveHardStopPercent,
      atrPeriod: effectiveAtrPeriod,
      // Per-market volatility filter settings
      rsiMinVolatilityPct: effectiveMinVolatilityPct,
      rsiMaxVolatilityPct: effectiveMaxVolatilityPct,
      // Per-market ADX filter settings
      rsiMinAdx: effectiveMinAdx,
      rsiMaxAdx: effectiveMaxAdx,
    },
    // Circuit breaker settings (from CLI options to bypass dotenv override)
    maxConsecutiveLosses: options.circuitBreakerMaxLosses,
    circuitBreakerCooldownMs: options.circuitBreakerCooldownMs,
  };

  const strategy = new RsiMeanReversionStrategy(strategyConfig);

  // Run simulation
  // - backtest: bar-open entries using previous-bar RSI (historical model)
  // - bot: tick-level loop with recalculateLastBar + getSignal/shouldClose each tick (bot.js parity)
  const isBotModel =
    String(options._traceModel || options.traceModel || "backtest").toLowerCase() === "bot";
  const simFn = isBotModel ? simulateBotRuntimeSingleMarket : simulateRsiMeanReversion;
  const result = simFn(strategy, candles, {
    positionSizeUsd: options.positionSize,
    leverage: effectiveLeverage,
    hardStopPercent: effectiveHardStopPercent,
    debug: options.debug,
    verbose: options.verbose,
    allowLongs: effectiveAllowLongs,
    allowShorts: effectiveAllowShorts,
    maxPositions: options.maxPositions,
    // No-lookahead: tick simulation is ONLY allowed when we have real 1m candles.
    simulateTicks: tickSimEnabled && !!(oneMinCandles && oneMinCandles.length > 0),
    ticksPerCandle: tickSimEnabled ? TICKS_PER_5MIN_CANDLE : 1,
    // 1-minute candles for accurate tick simulation
    oneMinCandles: oneMinCandles,
    // Tick cache for fast per-bar tick lookups
    ticksByBarOpenTime,
    symbol,
    // Early exit parameters
    enableEarlyExits: options.enableEarlyExits,
    maxDrawdownPct: options.maxDrawdownPct,
    trailingAfterPartialPct: options.trailingAfterPartialPct,
    // Compounding parameters
    enableCompounding: options.enableCompounding,
    initialCapital: options.initialCapital,
    positionSizePercent: options.positionSizePercent,
    minPositionSize: options.minPositionSize,
    // Extended exit parameters
    extendedExit: options.extendedExit,
    extendedExitReversal: options.extendedExitReversal,
    // Parity guardrails / deterministic execution
    parityChecks: options.parityChecks,
    // Trace
    _trace: options._trace,
    _traceModel: isBotModel ? "bot" : options._traceModel || "backtest",
  });

  // Log circuit breaker summary (aggregated, not individual events)
  strategy.logCircuitBreakerSummary();

  // Map result fields for consistency
  return {
    symbol,
    trades: result.trades,
    totalPnL: result.realisedPnl,
    realisedPnl: result.realisedPnl, // Also include for consistency
    totalFees: result.totalFees,
    feeBreakdown: result.feeBreakdown,
    makerEntryStats: result.makerEntryStats || null,
    makerExitStats: result.makerExitStats || null,
    equitySeries: result.equitySeries,
    initialCapital: result.initialCapital,
    capitalStats: result.capitalStats, // Include capital stats for shared equity tracking
    strategyStats: strategy.getStats(),
    // Robustness helpers (avoid re-fetching / rebuilding)
    candles,
    oneMinCandles,
    strategyConfig,
    effectiveLeverage,
    effectiveHardStopPercent,
    effectiveHardStopAtr,
  };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  const options = parseArgs();

  if (options.printEventModel) {
    printBotRuntimeEventModel();
    return;
  }

  console.log("\n🔄 RSI Mean-Reversion Strategy Backtest");
  console.log("=".repeat(60));

  // Print full config summary (loaded from .env.rsi-reversion)
  console.log("\n📋 CONFIG (from .env.rsi-reversion)");
  console.log("-".repeat(60));
  console.log(`  Markets:             ${options.symbols.join(", ")}`);
  console.log(`  Days:                ${options.days}`);
  console.log(`  Interval:            ${options.interval}`);
  console.log(
    `  Position Sizing:     ${options.positionSizingMethod} (${options.positionSizePercent}%)`
  );
  console.log(
    `  Initial Trade Size:  $${options.positionSize.toFixed(0)} (${options.positionSizePercent}% of $${options.initialCapital})`
  );
  console.log(
    `  Compounding:         ${options.enableCompounding ? "ENABLED (realised-only; no intratrade resizing)" : "disabled"}`
  );
  console.log(`  Max Position:        $${options.maxPositionSize}`);
  console.log(`  Initial Capital:     $${options.initialCapital}`);
  console.log(`  Leverage:            ${options.leverage}x`);

  console.log("\n📊 RSI PARAMETERS (Global Defaults)");
  console.log("-".repeat(60));
  console.log(`  RSI Period:          ${options.rsiPeriod}`);
  console.log(
    `  RSI Method:          ${options.rsiUseSma ? "SMA (simple avg)" : "Wilder's (smoothed) ✓ TradingView"}`
  );

  console.log(`  Oversold Extreme:    ${options.rsiOversoldExtreme}`);
  console.log(`  Oversold Recovery:   ${options.rsiOversoldRecovery}`);
  console.log(`  Overbought Extreme:  ${options.rsiOverboughtExtreme}`);
  console.log(`  Overbought Recovery: ${options.rsiOverboughtRecovery}`);
  console.log(`  Entry Max Deviation: ${options.rsiEntryMaxDeviation}`);
  console.log(`  Entry Max Bars:      ${options.rsiEntryMaxBars}`);
  console.log(`  Target Neutral:      ${options.rsiTargetNeutral}`);
  console.log(`  Partial Long:        ${options.rsiPartialTargetLong}`);
  console.log(`  Partial Short:       ${options.rsiPartialTargetShort}`);
  console.log(`  Partial Percent:     ${options.rsiPartialPercent}%`);
  console.log(`  Failure Long:        ${options.rsiFailureLong}`);
  console.log(`  Failure Short:       ${options.rsiFailureShort}`);
  console.log(`  Time Stop Bars:      ${options.rsiTimeStopBars}`);

  // Show per-market overrides if any
  const perMarketOverrides = [];
  for (const sym of options.symbols) {
    const mKey = `${sym}_PERP`.toUpperCase();
    const obExt = process.env[`STRATEGY_${mKey}_RSI_OVERBOUGHT_EXTREME`];
    const obRec = process.env[`STRATEGY_${mKey}_RSI_OVERBOUGHT_RECOVERY`];
    const lev = process.env[`STRATEGY_${mKey}_LEVERAGE`];
    const hardStop = process.env[`STRATEGY_${mKey}_HARD_STOP_PERCENT`];
    const failLong = process.env[`STRATEGY_${mKey}_RSI_FAILURE_LONG`];
    const failShort = process.env[`STRATEGY_${mKey}_RSI_FAILURE_SHORT`];
    const targetLong = process.env[`STRATEGY_${mKey}_RSI_TARGET_LONG`];
    if (obExt || obRec || lev || hardStop || failLong || failShort || targetLong) {
      let override = `  ${sym}: overbought=${obExt || options.rsiOverboughtExtreme}→${obRec || options.rsiOverboughtRecovery}, leverage=${lev || options.leverage}x, hardStop=${hardStop || options.rsiHardStopPercent}%`;
      // Add failure/target overrides if set
      if (failLong || failShort) {
        override += `, failure=${failLong || options.rsiFailureLong}/${failShort || options.rsiFailureShort}`;
      }
      if (targetLong) {
        override += `, target_long=${targetLong}`;
      }
      perMarketOverrides.push(override);
    }
  }
  if (perMarketOverrides.length > 0) {
    console.log("\n📈 PER-MARKET OVERRIDES");
    console.log("-".repeat(60));
    perMarketOverrides.forEach((l) => console.log(l));
  }

  console.log("\n🛡️ STOP LOSS CONFIG");
  console.log("-".repeat(60));
  console.log(`  Hard Stop Enabled:   ${options.rsiHardStopEnabled ? "YES" : "NO"}`);
  console.log(`  Hard Stop ATR:       ${options.rsiHardStopAtr}x ATR`);
  console.log(
    `  Hard Stop % (global): ${options.rsiHardStopPercent > 0 ? options.rsiHardStopPercent + "%" : "disabled (using ATR)"} (per-market overrides may apply)`
  );
  console.log(`  ATR Period:          ${options.atrPeriod}`);

  console.log("\n🎯 FILTERS");
  console.log("-".repeat(60));
  console.log(`  Allow Longs:         ${options.allowLongs ? "YES" : "NO"}`);
  console.log(`  Allow Shorts:        ${options.allowShorts ? "YES" : "NO"}`);
  console.log(`  Max Positions:       ${options.maxPositions}`);

  // Allocator-driven dynamic risk (post-selection size/leverage/stop adjustment)
  console.log("\n🎲 ALLOCATOR RISK");
  console.log("-".repeat(60));
  if (options.allocatorRiskEnabled) {
    if (options.allocatorRiskNeutral) {
      console.log(`  Status:              NEUTRAL (parity mode - returns base values)`);
    } else {
      console.log(`  Status:              ENABLED (dynamic size/leverage/stops)`);
    }
    console.log(
      `  Size Mult Range:     ${parseFloat(process.env.ALLOCATOR_RISK_SIZE_MULT_MIN || 0.7).toFixed(1)}x - ${parseFloat(process.env.ALLOCATOR_RISK_SIZE_MULT_MAX || 1.1).toFixed(1)}x`
    );
    console.log(
      `  Lev Mult Range:      ${parseFloat(process.env.ALLOCATOR_RISK_LEVERAGE_MULT_MIN || 0.7).toFixed(1)}x - ${parseFloat(process.env.ALLOCATOR_RISK_LEVERAGE_MULT_MAX || 1.1).toFixed(1)}x`
    );
    console.log(
      `  Stop% Mult Range:    ${parseFloat(process.env.ALLOCATOR_RISK_STOP_PCT_MULT_MIN || 0.6).toFixed(1)}x - ${parseFloat(process.env.ALLOCATOR_RISK_STOP_PCT_MULT_MAX || 1.2).toFixed(1)}x`
    );
    console.log(
      `  Quality Gamma:       ${parseFloat(process.env.ALLOCATOR_RISK_QUALITY_GAMMA || 1.0).toFixed(2)}`
    );
  } else {
    console.log(`  Status:              DISABLED (using fixed base values)`);
  }

  // Calculate time range
  // When using lookback days without explicit start/end, snap to LAST COMPLETED DAY (UTC)
  // to avoid intraday varying results. This ensures:
  // 1. Multiple runs on the same day use identical date range
  // 2. Lookback is always in full days (00:00:00 UTC to 23:59:59.999 UTC)
  // 3. Consistent caching and reproducible results
  //
  // When explicit timestamps are provided, snap to 5-minute candles as before.
  const FIVE_MIN_MS = 300_000;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  let endTime, startTime;

  if (Number.isFinite(options.endTime) && Number.isFinite(options.startTime)) {
    // Both start and end explicitly provided: snap to 5-min candles
    const rawEnd = options.endTime;
    const rawStart = options.startTime;
    endTime = alignToCandleCloseMs(rawEnd, FIVE_MIN_MS);
    startTime = alignToCandleOpenMs(rawStart, FIVE_MIN_MS);
  } else if (Number.isFinite(options.endTime)) {
    // Only end provided: snap end to 5-min, calculate start from lookback days
    const rawEnd = options.endTime;
    endTime = alignToCandleCloseMs(rawEnd, FIVE_MIN_MS);
    startTime = alignToCandleOpenMs(endTime - options.days * ONE_DAY_MS, FIVE_MIN_MS);
  } else {
    // No explicit timestamps: snap to LAST COMPLETED DAY for reproducibility
    // Example: if now is 2025-12-27 14:40:00 UTC, snap to 2025-12-26 23:59:59.999 UTC
    const nowDateUTC = new Date(now);
    const todayStartUTC = Date.UTC(
      nowDateUTC.getUTCFullYear(),
      nowDateUTC.getUTCMonth(),
      nowDateUTC.getUTCDate(),
      0,
      0,
      0,
      0
    );

    // End of last completed day (yesterday's EOD)
    const lastCompletedDayEnd = todayStartUTC - 1;

    // Start: N days before the end of last completed day
    const lastCompletedDayStart = lastCompletedDayEnd - options.days * ONE_DAY_MS + 1;

    endTime = lastCompletedDayEnd;
    startTime = alignToCandleOpenMs(lastCompletedDayStart, FIVE_MIN_MS);
  }

  console.log("\n🕒 TIME RANGE");
  console.log("-".repeat(60));
  console.log(`  Start:               ${new Date(startTime).toISOString()} (${startTime})`);
  console.log(`  End:                 ${new Date(endTime).toISOString()} (${endTime})`);

  // ============================================================
  // TRACE COMPARE MODE: run BOTH models + write diff summary
  // ============================================================
  if (options.traceCompare) {
    options.trace = true;
    const runId = Date.now();
    const traceOutputDir = path.join(__dirname, "../../results/json");
    if (!fs.existsSync(traceOutputDir)) fs.mkdirSync(traceOutputDir, { recursive: true });

    const tickMs =
      (options.interval || "5m") === "5m"
        ? TICK_INTERVAL_MS
        : Math.floor(
            intervalToMs(options.interval || "5m") /
              (options.ticksPerCandle || TICKS_PER_5MIN_CANDLE)
          );

    const runTraceForModel = async (model) => {
      const modelOptions = { ...options };
      modelOptions.trace = true;
      modelOptions.traceModel = model;
      modelOptions._traceModel = model;
      modelOptions._trace = createTraceCollector(modelOptions, {
        startTime,
        endTime,
        runId,
        model,
      });

      // Run minimal simulation (we only need the trace side effects)
      if (modelOptions.symbols.length === 1) {
        await runBacktestForSymbol(modelOptions.symbols[0], modelOptions, startTime, endTime);
      } else {
        // Multi-market: build candles + strategies fresh for this model
        const candlesMap = new Map();
        const strategiesMap = new Map();
        const perMarketLeverage = new Map();
        const perMarketHardStop = new Map();
        const perMarketHardStopAtr = new Map();
        const perMarketAllowLongs = new Map();
        const perMarketAllowShorts = new Map();

        for (const symbol of modelOptions.symbols) {
          const interval = modelOptions.interval || "5m";
          const candles = await fetchCandles(symbol, interval, startTime, endTime);
          if (!candles || candles.length === 0) continue;
          candlesMap.set(symbol, candles);

          const marketKey = `${symbol}_PERP`.toUpperCase();
          const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
          const overboughtExtreme =
            parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_EXTREME`]) ||
            modelOptions.rsiOverboughtExtreme;
          const overboughtRecovery =
            parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_RECOVERY`]) ||
            modelOptions.rsiOverboughtRecovery;
          const oversoldExtreme =
            parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERSOLD_EXTREME`]) ||
            modelOptions.rsiOversoldExtreme;
          const oversoldRecovery =
            parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERSOLD_RECOVERY`]) ||
            modelOptions.rsiOversoldRecovery;

          const envLev = process.env[`STRATEGY_${marketKey}_LEVERAGE`];
          const envHardStopPct = process.env[`STRATEGY_${marketKey}_HARD_STOP_PERCENT`];
          const envHardStopAtr = process.env[`STRATEGY_${marketKey}_HARD_STOP_ATR`];

          // CLI override takes precedence over env file (to bypass dotenv override issue)
          const marketLeverage =
            modelOptions.cliMarketLeverage?.get(symbol) ??
            (envLev !== undefined && envLev !== "" ? parseFloat(envLev) : modelOptions.leverage);
          const marketHardStop =
            envHardStopPct !== undefined && envHardStopPct !== ""
              ? parseFloat(envHardStopPct)
              : modelOptions.rsiHardStopPercent;
          const marketHardStopAtr =
            envHardStopAtr !== undefined && envHardStopAtr !== ""
              ? parseFloat(envHardStopAtr)
              : modelOptions.rsiHardStopAtr;

          perMarketLeverage.set(symbol, marketLeverage);
          perMarketHardStop.set(symbol, marketHardStop);
          perMarketHardStopAtr.set(symbol, marketHardStopAtr);

          // Direction gates per-market (ALLOW_LONGS / ALLOW_SHORTS)
          const envAllowLongs = process.env[`STRATEGY_${marketKey}_ALLOW_LONGS`];
          const envAllowShorts = process.env[`STRATEGY_${marketKey}_ALLOW_SHORTS`];
          const marketAllowLongs = has(envAllowLongs)
            ? envAllowLongs === "true" || envAllowLongs === "1"
            : modelOptions.allowLongs;
          const marketAllowShorts = has(envAllowShorts)
            ? envAllowShorts === "true" || envAllowShorts === "1"
            : modelOptions.allowShorts;
          perMarketAllowLongs.set(symbol, marketAllowLongs);
          perMarketAllowShorts.set(symbol, marketAllowShorts);

          // Failure/target overrides (already used by the strategy config)
          const envFailureLong = process.env[`STRATEGY_${marketKey}_RSI_FAILURE_LONG`];
          const envFailureShort = process.env[`STRATEGY_${marketKey}_RSI_FAILURE_SHORT`];
          const envTargetLong = process.env[`STRATEGY_${marketKey}_RSI_TARGET_LONG`];
          const envTargetShort = process.env[`STRATEGY_${marketKey}_RSI_TARGET_SHORT`];
          const envEntryMaxBars = process.env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_BARS`];
          const envEntryMaxDeviation = process.env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_DEVIATION`];
          const envMinVolatilityPct = process.env[`STRATEGY_${marketKey}_MIN_VOLATILITY_PCT`];
          const envMaxVolatilityPct = process.env[`STRATEGY_${marketKey}_MAX_VOLATILITY_PCT`];
          const envMinAdx = process.env[`STRATEGY_${marketKey}_MIN_ADX`];
          const envMaxAdx = process.env[`STRATEGY_${marketKey}_MAX_ADX`];
          const envAtrPeriod = process.env[`STRATEGY_${marketKey}_ATR_PERIOD`];

          const marketFailureLong = has(envFailureLong)
            ? parseFloat(envFailureLong)
            : modelOptions.rsiFailureLong;
          const marketFailureShort = has(envFailureShort)
            ? parseFloat(envFailureShort)
            : modelOptions.rsiFailureShort;
          // Priority: per-market override > global RSI_TARGET_LONG/SHORT > rsiTargetNeutral
          const marketTargetLong = has(envTargetLong)
            ? parseFloat(envTargetLong)
            : modelOptions.rsiTargetLong > 0
              ? modelOptions.rsiTargetLong
              : modelOptions.rsiTargetNeutral;
          const marketTargetShort = has(envTargetShort)
            ? parseFloat(envTargetShort)
            : modelOptions.rsiTargetShort > 0
              ? modelOptions.rsiTargetShort
              : modelOptions.rsiTargetNeutral;
          const marketEntryMaxBars = has(envEntryMaxBars)
            ? parseInt(envEntryMaxBars)
            : modelOptions.rsiEntryMaxBars;
          const marketEntryMaxDeviation = has(envEntryMaxDeviation)
            ? parseFloat(envEntryMaxDeviation)
            : modelOptions.rsiEntryMaxDeviation;
          const globalMinVol = parseFloat(process.env.RSI_MIN_VOLATILITY_PCT || "0.2");
          const globalMaxVol = parseFloat(process.env.RSI_MAX_VOLATILITY_PCT || "5.0");
          const marketMinVolatilityPct = has(envMinVolatilityPct)
            ? parseFloat(envMinVolatilityPct)
            : globalMinVol;
          const marketMaxVolatilityPct = has(envMaxVolatilityPct)
            ? parseFloat(envMaxVolatilityPct)
            : globalMaxVol;
          const globalMinAdx = parseFloat(process.env.RSI_MIN_ADX || "0");
          const globalMaxAdx = parseFloat(process.env.RSI_MAX_ADX || "100");
          const marketMinAdx = has(envMinAdx) ? parseFloat(envMinAdx) : globalMinAdx;
          const marketMaxAdx = has(envMaxAdx) ? parseFloat(envMaxAdx) : globalMaxAdx;
          const marketAtrPeriod = has(envAtrPeriod)
            ? parseInt(envAtrPeriod)
            : modelOptions.atrPeriod;

          const strategy = new RsiMeanReversionStrategy({
            market: `${symbol}-PERP`,
            quiet: true,
            rsiStrategy: {
              rsiPeriod: modelOptions.rsiPeriod,
              rsiUseSma: modelOptions.rsiUseSma,
              rsiOversoldExtreme: oversoldExtreme,
              rsiOversoldRecovery: oversoldRecovery,
              rsiOverboughtExtreme: overboughtExtreme,
              rsiOverboughtRecovery: overboughtRecovery,
              rsiEntryMaxDeviation: marketEntryMaxDeviation,
              rsiEntryMaxBars: marketEntryMaxBars,
              rsiTargetNeutral: modelOptions.rsiTargetNeutral,
              rsiTargetLong: marketTargetLong,
              rsiTargetShort: marketTargetShort,
              rsiPartialTargetLong: modelOptions.rsiPartialTargetLong,
              rsiPartialTargetShort: modelOptions.rsiPartialTargetShort,
              rsiPartialPercent: modelOptions.rsiPartialPercent,
              rsiFailureLong: marketFailureLong,
              rsiFailureShort: marketFailureShort,
              rsiTimeStopBars: modelOptions.rsiTimeStopBars,
              rsiHardStopEnabled: modelOptions.rsiHardStopEnabled,
              rsiHardStopAtr: marketHardStopAtr,
              rsiHardStopPercent: marketHardStop,
              atrPeriod: marketAtrPeriod,
              rsiMinVolatilityPct: marketMinVolatilityPct,
              rsiMaxVolatilityPct: marketMaxVolatilityPct,
              rsiMinAdx: marketMinAdx,
              rsiMaxAdx: marketMaxAdx,
            },
          });
          strategiesMap.set(symbol, strategy);
        }

        const simFn =
          model === "bot" ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;
        simFn(strategiesMap, candlesMap, {
          initialCapital: modelOptions.initialCapital,
          leverage: modelOptions.leverage,
          positionSizePercent: modelOptions.positionSizePercent,
          enableCompounding: modelOptions.enableCompounding,
          allowLongs: modelOptions.allowLongs,
          allowShorts: modelOptions.allowShorts,
          maxPositions: modelOptions.maxPositions,
          ticksPerCandle: modelOptions.ticksPerCandle || TICKS_PER_5MIN_CANDLE,
          simulateTicks: true,
          rsiHardStopPercent: modelOptions.rsiHardStopPercent,
          rsiHardStopAtr: modelOptions.rsiHardStopAtr,
          perMarketLeverage,
          perMarketHardStop,
          perMarketHardStopAtr,
          perMarketAllowLongs,
          perMarketAllowShorts,
          _trace: modelOptions._trace,
          _traceModel: model,
          allocatorExploreProbability: modelOptions.allocatorExploreProbability,
          allocatorUseBotScoring: modelOptions.allocatorUseBotScoring,
          allocatorRiskEnabled: modelOptions.allocatorRiskEnabled,
          allocatorRiskNeutral: modelOptions.allocatorRiskNeutral,
        });
      }

      const traceFile = path.join(
        traceOutputDir,
        `trace-${model}-${options.symbols.join("-")}-${options.days}d-${runId}.json`
      );
      modelOptions._trace.write(traceFile);
      return modelOptions._trace.toJSON();
    };

    const traceBacktest = await runTraceForModel("backtest");
    const traceBot = await runTraceForModel("bot");

    const diff = diffTraceModels(traceBacktest, traceBot, {
      kinds: ["entry", "exit"],
      tsToleranceMs: tickMs,
      priceTolerance: 0, // stopPrice deltas must match exactly (tick-level)
      barIndexTolerance: 1,
    });

    const diffPath = path.join(
      traceOutputDir,
      `trace-diff-${options.symbols.join("-")}-${options.days}d-${runId}.json`
    );
    fs.writeFileSync(diffPath, JSON.stringify(diff, null, 2));

    console.log("\n🧾 TRACE COMPARE SUMMARY");
    console.log("-".repeat(60));
    console.log(`  backtest events: ${diff.counts.a}`);
    console.log(`  bot events:      ${diff.counts.b}`);
    console.log(`  kinds compared:  ${diff.kindsCompared.join(", ")}`);
    console.log(`  tick tolerance:  ${tickMs}ms`);
    console.log(`  diff file:       ${diffPath}`);
    if (diff.firstMismatch) {
      console.log("\n  First mismatch:");
      console.log(`    index:  ${diff.firstMismatch.index}`);
      console.log(`    reason: ${diff.firstMismatch.reason}`);
      console.log(`    a: ${stableStringify(diff.firstMismatch.a)}`);
      console.log(`    b: ${stableStringify(diff.firstMismatch.b)}`);
    } else {
      console.log("\n  ✅ No mismatches found in compared event stream.");
    }
    return;
  }

  // Trace collector (optional)
  const traceCollector = createTraceCollector(options, { startTime, endTime });
  const traceOutputDir = path.join(__dirname, "../../results/json");
  const traceOutputFile = path.join(
    traceOutputDir,
    `trace-${options.traceModel || "backtest"}-${options.symbols.join("-")}-${options.days}d-${Date.now()}.json`
  );
  // Pass through options for downstream simulation functions
  options._trace = traceCollector;
  options._traceModel = options.traceModel || "backtest";

  let allResults = [];
  let result = null;
  // Store in-memory candles/configs for robustness testing (avoid refetch + scope issues)
  let candlesMapForRobustness = null;
  let strategyConfigsMapForRobustness = null;
  let oneMinCandlesMapForRobustness = null; // single-market only (tick sim)
  let ticksByBarOpenTimeMapForRobustness = null;
  let perMarketLeverageForRobustness = null;
  let perMarketHardStopForRobustness = null;
  let perMarketHardStopAtrForRobustness = null;

  // SINGLE MARKET: Use original simulation with tick simulation (more accurate)
  // MULTI MARKET: Use shared capital simulation with unified timeline
  if (options.symbols.length === 1) {
    console.log(`\n🚀 Running single-market backtest with tick simulation...`);
    console.log(`   Capital: $${options.initialCapital}`);

    const singleResult = await runBacktestForSymbol(
      options.symbols[0],
      options,
      startTime,
      endTime
    );
    if (singleResult) {
      allResults.push(singleResult);
      result = {
        trades: singleResult.trades,
        realisedPnl: singleResult.totalPnL,
        totalPnL: singleResult.totalPnL,
        totalFees: singleResult.totalFees,
        feeBreakdown: singleResult.feeBreakdown,
        equitySeries: singleResult.equitySeries,
        initialCapital: singleResult.initialCapital,
        capitalStats: singleResult.capitalStats,
        marketResults: new Map([
          [
            options.symbols[0],
            {
              trades: singleResult.trades,
              totalPnL: singleResult.totalPnL,
              totalFees: singleResult.totalFees,
            },
          ],
        ]),
      };

      // Robustness maps for single-market mode
      candlesMapForRobustness = new Map([[options.symbols[0], singleResult.candles]]);
      oneMinCandlesMapForRobustness = new Map([[options.symbols[0], singleResult.oneMinCandles]]);
      strategyConfigsMapForRobustness = new Map([
        [options.symbols[0], singleResult.strategyConfig],
      ]);
      perMarketLeverageForRobustness = new Map([
        [options.symbols[0], singleResult.effectiveLeverage],
      ]);
      perMarketHardStopForRobustness = new Map([
        [options.symbols[0], singleResult.effectiveHardStopPercent],
      ]);
      perMarketHardStopAtrForRobustness = new Map([
        [options.symbols[0], singleResult.effectiveHardStopAtr],
      ]);
    }
  } else {
    // SHARED CAPITAL MODE: All markets share the same capital pool (like production)
    // Uses unified timeline with shared capital across markets
    console.log(
      `\n🚀 Running backtest for ${options.symbols.length} market(s) with SHARED capital...`
    );
    console.log(`   Total Capital: $${options.initialCapital} (shared across all markets)`);
    console.log(`   Max Positions: ${options.maxPositions} (across all markets)`);

    // Fetch candles for all markets
    const candlesMap = new Map();
    const oneMinCandlesMap = new Map();
    const strategiesMap = new Map();
    const strategyConfigsMap = new Map();
    const perMarketLeverage = new Map();
    const perMarketHardStop = new Map();
    const perMarketHardStopAtr = new Map();
    const perMarketAllowLongs = new Map();
    const perMarketAllowShorts = new Map();

    // Store for robustness testing (scope fix)
    candlesMapForRobustness = candlesMap;
    strategyConfigsMapForRobustness = strategyConfigsMap;
    oneMinCandlesMapForRobustness = oneMinCandlesMap;
    perMarketLeverageForRobustness = perMarketLeverage;
    perMarketHardStopForRobustness = perMarketHardStop;
    perMarketHardStopAtrForRobustness = perMarketHardStopAtr;

    const interval = options.interval || "5m";
    const use1MinTicks = options.use1MinTicks !== false;
    const preferredSource = process.env.BACKTEST_USE_PYTH === "false" ? "binance" : "pyth";
    const ticksByBarOpenTimeMap = new Map(); // symbol -> Map<barOpenTime, tickObjs[]>
    ticksByBarOpenTimeMapForRobustness = ticksByBarOpenTimeMap;

    // Memory optimization settings
    const useTypedArrays = options.useTypedArrays !== false;
    const release1mAfterTicks = options.release1mAfterTicks !== false;
    const batchMarketLoading = options.batchMarketLoading !== false;
    const batchSize = options.batchSize || 4;
    const gcBetweenBatches = options.gcBetweenBatches !== false;

    // Log memory optimization settings
    if (options.verbose || options.symbols.length > 6) {
      console.log(`\n💾 Memory Optimization Settings:`);
      console.log(
        `   TypedArrays:       ${useTypedArrays ? "ON" : "OFF"} (--noTypedArrays to disable)`
      );
      console.log(
        `   Release 1m:        ${release1mAfterTicks ? "ON" : "OFF"} (--noRelease1m to disable)`
      );
      console.log(
        `   Batch Loading:     ${batchMarketLoading ? `ON (${batchSize} per batch)` : "OFF"}`
      );
      console.log(`   GC Between Batches:${gcBetweenBatches ? "ON" : "OFF"}`);

      // Estimate memory requirements
      const memEst = estimateMemoryRequirements(
        options.symbols.length,
        options.days,
        interval,
        useTypedArrays
      );
      console.log(
        `\n📊 Memory Estimate (${options.symbols.length} markets × ${options.days} days):`
      );
      console.log(`   Candle data:       ~${memEst.candleMemoryMB} MB`);
      console.log(`   Tick cache:        ~${memEst.tickMemoryMB} MB`);
      console.log(`   Overhead:          ~${memEst.overheadMB} MB`);
      console.log(`   Total (w/ release):~${memEst.totalWithRelease} MB`);
      console.log(
        `   Recommended heap:  ${memEst.recommendedHeapMB} MB (--max-old-space-size=${memEst.recommendedHeapMB})`
      );
      console.log(`   Current heap:      ${formatMemory(getMemoryUsage())}`);
    }

    const loadAllMarkets = async (source) => {
      candlesMap.clear();
      oneMinCandlesMap.clear();
      ticksByBarOpenTimeMap.clear();
      const symbolList = options.symbols;

      const loadStartMem = getMemoryUsage();
      const loadStartTime = Date.now();
      let totalCandles = 0;
      let gcRuns = 0;

      // Process in batches if enabled
      const batches = batchMarketLoading
        ? (() => {
            const b = [];
            for (let i = 0; i < symbolList.length; i += batchSize) {
              b.push(symbolList.slice(i, i + batchSize));
            }
            return b;
          })()
        : [symbolList];

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];

        if (batchMarketLoading && batches.length > 1) {
          console.log(`\n   📦 Batch ${batchIdx + 1}/${batches.length}: ${batch.join(", ")}`);
        }

        for (let idx = 0; idx < batch.length; idx++) {
          const symbol = batch[idx];
          const symbolStartMem = getMemoryUsage();

          if (interval === "5m" && use1MinTicks) {
            console.log(`\n📥 Fetching ${symbol} 1m candles (for accurate tick simulation)...`);
            let oneMin = await fetchCandles(symbol, "1m", startTime, endTime, source);
            if (!oneMin || oneMin.length === 0)
              throw new Error(`No 1m candles for ${symbol} (${source})`);

            // Store 1m candles only if we're not releasing them
            if (!release1mAfterTicks) {
              if (useTypedArrays) {
                oneMinCandlesMap.set(symbol, createTypedCandleArray(oneMin));
              } else {
                oneMinCandlesMap.set(symbol, oneMin);
              }
            }

            // Tick cache (15s ticks from 1m candles), with superset reuse + incremental extension.
            const ticksByBar = await getOrBuildTicksByBarOpenTime({
              source,
              symbol,
              startTime,
              endTime,
              oneMinCandles: oneMin,
            });
            ticksByBarOpenTimeMap.set(symbol, ticksByBar);

            const agg =
              (options.aggregation || "aligned") === "legacy"
                ? (() => {
                    const out = [];
                    for (let i = 0; i < oneMin.length; i += 5) {
                      const g = oneMin.slice(i, i + 5);
                      if (g.length === 5) out.push(aggregate1MinTo5Min(g));
                    }
                    return out;
                  })()
                : aggregate1MinTo5MinAligned(oneMin);
            if (!agg || agg.length === 0)
              throw new Error(`No 5m candles after aggregation for ${symbol} (${source})`);

            // Convert to TypedArray if enabled
            if (useTypedArrays) {
              candlesMap.set(symbol, createTypedCandleArray(agg));
            } else {
              candlesMap.set(symbol, agg);
            }

            totalCandles += agg.length;

            // Release 1m candles after tick cache is built (saves ~50MB per market)
            if (release1mAfterTicks) {
              const oneMinCount = oneMin.length;
              oneMin = null; // Allow GC
              console.log(
                `   ${oneMinCount} 1m candles → ${agg.length} 5m candles (${options.aggregation || "aligned"}) [1m released]`
              );
            } else {
              console.log(
                `   ${oneMin.length} 1m candles → ${agg.length} 5m candles (${options.aggregation || "aligned"})`
              );
            }
          } else {
            console.log(`\n📥 Fetching ${symbol} ${interval} candles...`);
            const candles = await fetchCandles(symbol, interval, startTime, endTime, source);
            if (!candles || candles.length === 0)
              throw new Error(`No ${interval} candles for ${symbol} (${source})`);

            // Convert to TypedArray if enabled
            if (useTypedArrays) {
              candlesMap.set(symbol, createTypedCandleArray(candles));
            } else {
              candlesMap.set(symbol, candles);
            }

            totalCandles += candles.length;
            console.log(`   ${candles.length} candles loaded`);
          }

          // Memory delta logging for verbose mode
          if (options.verbose) {
            const afterMem = getMemoryUsage();
            const delta = afterMem.heapUsed - symbolStartMem.heapUsed;
            console.log(`   💾 Memory: +${delta}MB (${formatMemory(afterMem)})`);
          }

          // Add delay between symbols to avoid overwhelming API (except after last symbol)
          const isLastInBatch = idx === batch.length - 1;
          const isLastBatch = batchIdx === batches.length - 1;
          if (!isLastInBatch && source === "pyth") {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        // GC between batches if enabled
        if (gcBetweenBatches && batchIdx < batches.length - 1) {
          if (tryGC()) {
            gcRuns++;
            const afterGC = getMemoryUsage();
            console.log(`   🗑️ GC after batch ${batchIdx + 1}: ${formatMemory(afterGC)}`);
          }
        }
      }

      // Final memory report
      const loadEndMem = getMemoryUsage();
      const loadDuration = ((Date.now() - loadStartTime) / 1000).toFixed(1);
      const memDelta = loadEndMem.heapUsed - loadStartMem.heapUsed;
      console.log(`\n   ✓ All ${symbolList.length} markets loaded in ${loadDuration}s`);
      console.log(`   Total candles: ${totalCandles.toLocaleString()}`);
      console.log(`   Memory used: +${memDelta}MB (${formatMemory(loadEndMem)})`);
      if (gcRuns > 0) console.log(`   GC runs: ${gcRuns}`);
    };

    let runSource = preferredSource;
    try {
      await loadAllMarkets(runSource);
    } catch (e) {
      if (preferredSource === "pyth") {
        console.warn(
          `\n⚠️  Pyth load failed (${e.message}). Falling back to Binance for ALL markets (single-source enforcement).\n`
        );
        runSource = "binance";
        await loadAllMarkets(runSource);
      } else {
        throw e;
      }
    }

    // CRITICAL: Validate all markets have sufficient data
    const intervalMs = intervalToMs(interval);
    const expectedCandles = Math.max(1, Math.floor((endTime - startTime) / intervalMs));
    const minAcceptableCoverage = 0.95;

    for (const [symbol, candles] of candlesMap.entries()) {
      const coverageRatio = candles.length / expectedCandles;
      if (coverageRatio < minAcceptableCoverage) {
        const first = candles[0];
        const last = candles[candles.length - 1];
        console.error(
          `\n❌ INSUFFICIENT DATA for ${symbol} - Multi-market backtest aborted\n` +
            `   Expected: ${expectedCandles} candles\n` +
            `   Received: ${candles.length} candles (${(coverageRatio * 100).toFixed(1)}% coverage)\n` +
            `   Range: ${first ? new Date(first.openTime).toISOString() : "N/A"} to ${last ? new Date(last.closeTime).toISOString() : "N/A"}\n` +
            `\n` +
            `   All markets must have complete data for multi-market simulation.\n` +
            `   Solutions:\n` +
            `   1. Reduce BACKTEST_DAYS\n` +
            `   2. Remove ${symbol} from SYMBOLS list\n` +
            `   3. Clear cache and retry: rm -f ${BACKTEST_CACHE_DIR}/*${symbol}*`
        );
        process.exit(1);
      }
      console.log(
        `   [${symbol}] ✓ Data validated: ${candles.length}/${expectedCandles} candles (${(coverageRatio * 100).toFixed(1)}%)`
      );
    }

    // Validate 1m data for all markets if using tick simulation
    // Skip if 1m candles were released after tick cache build (they were validated during loading)
    if (use1MinTicks && interval === "5m" && oneMinCandlesMap.size > 0) {
      const oneMinIntervalMs = 60000;
      const expectedOneMinCandles = Math.max(
        1,
        Math.floor((endTime - startTime) / oneMinIntervalMs)
      );

      for (const [symbol, oneMinCandles] of oneMinCandlesMap.entries()) {
        const coverageRatio = oneMinCandles.length / expectedOneMinCandles;
        if (coverageRatio < minAcceptableCoverage) {
          const first = oneMinCandles[0];
          const last = oneMinCandles[oneMinCandles.length - 1];
          console.error(
            `\n❌ INSUFFICIENT 1m DATA for ${symbol} - Cannot run tick simulation\n` +
              `   Expected: ${expectedOneMinCandles} candles\n` +
              `   Received: ${oneMinCandles.length} candles (${(coverageRatio * 100).toFixed(1)}% coverage)\n` +
              `   Range: ${first ? new Date(first.openTime).toISOString() : "N/A"} to ${last ? new Date(last.closeTime).toISOString() : "N/A"}`
          );
          process.exit(1);
        }
        console.log(
          `   [${symbol}] ✓ 1m data validated: ${oneMinCandles.length}/${expectedOneMinCandles} candles (${(coverageRatio * 100).toFixed(1)}%)`
        );
      }
    } else if (use1MinTicks && interval === "5m" && release1mAfterTicks) {
      console.log(`   ✓ 1m data validated during loading (released after tick cache build)`);
    }

    // Build strategies AFTER candles are successfully loaded (single-source guarantee)
    for (const symbol of options.symbols) {
      // Get per-market settings
      const marketKey = `${symbol}_PERP`.toUpperCase();
      const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
      const overboughtExtreme =
        parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_EXTREME`]) ||
        options.rsiOverboughtExtreme;
      const overboughtRecovery =
        parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_RECOVERY`]) ||
        options.rsiOverboughtRecovery;
      const oversoldExtreme =
        parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERSOLD_EXTREME`]) ||
        options.rsiOversoldExtreme;
      const oversoldRecovery =
        parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERSOLD_RECOVERY`]) ||
        options.rsiOversoldRecovery;
      const envLev = process.env[`STRATEGY_${marketKey}_LEVERAGE`];
      const envHardStopPct = process.env[`STRATEGY_${marketKey}_HARD_STOP_PERCENT`];
      const envHardStopAtr = process.env[`STRATEGY_${marketKey}_HARD_STOP_ATR`];
      // Per-market failure exit and target configs (optimized from grid search)
      const envFailureLong = process.env[`STRATEGY_${marketKey}_RSI_FAILURE_LONG`];
      const envFailureShort = process.env[`STRATEGY_${marketKey}_RSI_FAILURE_SHORT`];
      const envTargetLong = process.env[`STRATEGY_${marketKey}_RSI_TARGET_LONG`];
      const envTargetShort = process.env[`STRATEGY_${marketKey}_RSI_TARGET_SHORT`];
      // Per-market entry timing configs
      const envEntryMaxBars = process.env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_BARS`];
      const envEntryMaxDeviation = process.env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_DEVIATION`];
      // Per-market volatility filter configs
      const envMinVolatilityPct = process.env[`STRATEGY_${marketKey}_MIN_VOLATILITY_PCT`];
      const envMaxVolatilityPct = process.env[`STRATEGY_${marketKey}_MAX_VOLATILITY_PCT`];
      // Per-market ADX filter configs
      const envMinAdx = process.env[`STRATEGY_${marketKey}_MIN_ADX`];
      const envMaxAdx = process.env[`STRATEGY_${marketKey}_MAX_ADX`];
      // Per-market ATR period (for stop calculations)
      const envAtrPeriod = process.env[`STRATEGY_${marketKey}_ATR_PERIOD`];

      // CLI override takes precedence over env file (to bypass dotenv override issue)
      const marketLeverage =
        options.cliMarketLeverage?.get(symbol) ??
        (envLev !== undefined && envLev !== "" ? parseFloat(envLev) : options.leverage);
      // Allow explicit 0 to force ATR-based stops
      const marketHardStop =
        envHardStopPct !== undefined && envHardStopPct !== ""
          ? parseFloat(envHardStopPct)
          : options.rsiHardStopPercent;
      const marketHardStopAtr =
        envHardStopAtr !== undefined && envHardStopAtr !== ""
          ? parseFloat(envHardStopAtr)
          : options.rsiHardStopAtr;
      // Per-market failure and target overrides (critical for optimized configs)
      const marketFailureLong = has(envFailureLong)
        ? parseFloat(envFailureLong)
        : options.rsiFailureLong;
      const marketFailureShort = has(envFailureShort)
        ? parseFloat(envFailureShort)
        : options.rsiFailureShort;
      // Priority: per-market override > global RSI_TARGET_LONG/SHORT > rsiTargetNeutral
      const marketTargetLong = has(envTargetLong)
        ? parseFloat(envTargetLong)
        : options.rsiTargetLong > 0
          ? options.rsiTargetLong
          : options.rsiTargetNeutral;
      const marketTargetShort = has(envTargetShort)
        ? parseFloat(envTargetShort)
        : options.rsiTargetShort > 0
          ? options.rsiTargetShort
          : options.rsiTargetNeutral;
      // Per-market entry timing overrides
      const marketEntryMaxBars = has(envEntryMaxBars)
        ? parseInt(envEntryMaxBars)
        : options.rsiEntryMaxBars;
      const marketEntryMaxDeviation = has(envEntryMaxDeviation)
        ? parseFloat(envEntryMaxDeviation)
        : options.rsiEntryMaxDeviation;
      // Per-market volatility filter overrides
      const globalMinVol = parseFloat(process.env.RSI_MIN_VOLATILITY_PCT || "0.2");
      const globalMaxVol = parseFloat(process.env.RSI_MAX_VOLATILITY_PCT || "5.0");
      const marketMinVolatilityPct = has(envMinVolatilityPct)
        ? parseFloat(envMinVolatilityPct)
        : globalMinVol;
      const marketMaxVolatilityPct = has(envMaxVolatilityPct)
        ? parseFloat(envMaxVolatilityPct)
        : globalMaxVol;
      // Per-market ADX filter overrides
      const globalMinAdx = parseFloat(process.env.RSI_MIN_ADX || "0");
      const globalMaxAdx = parseFloat(process.env.RSI_MAX_ADX || "100");
      const marketMinAdx = has(envMinAdx) ? parseFloat(envMinAdx) : globalMinAdx;
      const marketMaxAdx = has(envMaxAdx) ? parseFloat(envMaxAdx) : globalMaxAdx;
      // Per-market ATR period override
      const marketAtrPeriod = has(envAtrPeriod) ? parseInt(envAtrPeriod) : options.atrPeriod;

      // Per-market direction gates (ALLOW_LONGS / ALLOW_SHORTS)
      const envAllowLongs = process.env[`STRATEGY_${marketKey}_ALLOW_LONGS`];
      const envAllowShorts = process.env[`STRATEGY_${marketKey}_ALLOW_SHORTS`];
      const marketAllowLongs = has(envAllowLongs)
        ? envAllowLongs === "true" || envAllowLongs === "1"
        : options.allowLongs;
      const marketAllowShorts = has(envAllowShorts)
        ? envAllowShorts === "true" || envAllowShorts === "1"
        : options.allowShorts;

      perMarketLeverage.set(symbol, marketLeverage);
      perMarketHardStop.set(symbol, marketHardStop);
      // ATR-based stop multiplier per market (only affects behavior if HARD_STOP_PERCENT == 0)
      perMarketHardStopAtr.set(symbol, marketHardStopAtr);
      // Direction gates per market
      perMarketAllowLongs.set(symbol, marketAllowLongs);
      perMarketAllowShorts.set(symbol, marketAllowShorts);

      console.log(
        `   [${symbol}] RSI: overbought=${overboughtExtreme}→${overboughtRecovery}, leverage=${marketLeverage}x, hardStop=${marketHardStop}%/ATR=${marketHardStopAtr}x, failure=${marketFailureLong}/${marketFailureShort}${marketAllowLongs !== options.allowLongs || marketAllowShorts !== options.allowShorts ? `, dirs=${marketAllowLongs ? "L" : "-"}${marketAllowShorts ? "S" : "-"}` : ""}`
      );

      // Create strategy for this market (using per-market overrides)
      const strategyConfig = {
        market: `${symbol}-PERP`,
        quiet: true,
        rsiStrategy: {
          rsiPeriod: options.rsiPeriod,
          rsiUseSma: options.rsiUseSma, // true = SMA, false = Wilder's smoothed (TradingView default)
          rsiOversoldExtreme: oversoldExtreme,
          rsiOversoldRecovery: oversoldRecovery,
          rsiOverboughtExtreme: overboughtExtreme,
          rsiOverboughtRecovery: overboughtRecovery,
          rsiEntryMaxDeviation: marketEntryMaxDeviation,
          rsiEntryMaxBars: marketEntryMaxBars, // Max bars after extreme to enter
          rsiTargetNeutral: options.rsiTargetNeutral,
          // Per-market target overrides
          rsiTargetLong: marketTargetLong,
          rsiTargetShort: marketTargetShort,
          rsiPartialTargetLong: options.rsiPartialTargetLong,
          rsiPartialTargetShort: options.rsiPartialTargetShort,
          rsiPartialPercent: options.rsiPartialPercent,
          // Per-market failure exit overrides (critical for optimized configs)
          rsiFailureLong: marketFailureLong,
          rsiFailureShort: marketFailureShort,
          rsiTimeStopBars: options.rsiTimeStopBars,
          rsiHardStopEnabled: options.rsiHardStopEnabled,
          rsiHardStopAtr: marketHardStopAtr,
          rsiHardStopPercent: marketHardStop,
          atrPeriod: marketAtrPeriod,
          // Per-market volatility filter settings
          rsiMinVolatilityPct: marketMinVolatilityPct,
          rsiMaxVolatilityPct: marketMaxVolatilityPct,
          // Per-market ADX filter settings
          rsiMinAdx: marketMinAdx,
          rsiMaxAdx: marketMaxAdx,
        },
        // Circuit breaker settings (from CLI options to bypass dotenv override)
        maxConsecutiveLosses: options.circuitBreakerMaxLosses,
        circuitBreakerCooldownMs: options.circuitBreakerCooldownMs,
      };

      console.log(
        `   [${symbol}] Entry timing: maxBars=${marketEntryMaxBars}, maxDeviation=${marketEntryMaxDeviation}, atrPeriod=${marketAtrPeriod}`
      );
      const strategy = new RsiMeanReversionStrategy(strategyConfig);
      strategiesMap.set(symbol, strategy);
      strategyConfigsMap.set(symbol, strategyConfig);
    }

    if (candlesMap.size === 0) {
      console.error("❌ No candle data available for any market");
      process.exit(1);
    }

    // Prefetch historical funding rates from Drift (if enabled)
    // This uses actual hourly funding rates instead of static estimates
    const enableHistoricalFunding =
      process.env.DRIFT_ENABLE_FUNDING === "true" &&
      process.env.FEE_MODEL?.toLowerCase() === "drift" &&
      process.env.DRIFT_HISTORICAL_FUNDING !== "false";
    let fundingRateMaps = null;
    if (enableHistoricalFunding) {
      try {
        // Import cache stats for display
        const {
          getCacheStats,
          DRIFT_FUNDING_CACHE_ENABLED,
        } = require("../../utils/drift-historical");
        const cacheStats = getCacheStats();

        console.log("\n📊 DRIFT HISTORICAL FUNDING RATES");
        console.log("-".repeat(50));
        console.log(
          `   Cache: ${DRIFT_FUNDING_CACHE_ENABLED ? "enabled" : "disabled"}${cacheStats.fileCount > 0 ? ` (${cacheStats.fileCount} files, ${cacheStats.totalSizeMB}MB)` : ""}`
        );

        fundingRateMaps = await prefetchFundingRatesMultiMarket(
          options.symbols,
          startTime,
          endTime,
          {
            verbose: true,
            parallel: Math.max(1, Number(process.env.DRIFT_FUNDING_PREFETCH_PARALLEL) || 6),
          }
        );
      } catch (err) {
        console.warn(`   ⚠️  Failed to fetch historical funding rates: ${err.message}`);
        console.warn("   Falling back to estimated average funding rate");
      }
    }

    // Run unified multi-market simulation
    const isBotModel =
      String(options._traceModel || options.traceModel || "backtest").toLowerCase() === "bot";
    const simFn = isBotModel ? simulateBotRuntimeMultiMarket : simulateMultiMarketSharedCapital;
    result = simFn(strategiesMap, candlesMap, {
      initialCapital: options.initialCapital,
      leverage: options.leverage,
      positionSizePercent: options.positionSizePercent,
      enableCompounding: options.enableCompounding,
      debug: options.debug,
      allowLongs: options.allowLongs,
      allowShorts: options.allowShorts,
      maxPositions: options.maxPositions,
      // No-lookahead: multi-market tick simulation MUST use real 1m candles.
      oneMinCandlesMap,
      ticksByBarOpenTimeMap,
      ticksPerCandle:
        interval === "5m" && use1MinTicks ? TICKS_PER_5MIN_CANDLE : options.ticksPerCandle || 1,
      simulateTicks: interval === "5m" && use1MinTicks,
      rsiHardStopPercent: options.rsiHardStopPercent,
      rsiHardStopAtr: options.rsiHardStopAtr,
      perMarketLeverage,
      perMarketHardStop,
      perMarketHardStopAtr,
      perMarketAllowLongs,
      perMarketAllowShorts,
      minPositionSize: options.minPositionSize,
      maxPositionSize: options.maxPositionSize,
      // Advanced sizing methods
      positionSizingMethod: options.positionSizingMethod,
      riskPerTradePercent: options.riskPerTradePercent,
      kellyFraction: options.kellyFraction,
      volatilityScaleBase: options.volatilityScaleBase,
      qualitySizeMultMin: options.qualitySizeMultMin,
      qualitySizeMultMax: options.qualitySizeMultMax,
      // Trace + allocator controls
      _trace: options._trace,
      _traceModel: isBotModel ? "bot" : options._traceModel || "backtest",
      allocatorExploreProbability: options.allocatorExploreProbability,
      allocatorUseBotScoring: options.allocatorUseBotScoring,
      // Allocator-driven dynamic risk (size/leverage/stops based on signal quality)
      allocatorRiskEnabled: options.allocatorRiskEnabled,
      allocatorRiskNeutral: options.allocatorRiskNeutral,
      // Historical funding rate maps (from Drift API)
      fundingRateMaps,
      enableHistoricalFunding,
      // Margin/liquidation simulation
      enableLiquidationCheck: process.env.ENABLE_LIQUIDATION_CHECK !== "false",
    });

    // Convert to allResults format for printResults compatibility
    for (const [symbol, marketData] of result.marketResults.entries()) {
      allResults.push({
        symbol,
        trades: marketData.trades,
        totalPnL: marketData.totalPnL,
        realisedPnl: marketData.totalPnL,
        totalFees: marketData.totalFees,
        feeBreakdown: result.feeBreakdown,
        equitySeries: result.equitySeries,
        initialCapital: options.initialCapital,
        capitalStats: result.capitalStats,
        // Propagate liquidation stats so reporting works even if `result` is shadowed later.
        liquidationStats: result.liquidationStats || null,
        fundingStats: result.fundingStats || null,
      });
    }
  } // End of else block (multi-market)

  // IMPORTANT: "no trades" is a valid outcome for parameter sweeps.
  // Do NOT exit non-zero; still print + persist a JSON result so sweep scripts can score it as invalid.
  if (allResults.length === 0 || (result && result.trades && result.trades.length === 0)) {
    console.warn("⚠️  No trades generated");
  }

  // Print per-market results
  console.log("\n" + "=".repeat(80));
  console.log("                    PER-MARKET RESULTS");
  console.log("=".repeat(80));

  for (const result of allResults) {
    // Use totalPnlUsd which includes all fees (entry + exit + partials)
    const getPnl = (t) => t.totalPnlUsd ?? t.pnlUsd ?? t.pnl ?? 0;
    const wins = result.trades.filter((t) => getPnl(t) > 0).length;
    const losses = result.trades.filter((t) => getPnl(t) <= 0).length;
    const winRate = result.trades.length > 0 ? ((wins / result.trades.length) * 100).toFixed(1) : 0;
    const longTrades = result.trades.filter((t) => t.side === "long");
    const shortTrades = result.trades.filter((t) => t.side === "short");
    const longPnl = longTrades.reduce((sum, t) => sum + getPnl(t), 0);
    const shortPnl = shortTrades.reduce((sum, t) => sum + getPnl(t), 0);
    const longWins = longTrades.filter((t) => getPnl(t) > 0).length;
    const shortWins = shortTrades.filter((t) => getPnl(t) > 0).length;

    // Calculate fees per market
    const marketFees = result.totalPnL - (longPnl + shortPnl);
    const grossPnl = longPnl + shortPnl;

    // Show return based on per-market capital
    const marketReturn = (result.totalPnL / options.initialCapital) * 100;
    const finalEquityMarket =
      result.capitalStats?.finalEquity || options.initialCapital + result.totalPnL;
    console.log(`\n📊 ${result.symbol}`);
    console.log("-".repeat(40));
    console.log(`  Trades: ${result.trades.length} | Win Rate: ${winRate}%`);
    console.log(
      `  Net P&L: $${result.totalPnL >= 0 ? "+" : ""}${result.totalPnL.toFixed(2)} (${marketReturn >= 0 ? "+" : ""}${marketReturn.toFixed(1)}%)`
    );
    console.log(`  Ending Equity: $${finalEquityMarket.toFixed(2)}`);
    console.log(
      `  Longs: ${longTrades.length} ($${longPnl.toFixed(2)}) | Shorts: ${shortTrades.length} ($${shortPnl.toFixed(2)})`
    );
  }

  // Aggregate results
  const totalTrades = allResults.reduce((sum, r) => sum + r.trades.length, 0);
  const totalPnL = allResults.reduce((sum, r) => sum + r.totalPnL, 0);
  const totalFees = allResults.reduce((sum, r) => sum + r.totalFees, 0);
  const allTrades = allResults.flatMap((r) =>
    r.trades.map((t) => ({
      ...t,
      symbol: r.symbol,
      pnl: t.totalPnlUsd ?? t.pnlUsd ?? t.pnl ?? 0,
    }))
  );
  const totalWins = allTrades.filter((t) => t.pnl > 0).length;
  const totalLosses = allTrades.filter((t) => t.pnl <= 0).length;

  // Aggregate fee breakdown
  // For multi-market mode, all entries in allResults share the SAME feeBreakdown object (the global one),
  // so we must NOT sum across them (that would multiply by number of markets).
  // Use result.feeBreakdown directly for multi-market, or sum for single-market.
  const isMultiMarket = options.symbols.length > 1;
  const aggregateFees =
    isMultiMarket && result?.feeBreakdown
      ? {
          openFees: result.feeBreakdown.openFees || 0,
          closeFees: result.feeBreakdown.closeFees || 0,
          impactFees: result.feeBreakdown.impactFees || 0,
          swapFees: result.feeBreakdown.swapFees || 0,
          borrowFees: result.feeBreakdown.borrowFees || 0,
          fundingFees: result.feeBreakdown.fundingFees || 0,
          slippageUsd: result.feeBreakdown.slippageUsd || 0,
          slippageEntryUsd: result.feeBreakdown.slippageEntryUsd || 0,
          slippageExitUsd: result.feeBreakdown.slippageExitUsd || 0,
          liquidatorFees: result.feeBreakdown.liquidatorFees || 0,
          insuranceFees: result.feeBreakdown.insuranceFees || 0,
          txFees: result.feeBreakdown.txFees || 0,
          makerEntryStats: result.makerEntryStats || null,
          makerExitStats: result.makerExitStats || null,
        }
      : {
          openFees: allResults.reduce((sum, r) => sum + (r.feeBreakdown?.openFees || 0), 0),
          closeFees: allResults.reduce((sum, r) => sum + (r.feeBreakdown?.closeFees || 0), 0),
          impactFees: allResults.reduce((sum, r) => sum + (r.feeBreakdown?.impactFees || 0), 0),
          swapFees: allResults.reduce((sum, r) => sum + (r.feeBreakdown?.swapFees || 0), 0),
          borrowFees: allResults.reduce((sum, r) => sum + (r.feeBreakdown?.borrowFees || 0), 0),
          fundingFees: allResults.reduce((sum, r) => sum + (r.feeBreakdown?.fundingFees || 0), 0),
          slippageUsd: allResults.reduce((sum, r) => sum + (r.feeBreakdown?.slippageUsd || 0), 0),
          slippageEntryUsd: allResults.reduce(
            (sum, r) => sum + (r.feeBreakdown?.slippageEntryUsd || 0),
            0
          ),
          slippageExitUsd: allResults.reduce(
            (sum, r) => sum + (r.feeBreakdown?.slippageExitUsd || 0),
            0
          ),
          liquidatorFees: allResults.reduce(
            (sum, r) => sum + (r.feeBreakdown?.liquidatorFees || 0),
            0
          ),
          insuranceFees: allResults.reduce(
            (sum, r) => sum + (r.feeBreakdown?.insuranceFees || 0),
            0
          ),
          txFees: allResults.reduce((sum, r) => sum + (r.feeBreakdown?.txFees || 0), 0),
          makerEntryStats: allResults.find((r) => r.makerEntryStats)?.makerEntryStats || null,
          makerExitStats: allResults.find((r) => r.makerExitStats)?.makerExitStats || null,
        };

  // Combined summary
  // SHARED CAPITAL MODE: All markets share the same initial capital pool
  const numMarkets = allResults.length;
  const sharedCapital = options.initialCapital; // This is the TOTAL capital shared across all markets
  const finalEquity = result?.capitalStats?.finalEquity || sharedCapital + totalPnL;
  const totalReturn = (totalPnL / sharedCapital) * 100;
  const annualizedReturn = (totalReturn / options.days) * 365;
  const monthlyReturn = (totalReturn / options.days) * 30;

  console.log("\n" + "═".repeat(80));
  console.log("                       📊 PORTFOLIO PERFORMANCE SUMMARY");
  console.log("═".repeat(80));
  console.log(`\n  Markets:           ${options.symbols.join(", ")} (${numMarkets} markets)`);
  console.log(`  Period:            ${options.days} days`);
  console.log(
    `  Initial Capital:   $${sharedCapital.toLocaleString()} (SHARED across all markets)`
  );
  console.log(
    `  Final Equity:      $${finalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  );
  console.log("");
  console.log(
    `  💰 TOTAL RETURN:   ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(1)}% ($${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)})`
  );
  console.log(`  📅 Monthly Est:    ${monthlyReturn >= 0 ? "+" : ""}${monthlyReturn.toFixed(1)}%`);
  console.log(
    `  📈 Annualized:     ${annualizedReturn >= 0 ? "+" : ""}${annualizedReturn.toFixed(0)}%`
  );
  console.log("");
  console.log(`  Total Trades:      ${totalTrades}`);
  console.log(
    `  Win Rate:          ${totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0}%`
  );
  console.log(
    `  Avg P&L/Trade:     $${totalTrades > 0 ? (totalPnL / totalTrades).toFixed(2) : 0} (${totalTrades > 0 ? ((totalPnL / totalTrades / sharedCapital) * 100).toFixed(3) : 0}%)`
  );

  // Portfolio-level risk metrics (Max Drawdown and Sharpe)
  const portfolioEquitySeries = result?.equitySeries || [];
  const portfolioMaxDD = calculateMaxDrawdown(portfolioEquitySeries);
  const portfolioDailyReturns = tradesToDailyReturns(allTrades, sharedCapital);
  const portfolioSharpe =
    portfolioDailyReturns.length > 0 ? calculateSharpeRatio(portfolioDailyReturns) : 0;
  const portfolioSortino =
    portfolioDailyReturns.length > 0 ? calculateSortinoRatio(portfolioDailyReturns) : 0;
  console.log(`  Max Drawdown:      ${portfolioMaxDD.toFixed(2)}%`);
  console.log(`  Sharpe Ratio:      ${portfolioSharpe.toFixed(2)}`);

  // Portfolio-level profitability summary (for sweep/workflow parsers)
  const portfolioProfitFactor = computeProfitFactor(allTrades);
  const pfStr = Number.isFinite(portfolioProfitFactor)
    ? portfolioProfitFactor.toFixed(2)
    : portfolioProfitFactor === Infinity
      ? "∞"
      : "0.00";
  console.log(`  Profit Factor:     ${pfStr}`);
  const portfolioExpectedValue = totalTrades > 0 ? totalPnL / totalTrades : 0;
  console.log(
    `  Expected Value:    $${portfolioExpectedValue.toFixed(2)}/trade (${((portfolioExpectedValue / sharedCapital) * 100).toFixed(2)}%)`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // ROBUST METRICS (SQN-Based Scoring)
  // ───────────────────────────────────────────────────────────────────────────
  const { sqn, expectancy, tradeStdDev } = calculateSQN(allTrades);
  const expectancyPct = sharedCapital > 0 ? expectancy / sharedCapital : 0;
  const recoveryFactor = portfolioMaxDD > 0 ? totalReturn / portfolioMaxDD : 0;
  const { payoffRatio } = computePayoffRatio(allTrades);
  const winProb = totalTrades > 0 ? totalWins / totalTrades : 0;
  const kelly = payoffRatio > 0 ? (winProb * payoffRatio - (1 - winProb)) / payoffRatio : 0;
  const kellyPct = clamp(kelly, 0, 1) * 100;
  const { maxWinStreak, maxLoseStreak } = computeStreaks(allTrades);
  const tail = computeTailMetrics(allTrades, sharedCapital);
  const robust = computeRobustScoreV2(
    {
      sqn,
      sharpe: portfolioSharpe,
      recoveryFactor,
      maxDD: portfolioMaxDD,
      profitFactor: portfolioProfitFactor,
      trades: totalTrades,
      days: options.days,
      winRate: winProb,
      payoffRatio,
      pnlSkewness: tail.pnlSkewness,
      lossTailToAvgWin: tail.lossTailToAvgWin,
      worstTrade: tail.worstTrade,
      pnlConcentrationTop5: tail.pnlConcentrationTop5,
    },
    { days: options.days }
  );

  console.log(`\n📈 ROBUST METRICS (SQN-Based Scoring)`);
  console.log("-".repeat(40));
  console.log(`  SQN (System Quality): ${sqn.toFixed(2)} (${sqnRating(sqn)})`);
  console.log(`  Sharpe Ratio:         ${portfolioSharpe.toFixed(2)}`);
  console.log(`  Sortino Ratio:        ${portfolioSortino.toFixed(2)}`);
  console.log(
    `  Recovery Factor:      ${Number.isFinite(recoveryFactor) ? recoveryFactor.toFixed(2) : "0.00"}`
  );
  console.log(
    `  Expectancy:           $${expectancy.toFixed(2)} (${(expectancyPct * 100).toFixed(2)}%)`
  );
  console.log(`  Payoff Ratio:         ${payoffRatio.toFixed(2)}`);
  console.log(`  Kelly %:              ${kellyPct.toFixed(1)}%`);
  console.log(`  Win Streak:           ${maxWinStreak} | Lose Streak: ${maxLoseStreak}`);
  const skewLabel = tail.pnlSkewness > 0 ? "(positive tail ✅)" : "(negative tail ⚠️)";
  console.log(`  PnL Skewness:         ${tail.pnlSkewness.toFixed(2)} ${skewLabel}`);
  console.log("");
  console.log(`  🎯 Robust Score:      ${robust.score.toFixed(2)}`);
  if (robust.disqualified) {
    console.log(`  ⚠️  DISQUALIFIED:     ${robust.disqualifyReason}`);
  }
  console.log(
    `     (SQN-driven composite with Sharpe, RF, DD, PF, sample confidence, tail-risk penalties)`
  );

  // Store robust metrics for JSON output
  const robustSummary = {
    sqn,
    sqnRating: sqnRating(sqn),
    sharpe: portfolioSharpe,
    sortino: portfolioSortino,
    recoveryFactor,
    profitFactor: portfolioProfitFactor,
    expectancy,
    expectancyPct,
    payoffRatio,
    kellyPct,
    tradeStdDev,
    robustScore: robust.score,
    disqualified: robust.disqualified,
    disqualifyReason: robust.disqualifyReason,
    scoring: robust.components,
    // Tail metrics
    pnlSkewness: tail.pnlSkewness,
    pnlExcessKurtosis: tail.pnlExcessKurtosis,
    cvar95: tail.cvar95,
    worstTrade: tail.worstTrade,
    avgWin: tail.avgWin,
    avgLossAbs: tail.avgLoss,
    lossTailToAvgWin: tail.lossTailToAvgWin,
    pnlConcentrationTop5: tail.pnlConcentrationTop5,
  };

  // Circuit breaker stats (if enabled)
  const cbStats = result?.circuitBreakerStats;
  if (cbStats && cbStats.enabled) {
    // Calculate totals
    const totalActivations = cbStats.activationsByMarket
      ? Object.values(cbStats.activationsByMarket).reduce((sum, count) => sum + count, 0)
      : cbStats.triggeredCount || 0;
    const totalExpirations = cbStats.expirationsByMarket
      ? Object.values(cbStats.expirationsByMarket).reduce((sum, count) => sum + count, 0)
      : totalActivations; // Usually same as activations

    console.log(
      `  Circuit Breaker:   ${cbStats.triggeredCount} triggers, ${cbStats.skippedEntries} entries skipped, ${totalActivations} activations, ${totalExpirations} expirations (max ${cbStats.maxLosses} losses, ${Math.round(cbStats.cooldownMs / 60000)}min cooldown)`
    );

    // Show per-market details only in verbose mode
    if (
      options.verbose &&
      cbStats.activationsByMarket &&
      Object.keys(cbStats.activationsByMarket).length > 0
    ) {
      console.log("  ⚡ Per-market activations:");
      const activations = Object.entries(cbStats.activationsByMarket).sort((a, b) => b[1] - a[1]);
      const lines = [];
      for (let i = 0; i < activations.length; i += 4) {
        const chunk = activations.slice(i, i + 4);
        const line = chunk.map(([market, count]) => `${market}: ${count}`).join(", ");
        lines.push(`     ${line}`);
      }
      console.log(lines.join("\n"));
    }
    if (
      options.verbose &&
      cbStats.expirationsByMarket &&
      Object.keys(cbStats.expirationsByMarket).length > 0
    ) {
      console.log("  ✅ Per-market expirations:");
      const expirations = Object.entries(cbStats.expirationsByMarket).sort((a, b) => b[1] - a[1]);
      const lines = [];
      for (let i = 0; i < expirations.length; i += 4) {
        const chunk = expirations.slice(i, i + 4);
        const line = chunk.map(([market, count]) => `${market}: ${count}`).join(", ");
        lines.push(`     ${line}`);
      }
      console.log(lines.join("\n"));
    }
  }

  // Allocator stats (signal selection quality)
  const allocStats = result?.allocatorStats;
  if (allocStats && allocStats.totalSignalsGenerated > 0) {
    console.log("\n📊 ALLOCATOR STATS");
    console.log("-".repeat(50));
    console.log(`  Signals Generated:   ${allocStats.totalSignalsGenerated}`);
    console.log(
      `  Signals Accepted:    ${allocStats.totalSignalsAccepted} (${allocStats.acceptanceRate})`
    );
    console.log(
      `  Signals Rejected:    ${allocStats.totalSignalsRejected} (outranked by higher-scoring signals)`
    );
    if (allocStats.totalSignalsBlockedCB > 0) {
      console.log(
        `  Blocked (CB):        ${allocStats.totalSignalsBlockedCB} (circuit breaker cooldown)`
      );
    }
    if (allocStats.concurrentSignalTicks > 0) {
      console.log(
        `  Concurrent Ticks:    ${allocStats.concurrentSignalTicks} ticks with >1 signal competing`
      );
      console.log(`  Max Concurrent:      ${allocStats.maxConcurrentSignals} signals at once`);
      // Show histogram for concurrent signals
      const histEntries = Object.entries(allocStats.concurrentSignalHist || {}).sort(
        (a, b) => Number(a[0]) - Number(b[0])
      );
      if (histEntries.length > 0) {
        const histStr = histEntries.map(([cnt, occ]) => `${cnt}→${occ}x`).join(", ");
        console.log(`  Concurrent Hist:     ${histStr}`);
      }
    }
    // Per-market breakdown
    if (allocStats.byMarket && Object.keys(allocStats.byMarket).length > 0) {
      console.log("  Per-Market:");
      for (const [mkt, stats] of Object.entries(allocStats.byMarket)) {
        const acceptRate =
          stats.generated > 0 ? ((stats.accepted / stats.generated) * 100).toFixed(0) : 0;
        console.log(
          `    ${mkt}: ${stats.generated} gen, ${stats.accepted} accept (${acceptRate}%), ${stats.rejected} reject, ${stats.blockedCB} CB`
        );
      }
    }
  }

  // Fee breakdown - use actual fee config from environment
  const displayFeeCfg = buildFeeCfg();
  // Note: openFeeBps is the CONFIGURED rate (e.g., -0.25bps for maker)
  // Actual fees are a mix of maker (rebate) and taker (fee) based on fill simulation
  const hasMakerStats = aggregateFees.makerEntryStats?.attempts > 0;
  const openFeeLabel = hasMakerStats
    ? `maker ${displayFeeCfg.openFeeBps}bps + taker fallbacks`
    : `${displayFeeCfg.openFeeBps} bps`;
  const closeFeeLabel = hasMakerStats
    ? `maker ${displayFeeCfg.closeFeeBps}bps + taker exits`
    : `${displayFeeCfg.closeFeeBps} bps`;

  // Workflow/sweep mode: suppress verbose reporting blocks (keeps stdout fast/clean).
  // Keep the portfolio summary + robust metrics + "Results saved to" lines intact.
  const __origConsoleLog = console.log;
  const __suppressVerbose = options.minimalOutput;
  if (__suppressVerbose) console.log = () => {};
  try {
    // ============================================================
    // COMPREHENSIVE FEE & COST BREAKDOWN
    // ============================================================
    console.log("\n💰 COMPREHENSIVE COST BREAKDOWN");
    console.log("═".repeat(60));

    // Get liquidation + funding stats for this section
    const liquidationStats = result?.liquidationStats ||
      (allResults.length > 0 && allResults[0]?.liquidationStats) || {
        enabled: String(process.env.ENABLE_LIQUIDATION_CHECK || "").toLowerCase() !== "false",
        count: 0,
        totalLoss: 0,
        maintenanceMarginPct: Number(process.env.DRIFT_MAINTENANCE_MARGIN_PCT) || 5,
        note: "stats_unavailable_for_model",
      };
    const fundingStats =
      result?.fundingStats || (allResults.length > 0 && allResults[0]?.fundingStats) || null;
    const usedHistoricalFunding = !!fundingStats?.usedHistorical;

    // ── Section 1: Fee Model Configuration ──
    const stakingTierDisplay =
      displayFeeCfg.model === "drift" &&
      displayFeeCfg.stakingTier &&
      displayFeeCfg.stakingTier !== "rookie"
        ? `, ${displayFeeCfg.stakingTier} staking`
        : "";
    console.log(`\n┌─ FEE MODEL CONFIGURATION`);
    console.log(`│  Model:               ${displayFeeCfg.model.toUpperCase()}`);
    console.log(
      `│  Execution Mode:      ${displayFeeCfg.execMode}${displayFeeCfg.model === "drift" ? ` (${displayFeeCfg.tier} tier${stakingTierDisplay})` : ""}`
    );
    if (displayFeeCfg.model === "drift") {
      console.log(
        `│  Open Fee:            ${displayFeeCfg.openFeeBps >= 0 ? "" : "-"}${Math.abs(displayFeeCfg.openFeeBps)} bps${displayFeeCfg.openFeeBps < 0 ? " (rebate)" : ""}`
      );
      console.log(
        `│  Close Fee:           ${displayFeeCfg.closeFeeBps >= 0 ? "" : "-"}${Math.abs(displayFeeCfg.closeFeeBps)} bps${displayFeeCfg.closeFeeBps < 0 ? " (rebate)" : ""}`
      );
      console.log(
        `│  Taker Fee:           ${displayFeeCfg.takerFeeBps || 5} bps (fallback/emergency)`
      );
    } else {
      console.log(`│  Base Fee:            ${displayFeeCfg.openFeeBps || 10} bps`);
    }

    // ── Section 2: Trading Fees (Protocol Fees) ──
    console.log(`│`);
    console.log(`├─ TRADING FEES (Protocol)`);
    console.log(`│  Open Fees:           $${aggregateFees.openFees.toFixed(2)}  (${openFeeLabel})`);
    console.log(
      `│  Close Fees:          $${aggregateFees.closeFees.toFixed(2)}  (${closeFeeLabel})`
    );
    const tradingFeesSubtotal = (aggregateFees.openFees || 0) + (aggregateFees.closeFees || 0);
    console.log(`│  ─────────────────────`);
    console.log(`│  Subtotal:            $${tradingFeesSubtotal.toFixed(2)}`);

    // ── Section 3: Execution Costs (Slippage, Impact) ──
    console.log(`│`);
    console.log(`├─ EXECUTION COSTS`);
    if (displayFeeCfg.model === "jupiter") {
      console.log(
        `│  Price Impact:        $${aggregateFees.impactFees.toFixed(2)}  (quadratic AMM formula)`
      );
      console.log(
        `│  Swap Fees:           $${(aggregateFees.swapFees || 0).toFixed(2)}  (${SIMULATION_CONSTANTS.DEFAULT_SWAP_FEE_BPS} bps on collateral)`
      );
      const executionSubtotal = (aggregateFees.impactFees || 0) + (aggregateFees.swapFees || 0);
      console.log(`│  ─────────────────────`);
      console.log(`│  Subtotal:            $${executionSubtotal.toFixed(2)}`);
    } else if (displayFeeCfg.model === "drift") {
      console.log(`│  Price Impact:        $0.00  (limit orders, no AMM impact)`);
      console.log(`│  Swap Fees:           $0.00  (USDC margin, no swap needed)`);
      const slippageUsd = aggregateFees.slippageUsd || 0;
      const slippageEntryUsd = aggregateFees.slippageEntryUsd || 0;
      const slippageExitUsd = aggregateFees.slippageExitUsd || 0;
      const fixedSlip =
        process.env.ENABLE_FIXED_SLIPPAGE === "true" &&
        (Number(process.env.FIXED_SLIPPAGE_BPS) || 0) > 0;
      const dynSlip = process.env.ENABLE_DYNAMIC_SLIPPAGE === "true";
      const fixedMode = String(process.env.FIXED_SLIPPAGE_MODE || "")
        .toLowerCase()
        .trim();
      const fixedBps = Number(process.env.FIXED_SLIPPAGE_BPS) || 0;
      const fixedScalar = (() => {
        const s = Number(process.env.FIXED_SLIPPAGE_SCALAR);
        return Number.isFinite(s) && s > 0 ? s : 1;
      })();
      const hasBuckets = !!String(process.env.FIXED_SLIPPAGE_BPS_BUCKETS || "").trim();
      const slipModel = fixedSlip
        ? fixedMode === "by_size"
          ? `fixed by_size (fallback ${fixedBps} bps, scalar ${fixedScalar}${hasBuckets ? "" : ", buckets missing"})`
          : `fixed (${fixedBps} bps, scalar ${fixedScalar})`
        : dynSlip
          ? "dynamic"
          : "off";
      const modeNote =
        displayFeeCfg.execMode === "taker"
          ? "taker-only mode"
          : "maker mode (includes limit price offsets + taker slippage on fallbacks/stops)";
      // Helpful sanity metric: implied average slippage bps across all fills (entry+exit notional).
      // If FIXED_SLIPPAGE_MODE=by_size is active, this will typically be < FIXED_SLIPPAGE_BPS due to buckets+scalar.
      // NOTE: We cannot use `totalVolume` here because it's computed later in the Cost Analysis section.
      // Compute a local fill-notional sum from trades instead.
      const entryNotionalForSlippage = allTrades.reduce((sum, t) => {
        const entryPx = Number.isFinite(t?.entryFillPrice)
          ? t.entryFillPrice
          : Number.isFinite(t?.entryPrice)
            ? t.entryPrice
            : null;
        const entryNotional =
          Number.isFinite(t?.quantity) && Number.isFinite(entryPx)
            ? t.quantity * entryPx
            : Number.isFinite(Number(t?.sizeUsd))
              ? Number(t.sizeUsd)
              : 0;
        return sum + (Number.isFinite(entryNotional) ? entryNotional : 0);
      }, 0);

      const exitNotionalForSlippage = allTrades.reduce((sum, t) => {
        const exitPx = Number.isFinite(t?.exitFillPrice)
          ? t.exitFillPrice
          : Number.isFinite(t?.exitPrice)
            ? t.exitPrice
            : null;
        const exitNotional =
          Number.isFinite(t?.quantity) && Number.isFinite(exitPx) ? t.quantity * exitPx : 0;
        return sum + (Number.isFinite(exitNotional) ? exitNotional : 0);
      }, 0);
      const fillNotionalForSlippage = entryNotionalForSlippage + exitNotionalForSlippage;
      const avgEntryNotional =
        allTrades.length > 0 ? entryNotionalForSlippage / allTrades.length : 0;
      const avgExitNotional = allTrades.length > 0 ? exitNotionalForSlippage / allTrades.length : 0;
      const impliedSlippageBps =
        fillNotionalForSlippage > 0 ? (slippageUsd / fillNotionalForSlippage) * 10000 : 0;
      const impliedEntryBps =
        entryNotionalForSlippage > 0 ? (slippageEntryUsd / entryNotionalForSlippage) * 10000 : 0;
      const impliedExitBps =
        exitNotionalForSlippage > 0 ? (slippageExitUsd / exitNotionalForSlippage) * 10000 : 0;
      console.log(
        `│  Slippage:            $${slippageUsd.toFixed(2)}  (${slipModel}, ${modeNote})`
      );
      if (slippageUsd > 0) {
        console.log(
          `│    ├─ Implied:        ${impliedSlippageBps.toFixed(2)} bps (slippageUsd / fillNotional)`
        );
      }
      if (slippageUsd > 0) {
        console.log(
          `│    ├─ Entry Slippage: $${slippageEntryUsd.toFixed(2)}  (${impliedEntryBps.toFixed(2)} bps on entry notional)`
        );
        console.log(`│    │    └─ Avg Entry Notional: $${avgEntryNotional.toFixed(2)} per trade`);
        console.log(
          `│    └─ Exit Slippage:  $${slippageExitUsd.toFixed(2)}  (${impliedExitBps.toFixed(2)} bps on exit notional)`
        );
        console.log(`│         └─ Avg Exit Notional:  $${avgExitNotional.toFixed(2)} per trade`);
      }
      console.log(`│  ─────────────────────`);
      console.log(`│  Subtotal:            $${slippageUsd.toFixed(2)}`);
    }

    // ── Section 4: Carry Costs (Funding, Borrow) ──
    console.log(`│`);
    console.log(`├─ CARRY COSTS (Time-Based)`);
    const fundingFees = aggregateFees.fundingFees || 0;
    const borrowFees = aggregateFees.borrowFees || 0;

    if (displayFeeCfg.model === "drift") {
      const fundingEnabled = process.env.DRIFT_ENABLE_FUNDING === "true";
      const fundingRequested = !!fundingStats?.requestedHistorical;
      const marketsWithRecords = Number(fundingStats?.marketsWithRecords) || 0;
      const marketsRequested = Number(fundingStats?.marketsRequested) || 0;
      const fundingSource = usedHistoricalFunding
        ? `📈 historical Drift API (${marketsWithRecords}/${marketsRequested} mkts)`
        : fundingRequested
          ? `📊 estimated average (historical fetch returned 0 records)`
          : "📊 estimated average";

      // Break out paid vs received for clarity (fundingFees is signed net: +received, -paid)
      const fundingPaidGross = allTrades.reduce((sum, t) => {
        const v = Number(t?.fees?.fundingFee ?? 0);
        return sum + (Number.isFinite(v) && v < 0 ? -v : 0);
      }, 0);
      const fundingReceivedGross = allTrades.reduce((sum, t) => {
        const v = Number(t?.fees?.fundingFee ?? 0);
        return sum + (Number.isFinite(v) && v > 0 ? v : 0);
      }, 0);
      // Some sim paths track funding only in `feeBreakdown.fundingFees` (aggregate) and do not attach per-trade `fees.fundingFee`.
      // If we have a non-zero net but paid/received are both zero, fall back to net-only attribution for clarity.
      const hasPerTradeFunding = fundingPaidGross !== 0 || fundingReceivedGross !== 0;
      const fallbackPaid = !hasPerTradeFunding && fundingFees < 0 ? Math.abs(fundingFees) : 0;
      const fallbackReceived = !hasPerTradeFunding && fundingFees > 0 ? fundingFees : 0;

      if (fundingEnabled && fundingFees !== 0) {
        const fundingSign = fundingFees > 0 ? "+" : "-";
        const fundingLabel = fundingFees > 0 ? "net received" : "net paid";
        console.log(
          `│  Funding (net):       ${fundingSign}$${Math.abs(fundingFees).toFixed(2)}  (${fundingLabel})`
        );
        console.log(
          `│    ├─ Paid:           $${(hasPerTradeFunding ? fundingPaidGross : fallbackPaid).toFixed(2)}${hasPerTradeFunding ? "" : " (net-derived)"}`
        );
        console.log(
          `│    └─ Received:       $${(hasPerTradeFunding ? fundingReceivedGross : fallbackReceived).toFixed(2)}${hasPerTradeFunding ? "" : " (net-derived)"}`
        );
        console.log(`│    └─ Data Source:    ${fundingSource}`);
      } else if (fundingEnabled) {
        console.log(`│  Funding Fees:        $0.00  (positions held <1hr or rates neutral)`);
        console.log(`│    └─ Data Source:    ${fundingSource}`);
      } else {
        console.log(`│  Funding Fees:        $0.00  (disabled - set DRIFT_ENABLE_FUNDING=true)`);
      }
      console.log(`│  Borrow Fees:         N/A  (Drift uses funding, not borrow)`);
    } else {
      console.log(
        `│  Borrow Fees:         $${borrowFees.toFixed(2)}  (${SIMULATION_CONSTANTS.DEFAULT_BORROW_RATE_BPS} bps/hr × ${Math.round(SIMULATION_CONSTANTS.DEFAULT_POOL_UTILIZATION * 100)}% util)`
      );
      console.log(`│  Funding Fees:        N/A  (Jupiter uses borrow model)`);
    }
    const carrySubtotal = displayFeeCfg.model === "drift" ? -fundingFees : borrowFees;
    console.log(`│  ─────────────────────`);
    console.log(
      `│  Subtotal:            $${carrySubtotal.toFixed(2)}${fundingFees > 0 ? " (net received)" : ""}`
    );

    // ── Section 5: Network Costs ──
    console.log(`│`);
    console.log(`├─ NETWORK COSTS`);
    const txFees = aggregateFees.txFees || 0;
    const avgTxFeePerTrade = totalTrades > 0 ? txFees / totalTrades / 2 : 0; // /2 for entry+exit
    console.log(
      `│  Solana TX Fees:      $${txFees.toFixed(2)}  (~$${avgTxFeePerTrade.toFixed(4)}/tx × ${totalTrades * 2} txs)`
    );
    console.log(
      `│  Priority Fees:       Included (${SIMULATION_CONSTANTS.DEFAULT_PRIORITY_FEE_LAMPORTS} lamports)`
    );
    console.log(`│  ─────────────────────`);
    console.log(`│  Subtotal:            $${txFees.toFixed(2)}`);

    // ── Section 6: Liquidation Losses ──
    console.log(`│`);
    console.log(`├─ MARGIN & LIQUIDATION`);
    if (liquidationStats && liquidationStats.enabled) {
      if (liquidationStats.maintenanceMode) {
        const fb = Number(liquidationStats.fallbackMaintenanceMarginPct);
        const fbStr = Number.isFinite(fb) ? ` (fallback ${fb.toFixed(2)}%)` : "";
        console.log(`│  Maintenance Margin:  per-market + IMF${fbStr}  (Drift docs table)`);
      } else {
        console.log(`│  Maintenance Margin:  ${liquidationStats.maintenanceMarginPct}%`);
      }
      // Drift "other perp fees" that typically apply on liquidation events (liquidator + insurance)
      const liqOtherLiquidatorFees = aggregateFees.liquidatorFees || 0;
      const liqOtherInsuranceFees = aggregateFees.insuranceFees || 0;
      if (
        displayFeeCfg.model === "drift" &&
        (liqOtherLiquidatorFees !== 0 || liqOtherInsuranceFees !== 0)
      ) {
        console.log(
          `│  Liquidator Fee:      $${liqOtherLiquidatorFees.toFixed(2)}  (charged on liquidation)`
        ); // https://docs.drift.trade/trading/other-trading-fees
        console.log(
          `│  Insurance Fee:       $${liqOtherInsuranceFees.toFixed(2)}  (charged on liquidation)`
        ); // https://docs.drift.trade/trading/other-trading-fees
      }
      const partialCnt = Number(liquidationStats.partialCount) || 0;
      const partialNotional = Number(liquidationStats.partialNotionalUsd) || 0;
      const partialFees = Number(liquidationStats.partialFeesUsd) || 0;
      if (partialCnt > 0) {
        console.log(`│  Partial Liquidations:${partialCnt} event(s)`);
        console.log(`│    ├─ Notional Cut:   $${partialNotional.toFixed(2)}`);
        console.log(`│    └─ Fees Paid:      $${partialFees.toFixed(2)}`);
      }
      if (liquidationStats.count > 0) {
        console.log(`│  Liquidations:        ${liquidationStats.count} position(s) ⚠️`);
        console.log(
          `│  Liquidation Loss:    $${liquidationStats.totalLoss.toFixed(2)}  (100% collateral wiped)`
        );
        console.log(`│  ─────────────────────`);
        console.log(`│  ⚠️  ${liquidationStats.count} position(s) hit liq price before stop!`);
      } else {
        console.log(`│  Liquidations:        0 ✅`);
        console.log(`│  ─────────────────────`);
        console.log(`│  All stops triggered before margin breach`);
      }
    } else {
      console.log(`│  Liquidation Check:   Disabled (set ENABLE_LIQUIDATION_CHECK=true)`);
    }

    // ── Section 7: Total Summary ──
    console.log(`│`);
    console.log(`└─ TOTAL COSTS`);
    const liquidationLoss = liquidationStats?.totalLoss || 0;
    const slippageUsdTotal = aggregateFees.slippageUsd || 0;
    const grossCosts =
      tradingFeesSubtotal +
      (aggregateFees.impactFees || 0) +
      (aggregateFees.swapFees || 0) +
      Math.max(0, -fundingFees) +
      borrowFees +
      txFees +
      slippageUsdTotal +
      liquidationLoss;
    const fundingReceived = Math.max(0, fundingFees);
    // totalFees includes protocol fees + funding/borrow (as modeled) + tx fees + liquidation/insurance fees (if any)
    // slippageUsdTotal is NOT in totalFees (it’s embedded in fills), so we include it explicitly for "all-in costs".
    const netCosts = totalFees + slippageUsdTotal + liquidationLoss;

    console.log(`   Trading Fees:       $${tradingFeesSubtotal.toFixed(2)}`);
    if (displayFeeCfg.model === "jupiter") {
      console.log(
        `   Execution Costs:    $${((aggregateFees.impactFees || 0) + (aggregateFees.swapFees || 0)).toFixed(2)}`
      );
    } else if (displayFeeCfg.model === "drift") {
      console.log(
        `   Slippage:           $${slippageUsdTotal.toFixed(2)} (execution vs reference price; includes limit offsets + taker slippage)`
      );
    }
    if (displayFeeCfg.model === "drift" && fundingFees !== 0) {
      if (fundingFees > 0) {
        console.log(`   Funding Received:   +$${fundingFees.toFixed(2)}`);
      } else {
        console.log(`   Funding Paid:       $${Math.abs(fundingFees).toFixed(2)}`);
      }
    }
    if (displayFeeCfg.model === "jupiter" && borrowFees > 0) {
      console.log(`   Borrow Fees:        $${borrowFees.toFixed(2)}`);
    }
    console.log(`   Network Fees:       $${txFees.toFixed(2)}`);
    if (liquidationLoss > 0) {
      console.log(`   Liquidation Loss:   $${liquidationLoss.toFixed(2)} ⚠️`);
    }
    console.log(`   ═════════════════════`);
    console.log(
      `   TOTAL FEES:         $${totalFees.toFixed(2)}${displayFeeCfg.isRebate ? " (incl. rebates)" : ""}`
    );
    // Show slippage contribution if significant (slippage is already in Gross P&L via fill prices)
    if (slippageUsdTotal > 0.01) {
      console.log(
        `   + SLIPPAGE:         $${slippageUsdTotal.toFixed(2)} (already in Gross P&L via fill prices)`
      );
    }
    if (liquidationLoss > 0) {
      console.log(`   + LIQUIDATIONS:     $${liquidationLoss.toFixed(2)}`);
    }
    if (slippageUsdTotal > 0.01 || liquidationLoss > 0) {
      console.log(`   ═════════════════════`);
      console.log(`   ALL-IN COSTS:       $${netCosts.toFixed(2)}`);
    }

    // ── Section 8: Maker Fill Statistics ──
    if (aggregateFees.makerEntryStats && aggregateFees.makerEntryStats.attempts > 0) {
      const entryStats = aggregateFees.makerEntryStats;
      const exitStats = aggregateFees.makerExitStats || {
        attempts: 0,
        makerFills: 0,
        takerFallbacks: 0,
        noFills: 0,
      };

      const entryMakerPct =
        entryStats.attempts > 0
          ? ((entryStats.makerFills / entryStats.attempts) * 100).toFixed(1)
          : 0;
      const entryTakerPct =
        entryStats.attempts > 0
          ? ((entryStats.takerFallbacks / entryStats.attempts) * 100).toFixed(1)
          : 0;
      const entryNoFillPct =
        entryStats.attempts > 0 ? ((entryStats.noFills / entryStats.attempts) * 100).toFixed(1) : 0;

      const forcedTakerCount = exitStats.forcedTaker || 0;
      const totalExits = exitStats.attempts + forcedTakerCount;

      console.log(`\n📊 MAKER/TAKER EXECUTION ANALYSIS`);
      console.log("─".repeat(50));
      console.log(`  ┌─ ENTRIES`);
      console.log(`  │  Attempts:           ${entryStats.attempts}`);
      console.log(
        `  │  Maker Fills:        ${entryStats.makerFills} (${entryMakerPct}%) → rebate received`
      );
      console.log(
        `  │  Taker Fallbacks:    ${entryStats.takerFallbacks} (${entryTakerPct}%) → paid taker fee`
      );
      if (entryStats.noFills > 0) {
        console.log(
          `  │  No Fills:           ${entryStats.noFills} (${entryNoFillPct}%) → trade skipped`
        );
      }

      if (totalExits > 0) {
        const exitForcedPct = ((forcedTakerCount / totalExits) * 100).toFixed(1);
        const exitMakerPctTotal = ((exitStats.makerFills / totalExits) * 100).toFixed(1);
        const exitTakerPctTotal = ((exitStats.takerFallbacks / totalExits) * 100).toFixed(1);
        console.log(`  │`);
        console.log(`  └─ EXITS`);
        console.log(`     Total:             ${totalExits}`);
        console.log(
          `     Maker Fills:       ${exitStats.makerFills} (${exitMakerPctTotal}%) ← RSI targets`
        );
        console.log(
          `     Taker Fallbacks:   ${exitStats.takerFallbacks} (${exitTakerPctTotal}%) ← timeout`
        );
        console.log(
          `     Forced Taker:      ${forcedTakerCount} (${exitForcedPct}%) ← stops/liq/emergency`
        );
      }

      // Calculate actual vs theoretical fees
      const avgMakerRate =
        entryStats.attempts + totalExits > 0
          ? (entryStats.makerFills + exitStats.makerFills) / (entryStats.attempts + totalExits)
          : 0;
      const avgTakerRate = 1 - avgMakerRate;
      console.log(`  ─────────────────────────`);
      console.log(
        `  Realized Mix:         ${(avgMakerRate * 100).toFixed(1)}% maker / ${(avgTakerRate * 100).toFixed(1)}% taker`
      );
    }

    // Calculate notional volume.
    // For fee-rate comparisons (e.g. vs DefiLlama protocol fees), "volume" should be per-fill notional
    // because fees are charged on each fill. That means entry + exit are BOTH counted.
    let entryVolume = 0;
    let exitVolume = 0;
    for (const trade of allTrades) {
      const entryNotional =
        trade.sizeUsd ||
        (trade.quantity && trade.entryPrice ? trade.quantity * trade.entryPrice : 0);
      const exitNotional =
        trade.sizeUsdExit ||
        (trade.quantity && trade.exitPrice ? trade.quantity * trade.exitPrice : 0);
      entryVolume += entryNotional;
      exitVolume += exitNotional;
    }
    const totalFillVolume = entryVolume + exitVolume;

    // If we can't calculate from trades, fall back to estimated per-fill volume
    let totalVolume = totalFillVolume;
    if (totalVolume === 0) {
      // Estimate: notional per trade leg (entry) * 2 legs
      const estimatedNotionalPerTrade = options.positionSize * (options.leverage || 1);
      totalVolume = totalTrades * estimatedNotionalPerTrade * 2;
      entryVolume = totalTrades * estimatedNotionalPerTrade;
      exitVolume = totalTrades * estimatedNotionalPerTrade;
    }

    const feePercent = totalVolume > 0 ? (totalFees / totalVolume) * 100 : 0;
    const allInCostUsdInclSlippage = totalFees + slippageUsdTotal;
    const allInCostPctInclSlippage =
      totalVolume > 0 ? (allInCostUsdInclSlippage / totalVolume) * 100 : 0;
    // Split fees into protocol fees vs carry (funding/borrow) vs network, so comparisons are meaningful.
    // DefiLlama "fees" are protocol/user fees; they do NOT include funding transfers.
    const openCloseFees = (aggregateFees.openFees || 0) + (aggregateFees.closeFees || 0);
    const protocolFees =
      openCloseFees + (aggregateFees.impactFees || 0) + (aggregateFees.swapFees || 0);
    // Funding is a transfer between longs/shorts; positive means received (i.e. negative cost).
    const netFundingCost = -(aggregateFees.fundingFees || 0);
    const carryCosts = (aggregateFees.borrowFees || 0) + netFundingCost;
    const networkFees = aggregateFees.txFees || 0;

    // ── Section 9: Cost Analysis Metrics ──
    console.log(`\n📈 COST ANALYSIS METRICS`);
    console.log("─".repeat(50));

    const protocolFeePct = totalVolume > 0 ? (protocolFees / totalVolume) * 100 : 0;
    const protocolFeeBps = totalVolume > 0 ? (protocolFees / totalVolume) * 10000 : 0;
    const allInFeeBps = totalVolume > 0 ? (totalFees / totalVolume) * 10000 : 0;
    const allInCostBpsInclSlippage =
      totalVolume > 0 ? (allInCostUsdInclSlippage / totalVolume) * 10000 : 0;
    const openCloseFeesBps = totalVolume > 0 ? (openCloseFees / totalVolume) * 10000 : 0;

    // Fee component breakdown for validation
    const openFeesBps = totalVolume > 0 ? ((aggregateFees.openFees || 0) / totalVolume) * 10000 : 0;
    const closeFeesBps =
      totalVolume > 0 ? ((aggregateFees.closeFees || 0) / totalVolume) * 10000 : 0;
    const impactFeesBps =
      totalVolume > 0 ? ((aggregateFees.impactFees || 0) / totalVolume) * 10000 : 0;
    const swapFeesBps = totalVolume > 0 ? ((aggregateFees.swapFees || 0) / totalVolume) * 10000 : 0;
    const borrowFeesBps =
      totalVolume > 0 ? ((aggregateFees.borrowFees || 0) / totalVolume) * 10000 : 0;
    const txFeesBps = totalVolume > 0 ? ((aggregateFees.txFees || 0) / totalVolume) * 10000 : 0;

    console.log(`  ┌─ VOLUME ANALYSIS`);
    console.log(`  │  Entry Volume:       $${entryVolume.toFixed(0)}`);
    console.log(`  │  Exit Volume:        $${exitVolume.toFixed(0)}`);
    console.log(`  │  Total Fill Volume:  $${totalVolume.toFixed(0)}`);
    console.log(`  │  Avg Trade Size:     $${(entryVolume / Math.max(1, totalTrades)).toFixed(0)}`);
    console.log(`  │`);
    console.log(`  ├─ COST RATIOS (vs Volume)`);
    console.log(
      `  │  Protocol Fees:      ${protocolFeeBps.toFixed(2)} bps (${protocolFeePct.toFixed(3)}%)`
    );
    console.log(`  │    ├─ Open Fees:     ${openFeesBps.toFixed(2)} bps`);
    console.log(`  │    ├─ Close Fees:    ${closeFeesBps.toFixed(2)} bps`);
    console.log(`  │    ├─ Impact Fees:   ${impactFeesBps.toFixed(2)} bps`);
    console.log(`  │    └─ Swap Fees:     ${swapFeesBps.toFixed(2)} bps`);
    console.log(
      `  │  All-in (fees):      ${allInFeeBps.toFixed(2)} bps (${feePercent.toFixed(3)}%)`
    );
    console.log(`  │    ├─ Protocol:      ${protocolFeeBps.toFixed(2)} bps`);
    console.log(`  │    ├─ Borrow:        ${borrowFeesBps.toFixed(2)} bps`);
    console.log(`  │    └─ Network:       ${txFeesBps.toFixed(2)} bps`);
    console.log(
      `  │  All-in (+slippage): ${allInCostBpsInclSlippage.toFixed(2)} bps (${allInCostPctInclSlippage.toFixed(3)}%)`
    );
    console.log(`  │  Open+Close:         ${openCloseFeesBps.toFixed(2)} bps`);

    // Show expected vs actual for maker execution
    if (displayFeeCfg.model === "drift" && aggregateFees.makerEntryStats?.attempts > 0) {
      const entryStats = aggregateFees.makerEntryStats;
      const exitStats = aggregateFees.makerExitStats || {
        attempts: 0,
        makerFills: 0,
        takerFallbacks: 0,
        forcedTaker: 0,
      };

      const entryMakerRate =
        entryStats.attempts > 0 ? entryStats.makerFills / entryStats.attempts : 0;
      const exitsTotal = (exitStats.attempts || 0) + (exitStats.forcedTaker || 0);
      const exitMakerRate = exitsTotal > 0 ? exitStats.makerFills / exitsTotal : 0;

      const takerFeeBps = Number.isFinite(displayFeeCfg.takerFeeBps)
        ? displayFeeCfg.takerFeeBps
        : 5;
      const makerRebateBps = Math.abs(Number(displayFeeCfg.openFeeBps) || 0.25);

      // Calculate expected fees based on actual maker/taker mix
      const expectedOpenBps = (1 - entryMakerRate) * takerFeeBps - entryMakerRate * makerRebateBps;
      const expectedCloseBps = (1 - exitMakerRate) * takerFeeBps - exitMakerRate * makerRebateBps;
      const expectedProtocolFeesUsd =
        (entryVolume * expectedOpenBps) / 10000 + (exitVolume * expectedCloseBps) / 10000;
      const expectedPerFillBps =
        totalVolume > 0 ? (expectedProtocolFeesUsd / totalVolume) * 10000 : 0;

      console.log(`  │  Expected from Mix:  ${expectedPerFillBps.toFixed(2)} bps (theoretical)`);
      const feeEfficiency =
        expectedPerFillBps !== 0 ? (openCloseFeesBps / expectedPerFillBps) * 100 : 100;
      console.log(`  │  Fee Efficiency:     ${feeEfficiency.toFixed(0)}% of expected`);
    }

    console.log(`  │`);
    console.log(`  ├─ PER-TRADE METRICS`);
    const avgFeePerTrade = totalTrades > 0 ? totalFees / totalTrades : 0;
    const avgNotionalPerTrade = totalTrades > 0 ? entryVolume / totalTrades : 0;
    const feeAsPercOfAvgTrade =
      avgNotionalPerTrade > 0 ? (avgFeePerTrade / avgNotionalPerTrade) * 100 : 0;
    console.log(
      `  │  Avg Fee/Trade:      $${avgFeePerTrade.toFixed(2)} (${feeAsPercOfAvgTrade.toFixed(2)}% of size)`
    );
    console.log(`  │  Avg Notional/Trade: $${avgNotionalPerTrade.toFixed(0)}`);

    // Calculate breakeven required return
    const breakevenReturnPct =
      avgNotionalPerTrade > 0 ? (avgFeePerTrade / avgNotionalPerTrade) * 100 : 0;
    console.log(`  │  Breakeven Return:   ${breakevenReturnPct.toFixed(3)}% per trade`);

    console.log(`  │`);
    console.log(`  └─ PROFITABILITY IMPACT`);
    const grossPnL = allTrades.reduce(
      (acc, t) => acc + (t.grossPnl || (t.pnl || 0) + (t.exitFee || 0) + (t.entryFee || 0)),
      0
    );
    const netPnL = totalPnL; // Use totalPnL which is available in main function scope
    const feeImpact = grossPnL > 0 ? ((grossPnL - netPnL) / grossPnL) * 100 : 0;
    console.log(`     Gross P&L:         $${grossPnL.toFixed(2)}`);
    console.log(`     Total Fees:        $${totalFees.toFixed(2)}`);
    console.log(`     Net P&L:           $${netPnL.toFixed(2)}`);
    console.log(
      `     Fee Impact:        ${feeImpact.toFixed(1)}% of gross profits consumed by fees`
    );

    // Add leverage-aware fee analysis for Jupiter
    if (displayFeeCfg.model === "jupiter" && totalTrades > 0) {
      const avgLeverage = allTrades.reduce((sum, t) => sum + (t.leverage || 1), 0) / totalTrades;
      const avgCollateralPerTrade = avgNotionalPerTrade / Math.max(1, avgLeverage);
      const feesAsPctOfCapital = avgLeverage > 0 ? (allInFeeBps / 10000) * avgLeverage * 100 : 0;
      console.log(`     Avg Leverage:      ${avgLeverage.toFixed(1)}x`);
      console.log(
        `     Fees vs Capital:   ${feesAsPctOfCapital.toFixed(2)}% (fees scale with notional, capital = notional/leverage)`
      );
      if (avgLeverage < 3 && feeImpact > 50) {
        console.log(
          `     ⚠️  At low leverage (${avgLeverage.toFixed(1)}x), fees as % of capital are ${(((avgLeverage * allInFeeBps) / 10000) * 100).toFixed(2)}%`
        );
        console.log(
          `        Consider: higher leverage or larger position sizes to reduce fee impact`
        );
      }
    }

    // Compare to different fee scenarios
    if (displayFeeCfg.model === "drift") {
      console.log(`\n💡 FEE SCENARIO COMPARISON`);
      console.log("─".repeat(50));

      // Calculate what fees would be in different scenarios
      const purelyTakerFees = (totalVolume * (displayFeeCfg.takerFeeBps || 5)) / 10000;
      const purelyMakerFees = (totalVolume * -(Math.abs(displayFeeCfg.openFeeBps) || 0.25)) / 10000;

      console.log(
        `  If 100% Taker:       $${purelyTakerFees.toFixed(2)} (${((purelyTakerFees / totalVolume) * 10000).toFixed(2)} bps)`
      );
      console.log(
        `  If 100% Maker:       $${purelyMakerFees.toFixed(2)} (${((purelyMakerFees / totalVolume) * 10000).toFixed(2)} bps) ← rebate`
      );
      console.log(
        `  Actual (realized):   $${openCloseFees.toFixed(2)} (${openCloseFeesBps.toFixed(2)} bps)`
      );

      const savingsVsTaker = purelyTakerFees - openCloseFees;
      if (savingsVsTaker > 0) {
        console.log(`  Maker Savings:       $${savingsVsTaker.toFixed(2)} saved vs pure taker`);
      } else {
        console.log(
          `  Maker Benefit:       $${Math.abs(savingsVsTaker).toFixed(2)} extra cost vs pure taker`
        );
      }
    }

    // Sanity check: fee breakdown should approximately match totalFees
    const breakdownSum =
      (aggregateFees.openFees || 0) +
      (aggregateFees.closeFees || 0) +
      (aggregateFees.impactFees || 0) +
      (aggregateFees.swapFees || 0) +
      (aggregateFees.borrowFees || 0) +
      -(aggregateFees.fundingFees || 0) +
      (aggregateFees.txFees || 0);
    const feeDiscrepancy = Math.abs(breakdownSum - totalFees);
    if (feeDiscrepancy > 1 && feeDiscrepancy / Math.max(1, totalFees) > 0.01) {
      console.log(
        `\n  ⚠️  Fee breakdown discrepancy: $${breakdownSum.toFixed(2)} vs total $${totalFees.toFixed(2)} (diff: $${feeDiscrepancy.toFixed(2)})`
      );
    }

    // Validation: For Jupiter, expected total should be ~14 bps (6 bps open + 6 bps close + swap/impact)
    if (displayFeeCfg.model === "jupiter" && totalVolume > 0) {
      const expectedOpenCloseBps =
        (displayFeeCfg.openFeeBps || 6) + (displayFeeCfg.closeFeeBps || 6);
      const actualOpenCloseBps = openCloseFeesBps;
      const expectedTotalBps = expectedOpenCloseBps + swapFeesBps + impactFeesBps; // ~14 bps target
      const deviation = Math.abs(actualOpenCloseBps - expectedOpenCloseBps);
      if (deviation > 1) {
        console.log(`\n  ⚠️  Jupiter fee validation:`);
        console.log(
          `      Expected open+close: ${expectedOpenCloseBps.toFixed(2)} bps (${displayFeeCfg.openFeeBps || 6} + ${displayFeeCfg.closeFeeBps || 6})`
        );
        console.log(`      Actual open+close:  ${actualOpenCloseBps.toFixed(2)} bps`);
        console.log(`      Deviation:          ${deviation.toFixed(2)} bps`);
      }
      // Expected: 6 open + 6 close + ~2 swap (at typical leverage) + minimal impact = ~14 bps
      if (protocolFeeBps < 10 || protocolFeeBps > 18) {
        console.log(
          `\n  ⚠️  Jupiter total protocol fees (${protocolFeeBps.toFixed(2)} bps) outside expected range (10-18 bps)`
        );
        console.log(`      Expected ~14 bps total (6 open + 6 close + ~2 swap/impact)`);
        console.log(
          `      Breakdown: Open=${openFeesBps.toFixed(2)} Close=${closeFeesBps.toFixed(2)} Swap=${swapFeesBps.toFixed(2)} Impact=${impactFeesBps.toFixed(2)}`
        );
      }

      // Check fee-to-revenue ratio at low leverage
      if (grossPnL > 0 && feeImpact > 50) {
        console.log(
          `\n  ⚠️  High fee impact (${feeImpact.toFixed(1)}%) - fees consuming >50% of gross profits`
        );
        console.log(
          `      This is normal at low leverage where fees scale with notional but capital is less`
        );
        console.log(
          `      Consider: higher leverage, larger position sizes, or lower frequency trading`
        );
      }
    }

    // By exit reason across all markets
    const byReason = {};
    for (const trade of allTrades) {
      const reason = trade.exitReason || "unknown";
      if (!byReason[reason]) byReason[reason] = { count: 0, pnl: 0, wins: 0 };
      byReason[reason].count++;
      byReason[reason].pnl += trade.pnl;
      if (trade.pnl > 0) byReason[reason].wins++;
    }

    console.log("\n🚪 EXIT REASONS (All Markets)");
    console.log("-".repeat(50));
    for (const [reason, data] of Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)) {
      let icon = "❓";
      if (reason.includes("target")) icon = "✅";
      else if (reason.includes("time")) icon = "⏰";
      else if (reason.includes("max_loss") || reason.includes("failure")) icon = "🛑";
      else if (reason.includes("hard_stop")) icon = "⛔";
      else if (reason.includes("liquidation")) icon = "💀";
      else if (reason.includes("partial")) icon = "📊";
      console.log(
        `  ${icon} ${reason.padEnd(25)} ${data.count} trades | Win: ${((data.wins / data.count) * 100).toFixed(0)}% | P&L: $${data.pnl.toFixed(2)}`
      );
    }

    // Position sizing stats
    console.log("\n📐 POSITION SIZING STATS");
    console.log("-".repeat(50));
    console.log(`  Sizing Method:       ${options.positionSizingMethod}`);
    console.log(`  Size Percent:        ${options.positionSizePercent}%`);
    console.log(`  Shared Capital:      $${sharedCapital}`);
    console.log(
      `  Initial Position:    $${((sharedCapital * options.positionSizePercent) / 100).toFixed(0)} (${options.positionSizePercent}% collateral)`
    );
    console.log(`  Leverage:            ${options.leverage}x`);
    console.log(
      `  Initial Notional:    $${(((sharedCapital * options.positionSizePercent) / 100) * options.leverage).toFixed(0)}`
    );
    console.log(`  Compounding:         ${options.enableCompounding ? "ENABLED" : "DISABLED"}`);
    console.log(`  Max Positions:       ${options.maxPositions} (across all markets)`);
    const totalEntryNotionalUsdForStats = allTrades.reduce(
      (acc, t) => acc + (Number(t.sizeUsd) || 0),
      0
    );
    console.log(
      `  Total Volume:        $${totalEntryNotionalUsdForStats.toFixed(0)} (entry-side notional)`
    );

    // Capital validation stats - calculate from equity series
    const concurrencyStats = result?.capitalStats || {};
    const peakEquity = Number.isFinite(concurrencyStats.maxEquity)
      ? concurrencyStats.maxEquity
      : finalEquity;
    const troughEquity = Number.isFinite(concurrencyStats.minEquity)
      ? concurrencyStats.minEquity
      : sharedCapital;
    const totalViolations = Number.isFinite(concurrencyStats.capitalViolations)
      ? concurrencyStats.capitalViolations
      : 0;

    console.log("\n💵 CAPITAL VALIDATION");
    console.log("-".repeat(50));
    console.log(`  Peak Equity:         $${peakEquity.toFixed(2)}`);
    console.log(`  Min Equity:          $${troughEquity.toFixed(2)}`);
    console.log(
      `  Capital Rule Hits:   ${totalViolations === 0 ? "✅ NONE - all entries within available capital" : `⚠️  ${totalViolations} sizing clamps triggered`}`
    );

    // Concurrent position stats (from multi-market result)
    if (concurrencyStats.maxConcurrentPositions !== undefined) {
      console.log(
        `  Max Concurrent Pos:  ${concurrencyStats.maxConcurrentPositions} (limit: ${options.maxPositions})`
      );
      console.log(
        `  Max Collateral Used: $${(concurrencyStats.maxCollateralInUse || 0).toFixed(2)} (initial: $${options.initialCapital})`
      );

      // Calculate average concurrent positions
      const positionCounts = concurrencyStats.concurrentPositionCounts || [];
      if (positionCounts.length > 0) {
        const avgPositions = positionCounts.reduce((a, b) => a + b, 0) / positionCounts.length;
        const positionsWithTrades = positionCounts.filter((c) => c > 0);
        const pctTimeWithTrades = (
          (positionsWithTrades.length / positionCounts.length) *
          100
        ).toFixed(1);
        console.log(
          `  Avg Concurrent Pos:  ${avgPositions.toFixed(2)} | Time in Trade: ${pctTimeWithTrades}%`
        );
      }
    }

    // Trade statistics
    const lossingTrades = allTrades.filter((t) => t.pnl < 0);
    const winningTrades = allTrades.filter((t) => t.pnl > 0);
    const avgWin =
      winningTrades.length > 0
        ? winningTrades.reduce((s, t) => s + t.pnl, 0) / winningTrades.length
        : 0;
    const avgLoss =
      lossingTrades.length > 0
        ? lossingTrades.reduce((s, t) => s + t.pnl, 0) / lossingTrades.length
        : 0;
    const maxLoss = lossingTrades.length > 0 ? Math.min(...lossingTrades.map((t) => t.pnl)) : 0;
    const maxWin = winningTrades.length > 0 ? Math.max(...winningTrades.map((t) => t.pnl)) : 0;
    const profitFactor = Math.abs(
      winningTrades.reduce((s, t) => s + t.pnl, 0) /
        (lossingTrades.reduce((s, t) => s + t.pnl, 0) || 1)
    );
    const expectedValue =
      totalTrades > 0
        ? (totalWins / totalTrades) * avgWin + (totalLosses / totalTrades) * avgLoss
        : 0;

    console.log("\n📊 TRADE STATISTICS");
    console.log("-".repeat(50));
    console.log(
      `  Winners:     ${winningTrades.length} (${((winningTrades.length / totalTrades) * 100).toFixed(0)}%) | Avg: +$${avgWin.toFixed(2)} | Best: +$${maxWin.toFixed(2)}`
    );
    console.log(
      `  Losers:      ${lossingTrades.length} (${((lossingTrades.length / totalTrades) * 100).toFixed(0)}%) | Avg: $${avgLoss.toFixed(2)} | Worst: $${maxLoss.toFixed(2)}`
    );
    console.log(`  Profit Factor:       ${profitFactor.toFixed(2)}`);
    console.log(
      `  Win/Loss Ratio:      ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "N/A"}`
    );
    console.log(
      `  Expected Value:      $${expectedValue.toFixed(2)}/trade (${((expectedValue / options.initialCapital) * 100).toFixed(2)}%)`
    );

    const formatTs = (ts) => {
      if (!Number.isFinite(ts)) return "n/a";
      const d = new Date(ts);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const hh = String(d.getUTCHours()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd} ${hh}:00Z`;
    };
    const formatTradeRow = (t, idx) => {
      const collateral =
        Number.isFinite(t.pnlPct) && Number.isFinite(t.collateral)
          ? t.collateral
          : Number.isFinite(t.collateral)
            ? t.collateral
            : Number.isFinite(t.positionSizeUsed)
              ? t.positionSizeUsed
              : Number.isFinite(t.sizeUsd) && Number.isFinite(t.leverage) && t.leverage > 0
                ? t.sizeUsd / t.leverage
                : null;

      const pnlPct = Number.isFinite(t.pnlPct)
        ? t.pnlPct.toFixed(2)
        : Number.isFinite(collateral) && collateral > 0
          ? ((t.pnl / collateral) * 100).toFixed(2)
          : ((t.pnl / options.initialCapital) * 100).toFixed(2);
      const rsiStr = t.exitRsi !== null && t.exitRsi !== undefined ? t.exitRsi.toFixed(1) : "N/A";
      const balanceStr =
        t.balanceAfterClose !== null && t.balanceAfterClose !== undefined
          ? `$${t.balanceAfterClose.toFixed(0)}`
          : "N/A";
      const entryTs = formatTs(t.openTime || t.entryTime).padEnd(16);
      const exitTs = formatTs(t.exitTime).padEnd(16);
      const entryPx = Number.isFinite(t.entryPrice)
        ? t.entryPrice.toFixed(2).padStart(9)
        : "    n/a ";
      const exitPx = Number.isFinite(t.exitPrice) ? t.exitPrice.toFixed(2).padStart(9) : "    n/a ";
      const tradeNo = String(idx + 1).padStart(3);
      return (
        `${tradeNo} ${(t.symbol || "N/A").padEnd(5)} ${(t.side || "N/A").padEnd(5)} $${t.pnl.toFixed(2).padStart(8)} ${pnlPct.padStart(7)}% ` +
        `${rsiStr.padStart(6)} ${(t.exitReason || "unknown").padEnd(18)} ${balanceStr.padStart(12)} ` +
        `${entryTs}→${exitTs}  ${entryPx}→${exitPx}`
      );
    };

    // Show only top 10 worst trades
    const worstTrades = lossingTrades.sort((a, b) => a.pnl - b.pnl).slice(0, 10);
    if (worstTrades.length > 0) {
      console.log(`\n🔴 TOP ${worstTrades.length} WORST TRADES`);
      console.log("-".repeat(140));
      worstTrades.forEach((t, i) => {
        console.log(`  ${formatTradeRow(t, i)}`);
      });
    }

    // Show only top 10 best trades
    const bestTrades = winningTrades.sort((a, b) => b.pnl - a.pnl).slice(0, 10);
    if (bestTrades.length > 0) {
      console.log(`\n🟢 TOP ${bestTrades.length} BEST TRADES`);
      console.log("-".repeat(140));
      bestTrades.forEach((t, i) => {
        console.log(`  ${formatTradeRow(t, i)}`);
      });
    }

    // Trade Duration Distribution
    const tradeDurations = allTrades
      .filter((t) => t.openTime && t.exitTime && t.exitTime > t.openTime)
      .map((t) => (t.exitTime - t.openTime) / 60000); // Duration in minutes

    if (tradeDurations.length > 0) {
      // Calculate duration statistics
      const sortedDurations = [...tradeDurations].sort((a, b) => a - b);
      const minDuration = sortedDurations[0];
      const maxDuration = sortedDurations[sortedDurations.length - 1];
      const avgDuration = tradeDurations.reduce((a, b) => a + b, 0) / tradeDurations.length;
      const medianDuration = sortedDurations[Math.floor(sortedDurations.length / 2)];
      const p25Duration = sortedDurations[Math.floor(sortedDurations.length * 0.25)];
      const p75Duration = sortedDurations[Math.floor(sortedDurations.length * 0.75)];
      const p90Duration = sortedDurations[Math.floor(sortedDurations.length * 0.9)];

      // Create duration buckets
      const buckets = {
        "<5m": 0,
        "5-15m": 0,
        "15-30m": 0,
        "30m-1h": 0,
        "1-2h": 0,
        "2-4h": 0,
        "4-8h": 0,
        "8-24h": 0,
        ">24h": 0,
      };

      for (const d of tradeDurations) {
        if (d < 5) buckets["<5m"]++;
        else if (d < 15) buckets["5-15m"]++;
        else if (d < 30) buckets["15-30m"]++;
        else if (d < 60) buckets["30m-1h"]++;
        else if (d < 120) buckets["1-2h"]++;
        else if (d < 240) buckets["2-4h"]++;
        else if (d < 480) buckets["4-8h"]++;
        else if (d < 1440) buckets["8-24h"]++;
        else buckets[">24h"]++;
      }

      // Format duration display
      const formatDuration = (mins) => {
        if (mins < 60) return `${mins.toFixed(1)}m`;
        if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
        return `${(mins / 1440).toFixed(1)}d`;
      };

      console.log("\n⏱️  TRADE DURATION DISTRIBUTION");
      console.log("-".repeat(50));
      console.log(
        `  Min:     ${formatDuration(minDuration).padStart(8)} | Max: ${formatDuration(maxDuration)}`
      );
      console.log(
        `  Avg:     ${formatDuration(avgDuration).padStart(8)} | Median: ${formatDuration(medianDuration)}`
      );
      console.log(
        `  P25:     ${formatDuration(p25Duration).padStart(8)} | P75: ${formatDuration(p75Duration)} | P90: ${formatDuration(p90Duration)}`
      );
      console.log("");

      // Find max count for histogram scaling
      const maxCount = Math.max(...Object.values(buckets));
      const barWidth = 20;

      console.log("  Duration Distribution Histogram:");
      for (const [label, count] of Object.entries(buckets)) {
        const pct = ((count / tradeDurations.length) * 100).toFixed(1);
        const barLen = maxCount > 0 ? Math.round((count / maxCount) * barWidth) : 0;
        const bar = "█".repeat(barLen) + "░".repeat(barWidth - barLen);
        console.log(
          `    ${label.padEnd(7)} ${bar} ${String(count).padStart(4)} (${pct.padStart(5)}%)`
        );
      }
    }

    // Save combined results
    const outputDir = path.join(__dirname, "../../results/json");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFile = path.join(
      outputDir,
      `rsi-backtest-${options.symbols.join("-")}-${options.days}d-${Date.now()}.json`
    );
    const jsonPayload = {
      config: {
        symbols: options.symbols,
        days: options.days,
        startTime,
        endTime,
        interval: options.interval,
        use1MinTicks: options.use1MinTicks !== false,
        aggregation: options.aggregation || "aligned",
        positionSize: options.positionSize,
        leverage: options.leverage,
        rsiPeriod: options.rsiPeriod,
        rsiUseSma: options.rsiUseSma,
        rsiRequireProfitForTarget: process.env.RSI_REQUIRE_PROFIT_FOR_TARGET === "true",
        rsiOversoldExtreme: options.rsiOversoldExtreme,
        rsiOversoldRecovery: options.rsiOversoldRecovery,
        rsiOverboughtExtreme: options.rsiOverboughtExtreme,
        rsiOverboughtRecovery: options.rsiOverboughtRecovery,
        rsiTargetNeutral: options.rsiTargetNeutral,
        rsiTargetLong: options.rsiTargetLong,
        rsiTargetShort: options.rsiTargetShort,
        rsiEntryMaxBars: options.rsiEntryMaxBars,
        rsiEntryMaxDeviation: options.rsiEntryMaxDeviation,
        rsiFailureLong: options.rsiFailureLong,
        rsiFailureShort: options.rsiFailureShort,
        rsiTimeStopBars: options.rsiTimeStopBars,
        rsiHardStopEnabled: options.rsiHardStopEnabled,
        rsiHardStopPercent: options.rsiHardStopPercent,
        rsiHardStopAtr: options.rsiHardStopAtr,
        atrPeriod: options.atrPeriod,
      },
      summary: {
        totalTrades,
        totalWins,
        totalLosses,
        winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
        totalPnL,
        totalFees,
        maxDrawdown: portfolioMaxDD,
        sharpe: portfolioSharpe,
        ...(typeof robustSummary === "object" && robustSummary ? robustSummary : {}),
      },
      ...(options.minimalOutput
        ? {}
        : {
            byMarket: allResults.map((r) => ({
              symbol: r.symbol,
              trades: r.trades.length,
              pnl: r.totalPnL,
              fees: r.totalFees,
            })),
            byReason,
            allocatorStats: allocStats || null,
            circuitBreakerStats: cbStats || null,
            liquidationStats: liquidationStats || null,
            trades: allTrades,
          }),
    };
    fs.writeFileSync(outputFile, JSON.stringify(jsonPayload, null, 2));

    if (__suppressVerbose) console.log = __origConsoleLog;
    console.log(`\n📁 Results saved to: ${outputFile}`);

    // In workflow/sweep mode we skip optional deep analysis steps to keep runs fast.
    if (options.minimalOutput) return;

    // ============================================================
    // RSI FAILURE GRID SWEEP (optional)
    // ============================================================
    if (
      options.rsiFailureGridSweep &&
      options.symbols.length > 1 &&
      candlesMapForRobustness &&
      strategyConfigsMapForRobustness
    ) {
      try {
        // Ensure we have ticks map for accurate tick simulation. If missing, build from 1m candles.
        let ticksMap = ticksByBarOpenTimeMapForRobustness;
        if (!ticksMap) {
          ticksMap = new Map();
          if (oneMinCandlesMapForRobustness) {
            for (const [sym, oneMin] of oneMinCandlesMapForRobustness.entries()) {
              if (oneMin && oneMin.length > 0)
                ticksMap.set(sym, buildTicksByBarOpenTimeFrom1m(oneMin));
            }
          }
        }

        const sweep = runRsiFailureGridSweepMultiMarket({
          options,
          candlesMap: candlesMapForRobustness,
          strategyConfigsMap: strategyConfigsMapForRobustness,
          perMarketLeverage: perMarketLeverageForRobustness,
          perMarketHardStop: perMarketHardStopForRobustness,
          perMarketHardStopAtr: perMarketHardStopAtrForRobustness,
          oneMinCandlesMap: oneMinCandlesMapForRobustness,
          ticksByBarOpenTimeMap: ticksMap,
          startTime,
          endTime,
        });

        const sweepFile = path.join(
          outputDir,
          `rsi-failure-grid-${options.symbols.join("-")}-${options.days}d-${Date.now()}.json`
        );
        fs.writeFileSync(sweepFile, JSON.stringify(sweep, null, 2));
        console.log(`\n📁 Failure grid saved to: ${sweepFile}`);
      } catch (err) {
        console.warn(`⚠️  RSI failure grid sweep failed: ${err.message}`);
      }
    }

    // Save trace (optional)
    if (
      options.trace &&
      options._trace &&
      options._trace.events &&
      options._trace.events.length > 0
    ) {
      if (!fs.existsSync(traceOutputDir)) fs.mkdirSync(traceOutputDir, { recursive: true });
      const tracePath = options._trace.write(traceOutputFile);
      if (tracePath) {
        console.log(`📎 Trace saved to: ${tracePath}`);
      }
    }

    // ============================================================
    // STATISTICAL ROBUSTNESS TESTING
    // ============================================================
    // Parse parameter robustness configuration
    const robustnessConfig = {
      enableJitter: process.env.ROBUST_JITTER !== "0" && process.env.ROBUST_JITTER !== "false", // Default ON (light jitter)
      enableHeatmap: process.env.ROBUST_HEATMAP === "1" || process.env.ROBUST_HEATMAP === "true", // Default OFF
      enableBootstrap:
        process.env.ROBUST_BOOTSTRAP === "1" || process.env.ROBUST_BOOTSTRAP === "true", // Default OFF
      enableWalkForward:
        process.env.ROBUST_WALK_FORWARD === "1" || process.env.ROBUST_WALK_FORWARD === "true", // Default OFF
    };

    // Run robustness tests if enabled
    let jitterResult = null;
    let bootstrapResult = null;
    let heatmapResult = null;

    // Prepare original result for robustness tests
    const originalResult = {
      trades: allTrades,
      realisedPnl: totalPnL,
      totalPnL: totalPnL,
      totalFees: totalFees,
      equitySeries:
        result?.equitySeries || (allResults.length > 0 ? allResults[0].equitySeries : []),
      initialCapital: options.initialCapital,
    };

    // Run jitter tests (default ON)
    if (robustnessConfig.enableJitter) {
      try {
        jitterResult = runJitterTest(
          originalResult,
          options,
          candlesMapForRobustness,
          strategyConfigsMapForRobustness,
          options.symbols.length > 1,
          perMarketLeverageForRobustness,
          perMarketHardStopForRobustness,
          perMarketHardStopAtrForRobustness,
          oneMinCandlesMapForRobustness
        );
      } catch (err) {
        console.warn(`⚠️  Jitter test failed: ${err.message}`);
      }
    }

    // Run walk-forward analysis (default OFF)
    let walkForwardResult = null;
    if (
      robustnessConfig.enableWalkForward &&
      candlesMapForRobustness &&
      strategyConfigsMapForRobustness
    ) {
      try {
        const wfConfig = {
          trainDays: parseInt(process.env.WF_TRAIN_DAYS || "60"),
          testDays: parseInt(process.env.WF_TEST_DAYS || "30"),
          stepDays: parseInt(process.env.WF_STEP_DAYS || "30"),
          mode: process.env.WF_MODE || "rolling", // 'rolling' or 'anchored'
          optimizeParams: process.env.WF_OPTIMIZE === "1" || process.env.WF_OPTIMIZE === "true",
        };
        walkForwardResult = await runWalkForwardAnalysis(
          options,
          candlesMapForRobustness,
          strategyConfigsMapForRobustness,
          perMarketLeverageForRobustness,
          perMarketHardStopForRobustness,
          perMarketHardStopAtrForRobustness,
          startTime,
          endTime,
          wfConfig,
          oneMinCandlesMapForRobustness
        );
      } catch (err) {
        console.warn(`⚠️  Walk-forward analysis failed: ${err.message}`);
      }
    }

    // Run sensitivity heatmap (default OFF)
    if (
      robustnessConfig.enableHeatmap &&
      candlesMapForRobustness &&
      strategyConfigsMapForRobustness
    ) {
      try {
        console.log("\n🔄 Running sensitivity heatmap analysis...");
        heatmapResult = generateSensitivityHeatmap(
          options,
          candlesMapForRobustness,
          strategyConfigsMapForRobustness,
          options.symbols.length > 1,
          perMarketLeverageForRobustness,
          perMarketHardStopForRobustness,
          perMarketHardStopAtrForRobustness,
          oneMinCandlesMapForRobustness
        );
      } catch (err) {
        console.warn(`⚠️  Heatmap generation failed: ${err.message}`);
      }
    }

    // Run bootstrap CI (default OFF)
    if (
      robustnessConfig.enableBootstrap &&
      allTrades.length > 0 &&
      result?.equitySeries &&
      result.equitySeries.length > 0
    ) {
      try {
        bootstrapResult = runBootstrapCI(
          allTrades,
          result.equitySeries,
          options.initialCapital,
          options.days,
          1000 // Use 1000 iterations for faster execution (can be increased via env var)
        );
      } catch (err) {
        console.warn(`⚠️  Bootstrap CI failed: ${err.message}`);
      }
    }

    // Print robustness results
    if (
      robustnessConfig.enableJitter ||
      robustnessConfig.enableBootstrap ||
      robustnessConfig.enableHeatmap ||
      robustnessConfig.enableWalkForward
    ) {
      printRobustnessResults({
        jitterResult,
        bootstrapResult,
        heatmapResult,
        walkForwardResult,
        robustnessConfig,
        originalResult,
        formatUsd,
        formatPct,
      });

      // Persist robustness results into the main output JSON (so sweep scripts can rank stability).
      // NOTE: This intentionally stores only the lightweight objects returned by the robustness helpers.
      // Heatmaps can be large; only enabled when explicitly requested.
      try {
        const existing = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        existing.robustness = {
          config: robustnessConfig,
          jitter: jitterResult || null,
          bootstrap: bootstrapResult || null,
          heatmap: heatmapResult || null,
          walkForward: walkForwardResult || null,
        };
        fs.writeFileSync(outputFile, JSON.stringify(existing, null, 2));
      } catch (err) {
        console.warn(`⚠️  Failed to persist robustness results to JSON: ${err.message}`);
      }
    }
  } finally {
    if (__suppressVerbose) console.log = __origConsoleLog;
  }

  console.log("\n✅ Backtest complete!\n");
}

module.exports = {
  // Event model spec + tooling
  BOT_RUNTIME_EVENT_MODEL,
  BOT_RUNTIME_EXIT_PRECEDENCE,
  createTraceCollector,
  diffTraceModels,

  // Simulation primitives (for parity tests)
  simulateRsiMeanReversion,
  simulateMultiMarketSharedCapital,
  simulateBotRuntimeSingleMarket,
  simulateBotRuntimeMultiMarket,

  // Workflow/sweep integration helpers
  parseArgs,
  prefetchSingleMarketData,
  runBacktestForSymbol,
  summarizeRsiBacktestForWorkflow,

  // Shared helpers
  intervalToMs,
  generateTickPrices,
};

// Run (only when executed directly)
if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Backtest failed:", err);
    process.exit(1);
  });
}
