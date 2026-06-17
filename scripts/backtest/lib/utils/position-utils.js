/**
 * Position management utilities for backtesting
 */

/**
 * Calculate unrealised PnL for a position
 * @param {Object} pos - Position object
 * @param {number} markPrice - Current mark price
 * @returns {number} Unrealised PnL in USD
 */
function unrealised(pos, markPrice) {
  if (!pos || !Number.isFinite(markPrice) || markPrice <= 0) return 0;
  const side = pos.side?.toLowerCase();
  if (side !== 'long' && side !== 'short') return 0;
  
  const entryPrice = pos.entryPrice;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  
  const sizeUsd = pos.sizeUsd || 0;
  if (sizeUsd <= 0) return 0;
  
  if (side === 'long') {
    return (markPrice - entryPrice) / entryPrice * sizeUsd;
  } else {
    return (entryPrice - markPrice) / entryPrice * sizeUsd;
  }
}

/**
 * Check if position should be liquidated
 * @param {Object} pos - Position object
 * @param {number} markPrice - Current mark price
 * @returns {boolean} True if position should be liquidated
 */
function shouldLiquidate(pos, markPrice) {
  if (!pos || !Number.isFinite(markPrice)) return false;
  
  const unrealisedPnl = unrealised(pos, markPrice);
  const collateral = pos.collateral || 0;
  
  // Liquidation occurs when unrealised loss exceeds collateral
  return unrealisedPnl < -collateral;
}

/**
 * Calculate position equity (collateral + unrealised PnL)
 * @param {Object} pos - Position object
 * @param {number} markPrice - Current mark price
 * @returns {number} Position equity in USD
 */
function positionEquity(pos, markPrice) {
  const collateral = pos.collateral || 0;
  const unrealisedPnl = unrealised(pos, markPrice);
  return collateral + unrealisedPnl;
}

module.exports = {
  unrealised,
  shouldLiquidate,
  positionEquity,
};
