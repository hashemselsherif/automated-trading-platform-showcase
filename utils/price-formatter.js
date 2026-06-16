/**
 * Price Formatter Utility
 * 
 * Provides smart price formatting for display purposes ONLY.
 * All computations should use raw price values without any rounding.
 * 
 * This formatter adapts decimal precision based on price magnitude:
 * - High prices (>$100): 2 decimals  e.g., $223.07
 * - Medium prices ($1-$100): 2-3 decimals  e.g., $12.24, $4.583
 * - Low prices ($0.10-$1): 4 decimals  e.g., $0.1924
 * - Very low prices (<$0.10): 5-6 decimals  e.g., $0.00234
 */

/**
 * Format a price for display with adaptive decimal precision.
 * 
 * IMPORTANT: This is for DISPLAY ONLY. Never use the output for computations.
 * Always use raw price values in calculations.
 * 
 * @param {number} price - The raw price value (full precision)
 * @param {Object} options - Formatting options
 * @param {boolean} options.includeSign - Include $ sign (default: true)
 * @param {number} options.minDecimals - Minimum decimal places (default: 2)
 * @param {number} options.maxDecimals - Maximum decimal places (default: 6)
 * @returns {string} Formatted price string for display
 */
function formatPriceForDisplay(price, options = {}) {
  const {
    includeSign = true,
    minDecimals = 2,
    maxDecimals = 6,
  } = options;

  // Handle invalid inputs
  if (price === null || price === undefined || !Number.isFinite(price)) {
    return includeSign ? '$---' : '---';
  }

  const absPrice = Math.abs(price);
  let decimals;

  if (absPrice >= 1000) {
    // Very high prices: $1000+ → 2 decimals
    decimals = 2;
  } else if (absPrice >= 100) {
    // High prices: $100-$999 → 2 decimals
    decimals = 2;
  } else if (absPrice >= 10) {
    // Medium-high prices: $10-$99 → 2-3 decimals
    decimals = 2;
  } else if (absPrice >= 1) {
    // Medium prices: $1-$9.99 → 3 decimals
    decimals = 3;
  } else if (absPrice >= 0.1) {
    // Low prices: $0.10-$0.99 → 4 decimals
    decimals = 4;
  } else if (absPrice >= 0.01) {
    // Very low prices: $0.01-$0.099 → 5 decimals
    decimals = 5;
  } else if (absPrice > 0) {
    // Micro prices: <$0.01 → 6 decimals
    decimals = maxDecimals;
  } else {
    // Zero
    decimals = minDecimals;
  }

  // Clamp to min/max
  decimals = Math.max(minDecimals, Math.min(maxDecimals, decimals));

  const formatted = price.toFixed(decimals);
  return includeSign ? `$${formatted}` : formatted;
}

/**
 * Format price for compact log display (fixed width padding)
 * Uses adaptive decimals but pads to consistent width
 * 
 * @param {number} price - The raw price value
 * @param {number} width - Total width including $ sign (default: 10)
 * @returns {string} Formatted and padded price string
 */
function formatPriceCompact(price, width = 10) {
  const formatted = formatPriceForDisplay(price, { includeSign: true });
  return formatted.padStart(width);
}

/**
 * Get recommended decimal precision for a given price magnitude.
 * Useful when you need just the precision, not the formatted string.
 * 
 * @param {number} price - The price value
 * @returns {number} Recommended decimal places
 */
function getPricePrecision(price) {
  if (!Number.isFinite(price) || price <= 0) return 2;
  
  const absPrice = Math.abs(price);
  
  if (absPrice >= 100) return 2;
  if (absPrice >= 10) return 2;
  if (absPrice >= 1) return 3;
  if (absPrice >= 0.1) return 4;
  if (absPrice >= 0.01) return 5;
  return 6;
}

/**
 * Validate that a price value has not been accidentally rounded during computation.
 * Returns true if the price appears to be at full precision.
 * 
 * This is a sanity check - if price looks "suspiciously round", it might have been
 * accidentally formatted and parsed, losing precision.
 * 
 * @param {number} price - The price to validate
 * @param {number} expectedPrecision - Expected significant figures (default: 6)
 * @returns {boolean} True if price appears to have full precision
 */
function validatePricePrecision(price, expectedPrecision = 6) {
  if (!Number.isFinite(price) || price <= 0) return false;
  
  // Get the string representation without exponential notation
  const str = price.toFixed(10);
  
  // Count significant digits after removing leading zeros and decimal point
  const cleaned = str.replace(/^0+|\./, '').replace(/0+$/, '');
  const sigFigs = cleaned.length;
  
  // Price should have at least the expected precision
  return sigFigs >= expectedPrecision;
}

module.exports = {
  formatPriceForDisplay,
  formatPriceCompact,
  getPricePrecision,
  validatePricePrecision,
};




