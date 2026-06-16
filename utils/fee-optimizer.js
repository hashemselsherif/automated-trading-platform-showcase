// utils/fee-optimizer.js

/**
 * Fee Optimizer for Scalping Trades
 * 
 * Validates that expected profit exceeds transaction fees by a minimum ratio.
 * Critical for scalping where tight profit margins (0.2-0.8%) can be eaten by fees.
 * 
 * Fee Components:
 * 1. Jupiter Perpetuals Trading Fee: ~0.06% (6 bps) per trade
 * 2. Solana Network Fee: ~0.000005 SOL (~$0.0005 @ $100 SOL)
 * 3. Priority Fee: 1000-50000 micro-lamports (dynamic)
 * 4. Slippage: 10-100 bps (dynamic)
 * 
 * Total Fees: ~0.15-0.30% per round trip (entry + exit)
 * 
 * For scalping to be profitable:
 *   expectedProfit > totalFees * minProfitToFeeRatio
 * 
 * Usage:
 *   const optimizer = new FeeOptimizer({ strategyType: 'scalping' });
 *   const validation = optimizer.validateTrade({
 *     entryPrice: 100,
 *     takeProfitPrice: 100.40,
 *     stopLossPrice: 99.85,
 *     positionSizeUsd: 1000,
 *   });
 *   if (!validation.profitable) {
 *     console.log('Trade rejected:', validation.reason);
 *   }
 */

class FeeOptimizer {
  constructor(options = {}) {
    // Strategy type (scalping or momentum)
    this.strategyType = options.strategyType || process.env.STRATEGY_TYPE || 'momentum';
    
    // Enable/disable fee optimization (scalping only)
    this.enabled = this.strategyType === 'scalping' 
      && (options.enabled !== false)
      && (process.env.SCALPING_ENABLE_FEE_OPTIMIZATION !== 'false');
    
    if (!this.enabled) {
      console.log('[FeeOptimizer] Initialized (DISABLED)');
      console.log(`[FeeOptimizer] Strategy: ${this.strategyType}`);
      return;
    }
    
    // Fee configuration (basis points, 1 bps = 0.01%)
    // Jupiter Perpetuals fees
    this.tradingFeeBps = options.tradingFeeBps || Number(process.env.JUPITER_TRADING_FEE_BPS) || 6; // 0.06%
    
    // Network fees (estimated in USD)
    this.networkFeeUsd = options.networkFeeUsd || Number(process.env.NETWORK_FEE_USD) || 0.001; // ~$0.001
    
    // Priority fee (estimated in USD, dynamic)
    this.priorityFeeUsd = options.priorityFeeUsd || Number(process.env.PRIORITY_FEE_USD) || 0.0005; // ~$0.0005
    
    // Slippage (basis points, dynamic)
    this.slippageBps = options.slippageBps || Number(process.env.SLIPPAGE_ESTIMATE_BPS) || 15; // 0.15% (optimistic with dynamic slippage)
    
    // Minimum profit-to-fee ratio
    // For scalping: profit should be at least 1.5x total fees (relaxed from 2x due to high fee reality)
    this.minProfitToFeeRatio = options.minProfitToFeeRatio || Number(process.env.MIN_PROFIT_TO_FEE_RATIO) || 1.5;
    
    // Minimum expected profit (basis points)
    // Reject trades with expected profit < this threshold
    // Set to 0 by default to allow EV-positive trades (even if small)
    this.minExpectedProfitBps = options.minExpectedProfitBps || Number(process.env.MIN_EXPECTED_PROFIT_BPS) || 0; // 0% (allow any positive EV)
    
    // Track statistics
    this.stats = {
      tradesValidated: 0,
      tradesAccepted: 0,
      tradesRejected: 0,
      rejectionReasons: {},
    };
    
    console.log('[FeeOptimizer] Initialized (ENABLED)');
    console.log(`[FeeOptimizer] Strategy: ${this.strategyType}`);
    console.log(`[FeeOptimizer] Min Profit/Fee Ratio: ${this.minProfitToFeeRatio}x`);
    console.log(`[FeeOptimizer] Min Expected Profit: ${this.minExpectedProfitBps} bps`);
  }
  
  /**
   * Validate if a trade is profitable after fees
   * 
   * @param {Object} params
   * @param {number} params.entryPrice - Entry price
   * @param {number} params.takeProfitPrice - Take profit price
   * @param {number} params.stopLossPrice - Stop loss price
   * @param {number} params.positionSizeUsd - Position size in USD
   * @param {number} params.winRate - Expected win rate (0-1, optional)
   * @param {number} params.priorityFeeBps - Priority fee in bps (optional, overrides default)
   * @param {number} params.slippageBps - Slippage in bps (optional, overrides default)
   * @returns {Object} Validation result { profitable, reason, expectedProfit, totalFees, ratio }
   */
  validateTrade(params = {}) {
    // If disabled (momentum or toggle off), always accept
    if (!this.enabled) {
      return {
        profitable: true,
        reason: 'Fee optimization disabled',
        expectedProfit: 0,
        totalFees: 0,
        ratio: Infinity,
      };
    }
    
    this.stats.tradesValidated++;
    
    const {
      entryPrice,
      takeProfitPrice,
      stopLossPrice,
      positionSizeUsd,
      winRate = 0.40, // Default 40% win rate
      priorityFeeBps,
      slippageBps,
    } = params;
    
    // Validate inputs
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return this._reject('Invalid entry price');
    }
    if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0) {
      return this._reject('Invalid take profit price');
    }
    if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
      return this._reject('Invalid stop loss price');
    }
    if (!Number.isFinite(positionSizeUsd) || positionSizeUsd <= 0) {
      return this._reject('Invalid position size');
    }
    
    // Calculate expected profit (win scenario)
    const profitPercent = Math.abs((takeProfitPrice - entryPrice) / entryPrice);
    const profitBps = profitPercent * 10000;
    
    // Calculate expected loss (loss scenario)
    const lossPercent = Math.abs((stopLossPrice - entryPrice) / entryPrice);
    const lossBps = lossPercent * 10000;
    
    // Calculate total fees (round trip: entry + exit)
    const totalFees = this._calculateTotalFees({
      positionSizeUsd,
      priorityFeeBps,
      slippageBps,
    });
    
    const totalFeesBps = (totalFees / positionSizeUsd) * 10000;
    
    // Calculate expected value (EV)
    // EV = (winRate * profit) - (lossRate * loss) - fees
    const expectedProfit = (winRate * profitBps) - ((1 - winRate) * lossBps) - totalFeesBps;
    
    // Validate minimum expected profit
    if (expectedProfit < this.minExpectedProfitBps) {
      return this._reject(
        `Expected profit too low (${expectedProfit.toFixed(2)} bps < ${this.minExpectedProfitBps} bps)`,
        { expectedProfit, totalFees: totalFeesBps, ratio: expectedProfit / totalFeesBps }
      );
    }
    
    // Validate profit-to-fee ratio (for winning trades)
    const profitToFeeRatio = profitBps / totalFeesBps;
    
    if (profitToFeeRatio < this.minProfitToFeeRatio) {
      return this._reject(
        `Profit/fee ratio too low (${profitToFeeRatio.toFixed(2)}x < ${this.minProfitToFeeRatio}x)`,
        { expectedProfit, totalFees: totalFeesBps, ratio: profitToFeeRatio }
      );
    }
    
    // Trade is profitable
    this.stats.tradesAccepted++;
    
    return {
      profitable: true,
      reason: 'Trade meets profitability criteria',
      expectedProfit,
      expectedProfitUsd: (expectedProfit / 10000) * positionSizeUsd,
      totalFees: totalFeesBps,
      totalFeesUsd: totalFees,
      ratio: profitToFeeRatio,
      winRate,
      profitBps,
      lossBps,
    };
  }
  
  /**
   * Calculate total fees for a round trip trade (entry + exit)
   * 
   * @param {Object} params
   * @param {number} params.positionSizeUsd - Position size in USD
   * @param {number} params.priorityFeeBps - Priority fee in bps (optional)
   * @param {number} params.slippageBps - Slippage in bps (optional)
   * @returns {number} Total fees in USD
   */
  _calculateTotalFees(params = {}) {
    const { positionSizeUsd, priorityFeeBps, slippageBps } = params;
    
    // 1. Trading fees (entry + exit)
    const tradingFees = (this.tradingFeeBps / 10000) * positionSizeUsd * 2; // Round trip
    
    // 2. Network fees (entry + exit)
    const networkFees = this.networkFeeUsd * 2;
    
    // 3. Priority fees (entry + exit)
    const priorityFees = this.priorityFeeUsd * 2;
    
    // 4. Slippage costs (entry + exit)
    const slippage = slippageBps || this.slippageBps;
    const slippageCosts = (slippage / 10000) * positionSizeUsd * 2;
    
    return tradingFees + networkFees + priorityFees + slippageCosts;
  }
  
  /**
   * Reject a trade with reason
   * 
   * @param {string} reason - Rejection reason
   * @param {Object} data - Additional data (optional)
   * @returns {Object} Rejection result
   */
  _reject(reason, data = {}) {
    this.stats.tradesRejected++;
    
    // Track rejection reasons
    if (!this.stats.rejectionReasons[reason]) {
      this.stats.rejectionReasons[reason] = 0;
    }
    this.stats.rejectionReasons[reason]++;
    
    return {
      profitable: false,
      reason,
      ...data,
    };
  }
  
  /**
   * Get optimizer statistics
   * 
   * @returns {Object} Statistics object
   */
  getStats() {
    if (!this.enabled) {
      return {
        enabled: false,
        strategyType: this.strategyType,
        note: 'Fee optimization disabled (momentum strategy or toggle off)',
      };
    }
    
    const acceptanceRate = this.stats.tradesValidated > 0
      ? (this.stats.tradesAccepted / this.stats.tradesValidated) * 100
      : 0;
    
    return {
      enabled: true,
      strategyType: this.strategyType,
      minProfitToFeeRatio: this.minProfitToFeeRatio,
      minExpectedProfitBps: this.minExpectedProfitBps,
      fees: {
        tradingFeeBps: this.tradingFeeBps,
        networkFeeUsd: this.networkFeeUsd,
        priorityFeeUsd: this.priorityFeeUsd,
        slippageBps: this.slippageBps,
      },
      stats: {
        tradesValidated: this.stats.tradesValidated,
        tradesAccepted: this.stats.tradesAccepted,
        tradesRejected: this.stats.tradesRejected,
        acceptanceRate: `${acceptanceRate.toFixed(2)}%`,
        rejectionReasons: this.stats.rejectionReasons,
      },
    };
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      tradesValidated: 0,
      tradesAccepted: 0,
      tradesRejected: 0,
      rejectionReasons: {},
    };
  }
}

module.exports = FeeOptimizer;

