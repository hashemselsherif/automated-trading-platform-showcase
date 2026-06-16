/**
 * Backtest Simulation Constants
 * Extracted magic numbers for maintainability and clarity
 */

const SIMULATION_CONSTANTS = {
  // Execution simulation
  DEFAULT_POST_ONLY_MISS_RATE: 0.5,
  PRICE_IMPACT_A: 15,
  PRICE_IMPACT_B: 0.3,
  BASE_LATENCY_MS: 50,
  MAX_LATENCY_MS: 250,
  DEFAULT_REJECT_RATE: 0.001, // 0.1%
  DEFAULT_TIMEOUT_RATE: 0.001, // 0.1%
  DEFAULT_STALE_RATE: 0.001,   // 0.1%
  
  // Intervals
  DEFAULT_INTERVAL_MS: 300_000, // 5 minutes
  
  // Funding
  FUNDING_CADENCE_MS: 8 * 3_600_000, // 8 hours (8 * 60 * 60 * 1000)
  
  // Fee models
  // - jupiter: Flat 6bps open/close (default, legacy)
  // - drift: Tiered taker/maker with rebates
  DEFAULT_FEE_MODEL: 'jupiter',
  DEFAULT_EXEC_MODE: 'taker', // 'taker' or 'maker' (only affects Drift)
  // Drift tier maps to Drift *30D volume* tiers (row selection in Drift docs table)
  // Keep legacy names for compatibility with existing envs/scripts.
  DEFAULT_DRIFT_TIER: 'rookie', // Drift volume tier: rookie, bronze, silver, gold, platinum, vip
  // Drift staking tier (applies % discount/rebate on top of volume tier)
  DEFAULT_DRIFT_STAKING_TIER: 'rookie', // rookie, kickstarter, racer, elite, master, champion
  DEFAULT_DRIFT_HIGH_LEVERAGE_MODE: false, // if true, taker fees are 2x the bottom fee tier (Drift docs)
  
  // Jupiter fee structure (flat 6bps each way)
  DEFAULT_OPEN_FEE_BPS: 6,
  DEFAULT_CLOSE_FEE_BPS: 6,
  
  // Price impact fee
  DEFAULT_PRICE_IMPACT_FEE_SCALAR: 125_000_000_000,
  
  // Solana transaction fees
  DEFAULT_SOLANA_TX_FEE_USD: 0.001, // ~$0.001 per tx
  
  // ADV limits
  MAX_SLICE_ADV: 0.02, // 2% ADV per slice
  MIN_SLICE_ADV: 0.001, // 0.1% ADV minimum
  
  // Limit order policy defaults (Drift maker mode)
  DEFAULT_LIMIT_REF_PRICE: 'oracle',
  DEFAULT_LIMIT_ENTRY_BPS: 10,
  DEFAULT_LIMIT_EXIT_BPS: -2,     // Negative = accept worse price for faster fills
  DEFAULT_LIMIT_POST_ONLY: true,
  DEFAULT_LIMIT_ENTRY_TIMEOUT_MS: 60000,
  DEFAULT_LIMIT_EXIT_TIMEOUT_MS: 15000, // Faster timeout for exits
  DEFAULT_LIMIT_REPLACE_EVERY_MS: 15000,
  DEFAULT_LIMIT_MAX_REPLACES: 3,
  DEFAULT_LIMIT_CANCEL_IF_SIGNAL_INVALID: true,
  DEFAULT_LIMIT_FALLBACK_TO_TAKER: true,
  DEFAULT_LIMIT_FALLBACK_AFTER_MS: 45000,
  DEFAULT_LIMIT_FALLBACK_MIN_CONFIDENCE: 0.7,
  DEFAULT_LIMIT_FALLBACK_MAX_SLIPPAGE_BPS: 30,
  // Exit-specific (more aggressive)
  DEFAULT_LIMIT_EXIT_AS_MAKER: true,
  DEFAULT_LIMIT_EXIT_FALLBACK_IMMEDIATE: true,
  DEFAULT_LIMIT_EXIT_MAX_SLIPPAGE_BPS: 50,
  DEFAULT_LIMIT_EXIT_REPLACE_EVERY_MS: 10000,
  DEFAULT_LIMIT_EXIT_MAX_REPLACES: 1,
};

module.exports = SIMULATION_CONSTANTS;
