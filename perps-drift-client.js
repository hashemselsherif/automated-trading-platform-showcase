/**
 * Drift Protocol Perps Client
 *
 * Implements the same interface as JupiterPerpsClient for Drift Protocol.
 * Supports both taker (market) and maker (limit post-only) orders.
 *
 * Uses subprocess isolation for Drift SDK due to Node v22 compatibility issues.
 *
 * Order Types:
 * - Taker: Immediate market orders (default)
 * - Maker: Post-only limit orders with state machine (enabled via DRIFT_LIMIT_*)
 */

/* eslint-disable no-mixed-spaces-and-tabs */
require("dotenv").config();
const { EventEmitter } = require("events");
const { DriftSubprocessClient } = require("./utils/drift-subprocess-client");
const driftLookup = require("./utils/drift-market-lookup");
const { parseLimitOrderConfig } = require("./backtest/utils/drift-limit-config");
const {
  classifyError,
  isInsufficientCollateral,
  isPerpMarketNotFound,
  isInvalidMarketError,
  isPostOnlyFailure,
  isTimeoutError,
  getRetryDelay,
} = require("./utils/drift-error-classifier");

// Mark price construction (DLOB WebSocket + constructor)
const DriftDlobWebSocketClient = require("./utils/drift-dlob-websocket-client");
const DriftMarkPriceConstructor = require("./utils/drift-mark-price-constructor");

// Database for position ID recovery on restart
let db = null;
try {
  db = require("./db");
} catch (e) {
  // DB not available - will use fallback ID generation
}

// Strategy-scoped environment manager for isolated configs
let strategyEnv = null;
try {
  strategyEnv = require("./utils/strategy-env-manager");
} catch (e) {
  console.warn("[DriftClient] Strategy env manager not available, using process.env");
}

/**
 * Order execution modes
 */
const ExecMode = {
  TAKER: "taker",
  MAKER: "maker",
};

/**
 * Order states for maker flow (matches limit-order-policy.js)
 */
const OrderState = {
  IDLE: "IDLE",
  WORKING_ENTRY: "WORKING_ENTRY",
  REPLACING: "REPLACING",
  FILLED: "FILLED",
  CANCELLED: "CANCELLED",
  FALLBACK_TAKER: "FALLBACK_TAKER",
  OPEN: "OPEN",
  WORKING_EXIT: "WORKING_EXIT",
  CLOSED: "CLOSED",
};

/**
 * Exit reasons that require immediate taker execution (emergency exits)
 * vs. those that can try maker first
 */
const EXIT_REASON_EXEC_MODE = {
  // Taker exits (immediate, emergency)
  rsi_hard_stop: "taker",
  rsi_trailing_stop: "taker",
  rsi_hard_time_stop: "taker",
  max_loss_cap: "taker",
  circuit_breaker_active: "taker",
  liquidation: "taker",
  stop_loss: "taker",
  hard_stop: "taker",
  emergency: "taker",

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

  // Check for partial matches
  if (normalized.includes("hard_stop") || normalized.includes("hard_time")) return "taker";
  if (normalized.includes("trailing_stop") || normalized.includes("trailing")) return "taker";
  if (normalized.includes("max_loss") || normalized.includes("circuit_breaker")) return "taker";
  if (normalized.includes("liquidat") || normalized.includes("emergency")) return "taker";
  if (normalized.includes("target") || normalized.includes("profit")) return "maker";
  if (normalized.includes("failure") || normalized.includes("time_stop")) return "maker";

  return defaultMode;
}

/**
 * Working order tracker
 */
class WorkingOrder {
  constructor(params) {
    this.id = params.id || `order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.market = params.market;
    this.marketIndex = params.marketIndex;
    this.userOrderId = params.userOrderId;
    this.side = params.side;
    this.size = params.size;
    this.limitPrice = params.limitPrice;
    // CRITICAL: Support both entry and exit orders
    // orderType: 'entry' (default) or 'exit'
    this.orderType = params.orderType || "entry";
    this.state = this.orderType === "exit" ? OrderState.WORKING_EXIT : OrderState.WORKING_ENTRY;
    this.createdAt = Date.now();
    // BUG FIX: Initialize lastReplaceAt to createdAt so first replacement happens after replaceEveryMs
    // Previously was 0 which made shouldReplace() always return true immediately
    this.lastReplaceAt = this.createdAt;
    this.replaceCount = 0;
    this.filledSize = 0;
    this.avgFillPrice = null;
    this.driftOrderId = null;
    this.collateral = params.collateral;
    this.leverage = params.leverage;
    this.entryPriceRef = params.entryPriceRef;
    // For exit orders, track the position being closed
    this.positionId = params.positionId || null;
    this.exitReason = params.exitReason || null;

    // CRITICAL: Mutex flags to prevent concurrent operations on same order
    // These prevent race conditions between _replaceOrder, _fallbackToTaker, and _checkWorkingOrders
    this._operationInProgress = false;
    this._fallbackInProgress = false;
    this._replaceInProgress = false;
    this.fallbackStartedAt = null;

    // CRITICAL FIX: Track when order first disappeared from on-chain to implement grace period
    // This prevents false "cancelled" detection when orders fill but positions haven't propagated yet
    this.orderDisappearedAt = null;
  }

  /**
   * Check if this is an exit order
   */
  isExit() {
    return this.orderType === "exit" || this.state === OrderState.WORKING_EXIT;
  }

  /**
   * Acquire lock for an operation. Returns true if lock acquired, false if already locked.
   * @param {string} operation - 'replace', 'fallback', or 'any'
   */
  acquireLock(operation = "any") {
    if (this._operationInProgress) {
      return false;
    }

    // Check specific locks
    if (operation === "replace" && this._replaceInProgress) return false;
    if (operation === "fallback" && this._fallbackInProgress) return false;

    // Acquire locks
    this._operationInProgress = true;
    if (operation === "replace") this._replaceInProgress = true;
    if (operation === "fallback") this._fallbackInProgress = true;

    return true;
  }

  /**
   * Release lock after operation completes
   * @param {string} operation - 'replace', 'fallback', or 'any'
   */
  releaseLock(operation = "any") {
    if (operation === "replace") this._replaceInProgress = false;
    if (operation === "fallback") this._fallbackInProgress = false;
    this._operationInProgress = false;
  }

  isExpired(timeoutMs) {
    return Date.now() - this.createdAt > timeoutMs;
  }

  /**
   * Check if order should be replaced based on time since last replacement
   * First replacement happens after replaceEveryMs from order creation
   * Subsequent replacements happen replaceEveryMs after the previous replacement
   */
  shouldReplace(replaceEveryMs) {
    return Date.now() - this.lastReplaceAt > replaceEveryMs;
  }
}

/**
 * Get execution mode for a specific market from isolated strategy env
 * This prevents env bleeding between .env.rsi-reversion and .env.rsi-reversion-alts
 */
function getExecModeForMarket(market) {
  if (strategyEnv) {
    const mode = strategyEnv.getMarketConfig(market, "EXEC_MODE", "taker");
    return String(mode).toLowerCase();
  }
  return (process.env.EXEC_MODE || "taker").toLowerCase();
}

/**
 * Get leverage for a specific market from isolated strategy env
 */
function getLeverageForMarket(market) {
  if (strategyEnv) {
    return strategyEnv.getMarketConfigNum(market, "LEVERAGE", 1);
  }

  // Fallback: try per-market override then base
  const normalized = market.toUpperCase().replace("-PERP", "_PERP").replace("-", "_");
  const perMarketKey = `STRATEGY_${normalized}_LEVERAGE`;
  if (process.env[perMarketKey]) {
    return Number(process.env[perMarketKey]) || 1;
  }
  return Number(process.env.LEVERAGE_BASE) || 1;
}

function getConfiguredSubaccount() {
  const rawId = process.env.DRIFT_SUBACCOUNT_ID;
  const rawLegacy = process.env.DRIFT_SUBACCOUNT;
  const parsedId = rawId !== undefined ? parseInt(rawId, 10) : NaN;
  const parsedLegacy = rawLegacy !== undefined ? parseInt(rawLegacy, 10) : NaN;

  if (Number.isFinite(parsedId) && Number.isFinite(parsedLegacy) && parsedId !== parsedLegacy) {
    console.warn(
      `[DriftClient] DRIFT_SUBACCOUNT_ID (${parsedId}) != DRIFT_SUBACCOUNT (${parsedLegacy}); using DRIFT_SUBACCOUNT_ID`
    );
  }

  if (Number.isFinite(parsedId)) return parsedId;
  if (Number.isFinite(parsedLegacy)) return parsedLegacy;
  return 0;
}

/**
 * Drift Protocol Perps Client
 */
class DriftPerpsClient extends EventEmitter {
  constructor(config, wallet, telegram = null, options = {}) {
    super();

    // Note: execMode is now resolved per-market using getExecModeForMarket()
    // The default here is only used when no market context is available
    this.config = {
      ...config,
      subaccount: getConfiguredSubaccount(),
      execMode: (process.env.EXEC_MODE || "taker").toLowerCase(), // Default fallback
    };

    this.wallet = wallet;
    this.telegram = telegram;

    // Active markets (for DLOB subscription optimization)
    this.activeMarkets = options.activeMarkets || null;

    // Subprocess client for Drift SDK calls
    this.subprocess = options.subprocessClient || null;
    this._externalSubprocess = !!options.subprocessClient;
    this.initialized = false;

    // Working orders (for maker flow)
    this.workingOrders = new Map(); // orderId -> WorkingOrder
    this._lastUserOrderId = null;
    this._userOrderIdCounter = 0;
    this._openOrdersBackoffMs = 0;
    this._openOrdersBackoffUntil = 0;
    this._positionsBackoffMs = 0;
    this._positionsBackoffUntil = 0;
    this._replaceBackoff = new Map(); // marketIndex -> { nextAt, backoffMs }
    this._initPromise = null;
    this._initBackoffMs = 0;
    this._initBackoffUntil = 0;

    // Subprocess lifecycle coalescing (prevents overlapping spawns/restarts).
    this._subprocessStartPromise = null;
    this._subprocessRestartPromise = null;

    // Open positions tracking
    this.positions = new Map(); // market -> position

    // Dedup: prevent duplicate positionClosed emissions under race conditions
    this._recentPositionClosedAt = new Map(); // key -> ts
    this._recentPositionClosedTtlMs = Math.max(
      30000,
      Number(process.env.DRIFT_POSITION_CLOSED_DEDUP_MS) || 5 * 60 * 1000
    );

    // Disabled markets (due to PerpMarketNotFound or validation failure)
    this.disabledMarkets = new Map(); // marketSymbol -> { disabledAt, reason, error }

    // Failed orphan order cancellations - tracks orders that repeatedly fail to cancel
    // After MAX_ORPHAN_CANCEL_ATTEMPTS failures, we assume the order no longer exists
    // Key: `${marketIndex}:${userOrderId}` -> { attempts, lastAttempt, lastError }
    this._failedOrphanCancels = new Map();
    this._maxOrphanCancelAttempts = 3; // After 3 failures, stop trying

    // CRITICAL FIX: Track stale exit order candidates (orders that exist WITH positions)
    // These are likely failed exit attempts that weren't cleaned up
    // Key: `${marketIndex}:${userOrderId}` -> { firstSeenAt, market }
    // After STALE_EXIT_ORDER_TIMEOUT_MS, cancel them as stale exit orders
    this._staleExitOrderCandidates = new Map();
    this._STALE_EXIT_ORDER_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes - cancel exit orders stuck this long

    // Price cache
    this.priceCache = new Map();
    this.cacheTtlMs = 5000;

    // Stats
    this.stats = {
      ordersPlaced: 0,
      ordersFilled: 0,
      ordersCancelled: 0,
      ordersTimedOut: 0,
      ordersReplaced: 0,
      fallbacksToTaker: 0,
      makerFills: 0,
      takerFills: 0,
    };

    // Load global limit order config
    this.limitConfig = parseLimitOrderConfig();

    // Mark price via DLOB WebSocket (enabled by default for Drift)
    this.useMarkPrice = process.env.USE_MARK_PRICE !== "false";
    this.dlobClient = null;
    this.markPriceConstructor = null;
    this.markPriceInitialized = false;
    this.priceProvider = options.priceProvider || null;
    this._oracleFeedLast = new Map();
    this._oracleFeedMinMs = Math.max(
      5000,
      Number(process.env.DRIFT_ORACLE_FEED_INTERVAL_MS) || 15000
    );
    this._pythMissingLogged = new Set();
    this._pythWideConfLogged = new Set();
    this._pythMaxConfRatio = Number(process.env.PYTH_CONFIDENCE_MAX_RATIO || 0.02);

    // When we intentionally stop the Drift subprocess (e.g., init cleanup / shutdown),
    // we should not treat the exit event as an unexpected crash.
    this._expectedExitSubprocesses = new Set();
  }

  /**
   * Initialize the Drift subprocess and connection
   */
  async initialize() {
    if (this.initialized) return;
    if (this._initPromise) {
      return this._initPromise;
    }

    const now = Date.now();
    if (this._initBackoffUntil && now < this._initBackoffUntil) {
      const remainingMs = this._initBackoffUntil - now;
      throw new Error(`Drift init backoff active (${Math.round(remainingMs / 1000)}s remaining)`);
    }

    const initPromise = (async () => {
      console.log("[DriftClient] Initializing Drift subprocess...");

      if (!this._externalSubprocess) {
        if (this.subprocess && this.subprocess.process) {
          try {
            this._expectedExitSubprocesses.add(this.subprocess);
            await this.subprocess.stop();
          } catch (stopErr) {
            console.warn(
              `[DriftClient] Failed to stop existing subprocess before re-init: ${stopErr.message}`
            );
          } finally {
            this._expectedExitSubprocesses.delete(this.subprocess);
          }
        }
        await this._startSubprocess();
      }

      console.log("[DriftClient] Drift subprocess initialized");
      this.initialized = true;
      this._initTimestamp = Date.now(); // Track initialization time for grace periods

      // CRITICAL: Reconcile local state with on-chain orders/positions
      await this._reconcileState();

      // Validate active markets on startup
      await this._validateActiveMarkets();

      // Always start order monitor - with strategy env isolation, execMode is per-market
      // Some markets may use maker mode even if global default is taker
      this._startOrderMonitor();
      console.log("[DriftClient] Order monitor started for maker order lifecycle management");

      // Start health monitor for memory tracking
      this._startHealthMonitor();
      console.log("[DriftClient] Health monitor started for subprocess memory tracking");

      // Initialize mark price construction (DLOB WebSocket)
      if (this.useMarkPrice) {
        await this._initializeMarkPriceClient();
      }
    })();

    this._initPromise = initPromise;
    try {
      await initPromise;
    } catch (err) {
      this._initBackoffMs = this._initBackoffMs ? Math.min(this._initBackoffMs * 2, 30000) : 1000;
      this._initBackoffUntil = Date.now() + this._initBackoffMs;
      if (this.subprocess && !this._externalSubprocess) {
        try {
          this._expectedExitSubprocesses.add(this.subprocess);
          await this.subprocess.stop();
        } catch (stopErr) {
          console.warn(
            `[DriftClient] Failed to stop subprocess after init error: ${stopErr.message}`
          );
        } finally {
          this._expectedExitSubprocesses.delete(this.subprocess);
        }
      }
      this.subprocess = this._externalSubprocess ? this.subprocess : null;
      this.initialized = false;
      throw err;
    } finally {
      if (this._initPromise === initPromise) {
        this._initPromise = null;
      }
    }
  }

  /**
   * Initialize DLOB WebSocket client and mark price constructor
   */
  async _initializeMarkPriceClient() {
    try {
      console.log("[DriftClient] Initializing mark price client (DLOB WebSocket)...");

      // Create DLOB WebSocket client
      this.dlobClient = new DriftDlobWebSocketClient({
        wsUrl: process.env.DRIFT_DLOB_WS_URL || "wss://dlob.drift.trade/ws",
        debug: process.env.DLOB_DEBUG === "true",
        staleThresholdMs: parseInt(process.env.MARK_STALENESS_TIMEOUT_MS) || 5000,
      });

      // Create mark price constructor
      this.markPriceConstructor = new DriftMarkPriceConstructor(this.dlobClient, {
        tau5m: parseFloat(process.env.MARK_TWAP_5M_TAU) || 300,
        tau1h: parseFloat(process.env.MARK_TWAP_1H_TAU) || 3600,
        divergenceThreshold: parseFloat(process.env.MARK_DIVERGENCE_THRESHOLD) || 0.1,
        stalenessTimeoutMs: parseInt(process.env.MARK_STALENESS_TIMEOUT_MS) || 5000,
        debug: process.env.DLOB_DEBUG === "true",
      });

      // Listen for divergence events
      this.markPriceConstructor.on("divergence", (market, state) => {
        console.warn(
          `[DriftClient] Mark price divergence for ${market}: ${state.percent.toFixed(2)}% - FROZEN`
        );
      });

      this.markPriceConstructor.on("divergenceCleared", (market, state) => {
        console.log(
          `[DriftClient] Mark price divergence cleared for ${market}: ${state.percent.toFixed(2)}%`
        );
      });

      // Connect to DLOB server
      this.dlobClient.connect();

      // Wait for connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("DLOB WebSocket connection timeout"));
        }, 10000);

        this.dlobClient.once("connected", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.dlobClient.once("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Subscribe to markets from config or tracked markets
      const markets = this._getMarketsToSubscribe();
      if (markets.length > 0) {
        console.log(
          `[DriftClient] Subscribing to ${markets.length} markets for mark price: ${markets.join(", ")}`
        );
        this.dlobClient.subscribeMarkets(markets, "perp");
      }

      this.markPriceInitialized = true;
      console.log("[DriftClient] ✅ Mark price client initialized (DLOB WebSocket connected)");

      // Start periodic oracle vs mark price divergence analysis
      this._startDivergenceAnalysis();
    } catch (err) {
      console.error(`[DriftClient] ⚠️ Failed to initialize mark price client: ${err.message}`);
      console.error("[DriftClient] Falling back to oracle price");
      this.useMarkPrice = false;
    }
  }

  /**
   * Start periodic oracle vs mark price divergence analysis
   * Runs every 5 minutes to monitor price discrepancies
   */
  _startDivergenceAnalysis() {
    const ANALYSIS_INTERVAL_MS =
      parseInt(process.env.DRIFT_PRICE_ANALYSIS_INTERVAL_MS, 10) || 300000; // 5 min

    // Store interval reference for cleanup
    this._divergenceAnalysisInterval = setInterval(async () => {
      if (!this.markPriceConstructor) return;

      try {
        const markets = this._getMarketsToSubscribe();
        const analysisResults = [];

        for (const market of markets) {
          try {
            // Get mark price and TWAPs
            const markPrice = this.markPriceConstructor.getMarkPrice(market);
            const markTwap5m = this.markPriceConstructor.getMarkTwap5m(market);
            const markTwap1h = this.markPriceConstructor.getMarkTwap1h(market);

            // Get oracle price (Pyth WS)
            let oraclePrice = null;
            let oracleTwap5m = null;
            const pythData = this._getPythOraclePriceData(market);
            if (pythData?.price && this.markPriceConstructor) {
              oraclePrice = pythData.price;
              this.markPriceConstructor.updateOraclePrice(
                market,
                pythData.price,
                pythData.timestamp
              );
              oracleTwap5m = this.markPriceConstructor.oracleTwap5m?.get(market)?.twap;
            }

            // Get divergence state
            const divergenceState = this.markPriceConstructor.divergenceState?.get(market);
            const priceAnalysis = this.markPriceConstructor.getPriceAnalysis?.(market);

            // Calculate divergence
            let divergence = null;
            let divergencePercent = null;
            if (markTwap5m && oracleTwap5m) {
              divergence = markTwap5m - oracleTwap5m;
              divergencePercent = (divergence / oracleTwap5m) * 100;
            }

            analysisResults.push({
              market,
              markPrice,
              markTwap5m,
              markTwap1h,
              oraclePrice,
              oracleTwap5m,
              divergence,
              divergencePercent,
              frozen: divergenceState?.frozen || false,
              stale: priceAnalysis?.bbo?.stale || false,
            });
          } catch (marketErr) {
            // Skip this market
          }
        }

        // Log analysis summary
        if (analysisResults.length > 0) {
          console.log("\n📊 [Price Analysis] Oracle vs Mark Price Divergence:");
          for (const r of analysisResults) {
            const markStr = r.markPrice ? `$${r.markPrice.toFixed(4)}` : "N/A";
            const markTwap5mStr = r.markTwap5m ? `$${r.markTwap5m.toFixed(4)}` : "N/A";
            const oracleStr = r.oraclePrice ? `$${r.oraclePrice.toFixed(4)}` : "N/A";
            const oracleTwapStr = r.oracleTwap5m ? `$${r.oracleTwap5m.toFixed(4)}` : "N/A";
            const divStr =
              r.divergencePercent !== null
                ? `${r.divergencePercent >= 0 ? "+" : ""}${r.divergencePercent.toFixed(3)}%`
                : "N/A";
            const statusFlags = [];
            if (r.frozen) statusFlags.push("FROZEN");
            if (r.stale) statusFlags.push("STALE");
            const status = statusFlags.length > 0 ? ` ⚠️ [${statusFlags.join(", ")}]` : "";

            console.log(
              `  ${r.market}: mark=${markStr} (5m: ${markTwap5mStr}) | oracle=${oracleStr} (5m: ${oracleTwapStr}) | div=${divStr}${status}`
            );
          }
          console.log("");
        }
      } catch (err) {
        console.warn(`[Price Analysis] Error during analysis: ${err.message}`);
      }
    }, ANALYSIS_INTERVAL_MS);

    console.log(
      `[DriftClient] Started divergence analysis (every ${ANALYSIS_INTERVAL_MS / 1000}s)`
    );
  }

  /**
   * Stop divergence analysis (for cleanup)
   */
  _stopDivergenceAnalysis() {
    if (this._divergenceAnalysisInterval) {
      clearInterval(this._divergenceAnalysisInterval);
      this._divergenceAnalysisInterval = null;
    }
  }

  /**
   * Get markets to subscribe for mark price
   */
  _getMarketsToSubscribe() {
    // If activeMarkets were passed during initialization, use only those
    if (this.activeMarkets && this.activeMarkets.length > 0) {
      const venueRouter = require("./utils/venue-router");
      const driftMarkets = this.activeMarkets.filter(
        (m) => venueRouter.getVenueForMarket(m) === "drift"
      );
      if (driftMarkets.length > 0) {
        console.log(
          `[DriftClient] Using ${driftMarkets.length} active Drift markets from bot configuration`
        );
        return driftMarkets;
      }
    }

    // Fallback: try environment variables for markets
    const envMarkets = process.env.STRATEGY_MARKETS || process.env.MARKETS;
    if (envMarkets) {
      const markets = envMarkets
        .split(",")
        .map((m) => (m.trim().includes("-PERP") ? m.trim() : `${m.trim()}-PERP`));
      console.log(`[DriftClient] Using ${markets.length} markets from environment`);
      return markets;
    }

    // No markets configured – do not auto-subscribe to the full registry (too heavy).
    console.warn(
      `[DriftClient] ⚠️  No Drift markets configured; skipping Drift market subscriptions. Pass activeMarkets to enable.`
    );
    return [];
  }

  /**
   * Generate a deterministic userOrderId for idempotent order placement.
   * NOTE: Drift SDK requires userOrderId to be u8 (0-255 range).
   *
   * New approach: Use deterministic mapping based on (marketIndex, purpose) to reduce
   * collision probability. This is more robust than the old time-based approach.
   *
   * ID allocation scheme:
   * - Reserved: 0 (Drift uses 0 as "no userOrderId")
   * - Per-market entry: (marketIndex * 3 + 1) % 254 + 1
   * - Per-market exit:  (marketIndex * 3 + 2) % 254 + 1
   * - Per-market replace: (marketIndex * 3 + 3) % 254 + 1
   *
   * This gives us stable, deterministic IDs per market/purpose combination.
   * The + 1 at the end ensures we never return 0.
   *
   * @param {number} marketIndex - Market index (optional, uses counter if not provided)
   * @param {'entry'|'exit'|'replace'|'fallback'} purpose - Order purpose (optional)
   * @returns {number} userOrderId in range 1-255
   */
  _generateUserOrderId(marketIndex = null, purpose = "entry") {
    // If marketIndex is provided, use deterministic mapping
    if (marketIndex !== null && Number.isFinite(marketIndex)) {
      // Purpose offsets: entry=1, exit=2, replace=3, fallback=4, exit_fallback=5
      // exit_fallback is used when taker fallback follows a failed/timed-out maker exit
      // to avoid userOrderId collision with the maker order that may still be on-chain
      const purposeOffset =
        purpose === "exit"
          ? 2
          : purpose === "replace"
            ? 3
            : purpose === "fallback"
              ? 4
              : purpose === "exit_fallback"
                ? 5
                : 1;
      // Use modulo 51 to give each market 5 slots within 255 IDs
      // This supports up to 51 markets with deterministic IDs
      const baseId = ((marketIndex % 51) * 5 + purposeOffset) % 254;
      const userOrderId = baseId + 1; // Ensure 1-255 range
      this._lastUserOrderId = userOrderId;
      return userOrderId;
    }

    // Fallback: sequential counter (used when marketIndex not available)
    this._userOrderIdCounter = (this._userOrderIdCounter + 1) % 254;
    const userOrderId = this._userOrderIdCounter + 1; // Ensure 1-255 range
    this._lastUserOrderId = userOrderId;
    return userOrderId;
  }

  /**
   * Get the orderId from on-chain open orders for a given marketIndex and userOrderId.
   * This allows us to cancel by orderId (more reliable) when possible.
   *
   * @param {number} marketIndex - Market index
   * @param {number} userOrderId - User order ID to find
   * @returns {Promise<{orderId: number|null, found: boolean}>}
   */
  async _findOrderIdByUserOrderId(marketIndex, userOrderId) {
    try {
      const result = await this._getOpenOrdersSnapshot({
        // When managing working orders we need a fresh user state (polling mode can lag by tens of seconds).
        // The subprocess throttles forced refreshes to avoid excessive RPC load.
        forceRefresh: this.workingOrders.size > 0,
      });
      if (result.backoff || !result.orders) {
        return { orderId: null, found: false };
      }

      const order = result.orders.find(
        (o) => o.marketIndex === marketIndex && Number(o.userOrderId) === Number(userOrderId)
      );

      if (order && order.orderId !== undefined) {
        return { orderId: order.orderId, found: true };
      }

      return { orderId: null, found: false };
    } catch (err) {
      console.warn(`[DriftClient] _findOrderIdByUserOrderId error: ${err.message}`);
      return { orderId: null, found: false };
    }
  }

  /**
   * Enforce one working maker order per market.
   */
  _getWorkingOrderByMarketIndex(marketIndex) {
    for (const order of this.workingOrders.values()) {
      if (order.marketIndex === marketIndex) {
        return order;
      }
    }
    return null;
  }

  /**
   * Get working EXIT order for a market (if any).
   * Used to prevent duplicate close orders when an exit is already in progress.
   * @param {number} marketIndex - Market index
   * @returns {WorkingOrder|null} - The working exit order, or null if none
   */
  _getWorkingExitOrderForMarket(marketIndex) {
    for (const order of this.workingOrders.values()) {
      if (order.marketIndex === marketIndex && order.isExit()) {
        // Return exit orders that are still active (not closed/cancelled)
        if (
          order.state === OrderState.WORKING_EXIT ||
          order.state === OrderState.FALLBACK_TAKER ||
          order.state === OrderState.REPLACING
        ) {
          return order;
        }
      }
    }
    return null;
  }

  /**
   * Cancel working ENTRY orders for a market (preserves exit orders).
   * Used when placing an exit order - we don't want to cancel in-flight exit orders.
   * @param {string} market - Market symbol (e.g., 'JTO-PERP')
   */
  async _cancelWorkingEntryOrdersForMarket(market) {
    const ordersToCancel = [];

    for (const [id, order] of this.workingOrders) {
      if (order.market === market && !order.isExit()) {
        ordersToCancel.push(id);
      }
    }

    if (ordersToCancel.length === 0) return;

    console.log(`[DriftClient] Cancelling ${ordersToCancel.length} entry order(s) for ${market}`);

    for (const id of ordersToCancel) {
      try {
        await this.cancelOrder(id);
      } catch (err) {
        console.warn(`[DriftClient] Warning: Failed to cancel entry order ${id}: ${err.message}`);
      }
    }
  }

  /**
   * Fetch open orders with backoff to avoid IPC storms under failure.
   */
  async _getOpenOrdersSnapshot(options = {}) {
    if (!this.subprocess || !this.initialized) {
      return { orders: [], live: false };
    }

    const now = Date.now();
    if (this._openOrdersBackoffUntil && now < this._openOrdersBackoffUntil) {
      const remainingMs = this._openOrdersBackoffUntil - now;
      console.warn(
        `[DriftClient] Backoff active for getOpenOrders (${Math.round(remainingMs / 1000)}s remaining)`
      );
      return { orders: [], live: false, backoff: true };
    }

    try {
      const result = await this.subprocess.send("getOpenOrders", {
        subaccount: this.config.subaccount,
        forceRefresh: !!options.forceRefresh,
      });
      this._openOrdersBackoffMs = 0;
      this._openOrdersBackoffUntil = 0;
      return result;
    } catch (err) {
      this._openOrdersBackoffMs = this._openOrdersBackoffMs
        ? Math.min(this._openOrdersBackoffMs * 2, 30000)
        : 1000;
      this._openOrdersBackoffUntil = Date.now() + this._openOrdersBackoffMs;
      throw err;
    }
  }

  /**
   * Fetch positions with backoff to avoid IPC storms under failure.
   */
  async _getPositionsSnapshot(options = {}) {
    if (!this.subprocess || !this.initialized) {
      return { positions: [], live: false };
    }

    const now = Date.now();
    if (this._positionsBackoffUntil && now < this._positionsBackoffUntil) {
      const remainingMs = this._positionsBackoffUntil - now;
      console.warn(
        `[DriftClient] Backoff active for getPositions (${Math.round(remainingMs / 1000)}s remaining)`
      );
      return { positions: [], live: false, backoff: true };
    }

    try {
      const result = await this.subprocess.send("getPositions", {
        subaccount: this.config.subaccount,
        forceRefresh: !!options.forceRefresh,
      });
      this._positionsBackoffMs = 0;
      this._positionsBackoffUntil = 0;
      return result;
    } catch (err) {
      this._positionsBackoffMs = this._positionsBackoffMs
        ? Math.min(this._positionsBackoffMs * 2, 30000)
        : 1000;
      this._positionsBackoffUntil = Date.now() + this._positionsBackoffMs;
      throw err;
    }
  }

  _recordReplaceBackoff(marketIndex) {
    const prev = this._replaceBackoff.get(marketIndex);
    const nextBackoff = prev ? Math.min(prev.backoffMs * 2, 30000) : 1000;
    this._replaceBackoff.set(marketIndex, {
      backoffMs: nextBackoff,
      nextAt: Date.now() + nextBackoff,
    });
  }

  _clearReplaceBackoff(marketIndex) {
    this._replaceBackoff.delete(marketIndex);
  }

  _canAttemptReplace(marketIndex) {
    const backoff = this._replaceBackoff.get(marketIndex);
    if (!backoff) return true;
    return Date.now() >= backoff.nextAt;
  }

  /**
   * Reconcile local state with on-chain orders/positions on startup or restart.
   */
  async _reconcileState() {
    try {
      console.log("[DriftClient] Reconciling on-chain orders and positions...");

      const [openOrdersResult, positionsResult] = await Promise.all([
        this._getOpenOrdersSnapshot(),
        this._getPositionsSnapshot(),
      ]);

      if (openOrdersResult?.backoff || positionsResult?.backoff) {
        console.warn("[DriftClient] Reconcile skipped - backoff active for on-chain snapshots");
        return;
      }
      if (openOrdersResult?.live === false || positionsResult?.live === false) {
        console.warn("[DriftClient] Reconcile skipped - on-chain snapshots not live");
        return;
      }

      const openOrders = openOrdersResult.orders || [];
      const positions = positionsResult.positions || [];

      const seenMarkets = new Map();
      for (const [id, workingOrder] of this.workingOrders) {
        const existing = seenMarkets.get(workingOrder.marketIndex);
        if (existing) {
          const keep = existing.createdAt >= workingOrder.createdAt ? existing : workingOrder;
          const drop = keep === existing ? workingOrder : existing;
          console.warn(
            `[DriftClient] Reconcile: multiple working orders for market ${workingOrder.marketIndex}, cancelling userOrderId=${drop.userOrderId}`
          );
          try {
            await this.subprocess.send("cancelOrderByUserOrderId", {
              marketIndex: drop.marketIndex,
              userOrderId: drop.userOrderId,
              subaccount: this.config.subaccount,
            });
          } catch (cancelErr) {
            console.warn(
              `[DriftClient] Reconcile: failed to cancel duplicate working order ${drop.id}: ${cancelErr.message}`
            );
          }
          this.workingOrders.delete(drop.id);
          seenMarkets.set(keep.marketIndex, keep);
        } else {
          seenMarkets.set(workingOrder.marketIndex, workingOrder);
        }
      }

      const openOrderKeys = new Set(
        openOrders.map((o) => {
          const userOrderId =
            o.userOrderId !== undefined && o.userOrderId !== null
              ? Number(o.userOrderId)
              : "unknown";
          return `${o.marketIndex}:${userOrderId}`;
        })
      );

      // 1) Validate workingOrders against on-chain
      for (const [id, workingOrder] of this.workingOrders) {
        const key = `${workingOrder.marketIndex}:${workingOrder.userOrderId}`;
        const isOpen = openOrderKeys.has(key);

        if (!isOpen) {
          const position = positions.find(
            (p) => p.marketIndex === workingOrder.marketIndex && Math.abs(p.sizeBase || 0) > 0
          );
          if (position) {
            console.log(
              `[DriftClient] Reconcile: working order ${id} missing but position exists - marking filled.`
            );
            this._applyOnChainPosition(workingOrder, position);
          } else {
            console.log(
              `[DriftClient] Reconcile: working order ${id} missing and no position - removing.`
            );
            this.workingOrders.delete(id);
          }
        }
      }

      // 2) Handle on-chain orders not in workingOrders
      for (const order of openOrders) {
        const orderUserOrderId =
          order.userOrderId !== undefined && order.userOrderId !== null
            ? Number(order.userOrderId)
            : null;
        const hasWorking =
          orderUserOrderId !== null &&
          Array.from(this.workingOrders.values()).some(
            (wo) => wo.marketIndex === order.marketIndex && wo.userOrderId === orderUserOrderId
          );
        if (hasWorking) continue;

        // Cancel only bot-owned orders (must have userOrderId we recognize)
        // NOTE: userOrderId defaults to 0 for manually placed orders (Drift UI/SDK)
        // Bot-generated userOrderIds are always >= 1, so we exclude 0
        if (
          order.userOrderId !== undefined &&
          order.userOrderId !== null &&
          order.userOrderId !== 0
        ) {
          console.log(
            `[DriftClient] Reconcile: cancelling orphaned bot order userOrderId=${order.userOrderId} on market ${order.marketIndex}`
          );
          try {
            await this.subprocess.send("cancelOrderByUserOrderId", {
              marketIndex: order.marketIndex,
              userOrderId: Number(order.userOrderId),
              subaccount: this.config.subaccount,
            });
          } catch (cancelErr) {
            console.warn(
              `[DriftClient] Reconcile: failed to cancel orphaned order userOrderId=${order.userOrderId}: ${cancelErr.message}`
            );
          }
        } else {
          console.log(
            `[DriftClient] Reconcile: leaving unowned order on market ${order.marketIndex} untouched`
          );
        }
      }

      console.log("[DriftClient] ✅ Reconciliation complete");
    } catch (err) {
      console.error(`[DriftClient] Failed to reconcile state: ${err.message}`);
      // Don't fail initialization - just log the error
    }
  }

  _applyOnChainPosition(order, position) {
    const marketSymbol = driftLookup.getMarketByIndex(position.marketIndex) || order.market;
    const baseSize = Math.abs(position.sizeBase || 0);
    let entryPrice = 0;

    if (position.entryPrice && position.entryPrice > 0) {
      entryPrice = position.entryPrice;
    } else if (position.quoteEntryAmount && position.baseAssetAmount) {
      const quoteEntry = Math.abs(Number(position.quoteEntryAmount) / 1e6);
      const baseEntry = Math.abs(Number(position.baseAssetAmount) / 1e9);
      if (baseEntry > 0) {
        entryPrice = quoteEntry / baseEntry;
      }
    }

    if (!entryPrice || entryPrice <= 0) {
      entryPrice = order.limitPrice || 0;
    }

    const positionData = {
      positionId: order.id,
      clientOrderId: order.id,
      market: marketSymbol,
      marketSymbol,
      marketIndex: position.marketIndex,
      side: order.side,
      collateral: order.collateral,
      leverage: order.leverage,
      size: order.collateral * order.leverage,
      sizeUsd: order.collateral * order.leverage,
      baseSize: baseSize || order.size,
      entryPrice,
      openTime: Date.now(),
      execMode: ExecMode.MAKER,
      trade_type: "automated",
      venue: "drift",
    };

    this.positions.set(marketSymbol, positionData);
    this.emit("positionOpened", positionData);
    this.workingOrders.delete(order.id);
    this.stats.ordersFilled++;
    this.stats.makerFills++;
  }

  _emitPositionClosedOnce(payload) {
    const now = Date.now();
    const positionId = payload?.position?.positionId || payload?.positionId || null;
    const market = payload?.market || payload?.position?.market || null;
    const execMode = payload?.execMode || null;
    const exitReason = payload?.exitReason || null;
    const key = positionId
      ? `pos:${positionId}`
      : market
        ? `mkt:${market}:${execMode || ""}:${exitReason || ""}`
        : `anon:${JSON.stringify(payload).slice(0, 100)}`;

    const last = this._recentPositionClosedAt.get(key) || 0;
    if (now - last < this._recentPositionClosedTtlMs) {
      return false;
    }

    this._recentPositionClosedAt.set(key, now);
    if (this._recentPositionClosedAt.size > 1000) {
      for (const [k, ts] of this._recentPositionClosedAt) {
        if (now - ts > this._recentPositionClosedTtlMs * 2) {
          this._recentPositionClosedAt.delete(k);
        }
      }
    }

    this.emit("positionClosed", payload);
    return true;
  }

  /**
   * Validate active markets on startup and periodically.
   * Queries getPerpMarketAccount for each market to verify it exists and is tradeable.
   * Disables markets that fail validation.
   */
  async _validateActiveMarkets() {
    if (!this.subprocess || !this.initialized) {
      console.log("[DriftClient] Skipping market validation - not initialized");
      return;
    }

    const markets = this._getMarketsToSubscribe();
    console.log(`[DriftClient] Validating ${markets.length} active markets...`);

    const validationResults = [];

    for (const market of markets) {
      try {
        const marketIndex = driftLookup.getMarketIndex(market);
        if (marketIndex === null) {
          console.warn(`[DriftClient] Market ${market} not found in registry - disabling`);
          this._disableMarket(market, "NotInRegistry", "Market not found in local registry");
          validationResults.push({ market, valid: false, reason: "NotInRegistry" });
          continue;
        }

        // Query on-chain market account to verify it exists and is active
        const result = await this.subprocess.send("getPerpMarketAccount", { marketIndex });

        if (!result || result.note === "Market not found") {
          console.warn(
            `[DriftClient] Market ${market} (index ${marketIndex}) not found on-chain - disabling`
          );
          this._disableMarket(
            market,
            "PerpMarketNotFound",
            `Market index ${marketIndex} not found on-chain`
          );
          validationResults.push({
            market,
            valid: false,
            reason: "PerpMarketNotFound",
            marketIndex,
          });
          continue;
        }

        // Check market status (if available)
        if (result.status && typeof result.status === "object") {
          const statusKeys = Object.keys(result.status);
          if (statusKeys.includes("paused") || statusKeys.includes("settlementOnly")) {
            console.warn(`[DriftClient] Market ${market} is paused or settlement-only - disabling`);
            this._disableMarket(market, "MarketPaused", `Market status: ${statusKeys.join(", ")}`);
            validationResults.push({ market, valid: false, reason: "MarketPaused", marketIndex });
            continue;
          }
        }

        validationResults.push({ market, valid: true, marketIndex });
      } catch (err) {
        // If we get a specific error indicating market doesn't exist, disable it
        if (isPerpMarketNotFound(err)) {
          console.warn(
            `[DriftClient] Market ${market} validation failed with PerpMarketNotFound - disabling`
          );
          this._disableMarket(market, "PerpMarketNotFound", err.message);
          validationResults.push({
            market,
            valid: false,
            reason: "PerpMarketNotFound",
            error: err.message,
          });
        } else {
          // Other errors (network, etc.) - don't disable, just log
          console.warn(
            `[DriftClient] Market ${market} validation error (non-fatal): ${err.message}`
          );
          validationResults.push({
            market,
            valid: true,
            reason: "ValidationSkipped",
            error: err.message,
          });
        }
      }
    }

    const validCount = validationResults.filter((r) => r.valid).length;
    const invalidCount = validationResults.filter((r) => !r.valid).length;

    console.log(
      `[DriftClient] Market validation complete: ${validCount} valid, ${invalidCount} disabled`
    );

    if (invalidCount > 0) {
      console.log(
        `[DriftClient] Disabled markets: ${validationResults
          .filter((r) => !r.valid)
          .map((r) => r.market)
          .join(", ")}`
      );
    }
  }

  /**
   * Disable a market (prevents new positions on this market)
   * @param {string} market - Market symbol
   * @param {string} reason - Reason for disabling
   * @param {string} error - Error message
   */
  _disableMarket(market, reason, error) {
    this.disabledMarkets.set(market, {
      disabledAt: new Date().toISOString(),
      reason,
      error,
    });
    this.emit("marketDisabled", { market, reason, error });
  }

  /**
   * Re-enable a disabled market
   * @param {string} market - Market symbol
   * @returns {boolean} True if market was enabled
   */
  enableMarket(market) {
    if (!this.disabledMarkets.has(market)) return false;
    this.disabledMarkets.delete(market);
    this.emit("marketEnabled", { market });
    return true;
  }

  /**
   * Check if a market is disabled
   * @param {string} market - Market symbol
   * @returns {boolean}
   */
  isMarketDisabled(market) {
    return this.disabledMarkets.has(market);
  }

  /**
   * Get list of disabled markets
   * @returns {Array}
   */
  getDisabledMarkets() {
    return Array.from(this.disabledMarkets.entries()).map(([market, info]) => ({
      market,
      ...info,
    }));
  }

  /**
   * Start (or restart) the Drift subprocess
   */
  async _startSubprocess() {
    if (this._externalSubprocess) return;
    if (this._subprocessStartPromise) {
      await this._subprocessStartPromise;
      return;
    }

    const startPromise = (async () => {
      // Initialize SDK in subprocess
      const rpcUrls = this._getDriftRpcUrls();
      const preferredRpcUrl = this._getPreferredDriftRpcUrl(rpcUrls);
      const perpMarketIndexes = this._getPerpMarketIndexesForInit();
      const spotMarketIndexes = this._getSpotMarketIndexesForInit();

      if (!perpMarketIndexes || perpMarketIndexes.length === 0) {
        console.warn(
          "[DriftClient] No Drift markets to initialize; Drift client will stay disabled."
        );
        return;
      }

      // Always stop any existing subprocess before starting a new one to avoid overlapping
      // Drift SDK subscriptions and duplicated background work.
      if (this.subprocess && this.subprocess.process) {
        const existing = this.subprocess;
        try {
          this._expectedExitSubprocesses.add(existing);
          await existing.stop();
        } catch (stopErr) {
          console.warn(
            `[DriftClient] Failed to stop existing subprocess before start: ${stopErr.message}`
          );
        } finally {
          this._expectedExitSubprocesses.delete(existing);
        }
      }

      // Get wallet password securely (only when needed)
      let walletPassword = null;
      try {
        const { getWalletPasswordSync } = require("./utils/secure-password-loader");
        walletPassword = getWalletPasswordSync();
        console.log("[DriftClient] Wallet password loaded for subprocess");
      } catch (err) {
        console.warn("[DriftClient] Could not load wallet password:", err.message);
        // Will try WALLET_PASSWORD env var as fallback in subprocess
      }

      const subprocess = new DriftSubprocessClient({
        network: process.env.DRIFT_NETWORK || "mainnet-beta",
        walletPassword, // Pass directly, not via global env
      });
      this.subprocess = subprocess;

      // Listen for subprocess exit to auto-restart
      subprocess.on("exit", ({ code, signal }) => {
        if (this.subprocess !== subprocess) {
          console.log(
            `[DriftClient] Ignoring exit from stale subprocess (code=${code}, signal=${signal})`
          );
          return;
        }
        if (this._expectedExitSubprocesses.has(subprocess)) {
          this._expectedExitSubprocesses.delete(subprocess);
          console.log(
            `[DriftClient] Subprocess exited (expected) (code=${code}, signal=${signal})`
          );
          return;
        }
        console.error(
          `[DriftClient] ⚠️ Subprocess exited unexpectedly (code=${code}, signal=${signal})`
        );
        void this._handleSubprocessExit();
      });

      // Listen for subprocess error events (uncaught exceptions, unhandled rejections)
      subprocess.on("error", ({ type, message, stack }) => {
        console.error(`[DriftClient] ⚠️ Subprocess ${type}: ${message}`);
        if (stack) console.error(`[DriftClient] Stack: ${stack}`);
        this.emit("subprocessError", { type, message, stack });
      });

      await subprocess.start();

      // Clear password from memory immediately after subprocess starts
      walletPassword = null;
      if (global.gc) global.gc();

      const initParams = {
        env: process.env.DRIFT_NETWORK || process.env.DRIFT_CLUSTER || "mainnet-beta",
        subaccount: getConfiguredSubaccount(),
        rpcUrl: preferredRpcUrl,
        rpcUrls,
        perpMarketIndexes,
        spotMarketIndexes,
      };

      const maskedPreferred = preferredRpcUrl ? this._maskRpcUrl(preferredRpcUrl) : "none";
      const maskedList = rpcUrls.slice(0, 3).map((url) => this._maskRpcUrl(url));
      console.log(
        `[DriftClient] Drift RPC init: preferred=${maskedPreferred}, candidates=${maskedList.join(", ")}${rpcUrls.length > 3 ? "…" : ""}`
      );
      console.log(`[DriftClient] Drift init markets: perp=${perpMarketIndexes.length}`);
      const initResult = await subprocess.send("init", initParams);
      console.log("[DriftClient] SDK init result:", initResult);
      if (initResult && typeof initResult === "object") {
        const subType = initResult.accountSubscription || "unknown";
        const wsEndpoint = initResult.wsEndpoint || "n/a";
        console.log(`[DriftClient] Drift subscription: ${subType} (ws=${wsEndpoint})`);
        if (initResult.subscriptionHealth) {
          console.log("[DriftClient] Drift subscription health:", initResult.subscriptionHealth);
        }
        if (
          subType === "websocket" &&
          (!initResult.wsEndpoint || initResult.wsEndpoint === "n/a")
        ) {
          console.warn(
            "[DriftClient] ⚠️ Drift websocket subscription selected but wsEndpoint is missing"
          );
        }
      }
    })();

    this._subprocessStartPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this._subprocessStartPromise === startPromise) {
        this._subprocessStartPromise = null;
      }
    }
  }

  _getPerpMarketIndexesForInit() {
    const subscribeAll =
      String(process.env.DRIFT_SDK_SUBSCRIBE_ALL_MARKETS || "")
        .trim()
        .toLowerCase() === "true" ||
      String(process.env.DRIFT_SUBSCRIBE_ALL_MARKETS || "")
        .trim()
        .toLowerCase() === "true";

    // Only include markets that are actually routed to Drift by default. This reduces
    // subscription load/memory for the Drift SDK subprocess.
    //
    // If DRIFT_SDK_SUBSCRIBE_ALL_MARKETS=true, subscribe to the full Drift registry so the SDK
    // never throws `...reading 'dataAndSlot'` when it needs a market account due to user state.
    let markets = subscribeAll ? driftLookup.getTradeableMarkets() : this._getMarketsToSubscribe();
    if (subscribeAll) {
      console.log(`[DriftClient] Drift SDK subscribe-all enabled: perp=${markets.length}`);
    }

    const indexes = [];
    for (const market of markets) {
      const marketIndex = driftLookup.getMarketIndex(market);
      if (Number.isFinite(marketIndex)) {
        indexes.push(marketIndex);
      } else {
        console.warn(`[DriftClient] Missing market index for ${market} during init`);
      }
    }

    const unique = Array.from(new Set(indexes));
    return unique.sort((a, b) => a - b);
  }

  _getSpotMarketIndexesForInit() {
    const indexes = [0]; // QUOTE_SPOT_MARKET_INDEX (USDC)

    const raw = process.env.DRIFT_SPOT_MARKET_INDEXES;
    if (raw && String(raw).trim()) {
      const extra = String(raw)
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value));
      indexes.push(...extra);
    }

    return Array.from(new Set(indexes)).sort((a, b) => a - b);
  }

  _getDriftRpcUrls() {
    const urls = [];
    const add = (value) => {
      if (!value) return;
      if (Array.isArray(value)) {
        for (const v of value) add(v);
        return;
      }
      const str = String(value).trim();
      if (!str) return;
      if (str.includes(",")) {
        for (const part of str.split(",")) add(part);
        return;
      }
      urls.push(str);
    };

    add(process.env.DRIFT_RPC_URLS);
    add(process.env.DRIFT_RPC_URL);
    add(process.env.RPC_HELIUS_URL);
    add(process.env.RPC_QUICKNODE_URL);
    add(process.env.RPC_TRITON_URL);
    add(process.env.RPC_TATUM_URL);
    add(process.env.RPC_FALLBACK_URL);
    add(process.env.RPC_URL);
    add(process.env.SOLANA_RPC_URL);

    let unique = Array.from(new Set(urls));

    const isDefaultPublicRpc = (url) => {
      const raw = String(url || "").toLowerCase();
      return raw.includes("api.mainnet-beta.solana.com") || raw.includes("api.devnet.solana.com");
    };
    const allowPublicFallback = process.env.DRIFT_ALLOW_PUBLIC_RPC_FALLBACK !== "false";
    const driftEnv = process.env.DRIFT_NETWORK || process.env.DRIFT_CLUSTER || "mainnet-beta";
    const defaultPublicFallback = driftEnv.includes("devnet")
      ? "https://api.devnet.solana.com"
      : "https://api.mainnet-beta.solana.com";

    const hasPaidRpc = Boolean(
      process.env.DRIFT_RPC_URL ||
      process.env.RPC_SYNDICA_URL ||
      process.env.RPC_HELIUS_URL ||
      process.env.RPC_QUICKNODE_URL ||
      process.env.RPC_TRITON_URL ||
      process.env.RPC_TATUM_URL
    );
    if (hasPaidRpc) {
      const publicCandidates = unique.filter(isDefaultPublicRpc);
      unique = unique.filter((url) => !isDefaultPublicRpc(url));

      if (allowPublicFallback) {
        const fallbackPublic =
          publicCandidates[0] ||
          (isDefaultPublicRpc(process.env.RPC_URL) ? process.env.RPC_URL : null) ||
          (isDefaultPublicRpc(process.env.SOLANA_RPC_URL) ? process.env.SOLANA_RPC_URL : null) ||
          defaultPublicFallback;
        if (fallbackPublic && !unique.includes(fallbackPublic)) {
          unique.push(fallbackPublic);
        }
      }
    }

    const syndicaUrl = process.env.RPC_SYNDICA_URL;
    if (syndicaUrl) {
      const idx = unique.indexOf(syndicaUrl);
      if (idx === -1) {
        unique.unshift(syndicaUrl);
      } else if (idx > 0) {
        unique.splice(idx, 1);
        unique.unshift(syndicaUrl);
      }
    }

    return unique;
  }

  _getPreferredDriftRpcUrl(rpcUrls = []) {
    const preferredProvider = process.env.DRIFT_RPC_PROVIDER || process.env.RPC_PROVIDER;
    if (preferredProvider === "syndica" && process.env.RPC_SYNDICA_URL) {
      return process.env.RPC_SYNDICA_URL;
    }
    if (process.env.DRIFT_RPC_URL) return process.env.DRIFT_RPC_URL;
    if (process.env.RPC_SYNDICA_URL) return process.env.RPC_SYNDICA_URL;
    if (process.env.RPC_HELIUS_URL) return process.env.RPC_HELIUS_URL;
    if (process.env.RPC_QUICKNODE_URL) return process.env.RPC_QUICKNODE_URL;
    if (process.env.RPC_TRITON_URL) return process.env.RPC_TRITON_URL;
    if (process.env.RPC_TATUM_URL) return process.env.RPC_TATUM_URL;
    if (process.env.RPC_FALLBACK_URL) return process.env.RPC_FALLBACK_URL;
    if (process.env.RPC_URL) return process.env.RPC_URL;
    if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
    return rpcUrls[0];
  }

  _maskRpcUrl(url) {
    if (!url) return "";
    const raw = String(url);
    return raw
      .replace(/(api-key=)[^&]+/i, "$1***")
      .replace(/(token=)[^&]+/i, "$1***")
      .replace(/(key=)[^&]+/i, "$1***")
      .replace(/\/\/.*?@/, "//***@");
  }

  _getRestartDelayMs(attempt) {
    const base = Number(process.env.DRIFT_SUBPROCESS_RESTART_BASE_DELAY_MS) || 10000;
    const max = Number(process.env.DRIFT_SUBPROCESS_RESTART_MAX_DELAY_MS) || 60000;
    const boundedAttempt = Math.max(1, Number(attempt) || 1);
    return Math.min(base * boundedAttempt, max);
  }

  /**
   * Handle subprocess exit - attempt auto-restart with CPU-conscious throttling
   */
  async _handleSubprocessExit() {
    if (this._externalSubprocess) return;
    if (this._subprocessRestartPromise) {
      await this._subprocessRestartPromise;
      return;
    }

    const restartPromise = (async () => {
      const maxRestarts = Number(process.env.DRIFT_SUBPROCESS_MAX_RESTARTS) || 5;

      while (true) {
        this._restartAttempts = (this._restartAttempts || 0) + 1;

        if (this._restartAttempts > maxRestarts) {
          console.error(
            `[DriftClient] ❌ Max restart attempts (${maxRestarts}) exceeded. Manual intervention required.`
          );
          this.emit("subprocessFailed", { attempts: this._restartAttempts });
          return;
        }

        const restartDelay = this._getRestartDelayMs(this._restartAttempts);
        console.log(
          `[DriftClient] Attempting subprocess restart (${this._restartAttempts}/${maxRestarts}) in ${restartDelay / 1000}s...`
        );
        console.log(
          "[DriftClient] CPU cooldown: Drift SDK subscribe() is CPU-intensive, using longer delays"
        );

        await new Promise((r) => setTimeout(r, restartDelay));

        try {
          await this._startSubprocess();
          console.log(
            `[DriftClient] ✅ Subprocess restarted successfully (attempt ${this._restartAttempts})`
          );
          this._restartAttempts = 0;
          await this._reconcileState();
          this.emit("subprocessRestarted");
          return;
        } catch (err) {
          console.error(`[DriftClient] Failed to restart subprocess: ${err.message}`);
          // Continue loop to retry with backoff.
        }
      }
    })();

    this._subprocessRestartPromise = restartPromise;
    try {
      await restartPromise;
    } finally {
      if (this._subprocessRestartPromise === restartPromise) {
        this._subprocessRestartPromise = null;
      }
    }
  }

  /**
   * Ensure subprocess is running, restart if necessary
   */
  async _ensureSubprocess() {
    if (this._externalSubprocess) return;

    if (this._subprocessRestartPromise) {
      await this._subprocessRestartPromise;
      return;
    }

    if (this._subprocessStartPromise) {
      await this._subprocessStartPromise;
      return;
    }

    if (!this.subprocess || !this.subprocess.process) {
      console.warn("[DriftClient] Subprocess not running, attempting restart...");
      await this._handleSubprocessExit();
    }
  }

  /**
   * Start periodic subprocess health monitoring
   */
  _startHealthMonitor() {
    // Check subprocess health every 5 minutes
    const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
    const MEMORY_WARNING_MB = 500; // Warn if subprocess uses > 500MB
    const MEMORY_CRITICAL_MB = 800; // Restart if subprocess uses > 800MB

    this._healthMonitorTimer = setInterval(async () => {
      if (!this.subprocess || !this.subprocess.process) {
        return;
      }

      try {
        const health = await this.subprocess.send("ping", {});
        if (health && health.memory) {
          const { rssMB, heapUsedMB } = health.memory;
          console.log(
            `[DriftClient] Subprocess health: RSS=${rssMB}MB, Heap=${heapUsedMB}MB, Uptime=${health.uptimeSeconds}s`
          );

          if (rssMB >= MEMORY_CRITICAL_MB) {
            console.error(
              `[DriftClient] ⚠️ Subprocess memory CRITICAL (${rssMB}MB >= ${MEMORY_CRITICAL_MB}MB). Scheduling restart...`
            );
            this.emit("subprocessMemoryCritical", { rssMB, heapUsedMB });
            // Don't restart immediately - let it finish current operations
            // The next natural restart opportunity will clean it up
          } else if (rssMB >= MEMORY_WARNING_MB) {
            console.warn(
              `[DriftClient] Subprocess memory HIGH (${rssMB}MB >= ${MEMORY_WARNING_MB}MB)`
            );
            this.emit("subprocessMemoryWarning", { rssMB, heapUsedMB });
          }
        }
      } catch (err) {
        console.warn(`[DriftClient] Health check failed: ${err.message}`);
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  /**
   * Shutdown the client
   */
  async shutdown() {
    if (this._orderMonitorTimer) {
      clearInterval(this._orderMonitorTimer);
    }
    if (this._orderSyncTimer) {
      clearInterval(this._orderSyncTimer);
    }
    if (this._healthMonitorTimer) {
      clearInterval(this._healthMonitorTimer);
    }
    if (this._divergenceAnalysisInterval) {
      clearInterval(this._divergenceAnalysisInterval);
    }
    if (this.dlobClient) {
      this.dlobClient.disconnect();
      this.dlobClient = null;
    }
    if (this.subprocess) {
      this._expectedExitSubprocesses.add(this.subprocess);
      await this.subprocess.stop();
      this._expectedExitSubprocesses.delete(this.subprocess);
    }
    this.initialized = false;
    this.markPriceInitialized = false;
  }

  /**
   * Get market price for indicators/signals (Pyth WS primary, oracle fallback)
   * @param {string} symbol - Market symbol (e.g., 'SOL', 'SOL-PERP')
   */
  async getMarketPrice(symbol) {
    return this.getPythPrice(symbol);
  }

  /**
   * Get Pyth oracle price for indicators/signals
   * @param {string} symbol - Market symbol (e.g., 'SOL', 'SOL-PERP')
   */
  async getPythPrice(symbol) {
    const market = symbol.includes("-PERP") ? symbol : `${symbol}-PERP`;
    const normalizedSymbol = symbol.replace("-PERP", "");
    const pythData = this._getPythOraclePriceData(market);

    if (pythData && Number.isFinite(pythData.price) && pythData.price > 0) {
      this.priceCache.set(normalizedSymbol, {
        price: pythData.price,
        ts: Date.now(),
        source: "pyth",
      });
      this._pythMissingLogged.delete(market);
      this._maybeWarnPythConfidence(market, pythData);
      this._feedPythOraclePriceAsync(market);
      return pythData.price;
    }

    this._warnPythMissing(market);
    return this._getOraclePriceFallback(symbol);
  }

  /**
   * Get Pyth oracle price data for a market (price + timestamp)
   * Uses PriceProvider Pyth WS data only (no RPC).
   */
  _getPythOraclePriceData(market) {
    if (!this.priceProvider || typeof this.priceProvider.getPythPriceData !== "function") {
      return null;
    }
    const pythData = this.priceProvider.getPythPriceData(market);
    if (!pythData || !Number.isFinite(pythData.price)) {
      return null;
    }
    const publishTime = Number(pythData.metadata?.publishTime || 0);
    const timestamp = publishTime > 0 ? publishTime : pythData.timestamp;
    return {
      price: pythData.price,
      timestamp,
      metadata: pythData.metadata || null,
      source: pythData.source || "pyth-ws",
    };
  }

  _warnPythMissing(market) {
    if (this._pythMissingLogged.has(market)) return;
    this._pythMissingLogged.add(market);
    console.warn(`[DriftClient] ${market}: Pyth price unavailable or stale, using oracle fallback`);
  }

  _maybeWarnPythConfidence(market, pythData) {
    if (!pythData?.metadata || !Number.isFinite(pythData.metadata.conf)) return;
    const price = pythData.price;
    const conf = Number(pythData.metadata.conf);
    if (!Number.isFinite(price) || price <= 0 || conf <= 0) return;
    const ratio = conf / price;
    if (ratio <= this._pythMaxConfRatio || this._pythWideConfLogged.has(market)) return;
    this._pythWideConfLogged.add(market);
    console.warn(
      `[DriftClient] ${market}: Pyth confidence wide (${(ratio * 100).toFixed(2)}% > ${(this._pythMaxConfRatio * 100).toFixed(2)}%)`
    );
  }

  /**
   * Feed Pyth oracle price to mark price constructor for divergence checks
   * Called asynchronously to avoid blocking price fetch
   */
  async _feedPythOraclePriceAsync(market) {
    try {
      if (!this.markPriceConstructor) return;
      const lastTs = this._oracleFeedLast.get(market) || 0;
      const now = Date.now();
      if (now - lastTs < this._oracleFeedMinMs) {
        return;
      }
      this._oracleFeedLast.set(market, now);
      const pythData = this._getPythOraclePriceData(market);
      if (pythData && this.markPriceConstructor) {
        this.markPriceConstructor.updateOraclePrice(market, pythData.price, pythData.timestamp);
      }
    } catch (e) {
      // Ignore errors - oracle feed is for monitoring only
    }
  }

  /**
   * Get oracle price (fallback when mark price unavailable)
   * @param {string} symbol - Market symbol
   */
  async _getOraclePriceFallback(symbol) {
    const normalizedSymbol = symbol.replace("-PERP", "");

    // Check cache first
    const cached = this.priceCache.get(normalizedSymbol);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return cached.price;
    }

    if (this.priceProvider && typeof this.priceProvider.getPrice === "function") {
      const sym = String(symbol || "");
      const marketKey = sym.includes("-PERP") ? sym : `${sym}-PERP`;
      const baseKey = sym.replace("-PERP", "");

      // Prefer the full market key first (what upstream providers typically cache under),
      // then fall back to the original symbol and base alias.
      const candidates = [];
      for (const key of [marketKey, sym, baseKey]) {
        if (key && !candidates.includes(key)) candidates.push(key);
      }

      for (const key of candidates) {
        const priceData = this.priceProvider.getPrice(key);
        if (priceData && Number.isFinite(priceData.price)) {
          const price = priceData.price;
          this.priceCache.set(normalizedSymbol, {
            price,
            ts: Date.now(),
            source: priceData.source || "oracle",
          });
          return price;
        }
      }
    }

    throw new Error(`Price not available for ${symbol} - price provider unavailable`);
  }

  /**
   * Get oracle price directly (for divergence guardrails and monitoring)
   * @param {string} symbol - Market symbol
   */
  async getOraclePrice(symbol) {
    return this._getOraclePriceFallback(symbol);
  }

  /**
   * Get mark price directly from DLOB (for explicit mark price requests)
   * @param {string} symbol - Market symbol
   */
  getMarkPrice(symbol) {
    if (!this.useMarkPrice || !this.markPriceInitialized || !this.markPriceConstructor) {
      return null;
    }
    const market = symbol.includes("-PERP") ? symbol : `${symbol}-PERP`;
    return this.markPriceConstructor.getMarkPrice(market);
  }

  /**
   * Get mark TWAP 5m
   * @param {string} symbol - Market symbol
   */
  getMarkTwap5m(symbol) {
    if (!this.markPriceConstructor) return null;
    const market = symbol.includes("-PERP") ? symbol : `${symbol}-PERP`;
    return this.markPriceConstructor.getMarkTwap5m(market);
  }

  /**
   * Get mark TWAP 1h
   * @param {string} symbol - Market symbol
   */
  getMarkTwap1h(symbol) {
    if (!this.markPriceConstructor) return null;
    const market = symbol.includes("-PERP") ? symbol : `${symbol}-PERP`;
    return this.markPriceConstructor.getMarkTwap1h(market);
  }

  /**
   * Get reference price for limit orders based on DRIFT_LIMIT_REF_PRICE setting
   * Supports: 'mark' (default), 'mid', 'oracle', 'last'
   * @param {string} symbol - Market symbol
   * @returns {Promise<number>} Reference price for limit order placement
   */
  async _getLimitRefPrice(symbol) {
    const refPriceSource = (process.env.DRIFT_LIMIT_REF_PRICE || "mark").toLowerCase();
    const market = symbol.includes("-PERP") ? symbol : `${symbol}-PERP`;
    const normalizedSymbol = symbol.replace("-PERP", "");

    switch (refPriceSource) {
      case "mark":
      case "mid":
        // Use constructed mark price (BBO mid) from DLOB WebSocket
        if (this.useMarkPrice && this.markPriceInitialized && this.markPriceConstructor) {
          const markPrice = this.markPriceConstructor.getMarkPrice(market);
          if (markPrice !== null && Number.isFinite(markPrice) && markPrice > 0) {
            return markPrice;
          }
        }
        // Fallback to oracle if mark unavailable
        return this._getOraclePriceFallback(symbol);

      case "oracle":
        // Use oracle price directly
        return this._getOraclePriceFallback(symbol);

      case "last": {
        // Use last trade price (from cache or oracle fallback)
        const cached = this.priceCache.get(normalizedSymbol);
        if (cached && cached.price) {
          return cached.price;
        }
        return this._getOraclePriceFallback(symbol);
      }

      default:
        console.warn(`[DriftClient] Unknown DRIFT_LIMIT_REF_PRICE: ${refPriceSource}, using mark`);
        if (this.useMarkPrice && this.markPriceInitialized && this.markPriceConstructor) {
          const markPrice = this.markPriceConstructor.getMarkPrice(market);
          if (markPrice !== null && Number.isFinite(markPrice) && markPrice > 0) {
            return markPrice;
          }
        }
        return this._getOraclePriceFallback(symbol);
    }
  }

  /**
   * Get price analysis for monitoring
   * @param {string} symbol - Market symbol
   */
  getPriceAnalysis(symbol) {
    if (!this.markPriceConstructor) return null;
    const market = symbol.includes("-PERP") ? symbol : `${symbol}-PERP`;
    return this.markPriceConstructor.getPriceAnalysis(market);
  }

  /**
   * Get multiple market prices
   * @param {string[]} symbols - Array of symbols
   */
  async getMarketPricesBatch(symbols) {
    const prices = {};

    // Fetch in parallel
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          prices[symbol] = await this.getMarketPrice(symbol);
        } catch (e) {
          console.warn(`[DriftClient] Failed to get price for ${symbol}: ${e.message}`);
        }
      })
    );

    return prices;
  }

  /**
   * Open a position (taker or maker based on config)
   * @param {string} side - 'long' or 'short'
   * @param {number} collateral - Collateral amount in USD
   * @param {number} leverage - Leverage multiplier
   * @param {number} entryPrice - Current market price for reference
   * @param {string} clientOrderId - Optional client order ID
   * @param {Object} options - Additional options (market, execMode override)
   */
  async openPosition(side, collateral, leverage, entryPrice, clientOrderId, options = {}) {
    await this._ensureInitialized();

    const market = options.market || this.config.currentMarket;

    if (!market) {
      throw new Error("Market not specified");
    }

    // Use market-specific exec mode from isolated strategy env
    // This prevents .env.rsi-reversion from overwriting .env.rsi-reversion-alts settings
    const execMode = options.execMode || getExecModeForMarket(market);

    console.log(
      `[DriftClient] Market ${market}: execMode=${execMode}, leverage=${getLeverageForMarket(market)}`
    );

    const marketIndex = driftLookup.getMarketIndex(market);
    if (marketIndex === null) {
      throw new Error(`Unknown market: ${market}`);
    }

    // Check if market is disabled (due to PerpMarketNotFound or validation failure)
    if (this.disabledMarkets.has(market)) {
      const disabledInfo = this.disabledMarkets.get(market);
      throw new Error(
        `Market ${market} is disabled: ${disabledInfo.reason} (since ${disabledInfo.disabledAt})`
      );
    }

    // SAFETY CHECK: Verify no existing position on same market/side before opening
    // This prevents duplicate positions when the bot doesn't track successfully opened trades
    if (!this.config.paperTradingMode) {
      try {
        const existingPositions = await this.getAllOpenPositions({ requireLive: true });
        const existingOnSameMarketSide = existingPositions.find(
          (p) =>
            (p.market === market || p.marketIndex === marketIndex) &&
            p.side?.toLowerCase() === side.toLowerCase()
        );

        if (existingOnSameMarketSide) {
          console.warn(
            `[DriftClient] DUPLICATE PREVENTION: Already have ${side} position on ${market}. ` +
              `Size: $${existingOnSameMarketSide.sizeUsd?.toFixed(2) || "unknown"}. Skipping duplicate open.`
          );

          // Add to local cache if not already tracked
          if (!this.positions.has(market)) {
            this.positions.set(market, existingOnSameMarketSide);
            console.log(`[DriftClient] Added existing position to local cache: ${market} ${side}`);
          }

          return existingOnSameMarketSide;
        }
      } catch (e) {
        console.warn(
          `[DriftClient] Position snapshot unavailable: ${e.message}. Aborting open to prevent duplicates.`
        );
        const err = new Error(
          "Position snapshot unavailable - aborting open to prevent duplicates"
        );
        err.code = e.code || "POSITIONS_UNAVAILABLE";
        throw err;
      }
    }

    // Calculate position size
    const notionalSize = collateral * leverage;
    const baseSize = notionalSize / entryPrice;

    // Paper trading mode
    if (this.config.paperTradingMode) {
      return this._paperOpen(
        side,
        collateral,
        leverage,
        entryPrice,
        clientOrderId,
        market,
        baseSize
      );
    }

    // ORACLE STALENESS CHECK: handled upstream by PriceProvider freshness checks.
    // Strategy signals use Pyth prices; execution uses mark price via _getLimitRefPrice().

    // Route to appropriate execution mode
    if (execMode === ExecMode.MAKER) {
      return this._openMaker(
        side,
        collateral,
        leverage,
        entryPrice,
        clientOrderId,
        market,
        marketIndex,
        baseSize
      );
    } else {
      return this._openTaker(
        side,
        collateral,
        leverage,
        entryPrice,
        clientOrderId,
        market,
        marketIndex,
        baseSize
      );
    }
  }

  /**
   * Open position with taker (market) order
   */
  async _openTaker(
    side,
    collateral,
    leverage,
    entryPrice,
    clientOrderId,
    market,
    marketIndex,
    baseSize
  ) {
    const orderId = clientOrderId || `drift-taker-${Date.now()}`;
    const userOrderId = this._generateUserOrderId(marketIndex, "entry");

    console.log(
      `[DriftClient] Opening TAKER ${side} position on ${market}: $${collateral.toFixed(2)} @ ${leverage}x`
    );

    // Pre-validation: Check for NaN, undefined, or invalid values
    const orderParams = {
      marketIndex,
      side: side.toLowerCase(),
      baseAssetAmount: baseSize,
      reduceOnly: false,
      userOrderId,
    };

    console.log(
      `[DriftClient] Taker order params BEFORE send:`,
      JSON.stringify({
        marketIndex: orderParams.marketIndex,
        marketIndexType: typeof orderParams.marketIndex,
        side: orderParams.side,
        baseAssetAmount: orderParams.baseAssetAmount,
        baseAssetAmountType: typeof orderParams.baseAssetAmount,
        baseAssetAmountIsNaN: Number.isNaN(orderParams.baseAssetAmount),
      })
    );

    // Validate critical params before sending
    if (orderParams.marketIndex === undefined || orderParams.marketIndex === null) {
      throw new Error(`[DriftClient] marketIndex is invalid: ${orderParams.marketIndex}`);
    }
    if (!orderParams.side) {
      throw new Error(`[DriftClient] side is invalid: ${orderParams.side}`);
    }
    if (!Number.isFinite(orderParams.baseAssetAmount) || orderParams.baseAssetAmount <= 0) {
      throw new Error(`[DriftClient] baseAssetAmount is invalid: ${orderParams.baseAssetAmount}`);
    }

    let result;
    try {
      result = await this.subprocess.send("placeMarketOrder", orderParams);
    } catch (err) {
      // Handle PerpMarketNotFound: disable market and re-throw
      if (isPerpMarketNotFound(err)) {
        console.error(
          `[DriftClient] PerpMarketNotFound for ${market} (index ${marketIndex}) - disabling market`
        );
        this._disableMarket(market, "PerpMarketNotFound", err.message);
        throw err;
      }

      // Handle command timeout: check if position was created on-chain
      // CRITICAL: Don't throw immediately - the order may have succeeded but IPC timed out
      if (this._isCommandTimeoutError(err)) {
        console.warn(
          `[DriftClient] placeMarketOrder timed out for ${market} - checking on-chain state...`
        );

        // Enter uncertainty window to prevent orphan cancellation
        this._enterUncertaintyWindow(`placeMarketOrder timeout for ${market}`, 120000); // 2 minutes

        const adoptedPosition = await this._tryAdoptOnChainPosition(
          market,
          marketIndex,
          side,
          collateral,
          leverage,
          orderId
        );
        if (adoptedPosition) {
          console.log(
            `[DriftClient] ✅ Position adopted from on-chain after timeout: ${market} ${side}`
          );
          return adoptedPosition;
        }
        console.warn(`[DriftClient] No position found on-chain after timeout for ${market}`);
        // Re-throw with clear indication this was a timeout with unknown result
        const timeoutErr = new Error(
          `openPosition timed out and no position found on-chain: ${err.message}`
        );
        timeoutErr.code = "TIMEOUT_UNKNOWN_RESULT";
        throw timeoutErr;
      }

      throw err;
    }

    // BUG FIX: Subprocess returns txSignature, not orderId
    // Check for successful submission (txSignature) or simulation (orderId)
    const txId = result.txSignature || result.orderId;
    if (!txId) {
      // Check if the error message indicates PerpMarketNotFound
      if (isPerpMarketNotFound(result.error || "")) {
        console.error(
          `[DriftClient] PerpMarketNotFound for ${market} (index ${marketIndex}) - disabling market`
        );
        this._disableMarket(market, "PerpMarketNotFound", result.error);
      }
      throw new Error(
        `Failed to open position: ${result.error || "No transaction signature returned"}`
      );
    }

    const confirmation = result.txSignature
      ? await this._confirmTransaction(result.txSignature, 30000)
      : { confirmed: false, failed: true, error: "No txSignature provided" };

    if (!confirmation.confirmed) {
      console.warn(
        `[DriftClient] TAKER open not confirmed for ${market} (tx=${txId}) - checking on-chain position...`
      );
      this._enterUncertaintyWindow(`TAKER open unconfirmed for ${market}`, 120000);

      const adoptedPosition = await this._tryAdoptOnChainPosition(
        market,
        marketIndex,
        side,
        collateral,
        leverage,
        orderId
      );
      if (adoptedPosition) {
        adoptedPosition.txSignature = result.txSignature || adoptedPosition.txSignature || null;
        this.stats.ordersPlaced++;
        this.stats.takerFills++;
        this.stats.ordersFilled++;
        console.log(
          `[DriftClient] ✅ Position verified on-chain despite unconfirmed tx: ${market} ${side}`
        );
        return adoptedPosition;
      }

      if (confirmation.failed) {
        const err = new Error(
          `openPosition failed: tx ${txId} not confirmed (${confirmation.error || "unknown"})`
        );
        err.code = "TX_FAILED";
        throw err;
      }

      const err = new Error(`openPosition confirmation timeout for ${market} (tx ${txId})`);
      err.code = "TX_CONFIRM_TIMEOUT";
      throw err;
    }

    console.log(
      `[DriftClient] Position submitted and confirmed: ${txId} (status: ${result.status})`
    );

    this.stats.ordersPlaced++;
    this.stats.takerFills++;
    this.stats.ordersFilled++;

    const position = {
      positionId: txId,
      clientOrderId: orderId,
      market,
      marketSymbol: market, // For getAllOpenPositions lookup
      marketIndex,
      side: side.toLowerCase(),
      collateral,
      leverage,
      size: collateral * leverage,
      sizeUsd: collateral * leverage, // For compatibility
      baseSize,
      entryPrice,
      openTime: Date.now(),
      liquidationPrice: this._calculateLiqPrice(entryPrice, leverage, side),
      execMode: ExecMode.TAKER,
      trade_type: "automated", // CRITICAL: Mark as bot-opened
      driftOrderId: txId,
      txSignature: result.txSignature,
      venue: "drift",
    };

    this.positions.set(market, position);
    this.emit("positionOpened", position);

    return position;
  }

  /**
   * Open position with maker (limit post-only) order
   *
   * Handles PlacePostOnlyLimitFailure (error 6057) by:
   * 1. Widening the offset (moving price further from spread)
   * 2. Retrying maker placement up to MAX_POST_ONLY_RETRIES times
   * 3. Falling back to taker if still failing and fallbackToTaker is enabled
   */
  async _openMaker(
    side,
    collateral,
    leverage,
    entryPrice,
    clientOrderId,
    market,
    marketIndex,
    baseSize
  ) {
    const orderId = clientOrderId || `drift-maker-${Date.now()}`;
    const limitCfg = parseLimitOrderConfig({ market });

    // Enforce one working maker order per market
    const existingWorking = this._getWorkingOrderByMarketIndex(marketIndex);
    if (existingWorking) {
      console.warn(
        `[DriftClient] Maker order already working for ${market} (userOrderId=${existingWorking.userOrderId}). Skipping new order.`
      );
      return {
        positionId: existingWorking.id,
        clientOrderId: existingWorking.id,
        market,
        marketIndex,
        side: existingWorking.side,
        collateral: existingWorking.collateral,
        leverage: existingWorking.leverage,
        size: existingWorking.collateral * existingWorking.leverage,
        baseSize: existingWorking.size,
        entryPrice: null,
        limitPrice: existingWorking.limitPrice,
        openTime: existingWorking.createdAt,
        liquidationPrice: null,
        execMode: ExecMode.MAKER,
        status: "already_working",
        driftOrderId: existingWorking.driftOrderId,
        txSignature: existingWorking.txSignature,
      };
    }

    // Get reference price for limit order (respects DRIFT_LIMIT_REF_PRICE)
    // Defaults to mark price from DLOB, with fallback to oracle
    const refPrice = await this._getLimitRefPrice(market);

    // PostOnly retry configuration
    const MAX_POST_ONLY_RETRIES = Number(process.env.DRIFT_POST_ONLY_MAX_RETRIES) || 3;
    const POST_ONLY_OFFSET_INCREMENT_BPS =
      Number(process.env.DRIFT_POST_ONLY_OFFSET_INCREMENT_BPS) || 5; // 5bps per retry

    // Calculate initial limit price with offset
    // BUG FIX: Use entryOffsetBps (the correct key) instead of entryBps
    let currentOffsetBps = limitCfg.entryOffsetBps ?? 10; // Default 10bps if not set

    let postOnlyAttempt = 0;
    let lastPostOnlyError = null;

    while (postOnlyAttempt < MAX_POST_ONLY_RETRIES) {
      postOnlyAttempt++;

      const offsetMultiplier =
        side.toLowerCase() === "long"
          ? 1 - currentOffsetBps / 10000 // Buy below market
          : 1 + currentOffsetBps / 10000; // Sell above market
      const limitPrice = refPrice * offsetMultiplier;

      const refPriceSource = process.env.DRIFT_LIMIT_REF_PRICE || "mark";
      console.log(
        `[DriftClient] Placing MAKER ${side} limit on ${market}: $${collateral.toFixed(2)} @ ${leverage}x, limit=$${limitPrice.toFixed(4)} (${currentOffsetBps}bps from ${refPriceSource}=$${refPrice.toFixed(4)})${postOnlyAttempt > 1 ? ` [post-only retry ${postOnlyAttempt}/${MAX_POST_ONLY_RETRIES}]` : ""}`
      );

      // Pre-validation: Check for NaN, undefined, or invalid values BEFORE sending to subprocess
      const userOrderId = this._generateUserOrderId(marketIndex, "entry");
      const orderParams = {
        marketIndex,
        side: side.toLowerCase(),
        baseAssetAmount: baseSize,
        price: limitPrice,
        postOnly: limitCfg.postOnly,
        reduceOnly: false,
        userOrderId,
      };

      // Log params only on first attempt to reduce noise
      if (postOnlyAttempt === 1) {
        console.log(
          `[DriftClient] Order params:`,
          JSON.stringify({
            marketIndex: orderParams.marketIndex,
            side: orderParams.side,
            baseAssetAmount: orderParams.baseAssetAmount,
            price: orderParams.price,
          })
        );
      }

      // Validate critical params before sending
      if (orderParams.marketIndex === undefined || orderParams.marketIndex === null) {
        throw new Error(`[DriftClient] marketIndex is invalid: ${orderParams.marketIndex}`);
      }
      if (!orderParams.side) {
        throw new Error(`[DriftClient] side is invalid: ${orderParams.side}`);
      }
      if (!Number.isFinite(orderParams.baseAssetAmount) || orderParams.baseAssetAmount <= 0) {
        throw new Error(`[DriftClient] baseAssetAmount is invalid: ${orderParams.baseAssetAmount}`);
      }
      if (!Number.isFinite(orderParams.price) || orderParams.price <= 0) {
        throw new Error(`[DriftClient] price is invalid: ${orderParams.price}`);
      }

      // Persist order state before network call (fail-closed on RPC errors)
      const workingOrder = new WorkingOrder({
        id: orderId,
        market,
        marketIndex,
        userOrderId,
        side: side.toLowerCase(),
        size: baseSize,
        limitPrice,
        collateral,
        leverage,
        entryPriceRef: refPrice, // Use reference price (mark/oracle based on DRIFT_LIMIT_REF_PRICE)
      });
      this.workingOrders.set(orderId, workingOrder);

      let result;
      try {
        result = await this.subprocess.send("placeLimitOrder", orderParams);

        // Handle deduped case: order already exists on-chain, remove from local tracking
        // This prevents orphaned WorkingOrders when deduped responses have no txSignature
        if (result.status === "deduped" && !result.txSignature) {
          this.workingOrders.delete(orderId);
          console.log(
            `[DriftClient] Limit order deduped - order already exists on-chain for market ${marketIndex}`
          );
          // Return gracefully - order already exists, no need to track locally
          return {
            positionId: orderId,
            clientOrderId: orderId,
            market,
            marketIndex,
            side: side.toLowerCase(),
            collateral,
            leverage,
            size: collateral * leverage,
            baseSize,
            entryPrice: null,
            limitPrice,
            status: "deduped",
          };
        }

        // BUG FIX: Subprocess returns txSignature, not orderId
        // Check for successful submission (txSignature) or simulation (orderId)
        const txId = result.txSignature || result.orderId;
        if (!txId) {
          this.workingOrders.delete(orderId);

          // Check if error is PostOnlyFailure
          const errorMsg = result.error || "No transaction signature returned";
          if (isPostOnlyFailure(errorMsg)) {
            lastPostOnlyError = new Error(errorMsg);
            console.warn(
              `[DriftClient] PostOnly failure (attempt ${postOnlyAttempt}/${MAX_POST_ONLY_RETRIES}): ${errorMsg}`
            );
            currentOffsetBps += POST_ONLY_OFFSET_INCREMENT_BPS;
            continue; // Retry with wider offset
          }

          throw new Error(`Failed to place limit order: ${errorMsg}`);
        }

        workingOrder.driftOrderId = txId;
        workingOrder.txSignature = result.txSignature;

        const confirmTimeoutMs = Math.max(
          5000,
          Math.min(30000, limitCfg.openOrderAppearMs ?? 15000)
        );
        const confirmation = result.txSignature
          ? await this._confirmTransaction(result.txSignature, confirmTimeoutMs)
          : { confirmed: false, failed: true, error: "No txSignature provided" };

        if (!confirmation.confirmed) {
          console.warn(
            `[DriftClient] Limit order tx not confirmed for ${market} (tx=${txId}) - verifying open order...`
          );
        }

        const openOrderAppearMs = limitCfg.openOrderAppearMs ?? 15000;
        const openOrderCheck = await this._waitForOpenOrderAppearance(
          marketIndex,
          userOrderId,
          openOrderAppearMs,
          { orderId }
        );

        if (openOrderCheck.aborted) {
          const activeOrder = this.workingOrders.get(orderId);
          if (activeOrder) {
            console.warn(
              `[DriftClient] Limit order wait aborted for ${market} (reason: ${openOrderCheck.reason}) - order still active, returning pending`
            );
            return {
              positionId: orderId,
              clientOrderId: orderId,
              market,
              marketIndex,
              side: activeOrder.side,
              collateral,
              leverage,
              size: collateral * leverage,
              baseSize,
              entryPrice: null,
              limitPrice: activeOrder.limitPrice,
              openTime: activeOrder.createdAt,
              liquidationPrice: null,
              execMode: ExecMode.MAKER,
              status: "pending",
              driftOrderId: activeOrder.driftOrderId,
              txSignature: activeOrder.txSignature,
            };
          }
          this.workingOrders.delete(orderId);
          const err = new Error(
            `Limit order wait aborted for ${market} (reason: ${openOrderCheck.reason})`
          );
          err.code = "ORDER_SUPERSEDED";
          throw err;
        }

        if (!openOrderCheck.found) {
          let onChainPosition = null;
          try {
            const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
            if (!posResult.backoff && posResult.live !== false) {
              const positions = posResult.positions || [];
              onChainPosition = positions.find(
                (p) => p.marketIndex === marketIndex && Math.abs(p.sizeBase || 0) > 0
              );
            }
          } catch (posErr) {
            console.warn(
              `[DriftClient] Position check failed after limit submit: ${posErr.message}`
            );
          }

          if (onChainPosition) {
            console.log(
              `[DriftClient] Limit order appears filled immediately on-chain - syncing position for ${market}`
            );
            this.stats.ordersPlaced++;
            this._applyOnChainPosition(workingOrder, onChainPosition);
            const synced =
              this.positions.get(market) ||
              this.positions.get(driftLookup.getMarketByIndex(marketIndex));
            if (!synced) {
              const err = new Error(`Position sync failed after limit fill for ${market}`);
              err.code = "POSITION_SYNC_FAILED";
              throw err;
            }
            synced.txSignature = result.txSignature || synced.txSignature || null;
            return synced;
          }

          if (openOrderCheck.backoff || confirmation.timeout) {
            this._enterUncertaintyWindow(
              `Limit order verification uncertain for ${market}`,
              120000
            );
            const err = new Error(`confirmation timeout for limit order on ${market} (tx ${txId})`);
            err.code = "TX_CONFIRM_TIMEOUT";
            throw err;
          }

          this.workingOrders.delete(orderId);
          const err = new Error(`Limit order not found on-chain after submit for ${market}`);
          err.code = confirmation.failed ? "TX_FAILED" : "ORDER_NOT_FOUND";
          throw err;
        }

        if (!confirmation.confirmed) {
          console.warn(
            `[DriftClient] Limit order visible on-chain despite unconfirmed tx: ${txId}`
          );
        } else {
          console.log(
            `[DriftClient] Limit order confirmed on-chain: ${txId} (status: ${result.status})`
          );
        }

        this.stats.ordersPlaced++;

        this.emit("orderPlaced", workingOrder);

        // Return a pending position (will be updated when filled)
        return {
          positionId: orderId,
          clientOrderId: orderId,
          market,
          marketIndex,
          side: side.toLowerCase(),
          collateral,
          leverage,
          size: collateral * leverage,
          baseSize,
          entryPrice: null, // Unknown until filled
          limitPrice,
          openTime: Date.now(),
          liquidationPrice: null,
          execMode: ExecMode.MAKER,
          status: "pending",
          driftOrderId: txId,
          txSignature: result.txSignature,
        };
      } catch (err) {
        // CRITICAL: Handle command timeout - order may have been placed AND filled on-chain
        if (this._isCommandTimeoutError(err)) {
          console.warn(
            `[DriftClient] placeLimitOrder timed out for ${market} - checking on-chain state...`
          );

          // Enter uncertainty window to prevent orphan cancellation
          this._enterUncertaintyWindow(`placeLimitOrder timeout for ${market}`, 120000); // 2 minutes

          // CRITICAL FIX: First check if POSITION was created (order was filled instantly)
          // This prevents duplicate fills when a filled order times out
          try {
            const adoptedPosition = await this._tryAdoptOnChainPosition(
              market,
              marketIndex,
              side,
              collateral,
              leverage,
              orderId
            );
            if (adoptedPosition) {
              console.log(
                `[DriftClient] ✅ Position adopted from on-chain after limit order timeout: ${market} ${side}`
              );
              this.workingOrders.delete(orderId);
              return adoptedPosition;
            }
          } catch (adoptErr) {
            console.warn(`[DriftClient] Could not check for adopted position: ${adoptErr.message}`);
          }

          // No position found - check if order was placed (still pending)
          try {
            const ordersResult = await this._getOpenOrdersSnapshot({ forceRefresh: true });
            if (ordersResult && !ordersResult.backoff) {
              const onChainOrder = (ordersResult.orders || []).find(
                (o) => o.marketIndex === marketIndex && o.userOrderId === userOrderId
              );

              if (onChainOrder) {
                console.log(
                  `[DriftClient] ✅ Order found on-chain after timeout! userOrderId=${userOrderId}`
                );
                // Keep the working order tracked since it exists
                return {
                  positionId: orderId,
                  clientOrderId: orderId,
                  market,
                  status: "pending",
                  execMode: ExecMode.MAKER,
                  driftOrderId: onChainOrder.orderId,
                  message: "Order placed (found after timeout)",
                };
              }
            }
          } catch (checkErr) {
            console.warn(
              `[DriftClient] Could not verify order state after timeout: ${checkErr.message}`
            );
          }

          // Order not found on-chain - safe to remove from tracking
          this.workingOrders.delete(orderId);
          console.log(
            `[DriftClient] Order not found on-chain after timeout - removed from tracking`
          );
          throw err;
        }

        this.workingOrders.delete(orderId);

        // Handle PerpMarketNotFound: disable market and re-throw
        if (isPerpMarketNotFound(err)) {
          console.error(
            `[DriftClient] PerpMarketNotFound for ${market} (index ${marketIndex}) - disabling market`
          );
          this._disableMarket(market, "PerpMarketNotFound", err.message);
          throw err;
        }

        // Handle PostOnlyFailure: widen offset and retry
        if (isPostOnlyFailure(err)) {
          lastPostOnlyError = err;
          console.warn(
            `[DriftClient] PostOnly failure (attempt ${postOnlyAttempt}/${MAX_POST_ONLY_RETRIES}): ${err.message}`
          );
          currentOffsetBps += POST_ONLY_OFFSET_INCREMENT_BPS;
          continue; // Retry with wider offset
        }

        throw err;
      }
    }

    // All post-only retries exhausted
    console.error(
      `[DriftClient] PostOnly failed after ${MAX_POST_ONLY_RETRIES} attempts (final offset: ${currentOffsetBps}bps)`
    );

    // Fallback to taker if enabled
    if (limitCfg.fallbackToTaker) {
      console.log(`[DriftClient] PostOnly exhausted - falling back to TAKER for ${market} ${side}`);
      return this._openTaker(
        side,
        collateral,
        leverage,
        entryPrice,
        clientOrderId,
        market,
        marketIndex,
        baseSize
      );
    }

    // No fallback - throw the last error
    throw (
      lastPostOnlyError ||
      new Error(`PostOnly limit order failed after ${MAX_POST_ONLY_RETRIES} attempts`)
    );
  }

  /**
   * Paper trading open position
   */
  _paperOpen(side, collateral, leverage, entryPrice, clientOrderId, market, baseSize) {
    const orderId = clientOrderId || `paper-drift-${Date.now()}`;

    const position = {
      positionId: orderId,
      clientOrderId: orderId,
      market,
      side: side.toLowerCase(),
      collateral,
      leverage,
      size: collateral * leverage,
      baseSize,
      entryPrice,
      openTime: Date.now(),
      liquidationPrice: this._calculateLiqPrice(entryPrice, leverage, side),
      execMode: this.config.execMode,
      paper: true,
    };

    this.positions.set(market, position);
    return position;
  }

  /**
   * Close a position
   * @param {Object} position - Position to close
   * @param {number} currentPrice - Current market price
   * @param {Object} options - Additional options { reason: string, useMaker: boolean }
   */
  async closePosition(position, currentPrice, options = {}) {
    await this._ensureInitialized();

    // Paper trading mode
    if (this.config.paperTradingMode || position.paper) {
      return this._paperClose(position, currentPrice, options);
    }

    const marketIndex = position.marketIndex || driftLookup.getMarketIndex(position.market);

    // VALIDATION: Ensure we have all required fields for close
    // baseSize can come from position.baseSize or position.sizeBase (field name mismatch fix)
    const baseSize = position.baseSize || position.sizeBase;
    // CRITICAL FIX: Normalize side to lowercase for consistent comparison
    // position.side may be "LONG" or "long" depending on source
    const side = String(position.side || "").toLowerCase();

    if (marketIndex === undefined || marketIndex === null) {
      throw new Error(
        `[DriftClient] closePosition failed: marketIndex is missing (position: ${JSON.stringify({
          positionId: position.positionId,
          market: position.market,
          marketIndex: position.marketIndex,
        })})`
      );
    }

    if (!side) {
      throw new Error(
        `[DriftClient] closePosition failed: side is missing (position: ${JSON.stringify({
          positionId: position.positionId,
          market: position.market,
          side: position.side,
        })})`
      );
    }

    if (!Number.isFinite(baseSize) || baseSize <= 0) {
      throw new Error(
        `[DriftClient] closePosition failed: baseSize is invalid (position: ${JSON.stringify({
          positionId: position.positionId,
          market: position.market,
          baseSize: position.baseSize,
          sizeBase: position.sizeBase,
        })})`
      );
    }

    const exitReason = options.reason || "unknown";

    // CRITICAL FIX: Check if there's already an exit order in progress for this market
    // This prevents duplicate close orders when maker exit is pending/filling/falling back
    const existingExitOrder = this._getWorkingExitOrderForMarket(marketIndex);
    if (existingExitOrder) {
      const exitState = existingExitOrder.state;
      const exitAge = Math.round((Date.now() - existingExitOrder.createdAt) / 1000);
      console.log(
        `[DriftClient] Exit already in progress for ${position.market}: order=${existingExitOrder.id} state=${exitState} age=${exitAge}s - skipping duplicate close`
      );
      return {
        exitInProgress: true,
        existingOrderId: existingExitOrder.id,
        existingOrderState: exitState,
        market: position.market,
        side: position.side,
        reason: `Exit order already in progress (${exitState})`,
      };
    }

    // Use market-specific exec mode from isolated strategy env
    const marketExecMode = getExecModeForMarket(position.market);

    // Determine if we should try maker or use taker immediately
    const preferredExecMode = getExitExecModeForReason(exitReason, marketExecMode);
    const useMaker =
      options.useMaker ?? (preferredExecMode === "maker" && marketExecMode === ExecMode.MAKER);

    // Cancel any working ENTRY orders for this market (not exit orders)
    await this._cancelWorkingEntryOrdersForMarket(position.market);

    let execMode = "taker";
    let result;
    let preVerifiedClosed = false;

    if (useMaker) {
      // Try maker exit first (limit order)
      const limitConfig = parseLimitOrderConfig({ market: position.market });
      const exitOffsetBps = limitConfig.exitOffsetBps ?? -2; // Default: aggressive (below market for longs)
      const offset = exitOffsetBps / 10000;

      // Get reference price for limit order (respects DRIFT_LIMIT_REF_PRICE)
      const refPrice = await this._getLimitRefPrice(position.market);

      // Calculate limit price for exit
      const limitPrice =
        side === "long"
          ? refPrice * (1 + offset) // Sell at (market + offset)
          : refPrice * (1 - offset); // Buy at (market - offset)

      const refPriceSource = process.env.DRIFT_LIMIT_REF_PRICE || "mark";
      console.log(
        `[DriftClient] Trying maker exit for ${side} on ${position.market} @ $${limitPrice.toFixed(4)} (${exitOffsetBps}bps from ${refPriceSource}=$${refPrice.toFixed(4)}, reason: ${exitReason})`
      );

      try {
        const userOrderId = this._generateUserOrderId(marketIndex, "exit");
        result = await this.subprocess.send("placeLimitOrder", {
          marketIndex,
          side: side === "long" ? "short" : "long",
          baseAssetAmount: baseSize,
          price: limitPrice,
          reduceOnly: true,
          postOnly: true,
          userOrderId,
        });

        // Use txSignature since orderId isn't reliably returned
        const txId = result.txSignature || result.orderId;
        if (txId) {
          console.log(`[DriftClient] Maker exit placed: ${txId}`);

          // CRITICAL: Track exit order in workingOrders for lifecycle management
          // This enables proper timeout, fallback, and cleanup handling
          const exitOrderId = `exit-${position.market}-${Date.now()}`;
          const workingExitOrder = new WorkingOrder({
            id: exitOrderId,
            market: position.market,
            marketIndex,
            userOrderId,
            side: side, // Original position side (for close direction)
            size: baseSize,
            limitPrice,
            orderType: "exit", // CRITICAL: Mark as exit order
            positionId: position.positionId,
            exitReason,
          });
          workingExitOrder.driftOrderId = txId;
          this.workingOrders.set(exitOrderId, workingExitOrder);

          console.log(
            `[DriftClient] Exit order tracked in workingOrders: ${exitOrderId} (will timeout/fallback via _checkOrderStatus)`
          );

          // Emit exitOrderPlaced event for informative notification (no fill yet)
          this.emit("exitOrderPlaced", {
            position,
            limitPrice,
            market: position.market,
            side: position.side,
            orderId: txId,
            execMode: "maker",
            exitReason,
          });

          // Return working: true - let _checkOrderStatus handle timeout/fallback
          // This is the same pattern as entry orders
          return {
            working: true,
            orderId: txId,
            exitOrderId,
            market: position.market,
            side: position.side,
            execMode: "maker",
            limitPrice,
          };
        }
      } catch (err) {
        // CRITICAL: Check for simulation/blockhash errors FIRST - these are NOT phantom positions!
        const errMsg = err.message || "";
        const isSimulationError =
          errMsg.includes("Simulation failed") ||
          errMsg.includes("Blockhash not found") ||
          errMsg.includes("blockhash") ||
          errMsg.includes("Transaction simulation failed");

        if (isSimulationError) {
          console.warn(
            `[DriftClient] Maker exit failed with simulation/blockhash error, falling back to taker: ${errMsg.slice(0, 100)}`
          );
          execMode = "taker";
        } else if (isPerpMarketNotFound(err) || isInvalidMarketError(err)) {
          // Check if this is an invalid market error - indicates phantom position or delisted market
          console.error(
            `[DriftClient] ⚠️ PHANTOM POSITION DETECTED: ${position.market} (marketIndex ${marketIndex}) - market invalid or no longer exists on Drift`
          );
          console.error(`[DriftClient] Error: ${err.message}`);
          console.error(
            `[DriftClient] Removing phantom position from local tracking (position cannot be closed)`
          );
          this.positions.delete(position.market);
          this.emit("phantomPositionRemoved", {
            market: position.market,
            marketIndex,
            positionId: position.positionId,
            side: position.side,
            reason: `Invalid market - ${err.message}`,
          });
          return {
            execMode: "phantom_removed",
            status: "phantom_position_removed",
            market: position.market,
            error: `Market ${position.market} (index ${marketIndex}) is invalid or no longer exists. Position removed from tracking.`,
          };
        } else {
          console.warn(`[DriftClient] Maker exit failed, falling back to taker: ${err.message}`);
          execMode = "taker"; // Ensure we fall back to taker on error
        }
      }
    }

    // If maker failed, timed out, or not used, use taker (market order)
    // BUG FIX: Check for txSignature instead of orderId (subprocess returns txSignature)
    const makerTxId = result?.txSignature || result?.orderId;
    if (execMode === "taker" || !makerTxId) {
      const takerReason = useMaker ? "maker_failed" : exitReason;
      console.log(
        `[DriftClient] Closing ${side} position on ${position.market} with TAKER @ $${currentPrice.toFixed(4)} (reason: ${takerReason})`
      );
      // CRITICAL FIX: Use 'exit_fallback' purpose to avoid userOrderId collision with maker exit
      // The maker exit uses 'exit' purpose which generates deterministic userOrderId per market
      // If maker times out but order is on-chain, taker using same userOrderId fails with 0x17b7 (UserOrderIdAlreadyInUse)
      const userOrderId = this._generateUserOrderId(marketIndex, "exit_fallback");
      try {
        result = await this.subprocess.send("placeMarketOrder", {
          marketIndex,
          side: side === "long" ? "short" : "long",
          baseAssetAmount: baseSize,
          reduceOnly: true,
          userOrderId,
        });
      } catch (err) {
        // CRITICAL: Check for simulation/blockhash errors FIRST - these are NOT phantom positions!
        // Simulation failures are transient network/RPC errors that should be retried, not treated as phantom
        const errMsg = err.message || "";
        const isSimulationError =
          errMsg.includes("Simulation failed") ||
          errMsg.includes("Blockhash not found") ||
          errMsg.includes("blockhash") ||
          errMsg.includes("Transaction simulation failed");

        if (isSimulationError) {
          console.warn(
            `[DriftClient] Taker close failed with simulation/blockhash error (NOT phantom): ${errMsg.slice(0, 100)}`
          );
          // Re-throw to trigger retry logic - this is NOT a phantom position
          throw err;
        }

        // Check if this is an invalid market error - indicates phantom position or delisted market
        // ONLY check after excluding simulation errors
        if (isPerpMarketNotFound(err) || isInvalidMarketError(err)) {
          console.error(
            `[DriftClient] ⚠️ PHANTOM POSITION DETECTED (taker close): ${position.market} (marketIndex ${marketIndex}) - market invalid or no longer exists`
          );
          console.error(`[DriftClient] Error: ${err.message}`);
          console.error(
            `[DriftClient] Removing phantom position from local tracking (position cannot be closed)`
          );
          this.positions.delete(position.market);
          this.emit("phantomPositionRemoved", {
            market: position.market,
            marketIndex,
            positionId: position.positionId,
            side: position.side,
            reason: `Invalid market - ${err.message}`,
          });
          return {
            execMode: "phantom_removed",
            status: "phantom_position_removed",
            market: position.market,
            error: `Market ${position.market} (index ${marketIndex}) is invalid or no longer exists. Position removed from tracking.`,
          };
        }
        if (this._isCommandTimeoutError(err)) {
          console.warn(
            `[DriftClient] placeMarketOrder timed out - verifying on-chain close for ${position.market}`
          );
          try {
            const closeCheck = await this._waitForPositionClosed(marketIndex, side, 8000);
            if (closeCheck.closed) {
              preVerifiedClosed = true;
              result = { orderId: "timeout_closed", status: "timeout_closed" };
            } else {
              console.warn(
                `[DriftClient] Close still pending after timeout for ${position.market} (remaining=${closeCheck.remainingSize})`
              );
              return { execMode: "taker", status: "close_pending", orderId: "timeout_pending" };
            }
          } catch (verifyErr) {
            console.warn(
              `[DriftClient] Close verification failed after timeout: ${verifyErr.message}`
            );
            return { execMode: "taker", status: "close_pending", orderId: "timeout_pending" };
          }
        } else {
          throw err;
        }
      }

      execMode = "taker";
    }

    // BUG FIX: Check for txSignature instead of orderId (subprocess returns txSignature)
    const closeTxId = result?.txSignature || result?.orderId;
    if (!closeTxId) {
      throw new Error(
        `Failed to close position: ${result?.error || "No transaction signature returned"}`
      );
    }

    // CRITICAL FIX: Only delete position from cache AFTER confirming close was submitted
    // Previous bug: deleted before confirmation, losing tracking if close failed
    // Now: Delete after we have txSignature (submission confirmed)
    //
    // Additional verification: Poll on-chain position until closed or timeout
    let positionVerifiedClosed = false;
    if (preVerifiedClosed) {
      console.log(
        `[DriftClient] ✅ Position ${position.market} ${position.side} verified closed on-chain (timeout recovery)`
      );
      this.positions.delete(position.market);
      positionVerifiedClosed = true;
    } else {
      try {
        const closeCheck = await this._waitForPositionClosed(marketIndex, side, 15000);
        if (closeCheck.closed) {
          console.log(
            `[DriftClient] ✅ Position ${position.market} ${position.side} verified closed on-chain`
          );
          this.positions.delete(position.market);
          positionVerifiedClosed = true;
        } else {
          console.warn(
            `[DriftClient] Position ${position.market} ${position.side} still open after close tx ${closeTxId} (remaining=${closeCheck.remainingSize})`
          );
          return {
            execMode,
            status: "close_pending",
            orderId: closeTxId,
            remainingSize: closeCheck.remainingSize,
          };
        }
      } catch (verifyErr) {
        console.warn(`[DriftClient] Could not verify position closure: ${verifyErr.message}`);
        return {
          execMode,
          status: "close_pending",
          orderId: closeTxId,
          remainingSize: position.baseSize || position.sizeBase,
        };
      }
    }

    // CRITICAL FIX: Only emit positionClosed AFTER verifying position is actually closed
    // Previous bug: Emitted positionClosed immediately after placing limit order,
    // causing duplicate notifications on every order replacement and premature "position closed" messages.
    //
    // New behavior:
    // - For taker exits (immediate fill): emit positionClosed immediately
    // - For maker exits (limit order): DON'T emit until position verified closed
    //   (the working order loop or final close confirmation will handle the notification)

    // Only proceed with PnL calculation and notification if position is actually closed
    // For maker exits that are still working, return early without emitting
    if (execMode === "maker" && !positionVerifiedClosed) {
      console.log(
        `[DriftClient] Maker exit order placed for ${position.market}, waiting for fill before emitting positionClosed`
      );
      // Return partial result indicating order is working (not filled yet)
      return {
        execMode,
        working: true,
        orderId: closeTxId,
        message: "Maker exit order placed, waiting for fill",
      };
    }

    // Position is closed (either taker or verified maker fill) - calculate PnL and emit
    // CRITICAL FIX: Fetch the ACTUAL current price from Drift oracle AFTER the order fills
    // Previous bug: Used the stale `currentPrice` parameter passed in, which was the price
    // BEFORE the order was submitted. This caused PnL discrepancy when price moved during
    // order execution (slippage, latency, market volatility).
    //
    // Now: Fetch fresh oracle price from Drift after position closure is confirmed.
    // This gives us a price much closer to the actual fill price.
    let actualExitPrice = currentPrice; // Fallback to passed-in price
    try {
      const freshPrice = await this.getMarketPrice(position.market);
      if (freshPrice && Number.isFinite(freshPrice) && freshPrice > 0) {
        // Log the price difference for debugging
        const priceDiff = (((freshPrice - currentPrice) / currentPrice) * 100).toFixed(3);
        console.log(
          `[DriftClient] Exit price adjustment: expected $${currentPrice.toFixed(4)} → actual $${freshPrice.toFixed(4)} (${priceDiff}% diff)`
        );
        actualExitPrice = freshPrice;
      } else {
        console.warn(
          `[DriftClient] Could not fetch fresh price for ${position.market}, using expected price $${currentPrice.toFixed(4)}`
        );
      }
    } catch (priceErr) {
      console.warn(
        `[DriftClient] Error fetching fresh exit price: ${priceErr.message}, using expected price $${currentPrice.toFixed(4)}`
      );
    }

    // Calculate PnL using the ACTUAL exit price (fetched after order fill)
    const pnl = this._calculatePnL(position, actualExitPrice);

    // Log PnL calculation details for debugging
    console.log(
      `[DriftClient] PnL calculation: entry=$${position.entryPrice?.toFixed(4)}, exit=$${actualExitPrice.toFixed(4)}, ` +
        `side=${position.side}, leverage=${position.leverage}x, collateral=$${position.collateral?.toFixed(2)}, PnL=$${pnl.toFixed(2)}`
    );

    // Emit positionClosed only when actually closed
    this.emit("positionClosed", {
      position,
      pnl,
      exitPrice: actualExitPrice,
      execMode,
      exitReason,
    });

    // Return the actual exit price so callers can use it for accurate PnL reporting
    return { pnl, execMode, exitPrice: actualExitPrice };
  }

  /**
   * Wait for an order to fill (with timeout)
   *
   * CRITICAL FIX: The subprocess's getOrderStatus doesn't check by specific orderId -
   * it only checks if there are ANY open orders for the market. This is fundamentally
   * broken for determining if a SPECIFIC order filled.
   *
   * New approach: Check if order is NO LONGER in open orders list AND position exists.
   * This is more reliable than getOrderStatus.
   *
   * @param {string} orderId - Order ID or txSignature (used for logging only)
   * @param {number} timeoutMs - Maximum time to wait
   * @param {number} marketIndex - Market index for order tracking (REQUIRED)
   * @param {Object} options - Additional options
   * @param {boolean} options.isClose - True if this is a close/exit order (inverts fill detection logic)
   */
  async _waitForOrderFill(orderId, timeoutMs = 15000, marketIndex = null, options = {}) {
    const startTime = Date.now();
    const pollIntervalMs = 1000;
    const isClose = options.isClose || false;
    const userOrderId = options.userOrderId;

    if (marketIndex === null) {
      console.warn(
        `[DriftClient] _waitForOrderFill called without marketIndex - cannot reliably detect fill`
      );
      // Fall back to old behavior
      await new Promise((r) => setTimeout(r, timeoutMs));
      return false;
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Check if there are still open orders for this market
        const ordersResult = await this._getOpenOrdersSnapshot({ forceRefresh: true });
        // CRITICAL: If backoff is active, we don't have accurate order data
        // Skip this iteration to avoid false conclusions about order status
        if (ordersResult.backoff) {
          console.warn(`[DriftClient] Backoff active during fill check - waiting before retry`);
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
        const openOrders = ordersResult.orders || [];
        const hasOpenOrderForMarket = openOrders.some(
          (o) =>
            o.marketIndex === marketIndex &&
            (userOrderId === undefined || Number(o.userOrderId) === Number(userOrderId))
        );

        if (!hasOpenOrderForMarket) {
          // Order is no longer open - check position status
          const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
          if (posResult.backoff) {
            console.warn(
              `[DriftClient] Backoff active during position check - waiting before retry`
            );
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            continue;
          }
          const positions = posResult.positions || [];
          const positionExists = positions.some(
            (p) => p.marketIndex === marketIndex && Math.abs(p.sizeBase || 0) > 0
          );

          if (isClose) {
            // CLOSE ORDER: Fill = position should be GONE
            if (!positionExists) {
              console.log(
                `[DriftClient] Close order ${orderId} filled - position no longer exists on market ${marketIndex}`
              );
              return true;
            } else {
              // Order gone but position still exists - close was not executed
              console.log(
                `[DriftClient] Close order ${orderId} no longer open but position still exists - likely cancelled/rejected`
              );
              return false;
            }
          } else {
            // ENTRY ORDER: Fill = position should EXIST
            if (positionExists) {
              console.log(
                `[DriftClient] Entry order ${orderId} filled - position exists on market ${marketIndex}`
              );
              return true;
            } else {
              // Order gone but no position - was cancelled or failed
              console.log(
                `[DriftClient] Entry order ${orderId} no longer open and no position - likely cancelled`
              );
              return false;
            }
          }
        }
      } catch (err) {
        console.warn(`[DriftClient] Error checking order status: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Timeout - cancel by userOrderId when possible
    console.log(`[DriftClient] Order ${orderId} timed out after ${timeoutMs}ms - cancelling`);
    try {
      if (userOrderId !== undefined) {
        await this.subprocess.send("cancelOrderByUserOrderId", {
          marketIndex,
          userOrderId,
          subaccount: this.config.subaccount,
        });
      } else {
        await this.subprocess.send("cancelAllOrders", { marketIndex });
      }
    } catch (err) {
      console.warn(`[DriftClient] Error cancelling timed-out order: ${err.message}`);
    }

    return false;
  }

  /**
   * Wait for an open order to appear on-chain (by userOrderId)
   */
  async _waitForOpenOrderAppearance(marketIndex, userOrderId, timeoutMs = 15000, options = {}) {
    const startTime = Date.now();
    const pollIntervalMs = 1000;
    let sawBackoff = false;
    let lastError = null;
    const orderId = options.orderId;

    const isOrderActive = () => {
      if (!orderId) return { active: true };
      const order = this.workingOrders.get(orderId);
      if (!order) {
        return { active: false, reason: "order_not_tracked" };
      }
      if (
        order.state === OrderState.FALLBACK_TAKER ||
        order.state === OrderState.CANCELLED ||
        order.state === OrderState.CLOSED
      ) {
        return { active: false, reason: `order_state_${order.state}` };
      }
      const currentIds = new Set();
      if (order.userOrderId !== undefined && order.userOrderId !== null) {
        currentIds.add(Number(order.userOrderId));
      }
      if (order.pendingUserOrderId !== undefined && order.pendingUserOrderId !== null) {
        currentIds.add(Number(order.pendingUserOrderId));
      }
      if (currentIds.size > 0 && !currentIds.has(Number(userOrderId))) {
        return { active: false, reason: "order_superseded" };
      }
      return { active: true };
    };

    const initialCheck = isOrderActive();
    if (!initialCheck.active) {
      return { found: false, aborted: true, reason: initialCheck.reason };
    }

    while (Date.now() - startTime < timeoutMs) {
      const activeCheck = isOrderActive();
      if (!activeCheck.active) {
        return { found: false, aborted: true, reason: activeCheck.reason };
      }
      try {
        const ordersResult = await this._getOpenOrdersSnapshot({ forceRefresh: true });
        if (ordersResult.backoff || ordersResult.live === false) {
          sawBackoff = true;
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }

        const openOrders = ordersResult.orders || [];
        const isOpen = openOrders.some(
          (o) => o.marketIndex === marketIndex && Number(o.userOrderId) === Number(userOrderId)
        );

        if (isOpen) {
          return { found: true };
        }
      } catch (err) {
        lastError = err;
        sawBackoff = true;
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return { found: false, backoff: sawBackoff, error: lastError };
  }

  /**
   * Wait for a position to fully close on-chain.
   */
  async _waitForPositionClosed(marketIndex, side, timeoutMs = 15000) {
    const startTime = Date.now();
    const pollIntervalMs = 1000;
    const dustThreshold = 0;
    let lastRemainingSize = "unknown";

    while (Date.now() - startTime < timeoutMs) {
      try {
        const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
        if (posResult?.backoff || posResult?.live === false) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
        const positions = posResult.positions || [];
        const position = positions.find((p) => p.marketIndex === marketIndex);
        const remainingSize = position ? Math.abs(position.sizeBase || 0) : 0;
        lastRemainingSize = remainingSize;

        if (!position || remainingSize <= dustThreshold) {
          return { closed: true, remainingSize: 0 };
        }
      } catch (err) {
        console.warn(`[DriftClient] Error polling position closure: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return { closed: false, remainingSize: lastRemainingSize };
  }

  /**
   * Paper trading close position
   * @param {Object} position - Position to close
   * @param {number} currentPrice - Current market price
   * @param {Object} options - Additional options { reason: string }
   */
  _paperClose(position, currentPrice, options = {}) {
    const pnl = this._calculatePnL(position, currentPrice);
    const exitReason = options.reason || "unknown";

    // Use position-specific exec mode if provided, otherwise market-specific env
    const marketExecMode = getExecModeForMarket(position.market);
    const baseExecMode = (
      position.execMode ||
      marketExecMode ||
      this.config.execMode ||
      "taker"
    ).toLowerCase();

    // Determine exec mode based on exit reason
    // Hard stops and emergencies → taker, RSI targets → can use maker
    const preferredExecMode = getExitExecModeForReason(exitReason, baseExecMode);
    const execMode =
      preferredExecMode === "maker" && baseExecMode === ExecMode.MAKER
        ? ExecMode.MAKER
        : ExecMode.TAKER;

    // Apply Drift fees based on actual exec mode
    const notionalSize = position.size || position.collateral * position.leverage;

    let fee;
    if (execMode === ExecMode.MAKER) {
      // Maker rebate: ~0.25bps (based on rookie tier)
      fee = (-notionalSize * 0.25) / 10000;
    } else {
      // Taker fee: ~3.5bps (rookie tier)
      fee = (notionalSize * 3.5) / 10000;
    }

    this.positions.delete(position.market);

    console.log(
      `[DriftClient Paper] Closed ${position.side} on ${position.market} (${execMode}) reason: ${exitReason}`
    );

    return { pnl: pnl - fee, fee, grossPnl: pnl, execMode, exitReason };
  }

  /**
   * Get all open positions
   * Returns positions in the format expected by the bot:
   * - positionId: unique identifier
   * - market: market symbol (e.g., 'JTO-PERP')
   * - marketIndex: Drift market index
   * - side: 'long' or 'short'
   * - sizeUsd: position size in USD
   * - entryPrice: estimated entry price
   * - collateral: collateral amount
   * - leverage: effective leverage
   */
  async getAllOpenPositions(options = {}) {
    await this._ensureInitialized();

    if (this.config.paperTradingMode) {
      return Array.from(this.positions.values());
    }
    const requireLive = options.requireLive === true;
    let result;
    try {
      result = await this._getPositionsSnapshot();
    } catch (err) {
      if (requireLive) {
        err.code = err.code || "POSITIONS_UNAVAILABLE";
        throw err;
      }
      console.warn(
        `[DriftClient] getAllOpenPositions failed, returning cached positions: ${err.message}`
      );
      return Array.from(this.positions.values());
    }

    if (result?.backoff || result?.live === false) {
      if (requireLive) {
        const err = new Error("Positions snapshot unavailable");
        err.code = "POSITIONS_UNAVAILABLE";
        throw err;
      }
      console.warn("[DriftClient] getAllOpenPositions using cached positions (snapshot not live)");
      return Array.from(this.positions.values());
    }

    if (result.positions && result.positions.length > 0) {
      // Convert raw Drift positions to bot-compatible format
      const convertedPositions = [];

      for (const pos of result.positions) {
        try {
          // Get market symbol from index
          let marketSymbol = driftLookup.getMarketByIndex(pos.marketIndex);
          if (!marketSymbol) {
            marketSymbol = `market-${pos.marketIndex}`;
            console.warn(
              `[DriftClient] Unknown market index: ${pos.marketIndex}, using fallback symbol ${marketSymbol}`
            );
          }

          // Calculate position values
          const sizeBase = Math.abs(pos.sizeBase || 0);
          const sizeQuote = Math.abs(pos.sizeQuote || 0);

          // Get current price to calculate USD size
          let currentPrice = 0;
          try {
            currentPrice = await this.getMarketPrice(marketSymbol);
          } catch (e) {
            // Fallback: estimate from quote/base
            if (sizeBase > 0 && sizeQuote > 0) {
              currentPrice = sizeQuote / sizeBase;
            }
          }

          // Calculate size in USD (using quote amount or base * price)
          const sizeUsd = sizeQuote > 0 ? sizeQuote : sizeBase * currentPrice;

          // Determine side first (needed for stable ID)
          const side =
            pos.side || (pos.baseAssetAmount && BigInt(pos.baseAssetAmount) < 0 ? "short" : "long");

          // CRITICAL FIX: Check if we have a tracked position for this market/side
          // This preserves the original positionId and clientOrderId from when the position was opened
          // (e.g., via maker→taker fallback), preventing the position from being treated as a new manual position
          const trackedPos = Array.from(this.positions.values()).find(
            (p) =>
              (p.market === marketSymbol || p.marketSymbol === marketSymbol) &&
              p.side?.toLowerCase() === side.toLowerCase()
          );

          // CRITICAL FIX #2: Also check database for matching position (handles restart scenario)
          // On restart, this.positions is empty but DB has the original positionId
          // Without this, position gets a new ID like drift-20-long instead of preserving the original
          let dbPos = null;
          if (!trackedPos && db) {
            try {
              const dbPositions = db.listOpen();
              // Match by market+side since on-chain doesn't report our positionId
              dbPos = dbPositions.find(
                (p) =>
                  p.market === marketSymbol && String(p.side).toLowerCase() === side.toLowerCase()
              );
              if (dbPos) {
                console.log(
                  `[DriftClient] Matched on-chain ${marketSymbol} ${side} to DB position ${dbPos.id?.slice(0, 8)}...`
                );
              }
            } catch (e) {
              // Ignore DB errors
            }
          }

          // Use tracked positionId if available, then DB positionId, otherwise create stable ID
          const positionId =
            trackedPos?.positionId || dbPos?.id || `drift-${pos.marketIndex}-${side}`;
          const clientOrderId = trackedPos?.clientOrderId || dbPos?.client_order_id || null;
          const tradeType = trackedPos ? "automated" : dbPos?.trade_type || null; // Use DB trade_type if available

          // Calculate entry price - CRITICAL for accurate PnL
          // Priority: 1) pre-calculated from subprocess, 2) quoteEntryAmount/baseAssetAmount, 3) fallbacks
          let entryPrice = 0;

          // Priority 1: Use pre-calculated entry price from subprocess (most accurate)
          if (pos.entryPrice && pos.entryPrice > 0) {
            entryPrice = pos.entryPrice;
          }
          // Priority 2: Calculate from quoteEntryAmount if available
          else if (pos.quoteEntryAmount && pos.baseAssetAmount) {
            // quoteEntryAmount is the ACTUAL entry quote (before funding/PnL)
            const quoteEntry = Math.abs(Number(pos.quoteEntryAmount) / 1e6); // 6 decimals for quote
            const baseEntry = Math.abs(Number(pos.baseAssetAmount) / 1e9); // 9 decimals for base
            if (baseEntry > 0) {
              entryPrice = quoteEntry / baseEntry;
            }
          }
          // Priority 3: WARNING - quoteAssetAmount includes PnL, this is INACCURATE!
          if (!entryPrice || entryPrice <= 0) {
            // Fallback: estimate from quoteAssetAmount/base (includes PnL - not ideal)
            entryPrice = sizeBase > 0 ? sizeQuote / sizeBase : currentPrice;
            console.warn(
              `[DriftClient] ⚠️ Using fallback entry price for ${marketSymbol}: $${entryPrice?.toFixed(4)} (quoteAssetAmount includes PnL)`
            );
          }
          if (!entryPrice || entryPrice <= 0) {
            // Last resort: use current price
            entryPrice = currentPrice;
            console.warn(
              `[DriftClient] ⚠️ Using current price as entry for ${marketSymbol}: $${currentPrice.toFixed(4)}`
            );
          }

          // Calculate collateral and leverage from Drift position data
          // Drift provides settledPnl, unsettledPnl, and margin info in some cases
          // For isolated margin: collateral = position value / leverage
          // For cross margin: we estimate based on typical leverage for the market
          //
          // IMPORTANT: Use STRATEGY_{MARKET}_LEVERAGE pattern (same as bot.js) for consistency.
          // Fallback chain: STRATEGY_X_PERP_LEVERAGE → LEVERAGE_BASE → DEFAULT_LEVERAGE → 5
          const marketKey = marketSymbol.replace(/-/g, "_"); // SOL-PERP → SOL_PERP
          const perMarketLeverage = Number(process.env[`STRATEGY_${marketKey}_LEVERAGE`]);
          const baseLeverage = Number(process.env.LEVERAGE_BASE);
          const defaultLeverage =
            Number.isFinite(perMarketLeverage) && perMarketLeverage > 0
              ? perMarketLeverage
              : Number.isFinite(baseLeverage) && baseLeverage > 0
                ? baseLeverage
                : Number(process.env.DEFAULT_LEVERAGE) || 5;
          const collateral = sizeUsd / defaultLeverage;
          const leverage = defaultLeverage;

          const positionData = {
            positionId,
            clientOrderId, // Preserve from tracked position if available
            market: marketSymbol,
            marketSymbol,
            marketIndex: pos.marketIndex,
            side,
            sizeBase,
            baseSize: sizeBase, // CRITICAL: closePosition() expects baseSize, not sizeBase
            sizeQuote,
            sizeUsd,
            size: sizeUsd, // Alias for compatibility
            entryPrice,
            collateral,
            leverage,
            openOrders: pos.openOrders || 0,
            venue: "drift",
            // Raw data for debugging
            _raw: pos,
          };

          // CRITICAL: Set trade_type to 'automated' if position was tracked by DriftClient
          // This prevents bot-opened positions from being downgraded to manual during sync
          if (tradeType) {
            positionData.trade_type = tradeType;
          }

          // Also preserve other tracking data from tracked position
          if (trackedPos) {
            positionData.openTime = trackedPos.openTime || positionData.openTime;
            positionData.execMode = trackedPos.execMode;
            console.log(
              `[DriftClient] Position matched to tracked: ${marketSymbol} ${side} (positionId: ${positionId.slice(0, 12)}..., trade_type: automated)`
            );
          } else {
            console.log(
              `[DriftClient] Found on-chain position: ${marketSymbol} ${side} $${sizeUsd.toFixed(2)} @ $${entryPrice.toFixed(4)} (no tracked match)`
            );
          }

          convertedPositions.push(positionData);
        } catch (e) {
          console.warn(`[DriftClient] Error converting position: ${e.message}`, pos);
        }
      }

      // Keep local cache aligned with on-chain snapshot (helps order sync + recovery)
      this.positions.clear();
      for (const position of convertedPositions) {
        this.positions.set(position.market, position);
      }

      return convertedPositions;
    }

    console.warn(`[DriftClient] Failed to fetch positions, using local cache`);
    return Array.from(this.positions.values());
  }

  /**
   * Cancel a working order
   * @param {string} orderId - Our internal order ID (not Drift's on-chain order ID)
   */
  async cancelOrder(orderId) {
    const workingOrder = this.workingOrders.get(orderId);
    if (!workingOrder) {
      console.warn(`[DriftClient] Order ${orderId} not found in working orders`);
      return false;
    }

    try {
      if (workingOrder.userOrderId !== undefined) {
        console.log(
          `[DriftClient] Cancelling order userOrderId=${workingOrder.userOrderId} for ${workingOrder.market} (marketIndex=${workingOrder.marketIndex})`
        );
        await this.subprocess.send("cancelOrderByUserOrderId", {
          marketIndex: workingOrder.marketIndex,
          userOrderId: workingOrder.userOrderId,
          subaccount: this.config.subaccount,
        });
      } else {
        console.log(
          `[DriftClient] Cancelling orders for ${workingOrder.market} (marketIndex=${workingOrder.marketIndex})`
        );
        await this.subprocess.send("cancelAllOrders", {
          marketIndex: workingOrder.marketIndex,
        });
      }
    } catch (cancelErr) {
      const raw = String(cancelErr?.message || cancelErr || "");
      const summary = raw.replace(/\s+/g, " ").slice(0, 220);
      console.warn(
        `[DriftClient] Warning: Failed to cancel orders for ${workingOrder.market}: ${summary}`
      );
    }

    workingOrder.state = OrderState.CANCELLED;
    this.workingOrders.delete(orderId);
    this.stats.ordersCancelled++;
    this.emit("orderCancelled", workingOrder);

    return true;
  }

  /**
   * Cancel all working orders for a market
   */
  async _cancelWorkingOrdersForMarket(market) {
    const ordersToCancel = [];

    for (const [id, order] of this.workingOrders) {
      if (order.market === market) {
        ordersToCancel.push(id);
      }
    }

    for (const id of ordersToCancel) {
      await this.cancelOrder(id);
    }
  }

  /**
   * Cancel all open orders on startup (safety)
   */
  async cancelAllOrders() {
    if (process.env.DRIFT_CANCEL_OPEN_ORDERS_ON_START !== "true") {
      return;
    }

    console.log("[DriftClient] Cancelling all open orders on startup...");

    const result = await this.subprocess.send("cancelAllOrders", {
      subaccount: this.config.subaccount,
    });

    console.log(`[DriftClient] Cancelled ${result.cancelledCount || 0} orders`);

    this.workingOrders.clear();
  }

  /**
   * Close all positions on startup (safety)
   */
  async closeAllPositions() {
    if (process.env.DRIFT_CLOSE_OPEN_POSITIONS_ON_START !== "true") {
      return;
    }

    console.log("[DriftClient] Closing all open positions on startup...");

    const positions = await this.getAllOpenPositions();

    for (const pos of positions) {
      try {
        const price = await this.getMarketPrice(pos.market);
        await this.closePosition(pos, price);
      } catch (e) {
        console.error(`[DriftClient] Failed to close ${pos.market}: ${e.message}`);
      }
    }
  }

  /**
   * Start order monitor loop for maker orders
   */
  _startOrderMonitor() {
    const monitorInterval = Math.max(
      1000,
      Number(process.env.DRIFT_ORDER_MONITOR_INTERVAL_MS) || 15000
    );
    const syncInterval = Math.max(10000, Number(process.env.DRIFT_ORDER_SYNC_INTERVAL_MS) || 60000);

    // Lock to prevent concurrent _checkWorkingOrders executions
    this._checkingOrders = false;
    this._checkingOrdersSince = null;

    this._orderMonitorTimer = setInterval(async () => {
      // GUARD: Prevent concurrent execution
      if (this._checkingOrders) {
        const stuckDuration = this._checkingOrdersSince
          ? Date.now() - this._checkingOrdersSince
          : 0;

        // CRITICAL FIX: If order check is stuck for more than 2 minutes, force release the lock
        // This prevents a single stuck operation from blocking all order processing
        if (stuckDuration > 120000) {
          console.error(
            `[DriftClient] ⚠️ Order check STUCK for ${Math.round(stuckDuration / 1000)}s - forcing lock release`
          );
          this._checkingOrders = false;
          this._checkingOrdersSince = null;
          // Continue to run the check
        } else {
          console.log(
            `[DriftClient] Skipping order check - previous check in progress (${Math.round(stuckDuration / 1000)}s)`
          );
          return;
        }
      }
      this._checkingOrders = true;
      this._checkingOrdersSince = Date.now();

      try {
        await this._checkWorkingOrders();
      } catch (e) {
        console.error(`[DriftClient] Order monitor error: ${e.message}`);
      } finally {
        this._checkingOrders = false;
        this._checkingOrdersSince = null;
      }
    }, monitorInterval);

    // Lock to prevent concurrent _syncWithOnChainOrders executions
    this._syncingOrders = false;

    // Periodic sync with on-chain state to detect orphaned orders
    this._orderSyncTimer = setInterval(async () => {
      // GUARD: Prevent concurrent execution
      if (this._syncingOrders) {
        return;
      }
      this._syncingOrders = true;

      try {
        await this._syncWithOnChainOrders();
      } catch (e) {
        // Handle circuit breaker and timeout errors gracefully
        if (e.code === "CIRCUIT_OPEN") {
          console.warn(
            `[DriftClient] Circuit breaker OPEN - skipping order sync (subprocess may be recovering)`
          );
        } else if (e.code === "TIMEOUT" || e.code === "SUBPROCESS_TERMINATED") {
          console.warn(
            `[DriftClient] Order sync error: ${e.message} (subprocess may be recovering)`
          );
        } else {
          console.error(`[DriftClient] Order sync error: ${e.message}`);
        }
      } finally {
        this._syncingOrders = false;
      }
    }, syncInterval);

    console.log(
      `[DriftClient] Order monitor started (interval=${monitorInterval}ms, sync=${syncInterval}ms)`
    );
  }

  /**
   * Enter uncertainty window - prevents orphan cancellation for a period
   * Call this after timeouts, unclear results, or other situations where
   * the on-chain state may be uncertain.
   *
   * @param {string} reason - Reason for entering uncertainty
   * @param {number} durationMs - Duration of uncertainty window (default 60s)
   */
  _enterUncertaintyWindow(reason, durationMs = 60000) {
    const until = Date.now() + durationMs;
    this._uncertaintyWindowUntil = Math.max(this._uncertaintyWindowUntil || 0, until);
    this._lastUncertaintyReason = reason;
    console.log(
      `[DriftClient] Entered uncertainty window for ${durationMs / 1000}s (reason: ${reason})`
    );
  }

  /**
   * Check if we're in an uncertainty window
   * @returns {boolean}
   */
  _isInUncertaintyWindow() {
    return (this._uncertaintyWindowUntil || 0) > Date.now();
  }

  /**
   * Sync local working orders with on-chain state
   * Detects orphaned orders and cleans them up
   *
   * CRITICAL: This function has a grace period after startup to prevent
   * cancelling valid orders that were placed before a restart.
   * The startup reconciliation in _reconcileState() handles initial cleanup.
   * This function only handles orders that become orphaned DURING operation.
   *
   * CRITICAL: This function also respects uncertainty windows - periods after
   * timeouts or errors where we cannot be certain of on-chain state.
   */
  async _syncWithOnChainOrders() {
    if (!this.subprocess || !this.initialized) return;

    // CRITICAL FIX: Grace period after startup
    // Don't cancel orders in the first 5 minutes after initialization
    // This allows the bot to recover position/order tracking after restart
    // The initial _reconcileState() already handles startup cleanup
    const STARTUP_GRACE_MS = 5 * 60 * 1000; // 5 minutes
    const timeSinceInit = Date.now() - (this._initTimestamp || 0);

    if (timeSinceInit < STARTUP_GRACE_MS) {
      console.log(
        `[DriftClient] Skipping orphan sync - in startup grace period (${Math.round((STARTUP_GRACE_MS - timeSinceInit) / 1000)}s remaining)`
      );
      return;
    }

    // CRITICAL: Don't cancel orders during uncertainty windows
    // (e.g., after timeouts, errors, or other unclear results)
    if (this._isInUncertaintyWindow()) {
      const remainingMs = (this._uncertaintyWindowUntil || 0) - Date.now();
      console.log(
        `[DriftClient] Skipping orphan sync - in uncertainty window (${Math.round(remainingMs / 1000)}s remaining, reason: ${this._lastUncertaintyReason || "unknown"})`
      );
      return;
    }

    try {
      const result = await this._getOpenOrdersSnapshot();
      let onChainPositions = null;
      try {
        onChainPositions = await this._getPositionsSnapshot();
      } catch (posErr) {
        console.warn(
          `[DriftClient] Position snapshot unavailable during order sync: ${posErr.message}`
        );
      }
      // CRITICAL: If backoff is active, we don't have accurate order data
      // Exit early to avoid incorrectly identifying orders as orphaned
      if (result.backoff) {
        console.warn(
          `[DriftClient] Backoff active - skipping orphan sync to avoid false detections`
        );
        return;
      }
      const onChainOrders = result.orders || [];
      const onChainPositionMarkets = new Set();
      if (onChainPositions && !onChainPositions.backoff && onChainPositions.live !== false) {
        const positions = onChainPositions.positions || [];
        for (const pos of positions) {
          if (Math.abs(pos.sizeBase || 0) <= 0) continue;
          const marketIndex = Number(pos.marketIndex);
          if (Number.isFinite(marketIndex)) {
            onChainPositionMarkets.add(marketIndex);
          }
        }
      }
      const localOrderKeys = new Set(
        Array.from(this.workingOrders.values()).map((wo) => `${wo.marketIndex}:${wo.userOrderId}`)
      );

      // Check for on-chain orders that are NOT in our local tracking
      const orphanedMarkets = new Set();
      const orphanedOrderDetails = [];

      for (const order of onChainOrders) {
        // We can't match by order ID (we only have txSignature), so track by market
        // If there are on-chain orders for markets we're not tracking, they're orphaned
        const orderKey = `${order.marketIndex}:${Number(order.userOrderId)}`;
        const hasLocalOrder = localOrderKeys.has(orderKey);

        // CRITICAL FIX: Also check if we have an OPEN POSITION for this market
        // If we have a position, the order might be a legitimate exit order
        // that was placed but not tracked (e.g., manual or from previous session)
        const localMarketKey =
          driftLookup.getMarketByIndex(order.marketIndex) || `market-${order.marketIndex}`;
        const hasOpenPosition =
          this.positions.has(localMarketKey) ||
          onChainPositionMarkets.has(Number(order.marketIndex));

        if (!hasLocalOrder && !hasOpenPosition) {
          // Only consider orders with non-zero userOrderId as potentially bot-owned
          // userOrderId defaults to 0 for manually placed orders (Drift UI/SDK)
          // Bot-generated userOrderIds are always >= 1, so we exclude 0
          if (
            order.userOrderId !== undefined &&
            order.userOrderId !== null &&
            order.userOrderId !== 0
          ) {
            orphanedMarkets.add(order.marketIndex);
          }
          orphanedOrderDetails.push({
            marketIndex: order.marketIndex,
            orderId: order.orderId,
            userOrderId: order.userOrderId,
            price: order.price,
            direction: order.direction,
          });
          console.warn(
            `[DriftClient] Orphaned order detected: market=${order.marketIndex}, userOrderId=${order.userOrderId}, orderId=${order.orderId}, price=${order.price}`
          );
        } else if (!hasLocalOrder && hasOpenPosition) {
          // Has position but no tracked order - could be a manually placed exit order OR stale bot exit
          // CRITICAL FIX: Track bot-owned orders (userOrderId > 0) as stale exit candidates
          // After STALE_EXIT_ORDER_TIMEOUT_MS, cancel them to prevent stuck exit orders
          const staleKey = `${order.marketIndex}:${Number(order.userOrderId)}`;
          const isBotOwned =
            order.userOrderId !== undefined &&
            order.userOrderId !== null &&
            order.userOrderId !== 0;

          if (isBotOwned) {
            if (!this._staleExitOrderCandidates.has(staleKey)) {
              // First time seeing this order - start tracking
              this._staleExitOrderCandidates.set(staleKey, {
                firstSeenAt: Date.now(),
                market: localMarketKey,
                marketIndex: order.marketIndex,
                userOrderId: order.userOrderId,
                orderId: order.orderId,
                price: order.price,
                direction: order.direction,
              });
              console.log(
                `[DriftClient] Tracking potential stale exit order: market=${order.marketIndex}, userOrderId=${order.userOrderId} (position exists, will cancel after ${this._STALE_EXIT_ORDER_TIMEOUT_MS / 1000}s if not filled)`
              );
            } else {
              // Already tracking - check if timeout exceeded
              const candidate = this._staleExitOrderCandidates.get(staleKey);
              const ageMs = Date.now() - candidate.firstSeenAt;

              if (ageMs >= this._STALE_EXIT_ORDER_TIMEOUT_MS) {
                // Timed out - treat as orphan and cancel
                console.warn(
                  `[DriftClient] ⚠️ STALE EXIT ORDER DETECTED: market=${order.marketIndex}, userOrderId=${order.userOrderId}, age=${Math.round(ageMs / 1000)}s - adding to orphan list for cancellation`
                );
                orphanedOrderDetails.push({
                  marketIndex: order.marketIndex,
                  orderId: order.orderId,
                  userOrderId: order.userOrderId,
                  price: order.price,
                  direction: order.direction,
                  reason: "stale_exit_order",
                });
                // Remove from tracking - we're handling it
                this._staleExitOrderCandidates.delete(staleKey);
              } else {
                // Still within grace period
                const remainingS = Math.ceil((this._STALE_EXIT_ORDER_TIMEOUT_MS - ageMs) / 1000);
                console.log(
                  `[DriftClient] Potential stale exit order: market=${order.marketIndex}, userOrderId=${order.userOrderId} - waiting (${remainingS}s remaining before cancel)`
                );
              }
            }
          } else {
            // Not bot-owned (userOrderId === 0) - leave alone
            console.log(
              `[DriftClient] On-chain order for market ${order.marketIndex} - not tracked but position exists, leaving manual order alone`
            );
          }
        }
      }

      // CRITICAL: Clean up stale exit candidates that are no longer on-chain
      // (they were filled or cancelled successfully)
      const onChainOrderKeys = new Set(
        onChainOrders
          .filter(
            (o) => o.userOrderId !== undefined && o.userOrderId !== null && o.userOrderId !== 0
          )
          .map((o) => `${o.marketIndex}:${Number(o.userOrderId)}`)
      );
      for (const [key] of this._staleExitOrderCandidates) {
        if (!onChainOrderKeys.has(key)) {
          console.log(
            `[DriftClient] Removing stale exit candidate ${key} - no longer on-chain (filled or cancelled)`
          );
          this._staleExitOrderCandidates.delete(key);
        }
      }

      // Cancel orphaned orders by market (only if truly orphaned)
      for (const orphan of orphanedOrderDetails) {
        // Skip orders without userOrderId or with userOrderId === 0 (manually placed)
        // userOrderId defaults to 0 for manually placed orders (Drift UI/SDK)
        // Bot-generated userOrderIds are always >= 1, so we exclude 0
        if (
          orphan.userOrderId === undefined ||
          orphan.userOrderId === null ||
          orphan.userOrderId === 0
        ) {
          continue;
        }

        // CRITICAL FIX: Track failed cancellation attempts
        // If we've tried too many times, the order likely no longer exists (already filled/cancelled)
        const orphanKey = `${orphan.marketIndex}:${orphan.userOrderId}`;
        const failedRecord = this._failedOrphanCancels.get(orphanKey);

        if (failedRecord && failedRecord.attempts >= this._maxOrphanCancelAttempts) {
          // Skip this order - we've tried too many times
          // If it still exists on-chain, it will show up again in the next snapshot
          // and we'll eventually try again after the record expires (next restart)
          const timeSinceLastAttempt = Date.now() - failedRecord.lastAttempt;
          // Only log once per hour to avoid spam
          if (timeSinceLastAttempt > 60 * 60 * 1000 || !failedRecord.loggedSkip) {
            console.warn(
              `[DriftClient] Skipping orphan cancel for userOrderId=${orphan.userOrderId} on market ${orphan.marketIndex} - ${failedRecord.attempts} failed attempts (last error: ${failedRecord.lastError})`
            );
            failedRecord.loggedSkip = true;
          }
          continue;
        }

        const orderType = orphan.reason === "stale_exit_order" ? "STALE EXIT" : "orphaned";
        console.log(
          `[DriftClient] Cancelling ${orderType} order userOrderId=${orphan.userOrderId} on market ${orphan.marketIndex}...`
        );
        try {
          await this.subprocess.send("cancelOrderByUserOrderId", {
            marketIndex: orphan.marketIndex,
            userOrderId: Number(orphan.userOrderId),
            subaccount: this.config.subaccount,
          });
          console.log(
            `[DriftClient] ✅ Cancelled ${orderType} order userOrderId=${orphan.userOrderId} on market ${orphan.marketIndex}`
          );
          // Success - remove from failed tracking
          this._failedOrphanCancels.delete(orphanKey);
        } catch (cancelErr) {
          // Track the failure
          const existing = this._failedOrphanCancels.get(orphanKey) || {
            attempts: 0,
            lastAttempt: 0,
            lastError: null,
          };
          existing.attempts++;
          existing.lastAttempt = Date.now();
          existing.lastError = cancelErr.message?.slice(0, 100);
          existing.loggedSkip = false;
          this._failedOrphanCancels.set(orphanKey, existing);

          // Check if this is a "Simulation failed" error - likely means order doesn't exist
          const isSimulationFailed = cancelErr.message?.includes("Simulation failed");
          const isOrderNotFound =
            cancelErr.message?.includes("order not found") ||
            cancelErr.message?.includes("OrderDoesNotExist");

          if (isSimulationFailed || isOrderNotFound) {
            console.log(
              `[DriftClient] Orphan order userOrderId=${orphan.userOrderId} on market ${orphan.marketIndex} likely doesn't exist (${cancelErr.message?.slice(0, 50)}...) - marking as uncancellable`
            );
            // Mark as max attempts immediately for orders that clearly don't exist
            existing.attempts = this._maxOrphanCancelAttempts;
          } else {
            console.error(
              `[DriftClient] Failed to cancel orphaned order userOrderId=${orphan.userOrderId} for market ${orphan.marketIndex}: ${cancelErr.message}`
            );
          }
        }
      }

      if (orphanedMarkets.size === 0 && onChainOrders.length > 0) {
        console.log(
          `[DriftClient] On-chain sync: ${onChainOrders.length} orders, ${this.workingOrders.size} locally tracked - all accounted for`
        );
      }
    } catch (err) {
      console.error(`[DriftClient] On-chain order sync failed: ${err.message}`);
    }
  }

  /**
   * Check working orders for fills, timeouts, replaces
   */
  async _checkWorkingOrders() {
    const orderCount = this.workingOrders.size;
    if (orderCount > 0) {
      console.log(`[DriftClient] Checking ${orderCount} working orders...`);
    }

    // Get current open orders from chain once per check cycle
    let onChainOpenOrders = [];
    try {
      const result = await this._getOpenOrdersSnapshot();
      // CRITICAL: Check for backoff flag - if backoff is active, we don't have accurate order data
      // and should exit early to avoid incorrectly concluding orders are gone
      if (result.backoff) {
        console.warn(
          `[DriftClient] Backoff active - skipping order check to avoid false fill/cancel detection`
        );
        return; // Exit early to avoid processing stale/incomplete data
      }
      onChainOpenOrders = result.orders || [];
    } catch (err) {
      // Handle circuit breaker and timeout errors gracefully
      if (err.code === "CIRCUIT_OPEN") {
        console.warn(
          `[DriftClient] Circuit breaker OPEN - skipping order check (subprocess may be recovering)`
        );
        // Don't log as error - circuit breaker will recover
        return; // Exit early to avoid processing stale data
      } else if (err.code === "TIMEOUT") {
        console.warn(
          `[DriftClient] getOpenOrders timeout - this may indicate network/subprocess issues`
        );
      } else if (err.code === "SUBPROCESS_TERMINATED") {
        console.warn(
          `[DriftClient] Subprocess terminated during order check - restart in progress`
        );
        return; // Exit early - subprocess is restarting
      } else {
        console.warn(`[DriftClient] Failed to fetch open orders for fill check: ${err.message}`);
      }
      // Exit early to avoid acting on incomplete order data (prevents duplicate fills)
      return;
    }

    // Lazy positions snapshot (only fetch if needed)
    let positionsSnapshot = null;
    let positionsError = null;
    const getPositionsSnapshot = async () => {
      if (positionsSnapshot || positionsError) return positionsSnapshot;
      try {
        positionsSnapshot = await this._getPositionsSnapshot({
          // Critical for fill detection: in polling mode, positions can lag unless we refresh.
          forceRefresh: true,
        });
      } catch (err) {
        positionsError = err;
      }
      return positionsSnapshot;
    };

    for (const [id, order] of this.workingOrders) {
      const limitCfg = parseLimitOrderConfig({ market: order.market });
      const ageMs = Date.now() - order.createdAt;
      // CRITICAL: Use exitTimeoutMs for exit orders, entryTimeoutMs for entry orders
      const timeoutMs = order.isExit()
        ? (limitCfg.exitTimeoutMs ?? 10000) // Default 10s for exits
        : limitCfg.entryTimeoutMs;

      // CRITICAL SAFEGUARD: Force cleanup of orders stuck for more than 30 minutes
      // This catches edge cases where orders get stuck due to race conditions or unhandled states
      const MAX_ORDER_AGE_MS = 30 * 60 * 1000; // 30 minutes
      if (ageMs > MAX_ORDER_AGE_MS) {
        console.warn(
          `[DriftClient] ⚠️ Force-removing STALE order ${id} (${order.market} ${order.side}) - age=${Math.round(ageMs / 1000)}s exceeds max ${MAX_ORDER_AGE_MS / 1000}s. State was: ${order.state}`
        );
        this.workingOrders.delete(id);
        this.stats.ordersTimedOut++;
        continue;
      }

      // Log order status periodically
      if (ageMs > 30000 && ageMs % 30000 < 5000) {
        console.log(
          `[DriftClient] Order ${id} (${order.market} ${order.side}): age=${Math.round(ageMs / 1000)}s, timeout=${timeoutMs / 1000}s, state=${order.state}, fallbackEnabled=${limitCfg.fallbackToTaker}`
        );
      }

      // CRITICAL: Check if order is still open on-chain before any other operations
      // If order is not in open orders list, it may have been filled or cancelled
      const isStillOpen = onChainOpenOrders.some(
        (oco) =>
          oco.marketIndex === order.marketIndex &&
          (order.userOrderId === undefined || Number(oco.userOrderId) === Number(order.userOrderId))
      );

      if (!isStillOpen) {
        // Grace period: allow time for newly placed orders to show up on-chain
        const openOrderAppearMs = limitCfg.openOrderAppearMs ?? 10000;
        if (ageMs < openOrderAppearMs) {
          console.log(
            `[DriftClient] Order ${id} (${order.market} ${order.side}) not open yet (age=${Math.round(ageMs / 1000)}s) - waiting for open order to appear`
          );
          continue;
        }

        // CRITICAL FIX: Track when order first disappeared for position appearance grace period
        // This prevents false "cancelled" detection when orders fill but positions haven't propagated
        if (!order.orderDisappearedAt) {
          order.orderDisappearedAt = Date.now();
          console.log(
            `[DriftClient] Order ${id} (${order.market} ${order.side}) disappeared from on-chain - tracking for position appearance`
          );
        }

        // Order is no longer open - check if it was filled (position exists) or cancelled
        // BUG FIX: Check BOTH local cache AND on-chain for position existence
        // Previous bug: Only checked local cache which could be stale
        let positionExists = false;
        let onChainPosition = null;

        try {
          const onChainResult = await getPositionsSnapshot();
          if (!onChainResult) {
            throw positionsError || new Error("Positions snapshot unavailable");
          }
          if (onChainResult.backoff) {
            console.warn(
              `[DriftClient] Backoff active during position check - skipping decision for ${id}`
            );
            continue;
          }
          const onChainPositions = onChainResult.positions || [];
          onChainPosition = onChainPositions.find(
            (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
          );
          positionExists = !!onChainPosition;

          if (positionExists && !this.positions.has(order.market)) {
            console.log(
              `[DriftClient] Order ${id} filled - position found on-chain but not in local cache. Syncing...`
            );
          }
        } catch (posCheckErr) {
          // Handle circuit breaker and timeout errors gracefully
          if (
            posCheckErr.code === "CIRCUIT_OPEN" ||
            posCheckErr.code === "TIMEOUT" ||
            posCheckErr.code === "SUBPROCESS_TERMINATED"
          ) {
            console.warn(
              `[DriftClient] Could not verify position on-chain: ${posCheckErr.message} (subprocess may be recovering)`
            );
          } else {
            console.warn(
              `[DriftClient] Could not verify position on-chain: ${posCheckErr.message}`
            );
          }
          // Do not fallback when position status is unknown; wait for next cycle.
          continue;
        }

        // CRITICAL: For EXIT orders, fill detection is INVERTED
        // Entry: positionExists → filled
        // Exit: !positionExists → filled (position was closed)
        const isExitOrder = order.isExit();

        if (isExitOrder) {
          if (!positionExists) {
            // EXIT order was filled - position is closed
            console.log(
              `[DriftClient] ✅ EXIT Order ${id} (${order.market} ${order.side}) was FILLED AS MAKER - position closed`
            );
            order.state = OrderState.CLOSED;
            this.workingOrders.delete(id);
            this.stats.ordersFilled++;
            this.stats.makerFills++;

            const cachedPosition = this.positions.get(order.market) || null;
            let exitPrice = order.limitPrice;
            try {
              const freshPrice = await this.getMarketPrice(order.market);
              if (freshPrice && Number.isFinite(freshPrice) && freshPrice > 0) {
                exitPrice = freshPrice;
              }
            } catch (e) {
              // Best-effort; keep fallback exitPrice
            }
            const pnl =
              cachedPosition && Number.isFinite(exitPrice) && exitPrice > 0
                ? this._calculatePnL(cachedPosition, exitPrice)
                : null;

            // Remove from local positions cache
            this.positions.delete(order.market);

            this._emitPositionClosedOnce({
              positionId: order.positionId || cachedPosition?.positionId || order.id,
              market: order.market,
              marketIndex: order.marketIndex,
              side: order.side,
              position: cachedPosition,
              pnl,
              exitPrice,
              execMode: "maker",
              exitReason: order.exitReason || "maker_exit_filled",
            });
            continue;
          }
          // Position still exists - exit not filled *yet*.
          // Give Drift a short grace period to reflect the position close before triggering fallback.
          const EXIT_POSITION_CLOSE_GRACE_MS =
            limitCfg.exitPositionCloseGraceMs ?? limitCfg.positionAppearGraceMs ?? 8000;
          const timeSinceDisappear = order.orderDisappearedAt
            ? Date.now() - order.orderDisappearedAt
            : 0;
          if (timeSinceDisappear < EXIT_POSITION_CLOSE_GRACE_MS) {
            console.log(
              `[DriftClient] EXIT Order ${id} (${order.market}) disappeared but position still open (${Math.round(timeSinceDisappear / 1000)}s ago) - waiting for close propagation (grace=${EXIT_POSITION_CLOSE_GRACE_MS / 1000}s)`
            );
            continue;
          }
        } else if (positionExists) {
          // ENTRY order was filled - position exists
          console.log(
            `[DriftClient] ✅ Order ${id} (${order.market} ${order.side}) was FILLED AS MAKER - syncing entry from chain`
          );
          order.state = OrderState.FILLED;
          if (onChainPosition) {
            this._applyOnChainPosition(order, onChainPosition);
          } else {
            this.workingOrders.delete(id);
          }
          continue;
        }

        // Order is no longer open but wasn't filled (entry: no position, exit: position still exists)
        // ENTRY ONLY: Check if replacement is in progress (grace period after replacement)
        // Exit orders don't use replacement, so skip this check for exits
        if (!isExitOrder) {
          const REPLACE_GRACE_MS = 5000; // 5 second minimum grace period after replacement
          const replaceGraceMs = Math.max(REPLACE_GRACE_MS, limitCfg.openOrderAppearMs ?? 15000);
          const timeSinceReplace = order.lastReplaceAt
            ? Date.now() - order.lastReplaceAt
            : Infinity;
          const isInReplaceGrace = timeSinceReplace < replaceGraceMs;

          if (isInReplaceGrace) {
            // Order was recently replaced - give it time to appear in open orders list
            const reason = order._replaceInProgress ? "replace_in_progress" : "recently_replaced";
            console.log(
              `[DriftClient] Order ${id} (${order.market} ${order.side}) not open but ${reason} (${Math.round(timeSinceReplace / 1000)}s ago) - waiting for new order to appear`
            );
            continue;
          }

          // CRITICAL FIX: Position appearance grace period for entry orders
          // When an order disappears without a position, wait before assuming it was cancelled
          // This prevents false fallbacks when orders fill but positions take time to propagate
          const POSITION_APPEAR_GRACE_MS = limitCfg.positionAppearGraceMs ?? 15000; // 15 second default
          const timeSinceDisappear = order.orderDisappearedAt
            ? Date.now() - order.orderDisappearedAt
            : 0;

          if (timeSinceDisappear < POSITION_APPEAR_GRACE_MS) {
            console.log(
              `[DriftClient] Order ${id} (${order.market} ${order.side}) disappeared but no position yet (${Math.round(timeSinceDisappear / 1000)}s ago) - waiting for position to appear (grace=${POSITION_APPEAR_GRACE_MS / 1000}s)`
            );
            continue;
          }
        }

        // If we already attempted taker fallback, give it time to settle before removing
        if (order.state === OrderState.FALLBACK_TAKER) {
          const fallbackGraceMs = limitCfg.fallbackConfirmMs ?? 15000;
          const timeSinceFallback = order.fallbackStartedAt
            ? Date.now() - order.fallbackStartedAt
            : ageMs;
          if (timeSinceFallback < fallbackGraceMs) {
            console.log(
              `[DriftClient] Waiting for taker fallback confirmation for ${order.id} (${order.market})`
            );
            continue;
          }
        }

        // CRITICAL: If fallback is enabled and order disappeared without being filled, always fallback
        // This ensures we don't miss trades when orders are cancelled/removed before timeout
        const hasTimedOut = order.isExpired(timeoutMs);
        // CRITICAL: Include WORKING_EXIT for exit order fallback support
        const canFallback =
          order.state === OrderState.WORKING_ENTRY ||
          order.state === OrderState.REPLACING ||
          order.state === OrderState.WORKING_EXIT;

        if (limitCfg.fallbackToTaker && canFallback) {
          // Order disappeared without being filled - execute taker fallback
          const reason = hasTimedOut ? "timed out" : "removed/cancelled before timeout";
          const orderType = isExitOrder ? "EXIT" : "ENTRY";
          console.log(
            `[DriftClient] ${orderType} Order ${id} (${order.market} ${order.side}) ${reason} (age=${Math.round(ageMs / 1000)}s, timeout=${timeoutMs / 1000}s) - initiating TAKER FALLBACK`
          );
          order.state = OrderState.FALLBACK_TAKER;
          order.fallbackStartedAt = Date.now();
          // CRITICAL FIX: Don't await - fire and forget to avoid blocking other orders
          // The fallback will run in background; next check cycle will see FALLBACK_TAKER state
          this._fallbackToTaker(order).catch((e) =>
            console.error(`[DriftClient] Background fallback error for ${order.id}: ${e.message}`)
          );
          continue;
        } else {
          // Fallback disabled or invalid state - remove from tracking
          if (hasTimedOut) {
            console.log(
              `[DriftClient] Order ${id} (${order.market} ${order.side}) timed out but fallback disabled or invalid state - removing (fallbackToTaker=${limitCfg.fallbackToTaker}, state=${order.state})`
            );
            this.stats.ordersTimedOut++;
          } else {
            console.log(
              `[DriftClient] Order ${id} (${order.market} ${order.side}) removed/cancelled before timeout (age=${Math.round(ageMs / 1000)}s < timeout=${timeoutMs / 1000}s) - removing from working orders`
            );
          }
          this.workingOrders.delete(id);
          continue;
        }
      }

      // CRITICAL FIX: Reset disappeared timestamp if order reappeared on-chain
      // This handles edge cases where network issues cause temporary order "disappearance"
      if (order.orderDisappearedAt) {
        console.log(
          `[DriftClient] Order ${id} (${order.market} ${order.side}) reappeared on-chain - resetting disappeared timestamp`
        );
        order.orderDisappearedAt = null;
      }

      // Check for early fallback (fallbackAfterMs) and hard timeout (entryTimeoutMs/exitTimeoutMs)
      // fallbackAfterMs (e.g., 45s) - trigger taker fallback early if enabled
      // entryTimeoutMs/exitTimeoutMs - hard cancel if still working
      // CRITICAL: For exit orders, use exitFallbackAfterMs if set, otherwise fallback immediately after exitTimeoutMs
      const isExitOrder = order.isExit();
      const fallbackAfterMs = isExitOrder
        ? (limitCfg.exitFallbackAfterMs ?? limitCfg.exitTimeoutMs ?? 10000) // Exit orders fallback faster
        : (limitCfg.fallbackAfterMs ?? timeoutMs);
      const hasReachedFallbackTime = ageMs >= fallbackAfterMs;
      const hasTimedOutHard = order.isExpired(timeoutMs);
      // CRITICAL: Include WORKING_EXIT for exit order fallback support
      const canFallback =
        order.state === OrderState.WORKING_ENTRY ||
        order.state === OrderState.REPLACING ||
        order.state === OrderState.WORKING_EXIT;

      // Early fallback at fallbackAfterMs (if enabled and before hard timeout)
      if (hasReachedFallbackTime && !hasTimedOutHard && limitCfg.fallbackToTaker && canFallback) {
        console.log(
          `[DriftClient] Order ${id} reached FALLBACK TIME after ${Math.round(ageMs / 1000)}s (fallbackAfterMs=${fallbackAfterMs / 1000}s, timeout=${timeoutMs / 1000}s)`
        );
        console.log(
          `[DriftClient] Initiating TAKER FALLBACK for ${id} (${order.market} ${order.side})`
        );
        order.state = OrderState.FALLBACK_TAKER;
        order.fallbackStartedAt = Date.now();
        // CRITICAL FIX: Don't await - fire and forget to avoid blocking other orders
        this._fallbackToTaker(order).catch((e) =>
          console.error(`[DriftClient] Background fallback error for ${order.id}: ${e.message}`)
        );
        continue;
      }

      // Hard timeout at entryTimeoutMs
      if (hasTimedOutHard) {
        console.log(
          `[DriftClient] Order ${id} HARD TIMEOUT after ${Math.round(ageMs / 1000)}s (timeout=${timeoutMs / 1000}s)`
        );

        // Last chance fallback if enabled
        if (limitCfg.fallbackToTaker && canFallback) {
          console.log(
            `[DriftClient] Initiating TAKER FALLBACK for ${id} (${order.market} ${order.side})`
          );
          order.state = OrderState.FALLBACK_TAKER;
          order.fallbackStartedAt = Date.now();
          // CRITICAL FIX: Don't await - fire and forget
          this._fallbackToTaker(order).catch((e) =>
            console.error(`[DriftClient] Background fallback error for ${order.id}: ${e.message}`)
          );
        } else {
          console.log(
            `[DriftClient] Cancelling order ${id} (fallbackToTaker=${limitCfg.fallbackToTaker}, state=${order.state})`
          );
          // Cancel can also be slow, but it's simpler - keep await for now
          // TODO: Consider making this non-blocking too
          this.cancelOrder(id).catch((e) =>
            console.error(`[DriftClient] Background cancel error for ${order.id}: ${e.message}`)
          );
          this.stats.ordersTimedOut++;
        }
        continue;
      }

      // Check if should replace (only if order is still open)
      if (
        order.shouldReplace(limitCfg.replaceEveryMs) &&
        order.replaceCount < limitCfg.maxReplaces
      ) {
        // CRITICAL FIX: Don't await - fire and forget to avoid blocking other orders
        // The replace will run in background; order state tracks replacement
        order.state = OrderState.REPLACING;
        order.lastReplaceAt = Date.now();
        this._replaceOrder(order, limitCfg, onChainOpenOrders).catch((e) =>
          console.error(`[DriftClient] Background replace error for ${order.id}: ${e.message}`)
        );
      }
    }
  }

  /**
   * Replace a working order with updated price
   */
  async _replaceOrder(order, limitCfg, onChainOpenOrders = null) {
    if (!this._canAttemptReplace(order.marketIndex)) {
      console.log(
        `[DriftClient] Replace backoff active for market ${order.marketIndex} - skipping`
      );
      return { status: "replace_backoff" };
    }
    // GUARD: Abort if fallback was already initiated (prevents race condition)
    if (order.state === OrderState.FALLBACK_TAKER) {
      console.log(
        `[DriftClient] Skipping replace for ${order.id} - TAKER fallback already in progress`
      );
      return;
    }

    // CRITICAL: Acquire lock to prevent concurrent replace/fallback operations
    if (!order.acquireLock("replace")) {
      console.log(`[DriftClient] Skipping replace for ${order.id} - another operation in progress`);
      return;
    }

    try {
      order.state = OrderState.REPLACING;
      // SAFETY CHECK: Verify order is still open on-chain before attempting replacement
      // This prevents trying to replace orders that have already been filled
      if (this.subprocess && this.initialized) {
        try {
          const result = onChainOpenOrders
            ? { orders: onChainOpenOrders }
            : await this._getOpenOrdersSnapshot({ forceRefresh: true });
          // CRITICAL: If backoff is active, we don't have accurate order data
          // Skip replace operation to avoid attempting to replace already-filled orders
          if (result.backoff) {
            console.warn(
              `[DriftClient] Backoff active - skipping replace for ${order.id} (cannot verify order status)`
            );
            this._recordReplaceBackoff(order.marketIndex);
            order.releaseLock();
            order.state = OrderState.WORKING_ENTRY;
            return { status: "replace_backoff" };
          }
          const onChainOrders = result.orders || [];
          const isStillOpen = onChainOrders.some(
            (oco) =>
              oco.marketIndex === order.marketIndex &&
              (order.userOrderId === undefined ||
                Number(oco.userOrderId) === Number(order.userOrderId))
          );

          if (!isStillOpen) {
            // Order is no longer open - check if filled or cancelled
            // BUG FIX: Check BOTH local cache AND on-chain for position existence
            let positionExists = this.positions.has(order.market);
            let onChainPosition = null;

            // Double-check on-chain if local cache says no position
            if (!positionExists) {
              try {
                const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
                if (posResult.backoff) {
                  console.warn(
                    `[DriftClient] Backoff active - skipping replace decision for ${order.id}`
                  );
                  this._recordReplaceBackoff(order.marketIndex);
                  order.state = OrderState.WORKING_ENTRY;
                  return { status: "replace_backoff" };
                }
                const positions = posResult.positions || [];
                onChainPosition = positions.find(
                  (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
                );
                positionExists = !!onChainPosition;
              } catch (e) {
                console.warn(
                  `[DriftClient] Could not verify position for replace check: ${e.message}`
                );
              }
            }

            if (positionExists) {
              console.log(
                `[DriftClient] Cannot replace order ${order.id} - order was FILLED (position exists)`
              );
              order.state = OrderState.FILLED;
              if (onChainPosition) {
                this._applyOnChainPosition(order, onChainPosition);
              } else {
                this.workingOrders.delete(order.id);
                this.stats.ordersFilled++;
                this.stats.makerFills++;
              }
            } else {
              console.log(
                `[DriftClient] Cannot replace order ${order.id} - order is no longer open (likely cancelled)`
              );
              this.workingOrders.delete(order.id);
            }
            return;
          }
        } catch (checkErr) {
          console.warn(
            `[DriftClient] Warning: Could not verify order status before replace: ${checkErr.message}`
          );
          // Continue with replacement attempt if check fails (better to try than skip)
        }
      }

      // Get reference price for limit order (respects DRIFT_LIMIT_REF_PRICE)
      const refPrice = await this._getLimitRefPrice(order.market);
      const offsetBps = limitCfg.entryOffsetBps ?? limitCfg.entryBps;
      const offsetMultiplier =
        order.side === "long" ? 1 - offsetBps / 10000 : 1 + offsetBps / 10000;
      const newLimitPrice = refPrice * offsetMultiplier;

      const refPriceSource = process.env.DRIFT_LIMIT_REF_PRICE || "mark";
      console.log(
        `[DriftClient] Replacing order ${order.id}: $${order.limitPrice.toFixed(4)} -> $${newLimitPrice.toFixed(4)} (ref: ${refPriceSource}=$${refPrice.toFixed(4)})`
      );

      // Cancel specific order by userOrderId and confirm cancellation
      try {
        await this.subprocess.send("cancelOrderByUserOrderId", {
          marketIndex: order.marketIndex,
          userOrderId: order.userOrderId,
          subaccount: this.config.subaccount,
        });
      } catch (cancelErr) {
        console.warn(`[DriftClient] Warning: Failed to cancel for replace: ${cancelErr.message}`);
        this._recordReplaceBackoff(order.marketIndex);
        order.state = OrderState.WORKING_ENTRY;
        return { status: "replace_failed_cancel_unconfirmed" };
      }

      let cancelConfirmed = false;
      try {
        const refreshed = await this._getOpenOrdersSnapshot();
        // CRITICAL: If backoff is active, we don't have accurate order data
        // Cannot reliably confirm cancellation, so abort replace to be safe
        if (refreshed.backoff) {
          console.warn(
            `[DriftClient] Backoff active - cannot confirm cancel before replace for order ${order.id}`
          );
          this._recordReplaceBackoff(order.marketIndex);
          order.state = OrderState.WORKING_ENTRY;
          order.releaseLock();
          return { status: "replace_failed_cancel_unconfirmed" };
        }
        const refreshedOrders = refreshed.orders || [];
        cancelConfirmed = !refreshedOrders.some(
          (oco) =>
            oco.marketIndex === order.marketIndex &&
            Number(oco.userOrderId) === Number(order.userOrderId)
        );
      } catch (confirmErr) {
        console.warn(
          `[DriftClient] Warning: Could not confirm cancel before replace: ${confirmErr.message}`
        );
      }

      if (!cancelConfirmed) {
        console.warn(`[DriftClient] Cancel unconfirmed for order ${order.id} - aborting replace`);
        this._recordReplaceBackoff(order.marketIndex);
        order.state = OrderState.WORKING_ENTRY;
        return { status: "replace_failed_cancel_unconfirmed" };
      }

      const newUserOrderId = this._generateUserOrderId(order.marketIndex, "replace");
      const previousUserOrderId = order.userOrderId;
      order.pendingUserOrderId = newUserOrderId;
      const result = await this.subprocess.send("placeLimitOrder", {
        marketIndex: order.marketIndex,
        side: order.side,
        baseAssetAmount: order.size,
        price: newLimitPrice,
        postOnly: limitCfg.postOnly,
        reduceOnly: false,
        userOrderId: newUserOrderId,
      });

      // Use txSignature since orderId isn't returned
      const txId = result.txSignature || result.orderId;
      if (txId) {
        // GUARD: Check state again after async operations - abort if fallback started
        if (order.state === OrderState.FALLBACK_TAKER || !this.workingOrders.has(order.id)) {
          console.log(
            `[DriftClient] Replace completed for ${order.id} but order is in fallback/deleted - discarding replaced order`
          );
          // Cancel the newly placed order since we're falling back to taker anyway
          try {
            await this.subprocess.send("cancelOrderByUserOrderId", {
              marketIndex: order.marketIndex,
              userOrderId: newUserOrderId,
              subaccount: this.config.subaccount,
            });
          } catch (e) {
            /* ignore */
          }
          return;
        }

        order.userOrderId = newUserOrderId;
        order.driftOrderId = txId;
        order.txSignature = result.txSignature || null;

        const openOrderAppearMs = limitCfg.openOrderAppearMs ?? 15000;
        const openOrderCheck = await this._waitForOpenOrderAppearance(
          order.marketIndex,
          newUserOrderId,
          openOrderAppearMs,
          { orderId: order.id }
        );

        if (openOrderCheck.aborted) {
          // Replacement superseded (fallback/removed). Best effort cancel of new order.
          try {
            await this.subprocess.send("cancelOrderByUserOrderId", {
              marketIndex: order.marketIndex,
              userOrderId: newUserOrderId,
              subaccount: this.config.subaccount,
            });
          } catch (e) {
            /* ignore */
          }
          order.userOrderId = previousUserOrderId;
          delete order.pendingUserOrderId;
          order.state = OrderState.WORKING_ENTRY;
          return { status: "replace_aborted" };
        }

        if (!openOrderCheck.found) {
          this._recordReplaceBackoff(order.marketIndex);
          delete order.pendingUserOrderId;
          order.state = OrderState.WORKING_ENTRY;
          return { status: "replace_unconfirmed" };
        }

        order.limitPrice = newLimitPrice;
        order.lastReplaceAt = Date.now();
        order.replaceCount++;
        delete order.pendingUserOrderId;
        // After replacement, set state back to WORKING_ENTRY so timeout tracking works
        // Industry standard: each replacement resets to working state, timeout measured from original order
        order.state = OrderState.WORKING_ENTRY;
        this.stats.ordersReplaced++;
        this._clearReplaceBackoff(order.marketIndex);
        console.log(
          `[DriftClient] Order replaced: ${order.id} -> $${newLimitPrice.toFixed(4)} (replaces: ${order.replaceCount}/${limitCfg.maxReplaces})`
        );
      }
    } catch (e) {
      delete order.pendingUserOrderId;
      // If replacement fails with insufficient collateral, the order may have been filled
      // Check if position exists (both local cache AND on-chain) and clean up if so
      if (e.message && e.message.includes("InsufficientCollateral")) {
        let positionExists = this.positions.has(order.market);

        // Double-check on-chain
        if (!positionExists) {
          try {
            const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
            if (posResult.backoff) {
              console.warn(
                `[DriftClient] Backoff active - skipping position check after InsufficientCollateral`
              );
              order.state = OrderState.WORKING_ENTRY;
              return;
            }
            const positions = posResult.positions || [];
            positionExists = positions.some(
              (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
            );
          } catch (posErr) {
            console.warn(
              `[DriftClient] Could not verify position after InsufficientCollateral: ${posErr.message}`
            );
          }
        }

        if (positionExists) {
          console.log(
            `[DriftClient] Replacement failed with InsufficientCollateral - order ${order.id} was likely FILLED`
          );
          order.state = OrderState.FILLED;
          this.workingOrders.delete(order.id);
          this.stats.ordersFilled++;
          this.stats.makerFills++;
          return;
        }
      }
      console.error(`[DriftClient] Failed to replace order ${order.id}: ${e.message}`);
      this._recordReplaceBackoff(order.marketIndex);
      // Reset state from REPLACING back to WORKING_ENTRY so order can be processed normally
      order.state = OrderState.WORKING_ENTRY;
    } finally {
      // CRITICAL: Always release lock when done
      order.releaseLock("replace");
    }
  }

  /**
   * Fallback to taker order when maker times out
   * Delegates to _fallbackExitToTaker for exit orders
   */
  async _fallbackToTaker(order) {
    // GUARD: Prevent duplicate fallback executions
    if (!this.workingOrders.has(order.id)) {
      console.log(
        `[DriftClient] Skipping TAKER fallback for ${order.id} - order already removed from tracking`
      );
      return;
    }

    // CRITICAL: For exit orders, use dedicated exit fallback logic
    if (order.isExit()) {
      return this._fallbackExitToTaker(order);
    }

    // CRITICAL: Acquire lock to prevent concurrent operations
    // This replaces the old _fallbackInProgress flag with the unified lock system
    if (!order.acquireLock("fallback")) {
      console.log(
        `[DriftClient] Skipping TAKER fallback for ${order.id} - another operation in progress`
      );
      return;
    }

    console.log(`[DriftClient] Falling back to TAKER for ${order.id} (${order.market})`);
    order.fallbackStartedAt = Date.now();

    try {
      // CRITICAL FIX: Check if maker order was already filled BEFORE placing taker
      // This prevents placing unnecessary taker orders when maker already succeeded
      try {
        console.log(`[DriftClient] Checking if maker order ${order.id} was already filled...`);
        const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
        if (posResult && !posResult.backoff) {
          const positions = posResult.positions || [];
          const onChainPos = positions.find(
            (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
          );

          if (onChainPos) {
            // Maker order already filled! No need for taker
            console.log(
              `[DriftClient] ✅ MAKER order ${order.id} was already FILLED! Syncing position instead of placing taker...`
            );

            const entryPrice = Number(onChainPos.entryPrice || onChainPos.entry_price || 0);
            const sizeBase = Math.abs(
              Number(onChainPos.sizeBase || onChainPos.baseAssetAmount || 0)
            );
            const sizeUsd = Math.abs(
              Number(onChainPos.quoteAssetAmount || onChainPos.size_usd || sizeBase * entryPrice)
            );

            const position = {
              positionId: order.id,
              clientOrderId: order.id,
              market: order.market,
              marketSymbol: order.market,
              marketIndex: order.marketIndex,
              side: order.side,
              entryPrice: entryPrice,
              collateral: order.collateral || sizeUsd,
              leverage: order.leverage || 1,
              size: sizeUsd,
              sizeUsd: sizeUsd,
              baseSize: sizeBase,
              sizeBase: sizeBase,
              openTime: Date.now(),
              liquidationPrice: this._calculateLiqPrice(
                entryPrice,
                order.leverage || 1,
                order.side
              ),
              strategyType: order.strategyType || "rsi-reversion-alt",
              trade_type: "automated",
              venue: "drift",
              execMode: ExecMode.MAKER,
            };

            this.positions.set(order.market, position);
            this.emit("positionOpened", position);
            this.workingOrders.delete(order.id);
            this.stats.ordersFilled++;
            this.stats.makerFills++;
            console.log(
              `[DriftClient] Position synced from filled maker: ${order.market} ${order.side} @ $${entryPrice?.toFixed(4) || "N/A"}`
            );
            return; // Exit early - no need for taker
          }
        }
      } catch (checkErr) {
        console.warn(
          `[DriftClient] Could not check if maker filled before taker: ${checkErr.message}`
        );
        // Continue with taker fallback
      }

      // Cancel specific order by userOrderId (fail-closed on cancel errors)
      try {
        console.log(
          `[DriftClient] Cancelling order userOrderId=${order.userOrderId} for ${order.market} (marketIndex=${order.marketIndex})`
        );
        await this.subprocess.send("cancelOrderByUserOrderId", {
          marketIndex: order.marketIndex,
          userOrderId: order.userOrderId,
          subaccount: this.config.subaccount,
        });
        console.log(
          `[DriftClient] Cancelled order userOrderId=${order.userOrderId} for ${order.market}`
        );
      } catch (cancelErr) {
        // CRITICAL: If cancel fails with "Simulation failed", the order may have been filled!
        // Check again before proceeding with taker
        const isSimulationFailed = cancelErr.message?.includes("Simulation failed");
        if (isSimulationFailed) {
          console.log(
            `[DriftClient] Cancel failed (Simulation failed) - order may have been filled, checking...`
          );
          try {
            const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
            if (posResult && !posResult.backoff) {
              const positions = posResult.positions || [];
              const onChainPos = positions.find(
                (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
              );

              if (onChainPos) {
                console.log(
                  `[DriftClient] ✅ Order was filled! Cancel failed because order no longer exists.`
                );
                const entryPrice = Number(onChainPos.entryPrice || onChainPos.entry_price || 0);
                const sizeBase = Math.abs(
                  Number(onChainPos.sizeBase || onChainPos.baseAssetAmount || 0)
                );
                const sizeUsd = Math.abs(
                  Number(onChainPos.quoteAssetAmount || sizeBase * entryPrice)
                );

                const position = {
                  positionId: order.id,
                  clientOrderId: order.id,
                  market: order.market,
                  marketSymbol: order.market,
                  marketIndex: order.marketIndex,
                  side: order.side,
                  entryPrice: entryPrice,
                  collateral: order.collateral || sizeUsd,
                  leverage: order.leverage || 1,
                  size: sizeUsd,
                  sizeUsd: sizeUsd,
                  baseSize: sizeBase,
                  openTime: Date.now(),
                  trade_type: "automated",
                  venue: "drift",
                  execMode: ExecMode.MAKER,
                };

                this.positions.set(order.market, position);
                this.emit("positionOpened", position);
                this.workingOrders.delete(order.id);
                this.stats.ordersFilled++;
                this.stats.makerFills++;
                return; // Exit - position synced from filled maker
              }
            }
          } catch (e) {
            console.warn(
              `[DriftClient] Could not verify position after cancel failure: ${e.message}`
            );
          }
        }
        console.warn(
          `[DriftClient] Warning: Failed to cancel orders for ${order.market}: ${cancelErr.message}`
        );
        // Continue anyway - the market order will work regardless
      }

      // Place market order
      console.log(`[DriftClient] Placing TAKER market order for ${order.market} ${order.side}`);
      // Use deterministic fallback userOrderId for this market
      const fallbackUserOrderId = this._generateUserOrderId(order.marketIndex, "fallback");
      const result = await this.subprocess.send("placeMarketOrder", {
        marketIndex: order.marketIndex,
        side: order.side,
        baseAssetAmount: order.size,
        reduceOnly: false,
        userOrderId: fallbackUserOrderId,
      });

      // Check for success - use txSignature since orderId isn't returned
      const txId = result.txSignature || result.orderId;
      if (txId) {
        // CRITICAL: Confirm transaction on-chain before declaring success
        console.log(`[DriftClient] TAKER fallback submitted: ${txId} - confirming on-chain...`);
        const confirmation = await this._confirmTransaction(txId, 30000);

        if (!confirmation.confirmed) {
          console.warn(
            `[DriftClient] TAKER fallback not confirmed (reason: ${confirmation.error || "unknown"}) - checking position state...`
          );

          // Enter uncertainty window to prevent orphan cancellation
          this._enterUncertaintyWindow(`TAKER fallback unconfirmed for ${order.market}`, 120000);

          let posResult;
          try {
            posResult = await this._getPositionsSnapshot({ forceRefresh: true });
          } catch (posErr) {
            console.warn(
              `[DriftClient] Position check failed after unconfirmed taker: ${posErr.message}`
            );
            return; // Keep order tracked for later reconciliation
          }

          if (posResult.backoff) {
            console.warn(`[DriftClient] Backoff active - deferring taker fill verification`);
            return; // Keep order tracked for later reconciliation
          }

          const positions = posResult.positions || [];
          const onChainPos = positions.find(
            (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
          );

          if (!onChainPos) {
            if (confirmation.failed) {
              console.error(
                `[DriftClient] TAKER fallback tx FAILED on-chain: ${confirmation.error}`
              );
            } else if (confirmation.timeout) {
              console.error(
                `[DriftClient] TAKER fallback tx ${txId} - no position created after timeout`
              );
            } else {
              console.error(
                `[DriftClient] TAKER fallback tx ${txId} - position not found (unconfirmed)`
              );
            }
            this.workingOrders.delete(order.id);
            return; // Don't create position if none exists
          }

          console.log(`[DriftClient] Position verified on-chain despite unconfirmed tx`);
          const entryPrice = onChainPos.entryPrice || order.entryPriceRef;
          const sizeBase = Math.abs(onChainPos.sizeBase || order.size);
          const sizeUsd = Math.abs(onChainPos.sizeQuote || sizeBase * entryPrice);
          const position = {
            positionId: order.id,
            clientOrderId: order.id,
            market: order.market,
            marketSymbol: order.market,
            marketIndex: order.marketIndex,
            side: order.side,
            collateral: order.collateral || sizeUsd,
            leverage: order.leverage || 1,
            size: order.collateral * order.leverage,
            sizeUsd: order.collateral * order.leverage,
            baseSize: sizeBase,
            entryPrice: entryPrice,
            openTime: Date.now(),
            execMode: ExecMode.TAKER,
            trade_type: "automated",
            driftOrderId: txId,
            txSignature: result.txSignature,
            venue: "drift",
          };

          this.positions.set(order.market, position);
          this.emit("positionOpened", position);
          this.workingOrders.delete(order.id);
          this.stats.fallbacksToTaker++;
          this.stats.takerFills++;
          this.stats.ordersFilled++;
          console.log(
            `[DriftClient] Position created after unconfirmed taker: ${order.market} ${order.side} @ $${entryPrice?.toFixed(4) || "N/A"}`
          );
          return;
        }

        console.log(`[DriftClient] ✅ TAKER FALLBACK CONFIRMED: ${txId}`);
        order.state = OrderState.FILLED;
        this.workingOrders.delete(order.id);
        this.stats.fallbacksToTaker++;
        this.stats.takerFills++;
        this.stats.ordersFilled++;
        console.log(
          `[DriftClient] Order ${order.id} filled as TAKER (fallback from limit order timeout)`
        );

        // Get current price for entry
        let entryPrice = order.entryPriceRef;
        try {
          const currentPrice = await this.getMarketPrice(order.market);
          if (currentPrice) entryPrice = currentPrice;
        } catch (e) {
          console.warn(
            `[DriftClient] Could not get current price for ${order.market}: ${e.message}`
          );
        }

        // Create position from filled order
        // CRITICAL: Set trade_type to 'automated' so bot doesn't classify it as manual
        const position = {
          positionId: order.id,
          clientOrderId: order.id,
          market: order.market,
          marketSymbol: order.market, // For getAllOpenPositions lookup
          marketIndex: order.marketIndex,
          side: order.side,
          collateral: order.collateral,
          leverage: order.leverage,
          size: order.collateral * order.leverage,
          sizeUsd: order.collateral * order.leverage, // For compatibility
          baseSize: order.size,
          entryPrice: entryPrice,
          openTime: Date.now(),
          execMode: ExecMode.TAKER, // Filled as taker
          trade_type: "automated", // CRITICAL: Mark as automated to prevent manual classification
          driftOrderId: txId,
          txSignature: result.txSignature,
          venue: "drift",
        };

        this.positions.set(order.market, position);
        this.emit("positionOpened", position);
        console.log(
          `[DriftClient] Position created from TAKER fallback: ${order.market} ${order.side} @ $${entryPrice?.toFixed(4) || "N/A"} (positionId: ${order.id}, trade_type: automated)`
        );
      } else {
        console.error(`[DriftClient] TAKER fallback failed: no txSignature returned`);

        // CRITICAL FIX: Check if maker order filled before taker was attempted
        try {
          const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
          if (posResult.backoff) {
            console.warn(`[DriftClient] Backoff active - deferring position recovery after no-tx`);
            return;
          }
          const positions = posResult.positions || [];
          const onChainPos = positions.find(
            (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
          );

          if (onChainPos) {
            console.log(
              `[DriftClient] TAKER returned no tx but MAKER order ${order.id} was filled! Syncing...`
            );
            const entryPrice = Number(onChainPos.entryPrice || onChainPos.entry_price || 0);
            const sizeBase = Math.abs(
              Number(onChainPos.sizeBase || onChainPos.baseAssetAmount || 0)
            );
            const sizeUsd = Math.abs(
              Number(onChainPos.quoteAssetAmount || onChainPos.size_usd || sizeBase * entryPrice)
            );

            const position = {
              positionId: order.id,
              clientOrderId: order.id,
              market: order.market,
              marketIndex: order.marketIndex,
              side: order.side,
              entryPrice: entryPrice,
              collateral: order.collateral || sizeUsd,
              leverage: order.leverage || 1,
              size: sizeUsd,
              sizeUsd: sizeUsd,
              baseSize: sizeBase,
              sizeBase: sizeBase,
              openTime: Date.now(),
              liquidationPrice: this._calculateLiqPrice(
                entryPrice,
                order.leverage || 1,
                order.side
              ),
              strategyType: order.strategyType || "rsi-reversion-alt",
              trade_type: "automated",
              venue: "drift",
              execMode: "maker",
            };

            this.positions.set(order.market, position);
            this.emit("positionOpened", position);
            console.log(
              `[DriftClient] Position recovered: ${order.market} ${order.side} @ $${entryPrice?.toFixed(4) || "N/A"}`
            );
          }
        } catch (checkErr) {
          console.warn(
            `[DriftClient] Failed to check on-chain position after no-tx: ${checkErr.message}`
          );
          return;
        }

        // Still remove from working orders to prevent retry loops
        this.workingOrders.delete(order.id);
      }
    } catch (fallbackErr) {
      console.error(`[DriftClient] TAKER fallback error for ${order.id}: ${fallbackErr.message}`);

      // CRITICAL FIX: Before giving up, check if the MAKER order actually filled
      // This happens when: maker fills → taker fallback triggered (for unrelated reason) → taker fails
      // In this case the position EXISTS on-chain but we're about to lose tracking!
      try {
        const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
        if (posResult.backoff) {
          console.warn(
            `[DriftClient] Backoff active - deferring position recovery after taker error`
          );
          return;
        }
        const positions = posResult.positions || [];
        const onChainPos = positions.find(
          (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
        );

        if (onChainPos) {
          // The maker order DID fill! Track this position
          console.log(
            `[DriftClient] TAKER failed but MAKER order ${order.id} was already filled! Syncing position...`
          );

          const entryPrice = Number(onChainPos.entryPrice || onChainPos.entry_price || 0);
          const sizeBase = Math.abs(Number(onChainPos.sizeBase || onChainPos.baseAssetAmount || 0));
          const sizeUsd = Math.abs(
            Number(onChainPos.quoteAssetAmount || onChainPos.size_usd || sizeBase * entryPrice)
          );

          const position = {
            positionId: order.id,
            clientOrderId: order.id,
            market: order.market,
            marketIndex: order.marketIndex,
            side: order.side,
            entryPrice: entryPrice,
            collateral: order.collateral || sizeUsd,
            leverage: order.leverage || 1,
            size: sizeUsd,
            sizeUsd: sizeUsd,
            baseSize: sizeBase,
            sizeBase: sizeBase,
            openTime: Date.now(),
            liquidationPrice: this._calculateLiqPrice(entryPrice, order.leverage || 1, order.side),
            strategyType: order.strategyType || "rsi-reversion-alt",
            trade_type: "automated",
            venue: "drift",
            execMode: "maker",
          };

          this.positions.set(order.market, position);
          this.emit("positionOpened", position);
          console.log(
            `[DriftClient] Position recovered from failed TAKER fallback: ${order.market} ${order.side} @ $${entryPrice?.toFixed(4) || "N/A"}`
          );
        } else {
          console.log(
            `[DriftClient] No on-chain position found for ${order.market} after TAKER fallback error - order was likely cancelled`
          );
        }
      } catch (checkErr) {
        console.warn(
          `[DriftClient] Failed to check on-chain position after TAKER error: ${checkErr.message}`
        );
        return;
      }

      // Remove from working orders to prevent infinite retry loops
      this.workingOrders.delete(order.id);
    } finally {
      // CRITICAL: Always release lock when done
      order.releaseLock("fallback");
    }
  }

  /**
   * Fallback to taker for EXIT orders when maker exit times out
   * This closes the position with a market order instead of opening one
   */
  async _fallbackExitToTaker(order) {
    // CRITICAL: Acquire lock to prevent concurrent operations
    if (!order.acquireLock("fallback")) {
      console.log(
        `[DriftClient] Skipping EXIT TAKER fallback for ${order.id} - another operation in progress`
      );
      return;
    }

    console.log(
      `[DriftClient] EXIT TAKER FALLBACK for ${order.id} (${order.market}) - closing position with market order`
    );
    order.fallbackStartedAt = Date.now();

    try {
      // Check if position is already closed (maker exit filled)
      try {
        console.log(`[DriftClient] Checking if maker exit order ${order.id} was already filled...`);
        const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
        if (posResult && !posResult.backoff) {
          const positions = posResult.positions || [];
          const onChainPos = positions.find(
            (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
          );

          if (!onChainPos) {
            // Position is GONE - maker exit filled successfully!
            console.log(
              `[DriftClient] ✅ MAKER EXIT order ${order.id} was already FILLED! Position closed.`
            );

            order.state = OrderState.CLOSED;
            this.workingOrders.delete(order.id);
            this.stats.ordersFilled++;
            this.stats.makerFills++;

            const cachedPosition = this.positions.get(order.market) || null;
            let exitPrice = order.limitPrice;
            try {
              const freshPrice = await this.getMarketPrice(order.market);
              if (freshPrice && Number.isFinite(freshPrice) && freshPrice > 0) {
                exitPrice = freshPrice;
              }
            } catch (e) {
              // Best-effort; keep fallback exitPrice
            }
            const pnl =
              cachedPosition && Number.isFinite(exitPrice) && exitPrice > 0
                ? this._calculatePnL(cachedPosition, exitPrice)
                : null;

            // Remove from local positions cache before notifying
            this.positions.delete(order.market);

            this._emitPositionClosedOnce({
              positionId: order.positionId || cachedPosition?.positionId || order.id,
              market: order.market,
              marketIndex: order.marketIndex,
              side: order.side,
              position: cachedPosition,
              pnl,
              exitPrice,
              execMode: "maker",
              exitReason: order.exitReason || "maker_exit",
            });
            return;
          }
        }
      } catch (checkErr) {
        console.warn(`[DriftClient] Could not check if exit maker filled: ${checkErr.message}`);
        // Continue with taker fallback
      }

      // Cancel the maker exit order before placing taker
      try {
        console.log(
          `[DriftClient] Cancelling maker exit order userOrderId=${order.userOrderId} for ${order.market}`
        );
        await this.subprocess.send("cancelOrderByUserOrderId", {
          marketIndex: order.marketIndex,
          userOrderId: order.userOrderId,
          subaccount: this.config.subaccount,
        });
        console.log(`[DriftClient] Cancelled maker exit order userOrderId=${order.userOrderId}`);
      } catch (cancelErr) {
        const cancelMsg = String(cancelErr?.message || cancelErr || "");
        const cancelSummary = cancelMsg.replace(/\s+/g, " ").slice(0, 240);
        // If cancel fails with "Simulation failed" OR "Order not open", the order may have been filled/cancelled already.
        const isSimulationFailed = /Simulation failed/i.test(cancelMsg);
        const isOrderNotOpen =
          /Order not open|OrderNotOpen|custom program error:\s*0x17ae|Error Number:\s*6062/i.test(
            cancelMsg
          );
        if (isSimulationFailed || isOrderNotOpen) {
          console.log(
            `[DriftClient] Cancel failed (${isOrderNotOpen ? "OrderNotOpen" : "Simulation failed"}) - exit order may have been filled, checking...`
          );
          try {
            const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
            if (posResult && !posResult.backoff) {
              const positions = posResult.positions || [];
              const onChainPos = positions.find(
                (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
              );

              if (!onChainPos) {
                console.log(`[DriftClient] ✅ Exit order was filled! Position is closed.`);
                order.state = OrderState.CLOSED;
                this.workingOrders.delete(order.id);
                this.stats.ordersFilled++;
                this.stats.makerFills++;
                const cachedPosition = this.positions.get(order.market) || null;
                let exitPrice = order.limitPrice;
                try {
                  const freshPrice = await this.getMarketPrice(order.market);
                  if (freshPrice && Number.isFinite(freshPrice) && freshPrice > 0) {
                    exitPrice = freshPrice;
                  }
                } catch (e) {
                  // Best-effort; keep fallback exitPrice
                }
                const pnl =
                  cachedPosition && Number.isFinite(exitPrice) && exitPrice > 0
                    ? this._calculatePnL(cachedPosition, exitPrice)
                    : null;
                this.positions.delete(order.market);
                this._emitPositionClosedOnce({
                  positionId: order.positionId || cachedPosition?.positionId || order.id,
                  market: order.market,
                  marketIndex: order.marketIndex,
                  side: order.side,
                  position: cachedPosition,
                  pnl,
                  exitPrice,
                  execMode: "maker",
                  exitReason: order.exitReason || "maker_exit",
                });
                return;
              }
            }
          } catch (e) {
            console.warn(
              `[DriftClient] Could not verify position after exit cancel failure: ${e.message}`
            );
          }
        }
        console.warn(
          `[DriftClient] Warning: Failed to cancel exit order for ${order.market}: ${cancelSummary}`
        );
        // Continue anyway - the market close will work regardless
      }

      // Place taker close (market order with reduceOnly)
      console.log(`[DriftClient] Placing TAKER CLOSE for ${order.market} ${order.side}`);
      const fallbackUserOrderId = this._generateUserOrderId(order.marketIndex, "exit_fallback");

      // For closing, we need to trade the OPPOSITE side
      const closeSide = order.side === "long" ? "short" : "long";

      const result = await this.subprocess.send("placeMarketOrder", {
        marketIndex: order.marketIndex,
        side: closeSide,
        baseAssetAmount: order.size,
        reduceOnly: true,
        userOrderId: fallbackUserOrderId,
      });

      const txId = result.txSignature || result.orderId;
      if (txId) {
        console.log(
          `[DriftClient] EXIT TAKER fallback submitted: ${txId} - confirming on-chain...`
        );
        const confirmation = await this._confirmTransaction(txId, 30000);

        if (!confirmation.confirmed) {
          console.warn(
            `[DriftClient] EXIT TAKER fallback not confirmed - checking position state...`
          );
          this._enterUncertaintyWindow(
            `EXIT TAKER fallback unconfirmed for ${order.market}`,
            120000
          );

          // Check if position is actually closed
          let posResult;
          try {
            posResult = await this._getPositionsSnapshot({ forceRefresh: true });
          } catch (posErr) {
            console.warn(
              `[DriftClient] Position check failed after unconfirmed exit taker: ${posErr.message}`
            );
            return;
          }

          if (posResult.backoff) {
            console.warn(`[DriftClient] Backoff active - deferring exit taker fill verification`);
            return;
          }

          const positions = posResult.positions || [];
          const onChainPos = positions.find(
            (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
          );

          if (!onChainPos) {
            console.log(`[DriftClient] Position verified CLOSED despite unconfirmed tx`);
          } else {
            console.error(`[DriftClient] EXIT TAKER fallback tx ${txId} - position still open!`);
            this.workingOrders.delete(order.id);
            return;
          }
        }

        console.log(`[DriftClient] ✅ EXIT TAKER FALLBACK SUCCESS: ${txId}`);
        order.state = OrderState.CLOSED;
        this.workingOrders.delete(order.id);
        this.stats.fallbacksToTaker++;
        this.stats.takerFills++;
        this.stats.ordersFilled++;

        const cachedPosition = this.positions.get(order.market) || null;
        let exitPrice = order.limitPrice;
        try {
          const freshPrice = await this.getMarketPrice(order.market);
          if (freshPrice && Number.isFinite(freshPrice) && freshPrice > 0) {
            exitPrice = freshPrice;
          }
        } catch (e) {
          // Best-effort; keep fallback exitPrice
        }
        const pnl =
          cachedPosition && Number.isFinite(exitPrice) && exitPrice > 0
            ? this._calculatePnL(cachedPosition, exitPrice)
            : null;

        // Remove from local positions cache
        this.positions.delete(order.market);

        this._emitPositionClosedOnce({
          positionId: order.positionId || cachedPosition?.positionId || order.id,
          market: order.market,
          marketIndex: order.marketIndex,
          side: order.side,
          position: cachedPosition,
          pnl,
          exitPrice,
          execMode: "taker",
          exitReason: order.exitReason || "exit_taker_fallback",
          txSignature: txId,
        });

        console.log(
          `[DriftClient] Position closed via EXIT TAKER fallback: ${order.market} ${order.side}`
        );
      } else {
        console.error(`[DriftClient] EXIT TAKER fallback failed: no txSignature returned`);

        // Check if position is actually closed anyway
        try {
          const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
          if (posResult && !posResult.backoff) {
            const positions = posResult.positions || [];
            const onChainPos = positions.find(
              (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
            );

            if (!onChainPos) {
              console.log(`[DriftClient] EXIT TAKER returned no tx but position is closed!`);
              order.state = OrderState.CLOSED;
              const cachedPosition = this.positions.get(order.market) || null;
              let exitPrice = order.limitPrice;
              try {
                const freshPrice = await this.getMarketPrice(order.market);
                if (freshPrice && Number.isFinite(freshPrice) && freshPrice > 0) {
                  exitPrice = freshPrice;
                }
              } catch (e) {
                // Best-effort; keep fallback exitPrice
              }
              const pnl =
                cachedPosition && Number.isFinite(exitPrice) && exitPrice > 0
                  ? this._calculatePnL(cachedPosition, exitPrice)
                  : null;
              this.positions.delete(order.market);
              this._emitPositionClosedOnce({
                positionId: order.positionId || cachedPosition?.positionId || order.id,
                market: order.market,
                marketIndex: order.marketIndex,
                side: order.side,
                position: cachedPosition,
                pnl,
                exitPrice,
                execMode: "taker",
                exitReason: order.exitReason || "exit_taker_fallback",
              });
            }
          }
        } catch (checkErr) {
          console.warn(
            `[DriftClient] Failed to check position after exit no-tx: ${checkErr.message}`
          );
        }

        this.workingOrders.delete(order.id);
      }
    } catch (fallbackErr) {
      console.error(
        `[DriftClient] EXIT TAKER fallback error for ${order.id}: ${fallbackErr.message}`
      );

      // Check if position is closed despite the error
      try {
        const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
        if (posResult && !posResult.backoff) {
          const positions = posResult.positions || [];
          const onChainPos = positions.find(
            (p) => p.marketIndex === order.marketIndex && Math.abs(p.sizeBase || 0) > 0
          );

          if (!onChainPos) {
            console.log(`[DriftClient] EXIT TAKER failed but position is closed anyway!`);
            order.state = OrderState.CLOSED;
            const cachedPosition = this.positions.get(order.market) || null;
            let exitPrice = order.limitPrice;
            try {
              const freshPrice = await this.getMarketPrice(order.market);
              if (freshPrice && Number.isFinite(freshPrice) && freshPrice > 0) {
                exitPrice = freshPrice;
              }
            } catch (e) {
              // Best-effort; keep fallback exitPrice
            }
            const pnl =
              cachedPosition && Number.isFinite(exitPrice) && exitPrice > 0
                ? this._calculatePnL(cachedPosition, exitPrice)
                : null;
            this.positions.delete(order.market);
            this._emitPositionClosedOnce({
              positionId: order.positionId || cachedPosition?.positionId || order.id,
              market: order.market,
              marketIndex: order.marketIndex,
              side: order.side,
              position: cachedPosition,
              pnl,
              exitPrice,
              execMode: "unknown",
              exitReason: order.exitReason || "exit_error_but_closed",
            });
          }
        }
      } catch (checkErr) {
        console.warn(
          `[DriftClient] Failed to check position after exit fallback error: ${checkErr.message}`
        );
      }

      this.workingOrders.delete(order.id);
    } finally {
      order.releaseLock("fallback");
    }
  }

  /**
   * Calculate liquidation price
   */
  _calculateLiqPrice(entryPrice, leverage, side) {
    const maintenanceMargin = 1 / Math.max(1, leverage);
    const distance = entryPrice * maintenanceMargin;
    return side.toLowerCase() === "long"
      ? Math.max(0.0001, entryPrice - distance)
      : entryPrice + distance;
  }

  /**
   * Calculate PnL for a position
   */
  _calculatePnL(position, currentPrice) {
    const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
    const direction = position.side.toLowerCase() === "long" ? 1 : -1;
    return position.collateral * priceChange * direction * position.leverage;
  }

  /**
   * Calculate PnL percentage (for RiskManager compatibility)
   */
  calculatePnL(position, currentPrice) {
    const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
    const direction = position.side.toLowerCase() === "long" ? 1 : -1;
    return priceChange * direction * position.leverage * 100;
  }

  /**
   * Ensure client is initialized and subprocess is running
   */
  async _ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }

    // Also ensure subprocess is running (may have crashed after init)
    await this._ensureSubprocess();
  }

  _isCommandTimeoutError(err) {
    if (!err) return false;
    if (err.code === "TIMEOUT") return true;
    const msg = String(err.message || "");
    return /Command timeout/i.test(msg);
  }

  /**
   * Try to adopt an on-chain position after an unclear open result (timeout, error, etc.)
   * This prevents positions from being "lost" when the IPC call times out but the order succeeded.
   *
   * @param {string} market - Market symbol
   * @param {number} marketIndex - Market index
   * @param {string} side - 'long' or 'short'
   * @param {number} collateral - Expected collateral
   * @param {number} leverage - Expected leverage
   * @param {string} orderId - Client order ID to assign
   * @returns {Promise<Object|null>} Adopted position or null if no position found
   */
  async _tryAdoptOnChainPosition(market, marketIndex, side, collateral, leverage, orderId) {
    try {
      // Wait a bit for the transaction to propagate
      await new Promise((r) => setTimeout(r, 2000));

      const posResult = await this._getPositionsSnapshot({ forceRefresh: true });
      if (posResult.backoff || posResult.live === false) {
        console.warn(`[DriftClient] Cannot verify on-chain position (snapshot unavailable)`);
        return null;
      }

      const positions = posResult.positions || [];
      const onChainPosition = positions.find(
        (p) =>
          p.marketIndex === marketIndex &&
          Math.abs(p.sizeBase || 0) > 0 &&
          // Match side if position side is available
          (!p.side || p.side.toLowerCase() === side.toLowerCase())
      );

      if (!onChainPosition) {
        return null;
      }

      // Calculate entry price from on-chain data
      let entryPrice = 0;
      if (onChainPosition.entryPrice && onChainPosition.entryPrice > 0) {
        entryPrice = onChainPosition.entryPrice;
      } else if (onChainPosition.quoteEntryAmount && onChainPosition.baseAssetAmount) {
        const quoteEntry = Math.abs(Number(onChainPosition.quoteEntryAmount) / 1e6);
        const baseEntry = Math.abs(Number(onChainPosition.baseAssetAmount) / 1e9);
        if (baseEntry > 0) {
          entryPrice = quoteEntry / baseEntry;
        }
      }

      // Fallback to current market price
      if (!entryPrice || entryPrice <= 0) {
        try {
          entryPrice = await this.getMarketPrice(market);
        } catch (e) {
          console.warn(
            `[DriftClient] Could not get market price for adopted position: ${e.message}`
          );
        }
      }

      const sizeBase = Math.abs(onChainPosition.sizeBase || 0);
      const sizeUsd = sizeBase * entryPrice;

      // Create position object
      const adoptedPosition = {
        positionId: orderId || `drift-adopted-${marketIndex}-${Date.now()}`,
        clientOrderId: orderId,
        market,
        marketSymbol: market,
        marketIndex,
        side: side.toLowerCase(),
        collateral: collateral || sizeUsd / leverage,
        leverage: leverage || 1,
        size: sizeUsd,
        sizeUsd,
        baseSize: sizeBase,
        sizeBase,
        entryPrice,
        openTime: Date.now(),
        liquidationPrice: this._calculateLiqPrice(entryPrice, leverage, side),
        execMode: ExecMode.TAKER,
        trade_type: "automated", // Mark as automated to prevent manual classification
        venue: "drift",
        adopted: true, // Flag that this was adopted after unclear result
      };

      // Add to local tracking
      this.positions.set(market, adoptedPosition);
      this.emit("positionAdopted", adoptedPosition);

      console.log(
        `[DriftClient] Adopted on-chain position: ${market} ${side} @ $${entryPrice?.toFixed(4) || "N/A"} (baseSize: ${sizeBase})`
      );

      return adoptedPosition;
    } catch (err) {
      console.warn(`[DriftClient] Error trying to adopt on-chain position: ${err.message}`);
      return null;
    }
  }

  /**
   * Confirm a transaction on-chain
   * @param {string} txSignature - Transaction signature to confirm
   * @param {number} timeoutMs - Max time to wait for confirmation
   * @returns {Object} { confirmed: boolean, failed: boolean, error?: string }
   */
  async _confirmTransaction(txSignature, timeoutMs = 30000) {
    if (!txSignature) {
      return { confirmed: false, failed: true, error: "No txSignature provided" };
    }

    try {
      const result = await this.subprocess.send("confirmTransaction", {
        txSignature,
        commitment: "confirmed",
        timeout: timeoutMs,
      });

      return result;
    } catch (err) {
      console.warn(`[DriftClient] Transaction confirmation failed: ${err.message}`);
      return { confirmed: false, failed: true, error: err.message };
    }
  }

  /**
   * Get client stats
   */
  getStats() {
    return {
      ...this.stats,
      workingOrdersCount: this.workingOrders.size,
      openPositionsCount: this.positions.size,
      execMode: this.config.execMode,
      failedOrphanCancelsCount: this._failedOrphanCancels.size,
      disabledMarketsCount: this.disabledMarkets.size,
    };
  }

  /**
   * Reset failed orphan cancellation tracking
   * Call this to allow retrying orphan cancellations that previously failed
   */
  resetFailedOrphanCancels() {
    const count = this._failedOrphanCancels.size;
    this._failedOrphanCancels.clear();
    console.log(`[DriftClient] Cleared ${count} failed orphan cancellation records`);
    return count;
  }

  /**
   * Get list of orders that failed to cancel (orphan orders)
   */
  getFailedOrphanCancels() {
    return Array.from(this._failedOrphanCancels.entries()).map(([key, data]) => {
      const [marketIndex, userOrderId] = key.split(":");
      return {
        marketIndex: Number(marketIndex),
        userOrderId: Number(userOrderId),
        ...data,
      };
    });
  }

  /**
   * Set current market context
   */
  setMarket(market) {
    this.config.currentMarket = market;
  }
}

module.exports = DriftPerpsClient;
