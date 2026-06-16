#!/usr/bin/env node

/**
 * Ichimoku Cloud Breakout Strategy Backtest
 *
 * Designed to mirror bot runtime sequencing for 15m bars with 15s tick simulation.
 *
 * Usage:
 *   node scripts/backtest/backtest-ichimoku-cloud.js [options]
 *
 * Memory Optimization:
 *   For long backtests (e.g., 360 days with walk-forward analysis), increase Node.js heap size:
 *   node --max-old-space-size=8192 scripts/backtest/backtest-ichimoku-cloud.js --days=360
 *   Or with expose-gc for manual garbage collection:
 *   node --max-old-space-size=8192 --expose-gc scripts/backtest/backtest-ichimoku-cloud.js --days=360
 *
 * Options:
 *   --days=N             Number of days to backtest (default: 30)
 *   --symbol=SYMBOL      Trading symbol (default: SOL)
 *   --positionSize=N     Position size in USD (default: 1000)
 *   --disabledHoursUtc=H Comma-separated UTC hours to disable entries (e.g. "13,14")
 *   --allowedHoursUtc=H  Comma-separated UTC hours to allow entries (overrides disabled)
 *   --debug              Enable debug logging
 *   --verbose            Enable verbose logging
 */

// Load strategy-specific env file FIRST with override to ensure Ichimoku config takes precedence
// Path must be absolute for dotenv to find it reliably
const envPath = require("path");
const envFile = process.env.ENV_FILE || envPath.join(__dirname, "..", "..", ".env.ichimoku");
require("dotenv").config({ path: envFile, override: true });
if (require.main === module) console.log(`[ENV] Loaded from ${envFile}`);

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// NOTE: env already loaded above via ENV_FILE

// Import the Ichimoku Cloud Breakout Strategy
const IchimokuCloudBreakoutStrategy = require("../../ichimoku-cloud-breakout-strategy");

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
} = require("../../backtest");

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
    notes: "If a discrete 15m bar completes, call strategy.update() with completed bar OHLCV",
  },
  {
    step: 3,
    name: "intra_bar_recalc",
    notes:
      "Update last bar with rolling window OHLCV via recalculateLastBar(); indicators may change intra-bar",
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
      "Evaluate exits each tick; execute at tick price. Precedence: hard stop > ATR trail > bar-based exits",
  },
];

// Explicit exit precedence used by the bot loop (highest priority first).
const BOT_RUNTIME_EXIT_PRECEDENCE = [
  "ichimoku_hard_stop_percent",
  "ichimoku_hard_stop_atr",
  "ichimoku_atr_trail",
  "ichimoku_time_stop",
  "ichimoku_rsi_exit",
  "ichimoku_macd_exit",
  "ichimoku_kijun_break",
  "ichimoku_tenkan_kijun_cross",
  "ichimoku_cloud_reentry",
  "ichimoku_cloud_flip",
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
      adx: ev.adx ?? null,
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
// HARD STOP HELPERS (match strategy hard-stop semantics)
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

  // Strategy behavior: percent takes precedence; ATR used only when percent==0.
  if (Number.isFinite(hardStopPercent) && hardStopPercent > 0) {
    const dist = (entryPrice * (hardStopPercent / 100)) / lev;
    return Number.isFinite(dist) && dist > 0 ? dist : null;
  }

  if (Number.isFinite(atr) && atr > 0 && Number.isFinite(hardStopAtrMult) && hardStopAtrMult > 0) {
    const dist = atr * hardStopAtrMult; // not leverage-adjusted (matches strategy)
    return Number.isFinite(dist) && dist > 0 ? dist : null;
  }

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
const { buildFeeCfg } = require("../../backtest/utils/fee-config");
const { parseLimitOrderConfig } = require("../../backtest/utils/drift-limit-config");
const { getOtherPerpFees } = require("../../backtest/utils/drift-other-fees");
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
} = require("../../backtest/utils/market-microstructure");

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
 * - ichimoku_hard_stop_percent / ichimoku_hard_stop_atr: Hard stop loss hit
 * - ichimoku_atr_trail: ATR trailing stop hit
 * - max_loss_cap: Maximum loss reached - emergency
 * - circuit_breaker_active: Circuit breaker triggered
 * - end_of_backtest: Force close at end
 * - liquidation: Position liquidated
 *
 * MAKER (can try maker first with fallback):
 * - ichimoku_time_stop: Time-based stop
 * - ichimoku_rsi_exit / ichimoku_macd_exit: Momentum-based exits
 * - ichimoku_kijun_break / ichimoku_tenkan_kijun_cross: Line exits
 * - ichimoku_cloud_reentry / ichimoku_cloud_flip: Cloud exits
 */
const EXIT_REASON_EXEC_MODE = {
  // Taker exits (immediate)
  ichimoku_hard_stop_percent: "taker",
  ichimoku_hard_stop_atr: "taker",
  ichimoku_atr_trail: "taker",
  max_loss_cap: "taker",
  circuit_breaker_active: "taker",
  end_of_backtest: "taker",
  liquidation: "taker",
  stop_loss: "taker",
  hard_stop: "taker",

  // Maker exits (can try maker first)
  ichimoku_time_stop: "maker",
  ichimoku_rsi_exit: "maker",
  ichimoku_macd_exit: "maker",
  ichimoku_kijun_break: "maker",
  ichimoku_tenkan_kijun_cross: "maker",
  ichimoku_cloud_reentry: "maker",
  ichimoku_cloud_flip: "maker",
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
  // If the overall mode is taker, do not "upgrade" certain reasons to maker.
  // Reason-based maker routing only makes sense when execMode=maker (and maker fill sim is enabled).
  if (String(defaultMode || "").toLowerCase() !== "maker") return "taker";
  if (!reason) return "maker";
  const normalized = String(reason).toLowerCase().trim();

  // Check direct match first
  if (EXIT_REASON_EXEC_MODE[normalized]) {
    return EXIT_REASON_EXEC_MODE[normalized];
  }

  // Check for partial matches (e.g., 'ichimoku_hard_stop_percent' → 'taker')
  if (normalized.includes("hard_stop") || normalized.includes("hard_time")) return "taker";
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
  ticks,
  tickTimestamps,
  startTickIndex = 0,
  tickIntervalMs = TICK_INTERVAL_MS,
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
      const fillTs =
        Array.isArray(tickTimestamps) && Number.isFinite(tickTimestamps[startTickIndex])
          ? tickTimestamps[startTickIndex]
          : null;
      return {
        execMode: "maker",
        fillPrice: limitPrice,
        limitPrice,
        outcome: "maker_fill",
        reason: "fixed_ratio",
        fillIndex: startTickIndex,
        fillTs,
      };
    }
    if (cfg.fallbackToTaker) {
      return {
        execMode: "taker",
        fillPrice: refPrice,
        limitPrice,
        outcome: "taker_fallback",
        reason: "fixed_ratio",
        fillIndex: startTickIndex,
        fillTs:
          Array.isArray(tickTimestamps) && Number.isFinite(tickTimestamps[startTickIndex])
            ? tickTimestamps[startTickIndex]
            : null,
      };
    }
    return {
      execMode: null,
      fillPrice: null,
      limitPrice,
      outcome: "no_fill",
      reason: "fixed_ratio",
      fillIndex: null,
      fillTs: null,
    };
  }

  // If the entry limit is marketable (would cross the book), it will NOT be a maker/post-only fill.
  // In production post-only would reject; in simulation treat as immediate taker.
  const isMarketable =
    side === "long"
      ? limitPrice >= refPrice // buying at/above market
      : limitPrice <= refPrice; // selling at/below market
  if (isMarketable) {
    const fillTs =
      Array.isArray(tickTimestamps) && Number.isFinite(tickTimestamps[startTickIndex])
        ? tickTimestamps[startTickIndex]
        : null;
    return {
      execMode: "taker",
      fillPrice: refPrice,
      limitPrice,
      outcome: "taker_fallback",
      reason: "marketable_limit",
      fillIndex: startTickIndex,
      fillTs,
    };
  }

  // Fill probability for maker entries (queue position etc.).
  const getMakerFillProb = () => {
    const perMarketRate = Number(process.env[`MAKER_ENTRY_FILL_RATE_${marketKey}`]);
    if (Number.isFinite(perMarketRate)) return perMarketRate;
    const globalRate = Number(process.env.MAKER_ENTRY_FILL_RATE);
    return Number.isFinite(globalRate) ? globalRate : 0.85;
  };

  const fallbackAfterMs = Number.isFinite(cfg.fallbackAfterMs)
    ? cfg.fallbackAfterMs
    : Number.isFinite(cfg.entryTimeoutMs)
      ? cfg.entryTimeoutMs
      : 45_000;
  const waitMs = cfg.fallbackToTaker
    ? fallbackAfterMs
    : Number(cfg.entryTimeoutMs || fallbackAfterMs);

  // Tick-aware simulation (preferred; avoids candle-high/low look-ahead)
  if (Array.isArray(ticks) && ticks.length > 0) {
    const start = Math.max(0, Math.min(startTickIndex, ticks.length - 1));
    const ticksToWait = Math.max(1, Math.ceil(waitMs / Math.max(1, tickIntervalMs)));
    const end = Math.min(ticks.length - 1, start + ticksToWait);

    const getTickPx = (i) => {
      const t = ticks[i];
      const px = typeof t === "number" ? t : Number(t?.price);
      return Number.isFinite(px) ? px : null;
    };

    let crossIdx = null;
    if (side === "long") {
      for (let i = start; i <= end; i++) {
        const px = getTickPx(i);
        if (px !== null && px <= limitPrice) {
          crossIdx = i;
          break;
        }
      }
    } else {
      for (let i = start; i <= end; i++) {
        const px = getTickPx(i);
        if (px !== null && px >= limitPrice) {
          crossIdx = i;
          break;
        }
      }
    }

    const fallbackIdx = end;
    const fallbackPx = (() => {
      const px = getTickPx(fallbackIdx);
      return px !== null ? px : refPrice;
    })();
    const fallbackTs =
      Array.isArray(tickTimestamps) && Number.isFinite(tickTimestamps[fallbackIdx])
        ? tickTimestamps[fallbackIdx]
        : null;

    if (crossIdx !== null) {
      const fillProb = getMakerFillProb();
      const priceInt = Math.floor(refPrice * 1e6) + crossIdx;
      const salt = marketKey.length * 17 + (side === "long" ? 3 : 7);
      const rand = ((priceInt + salt) % 100) / 100;
      const crossTs =
        Array.isArray(tickTimestamps) && Number.isFinite(tickTimestamps[crossIdx])
          ? tickTimestamps[crossIdx]
          : null;

      if (rand < fillProb) {
        return {
          execMode: "maker",
          fillPrice: limitPrice,
          limitPrice,
          outcome: "maker_fill",
          fillIndex: crossIdx,
          fillTs: crossTs,
        };
      }

      // Price crossed but we didn't get filled (queue position). Fallback at the end of the window.
      if (cfg.fallbackToTaker) {
        return {
          execMode: "taker",
          fillPrice: fallbackPx,
          limitPrice,
          outcome: "taker_fallback",
          reason: "queue_position",
          fillIndex: fallbackIdx,
          fillTs: fallbackTs,
        };
      }
      return {
        execMode: null,
        fillPrice: null,
        limitPrice,
        outcome: "no_fill",
        reason: "queue_position",
        fillIndex: null,
        fillTs: null,
      };
    }

    // Not crossed within window → taker fallback (or no fill).
    if (cfg.fallbackToTaker) {
      return {
        execMode: "taker",
        fillPrice: fallbackPx,
        limitPrice,
        outcome: "taker_fallback",
        reason: "timeout",
        fillIndex: fallbackIdx,
        fillTs: fallbackTs,
      };
    }
    return {
      execMode: null,
      fillPrice: null,
      limitPrice,
      outcome: "no_fill",
      reason: "timeout",
      fillIndex: null,
      fillTs: null,
    };
  }

  // Bar-level fallback (no ticks): candle crossing. NOTE: this is optimistic (coarse).
  const crossed =
    side === "long"
      ? Number.isFinite(candle?.low) && candle.low <= limitPrice
      : Number.isFinite(candle?.high) && candle.high >= limitPrice;
  if (crossed) {
    const fillProb = getMakerFillProb();
    const priceInt = Math.floor(refPrice * 1e6);
    const salt = marketKey.length * 17 + (side === "long" ? 3 : 7);
    const rand = ((priceInt + salt) % 100) / 100;
    if (rand < fillProb) {
      return { execMode: "maker", fillPrice: limitPrice, limitPrice, outcome: "maker_fill" };
    }
    if (cfg.fallbackToTaker) {
      return {
        execMode: "taker",
        fillPrice: refPrice,
        limitPrice,
        outcome: "taker_fallback",
        reason: "queue_position",
      };
    }
  }

  if (cfg.fallbackToTaker) {
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
  const microJitterBps = (baseLatency / (cfg.intervalMs || BAR_INTERVAL_MS)) * volBps;
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
    entryAdx: null, // Will be set by caller
    entryAtr: null, // Will be set by caller (for ATR hard stops)
    openTime: ts,
    openBarIndex: null, // Will be set by caller
    sizeUsd,
    quantity: qty,
    leverage: lev,
    collateral,
    liquidationPrice,
    tookPartial: false,
    fills: [],
  };
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
  // Prefer *net* PnL when available. In this backtest:
  // - pnlUsd can exclude entry fees (entry fees are charged upfront).
  // - totalPnlUsd is intended to be the net after entry+exit fees (and any funding/borrow adjustments included in net calc).
  const p = Number(trade?.totalPnlUsd ?? trade?.pnlUsd ?? trade?.pnl ?? trade?.totalPnl ?? 0);
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

  // Hard disqualification: max drawdown above threshold (env override supported).
  const envMaxDd = Number(process.env.ROBUST_MAX_DD_PCT);
  const maxDrawdownThreshold = Number.isFinite(options.maxDrawdownPct)
    ? options.maxDrawdownPct
    : Number.isFinite(envMaxDd) && envMaxDd > 0
      ? envMaxDd
      : 20;
  const isDisqualified = ddPct > maxDrawdownThreshold;
  const disqualifyReason = isDisqualified
    ? `maxDrawdown ${ddPct.toFixed(2)}% > ${maxDrawdownThreshold}%`
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
  return map[interval] || BAR_INTERVAL_MS;
}

// Binance symbol mapping (futures format)
function getBinanceSymbol(symbol) {
  const symbolUpper = String(symbol || "").toUpperCase();
  const binanceMap = {
    SOL: "SOLUSDT",
    BTC: "BTCUSDT",
    ETH: "ETHUSDT",
    DOGE: "DOGEUSDT",
    JTO: "JTOUSDT",
    WIF: "WIFUSDT",
    JUP: "JUPUSDT",
    BONK: "BONKUSDT",
    PYTH: "PYTHUSDT",
    W: "WUSDT",
  };
  return binanceMap[symbolUpper] || `${symbolUpper}USDT`;
}

// ============================================================
// DATA FETCHING (single-source per run)
// - source='pyth': Pyth TradingView shim ONLY (no Binance fallback)
// - source='binance': Binance klines ONLY (no Pyth calls)
// This prevents mixed sources across markets/timeframes within a run.
// ============================================================
async function fetchCandles(symbol, interval = "1m", startTime, endTime, source = "pyth") {
  const symbolUpper = symbol.toUpperCase();
  const binanceSymbol = getBinanceSymbol(symbolUpper);
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
    } catch (_) {
      // ignore (cache directory may not exist yet)
    }
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
            } catch (_) {
              // ignore
            }
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
// BINANCE VOLUME FETCHING (for Pyth price candles)
// ============================================================
async function fetchBinanceVolumeOnly(symbol, interval, startTime, endTime) {
  const symbolUpper = String(symbol || "").toUpperCase();
  const binanceSymbol = getBinanceSymbol(symbolUpper);
  const intervalMs = intervalToMs(interval);
  const startAligned = alignToCandleOpenMs(startTime, intervalMs);
  const endAligned = alignToCandleCloseMs(endTime, intervalMs);
  const limit = 1000;

  const startBucket = Math.floor(startAligned / intervalMs);
  const endBucket = Math.floor(endAligned / intervalMs);
  const cacheKey = `binance_${symbolUpper}_${interval}_volume`;
  const cachePrefix = `${cacheKey}_`;
  const primaryCacheName = `${cachePrefix}${startBucket}_${endBucket}.json`;
  const primaryCachePath = path.join(BACKTEST_CACHE_DIR, primaryCacheName);

  const normalizeCandles = (candles) => {
    if (!Array.isArray(candles)) return [];
    return candles
      .map((c) => {
        const openTime = Number(c.openTime ?? c.timestamp);
        return {
          openTime,
          volume: Number(c.volume ?? 0),
          quoteVolume: Number(c.quoteVolume ?? 0),
          takerBuyBaseVolume: Number(c.takerBuyBaseVolume ?? 0),
          takerBuyQuoteVolume: Number(c.takerBuyQuoteVolume ?? 0),
        };
      })
      .filter((c) => Number.isFinite(c.openTime));
  };

  const sliceToRequest = (candles) =>
    (candles || [])
      .filter((c) => c.openTime >= startAligned && c.openTime <= endAligned)
      .sort((a, b) => a.openTime - b.openTime);

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

  const fetchVolumeRange = async (rangeStartMs, rangeEndMs) => {
    if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeStartMs > rangeEndMs)
      return [];
    const rStart = alignToCandleOpenMs(rangeStartMs, intervalMs);
    const rEnd = alignToCandleCloseMs(rangeEndMs, intervalMs);
    if (rStart > rEnd) return [];

    const out = [];
    let cursor = rStart;
    while (cursor < rEnd) {
      const chunkEnd = Math.min(cursor + limit * intervalMs, rEnd);
      const futuresUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${interval}&startTime=${cursor}&endTime=${chunkEnd}&limit=${limit}`;
      let resp = await fetch(futuresUrl, { timeout: 30000 });
      if (!resp.ok) {
        const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&startTime=${cursor}&endTime=${chunkEnd}&limit=${limit}`;
        resp = await fetch(spotUrl, { timeout: 30000 });
        if (!resp.ok) throw new Error(`Binance API error: ${resp.status}`);
      }
      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (const k of data) {
        out.push({
          openTime: k[0],
          volume: parseFloat(k[5]) || 0,
          quoteVolume: parseFloat(k[7]) || 0,
          takerBuyBaseVolume: parseFloat(k[9]) || 0,
          takerBuyQuoteVolume: parseFloat(k[10]) || 0,
        });
      }
      const lastTs = data[data.length - 1][0];
      cursor = lastTs + intervalMs;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return normalizeCandles(out);
  };

  const readCacheFile = (candidatePath) => {
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
      const endBucketFromCandles = Math.floor(Number(last.openTime) / intervalMs);
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
        endTime: Number(last.openTime),
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
    } catch (_) {
      // ignore
    }
    if (!paths.includes(primaryCachePath)) paths.unshift(primaryCachePath);
    return paths;
  };

  if (BACKTEST_CACHE_ENABLED) {
    const cacheCandidates = [];
    const seenPaths = new Set();
    for (const p of listCacheFiles()) {
      if (seenPaths.has(p)) continue;
      seenPaths.add(p);
      const info = readCacheFile(p);
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

    const full = cacheCandidates
      .filter((c) => c.covers)
      .sort((a, b) => {
        if (a.span !== b.span) return a.span - b.span;
        const au = Number(a.meta?.updatedAt || a.meta?.createdAt || 0);
        const bu = Number(b.meta?.updatedAt || b.meta?.createdAt || 0);
        return bu - au;
      });

    for (const c of full) {
      const sliced = sliceToRequest(c.candles);
      if (sliced.length > 0) {
        console.log(
          `   [BINANCE] ✅ Loaded ${sliced.length} ${interval} volume records from cache`
        );
        return sliced;
      }
    }

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
        try {
          const beforeStart = startAligned;
          const beforeEnd = Math.min(endAligned, base.startTime - 1);
          const afterStart = Math.max(startAligned, base.endTime + 1);
          const afterEnd = endAligned;

          const fetchedBefore = needBefore ? await fetchVolumeRange(beforeStart, beforeEnd) : [];
          const fetchedAfter = needAfter ? await fetchVolumeRange(afterStart, afterEnd) : [];

          const mergedSorted = [...base.candles, ...fetchedBefore, ...fetchedAfter]
            .filter((c) => Number.isFinite(c?.openTime))
            .sort((a, b) => a.openTime - b.openTime);
          const merged = dedupeByOpenTimeKeepLast(mergedSorted);

          const mergedFirst = merged[0];
          const mergedLast = merged[merged.length - 1];
          const mergedStartTime = Number(mergedFirst?.openTime);
          const mergedEndTime = Number(mergedLast?.openTime);
          const mergedStartBucket = Math.floor(mergedStartTime / intervalMs);
          const mergedEndBucket = Math.floor(mergedEndTime / intervalMs);
          const targetCacheName = `${cachePrefix}${mergedStartBucket}_${mergedEndBucket}.json`;
          const targetCachePath = path.join(BACKTEST_CACHE_DIR, targetCacheName);

          const updatedPayload = {
            meta: {
              symbol: symbolUpper,
              interval,
              startTime: mergedStartTime,
              endTime: mergedEndTime,
              startBucket: mergedStartBucket,
              endBucket: mergedEndBucket,
              intervalMs,
              createdAt: base.meta?.createdAt || Date.now(),
              updatedAt: Date.now(),
              count: merged.length,
              source: "binance_volume_only",
            },
            candles: merged,
          };

          ensureDir(BACKTEST_CACHE_DIR);
          fs.writeFileSync(targetCachePath, stableStringify(updatedPayload));
          console.log(`   [BINANCE] 💾 Cached ${merged.length} ${interval} volume records`);

          if (base.path !== targetCachePath && fs.existsSync(base.path)) {
            try {
              fs.unlinkSync(base.path);
            } catch (_) {
              // ignore
            }
          }

          cleanupOverlappingCaches(cachePrefix, targetCachePath, intervalMs);
          const finalSliced = sliceToRequest(merged);
          if (finalSliced.length > 0) return finalSliced;
        } catch (err) {
          console.warn(
            `   [BINANCE] Cache incremental update failed: ${err.message}. Falling back to full fetch.`
          );
        }
      }
    }
  }

  console.log(`   [BINANCE] Fetching ${interval} volume for ${binanceSymbol}...`);
  const allCandles = await fetchVolumeRange(startAligned, endAligned);

  if (BACKTEST_CACHE_ENABLED && allCandles.length > 0) {
    try {
      ensureDir(BACKTEST_CACHE_DIR);
      const payload = {
        meta: {
          symbol: symbolUpper,
          interval,
          startTime: startAligned,
          endTime: endAligned,
          startBucket,
          endBucket,
          intervalMs,
          createdAt: Date.now(),
          source: "binance_volume_only",
        },
        candles: allCandles,
      };
      fs.writeFileSync(primaryCachePath, stableStringify(payload));
      console.log(`   [BINANCE] 💾 Cached ${allCandles.length} ${interval} volume records`);
      cleanupOverlappingCaches(cachePrefix, primaryCachePath, intervalMs);
    } catch (_) {
      // ignore
    }
  }

  console.log(`   [BINANCE] ✅ Fetched ${allCandles.length} ${interval} volume records`);
  return allCandles;
}

function mergeVolumeIntoCandles(candles, volumeCandles, label) {
  if (!Array.isArray(candles) || candles.length === 0) return candles;
  if (!Array.isArray(volumeCandles) || volumeCandles.length === 0) {
    console.warn(`   [VOLUME] No Binance volume to merge${label ? ` (${label})` : ""}`);
    return candles;
  }

  const volumeMap = new Map();
  for (const v of volumeCandles) {
    const ts = Number(v?.openTime ?? v?.timestamp);
    if (!Number.isFinite(ts)) continue;
    volumeMap.set(ts, v);
  }

  let mergedCount = 0;
  for (const candle of candles) {
    const ts = Number(candle?.openTime ?? candle?.timestamp);
    if (!Number.isFinite(ts)) continue;
    const v = volumeMap.get(ts);
    if (!v) continue;
    candle.volume = v.volume || 0;
    candle.quoteVolume = v.quoteVolume || 0;
    if (Number.isFinite(v.takerBuyBaseVolume)) candle.takerBuyBaseVolume = v.takerBuyBaseVolume;
    if (Number.isFinite(v.takerBuyQuoteVolume)) candle.takerBuyQuoteVolume = v.takerBuyQuoteVolume;
    mergedCount++;
  }

  console.log(
    `   [VOLUME] Merged Binance volume for ${mergedCount}/${candles.length} candles${label ? ` (${label})` : ""}`
  );
  return candles;
}

function hasNonZeroVolume(candles) {
  return Array.isArray(candles) && candles.some((c) => Number(c?.volume) > 0);
}

async function attachBinanceVolumeToPythCandles({ symbol, interval, startTime, endTime, candles }) {
  if (!Array.isArray(candles) || candles.length === 0) return candles;
  if (hasNonZeroVolume(candles)) return candles;

  try {
    const volumeCandles = await fetchBinanceVolumeOnly(symbol, interval, startTime, endTime);
    mergeVolumeIntoCandles(candles, volumeCandles, `${symbol} ${interval}`);
  } catch (e) {
    console.warn(`   [VOLUME] Binance volume fetch failed: ${e.message}`);
  }

  if (!hasNonZeroVolume(candles)) {
    console.warn(`   [VOLUME] Still no volume after merge for ${symbol} ${interval}`);
  } else {
    const total = candles.length;
    const nonZero = candles.filter((c) => Number(c?.volume) > 0).length;
    const pct = total > 0 ? ((nonZero / total) * 100).toFixed(1) : "0.0";
    console.log(`   [VOLUME] Nonzero volume: ${nonZero}/${total} (${pct}%)`);
  }

  return candles;
}

// ============================================================
// PYTH DATA FETCHING (same source as Jupiter Perps)
// ============================================================

function normalizePythSymbol(symbol) {
  const upper = String(symbol || "")
    .toUpperCase()
    .replace(/-PERP$/, "");
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

  // Pyth limit: short window for 1m, much larger for coarse intervals.
  // Use 5-day chunks for 1m, 120-day chunks for longer intervals.
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
      const intervalMs = intervalToMs(interval || "1m");

      for (let i = 0; i < data.t.length; i++) {
        const timestamp = data.t[i] * 1000;
        const open = Number(data.o?.[i]);
        const high = Number(data.h?.[i]);
        const low = Number(data.l?.[i]);
        const close = Number(data.c?.[i]);
        if (![open, high, low, close].every(Number.isFinite)) continue;
        candles.push({
          openTime: timestamp,
          closeTime: timestamp + intervalMs - 1,
          open,
          high,
          low,
          close,
          volume: 0, // Pyth volume is unreliable; merge Binance volume instead
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
// Bot runs on 15-second loops with 15-minute bars
// Strategy: Fetch 1-minute candles, interpolate 4 ticks per minute
// This gives REAL price data every minute instead of guessing from 15-min OHLC
//
// 15-minute period = 15 x 1-minute candles
// Each 1-minute candle = 4 ticks (15 sec intervals)
// Total = 60 ticks per 15-minute period with REAL 1-min data

const ONE_MIN_MS = 60_000;
const BAR_INTERVAL_MS = 900_000; // 15 minutes
const TICK_INTERVAL_MS = 15_000; // 15 seconds
const TICKS_PER_1MIN_CANDLE = 4; // 4 ticks per 1-minute candle = 15-second intervals
const TICKS_PER_15MIN_CANDLE = 60; // 60 ticks per 15-minute period
const ONE_MIN_CANDLES_PER_BAR = BAR_INTERVAL_MS / ONE_MIN_MS;

/**
 * Tick timestamp helpers (anti-mismatch guardrails)
 *
 * For 15m bars with tick simulation enabled, this repo's source-of-truth model is:
 * - exactly 60 ticks per 15m candle
 * - exactly 15,000ms spacing between ticks
 *
 * We enforce this strictly to prevent "price from tick i" being paired with a different timestamp.
 */
function getTickStepMsOrThrow(interval, ticksPerCandle, { simulateTicks = true } = {}) {
  const intervalMs = intervalToMs(interval || "15m");
  if (simulateTicks && intervalMs === BAR_INTERVAL_MS) {
    if (ticksPerCandle !== TICKS_PER_15MIN_CANDLE) {
      throw new Error(
        `[TICK-TS] Invalid ticksPerCandle for 15m tick simulation: got ${ticksPerCandle}, expected ${TICKS_PER_15MIN_CANDLE}`
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
  const startBucket = Math.floor(alignToCandleOpenMs(startTime, BAR_INTERVAL_MS) / BAR_INTERVAL_MS);
  const endBucket = Math.floor(alignToCandleCloseMs(endTime, BAR_INTERVAL_MS) / BAR_INTERVAL_MS);
  return `${src}_${symbol.toUpperCase()}_ticks15s_15m_${startBucket}_${endBucket}.json`;
}

function tickCachePrefix({ source, symbol }) {
  const src = (source || "pyth").toLowerCase() === "binance" ? "binance" : "pyth";
  return `${src}_${symbol.toUpperCase()}_ticks15s_15m_`;
}

function sliceTicksByBucketRange(byBar, startBucket, endBucket) {
  if (!byBar) return null;
  const out = new Map();
  const startOpen = startBucket * BAR_INTERVAL_MS;
  const endOpen = endBucket * BAR_INTERVAL_MS;
  for (const [barOpen, ticks] of byBar.entries()) {
    const t = Number(barOpen);
    if (!Number.isFinite(t)) continue;
    if (t < startOpen || t > endOpen) continue;
    out.set(t, ticks);
  }
  return out;
}

function buildTicksFor15mBucketsFrom1m(oneMinCandles, bucketOpens) {
  // Build ticks only for the requested 15m buckets (no need to rebuild the whole map).
  const out = new Map();
  if (!Array.isArray(oneMinCandles) || oneMinCandles.length === 0) return out;

  const byOpen = new Map();
  for (const c of oneMinCandles) {
    const ot = Number(c?.openTime);
    if (!Number.isFinite(ot)) continue;
    byOpen.set(ot, c);
  }

  for (const bucket of bucketOpens || []) {
    const bucketOpen = Number(bucket);
    if (!Number.isFinite(bucketOpen)) continue;
    if (bucketOpen % BAR_INTERVAL_MS !== 0) continue;
    const group = [];
    for (let i = 0; i < ONE_MIN_CANDLES_PER_BAR; i++) {
      const c = byOpen.get(bucketOpen + i * ONE_MIN_MS);
      if (!c) {
        group.length = 0;
        break;
      }
      group.push(c);
    }
    if (group.length !== ONE_MIN_CANDLES_PER_BAR) continue;
    const tickObjs = [];
    let tsCursor = bucketOpen;
    for (const oneMin of group) {
      const minTicks = generateTicksFrom1MinCandle(oneMin);
      for (const p of minTicks) {
        tickObjs.push({ price: p, ts: tsCursor });
        tsCursor += TICK_INTERVAL_MS;
      }
    }
    if (tickObjs.length === TICKS_PER_15MIN_CANDLE) {
      out.set(bucketOpen, tickObjs);
    }
  }

  return out;
}

function buildTicksByBarOpenTimeFrom1m(oneMinCandles) {
  // Output: Map<barOpenTimeMs, Array<{price:number, ts:number}>>
  // Each 15m bar has 60 ticks: 15 x (4 ticks per 1m candle).
  const byBar = new Map();
  if (!Array.isArray(oneMinCandles) || oneMinCandles.length === 0) return byBar;

  // Ensure sorted by openTime (copy to avoid mutating caller)
  const sorted = oneMinCandles.slice().sort((a, b) => Number(a.openTime) - Number(b.openTime));

  // Group by true 15m boundaries
  const buckets = new Map(); // bucketOpenTime -> 1m candles[]
  for (const c of sorted) {
    const ot = Number(c?.openTime);
    if (!Number.isFinite(ot)) continue;
    const bucket = Math.floor(ot / BAR_INTERVAL_MS) * BAR_INTERVAL_MS;
    const arr = buckets.get(bucket) || [];
    arr.push(c);
    buckets.set(bucket, arr);
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  for (const bucket of keys) {
    const group = (buckets.get(bucket) || []).sort(
      (a, b) => Number(a.openTime) - Number(b.openTime)
    );
    if (group.length !== ONE_MIN_CANDLES_PER_BAR) continue;
    // Require contiguity (exact 1m spacing)
    let contiguous = true;
    for (let i = 0; i < ONE_MIN_CANDLES_PER_BAR; i++) {
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
    if (tickObjs.length === TICKS_PER_15MIN_CANDLE) {
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
    const ticksPerBar = Number(parsed.ticksPerBar || TICKS_PER_15MIN_CANDLE);
    const tickIntervalMs = Number(parsed.tickIntervalMs || TICK_INTERVAL_MS);
    // Hard guardrails: refuse to load caches that could produce mismatched tick timestamps.
    if (ticksPerBar !== TICKS_PER_15MIN_CANDLE) return null;
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
      : Math.floor(firstBar / BAR_INTERVAL_MS);
    const endBucket = Number.isFinite(Number(meta.endBucket))
      ? Number(meta.endBucket)
      : Math.floor(lastBar / BAR_INTERVAL_MS);
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
      (barOpenTimes.length ? Math.floor(barOpenTimes[0] / BAR_INTERVAL_MS) : null);
    const endBucket =
      bucketRange?.endBucket ??
      (barOpenTimes.length
        ? Math.floor(barOpenTimes[barOpenTimes.length - 1] / BAR_INTERVAL_MS)
        : null);
    const startTime = Number.isFinite(startBucket)
      ? startBucket * BAR_INTERVAL_MS
      : meta?.startTime;
    const endTime = Number.isFinite(endBucket)
      ? endBucket * BAR_INTERVAL_MS + BAR_INTERVAL_MS - 1
      : meta?.endTime;
    const payload = {
      meta: {
        ...meta,
        startBucket,
        endBucket,
        intervalMs: BAR_INTERVAL_MS,
        startTime,
        endTime,
        createdAt: meta?.createdAt || Date.now(),
        updatedAt: Date.now(),
      },
      ticksPerBar: TICKS_PER_15MIN_CANDLE,
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
  const requestedStartBucket = Math.floor(
    alignToCandleOpenMs(startTime, BAR_INTERVAL_MS) / BAR_INTERVAL_MS
  );
  const requestedEndBucket = Math.floor(
    alignToCandleCloseMs(endTime, BAR_INTERVAL_MS) / BAR_INTERVAL_MS
  );
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
    } catch (_) {
      // ignore
    }
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

      const { startBucket: cacheStartBucket, endBucket: cacheEndBucket } = parsed;
      const covers =
        cacheStartBucket <= requestedStartBucket && cacheEndBucket >= requestedEndBucket;
      const overlaps =
        cacheEndBucket >= requestedStartBucket && cacheStartBucket <= requestedEndBucket;
      const span = cacheEndBucket - cacheStartBucket;

      candidateMeta.push({
        path: p,
        startBucket: cacheStartBucket,
        endBucket: cacheEndBucket,
        covers,
        overlaps,
        span,
      });
    }

    // Find best SUPERSET (covers entire range) - prefer smallest span (tightest fit)
    const fullCandidates = candidateMeta.filter((c) => c.covers).sort((a, b) => a.span - b.span);

    if (fullCandidates[0]) {
      // Phase 2: Load ONLY the best matching cache
      const best = fullCandidates[0];
      const loaded = readTickCacheFile(best.path);
      if (loaded && loaded.byBar) {
        const sliced = sliceTicksByBucketRange(
          loaded.byBar,
          requestedStartBucket,
          requestedEndBucket
        );
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
          Math.min(requestedEndBucket, a.endBucket) - Math.max(requestedStartBucket, a.startBucket)
        );
        const overlapB = Math.max(
          0,
          Math.min(requestedEndBucket, b.endBucket) - Math.max(requestedStartBucket, b.startBucket)
        );
        if (overlapA !== overlapB) return overlapB - overlapA;
        return b.span - a.span;
      });

    const bestOverlap = overlappingCandidates[0] || null;
    if (bestOverlap) {
      // Phase 2: Load ONLY this one cache for extension
      const loaded = readTickCacheFile(bestOverlap.path);
      if (loaded && loaded.byBar) {
        const needBefore = requestedStartBucket < bestOverlap.startBucket;
        const needAfter = requestedEndBucket > bestOverlap.endBucket;

        console.log(
          `   [TICK-CACHE] INCREMENTAL (${needBefore ? "prepend" : ""}${needBefore && needAfter ? "+" : ""}${needAfter ? "append" : ""}) ` +
            `via ${path.basename(bestOverlap.path)}`
        );

        const missingBuckets = [];
        for (let b = requestedStartBucket; b <= requestedEndBucket; b++) {
          const barOpen = b * BAR_INTERVAL_MS;
          if (!loaded.byBar.has(barOpen)) missingBuckets.push(barOpen);
        }
        const built = buildTicksFor15mBucketsFrom1m(oneMinCandles, missingBuckets);
        for (const [k, v] of built.entries()) loaded.byBar.set(k, v);

        // Write merged cache under its true bucket range
        const keys = [...loaded.byBar.keys()].sort((a, b) => a - b);
        const mergedStartBucket = keys.length
          ? Math.floor(keys[0] / BAR_INTERVAL_MS)
          : requestedStartBucket;
        const mergedEndBucket = keys.length
          ? Math.floor(keys[keys.length - 1] / BAR_INTERVAL_MS)
          : requestedEndBucket;
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
          } catch (_) {
            // ignore
          }
        }

        cleanupOverlappingCaches(cachePrefix, targetPath, BAR_INTERVAL_MS);
        const sliced = sliceTicksByBucketRange(
          loaded.byBar,
          requestedStartBucket,
          requestedEndBucket
        );
        return sliced;
      }
    }

    // No useful cache: fall through to build fresh.
  }

  const builtAll = buildTicksByBarOpenTimeFrom1m(oneMinCandles);
  const sliced = sliceTicksByBucketRange(builtAll, requestedStartBucket, requestedEndBucket);
  if (BACKTEST_TICK_CACHE_ENABLED) {
    const keys = [...builtAll.keys()].sort((a, b) => a - b);
    const bStart = keys.length ? Math.floor(keys[0] / BAR_INTERVAL_MS) : requestedStartBucket;
    const bEnd = keys.length
      ? Math.floor(keys[keys.length - 1] / BAR_INTERVAL_MS)
      : requestedEndBucket;
    saveTickCache(primaryPath, { source: src, symbol: symbolUpper }, builtAll, {
      startBucket: bStart,
      endBucket: bEnd,
    });
    cleanupOverlappingCaches(cachePrefix, primaryPath, BAR_INTERVAL_MS);
    console.log(`   [TICK-CACHE] Saved: ${path.basename(primaryPath)} (${builtAll.size} bars)`);
  }
  return sliced;
}

/**
 * Generate tick prices from a 1-minute candle (4 ticks = 15 sec each)
 * More accurate than interpolating from 15-minute candles
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
 * Aggregate 15 x 1-minute candles into 1 x 15-minute candle
 */
function aggregate1MinTo15Min(oneMinCandles) {
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
 * Deterministically aggregate 1m candles into timestamp-aligned 15m candles.
 * This avoids "slice-in-5s" bar drift when the requested startTime isn't on a 15m boundary.
 *
 * Rules:
 * - Group by real 15m boundaries (bucket = floor(openTime/15m)*15m)
 * - Only emit a 15m candle when all 15 constituent 1m candles are present and contiguous
 */
function aggregate1MinTo15MinAligned(oneMinCandles) {
  if (!oneMinCandles || oneMinCandles.length === 0) return [];

  const byBucket = new Map();
  for (const c of oneMinCandles) {
    if (!c) continue;
    const openTime = Number(c.openTime);
    if (!Number.isFinite(openTime)) continue;
    const bucket = Math.floor(openTime / BAR_INTERVAL_MS) * BAR_INTERVAL_MS;
    const arr = byBucket.get(bucket) || [];
    arr.push(c);
    byBucket.set(bucket, arr);
  }

  const buckets = [...byBucket.keys()].sort((a, b) => a - b);
  const out = [];
  for (const bucket of buckets) {
    const group = byBucket.get(bucket) || [];
    group.sort((a, b) => Number(a.openTime) - Number(b.openTime));
    if (group.length !== ONE_MIN_CANDLES_PER_BAR) continue;
    let contiguous = true;
    for (let i = 0; i < ONE_MIN_CANDLES_PER_BAR; i++) {
      const expectedOpen = bucket + i * ONE_MIN_MS;
      if (Number(group[i].openTime) !== expectedOpen) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const agg = aggregate1MinTo15Min(group);
    if (agg) out.push(agg);
  }
  return out;
}

/**
 * Generate all ticks from 15 x 1-minute candles (60 ticks total)
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
 * Legacy function for backward compatibility (15-min candle interpolation)
 * Used when 1-minute data is not available
 */
function generateIntraBarTicks(candle, numTicks = TICKS_PER_15MIN_CANDLE) {
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
function generateTickPrices(candle, numTicks = TICKS_PER_15MIN_CANDLE) {
  return generateIntraBarTicks(candle, numTicks);
}

/**
 * Generate tick objects from 15m candle OHLC (fallback when 1m data is incomplete)
 * Returns array of {price, ts} objects matching the format from 1m-derived ticks.
 * This is used for graceful degradation at fold boundaries in walk-forward analysis.
 */
function generateTicksFromOHLC(candle, numTicks = TICKS_PER_15MIN_CANDLE) {
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
// ICHIMOKU CLOUD SIMULATION
// ============================================================
function simulateIchimokuCloud(strategy, candles, options = {}) {
  // Ichimoku backtest uses the bot runtime parity loop to avoid lookahead.
  return simulateBotRuntimeSingleMarket(strategy, candles, {
    ...options,
    _traceModel: options._traceModel || "backtest",
  });
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
    ticksPerCandle = TICKS_PER_15MIN_CANDLE,
    simulateTicks = true,
    hardStopAtrMult = 0,
    // Advanced sizing methods
    positionSizingMethod = "percent",
    riskPerTradePercent = 2, // For equal-risk: % of capital to risk per trade
    kellyFraction = 0.25, // For Kelly: use quarter-Kelly
    volatilityScaleBase = 0.02, // For volatility-scaled: target ATR %
    qualitySizeMultMin = 0.5, // For quality-weighted: min multiplier
    qualitySizeMultMax = 1.5, // For quality-weighted: max multiplier
    hardStopPercent = 0, // For equal-risk sizing calculation
  } = options;

  const suppressSimHeader =
    options.suppressSimHeader === true ||
    options.minimalOutput === true ||
    ["workflow", "minimal", "quiet"].includes(
      String(process.env.BACKTEST_OUTPUT_MODE || "")
        .trim()
        .toLowerCase()
    );

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
  const makerFillSimEnabled =
    feeCfg.model === "drift" &&
    feeCfg.execMode === "maker" &&
    process.env.ENABLE_MAKER_FILL_SIM === "true";

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
  const pendingEntries = []; // scheduled fills (maker or delayed taker fallback)
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

  // Optional debugging: capture per-market signal reasons (to diagnose multi-market parity issues)
  const debugSignalReasons = process.env.DEBUG_MULTI_MARKET_SIGNAL_REASONS === "true";
  const debugSignalMaxBars = Number(process.env.DEBUG_MULTI_MARKET_SIGNAL_MAX_BARS) || 0; // 0 = all
  const signalReasonStats = debugSignalReasons
    ? new Map() // market -> Map(reason -> count)
    : null;
  const signalActionStats = debugSignalReasons
    ? new Map() // market -> { open, hold }
    : null;

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
    if (debugSignalReasons) {
      signalReasonStats.set(market, new Map());
      signalActionStats.set(market, { open: 0, hold: 0 });
    }
  }

  const openFilledEntry = ({
    id,
    market,
    side,
    strategy,
    candle,
    barIndex,
    fillTickIndex,
    entryMarkPrice,
    execMode,
    fillPrice,
    fillTs,
    sizeUsd,
    collateral,
    marketLeverage,
    allocatorRiskApplied,
    entryReason,
    entryConfidence,
    effectiveHardStopPct,
    effectiveHardStopAtr,
  }) => {
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;
    let filledEntryPrice = fillPrice;

    if (execMode === "taker") {
      const before = filledEntryPrice;
      filledEntryPrice = applyTakerEntrySlippage(
        filledEntryPrice,
        side,
        sizeUsd,
        market,
        strategy?.atr
      );
      if (Number.isFinite(before) && before > 0 && Number.isFinite(filledEntryPrice)) {
        const slipUsd = sizeUsd * Math.abs(filledEntryPrice / before - 1);
        if (Number.isFinite(slipUsd) && slipUsd > 0) {
          feeBreakdown.slippageUsd += slipUsd;
          feeBreakdown.slippageEntryUsd += slipUsd;
        }
      }
    }

    const quantity = sizeUsd / filledEntryPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) return null;

    const openRes = feeCfg.calculateOpenFee
      ? feeCfg.calculateOpenFee(sizeUsd, { execMode })
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
      id,
      market,
      side,
      entryMarkPrice,
      entryPrice: filledEntryPrice,
      entryFillPrice: filledEntryPrice,
      entryAdx: strategy?.adx ?? null,
      entryAtr: Number.isFinite(strategy?.atr) ? strategy.atr : null,
      openTime: fillTs,
      lastBorrowTs: fillTs,
      openBarIndex: barIndex,
      sizeUsd,
      quantity,
      collateral,
      leverage: marketLeverage,
      entryFee: totalEntryFees,
      entryExecMode: execMode,
      allocatorRiskApplied,
      entryReason,
      entryConfidence,
      entryFees: { openFee, impactFee, txFee, total: totalEntryFees, execMode },
    };

    // Fixed hard stop level from ENTRY ATR (used for per-tick stops)
    // Use EFFECTIVE hard stop values (may be adjusted by allocator)
    if (
      strategy?.cfg?.hardStopEnabled &&
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

    position.highWaterMark = position.entryPrice;
    position.lowWaterMark = position.entryPrice;
    allPositions.push(position);

    if (trace) {
      trace.push({
        model: traceModel,
        kind: "entry",
        ts: fillTs,
        market: traceMarketName(market),
        barIndex,
        tickIndex: fillTickIndex,
        price: Number.isFinite(entryMarkPrice) ? entryMarkPrice : filledEntryPrice,
        adx: position.entryAdx,
        atr: position.entryAtr,
        action: "open",
        side: position.side,
        confidence: entryConfidence ?? null,
        reason: entryReason ?? null,
        positionId: position.id,
        fillPrice: filledEntryPrice,
      });
    }

    return position;
  };

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

  // Note: No look-ahead bias because indicators update at bar close
  // and entries happen at current bar's open - matching live bot behavior

  // Get locked collateral (across ALL markets)
  const getLockedCollateral = () => {
    const open = allPositions.reduce((sum, pos) => sum + (pos.collateral || 0), 0);
    const pending = pendingEntries.reduce((sum, pos) => sum + (pos.collateral || 0), 0);
    return open + pending;
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
        const atrStopMult = options.hardStopAtrMult || hardStopAtrMult || 0;
        if (atrStopMult > 0 && context.atr && context.price && context.atr > 0) {
          const atrStopPct = ((context.atr * atrStopMult) / context.price) * 100;
          if (atrStopPct > 0) {
            stopDistancePct = atrStopPct;
            stopSource = `ATR(${atrStopMult}x)`;
          }
        }

        // If no ATR stop, use percent-based
        if (stopSource === "fallback") {
          const pctStop = context.hardStopPct || hardStopPercent || 0;
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
    "equal-risk": `${riskPerTradePercent}% risk per trade (stop=${hardStopPercent}%)`,
    kelly: `Kelly criterion (${(kellyFraction * 100).toFixed(0)}% fraction)`,
    "volatility-scaled": `volatility-scaled (target ${(volatilityScaleBase * 100).toFixed(1)}% ATR)`,
    "quality-weighted": `quality-weighted (${qualitySizeMultMin.toFixed(1)}x-${qualitySizeMultMax.toFixed(1)}x)`,
  };

  // Debug: verify sizing params are received
  if (process.env.DEBUG_SIZING === "true") {
    console.log(
      `[DEBUG_SIZING] method=${positionSizingMethod}, pct=${positionSizePercent}%, risk=${riskPerTradePercent}%, kelly=${kellyFraction}, volBase=${volatilityScaleBase}, hardStop=${hardStopPercent}%`
    );
  }

  if (!suppressSimHeader) {
    console.log(`\n📊 Multi-Market Shared Capital Simulation`);
    console.log(`   Markets: ${Array.from(candlesMap.keys()).join(", ")}`);
    console.log(`   Timeline: ${timestamps.length} unified timestamps`);
    console.log(
      `   Tick Simulation: ${simulateTicks ? `${effectiveTicksPerCandle} ticks/candle` : "disabled"}`
    );
    console.log(`   Entry Timing: BAR OPEN (signals from prev bar close - no look-ahead)`);
    console.log(`   Initial Capital: $${initialCapital} (SHARED across all markets)`);
    console.log(
      `   Sizing Method: ${positionSizingMethod} - ${sizingDesc[positionSizingMethod] || sizingDesc["percent"]}`
    );
    console.log(`   Leverage: ${leverage}x`);
    console.log(`   Max Positions: ${maxPositions} (across all markets)\n`);
  }

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
    // Strategy exits at BAR OPEN (production parity)
    // - Indicators updated from previous bar close
    // - Execute exits at bar open price
    // ============================================================
    if (idx > 0 && allPositions.length > 0) {
      const toClose = [];
      for (const pos of allPositions) {
        const candle = marketCandles.get(pos.market);
        const strategy = strategiesMap.get(pos.market);
        if (!candle || !strategy) continue;

        const sig = strategy.shouldClose(pos, candle.open);
        if (!sig) continue;
        if (
          sig.reason === "ichimoku_hard_stop_percent" ||
          sig.reason === "ichimoku_hard_stop_atr" ||
          sig.reason === "ichimoku_atr_trail"
        ) {
          continue; // per-tick only
        }
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
        let exitExecMode = makerFillSimEnabled ? preferredExitMode : "taker";
        let filledExitPrice = exitPrice;

        // Simulate maker exit if applicable
        if (makerFillSimEnabled && preferredExitMode === "maker") {
          makerExitStats.attempts++;
          const exitSim = simulateDriftMakerExitFill({
            market: `${market}-PERP`,
            strategyKey: process.env.STRATEGY_TYPE || "ichimoku-cloud",
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
        } else if (makerFillSimEnabled && preferredExitMode === "taker") {
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
        const impactFee = closeRes.breakdown?.priceImpactFee ?? 0;
        const protocolFee = closeRes.fee ?? closeFee + impactFee;
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

        const totalExitFees = protocolFee + swapFee + borrowFee + txFee - fundingFee;

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
          entryAdx: pos.entryAdx,
          exitAdx: strategy.adx,
          openTime: pos.openTime,
          exitTime: exitTs,
          sizeUsd: pos.sizeUsd,
          quantity: pos.quantity,
          leverage: marketLeverage,
          collateral: pos.collateral,
          grossPnl,
          pnlUsd: netPnl,
          totalPnlUsd: netPnl - (pos.entryFee || 0),
          pnlPct: ((netPnl - (pos.entryFee || 0)) / pos.collateral) * 100,
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
            adx: strategy.adx,
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
        if (typeof strategy.recordTrade === "function") {
          strategy.recordTrade(trade);
        }
      }
    }

    // Generate tick prices for all markets (NO LOOK-AHEAD):
    // Use real 1m candles → 15s ticks. Never synthesize from 15m OHLC.
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
    // ENTRY CHECK AT BAR OPEN (using indicators from previous bar close)
    // This matches live bot behavior:
    //   1. Previous bar closes → indicators updated
    //   2. Signal check happens immediately
    //   3. Entry at current bar's open price
    // ============================================================
    if (allPositions.length + pendingEntries.length < maxPositions && idx > 0) {
      // Collect all eligible signals first, then apply deterministic ranking/tie-breaks.
      const candidates = [];

      for (const [market, candle] of marketCandles.entries()) {
        const strategy = strategiesMap.get(market);
        if (!strategy) continue;

        if (parityChecks) {
          const lastIdx = lastBarCloseUpdatedIdxByMarket.get(market);
          if (Number.isFinite(lastIdx) && lastIdx !== idx - 1) {
            throw new Error(
              `[PARITY] Illegal entry sequencing for ${market} at bar ${idx}: expected last bar-close update idx=${idx - 1}, got ${lastIdx}`
            );
          }
        }

        // Skip if already have a position in this market
        const hasPositionInMarket =
          allPositions.some((p) => p.market === market) ||
          pendingEntries.some((p) => p.market === market);
        if (hasPositionInMarket) continue;

        const entryPrice = candle.open;
        const entryTime = candle.openTime;

        const signal = strategy.getSignal(entryPrice, []);
        if (debugSignalReasons && (debugSignalMaxBars <= 0 || idx <= debugSignalMaxBars)) {
          const reason = String(signal?.reason || "none");
          const action = String(signal?.action || "none");
          const m = signalReasonStats.get(market);
          if (m) m.set(reason, (m.get(reason) || 0) + 1);
          const a = signalActionStats.get(market);
          if (a) {
            if (action === "open") a.open++;
            else a.hold++;
          }
        }
        if (trace) {
          trace.push({
            model: traceModel,
            kind: "signal",
            ts: entryTime,
            market: traceMarketName(market),
            barIndex: idx,
            tickIndex: 0,
            price: entryPrice,
            adx: strategy.adx,
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
          const remainingSlots = Math.max(
            0,
            maxPositions - (allPositions.length + pendingEntries.length)
          );
          const allMarketSignals = candidates.map((c) => ({
            market: traceMarketName(c.market),
            signal: { ...c.signal, strategyType: "ichimoku-cloud" },
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
            remainingSlots,
            positionsForAllocator
          );
          selected.sort((a, b) => {
            const ds = (b.score ?? 0) - (a.score ?? 0);
            if (ds !== 0) return ds;
            const dm = String(a.market).localeCompare(String(b.market));
            if (dm !== 0) return dm;
            return String(a.signal?.side).localeCompare(String(b.signal?.side));
          });
          const selectedMarkets = new Set(selected.map((s) => s.market));

          // Identify rejected candidates (ranked but not selected)
          for (let rIdx = 0; rIdx < ranked.length; rIdx++) {
            const r = ranked[rIdx];
            if (selectedMarkets.has(r.market)) continue;
            const cand = candidates.find((c) => traceMarketName(c.market) === r.market);
            if (!cand) continue;
            const reason = remainingSlots < ranked.length ? "blocked_capacity" : "outranked";
            rejectedCandidates.push({
              ...cand,
              _allocatorScore: r.score,
              _rejectionReason: reason,
            });
            if (reason === "blocked_capacity") {
              allocatorStats.totalSignalsBlockedCapacity++;
              const mkt = traceMarketName(cand.market);
              if (allocatorStats.byMarket.has(mkt))
                allocatorStats.byMarket.get(mkt).blockedCapacity++;
            } else {
              allocatorStats.totalSignalsRejected++;
              const mkt = traceMarketName(cand.market);
              if (allocatorStats.byMarket.has(mkt)) allocatorStats.byMarket.get(mkt).rejected++;
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

        // Allocator-driven risk (batch): compute multipliers once so when multiple markets
        // are selected on the same bar, the inferior pick is de-risked.
        let allocatorRiskMults = null;
        if (
          allocator &&
          typeof allocator.recommendRiskMultipliersBatch === "function" &&
          (allocator?.riskRecommendation?.enabled ||
            allocator?.riskRecommendation?.ichimoku?.enabled)
        ) {
          const remainingSlots = Math.max(
            0,
            maxPositions - (allPositions.length + pendingEntries.length)
          );
          const batch = ordered.slice(0, remainingSlots).map((c) => ({
            market: traceMarketName(c.market),
            signal: c.signal,
            priceData: { price: c.entryPrice, atr: c.strategy?.atr },
            score: c._allocatorScore ?? 0,
            strategyType: "ichimoku-cloud",
          }));
          allocatorRiskMults = allocator.recommendRiskMultipliersBatch(batch);
        }

        for (const cand of ordered) {
          if (allPositions.length + pendingEntries.length >= maxPositions) break;

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
          const baseHardStopPct = strategy?.cfg?.hardStopPercent ?? 0;
          const baseHardStopAtr = strategy?.cfg?.hardStopAtrMult ?? 0;

          // === ALLOCATOR RISK RECOMMENDATION ===
          // When enabled, dynamically adjust size/leverage/stops based on signal quality
          let effectiveSizePct = baseSizePct;
          let effectiveLeverage = baseLeverage;
          let effectiveHardStopPct = baseHardStopPct;
          let effectiveHardStopAtr = baseHardStopAtr;
          let allocatorRiskApplied = null;

          if (allocatorRiskMults && allocator) {
            const key = `${traceMarketName(market)}:${String(signal?.side || "").toLowerCase()}`;
            const mult = allocatorRiskMults.get(key);
            if (mult) {
              effectiveSizePct =
                baseSizePct * (Number.isFinite(mult.finalSizeMult) ? mult.finalSizeMult : 1);
              effectiveLeverage =
                baseLeverage * (Number.isFinite(mult.finalLevMult) ? mult.finalLevMult : 1);

              // Mirror allocator rounding/clamps (recommendRisk()).
              const step = Number(allocator?.riskRecommendation?.leverage?.roundStep);
              if (Number.isFinite(step) && step > 0) {
                effectiveLeverage = Math.round(effectiveLeverage / step) * step;
              }
              const levMin = Number(allocator?.riskRecommendation?.leverage?.min ?? 1);
              const levMax = Number(allocator?.riskRecommendation?.leverage?.max ?? 100);
              effectiveLeverage = Math.max(levMin, Math.min(levMax, effectiveLeverage));

              // Price-space invariant: scale hard stop % proportionally with leverage.
              effectiveHardStopPct =
                baseHardStopPct > 0 && baseLeverage > 0
                  ? baseHardStopPct * (effectiveLeverage / baseLeverage)
                  : baseHardStopPct;
              effectiveHardStopAtr = baseHardStopAtr;

              allocatorRiskApplied = {
                quality: mult.quality,
                rankMult: mult.rankMult,
                sizePct: { base: baseSizePct, effective: effectiveSizePct },
                leverage: { base: baseLeverage, effective: effectiveLeverage },
                hardStopPct: { base: baseHardStopPct, effective: effectiveHardStopPct },
                hardStopAtr: { base: baseHardStopAtr, effective: effectiveHardStopAtr },
              };

              if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
                console.log(
                  `[ALLOCATOR_RISK] ${market} q=${Number(mult.quality || 0).toFixed(2)} rank=${Number(mult.rankMult || 1).toFixed(2)} | size=${baseSizePct.toFixed(0)}→${effectiveSizePct.toFixed(0)}% lev=${baseLeverage.toFixed(1)}→${effectiveLeverage.toFixed(1)}x`
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

          const id = `sim-${++tradeCounter}`;
          const entryReason = signal?.reason ?? null;
          const entryConfidence = signal?.confidence ?? null;

          // Default: immediate fill at bar open.
          let execMode = makerFillSimEnabled ? "maker" : "taker";
          let fillPrice = entryPrice;
          let fillIndex = 0;
          let fillTs = entryTime;

          if (makerFillSimEnabled) {
            makerEntryStats.attempts++;
            const rawTicks = marketTicks.get(market) || [];
            const ticksForMarket = rawTicks.map((t) =>
              typeof t === "number" ? t : Number(t?.price)
            );
            const tickIntervalMs =
              intervalToMs(options.interval || "15m") / effectiveTicksPerCandle;
            const tickTimestampsForMarket = rawTicks.map((t, i) => {
              const tsVal = typeof t === "object" && t && Number.isFinite(t.ts) ? t.ts : null;
              if (Number.isFinite(tsVal)) return tsVal;
              return entryTime + i * tickIntervalMs;
            });

            const sim = simulateDriftMakerEntryFill({
              market: traceMarketName(market),
              strategyKey: process.env.STRATEGY_TYPE || "ichimoku-cloud",
              side: signal.side,
              refPrice: entryPrice,
              candle,
              ticks: ticksForMarket,
              tickTimestamps: tickTimestampsForMarket,
              startTickIndex: 0,
              tickIntervalMs,
              positionSizeUsd: sizeUsd,
              volatility: strategy?.atr && entryPrice ? strategy.atr / entryPrice : 0.02,
            });
            if (sim.outcome === "maker_fill") makerEntryStats.makerFills++;
            if (sim.outcome === "taker_fallback") makerEntryStats.takerFallbacks++;
            if (sim.outcome === "no_fill") {
              makerEntryStats.noFills++;
              continue;
            }
            execMode = sim.execMode || "taker";
            fillPrice = sim.fillPrice ?? entryPrice;
            fillIndex = Number.isFinite(sim.fillIndex) ? sim.fillIndex : 0;
            fillTs = Number.isFinite(sim.fillTs)
              ? sim.fillTs
              : (tickTimestampsForMarket[fillIndex] ?? entryTime + fillIndex * tickIntervalMs);
          }

          // Track accepted signal
          allocatorStats.totalSignalsAccepted++;
          const mktAccepted = traceMarketName(market);
          if (allocatorStats.byMarket.has(mktAccepted))
            allocatorStats.byMarket.get(mktAccepted).accepted++;

          // If fill is delayed (maker fill or delayed taker fallback), schedule it.
          if (fillIndex > 0) {
            pendingEntries.push({
              id,
              market,
              side: signal.side,
              execMode,
              fillPrice,
              fillTs,
              fillIndex,
              entryMarkPrice: entryPrice,
              sizeUsd,
              collateral,
              marketLeverage,
              allocatorRiskApplied,
              entryReason,
              entryConfidence,
              effectiveHardStopPct,
              effectiveHardStopAtr,
              barIndex: idx,
            });
            if (debug) {
              console.log(
                `🕒 [${market}] ENTRY scheduled: ${String(signal.side).toUpperCase()} tick=${fillIndex} @ $${fillPrice.toFixed(2)} (mode=${execMode})`
              );
            }
            continue;
          }

          const opened = openFilledEntry({
            id,
            market,
            side: signal.side,
            strategy,
            candle,
            barIndex: idx,
            fillTickIndex: 0,
            entryMarkPrice: entryPrice,
            execMode,
            fillPrice,
            fillTs,
            sizeUsd,
            collateral,
            marketLeverage,
            allocatorRiskApplied,
            entryReason,
            entryConfidence,
            effectiveHardStopPct,
            effectiveHardStopAtr,
          });

          if (debug && opened) {
            console.log(
              `🎯 [${market}] ENTRY @ tick0: ${String(signal.side).toUpperCase()} @ $${opened.entryPrice.toFixed(2)} | Collateral: $${collateral.toFixed(0)}`
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
      const intervalMs = intervalToMs(options.interval || "15m");
      const anyCandle = marketCandles.values().next().value;
      const tickTsBase = anyCandle?.openTime ?? ts;
      const tickTs = tickTsBase + tickIdx * (intervalMs / effectiveTicksPerCandle);

      // Fill any scheduled entries (maker fill or delayed taker fallback) for this tick.
      for (let i = pendingEntries.length - 1; i >= 0; i--) {
        const pe = pendingEntries[i];
        if (!pe || pe.barIndex !== idx || pe.fillIndex !== tickIdx) continue;
        pendingEntries.splice(i, 1);

        const candle = marketCandles.get(pe.market);
        const strategy = strategiesMap.get(pe.market);
        if (!candle || !strategy) continue;

        openFilledEntry({
          id: pe.id,
          market: pe.market,
          side: pe.side,
          strategy,
          candle,
          barIndex: idx,
          fillTickIndex: tickIdx,
          entryMarkPrice: pe.entryMarkPrice,
          execMode: pe.execMode,
          fillPrice: pe.fillPrice,
          fillTs: Number.isFinite(pe.fillTs) ? pe.fillTs : tickTs,
          sizeUsd: pe.sizeUsd,
          collateral: pe.collateral,
          marketLeverage: pe.marketLeverage,
          allocatorRiskApplied: pe.allocatorRiskApplied,
          entryReason: pe.entryReason,
          entryConfidence: pe.entryConfidence,
          effectiveHardStopPct: pe.effectiveHardStopPct,
          effectiveHardStopAtr: pe.effectiveHardStopAtr,
        });
      }

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
      // Strategy exits are bar-based and evaluated at bar open using the last closed bar.
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

        // Update trailing watermarks once per tick (ATR itself only updates on bar close).
        if (pos.side === "long") {
          pos.highWaterMark = Math.max(Number(pos.highWaterMark || pos.entryPrice), price);
        } else if (pos.side === "short") {
          pos.lowWaterMark = Math.min(Number(pos.lowWaterMark || pos.entryPrice), price);
        }

        // ===== HARD STOP CHECK FIRST (priority over max_loss_cap) =====
        // Even if price has gapped way past the stop, exit at stop level
        const hardStopPercent = options.perMarketHardStop?.has(market)
          ? options.perMarketHardStop.get(market)
          : (options.hardStopPercent ?? 3);
        // Use outer-scope default `hardStopAtrMult` from options destructuring (avoid TDZ shadowing).
        const effectiveHardStopAtrMult = options.perMarketHardStopAtr?.has(market)
          ? options.perMarketHardStopAtr.get(market)
          : (options.hardStopAtrMult ?? hardStopAtrMult ?? 0);

        const atrForStop = Number.isFinite(pos.entryAtr) ? pos.entryAtr : strategy.atr;

        // Percent stop respects hardStopEnabled; ATR stop can be active even if hardStopEnabled is false
        // (matches ichimoku-cloud-breakout-strategy.js shouldClose()).
        let stopTriggered = false;
        let stopPrice = price;
        let stopLevel = null;
        let stopReason = null;

        // 1) Percent stop (leverage-adjusted, collateral PnL% -> price %)
        if (
          strategy?.cfg?.hardStopEnabled === true &&
          Number.isFinite(hardStopPercent) &&
          hardStopPercent > 0
        ) {
          const pricePct = hardStopPercent / 100 / Math.max(1, posLeverage || 1);
          if (pos.side === "short") {
            stopLevel = pos.entryPrice * (1 + pricePct);
            if (price >= stopLevel) {
              stopTriggered = true;
              stopReason = "ichimoku_hard_stop_percent";
              stopPrice = Math.max(stopLevel, price);
            }
          } else if (pos.side === "long") {
            stopLevel = pos.entryPrice * (1 - pricePct);
            if (price <= stopLevel) {
              stopTriggered = true;
              stopReason = "ichimoku_hard_stop_percent";
              stopPrice = Math.min(stopLevel, price);
            }
          }
        }

        // 2) ATR stop (absolute $ distance, not leverage-adjusted)
        if (
          !stopTriggered &&
          Number.isFinite(effectiveHardStopAtrMult) &&
          effectiveHardStopAtrMult > 0 &&
          Number.isFinite(atrForStop) &&
          atrForStop > 0
        ) {
          const dist = atrForStop * effectiveHardStopAtrMult;
          if (Number.isFinite(dist) && dist > 0) {
            if (pos.side === "short") {
              stopLevel = pos.entryPrice + dist;
              if (price >= stopLevel) {
                stopTriggered = true;
                stopReason = "ichimoku_hard_stop_atr";
                stopPrice = Math.max(stopLevel, price);
              }
            } else if (pos.side === "long") {
              stopLevel = pos.entryPrice - dist;
              if (price <= stopLevel) {
                stopTriggered = true;
                stopReason = "ichimoku_hard_stop_atr";
                stopPrice = Math.min(stopLevel, price);
              }
            }
          }
        }

        if (stopTriggered) {
          positionsToClose.push({
            pos,
            reason: stopReason || "ichimoku_hard_stop_percent",
            price: stopPrice,
            stopPrice,
            stopLevel, // Original stop level for logging
            tickPrice: price, // Actual tick price for reference
            exitTs: posTickTs,
            candle,
            market,
            strategy,
          });
          continue; // Skip other per-tick checks - hard stop takes priority
        }

        // ===== ATR TRAILING STOP (tick-level, uses bar-updated ATR) =====
        // ATR is updated only when strategy.update() runs at bar close. We can still enforce
        // ATR-based exits intra-bar using the latest available ATR.
        if (strategy?.cfg?.enableAtrTrail && Number.isFinite(strategy.atr) && strategy.atr > 0) {
          const mult = Number(strategy.cfg.trailAtrMult);
          if (Number.isFinite(mult) && mult > 0) {
            const trailDistance = strategy.atr * mult;
            if (
              pos.side === "long" &&
              Number.isFinite(pos.highWaterMark) &&
              price <= pos.highWaterMark - trailDistance
            ) {
              positionsToClose.push({
                pos,
                reason: "ichimoku_atr_trail",
                price,
                stopPrice: price,
                exitTs: posTickTs,
                candle,
                market,
                strategy,
              });
              continue;
            }
            if (
              pos.side === "short" &&
              Number.isFinite(pos.lowWaterMark) &&
              price >= pos.lowWaterMark + trailDistance
            ) {
              positionsToClose.push({
                pos,
                reason: "ichimoku_atr_trail",
                price,
                stopPrice: price,
                exitTs: posTickTs,
                candle,
                market,
                strategy,
              });
              continue;
            }
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
      } of positionsToClose) {
        const posIdx = allPositions.indexOf(pos);
        if (posIdx === -1) continue;
        allPositions.splice(posIdx, 1);

        const dir = pos.side === "long" ? 1 : -1;
        // NOTE: grossPnl will be calculated AFTER slippage is applied to filledExitPrice

        // Determine if exit should be maker or taker based on reason
        // Hard stops and emergency exits → immediate taker
        // Bar-based strategy exits → can try maker
        const preferredExitMode = getExitExecModeForReason(reason, feeCfg.execMode);
        let exitExecMode = makerFillSimEnabled ? preferredExitMode : "taker";
        let filledExitPrice = price;
        const refExitPriceForSlippage = price; // always measure execution vs the true reference

        // Only simulate maker if preferred AND Drift maker mode is enabled
        if (makerFillSimEnabled && preferredExitMode === "maker") {
          makerExitStats.attempts++;
          const exitSim = simulateDriftMakerExitFill({
            market: traceMarketName(market),
            strategyKey: process.env.STRATEGY_TYPE || "ichimoku-cloud",
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
        const impactFee = closeRes.breakdown?.priceImpactFee ?? 0;
        const protocolFee = closeRes.fee ?? closeFee + impactFee;
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

        const totalExitFees = protocolFee + swapFee + borrowFee + txFee - fundingFee; // Subtract because fundingFee is already signed

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
          entryAdx: pos.entryAdx,
          exitAdx: strategy.adx,
          openTime: pos.openTime,
          exitTime: exitTs ?? candle.closeTime,
          sizeUsd: pos.sizeUsd,
          quantity: pos.quantity,
          leverage: posLeverage,
          collateral: pos.collateral,
          grossPnl,
          pnlUsd: netPnl,
          totalPnlUsd: netPnl - (pos.entryFee || 0),
          pnlPct: ((netPnl - (pos.entryFee || 0)) / pos.collateral) * 100,
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
            adx: strategy.adx,
            atr: strategy.atr,
            action: "close",
            side: pos.side,
            reason,
            positionId: pos.id,
            fillPrice: price,
            stopPrice: reason.startsWith("ichimoku_hard_stop") ? (stopPrice ?? price) : null,
            extra: reason.startsWith("ichimoku_hard_stop")
              ? { tickPrice: currentPrices.get(market), stopLevel: stopPrice ?? price }
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
        if (typeof strategy.recordTrade === "function") {
          strategy.recordTrade(trade);
        }
      }
    } // End of tick loop

    // ============================================================
    // BAR CLOSE: update indicators (strategy exits are evaluated at next bar open)
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
          adx: strategy.adx,
          atr: strategy.atr,
          extra: { close: candle.close, high: candle.high, low: candle.low },
        });
      }
    }

    // NOTE (production parity): Strategy exits are evaluated at BAR OPEN only.
    // We do not evaluate strategy exits at candle close here.
  } // End of timestamp loop

  if (debugSignalReasons) {
    console.log("\n🧪 DEBUG_MULTI_MARKET_SIGNAL_REASONS");
    console.log("-".repeat(60));
    for (const market of candlesMap.keys()) {
      const a = signalActionStats.get(market) || { open: 0, hold: 0 };
      console.log(`  ${market}: open=${a.open}, hold=${a.hold}`);
      const m = signalReasonStats.get(market);
      if (!m || m.size === 0) continue;
      const top = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
      for (const [reason, count] of top) {
        console.log(`    - ${reason}: ${count}`);
      }
    }
  }

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
    const impactFee = closeRes.breakdown?.priceImpactFee ?? 0;
    const protocolFee = closeRes.fee ?? closeFee + impactFee;
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

    const totalExitFees = protocolFee + swapFee + borrowFee + txFee - fundingFee;
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
      entryAdx: pos.entryAdx,
      exitAdx: strategy?.adx,
      openTime: pos.openTime,
      exitTime: timestamps[timestamps.length - 1],
      sizeUsd: pos.sizeUsd,
      quantity: pos.quantity,
      leverage: marketLeverage,
      collateral: pos.collateral,
      grossPnl,
      pnlUsd: netPnl,
      totalPnlUsd: netPnl - (pos.entryFee || 0),
      pnlPct: ((netPnl - (pos.entryFee || 0)) / pos.collateral) * 100,
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
    // Static TP/SL exits (standalone mode for workflow)
    useRiskTP = false,
    stopLossPercent = 0,
    takeProfitPercent = 0,
    useTrailingStop = false,
    trailingStopPercent = 0,
    debug = false,
    verbose = false,
    allowLongs = true,
    allowShorts = true,
    simulateTicks = true,
    ticksPerCandle = TICKS_PER_15MIN_CANDLE,
    maxPositions = 1,
  } = options;

  const trace = options._trace;
  const traceModel = options._traceModel || "bot";
  const marketName = strategy?.cfg?.market || (options.symbol ? `${options.symbol}-PERP` : null);

  // Optional: use the same allocator scoring model as the bot for deterministic
  // signal quality + allocator-risk in single-market mode.
  const allocator =
    options.allocatorUseBotScoring !== false
      ? new MarketAllocator({
          markets: marketName ? [marketName] : [],
          exploreProbability: options.allocatorExploreProbability ?? 0,
          riskRecommendation: {
            enabled: options.allocatorRiskEnabled ?? false,
            neutral: options.allocatorRiskNeutral ?? false,
          },
        })
      : null;

  // Fee configuration - uses FEE_MODEL env var (jupiter or drift)
  const feeCfg = buildFeeCfg();
  const makerFillSimEnabled =
    feeCfg.model === "drift" &&
    feeCfg.execMode === "maker" &&
    process.env.ENABLE_MAKER_FILL_SIM === "true";

  const trades = [];
  const positions = [];
  const pendingEntries = []; // scheduled fills (maker or taker fallback)
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
    fundingFees: 0,
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

  // Unified entry handler so maker/taker entries are applied consistently (timing + fees + trace).
  const openFilledEntry = ({
    id,
    side,
    execMode,
    fillPrice,
    fillTs,
    barIndex,
    tickIndex,
    barOpenPrice,
    sizeUsd,
    lev,
    entryReason,
    hardStopPercentOverride,
    hardStopAtrMultOverride,
  }) => {
    let filledEntryPrice = fillPrice;
    if (execMode === "taker") {
      const before = filledEntryPrice;
      filledEntryPrice = applyTakerEntrySlippage(
        filledEntryPrice,
        side,
        sizeUsd,
        marketName,
        strategy?.atr
      );
      if (Number.isFinite(before) && before > 0 && Number.isFinite(filledEntryPrice)) {
        const slipUsd = sizeUsd * Math.abs(filledEntryPrice / before - 1);
        if (Number.isFinite(slipUsd) && slipUsd > 0) {
          feeBreakdown.slippageUsd += slipUsd;
          feeBreakdown.slippageEntryUsd += slipUsd;
        }
      }
    }

    const position = openPosition({
      id,
      side,
      price: filledEntryPrice,
      ts: fillTs,
      sizeUsd,
      leverage: lev,
    });
    if (!position) return null;

    const openRes = feeCfg.calculateOpenFee
      ? feeCfg.calculateOpenFee(sizeUsd, { execMode })
      : { fee: sizeUsd * (feeCfg.openFeeBps / 10_000), breakdown: {} };
    const openFee =
      openRes.breakdown?.baseFee ?? openRes.fee ?? sizeUsd * (feeCfg.openFeeBps / 10_000);
    const impactFee = openRes.breakdown?.priceImpactFee ?? 0;
    const protocolFee = openRes.fee ?? openFee + impactFee;
    const txFee = calculateSolanaTransactionFees(filledEntryPrice, feeCfg);
    const totalEntryFees = protocolFee + txFee;

    totalFees += totalEntryFees;
    realisedPnl -= totalEntryFees;
    feeBreakdown.openFees += openFee;
    feeBreakdown.impactFees += impactFee;
    feeBreakdown.txFees += txFee;

    position.entryFees = { openFee, impactFee, txFee, total: totalEntryFees, execMode };
    position.entryFee = totalEntryFees;
    position.entryExecMode = execMode;
    position.entryAtr = Number.isFinite(strategy.atr) ? strategy.atr : null;
    position.atrAtEntry = position.entryAtr;
    if (Number.isFinite(hardStopPercentOverride) && hardStopPercentOverride > 0) {
      position.stopLossPercentOverride = hardStopPercentOverride;
    }
    if (Number.isFinite(hardStopAtrMultOverride) && hardStopAtrMultOverride > 0) {
      position.hardStopAtrMultOverride = hardStopAtrMultOverride;
    }
    position.openBarIndex = barIndex;
    position.entryReason = entryReason || "ichimoku_signal";
    position.market = marketName;
    position.highWaterMark = position.entryPrice;
    position.lowWaterMark = position.entryPrice;

    positions.push(position);

    if (trace) {
      trace.push({
        model: traceModel,
        kind: "entry",
        ts: fillTs,
        market: marketName,
        barIndex,
        tickIndex,
        price: Number.isFinite(barOpenPrice) ? barOpenPrice : fillPrice,
        adx: strategy.adx,
        atr: position.entryAtr,
        action: "open",
        side: position.side,
        confidence: null,
        reason: position.entryReason,
        positionId: position.positionId || position.id,
        fillPrice: filledEntryPrice,
      });
    }

    return position;
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

  const getUsedMargin = () => {
    const open = positions.reduce((s, p) => s + (p.collateral || p.sizeUsd / leverage), 0);
    const pending = pendingEntries.reduce((s, p) => s + (p.collateral || 0), 0);
    return open + pending;
  };
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

  const warmupBars = Number.isFinite(strategy?.cfg?.minBars) ? strategy.cfg.minBars : 0;
  let lastBarCloseUpdatedIdx = -1;
  let globalTick = 0;

  const oneMinCandles = options.oneMinCandles;
  const riskStopLossPct = Number(stopLossPercent);
  const riskTakeProfitPct = Number(takeProfitPercent);
  const riskTrailEnabled = useTrailingStop === true && Number(trailingStopPercent) > 0;
  const riskTrailPct = Number(trailingStopPercent);

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
      lastBarCloseUpdatedIdx = barIndex - 1;
      if (trace) {
        trace.push({
          model: traceModel,
          kind: "bar_close_update",
          ts: prev.closeTime,
          market: marketName,
          barIndex: barIndex - 1,
          tickIndex: ticksPerCandle - 1,
          price: prev.close,
          adx: strategy.adx,
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
      // Production parity mode: indicators update only on bar close, so we DO NOT call recalculateLastBar().
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
          adx: strategy.adx,
          atr: strategy.atr,
        });
      }

      if (options.parityChecks && tickIndex === 0 && lastBarCloseUpdatedIdx !== barIndex - 1) {
        throw new Error(
          `[PARITY] Illegal sequencing at bar ${barIndex}: expected last bar-close update idx=${barIndex - 1}, got ${lastBarCloseUpdatedIdx}`
        );
      }

      // Fill any scheduled entries for this bar/tick (maker fill or delayed taker fallback).
      for (let i = pendingEntries.length - 1; i >= 0; i--) {
        const pe = pendingEntries[i];
        if (!pe || pe.barIndex !== barIndex || pe.fillIndex !== tickIndex) continue;
        pendingEntries.splice(i, 1);
        openFilledEntry({
          id: pe.id,
          side: pe.side,
          execMode: pe.execMode,
          fillPrice: pe.fillPrice,
          fillTs: pe.fillTs,
          barIndex,
          tickIndex,
          barOpenPrice: candle.open,
          sizeUsd: pe.sizeUsd,
          lev: pe.leverage,
          entryReason: pe.entryReason,
          hardStopPercentOverride: pe.hardStopPercentOverride,
          hardStopAtrMultOverride: pe.hardStopAtrMultOverride,
        });
      }

      // Exits:
      // - Liquidation checks happen on every tick (margin breach)
      // - Hard stops can happen on any tick (per tick).
      // - Bar-based strategy exits are evaluated only at BAR OPEN (tickIndex=0) using the previous bar close.
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
          if (makerFillSimEnabled) makerExitStats.forcedTaker++;

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
            const entryFee = Number(pos.entryFee ?? pos.entryFees?.total) || 0;
            const totalPnlUsd = netPnl - entryFee;

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
              totalPnlUsd,
              pnlPct: (totalPnlUsd / Math.max(1e-9, collateral)) * 100,
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
              entryFee,
              exitFee: totalExitFees,
              exitAdx: strategy.adx,
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
                adx: strategy.adx,
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
              adx: strategy.adx,
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

        // Update trailing watermarks for ATR trailing logic.
        if (pos.side === "long") {
          pos.highWaterMark = Math.max(Number(pos.highWaterMark || pos.entryPrice), tickPrice);
        } else if (pos.side === "short") {
          pos.lowWaterMark = Math.min(Number(pos.lowWaterMark || pos.entryPrice), tickPrice);
        }

        let exit = null;
        if (useRiskTP) {
          const collateral = Number(pos.collateral);
          const qty = Number(pos.quantity);
          const entry = Number(pos.entryPrice);
          if (
            Number.isFinite(collateral) &&
            collateral > 0 &&
            Number.isFinite(qty) &&
            qty > 0 &&
            Number.isFinite(entry) &&
            entry > 0
          ) {
            const dir = pos.side === "short" ? -1 : 1;
            const rawPnl = dir * (tickPrice - entry) * qty;
            const pnlPct = (rawPnl / collateral) * 100;

            if (Number.isFinite(pnlPct)) {
              const prevBest = Number.isFinite(pos.highestPnlPct)
                ? Number(pos.highestPnlPct)
                : pnlPct;
              pos.highestPnlPct = Math.max(prevBest, pnlPct);

              // RiskManager parity (bot.js): stop loss evaluated before take profit.
              if (
                Number.isFinite(riskStopLossPct) &&
                riskStopLossPct > 0 &&
                pnlPct <= -riskStopLossPct
              ) {
                exit = { close: true, reason: "STOP_LOSS", pnlPct };
              } else if (
                Number.isFinite(riskTakeProfitPct) &&
                riskTakeProfitPct > 0 &&
                pnlPct >= riskTakeProfitPct
              ) {
                exit = { close: true, reason: "TAKE_PROFIT", pnlPct };
              } else if (riskTrailEnabled && Number.isFinite(prevBest) && prevBest > 0) {
                const ddFromPeak = prevBest - pnlPct;
                if (Number.isFinite(ddFromPeak) && ddFromPeak >= riskTrailPct) {
                  exit = { close: true, reason: "TRAILING_STOP", pnlPct };
                }
              }
            }
          }
        } else {
          exit = strategy.shouldClose(pos, tickPrice);
        }
        if (exit?.close) {
          const exitReason = exit.reason;
          const exitRefPrice = tickPrice;

          // Determine exit mode based on reason (bar-based exits can use maker)
          const preferredExitMode = getExitExecModeForReason(exitReason, feeCfg.execMode);
          let exitExecMode = makerFillSimEnabled ? preferredExitMode : "taker";
          let filledExitPrice = exitRefPrice;
          let filledExitTs = tickTs;

          // Use intra-bar tick path + fallback timeout to decide if maker exit fills.
          if (makerFillSimEnabled && preferredExitMode === "maker") {
            makerExitStats.attempts++;
            const exitSim = simulateDriftMakerExitFill({
              market: `${pos.market}-PERP`,
              strategyKey: process.env.STRATEGY_TYPE || "ichimoku-cloud",
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
          } else if (makerFillSimEnabled && preferredExitMode === "taker") {
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
          const impactFee = closeRes.breakdown?.priceImpactFee ?? 0;
          const protocolFee = closeRes.fee ?? closeFee + impactFee;
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

          const totalExitFees = protocolFee + swapFee + borrowFee + txFee - fundingFee;

          totalFees += totalExitFees;
          feeBreakdown.closeFees += closeFee;
          feeBreakdown.impactFees += impactFee;
          feeBreakdown.swapFees += swapFee;
          feeBreakdown.borrowFees += borrowFee;
          feeBreakdown.fundingFees += fundingFee;
          feeBreakdown.txFees += txFee;
          feeBreakdown.totalTrades++;

          const grossPnl = pnl.pnlUsd;
          const exitFee = totalExitFees;
          const entryFee = Number(pos.entryFee ?? pos.entryFees?.total) || 0;
          const pnlUsd = grossPnl - exitFee; // excludes entry fees (already deducted at entry time)
          const totalPnlUsd = pnlUsd - entryFee;

          pnl.pnlUsd = pnlUsd;
          pnl.fees = { closeFee, impactFee, swapFee, borrowFee, fundingFee, txFee, exitExecMode };
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
              adx: strategy.adx,
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
          trades.push({
            id: pos.positionId || pos.id,
            market: marketName,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: filledExitPrice,
            openTime: pos.openTime,
            exitTime: filledExitTs,
            sizeUsd: pos.sizeUsd,
            quantity: pos.quantity,
            leverage: pos.leverage,
            collateral: pos.collateral,
            grossPnl,
            pnlUsd,
            totalPnlUsd,
            pnlPct: (totalPnlUsd / Math.max(1e-9, pos.collateral)) * 100,
            exitReason: exit.reason,
            entryFee,
            exitFee,
            entryExecMode: pos.entryExecMode || pos.entryFees?.execMode || "taker",
            exitExecMode,
          });

          currentEquity = initialCapital + realisedPnl;
          if (typeof strategy.recordTrade === "function") {
            strategy.recordTrade({
              pnlUsd: totalPnlUsd,
              pnlPercent: totalPnlUsd / Math.max(1e-9, pos.collateral),
              exitReason: exit.reason,
            });
          }
        }
      }

      // Skip entries during warmup
      if (barIndex < warmupBars) continue;

      // Evaluate entry only at BAR OPEN (tickIndex=0) using previous bar close indicators.
      if (tickIndex === 0 && positions.length + pendingEntries.length < maxPositions) {
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
            adx: strategy.adx,
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

          // Base values from config. Allocator risk (if enabled) adjusts these.
          const baseLeverage = leverage;
          const baseHardStopPct = strategy?.cfg?.hardStopPercent ?? 0;
          const baseHardStopAtr = strategy?.cfg?.hardStopAtrMult ?? 0;
          let effectiveLeverage = baseLeverage;
          let effectiveHardStopPct = baseHardStopPct;
          let effectiveHardStopAtr = baseHardStopAtr;

          // Single-market allocator risk: apply quality-based size/leverage even without competition.
          if (
            allocator &&
            typeof allocator.evaluateOpportunities === "function" &&
            typeof allocator.recommendRiskMultipliersBatch === "function" &&
            (allocator?.riskRecommendation?.enabled ||
              allocator?.riskRecommendation?.ichimoku?.enabled)
          ) {
            try {
              const allMarketSignals = [
                {
                  market: marketName,
                  signal: { ...signal, strategyType: "ichimoku-cloud" },
                  priceData: { price: candle.open, atr: strategy?.atr },
                },
              ];
              const ranked = allocator.evaluateOpportunities(
                allMarketSignals,
                positions.map((p) => ({ ...p, market: marketName })),
                {},
                new Map()
              );
              const score = ranked?.[0]?.score ?? 0;
              const batch = [
                {
                  market: marketName,
                  signal,
                  priceData: { price: candle.open, atr: strategy?.atr },
                  score,
                  strategyType: "ichimoku-cloud",
                },
              ];
              const m = allocator.recommendRiskMultipliersBatch(batch);
              const key = `${marketName}:${side}`;
              const mult = m.get(key);
              if (mult) {
                collateral *= Number.isFinite(mult.finalSizeMult) ? mult.finalSizeMult : 1;
                effectiveLeverage *= Number.isFinite(mult.finalLevMult) ? mult.finalLevMult : 1;

                // Mirror allocator rounding/clamps (recommendRisk()).
                const step = Number(allocator?.riskRecommendation?.leverage?.roundStep);
                if (Number.isFinite(step) && step > 0) {
                  effectiveLeverage = Math.round(effectiveLeverage / step) * step;
                }
                const levMin = Number(allocator?.riskRecommendation?.leverage?.min ?? 1);
                const levMax = Number(allocator?.riskRecommendation?.leverage?.max ?? 100);
                effectiveLeverage = Math.max(levMin, Math.min(levMax, effectiveLeverage));

                // Price-space invariant: scale hard stop % proportionally with leverage.
                effectiveHardStopPct =
                  baseHardStopPct > 0 && baseLeverage > 0
                    ? baseHardStopPct * (effectiveLeverage / baseLeverage)
                    : baseHardStopPct;
                effectiveHardStopAtr = baseHardStopAtr;
              }
            } catch (e) {
              if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
                console.warn("[ALLOCATOR_RISK] single-market apply failed (ignored):", e);
              }
            }
          }

          // Clamp collateral after multipliers (never exceed available)
          if (collateral > available + 0.01) collateral = Math.max(0, available * 0.95);
          if (collateral <= 0) continue;

          let sizeUsd = collateral * effectiveLeverage;

          // AUDIT FIX: Apply liquidity constraint / position size cap
          // Disabled by default - enable with ENABLE_LIQUIDITY_CAPS=true
          if (process.env.ENABLE_LIQUIDITY_CAPS === "true") {
            const tradeCheck = shouldSkipTrade(marketName, sizeUsd, { strict: false });
            if (tradeCheck.skip) continue;
            if (tradeCheck.capped) {
              sizeUsd = tradeCheck.cappedSize;
              collateral = sizeUsd / effectiveLeverage;
            }
          }

          const entryReason = signal.reason || "ichimoku_signal";
          const id = `bot-${++tradeCounter}`;

          // Default: immediate fill at bar open.
          let execMode = makerFillSimEnabled ? "maker" : "taker";
          let fillPrice = candle.open;
          let fillIndex = 0;
          let fillTs = candle.openTime;

          if (makerFillSimEnabled) {
            makerEntryStats.attempts++;
            const entrySim = simulateDriftMakerEntryFill({
              market: marketName,
              strategyKey: process.env.STRATEGY_TYPE || "ichimoku-cloud",
              side,
              refPrice: candle.open,
              candle,
              ticks: intraBarTicks,
              tickTimestamps,
              startTickIndex: tickIndex,
              tickIntervalMs: TICK_INTERVAL_MS,
              positionSizeUsd: sizeUsd,
              volatility: strategy?.atr && candle.open ? strategy.atr / candle.open : 0.02,
            });
            if (entrySim.outcome === "maker_fill") makerEntryStats.makerFills++;
            if (entrySim.outcome === "taker_fallback") makerEntryStats.takerFallbacks++;
            if (entrySim.outcome === "no_fill") {
              makerEntryStats.noFills++;
              continue;
            }
            execMode = entrySim.execMode || "taker";
            fillPrice = entrySim.fillPrice ?? candle.open;
            fillIndex = Number.isFinite(entrySim.fillIndex) ? entrySim.fillIndex : 0;
            fillTs = Number.isFinite(entrySim.fillTs)
              ? entrySim.fillTs
              : (tickTimestamps[fillIndex] ?? candle.openTime + fillIndex * TICK_INTERVAL_MS);
          }

          // If fill is delayed (maker fill or delayed taker fallback), schedule it.
          if (fillIndex > tickIndex) {
            pendingEntries.push({
              id,
              side,
              execMode,
              fillPrice,
              fillTs,
              fillIndex,
              barIndex,
              sizeUsd,
              leverage: effectiveLeverage,
              collateral,
              entryReason,
              hardStopPercentOverride: effectiveHardStopPct,
              hardStopAtrMultOverride: effectiveHardStopAtr,
            });
            continue;
          }

          // Immediate fill at bar open
          const pos = openFilledEntry({
            id,
            side,
            execMode,
            fillPrice,
            fillTs,
            barIndex,
            tickIndex,
            barOpenPrice: candle.open,
            sizeUsd,
            lev: effectiveLeverage,
            entryReason,
            hardStopPercentOverride: effectiveHardStopPct,
            hardStopAtrMultOverride: effectiveHardStopAtr,
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
      const adxLabel = Number.isFinite(strategy.adx) ? strategy.adx.toFixed(1) : "n/a";
      const atrLabel = Number.isFinite(strategy.atr) ? strategy.atr.toFixed(4) : "n/a";
      console.log(
        `[BOT-MODEL ${barIndex}] ADX=${adxLabel} ATR=${atrLabel} price=${closePrice.toFixed(2)}`
      );
    }
  }

  // Force close remaining
  for (const pos of [...positions]) {
    const last = candles[candles.length - 1];
    const exitPrice = last.close;
    const ts = last.closeTime;
    const pnl = exitPosition(pos, exitPrice, ts, { reason: "end_of_backtest" });

    const exitExecMode = "taker";
    const currentNotional = pos.quantity * exitPrice;
    const closeRes = feeCfg.calculateCloseFee
      ? feeCfg.calculateCloseFee(currentNotional, { execMode: exitExecMode })
      : { fee: currentNotional * (feeCfg.closeFeeBps / 10_000), breakdown: {} };
    const closeFee =
      closeRes.breakdown?.baseFee ??
      closeRes.fee ??
      currentNotional * (feeCfg.closeFeeBps / 10_000);
    const impactFee = closeRes.breakdown?.priceImpactFee ?? 0;
    const protocolFee = closeRes.fee ?? closeFee + impactFee;
    const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(pos.collateral);
    const lastBorrowTs = Number.isFinite(pos.lastBorrowTs) ? pos.lastBorrowTs : pos.openTime;
    const borrowFee =
      feeCfg.model === "drift"
        ? 0
        : calculateBorrowFeeUsd(pos.sizeUsd, Math.max(0, ts - lastBorrowTs));
    const txFee = calculateSolanaTransactionFees(exitPrice, feeCfg);
    const holdDurationMs = ts - pos.openTime;
    const fundingFee =
      typeof estimateFundingCost === "function"
        ? estimateFundingCost(
            pos.side,
            pos.sizeUsd,
            holdDurationMs,
            getMarketFundingRate(pos.market)
          )
        : 0;
    const totalExitFees = protocolFee + swapFee + borrowFee + txFee - fundingFee;

    const grossPnl = pnl.pnlUsd;
    const pnlUsd = grossPnl - totalExitFees;
    const entryFee = Number(pos.entryFee ?? pos.entryFees?.total) || 0;
    const totalPnlUsd = pnlUsd - entryFee;

    realisedPnl += pnlUsd;
    totalFees += totalExitFees;
    feeBreakdown.closeFees += closeFee;
    feeBreakdown.impactFees += impactFee;
    feeBreakdown.swapFees += swapFee;
    feeBreakdown.borrowFees += borrowFee;
    feeBreakdown.fundingFees += fundingFee;
    feeBreakdown.txFees += txFee;
    feeBreakdown.totalTrades++;

    trades.push({
      id: pos.positionId || pos.id,
      market: marketName,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      openTime: pos.openTime,
      exitTime: ts,
      sizeUsd: pos.sizeUsd,
      quantity: pos.quantity,
      leverage: pos.leverage,
      collateral: pos.collateral,
      grossPnl,
      pnlUsd,
      totalPnlUsd,
      pnlPct: (totalPnlUsd / Math.max(1e-9, pos.collateral)) * 100,
      exitReason: "end_of_backtest",
      entryFee,
      exitFee: totalExitFees,
      entryExecMode: pos.entryExecMode || pos.entryFees?.execMode || "taker",
      exitExecMode,
    });
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
    ticksPerCandle = TICKS_PER_15MIN_CANDLE,
    simulateTicks = true,
  } = options;

  const trace = options._trace;
  const traceModel = options._traceModel || "bot";

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
  const pendingEntries = []; // scheduled fills (maker or delayed taker fallback)
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

  const openFilledEntry = ({
    id,
    marketKey,
    side,
    execMode,
    fillPrice,
    fillTs,
    barIndex,
    tickIndex,
    barOpenPrice,
    sizeUsd,
    lev,
    collateral,
    entryReason,
    allocatorRiskApplied,
  }) => {
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;
    let filledEntryPrice = fillPrice;
    if (execMode === "taker") {
      const before = filledEntryPrice;
      filledEntryPrice = applyTakerEntrySlippage(
        filledEntryPrice,
        side,
        sizeUsd,
        `${marketKey}-PERP`,
        strategiesMap.get(marketKey)?.atr
      );
      if (Number.isFinite(before) && before > 0 && Number.isFinite(filledEntryPrice)) {
        const slipUsd = sizeUsd * Math.abs(filledEntryPrice / before - 1);
        if (Number.isFinite(slipUsd) && slipUsd > 0) {
          feeBreakdown.slippageUsd += slipUsd;
          feeBreakdown.slippageEntryUsd += slipUsd;
        }
      }
    }

    const quantity = sizeUsd / filledEntryPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) return null;

    const openRes = feeCfg.calculateOpenFee
      ? feeCfg.calculateOpenFee(sizeUsd, { execMode })
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

    const strategy = strategiesMap.get(marketKey);
    const position = {
      id,
      market: `${marketKey}-PERP`,
      marketKey,
      side,
      entryPrice: filledEntryPrice,
      entryAtr: Number.isFinite(strategy?.atr) ? strategy.atr : null,
      atrAtEntry: Number.isFinite(strategy?.atr) ? strategy.atr : null,
      openTime: fillTs,
      lastBorrowTs: fillTs,
      sizeUsd,
      quantity,
      collateral,
      leverage: lev,
      entryFee: totalEntryFees,
      entryExecMode: execMode,
      allocatorRiskApplied,
      entryReason,
    };
    position.openBarIndex = barIndex;
    position.highWaterMark = position.entryPrice;
    position.lowWaterMark = position.entryPrice;

    allPositions.push(position);
    marketResults.get(marketKey).totalPnL -= totalEntryFees;
    marketResults.get(marketKey).totalFees += totalEntryFees;

    if (trace) {
      trace.push({
        model: traceModel,
        kind: "entry",
        ts: fillTs,
        market: `${marketKey}-PERP`,
        barIndex,
        tickIndex,
        price: Number.isFinite(barOpenPrice) ? barOpenPrice : filledEntryPrice,
        adx: strategy?.adx ?? null,
        atr: position.entryAtr,
        action: "open",
        side: position.side,
        confidence: null,
        reason: entryReason,
        positionId: position.id,
        fillPrice: filledEntryPrice,
      });
    }

    return position;
  };

  const getLockedCollateral = () => {
    const open = allPositions.reduce((s, p) => s + (p.collateral || 0), 0);
    const pending = pendingEntries.reduce((s, p) => s + (p.collateral || 0), 0);
    return open + pending;
  };
  const getAvailableCapital = () => {
    const locked = getLockedCollateral();
    const base = enableCompounding ? initialCapital + realisedPnl : initialCapital;
    return Math.max(0, base - locked);
  };
  const getPositionCollateral = () => {
    const base = getAvailableCapital() * (positionSizePercent / 100);
    return Math.max(0, Math.min(base, options.maxPositionSize || 5000));
  };

  // Build unified timestamp set (15m bar opens)
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
              adx: strategy.adx,
              atr: strategy.atr,
            });
          }
        }
      }
    }

    // Generate ticks for each market candle (NO LOOK-AHEAD):
    // Use real 1m candles → 15s ticks. Never synthesize from 15m OHLC.
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
          adx: strategy?.adx ?? null,
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

      // Production parity mode: indicators update on bar close; intra-bar ticks are for stops/trailing.
      for (const [market, candle] of marketCandles.entries()) {
        const strategy = strategiesMap.get(market);
        if (!strategy) continue;
        const tickPrice = currentPrices.get(market);
        const tickTs =
          candle.openTime + tickIndex * (intervalToMs(options.interval || "15m") / ticksPerCandle);

        if (typeof strategy.updateTick === "function") {
          strategy.updateTick({ price: tickPrice, volume: 0, ts: tickTs });
        }
      }

      // Fill any scheduled entries (maker or delayed taker fallback) for this tick.
      const tickIntervalMs = intervalToMs(options.interval || "15m") / ticksPerCandle;
      for (let i = pendingEntries.length - 1; i >= 0; i--) {
        const pe = pendingEntries[i];
        if (!pe || pe.barOpenTime !== ts || pe.fillIndex !== tickIndex) continue;
        pendingEntries.splice(i, 1);

        const candle = marketCandles.get(pe.marketKey);
        if (!candle) continue;
        const barIndex = candleIndexMaps.get(pe.marketKey)?.get(ts) ?? null;
        const fillTs = Number.isFinite(pe.fillTs)
          ? pe.fillTs
          : candle.openTime + tickIndex * tickIntervalMs;

        openFilledEntry({
          id: pe.id,
          marketKey: pe.marketKey,
          side: pe.side,
          execMode: pe.execMode,
          fillPrice: pe.fillPrice,
          fillTs,
          barIndex,
          tickIndex,
          barOpenPrice: candle.open,
          sizeUsd: pe.sizeUsd,
          lev: pe.leverage,
          collateral: pe.collateral,
          entryReason: pe.entryReason,
          allocatorRiskApplied: pe.allocatorRiskApplied,
        });
      }

      // Exits:
      // - Liquidation checks happen on every tick (margin breach)
      // - Hard stops can happen on any tick (per tick).
      // - Bar-based strategy exits are evaluated only at BAR OPEN (tickIndex=0).
      for (const pos of [...allPositions]) {
        const market = pos.marketKey;
        const strategy = strategiesMap.get(market);
        const tickPrice = currentPrices.get(market) || pos.entryPrice;
        const candle = marketCandles.get(market);
        const tickTs = candle
          ? candle.openTime + tickIndex * (intervalToMs(options.interval || "15m") / ticksPerCandle)
          : ts;

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
          if (makerFillSimEnabled) makerExitStats.forcedTaker++;

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
              exitAdx: null,
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
                adx: strategy?.adx ?? null,
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
              adx: strategy?.adx ?? null,
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

        // Strategy exits (bar-based or tick-based depending on strategy)
        if (pos.side === "long") {
          pos.highWaterMark = Math.max(Number(pos.highWaterMark || pos.entryPrice), tickPrice);
        } else if (pos.side === "short") {
          pos.lowWaterMark = Math.min(Number(pos.lowWaterMark || pos.entryPrice), tickPrice);
        }
        const exit = strategy?.shouldClose(pos, tickPrice);
        if (!exit?.close) continue;

        const exitReason = exit.reason;
        const exitRefPrice = tickPrice;
        let filledExitTs = tickTs;

        // Determine exit mode based on reason (strategy exits can use maker)
        const preferredExitMode = getExitExecModeForReason(exitReason, feeCfg.execMode);
        let exitExecMode = makerFillSimEnabled ? preferredExitMode : "taker";
        let filledExitPrice = exitRefPrice;

        if (makerFillSimEnabled && preferredExitMode === "maker") {
          makerExitStats.attempts++;
          // Tick-aware maker exit fill simulation needs the current market's tick stream.
          // marketTicks may contain either numeric prices or {price, ts} objects.
          const rawTicksForMarket = marketTicks.get(market) || [];
          const ticksForMarket = rawTicksForMarket.map((t) =>
            typeof t === "number" ? t : Number(t?.price)
          );
          const tickIntervalMs = intervalToMs(options.interval || "15m") / ticksPerCandle;
          const tickTimestampsForMarket = rawTicksForMarket.map((t, i) => {
            const tsVal = typeof t === "object" && t && Number.isFinite(t.ts) ? t.ts : null;
            if (Number.isFinite(tsVal)) return tsVal;
            // Derive timestamp if not provided by tick source
            return candle ? candle.openTime + i * tickIntervalMs : null;
          });
          const exitSim = simulateDriftMakerExitFill({
            market: `${market}-PERP`,
            strategyKey: process.env.STRATEGY_TYPE || "ichimoku-cloud",
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
              exitSim.fillIndex * (intervalToMs(options.interval || "15m") / ticksPerCandle);
          }
        } else if (makerFillSimEnabled && preferredExitMode === "taker") {
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
        const impactFee = closeRes.breakdown?.priceImpactFee ?? 0;
        const protocolFee = closeRes.fee ?? closeFee + impactFee;
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

        const totalExitFees = protocolFee + swapFee + borrowFee + txFee - fundingFee;
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
          entryAdx: pos.entryAdx,
          exitAdx: strategy?.adx ?? null,
          openTime: pos.openTime,
          exitTime: filledExitTs,
          sizeUsd: pos.sizeUsd,
          quantity: pos.quantity,
          leverage: pos.leverage,
          collateral: pos.collateral,
          grossPnl,
          pnlUsd: netPnl,
          totalPnlUsd: netPnl - (pos.entryFee || 0),
          pnlPct: ((netPnl - (pos.entryFee || 0)) / pos.collateral) * 100,
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
            adx: strategy?.adx ?? null,
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

        // Only consider opens if we have capacity and no position in market (bot allocator enforces max per market)
        const hasPosInMarket =
          allPositions.some((p) => p.marketKey === market) ||
          pendingEntries.some((p) => p.marketKey === market);
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
            adx: strategy.adx,
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
            strategyType: "ichimoku-cloud",
            signal: sig,
            priceData: { price: tickPrice },
          });
        }
      }

      if (
        signals.length > 0 &&
        allocator &&
        allPositions.length + pendingEntries.length < maxPositions
      ) {
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

        // Allocator-driven risk (batch): compute multipliers once so when multiple markets
        // are selected on the same bar, the inferior pick is de-risked.
        let allocatorRiskMults = null;
        if (
          allocator &&
          typeof allocator.recommendRiskMultipliersBatch === "function" &&
          (allocator?.riskRecommendation?.enabled ||
            allocator?.riskRecommendation?.ichimoku?.enabled)
        ) {
          const batch = selected
            .map((opp) => {
              const marketKey = String(opp.market || "").replace("-PERP", "");
              const candle = marketCandles.get(marketKey);
              const entryPrice = candle?.open;
              const strategy = strategiesMap.get(marketKey);
              if (!Number.isFinite(entryPrice)) return null;
              return {
                market: opp.market,
                signal: opp.signal,
                priceData: { price: entryPrice, atr: strategy?.atr },
                score: opp.score ?? 0,
                strategyType: "ichimoku-cloud",
              };
            })
            .filter(Boolean);
          allocatorRiskMults = allocator.recommendRiskMultipliersBatch(batch);
        }

        for (const opp of selected) {
          if (allPositions.length + pendingEntries.length >= maxPositions) break;
          const marketKey = String(opp.market || "").replace("-PERP", "");
          const candle = marketCandles.get(marketKey);
          const entryPrice = candle?.open;
          if (!Number.isFinite(entryPrice)) continue;
          const available = getAvailableCapital();

          // Base values from config/per-market overrides
          const strategy = strategiesMap.get(marketKey);
          const baseSizePct = positionSizePercent;
          const baseLeverage = options.perMarketLeverage?.get(marketKey) || leverage;
          const baseHardStopPct = strategy?.cfg?.hardStopPercent ?? 0;
          const baseHardStopAtr = strategy?.cfg?.hardStopAtrMult ?? 0;

          // === ALLOCATOR RISK RECOMMENDATION ===
          // When enabled, dynamically adjust size/leverage/stops based on signal quality
          let effectiveSizePct = baseSizePct;
          let effectiveLeverage = baseLeverage;
          let effectiveHardStopPct = baseHardStopPct;
          let effectiveHardStopAtr = baseHardStopAtr;
          let allocatorRiskApplied = null;

          if (allocatorRiskMults && allocator) {
            const key = `${marketKey}-PERP:${String(opp.signal?.side || "").toLowerCase()}`;
            const mult = allocatorRiskMults.get(key);
            if (mult) {
              effectiveSizePct =
                baseSizePct * (Number.isFinite(mult.finalSizeMult) ? mult.finalSizeMult : 1);
              effectiveLeverage =
                baseLeverage * (Number.isFinite(mult.finalLevMult) ? mult.finalLevMult : 1);

              // Mirror allocator rounding/clamps (recommendRisk()).
              const step = Number(allocator?.riskRecommendation?.leverage?.roundStep);
              if (Number.isFinite(step) && step > 0) {
                effectiveLeverage = Math.round(effectiveLeverage / step) * step;
              }
              const levMin = Number(allocator?.riskRecommendation?.leverage?.min ?? 1);
              const levMax = Number(allocator?.riskRecommendation?.leverage?.max ?? 100);
              effectiveLeverage = Math.max(levMin, Math.min(levMax, effectiveLeverage));

              // Price-space invariant: scale hard stop % proportionally with leverage.
              effectiveHardStopPct =
                baseHardStopPct > 0 && baseLeverage > 0
                  ? baseHardStopPct * (effectiveLeverage / baseLeverage)
                  : baseHardStopPct;
              effectiveHardStopAtr = baseHardStopAtr;

              allocatorRiskApplied = {
                quality: mult.quality,
                rankMult: mult.rankMult,
                sizePct: { base: baseSizePct, effective: effectiveSizePct },
                leverage: { base: baseLeverage, effective: effectiveLeverage },
                hardStopPct: { base: baseHardStopPct, effective: effectiveHardStopPct },
                hardStopAtr: { base: baseHardStopAtr, effective: effectiveHardStopAtr },
              };

              if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
                console.log(
                  `[ALLOCATOR_RISK] ${marketKey} q=${Number(mult.quality || 0).toFixed(2)} rank=${Number(mult.rankMult || 1).toFixed(2)} | size=${baseSizePct.toFixed(0)}→${effectiveSizePct.toFixed(0)}% lev=${baseLeverage.toFixed(1)}→${effectiveLeverage.toFixed(1)}x`
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

          const entryReason = opp.signal?.reason ?? null;
          const id = `bot-${++tradeCounter}`;

          // Default: immediate fill at bar open.
          let execMode = makerFillSimEnabled ? "maker" : "taker";
          let fillPrice = entryPrice;
          let fillIndex = 0;
          let fillTs = candle ? candle.openTime : ts;

          if (makerFillSimEnabled) {
            makerEntryStats.attempts++;
            const rawTicks = marketTicks.get(marketKey) || [];
            const ticksForMarket = rawTicks.map((t) =>
              typeof t === "number" ? t : Number(t?.price)
            );
            const tickIntervalMs = intervalToMs(options.interval || "15m") / ticksPerCandle;
            const tickTimestampsForMarket = rawTicks.map((t, i) => {
              const tsVal = typeof t === "object" && t && Number.isFinite(t.ts) ? t.ts : null;
              if (Number.isFinite(tsVal)) return tsVal;
              return candle ? candle.openTime + i * tickIntervalMs : null;
            });

            const sim = simulateDriftMakerEntryFill({
              market: `${marketKey}-PERP`,
              strategyKey: process.env.STRATEGY_TYPE || "ichimoku-cloud",
              side: opp.signal.side,
              refPrice: entryPrice,
              candle: candle || { high: entryPrice, low: entryPrice },
              ticks: ticksForMarket,
              tickTimestamps: tickTimestampsForMarket,
              startTickIndex: 0,
              tickIntervalMs,
              positionSizeUsd: sizeUsd,
              volatility: strategy?.atr && entryPrice ? strategy.atr / entryPrice : 0.02,
            });
            if (sim.outcome === "maker_fill") makerEntryStats.makerFills++;
            if (sim.outcome === "taker_fallback") makerEntryStats.takerFallbacks++;
            if (sim.outcome === "no_fill") {
              makerEntryStats.noFills++;
              continue;
            }
            execMode = sim.execMode || "taker";
            fillPrice = sim.fillPrice ?? entryPrice;
            fillIndex = Number.isFinite(sim.fillIndex) ? sim.fillIndex : 0;
            fillTs = Number.isFinite(sim.fillTs)
              ? sim.fillTs
              : (tickTimestampsForMarket[fillIndex] ??
                (candle ? candle.openTime + fillIndex * tickIntervalMs : ts));
          }

          const barIndex = candleIndexMaps.get(marketKey)?.get(ts) ?? null;
          if (fillIndex > 0) {
            pendingEntries.push({
              id,
              marketKey,
              side: opp.signal.side,
              execMode,
              fillPrice,
              fillTs,
              fillIndex,
              barOpenTime: ts,
              sizeUsd,
              leverage: marketLev,
              collateral,
              entryReason,
              allocatorRiskApplied,
            });
            continue;
          }

          openFilledEntry({
            id,
            marketKey,
            side: opp.signal.side,
            execMode,
            fillPrice,
            fillTs,
            barIndex,
            tickIndex: 0,
            barOpenPrice: entryPrice,
            sizeUsd,
            lev: marketLev,
            collateral,
            entryReason,
            allocatorRiskApplied,
          });
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

function withIchimokuOverridesOnStrategyConfig(strategyConfig, overrides) {
  const cfg = cloneJson(strategyConfig || {});
  cfg.quiet = true;
  cfg.ichimokuStrategy = cfg.ichimokuStrategy || {};
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined || v === null) continue;
    cfg.ichimokuStrategy[k] = v;
  }
  return cfg;
}

function buildStrategyConfigsMapWithGlobalOverrides(strategyConfigsMap, overrides) {
  const out = new Map();
  for (const [symbol, cfg] of strategyConfigsMap.entries()) {
    out.set(symbol, withIchimokuOverridesOnStrategyConfig(cfg, overrides));
  }
  return out;
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

    const strategy = new IchimokuCloudBreakoutStrategy(strategyConfig);
    const interval = options.interval || "15m";
    const tickSimEnabled = interval === "15m" || interval === "1m";
    const leverage = perMarketLeverage?.get(symbol) ?? options.leverage;
    const hardStopPercent = perMarketHardStop?.get(symbol) ?? options.hardStopPercent;

    const simFn = isBotModel ? simulateBotRuntimeSingleMarket : simulateIchimokuCloud;
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
      ticksPerCandle: tickSimEnabled ? TICKS_PER_15MIN_CANDLE : 1,
      oneMinCandles: oneMinCandlesMap?.get(symbol) || null,
      symbol,
      enableCompounding: options.enableCompounding,
      initialCapital: options.initialCapital,
      positionSizePercent: options.positionSizePercent,
      minPositionSize: options.minPositionSize,
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
    strategiesMap.set(symbol, new IchimokuCloudBreakoutStrategy(cfg));
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
    hardStopPercent: options.hardStopPercent,
    hardStopAtrMult: options.hardStopAtrMult,
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
 * Run jitter robustness suite: perturb key Ichimoku parameters and re-simulate.
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
    { name: "Tenkan +1", overrides: { tenkanPeriod: (options.tenkanPeriod || 9) + 1 } },
    {
      name: "Tenkan -1",
      overrides: { tenkanPeriod: Math.max(5, (options.tenkanPeriod || 9) - 1) },
    },
    { name: "Kijun +2", overrides: { kijunPeriod: (options.kijunPeriod || 26) + 2 } },
    { name: "Kijun -2", overrides: { kijunPeriod: Math.max(10, (options.kijunPeriod || 26) - 2) } },
    { name: "ADX Min +2", overrides: { adxMinTrend: (options.adxMinTrend || 20) + 2 } },
    {
      name: "ADX Min -2",
      overrides: { adxMinTrend: Math.max(5, (options.adxMinTrend || 20) - 2) },
    },
    {
      name: "Break Buffer ATR +0.05",
      overrides: { breakBufferAtr: Math.max(0, (options.breakBufferAtr || 0) + 0.05) },
    },
    {
      name: "Break Buffer ATR -0.05",
      overrides: { breakBufferAtr: Math.max(0, (options.breakBufferAtr || 0) - 0.05) },
    },
    {
      name: "Max Entry Dist ATR +0.25",
      overrides: { maxEntryDistAtr: (options.maxEntryDistAtr || 1.5) + 0.25 },
    },
    {
      name: "Max Entry Dist ATR -0.25",
      overrides: { maxEntryDistAtr: Math.max(0.5, (options.maxEntryDistAtr || 1.5) - 0.25) },
    },
    {
      name: "ATR Stop Mult +0.3",
      overrides: { atrStopMultiplier: (options.atrStopMultiplier || 2.8) + 0.3 },
    },
    {
      name: "ATR Stop Mult -0.3",
      overrides: { atrStopMultiplier: Math.max(1, (options.atrStopMultiplier || 2.8) - 0.3) },
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
 * @param {Object} overrides - Ichimoku strategy parameter overrides for targetSymbol
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
      // Apply strategy overrides to target market
      modifiedConfigsMap.set(symbol, withIchimokuOverridesOnStrategyConfig(baseConfig, overrides));
    } else {
      modifiedConfigsMap.set(symbol, baseConfig);
    }
  }

  // Build strategies from configs
  const strategiesMap = new Map();
  for (const [symbol, cfg] of modifiedConfigsMap.entries()) {
    strategiesMap.set(symbol, new IchimokuCloudBreakoutStrategy(cfg));
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
  const interval = options.interval || "15m";
  const tickSimEnabled = interval === "15m" || interval === "1m";

  const simResult = simFn(strategiesMap, candlesMap, {
    initialCapital: options.initialCapital,
    leverage: options.leverage,
    positionSizePercent: modifiedPositionSizePercent,
    enableCompounding: options.enableCompounding,
    debug: false,
    allowLongs: options.allowLongs,
    allowShorts: options.allowShorts,
    maxPositions: options.maxPositions,
    ticksPerCandle: tickSimEnabled ? TICKS_PER_15MIN_CANDLE : 1,
    simulateTicks: tickSimEnabled,
    hardStopPercent: options.hardStopPercent,
    hardStopAtrMult: options.hardStopAtrMult,
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
  // TypedCandleArrayProxy.filter() returns a raw TypedCandleArray (not proxied),
  // which breaks downstream code that expects array-like indexing. For WFA we keep it simple:
  // slice candles into plain object arrays per fold.
  const sliceCandlesToObjects = (candles, fromMs, toMs) => {
    const out = [];
    if (!candles) return out;
    for (const c of candles) {
      const ot = Number(c?.openTime);
      if (!Number.isFinite(ot)) continue;
      if (ot >= fromMs && ot < toMs) out.push(c);
    }
    return out;
  };

  const pickFinitePnl = (res, label) => {
    const v = res?.realisedPnl ?? res?.totalPnL ?? null;
    if (!Number.isFinite(v)) {
      throw new Error(`${label} returned non-finite PnL (${String(v)})`);
    }
    return v;
  };

  const {
    trainDays = 60, // Training window in days
    testDays = 30, // Test window in days
    stepDays = 30, // Step forward in days (rolling) or 0 for anchored
    mode = "rolling", // 'rolling' or 'anchored'
  } = config;

  const trainMs = trainDays * 24 * 60 * 60 * 1000;
  const testMs = testDays * 24 * 60 * 60 * 1000;
  const stepMs = stepDays * 24 * 60 * 60 * 1000;
  const stepMsEff = stepMs > 0 ? stepMs : testMs;

  const folds = [];
  let foldNum = 0;

  console.log(`\n🔄 Walk-Forward Analysis: ${mode} mode`);
  console.log(`   Train: ${trainDays}d, Test: ${testDays}d, Step: ${stepDays}d`);
  console.log(
    `   How to read this: each fold trains on earlier history and evaluates on a later, unseen window.`
  );
  console.log(
    `   Degradation = (TestPnL - TrainPnL) / |TrainPnL|. Large negative values imply overfitting/regime dependence.`
  );

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
        const trainCandles = sliceCandlesToObjects(candles, trainStart, trainEnd);
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
      const interval = options.interval || "15m";
      const tickSimEnabled = interval === "15m" || interval === "1m";

      // Build 1m candles and ticks for training period (if tick sim enabled)
      const trainOneMinCandlesMap = new Map();
      const trainTicksByBarOpenTimeMap = new Map();
      if (tickSimEnabled && oneMinCandlesMap) {
        for (const [symbol, oneMin] of oneMinCandlesMap.entries()) {
          const trainOneMin = sliceCandlesToObjects(oneMin, trainStart, trainEnd);
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
        trainStrategiesMap.set(symbol, new IchimokuCloudBreakoutStrategy(trainCfg));
      }

      let trainResult = simFn(trainStrategiesMap, trainCandlesMap, {
        initialCapital: options.initialCapital,
        leverage: options.leverage,
        positionSizePercent: options.positionSizePercent,
        enableCompounding: options.enableCompounding,
        allowLongs: options.allowLongs,
        allowShorts: options.allowShorts,
        maxPositions: options.maxPositions,
        ticksPerCandle: tickSimEnabled ? TICKS_PER_15MIN_CANDLE : 1,
        simulateTicks: tickSimEnabled,
        hardStopPercent: options.hardStopPercent,
        hardStopAtrMult: options.hardStopAtrMult,
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
      const trainPnL = pickFinitePnl(trainResult, "Train simulation");
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

      // ===== RUN TEST PERIOD (OUT-OF-SAMPLE) =====
      const testCandlesMap = new Map();
      for (const [symbol, candles] of candlesMap.entries()) {
        const testCandles = sliceCandlesToObjects(candles, testStart, testEnd);
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
          const testOneMin = sliceCandlesToObjects(oneMin, testStart, testEnd);
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
        testStrategiesMap.set(symbol, new IchimokuCloudBreakoutStrategy(testCfg));
      }

      let testResult = simFn(testStrategiesMap, testCandlesMap, {
        initialCapital: options.initialCapital,
        leverage: options.leverage,
        positionSizePercent: options.positionSizePercent,
        enableCompounding: options.enableCompounding,
        allowLongs: options.allowLongs,
        allowShorts: options.allowShorts,
        maxPositions: options.maxPositions,
        ticksPerCandle: tickSimEnabled ? TICKS_PER_15MIN_CANDLE : 1,
        simulateTicks: tickSimEnabled,
        hardStopPercent: options.hardStopPercent,
        hardStopAtrMult: options.hardStopAtrMult,
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
      const testPnL = pickFinitePnl(testResult, "Test simulation");
      const testDailyReturns = tradesToDailyReturns(testTrades, options.initialCapital);
      const testSharpe = testDailyReturns.length > 0 ? calculateSharpeRatio(testDailyReturns) : 0;

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

      folds.push(foldData);

      console.log(
        `    Fixed:     Train ${formatUsd(trainPnL)} (${foldData.trainTrades} trades, Sharpe ${trainSharpe.toFixed(2)}) → Test ${formatUsd(testPnL)} (${foldData.testTrades} trades, Sharpe ${testSharpe.toFixed(2)})`
      );

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

  return result;
}

/**
 * Print robustness test results and recommendations
 */
function printRobustnessResults({
  jitterResult,
  bootstrapResult,
  walkForwardResult,
  robustnessConfig,
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

  // Walk-forward analysis
  if (
    robustnessConfig.enableWalkForward &&
    walkForwardResult &&
    walkForwardResult.folds.length > 0
  ) {
    console.log(`\n📊 Walk-Forward Analysis (${walkForwardResult.totalFolds} folds):`);
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

    console.log(`\n  ── FOLD-BY-FOLD RESULTS ──`);
    for (const fold of walkForwardResult.folds) {
      const deg = formatPct(fold.degradation * 100);

      console.log(
        `    Fold ${fold.fold}: Train ${formatUsd(fold.trainPnL)} / Test ${formatUsd(fold.testPnL)} (${deg})`
      );
    }
  }

  // Recommendations for default=OFF metrics
  if (!robustnessConfig.enableBootstrap || !robustnessConfig.enableWalkForward) {
    console.log(`\n💡 Recommendations for Periodic Deep Analysis:`);

    if (!robustnessConfig.enableBootstrap) {
      console.log(`  📊 Bootstrap CI: Enable with ROBUST_BOOTSTRAP=1 to get confidence intervals`);
      console.log(`     → Checks if Sharpe/MAR CI overlaps benchmark (decline promotion if yes)`);
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
    "  #  | Side  | Entry Time          | Entry Price | Entry ADX | Exit Time           | Exit Price | Exit ADX | Exit Reason              | P&L USD   | P&L %"
  );
  console.log("-".repeat(100));

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const entryTime = new Date(t.openTime).toISOString().slice(0, 19).replace("T", " ");
    const exitTime = new Date(t.exitTime).toISOString().slice(0, 19).replace("T", " ");
    const entryPrice = t.entryPrice?.toFixed(2) || "N/A";
    const exitPrice = t.exitPrice?.toFixed(2) || "N/A";
    const entryAdx = t.entryAdx?.toFixed(1) || "N/A";
    const exitAdx = t.exitAdx?.toFixed(1) || "N/A";
    const totalPnl = t.totalPnlUsd ?? t.pnlUsd ?? 0;
    const pnlUsd = totalPnl.toFixed(2);
    const pnlPct = t.pnlPct?.toFixed(2) || "0.00";
    const reason = (t.exitReason || "unknown").padEnd(24);
    const side = (t.side || "N/A").padEnd(5);
    const emoji = totalPnl >= 0 ? "✅" : "❌";

    console.log(
      `${emoji} ${String(i + 1).padStart(2)} | ${side} | ${entryTime} | $${entryPrice.padStart(9)} | ${String(entryAdx).padStart(9)} | ${exitTime} | $${exitPrice.padStart(8)} | ${String(exitAdx).padStart(8)} | ${reason} | $${pnlUsd.padStart(8)} | ${pnlPct.padStart(6)}%`
    );

    // Show partial fills if any
    if (t.fills && t.fills.length > 0) {
      for (const fill of t.fills) {
        const fillTime = new Date(fill.ts).toISOString().slice(0, 19).replace("T", " ");
        const fillReason = (fill.reason || fill.type || "unknown").padEnd(24);
        const fillPnl = fill.pnlUsd?.toFixed(2) || "0.00";
        console.log(
          `   ↳ PARTIAL | ${fillTime} | $${fill.price?.toFixed(2).padStart(9)} | ${fillReason} | Qty: ${fill.quantity?.toFixed(4)} | P&L: $${fillPnl}`
        );
      }
    }
  }

  console.log("-".repeat(100));

  console.log("\n" + "=".repeat(70));
  console.log("               ICHIMOKU CLOUD BREAKOUT BACKTEST RESULTS");
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
  console.log(
    `  Tenkan/Kijun/SenkouB/Shift: ${config.tenkanPeriod}/${config.kijunPeriod}/${config.senkouBPeriod}/${config.shift}`
  );
  console.log(`  ADX Period / Min Trend:     ${config.adxPeriod} / ${config.adxMinTrend}`);
  console.log(`  ATR Period / Stop Mult:     ${config.atrPeriod} / ${config.atrStopMultiplier}`);
  console.log(`  Break Buffer ATR:           ${config.breakBufferAtr}`);
  console.log(`  Max Entry Dist ATR:         ${config.maxEntryDistAtr}`);
  console.log(`  Exit Oscillator:            ${config.exitOscillator}`);
  console.log(`  Hard Stop Enabled:          ${config.hardStopEnabled ? "YES" : "NO"}`);
  console.log(`  Hard Stop %:                ${config.hardStopPercent}%`);
  console.log(`  Hard Stop ATR:              ${config.hardStopAtrMult}x`);

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

function alignToCandleOpenMs(t, intervalMs) {
  return Math.floor(t / intervalMs) * intervalMs;
}

function alignToCandleCloseMs(t, intervalMs) {
  const open = alignToCandleOpenMs(t, intervalMs);
  return open + intervalMs - 1;
}

// Default markets for Ichimoku breakout (majors only).
const DEFAULT_MARKETS = ["BTC", "ETH", "SOL"];

function normalizeSymbolInput(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase();
  if (!s) return null;
  return s.endsWith("-PERP") ? s.slice(0, -5) : s;
}

// Get default markets from env or fallback to supported
function getDefaultMarkets() {
  const envMarkets = process.env.STRATEGY_MARKETS;
  if (envMarkets) {
    const markets = envMarkets
      .toUpperCase()
      .split(",")
      .map((s) => normalizeSymbolInput(s))
      .filter(Boolean);
    if (markets.length > 0) return markets;
  }
  return [...DEFAULT_MARKETS];
}

function parseArgs(args = process.argv.slice(2)) {
  // Read ALL config from env vars (from .env.ichimoku)
  const options = {
    // General
    days: 30,
    symbols: getDefaultMarkets(), // Read from STRATEGY_MARKETS env var
    symbol: null, // Single symbol mode (overrides symbols array)
    startTime: null, // Optional override (ms epoch or ISO string via CLI)
    endTime: null, // Optional override (ms epoch or ISO string via CLI)
    aggregation: "aligned", // 'aligned' (timestamp-aligned 15m) | 'legacy' (chunk-by-15)
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

    // Risk TP/SL mode (static exits; mutually exclusive with strategy exits in workflow/backtest)
    // NOTE: This is an analysis/backtest control knob. In production, RiskManager TP/SL is evaluated
    // on every tick regardless; the workflow intentionally tests TP/SL as a standalone exit system.
    useRiskTP: envBool("USE_RISK_TP", false),
    stopLossPercent: envNum("STOP_LOSS_PERCENT", 5),
    takeProfitPercent: envNum("TAKE_PROFIT_PERCENT", 15),
    useTrailingStop: envBool("USE_TRAILING_STOP", false),
    trailingStopPercent: envNum("TRAILING_STOP_PERCENT", 1),

    // Debug
    debug: envBool("DEBUG_ICHIMOKU_STRATEGY", false),
    verbose: false,

    // Time-of-day filters (UTC) - entry gate
    tradingDisabledHoursUtc: String(process.env.TRADING_DISABLED_HOURS_UTC || "").trim(),
    tradingAllowedHoursUtc: String(process.env.TRADING_ALLOWED_HOURS_UTC || "").trim(),

    // Ichimoku config - ALL from env
    tenkanPeriod: envInt("ICHIMOKU_TENKAN_PERIOD", 9),
    kijunPeriod: envInt("ICHIMOKU_KIJUN_PERIOD", 26),
    senkouBPeriod: envInt("ICHIMOKU_SENKOU_B_PERIOD", 52),
    shift: envInt("ICHIMOKU_SHIFT", 26),
    minBars: envInt("ICHIMOKU_MIN_BARS", 200),

    adxPeriod: envInt("ICHIMOKU_ADX_PERIOD", 14),
    adxMinTrend: envNum("ICHIMOKU_ADX_MIN_TREND", 20),
    atrPeriod: envInt("ICHIMOKU_ATR_PERIOD", 14),
    atrStopMultiplier: envNum("ICHIMOKU_ATR_STOP_MULTIPLIER", 2.8),

    breakBufferBps: envNum("ICHIMOKU_BREAK_BUFFER_BPS", 0),
    breakBufferAtr: envNum("ICHIMOKU_BREAK_BUFFER_ATR", 0.1),
    maxEntryDistAtr: envNum("ICHIMOKU_MAX_ENTRY_DIST_ATR", 1.5),
    requireTenkanKijunAlign: envBool("ICHIMOKU_REQUIRE_TENKAN_KIJUN_ALIGN", true),
    requireChikouBreakout: envBool("ICHIMOKU_REQUIRE_CHIKOU_BREAKOUT", false),
    // Default to 26 (standard Ichimoku displacement) when not explicitly configured.
    chikouLookback: envNum("ICHIMOKU_CHIKOU_LOOKBACK", 26),
    chikouCompare: String(process.env.ICHIMOKU_CHIKOU_COMPARE || "hilo").trim().toLowerCase(),
    chikouBufferBps: envNum("ICHIMOKU_CHIKOU_BUFFER_BPS", 0),
    chikouBufferAtr: envNum("ICHIMOKU_CHIKOU_BUFFER_ATR", 0),
    requireChikouAboveCloud: envBool("ICHIMOKU_CHIKOU_REQUIRE_ABOVE_CLOUD", false),
    chikouCloudLookback: envNum("ICHIMOKU_CHIKOU_CLOUD_LOOKBACK", 0),

    // VWAP confirmation (optional)
    requireVwapConfirm: envBool("ICHIMOKU_REQUIRE_VWAP_CONFIRM", false),
    vwapSessionMs: envNum("ICHIMOKU_VWAP_SESSION_MS", 24 * 60 * 60 * 1000),
    vwapBandBps: envNum("ICHIMOKU_VWAP_BAND_BPS", 0),
    vwapRequireCross: envBool("ICHIMOKU_VWAP_REQUIRE_CROSS", false),

    enableHtfRegime: envBool("ICHIMOKU_ENABLE_HTF_REGIME", false),
    htfMultiplier: envNum("ICHIMOKU_HTF_MULTIPLIER", 4),
    htfAdxPeriod: envInt("ICHIMOKU_HTF_ADX_PERIOD", 14),
    htfAdxMinTrend: envNum("ICHIMOKU_HTF_ADX_MIN_TREND", 25),
    htfUseChop: envBool("ICHIMOKU_HTF_USE_CHOP", false),
    htfChopPeriod: envInt("ICHIMOKU_HTF_CHOP_PERIOD", 14),
    htfChopRanging: envNum("ICHIMOKU_HTF_CHOP_RANGING", 61.8),
    htfChopTrending: envNum("ICHIMOKU_HTF_CHOP_TRENDING", 38.2),

    requireVolumeSpike: envBool("ICHIMOKU_REQUIRE_VOLUME_SPIKE", false),
    volumeLookback: envInt("ICHIMOKU_VOLUME_LOOKBACK", 20),
    volumeSpikeThreshold: envNum("ICHIMOKU_VOLUME_SPIKE_THRESHOLD", 1.5),

    // Ichimoku-native exits (bar-based)
    exitOnKijunBreak: envBool("ICHIMOKU_EXIT_ON_KIJUN_BREAK", true),
    kijunBreakBufferBps: envNum("ICHIMOKU_KIJUN_BREAK_BUFFER_BPS", 0),
    kijunBreakBufferAtr: envNum("ICHIMOKU_KIJUN_BREAK_BUFFER_ATR", 0.05),
    exitOnTenkanKijunCross: envBool("ICHIMOKU_EXIT_ON_TENKAN_KIJUN_CROSS", false),
    exitOnCloudReentry: envBool("ICHIMOKU_EXIT_ON_CLOUD_REENTRY", true),
    exitOnCloudFlip: envBool("ICHIMOKU_EXIT_ON_CLOUD_FLIP", false),
    timeStopBars: envInt("ICHIMOKU_TIME_STOP_BARS", 0),

    // Tick-based hard stops / trailing
    hardStopEnabled: envBool("ICHIMOKU_HARD_STOP_ENABLED", false),
    hardStopPercent: envNum("ICHIMOKU_HARD_STOP_PERCENT", 20),
    hardStopAtrMult: envNum("ICHIMOKU_HARD_STOP_ATR_MULT", 0),
    enableAtrTrail: envBool("ICHIMOKU_ENABLE_ATR_TRAIL", false),
    trailAtrMult: envNum("ICHIMOKU_TRAIL_ATR_MULT", 1.5),

    // Momentum oscillator exit
    exitOscillator: String(process.env.ICHIMOKU_EXIT_OSCILLATOR || "none").toLowerCase(),
    exitRsiPeriod: envInt("ICHIMOKU_EXIT_RSI_PERIOD", 14),
    exitRsiLong: envNum("ICHIMOKU_EXIT_RSI_LONG", 50),
    exitRsiShort: envNum("ICHIMOKU_EXIT_RSI_SHORT", 50),
    exitMacdFast: envInt("ICHIMOKU_EXIT_MACD_FAST", 12),
    exitMacdSlow: envInt("ICHIMOKU_EXIT_MACD_SLOW", 26),
    exitMacdSignal: envInt("ICHIMOKU_EXIT_MACD_SIGNAL", 9),

    // Filters - read from env
    allowLongs: envBool("ALLOW_LONGS", true),
    allowShorts: envBool("ALLOW_SHORTS", true),
    maxPositions: envInt("MAX_POSITIONS", 1),

    // Circuit breaker - pause trading after consecutive losses
    circuitBreakerMaxLosses: envInt("ICHIMOKU_MAX_CONSECUTIVE_LOSSES", 3), // Pause after N consecutive losses
    circuitBreakerCooldownMs: envInt("ICHIMOKU_CIRCUIT_BREAKER_COOLDOWN_MS", 180000), // Cooldown duration (ms)
    circuitBreakerEnabled: envBool("ICHIMOKU_CIRCUIT_BREAKER_ENABLED", false), // Master switch

    // Candle interval - from env
    interval: process.env.TRADING_INTERVAL || "15m",

    // Tick interpolation (15m only)
    use1MinTicks: envBool("BACKTEST_USE_1M_TICKS", true),

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
      envBool("ICHIMOKU_ALLOCATOR_RISK_ENABLED", envBool("ALLOCATOR_RISK_ENABLED", false))
    ),
    allocatorRiskNeutral: envBool(
      "BACKTEST_ALLOCATOR_RISK_NEUTRAL",
      envBool("ALLOCATOR_RISK_NEUTRAL", false)
    ),

    // Memory optimization flags
    useTypedArrays: envBool("BACKTEST_USE_TYPED_ARRAYS", true), // Use Float64Array for candle storage
    release1mAfterTicks: envBool("BACKTEST_RELEASE_1M", true), // Free 1m candles after tick cache
    batchMarketLoading: envBool("BACKTEST_BATCH_LOADING", true), // Load markets in batches for GC
    batchSize: envInt("BACKTEST_BATCH_SIZE", 4), // Markets per batch
    gcBetweenBatches: envBool("BACKTEST_GC_BETWEEN_BATCHES", true), // Force GC between batches

    // Repro helpers
    cfgFrom: null, // Path to a workflow/phase result JSON containing best.cfg
    cfgPhase: null, // Optional phase name when cfgFrom points at *.workflow.json
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
      else if (
        key === "tradingDisabledHoursUtc" ||
        key === "disabledHoursUtc" ||
        key === "disabledHours"
      )
        options.tradingDisabledHoursUtc = String(value ?? "").trim();
      else if (
        key === "tradingAllowedHoursUtc" ||
        key === "allowedHoursUtc" ||
        key === "allowedHours"
      )
        options.tradingAllowedHoursUtc = String(value ?? "").trim();
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
      else if (key === "days") {
        options.days = parseInt(value);
        options._cliDays = true;
      } else if (key === "startTime" || key === "start") {
        options.startTime = parseTimeArg(value);
        options._cliStartTime = true;
      } else if (key === "endTime" || key === "end") {
        options.endTime = parseTimeArg(value);
        options._cliEndTime = true;
      }
      else if (key === "aggregation" || key === "agg")
        options.aggregation = String(value || "").toLowerCase();
      else if (key === "symbol") {
        const sym = normalizeSymbolInput(value);
        options.symbol = sym;
        options.symbols = sym ? [sym] : []; // Single symbol mode
        options._cliSymbol = true;
      } else if (key === "symbols") {
        options.symbols = value
          .toUpperCase()
          .split(",")
          .map((s) => normalizeSymbolInput(s))
          .filter(Boolean);
        if (options.symbols.length === 0) options.symbols = [...DEFAULT_MARKETS];
        options._cliSymbols = true;
      }
      // Load best.cfg from a workflow/phase result JSON and apply as per-run marketOverrides.
      else if (key === "cfgFrom" || key === "cfg") options.cfgFrom = String(value || "").trim();
      else if (key === "cfgPhase") options.cfgPhase = String(value || "").trim();
      // When cfgFrom is set, default is to use the cfg file's meta time range for reproducibility.
      // Disable with: --cfgUseMetaRange=false (or set explicit --start/--end).
      else if (key === "cfgUseMetaRange")
        options.cfgUseMetaRange = value !== "false" && value !== "0";
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
      else if (key === "useRiskTP" || key === "useRiskTp" || key === "riskTP")
        options.useRiskTP = value !== "false" && value !== "0";
      else if (key === "stopLossPercent" || key === "sl")
        options.stopLossPercent = parseFloat(value);
      else if (key === "takeProfitPercent" || key === "tp")
        options.takeProfitPercent = parseFloat(value);
      else if (key === "useTrailingStop")
        options.useTrailingStop = value !== "false" && value !== "0";
      else if (key === "trailingStopPercent") options.trailingStopPercent = parseFloat(value);
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
      } else if (key === "tenkan") options.tenkanPeriod = parseInt(value);
      else if (key === "kijun") options.kijunPeriod = parseInt(value);
      else if (key === "senkouB") options.senkouBPeriod = parseInt(value);
      else if (key === "shift") options.shift = parseInt(value);
      else if (key === "minBars") options.minBars = parseInt(value);
      else if (key === "adxPeriod") options.adxPeriod = parseInt(value);
      else if (key === "adxMin") options.adxMinTrend = parseFloat(value);
      else if (key === "atrPeriod") options.atrPeriod = parseInt(value);
      else if (key === "atrStopMult") options.atrStopMultiplier = parseFloat(value);
      else if (key === "breakBufferBps") options.breakBufferBps = parseFloat(value);
      else if (key === "breakBufferAtr") options.breakBufferAtr = parseFloat(value);
      else if (key === "maxEntryDistAtr") options.maxEntryDistAtr = parseFloat(value);
      else if (key === "requireTenkanKijunAlign")
        options.requireTenkanKijunAlign = value !== "false";
      else if (key === "enableHtf") options.enableHtfRegime = value !== "false";
      else if (key === "htfMultiplier") options.htfMultiplier = parseFloat(value);
      else if (key === "htfAdxPeriod") options.htfAdxPeriod = parseInt(value);
      else if (key === "htfAdxMin") options.htfAdxMinTrend = parseFloat(value);
      else if (key === "htfUseChop") options.htfUseChop = value !== "false";
      else if (key === "htfChopPeriod") options.htfChopPeriod = parseInt(value);
      else if (key === "htfChopRanging") options.htfChopRanging = parseFloat(value);
      else if (key === "htfChopTrending") options.htfChopTrending = parseFloat(value);
      else if (key === "requireVolumeSpike") options.requireVolumeSpike = value !== "false";
      else if (key === "volumeLookback") options.volumeLookback = parseInt(value);
      else if (key === "volumeSpikeThreshold") options.volumeSpikeThreshold = parseFloat(value);
      else if (key === "exitKijunBreak") options.exitOnKijunBreak = value !== "false";
      else if (key === "exitTenkanKijun") options.exitOnTenkanKijunCross = value !== "false";
      else if (key === "exitCloudReentry") options.exitOnCloudReentry = value !== "false";
      else if (key === "exitCloudFlip") options.exitOnCloudFlip = value !== "false";
      else if (key === "timeStopBars") options.timeStopBars = parseInt(value);
      else if (key === "hardStopEnabled") options.hardStopEnabled = value !== "false";
      else if (key === "hardStopAtr") options.hardStopAtrMult = parseFloat(value);
      else if (key === "hardStopPercent") options.hardStopPercent = parseFloat(value);
      else if (key === "noHardStop") options.hardStopEnabled = false;
      else if (key === "atrTrail") options.enableAtrTrail = value !== "false";
      else if (key === "trailAtrMult") options.trailAtrMult = parseFloat(value);
      else if (key === "exitOscillator") {
        options.exitOscillator = String(value || "").toLowerCase();
        options._cliExitOscillator = true;
      }
      else if (key === "exitRsiPeriod") options.exitRsiPeriod = parseInt(value);
      else if (key === "exitRsiLong") options.exitRsiLong = parseFloat(value);
      else if (key === "exitRsiShort") options.exitRsiShort = parseFloat(value);
      else if (key === "exitMacdFast") options.exitMacdFast = parseInt(value);
      else if (key === "exitMacdSlow") options.exitMacdSlow = parseInt(value);
      else if (key === "exitMacdSignal") options.exitMacdSignal = parseInt(value);
      else if (key === "longsOnly") options.allowShorts = false;
      else if (key === "shortsOnly") options.allowLongs = false;
      else if (key === "maxPositions") options.maxPositions = parseInt(value);
      else if (key === "interval") options.interval = value;
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
      // Tick interpolation toggles
      else if (key === "use1mTicks") options.use1MinTicks = value !== "false" && value !== "0";
      else if (key === "no1mTicks") options.use1MinTicks = false;
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

  // Backward-compatible aliases for shared sizing/helpers (avoid undefined usage).
  options.hardStopPercent = options.hardStopPercent;
  options.hardStopAtrMult = options.hardStopAtrMult;
  options.hardStopEnabled = options.hardStopEnabled;

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

function loadBestCfgFromJsonFile({ filePath, phase }) {
  if (!filePath) return null;
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absPath, "utf8");
  const json = JSON.parse(raw);

  const out = { absPath, cfg: null, meta: null };
  if (!json || typeof json !== "object") return out;

  // Phase result file (e.g. ichimoku-BTC-leverage-*.json): { meta, best: { cfg, summary } }
  if (json.best && typeof json.best === "object" && json.best.cfg && typeof json.best.cfg === "object") {
    out.cfg = json.best.cfg;
    out.meta = json.meta && typeof json.meta === "object" ? json.meta : null;
    return out;
  }

  // Workflow file (e.g. BTC.workflow.json): { meta, phases: { leverage: { best: { cfg } } } }
  if (json.phases && typeof json.phases === "object") {
    const phases = json.phases;
    const phaseNames = Object.keys(phases);
    let phaseName = phase && String(phase).trim() ? String(phase).trim() : null;

    if (!phaseName) {
      if (phaseNames.length === 1) phaseName = phaseNames[0];
      else if (phases.leverage) phaseName = "leverage";
    }

    const node = phaseName ? phases[phaseName] : null;
    if (!node || typeof node !== "object") {
      const hint =
        phaseNames.length > 0 ? ` Available phases: ${phaseNames.join(", ")}` : " No phases found.";
      throw new Error(
        `[cfgFrom] Unable to select phase for ${absPath}.${hint} Provide --cfgPhase=<phaseName>.`
      );
    }

    if (node.best && typeof node.best === "object" && node.best.cfg && typeof node.best.cfg === "object") {
      out.cfg = node.best.cfg;
      out.meta = json.meta && typeof json.meta === "object" ? json.meta : null;
      return out;
    }
  }

  return out;
}

function getPerMarketLeveragePreview(options, symbol) {
  if (!symbol) return null;
  const marketOverride = getMarketOverride(options?.marketOverrides, symbol) || null;
  if (marketOverride && marketOverride.leverage !== undefined && marketOverride.leverage !== null) {
    const n = Number(marketOverride.leverage);
    if (Number.isFinite(n)) return n;
  }
  const marketKey = `${symbol}_PERP`.toUpperCase();
  const envLev = process.env[`STRATEGY_${marketKey}_LEVERAGE`];
  const n = Number(envLev);
  if (envLev !== undefined && envLev !== "" && Number.isFinite(n)) return n;
  return Number.isFinite(options?.leverage) ? options.leverage : null;
}

async function prefetchSingleMarketData({ symbol, options, startTime, endTime }) {
  const interval = options?.interval || "15m";
  const use1MinTicks = options?.use1MinTicks !== false;
  const preferredSource = process.env.BACKTEST_USE_PYTH === "false" ? "binance" : "pyth";

  let candles;
  let oneMinCandles = null;
  let ticksByBarOpenTime = null;

  if (use1MinTicks && interval === "15m") {
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

    if (preferredSource === "pyth") {
      oneMinCandles = await attachBinanceVolumeToPythCandles({
        symbol,
        interval: "1m",
        startTime,
        endTime,
        candles: oneMinCandles,
      });
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
      for (let i = 0; i < oneMinCandles.length; i += 15) {
        const group = oneMinCandles.slice(i, i + 15);
        if (group.length === 15) candles.push(aggregate1MinTo15Min(group));
      }
    } else {
      candles = aggregate1MinTo15MinAligned(oneMinCandles);
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
    if (preferredSource === "pyth") {
      candles = await attachBinanceVolumeToPythCandles({
        symbol,
        interval,
        startTime,
        endTime,
        candles,
      });
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

function summarizeIchimokuBacktestForWorkflow({ trades, equitySeries, days, initialCapital, netPnlUsd = null }) {
  const t = Array.isArray(trades) ? trades : [];
  const totalTrades = t.length;
  const tradeBasedPnL = t.reduce((s, x) => s + getTradePnlUsd(x), 0);
  const totalPnL = Number.isFinite(netPnlUsd) ? Number(netPnlUsd) : tradeBasedPnL;
  const wins = t.filter((x) => getTradePnlUsd(x) > 0).length;
  const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const returnPct = initialCapital > 0 ? (totalPnL / initialCapital) * 100 : 0;
  const tradeBasedReturnPct = initialCapital > 0 ? (tradeBasedPnL / initialCapital) * 100 : 0;

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
  const sumExitByList = (reasons) => {
    let count = 0;
    let pnl = 0;
    for (const reason of reasons || []) {
      const v = byExit.get(reason);
      if (!v) continue;
      count += Number(v?.count || 0);
      pnl += Number(v?.pnl || 0);
    }
    return count > 0 ? { count, pnl } : null;
  };

  return {
    returnPct,
    pnlUsd: totalPnL,
    tradeBasedReturnPct,
    tradeBasedPnlUsd: tradeBasedPnL,
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
      hardStop: sumExitByPrefix("ichimoku_hard_stop"),
      atrTrail: sumExitByExact("ichimoku_atr_trail"),
      timeStop: sumExitByExact("ichimoku_time_stop"),
      oscillator: sumExitByList(["ichimoku_rsi_exit", "ichimoku_macd_exit"]),
      lineExit: sumExitByList(["ichimoku_kijun_break", "ichimoku_tenkan_kijun_cross"]),
      cloudExit: sumExitByList(["ichimoku_cloud_reentry", "ichimoku_cloud_flip"]),
      byReason: exitBreakdown,
    },
    streaks: { maxWinStreak, maxLoseStreak },
  };
}

// ============================================================
// RUN BACKTEST FOR A SINGLE SYMBOL
// ============================================================
async function runBacktestForSymbol(symbol, options, startTime, endTime) {
  const interval = options.interval || "15m";
  const use1MinTicks = options.use1MinTicks !== false; // Default: use 1-min candles for accurate ticks

  // Enable tick simulation for 15m candles with 15s intervals (matches bot behavior)
  const tickSimEnabled = interval === "15m" || interval === "1m";
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
  } else if (use1MinTicks && interval === "15m") {
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

      if (preferredSource === "pyth") {
        oneMinCandles = await attachBinanceVolumeToPythCandles({
          symbol,
          interval: "1m",
          startTime,
          endTime,
          candles: oneMinCandles,
        });
      }

      // Build/load tick cache for this range (15s ticks), with superset reuse + incremental extension.
      ticksByBarOpenTime = await getOrBuildTicksByBarOpenTime({
        source: preferredSource === "pyth" ? "pyth" : "binance",
        symbol,
        startTime,
        endTime,
        oneMinCandles,
      });

      // Aggregate to 15-minute candles for Ichimoku calculation
      if ((options.aggregation || "aligned") === "legacy") {
        candles = [];
        for (let i = 0; i < oneMinCandles.length; i += 15) {
          const group = oneMinCandles.slice(i, i + 15);
          if (group.length === 15) candles.push(aggregate1MinTo15Min(group));
        }
      } else {
        candles = aggregate1MinTo15MinAligned(oneMinCandles);
      }
      console.log(
        `   Aggregated to ${candles.length} 15-minute candles (${options.aggregation || "aligned"})`
      );
    } else {
      // No 1-minute data => disable tick simulation to avoid 15m look-ahead ticks.
      console.error(
        `❌ 1-minute data unavailable for ${symbol} - refusing 15m look-ahead tick simulation.`
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
    if (preferredSource === "pyth") {
      candles = await attachBinanceVolumeToPythCandles({
        symbol,
        interval,
        startTime,
        endTime,
        candles,
      });
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
  const overrideStr = (k) => {
    if (
      !marketOverride ||
      marketOverride[k] === undefined ||
      marketOverride[k] === null ||
      String(marketOverride[k]).trim() === ""
    )
      return null;
    return String(marketOverride[k]).trim();
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

  const ignorePerMarketOverrides =
    options.ignorePerMarketOverrides === true || options.ignorePerMarketEnv === true;
  const perMarketEnv = ignorePerMarketOverrides ? {} : process.env;

  // Check for per-market Ichimoku overrides from environment variables
  const marketKey = `${symbol}_PERP`.toUpperCase();
  const perMarketLeverage = perMarketEnv[`STRATEGY_${marketKey}_LEVERAGE`];
  const perMarketHardStopPercent = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HARD_STOP_PERCENT`];
  const perMarketHardStopAtr = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HARD_STOP_ATR_MULT`];
  const perMarketAdxMinTrend = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_ADX_MIN_TREND`];
  const perMarketBreakBufferBps = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_BREAK_BUFFER_BPS`];
  const perMarketBreakBufferAtr = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_BREAK_BUFFER_ATR`];
  const perMarketMaxEntryDistAtr =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_MAX_ENTRY_DIST_ATR`];
  const perMarketAtrStopMultiplier =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_ATR_STOP_MULTIPLIER`];
  const perMarketTenkanPeriod = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_TENKAN_PERIOD`];
  const perMarketKijunPeriod = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_KIJUN_PERIOD`];
  const perMarketSenkouBPeriod = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_SENKOU_B_PERIOD`];
  const perMarketShift = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_SHIFT`];
  const perMarketMinBars = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_MIN_BARS`];
  const perMarketAdxPeriod = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_ADX_PERIOD`];
  const perMarketAtrPeriod = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_ATR_PERIOD`];
  const perMarketTradingDisabledHoursUtc =
    perMarketEnv[`STRATEGY_${marketKey}_TRADING_DISABLED_HOURS_UTC`];
  const perMarketTradingAllowedHoursUtc =
    perMarketEnv[`STRATEGY_${marketKey}_TRADING_ALLOWED_HOURS_UTC`];
  const perMarketRequireTenkanKijunAlign =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_REQUIRE_TENKAN_KIJUN_ALIGN`];
  const perMarketRequireChikouBreakout =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_REQUIRE_CHIKOU_BREAKOUT`] ??
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_REQUIRE_CHIKOU_CLEAR`];
  const perMarketChikouLookback = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_CHIKOU_LOOKBACK`];
  const perMarketChikouCompare = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_CHIKOU_COMPARE`];
  const perMarketChikouBufferBps = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_CHIKOU_BUFFER_BPS`];
  const perMarketChikouBufferAtr = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_CHIKOU_BUFFER_ATR`];
  const perMarketChikouRequireAboveCloud =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_CHIKOU_REQUIRE_ABOVE_CLOUD`];
  const perMarketChikouCloudLookback =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_CHIKOU_CLOUD_LOOKBACK`];
  const perMarketRequireVwapConfirm =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_REQUIRE_VWAP_CONFIRM`];
  const perMarketVwapSessionMs = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_VWAP_SESSION_MS`];
  const perMarketVwapBandBps = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_VWAP_BAND_BPS`];
  const perMarketVwapRequireCross =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_VWAP_REQUIRE_CROSS`];
  const perMarketEnableHtfRegime = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_ENABLE_HTF_REGIME`];
  const perMarketHtfMultiplier = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HTF_MULTIPLIER`];
  const perMarketHtfAdxPeriod = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HTF_ADX_PERIOD`];
  const perMarketHtfAdxMinTrend = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HTF_ADX_MIN_TREND`];
  const perMarketHtfUseChop = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HTF_USE_CHOP`];
  const perMarketHtfChopPeriod = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HTF_CHOP_PERIOD`];
  const perMarketHtfChopRanging = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HTF_CHOP_RANGING`];
  const perMarketHtfChopTrending = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HTF_CHOP_TRENDING`];
  const perMarketRequireVolumeSpike =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_REQUIRE_VOLUME_SPIKE`];
  const perMarketVolumeLookback = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_VOLUME_LOOKBACK`];
  const perMarketVolumeSpikeThreshold =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_VOLUME_SPIKE_THRESHOLD`];
  const perMarketExitOnKijunBreak =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_ON_KIJUN_BREAK`];
  const perMarketKijunBreakBufferBps =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_KIJUN_BREAK_BUFFER_BPS`];
  const perMarketKijunBreakBufferAtr =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_KIJUN_BREAK_BUFFER_ATR`];
  const perMarketExitOnTenkanKijunCross =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_ON_TENKAN_KIJUN_CROSS`];
  const perMarketExitOnCloudReentry =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_ON_CLOUD_REENTRY`];
  const perMarketExitOnCloudFlip =
    perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_ON_CLOUD_FLIP`];
  const perMarketTimeStopBars = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_TIME_STOP_BARS`];
  const perMarketHardStopEnabled = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_HARD_STOP_ENABLED`];
  const perMarketEnableAtrTrail = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_ENABLE_ATR_TRAIL`];
  const perMarketTrailAtrMult = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_TRAIL_ATR_MULT`];
  const perMarketExitOscillator = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_OSCILLATOR`];
  const perMarketExitRsiPeriod = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_RSI_PERIOD`];
  const perMarketExitRsiLong = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_RSI_LONG`];
  const perMarketExitRsiShort = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_RSI_SHORT`];
  const perMarketExitMacdFast = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_MACD_FAST`];
  const perMarketExitMacdSlow = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_MACD_SLOW`];
  const perMarketExitMacdSignal = perMarketEnv[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_MACD_SIGNAL`];
  const perMarketAllowLongs = perMarketEnv[`STRATEGY_${marketKey}_ALLOW_LONGS`];
  const perMarketAllowShorts = perMarketEnv[`STRATEGY_${marketKey}_ALLOW_SHORTS`];
  // Per-market RiskManager TP/SL mode overrides (analysis/backtest harness only)
  const perMarketUseRiskTP = perMarketEnv[`STRATEGY_${marketKey}_USE_RISK_TP`];
  const perMarketStopLossPercent = perMarketEnv[`STRATEGY_${marketKey}_STOP_LOSS_PERCENT`];
  const perMarketTakeProfitPercent = perMarketEnv[`STRATEGY_${marketKey}_TAKE_PROFIT_PERCENT`];
  const perMarketUseTrailingStop = perMarketEnv[`STRATEGY_${marketKey}_USE_TRAILING_STOP`];
  const perMarketTrailingStopPercent = perMarketEnv[`STRATEGY_${marketKey}_TRAILING_STOP_PERCENT`];

  // Use per-market settings if available, otherwise use global defaults
  // NOTE: must treat "0" as a valid override (e.g., ICHIMOKU_HARD_STOP_PERCENT=0 forces ATR-based stop)
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const effectiveTenkanPeriod =
    overrideNum("tenkanPeriod") ??
    (has(perMarketTenkanPeriod) ? parseFloat(perMarketTenkanPeriod) : options.tenkanPeriod);
  const effectiveKijunPeriod =
    overrideNum("kijunPeriod") ??
    (has(perMarketKijunPeriod) ? parseFloat(perMarketKijunPeriod) : options.kijunPeriod);
  const effectiveSenkouBPeriod =
    overrideNum("senkouBPeriod") ??
    (has(perMarketSenkouBPeriod) ? parseFloat(perMarketSenkouBPeriod) : options.senkouBPeriod);
  const effectiveShift =
    overrideNum("shift") ?? (has(perMarketShift) ? parseFloat(perMarketShift) : options.shift);
  const effectiveTradingDisabledHoursUtc =
    (marketOverride &&
    marketOverride.tradingDisabledHoursUtc !== undefined &&
    marketOverride.tradingDisabledHoursUtc !== null &&
    String(marketOverride.tradingDisabledHoursUtc).trim() !== ""
      ? String(marketOverride.tradingDisabledHoursUtc).trim()
      : null) ??
    (has(perMarketTradingDisabledHoursUtc)
      ? String(perMarketTradingDisabledHoursUtc).trim()
      : options.tradingDisabledHoursUtc);
  const effectiveTradingAllowedHoursUtc =
    (marketOverride &&
    marketOverride.tradingAllowedHoursUtc !== undefined &&
    marketOverride.tradingAllowedHoursUtc !== null &&
    String(marketOverride.tradingAllowedHoursUtc).trim() !== ""
      ? String(marketOverride.tradingAllowedHoursUtc).trim()
      : null) ??
    (has(perMarketTradingAllowedHoursUtc)
      ? String(perMarketTradingAllowedHoursUtc).trim()
      : options.tradingAllowedHoursUtc);
  const effectiveMinBars =
    overrideNum("minBars") ??
    (has(perMarketMinBars) ? parseFloat(perMarketMinBars) : options.minBars);
  const effectiveAdxPeriod =
    overrideNum("adxPeriod") ??
    (has(perMarketAdxPeriod) ? parseFloat(perMarketAdxPeriod) : options.adxPeriod);
  const effectiveAtrPeriod =
    overrideNum("atrPeriod") ??
    (has(perMarketAtrPeriod) ? parseFloat(perMarketAtrPeriod) : options.atrPeriod);
  const effectiveLeverage =
    overrideNum("leverage") ??
    (has(perMarketLeverage) ? parseFloat(perMarketLeverage) : options.leverage);
  const effectiveHardStopPercent =
    overrideNum("hardStopPercent") ??
    (has(perMarketHardStopPercent)
      ? parseFloat(perMarketHardStopPercent)
      : options.hardStopPercent);
  const effectiveHardStopAtr =
    overrideNum("hardStopAtrMult") ??
    (has(perMarketHardStopAtr) ? parseFloat(perMarketHardStopAtr) : options.hardStopAtrMult);
  const effectiveAdxMinTrend =
    overrideNum("adxMinTrend") ??
    (has(perMarketAdxMinTrend) ? parseFloat(perMarketAdxMinTrend) : options.adxMinTrend);
  const effectiveBreakBufferBps =
    overrideNum("breakBufferBps") ??
    (has(perMarketBreakBufferBps) ? parseFloat(perMarketBreakBufferBps) : options.breakBufferBps);
  const effectiveBreakBufferAtr =
    overrideNum("breakBufferAtr") ??
    (has(perMarketBreakBufferAtr) ? parseFloat(perMarketBreakBufferAtr) : options.breakBufferAtr);
  const effectiveMaxEntryDistAtr =
    overrideNum("maxEntryDistAtr") ??
    (has(perMarketMaxEntryDistAtr)
      ? parseFloat(perMarketMaxEntryDistAtr)
      : options.maxEntryDistAtr);
  const effectiveAtrStopMultiplier =
    overrideNum("atrStopMultiplier") ??
    (has(perMarketAtrStopMultiplier)
      ? parseFloat(perMarketAtrStopMultiplier)
      : options.atrStopMultiplier);
  const effectiveRequireTenkanKijunAlign =
    overrideBool("requireTenkanKijunAlign") ??
    (has(perMarketRequireTenkanKijunAlign)
      ? perMarketRequireTenkanKijunAlign === "true" || perMarketRequireTenkanKijunAlign === "1"
      : options.requireTenkanKijunAlign);
  const effectiveRequireChikouBreakout =
    overrideBool("requireChikouBreakout") ??
    (has(perMarketRequireChikouBreakout)
      ? perMarketRequireChikouBreakout === "true" || perMarketRequireChikouBreakout === "1"
      : options.requireChikouBreakout);
  const effectiveChikouLookback =
    overrideNum("chikouLookback") ??
    (has(perMarketChikouLookback) ? parseFloat(perMarketChikouLookback) : options.chikouLookback);
  const effectiveChikouCompare = String(
    overrideStr("chikouCompare") ??
      (has(perMarketChikouCompare) ? String(perMarketChikouCompare).trim() : options.chikouCompare)
  )
    .trim()
    .toLowerCase();
  const effectiveChikouBufferBps =
    overrideNum("chikouBufferBps") ??
    (has(perMarketChikouBufferBps)
      ? parseFloat(perMarketChikouBufferBps)
      : options.chikouBufferBps);
  const effectiveChikouBufferAtr =
    overrideNum("chikouBufferAtr") ??
    (has(perMarketChikouBufferAtr)
      ? parseFloat(perMarketChikouBufferAtr)
      : options.chikouBufferAtr);
  const effectiveRequireChikouAboveCloud =
    overrideBool("requireChikouAboveCloud") ??
    (has(perMarketChikouRequireAboveCloud)
      ? perMarketChikouRequireAboveCloud === "true" || perMarketChikouRequireAboveCloud === "1"
      : options.requireChikouAboveCloud);
  const effectiveChikouCloudLookback =
    overrideNum("chikouCloudLookback") ??
    (has(perMarketChikouCloudLookback)
      ? parseFloat(perMarketChikouCloudLookback)
      : options.chikouCloudLookback);
  const effectiveRequireVwapConfirm =
    overrideBool("requireVwapConfirm") ??
    (has(perMarketRequireVwapConfirm)
      ? perMarketRequireVwapConfirm === "true" || perMarketRequireVwapConfirm === "1"
      : options.requireVwapConfirm);
  const effectiveVwapSessionMs =
    overrideNum("vwapSessionMs") ??
    (has(perMarketVwapSessionMs) ? parseFloat(perMarketVwapSessionMs) : options.vwapSessionMs);
  const effectiveVwapBandBps =
    overrideNum("vwapBandBps") ??
    (has(perMarketVwapBandBps) ? parseFloat(perMarketVwapBandBps) : options.vwapBandBps);
  const effectiveVwapRequireCross =
    overrideBool("vwapRequireCross") ??
    (has(perMarketVwapRequireCross)
      ? perMarketVwapRequireCross === "true" || perMarketVwapRequireCross === "1"
      : options.vwapRequireCross);
  const effectiveEnableHtfRegime =
    overrideBool("enableHtfRegime") ??
    (has(perMarketEnableHtfRegime)
      ? perMarketEnableHtfRegime === "true" || perMarketEnableHtfRegime === "1"
      : options.enableHtfRegime);
  const effectiveHtfMultiplier =
    overrideNum("htfMultiplier") ??
    (has(perMarketHtfMultiplier) ? parseFloat(perMarketHtfMultiplier) : options.htfMultiplier);
  const effectiveHtfAdxPeriod =
    overrideNum("htfAdxPeriod") ??
    (has(perMarketHtfAdxPeriod) ? parseFloat(perMarketHtfAdxPeriod) : options.htfAdxPeriod);
  const effectiveHtfAdxMinTrend =
    overrideNum("htfAdxMinTrend") ??
    (has(perMarketHtfAdxMinTrend) ? parseFloat(perMarketHtfAdxMinTrend) : options.htfAdxMinTrend);
  const effectiveHtfUseChop =
    overrideBool("htfUseChop") ??
    (has(perMarketHtfUseChop)
      ? perMarketHtfUseChop === "true" || perMarketHtfUseChop === "1"
      : options.htfUseChop);
  const effectiveHtfChopPeriod =
    overrideNum("htfChopPeriod") ??
    (has(perMarketHtfChopPeriod) ? parseFloat(perMarketHtfChopPeriod) : options.htfChopPeriod);
  const effectiveHtfChopRanging =
    overrideNum("htfChopRanging") ??
    (has(perMarketHtfChopRanging) ? parseFloat(perMarketHtfChopRanging) : options.htfChopRanging);
  const effectiveHtfChopTrending =
    overrideNum("htfChopTrending") ??
    (has(perMarketHtfChopTrending)
      ? parseFloat(perMarketHtfChopTrending)
      : options.htfChopTrending);
  const effectiveRequireVolumeSpike =
    overrideBool("requireVolumeSpike") ??
    (has(perMarketRequireVolumeSpike)
      ? perMarketRequireVolumeSpike === "true" || perMarketRequireVolumeSpike === "1"
      : options.requireVolumeSpike);
  const effectiveVolumeLookback =
    overrideNum("volumeLookback") ??
    (has(perMarketVolumeLookback) ? parseFloat(perMarketVolumeLookback) : options.volumeLookback);
  const effectiveVolumeSpikeThreshold =
    overrideNum("volumeSpikeThreshold") ??
    (has(perMarketVolumeSpikeThreshold)
      ? parseFloat(perMarketVolumeSpikeThreshold)
      : options.volumeSpikeThreshold);
  const effectiveExitOnKijunBreak =
    overrideBool("exitOnKijunBreak") ??
    (has(perMarketExitOnKijunBreak)
      ? perMarketExitOnKijunBreak === "true" || perMarketExitOnKijunBreak === "1"
      : options.exitOnKijunBreak);
  const effectiveKijunBreakBufferBps =
    overrideNum("kijunBreakBufferBps") ??
    (has(perMarketKijunBreakBufferBps)
      ? parseFloat(perMarketKijunBreakBufferBps)
      : options.kijunBreakBufferBps);
  const effectiveKijunBreakBufferAtr =
    overrideNum("kijunBreakBufferAtr") ??
    (has(perMarketKijunBreakBufferAtr)
      ? parseFloat(perMarketKijunBreakBufferAtr)
      : options.kijunBreakBufferAtr);
  const effectiveExitOnTenkanKijunCross =
    overrideBool("exitOnTenkanKijunCross") ??
    (has(perMarketExitOnTenkanKijunCross)
      ? perMarketExitOnTenkanKijunCross === "true" || perMarketExitOnTenkanKijunCross === "1"
      : options.exitOnTenkanKijunCross);
  const effectiveExitOnCloudReentry =
    overrideBool("exitOnCloudReentry") ??
    (has(perMarketExitOnCloudReentry)
      ? perMarketExitOnCloudReentry === "true" || perMarketExitOnCloudReentry === "1"
      : options.exitOnCloudReentry);
  const effectiveExitOnCloudFlip =
    overrideBool("exitOnCloudFlip") ??
    (has(perMarketExitOnCloudFlip)
      ? perMarketExitOnCloudFlip === "true" || perMarketExitOnCloudFlip === "1"
      : options.exitOnCloudFlip);
  const effectiveTimeStopBars =
    overrideNum("timeStopBars") ??
    (has(perMarketTimeStopBars) ? parseFloat(perMarketTimeStopBars) : options.timeStopBars);
  const effectiveHardStopEnabled =
    overrideBool("hardStopEnabled") ??
    (has(perMarketHardStopEnabled)
      ? perMarketHardStopEnabled === "true" || perMarketHardStopEnabled === "1"
      : options.hardStopEnabled);
  const effectiveEnableAtrTrail =
    overrideBool("enableAtrTrail") ??
    (has(perMarketEnableAtrTrail)
      ? perMarketEnableAtrTrail === "true" || perMarketEnableAtrTrail === "1"
      : options.enableAtrTrail);
  const effectiveTrailAtrMult =
    overrideNum("trailAtrMult") ??
    (has(perMarketTrailAtrMult) ? parseFloat(perMarketTrailAtrMult) : options.trailAtrMult);
  const effectiveExitOscillator = String(
    overrideStr("exitOscillator") ??
      (has(perMarketExitOscillator)
        ? String(perMarketExitOscillator).trim()
        : options.exitOscillator)
  )
    .trim()
    .toLowerCase();
  const effectiveExitRsiPeriod =
    overrideNum("exitRsiPeriod") ??
    (has(perMarketExitRsiPeriod) ? parseFloat(perMarketExitRsiPeriod) : options.exitRsiPeriod);
  const effectiveExitRsiLong =
    overrideNum("exitRsiLong") ??
    (has(perMarketExitRsiLong) ? parseFloat(perMarketExitRsiLong) : options.exitRsiLong);
  const effectiveExitRsiShort =
    overrideNum("exitRsiShort") ??
    (has(perMarketExitRsiShort) ? parseFloat(perMarketExitRsiShort) : options.exitRsiShort);
  const effectiveExitMacdFast =
    overrideNum("exitMacdFast") ??
    (has(perMarketExitMacdFast) ? parseFloat(perMarketExitMacdFast) : options.exitMacdFast);
  const effectiveExitMacdSlow =
    overrideNum("exitMacdSlow") ??
    (has(perMarketExitMacdSlow) ? parseFloat(perMarketExitMacdSlow) : options.exitMacdSlow);
  const effectiveExitMacdSignal =
    overrideNum("exitMacdSignal") ??
    (has(perMarketExitMacdSignal) ? parseFloat(perMarketExitMacdSignal) : options.exitMacdSignal);
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
  const inferredUseRiskTP =
    !has(perMarketUseRiskTP) && has(perMarketStopLossPercent) && has(perMarketTakeProfitPercent);
  const effectiveUseRiskTP =
    overrideBool("useRiskTP") ??
    (has(perMarketUseRiskTP)
      ? perMarketUseRiskTP === "true" || perMarketUseRiskTP === "1"
      : inferredUseRiskTP
        ? true
        : options.useRiskTP);
  const effectiveStopLossPercent =
    overrideNum("stopLossPercent") ??
    (has(perMarketStopLossPercent)
      ? parseFloat(perMarketStopLossPercent)
      : options.stopLossPercent);
  const effectiveTakeProfitPercent =
    overrideNum("takeProfitPercent") ??
    (has(perMarketTakeProfitPercent)
      ? parseFloat(perMarketTakeProfitPercent)
      : options.takeProfitPercent);
  const effectiveUseTrailingStop =
    overrideBool("useTrailingStop") ??
    (has(perMarketUseTrailingStop)
      ? perMarketUseTrailingStop === "true" || perMarketUseTrailingStop === "1"
      : options.useTrailingStop);
  const effectiveTrailingStopPercent =
    overrideNum("trailingStopPercent") ??
    (has(perMarketTrailingStopPercent)
      ? parseFloat(perMarketTrailingStopPercent)
      : options.trailingStopPercent);

  // Log per-market settings if different from global
  if (
    marketOverride ||
    perMarketLeverage ||
    perMarketHardStopPercent ||
    perMarketHardStopAtr ||
    perMarketAdxMinTrend ||
    perMarketBreakBufferBps ||
    perMarketBreakBufferAtr ||
    perMarketMaxEntryDistAtr ||
    perMarketAtrStopMultiplier ||
    perMarketAllowLongs ||
    perMarketAllowShorts ||
    perMarketTradingDisabledHoursUtc ||
    perMarketTradingAllowedHoursUtc ||
    perMarketUseRiskTP ||
    perMarketStopLossPercent ||
    perMarketTakeProfitPercent ||
    perMarketUseTrailingStop ||
    perMarketTrailingStopPercent
  ) {
    const dirsLabel =
      effectiveAllowLongs !== options.allowLongs || effectiveAllowShorts !== options.allowShorts
        ? `, dirs=${effectiveAllowLongs ? "L" : "-"}${effectiveAllowShorts ? "S" : "-"}`
        : "";
    const riskLabel = effectiveUseRiskTP
      ? `, riskTP=on${inferredUseRiskTP ? "*" : ""} (sl=${effectiveStopLossPercent} tp=${effectiveTakeProfitPercent}${
          effectiveUseTrailingStop ? ` trail=${effectiveTrailingStopPercent}` : ""
        })`
      : "";
    console.log(
      `[${symbol}] Using per-market settings: adxMin=${effectiveAdxMinTrend}, breakBufBps=${effectiveBreakBufferBps}, breakBufATR=${effectiveBreakBufferAtr}, ` +
        `maxEntryATR=${effectiveMaxEntryDistAtr}, atrStop=${effectiveAtrStopMultiplier}, leverage=${effectiveLeverage}x, ` +
        `hardStop=${effectiveHardStopPercent}%/ATR=${effectiveHardStopAtr}x${dirsLabel}${riskLabel}`
    );
  }

  // Create strategy with config (using per-market overrides where available)
  const strategyConfig = {
    market: `${symbol}-PERP`,
    quiet: !options.verbose, // Suppress per-trade logging unless verbose mode
    ichimokuStrategy: {
      tenkanPeriod: effectiveTenkanPeriod,
      kijunPeriod: effectiveKijunPeriod,
      senkouBPeriod: effectiveSenkouBPeriod,
      shift: effectiveShift,
      tradingDisabledHoursUtc: effectiveTradingDisabledHoursUtc,
      tradingAllowedHoursUtc: effectiveTradingAllowedHoursUtc,
      minBars: effectiveMinBars,
      adxPeriod: effectiveAdxPeriod,
      adxMinTrend: effectiveAdxMinTrend,
      atrPeriod: effectiveAtrPeriod,
      atrStopMultiplier: effectiveAtrStopMultiplier,
      breakBufferBps: effectiveBreakBufferBps,
      breakBufferAtr: effectiveBreakBufferAtr,
      maxEntryDistAtr: effectiveMaxEntryDistAtr,
      requireTenkanKijunAlign: effectiveRequireTenkanKijunAlign,
      requireChikouBreakout: effectiveRequireChikouBreakout,
      chikouLookback: effectiveChikouLookback,
      chikouCompare: effectiveChikouCompare,
      chikouBufferBps: effectiveChikouBufferBps,
      chikouBufferAtr: effectiveChikouBufferAtr,
      requireChikouAboveCloud: effectiveRequireChikouAboveCloud,
      chikouCloudLookback: effectiveChikouCloudLookback,
      requireVwapConfirm: effectiveRequireVwapConfirm,
      vwapSessionMs: effectiveVwapSessionMs,
      vwapBandBps: effectiveVwapBandBps,
      vwapRequireCross: effectiveVwapRequireCross,
      enableHtfRegime: effectiveEnableHtfRegime,
      htfMultiplier: effectiveHtfMultiplier,
      htfAdxPeriod: effectiveHtfAdxPeriod,
      htfAdxMinTrend: effectiveHtfAdxMinTrend,
      htfUseChop: effectiveHtfUseChop,
      htfChopPeriod: effectiveHtfChopPeriod,
      htfChopRanging: effectiveHtfChopRanging,
      htfChopTrending: effectiveHtfChopTrending,
      requireVolumeSpike: effectiveRequireVolumeSpike,
      volumeLookback: effectiveVolumeLookback,
      volumeSpikeThreshold: effectiveVolumeSpikeThreshold,
      exitOnKijunBreak: effectiveExitOnKijunBreak,
      kijunBreakBufferBps: effectiveKijunBreakBufferBps,
      kijunBreakBufferAtr: effectiveKijunBreakBufferAtr,
      exitOnTenkanKijunCross: effectiveExitOnTenkanKijunCross,
      exitOnCloudReentry: effectiveExitOnCloudReentry,
      exitOnCloudFlip: effectiveExitOnCloudFlip,
      timeStopBars: effectiveTimeStopBars,
      hardStopEnabled: effectiveHardStopEnabled,
      hardStopAtrMult: effectiveHardStopAtr,
      hardStopPercent: effectiveHardStopPercent,
      enableAtrTrail: effectiveEnableAtrTrail,
      trailAtrMult: effectiveTrailAtrMult,
      exitOscillator: effectiveExitOscillator,
      exitRsiPeriod: effectiveExitRsiPeriod,
      exitRsiLong: effectiveExitRsiLong,
      exitRsiShort: effectiveExitRsiShort,
      exitMacdFast: effectiveExitMacdFast,
      exitMacdSlow: effectiveExitMacdSlow,
      exitMacdSignal: effectiveExitMacdSignal,
      allowLongs: effectiveAllowLongs,
      allowShorts: effectiveAllowShorts,
    },
    // Circuit breaker settings (from CLI options to bypass dotenv override)
    maxConsecutiveLosses: options.circuitBreakerMaxLosses,
    circuitBreakerCooldownMs: options.circuitBreakerCooldownMs,
  };

  const strategy = new IchimokuCloudBreakoutStrategy(strategyConfig);

  // Run simulation
  // - backtest: bar-open entries using previous-bar indicators (historical model)
  // - bot: tick-level loop with getSignal/shouldClose each tick (bot.js parity)
  const isBotModel =
    String(options._traceModel || options.traceModel || "backtest").toLowerCase() === "bot";
  const simFn = isBotModel ? simulateBotRuntimeSingleMarket : simulateIchimokuCloud;
  const result = simFn(strategy, candles, {
    positionSizeUsd: options.positionSize,
    leverage: effectiveLeverage,
    hardStopPercent: effectiveHardStopPercent,
    // Static TP/SL mode (mutually exclusive with strategy exits in this backtest harness)
    useRiskTP: effectiveUseRiskTP,
    stopLossPercent: effectiveStopLossPercent,
    takeProfitPercent: effectiveTakeProfitPercent,
    useTrailingStop: effectiveUseTrailingStop,
    trailingStopPercent: effectiveTrailingStopPercent,
    debug: options.debug,
    verbose: options.verbose,
    allowLongs: effectiveAllowLongs,
    allowShorts: effectiveAllowShorts,
    maxPositions: options.maxPositions,
    // No-lookahead: tick simulation is ONLY allowed when we have real 1m candles.
    simulateTicks: tickSimEnabled && !!(oneMinCandles && oneMinCandles.length > 0),
    ticksPerCandle: tickSimEnabled ? TICKS_PER_15MIN_CANDLE : 1,
    // 1-minute candles for accurate tick simulation
    oneMinCandles: oneMinCandles,
    // Tick cache for fast per-bar tick lookups
    ticksByBarOpenTime,
    symbol,
    // Compounding parameters
    enableCompounding: options.enableCompounding,
    initialCapital: options.initialCapital,
    positionSizePercent: options.positionSizePercent,
    minPositionSize: options.minPositionSize,
    // Parity guardrails / deterministic execution
    parityChecks: options.parityChecks,
    // Trace
    _trace: options._trace,
    _traceModel: isBotModel ? "bot" : options._traceModel || "backtest",
  });

  // Log circuit breaker summary (aggregated, not individual events)
  if (typeof strategy.logCircuitBreakerSummary === "function") {
    strategy.logCircuitBreakerSummary();
  }

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

  // ------------------------------------------------------------
  // Repro helper: load best.cfg from workflow/phase JSON and apply
  // ------------------------------------------------------------
  if (options.cfgFrom) {
    const loaded = loadBestCfgFromJsonFile({ filePath: options.cfgFrom, phase: options.cfgPhase });
    if (!loaded?.cfg) {
      throw new Error(`[cfgFrom] No best.cfg found in ${loaded?.absPath || options.cfgFrom}`);
    }

    // Mimic workflow behavior: apply cfg at the options level, and also force it via marketOverrides.
    for (const [k, v] of Object.entries(loaded.cfg || {})) {
      if (v === undefined || v === null) continue;
      if (Object.prototype.hasOwnProperty.call(options, k)) options[k] = v;
    }

    // Recalculate derived position size if percent sizing inputs changed.
    if (options.positionSizingMethod === "percent") {
      const calculatedSize = (options.positionSizePercent / 100) * options.initialCapital;
      options.positionSize = Math.min(
        Math.max(calculatedSize, options.positionSize),
        options.maxPositionSize
      );
    }

    const cfgSymbol = normalizeSymbolInput(loaded?.meta?.symbol || "");
    const effectiveSymbol =
      options._cliSymbol || options._cliSymbols
        ? normalizeSymbolInput(options.symbols?.[0] || options.symbol || "")
        : cfgSymbol;
    if (!effectiveSymbol) {
      throw new Error(
        `[cfgFrom] Could not infer symbol. Pass --symbol=<SYMBOL> or use a cfg file with meta.symbol.`
      );
    }

    if (!options._cliSymbol && !options._cliSymbols) {
      options.symbol = effectiveSymbol;
      options.symbols = [effectiveSymbol];
    }
    const cfgUseMetaRange = options.cfgUseMetaRange !== false;
    if ((!options._cliDays || cfgUseMetaRange) && Number.isFinite(Number(loaded?.meta?.days))) {
      options.days = Number(loaded.meta.days);
    }

    // Only force the exact historical time range when the user didn't provide a custom days/window.
    const allowMetaRange = cfgUseMetaRange && !options._cliStartTime && !options._cliEndTime;
    if (allowMetaRange && Number.isFinite(Number(loaded?.meta?.startTime))) {
      options.startTime = Number(loaded.meta.startTime);
    }
    if (allowMetaRange && Number.isFinite(Number(loaded?.meta?.endTime))) {
      options.endTime = Number(loaded.meta.endTime);
    }

    const symbolKey = String(effectiveSymbol || "").toUpperCase();
    options.marketOverrides = options.marketOverrides || {};
    options.marketOverrides[symbolKey] = {
      ...(options.marketOverrides[symbolKey] || {}),
      ...loaded.cfg,
    };
    if (options._cliExitOscillator) {
      options.marketOverrides[symbolKey].exitOscillator = options.exitOscillator;
    }

    console.log(
      `[cfgFrom] Applied best.cfg from ${loaded.absPath} (${symbolKey}${
        options.cfgPhase ? ` phase=${options.cfgPhase}` : ""
      })`
    );
  }

  console.log("\n🔄 Ichimoku Cloud Breakout Strategy Backtest");
  console.log("=".repeat(60));

  // Print full config summary (loaded from .env.ichimoku-cloud)
  console.log("\n📋 CONFIG (from .env.ichimoku)");
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
  const singleMarket = options.symbols.length === 1;
  const effectiveLevPreview = singleMarket
    ? getPerMarketLeveragePreview(options, options.symbols[0])
    : null;
  const leverageLabel =
    singleMarket && Number.isFinite(effectiveLevPreview) && effectiveLevPreview !== options.leverage
      ? `${effectiveLevPreview}x (base ${options.leverage}x)`
      : `${options.leverage}x`;
  console.log(`  Leverage:            ${leverageLabel}`);

  console.log("\n📊 ICHIMOKU PARAMETERS (Global Defaults)");
  console.log("-".repeat(60));
  console.log(
    `  Tenkan/Kijun/SenkouB/Shift: ${options.tenkanPeriod}/${options.kijunPeriod}/${options.senkouBPeriod}/${options.shift}`
  );
  console.log(`  ADX Period / Min Trend:     ${options.adxPeriod} / ${options.adxMinTrend}`);
  console.log(`  ATR Period / Stop Mult:     ${options.atrPeriod} / ${options.atrStopMultiplier}`);
  console.log(`  Break Buffer ATR:           ${options.breakBufferAtr}`);
  console.log(`  Max Entry Dist ATR:         ${options.maxEntryDistAtr}`);
  console.log(
    `  HTF Regime:                 ${options.enableHtfRegime ? "ON" : "OFF"} (x${options.htfMultiplier}, ADX min ${options.htfAdxMinTrend})`
  );
  console.log(`  Exit Oscillator:            ${options.exitOscillator}`);

  // Show per-market overrides if any
  const perMarketOverrides = [];
  for (const sym of options.symbols) {
    const mKey = `${sym}_PERP`.toUpperCase();
    const lev = process.env[`STRATEGY_${mKey}_LEVERAGE`];
    const hardStop = process.env[`STRATEGY_${mKey}_ICHIMOKU_HARD_STOP_PERCENT`];
    const hardStopAtr = process.env[`STRATEGY_${mKey}_ICHIMOKU_HARD_STOP_ATR_MULT`];
    const adxMin = process.env[`STRATEGY_${mKey}_ICHIMOKU_ADX_MIN_TREND`];
    const breakBufAtr = process.env[`STRATEGY_${mKey}_ICHIMOKU_BREAK_BUFFER_ATR`];
    const breakBufBps = process.env[`STRATEGY_${mKey}_ICHIMOKU_BREAK_BUFFER_BPS`];
    const maxEntryAtr = process.env[`STRATEGY_${mKey}_ICHIMOKU_MAX_ENTRY_DIST_ATR`];
    const atrStopMult = process.env[`STRATEGY_${mKey}_ICHIMOKU_ATR_STOP_MULTIPLIER`];
    const allowLongs = process.env[`STRATEGY_${mKey}_ALLOW_LONGS`];
    const allowShorts = process.env[`STRATEGY_${mKey}_ALLOW_SHORTS`];
    const parts = [];

    if (adxMin) parts.push(`adxMin=${adxMin}`);
    if (breakBufAtr) parts.push(`breakBufATR=${breakBufAtr}`);
    if (breakBufBps) parts.push(`breakBufBps=${breakBufBps}`);
    if (maxEntryAtr) parts.push(`maxEntryATR=${maxEntryAtr}`);
    if (atrStopMult) parts.push(`atrStop=${atrStopMult}`);
    if (lev) parts.push(`lev=${lev}x`);
    if (hardStop) parts.push(`hardStop=${hardStop}%`);
    if (hardStopAtr) parts.push(`hardStopATR=${hardStopAtr}x`);
    if (allowLongs || allowShorts) {
      const l =
        allowLongs === undefined
          ? options.allowLongs
            ? "L"
            : "-"
          : allowLongs === "true" || allowLongs === "1"
            ? "L"
            : "-";
      const s =
        allowShorts === undefined
          ? options.allowShorts
            ? "S"
            : "-"
          : allowShorts === "true" || allowShorts === "1"
            ? "S"
            : "-";
      parts.push(`dirs=${l}${s}`);
    }
    if (parts.length > 0) perMarketOverrides.push(`  ${sym}: ${parts.join(", ")}`);
  }
  if (perMarketOverrides.length > 0) {
    console.log("\n📈 PER-MARKET OVERRIDES");
    console.log("-".repeat(60));
    perMarketOverrides.forEach((l) => console.log(l));
  }

  console.log("\n🛡️ STOP LOSS CONFIG");
  console.log("-".repeat(60));
  console.log(`  Hard Stop Enabled:   ${options.hardStopEnabled ? "YES" : "NO"}`);
  console.log(`  Hard Stop ATR:       ${options.hardStopAtrMult}x ATR`);
  console.log(
    `  Hard Stop % (global): ${options.hardStopPercent > 0 ? options.hardStopPercent + "%" : "disabled (using ATR)"} (per-market overrides may apply)`
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
    const ichiEnabled =
      String(process.env.ICHIMOKU_ALLOCATOR_RISK_ENABLED || "")
        .trim()
        .toLowerCase() === "true" ||
      String(process.env.ICHIMOKU_ALLOCATOR_RISK_ENABLED || "")
        .trim()
        .toLowerCase() === "1";
    if (options.allocatorRiskNeutral) {
      console.log(`  Status:              NEUTRAL (parity mode - returns base values)`);
    } else {
      console.log(
        `  Status:              ENABLED (dynamic size/leverage/stops${ichiEnabled ? " - ichimoku" : ""})`
      );
    }
    if (ichiEnabled) {
      console.log(
        `  Ichi Size Mult:      ${parseFloat(process.env.ICHIMOKU_ALLOCATOR_RISK_SIZE_MULT_MIN || 0.7).toFixed(2)}x - ${parseFloat(process.env.ICHIMOKU_ALLOCATOR_RISK_SIZE_MULT_MAX || 1.1).toFixed(2)}x`
      );
      console.log(
        `  Ichi Lev Mult:       ${parseFloat(process.env.ICHIMOKU_ALLOCATOR_RISK_LEV_MULT_MIN || 0.9).toFixed(2)}x - ${parseFloat(process.env.ICHIMOKU_ALLOCATOR_RISK_LEV_MULT_MAX || 1.1).toFixed(2)}x`
      );
      console.log(
        `  Ichi Rank Tilt:      ${parseFloat(process.env.ICHIMOKU_ALLOCATOR_RISK_RANK_TILT || 0.5).toFixed(2)} (power ${parseFloat(process.env.ICHIMOKU_ALLOCATOR_RISK_RANK_POWER || 2.0).toFixed(1)})`
      );
      console.log(
        `  Ichi Gamma:          ${parseFloat(process.env.ICHIMOKU_ALLOCATOR_RISK_GAMMA || 1.0).toFixed(2)}`
      );
    } else {
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
    }
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
  // When explicit timestamps are provided, snap to 15-minute candles.
  const BAR_ALIGN_MS = BAR_INTERVAL_MS;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  let endTime, startTime;

  if (Number.isFinite(options.endTime) && Number.isFinite(options.startTime)) {
    // Both start and end explicitly provided: snap to 15-min candles
    const rawEnd = options.endTime;
    const rawStart = options.startTime;
    endTime = alignToCandleCloseMs(rawEnd, BAR_ALIGN_MS);
    startTime = alignToCandleOpenMs(rawStart, BAR_ALIGN_MS);
  } else if (Number.isFinite(options.endTime)) {
    // Only end provided: snap end to 15-min, calculate start from lookback days
    const rawEnd = options.endTime;
    endTime = alignToCandleCloseMs(rawEnd, BAR_ALIGN_MS);
    startTime = alignToCandleOpenMs(endTime - options.days * ONE_DAY_MS, BAR_ALIGN_MS);
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
    startTime = alignToCandleOpenMs(lastCompletedDayStart, BAR_ALIGN_MS);
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
      (options.interval || "15m") === "15m"
        ? TICK_INTERVAL_MS
        : Math.floor(
            intervalToMs(options.interval || "15m") /
              (options.ticksPerCandle || TICKS_PER_15MIN_CANDLE)
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
          const interval = modelOptions.interval || "15m";
          const candles = await fetchCandles(symbol, interval, startTime, endTime);
          if (!candles || candles.length === 0) continue;
          candlesMap.set(symbol, candles);

          const marketKey = `${symbol}_PERP`.toUpperCase();
          const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
          const envLev = process.env[`STRATEGY_${marketKey}_LEVERAGE`];
          const envHardStopPct = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HARD_STOP_PERCENT`];
          const envHardStopAtr = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HARD_STOP_ATR_MULT`];
          const envAdxMinTrend = process.env[`STRATEGY_${marketKey}_ICHIMOKU_ADX_MIN_TREND`];
          const envBreakBufferBps = process.env[`STRATEGY_${marketKey}_ICHIMOKU_BREAK_BUFFER_BPS`];
          const envBreakBufferAtr = process.env[`STRATEGY_${marketKey}_ICHIMOKU_BREAK_BUFFER_ATR`];
          const envMaxEntryDistAtr =
            process.env[`STRATEGY_${marketKey}_ICHIMOKU_MAX_ENTRY_DIST_ATR`];
          const envAtrStopMultiplier =
            process.env[`STRATEGY_${marketKey}_ICHIMOKU_ATR_STOP_MULTIPLIER`];

          // CLI override takes precedence over env file (to bypass dotenv override issue)
          const marketLeverage =
            modelOptions.cliMarketLeverage?.get(symbol) ??
            (envLev !== undefined && envLev !== "" ? parseFloat(envLev) : modelOptions.leverage);
          const marketHardStop =
            envHardStopPct !== undefined && envHardStopPct !== ""
              ? parseFloat(envHardStopPct)
              : modelOptions.hardStopPercent;
          const marketHardStopAtr =
            envHardStopAtr !== undefined && envHardStopAtr !== ""
              ? parseFloat(envHardStopAtr)
              : modelOptions.hardStopAtrMult;
          const marketAdxMinTrend = has(envAdxMinTrend)
            ? parseFloat(envAdxMinTrend)
            : modelOptions.adxMinTrend;
          const marketBreakBufferBps = has(envBreakBufferBps)
            ? parseFloat(envBreakBufferBps)
            : modelOptions.breakBufferBps;
          const marketBreakBufferAtr = has(envBreakBufferAtr)
            ? parseFloat(envBreakBufferAtr)
            : modelOptions.breakBufferAtr;
          const marketMaxEntryDistAtr = has(envMaxEntryDistAtr)
            ? parseFloat(envMaxEntryDistAtr)
            : modelOptions.maxEntryDistAtr;
          const marketAtrStopMultiplier = has(envAtrStopMultiplier)
            ? parseFloat(envAtrStopMultiplier)
            : modelOptions.atrStopMultiplier;

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

          const envDisabledHoursUtc =
            process.env[`STRATEGY_${marketKey}_TRADING_DISABLED_HOURS_UTC`];
          const envAllowedHoursUtc = process.env[`STRATEGY_${marketKey}_TRADING_ALLOWED_HOURS_UTC`];
          const marketTradingDisabledHoursUtc = has(envDisabledHoursUtc)
            ? String(envDisabledHoursUtc).trim()
            : modelOptions.tradingDisabledHoursUtc;
          const marketTradingAllowedHoursUtc = has(envAllowedHoursUtc)
            ? String(envAllowedHoursUtc).trim()
            : modelOptions.tradingAllowedHoursUtc;

          const strategy = new IchimokuCloudBreakoutStrategy({
            market: `${symbol}-PERP`,
            quiet: true,
            ichimokuStrategy: {
              tenkanPeriod: modelOptions.tenkanPeriod,
              kijunPeriod: modelOptions.kijunPeriod,
              senkouBPeriod: modelOptions.senkouBPeriod,
              shift: modelOptions.shift,
              tradingDisabledHoursUtc: marketTradingDisabledHoursUtc,
              tradingAllowedHoursUtc: marketTradingAllowedHoursUtc,
              minBars: modelOptions.minBars,
              adxPeriod: modelOptions.adxPeriod,
              adxMinTrend: marketAdxMinTrend,
              atrPeriod: modelOptions.atrPeriod,
              atrStopMultiplier: marketAtrStopMultiplier,
              breakBufferBps: marketBreakBufferBps,
              breakBufferAtr: marketBreakBufferAtr,
              maxEntryDistAtr: marketMaxEntryDistAtr,
              requireTenkanKijunAlign: modelOptions.requireTenkanKijunAlign,
              enableHtfRegime: modelOptions.enableHtfRegime,
              htfMultiplier: modelOptions.htfMultiplier,
              htfAdxPeriod: modelOptions.htfAdxPeriod,
              htfAdxMinTrend: modelOptions.htfAdxMinTrend,
              htfUseChop: modelOptions.htfUseChop,
              htfChopPeriod: modelOptions.htfChopPeriod,
              htfChopRanging: modelOptions.htfChopRanging,
              htfChopTrending: modelOptions.htfChopTrending,
              requireVolumeSpike: modelOptions.requireVolumeSpike,
              volumeLookback: modelOptions.volumeLookback,
              volumeSpikeThreshold: modelOptions.volumeSpikeThreshold,
              exitOnKijunBreak: modelOptions.exitOnKijunBreak,
              kijunBreakBufferBps: modelOptions.kijunBreakBufferBps,
              kijunBreakBufferAtr: modelOptions.kijunBreakBufferAtr,
              exitOnTenkanKijunCross: modelOptions.exitOnTenkanKijunCross,
              exitOnCloudReentry: modelOptions.exitOnCloudReentry,
              exitOnCloudFlip: modelOptions.exitOnCloudFlip,
              timeStopBars: modelOptions.timeStopBars,
              hardStopEnabled: modelOptions.hardStopEnabled,
              hardStopAtrMult: marketHardStopAtr,
              hardStopPercent: marketHardStop,
              enableAtrTrail: modelOptions.enableAtrTrail,
              trailAtrMult: modelOptions.trailAtrMult,
              exitOscillator: modelOptions.exitOscillator,
              exitRsiPeriod: modelOptions.exitRsiPeriod,
              exitRsiLong: modelOptions.exitRsiLong,
              exitRsiShort: modelOptions.exitRsiShort,
              exitMacdFast: modelOptions.exitMacdFast,
              exitMacdSlow: modelOptions.exitMacdSlow,
              exitMacdSignal: modelOptions.exitMacdSignal,
              allowLongs: marketAllowLongs,
              allowShorts: marketAllowShorts,
            },
            maxConsecutiveLosses: modelOptions.circuitBreakerMaxLosses,
            circuitBreakerCooldownMs: modelOptions.circuitBreakerCooldownMs,
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
          ticksPerCandle: modelOptions.ticksPerCandle || TICKS_PER_15MIN_CANDLE,
          simulateTicks: true,
          hardStopPercent: modelOptions.hardStopPercent,
          hardStopAtrMult: modelOptions.hardStopAtrMult,
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

    const interval = options.interval || "15m";
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

          if (interval === "15m" && use1MinTicks) {
            console.log(`\n📥 Fetching ${symbol} 1m candles (for accurate tick simulation)...`);
            let oneMin = await fetchCandles(symbol, "1m", startTime, endTime, source);
            if (!oneMin || oneMin.length === 0)
              throw new Error(`No 1m candles for ${symbol} (${source})`);

            // Production parity: Pyth history does not reliably include volume. Many Ichimoku configs
            // gate entries on volume spikes, so multi-market runs must merge Binance volume here
            // (same behavior as single-market runs and prefetchSingleMarketData()).
            if (source === "pyth") {
              oneMin = await attachBinanceVolumeToPythCandles({
                symbol,
                interval: "1m",
                startTime,
                endTime,
                candles: oneMin,
              });
            }

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
                    for (let i = 0; i < oneMin.length; i += 15) {
                      const g = oneMin.slice(i, i + 15);
                      if (g.length === 15) out.push(aggregate1MinTo15Min(g));
                    }
                    return out;
                  })()
                : aggregate1MinTo15MinAligned(oneMin);
            if (!agg || agg.length === 0)
              throw new Error(`No 15m candles after aggregation for ${symbol} (${source})`);

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
                `   ${oneMinCount} 1m candles → ${agg.length} 15m candles (${options.aggregation || "aligned"}) [1m released]`
              );
            } else {
              console.log(
                `   ${oneMin.length} 1m candles → ${agg.length} 15m candles (${options.aggregation || "aligned"})`
              );
            }
          } else {
            console.log(`\n📥 Fetching ${symbol} ${interval} candles...`);
            let candles = await fetchCandles(symbol, interval, startTime, endTime, source);
            if (!candles || candles.length === 0)
              throw new Error(`No ${interval} candles for ${symbol} (${source})`);

            if (source === "pyth") {
              candles = await attachBinanceVolumeToPythCandles({
                symbol,
                interval,
                startTime,
                endTime,
                candles,
              });
            }

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
    if (use1MinTicks && interval === "15m" && oneMinCandlesMap.size > 0) {
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
    } else if (use1MinTicks && interval === "15m" && release1mAfterTicks) {
      console.log(`   ✓ 1m data validated during loading (released after tick cache build)`);
    }

    // Build strategies AFTER candles are successfully loaded (single-source guarantee)
    for (const symbol of options.symbols) {
      // Get per-market settings
      const marketKey = `${symbol}_PERP`.toUpperCase();
      const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
      const envLev = process.env[`STRATEGY_${marketKey}_LEVERAGE`];
      const envHardStopPct = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HARD_STOP_PERCENT`];
      const envHardStopAtr = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HARD_STOP_ATR_MULT`];
      const envAdxMinTrend = process.env[`STRATEGY_${marketKey}_ICHIMOKU_ADX_MIN_TREND`];
      const envBreakBufferBps = process.env[`STRATEGY_${marketKey}_ICHIMOKU_BREAK_BUFFER_BPS`];
      const envBreakBufferAtr = process.env[`STRATEGY_${marketKey}_ICHIMOKU_BREAK_BUFFER_ATR`];
      const envMaxEntryDistAtr = process.env[`STRATEGY_${marketKey}_ICHIMOKU_MAX_ENTRY_DIST_ATR`];
      const envAtrStopMultiplier =
        process.env[`STRATEGY_${marketKey}_ICHIMOKU_ATR_STOP_MULTIPLIER`];
      const envTenkanPeriod = process.env[`STRATEGY_${marketKey}_ICHIMOKU_TENKAN_PERIOD`];
      const envKijunPeriod = process.env[`STRATEGY_${marketKey}_ICHIMOKU_KIJUN_PERIOD`];
      const envSenkouBPeriod = process.env[`STRATEGY_${marketKey}_ICHIMOKU_SENKOU_B_PERIOD`];
      const envShift = process.env[`STRATEGY_${marketKey}_ICHIMOKU_SHIFT`];
      const envMinBars = process.env[`STRATEGY_${marketKey}_ICHIMOKU_MIN_BARS`];
      const envAdxPeriod = process.env[`STRATEGY_${marketKey}_ICHIMOKU_ADX_PERIOD`];
      const envAtrPeriod = process.env[`STRATEGY_${marketKey}_ICHIMOKU_ATR_PERIOD`];
      const envRequireTenkanKijunAlign =
        process.env[`STRATEGY_${marketKey}_ICHIMOKU_REQUIRE_TENKAN_KIJUN_ALIGN`];
      const envEnableHtfRegime = process.env[`STRATEGY_${marketKey}_ICHIMOKU_ENABLE_HTF_REGIME`];
      const envHtfMultiplier = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HTF_MULTIPLIER`];
      const envHtfAdxPeriod = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HTF_ADX_PERIOD`];
      const envHtfAdxMinTrend = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HTF_ADX_MIN_TREND`];
      const envHtfUseChop = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HTF_USE_CHOP`];
      const envHtfChopPeriod = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HTF_CHOP_PERIOD`];
      const envHtfChopRanging = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HTF_CHOP_RANGING`];
      const envHtfChopTrending = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HTF_CHOP_TRENDING`];
      const envRequireVolumeSpike =
        process.env[`STRATEGY_${marketKey}_ICHIMOKU_REQUIRE_VOLUME_SPIKE`];
      const envVolumeLookback = process.env[`STRATEGY_${marketKey}_ICHIMOKU_VOLUME_LOOKBACK`];
      const envVolumeSpikeThreshold =
        process.env[`STRATEGY_${marketKey}_ICHIMOKU_VOLUME_SPIKE_THRESHOLD`];
      const envExitOnKijunBreak = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_ON_KIJUN_BREAK`];
      const envKijunBreakBufferBps =
        process.env[`STRATEGY_${marketKey}_ICHIMOKU_KIJUN_BREAK_BUFFER_BPS`];
      const envKijunBreakBufferAtr =
        process.env[`STRATEGY_${marketKey}_ICHIMOKU_KIJUN_BREAK_BUFFER_ATR`];
      const envExitOnTenkanKijunCross =
        process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_ON_TENKAN_KIJUN_CROSS`];
      const envExitOnCloudReentry =
        process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_ON_CLOUD_REENTRY`];
      const envExitOnCloudFlip = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_ON_CLOUD_FLIP`];
      const envTimeStopBars = process.env[`STRATEGY_${marketKey}_ICHIMOKU_TIME_STOP_BARS`];
      const envHardStopEnabled = process.env[`STRATEGY_${marketKey}_ICHIMOKU_HARD_STOP_ENABLED`];
      const envEnableAtrTrail = process.env[`STRATEGY_${marketKey}_ICHIMOKU_ENABLE_ATR_TRAIL`];
      const envTrailAtrMult = process.env[`STRATEGY_${marketKey}_ICHIMOKU_TRAIL_ATR_MULT`];
      const envExitOscillator = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_OSCILLATOR`];
      const envExitRsiPeriod = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_RSI_PERIOD`];
      const envExitRsiLong = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_RSI_LONG`];
      const envExitRsiShort = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_RSI_SHORT`];
      const envExitMacdFast = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_MACD_FAST`];
      const envExitMacdSlow = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_MACD_SLOW`];
      const envExitMacdSignal = process.env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_MACD_SIGNAL`];

      // CLI override takes precedence over env file (to bypass dotenv override issue)
      const marketLeverage =
        options.cliMarketLeverage?.get(symbol) ??
        (envLev !== undefined && envLev !== "" ? parseFloat(envLev) : options.leverage);
      // Allow explicit 0 to force ATR-based stops
      const marketHardStop =
        envHardStopPct !== undefined && envHardStopPct !== ""
          ? parseFloat(envHardStopPct)
          : options.hardStopPercent;
      const marketHardStopAtr =
        envHardStopAtr !== undefined && envHardStopAtr !== ""
          ? parseFloat(envHardStopAtr)
          : options.hardStopAtrMult;
      const marketAdxMinTrend = has(envAdxMinTrend)
        ? parseFloat(envAdxMinTrend)
        : options.adxMinTrend;
      const marketBreakBufferBps = has(envBreakBufferBps)
        ? parseFloat(envBreakBufferBps)
        : options.breakBufferBps;
      const marketBreakBufferAtr = has(envBreakBufferAtr)
        ? parseFloat(envBreakBufferAtr)
        : options.breakBufferAtr;
      const marketMaxEntryDistAtr = has(envMaxEntryDistAtr)
        ? parseFloat(envMaxEntryDistAtr)
        : options.maxEntryDistAtr;
      const marketAtrStopMultiplier = has(envAtrStopMultiplier)
        ? parseFloat(envAtrStopMultiplier)
        : options.atrStopMultiplier;
      const marketTenkanPeriod = has(envTenkanPeriod)
        ? parseFloat(envTenkanPeriod)
        : options.tenkanPeriod;
      const marketKijunPeriod = has(envKijunPeriod)
        ? parseFloat(envKijunPeriod)
        : options.kijunPeriod;
      const marketSenkouBPeriod = has(envSenkouBPeriod)
        ? parseFloat(envSenkouBPeriod)
        : options.senkouBPeriod;
      const marketShift = has(envShift) ? parseFloat(envShift) : options.shift;
      const marketMinBars = has(envMinBars) ? parseFloat(envMinBars) : options.minBars;
      const marketAdxPeriod = has(envAdxPeriod) ? parseFloat(envAdxPeriod) : options.adxPeriod;
      const marketAtrPeriod = has(envAtrPeriod) ? parseFloat(envAtrPeriod) : options.atrPeriod;
      const marketRequireTenkanKijunAlign = has(envRequireTenkanKijunAlign)
        ? envRequireTenkanKijunAlign === "true" || envRequireTenkanKijunAlign === "1"
        : options.requireTenkanKijunAlign;
      const marketEnableHtfRegime = has(envEnableHtfRegime)
        ? envEnableHtfRegime === "true" || envEnableHtfRegime === "1"
        : options.enableHtfRegime;
      const marketHtfMultiplier = has(envHtfMultiplier)
        ? parseFloat(envHtfMultiplier)
        : options.htfMultiplier;
      const marketHtfAdxPeriod = has(envHtfAdxPeriod)
        ? parseFloat(envHtfAdxPeriod)
        : options.htfAdxPeriod;
      const marketHtfAdxMinTrend = has(envHtfAdxMinTrend)
        ? parseFloat(envHtfAdxMinTrend)
        : options.htfAdxMinTrend;
      const marketHtfUseChop = has(envHtfUseChop)
        ? envHtfUseChop === "true" || envHtfUseChop === "1"
        : options.htfUseChop;
      const marketHtfChopPeriod = has(envHtfChopPeriod)
        ? parseFloat(envHtfChopPeriod)
        : options.htfChopPeriod;
      const marketHtfChopRanging = has(envHtfChopRanging)
        ? parseFloat(envHtfChopRanging)
        : options.htfChopRanging;
      const marketHtfChopTrending = has(envHtfChopTrending)
        ? parseFloat(envHtfChopTrending)
        : options.htfChopTrending;
      const marketRequireVolumeSpike = has(envRequireVolumeSpike)
        ? envRequireVolumeSpike === "true" || envRequireVolumeSpike === "1"
        : options.requireVolumeSpike;
      const marketVolumeLookback = has(envVolumeLookback)
        ? parseFloat(envVolumeLookback)
        : options.volumeLookback;
      const marketVolumeSpikeThreshold = has(envVolumeSpikeThreshold)
        ? parseFloat(envVolumeSpikeThreshold)
        : options.volumeSpikeThreshold;
      const marketExitOnKijunBreak = has(envExitOnKijunBreak)
        ? envExitOnKijunBreak === "true" || envExitOnKijunBreak === "1"
        : options.exitOnKijunBreak;
      const marketKijunBreakBufferBps = has(envKijunBreakBufferBps)
        ? parseFloat(envKijunBreakBufferBps)
        : options.kijunBreakBufferBps;
      const marketKijunBreakBufferAtr = has(envKijunBreakBufferAtr)
        ? parseFloat(envKijunBreakBufferAtr)
        : options.kijunBreakBufferAtr;
      const marketExitOnTenkanKijunCross = has(envExitOnTenkanKijunCross)
        ? envExitOnTenkanKijunCross === "true" || envExitOnTenkanKijunCross === "1"
        : options.exitOnTenkanKijunCross;
      const marketExitOnCloudReentry = has(envExitOnCloudReentry)
        ? envExitOnCloudReentry === "true" || envExitOnCloudReentry === "1"
        : options.exitOnCloudReentry;
      const marketExitOnCloudFlip = has(envExitOnCloudFlip)
        ? envExitOnCloudFlip === "true" || envExitOnCloudFlip === "1"
        : options.exitOnCloudFlip;
      const marketTimeStopBars = has(envTimeStopBars)
        ? parseFloat(envTimeStopBars)
        : options.timeStopBars;
      const marketHardStopEnabled = has(envHardStopEnabled)
        ? envHardStopEnabled === "true" || envHardStopEnabled === "1"
        : options.hardStopEnabled;
      const marketEnableAtrTrail = has(envEnableAtrTrail)
        ? envEnableAtrTrail === "true" || envEnableAtrTrail === "1"
        : options.enableAtrTrail;
      const marketTrailAtrMult = has(envTrailAtrMult)
        ? parseFloat(envTrailAtrMult)
        : options.trailAtrMult;
      const marketExitOscillator = has(envExitOscillator)
        ? String(envExitOscillator).trim().toLowerCase()
        : options.exitOscillator;
      const marketExitRsiPeriod = has(envExitRsiPeriod)
        ? parseFloat(envExitRsiPeriod)
        : options.exitRsiPeriod;
      const marketExitRsiLong = has(envExitRsiLong)
        ? parseFloat(envExitRsiLong)
        : options.exitRsiLong;
      const marketExitRsiShort = has(envExitRsiShort)
        ? parseFloat(envExitRsiShort)
        : options.exitRsiShort;
      const marketExitMacdFast = has(envExitMacdFast)
        ? parseFloat(envExitMacdFast)
        : options.exitMacdFast;
      const marketExitMacdSlow = has(envExitMacdSlow)
        ? parseFloat(envExitMacdSlow)
        : options.exitMacdSlow;
      const marketExitMacdSignal = has(envExitMacdSignal)
        ? parseFloat(envExitMacdSignal)
        : options.exitMacdSignal;

      // Per-market direction gates (ALLOW_LONGS / ALLOW_SHORTS)
      const envAllowLongs = process.env[`STRATEGY_${marketKey}_ALLOW_LONGS`];
      const envAllowShorts = process.env[`STRATEGY_${marketKey}_ALLOW_SHORTS`];
      const marketAllowLongs = has(envAllowLongs)
        ? envAllowLongs === "true" || envAllowLongs === "1"
        : options.allowLongs;
      const marketAllowShorts = has(envAllowShorts)
        ? envAllowShorts === "true" || envAllowShorts === "1"
        : options.allowShorts;

      const envDisabledHoursUtc = process.env[`STRATEGY_${marketKey}_TRADING_DISABLED_HOURS_UTC`];
      const envAllowedHoursUtc = process.env[`STRATEGY_${marketKey}_TRADING_ALLOWED_HOURS_UTC`];
      const marketTradingDisabledHoursUtc = has(envDisabledHoursUtc)
        ? String(envDisabledHoursUtc).trim()
        : options.tradingDisabledHoursUtc;
      const marketTradingAllowedHoursUtc = has(envAllowedHoursUtc)
        ? String(envAllowedHoursUtc).trim()
        : options.tradingAllowedHoursUtc;

      perMarketLeverage.set(symbol, marketLeverage);
      perMarketHardStop.set(symbol, marketHardStop);
      // ATR-based stop multiplier per market (only affects behavior if ICHIMOKU_HARD_STOP_PERCENT == 0)
      perMarketHardStopAtr.set(symbol, marketHardStopAtr);
      // Direction gates per market
      perMarketAllowLongs.set(symbol, marketAllowLongs);
      perMarketAllowShorts.set(symbol, marketAllowShorts);

      console.log(
        `   [${symbol}] Ichimoku: adxMin=${marketAdxMinTrend}, breakBufBps=${marketBreakBufferBps}, breakBufATR=${marketBreakBufferAtr}, maxEntryATR=${marketMaxEntryDistAtr}, atrStop=${marketAtrStopMultiplier}, leverage=${marketLeverage}x, hardStop=${marketHardStop}%/ATR=${marketHardStopAtr}x${marketAllowLongs !== options.allowLongs || marketAllowShorts !== options.allowShorts ? `, dirs=${marketAllowLongs ? "L" : "-"}${marketAllowShorts ? "S" : "-"}` : ""}`
      );

      // Create strategy for this market (using per-market overrides)
      const strategyConfig = {
        market: `${symbol}-PERP`,
        quiet: true,
        ichimokuStrategy: {
          tenkanPeriod: marketTenkanPeriod,
          kijunPeriod: marketKijunPeriod,
          senkouBPeriod: marketSenkouBPeriod,
          shift: marketShift,
          tradingDisabledHoursUtc: marketTradingDisabledHoursUtc,
          tradingAllowedHoursUtc: marketTradingAllowedHoursUtc,
          minBars: marketMinBars,
          adxPeriod: marketAdxPeriod,
          adxMinTrend: marketAdxMinTrend,
          atrPeriod: marketAtrPeriod,
          atrStopMultiplier: marketAtrStopMultiplier,
          breakBufferBps: marketBreakBufferBps,
          breakBufferAtr: marketBreakBufferAtr,
          maxEntryDistAtr: marketMaxEntryDistAtr,
          requireTenkanKijunAlign: marketRequireTenkanKijunAlign,
          enableHtfRegime: marketEnableHtfRegime,
          htfMultiplier: marketHtfMultiplier,
          htfAdxPeriod: marketHtfAdxPeriod,
          htfAdxMinTrend: marketHtfAdxMinTrend,
          htfUseChop: marketHtfUseChop,
          htfChopPeriod: marketHtfChopPeriod,
          htfChopRanging: marketHtfChopRanging,
          htfChopTrending: marketHtfChopTrending,
          requireVolumeSpike: marketRequireVolumeSpike,
          volumeLookback: marketVolumeLookback,
          volumeSpikeThreshold: marketVolumeSpikeThreshold,
          exitOnKijunBreak: marketExitOnKijunBreak,
          kijunBreakBufferBps: marketKijunBreakBufferBps,
          kijunBreakBufferAtr: marketKijunBreakBufferAtr,
          exitOnTenkanKijunCross: marketExitOnTenkanKijunCross,
          exitOnCloudReentry: marketExitOnCloudReentry,
          exitOnCloudFlip: marketExitOnCloudFlip,
          timeStopBars: marketTimeStopBars,
          hardStopEnabled: marketHardStopEnabled,
          hardStopAtrMult: marketHardStopAtr,
          hardStopPercent: marketHardStop,
          enableAtrTrail: marketEnableAtrTrail,
          trailAtrMult: marketTrailAtrMult,
          exitOscillator: marketExitOscillator,
          exitRsiPeriod: marketExitRsiPeriod,
          exitRsiLong: marketExitRsiLong,
          exitRsiShort: marketExitRsiShort,
          exitMacdFast: marketExitMacdFast,
          exitMacdSlow: marketExitMacdSlow,
          exitMacdSignal: marketExitMacdSignal,
          allowLongs: marketAllowLongs,
          allowShorts: marketAllowShorts,
        },
        // Circuit breaker settings (from CLI options to bypass dotenv override)
        maxConsecutiveLosses: options.circuitBreakerMaxLosses,
        circuitBreakerCooldownMs: options.circuitBreakerCooldownMs,
      };
      const strategy = new IchimokuCloudBreakoutStrategy(strategyConfig);
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
        interval === "15m" && use1MinTicks ? TICKS_PER_15MIN_CANDLE : options.ticksPerCandle || 1,
      simulateTicks: interval === "15m" && use1MinTicks,
      hardStopPercent: options.hardStopPercent,
      hardStopAtrMult: options.hardStopAtrMult,
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
    if (allocStats.totalSignalsBlockedCapacity > 0) {
      console.log(
        `  Blocked (Capacity):  ${allocStats.totalSignalsBlockedCapacity} (maxPositions limit at bar open)`
      );
    }
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
        const cap = stats.blockedCapacity ? `, ${stats.blockedCapacity} cap` : "";
        console.log(
          `    ${mkt}: ${stats.generated} gen, ${stats.accepted} accept (${acceptRate}%), ${stats.rejected} reject${cap}, ${stats.blockedCB} CB`
        );
      }
    }
  }

  // Fee breakdown - use actual fee config from environment
  const displayFeeCfg = buildFeeCfg();
  // Note: openFeeBps is the CONFIGURED rate (e.g., -0.25bps for maker)
  // Actual fees are a mix of maker (rebate) and taker (fee) based on fill simulation.

  // Workflow/sweep mode: suppress verbose reporting blocks (keeps stdout fast/clean).
  // Keep the portfolio summary + robust metrics + "Results saved to" lines intact.
  const __origConsoleLog = console.log;
  const __suppressVerbose = options.minimalOutput;
  if (__suppressVerbose) console.log = () => {};
  try {
    // ============================================================
    // COST SUMMARY (condensed)
    // ============================================================
    console.log(`💰 COST SUMMARY (${displayFeeCfg.model.toUpperCase()}/${displayFeeCfg.execMode})`);
    if (displayFeeCfg.model === "drift") {
      const openBps = Number(displayFeeCfg.openFeeBps) || 0;
      const closeBps = Number(displayFeeCfg.closeFeeBps) || 0;
      const empirical = displayFeeCfg.empiricalTakerFeeBps;
      const hasEmpirical = Number.isFinite(empirical) && empirical !== null;
      const adj = Number(displayFeeCfg.takerFeeAdjustmentBps) || 0;
      const mult = Number(displayFeeCfg.takerFeeMultiplier) || 1;
      const highLev = displayFeeCfg.highLeverageMode === true ? "on" : "off";
      const overrideTag = hasEmpirical ? " (DRIFT_TAKER_FEE_BPS override active)" : "";
      console.log(
        `  Rates:              open ${openBps.toFixed(3)}bps | close ${closeBps.toFixed(
          3
        )}bps | tier=${displayFeeCfg.tier} stake=${displayFeeCfg.stakingTier} highLev=${highLev} adj=${adj} mult=${mult}${overrideTag}`
      );
    }
    const liquidationStats = result?.liquidationStats ||
      (allResults.length > 0 && allResults[0]?.liquidationStats) || {
        enabled: String(process.env.ENABLE_LIQUIDATION_CHECK || "").toLowerCase() !== "false",
        count: 0,
        totalLoss: 0,
        maintenanceMarginPct: Number(process.env.DRIFT_MAINTENANCE_MARGIN_PCT) || 5,
      };
    const fundingFees = aggregateFees.fundingFees || 0;
    const borrowFees = aggregateFees.borrowFees || 0;
    const slippageUsdTotal = aggregateFees.slippageUsd || 0;
    const txFees = aggregateFees.txFees || 0;
    const openCloseFees = (aggregateFees.openFees || 0) + (aggregateFees.closeFees || 0);
    const impactSwapFees = (aggregateFees.impactFees || 0) + (aggregateFees.swapFees || 0);
    const liquidationLoss = liquidationStats?.totalLoss || 0;
    const liquidationCount = Number(liquidationStats?.count) || 0;
    const netPnL = totalPnL;
    // Robust definition: "gross" = P&L before fees (protocol/network/carry), derived from totals.
    // This avoids relying on per-trade fields that differ between simulation engines.
    const grossPnL = netPnL + totalFees;
    const feeImpact = grossPnL > 0 ? ((grossPnL - netPnL) / grossPnL) * 100 : 0;
    const allInCosts = totalFees + slippageUsdTotal + liquidationLoss;
    const slipMode =
      process.env.ENABLE_FIXED_SLIPPAGE === "true"
        ? `fixed ${Number(process.env.FIXED_SLIPPAGE_BPS) || 0}bps`
        : process.env.ENABLE_DYNAMIC_SLIPPAGE === "true"
          ? "dynamic"
          : "off";
    const entryStats = aggregateFees.makerEntryStats || null;
    const exitStats = aggregateFees.makerExitStats || null;
    let makerMixLabel = displayFeeCfg.execMode === "taker" ? "M/T: taker-only" : "M/T: n/a";
    if (entryStats?.attempts > 0) {
      const forcedTaker = Number(exitStats?.forcedTaker || 0);
      const totalExits = Number(exitStats?.attempts || 0) + forcedTaker;
      const totalFills = Number(entryStats.attempts || 0) + totalExits;
      const makerFills = Number(entryStats.makerFills || 0) + Number(exitStats?.makerFills || 0);
      const takerFills =
        Number(entryStats.takerFallbacks || 0) +
        Number(exitStats?.takerFallbacks || 0) +
        forcedTaker;
      if (totalFills > 0) {
        const makerPct = (makerFills / totalFills) * 100;
        const takerPct = (takerFills / totalFills) * 100;
        makerMixLabel = `M/T: ${makerPct.toFixed(1)}/${takerPct.toFixed(1)}%`;
      }
    }

    // Actual traded notional (sum of entry notionals). This is the right denominator for protocol bps.
    // Do NOT use options.positionSize when compounding/dynamic sizing is enabled.
    const totalEntryNotionalUsd = allTrades.reduce((acc, t) => acc + (Number(t.sizeUsd) || 0), 0);
    // Fees are charged on both legs (open+close), but we report bps on entry-side notional to avoid
    // double-counting "volume" (entry and exit notionals are effectively the same for this backtest).
    const protocolBpsOnEntryNotional =
      totalEntryNotionalUsd > 0 ? (openCloseFees / totalEntryNotionalUsd) * 10_000 : 0;
    const totalExitNotionalUsd = allTrades.reduce((acc, t) => {
      const qty = Number(t.quantity);
      const px = Number(t.exitPrice);
      const notional = Number.isFinite(qty) && Number.isFinite(px) ? qty * px : 0;
      return acc + (Number.isFinite(notional) ? notional : 0);
    }, 0);
    const openBpsOnEntryNotional =
      totalEntryNotionalUsd > 0
        ? ((aggregateFees.openFees || 0) / totalEntryNotionalUsd) * 10_000
        : 0;
    const closeBpsOnExitNotional =
      totalExitNotionalUsd > 0
        ? ((aggregateFees.closeFees || 0) / totalExitNotionalUsd) * 10_000
        : 0;

    console.log(
      `  Protocol:           $${openCloseFees.toFixed(2)} (open+close, ~${protocolBpsOnEntryNotional.toFixed(2)}bps on entry notional) | Impact+Swap: $${impactSwapFees.toFixed(2)} | ${makerMixLabel}`
    );
    if (displayFeeCfg.model === "drift") {
      console.log(
        `  Protocol bps:       open ~${openBpsOnEntryNotional.toFixed(
          2
        )}bps | close ~${closeBpsOnExitNotional.toFixed(2)}bps`
      );
    }
    console.log(`  Execution:          $${slippageUsdTotal.toFixed(2)} slippage (${slipMode})`);
    if (displayFeeCfg.model === "drift") {
      const fundingLabel =
        fundingFees >= 0 ? `+$${fundingFees.toFixed(2)}` : `-$${Math.abs(fundingFees).toFixed(2)}`;
      console.log(`  Carry:              funding ${fundingLabel} | borrow N/A`);
    } else {
      console.log(`  Carry:              borrow $${borrowFees.toFixed(2)} | funding N/A`);
    }
    console.log(`  Network:            $${txFees.toFixed(2)} (${totalTrades * 2} txs)`);
    console.log(
      `  Liquidations:       $${liquidationLoss.toFixed(2)} (${liquidationCount} events)`
    );
    console.log(
      `  Total fees:         $${totalFees.toFixed(2)} | All-in: $${allInCosts.toFixed(2)}`
    );
    console.log(`  Gross P&L:          $${grossPnL.toFixed(2)} | Net P&L: $${netPnL.toFixed(2)}`);
    console.log(`  Fee impact:         ${feeImpact.toFixed(1)}% of gross P&L`);

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
    const statsLeverage =
      singleMarket && Number.isFinite(effectiveLevPreview) ? effectiveLevPreview : options.leverage;
    console.log(`  Leverage:            ${statsLeverage}x`);
    console.log(
      `  Initial Notional:    $${(((sharedCapital * options.positionSizePercent) / 100) * statsLeverage).toFixed(0)}`
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
      const adxStr = t.exitAdx !== null && t.exitAdx !== undefined ? t.exitAdx.toFixed(1) : "N/A";
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
        `${adxStr.padStart(6)} ${(t.exitReason || "unknown").padEnd(18)} ${balanceStr.padStart(12)} ` +
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
        "<15m": 0,
        "15-60m": 0,
        "1-2h": 0,
        "2-4h": 0,
        "4-8h": 0,
        "8-24h": 0,
        ">24h": 0,
      };

      for (const d of tradeDurations) {
        if (d < 15) buckets["<15m"]++;
        else if (d < 60) buckets["15-60m"]++;
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
      `ichimoku-backtest-${options.symbols.join("-")}-${options.days}d-${Date.now()}.json`
    );
    const workflowSummary = summarizeIchimokuBacktestForWorkflow({
      trades: allTrades,
      equitySeries: result?.equitySeries || [],
      days: options.days,
      initialCapital: options.initialCapital,
      // Backtest is SoT: use engine net P&L (includes costs accounted by the sim).
      netPnlUsd: totalPnL,
    });
    const netReturnPct = options.initialCapital > 0 ? (totalPnL / options.initialCapital) * 100 : 0;

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
        positionSizingMethod: options.positionSizingMethod,
        positionSizePercent: options.positionSizePercent,
        initialCapital: options.initialCapital,
        allowLongs: options.allowLongs,
        allowShorts: options.allowShorts,
        maxPositions: options.maxPositions,
        tenkanPeriod: options.tenkanPeriod,
        kijunPeriod: options.kijunPeriod,
        senkouBPeriod: options.senkouBPeriod,
        shift: options.shift,
        minBars: options.minBars,
        adxPeriod: options.adxPeriod,
        adxMinTrend: options.adxMinTrend,
        atrPeriod: options.atrPeriod,
        atrStopMultiplier: options.atrStopMultiplier,
        breakBufferBps: options.breakBufferBps,
        breakBufferAtr: options.breakBufferAtr,
        maxEntryDistAtr: options.maxEntryDistAtr,
        requireTenkanKijunAlign: options.requireTenkanKijunAlign,
        enableHtfRegime: options.enableHtfRegime,
        htfMultiplier: options.htfMultiplier,
        htfAdxPeriod: options.htfAdxPeriod,
        htfAdxMinTrend: options.htfAdxMinTrend,
        htfUseChop: options.htfUseChop,
        htfChopPeriod: options.htfChopPeriod,
        htfChopRanging: options.htfChopRanging,
        htfChopTrending: options.htfChopTrending,
        requireVolumeSpike: options.requireVolumeSpike,
        volumeLookback: options.volumeLookback,
        volumeSpikeThreshold: options.volumeSpikeThreshold,
        exitOnKijunBreak: options.exitOnKijunBreak,
        kijunBreakBufferBps: options.kijunBreakBufferBps,
        kijunBreakBufferAtr: options.kijunBreakBufferAtr,
        exitOnTenkanKijunCross: options.exitOnTenkanKijunCross,
        exitOnCloudReentry: options.exitOnCloudReentry,
        exitOnCloudFlip: options.exitOnCloudFlip,
        timeStopBars: options.timeStopBars,
        exitOscillator: options.exitOscillator,
        exitRsiPeriod: options.exitRsiPeriod,
        exitRsiLong: options.exitRsiLong,
        exitRsiShort: options.exitRsiShort,
        exitMacdFast: options.exitMacdFast,
        exitMacdSlow: options.exitMacdSlow,
        exitMacdSignal: options.exitMacdSignal,
        hardStopEnabled: options.hardStopEnabled,
        hardStopPercent: options.hardStopPercent,
        hardStopAtrMult: options.hardStopAtrMult,
        enableAtrTrail: options.enableAtrTrail,
        trailAtrMult: options.trailAtrMult,
        effectiveBySymbol: options.symbols.map((sym) => {
          const symbol = String(sym || "").toUpperCase();
          const cfg =
            (strategyConfigsMapForRobustness instanceof Map
              ? strategyConfigsMapForRobustness.get(symbol)
              : null) || null;
          const lev =
            perMarketLeverageForRobustness instanceof Map
              ? perMarketLeverageForRobustness.get(symbol)
              : null;
          const hs =
            perMarketHardStopForRobustness instanceof Map
              ? perMarketHardStopForRobustness.get(symbol)
              : null;
          const hsAtr =
            perMarketHardStopAtrForRobustness instanceof Map
              ? perMarketHardStopAtrForRobustness.get(symbol)
              : null;

          const fallback = allResults.find((r) => r.symbol === symbol) || null;

          return {
            symbol,
            leverage: lev ?? fallback?.effectiveLeverage ?? null,
            hardStopPercent: hs ?? fallback?.effectiveHardStopPercent ?? null,
            hardStopAtrMult: hsAtr ?? fallback?.effectiveHardStopAtr ?? null,
            ichimoku: cfg?.ichimokuStrategy || fallback?.strategyConfig?.ichimokuStrategy || null,
          };
        }),
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
        // SoT: return based on engine net P&L.
        pnlUsd: totalPnL,
        returnPct: netReturnPct,
        // Keep trade-based P&L visible for debugging/drift analysis.
        tradeBasedPnlUsd: workflowSummary.tradeBasedPnlUsd,
        tradeBasedReturnPct: workflowSummary.tradeBasedReturnPct,
        ...(typeof robustSummary === "object" && robustSummary ? robustSummary : {}),
      },
      workflowSummary,
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
      enableBootstrap:
        process.env.ROBUST_BOOTSTRAP === "1" || process.env.ROBUST_BOOTSTRAP === "true", // Default OFF
      enableWalkForward:
        process.env.ROBUST_WALK_FORWARD === "1" || process.env.ROBUST_WALK_FORWARD === "true", // Default OFF
    };

    // Run robustness tests if enabled
    let jitterResult = null;
    let bootstrapResult = null;

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
      robustnessConfig.enableWalkForward
    ) {
      printRobustnessResults({
        jitterResult,
        bootstrapResult,
        walkForwardResult,
        robustnessConfig,
        formatUsd,
        formatPct,
      });

      // Persist robustness results into the main output JSON (so sweep scripts can rank stability).
      // NOTE: This intentionally stores only the lightweight objects returned by the robustness helpers.
      try {
        const existing = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        existing.robustness = {
          config: robustnessConfig,
          jitter: jitterResult || null,
          bootstrap: bootstrapResult || null,
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
  simulateIchimokuCloud,
  simulateMultiMarketSharedCapital,
  simulateBotRuntimeSingleMarket,
  simulateBotRuntimeMultiMarket,

  // Workflow/sweep integration helpers
  parseArgs,
  prefetchSingleMarketData,
  runBacktestForSymbol,
  summarizeIchimokuBacktestForWorkflow,
  runWalkForwardAnalysis,

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
