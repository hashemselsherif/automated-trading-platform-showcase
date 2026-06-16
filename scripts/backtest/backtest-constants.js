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
  
  // Price impact fee
  DEFAULT_PRICE_IMPACT_FEE_SCALAR: 125_000_000_000,
  
  // ADV limits
  MAX_SLICE_ADV: 0.02, // 2% ADV per slice
  MIN_SLICE_ADV: 0.001, // 0.1% ADV minimum
};

module.exports = SIMULATION_CONSTANTS;
