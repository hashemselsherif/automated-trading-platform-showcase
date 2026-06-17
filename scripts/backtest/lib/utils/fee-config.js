/**
 * Fee Configuration for Backtesting
 * 
 * Reads fee model configuration from environment variables:
 * - FEE_MODEL: 'jupiter' (default) or 'drift'
 * - EXEC_MODE: 'taker' (default) or 'maker' (only affects Drift)
 * - DRIFT_TIER: 'rookie' (default), 'bronze', 'silver', 'gold', 'platinum', 'vip'
 * - DRIFT_STAKING_TIER: 'rookie' (default), 'kickstarter', 'racer', 'elite', 'master', 'champion'
 * - DRIFT_HIGH_LEVERAGE_MODE: 'true'/'false' (if true, taker fees are 2x bottom tier)
 * - DRIFT_TAKER_FEE_ADJUSTMENT_BPS: additive bps adjustment for taker fees (fee-adjusted markets)
 * - DRIFT_TAKER_FEE_MULTIPLIER: multiplicative scalar for taker fees (fee-adjusted markets)
 * 
 * Handles:
 * - Jupiter flat 6bps fees (legacy default)
 * - Drift tiered fees with maker rebates
 */

const SIMULATION_CONSTANTS = require('../backtest-constants');
const { getFeeParams, calculateTradingFee, calculateRoundTripFees } = require('./fee-calculator');

/**
 * Valid fee models
 */
const VALID_FEE_MODELS = ['jupiter', 'drift'];
const VALID_EXEC_MODES = ['taker', 'maker'];
const VALID_DRIFT_TIERS = ['rookie', 'bronze', 'silver', 'gold', 'platinum', 'vip'];
const VALID_DRIFT_STAKING_TIERS = ['rookie', 'kickstarter', 'racer', 'elite', 'master', 'champion'];

function parseBool(v, fallback = false) {
  const s = String(v ?? '').toLowerCase().trim();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/**
 * Get fee configuration from environment
 * @param {Object} env - Environment object (defaults to process.env)
 * @returns {Object} Fee configuration
 */
function getFeeConfigFromEnv(env = process.env) {
  const model = VALID_FEE_MODELS.includes(env.FEE_MODEL) 
    ? env.FEE_MODEL 
    : SIMULATION_CONSTANTS.DEFAULT_FEE_MODEL;
    
  const execMode = VALID_EXEC_MODES.includes(env.EXEC_MODE)
    ? env.EXEC_MODE
    : SIMULATION_CONSTANTS.DEFAULT_EXEC_MODE;
    
  const driftTier = VALID_DRIFT_TIERS.includes(env.DRIFT_TIER)
    ? env.DRIFT_TIER
    : SIMULATION_CONSTANTS.DEFAULT_DRIFT_TIER;

  const driftStakingTier = VALID_DRIFT_STAKING_TIERS.includes(String(env.DRIFT_STAKING_TIER || '').toLowerCase())
    ? String(env.DRIFT_STAKING_TIER).toLowerCase()
    : (SIMULATION_CONSTANTS.DEFAULT_DRIFT_STAKING_TIER || 'rookie');

  const driftHighLeverageMode = parseBool(env.DRIFT_HIGH_LEVERAGE_MODE, SIMULATION_CONSTANTS.DEFAULT_DRIFT_HIGH_LEVERAGE_MODE === true);

  const rawAdj = Number(env.DRIFT_TAKER_FEE_ADJUSTMENT_BPS);
  const driftTakerFeeAdjustmentBps = Number.isFinite(rawAdj) ? rawAdj : 0;

  const rawMult = Number(env.DRIFT_TAKER_FEE_MULTIPLIER);
  const driftTakerFeeMultiplier = Number.isFinite(rawMult) && rawMult > 0 ? rawMult : 1;

  // ============================================================
  // EMPIRICAL FEE VALUES (from Drift historical data analysis)
  // ============================================================
  // Read override bps values if provided (from 181 days of real data)
  const rawTakerBps = Number(env.DRIFT_TAKER_FEE_BPS);
  const empiricalTakerFeeBps = Number.isFinite(rawTakerBps) ? rawTakerBps : null;
  
  const rawMakerRebateBps = Number(env.DRIFT_MAKER_REBATE_BPS);
  const empiricalMakerRebateBps = Number.isFinite(rawMakerRebateBps) ? rawMakerRebateBps : null;

  // Maker fill rates for simulation
  const rawEntryFillRate = Number(env.MAKER_ENTRY_FILL_RATE);
  const makerEntryFillRate = Number.isFinite(rawEntryFillRate) ? rawEntryFillRate : 0.55;
  
  const rawExitFillRate = Number(env.MAKER_EXIT_FILL_RATE);
  const makerExitFillRate = Number.isFinite(rawExitFillRate) ? rawExitFillRate : 0.50;

  // Slippage settings
  const enableFixedSlippage = parseBool(env.ENABLE_FIXED_SLIPPAGE, false);
  const rawSlippageBps = Number(env.FIXED_SLIPPAGE_BPS);
  const fixedSlippageBps = Number.isFinite(rawSlippageBps) ? rawSlippageBps : 15;

  // Maker fill simulation toggle
  const enableMakerFillSim = parseBool(env.ENABLE_MAKER_FILL_SIM, false);

  // Get fee params from the fee calculator
  const feeParams = getFeeParams({
    model,
    execMode,
    tier: driftTier,
    stakingTier: driftStakingTier,
    highLeverageMode: driftHighLeverageMode,
    takerFeeAdjustmentBps: driftTakerFeeAdjustmentBps,
    takerFeeMultiplier: driftTakerFeeMultiplier,
    overrideTakerFeeBps: empiricalTakerFeeBps ?? undefined,
    overrideMakerRebateBps: empiricalMakerRebateBps ?? undefined,
  });

  // If empirical values are provided, override the calculated ones
  let effectiveOpenFeeBps = feeParams.openFeeBps;
  let effectiveCloseFeeBps = feeParams.closeFeeBps;
  let effectiveTakerFeeBps = null;
  
  if (model === 'drift') {
    // Use empirical values from historical data if provided
    if (empiricalTakerFeeBps !== null) {
      effectiveTakerFeeBps = empiricalTakerFeeBps;
    }
    if (empiricalMakerRebateBps !== null && execMode === 'maker') {
      // Maker rebate is negative (you receive money)
      effectiveOpenFeeBps = -empiricalMakerRebateBps;
      effectiveCloseFeeBps = -empiricalMakerRebateBps;
    }
  }

  return {
    // Model settings
    model,
    execMode,
    tier: driftTier,
    stakingTier: driftStakingTier,
    highLeverageMode: driftHighLeverageMode,
    takerFeeAdjustmentBps: driftTakerFeeAdjustmentBps,
    takerFeeMultiplier: driftTakerFeeMultiplier,
    
    // Empirical values from historical data
    empiricalTakerFeeBps,
    empiricalMakerRebateBps,
    makerEntryFillRate,
    makerExitFillRate,
    enableMakerFillSim,
    enableFixedSlippage,
    fixedSlippageBps,
    
    // Fee rates (derived from model, or overridden by empirical)
    openFeeBps: effectiveOpenFeeBps,
    closeFeeBps: effectiveCloseFeeBps,
    takerFeeBps: effectiveTakerFeeBps || feeParams.takerFeeBps || 9.0,
    isRebate: feeParams.isRebate || (execMode === 'maker' && model === 'drift'),
    
    // Venue-specific knobs:
    // - Drift: do NOT apply Jupiter price-impact model
    // - Jupiter: price impact on takers
    enablePriceImpactFee: (model !== 'drift') && !feeParams.isRebate,
    priceImpactFeeScalar: SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR,

    // Drift perps are USDC collateral; swaps are not inherently per-trade fees.
    // Leave enabled for Jupiter; disabled for Drift by default.
    enableSwapFee: (model !== 'drift'),

    // Borrow fees are Jupiter-specific in this codebase; Drift perps primarily have funding.
    enableBorrowFee: (model !== 'drift'),
    
    // Helper functions
    calculateOpenFee: (sizeUsd, overrides = {}) => calculateTradingFee(sizeUsd, 'open', {
      model,
      execMode,
      tier: driftTier,
      stakingTier: driftStakingTier,
      highLeverageMode: driftHighLeverageMode,
      takerFeeAdjustmentBps: driftTakerFeeAdjustmentBps,
      takerFeeMultiplier: driftTakerFeeMultiplier,
      overrideTakerFeeBps: empiricalTakerFeeBps ?? undefined,
      overrideMakerRebateBps: empiricalMakerRebateBps ?? undefined,
      enablePriceImpactFee: (model !== 'drift') && (String(overrides?.execMode || execMode).toLowerCase() !== 'maker'),
      priceImpactFeeScalar: SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR,
      ...overrides,
    }),
    calculateCloseFee: (sizeUsd, overrides = {}) => calculateTradingFee(sizeUsd, 'close', {
      model,
      execMode,
      tier: driftTier,
      stakingTier: driftStakingTier,
      highLeverageMode: driftHighLeverageMode,
      takerFeeAdjustmentBps: driftTakerFeeAdjustmentBps,
      takerFeeMultiplier: driftTakerFeeMultiplier,
      overrideTakerFeeBps: empiricalTakerFeeBps ?? undefined,
      overrideMakerRebateBps: empiricalMakerRebateBps ?? undefined,
      enablePriceImpactFee: (model !== 'drift') && (String(overrides?.execMode || execMode).toLowerCase() !== 'maker'),
      priceImpactFeeScalar: SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR,
      ...overrides,
    }),
    calculateRoundTrip: (sizeUsd, overrides = {}) => calculateRoundTripFees(sizeUsd, {
      model,
      execMode,
      tier: driftTier,
      stakingTier: driftStakingTier,
      highLeverageMode: driftHighLeverageMode,
      takerFeeAdjustmentBps: driftTakerFeeAdjustmentBps,
      takerFeeMultiplier: driftTakerFeeMultiplier,
      overrideTakerFeeBps: empiricalTakerFeeBps ?? undefined,
      overrideMakerRebateBps: empiricalMakerRebateBps ?? undefined,
      // Round-trip uses calculateTradingFee internally; disable price impact for Drift there as well by passing through.
      enablePriceImpactFee: (model !== 'drift') && (String(overrides?.execMode || execMode).toLowerCase() !== 'maker'),
      priceImpactFeeScalar: SIMULATION_CONSTANTS.DEFAULT_PRICE_IMPACT_FEE_SCALAR,
      ...overrides,
    }),
  };
}

/**
 * Build feeCfg object compatible with backtest scripts
 * @param {Object} env - Environment object
 * @returns {Object} feeCfg for backtest
 */
function buildFeeCfg(env = process.env) {
  const config = getFeeConfigFromEnv(env);
  
  return {
    // Fee rates for inline calculations
    openFeeBps: config.openFeeBps,
    closeFeeBps: config.closeFeeBps,
    takerFeeBps: config.takerFeeBps,
    
    // Price impact settings
    enablePriceImpactFee: config.enablePriceImpactFee,
    priceImpactFeeScalar: config.priceImpactFeeScalar,

    // Venue toggles
    enableSwapFee: config.enableSwapFee,
    enableBorrowFee: config.enableBorrowFee,
    
    // Model info for logging
    model: config.model,
    execMode: config.execMode,
    tier: config.tier,
    stakingTier: config.stakingTier,
    highLeverageMode: config.highLeverageMode,
    takerFeeAdjustmentBps: config.takerFeeAdjustmentBps,
    takerFeeMultiplier: config.takerFeeMultiplier,
    isRebate: config.isRebate,
    
    // Empirical values from historical data (181 days)
    empiricalTakerFeeBps: config.empiricalTakerFeeBps,
    empiricalMakerRebateBps: config.empiricalMakerRebateBps,
    makerEntryFillRate: config.makerEntryFillRate,
    makerExitFillRate: config.makerExitFillRate,
    enableMakerFillSim: config.enableMakerFillSim,
    enableFixedSlippage: config.enableFixedSlippage,
    fixedSlippageBps: config.fixedSlippageBps,
    
    // Helper methods
    calculateOpenFee: config.calculateOpenFee,
    calculateCloseFee: config.calculateCloseFee,
    calculateRoundTrip: config.calculateRoundTrip,
  };
}

/**
 * Log fee configuration for debugging
 * @param {Object} feeCfg - Fee configuration
 */
function logFeeConfig(feeCfg) {
  const modelDesc = feeCfg.model === 'drift' 
    ? `Drift (vol=${feeCfg.tier}, stake=${feeCfg.stakingTier || 'rookie'}, ${feeCfg.execMode}${feeCfg.highLeverageMode ? ', high-lev' : ''})`
    : 'Jupiter';
    
  const feeDesc = feeCfg.isRebate
    ? `rebate ${Math.abs(feeCfg.openFeeBps)}bps`
    : `fee ${feeCfg.openFeeBps}bps`;
    
  console.log(`[FEES] Model: ${modelDesc} | Open: ${feeDesc} | Close: ${feeDesc} | Price impact: ${feeCfg.enablePriceImpactFee ? 'ON' : 'OFF'}`);
  
  // Log empirical values if using Drift maker mode
  if (feeCfg.model === 'drift' && feeCfg.enableMakerFillSim) {
    console.log(`[FEES] Maker Fill Sim: Entry=${(feeCfg.makerEntryFillRate * 100).toFixed(0)}% | Exit=${(feeCfg.makerExitFillRate * 100).toFixed(0)}% | Taker fallback: ${feeCfg.takerFeeBps}bps`);
  }
  if (feeCfg.enableFixedSlippage) {
    console.log(`[FEES] Slippage: ${feeCfg.fixedSlippageBps}bps (fixed)`);
  }
}

/**
 * Parse fee model from CLI args or env
 * @param {Object} options - Options with model, execMode, tier
 * @returns {Object} Fee configuration
 */
function parseFeeOptions(options = {}) {
  const env = {
    FEE_MODEL: options.feeModel || options.model || process.env.FEE_MODEL,
    EXEC_MODE: options.execMode || process.env.EXEC_MODE,
    DRIFT_TIER: options.driftTier || options.tier || process.env.DRIFT_TIER,
    DRIFT_STAKING_TIER: options.driftStakingTier || options.stakingTier || process.env.DRIFT_STAKING_TIER,
    DRIFT_HIGH_LEVERAGE_MODE: options.driftHighLeverageMode || options.highLeverageMode || process.env.DRIFT_HIGH_LEVERAGE_MODE,
    DRIFT_TAKER_FEE_ADJUSTMENT_BPS: options.driftTakerFeeAdjustmentBps || options.takerFeeAdjustmentBps || process.env.DRIFT_TAKER_FEE_ADJUSTMENT_BPS,
    DRIFT_TAKER_FEE_MULTIPLIER: options.driftTakerFeeMultiplier || options.takerFeeMultiplier || process.env.DRIFT_TAKER_FEE_MULTIPLIER,
    // Empirical values
    DRIFT_TAKER_FEE_BPS: options.takerFeeBps || process.env.DRIFT_TAKER_FEE_BPS,
    DRIFT_MAKER_REBATE_BPS: options.makerRebateBps || process.env.DRIFT_MAKER_REBATE_BPS,
    MAKER_ENTRY_FILL_RATE: options.makerEntryFillRate || process.env.MAKER_ENTRY_FILL_RATE,
    MAKER_EXIT_FILL_RATE: options.makerExitFillRate || process.env.MAKER_EXIT_FILL_RATE,
    ENABLE_MAKER_FILL_SIM: options.enableMakerFillSim || process.env.ENABLE_MAKER_FILL_SIM,
    ENABLE_FIXED_SLIPPAGE: options.enableFixedSlippage || process.env.ENABLE_FIXED_SLIPPAGE,
    FIXED_SLIPPAGE_BPS: options.fixedSlippageBps || process.env.FIXED_SLIPPAGE_BPS,
  };
  
  return getFeeConfigFromEnv(env);
}

/**
 * Build limit order policy from environment variables
 * @param {Object} env - Environment object
 * @returns {Object} Policy configuration for LimitOrderPolicySimulator
 */
function buildLimitOrderPolicy(env = process.env) {
  const parseNum = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    // Price selection
    refPriceSource: env.DRIFT_LIMIT_REF_PRICE || SIMULATION_CONSTANTS.DEFAULT_LIMIT_REF_PRICE || 'oracle',
    entryOffsetBps: parseNum(env.DRIFT_LIMIT_ENTRY_BPS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_ENTRY_BPS),
    exitOffsetBps: parseNum(env.DRIFT_LIMIT_EXIT_BPS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_EXIT_BPS),
    postOnly: parseBool(env.DRIFT_LIMIT_POST_ONLY, SIMULATION_CONSTANTS.DEFAULT_LIMIT_POST_ONLY),
    
    // Lifecycle
    entryTimeoutMs: parseNum(env.DRIFT_LIMIT_ENTRY_TIMEOUT_MS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_ENTRY_TIMEOUT_MS),
    exitTimeoutMs: parseNum(env.DRIFT_LIMIT_EXIT_TIMEOUT_MS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_EXIT_TIMEOUT_MS),
    replaceEveryMs: parseNum(env.DRIFT_LIMIT_REPLACE_EVERY_MS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_REPLACE_EVERY_MS),
    maxReplaces: parseNum(env.DRIFT_LIMIT_MAX_REPLACES, SIMULATION_CONSTANTS.DEFAULT_LIMIT_MAX_REPLACES),
    cancelIfSignalInvalid: parseBool(env.DRIFT_LIMIT_CANCEL_IF_SIGNAL_INVALID, SIMULATION_CONSTANTS.DEFAULT_LIMIT_CANCEL_IF_SIGNAL_INVALID),
    
    // Fallback to taker (entry)
    fallbackToTaker: parseBool(env.DRIFT_LIMIT_FALLBACK_TO_TAKER, SIMULATION_CONSTANTS.DEFAULT_LIMIT_FALLBACK_TO_TAKER),
    fallbackAfterMs: parseNum(env.DRIFT_LIMIT_FALLBACK_AFTER_MS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_FALLBACK_AFTER_MS),
    fallbackMinConfidence: parseNum(env.DRIFT_LIMIT_FALLBACK_MIN_CONFIDENCE, SIMULATION_CONSTANTS.DEFAULT_LIMIT_FALLBACK_MIN_CONFIDENCE),
    fallbackMaxSlippageBps: parseNum(env.DRIFT_LIMIT_FALLBACK_MAX_SLIPPAGE_BPS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_FALLBACK_MAX_SLIPPAGE_BPS),
    
    // Exit-specific settings (more aggressive)
    exitAsMaker: parseBool(env.DRIFT_LIMIT_EXIT_AS_MAKER, SIMULATION_CONSTANTS.DEFAULT_LIMIT_EXIT_AS_MAKER),
    exitFallbackImmediate: parseBool(env.DRIFT_LIMIT_EXIT_FALLBACK_IMMEDIATE, SIMULATION_CONSTANTS.DEFAULT_LIMIT_EXIT_FALLBACK_IMMEDIATE),
    exitMaxSlippageBps: parseNum(env.DRIFT_LIMIT_EXIT_MAX_SLIPPAGE_BPS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_EXIT_MAX_SLIPPAGE_BPS),
    exitReplaceEveryMs: parseNum(env.DRIFT_LIMIT_EXIT_REPLACE_EVERY_MS, SIMULATION_CONSTANTS.DEFAULT_LIMIT_EXIT_REPLACE_EVERY_MS),
    exitMaxReplaces: parseNum(env.DRIFT_LIMIT_EXIT_MAX_REPLACES, SIMULATION_CONSTANTS.DEFAULT_LIMIT_EXIT_MAX_REPLACES),
  };
}

/**
 * Log limit order policy configuration for debugging
 * @param {Object} policy - Policy configuration
 */
function logLimitOrderPolicy(policy) {
  console.log(`[LIMIT-ORDERS] Entry: ${policy.entryOffsetBps}bps offset, ${policy.entryTimeoutMs}ms timeout, ${policy.maxReplaces} replaces`);
  console.log(`[LIMIT-ORDERS] Exit:  ${policy.exitOffsetBps}bps offset, ${policy.exitTimeoutMs}ms timeout, ${policy.exitMaxReplaces ?? 1} replaces`);
  console.log(`[LIMIT-ORDERS] Fallback: ${policy.fallbackToTaker ? 'enabled' : 'disabled'} after ${policy.fallbackAfterMs}ms, max slip ${policy.fallbackMaxSlippageBps}bps`);
  if (policy.exitAsMaker) {
    console.log(`[LIMIT-ORDERS] Exit as maker: ON (immediate fallback: ${policy.exitFallbackImmediate ? 'yes' : 'no'}, max slip ${policy.exitMaxSlippageBps}bps)`);
  }
}

module.exports = {
  VALID_FEE_MODELS,
  VALID_EXEC_MODES,
  VALID_DRIFT_TIERS,
  VALID_DRIFT_STAKING_TIERS,
  getFeeConfigFromEnv,
  buildFeeCfg,
  logFeeConfig,
  parseFeeOptions,
  buildLimitOrderPolicy,
  logLimitOrderPolicy,
};

