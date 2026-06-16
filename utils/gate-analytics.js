// gate-analytics.js
// Tracks which gates are blocking entry signals the most

class GateAnalytics {
  constructor() {
    // Store gate blocking statistics
    // Structure: { market: { side: { gateName: count } } }
    this.gateStats = new Map();
    
    // Track total evaluations per market/side
    this.totalEvaluations = new Map();
    
    // Time window for statistics (default: last 24 hours)
    this.timeWindowMs = 24 * 60 * 60 * 1000;
    
    // Store timestamps for each gate block (for time-based filtering)
    this.gateBlocks = [];
    
    // Maximum number of blocks to keep in memory (reduced for efficiency)
    // Since we're sampling passes, failures are the minority, so we need less storage
    this.maxBlocks = 5000;
    
    // Track last cleanup time to avoid frequent cleanup operations
    this._lastCleanup = Date.now();
    this._cleanupInterval = 5 * 60 * 1000; // Cleanup every 5 minutes
  }

  /**
   * Increment evaluation count (lightweight, for sampled passes)
   * @param {string} market - Market name
   * @param {string} side - 'long' or 'short'
   * @param {number} sampleRate - Sample rate used (to account for sampling)
   */
  incrementEvaluationCount(market, side, sampleRate = 1) {
    const key = `${market}:${side}`;
    const currentTotal = this.totalEvaluations.get(key) || 0;
    // Account for sampling: if we sample 1 in 20, each recorded pass represents 20 actual passes
    this.totalEvaluations.set(key, currentTotal + sampleRate);
  }

  /**
   * Record a gate evaluation result
   * @param {string} market - Market name (e.g., 'BTC-PERP')
   * @param {string} side - 'long' or 'short'
   * @param {boolean} passed - Whether gates passed
   * @param {Object} gateStatus - Detailed gate status object
   * @param {number} sampleRate - Sample rate used (default: 1, meaning no sampling)
   */
  recordEvaluation(market, side, passed, gateStatus = {}, sampleRate = 1) {
    const key = `${market}:${side}`;
    
    // Increment total evaluations (account for sampling)
    const currentTotal = this.totalEvaluations.get(key) || 0;
    this.totalEvaluations.set(key, currentTotal + sampleRate);
    
    // If gates passed, just update counter (no further processing needed)
    if (passed) {
      return;
    }
    
    // Only process failures (they're the minority, so this is efficient)
    // Track which gates failed
    const failedGates = gateStatus ? this._getFailedGates(side, gateStatus) : ['unknown'];
    
    // Record each failed gate (increment counters - very fast)
    for (const gateName of failedGates) {
      this._incrementGate(market, side, gateName);
    }
    
    // Store block event with timestamp (only for failures)
    // Use circular buffer approach: only store recent blocks, cleanup periodically
    const now = Date.now();
    this.gateBlocks.push({
      timestamp: now,
      market,
      side,
      failedGates,
    });
    
    // Periodic cleanup: only when needed (reduces overhead)
    // Cleanup when array is large OR periodically (every 5 minutes)
    const shouldCleanup = (this.gateBlocks.length > this.maxBlocks) || 
                         (now - this._lastCleanup > this._cleanupInterval);
    
    if (shouldCleanup) {
      const cutoff = now - this.timeWindowMs;
      // Use filter once when needed, not on every insert
      this.gateBlocks = this.gateBlocks.filter(block => block.timestamp > cutoff);
      this._lastCleanup = now;
    }
  }

  /**
   * Extract failed gate names from gate status
   * @param {string} side - 'long' or 'short'
   * @param {Object} gateStatus - Gate status object
   * @returns {Array<string>} Array of failed gate names
   */
  _getFailedGates(side, gateStatus) {
    const failedGates = [];
    
    // Define gate names based on side
    const gateChecks = side === 'long' ? [
      { name: 'aboveMA', check: gateStatus.aboveMA },
      { name: 'maSlopeUp', check: gateStatus.maSlopeUp },
      { name: 'trendOK', check: gateStatus.trendOK },
      { name: 'donUpOK', check: gateStatus.donUpOK },
      { name: 'regimeLongOK', check: gateStatus.regimeLongOK },
      { name: 'longHTFOK', check: gateStatus.longHTFOK },
      { name: 'rsiLongOK', check: gateStatus.rsiLongOK },
      { name: 'adxLongOK', check: gateStatus.adxLongOK },
      { name: 'bandLongOK', check: gateStatus.bandLongOK },
      { name: 'volumeOK', check: gateStatus.volumeOK },
      { name: 'cooldownLongOK', check: gateStatus.cooldownLongOK },
      { name: 'flipLongOK', check: gateStatus.flipLongOK },
      { name: 'diLongOK', check: gateStatus.diLongOK },
      { name: 'retestOKlong', check: gateStatus.retestOKlong },
      { name: 'adxSlopeOK', check: gateStatus.adxSlopeOK },
      { name: 'entryDistLongOK', check: gateStatus.entryDistLongOK },
      { name: 'timeGateOK', check: gateStatus.timeGateOK },
    ] : [
      { name: 'belowMA', check: gateStatus.belowMA },
      { name: 'maSlopeDn', check: gateStatus.maSlopeDn },
      { name: 'trendOK', check: gateStatus.trendOK },
      { name: 'donDnOK', check: gateStatus.donDnOK },
      { name: 'regimeShortOK', check: gateStatus.regimeShortOK },
      { name: 'shortHTFOK', check: gateStatus.shortHTFOK },
      { name: 'rsiShortOK', check: gateStatus.rsiShortOK },
      { name: 'adxShortOK', check: gateStatus.adxShortOK },
      { name: 'bandShortOK', check: gateStatus.bandShortOK },
      { name: 'volumeOK', check: gateStatus.volumeOK },
      { name: 'cooldownShortOK', check: gateStatus.cooldownShortOK },
      { name: 'flipShortOK', check: gateStatus.flipShortOK },
      { name: 'diShortOK', check: gateStatus.diShortOK },
      { name: 'retestOKshort', check: gateStatus.retestOKshort },
      { name: 'htfSlopeNegative', check: gateStatus.htfSlopeNegative },
      { name: 'vetoShortsGreenDay', check: !gateStatus.vetoShortsGreenDay }, // Inverted: true means blocked
      { name: 'adxSlopeOK', check: gateStatus.adxSlopeOK },
      { name: 'entryDistShortOK', check: gateStatus.entryDistShortOK },
      { name: 'timeGateOK', check: gateStatus.timeGateOK },
    ];
    
    for (const { name, check } of gateChecks) {
      if (check === false) {
        failedGates.push(name);
      }
    }
    
    return failedGates;
  }

  /**
   * Increment count for a specific gate block
   */
  _incrementGate(market, side, gateName) {
    if (!this.gateStats.has(market)) {
      this.gateStats.set(market, new Map());
    }
    const marketStats = this.gateStats.get(market);
    
    if (!marketStats.has(side)) {
      marketStats.set(side, new Map());
    }
    const sideStats = marketStats.get(side);
    
    const currentCount = sideStats.get(gateName) || 0;
    sideStats.set(gateName, currentCount + 1);
  }

  /**
   * Get gate statistics for a specific market and side
   * @param {string} market - Market name (optional, if not provided returns all)
   * @param {string} side - 'long' or 'short' (optional)
   * @param {number} timeWindowMs - Time window in milliseconds (optional)
   * @returns {Object} Gate statistics
   */
  getStats(market = null, side = null, timeWindowMs = null) {
    const window = timeWindowMs || this.timeWindowMs;
    const cutoff = Date.now() - window;
    
    // Filter blocks by time window
    const recentBlocks = this.gateBlocks.filter(block => block.timestamp > cutoff);
    
    // Recalculate stats from recent blocks
    const stats = {};
    const totals = {};
    
    for (const block of recentBlocks) {
      if (market && block.market !== market) continue;
      if (side && block.side !== side) continue;
      
      const key = `${block.market}:${block.side}`;
      if (!stats[key]) {
        stats[key] = {};
        totals[key] = 0;
      }
      
      for (const gateName of block.failedGates) {
        stats[key][gateName] = (stats[key][gateName] || 0) + 1;
        totals[key] += 1;
      }
    }
    
    // Convert to array format with percentages
    const result = {};
    for (const [key, gateCounts] of Object.entries(stats)) {
      const total = totals[key];
      const [mkt, sde] = key.split(':');
      
      if (!result[mkt]) result[mkt] = {};
      if (!result[mkt][sde]) result[mkt][sde] = [];
      
      const gateArray = Object.entries(gateCounts)
        .map(([gateName, count]) => ({
          gate: gateName,
          count,
          percentage: total > 0 ? (count / total * 100).toFixed(1) : 0,
        }))
        .sort((a, b) => b.count - a.count);
      
      const totalEvals = this.totalEvaluations.get(key) || 0;
      // Calculate pass rate: (evaluations - blocks) / evaluations * 100
      // Clamp to 0-100 range to handle edge cases
      let passRate = '100.0';
      if (totalEvals > 0) {
        const passes = Math.max(0, totalEvals - total);
        const rate = (passes / totalEvals) * 100;
        passRate = Math.max(0, Math.min(100, rate)).toFixed(1);
      } else if (total > 0) {
        passRate = '0.0'; // Had blocks but no evaluations recorded
      }
      
      result[mkt][sde] = {
        gates: gateArray,
        totalBlocks: total,
        totalEvaluations: totalEvals,
        passRate,
      };
    }
    
    return result;
  }

  /**
   * Get summary statistics across all markets
   * @param {number} timeWindowMs - Time window in milliseconds (optional)
   * @returns {Object} Summary statistics
   */
  getSummary(timeWindowMs = null) {
    const stats = this.getStats(null, null, timeWindowMs);
    
    // Aggregate across all markets and sides
    const gateTotals = {};
    let totalBlocks = 0;
    let totalEvaluations = 0;
    
    for (const [market, sides] of Object.entries(stats)) {
      for (const [side, data] of Object.entries(sides)) {
        totalBlocks += data.totalBlocks;
        totalEvaluations += data.totalEvaluations;
        
        for (const gate of data.gates) {
          gateTotals[gate.gate] = (gateTotals[gate.gate] || 0) + gate.count;
        }
      }
    }
    
    // Convert to sorted array
    const topGates = Object.entries(gateTotals)
      .map(([gate, count]) => ({
        gate,
        count,
        percentage: totalBlocks > 0 ? (count / totalBlocks * 100).toFixed(1) : 0,
      }))
      .sort((a, b) => b.count - a.count);
    
    // Calculate overall pass rate (clamp to 0-100 range)
    let overallPassRate = '100.0';
    if (totalEvaluations > 0) {
      const passes = Math.max(0, totalEvaluations - totalBlocks);
      const rate = (passes / totalEvaluations) * 100;
      overallPassRate = Math.max(0, Math.min(100, rate)).toFixed(1);
    } else if (totalBlocks > 0) {
      overallPassRate = '0.0'; // Had blocks but no evaluations recorded
    }
    
    return {
      topGates,
      totalBlocks,
      totalEvaluations,
      overallPassRate,
      markets: Object.keys(stats).length,
    };
  }

  /**
   * Clear old data beyond time window
   */
  cleanup() {
    const cutoff = Date.now() - this.timeWindowMs;
    this.gateBlocks = this.gateBlocks.filter(block => block.timestamp > cutoff);
  }

  /**
   * Reset all statistics
   */
  reset() {
    this.gateStats.clear();
    this.totalEvaluations.clear();
    this.gateBlocks = [];
  }
}

// Singleton instance
let instance = null;

function getGateAnalytics() {
  if (!instance) {
    instance = new GateAnalytics();
  }
  return instance;
}

module.exports = { GateAnalytics, getGateAnalytics };

