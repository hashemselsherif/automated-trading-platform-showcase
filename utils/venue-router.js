/**
 * Venue Router - Routes orders to correct execution venue (Jupiter vs Drift)
 * 
 * Key Principles:
 * 1. Majors (SOL, BTC, ETH) → Jupiter by default
 * 2. Alts → Drift by default
 * 3. Per-market overrides via env (VENUE_OVERRIDE_${MARKET}_PERP)
 * 4. Registry's defaultVenue field is authoritative
 * 5. Capital pools are SEPARATE between majors (Jupiter) and alts (Drift)
 */

const driftLookup = require('./drift-market-lookup');

// Strategy-scoped environment manager for isolated configs per strategy
let strategyEnv = null;
try {
  strategyEnv = require('./strategy-env-manager');
} catch (e) {
  // Not available, use process.env fallback
}

// Venue constants
const VENUE = {
  JUPITER: 'jupiter',
  DRIFT: 'drift',
};

// Default venue for majors (these use Jupiter even though registry might say drift)
const MAJORS = new Set(['SOL-PERP', 'BTC-PERP', 'ETH-PERP']);

/**
 * Get the execution venue for a market
 * @param {string} market - Market symbol (e.g., 'SOL-PERP', 'APT-PERP')
 * @returns {string} 'jupiter' or 'drift'
 */
function getVenueForMarket(market) {
  const normalizedMarket = market.toUpperCase().includes('-PERP') 
    ? market.toUpperCase() 
    : `${market.toUpperCase()}-PERP`;
  
  // 1. Check for explicit env override
  const marketKey = normalizedMarket.replace(/-/g, '_');
  const envOverride = process.env[`VENUE_OVERRIDE_${marketKey}`];
  if (envOverride) {
    const venue = envOverride.toLowerCase();
    if (venue === VENUE.JUPITER || venue === VENUE.DRIFT) {
      return venue;
    }
  }
  
  // 2. Check PERPS_EXECUTION_PROVIDER_DEFAULT (legacy/global override)
  const globalDefault = process.env.PERPS_EXECUTION_PROVIDER_DEFAULT;
  if (globalDefault) {
    const venue = globalDefault.toLowerCase();
    if (venue === VENUE.JUPITER || venue === VENUE.DRIFT) {
      // If global says Jupiter, only apply to majors
      // If global says Drift, apply to all
      if (venue === VENUE.JUPITER && MAJORS.has(normalizedMarket)) {
        return VENUE.JUPITER;
      }
      if (venue === VENUE.DRIFT && !MAJORS.has(normalizedMarket)) {
        return VENUE.DRIFT;
      }
    }
  }
  
  // 3. Check registry's defaultVenue
  try {
    const marketInfo = driftLookup.getMarketInfo(normalizedMarket);
    if (marketInfo?.defaultVenue) {
      return marketInfo.defaultVenue.toLowerCase();
    }
  } catch (e) {
    // Registry lookup failed, use fallback logic
  }
  
  // 4. Fallback: majors → Jupiter, alts → Drift
  return MAJORS.has(normalizedMarket) ? VENUE.JUPITER : VENUE.DRIFT;
}

/**
 * Check if a market is considered a "major" (SOL, BTC, ETH)
 * @param {string} market - Market symbol
 * @returns {boolean}
 */
function isMajor(market) {
  const normalizedMarket = market.toUpperCase().includes('-PERP') 
    ? market.toUpperCase() 
    : `${market.toUpperCase()}-PERP`;
  return MAJORS.has(normalizedMarket);
}

/**
 * Get the capital pool for a market (based on venue)
 * @param {string} market - Market symbol
 * @param {Object} config - Bot config object
 * @returns {Object} { pool: 'majors'|'alts', balance: number, maxPositions: number }
 */
function getCapitalPool(market, config) {
  const venue = getVenueForMarket(market);
  
  // CRITICAL: Jupiter and Drift have SEPARATE capital pools
  // - Jupiter: uses STARTING_BALANCE_USD / PAPER_BALANCE (main balance variables)
  // - Drift: uses PAPER_BALANCE_ALTS (Drift-specific, must NOT share with Jupiter)
  
  if (venue === VENUE.JUPITER) {
    return {
      pool: 'majors',
      venue: VENUE.JUPITER,
      // Jupiter uses main balance variables
      balance: config.startingBalanceUsd || config.paperBalance || 1000,
      maxPositions: config.maxOpenPositionsMajors || config.maxOpenPositions || 4,
    };
  } else {
    return {
      pool: 'alts',
      venue: VENUE.DRIFT,
      // Drift ALWAYS uses paperBalanceAlts - this is the Drift-specific variable
      // Do NOT fall back to startingBalanceUsd as that's for Jupiter
      balance: config.paperBalanceAlts || 1000,
      maxPositions: config.maxOpenPositionsAlts || config.maxOpenPositions || 4,
    };
  }
}

/**
 * Group markets by venue
 * @param {string[]} markets - Array of market symbols
 * @returns {Object} { jupiter: string[], drift: string[] }
 */
function groupMarketsByVenue(markets) {
  const result = {
    jupiter: [],
    drift: [],
  };
  
  for (const market of markets) {
    const venue = getVenueForMarket(market);
    result[venue].push(market);
  }
  
  return result;
}

/**
 * Get venue statistics for configured markets
 * @param {string[]} markets - Array of market symbols
 * @returns {Object} Venue breakdown stats
 */
function getVenueStats(markets) {
  const grouped = groupMarketsByVenue(markets);
  return {
    total: markets.length,
    jupiter: grouped.jupiter.length,
    drift: grouped.drift.length,
    jupiterMarkets: grouped.jupiter,
    driftMarkets: grouped.drift,
  };
}

/**
 * Get the correct fee model for a market based on its venue.
 * This prevents env file override issues where .env.rsi-reversion (majors)
 * might override .env.rsi-reversion-alts (alts) values.
 * 
 * @param {string} market - Market symbol (e.g., 'SOL-PERP', 'JTO-PERP')
 * @returns {string} 'jupiter' or 'drift'
 */
function getFeeModelForMarket(market) {
  const venue = getVenueForMarket(market);
  // Fee model follows venue: Jupiter markets use Jupiter fees, Drift markets use Drift fees
  return venue;
}

/**
 * Get the correct execution mode for a market based on its venue.
 * - Jupiter: typically 'taker' (no maker orders on Jupiter Perps)
 * - Drift: respects EXEC_MODE env var, defaults to 'maker' for rebates
 * 
 * @param {string} market - Market symbol
 * @returns {string} 'taker' or 'maker'
 */
function getExecModeForMarket(market) {
  const venue = getVenueForMarket(market);
  if (venue === VENUE.JUPITER) {
    // Jupiter Perps only supports taker orders
    return 'taker';
  }
  
  // Drift: use market-specific exec mode from isolated strategy env
  // This prevents .env.rsi-reversion from overwriting .env.rsi-reversion-alts settings
  if (strategyEnv) {
    const mode = strategyEnv.getMarketConfig(market, 'EXEC_MODE', null);
    if (mode) return String(mode).toLowerCase();
  }
  
  // Fallback to process.env (for backwards compatibility)
  return (process.env.DRIFT_EXEC_MODE || process.env.EXEC_MODE || 'maker').toLowerCase();
}

/**
 * Get venue-aware configuration for a market.
 * Ensures correct fee model, exec mode, and capital pool regardless of env file load order.
 * 
 * @param {string} market - Market symbol
 * @param {Object} config - Bot config object
 * @returns {Object} { venue, feeModel, execMode, capitalPool }
 */
function getVenueConfig(market, config = {}) {
  const venue = getVenueForMarket(market);
  return {
    venue,
    feeModel: getFeeModelForMarket(market),
    execMode: getExecModeForMarket(market),
    capitalPool: getCapitalPool(market, config),
    isMajor: isMajor(market),
  };
}

module.exports = {
  VENUE,
  getVenueForMarket,
  isMajor,
  getCapitalPool,
  groupMarketsByVenue,
  getVenueStats,
  getFeeModelForMarket,
  getExecModeForMarket,
  getVenueConfig,
};


