/**
 * Drift Market Lookup Utility
 * 
 * Provides deterministic lookups for Drift market information from the registry.
 * All market indices, oracles, and metadata are loaded from config/drift-market-registry.json
 * 
 * Usage:
 *   const { getMarketIndex, getMarketInfo, getTradeableMarkets } = require('./utils/drift-market-lookup');
 *   
 *   const index = getMarketIndex('SOL-PERP');  // Returns 0
 *   const info = getMarketInfo('SOL-PERP');    // Returns full market entry
 *   const markets = getTradeableMarkets();     // Returns array of tradeable market symbols
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', 'config', 'drift-market-registry.json');

let registryCache = null;

/**
 * Load and cache the market registry
 * @returns {Object} The market registry
 */
function loadRegistry() {
  if (registryCache) {
    return registryCache;
  }
  
  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(`Drift market registry not found at ${REGISTRY_PATH}. Run: npm run drift:generate-registry`);
  }
  
  registryCache = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  return registryCache;
}

/**
 * Clear the registry cache (useful for testing or after regeneration)
 */
function clearCache() {
  registryCache = null;
}

/**
 * Get the Drift market index for a given symbol
 * @param {string} symbol - Market symbol (e.g., 'SOL-PERP', 'SOL', 'BTC-PERP')
 * @returns {number|null} The market index or null if not found
 */
function getMarketIndex(symbol) {
  const registry = loadRegistry();
  
  // Normalize symbol to include -PERP if not present
  const normalizedSymbol = symbol.endsWith('-PERP') ? symbol : `${symbol}-PERP`;
  
  const market = registry.markets[normalizedSymbol];
  return market ? market.marketIndex : null;
}

/**
 * Get full market information for a given symbol
 * @param {string} symbol - Market symbol (e.g., 'SOL-PERP', 'SOL')
 * @returns {Object|null} The market entry or null if not found
 */
function getMarketInfo(symbol) {
  const registry = loadRegistry();
  
  // Normalize symbol to include -PERP if not present
  const normalizedSymbol = symbol.endsWith('-PERP') ? symbol : `${symbol}-PERP`;
  
  return registry.markets[normalizedSymbol] || null;
}

/**
 * Get market symbol by index
 * @param {number} index - The market index
 * @returns {string|null} The market symbol or null if not found
 */
function getMarketByIndex(index) {
  const registry = loadRegistry();
  
  for (const [symbol, market] of Object.entries(registry.markets)) {
    if (market.marketIndex === index) {
      return symbol;
    }
  }
  
  return null;
}

/**
 * Get all tradeable markets
 * @returns {string[]} Array of tradeable market symbols
 */
function getTradeableMarkets() {
  const registry = loadRegistry();
  
  return Object.entries(registry.markets)
    .filter(([_, market]) => market.tradeable)
    .map(([symbol]) => symbol);
}

/**
 * Get markets by category
 * @param {string} category - Category (e.g., 'majors', 'altcoins', 'memecoins')
 * @returns {string[]} Array of market symbols in the category
 */
function getMarketsByCategory(category) {
  const registry = loadRegistry();
  
  return Object.entries(registry.markets)
    .filter(([_, market]) => market.category === category)
    .map(([symbol]) => symbol);
}

/**
 * Get max leverage for a market
 * @param {string} symbol - Market symbol
 * @returns {number} Max leverage (defaults to 5 if not found)
 */
function getMaxLeverage(symbol) {
  const market = getMarketInfo(symbol);
  return market ? market.maxLeverage : 5;
}

/**
 * Get Pyth feed ID for a market
 * @param {string} symbol - Market symbol
 * @returns {string|null} Pyth feed ID or null if not available
 */
function getPythFeedId(symbol) {
  const market = getMarketInfo(symbol);
  return market ? market.pythFeedId : null;
}

/**
 * Get CoinGecko ID for a market
 * @param {string} symbol - Market symbol
 * @returns {string|null} CoinGecko ID or null if not available
 */
function getCoinGeckoId(symbol) {
  const market = getMarketInfo(symbol);
  return market ? market.coingeckoId : null;
}

/**
 * Get oracle address for a market
 * @param {string} symbol - Market symbol
 * @returns {string|null} Oracle address or null if not available
 */
function getOracleAddress(symbol) {
  const market = getMarketInfo(symbol);
  return market ? market.oracle : null;
}

/**
 * Validate that a market exists and is tradeable
 * @param {string} symbol - Market symbol
 * @returns {{valid: boolean, reason?: string}} Validation result
 */
function validateMarket(symbol) {
  const market = getMarketInfo(symbol);
  
  if (!market) {
    return { valid: false, reason: `Market ${symbol} not found in registry` };
  }
  
  if (!market.tradeable) {
    return { valid: false, reason: `Market ${symbol} is not tradeable (category: ${market.category})` };
  }
  
  if (!market.hasPriceFeed) {
    return { valid: false, reason: `Market ${symbol} has no price feed available` };
  }
  
  return { valid: true };
}

/**
 * Build a symbol-to-index mapping for a list of markets
 * @param {string[]} symbols - Array of market symbols
 * @returns {Object} Mapping of symbol to market index
 */
function buildMarketIndexMap(symbols) {
  const map = {};
  
  for (const symbol of symbols) {
    const index = getMarketIndex(symbol);
    if (index !== null) {
      // Store both with and without -PERP suffix for flexibility
      const normalizedSymbol = symbol.endsWith('-PERP') ? symbol : `${symbol}-PERP`;
      const baseSymbol = normalizedSymbol.replace('-PERP', '');
      
      map[normalizedSymbol] = index;
      map[baseSymbol] = index;
    }
  }
  
  return map;
}

/**
 * Get registry metadata
 * @returns {Object} Registry generation metadata
 */
function getRegistryMetadata() {
  const registry = loadRegistry();
  return registry.generated || {};
}

/**
 * Get registry statistics
 * @returns {Object} Statistics about the registry
 */
function getRegistryStats() {
  const registry = loadRegistry();
  const markets = Object.values(registry.markets);
  
  return {
    totalMarkets: markets.length,
    tradeableMarkets: markets.filter(m => m.tradeable).length,
    withPriceFeed: markets.filter(m => m.hasPriceFeed).length,
    byCategory: {
      majors: markets.filter(m => m.category === 'majors').length,
      altcoins: markets.filter(m => m.category === 'altcoins').length,
      memecoins: markets.filter(m => m.category === 'memecoins').length,
      prediction: markets.filter(m => m.category === 'prediction').length,
      other: markets.filter(m => !['majors', 'altcoins', 'memecoins', 'prediction'].includes(m.category)).length,
    },
  };
}

/**
 * Get price decimals for display formatting
 * @param {string} symbol - Market symbol
 * @returns {number} Number of decimal places for price display (defaults to 4)
 */
function getPriceDecimals(symbol) {
  const market = getMarketInfo(symbol);
  return market?.priceDecimals ?? 4;
}

/**
 * Format a price with the correct number of decimals for a market
 * @param {number} price - The price to format
 * @param {string} symbol - Market symbol
 * @returns {string} Formatted price string
 */
function formatPrice(price, symbol) {
  if (price == null || isNaN(price)) return 'N/A';
  const decimals = getPriceDecimals(symbol);
  return price.toFixed(decimals);
}

/**
 * Format a price with dollar sign and correct decimals
 * @param {number} price - The price to format
 * @param {string} symbol - Market symbol
 * @returns {string} Formatted price string with $ prefix
 */
function formatPriceUSD(price, symbol) {
  if (price == null || isNaN(price)) return '$N/A';
  return `$${formatPrice(price, symbol)}`;
}

module.exports = {
  loadRegistry,
  clearCache,
  getMarketIndex,
  getMarketInfo,
  getMarketByIndex,
  getTradeableMarkets,
  getMarketsByCategory,
  getMaxLeverage,
  getPythFeedId,
  getCoinGeckoId,
  getOracleAddress,
  validateMarket,
  buildMarketIndexMap,
  getRegistryMetadata,
  getRegistryStats,
  getPriceDecimals,
  formatPrice,
  formatPriceUSD,
  REGISTRY_PATH,
};

