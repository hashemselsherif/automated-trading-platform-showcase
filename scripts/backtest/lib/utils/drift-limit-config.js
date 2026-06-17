/**
 * Drift Limit Order Policy Configuration
 * 
 * Parses environment variables for limit order policy with precedence:
 * per-market > per-strategy > global
 * 
 * Naming convention:
 * - Global: DRIFT_LIMIT_*
 * - Per-strategy: DRIFT_LIMIT_<STRATEGYKEY>_* (e.g., DRIFT_LIMIT_RSI_REVERSION_ALTS_*)
 * - Per-market: DRIFT_LIMIT_<MARKETKEY>_* (e.g., DRIFT_LIMIT_JTO_PERP_*)
 */

const { DEFAULT_POLICY } = require('../simulation/limit-order-policy');

/**
 * Environment variable to policy key mapping
 */
const ENV_KEY_MAP = {
  // Price selection
  'REF_PRICE': { key: 'refPriceSource', type: 'string', values: ['mid', 'mark', 'oracle', 'last'] },
  'ENTRY_BPS': { key: 'entryOffsetBps', type: 'number' },
  'EXIT_BPS': { key: 'exitOffsetBps', type: 'number' },
  'POST_ONLY': { key: 'postOnly', type: 'boolean' },
  
  // Lifecycle
  'ENTRY_TIMEOUT_MS': { key: 'entryTimeoutMs', type: 'number' },
  'EXIT_TIMEOUT_MS': { key: 'exitTimeoutMs', type: 'number' },
  'OPEN_ORDER_APPEAR_MS': { key: 'openOrderAppearMs', type: 'number' },
  'REPLACE_EVERY_MS': { key: 'replaceEveryMs', type: 'number' },
  'MAX_REPLACES': { key: 'maxReplaces', type: 'number' },
  'CANCEL_IF_SIGNAL_INVALID': { key: 'cancelIfSignalInvalid', type: 'boolean' },
  'SIGNAL_GRACE_TICKS': { key: 'signalGraceTicks', type: 'number' },
  
  // Fallback to taker
  'FALLBACK_TO_TAKER': { key: 'fallbackToTaker', type: 'boolean' },
  'FALLBACK_AFTER_MS': { key: 'fallbackAfterMs', type: 'number' },
  'FALLBACK_CONFIRM_MS': { key: 'fallbackConfirmMs', type: 'number' },
  'FALLBACK_MIN_CONFIDENCE': { key: 'fallbackMinConfidence', type: 'number' },
  'FALLBACK_MAX_SLIPPAGE_BPS': { key: 'fallbackMaxSlippageBps', type: 'number' },
  
  // Partial fills
  'ALLOW_PARTIAL': { key: 'allowPartial', type: 'boolean' },
  'PARTIAL_MIN_FILL_PCT': { key: 'partialMinFillPct', type: 'number' },
  
  // Fill simulation (for backtesting)
  'FILL_PROBABILITY_MODEL': { key: 'fillProbabilityModel', type: 'string', values: ['exponential', 'linear', 'fixed'] },
  'BASE_FILL_PROBABILITY': { key: 'baseFillProbability', type: 'number' },
  'FILL_DECAY_PER_BPS': { key: 'fillDecayPerBps', type: 'number' },
  'VOLATILITY_FILL_BOOST': { key: 'volatilityFillBoost', type: 'number' },
};

/**
 * Parse a value based on type
 */
function parseValue(value, type, validValues = null) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  
  switch (type) {
    case 'number':
      const num = parseFloat(value);
      return isNaN(num) ? undefined : num;
      
    case 'boolean':
      const lower = String(value).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(lower)) return true;
      if (['false', '0', 'no', 'off'].includes(lower)) return false;
      return undefined;
      
    case 'string':
      const str = String(value);
      if (validValues && !validValues.includes(str)) {
        return undefined;
      }
      return str;
      
    default:
      return value;
  }
}

/**
 * Normalize market symbol for env key lookup
 * SOL-PERP → SOL_PERP
 */
function normalizeMarketKey(market) {
  return market.toUpperCase().replace(/-/g, '_');
}

/**
 * Normalize strategy name for env key lookup
 * rsi-reversion-alts → RSI_REVERSION_ALTS
 */
function normalizeStrategyKey(strategy) {
  return strategy.toUpperCase().replace(/-/g, '_');
}

/**
 * Get env value with prefix
 */
function getEnvValue(prefix, suffix, env = process.env) {
  const key = `${prefix}${suffix}`;
  return env[key];
}

/**
 * Parse limit order config from environment
 * @param {Object} options - Parse options
 * @param {string} options.market - Market symbol (e.g., 'JTO-PERP')
 * @param {string} options.strategy - Strategy name (e.g., 'rsi-reversion-alts')
 * @param {Object} options.env - Environment object (defaults to process.env)
 * @param {Object} options.defaults - Default values (defaults to DEFAULT_POLICY)
 * @returns {Object} Merged policy configuration
 */
function parseLimitOrderConfig(options = {}) {
  const {
    market = null,
    strategy = null,
    env = process.env,
    defaults = DEFAULT_POLICY,
  } = options;

  const config = { ...defaults };
  
  // Build prefixes in order of precedence (lowest to highest)
  const prefixes = ['DRIFT_LIMIT_'];
  
  if (strategy) {
    prefixes.push(`DRIFT_LIMIT_${normalizeStrategyKey(strategy)}_`);
  }
  
  if (market) {
    prefixes.push(`DRIFT_LIMIT_${normalizeMarketKey(market)}_`);
  }
  
  // Process each env key mapping
  for (const [envSuffix, mapping] of Object.entries(ENV_KEY_MAP)) {
    // Check each prefix in order (later = higher priority)
    for (const prefix of prefixes) {
      const value = getEnvValue(prefix, envSuffix, env);
      const parsed = parseValue(value, mapping.type, mapping.values);
      
      if (parsed !== undefined) {
        config[mapping.key] = parsed;
      }
    }
  }
  
  return config;
}

/**
 * Get all configured limits as a debug summary
 */
function getConfigSummary(options = {}) {
  const config = parseLimitOrderConfig(options);
  
  return {
    market: options.market || 'global',
    strategy: options.strategy || 'default',
    priceSelection: {
      refPriceSource: config.refPriceSource,
      entryOffsetBps: config.entryOffsetBps,
      exitOffsetBps: config.exitOffsetBps,
      postOnly: config.postOnly,
    },
    lifecycle: {
      entryTimeoutMs: config.entryTimeoutMs,
      exitTimeoutMs: config.exitTimeoutMs,
      replaceEveryMs: config.replaceEveryMs,
      maxReplaces: config.maxReplaces,
    },
    fallback: {
      enabled: config.fallbackToTaker,
      afterMs: config.fallbackAfterMs,
      minConfidence: config.fallbackMinConfidence,
      maxSlippageBps: config.fallbackMaxSlippageBps,
    },
    simulation: {
      fillModel: config.fillProbabilityModel,
      baseProbability: config.baseFillProbability,
      decayPerBps: config.fillDecayPerBps,
    },
  };
}

/**
 * Validate config and return warnings
 */
function validateConfig(config) {
  const warnings = [];
  
  if (config.entryOffsetBps < 0) {
    warnings.push('entryOffsetBps should be positive');
  }
  
  if (config.entryOffsetBps > 100) {
    warnings.push('entryOffsetBps > 100bps may result in poor fills');
  }
  
  if (config.maxReplaces > 10) {
    warnings.push('maxReplaces > 10 may cause excessive order churn');
  }
  
  if (config.fallbackToTaker && config.fallbackAfterMs < config.entryTimeoutMs) {
    warnings.push('fallbackAfterMs should be less than entryTimeoutMs');
  }
  
  if (config.baseFillProbability < 0 || config.baseFillProbability > 1) {
    warnings.push('baseFillProbability should be between 0 and 1');
  }
  
  return {
    valid: warnings.length === 0,
    warnings,
  };
}

module.exports = {
  ENV_KEY_MAP,
  parseLimitOrderConfig,
  getConfigSummary,
  validateConfig,
  normalizeMarketKey,
  normalizeStrategyKey,
};
