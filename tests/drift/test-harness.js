/**
 * Drift Unit Test Harness
 *
 * Provides utilities for testing Drift integration:
 * - Mock subprocess responses
 * - Test fixtures for market data
 * - State machine testing helpers
 * - Assertion utilities
 */

// Test result tracking
const testResults = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
};

/**
 * Mock wallet for testing
 */
const mockWallet = {
  publicKey: {
    toBase58: () => 'MockPublicKey123456789',
    toString: () => 'MockPublicKey123456789',
  },
  signTransaction: async (tx) => tx,
  signAllTransactions: async (txs) => txs,
};

/**
 * Create a mock subprocess client
 */
function createMockSubprocess(responses = {}) {
  const defaultResponses = {
    init: { sdkLoaded: true },
    getPerpMarkets: { markets: mockMarkets, count: mockMarkets.length },
    getMarketIndexMap: { indexMap: mockMarketIndexMap },
    getOraclePrice: { price: 100.00, marketIndex: 0 },
    placeMarketOrder: { orderId: `mock-market-${Date.now()}`, status: 'simulated' },
    placeLimitOrder: { orderId: `mock-limit-${Date.now()}`, status: 'simulated' },
    cancelOrder: { cancelled: true },
    cancelAllOrders: { cancelledCount: 0 },
    getPositions: { positions: [] },
    getFeeInfo: { feeTiers: mockFeeTiers },
  };

  const allResponses = { ...defaultResponses, ...responses };

  return {
    start: async () => {},
    stop: async () => {},
    send: async (action, params) => {
      if (typeof allResponses[action] === 'function') {
        return allResponses[action](params);
      }
      return allResponses[action] || { error: `Unknown action: ${action}` };
    },
  };
}

/**
 * Mock market data
 */
const mockMarkets = [
  { symbol: 'SOL-PERP', marketIndex: 0, oracle: 'SolOraclePubkey', category: 'majors' },
  { symbol: 'BTC-PERP', marketIndex: 1, oracle: 'BtcOraclePubkey', category: 'majors' },
  { symbol: 'ETH-PERP', marketIndex: 2, oracle: 'EthOraclePubkey', category: 'majors' },
  { symbol: 'APT-PERP', marketIndex: 24, oracle: 'AptOraclePubkey', category: 'altcoins' },
  { symbol: 'SUI-PERP', marketIndex: 25, oracle: 'SuiOraclePubkey', category: 'altcoins' },
  { symbol: 'HNT-PERP', marketIndex: 34, oracle: 'HntOraclePubkey', category: 'altcoins' },
  { symbol: 'XRP-PERP', marketIndex: 46, oracle: 'XrpOraclePubkey', category: 'altcoins' },
  { symbol: 'DOGE-PERP', marketIndex: 15, oracle: 'DogeOraclePubkey', category: 'memecoins' },
  { symbol: '1MBONK-PERP', marketIndex: 23, oracle: 'BonkOraclePubkey', category: 'memecoins' },
];

const mockMarketIndexMap = {
  'SOL-PERP': 0, 'SOL': 0,
  'BTC-PERP': 1, 'BTC': 1,
  'ETH-PERP': 2, 'ETH': 2,
  'APT-PERP': 24, 'APT': 24,
  'SUI-PERP': 25, 'SUI': 25,
  'HNT-PERP': 34, 'HNT': 34,
  'XRP-PERP': 46, 'XRP': 46,
  'DOGE-PERP': 15, 'DOGE': 15,
  '1MBONK-PERP': 23, '1MBONK': 23,
};

/**
 * Mock fee tiers (Drift documentation)
 */
const mockFeeTiers = {
  rookie: { taker: 10, maker: -2 },   // 10bps taker, -2bps rebate
  bronze: { taker: 8, maker: -2 },
  silver: { taker: 6, maker: -2 },
  gold: { taker: 4, maker: -3 },
  platinum: { taker: 3, maker: -3 },
  vip: { taker: 2, maker: -4 },
};

/**
 * Mock position data
 */
function createMockPosition(overrides = {}) {
  return {
    positionId: `pos-${Date.now()}`,
    clientOrderId: null,
    market: 'SOL-PERP',
    marketIndex: 0,
    side: 'long',
    collateral: 100,
    leverage: 5,
    size: 500,
    baseSize: 2.5,
    entryPrice: 200.00,
    openTime: Date.now(),
    liquidationPrice: 160.00,
    execMode: 'taker',
    paper: true,
    ...overrides,
  };
}

/**
 * Test assertion utilities
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}. ${message}`);
  }
}

function assertClose(actual, expected, tolerance = 0.01, message = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`Expected ~${expected} (±${tolerance}), got ${actual}. ${message}`);
  }
}

function assertThrows(fn, expectedError = null, message = '') {
  let threw = false;
  let actualError = null;
  try {
    fn();
  } catch (e) {
    threw = true;
    actualError = e;
  }
  if (!threw) {
    throw new Error(`Expected function to throw. ${message}`);
  }
  if (expectedError && !actualError.message.includes(expectedError)) {
    throw new Error(`Expected error containing "${expectedError}", got "${actualError.message}"`);
  }
}

async function assertThrowsAsync(fn, expectedError = null, message = '') {
  let threw = false;
  let actualError = null;
  try {
    await fn();
  } catch (e) {
    threw = true;
    actualError = e;
  }
  if (!threw) {
    throw new Error(`Expected async function to throw. ${message}`);
  }
  if (expectedError && !actualError.message.includes(expectedError)) {
    throw new Error(`Expected error containing "${expectedError}", got "${actualError.message}"`);
  }
}

/**
 * Test runner - collects tests then runs them
 */
const pendingTests = [];
let currentSuite = null;
let beforeAllFn = null;
let afterAllFn = null;

async function describe(suiteName, fn) {
  currentSuite = suiteName;
  beforeAllFn = null;
  afterAllFn = null;

  // Run the describe block (may be async)
  await fn();

  currentSuite = null;
  beforeAllFn = null;
  afterAllFn = null;
}

function beforeAll(fn) {
  beforeAllFn = fn;
}

function afterAll(fn) {
  afterAllFn = fn;
}

async function test(name, fn) {
  // If we're collecting tests for batch run, just push
  // Otherwise run immediately (for new describe(async) pattern)
  const t = { name, fn, suite: currentSuite };

  // Run beforeAll if defined and this is the first test in suite
  const suite = currentSuite;
  const isFirstInSuite = !pendingTests.some(p => p.suite === suite);

  if (isFirstInSuite && beforeAllFn) {
    try {
      await beforeAllFn();
    } catch (e) {
      console.error(`  ⚠️  beforeAll failed: ${e.message}`);
    }
  }

  // Run the test immediately
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    testResults.passed++;
    testResults.tests.push({ name, status: 'passed' });
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    testResults.failed++;
    testResults.tests.push({ name, status: 'failed', error: e.message });
  }

  // Also push to pending for compatibility
  pendingTests.push(t);
}

function skip(name, _fn) {
  console.log(`  ⏭️  ${name} (skipped)`);
  testResults.skipped++;
  testResults.tests.push({ name, status: 'skipped' });
  pendingTests.push({ name, fn: null, suite: currentSuite, skipped: true });
}

async function runAllTests() {
  let lastSuite = null;

  for (const t of pendingTests) {
    if (t.suite !== lastSuite) {
      console.log(`\n📦 ${t.suite}`);
      lastSuite = t.suite;
    }

    if (t.skipped) {
      console.log(`  ⏭️  ${t.name} (skipped)`);
      testResults.skipped++;
      testResults.tests.push({ name: t.name, status: 'skipped' });
      continue;
    }

    try {
      await t.fn();
      console.log(`  ✅ ${t.name}`);
      testResults.passed++;
      testResults.tests.push({ name: t.name, status: 'passed' });
    } catch (e) {
      console.log(`  ❌ ${t.name}`);
      console.log(`     ${e.message}`);
      testResults.failed++;
      testResults.tests.push({ name: t.name, status: 'failed', error: e.message });
    }
  }
}

function getResults() {
  return testResults;
}

function resetResults() {
  testResults.passed = 0;
  testResults.failed = 0;
  testResults.skipped = 0;
  testResults.tests = [];
  pendingTests.length = 0;
}

async function printSummary() {
  // Run all collected tests first (for backwards compat with old test files)
  // New test files using async describe already ran their tests
  // await runAllTests(); // Disabled - tests now run inline

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`       Results: ${testResults.passed} passed, ${testResults.failed} failed, ${testResults.skipped} skipped`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  return testResults.failed === 0;
}

/**
 * Run tests - for new async describe pattern
 */
async function runTests() {
  // Tests already ran inline via async describe/test
  // Just print summary
  return printSummary();
}

module.exports = {
  // Mock data
  mockWallet,
  mockMarkets,
  mockMarketIndexMap,
  mockFeeTiers,
  createMockSubprocess,
  createMockPosition,

  // Assertions
  assert,
  assertEqual,
  assertClose,
  assertThrows,
  assertThrowsAsync,

  // Test runner
  describe,
  test,
  skip,
  beforeAll,
  afterAll,
  getResults,
  resetResults,
  printSummary,
  runTests,
  runAllTests,
};
