// config.js
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// ========================================
// MULTI-STRATEGY ENV LOADING SYSTEM
// ========================================
// Two modes:
// 1. Single-strategy mode (MULTI_STRATEGY_MODE=false or unset):
//    - Load .env, then .env.{STRATEGY_TYPE} (legacy behavior)
// 2. Multi-strategy mode (MULTI_STRATEGY_MODE=true):
//    - Load .env, then load ALL enabled strategy configs
//    - ENABLE_MOMENTUM_STRATEGY, ENABLE_SCALPING_STRATEGY, ENABLE_RSI_REVERSION_STRATEGY

// Load shared config first
dotenv.config({ path: path.join(__dirname, '.env') });

// Check for multi-strategy mode
const multiStrategyMode = (process.env.MULTI_STRATEGY_MODE || 'false').toLowerCase() === 'true';

// Helper: parse a dotenv file WITHOUT mutating process.env (used for market union in multi-strategy mode)
function parseEnvFileNoMutate(envFile) {
  try {
    const envPath = path.join(__dirname, envFile);
    if (!fs.existsSync(envPath)) return null;
    const raw = fs.readFileSync(envPath, 'utf8');
    return dotenv.parse(raw);
  } catch {
    return null;
  }
}

// Helper: parse comma-separated markets, normalizing to *-PERP uppercase
function parseMarketList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(m => m.trim().toUpperCase())
    .filter(Boolean)
    .map(m => (m.includes('-PERP') ? m : `${m}-PERP`));
}

if (multiStrategyMode) {
  // Multi-strategy mode: Load all enabled strategy configs
  console.log('🔄 Multi-strategy mode enabled');
  
  const strategyEnvFiles = [];
  
  if ((process.env.ENABLE_MOMENTUM_STRATEGY || 'true').toLowerCase() === 'true') {
    strategyEnvFiles.push('.env.momentum');
  }
  if ((process.env.ENABLE_SCALPING_STRATEGY || 'false').toLowerCase() === 'true') {
    strategyEnvFiles.push('.env.scalping');
  }
  if ((process.env.ENABLE_RSI_REVERSION_STRATEGY || 'false').toLowerCase() === 'true') {
    strategyEnvFiles.push('.env.rsi-reversion');
  }
  if ((process.env.ENABLE_RSI_REVERSION_ALTS_STRATEGY || 'false').toLowerCase() === 'true') {
    // Load alts BEFORE majors so majors remain the baseline env for legacy reads.
    strategyEnvFiles.unshift('.env.rsi-reversion-alts');
  }
  if ((process.env.ENABLE_BTC_BREAKOUT_STRATEGY || 'false').toLowerCase() === 'true') {
    strategyEnvFiles.push('.env.btc-breakout');
  }
  if ((process.env.ENABLE_ICHIMOKU_STRATEGY || 'false').toLowerCase() === 'true') {
    strategyEnvFiles.push('.env.ichimoku');
  }
  if ((process.env.ENABLE_COPY_TRADING_STRATEGY || 'false').toLowerCase() === 'true') {
    strategyEnvFiles.push('.env.copy-trading');
  }
  
  // Load each enabled strategy config (note: later files override earlier ones for shared keys)
  // Strategy-specific keys should be prefixed to avoid conflicts
  for (const envFile of strategyEnvFiles) {
    const envPath = path.join(__dirname, envFile);
    if (fs.existsSync(envPath)) {
      const result = dotenv.config({ path: envPath, override: true });
      if (!result.error) {
        console.log(`✅ Loaded strategy config: ${envFile}`);
      }
    } else {
      console.warn(`⚠️  Strategy config file ${envFile} not found`);
    }
  }
} else {
  // Single-strategy mode (legacy): Load only the active strategy config
  // Priority: ENV_FILE > STRATEGY_TYPE > enabled strategies (if momentum disabled) > auto-detect from TRADING_INTERVAL > default 'momentum'
  
  // Check enabled strategies to determine which strategy to use if momentum is disabled
  const momentumEnabled = (process.env.ENABLE_MOMENTUM_STRATEGY || 'true').toLowerCase() === 'true';
  const scalpingEnabled = (process.env.ENABLE_SCALPING_STRATEGY || 'false').toLowerCase() === 'true';
  const rsiEnabled = (process.env.ENABLE_RSI_REVERSION_STRATEGY || 'false').toLowerCase() === 'true';
  const ichimokuEnabled = (process.env.ENABLE_ICHIMOKU_STRATEGY || 'false').toLowerCase() === 'true';
  const btcBreakoutEnabled =
    (process.env.ENABLE_BTC_BREAKOUT_STRATEGY || 'false').toLowerCase() === 'true';
  const copyEnabled = (process.env.ENABLE_COPY_TRADING_STRATEGY || 'false').toLowerCase() === 'true';
  
  let strategyType = process.env.STRATEGY_TYPE;
  
  if (!strategyType) {
    // If momentum is disabled, use the enabled strategy
    if (!momentumEnabled) {
      if (rsiEnabled && !scalpingEnabled) {
        strategyType = 'rsi-reversion';
      } else if (
        btcBreakoutEnabled &&
        !rsiEnabled &&
        !scalpingEnabled &&
        !ichimokuEnabled &&
        !copyEnabled
      ) {
        strategyType = 'btc-breakout';
      } else if (scalpingEnabled && !rsiEnabled) {
        strategyType = 'scalping';
      } else if (copyEnabled && !rsiEnabled && !scalpingEnabled && !ichimokuEnabled) {
        strategyType = 'copy-trading';
      } else if (btcBreakoutEnabled && !rsiEnabled && !scalpingEnabled) {
        strategyType = 'btc-breakout';
      } else if (rsiEnabled && scalpingEnabled) {
        strategyType = 'rsi-reversion'; // Prefer RSI if both enabled
      }
    }
    
    // Fallback to auto-detect from trading interval
    if (!strategyType) {
      strategyType = process.env.TRADING_INTERVAL === '1m' ? 'scalping' : 'momentum';
    }
  }

  const envFileFromEnv = (process.env.ENV_FILE || '').trim();
  let strategyEnvFile = envFileFromEnv || `.env.${strategyType}`;

  // Back-compat / alias support for the alt RSI variant:
  // Strategy identity: rsi-reversion-alt
  // Overlay file: .env.rsi-reversion-alts
  if (!envFileFromEnv && strategyType === 'rsi-reversion-alt') {
    const singular = path.join(__dirname, '.env.rsi-reversion-alt');
    const plural = path.join(__dirname, '.env.rsi-reversion-alts');
    if (!fs.existsSync(singular) && fs.existsSync(plural)) {
      strategyEnvFile = '.env.rsi-reversion-alts';
    }
  }

  const strategyEnvPath = path.join(__dirname, strategyEnvFile);

  // Load strategy-specific config (overrides shared)
  if (fs.existsSync(strategyEnvPath)) {
    const result = dotenv.config({ path: strategyEnvPath, override: true });
    if (!result.error) {
      console.log(`✅ Loaded strategy config: ${strategyEnvFile} (single-strategy mode: ${strategyType})`);
    }
  } else {
    console.warn(`⚠️  Strategy config file ${strategyEnvFile} not found, using shared .env only`);
  }
}

// Now all process.env.* keys are available with strategy-specific overrides

const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const boolFrom = (v, d) => {
  if (v === undefined) return d;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
};

// Single source of truth for leverage (env-driven)
const DEFAULT_MIN_LEVERAGE = num(process.env.LEVERAGE_MIN, 1);
const DEFAULT_MAX_LEVERAGE = num(process.env.LEVERAGE_MAX, 6);

// Alias support: if LEVERAGE is provided, use it as a global fixed leverage
// This maps to base/long/short/max unless those are explicitly set.
const LEVERAGE_ALIAS = (() => {
  const v = process.env.LEVERAGE;
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

// Helper to convert camelCase to UPPER_SNAKE_CASE
// Example: adxMinTrend -> ADX_MIN_TREND
function camelToUpperSnake(str) {
  return str
    .replace(/([A-Z])/g, '_$1')  // Add underscore before uppercase letters
    .toUpperCase()                // Convert to uppercase
    .replace(/^_/, '');           // Remove leading underscore if any
}

// Helper to get configured markets from env (called before module.exports is defined)
function getConfiguredMarkets() {
  // Multi-strategy mode: union per-strategy STRATEGY_MARKETS from enabled env overlays
  if (multiStrategyMode) {
    const marketsSet = new Set();

    // Prefer explicit MARKETS/STRATEGY_MARKETS from runtime env if provided
    for (const m of parseMarketList(process.env.STRATEGY_MARKETS)) marketsSet.add(m);
    for (const m of parseMarketList(process.env.MARKETS)) marketsSet.add(m);

    // Also union markets from strategy env files (disk), so per-strategy configs don't clobber each other
    const files = [];
    if ((process.env.ENABLE_MOMENTUM_STRATEGY || 'true').toLowerCase() === 'true') files.push('.env.momentum');
    if ((process.env.ENABLE_SCALPING_STRATEGY || 'false').toLowerCase() === 'true') files.push('.env.scalping');
    if ((process.env.ENABLE_RSI_REVERSION_STRATEGY || 'false').toLowerCase() === 'true') files.push('.env.rsi-reversion');
    if ((process.env.ENABLE_RSI_REVERSION_ALTS_STRATEGY || 'false').toLowerCase() === 'true') files.push('.env.rsi-reversion-alts');
    if ((process.env.ENABLE_BTC_BREAKOUT_STRATEGY || 'false').toLowerCase() === 'true') files.push('.env.btc-breakout');
    if ((process.env.ENABLE_ICHIMOKU_STRATEGY || 'false').toLowerCase() === 'true') files.push('.env.ichimoku');
    if ((process.env.ENABLE_COPY_TRADING_STRATEGY || 'false').toLowerCase() === 'true') files.push('.env.copy-trading');

    for (const f of files) {
      const parsed = parseEnvFileNoMutate(f);
      if (!parsed) continue;
      for (const m of parseMarketList(parsed.STRATEGY_MARKETS || parsed.MARKETS)) marketsSet.add(m);
    }

    const out = Array.from(marketsSet);
    if (out.length > 0) return out;
    return ['SOL-PERP', 'ETH-PERP', 'BTC-PERP'];
  }

  if (process.env.STRATEGY_MARKETS) {
    return process.env.STRATEGY_MARKETS.split(',')
      .map(m => m.trim().toUpperCase())
      .filter(m => m.length > 0)
      .map(m => m.includes('-PERP') ? m : `${m}-PERP`);
  }
  if (process.env.MARKETS) {
    return process.env.MARKETS.split(',')
      .map(m => m.trim().toUpperCase())
      .filter(m => m.length > 0)
      .map(m => m.includes('-PERP') ? m : `${m}-PERP`);
  }
  if (process.env.MARKET) {
    return [process.env.MARKET.toUpperCase()].map(m => m.includes('-PERP') ? m : `${m}-PERP`);
  }
  return ['SOL-PERP', 'ETH-PERP', 'BTC-PERP']; // Default fallback
}

// Helper to parse per-market strategy configs from env
// Parses config for ALL markets in STRATEGY_MARKETS/MARKETS (not just hardcoded majors)
// Includes optimized defaults for majors from backtest analysis
function parsePerMarketStrategyConfig() {
  const perMarket = {};
  const markets = getConfiguredMarkets();
  
  // Optimized defaults from backtest analysis
  const optimizedDefaults = {
    'SOL-PERP': {
      adxMinTrend: 30,        // Stricter trend requirement (de-risk SOL)
      donchianConfirm: 1,     // Require confirmation
      requireVolumeSpike: true, // Require volume spike
      allowShorts: false,     // Disable shorts for SOL
    },
    'BTC-PERP': {
      zFilter: 6.5,           // Lower zFilter (more triggers)
      bandPct: 0.0012,        // Lower bandPct (more triggers)
      adxMinTrend: 24,        // Higher ADX (quality filter)
      donchianConfirm: 0,     // No confirmation needed
    },
    'ETH-PERP': {
      zFilter: 6.5,           // Lower zFilter (more triggers)
      bandPct: 0.0012,        // Lower bandPct (more triggers)
      adxMinTrend: 24,        // Higher ADX (quality filter)
      donchianConfirm: 0,     // No confirmation needed
    },
  };
  
  for (const market of markets) {
    const marketKey = market.replace('-', '_'); // SOL-PERP -> SOL_PERP
    const prefix = `STRATEGY_${marketKey}_`;
    
    // Start with optimized defaults if available
    const config = optimizedDefaults[market] ? { ...optimizedDefaults[market] } : {};
    
    // Parse numeric params from env (override defaults)
    const numericParams = [
      'adxMinTrend', 'adxExitWeak', 'zFilter', 'bandPct', 'donchianConfirm',
      'donchianPeriod', 'adxPeriod', 'atrPeriod', 'rsiLong', 'rsiShort',
      'rsiPeriod', 'maPeriod', 'atrStopMultiplier', 'atrTakeProfitMultiplier',
      'partialAtR', 'trailATR', 'timeStopBars', 'minRToHold', 'cooldownMs',
      'flipCooldownMs', 'flipCooldownBars', 'minBarsSameSideReentry', 'minDist', 
      'pullbackSizeMultiplier', 'pullbackLookbackBars', 'pullbackTouchBps', 
      'squeezeBarsN', 'squeezeAdxStart', 'squeezeAdxTarget', 'squeezeInitialStopATR', 
      'squeezeWidenToATR', 'squeezeWidenAtR', 'pyramidTriggerAtr', 'pyramidAddPct', 
      'pyramidTrailATR', 'strictAdxMin', 'maxEntryDistAtr', 'retestBars', 
      'timeGateAdxThreshold', 'htfMaPeriod', 'maSlopeUpMin', 'maSlopeDownMax', 'maSlopeLookback'
    ];
    
    for (const param of numericParams) {
      // Convert camelCase to UPPER_SNAKE_CASE for env var name
      const envKey = `${prefix}${camelToUpperSnake(param)}`;
      const value = process.env[envKey];
      if (value !== undefined && value !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) {
          config[param] = n;
        }
      }
    }
    
    // Parse boolean params from env (override defaults)
    const booleanParams = [
      'requireVolumeSpike', 'enableHTFTrend', 'enableVolatilityFilter',
      'enableSessionAwareness', 'requireAdxSlopeUp', 'enablePartialTake',
      'enableTrailingStop', 'enableTimeStop', 'enablePullbackEntry',
      'enableSqueezeEntry', 'pyramidEnable', 'allowShorts', 'allowLongs',
      'enableGreenDayVeto', 'enableDonchianGate', 'longStrictHTF',
      'shortStrictHTF', 'enableTimeGate', 'requireRetest', 'enableCooldown',
      'enableSameBarGuard', 'enableEdgeTrigger'
    ];
    
    for (const param of booleanParams) {
      // Convert camelCase to UPPER_SNAKE_CASE for env var name
      const envKey = `${prefix}${camelToUpperSnake(param)}`;
      const value = process.env[envKey];
      if (value !== undefined && value !== '') {
        config[param] = boolFrom(value, true);
      }
    }
    
    const stringParams = ['htfInterval'];
    for (const param of stringParams) {
      const envKey = `${prefix}${camelToUpperSnake(param)}`;
      const value = process.env[envKey];
      if (value !== undefined && value !== '') {
        config[param] = value;
      }
    }
    
    // Only add if config has any params (always include optimized defaults)
    if (Object.keys(config).length > 0) {
      perMarket[market] = config;
    }
  }
  
  return perMarket;
}

module.exports = {
  // ---------- Modes ----------
  paperTradingMode: (process.env.TRADING_MODE || 'paper').toLowerCase() === 'paper',
  executionMode: (process.env.EXECUTION_MODE || 'guarded').toLowerCase(),

  // ---------- Multi-Strategy Mode ----------
  // When enabled, multiple strategies can run simultaneously per market
  multiStrategyMode: (process.env.MULTI_STRATEGY_MODE || 'false').toLowerCase() === 'true',
  
  // Individual strategy toggles (used in multi-strategy mode)
  enableMomentumStrategy: (process.env.ENABLE_MOMENTUM_STRATEGY || 'true').toLowerCase() === 'true',
  enableScalpingStrategy: (process.env.ENABLE_SCALPING_STRATEGY || 'false').toLowerCase() === 'true',
  enableRsiReversionStrategy: (process.env.ENABLE_RSI_REVERSION_STRATEGY || 'false').toLowerCase() === 'true',
  enableRsiReversionAltsStrategy: (process.env.ENABLE_RSI_REVERSION_ALTS_STRATEGY || 'false').toLowerCase() === 'true',
  enableBtcBreakoutStrategy: (process.env.ENABLE_BTC_BREAKOUT_STRATEGY || 'false').toLowerCase() === 'true',
  enableIchimokuStrategy: (process.env.ENABLE_ICHIMOKU_STRATEGY || 'false').toLowerCase() === 'true',
  enableCopyTradingStrategy: (process.env.ENABLE_COPY_TRADING_STRATEGY || 'false').toLowerCase() === 'true',

  // ---------- Network / RPC ----------
  // This is what validate-config checks (must exist)
  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Jupiter Swap API URL (only used for slippage validator pre-trade quotes)
  // NOT used for price fetching - we use batched Jupiter Price API instead
  jupiterApiUrl: process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1',

  // ---------- Market ----------
  // Support both single MARKET (backward compatibility) and multiple MARKETS
  // Also supports STRATEGY_MARKETS for RSI-reversion strategy filtering
  // Uses getConfiguredMarkets() helper for consistency
  market: (process.env.MARKET || 'SOL-PERP').toUpperCase(),
  markets: getConfiguredMarkets(),

  // ---------- Trading Interval & Strategy Type ----------
  // Auto-detect strategy type based on trading interval (if not explicitly set)
  // 1m interval → scalping strategy (high-frequency, tight stops)
  // 5m+ interval → momentum strategy (swing trading, wider stops)
  tradingInterval: process.env.TRADING_INTERVAL || '5m',
  
  // Strategy type with auto-detection
  // Priority: STRATEGY_TYPE env var > enabled strategies (if momentum disabled) > auto-detect from tradingInterval > default (momentum)
  strategyType: (() => {
    // Explicit override (highest priority)
    if (process.env.STRATEGY_TYPE) {
      return process.env.STRATEGY_TYPE.toLowerCase();
    }
    
	    // If momentum is disabled and only one other strategy is enabled, use that
	    const momentumEnabled = (process.env.ENABLE_MOMENTUM_STRATEGY || 'true').toLowerCase() === 'true';
	    const scalpingEnabled = (process.env.ENABLE_SCALPING_STRATEGY || 'false').toLowerCase() === 'true';
	    const rsiEnabled = (process.env.ENABLE_RSI_REVERSION_STRATEGY || 'false').toLowerCase() === 'true';
	    const btcBreakoutEnabled =
	      (process.env.ENABLE_BTC_BREAKOUT_STRATEGY || 'false').toLowerCase() === 'true';
	    const ichimokuEnabled = (process.env.ENABLE_ICHIMOKU_STRATEGY || 'false').toLowerCase() === 'true';
	    const copyEnabled = (process.env.ENABLE_COPY_TRADING_STRATEGY || 'false').toLowerCase() === 'true';
	    
	    if (!momentumEnabled) {
	      // Momentum disabled - check which other strategy is enabled
	      if (rsiEnabled && !scalpingEnabled && !ichimokuEnabled) {
	        return 'rsi-reversion';
      }
      if (
        btcBreakoutEnabled &&
        !rsiEnabled &&
        !scalpingEnabled &&
        !ichimokuEnabled &&
        !copyEnabled
      ) {
        return 'btc-breakout';
      }
      if (scalpingEnabled && !rsiEnabled && !ichimokuEnabled) {
        return 'scalping';
      }
      if (ichimokuEnabled && !rsiEnabled && !scalpingEnabled) {
        return 'ichimoku-cloud';
      }
      if (rsiEnabled && scalpingEnabled && !ichimokuEnabled && !btcBreakoutEnabled) {
        // Both enabled - prefer RSI if momentum is off
        return 'rsi-reversion';
      }
      if (btcBreakoutEnabled && !copyEnabled) {
        return 'btc-breakout';
      }
      if (ichimokuEnabled && (rsiEnabled || scalpingEnabled)) {
        // If Ichimoku is enabled with others, prefer RSI unless explicitly overridden
        return rsiEnabled ? 'rsi-reversion' : 'ichimoku-cloud';
      }
    }
    
    // Auto-detect from trading interval
    const interval = (process.env.TRADING_INTERVAL || '5m').toLowerCase();
    if (interval === '1m') {
      return 'scalping'; // 1-minute bars → scalping
    } else {
      return 'momentum'; // 5m+ bars → momentum (default)
    }
  })(),
  
  // Per-market strategy type override
  // STRATEGY_TYPE_SOL_PERP=scalping overrides auto-detection for SOL-PERP
  // Parses for ALL configured markets (not just hardcoded majors)
  strategyTypePerMarket: (() => {
    const perMarket = {};
    const markets = getConfiguredMarkets();
    
    for (const market of markets) {
      const marketKey = market.replace(/-/g, '_'); // SOL-PERP → SOL_PERP
      const envKey = `STRATEGY_TYPE_${marketKey}`;
      const value = process.env[envKey];
      
      if (value) {
        perMarket[market] = value.toLowerCase();
      }
    }
    
    return perMarket;
  })(),

  // ---------- Limits & Loop ----------
  dailyTradeLimit: num(process.env.DAILY_TRADE_LIMIT, 20),
  maxOpenPositions: num(process.env.MAX_POSITIONS, 4),
  // Starting balance - now set per-strategy in strategy env files
  // Priority: STARTING_BALANCE_USD > PAPER_BALANCE > default 1000
  startingBalanceUsd: num(process.env.STARTING_BALANCE_USD, num(process.env.PAPER_BALANCE, 1000)),
  // Alias for backward compatibility
  paperBalance: num(process.env.PAPER_BALANCE, num(process.env.STARTING_BALANCE_USD, 1000)),
  // Separate capital pool for alts (Drift) - NOT shared with majors
  paperBalanceAlts: num(process.env.PAPER_BALANCE_ALTS, num(process.env.STARTING_BALANCE_USD, 1000)),
  // Separate capital pool for copy-trading strategy (Jupiter)
  startingBalanceCopy: num(process.env.STARTING_BALANCE_COPY, num(process.env.PAPER_BALANCE_COPY, 500)),
  paperBalanceCopy: num(process.env.PAPER_BALANCE_COPY, num(process.env.STARTING_BALANCE_COPY, 500)),
  
  // ---------- Per-Venue Limits ----------
  // Majors (Jupiter) limits
  maxOpenPositionsMajors: num(process.env.MAX_POSITIONS_MAJORS, process.env.MAX_POSITIONS || 4),
  // Alts (Drift) limits  
  maxOpenPositionsAlts: num(process.env.MAX_POSITIONS_ALTS, process.env.MAX_POSITIONS || 4),

  // ---------- Leverage ----------
  leverage: {
    // Dynamic leverage settings
    // If LEVERAGE alias is provided and DYNAMIC_LEVERAGE is not set, default dynamic=false to honor fixed leverage
    dynamic: (() => {
      const explicit = process.env.DYNAMIC_LEVERAGE;
      if (explicit !== undefined) return boolFrom(explicit, true);
      if (LEVERAGE_ALIAS !== null) return false;
      return true; // default: dynamic on
    })(),
    baseLeverage: (() => {
      if (process.env.LEVERAGE_BASE !== undefined) return num(process.env.LEVERAGE_BASE, 1);
      if (LEVERAGE_ALIAS !== null) return LEVERAGE_ALIAS;
      return 1;
    })(),
    minLeverage: DEFAULT_MIN_LEVERAGE,
    maxLeverage: (() => {
      if (process.env.LEVERAGE_MAX !== undefined) return num(process.env.LEVERAGE_MAX, DEFAULT_MAX_LEVERAGE);
      if (LEVERAGE_ALIAS !== null) return LEVERAGE_ALIAS; // cap at alias when provided
      return DEFAULT_MAX_LEVERAGE;
    })(),
    // Static leverage (used when dynamic is false)
    long: (() => {
      if (process.env.LEVERAGE_LONG !== undefined) return num(process.env.LEVERAGE_LONG, 1);
      if (process.env.LEVERAGE_BASE !== undefined) return num(process.env.LEVERAGE_BASE, 1);
      if (LEVERAGE_ALIAS !== null) return LEVERAGE_ALIAS;
      return 1;
    })(),
    short: (() => {
      if (process.env.LEVERAGE_SHORT !== undefined) return num(process.env.LEVERAGE_SHORT, 1);
      if (process.env.LEVERAGE_BASE !== undefined) return num(process.env.LEVERAGE_BASE, 1);
      if (LEVERAGE_ALIAS !== null) return LEVERAGE_ALIAS;
      return 1;
    })(),
    // Adjustment factors
    volatilityAdjustment: boolFrom(process.env.LEVERAGE_VOLATILITY_ADJ, true),
    // Use defaults from dynamic-leverage.js when not provided
    adxAdjustment: boolFrom(process.env.LEVERAGE_ADX_ADJ, true),
    confidenceAdjustment: boolFrom(process.env.LEVERAGE_CONFIDENCE_ADJ, true),
    portfolioRiskAdjustment: boolFrom(process.env.LEVERAGE_PORTFOLIO_ADJ, true),
    fundingAdjustment: boolFrom(process.env.LEVERAGE_FUNDING_ADJ, true),
    drawdownProtection: boolFrom(process.env.LEVERAGE_DRAWDOWN_PROT, true),
    useKelly: boolFrom(process.env.LEVERAGE_USE_KELLY, false),
    // NEW: Dynamic maxLeverage throttle
    useDynamicMaxLev: boolFrom(process.env.USE_DYNAMIC_MAX_LEV, true), // Enable throttle by default
    dailyDrawdownThreshold: num(process.env.DAILY_DRAWDOWN_THRESHOLD, 0.03), // 3% daily drawdown
  },

  // ---------- Risk Management ----------
  risk: {
    minPositionSize: num(process.env.MIN_POSITION_SIZE, 50), // Minimum position size in USD (default: $50)
    maxPositionSize: num(process.env.MAX_POSITION_SIZE, 10000),
    
    // Position Sizing Method Toggle
    // Set to 'equal-risk' for risk-based sizing (uses stop distance to equalize risk per trade)
    // Set to 'percent' for fixed percentage sizing (uses positionSizePercent directly)
    // Default: 'equal-risk' (better risk-adjusted performance)
    // This controls both production and backtest behavior
    sizingMethod: process.env.POSITION_SIZING_METHOD || process.env.FORCE_SIZING_METHOD || 'equal-risk', // 'equal-risk' | 'percent'
    
    // Position size as % of capital (used for position sizing calculations)
    // For equal-risk sizing: Acts as a soft cap (only applies when < 100%)
    //   - Set to 100% to allow risk-based sizing to work freely
    //   - Set to < 100% to cap position size (risk per trade may not be fully achieved)
    // For percent-based sizing: Directly determines position size (% of capital)
    // Default: 10% of capital per position (can be overridden via POSITION_SIZE_PERCENT env var)
    positionSizePercent: num(process.env.POSITION_SIZE_PERCENT, 10), // Default: 10% (0.10)
    
    // Risk per trade as % of equity (used ONLY for equal-risk sizing)
    // Default: 5% risk per trade (can be overridden via RISK_PER_TRADE_PERCENT env var)
    // For more conservative risk profile, set RISK_PER_TRADE_PERCENT to 0.005 (0.5%)
    // Note: This is IGNORED when sizingMethod='percent' (percent-based sizing uses positionSizePercent instead)
    riskPerTradePercent: num(process.env.RISK_PER_TRADE_PERCENT, 0.05), // Default: 5% (0.05)
    
    // Legacy support: FORCE_SIZING_METHOD (deprecated, use POSITION_SIZING_METHOD instead)
    // This is kept for backward compatibility but POSITION_SIZING_METHOD takes precedence
    forceSizingMethod: process.env.FORCE_SIZING_METHOD || null, // 'equal-risk' | 'percent' | null (auto, defaults to equal-risk)
    // Compounding: When enabled, position sizes grow with profits. When disabled, position sizes remain fixed at initial capital.
    enableCompounding: boolFrom(process.env.ENABLE_COMPOUNDING, false), // Default: false (no compounding)
    takeProfitPercent: num(process.env.TAKE_PROFIT_PERCENT, 2),
    stopLossPercent: num(process.env.STOP_LOSS_PERCENT, 5),
    trailingStopPercent: num(process.env.TRAILING_STOP_PERCENT, 1),
    useTrailingStop: boolFrom(process.env.USE_TRAILING_STOP, false),
    maxFundingRatePercent: num(process.env.MAX_FUNDING_RATE_PERCENT, 0.1),
    maxPositionHours: num(process.env.MAX_POSITION_HOURS, 24),
    maxTotalLeverage: num(process.env.MAX_TOTAL_LEVERAGE, 10),
    maxTotalExposure: num(process.env.MAX_TOTAL_EXPOSURE, 5000),
    maxPositions: num(process.env.MAX_POSITIONS, 8),
    maxMarketImpactBps: num(process.env.MAX_MARKET_IMPACT_BPS, 30),
    slippageBps: num(process.env.SLIPPAGE_BPS, 50),
  },

  // ---------- Jupiter Perps Fees ----------
  // Jupiter Perps fee structure based on official documentation
  // Source: https://support.jup.ag/hc/en-us/articles/18735045234588-Fees
  fees: {
    // Base fee: 0.06% (6 basis points) of notional position size
    // Applied to open/close, liquidations, TP/SL, and limit orders
    openFeeBps: num(process.env.OPEN_FEE_BPS, 6), // 0.06% = 6 bps
    closeFeeBps: num(process.env.CLOSE_FEE_BPS, 6), // 0.06% = 6 bps
    
    // Price impact fee: Linear price impact fee to simulate market slippage
    // Formula: Linear price impact fee coefficient = trade size / price impact fee scalar constant
    // Final linear price impact fee = trade size * linear price impact fee coefficient
    // For SOL: scalar constant = 125,000,000,000,000 / 10,000 = 125,000,000,000
    // Example: $10k trade → coefficient = 10,000 / 125,000,000,000 = 0.00000008 → fee = $0.0008
    // Note: Price impact fee is typically negligible for small trades (< 0.001% for $10k)
    priceImpactFeeScalar: num(process.env.PRICE_IMPACT_FEE_SCALAR, 125_000_000_000), // Default for SOL (can be configured per asset)
    enablePriceImpactFee: num(process.env.ENABLE_PRICE_IMPACT_FEE, 1) === 1, // Enable price impact fee (default: true)
    
    // Borrow fee: Hourly fee on leveraged positions
    // Formula: Hourly Borrow Fee = Utilization × Hourly Borrow Rate × Position Size
    // Utilization = Total Tokens Locked / Tokens in Pool
    // Example: 19.8% utilization × 0.012% × $10k = $0.238/hour
    borrowFeeBpsPerHour: num(process.env.BORROW_FEE_BPS_PER_HOUR, 1.2), // 0.012% = 1.2 bps per hour (official docs example)
    // Utilization rate for borrow fee calculation (default 0.198 = 19.8% from docs example)
    // In practice, this varies based on pool utilization, but we use a default for simulation
    borrowUtilizationRate: num(process.env.BORROW_UTILIZATION_RATE, 0.198), // Default 19.8% utilization (from docs example)
    
    // Solana transaction and priority fees
    // Source: https://solana.com/docs/core/fees
    // Base transaction fee: 5,000 lamports (0.000005 SOL) per signature
    // Priority fee: CU limit × CU price (optional, user-configurable)
    // Note: Rent for escrow account is refunded on position close, so not included here
    solanaTxFee: {
      // Base fee per transaction signature (in lamports)
      baseFeeLamports: num(process.env.SOLANA_BASE_FEE_LAMPORTS, 5000), // 5,000 lamports = 0.000005 SOL
      // Compute Unit (CU) limit for transaction (typical range: 200,000-400,000 for Jupiter swaps)
      cuLimit: num(process.env.SOLANA_CU_LIMIT, 200000), // Default: 200,000 CU
      // Priority fee in micro-lamports per CU (optional, network dependent)
      // Typical range: 0-100,000 micro-lamports/CU during normal conditions
      // Higher during network congestion (can reach 100,000+ micro-lamports/CU)
      priorityFeeMicroLamports: num(process.env.SOLANA_PRIORITY_FEE_MICROLAMPORTS, 0), // Default: 0 (no priority fee)
      // Enable transaction fees in backtests (default: true)
      enableTxFees: boolFrom(process.env.ENABLE_SOLANA_TX_FEES, true),
    },
  },

  // ---------- Tokens & Decimals ----------
  tokens: {
    // base tokens you trade
    SOL: process.env.SOL_MINT || 'So11111111111111111111111111111111111111112',
    ETH: process.env.ETH_MINT || '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    WBTC: process.env.WBTC_MINT || '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    // BTC alias for BTC-PERP (maps to WBTC mint)
    BTC: process.env.BTC_MINT || process.env.WBTC_MINT || '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    // common quotes
    USDC: process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: process.env.USDT_MINT || 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },

  // your quote mint (default USDC)
  quoteMint: process.env.QUOTE_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',

  tokenDecimals: {
    SOL: 9,
    ETH: 8,
    WBTC: 8,
    BTC: 8, // BTC alias uses same decimals as WBTC
    USDC: 6,
    USDT: 6,
  },

  // ---------- (Live-only) Anchor program ----------
  // Only required when you wire real perps tx; optional in paper mode
  perpsProgram: process.env.PERPS_PROGRAM || '',

  // ---------- Bot Operation ----------
  // Bot loop interval in milliseconds
  // CRITICAL: Must be >= JUP_API_MIN_MS to avoid rate limits
  // Default 15s = 4 calls/min = 240 calls/hour (safe)
  botLoopMs: num(process.env.BOT_LOOP_MS, 15000),
  // Number of warmup ticks before starting trading
  // CRITICAL: Strategy needs 100+ bars for proper indicator initialization
  // With JUP_API_MIN_MS=10s: 100 ticks = ~17 minutes warmup
  warmupTicks: num(process.env.WARMUP_TICKS, 100),
  // Volume fallback alert threshold
  volumeFallbackThreshold: num(process.env.VOLUME_FALLBACK_ALERT_THRESHOLD, 3),

  // ---------- UI Server ----------
  // Prefer platform-provided PORT (e.g., Render) and fall back to UI_PORT/local default
  uiPort: num(process.env.PORT || process.env.UI_PORT, 3000),
  wsMaxConnections: num(process.env.WS_MAX_CONNECTIONS, 100),
  messageSizeLimit: num(process.env.MESSAGE_SIZE_LIMIT, 1024 * 1024), // 1MB

  // ---------- Transaction Settings ----------
  // Market impact steps (comma-separated list of percentages 0-1)
  marketImpactSteps: (process.env.MARKET_IMPACT_STEPS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 1),
  // Priority fee settings (for live client)
  priorityFeeMicrolamps: num(process.env.PRIORITY_FEE_MICROLAMPORTS, 0),
  tipAccountsPerTx: Math.max(1, num(process.env.TIP_ACCOUNTS_PER_TX, 1)),
  closePrioritySteps: (() => {
    const steps = (process.env.CLOSE_PRIORITY_STEPS || '0,1500,5000,15000')
      .split(',')
      .map(v => Number(v.trim()))
      .filter(v => Number.isFinite(v) && v >= 0);
    return steps.length > 0 ? steps : [0]; // Default to [0] if empty
  })(),
  closeRetryDelayMs: num(process.env.CLOSE_RETRY_DELAY_MS, 1000),
  closeMaxAttempts: num(process.env.CLOSE_MAX_ATTEMPTS, null), // Will be set based on closePrioritySteps length if null
  closeKillSwitchAfter: num(process.env.CLOSE_KILL_SWITCH_AFTER, null), // Will be calculated if null

  // ---------- Strategy overrides (optional) ----------
  strategy: {
    // Enable enhanced strategy features (env-driven, tuned for "faster, but disciplined")
    enableDonchianGate: boolFrom(process.env.ENABLE_DONCHIAN_GATE, true),  // Require Donchian breakout (default: true)
    enableHTFTrend: boolFrom(process.env.ENABLE_HTF_TREND, false),
    longStrictHTF: boolFrom(process.env.LONG_STRICT_HTF, false),
    shortStrictHTF: boolFrom(process.env.SHORT_STRICT_HTF, false),
    enableVolatilityFilter: boolFrom(process.env.ENABLE_VOLATILITY_FILTER, false),
    enableSessionAwareness: boolFrom(process.env.ENABLE_SESSION_AWARENESS, false),
    enableGreenDayVeto: boolFrom(process.env.ENABLE_GREEN_DAY_VETO, false),  // Veto shorts on green trending days (default: false)
    // Time gating
    enableTimeGate: boolFrom(process.env.ENABLE_TIME_GATE, false),
    timeGateAdxThreshold: num(process.env.TIME_GATE_ADX_THRESHOLD, 25),
    // Core momentum filters
    zFilter: num(process.env.Z_FILTER, 6.0),                 // from 8.0 → 6.0 (lets more momentum through)
    // Cooldown & protection system
    enableCooldown: boolFrom(process.env.ENABLE_COOLDOWN, true), // Master toggle for time-based cooldown (default: enabled)
    cooldownMs: num(process.env.COOLDOWN_MS, 20000),         // 20s basic cooldown
    flipCooldownMs: num(process.env.FLIP_COOLDOWN_MS, 60000), // 60s flip cooldown
    flipCooldownBars: num(process.env.FLIP_COOLDOWN_BARS, 5), // 5 bars between flips (25min on 5m)
    minBarsSameSideReentry: num(process.env.MIN_BARS_SAME_SIDE_REENTRY, 3), // 3 bars before re-entering same side (15min on 5m)
    enableSameBarGuard: boolFrom(process.env.ENABLE_SAME_BAR_GUARD, true), // Prevent multiple entries within same bar
    enableEdgeTrigger: boolFrom(process.env.ENABLE_EDGE_TRIGGER, true), // Only fire signals on false→true transitions
    // RSI thresholds (env-driven) - Optimized: 60/40 (was 55/45)
    rsiLong: num(process.env.RSI_LONG, 60),      // Minimum RSI for long entries (optimized from bottleneck analysis)
    rsiShort: num(process.env.RSI_SHORT, 40),    // Maximum RSI for short entries (optimized from bottleneck analysis)
    // ADX thresholds (env-driven) - Optimized: 20 (was 15)
    adxMinTrend: num(process.env.ADX_MIN_TREND, 20),  // Minimum ADX for trend strength (optimized from bottleneck analysis)
    adxExitWeak: num(process.env.ADX_EXIT_WEAK, 20),  // Exit if ADX drops below this (match adxMinTrend)
    strictAdxMin: num(process.env.STRICT_ADX_MIN, 20),
    // Breakout confirmation
    donchianPeriod: num(process.env.DONCHIAN_PERIOD, 15),    // Optimized from heatmap analysis: best performance at 15
    donchianConfirm: num(process.env.DONCHIAN_CONFIRM, 0),   // allow touch + close breakout (no extra wait)
    maxEntryDistAtr: (() => {
      const raw = process.env.MAX_ENTRY_DIST_ATR;
      if (raw === undefined || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    })(),
    requireRetest: boolFrom(process.env.REQUIRE_RETEST, false),
    retestBars: num(process.env.RETEST_BARS, 5),
    // Trend quality
    adxPeriod: num(process.env.ADX_PERIOD, 14),
    // adxMinTrend set above (env-driven, default 20)
    requireAdxSlopeUp: boolFrom(process.env.REQUIRE_ADX_SLOPE_UP, false),
    requireMaSlopeLong: boolFrom(process.env.REQUIRE_MA_SLOPE_LONG, true),
    requireMaSlopeShort: boolFrom(process.env.REQUIRE_MA_SLOPE_SHORT, true),
    maSlopeUpMin: num(process.env.MA_SLOPE_UP_MIN, 0),        // % per bar (e.g., 0.01 = 0.01%/bar)
    maSlopeDownMax: num(process.env.MA_SLOPE_DOWN_MAX, 0),    // % per bar (e.g., -0.01 = -0.01%/bar)
    maSlopeLookback: num(process.env.MA_SLOPE_LOOKBACK, 10),  // Lookback period for slope calculation
    // ATR risk framework
    atrPeriod: num(process.env.ATR_PERIOD, 21),
    atrStopMultiplier: num(process.env.ATR_STOP_MULTIPLIER, 2.0),       // Optimized from heatmap analysis: best performance at 2.0
    atrTakeProfitMultiplier: num(process.env.ATR_TAKE_PROFIT_MULTIPLIER, 3.2), // keep RR>1
    enablePartialTake: boolFrom(process.env.ENABLE_PARTIAL_TAKE, true),
    partialAtR: num(process.env.PARTIAL_AT_R, 1.0),              // 50% off at +1R
    enableTrailingStop: boolFrom(process.env.ENABLE_TRAILING_STOP, true),
    trailATR: num(process.env.TRAIL_ATR, 1.6),                   // trail engages after partial
    enableTimeStop: boolFrom(process.env.ENABLE_TIME_STOP, true),
    timeStopBars: num(process.env.TIME_STOP_BARS, 30),          // ~2.5h on 5m
    minRToHold: num(process.env.MIN_R_TO_HOLD, 0.4),
    // Keep sensible MA/RSI defaults
    maPeriod: num(process.env.MA_PERIOD, 70),
    rsiPeriod: num(process.env.RSI_PERIOD, 12),
    // rsiLong and rsiShort set above (env-driven, defaults 60/40)
    htfMaPeriod: num(process.env.HTF_MA_PERIOD, 72),
    htfInterval: process.env.HTF_INTERVAL || '1h',
    // Distance/band
    bandPct: num(process.env.BAND_PCT, 0.0015),
    minDist: num(process.env.MIN_DIST, 0.0012),
    // Optional: re-entry features wiring (pullback/squeeze)
    enablePullbackEntry: boolFrom(process.env.ENABLE_PULLBACK_ENTRY, true),
    pullbackSizeMultiplier: num(process.env.PULLBACK_SIZE_MULTIPLIER, 0.5),
    pullbackLookbackBars: num(process.env.PULLBACK_LOOKBACK_BARS, 5),
    pullbackTouchBps: num(process.env.PULLBACK_TOUCH_BPS, 0.002), // 20 bps
    enableSqueezeEntry: boolFrom(process.env.ENABLE_SQUEEZE_ENTRY, true),
    squeezeBarsN: num(process.env.SQUEEZE_BARS_N, 6),
    squeezeAdxStart: num(process.env.SQUEEZE_ADX_START, 15),
    squeezeAdxTarget: num(process.env.SQUEEZE_ADX_TARGET, 18),
    squeezeInitialStopATR: num(process.env.SQUEEZE_INITIAL_STOP_ATR, 2.3),
    squeezeWidenToATR: num(process.env.SQUEEZE_WIDEN_TO_ATR, 2.8),
    squeezeWidenAtR: num(process.env.SQUEEZE_WIDEN_AT_R, 0.5),
    // Pyramiding winners (unchanged)
    pyramidEnable: boolFrom(process.env.PYRAMID_ENABLE, true),
    pyramidTriggerAtr: num(process.env.PYRAMID_TRIGGER_ATR, 0.7),
    pyramidAddPct: num(process.env.PYRAMID_ADD_PCT, 50),
    pyramidTrailATR: num(process.env.PYRAMID_TRAIL_ATR, 1.8),
  },

  // ---------- Per-market strategy overrides (optional) ----------
  // Configured via env vars: STRATEGY_<MARKET>_<PARAM>
  // Example: STRATEGY_SOL_PERP_ADX_MIN_TREND=30
  // Markets: SOL-PERP, BTC-PERP, ETH-PERP
  perMarketStrategy: parsePerMarketStrategyConfig(),

  // ---------- Allocator configuration ----------
  // Optimized defaults from backtest analysis (better performance than baseline)
  allocator: {
    maxPositionsPerMarket: num(process.env.ALLOCATOR_MAX_POSITIONS_PER_MARKET, 3),
    diversificationBonus: num(process.env.ALLOCATOR_DIVERSIFICATION_BONUS, 1.1),
    performanceWeight: num(process.env.ALLOCATOR_PERFORMANCE_WEIGHT, 0.45), // Optimized: 0.45 (was 0.35)
    confidenceWeight: num(process.env.ALLOCATOR_CONFIDENCE_WEIGHT, 0.30), // Optimized: 0.30 (was 0.20)
    riskAdjustedWeight: num(process.env.ALLOCATOR_RISKADJUSTED_WEIGHT, 0.15), // Optimized: 0.15 (was 0.25)
    volatilityWeight: num(process.env.ALLOCATOR_VOLATILITY_WEIGHT, 0.10), // Optimized: 0.10 (was 0.20)
    minConfidence: num(process.env.ALLOCATOR_MIN_CONFIDENCE, 0.00),
    minScore: num(process.env.ALLOCATOR_MIN_SCORE, 0.15), // Optimized: 0.15 (was 0.00)
    cooldownLossPenalty: num(process.env.ALLOCATOR_COOLDOWN_LOSS_PENALTY, -0.10),
    cooldownWinBonus: num(process.env.ALLOCATOR_COOLDOWN_WIN_BONUS, 0.10),
    cooldownWindowMs: num(process.env.ALLOCATOR_COOLDOWN_WINDOW_MS, 15 * 60 * 1000),
    exploreProbability: num(process.env.ALLOCATOR_EXPLORE_PROBABILITY, 0.03), // Optimized: 0.03 (was 0.08)
    maxCorrelatedExposure: num(process.env.ALLOCATOR_MAX_CORRELATED_EXPOSURE, 0.6),
    // Correlation matrix (majors defined, alts default to 0.5 cross-correlation)
    // Allocator code should fall back to DEFAULT_CROSS_CORRELATION for unknown pairs
    correlationMatrix: {
      'SOL-PERP': { 'ETH-PERP': 0.7, 'BTC-PERP': 0.6 },
      'ETH-PERP': { 'SOL-PERP': 0.7, 'BTC-PERP': 0.85 },
      'BTC-PERP': { 'SOL-PERP': 0.6, 'ETH-PERP': 0.85 },
    },
    defaultCrossCorrelation: num(process.env.ALLOCATOR_DEFAULT_CROSS_CORRELATION, 0.5),
  },
};
