// Dynamic Leverage Manager
// Implements leverage adjustment strategies used by top traders:
//   - Volatility-based (ATR): Lower leverage in high volatility
//   - Trend strength (ADX): Higher leverage in strong trends
//   - Confidence-based: Scale with strategy confidence
//   - Portfolio risk: Adjust based on existing positions
//   - Funding rate: Lower leverage when funding unfavorable
//   - Drawdown protection: Reduce leverage after losses
//   - Kelly Criterion: Optimal leverage based on win rate

class DynamicLeverageManager {
  constructor(config = {}) {
    this.config = {
      // Base leverage settings
      baseLeverage: config.baseLeverage || 2,
      minLeverage: config.minLeverage || 1,
      // Use config value if explicitly set (even if 0), otherwise use default
      // This ensures maxLeverage from config is respected
      maxLeverage: config.maxLeverage !== undefined && config.maxLeverage !== null 
        ? config.maxLeverage 
        : 5,
      
      // NEW: Dynamic max leverage throttle (testing)
      useDynamicMaxLev: config.useDynamicMaxLev || false, // Enable to override maxLeverage dynamically
      
      // Volatility-based adjustment
      volatilityAdjustment: config.volatilityAdjustment !== false, // Enable by default
      volatilityThresholds: {
        low: config.volatilityThresholds?.low || 1.0,  // ATR % below this = low vol
        high: config.volatilityThresholds?.high || 2.5,  // ATR % above this = high vol
      },
      volatilityMultipliers: {
        low: config.volatilityMultipliers?.low || 1.2,   // Increase leverage in low vol
        high: config.volatilityMultipliers?.high || 0.7, // Decrease leverage in high vol
      },
      
      // Trend strength (ADX) adjustment
      adxAdjustment: config.adxAdjustment !== false,
      adxThresholds: {
        weak: config.adxThresholds?.weak || 20,   // Below = weak trend
        strong: config.adxThresholds?.strong || 40, // Above = strong trend
      },
      adxMultipliers: {
        weak: config.adxMultipliers?.weak || 0.8,   // Reduce leverage in weak trends
        strong: config.adxMultipliers?.strong || 1.2, // Increase leverage in strong trends
      },
      
      // Drawdown protection
      drawdownProtection: config.drawdownProtection !== false,
      drawdownThreshold: config.drawdownThreshold || 0.15, // 15% drawdown
      drawdownMultiplier: config.drawdownMultiplier || 0.6, // Reduce leverage by 40%
      
      // NEW: Daily drawdown protection for maxLeverage throttle
      dailyDrawdownThreshold: config.dailyDrawdownThreshold || 0.03, // 3% daily drawdown
      
      // Confidence-based adjustment
      confidenceAdjustment: config.confidenceAdjustment !== false,
      confidenceThresholds: {
        low: config.confidenceThresholds?.low || 1.0,
        high: config.confidenceThresholds?.high || 2.5,
      },
      confidenceMultipliers: {
        low: config.confidenceMultipliers?.low || 0.8,
        high: config.confidenceMultipliers?.high || 1.3,
      },
      
      // Portfolio risk adjustment
      portfolioRiskAdjustment: config.portfolioRiskAdjustment !== false,
      portfolioLeverageThreshold: config.portfolioLeverageThreshold || 0.7, // 70% of max
      portfolioMultiplier: config.portfolioMultiplier || 0.8, // Reduce by 20% when near limit
      
      // Funding rate adjustment
      fundingAdjustment: config.fundingAdjustment !== false,
      maxFundingRatePercent: config.maxFundingRatePercent || 0.1,
      fundingMultiplier: config.fundingMultiplier || 0.7, // Reduce leverage when funding unfavorable
      
      // Kelly Criterion (optional, advanced)
      useKelly: config.useKelly || false,
      winRate: config.winRate || 0.55, // Default win rate
      avgWinLossRatio: config.avgWinLossRatio || 1.2, // Default win/loss ratio
      
      // Performance tracking
      trackPerformance: config.trackPerformance !== false,
    };
    
    // Performance tracking for drawdown protection
    if (this.config.trackPerformance) {
      this.performanceHistory = [];
      this.maxHistorySize = 100;
      this.peakBalance = null;
    }
    
    // Daily P&L tracking for daily drawdown protection
    this.dailyPnLHistory = []; // [{date, pnl, balance}]
    this.maxDailyHistory = 30; // Keep 30 days
  }

  /**
   * Calculate dynamic leverage based on market conditions
   * @param {Object} context - Market and strategy context
   * @param {number} context.price - Current price
   * @param {string} context.side - 'long' or 'short'
   * @param {Object} context.strategy - Strategy instance (for ATR, ADX, confidence)
   * @param {Array} context.positions - Current open positions
   * @param {number} context.availableCapital - Available capital
   * @param {Object} context.portfolioRisk - PortfolioRiskManager instance
   * @param {number} context.fundingRate - Current funding rate (optional)
   * @param {number} context.currentBalance - Current account balance (for drawdown)
   * @returns {Object} - { leverage: number, adjustments: Object, reason: string }
   */
  calculateLeverage(context = {}) {
    const {
      price,
      side,
      strategy,
      positions = [],
      availableCapital,
      portfolioRisk,
      fundingRate = 0,
      currentBalance,
    } = context;

    let leverage = this.config.baseLeverage;
    const adjustments = {};
    const reasons = [];

    // 1. Volatility-based adjustment (ATR)
    if (this.config.volatilityAdjustment && strategy?.atr && price) {
      const atrPercent = (strategy.atr / price) * 100;
      
      if (atrPercent > this.config.volatilityThresholds.high) {
        leverage *= this.config.volatilityMultipliers.high;
        adjustments.volatility = {
          atrPercent: atrPercent.toFixed(2),
          multiplier: this.config.volatilityMultipliers.high,
          reason: 'high_volatility',
        };
        reasons.push(`High volatility (ATR ${atrPercent.toFixed(2)}%): reduce leverage`);
      } else if (atrPercent < this.config.volatilityThresholds.low) {
        leverage *= this.config.volatilityMultipliers.low;
        adjustments.volatility = {
          atrPercent: atrPercent.toFixed(2),
          multiplier: this.config.volatilityMultipliers.low,
          reason: 'low_volatility',
        };
        reasons.push(`Low volatility (ATR ${atrPercent.toFixed(2)}%): increase leverage`);
      }
    }

    // 2. Trend strength adjustment (ADX)
    if (this.config.adxAdjustment && strategy?.adx) {
      if (strategy.adx >= this.config.adxThresholds.strong) {
        leverage *= this.config.adxMultipliers.strong;
        adjustments.trendStrength = {
          adx: strategy.adx.toFixed(2),
          multiplier: this.config.adxMultipliers.strong,
          reason: 'strong_trend',
        };
        reasons.push(`Strong trend (ADX ${strategy.adx.toFixed(2)}): increase leverage`);
      } else if (strategy.adx < this.config.adxThresholds.weak) {
        leverage *= this.config.adxMultipliers.weak;
        adjustments.trendStrength = {
          adx: strategy.adx.toFixed(2),
          multiplier: this.config.adxMultipliers.weak,
          reason: 'weak_trend',
        };
        reasons.push(`Weak trend (ADX ${strategy.adx.toFixed(2)}): reduce leverage`);
      }
    }

    // 3. Confidence-based adjustment
    if (this.config.confidenceAdjustment && strategy && typeof strategy._confidence === 'function') {
      try {
        const currentPrice = price || (strategy.prices && strategy.prices.length > 0 ? strategy.prices[strategy.prices.length - 1] : null);
        if (currentPrice) {
          const confidence = Math.abs(strategy._confidence(currentPrice));
          
          if (confidence >= this.config.confidenceThresholds.high) {
            leverage *= this.config.confidenceMultipliers.high;
            adjustments.confidence = {
              confidence: confidence.toFixed(2),
              multiplier: this.config.confidenceMultipliers.high,
              reason: 'high_confidence',
            };
            reasons.push(`High confidence (${confidence.toFixed(2)}): increase leverage`);
          } else if (confidence < this.config.confidenceThresholds.low) {
            leverage *= this.config.confidenceMultipliers.low;
            adjustments.confidence = {
              confidence: confidence.toFixed(2),
              multiplier: this.config.confidenceMultipliers.low,
              reason: 'low_confidence',
            };
            reasons.push(`Low confidence (${confidence.toFixed(2)}): reduce leverage`);
          }
        }
      } catch (e) {
        // Confidence calculation failed, skip this adjustment
      }
    }

    // 4. Portfolio risk adjustment
    if (this.config.portfolioRiskAdjustment && portfolioRisk && availableCapital) {
      const metrics = portfolioRisk.getRiskMetrics(positions, availableCapital);
      const leverageUtilization = metrics.totalLeverage / this.config.portfolioLeverageThreshold;
      
      if (leverageUtilization >= this.config.portfolioLeverageThreshold) {
        leverage *= this.config.portfolioMultiplier;
        adjustments.portfolioRisk = {
          utilization: (leverageUtilization * 100).toFixed(1),
          multiplier: this.config.portfolioMultiplier,
          reason: 'high_portfolio_leverage',
        };
        reasons.push(`High portfolio leverage (${(metrics.totalLeverage).toFixed(2)}x): reduce leverage`);
      }
    }

    // 5. Funding rate adjustment
    if (this.config.fundingAdjustment && fundingRate !== undefined) {
      const fundingRatePercent = fundingRate * 100;
      const maxFunding = this.config.maxFundingRatePercent;
      
      // Unfavorable funding: long when funding is positive, short when negative
      const isUnfavorable = (side === 'long' && fundingRatePercent > maxFunding) ||
                           (side === 'short' && fundingRatePercent < -maxFunding);
      
      if (isUnfavorable) {
        leverage *= this.config.fundingMultiplier;
        adjustments.funding = {
          fundingRatePercent: fundingRatePercent.toFixed(3),
          multiplier: this.config.fundingMultiplier,
          reason: 'unfavorable_funding',
        };
        reasons.push(`Unfavorable funding (${fundingRatePercent.toFixed(3)}%): reduce leverage`);
      }
    }

    // 6. Drawdown protection
    if (this.config.drawdownProtection && currentBalance !== undefined) {
      if (this.config.trackPerformance && this.peakBalance !== null) {
        const drawdown = (this.peakBalance - currentBalance) / this.peakBalance;
        
        if (drawdown >= this.config.drawdownThreshold) {
          leverage *= this.config.drawdownMultiplier;
          adjustments.drawdown = {
            drawdown: (drawdown * 100).toFixed(2),
            multiplier: this.config.drawdownMultiplier,
            reason: 'drawdown_protection',
          };
          reasons.push(`Drawdown protection (${(drawdown * 100).toFixed(2)}%): reduce leverage`);
        }
      }
      
      // Update peak balance
      if (this.peakBalance === null || currentBalance > this.peakBalance) {
        this.peakBalance = currentBalance;
      }
    }

    // 7. NEW: Dynamic maxLeverage throttle (ADX + ATR based)
    let effectiveMaxLeverage = this.config.maxLeverage;
    if (this.config.useDynamicMaxLev && strategy?.atr && strategy?.adx && price) {
      const atrPercent = (strategy.atr / price) * 100;
      const adx = strategy.adx;
      
      // Previous dynamic max logic (coarser tiers)
      // Default to configured maxLeverage instead of hardcoded 3x
      let dynMaxLev = this.config.maxLeverage; // Use configured max leverage as default
      if (adx >= 28 && atrPercent >= 0.5) {
        dynMaxLev = Math.max(7, this.config.maxLeverage); // Can go above configured max when conditions are strong
      } else if (adx >= 22 && adx < 28 && atrPercent >= 0.35) {
        dynMaxLev = Math.max(5, this.config.maxLeverage); // Never go below configured max
      }
      // If conditions don't meet thresholds, use configured maxLeverage (already set above)
      
      // Check for daily drawdown reduction
      const dailyDrawdownReduction = this._checkDailyDrawdown();
      if (dailyDrawdownReduction > 1) {
        dynMaxLev = Math.floor(dynMaxLev / dailyDrawdownReduction);
        // Ensure we never go below configured max even after drawdown reduction
        dynMaxLev = Math.max(dynMaxLev, this.config.maxLeverage);
        adjustments.dailyDrawdown = {
          reduction: dailyDrawdownReduction,
          reason: 'daily_drawdown_halving',
        };
        reasons.push(`Daily drawdown: maxLev reduced by ${dailyDrawdownReduction}x`);
      }
      
      effectiveMaxLeverage = dynMaxLev;
      adjustments.dynamicMaxLev = {
        adx: adx.toFixed(2),
        atrPercent: atrPercent.toFixed(3),
        maxLeverage: dynMaxLev,
        reason: 'dynamic_max_throttle',
      };
      reasons.push(`Dynamic maxLev: ${dynMaxLev}x (ADX ${adx.toFixed(1)}, ATR ${atrPercent.toFixed(2)}%)`);
    }
    
    // 8. Kelly Criterion (optional, advanced)
    if (this.config.useKelly) {
      const kellyLeverage = this._calculateKellyLeverage();
      if (kellyLeverage > 0) {
        // Original blend
        leverage = leverage * 0.7 + kellyLeverage * 0.3;
        adjustments.kelly = {
          kellyLeverage: kellyLeverage.toFixed(2),
          reason: 'kelly_criterion',
        };
        reasons.push(`Kelly Criterion: ${kellyLeverage.toFixed(2)}x`);
      }
    }

    // Ensure leverage is within bounds
    leverage = Math.max(this.config.minLeverage, Math.min(leverage, effectiveMaxLeverage));
    
    // Round to 1 decimal place for cleaner numbers
    leverage = Math.round(leverage * 10) / 10;

    return {
      leverage,
      adjustments,
      reason: reasons.length > 0 ? reasons.join('; ') : 'base_leverage',
      baseLeverage: this.config.baseLeverage,
    };
  }

  /**
   * Calculate optimal leverage using Kelly Criterion
   * Kelly % = (Win Rate × Win/Loss Ratio - Loss Rate) / Win/Loss Ratio
   * Optimal Leverage ≈ Kelly % (with safety factor)
   */
  _calculateKellyLeverage() {
    const { winRate, avgWinLossRatio } = this.config;
    const lossRate = 1 - winRate;
    const kellyPercent = (winRate * avgWinLossRatio - lossRate) / avgWinLossRatio;
    
    // Apply safety factor (fractional Kelly = 0.25x for conservative)
    const fractionalKelly = kellyPercent * 0.25;
    
    // Convert to leverage (Kelly % of 20% = 1.2x leverage)
    const leverage = 1 + fractionalKelly;
    
    return Math.max(1, Math.min(leverage, this.config.maxLeverage));
  }

  /**
   * Update performance metrics for drawdown tracking
   */
  updatePerformance(balance, timestamp = Date.now()) {
    if (!this.config.trackPerformance) return;
    
    this.performanceHistory.push({ balance, timestamp });
    if (this.performanceHistory.length > this.maxHistorySize) {
      this.performanceHistory.shift();
    }
    
    if (this.peakBalance === null || balance > this.peakBalance) {
      this.peakBalance = balance;
    }
  }

  /**
   * Reset performance tracking
   */
  resetPerformance() {
    if (this.config.trackPerformance) {
      this.performanceHistory = [];
      this.peakBalance = null;
    }
  }

  /**
   * Get current drawdown percentage
   */
  getDrawdown(currentBalance) {
    if (!this.config.trackPerformance || this.peakBalance === null) {
      return 0;
    }
    
    return Math.max(0, (this.peakBalance - currentBalance) / this.peakBalance);
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Check for daily drawdown and return reduction factor
   * Returns: 2 if daily drawdown >= threshold, 1 otherwise
   */
  _checkDailyDrawdown() {
    if (!this.dailyPnLHistory || this.dailyPnLHistory.length === 0) {
      return 1;
    }
    
    // Get today's date
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    // Find today's entry
    const todayEntry = this.dailyPnLHistory.find(e => e.date === todayKey);
    if (!todayEntry) {
      return 1;
    }
    
    // Check if today's drawdown exceeds threshold
    if (todayEntry.pnl < 0 && Math.abs(todayEntry.pnl) >= this.config.dailyDrawdownThreshold) {
      return 2; // Halve maxLeverage
    }
    
    return 1; // No reduction
  }

  /**
   * Update daily P&L tracking
   * @param {number} pnl - Daily P&L (can be cumulative for the day)
   * @param {number} balance - Current balance
   * @param {Date|number} timestamp - Timestamp (optional, defaults to now)
   */
  updateDailyPnL(pnl, balance, timestamp = Date.now()) {
    const date = new Date(timestamp);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    
    // Find existing entry for this date
    const existingIdx = this.dailyPnLHistory.findIndex(e => e.date === dateKey);
    
    if (existingIdx >= 0) {
      // Update existing entry
      this.dailyPnLHistory[existingIdx].pnl = pnl;
      this.dailyPnLHistory[existingIdx].balance = balance;
    } else {
      // Add new entry
      this.dailyPnLHistory.push({ date: dateKey, pnl, balance });
      
      // Trim to max history size
      if (this.dailyPnLHistory.length > this.maxDailyHistory) {
        this.dailyPnLHistory.shift();
      }
    }
    
    // Update peak balance if using drawdown protection
    if (this.config.trackPerformance && (this.peakBalance === null || balance > this.peakBalance)) {
      this.peakBalance = balance;
    }
  }
}

module.exports = DynamicLeverageManager;

