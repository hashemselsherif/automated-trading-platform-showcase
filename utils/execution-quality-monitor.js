// utils/execution-quality-monitor.js

/**
 * Execution Quality Monitor for Scalping
 * 
 * Tracks execution quality metrics and alerts on degradation.
 * Critical for scalping where execution quality directly impacts profitability.
 * 
 * Monitored Metrics:
 * 1. Fill Rate: % of orders successfully filled
 * 2. Slippage: Actual vs expected execution price
 * 3. Latency: Time from signal to execution
 * 4. Rejection Rate: % of orders rejected
 * 5. Fee Impact: Actual fees vs expected
 * 
 * Alerts:
 * - Degraded execution (fill rate < threshold)
 * - High slippage (> threshold)
 * - High latency (> threshold)
 * - Blocking gates (which gates are rejecting most trades)
 * 
 * Usage:
 *   const monitor = new ExecutionQualityMonitor({ strategyType: 'scalping' });
 *   monitor.recordExecution({ type: 'entry', success: true, slippage: 0.15, latency: 250 });
 *   const quality = monitor.getQualityReport();
 */

class ExecutionQualityMonitor {
  constructor(options = {}) {
    // Strategy type (scalping or momentum)
    this.strategyType = options.strategyType || process.env.STRATEGY_TYPE || 'momentum';
    
    // Enable/disable monitoring (scalping only by default)
    this.enabled = this.strategyType === 'scalping' 
      && (options.enabled !== false)
      && (process.env.ENABLE_EXECUTION_MONITORING !== 'false');
    
    if (!this.enabled) {
      console.log('[ExecutionMonitor] Initialized (DISABLED)');
      console.log(`[ExecutionMonitor] Strategy: ${this.strategyType}`);
      return;
    }
    
    // Quality thresholds (for alerts)
    this.thresholds = {
      minFillRate: options.minFillRate || Number(process.env.MIN_FILL_RATE) || 0.95, // 95%
      maxSlippageBps: options.maxSlippageBps || Number(process.env.MAX_SLIPPAGE_BPS) || 30, // 0.30%
      maxLatencyMs: options.maxLatencyMs || Number(process.env.MAX_LATENCY_MS) || 2000, // 2 seconds
      maxRejectionRate: options.maxRejectionRate || Number(process.env.MAX_REJECTION_RATE) || 0.10, // 10%
      minSampleSize: options.minSampleSize || Number(process.env.MIN_SAMPLE_SIZE) || 20, // 20 trades
    };
    
    // Execution tracking
    this.executions = [];
    this.maxExecutions = 1000; // Keep last 1000 executions
    
    // Gate blocking tracking (which gates are rejecting trades)
    this.gateBlocks = {
      volatility: 0,
      circuitBreaker: 0,
      maxPositions: 0,
      funding: 0,
      feeOptimization: 0,
      riskManager: 0,
      other: 0,
    };
    
    // Alert tracking (prevent spam)
    this.lastAlerts = {};
    this.alertCooldownMs = 5 * 60 * 1000; // 5 minutes
    
    // Performance tracking
    this.startTime = Date.now();
    
    console.log('[ExecutionMonitor] Initialized (ENABLED)');
    console.log(`[ExecutionMonitor] Strategy: ${this.strategyType}`);
    console.log(`[ExecutionMonitor] Thresholds: Fill Rate ${(this.thresholds.minFillRate * 100).toFixed(0)}%, Slippage ${this.thresholds.maxSlippageBps} bps, Latency ${this.thresholds.maxLatencyMs}ms`);
  }
  
  /**
   * Record an execution attempt
   * 
   * @param {Object} params
   * @param {string} params.type - 'entry' or 'exit'
   * @param {boolean} params.success - Was the order filled?
   * @param {number} params.expectedPrice - Expected execution price
   * @param {number} params.actualPrice - Actual execution price (if filled)
   * @param {number} params.slippageBps - Actual slippage in basis points
   * @param {number} params.latencyMs - Time from signal to execution (ms)
   * @param {number} params.feeUsd - Actual fee paid (USD)
   * @param {string} params.rejectionReason - Reason for rejection (if not filled)
   */
  recordExecution(params = {}) {
    if (!this.enabled) return;
    
    const {
      type,
      success,
      expectedPrice,
      actualPrice,
      slippageBps,
      latencyMs,
      feeUsd,
      rejectionReason,
    } = params;
    
    const execution = {
      timestamp: Date.now(),
      type,
      success,
      expectedPrice,
      actualPrice,
      slippageBps: slippageBps || this._calculateSlippage(expectedPrice, actualPrice),
      latencyMs: latencyMs || 0,
      feeUsd: feeUsd || 0,
      rejectionReason,
    };
    
    this.executions.push(execution);
    
    // Keep only last N executions
    if (this.executions.length > this.maxExecutions) {
      this.executions.shift();
    }
    
    // Check for quality degradation
    this._checkQualityAlerts();
  }
  
  /**
   * Record a gate block (trade rejected by entry gate)
   * 
   * @param {string} gate - Gate name (volatility, circuitBreaker, maxPositions, funding, feeOptimization, riskManager, other)
   */
  recordGateBlock(gate) {
    if (!this.enabled) return;
    
    if (gate in this.gateBlocks) {
      this.gateBlocks[gate]++;
    } else {
      this.gateBlocks.other++;
    }
    
    // Record as execution failure
    this.recordExecution({
      type: 'entry',
      success: false,
      rejectionReason: gate,
    });
  }
  
  /**
   * Calculate slippage from expected vs actual price
   * 
   * @param {number} expectedPrice - Expected price
   * @param {number} actualPrice - Actual price
   * @returns {number} Slippage in basis points
   */
  _calculateSlippage(expectedPrice, actualPrice) {
    if (!Number.isFinite(expectedPrice) || !Number.isFinite(actualPrice)) {
      return 0;
    }
    
    const slippagePct = Math.abs((actualPrice - expectedPrice) / expectedPrice);
    return slippagePct * 10000; // Convert to bps
  }
  
  /**
   * Check for quality degradation and send alerts
   */
  _checkQualityAlerts() {
    // Need minimum sample size
    if (this.executions.length < this.thresholds.minSampleSize) {
      return;
    }
    
    const report = this.getQualityReport();
    
    // Check fill rate
    if (report.fillRate < this.thresholds.minFillRate) {
      this._sendAlert('fillRate', `Low fill rate: ${(report.fillRate * 100).toFixed(1)}% (threshold: ${(this.thresholds.minFillRate * 100).toFixed(0)}%)`);
    }
    
    // Check slippage
    if (report.avgSlippageBps > this.thresholds.maxSlippageBps) {
      this._sendAlert('slippage', `High slippage: ${report.avgSlippageBps.toFixed(2)} bps (threshold: ${this.thresholds.maxSlippageBps} bps)`);
    }
    
    // Check latency
    if (report.avgLatencyMs > this.thresholds.maxLatencyMs) {
      this._sendAlert('latency', `High latency: ${report.avgLatencyMs.toFixed(0)}ms (threshold: ${this.thresholds.maxLatencyMs}ms)`);
    }
    
    // Check rejection rate
    if (report.rejectionRate > this.thresholds.maxRejectionRate) {
      this._sendAlert('rejectionRate', `High rejection rate: ${(report.rejectionRate * 100).toFixed(1)}% (threshold: ${(this.thresholds.maxRejectionRate * 100).toFixed(0)}%)`);
    }
  }
  
  /**
   * Send alert (with cooldown to prevent spam)
   * 
   * @param {string} type - Alert type
   * @param {string} message - Alert message
   */
  _sendAlert(type, message) {
    const now = Date.now();
    const lastAlert = this.lastAlerts[type] || 0;
    
    // Check cooldown
    if (now - lastAlert < this.alertCooldownMs) {
      return; // Skip alert (too soon)
    }
    
    this.lastAlerts[type] = now;
    
    console.warn(`[ExecutionMonitor] ⚠️  ${message}`);
    
    // TODO: Send to Telegram if configured
    // if (this.telegramBot) {
    //   this.telegramBot.sendMessage(`⚠️ Execution Quality Alert: ${message}`);
    // }
  }
  
  /**
   * Get execution quality report
   * 
   * @returns {Object} Quality report
   */
  getQualityReport() {
    if (!this.enabled) {
      return {
        enabled: false,
        strategyType: this.strategyType,
        note: 'Execution monitoring disabled',
      };
    }
    
    const totalExecutions = this.executions.length;
    
    if (totalExecutions === 0) {
      return {
        enabled: true,
        strategyType: this.strategyType,
        totalExecutions: 0,
        note: 'No executions recorded yet',
      };
    }
    
    // Calculate metrics
    const successfulExecutions = this.executions.filter(e => e.success);
    const failedExecutions = this.executions.filter(e => !e.success);
    
    const fillRate = successfulExecutions.length / totalExecutions;
    const rejectionRate = failedExecutions.length / totalExecutions;
    
    // Slippage stats (only for successful executions)
    const slippages = successfulExecutions.map(e => e.slippageBps).filter(s => Number.isFinite(s));
    const avgSlippageBps = slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : 0;
    const maxSlippageBps = slippages.length > 0 ? Math.max(...slippages) : 0;
    
    // Latency stats
    const latencies = this.executions.map(e => e.latencyMs).filter(l => Number.isFinite(l) && l > 0);
    const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const maxLatencyMs = latencies.length > 0 ? Math.max(...latencies) : 0;
    
    // Fee stats
    const fees = successfulExecutions.map(e => e.feeUsd).filter(f => Number.isFinite(f) && f > 0);
    const totalFeesUsd = fees.reduce((a, b) => a + b, 0);
    const avgFeeUsd = fees.length > 0 ? totalFeesUsd / fees.length : 0;
    
    // Entry vs Exit breakdown
    const entries = this.executions.filter(e => e.type === 'entry');
    const exits = this.executions.filter(e => e.type === 'exit');
    
    const entryFillRate = entries.length > 0 ? entries.filter(e => e.success).length / entries.length : 0;
    const exitFillRate = exits.length > 0 ? exits.filter(e => e.success).length / exits.length : 0;
    
    // Top rejection reasons
    const rejectionReasons = {};
    failedExecutions.forEach(e => {
      if (e.rejectionReason) {
        rejectionReasons[e.rejectionReason] = (rejectionReasons[e.rejectionReason] || 0) + 1;
      }
    });
    
    // Quality score (0-100)
    const qualityScore = this._calculateQualityScore({
      fillRate,
      avgSlippageBps,
      avgLatencyMs,
      rejectionRate,
    });
    
    // Health status
    const health = this._determineHealth(qualityScore);
    
    return {
      enabled: true,
      strategyType: this.strategyType,
      health,
      qualityScore,
      
      // Overall metrics
      totalExecutions,
      fillRate,
      rejectionRate,
      
      // Slippage metrics
      avgSlippageBps,
      maxSlippageBps,
      
      // Latency metrics
      avgLatencyMs,
      maxLatencyMs,
      
      // Fee metrics
      totalFeesUsd,
      avgFeeUsd,
      
      // Breakdown
      entries: {
        total: entries.length,
        successful: entries.filter(e => e.success).length,
        fillRate: entryFillRate,
      },
      exits: {
        total: exits.length,
        successful: exits.filter(e => e.success).length,
        fillRate: exitFillRate,
      },
      
      // Gate blocks
      gateBlocks: { ...this.gateBlocks },
      topBlockingGate: this._getTopBlockingGate(),
      
      // Rejection reasons
      rejectionReasons,
      
      // Thresholds
      thresholds: { ...this.thresholds },
      
      // Uptime
      uptimeMs: Date.now() - this.startTime,
    };
  }
  
  /**
   * Calculate quality score (0-100)
   * 
   * @param {Object} metrics
   * @returns {number} Quality score
   */
  _calculateQualityScore(metrics) {
    const { fillRate, avgSlippageBps, avgLatencyMs, rejectionRate } = metrics;
    
    // Fill rate score (40% weight)
    const fillRateScore = fillRate * 40;
    
    // Slippage score (30% weight)
    // 0 bps = 30 points, 50 bps = 0 points
    const slippageScore = Math.max(0, 30 * (1 - avgSlippageBps / 50));
    
    // Latency score (20% weight)
    // 0ms = 20 points, 3000ms = 0 points
    const latencyScore = Math.max(0, 20 * (1 - avgLatencyMs / 3000));
    
    // Rejection rate score (10% weight)
    // 0% = 10 points, 20% = 0 points
    const rejectionScore = Math.max(0, 10 * (1 - rejectionRate / 0.20));
    
    return Math.round(fillRateScore + slippageScore + latencyScore + rejectionScore);
  }
  
  /**
   * Determine health status from quality score
   * 
   * @param {number} score - Quality score (0-100)
   * @returns {string} Health status
   */
  _determineHealth(score) {
    if (score >= 90) return 'excellent';
    if (score >= 80) return 'good';
    if (score >= 70) return 'fair';
    if (score >= 60) return 'poor';
    return 'critical';
  }
  
  /**
   * Get top blocking gate
   * 
   * @returns {Object} Top blocking gate
   */
  _getTopBlockingGate() {
    const gates = Object.entries(this.gateBlocks);
    
    if (gates.length === 0) {
      return { gate: 'none', count: 0 };
    }
    
    const sorted = gates.sort((a, b) => b[1] - a[1]);
    const [gate, count] = sorted[0];
    
    return { gate, count };
  }
  
  /**
   * Get recommendations for improving execution quality
   * 
   * @returns {Array<string>} Recommendations
   */
  getRecommendations() {
    if (!this.enabled) {
      return [];
    }
    
    const report = this.getQualityReport();
    const recommendations = [];
    
    // Low fill rate
    if (report.fillRate < this.thresholds.minFillRate) {
      recommendations.push(`⚠️  Low fill rate (${(report.fillRate * 100).toFixed(1)}%)`);
      recommendations.push('   → Increase slippage tolerance');
      recommendations.push('   → Use market orders instead of limit orders');
      recommendations.push('   → Check RPC connectivity');
    }
    
    // High slippage
    if (report.avgSlippageBps > this.thresholds.maxSlippageBps) {
      recommendations.push(`⚠️  High slippage (${report.avgSlippageBps.toFixed(2)} bps)`);
      recommendations.push('   → Reduce position size');
      recommendations.push('   → Trade during higher liquidity periods');
      recommendations.push('   → Use limit orders with tighter spreads');
    }
    
    // High latency
    if (report.avgLatencyMs > this.thresholds.maxLatencyMs) {
      recommendations.push(`⚠️  High latency (${report.avgLatencyMs.toFixed(0)}ms)`);
      recommendations.push('   → Switch to faster RPC (QuickNode/Helius)');
      recommendations.push('   → Optimize bot loop speed');
      recommendations.push('   → Check network connectivity');
    }
    
    // High rejection rate
    if (report.rejectionRate > this.thresholds.maxRejectionRate) {
      recommendations.push(`⚠️  High rejection rate (${(report.rejectionRate * 100).toFixed(1)}%)`);
      recommendations.push(`   → Top blocking gate: ${report.topBlockingGate.gate} (${report.topBlockingGate.count} blocks)`);
      
      // Specific recommendations based on top blocking gate
      if (report.topBlockingGate.gate === 'volatility') {
        recommendations.push('   → Adjust volatility thresholds (MIN_VOLATILITY_PERCENT, MAX_VOLATILITY_PERCENT)');
      } else if (report.topBlockingGate.gate === 'circuitBreaker') {
        recommendations.push('   → Review recent losses, improve entry patterns');
      } else if (report.topBlockingGate.gate === 'maxPositions') {
        recommendations.push('   → Increase MAX_OPEN_POSITIONS or close existing positions faster');
      } else if (report.topBlockingGate.gate === 'funding') {
        recommendations.push('   → Adjust MAX_FUNDING_RATE_PERCENT threshold');
      } else if (report.topBlockingGate.gate === 'feeOptimization') {
        recommendations.push('   → Increase take profit targets (SCALPING_TAKE_PROFIT_PERCENT)');
        recommendations.push('   → Improve win rate (focus on high-confidence patterns)');
      }
    }
    
    // Quality score recommendations
    if (report.qualityScore < 70) {
      recommendations.push('⚠️  Overall execution quality is poor');
      recommendations.push('   → Consider pausing trading until issues are resolved');
      recommendations.push('   → Review all execution metrics and thresholds');
    }
    
    return recommendations;
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this.executions = [];
    this.gateBlocks = {
      volatility: 0,
      circuitBreaker: 0,
      maxPositions: 0,
      funding: 0,
      feeOptimization: 0,
      riskManager: 0,
      other: 0,
    };
    this.lastAlerts = {};
    this.startTime = Date.now();
  }
}

module.exports = ExecutionQualityMonitor;

