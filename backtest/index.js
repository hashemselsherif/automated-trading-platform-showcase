/**
 * Backtest Utilities - Main Entry Point
 * 
 * This module exports all backtest utilities for memory-optimized
 * and efficient backtesting.
 * 
 * Usage:
 *   const { createTypedCandleArray, loadAllMarkets } = require('./backtest');
 */

const typedCandleArray = require('./typed-candle-array');
const streamingJson = require('./streaming-json');
const dataLoader = require('./data-loader');
const rsiConfigBuilder = require('./rsi-config-builder');

module.exports = {
  // TypedCandleArray for memory-efficient candle storage
  ...typedCandleArray,
  
  // Streaming JSON parser for large cache files
  ...streamingJson,
  
  // Memory-optimized data loader
  ...dataLoader,
  
  // RSI strategy config builder
  ...rsiConfigBuilder,
};

