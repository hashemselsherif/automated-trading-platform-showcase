/**
 * Funding rate utilities for backtesting
 */

const SIMULATION_CONSTANTS = require('../backtest-constants');
const { gaussian } = require('./math-utils');

/**
 * Get funding rate for a specific timestamp
 * @param {number} ts - Timestamp
 * @param {Object} fundingCfg - Funding configuration
 * @param {Map<number, number>} historicalRates - Optional historical funding rates map
 * @param {string} market - Optional market symbol for multi-market
 * @returns {number} Funding rate per 8h period (as decimal)
 */
function getFundingRateForTimestamp(ts, fundingCfg, historicalRates = null, market = null) {
  // If historical rates available, use them
  if (historicalRates) {
    // Handle multi-market case (Map of market -> Map of timestamp -> rate)
    let ratesMap = historicalRates;
    if (market && historicalRates instanceof Map && historicalRates.size > 0) {
      // Check if first entry is a Map (multi-market structure)
      const firstEntry = historicalRates.values().next().value;
      if (firstEntry instanceof Map) {
        ratesMap = historicalRates.get(market) || new Map();
      }
    }
    
    if (ratesMap && ratesMap instanceof Map && ratesMap.size > 0) {
      // Find the closest funding rate timestamp (funding rates are every 8h)
      const fundingPeriodMs = SIMULATION_CONSTANTS.FUNDING_CADENCE_MS; // 8 hours
      const alignedTs = Math.floor(ts / fundingPeriodMs) * fundingPeriodMs;
      
      // Look for funding rate at or before this timestamp
      let closestRate = null;
      let closestTs = null;
      
      for (const [fundingTs, rate] of ratesMap.entries()) {
        if (fundingTs <= alignedTs && (!closestTs || fundingTs > closestTs)) {
          closestTs = fundingTs;
          closestRate = rate;
        }
      }
      
      if (closestRate !== null) {
        return closestRate;
      }
    }
  }
  
  // Fall back to configured rate
  return fundingCfg?.ratePerCadence || 0;
}

/**
 * Accrue funding fees if due
 * @param {Array} positions - Open positions
 * @param {number} ts - Timestamp
 * @param {number} markPrice - Current mark price
 * @param {Object} options - Funding configuration
 * @param {Map<number, number>} historicalRates - Optional historical funding rates map
 * @param {string} market - Optional market symbol for multi-market
 * @returns {number} Total funding fees accrued
 */
function accrueFundingIfDue(positions, ts, markPrice, { cadenceMs = SIMULATION_CONSTANTS.FUNDING_CADENCE_MS, ratePerCadence = 0, startOffsetMs = 0 } = {}, historicalRates = null, market = null) {
  let realised = 0;
  const fundingCfg = { cadenceMs, ratePerCadence, startOffsetMs };
  
  for (const pos of positions) {
    const last = pos._lastFundingTs ?? 0;
    if (last === 0) {
      const aligned = Math.floor((ts - startOffsetMs) / cadenceMs) * cadenceMs + startOffsetMs;
      pos._lastFundingTs = aligned;
      continue;
    }
    const duePeriods = Math.floor((ts - last) / cadenceMs);
    if (duePeriods <= 0) continue;
    
    // Get funding rate for each period (can vary if using historical rates)
    let totalPayment = 0;
    const posMarket = pos.market || market;
    
    for (let period = 0; period < duePeriods; period++) {
      const periodTs = last + (period + 1) * cadenceMs;
      const periodRate = getFundingRateForTimestamp(periodTs, fundingCfg, historicalRates, posMarket);
      
      // Funding formula: payment = sizeUsd * rate * side_multiplier
      // For longs: positive rate means paying (1), negative rate means receiving (-1)
      // For shorts: positive rate means receiving (-1), negative rate means paying (1)
      // So: payment = sizeUsd * rate * (side === 'long' ? 1 : -1)
      const paymentPerPeriod = pos.sizeUsd * periodRate * (pos.side === 'long' ? 1 : -1);
      totalPayment += paymentPerPeriod;
    }
    
    // Subtract from PnL (positive payment = cost, negative payment = credit)
    realised -= totalPayment;
    if (totalPayment !== 0) {
      pos.totalFundingPayments = (pos.totalFundingPayments || 0) + totalPayment;
    }
    pos._lastFundingTs = last + duePeriods * cadenceMs;
  }
  return realised;
}

module.exports = { accrueFundingIfDue };
