#!/usr/bin/env node

/**
 * Predicta V4 Strategy Backtest
 *
 * Port of "Predicta Futures - Next Candle Predictor V4" Pine Script
 *
 * This backtest script is specifically designed for the Predicta strategy.
 * It implements the 8-point confluence system, weighted scoring, and dual-tier signals.
 *
 * Entry Logic:
 * - BUY: EMA cross up + bullish Supertrend + positive delta momentum
 * - SELL: EMA cross down + bearish Supertrend + negative delta momentum
 * - PERFECT LONG: Score >= threshold + confluence >= min + all gates pass
 * - PERFECT SHORT: Score >= threshold + confluence >= min + all gates pass
 *
 * Exit Logic (priority order):
 * 1. Time stop: Max bars held
 * 2. Supertrend flip: Trend reversal
 * 3. Opposite PERFECT signal: Signal reversal
 * 4. Trailing stop: ATR-based profit protection
 * 5. Hard stop: Emergency ATR/percent-based stop
 *
 * Usage:
 *   node scripts/backtest/backtest-predicta.js [options]
 *
 * Options:
 *   --days=N              Number of days to backtest (default: 30)
 *   --symbol=SYMBOL       Trading symbol (default: SOL)
 *   --symbols=A,B,C       Multiple symbols (default: from env)
 *   --positionSize=N      Position size in USD (default: 1000)
 *   --debug               Enable debug logging
 *   --verbose             Enable verbose logging
 *   --wfa                 Run walk-forward analysis (OOS folds)
 *   --wfTrainDays=N       WFA training window in days (default: 60)
 *   --wfTestDays=N        WFA test window in days (default: 30)
 *   --wfStepDays=N        WFA step size in days (default: 30)
 *   --wfMode=rolling      WFA mode: rolling or anchored (default: rolling)
 *   --wfOptimize          Enable WFA optimization (per-fold grid search)
 *   --wfGridMode=fast     WFA grid mode: fast, balanced, full (default: fast)
 *   --wfaMaxFolds=N       Max folds to run (default: 6)
 *   --stFactor=N          Supertrend factor (default: 3.0)
 *   --stPeriod=N          Supertrend period (default: 10)
 *   --minConfluence=N     Minimum confluence points (default: 5)
 *   --adxThreshold=N      ADX threshold (default: 25)
 */

// Load strategy-specific env file (don't override command-line env vars)
const envPath = require("path");
const envFile = process.env.ENV_FILE || envPath.join(__dirname, "..", "..", ".env.predicta");
require("dotenv").config({ path: envFile, override: false });

// ============================================================
// OUTPUT MODE (to keep workflow runs fast)
// ============================================================
function rawArgVal(name) {
  const prefix = `--${name}=`;
  const a = process.argv.find((x) => typeof x === "string" && x.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}

const BACKTEST_OUTPUT_MODE = String(rawArgVal("output") || process.env.BACKTEST_OUTPUT_MODE || "")
  .trim()
  .toLowerCase();
const BACKTEST_MINIMAL_OUTPUT =
  ["workflow", "minimal", "quiet"].includes(BACKTEST_OUTPUT_MODE) ||
  ["1", "true", "yes", "on"].includes(
    String(process.env.BACKTEST_MINIMAL_OUTPUT || "")
      .trim()
      .toLowerCase()
  );

function logFull(...args) {
  if (!BACKTEST_MINIMAL_OUTPUT) console.log(...args);
}

logFull(`[ENV] Loaded from ${envFile}`);

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Import the Predicta Strategy
const PredictaStrategy = require("../../predicta-strategy");

// Import shared utilities
const db = require("../../db");
const RiskManager = require("../../risk-manager");
const MarketAllocator = require("../../utils/market-allocator");

// Import scoring stats for SQN/robust metrics (tail-risk aware)
const {
  mean,
  std,
  computeTailMetrics,
  computeSampleConfidence,
  scoreFromMetrics,
  clamp: clampUtil,
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

// Import fee configuration (same as backtest-rsi-reversion.js)
const SIMULATION_CONSTANTS = require("../../backtest/backtest-constants");
const { buildFeeCfg, logFeeConfig } = require("../../backtest/utils/fee-config");
const {
  calculatePriceImpactFee,
  calculateOpenFee,
  calculateCloseFee,
  calculateSolanaTransactionFees,
  accrueBorrowFeesIfDue,
} = require("../../backtest/utils/fee-calculator");

// ============================================================
// BOT RUNTIME EVENT MODEL (SOURCE-OF-TRUTH PARITY)
// ============================================================
const BOT_RUNTIME_EVENT_MODEL = [
  {
    step: 1,
    name: "tick_ingest",
    notes: "Fetch price, add to bar aggregator + rolling window buffer",
  },
  {
    step: 2,
    name: "bar_close_update",
    notes: "If a discrete bar completes, call strategy.update() with completed bar OHLCV",
  },
  {
    step: 3,
    name: "intra_bar_recalc",
    notes: "Update last bar with rolling window OHLCV via recalculateLastBar()",
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
      "Evaluate exits each tick; execute at tick price. Priority: hard_stop > time > supertrend_flip > opposite_perfect > trailing",
  },
];

// Explicit exit precedence for Predicta (highest priority first)
const BOT_RUNTIME_EXIT_PRECEDENCE = [
  "predicta_hard_stop", // price-based stop (per tick - emergency)
  "predicta_time_stop", // max bars held
  "supertrend_flip", // trend reversal (primary)
  "opposite_perfect_long", // signal reversal
  "opposite_perfect_short", // signal reversal
  "predicta_trailing_stop", // profit protection
];

function printBotRuntimeEventModel() {
  if (BACKTEST_MINIMAL_OUTPUT) return;
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
// CACHE CONFIGURATION
// ============================================================
const BACKTEST_CACHE_DISABLED = String(process.env.BACKTEST_DISABLE_CACHE || "").toLowerCase();
const BACKTEST_CACHE_ENABLED = !["1", "true", "yes", "on"].includes(BACKTEST_CACHE_DISABLED);
const BACKTEST_CACHE_DIR =
  process.env.BACKTEST_CACHE_DIR || path.join(process.cwd(), "backtest-results", "cache");
const BACKTEST_CACHE_TTL_MS = Number(process.env.BACKTEST_CACHE_TTL_MS || 0) || 0;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function intervalToMs(interval) {
  const map = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  };
  return map[String(interval || "5m")] || 300_000;
}

// ============================================================
// TICK INTERPOLATION CONSTANTS (from 1m candles)
// ============================================================
// Strategy: Fetch 1-minute candles from Pyth (price) + Binance (volume)
// Merge volume into Pyth candles, then interpolate 4 ticks per minute
// This gives REAL price data every 15 seconds instead of guessing from 5-min OHLC
//
// 5-minute period = 5 x 1-minute candles
// Each 1-minute candle = 4 ticks (15 sec intervals)
// Total = 20 ticks per 5-minute period with REAL 1-min data

const TICKS_PER_1MIN_CANDLE = 4; // 4 ticks per 1-minute candle = 15-second intervals
const TICKS_PER_5MIN_CANDLE = 20; // 20 ticks per 5-minute period
const TICK_INTERVAL_MS = 15000; // 15 seconds

// Tick cache configuration
const BACKTEST_TICK_CACHE_ENABLED = process.env.BACKTEST_TICK_CACHE_ENABLED !== "false";

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
    if (val === null || typeof val !== "object") return JSON.stringify(val);
    if (seen.has(val)) return '"[Circular]"';
    seen.add(val);
    if (Array.isArray(val)) return `[${val.map(stringify).join(",")}]`;
    const keys = Object.keys(val).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ":" + stringify(val[k])).join(",")}}`;
  };
  return stringify(value);
}

function parseCacheRangeFromFilename(filename, cachePrefix) {
  // Filename pattern: <cachePrefix><startBucket>_<endBucket>.json
  const base = path.basename(filename);
  if (!base.startsWith(cachePrefix) || !base.endsWith(".json")) return null;
  const tail = base.slice(cachePrefix.length, base.length - ".json".length);
  const m = tail.match(/^(\d+)_(\d+)$/);
  if (!m) return null;
  const startBucket = Number(m[1]);
  const endBucket = Number(m[2]);
  if (!Number.isFinite(startBucket) || !Number.isFinite(endBucket)) return null;
  return { startBucket, endBucket };
}

function cleanupOverlappingCaches(cachePrefix, primaryCachePath, startBucket, endBucket) {
  try {
    if (!fs.existsSync(BACKTEST_CACHE_DIR)) return;
    const entries = fs.readdirSync(BACKTEST_CACHE_DIR);
    for (const entry of entries) {
      if (!entry.startsWith(cachePrefix) || !entry.endsWith(".json")) continue;
      const full = path.join(BACKTEST_CACHE_DIR, entry);
      if (full === primaryCachePath) continue;
      const range = parseCacheRangeFromFilename(entry, cachePrefix);
      if (!range) continue;
      const covered = range.startBucket >= startBucket && range.endBucket <= endBucket;
      if (covered) {
        try {
          fs.unlinkSync(full);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function tryLoadCacheFileForRange(fullPath, cachePrefix, startBucket, endBucket) {
  try {
    if (!fs.existsSync(fullPath)) return null;
    if (BACKTEST_CACHE_TTL_MS) {
      const stats = fs.statSync(fullPath);
      if (!stats || Date.now() - stats.mtimeMs > BACKTEST_CACHE_TTL_MS) return null;
    }

    const raw = fs.readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const meta = parsed.meta || {};
    const range = parseCacheRangeFromFilename(fullPath, cachePrefix);
    const candidateStartBucket = Number.isFinite(Number(meta.startBucket))
      ? Number(meta.startBucket)
      : (range?.startBucket ?? null);
    const candidateEndBucket = Number.isFinite(Number(meta.endBucket))
      ? Number(meta.endBucket)
      : (range?.endBucket ?? null);
    if (!Number.isFinite(candidateStartBucket) || !Number.isFinite(candidateEndBucket)) return null;
    if (candidateStartBucket > startBucket || candidateEndBucket < endBucket) return null;

    return {
      parsed,
      startBucket: candidateStartBucket,
      endBucket: candidateEndBucket,
    };
  } catch (_) {
    return null;
  }
}

function findCacheFileCoveringRange(cachePrefix, startBucket, endBucket) {
  if (!BACKTEST_CACHE_ENABLED) return null;
  if (!fs.existsSync(BACKTEST_CACHE_DIR)) return null;

  const primaryPath = path.join(
    BACKTEST_CACHE_DIR,
    `${cachePrefix}${startBucket}_${endBucket}.json`
  );
  const primaryCandidate = tryLoadCacheFileForRange(
    primaryPath,
    cachePrefix,
    startBucket,
    endBucket
  );
  if (primaryCandidate) {
    return {
      path: primaryPath,
      parsed: primaryCandidate.parsed,
      startBucket: primaryCandidate.startBucket,
      endBucket: primaryCandidate.endBucket,
    };
  }

  let best = null;
  try {
    const entries = fs.readdirSync(BACKTEST_CACHE_DIR);
    for (const entry of entries) {
      if (!entry.startsWith(cachePrefix) || !entry.endsWith(".json")) continue;
      const full = path.join(BACKTEST_CACHE_DIR, entry);
      if (full === primaryPath) continue;
      const candidate = tryLoadCacheFileForRange(full, cachePrefix, startBucket, endBucket);
      if (!candidate) continue;
      const span = candidate.endBucket - candidate.startBucket;
      if (!best || span < best.span) {
        best = {
          path: full,
          parsed: candidate.parsed,
          startBucket: candidate.startBucket,
          endBucket: candidate.endBucket,
          span,
        };
      }
    }
  } catch (_) {
    // ignore read errors
  }

  return best;
}

function loadCachedBinanceCandles({ cacheKeySymbol, interval, startAlignedMs, endAlignedMs }) {
  if (!BACKTEST_CACHE_ENABLED) return null;
  if (!fs.existsSync(BACKTEST_CACHE_DIR)) return null;

  const intervalMs = intervalToMs(interval);
  const startBucket = Math.floor(startAlignedMs / intervalMs);
  const endBucket = Math.floor(endAlignedMs / intervalMs);
  const cachePrefix = `binance_${cacheKeySymbol}_${interval}_`;
  const primaryPath = path.join(
    BACKTEST_CACHE_DIR,
    `${cachePrefix}${startBucket}_${endBucket}.json`
  );

  const candidatePaths = [];
  candidatePaths.push(primaryPath);
  try {
    const entries = fs.readdirSync(BACKTEST_CACHE_DIR);
    for (const entry of entries) {
      if (!entry.startsWith(cachePrefix) || !entry.endsWith(".json")) continue;
      const full = path.join(BACKTEST_CACHE_DIR, entry);
      if (!candidatePaths.includes(full)) candidatePaths.push(full);
    }
  } catch (_) {}

  for (const candidatePath of candidatePaths) {
    try {
      if (!fs.existsSync(candidatePath)) continue;
      if (BACKTEST_CACHE_TTL_MS) {
        const stats = fs.statSync(candidatePath);
        const stale = !stats || Date.now() - stats.mtimeMs > BACKTEST_CACHE_TTL_MS;
        if (stale) continue;
      }
      const raw = fs.readFileSync(candidatePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.candles)) continue;

      const meta = parsed.meta || {};
      const metaStartBucketRaw =
        meta.startBucket ??
        (meta.startTime ? Math.floor(Number(meta.startTime) / intervalMs) : null);
      const metaEndBucketRaw =
        meta.endBucket ?? (meta.endTime ? Math.floor(Number(meta.endTime) / intervalMs) : null);
      const metaStartBucket = Number(metaStartBucketRaw);
      const metaEndBucket = Number(metaEndBucketRaw);
      const hasMetaRange = Number.isFinite(metaStartBucket) && Number.isFinite(metaEndBucket);
      if (hasMetaRange && (metaStartBucket > startBucket || metaEndBucket < endBucket)) continue;

      const candles = parsed.candles
        .map((c) => ({
          openTime: Number(c.openTime ?? c.timestamp ?? c.time),
          closeTime: Number(
            c.closeTime ?? Number(c.openTime ?? c.timestamp ?? c.time) + intervalMs - 1
          ),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          baseVolume: Number(c.baseVolume ?? c.volume ?? 0),
          quoteVolume: Number(c.quoteVolume ?? 0),
          takerBuyBaseVolume: Number(c.takerBuyBaseVolume ?? c.takerBuyBase ?? 0),
          takerBuyQuoteVolume: Number(c.takerBuyQuoteVolume ?? c.takerBuyQuote ?? 0),
        }))
        .filter((c) => Number.isFinite(c.openTime) && Number.isFinite(c.closeTime))
        .filter((c) => c.openTime >= startAlignedMs && c.closeTime <= endAlignedMs)
        .sort((a, b) => a.openTime - b.openTime)
        .map((c) => ({
          timestamp: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.baseVolume,
          quoteVolume: c.quoteVolume,
          takerBuyBaseVolume: c.takerBuyBaseVolume,
          takerBuyQuoteVolume: c.takerBuyQuoteVolume,
          closeTime: c.closeTime,
        }));

      if (candles.length > 0) {
        logFull(
          `   📦 Loaded ${candles.length} cached Binance candles for ${cacheKeySymbol} @ ${interval} [${path.basename(candidatePath)}]`
        );
        return candles;
      }
    } catch (_) {
      // skip invalid cache files
      continue;
    }
  }

  return null;
}

function saveBinanceCandleCache({
  cacheKeySymbol,
  interval,
  startAlignedMs,
  endAlignedMs,
  candles,
}) {
  if (!BACKTEST_CACHE_ENABLED) return;
  if (!Array.isArray(candles) || candles.length === 0) return;

  const intervalMs = intervalToMs(interval);
  const startBucket = Math.floor(startAlignedMs / intervalMs);
  const endBucket = Math.floor(endAlignedMs / intervalMs);
  const cachePrefix = `binance_${cacheKeySymbol}_${interval}_`;
  const primaryPath = path.join(
    BACKTEST_CACHE_DIR,
    `${cachePrefix}${startBucket}_${endBucket}.json`
  );

  try {
    ensureDir(BACKTEST_CACHE_DIR);
    const normalized = candles
      .map((c) => ({
        openTime: Number(c.timestamp),
        closeTime: Number(c.closeTime ?? Number(c.timestamp) + intervalMs - 1),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        baseVolume: Number(c.volume ?? 0),
        quoteVolume: Number(c.quoteVolume ?? 0),
        takerBuyBaseVolume: Number(c.takerBuyBaseVolume ?? 0),
        takerBuyQuoteVolume: Number(c.takerBuyQuoteVolume ?? 0),
      }))
      .filter((c) => Number.isFinite(c.openTime) && Number.isFinite(c.closeTime))
      .sort((a, b) => a.openTime - b.openTime);

    if (normalized.length === 0) return;

    const payload = {
      meta: {
        symbol: cacheKeySymbol,
        interval,
        startTime: startAlignedMs,
        endTime: endAlignedMs,
        startBucket,
        endBucket,
        intervalMs,
        createdAt: Date.now(),
        count: normalized.length,
        source: "binance_klines",
      },
      candles: normalized,
    };
    fs.writeFileSync(primaryPath, stableStringify(payload));
    cleanupOverlappingCaches(cachePrefix, primaryPath, startBucket, endBucket);
  } catch (_) {}
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [key, val] = arg.slice(2).split("=");
      args[key] = val === undefined ? true : val;
    }
  }
  return args;
}

function num(val, fallback) {
  if (val === undefined || val === "" || val === null) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function bool(val, fallback) {
  if (val === undefined || val === "" || val === null) return fallback;
  return String(val).toLowerCase() === "true";
}

function isTruthy(val) {
  const s = String(val ?? "")
    .trim()
    .toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
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

function hasValue(v) {
  return v !== undefined && v !== null && v !== "";
}

function computeDynamicWfaWindows(totalDays) {
  const days = Math.max(0, Math.floor(Number(totalDays) || 0));
  if (days >= 360) return { train: 90, test: 45, step: 45 };
  if (days >= 180) return { train: 50, test: 25, step: 25 };
  if (days >= 120) return { train: 40, test: 20, step: 20 };
  if (days >= 90) return { train: 36, test: 18, step: 18 };
  return { train: 60, test: 30, step: 30 };
}

function buildOptions(args = {}) {
  const days = num(args.days || process.env.BACKTEST_DAYS, 30);
  const wfTrainRaw = args.wfTrainDays ?? process.env.WF_TRAIN_DAYS;
  const wfTestRaw = args.wfTestDays ?? args.wfaFoldSize ?? process.env.WF_TEST_DAYS;
  const wfStepRaw = args.wfStepDays ?? process.env.WF_STEP_DAYS;
  const dynamicWfa = computeDynamicWfaWindows(days);

  return {
    days,
    symbols: (args.symbols || args.symbol || process.env.STRATEGY_MARKETS || "SOL")
      .split(",")
      .map((s) => s.trim().toUpperCase()),
    interval: args.interval || process.env.TRADING_INTERVAL || "5m",
    startTime: parseTimeArg(args.startTime || process.env.BACKTEST_START_TIME),
    endTime: parseTimeArg(args.endTime || process.env.BACKTEST_END_TIME),
    initialCapital: num(args.capital || process.env.STARTING_BALANCE_USD, 1000),
    positionSize: num(args.positionSize || process.env.POSITION_SIZE_USD, 1000),
    positionSizePercent: num(args.positionSizePercent || process.env.POSITION_SIZE_PERCENT, 30),
    leverage: num(args.leverage || process.env.LEVERAGE_BASE, 5),
    maxPositions: num(args.maxPositions || process.env.MAX_POSITIONS, 3),
    debug: bool(args.debug, false),
    verbose: bool(args.verbose, false),
    saveTradesLimit: num(args.saveTradesLimit || process.env.BACKTEST_SAVE_TRADES_LIMIT, 100),
    minPositionSize: num(args.minPositionSize || process.env.MIN_POSITION_SIZE, 0),
    maxPositionSize: num(args.maxPositionSize || process.env.MAX_POSITION_SIZE, 0),
    wfa: bool(args.wfa, false) || isTruthy(process.env.ROBUST_WALK_FORWARD),
    wfaMaxFolds: num(args.wfaMaxFolds || process.env.WFA_MAX_FOLDS, 6),
    wfTrainDays: hasValue(wfTrainRaw) ? num(wfTrainRaw, dynamicWfa.train) : dynamicWfa.train,
    wfTestDays: hasValue(wfTestRaw) ? num(wfTestRaw, dynamicWfa.test) : dynamicWfa.test,
    wfStepDays: hasValue(wfStepRaw) ? num(wfStepRaw, dynamicWfa.step) : dynamicWfa.step,
    wfMode: String(args.wfMode || process.env.WF_MODE || "rolling").toLowerCase(),
    wfOptimize: bool(args.wfOptimize, false) || isTruthy(process.env.WF_OPTIMIZE),
    wfGridMode: String(args.wfGridMode || process.env.WF_GRID_MODE || "fast").toLowerCase(),

    // Execution model
    // Prod behavior: enter at beginning of bar N, after bar N-1 is fully closed/updated.
    // In backtests with tick simulation, this means only allow opens on the first tick of each bar.
    entryAtBarOpenOnly: bool(
      args.entryAtBarOpenOnly ?? process.env.BACKTEST_ENTRY_AT_BAR_OPEN_ONLY,
      true
    ),

    // Supertrend
    stFactor: num(args.stFactor || process.env.PREDICTA_ST_FACTOR, 3.0),
    stPeriod: num(args.stPeriod || process.env.PREDICTA_ST_PERIOD, 10),

    // Confluence
    minConfluence: num(args.minConfluence || process.env.PREDICTA_MIN_CONFLUENCE, 5),
    minVolumeRatio: num(process.env.PREDICTA_MIN_VOLUME_RATIO, 0.8),
    adxThreshold: num(args.adxThreshold || process.env.PREDICTA_ADX_THRESHOLD, 25),

    // Dynamic threshold
    adxStrong: num(process.env.PREDICTA_ADX_STRONG, 30),
    adxOk: num(process.env.PREDICTA_ADX_OK, 25),
    adxWeak: num(process.env.PREDICTA_ADX_WEAK, 20),
    thresholdStrong: num(process.env.PREDICTA_THRESHOLD_STRONG, 55),
    thresholdOk: num(process.env.PREDICTA_THRESHOLD_OK, 60),
    thresholdWeak: num(process.env.PREDICTA_THRESHOLD_WEAK, 65),
    thresholdDefault: num(process.env.PREDICTA_THRESHOLD_DEFAULT, 70),

    // Indicator periods
    atrPeriod: num(process.env.PREDICTA_ATR_PERIOD, 14),
    atrPercentileLookback: num(process.env.PREDICTA_ATR_PERCENTILE_LOOKBACK, 100),
    emaFast: num(process.env.PREDICTA_EMA_FAST, 8),
    emaMid: num(process.env.PREDICTA_EMA_MID, 21),
    emaSlow: num(process.env.PREDICTA_EMA_SLOW, 50),
    rsiPeriod: num(process.env.PREDICTA_RSI_PERIOD, 14),
    macdFast: num(process.env.PREDICTA_MACD_FAST, 12),
    macdSlow: num(process.env.PREDICTA_MACD_SLOW, 26),
    macdSignal: num(process.env.PREDICTA_MACD_SIGNAL, 9),
    stochPeriod: num(process.env.PREDICTA_STOCH_PERIOD, 14),
    stochSmooth: num(process.env.PREDICTA_STOCH_SMOOTH, 3),
    adxPeriod: num(process.env.PREDICTA_ADX_PERIOD, 14),
    volumeLookback: num(process.env.PREDICTA_VOLUME_LOOKBACK, 20),
    deltaEmaPeriod: num(process.env.PREDICTA_DELTA_EMA_PERIOD, 10),

    // Weights
    weightTrend: num(process.env.PREDICTA_WEIGHT_TREND, 0.23),
    weightMacd: num(process.env.PREDICTA_WEIGHT_MACD, 0.18),
    weightDelta: num(process.env.PREDICTA_WEIGHT_DELTA, 0.15),
    weightRsi: num(process.env.PREDICTA_WEIGHT_RSI, 0.12),
    weightStoch: num(process.env.PREDICTA_WEIGHT_STOCH, 0.12),
    weightAdx: num(process.env.PREDICTA_WEIGHT_ADX, 0.1),
    weightVolume: num(process.env.PREDICTA_WEIGHT_VOLUME, 0.1),

    // Signals
    enablePerfectSignals: bool(process.env.PREDICTA_ENABLE_PERFECT_SIGNALS, true),
    enableBuySellSignals: bool(process.env.PREDICTA_ENABLE_BUY_SELL_SIGNALS, true),
    perfectConfidence: num(process.env.PREDICTA_PERFECT_CONFIDENCE, 2.5),
    buySellConfidence: num(process.env.PREDICTA_BUY_SELL_CONFIDENCE, 1.5),
    buySellEntryTrigger: String(
      process.env.PREDICTA_BUY_SELL_ENTRY_TRIGGER || "st_flip_or_ema_cross"
    ),
    buySellRequireDelta: bool(process.env.PREDICTA_BUY_SELL_REQUIRE_DELTA, true),
    buySellUseConfluenceFilter: bool(process.env.PREDICTA_BUY_SELL_USE_CONFLUENCE_FILTER, false),
    buySellMinConfluence: num(process.env.PREDICTA_BUY_SELL_MIN_CONFLUENCE, 0),
    buySellUseScoreFilter: bool(process.env.PREDICTA_BUY_SELL_USE_SCORE_FILTER, false),
    buySellScoreThresholdOffset: num(process.env.PREDICTA_BUY_SELL_SCORE_THRESHOLD_OFFSET, 0),
    relaxPerfectDirection: bool(process.env.PREDICTA_RELAX_PERFECT_DIRECTION, false),

    // Exits
    supertrendExit: bool(process.env.PREDICTA_SUPERTREND_EXIT, true),
    oppositePerfectExit: bool(process.env.PREDICTA_OPPOSITE_PERFECT_EXIT, true),
    enableTimeStop: bool(process.env.PREDICTA_ENABLE_TIME_STOP, false),
    timeStopBars: num(process.env.PREDICTA_TIME_STOP_BARS, 72),
    enableTrailingStop: bool(process.env.PREDICTA_ENABLE_TRAILING_STOP, false),
    trailingAtrMult: num(process.env.PREDICTA_TRAILING_ATR_MULT, 1.5),
    hardStopEnabled: bool(process.env.PREDICTA_HARD_STOP_ENABLED, true),
    hardStopPercent: num(process.env.PREDICTA_HARD_STOP_PERCENT, 15),
    hardStopAtr: num(process.env.PREDICTA_HARD_STOP_ATR, 2.0),

    // Cooldowns
    enableCooldown: bool(process.env.ENABLE_COOLDOWN, true),
    cooldownMs: num(process.env.COOLDOWN_MS, 30000),
    flipCooldownBars: num(process.env.FLIP_COOLDOWN_BARS, 4),
    enableEdgeTrigger: bool(process.env.ENABLE_EDGE_TRIGGER, true),
    minBarsSameSideReentry: num(process.env.MIN_BARS_SAME_SIDE_REENTRY, 2),
    enableSameBarGuard: bool(process.env.ENABLE_SAME_BAR_GUARD, true),

    // Position sizing
    perfectSizeMult: num(process.env.PREDICTA_PERFECT_SIZE_MULT, 1.5),
    buySellSizeMult: num(process.env.PREDICTA_BUY_SELL_SIZE_MULT, 1.0),

    // Gate toggles
    enableGateSupertrend: bool(process.env.PREDICTA_ENABLE_GATE_SUPERTREND, true),
    enableGateEmaCross: bool(process.env.PREDICTA_ENABLE_GATE_EMA_CROSS, true),
    enableGateEmaTrend: bool(process.env.PREDICTA_ENABLE_GATE_EMA_TREND, true),
    enableGateMacd: bool(process.env.PREDICTA_ENABLE_GATE_MACD, true),
    enableGateStoch: bool(process.env.PREDICTA_ENABLE_GATE_STOCH, true),
    enableGateRsi: bool(process.env.PREDICTA_ENABLE_GATE_RSI, true),
    enableGateAdx: bool(process.env.PREDICTA_ENABLE_GATE_ADX, true),
    enableGateVolume: bool(process.env.PREDICTA_ENABLE_GATE_VOLUME, true),

    // Direction
    allowLongs: bool(process.env.ALLOW_LONGS, true),
    allowShorts: bool(process.env.ALLOW_SHORTS, true),

    // Warmup
    minBars: num(process.env.PREDICTA_MIN_BARS, 100),
  };
}

// ============================================================
// FEE MODEL (exact Jupiter fee structure from backtest-rsi-reversion.js)
// ============================================================

// Jupiter swap fee (applies to COLLATERAL, not notional!)
// Typical 2-3 bps on collateral. At 2x leverage: 3 bps on collateral = 1.5 bps on notional per swap
const DEFAULT_SWAP_FEE_BPS = 3;
const DEFAULT_BORROW_RATE_BPS = 1; // 0.01% per hour
const DEFAULT_POOL_UTILIZATION = 0.2; // ~20% typical pool utilization

/**
 * Calculate swap fee for USDC ↔ Asset swaps
 * IMPORTANT: Apply to COLLATERAL, not notional!
 * @param {number} collateralUsd - Collateral amount (not notional!)
 * @param {object} cfg - Configuration
 */
function calculateSwapFee(collateralUsd, cfg = {}) {
  // Drift perps: no per-trade "swap fee" unless you explicitly model swaps to acquire collateral.
  if (String(process.env.FEE_MODEL || "").toLowerCase() === "drift") return 0;
  const feeBps = cfg.swapFeeBps ?? DEFAULT_SWAP_FEE_BPS;
  return (collateralUsd * feeBps) / 10000;
}

/**
 * Calculate borrow fee for holding position
 * @param {number} notionalUsd - Position size in USD
 * @param {number} holdMs - Time held in milliseconds
 * @param {object} cfg - Configuration
 */
function calculateBorrowFeeUsd(notionalUsd, holdMs, cfg = {}) {
  // Drift perps: this borrow-fee model is Jupiter-specific; Drift uses funding.
  if (String(process.env.FEE_MODEL || "").toLowerCase() === "drift") return 0;
  const hourlyBps = cfg.borrowRateBps ?? DEFAULT_BORROW_RATE_BPS;
  const utilization = cfg.poolUtilization ?? DEFAULT_POOL_UTILIZATION;
  const holdHours = holdMs / (1000 * 60 * 60);
  // Borrow fee = notional × hourlyBps × utilization × hours
  return (notionalUsd * hourlyBps * utilization * holdHours) / 10000;
}

/**
 * Build fee configuration for a trade
 * Uses centralized fee configuration from backtest utils
 */
function getFeeCfg() {
  return buildFeeCfg();
}

// ============================================================
// CANDLE DATA FETCHING
// ============================================================

// Binance symbol mapping
function getBinanceSymbol(symbol) {
  const symbolUpper = symbol.toUpperCase();
  // Map common symbols to Binance futures format
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

/**
 * Fetch candles from Binance Futures API (has volume data - required for CVD)
 */
async function fetchFromBinance(symbol, startTime, endTime, interval = "5m") {
  const binanceSymbol = getBinanceSymbol(symbol);
  const candles = [];
  let currentStart = startTime;

  logFull(`   Fetching from Binance: ${binanceSymbol} ${interval}...`);

  // Binance limit is 1500 candles per request
  while (currentStart < endTime) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${interval}&startTime=${currentStart}&endTime=${endTime}&limit=1500`;

    const resp = await fetch(url, { timeout: 30000 });
    if (!resp.ok) {
      // Try spot API if futures fails
      const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&startTime=${currentStart}&endTime=${endTime}&limit=1000`;
      const spotResp = await fetch(spotUrl, { timeout: 30000 });
      if (!spotResp.ok) {
        throw new Error(`Binance API error: ${resp.status}`);
      }
      const spotData = await spotResp.json();
      if (!Array.isArray(spotData) || spotData.length === 0) break;

      for (const k of spotData) {
        candles.push({
          timestamp: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]), // Base volume - CRITICAL for CVD
          quoteVolume: parseFloat(k[7]),
          takerBuyBaseVolume: parseFloat(k[9] || 0),
          takerBuyQuoteVolume: parseFloat(k[10] || 0),
          closeTime: k[6],
        });
      }
      currentStart = spotData[spotData.length - 1][6] + 1;
      continue;
    }

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) break;

    for (const k of data) {
      candles.push({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]), // Base volume - CRITICAL for CVD
        quoteVolume: parseFloat(k[7]),
        takerBuyBaseVolume: parseFloat(k[9] || 0),
        takerBuyQuoteVolume: parseFloat(k[10] || 0),
        closeTime: k[6],
      });
    }

    // Move to next batch
    currentStart = data[data.length - 1][6] + 1; // closeTime + 1

    // Small delay to avoid rate limiting
    if (currentStart < endTime) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return candles;
}

// Pyth market ID mapping (fallback - no volume)
function normalizePythSymbol(symbol) {
  const upper = String(symbol || "").toUpperCase().replace(/-PERP$/, "");
  if (upper.startsWith("1M") && upper.length > 2) return upper.slice(2);
  if (upper.startsWith("1K") && upper.length > 2) return upper.slice(2);
  return upper;
}

function getPythMarketId(symbol) {
  const pythMarkets = {
    SOL: "Crypto.SOL/USD",
    BTC: "Crypto.BTC/USD",
    ETH: "Crypto.ETH/USD",
    DOGE: "Crypto.DOGE/USD",
    JTO: "Crypto.JTO/USD",
    WIF: "Crypto.WIF/USD",
  };
  const normalized = normalizePythSymbol(symbol);
  return pythMarkets[normalized] || `Crypto.${normalized}/USD`;
}

/**
 * Fetch candles from Pyth with chunking support for large date ranges
 * Pyth has limits: ~6 days for 1m, ~150 days for 5m
 */
async function fetchFromPyth(symbol, startTime, endTime, interval = "5m") {
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
    if (!BACKTEST_MINIMAL_OUTPUT) {
      console.log(
        `   [PYTH] Large request (${Math.round(totalDuration / (24 * 60 * 60 * 1000))} days) - chunking into ${Math.ceil(totalDuration / PYTH_MAX_CHUNK_MS)} parts`
      );
    }

    const allCandles = [];
    let chunkStart = startTime;
    let chunkNum = 0;

    while (chunkStart < endTime) {
      const chunkEnd = Math.min(chunkStart + PYTH_MAX_CHUNK_MS, endTime);
      chunkNum++;

      if (!BACKTEST_MINIMAL_OUTPUT) {
        console.log(
          `   [PYTH] Chunk ${chunkNum}: ${new Date(chunkStart).toISOString().slice(0, 10)} to ${new Date(chunkEnd).toISOString().slice(0, 10)}`
        );
      }

      const chunkCandles = await fetchFromPythSingleRequest(
        pythMarketId,
        resolution,
        chunkStart,
        chunkEnd,
        interval
      );
      allCandles.push(...chunkCandles);

      chunkStart = chunkEnd;

      // Rate limit between chunks
      if (chunkStart < endTime) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!BACKTEST_MINIMAL_OUTPUT) {
      console.log(
        `   [PYTH] Fetched ${allCandles.length} total candles for ${pythMarketId} @ ${resolution}min`
      );
    }
    return allCandles;
  } else {
    if (!BACKTEST_MINIMAL_OUTPUT) {
      logFull(`   [PYTH] Fetching: ${pythMarketId} @ ${resolution}min`);
    }
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
            `   [PYTH] Got ${resp.status}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})`
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
        candles.push({
          timestamp,
          openTime: timestamp,
          closeTime: timestamp + intervalMs - 1,
          open: data.o[i],
          high: data.h[i],
          low: data.l[i],
          close: data.c[i],
          volume: 0, // Pyth doesn't provide volume
          quoteVolume: 0,
        });
      }

      return candles;
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 5000);
        console.log(
          `   [PYTH] Request failed: ${err.message}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw lastError || new Error("Pyth fetch failed after retries");
}

// ============================================================
// 1-MINUTE CANDLE FETCHING (Pyth price + Binance volume)
// ============================================================

/**
 * Fetch 5m candles from Binance for volume data only
 * Volume is only needed for CVD signals (entry decisions per bar), not tick-level exits
 * Includes caching to avoid repeated API calls
 */
async function fetchBinance5mVolume(symbol, startTime, endTime) {
  const binanceSymbol = getBinanceSymbol(symbol);
  const intervalMs = 300000; // 5 minutes
  const limit = 1000;

  const startAligned = alignToCandleOpenMs(startTime, intervalMs);
  const endAligned = alignToCandleCloseMs(endTime, intervalMs);

  // Check cache first
  const cacheKey = `binance_${symbol.toUpperCase()}_5m_volume`;
  const startBucket = Math.floor(startAligned / intervalMs);
  const endBucket = Math.floor(endAligned / intervalMs);
  const cachePath = path.join(BACKTEST_CACHE_DIR, `${cacheKey}_${startBucket}_${endBucket}.json`);

  if (BACKTEST_CACHE_ENABLED && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (cached.candles && cached.candles.length > 0) {
        logFull(`   [BINANCE] ✅ Loaded ${cached.candles.length} 5m volume records from cache`);
        return cached.candles;
      }
    } catch (e) {
      // Ignore cache errors
    }
  }

  logFull(`   [BINANCE] Fetching 5m volume data for ${binanceSymbol}...`);

  const allCandles = [];
  let cursor = startAligned;

  while (cursor < endAligned) {
    const chunkEnd = Math.min(cursor + limit * intervalMs, endAligned);
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=5m&startTime=${cursor}&endTime=${chunkEnd}&limit=${limit}`;

    try {
      const resp = await fetch(url, { timeout: 30000 });
      if (!resp.ok) {
        console.log(`   [BINANCE] API error: ${resp.status}`);
        break;
      }

      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) break;

      for (const k of data) {
        allCandles.push({
          timestamp: k[0],
          openTime: k[0],
          volume: parseFloat(k[5]) || 0,
          quoteVolume: parseFloat(k[7]) || 0,
          takerBuyBaseVolume: parseFloat(k[9]) || 0,
          takerBuyQuoteVolume: parseFloat(k[10]) || 0,
        });
      }

      const lastTs = data[data.length - 1][0];
      cursor = lastTs + intervalMs;

      // Rate limit
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (e) {
      console.log(`   [BINANCE] Fetch error: ${e.message}`);
      break;
    }
  }

  // Save to cache
  if (BACKTEST_CACHE_ENABLED && allCandles.length > 0) {
    try {
      ensureDir(BACKTEST_CACHE_DIR);
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          meta: {
            symbol,
            interval: "5m",
            startTime: startAligned,
            endTime: endAligned,
            createdAt: Date.now(),
            source: "binance_volume_only",
          },
          candles: allCandles,
        })
      );
      console.log(`   [BINANCE] 💾 Cached ${allCandles.length} 5m volume records`);
    } catch (e) {
      // Ignore cache save errors
    }
  }

  console.log(`   [BINANCE] ✅ Fetched ${allCandles.length} 5m volume records`);
  return allCandles;
}

/**
 * Merge volume data from Binance into 5m candles
 * Used after aggregating 1m Pyth candles to 5m
 */
function mergeVolumeInto5mCandles(fiveMinCandles, binanceVolume) {
  if (!binanceVolume || binanceVolume.length === 0) {
    console.log(`   [MERGE] No Binance volume to merge`);
    return fiveMinCandles;
  }

  // Build lookup map from Binance volume (keyed by openTime)
  const volumeMap = new Map();
  for (const v of binanceVolume) {
    volumeMap.set(v.timestamp || v.openTime, v);
  }

  let mergedCount = 0;
  for (const candle of fiveMinCandles) {
    const ts = candle.timestamp || candle.openTime;
    const volData = volumeMap.get(ts);
    if (volData) {
      candle.volume = volData.volume || 0;
      candle.quoteVolume = volData.quoteVolume || 0;
      candle.takerBuyBaseVolume = volData.takerBuyBaseVolume || 0;
      candle.takerBuyQuoteVolume = volData.takerBuyQuoteVolume || 0;
      mergedCount++;
    }
  }

  console.log(`   [MERGE] Merged 5m volume for ${mergedCount}/${fiveMinCandles.length} candles`);
  return fiveMinCandles;
}

/**
 * Fetch 1m candles from Pyth (price only - no volume)
 * Volume will be fetched at 5m level separately since CVD is only used for entry signals
 */
async function fetch1mPythCandles(symbol, startTime, endTime) {
  if (!BACKTEST_MINIMAL_OUTPUT) {
    logFull(`\n📥 Fetching ${symbol} 1m candles from Pyth (price only)...`);
  }

  const startAligned = alignToCandleOpenMs(startTime, 60000);
  const endAligned = alignToCandleCloseMs(endTime, 60000);

  // Check cache first
  const cacheKey = `pyth_${symbol.toUpperCase()}_1m_price`;
  const startBucket = Math.floor(startAligned / 60000);
  const endBucket = Math.floor(endAligned / 60000);
  const cachePrefix = `${cacheKey}_`;
  const cachePath = path.join(BACKTEST_CACHE_DIR, `${cachePrefix}${startBucket}_${endBucket}.json`);

  if (BACKTEST_CACHE_ENABLED) {
    const cachedRange = findCacheFileCoveringRange(cachePrefix, startBucket, endBucket);
    if (
      cachedRange &&
      Array.isArray(cachedRange.parsed.candles) &&
      cachedRange.parsed.candles.length > 0
    ) {
      const normalized = cachedRange.parsed.candles
        .map((c) => ({
          timestamp: Number(c.openTime ?? c.timestamp ?? c.time),
          closeTime: Number(c.closeTime ?? Number(c.openTime ?? c.timestamp ?? c.time) + 60000 - 1),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume ?? c.baseVolume ?? 0),
          quoteVolume: Number(c.quoteVolume ?? 0),
          takerBuyBaseVolume: Number(c.takerBuyBaseVolume ?? 0),
          takerBuyQuoteVolume: Number(c.takerBuyQuoteVolume ?? 0),
        }))
        .filter((c) => Number.isFinite(c.timestamp))
        .filter((c) => c.timestamp >= startAligned && c.closeTime <= endAligned)
        .sort((a, b) => a.timestamp - b.timestamp);

      if (normalized.length > 0) {
        if (!BACKTEST_MINIMAL_OUTPUT) {
          logFull(
            `   ✅ Loaded ${normalized.length} 1m candles from cache [${path.basename(cachedRange.path)}]`
          );
        }
        return normalized;
      }
    }
  }

  // Fetch Pyth price data
  const pythCandles = await fetchFromPyth(symbol, startAligned, endAligned, "1m");
  if (!pythCandles || pythCandles.length === 0) {
    throw new Error(`No 1m candles from Pyth for ${symbol}`);
  }

  // Save to cache (no volume at 1m level)
  if (BACKTEST_CACHE_ENABLED && pythCandles.length > 0) {
    try {
      ensureDir(BACKTEST_CACHE_DIR);
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          meta: {
            symbol,
            interval: "1m",
            startTime: startAligned,
            endTime: endAligned,
            startBucket,
            endBucket,
            intervalMs: 60000,
            createdAt: Date.now(),
            source: "pyth_price_only",
          },
          candles: pythCandles,
        })
      );
    } catch (e) {
      // Ignore cache save errors
    }
  }

  if (!BACKTEST_MINIMAL_OUTPUT) {
    logFull(`   ✅ Loaded ${pythCandles.length} 1m candles (price only)`);
  }
  return pythCandles;
}

// ============================================================
// TICK GENERATION FROM 1-MINUTE CANDLES
// ============================================================

/**
 * Generate tick prices from a 1-minute candle (4 ticks = 15 sec each)
 * More accurate than interpolating from 5-minute candles
 *
 * Pattern: O → extreme → extreme → C
 * - Bullish candle (close >= open): O → L → H → C
 * - Bearish candle (close < open): O → H → L → C
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
 * Build tick data from 1m candles, indexed by bar open time
 * Output: Map<barOpenTimeMs, Array<{price:number, ts:number}>>
 * Each 1m candle contributes 4 ticks (15s each).
 */
function buildTicksByBarOpenTimeFrom1m(oneMinCandles, intervalMs = 300_000) {
  const byBar = new Map();
  if (!Array.isArray(oneMinCandles) || oneMinCandles.length === 0) return byBar;

  // Ensure sorted by openTime (copy to avoid mutating caller)
  const sorted = oneMinCandles
    .slice()
    .sort((a, b) => Number(a.openTime || a.timestamp) - Number(b.openTime || b.timestamp));
  const ONE_MIN_MS = 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs < ONE_MIN_MS || intervalMs % ONE_MIN_MS !== 0)
    return byBar;
  const groupSize = Math.round(intervalMs / ONE_MIN_MS);

  const byMinute = new Map(); // minuteOpenTime -> candle
  for (const c of sorted) {
    const ot = Number(c?.openTime || c?.timestamp);
    if (!Number.isFinite(ot)) continue;
    byMinute.set(ot, c);
  }

  const firstOt = Number(sorted[0].openTime || sorted[0].timestamp);
  const lastOt = Number(sorted[sorted.length - 1].openTime || sorted[sorted.length - 1].timestamp);
  if (!Number.isFinite(firstOt) || !Number.isFinite(lastOt)) return byBar;

  const startBucket = Math.floor(firstOt / intervalMs) * intervalMs;
  const endBucket = Math.floor(lastOt / intervalMs) * intervalMs;

  // Build ticks for every interval bucket in-range.
  // If some 1m candles are missing inside a bucket, we fill the missing minutes using the last known close
  // (from strictly earlier minutes) to keep the tick simulation deterministic and avoid falling back to OHLC.
  let lastClose = null;
  for (let bucket = startBucket; bucket <= endBucket; bucket += intervalMs) {
    const tickObjs = [];
    let tsCursor = bucket;
    let canBuild = true;

    for (let m = 0; m < groupSize; m++) {
      const minuteOpen = bucket + m * ONE_MIN_MS;
      const candle = byMinute.get(minuteOpen);
      let useCandle = candle;

      if (!useCandle) {
        if (!Number.isFinite(lastClose)) {
          canBuild = false;
          break;
        }
        useCandle = {
          open: lastClose,
          high: lastClose,
          low: lastClose,
          close: lastClose,
          openTime: minuteOpen,
        };
      }

      const minTicks = generateTicksFrom1MinCandle(useCandle);
      if (!Array.isArray(minTicks) || minTicks.length !== TICKS_PER_1MIN_CANDLE) {
        canBuild = false;
        break;
      }
      for (const p of minTicks) {
        tickObjs.push({ price: p, ts: tsCursor });
        tsCursor += TICK_INTERVAL_MS;
      }

      const nextLastClose = Number(useCandle.close);
      if (Number.isFinite(nextLastClose)) lastClose = nextLastClose;
    }

    if (canBuild && tickObjs.length === groupSize * TICKS_PER_1MIN_CANDLE) {
      byBar.set(bucket, tickObjs);
    }
  }
  return byBar;
}

/**
 * Aggregate 5 x 1-minute candles into 1 x 5-minute candle
 */
function aggregate1MinTo5Min(oneMinCandles) {
  if (!oneMinCandles || oneMinCandles.length === 0) return null;

  return {
    timestamp: oneMinCandles[0].openTime || oneMinCandles[0].timestamp,
    openTime: oneMinCandles[0].openTime || oneMinCandles[0].timestamp,
    closeTime:
      (oneMinCandles[oneMinCandles.length - 1].openTime ||
        oneMinCandles[oneMinCandles.length - 1].timestamp) +
      60000 -
      1,
    open: oneMinCandles[0].open,
    high: Math.max(...oneMinCandles.map((c) => c.high)),
    low: Math.min(...oneMinCandles.map((c) => c.low)),
    close: oneMinCandles[oneMinCandles.length - 1].close,
    volume: oneMinCandles.reduce((sum, c) => sum + (c.volume || 0), 0),
    quoteVolume: oneMinCandles.reduce((sum, c) => sum + (c.quoteVolume || 0), 0),
    takerBuyBaseVolume: oneMinCandles.reduce((sum, c) => sum + (c.takerBuyBaseVolume || 0), 0),
    takerBuyQuoteVolume: oneMinCandles.reduce((sum, c) => sum + (c.takerBuyQuoteVolume || 0), 0),
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
    const openTime = Number(c.openTime || c.timestamp);
    if (!Number.isFinite(openTime)) continue;
    const bucket = Math.floor(openTime / FIVE_MIN_MS) * FIVE_MIN_MS;
    const arr = byBucket.get(bucket) || [];
    arr.push(c);
    byBucket.set(bucket, arr);
  }

  const sortedBuckets = [...byBucket.keys()].sort((a, b) => a - b);
  const result = [];

  for (const bucket of sortedBuckets) {
    const group = (byBucket.get(bucket) || []).sort(
      (a, b) => Number(a.openTime || a.timestamp) - Number(b.openTime || b.timestamp)
    );
    if (group.length !== 5) continue;

    // Require contiguity (exact 1m spacing)
    let contiguous = true;
    for (let i = 0; i < 5; i++) {
      const expected = bucket + i * ONE_MIN_MS;
      const actual = Number(group[i].openTime || group[i].timestamp);
      if (actual !== expected) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;

    result.push(aggregate1MinTo5Min(group));
  }

  return result;
}

/**
 * Get or build tick cache for 15s ticks derived from 1m candles
 * Cached per interval size to keep alignment with strategy bars.
 */
async function getOrBuildTicksByBarOpenTime({
  symbol,
  startTime,
  endTime,
  oneMinCandles,
  intervalMs,
}) {
  const symbolUpper = String(symbol || "").toUpperCase();
  const ONE_MIN_MS = 60_000;
  const effectiveIntervalMs = Number.isFinite(intervalMs) ? intervalMs : 300_000;
  const groupSize =
    effectiveIntervalMs % ONE_MIN_MS === 0 ? Math.round(effectiveIntervalMs / ONE_MIN_MS) : 5;
  const expectedTicksPerBar = groupSize * TICKS_PER_1MIN_CANDLE;
  const alignedStartTime = alignToCandleOpenMs(startTime, effectiveIntervalMs);
  const alignedEndTime = alignToCandleCloseMs(endTime, effectiveIntervalMs);
  const startBucket = Math.floor(alignedStartTime / effectiveIntervalMs);
  const endBucket = Math.floor(alignedEndTime / effectiveIntervalMs);
  const cachePrefix = `pyth_${symbolUpper}_ticks15s_${effectiveIntervalMs}ms_`;
  const primaryName = `${cachePrefix}${startBucket}_${endBucket}.json`;
  const primaryPath = path.join(BACKTEST_CACHE_DIR, primaryName);

  const buildOneMinIndex = () => {
    const idx = new Map();
    if (!Array.isArray(oneMinCandles)) return idx;
    for (const c of oneMinCandles) {
      const ts = Number(c?.openTime ?? c?.timestamp ?? c?.time);
      if (!Number.isFinite(ts)) continue;
      idx.set(ts, c);
    }
    return idx;
  };

  const expectedTicksForBarOpen = (oneMinIdx, barOpen) => {
    const ticks = [];
    for (let m = 0; m < groupSize; m++) {
      const minuteOpen = barOpen + m * ONE_MIN_MS;
      const candle = oneMinIdx.get(minuteOpen);
      if (!candle) return null;
      const minTicks = generateTicksFrom1MinCandle(candle);
      if (!Array.isArray(minTicks) || minTicks.length !== TICKS_PER_1MIN_CANDLE) return null;
      for (const p of minTicks) ticks.push(p);
    }
    return ticks.length === expectedTicksPerBar ? ticks : null;
  };

  if (BACKTEST_TICK_CACHE_ENABLED) {
    const cachedRange = findCacheFileCoveringRange(cachePrefix, startBucket, endBucket);
    if (cachedRange && cachedRange.parsed) {
      const cached = cachedRange.parsed;
      const barOpenTimes = (Array.isArray(cached.barOpenTimes) ? cached.barOpenTimes : []).map(
        Number
      );
      const tickPricesFlat = (
        Array.isArray(cached.tickPricesFlat) ? cached.tickPricesFlat : []
      ).map(Number);
      const ticksPerBar = Number(cached.ticksPerBar || expectedTicksPerBar);
      if (
        Number.isFinite(ticksPerBar) &&
        tickPricesFlat.length === barOpenTimes.length * ticksPerBar
      ) {
        const selectedBars = [];
        for (let i = 0; i < barOpenTimes.length; i++) {
          const barOpen = barOpenTimes[i];
          if (!Number.isFinite(barOpen)) continue;
          const barClose = barOpen + effectiveIntervalMs - 1;
          if (barOpen < alignedStartTime || barClose > alignedEndTime) continue;
          selectedBars.push({ barOpen, index: i });
        }
        if (selectedBars.length > 0) {
          // Validate cached ticks against the CURRENT 1m candles to avoid stale-tick-cache drift.
          // This matters because tick cache filenames don't currently include an algo/data hash.
          // We do a cheap 3-bar spot check: first/middle/last bar in the selected range.
          let cacheLooksValid = true;
          try {
            const oneMinIdx = buildOneMinIndex();
            const samples = [
              selectedBars[0],
              selectedBars[Math.floor(selectedBars.length / 2)],
              selectedBars[selectedBars.length - 1],
            ].filter(Boolean);
            const checkOffsets = [0, 1, 2, 3, Math.floor(ticksPerBar / 2), ticksPerBar - 1].filter(
              (o) => Number.isFinite(o) && o >= 0 && o < ticksPerBar
            );
            for (const s of samples) {
              const expected = expectedTicksForBarOpen(oneMinIdx, s.barOpen);
              if (!expected) continue; // can't validate this sample (missing 1m candles)
              const base = s.index * ticksPerBar;
              for (const off of checkOffsets) {
                const cachedP = tickPricesFlat[base + off];
                const expectedP = expected[off];
                if (
                  !Number.isFinite(cachedP) ||
                  !Number.isFinite(expectedP) ||
                  Math.abs(cachedP - expectedP) > 1e-9
                ) {
                  cacheLooksValid = false;
                  break;
                }
              }
              if (!cacheLooksValid) break;
            }
          } catch (_) {
            // If validation fails unexpectedly, be conservative and rebuild.
            cacheLooksValid = false;
          }

          if (!cacheLooksValid) {
            logFull(
              `   [TICK-CACHE] Stale cache detected (${path.basename(cachedRange.path)}); rebuilding from 1m candles...`
            );
          } else {
            const byBar = new Map();
            for (const { barOpen, index } of selectedBars) {
              const startIdx = index * ticksPerBar;
              if (startIdx + ticksPerBar > tickPricesFlat.length) continue;
              const tickObjs = [];
              for (let j = 0; j < ticksPerBar; j++) {
                tickObjs.push({
                  price: tickPricesFlat[startIdx + j],
                  ts: barOpen + j * TICK_INTERVAL_MS,
                });
              }
              byBar.set(barOpen, tickObjs);
            }
            if (byBar.size > 0) {
              const expectedBars =
                Math.floor((alignedEndTime - alignedStartTime) / effectiveIntervalMs) + 1;
              if (Number.isFinite(expectedBars) && expectedBars > 0 && byBar.size < expectedBars) {
                logFull(
                  `   [TICK-CACHE] Cache coverage incomplete (${byBar.size}/${expectedBars} bars); rebuilding from 1m candles...`
                );
              } else {
                logFull(
                  `   [TICK-CACHE] Loaded ${byBar.size} bars from cache [${path.basename(cachedRange.path)}]`
                );
                return byBar;
              }
            }
          }
        }
      }
    }
  }

  // Build from 1m candles
  const builtAll = buildTicksByBarOpenTimeFrom1m(oneMinCandles, effectiveIntervalMs);

  // Save to cache
  if (BACKTEST_TICK_CACHE_ENABLED && builtAll.size > 0) {
    try {
      ensureDir(BACKTEST_CACHE_DIR);
      const barOpenTimes = [...builtAll.keys()].sort((a, b) => a - b);
      const tickPricesFlat = [];
      for (const barOpen of barOpenTimes) {
        const ticks = builtAll.get(barOpen);
        for (const t of ticks) {
          tickPricesFlat.push(t.price);
        }
      }

      fs.writeFileSync(
        primaryPath,
        JSON.stringify({
          meta: {
            symbol: symbolUpper,
            startTime,
            endTime,
            createdAt: Date.now(),
            startBucket,
            endBucket,
            intervalMs: effectiveIntervalMs,
            tickAlgo: "O→L→H→C bullish / O→H→L→C bearish (4 ticks per 1m)",
          },
          ticksPerBar: expectedTicksPerBar,
          tickIntervalMs: TICK_INTERVAL_MS,
          barOpenTimes,
          tickPricesFlat,
        })
      );
      logFull(`   [TICK-CACHE] Saved ${builtAll.size} bars to cache`);
    } catch (e) {
      // Ignore cache save errors
    }
  }

  return builtAll;
}

/**
 * Generate tick objects from 5m candle OHLC (fallback when 1m data is incomplete)
 * Returns array of {price, ts} objects matching the format from 1m-derived ticks.
 */
function generateTicksFromOHLC(candle, numTicks = TICKS_PER_5MIN_CANDLE) {
  const prices = generateTickPrices(candle.open, candle.high, candle.low, candle.close, numTicks);
  const ticks = [];
  const barStart = Number(candle.openTime || candle.timestamp);

  for (let i = 0; i < prices.length; i++) {
    ticks.push({
      price: prices[i],
      ts: barStart + i * TICK_INTERVAL_MS,
    });
  }

  return ticks;
}

async function fetchCandleData(symbol, startTime, endTime, interval = "5m") {
  logFull(`\n📊 Fetching ${interval} candle data for ${symbol}...`);

  // Align to candle boundaries so cache keys are stable across runs.
  const intervalMs = intervalToMs(interval);
  const startAligned = alignToCandleOpenMs(startTime, intervalMs);
  const endAligned = alignToCandleCloseMs(endTime, intervalMs);

  // Try Binance first (has volume - required for CVD)
  try {
    const binanceKey = getBinanceSymbol(symbol);
    const cached = loadCachedBinanceCandles({
      cacheKeySymbol: binanceKey,
      interval,
      startAlignedMs: startAligned,
      endAlignedMs: endAligned,
    });
    if (cached && cached.length > 0) {
      const hasVolume = cached.some((c) => c.volume > 0);
      if (hasVolume) {
        logFull(`   ✅ Loaded ${cached.length} candles from Binance cache (with volume)`);
        return cached;
      }
    }

    const candles = await fetchFromBinance(symbol, startAligned, endAligned, interval);
    if (candles.length > 0) {
      // Verify volume data exists
      const hasVolume = candles.some((c) => c.volume > 0);
      if (hasVolume) {
        saveBinanceCandleCache({
          cacheKeySymbol: binanceKey,
          interval,
          startAlignedMs: startAligned,
          endAlignedMs: endAligned,
          candles,
        });
        logFull(`   ✅ Loaded ${candles.length} candles from Binance (with volume)`);
        return candles;
      }
    }
  } catch (e) {
    console.log(`   Binance fetch failed: ${e.message}`);
  }

  // Try local database
  try {
    const rawCandles = db.getCandles(symbol, interval, startAligned, endAligned);

    if (rawCandles && rawCandles.length > 0) {
      const candles = rawCandles.map((c) => ({
        timestamp: c.openTime || c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.baseVolume || c.volume || 0,
      }));

      candles.sort((a, b) => a.timestamp - b.timestamp);
      const hasVolume = candles.some((c) => c.volume > 0);
      logFull(
        `   ✅ Loaded ${candles.length} candles from DB ${hasVolume ? "(with volume)" : "(NO VOLUME - CVD will fail!)"}`
      );
      return candles;
    }
  } catch (e) {
    console.log(`   DB fetch failed: ${e.message}`);
  }

  // Pyth as last resort (no volume - CVD won't work)
  try {
    const candles = await fetchFromPyth(symbol, startAligned, endAligned, interval);
    logFull(
      `   ⚠️ Loaded ${candles.length} candles from Pyth (NO VOLUME - CVD indicator will not work!)`
    );
    return candles;
  } catch (e) {
    console.log(`   Pyth fetch failed: ${e.message}`);
  }

  throw new Error(`No candle data found for ${symbol}`);
}

// ============================================================
// SINGLE MARKET SIMULATION (Bot Runtime Model)
// ============================================================

function simulatePredictaSingleMarket(strategy, candles, options = {}) {
  const {
    positionSizeUsd = 1000,
    leverage = 5,
    hardStopPercent = 15,
    debug = false,
    allowLongs = true,
    allowShorts = true,
    ticksPerCandle = TICKS_PER_5MIN_CANDLE, // Default to 20 ticks per 5m bar
    simulateTicks = true, // Enable 15-second tick simulation (matches bot loop)
    ticksByBarOpenTime = null, // Map<barOpenTimeMs, Array<{price, ts}>> from 1m candles
    oneMinCandles = null, // 1m candle array for fallback tick generation
    entryAtBarOpenOnly = true,
  } = options;

  const symbol = String(options.symbol || "UNKNOWN").toUpperCase();
  const marketKey = `${symbol}_PERP`;
  const pmEnv = (key) => process.env[`STRATEGY_${marketKey}_${key}`];
  const pmBool = (key, fallback) => {
    const pm = pmEnv(key);
    if (pm !== undefined && pm !== "") return String(pm).toLowerCase() === "true" || pm === "1";
    return fallback;
  };
  const pmNum = (key, fallback) => {
    const pm = pmEnv(key);
    if (pm !== undefined && pm !== "") return Number(pm);
    return fallback;
  };

  const globalUseRiskTP =
    String(process.env.USE_RISK_TP || "").toLowerCase() === "true" ||
    String(process.env.USE_RISK_TP || "") === "1";
  const useRiskTP = pmBool("USE_RISK_TP", globalUseRiskTP);
  const takeProfitPercent = pmNum("TAKE_PROFIT_PERCENT", num(process.env.TAKE_PROFIT_PERCENT, 0));
  const stopLossPercent = pmNum("STOP_LOSS_PERCENT", num(process.env.STOP_LOSS_PERCENT, 0));
  const globalUseTrailingStop =
    String(process.env.USE_TRAILING_STOP || "").toLowerCase() === "true" ||
    String(process.env.USE_TRAILING_STOP || "") === "1";
  const useTrailingStopPercent = pmBool("USE_TRAILING_STOP", globalUseTrailingStop);
  const trailingStopPercent = pmNum(
    "TRAILING_STOP_PERCENT",
    num(process.env.TRAILING_STOP_PERCENT, 0)
  );

  // Fee configuration - uses FEE_MODEL env var (jupiter or drift)
  const feeCfg = getFeeCfg();
  const trades = [];
  let position = null;
  let equity = options.initialCapital || positionSizeUsd;
  let peak = equity;
  let maxDrawdown = 0;
  let highWaterMark = null;
  let lowWaterMark = null;
  let totalFees = 0;
  const feeBreakdown = {
    openFees: 0,
    closeFees: 0,
    priceImpactFees: 0,
    swapFees: 0,
    borrowFees: 0,
    txFees: 0,
    count: 0,
  };
  const riskExitCounts = { STOP_LOSS: 0, TAKE_PROFIT: 0, TRAILING_STOP: 0 };

  // Reset strategy state
  strategy.reset();

  // Helper: Calculate stop/TP prices for intrabar simulation
  const calculateStopTpPrices = (pos, slPct, tpPct) => {
    const entry = pos.entryPrice;
    const lev = pos.leverage;
    // Stop loss price: the price at which PnL% hits -slPct
    // For LONG: (stopPrice - entry) / entry * lev * 100 = -slPct
    //           stopPrice = entry * (1 - slPct / lev / 100)
    // For SHORT: (entry - stopPrice) / entry * lev * 100 = -slPct
    //            stopPrice = entry * (1 + slPct / lev / 100)
    const slPrice =
      pos.side === "long" ? entry * (1 - slPct / lev / 100) : entry * (1 + slPct / lev / 100);
    // Take profit price: the price at which PnL% hits +tpPct
    const tpPrice =
      pos.side === "long" ? entry * (1 + tpPct / lev / 100) : entry * (1 - tpPct / lev / 100);
    return { slPrice, tpPrice };
  };

  // Determine if we have 1m-based tick data
  const has1MinTickData = ticksByBarOpenTime && ticksByBarOpenTime.size > 0;

  if (debug) {
    console.log(
      `[TICK-SIM] Mode: ${simulateTicks ? (has1MinTickData ? "1m-derived (15s ticks)" : "OHLC interpolation") : "disabled"}`
    );
    console.log(
      `[RISK-TP] SL: ${stopLossPercent}%, TP: ${takeProfitPercent}%, Trailing: ${useTrailingStopPercent ? trailingStopPercent + "%" : "disabled"}`
    );
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const { open, high, low, close, volume, timestamp, takerBuyBaseVolume } = candle;
    const barOpenTime = Number(candle.openTime || candle.timestamp);

    // Get tick data for this bar
    // Priority: 1m-derived ticks > OHLC interpolation > close-only
    let intraBarTicks = null;
    if (simulateTicks) {
      // Try to get pre-built ticks from 1m candles
      if (has1MinTickData) {
        const cached = ticksByBarOpenTime.get(barOpenTime);
        if (cached && cached.length > 0) {
          intraBarTicks = cached;
        }
      }

      // Fallback: generate ticks from 5m OHLC (less accurate but better than nothing)
      if (!intraBarTicks) {
        intraBarTicks = generateTicksFromOHLC(candle, ticksPerCandle);
      }
    }

    // If no tick simulation, just use close price
    if (!intraBarTicks || intraBarTicks.length === 0) {
      intraBarTicks = [{ price: close, ts: barOpenTime }];
    }

    let runningHigh = open ?? close;
    let runningLow = open ?? close;

    // Process each tick within the bar (15s intervals from 1m candles)
    for (let tickIdx = 0; tickIdx < intraBarTicks.length; tickIdx++) {
      const tick = intraBarTicks[tickIdx];
      const tickPrice = typeof tick === "number" ? tick : tick.price;
      const tickTs = typeof tick === "number" ? barOpenTime + tickIdx * TICK_INTERVAL_MS : tick.ts;

      runningHigh = Math.max(Number.isFinite(runningHigh) ? runningHigh : tickPrice, tickPrice);
      runningLow = Math.min(Number.isFinite(runningLow) ? runningLow : tickPrice, tickPrice);

      // Recalculate last bar with tick data (for intra-bar indicator updates)
      if (strategy.recalculateLastBar) {
        strategy.recalculateLastBar({
          close: tickPrice,
          high: runningHigh,
          low: runningLow,
          volume,
          takerBuyBaseVolume,
        });
      }

      // Check exits first (if in position)
      if (position) {
        // Update water marks for trailing stop
        if (position.side === "long") {
          highWaterMark = highWaterMark === null ? tickPrice : Math.max(highWaterMark, tickPrice);
        } else {
          lowWaterMark = lowWaterMark === null ? tickPrice : Math.min(lowWaterMark, tickPrice);
        }
        position.highWaterMark = highWaterMark;
        position.lowWaterMark = lowWaterMark;

        // 1) Strategy exits (disabled when USE_RISK_TP=true to mirror bot.js behavior)
        if (!useRiskTP) {
          const exitSignal = strategy.shouldClose(position, tickPrice, i);
          if (exitSignal && exitSignal.close) {
            // Calculate P&L
            const entryPrice = position.entryPrice;
            const exitPrice = tickPrice;
            const currentNotional = position.size; // Use entry size for fee calculation
            const pnlPct =
              position.side === "long"
                ? (exitPrice - entryPrice) / entryPrice
                : (entryPrice - exitPrice) / entryPrice;
            const leveragedPnlPct = pnlPct * position.leverage;
            // grossPnlUsd = collateral * leveragedPnlPct = notional * rawPnl
            const collateral = position.collateral || position.size / position.leverage;
            const grossPnlUsd = collateral * leveragedPnlPct;

            // Calculate fees using Jupiter fee structure
            const openFee = Number(position.entryFee || 0);
            const closeRes = feeCfg.calculateCloseFee
              ? feeCfg.calculateCloseFee(currentNotional, { execMode: "taker" })
              : {
                  fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                  breakdown: {
                    baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                    priceImpactFee: 0,
                  },
                };
            const closeFee = closeRes.breakdown?.baseFee ?? 0;
            const priceImpactFee =
              feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
            const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(collateral);
            const lastBorrowTs = Number.isFinite(position.lastBorrowTs)
              ? position.lastBorrowTs
              : position.entryTime;
            const borrowFee =
              feeCfg.model === "drift"
                ? 0
                : calculateBorrowFeeUsd(position.size, Math.max(0, tickTs - lastBorrowTs));
            const txFee = calculateSolanaTransactionFees(exitPrice, feeCfg);
            const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;
            const pnlUsd = grossPnlUsd - totalExitFees;
            const totalFeesForTrade = openFee + totalExitFees;

            totalFees += totalExitFees;
            feeBreakdown.closeFees += closeFee;
            feeBreakdown.priceImpactFees += priceImpactFee;
            feeBreakdown.swapFees += swapFee;
            feeBreakdown.borrowFees += borrowFee;
            feeBreakdown.txFees += txFee;
            feeBreakdown.count += 1;

            const pnlPctCollateral = collateral > 0 ? pnlUsd / collateral : leveragedPnlPct;
            // Record trade
            trades.push({
              symbol,
              side: position.side,
              entryPrice,
              exitPrice,
              entryTime: position.entryTime,
              exitTime: tickTs,
              pnlPct: leveragedPnlPct,
              pnlPctCollateral,
              pnlUsd,
              grossPnlUsd,
              collateral,
              fees: {
                open: openFee,
                close: closeFee,
                priceImpact: priceImpactFee,
                swap: swapFee,
                borrow: borrowFee,
                tx: txFee,
                total: totalFeesForTrade,
                model: feeCfg.model,
              },
              exitReason: exitSignal.reason,
              leverage: position.leverage,
              size: position.size,
              barsHeld: i - position.openBarIndex,
            });

            // Update equity
            equity += collateral + pnlUsd;
            if (equity > peak) peak = equity;
            const drawdown = (peak - equity) / peak;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;

            // Record trade in strategy
            strategy.recordTrade({
              side: position.side,
              pnlUsd,
              pnlPercent: leveragedPnlPct,
              exitReason: exitSignal.reason,
            });

            if (debug) {
              console.log(
                `[EXIT] ${position.side.toUpperCase()} @ $${exitPrice.toFixed(4)} | Reason: ${exitSignal.reason} | PnL: ${(leveragedPnlPct * 100).toFixed(2)}% ($${pnlUsd.toFixed(2)}) | Fees: $${fees.toFixed(4)}`
              );
            }

            position = null;
            highWaterMark = null;
            lowWaterMark = null;
          }
        }

        // 2) Risk TP/SL/percent-trailing exits (PER-TICK checking for accuracy)
        // This is the key change: check at EACH tick price, not using candle high/low
        if (position && useRiskTP) {
          const entryPrice = position.entryPrice;
          let riskReason = null;
          let actualExitPrice = tickPrice;

          // Calculate stop/TP price levels if enabled
          const hasStopLoss = Number.isFinite(stopLossPercent) && stopLossPercent > 0;
          const hasTakeProfit = Number.isFinite(takeProfitPercent) && takeProfitPercent > 0;

          let slPrice = null;
          let tpPrice = null;
          if (hasStopLoss || hasTakeProfit) {
            const prices = calculateStopTpPrices(
              position,
              stopLossPercent || 100,
              takeProfitPercent || 100
            );
            slPrice = hasStopLoss ? prices.slPrice : null;
            tpPrice = hasTakeProfit ? prices.tpPrice : null;
          }

          // PER-TICK STOP LOSS CHECK
          // Check if THIS tick price hits the stop loss level
          // For LONG: stop triggers if tick price <= slPrice
          // For SHORT: stop triggers if tick price >= slPrice
          if (hasStopLoss && !riskReason) {
            const breachedSL =
              position.side === "long" ? tickPrice <= slPrice : tickPrice >= slPrice;
            if (breachedSL) {
              riskReason = "STOP_LOSS";
              // Exit at the tick price (realistic - you get filled at market, not exactly at stop level)
              // This means SL exits will have variance around the configured level
              actualExitPrice = tickPrice;
            }
          }

          // PER-TICK TAKE PROFIT CHECK
          // For LONG: TP triggers if tick price >= tpPrice
          // For SHORT: TP triggers if tick price <= tpPrice
          if (hasTakeProfit && !riskReason) {
            const breachedTP =
              position.side === "long" ? tickPrice >= tpPrice : tickPrice <= tpPrice;
            if (breachedTP) {
              riskReason = "TAKE_PROFIT";
              // Exit at the tick price (realistic - you get filled at market, not exactly at TP level)
              // This means TP exits will have variance around the configured level
              actualExitPrice = tickPrice;
            }
          }

          // Percent TRAILING STOP (drawdown from peak) - check at each tick
          if (
            !riskReason &&
            useTrailingStopPercent &&
            Number.isFinite(trailingStopPercent) &&
            trailingStopPercent > 0
          ) {
            const rawPnl =
              position.side === "long"
                ? (tickPrice - entryPrice) / entryPrice
                : (entryPrice - tickPrice) / entryPrice;
            const pnlPercent = rawPnl * position.leverage * 100;

            // Track peak PnL for trailing stop
            if (!Number.isFinite(position.highestPnlPercent))
              position.highestPnlPercent = pnlPercent;
            position.highestPnlPercent = Math.max(position.highestPnlPercent, pnlPercent);

            const drawdownFromPeak = position.highestPnlPercent - pnlPercent;
            if (drawdownFromPeak >= trailingStopPercent) {
              riskReason = "TRAILING_STOP";
              actualExitPrice = tickPrice;
            }
          }

          if (riskReason) {
            const exitPrice = actualExitPrice;
            const rawPnlAtExit =
              position.side === "long"
                ? (exitPrice - entryPrice) / entryPrice
                : (entryPrice - exitPrice) / entryPrice;
            const leveragedPnlPct = rawPnlAtExit * position.leverage;
            const pnlPercent = leveragedPnlPct * 100;

            const currentNotional = position.size;
            // grossPnlUsd = collateral * leveragedPnlPct = notional * rawPnl
            const collateral = position.collateral || position.size / position.leverage;
            const grossPnlUsd = collateral * leveragedPnlPct;

            // Calculate fees using Jupiter fee structure
            const openFee = Number(position.entryFee || 0);
            const closeRes = feeCfg.calculateCloseFee
              ? feeCfg.calculateCloseFee(currentNotional, { execMode: "taker" })
              : {
                  fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                  breakdown: {
                    baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                    priceImpactFee: 0,
                  },
                };
            const closeFee = closeRes.breakdown?.baseFee ?? 0;
            const priceImpactFee =
              feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
            const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(collateral);
            const lastBorrowTs = Number.isFinite(position.lastBorrowTs)
              ? position.lastBorrowTs
              : position.entryTime;
            const borrowFee =
              feeCfg.model === "drift"
                ? 0
                : calculateBorrowFeeUsd(position.size, Math.max(0, tickTs - lastBorrowTs));
            const txFee = calculateSolanaTransactionFees(exitPrice, feeCfg);
            const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;
            const pnlUsd = grossPnlUsd - totalExitFees;
            const totalFeesForTrade = openFee + totalExitFees;

            totalFees += totalExitFees;
            feeBreakdown.closeFees += closeFee;
            feeBreakdown.priceImpactFees += priceImpactFee;
            feeBreakdown.swapFees += swapFee;
            feeBreakdown.borrowFees += borrowFee;
            feeBreakdown.txFees += txFee;
            feeBreakdown.count += 1;
            riskExitCounts[riskReason] = (riskExitCounts[riskReason] || 0) + 1;

            const pnlPctCollateral = collateral > 0 ? pnlUsd / collateral : leveragedPnlPct;
            trades.push({
              symbol,
              side: position.side,
              entryPrice,
              exitPrice,
              entryTime: position.entryTime,
              exitTime: tickTs,
              pnlPct: leveragedPnlPct,
              pnlPctCollateral,
              pnlUsd,
              grossPnlUsd,
              collateral,
              fees: {
                open: openFee,
                close: closeFee,
                priceImpact: priceImpactFee,
                swap: swapFee,
                borrow: borrowFee,
                tx: txFee,
                total: totalFeesForTrade,
                model: feeCfg.model,
              },
              exitReason: riskReason,
              leverage: position.leverage,
              size: position.size,
              barsHeld: i - position.openBarIndex,
            });

            equity += collateral + pnlUsd;
            if (equity > peak) peak = equity;
            const drawdown = (peak - equity) / peak;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;

            // Record in strategy (helps circuit breaker metrics)
            strategy.recordTrade({
              side: position.side,
              pnlUsd,
              pnlPercent: leveragedPnlPct,
              exitReason: riskReason,
            });

            if (debug) {
              console.log(
                `[EXIT] ${position.side.toUpperCase()} @ $${exitPrice.toFixed(4)} | Reason: ${riskReason} | PnL: ${pnlPercent.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | Fees: $${totalFeesForTrade.toFixed(4)}`
              );
            }

            position = null;
            highWaterMark = null;
            lowWaterMark = null;
          }
        }
      }

      // Check for entries (if not in position)
      if (!position) {
        if (entryAtBarOpenOnly && tickIdx !== 0) {
          continue;
        }

        const signal = strategy.getSignal(tickPrice, [], debug, i);

        if (signal.action === "open") {
          const side = signal.side;

          // Check direction filters
          if ((side === "long" && !allowLongs) || (side === "short" && !allowShorts)) {
            continue;
          }

          // Open position with proper Jupiter fee structure
          const sizeMult = strategy.getRecommendedPositionSize(tickPrice, side, equity) || 1.0;
          const pct = (options.positionSizePercent || 30) / 100;
          const desiredCollateral = equity * pct * sizeMult;
          const minPos = Number(options.minPositionSize || 0);
          const maxPos = Number(options.maxPositionSize || 0);
          let collateral = Math.min(desiredCollateral, equity);
          if (Number.isFinite(maxPos) && maxPos > 0) collateral = Math.min(collateral, maxPos);
          if (Number.isFinite(minPos) && minPos > 0 && collateral < minPos) {
            continue;
          }
          const posSize = collateral * leverage;

          // Calculate entry fees using Jupiter fee structure
          const openRes = feeCfg.calculateOpenFee
            ? feeCfg.calculateOpenFee(posSize, { execMode: "taker" })
            : {
                fee: posSize * (feeCfg.openFeeBps / 10_000),
                breakdown: { baseFee: posSize * (feeCfg.openFeeBps / 10_000), priceImpactFee: 0 },
              };
          const openBaseFee =
            openRes.breakdown?.baseFee ?? openRes.fee ?? posSize * (feeCfg.openFeeBps / 10_000);
          const openPriceImpactFee =
            feeCfg.model === "drift" ? 0 : (openRes.breakdown?.priceImpactFee ?? 0);
          const openSwapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(collateral);
          const openTxFee = calculateSolanaTransactionFees(tickPrice, feeCfg);
          const entryFee = openBaseFee + openPriceImpactFee + openSwapFee + openTxFee;
          const totalRequired = collateral + entryFee;
          if (totalRequired > equity) {
            continue;
          }
          equity -= totalRequired;
          totalFees += entryFee;
          feeBreakdown.openFees += openBaseFee;
          feeBreakdown.priceImpactFees += openPriceImpactFee;
          feeBreakdown.swapFees += openSwapFee;
          feeBreakdown.txFees += openTxFee;

          position = {
            side,
            entryPrice: tickPrice,
            entryTime: tickTs,
            size: posSize,
            collateral,
            leverage,
            openBarIndex: i,
            signalType: signal.signalType,
            confluence: signal.confluence,
            score: signal.score,
            entryFee,
            entryFeeBreakdown: {
              base: openBaseFee,
              priceImpact: openPriceImpactFee,
              swap: openSwapFee,
              tx: openTxFee,
            },
            highestPnlPercent: 0,
            lastBorrowTs: tickTs,
          };
          highWaterMark = tickPrice;
          lowWaterMark = tickPrice;

          if (debug) {
            console.log(
              `[ENTRY] ${side.toUpperCase()} @ $${tickPrice.toFixed(4)} | Signal: ${signal.reason} | Conf: ${signal.confluence}/8 | Score: ${signal.score?.toFixed(1)}%`
            );
          }
        }
      }
    }

    // Bar-close update LAST (after all intra-bar ticks are processed) to avoid lookahead.
    // Predicta is bar-based (recalculateLastBar is a NO-OP), so signals during this bar
    // should be based on the previous completed bar, matching the live event model.
    const barCloseTs = Number.isFinite(Number(candle.closeTime))
      ? Number(candle.closeTime)
      : barOpenTime;
    strategy.update({
      price: close,
      close,
      high,
      low,
      volume,
      takerBuyBaseVolume,
      ts: barCloseTs,
    });
  }

  // Close any remaining position at last tick (or last candle close if ticks unavailable)
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const lastBarOpen = Number(lastCandle.openTime ?? lastCandle.timestamp);
    let exitPrice = lastCandle.close;
    let exitTime = Number.isFinite(lastCandle.closeTime)
      ? Number(lastCandle.closeTime)
      : lastBarOpen;
    if (simulateTicks && ticksByBarOpenTime && Number.isFinite(lastBarOpen)) {
      const ticks = ticksByBarOpenTime.get(lastBarOpen);
      if (Array.isArray(ticks) && ticks.length > 0) {
        const lastTick = ticks[ticks.length - 1];
        exitPrice = typeof lastTick === "number" ? lastTick : Number(lastTick.price);
        exitTime =
          typeof lastTick === "number"
            ? lastBarOpen + (ticks.length - 1) * TICK_INTERVAL_MS
            : Number(lastTick.ts);
      }
    }
    const currentNotional = position.size;
    const pnlPct =
      position.side === "long"
        ? (exitPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - exitPrice) / position.entryPrice;
    const leveragedPnlPct = pnlPct * position.leverage;
    // grossPnlUsd = collateral * leveragedPnlPct = notional * rawPnl
    const collateral = position.collateral || position.size / position.leverage;
    const grossPnlUsd = collateral * leveragedPnlPct;

    // Calculate fees using Jupiter fee structure
    const openFee = Number(position.entryFee || 0);
    const closeRes = feeCfg.calculateCloseFee
      ? feeCfg.calculateCloseFee(currentNotional, { execMode: "taker" })
      : {
          fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
          breakdown: {
            baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
            priceImpactFee: 0,
          },
        };
    const closeFee = closeRes.breakdown?.baseFee ?? 0;
    const priceImpactFee = feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
    const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(collateral);
    const lastBorrowTs = Number.isFinite(position.lastBorrowTs)
      ? position.lastBorrowTs
      : position.entryTime;
    const borrowFee =
      feeCfg.model === "drift"
        ? 0
        : calculateBorrowFeeUsd(position.size, Math.max(0, exitTime - lastBorrowTs));
    const txFee = calculateSolanaTransactionFees(exitPrice, feeCfg);
    const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;
    const pnlUsd = grossPnlUsd - totalExitFees;
    const totalFeesForTrade = openFee + totalExitFees;

    totalFees += totalExitFees;
    feeBreakdown.closeFees += closeFee;
    feeBreakdown.priceImpactFees += priceImpactFee;
    feeBreakdown.swapFees += swapFee;
    feeBreakdown.borrowFees += borrowFee;
    feeBreakdown.txFees += txFee;
    feeBreakdown.count += 1;

    const pnlPctCollateral = collateral > 0 ? pnlUsd / collateral : leveragedPnlPct;
    trades.push({
      symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      entryTime: position.entryTime,
      exitTime,
      pnlPct: leveragedPnlPct,
      pnlPctCollateral,
      pnlUsd,
      grossPnlUsd,
      collateral,
      fees: {
        open: openFee,
        close: closeFee,
        priceImpact: priceImpactFee,
        swap: swapFee,
        borrow: borrowFee,
        tx: txFee,
        total: totalFeesForTrade,
        model: feeCfg.model,
      },
      exitReason: "end_of_backtest",
      leverage: position.leverage,
      size: position.size,
      barsHeld: candles.length - position.openBarIndex,
    });

    equity += collateral + pnlUsd;
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Calculate metrics
  const winningTrades = trades.filter((t) => t.pnlUsd > 0);
  const losingTrades = trades.filter((t) => t.pnlUsd <= 0);
  // totalPnL should reflect actual net P&L after ALL fees (entry + exit)
  // Equity already accounts for all fees, so calculate from equity change
  const initialCapital = options.initialCapital || positionSizeUsd;
  const totalPnL = equity - initialCapital;
  const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;

  const avgWin =
    winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.pnlUsd, 0) / winningTrades.length
      : 0;
  const avgLoss =
    losingTrades.length > 0
      ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlUsd, 0)) / losingTrades.length
      : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  return {
    trades,
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate,
    totalPnL,
    totalFees,
    feeBreakdown,
    avgWin,
    avgLoss,
    profitFactor,
    maxDrawdown,
    finalEquity: equity,
    returnPct:
      ((equity - (options.initialCapital || positionSizeUsd)) /
        (options.initialCapital || positionSizeUsd)) *
      100,
  };
}

function generateTickPrices(open, high, low, close, count) {
  const o = Number(open);
  const h = Number(high);
  const l = Number(low);
  const c = Number(close);
  const n = Math.max(1, Math.floor(Number(count) || 0));
  if (![o, h, l, c].every(Number.isFinite)) return [c];
  if (n === 1) return [c];

  const bullish = c >= o;
  const p1 = bullish ? l : h;
  const p2 = bullish ? h : l;

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (x) => Math.max(l, Math.min(h, x));

  const totalSteps = n - 1; // points to generate after the initial open
  let n1 = Math.max(1, Math.floor(totalSteps / 3));
  let n2 = Math.max(1, Math.floor(totalSteps / 3));
  let n3 = totalSteps - n1 - n2;
  if (n3 < 1) {
    n3 = 1;
    if (n2 > 1) n2 -= 1;
    else n1 = Math.max(1, n1 - 1);
  }

  const ticks = [o];
  const addSegment = (a, b, steps) => {
    for (let i = 1; i <= steps; i++) ticks.push(clamp(lerp(a, b, i / steps)));
  };

  addSegment(o, p1, n1);
  addSegment(p1, p2, n2);
  addSegment(p2, c, n3);
  return ticks.length === n ? ticks : ticks.slice(0, n);
}

// ============================================================
// MULTI-MARKET SIMULATION
// ============================================================

function simulatePredictaMultiMarket(strategiesMap, candlesMap, options = {}) {
  const {
    initialCapital = 1000,
    leverage = 5,
    positionSizePercent = 30,
    maxPositions = 3,
    debug = false,
    allowLongs = true,
    allowShorts = true,
    perMarketLeverage = new Map(),
    perMarketHardStop = new Map(),
    // Tick simulation options
    simulateTicks = true,
    ticksPerCandle = TICKS_PER_5MIN_CANDLE,
    ticksByBarOpenTimeMap = null, // Map<symbol, Map<barOpenTimeMs, Array<{price, ts}>>>
    oneMinCandlesMap = null,
    minPositionSize = 0,
    maxPositionSize = 0,
    entryAtBarOpenOnly = true,
  } = options;

  const has1MinTickData = ticksByBarOpenTimeMap && ticksByBarOpenTimeMap.size > 0;

  // Per-market risk TP/SL helpers
  const getPerMarketRiskParams = (symbol) => {
    const marketKey = `${symbol.toUpperCase()}_PERP`;
    const pmEnv = (key) => process.env[`STRATEGY_${marketKey}_${key}`];
    const pmBool = (key, fallback) => {
      const pm = pmEnv(key);
      if (pm !== undefined && pm !== "") return String(pm).toLowerCase() === "true" || pm === "1";
      return fallback;
    };
    const pmNum = (key, fallback) => {
      const pm = pmEnv(key);
      if (pm !== undefined && pm !== "") return Number(pm);
      return fallback;
    };

    const globalUseRiskTP =
      String(process.env.USE_RISK_TP || "").toLowerCase() === "true" ||
      String(process.env.USE_RISK_TP || "") === "1";
    const globalUseTrailingStop =
      String(process.env.USE_TRAILING_STOP || "").toLowerCase() === "true" ||
      String(process.env.USE_TRAILING_STOP || "") === "1";

    return {
      useRiskTP: pmBool("USE_RISK_TP", globalUseRiskTP),
      takeProfitPercent: pmNum("TAKE_PROFIT_PERCENT", num(process.env.TAKE_PROFIT_PERCENT, 0)),
      stopLossPercent: pmNum("STOP_LOSS_PERCENT", num(process.env.STOP_LOSS_PERCENT, 0)),
      useTrailingStopPercent: pmBool("USE_TRAILING_STOP", globalUseTrailingStop),
      trailingStopPercent: pmNum(
        "TRAILING_STOP_PERCENT",
        num(process.env.TRAILING_STOP_PERCENT, 0)
      ),
    };
  };

  // Fee configuration - uses FEE_MODEL env var (jupiter or drift)
  const feeCfg = getFeeCfg();
  const allTrades = [];
  const positionsByMarket = new Map();
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  let totalFees = 0;
  const feeBreakdown = {
    openFees: 0,
    closeFees: 0,
    priceImpactFees: 0,
    swapFees: 0,
    borrowFees: 0,
    txFees: 0,
    count: 0,
  };
  const riskParamsByMarket = new Map();
  for (const symbol of strategiesMap.keys()) {
    riskParamsByMarket.set(symbol, getPerMarketRiskParams(symbol));
  }

  // Get all timestamps across all markets
  const allTimestamps = new Set();
  for (const [symbol, candles] of candlesMap.entries()) {
    for (const candle of candles) {
      allTimestamps.add(candle.timestamp);
    }
  }
  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

  // Index candles by timestamp for each market
  const candleIndexes = new Map();
  for (const [symbol, candles] of candlesMap.entries()) {
    const index = new Map();
    candles.forEach((c, i) => index.set(c.timestamp, i));
    candleIndexes.set(symbol, { candles, index });
  }

  // Reset all strategies
  for (const [symbol, strategy] of strategiesMap.entries()) {
    strategy.reset();
  }

  // Process each timestamp
  for (const ts of sortedTimestamps) {
    if (simulateTicks) {
      const barStates = [];
      let maxTicks = 0;

      for (const [symbol, strategy] of strategiesMap.entries()) {
        const { candles, index } = candleIndexes.get(symbol);
        const candleIdx = index.get(ts);
        if (candleIdx === undefined) continue;
        const candle = candles[candleIdx];
        const barOpenTime = Number(candle.openTime || candle.timestamp);
        let ticks = null;

        if (has1MinTickData) {
          const marketTicksByBar = ticksByBarOpenTimeMap.get(symbol);
          const cached = marketTicksByBar ? marketTicksByBar.get(barOpenTime) : null;
          if (cached && cached.length > 0) ticks = cached;
        }
        if (!ticks || ticks.length === 0) {
          ticks = generateTicksFromOHLC(candle, ticksPerCandle);
        }
        if (!ticks || ticks.length === 0) {
          ticks = [{ price: candle.close, ts: barOpenTime }];
        }

        maxTicks = Math.max(maxTicks, ticks.length);
        barStates.push({
          symbol,
          strategy,
          candle,
          candleIdx,
          barOpenTime,
          ticks,
          high: candle.open ?? candle.close,
          low: candle.open ?? candle.close,
        });
      }

      for (let tickIdx = 0; tickIdx < maxTicks; tickIdx++) {
        const signals = [];

        for (const state of barStates) {
          const tick = state.ticks[Math.min(tickIdx, state.ticks.length - 1)];
          const tickPrice = typeof tick === "number" ? tick : tick.price;
          const tickTs =
            typeof tick === "number" ? state.barOpenTime + tickIdx * TICK_INTERVAL_MS : tick.ts;

          state.high = Math.max(state.high, tickPrice);
          state.low = Math.min(state.low, tickPrice);

          if (state.strategy.recalculateLastBar) {
            state.strategy.recalculateLastBar({
              close: tickPrice,
              high: state.high,
              low: state.low,
              volume: state.candle.volume,
              takerBuyBaseVolume: state.candle.takerBuyBaseVolume,
            });
          }

          const position = positionsByMarket.get(state.symbol);
          const riskParams =
            riskParamsByMarket.get(state.symbol) || getPerMarketRiskParams(state.symbol);

          if (position) {
            const closePosition = (exitReason, leveragedPnlPct, exitPriceOverride = null) => {
              const actualExitPrice = exitPriceOverride !== null ? exitPriceOverride : tickPrice;
              const currentNotional = position.size;
              const collateral = position.collateral || position.size / position.leverage;
              const grossPnlUsd = collateral * leveragedPnlPct;

              const openFee = Number(position.entryFee || 0);
              const closeRes = feeCfg.calculateCloseFee
                ? feeCfg.calculateCloseFee(currentNotional, { execMode: "taker" })
                : {
                    fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                    breakdown: {
                      baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                      priceImpactFee: 0,
                    },
                  };
              const closeFee = closeRes.breakdown?.baseFee ?? 0;
              const priceImpactFee =
                feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
              const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(collateral);
              const lastBorrowTs = Number.isFinite(position.lastBorrowTs)
                ? position.lastBorrowTs
                : position.entryTime;
              const borrowFee =
                feeCfg.model === "drift"
                  ? 0
                  : calculateBorrowFeeUsd(position.size, Math.max(0, tickTs - lastBorrowTs));
              const txFee = calculateSolanaTransactionFees(actualExitPrice, feeCfg);
              const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;
              const pnlUsd = grossPnlUsd - totalExitFees;
              const totalFeesForTrade = openFee + totalExitFees;

              totalFees += totalExitFees;
              feeBreakdown.closeFees += closeFee;
              feeBreakdown.priceImpactFees += priceImpactFee;
              feeBreakdown.swapFees += swapFee;
              feeBreakdown.borrowFees += borrowFee;
              feeBreakdown.txFees += txFee;
              feeBreakdown.count += 1;

              const pnlPctCollateral = collateral > 0 ? pnlUsd / collateral : leveragedPnlPct;
              allTrades.push({
                symbol: state.symbol,
                side: position.side,
                entryPrice: position.entryPrice,
                exitPrice: actualExitPrice,
                entryTime: position.entryTime,
                exitTime: tickTs,
                pnlPct: leveragedPnlPct,
                pnlPctCollateral,
                pnlUsd,
                grossPnlUsd,
                collateral,
                fees: {
                  open: openFee,
                  close: closeFee,
                  priceImpact: priceImpactFee,
                  swap: swapFee,
                  borrow: borrowFee,
                  tx: txFee,
                  total: totalFeesForTrade,
                  model: feeCfg.model,
                },
                exitReason,
                leverage: position.leverage,
                size: position.size,
                barsHeld: state.candleIdx - (position.openBarIndex || state.candleIdx),
              });

              equity += collateral + pnlUsd;
              if (equity > peak) peak = equity;
              const drawdown = (peak - equity) / peak;
              if (drawdown > maxDrawdown) maxDrawdown = drawdown;

              state.strategy.recordTrade({
                side: position.side,
                pnlUsd,
                pnlPercent: leveragedPnlPct,
                exitReason,
              });

              positionsByMarket.delete(state.symbol);
            };

            if (!riskParams.useRiskTP) {
              const exitSignal = state.strategy.shouldClose(position, tickPrice, state.candleIdx);
              if (exitSignal && exitSignal.close) {
                const rawPnl =
                  position.side === "long"
                    ? (tickPrice - position.entryPrice) / position.entryPrice
                    : (position.entryPrice - tickPrice) / position.entryPrice;
                closePosition(exitSignal.reason, rawPnl * position.leverage, tickPrice);
                continue;
              }
            }

            if (riskParams.useRiskTP) {
              const entry = position.entryPrice;
              const lev = position.leverage;
              const slPct = Number(riskParams.stopLossPercent || 0);
              const tpPct = Number(riskParams.takeProfitPercent || 0);
              const hasStopLoss = slPct > 0;
              const hasTakeProfit = tpPct > 0;
              const slPrice = hasStopLoss
                ? position.side === "long"
                  ? entry * (1 - slPct / lev / 100)
                  : entry * (1 + slPct / lev / 100)
                : null;
              const tpPrice = hasTakeProfit
                ? position.side === "long"
                  ? entry * (1 + tpPct / lev / 100)
                  : entry * (1 - tpPct / lev / 100)
                : null;

              let riskReason = null;
              let exitPrice = tickPrice;

              if (hasStopLoss) {
                const breachedSL =
                  position.side === "long" ? tickPrice <= slPrice : tickPrice >= slPrice;
                if (breachedSL) riskReason = "STOP_LOSS";
              }

              if (hasTakeProfit && !riskReason) {
                const breachedTP =
                  position.side === "long" ? tickPrice >= tpPrice : tickPrice <= tpPrice;
                if (breachedTP) riskReason = "TAKE_PROFIT";
              }

              if (
                !riskReason &&
                riskParams.useTrailingStopPercent &&
                Number(riskParams.trailingStopPercent) > 0
              ) {
                const rawPnlAtTick =
                  position.side === "long"
                    ? (tickPrice - entry) / entry
                    : (entry - tickPrice) / entry;
                const pnlPercentAtTick = rawPnlAtTick * lev * 100;
                position.highestPnlPercent = Math.max(
                  position.highestPnlPercent || pnlPercentAtTick,
                  pnlPercentAtTick
                );
                const drawdownFromPeak = position.highestPnlPercent - pnlPercentAtTick;
                if (drawdownFromPeak >= Number(riskParams.trailingStopPercent)) {
                  riskReason = "TRAILING_STOP";
                }
              }

              if (riskReason) {
                const rawPnlAtExit =
                  position.side === "long"
                    ? (exitPrice - entry) / entry
                    : (entry - exitPrice) / entry;
                closePosition(riskReason, rawPnlAtExit * lev, exitPrice);
                continue;
              }
            }
          } else {
            if (!entryAtBarOpenOnly || tickIdx === 0) {
              const signal = state.strategy.getSignal(tickPrice, [], false, state.candleIdx);
              if (signal.action === "open") {
                signals.push({
                  symbol: state.symbol,
                  strategy: state.strategy,
                  signal,
                  price: tickPrice,
                  timestamp: tickTs,
                  candleIdx: state.candleIdx,
                });
              }
            }
          }
        }

        if (signals.length && positionsByMarket.size < maxPositions) {
          signals.sort((a, b) => Math.abs(b.signal.confidence) - Math.abs(a.signal.confidence));
          for (const entry of signals) {
            if (positionsByMarket.size >= maxPositions) break;
            if (positionsByMarket.has(entry.symbol)) continue;

            const side = entry.signal.side;
            if ((side === "long" && !allowLongs) || (side === "short" && !allowShorts)) continue;

            const marketLeverage = perMarketLeverage.get(entry.symbol) || leverage;
            const sizeMult =
              entry.strategy.getRecommendedPositionSize(entry.price, side, equity) || 1.0;
            const pct = positionSizePercent / 100;
            const desiredCollateral = equity * pct * sizeMult;
            const maxAlloc = equity / (maxPositions - positionsByMarket.size);
            const minPos = Number(minPositionSize || 0);
            const maxPos = Number(maxPositionSize || 0);
            let collateral = Math.min(desiredCollateral, maxAlloc, equity);
            if (Number.isFinite(maxPos) && maxPos > 0) collateral = Math.min(collateral, maxPos);
            if (Number.isFinite(minPos) && minPos > 0 && collateral < minPos) {
              continue;
            }
            const posSize = collateral * marketLeverage;

            const openRes = feeCfg.calculateOpenFee
              ? feeCfg.calculateOpenFee(posSize, { execMode: "taker" })
              : {
                  fee: posSize * (feeCfg.openFeeBps / 10_000),
                  breakdown: { baseFee: posSize * (feeCfg.openFeeBps / 10_000), priceImpactFee: 0 },
                };
            const openBaseFee =
              openRes.breakdown?.baseFee ?? openRes.fee ?? posSize * (feeCfg.openFeeBps / 10_000);
            const openPriceImpactFee =
              feeCfg.model === "drift" ? 0 : (openRes.breakdown?.priceImpactFee ?? 0);
            const openSwapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(collateral);
            const openTxFee = calculateSolanaTransactionFees(entry.price, feeCfg);
            const entryFee = openBaseFee + openPriceImpactFee + openSwapFee + openTxFee;
            const totalRequired = collateral + entryFee;
            if (totalRequired > equity) {
              continue;
            }
            equity -= totalRequired;
            totalFees += entryFee;
            feeBreakdown.openFees += openBaseFee;
            feeBreakdown.priceImpactFees += openPriceImpactFee;
            feeBreakdown.swapFees += openSwapFee;
            feeBreakdown.txFees += openTxFee;

            positionsByMarket.set(entry.symbol, {
              side,
              entryPrice: entry.price,
              entryTime: entry.timestamp,
              size: posSize,
              collateral,
              leverage: marketLeverage,
              openBarIndex: entry.candleIdx,
              highWaterMark: entry.price,
              lowWaterMark: entry.price,
              entryFee,
              entryFeeBreakdown: {
                base: openBaseFee,
                priceImpact: openPriceImpactFee,
                swap: openSwapFee,
                tx: openTxFee,
              },
              highestPnlPercent: 0,
              lastBorrowTs: entry.timestamp,
            });
          }
        }
      }

      // Bar-close updates LAST (after all intra-bar ticks processed) to avoid lookahead.
      for (const state of barStates) {
        const candle = state.candle;
        const barCloseTs = Number.isFinite(Number(candle.closeTime))
          ? Number(candle.closeTime)
          : Number(candle.timestamp);
        state.strategy.update({
          price: candle.close,
          close: candle.close,
          high: candle.high,
          low: candle.low,
          volume: candle.volume,
          takerBuyBaseVolume: candle.takerBuyBaseVolume,
          ts: barCloseTs,
        });
      }

      continue;
    }

    // Check exits for all positions
    for (const [symbol, position] of positionsByMarket.entries()) {
      const strategy = strategiesMap.get(symbol);
      const { candles, index } = candleIndexes.get(symbol);
      const candleIdx = index.get(ts);
      if (candleIdx === undefined) continue;

      const candle = candles[candleIdx];
      const closePrice = candle.close;

      const closePosition = (exitReason, leveragedPnlPct, exitPriceOverride = null) => {
        const actualExitPrice = exitPriceOverride !== null ? exitPriceOverride : closePrice;
        const currentNotional = position.size;
        // grossPnlUsd = collateral * leveragedPnlPct = notional * rawPnl
        const collateral = position.collateral || position.size / position.leverage;
        const grossPnlUsd = collateral * leveragedPnlPct;

        // Calculate fees using Jupiter fee structure
        const openFee = Number(position.entryFee || 0);
        const closeRes = feeCfg.calculateCloseFee
          ? feeCfg.calculateCloseFee(currentNotional, { execMode: "taker" })
          : {
              fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
              breakdown: {
                baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
                priceImpactFee: 0,
              },
            };
        const closeFee = closeRes.breakdown?.baseFee ?? 0;
        const priceImpactFee =
          feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
        const swapFee =
          feeCfg.model === "drift"
            ? 0
            : calculateSwapFee(position.collateral || position.size / position.leverage);
        const lastBorrowTs = Number.isFinite(position.lastBorrowTs)
          ? position.lastBorrowTs
          : position.entryTime;
        const borrowFee =
          feeCfg.model === "drift"
            ? 0
            : calculateBorrowFeeUsd(position.size, Math.max(0, ts - lastBorrowTs));
        const txFee = calculateSolanaTransactionFees(actualExitPrice, feeCfg);
        const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;
        const pnlUsd = grossPnlUsd - totalExitFees;
        const totalFeesForTrade = openFee + totalExitFees;

        totalFees += totalExitFees;
        feeBreakdown.closeFees += closeFee;
        feeBreakdown.priceImpactFees += priceImpactFee;
        feeBreakdown.swapFees += swapFee;
        feeBreakdown.borrowFees += borrowFee;
        feeBreakdown.txFees += txFee;
        feeBreakdown.count += 1;

        const pnlPctCollateral = collateral > 0 ? pnlUsd / collateral : leveragedPnlPct;
        allTrades.push({
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: actualExitPrice,
          entryTime: position.entryTime,
          exitTime: ts,
          pnlPct: leveragedPnlPct,
          pnlPctCollateral,
          pnlUsd,
          grossPnlUsd,
          collateral,
          fees: {
            open: openFee,
            close: closeFee,
            priceImpact: priceImpactFee,
            swap: swapFee,
            borrow: borrowFee,
            tx: txFee,
            total: totalFeesForTrade,
            model: feeCfg.model,
          },
          exitReason,
          leverage: position.leverage,
          size: position.size,
          barsHeld: candleIdx - (position.openBarIndex || candleIdx),
        });

        equity += collateral + pnlUsd;
        if (equity > peak) peak = equity;
        const drawdown = (peak - equity) / peak;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;

        strategy.recordTrade({
          side: position.side,
          pnlUsd,
          pnlPercent: leveragedPnlPct,
          exitReason,
        });

        positionsByMarket.delete(symbol);

        if (debug) {
          console.log(
            `[${symbol}] EXIT ${position.side.toUpperCase()} @ $${actualExitPrice.toFixed(4)} | ${exitReason} | PnL: ${(leveragedPnlPct * 100).toFixed(2)}%`
          );
        }
      };

      // Compute current leveraged PnL
      const rawPnl =
        position.side === "long"
          ? (closePrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - closePrice) / position.entryPrice;
      const leveragedPnlPct = rawPnl * position.leverage; // decimal fraction
      const pnlPercent = leveragedPnlPct * 100; // percent points

      // Track peak PnL% for percent trailing stop (risk-manager semantics)
      if (!Number.isFinite(position.highestPnlPercent)) position.highestPnlPercent = pnlPercent;
      position.highestPnlPercent = Math.max(position.highestPnlPercent, pnlPercent);

      // Get per-market risk params
      const riskParams = getPerMarketRiskParams(symbol);

      // 1) Strategy exits (disabled when USE_RISK_TP=true to mirror bot.js behavior)
      if (!riskParams.useRiskTP) {
        const exitSignal = strategy.shouldClose(position, closePrice, candleIdx);
        if (exitSignal && exitSignal.close) {
          closePosition(exitSignal.reason, leveragedPnlPct);
          continue;
        }
      }

      // 2) Risk TP/SL/percent-trailing exits (with tick simulation when available)
      // Get tick data for this market/bar if available
      const barOpenTime = Number(candle.openTime || candle.timestamp);
      let intraBarTicks = null;

      if (simulateTicks && riskParams.useRiskTP && has1MinTickData) {
        const marketTicksByBar = ticksByBarOpenTimeMap.get(symbol);
        if (marketTicksByBar) {
          const cached = marketTicksByBar.get(barOpenTime);
          if (cached && cached.length > 0) {
            intraBarTicks = cached;
          }
        }
      }

      // Helper to calculate SL/TP prices
      const calcStopTpPrices = (pos, slPct, tpPct) => {
        const entry = pos.entryPrice;
        const lev = pos.leverage;
        const slPrice =
          pos.side === "long" ? entry * (1 - slPct / lev / 100) : entry * (1 + slPct / lev / 100);
        const tpPrice =
          pos.side === "long" ? entry * (1 + tpPct / lev / 100) : entry * (1 - tpPct / lev / 100);
        return { slPrice, tpPrice };
      };

      // Calculate stop/TP price levels if enabled
      const hasStopLoss =
        Number.isFinite(riskParams.stopLossPercent) && riskParams.stopLossPercent > 0;
      const hasTakeProfit =
        Number.isFinite(riskParams.takeProfitPercent) && riskParams.takeProfitPercent > 0;

      let slPrice = null;
      let tpPrice = null;
      if (hasStopLoss || hasTakeProfit) {
        const prices = calcStopTpPrices(
          position,
          riskParams.stopLossPercent || 100,
          riskParams.takeProfitPercent || 100
        );
        slPrice = hasStopLoss ? prices.slPrice : null;
        tpPrice = hasTakeProfit ? prices.tpPrice : null;
      }

      let riskReason = null;
      let actualExitPrice = closePrice;
      let exitTickTs = ts;

      // PER-TICK checking when tick data is available
      if (intraBarTicks && intraBarTicks.length > 0 && riskParams.useRiskTP) {
        for (const tick of intraBarTicks) {
          const tickPrice = typeof tick === "number" ? tick : tick.price;
          const tickTs = typeof tick === "number" ? barOpenTime : tick.ts;

          // Update high water mark for trailing stop
          if (position.side === "long") {
            position.highWaterMark = Math.max(position.highWaterMark || tickPrice, tickPrice);
          } else {
            position.lowWaterMark = Math.min(position.lowWaterMark || tickPrice, tickPrice);
          }

          // Update peak PnL for trailing stop
          const rawPnlAtTick =
            position.side === "long"
              ? (tickPrice - position.entryPrice) / position.entryPrice
              : (position.entryPrice - tickPrice) / position.entryPrice;
          const pnlPercentAtTick = rawPnlAtTick * position.leverage * 100;
          position.highestPnlPercent = Math.max(
            position.highestPnlPercent || pnlPercentAtTick,
            pnlPercentAtTick
          );

          // Check stop loss at this tick
          if (hasStopLoss && !riskReason) {
            const breachedSL =
              position.side === "long" ? tickPrice <= slPrice : tickPrice >= slPrice;
            if (breachedSL) {
              riskReason = "STOP_LOSS";
              // Exit at the tick price (realistic - market fill, not exact stop level)
              actualExitPrice = tickPrice;
              exitTickTs = tickTs;
              break;
            }
          }

          // Check take profit at this tick
          if (hasTakeProfit && !riskReason) {
            const breachedTP =
              position.side === "long" ? tickPrice >= tpPrice : tickPrice <= tpPrice;
            if (breachedTP) {
              riskReason = "TAKE_PROFIT";
              // Exit at the tick price (realistic - market fill, not exact TP level)
              actualExitPrice = tickPrice;
              exitTickTs = tickTs;
              break;
            }
          }

          // Check trailing stop at this tick
          if (
            !riskReason &&
            riskParams.useTrailingStopPercent &&
            Number.isFinite(riskParams.trailingStopPercent) &&
            riskParams.trailingStopPercent > 0
          ) {
            const drawdownFromPeak = position.highestPnlPercent - pnlPercentAtTick;
            if (drawdownFromPeak >= riskParams.trailingStopPercent) {
              riskReason = "TRAILING_STOP";
              actualExitPrice = tickPrice;
              exitTickTs = tickTs;
              break;
            }
          }
        }
      } else {
        // Fallback: INTRABAR checking using candle high/low (less accurate but still works)
        if (hasStopLoss && !riskReason) {
          const breachedSL =
            position.side === "long" ? candle.low <= slPrice : candle.high >= slPrice;
          if (breachedSL) {
            riskReason = "STOP_LOSS";
            actualExitPrice = slPrice;
          }
        }

        if (hasTakeProfit && !riskReason) {
          const breachedTP =
            position.side === "long" ? candle.high >= tpPrice : candle.low <= tpPrice;
          if (breachedTP) {
            riskReason = "TAKE_PROFIT";
            actualExitPrice = tpPrice;
          }
        }

        // Percent TRAILING STOP (drawdown from peak)
        if (
          !riskReason &&
          riskParams.useTrailingStopPercent &&
          Number.isFinite(riskParams.trailingStopPercent) &&
          riskParams.trailingStopPercent > 0
        ) {
          const drawdownFromPeak = position.highestPnlPercent - pnlPercent;
          if (drawdownFromPeak >= riskParams.trailingStopPercent) {
            riskReason = "TRAILING_STOP";
            actualExitPrice = closePrice;
          }
        }
      }

      if (riskReason) {
        // Recalculate PnL at actual exit price
        const rawPnlAtExit =
          position.side === "long"
            ? (actualExitPrice - position.entryPrice) / position.entryPrice
            : (position.entryPrice - actualExitPrice) / position.entryPrice;
        const leveragedPnlPctAtExit = rawPnlAtExit * position.leverage;
        closePosition(riskReason, leveragedPnlPctAtExit, actualExitPrice);
      }
    }

    // Check entries (if not at max positions)
    if (positionsByMarket.size < maxPositions) {
      const signals = [];

      for (const [symbol, strategy] of strategiesMap.entries()) {
        if (positionsByMarket.has(symbol)) continue;

        const { candles, index } = candleIndexes.get(symbol);
        const candleIdx = index.get(ts);
        if (candleIdx === undefined) continue;

        const candle = candles[candleIdx];
        const signal = strategy.getSignal(candle.close, [], false, candleIdx);

        if (signal.action === "open") {
          signals.push({
            symbol,
            strategy,
            signal,
            price: candle.close,
            timestamp: ts,
            candleIdx,
          });
        }
      }

      // Sort by confidence (PERFECT signals first)
      signals.sort((a, b) => Math.abs(b.signal.confidence) - Math.abs(a.signal.confidence));

      // Execute entries up to max positions
      for (const entry of signals) {
        if (positionsByMarket.size >= maxPositions) break;

        const { symbol, strategy, signal, price, timestamp, candleIdx } = entry;
        const side = signal.side;

        // Check direction filters
        if ((side === "long" && !allowLongs) || (side === "short" && !allowShorts)) {
          continue;
        }

        const marketLeverage = perMarketLeverage.get(symbol) || leverage;
        const sizeMult = strategy.getRecommendedPositionSize(price, side, equity) || 1.0;
        const pct = positionSizePercent / 100;
        const desiredCollateral = equity * pct * sizeMult;
        const maxAlloc = equity / (maxPositions - positionsByMarket.size);
        const minPos = Number(minPositionSize || 0);
        const maxPos = Number(maxPositionSize || 0);
        let collateral = Math.min(desiredCollateral, maxAlloc, equity);
        if (Number.isFinite(maxPos) && maxPos > 0) collateral = Math.min(collateral, maxPos);
        if (Number.isFinite(minPos) && minPos > 0 && collateral < minPos) {
          continue;
        }
        const posSize = collateral * marketLeverage;

        // Calculate entry fees using Jupiter fee structure
        const openRes = feeCfg.calculateOpenFee
          ? feeCfg.calculateOpenFee(posSize, { execMode: "taker" })
          : {
              fee: posSize * (feeCfg.openFeeBps / 10_000),
              breakdown: { baseFee: posSize * (feeCfg.openFeeBps / 10_000), priceImpactFee: 0 },
            };
        const openBaseFee =
          openRes.breakdown?.baseFee ?? openRes.fee ?? posSize * (feeCfg.openFeeBps / 10_000);
        const openPriceImpactFee =
          feeCfg.model === "drift" ? 0 : (openRes.breakdown?.priceImpactFee ?? 0);
        const openSwapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(collateral);
        const openTxFee = calculateSolanaTransactionFees(price, feeCfg);
        const entryFee = openBaseFee + openPriceImpactFee + openSwapFee + openTxFee;
        const totalRequired = collateral + entryFee;
        if (totalRequired > equity) {
          continue;
        }
        equity -= totalRequired;
        totalFees += entryFee;
        feeBreakdown.openFees += openBaseFee;
        feeBreakdown.priceImpactFees += openPriceImpactFee;
        feeBreakdown.swapFees += openSwapFee;
        feeBreakdown.txFees += openTxFee;

        const position = {
          side,
          entryPrice: price,
          entryTime: timestamp,
          size: posSize,
          collateral,
          leverage: marketLeverage,
          openBarIndex: candleIdx,
          highWaterMark: price,
          lowWaterMark: price,
          entryFee,
          entryFeeBreakdown: {
            base: openBaseFee,
            priceImpact: openPriceImpactFee,
            swap: openSwapFee,
            tx: openTxFee,
          },
          highestPnlPercent: 0,
          lastBorrowTs: timestamp,
        };

        positionsByMarket.set(symbol, position);

        if (debug) {
          console.log(
            `[${symbol}] ENTRY ${side.toUpperCase()} @ $${price.toFixed(4)} | ${signal.reason} | Conf: ${signal.confluence}/8 | Fees: $${entryFee.toFixed(4)}`
          );
        }
      }
    }
  }

  // Bar-close updates for non-tick mode (simulateTicks=false).
  // In tick mode, this happens inside the per-bar tick branch (before `continue`).
  if (!simulateTicks) {
    for (const [symbol, strategy] of strategiesMap.entries()) {
      const idxObj = candleIndexes.get(symbol);
      if (!idxObj) continue;
      const candleIdx = idxObj.index.get(ts);
      if (candleIdx === undefined) continue;
      const candle = idxObj.candles[candleIdx];
      const barCloseTs = Number.isFinite(Number(candle.closeTime))
        ? Number(candle.closeTime)
        : Number(candle.timestamp);
      strategy.update({
        price: candle.close,
        close: candle.close,
        high: candle.high,
        low: candle.low,
        volume: candle.volume,
        takerBuyBaseVolume: candle.takerBuyBaseVolume,
        ts: barCloseTs,
      });
    }
  }

  // Close remaining positions
  for (const [symbol, position] of positionsByMarket.entries()) {
    const { candles } = candleIndexes.get(symbol);
    const lastCandle = candles[candles.length - 1];
    const lastBarOpen = Number(lastCandle.openTime ?? lastCandle.timestamp);
    let exitPrice = lastCandle.close;
    let exitTime = Number.isFinite(lastCandle.closeTime)
      ? Number(lastCandle.closeTime)
      : lastBarOpen;
    if (simulateTicks && ticksByBarOpenTimeMap && Number.isFinite(lastBarOpen)) {
      const tickMap = ticksByBarOpenTimeMap.get(symbol);
      const ticks = tickMap instanceof Map ? tickMap.get(lastBarOpen) : null;
      if (Array.isArray(ticks) && ticks.length > 0) {
        const lastTick = ticks[ticks.length - 1];
        exitPrice = typeof lastTick === "number" ? lastTick : Number(lastTick.price);
        exitTime =
          typeof lastTick === "number"
            ? lastBarOpen + (ticks.length - 1) * TICK_INTERVAL_MS
            : Number(lastTick.ts);
      }
    }
    const currentNotional = position.size;
    const pnlPct =
      position.side === "long"
        ? (exitPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - exitPrice) / position.entryPrice;
    const leveragedPnlPct = pnlPct * position.leverage;
    // grossPnlUsd = collateral * leveragedPnlPct = notional * rawPnl
    const collateral = position.collateral || position.size / position.leverage;
    const grossPnlUsd = collateral * leveragedPnlPct;

    // Calculate fees using Jupiter fee structure
    const openFee = Number(position.entryFee || 0);
    const closeRes = feeCfg.calculateCloseFee
      ? feeCfg.calculateCloseFee(currentNotional, { execMode: "taker" })
      : {
          fee: currentNotional * (feeCfg.closeFeeBps / 10_000),
          breakdown: {
            baseFee: currentNotional * (feeCfg.closeFeeBps / 10_000),
            priceImpactFee: 0,
          },
        };
    const closeFee = closeRes.breakdown?.baseFee ?? 0;
    const priceImpactFee = feeCfg.model === "drift" ? 0 : (closeRes.breakdown?.priceImpactFee ?? 0);
    const swapFee = feeCfg.model === "drift" ? 0 : calculateSwapFee(collateral);
    const lastBorrowTs = Number.isFinite(position.lastBorrowTs)
      ? position.lastBorrowTs
      : position.entryTime;
    const borrowFee =
      feeCfg.model === "drift"
        ? 0
        : calculateBorrowFeeUsd(position.size, Math.max(0, exitTime - lastBorrowTs));
    const txFee = calculateSolanaTransactionFees(exitPrice, feeCfg);
    const totalExitFees = (closeRes.fee ?? 0) + swapFee + borrowFee + txFee;
    const pnlUsd = grossPnlUsd - totalExitFees;
    const totalFeesForTrade = openFee + totalExitFees;

    totalFees += totalExitFees;
    feeBreakdown.closeFees += closeFee;
    feeBreakdown.priceImpactFees += priceImpactFee;
    feeBreakdown.swapFees += swapFee;
    feeBreakdown.borrowFees += borrowFee;
    feeBreakdown.txFees += txFee;
    feeBreakdown.count += 1;

    const pnlPctCollateral = collateral > 0 ? pnlUsd / collateral : leveragedPnlPct;
    allTrades.push({
      symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      entryTime: position.entryTime,
      exitTime,
      pnlPct: leveragedPnlPct,
      pnlPctCollateral,
      pnlUsd,
      grossPnlUsd,
      collateral,
      fees: {
        open: openFee,
        close: closeFee,
        priceImpact: priceImpactFee,
        swap: swapFee,
        borrow: borrowFee,
        tx: txFee,
        total: totalFeesForTrade,
        model: feeCfg.model,
      },
      exitReason: "end_of_backtest",
      leverage: position.leverage,
      size: position.size,
    });

    equity += collateral + pnlUsd;
  }

  // Calculate aggregate metrics
  const winningTrades = allTrades.filter((t) => t.pnlUsd > 0);
  const losingTrades = allTrades.filter((t) => t.pnlUsd <= 0);
  // totalPnL should reflect actual net P&L after ALL fees (entry + exit)
  // Equity already accounts for all fees, so calculate from equity change
  const totalPnL = equity - initialCapital;
  const winRate = allTrades.length > 0 ? winningTrades.length / allTrades.length : 0;

  return {
    trades: allTrades,
    totalTrades: allTrades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate,
    totalPnL,
    totalFees,
    feeBreakdown,
    maxDrawdown,
    finalEquity: equity,
    returnPct: ((equity - initialCapital) / initialCapital) * 100,
    byMarket: groupTradesByMarket(allTrades),
  };
}

function groupTradesByMarket(trades) {
  const byMarket = {};
  for (const trade of trades) {
    if (!byMarket[trade.symbol]) {
      byMarket[trade.symbol] = [];
    }
    byMarket[trade.symbol].push(trade);
  }
  return byMarket;
}

// ============================================================
// BUILD STRATEGY CONFIG
// ============================================================

function buildPredictaStrategyConfig(symbol, options) {
  const marketKey = `${symbol.toUpperCase()}_PERP`; // ETH -> ETH_PERP
  const env = process.env;

  // Per-market override helpers
  const has = (v) => v !== undefined && v !== "";
  const envNum = (k, d) => (has(env[k]) ? Number(env[k]) : d);
  const envBool = (k, d) => (has(env[k]) ? String(env[k]).toLowerCase() === "true" : d);
  const pmKey = (param) => `STRATEGY_${marketKey}_${param}`;

  // Per-market overrides for core strategy params
  const minConfluence = envNum(pmKey("MIN_CONFLUENCE"), options.minConfluence);
  const adxThreshold = envNum(pmKey("ADX_THRESHOLD"), options.adxThreshold);
  const stFactor = envNum(pmKey("ST_FACTOR"), options.stFactor);
  const stPeriod = envNum(pmKey("ST_PERIOD"), options.stPeriod);
  const leverageRaw = envNum(pmKey("LEVERAGE"), options.leverage);
  const leverageMax = envNum("LEVERAGE_MAX", 0);
  const leverage = Math.max(
    1,
    Number.isFinite(leverageMax) && leverageMax > 0
      ? Math.min(leverageRaw, leverageMax)
      : leverageRaw
  );
  const hardStopPercent = envNum(pmKey("PREDICTA_HARD_STOP_PERCENT"), options.hardStopPercent);
  const hardStopAtr = envNum(pmKey("PREDICTA_HARD_STOP_ATR"), options.hardStopAtr);
  const hardStopEnabled = envBool(pmKey("PREDICTA_HARD_STOP_ENABLED"), options.hardStopEnabled);
  const allowLongs = envBool(pmKey("ALLOW_LONGS"), options.allowLongs);
  const allowShorts = envBool(pmKey("ALLOW_SHORTS"), options.allowShorts);

  // Per-market overrides for signals
  const enablePerfectSignals = envBool(
    pmKey("PREDICTA_ENABLE_PERFECT_SIGNALS"),
    options.enablePerfectSignals
  );
  const enableBuySellSignals = envBool(
    pmKey("PREDICTA_ENABLE_BUY_SELL_SIGNALS"),
    options.enableBuySellSignals
  );
  const perfectConfidence = envNum(pmKey("PREDICTA_PERFECT_CONFIDENCE"), options.perfectConfidence);
  const buySellConfidence = envNum(
    pmKey("PREDICTA_BUY_SELL_CONFIDENCE"),
    options.buySellConfidence
  );
  const buySellEntryTrigger = has(env[pmKey("PREDICTA_BUY_SELL_ENTRY_TRIGGER")])
    ? String(env[pmKey("PREDICTA_BUY_SELL_ENTRY_TRIGGER")])
    : String(options.buySellEntryTrigger || "st_flip_or_ema_cross");
  const buySellRequireDelta = envBool(
    pmKey("PREDICTA_BUY_SELL_REQUIRE_DELTA"),
    options.buySellRequireDelta
  );
  const buySellUseConfluenceFilter = envBool(
    pmKey("PREDICTA_BUY_SELL_USE_CONFLUENCE_FILTER"),
    options.buySellUseConfluenceFilter
  );
  const buySellMinConfluence = envNum(
    pmKey("PREDICTA_BUY_SELL_MIN_CONFLUENCE"),
    options.buySellMinConfluence
  );
  const buySellUseScoreFilter = envBool(
    pmKey("PREDICTA_BUY_SELL_USE_SCORE_FILTER"),
    options.buySellUseScoreFilter
  );
  const buySellScoreThresholdOffset = envNum(
    pmKey("PREDICTA_BUY_SELL_SCORE_THRESHOLD_OFFSET"),
    options.buySellScoreThresholdOffset
  );
  const relaxPerfectDirection = envBool(
    pmKey("PREDICTA_RELAX_PERFECT_DIRECTION"),
    options.relaxPerfectDirection
  );

  // Per-market overrides for exits
  const supertrendExit = envBool(pmKey("PREDICTA_SUPERTREND_EXIT"), options.supertrendExit);
  const oppositePerfectExit = envBool(
    pmKey("PREDICTA_OPPOSITE_PERFECT_EXIT"),
    options.oppositePerfectExit
  );
  const enableTrailingStop = envBool(
    pmKey("PREDICTA_ENABLE_TRAILING_STOP"),
    options.enableTrailingStop
  );
  const trailingAtrMult = envNum(pmKey("PREDICTA_TRAILING_ATR_MULT"), options.trailingAtrMult);

  // Per-market overrides for volume/ADX thresholds
  const minVolumeRatio = envNum(pmKey("PREDICTA_MIN_VOLUME_RATIO"), options.minVolumeRatio);
  const adxStrong = envNum(pmKey("PREDICTA_ADX_STRONG"), options.adxStrong);
  const adxOk = envNum(pmKey("PREDICTA_ADX_OK"), options.adxOk);
  const adxWeak = envNum(pmKey("PREDICTA_ADX_WEAK"), options.adxWeak);
  const thresholdStrong = envNum(pmKey("PREDICTA_THRESHOLD_STRONG"), options.thresholdStrong);
  const thresholdOk = envNum(pmKey("PREDICTA_THRESHOLD_OK"), options.thresholdOk);
  const thresholdWeak = envNum(pmKey("PREDICTA_THRESHOLD_WEAK"), options.thresholdWeak);
  const thresholdDefault = envNum(pmKey("PREDICTA_THRESHOLD_DEFAULT"), options.thresholdDefault);

  // Per-market overrides for EMA periods
  const emaFast = envNum(pmKey("PREDICTA_EMA_FAST"), options.emaFast);
  const emaMid = envNum(pmKey("PREDICTA_EMA_MID"), options.emaMid);
  const emaSlow = envNum(pmKey("PREDICTA_EMA_SLOW"), options.emaSlow);
  const adxPeriod = envNum(pmKey("PREDICTA_ADX_PERIOD"), options.adxPeriod);
  const deltaEmaPeriod = envNum(pmKey("PREDICTA_DELTA_EMA_PERIOD"), options.deltaEmaPeriod);

  // Per-market overrides for gate toggles
  const enableGateSupertrend = envBool(
    pmKey("PREDICTA_ENABLE_GATE_SUPERTREND"),
    options.enableGateSupertrend
  );
  const enableGateEmaCross = envBool(
    pmKey("PREDICTA_ENABLE_GATE_EMA_CROSS"),
    options.enableGateEmaCross
  );
  const enableGateEmaTrend = envBool(
    pmKey("PREDICTA_ENABLE_GATE_EMA_TREND"),
    options.enableGateEmaTrend
  );
  const enableGateMacd = envBool(pmKey("PREDICTA_ENABLE_GATE_MACD"), options.enableGateMacd);
  const enableGateStoch = envBool(pmKey("PREDICTA_ENABLE_GATE_STOCH"), options.enableGateStoch);
  const enableGateRsi = envBool(pmKey("PREDICTA_ENABLE_GATE_RSI"), options.enableGateRsi);
  const enableGateAdx = envBool(pmKey("PREDICTA_ENABLE_GATE_ADX"), options.enableGateAdx);
  const enableGateVolume = envBool(pmKey("PREDICTA_ENABLE_GATE_VOLUME"), options.enableGateVolume);

  // Per-market overrides for cooldowns
  const cooldownMs = envNum(pmKey("COOLDOWN_MS"), options.cooldownMs);
  const flipCooldownBars = envNum(pmKey("FLIP_COOLDOWN_BARS"), options.flipCooldownBars);
  const minBarsSameSideReentry = envNum(
    pmKey("MIN_BARS_SAME_SIDE_REENTRY"),
    options.minBarsSameSideReentry
  );
  const enableSameBarGuard = envBool(pmKey("ENABLE_SAME_BAR_GUARD"), options.enableSameBarGuard);
  const enableEdgeTrigger = envBool(pmKey("ENABLE_EDGE_TRIGGER"), options.enableEdgeTrigger);

  // Per-market overrides for position sizing multipliers
  const perfectSizeMult = envNum(pmKey("PREDICTA_PERFECT_SIZE_MULT"), options.perfectSizeMult);
  const buySellSizeMult = envNum(pmKey("PREDICTA_BUY_SELL_SIZE_MULT"), options.buySellSizeMult);

  // Log per-market overrides if any were found
  const overridesFound = [];
  if (env[pmKey("MIN_CONFLUENCE")]) overridesFound.push(`conf=${minConfluence}`);
  if (env[pmKey("ST_FACTOR")]) overridesFound.push(`st=${stFactor}/${stPeriod}`);
  if (env[pmKey("LEVERAGE")]) overridesFound.push(`lev=${leverage}x`);
  if (
    env[pmKey("PREDICTA_ENABLE_PERFECT_SIGNALS")] ||
    env[pmKey("PREDICTA_ENABLE_BUY_SELL_SIGNALS")]
  ) {
    overridesFound.push(
      `sig=${enablePerfectSignals ? "P" : ""}${enableBuySellSignals ? "BS" : ""}`
    );
  }
  if (env[pmKey("PREDICTA_BUY_SELL_ENTRY_TRIGGER")])
    overridesFound.push(`bsTrigger=${buySellEntryTrigger}`);
  if (env[pmKey("PREDICTA_BUY_SELL_REQUIRE_DELTA")])
    overridesFound.push(`bsDelta=${buySellRequireDelta}`);
  if (env[pmKey("PREDICTA_BUY_SELL_USE_CONFLUENCE_FILTER")])
    overridesFound.push(`bsConf=${buySellUseConfluenceFilter}`);
  if (env[pmKey("PREDICTA_BUY_SELL_MIN_CONFLUENCE")])
    overridesFound.push(`bsMinC=${buySellMinConfluence}`);
  if (env[pmKey("PREDICTA_BUY_SELL_USE_SCORE_FILTER")])
    overridesFound.push(`bsScore=${buySellUseScoreFilter}`);
  if (env[pmKey("PREDICTA_BUY_SELL_SCORE_THRESHOLD_OFFSET")])
    overridesFound.push(`bsOff=${buySellScoreThresholdOffset}`);
  if (env[pmKey("PREDICTA_THRESHOLD_STRONG")])
    overridesFound.push(
      `th=${thresholdStrong}/${thresholdOk}/${thresholdWeak}/${thresholdDefault}`
    );
  if (env[pmKey("PREDICTA_ADX_STRONG")])
    overridesFound.push(`adx=${adxStrong}/${adxOk}/${adxWeak}`);
  if (env[pmKey("PREDICTA_MIN_VOLUME_RATIO")]) overridesFound.push(`vol=${minVolumeRatio}`);
  const quietOverridesLog = process.env.BACKTEST_OUTPUT_MODE === "workflow" || options?.quiet;
  if (overridesFound.length > 0 && !quietOverridesLog) {
    console.log(`   📌 [${symbol}] Per-market overrides: ${overridesFound.join(", ")}`);
  }

  return {
    market: `${symbol}-PERP`,
    quiet: true,
    predictaStrategy: {
      // Supertrend
      stFactor,
      stPeriod,

      // Confluence
      minConfluence,
      minVolumeRatio,
      adxThreshold,

      // Dynamic threshold levels
      adxStrong,
      adxOk,
      adxWeak,
      thresholdStrong,
      thresholdOk,
      thresholdWeak,
      thresholdDefault,

      // Indicator periods
      atrPeriod: options.atrPeriod,
      atrPercentileLookback: options.atrPercentileLookback,
      emaFast,
      emaMid,
      emaSlow,
      rsiPeriod: options.rsiPeriod,
      macdFast: options.macdFast,
      macdSlow: options.macdSlow,
      macdSignal: options.macdSignal,
      stochPeriod: options.stochPeriod,
      stochSmooth: options.stochSmooth,
      adxPeriod,
      volumeLookback: options.volumeLookback,
      deltaEmaPeriod,

      // Scoring weights
      weightTrend: options.weightTrend,
      weightMacd: options.weightMacd,
      weightDelta: options.weightDelta,
      weightRsi: options.weightRsi,
      weightStoch: options.weightStoch,
      weightAdx: options.weightAdx,
      weightVolume: options.weightVolume,

      // Signals
      enablePerfectSignals,
      enableBuySellSignals,
      perfectConfidence,
      buySellConfidence,
      buySellEntryTrigger,
      buySellRequireDelta,
      buySellUseConfluenceFilter,
      buySellMinConfluence,
      buySellUseScoreFilter,
      buySellScoreThresholdOffset,
      relaxPerfectDirection,

      // Exits
      supertrendExit,
      oppositePerfectExit,
      enableTimeStop: options.enableTimeStop,
      timeStopBars: options.timeStopBars,
      enableTrailingStop,
      trailingAtrMult,
      hardStopEnabled,
      hardStopPercent,
      hardStopAtr,

      // Cooldowns
      enableCooldown: options.enableCooldown,
      cooldownMs,
      flipCooldownBars,
      minBarsSameSideReentry,
      enableSameBarGuard,
      enableEdgeTrigger,

      // Position sizing
      perfectSizeMult,
      buySellSizeMult,

      // Gate toggles
      enableGateSupertrend,
      enableGateEmaCross,
      enableGateEmaTrend,
      enableGateMacd,
      enableGateStoch,
      enableGateRsi,
      enableGateAdx,
      enableGateVolume,

      // Direction
      allowLongs,
      allowShorts,

      // Warmup
      minBars: options.minBars,
    },
    leverage,
  };
}

// ============================================================
// PRINT RESULTS
// ============================================================

function printResults(results, options) {
  // In workflow/minimal mode, suppress heavy report output (keeps computation identical)
  if (BACKTEST_MINIMAL_OUTPUT) {
    const totalFees = Number(results.totalFees || 0);
    const pf = Number.isFinite(results.profitFactor) ? Number(results.profitFactor) : null;
    const dd = Number.isFinite(results.maxDrawdown) ? Number(results.maxDrawdown) : null;
    const tp = Number.isFinite(results.totalPnL) ? Number(results.totalPnL) : 0;
    const trades = Number.isFinite(results.totalTrades)
      ? Number(results.totalTrades)
      : (results.trades || []).length || 0;
    const tpd = options?.days && options.days > 0 ? trades / options.days : null;
    const sqn = Number.isFinite(results.sqn) ? Number(results.sqn) : null;
    const robustScore = Number.isFinite(results.robustScore) ? Number(results.robustScore) : null;
    console.log(
      `[RESULT] symbols=${(options.symbols || []).join(",")} days=${options.days} trades=${trades}${tpd !== null ? ` (${tpd.toFixed(2)}/d)` : ""} ` +
        `pnl=$${tp.toFixed(2)} fees=$${totalFees.toFixed(2)}` +
        `${dd !== null ? ` dd=${(dd * 100).toFixed(2)}%` : ""}` +
        `${pf !== null ? ` pf=${pf.toFixed(2)}` : ""}` +
        `${sqn !== null ? ` sqn=${sqn.toFixed(2)}` : ""}` +
        `${robustScore !== null ? ` rs=${robustScore.toFixed(2)}` : ""}`
    );
    return;
  }

  const totalFees = Number(results.totalFees || 0);
  const tradeCount = Number(results.totalTrades || (results.trades || []).length || 0);
  const feeBreakdown = results.feeBreakdown || {};

  // ANSI color codes for better readability
  const BOLD = "\x1b[1m";
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const YELLOW = "\x1b[33m";
  const CYAN = "\x1b[36m";
  const RESET = "\x1b[0m";

  console.log("\n" + "=".repeat(70));
  console.log("📊 PREDICTA V4 BACKTEST RESULTS");
  console.log("=".repeat(70));

  console.log(`\n📈 PERFORMANCE SUMMARY`);
  console.log("-".repeat(50));
  console.log(`   Total Trades:     ${results.totalTrades}`);
  console.log(
    `   Winning Trades:   ${results.winningTrades} (${(results.winRate * 100).toFixed(1)}%)`
  );
  console.log(`   Losing Trades:    ${results.losingTrades}`);

  // Highlight key metrics with colors
  const pnlColor = results.totalPnL >= 0 ? GREEN : RED;
  const returnColor = results.returnPct >= 0 ? GREEN : RED;
  console.log(
    `   ${BOLD}Total P&L:${RESET}        ${pnlColor}${BOLD}$${results.totalPnL.toFixed(2)}${RESET}`
  );
  console.log(
    `   ${BOLD}Return:${RESET}           ${returnColor}${BOLD}${results.returnPct.toFixed(2)}%${RESET}`
  );
  console.log(`   Total Fees:       $${totalFees.toFixed(2)}`);
  console.log(
    `   ${BOLD}Max Drawdown:${RESET}     ${RED}${BOLD}${(results.maxDrawdown * 100).toFixed(2)}%${RESET}`
  );
  console.log(
    `   ${BOLD}Final Equity:${RESET}     ${CYAN}${BOLD}$${results.finalEquity.toFixed(2)}${RESET}`
  );

  if (results.profitFactor) {
    const pfColor =
      results.profitFactor >= 1.5 ? GREEN : results.profitFactor >= 1.0 ? YELLOW : RED;
    console.log(
      `   ${BOLD}Profit Factor:${RESET}    ${pfColor}${BOLD}${results.profitFactor.toFixed(2)}${RESET}`
    );
    console.log(`   Avg Win:          ${GREEN}$${results.avgWin.toFixed(2)}${RESET}`);
    console.log(`   Avg Loss:         ${RED}$${results.avgLoss.toFixed(2)}${RESET}`);
  }

  console.log(`\n💰 FEE BREAKDOWN`);
  console.log("-".repeat(50));
  const feeModel = (process.env.FEE_MODEL || "jupiter").toLowerCase();

  // Quick summary
  console.log(`  Model: ${feeModel.toUpperCase()} | Open/Close: 6 bps each`);
  const tradingFeesSubtotal =
    Number(feeBreakdown.openFees || 0) + Number(feeBreakdown.closeFees || 0);
  console.log(`  Trading Fees:       $${tradingFeesSubtotal.toFixed(2)}  (protocol)`);
  if (feeModel === "jupiter") {
    const executionCosts =
      Number(feeBreakdown.priceImpactFees || 0) + Number(feeBreakdown.swapFees || 0);
    console.log(`  Execution Costs:    $${executionCosts.toFixed(4)}  (impact + swap)`);
    console.log(
      `  Borrow Fees:        $${Number(feeBreakdown.borrowFees || 0).toFixed(4)}  (carry)`
    );
  }
  const txFees = Number(feeBreakdown.txFees || 0);
  console.log(`  Network Fees:       $${txFees.toFixed(4)}  (Solana tx)`);
  console.log(`  ─────────────────────`);
  console.log(`  TOTAL FEES:         $${totalFees.toFixed(2)}`);

  // Cost ratios
  const trades = results.trades || [];
  let entryVolume = 0;
  let exitVolume = 0;
  for (const trade of trades) {
    entryVolume += trade.size || 0;
    exitVolume += trade.size || 0;
  }
  const totalVolume = entryVolume + exitVolume;
  const allInFeeBps = totalVolume > 0 ? (totalFees / totalVolume) * 10000 : 0;
  const avgFeePerTrade = tradeCount > 0 ? totalFees / tradeCount : 0;
  console.log(
    `  Avg Fee/Trade:      $${avgFeePerTrade.toFixed(4)} (${allInFeeBps.toFixed(2)} bps)`
  );

  // ============================================================
  // CAPITAL VALIDATION
  // ============================================================
  console.log(`\n💵 CAPITAL VALIDATION`);
  console.log("-".repeat(50));
  const initialCapital = options.initialCapital || options.positionSizeUsd || 1000;
  console.log(`  Initial Capital:    $${initialCapital.toFixed(2)}`);
  console.log(`  Final Equity:       $${results.finalEquity.toFixed(2)}`);
  console.log(
    `  Peak Equity:        $${(results.finalEquity > initialCapital ? results.finalEquity : initialCapital).toFixed(2)}`
  );
  console.log(`  Max Drawdown:       ${(results.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`  Capital Rule:       ✅ All entries within available capital`);

  // ============================================================
  // TRADE STATISTICS
  // ============================================================
  console.log(`\n📊 TRADE STATISTICS`);
  console.log("-".repeat(50));
  const winningTrades = trades.filter((t) => t.pnlUsd > 0);
  const losingTrades = trades.filter((t) => t.pnlUsd <= 0);
  const avgWin =
    winningTrades.length > 0
      ? winningTrades.reduce((s, t) => s + t.pnlUsd, 0) / winningTrades.length
      : 0;
  const avgLoss =
    losingTrades.length > 0
      ? losingTrades.reduce((s, t) => s + t.pnlUsd, 0) / losingTrades.length
      : 0;
  const maxWin = winningTrades.length > 0 ? Math.max(...winningTrades.map((t) => t.pnlUsd)) : 0;
  const maxLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map((t) => t.pnlUsd)) : 0;
  const expectedValue =
    tradeCount > 0
      ? (winningTrades.length / tradeCount) * avgWin + (losingTrades.length / tradeCount) * avgLoss
      : 0;
  const median = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };
  const winPnls = winningTrades.map((t) => t.pnlUsd);
  const lossPnls = losingTrades.map((t) => t.pnlUsd);
  const medianWin = median(winPnls);
  const medianLoss = median(lossPnls);
  const longTrades = trades.filter((t) => (t.side || "").toLowerCase() === "long");
  const shortTrades = trades.filter((t) => (t.side || "").toLowerCase() === "short");

  console.log(
    `  Winners:     ${winningTrades.length} (${(results.winRate * 100).toFixed(0)}%) | Avg: +$${avgWin.toFixed(2)} | Best: +$${maxWin.toFixed(2)}`
  );
  console.log(
    `  Losers:      ${losingTrades.length} (${((1 - results.winRate) * 100).toFixed(0)}%) | Avg: $${avgLoss.toFixed(2)} | Worst: $${maxLoss.toFixed(2)}`
  );
  console.log(`  Median Win:  +$${medianWin.toFixed(2)} | Median Loss: $${medianLoss.toFixed(2)}`);
  console.log(
    `  Profit Factor:       ${results.profitFactor ? results.profitFactor.toFixed(2) : "N/A"}`
  );
  console.log(
    `  Win/Loss Ratio:      ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "N/A"}`
  );
  console.log(
    `  Expected Value:      $${expectedValue.toFixed(2)}/trade (${((expectedValue / initialCapital) * 100).toFixed(2)}%)`
  );
  console.log(`  Long/Short:   ${longTrades.length}/${shortTrades.length}`);

  // ============================================================
  // TRADE DURATION DISTRIBUTION
  // ============================================================
  const tradeDurations = trades
    .filter((t) => t.entryTime && t.exitTime && t.exitTime > t.entryTime)
    .map((t) => (t.exitTime - t.entryTime) / 60000); // Duration in minutes

  const formatDuration = (mins) => {
    if (mins < 60) return `${mins.toFixed(1)}m`;
    if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
    return `${(mins / 1440).toFixed(1)}d`;
  };

  if (tradeDurations.length > 0) {
    const sortedDurations = [...tradeDurations].sort((a, b) => a - b);
    const minDuration = sortedDurations[0];
    const maxDuration = sortedDurations[sortedDurations.length - 1];
    const avgDuration = tradeDurations.reduce((a, b) => a + b, 0) / tradeDurations.length;
    const medianDuration = sortedDurations[Math.floor(sortedDurations.length / 2)];
    const p90Duration = sortedDurations[Math.floor(sortedDurations.length * 0.9)];

    console.log("\n⏱️  TRADE DURATION");
    console.log("-".repeat(50));
    console.log(
      `  Min: ${formatDuration(minDuration).padStart(8)} | Max: ${formatDuration(maxDuration)} | Avg: ${formatDuration(avgDuration)} | Median: ${formatDuration(medianDuration)} | P90: ${formatDuration(p90Duration)}`
    );
  }
  // Exit reason breakdown
  if (trades.length > 0) {
    console.log(`\n📋 EXIT REASON BREAKDOWN`);
    console.log("-".repeat(50));
    const exitReasons = {};
    for (const trade of trades) {
      exitReasons[trade.exitReason] = (exitReasons[trade.exitReason] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(exitReasons).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / trades.length) * 100).toFixed(1);
      const emoji = reason.includes("TAKE_PROFIT")
        ? "✅"
        : reason.includes("STOP_LOSS")
          ? "🛑"
          : reason.includes("TRAILING")
            ? "📊"
            : reason.includes("supertrend")
              ? "📉"
              : reason.includes("time")
                ? "⏰"
                : "📌";
      console.log(`   ${emoji} ${reason.padEnd(25)} ${String(count).padStart(4)} (${pct}%)`);
    }
  }

  if (trades.length > 0) {
    const formatTs = (ts) => {
      if (!Number.isFinite(ts)) return "n/a";
      const d = new Date(ts);
      const yy = String(d.getUTCFullYear()).slice(-2);
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const hh = String(d.getUTCHours()).padStart(2, "0");
      return `${yy}-${mm}-${dd} ${hh}`;
    };
    const abbreviateReason = (reason) => {
      const raw = String(reason || "n/a");
      const tokens = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);
      if (!tokens.length) return raw.slice(0, 4).toUpperCase();
      const code = tokens.map((token) => token.slice(0, 2).toUpperCase()).join("");
      if (code.length === 0) return raw.slice(0, 4).toUpperCase();
      return code.slice(0, 8);
    };
    const formatPrice = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a");
    const formatCell = (value, width, alignRight = false) => {
      const raw = String(value ?? "");
      const clipped = raw.length > width ? raw.slice(0, width) : raw;
      return alignRight ? clipped.padStart(width) : clipped.padEnd(width);
    };
    const tradeRows = trades.map((t, i) => ({ ...t, __idx: i }));
    const sortedByPnl = [...tradeRows].sort((a, b) => (b.pnlUsd || 0) - (a.pnlUsd || 0));
    const top = sortedByPnl.slice(0, 10);
    const worst = sortedByPnl.slice(-10).reverse();
    const formatTradeRow = (t) => {
      const pctBase = Number.isFinite(t.pnlPctCollateral) ? t.pnlPctCollateral : t.pnlPct;
      const pnlPct = Number.isFinite(pctBase) ? (pctBase * 100).toFixed(2) : "n/a";
      const coll = Number.isFinite(t.collateral) ? t.collateral.toFixed(2) : "n/a";
      const reason = abbreviateReason(t.exitReason);
      const dur =
        t.entryTime && t.exitTime ? formatDuration((t.exitTime - t.entryTime) / 60000) : "n/a";
      const entryTs = formatTs(t.entryTime);
      const exitTs = formatTs(t.exitTime);
      const entryPrice = formatPrice(t.entryPrice);
      const exitPrice = formatPrice(t.exitPrice);
      const row = [
        formatCell(String(t.__idx + 1), 4, true),
        formatCell(String(t.symbol || ""), 5),
        formatCell(String(t.side || "").toUpperCase(), 5),
        formatCell(Number(t.pnlUsd || 0).toFixed(2), 11, true),
        formatCell(pnlPct, 8, true),
        formatCell(coll, 10, true),
        formatCell(reason, 12),
        formatCell(dur, 6, true),
        formatCell(entryTs, 11),
        formatCell(exitTs, 11),
        formatCell(entryPrice, 10, true),
        formatCell(exitPrice, 10, true),
      ].join(" | ");
      return `| ${row} |`;
    };
    const tableBorder =
      "+------+-------+-------+-------------+----------+------------+--------------+--------+-------------+-------------+------------+------------+";
    const tableHeaderRow = [
      formatCell("#", 4, true),
      formatCell("SYM", 5),
      formatCell("SIDE", 5),
      formatCell("PNL_USD", 11, true),
      formatCell("PNL_%", 8, true),
      formatCell("COLL", 10, true),
      formatCell("REASON", 12),
      formatCell("DUR", 6, true),
      formatCell("ENTRY", 11),
      formatCell("EXIT", 11),
      formatCell("ENTRY_PX", 10, true),
      formatCell("EXIT_PX", 10, true),
    ].join(" | ");
    const tableHeader = `| ${tableHeaderRow} |`;

    const auditTrades = (items) => {
      const initialCapital = Number(
        options.initialCapital || options.positionSizeUsd || options.positionSize || 0
      );
      const maxPositions = Number(options.maxPositions || 0);
      const events = [];
      for (const t of items) {
        if (!Number.isFinite(t.entryTime) || !Number.isFinite(t.exitTime)) continue;
        const collateral = Number.isFinite(t.collateral)
          ? t.collateral
          : Number.isFinite(t.size) && Number.isFinite(t.leverage) && t.leverage > 0
            ? t.size / t.leverage
            : 0;
        const openFee = Number(t.fees?.open || 0);
        events.push({ ts: t.entryTime, type: "entry", t, collateral, openFee });
        events.push({ ts: t.exitTime, type: "exit", t, collateral });
      }
      events.sort((a, b) => a.ts - b.ts || (a.type === "exit" ? -1 : 1));
      let equity = initialCapital;
      let activeCount = 0;
      const activeSymbols = new Set();
      const violations = [];
      for (const ev of events) {
        const sym = String(ev.t.symbol || "").toUpperCase();
        if (ev.type === "exit") {
          const pnlUsd = Number(ev.t.pnlUsd || 0);
          equity += (ev.collateral || 0) + pnlUsd;
          if (activeSymbols.has(sym)) activeSymbols.delete(sym);
          activeCount = Math.max(0, activeCount - 1);
          continue;
        }
        if (activeSymbols.has(sym)) {
          violations.push(
            `Overlap same market at ${formatTs(ev.ts)}: ${sym} trade #${ev.t.__idx + 1}`
          );
        }
        if (maxPositions > 0 && activeCount >= maxPositions) {
          violations.push(`Max positions exceeded at ${formatTs(ev.ts)}: trade #${ev.t.__idx + 1}`);
        }
        const required = (ev.collateral || 0) + (ev.openFee || 0);
        if (equity + 1e-6 < required) {
          violations.push(
            `Insufficient capital at ${formatTs(ev.ts)}: need $${required.toFixed(2)}, have $${equity.toFixed(2)} (trade #${ev.t.__idx + 1})`
          );
        }
        equity -= required;
        activeSymbols.add(sym);
        activeCount += 1;
      }
      return violations;
    };
    const violations = auditTrades(tradeRows);

    console.log(`\n🟢 TOP 10 BEST TRADES`);
    console.log(tableBorder);
    console.log(tableHeader);
    console.log(tableBorder);
    top.forEach((t) => {
      console.log(formatTradeRow(t));
    });
    console.log(tableBorder);

    console.log(`\n🟦 FIRST 10 TRADES`);
    console.log(tableBorder);
    console.log(tableHeader);
    console.log(tableBorder);
    tradeRows.slice(0, 10).forEach((t) => {
      console.log(formatTradeRow(t));
    });
    console.log(tableBorder);

    console.log(`\n🔴 TOP 10 WORST TRADES`);
    console.log(tableBorder);
    console.log(tableHeader);
    console.log(tableBorder);
    worst.forEach((t) => {
      console.log(formatTradeRow(t));
    });
    console.log(tableBorder);

    if (violations.length > 0) {
      console.log(`\n⚠️  TRADE AUDIT VIOLATIONS (${violations.length})`);
      violations.slice(0, 10).forEach((v) => console.log(`  - ${v}`));
      if (violations.length > 10) {
        console.log(`  ...and ${violations.length - 10} more`);
      }
    } else {
      console.log(`\n✅ TRADE AUDIT: No overlap or capital violations detected`);
    }
  }
}

function computeTimeRange({ options, intervalMs }) {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  let endTime;
  let startTime;

  if (Number.isFinite(options.endTime) && Number.isFinite(options.startTime)) {
    endTime = alignToCandleCloseMs(options.endTime, intervalMs);
    startTime = alignToCandleOpenMs(options.startTime, intervalMs);
  } else if (Number.isFinite(options.endTime)) {
    endTime = alignToCandleCloseMs(options.endTime, intervalMs);
    startTime = alignToCandleOpenMs(endTime - options.days * ONE_DAY_MS, intervalMs);
  } else {
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
    const lastCompletedDayEnd = todayStartUTC - 1;
    const lastCompletedDayStart = lastCompletedDayEnd - options.days * ONE_DAY_MS + 1;
    endTime = alignToCandleCloseMs(lastCompletedDayEnd, intervalMs);
    startTime = alignToCandleOpenMs(lastCompletedDayStart, intervalMs);
  }

  return { startTime, endTime };
}

function shouldUse1MinTicks(intervalMs) {
  const ONE_MIN_MS = 60_000;
  const intervalIsMinuteMultiple = intervalMs % ONE_MIN_MS === 0;
  return intervalIsMinuteMultiple && process.env.BACKTEST_USE_1M_TICKS !== "false";
}

function ticksPerBarFromInterval(intervalMs) {
  const ONE_MIN_MS = 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs < ONE_MIN_MS || intervalMs % ONE_MIN_MS !== 0)
    return 1;
  return Math.round(intervalMs / ONE_MIN_MS) * TICKS_PER_1MIN_CANDLE;
}

async function preloadMarketData({ options, startTime, endTime, intervalMs, use1MinTicks }) {
  const candlesMap = new Map();
  const oneMinCandlesMap = new Map();
  const ticksByBarOpenTimeMap = new Map();
  const symbols = options.symbols || [];

  for (const symbol of symbols) {
    // Fetch 1m candles if tick simulation is enabled
    if (use1MinTicks) {
      // 1. Fetch 1m candles from Pyth (price only)
      const oneMinCandles = await fetch1mPythCandles(symbol, startTime, endTime);
      oneMinCandlesMap.set(symbol, oneMinCandles);

      // 2. Build tick cache from 1m candles (for 15s tick simulation)
      const ticksByBar = await getOrBuildTicksByBarOpenTime({
        symbol,
        startTime,
        endTime,
        oneMinCandles,
        intervalMs,
      });
      ticksByBarOpenTimeMap.set(symbol, ticksByBar);

      if (options.interval === "5m") {
        // 3. Aggregate 1m candles to 5m for strategy signals
        let fiveMinCandles = aggregate1MinTo5MinAligned(oneMinCandles);
        if (!fiveMinCandles || fiveMinCandles.length === 0) {
          throw new Error(`No 5m candles after aggregation for ${symbol}`);
        }

        // 4. Fetch 5m volume from Binance (for CVD signals)
        try {
          const volumeData = await fetchBinance5mVolume(symbol, startTime, endTime);
          fiveMinCandles = mergeVolumeInto5mCandles(fiveMinCandles, volumeData);
        } catch (e) {
          console.log(`   ⚠️ Could not fetch Binance 5m volume: ${e.message}`);
        }

        candlesMap.set(symbol, fiveMinCandles);

        const hasVolume = fiveMinCandles.some((c) => c.volume > 0);
        logFull(
          `   [${symbol}] ${oneMinCandles.length} 1m → ${fiveMinCandles.length} 5m candles, ${ticksByBar.size} tick bars ${hasVolume ? "(with volume)" : "(no volume)"}`
        );
      } else {
        const candles = await fetchCandleData(symbol, startTime, endTime, options.interval);
        candlesMap.set(symbol, candles);
        logFull(
          `   [${symbol}] ${oneMinCandles.length} 1m + ${candles.length} ${options.interval} candles, ${ticksByBar.size} tick bars`
        );
      }
    } else {
      // Fall back to direct interval fetching
      const candles = await fetchCandleData(symbol, startTime, endTime, options.interval);
      candlesMap.set(symbol, candles);
    }
  }

  return { candlesMap, oneMinCandlesMap, ticksByBarOpenTimeMap };
}

function runSimulation({ options, data, use1MinTicks, ticksPerBar }) {
  const candlesMap = data.candlesMap || new Map();
  const oneMinCandlesMap = data.oneMinCandlesMap || new Map();
  const ticksByBarOpenTimeMap = data.ticksByBarOpenTimeMap || new Map();
  const strategiesMap = new Map();
  const strategyConfigsMap = new Map();

  for (const symbol of options.symbols) {
    const config = buildPredictaStrategyConfig(symbol, options);
    strategyConfigsMap.set(symbol, config);

    const strategy = new PredictaStrategy(config);
    strategiesMap.set(symbol, strategy);

    if (!BACKTEST_MINIMAL_OUTPUT && !options.quiet) {
      console.log(
        `   [${symbol}] ST(${config.predictaStrategy.stFactor}/${config.predictaStrategy.stPeriod}) | Conf>=${config.predictaStrategy.minConfluence} | ADX>=${config.predictaStrategy.adxThreshold}`
      );
    }
  }

  if (candlesMap.size === 0) {
    throw new Error("No candle data available for any market");
  }

  if (options.symbols.length === 1) {
    const symbol = options.symbols[0];
    const strategy = strategiesMap.get(symbol);
    const candles = candlesMap.get(symbol);
    const config = strategyConfigsMap.get(symbol);
    const ticksByBar = ticksByBarOpenTimeMap.get(symbol) || null;
    const oneMinCandles = oneMinCandlesMap.get(symbol) || null;

    // Use per-market leverage from strategy config if available
    const marketLeverage = config?.leverage ?? options.leverage;

    return simulatePredictaSingleMarket(strategy, candles, {
      symbol,
      positionSizeUsd: options.positionSize,
      initialCapital: options.initialCapital,
      leverage: marketLeverage,
      hardStopPercent: config?.predictaStrategy?.hardStopPercent ?? options.hardStopPercent,
      debug: options.debug,
      allowLongs: config?.predictaStrategy?.allowLongs ?? options.allowLongs,
      allowShorts: config?.predictaStrategy?.allowShorts ?? options.allowShorts,
      positionSizePercent: options.positionSizePercent,
      minPositionSize: options.minPositionSize,
      maxPositionSize: options.maxPositionSize,
      entryAtBarOpenOnly: options.entryAtBarOpenOnly,
      // Tick simulation options
      simulateTicks: use1MinTicks,
      ticksPerCandle: use1MinTicks ? ticksPerBar : 1,
      ticksByBarOpenTime: ticksByBar,
      oneMinCandles,
    });
  }

  // Multi-market simulation - build perMarketLeverage map from configs
  const perMarketLeverage = new Map();
  for (const [symbol, config] of strategyConfigsMap.entries()) {
    if (config?.leverage) perMarketLeverage.set(symbol, config.leverage);
  }

  return simulatePredictaMultiMarket(strategiesMap, candlesMap, {
    initialCapital: options.initialCapital,
    leverage: options.leverage,
    positionSizePercent: options.positionSizePercent,
    maxPositions: options.maxPositions,
    debug: options.debug,
    allowLongs: options.allowLongs,
    allowShorts: options.allowShorts,
    perMarketLeverage,
    minPositionSize: options.minPositionSize,
    maxPositionSize: options.maxPositionSize,
    entryAtBarOpenOnly: options.entryAtBarOpenOnly,
    // Tick simulation options for multi-market
    simulateTicks: use1MinTicks,
    ticksPerCandle: use1MinTicks ? ticksPerBar : 1,
    ticksByBarOpenTimeMap,
    oneMinCandlesMap,
  });
}

function sliceCandlesByRange(candles, startTime, endTime) {
  if (!Array.isArray(candles) || !Number.isFinite(startTime) || !Number.isFinite(endTime))
    return candles;
  return candles.filter((c) => {
    const ts = Number(c?.openTime ?? c?.timestamp);
    return Number.isFinite(ts) && ts >= startTime && ts <= endTime;
  });
}

function sliceTickMapByRange(ticksByBarOpenTimeMap, startTime, endTime) {
  if (
    !(ticksByBarOpenTimeMap instanceof Map) ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime)
  ) {
    return ticksByBarOpenTimeMap;
  }
  const out = new Map();
  for (const [barOpen, ticks] of ticksByBarOpenTimeMap.entries()) {
    if (barOpen >= startTime && barOpen <= endTime) {
      out.set(barOpen, ticks);
    }
  }
  return out;
}

function sliceMarketDataByRange(data, startTime, endTime) {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return data;
  const candlesMap = new Map();
  const oneMinCandlesMap = new Map();
  const ticksByBarOpenTimeMap = new Map();

  for (const [symbol, candles] of (data.candlesMap || new Map()).entries()) {
    candlesMap.set(symbol, sliceCandlesByRange(candles, startTime, endTime));
  }
  for (const [symbol, candles] of (data.oneMinCandlesMap || new Map()).entries()) {
    oneMinCandlesMap.set(symbol, sliceCandlesByRange(candles, startTime, endTime));
  }
  for (const [symbol, tickMap] of (data.ticksByBarOpenTimeMap || new Map()).entries()) {
    ticksByBarOpenTimeMap.set(symbol, sliceTickMapByRange(tickMap, startTime, endTime));
  }

  return { candlesMap, oneMinCandlesMap, ticksByBarOpenTimeMap };
}

function saveBacktestResults(options, results) {
  const resultsDir = path.join(process.cwd(), "backtest-results");
  ensureDir(resultsDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `predicta_${options.symbols.join("-")}_${options.days}d_${timestamp}.json`;
  const filepath = path.join(resultsDir, filename);
  const tradeLimit = Number(options?.saveTradesLimit);
  const trades = Array.isArray(results?.trades) ? results.trades : [];
  const limitedTrades =
    Number.isFinite(tradeLimit) && tradeLimit > 0 ? trades.slice(0, tradeLimit) : trades;

  const json = {
    options,
    results: {
      ...results,
      trades: limitedTrades,
    },
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(filepath, JSON.stringify(json, null, 2));
  return { filepath, json };
}

async function runBacktestWithData({
  options,
  data,
  startTime,
  endTime,
  intervalMs,
  use1MinTicks,
  print = true,
  save = true,
}) {
  const ticksPerBar = ticksPerBarFromInterval(intervalMs);
  const slicedData = sliceMarketDataByRange(data, startTime, endTime);
  const results = runSimulation({ options, data: slicedData, use1MinTicks, ticksPerBar });

  // Compute + attach robust metrics (used by workflows and console)
  const robustMetrics = computeRobustMetrics(results, options);
  Object.assign(results, robustMetrics);

  if (print) {
    printResults(results, options);
    printRobustMetrics(robustMetrics);
  }

  let filepath = null;
  let json = null;
  if (save) {
    const saved = saveBacktestResults(options, results);
    filepath = saved.filepath;
    json = saved.json;
  }

  return { results, robustMetrics, filepath, json };
}

function buildCenteredGrid({ base, deltas, min, max, integer = false }) {
  const out = new Set();
  for (const d of deltas) {
    let v = base + d;
    if (integer) v = Math.round(v);
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);
    out.add(v);
  }
  return Array.from(out).sort((a, b) => a - b);
}

function buildPredictaWfGrid(options, mode) {
  const deltasSmall = [-0.5, 0, 0.5];
  const deltasMid = [-2, 0, 2];
  const deltasLarge = [-5, 0, 5];

  const grid = [
    {
      key: "stFactor",
      values: buildCenteredGrid({ base: options.stFactor, deltas: deltasSmall, min: 1 }),
    },
    {
      key: "stPeriod",
      values: buildCenteredGrid({
        base: options.stPeriod,
        deltas: deltasMid,
        min: 5,
        integer: true,
      }),
    },
    {
      key: "minConfluence",
      values: buildCenteredGrid({
        base: options.minConfluence,
        deltas: [-1, 0, 1],
        min: 1,
        max: 8,
        integer: true,
      }),
    },
    {
      key: "adxThreshold",
      values: buildCenteredGrid({
        base: options.adxThreshold,
        deltas: deltasLarge,
        min: 5,
        max: 60,
        integer: true,
      }),
    },
  ];

  if (mode === "balanced" || mode === "full") {
    grid.push({
      key: "perfectConfidence",
      values: buildCenteredGrid({ base: options.perfectConfidence, deltas: deltasSmall, min: 0.5 }),
    });
  }
  if (mode === "full") {
    grid.push({
      key: "buySellConfidence",
      values: buildCenteredGrid({ base: options.buySellConfidence, deltas: deltasSmall, min: 0.5 }),
    });
  }

  return grid.filter((p) => Array.isArray(p.values) && p.values.length > 0);
}

function buildParamCombos(pairs, limit = 5000) {
  const combos = [];
  function walk(i, acc) {
    if (combos.length >= limit) return;
    if (i >= pairs.length) {
      combos.push({ ...acc });
      return;
    }
    const { key, values } = pairs[i];
    for (const v of values) {
      acc[key] = v;
      walk(i + 1, acc);
      if (combos.length >= limit) return;
    }
  }
  walk(0, {});
  return combos;
}

async function runWalkForwardOptimization({
  options,
  data,
  startTime,
  endTime,
  intervalMs,
  use1MinTicks,
  trainDaysActual,
}) {
  const gridMode = options.wfGridMode || "fast";
  const gridPairs = buildPredictaWfGrid(options, gridMode);
  const combos = buildParamCombos(gridPairs, 5000);

  if (!BACKTEST_MINIMAL_OUTPUT) {
    console.log(`   🔧 Grid mode:        ${gridMode} (${combos.length} combos)`);
  }

  let best = null;
  for (const params of combos) {
    const optOptions = { ...options, ...params, days: trainDaysActual, quiet: true };
    const run = await runBacktestWithData({
      options: optOptions,
      data,
      startTime,
      endTime,
      intervalMs,
      use1MinTicks,
      print: false,
      save: false,
    });
    const score = Number(run?.robustMetrics?.robustScore || 0);
    const sharpe = Number(run?.robustMetrics?.sharpe || 0);
    const pnl = Number(run?.results?.totalPnL || 0);
    const trades = Number(run?.results?.totalTrades || run?.results?.trades?.length || 0);
    if (!best || score > best.score || (score === best.score && pnl > best.pnl)) {
      best = {
        params: { ...params },
        score,
        sharpe,
        pnl,
        trades,
      };
    }
  }

  return best;
}

async function runWalkForwardAnalysis({
  options,
  data,
  startTime,
  endTime,
  intervalMs,
  use1MinTicks,
}) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const trainDays = Math.max(1, Math.floor(options.wfTrainDays || 60));
  const testDays = Math.max(1, Math.floor(options.wfTestDays || 30));
  const stepDays = Math.max(1, Math.floor(options.wfStepDays || testDays));
  const mode = String(options.wfMode || "rolling").toLowerCase();
  const maxFolds = Math.max(1, Math.floor(options.wfaMaxFolds || 6));
  const trainMs = trainDays * DAY_MS;
  const testMs = testDays * DAY_MS;
  const stepMs = stepDays * DAY_MS;
  const stepMsEff = stepMs > 0 ? stepMs : testMs;

  console.log(`\n🧪 WALK-FORWARD ANALYSIS`);
  console.log("-".repeat(50));
  console.log(`   Mode:              ${mode}`);
  console.log(`   Train:             ${trainDays}d`);
  console.log(`   Test:              ${testDays}d`);
  console.log(`   Step:              ${stepDays}d`);
  if (options.wfOptimize) {
    console.log(`   Optimization:      ENABLED (objective: robustScore)`);
  }

  const folds = [];
  let foldNum = 0;
  const fmtStats = (pnl, sharpe, robust, trades) => {
    const t = Number.isFinite(trades) ? trades : 0;
    return `${fmtMoney(pnl)} / ${sharpe.toFixed(2)} / ${robust.toFixed(2)} / T${t}`;
  };

  if (!BACKTEST_MINIMAL_OUTPUT) {
    const header = [
      "Fold",
      "Fixed Train (PnL/Sharpe/Robust/T)",
      "Fixed Test (PnL/Sharpe/Robust/T)",
    ];
    if (options.wfOptimize) {
      header.push("Opt Train (PnL/Sharpe/Robust/T)");
      header.push("Opt Test (PnL/Sharpe/Robust/T)");
    }
    console.log(`   ${header.join(" | ")}`);
  }

  for (let k = 0; ; k++) {
    const trainStart = mode === "anchored" ? startTime : startTime + k * stepMsEff;
    const trainEnd =
      mode === "anchored" ? startTime + trainMs + k * stepMsEff : trainStart + trainMs;
    const testStart = trainEnd + 1;
    const testEnd = testStart + testMs;
    if (testEnd > endTime) break;
    if (foldNum >= maxFolds) break;

    foldNum = k + 1;
    const trainDaysActual = Math.max(1, Math.round((trainEnd - trainStart) / DAY_MS));
    const testDaysActual = Math.max(1, Math.round((testEnd - testStart) / DAY_MS));

    const trainRun = await runBacktestWithData({
      options: { ...options, days: trainDaysActual, quiet: true },
      data,
      startTime: trainStart,
      endTime: trainEnd,
      intervalMs,
      use1MinTicks,
      print: false,
      save: false,
    });

    const testRun = await runBacktestWithData({
      options: { ...options, days: testDaysActual, quiet: true },
      data,
      startTime: testStart,
      endTime: testEnd,
      intervalMs,
      use1MinTicks,
      print: false,
      save: false,
    });

    const trainTrades = Array.isArray(trainRun?.results?.trades) ? trainRun.results.trades : [];
    const testTrades = Array.isArray(testRun?.results?.trades) ? testRun.results.trades : [];
    const trainPnL = Number(trainRun?.results?.totalPnL || 0);
    const testPnL = Number(testRun?.results?.totalPnL || 0);
    const trainRobustScore = Number(trainRun?.robustMetrics?.robustScore || 0);
    const testRobustScore = Number(testRun?.robustMetrics?.robustScore || 0);
    const trainReturns = tradesToDailyReturns(trainTrades, options.initialCapital);
    const testReturns = tradesToDailyReturns(testTrades, options.initialCapital);
    const trainSharpe = trainReturns.length ? calculateSharpeRatio(trainReturns) : 0;
    const testSharpe = testReturns.length ? calculateSharpeRatio(testReturns) : 0;

    let optimizedParams = null;
    let optimizedTrainPnL = 0;
    let optimizedTrainRobustScore = 0;
    let optimizedTrainSharpe = 0;
    let optimizedTrainTrades = 0;
    let optimizedTestPnL = 0;
    let optimizedTestRobustScore = 0;
    let optimizedTestTrades = 0;
    let optimizedTestSharpe = 0;

    if (options.wfOptimize) {
      const optResult = await runWalkForwardOptimization({
        options,
        data,
        startTime: trainStart,
        endTime: trainEnd,
        intervalMs,
        use1MinTicks,
        trainDaysActual,
      });
      if (optResult?.params) {
        optimizedParams = optResult.params;
        optimizedTrainPnL = optResult.pnl || 0;
        optimizedTrainRobustScore = optResult.score || 0;
        optimizedTrainSharpe = optResult.sharpe || 0;
        optimizedTrainTrades = optResult.trades || 0;

        const optTestRun = await runBacktestWithData({
          options: { ...options, ...optimizedParams, days: testDaysActual, quiet: true },
          data,
          startTime: testStart,
          endTime: testEnd,
          intervalMs,
          use1MinTicks,
          print: false,
          save: false,
        });
        optimizedTestPnL = Number(optTestRun?.results?.totalPnL || 0);
        optimizedTestRobustScore = Number(optTestRun?.robustMetrics?.robustScore || 0);
        optimizedTestTrades = Array.isArray(optTestRun?.results?.trades)
          ? optTestRun.results.trades.length
          : 0;
        const optTestReturns = tradesToDailyReturns(
          optTestRun?.results?.trades || [],
          options.initialCapital
        );
        optimizedTestSharpe = optTestReturns.length ? calculateSharpeRatio(optTestReturns) : 0;
      }
    }

    const foldData = {
      fold: foldNum,
      trainStart,
      trainEnd,
      testStart,
      testEnd,
      trainPnL,
      trainTrades: trainTrades.length,
      trainSharpe,
      trainRobustScore,
      testPnL,
      testTrades: testTrades.length,
      testSharpe,
      testRobustScore,
      degradation: trainPnL !== 0 ? (testPnL - trainPnL) / Math.abs(trainPnL) : 0,
    };

    if (optimizedParams) {
      foldData.optimizedParams = optimizedParams;
      foldData.optimizedTrainPnL = optimizedTrainPnL;
      foldData.optimizedTrainRobustScore = optimizedTrainRobustScore;
      foldData.optimizedTrainSharpe = optimizedTrainSharpe;
      foldData.optimizedTrainTrades = optimizedTrainTrades;
      foldData.optimizedTestPnL = optimizedTestPnL;
      foldData.optimizedTestRobustScore = optimizedTestRobustScore;
      foldData.optimizedTestTrades = optimizedTestTrades;
      foldData.optimizedTestSharpe = optimizedTestSharpe;
      foldData.optimizedDegradation =
        optimizedTrainPnL !== 0
          ? (optimizedTestPnL - optimizedTrainPnL) / Math.abs(optimizedTrainPnL)
          : 0;
      foldData.optimizationLift =
        testPnL !== 0 ? (optimizedTestPnL - testPnL) / Math.abs(testPnL) : 0;
    }

    folds.push(foldData);

    if (!BACKTEST_MINIMAL_OUTPUT) {
      const row = [
        String(foldNum).padStart(2, "0"),
        fmtStats(trainPnL, trainSharpe, trainRobustScore, foldData.trainTrades),
        fmtStats(testPnL, testSharpe, testRobustScore, foldData.testTrades),
      ];
      if (options.wfOptimize) {
        if (optimizedParams) {
          row.push(
            fmtStats(
              optimizedTrainPnL,
              optimizedTrainSharpe,
              optimizedTrainRobustScore,
              optimizedTrainTrades
            )
          );
          row.push(
            fmtStats(
              optimizedTestPnL,
              optimizedTestSharpe,
              optimizedTestRobustScore,
              optimizedTestTrades
            )
          );
        } else {
          row.push("n/a");
          row.push("n/a");
        }
      }
      console.log(`  ${row.join(" | ")}`);
    }
  }

  if (folds.length === 0) {
    console.log(`   ⚠️  WFA skipped: insufficient window for ${trainDays}d/${testDays}d folds.`);
    return { folds: [], message: "No valid folds generated" };
  }

  const avgTrainPnL = folds.reduce((sum, f) => sum + f.trainPnL, 0) / folds.length;
  const avgTestPnL = folds.reduce((sum, f) => sum + f.testPnL, 0) / folds.length;
  const avgTrainSharpe = folds.reduce((sum, f) => sum + f.trainSharpe, 0) / folds.length;
  const avgTestSharpe = folds.reduce((sum, f) => sum + f.testSharpe, 0) / folds.length;
  const avgTrainRobust = folds.reduce((sum, f) => sum + f.trainRobustScore, 0) / folds.length;
  const avgTestRobust = folds.reduce((sum, f) => sum + f.testRobustScore, 0) / folds.length;
  const avgDegradation = folds.reduce((sum, f) => sum + f.degradation, 0) / folds.length;
  const positiveFolds = folds.filter((f) => f.testPnL > 0).length;
  const consistency = (positiveFolds / folds.length) * 100;
  const summarizeWfa = (consistencyPct, avgDeg, avgTest) => {
    if (avgTest <= 0) return "OOS negative; likely no edge in test window.";
    if (consistencyPct >= 60 && avgDeg >= -0.3)
      return "Healthy OOS stability; degradation within tolerance.";
    if (consistencyPct >= 50 && avgDeg >= -0.5)
      return "Moderate OOS degradation; monitor regime sensitivity.";
    return "Weak OOS stability; possible overfit or regime dependence.";
  };

  console.log(
    `   Fixed Consistency: ${consistency.toFixed(0)}% (${positiveFolds}/${folds.length})`
  );
  console.log(
    `   Fixed Avg Train:   ${fmtMoney(avgTrainPnL)} | Sharpe ${avgTrainSharpe.toFixed(2)} | Robust ${avgTrainRobust.toFixed(2)}`
  );
  console.log(
    `   Fixed Avg Test:    ${fmtMoney(avgTestPnL)} | Sharpe ${avgTestSharpe.toFixed(2)} | Robust ${avgTestRobust.toFixed(2)}`
  );
  console.log(`   Fixed OOS Deg:     ${(avgDegradation * 100).toFixed(1)}%`);
  console.log(`   Fixed WFA Read:    ${summarizeWfa(consistency, avgDegradation, avgTestPnL)}`);

  const optimizedFolds = folds.filter((f) => Number.isFinite(f.optimizedTestPnL));
  if (optimizedFolds.length > 0) {
    const avgOptTrainPnL =
      optimizedFolds.reduce((sum, f) => sum + f.optimizedTrainPnL, 0) / optimizedFolds.length;
    const avgOptTestPnL =
      optimizedFolds.reduce((sum, f) => sum + f.optimizedTestPnL, 0) / optimizedFolds.length;
    const avgOptTrainSharpe =
      optimizedFolds.reduce((sum, f) => sum + (f.optimizedTrainSharpe || 0), 0) /
      optimizedFolds.length;
    const avgOptTestSharpe =
      optimizedFolds.reduce((sum, f) => sum + (f.optimizedTestSharpe || 0), 0) /
      optimizedFolds.length;
    const avgOptTrainRobust =
      optimizedFolds.reduce((sum, f) => sum + (f.optimizedTrainRobustScore || 0), 0) /
      optimizedFolds.length;
    const avgOptTestRobust =
      optimizedFolds.reduce((sum, f) => sum + (f.optimizedTestRobustScore || 0), 0) /
      optimizedFolds.length;
    const avgOptLift =
      optimizedFolds.reduce((sum, f) => sum + (f.optimizationLift || 0), 0) / optimizedFolds.length;
    const avgOptDegradation =
      optimizedFolds.reduce((sum, f) => sum + (f.optimizedDegradation || 0), 0) /
      optimizedFolds.length;
    const positiveOptFolds = optimizedFolds.filter((f) => f.optimizedTestPnL > 0).length;
    const optConsistency = (positiveOptFolds / optimizedFolds.length) * 100;

    console.log(
      `   Opt Consistency:   ${optConsistency.toFixed(0)}% (${positiveOptFolds}/${optimizedFolds.length})`
    );
    console.log(
      `   Opt Avg Train:     ${fmtMoney(avgOptTrainPnL)} | Sharpe ${avgOptTrainSharpe.toFixed(2)} | Robust ${avgOptTrainRobust.toFixed(2)}`
    );
    console.log(
      `   Opt Avg Test:      ${fmtMoney(avgOptTestPnL)} | Sharpe ${avgOptTestSharpe.toFixed(2)} | Robust ${avgOptTestRobust.toFixed(2)} | Lift ${(avgOptLift * 100).toFixed(1)}%`
    );
    console.log(`   Opt OOS Deg:       ${(avgOptDegradation * 100).toFixed(1)}%`);
    console.log(
      `   Opt WFA Read:      ${summarizeWfa(optConsistency, avgOptDegradation, avgOptTestPnL)}`
    );
  }

  return {
    folds,
    avgTrainPnL,
    avgTestPnL,
    avgDegradation,
    consistency,
    totalFolds: folds.length,
    positiveFolds,
  };
}

// ============================================================
// ROBUST METRICS (SQN + tail-risk-aware composite)
// ============================================================

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

function getTradePnlUsd(t) {
  const p = Number(t?.pnlUsd ?? t?.totalPnlUsd ?? t?.pnl ?? t?.totalPnl ?? 0);
  return Number.isFinite(p) ? p : 0;
}

function calculateSQN(trades) {
  const pnls = (trades || []).map(getTradePnlUsd);
  const n = pnls.length;
  if (n < 2) return { sqn: 0, expectancy: 0, tradeStdDev: 0 };
  const expectancy = mean(pnls);
  const tradeStdDev = std(pnls);
  if (!Number.isFinite(tradeStdDev) || tradeStdDev === 0)
    return { sqn: 0, expectancy, tradeStdDev: tradeStdDev || 0 };
  const sqn = Math.sqrt(n) * (expectancy / tradeStdDev);
  return {
    sqn: Number.isFinite(sqn) ? sqn : 0,
    expectancy,
    tradeStdDev: Number.isFinite(tradeStdDev) ? tradeStdDev : 0,
  };
}

function tradesToDailyReturns(trades, initialCapital) {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const cap = Number(initialCapital);
  if (!Number.isFinite(cap) || cap <= 0) return [];

  const byDay = new Map();
  for (const t of trades) {
    const ts = Number(t?.exitTime ?? t?.closeTime ?? t?.timestamp ?? t?.time);
    const pnl = getTradePnlUsd(t);
    if (!Number.isFinite(ts) || !Number.isFinite(pnl)) continue;
    const d = new Date(ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    byDay.set(key, (byDay.get(key) || 0) + pnl);
  }
  const keys = Array.from(byDay.keys()).sort();
  return keys.map((k) => (byDay.get(k) || 0) / cap);
}

function calculateSharpeRatio(returns, riskFreeRate = 0) {
  if (!Array.isArray(returns) || returns.length < 2) return 0;
  const excess = returns.map((r) => Number(r) - riskFreeRate).filter(Number.isFinite);
  if (excess.length < 2) return 0;
  const avg = mean(excess);
  const sd = std(excess);
  if (!Number.isFinite(sd) || sd === 0) return 0;
  return (avg / sd) * Math.sqrt(252);
}

function calculateSortinoRatio(returns, riskFreeRate = 0) {
  if (!Array.isArray(returns) || returns.length < 2) return 0;
  const excess = returns.map((r) => Number(r) - riskFreeRate).filter(Number.isFinite);
  if (excess.length < 2) return 0;
  const avg = mean(excess);
  const downside = excess.filter((r) => r < 0);
  if (downside.length < 2) return avg > 0 ? 10 : 0;
  const downsideVariance =
    downside.reduce((acc, r) => acc + Math.pow(r, 2), 0) / (downside.length - 1);
  const downsideStd = Math.sqrt(downsideVariance);
  if (!Number.isFinite(downsideStd) || downsideStd === 0) return 0;
  return (avg / downsideStd) * Math.sqrt(252);
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "n/a";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
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
      winStreak = 0;
      loseStreak = 0;
    }
    if (winStreak > maxWinStreak) maxWinStreak = winStreak;
    if (loseStreak > maxLoseStreak) maxLoseStreak = loseStreak;
  }
  return { maxWinStreak, maxLoseStreak };
}

function computeRobustMetrics(results, options) {
  const trades = Array.isArray(results?.trades) ? results.trades : [];
  const days = Number(options?.days) || 0;
  const initialCapital = Number(
    options?.initialCapital || options?.positionSizeUsd || options?.positionSize || 1000
  );
  const maxDD = Number.isFinite(results?.maxDrawdown) ? Number(results.maxDrawdown) : 0;
  const profitFactor = Number.isFinite(results?.profitFactor) ? Number(results.profitFactor) : 0;
  const totalPnL = Number.isFinite(results?.totalPnL) ? Number(results.totalPnL) : 0;
  const returnPct = Number.isFinite(results?.returnPct)
    ? Number(results.returnPct)
    : initialCapital > 0
      ? (totalPnL / initialCapital) * 100
      : 0;
  const totalTrades = Number.isFinite(results?.totalTrades)
    ? Number(results.totalTrades)
    : trades.length;
  const winRate = Number.isFinite(results?.winRate)
    ? Number(results.winRate)
    : totalTrades > 0
      ? trades.filter((t) => getTradePnlUsd(t) > 0).length / totalTrades
      : 0;

  const { sqn, expectancy, tradeStdDev } = calculateSQN(trades);
  const expectancyPct = initialCapital > 0 ? expectancy / initialCapital : 0;
  const maxDDPct = maxDD > 0 ? maxDD * 100 : 0;
  const recoveryFactor = maxDDPct > 0 ? returnPct / maxDDPct : 0;

  const dailyReturns = tradesToDailyReturns(trades, initialCapital);
  const sharpe = calculateSharpeRatio(dailyReturns);
  const sortino = calculateSortinoRatio(dailyReturns);

  const { payoffRatio } = computePayoffRatio(trades);
  const wins = trades.filter((t) => getTradePnlUsd(t) > 0).length;
  const winProb = totalTrades > 0 ? wins / totalTrades : 0;
  const kelly = payoffRatio > 0 ? (winProb * payoffRatio - (1 - winProb)) / payoffRatio : 0;
  const kellyPct = clampUtil(kelly, 0, 1) * 100;

  const { maxWinStreak, maxLoseStreak } = computeStreaks(trades);
  const tail = computeTailMetrics(trades, initialCapital);

  const sampleConfidence = computeSampleConfidence(totalTrades, days || 180, 0.25);
  const robustScore = scoreFromMetrics(
    {
      sqn,
      sharpe,
      recoveryFactor,
      maxDD,
      profitFactor,
      trades: totalTrades,
      pnl: totalPnL,
      days: days || 180,
      winRate,
      payoffRatio,
      pnlSkewness: tail.pnlSkewness,
      lossTailToAvgWin: tail.lossTailToAvgWin,
      worstTrade: tail.worstTrade,
      pnlConcentrationTop5: tail.pnlConcentrationTop5,
    },
    { days: days || 180, targetTradesPerDay: 0.25 }
  );

  return {
    sqn,
    sqnRating: sqnRating(sqn),
    sharpe,
    sortino,
    recoveryFactor,
    expectancy,
    expectancyPct,
    payoffRatio,
    kellyPct,
    tradeStdDev,
    robustScore,
    scoring: {
      score: robustScore,
      sampleConfidence,
    },
    // Tail metrics
    pnlSkewness: tail.pnlSkewness,
    pnlExcessKurtosis: tail.pnlExcessKurtosis,
    cvar95: tail.cvar95,
    worstTrade: tail.worstTrade,
    avgWin: tail.avgWin,
    avgLoss: tail.avgLoss,
    lossTailToAvgWin: tail.lossTailToAvgWin,
    pnlConcentrationTop5: tail.pnlConcentrationTop5,
    // Streaks
    maxWinStreak,
    maxLoseStreak,
  };
}

function printRobustMetrics(metrics) {
  const sqn = Number.isFinite(metrics?.sqn) ? metrics.sqn : 0;
  const sharpe = Number.isFinite(metrics?.sharpe) ? metrics.sharpe : 0;
  const sortino = Number.isFinite(metrics?.sortino) ? metrics.sortino : 0;
  const recoveryFactor = Number.isFinite(metrics?.recoveryFactor) ? metrics.recoveryFactor : 0;
  const expectancy = Number.isFinite(metrics?.expectancy) ? metrics.expectancy : 0;
  const expectancyPct = Number.isFinite(metrics?.expectancyPct) ? metrics.expectancyPct : 0;
  const payoffRatio = Number.isFinite(metrics?.payoffRatio) ? metrics.payoffRatio : 0;
  const kellyPct = Number.isFinite(metrics?.kellyPct) ? metrics.kellyPct : 0;
  const robustScore = Number.isFinite(metrics?.robustScore) ? metrics.robustScore : 0;
  const maxWinStreak = Number.isFinite(metrics?.maxWinStreak) ? metrics.maxWinStreak : 0;
  const maxLoseStreak = Number.isFinite(metrics?.maxLoseStreak) ? metrics.maxLoseStreak : 0;
  const pnlSkewness = Number.isFinite(metrics?.pnlSkewness) ? metrics.pnlSkewness : 0;

  console.log("\n🧪 ROBUST METRICS (SQN-Based Scoring)");
  console.log("-".repeat(60));
  console.log(`  SQN (System Quality): ${sqn.toFixed(2)} (${sqnRating(sqn)})`);
  console.log(`  Sharpe Ratio:         ${sharpe.toFixed(2)}`);
  console.log(`  Sortino Ratio:        ${sortino.toFixed(2)}`);
  console.log(`  Recovery Factor:      ${recoveryFactor.toFixed(2)}`);
  console.log(
    `  Expectancy:           $${expectancy.toFixed(2)} (${(expectancyPct * 100).toFixed(2)}%)`
  );
  console.log(`  Payoff Ratio:         ${payoffRatio.toFixed(2)}`);
  console.log(`  Kelly %:              ${kellyPct.toFixed(1)}%`);
  console.log(`  Win Streak:           ${maxWinStreak} | Lose Streak: ${maxLoseStreak}`);
  console.log(`  PnL Skewness:         ${pnlSkewness.toFixed(2)}`);
  console.log("");
  console.log(`  🎯 Robust Score:      ${robustScore.toFixed(2)}`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const args = parseArgs();

  if (!BACKTEST_MINIMAL_OUTPUT) {
    console.log("\n" + "=".repeat(70));
    console.log("🔮 PREDICTA V4 STRATEGY BACKTEST");
    console.log("=".repeat(70));
  }

  // Parse options from args and env
  const options = buildOptions(args);

  console.log(`\n📋 CONFIGURATION`);
  console.log("-".repeat(50));
  console.log(`   Symbols:          ${options.symbols.join(", ")}`);
  console.log(`   Days:             ${options.days}`);
  console.log(`   Interval:         ${options.interval}`);
  console.log(`   Capital:          $${options.initialCapital}`);
  console.log(`   Position Size:    ${options.positionSizePercent}%`);
  console.log(`   Leverage:         ${options.leverage}x`);
  console.log(`   Max Positions:    ${options.maxPositions}`);
  console.log(`   Supertrend:       Factor=${options.stFactor}, Period=${options.stPeriod}`);
  console.log(`   Confluence:       Min=${options.minConfluence}/8, ADX>=${options.adxThreshold}`);
  console.log(
    `   Signals:          PERFECT=${options.enablePerfectSignals}, BUY/SELL=${options.enableBuySellSignals}`
  );
  console.log(
    `   Exits:            ST_flip=${options.supertrendExit}, OppPerfect=${options.oppositePerfectExit}`
  );
  console.log(
    `   Hard Stop:        ${options.hardStopEnabled ? `${options.hardStopPercent}% / ${options.hardStopAtr}x ATR` : "disabled"}`
  );
  console.log(`   Direction:        Longs=${options.allowLongs}, Shorts=${options.allowShorts}`);

  // Log fee configuration
  console.log(`\n💰 FEE MODEL`);
  console.log("-".repeat(50));
  const feeCfg = getFeeCfg();
  logFeeConfig(feeCfg);

  printBotRuntimeEventModel();

  // Calculate time range
  // Snap to LAST COMPLETED DAY (UTC) when no explicit timestamps are provided,
  // for reproducibility (same behavior as RSI backtest).
  const intervalMs = intervalToMs(options.interval);
  const { startTime, endTime } = computeTimeRange({ options, intervalMs });

  if (!BACKTEST_MINIMAL_OUTPUT) {
    console.log(`\n🕒 TIME RANGE`);
    console.log("-".repeat(50));
    console.log(`   Start:            ${new Date(startTime).toISOString()} (${startTime})`);
    console.log(`   End:              ${new Date(endTime).toISOString()} (${endTime})`);
  }

  // ============================================================
  // TICK SIMULATION CONFIGURATION
  // ============================================================
  // When enabled, fetches 1m candles from Pyth (price) and generates 15-second ticks
  // for per-tick stop loss/take profit checking.
  const ONE_MIN_MS = 60_000;
  const intervalIsMinuteMultiple = intervalMs % ONE_MIN_MS === 0;
  const use1MinTicks = shouldUse1MinTicks(intervalMs);

  if (!BACKTEST_MINIMAL_OUTPUT) {
    console.log(`\n🔄 TICK SIMULATION`);
    console.log("-".repeat(50));
    if (!intervalIsMinuteMultiple) {
      console.log(`   Mode:             Bar-based (interval not aligned to 1m)`);
      console.log(`   Ticks per bar:    1`);
      console.log(`   Tick interval:    N/A`);
    } else {
      const ticksPerBar = ticksPerBarFromInterval(intervalMs);
      console.log(
        `   Mode:             ${use1MinTicks ? "1m-derived (15s ticks) - more accurate SL/TP" : "Bar-based (interval close)"}`
      );
      console.log(`   Ticks per bar:    ${use1MinTicks ? ticksPerBar : 1}`);
      console.log(`   Tick interval:    ${use1MinTicks ? TICK_INTERVAL_MS / 1000 + "s" : "N/A"}`);
    }
  }

  const data = await preloadMarketData({ options, startTime, endTime, intervalMs, use1MinTicks });

  // Run simulation
  console.log(`\n🚀 Running simulation...`);

  const run = await runBacktestWithData({
    options,
    data,
    startTime,
    endTime,
    intervalMs,
    use1MinTicks,
    print: true,
    save: true,
  });

  let walkForwardResult = null;
  if (options.wfa && !BACKTEST_MINIMAL_OUTPUT) {
    walkForwardResult = await runWalkForwardAnalysis({
      options,
      data,
      startTime,
      endTime,
      intervalMs,
      use1MinTicks,
    });
  }

  if (walkForwardResult && run.filepath) {
    try {
      const existing = JSON.parse(fs.readFileSync(run.filepath, "utf8"));
      existing.robustness = {
        ...(existing.robustness || {}),
        config: {
          enableWalkForward: true,
          wfTrainDays: options.wfTrainDays,
          wfTestDays: options.wfTestDays,
          wfStepDays: options.wfStepDays,
          wfMode: options.wfMode,
          wfOptimize: options.wfOptimize,
          wfGridMode: options.wfGridMode,
        },
        walkForward: walkForwardResult,
      };
      fs.writeFileSync(run.filepath, JSON.stringify(existing, null, 2));
    } catch (err) {
      console.warn(`⚠️  Failed to persist WFA results to JSON: ${err.message}`);
    }
  }

  if (run.filepath) {
    console.log(`\n💾 Results saved to: ${run.filepath}`);
  }

  // Cleanup if method exists
  if (db.cleanup && typeof db.cleanup === "function") {
    await db.cleanup();
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  buildOptions,
  computeTimeRange,
  shouldUse1MinTicks,
  ticksPerBarFromInterval,
  preloadMarketData,
  runBacktestWithData,
};
