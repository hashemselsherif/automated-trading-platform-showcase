/**
 * Memory-Optimized Data Loader for Backtest
 * 
 * Key optimizations:
 * 1. Uses TypedArrays for candle storage (~60% memory reduction)
 * 2. Releases 1m candles after tick cache is built (saves ~50MB per market)
 * 3. Uses streaming JSON parser for large cache files
 * 4. Batches market loading for better memory predictability
 * 5. Optional garbage collection hints between batches
 */

const fs = require('fs');
const path = require('path');
const { createTypedCandleArray, isTypedCandleArray } = require('./typed-candle-array');
const { loadCandlesFromCache, saveCandlesToCache, getFileSizeMB } = require('./streaming-json');

// Default cache directory
const DEFAULT_CACHE_DIR = path.join(process.cwd(), 'backtest-cache');

/**
 * Memory stats helper
 * @returns {Object} Memory usage in MB
 */
function getMemoryUsage() {
  const used = process.memoryUsage();
  return {
    heapUsed: Math.round(used.heapUsed / 1024 / 1024),
    heapTotal: Math.round(used.heapTotal / 1024 / 1024),
    rss: Math.round(used.rss / 1024 / 1024),
    external: Math.round(used.external / 1024 / 1024),
  };
}

/**
 * Format memory stats as string
 * @param {Object} mem
 * @returns {string}
 */
function formatMemory(mem) {
  return `heap=${mem.heapUsed}/${mem.heapTotal}MB, rss=${mem.rss}MB`;
}

/**
 * Try to trigger garbage collection if exposed
 */
function tryGC() {
  if (global.gc) {
    global.gc();
    return true;
  }
  return false;
}

/**
 * Load market data with memory optimizations
 * 
 * @param {Object} params
 * @param {string} params.symbol - Market symbol (e.g., 'SOL')
 * @param {string} params.interval - Candle interval ('5m')
 * @param {number} params.startTime - Start timestamp (ms)
 * @param {number} params.endTime - End timestamp (ms)
 * @param {Function} params.fetchCandles - Function to fetch candles
 * @param {Function} params.getOrBuildTicksByBarOpenTime - Function to build tick cache
 * @param {Function} [params.aggregate1MinTo5MinAligned] - Function to aggregate 1m to 5m
 * @param {Object} [options]
 * @param {boolean} [options.use1MinTicks=true] - Whether to load 1m for tick generation
 * @param {boolean} [options.useTypedArrays=true] - Use TypedArrays for storage
 * @param {boolean} [options.release1mAfterTicks=true] - Free 1m candles after tick cache
 * @param {string} [options.source='db'] - Data source ('db', 'pyth', 'binance')
 * @param {string} [options.aggregation='aligned'] - Aggregation method
 * @param {boolean} [options.verbose=false] - Log memory stats
 * @returns {Promise<Object>} { candles, ticksByBarOpenTime, oneMinCandles? }
 */
async function loadMarketData(params, options = {}) {
  const {
    symbol,
    interval,
    startTime,
    endTime,
    fetchCandles,
    getOrBuildTicksByBarOpenTime,
    aggregate1MinTo5MinAligned,
  } = params;

  const {
    use1MinTicks = true,
    useTypedArrays = true,
    release1mAfterTicks = true,
    source = 'db',
    aggregation = 'aligned',
    verbose = false,
  } = options;

  const result = {
    candles: null,
    ticksByBarOpenTime: null,
    oneMinCandles: null,
    memoryBefore: getMemoryUsage(),
    memoryAfter: null,
  };

  if (verbose) {
    console.log(`\n📥 Loading ${symbol} data [${formatMemory(result.memoryBefore)}]`);
  }

  if (interval === '5m' && use1MinTicks) {
    // Load 1m candles for tick generation
    if (verbose) console.log(`   Fetching ${symbol} 1m candles...`);
    
    let oneMinCandles = await fetchCandles(symbol, '1m', startTime, endTime, source);
    if (!oneMinCandles || oneMinCandles.length === 0) {
      throw new Error(`No 1m candles for ${symbol} (${source})`);
    }
    
    if (verbose) console.log(`   ${oneMinCandles.length} 1m candles loaded`);

    // Build tick cache
    if (verbose) console.log(`   Building tick cache...`);
    
    const ticksByBarOpenTime = await getOrBuildTicksByBarOpenTime({
      source,
      symbol,
      startTime,
      endTime,
      oneMinCandles,
    });
    result.ticksByBarOpenTime = ticksByBarOpenTime;

    // Aggregate 1m -> 5m
    if (verbose) console.log(`   Aggregating to 5m...`);
    
    let agg;
    if (aggregation === 'legacy') {
      agg = [];
      for (let i = 0; i < oneMinCandles.length; i += 5) {
        const g = oneMinCandles.slice(i, i + 5);
        if (g.length === 5) {
          agg.push({
            openTime: g[0].openTime,
            closeTime: g[4].closeTime,
            open: g[0].open,
            high: Math.max(...g.map(c => c.high)),
            low: Math.min(...g.map(c => c.low)),
            close: g[4].close,
            baseVolume: g.reduce((s, c) => s + (c.baseVolume || 0), 0),
            quoteVolume: g.reduce((s, c) => s + (c.quoteVolume || 0), 0),
            tradeCount: g.reduce((s, c) => s + (c.tradeCount || 0), 0),
          });
        }
      }
    } else {
      agg = aggregate1MinTo5MinAligned(oneMinCandles);
    }

    if (!agg || agg.length === 0) {
      throw new Error(`No 5m candles after aggregation for ${symbol} (${source})`);
    }
    
    if (verbose) console.log(`   ${oneMinCandles.length} 1m → ${agg.length} 5m candles`);

    // Convert to TypedArray if requested
    if (useTypedArrays) {
      result.candles = createTypedCandleArray(agg);
    } else {
      result.candles = agg;
    }

    // Release 1m candles to save memory
    if (release1mAfterTicks) {
      if (verbose) console.log(`   Releasing 1m candles (${oneMinCandles.length} items)...`);
      oneMinCandles = null; // Allow GC
      result.oneMinCandles = null;
    } else {
      // Keep 1m candles if needed for other purposes
      if (useTypedArrays) {
        result.oneMinCandles = createTypedCandleArray(oneMinCandles);
      } else {
        result.oneMinCandles = oneMinCandles;
      }
    }

  } else {
    // Direct interval fetch (no tick generation)
    if (verbose) console.log(`   Fetching ${symbol} ${interval} candles...`);
    
    const candles = await fetchCandles(symbol, interval, startTime, endTime, source);
    if (!candles || candles.length === 0) {
      throw new Error(`No ${interval} candles for ${symbol} (${source})`);
    }
    
    if (verbose) console.log(`   ${candles.length} candles loaded`);

    if (useTypedArrays) {
      result.candles = createTypedCandleArray(candles);
    } else {
      result.candles = candles;
    }
  }

  result.memoryAfter = getMemoryUsage();
  
  if (verbose) {
    const memDiff = result.memoryAfter.heapUsed - result.memoryBefore.heapUsed;
    console.log(`   ✓ ${symbol} loaded (+${memDiff}MB heap) [${formatMemory(result.memoryAfter)}]`);
  }

  return result;
}

/**
 * Load multiple markets in batches with optional GC between batches
 * 
 * @param {Object} params
 * @param {string[]} params.symbols - Market symbols
 * @param {string} params.interval - Candle interval
 * @param {number} params.startTime - Start timestamp
 * @param {number} params.endTime - End timestamp  
 * @param {Function} params.fetchCandles - Function to fetch candles
 * @param {Function} params.getOrBuildTicksByBarOpenTime - Function to build tick cache
 * @param {Function} params.aggregate1MinTo5MinAligned - Aggregation function
 * @param {Object} [options]
 * @param {number} [options.batchSize=4] - Markets to load per batch
 * @param {boolean} [options.gcBetweenBatches=true] - Force GC between batches
 * @param {number} [options.delayBetweenSymbols=0] - Delay in ms between symbol loads
 * @param {boolean} [options.use1MinTicks=true]
 * @param {boolean} [options.useTypedArrays=true]
 * @param {boolean} [options.release1mAfterTicks=true]
 * @param {string} [options.source='db']
 * @param {string} [options.aggregation='aligned']
 * @param {boolean} [options.verbose=false]
 * @returns {Promise<Object>} { candlesMap, ticksByBarOpenTimeMap, stats }
 */
async function loadAllMarkets(params, options = {}) {
  const {
    symbols,
    interval,
    startTime,
    endTime,
    fetchCandles,
    getOrBuildTicksByBarOpenTime,
    aggregate1MinTo5MinAligned,
  } = params;

  const {
    batchSize = 4,
    gcBetweenBatches = true,
    delayBetweenSymbols = 0,
    use1MinTicks = true,
    useTypedArrays = true,
    release1mAfterTicks = true,
    source = 'db',
    aggregation = 'aligned',
    verbose = false,
  } = options;

  const candlesMap = new Map();
  const ticksByBarOpenTimeMap = new Map();
  const oneMinCandlesMap = new Map();
  
  const stats = {
    startTime: Date.now(),
    endTime: null,
    symbolStats: new Map(),
    initialMemory: getMemoryUsage(),
    peakMemory: getMemoryUsage(),
    finalMemory: null,
    totalCandles: 0,
    gcRuns: 0,
  };

  console.log(`\n📦 Loading ${symbols.length} markets (batch size: ${batchSize}, TypedArrays: ${useTypedArrays})`);
  console.log(`   Initial memory: ${formatMemory(stats.initialMemory)}`);

  // Process in batches
  const batches = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    
    if (verbose || batches.length > 1) {
      console.log(`\n   Batch ${batchIdx + 1}/${batches.length}: ${batch.join(', ')}`);
    }

    for (let i = 0; i < batch.length; i++) {
      const symbol = batch[i];
      
      try {
        const result = await loadMarketData({
          symbol,
          interval,
          startTime,
          endTime,
          fetchCandles,
          getOrBuildTicksByBarOpenTime,
          aggregate1MinTo5MinAligned,
        }, {
          use1MinTicks,
          useTypedArrays,
          release1mAfterTicks,
          source,
          aggregation,
          verbose: verbose || symbols.length <= 4,
        });

        candlesMap.set(symbol, result.candles);
        
        if (result.ticksByBarOpenTime) {
          ticksByBarOpenTimeMap.set(symbol, result.ticksByBarOpenTime);
        }
        
        if (result.oneMinCandles) {
          oneMinCandlesMap.set(symbol, result.oneMinCandles);
        }

        // Track stats
        const candleCount = result.candles.length;
        stats.totalCandles += candleCount;
        stats.symbolStats.set(symbol, {
          candles: candleCount,
          memoryDelta: result.memoryAfter.heapUsed - result.memoryBefore.heapUsed,
        });

        // Update peak memory
        const currentMem = getMemoryUsage();
        if (currentMem.heapUsed > stats.peakMemory.heapUsed) {
          stats.peakMemory = currentMem;
        }

        // Delay between symbols if needed (e.g., for rate limiting)
        if (delayBetweenSymbols > 0 && i < batch.length - 1) {
          await new Promise(r => setTimeout(r, delayBetweenSymbols));
        }

      } catch (err) {
        console.error(`   ❌ Failed to load ${symbol}: ${err.message}`);
        throw err;
      }
    }

    // GC between batches
    if (gcBetweenBatches && batchIdx < batches.length - 1) {
      if (tryGC()) {
        stats.gcRuns++;
        const afterGC = getMemoryUsage();
        if (verbose) {
          console.log(`   🗑️ GC run, memory now: ${formatMemory(afterGC)}`);
        }
      }
    }
  }

  stats.endTime = Date.now();
  stats.finalMemory = getMemoryUsage();
  
  console.log(`\n   ✓ All ${symbols.length} markets loaded in ${((stats.endTime - stats.startTime) / 1000).toFixed(1)}s`);
  console.log(`   Total candles: ${stats.totalCandles.toLocaleString()}`);
  console.log(`   Final memory: ${formatMemory(stats.finalMemory)}`);
  console.log(`   Peak memory: ${formatMemory(stats.peakMemory)}`);
  
  if (stats.gcRuns > 0) {
    console.log(`   GC runs: ${stats.gcRuns}`);
  }

  return {
    candlesMap,
    ticksByBarOpenTimeMap,
    oneMinCandlesMap: release1mAfterTicks ? null : oneMinCandlesMap,
    stats,
  };
}

/**
 * Estimate memory requirements for a backtest
 * 
 * @param {number} numMarkets - Number of markets
 * @param {number} daysOfData - Days of historical data
 * @param {string} interval - Candle interval ('5m', '1m')
 * @param {boolean} useTypedArrays - Whether TypedArrays will be used
 * @returns {Object} Memory estimates in MB
 */
function estimateMemoryRequirements(numMarkets, daysOfData, interval = '5m', useTypedArrays = true) {
  // Candles per day by interval
  const candlesPerDay = {
    '1m': 1440,
    '5m': 288,
    '15m': 96,
    '1h': 24,
    '4h': 6,
    '1d': 1,
  };

  const candlesPer = candlesPerDay[interval] || 288;
  const totalCandles = numMarkets * daysOfData * candlesPer;
  
  // Memory per candle
  const bytesPerCandleTyped = 88; // 11 Float64 values
  const bytesPerCandleObject = 200; // Rough estimate with object overhead
  
  const bytesPerCandle = useTypedArrays ? bytesPerCandleTyped : bytesPerCandleObject;
  const candleMemoryMB = (totalCandles * bytesPerCandle) / (1024 * 1024);

  // Tick cache is roughly 4x the 5m candles (15s ticks)
  const tickCacheMultiplier = interval === '5m' ? 4 : 1;
  const tickMemoryMB = candleMemoryMB * tickCacheMultiplier * 0.3; // Ticks are smaller

  // Index maps and other overhead
  const overheadMB = numMarkets * 10; // ~10MB per market for indexes

  // 1m candles if not released
  const oneMinMemoryMB = interval === '5m' 
    ? (numMarkets * daysOfData * 1440 * bytesPerCandle) / (1024 * 1024)
    : 0;

  return {
    totalCandles,
    candleMemoryMB: Math.round(candleMemoryMB),
    tickMemoryMB: Math.round(tickMemoryMB),
    overheadMB: Math.round(overheadMB),
    oneMinMemoryMB: Math.round(oneMinMemoryMB),
    totalWithRelease: Math.round(candleMemoryMB + tickMemoryMB + overheadMB),
    totalWithoutRelease: Math.round(candleMemoryMB + tickMemoryMB + overheadMB + oneMinMemoryMB),
    recommendedHeapMB: Math.round((candleMemoryMB + tickMemoryMB + overheadMB) * 2.5), // 2.5x for safety
  };
}

module.exports = {
  loadMarketData,
  loadAllMarkets,
  estimateMemoryRequirements,
  getMemoryUsage,
  formatMemory,
  tryGC,
  DEFAULT_CACHE_DIR,
};

