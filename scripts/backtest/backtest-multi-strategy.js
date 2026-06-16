#!/usr/bin/env node
/**
 * Multi-Strategy Backtest
 * 
 * Runs momentum AND RSI reversion strategies together with shared capital.
 * Both strategies operate on the same candle data and compete for capital.
 * 
 * Usage:
 *   node scripts/backtest/backtest-multi-strategy.js --days=30 --symbols=ETH,SOL
 */

const dotenv = require('dotenv');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

// Load environment files
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.momentum'), override: true });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.rsi-reversion'), override: true });

// Strategy classes
const EnhancedMomentumStrategy = require('../../enhanced-momentum-strategy');
const RsiMeanReversionStrategy = require('../../enhanced-momentum-rsi-strategy');
const db = require('../../db');

// Constants
const SUPPORTED_MARKETS = ['BTC', 'ETH', 'SOL'];
const TICKS_PER_5MIN_CANDLE = 20; // 5min / 15sec = 20 ticks

// Fee configuration (Jupiter Perps)
const FEE_CONFIG = {
  openFeeBps: 6,
  closeFeeBps: 6,
  priceImpactScalar: 0,
  solTxFeeUsd: 0.005 * 230, // ~$1.15
};

// ============================================================
// DATA FETCHING
// ============================================================

async function fetchCandles(symbol, interval, startTime, endTime) {
  // Try cache first
  const cacheKey = `${symbol}_${interval}_${startTime}_${endTime}`;
  
  // Try Pyth first
  try {
    const pythSymbol = `Crypto.${symbol}/USD`;
    const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history`;
    const response = await axios.get(url, {
      params: {
        symbol: pythSymbol,
        resolution: interval === '5m' ? '5' : '15',
        from: Math.floor(startTime / 1000),
        to: Math.floor(endTime / 1000),
      },
      timeout: 30000,
    });
    
    if (response.data?.s === 'ok' && response.data?.c?.length > 0) {
      const candles = response.data.t.map((timestamp, i) => ({
        openTime: timestamp * 1000,
        closeTime: timestamp * 1000 + (interval === '5m' ? 5 * 60 * 1000 : 15 * 60 * 1000),
        open: response.data.o[i],
        high: response.data.h[i],
        low: response.data.l[i],
        close: response.data.c[i],
        volume: response.data.v?.[i] || 0,
      }));
      console.log(`   [PYTH] Fetched ${candles.length} candles for ${symbol}`);
      return candles;
    }
  } catch (e) {
    console.log(`   [PYTH] Failed for ${symbol}, trying Binance...`);
  }
  
  // Fallback to Binance
  try {
    const binanceSymbol = `${symbol}USDT`;
    const url = 'https://api.binance.com/api/v3/klines';
    const candles = [];
    let currentStart = startTime;
    
    while (currentStart < endTime) {
      const response = await axios.get(url, {
        params: {
          symbol: binanceSymbol,
          interval: interval,
          startTime: currentStart,
          endTime: endTime,
          limit: 1000,
        },
        timeout: 30000,
      });
      
      if (!response.data?.length) break;
      
      for (const k of response.data) {
        candles.push({
          openTime: k[0],
          closeTime: k[6],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }
      
      currentStart = response.data[response.data.length - 1][6] + 1;
      if (response.data.length < 1000) break;
    }
    
    console.log(`   [BINANCE] Fetched ${candles.length} candles for ${symbol}`);
    return candles;
  } catch (e) {
    console.error(`   Failed to fetch ${symbol}: ${e.message}`);
    return [];
  }
}

// ============================================================
// SIMULATION
// ============================================================

function simulateMultiStrategy(momentumStrategies, rsiStrategies, candlesMap, options = {}) {
  const {
    initialCapital = 1000,
    positionSizePercent = 50,
    maxPositions = 3,
    leverage = 5,
    debug = false,
  } = options;
  
  // Build unified timeline
  const allTimestamps = new Set();
  for (const candles of candlesMap.values()) {
    for (const c of candles) {
      allTimestamps.add(c.openTime);
    }
  }
  const timestamps = Array.from(allTimestamps).sort((a, b) => a - b);
  
  // Build index maps
  const candleIndexMaps = new Map();
  for (const [market, candles] of candlesMap.entries()) {
    const indexMap = new Map();
    candles.forEach((c, idx) => indexMap.set(c.openTime, idx));
    candleIndexMaps.set(market, indexMap);
  }
  
  // State
  let realisedPnl = 0;
  let totalFees = 0;
  const allPositions = []; // All open positions across strategies
  const allTrades = [];
  const equitySeries = [initialCapital];
  let tradeCounter = 0;
  
  // Track by strategy type
  const strategyResults = {
    momentum: { trades: [], pnl: 0, wins: 0, losses: 0 },
    'rsi-reversion': { trades: [], pnl: 0, wins: 0, losses: 0 },
  };
  
  // Helper functions
  const getLockedCollateral = () => allPositions.reduce((sum, p) => sum + p.collateral, 0);
  const getAvailableCapital = () => Math.max(0, initialCapital + realisedPnl - getLockedCollateral());
  const getPositionSize = (available) => {
    const size = available * (positionSizePercent / 100);
    return Math.max(50, Math.min(size, available * 0.95));
  };
  
  console.log(`\n📊 Multi-Strategy Backtest`);
  console.log(`   Markets: ${Array.from(candlesMap.keys()).join(', ')}`);
  console.log(`   Strategies: momentum + rsi-reversion`);
  console.log(`   Initial Capital: $${initialCapital}`);
  console.log(`   Position Size: ${positionSizePercent}% of available`);
  console.log(`   Max Positions: ${maxPositions}`);
  console.log(`   Timeline: ${timestamps.length} candles\n`);
  
  // Main simulation loop
  for (let idx = 0; idx < timestamps.length; idx++) {
    const ts = timestamps[idx];
    
    // Get candles for all markets at this timestamp
    const marketCandles = new Map();
    for (const [market, candles] of candlesMap.entries()) {
      const indexMap = candleIndexMaps.get(market);
      if (indexMap.has(ts)) {
        const candleIdx = indexMap.get(ts);
        marketCandles.set(market, candles[candleIdx]);
      }
    }
    
    // Update all strategies
    for (const [market, candle] of marketCandles.entries()) {
      const momentumStrategy = momentumStrategies.get(market);
      const rsiStrategy = rsiStrategies.get(market);
      
      const barData = {
        price: candle.close,
        close: candle.close,
        high: candle.high,
        low: candle.low,
        volume: candle.volume,
        ts,
      };
      
      if (momentumStrategy) momentumStrategy.update(barData);
      if (rsiStrategy) rsiStrategy.update(barData);
    }
    
    // Calculate current equity
    let unrealisedPnl = 0;
    for (const pos of allPositions) {
      const candle = marketCandles.get(pos.market);
      const currentPrice = candle?.close || pos.entryPrice;
      const dir = pos.side === 'long' ? 1 : -1;
      unrealisedPnl += dir * (currentPrice - pos.entryPrice) * pos.quantity;
    }
    const currentEquity = initialCapital + realisedPnl + unrealisedPnl;
    equitySeries.push(currentEquity);
    
    // Process exits for all open positions - EACH STRATEGY HAS ITS OWN EXIT LOGIC
    const positionsToClose = [];
    for (const pos of allPositions) {
      const candle = marketCandles.get(pos.market);
      if (!candle) continue;
      
      const price = candle.close;
      
      // ============================================================
      // MOMENTUM STRATEGY EXITS: Static TP/SL based on price %
      // ============================================================
      if (pos.strategyType === 'momentum') {
        const tpPercent = parseFloat(process.env.STRATEGY_TP_PERCENT) || 10;
        const slPercent = parseFloat(process.env.STRATEGY_SL_PERCENT) || 5;
        
        // Calculate P&L percentage
        const pnlPct = pos.side === 'long'
          ? ((price - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - price) / pos.entryPrice) * 100;
        
        // Check TP (take profit)
        if (pnlPct >= tpPercent) {
          positionsToClose.push({ pos, reason: 'momentum_tp', price, candle });
          continue;
        }
        
        // Check SL (stop loss) - use intra-bar high/low for accuracy
        const slDistance = (slPercent / 100) * pos.entryPrice;
        let slTriggered = false;
        let slPrice = price;
        
        if (pos.side === 'long') {
          const slLevel = pos.entryPrice - slDistance;
          if (candle.low <= slLevel) {
            slTriggered = true;
            slPrice = slLevel;
          }
        } else {
          const slLevel = pos.entryPrice + slDistance;
          if (candle.high >= slLevel) {
            slTriggered = true;
            slPrice = slLevel;
          }
        }
        
        if (slTriggered) {
          positionsToClose.push({ pos, reason: 'momentum_sl', price: slPrice, candle });
          continue;
        }
        
        // Check strategy's shouldClose for other exits (trend reversal, etc.)
        const strategy = momentumStrategies.get(pos.market);
        if (strategy?.shouldClose) {
          const exitSignal = strategy.shouldClose(pos, price, price);
          if (exitSignal?.close) {
            positionsToClose.push({ pos, reason: exitSignal.reason || 'momentum_exit', price, candle });
          }
        }
      }
      
      // ============================================================
      // RSI STRATEGY EXITS: RSI-based targets + hard stop
      // ============================================================
      else if (pos.strategyType === 'rsi-reversion') {
        const strategy = rsiStrategies.get(pos.market);
        if (!strategy) continue;
        
        // RSI hard stop (collateral-based)
        const hardStopPercent = parseFloat(process.env[`STRATEGY_${pos.market}_PERP_HARD_STOP_PERCENT`]) || 
                                parseFloat(process.env.RSI_HARD_STOP_PERCENT) || 3;
        const hardStopDistance = (hardStopPercent / 100 / pos.leverage) * pos.entryPrice;
        
        let hardStopTriggered = false;
        let hardStopPrice = price;
        
        if (pos.side === 'short') {
          const stopLevel = pos.entryPrice + hardStopDistance;
          if (candle.high >= stopLevel) {
            hardStopTriggered = true;
            hardStopPrice = stopLevel;
          }
        } else if (pos.side === 'long') {
          const stopLevel = pos.entryPrice - hardStopDistance;
          if (candle.low <= stopLevel) {
            hardStopTriggered = true;
            hardStopPrice = stopLevel;
          }
        }
        
        if (hardStopTriggered) {
          positionsToClose.push({ pos, reason: 'rsi_hard_stop', price: hardStopPrice, candle });
          continue;
        }
        
        // RSI target exit - use candle.close since RSI is calculated from close
        const exitSignal = strategy.shouldClose(pos, price, price);
        if (exitSignal?.close) {
          positionsToClose.push({ pos, reason: exitSignal.reason || 'rsi_exit', price: candle.close, candle });
        }
      }
    }
    
    // Close positions
    for (const { pos, reason, price } of positionsToClose) {
      const idx = allPositions.indexOf(pos);
      if (idx === -1) continue;
      allPositions.splice(idx, 1);
      
      const dir = pos.side === 'long' ? 1 : -1;
      const grossPnl = dir * (price - pos.entryPrice) * pos.quantity;
      const closeFee = (pos.sizeUsd * FEE_CONFIG.closeFeeBps) / 10000;
      const txFee = FEE_CONFIG.solTxFeeUsd;
      const exitFees = closeFee + txFee;
      const netPnl = grossPnl - exitFees;
      
      realisedPnl += netPnl;
      // Only add exit fees here - entry fees were already added when position was opened
      totalFees += exitFees;
      
      const trade = {
        id: pos.id,
        market: pos.market,
        strategyType: pos.strategyType,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: price,
        sizeUsd: pos.sizeUsd,
        collateral: pos.collateral,
        leverage: pos.leverage,
        grossPnl,
        netPnl,
        pnlPct: (netPnl / pos.collateral) * 100,
        exitReason: reason,
        entryFee: pos.entryFee,
        exitFee: exitFees,
      };
      
      allTrades.push(trade);
      strategyResults[pos.strategyType].trades.push(trade);
      strategyResults[pos.strategyType].pnl += netPnl;
      if (netPnl > 0) strategyResults[pos.strategyType].wins++;
      else strategyResults[pos.strategyType].losses++;
      
      if (debug) {
        const emoji = netPnl >= 0 ? '✅' : '❌';
        console.log(`${emoji} [${pos.strategyType}] ${pos.market} ${pos.side} | ${reason} | PnL: $${netPnl.toFixed(2)}`);
      }
    }
    
    // Collect entry signals from all strategies
    if (allPositions.length >= maxPositions) continue;
    
    const availableCapital = getAvailableCapital();
    if (availableCapital < 50) continue;
    
    const signals = [];
    
    for (const [market, candle] of marketCandles.entries()) {
      // Check if already have position in this market
      const hasPosition = allPositions.some(p => p.market === market);
      if (hasPosition) continue;
      
      const price = candle.close;
      
      // ============================================================
      // MOMENTUM SIGNALS - Trend following, both longs and shorts
      // ============================================================
      const momentumStrategy = momentumStrategies.get(market);
      if (momentumStrategy) {
        const signal = momentumStrategy.getSignal?.(price, []);
        if (signal?.action === 'open') {
          signals.push({
            market,
            strategyType: 'momentum',
            side: signal.side,
            price,
            candle,
            confidence: signal.confidence || 0.5,
            priority: 1, // Momentum has lower priority (less frequent, bigger moves)
          });
        }
      }
      
      // ============================================================
      // RSI SIGNALS - Mean reversion, filtered by env config
      // ============================================================
      const rsiStrategy = rsiStrategies.get(market);
      if (rsiStrategy) {
        // Check env filters for RSI
        const allowLongs = (process.env.RSI_ALLOW_LONGS || 'false').toLowerCase() === 'true';
        const allowShorts = (process.env.RSI_ALLOW_SHORTS || 'true').toLowerCase() === 'true';
        
        const signal = rsiStrategy.getSignal?.(price, []);
        if (signal?.action === 'open') {
          // Apply direction filter
          if ((signal.side === 'long' && allowLongs) || (signal.side === 'short' && allowShorts)) {
            signals.push({
              market,
              strategyType: 'rsi-reversion',
              side: signal.side,
              price,
              candle,
              confidence: signal.confidence || 0.6,
              priority: 2, // RSI has higher priority (more frequent, smaller moves)
            });
          }
        }
      }
    }
    
    // Sort signals by priority (higher first), then confidence
    signals.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) {
        return (b.priority || 0) - (a.priority || 0);
      }
      return (b.confidence || 0) - (a.confidence || 0);
    });
    
    // Execute best signals until max positions reached
    for (const signal of signals) {
      if (allPositions.length >= maxPositions) break;
      
      const available = getAvailableCapital();
      if (available < 50) break;
      
      // Don't open conflicting positions in same market
      if (allPositions.some(p => p.market === signal.market)) continue;
      
      const collateral = getPositionSize(available);
      const marketLeverage = signal.strategyType === 'momentum' ? leverage : 5;
      const sizeUsd = collateral * marketLeverage;
      const quantity = sizeUsd / signal.price;
      
      // Entry fees
      const openFee = (sizeUsd * FEE_CONFIG.openFeeBps) / 10000;
      const txFee = FEE_CONFIG.solTxFeeUsd;
      const entryFee = openFee + txFee;
      
      realisedPnl -= entryFee;
      totalFees += entryFee;
      
      const position = {
        id: `multi-${++tradeCounter}`,
        market: signal.market,
        strategyType: signal.strategyType,
        side: signal.side,
        entryPrice: signal.price,
        sizeUsd,
        quantity,
        collateral,
        leverage: marketLeverage,
        entryFee,
        openTime: signal.candle.closeTime,
      };
      
      allPositions.push(position);
      
      if (debug) {
        console.log(`🎯 [${signal.strategyType}] ${signal.market} ${signal.side.toUpperCase()} @ $${signal.price.toFixed(2)} | Collateral: $${collateral.toFixed(0)}`);
      }
    }
  }
  
  // Close remaining positions
  for (const pos of [...allPositions]) {
    const candles = candlesMap.get(pos.market);
    const lastCandle = candles?.[candles.length - 1];
    const price = lastCandle?.close || pos.entryPrice;
    
    const dir = pos.side === 'long' ? 1 : -1;
    const grossPnl = dir * (price - pos.entryPrice) * pos.quantity;
    const closeFee = (pos.sizeUsd * FEE_CONFIG.closeFeeBps) / 10000;
    const netPnl = grossPnl - closeFee;
    
    realisedPnl += netPnl;
    // Only add exit fees here - entry fees were already added when position was opened
    totalFees += closeFee;
    
    allTrades.push({
      id: pos.id,
      market: pos.market,
      strategyType: pos.strategyType,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      netPnl,
      exitReason: 'backtest_end',
    });
    
    strategyResults[pos.strategyType].pnl += netPnl;
  }
  
  return {
    trades: allTrades,
    totalPnL: realisedPnl,
    totalFees,
    equitySeries,
    initialCapital,
    strategyResults,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  const options = {
    days: 30,
    symbols: ['ETH', 'SOL'],
    initialCapital: 1000,
    positionSizePercent: 50,
    maxPositions: 3,
    leverage: 5,
    debug: false,
  };
  
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (key === 'days') options.days = parseInt(value);
      else if (key === 'symbols') options.symbols = value.toUpperCase().split(',').filter(s => SUPPORTED_MARKETS.includes(s));
      else if (key === 'initialCapital') options.initialCapital = parseFloat(value);
      else if (key === 'positionSizePercent') options.positionSizePercent = parseFloat(value);
      else if (key === 'maxPositions') options.maxPositions = parseInt(value);
      else if (key === 'leverage') options.leverage = parseFloat(value);
      else if (key === 'debug') options.debug = true;
    }
  }
  
  console.log('\n🔄 Multi-Strategy Backtest (Momentum + RSI Reversion)');
  console.log('='.repeat(60));
  console.log(`  Markets: ${options.symbols.join(', ')}`);
  console.log(`  Days: ${options.days}`);
  console.log(`  Initial Capital: $${options.initialCapital}`);
  console.log(`  Position Size: ${options.positionSizePercent}%`);
  console.log(`  Max Positions: ${options.maxPositions}`);
  
  // Strategy-specific settings
  const momentumTp = parseFloat(process.env.STRATEGY_TP_PERCENT) || 10;
  const momentumSl = parseFloat(process.env.STRATEGY_SL_PERCENT) || 5;
  const rsiHardStop = parseFloat(process.env.RSI_HARD_STOP_PERCENT) || 3;
  const rsiAllowLongs = (process.env.RSI_ALLOW_LONGS || 'false').toLowerCase() === 'true';
  const rsiAllowShorts = (process.env.RSI_ALLOW_SHORTS || 'true').toLowerCase() === 'true';
  
  console.log(`\n🚀 MOMENTUM CONFIG`);
  console.log(`  TP: ${momentumTp}% | SL: ${momentumSl}%`);
  console.log(`  Direction: Both longs & shorts`);
  
  console.log(`\n📊 RSI REVERSION CONFIG`);
  console.log(`  Hard Stop: ${rsiHardStop}% of collateral`);
  console.log(`  Direction: ${rsiAllowLongs ? 'Longs' : ''}${rsiAllowLongs && rsiAllowShorts ? ' + ' : ''}${rsiAllowShorts ? 'Shorts' : ''}`);
  
  // Fetch candles
  const endTime = Date.now();
  const startTime = endTime - options.days * 24 * 60 * 60 * 1000;
  
  const candlesMap = new Map();
  const momentumStrategies = new Map();
  const rsiStrategies = new Map();
  
  for (const symbol of options.symbols) {
    console.log(`\n📥 Fetching ${symbol} 5m candles...`);
    const candles = await fetchCandles(symbol, '5m', startTime, endTime);
    
    if (!candles || candles.length === 0) {
      console.error(`❌ No candle data for ${symbol}`);
      continue;
    }
    
    candlesMap.set(symbol, candles);
    
    // Create momentum strategy
    const momentumStrategy = new EnhancedMomentumStrategy({
      market: `${symbol}-PERP`,
      strategy: {
        tpPercent: parseFloat(process.env.STRATEGY_TP_PERCENT) || 10,
        slPercent: parseFloat(process.env.STRATEGY_SL_PERCENT) || 5,
        trendConfirmation: true,
      },
    });
    momentumStrategies.set(symbol, momentumStrategy);
    
    // Create RSI strategy with per-market settings
    const marketKey = `${symbol}_PERP`.toUpperCase();
    const overboughtExtreme = parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_EXTREME`]) || 72;
    const overboughtRecovery = parseFloat(process.env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_RECOVERY`]) || 68;
    
    const rsiStrategy = new RsiMeanReversionStrategy({
      market: `${symbol}-PERP`,
      quiet: true,
      rsiStrategy: {
        rsiPeriod: 14,
        rsiOverboughtExtreme: overboughtExtreme,
        rsiOverboughtRecovery: overboughtRecovery,
        rsiOversoldExtreme: 24,
        rsiOversoldRecovery: 26,
        rsiTargetNeutral: 50,
      },
    });
    rsiStrategies.set(symbol, rsiStrategy);
    
    console.log(`   Created strategies for ${symbol}`);
  }
  
  if (candlesMap.size === 0) {
    console.error('❌ No candle data available');
    process.exit(1);
  }
  
  // Run simulation
  const result = simulateMultiStrategy(momentumStrategies, rsiStrategies, candlesMap, options);
  
  // Print results
  console.log('\n' + '='.repeat(80));
  console.log('                    MULTI-STRATEGY BACKTEST RESULTS');
  console.log('='.repeat(80));
  
  // Overall results
  const finalEquity = options.initialCapital + result.totalPnL;
  const returnPct = (result.totalPnL / options.initialCapital) * 100;
  const wins = result.trades.filter(t => t.netPnl > 0).length;
  const losses = result.trades.filter(t => t.netPnl <= 0).length;
  const winRate = result.trades.length > 0 ? (wins / result.trades.length * 100) : 0;
  
  console.log(`\n📊 OVERALL PERFORMANCE`);
  console.log('-'.repeat(50));
  console.log(`  Initial Capital:   $${options.initialCapital.toLocaleString()}`);
  console.log(`  Final Equity:      $${finalEquity.toFixed(2)}`);
  console.log(`  Total Return:      ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}% ($${result.totalPnL >= 0 ? '+' : ''}${result.totalPnL.toFixed(2)})`);
  console.log(`  Total Trades:      ${result.trades.length}`);
  console.log(`  Win Rate:          ${winRate.toFixed(1)}%`);
  console.log(`  Total Fees:        $${result.totalFees.toFixed(2)}`);
  
  // Per-strategy breakdown
  console.log(`\n📈 STRATEGY BREAKDOWN`);
  console.log('-'.repeat(50));
  
  for (const [strategyType, stats] of Object.entries(result.strategyResults)) {
    const strategyWinRate = stats.trades.length > 0 ? (stats.wins / stats.trades.length * 100) : 0;
    const emoji = strategyType === 'momentum' ? '🚀' : '📊';
    console.log(`\n${emoji} ${strategyType.toUpperCase()}`);
    console.log(`  Trades: ${stats.trades.length} | Wins: ${stats.wins} | Losses: ${stats.losses}`);
    console.log(`  Win Rate: ${strategyWinRate.toFixed(1)}%`);
    console.log(`  P&L: $${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2)}`);
    
    // By market
    const byMarket = {};
    for (const trade of stats.trades) {
      if (!byMarket[trade.market]) byMarket[trade.market] = { trades: 0, pnl: 0 };
      byMarket[trade.market].trades++;
      byMarket[trade.market].pnl += trade.netPnl || 0;
    }
    for (const [market, mstats] of Object.entries(byMarket)) {
      console.log(`    ${market}: ${mstats.trades} trades, $${mstats.pnl >= 0 ? '+' : ''}${mstats.pnl.toFixed(2)}`);
    }
  }
  
  // Exit reasons
  console.log(`\n🚪 EXIT REASONS`);
  console.log('-'.repeat(50));
  const exitReasons = {};
  for (const trade of result.trades) {
    const reason = trade.exitReason || 'unknown';
    if (!exitReasons[reason]) exitReasons[reason] = { count: 0, pnl: 0 };
    exitReasons[reason].count++;
    exitReasons[reason].pnl += trade.netPnl || 0;
  }
  for (const [reason, stats] of Object.entries(exitReasons).sort((a, b) => b[1].count - a[1].count)) {
    const emoji = stats.pnl >= 0 ? '✅' : '❌';
    console.log(`  ${emoji} ${reason}: ${stats.count} trades | P&L: $${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2)}`);
  }
  
  // Worst trades
  const worstTrades = result.trades.filter(t => t.netPnl < 0).sort((a, b) => a.netPnl - b.netPnl).slice(0, 5);
  if (worstTrades.length > 0) {
    console.log(`\n🔴 TOP 5 WORST TRADES`);
    console.log('-'.repeat(50));
    for (const t of worstTrades) {
      console.log(`  [${t.strategyType}] ${t.market} ${t.side} $${t.netPnl.toFixed(2)} | ${t.exitReason}`);
    }
  }
  
  // Best trades
  const bestTrades = result.trades.filter(t => t.netPnl > 0).sort((a, b) => b.netPnl - a.netPnl).slice(0, 5);
  if (bestTrades.length > 0) {
    console.log(`\n🟢 TOP 5 BEST TRADES`);
    console.log('-'.repeat(50));
    for (const t of bestTrades) {
      console.log(`  [${t.strategyType}] ${t.market} ${t.side} $+${t.netPnl.toFixed(2)} | ${t.exitReason}`);
    }
  }
  
  // Save results
  const resultsDir = path.join(__dirname, '..', '..', 'results', 'json');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  
  const filename = `multi-strategy-${options.symbols.join('-')}-${options.days}d-${Date.now()}.json`;
  const filepath = path.join(resultsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify({
    config: options,
    results: {
      totalPnL: result.totalPnL,
      totalFees: result.totalFees,
      trades: result.trades.length,
      winRate,
    },
    strategyResults: result.strategyResults,
    trades: result.trades,
  }, null, 2));
  
  console.log(`\n📁 Results saved to: ${filepath}`);
  console.log('\n✅ Multi-strategy backtest complete!\n');
}

main().catch(err => {
  console.error('❌ Backtest failed:', err);
  process.exit(1);
});

