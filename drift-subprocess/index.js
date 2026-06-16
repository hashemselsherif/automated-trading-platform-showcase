#!/usr/bin/env node
/* eslint-disable no-mixed-spaces-and-tabs */
/**
 * Drift SDK Subprocess
 *
 * Runs in an isolated Node environment with its own dependencies.
 * Communicates with the parent process via JSON messages on stdin/stdout.
 *
 * Message protocol:
 * - Parent sends: { "type": "command", "id": "uuid", "action": "...", "params": {...} }
 * - Subprocess responds: { "type": "response", "id": "uuid", "success": true/false, "data": {...}, "error": "..." }
 *
 * Security:
 * - Wallet is loaded LOCALLY from WALLET_PRIVATE_KEY_PATH (never via IPC)
 * - Private key bytes never sent in IPC messages
 * - Only public key logged
 */

const readline = require("readline");
const path = require("path");

// Lazy-load Drift SDK to catch load errors gracefully
let DriftClient, initialize, PerpMarkets, SpotMarkets, DRIFT_PROGRAM_ID, BN, Wallet;
let WebSocketDriftClientAccountSubscriber;
let OrderType, PositionDirection, OrderTriggerCondition, MarketType, PostOnlyParams;
let getLimitOrderParams, getMarketOrderParams;
let sdkLoaded = false;
let sdkError = null;

try {
  const sdk = require("@drift-labs/sdk");
  DriftClient = sdk.DriftClient;
  initialize = sdk.initialize;
  PerpMarkets = sdk.PerpMarkets;
  SpotMarkets = sdk.SpotMarkets;
  DRIFT_PROGRAM_ID = sdk.DRIFT_PROGRAM_ID;
  WebSocketDriftClientAccountSubscriber = sdk.WebSocketDriftClientAccountSubscriber;
  BN = sdk.BN;
  Wallet = sdk.Wallet;
  OrderType = sdk.OrderType;
  PositionDirection = sdk.PositionDirection;
  OrderTriggerCondition = sdk.OrderTriggerCondition;
  MarketType = sdk.MarketType;
  PostOnlyParams = sdk.PostOnlyParams;
  // Use SDK helper functions for proper order param construction
  getLimitOrderParams = sdk.getLimitOrderParams;
  getMarketOrderParams = sdk.getMarketOrderParams;
  sdkLoaded = true;
} catch (err) {
  sdkError = err.message;
}

const {
  Connection,
  PublicKey,
  Keypair,
  SendTransactionError,
  SYSVAR_CLOCK_PUBKEY,
} = require("@solana/web3.js");

let SafeWebSocketDriftClientAccountSubscriber = null;
if (sdkLoaded && WebSocketDriftClientAccountSubscriber) {
  SafeWebSocketDriftClientAccountSubscriber = class SafeWebSocketDriftClientAccountSubscriber extends (
    WebSocketDriftClientAccountSubscriber
  ) {
    getStateAccountAndSlot() {
      this.assertIsSubscribed();
      const dataAndSlot = this.stateAccountSubscriber?.dataAndSlot;
      if (!dataAndSlot?.data) {
        throw new Error("market data not ready for state");
      }
      return dataAndSlot;
    }

    getMarketAccountAndSlot(marketIndex) {
      this.assertIsSubscribed();
      const subscriber = this.perpMarketAccountSubscribers.get(marketIndex);
      const dataAndSlot = subscriber?.dataAndSlot;
      if (!subscriber || !dataAndSlot?.data) {
        throw new Error(`market data not ready for perpMarket(${marketIndex})`);
      }
      return dataAndSlot;
    }

    getSpotMarketAccountAndSlot(marketIndex) {
      this.assertIsSubscribed();
      const subscriber = this.spotMarketAccountSubscribers.get(marketIndex);
      const dataAndSlot = subscriber?.dataAndSlot;
      if (!subscriber || !dataAndSlot?.data) {
        throw new Error(`market data not ready for spotMarket(${marketIndex})`);
      }
      return dataAndSlot;
    }

    getOraclePriceDataAndSlot(oracleId) {
      this.assertIsSubscribed();
      try {
        const dataAndSlot = super.getOraclePriceDataAndSlot(oracleId);
        if (!dataAndSlot?.data) {
          throw new Error("oracle missing");
        }
        return dataAndSlot;
      } catch {
        throw new Error(`market data not ready for oracle(${oracleId})`);
      }
    }
  };
}

function patchWebSocketDriftClientAccountSubscriberSafety(AccountSubscriberClass) {
  if (!AccountSubscriberClass || !AccountSubscriberClass.prototype) return;
  const proto = AccountSubscriberClass.prototype;
  if (proto.__jupPerpsBotPatchedDataAndSlot) return;

  const hasPerpMap =
    proto &&
    typeof proto.getMarketAccountAndSlot === "function" &&
    typeof proto.assertIsSubscribed === "function";

  if (!hasPerpMap) return;

  const ensureSubscribed = (ctx) => {
    if (typeof ctx?.assertIsSubscribed === "function") {
      ctx.assertIsSubscribed();
    }
  };

  proto.getStateAccountAndSlot = function patchedGetStateAccountAndSlot() {
    ensureSubscribed(this);
    const dataAndSlot = this.stateAccountSubscriber?.dataAndSlot;
    if (!dataAndSlot?.data) {
      throw new Error("market data not ready for state");
    }
    return dataAndSlot;
  };

  // Patch unsafe getters to throw a stable, parseable error instead of TypeError.
  proto.getMarketAccountAndSlot = function patchedGetMarketAccountAndSlot(marketIndex) {
    ensureSubscribed(this);
    const subscriber = this.perpMarketAccountSubscribers?.get?.(marketIndex);
    const dataAndSlot = subscriber?.dataAndSlot;
    if (!subscriber || !dataAndSlot?.data) {
      throw new Error(`market data not ready for perpMarket(${marketIndex})`);
    }
    return dataAndSlot;
  };

  proto.getSpotMarketAccountAndSlot = function patchedGetSpotMarketAccountAndSlot(marketIndex) {
    ensureSubscribed(this);
    const subscriber = this.spotMarketAccountSubscribers?.get?.(marketIndex);
    const dataAndSlot = subscriber?.dataAndSlot;
    if (!subscriber || !dataAndSlot?.data) {
      throw new Error(`market data not ready for spotMarket(${marketIndex})`);
    }
    return dataAndSlot;
  };

  const originalGetOracle = proto.getOraclePriceDataAndSlot;
  proto.getOraclePriceDataAndSlot = function patchedGetOraclePriceDataAndSlot(oracleId) {
    ensureSubscribed(this);
    try {
      const dataAndSlot =
        typeof originalGetOracle === "function" ? originalGetOracle.call(this, oracleId) : null;
      if (!dataAndSlot?.data) {
        throw new Error("oracle missing");
      }
      return dataAndSlot;
    } catch {
      throw new Error(`market data not ready for oracle(${oracleId})`);
    }
  };

  proto.__jupPerpsBotPatchedDataAndSlot = true;
}

if (sdkLoaded && WebSocketDriftClientAccountSubscriber) {
  patchWebSocketDriftClientAccountSubscriberSafety(WebSocketDriftClientAccountSubscriber);
}

function toPublicKey(maybePubkey) {
  if (!maybePubkey) return null;
  if (typeof maybePubkey === "string") return new PublicKey(maybePubkey);
  if (typeof maybePubkey.toBuffer === "function") return maybePubkey;
  if (typeof maybePubkey.toBase58 === "function") return new PublicKey(maybePubkey.toBase58());
  return null;
}

function publicKeyToString(maybePubkey) {
  if (!maybePubkey) return null;
  if (typeof maybePubkey === "string") return maybePubkey;
  if (typeof maybePubkey.toBase58 === "function") return maybePubkey.toBase58();
  if (typeof maybePubkey.toString === "function") return maybePubkey.toString();
  return null;
}

// Load secure wallet loader from parent project
let secureWalletLoader = null;
try {
  secureWalletLoader = require("../utils/secure-wallet-loader");
} catch (err) {
  // Fallback: loader not available (standalone testing)
}

// State
let connection = null;
let driftClient = null;
let bulkAccountLoader = null;
let walletKeypair = null;
let walletPubkey = null;
let cluster = null;
let subaccountId = 0;
let warnedSubaccountMismatch = false;
let isInitialized = false;
const userOrderIdToOrderId = new Map();
const orderIdToUserOrderId = new Map();
const orderIdLastSeen = new Map();
const ORDER_ID_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ORDER_ID_CACHE_MAX = 2000;
let resubscribeInProgress = false;
let lastResubscribeAt = 0;
const RESUBSCRIBE_COOLDOWN_MS = 60000;
const RESUBSCRIBE_WINDOW_MS = Number(process.env.DRIFT_RESUB_WINDOW_MS) || 5 * 60 * 1000;
const RESUBSCRIBE_MAX_ATTEMPTS = Number(process.env.DRIFT_RESUB_MAX_ATTEMPTS) || 3;
const resubscribeAttempts = new Map(); // subaccount -> { count, windowStart }

function isNil(value) {
  return value === null || value === undefined;
}

// Promise coalescing for in-flight polling requests
const inFlightOpenOrdersPromises = new Map(); // subaccount -> Promise
const inFlightPositionsPromises = new Map(); // subaccount -> Promise
let lastPositionsRefreshAt = 0;
const lastForcedRefreshAtBySubaccount = new Map(); // subaccount -> ts
const FORCED_REFRESH_MIN_INTERVAL_MS =
  Number(process.env.DRIFT_FORCED_REFRESH_MIN_INTERVAL_MS) || 2000;

async function maybeForceUserRefresh(user, subaccount, reason = "force") {
  if (!user || typeof user.fetchAccounts !== "function") return;
  const now = Date.now();
  const last = lastForcedRefreshAtBySubaccount.get(subaccount) || 0;
  if (now - last < FORCED_REFRESH_MIN_INTERVAL_MS) return;
  lastForcedRefreshAtBySubaccount.set(subaccount, now);
  try {
    await user.fetchAccounts();
  } catch (err) {
    log(`[WARN] Forced refresh failed (${reason}) for subaccount ${subaccount}: ${err.message}`);
  }
}

// Drift SDK blockhash caching (TxHandler) to reduce RPC pressure.
// IMPORTANT: do not prefetch blockhashes manually here — it adds extra RPC calls and does not feed
// Drift's internal tx builder. Configure txHandlerConfig on DriftClient instead.
let sdkBlockhashStaleCacheTimeMs = 2000;
const MARKET_READY_TTL_MS = Number(process.env.DRIFT_MARKET_READY_TTL_MS) || 30000;
const marketReadyAt = new Map();
const marketNotReadyLoggedAt = new Map();
const MARKET_NOT_READY_LOG_TTL_MS = Number(process.env.DRIFT_MARKET_NOT_READY_LOG_TTL_MS) || 60000;

// Global RPC backoff state for 429 errors
let rpcBackoffUntil = 0;
let rpcBackoffMs = 0;
const RPC_BACKOFF_BASE_MS = 1000;
const RPC_BACKOFF_MAX_MS = 30000;
let rateLimitedEndpoints = new Map(); // endpoint -> backoffUntil
let gpaThrottleLogged = false;

const GPA_MIN_INTERVAL_MS = Number(process.env.DRIFT_GPA_MIN_INTERVAL_MS) || 250;

let basePollingFrequencyMs = null;
let currentPollingFrequencyMs = null;
let pollingBoostRefCount = 0;
let pollingBoostTimer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, { min, max, fallback }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (Number.isFinite(min) && num < min) return min;
  if (Number.isFinite(max) && num > max) return max;
  return num;
}

function updatePollingFrequency(nextMs, reason = "") {
  if (!bulkAccountLoader || typeof bulkAccountLoader.updatePollingFrequency !== "function") return;
  if (!Number.isFinite(nextMs) || nextMs <= 0) return;
  if (currentPollingFrequencyMs === nextMs) return;
  try {
    bulkAccountLoader.updatePollingFrequency(nextMs);
    currentPollingFrequencyMs = nextMs;
    log(`[POLL] pollingFrequency=${nextMs}ms${reason ? ` (${reason})` : ""}`);
  } catch (e) {
    log(`[WARN] Failed to update polling frequency: ${e.message}`);
  }
}

function acquirePollingBoost() {
  if (!bulkAccountLoader) return;
  const boostMs = clampNumber(process.env.DRIFT_POLLING_BOOST_MS, {
    min: 150,
    max: 5000,
    fallback: 300,
  });
  pollingBoostRefCount += 1;
  if (pollingBoostTimer) {
    clearTimeout(pollingBoostTimer);
    pollingBoostTimer = null;
  }
  updatePollingFrequency(boostMs, "boost");
}

function releasePollingBoost() {
  if (!bulkAccountLoader) return;
  pollingBoostRefCount = Math.max(0, pollingBoostRefCount - 1);
  if (pollingBoostRefCount > 0) return;
  const ttlMs = clampNumber(process.env.DRIFT_POLLING_BOOST_TTL_MS, {
    min: 250,
    max: 30000,
    fallback: 5000,
  });
  if (pollingBoostTimer) {
    clearTimeout(pollingBoostTimer);
  }
  pollingBoostTimer = setTimeout(() => {
    pollingBoostTimer = null;
    if (pollingBoostRefCount > 0) return;
    if (Number.isFinite(basePollingFrequencyMs)) {
      updatePollingFrequency(basePollingFrequencyMs, "base");
    }
  }, ttlMs);
}

function resetPollingState() {
  pollingBoostRefCount = 0;
  basePollingFrequencyMs = null;
  currentPollingFrequencyMs = null;
  if (pollingBoostTimer) {
    clearTimeout(pollingBoostTimer);
    pollingBoostTimer = null;
  }
}

async function ensurePerpMarketReady(marketIndex) {
  if (!driftClient || !driftClient.accountSubscriber) return false;
  const subscriber = driftClient.accountSubscriber;
  const debug = process.env.DRIFT_DEBUG_MARKET_READY === "true";
  const {
    getOracleId,
    getPerpMarketPublicKey,
    getSpotMarketPublicKey,
    getDriftStateAccountPublicKey,
    getUserAccountPublicKey,
    getUserStatsAccountPublicKey,
  } = require("@drift-labs/sdk");

  // Polling subscriber uses DataAndSlot objects stored in Maps:
  // - perpMarket: Map<number, DataAndSlot<PerpMarketAccount>>
  // - spotMarket: Map<number, DataAndSlot<SpotMarketAccount>>
  // - oracles: Map<string, DataAndSlot<OraclePriceData>>
  const isPollingSubscriber =
    subscriber && subscriber.perpMarket instanceof Map && subscriber.spotMarket instanceof Map;

  const oracleMap = subscriber && subscriber.oracles instanceof Map ? subscriber.oracles : null;

  const capitalize = (str) => (str ? `${str.charAt(0).toUpperCase()}${str.slice(1)}` : str);

  // Fast-path: verify the *current* subscription state before doing any heavy fixups.
  // This prevents stale MARKET_READY_TTL_MS caching from hiding missing WS subscribers
  // (which leads to `Cannot read properties of undefined (reading 'dataAndSlot')`).
  try {
    if (isPollingSubscriber) {
      const stateOk = Boolean(subscriber?.state?.data);
      const perpOk = Boolean(subscriber?.perpMarket?.get?.(marketIndex)?.data);
      const quoteIdx = subscriber?.perpMarket?.get?.(marketIndex)?.data?.quoteSpotMarketIndex ?? 0;
      const spotOk = Boolean(subscriber?.spotMarket?.get?.(quoteIdx)?.data);
      if (stateOk && perpOk && spotOk) {
        marketReadyAt.set(marketIndex, Date.now());
        return true;
      }
    } else if (
      subscriber?.perpMarketAccountSubscribers &&
      subscriber?.spotMarketAccountSubscribers
    ) {
      const stateOk = Boolean(subscriber?.stateAccountSubscriber?.dataAndSlot?.data);
      const perpSub = subscriber.perpMarketAccountSubscribers.get(marketIndex);
      const perpOk = Boolean(perpSub?.dataAndSlot?.data);
      const quoteIdx = perpSub?.dataAndSlot?.data?.quoteSpotMarketIndex ?? 0;
      const spotSub = subscriber.spotMarketAccountSubscribers.get(quoteIdx);
      const spotOk = Boolean(spotSub?.dataAndSlot?.data);
      if (stateOk && perpOk && spotOk) {
        let perpOracleOk = true;
        let spotOracleOk = true;

        const oracleSubscribers = subscriber?.oracleSubscribers;
        if (oracleSubscribers && typeof oracleSubscribers.get === "function") {
          const perpOraclePk = perpSub?.dataAndSlot?.data?.amm?.oracle;
          const perpOracleSource = perpSub?.dataAndSlot?.data?.amm?.oracleSource;
          if (perpOraclePk && !isNil(perpOracleSource)) {
            perpOracleOk =
              (perpOraclePk.equals && perpOraclePk.equals(PublicKey.default)) ||
              Boolean(
                oracleSubscribers.get(getOracleId(perpOraclePk, perpOracleSource))?.dataAndSlot
                  ?.data
              );
          }

          const spotOraclePk = spotSub?.dataAndSlot?.data?.oracle;
          const spotOracleSource = spotSub?.dataAndSlot?.data?.oracleSource;
          if (spotOraclePk && !isNil(spotOracleSource)) {
            spotOracleOk =
              (spotOraclePk.equals && spotOraclePk.equals(PublicKey.default)) ||
              Boolean(
                oracleSubscribers.get(getOracleId(spotOraclePk, spotOracleSource))?.dataAndSlot
                  ?.data
              );
          }
        }

        if (!perpOracleOk || !spotOracleOk) {
          // Not ready yet; fall through to fixups below.
        } else {
          marketReadyAt.set(marketIndex, Date.now());
          return true;
        }
      }
    }
  } catch (e) {
    if (debug) log(`[WARN] ensurePerpMarketReady fast-path failed: ${e.message}`);
  }

  const directFetchAnchorAccount = async (accountKey, publicKey) => {
    if (!driftClient?.program || !connection) return null;
    try {
      await awaitRpcBackoff("ACCT", connection?.rpcEndpoint);
      const ctx = await connection.getAccountInfoAndContext(publicKey, { commitment: "confirmed" });
      const slot = ctx?.context?.slot;
      const value = ctx?.value;
      const buf = value?.data || null;
      if (!buf) return null;
      const decoded = driftClient.program.account[accountKey].coder.accounts.decodeUnchecked(
        capitalize(accountKey),
        buf
      );
      return { decoded, slot: Number.isFinite(slot) ? slot : 0 };
    } catch (err) {
      if (isRateLimitError(err)) {
        applyRpcBackoff(connection?.rpcEndpoint, "ACCT");
      }
      if (debug) log(`[WARN] directFetchAnchorAccount(${accountKey}) failed: ${err.message}`);
      return null;
    }
  };

  const directFetchPerpMarket = async (idx) => {
    if (!driftClient?.program?.programId || !connection || !subscriber?.perpMarket) return null;
    try {
      const pk = await getPerpMarketPublicKey(driftClient.program.programId, idx);
      const fetched = await directFetchAnchorAccount("perpMarket", pk);
      if (!fetched) return null;
      subscriber.perpMarket.set(idx, { data: fetched.decoded, slot: fetched.slot });
      return fetched.decoded;
    } catch (e) {
      if (debug) log(`[WARN] directFetchPerpMarket(${idx}) failed: ${e.message}`);
      return null;
    }
  };

  const directFetchSpotMarket = async (idx) => {
    if (!driftClient?.program?.programId || !connection || !subscriber?.spotMarket) return null;
    try {
      const pk = await getSpotMarketPublicKey(driftClient.program.programId, idx);
      const fetched = await directFetchAnchorAccount("spotMarket", pk);
      if (!fetched) return null;
      subscriber.spotMarket.set(idx, { data: fetched.decoded, slot: fetched.slot });
      return fetched.decoded;
    } catch (e) {
      if (debug) log(`[WARN] directFetchSpotMarket(${idx}) failed: ${e.message}`);
      return null;
    }
  };

  const directFetchOracle = async (oraclePk, oracleSource) => {
    if (!oracleMap || !subscriber?.oracleClientCache || !driftClient?.program || !connection)
      return false;
    try {
      const oracleId = getOracleId(oraclePk, oracleSource);
      const existing = oracleMap.get(oracleId);
      if (existing?.data) return true;

      await awaitRpcBackoff("ORACLE", connection?.rpcEndpoint);
      const ctx = await connection.getAccountInfoAndContext(oraclePk, { commitment: "confirmed" });
      const slot = ctx?.context?.slot;
      const buf = ctx?.value?.data || null;
      if (!buf) return false;

      const oracleClient = subscriber.oracleClientCache.get(
        oracleSource,
        driftClient.program.provider.connection,
        driftClient.program
      );
      const oraclePriceData = oracleClient.getOraclePriceDataFromBuffer(buf);
      oracleMap.set(oracleId, { data: oraclePriceData, slot: Number.isFinite(slot) ? slot : 0 });
      return true;
    } catch (err) {
      if (isRateLimitError(err)) {
        applyRpcBackoff(connection?.rpcEndpoint, "ORACLE");
      }
      if (debug) log(`[WARN] directFetchOracle failed: ${err.message}`);
      return false;
    }
  };

  const ensureStateReady = async () => {
    if (subscriber?.state?.data) return true;
    if (!driftClient?.program?.programId) return false;
    try {
      const pk = await getDriftStateAccountPublicKey(driftClient.program.programId);
      const fetched = await directFetchAnchorAccount("state", pk);
      if (fetched) {
        subscriber.state = { data: fetched.decoded, slot: fetched.slot };
      }
    } catch (e) {
      if (debug) log(`[WARN] ensureStateReady failed: ${e.message}`);
    }
    return Boolean(subscriber?.state?.data);
  };

  const ensureUserAndStatsReady = async () => {
    if (!driftClient?.program?.programId) return false;
    const authority = driftClient?.authority || driftClient?.wallet?.publicKey;
    if (!authority) return false;

    let userReady = false;
    try {
      let user =
        typeof driftClient.getUser === "function"
          ? driftClient.getUser(subaccountId, authority)
          : null;
      const userSlot =
        typeof user?.getUserAccountAndSlot === "function" ? user.getUserAccountAndSlot() : null;
      userReady = Boolean(userSlot?.data);

      if (!userReady && typeof driftClient.addUser === "function") {
        try {
          const ok = await driftClient.addUser(subaccountId, authority);
          if (ok && typeof driftClient.getUser === "function") {
            user = driftClient.getUser(subaccountId, authority);
          }
        } catch (e) {
          if (debug) log(`[WARN] ensureUserAndStatsReady addUser failed: ${e.message}`);
        }
      }

      if (!userReady) {
        const pk = await getUserAccountPublicKey(
          driftClient.program.programId,
          authority,
          subaccountId
        );
        const fetched = await directFetchAnchorAccount("user", pk);
        if (fetched && user?.accountSubscriber && "user" in user.accountSubscriber) {
          user.accountSubscriber.user = { data: fetched.decoded, slot: fetched.slot };
        }
        try {
          const refreshed =
            typeof user?.getUserAccountAndSlot === "function" ? user.getUserAccountAndSlot() : null;
          userReady = Boolean(refreshed?.data);
        } catch {
          // ignore
        }
      }
    } catch (e) {
      if (debug) log(`[WARN] ensureUserAndStatsReady user fetch failed: ${e.message}`);
    }

    let statsReady = false;
    try {
      const userStats =
        typeof driftClient.getUserStats === "function" ? driftClient.getUserStats() : null;
      // UserStats is optional in the Drift SDK. If not enabled, don't block readiness on it.
      if (!userStats) {
        return userReady;
      }
      const statsSlot =
        typeof userStats?.getAccountAndSlot === "function" ? userStats.getAccountAndSlot() : null;
      statsReady = Boolean(statsSlot?.data);

      if (!statsReady) {
        const pk = getUserStatsAccountPublicKey(driftClient.program.programId, authority);
        const fetched = await directFetchAnchorAccount("userStats", pk);
        if (fetched && userStats?.accountSubscriber && "userStats" in userStats.accountSubscriber) {
          userStats.accountSubscriber.userStats = { data: fetched.decoded, slot: fetched.slot };
        }
        try {
          const refreshed =
            typeof userStats?.getAccountAndSlot === "function"
              ? userStats.getAccountAndSlot()
              : null;
          statsReady = Boolean(refreshed?.data);
        } catch {
          // ignore
        }
      }
    } catch (e) {
      if (debug) log(`[WARN] ensureUserAndStatsReady userStats fetch failed: ${e.message}`);
    }

    return userReady && statsReady;
  };

  const fetchIfMissing = async (accountSub, label) => {
    if (!accountSub || typeof accountSub.fetch !== "function") return;
    const data = accountSub.dataAndSlot?.data;
    if (!data) {
      if (debug) log(`[FIXUP] ensurePerpMarketReady: fetching ${label}`);
      await accountSub.fetch();
    }
  };

  const ensurePollingMarket = async (type, index) => {
    if (!index && index !== 0) return;
    const fn =
      type === "perp"
        ? subscriber.addPerpMarket
        : type === "spot"
          ? subscriber.addSpotMarket
          : null;
    const map =
      type === "perp" ? subscriber.perpMarket : type === "spot" ? subscriber.spotMarket : null;
    if (!map || !(map instanceof Map) || typeof fn !== "function") return;
    if (map.has(index)) return;
    try {
      if (debug)
        log(
          `[FIXUP] ensurePerpMarketReady(polling): add${type === "perp" ? "Perp" : "Spot"}Market(${index})`
        );
      await fn.call(subscriber, index);
    } catch (e) {
      log(`[WARN] ensurePerpMarketReady(polling) add${type}Market(${index}) failed: ${e.message}`);
    }
  };

  const ensurePollingOracle = async (oraclePk, oracleSource, label) => {
    if (!oracleMap) return;
    try {
      if (isNil(oraclePk) || isNil(oracleSource)) return;
      if (oraclePk.equals && oraclePk.equals(PublicKey.default)) return;
      const oracleId = getOracleId(oraclePk, oracleSource);
      const existing = oracleMap.get(oracleId);
      if (existing?.data) return;
      if (typeof subscriber.addOracle === "function") {
        if (debug)
          log(
            `[FIXUP] ensurePerpMarketReady(polling): addOracle(${label}) ${oraclePk.toString?.() || oraclePk}`
          );
        await subscriber.addOracle({ publicKey: oraclePk, source: oracleSource });
      }
    } catch (e) {
      log(`[WARN] ensurePerpMarketReady(polling) addOracle failed for ${label}: ${e.message}`);
    }
  };

  const ensureOracleSubscriber = async (oraclePk, oracleSource, label) => {
    try {
      // NOTE: Drift's OracleSource enum uses 0 for PYTH, so we must not treat 0 as "missing".
      if (isNil(oraclePk) || isNil(oracleSource)) return false;
      if (!subscriber.oracleSubscribers || typeof subscriber.oracleSubscribers.has !== "function")
        return false;
      const oracleId = getOracleId(oraclePk, oracleSource);
      if (oraclePk.equals && oraclePk.equals(PublicKey.default)) return true;

      const ensureFetched = async () => {
        const oracleSub = subscriber.oracleSubscribers?.get?.(oracleId);
        if (oracleSub) {
          try {
            await fetchIfMissing(oracleSub, `oracle(${label})`);
          } catch (e) {
            if (debug)
              log(`[WARN] ensurePerpMarketReady oracle fetch failed for ${label}: ${e.message}`);
          }
        }
        return Boolean(oracleSub?.dataAndSlot?.data);
      };

      if (subscriber.oracleSubscribers.has(oracleId)) {
        return await ensureFetched();
      }
      if (typeof subscriber.addOracle === "function") {
        if (debug) {
          log(
            `[FIXUP] ensurePerpMarketReady: subscribing missing ${label} oracle ${oraclePk.toString?.() || oraclePk}`
          );
        }
        await subscriber.addOracle({ publicKey: oraclePk, source: oracleSource });
      }
      return await ensureFetched();
    } catch (err) {
      log(`[WARN] ensurePerpMarketReady failed to subscribe ${label} oracle: ${err.message}`);
      return false;
    }
  };

  try {
    if (isPollingSubscriber) {
      const maxRounds = clampNumber(process.env.DRIFT_MARKET_READY_ROUNDS, {
        min: 1,
        max: 20,
        fallback: 6,
      });
      const roundSleepMs = clampNumber(process.env.DRIFT_MARKET_READY_SLEEP_MS, {
        min: 25,
        max: 500,
        fallback: 75,
      });
      let lastNotReadyStatus = null;

      // Ensure requested perp market is tracked (polling subscriber only loads configured markets).
      await ensurePollingMarket("perp", marketIndex);

      for (let round = 0; round < maxRounds; round += 1) {
        const stateReady = await ensureStateReady();
        const userReady = await ensureUserAndStatsReady();

        if (typeof subscriber.fetch === "function") {
          try {
            if (debug)
              log(
                `[FIXUP] ensurePerpMarketReady(polling): fetch() round=${round + 1}/${maxRounds} market=${marketIndex}`
              );
            await subscriber.fetch();
          } catch (e) {
            log(
              `[WARN] ensurePerpMarketReady(polling) fetch failed for ${marketIndex}: ${e.message}`
            );
          }
        }

        const perpEntry = subscriber.perpMarket.get(marketIndex) || null;
        let perpData = perpEntry?.data || null;
        if (!perpData) {
          perpData = await directFetchPerpMarket(marketIndex);
        }
        const quoteSpotMarketIndex = Number.isFinite(perpData?.quoteSpotMarketIndex)
          ? perpData.quoteSpotMarketIndex
          : 0;

        // Ensure the quote spot market is tracked (required for remaining accounts on perp orders).
        await ensurePollingMarket("spot", quoteSpotMarketIndex);

        const spotEntry = subscriber.spotMarket.get(quoteSpotMarketIndex) || null;
        let spotData = spotEntry?.data || null;
        if (!spotData) {
          spotData = await directFetchSpotMarket(quoteSpotMarketIndex);
        }

        try {
          if (typeof subscriber.setPerpOracleMap === "function") {
            await subscriber.setPerpOracleMap();
          }
        } catch (e) {
          log(`[WARN] ensurePerpMarketReady(polling) setPerpOracleMap failed: ${e.message}`);
        }
        try {
          if (typeof subscriber.setSpotOracleMap === "function") {
            await subscriber.setSpotOracleMap();
          }
        } catch (e) {
          log(`[WARN] ensurePerpMarketReady(polling) setSpotOracleMap failed: ${e.message}`);
        }

        // Ensure oracle accounts are present in polling mode (oracles map uses DataAndSlot.data).
        if (perpData?.amm?.oracle && !isNil(perpData?.amm?.oracleSource)) {
          await ensurePollingOracle(
            perpData.amm.oracle,
            perpData.amm.oracleSource,
            `perp(${marketIndex})`
          );
          await directFetchOracle(perpData.amm.oracle, perpData.amm.oracleSource);
        }
        if (spotData?.oracle && !isNil(spotData?.oracleSource)) {
          await ensurePollingOracle(
            spotData.oracle,
            spotData.oracleSource,
            `spot(${quoteSpotMarketIndex})`
          );
          await directFetchOracle(spotData.oracle, spotData.oracleSource);
        }

        const perpOracleReady = !oracleMap
          ? true
          : perpData?.amm?.oracle
            ? Boolean(
                oracleMap.get(getOracleId(perpData.amm.oracle, perpData.amm.oracleSource))?.data
              )
            : true;
        const spotOracleReady = !oracleMap
          ? true
          : spotData?.oracle
            ? Boolean(oracleMap.get(getOracleId(spotData.oracle, spotData.oracleSource))?.data)
            : true;

        if (stateReady && userReady && perpData && spotData && perpOracleReady && spotOracleReady) {
          marketReadyAt.set(marketIndex, Date.now());
          return true;
        }

        lastNotReadyStatus = {
          marketIndex,
          stateReady,
          userReady,
          hasPerp: Boolean(perpData),
          quoteSpotMarketIndex,
          hasSpot: Boolean(spotData),
          perpOracleReady,
          spotOracleReady,
        };

        if (debug) {
          log(
            `[FIXUP] ensurePerpMarketReady(polling): not ready round=${round + 1}/${maxRounds} market=${marketIndex} ` +
              `(perp=${Boolean(perpData)} quoteSpot=${quoteSpotMarketIndex} spot=${Boolean(spotData)} ` +
              `state=${stateReady} user=${userReady} perpOracle=${perpOracleReady} spotOracle=${spotOracleReady})`
          );
        }

        await sleep(roundSleepMs);
      }

      if (lastNotReadyStatus) {
        const lastLogged = marketNotReadyLoggedAt.get(marketIndex) || 0;
        const nowMs = Date.now();
        if (nowMs - lastLogged >= MARKET_NOT_READY_LOG_TTL_MS) {
          marketNotReadyLoggedAt.set(marketIndex, nowMs);
          log(
            `[WARN] perp market not ready after ${maxRounds} rounds: ` +
              `market=${marketIndex} state=${lastNotReadyStatus.stateReady} user=${lastNotReadyStatus.userReady} perp=${lastNotReadyStatus.hasPerp} ` +
              `quoteSpot=${lastNotReadyStatus.quoteSpotMarketIndex} spot=${lastNotReadyStatus.hasSpot} ` +
              `perpOracle=${lastNotReadyStatus.perpOracleReady} spotOracle=${lastNotReadyStatus.spotOracleReady}`
          );
        }
      }

      return false;
    }

    await fetchIfMissing(subscriber?.stateAccountSubscriber, "state");

    const perpMap = subscriber.perpMarketAccountSubscribers;
    let marketSub = perpMap && typeof perpMap.get === "function" ? perpMap.get(marketIndex) : null;
    if (!marketSub && typeof subscriber.addPerpMarket === "function") {
      if (debug) log(`[FIXUP] ensurePerpMarketReady: addPerpMarket(${marketIndex})`);
      await subscriber.addPerpMarket(marketIndex);
      marketSub = perpMap && typeof perpMap.get === "function" ? perpMap.get(marketIndex) : null;
    }

    await fetchIfMissing(marketSub, `perpMarket(${marketIndex})`);
    const perpData = marketSub?.dataAndSlot?.data || null;

    // Drift SDK always includes the perp's quote spot market (usually USDC=0)
    // in remaining accounts when placing orders. If we don't subscribe to it,
    // order placement can throw "Cannot read properties of undefined (reading 'dataAndSlot')".
    const quoteSpotMarketIndex = Number.isFinite(perpData?.quoteSpotMarketIndex)
      ? perpData.quoteSpotMarketIndex
      : 0;
    const spotMap = subscriber.spotMarketAccountSubscribers;
    let spotSub =
      spotMap && typeof spotMap.get === "function" ? spotMap.get(quoteSpotMarketIndex) : null;
    if (!spotSub && typeof subscriber.addSpotMarket === "function") {
      if (debug) log(`[FIXUP] ensurePerpMarketReady: addSpotMarket(${quoteSpotMarketIndex})`);
      await subscriber.addSpotMarket(quoteSpotMarketIndex);
      spotSub =
        spotMap && typeof spotMap.get === "function" ? spotMap.get(quoteSpotMarketIndex) : null;
    }

    await fetchIfMissing(spotSub, `spotMarket(${quoteSpotMarketIndex})`);
    const spotData = spotSub?.dataAndSlot?.data || null;

    try {
      if (typeof subscriber.setSpotOracleMap === "function") {
        const spotOracleId = subscriber.spotOracleStringMap?.get?.(quoteSpotMarketIndex);
        const hasSpotOracleSub = spotOracleId && subscriber.oracleSubscribers?.has?.(spotOracleId);
        if (!spotOracleId || !hasSpotOracleSub) {
          await subscriber.setSpotOracleMap();
        }
      }
    } catch (spotOracleErr) {
      log(
        `[WARN] ensurePerpMarketReady setSpotOracleMap failed for ${quoteSpotMarketIndex}: ${spotOracleErr.message}`
      );
    }
    let spotOracleReady = true;
    if (spotData?.oracle && !isNil(spotData?.oracleSource)) {
      spotOracleReady = await ensureOracleSubscriber(
        spotData.oracle,
        spotData.oracleSource,
        `spot(${quoteSpotMarketIndex})`
      );
    }

    // Ensure oracle mapping/subscription exists for this market
    try {
      if (typeof subscriber.setPerpOracleMap === "function") {
        const oracleId = subscriber.perpOracleStringMap?.get?.(marketIndex);
        const hasOracleSub = oracleId && subscriber.oracleSubscribers?.has?.(oracleId);
        if (!oracleId || !hasOracleSub) {
          await subscriber.setPerpOracleMap();
        }
      }
    } catch (oracleErr) {
      log(
        `[WARN] ensurePerpMarketReady oracle refresh failed for ${marketIndex}: ${oracleErr.message}`
      );
    }

    let perpOracleReady = true;
    if (perpData?.amm?.oracle && !isNil(perpData?.amm?.oracleSource)) {
      perpOracleReady = await ensureOracleSubscriber(
        perpData.amm.oracle,
        perpData.amm.oracleSource,
        `perp(${marketIndex})`
      );
    }

    // Only mark ready if we actually have the core market accounts loaded.
    // Otherwise we may suppress future fixups and keep throwing dataAndSlot errors.
    const stateOk = Boolean(subscriber?.stateAccountSubscriber?.dataAndSlot?.data);
    if (stateOk && perpData && spotData && perpOracleReady && spotOracleReady) {
      marketReadyAt.set(marketIndex, Date.now());
      return true;
    }
  } catch (err) {
    log(`[WARN] ensurePerpMarketReady failed for ${marketIndex}: ${err.message}`);
  }
  return false;
}

function getMarketTypeKey(marketType) {
  if (!marketType) return null;
  if (typeof marketType === "string") return marketType.toLowerCase();
  if (typeof marketType === "object") {
    const keys = Object.keys(marketType);
    if (keys.length === 1) return keys[0].toLowerCase();
  }
  return null;
}

async function ensureSpotMarketReady(spotMarketIndex) {
  if (!driftClient || !driftClient.accountSubscriber) return false;
  const subscriber = driftClient.accountSubscriber;
  const debug = process.env.DRIFT_DEBUG_MARKET_READY === "true";
  const isPollingSubscriber =
    subscriber && subscriber.perpMarket instanceof Map && subscriber.spotMarket instanceof Map;

  const fetchIfMissing = async (accountSub, label) => {
    if (!accountSub || typeof accountSub.fetch !== "function") return;
    const data = accountSub.dataAndSlot?.data;
    if (!data) {
      if (debug) log(`[FIXUP] ensureSpotMarketReady: fetching ${label}`);
      await accountSub.fetch();
    }
  };

  try {
    if (isPollingSubscriber) {
      if (!(subscriber.spotMarket instanceof Map)) return false;
      if (
        !subscriber.spotMarket.has(spotMarketIndex) &&
        typeof subscriber.addSpotMarket === "function"
      ) {
        if (debug) log(`[FIXUP] ensureSpotMarketReady(polling): addSpotMarket(${spotMarketIndex})`);
        await subscriber.addSpotMarket(spotMarketIndex);
      }
      if (typeof subscriber.fetch === "function") {
        await subscriber.fetch();
      }
      const spotEntry = subscriber.spotMarket.get(spotMarketIndex) || null;
      const spotData = spotEntry?.data || null;
      const stateOk = Boolean(subscriber?.state?.data);
      return Boolean(stateOk && spotData);
    }

    const stateOk = Boolean(subscriber?.stateAccountSubscriber?.dataAndSlot?.data);
    const spotMap = subscriber.spotMarketAccountSubscribers;
    let spotSub =
      spotMap && typeof spotMap.get === "function" ? spotMap.get(spotMarketIndex) : null;
    if (!spotSub && typeof subscriber.addSpotMarket === "function") {
      if (debug) log(`[FIXUP] ensureSpotMarketReady: addSpotMarket(${spotMarketIndex})`);
      await subscriber.addSpotMarket(spotMarketIndex);
      spotSub = spotMap && typeof spotMap.get === "function" ? spotMap.get(spotMarketIndex) : null;
    }

    await fetchIfMissing(spotSub, `spotMarket(${spotMarketIndex})`);
    const spotData = spotSub?.dataAndSlot?.data || null;
    return Boolean(stateOk && spotData);
  } catch (err) {
    log(`[WARN] ensureSpotMarketReady failed for ${spotMarketIndex}: ${err.message}`);
    return false;
  }
}

async function collectRequiredMarketIndexesForPerpOrder({ subaccount, primaryPerpMarketIndex }) {
  const requiredPerp = new Set();
  const requiredSpot = new Set([0]); // Always include USDC spot market

  if (Number.isFinite(primaryPerpMarketIndex)) {
    requiredPerp.add(primaryPerpMarketIndex);
  }

  // Include DriftClient "must include" sets if present
  try {
    if (driftClient?.mustIncludePerpMarketIndexes instanceof Set) {
      for (const idx of driftClient.mustIncludePerpMarketIndexes.values()) {
        if (Number.isFinite(idx)) requiredPerp.add(idx);
      }
    }
    if (driftClient?.mustIncludeSpotMarketIndexes instanceof Set) {
      for (const idx of driftClient.mustIncludeSpotMarketIndexes.values()) {
        if (Number.isFinite(idx)) requiredSpot.add(idx);
      }
    }
  } catch {
    // ignore
  }

  // If we can't read user state, still return the primary market set (best effort).
  let user = null;
  try {
    user = await ensureUser(subaccount);
  } catch {
    user = null;
  }

  if (!user) {
    return {
      perpMarketIndexes: Array.from(requiredPerp),
      spotMarketIndexes: Array.from(requiredSpot),
      userReady: false,
      openOrdersCount: 0,
      activePerpPositionsCount: 0,
      activeSpotPositionsCount: 0,
    };
  }

  // Open orders can force Drift SDK to include extra markets in remaining accounts.
  let openOrders = [];
  try {
    openOrders = await fetchOpenOrders(subaccount);
  } catch (e) {
    log(`[WARN] collectRequiredMarketIndexesForPerpOrder: fetchOpenOrders failed: ${e.message}`);
  }
  for (const order of openOrders || []) {
    const idx = toNumberSafe(order?.marketIndex);
    if (!Number.isFinite(idx)) continue;
    const typeKey = getMarketTypeKey(order?.marketType);
    if (typeKey === "spot") {
      requiredSpot.add(idx);
    } else {
      // Default to PERP for unknown/legacy shapes
      requiredPerp.add(idx);
    }
  }

  // Active perp positions can also force additional markets.
  let perpPositions = [];
  try {
    perpPositions = await fetchPerpPositions(subaccount);
  } catch (e) {
    log(`[WARN] collectRequiredMarketIndexesForPerpOrder: fetchPerpPositions failed: ${e.message}`);
  }
  try {
    const { positionIsAvailable } = require("@drift-labs/sdk");
    for (const pos of perpPositions || []) {
      const idx = toNumberSafe(pos?.marketIndex);
      if (!Number.isFinite(idx)) continue;
      try {
        if (!positionIsAvailable(pos)) requiredPerp.add(idx);
      } catch {
        // Fallback if position shape differs: include non-zero base positions.
        const base = pos?.baseAssetAmount;
        if (toNumberSafe(base) !== 0) requiredPerp.add(idx);
      }
    }
  } catch {
    // ignore
  }

  // Spot positions can force additional spot markets (rare for this bot, but keep it correct).
  let activeSpotPositionsCount = 0;
  try {
    const userAccount = typeof user.getUserAccount === "function" ? user.getUserAccount() : null;
    const spotPositions = userAccount?.spotPositions || [];
    const { isSpotPositionAvailable } = require("@drift-labs/sdk");
    for (const spotPos of spotPositions) {
      const idx = toNumberSafe(spotPos?.marketIndex);
      if (!Number.isFinite(idx)) continue;
      if (!isSpotPositionAvailable(spotPos)) {
        requiredSpot.add(idx);
        activeSpotPositionsCount += 1;
      }
    }
  } catch {
    // ignore
  }

  return {
    perpMarketIndexes: Array.from(requiredPerp),
    spotMarketIndexes: Array.from(requiredSpot),
    userReady: true,
    openOrdersCount: Array.isArray(openOrders) ? openOrders.length : 0,
    activePerpPositionsCount: Array.isArray(perpPositions) ? perpPositions.length : 0,
    activeSpotPositionsCount,
  };
}

async function ensureUserContextReady(subaccount) {
  if (!driftClient) return false;

  const user = await ensureUser(subaccount);
  if (!user) return false;

  let userReady = false;
  try {
    const slot =
      typeof user.getUserAccountAndSlot === "function" ? user.getUserAccountAndSlot() : null;
    userReady = Boolean(slot?.data);
  } catch {
    userReady = false;
  }

  if (!userReady && typeof user.fetchAccounts === "function") {
    try {
      await user.fetchAccounts();
    } catch (err) {
      log(`[WARN] Failed to fetch user accounts for subaccount ${subaccount}: ${err.message}`);
    }
    try {
      const slot =
        typeof user.getUserAccountAndSlot === "function" ? user.getUserAccountAndSlot() : null;
      userReady = Boolean(slot?.data);
    } catch {
      userReady = false;
    }
  }

  let statsReady = true;
  try {
    const userStats =
      typeof driftClient.getUserStats === "function" ? driftClient.getUserStats() : null;
    if (userStats && typeof userStats.getAccountAndSlot === "function") {
      const slot = userStats.getAccountAndSlot();
      statsReady = Boolean(slot?.data);
      if (!statsReady && typeof userStats.fetchAccounts === "function") {
        try {
          await userStats.fetchAccounts();
        } catch (err) {
          log(`[WARN] Failed to fetch userStats for subaccount ${subaccount}: ${err.message}`);
        }
        try {
          statsReady = Boolean(userStats.getAccountAndSlot()?.data);
        } catch {
          statsReady = false;
        }
      }
    }
  } catch (err) {
    log(`[WARN] Failed to check userStats readiness: ${err.message}`);
    statsReady = false;
  }

  return userReady && statsReady;
}

async function ensureAccountContextReadyForPerpOrder(primaryPerpMarketIndex) {
  const subaccount = subaccountId;
  const userReady = await ensureUserContextReady(subaccount);
  if (!userReady) {
    const required = {
      perpMarketIndexes: Number.isFinite(primaryPerpMarketIndex) ? [primaryPerpMarketIndex] : [],
      spotMarketIndexes: [0],
      userReady: false,
      openOrdersCount: 0,
      activePerpPositionsCount: 0,
      activeSpotPositionsCount: 0,
    };
    return { ok: false, reason: `user data not ready for subaccount ${subaccount}`, required };
  }

  const required = await collectRequiredMarketIndexesForPerpOrder({
    subaccount,
    primaryPerpMarketIndex,
  });

  const failedPerp = [];
  const failedSpot = [];

  // Ensure all perp markets first (each will ensure its quote spot market internally).
  for (const idx of required.perpMarketIndexes) {
    if (!Number.isFinite(idx)) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await ensurePerpMarketReady(idx);
    if (!ok) failedPerp.push(idx);
  }

  // Ensure any additional spot markets (e.g., non-USDC deposits/borrows or spot orders).
  for (const idx of required.spotMarketIndexes) {
    if (!Number.isFinite(idx)) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await ensureSpotMarketReady(idx);
    if (!ok) failedSpot.push(idx);
  }

  if (failedPerp.length || failedSpot.length) {
    const reason = `market data not ready (perp=${failedPerp.join(",") || "ok"}, spot=${failedSpot.join(",") || "ok"})`;
    return { ok: false, reason, required };
  }

  return { ok: true, required };
}

function wrapConnectionForGpaThrottle(conn, endpoint) {
  if (!conn || typeof conn.getProgramAccounts !== "function") {
    return conn;
  }

  if (!gpaThrottleLogged) {
    gpaThrottleLogged = true;
    log(`[RPC] getProgramAccounts throttle enabled (minIntervalMs=${GPA_MIN_INTERVAL_MS})`);
  }

  const original = conn.getProgramAccounts.bind(conn);
  let lastGpaAt = 0;
  const queue = [];
  let processing = false;

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const { args, resolve, reject } = queue.shift();
        try {
          await awaitRpcBackoff("GPA", endpoint);
          const now = Date.now();
          const waitMs = lastGpaAt + GPA_MIN_INTERVAL_MS - now;
          if (waitMs > 0) {
            await sleep(waitMs);
          }
          lastGpaAt = Date.now();

          const result = await original(...args);
          rpcBackoffMs = 0;
          rpcBackoffUntil = 0;
          if (endpoint) {
            rateLimitedEndpoints.delete(endpoint);
          }
          resolve(result);
        } catch (err) {
          if (isRateLimitError(err)) {
            applyRpcBackoff(endpoint, "GPA");
          }
          reject(err);
        }
      }
    } finally {
      processing = false;
    }
  };

  conn.getProgramAccounts = (...args) => {
    const promise = new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject });
    });
    void processQueue();
    return promise;
  };

  return conn;
}

/**
 * Parse Drift error code from error message
 * @param {string} message - Error message
 * @returns {number|null} Drift error code or null
 */
function parseDriftErrorCode(message) {
  if (!message) return null;

  // Pattern: "AnchorError: X. Error Code: XXX" or "Error Code: XXX"
  const codeMatch = message.match(/Error Code[:\s]+(\d+)/i);
  if (codeMatch) return parseInt(codeMatch[1], 10);

  // Pattern: "Error number: XXX"
  const numMatch = message.match(/Error number[:\s]+(\d+)/i);
  if (numMatch) return parseInt(numMatch[1], 10);

  // Pattern: "custom program error: 0xXXXX" (hex)
  const hexMatch = message.match(/custom program error:\s*0x([0-9a-fA-F]+)/i);
  if (hexMatch) return parseInt(hexMatch[1], 16);

  return null;
}

/**
 * Parse Drift error name from message
 * @param {string} message - Error message
 * @returns {string|null} Error name or null
 */
function parseDriftErrorName(message) {
  if (!message) return null;

  // Common error names
  const errorNames = [
    "InsufficientCollateral",
    "PerpMarketNotFound",
    "PlacePostOnlyLimitFailure",
    "UserMaxOpenOrders",
    "UserHasNoPosition",
    "InvalidOraclePrice",
    "OracleTooStale",
    "OrderDoesNotExist",
    "OrderNotOpen",
    "MarketPaused",
    "MarketNotActive",
  ];

  for (const name of errorNames) {
    if (message.includes(name)) return name;
  }

  return null;
}

// Send response to parent with structured error info
function respond(id, success, data = null, error = null) {
  const msg = { type: "response", id, success, data };

  // Include structured error information for failures
  if (error) {
    const errorMessage = typeof error === "string" ? error : error.message || String(error);
    msg.error = errorMessage;

    // Add parsed error codes for better handling by parent
    const driftCode = parseDriftErrorCode(errorMessage);
    const driftErrorName = parseDriftErrorName(errorMessage);

    if (driftCode !== null || driftErrorName) {
      msg.errorInfo = {
        driftCode,
        driftErrorName,
        isRateLimit: isRateLimitError(errorMessage),
        isBlockhash: /blockhash not found|expired blockhash|Transaction expired/i.test(
          errorMessage
        ),
      };
    }
  }

  console.log(JSON.stringify(msg));
}

// Send event to parent (unsolicited)
function emit(event, data) {
  const msg = { type: "event", event, data };
  console.log(JSON.stringify(msg));
}

// Log to stderr (doesn't interfere with JSON protocol)
function log(...args) {
  console.error("[drift-subprocess]", ...args);
}

function resolveSubaccountId() {
  const rawId = process.env.DRIFT_SUBACCOUNT_ID;
  const rawLegacy = process.env.DRIFT_SUBACCOUNT;
  const parsedId = rawId !== undefined ? parseInt(rawId, 10) : NaN;
  const parsedLegacy = rawLegacy !== undefined ? parseInt(rawLegacy, 10) : NaN;

  if (
    !warnedSubaccountMismatch &&
    Number.isFinite(parsedId) &&
    Number.isFinite(parsedLegacy) &&
    parsedId !== parsedLegacy
  ) {
    warnedSubaccountMismatch = true;
    log(
      `DRIFT_SUBACCOUNT_ID (${parsedId}) != DRIFT_SUBACCOUNT (${parsedLegacy}); using DRIFT_SUBACCOUNT_ID`
    );
  }

  if (Number.isFinite(parsedId)) return parsedId;
  if (Number.isFinite(parsedLegacy)) return parsedLegacy;
  return 0;
}

async function fetchOpenOrders(subaccount, options = {}) {
  // Coalesce in-flight requests - reuse existing promise if one is pending
  const cacheKey = subaccount;
  const existingPromise = inFlightOpenOrdersPromises.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  // Create new promise and cache it
  const promise = (async () => {
    try {
      if (!driftClient) return [];
      const user = await ensureUser(subaccount);
      if (!user) {
        const err = new Error(`User not ready for subaccount ${subaccount}`);
        err.code = "USER_NOT_READY";
        throw err;
      }

      if (options.forceRefresh) {
        await maybeForceUserRefresh(user, subaccount, "getOpenOrders");
      }

      if (typeof user.getOpenOrders === "function") {
        return user.getOpenOrders();
      }
      if (typeof user.getOrders === "function") {
        return user
          .getOrders()
          .filter((o) => o.status === "open" || !o.baseAssetAmountFilled?.eq(o.baseAssetAmount));
      }
      if (typeof user.getUserAccount === "function") {
        const userAccount = await user.getUserAccount();
        return (userAccount?.orders || []).filter(
          (o) => o.status?.open || o.baseAssetAmount?.gt(o.baseAssetAmountFilled || new BN(0))
        );
      }
      return [];
    } finally {
      // Clean up promise from cache when done (success or failure)
      inFlightOpenOrdersPromises.delete(cacheKey);
    }
  })();

  inFlightOpenOrdersPromises.set(cacheKey, promise);
  return promise;
}

function normalizeUserOrderId(order) {
  if (order.userOrderId !== undefined && order.userOrderId !== null) {
    return Number(order.userOrderId);
  }
  if (order.orderId !== undefined && orderIdToUserOrderId.has(order.orderId)) {
    return orderIdToUserOrderId.get(order.orderId);
  }
  return null;
}

function toNumberSafe(value) {
  try {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") return Number(value);
    if (typeof value.toNumber === "function") return value.toNumber();
  } catch (err) {
    return 0;
  }
  return 0;
}

async function fetchPerpPositions(subaccount, options = {}) {
  // Coalesce in-flight requests - reuse existing promise if one is pending
  const cacheKey = subaccount;
  const existingPromise = inFlightPositionsPromises.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  // Create new promise and cache it
  const promise = (async () => {
    try {
      if (!driftClient) return [];
      const user = await ensureUser(subaccount);
      if (!user) {
        const err = new Error(`User not ready for subaccount ${subaccount}`);
        err.code = "USER_NOT_READY";
        throw err;
      }

      // Only force RPC refreshes in polling mode. In websocket mode the SDK keeps user state updated
      // continuously; forcing fetchAccounts() here adds unnecessary RPC load and can trigger rate limits.
      const subscriber = driftClient?.accountSubscriber;
      const isPollingSubscriber =
        subscriber && subscriber.perpMarket instanceof Map && subscriber.spotMarket instanceof Map;
      if (isPollingSubscriber) {
        const refreshMs = Number(process.env.DRIFT_POSITIONS_REFRESH_MS || 60000);
        if (Number.isFinite(refreshMs) && refreshMs > 0) {
          const now = Date.now();
          if (options.forceRefresh) {
            await maybeForceUserRefresh(user, subaccount, "getPositions");
          } else if (now - lastPositionsRefreshAt >= refreshMs) {
            try {
              await user.fetchAccounts();
              lastPositionsRefreshAt = now;
            } catch (err) {
              log(`[WARN] Failed to refresh user accounts before getPositions: ${err.message}`);
            }
          }
        }
      } else if (options.forceRefresh) {
        // In websocket mode the SDK is typically up-to-date, but on some deployments updates can lag.
        // Only force refresh when explicitly requested (e.g., order lifecycle confirmation).
        await maybeForceUserRefresh(user, subaccount, "getPositions(ws)");
      }

      if (typeof user.getPerpPositions === "function") {
        return user.getPerpPositions();
      }
      if (typeof user.getActivePerpPositions === "function") {
        return user.getActivePerpPositions();
      }
      if (user.perpPositions) {
        return user.perpPositions;
      }
      if (typeof user.getUserAccount === "function") {
        const userAccount = await user.getUserAccount();
        return userAccount?.perpPositions || [];
      }
      return [];
    } finally {
      // Clean up promise from cache when done (success or failure)
      inFlightPositionsPromises.delete(cacheKey);
    }
  })();

  inFlightPositionsPromises.set(cacheKey, promise);
  return promise;
}

async function ensureUser(subaccount) {
  if (!driftClient) return null;
  const tryGetUser = () => {
    try {
      if (!driftClient) return null;
      if (typeof driftClient.hasUser === "function" && !driftClient.hasUser(subaccount)) {
        return null;
      }
      if (typeof driftClient.getUser !== "function") return null;
      return driftClient.getUser(subaccount);
    } catch {
      return null;
    }
  };

  let user = tryGetUser();
  if (user) return user;

  // Cap resubscribe attempts per subaccount in a rolling window to prevent runaway loops.
  const now = Date.now();
  const attemptInfo = resubscribeAttempts.get(subaccount) || { count: 0, windowStart: now };
  if (now - attemptInfo.windowStart > RESUBSCRIBE_WINDOW_MS) {
    attemptInfo.count = 0;
    attemptInfo.windowStart = now;
  }
  if (attemptInfo.count >= RESUBSCRIBE_MAX_ATTEMPTS) {
    log(
      `[WARN] Resubscribe cap reached for subaccount ${subaccount} ` +
        `(${attemptInfo.count}/${RESUBSCRIBE_MAX_ATTEMPTS} in ${Math.round(RESUBSCRIBE_WINDOW_MS / 1000)}s) - skipping resubscribe.`
    );
    return null;
  }
  const nowTs = Date.now();
  if (resubscribeInProgress || nowTs - lastResubscribeAt < RESUBSCRIBE_COOLDOWN_MS) {
    return null;
  }
  resubscribeInProgress = true;
  lastResubscribeAt = nowTs;
  try {
    log(`[WARN] User not found for subaccount ${subaccount}. Re-subscribing...`);
    const ok = await driftClient.addUser(subaccount);
    if (!ok) {
      log(`[WARN] addUser returned false for subaccount ${subaccount}`);
    }
    attemptInfo.count += 1;
    resubscribeAttempts.set(subaccount, attemptInfo);
  } catch (err) {
    log(`[WARN] Failed to re-subscribe user ${subaccount}: ${err.message}`);
  } finally {
    resubscribeInProgress = false;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    user = tryGetUser();
    if (user) return user;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function touchOrderIdMapping(orderId, userOrderId) {
  if (orderId === undefined || userOrderId === null) return;
  orderIdToUserOrderId.set(orderId, userOrderId);
  userOrderIdToOrderId.set(userOrderId, orderId);
  orderIdLastSeen.set(orderId, Date.now());
}

function pruneOrderIdCache() {
  const now = Date.now();
  for (const [orderId, lastSeen] of orderIdLastSeen) {
    if (now - lastSeen > ORDER_ID_CACHE_TTL_MS) {
      const userOrderId = orderIdToUserOrderId.get(orderId);
      orderIdLastSeen.delete(orderId);
      orderIdToUserOrderId.delete(orderId);
      if (userOrderId !== undefined) {
        userOrderIdToOrderId.delete(userOrderId);
      }
    }
  }

  if (orderIdLastSeen.size <= ORDER_ID_CACHE_MAX) return;
  const entries = Array.from(orderIdLastSeen.entries()).sort((a, b) => a[1] - b[1]);
  const overflow = entries.length - ORDER_ID_CACHE_MAX;
  for (let i = 0; i < overflow; i += 1) {
    const [orderId] = entries[i];
    const userOrderId = orderIdToUserOrderId.get(orderId);
    orderIdLastSeen.delete(orderId);
    orderIdToUserOrderId.delete(orderId);
    if (userOrderId !== undefined) {
      userOrderIdToOrderId.delete(userOrderId);
    }
  }
}

function normalizeRpcList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function maskRpcUrl(url) {
  if (!url) return "";
  return String(url)
    .replace(/(api-key=)[^&]+/gi, "$1***")
    .replace(/(token=)[^&]+/gi, "$1***")
    .replace(/(key=)[^&]+/gi, "$1***")
    .replace(/(\/api-key\/)[^/]+/gi, "$1***")
    .replace(/\/\/.*?@/, "//***@");
}

function isRateLimitError(err) {
  const msg = err?.message ? String(err.message) : String(err);
  return /429|402|max usage reached|Too Many Requests|Payment Required|rate limit/i.test(msg);
}

function isDefaultPublicRpc(url) {
  const raw = String(url || "").toLowerCase();
  return raw.includes("api.mainnet-beta.solana.com") || raw.includes("api.devnet.solana.com");
}

function applyRpcBackoff(endpoint, label) {
  const now = Date.now();
  rpcBackoffMs = rpcBackoffMs
    ? Math.min(rpcBackoffMs * 2, RPC_BACKOFF_MAX_MS)
    : RPC_BACKOFF_BASE_MS;
  rpcBackoffUntil = now + rpcBackoffMs;
  if (endpoint) {
    rateLimitedEndpoints.set(endpoint, now + rpcBackoffMs);
  }
  const masked = endpoint ? maskRpcUrl(endpoint) : "";
  log(`[${label}] Rate limited${masked ? ` (${masked})` : ""}, backing off for ${rpcBackoffMs}ms`);
}

async function awaitRpcBackoff(label, endpoint) {
  const now = Date.now();
  let waitMs = 0;
  if (endpoint) {
    const endpointBackoffUntil = rateLimitedEndpoints.get(endpoint) || 0;
    if (endpointBackoffUntil > now) {
      waitMs = Math.max(waitMs, endpointBackoffUntil - now);
    }
  }
  if (rpcBackoffUntil > now) {
    waitMs = Math.max(waitMs, rpcBackoffUntil - now);
  }
  if (waitMs > 0) {
    log(`[${label}] RPC backoff active, waiting ${waitMs}ms`);
    await sleep(Math.min(waitMs, 5000));
  }
}

function normalizeRpcEndpoint(rpcUrl) {
  const raw = String(rpcUrl || "").trim();
  let httpUrl = raw;
  let wsEndpoint = null;
  if (raw.startsWith("wss://")) {
    wsEndpoint = raw;
    httpUrl = `https://${raw.slice("wss://".length)}`;
  } else if (raw.startsWith("ws://")) {
    wsEndpoint = raw;
    httpUrl = `http://${raw.slice("ws://".length)}`;
  }
  return { httpUrl, wsEndpoint };
}

function normalizeWsEndpoint(value) {
  if (!value) return null;
  let ws = String(value).trim();
  if (!ws) return null;

  if (ws.startsWith("https://")) {
    ws = `wss://${ws.slice("https://".length)}`;
  } else if (ws.startsWith("http://")) {
    ws = `ws://${ws.slice("http://".length)}`;
  }

  return ws;
}

function createConnectionForRpc(rpcUrl, { wsEndpointOverride } = {}) {
  const options = { commitment: "confirmed" };
  const { httpUrl, wsEndpoint } = normalizeRpcEndpoint(rpcUrl);
  const explicitWs =
    normalizeWsEndpoint(process.env.DRIFT_RPC_WS_URL) ||
    normalizeWsEndpoint(process.env.RPC_SYNDICA_WS_URL) ||
    normalizeWsEndpoint(process.env.RPC_HELIUS_WS_URL);
  const fallbackWs = normalizeWsEndpoint(process.env.RPC_WS_URL);
  const normalizedWsEndpoint = normalizeWsEndpoint(wsEndpoint);
  const derivedSyndicaWs =
    httpUrl && String(httpUrl).includes("syndica.io") ? normalizeWsEndpoint(httpUrl) : null;
  const normalizedOverrideWs = normalizeWsEndpoint(wsEndpointOverride);

  const safeHost = (value) => {
    try {
      if (!value) return null;
      return new URL(String(value)).host;
    } catch {
      return null;
    }
  };
  const httpHost = safeHost(httpUrl);
  const fallbackHost = safeHost(fallbackWs);

  const normalizedEnvWs =
    explicitWs ||
    (fallbackWs && fallbackHost && httpHost && fallbackHost === httpHost ? fallbackWs : null);
  if (normalizedOverrideWs) {
    options.wsEndpoint = normalizedOverrideWs;
  } else if (normalizedEnvWs || normalizedWsEndpoint) {
    options.wsEndpoint = normalizedEnvWs || normalizedWsEndpoint;
  } else if (derivedSyndicaWs) {
    // Derive a WS endpoint from the HTTP URL (e.g. Syndica). We probe WS health during init and can
    // fall back to alternate endpoints if this one doesn't emit subscriptions correctly.
    options.wsEndpoint = derivedSyndicaWs;
  }
  const tatumUrl = process.env.RPC_TATUM_URL;
  const tatumKey = process.env.RPC_TATUM_API_KEY;
  if (tatumKey && tatumUrl && String(httpUrl).includes(tatumUrl)) {
    options.httpHeaders = { "x-api-key": tatumKey };
  }
  const conn = new Connection(httpUrl, options);
  conn.__codexHttpEndpoint = httpUrl;
  conn.__codexWsEndpoint = options.wsEndpoint || conn._rpcWsEndpoint || null;
  return wrapConnectionForGpaThrottle(conn, httpUrl);
}

function buildRpcCandidates(params, env) {
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const v of value) add(v);
      return;
    }
    const trimmed = String(value).trim();
    if (trimmed) candidates.push(trimmed);
  };

  const { rpcUrl, rpcUrls } = params || {};
  add(rpcUrl);
  add(normalizeRpcList(rpcUrls));
  add(normalizeRpcList(process.env.DRIFT_RPC_URLS));
  add(process.env.DRIFT_RPC_URL);
  add(process.env.RPC_HELIUS_URL);
  add(process.env.RPC_QUICKNODE_URL);
  add(process.env.RPC_TRITON_URL);
  add(process.env.RPC_TATUM_URL);
  add(process.env.RPC_FALLBACK_URL);
  add(process.env.RPC_URL);
  add(process.env.SOLANA_RPC_URL);

  let unique = Array.from(new Set(candidates));
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

  const allowPublicFallback = process.env.DRIFT_ALLOW_PUBLIC_RPC_FALLBACK !== "false";
  const publicCandidates = unique.filter(isDefaultPublicRpc);
  const paidCandidates = unique.filter((url) => !isDefaultPublicRpc(url));
  if (paidCandidates.length) {
    unique = paidCandidates;
    if (allowPublicFallback) {
      const fallbackPublic =
        publicCandidates[0] ||
        (env === "devnet"
          ? "https://api.devnet.solana.com"
          : "https://api.mainnet-beta.solana.com");
      if (fallbackPublic && !unique.includes(fallbackPublic)) {
        unique.push(fallbackPublic);
      }
    }
  }

  if (unique.length > 0) return unique;
  return [
    env === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com",
  ];
}

async function waitForWebsocketAccountsReady({ subscriber, perpMarketIndexes, timeoutMs }) {
  const start = Date.now();
  const pollMs = 250;
  const requiredPerps = Array.isArray(perpMarketIndexes)
    ? perpMarketIndexes.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  while (Date.now() - start < timeoutMs) {
    const stateOk = Boolean(subscriber?.stateAccountSubscriber?.dataAndSlot?.data);
    const spotSubs = subscriber?.spotMarketAccountSubscribers;
    const quoteSpotOk = Boolean(spotSubs?.get?.(0)?.dataAndSlot?.data);
    const perpSubs = subscriber?.perpMarketAccountSubscribers;
    if (!perpSubs || typeof perpSubs.get !== "function") {
      await sleep(pollMs);
      continue;
    }
    let readyPerps = 0;
    for (const marketIndex of requiredPerps) {
      const entry = perpSubs.get(marketIndex);
      if (entry?.dataAndSlot?.data) readyPerps += 1;
    }

    // Require:
    // - State account data present
    // - Quote spot market (USDC) present
    // - All requested perp markets have delivered data (prevents later dataAndSlot errors)
    if (
      stateOk &&
      quoteSpotOk &&
      (requiredPerps.length === 0 || readyPerps === requiredPerps.length)
    ) {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

async function probeWebsocketSlotStream({ connection, timeoutMs }) {
  if (!connection || typeof connection.onSlotChange !== "function") {
    return { ok: false, reason: "no_connection", durationMs: 0 };
  }
  const start = Date.now();
  return await new Promise((resolve) => {
    let resolved = false;
    let subId = null;
    const finish = async (result) => {
      if (resolved) return;
      resolved = true;
      if (subId !== null) {
        try {
          await connection.removeSlotChangeListener(subId);
        } catch {
          // ignore
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      void finish({ ok: false, reason: "timeout", durationMs: Date.now() - start, subId });
    }, timeoutMs);

    try {
      subId = connection.onSlotChange((slotInfo) => {
        clearTimeout(timer);
        void finish({
          ok: true,
          reason: "slot",
          durationMs: Date.now() - start,
          subId,
          slot: slotInfo?.slot,
          parent: slotInfo?.parent,
          root: slotInfo?.root,
        });
      });
    } catch (err) {
      clearTimeout(timer);
      void finish({
        ok: false,
        reason: "exception",
        durationMs: Date.now() - start,
        error: err?.message ? String(err.message) : String(err),
      });
    }
  });
}

async function probeWebsocketAccountStream({
  connection,
  timeoutMs,
  publicKey,
  commitment = "confirmed",
}) {
  if (!connection || typeof connection.onAccountChange !== "function") {
    return { ok: false, reason: "no_connection", durationMs: 0 };
  }
  if (!publicKey) {
    return { ok: false, reason: "no_pubkey", durationMs: 0 };
  }

  const start = Date.now();
  return await new Promise((resolve) => {
    let resolved = false;
    let subId = null;
    const finish = async (result) => {
      if (resolved) return;
      resolved = true;
      if (subId !== null) {
        try {
          await connection.removeAccountChangeListener(subId);
        } catch {
          // ignore
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      void finish({ ok: false, reason: "timeout", durationMs: Date.now() - start, subId });
    }, timeoutMs);

    try {
      subId = connection.onAccountChange(
        publicKey,
        (_accountInfo, context) => {
          clearTimeout(timer);
          void finish({
            ok: true,
            reason: "account",
            durationMs: Date.now() - start,
            subId,
            slot: context?.slot,
          });
        },
        commitment
      );
    } catch (err) {
      clearTimeout(timer);
      void finish({
        ok: false,
        reason: "exception",
        durationMs: Date.now() - start,
        error: err?.message ? String(err.message) : String(err),
      });
    }
  });
}

async function closeConnectionWebsocket(conn) {
  const ws = conn?._rpcWebSocket;
  if (ws && typeof ws.close === "function") {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}

// Action handlers
const handlers = {
  // Health check with memory stats
  ping: async (params, id) => {
    const memUsage = process.memoryUsage();
    const memStats = {
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
      externalMB: Math.round(memUsage.external / 1024 / 1024),
    };

    // Warn if memory usage is high (Render free tier has ~512MB limit)
    const MEMORY_WARNING_THRESHOLD_MB = 400; // Warn at 400MB
    if (memStats.rssMB > MEMORY_WARNING_THRESHOLD_MB) {
      log(
        `[WARN] High memory usage: ${memStats.rssMB}MB RSS (heap: ${memStats.heapUsedMB}MB / ${memStats.heapTotalMB}MB)`
      );

      // Force garbage collection if available
      if (global.gc) {
        try {
          global.gc();
          const afterGC = process.memoryUsage();
          log(`[GC] After GC: ${Math.round(afterGC.rss / 1024 / 1024)}MB RSS`);
        } catch (gcErr) {
          log(`[WARN] GC failed: ${gcErr.message}`);
        }
      }
    }

    respond(id, true, {
      pong: true,
      sdkLoaded,
      sdkError,
      nodeVersion: process.version,
      isInitialized,
      walletPubkey,
      pid: process.pid,
      memory: memStats,
      uptimeSeconds: Math.round(process.uptime()),
    });
  },

  // Check SDK status
  getSdkStatus: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, `SDK failed to load: ${sdkError}`);
      return;
    }

    respond(id, true, {
      loaded: true,
      exports: Object.keys(require("@drift-labs/sdk")).slice(0, 20),
      hasDriftClient: typeof DriftClient === "function",
      hasPerpMarkets: !!PerpMarkets,
      isInitialized,
      walletPubkey,
    });
  },

  // Initialize Drift client with local wallet (secure - no IPC key transfer)
  // Reads wallet from WALLET_PRIVATE_KEY_PATH or WALLET_PRIVATE_KEY env var
  init: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, `SDK failed to load: ${sdkError}`);
      return;
    }

    const {
      env = process.env.DRIFT_CLUSTER || "mainnet-beta",
      subaccount = resolveSubaccountId(),
    } = params;

    cluster = env;
    subaccountId = subaccount;

    try {
      // 1. Load wallet locally (NEVER from IPC)
      if (!secureWalletLoader) {
        respond(id, false, null, "Secure wallet loader not available. Cannot initialize.");
        return;
      }

      const walletResult = secureWalletLoader.loadWallet({
        allowGenerate: false,
        quiet: true,
      });
      walletKeypair = walletResult.keypair;
      walletPubkey = walletResult.pubkey;

      log(`Wallet loaded: ${walletPubkey} (source: ${walletResult.source})`);

      const candidates = buildRpcCandidates(params, env);
      const perpMarketIndexes = Array.isArray(params?.perpMarketIndexes)
        ? params.perpMarketIndexes
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value))
        : null;
      const hasExplicitPerpMarkets =
        Array.isArray(perpMarketIndexes) && perpMarketIndexes.length > 0;
      const spotMarketIndexes = Array.isArray(params?.spotMarketIndexes)
        ? params.spotMarketIndexes
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value))
        : hasExplicitPerpMarkets
          ? [0]
          : null;
      if (
        hasExplicitPerpMarkets &&
        Array.isArray(spotMarketIndexes) &&
        !spotMarketIndexes.includes(0)
      ) {
        spotMarketIndexes.unshift(0);
      }
      const maxInitAttempts = Number(process.env.DRIFT_INIT_RPC_ATTEMPTS) || 3;

      // 3. Initialize SDK for environment (once)
      initialize({ env });
      const driftProgramId = toPublicKey(DRIFT_PROGRAM_ID);
      if (!driftProgramId) {
        respond(
          id,
          false,
          null,
          `Init failed: invalid DRIFT_PROGRAM_ID (${publicKeyToString(DRIFT_PROGRAM_ID)})`
        );
        return;
      }

      let lastErr = null;
      for (const rpc of candidates) {
        for (let attempt = 1; attempt <= maxInitAttempts; attempt += 1) {
          try {
            await awaitRpcBackoff("INIT", rpc);

            // Reset any previous client before retry
            if (driftClient) {
              try {
                await driftClient.unsubscribe();
              } catch (e) {
                /* ignore */
              }
            }
            if (bulkAccountLoader) {
              try {
                bulkAccountLoader.stopPolling();
              } catch (e) {
                /* ignore */
              }
              resetPollingState();
            }
            driftClient = null;
            bulkAccountLoader = null;
            connection = null;

            // 2. Create connection
            connection = createConnectionForRpc(rpc);

            // 4. Create DriftClient with websocket subscription (avoids batch RPC requirements)
            const wallet = new Wallet(walletKeypair);
            const requestedModeRaw = String(process.env.DRIFT_ACCOUNT_SUBSCRIPTION_MODE || "")
              .trim()
              .toLowerCase();
            const subscriptionMode = requestedModeRaw || "websocket";
            let wsStreamProbe = null;
            let wsAccountProbe = null;
            let wsFallbackAttempted = false;
            let wsFallbackUsed = false;
            if (subscriptionMode !== "polling") {
              const wsProbeTimeoutMs = clampNumber(process.env.DRIFT_WS_STREAM_TEST_TIMEOUT_MS, {
                min: 500,
                max: 30000,
                fallback: 5000,
              });
              const wsAccountProbeTimeoutMs = clampNumber(
                process.env.DRIFT_WS_ACCOUNT_TEST_TIMEOUT_MS,
                {
                  min: 500,
                  max: 30000,
                  fallback: 5000,
                }
              );
              const { getDriftStateAccountPublicKey } = require("@drift-labs/sdk");
              const statePk = await getDriftStateAccountPublicKey(driftProgramId);
              // Some RPC providers won't emit a drift state account notification quickly (it may not change
              // frequently). Use Sysvar Clock for the account WS probe because it updates every slot.
              const probePk = SYSVAR_CLOCK_PUBKEY || statePk;

              const runWsProbes = async () => {
                const slotProbe = await probeWebsocketSlotStream({
                  connection,
                  timeoutMs: wsProbeTimeoutMs,
                });
                const accountProbe = await probeWebsocketAccountStream({
                  connection,
                  timeoutMs: wsAccountProbeTimeoutMs,
                  publicKey: probePk,
                  commitment: "confirmed",
                });
                return { slotProbe, accountProbe };
              };

              ({ slotProbe: wsStreamProbe, accountProbe: wsAccountProbe } = await runWsProbes());

              const wsOk = Boolean(wsStreamProbe?.ok) && Boolean(wsAccountProbe?.ok);
              if (!wsOk) {
                const fallbackWs =
                  normalizeWsEndpoint(process.env.DRIFT_RPC_WS_FALLBACK_URL) ||
                  normalizeWsEndpoint(process.env.RPC_WS_FALLBACK_URL) ||
                  normalizeWsEndpoint(
                    env === "devnet"
                      ? "https://api.devnet.solana.com"
                      : "https://api.mainnet-beta.solana.com"
                  );
                const currentWs = normalizeWsEndpoint(
                  connection?.__codexWsEndpoint || connection?._rpcWsEndpoint || null
                );

                const wsCandidates = [];
                const addCandidate = (value) => {
                  const normalized = normalizeWsEndpoint(value);
                  if (!normalized) return;
                  if (!wsCandidates.includes(normalized)) wsCandidates.push(normalized);
                };
                const addSyndicaVariants = (ws) => {
                  if (!ws || !/syndica\\.io/i.test(ws)) return;
                  try {
                    const url = new URL(ws);
                    const stripWebsocketSuffix = (pathname) => {
                      const raw = String(pathname || "");
                      const lower = raw.toLowerCase();
                      if (lower.endsWith("/websocket/")) {
                        return raw.slice(0, -"/websocket/".length) || "/";
                      }
                      if (lower.endsWith("/websocket")) {
                        return raw.slice(0, -"/websocket".length) || "/";
                      }
                      return raw;
                    };
                    const hasWebsocketSuffix = (pathname) => {
                      const lower = String(pathname || "").toLowerCase();
                      return lower.endsWith("/websocket") || lower.endsWith("/websocket/");
                    };
                    const trimTrailingSlashes = (pathname) =>
                      String(pathname || "").replace(/\/+$/, "");
                    const stripSuffix = () => {
                      const stripped = new URL(url.toString());
                      stripped.pathname = stripWebsocketSuffix(stripped.pathname);
                      if (!stripped.pathname) stripped.pathname = "/";
                      return stripped.toString();
                    };
                    const addSuffix = () => {
                      const suffixed = new URL(url.toString());
                      if (!hasWebsocketSuffix(suffixed.pathname)) {
                        suffixed.pathname = `${trimTrailingSlashes(suffixed.pathname)}/websocket`;
                      }
                      return suffixed.toString();
                    };
                    const baseHost = () => {
                      const base = new URL(url.toString());
                      base.pathname = "/";
                      base.search = "";
                      base.hash = "";
                      return base.toString();
                    };
                    addCandidate(stripSuffix());
                    addCandidate(addSuffix());
                    addCandidate(baseHost());
                  } catch {
                    // Fallback string-based variants.
                    addCandidate(ws.replace(/\/websocket\/?$/i, "").replace(/\/+$/, ""));
                    addCandidate(
                      ws.replace(/\/+$/, "").replace(/\/websocket\/?$/i, "") + "/websocket"
                    );
                  }
                };

                // If the current WS is Syndica, probe both suffix/no-suffix variants before falling back.
                addSyndicaVariants(currentWs);
                addCandidate(process.env.DRIFT_RPC_WS_URL);
                addCandidate(process.env.RPC_SYNDICA_WS_URL);
                addCandidate(process.env.RPC_HELIUS_WS_URL);
                addCandidate(process.env.DRIFT_RPC_WS_FALLBACK_URL);
                addCandidate(process.env.RPC_WS_FALLBACK_URL);
                addCandidate(process.env.RPC_WS_URL);
                if (fallbackWs) addCandidate(fallbackWs);

                for (const candidateWs of wsCandidates) {
                  if (!candidateWs) continue;
                  if (currentWs && candidateWs === currentWs) continue;
                  wsFallbackAttempted = true;
                  log(
                    `[INIT] WS probe failed for ${maskRpcUrl(rpc)} (ws=${maskRpcUrl(currentWs)}), retrying with ws=${maskRpcUrl(candidateWs)}`
                  );
                  await closeConnectionWebsocket(connection);
                  connection = createConnectionForRpc(rpc, { wsEndpointOverride: candidateWs });
                  ({ slotProbe: wsStreamProbe, accountProbe: wsAccountProbe } =
                    await runWsProbes());
                  const ok = Boolean(wsStreamProbe?.ok) && Boolean(wsAccountProbe?.ok);
                  if (ok) {
                    wsFallbackUsed = true;
                    break;
                  }
                }
              }

              const finalWsOk = Boolean(wsStreamProbe?.ok) && Boolean(wsAccountProbe?.ok);
              if (!finalWsOk) {
                const slotReason = wsStreamProbe?.reason || "unknown";
                const acctReason = wsAccountProbe?.reason || "unknown";
                throw new Error(
                  `websocket probe failed (slot=${slotReason}, account=${acctReason}) after ` +
                    `${Math.max(wsStreamProbe?.durationMs || wsProbeTimeoutMs, wsAccountProbe?.durationMs || wsAccountProbeTimeoutMs)}ms`
                );
              }
            }
            const pollingFrequencyMs = clampNumber(process.env.DRIFT_POLLING_FREQUENCY_MS, {
              min: 250,
              max: 10000,
              fallback: 1000,
            });
            sdkBlockhashStaleCacheTimeMs = clampNumber(process.env.DRIFT_BLOCKHASH_CACHE_TTL_MS, {
              min: 250,
              max: 60000,
              fallback: 2000,
            });
            const sdkBlockhashRetryCount = clampNumber(process.env.DRIFT_BLOCKHASH_RETRY_COUNT, {
              min: 1,
              max: 10,
              fallback: 3,
            });
            const sdkBlockhashRetrySleepTimeMs = clampNumber(
              process.env.DRIFT_BLOCKHASH_RETRY_SLEEP_MS,
              {
                min: 0,
                max: 5000,
                fallback: 200,
              }
            );
            const driftClientConfig = {
              connection,
              wallet,
              programID: driftProgramId,
              env,
              accountSubscription: {
                type: subscriptionMode === "polling" ? "polling" : "websocket",
              },
              subAccountIds: [subaccount],
              activeSubAccountId: subaccount,
              // Ensure UserStats account is available; some SDK paths assume it exists.
              userStats: true,
              // CRITICAL: Avoid scanning all user accounts on-chain (Anchor getProgramAccounts).
              // We'll subscribe only to our configured subaccount via driftClient.addUser(subaccount)
              // after the accountSubscriber is ready.
              skipLoadUsers: true,
              txHandlerConfig: {
                blockhashCachingEnabled: true,
                blockhashCachingConfig: {
                  retryCount: sdkBlockhashRetryCount,
                  retrySleepTimeMs: sdkBlockhashRetrySleepTimeMs,
                  staleCacheTimeMs: sdkBlockhashStaleCacheTimeMs,
                },
              },
            };
            if (subscriptionMode === "polling") {
              const { BulkAccountLoader } = require("@drift-labs/sdk");
              bulkAccountLoader = new BulkAccountLoader(
                connection,
                "confirmed",
                pollingFrequencyMs
              );
              basePollingFrequencyMs = pollingFrequencyMs;
              currentPollingFrequencyMs = pollingFrequencyMs;
              driftClientConfig.accountSubscription = {
                type: "polling",
                accountLoader: bulkAccountLoader,
              };
              log(`[INIT] Drift account subscription: polling (freq=${pollingFrequencyMs}ms)`);
            } else {
              driftClientConfig.accountSubscription = {
                type: "websocket",
                ...(SafeWebSocketDriftClientAccountSubscriber
                  ? { driftClientAccountSubscriber: SafeWebSocketDriftClientAccountSubscriber }
                  : {}),
              };
              log("[INIT] Drift account subscription: websocket");
              if (wsStreamProbe?.ok) {
                log(
                  `[INIT] WS stream probe ok in ${wsStreamProbe.durationMs}ms (slot=${wsStreamProbe.slot ?? "n/a"})`
                );
              }
              if (wsAccountProbe?.ok) {
                log(
                  `[INIT] WS account probe ok in ${wsAccountProbe.durationMs}ms (slot=${wsAccountProbe.slot ?? "n/a"})`
                );
              }
              if (wsFallbackAttempted && wsFallbackUsed) {
                log(
                  "[INIT] WS fallback endpoint selected (account subscriptions use fallback wsEndpoint)"
                );
              }
            }
            if (perpMarketIndexes && perpMarketIndexes.length > 0) {
              driftClientConfig.perpMarketIndexes = perpMarketIndexes;
            }
            if (spotMarketIndexes && spotMarketIndexes.length > 0) {
              driftClientConfig.spotMarketIndexes = Array.from(new Set(spotMarketIndexes)).sort(
                (a, b) => a - b
              );
            }
            if (hasExplicitPerpMarkets) {
              try {
                const oracleInfos = [];
                const seen = new Set();
                const addOracle = (oracle, source) => {
                  // NOTE: Drift's OracleSource enum uses 0 for PYTH, so we must not treat 0 as "missing".
                  if (isNil(oracle) || isNil(source)) return;
                  if (oracle.equals && oracle.equals(PublicKey.default)) return;
                  const key = `${oracle.toString()}:${JSON.stringify(source)}`;
                  if (seen.has(key)) return;
                  seen.add(key);
                  oracleInfos.push({ publicKey: oracle, source });
                };

                const perpRegistry = PerpMarkets[env] || PerpMarkets["mainnet-beta"] || [];
                const perpSet = new Set(perpMarketIndexes);
                for (const m of perpRegistry) {
                  if (!perpSet.has(m.marketIndex)) continue;
                  addOracle(m.oracle, m.oracleSource);
                }

                const spotRegistry = SpotMarkets[env] || SpotMarkets["mainnet-beta"] || [];
                const spotSet = new Set(spotMarketIndexes || []);
                for (const m of spotRegistry) {
                  if (!spotSet.has(m.marketIndex)) continue;
                  addOracle(m.oracle, m.oracleSource);
                }

                if (oracleInfos.length > 0) {
                  driftClientConfig.oracleInfos = oracleInfos;
                }
              } catch (e) {
                log(`[WARN] Failed to derive oracleInfos for init: ${e.message}`);
              }
            }
            driftClient = new DriftClient(driftClientConfig);

            // 6. Subscribe to account updates
            // DriftClient.subscribe() returns a boolean and can return false (without throwing) if
            // the underlying account subscriber didn't load required accounts yet.
            const subscribed = await driftClient.subscribe();
            if (!subscribed) {
              throw new Error("DriftClient.subscribe() returned false");
            }

            // In websocket mode, `subscribe()` may resolve before the first account payloads arrive.
            // If the provider's WS endpoint is wrong/down, we can end up "initialized" but missing
            // `dataAndSlot` forever (causing order placement failures later).
            if (subscriptionMode !== "polling") {
              const wsReadyTimeoutMs = clampNumber(process.env.DRIFT_WS_READY_TIMEOUT_MS, {
                min: 500,
                max: 30000,
                fallback: 8000,
              });
              const wsReady = await waitForWebsocketAccountsReady({
                subscriber: driftClient.accountSubscriber,
                perpMarketIndexes,
                timeoutMs: wsReadyTimeoutMs,
              });
              if (!wsReady) {
                throw new Error(`websocket subscription not ready after ${wsReadyTimeoutMs}ms`);
              }
            }
            if (bulkAccountLoader && subscriptionMode === "polling") {
              try {
                bulkAccountLoader.startPolling();
              } catch (e) {
                log(`[WARN] Failed to start BulkAccountLoader polling: ${e.message}`);
              }
            }

            // Subscribe to our configured subaccount explicitly (no getProgramAccounts).
            try {
              const ok = await driftClient.addUser(subaccount);
              if (!ok) {
                throw new Error("addUser returned false");
              }
            } catch (userErr) {
              throw new Error(`addUser(${subaccount}) during init failed: ${userErr.message}`);
            }

            // Warm the account subscriber once so the first live order doesn't race empty Maps in polling mode.
            // Keep this lightweight: one fetch + oracle-map derivation. Per-market readiness is handled
            // lazily at order time (and includes direct RPC fallbacks when polling batches are rate-limited).
            try {
              const subscriber = driftClient.accountSubscriber;
              if (
                subscriber &&
                subscriber.perpMarket instanceof Map &&
                Array.isArray(perpMarketIndexes) &&
                perpMarketIndexes.length > 0
              ) {
                if (typeof subscriber.fetch === "function") {
                  await subscriber.fetch();
                }
                try {
                  if (typeof subscriber.setPerpOracleMap === "function") {
                    await subscriber.setPerpOracleMap();
                  }
                  if (typeof subscriber.setSpotOracleMap === "function") {
                    await subscriber.setSpotOracleMap();
                  }
                } catch (mapErr) {
                  log(`[WARN] Account subscriber oracle-map warmup failed: ${mapErr.message}`);
                }
              }
            } catch (warmErr) {
              log(`[WARN] Account subscriber warmup failed: ${warmErr.message}`);
            }

            isInitialized = true;

            log(`DriftClient initialized: cluster=${env}, subaccount=${subaccount}`);

            let subscriptionHealth = null;
            try {
              const subscriber = driftClient?.accountSubscriber;
              if (
                subscriber?.perpMarketAccountSubscribers &&
                subscriber?.spotMarketAccountSubscribers
              ) {
                subscriptionHealth = {
                  type: "websocket",
                  accountSubscriberClass: subscriber?.constructor?.name || "unknown",
                  safeSubscriber:
                    Boolean(SafeWebSocketDriftClientAccountSubscriber) &&
                    subscriber instanceof SafeWebSocketDriftClientAccountSubscriber,
                  stateOk: Boolean(subscriber?.stateAccountSubscriber?.dataAndSlot?.data),
                  perpSubs: subscriber?.perpMarketAccountSubscribers?.size || 0,
                  spotSubs: subscriber?.spotMarketAccountSubscribers?.size || 0,
                  oracleSubs: subscriber?.oracleSubscribers?.size || 0,
                  wsStreamProbe,
                  wsAccountProbe,
                  wsFallbackAttempted,
                  wsFallbackUsed,
                };
              } else if (
                subscriber?.perpMarket instanceof Map &&
                subscriber?.spotMarket instanceof Map
              ) {
                subscriptionHealth = {
                  type: "polling",
                  accountSubscriberClass: subscriber?.constructor?.name || "unknown",
                  stateOk: Boolean(subscriber?.state?.data),
                  perpMarkets: subscriber?.perpMarket?.size || 0,
                  spotMarkets: subscriber?.spotMarket?.size || 0,
                  oracles: subscriber?.oracles?.size || 0,
                };
              }
            } catch (e) {
              // ignore
            }

            respond(id, true, {
              initialized: true,
              walletPubkey,
              cluster: env,
              subaccountId: subaccount,
              programId: driftProgramId.toBase58(),
              rpcUrl: maskRpcUrl(rpc),
              httpEndpoint: maskRpcUrl(
                connection?.__codexHttpEndpoint || connection?._rpcEndpoint || rpc
              ),
              wsEndpoint: maskRpcUrl(
                connection?.__codexWsEndpoint || connection?._rpcWsEndpoint || null
              ),
              accountSubscription:
                driftClientConfig?.accountSubscription?.type ||
                (subscriptionMode === "polling" ? "polling" : "websocket"),
              subscriptionHealth,
            });
            return;
          } catch (err) {
            lastErr = err;
            const rateLimited = isRateLimitError(err);
            log(
              `[WARN] Init failed for RPC ${maskRpcUrl(rpc)} (attempt ${attempt}/${maxInitAttempts}): ${err.message}`
            );
            if (connection) {
              await closeConnectionWebsocket(connection);
            }
            if (rateLimited) {
              applyRpcBackoff(rpc, "INIT");
              if (attempt < maxInitAttempts) {
                await sleep(Math.min(rpcBackoffMs, 5000));
                continue;
              }
            }
            break;
          }
        }
      }

      const errorMessage = lastErr ? lastErr.message : "Unknown init error";
      log(`Init error: ${errorMessage}`);
      // Ensure we don't leak subscriptions/resources on init failure.
      if (driftClient) {
        try {
          await driftClient.unsubscribe();
        } catch (cleanupErr) {
          log(`[WARN] Failed to unsubscribe driftClient after init failure: ${cleanupErr.message}`);
        }
      }
      if (connection) {
        await closeConnectionWebsocket(connection);
      }
      if (bulkAccountLoader) {
        try {
          bulkAccountLoader.stopPolling();
        } catch (e) {
          // ignore
        }
        resetPollingState();
      }
      driftClient = null;
      bulkAccountLoader = null;
      connection = null;
      isInitialized = false;
      respond(id, false, null, `Init failed: ${errorMessage}`);
    } catch (err) {
      log(`Init error: ${err.message}`);
      if (driftClient) {
        try {
          await driftClient.unsubscribe();
        } catch (cleanupErr) {
          log(
            `[WARN] Failed to unsubscribe driftClient after init exception: ${cleanupErr.message}`
          );
        }
      }
      if (connection) {
        await closeConnectionWebsocket(connection);
      }
      if (bulkAccountLoader) {
        try {
          bulkAccountLoader.stopPolling();
        } catch (e) {
          // ignore
        }
        resetPollingState();
      }
      driftClient = null;
      bulkAccountLoader = null;
      connection = null;
      isInitialized = false;
      respond(id, false, null, `Init failed: ${err.message}`);
    }
  },

  // Initialize connection only (no wallet, read-only)
  initConnection: async (params, id) => {
    const { rpcUrl, env = "devnet" } = params;
    try {
      connection = new Connection(rpcUrl || "https://api.devnet.solana.com", "confirmed");
      const version = await connection.getVersion();

      if (sdkLoaded) {
        initialize({ env });
        cluster = env;
      }

      respond(id, true, {
        connected: true,
        solanaVersion: version["solana-core"],
        env,
      });
    } catch (err) {
      respond(id, false, null, err.message);
    }
  },

  // Get perp markets from registry
  getPerpMarkets: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { env = "mainnet-beta" } = params;
    const markets = PerpMarkets[env] || PerpMarkets["mainnet-beta"] || [];

    const simplified = markets.map((m) => ({
      symbol: m.symbol || m.baseAssetSymbol,
      marketIndex: m.marketIndex,
      oracle: m.oracle?.toString(),
    }));

    respond(id, true, { markets: simplified, count: simplified.length });
  },

  // Get spot markets from registry
  getSpotMarkets: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { env = "mainnet-beta" } = params;
    const markets = SpotMarkets[env] || SpotMarkets["mainnet-beta"] || [];

    const simplified = markets.map((m) => ({
      symbol: m.symbol,
      marketIndex: m.marketIndex,
      mint: m.mint?.toString(),
    }));

    respond(id, true, { markets: simplified, count: simplified.length });
  },

  // Get market index mapping
  getMarketIndexMap: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { env = "mainnet-beta" } = params;
    const markets = PerpMarkets[env] || PerpMarkets["mainnet-beta"] || [];

    const indexMap = {};
    for (const m of markets) {
      const symbol = m.symbol || m.baseAssetSymbol;
      if (symbol && m.marketIndex !== undefined) {
        // Store both with and without -PERP suffix for flexible lookup
        indexMap[symbol] = m.marketIndex;
        if (symbol.endsWith("-PERP")) {
          indexMap[symbol.replace(/-PERP$/, "")] = m.marketIndex;
        } else {
          indexMap[`${symbol}-PERP`] = m.marketIndex;
        }
      }
    }

    respond(id, true, { indexMap });
  },

  // Validate market exists
  validateMarket: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { symbol, env = "mainnet-beta" } = params;
    const markets = PerpMarkets[env] || PerpMarkets["mainnet-beta"] || [];

    // Normalize: support both "SOL" and "SOL-PERP" input formats
    const inputUpper = symbol.toUpperCase();
    const withPerp = inputUpper.endsWith("-PERP") ? inputUpper : `${inputUpper}-PERP`;
    const withoutPerp = inputUpper.replace(/-PERP$/, "");

    const market = markets.find((m) => {
      const mSymbol = (m.symbol || m.baseAssetSymbol || "").toUpperCase();
      // Match against both formats
      return mSymbol === withPerp || mSymbol === withoutPerp || mSymbol === inputUpper;
    });

    if (market) {
      respond(id, true, {
        exists: true,
        marketIndex: market.marketIndex,
        symbol: market.symbol || market.baseAssetSymbol,
        oracle: market.oracle?.toString(),
      });
    } else {
      respond(id, true, { exists: false, tried: [withPerp, withoutPerp] });
    }
  },

  // Get ALL perp markets with full details for registry building
  getAllPerpMarketsDetailed: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { env = "mainnet-beta" } = params;
    const markets = PerpMarkets[env] || PerpMarkets["mainnet-beta"] || [];

    const detailed = markets.map((m) => {
      // Extract all useful fields
      const symbol = m.symbol || m.baseAssetSymbol || "UNKNOWN";
      return {
        symbol,
        marketIndex: m.marketIndex,
        baseAssetSymbol: m.baseAssetSymbol,
        oracle: m.oracle?.toString(),
        oracleSource: m.oracleSource,
        mint: m.mint?.toString(),
        // Normalize symbol for our bot (ensure -PERP suffix)
        normalizedSymbol: symbol.endsWith("-PERP") ? symbol : `${symbol}-PERP`,
        // Base symbol without -PERP for flexible lookup
        baseSymbol: symbol.replace(/-PERP$/, ""),
      };
    });

    // Sort by market index
    detailed.sort((a, b) => a.marketIndex - b.marketIndex);

    respond(id, true, {
      markets: detailed,
      count: detailed.length,
      env,
    });
  },

  // Get fee info (placeholder - actual fees need on-chain query)
  getFeeInfo: async (params, id) => {
    // Drift fee tiers based on documentation
    // https://docs.drift.trade/trading/trading-fees
    const feeTiers = {
      rookie: { taker: 10, maker: -2 }, // bps
      bronze: { taker: 8, maker: -2 },
      silver: { taker: 6, maker: -2 },
      gold: { taker: 4, maker: -3 },
      platinum: { taker: 3, maker: -3 },
      vip: { taker: 2, maker: -4 },
    };

    respond(id, true, { feeTiers, note: "Fees in basis points. Negative maker = rebate." });
  },

  // Query all perp markets on-chain (including markets not in static PerpMarkets array)
  queryAllPerpMarketsOnChain: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { env = "mainnet-beta" } = params;

    try {
      // If DriftClient is initialized, we can query from its state
      if (isInitialized && driftClient) {
        const state = driftClient.getStateAccount();
        if (!state) {
          respond(id, false, null, "State account not available");
          return;
        }

        const numMarkets = state.numberOfMarkets?.toNumber() || 0;
        const markets = [];

        // Query each market index from the client's subscribed accounts
        for (let i = 0; i < numMarkets; i++) {
          try {
            const marketAccount = driftClient.getPerpMarketAccount(i);
            if (marketAccount) {
              markets.push({
                marketIndex: i,
                symbol: marketAccount.name?.toString() || null,
                baseAssetSymbol: marketAccount.name?.toString()?.replace(/\s+/g, "") || null,
                oracle: marketAccount.amm?.oracle?.toString() || null,
                oracleSource: marketAccount.amm?.oracleSource || null,
              });
            }
          } catch (err) {
            // Market may not be subscribed, skip
            continue;
          }
        }

        respond(id, true, {
          markets,
          count: markets.length,
          env,
          source: "driftClient",
        });
        return;
      }

      // Fallback: Try to query via RPC using SDK's market account derivation
      if (connection) {
        try {
          const { getPerpMarketPublicKey } = require("@drift-labs/sdk");
          const driftProgramPubkey = toPublicKey(DRIFT_PROGRAM_ID);
          if (!driftProgramPubkey) {
            throw new Error("Invalid DRIFT_PROGRAM_ID");
          }
          const markets = [];

          // Query specific market index if provided, otherwise try 0-100
          const marketIndices =
            params.marketIndex !== undefined
              ? [Number(params.marketIndex)]
              : Array.from({ length: 101 }, (_, i) => i);

          for (const i of marketIndices) {
            try {
              const marketPubkey = getPerpMarketPublicKey(driftProgramPubkey, i);
              const accountInfo = await connection.getAccountInfo(marketPubkey, "confirmed");

              if (accountInfo && accountInfo.data) {
                // Try to decode the market account using SDK
                try {
                  const { PerpMarketAccount } = require("@drift-labs/sdk");
                  const marketAccount = PerpMarketAccount.decode(accountInfo.data);
                  markets.push({
                    marketIndex: i,
                    accountExists: true,
                    accountPubkey: marketPubkey.toString(),
                    oracle: marketAccount.amm?.oracle?.toString() || null,
                    oracleSource: marketAccount.amm?.oracleSource || null,
                    name: marketAccount.name?.toString() || null,
                  });
                } catch (decodeErr) {
                  // Decoding failed, but account exists
                  markets.push({
                    marketIndex: i,
                    accountExists: true,
                    accountPubkey: marketPubkey.toString(),
                    note: "Account exists but decoding failed",
                  });
                }
              }
            } catch (err) {
              // Market doesn't exist at this index, continue
              continue;
            }
          }

          if (markets.length > 0) {
            respond(id, true, {
              markets,
              count: markets.length,
              env,
              source: "rpc",
              note: "Queried via RPC. Oracle addresses require account data decoding.",
            });
            return;
          }
        } catch (rpcErr) {
          // RPC query failed, fall through to static array
        }
      }

      // Final fallback: Use static PerpMarkets array
      const markets = PerpMarkets[env] || PerpMarkets["mainnet-beta"] || [];
      const detailed = markets.map((m) => ({
        marketIndex: m.marketIndex,
        symbol: m.symbol || m.baseAssetSymbol || "UNKNOWN",
        baseAssetSymbol: m.baseAssetSymbol,
        oracle: m.oracle?.toString(),
        oracleSource: m.oracleSource,
      }));

      respond(id, true, {
        markets: detailed,
        count: detailed.length,
        env,
        source: "static",
        note: "DriftClient not initialized and RPC query unavailable. Returning static PerpMarkets array.",
      });
    } catch (err) {
      respond(id, false, null, `Query failed: ${err.message}`);
    }
  },

  // ===== TRADING COMMANDS =====
  // These use real DriftClient when initialized, otherwise return simulated responses

  // Get oracle price for a market
  getOraclePrice: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { marketIndex } = params;

    if (marketIndex === undefined) {
      respond(id, false, null, "Missing required param: marketIndex");
      return;
    }

    // Use real DriftClient if initialized
    if (isInitialized && driftClient) {
      try {
        const oraclePriceData = driftClient.getOracleDataForPerpMarket(marketIndex);

        if (!oraclePriceData || !oraclePriceData.price) {
          respond(id, true, {
            price: null,
            marketIndex,
            note: "Oracle price not available",
            stale: true,
          });
          return;
        }

        // Convert BN price to number (Drift uses 6 decimal precision)
        const priceNum = oraclePriceData.price.toNumber() / 1e6;

        // NOTE: We intentionally do not compute slot-based staleness here.
        // Slot lookups call `getSlot`, which can spam RPC and trigger rate limits.
        // Use Pyth WS staleness checks in the main process instead.
        let oracleSlot = 0;
        try {
          if (oraclePriceData.slot) {
            oracleSlot =
              typeof oraclePriceData.slot === "number"
                ? oraclePriceData.slot
                : oraclePriceData.slot.toNumber();
          }
        } catch (slotErr) {
          // Non-fatal: slot is for diagnostics only
        }

        respond(id, true, {
          price: priceNum,
          marketIndex,
          slot: oracleSlot,
          currentSlot: null,
          slotDelay: null,
          timeDelaySeconds: null,
          stale: null,
          confidence: oraclePriceData.confidence?.toNumber() / 1e6,
          live: true,
        });
      } catch (err) {
        log(`getOraclePrice error for market ${marketIndex}: ${err.message}`);
        respond(id, false, null, `Oracle query failed: ${err.message}`);
      }
      return;
    }

    // Fallback: not initialized
    respond(id, true, {
      price: null,
      note: "DriftClient not initialized. Call init first.",
      marketIndex,
      live: false,
    });
  },

  // Place market order (taker)
  placeMarketOrder: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const {
      marketIndex: rawMarketIndex,
      side,
      baseAssetAmount: rawBaseAssetAmount,
      reduceOnly = false,
      simulate = false,
      userOrderId: rawUserOrderId = 0,
    } = params;

    const marketIndex = Number(rawMarketIndex);
    const baseAssetAmount = Number(rawBaseAssetAmount);
    const userOrderId = Number(rawUserOrderId) || 0;

    // Validate params
    if (!Number.isFinite(marketIndex)) {
      respond(id, false, null, "Missing or invalid param: marketIndex");
      return;
    }
    if (!side) {
      respond(id, false, null, "Missing required param: side");
      return;
    }
    if (!Number.isFinite(baseAssetAmount) || baseAssetAmount <= 0) {
      respond(id, false, null, "Missing required params: marketIndex, side, baseAssetAmount");
      return;
    }

    // If not initialized or simulate mode, return simulated response
    if (!isInitialized || !driftClient || simulate) {
      const orderId = `sim-market-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      log(`[SIM] Market order: ${side} ${baseAssetAmount} on market ${marketIndex}`);
      respond(id, true, {
        orderId,
        status: "simulated",
        marketIndex,
        side,
        baseAssetAmount,
        reduceOnly,
        userOrderId,
        live: false,
      });
      return;
    }

    // Helper: place order with fresh blockhash + retry on blockhash-related failures
    const placeWithRetry = async (orderParams, label = "MARKET", maxAttempts = 3) => {
      // PRE-PLACEMENT DEDUP CHECK: Check if userOrderId is already in use BEFORE attempting to place
      // This prevents UserOrderIdAlreadyInUse (0x17b7) errors when a previous order with this ID
      // is still on-chain (e.g., from a timed-out placement that actually succeeded)
      if (orderParams.userOrderId && orderParams.userOrderId !== 0) {
        try {
          const openOrders = await fetchOpenOrders(subaccountId);
          const existing = openOrders.find(
            (o) =>
              o.marketIndex === orderParams.marketIndex &&
              normalizeUserOrderId(o) === Number(orderParams.userOrderId)
          );
          if (existing) {
            log(
              `[DEDUP] ${label} order already exists for userOrderId=${orderParams.userOrderId} on market ${orderParams.marketIndex} - returning existing`
            );
            return { deduped: true, existingOrder: existing };
          }
        } catch (preCheckErr) {
          // Non-fatal: continue with placement attempt if pre-check fails
          log(
            `[WARN] Pre-placement dedup check failed (will attempt placement anyway): ${preCheckErr.message}`
          );
        }
      }

      let attempt = 0;
      while (attempt < maxAttempts) {
        acquirePollingBoost();
        try {
          // Preflight: ensure required market/spot/oracle data exists in the subscriber.
          // This is especially important in polling mode where market data is stored in Maps and may
          // not be populated yet even though subscribe() completed.
          const ready = await ensureAccountContextReadyForPerpOrder(orderParams.marketIndex);
          if (!ready.ok) {
            throw new Error(
              ready.reason || `market data not ready for perpMarket(${orderParams.marketIndex})`
            );
          }

          const startTime = Date.now();
          const txSig = await driftClient.placePerpOrder(orderParams);
          const elapsed = Date.now() - startTime;
          log(`[LIVE] ${label} placePerpOrder succeeded in ${elapsed}ms: ${txSig}`);
          return { txSig };
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          const isBlockhashIssue =
            /blockhash not found|expired blockhash|Transaction expired|Blockhash not found/i.test(
              msg
            );
          const needsMarketRefresh = /dataAndSlot|reading 'data'\)|market data not ready/i.test(
            msg
          );
          const isRateLimit = isRateLimitError(err);
          if (needsMarketRefresh && err?.stack) {
            log(`[ERROR] ${label} market data stack:\n${err.stack}`);
          }

          // If it's a SendTransactionError, try to fetch logs for better diagnostics
          try {
            if (err instanceof SendTransactionError && connection) {
              const logs = await err.getLogs(connection).catch(() => null);
              if (Array.isArray(logs) && logs.length) {
                logs.forEach((line) => log(`[TX LOG] ${line}`));
              }
            }
          } catch (logErr) {
            log(`[WARN] Unable to fetch tx logs: ${logErr.message}`);
          }

          // Handle rate limit errors - back off and retry
          if (isRateLimit && attempt < maxAttempts - 1) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
            log(
              `[RETRY] ${label} rate limited, backing off ${backoffMs}ms (attempt ${attempt + 1}/${maxAttempts})...`
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            attempt += 1;
            continue;
          }

          if (needsMarketRefresh && attempt < maxAttempts - 1) {
            // This error commonly occurs when required market/spot/oracle data isn't available
            // in the accountSubscriber yet (polling: map entry missing; websocket: subscriber missing).
            // Refresh only the required market/oracle subscriptions (avoid global fetch()).
            const missingPerp = msg.match(/perpMarket\((\d+)\)/i);
            const missingSpot = msg.match(/spotMarket\((\d+)\)/i);
            const missingOracle = msg.match(/oracle\(([^)]+)\)/i);
            if (missingPerp) {
              await ensurePerpMarketReady(Number(missingPerp[1]));
            }
            if (missingSpot) {
              await ensureSpotMarketReady(Number(missingSpot[1]));
            }
            if (missingOracle) {
              try {
                const subscriber = driftClient?.accountSubscriber;
                if (typeof subscriber?.setPerpOracleMap === "function") {
                  await subscriber.setPerpOracleMap();
                }
                if (typeof subscriber?.setSpotOracleMap === "function") {
                  await subscriber.setSpotOracleMap();
                }
                if (typeof subscriber?.fetch === "function") {
                  await subscriber.fetch();
                }
              } catch (oracleErr) {
                log(`[WARN] ${label} oracle refresh failed: ${oracleErr.message}`);
              }
            }
            if (!missingPerp && !missingSpot && !missingOracle && /dataAndSlot/i.test(msg)) {
              // We couldn't identify a specific market from the error message; force a full fetch
              // to refresh account subscriber caches before retrying.
              try {
                const subscriber = driftClient?.accountSubscriber;
                if (typeof subscriber?.fetch === "function") {
                  await subscriber.fetch();
                }
              } catch (fetchErr) {
                log(
                  `[WARN] ${label} subscriber.fetch() failed after dataAndSlot error: ${fetchErr.message}`
                );
              }
            }
            await ensureAccountContextReadyForPerpOrder(orderParams.marketIndex);
            attempt += 1;
            log(
              `[RETRY] ${label} market data not ready, retrying (attempt ${attempt}/${maxAttempts})...`
            );
            await new Promise((r) => setTimeout(r, 150));
            continue;
          }

          if (isBlockhashIssue && attempt < maxAttempts - 1) {
            const waitMs = Math.max(
              250,
              Number.isFinite(sdkBlockhashStaleCacheTimeMs) ? sdkBlockhashStaleCacheTimeMs : 2000
            );
            if (orderParams.userOrderId && orderParams.userOrderId !== 0) {
              try {
                const openOrders = await fetchOpenOrders(subaccountId);
                const existing = openOrders.find(
                  (o) =>
                    o.marketIndex === orderParams.marketIndex &&
                    normalizeUserOrderId(o) === Number(orderParams.userOrderId)
                );
                if (existing) {
                  log(
                    `[DEDUP] ${label} order already open for userOrderId=${orderParams.userOrderId}`
                  );
                  return { deduped: true, existingOrder: existing };
                }
              } catch (dedupeErr) {
                if (dedupeErr.code === "USER_NOT_READY") {
                  const retryErr = new Error(
                    `${label} blockhash retry aborted - user not ready for dedupe`
                  );
                  retryErr.code = "USER_NOT_READY";
                  throw retryErr;
                }
                log(`[WARN] Dedup check failed: ${dedupeErr.message}`);
              }
            }
            // NOTE: Position check removed - checking for existing positions is not a valid
            // deduplication method for blockhash errors because:
            // 1. A position could be pre-existing from a previous unrelated trade
            // 2. The order placement actually failed, so we cannot verify the position was created by this order
            // 3. This caused silent order failures where failed orders were incorrectly marked as successful
            attempt += 1;
            log(
              `[RETRY] ${label} blockhash issue detected, retrying (attempt ${attempt}/${maxAttempts})...`
            );
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw err;
        } finally {
          releasePollingBoost();
        }
      }
      // Should not reach here
      throw new Error(`${label} order failed after ${maxAttempts} attempts`);
    };

    // REAL order placement
    try {
      // Direction enum - per Drift SDK docs
      const direction =
        side.toLowerCase() === "long" ? PositionDirection.LONG : PositionDirection.SHORT;

      // Convert baseAssetAmount to BN (assuming input is in base units * 1e9)
      const baseAmountBN = new BN(Math.floor(baseAssetAmount * 1e9));

      // Construct order params manually following official Drift SDK docs:
      // https://drift-labs.github.io/v2-teacher/?typescript#placing-perp-order
      // https://drift-labs.github.io/protocol-v2/sdk/classes/DriftClient.html
      const orderParams = {
        // Required params
        orderType: OrderType.MARKET,
        marketIndex: marketIndex,
        direction: direction,
        baseAssetAmount: baseAmountBN,
        // Optional params with explicit values
        marketType: MarketType.PERP,
        userOrderId: userOrderId || 0,
        reduceOnly: reduceOnly,
      };

      log(`[LIVE] Placing market order: ${side} ${baseAssetAmount} on market ${marketIndex}`);
      log(
        `[LIVE] Order params: ${JSON.stringify({
          orderType: "MARKET",
          marketType: "PERP",
          marketIndex,
          direction: side,
          baseAssetAmount: baseAssetAmount.toString(),
          reduceOnly,
        })}`
      );

      const result = await placeWithRetry(orderParams, "MARKET");

      if (result.deduped) {
        log(`[LIVE] Market order deduped for userOrderId=${userOrderId}`);
      } else {
        log(`[LIVE] Market order placed: ${result.txSig}`);
      }

      respond(id, true, {
        txSignature: result.txSig,
        status: result.deduped ? "deduped" : "submitted",
        marketIndex,
        side,
        baseAssetAmount,
        reduceOnly,
        userOrderId,
        live: true,
      });
    } catch (err) {
      log(`[LIVE] Market order error: ${err.message}`);
      respond(id, false, null, `Order placement failed: ${err.message}`);
    }
  },

  // Place limit order (maker)
  placeLimitOrder: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    log(`[placeLimitOrder] Received params: ${JSON.stringify(params)}`);

    const {
      marketIndex: rawMarketIndex,
      side,
      baseAssetAmount: rawBaseAssetAmount,
      price: rawPrice,
      postOnly = true,
      reduceOnly = false,
      simulate = false,
      userOrderId: rawUserOrderId = 0,
    } = params;

    const marketIndex = Number(rawMarketIndex);
    const baseAssetAmount = Number(rawBaseAssetAmount);
    const price = Number(rawPrice);
    const userOrderId = Number(rawUserOrderId) || 0;

    // Validate params with detailed logging
    const missing = [];
    if (!Number.isFinite(marketIndex)) missing.push("marketIndex");
    if (!side) missing.push("side");
    if (!Number.isFinite(baseAssetAmount) || baseAssetAmount <= 0) missing.push("baseAssetAmount");
    if (!Number.isFinite(price) || price <= 0) missing.push("price");

    if (missing.length > 0) {
      log(
        `[placeLimitOrder] Missing params: ${missing.join(", ")}. Values: marketIndex=${marketIndex}, side=${side}, baseAssetAmount=${baseAssetAmount}, price=${price}`
      );
      respond(id, false, null, `Missing required params: ${missing.join(", ")}`);
      return;
    }

    // If not initialized or simulate mode, return simulated response
    if (!isInitialized || !driftClient || simulate) {
      const orderId = `sim-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      log(`[SIM] Limit order: ${side} ${baseAssetAmount} @ ${price} on market ${marketIndex}`);
      respond(id, true, {
        orderId,
        status: "simulated",
        marketIndex,
        side,
        baseAssetAmount,
        price,
        postOnly,
        reduceOnly,
        userOrderId,
        live: false,
      });
      return;
    }

    // Helper: place order with cached blockhash + retry on blockhash/rate-limit failures
    const placeWithRetry = async (orderParams, label = "LIMIT", maxAttempts = 3) => {
      // PRE-PLACEMENT DEDUP CHECK: Check if userOrderId is already in use BEFORE attempting to place
      // This prevents UserOrderIdAlreadyInUse (0x17b7) errors when a previous order with this ID
      // is still on-chain (e.g., from a timed-out placement that actually succeeded)
      if (orderParams.userOrderId && orderParams.userOrderId !== 0) {
        try {
          const openOrders = await fetchOpenOrders(subaccountId);
          const existing = openOrders.find(
            (o) =>
              o.marketIndex === orderParams.marketIndex &&
              normalizeUserOrderId(o) === Number(orderParams.userOrderId)
          );
          if (existing) {
            log(
              `[DEDUP] ${label} order already exists for userOrderId=${orderParams.userOrderId} on market ${orderParams.marketIndex} - returning existing`
            );
            return { deduped: true, existingOrder: existing };
          }
        } catch (preCheckErr) {
          // Non-fatal: continue with placement attempt if pre-check fails
          log(
            `[WARN] Pre-placement dedup check failed (will attempt placement anyway): ${preCheckErr.message}`
          );
        }
      }

      let attempt = 0;
      while (attempt < maxAttempts) {
        acquirePollingBoost();
        try {
          // Preflight: ensure required market/spot/oracle data exists in the subscriber.
          const ready = await ensureAccountContextReadyForPerpOrder(orderParams.marketIndex);
          if (!ready.ok) {
            throw new Error(
              ready.reason || `market data not ready for perpMarket(${orderParams.marketIndex})`
            );
          }

          const startTime = Date.now();
          const txSig = await driftClient.placePerpOrder(orderParams);
          const elapsed = Date.now() - startTime;
          log(`[LIVE] ${label} placePerpOrder succeeded in ${elapsed}ms: ${txSig}`);
          return { txSig };
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          const isBlockhashIssue =
            /blockhash not found|expired blockhash|Transaction expired|Blockhash not found/i.test(
              msg
            );
          const needsMarketRefresh = /dataAndSlot|reading 'data'\)|market data not ready/i.test(
            msg
          );
          const isRateLimit = isRateLimitError(err);
          if (needsMarketRefresh && err?.stack) {
            log(`[ERROR] ${label} market data stack:\n${err.stack}`);
          }

          // If it's a SendTransactionError, try to fetch logs for better diagnostics
          try {
            if (err instanceof SendTransactionError && connection) {
              const logs = await err.getLogs(connection).catch(() => null);
              if (Array.isArray(logs) && logs.length) {
                logs.forEach((line) => log(`[TX LOG] ${line}`));
              }
            }
          } catch (logErr) {
            log(`[WARN] Unable to fetch tx logs: ${logErr.message}`);
          }

          // Handle rate limit errors - back off and retry
          if (isRateLimit && attempt < maxAttempts - 1) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
            log(
              `[RETRY] ${label} rate limited, backing off ${backoffMs}ms (attempt ${attempt + 1}/${maxAttempts})...`
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            attempt += 1;
            continue;
          }

          if (needsMarketRefresh && attempt < maxAttempts - 1) {
            // Refresh only the required market subscriptions (avoid global fetch()).
            const missingPerp = msg.match(/perpMarket\((\d+)\)/i);
            const missingSpot = msg.match(/spotMarket\((\d+)\)/i);
            const missingOracle = msg.match(/oracle\(([^)]+)\)/i);
            if (missingPerp) {
              await ensurePerpMarketReady(Number(missingPerp[1]));
            }
            if (missingSpot) {
              await ensureSpotMarketReady(Number(missingSpot[1]));
            }
            if (missingOracle) {
              try {
                const subscriber = driftClient?.accountSubscriber;
                if (typeof subscriber?.setPerpOracleMap === "function") {
                  await subscriber.setPerpOracleMap();
                }
                if (typeof subscriber?.setSpotOracleMap === "function") {
                  await subscriber.setSpotOracleMap();
                }
                if (typeof subscriber?.fetch === "function") {
                  await subscriber.fetch();
                }
              } catch (oracleErr) {
                log(`[WARN] ${label} oracle refresh failed: ${oracleErr.message}`);
              }
            }
            if (!missingPerp && !missingSpot && !missingOracle && /dataAndSlot/i.test(msg)) {
              try {
                const subscriber = driftClient?.accountSubscriber;
                if (typeof subscriber?.fetch === "function") {
                  await subscriber.fetch();
                }
              } catch (fetchErr) {
                log(
                  `[WARN] ${label} subscriber.fetch() failed after dataAndSlot error: ${fetchErr.message}`
                );
              }
            }
            await ensureAccountContextReadyForPerpOrder(orderParams.marketIndex);
            attempt += 1;
            log(
              `[RETRY] ${label} market data not ready, retrying (attempt ${attempt}/${maxAttempts})...`
            );
            await new Promise((r) => setTimeout(r, 150));
            continue;
          }

          if (isBlockhashIssue && attempt < maxAttempts - 1) {
            const waitMs = Math.max(
              250,
              Number.isFinite(sdkBlockhashStaleCacheTimeMs) ? sdkBlockhashStaleCacheTimeMs : 2000
            );
            if (orderParams.userOrderId && orderParams.userOrderId !== 0) {
              try {
                const openOrders = await fetchOpenOrders(subaccountId);
                const existing = openOrders.find(
                  (o) =>
                    o.marketIndex === orderParams.marketIndex &&
                    normalizeUserOrderId(o) === Number(orderParams.userOrderId)
                );
                if (existing) {
                  log(
                    `[DEDUP] ${label} order already open for userOrderId=${orderParams.userOrderId}`
                  );
                  return { deduped: true, existingOrder: existing };
                }
              } catch (dedupeErr) {
                log(`[WARN] Dedup check failed: ${dedupeErr.message}`);
              }
            }
            // NOTE: Position check removed - checking for existing positions is not a valid
            // deduplication method for blockhash errors because:
            // 1. A position could be pre-existing from a previous unrelated trade
            // 2. The order placement actually failed, so we cannot verify the position was created by this order
            // 3. This caused silent order failures where failed orders were incorrectly marked as successful
            attempt += 1;
            log(
              `[RETRY] ${label} blockhash issue detected, retrying (attempt ${attempt}/${maxAttempts})...`
            );
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw err;
        } finally {
          releasePollingBoost();
        }
      }
      // Should not reach here
      throw new Error(`${label} order failed after ${maxAttempts} attempts`);
    };

    // REAL order placement
    try {
      // Direction enum - per Drift SDK docs
      const direction =
        side.toLowerCase() === "long" ? PositionDirection.LONG : PositionDirection.SHORT;

      // Convert to BN (base: 1e9, price: 1e6) per Drift precision docs
      const baseAmountBN = new BN(Math.floor(baseAssetAmount * 1e9));
      const priceBN = new BN(Math.floor(price * 1e6));

      // Construct order params manually following official Drift SDK docs:
      // https://drift-labs.github.io/v2-teacher/?typescript#placing-perp-order
      // https://drift-labs.github.io/protocol-v2/sdk/classes/DriftClient.html
      const orderParams = {
        // Required params
        orderType: OrderType.LIMIT,
        marketIndex: marketIndex,
        direction: direction,
        baseAssetAmount: baseAmountBN,
        // Optional params with explicit values
        marketType: MarketType.PERP,
        price: priceBN,
        userOrderId: userOrderId || 0,
        reduceOnly: reduceOnly,
        // PostOnlyParams enum - NOT a boolean
        postOnly: postOnly ? PostOnlyParams.MUST_POST_ONLY : PostOnlyParams.NONE,
      };

      log(
        `[LIVE] Placing limit order: ${side} ${baseAssetAmount} @ ${price} on market ${marketIndex}, postOnly=${postOnly}`
      );
      log(
        `[LIVE] Order params: ${JSON.stringify({
          orderType: "LIMIT",
          marketType: "PERP",
          marketIndex,
          direction: side,
          baseAssetAmount: baseAssetAmount.toString(),
          price: price.toString(),
          reduceOnly,
          postOnly,
        })}`
      );

      const result = await placeWithRetry(orderParams, "LIMIT");

      if (result.deduped) {
        log(`[LIVE] Limit order deduped for userOrderId=${userOrderId}`);
      } else {
        log(`[LIVE] Limit order placed: ${result.txSig}`);
      }

      respond(id, true, {
        txSignature: result.txSig,
        status: result.deduped ? "deduped" : "submitted",
        marketIndex,
        side,
        baseAssetAmount,
        price,
        postOnly,
        reduceOnly,
        userOrderId,
        live: true,
      });
    } catch (err) {
      log(`[LIVE] Limit order error: ${err.message}`);
      respond(id, false, null, `Order placement failed: ${err.message}`);
    }
  },

  // Cancel order by order ID
  cancelOrder: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { orderId, marketIndex, simulate = false } = params;

    // If not initialized or simulate mode, return simulated response
    if (!isInitialized || !driftClient || simulate) {
      log(`[SIM] Cancel order: ${orderId} on market ${marketIndex}`);
      respond(id, true, {
        cancelled: true,
        orderId,
        marketIndex,
        status: "simulated",
        live: false,
      });
      return;
    }

    // REAL cancel
    try {
      log(`[LIVE] Cancelling order: ${orderId}`);

      const ready = await ensureAccountContextReadyForPerpOrder(
        Number.isFinite(Number(marketIndex)) ? Number(marketIndex) : Number.NaN
      );
      if (!ready.ok) {
        throw new Error(ready.reason || "market data not ready");
      }

      const txSig = await driftClient.cancelOrder(orderId);

      log(`[LIVE] Order cancelled: ${txSig}`);

      respond(id, true, {
        cancelled: true,
        orderId,
        marketIndex,
        txSignature: txSig,
        status: "cancelled",
        live: true,
      });
    } catch (err) {
      log(`[LIVE] Cancel order error: ${err.message}`);
      respond(id, false, null, `Cancel failed: ${err.message}`);
    }
  },

  // Cancel order by userOrderId (idempotency key)
  cancelOrderByUserOrderId: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { userOrderId, marketIndex, subaccount = subaccountId, simulate = false } = params;

    if (userOrderId === undefined || userOrderId === null) {
      respond(id, false, null, "Missing required param: userOrderId");
      return;
    }

    if (!isInitialized || !driftClient || simulate) {
      log(`[SIM] Cancel order by userOrderId: ${userOrderId} on market ${marketIndex}`);
      respond(id, true, {
        cancelled: true,
        userOrderId,
        marketIndex,
        status: "simulated",
        live: false,
      });
      return;
    }

    try {
      log(`[LIVE] Cancelling order by userOrderId: ${userOrderId}`);
      const ready = await ensureAccountContextReadyForPerpOrder(
        Number.isFinite(Number(marketIndex)) ? Number(marketIndex) : Number.NaN
      );
      if (!ready.ok) {
        throw new Error(ready.reason || "market data not ready");
      }
      const openOrders = await fetchOpenOrders(subaccount);
      const existing = openOrders.find((o) => normalizeUserOrderId(o) === Number(userOrderId));
      if (!existing) {
        log(
          `[LIVE] No open order found for userOrderId=${userOrderId} - treating as already closed`
        );
        respond(id, true, {
          cancelled: false,
          userOrderId,
          marketIndex,
          status: "not_found",
          live: true,
        });
        return;
      }
      const txSig = await driftClient.cancelOrderByUserId(userOrderId, undefined, subaccount);
      log(`[LIVE] Order cancelled by userOrderId: ${txSig}`);
      respond(id, true, {
        cancelled: true,
        userOrderId,
        marketIndex,
        txSignature: txSig,
        status: "cancelled",
        live: true,
      });
    } catch (err) {
      log(`[LIVE] Cancel by userOrderId error: ${err.message}`);
      respond(id, false, null, `Cancel failed: ${err.message}`);
    }
  },

  // Cancel all orders for a market or all markets
  cancelAllOrders: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { marketIndex, subaccount = subaccountId, simulate = false } = params;

    // If not initialized or simulate mode, return simulated response
    if (!isInitialized || !driftClient || simulate) {
      log(
        `[SIM] Cancel all orders for subaccount ${subaccount}${marketIndex !== undefined ? ` market ${marketIndex}` : ""}`
      );
      respond(id, true, {
        cancelledCount: 0,
        marketIndex,
        subaccount,
        status: "simulated",
        live: false,
      });
      return;
    }

    // REAL cancel all
    try {
      log(
        `[LIVE] Cancelling all orders${marketIndex !== undefined ? ` for market ${marketIndex}` : ""}`
      );
      const ready = await ensureAccountContextReadyForPerpOrder(
        Number.isFinite(Number(marketIndex)) ? Number(marketIndex) : Number.NaN
      );
      if (!ready.ok) {
        throw new Error(ready.reason || "market data not ready");
      }

      if (marketIndex !== undefined) {
        // Cancel orders for specific market
        const txSig = await driftClient.cancelOrders(MarketType.PERP, marketIndex);
        log(`[LIVE] Orders cancelled for market ${marketIndex}: ${txSig}`);

        respond(id, true, {
          txSignature: txSig,
          marketIndex,
          subaccount,
          status: "cancelled",
          live: true,
        });
      } else {
        // Cancel all perp orders - need to get all open orders and cancel by market
        // Drift SDK doesn't have a global cancelAllOrders method, so we iterate
        const user = await ensureUser(subaccount);
        const openOrders = user ? user.getOpenOrders() : [];
        const perpOrders = openOrders.filter(
          (o) =>
            o.marketType &&
            (o.marketType.perp !== undefined || Object.keys(o.marketType)[0] === "perp")
        );

        // Get unique market indices
        const marketIndices = [...new Set(perpOrders.map((o) => o.marketIndex))];

        if (marketIndices.length === 0) {
          log("[LIVE] No open perp orders to cancel");
          respond(id, true, {
            cancelledCount: 0,
            subaccount,
            status: "no_orders",
            live: true,
          });
          return;
        }

        log(
          `[LIVE] Cancelling orders for ${marketIndices.length} markets: ${marketIndices.join(", ")}`
        );

        // Cancel each market's orders
        const txSignatures = [];
        for (const mktIdx of marketIndices) {
          try {
            const txSig = await driftClient.cancelOrders(MarketType.PERP, mktIdx);
            txSignatures.push(txSig);
            log(`[LIVE] Cancelled orders for market ${mktIdx}: ${txSig}`);
          } catch (mktErr) {
            log(`[LIVE] Failed to cancel orders for market ${mktIdx}: ${mktErr.message}`);
          }
        }

        respond(id, true, {
          txSignatures,
          cancelledMarkets: marketIndices,
          subaccount,
          status: "cancelled",
          live: true,
        });
      }
    } catch (err) {
      log(`[LIVE] Cancel all orders error: ${err.message}`);
      respond(id, false, null, `Cancel all failed: ${err.message}`);
    }
  },

  // Get order status (check if filled, cancelled, etc.)
  // Note: Drift doesn't have a direct "get order by ID" API since orders are filled/cancelled quickly
  // We check if an order still exists in open orders, and if not, assume it was filled or cancelled
  getOrderStatus: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { orderId, marketIndex, subaccount = subaccountId } = params;

    if (!isInitialized || !driftClient) {
      respond(id, true, {
        orderId,
        filled: false,
        cancelled: false,
        expired: false,
        live: false,
        note: "DriftClient not initialized",
      });
      return;
    }

    try {
      const user = await ensureUser(subaccount);
      if (!user) {
        // No user account = no orders = likely filled
        respond(id, true, {
          orderId,
          filled: true,
          cancelled: false,
          expired: false,
          live: true,
          note: "User account not found - order likely filled",
        });
        return;
      }

      // Get open orders
      let openOrders = [];
      if (typeof user.getOpenOrders === "function") {
        openOrders = user.getOpenOrders();
      } else if (typeof user.getOrders === "function") {
        openOrders = user
          .getOrders()
          .filter((o) => o.status === "open" || !o.baseAssetAmountFilled?.eq(o.baseAssetAmount));
      }

      // Filter by market if specified
      if (marketIndex !== undefined) {
        openOrders = openOrders.filter((o) => o.marketIndex === marketIndex);
      }

      // If no open orders for this market, the order was likely filled
      const isStillOpen = openOrders.length > 0;

      respond(id, true, {
        orderId,
        filled: !isStillOpen,
        cancelled: false,
        expired: false,
        openOrderCount: openOrders.length,
        live: true,
      });
    } catch (err) {
      log(`getOrderStatus error: ${err.message}`);
      // On error, assume order may have been processed
      respond(id, true, {
        orderId,
        filled: false,
        cancelled: false,
        expired: false,
        error: err.message,
        live: true,
      });
    }
  },

  // Get open orders (for monitoring and cleanup)
  getOpenOrders: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { subaccount = subaccountId, marketIndex, forceRefresh = false } = params;

    if (!isInitialized || !driftClient) {
      respond(id, true, {
        orders: [],
        subaccount,
        live: false,
        note: "DriftClient not initialized",
      });
      return;
    }

    try {
      const startTime = Date.now();
      // Get open orders from user account with timeout protection
      let openOrders = [];
      try {
        openOrders = await fetchOpenOrders(subaccount, { forceRefresh: !!forceRefresh });
      } catch (orderErr) {
        if (orderErr.code === "USER_NOT_READY") {
          respond(id, true, {
            orders: [],
            subaccount,
            live: false,
            backoff: true,
            note: "User account not ready",
          });
          return;
        }
        log(`getOpenOrders: Error fetching orders: ${orderErr.message}`);
        openOrders = [];
      }

      // Filter by market if specified
      let filteredOrders = openOrders;
      if (marketIndex !== undefined) {
        filteredOrders = openOrders.filter((o) => o.marketIndex === marketIndex);
      }

      // Map to serializable format
      const orders = filteredOrders.map((o) => {
        const orderId = o.orderId || o.id;
        const userOrderId = normalizeUserOrderId(o);
        if (orderId !== undefined && userOrderId !== null) {
          touchOrderIdMapping(orderId, userOrderId);
        }

        return {
          orderId,
          userOrderId,
          marketIndex: o.marketIndex,
          orderType: o.orderType?.toString?.() || o.orderType,
          direction: o.direction?.toString?.() || (o.baseAssetAmount?.isNeg?.() ? "short" : "long"),
          baseAssetAmount: o.baseAssetAmount?.toString?.() || o.baseAssetAmount,
          baseAssetAmountFilled: o.baseAssetAmountFilled?.toString?.() || "0",
          price: o.price?.toString?.() || o.price,
          status: o.status?.toString?.() || "open",
          postOnly: o.postOnly,
          reduceOnly: o.reduceOnly,
          slot: o.slot,
        };
      });
      pruneOrderIdCache();

      const elapsed = Date.now() - startTime;
      if (elapsed > 5000) {
        log(`[WARN] getOpenOrders took ${elapsed}ms (slow)`);
      }

      log(
        `Found ${orders.length} open orders${marketIndex !== undefined ? ` for market ${marketIndex}` : ""} (${elapsed}ms)`
      );

      respond(id, true, {
        orders,
        subaccount,
        live: true,
        count: orders.length,
      });
    } catch (err) {
      log(`getOpenOrders error: ${err.message}`);
      log(`Stack: ${err.stack}`);
      respond(id, false, null, `Open orders query failed: ${err.message}`);
    }
  },

  // Get positions
  getPositions: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { subaccount = subaccountId, forceRefresh = false } = params;

    // Use real DriftClient if initialized
    if (isInitialized && driftClient) {
      try {
        let perpPositions;
        try {
          perpPositions = await fetchPerpPositions(subaccount, { forceRefresh: !!forceRefresh });
        } catch (posErr) {
          if (posErr.code === "USER_NOT_READY") {
            respond(id, true, {
              positions: [],
              subaccount,
              live: false,
              backoff: true,
              note: "User account not ready or not subscribed",
            });
            return;
          }
          throw posErr;
        }

        const positions = perpPositions
          .map((p) => {
            // CRITICAL: quoteEntryAmount is the ACTUAL entry quote value (before funding/PnL)
            // quoteAssetAmount includes unrealized PnL - DO NOT use for entry price!
            const quoteEntryAmount = p.quoteEntryAmount?.toString();
            const baseAssetAmount =
              p.baseAssetAmount?.toString?.() ?? String(p.baseAssetAmount ?? "0");
            const baseAmountNum = toNumberSafe(p.baseAssetAmount);
            const quoteAmountNum = toNumberSafe(p.quoteAssetAmount);
            const sizeBase = Math.abs(baseAmountNum) / 1e9;

            // Calculate true entry price from quoteEntryAmount if available
            let entryPrice = null;
            if (quoteEntryAmount) {
              const quoteEntry = Math.abs(Number(quoteEntryAmount)) / 1e6;
              if (sizeBase > 0) {
                entryPrice = quoteEntry / sizeBase;
              }
            }

            return {
              marketIndex: p.marketIndex,
              baseAssetAmount,
              quoteAssetAmount:
                p.quoteAssetAmount?.toString?.() ?? String(p.quoteAssetAmount ?? "0"),
              quoteBreakEvenAmount: p.quoteBreakEvenAmount?.toString(),
              quoteEntryAmount, // CRITICAL: Entry quote value for accurate fill price
              entryPrice, // Pre-calculated entry price
              lastCumulativeFundingRate: p.lastCumulativeFundingRate?.toString(),
              openOrders: p.openOrders,
              // Derived fields
              side: p.baseAssetAmount?.isNeg?.() ? "short" : baseAmountNum < 0 ? "short" : "long",
              sizeBase, // 9 decimals for base
              sizeQuote: Math.abs(quoteAmountNum) / 1e6, // 6 decimals for quote
            };
          })
          .filter((p) => Math.abs(p.sizeBase || 0) > 0);

        if (process.env.DRIFT_DEBUG_POSITIONS === "true") {
          log(`getPositions raw=${perpPositions.length} filtered=${positions.length}`);
          for (const pos of positions) {
            log(
              `   pos marketIndex=${pos.marketIndex} side=${pos.side} sizeBase=${pos.sizeBase} quoteEntryAmount=${pos.quoteEntryAmount}`
            );
          }
        }

        respond(id, true, {
          positions,
          subaccount,
          live: true,
          count: positions.length,
        });
      } catch (err) {
        log(`getPositions error: ${err.message}`);
        respond(id, false, null, `Position query failed: ${err.message}`);
      }
      return;
    }

    // Fallback: not initialized
    respond(id, true, {
      positions: [],
      subaccount,
      live: false,
      note: "DriftClient not initialized. Call init first.",
    });
  },

  // DEPRECATED: Use 'init' instead (secure wallet loading)
  // This handler is kept for backwards compatibility warning
  initWithWallet: async (params, id) => {
    log(
      '[DEPRECATED] initWithWallet is deprecated. Use "init" command instead (loads wallet locally, no IPC key transfer).'
    );
    respond(
      id,
      false,
      null,
      'initWithWallet is DEPRECATED for security. Use "init" command instead - it loads the wallet locally from WALLET_PRIVATE_KEY_PATH without sending private keys via IPC.'
    );
  },

  // Get current client state
  getState: async (params, id) => {
    respond(id, true, {
      isInitialized,
      walletPubkey,
      cluster,
      subaccountId,
      sdkLoaded,
      sdkError,
      programId: sdkLoaded ? publicKeyToString(DRIFT_PROGRAM_ID) : null,
    });
  },

  // Confirm transaction status (check if tx was actually confirmed on-chain)
  confirmTransaction: async (params, id) => {
    const { txSignature, commitment = "confirmed", timeout = 30000 } = params;

    if (!txSignature) {
      respond(id, false, null, "Missing required param: txSignature");
      return;
    }

    if (!connection) {
      respond(id, false, null, "Connection not initialized");
      return;
    }

    try {
      log(`[confirmTransaction] Checking status of tx: ${txSignature.slice(0, 20)}...`);

      // Use confirmTransaction with timeout
      const startTime = Date.now();
      const result = await connection.confirmTransaction(
        {
          signature: txSignature,
          blockhash: null, // Let SDK handle
          lastValidBlockHeight: null, // Let SDK handle
        },
        commitment
      );

      const elapsed = Date.now() - startTime;

      if (result.value?.err) {
        log(
          `[confirmTransaction] Tx ${txSignature.slice(0, 20)}... FAILED: ${JSON.stringify(result.value.err)}`
        );
        respond(id, true, {
          confirmed: false,
          failed: true,
          error: result.value.err,
          elapsedMs: elapsed,
          txSignature,
        });
      } else {
        log(`[confirmTransaction] Tx ${txSignature.slice(0, 20)}... confirmed in ${elapsed}ms`);
        respond(id, true, {
          confirmed: true,
          failed: false,
          elapsedMs: elapsed,
          txSignature,
          slot: result.context?.slot,
        });
      }
    } catch (err) {
      log(
        `[confirmTransaction] Error confirming tx ${txSignature.slice(0, 20)}...: ${err.message}`
      );

      // Check if it's a timeout (which might mean tx is still pending)
      const isTimeout = err.message?.includes("timeout") || err.message?.includes("expired");

      respond(id, true, {
        confirmed: false,
        failed: !isTimeout,
        timeout: isTimeout,
        error: err.message,
        txSignature,
      });
    }
  },

  // Get version info
  getVersion: async (params, id) => {
    let sdkVersion = "unknown";
    try {
      const pkg = require("@drift-labs/sdk/package.json");
      sdkVersion = pkg.version;
    } catch (e) {
      // ignore
    }

    respond(id, true, {
      nodeVersion: process.version,
      sdkVersion,
      sdkLoaded,
    });
  },

  // Get program ID
  getProgramId: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }
    respond(id, true, {
      programId: publicKeyToString(DRIFT_PROGRAM_ID),
    });
  },

  // Get fee structure info
  getFeeStructure: async (params, id) => {
    // Return fee tiers (same as getFeeInfo but with more detail)
    const feeTiers = {
      rookie: { takerBps: 10, makerBps: -2, volume30d: 0 },
      bronze: { takerBps: 8, makerBps: -2, volume30d: 1_000_000 },
      silver: { takerBps: 6, makerBps: -2, volume30d: 5_000_000 },
      gold: { takerBps: 4, makerBps: -3, volume30d: 10_000_000 },
      platinum: { takerBps: 3, makerBps: -3, volume30d: 50_000_000 },
      vip: { takerBps: 2, makerBps: -4, volume30d: 100_000_000 },
    };

    respond(id, true, {
      feeTiers,
      note: "makerBps negative = rebate. volume30d is USD threshold.",
    });
  },

  // Get perp market account (on-chain data)
  getPerpMarketAccount: async (params, id) => {
    if (!sdkLoaded) {
      respond(id, false, null, "SDK not loaded");
      return;
    }

    const { marketIndex } = params;

    if (marketIndex === undefined) {
      respond(id, false, null, "Missing required param: marketIndex");
      return;
    }

    if (!isInitialized || !driftClient) {
      respond(id, true, {
        marketIndex,
        live: false,
        note: "DriftClient not initialized. Call init first.",
      });
      return;
    }

    try {
      const market = driftClient.getPerpMarketAccount(marketIndex);

      if (!market) {
        respond(id, true, {
          marketIndex,
          live: true,
          note: "Market not found",
        });
        return;
      }

      respond(id, true, {
        marketIndex,
        live: true,
        status: market.status,
        marginRatioInitial: market.marginRatioInitial,
        marginRatioMaintenance: market.marginRatioMaintenance,
        imfFactor: market.imfFactor,
        baseAssetAmountLong: market.amm?.baseAssetAmountLong?.toString(),
        baseAssetAmountShort: market.amm?.baseAssetAmountShort?.toString(),
        openInterest: market.amm?.openInterest?.toString(),
      });
    } catch (err) {
      log(`getPerpMarketAccount error: ${err.message}`);
      respond(id, false, null, `Market account query failed: ${err.message}`);
    }
  },

  // Shutdown
  shutdown: async (params, id) => {
    // Clean up in-flight promise caches
    inFlightOpenOrdersPromises.clear();
    inFlightPositionsPromises.clear();
    try {
      if (driftClient) {
        await driftClient.unsubscribe();
      }
    } catch (e) {
      // Ignore shutdown errors
    } finally {
      if (bulkAccountLoader) {
        try {
          bulkAccountLoader.stopPolling();
        } catch (e) {
          // ignore
        }
        resetPollingState();
      }
      driftClient = null;
      bulkAccountLoader = null;
      connection = null;
      isInitialized = false;
    }
    respond(id, true, { shutting_down: true });
    process.exit(0);
  },
};

// Message handler
async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    log("Invalid JSON:", line);
    return;
  }

  const { type, id, action, params = {} } = msg;

  // Debug: log incoming commands with their params
  log(`[MSG] Received: action=${action}, params=${JSON.stringify(params)}`);

  if (type !== "command") {
    log("Unknown message type:", type);
    return;
  }

  const handler = handlers[action];
  if (!handler) {
    respond(id, false, null, `Unknown action: ${action}`);
    return;
  }

  try {
    await handler(params, id);
  } catch (err) {
    respond(id, false, null, err.message);
  }
}

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  log("FATAL: Uncaught exception:", err.message);
  log("Stack:", err.stack);
  emit("error", { type: "uncaughtException", message: err.message, stack: err.stack });
  // Don't exit immediately - give time for the error to be logged/sent
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason, promise) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  log("FATAL: Unhandled rejection:", message);
  if (stack) log("Stack:", stack);
  emit("error", { type: "unhandledRejection", message, stack });
  // Don't exit for unhandled rejections - let the process continue
  // but log the error for debugging
});

// Handle SIGTERM gracefully (e.g., from Render restarts)
process.on("SIGTERM", () => {
  log("Received SIGTERM, shutting down gracefully...");
  // Clean up in-flight promise caches to avoid retained references
  inFlightOpenOrdersPromises.clear();
  inFlightPositionsPromises.clear();
  if (driftClient) {
    try {
      driftClient.unsubscribe().catch(() => {});
    } catch (e) {
      // ignore
    }
  }
  if (bulkAccountLoader) {
    try {
      bulkAccountLoader.stopPolling();
    } catch (e) {
      // ignore
    }
    resetPollingState();
    bulkAccountLoader = null;
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  log("Received SIGINT, shutting down gracefully...");
  // Clean up in-flight promise caches to avoid retained references
  inFlightOpenOrdersPromises.clear();
  inFlightPositionsPromises.clear();
  if (driftClient) {
    try {
      driftClient.unsubscribe().catch(() => {});
    } catch (e) {
      // ignore
    }
  }
  if (bulkAccountLoader) {
    try {
      bulkAccountLoader.stopPolling();
    } catch (e) {
      // ignore
    }
    resetPollingState();
    bulkAccountLoader = null;
  }
  process.exit(0);
});

// Main
function main() {
  log("Starting Drift subprocess...");
  log("Node version:", process.version);
  log("SDK loaded:", sdkLoaded);
  log("PID:", process.pid);
  if (sdkError) log("SDK error:", sdkError);

  // Emit ready event
  emit("ready", { sdkLoaded, sdkError, nodeVersion: process.version, pid: process.pid });

  // Read commands from stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", handleMessage);
  rl.on("close", () => {
    log("stdin closed (parent disconnected), cleaning up...");
    emit("exit", { reason: "stdin_closed" });

    // Clean up in-flight promise caches to avoid retained references
    inFlightOpenOrdersPromises.clear();
    inFlightPositionsPromises.clear();

    // Clean up Drift subscription before exit to free memory
    if (driftClient) {
      driftClient
        .unsubscribe()
        .catch((err) => {
          log("Unsubscribe error during cleanup:", err.message);
        })
        .finally(() => {
          log("Cleanup complete, exiting");
          process.exit(0);
        });
    } else {
      process.exit(0);
    }
  });

  // Handle readline errors
  rl.on("error", (err) => {
    log("readline error:", err.message);
    emit("error", { type: "readline", message: err.message });
  });
}

main();
