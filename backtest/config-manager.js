/**
 * Backtest Configuration Manager
 * Unified configuration resolution, merging, and defaults for backtest simulations
 */

const SIMULATION_CONSTANTS = require('../backtest/backtest-constants');

/**
 * Default fee configuration
 */
const DEFAULT_FEE_CONFIG = {
  openFeeBps: 6,
  closeFeeBps: 6,
  borrowFeeBpsPerHour: 1.2,
  borrowUtilizationRate: 0.198,
  priceImpactFeeScalar: SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR,
  enablePriceImpactFee: true,
  solanaTxFee: {
    baseFeeLamports: 5000,
    cuLimit: 200000,
    priorityFeeMicroLamports: 0,
    enableTxFees: true,
  },
};

/**
 * Default funding configuration
 * Note: ratePerCadence defaults to 0 for neutral backtesting.
 * To simulate realistic funding:
 * - Set ratePerCadence to a non-zero value (e.g., 0.0001 = 0.01% per 8h)
 * - Or enable wobble with wobbleMeanBps (e.g., 1.0 = 0.01% mean)
 * - Or use historical funding rates from Binance API
 */
const DEFAULT_FUNDING_CONFIG = {
  cadenceMs: SIMULATION_CONSTANTS.FUNDING_CADENCE_MS,
  ratePerCadence: 0, // Default 0 for neutral backtesting. Set to simulate or use historical rates
  wobbleStdBps: 0.75, // Standard deviation in basis points (0.75 bps = 0.0075%)
  wobbleMeanBps: 1.0, // Mean in basis points (1.0 bps = 0.01% per 8h) - realistic average funding rate
  useHistoricalRates: true, // Default to true: fetch historical rates from Binance API
};

/**
 * Default leverage configuration
 */
const DEFAULT_LEVERAGE_CONFIG = {
  baseLeverage: 2,
  minLeverage: 1,
  maxLeverage: 5,
  volatilityAdjustment: true,
  adxAdjustment: true,
  confidenceAdjustment: true,
  portfolioRiskAdjustment: true,
  fundingAdjustment: true,
  drawdownProtection: true,
  useKelly: false,
  useDynamicMaxLev: false, // Only enable if explicitly set
  dailyDrawdownThreshold: 0.03,
};

/**
 * Default risk/trading limits
 */
const DEFAULT_TRADING_LIMITS = {
  maxOpenPositions: 4,
  dailyTradeLimit: 20,
};

/**
 * Deep merge utility - merges nested objects
 */
function deepMerge(target, source) {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Backtest Configuration Manager Class
 */
class BacktestConfigManager {
  constructor(baseConfig = null) {
    // Resolve base config (use provided or require default)
    this.baseConfig = baseConfig || require('../config');
    
    // Cache resolved configurations
    this._feeConfig = null;
    this._fundingConfig = null;
    this._leverageConfig = null;
    this._tradingLimits = null;
  }

  /**
   * Get merged fee configuration with defaults
   * @returns {Object} Fee configuration
   */
  getFeeConfig() {
    if (this._feeConfig) return this._feeConfig;

    const configFees = this.baseConfig?.fees || {};
    this._feeConfig = deepMerge(DEFAULT_FEE_CONFIG, configFees);
    return this._feeConfig;
  }

  /**
   * Get merged funding configuration with defaults
   * @returns {Object} Funding configuration
   */
  getFundingConfig() {
    if (this._fundingConfig) return this._fundingConfig;

    const configFunding = this.baseConfig?.funding || {};
    this._fundingConfig = { ...DEFAULT_FUNDING_CONFIG, ...configFunding };
    return this._fundingConfig;
  }

  /**
   * Get leverage configuration for DynamicLeverageManager
   * @param {Object} overrides - Optional overrides
   * @returns {Object} Leverage configuration
   */
  getLeverageConfig(overrides = {}) {
    const leverage = this.baseConfig?.leverage || {};
    
    return {
      ...DEFAULT_LEVERAGE_CONFIG,
      baseLeverage: leverage.baseLeverage || leverage.long || DEFAULT_LEVERAGE_CONFIG.baseLeverage,
      minLeverage: leverage.minLeverage ?? DEFAULT_LEVERAGE_CONFIG.minLeverage,
      // Use config value if explicitly set (even if 0), otherwise use default
      // This ensures LEVERAGE_MAX env var is respected
      maxLeverage: leverage.maxLeverage !== undefined && leverage.maxLeverage !== null 
        ? leverage.maxLeverage 
        : DEFAULT_LEVERAGE_CONFIG.maxLeverage,
      volatilityAdjustment: leverage.volatilityAdjustment !== false,
      adxAdjustment: leverage.adxAdjustment !== false,
      confidenceAdjustment: leverage.confidenceAdjustment !== false,
      portfolioRiskAdjustment: leverage.portfolioRiskAdjustment !== false,
      fundingAdjustment: leverage.fundingAdjustment !== false,
      drawdownProtection: leverage.drawdownProtection !== false,
      useKelly: leverage.useKelly || false,
      useDynamicMaxLev: leverage.useDynamicMaxLev === true, // Only enable if explicitly set
      dailyDrawdownThreshold: leverage.dailyDrawdownThreshold || DEFAULT_LEVERAGE_CONFIG.dailyDrawdownThreshold,
      trackPerformance: true,
      ...overrides,
    };
  }

  /**
   * Get trading limits (max positions, daily trade limit)
   * @param {Object} options - Options with potential overrides
   * @returns {Object} Trading limits
   */
  getTradingLimits(options = {}) {
    return {
      maxPositions: Number(
        options.maxPositions ??
        this.baseConfig?.maxOpenPositions ??
        DEFAULT_TRADING_LIMITS.maxOpenPositions
      ),
      dailyTradeLimit: Number(
        options.dailyTradeLimit ??
        this.baseConfig?.dailyTradeLimit ??
        DEFAULT_TRADING_LIMITS.dailyTradeLimit
      ),
    };
  }

  /**
   * Get SOL price for transaction fee calculations
   * @param {number} currentPrice - Current market price
   * @param {string|null} market - Market symbol (e.g., 'SOL-PERP')
   * @returns {number} SOL price in USD
   */
  getSolPrice(currentPrice, market = null) {
    // If market is SOL-PERP, use current price
    if (market && market.toUpperCase().includes('SOL-PERP')) {
      return currentPrice;
    }
    
    // Otherwise, use configurable SOL price (default ~$150 USD)
    const feeCfg = this.getFeeConfig();
    return feeCfg.solPriceUsd || this.baseConfig?.solPriceUsd || 150;
  }

  /**
   * Get risk manager configuration
   * @returns {Object} Configuration for RiskManager
   */
  getRiskConfig() {
    return this.baseConfig;
  }

  /**
   * Get portfolio risk manager configuration
   * @param {Object} overrides - Optional overrides
   * @returns {Object} Configuration for PortfolioRiskManager
   */
  getPortfolioRiskConfig(overrides = {}) {
    const risk = this.baseConfig?.risk || {};
    return {
      ...risk,
      maxTotalLeverage: risk.maxTotalLeverage ?? 10,
      maxTotalExposure: risk.maxTotalExposure ?? 5000,
      ...overrides,
    };
  }

  /**
   * Get compounding configuration
   * @param {Object} options - Options with potential overrides
   * @returns {boolean} Whether compounding is enabled
   */
  isCompoundingEnabled(options = {}) {
    return (
      this.baseConfig?.risk?.enableCompounding === true ||
      options.enableCompounding === true
    );
  }

  /**
   * Get position sizing method
   * @param {Object} options - Options with potential overrides
   * @returns {string|null} Sizing method ('equal-risk' | 'percent' | null)
   */
  getSizingMethod(options = {}) {
    // Priority: options > config.sizingMethod > config.forceSizingMethod
    return (
      options.forceSizingMethod ||
      this.baseConfig?.risk?.sizingMethod ||
      this.baseConfig?.risk?.forceSizingMethod ||
      null
    );
  }
}

/**
 * Factory function to create a config manager instance
 * @param {Object|null} baseConfig - Base configuration object (optional)
 * @returns {BacktestConfigManager} Config manager instance
 */
function createConfigManager(baseConfig = null) {
  return new BacktestConfigManager(baseConfig);
}

module.exports = {
  BacktestConfigManager,
  createConfigManager,
  DEFAULT_FEE_CONFIG,
  DEFAULT_FUNDING_CONFIG,
  DEFAULT_LEVERAGE_CONFIG,
  DEFAULT_TRADING_LIMITS,
};
