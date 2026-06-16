// utils/regime-filter.js

/**
 * RegimeFilter - Market regime classification using Choppiness Index and ADX
 * 
 * Classifies markets as RANGING (RSI-reversion) or TRENDING (momentum) to gate
 * strategy selection for Jupiter-venue majors only.
 * 
 * Key Features:
 * - Choppiness Index: Measures consolidation vs trend
 * - ADX confirmation: Validates trend strength
 * - Hysteresis: Prevents rapid regime switching
 * - Memory efficient: Ring buffers for historical data
 * 
 * Usage:
 *   const filter = new RegimeFilter({ chopPeriod: 14, confirmBars: 3 });
 *   filter.update({ high, low, atr, adx });
 *   const activeStrategy = filter.getActiveStrategy(); // 'rsi-reversion' | 'momentum'
 */

class RegimeFilter {
  constructor(config = {}) {
    // Configuration
    this.chopPeriod = config.chopPeriod || 14;
    this.chopTrending = config.chopTrending || 38.2;
    this.chopRanging = config.chopRanging || 61.8;
    this.adxMinTrend = config.adxMinTrend || 25;
    this.confirmBars = config.confirmBars || 3;
    
    // State
    this._currentRegime = 'rsi-reversion'; // Default to RSI (safer)
    this._previousRegime = null;
    this._pendingRegime = null;
    this._confirmCount = 0;
    
    // Ring buffers for historical data (memory efficient)
    this._highs = [];
    this._lows = [];
    this._atrs = [];
    this._maxBufferSize = this.chopPeriod + 5; // Small buffer overhead
    
    // Metrics
    this._lastChop = null;
    this._lastAdx = null;
  }
  
  /**
   * Update regime filter with latest bar data
   * @param {Object} data - { high, low, atr, adx }
   * @returns {boolean} True if regime changed
   */
  update({ high, low, atr, adx }) {
    // Validate inputs
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(atr)) {
      return false;
    }
    
    // Store ADX (may not be available initially)
    this._lastAdx = Number.isFinite(adx) ? adx : 0;
    
    // Add to ring buffers
    this._highs.push(high);
    this._lows.push(low);
    this._atrs.push(atr);
    
    // Trim buffers to max size
    if (this._highs.length > this._maxBufferSize) {
      this._highs.shift();
      this._lows.shift();
      this._atrs.shift();
    }
    
    // Need at least chopPeriod bars to calculate
    if (this._highs.length < this.chopPeriod) {
      return false;
    }
    
    // Calculate Choppiness Index
    const chop = this._calculateChoppinessIndex();
    this._lastChop = chop;
    
    // Determine target regime based on indicators
    const targetRegime = this._classifyRegime(chop, this._lastAdx);
    
    // Apply hysteresis (require N consecutive bars to confirm change)
    return this._applyHysteresis(targetRegime);
  }
  
  /**
   * Calculate Choppiness Index
   * Formula: 100 * LOG10(SUM(ATR, n) / (Highest High - Lowest Low)) / LOG10(n)
   * @returns {number} Choppiness Index (0-100)
   */
  _calculateChoppinessIndex() {
    const n = this.chopPeriod;
    
    // Use last N bars
    const recentHighs = this._highs.slice(-n);
    const recentLows = this._lows.slice(-n);
    const recentAtrs = this._atrs.slice(-n);
    
    // Sum of ATRs
    const atrSum = recentAtrs.reduce((sum, atr) => sum + atr, 0);
    
    // Highest high and lowest low over the period
    const highestHigh = Math.max(...recentHighs);
    const lowestLow = Math.min(...recentLows);
    const range = highestHigh - lowestLow;
    
    // Avoid division by zero or invalid values
    if (range <= 0 || atrSum <= 0 || !Number.isFinite(range) || !Number.isFinite(atrSum)) {
      return 50; // Neutral value
    }
    
    // CI = 100 * LOG10(SUM(ATR) / Range) / LOG10(n)
    // Higher CI = more choppy (ATR sum is large relative to range)
    // Lower CI = more trending (range is large relative to ATR sum)
    const ratio = atrSum / range;
    const ci = 100 * Math.log10(ratio) / Math.log10(n);
    
    // Clamp to 0-100
    return Math.max(0, Math.min(100, ci));
  }
  
  /**
   * Classify regime based on Choppiness Index and ADX
   * @param {number} chop - Choppiness Index
   * @param {number} adx - ADX value
   * @returns {string} 'rsi-reversion' | 'momentum'
   */
  _classifyRegime(chop, adx) {
    // RANGING: High choppiness (consolidation)
    if (chop > this.chopRanging) {
      return 'rsi-reversion';
    }
    
    // TRENDING: Low choppiness AND strong ADX
    if (chop < this.chopTrending && adx >= this.adxMinTrend) {
      return 'momentum';
    }
    
    // WEAK TREND: Low choppiness but weak ADX
    if (chop < this.chopTrending && adx < this.adxMinTrend) {
      return 'rsi-reversion';
    }
    
    // TRANSITIONAL: In between thresholds, keep current regime
    return this._currentRegime;
  }
  
  /**
   * Apply hysteresis to prevent rapid regime switching
   * @param {string} targetRegime - Desired regime
   * @returns {boolean} True if regime changed
   */
  _applyHysteresis(targetRegime) {
    // If target matches current, reset pending
    if (targetRegime === this._currentRegime) {
      this._pendingRegime = null;
      this._confirmCount = 0;
      return false;
    }
    
    // If target is new, start pending
    if (targetRegime !== this._pendingRegime) {
      this._pendingRegime = targetRegime;
      this._confirmCount = 1;
      return false;
    }
    
    // If target matches pending, increment confirm count
    if (targetRegime === this._pendingRegime) {
      this._confirmCount++;
      
      // If confirmed for N bars, switch regime
      if (this._confirmCount >= this.confirmBars) {
        this._previousRegime = this._currentRegime;
        this._currentRegime = targetRegime;
        this._pendingRegime = null;
        this._confirmCount = 0;
        return true; // Regime changed
      }
    }
    
    return false;
  }
  
  /**
   * Get the currently active strategy based on regime
   * @returns {string} 'rsi-reversion' | 'momentum'
   */
  getActiveStrategy() {
    return this._currentRegime;
  }
  
  /**
   * Get current Choppiness Index value
   * @returns {number|null} Current CI or null if not calculated yet
   */
  getChoppinessIndex() {
    return this._lastChop;
  }
  
  /**
   * Get regime metrics for logging/debugging
   * @returns {Object} { chop, adx, regime, confirmCount, previousRegime }
   */
  getMetrics() {
    return {
      chop: this._lastChop,
      adx: this._lastAdx,
      regime: this._currentRegime,
      confirmCount: this._confirmCount,
      previousRegime: this._previousRegime,
      pendingRegime: this._pendingRegime,
    };
  }
  
  /**
   * Reset filter to initial state
   */
  reset() {
    this._currentRegime = 'rsi-reversion';
    this._previousRegime = null;
    this._pendingRegime = null;
    this._confirmCount = 0;
    this._highs = [];
    this._lows = [];
    this._atrs = [];
    this._lastChop = null;
    this._lastAdx = null;
  }
}

module.exports = RegimeFilter;

