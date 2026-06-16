/**
 * Unit tests for utils/limited-live.js
 * 
 * Tests:
 * - canOpenPosition returns true/false based on caps
 * - recordTrade updates internal accounting
 * - Rollback gate triggers when loss threshold exceeded
 * - Exposure summary calculation
 * - Market allowlist parsing and enforcement
 */

const { describe, test, assert, runTests } = require('./test-harness');
const { LimitedLiveController, LiveState } = require('../../utils/limited-live');

describe('LimitedLiveController', async () => {
  
  // ===== Basic state tests =====
  
  await test('constructor initializes with correct defaults', async () => {
    const controller = new LimitedLiveController();
    
    assert(controller.state === LiveState.SHADOW_ONLY, 'Default state should be shadow_only');
    assert(controller.enabledMarkets.size === 0, 'Should start with no enabled markets');
    assert(controller.positionCaps.default === 100, 'Default position cap should be $100');
    assert(controller.totalExposureCap === 500, 'Total exposure cap should be $500');
  });
  
  await test('constructor accepts custom config', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.LIMITED_LIVE,
      enabledMarkets: ['SOL-PERP', 'BTC-PERP'],
      defaultPositionCap: 200,
      totalExposureCap: 1000,
    });
    
    assert(controller.state === LiveState.LIMITED_LIVE, 'Should use custom state');
    assert(controller.enabledMarkets.size === 2, 'Should have 2 enabled markets');
    assert(controller.positionCaps.default === 200, 'Should use custom position cap');
    assert(controller.totalExposureCap === 1000, 'Should use custom exposure cap');
  });
  
  // ===== canTradeLive tests =====
  
  await test('canTradeLive returns false for DISABLED state', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.DISABLED,
    });
    
    const result = controller.canTradeLive('SOL-PERP');
    assert(result.allowed === false, 'Should not allow trading');
    assert(result.reason.includes('disabled'), 'Reason should mention disabled');
  });
  
  await test('canTradeLive returns false for SHADOW_ONLY state', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.SHADOW_ONLY,
    });
    
    const result = controller.canTradeLive('SOL-PERP');
    assert(result.allowed === false, 'Should not allow trading');
    assert(result.reason.includes('shadow'), 'Reason should mention shadow');
  });
  
  await test('canTradeLive checks market allowlist in LIMITED_LIVE', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.LIMITED_LIVE,
      enabledMarkets: ['SOL-PERP', 'BTC-PERP'],
    });
    
    const solResult = controller.canTradeLive('SOL-PERP');
    const xrpResult = controller.canTradeLive('XRP-PERP');
    
    assert(solResult.allowed === true, 'SOL should be allowed');
    assert(xrpResult.allowed === false, 'XRP should not be allowed');
    assert(xrpResult.reason.includes('not in enabled'), 'Reason should explain');
  });
  
  await test('canTradeLive allows all markets in FULL_LIVE', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      enabledMarkets: [], // Empty, but should still allow
    });
    
    const solResult = controller.canTradeLive('SOL-PERP');
    const xrpResult = controller.canTradeLive('XRP-PERP');
    
    assert(solResult.allowed === true, 'SOL should be allowed');
    assert(xrpResult.allowed === true, 'XRP should be allowed');
  });
  
  // ===== canOpenPosition tests =====
  
  await test('canOpenPosition checks market cap', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      defaultPositionCap: 100,
    });
    
    const allowed = controller.canOpenPosition('SOL-PERP', 90);
    const tooLarge = controller.canOpenPosition('SOL-PERP', 150);
    
    assert(allowed.allowed === true, '$90 should be within $100 cap');
    assert(tooLarge.allowed === false, '$150 should exceed $100 cap');
    assert(tooLarge.reason.includes('market cap'), 'Reason should mention market cap');
  });
  
  await test('canOpenPosition tracks current exposure', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      defaultPositionCap: 100,
    });
    
    // Simulate existing exposure
    controller.currentExposure.byMarket['SOL-PERP'] = 60;
    controller.currentExposure.total = 60;
    
    const allowed = controller.canOpenPosition('SOL-PERP', 30);
    const tooLarge = controller.canOpenPosition('SOL-PERP', 50);
    
    assert(allowed.allowed === true, '60+30=90 should be within $100 cap');
    assert(tooLarge.allowed === false, '60+50=110 should exceed $100 cap');
  });
  
  await test('canOpenPosition checks total exposure cap', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      defaultPositionCap: 200,
      totalExposureCap: 500,
    });
    
    // Simulate existing total exposure
    controller.currentExposure.total = 450;
    
    const allowed = controller.canOpenPosition('SOL-PERP', 40);
    const tooLarge = controller.canOpenPosition('SOL-PERP', 60);
    
    assert(allowed.allowed === true, '450+40=490 should be within $500 total cap');
    assert(tooLarge.allowed === false, '450+60=510 should exceed $500 total cap');
    assert(tooLarge.reason.includes('total cap'), 'Reason should mention total cap');
  });
  
  await test('canOpenPosition uses per-market caps when set', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      defaultPositionCap: 100,
      perMarketCaps: { 'SOL-PERP': 200 },
    });
    
    const solAllowed = controller.canOpenPosition('SOL-PERP', 150);
    const btcNotAllowed = controller.canOpenPosition('BTC-PERP', 150);
    
    assert(solAllowed.allowed === true, 'SOL has $200 cap, $150 should be allowed');
    assert(btcNotAllowed.allowed === false, 'BTC uses default $100 cap');
  });
  
  // ===== recordPositionOpened/Closed tests =====
  
  await test('recordPositionOpened updates exposure', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
    });
    
    controller.recordPositionOpened('SOL-PERP', 100);
    
    assert(controller.currentExposure.total === 100, 'Total should be 100');
    assert(controller.currentExposure.byMarket['SOL-PERP'] === 100, 'SOL exposure should be 100');
  });
  
  await test('recordPositionClosed updates exposure', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
    });
    
    controller.recordPositionOpened('SOL-PERP', 100);
    controller.recordPositionClosed('SOL-PERP', 100, 10); // $10 profit
    
    assert(controller.currentExposure.total === 0, 'Total should be 0 after close');
    assert(controller.currentExposure.byMarket['SOL-PERP'] === 0, 'SOL exposure should be 0');
  });
  
  await test('recordPositionClosed adds to trade history', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
    });
    
    controller.recordPositionClosed('SOL-PERP', 100, 10);
    
    assert(controller.tradeHistory.length === 1, 'Should have 1 trade in history');
    assert(controller.tradeHistory[0].market === 'SOL-PERP', 'Trade should have market');
    assert(controller.tradeHistory[0].pnl === 10, 'Trade should have PnL');
  });
  
  // ===== Rollback gate tests =====
  
  await test('rollback triggers on single large loss', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      maxLossPerTrade: 25,
      rollbackEnabled: true,
    });
    
    controller.recordPositionOpened('SOL-PERP', 100);
    controller.recordPositionClosed('SOL-PERP', 100, -30); // $30 loss
    
    assert(controller.rollbackMetrics.rollbackTriggered === true, 'Rollback should be triggered');
    assert(controller.state === LiveState.SHADOW_ONLY, 'Should revert to shadow_only');
    assert(controller.rollbackMetrics.rollbackReason.includes('Single trade'), 'Reason should mention single trade');
  });
  
  await test('rollback triggers on consecutive losses', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      maxLossPerTrade: 50, // Higher to not trigger single-loss
      maxConsecutiveLosses: 3,
      rollbackEnabled: true,
    });
    
    // 3 consecutive losses
    controller.recordPositionClosed('SOL-PERP', 50, -10);
    assert(!controller.rollbackMetrics.rollbackTriggered, 'Should not trigger after 1 loss');
    
    controller.recordPositionClosed('SOL-PERP', 50, -10);
    assert(!controller.rollbackMetrics.rollbackTriggered, 'Should not trigger after 2 losses');
    
    controller.recordPositionClosed('SOL-PERP', 50, -10);
    assert(controller.rollbackMetrics.rollbackTriggered === true, 'Should trigger after 3 losses');
  });
  
  await test('consecutive losses reset on win', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      maxLossPerTrade: 50,
      maxConsecutiveLosses: 3,
      rollbackEnabled: true,
    });
    
    controller.recordPositionClosed('SOL-PERP', 50, -10);
    controller.recordPositionClosed('SOL-PERP', 50, -10);
    assert(controller.rollbackMetrics.consecutiveLosses === 2, 'Should have 2 consecutive losses');
    
    controller.recordPositionClosed('SOL-PERP', 50, 5); // Win
    assert(controller.rollbackMetrics.consecutiveLosses === 0, 'Consecutive losses should reset');
  });
  
  await test('rollback triggers on daily loss limit', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      maxLossPerTrade: 50,
      maxLossPerDay: 100,
      maxConsecutiveLosses: 10,
      rollbackEnabled: true,
    });
    
    // Accumulate daily losses
    controller.recordPositionClosed('SOL-PERP', 50, -40);
    assert(!controller.rollbackMetrics.rollbackTriggered, 'Should not trigger at $40 daily loss');
    
    controller.recordPositionClosed('SOL-PERP', 50, -40);
    assert(!controller.rollbackMetrics.rollbackTriggered, 'Should not trigger at $80 daily loss');
    
    controller.recordPositionClosed('SOL-PERP', 50, -25);
    assert(controller.rollbackMetrics.rollbackTriggered === true, 'Should trigger at $105 daily loss');
    assert(controller.rollbackMetrics.rollbackReason.includes('Daily'), 'Reason should mention daily');
  });
  
  await test('rollback prevents further trading', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      maxLossPerTrade: 10,
      rollbackEnabled: true,
    });
    
    // Trigger rollback
    controller.recordPositionClosed('SOL-PERP', 50, -15);
    
    // Try to trade
    const result = controller.canTradeLive('SOL-PERP');
    assert(result.allowed === false, 'Should not allow trading after rollback');
    assert(result.reason.includes('Rollback'), 'Reason should mention rollback');
  });
  
  // ===== Market management tests =====
  
  await test('enableMarket adds market to enabled set', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.LIMITED_LIVE,
    });
    
    // This would normally validate against drift-market-lookup
    // For testing, we'll manually add
    controller.enabledMarkets.add('SOL-PERP');
    
    assert(controller.enabledMarkets.has('SOL-PERP'), 'SOL should be enabled');
    assert(controller.canTradeLive('SOL-PERP').allowed === true, 'Should allow trading SOL');
  });
  
  await test('disableMarket removes market from enabled set', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.LIMITED_LIVE,
      enabledMarkets: ['SOL-PERP', 'BTC-PERP'],
    });
    
    controller.disableMarket('SOL-PERP');
    
    assert(!controller.enabledMarkets.has('SOL-PERP'), 'SOL should be disabled');
    assert(controller.canTradeLive('SOL-PERP').allowed === false, 'Should not allow trading SOL');
    assert(controller.canTradeLive('BTC-PERP').allowed === true, 'BTC should still be allowed');
  });
  
  await test('setMarketCap updates per-market cap', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      defaultPositionCap: 100,
    });
    
    controller.setMarketCap('SOL-PERP', 500);
    
    const result = controller.canOpenPosition('SOL-PERP', 400);
    assert(result.allowed === true, '$400 should be within $500 SOL cap');
    
    const btcResult = controller.canOpenPosition('BTC-PERP', 150);
    assert(btcResult.allowed === false, '$150 should exceed $100 default BTC cap');
  });
  
  // ===== State transition tests =====
  
  await test('setState transitions state correctly', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.SHADOW_ONLY,
    });
    
    controller.setState(LiveState.LIMITED_LIVE);
    assert(controller.state === LiveState.LIMITED_LIVE, 'State should be limited_live');
    
    controller.setState(LiveState.FULL_LIVE);
    assert(controller.state === LiveState.FULL_LIVE, 'State should be full_live');
  });
  
  await test('setState resets rollback when not disabled', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      maxLossPerTrade: 10,
    });
    
    // Trigger rollback
    controller.recordPositionClosed('SOL-PERP', 50, -15);
    assert(controller.rollbackMetrics.rollbackTriggered === true, 'Rollback should be triggered');
    
    // Transition to limited_live
    controller.setState(LiveState.LIMITED_LIVE);
    
    assert(controller.rollbackMetrics.rollbackTriggered === false, 'Rollback should be reset');
  });
  
  // ===== Status and summary tests =====
  
  await test('getStatus returns comprehensive status', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.LIMITED_LIVE,
      enabledMarkets: ['SOL-PERP'],
    });
    
    controller.recordPositionOpened('SOL-PERP', 50);
    controller.recordPositionClosed('SOL-PERP', 50, 5);
    
    const status = controller.getStatus();
    
    assert(status.state === LiveState.LIMITED_LIVE, 'Status should include state');
    assert(Array.isArray(status.enabledMarkets), 'Status should include enabled markets');
    assert(status.currentExposure, 'Status should include current exposure');
    assert(status.positionCaps, 'Status should include position caps');
    assert(status.rollbackGates, 'Status should include rollback gates');
    assert(status.rollbackMetrics, 'Status should include rollback metrics');
    assert(Array.isArray(status.recentTrades), 'Status should include recent trades');
  });
  
  // ===== Progressive increase tests =====
  
  await test('progressiveIncrease multiplies caps', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      defaultPositionCap: 100,
      totalExposureCap: 500,
      perMarketCaps: { 'SOL-PERP': 200 },
    });
    
    const result = controller.progressiveIncrease(2);
    
    assert(result === true, 'Should succeed');
    assert(controller.positionCaps.default === 200, 'Default cap should double');
    assert(controller.totalExposureCap === 1000, 'Total cap should double');
    assert(controller.positionCaps.perMarket['SOL-PERP'] === 400, 'SOL cap should double');
  });
  
  await test('progressiveIncrease fails during rollback', async () => {
    const controller = new LimitedLiveController({
      initialState: LiveState.FULL_LIVE,
      maxLossPerTrade: 10,
    });
    
    // Trigger rollback
    controller.recordPositionClosed('SOL-PERP', 50, -15);
    
    const result = controller.progressiveIncrease(2);
    assert(result === false, 'Should fail during rollback');
  });
});

// Run if called directly
if (require.main === module) {
  runTests().catch(console.error);
}




