/**
 * Drift Error Classifier
 * 
 * Parses and classifies Drift protocol errors to determine:
 * - Whether errors are retriable
 * - What action to take (retry, abort, reconcile)
 * - Specific error codes for targeted handling
 * 
 * Error codes reference: https://docs.drift.trade/
 * Anchor error codes are 6000+
 */

// Known Drift error codes (Anchor program errors)
const DRIFT_ERROR_CODES = {
  // Non-retriable errors
  6003: { name: 'InsufficientCollateral', retriable: false, action: 'lock_collateral' },
  6078: { name: 'PerpMarketNotFound', retriable: false, action: 'disable_market' },
  6057: { name: 'PlacePostOnlyLimitFailure', retriable: true, action: 'widen_offset_or_fallback' },
  6058: { name: 'UserMaxOpenOrders', retriable: false, action: 'cancel_oldest_order' },
  6009: { name: 'UserHasNoPosition', retriable: false, action: 'skip' },
  6001: { name: 'InvalidOraclePrice', retriable: true, action: 'wait_and_retry' },
  6002: { name: 'InvalidMarkPrice', retriable: true, action: 'wait_and_retry' },
  6011: { name: 'OracleNotFound', retriable: false, action: 'disable_market' },
  6010: { name: 'OracleTooStale', retriable: true, action: 'wait_and_retry' },
  6012: { name: 'OracleTooVolatile', retriable: true, action: 'wait_and_retry' },
  6004: { name: 'SufficientCollateral', retriable: false, action: 'skip' },
  6005: { name: 'UnableToLoadAccount', retriable: true, action: 'reconnect' },
  6059: { name: 'OrderDoesNotExist', retriable: false, action: 'skip' },
  6060: { name: 'OrderNotOpen', retriable: false, action: 'skip' },
  
  // Position-related errors
  6006: { name: 'PositionAlreadyOpen', retriable: false, action: 'skip_duplicate' },
  6007: { name: 'MaxNumberOfPositions', retriable: false, action: 'close_position_first' },
  6008: { name: 'InvalidOrderDirection', retriable: false, action: 'abort' },
  
  // Market errors
  6070: { name: 'MarketWrongMutability', retriable: false, action: 'abort' },
  6071: { name: 'MarketStatusInvalid', retriable: false, action: 'disable_market' }, // Often indicates market delisted
  6072: { name: 'MarketPaused', retriable: false, action: 'wait_and_retry' },
  6073: { name: 'MarketReduceOnly', retriable: false, action: 'reduce_only' },
  6074: { name: 'MarketNotActive', retriable: false, action: 'disable_market' },
  6075: { name: 'MarketNotInitialized', retriable: false, action: 'disable_market' },
  6076: { name: 'InvalidMarketType', retriable: false, action: 'disable_market' },
  6077: { name: 'InvalidMarketIndex', retriable: false, action: 'disable_market' },
};

// RPC/Network error patterns
const RPC_ERROR_PATTERNS = [
  // Drift SDK/subprocess readiness failures (missing accountSubscriber data)
  // These are usually transient and should be retried with backoff.
  {
    pattern: /market data not ready|dataAndSlot|Cannot read properties of undefined \\(reading 'data'\\)|Cannot read properties of undefined \\(reading 'dataAndSlot'\\)/i,
    type: 'market_data_not_ready',
    retriable: true,
    action: 'wait_and_retry',
  },
  { pattern: /429|Too Many Requests|rate limit/i, type: 'rate_limit', retriable: true, action: 'backoff_and_rotate' },
  { pattern: /timeout|timed out/i, type: 'timeout', retriable: true, action: 'unknown_reconcile' },
  { pattern: /blockhash not found|expired blockhash|Transaction expired|Blockhash not found/i, type: 'blockhash', retriable: true, action: 'refresh_blockhash' },
  { pattern: /503|502|Service Unavailable|Bad Gateway/i, type: 'service_unavailable', retriable: true, action: 'backoff_and_rotate' },
  { pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/i, type: 'network', retriable: true, action: 'backoff_and_rotate' },
  { pattern: /insufficient funds|InsufficientFundsForRent/i, type: 'insufficient_sol', retriable: false, action: 'abort' },
];

/**
 * Error classification result
 * @typedef {Object} ClassifiedError
 * @property {string} kind - Error category: 'drift', 'rpc', 'timeout', 'unknown'
 * @property {number|null} driftCode - Drift error code if applicable
 * @property {string|null} driftErrorName - Human-readable Drift error name
 * @property {string|null} rpcCode - RPC error type if applicable
 * @property {boolean} isRateLimit - True if error is a rate limit
 * @property {boolean} isTimeout - True if error is a timeout
 * @property {boolean} isBlockhash - True if error is blockhash-related
 * @property {boolean} retriable - Whether the operation can be retried
 * @property {string} action - Recommended action to take
 * @property {string} raw - Original error message
 */

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
  
  // Pattern: "Program log: AnchorError: XXX" in tx logs
  const anchorMatch = message.match(/AnchorError[^0-9]*(\d+)/);
  if (anchorMatch) return parseInt(anchorMatch[1], 10);
  
  return null;
}

/**
 * Parse Drift error name from message
 * @param {string} message - Error message
 * @returns {string|null} Error name or null
 */
function parseDriftErrorName(message) {
  if (!message) return null;
  
  // Pattern: "AnchorError: ErrorName" or "Error Message: ErrorName"
  const nameMatch = message.match(/(?:AnchorError|Error Message)[:\s]+([A-Za-z]+)/i);
  if (nameMatch) return nameMatch[1];
  
  // Check for known error names directly in message
  for (const [code, info] of Object.entries(DRIFT_ERROR_CODES)) {
    if (message.includes(info.name)) {
      return info.name;
    }
  }
  
  return null;
}

/**
 * Classify an error from Drift operations
 * @param {Error|string} error - Error object or message
 * @returns {ClassifiedError} Classified error with recommended action
 */
function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const result = {
    kind: 'unknown',
    driftCode: null,
    driftErrorName: null,
    rpcCode: null,
    isRateLimit: false,
    isTimeout: false,
    isBlockhash: false,
    retriable: false,
    action: 'abort',
    raw: message,
  };
  
  // Try to parse Drift error code
  const driftCode = parseDriftErrorCode(message);
  if (driftCode !== null && DRIFT_ERROR_CODES[driftCode]) {
    const errorInfo = DRIFT_ERROR_CODES[driftCode];
    result.kind = 'drift';
    result.driftCode = driftCode;
    result.driftErrorName = errorInfo.name;
    result.retriable = errorInfo.retriable;
    result.action = errorInfo.action;
    return result;
  }
  
  // Also try to match by name if code wasn't found
  const errorName = parseDriftErrorName(message);
  if (errorName) {
    const codeEntry = Object.entries(DRIFT_ERROR_CODES).find(([_, info]) => info.name === errorName);
    if (codeEntry) {
      const [code, errorInfo] = codeEntry;
      result.kind = 'drift';
      result.driftCode = parseInt(code, 10);
      result.driftErrorName = errorInfo.name;
      result.retriable = errorInfo.retriable;
      result.action = errorInfo.action;
      return result;
    }
  }
  
  // Check for RPC/network errors
  for (const { pattern, type, retriable, action } of RPC_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      result.kind = 'rpc';
      result.rpcCode = type;
      result.retriable = retriable;
      result.action = action;
      result.isRateLimit = type === 'rate_limit';
      result.isTimeout = type === 'timeout';
      result.isBlockhash = type === 'blockhash';
      return result;
    }
  }
  
  // Check for command timeout (from subprocess)
  if (/Command timeout/i.test(message)) {
    result.kind = 'timeout';
    result.isTimeout = true;
    result.retriable = false; // Don't retry blindly, reconcile first
    result.action = 'unknown_reconcile';
    return result;
  }
  
  return result;
}

/**
 * Check if error indicates insufficient collateral
 * @param {Error|string} error - Error to check
 * @returns {boolean}
 */
function isInsufficientCollateral(error) {
  const classified = classifyError(error);
  return classified.driftCode === 6003 || classified.driftErrorName === 'InsufficientCollateral';
}

/**
 * Check if error indicates market not found
 * @param {Error|string} error - Error to check
 * @returns {boolean}
 */
function isPerpMarketNotFound(error) {
  const classified = classifyError(error);
  return classified.driftCode === 6078 || classified.driftErrorName === 'PerpMarketNotFound';
}

/**
 * Check if error indicates post-only failure
 * @param {Error|string} error - Error to check
 * @returns {boolean}
 */
function isPostOnlyFailure(error) {
  const classified = classifyError(error);
  return classified.driftCode === 6057 || classified.driftErrorName === 'PlacePostOnlyLimitFailure';
}

/**
 * Check if error is rate limit related
 * @param {Error|string} error - Error to check
 * @returns {boolean}
 */
function isRateLimitError(error) {
  const classified = classifyError(error);
  return classified.isRateLimit;
}

/**
 * Check if error is timeout related
 * @param {Error|string} error - Error to check
 * @returns {boolean}
 */
function isTimeoutError(error) {
  const classified = classifyError(error);
  return classified.isTimeout;
}

/**
 * Check if error is blockhash related
 * @param {Error|string} error - Error to check
 * @returns {boolean}
 */
function isBlockhashError(error) {
  const classified = classifyError(error);
  return classified.isBlockhash;
}

/**
 * Check if error indicates an invalid/non-existent market
 * Covers: PerpMarketNotFound (6078), InvalidMarketIndex (6077), MarketNotActive (6074), etc.
 * IMPORTANT: Simulation/blockhash errors are NOT invalid market errors!
 * @param {Error|string} error - Error to check
 * @returns {boolean}
 */
function isInvalidMarketError(error) {
  const classified = classifyError(error);
  const raw = classified.raw || '';
  
  // CRITICAL: Exclude simulation/blockhash errors - these are NOT invalid market errors
  // They are transient network issues that should be retried
  const isSimulationError = /Simulation failed|Blockhash not found|Transaction simulation failed/i.test(raw);
  if (isSimulationError) {
    return false;
  }
  
  const invalidMarketCodes = [6071, 6074, 6075, 6076, 6077, 6078];
  return invalidMarketCodes.includes(classified.driftCode) || 
         classified.action === 'disable_market' ||
         /market.*not.*found|invalid.*market|market.*not.*exist/i.test(raw);
}

/**
 * Get recommended retry delay based on error type
 * @param {ClassifiedError} classified - Classified error
 * @param {number} attempt - Attempt number (0-based)
 * @returns {number} Delay in milliseconds
 */
function getRetryDelay(classified, attempt = 0) {
  const baseDelay = 1000;
  const maxDelay = 30000;
  
  // Rate limits need longer delays
  if (classified.isRateLimit) {
    return Math.min(5000 * Math.pow(2, attempt), 60000);
  }
  
  // Timeouts should use moderate backoff
  if (classified.isTimeout) {
    return Math.min(2000 * Math.pow(2, attempt), maxDelay);
  }
  
  // Blockhash errors can retry quickly
  if (classified.isBlockhash) {
    return Math.min(500 * Math.pow(2, attempt), 5000);
  }
  
  // Default exponential backoff with jitter
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = Math.random() * 0.2 * delay;
  return Math.round(delay + jitter);
}

module.exports = {
  DRIFT_ERROR_CODES,
  classifyError,
  parseDriftErrorCode,
  parseDriftErrorName,
  isInsufficientCollateral,
  isPerpMarketNotFound,
  isInvalidMarketError,
  isPostOnlyFailure,
  isRateLimitError,
  isTimeoutError,
  isBlockhashError,
  getRetryDelay,
};
