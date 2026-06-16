// Input validation and sanitization utilities

/**
 * Validate and sanitize string input
 */
function validateString(input, options = {}) {
  if (input === null || input === undefined) {
    return options.optional ? null : null;
  }

  if (typeof input !== 'string') {
    throw new Error(`Expected string, got ${typeof input}`);
  }

  const trimmed = input.trim();
  const { minLength = 0, maxLength = Infinity, pattern } = options;

  if (trimmed.length < minLength) {
    throw new Error(`String must be at least ${minLength} characters`);
  }

  if (trimmed.length > maxLength) {
    throw new Error(`String must be at most ${maxLength} characters`);
  }

  if (pattern && !pattern.test(trimmed)) {
    throw new Error('String does not match required pattern');
  }

  return trimmed;
}

/**
 * Validate numeric input with bounds
 */
function validateNumber(input, options = {}) {
  if (input === null || input === undefined) {
    return options.optional ? null : null;
  }

  const num = Number(input);

  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`Expected valid number, got ${input}`);
  }

  const { min, max, integer = false } = options;

  if (integer && !Number.isInteger(num)) {
    throw new Error(`Expected integer, got ${num}`);
  }

  if (min !== undefined && num < min) {
    throw new Error(`Number must be at least ${min}, got ${num}`);
  }

  if (max !== undefined && num > max) {
    throw new Error(`Number must be at most ${max}, got ${num}`);
  }

  return integer ? Math.floor(num) : num;
}

/**
 * Validate transaction parameters
 * NOTE: This is for transaction params only (side, collateral, leverage as number, price)
 * NOT for config objects (which have nested risk, leverage as object, etc)
 */
function validateTransactionParams(params) {
  // Skip validation if this looks like a config object
  if (params && typeof params === 'object') {
    // Check if it's a config object (has risk, or leverage as object, or config-like structure)
    if (params.risk || 
        (params.leverage && typeof params.leverage === 'object' && !Array.isArray(params.leverage)) ||
        params.paperTradingMode !== undefined ||
        params.executionMode !== undefined ||
        params.botLoopMs !== undefined ||
        params.dailyTradeLimit !== undefined ||
        params.paperBalance !== undefined ||
        // Check if it's a leverage object itself (has leverage config fields)
        (params.dynamic !== undefined || params.baseLeverage !== undefined || 
         params.minLeverage !== undefined || params.maxLeverage !== undefined ||
         params.volatilityAdjustment !== undefined || params.adxAdjustment !== undefined)) {
      // This is a config object, not transaction params - skip validation
      return true;
    }
  }
  
  const errors = [];

  // Validate side
  if (params.side && !['long', 'short'].includes(params.side.toLowerCase())) {
    errors.push('Side must be "long" or "short"');
  }

  // Validate collateral
  if (params.collateral !== undefined) {
    try {
      validateNumber(params.collateral, { min: 0, max: 1000000 });
    } catch (e) {
      errors.push(`Invalid collateral: ${e.message}`);
    }
  }

  // Validate leverage (only if it's a number, not an object)
  if (params.leverage !== undefined && typeof params.leverage === 'number') {
    try {
      validateNumber(params.leverage, { min: 1, max: 100, integer: false });
    } catch (e) {
      errors.push(`Invalid leverage: ${e.message}`);
    }
  }

  // Validate price
  if (params.price !== undefined) {
    try {
      validateNumber(params.price, { min: 0 });
    } catch (e) {
      errors.push(`Invalid price: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Validation errors: ${errors.join('; ')}`);
  }

  return true;
}

/**
 * Sanitize Telegram callback data
 */
function sanitizeTelegramCallback(data) {
  if (!data || typeof data !== 'string') {
    return null;
  }

  // Only allow alphanumeric, dashes, underscores, and colons
  const sanitized = data.replace(/[^a-zA-Z0-9:_-]/g, '');
  
  // Validate format: APPROVAL:<id>:yes|no
  const parts = sanitized.split(':');
  if (parts.length === 3 && parts[0] === 'APPROVAL') {
    const [, id, decision] = parts;
    if (id.length <= 50 && (decision === 'yes' || decision === 'no')) {
      return sanitized;
    }
  }

  return null;
}

/**
 * Validate WebSocket message structure
 */
function validateWebSocketMessage(data) {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    
    if (!parsed || typeof parsed !== 'object') {
      return { valid: false, error: 'Message must be an object' };
    }

    if (!parsed.ev || typeof parsed.ev !== 'string') {
      return { valid: false, error: 'Message must have "ev" field' };
    }

    // Validate event types
    const allowedEvents = ['price', 'status', 'signal', 'open', 'close', 'activity', 'log', 'decision', 'config'];
    if (!allowedEvents.includes(parsed.ev)) {
      return { valid: false, error: `Unknown event type: ${parsed.ev}` };
    }

    // Validate data structure
    if (parsed.data && typeof parsed.data !== 'object') {
      return { valid: false, error: 'Message data must be an object' };
    }

    // Size limit check (prevent DoS)
    const messageSize = JSON.stringify(parsed).length;
    if (messageSize > 1024 * 1024) { // 1MB limit
      return { valid: false, error: 'Message too large' };
    }

    return { valid: true, message: parsed };
  } catch (e) {
    return { valid: false, error: `Invalid JSON: ${e.message}` };
  }
}

module.exports = {
  validateString,
  validateNumber,
  validateTransactionParams,
  sanitizeTelegramCallback,
  validateWebSocketMessage,
};

