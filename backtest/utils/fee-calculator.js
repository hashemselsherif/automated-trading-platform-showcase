/**
 * Fee calculation utilities for backtesting
 * 
 * Supports multiple fee models:
 * - jupiter: Flat 6bps open/close fees
 * - drift: Tiered taker/maker fees with maker rebates
 */

const SIMULATION_CONSTANTS = require('../../backtest/backtest-constants');

/**
 * Fee model definitions
 */
const FEE_MODELS = {
  jupiter: {
    name: 'Jupiter',
    openFeeBps: 6,      // 6 bps per side - total ~14 bps with swap/impact fees
    closeFeeBps: 6,    // 6 bps per side - total ~14 bps with swap/impact fees
    makerRebateBps: 0,
    hasTiers: false,
  },
  drift: {
    name: 'Drift',
    // Drift perp market fees are tiered by 30D volume, and can be improved by DRIFT staking.
    // Source: https://docs.drift.trade/trading/trading-fees
    //
    // We store the *base* (Rookie staking) fee rates per 30D volume tier in BPS.
    // Then apply staking discounts/rebates as multipliers (see stakingBenefits below).
    tiers: {
      // Legacy tier naming for compatibility:
      // rookie→Tier1 (≤$2M), bronze→Tier2 (>$2M), silver→Tier3 (>$10M),
      // gold→Tier4 (>$20M), platinum→Tier5 (>$80M), vip→VIP (>$200M)
      rookie:   { minVolume: 0,         takerFeeBps: 3.5,  makerRebateBps: 0.25 },
      bronze:   { minVolume: 2_000_000, takerFeeBps: 3.0,  makerRebateBps: 0.25 },
      silver:   { minVolume: 10_000_000,takerFeeBps: 2.75, makerRebateBps: 0.25 },
      gold:     { minVolume: 20_000_000,takerFeeBps: 2.5,  makerRebateBps: 0.25 },
      platinum: { minVolume: 80_000_000,takerFeeBps: 2.25, makerRebateBps: 0.25 },
      vip:      { minVolume: 200_000_000,takerFeeBps: 2.0, makerRebateBps: 0.25 },
    },
    // Staking benefits are applied on top of the selected 30D volume tier.
    // Maker fee "rebate boost" increases rebate magnitude (e.g. -0.25bps -> -0.30bps at +20%).
    // Taker fee discount reduces taker fees multiplicatively.
    stakingBenefits: {
      rookie:      { takerDiscountPct: 0.00, makerRebateBoostPct: 0.00 },
      kickstarter: { takerDiscountPct: 0.05, makerRebateBoostPct: 0.05 },
      racer:       { takerDiscountPct: 0.10, makerRebateBoostPct: 0.10 },
      elite:       { takerDiscountPct: 0.20, makerRebateBoostPct: 0.20 },
      master:      { takerDiscountPct: 0.30, makerRebateBoostPct: 0.30 },
      champion:    { takerDiscountPct: 0.40, makerRebateBoostPct: 0.40 },
    },
    hasTiers: true,
    defaultTier: 'rookie',
  },
};

/**
 * Drift per-market "other fees" (liquidation + insurance + borrow rate share)
 * Source: https://docs.drift.trade/trading/other-trading-fees
 * 
 * liquidator_fee: Additional premium for taking over asset/liability pairs at oracle (% of position)
 * insurance_fee: Fee reserved for revenue pool → insurance fund (% of position)
 * 
 * These fees apply ONLY during liquidation events, not normal trading.
 * We include them for:
 * 1. Accurate liquidation simulation (if implemented)
 * 2. Understanding per-market risk profiles (higher fees = riskier/more volatile markets)
 */
const DRIFT_MARKET_FEES = {
  // Major markets (tighter fees)
  'SOL-PERP':       { liquidatorFee: 0.0075, insuranceFee: 0.0075 },
  'BTC-PERP':       { liquidatorFee: 0.005,  insuranceFee: 0.0075 },
  'ETH-PERP':       { liquidatorFee: 0.005,  insuranceFee: 0.0075 },
  // Mid-tier markets
  'APT-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.025 },
  '1MBONK-PERP':    { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'POL-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'ARB-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.025 },
  'DOGE-PERP':      { liquidatorFee: 0.01,   insuranceFee: 0.025 },
  'BNB-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'SUI-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  '1MPEPE-PERP':    { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'OP-PERP':        { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'RENDER-PERP':    { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'XRP-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'HNT-PERP':       { liquidatorFee: 0.025,  insuranceFee: 0.025 },
  'INJ-PERP':       { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  'LINK-PERP':      { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  'RLB-PERP':       { liquidatorFee: 0.025,  insuranceFee: 0.025 },
  'PYTH-PERP':      { liquidatorFee: 0.025,  insuranceFee: 0.025 },
  'TIA-PERP':       { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  'JTO-PERP':       { liquidatorFee: 0.025,  insuranceFee: 0.025 },
  'SEI-PERP':       { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  'AVAX-PERP':      { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'WIF-PERP':       { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'JUP-PERP':       { liquidatorFee: 0.02,   insuranceFee: 0.025 },
  'DYM-PERP':       { liquidatorFee: 0.025,  insuranceFee: 0.045 },
  'TAO-PERP':       { liquidatorFee: 0.025,  insuranceFee: 0.045 },
  'W-PERP':         { liquidatorFee: 0.03,   insuranceFee: 0.045 },
  'KMNO-PERP':      { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'TNSR-PERP':      { liquidatorFee: 0.01,   insuranceFee: 0.05 },
  'DRIFT-PERP':     { liquidatorFee: 0.01,   insuranceFee: 0.05 },
  'CLOUD-PERP':     { liquidatorFee: 0.045,  insuranceFee: 0.045 },
  'IO-PERP':        { liquidatorFee: 0.045,  insuranceFee: 0.045 },
  'ZEX-PERP':       { liquidatorFee: 0.045,  insuranceFee: 0.045 },
  'POPCAT-PERP':    { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  '1KWEN-PERP':     { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'TON-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.05 },
  'MOTHER-PERP':    { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'MOODENG-PERP':   { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'DBR-PERP':       { liquidatorFee: 0.045,  insuranceFee: 0.045 },
  '1KMEW-PERP':     { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'MICHI-PERP':     { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'GOAT-PERP':      { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'FWOG-PERP':      { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'PNUT-PERP':      { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'RAY-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.05 },
  'HYPE-PERP':      { liquidatorFee: 0.01,   insuranceFee: 0.05 },
  'LTC-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'ME-PERP':        { liquidatorFee: 0.01,   insuranceFee: 0.02 },
  'PENGU-PERP':     { liquidatorFee: 0.02,   insuranceFee: 0.05 },
  'AI16Z-PERP':     { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'TRUMP-PERP':     { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'MELANIA-PERP':   { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'BERA-PERP':      { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'KAITO-PERP':     { liquidatorFee: 0.01,   insuranceFee: 0.015 },
  'IP-PERP':        { liquidatorFee: 0.025,  insuranceFee: 0.05 },
  'FARTCOIN-PERP':  { liquidatorFee: 0.01,   insuranceFee: 0.015 },
  'ADA-PERP':       { liquidatorFee: 0.01,   insuranceFee: 0.015 },
  'PAXG-PERP':      { liquidatorFee: 0.01,   insuranceFee: 0.015 },
  'LAUNCHCOIN-PERP':{ liquidatorFee: 0.01,   insuranceFee: 0.015 },
  'PUMP-PERP':      { liquidatorFee: 0.04,   insuranceFee: 0.04 },
  'ASTER-PERP':     { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  'XPL-PERP':       { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  '2Z-PERP':        { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  'ZEC-PERP':       { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  'MNT-PERP':       { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  '1KPUMP-PERP':    { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  'MET-PERP':       { liquidatorFee: 0.02,   insuranceFee: 0.02 },
  '1KMON-PERP':     { liquidatorFee: 0.02,   insuranceFee: 0.02 },
};

// Default fees for markets not in the list (conservative assumption)
const DEFAULT_DRIFT_MARKET_FEES = { liquidatorFee: 0.025, insuranceFee: 0.05 };

/**
 * Get per-market liquidation/insurance fees for Drift
 * @param {string} market - Market symbol (e.g., 'SOL-PERP')
 * @returns {Object} { liquidatorFee, insuranceFee } as decimals (0.01 = 1%)
 */
function getDriftMarketFees(market) {
  const normalized = market?.toUpperCase?.() || '';
  return DRIFT_MARKET_FEES[normalized] || DEFAULT_DRIFT_MARKET_FEES;
}

/**
 * Normalize API inputs: supports both the legacy positional signature and an options object.
 */
function normalizeFeeArgs(modelOrOptions, execMode, tier) {
  if (modelOrOptions && typeof modelOrOptions === 'object') {
    const opt = modelOrOptions;
    return {
      model: opt.model ?? 'jupiter',
      execMode: opt.execMode ?? 'taker',
      tier: opt.tier ?? 'rookie',
      stakingTier: opt.stakingTier ?? opt.driftStakingTier ?? SIMULATION_CONSTANTS.DEFAULT_DRIFT_STAKING_TIER ?? 'rookie',
      highLeverageMode: opt.highLeverageMode === true,
      // Optional per-market fee adjustments (additive bps and/or multiplicative scalar)
      takerFeeAdjustmentBps: Number.isFinite(opt.takerFeeAdjustmentBps) ? opt.takerFeeAdjustmentBps : 0,
      takerFeeMultiplier: Number.isFinite(opt.takerFeeMultiplier) && opt.takerFeeMultiplier > 0 ? opt.takerFeeMultiplier : 1,
      // Optional empirical overrides (final effective bps)
      overrideTakerFeeBps: Number.isFinite(opt.overrideTakerFeeBps) ? opt.overrideTakerFeeBps : undefined,
      overrideMakerRebateBps: Number.isFinite(opt.overrideMakerRebateBps) ? opt.overrideMakerRebateBps : undefined,
    };
  }

  return {
    model: modelOrOptions ?? 'jupiter',
    execMode: execMode ?? 'taker',
    tier: tier ?? 'rookie',
    stakingTier: SIMULATION_CONSTANTS.DEFAULT_DRIFT_STAKING_TIER ?? 'rookie',
    highLeverageMode: false,
    takerFeeAdjustmentBps: 0,
    takerFeeMultiplier: 1,
  };
}

/**
 * Get fee parameters for a given model and execution mode
 * @param {Object|string} modelOrOptions - Fee options object or model ('jupiter' or 'drift')
 * @param {string} execMode - Execution mode ('taker' or 'maker') (legacy positional)
 * @param {string} tier - Drift 30D volume tier (legacy positional)
 * @returns {Object} Fee parameters { openFeeBps, closeFeeBps, isRebate, model, execMode, tier, stakingTier }
 */
function getFeeParams(modelOrOptions = 'jupiter', execMode = 'taker', tier = 'rookie') {
  const args = normalizeFeeArgs(modelOrOptions, execMode, tier);
  const feeModel = FEE_MODELS[args.model] || FEE_MODELS.jupiter;
  
  if (args.model === 'jupiter') {
    return {
      openFeeBps: feeModel.openFeeBps,
      closeFeeBps: feeModel.closeFeeBps,
      isRebate: false,
      model: 'jupiter',
      execMode: 'taker', // Jupiter is always taker
    };
  }
  
  if (args.model === 'drift') {
    const tierConfig = feeModel.tiers[args.tier] || feeModel.tiers.rookie;
    const staking = feeModel.stakingBenefits?.[args.stakingTier] || feeModel.stakingBenefits.rookie;

    // Base fees are in bps; apply staking adjustments.
    // Taker: discount reduces fee.
    let takerFeeBps = tierConfig.takerFeeBps * (1 - staking.takerDiscountPct);
    // Optional per-market taker fee adjustments (fee-adjusted markets).
    takerFeeBps = (takerFeeBps + args.takerFeeAdjustmentBps) * args.takerFeeMultiplier;

    // High leverage mode: taker fees are 2x the bottom fee tier (Drift docs).
    // We approximate "bottom tier" as the best (VIP) base fee, then apply staking + adjustments.
    if (args.highLeverageMode) {
      const bottom = feeModel.tiers.vip || tierConfig;
      const bottomTaker = (bottom.takerFeeBps * (1 - staking.takerDiscountPct) + args.takerFeeAdjustmentBps) * args.takerFeeMultiplier;
      takerFeeBps = 2 * bottomTaker;
    }

    // Maker: rebate magnitude increases with boost.
    let makerRebateBps = tierConfig.makerRebateBps * (1 + staking.makerRebateBoostPct);

    // Empirical overrides (e.g. from Drift historical trade records):
    // If provided, treat as final effective bps AFTER all discounts/boosts.
    if (Number.isFinite(args.overrideTakerFeeBps)) {
      takerFeeBps = args.overrideTakerFeeBps;
    }
    if (Number.isFinite(args.overrideMakerRebateBps)) {
      makerRebateBps = args.overrideMakerRebateBps;
    }
    
    if (args.execMode === 'maker') {
      return {
        openFeeBps: -makerRebateBps, // Negative = rebate
        closeFeeBps: -makerRebateBps,
        isRebate: true,
        model: 'drift',
        execMode: 'maker',
        tier: args.tier,
        stakingTier: args.stakingTier,
        takerFeeBps,
        makerRebateBps,
      };
    }
    
    return {
      openFeeBps: takerFeeBps,
      closeFeeBps: takerFeeBps,
      isRebate: false,
      model: 'drift',
      execMode: 'taker',
      tier: args.tier,
      stakingTier: args.stakingTier,
      takerFeeBps,
      makerRebateBps,
    };
  }
  
  // Default to Jupiter
  return getFeeParams('jupiter', 'taker');
}

/**
 * Calculate trading fees with model support
 * @param {number} sizeUsd - Position size in USD
 * @param {string|Object} feeTypeOrOptions - 'open' | 'close' OR options object (legacy convenience)
 * @param {Object} options - Fee options
 * @returns {Object} { fee, isRebate, breakdown }
 */
function calculateTradingFee(sizeUsd, feeTypeOrOptions = 'open', options = {}) {
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return { fee: 0, isRebate: false, breakdown: { baseFee: 0 } };
  }
  
  const feeType = (typeof feeTypeOrOptions === 'object' && feeTypeOrOptions) ? 'open' : feeTypeOrOptions;
  const opt = (typeof feeTypeOrOptions === 'object' && feeTypeOrOptions) ? feeTypeOrOptions : options;

  const {
    model = 'jupiter',
    execMode = 'taker',
    tier = 'rookie',
    stakingTier,
    highLeverageMode = false,
    takerFeeAdjustmentBps = 0,
    takerFeeMultiplier = 1,
    overrideTakerFeeBps,
    overrideMakerRebateBps,
    enablePriceImpactFee = true,
    priceImpactFeeScalar,
  } = opt;
  
  const params = getFeeParams({
    model,
    execMode,
    tier,
    stakingTier,
    highLeverageMode,
    takerFeeAdjustmentBps,
    takerFeeMultiplier,
    overrideTakerFeeBps,
    overrideMakerRebateBps,
  });
  const feeBps = feeType === 'open' ? params.openFeeBps : params.closeFeeBps;
  
  // Base fee (negative for rebates)
  const baseFee = sizeUsd * (feeBps / 10_000);
  
  // Price impact fee (only for taker orders, not for maker)
  let priceImpactFee = 0;
  if (enablePriceImpactFee && !params.isRebate) {
    const scalar = priceImpactFeeScalar ?? SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR;
    priceImpactFee = calculatePriceImpactFee(sizeUsd, scalar);
  }
  
  const totalFee = baseFee + priceImpactFee;
  
  return {
    fee: totalFee,
    isRebate: params.isRebate,
    breakdown: {
      baseFee,
      baseFeesBps: feeBps,
      priceImpactFee,
      total: totalFee,
      model: params.model,
      execMode: params.execMode,
      tier: params.tier,
      stakingTier: params.stakingTier,
    },
  };
}

/**
 * Calculate round-trip trading fees (open + close)
 * @param {number} sizeUsd - Position size in USD
 * @param {Object} options - Fee options
 * @returns {Object} { totalFee, openFee, closeFee, netRebate, breakdown }
 */
function calculateRoundTripFees(sizeUsd, options = {}) {
  const openResult = calculateTradingFee(sizeUsd, 'open', options);
  const closeResult = calculateTradingFee(sizeUsd, 'close', options);
  
  const totalFee = openResult.fee + closeResult.fee;
  const netRebate = openResult.isRebate ? -totalFee : 0;
  
  return {
    totalFee,
    openFee: openResult.fee,
    closeFee: closeResult.fee,
    netRebate,
    isRebate: openResult.isRebate,
    breakdown: {
      open: openResult.breakdown,
      close: closeResult.breakdown,
      roundTripBps: ((openResult.breakdown.baseFeesBps || 0) + (closeResult.breakdown.baseFeesBps || 0)),
    },
  };
}

/**
 * Calculate funding rate impact
 * @param {number} sizeUsd - Position size in USD
 * @param {number} holdingHours - Hours position is held
 * @param {string} side - 'long' or 'short'
 * @param {Object} options - Funding options
 * @returns {Object} { fundingPaid, fundingReceived, netFunding }
 */
function calculateFundingFees(sizeUsd, holdingHours, side = 'long', options = {}) {
  const {
    model = 'jupiter',
    fundingRatePer8h = 0.01, // Default 0.01% per 8 hours
    marketSentiment = 0, // -1 = bearish, 0 = neutral, 1 = bullish
  } = options;
  
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || !Number.isFinite(holdingHours) || holdingHours <= 0) {
    return { fundingPaid: 0, fundingReceived: 0, netFunding: 0 };
  }
  
  // Calculate number of 8-hour funding periods
  const fundingPeriods = holdingHours / 8;
  
  // Adjust funding rate based on market sentiment
  // Positive sentiment = longs pay shorts, negative = shorts pay longs
  let effectiveRate = fundingRatePer8h;
  if (marketSentiment !== 0) {
    effectiveRate *= (1 + marketSentiment * 0.5); // ±50% adjustment based on sentiment
  }
  
  // Calculate funding
  const fundingAmount = sizeUsd * (effectiveRate / 100) * fundingPeriods;
  
  // Determine who pays (simplified model)
  // In bullish markets (positive funding), longs pay shorts
  // In bearish markets (negative funding), shorts pay longs
  const isLong = side === 'long';
  const isPaying = (marketSentiment >= 0 && isLong) || (marketSentiment < 0 && !isLong);
  
  return {
    fundingPaid: isPaying ? fundingAmount : 0,
    fundingReceived: isPaying ? 0 : fundingAmount * 0.9, // 90% passthrough (simplified)
    netFunding: isPaying ? -fundingAmount : fundingAmount * 0.9,
    details: {
      holdingHours,
      fundingPeriods,
      fundingRatePer8h,
      effectiveRate,
      side,
      marketSentiment,
    },
  };
}

/**
 * Calculate price impact fee
 * @param {number} sizeUsd - Position size in USD
 * @param {number} priceImpactFeeScalar - Price impact fee scalar constant
 * @returns {number} Price impact fee in USD
 */
function calculatePriceImpactFee(sizeUsd, priceImpactFeeScalar = SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR) {
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return 0;
  if (!Number.isFinite(priceImpactFeeScalar) || priceImpactFeeScalar <= 0) return 0;
  // Linear price impact fee coefficient = trade size / price impact fee scalar constant
  const coefficient = sizeUsd / priceImpactFeeScalar;
  // Final linear price impact fee = trade size × linear price impact fee coefficient
  return sizeUsd * coefficient;
}

/**
 * Calculate open fee (including price impact)
 * @param {number} sizeUsd - Position size in USD
 * @param {number} openFeeBps - Open fee in basis points
 * @param {Object} feeCfg - Fee configuration
 * @returns {number} Total open fee in USD
 */
function calculateOpenFee(sizeUsd, openFeeBps = 6, feeCfg = {}) {
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return 0;
  // Base fee: 0.06% (6 basis points) of notional position size
  const baseFee = sizeUsd * (openFeeBps / 10_000);
  
  let priceImpactFee = 0;
  if (feeCfg.enablePriceImpactFee !== false) {
    const priceImpactFeeScalar = feeCfg.priceImpactFeeScalar ?? SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR;
    priceImpactFee = calculatePriceImpactFee(sizeUsd, priceImpactFeeScalar);
  }
  
  return baseFee + priceImpactFee;
}

/**
 * Calculate close fee (including price impact)
 * @param {number} sizeUsd - Position size in USD
 * @param {number} closeFeeBps - Close fee in basis points
 * @param {Object} feeCfg - Fee configuration
 * @returns {number} Total close fee in USD
 */
function calculateCloseFee(sizeUsd, closeFeeBps = 6, feeCfg = {}) {
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return 0;
  // Base fee: 0.06% (6 basis points) of notional position size
  const baseFee = sizeUsd * (closeFeeBps / 10_000);
  
  let priceImpactFee = 0;
  if (feeCfg.enablePriceImpactFee !== false) {
    const priceImpactFeeScalar = feeCfg.priceImpactFeeScalar ?? SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR;
    priceImpactFee = calculatePriceImpactFee(sizeUsd, priceImpactFeeScalar);
  }
  
  return baseFee + priceImpactFee;
}

/**
 * Calculate Solana transaction fees
 * @param {number} solPriceUsd - SOL price in USD
 * @param {Object} feeCfg - Fee configuration
 * @returns {number} Transaction fee in USD
 */
function calculateSolanaTransactionFees(solPriceUsd, feeCfg = {}) {
  const txFeeCfg = feeCfg.solanaTxFee || {};
  if (txFeeCfg.enableTxFees === false) return 0;
  
  const baseFeeLamports = txFeeCfg.baseFeeLamports ?? 5000;
  const cuLimit = txFeeCfg.cuLimit ?? 200000;
  const priorityFeeMicroLamports = txFeeCfg.priorityFeeMicroLamports ?? 0;
  
  // Total lamports = base fee + (CU limit * priority fee per CU)
  const totalLamports = baseFeeLamports + (cuLimit * priorityFeeMicroLamports / 1_000_000);
  
  // Convert to USD (1 SOL = 1,000,000,000 lamports)
  const solAmount = totalLamports / 1_000_000_000;
  return solAmount * solPriceUsd;
}

/**
 * Accrue borrow fees if due
 * @param {Array} positions - Open positions
 * @param {number} ts - Timestamp
 * @param {Object} feeCfg - Fee configuration
 * @returns {number} Total borrow fees accrued
 */
function accrueBorrowFeesIfDue(positions, ts, feeCfg = {}) {
  const borrowFeeBpsPerHour = feeCfg.borrowFeeBpsPerHour ?? 1.2; // 0.012% per hour
  const borrowUtilizationRate = feeCfg.borrowUtilizationRate ?? 0.198; // 19.8% utilization
  const hourlyCadenceMs = feeCfg.hourlyCadenceMs ?? 3_600_000; // 1 hour
  
  let totalFees = 0;
  
  for (const pos of positions) {
    // Position uses openTime, not openTs (check both for compatibility)
    const openTime = pos.openTs || pos.openTime;
    if (!openTime || !Number.isFinite(openTime)) continue;
    
    if (!pos.lastBorrowFeeTs) {
      pos.lastBorrowFeeTs = openTime;
    }
    
    // Ensure we have position size
    if (!pos.sizeUsd || !Number.isFinite(pos.sizeUsd) || pos.sizeUsd <= 0) continue;
    
    const elapsed = ts - pos.lastBorrowFeeTs;
    if (elapsed >= hourlyCadenceMs) {
      const hours = elapsed / hourlyCadenceMs;
      const feeBps = borrowFeeBpsPerHour * hours * borrowUtilizationRate;
      const feeUsd = (pos.sizeUsd * feeBps) / 10000;
      pos.totalBorrowFees = (pos.totalBorrowFees || 0) + feeUsd;
      totalFees += feeUsd;
      pos.lastBorrowFeeTs = ts;
    }
  }
  
  // Return negative value (fees reduce P&L)
  return -totalFees;
}

module.exports = {
  // Legacy API (for backward compatibility)
  calculatePriceImpactFee,
  calculateOpenFee,
  calculateCloseFee,
  calculateSolanaTransactionFees,
  accrueBorrowFeesIfDue,
  
  // New fee model API
  FEE_MODELS,
  getFeeParams,
  calculateTradingFee,
  calculateRoundTripFees,
  calculateFundingFees,
  
  // Per-market Drift fees (liquidation/insurance)
  DRIFT_MARKET_FEES,
  DEFAULT_DRIFT_MARKET_FEES,
  getDriftMarketFees,
};
