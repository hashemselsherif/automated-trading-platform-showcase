/**
 * Drift Structured Logger
 * 
 * Provides consistent, structured JSON logging for Drift operations.
 * Includes correlation IDs for request tracing and parsed error codes.
 */

const crypto = require('crypto');
const { classifyError, parseDriftErrorCode, parseDriftErrorName } = require('./drift-error-classifier');

/**
 * Generate a short correlation ID for request tracing
 * @returns {string} 8-character hex correlation ID
 */
function generateCorrelationId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Create a correlation context for a trading operation
 * @param {Object} params - Operation parameters
 * @returns {Object} Correlation context
 */
function createCorrelationContext(params = {}) {
  return {
    correlationId: generateCorrelationId(),
    timestamp: new Date().toISOString(),
    market: params.market || params.marketSymbol || null,
    marketIndex: params.marketIndex ?? null,
    side: params.side || null,
    userOrderId: params.userOrderId ?? null,
    clientOrderId: params.clientOrderId || null,
    subaccount: params.subaccount ?? null,
  };
}

/**
 * Format error for structured logging
 * @param {Error|string} error - Error to format
 * @returns {Object} Structured error object
 */
function formatError(error) {
  const classified = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);
  
  return {
    message,
    kind: classified.kind,
    driftCode: classified.driftCode,
    driftErrorName: classified.driftErrorName,
    rpcCode: classified.rpcCode,
    isRateLimit: classified.isRateLimit,
    isTimeout: classified.isTimeout,
    isBlockhash: classified.isBlockhash,
    retriable: classified.retriable,
    action: classified.action,
  };
}

/**
 * Log a structured event
 * @param {string} event - Event name (e.g., 'order:place', 'position:open')
 * @param {Object} payload - Event payload
 * @param {Object} options - Logging options
 */
function logEvent(event, payload = {}, options = {}) {
  const { correlationId, isError = false, logger = console } = options;
  
  const logEntry = {
    ts: new Date().toISOString(),
    ev: event,
    ...payload,
  };
  
  if (correlationId) {
    logEntry.cid = correlationId;
  }
  
  // Add error details if this is an error event
  if (isError && payload.error) {
    const errorDetails = formatError(payload.error);
    logEntry.err = errorDetails;
    delete logEntry.error; // Remove raw error, use structured err instead
  }
  
  const logFn = isError ? (logger.error || logger.log) : logger.log;
  logFn.call(logger, JSON.stringify(logEntry));
}

/**
 * Create a logger with bound correlation context
 * @param {Object} context - Correlation context
 * @param {Object} logger - Base logger (default: console)
 * @returns {Object} Logger with bound context
 */
function createContextualLogger(context = {}, logger = console) {
  const correlationId = context.correlationId || generateCorrelationId();
  const baseContext = {
    market: context.market || null,
    marketIndex: context.marketIndex ?? null,
    side: context.side || null,
  };
  
  return {
    correlationId,
    
    log: (event, payload = {}) => {
      logEvent(event, { ...baseContext, ...payload }, { correlationId, logger });
    },
    
    error: (event, payload = {}) => {
      logEvent(event, { ...baseContext, ...payload }, { correlationId, isError: true, logger });
    },
    
    // Log order-related events
    orderPlaced: (orderDetails) => {
      logEvent('order:placed', { ...baseContext, ...orderDetails }, { correlationId, logger });
    },
    
    orderFilled: (orderDetails) => {
      logEvent('order:filled', { ...baseContext, ...orderDetails }, { correlationId, logger });
    },
    
    orderCancelled: (orderDetails) => {
      logEvent('order:cancelled', { ...baseContext, ...orderDetails }, { correlationId, logger });
    },
    
    orderFailed: (orderDetails, error) => {
      logEvent('order:failed', { ...baseContext, ...orderDetails, error }, { correlationId, isError: true, logger });
    },
    
    // Log position-related events
    positionOpened: (positionDetails) => {
      logEvent('position:opened', { ...baseContext, ...positionDetails }, { correlationId, logger });
    },
    
    positionClosed: (positionDetails) => {
      logEvent('position:closed', { ...baseContext, ...positionDetails }, { correlationId, logger });
    },
    
    positionAdopted: (positionDetails) => {
      logEvent('position:adopted', { ...baseContext, ...positionDetails }, { correlationId, logger });
    },
    
    // Log IPC/subprocess events
    ipcSent: (action, params) => {
      logEvent('ipc:sent', { action, params: sanitizeParams(params) }, { correlationId, logger });
    },
    
    ipcReceived: (action, success, data) => {
      logEvent('ipc:received', { action, success, data: summarizeData(data) }, { correlationId, logger });
    },
    
    ipcError: (action, error) => {
      logEvent('ipc:error', { action, error }, { correlationId, isError: true, logger });
    },
  };
}

/**
 * Sanitize params for logging (remove sensitive data)
 * @param {Object} params - Parameters to sanitize
 * @returns {Object} Sanitized parameters
 */
function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return params;
  
  const sanitized = { ...params };
  
  // Remove sensitive fields
  const sensitiveFields = ['privateKey', 'secretKey', 'password', 'apiKey', 'apiSecret'];
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  }
  
  return sanitized;
}

/**
 * Summarize data for logging (prevent huge payloads)
 * @param {any} data - Data to summarize
 * @param {number} maxLength - Maximum string length
 * @returns {any} Summarized data
 */
function summarizeData(data, maxLength = 500) {
  if (data === null || data === undefined) return data;
  
  if (typeof data === 'string') {
    return data.length > maxLength ? data.slice(0, maxLength) + '...' : data;
  }
  
  if (Array.isArray(data)) {
    return { count: data.length, sample: data.slice(0, 3) };
  }
  
  if (typeof data === 'object') {
    const summary = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.length > maxLength) {
        summary[key] = value.slice(0, maxLength) + '...';
      } else if (Array.isArray(value)) {
        summary[key] = { count: value.length };
      } else {
        summary[key] = value;
      }
    }
    return summary;
  }
  
  return data;
}

/**
 * Log entry format for subprocess (writes to stderr to not interfere with IPC)
 * @param {string} event - Event name
 * @param {Object} payload - Event payload
 * @param {string} correlationId - Optional correlation ID
 */
function subprocessLog(event, payload = {}, correlationId = null) {
  const entry = {
    ts: new Date().toISOString(),
    ev: event,
    ...payload,
  };
  
  if (correlationId) {
    entry.cid = correlationId;
  }
  
  console.error(JSON.stringify(entry));
}

module.exports = {
  generateCorrelationId,
  createCorrelationContext,
  formatError,
  logEvent,
  createContextualLogger,
  sanitizeParams,
  summarizeData,
  subprocessLog,
};
