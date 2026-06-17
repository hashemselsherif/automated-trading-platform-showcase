/**
 * Backtest Utilities - Central Export
 * Provides unified access to all backtest utility functions
 */

// Math utilities
const { gaussian } = require('./math-utils');

// Price utilities
const { computeMarkPrice } = require('./price-utils');

// Fee calculation utilities
const {
  calculatePriceImpactFee,
  calculateOpenFee,
  calculateCloseFee,
  calculateSolanaTransactionFees,
  accrueBorrowFeesIfDue,
} = require('./fee-calculator');

// Funding utilities
const { accrueFundingIfDue } = require('./funding-utils');

// Position utilities
const {
  unrealised,
  shouldLiquidate,
  positionEquity,
} = require('./position-utils');

module.exports = {
  // Math
  gaussian,
  
  // Price
  computeMarkPrice,
  
  // Fees
  calculatePriceImpactFee,
  calculateOpenFee,
  calculateCloseFee,
  calculateSolanaTransactionFees,
  accrueBorrowFeesIfDue,
  
  // Funding
  accrueFundingIfDue,
  
  // Positions
  unrealised,
  shouldLiquidate,
  positionEquity,
};
