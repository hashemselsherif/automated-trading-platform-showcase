/**
 * Smart Levels Tracker
 * 
 * Tracks institutional-grade price levels for scalping strategy:
 * - Session pivots (previous day/hour high/low)
 * - Liquidity pools (equal highs/lows, swing points)
 * - Fair Value Gaps (FVGs / imbalances)
 * - Liquidity sweeps (stop hunts)
 * 
 * Design:
 * - Bar-level formation (1-min bars): Identify pivots, pools, FVGs
 * - Tick-level checks (1s bot loop): Detect sweeps, proximity, fills
 * 
 * Data source: Pyth WebSocket (400ms updates) + aggregated 1-min bars
 */

class SmartLevelsTracker {
  constructor(options = {}) {
    this.market = options.market || 'UNKNOWN';
    this.config = {
      // Pivot detection
      swingLookback: options.swingLookback || 5, // Bars to look back for swing high/low
      equalThresholdPct: options.equalThresholdPct || 0.0005, // 0.05% tolerance for "equal" levels
      
      // Liquidity pool detection
      minPoolTouches: options.minPoolTouches || 2, // Min touches to qualify as liquidity pool
      poolMergeDistancePct: options.poolMergeDistancePct || 0.001, // 0.1% - merge nearby pools
      
      // Fair Value Gap (FVG) detection
      minFVGSizePct: options.minFVGSizePct || 0.002, // 0.2% - minimum gap size
      maxFVGAgeBars: options.maxFVGAgeBars || 20, // Max 20 bars to keep FVG active
      
      // Liquidity sweep detection
      sweepWickPct: options.sweepWickPct || 0.0005, // 0.05% wick beyond level = sweep
      sweepReversalBars: options.sweepReversalBars || 3, // Bars to confirm reversal after sweep
      
      // Proximity detection
      proximityPct: options.proximityPct || 0.001, // 0.1% - "near" a level
    };
    
    // BAR-LEVEL STATE (updated once per 1-min bar completion)
    this.sessionPivots = {
      prevDayHigh: null,
      prevDayLow: null,
      prevDayOpen: null,
      prevHourHigh: null,
      prevHourLow: null,
      prevHourOpen: null,
      todayOpen: null,
      currentDayHigh: null,
      currentDayLow: null,
    };
    
    this.liquidityPools = []; // Array of { price, type: 'high'|'low', touches, lastTouch, strength }
    this.activeGaps = []; // Array of { top, bottom, size, createdAt, barsSinceCreated, filled }
    this.swingPoints = []; // Array of { price, type: 'high'|'low', barIndex, confirmed }
    
    // TICK-LEVEL STATE (updated every bot loop - 1s)
    this.currentTickPrice = null;
    this.prevTickPrice = null;
    this.tickHigh = null; // Highest price in current tick
    this.tickLow = null; // Lowest price in current tick
    this.tickTimestamp = null;
    
    // Sweep tracking
    this.recentSweeps = []; // Array of { price, level, type: 'high'|'low', timestamp }
    this.maxRecentSweeps = 10; // Keep last 10 sweeps
    
    // Bar tracking
    this.barIndex = 0; // Increments with each bar
    this.lastBarTimestamp = null;
    
    // Statistics
    this.stats = {
      totalBars: 0,
      totalTicks: 0,
      liquidityPoolsDetected: 0,
      fvgsDetected: 0,
      sweepsDetected: 0,
      pivotUpdates: 0,
    };
  }
  
  /**
   * Update tick-level state (called every bot loop - 1s)
   * Detects real-time sweeps, tracks current price movement
   */
  updateTick(price, timestamp) {
    if (!Number.isFinite(price) || price <= 0) {
      return;
    }
    
    this.prevTickPrice = this.currentTickPrice;
    this.currentTickPrice = price;
    this.tickTimestamp = timestamp || Date.now();
    
    // Track tick high/low
    if (this.tickHigh === null || price > this.tickHigh) {
      this.tickHigh = price;
    }
    if (this.tickLow === null || price < this.tickLow) {
      this.tickLow = price;
    }
    
    // Detect liquidity sweeps in real-time
    if (this.prevTickPrice !== null) {
      this._detectLiquiditySweeps(this.prevTickPrice, price, timestamp);
    }
    
    this.stats.totalTicks++;
  }
  
  /**
   * Update bar-level state (called when 1-min bar completes)
   * Forms pivots, detects liquidity pools and FVGs
   */
  updateBar(candles) {
    if (!candles || candles.length === 0) {
      return;
    }
    
    const latestBar = candles[candles.length - 1];
    this.barIndex++;
    this.stats.totalBars++;
    this.lastBarTimestamp = latestBar.timestamp || Date.now();
    
    // Reset tick high/low for new bar
    this.tickHigh = null;
    this.tickLow = null;
    
    // Update session pivots (day/hour boundaries)
    this._updateSessionPivots(candles);
    
    // Detect swing points (potential liquidity pools)
    this._detectSwingPoints(candles);
    
    // Update liquidity pools (aggregate swing points)
    this._updateLiquidityPools(candles);
    
    // Detect Fair Value Gaps (FVGs)
    this._detectFairValueGaps(candles);
    
    // Age out old FVGs
    this._ageOutFVGs();
    
    // Check if any FVGs got filled this bar
    this._checkFVGFills(latestBar);
  }
  
  /**
   * Update session pivots (previous day/hour high/low)
   */
  _updateSessionPivots(candles) {
    if (candles.length < 2) return;
    
    const latest = candles[candles.length - 1];
    const latestTime = new Date(latest.timestamp || Date.now());
    
    // Previous bar
    const prev = candles[candles.length - 2];
    const prevTime = new Date(prev.timestamp || Date.now());
    
    // Check for day boundary (UTC midnight)
    if (latestTime.getUTCDate() !== prevTime.getUTCDate()) {
      // New day started - save yesterday's pivots
      this.sessionPivots.prevDayHigh = this.sessionPivots.currentDayHigh;
      this.sessionPivots.prevDayLow = this.sessionPivots.currentDayLow;
      this.sessionPivots.prevDayOpen = this.sessionPivots.todayOpen;
      
      // Reset current day tracking
      this.sessionPivots.todayOpen = latest.open;
      this.sessionPivots.currentDayHigh = latest.high;
      this.sessionPivots.currentDayLow = latest.low;
      
      this.stats.pivotUpdates++;
      console.log(`[Smart Levels] ${this.market} Day pivot update: H=${this.sessionPivots.prevDayHigh?.toFixed(2)} L=${this.sessionPivots.prevDayLow?.toFixed(2)}`);
    } else {
      // Update current day high/low
      if (this.sessionPivots.currentDayHigh === null || latest.high > this.sessionPivots.currentDayHigh) {
        this.sessionPivots.currentDayHigh = latest.high;
      }
      if (this.sessionPivots.currentDayLow === null || latest.low < this.sessionPivots.currentDayLow) {
        this.sessionPivots.currentDayLow = latest.low;
      }
    }
    
    // Check for hour boundary
    if (latestTime.getUTCHours() !== prevTime.getUTCHours()) {
      // New hour started - save previous hour's pivots
      this.sessionPivots.prevHourHigh = this._getHourHigh(candles, prevTime);
      this.sessionPivots.prevHourLow = this._getHourLow(candles, prevTime);
      this.sessionPivots.prevHourOpen = this._getHourOpen(candles, prevTime);
      
      this.stats.pivotUpdates++;
    }
  }
  
  /**
   * Get highest price in previous hour
   */
  _getHourHigh(candles, hourTime) {
    const hourStart = new Date(hourTime);
    hourStart.setUTCMinutes(0, 0, 0);
    
    let high = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      const barTime = new Date(candles[i].timestamp || Date.now());
      if (barTime < hourStart) break;
      
      if (high === null || candles[i].high > high) {
        high = candles[i].high;
      }
    }
    
    return high;
  }
  
  /**
   * Get lowest price in previous hour
   */
  _getHourLow(candles, hourTime) {
    const hourStart = new Date(hourTime);
    hourStart.setUTCMinutes(0, 0, 0);
    
    let low = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      const barTime = new Date(candles[i].timestamp || Date.now());
      if (barTime < hourStart) break;
      
      if (low === null || candles[i].low < low) {
        low = candles[i].low;
      }
    }
    
    return low;
  }
  
  /**
   * Get opening price of hour
   */
  _getHourOpen(candles, hourTime) {
    const hourStart = new Date(hourTime);
    hourStart.setUTCMinutes(0, 0, 0);
    
    for (let i = candles.length - 1; i >= 0; i--) {
      const barTime = new Date(candles[i].timestamp || Date.now());
      if (barTime < hourStart) break;
      if (barTime >= hourStart) {
        return candles[i].open;
      }
    }
    
    return null;
  }
  
  /**
   * Detect swing points (local highs and lows)
   */
  _detectSwingPoints(candles) {
    if (candles.length < this.config.swingLookback * 2 + 1) {
      return; // Not enough data
    }
    
    const lookback = this.config.swingLookback;
    const pivotIndex = candles.length - lookback - 1; // Check middle bar
    
    if (pivotIndex < 0) return;
    
    const pivotBar = candles[pivotIndex];
    
    // Check for swing high (higher than surrounding bars)
    let isSwingHigh = true;
    for (let i = pivotIndex - lookback; i <= pivotIndex + lookback; i++) {
      if (i === pivotIndex) continue;
      if (i < 0 || i >= candles.length) continue;
      
      if (candles[i].high >= pivotBar.high) {
        isSwingHigh = false;
        break;
      }
    }
    
    if (isSwingHigh) {
      this.swingPoints.push({
        price: pivotBar.high,
        type: 'high',
        barIndex: this.barIndex - lookback,
        confirmed: true,
        timestamp: pivotBar.timestamp,
      });
    }
    
    // Check for swing low (lower than surrounding bars)
    let isSwingLow = true;
    for (let i = pivotIndex - lookback; i <= pivotIndex + lookback; i++) {
      if (i === pivotIndex) continue;
      if (i < 0 || i >= candles.length) continue;
      
      if (candles[i].low <= pivotBar.low) {
        isSwingLow = false;
        break;
      }
    }
    
    if (isSwingLow) {
      this.swingPoints.push({
        price: pivotBar.low,
        type: 'low',
        barIndex: this.barIndex - lookback,
        confirmed: true,
        timestamp: pivotBar.timestamp,
      });
    }
    
    // Keep only recent swing points (last 50)
    if (this.swingPoints.length > 50) {
      this.swingPoints = this.swingPoints.slice(-50);
    }
  }
  
  /**
   * Update liquidity pools (clusters of equal highs/lows)
   */
  _updateLiquidityPools(candles) {
    if (this.swingPoints.length < 2) return;
    
    // Group swing points by price (within tolerance)
    const pools = new Map(); // price -> {type, touches, lastTouch}
    
    for (const swing of this.swingPoints) {
      let foundPool = false;
      
      // Check if swing matches existing pool
      for (const [poolPrice, pool] of pools.entries()) {
        if (pool.type !== swing.type) continue;
        
        const distancePct = Math.abs(swing.price - poolPrice) / poolPrice;
        if (distancePct <= this.config.equalThresholdPct) {
          // Found matching pool
          pool.touches++;
          pool.lastTouch = swing.timestamp;
          pool.prices.push(swing.price);
          foundPool = true;
          break;
        }
      }
      
      // Create new pool if no match
      if (!foundPool) {
        pools.set(swing.price, {
          type: swing.type,
          touches: 1,
          lastTouch: swing.timestamp,
          prices: [swing.price],
        });
      }
    }
    
    // Convert to liquidity pools (min 2 touches)
    this.liquidityPools = [];
    for (const [price, pool] of pools.entries()) {
      if (pool.touches >= this.config.minPoolTouches) {
        // Calculate average price of all touches
        const avgPrice = pool.prices.reduce((sum, p) => sum + p, 0) / pool.prices.length;
        
        this.liquidityPools.push({
          price: avgPrice,
          type: pool.type,
          touches: pool.touches,
          lastTouch: pool.lastTouch,
          strength: pool.touches, // More touches = stronger pool
        });
        
        this.stats.liquidityPoolsDetected++;
      }
    }
    
    // Sort by strength (descending)
    this.liquidityPools.sort((a, b) => b.strength - a.strength);
    
    // Keep only top 10 strongest pools
    if (this.liquidityPools.length > 10) {
      this.liquidityPools = this.liquidityPools.slice(0, 10);
    }
  }
  
  /**
   * Detect Fair Value Gaps (FVGs / imbalances)
   */
  _detectFairValueGaps(candles) {
    if (candles.length < 3) return;
    
    // FVG: 3-bar pattern where bar 1 high < bar 3 low (bullish) or bar 1 low > bar 3 high (bearish)
    const bar1 = candles[candles.length - 3];
    const bar2 = candles[candles.length - 2]; // Middle bar (imbalance)
    const bar3 = candles[candles.length - 1];
    
    // Bullish FVG (gap up)
    if (bar1.high < bar3.low) {
      const gapSize = bar3.low - bar1.high;
      const gapSizePct = gapSize / bar1.high;
      
      if (gapSizePct >= this.config.minFVGSizePct) {
        this.activeGaps.push({
          top: bar3.low,
          bottom: bar1.high,
          size: gapSize,
          sizePct: gapSizePct,
          type: 'bullish',
          createdAt: this.barIndex,
          barsSinceCreated: 0,
          filled: false,
          timestamp: bar3.timestamp,
        });
        
        this.stats.fvgsDetected++;
      }
    }
    
    // Bearish FVG (gap down)
    if (bar1.low > bar3.high) {
      const gapSize = bar1.low - bar3.high;
      const gapSizePct = gapSize / bar3.high;
      
      if (gapSizePct >= this.config.minFVGSizePct) {
        this.activeGaps.push({
          top: bar1.low,
          bottom: bar3.high,
          size: gapSize,
          sizePct: gapSizePct,
          type: 'bearish',
          createdAt: this.barIndex,
          barsSinceCreated: 0,
          filled: false,
          timestamp: bar3.timestamp,
        });
        
        this.stats.fvgsDetected++;
      }
    }
  }
  
  /**
   * Age out old FVGs
   */
  _ageOutFVGs() {
    for (const gap of this.activeGaps) {
      gap.barsSinceCreated = this.barIndex - gap.createdAt;
    }
    
    // Remove FVGs older than max age
    this.activeGaps = this.activeGaps.filter(gap => {
      return gap.barsSinceCreated <= this.config.maxFVGAgeBars && !gap.filled;
    });
  }
  
  /**
   * Check if any FVGs got filled this bar
   */
  _checkFVGFills(bar) {
    for (const gap of this.activeGaps) {
      if (gap.filled) continue;
      
      // Bullish FVG is filled if price drops into the gap
      if (gap.type === 'bullish' && bar.low <= gap.top && bar.low >= gap.bottom) {
        gap.filled = true;
        gap.filledAt = this.barIndex;
        gap.filledPrice = bar.low;
      }
      
      // Bearish FVG is filled if price rises into the gap
      if (gap.type === 'bearish' && bar.high >= gap.bottom && bar.high <= gap.top) {
        gap.filled = true;
        gap.filledAt = this.barIndex;
        gap.filledPrice = bar.high;
      }
    }
  }
  
  /**
   * Detect liquidity sweeps in real-time (tick-level)
   */
  _detectLiquiditySweeps(prevPrice, currentPrice, timestamp) {
    const sweepThreshold = this.config.sweepWickPct;
    
    // Check sweeps of session pivots
    const pivots = [
      { price: this.sessionPivots.prevDayHigh, type: 'high', level: 'prevDayHigh' },
      { price: this.sessionPivots.prevDayLow, type: 'low', level: 'prevDayLow' },
      { price: this.sessionPivots.prevHourHigh, type: 'high', level: 'prevHourHigh' },
      { price: this.sessionPivots.prevHourLow, type: 'low', level: 'prevHourLow' },
    ];
    
    for (const pivot of pivots) {
      if (pivot.price === null) continue;
      
      if (pivot.type === 'high') {
        // High sweep: Price briefly exceeds high then reverses
        const exceededBy = currentPrice - pivot.price;
        const exceededPct = exceededBy / pivot.price;
        
        if (prevPrice <= pivot.price && currentPrice > pivot.price && exceededPct <= sweepThreshold) {
          this._recordSweep(pivot.price, pivot.level, 'high', timestamp);
        }
      } else {
        // Low sweep: Price briefly drops below low then reverses
        const droppedBy = pivot.price - currentPrice;
        const droppedPct = droppedBy / pivot.price;
        
        if (prevPrice >= pivot.price && currentPrice < pivot.price && droppedPct <= sweepThreshold) {
          this._recordSweep(pivot.price, pivot.level, 'low', timestamp);
        }
      }
    }
    
    // Check sweeps of liquidity pools
    for (const pool of this.liquidityPools) {
      if (pool.type === 'high') {
        const exceededBy = currentPrice - pool.price;
        const exceededPct = exceededBy / pool.price;
        
        if (prevPrice <= pool.price && currentPrice > pool.price && exceededPct <= sweepThreshold) {
          this._recordSweep(pool.price, 'liquidityPool', 'high', timestamp);
        }
      } else {
        const droppedBy = pool.price - currentPrice;
        const droppedPct = droppedBy / pool.price;
        
        if (prevPrice >= pool.price && currentPrice < pool.price && droppedPct <= sweepThreshold) {
          this._recordSweep(pool.price, 'liquidityPool', 'low', timestamp);
        }
      }
    }
  }
  
  /**
   * Record a liquidity sweep
   */
  _recordSweep(price, level, type, timestamp) {
    this.recentSweeps.unshift({
      price,
      level,
      type,
      timestamp: timestamp || Date.now(),
    });
    
    // Keep only recent sweeps
    if (this.recentSweeps.length > this.maxRecentSweeps) {
      this.recentSweeps.pop();
    }
    
    this.stats.sweepsDetected++;
    
    console.log(`[Smart Levels] ${this.market} Liquidity sweep: ${type} @ ${price.toFixed(2)} (${level})`);
  }
  
  /**
   * Check if current price is near a pivot
   */
  checkPivotProximity(price) {
    if (!price || !Number.isFinite(price)) return null;
    
    const proximityPct = this.config.proximityPct;
    const pivots = [
      { price: this.sessionPivots.prevDayHigh, label: 'prevDayHigh' },
      { price: this.sessionPivots.prevDayLow, label: 'prevDayLow' },
      { price: this.sessionPivots.prevHourHigh, label: 'prevHourHigh' },
      { price: this.sessionPivots.prevHourLow, label: 'prevHourLow' },
      { price: this.sessionPivots.todayOpen, label: 'todayOpen' },
    ];
    
    for (const pivot of pivots) {
      if (pivot.price === null) continue;
      
      const distancePct = Math.abs(price - pivot.price) / pivot.price;
      if (distancePct <= proximityPct) {
        return {
          pivot: pivot.label,
          price: pivot.price,
          distance: price - pivot.price,
          distancePct,
        };
      }
    }
    
    return null;
  }
  
  /**
   * Check if current price is near a liquidity pool
   */
  checkLiquidityPoolProximity(price) {
    if (!price || !Number.isFinite(price)) return null;
    
    const proximityPct = this.config.proximityPct;
    
    for (const pool of this.liquidityPools) {
      const distancePct = Math.abs(price - pool.price) / pool.price;
      if (distancePct <= proximityPct) {
        return {
          pool,
          distance: price - pool.price,
          distancePct,
        };
      }
    }
    
    return null;
  }
  
  /**
   * Check if there's an unfilled FVG near current price
   */
  checkUnfilledFVG(price) {
    if (!price || !Number.isFinite(price)) return null;
    
    for (const gap of this.activeGaps) {
      if (gap.filled) continue;
      
      // Check if price is within the gap
      if (price >= gap.bottom && price <= gap.top) {
        return gap;
      }
    }
    
    return null;
  }
  
  /**
   * Get recent sweep (within last N bars)
   */
  getRecentSweep(maxAgeMs = 60000) {
    // maxAgeMs default: 1 minute
    if (this.recentSweeps.length === 0) return null;
    
    const now = Date.now();
    const recent = this.recentSweeps.find(sweep => {
      const age = now - sweep.timestamp;
      return age <= maxAgeMs;
    });
    
    return recent || null;
  }
  
  /**
   * Get all smart levels (for visualization/debugging)
   */
  getAllLevels() {
    return {
      sessionPivots: this.sessionPivots,
      liquidityPools: this.liquidityPools,
      activeGaps: this.activeGaps.filter(g => !g.filled),
      recentSweeps: this.recentSweeps,
    };
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeLiquidityPools: this.liquidityPools.length,
      activeFVGs: this.activeGaps.filter(g => !g.filled).length,
      recentSweepsCount: this.recentSweeps.length,
    };
  }
  
  /**
   * Reset tracker (for testing or market change)
   */
  reset() {
    this.sessionPivots = {
      prevDayHigh: null,
      prevDayLow: null,
      prevDayOpen: null,
      prevHourHigh: null,
      prevHourLow: null,
      prevHourOpen: null,
      todayOpen: null,
      currentDayHigh: null,
      currentDayLow: null,
    };
    
    this.liquidityPools = [];
    this.activeGaps = [];
    this.swingPoints = [];
    this.recentSweeps = [];
    
    this.currentTickPrice = null;
    this.prevTickPrice = null;
    this.tickHigh = null;
    this.tickLow = null;
    
    this.barIndex = 0;
    this.lastBarTimestamp = null;
    
    // Reset statistics (but keep cumulative totals for tracking)
    // Only reset the counts that should start fresh
    this.stats = {
      totalBars: 0,
      totalTicks: 0,
      liquidityPoolsDetected: 0,
      fvgsDetected: 0,
      sweepsDetected: 0,
      pivotUpdates: 0,
    };
    
    console.log(`[Smart Levels] ${this.market} tracker reset`);
  }
}

module.exports = SmartLevelsTracker;

