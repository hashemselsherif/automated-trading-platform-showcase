/**
 * Unit Tests: VenueAwareTradeExecutor
 * 
 * Tests the multi-venue trade dispatch to Jupiter and Drift
 */

const { test, assertEqual, assert, assertThrows, runTests, skip } = require('./test-harness');

// Mock clients
class MockJupiterClient {
  constructor() {
    this.openCalls = [];
    this.closeCalls = [];
    this.shouldFail = false;
    this.positions = [];
  }
  
  async openPosition(side, collateral, leverage, price, orderId, market) {
    this.openCalls.push({ side, collateral, leverage, price, orderId, market });
    if (this.shouldFail) throw new Error('Jupiter mock error');
    return {
      positionId: `jup-${Date.now()}`,
      clientOrderId: orderId,
      market,
      side,
      collateral,
      leverage,
      entryPrice: price,
      size: collateral * leverage,
    };
  }
  
  async closePosition(position, price) {
    this.closeCalls.push({ position, price });
    if (this.shouldFail) throw new Error('Jupiter close mock error');
    return { pnl: 10, signature: 'mock-sig' };
  }
  
  async getAllOpenPositions() {
    return this.positions;
  }
}

class MockDriftClient {
  constructor() {
    this.openCalls = [];
    this.closeCalls = [];
    this.shouldFail = false;
    this.initialized = false;
    this.positions = [];
  }
  
  async initialize() {
    this.initialized = true;
  }
  
  async openPosition(side, collateral, leverage, price, orderId, options) {
    this.openCalls.push({ side, collateral, leverage, price, orderId, options });
    if (this.shouldFail) throw new Error('Drift mock error');
    return {
      positionId: `drift-${Date.now()}`,
      clientOrderId: orderId,
      market: options?.market,
      side,
      collateral,
      leverage,
      entryPrice: price,
      size: collateral * leverage,
    };
  }
  
  async closePosition(position, price, options) {
    this.closeCalls.push({ position, price, options });
    if (this.shouldFail) throw new Error('Drift close mock error');
    return { pnl: 15, execMode: 'maker' };
  }
  
  async getAllOpenPositions() {
    return this.positions;
  }
}

class MockLimitedLiveController {
  constructor() {
    this.state = 'limited_live';
    this.allowedMarkets = new Set(['JTO-PERP', 'APT-PERP']);
    this.trades = [];
  }
  
  canOpenPosition(market, size) {
    if (this.state === 'shadow_only') {
      return { allowed: false, reason: 'State is shadow_only' };
    }
    if (!this.allowedMarkets.has(market)) {
      return { allowed: false, reason: `Market ${market} not in enabled list` };
    }
    return { allowed: true };
  }
  
  recordTrade(trade) {
    this.trades.push(trade);
  }
}

class MockShadowManager {
  constructor() {
    this.enabled = false;
    this.shadowTrades = [];
  }
  
  recordShadowTrade(trade) {
    this.shadowTrades.push(trade);
    return trade;
  }
}

// Tests
test('VenueAwareTradeExecutor constructor requires jupiter client', () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  let error = null;
  try {
    new VenueAwareTradeExecutor({});
  } catch (e) {
    error = e;
  }
  assert(error !== null, 'Should throw error');
  assert(error.message.includes('Jupiter'), 'Error should mention Jupiter');
});

test('VenueAwareTradeExecutor initializes with jupiter only', () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    logger: { log: () => {}, error: () => {} },
  });
  
  assert(executor !== null, 'Executor should be created');
  assertEqual(executor.driftClient, null, 'Drift should be null');
});

test('VenueAwareTradeExecutor initializes with both clients', () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    logger: { log: () => {}, error: () => {} },
  });
  
  assert(executor.driftClient !== null, 'Drift should be set');
});

test('routes SOL-PERP to Jupiter', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    logger: { log: () => {}, error: () => {} },
  });
  
  await executor.openPosition('long', 100, 5, 200.0, 'test-order', 'SOL-PERP');
  
  assertEqual(jupiter.openCalls.length, 1, 'Jupiter should be called');
  assertEqual(drift.openCalls.length, 0, 'Drift should not be called');
  assertEqual(jupiter.openCalls[0].market, 'SOL-PERP', 'Market should be SOL-PERP');
});

test('routes BTC-PERP to Jupiter', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    logger: { log: () => {}, error: () => {} },
  });
  
  await executor.openPosition('short', 50, 10, 100000.0, 'btc-order', 'BTC-PERP');
  
  assertEqual(jupiter.openCalls.length, 1, 'Jupiter should be called for BTC');
  assertEqual(drift.openCalls.length, 0, 'Drift should not be called');
});

test('routes JTO-PERP to Drift with limited-live gate', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  const limitedLive = new MockLimitedLiveController();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    limitedLiveController: limitedLive,
    logger: { log: () => {}, error: () => {} },
  });
  
  await executor.openPosition('long', 100, 5, 4.0, 'jto-order', 'JTO-PERP');
  
  assertEqual(jupiter.openCalls.length, 0, 'Jupiter should not be called');
  assertEqual(drift.openCalls.length, 1, 'Drift should be called');
  assertEqual(drift.openCalls[0].options.market, 'JTO-PERP', 'Market should be JTO-PERP');
});

test('blocks Drift when limited-live state is shadow_only', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  const limitedLive = new MockLimitedLiveController();
  limitedLive.state = 'shadow_only';
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    limitedLiveController: limitedLive,
    logger: { log: () => {}, error: () => {} },
  });
  
  let error = null;
  try {
    await executor.openPosition('long', 100, 5, 4.0, 'jto-order', 'JTO-PERP');
  } catch (e) {
    error = e;
  }
  
  assert(error !== null, 'Should throw error');
  assert(error.message.includes('blocked'), 'Error should mention blocked');
  assertEqual(drift.openCalls.length, 0, 'Drift should not be called');
});

test('blocks Drift for non-allowed market in limited_live', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  const limitedLive = new MockLimitedLiveController();
  limitedLive.allowedMarkets = new Set(['JTO-PERP']); // DOGE not allowed
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    limitedLiveController: limitedLive,
    logger: { log: () => {}, error: () => {} },
  });
  
  let error = null;
  try {
    await executor.openPosition('long', 100, 5, 0.10, 'doge-order', 'DOGE-PERP');
  } catch (e) {
    error = e;
  }
  
  assert(error !== null, 'Should throw error for non-allowed market');
});

test('records shadow trade when blocked and shadow enabled', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  const limitedLive = new MockLimitedLiveController();
  limitedLive.state = 'shadow_only';
  const shadow = new MockShadowManager();
  shadow.enabled = true;
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    limitedLiveController: limitedLive,
    shadowManager: shadow,
    logger: { log: () => {}, error: () => {} },
  });
  
  try {
    await executor.openPosition('long', 100, 5, 4.0, 'jto-order', 'JTO-PERP');
  } catch (e) {
    // Expected
  }
  
  assertEqual(shadow.shadowTrades.length, 1, 'Shadow trade should be recorded');
  assertEqual(shadow.shadowTrades[0].market, 'JTO-PERP', 'Shadow market should be JTO-PERP');
});

test('getStats returns correct structure', () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    logger: { log: () => {}, error: () => {} },
  });
  
  const stats = executor.getStats();
  
  assert('jupiterOpens' in stats, 'Stats should have jupiterOpens');
  assert('driftOpens' in stats, 'Stats should have driftOpens');
  assert('shadowTrades' in stats, 'Stats should have shadowTrades');
  assert('blockedByGate' in stats, 'Stats should have blockedByGate');
});

test('closePosition routes to Jupiter for Jupiter position', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    logger: { log: () => {}, error: () => {} },
  });
  
  const position = {
    positionId: 'test-pos',
    market: 'SOL-PERP',
    venue: 'jupiter',
  };
  
  await executor.closePosition(position, 210.0);
  
  assertEqual(jupiter.closeCalls.length, 1, 'Jupiter close should be called');
  assertEqual(drift.closeCalls.length, 0, 'Drift close should not be called');
});

test('closePosition routes to Drift for Drift position', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  const drift = new MockDriftClient();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    logger: { log: () => {}, error: () => {} },
  });
  
  const position = {
    positionId: 'test-drift-pos',
    market: 'JTO-PERP',
    venue: 'drift',
  };
  
  await executor.closePosition(position, 4.50);
  
  assertEqual(jupiter.closeCalls.length, 0, 'Jupiter close should not be called');
  assertEqual(drift.closeCalls.length, 1, 'Drift close should be called');
});

test('getAllOpenPositions aggregates from both venues', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  jupiter.positions = [{ market: 'SOL-PERP', side: 'long' }];
  const drift = new MockDriftClient();
  drift.positions = [{ market: 'JTO-PERP', side: 'short' }];
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    driftClient: drift,
    logger: { log: () => {}, error: () => {} },
  });
  
  const positions = await executor.getAllOpenPositions();
  
  assertEqual(positions.length, 2, 'Should have positions from both venues');
  assert(positions.some(p => p.market === 'SOL-PERP'), 'Should have SOL position');
  assert(positions.some(p => p.market === 'JTO-PERP'), 'Should have JTO position');
});

test('tracks position venue mapping', async () => {
  const VenueAwareTradeExecutor = require('../../src/execution/venue-aware-trade-executor');
  const jupiter = new MockJupiterClient();
  
  const executor = new VenueAwareTradeExecutor({
    jupiterClient: jupiter,
    logger: { log: () => {}, error: () => {} },
  });
  
  const pos = await executor.openPosition('long', 100, 5, 200.0, 'track-test', 'SOL-PERP');
  
  assertEqual(pos.venue, 'jupiter', 'Position should have venue tag');
  assertEqual(executor.positionVenueMap.get(pos.positionId), 'jupiter', 'Venue map should track position');
});

// Run tests
if (require.main === module) {
  runTests();
}

module.exports = { runTests };

