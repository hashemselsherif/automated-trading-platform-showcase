// utils/strategy-manager.js

/**
 * Strategy Manager
 * 
 * Runtime coordination for multiple strategies across markets.
 * Handles strategy lifecycle, signal generation, and performance tracking.
 * 
 * Supports two modes:
 * 1. Single-strategy mode: One strategy per market (legacy)
 * 2. Multi-strategy mode: Multiple strategies per market, all signals feed to allocator
 * 
 * Usage (single-strategy):
 *   const manager = new StrategyManager(factory, options);
 *   await manager.updateAll(priceData, candles);
 *   const signals = manager.getAllSignals(prices, positions);
 * 
 * Usage (multi-strategy):
 *   const manager = new StrategyManager(factory, { multiStrategyMode: true });
 *   const signals = manager.getAllSignals(prices, positions);
 *   // signals = [{ market, strategyType, ...signal }, ...]
 */

class StrategyManager {
  constructor(strategyFactory, options = {}) {
    this.factory = strategyFactory;
    this.options = options;
    
    // Multi-strategy mode (from factory or options)
    this.multiStrategyMode = strategyFactory.multiStrategyMode || options.multiStrategyMode || false;
    
    // Active markets
    this.markets = options.markets || [];
    
    // Strategy performance tracking (per market AND per strategy type)
    // Format: Map<market, Map<strategyType, { trades, wins, losses, pnl }>>
    this.performance = new Map();
    
    // Signal history (for debugging)
    this.signalHistory = [];
    this.maxSignalHistory = 1000;
    
    // Update tracking
    this.lastTickUpdate = new Map(); // market -> timestamp
    this.lastBarUpdate = new Map(); // market -> timestamp
    
    console.log('[StrategyManager] Initialized');
    console.log(`[StrategyManager] Multi-strategy mode: ${this.multiStrategyMode}`);
    console.log(`[StrategyManager] Markets: ${this.markets.join(', ')}`);
  }
  
  /**
   * Update all strategies with tick data (sub-second updates)
   * 
   * @param {Object} priceData - Price data per market { market: { price, timestamp } }
   */
  updateTick(priceData) {
    const now = Date.now();
    
    for (const market of this.markets) {
      const price = priceData[market];
      if (!price) continue;
      
      if (this.multiStrategyMode) {
        // Multi-strategy mode: update ALL strategies for this market
        const strategies = this.factory.createAllStrategies(market);
        for (const { type, strategy } of strategies) {
          // Update tick (if strategy supports it)
          if (typeof strategy.updateTick === 'function') {
            strategy.updateTick({ price: price.price, ts: price.timestamp || now });
          }
          // Also call recalculateLastBar for tick-based indicators
          if (typeof strategy.recalculateLastBar === 'function') {
            strategy.recalculateLastBar({ close: price.price, high: price.price, low: price.price, volume: 0 });
          }
        }
      } else {
        // Single-strategy mode (legacy)
        const strategy = this.factory.createStrategy(market);
        if (typeof strategy.updateTick === 'function') {
          strategy.updateTick(price.price, price.timestamp || now);
        }
      }
      
      // Track update
      this.lastTickUpdate.set(market, now);
    }
  }
  
  /**
   * Update all strategies with bar data (candle-based updates)
   * 
   * @param {Object} candles - Candle data per market { market: [candles] }
   */
  updateBar(candles) {
    const now = Date.now();
    
    for (const market of this.markets) {
      const marketCandles = candles[market];
      if (!marketCandles || marketCandles.length === 0) continue;
      
      // Get latest candle
      const latestCandle = marketCandles[marketCandles.length - 1];
      
      if (this.multiStrategyMode) {
        // Multi-strategy mode: update ALL strategies for this market
        const strategies = this.factory.createAllStrategies(market);
        for (const { type, strategy } of strategies) {
          // Update bar (if strategy supports it)
          if (typeof strategy.updateBar === 'function') {
            strategy.updateBar(latestCandle);
          } else if (typeof strategy.update === 'function') {
            // Fallback to update() for strategies without updateBar()
            strategy.update(latestCandle);
          }
        }
      } else {
        // Single-strategy mode (legacy)
        const strategy = this.factory.createStrategy(market);
        if (typeof strategy.updateBar === 'function') {
          strategy.updateBar(latestCandle);
        } else if (typeof strategy.update === 'function') {
          strategy.update(latestCandle);
        }
      }
      
      // Track update
      this.lastBarUpdate.set(market, now);
    }
  }
  
  /**
   * Get signal for a specific market (single-strategy mode)
   * 
   * @param {string} market - Market symbol
   * @param {number} price - Current price
   * @param {Array} positions - Current positions
   * @returns {Object|null} Signal or null
   */
  getSignal(market, price, positions) {
    // Get strategy
    const strategy = this.factory.getStrategy(market);
    if (!strategy) {
      return null;
    }
    
    // Get signal
    const signal = strategy.getSignal(price, positions);
    
    // Track signal
    if (signal && signal.action !== 'hold') {
      this._recordSignal(market, signal);
    }
    
    return signal;
  }
  
  /**
   * Get signals from ALL strategies for a market (multi-strategy mode)
   * 
   * @param {string} market - Market symbol
   * @param {number} price - Current price
   * @param {Array} positions - Current positions
   * @returns {Array} Array of signals with strategyType
   */
  getSignalsForMarket(market, price, positions) {
    const signals = [];
    
    if (this.multiStrategyMode) {
      // Get all strategies for this market
      const strategies = this.factory.getStrategies(market);
      if (!strategies) return signals;
      
      for (const { type, strategy } of strategies) {
        if (!strategy) continue;
        
        // Get signal from this strategy
        const signal = strategy.getSignal(price, positions);
        
        if (signal && signal.action !== 'hold') {
          // Add strategyType to signal
          const enrichedSignal = {
            ...signal,
            strategyType: type,
            market,
          };
          
          signals.push(enrichedSignal);
          this._recordSignal(market, enrichedSignal, type);
        }
      }
    } else {
      // Single-strategy mode
      const signal = this.getSignal(market, price, positions);
      if (signal && signal.action !== 'hold') {
        const type = this.factory.getStrategyType(market);
        signals.push({
          ...signal,
          strategyType: type,
          market,
        });
      }
    }
    
    return signals;
  }
  
  /**
   * Get signals for all markets
   * 
   * @param {Object} prices - Prices per market { market: price }
   * @param {Array} positions - Current positions
   * @returns {Object|Array} 
   *   Single-strategy mode: { market: signal }
   *   Multi-strategy mode: [{ market, strategyType, ...signal }, ...]
   */
  getAllSignals(prices, positions) {
    if (this.multiStrategyMode) {
      // Multi-strategy mode: return array of all signals from all strategies
      const allSignals = [];
      
      for (const market of this.markets) {
        const price = prices[market];
        if (!price) continue;
        
        const marketSignals = this.getSignalsForMarket(market, price, positions);
        allSignals.push(...marketSignals);
      }
      
      return allSignals;
    } else {
      // Single-strategy mode (legacy): return object keyed by market
      const signals = {};
      
      for (const market of this.markets) {
        const price = prices[market];
        if (!price) continue;
        
        const signal = this.getSignal(market, price, positions);
        if (signal && signal.action !== 'hold') {
          signals[market] = signal;
        }
      }
      
      return signals;
    }
  }
  
  /**
   * Check if a position should be closed
   * Uses the correct strategy based on position.strategyType
   * 
   * @param {Object} position - Position object (with strategyType)
   * @param {number} currentPrice - Current price
   * @returns {Object|null} Close signal or null
   */
  shouldClose(position, currentPrice) {
    const market = position.market;
    const strategyType = position.strategyType;
    
    if (this.multiStrategyMode && strategyType) {
      // Multi-strategy mode: find the correct strategy by type
      const strategies = this.factory.getStrategies(market);
      if (!strategies) return null;
      
      const match = strategies.find(s => s.type === strategyType);
      if (match && match.strategy && typeof match.strategy.shouldClose === 'function') {
        return match.strategy.shouldClose(position, currentPrice);
      }
      return null;
    }
    
    // Single-strategy mode or no strategyType: use default strategy
    const strategy = this.factory.getStrategy(market);
    if (!strategy) {
      return null;
    }
    
    if (typeof strategy.shouldClose === 'function') {
      return strategy.shouldClose(position, currentPrice);
    }
    
    return null;
  }
  
  /**
   * Get recommended position size
   * 
   * @param {string} market - Market symbol
   * @param {number} price - Current price
   * @param {string} side - 'long' or 'short'
   * @param {number} capital - Available capital
   * @param {Object} opts - Additional options (including strategyType)
   * @returns {number} Position size in USD
   */
  getRecommendedPositionSize(market, price, side, capital, opts = {}) {
    const strategyType = opts.strategyType;
    let strategy = null;
    
    if (this.multiStrategyMode && strategyType) {
      // Multi-strategy mode: find the correct strategy by type
      const strategies = this.factory.getStrategies(market);
      if (strategies) {
        const match = strategies.find(s => s.type === strategyType);
        if (match) strategy = match.strategy;
      }
    }
    
    // Fallback to default strategy
    if (!strategy) {
      strategy = this.factory.getStrategy(market);
    }
    
    if (!strategy) {
      return 0;
    }
    
    // Get position size
    if (typeof strategy.getRecommendedPositionSize === 'function') {
      return strategy.getRecommendedPositionSize(price, side, capital, opts);
    }
    
    // Fallback to default sizing
    const positionSizePercent = 0.20; // 20%
    return capital * positionSizePercent;
  }
  
  /**
   * Record a trade result
   * 
   * @param {string} market - Market symbol
   * @param {Object} trade - Trade object (with strategyType)
   */
  recordTrade(market, trade) {
    const strategyType = trade.strategyType || this.factory.getStrategyType(market);
    
    // Get or create performance tracker for this market
    if (!this.performance.has(market)) {
      this.performance.set(market, new Map());
    }
    
    const marketPerf = this.performance.get(market);
    
    // Get or create performance tracker for this strategy type
    if (!marketPerf.has(strategyType)) {
      marketPerf.set(strategyType, {
        strategyType,
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
      });
    }
    
    const perf = marketPerf.get(strategyType);
    
    // Update stats
    perf.trades++;
    perf.pnl += trade.pnl || 0;
    
    if (trade.pnl > 0) {
      perf.wins++;
    } else if (trade.pnl < 0) {
      perf.losses++;
    }
    
    // Also notify the strategy (if it has recordTrade)
    if (this.multiStrategyMode) {
      const strategies = this.factory.getStrategies(market);
      if (strategies) {
        const match = strategies.find(s => s.type === strategyType);
        if (match && match.strategy && typeof match.strategy.recordTrade === 'function') {
          match.strategy.recordTrade(trade);
        }
      }
    }
  }
  
  /**
   * Record a signal
   * 
   * @param {string} market - Market symbol
   * @param {Object} signal - Signal object
   * @param {string} strategyType - Strategy type (optional, will detect if not provided)
   */
  _recordSignal(market, signal, strategyType = null) {
    this.signalHistory.push({
      timestamp: Date.now(),
      market,
      strategyType: strategyType || signal.strategyType || this.factory.getStrategyType(market),
      signal,
    });
    
    // Keep only last N signals
    if (this.signalHistory.length > this.maxSignalHistory) {
      this.signalHistory.shift();
    }
  }
  
  /**
   * Get performance for a market
   * 
   * @param {string} market - Market symbol
   * @param {string} strategyType - Optional strategy type filter
   * @returns {Object|null} Performance stats or null
   */
  getPerformance(market, strategyType = null) {
    const marketPerf = this.performance.get(market);
    if (!marketPerf) return null;
    
    // New format: Map<strategyType, perf>
    if (marketPerf instanceof Map) {
      if (strategyType) {
        return marketPerf.get(strategyType) || null;
      }
      // Return aggregated performance for this market
      const aggregated = { trades: 0, wins: 0, losses: 0, pnl: 0, byStrategy: {} };
      for (const [type, perf] of marketPerf) {
        aggregated.trades += perf.trades;
        aggregated.wins += perf.wins;
        aggregated.losses += perf.losses;
        aggregated.pnl += perf.pnl;
        aggregated.byStrategy[type] = { ...perf, winRate: perf.trades > 0 ? perf.wins / perf.trades : 0 };
      }
      aggregated.winRate = aggregated.trades > 0 ? aggregated.wins / aggregated.trades : 0;
      return aggregated;
    }
    
    // Legacy format: single object
    return marketPerf;
  }
  
  /**
   * Get performance for all markets
   * 
   * @returns {Object} Performance per market
   */
  getAllPerformance() {
    const allPerf = {};
    
    for (const [market, marketPerf] of this.performance) {
      // New format: Map<strategyType, perf>
      if (marketPerf instanceof Map) {
        allPerf[market] = { byStrategy: {} };
        let totalTrades = 0, totalWins = 0, totalLosses = 0, totalPnl = 0;
        
        for (const [type, perf] of marketPerf) {
          allPerf[market].byStrategy[type] = {
            ...perf,
            winRate: perf.trades > 0 ? perf.wins / perf.trades : 0,
          };
          totalTrades += perf.trades;
          totalWins += perf.wins;
          totalLosses += perf.losses;
          totalPnl += perf.pnl;
        }
        
        allPerf[market].trades = totalTrades;
        allPerf[market].wins = totalWins;
        allPerf[market].losses = totalLosses;
        allPerf[market].pnl = totalPnl;
        allPerf[market].winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
      } else {
        // Legacy format
        allPerf[market] = {
          ...marketPerf,
          winRate: marketPerf.trades > 0 ? marketPerf.wins / marketPerf.trades : 0,
        };
      }
    }
    
    return allPerf;
  }
  
  /**
   * Get aggregated performance by strategy type
   * 
   * @returns {Object} Performance by strategy type
   */
  getPerformanceByStrategy() {
    const byStrategy = {
      momentum: { trades: 0, wins: 0, losses: 0, pnl: 0, markets: [] },
      scalping: { trades: 0, wins: 0, losses: 0, pnl: 0, markets: [] },
      'rsi-reversion': { trades: 0, wins: 0, losses: 0, pnl: 0, markets: [] },
      'rsi-reversion-alt': { trades: 0, wins: 0, losses: 0, pnl: 0, markets: [] },
      'ichimoku-cloud': { trades: 0, wins: 0, losses: 0, pnl: 0, markets: [] },
    };
    
    for (const [market, marketPerf] of this.performance) {
      // New format: Map<strategyType, perf>
      if (marketPerf instanceof Map) {
        for (const [strategyType, perf] of marketPerf) {
          if (byStrategy[strategyType]) {
            byStrategy[strategyType].trades += perf.trades;
            byStrategy[strategyType].wins += perf.wins;
            byStrategy[strategyType].losses += perf.losses;
            byStrategy[strategyType].pnl += perf.pnl;
            if (!byStrategy[strategyType].markets.includes(market)) {
              byStrategy[strategyType].markets.push(market);
            }
          }
        }
      } else {
        // Legacy format
        const strategyType = marketPerf.strategyType;
        if (byStrategy[strategyType]) {
          byStrategy[strategyType].trades += marketPerf.trades;
          byStrategy[strategyType].wins += marketPerf.wins;
          byStrategy[strategyType].losses += marketPerf.losses;
          byStrategy[strategyType].pnl += marketPerf.pnl;
          byStrategy[strategyType].markets.push(market);
        }
      }
    }
    
    // Calculate win rates
    for (const strategyType in byStrategy) {
      const perf = byStrategy[strategyType];
      perf.winRate = perf.trades > 0 ? perf.wins / perf.trades : 0;
    }
    
    return byStrategy;
  }
  
  /**
   * Get recent signals
   * 
   * @param {number} limit - Maximum number of signals to return
   * @returns {Array} Recent signals
   */
  getRecentSignals(limit = 100) {
    return this.signalHistory.slice(-limit);
  }
  
  /**
   * Get strategy stats for a market
   * 
   * @param {string} market - Market symbol
   * @returns {Object|null} Strategy stats or null
   */
  getStrategyStats(market) {
    const strategy = this.factory.getStrategy(market);
    if (!strategy) {
      return null;
    }
    
    if (typeof strategy.getStats === 'function') {
      return strategy.getStats();
    }
    
    return null;
  }
  
  /**
   * Get all strategy stats
   * 
   * @returns {Object} Stats per market (and per strategy type in multi-strategy mode)
   */
  getAllStrategyStats() {
    const allStats = {};
    
    for (const market of this.markets) {
      if (this.multiStrategyMode) {
        // Multi-strategy mode: get stats from all strategies
        const strategies = this.factory.getStrategies(market);
        if (strategies) {
          allStats[market] = {};
          for (const { type, strategy } of strategies) {
            if (strategy && typeof strategy.getStats === 'function') {
              allStats[market][type] = {
                strategyType: type,
                ...strategy.getStats(),
              };
            }
          }
        }
      } else {
        // Single-strategy mode
        const stats = this.getStrategyStats(market);
        if (stats) {
          allStats[market] = {
            strategyType: this.factory.getStrategyType(market),
            ...stats,
          };
        }
      }
    }
    
    return allStats;
  }
  
  /**
   * Switch strategy for a market (single-strategy mode only)
   * In multi-strategy mode, use factory.setStrategyEnabled() instead
   * 
   * @param {string} market - Market symbol
   * @param {string} newStrategyType - New strategy type
   */
  switchStrategy(market, newStrategyType) {
    if (this.multiStrategyMode) {
      console.warn('[StrategyManager] switchStrategy() not supported in multi-strategy mode. Use factory.setStrategyEnabled() instead.');
      return;
    }
    
    console.log(`[StrategyManager] Switching ${market} to ${newStrategyType}`);
    
    // Switch in factory
    this.factory.switchStrategy(market, newStrategyType);
    
    // Reset performance tracking
    if (this.performance.has(market)) {
      const perf = this.performance.get(market);
      if (perf instanceof Map) {
        // New format - clear all
        perf.clear();
      } else {
        perf.strategyType = newStrategyType;
      }
    }
  }
  
  /**
   * Add a market
   * 
   * @param {string} market - Market symbol
   */
  addMarket(market) {
    if (!this.markets.includes(market)) {
      this.markets.push(market);
      console.log(`[StrategyManager] Added market: ${market}`);
    }
  }
  
  /**
   * Remove a market
   * 
   * @param {string} market - Market symbol
   */
  removeMarket(market) {
    const index = this.markets.indexOf(market);
    if (index !== -1) {
      this.markets.splice(index, 1);
      console.log(`[StrategyManager] Removed market: ${market}`);
    }
  }
  
  /**
   * Get manager statistics
   * 
   * @returns {Object} Statistics
   */
  getStats() {
    const factoryStats = this.factory.getStats();
    const perfByStrategy = this.getPerformanceByStrategy();
    
    return {
      multiStrategyMode: this.multiStrategyMode,
      markets: this.markets.length,
      ...factoryStats,
      performance: perfByStrategy,
      signalHistory: this.signalHistory.length,
      lastTickUpdates: this.lastTickUpdate.size,
      lastBarUpdates: this.lastBarUpdate.size,
    };
  }
  
  /**
   * Reset all strategies and performance
   */
  reset() {
    console.log('[StrategyManager] Resetting all strategies and performance');
    this.factory.reset();
    this.performance.clear();
    this.signalHistory = [];
    this.lastTickUpdate.clear();
    this.lastBarUpdate.clear();
  }
}

module.exports = StrategyManager;
