// utils/slippage-controller.js

/**
 * Dynamic Slippage Controller for Solana Transactions
 * 
 * Dynamically adjusts slippage tolerance based on:
 * - Market volatility (ATR)
 * - Trade urgency (entry vs exit)
 * - Trade size relative to liquidity
 * 
 * For scalping, tight slippage control is critical:
 * - Prevents bad fills that eat into tight profit targets (0.2-0.8%)
 * - Balances fill rate vs execution quality
 * - Adapts to market conditions in real-time
 * 
 * Usage:
 *   const controller = new SlippageController({ strategyType: 'scalping' });
 *   const slippage = controller.calculateSlippage({ atr: 1.2, urgency: 'entry' });
 */

class SlippageController {
  constructor(options = {}) {
    // Strategy type (scalping or momentum)
    this.strategyType = options.strategyType || process.env.STRATEGY_TYPE || 'momentum';
    
    // Enable/disable dynamic slippage (scalping only)
    this.enabled = this.strategyType === 'scalping' 
      && (options.enabled !== false)
      && (process.env.SCALPING_ENABLE_DYNAMIC_SLIPPAGE !== 'false');
    
    if (!this.enabled) {
      // Use fixed slippage for momentum or when disabled
      this.fixedSlippage = Number(process.env.MOMENTUM_SLIPPAGE_BPS) || 50; // 0.5%
      console.log('[SlippageController] Initialized (DISABLED)');
      console.log(`[SlippageController] Strategy: ${this.strategyType}, Fixed Slippage: ${this.fixedSlippage} bps`);
      return;
    }
    
    // Dynamic slippage (scalping only)
    // Base slippage (basis points, 1 bps = 0.01%)
    this.baseSlippage = options.baseSlippage || Number(process.env.SLIPPAGE_BASE_BPS) || 10; // 0.1%
    
    // Volatility-based slippage (ATR-scaled)
    this.lowVolSlippage = options.lowVolSlippage || Number(process.env.SLIPPAGE_LOW_VOL_BPS) || 10;  // 0.1%
    this.medVolSlippage = options.medVolSlippage || Number(process.env.SLIPPAGE_MED_VOL_BPS) || 20;  // 0.2%
    this.highVolSlippage = options.highVolSlippage || Number(process.env.SLIPPAGE_HIGH_VOL_BPS) || 50; // 0.5%
    
    // Urgency-based slippage
    this.entrySlippage = options.entrySlippage || Number(process.env.SLIPPAGE_ENTRY_BPS) || 15;  // 0.15%
    this.exitSlippage = options.exitSlippage || Number(process.env.SLIPPAGE_EXIT_BPS) || 30;    // 0.3%
    
    // Max slippage (safety limit)
    this.maxSlippage = options.maxSlippage || Number(process.env.SLIPPAGE_MAX_BPS) || 100; // 1.0%
    
    // Min slippage (prevent too tight)
    this.minSlippage = options.minSlippage || Number(process.env.SLIPPAGE_MIN_BPS) || 5; // 0.05%
    
    // Volatility thresholds (ATR as % of price)
    this.lowVolThreshold = 0.5;   // < 0.5% ATR = low volatility
    this.medVolThreshold = 1.5;   // 0.5-1.5% ATR = medium volatility
    // > 1.5% ATR = high volatility
    
    // ATR multiplier (how much to scale slippage by ATR)
    this.atrMultiplier = options.atrMultiplier || Number(process.env.SLIPPAGE_ATR_MULTIPLIER) || 10;
    
    console.log('[SlippageController] Initialized (ENABLED)');
    console.log(`[SlippageController] Strategy: ${this.strategyType}, Base: ${this.baseSlippage} bps, Max: ${this.maxSlippage} bps`);
  }
  
  /**
   * Calculate optimal slippage tolerance based on market conditions
   * 
   * @param {Object} params
   * @param {number} params.atr - Average True Range as % of price (e.g., 1.2 for 1.2%)
   * @param {string} params.urgency - 'entry' or 'exit'
   * @param {string} params.volatility - 'low', 'medium', 'high' (optional, auto-detected from ATR)
   * @param {number} params.positionSizeUsd - Position size in USD (optional, for liquidity-based scaling)
   * @param {number} params.liquidityUsd - Available liquidity in USD (optional, for liquidity-based scaling)
   * @returns {number} Slippage tolerance in basis points (bps)
   */
  calculateSlippage(params = {}) {
    // If disabled (momentum or toggle off), return fixed slippage
    if (!this.enabled) {
      return this.fixedSlippage;
    }
    
    const { atr, urgency, volatility, positionSizeUsd, liquidityUsd } = params;
    
    let slippage = this.baseSlippage;
    
    // 1. Start with volatility-based slippage
    const vol = volatility || this._detectVolatility(atr);
    
    if (vol === 'low') {
      slippage = this.lowVolSlippage;
    } else if (vol === 'medium') {
      slippage = this.medVolSlippage;
    } else if (vol === 'high') {
      slippage = this.highVolSlippage;
    }
    
    // 2. Scale by ATR (more precise than just low/med/high)
    if (Number.isFinite(atr) && atr > 0) {
      // ATR-scaled slippage: base + (ATR * multiplier)
      // Example: 0.1% base + (1.2% ATR * 10) = 0.1% + 12 bps = 12.1 bps = 0.121%
      const atrScaled = this.baseSlippage + (atr * this.atrMultiplier);
      slippage = Math.max(slippage, atrScaled);
    }
    
    // 3. Adjust for urgency
    if (urgency === 'entry') {
      slippage = Math.max(slippage, this.entrySlippage);
    } else if (urgency === 'exit') {
      slippage = Math.max(slippage, this.exitSlippage);
    }
    
    // 4. Adjust for position size vs liquidity (if provided)
    if (Number.isFinite(positionSizeUsd) && Number.isFinite(liquidityUsd) && liquidityUsd > 0) {
      const sizeRatio = positionSizeUsd / liquidityUsd;
      
      // If position is > 1% of liquidity, increase slippage
      if (sizeRatio > 0.01) {
        const liquidityMultiplier = 1 + (sizeRatio * 10); // +10% slippage per 1% of liquidity
        slippage *= liquidityMultiplier;
      }
    }
    
    // 5. Apply min/max limits
    slippage = Math.max(this.minSlippage, Math.min(slippage, this.maxSlippage));
    
    // 6. Round to nearest 1 bps
    slippage = Math.round(slippage);
    
    return slippage;
  }
  
  /**
   * Detect volatility level from ATR
   * 
   * @param {number} atr - ATR as % of price (e.g., 1.2 for 1.2%)
   * @returns {string} 'low', 'medium', or 'high'
   */
  _detectVolatility(atr) {
    if (!Number.isFinite(atr) || atr <= 0) {
      return 'medium'; // Default to medium if invalid
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
   * Convert basis points to decimal (for Jupiter API)
   * 
   * @param {number} bps - Slippage in basis points
   * @returns {number} Slippage as decimal (e.g., 0.001 for 10 bps)
   */
  bpsToDecimal(bps) {
    return bps / 10000;
  }
  
  /**
   * Convert basis points to percentage string
   * 
   * @param {number} bps - Slippage in basis points
   * @returns {string} Slippage as percentage (e.g., "0.10%")
   */
  bpsToPercent(bps) {
    return `${(bps / 100).toFixed(2)}%`;
  }
  
  /**
   * Get controller statistics
   * 
   * @returns {Object} Statistics object
   */
  getStats() {
    if (!this.enabled) {
      return {
        enabled: false,
        strategyType: this.strategyType,
        fixedSlippage: this.fixedSlippage,
        fixedSlippagePercent: this.bpsToPercent(this.fixedSlippage),
        note: 'Dynamic slippage disabled (momentum strategy or toggle off)',
      };
    }
    
    return {
      enabled: true,
      strategyType: this.strategyType,
      baseSlippage: this.baseSlippage,
      minSlippage: this.minSlippage,
      maxSlippage: this.maxSlippage,
      volatilitySlippage: {
        low: this.lowVolSlippage,
        medium: this.medVolSlippage,
        high: this.highVolSlippage,
      },
      urgencySlippage: {
        entry: this.entrySlippage,
        exit: this.exitSlippage,
      },
      atrMultiplier: this.atrMultiplier,
      ranges: {
        base: this.bpsToPercent(this.baseSlippage),
        min: this.bpsToPercent(this.minSlippage),
        max: this.bpsToPercent(this.maxSlippage),
      },
    };
  }
}

module.exports = SlippageController;

