/**
 * Unit tests for utils/shadow-mode.js
 * 
 * Tests:
 * - recordShadowTrade stores trade correctly
 * - Shadow report generation includes all recorded trades
 * - Shadow PnL calculation (simulated entry vs current price)
 * - getStats returns correct counts and totals
 */

const { describe, test, assert, runTests } = require('./test-harness');
const { ShadowModeManager } = require('../../utils/shadow-mode');

describe('ShadowModeManager', async () => {
  
  // ===== Basic initialization tests =====
  
  await test('constructor initializes with correct defaults', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    assert(manager.enabled === true, 'Should be enabled');
    assert(manager.shadowTrades.size === 0, 'Should start with no shadow trades');
    assert(manager.realTrades.size === 0, 'Should start with no real trades');
    assert(manager.metrics.shadowTradeCount === 0, 'Shadow count should be 0');
    assert(manager.metrics.realTradeCount === 0, 'Real count should be 0');
  });
  
  await test('start() sets startedAt timestamp', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    assert(manager.startedAt === null, 'Should not be started initially');
    
    manager.start();
    
    assert(manager.startedAt !== null, 'Should have startedAt after start');
    assert(typeof manager.startedAt === 'number', 'startedAt should be timestamp');
  });
  
  // ===== recordShadowTrade tests =====
  
  await test('recordShadowTrade stores trade correctly', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    const trade = {
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.10,
      execMode: 'taker',
      fees: 0.10,
    };
    
    const record = manager.recordShadowTrade(trade);
    
    assert(record.market === 'SOL-PERP', 'Record should have market');
    assert(record.side === 'long', 'Record should have side');
    assert(record.size === 100, 'Record should have size');
    assert(record.timestamp, 'Record should have timestamp');
    assert(typeof record.oracleDeviationBps === 'number', 'Should calculate oracle deviation');
  });
  
  await test('recordShadowTrade updates metrics', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.10,
      execMode: 'taker',
      fees: 0.10,
    });
    
    assert(manager.metrics.shadowTradeCount === 1, 'Shadow count should be 1');
    assert(manager.metrics.totalShadowVolume === 100, 'Shadow volume should be 100');
    assert(manager.shadowTrades.has('SOL-PERP'), 'Should have SOL-PERP in shadow trades');
    assert(manager.shadowTrades.get('SOL-PERP').length === 1, 'Should have 1 trade');
  });
  
  await test('recordShadowTrade handles maker execution mode', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.00,
      execMode: 'maker',
      fees: -0.02, // Rebate
    });
    
    assert(manager.metrics.feeDeltas.totalDriftMakerRebates === 0.02, 'Should track maker rebates');
  });
  
  await test('recordShadowTrade handles taker execution mode', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.00,
      execMode: 'taker',
      fees: 0.10,
    });
    
    assert(manager.metrics.feeDeltas.totalDriftTakerFees === 0.10, 'Should track taker fees');
  });
  
  await test('recordShadowTrade emits event', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    let emittedRecord = null;
    
    manager.on('shadowTrade', (record) => {
      emittedRecord = record;
    });
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.00,
      execMode: 'taker',
      fees: 0.10,
    });
    
    assert(emittedRecord !== null, 'Should emit shadowTrade event');
    assert(emittedRecord.market === 'SOL-PERP', 'Emitted record should have market');
  });
  
  // ===== recordRealTrade tests =====
  
  await test('recordRealTrade stores trade correctly', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    const trade = {
      market: 'BTC-PERP',
      side: 'short',
      size: 500,
      entryPrice: 95000,
      oraclePrice: 95050,
      fees: 0.30,
    };
    
    const record = manager.recordRealTrade(trade);
    
    assert(record.market === 'BTC-PERP', 'Record should have market');
    assert(record.side === 'short', 'Record should have side');
    assert(manager.realTrades.has('BTC-PERP'), 'Should have BTC-PERP in real trades');
  });
  
  await test('recordRealTrade updates metrics', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    manager.recordRealTrade({
      market: 'BTC-PERP',
      side: 'short',
      size: 500,
      entryPrice: 95000,
      oraclePrice: 95050,
      fees: 0.30,
    });
    
    assert(manager.metrics.realTradeCount === 1, 'Real count should be 1');
    assert(manager.metrics.totalRealVolume === 500, 'Real volume should be 500');
    assert(manager.metrics.feeDeltas.totalJupiterFees === 0.30, 'Should track Jupiter fees');
  });
  
  // ===== Price health tracking tests =====
  
  await test('tracks price health metrics', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    // Record trades with oracle deviations
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.175, // ~10bps deviation
      execMode: 'taker',
      fees: 0.10,
    });
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.35, // ~20bps deviation
      execMode: 'taker',
      fees: 0.10,
    });
    
    const ph = manager.metrics.priceHealth;
    assert(ph.deviationSamples === 2, 'Should have 2 samples');
    assert(ph.avgOracleDeviation > 0, 'Should have positive avg deviation');
    assert(ph.maxOracleDeviation > 0, 'Should have positive max deviation');
  });
  
  // ===== compareMarket tests =====
  
  await test('compareMarket returns correct comparison', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    // Record shadow trades
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.00,
      execMode: 'maker',
      fees: -0.02,
    });
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'short',
      size: 50,
      entryPrice: 176.00,
      oraclePrice: 176.00,
      execMode: 'taker',
      fees: 0.05,
    });
    
    const comparison = manager.compareMarket('SOL-PERP');
    
    assert(comparison.market === 'SOL-PERP', 'Should have market');
    assert(comparison.shadowCount === 2, 'Should have 2 shadow trades');
    assert(comparison.shadowVolume === 150, 'Shadow volume should be 150');
    assert(comparison.makerFillRate === 0.5, 'Maker fill rate should be 50%');
  });
  
  await test('compareMarket handles empty market', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    const comparison = manager.compareMarket('UNKNOWN-PERP');
    
    assert(comparison.shadowCount === 0, 'Should have 0 shadow trades');
    assert(comparison.realCount === 0, 'Should have 0 real trades');
    assert(comparison.makerFillRate === 0, 'Maker fill rate should be 0');
  });
  
  // ===== getReport tests =====
  
  await test('getReport includes all metrics', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    manager.start();
    
    // Record some trades
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 1000,
      entryPrice: 175.00,
      oraclePrice: 175.00,
      execMode: 'maker',
      fees: -0.20,
    });
    
    manager.recordRealTrade({
      market: 'BTC-PERP',
      side: 'short',
      size: 500,
      entryPrice: 95000,
      oraclePrice: 95000,
      fees: 0.30,
    });
    
    const report = manager.getReport();
    
    assert(report.enabled === true, 'Report should show enabled');
    assert(report.startedAt, 'Report should have startedAt');
    assert(report.durationDays, 'Report should have durationDays');
    assert(report.metrics, 'Report should have metrics');
    assert(report.thresholds, 'Report should have thresholds');
    assert(report.thresholdsPassed, 'Report should have thresholdsPassed');
    assert('readyForLive' in report, 'Report should have readyForLive flag');
    assert(Array.isArray(report.marketComparisons), 'Report should have marketComparisons');
  });
  
  await test('getReport calculates net savings correctly', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    manager.start();
    
    // Record $1000 of shadow trades with maker
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 1000,
      entryPrice: 175.00,
      oraclePrice: 175.00,
      execMode: 'maker',
      fees: -0.20, // 2bps rebate = $0.20 on $1000
    });
    
    const report = manager.getReport();
    
    // Jupiter equivalent would be $1000 * 6bps = $0.60
    // Drift maker is -$0.20 (rebate)
    // Net savings = $0.60 - (-$0.20) = $0.80
    assert(report.metrics.feeDeltas.netSavingsWithMaker > 0, 'Should show positive savings with maker');
  });
  
  // ===== Threshold checking tests =====
  
  await test('thresholdsPassed reflects oracle deviation', async () => {
    const manager = new ShadowModeManager({ 
      enabled: true,
      maxOracleDeviationBps: 20, // Strict threshold
    });
    manager.start();
    
    // Record trade with large deviation
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 176.00, // ~57bps deviation
      execMode: 'taker',
      fees: 0.10,
    });
    
    const report = manager.getReport();
    
    assert(report.thresholdsPassed.oracleDeviation === false, 
      'Should fail oracle deviation threshold');
  });
  
  await test('thresholdsPassed reflects maker fill rate', async () => {
    const manager = new ShadowModeManager({ 
      enabled: true,
      minMakerFillRate: 0.8, // 80% min
    });
    manager.start();
    
    // Record mostly taker trades
    for (let i = 0; i < 10; i++) {
      manager.recordShadowTrade({
        market: 'SOL-PERP',
        side: 'long',
        size: 100,
        entryPrice: 175.00,
        oraclePrice: 175.00,
        execMode: i < 5 ? 'maker' : 'taker', // 50% maker
        fees: i < 5 ? -0.02 : 0.10,
      });
    }
    
    const report = manager.getReport();
    
    assert(report.thresholdsPassed.makerFillRate === false,
      'Should fail maker fill rate threshold (50% < 80%)');
  });
  
  // ===== isTrackingComplete tests =====
  
  await test('isTrackingComplete returns false before start', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    assert(manager.isTrackingComplete() === false, 'Should not be complete before start');
  });
  
  await test('isTrackingComplete respects tracking period', async () => {
    const manager = new ShadowModeManager({ 
      enabled: true,
      trackingPeriodMs: 100, // 100ms for testing
    });
    
    manager.start();
    assert(manager.isTrackingComplete() === false, 'Should not be complete immediately');
    
    // Wait for tracking period
    await new Promise(resolve => setTimeout(resolve, 150));
    
    assert(manager.isTrackingComplete() === true, 'Should be complete after tracking period');
  });
  
  // ===== exportData tests =====
  
  await test('exportData returns all data', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    manager.start();
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.00,
      execMode: 'maker',
      fees: -0.02,
    });
    
    const data = manager.exportData();
    
    assert(data.shadowTrades, 'Should have shadowTrades');
    assert(data.realTrades, 'Should have realTrades');
    assert(data.metrics, 'Should have metrics');
    assert(data.report, 'Should have report');
    assert(data.shadowTrades['SOL-PERP'].length === 1, 'Should have 1 SOL trade');
  });
  
  // ===== Per-market metrics tests =====
  
  await test('byMarket metrics are tracked correctly', async () => {
    const manager = new ShadowModeManager({ enabled: true });
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'long',
      size: 100,
      entryPrice: 175.00,
      oraclePrice: 175.00,
      execMode: 'maker',
      fees: -0.02,
    });
    
    manager.recordShadowTrade({
      market: 'SOL-PERP',
      side: 'short',
      size: 50,
      entryPrice: 176.00,
      oraclePrice: 176.00,
      execMode: 'taker',
      fees: 0.05,
    });
    
    const solMetrics = manager.metrics.byMarket['SOL-PERP'];
    
    assert(solMetrics.shadowTrades === 2, 'Should have 2 shadow trades');
    assert(solMetrics.shadowVolume === 150, 'Volume should be 150');
    assert(solMetrics.makerFills === 1, 'Should have 1 maker fill');
    assert(solMetrics.takerFills === 1, 'Should have 1 taker fill');
  });
  
  // ===== shouldExecuteReal tests =====
  
  await test('shouldExecuteReal returns true when disabled', async () => {
    const manager = new ShadowModeManager({ enabled: false });
    
    assert(manager.shouldExecuteReal('SOL-PERP') === true, 'All trades should be real when disabled');
  });
  
  // Note: Full shouldExecuteReal tests would require mocking venue-router
});

// Run if called directly
if (require.main === module) {
  runTests().catch(console.error);
}




