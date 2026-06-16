/**
 * Market Microstructure Constraints
 * 
 * Provides realistic market constraints for backtesting:
 * - Dynamic slippage based on position size and market depth
 * - Position size caps per market
 * - Liquidity-based trade filtering
 * - Degrading maker fill rates at scale
 * 
 * Created: 2024-12-25
 * Purpose: Fix unrealistic backtest assumptions (audit findings)
 */

// ============================================================
// MARKET DEPTH & LIQUIDITY DATA
// ============================================================
// Based on typical Drift Protocol market conditions (Dec 2024)
// Values represent approximate $ notional depth at best bid/ask
const MARKET_DEPTH = {
  // High liquidity majors
  'SOL-PERP': 2000000,    // $2M
  'BTC-PERP': 5000000,    // $5M
  'ETH-PERP': 3000000,    // $3M
  
  // Mid-tier alts
  'DOGE-PERP': 1000000,   // $1M
  'SUI-PERP': 500000,     // $500K
  'APT-PERP': 400000,     // $400K
  'ARB-PERP': 400000,     // $400K
  'XRP-PERP': 600000,     // $600K
  'OP-PERP': 300000,      // $300K
  'LINK-PERP': 400000,    // $400K
  'INJ-PERP': 300000,     // $300K
  
  // Lower liquidity alts
  'TAO-PERP': 200000,     // $200K
  'HNT-PERP': 100000,     // $100K
  'RENDER-PERP': 150000,  // $150K
  'POL-PERP': 250000,     // $250K
  'BNB-PERP': 500000,     // $500K
  'RAY-PERP': 150000,     // $150K
  
  // Default for unknown markets
  'DEFAULT': 200000,      // $200K
};

// ============================================================
// POSITION SIZE CAPS
// ============================================================
// Maximum position size per market ($ notional)
// Based on typical daily volume and open interest limits
const POSITION_CAPS = {
  // Majors - higher caps
  'SOL-PERP': 2000000,    // $2M max
  'BTC-PERP': 5000000,    // $5M max
  'ETH-PERP': 3000000,    // $3M max
  
  // Mid-tier alts
  'DOGE-PERP': 1000000,   // $1M max
  'SUI-PERP': 500000,     // $500K max
  'APT-PERP': 400000,     // $400K max
  'ARB-PERP': 400000,     // $400K max
  'XRP-PERP': 600000,     // $600K max
  'OP-PERP': 300000,      // $300K max
  'LINK-PERP': 400000,    // $400K max
  'INJ-PERP': 300000,     // $300K max
  
  // Lower liquidity alts - conservative caps
  'TAO-PERP': 150000,     // $150K max
  'HNT-PERP': 75000,      // $75K max
  'RENDER-PERP': 100000,  // $100K max
  'POL-PERP': 200000,     // $200K max
  'BNB-PERP': 400000,     // $400K max
  'RAY-PERP': 100000,     // $100K max
  
  // Default for unknown markets
  'DEFAULT': 150000,      // $150K max
};

// ============================================================
// DYNAMIC SLIPPAGE MODEL (Taker Orders Only)
// ============================================================
/**
 * Calculate realistic slippage for taker (market) orders
 * 
 * Slippage increases non-linearly with position size relative to market depth.
 * Model: base + size_impact + volatility_impact
 * 
 * @param {number} positionSizeUsd - Position size in USD (notional)
 * @param {string} market - Market symbol (e.g., 'SOL-PERP')
 * @param {number} volatility - Market volatility (ATR % or similar, 0-1)
 * @param {Object} options - Additional options
 * @returns {number} Slippage in decimal (e.g., 0.001 = 10 bps)
 */
function calculateDynamicSlippage(positionSizeUsd, market, volatility = 0.02, options = {}) {
  // Get market depth (or use default)
  const depth = MARKET_DEPTH[market] || MARKET_DEPTH.DEFAULT;
  
  // Base slippage (minimum for any trade) - reduced from 5 to 2 bps
  const baseSlippage = options.baseSlippageBps || 2; // 2 bps minimum
  
  // Calculate position size relative to market depth
  const sizeRatio = positionSizeUsd / depth;
  
  // Size impact: more gradual growth as position approaches market depth
  // Using sqrt instead of pow(1.5) for gentler curve
  // At 10% of depth: ~3 bps additional
  // At 50% of depth: ~15 bps additional
  // At 100% of depth: ~30 bps additional
  const sizeImpactBps = baseSlippage * Math.sqrt(sizeRatio) * 10;
  
  // Volatility impact: more moderate scaling
  // Typical volatility (2%): 1.2x multiplier
  // High volatility (5%): 1.5x multiplier
  const volatilityMultiplier = 1 + (volatility * 10);
  
  // Total slippage
  const totalSlippageBps = (baseSlippage + sizeImpactBps) * volatilityMultiplier;
  
  // Cap at maximum (100 bps = 1%) - reduced from 500 bps
  const maxSlippageBps = options.maxSlippageBps || 100;
  const cappedSlippageBps = Math.min(totalSlippageBps, maxSlippageBps);
  
  // Convert bps to decimal
  return cappedSlippageBps / 10000;
}

// ============================================================
// DEGRADING MAKER FILL RATES
// ============================================================
/**
 * Estimate maker fill probability based on position size
 * 
 * As positions grow, maker orders are less likely to fill:
 * - Queue competition increases
 * - Price moves away before fill
 * - Urgency to execute forces taker fallback
 * 
 * @param {number} positionSizeUsd - Position size in USD (notional)
 * @param {string} market - Market symbol
 * @param {Object} options - Additional options
 * @returns {number} Fill probability (0-1)
 */
function estimateMakerFillProbability(positionSizeUsd, market, options = {}) {
  const depth = MARKET_DEPTH[market] || MARKET_DEPTH.DEFAULT;
  
  // Base fill rate for small positions
  const baseFillRate = options.baseFillRate || 0.60; // 60% at small size
  
  // Calculate size ratio
  const sizeRatio = positionSizeUsd / depth;
  
  // Degradation curve: exponential decay
  // At 10% of depth: ~54% fill rate
  // At 50% of depth: ~37% fill rate
  // At 100% of depth: ~22% fill rate
  const degradation = Math.pow(sizeRatio, 0.5);
  const adjustedFillRate = baseFillRate * Math.exp(-degradation);
  
  // Floor at minimum fill rate (some orders always fill)
  const minFillRate = options.minFillRate || 0.15; // 15% floor
  return Math.max(adjustedFillRate, minFillRate);
}

/**
 * Simulate maker fill outcome with degrading probability
 * 
 * @param {number} positionSizeUsd - Position size in USD (notional)
 * @param {string} market - Market symbol
 * @param {Object} options - Additional options
 * @returns {Object} { filled: boolean, fillRate: number }
 */
function simulateMakerFill(positionSizeUsd, market, options = {}) {
  const fillRate = estimateMakerFillProbability(positionSizeUsd, market, options);
  const filled = Math.random() < fillRate;
  
  return {
    filled,
    fillRate,
    willFallbackToTaker: !filled,
  };
}

// ============================================================
// LIQUIDITY CONSTRAINTS
// ============================================================
/**
 * Check if position size violates liquidity constraints
 * 
 * @param {string} market - Market symbol
 * @param {number} positionSizeUsd - Position size in USD (notional)
 * @param {Object} marketData - Optional market data (volume, OI, etc.)
 * @returns {Object} { allowed: boolean, reason: string, adjustedSize: number }
 */
function checkLiquidityConstraint(market, positionSizeUsd, marketData = {}) {
  const depth = MARKET_DEPTH[market] || MARKET_DEPTH.DEFAULT;
  const cap = POSITION_CAPS[market] || POSITION_CAPS.DEFAULT;
  
  // Hard cap: position size limit
  if (positionSizeUsd > cap) {
    return {
      allowed: false,
      reason: 'exceeds_position_cap',
      requestedSize: positionSizeUsd,
      maxSize: cap,
      adjustedSize: cap,
    };
  }
  
  // Soft cap: position shouldn't exceed 50% of typical depth
  // (allows trade but triggers warning)
  const softLimit = depth * 0.5;
  if (positionSizeUsd > softLimit) {
    return {
      allowed: true,
      warning: 'exceeds_depth_threshold',
      requestedSize: positionSizeUsd,
      depthThreshold: softLimit,
      adjustedSize: positionSizeUsd, // Allow but warn
    };
  }
  
  // If volume data provided, check 24h volume constraint
  if (marketData.volume24h) {
    const volumeLimit = marketData.volume24h * 0.10; // Max 10% of daily volume
    if (positionSizeUsd > volumeLimit) {
      return {
        allowed: false,
        reason: 'exceeds_volume_limit',
        requestedSize: positionSizeUsd,
        maxSize: volumeLimit,
        adjustedSize: volumeLimit,
      };
    }
  }
  
  // All checks passed
  return {
    allowed: true,
    requestedSize: positionSizeUsd,
    adjustedSize: positionSizeUsd,
  };
}

/**
 * Get capped position size for a market
 * 
 * @param {string} market - Market symbol
 * @param {number} requestedSizeUsd - Requested position size in USD (notional)
 * @returns {number} Capped position size in USD
 */
function getCapppedPositionSize(market, requestedSizeUsd) {
  const cap = POSITION_CAPS[market] || POSITION_CAPS.DEFAULT;
  return Math.min(requestedSizeUsd, cap);
}

/**
 * Check if trade should be skipped due to liquidity constraints
 * 
 * @param {string} market - Market symbol
 * @param {number} positionSizeUsd - Position size in USD (notional)
 * @param {Object} options - Options { strict: boolean }
 * @returns {Object} { skip: boolean, reason: string, cappedSize: number }
 */
function shouldSkipTrade(market, positionSizeUsd, options = {}) {
  const constraint = checkLiquidityConstraint(market, positionSizeUsd);
  
  if (!constraint.allowed) {
    if (options.strict) {
      // Strict mode: skip trade if any violation
      return {
        skip: true,
        reason: constraint.reason,
        requestedSize: positionSizeUsd,
      };
    } else {
      // Lenient mode: cap to max size and continue
      return {
        skip: false,
        capped: true,
        reason: constraint.reason,
        requestedSize: positionSizeUsd,
        cappedSize: constraint.adjustedSize,
      };
    }
  }
  
  return {
    skip: false,
    requestedSize: positionSizeUsd,
    cappedSize: positionSizeUsd,
  };
}

// ============================================================
// CONFIGURATION HELPERS
// ============================================================
/**
 * Update market depth data (useful for testing or custom markets)
 */
function setMarketDepth(market, depthUsd) {
  MARKET_DEPTH[market] = depthUsd;
}

/**
 * Update position cap (useful for testing or custom markets)
 */
function setPositionCap(market, capUsd) {
  POSITION_CAPS[market] = capUsd;
}

/**
 * Get current market constraints
 */
function getMarketConstraints(market) {
  return {
    market,
    depth: MARKET_DEPTH[market] || MARKET_DEPTH.DEFAULT,
    positionCap: POSITION_CAPS[market] || POSITION_CAPS.DEFAULT,
  };
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  // Data
  MARKET_DEPTH,
  POSITION_CAPS,
  
  // Slippage
  calculateDynamicSlippage,
  
  // Maker fills
  estimateMakerFillProbability,
  simulateMakerFill,
  
  // Liquidity constraints
  checkLiquidityConstraint,
  getCapppedPositionSize,
  shouldSkipTrade,
  
  // Configuration
  setMarketDepth,
  setPositionCap,
  getMarketConstraints,
};

