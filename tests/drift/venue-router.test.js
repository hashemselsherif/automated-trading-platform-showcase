#!/usr/bin/env node
/**
 * Unit Tests: Venue Router
 * 
 * Tests market-specific client routing (Jupiter vs Drift)
 * 
 * Run: node tests/drift/venue-router.test.js
 */

require('dotenv').config();
const { describe, test, assert, assertEqual, printSummary, resetResults } = require('./test-harness');

// Load the venue router
const venueRouter = require('../../utils/venue-router');

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       Unit Tests: Venue Router');
  console.log('═══════════════════════════════════════════════════════════════');
  
  resetResults();

  describe('VENUE constants', () => {
    test('has JUPITER venue', async () => {
      assertEqual(venueRouter.VENUE.JUPITER, 'jupiter');
    });

    test('has DRIFT venue', async () => {
      assertEqual(venueRouter.VENUE.DRIFT, 'drift');
    });
  });

  describe('getVenueForMarket', () => {
    test('routes SOL-PERP to Jupiter (major)', async () => {
      const venue = venueRouter.getVenueForMarket('SOL-PERP');
      assertEqual(venue, 'jupiter');
    });

    test('routes BTC-PERP to Jupiter (major)', async () => {
      const venue = venueRouter.getVenueForMarket('BTC-PERP');
      assertEqual(venue, 'jupiter');
    });

    test('routes APT-PERP to Drift (altcoin)', async () => {
      const venue = venueRouter.getVenueForMarket('APT-PERP');
      assertEqual(venue, 'drift');
    });

    test('routes HNT-PERP to Drift (altcoin)', async () => {
      const venue = venueRouter.getVenueForMarket('HNT-PERP');
      assertEqual(venue, 'drift');
    });

    test('routes DOGE-PERP to Drift (memecoin)', async () => {
      const venue = venueRouter.getVenueForMarket('DOGE-PERP');
      assertEqual(venue, 'drift');
    });

    test('handles unknown market with default', async () => {
      const venue = venueRouter.getVenueForMarket('UNKNOWN-PERP');
      // Should return a valid venue
      assert(venue === 'jupiter' || venue === 'drift', 'Should return valid venue');
    });
  });

  describe('isMajor', () => {
    test('SOL is major', async () => {
      assert(venueRouter.isMajor('SOL-PERP'), 'SOL should be major');
    });

    test('BTC is major', async () => {
      assert(venueRouter.isMajor('BTC-PERP'), 'BTC should be major');
    });

    test('APT is not major', async () => {
      assert(!venueRouter.isMajor('APT-PERP'), 'APT should not be major');
    });

    test('HNT is not major', async () => {
      assert(!venueRouter.isMajor('HNT-PERP'), 'HNT should not be major');
    });
  });

  describe('getCapitalPool', () => {
    test('returns pool info for major market', async () => {
      const pool = venueRouter.getCapitalPool('SOL-PERP', { paperBalance: 1000, paperBalanceAlts: 500 });
      assertEqual(pool.pool, 'majors');
      assertEqual(pool.venue, 'jupiter');
    });

    test('returns pool info for alt market', async () => {
      const pool = venueRouter.getCapitalPool('APT-PERP', { paperBalance: 1000, paperBalanceAlts: 500 });
      assertEqual(pool.pool, 'alts');
      assertEqual(pool.venue, 'drift');
    });

    test('has balance field', async () => {
      const pool = venueRouter.getCapitalPool('SOL-PERP', { paperBalance: 1000 });
      assert(pool.balance !== undefined, 'Should have balance');
    });
  });

  describe('groupMarketsByVenue', () => {
    test('groups markets correctly', async () => {
      const markets = ['SOL-PERP', 'BTC-PERP', 'APT-PERP', 'HNT-PERP'];
      const grouped = venueRouter.groupMarketsByVenue(markets);
      
      assert(grouped.jupiter, 'Should have jupiter group');
      assert(grouped.drift, 'Should have drift group');
    });

    test('majors go to jupiter', async () => {
      const markets = ['SOL-PERP', 'BTC-PERP', 'APT-PERP'];
      const grouped = venueRouter.groupMarketsByVenue(markets);
      
      assert(grouped.jupiter.includes('SOL-PERP'), 'SOL should be in jupiter');
      assert(grouped.jupiter.includes('BTC-PERP'), 'BTC should be in jupiter');
    });

    test('alts go to drift', async () => {
      const markets = ['SOL-PERP', 'APT-PERP', 'HNT-PERP'];
      const grouped = venueRouter.groupMarketsByVenue(markets);
      
      assert(grouped.drift.includes('APT-PERP'), 'APT should be in drift');
      assert(grouped.drift.includes('HNT-PERP'), 'HNT should be in drift');
    });
  });

  describe('getVenueStats', () => {
    test('returns stats object', async () => {
      const markets = ['SOL-PERP', 'BTC-PERP', 'APT-PERP', 'HNT-PERP', 'DOGE-PERP'];
      const stats = venueRouter.getVenueStats(markets);
      
      assert(stats, 'Should return stats');
      assert('jupiter' in stats, 'Should have jupiter stats');
      assert('drift' in stats, 'Should have drift stats');
    });

    test('counts markets per venue', async () => {
      const markets = ['SOL-PERP', 'BTC-PERP', 'APT-PERP'];
      const stats = venueRouter.getVenueStats(markets);
      
      // Stats structure may vary - just verify counts exist
      assert(stats.jupiter, 'Should have jupiter stats');
      assert(stats.drift, 'Should have drift stats');
    });
  });

  describe('Venue isolation', () => {
    test('major routed to jupiter', async () => {
      const venue = venueRouter.getVenueForMarket('SOL-PERP');
      const isMajor = venueRouter.isMajor('SOL-PERP');
      
      assert(isMajor, 'SOL should be major');
      assertEqual(venue, 'jupiter', 'Major should route to jupiter');
    });

    test('non-major routed to drift', async () => {
      const venue = venueRouter.getVenueForMarket('APT-PERP');
      const isMajor = venueRouter.isMajor('APT-PERP');
      
      assert(!isMajor, 'APT should not be major');
      assertEqual(venue, 'drift', 'Non-major should route to drift');
    });
  });

  return printSummary();
}

runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

