const test = require('node:test');
const assert = require('node:assert/strict');

const MarketAllocator = require('../utils/market-allocator');

test('MarketAllocator scores ichimoku-cloud signals without errors and returns ranked opportunities', () => {
  const allocator = new MarketAllocator(
    {
      markets: ['SOL-PERP', 'ETH-PERP'],
      maxPositionsPerMarket: 1,
      exploreProbability: 0, // deterministic
      minScore: 0,
      minConfidence: 0,
      ichimokuMinScore: 0,
      ichimokuMinConfidence: 0,
    },
    {
      strategyFactory: null,
    }
  );

  const marketPerformance = new Map();
  marketPerformance.set('SOL-PERP', { winRate: 0.55, avgPnL: 5, recentTrades: 10 });
  marketPerformance.set('ETH-PERP', { winRate: 0.55, avgPnL: 5, recentTrades: 10 });

  const signals = [
    {
      market: 'SOL-PERP',
      signal: {
        action: 'open',
        side: 'long',
        strategyType: 'ichimoku-cloud',
        confidence: 0.9,
        reason: 'ichimoku_breakout_long',
        indicators: {
          breakoutDistAtr: 0.5,
          cloudThicknessAtr: 1.2,
          kijunDistAtr: 0.8,
          atr: 2.0,
          adx: 30,
          price: 100,
        },
      },
      priceData: { price: 100, atr: 2.0, adx: 30 },
    },
    {
      market: 'ETH-PERP',
      signal: {
        action: 'open',
        side: 'long',
        strategyType: 'ichimoku-cloud',
        confidence: 0.9,
        reason: 'ichimoku_breakout_long',
        indicators: {
          // Worse signal: later + thicker cloud
          breakoutDistAtr: 1.4,
          cloudThicknessAtr: 3.2,
          kijunDistAtr: 1.8,
          atr: 2.0,
          adx: 30,
          price: 100,
        },
      },
      priceData: { price: 100, atr: 2.0, adx: 30 },
    },
    {
      market: 'BTC-PERP',
      signal: {
        action: 'open',
        side: 'long',
        strategyType: 'momentum',
        confidence: 0.9,
        reason: 'momentum_breakout',
      },
      priceData: { price: 100, atr: 2.0, adx: 20 },
    },
  ];

  const ranked = allocator.evaluateOpportunities(signals, [], {}, marketPerformance);
  assert(Array.isArray(ranked));
  assert(ranked.length > 0);

  // Ensure strategyType is carried through (multi-strategy compatible)
  const gotTypes = new Set(ranked.map((x) => x.strategyType));
  assert(gotTypes.has('ichimoku-cloud'));

  // Ensure the cleaner Ichimoku breakout ranks above the late/thick-cloud one (when thresholds are permissive).
  const ichiRanked = ranked.filter((r) => r.strategyType === 'ichimoku-cloud');
  assert(ichiRanked.length >= 2);
  assert.equal(ichiRanked[0].market, 'SOL-PERP');
});

test('MarketAllocator ichimoku allocator risk applies rank tilt across a batch (size + leverage)', () => {
  const savedEnv = { ...process.env };
  try {
    process.env.ALLOCATOR_RISK_ENABLED = 'true';
    process.env.ICHIMOKU_ALLOCATOR_RISK_ENABLED = 'true';
    process.env.ICHIMOKU_ALLOCATOR_RISK_RANK_TILT = '1.0';
    process.env.ICHIMOKU_ALLOCATOR_RISK_RANK_POWER = '1.0';
    process.env.ICHIMOKU_ALLOCATOR_RISK_SIZE_MULT_MIN = '1.0';
    process.env.ICHIMOKU_ALLOCATOR_RISK_SIZE_MULT_MAX = '1.0';
    process.env.ICHIMOKU_ALLOCATOR_RISK_LEV_MULT_MIN = '1.0';
    process.env.ICHIMOKU_ALLOCATOR_RISK_LEV_MULT_MAX = '1.0';

    const allocator = new MarketAllocator({ markets: ['SOL-PERP', 'ETH-PERP'] });

    const batch = [
      {
        market: 'SOL-PERP',
        strategyType: 'ichimoku-cloud',
        score: 1.0,
        priceData: { price: 100 },
        signal: {
          action: 'open',
          side: 'long',
          strategyType: 'ichimoku-cloud',
          confidence: 1.0,
          indicators: {
            breakoutDistAtr: 0.5,
            cloudThicknessAtr: 1.2,
            kijunDistAtr: 0.8,
            atr: 2.0,
            adx: 30,
            price: 100,
          },
        },
      },
      {
        market: 'ETH-PERP',
        strategyType: 'ichimoku-cloud',
        score: 1.0,
        priceData: { price: 100 },
        signal: {
          action: 'open',
          side: 'long',
          strategyType: 'ichimoku-cloud',
          confidence: 1.0,
          indicators: {
            breakoutDistAtr: 1.4,
            cloudThicknessAtr: 3.2,
            kijunDistAtr: 1.8,
            atr: 2.0,
            adx: 30,
            price: 100,
          },
        },
      },
    ];

    const m = allocator.recommendRiskMultipliersBatch(batch);
    const sol = m.get('SOL-PERP:long');
    const eth = m.get('ETH-PERP:long');
    assert(sol && eth);

    // Better signal gets larger rank multiplier; mean-preserving => sum ~2 for 2 selections (tilt=1).
    assert(sol.rankMult > eth.rankMult);
    assert(Math.abs((sol.rankMult + eth.rankMult) - 2) < 1e-9);

    // Rank tilt affects size and leverage equally (multipliers here are 1.0 so final==rank).
    assert.equal(sol.finalSizeMult, sol.rankMult);
    assert.equal(eth.finalLevMult, eth.rankMult);
  } finally {
    // Restore env without replacing the process.env object (Node treats it specially).
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      process.env[k] = v;
    }
  }
});
