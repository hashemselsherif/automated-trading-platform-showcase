/**
 * Config Manager Tests
 * Tests for unified configuration management
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createConfigManager, DEFAULT_FEE_CONFIG, DEFAULT_FUNDING_CONFIG, DEFAULT_LEVERAGE_CONFIG, DEFAULT_TRADING_LIMITS } = require('../config-manager');

function expect(actual) {
  return {
    toBe(expected) {
      assert.equal(actual, expected);
    },
    toBeDefined() {
      assert.notEqual(actual, undefined);
    },
    toHaveProperty(property) {
      assert.ok(actual && Object.prototype.hasOwnProperty.call(actual, property));
    },
  };
}

describe('Config Manager', () => {
  let cfgManager;

  beforeEach(() => {
    cfgManager = createConfigManager();
  });

  describe('Initialization', () => {
    test('should create config manager with default config', () => {
      expect(cfgManager).toBeDefined();
      expect(cfgManager.baseConfig).toBeDefined();
    });

    test('should create config manager with custom config', () => {
      const customConfig = {
        maxOpenPositions: 8,
        dailyTradeLimit: 50,
      };
      const manager = createConfigManager(customConfig);
      expect(manager.baseConfig.maxOpenPositions).toBe(8);
    });
  });

  describe('Fee Config', () => {
    test('should return fee config with defaults', () => {
      const feeCfg = cfgManager.getFeeConfig();
      expect(feeCfg.openFeeBps).toBe(DEFAULT_FEE_CONFIG.openFeeBps);
      expect(feeCfg.closeFeeBps).toBe(DEFAULT_FEE_CONFIG.closeFeeBps);
      expect(feeCfg.priceImpactFeeScalar).toBe(DEFAULT_FEE_CONFIG.priceImpactFeeScalar);
    });

    test('should merge custom fee config', () => {
      const customConfig = {
        fees: {
          openFeeBps: 10,
          solanaTxFee: {
            baseFeeLamports: 10000,
          },
        },
      };
      const manager = createConfigManager(customConfig);
      const feeCfg = manager.getFeeConfig();
      expect(feeCfg.openFeeBps).toBe(10);
      expect(feeCfg.closeFeeBps).toBe(DEFAULT_FEE_CONFIG.closeFeeBps); // Should keep default
      expect(feeCfg.solanaTxFee.baseFeeLamports).toBe(10000);
      expect(feeCfg.solanaTxFee.cuLimit).toBe(DEFAULT_FEE_CONFIG.solanaTxFee.cuLimit); // Should keep default
    });

    test('should cache fee config', () => {
      const feeCfg1 = cfgManager.getFeeConfig();
      const feeCfg2 = cfgManager.getFeeConfig();
      expect(feeCfg1).toBe(feeCfg2); // Same reference (cached)
    });
  });

  describe('Funding Config', () => {
    test('should return funding config with defaults', () => {
      const fundingCfg = cfgManager.getFundingConfig();
      expect(fundingCfg.cadenceMs).toBe(DEFAULT_FUNDING_CONFIG.cadenceMs);
      expect(fundingCfg.ratePerCadence).toBe(DEFAULT_FUNDING_CONFIG.ratePerCadence);
    });

    test('should merge custom funding config', () => {
      const customConfig = {
        funding: {
          ratePerCadence: 0.01,
        },
      };
      const manager = createConfigManager(customConfig);
      const fundingCfg = manager.getFundingConfig();
      expect(fundingCfg.ratePerCadence).toBe(0.01);
      expect(fundingCfg.cadenceMs).toBe(DEFAULT_FUNDING_CONFIG.cadenceMs); // Should keep default
    });
  });

  describe('Leverage Config', () => {
    test('should return leverage config with defaults', () => {
      const leverageCfg = cfgManager.getLeverageConfig();
      expect(leverageCfg.minLeverage).toBe(cfgManager.baseConfig.leverage.minLeverage);
      expect(leverageCfg.maxLeverage).toBe(cfgManager.baseConfig.leverage.maxLeverage);
      expect(leverageCfg.trackPerformance).toBe(true);
    });

    test('should use config.leverage.long as baseLeverage fallback', () => {
      const customConfig = {
        leverage: {
          long: 4,
        },
      };
      const manager = createConfigManager(customConfig);
      const leverageCfg = manager.getLeverageConfig();
      expect(leverageCfg.baseLeverage).toBe(4);
    });

    test('should apply overrides', () => {
      const leverageCfg = cfgManager.getLeverageConfig({
        minLeverage: 2,
        maxLeverage: 8,
      });
      expect(leverageCfg.minLeverage).toBe(2);
      expect(leverageCfg.maxLeverage).toBe(8);
    });
  });

  describe('Trading Limits', () => {
    test('should return trading limits from config', () => {
      const limits = cfgManager.getTradingLimits();
      expect(limits).toHaveProperty('maxPositions');
      expect(limits).toHaveProperty('dailyTradeLimit');
    });

    test('should use options overrides', () => {
      const limits = cfgManager.getTradingLimits({
        maxPositions: 10,
        dailyTradeLimit: 100,
      });
      expect(limits.maxPositions).toBe(10);
      expect(limits.dailyTradeLimit).toBe(100);
    });

    test('should fall back to config.js values', () => {
      const customConfig = {
        maxOpenPositions: 6,
        dailyTradeLimit: 30,
      };
      const manager = createConfigManager(customConfig);
      const limits = manager.getTradingLimits();
      expect(limits.maxPositions).toBe(6);
      expect(limits.dailyTradeLimit).toBe(30);
    });
  });

  describe('SOL Price', () => {
    test('should return current price for SOL-PERP market', () => {
      const price = cfgManager.getSolPrice(150, 'SOL-PERP');
      expect(price).toBe(150);
    });

    test('should return config SOL price for other markets', () => {
      const price = cfgManager.getSolPrice(150, 'ETH-PERP');
      expect(price).toBe(150); // Default fallback
    });

    test('should use custom SOL price from config', () => {
      const customConfig = {
        solPriceUsd: 200,
      };
      const manager = createConfigManager(customConfig);
      const price = manager.getSolPrice(150, 'ETH-PERP');
      expect(price).toBe(200);
    });

    test('should use fee config SOL price if available', () => {
      const customConfig = {
        fees: {
          solPriceUsd: 175,
        },
      };
      const manager = createConfigManager(customConfig);
      const price = manager.getSolPrice(150, 'ETH-PERP');
      expect(price).toBe(175);
    });
  });

  describe('Risk Config', () => {
    test('should return risk config', () => {
      const riskCfg = cfgManager.getRiskConfig();
      expect(riskCfg).toBeDefined();
    });

    test('should return portfolio risk config with defaults', () => {
      const portfolioCfg = cfgManager.getPortfolioRiskConfig();
      expect(portfolioCfg.maxTotalLeverage).toBe(10);
      expect(portfolioCfg.maxTotalExposure).toBe(5000);
    });

    test('should apply portfolio risk overrides', () => {
      const portfolioCfg = cfgManager.getPortfolioRiskConfig({
        maxTotalLeverage: 20,
      });
      expect(portfolioCfg.maxTotalLeverage).toBe(20);
      expect(portfolioCfg.maxTotalExposure).toBe(5000); // Should keep default
    });
  });

  describe('Compounding and Sizing', () => {
    test('should return compounding status', () => {
      const enabled = cfgManager.isCompoundingEnabled();
      expect(typeof enabled).toBe('boolean');
    });

    test('should enable compounding from options', () => {
      const enabled = cfgManager.isCompoundingEnabled({ enableCompounding: true });
      expect(enabled).toBe(true);
    });

    test('should return sizing method', () => {
      const method = cfgManager.getSizingMethod();
      expect(method === null || typeof method === 'string').toBe(true);
    });

    test('should return sizing method from options', () => {
      const method = cfgManager.getSizingMethod({ forceSizingMethod: 'equal-risk' });
      expect(method).toBe('equal-risk');
    });
  });

  describe('Exported Constants', () => {
    test('should export default constants', () => {
      expect(DEFAULT_FEE_CONFIG).toBeDefined();
      expect(DEFAULT_FUNDING_CONFIG).toBeDefined();
      expect(DEFAULT_LEVERAGE_CONFIG).toBeDefined();
      expect(DEFAULT_TRADING_LIMITS).toBeDefined();
    });
  });
});

// Run tests if executed directly
if (require.main === module) {
  console.log('Running Config Manager Tests...\n');
  
  // Simple test runner (basic implementation)
  let passed = 0;
  let failed = 0;
  
  try {
    // Basic smoke tests
    const cm = createConfigManager();
    
    // Test 1: Basic initialization
    console.log('Test 1: Initialization...');
    if (cm && cm.baseConfig) {
      console.log('  ✅ PASS');
      passed++;
    } else {
      throw new Error('Initialization failed');
    }
    
    // Test 2: Fee config
    console.log('Test 2: Fee Config...');
    const feeCfg = cm.getFeeConfig();
    if (feeCfg && feeCfg.openFeeBps === 6) {
      console.log('  ✅ PASS');
      passed++;
    } else {
      throw new Error('Fee config failed');
    }
    
    // Test 3: Trading limits
    console.log('Test 3: Trading Limits...');
    const limits = cm.getTradingLimits();
    if (limits && limits.maxPositions && limits.dailyTradeLimit) {
      console.log('  ✅ PASS');
      passed++;
    } else {
      throw new Error('Trading limits failed');
    }
    
    // Test 4: SOL price
    console.log('Test 4: SOL Price...');
    const price = cm.getSolPrice(150, 'SOL-PERP');
    if (price === 150) {
      console.log('  ✅ PASS');
      passed++;
    } else {
      throw new Error('SOL price failed');
    }
    
    // Test 5: Leverage config
    console.log('Test 5: Leverage Config...');
    const levCfg = cm.getLeverageConfig();
    if (levCfg && levCfg.baseLeverage) {
      console.log('  ✅ PASS');
      passed++;
    } else {
      throw new Error('Leverage config failed');
    }
    
    console.log(`\n✅ All tests passed: ${passed}/${passed}`);
    console.log('Config Manager is working correctly!\n');
    
  } catch (error) {
    console.error(`\n❌ Test failed: ${error.message}`);
    failed++;
    process.exit(1);
  }
}
