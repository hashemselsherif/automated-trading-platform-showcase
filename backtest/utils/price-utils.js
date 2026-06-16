/**
 * Price calculation utilities for backtesting
 */

const { gaussian } = require('./math-utils');

/**
 * Compute mark price with funding rate wobble
 * @param {number} price - Base price
 * @param {Object} options - Funding configuration
 * @param {number} options.wobbleStdBps - Standard deviation in basis points
 * @param {number} options.wobbleMeanBps - Mean offset in basis points
 * @returns {number} Mark price
 */
function computeMarkPrice(price, { wobbleStdBps = 0.75, wobbleMeanBps = 0 } = {}) {
  if (!Number.isFinite(price) || price <= 0) return price;
  const std = wobbleStdBps / 10_000;
  const mean = wobbleMeanBps / 10_000;
  const noise = gaussian(mean, std);
  return price * (1 + noise);
}

module.exports = { computeMarkPrice };
