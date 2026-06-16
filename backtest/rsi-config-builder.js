/**
 * RSI Strategy Config Builder
 * 
 * Extracts duplicated per-market config parsing logic into a reusable module.
 * This eliminates ~200 lines of duplicated code across:
 * - runBacktestForSymbol()
 * - main() multi-market loop
 * - runTraceForModel()
 * - runRobustnessResim()
 */

/**
 * Check if an environment variable has a value set
 * @param {string|undefined} v
 * @returns {boolean}
 */
function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Parse a number from env, returning fallback if invalid
 * @param {string|undefined} v
 * @param {number} fallback
 * @returns {number}
 */
function parseEnvNum(v, fallback) {
  if (!hasValue(v)) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse an integer from env, returning fallback if invalid
 * @param {string|undefined} v
 * @param {number} fallback
 * @returns {number}
 */
function parseEnvInt(v, fallback) {
  if (!hasValue(v)) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse a boolean from env, returning fallback if not set
 * @param {string|undefined} v
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseEnvBool(v, fallback) {
  if (!hasValue(v)) return fallback;
  return v === 'true' || v === '1';
}

/**
 * Build per-market configuration by reading env variables and applying overrides
 * 
 * @param {string} symbol - Market symbol (e.g., 'SOL', 'BTC')
 * @param {Object} globalOptions - Global options object with defaults
 * @param {Object} [cliOverrides] - Optional CLI overrides (e.g., cliMarketLeverage map)
 * @returns {Object} Per-market config with all resolved values
 */
function buildMarketConfig(symbol, globalOptions, cliOverrides = {}) {
  const marketKey = `${symbol}_PERP`.toUpperCase();
  
  // Read all per-market env variables
  const env = {
    overboughtExtreme: process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_EXTREME`],
    overboughtRecovery: process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_RECOVERY`],
    oversoldExtreme: process.env[`STRATEGY_${marketKey}_RSI_OVERSOLD_EXTREME`],
    oversoldRecovery: process.env[`STRATEGY_${marketKey}_RSI_OVERSOLD_RECOVERY`],
    leverage: process.env[`STRATEGY_${marketKey}_LEVERAGE`],
    hardStopPercent: process.env[`STRATEGY_${marketKey}_HARD_STOP_PERCENT`],
    hardStopAtr: process.env[`STRATEGY_${marketKey}_HARD_STOP_ATR`],
    failureLong: process.env[`STRATEGY_${marketKey}_RSI_FAILURE_LONG`],
    failureShort: process.env[`STRATEGY_${marketKey}_RSI_FAILURE_SHORT`],
    targetLong: process.env[`STRATEGY_${marketKey}_RSI_TARGET_LONG`],
    targetShort: process.env[`STRATEGY_${marketKey}_RSI_TARGET_SHORT`],
    entryMaxBars: process.env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_BARS`],
    entryMaxDeviation: process.env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_DEVIATION`],
    minVolatilityPct: process.env[`STRATEGY_${marketKey}_MIN_VOLATILITY_PCT`],
    maxVolatilityPct: process.env[`STRATEGY_${marketKey}_MAX_VOLATILITY_PCT`],
    minAdx: process.env[`STRATEGY_${marketKey}_MIN_ADX`],
    maxAdx: process.env[`STRATEGY_${marketKey}_MAX_ADX`],
    atrPeriod: process.env[`STRATEGY_${marketKey}_ATR_PERIOD`],
    allowLongs: process.env[`STRATEGY_${marketKey}_ALLOW_LONGS`],
    allowShorts: process.env[`STRATEGY_${marketKey}_ALLOW_SHORTS`],
  };

  // Global defaults from env
  const globalMinVol = parseFloat(process.env.RSI_MIN_VOLATILITY_PCT || '0.2');
  const globalMaxVol = parseFloat(process.env.RSI_MAX_VOLATILITY_PCT || '5.0');
  const globalMinAdx = parseFloat(process.env.RSI_MIN_ADX || '0');
  const globalMaxAdx = parseFloat(process.env.RSI_MAX_ADX || '100');

  // Resolve values: CLI override > per-market env > global option
  const config = {
    symbol,
    marketKey,
    
    // RSI parameters
    overboughtExtreme: parseEnvNum(env.overboughtExtreme, globalOptions.rsiOverboughtExtreme),
    overboughtRecovery: parseEnvNum(env.overboughtRecovery, globalOptions.rsiOverboughtRecovery),
    oversoldExtreme: parseEnvNum(env.oversoldExtreme, globalOptions.rsiOversoldExtreme),
    oversoldRecovery: parseEnvNum(env.oversoldRecovery, globalOptions.rsiOversoldRecovery),
    
    // Leverage (CLI override takes precedence)
    leverage: cliOverrides.cliMarketLeverage?.get(symbol) 
      ?? parseEnvNum(env.leverage, globalOptions.leverage),
    
    // Stop loss
    hardStopPercent: parseEnvNum(env.hardStopPercent, globalOptions.rsiHardStopPercent),
    hardStopAtr: parseEnvNum(env.hardStopAtr, globalOptions.rsiHardStopAtr),
    
    // Failure exit levels
    failureLong: parseEnvNum(env.failureLong, globalOptions.rsiFailureLong),
    failureShort: parseEnvNum(env.failureShort, globalOptions.rsiFailureShort),
    
    // Target levels (priority: per-market > global target > neutral)
    targetLong: hasValue(env.targetLong) 
      ? parseFloat(env.targetLong) 
      : (globalOptions.rsiTargetLong > 0 ? globalOptions.rsiTargetLong : globalOptions.rsiTargetNeutral),
    targetShort: hasValue(env.targetShort)
      ? parseFloat(env.targetShort)
      : (globalOptions.rsiTargetShort > 0 ? globalOptions.rsiTargetShort : globalOptions.rsiTargetNeutral),
    
    // Entry timing
    entryMaxBars: parseEnvInt(env.entryMaxBars, globalOptions.rsiEntryMaxBars),
    entryMaxDeviation: parseEnvNum(env.entryMaxDeviation, globalOptions.rsiEntryMaxDeviation),
    
    // Volatility filter
    minVolatilityPct: parseEnvNum(env.minVolatilityPct, globalMinVol),
    maxVolatilityPct: parseEnvNum(env.maxVolatilityPct, globalMaxVol),
    
    // ADX filter
    minAdx: parseEnvNum(env.minAdx, globalMinAdx),
    maxAdx: parseEnvNum(env.maxAdx, globalMaxAdx),
    
    // ATR period
    atrPeriod: parseEnvInt(env.atrPeriod, globalOptions.atrPeriod),
    
    // Direction gates
    allowLongs: parseEnvBool(env.allowLongs, globalOptions.allowLongs),
    allowShorts: parseEnvBool(env.allowShorts, globalOptions.allowShorts),
    
    // Track which settings were overridden
    hasOverrides: !!(
      env.overboughtExtreme || env.overboughtRecovery || 
      env.leverage || env.hardStopPercent || env.hardStopAtr ||
      env.failureLong || env.failureShort ||
      env.allowLongs || env.allowShorts
    ),
  };

  return config;
}

/**
 * Build strategy configuration object from market config
 * 
 * @param {Object} marketConfig - Result from buildMarketConfig()
 * @param {Object} globalOptions - Global options object
 * @returns {Object} Strategy configuration for RsiMeanReversionStrategy
 */
function buildStrategyConfig(marketConfig, globalOptions) {
  return {
    market: `${marketConfig.symbol}-PERP`,
    quiet: !globalOptions.verbose,
    rsiStrategy: {
      rsiPeriod: globalOptions.rsiPeriod,
      rsiUseSma: globalOptions.rsiUseSma,
      rsiOversoldExtreme: marketConfig.oversoldExtreme,
      rsiOversoldRecovery: marketConfig.oversoldRecovery,
      rsiOverboughtExtreme: marketConfig.overboughtExtreme,
      rsiOverboughtRecovery: marketConfig.overboughtRecovery,
      rsiEntryMaxDeviation: marketConfig.entryMaxDeviation,
      rsiEntryMaxBars: marketConfig.entryMaxBars,
      rsiTargetNeutral: globalOptions.rsiTargetNeutral,
      rsiTargetLong: marketConfig.targetLong,
      rsiTargetShort: marketConfig.targetShort,
      rsiPartialTargetLong: globalOptions.rsiPartialTargetLong,
      rsiPartialTargetShort: globalOptions.rsiPartialTargetShort,
      rsiPartialPercent: globalOptions.rsiPartialPercent,
      rsiFailureLong: marketConfig.failureLong,
      rsiFailureShort: marketConfig.failureShort,
      rsiTimeStopBars: globalOptions.rsiTimeStopBars,
      rsiHardStopEnabled: globalOptions.rsiHardStopEnabled,
      rsiHardStopAtr: marketConfig.hardStopAtr,
      rsiHardStopPercent: marketConfig.hardStopPercent,
      atrPeriod: marketConfig.atrPeriod,
      rsiMinVolatilityPct: marketConfig.minVolatilityPct,
      rsiMaxVolatilityPct: marketConfig.maxVolatilityPct,
      rsiMinAdx: marketConfig.minAdx,
      rsiMaxAdx: marketConfig.maxAdx,
    },
    maxConsecutiveLosses: globalOptions.circuitBreakerMaxLosses,
    circuitBreakerCooldownMs: globalOptions.circuitBreakerCooldownMs,
  };
}

/**
 * Build all market configs for a list of symbols
 * 
 * @param {string[]} symbols - Array of market symbols
 * @param {Object} globalOptions - Global options
 * @param {Object} [cliOverrides] - Optional CLI overrides
 * @returns {Object} Object containing Maps for all per-market settings
 */
function buildAllMarketConfigs(symbols, globalOptions, cliOverrides = {}) {
  const configs = new Map();
  const perMarketLeverage = new Map();
  const perMarketHardStop = new Map();
  const perMarketHardStopAtr = new Map();
  const perMarketAllowLongs = new Map();
  const perMarketAllowShorts = new Map();
  const strategyConfigs = new Map();

  for (const symbol of symbols) {
    const marketConfig = buildMarketConfig(symbol, globalOptions, cliOverrides);
    configs.set(symbol, marketConfig);
    
    // Populate per-market maps
    perMarketLeverage.set(symbol, marketConfig.leverage);
    perMarketHardStop.set(symbol, marketConfig.hardStopPercent);
    perMarketHardStopAtr.set(symbol, marketConfig.hardStopAtr);
    perMarketAllowLongs.set(symbol, marketConfig.allowLongs);
    perMarketAllowShorts.set(symbol, marketConfig.allowShorts);
    
    // Build strategy config
    strategyConfigs.set(symbol, buildStrategyConfig(marketConfig, globalOptions));
  }

  return {
    configs,
    perMarketLeverage,
    perMarketHardStop,
    perMarketHardStopAtr,
    perMarketAllowLongs,
    perMarketAllowShorts,
    strategyConfigs,
  };
}

/**
 * Log per-market overrides summary
 * 
 * @param {Map} configs - Map of symbol -> marketConfig
 * @param {Object} globalOptions - Global options for comparison
 */
function logMarketOverrides(configs, globalOptions) {
  for (const [symbol, config] of configs.entries()) {
    if (config.hasOverrides) {
      const dirsLabel = (config.allowLongs !== globalOptions.allowLongs || config.allowShorts !== globalOptions.allowShorts)
        ? `, dirs=${config.allowLongs ? 'L' : '-'}${config.allowShorts ? 'S' : '-'}`
        : '';
      console.log(`   [${symbol}] RSI: overbought=${config.overboughtExtreme}→${config.overboughtRecovery}, leverage=${config.leverage}x, hardStop=${config.hardStopPercent}%/ATR=${config.hardStopAtr}x, failure=${config.failureLong}/${config.failureShort}${dirsLabel}`);
    }
    console.log(`   [${symbol}] Entry timing: maxBars=${config.entryMaxBars}, maxDeviation=${config.entryMaxDeviation}, atrPeriod=${config.atrPeriod}`);
  }
}

/**
 * Apply RSI overrides to an existing strategy config
 * Used for robustness testing and parameter sweeps
 * 
 * @param {Object} baseConfig - Base strategy config
 * @param {Object} overrides - Overrides to apply
 * @returns {Object} New config with overrides applied
 */
function withRsiOverrides(baseConfig, overrides) {
  const newConfig = JSON.parse(JSON.stringify(baseConfig)); // Deep clone
  
  if (overrides.rsiFailureLong !== undefined) {
    newConfig.rsiStrategy.rsiFailureLong = overrides.rsiFailureLong;
  }
  if (overrides.rsiFailureShort !== undefined) {
    newConfig.rsiStrategy.rsiFailureShort = overrides.rsiFailureShort;
  }
  if (overrides.rsiTargetLong !== undefined) {
    newConfig.rsiStrategy.rsiTargetLong = overrides.rsiTargetLong;
  }
  if (overrides.rsiTargetShort !== undefined) {
    newConfig.rsiStrategy.rsiTargetShort = overrides.rsiTargetShort;
  }
  if (overrides.rsiHardStopAtr !== undefined) {
    newConfig.rsiStrategy.rsiHardStopAtr = overrides.rsiHardStopAtr;
  }
  if (overrides.rsiHardStopPercent !== undefined) {
    newConfig.rsiStrategy.rsiHardStopPercent = overrides.rsiHardStopPercent;
  }
  if (overrides.rsiOverboughtExtreme !== undefined) {
    newConfig.rsiStrategy.rsiOverboughtExtreme = overrides.rsiOverboughtExtreme;
  }
  if (overrides.rsiOversoldExtreme !== undefined) {
    newConfig.rsiStrategy.rsiOversoldExtreme = overrides.rsiOversoldExtreme;
  }
  
  return newConfig;
}

module.exports = {
  hasValue,
  parseEnvNum,
  parseEnvInt,
  parseEnvBool,
  buildMarketConfig,
  buildStrategyConfig,
  buildAllMarketConfigs,
  logMarketOverrides,
  withRsiOverrides,
};

