// utils/priority-fee-calculator.js
const axios = require('axios');

/**
 * Priority Fee Calculator for Solana Transactions
 * 
 * Dynamically calculates priority fees (compute units) based on:
 * - Market volatility (ATR)
 * - Trade urgency (entry vs exit)
 * - Network congestion (via QuickNode Priority Fee API)
 * 
 * Priority fees in Solana are specified in micro-lamports per compute unit.
 * Higher fees = faster transaction processing
 * 
 * QuickNode Integration:
 * - Uses QuickNode qn_estimatePriorityFees API for real-time network fee estimates
 * - Falls back to static calculation if API unavailable
 * 
 * Usage:
 *   const calc = new PriorityFeeCalculator({ quicknodeUrl });
 *   const fee = await calc.calculateFee({ volatility: 'high', urgency: 'exit' });
 */

class PriorityFeeCalculator {
  constructor(options = {}) {
    // Strategy type (scalping or momentum)
    this.strategyType = options.strategyType || process.env.STRATEGY_TYPE || 'momentum';
    
    // Enable/disable dynamic fees (scalping only)
    this.enabled = this.strategyType === 'scalping' 
      && (options.enabled !== false)
      && (process.env.SCALPING_ENABLE_PRIORITY_FEES !== 'false');
    
    // QuickNode RPC URL (for Priority Fee API)
    this.quicknodeUrl = options.quicknodeUrl || process.env.RPC_QUICKNODE_URL || null;
    this.useQuickNodeAPI = this.enabled && this.quicknodeUrl && this.quicknodeUrl.includes('quiknode.pro');
    
    // Cache for QuickNode API responses (10 second TTL to avoid rate limits)
    this.quicknodeCache = null;
    this.quicknodeCacheTime = 0;
    this.quicknodeCacheTTL = 10000; // 10 seconds (avoid 429 rate limit errors)
    
    if (!this.enabled) {
      // Use fixed fee for momentum or when disabled
      this.fixedFee = Number(process.env.MOMENTUM_PRIORITY_FEE) || 5000;
      console.log('[PriorityFeeCalc] Initialized (DISABLED)');
      console.log(`[PriorityFeeCalc] Strategy: ${this.strategyType}, Fixed Fee: ${this.fixedFee}`);
      return;
    }
    
    // Dynamic fees (scalping only)
    // Base fees (micro-lamports per compute unit)
    this.baseFee = options.baseFee || Number(process.env.PRIORITY_FEE_BASE) || 1000;
    
    // Volatility-based fees
    this.lowVolFee = options.lowVolFee || Number(process.env.PRIORITY_FEE_LOW_VOL) || 1000;
    this.medVolFee = options.medVolFee || Number(process.env.PRIORITY_FEE_MED_VOL) || 5000;
    this.highVolFee = options.highVolFee || Number(process.env.PRIORITY_FEE_HIGH_VOL) || 10000;
    
    // Urgency-based fees
    this.entryFee = options.entryFee || Number(process.env.PRIORITY_FEE_ENTRY) || 5000;
    this.exitFee = options.exitFee || Number(process.env.PRIORITY_FEE_EXIT) || 10000;
    
    // Max fee (safety limit)
    this.maxFee = options.maxFee || Number(process.env.PRIORITY_FEE_MAX) || 50000;
    
    // Volatility thresholds (ATR as % of price)
    this.lowVolThreshold = 0.5;   // < 0.5% ATR = low volatility
    this.medVolThreshold = 1.5;   // 0.5-1.5% ATR = medium volatility
    // > 1.5% ATR = high volatility
    
    console.log('[PriorityFeeCalc] Initialized (ENABLED)');
    console.log(`[PriorityFeeCalc] Strategy: ${this.strategyType}, Base: ${this.baseFee}, Max: ${this.maxFee}`);
    console.log(`[PriorityFeeCalc] QuickNode API: ${this.useQuickNodeAPI ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Fetch real-time priority fee estimates from QuickNode API
   * 
   * @returns {Promise<Object|null>} { low, medium, high, veryHigh } or null if unavailable
   */
  async fetchQuickNodeFees() {
    if (!this.useQuickNodeAPI) {
      return null;
    }
    
    // Check cache
    const now = Date.now();
    if (this.quicknodeCache && (now - this.quicknodeCacheTime) < this.quicknodeCacheTTL) {
      return this.quicknodeCache;
    }
    
    try {
      // Convert WebSocket URL to HTTP if needed
      const httpUrl = this.quicknodeUrl.replace('wss://', 'https://').replace('ws://', 'http://');
      
      const response = await axios.post(httpUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'qn_estimatePriorityFees',
        params: {
          last_n_blocks: 100, // Analyze last 100 blocks
          account: null, // Global estimate (not account-specific)
        },
      }, {
        timeout: 3000, // 3 second timeout
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (response.data && response.data.result) {
        const result = response.data.result;
        
        // QuickNode returns fees in different percentile levels
        const fees = {
          low: result.per_compute_unit?.low || result.low || 1000,
          medium: result.per_compute_unit?.medium || result.medium || 5000,
          high: result.per_compute_unit?.high || result.high || 10000,
          veryHigh: result.per_compute_unit?.very_high || result.very_high || 20000,
        };
        
        // Cache the result
        this.quicknodeCache = fees;
        this.quicknodeCacheTime = now;
        
        return fees;
      }
      
      return null;
      
    } catch (error) {
      console.warn('[PriorityFeeCalc] QuickNode API error:', error.message);
      return null;
    }
  }
  
  /**
   * Calculate priority fee based on market conditions and trade type
   * 
   * @param {Object} params
   * @param {number} params.atr - Average True Range as % of price (e.g., 1.2 for 1.2%)
   * @param {string} params.urgency - 'entry' or 'exit'
   * @param {string} params.volatility - 'low', 'medium', 'high' (optional, auto-detected from ATR)
   * @param {Object} params.quicknodeFees - QuickNode API fees (optional, from fetchQuickNodeFees)
   * @returns {Promise<number>} Priority fee in micro-lamports per compute unit
   */
  async calculateFee(params = {}) {
    // If disabled (momentum or toggle off), return fixed fee
    if (!this.enabled) {
      return this.fixedFee;
    }
    
    const { atr, urgency, volatility, quicknodeFees } = params;
    
    // Try to get real-time network fees from QuickNode
    const networkFees = quicknodeFees || await this.fetchQuickNodeFees();
    
    let fee = this.baseFee;
    
    // 1. Start with network-based fee if available (QuickNode API)
    if (networkFees) {
      // Use QuickNode's real-time network fees as base
      const vol = volatility || this._detectVolatility(atr);
      
      if (vol === 'low') {
        fee = networkFees.low;
      } else if (vol === 'medium') {
        fee = networkFees.medium;
      } else if (vol === 'high') {
        fee = networkFees.high;
      }
      
      // Adjust for urgency
      if (urgency === 'entry') {
        fee = Math.max(fee, networkFees.medium);
      } else if (urgency === 'exit') {
        fee = Math.max(fee, networkFees.high);
      }
    } else {
      // Fallback to static calculation
      const vol = volatility || this._detectVolatility(atr);
      
      if (vol === 'low') {
        fee = this.lowVolFee;
      } else if (vol === 'medium') {
        fee = this.medVolFee;
      } else if (vol === 'high') {
        fee = this.highVolFee;
      }
      
      // Adjust for urgency
      if (urgency === 'entry') {
        fee = Math.max(fee, this.entryFee);
      } else if (urgency === 'exit') {
        fee = Math.max(fee, this.exitFee);
      }
    }
    
    // 2. Apply max limit
    fee = Math.min(fee, this.maxFee);
    
    // 3. Round to nearest 100
    fee = Math.round(fee / 100) * 100;
    
    return fee;
  }
  
  /**
   * Detect volatility level from ATR
   * 
   * @param {number} atr - ATR as % of price (e.g., 1.2 for 1.2%)
   * @returns {string} 'low', 'medium', or 'high'
   */
  _detectVolatility(atr) {
    if (!atr || !Number.isFinite(atr)) {
      return 'medium'; // Default
    }
    
    if (atr < this.lowVolThreshold) {
      return 'low';
    } else if (atr < this.medVolThreshold) {
      return 'medium';
    } else {
      return 'high';
    }
  }
  
  /**
   * Calculate fee for opening a position
   * 
   * @param {number} atr - ATR as % of price
   * @returns {number} Priority fee
   */
  calculateEntryFee(atr) {
    return this.calculateFee({ atr, urgency: 'entry' });
  }
  
  /**
   * Calculate fee for closing a position
   * 
   * @param {number} atr - ATR as % of price
   * @returns {number} Priority fee
   */
  calculateExitFee(atr) {
    return this.calculateFee({ atr, urgency: 'exit' });
  }
  
  /**
   * Get fee recommendation with explanation
   * 
   * @param {Object} params - Same as calculateFee
   * @returns {Object} { fee, volatility, urgency, explanation }
   */
  getFeeRecommendation(params) {
    const { atr, urgency } = params;
    const volatility = this._detectVolatility(atr);
    const fee = this.calculateFee(params);
    
    const explanation = [
      `Volatility: ${volatility} (ATR: ${atr?.toFixed(2)}%)`,
      `Urgency: ${urgency || 'normal'}`,
      `Fee: ${fee} micro-lamports/CU`,
    ].join(' | ');
    
    return {
      fee,
      volatility,
      urgency: urgency || 'normal',
      explanation,
    };
  }
  
  /**
   * Estimate transaction cost in SOL
   * 
   * @param {number} priorityFee - Priority fee in micro-lamports/CU
   * @param {number} computeUnits - Estimated compute units (default: 200,000)
   * @param {number} solPrice - SOL price in USD (optional)
   * @returns {Object} { lamports, sol, usd }
   */
  estimateCost(priorityFee, computeUnits = 200000, solPrice = null) {
    // Priority fee cost
    const priorityCostLamports = (priorityFee * computeUnits) / 1000000; // Convert micro-lamports to lamports
    
    // Base transaction fee (5000 lamports)
    const baseFee = 5000;
    
    // Total cost
    const totalLamports = baseFee + priorityCostLamports;
    const totalSol = totalLamports / 1e9;
    const totalUsd = solPrice ? totalSol * solPrice : null;
    
    return {
      lamports: Math.round(totalLamports),
      sol: totalSol.toFixed(9),
      usd: totalUsd ? `$${totalUsd.toFixed(4)}` : null,
      breakdown: {
        baseFee: baseFee,
        priorityFee: Math.round(priorityCostLamports),
      },
    };
  }
  
  /**
   * Get stats about fee usage
   */
  getStats() {
    if (!this.enabled) {
      return {
        enabled: false,
        strategyType: this.strategyType,
        fixedFee: this.fixedFee,
        note: 'Dynamic priority fees disabled (momentum strategy or toggle off)',
      };
    }
    
    return {
      enabled: true,
      strategyType: this.strategyType,
      baseFee: this.baseFee,
      lowVolFee: this.lowVolFee,
      medVolFee: this.medVolFee,
      highVolFee: this.highVolFee,
      entryFee: this.entryFee,
      exitFee: this.exitFee,
      maxFee: this.maxFee,
      thresholds: {
        lowVol: `< ${this.lowVolThreshold}%`,
        medVol: `${this.lowVolThreshold}% - ${this.medVolThreshold}%`,
        highVol: `> ${this.medVolThreshold}%`,
      },
    };
  }
}

module.exports = PriorityFeeCalculator;

