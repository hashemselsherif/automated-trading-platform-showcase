/**
 * Shared transaction builder for Jupiter Perps
 * Used by both the bot and manual UI trades
 * 
 * Extracts core transaction logic from perps-live-client.js
 * to enable reuse across different execution contexts.
 */

const { Connection, Transaction, VersionedTransaction } = require("@solana/web3.js");

/**
 * Build an open position transaction request
 * @param {Object} params
 * @param {Object} params.group - Jupiter Perps group
 * @param {Object} params.market - Jupiter Perps market
 * @param {string} params.side - "long" or "short"
 * @param {number} params.collateralUsd - Collateral in USD
 * @param {number} params.leverage - Leverage multiplier
 * @param {number} params.slippageBps - Slippage tolerance in basis points
 * @param {number} [params.priceLimit] - Optional price limit
 * @param {string} [params.clientOrderId] - Optional client order ID
 * @returns {Object} Transaction request object
 */
function buildOpenPositionRequest({
  group,
  market,
  side,
  collateralUsd,
  leverage,
  slippageBps,
  priceLimit,
  clientOrderId,
}) {
  const req = {
    group,
    market,
    side: String(side).toLowerCase() === "short" ? "short" : "long",
    collateralUsd: Number(collateralUsd),
    leverage: Number(leverage),
    slippageBps: Number(slippageBps),
    priceLimit: priceLimit ? Number(priceLimit) : undefined,
  };

  if (clientOrderId) {
    req.clientOrderId = clientOrderId;
  }

  return req;
}

/**
 * Build a close position transaction request
 * @param {Object} params
 * @param {Object} params.group - Jupiter Perps group
 * @param {Object} params.market - Jupiter Perps market
 * @param {number} params.slippageBps - Slippage tolerance in basis points
 * @param {number} [params.priceLimit] - Optional price limit
 * @returns {Object} Transaction request object
 */
function buildClosePositionRequest({
  group,
  market,
  slippageBps,
  priceLimit,
}) {
  return {
    group,
    market,
    slippageBps: Number(slippageBps),
    priceLimit: priceLimit ? Number(priceLimit) : undefined,
  };
}

/**
 * Normalize transaction payload from SDK
 * Handles various return formats: Transaction | VersionedTransaction | { tx } | { transactions: [...] } | [ix...]
 * @param {*} txOrObj - Transaction payload from SDK
 * @returns {Transaction | VersionedTransaction} Normalized transaction
 */
function normalizeTxPayload(txOrObj) {
  if (!txOrObj) {
    throw new Error("Empty transaction payload");
  }

  // Already a transaction
  if (txOrObj instanceof Transaction || txOrObj instanceof VersionedTransaction) {
    return txOrObj;
  }

  // Array of instructions
  if (Array.isArray(txOrObj)) {
    const tx = new Transaction();
    for (const ix of txOrObj) {
      tx.add(ix);
    }
    return tx;
  }

  // Object with tx/transaction field
  if (typeof txOrObj === "object") {
    if (txOrObj.tx) return normalizeTxPayload(txOrObj.tx);
    if (txOrObj.transaction) return normalizeTxPayload(txOrObj.transaction);
    if (Array.isArray(txOrObj.transactions) && txOrObj.transactions.length > 0) {
      return normalizeTxPayload(txOrObj.transactions[0]);
    }
  }

  throw new Error("Unrecognized transaction payload format");
}

/**
 * Validate open position parameters
 * @param {Object} params
 * @throws {Error} If validation fails
 */
function validateOpenPositionParams({
  side,
  collateralUsd,
  leverage,
  market,
}) {
  if (!side || !["long", "short"].includes(String(side).toLowerCase())) {
    throw new Error('Invalid side: must be "long" or "short"');
  }

  const collateral = Number(collateralUsd);
  if (!Number.isFinite(collateral) || collateral <= 0) {
    throw new Error("Invalid collateralUsd: must be a positive number");
  }

  const lev = Number(leverage);
  if (!Number.isFinite(lev) || lev < 1 || lev > 100) {
    throw new Error("Invalid leverage: must be between 1 and 100");
  }

  if (!market || typeof market !== "string") {
    throw new Error("Invalid market: must be a non-empty string");
  }
}

/**
 * Validate close position parameters
 * @param {Object} params
 * @throws {Error} If validation fails
 */
function validateClosePositionParams({ market }) {
  if (!market || typeof market !== "string") {
    throw new Error("Invalid market: must be a non-empty string");
  }
}

/**
 * Generate a unique client order ID
 * @param {string} prefix - Optional prefix
 * @returns {string} Unique order ID
 */
function generateClientOrderId(prefix = "manual") {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

module.exports = {
  buildOpenPositionRequest,
  buildClosePositionRequest,
  normalizeTxPayload,
  validateOpenPositionParams,
  validateClosePositionParams,
  generateClientOrderId,
};

