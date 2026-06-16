// Portfolio-level risk management
class PortfolioRiskManager {
  constructor(config) {
    this.config = config.risk || {};
    this.maxTotalLeverage = config.maxTotalLeverage || 10; // Total leverage across all positions
    this.maxTotalExposure = config.maxTotalExposure || 5000; // Max total USD exposure
  }

  /**
   * Calculate total portfolio exposure
   */
  calculateTotalExposure(positions) {
    return positions.reduce((total, pos) => {
      return total + (pos.size || pos.collateral * (pos.leverage || 1));
    }, 0);
  }

  /**
   * Calculate total portfolio leverage
   * @param {Array} positions - Current open positions
   * @param {number} availableCapital - Free capital (balance after collateral deducted)
   * @returns {number} Total leverage ratio (totalExposure / totalEquity)
   * 
   * CRITICAL: Leverage must be calculated using TOTAL EQUITY (free + locked capital),
   * not just available capital. This is because:
   * - Total exposure = sum of all position sizes (collateral * leverage)
   * - Total equity = free capital + locked capital (collateral)
   * - Leverage = total exposure / total equity
   * 
   * Using only available capital would incorrectly inflate leverage when positions are open.
   */
  calculateTotalLeverage(positions, availableCapital) {
    // Calculate total equity: free capital + locked capital (collateral)
    const lockedCapital = positions.reduce((sum, pos) => sum + (pos.collateral || 0), 0);
    const totalEquity = (availableCapital || 0) + lockedCapital;
    
    if (!totalEquity || totalEquity === 0) return 0;
    const totalExposure = this.calculateTotalExposure(positions);
    return totalExposure / totalEquity;
  }

  /**
   * Check if new position would exceed portfolio limits
   */
  canOpenPosition(currentPositions, newPosition, availableCapital) {
    const currentExposure = this.calculateTotalExposure(currentPositions);
    const newExposure = newPosition.size || newPosition.collateral * (newPosition.leverage || 1);
    const totalExposure = currentExposure + newExposure;
    const totalLeverage = this.calculateTotalLeverage(
      [...currentPositions, newPosition],
      availableCapital
    );

    const checks = {
      exposureLimit: totalExposure <= this.maxTotalExposure,
      leverageLimit: totalLeverage <= this.maxTotalLeverage,
      maxPositions: currentPositions.length < (this.config.maxPositions || 10),
    };

    const canOpen = Object.values(checks).every(v => v === true);

    return {
      canOpen,
      checks,
      currentExposure,
      newExposure,
      totalExposure,
      totalLeverage,
      availableCapacity: {
        exposure: Math.max(0, this.maxTotalExposure - currentExposure),
        leverage: Math.max(0, this.maxTotalLeverage - this.calculateTotalLeverage(currentPositions, availableCapital)),
      },
    };
  }

  /**
   * Adjust position size based on portfolio limits
   */
  adjustPositionSize(requestedSize, currentPositions, availableCapital) {
    const currentExposure = this.calculateTotalExposure(currentPositions);
    const availableExposure = this.maxTotalExposure - currentExposure;
    
    // Check leverage limit using total equity (free + locked capital)
    const lockedCapital = currentPositions.reduce((sum, pos) => sum + (pos.collateral || 0), 0);
    const totalEquity = (availableCapital || 0) + lockedCapital;
    const currentLeverage = this.calculateTotalLeverage(currentPositions, availableCapital);
    const availableLeverage = this.maxTotalLeverage - currentLeverage;
    // Use total equity for leverage-based sizing calculation
    const maxSizeByLeverage = totalEquity * availableLeverage;

    // Use the most restrictive limit
    const maxSize = Math.min(availableExposure, maxSizeByLeverage, requestedSize);

    return {
      requestedSize,
      adjustedSize: Math.max(0, maxSize),
      reason: maxSize < requestedSize ? 'portfolio_limit' : null,
      limits: {
        exposure: availableExposure,
        leverage: maxSizeByLeverage,
      },
    };
  }

  /**
   * Calculate portfolio risk metrics
   */
  getRiskMetrics(positions, availableCapital) {
    const totalExposure = this.calculateTotalExposure(positions);
    const totalLeverage = this.calculateTotalLeverage(positions, availableCapital);
    const avgLeverage = positions.length > 0
      ? positions.reduce((sum, p) => sum + (p.leverage || 1), 0) / positions.length
      : 0;

    return {
      totalExposure,
      totalLeverage,
      avgLeverage,
      positionCount: positions.length,
      utilization: {
        exposure: (totalExposure / this.maxTotalExposure) * 100,
        leverage: (totalLeverage / this.maxTotalLeverage) * 100,
      },
    };
  }

  /**
   * Check for correlated positions (basic implementation)
   */
  hasCorrelatedPositions(positions) {
    // Group by base asset
    const byAsset = {};
    positions.forEach(pos => {
      const asset = pos.market?.split('-')[0] || 'unknown';
      if (!byAsset[asset]) {
        byAsset[asset] = [];
      }
      byAsset[asset].push(pos);
    });

    // Check for same asset, opposite sides (hedged)
    const correlated = [];
    for (const [asset, assetPositions] of Object.entries(byAsset)) {
      if (assetPositions.length > 1) {
        const hasLong = assetPositions.some(p => p.side === 'long');
        const hasShort = assetPositions.some(p => p.side === 'short');
        if (hasLong && hasShort) {
          correlated.push({
            asset,
            type: 'hedged',
            positions: assetPositions,
          });
        }
      }
    }

    return correlated.length > 0 ? correlated : null;
  }
}

module.exports = PortfolioRiskManager;

