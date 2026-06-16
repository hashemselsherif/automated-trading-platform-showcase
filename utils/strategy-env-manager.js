/**
 * Strategy Environment Manager
 * 
 * Provides isolated environment snapshots per strategy to prevent env bleeding
 * between .env.rsi-reversion (majors/Jupiter) and .env.rsi-reversion-alts (alts/Drift).
 * 
 * Each strategy has its own complete env snapshot. When processing a market,
 * use getEnvForMarket(market) to get the correct isolated config.
 * 
 * Usage:
 *   const strategyEnv = require('./utils/strategy-env-manager');
 *   
 *   // Get env for a specific market (returns isolated snapshot)
 *   const env = strategyEnv.getEnvForMarket('JTO-PERP');
 *   const execMode = env.EXEC_MODE;  // 'maker' from .env.rsi-reversion-alts
 *   
 *   // Get env for a specific strategy
 *   const altsEnv = strategyEnv.getEnvForStrategy('rsi-reversion-alt');
 *   
 *   // Get per-market config value with proper fallback chain
 *   const leverage = strategyEnv.getMarketConfig('JTO-PERP', 'LEVERAGE', 1);
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Strategy definitions with their env files and market ownership
const STRATEGY_DEFINITIONS = {
  'rsi-reversion': {
    envFile: '.env.rsi-reversion',
    // Markets managed by this strategy (majors on Jupiter)
    // Will be populated from STRATEGY_MARKETS in the env file
    markets: [],
    provider: 'jupiter',
  },
  'rsi-reversion-alt': {
    envFile: '.env.rsi-reversion-alts',
    // Markets managed by this strategy (alts on Drift)
    markets: [],
    provider: 'drift',
  },
  'momentum': {
    envFile: '.env.momentum',
    markets: [],
    provider: 'jupiter',
  },
  'scalping': {
    envFile: '.env.scalping',
    markets: [],
    provider: 'jupiter',
  },
  'predicta': {
    envFile: '.env.predicta',
    // Markets managed by this strategy (majors on Jupiter)
    // Will be populated from STRATEGY_MARKETS in the env file
    markets: [],
    provider: 'jupiter',
  },
  'btc-breakout': {
    envFile: '.env.btc-breakout',
    markets: [],
    provider: 'jupiter',
  },
  'ichimoku-cloud': {
    envFile: '.env.ichimoku',
    markets: [],
    provider: 'jupiter',
  },
  'copy-trading': {
    envFile: '.env.copy-trading',
    markets: [],
    provider: 'jupiter',
  },
};

const STRATEGY_ENABLE_DEFAULTS = {
  momentum: true,
  scalping: false,
  'rsi-reversion': false,
  'rsi-reversion-alt': false,
  predicta: false,
  'btc-breakout': false,
  'ichimoku-cloud': false,
  'copy-trading': false,
};

const STRATEGY_ENABLE_KEYS = {
  momentum: 'ENABLE_MOMENTUM_STRATEGY',
  scalping: 'ENABLE_SCALPING_STRATEGY',
  'rsi-reversion': 'ENABLE_RSI_REVERSION_STRATEGY',
  'rsi-reversion-alt': 'ENABLE_RSI_REVERSION_ALTS_STRATEGY',
  predicta: 'ENABLE_PREDICTA_STRATEGY',
  'btc-breakout': 'ENABLE_BTC_BREAKOUT_STRATEGY',
  'ichimoku-cloud': 'ENABLE_ICHIMOKU_STRATEGY',
  'copy-trading': 'ENABLE_COPY_TRADING_STRATEGY',
};

// Cached env snapshots per strategy
const envSnapshots = new Map();

// Market-to-strategies mapping cache (supports multiple strategies per market)
const marketToStrategies = new Map();
const warnedAmbiguousMarkets = new Set();

/**
 * Parse an env file into an object WITHOUT mutating process.env
 */
function parseEnvFile(envFile) {
  try {
    const envPath = path.join(process.cwd(), envFile);
    if (!fs.existsSync(envPath)) {
      console.warn(`[StrategyEnvManager] Env file not found: ${envFile}`);
      return null;
    }
    const raw = fs.readFileSync(envPath, 'utf8');
    return dotenv.parse(raw);
  } catch (e) {
    console.error(`[StrategyEnvManager] Error parsing ${envFile}: ${e.message}`);
    return null;
  }
}

/**
 * Parse market list from env value
 */
function parseMarketList(value) {
  if (!value) return [];
  return value.split(',')
    .map(m => m.trim().toUpperCase())
    .filter(m => m.length > 0)
    .map(m => m.includes('-PERP') ? m : `${m}-PERP`);
}

function parseEnvBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveEnabledStrategies(multiStrategyMode) {
  const enabled = new Set();

  if (multiStrategyMode) {
    for (const strategyId of Object.keys(STRATEGY_DEFINITIONS)) {
      const envKey = STRATEGY_ENABLE_KEYS[strategyId];
      const defaultValue = STRATEGY_ENABLE_DEFAULTS[strategyId] || false;
      if (envKey && parseEnvBoolean(process.env[envKey], defaultValue)) {
        enabled.add(strategyId);
      }
    }
  } else {
    let strategyType = process.env.STRATEGY_TYPE;
    if (!strategyType) {
      const momentumEnabled = parseEnvBoolean(process.env.ENABLE_MOMENTUM_STRATEGY, true);
      const scalpingEnabled = parseEnvBoolean(process.env.ENABLE_SCALPING_STRATEGY, false);
      const rsiEnabled = parseEnvBoolean(process.env.ENABLE_RSI_REVERSION_STRATEGY, false);
      const predictaEnabled = parseEnvBoolean(process.env.ENABLE_PREDICTA_STRATEGY, false);
      const btcBreakoutEnabled = parseEnvBoolean(
        process.env.ENABLE_BTC_BREAKOUT_STRATEGY,
        false
      );
      const copyEnabled = parseEnvBoolean(process.env.ENABLE_COPY_TRADING_STRATEGY, false);

      if (predictaEnabled && !momentumEnabled) {
        strategyType = 'predicta';
      } else if (
        btcBreakoutEnabled &&
        !momentumEnabled &&
        !scalpingEnabled &&
        !rsiEnabled &&
        !predictaEnabled
      ) {
        strategyType = 'btc-breakout';
      } else if (rsiEnabled && !momentumEnabled && !scalpingEnabled && !predictaEnabled) {
        strategyType = 'rsi-reversion';
      } else if (scalpingEnabled && !momentumEnabled && !rsiEnabled && !predictaEnabled) {
        strategyType = 'scalping';
      } else if (copyEnabled && !momentumEnabled && !rsiEnabled && !scalpingEnabled && !predictaEnabled) {
        strategyType = 'copy-trading';
      } else if (!momentumEnabled && btcBreakoutEnabled) {
        strategyType = 'btc-breakout';
      } else if (!momentumEnabled && rsiEnabled) {
        strategyType = 'rsi-reversion';
      } else if (!momentumEnabled && scalpingEnabled) {
        strategyType = 'scalping';
      } else {
        strategyType = 'momentum';
      }
    }

    if (strategyType && STRATEGY_DEFINITIONS[strategyType]) {
      enabled.add(strategyType);
    }
  }

  return enabled;
}

/**
 * Initialize all strategy env snapshots
 * Call this once at startup after base .env is loaded
 */
function initialize() {
  console.log('[StrategyEnvManager] Initializing strategy environment snapshots...');

  // First, load base .env into a snapshot (shared keys)
  const baseEnv = parseEnvFile('.env') || {};
  const multiStrategyMode = parseEnvBoolean(process.env.MULTI_STRATEGY_MODE, false);
  const enabledStrategies = resolveEnabledStrategies(multiStrategyMode);
  if (enabledStrategies.size > 0) {
    console.log(`[StrategyEnvManager] Enabled strategies: ${Array.from(enabledStrategies).join(', ')}`);
  } else if (multiStrategyMode) {
    console.warn('[StrategyEnvManager] No enabled strategies detected in MULTI_STRATEGY_MODE');
  }
  
  // Load each strategy's env file
  for (const [strategyId, def] of Object.entries(STRATEGY_DEFINITIONS)) {
    if (multiStrategyMode && !enabledStrategies.has(strategyId)) {
      continue;
    }
    if (!multiStrategyMode && enabledStrategies.size > 0 && !enabledStrategies.has(strategyId)) {
      continue;
    }
    const strategyEnv = parseEnvFile(def.envFile);
    
    if (!strategyEnv) {
      console.log(`[StrategyEnvManager] Skipping ${strategyId} (no env file)`);
      continue;
    }
    
    // Merge base env with strategy env (strategy takes precedence)
    const mergedEnv = { ...baseEnv, ...strategyEnv };
    
    // Store the snapshot
    envSnapshots.set(strategyId, mergedEnv);
    
    // Extract markets from this strategy
    const markets = parseMarketList(mergedEnv.STRATEGY_MARKETS || mergedEnv.MARKETS);
    def.markets = markets;
    
    // Build market-to-strategy mapping (support multiple strategies per market)
    for (const market of markets) {
      const existing = marketToStrategies.get(market) || new Set();
      existing.add(strategyId);
      marketToStrategies.set(market, existing);
    }
    
    console.log(`[StrategyEnvManager] Loaded ${strategyId}: ${markets.length} markets, ` +
      `EXEC_MODE=${mergedEnv.EXEC_MODE}, FEE_MODEL=${mergedEnv.FEE_MODEL}`);
  }
  
  console.log(`[StrategyEnvManager] Market mappings: ${marketToStrategies.size} markets across ${envSnapshots.size} strategies`);
  
  // Log the market mappings for debugging
  for (const [market, strategies] of marketToStrategies) {
    const list = Array.from(strategies).join(', ');
    console.log(`[StrategyEnvManager]   ${market} → ${list}`);
  }
}

/**
 * Get the strategy ID that owns a market
 */
function getStrategyForMarket(market, strategyType = null) {
  const normalized = market.toUpperCase();
  const fullMarket = normalized.includes('-PERP') ? normalized : `${normalized}-PERP`;
  
  const strategies = marketToStrategies.get(fullMarket);
  if (!strategies || strategies.size === 0) return null;
  if (strategyType && strategies.has(strategyType)) return strategyType;
  if (strategies.size === 1) return Array.from(strategies)[0];
  return null;
}

/**
 * Get all strategy IDs registered for a market
 */
function getStrategiesForMarket(market) {
  const normalized = String(market || '').toUpperCase();
  const fullMarket = normalized.includes('-PERP') ? normalized : `${normalized}-PERP`;
  const strategies = marketToStrategies.get(fullMarket);
  return strategies ? Array.from(strategies) : [];
}

/**
 * Get the isolated env snapshot for a market
 * Returns the full env object for the strategy that owns this market
 */
function getEnvForMarket(market, strategyType = null) {
  const strategyId = getStrategyForMarket(market, strategyType);
  
  if (!strategyId) {
    const normalized = String(market || '').toUpperCase();
    const fullMarket = normalized.includes('-PERP') ? normalized : `${normalized}-PERP`;
    const strategies = marketToStrategies.get(fullMarket);
    if (strategies && strategies.size > 1) {
      if (!warnedAmbiguousMarkets.has(fullMarket)) {
        warnedAmbiguousMarkets.add(fullMarket);
        console.warn(
          `[StrategyEnvManager] Multiple strategies for ${market}; pass strategyType to resolve env. Using process.env`
        );
      }
    } else {
      console.warn(`[StrategyEnvManager] No strategy found for market ${market}, using process.env`);
    }
    return process.env;
  }
  
  return envSnapshots.get(strategyId) || process.env;
}

/**
 * Get the isolated env snapshot for a strategy
 */
function getEnvForStrategy(strategyId) {
  return envSnapshots.get(strategyId) || process.env;
}

/**
 * Get a config value for a specific market with proper fallback chain:
 * 1. STRATEGY_{MARKET}_{KEY} (per-market override)
 * 2. {KEY} (strategy default)
 * 3. defaultValue (fallback)
 */
function getMarketConfig(market, key, defaultValue = null, strategyType = null) {
  const env = getEnvForMarket(market, strategyType);
  const normalized = market.toUpperCase().replace('-PERP', '_PERP').replace('-', '_');
  
  // Try per-market override first
  const perMarketKey = `STRATEGY_${normalized}_${key}`;
  if (env[perMarketKey] !== undefined && env[perMarketKey] !== '') {
    return env[perMarketKey];
  }
  
  // Try base key
  if (env[key] !== undefined && env[key] !== '') {
    return env[key];
  }
  
  return defaultValue;
}

/**
 * Get a numeric config value for a market
 */
function getMarketConfigNum(market, key, defaultValue = 0, strategyType = null) {
  const value = getMarketConfig(market, key, defaultValue, strategyType);
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultValue;
}

/**
 * Get a boolean config value for a market
 */
function getMarketConfigBool(market, key, defaultValue = false, strategyType = null) {
  const value = getMarketConfig(market, key, defaultValue, strategyType);
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

/**
 * Get the execution provider for a market
 */
function getProviderForMarket(market, strategyType = null) {
  const strategyId = getStrategyForMarket(market, strategyType);
  if (!strategyId) return 'jupiter'; // Default
  
  const def = STRATEGY_DEFINITIONS[strategyId];
  return def?.provider || 'jupiter';
}

/**
 * Get all markets for a specific strategy
 */
function getMarketsForStrategy(strategyId) {
  const def = STRATEGY_DEFINITIONS[strategyId];
  return def?.markets || [];
}

/**
 * Get all loaded strategy IDs
 */
function getLoadedStrategies() {
  return Array.from(envSnapshots.keys());
}

/**
 * Debug: dump all strategy configs
 */
function dumpConfigs() {
  console.log('\n[StrategyEnvManager] === Configuration Dump ===');
  
  for (const [strategyId, env] of envSnapshots) {
    console.log(`\n${strategyId}:`);
    console.log(`  EXEC_MODE: ${env.EXEC_MODE}`);
    console.log(`  FEE_MODEL: ${env.FEE_MODEL}`);
    console.log(`  LEVERAGE_BASE: ${env.LEVERAGE_BASE}`);
    console.log(`  PERPS_EXECUTION_PROVIDER_DEFAULT: ${env.PERPS_EXECUTION_PROVIDER_DEFAULT}`);
    console.log(`  Markets: ${STRATEGY_DEFINITIONS[strategyId]?.markets?.join(', ')}`);
  }
  
  console.log('\n[StrategyEnvManager] === Market Mappings ===');
  for (const [market, strategies] of marketToStrategies) {
    for (const strategyId of strategies) {
      const env = envSnapshots.get(strategyId);
      console.log(`  ${market} → ${strategyId} (EXEC_MODE=${env?.EXEC_MODE}, LEV=${env?.LEVERAGE_BASE})`);
    }
  }
  console.log('');
}

module.exports = {
  initialize,
  getStrategyForMarket,
  getStrategiesForMarket,
  getEnvForMarket,
  getEnvForStrategy,
  getMarketConfig,
  getMarketConfigNum,
  getMarketConfigBool,
  getProviderForMarket,
  getMarketsForStrategy,
  getLoadedStrategies,
  dumpConfigs,
  // Expose for testing
  _envSnapshots: envSnapshots,
  _marketToStrategy: marketToStrategies,
  _marketToStrategies: marketToStrategies,
};
