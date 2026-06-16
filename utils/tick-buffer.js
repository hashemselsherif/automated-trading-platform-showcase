/**
 * TickBuffer - Maintains a rolling window of price ticks for dynamic indicator calculation
 * 
 * Unlike BarAggregator which waits for discrete bar completion, TickBuffer maintains
 * a continuous rolling window (e.g., last 5 minutes) and generates the current bar
 * on-demand. This allows indicators to update dynamically with each new tick,
 * matching the behavior of modern trading platforms like Jupiter Perps and TradingView.
 * 
 * Key differences from BarAggregator:
 * - No concept of "completed" vs "incomplete" bars
 * - Continuous rolling window (e.g., 15:30:15-15:35:15, then 15:30:30-15:35:30)
 * - Current bar always includes the latest data
 * - Indicators update every tick, not just on bar boundaries
 */

class TickBuffer {
  /**
   * @param {Object} options Configuration options
   * @param {number} options.windowMs Rolling window duration in milliseconds (default: 5 minutes)
   * @param {number} options.maxTicks Maximum ticks to store (prevents memory leak)
   */
  constructor({ windowMs = 5 * 60 * 1000, maxTicks = 1000 } = {}) {
    this.windowMs = windowMs;
    this.maxTicks = maxTicks;
    this.ticks = [];
    this._lastCleanup = Date.now();
  }

  /**
   * Add a new tick to the buffer
   * @param {Object} tick Tick data
   * @param {number} tick.price Price at this tick
   * @param {number} tick.volume Volume (optional, default 0)
   * @param {number} tick.timestamp Timestamp in milliseconds
   * @param {number} tick.high High price (optional, defaults to price)
   * @param {number} tick.low Low price (optional, defaults to price)
   */
  addTick({ price, volume = 0, timestamp = Date.now(), high, low }) {
    // Validate inputs
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid price: ${price}`);
    }
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error(`Invalid timestamp: ${timestamp}`);
    }

    // Add tick
    this.ticks.push({
      price,
      volume: Math.max(0, volume),
      timestamp,
      high: Number.isFinite(high) ? high : price,
      low: Number.isFinite(low) ? low : price,
    });

    // Cleanup old ticks (only every 5 ticks to reduce overhead)
    if (this.ticks.length % 5 === 0 || Date.now() - this._lastCleanup > 60000) {
      this._cleanup(timestamp);
      this._lastCleanup = Date.now();
    }

    // Prevent memory leak
    if (this.ticks.length > this.maxTicks) {
      const excess = this.ticks.length - this.maxTicks;
      this.ticks.splice(0, excess);
      console.warn(`[TickBuffer] Removed ${excess} excess ticks (max: ${this.maxTicks})`);
    }
  }

  /**
   * Remove ticks older than the rolling window
   * @private
   */
  _cleanup(currentTimestamp) {
    const cutoff = currentTimestamp - this.windowMs;
    let removed = 0;

    while (this.ticks.length > 0 && this.ticks[0].timestamp < cutoff) {
      this.ticks.shift();
      removed++;
    }

    if (removed > 0 && removed > 10) {
      // Only log if significant cleanup (avoid spam)
      console.log(`[TickBuffer] Cleaned up ${removed} old ticks (cutoff: ${new Date(cutoff).toISOString()})`);
    }
  }

  /**
   * Get the current bar (OHLCV) from all ticks in the rolling window
   * This represents the aggregated data for the last N minutes
   * 
   * @returns {Object|null} Current bar or null if no ticks
   */
  getCurrentBar() {
    if (this.ticks.length === 0) {
      return null;
    }

    // Extract prices for high/low calculation
    const prices = this.ticks.map(t => t.price);
    const highs = this.ticks.map(t => t.high);
    const lows = this.ticks.map(t => t.low);

    return {
      open: this.ticks[0].price,
      high: Math.max(...highs),
      low: Math.min(...lows),
      close: this.ticks[this.ticks.length - 1].price,
      volume: this.ticks.reduce((sum, t) => sum + t.volume, 0),
      timestamp: this.ticks[this.ticks.length - 1].timestamp,
      tickCount: this.ticks.length,
      windowStart: this.ticks[0].timestamp,
      windowEnd: this.ticks[this.ticks.length - 1].timestamp,
    };
  }

  /**
   * Get the number of ticks currently in the buffer
   * @returns {number} Tick count
   */
  getTickCount() {
    return this.ticks.length;
  }

  /**
   * Get the age of the oldest tick in the buffer
   * @returns {number} Age in milliseconds
   */
  getOldestTickAge() {
    if (this.ticks.length === 0) return 0;
    return Date.now() - this.ticks[0].timestamp;
  }

  /**
   * Get the duration covered by current ticks
   * @returns {number} Duration in milliseconds
   */
  getWindowDuration() {
    if (this.ticks.length === 0) return 0;
    return this.ticks[this.ticks.length - 1].timestamp - this.ticks[0].timestamp;
  }

  /**
   * Get window progress as a percentage (how much of the window is filled)
   * @returns {number} Progress percentage (0-100)
   */
  getWindowProgress() {
    if (this.ticks.length === 0) return 0;
    const duration = this.getWindowDuration();
    return Math.min(100, (duration / this.windowMs) * 100);
  }

  /**
   * Check if the buffer has enough data for reliable indicator calculation
   * @param {number} minTicks Minimum number of ticks required
   * @returns {boolean} True if buffer has enough data
   */
  isReady(minTicks = 20) {
    return this.ticks.length >= minTicks && this.getWindowProgress() >= 80;
  }

  /**
   * Get buffer statistics for debugging
   * @returns {Object} Statistics
   */
  getStats() {
    const bar = this.getCurrentBar();
    return {
      tickCount: this.ticks.length,
      windowMs: this.windowMs,
      windowDuration: this.getWindowDuration(),
      windowProgress: this.getWindowProgress().toFixed(1) + '%',
      oldestTickAge: this.getOldestTickAge(),
      ready: this.isReady(),
      currentBar: bar ? {
        open: bar.open.toFixed(2),
        high: bar.high.toFixed(2),
        low: bar.low.toFixed(2),
        close: bar.close.toFixed(2),
        volume: bar.volume.toFixed(2),
      } : null,
    };
  }

  /**
   * Clear all ticks (useful for testing or reset)
   */
  clear() {
    this.ticks = [];
    this._lastCleanup = Date.now();
  }

  /**
   * Seed the buffer with historical bars (for warmup)
   * Converts completed bars into ticks to populate the buffer
   * 
   * @param {Array} bars Array of historical OHLCV bars
   */
  seedFromBars(bars) {
    if (!Array.isArray(bars) || bars.length === 0) {
      console.warn('[TickBuffer] seedFromBars called with empty array');
      return;
    }

    // Clear existing ticks
    this.clear();

    // Convert each bar into multiple ticks (simulate intra-bar price movement)
    for (const bar of bars) {
      // Create ticks at open, high, low, and close
      // This gives a reasonable approximation of intra-bar movement
      const barDuration = this.windowMs; // Assume bars are same duration as window
      const tickInterval = barDuration / 4; // 4 ticks per bar (open, high, low, close)

      // Tick 1: Open
      this.ticks.push({
        price: bar.open,
        volume: bar.volume / 4,
        timestamp: bar.ts || bar.timestamp,
        high: bar.open,
        low: bar.open,
      });

      // Tick 2: High
      this.ticks.push({
        price: bar.high,
        volume: bar.volume / 4,
        timestamp: (bar.ts || bar.timestamp) + tickInterval,
        high: bar.high,
        low: bar.high,
      });

      // Tick 3: Low
      this.ticks.push({
        price: bar.low,
        volume: bar.volume / 4,
        timestamp: (bar.ts || bar.timestamp) + tickInterval * 2,
        high: bar.low,
        low: bar.low,
      });

      // Tick 4: Close
      this.ticks.push({
        price: bar.close,
        volume: bar.volume / 4,
        timestamp: (bar.ts || bar.timestamp) + tickInterval * 3,
        high: bar.close,
        low: bar.close,
      });
    }

    // Keep only ticks within the rolling window
    if (this.ticks.length > 0) {
      const latestTimestamp = this.ticks[this.ticks.length - 1].timestamp;
      this._cleanup(latestTimestamp);
    }

    console.log(`[TickBuffer] Seeded with ${bars.length} bars → ${this.ticks.length} ticks (window: ${(this.windowMs / 1000).toFixed(0)}s)`);
  }
}

module.exports = TickBuffer;

