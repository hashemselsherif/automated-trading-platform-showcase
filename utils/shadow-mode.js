/**
 * Shadow Mode Manager
 * 
 * Enables shadow trading mode where:
 * - Majors (SOL, BTC, ETH) execute on Jupiter (real)
 * - Alts simulate on Drift (paper) for comparison
 * 
 * Tracks deltas between simulated and would-be real execution:
 * - Price health (slippage, oracle vs execution)
 * - Fee deltas (Jupiter flat vs Drift tiered/maker)
 * - Risk cap behavior
 */

const EventEmitter = require('events');
const venueRouter = require('./venue-router');

class ShadowModeManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.enabled = config.enabled ?? process.env.SHADOW_MODE_ENABLED === 'true';
    this.trackingPeriodMs = config.trackingPeriodMs ?? 7 * 24 * 60 * 60 * 1000; // 1 week default
    this.startedAt = null;
    
    // Shadow execution log
    this.shadowTrades = new Map(); // market -> trades[]
    this.realTrades = new Map();   // market -> trades[]
    
    // Aggregated metrics
    this.metrics = {
      shadowTradeCount: 0,
      realTradeCount: 0,
      totalShadowVolume: 0,
      totalRealVolume: 0,
      feeDeltas: {
        totalJupiterFees: 0,
        totalDriftTakerFees: 0,
        totalDriftMakerRebates: 0,
        netSavingsWithMaker: 0,
      },
      priceHealth: {
        avgOracleDeviation: 0,
        maxOracleDeviation: 0,
        deviationSamples: 0,
      },
      byMarket: {},
    };
    
    // Comparison thresholds
    this.thresholds = {
      maxAcceptableSlippageBps: config.maxAcceptableSlippageBps ?? 50,
      maxOracleDeviationBps: config.maxOracleDeviationBps ?? 30,
      minMakerFillRate: config.minMakerFillRate ?? 0.7,
    };
  }

  /**
   * Start shadow mode tracking
   */
  start() {
    if (!this.enabled) {
      console.log('[ShadowMode] Disabled via config');
      return;
    }
    
    this.startedAt = Date.now();
    console.log('[ShadowMode] Started shadow mode tracking');
    console.log(`[ShadowMode] Tracking period: ${this.trackingPeriodMs / (24 * 60 * 60 * 1000)} days`);
    this.emit('started', { startedAt: this.startedAt });
  }

  /**
   * Determine if a trade should be real or shadow
   */
  shouldExecuteReal(market) {
    if (!this.enabled) return true; // All real if shadow mode disabled
    
    const venue = venueRouter.getVenueForMarket(market);
    return venue === 'jupiter'; // Only Jupiter trades are real in shadow mode
  }

  /**
   * Record a shadow trade (simulated Drift execution)
   */
  recordShadowTrade(trade) {
    const { market, side, size, entryPrice, oraclePrice, execMode, fees } = trade;
    
    if (!this.shadowTrades.has(market)) {
      this.shadowTrades.set(market, []);
      this.metrics.byMarket[market] = this._initMarketMetrics();
    }
    
    const record = {
      timestamp: Date.now(),
      market,
      side,
      size,
      entryPrice,
      oraclePrice,
      execMode,
      fees,
      oracleDeviationBps: Math.abs((entryPrice - oraclePrice) / oraclePrice * 10000),
    };
    
    this.shadowTrades.get(market).push(record);
    this.metrics.shadowTradeCount++;
    this.metrics.totalShadowVolume += size;
    
    // Update fee deltas
    if (execMode === 'maker') {
      this.metrics.feeDeltas.totalDriftMakerRebates += Math.abs(fees);
    } else {
      this.metrics.feeDeltas.totalDriftTakerFees += fees;
    }
    
    // Update price health
    this._updatePriceHealth(record.oracleDeviationBps);
    this._updateMarketMetrics(market, record, 'shadow');
    
    this.emit('shadowTrade', record);
    return record;
  }

  /**
   * Record a real trade (Jupiter execution)
   */
  recordRealTrade(trade) {
    const { market, side, size, entryPrice, oraclePrice, fees } = trade;
    
    if (!this.realTrades.has(market)) {
      this.realTrades.set(market, []);
      if (!this.metrics.byMarket[market]) {
        this.metrics.byMarket[market] = this._initMarketMetrics();
      }
    }
    
    const record = {
      timestamp: Date.now(),
      market,
      side,
      size,
      entryPrice,
      oraclePrice,
      fees,
      oracleDeviationBps: oraclePrice ? Math.abs((entryPrice - oraclePrice) / oraclePrice * 10000) : 0,
    };
    
    this.realTrades.get(market).push(record);
    this.metrics.realTradeCount++;
    this.metrics.totalRealVolume += size;
    this.metrics.feeDeltas.totalJupiterFees += fees;
    
    this._updateMarketMetrics(market, record, 'real');
    
    this.emit('realTrade', record);
    return record;
  }

  /**
   * Compare shadow vs real execution for a market
   */
  compareMarket(market) {
    const shadow = this.shadowTrades.get(market) || [];
    const real = this.realTrades.get(market) || [];
    
    return {
      market,
      shadowCount: shadow.length,
      realCount: real.length,
      shadowVolume: shadow.reduce((sum, t) => sum + t.size, 0),
      realVolume: real.reduce((sum, t) => sum + t.size, 0),
      avgShadowOracleDeviation: shadow.length > 0 
        ? shadow.reduce((sum, t) => sum + t.oracleDeviationBps, 0) / shadow.length
        : 0,
      avgRealOracleDeviation: real.length > 0
        ? real.reduce((sum, t) => sum + t.oracleDeviationBps, 0) / real.length
        : 0,
      makerFillRate: shadow.filter(t => t.execMode === 'maker').length / Math.max(shadow.length, 1),
    };
  }

  /**
   * Get overall shadow mode report
   */
  getReport() {
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const durationDays = durationMs / (24 * 60 * 60 * 1000);
    
    // Calculate net savings from maker execution
    const jupiterEquivalentFees = this.metrics.totalShadowVolume * 0.0006; // 6bps
    const actualDriftCost = this.metrics.feeDeltas.totalDriftTakerFees - this.metrics.feeDeltas.totalDriftMakerRebates;
    const netSavings = jupiterEquivalentFees - actualDriftCost;
    
    this.metrics.feeDeltas.netSavingsWithMaker = netSavings;
    
    // Check if thresholds are met
    const thresholdsPassed = {
      oracleDeviation: this.metrics.priceHealth.avgOracleDeviation <= this.thresholds.maxOracleDeviationBps,
      makerFillRate: this._getOverallMakerFillRate() >= this.thresholds.minMakerFillRate,
    };
    
    return {
      enabled: this.enabled,
      startedAt: this.startedAt,
      durationDays: durationDays.toFixed(2),
      metrics: this.metrics,
      thresholds: this.thresholds,
      thresholdsPassed,
      readyForLive: thresholdsPassed.oracleDeviation && thresholdsPassed.makerFillRate,
      marketComparisons: [...this.shadowTrades.keys()].map(m => this.compareMarket(m)),
    };
  }

  /**
   * Check if shadow period is complete
   */
  isTrackingComplete() {
    if (!this.startedAt) return false;
    return Date.now() - this.startedAt >= this.trackingPeriodMs;
  }

  /**
   * Export shadow data for analysis
   */
  exportData() {
    return {
      shadowTrades: Object.fromEntries(this.shadowTrades),
      realTrades: Object.fromEntries(this.realTrades),
      metrics: this.metrics,
      report: this.getReport(),
    };
  }

  // Private methods
  
  _initMarketMetrics() {
    return {
      shadowTrades: 0,
      realTrades: 0,
      shadowVolume: 0,
      realVolume: 0,
      shadowFees: 0,
      realFees: 0,
      avgOracleDeviation: 0,
      makerFills: 0,
      takerFills: 0,
    };
  }

  _updateMarketMetrics(market, record, type) {
    const m = this.metrics.byMarket[market];
    if (type === 'shadow') {
      m.shadowTrades++;
      m.shadowVolume += record.size;
      m.shadowFees += record.fees || 0;
      if (record.execMode === 'maker') m.makerFills++;
      else m.takerFills++;
    } else {
      m.realTrades++;
      m.realVolume += record.size;
      m.realFees += record.fees || 0;
    }
  }

  _updatePriceHealth(deviationBps) {
    const ph = this.metrics.priceHealth;
    const n = ph.deviationSamples;
    ph.avgOracleDeviation = (ph.avgOracleDeviation * n + deviationBps) / (n + 1);
    ph.maxOracleDeviation = Math.max(ph.maxOracleDeviation, deviationBps);
    ph.deviationSamples++;
  }

  _getOverallMakerFillRate() {
    let makerFills = 0;
    let totalFills = 0;
    for (const trades of this.shadowTrades.values()) {
      for (const t of trades) {
        if (t.execMode === 'maker') makerFills++;
        totalFills++;
      }
    }
    return totalFills > 0 ? makerFills / totalFills : 0;
  }
}

// Singleton instance
let instance = null;

function getShadowModeManager(config) {
  if (!instance) {
    instance = new ShadowModeManager(config);
  }
  return instance;
}

module.exports = {
  ShadowModeManager,
  getShadowModeManager,
};

