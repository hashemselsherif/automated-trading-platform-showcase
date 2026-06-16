/**
 * Venue Adapter
 * 
 * Normalizes positions and orders from different venues (Jupiter, Drift)
 * into a consistent format for the bot's internal processing.
 * 
 * This ensures risk management, allocator, and strategy code can work
 * with positions from any venue without venue-specific conditionals.
 */

/**
 * Standard position fields expected by the bot
 */
const STANDARD_POSITION_FIELDS = {
  // Required fields
  positionId: null,       // Unique identifier
  market: null,           // Market symbol (e.g., 'SOL-PERP')
  side: null,             // 'long' or 'short'
  size: null,             // Position size in USD
  sizeBase: null,         // Position size in base asset
  collateral: null,       // Collateral/margin in USD
  leverage: null,         // Leverage multiplier
  entryPrice: null,       // Entry price
  markPrice: null,        // Current mark price
  liquidationPrice: null, // Liquidation price
  
  // PnL fields
  unrealizedPnl: null,    // Unrealized PnL in USD
  unrealizedPnlPct: null, // Unrealized PnL as percentage
  realizedPnl: null,      // Realized PnL in USD (if available)
  
  // Timing
  openTime: null,         // When position was opened (timestamp)
  lastUpdateTime: null,   // Last update timestamp
  
  // Risk fields
  marginRatio: null,      // Current margin ratio (0-1)
  health: null,           // Account health (Drift-specific, normalized 0-100)
  
  // Venue info
  venue: null,            // 'jupiter' or 'drift'
  venuePositionId: null,  // Original venue-specific ID
  subaccount: null,       // Subaccount (Drift-specific)
  
  // Order info
  execMode: null,         // 'taker' or 'maker'
  
  // Venue-specific raw data (for debugging)
  _raw: null,
};

/**
 * Normalize a Jupiter position to standard format
 * @param {Object} pos - Jupiter position
 * @param {number} currentPrice - Current market price
 * @returns {Object} Normalized position
 */
function normalizeJupiterPosition(pos, currentPrice = null) {
  const markPrice = currentPrice || pos.markPrice || pos.entryPrice;
  const size = pos.size || (pos.collateral * pos.leverage);
  const sizeBase = size / markPrice;
  
  // Calculate unrealized PnL
  let unrealizedPnl = 0;
  let unrealizedPnlPct = 0;
  if (pos.entryPrice && markPrice) {
    const priceChange = (markPrice - pos.entryPrice) / pos.entryPrice;
    const direction = pos.side?.toLowerCase() === 'long' ? 1 : -1;
    unrealizedPnlPct = priceChange * direction * (pos.leverage || 1) * 100;
    unrealizedPnl = pos.collateral * (unrealizedPnlPct / 100);
  }
  
  return {
    ...STANDARD_POSITION_FIELDS,
    
    // Core fields
    positionId: pos.positionId || pos.clientOrderId,
    market: pos.market || pos.symbol,
    side: pos.side?.toLowerCase(),
    size,
    sizeBase,
    collateral: pos.collateral,
    leverage: pos.leverage || 1,
    entryPrice: pos.entryPrice,
    markPrice,
    liquidationPrice: pos.liquidationPrice,
    
    // PnL
    unrealizedPnl,
    unrealizedPnlPct,
    realizedPnl: pos.realizedPnl || 0,
    
    // Timing
    openTime: pos.openTime || Date.now(),
    lastUpdateTime: Date.now(),
    
    // Risk (Jupiter doesn't expose these directly)
    marginRatio: null,
    health: null,
    
    // Venue
    venue: 'jupiter',
    venuePositionId: pos.positionId,
    subaccount: null,
    execMode: 'taker', // Jupiter only supports taker
    
    _raw: pos,
  };
}

/**
 * Normalize a Drift position to standard format
 * @param {Object} pos - Drift position
 * @param {number} currentPrice - Current market price (optional)
 * @returns {Object} Normalized position
 */
function normalizeDriftPosition(pos, currentPrice = null) {
  const markPrice = currentPrice || pos.markPrice || pos.entryPrice;
  const size = pos.size || (pos.collateral * (pos.leverage || 1));
  const sizeBase = pos.baseSize || pos.sizeBase || (size / markPrice);
  
  // Calculate unrealized PnL
  let unrealizedPnl = pos.unrealizedPnl || 0;
  let unrealizedPnlPct = 0;
  if (pos.entryPrice && markPrice && pos.collateral) {
    const priceChange = (markPrice - pos.entryPrice) / pos.entryPrice;
    const direction = pos.side?.toLowerCase() === 'long' ? 1 : -1;
    unrealizedPnlPct = priceChange * direction * (pos.leverage || 1) * 100;
    if (!unrealizedPnl) {
      unrealizedPnl = pos.collateral * (unrealizedPnlPct / 100);
    }
  }
  
  // Drift-specific health calculation
  // Health ranges from 0 (liquidation) to 100 (fully healthy)
  let health = null;
  if (pos.health !== undefined) {
    health = pos.health;
  } else if (pos.marginRatio !== undefined) {
    // Convert margin ratio to health score (0.05 margin ratio = 5% = 50 health)
    health = Math.min(100, pos.marginRatio * 1000);
  }
  
  return {
    ...STANDARD_POSITION_FIELDS,
    
    // Core fields
    positionId: pos.positionId || pos.clientOrderId,
    market: pos.market,
    side: pos.side?.toLowerCase(),
    size,
    sizeBase,
    collateral: pos.collateral,
    leverage: pos.leverage || 1,
    entryPrice: pos.entryPrice,
    markPrice,
    liquidationPrice: pos.liquidationPrice,
    
    // PnL
    unrealizedPnl,
    unrealizedPnlPct,
    realizedPnl: pos.realizedPnl || 0,
    
    // Timing
    openTime: pos.openTime || Date.now(),
    lastUpdateTime: Date.now(),
    
    // Risk (Drift-specific)
    marginRatio: pos.marginRatio,
    health,
    marginRequirement: pos.marginRequirement,
    unsettledPnl: pos.unsettledPnl,
    
    // Venue
    venue: 'drift',
    venuePositionId: pos.driftOrderId || pos.positionId,
    subaccount: pos.subaccount || 0,
    marketIndex: pos.marketIndex,
    execMode: pos.execMode || 'taker',
    
    _raw: pos,
  };
}

/**
 * Normalize a position from any venue
 * @param {Object} pos - Position from any venue
 * @param {string} venue - Venue identifier ('jupiter' or 'drift')
 * @param {number} currentPrice - Current market price (optional)
 * @returns {Object} Normalized position
 */
function normalizePosition(pos, venue, currentPrice = null) {
  if (venue === 'drift' || pos.venue === 'drift' || pos.driftOrderId) {
    return normalizeDriftPosition(pos, currentPrice);
  } else {
    return normalizeJupiterPosition(pos, currentPrice);
  }
}

/**
 * Normalize multiple positions
 * @param {Object[]} positions - Array of positions
 * @param {string} venue - Venue identifier
 * @param {Object} prices - Map of symbol -> price
 * @returns {Object[]} Normalized positions
 */
function normalizePositions(positions, venue, prices = {}) {
  return positions.map(pos => {
    const symbol = pos.market?.replace('-PERP', '') || pos.symbol;
    const price = prices[symbol] || prices[pos.market];
    return normalizePosition(pos, venue, price);
  });
}

/**
 * Get total exposure across all positions
 * @param {Object[]} positions - Array of normalized positions
 * @returns {Object} Exposure summary
 */
function getExposureSummary(positions) {
  let totalLongExposure = 0;
  let totalShortExposure = 0;
  let totalCollateral = 0;
  let totalUnrealizedPnl = 0;
  const byMarket = {};
  const byVenue = { jupiter: 0, drift: 0 };
  
  for (const pos of positions) {
    const exposure = Math.abs(pos.size || 0);
    
    if (pos.side === 'long') {
      totalLongExposure += exposure;
    } else {
      totalShortExposure += exposure;
    }
    
    totalCollateral += pos.collateral || 0;
    totalUnrealizedPnl += pos.unrealizedPnl || 0;
    
    if (pos.market) {
      byMarket[pos.market] = (byMarket[pos.market] || 0) + exposure;
    }
    
    if (pos.venue) {
      byVenue[pos.venue] = (byVenue[pos.venue] || 0) + exposure;
    }
  }
  
  return {
    totalExposure: totalLongExposure + totalShortExposure,
    netExposure: totalLongExposure - totalShortExposure,
    totalLongExposure,
    totalShortExposure,
    totalCollateral,
    totalUnrealizedPnl,
    positionCount: positions.length,
    byMarket,
    byVenue,
  };
}

/**
 * Validate position has required fields
 * @param {Object} pos - Position to validate
 * @returns {{valid: boolean, missing: string[]}}
 */
function validatePosition(pos) {
  const required = ['positionId', 'market', 'side', 'size', 'collateral', 'entryPrice'];
  const missing = required.filter(field => pos[field] === null || pos[field] === undefined);
  
  return {
    valid: missing.length === 0,
    missing,
  };
}

module.exports = {
  STANDARD_POSITION_FIELDS,
  normalizeJupiterPosition,
  normalizeDriftPosition,
  normalizePosition,
  normalizePositions,
  getExposureSummary,
  validatePosition,
};

