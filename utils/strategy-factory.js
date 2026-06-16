// utils/strategy-factory.js

/**
 * Strategy Factory
 *
 * Creates and manages strategy instances (momentum, scalping, rsi-reversion).
 * Handles strategy switching, per-market overrides, and multi-strategy mode.
 *
 * Usage (single-strategy mode):
 *   const factory = new StrategyFactory(config);
 *   const strategy = factory.createStrategy(market);
 *   const signal = strategy.getSignal(price, positions);
 *
 * Usage (multi-strategy mode):
 *   const factory = new StrategyFactory(config);
 *   const strategies = factory.createAllStrategies(market);
 *   // strategies = [{ type: 'momentum', strategy }, { type: 'rsi-reversion', strategy }]
 */

const EnhancedMomentumStrategy = require("../enhanced-momentum-strategy");
const ScalpingStrategy = require("../scalping-strategy");
const RsiMeanReversionStrategy = require("../enhanced-momentum-rsi-strategy");
const BtcBreakoutStrategy = require("../btc-breakout-strategy");
const IchimokuCloudBreakoutStrategy = require("../ichimoku-cloud-breakout-strategy");
const CopyTradingStrategy = require("../copy-trading-strategy");
const CopyTradingMetaStrategy = require("../copy-trading-meta-strategy");
const CopyTradingEventStrategy = require("../copy-trading-event-strategy");
const { getCopyTradingConsensusProvider } = require("./copy-trading-consensus-provider");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

// Unified strategy environment manager - preferred for isolated env snapshots
let strategyEnvManager = null;
try {
  strategyEnvManager = require("./strategy-env-manager");
} catch (e) {
  // Fall back to local implementation
}

class StrategyFactory {
  constructor(config = {}) {
    this.config = config;

    // Strategy type (global default for single-strategy mode)
    this.defaultStrategyType = config.strategyType || "momentum";

    // Multi-strategy mode
    this.multiStrategyMode = config.multiStrategyMode || false;

    // Strategy enablement (for multi-strategy mode)
    this.enabledStrategies = {
      momentum: config.enableMomentumStrategy !== false, // Default: true
      scalping: config.enableScalpingStrategy === true, // Default: false
      "rsi-reversion": config.enableRsiReversionStrategy === true, // Default: false
      "rsi-reversion-alt": config.enableRsiReversionAltsStrategy === true, // Default: false
      "btc-breakout": config.enableBtcBreakoutStrategy === true, // Default: false
      "ichimoku-cloud": config.enableIchimokuStrategy === true, // Default: false
      "copy-trading": config.enableCopyTradingStrategy === true, // Default: false
    };

    // Strategy class registry
    this.strategyClasses = {
      momentum: EnhancedMomentumStrategy,
      scalping: ScalpingStrategy,
      "rsi-reversion": RsiMeanReversionStrategy,
      "rsi-reversion-alt": RsiMeanReversionStrategy, // same strategy implementation, separate identity/config
      "btc-breakout": BtcBreakoutStrategy,
      "ichimoku-cloud": IchimokuCloudBreakoutStrategy,
      "copy-trading": CopyTradingStrategy,
    };

    // Per-market strategy overrides (single-strategy mode)
    this.strategyTypePerMarket = config.strategyTypePerMarket || {};

    // Per-strategy env snapshots (critical for multi-strategy mode; avoids env clobbering)
    this._envSnapshots = {
      "rsi-reversion": this._loadEnvSnapshot(".env.rsi-reversion"),
      "rsi-reversion-alt": this._loadEnvSnapshot(".env.rsi-reversion-alts"),
      "btc-breakout": this._loadEnvSnapshot(".env.btc-breakout"),
      "ichimoku-cloud": this._loadEnvSnapshot(".env.ichimoku"),
      "copy-trading": this._loadEnvSnapshot(".env.copy-trading"),
    };

    // Per-market strategy enablement (multi-strategy mode)
    // Format: { 'rsi-reversion': ['ETH-PERP', 'SOL-PERP'], 'rsi-reversion-alt': ['DOGE-PERP'], 'scalping': ['BTC-PERP'] }
    this.strategyMarkets = this._parseStrategyMarkets(config);

    // Strategy instances cache
    // Single-strategy: market -> { type, instance }
    // Multi-strategy: market -> [{ type, instance }, ...]
    this.strategyInstances = new Map();

    // Strategy configurations
    this.momentumConfig = this._extractMomentumConfig(config);
    this.scalpingConfig = this._extractScalpingConfig(config);
    this.rsiReversionConfig = this._extractRsiReversionConfigFromEnv(
      this._envForStrategy("rsi-reversion")
    );
    this.rsiReversionAltConfig = this._extractRsiReversionConfigFromEnv(
      this._envForStrategy("rsi-reversion-alt")
    );
    this.btcBreakoutConfig = this._extractBtcBreakoutConfigFromEnv(
      this._envForStrategy("btc-breakout")
    );
    this.ichimokuConfig = this._extractIchimokuConfigFromEnv(
      this._envForStrategy("ichimoku-cloud")
    );
    this.copyTradingConfig = this._extractCopyTradingConfigFromEnv(
      this._envForStrategy("copy-trading")
    );
    this._copyTradingProvider = null;

    console.log("[StrategyFactory] Initialized");
    console.log(`[StrategyFactory] Multi-strategy mode: ${this.multiStrategyMode}`);
    console.log(`[StrategyFactory] Default strategy: ${this.defaultStrategyType}`);
    if (this.multiStrategyMode) {
      const enabled = Object.entries(this.enabledStrategies)
        .filter(([_, v]) => v)
        .map(([k]) => k);
      console.log(`[StrategyFactory] Enabled strategies: ${enabled.join(", ")}`);
    }
    console.log(`[StrategyFactory] Per-market overrides:`, this.strategyTypePerMarket);
    if (this.multiStrategyMode && Object.keys(this.strategyMarkets).length > 0) {
      console.log(`[StrategyFactory] Per-market strategy enablement:`, this.strategyMarkets);
    }
  }

  /**
   * Load an env overlay from disk into an object WITHOUT mutating process.env.
   * File values take precedence to ensure per-strategy configs like STRATEGY_MARKETS
   * are isolated. Global/secret keys (like API keys) come from Render Secret Files,
   * not env vars, so this merge order is correct.
   */
  _loadEnvSnapshot(envFile) {
    try {
      const envPath = path.join(process.cwd(), envFile);
      if (!fs.existsSync(envPath)) return { ...process.env };
      const raw = fs.readFileSync(envPath, "utf8");
      const parsed = dotenv.parse(raw);
      // File values take precedence so each strategy gets its own STRATEGY_MARKETS,
      // thresholds, etc. process.env provides defaults for keys not in the file.
      return { ...process.env, ...parsed };
    } catch {
      return { ...process.env };
    }
  }

  _envForStrategy(strategyType) {
    // Prefer the unified strategy-env-manager if available
    if (strategyEnvManager) {
      const env = strategyEnvManager.getEnvForStrategy(strategyType);
      if (env !== process.env) return env;
    }

    // Fall back to local snapshots
    if (strategyType === "rsi-reversion") return this._envSnapshots["rsi-reversion"] || process.env;
    if (strategyType === "rsi-reversion-alt")
      return this._envSnapshots["rsi-reversion-alt"] || process.env;
    if (strategyType === "btc-breakout")
      return this._envSnapshots["btc-breakout"] || process.env;
    if (strategyType === "ichimoku-cloud")
      return this._envSnapshots["ichimoku-cloud"] || process.env;
    if (strategyType === "copy-trading") return this._envSnapshots["copy-trading"] || process.env;
    return process.env;
  }

  /**
   * Parse per-market strategy enablement from config/env
   * Supports env vars like: RSI_REVERSION_MARKETS=ETH-PERP,SOL-PERP
   * @returns {Object} Map of strategy type -> array of markets
   */
  _parseStrategyMarkets(config) {
    const strategyMarkets = {};

    const parseList = (raw) =>
      String(raw || "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
        .map((m) => (m.includes("-PERP") ? m : `${m}-PERP`));

    // Multi-strategy mode: prefer per-strategy STRATEGY_MARKETS from overlay snapshots
    if (this.multiStrategyMode) {
      const assignMarkets = (strategyType) => {
        if (this.enabledStrategies[strategyType] !== true) return;
        const env = this._envForStrategy(strategyType);
        const markets = parseList(env.STRATEGY_MARKETS || env.MARKETS);
        if (markets.length > 0) {
          strategyMarkets[strategyType] = markets;
        }
      };

      assignMarkets("rsi-reversion");
      assignMarkets("rsi-reversion-alt");
      assignMarkets("btc-breakout");
      assignMarkets("ichimoku-cloud");
      assignMarkets("copy-trading");
    } else {
      // Legacy: Parse RSI-reversion markets from env var
      const rsiMarkets = process.env.RSI_REVERSION_MARKETS || config.rsiReversionMarkets;
      if (rsiMarkets) {
        const markets = parseList(rsiMarkets);
        if (markets.length > 0) strategyMarkets["rsi-reversion"] = markets;
      }
    }

    // Parse scalping markets (for future use)
    const scalpingMarkets = process.env.SCALPING_MARKETS || config.scalpingMarkets;
    if (scalpingMarkets) {
      const markets = parseList(scalpingMarkets);
      if (markets.length > 0) {
        strategyMarkets["scalping"] = markets;
      }
    }

    // Parse Ichimoku markets (single-strategy mode; optional)
    const ichimokuMarkets = process.env.ICHIMOKU_MARKETS || config.ichimokuMarkets;
    if (ichimokuMarkets) {
      const markets = parseList(ichimokuMarkets);
      if (markets.length > 0) {
        strategyMarkets["ichimoku-cloud"] = markets;
      }
    }

    const breakoutMarkets = process.env.BTC_BREAKOUT_MARKETS || config.btcBreakoutMarkets;
    if (breakoutMarkets) {
      const markets = parseList(breakoutMarkets);
      if (markets.length > 0) {
        strategyMarkets["btc-breakout"] = markets;
      }
    }

    return strategyMarkets;
  }

  /**
   * Check if a strategy should be enabled for a specific market
   * @param {string} strategyType - Strategy type
   * @param {string} market - Market symbol
   * @returns {boolean} True if strategy should be enabled for this market
   */
  _isStrategyEnabledForMarket(strategyType, market) {
    // Multi-strategy mode should NEVER "bleed" an enabled strategy onto all markets
    // just because a market list wasn't provided. Each enabled strategy must have
    // an explicit market list (STRATEGY_MARKETS/MARKETS in its overlay file).
    if (this.multiStrategyMode) {
      if (this.enabledStrategies[strategyType] !== true) return false;
      const markets = this.strategyMarkets?.[strategyType];
      return Array.isArray(markets) && markets.includes(market);
    }

    // If no per-market restriction, use global enablement
    if (!this.strategyMarkets[strategyType]) {
      return this.enabledStrategies[strategyType] === true;
    }

    // Check if market is in the allowed list
    return this.strategyMarkets[strategyType].includes(market);
  }

  /**
   * Get list of enabled strategy types
   * @returns {string[]} Array of enabled strategy type names
   */
  getEnabledStrategies() {
    return Object.entries(this.enabledStrategies)
      .filter(([_, enabled]) => enabled)
      .map(([type]) => type);
  }

  /**
   * Create ALL enabled strategies for a market (multi-strategy mode)
   *
   * @param {string} market - Market symbol (e.g., 'SOL-PERP')
   * @param {Object} options - Additional options
   * @returns {Array<{type: string, strategy: Object}>} Array of strategy instances
   */
  createAllStrategies(market, options = {}) {
    if (!this.multiStrategyMode) {
      // Fallback to single-strategy mode
      const strategy = this.createStrategy(market, options);
      const type = this._getStrategyTypeForMarket(market);
      return [{ type, strategy }];
    }

    // Check cache
    const cached = this.strategyInstances.get(market);
    if (cached && Array.isArray(cached)) {
      return cached;
    }

    // Create instances for all enabled strategies (filtered by per-market enablement)
    const strategies = [];
    const enabledTypes = this.getEnabledStrategies();

    for (const type of enabledTypes) {
      // Check if this strategy should be enabled for this specific market
      if (!this._isStrategyEnabledForMarket(type, market)) {
        continue; // Skip this strategy for this market
      }

      const instance = this._createStrategyInstance(type, market, options);
      strategies.push({ type, strategy: instance });
    }

    // Cache
    this.strategyInstances.set(market, strategies);

    const createdTypes = strategies.map((s) => s.type);
    console.log(
      `[StrategyFactory] Created ${strategies.length} strategies for ${market}: ${createdTypes.join(", ")}`
    );

    return strategies;
  }

  /**
   * Create a strategy instance for a market
   *
   * @param {string} market - Market symbol (e.g., 'SOL-PERP')
   * @param {Object} options - Additional options
   * @returns {Object} Strategy instance
   */
  createStrategy(market, options = {}) {
    // Determine strategy type for this market
    const strategyType = this._getStrategyTypeForMarket(market);

    // Check if we already have an instance
    const cached = this.strategyInstances.get(market);
    if (cached && cached.type === strategyType) {
      return cached.instance;
    }

    // Create new instance
    const instance = this._createStrategyInstance(strategyType, market, options);

    // Cache it
    this.strategyInstances.set(market, {
      type: strategyType,
      instance,
    });

    console.log(`[StrategyFactory] Created ${strategyType} strategy for ${market}`);

    return instance;
  }

  /**
   * Get strategy type for a market
   *
   * @param {string} market - Market symbol
   * @returns {string} Strategy type ('momentum' or 'scalping')
   */
  _getStrategyTypeForMarket(market) {
    // Check per-market override
    if (this.strategyTypePerMarket[market]) {
      return this.strategyTypePerMarket[market];
    }

    // Multi-strategy mode: prefer explicit per-strategy market enablement.
    // This repo convention is "never run the same market on multiple strategies",
    // so in practice this should resolve to a single strategy.
    if (
      this.multiStrategyMode &&
      this.strategyMarkets &&
      Object.keys(this.strategyMarkets).length
    ) {
      const matches = [];
      for (const [type, markets] of Object.entries(this.strategyMarkets)) {
        if (this.enabledStrategies[type] !== true) continue;
        if (Array.isArray(markets) && markets.includes(market)) matches.push(type);
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const primaryMatches = matches.includes("copy-trading")
          ? matches.filter((t) => t !== "copy-trading")
          : matches;
        // Deterministic fallback if misconfigured: prefer ichimoku for majors, RSI for alts.
        try {
          const venueRouter = require("./venue-router");
          if (venueRouter?.isMajor?.(market)) {
            if (primaryMatches.includes("btc-breakout")) return "btc-breakout";
            if (primaryMatches.includes("ichimoku-cloud")) return "ichimoku-cloud";
          } else {
            if (primaryMatches.includes("rsi-reversion-alt")) return "rsi-reversion-alt";
            if (primaryMatches.includes("rsi-reversion")) return "rsi-reversion";
          }
        } catch (_) {
          // ignore
        }
        primaryMatches.sort();
        return primaryMatches[0];
      }
    }

    // Default fallback (single-strategy mode or no per-market mapping)
    return this.defaultStrategyType;
  }

  /**
   * Create strategy instance
   *
   * @param {string} strategyType - 'momentum', 'scalping', or 'rsi-reversion'
   * @param {string} market - Market symbol
   * @param {Object} options - Additional options
   * @returns {Object} Strategy instance
   */
  _createStrategyInstance(strategyType, market, options = {}) {
    if (strategyType === "scalping") {
      return new ScalpingStrategy({
        ...this.scalpingConfig,
        ...options,
        market,
      });
    } else if (strategyType === "momentum") {
      const { strategy: optionStrategy, ...restOptions } = options || {};
      const baseConfig = {
        ...this.momentumConfig,
        ...restOptions,
        market,
      };

      const mergedStrategy = {
        ...(this.momentumConfig.strategy || {}),
        ...(optionStrategy || {}),
      };

      const perMarketOverrides = this.config.perMarketStrategy?.[market];
      if (perMarketOverrides && typeof perMarketOverrides === "object") {
        Object.assign(mergedStrategy, perMarketOverrides);
      }

      baseConfig.strategy = mergedStrategy;

      return new EnhancedMomentumStrategy(baseConfig);
    } else if (strategyType === "rsi-reversion" || strategyType === "rsi-reversion-alt") {
      const env = this._envForStrategy(strategyType);
      const baseRsiConfig =
        strategyType === "rsi-reversion-alt" ? this.rsiReversionAltConfig : this.rsiReversionConfig;

      // Build RSI config with per-market overrides (matching momentum pattern)
      const { rsiStrategy: optionRsiStrategy, ...restOptions } = options || {};
      const baseConfig = {
        ...baseRsiConfig,
        ...restOptions,
        market,
      };

      // Start with global RSI config, merge any options, then apply per-market overrides
      // This matches how momentum handles config.strategy
      const mergedRsiStrategy = {
        ...(baseRsiConfig.rsiStrategy || {}),
        ...(optionRsiStrategy || {}),
      };

      // Apply per-market RSI threshold overrides from env vars
      // Format: STRATEGY_{MARKET}_RSI_OVERBOUGHT_EXTREME, etc.
      const marketKey = market.replace("-", "_"); // SOL-PERP -> SOL_PERP

      const hasEnvVal = (v) => v !== undefined && v !== "";
      const envNum = (v) => {
        if (!hasEnvVal(v)) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      // Read per-market overrides
      const rsiOversoldExtreme = env[`STRATEGY_${marketKey}_RSI_OVERSOLD_EXTREME`];
      if (hasEnvVal(rsiOversoldExtreme))
        mergedRsiStrategy.rsiOversoldExtreme = Number(rsiOversoldExtreme);

      const rsiOversoldRecovery = env[`STRATEGY_${marketKey}_RSI_OVERSOLD_RECOVERY`];
      if (hasEnvVal(rsiOversoldRecovery))
        mergedRsiStrategy.rsiOversoldRecovery = Number(rsiOversoldRecovery);

      const rsiOverboughtExtreme = env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_EXTREME`];
      if (hasEnvVal(rsiOverboughtExtreme))
        mergedRsiStrategy.rsiOverboughtExtreme = Number(rsiOverboughtExtreme);

      const rsiOverboughtRecovery = env[`STRATEGY_${marketKey}_RSI_OVERBOUGHT_RECOVERY`];
      if (hasEnvVal(rsiOverboughtRecovery))
        mergedRsiStrategy.rsiOverboughtRecovery = Number(rsiOverboughtRecovery);

      // Per-market entry window controls
      // - RSI_ENTRY_MAX_BARS: how long after the extreme we allow a recovery-entry
      // - RSI_ENTRY_MAX_DEVIATION: how many RSI points past recovery we still allow for entry
      //
      // Support both:
      // - STRATEGY_BTC_PERP_RSI_ENTRY_MAX_DEVIATION (preferred; matches marketKey)
      // - STRATEGY_BTC_RSI_ENTRY_MAX_DEVIATION (legacy; without -PERP suffix)
      const marketBaseKey = marketKey.replace(/_PERP$/i, ""); // BTC_PERP -> BTC

      const rsiEntryMaxBars =
        env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_BARS`] ??
        env[`STRATEGY_${marketBaseKey}_RSI_ENTRY_MAX_BARS`];
      if (hasEnvVal(rsiEntryMaxBars)) mergedRsiStrategy.rsiEntryMaxBars = Number(rsiEntryMaxBars);

      const rsiEntryMaxDeviation =
        env[`STRATEGY_${marketKey}_RSI_ENTRY_MAX_DEVIATION`] ??
        env[`STRATEGY_${marketBaseKey}_RSI_ENTRY_MAX_DEVIATION`];
      if (hasEnvVal(rsiEntryMaxDeviation))
        mergedRsiStrategy.rsiEntryMaxDeviation = Number(rsiEntryMaxDeviation);

      const rsiTargetNeutral = env[`STRATEGY_${marketKey}_RSI_TARGET_NEUTRAL`];
      if (hasEnvVal(rsiTargetNeutral))
        mergedRsiStrategy.rsiTargetNeutral = Number(rsiTargetNeutral);

      const rsiTargetLong = env[`STRATEGY_${marketKey}_RSI_TARGET_LONG`];
      if (hasEnvVal(rsiTargetLong)) mergedRsiStrategy.rsiTargetLong = Number(rsiTargetLong);

      const rsiTargetShort = env[`STRATEGY_${marketKey}_RSI_TARGET_SHORT`];
      if (hasEnvVal(rsiTargetShort)) mergedRsiStrategy.rsiTargetShort = Number(rsiTargetShort);

      const hardStopPercent = env[`STRATEGY_${marketKey}_HARD_STOP_PERCENT`];
      if (hasEnvVal(hardStopPercent))
        mergedRsiStrategy.rsiHardStopPercent = Number(hardStopPercent);

      // Per-market hard stop ATR multiplier (0 disables ATR mode; uses percent stop if configured)
      // Matches backtest and docs: STRATEGY_<MKT>_HARD_STOP_ATR overrides RSI_HARD_STOP_ATR
      const hardStopAtr = env[`STRATEGY_${marketKey}_HARD_STOP_ATR`];
      if (hasEnvVal(hardStopAtr)) mergedRsiStrategy.rsiHardStopAtr = Number(hardStopAtr);

      const leverage = env[`STRATEGY_${marketKey}_LEVERAGE`];
      if (hasEnvVal(leverage)) mergedRsiStrategy.leverage = Number(leverage);

      // Per-market RSI failure levels (stop loss triggers)
      const rsiFailureLong = env[`STRATEGY_${marketKey}_RSI_FAILURE_LONG`];
      if (hasEnvVal(rsiFailureLong)) mergedRsiStrategy.rsiFailureLong = Number(rsiFailureLong);

      const rsiFailureShort = env[`STRATEGY_${marketKey}_RSI_FAILURE_SHORT`];
      if (hasEnvVal(rsiFailureShort)) mergedRsiStrategy.rsiFailureShort = Number(rsiFailureShort);

      // Per-market RSI partial targets
      const rsiPartialTargetLong = env[`STRATEGY_${marketKey}_RSI_PARTIAL_TARGET_LONG`];
      if (hasEnvVal(rsiPartialTargetLong))
        mergedRsiStrategy.rsiPartialTargetLong = Number(rsiPartialTargetLong);

      const rsiPartialTargetShort = env[`STRATEGY_${marketKey}_RSI_PARTIAL_TARGET_SHORT`];
      if (hasEnvVal(rsiPartialTargetShort))
        mergedRsiStrategy.rsiPartialTargetShort = Number(rsiPartialTargetShort);

      // Per-market time stop and ATR
      const rsiTimeStopBars = env[`STRATEGY_${marketKey}_RSI_TIME_STOP_BARS`];
      if (hasEnvVal(rsiTimeStopBars)) mergedRsiStrategy.rsiTimeStopBars = Number(rsiTimeStopBars);

      const atrPeriod = env[`STRATEGY_${marketKey}_ATR_PERIOD`];
      if (hasEnvVal(atrPeriod)) mergedRsiStrategy.atrPeriod = Number(atrPeriod);

      // Per-market RSI period override
      const rsiPeriod = env[`STRATEGY_${marketKey}_RSI_PERIOD`];
      if (hasEnvVal(rsiPeriod)) mergedRsiStrategy.rsiPeriod = Number(rsiPeriod);

      // Per-market ADX filter overrides
      const minAdx = env[`STRATEGY_${marketKey}_MIN_ADX`];
      if (hasEnvVal(minAdx)) mergedRsiStrategy.rsiMinAdx = Number(minAdx);

      const maxAdx = env[`STRATEGY_${marketKey}_MAX_ADX`];
      if (hasEnvVal(maxAdx)) mergedRsiStrategy.rsiMaxAdx = Number(maxAdx);

      // Log ADX filter config explicitly (critical for validating production behavior)
      console.log(
        `[StrategyFactory] RSI ADX filter for ${market}: min=${mergedRsiStrategy.rsiMinAdx ?? 0}, ` +
          `max=${mergedRsiStrategy.rsiMaxAdx ?? 100}`
      );

      // Per-market volatility filter overrides
      const minVolatilityPct = env[`STRATEGY_${marketKey}_MIN_VOLATILITY_PCT`];
      if (hasEnvVal(minVolatilityPct))
        mergedRsiStrategy.rsiMinVolatilityPct = Number(minVolatilityPct);

      const maxVolatilityPct = env[`STRATEGY_${marketKey}_MAX_VOLATILITY_PCT`];
      if (hasEnvVal(maxVolatilityPct))
        mergedRsiStrategy.rsiMaxVolatilityPct = Number(maxVolatilityPct);

      // Log final config being passed to strategy
      console.log(
        `[StrategyFactory] RSI config for ${market}: rsiPeriod=${mergedRsiStrategy.rsiPeriod}, atrPeriod=${mergedRsiStrategy.atrPeriod}, overbought=${mergedRsiStrategy.rsiOverboughtExtreme}→${mergedRsiStrategy.rsiOverboughtRecovery}, oversold=${mergedRsiStrategy.rsiOversoldExtreme}→${mergedRsiStrategy.rsiOversoldRecovery}`
      );
      console.log(
        `[StrategyFactory] RSI entries for ${market}: maxBars=${mergedRsiStrategy.rsiEntryMaxBars}, maxDeviation=${mergedRsiStrategy.rsiEntryMaxDeviation}`
      );
      console.log(
        `[StrategyFactory] RSI exits for ${market}: target_long=${mergedRsiStrategy.rsiTargetLong ?? "null"}, target_short=${mergedRsiStrategy.rsiTargetShort ?? "null"}, neutral=${mergedRsiStrategy.rsiTargetNeutral}`
      );
      console.log(
        `[StrategyFactory] RSI stops for ${market}: hardStopPercent=${mergedRsiStrategy.rsiHardStopPercent}%, leverage=${mergedRsiStrategy.leverage ?? "default"}, volFilter=${mergedRsiStrategy.rsiMinVolatilityPct}-${mergedRsiStrategy.rsiMaxVolatilityPct}%`
      );

      // Set rsiStrategy on baseConfig (constructor reads from config.rsiStrategy)
      baseConfig.rsiStrategy = mergedRsiStrategy;

      return new RsiMeanReversionStrategy(baseConfig);
    } else if (strategyType === "btc-breakout") {
      const env = this._envForStrategy(strategyType);
      const baseBreakoutConfig =
        this.btcBreakoutConfig || this._extractBtcBreakoutConfigFromEnv(env);
      const { breakoutStrategy: optionBreakoutStrategy, ...restOptions } = options || {};
      const baseConfig = {
        ...baseBreakoutConfig,
        ...restOptions,
        market,
      };
      const mergedBreakout = {
        ...(baseBreakoutConfig.breakoutStrategy || {}),
        ...(optionBreakoutStrategy || {}),
      };

      const marketKey = market.replace(/-/g, "_");
      const hasEnvVal = (v) => v !== undefined && v !== "";
      const getPerMarket = (key) => env[`STRATEGY_${marketKey}_${key}`];
      const applyNum = (key, targetKey) => {
        const v = getPerMarket(key);
        if (hasEnvVal(v)) mergedBreakout[targetKey] = Number(v);
      };
      const applyBool = (key, targetKey) => {
        const v = getPerMarket(key);
        if (hasEnvVal(v)) mergedBreakout[targetKey] = String(v).toLowerCase() === "true";
      };
      const applyString = (key, targetKey) => {
        const v = getPerMarket(key);
        if (hasEnvVal(v)) mergedBreakout[targetKey] = String(v);
      };

      applyNum("BREAKOUT_TREND_EMA_PERIOD", "trendEmaPeriod");
      applyNum("BREAKOUT_TREND_SLOPE_LOOKBACK", "trendSlopeLookback");
      applyNum("BREAKOUT_TREND_SLOPE_THRESHOLD", "trendSlopeThreshold");
      applyNum("BREAKOUT_ENTRY_CHANNEL", "entryChannel");
      applyBool("BREAKOUT_CONFIRM_CLOSE_ONLY", "confirmCloseOnly");
      applyBool("BREAKOUT_REQUIRE_VOLUME_CONFIRMATION", "requireVolumeConfirmation");
      applyNum("BREAKOUT_VOLUME_LOOKBACK", "volumeLookback");
      applyNum("BREAKOUT_VOLUME_SPIKE_THRESHOLD", "volumeSpikeThreshold");
      applyString("BREAKOUT_ENTRY_MODE", "entryMode");
      applyNum("BREAKOUT_ENTRY_BUFFER_BPS", "entryBufferBps");
      applyNum("BREAKOUT_MAX_ENTRY_DIST_ATR", "maxEntryDistAtr");
      applyNum("BREAKOUT_MIN_BAR_RANGE_ATR", "breakoutMinBarRangeAtr");
      applyNum("BREAKOUT_MIN_CLOSE_LOCATION", "breakoutMinCloseLocation");
      applyNum("BREAKOUT_MIN_VOLUME_RATIO", "breakoutMinVolumeRatio");
      applyNum("BREAKOUT_MIN_BREAK_DISTANCE_ATR", "breakoutMinBreakDistanceAtr");
      applyNum("BREAKOUT_PULLBACK_RETEST_ATR", "pullbackRetestAtr");
      applyNum("BREAKOUT_PULLBACK_SETUP_EXPIRY_BARS", "pullbackSetupExpiryBars");
      applyNum("BREAKOUT_FIB_RETRACE_LEVEL", "fibRetraceLevel");
      applyNum("BREAKOUT_FIB_POCKET_LOWER_LEVEL", "fibPocketLowerLevel");
      applyNum("BREAKOUT_FIB_ZONE_SHALLOW_LEVEL", "fibZoneShallowLevel");
      applyNum("BREAKOUT_FIB_ZONE_MID_LEVEL", "fibZoneMidLevel");
      applyNum("BREAKOUT_FIB_ZONE_DEEP_LEVEL", "fibZoneDeepLevel");
      applyNum("BREAKOUT_FIB_INVALIDATION_LEVEL", "fibInvalidationLevel");
      applyNum("BREAKOUT_FIB_CONFIRM_CLOSE_LOCATION", "fibRetraceConfirmCloseLocation");
      applyNum("BREAKOUT_FIB_SWING_LOOKBACK_BARS", "fibSwingLookbackBars");
      applyNum("BREAKOUT_FIB_SWING_PIVOT_STRENGTH", "fibSwingPivotStrength");
      applyNum("BREAKOUT_FIB_MIN_SWING_RANGE_ATR", "fibMinSwingRangeAtr");
      applyBool("BREAKOUT_FIB_REQUIRE_CONFIRMED_SWING", "fibRequireConfirmedSwing");
      applyNum("BREAKOUT_FIB_MIN_CONFLUENCE_COUNT", "fibMinConfluenceCount");
      applyNum("BREAKOUT_FIB_CONFLUENCE_TOLERANCE_ATR", "fibConfluenceToleranceAtr");
      applyBool(
        "BREAKOUT_FIB_USE_BREAKOUT_LEVEL_CONFLUENCE",
        "fibUseBreakoutLevelConfluence"
      );
      applyBool("BREAKOUT_FIB_USE_EMA_CONFLUENCE", "fibUseEmaConfluence");
      applyBool(
        "BREAKOUT_FIB_USE_ANCHORED_VWAP_CONFLUENCE",
        "fibUseAnchoredVwapConfluence"
      );
      applyString("BREAKOUT_FIB_ANCHORED_VWAP_SOURCE", "fibAnchoredVwapSource");

      applyNum("BREAKOUT_EXIT_CHANNEL", "exitChannel");
      applyBool("BREAKOUT_ENABLE_OPPOSITE_CHANNEL_EXIT", "enableOppositeChannelExit");
      applyBool("BREAKOUT_ENABLE_REGIME_FAILURE_EXIT", "enableRegimeFailureExit");
      applyString("BREAKOUT_REGIME_FAILURE_MODE", "regimeFailureMode");
      applyBool("BREAKOUT_ENABLE_ATR_TRAIL", "enableAtrTrail");
      applyNum("BREAKOUT_ATR_TRAIL_MULT", "atrTrailMult");
      applyNum("BREAKOUT_TIME_STOP_BARS", "timeStopBars");
      applyBool("BREAKOUT_STALE_TIME_STOP_ENABLED", "staleTimeStopEnabled");
      applyNum("BREAKOUT_STALE_TIME_STOP_MIN_PROFIT_ATR", "staleTimeStopMinProfitAtr");
      applyBool(
        "BREAKOUT_STALE_TIME_STOP_REQUIRE_TREND_FAILURE",
        "staleTimeStopRequireTrendFailure"
      );
      applyBool("BREAKOUT_ENABLE_PARTIAL_EXIT", "enablePartialExit");
      applyNum("BREAKOUT_PARTIAL_AT_R", "partialAtR");
      applyNum("BREAKOUT_PARTIAL_EXIT_PERCENT", "partialExitPercent");
      applyBool("BREAKOUT_REQUIRE_PROFIT_FOR_EXIT", "requireProfitForExit");

      applyBool("BREAKOUT_HARD_STOP_ENABLED", "hardStopEnabled");
      applyNum("BREAKOUT_HARD_STOP_PERCENT", "hardStopPercent");
      applyNum("BREAKOUT_ATR_STOP_MULT", "atrStopMult");
      applyNum("BREAKOUT_ATR_PERIOD", "atrPeriod");
      applyNum("ATR_PERIOD", "atrPeriod");

      applyNum("BREAKOUT_MIN_VOLATILITY_PCT", "minVolatilityPct");
      applyNum("BREAKOUT_MAX_VOLATILITY_PCT", "maxVolatilityPct");
      applyBool("BREAKOUT_REGIME_FILTER_ENABLED", "regimeFilterEnabled");
      applyNum("BREAKOUT_REGIME_EMA_PERIOD", "regimeEmaPeriod");
      applyNum("BREAKOUT_REGIME_SLOPE_LOOKBACK", "regimeSlopeLookback");
      applyNum("BREAKOUT_REGIME_SLOPE_THRESHOLD", "regimeSlopeThreshold");

      applyBool("ALLOW_LONGS", "allowLongs");
      applyBool("ALLOW_SHORTS", "allowShorts");
      applyNum("BREAKOUT_MAX_CONSECUTIVE_LOSSES", "maxConsecutiveLosses");
      applyNum("BREAKOUT_CIRCUIT_BREAKER_COOLDOWN_MS", "circuitBreakerCooldownMs");
      applyBool("BREAKOUT_DYNAMIC_CONFIDENCE", "dynamicConfidence");
      applyNum("BREAKOUT_DYNAMIC_CONFIDENCE_BASE", "dynamicConfidenceBase");
      applyNum("BREAKOUT_DYNAMIC_CONFIDENCE_SCALE", "dynamicConfidenceScale");

      applyBool("ENABLE_COOLDOWN", "enableCooldown");
      applyNum("COOLDOWN_MS", "cooldownMs");
      applyNum("COOLDOWN_LONG_MS", "cooldownLongMs");
      applyNum("COOLDOWN_SHORT_MS", "cooldownShortMs");
      applyNum("FLIP_COOLDOWN_MS", "flipCooldownMs");
      applyNum("MIN_BARS_SAME_SIDE_REENTRY", "minBarsSameSideReentry");
      applyString("TRADING_DISABLED_HOURS_UTC", "tradingDisabledHoursUtc");
      applyString("TRADING_ALLOWED_HOURS_UTC", "tradingAllowedHoursUtc");

      applyNum("POSITION_SIZE_PERCENT", "positionSizePercent");
      applyNum("VOLATILITY_SCALE_BASE", "volatilityScaleBase");
      applyNum("RISK_PER_TRADE_PERCENT", "riskPerTradePercent");
      applyNum("MIN_POSITION_SIZE", "minPositionSize");
      applyNum("MAX_POSITION_SIZE", "maxPositionSize");
      applyNum("MIN_BARS", "minBars");

      console.log(
        `[StrategyFactory] BTC-Breakout config for ${market}: trendEma=${mergedBreakout.trendEmaPeriod}, entry=${mergedBreakout.entryChannel}, exit=${mergedBreakout.exitChannel}, atr=${mergedBreakout.atrPeriod}, dirs=${mergedBreakout.allowLongs ? "L" : "-"}${mergedBreakout.allowShorts ? "S" : "-"}`
      );

      baseConfig.breakoutStrategy = mergedBreakout;
      return new BtcBreakoutStrategy(baseConfig);
    } else if (strategyType === "ichimoku-cloud") {
      const env = this._envForStrategy(strategyType);
      const baseIchiConfig = this.ichimokuConfig || this._extractIchimokuConfigFromEnv(env);
      const { ichimokuStrategy: optionIchimokuStrategy, ...restOptions } = options || {};
      const baseConfig = {
        ...baseIchiConfig,
        ...restOptions,
        market,
      };
      const mergedIchimoku = {
        ...(baseIchiConfig.ichimokuStrategy || {}),
        ...(optionIchimokuStrategy || {}),
      };

      const marketKey = market.replace("-", "_");
      const hasEnvVal = (v) => v !== undefined && v !== "";
      const applyNum = (key, targetKey) => {
        const v = env[`STRATEGY_${marketKey}_${key}`];
        if (hasEnvVal(v)) mergedIchimoku[targetKey] = Number(v);
      };
      const applyBool = (key, targetKey) => {
        const v = env[`STRATEGY_${marketKey}_${key}`];
        if (hasEnvVal(v)) mergedIchimoku[targetKey] = String(v).toLowerCase() === "true";
      };

      // Core Ichimoku structure (allow per-market tuning when needed)
      applyNum("ICHIMOKU_TENKAN_PERIOD", "tenkanPeriod");
      applyNum("ICHIMOKU_KIJUN_PERIOD", "kijunPeriod");
      applyNum("ICHIMOKU_SENKOU_B_PERIOD", "senkouBPeriod");
      applyNum("ICHIMOKU_SHIFT", "shift");
      applyNum("ICHIMOKU_MIN_BARS", "minBars");
      applyNum("ICHIMOKU_ADX_PERIOD", "adxPeriod");
      applyNum("ICHIMOKU_ADX_MIN_TREND", "adxMinTrend");
      applyNum("ICHIMOKU_ATR_PERIOD", "atrPeriod");
      applyNum("ICHIMOKU_ATR_STOP_MULTIPLIER", "atrStopMultiplier");
      applyNum("ICHIMOKU_BREAK_BUFFER_ATR", "breakBufferAtr");
      applyNum("ICHIMOKU_BREAK_BUFFER_BPS", "breakBufferBps");
      applyNum("ICHIMOKU_MAX_ENTRY_DIST_ATR", "maxEntryDistAtr");
      applyBool("ICHIMOKU_REQUIRE_TENKAN_KIJUN_ALIGN", "requireTenkanKijunAlign");
      applyBool("ICHIMOKU_ENABLE_HTF_REGIME", "enableHtfRegime");
      applyNum("ICHIMOKU_HTF_MULTIPLIER", "htfMultiplier");
      applyNum("ICHIMOKU_HTF_ADX_PERIOD", "htfAdxPeriod");
      applyNum("ICHIMOKU_HTF_ADX_MIN_TREND", "htfAdxMinTrend");
      applyBool("ICHIMOKU_HTF_USE_CHOP", "htfUseChop");
      applyNum("ICHIMOKU_HTF_CHOP_PERIOD", "htfChopPeriod");
      applyNum("ICHIMOKU_HTF_CHOP_RANGING", "htfChopRanging");
      applyNum("ICHIMOKU_HTF_CHOP_TRENDING", "htfChopTrending");
      applyBool("ICHIMOKU_REQUIRE_VOLUME_SPIKE", "requireVolumeSpike");
      applyNum("ICHIMOKU_VOLUME_LOOKBACK", "volumeLookback");
      applyNum("ICHIMOKU_VOLUME_SPIKE_THRESHOLD", "volumeSpikeThreshold");
      applyBool("ALLOW_LONGS", "allowLongs");
      applyBool("ALLOW_SHORTS", "allowShorts");

      applyBool("ICHIMOKU_EXIT_ON_KIJUN_BREAK", "exitOnKijunBreak");
      applyNum("ICHIMOKU_KIJUN_BREAK_BUFFER_ATR", "kijunBreakBufferAtr");
      applyNum("ICHIMOKU_KIJUN_BREAK_BUFFER_BPS", "kijunBreakBufferBps");
      applyBool("ICHIMOKU_EXIT_ON_TENKAN_KIJUN_CROSS", "exitOnTenkanKijunCross");
      applyBool("ICHIMOKU_EXIT_ON_CLOUD_REENTRY", "exitOnCloudReentry");
      applyBool("ICHIMOKU_EXIT_ON_CLOUD_FLIP", "exitOnCloudFlip");
      applyNum("ICHIMOKU_TIME_STOP_BARS", "timeStopBars");

      applyBool("ICHIMOKU_ENABLE_ATR_TRAIL", "enableAtrTrail");
      applyNum("ICHIMOKU_TRAIL_ATR_MULT", "trailAtrMult");
      applyBool("ICHIMOKU_HARD_STOP_ENABLED", "hardStopEnabled");
      applyNum("ICHIMOKU_HARD_STOP_PERCENT", "hardStopPercent");
      applyNum("ICHIMOKU_HARD_STOP_ATR_MULT", "hardStopAtrMult");

      const osc = env[`STRATEGY_${marketKey}_ICHIMOKU_EXIT_OSCILLATOR`];
      if (hasEnvVal(osc)) mergedIchimoku.exitOscillator = String(osc).toLowerCase();
      const oscGlobal = env.ICHIMOKU_EXIT_OSCILLATOR;
      if (!hasEnvVal(osc) && hasEnvVal(oscGlobal)) {
        mergedIchimoku.exitOscillator = String(oscGlobal).toLowerCase();
      }

      applyNum("ICHIMOKU_EXIT_RSI_PERIOD", "exitRsiPeriod");
      applyNum("ICHIMOKU_EXIT_RSI_LONG", "exitRsiLong");
      applyNum("ICHIMOKU_EXIT_RSI_SHORT", "exitRsiShort");
      applyNum("ICHIMOKU_EXIT_MACD_FAST", "exitMacdFast");
      applyNum("ICHIMOKU_EXIT_MACD_SLOW", "exitMacdSlow");
      applyNum("ICHIMOKU_EXIT_MACD_SIGNAL", "exitMacdSignal");

      baseConfig.ichimokuStrategy = mergedIchimoku;
      return new IchimokuCloudBreakoutStrategy(baseConfig);
    } else if (strategyType === "copy-trading") {
      const env = this._envForStrategy(strategyType);
      const baseCopyConfig = this.copyTradingConfig || this._extractCopyTradingConfigFromEnv(env);
      const provider = this._getCopyTradingProvider();
      const symbol = String(market || "")
        .replace(/-PERP$/i, "")
        .toUpperCase();
      const signalFamily = String(options.signalFamily || baseCopyConfig.signalFamily || "direct")
        .trim()
        .toLowerCase();
      const StrategyClass =
        signalFamily === "meta"
          ? CopyTradingMetaStrategy
          : ["eventmeta", "event_meta", "event-meta", "event"].includes(signalFamily)
            ? CopyTradingEventStrategy
            : CopyTradingStrategy;
      return new StrategyClass({
        ...baseCopyConfig,
        ...options,
        symbol: symbol || "BTC",
        consensusProvider: provider ? provider.getConsensus.bind(provider) : null,
      });
    } else {
      throw new Error(`Unknown strategy type: ${strategyType}`);
    }
  }

  _getCopyTradingProvider() {
    if (this._copyTradingProvider) return this._copyTradingProvider;
    try {
      this._copyTradingProvider = getCopyTradingConsensusProvider();
      return this._copyTradingProvider;
    } catch (e) {
      console.warn(
        "[StrategyFactory] Failed to init copy-trading consensus provider:",
        e?.message || e
      );
      return null;
    }
  }

  getCopyTradingProvider() {
    return this._copyTradingProvider || null;
  }

  /**
   * Extract momentum strategy configuration
   *
   * @param {Object} config - Full config object
   * @returns {Object} Momentum config
   */
  _extractMomentumConfig(config) {
    // Extract momentum-specific config from main config
    // Most existing config keys are for momentum
    return {
      tradingInterval: config.tradingInterval,
      strategy: config.strategy ? { ...config.strategy } : {},
      emaShort: config.emaShort,
      emaMedium: config.emaMedium,
      emaLong: config.emaLong,
      rsiPeriod: config.rsiPeriod,
      rsiOverbought: config.rsiOverbought,
      rsiOversold: config.rsiOversold,
      atrPeriod: config.atrPeriod,
      atrMultiplier: config.atrMultiplier,
      volumeThreshold: config.volumeThreshold,
      trendStrength: config.trendStrength,
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
      trailingStopPercent: config.trailingStopPercent,
      useTrailingStop: config.useTrailingStop,
      // Add any other momentum-specific keys
    };
  }

  /**
   * Extract scalping strategy configuration
   *
   * @param {Object} config - Full config object
   * @returns {Object} Scalping config
   */
  _extractScalpingConfig(config) {
    // Extract scalping-specific config from main config
    // These are prefixed with SCALPING_ in env vars
    return {
      // Trading interval (1m for scalping)
      tradingInterval: "1m",

      // Risk model
      stopLossPercent: Number(process.env.SCALPING_STOP_LOSS_PERCENT) || 0.15,
      takeProfitPercent: Number(process.env.SCALPING_TAKE_PROFIT_PERCENT) || 1.2,
      riskPerTradePercent: Number(process.env.SCALPING_RISK_PER_TRADE_PERCENT) || 1.5,
      positionSizePercent: Number(process.env.SCALPING_POSITION_SIZE_PERCENT) || 20,

      // Circuit breaker
      maxConsecutiveLosses: Number(process.env.SCALPING_MAX_CONSECUTIVE_LOSSES) || 3,
      circuitBreakerCooldown: Number(process.env.SCALPING_CIRCUIT_BREAKER_COOLDOWN) || 3600000,

      // Volatility filter
      minVolatilityPercent: Number(process.env.SCALPING_MIN_VOLATILITY_PERCENT) || 0.5,
      maxVolatilityPercent: Number(process.env.SCALPING_MAX_VOLATILITY_PERCENT) || 3.0,

      // Win rate tracking
      targetWinRate: Number(process.env.SCALPING_TARGET_WIN_RATE) || 0.4,
      minSampleSize: Number(process.env.SCALPING_MIN_SAMPLE_SIZE) || 20,

      // R:R validation
      minRiskRewardRatio: Number(process.env.SCALPING_MIN_RISK_REWARD_RATIO) || 1.0,
      maxRiskRewardRatio: Number(process.env.SCALPING_MAX_RISK_REWARD_RATIO) || 2.0,

      // Entry patterns
      enableContinuationPattern: process.env.SCALPING_ENABLE_CONTINUATION !== "false",
      continuationVolumeMultiplier:
        Number(process.env.SCALPING_CONTINUATION_VOLUME_MULTIPLIER) || 2.0,
      continuationCVDThreshold: Number(process.env.SCALPING_CONTINUATION_CVD_THRESHOLD) || 0.6,
      continuationDonchianBreakPct:
        Number(process.env.SCALPING_CONTINUATION_DONCHIAN_BREAK_PCT) || 0.1,

      enableSweepReversal: process.env.SCALPING_ENABLE_SWEEP_REVERSAL !== "false",
      sweepReversalMaxAge: Number(process.env.SCALPING_SWEEP_REVERSAL_MAX_AGE) || 300000,
      sweepReversalCVDFlip: Number(process.env.SCALPING_SWEEP_REVERSAL_CVD_FLIP) || 0.3,
      sweepReversalConfirmBars: Number(process.env.SCALPING_SWEEP_REVERSAL_CONFIRM_BARS) || 2,

      enablePullbackPattern: process.env.SCALPING_ENABLE_PULLBACK !== "false",
      pullbackEMAProximity: Number(process.env.SCALPING_PULLBACK_EMA_PROXIMITY) || 0.002,
      pullbackCVDThreshold: Number(process.env.SCALPING_PULLBACK_CVD_THRESHOLD) || 0.55,
      pullbackMaxATRMultiplier: Number(process.env.SCALPING_PULLBACK_MAX_ATR_MULTIPLIER) || 0.5,

      enableTripleThreat: process.env.SCALPING_ENABLE_TRIPLE_THREAT !== "false",
      tripleThreatOIThreshold: Number(process.env.SCALPING_TRIPLE_THREAT_OI_THRESHOLD) || 0.1,
      tripleThreatCVDThreshold: Number(process.env.SCALPING_TRIPLE_THREAT_CVD_THRESHOLD) || 0.6,
      tripleThreatSweepMaxAge: Number(process.env.SCALPING_TRIPLE_THREAT_SWEEP_MAX_AGE) || 300000,

      // Indicators
      emaShort: Number(process.env.SCALPING_EMA_SHORT) || 9,
      emaMedium: Number(process.env.SCALPING_EMA_MEDIUM) || 21,
      emaLong: Number(process.env.SCALPING_EMA_LONG) || 50,
      hullPeriod: Number(process.env.SCALPING_HULL_PERIOD) || 14,
      donchianPeriod: Number(process.env.SCALPING_DONCHIAN_PERIOD) || 20,
      adxPeriod: Number(process.env.SCALPING_ADX_PERIOD) || 14,
      atrPeriod: Number(process.env.SCALPING_ATR_PERIOD) || 14,

      // Execution optimizations
      enablePriorityFees: process.env.SCALPING_ENABLE_PRIORITY_FEES !== "false",
      enableDynamicSlippage: process.env.SCALPING_ENABLE_DYNAMIC_SLIPPAGE !== "false",
      enableFeeOptimization: process.env.SCALPING_ENABLE_FEE_OPTIMIZATION !== "false",
    };
  }

  /**
   * Extract RSI mean-reversion strategy configuration
   * IMPORTANT: Returns config nested under `rsiStrategy` key to match how momentum uses `strategy`
   * The RSI strategy constructor reads from `config.rsiStrategy || config.strategy`
   *
   * @param {Object} config - Full config object
   * @returns {Object} RSI-reversion config with rsiStrategy nested object
   */
  _extractRsiReversionConfigFromEnv(env) {
    // Helper: parse numbers from env while preserving explicit 0 (do NOT use `||`).
    const num = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      const n = Number(envVal);
      return Number.isFinite(n) ? n : fallback;
    };

    // Helper: parse optional numbers where empty/undefined means null
    const maybeNum = (envVal) => {
      if (envVal === undefined || envVal === "") return null;
      const n = Number(envVal);
      return Number.isFinite(n) ? n : null;
    };

    // Build rsiStrategy object with ALL RSI-specific params to prevent process.env bleeding
    const rsiStrategy = {
      // RSI calculation
      rsiPeriod: num(env.RSI_PERIOD, 14),
      rsiUseSma: env.RSI_USE_SMA !== "false", // Default: true (SMA for TradingView alignment)

      // Entry thresholds
      rsiOversoldExtreme: num(env.RSI_OVERSOLD_EXTREME, 20),
      rsiOversoldRecovery: num(env.RSI_OVERSOLD_RECOVERY, 25),
      rsiOverboughtExtreme: num(env.RSI_OVERBOUGHT_EXTREME, 80),
      rsiOverboughtRecovery: num(env.RSI_OVERBOUGHT_RECOVERY, 75),
      rsiEntryMaxBars: num(env.RSI_ENTRY_MAX_BARS, 5),
      rsiEntryMaxDeviation: num(env.RSI_ENTRY_MAX_DEVIATION, 10),
      rsiRequireCrossover: env.RSI_REQUIRE_CROSSOVER === "true", // Default: false (relaxed)

      // Exit thresholds (RSI-based)
      rsiTargetNeutral: num(env.RSI_TARGET_NEUTRAL, 50),
      rsiTargetLong: maybeNum(env.RSI_TARGET_LONG),
      rsiTargetShort: maybeNum(env.RSI_TARGET_SHORT),
      rsiPartialEnabled: env.RSI_PARTIAL_ENABLED !== "false", // Default: enabled
      rsiPartialTargetLong: num(env.RSI_PARTIAL_TARGET_LONG, 35),
      rsiPartialTargetShort: num(env.RSI_PARTIAL_TARGET_SHORT, 65),
      rsiPartialPercent: num(env.RSI_PARTIAL_PERCENT, 50),
      rsiFailureEnabled: env.RSI_FAILURE_ENABLED !== "false", // Default: enabled
      rsiFailureLong: num(env.RSI_FAILURE_LONG, 22),
      rsiFailureShort: num(env.RSI_FAILURE_SHORT, 78),
      rsiRequireProfitForTarget: env.RSI_REQUIRE_PROFIT_FOR_TARGET === "true",

      // Time & hard stops
      rsiTimeStopBars: num(env.RSI_TIME_STOP_BARS, 20),
      rsiHardTimeStopBars: num(env.RSI_HARD_TIME_STOP_BARS, 0), // 0 = disabled
      rsiHardStopEnabled: env.RSI_HARD_STOP_ENABLED !== "false",
      rsiHardStopAtr: num(env.RSI_HARD_STOP_ATR, 2.0),
      rsiHardStopPercent: num(env.RSI_HARD_STOP_PERCENT, 0),
      atrPeriod: num(env.ATR_PERIOD, 14),

      // Position sizing
      rsiPositionSizeMultiplier: num(env.RSI_POSITION_SIZE_MULTIPLIER, 0.5),
      positionSizePercent: num(env.POSITION_SIZE_PERCENT, 30),
      riskPerTradePercent: num(env.RISK_PER_TRADE_PERCENT, 1.0),

      // Filters
      rsiRequireTrendFilter: env.RSI_REQUIRE_TREND_FILTER === "true",
      rsiMinAdx: num(env.RSI_MIN_ADX, 0),
      rsiMaxAdx: num(env.RSI_MAX_ADX, 100), // 100 = disabled
      rsiMinVolatilityPct: num(env.RSI_MIN_VOLATILITY_PCT, 0.2),
      rsiMaxVolatilityPct: num(env.RSI_MAX_VOLATILITY_PCT, 3.0),

      // Circuit breaker
      maxConsecutiveLosses: num(env.RSI_MAX_CONSECUTIVE_LOSSES, 3),
      circuitBreakerCooldownMs: num(env.RSI_CIRCUIT_BREAKER_COOLDOWN_MS, 1800000),

      // Dynamic confidence scaling
      rsiDynamicConfidence: env.RSI_DYNAMIC_CONFIDENCE !== "false", // Default: enabled
      rsiDynamicConfidenceBase: num(env.RSI_DYNAMIC_CONFIDENCE_BASE, 0.5),
      rsiDynamicConfidenceScale: num(env.RSI_DYNAMIC_CONFIDENCE_SCALE, 20),

      // Cooldowns
      cooldownMs: num(env.COOLDOWN_MS, 30000),
      cooldownLongMs: num(env.COOLDOWN_LONG_MS, 0),
      cooldownShortMs: num(env.COOLDOWN_SHORT_MS, 0),

      // Regime filter (trend-following gate)
      rsiRegimeFilterEnabled: env.RSI_REGIME_FILTER_ENABLED === "true", // Default: disabled
      rsiRegimeEmaPeriod: num(env.RSI_REGIME_EMA_PERIOD, 50),
      rsiRegimeSlopeThreshold: num(env.RSI_REGIME_SLOPE_THRESHOLD, 0.1),

      // Time-of-day filters (explicit per-strategy, not from process.env)
      tradingDisabledHoursUtc: env.TRADING_DISABLED_HOURS_UTC || "",
      tradingAllowedHoursUtc: env.TRADING_ALLOWED_HOURS_UTC || "",

      // Warmup
      minBars: num(env.MIN_BARS, 50),

      // Position size limits (generic but isolated per strategy)
      minPositionSize: num(env.MIN_POSITION_SIZE, 50),
      maxPositionSize: num(env.MAX_POSITION_SIZE, 5000),

      // Debug
      verbose: env.DEBUG_RSI_STRATEGY === "true",
    };

    // Log global RSI config for debugging
    console.log(
      `[StrategyFactory] RSI global config from env: overbought=${rsiStrategy.rsiOverboughtExtreme}→${rsiStrategy.rsiOverboughtRecovery}, oversold=${rsiStrategy.rsiOversoldExtreme}→${rsiStrategy.rsiOversoldRecovery}`
    );
    console.log(
      `[StrategyFactory] RSI time filter from env: disabledHours="${rsiStrategy.tradingDisabledHoursUtc}", allowedHours="${rsiStrategy.tradingAllowedHoursUtc}"`
    );

    return {
      tradingInterval: env.TRADING_INTERVAL || "5m",
      // Nest under rsiStrategy so constructor can find it (like momentum uses strategy)
      rsiStrategy,
    };
  }

  _extractBtcBreakoutConfigFromEnv(env) {
    const num = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      const n = Number(envVal);
      return Number.isFinite(n) ? n : fallback;
    };
    const bool = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      const s = String(envVal).toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "y";
    };
    const str = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      return String(envVal);
    };

    const breakoutStrategy = {
      trendEmaPeriod: num(env.BREAKOUT_TREND_EMA_PERIOD, 200),
      trendSlopeLookback: num(env.BREAKOUT_TREND_SLOPE_LOOKBACK, 20),
      trendSlopeThreshold: num(env.BREAKOUT_TREND_SLOPE_THRESHOLD, 0),

      entryChannel: num(env.BREAKOUT_ENTRY_CHANNEL, 20),
      confirmCloseOnly: bool(env.BREAKOUT_CONFIRM_CLOSE_ONLY, true),
      requireVolumeConfirmation: bool(env.BREAKOUT_REQUIRE_VOLUME_CONFIRMATION, false),
      volumeLookback: num(env.BREAKOUT_VOLUME_LOOKBACK, 20),
      volumeSpikeThreshold: num(env.BREAKOUT_VOLUME_SPIKE_THRESHOLD, 1.5),
      entryBufferBps: num(env.BREAKOUT_ENTRY_BUFFER_BPS, 0),
      maxEntryDistAtr: num(env.BREAKOUT_MAX_ENTRY_DIST_ATR, 0),
      breakoutMinBarRangeAtr: num(env.BREAKOUT_MIN_BAR_RANGE_ATR, 0),
      breakoutMinCloseLocation: num(env.BREAKOUT_MIN_CLOSE_LOCATION, 0),
      breakoutMinVolumeRatio: num(env.BREAKOUT_MIN_VOLUME_RATIO, 0),
      breakoutMinBreakDistanceAtr: num(env.BREAKOUT_MIN_BREAK_DISTANCE_ATR, 0),
      fibRetraceLevel: num(env.BREAKOUT_FIB_RETRACE_LEVEL, 0.618),
      fibPocketLowerLevel: num(env.BREAKOUT_FIB_POCKET_LOWER_LEVEL, 0.65),
      fibZoneShallowLevel: num(env.BREAKOUT_FIB_ZONE_SHALLOW_LEVEL, 0.382),
      fibZoneMidLevel: num(env.BREAKOUT_FIB_ZONE_MID_LEVEL, 0.5),
      fibZoneDeepLevel: num(env.BREAKOUT_FIB_ZONE_DEEP_LEVEL, 0.618),
      fibInvalidationLevel: num(env.BREAKOUT_FIB_INVALIDATION_LEVEL, 0.786),
      fibRetraceConfirmCloseLocation: num(env.BREAKOUT_FIB_CONFIRM_CLOSE_LOCATION, 0.5),

      exitChannel: num(env.BREAKOUT_EXIT_CHANNEL, 10),
      enableOppositeChannelExit: bool(env.BREAKOUT_ENABLE_OPPOSITE_CHANNEL_EXIT, true),
      enableRegimeFailureExit: bool(env.BREAKOUT_ENABLE_REGIME_FAILURE_EXIT, false),
      regimeFailureMode: String(env.BREAKOUT_REGIME_FAILURE_MODE || "ema_cross")
        .trim()
        .toLowerCase(),
      enableAtrTrail: bool(env.BREAKOUT_ENABLE_ATR_TRAIL, true),
      atrTrailMult: num(env.BREAKOUT_ATR_TRAIL_MULT, 3.0),
      timeStopBars: num(env.BREAKOUT_TIME_STOP_BARS, 0),
      staleTimeStopEnabled: bool(env.BREAKOUT_STALE_TIME_STOP_ENABLED, false),
      staleTimeStopMinProfitAtr: num(env.BREAKOUT_STALE_TIME_STOP_MIN_PROFIT_ATR, 0.5),
      staleTimeStopRequireTrendFailure: bool(
        env.BREAKOUT_STALE_TIME_STOP_REQUIRE_TREND_FAILURE,
        false
      ),
      enablePartialExit: bool(env.BREAKOUT_ENABLE_PARTIAL_EXIT, false),
      partialAtR: num(env.BREAKOUT_PARTIAL_AT_R, 0),
      partialExitPercent: num(env.BREAKOUT_PARTIAL_EXIT_PERCENT, 50),
      requireProfitForExit: bool(env.BREAKOUT_REQUIRE_PROFIT_FOR_EXIT, false),

      hardStopEnabled: bool(env.BREAKOUT_HARD_STOP_ENABLED, true),
      hardStopPercent: num(env.BREAKOUT_HARD_STOP_PERCENT, 0),
      atrStopMult: num(env.BREAKOUT_ATR_STOP_MULT, 2.5),
      atrPeriod: num(env.BREAKOUT_ATR_PERIOD, num(env.ATR_PERIOD, 20)),

      minVolatilityPct: num(env.BREAKOUT_MIN_VOLATILITY_PCT, 0),
      maxVolatilityPct: num(env.BREAKOUT_MAX_VOLATILITY_PCT, 20),
      regimeFilterEnabled: bool(env.BREAKOUT_REGIME_FILTER_ENABLED, true),
      regimeEmaPeriod: num(env.BREAKOUT_REGIME_EMA_PERIOD, num(env.BREAKOUT_TREND_EMA_PERIOD, 200)),
      regimeSlopeLookback: num(
        env.BREAKOUT_REGIME_SLOPE_LOOKBACK,
        num(env.BREAKOUT_TREND_SLOPE_LOOKBACK, 20)
      ),
      regimeSlopeThreshold: num(env.BREAKOUT_REGIME_SLOPE_THRESHOLD, 0),

      allowLongs: bool(env.ALLOW_LONGS, true),
      allowShorts: bool(env.ALLOW_SHORTS, true),
      maxConsecutiveLosses: num(env.BREAKOUT_MAX_CONSECUTIVE_LOSSES, 3),
      circuitBreakerCooldownMs: num(env.BREAKOUT_CIRCUIT_BREAKER_COOLDOWN_MS, 14400000),

      dynamicConfidence: bool(env.BREAKOUT_DYNAMIC_CONFIDENCE, true),
      dynamicConfidenceBase: num(env.BREAKOUT_DYNAMIC_CONFIDENCE_BASE, 0.5),
      dynamicConfidenceScale: num(env.BREAKOUT_DYNAMIC_CONFIDENCE_SCALE, 1.0),

      enableCooldown: bool(env.ENABLE_COOLDOWN, true),
      cooldownMs: num(env.COOLDOWN_MS, 300000),
      cooldownLongMs: num(env.COOLDOWN_LONG_MS, 0),
      cooldownShortMs: num(env.COOLDOWN_SHORT_MS, 0),
      flipCooldownMs: num(env.FLIP_COOLDOWN_MS, 14400000),
      minBarsSameSideReentry: num(env.MIN_BARS_SAME_SIDE_REENTRY, 1),
      tradingDisabledHoursUtc: str(env.TRADING_DISABLED_HOURS_UTC, ""),
      tradingAllowedHoursUtc: str(env.TRADING_ALLOWED_HOURS_UTC, ""),

      positionSizePercent: num(env.POSITION_SIZE_PERCENT, 25),
      volatilityScaleBase: num(env.VOLATILITY_SCALE_BASE, 0.02),
      riskPerTradePercent: num(env.RISK_PER_TRADE_PERCENT, 0.5),
      minPositionSize: num(env.MIN_POSITION_SIZE, 50),
      maxPositionSize: num(env.MAX_POSITION_SIZE, 5000),
      minBars: num(env.MIN_BARS, 250),

      verbose: bool(env.DEBUG_BREAKOUT_STRATEGY, false),
    };

    return {
      tradingInterval: env.TRADING_INTERVAL || "4h",
      breakoutStrategy,
    };
  }

  _extractIchimokuConfigFromEnv(env) {
    const num = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      const n = Number(envVal);
      return Number.isFinite(n) ? n : fallback;
    };
    const bool = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      const s = String(envVal).toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "y";
    };
    const str = (envVal, fallback) => {
      if (envVal === undefined || envVal === "") return fallback;
      return String(envVal);
    };

    const ichimokuStrategy = {
      tenkanPeriod: num(env.ICHIMOKU_TENKAN_PERIOD, 9),
      kijunPeriod: num(env.ICHIMOKU_KIJUN_PERIOD, 26),
      senkouBPeriod: num(env.ICHIMOKU_SENKOU_B_PERIOD, 52),
      shift: num(env.ICHIMOKU_SHIFT, 26),
      minBars: num(env.ICHIMOKU_MIN_BARS, null),
      adxPeriod: num(env.ICHIMOKU_ADX_PERIOD, 14),
      adxMinTrend: num(env.ICHIMOKU_ADX_MIN_TREND, 20),
      atrPeriod: num(env.ICHIMOKU_ATR_PERIOD, 14),
      atrStopMultiplier: num(env.ICHIMOKU_ATR_STOP_MULTIPLIER, 2.8),
      breakBufferBps: num(env.ICHIMOKU_BREAK_BUFFER_BPS, 0),
      breakBufferAtr: num(env.ICHIMOKU_BREAK_BUFFER_ATR, 0.1),
      maxEntryDistAtr: num(env.ICHIMOKU_MAX_ENTRY_DIST_ATR, 1.5),
      requireTenkanKijunAlign: bool(env.ICHIMOKU_REQUIRE_TENKAN_KIJUN_ALIGN, true),
      // Chikou confirmation (optional): pass through env snapshot so multi-strategy mode does not
      // depend on global process.env for these knobs.
      requireChikouBreakout: bool(
        env.ICHIMOKU_REQUIRE_CHIKOU_BREAKOUT ?? env.ICHIMOKU_REQUIRE_CHIKOU_CLEAR,
        false
      ),
      chikouLookback: num(env.ICHIMOKU_CHIKOU_LOOKBACK, 26),
      chikouCompare: str(env.ICHIMOKU_CHIKOU_COMPARE, "hilo").toLowerCase(),
      chikouBufferBps: num(env.ICHIMOKU_CHIKOU_BUFFER_BPS, 0),
      chikouBufferAtr: num(env.ICHIMOKU_CHIKOU_BUFFER_ATR, 0),
      requireChikouAboveCloud: bool(env.ICHIMOKU_CHIKOU_REQUIRE_ABOVE_CLOUD, false),
      chikouCloudLookback: num(env.ICHIMOKU_CHIKOU_CLOUD_LOOKBACK, 0),
      requireVwapConfirm: bool(env.ICHIMOKU_REQUIRE_VWAP_CONFIRM, false),
      vwapSessionMs: num(env.ICHIMOKU_VWAP_SESSION_MS, 24 * 60 * 60 * 1000),
      vwapBandBps: num(env.ICHIMOKU_VWAP_BAND_BPS, 0),
      vwapRequireCross: bool(env.ICHIMOKU_VWAP_REQUIRE_CROSS, false),
      enableHtfRegime: bool(env.ICHIMOKU_ENABLE_HTF_REGIME, false),
      htfMultiplier: num(env.ICHIMOKU_HTF_MULTIPLIER, 4),
      htfAdxPeriod: num(env.ICHIMOKU_HTF_ADX_PERIOD, 14),
      htfAdxMinTrend: num(env.ICHIMOKU_HTF_ADX_MIN_TREND, 25),
      htfUseChop: bool(env.ICHIMOKU_HTF_USE_CHOP, false),
      htfChopPeriod: num(env.ICHIMOKU_HTF_CHOP_PERIOD, 14),
      htfChopRanging: num(env.ICHIMOKU_HTF_CHOP_RANGING, 61.8),
      htfChopTrending: num(env.ICHIMOKU_HTF_CHOP_TRENDING, 38.2),
      requireVolumeSpike: bool(env.ICHIMOKU_REQUIRE_VOLUME_SPIKE, false),
      volumeLookback: num(env.ICHIMOKU_VOLUME_LOOKBACK, 20),
      volumeSpikeThreshold: num(env.ICHIMOKU_VOLUME_SPIKE_THRESHOLD, 1.5),
      exitOnKijunBreak: bool(env.ICHIMOKU_EXIT_ON_KIJUN_BREAK, true),
      kijunBreakBufferBps: num(env.ICHIMOKU_KIJUN_BREAK_BUFFER_BPS, 0),
      kijunBreakBufferAtr: num(env.ICHIMOKU_KIJUN_BREAK_BUFFER_ATR, 0.05),
      exitOnTenkanKijunCross: bool(env.ICHIMOKU_EXIT_ON_TENKAN_KIJUN_CROSS, false),
      exitOnCloudReentry: bool(env.ICHIMOKU_EXIT_ON_CLOUD_REENTRY, true),
      exitOnCloudFlip: bool(env.ICHIMOKU_EXIT_ON_CLOUD_FLIP, false),
      timeStopBars: num(env.ICHIMOKU_TIME_STOP_BARS, 0),
      enableAtrTrail: bool(env.ICHIMOKU_ENABLE_ATR_TRAIL, false),
      trailAtrMult: num(env.ICHIMOKU_TRAIL_ATR_MULT, 1.5),
      hardStopEnabled: bool(env.ICHIMOKU_HARD_STOP_ENABLED, false),
      hardStopPercent: num(env.ICHIMOKU_HARD_STOP_PERCENT, 20),
      hardStopAtrMult: num(env.ICHIMOKU_HARD_STOP_ATR_MULT, 0),
      exitOscillator: str(env.ICHIMOKU_EXIT_OSCILLATOR, "none").toLowerCase(),
      exitRsiPeriod: num(env.ICHIMOKU_EXIT_RSI_PERIOD, 14),
      exitRsiLong: num(env.ICHIMOKU_EXIT_RSI_LONG, 50),
      exitRsiShort: num(env.ICHIMOKU_EXIT_RSI_SHORT, 50),
      exitMacdFast: num(env.ICHIMOKU_EXIT_MACD_FAST, 12),
      exitMacdSlow: num(env.ICHIMOKU_EXIT_MACD_SLOW, 26),
      exitMacdSignal: num(env.ICHIMOKU_EXIT_MACD_SIGNAL, 9),
      allowLongs: bool(env.ALLOW_LONGS, true),
      allowShorts: bool(env.ALLOW_SHORTS, true),
      tradingDisabledHoursUtc: env.TRADING_DISABLED_HOURS_UTC || "",
      tradingAllowedHoursUtc: env.TRADING_ALLOWED_HOURS_UTC || "",
      verbose: env.DEBUG_ICHIMOKU_STRATEGY === "true",
    };

    return {
      tradingInterval: env.TRADING_INTERVAL || "15m",
      ichimokuStrategy,
    };
  }

  _extractCopyTradingConfigFromEnv(env) {
    const num = (v, d) => {
      if (v === undefined || v === "") return d;
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const bool = (v, d) => {
      if (v === undefined || v === "") return d;
      const s = String(v).trim().toLowerCase();
      if (["1", "true", "yes", "y", "on"].includes(s)) return true;
      if (["0", "false", "no", "n", "off"].includes(s)) return false;
      return d;
    };
    const csv = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const out = String(v)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      return out.length ? out : null;
    };

    return {
      tradingInterval: env.TRADING_INTERVAL || "1m",
      signalFamily: String(env.COPY_SIGNAL_FAMILY || "direct")
        .trim()
        .toLowerCase(),
      enterThreshold: num(env.COPY_CONSENSUS_ENTER, 0.65),
      exitThreshold: num(env.COPY_CONSENSUS_EXIT, 0.55),
      longEnterThreshold: num(env.COPY_LONG_ENTER, num(env.COPY_CONSENSUS_ENTER, 0.65)),
      shortEnterThreshold: num(env.COPY_SHORT_ENTER, num(env.COPY_CONSENSUS_ENTER, 0.65)),
      longExitThreshold: num(env.COPY_LONG_EXIT, num(env.COPY_CONSENSUS_EXIT, 0.55)),
      shortExitThreshold: num(env.COPY_SHORT_EXIT, num(env.COPY_CONSENSUS_EXIT, 0.55)),
      minLeaders: num(env.COPY_STRATEGY_MIN_LEADERS, num(env.COPY_MIN_LEADERS, 7)),
      longMinLeaders: num(
        env.COPY_LONG_MIN_LEADERS,
        num(env.COPY_STRATEGY_MIN_LEADERS, num(env.COPY_MIN_LEADERS, 7))
      ),
      shortMinLeaders: num(
        env.COPY_SHORT_MIN_LEADERS,
        num(env.COPY_STRATEGY_MIN_LEADERS, num(env.COPY_MIN_LEADERS, 7))
      ),
      minEffectiveN: num(env.COPY_MIN_EFFECTIVE_N, 2.0),
      longMinEffectiveN: num(env.COPY_LONG_MIN_EFFECTIVE_N, num(env.COPY_MIN_EFFECTIVE_N, 2.0)),
      shortMinEffectiveN: num(env.COPY_SHORT_MIN_EFFECTIVE_N, num(env.COPY_MIN_EFFECTIVE_N, 2.0)),
      confirmMs: num(env.COPY_CONFIRM_SECONDS, 60) * 1000,
      fadeWorstEnabled: bool(env.COPY_FADE_WORST_ENABLED, false),
      signalIntervalMs: num(env.COPY_SIGNAL_INTERVAL_MS, 0),
      signalMaxActiveWeightShare: num(env.COPY_SIGNAL_MAX_ACTIVE_WEIGHT_SHARE, 1),
      longSignalMaxActiveWeightShare: num(
        env.COPY_LONG_SIGNAL_MAX_ACTIVE_WEIGHT_SHARE,
        num(env.COPY_SIGNAL_MAX_ACTIVE_WEIGHT_SHARE, 1)
      ),
      shortSignalMaxActiveWeightShare: num(
        env.COPY_SHORT_SIGNAL_MAX_ACTIVE_WEIGHT_SHARE,
        num(env.COPY_SIGNAL_MAX_ACTIVE_WEIGHT_SHARE, 1)
      ),
      signalMaxClusterWeightShare: num(env.COPY_SIGNAL_MAX_CLUSTER_WEIGHT_SHARE, 1),
      longSignalMaxClusterWeightShare: num(
        env.COPY_LONG_SIGNAL_MAX_CLUSTER_WEIGHT_SHARE,
        num(env.COPY_SIGNAL_MAX_CLUSTER_WEIGHT_SHARE, 1)
      ),
      shortSignalMaxClusterWeightShare: num(
        env.COPY_SHORT_SIGNAL_MAX_CLUSTER_WEIGHT_SHARE,
        num(env.COPY_SIGNAL_MAX_CLUSTER_WEIGHT_SHARE, 1)
      ),
      maxLeaderFamilyWeightShare: num(env.COPY_MAX_LEADER_FAMILY_WEIGHT_SHARE, 1),
      longMaxLeaderFamilyWeightShare: num(
        env.COPY_LONG_MAX_LEADER_FAMILY_WEIGHT_SHARE,
        num(env.COPY_MAX_LEADER_FAMILY_WEIGHT_SHARE, 1)
      ),
      shortMaxLeaderFamilyWeightShare: num(
        env.COPY_SHORT_MAX_LEADER_FAMILY_WEIGHT_SHARE,
        num(env.COPY_MAX_LEADER_FAMILY_WEIGHT_SHARE, 1)
      ),
      regimeFilterEnabled: bool(env.COPY_REGIME_FILTER_ENABLED, false),
      regimeRequireReady: bool(env.COPY_REGIME_REQUIRE_READY, true),
      regimeLookbackBars: num(env.COPY_REGIME_LOOKBACK_BARS, 24),
      regimeMinTrendStrength: num(env.COPY_REGIME_MIN_TREND_STRENGTH, 0.15),
      longMinTrendReturnPct: num(env.COPY_LONG_MIN_TREND_RETURN_PCT, 0),
      shortMinTrendReturnPct: num(env.COPY_SHORT_MIN_TREND_RETURN_PCT, 0),
      regimeMinVolPct: num(env.COPY_REGIME_MIN_VOL_PCT, 0),
      regimeMaxVolPct: num(env.COPY_REGIME_MAX_VOL_PCT, 10),
      maxHoldHours: num(env.COPY_MAX_HOLD_HOURS, 0),
      adverseMoveStopPercent: num(env.COPY_ADVERSE_MOVE_STOP_PERCENT, 0),
      takeProfitPercent: num(env.COPY_TAKE_PROFIT_PERCENT, 0),
      trailingStopPercent: num(env.COPY_TRAILING_STOP_PERCENT, 0),
      trailActivateAfterProfitPercent: num(env.COPY_TRAIL_ACTIVATE_AFTER_PROFIT_PERCENT, 0),
      breakevenAfterHours: num(env.COPY_BREAKEVEN_AFTER_HOURS, 0),
      followerOwnedExitMode: bool(env.COPY_FOLLOWER_OWNED_EXIT_MODE, false),
      metaFollowScoreMin: num(env.COPY_META_FOLLOW_SCORE_MIN, 0.5),
      metaFullSizeScoreMin: num(env.COPY_META_FULL_SIZE_SCORE_MIN, 0.7),
      metaExitScoreMin: num(env.COPY_META_EXIT_SCORE_MIN, 0.42),
      metaSmallSizeFraction: num(env.COPY_META_SMALL_SIZE_FRACTION, 0.55),
      metaDownweightSizeFraction: num(env.COPY_META_DOWNWEIGHT_SIZE_FRACTION, 0.3),
      metaTargetContributors: num(env.COPY_META_TARGET_CONTRIBUTORS, 4),
      metaTargetEffectiveN: num(env.COPY_META_TARGET_EFFECTIVE_N, 3),
      metaFreshnessDays: num(env.COPY_META_FRESHNESS_DAYS, 14),
      metaExpectancyScaleUsd: num(env.COPY_META_EXPECTANCY_SCALE_USD, 10),
      metaConcentrationSoftCap: num(env.COPY_META_CONCENTRATION_SOFT_CAP, 0.35),
      metaConcentrationHardCap: num(env.COPY_META_CONCENTRATION_HARD_CAP, 0.75),
      metaClusterSoftCap: num(env.COPY_META_CLUSTER_SOFT_CAP, 0.5),
      metaClusterHardCap: num(env.COPY_META_CLUSTER_HARD_CAP, 0.85),
      metaRequireLeaderSummary: bool(env.COPY_META_REQUIRE_LEADER_SUMMARY, false),
      eventPrimaryHorizon: env.COPY_EVENT_PRIMARY_HORIZON || "6h",
      eventFollowScoreMin: num(env.COPY_EVENT_FOLLOW_SCORE_MIN, 0.56),
      eventFullSizeScoreMin: num(env.COPY_EVENT_FULL_SIZE_SCORE_MIN, 0.76),
      eventMinActiveContributors: num(env.COPY_EVENT_MIN_ACTIVE_CONTRIBUTORS, 2),
      eventTargetContributors: num(env.COPY_EVENT_TARGET_CONTRIBUTORS, 4),
      eventTargetEffectiveN: num(env.COPY_EVENT_TARGET_EFFECTIVE_N, 2),
      eventMinWalletResolvedCount: num(env.COPY_EVENT_MIN_WALLET_RESOLVED_COUNT, 1),
      eventMinSymbolResolvedCount: num(env.COPY_EVENT_MIN_SYMBOL_RESOLVED_COUNT, 1),
      eventMinWalletQualityScore: num(env.COPY_EVENT_MIN_WALLET_QUALITY_SCORE, 0.45),
      eventMinSymbolQualityScore: num(env.COPY_EVENT_MIN_SYMBOL_QUALITY_SCORE, 0.45),
      eventMaxStaleStateMs: num(env.COPY_EVENT_MAX_STALE_STATE_MS, 6 * 60 * 60 * 1000),
      eventRequireRegimeReady: bool(env.COPY_EVENT_REQUIRE_REGIME_READY, false),
      eventConcentrationSoftCap: num(env.COPY_EVENT_CONCENTRATION_SOFT_CAP, 0.55),
      eventConcentrationHardCap: num(env.COPY_EVENT_CONCENTRATION_HARD_CAP, 0.85),
      eventClusterSoftCap: num(env.COPY_EVENT_CLUSTER_SOFT_CAP, 0.7),
      eventClusterHardCap: num(env.COPY_EVENT_CLUSTER_HARD_CAP, 0.9),
      eventCostScaleBps: num(env.COPY_EVENT_COST_SCALE_BPS, 20),
      eventTrendScale: num(env.COPY_EVENT_TREND_SCALE, 2),
      eventAllowedWallets: csv(env.COPY_EVENT_ALLOWED_WALLETS),
      eventAllowedSymbols: csv(env.COPY_EVENT_ALLOWED_SYMBOLS),
      eventAllowedSides: csv(env.COPY_EVENT_ALLOWED_SIDES),
      eventAllowedEventTypes: csv(env.COPY_EVENT_ALLOWED_EVENT_TYPES),
      eventAllowedRegimeBuckets: csv(env.COPY_EVENT_ALLOWED_REGIME_BUCKETS),
      eventSignalDatasetFile: env.COPY_EVENT_SIGNAL_DATASET_FILE || null,
      atrPeriod: num(env.COPY_ATR_PERIOD, 14),
      atrStopMultiplier: num(env.COPY_ATR_STOP_MULTIPLIER, 2.5),
      hardStopEnabled: bool(env.COPY_HARD_STOP_ENABLED, false),
      hardStopPercent: num(env.COPY_HARD_STOP_PERCENT, 0),
      hardStopAtrMult: num(env.COPY_HARD_STOP_ATR_MULT, 0),
      enableAtrTrail: bool(env.COPY_ENABLE_ATR_TRAIL, false),
      trailAtrMult: num(env.COPY_TRAIL_ATR_MULT, 1.5),
      circuitBreakerEnabled: bool(env.COPY_CIRCUIT_BREAKER_ENABLED, true),
      maxConsecutiveLosses: num(env.COPY_MAX_CONSECUTIVE_LOSSES, 3),
      circuitBreakerCooldownMs: num(env.COPY_CIRCUIT_BREAKER_COOLDOWN_MS, 180000),
      safeModeOnStale: bool(env.COPY_SAFE_MODE_ON_STALE, true),
    };
  }

  /**
   * Get strategy instance for a market (single-strategy mode)
   *
   * @param {string} market - Market symbol
   * @returns {Object|null} Strategy instance or null
   */
  getStrategy(market) {
    const cached = this.strategyInstances.get(market);
    if (!cached) return null;

    // Multi-strategy mode returns array, single-strategy mode returns object
    if (Array.isArray(cached)) {
      // Return first strategy (for backward compatibility)
      return cached[0]?.strategy || null;
    }
    return cached.instance || null;
  }

  /**
   * Get all strategy instances for a market (multi-strategy mode)
   *
   * @param {string} market - Market symbol
   * @returns {Array|null} Array of {type, strategy} or null
   */
  getStrategies(market) {
    const cached = this.strategyInstances.get(market);
    if (!cached) return null;

    // Ensure we return an array
    if (Array.isArray(cached)) {
      return cached;
    }
    // Convert single-strategy cache to array format
    return [{ type: cached.type, strategy: cached.instance }];
  }

  /**
   * Get strategy type for a market
   *
   * @param {string} market - Market symbol
   * @returns {string} Strategy type
   */
  getStrategyType(market) {
    return this._getStrategyTypeForMarket(market);
  }

  /**
   * Switch strategy for a market (single-strategy mode only)
   *
   * @param {string} market - Market symbol
   * @param {string} newStrategyType - New strategy type
   */
  switchStrategy(market, newStrategyType) {
    if (
      ![
        "momentum",
        "scalping",
        "rsi-reversion",
        "rsi-reversion-alt",
        "ichimoku-cloud",
        "copy-trading",
      ].includes(newStrategyType)
    ) {
      throw new Error(`Invalid strategy type: ${newStrategyType}`);
    }

    console.log(
      `[StrategyFactory] Switching ${market} from ${this.getStrategyType(market)} to ${newStrategyType}`
    );

    // Update per-market override
    this.strategyTypePerMarket[market] = newStrategyType;

    // Invalidate cached instance
    this.strategyInstances.delete(market);

    // Create new instance
    return this.createStrategy(market);
  }

  /**
   * Enable or disable a strategy type (multi-strategy mode)
   *
   * @param {string} strategyType - Strategy type
   * @param {boolean} enabled - Enable or disable
   */
  setStrategyEnabled(strategyType, enabled) {
    if (
      !["momentum", "scalping", "rsi-reversion", "rsi-reversion-alt", "ichimoku-cloud"].includes(
        strategyType
      )
    ) {
      throw new Error(`Invalid strategy type: ${strategyType}`);
    }

    this.enabledStrategies[strategyType] = enabled;
    console.log(`[StrategyFactory] ${strategyType} strategy ${enabled ? "enabled" : "disabled"}`);

    // Clear cache to recreate strategies
    this.strategyInstances.clear();
  }

  /**
   * Get all strategy instances
   *
   * @returns {Map} Map of market -> { type, instance }
   */
  getAllStrategies() {
    return this.strategyInstances;
  }

  /**
   * Get statistics
   *
   * @returns {Object} Statistics
   */
  getStats() {
    const stats = {
      multiStrategyMode: this.multiStrategyMode,
      defaultStrategyType: this.defaultStrategyType,
      enabledStrategies: this.getEnabledStrategies(),
      totalMarkets: this.strategyInstances.size,
      momentumMarkets: 0,
      scalpingMarkets: 0,
      rsiReversionMarkets: 0,
      rsiReversionAltMarkets: 0,
      perMarketOverrides: Object.keys(this.strategyTypePerMarket).length,
    };

    for (const [market, cached] of this.strategyInstances) {
      // Handle both single-strategy and multi-strategy cache formats
      const types = Array.isArray(cached) ? cached.map((s) => s.type) : [cached.type];

      for (const type of types) {
        if (type === "momentum") {
          stats.momentumMarkets++;
        } else if (type === "scalping") {
          stats.scalpingMarkets++;
        } else if (type === "rsi-reversion") {
          stats.rsiReversionMarkets++;
        } else if (type === "rsi-reversion-alt") {
          stats.rsiReversionAltMarkets++;
        }
      }
    }

    return stats;
  }

  /**
   * Reset all strategies (clear cache)
   */
  reset() {
    console.log("[StrategyFactory] Resetting all strategies");
    this.strategyInstances.clear();
  }
}

module.exports = StrategyFactory;
