/**
 * Bar Aggregator - Converts high-frequency ticks into lower-frequency bars
 * 
 * Collects 15-second price updates and aggregates them into 5-minute OHLCV bars
 * for proper technical indicator calculation.
 * 
 * Usage:
 *   const aggregator = new BarAggregator({ barDurationMs: 300000 }); // 5 minutes
 *   
 *   // Every 15 seconds:
 *   aggregator.addTick({ price: 100.5, volume: 1000, timestamp: Date.now() });
 *   
 *   // Check if bar is complete:
 *   const bar = aggregator.getCompletedBar();
 *   if (bar) {
 *     strategy.update(bar); // Update with 5-minute bar
 *   }
 */

class BarAggregator {
  constructor(options = {}) {
    this.barDurationMs = options.barDurationMs || 300000; // Default: 5 minutes
    this.currentBar = null;
    this.completedBars = [];
    this.maxCompletedBars = options.maxCompletedBars || 1000; // Keep last 1000 bars in memory
  }

  /**
   * Add a tick (price update) to the aggregator
   * @param {Object} tick - { price, volume, timestamp, high?, low?, takerBuyBaseVolume? }
   * @returns {Object|null} - Completed bar if bar just closed, null otherwise
   */
  addTick(tick) {
    const { price, volume = 0, timestamp, high, low, takerBuyBaseVolume = 0 } = tick;
    
    if (!Number.isFinite(price) || price <= 0) {
      console.warn('[BarAggregator] Invalid price:', price);
      return null;
    }
    
    const ts = timestamp || Date.now();
    const barStartTime = this._getBarStartTime(ts);
    
    // Check if we need to start a new bar
    if (!this.currentBar || this.currentBar.startTime !== barStartTime) {
      // Close current bar if it exists
      const completedBar = this._closeCurrentBar();
      
      // Start new bar
      this.currentBar = {
        startTime: barStartTime,
        endTime: barStartTime + this.barDurationMs,
        open: price,
        high: high || price,
        low: low || price,
        close: price,
        volume: volume,
        takerBuyBaseVolume: takerBuyBaseVolume, // Track buy volume for CVD calculation
        tickCount: 1,
        firstTickTime: ts,
        lastTickTime: ts,
      };
      
      return completedBar;
    }
    
    // Update current bar
    this.currentBar.high = Math.max(this.currentBar.high, high || price);
    this.currentBar.low = Math.min(this.currentBar.low, low || price);
    this.currentBar.close = price;
    this.currentBar.volume += volume;
    this.currentBar.takerBuyBaseVolume = (this.currentBar.takerBuyBaseVolume || 0) + takerBuyBaseVolume;
    this.currentBar.tickCount++;
    this.currentBar.lastTickTime = ts;
    
    return null;
  }

  /**
   * Get the most recently completed bar (if any)
   * @returns {Object|null} - { open, high, low, close, volume, timestamp, duration }
   */
  getCompletedBar() {
    if (this.completedBars.length === 0) return null;
    return this._formatBar(this.completedBars[this.completedBars.length - 1]);
  }

  /**
   * Get all completed bars
   * @returns {Array} - Array of formatted bars
   */
  getAllCompletedBars() {
    return this.completedBars.map(bar => this._formatBar(bar));
  }

  /**
   * Get the current (incomplete) bar
   * @returns {Object|null} - Current bar or null if no bar started
   */
  getCurrentBar() {
    if (!this.currentBar) return null;
    return this._formatBar(this.currentBar);
  }

  /**
   * Force close the current bar (useful for testing or end-of-session)
   * @returns {Object|null} - Completed bar
   */
  forceCloseCurrentBar() {
    return this._closeCurrentBar();
  }

  /**
   * Reset the aggregator
   */
  reset() {
    this.currentBar = null;
    this.completedBars = [];
  }

  /**
   * Get statistics about the aggregator
   */
  getStats() {
    return {
      currentBar: this.currentBar ? {
        startTime: new Date(this.currentBar.startTime).toISOString(),
        tickCount: this.currentBar.tickCount,
        duration: this.currentBar.lastTickTime - this.currentBar.firstTickTime,
      } : null,
      completedBars: this.completedBars.length,
      barDurationMs: this.barDurationMs,
      barDurationMin: this.barDurationMs / 60000,
    };
  }

  // ========== Private Methods ==========

  /**
   * Get the start time of the bar that contains the given timestamp
   * @private
   */
  _getBarStartTime(timestamp) {
    return Math.floor(timestamp / this.barDurationMs) * this.barDurationMs;
  }

  /**
   * Close the current bar and add it to completed bars
   * @private
   */
  _closeCurrentBar() {
    if (!this.currentBar) return null;
    
    // Add to completed bars
    this.completedBars.push(this.currentBar);
    
    // Trim if we have too many
    if (this.completedBars.length > this.maxCompletedBars) {
      this.completedBars.shift();
    }
    
    const completedBar = this._formatBar(this.currentBar);
    this.currentBar = null;
    
    return completedBar;
  }

  /**
   * Format a bar for external consumption
   * @private
   */
  _formatBar(bar) {
    if (!bar) return null;
    
    return {
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      takerBuyBaseVolume: bar.takerBuyBaseVolume || 0, // For CVD calculation in Predicta
      timestamp: bar.endTime, // Use end time as canonical timestamp
      ts: bar.endTime,
      price: bar.close, // Alias for compatibility
      
      // Metadata
      startTime: bar.startTime,
      endTime: bar.endTime,
      duration: bar.endTime - bar.startTime,
      tickCount: bar.tickCount,
      actualDuration: bar.lastTickTime - bar.firstTickTime,
    };
  }
}

module.exports = BarAggregator;

