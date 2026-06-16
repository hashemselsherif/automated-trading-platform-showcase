let strategyEnvManager = null;
try {
  strategyEnvManager = require("./utils/strategy-env-manager");
} catch {
  // Optional: strategy env manager not available in all contexts.
}

class RiskManager {
  constructor(config, options = {}) {
    // Store full config for strategy-aware risk management
    this.fullConfig = config;

    // Default risk config (momentum)
    this.config = config.risk;

    // Store max leverage from leverage config for position sizing calculations
    this.maxLeverage = config.leverage?.maxLeverage || config.leverage?.long || 6;

    // Strategy-aware risk configs
    this.riskConfigs = {
      momentum: this._extractMomentumRiskConfig(config),
      scalping: this._extractScalpingRiskConfig(config),
      "rsi-reversion": this._extractRsiReversionRiskConfig(config),
      "rsi-reversion-alt": this._extractRsiReversionRiskConfig(config), // Same config as rsi-reversion
      "btc-breakout": this._extractBtcBreakoutRiskConfig(config),
      "ichimoku-cloud": this._extractIchimokuRiskConfig(config),
      "copy-trading": this._extractCopyTradingRiskConfig(config),
    };

    // Strategy factory (optional, for determining strategy type per market)
    this.strategyFactory = options.strategyFactory || null;

    console.log("[RiskManager] Initialized with strategy-aware risk configs");
    console.log("[RiskManager] Momentum:", {
      stopLoss: this.riskConfigs.momentum.stopLossPercent + "%",
      takeProfit: this.riskConfigs.momentum.takeProfitPercent + "%",
    });
    console.log("[RiskManager] Scalping:", {
      stopLoss: this.riskConfigs.scalping.stopLossPercent + "%",
      takeProfit: this.riskConfigs.scalping.takeProfitPercent + "%",
    });
    console.log("[RiskManager] RSI-Reversion:", {
      // NOTE: stopLossPercent for RSI-reversion is intended to match RSI_HARD_STOP_PERCENT (collateral %)
      stopLoss: this.riskConfigs["rsi-reversion"].stopLossPercent + "%",
      takeProfit: this.riskConfigs["rsi-reversion"].takeProfitPercent + "%",
    });
    console.log("[RiskManager] BTC-Breakout:", {
      stopLoss: this.riskConfigs["btc-breakout"].stopLossPercent + "%",
      takeProfit: this.riskConfigs["btc-breakout"].takeProfitPercent + "%",
    });
    console.log("[RiskManager] Copy-Trading:", {
      stopLoss: this.riskConfigs["copy-trading"].stopLossPercent + "%",
      takeProfit: this.riskConfigs["copy-trading"].takeProfitPercent + "%",
    });
  }

  /**
   * Extract momentum risk configuration
   */
  _extractMomentumRiskConfig(config) {
    return {
      // Stop loss & take profit
      stopLossPercent: config.risk?.stopLossPercent || 5, // 5% (wide for momentum)
      takeProfitPercent: config.risk?.takeProfitPercent || 15, // 15% (wide for momentum)
      trailingStopPercent: config.risk?.trailingStopPercent || 1, // 1%
      useTrailingStop: config.risk?.useTrailingStop !== false,

      // Position sizing
      minPositionSize: config.risk?.minPositionSize || 50,
      maxPositionSize: config.risk?.maxPositionSize || 10000,
      positionSizePercent: config.risk?.positionSizePercent || 10, // 10%
      riskPerTradePercent: config.risk?.riskPerTradePercent || 0.05, // 5%
      sizingMethod: config.risk?.sizingMethod || "risk", // risk-based

      // Time & funding
      maxPositionHours: config.risk?.maxPositionHours || 72, // 3 days
      maxFundingRatePercent: config.risk?.maxFundingRatePercent || 0.01, // 1%
    };
  }

  /**
   * Extract scalping risk configuration
   */
  _extractScalpingRiskConfig(config) {
    const num = (v, d) => {
      if (v === undefined || v === "") return d;
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };

    const bool = (v, d) => {
      if (v === undefined) return d;
      const s = String(v).toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "y";
    };

    return {
      // Stop loss & take profit (TIGHT for scalping)
      stopLossPercent: num(process.env.SCALPING_STOP_LOSS_PERCENT, 0.15), // 0.15% (tight)
      takeProfitPercent: num(process.env.SCALPING_TAKE_PROFIT_PERCENT, 1.2), // 1.20% (tight)
      trailingStopPercent: 0, // No trailing stop for scalping
      useTrailingStop: false, // Hard stops only

      // Position sizing
      minPositionSize: num(
        process.env.SCALPING_MIN_POSITION_SIZE,
        config.risk?.minPositionSize || 50
      ),
      maxPositionSize: num(
        process.env.SCALPING_MAX_POSITION_SIZE,
        config.risk?.maxPositionSize || 10000
      ),
      positionSizePercent: num(process.env.SCALPING_POSITION_SIZE_PERCENT, 20), // 20%
      riskPerTradePercent: num(process.env.SCALPING_RISK_PER_TRADE_PERCENT, 1.5) / 100, // 1.5% -> 0.015
      sizingMethod: process.env.SCALPING_POSITION_SIZING_METHOD || "risk", // risk-based default

      // Time & funding (not used for scalping - positions close quickly)
      maxPositionHours: num(process.env.SCALPING_MAX_POSITION_HOURS, 1), // 1 hour max
      maxFundingRatePercent: num(process.env.SCALPING_MAX_FUNDING_RATE_PERCENT, 0.01), // 1%
    };
  }

  /**
   * Extract Ichimoku breakout risk configuration (trend-following, momentum-like).
   */
  _extractIchimokuRiskConfig(config) {
    return {
      // Stop loss & take profit
      stopLossPercent: config.risk?.stopLossPercent || 5,
      takeProfitPercent: config.risk?.takeProfitPercent || 15,
      trailingStopPercent: config.risk?.trailingStopPercent || 1,
      useTrailingStop: config.risk?.useTrailingStop !== false,

      // Position sizing
      minPositionSize: config.risk?.minPositionSize || 50,
      maxPositionSize: config.risk?.maxPositionSize || 10000,
      positionSizePercent: config.risk?.positionSizePercent || 10,
      riskPerTradePercent: config.risk?.riskPerTradePercent || 0.05,
      sizingMethod: config.risk?.sizingMethod || "risk",

      // Time & funding
      maxPositionHours: config.risk?.maxPositionHours || 72,
      maxFundingRatePercent: config.risk?.maxFundingRatePercent || 0.01,
    };
  }

  _extractBtcBreakoutRiskConfig(config) {
    const num = (v, d) => {
      if (v === undefined || v === "") return d;
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };

    return {
      stopLossPercent: num(process.env.STOP_LOSS_PERCENT, config.risk?.stopLossPercent || 8),
      takeProfitPercent: num(process.env.TAKE_PROFIT_PERCENT, config.risk?.takeProfitPercent || 10),
      trailingStopPercent: num(
        process.env.TRAILING_STOP_PERCENT,
        config.risk?.trailingStopPercent || 2
      ),
      useTrailingStop:
        process.env.USE_TRAILING_STOP !== undefined
          ? String(process.env.USE_TRAILING_STOP).toLowerCase() === "true"
          : config.risk?.useTrailingStop === true,

      minPositionSize: config.risk?.minPositionSize || 50,
      maxPositionSize: config.risk?.maxPositionSize || 10000,
      positionSizePercent: config.risk?.positionSizePercent || 10,
      riskPerTradePercent: config.risk?.riskPerTradePercent || 0.05,
      sizingMethod: config.risk?.sizingMethod || "risk",

      maxPositionHours: config.risk?.maxPositionHours || 168,
      maxFundingRatePercent: config.risk?.maxFundingRatePercent || 0.01,
    };
  }

  _extractCopyTradingRiskConfig(config) {
    return {
      stopLossPercent: config.risk?.stopLossPercent || 5,
      takeProfitPercent: config.risk?.takeProfitPercent || 15,
      trailingStopPercent: config.risk?.trailingStopPercent || 1,
      useTrailingStop: config.risk?.useTrailingStop !== false,
      minPositionSize: config.risk?.minPositionSize || 50,
      maxPositionSize: config.risk?.maxPositionSize || 10000,
      positionSizePercent: config.risk?.positionSizePercent || 10,
      riskPerTradePercent: config.risk?.riskPerTradePercent || 0.05,
      sizingMethod: config.risk?.sizingMethod || "risk",
      maxPositionHours: config.risk?.maxPositionHours || 72,
      maxFundingRatePercent: config.risk?.maxFundingRatePercent || 0.01,
    };
  }

  /**
   * Extract RSI mean-reversion risk configuration.
   *
   * Important: In this codebase, `stopLossPercent` is compared against leveraged PnL%
   * (i.e., collateral PnL% after leverage), so it matches RSI_HARD_STOP_PERCENT semantics.
   *
   * We keep other risk limits aligned with the base config.risk, but make the stop-loss
   * default to RSI_HARD_STOP_PERCENT (with per-market overrides applied in getRiskConfigForMarket()).
   */
  _extractRsiReversionRiskConfig(config) {
    const num = (v, d) => {
      if (v === undefined || v === "") return d;
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };

    return {
      // Stop loss & take profit
      // Default to RSI hard stop (collateral %) for mean-reversion.
      stopLossPercent: num(process.env.RSI_HARD_STOP_PERCENT, config.risk?.stopLossPercent || 5),

      // Take profit can remain configured via TAKE_PROFIT_PERCENT / config.risk, but RSI strategies
      // typically handle exits via RSI targets. Keeping it configurable preserves existing behavior.
      takeProfitPercent: config.risk?.takeProfitPercent || 15,

      trailingStopPercent: 0, // generally not used for mean-reversion (handled in strategy)
      useTrailingStop: false,

      // Position sizing
      minPositionSize: config.risk?.minPositionSize || 50,
      maxPositionSize: config.risk?.maxPositionSize || 10000,
      positionSizePercent: config.risk?.positionSizePercent || 10,
      riskPerTradePercent: config.risk?.riskPerTradePercent || 0.05,
      sizingMethod: config.risk?.sizingMethod || "risk",

      // Time & funding
      maxPositionHours: config.risk?.maxPositionHours || 72,
      maxFundingRatePercent: config.risk?.maxFundingRatePercent || 0.01,
    };
  }

  /**
   * Get risk config for a strategy type
   */
  getRiskConfig(strategyType) {
    return this.riskConfigs[strategyType] || this.riskConfigs.momentum;
  }

  /**
   * Get risk config for a market (uses strategy factory to determine strategy type)
   */
  getRiskConfigForMarket(market, strategyType = null) {
    if (!this.strategyFactory) {
      // Fallback to default config if no factory
      return this.config;
    }

    const resolvedStrategyType = strategyType || this.strategyFactory.getStrategyType(market);
    let base = this.getRiskConfig(resolvedStrategyType);

    // Strategy-aware overrides from isolated env snapshots (prevents env bleeding).
    if (
      strategyEnvManager &&
      market &&
      typeof strategyEnvManager.getStrategyForMarket === "function"
    ) {
      const strategyId = strategyEnvManager.getStrategyForMarket(market, resolvedStrategyType);
      if (strategyId) {
        const hasVal = (v) => v !== undefined && v !== null && v !== "";
        const toNum = (v) => {
          if (!hasVal(v)) return null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        const overrides = {};

        const stopLoss = strategyEnvManager.getMarketConfig(
          market,
          "STOP_LOSS_PERCENT",
          null,
          resolvedStrategyType
        );
        const takeProfit = strategyEnvManager.getMarketConfig(
          market,
          "TAKE_PROFIT_PERCENT",
          null,
          resolvedStrategyType
        );
        const trailingStop = strategyEnvManager.getMarketConfig(
          market,
          "TRAILING_STOP_PERCENT",
          null,
          resolvedStrategyType
        );
        const useTrailingStop = strategyEnvManager.getMarketConfig(
          market,
          "USE_TRAILING_STOP",
          null,
          resolvedStrategyType
        );
        const positionSizePct = strategyEnvManager.getMarketConfig(
          market,
          "POSITION_SIZE_PERCENT",
          null,
          resolvedStrategyType
        );
        const sizingMethod = strategyEnvManager.getMarketConfig(
          market,
          "POSITION_SIZING_METHOD",
          null,
          resolvedStrategyType
        );
        const riskPerTradePct = strategyEnvManager.getMarketConfig(
          market,
          "RISK_PER_TRADE_PERCENT",
          null,
          resolvedStrategyType
        );
        const minPos = strategyEnvManager.getMarketConfig(
          market,
          "MIN_POSITION_SIZE",
          null,
          resolvedStrategyType
        );
        const maxPos = strategyEnvManager.getMarketConfig(
          market,
          "MAX_POSITION_SIZE",
          null,
          resolvedStrategyType
        );
        const maxHours = strategyEnvManager.getMarketConfig(
          market,
          "MAX_POSITION_HOURS",
          null,
          resolvedStrategyType
        );
        const maxFunding = strategyEnvManager.getMarketConfig(
          market,
          "MAX_FUNDING_RATE_PERCENT",
          null,
          resolvedStrategyType
        );

        if (hasVal(stopLoss)) {
          const n = toNum(stopLoss);
          if (n !== null) overrides.stopLossPercent = n;
        }
        if (hasVal(takeProfit)) {
          const n = toNum(takeProfit);
          if (n !== null) overrides.takeProfitPercent = n;
        }
        if (hasVal(trailingStop)) {
          const n = toNum(trailingStop);
          if (n !== null) overrides.trailingStopPercent = n;
        }
        if (hasVal(useTrailingStop)) {
          overrides.useTrailingStop = strategyEnvManager.getMarketConfigBool(
            market,
            "USE_TRAILING_STOP",
            base.useTrailingStop,
            resolvedStrategyType
          );
        }
        if (hasVal(positionSizePct)) {
          const n = toNum(positionSizePct);
          if (n !== null) overrides.positionSizePercent = n;
        }
        if (hasVal(sizingMethod)) overrides.sizingMethod = String(sizingMethod).toLowerCase();
        if (hasVal(riskPerTradePct)) {
          const n = toNum(riskPerTradePct);
          if (n !== null) overrides.riskPerTradePercent = n;
        }
        if (hasVal(minPos)) {
          const n = toNum(minPos);
          if (n !== null) overrides.minPositionSize = n;
        }
        if (hasVal(maxPos)) {
          const n = toNum(maxPos);
          if (n !== null) overrides.maxPositionSize = n;
        }
        if (hasVal(maxHours)) {
          const n = toNum(maxHours);
          if (n !== null) overrides.maxPositionHours = n;
        }
        if (hasVal(maxFunding)) {
          const n = toNum(maxFunding);
          if (n !== null) overrides.maxFundingRatePercent = n;
        }

        if (Object.keys(overrides).length > 0) {
          base = { ...base, ...overrides };
        }
      }
    }

    if (resolvedStrategyType === "copy-trading" && strategyEnvManager && market) {
      const env = strategyEnvManager.getEnvForMarket(market, resolvedStrategyType) || {};
      const hasVal = (v) => v !== undefined && v !== null && v !== "";
      const toNum = (v) => {
        if (!hasVal(v)) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const toBool = (v) => {
        if (!hasVal(v)) return null;
        const s = String(v).toLowerCase();
        if (["1", "true", "yes", "y", "on"].includes(s)) return true;
        if (["0", "false", "no", "n", "off"].includes(s)) return false;
        return null;
      };
      const copyOverrides = {};
      const copyStopLoss = toNum(env.COPY_STOP_LOSS_PERCENT);
      const copyTakeProfit = toNum(env.COPY_TAKE_PROFIT_PERCENT);
      const copyTrailing = toNum(env.COPY_TRAILING_STOP_PERCENT);
      const copyUseTrailing = toBool(env.COPY_USE_TRAILING_STOP);
      const copyPositionSize = toNum(env.COPY_POSITION_SIZE_PERCENT);
      const copySizingMethod = env.COPY_POSITION_SIZING_METHOD;
      const copyRiskPerTrade = toNum(env.COPY_RISK_PER_TRADE_PERCENT);
      const copyMinPos = toNum(env.COPY_MIN_POSITION_SIZE);
      const copyMaxPos = toNum(env.COPY_MAX_POSITION_SIZE);
      const copyMaxHours = toNum(env.COPY_MAX_POSITION_HOURS);
      const copyMaxFunding = toNum(env.COPY_MAX_FUNDING_RATE_PERCENT);

      if (copyStopLoss !== null) copyOverrides.stopLossPercent = copyStopLoss;
      if (copyTakeProfit !== null) copyOverrides.takeProfitPercent = copyTakeProfit;
      if (copyTrailing !== null) copyOverrides.trailingStopPercent = copyTrailing;
      if (copyUseTrailing !== null) copyOverrides.useTrailingStop = copyUseTrailing;
      if (copyPositionSize !== null) copyOverrides.positionSizePercent = copyPositionSize;
      if (hasVal(copySizingMethod))
        copyOverrides.sizingMethod = String(copySizingMethod).toLowerCase();
      if (copyRiskPerTrade !== null) copyOverrides.riskPerTradePercent = copyRiskPerTrade;
      if (copyMinPos !== null) copyOverrides.minPositionSize = copyMinPos;
      if (copyMaxPos !== null) copyOverrides.maxPositionSize = copyMaxPos;
      if (copyMaxHours !== null) copyOverrides.maxPositionHours = copyMaxHours;
      if (copyMaxFunding !== null) copyOverrides.maxFundingRatePercent = copyMaxFunding;

      if (Object.keys(copyOverrides).length > 0) {
        base = { ...base, ...copyOverrides };
      }
    }

    // Per-market overrides (env-based) for RSI mean-reversion.
    // This aligns bot-level STOP_LOSS with strategy-level RSI hard stop settings.
    if (
      (resolvedStrategyType === "rsi-reversion" || resolvedStrategyType === "rsi-reversion-alt") &&
      market
    ) {
      const marketKey = String(market).replace(/-/g, "_"); // ETH-PERP -> ETH_PERP
      const perMarketHardStop =
        strategyEnvManager &&
        strategyEnvManager.getStrategyForMarket?.(market, resolvedStrategyType)
          ? strategyEnvManager.getMarketConfig(
              market,
              "HARD_STOP_PERCENT",
              null,
              resolvedStrategyType
            )
          : process.env[`STRATEGY_${marketKey}_HARD_STOP_PERCENT`];
      const n =
        perMarketHardStop !== undefined && perMarketHardStop !== ""
          ? Number(perMarketHardStop)
          : null;

      if (Number.isFinite(n) && n > 0) {
        if (process.env.DEBUG_RISK_MANAGER === "true" || process.env.DEBUG_STOP_LOSS === "true") {
          console.log(
            `[RiskManager] Using per-market HARD_STOP_PERCENT for ${market}: ${n}% (env STRATEGY_${marketKey}_HARD_STOP_PERCENT)`
          );
        }
        return {
          ...base,
          stopLossPercent: n,
        };
      }
    }

    return base;
  }

  /**
   * Set strategy factory (for runtime integration)
   */
  setStrategyFactory(factory) {
    this.strategyFactory = factory;
  }

  calculatePositionSize(availableCapital, opts = {}) {
    if (!Number.isFinite(availableCapital) || availableCapital <= 0) {
      if (process.env.DEBUG_RISK_MANAGER === "true") {
        console.log("[RISK_MGR] Return 0: invalid availableCapital", availableCapital);
      }
      return 0;
    }

    // Get strategy-aware risk config
    const riskConfig = opts.market
      ? this.getRiskConfigForMarket(opts.market, opts.strategyType)
      : this.config;

    const price = Number(opts.price);
    const stopDistance = opts.stopDistance != null ? Number(opts.stopDistance) : null; // Handle null/undefined properly
    const equity = Number.isFinite(opts.equity) ? Number(opts.equity) : availableCapital;
    const minNotional = Number.isFinite(opts.minNotional) ? Number(opts.minNotional) : 0;
    const maxNotional = Number.isFinite(riskConfig.maxPositionSize)
      ? riskConfig.maxPositionSize
      : Infinity;
    const positionSizePercentOverride =
      opts.positionSizePercentOverride != null ? Number(opts.positionSizePercentOverride) : null;
    const rawSizeFraction = opts.sizeFraction != null ? Number(opts.sizeFraction) : null;
    const sizeFraction = Number.isFinite(rawSizeFraction)
      ? Math.max(0, Math.min(rawSizeFraction, 1))
      : 1;
    if (sizeFraction <= 0) return 0;

    // Get expected leverage (will be applied by caller)
    // If not provided, use max leverage as conservative estimate
    const expectedLeverage =
      Number.isFinite(opts.leverage) && opts.leverage > 0 ? opts.leverage : this.maxLeverage;

    // Determine sizing method: priority: opts > riskConfig.sizingMethod > config.sizingMethod
    const forceMethod =
      opts.forceSizingMethod ||
      riskConfig.sizingMethod ||
      this.config.sizingMethod ||
      this.config.forceSizingMethod;

    // Always log if DEBUG_RISK_MANAGER is enabled, or log key info for debugging position sizing bug
    if (process.env.DEBUG_RISK_MANAGER === "true" || process.env.DEBUG_POSITION_SIZING === "true") {
      console.log("[RISK_MGR] calculatePositionSize:", {
        market: opts.market,
        availableCapital: availableCapital.toFixed(2),
        price: price?.toFixed(2),
        stopDistance: stopDistance?.toFixed(4),
        forceMethod,
        sizingMethod: riskConfig.sizingMethod,
        positionSizePercent: riskConfig.positionSizePercent,
        riskPerTradePercent: riskConfig.riskPerTradePercent,
        sizeFraction,
        expectedLeverage,
        maxPositionSize: riskConfig.maxPositionSize,
      });
    }

    // CRITICAL: Calculate leverage constraint
    // When leverage is applied: notional = baseSize * leverage
    // Required collateral = notional / leverage = baseSize
    // Constraint: baseSize <= availableCapital (collateral cannot exceed available capital)
    // Also consider maxPositionSize: notional = baseSize * leverage <= maxNotional
    // Therefore: baseSize <= min(availableCapital, maxNotional / expectedLeverage)
    const maxBaseSizeFromCapital = availableCapital; // Collateral constraint
    const maxBaseSizeFromMaxNotional = maxNotional / expectedLeverage; // Max notional constraint
    const maxBaseSize = Math.min(maxBaseSizeFromCapital, maxBaseSizeFromMaxNotional);

    // If forced to percent-based, skip equal-risk sizing
    if (forceMethod === "percent") {
      // Fall through to percent-based sizing below
    } else if (
      Number.isFinite(price) &&
      price > 0 &&
      stopDistance != null &&
      Number.isFinite(stopDistance) &&
      stopDistance > 0
    ) {
      // Use equal-risk sizing when stop distance is available (default behavior)
      // Default: 5% of equity per trade (can be overridden via RISK_PER_TRADE_PERCENT env var)
      // For more conservative risk profile, set RISK_PER_TRADE_PERCENT to 0.005 (0.5%)
      const defaultRiskPercent = riskConfig.riskPerTradePercent || 0.05; // Default: 5%
      const riskPerTrade = equity * defaultRiskPercent * sizeFraction;

      // Calculate notional size needed to risk riskPerTrade at stopDistance
      // Loss at stop (USD) = (notional / price) * stopDistance
      // Solving for notional: notional = riskPerTrade * (price / stopDistance)
      // This is the notional AFTER leverage will be applied
      const targetNotional = riskPerTrade * (price / stopDistance);

      if (!Number.isFinite(targetNotional) || targetNotional <= 0) return 0;

      // Convert target notional to base size (before leverage)
      // baseSize = targetNotional / expectedLeverage
      let baseSize = targetNotional / expectedLeverage;

      // Calculate maximum base size from positionSizePercent constraint
      // For equal-risk sizing, positionSizePercent is a soft limit that allows risk-based sizing
      // to exceed it when needed to achieve risk per trade, but caps at maxPositionSize
      const cappedPositionSizePercent =
        ((Number.isFinite(positionSizePercentOverride) && positionSizePercentOverride > 0
          ? positionSizePercentOverride
          : riskConfig.positionSizePercent || 10) *
          sizeFraction) /
        100;

      // Max base size from positionSizePercent (before leverage)
      // When positionSizePercent=100%, allow risk-based sizing to use full capital
      const maxBaseSizeFromPercent =
        cappedPositionSizePercent >= 1.0
          ? availableCapital // 100% allows full capital usage
          : availableCapital * cappedPositionSizePercent;

      // For equal-risk sizing: prioritize risk per trade, but respect position size limits
      // If positionSizePercent < 100%, it's a hard cap
      // If positionSizePercent = 100%, allow risk-based sizing (subject to maxBaseSize)
      let effectiveMaxBaseSize;
      if (cappedPositionSizePercent >= 1.0) {
        // positionSizePercent=100%: Allow risk-based sizing, only cap by leverage constraints
        effectiveMaxBaseSize = maxBaseSize;
      } else {
        // positionSizePercent < 100%: Apply both caps (most restrictive)
        effectiveMaxBaseSize = Math.min(maxBaseSize, maxBaseSizeFromPercent);
      }

      // Apply the limit: prioritize risk-based sizing but respect safety caps
      baseSize = Math.max(minNotional / expectedLeverage, Math.min(baseSize, effectiveMaxBaseSize));

      if (process.env.DEBUG_RISK_MANAGER === "true") {
        console.log("[RISK_MGR] Equal-risk result:", {
          targetNotional,
          baseSize,
          expectedLeverage,
          effectiveMaxBaseSize,
          maxBaseSize,
          minNotional: minNotional / expectedLeverage,
        });
      }
      return baseSize;
    }

    // Volatility-scaled sizing: size inversely to ATR
    // In calm markets (low ATR) → larger positions
    // In volatile markets (high ATR) → smaller positions
    if (forceMethod === "volatility-scaled" && Number.isFinite(price) && price > 0) {
      const atr = opts.atr;
      const volatilityScaleBase = opts.volatilityScaleBase || 0.015; // Target ATR% (1.5%)
      const basePct =
        ((Number.isFinite(positionSizePercentOverride) && positionSizePercentOverride > 0
          ? positionSizePercentOverride
          : riskConfig.positionSizePercent || 40) *
          sizeFraction) /
        100;

      if (Number.isFinite(atr) && atr > 0) {
        const atrPercent = atr / price;
        const scaleFactor = volatilityScaleBase / Math.max(atrPercent, 0.001);
        // Clamp scale factor to reasonable range (0.5x to 2x)
        const clampedScale = Math.max(0.5, Math.min(2.0, scaleFactor));
        let baseSize = availableCapital * basePct * clampedScale;

        // Apply max constraints
        baseSize = Math.max(minNotional / expectedLeverage, Math.min(baseSize, maxBaseSize));

        if (process.env.DEBUG_RISK_MANAGER === "true") {
          console.log("[RISK_MGR] Volatility-scaled result:", {
            atr,
            price,
            atrPercent: (atrPercent * 100).toFixed(2) + "%",
            volatilityScaleBase,
            scaleFactor: scaleFactor.toFixed(2),
            clampedScale: clampedScale.toFixed(2),
            baseSize: baseSize.toFixed(2),
          });
        }
        return baseSize;
      }
      // Fall through to percent-based if no ATR
    }

    // Kelly criterion sizing
    if (forceMethod === "kelly") {
      const kellyFraction = opts.kellyFraction || 0.25; // Quarter-Kelly default
      const winRate = opts.winRate || 0.65; // Default 65%
      const avgWin = opts.avgWin || 100;
      const avgLoss = opts.avgLoss || 80;

      const p = winRate;
      const q = 1 - p;
      const b = avgLoss > 0 ? avgWin / avgLoss : 1;

      let kellyF = (p * b - q) / b;
      kellyF = Math.max(0, Math.min(kellyF, 1)); // Clamp 0-1

      const effectiveKelly = kellyF * kellyFraction;
      let baseSize = availableCapital * effectiveKelly * sizeFraction;
      baseSize = Math.max(minNotional / expectedLeverage, Math.min(baseSize, maxBaseSize));

      if (process.env.DEBUG_RISK_MANAGER === "true") {
        console.log("[RISK_MGR] Kelly result:", {
          winRate,
          b: b.toFixed(2),
          kellyF: (kellyF * 100).toFixed(1) + "%",
          effectiveKelly: (effectiveKelly * 100).toFixed(1) + "%",
          baseSize: baseSize.toFixed(2),
        });
      }
      return baseSize;
    }

    // Percent-of-capital sizing (fallback or forced)
    // Use positionSizePercent for position sizing (e.g., 10% of capital per position)
    const effectivePct =
      (Number.isFinite(positionSizePercentOverride) && positionSizePercentOverride > 0
        ? positionSizePercentOverride
        : riskConfig.positionSizePercent || 10) * sizeFraction;
    const positionSizePercent = effectivePct / 100; // Convert % to decimal

    // Base size is a percentage of available capital (before leverage)
    // This will be multiplied by leverage to get the notional size
    const baseNotional = availableCapital * positionSizePercent;

    // Apply leverage constraints
    // The base size cannot exceed availableCapital (collateral constraint)
    // and the resulting notional (baseSize * leverage) cannot exceed maxNotional
    const effectiveMaxBaseSize = Math.min(maxBaseSize, baseNotional);
    const size = Math.max(
      minNotional / expectedLeverage,
      Math.min(baseNotional, effectiveMaxBaseSize)
    );
    const result = Number.isFinite(size) && size > 0 ? size : 0;

    // Always log if DEBUG_RISK_MANAGER or DEBUG_POSITION_SIZING is enabled
    if (process.env.DEBUG_RISK_MANAGER === "true" || process.env.DEBUG_POSITION_SIZING === "true") {
      console.log("[RISK_MGR] Percent-based result:", {
        availableCapital: availableCapital.toFixed(2),
        positionSizePercent: (positionSizePercent * 100).toFixed(2) + "%",
        positionSizePercentOverride: Number.isFinite(positionSizePercentOverride)
          ? positionSizePercentOverride
          : null,
        sizeFraction,
        baseNotional: baseNotional.toFixed(2),
        maxBaseSize: maxBaseSize.toFixed(2),
        effectiveMaxBaseSize: effectiveMaxBaseSize.toFixed(2),
        size: size.toFixed(2),
        result: result.toFixed(2),
        expectedLeverage,
        minNotional: minNotional / expectedLeverage,
      });
    }
    return result;
  }

  shouldTakeProfit(position, currentPrice, perpsClient) {
    const pnlPercent = perpsClient.calculatePnL(position, currentPrice);

    // Get strategy-aware risk config for this position's market
    const riskConfig = position.market
      ? this.getRiskConfigForMarket(position.market, position.strategyType)
      : this.config;

    // pnlPercent is already leverage-adjusted (e.g., 5% price move × 3x leverage = 15% PnL)
    // So we compare directly to takeProfitPercent without multiplying by leverage again
    if (pnlPercent >= riskConfig.takeProfitPercent) {
      return { should: true, reason: "TAKE_PROFIT", pnl: pnlPercent };
    }

    if (riskConfig.useTrailingStop && position.highestPnl) {
      const drawdownFromPeak = position.highestPnl - pnlPercent;
      // pnlPercent is already leverage-adjusted, so compare directly to trailingStopPercent
      const trailingThreshold = riskConfig.trailingStopPercent;

      if (drawdownFromPeak >= trailingThreshold) {
        return { should: true, reason: "TRAILING_STOP", pnl: pnlPercent };
      }
    }

    return { should: false };
  }

  shouldStopLoss(position, currentPrice, perpsClient) {
    const pnlPercent = perpsClient.calculatePnL(position, currentPrice);

    // Get strategy-aware risk config for this position's market
    const riskConfig = position.market
      ? this.getRiskConfigForMarket(position.market, position.strategyType)
      : this.config;

    // Optional per-position override (used by allocator risk mapping post-selection)
    // This is compared against leveraged PnL% (same semantics as riskConfig.stopLossPercent).
    const stopLossPercentOverride =
      position && position.stopLossPercentOverride != null
        ? Number(position.stopLossPercentOverride)
        : null;
    const effectiveStopLossPercent =
      Number.isFinite(stopLossPercentOverride) && stopLossPercentOverride > 0
        ? stopLossPercentOverride
        : riskConfig.stopLossPercent;

    // pnlPercent is already leverage-adjusted (e.g., 5% price move × 3x leverage = 15% PnL)
    // So we compare directly to stopLossPercent without multiplying by leverage again
    if (pnlPercent <= -effectiveStopLossPercent) {
      return { should: true, reason: "STOP_LOSS", pnl: pnlPercent };
    }

    if (perpsClient.isNearLiquidation(position, currentPrice)) {
      return { should: true, reason: "LIQUIDATION_PROTECTION", pnl: pnlPercent };
    }

    return { should: false };
  }

  shouldTimeExit(position) {
    const hoursOpen = (Date.now() - position.openTime) / (1000 * 60 * 60);

    // Get strategy-aware risk config for this position's market
    const riskConfig = position.market
      ? this.getRiskConfigForMarket(position.market, position.strategyType)
      : this.config;

    if (hoursOpen >= riskConfig.maxPositionHours) {
      return { should: true, reason: "TIME_EXIT", hoursOpen };
    }

    return { should: false };
  }

  async shouldExitFunding(position, fundingRate) {
    const absFundingRate = Math.abs(fundingRate);

    // Get strategy-aware risk config for this position's market
    const riskConfig = position.market
      ? this.getRiskConfigForMarket(position.market, position.strategyType)
      : this.config;

    if (
      (position.side === "long" && fundingRate > riskConfig.maxFundingRatePercent) ||
      (position.side === "short" && fundingRate < -riskConfig.maxFundingRatePercent)
    ) {
      return { should: true, reason: "HIGH_FUNDING", rate: fundingRate };
    }

    return { should: false };
  }

  updatePosition(position, currentPrice, perpsClient) {
    const pnlPercent = perpsClient.calculatePnL(position, currentPrice);

    if (!position.highestPnl || pnlPercent > position.highestPnl) {
      position.highestPnl = pnlPercent;
    }
  }

  // ============================================================
  // VENUE-AWARE EXPOSURE TRACKING (Phase 3: Hybrid Venue Routing)
  // ============================================================

  /**
   * Get venue router (lazy-loaded to avoid circular deps)
   */
  _getVenueRouter() {
    if (!this._venueRouter) {
      try {
        this._venueRouter = require("./utils/venue-router");
      } catch (e) {
        console.warn("[RiskManager] Venue router not available:", e.message);
        return null;
      }
    }
    return this._venueRouter;
  }

  /**
   * Calculate exposure stats per venue/capital pool
   * @param {Array} openPositions - Array of open position objects
   * @returns {Object} Per-venue exposure breakdown
   */
  getVenueExposure(openPositions) {
    const venueRouter = this._getVenueRouter();
    if (!venueRouter) {
      // Fallback: all positions in single pool
      return {
        jupiter: {
          positions: openPositions.length,
          collateral: this._sumCollateral(openPositions),
          markets: [],
        },
        drift: { positions: 0, collateral: 0, markets: [] },
        total: { positions: openPositions.length, collateral: this._sumCollateral(openPositions) },
      };
    }

    const result = {
      jupiter: { positions: 0, collateral: 0, notional: 0, markets: [] },
      drift: { positions: 0, collateral: 0, notional: 0, markets: [] },
      total: { positions: 0, collateral: 0, notional: 0 },
    };

    for (const pos of openPositions) {
      const venue = venueRouter.getVenueForMarket(pos.market || "SOL-PERP");
      const bucket = result[venue] || result.jupiter;

      bucket.positions++;
      bucket.collateral += pos.collateral || 0;
      bucket.notional += pos.size || pos.collateral * (pos.leverage || 1);
      if (pos.market && !bucket.markets.includes(pos.market)) {
        bucket.markets.push(pos.market);
      }
    }

    result.total.positions = result.jupiter.positions + result.drift.positions;
    result.total.collateral = result.jupiter.collateral + result.drift.collateral;
    result.total.notional = result.jupiter.notional + result.drift.notional;

    return result;
  }

  /**
   * Check if a new position can be opened based on per-venue limits
   * @param {string} market - Target market
   * @param {Array} openPositions - Current open positions
   * @param {number} collateralUsd - Collateral for new position
   * @returns {Object} { allowed: boolean, reason?: string, venue: string, poolStats: Object }
   */
  checkVenueCapacity(market, openPositions, collateralUsd = 0) {
    const venueRouter = this._getVenueRouter();
    if (!venueRouter) {
      // Fallback: use global limits
      const maxPos = this.fullConfig.maxOpenPositions || 4;
      const currentPos = openPositions.length;
      return {
        allowed: currentPos < maxPos,
        reason: currentPos >= maxPos ? "MAX_POSITIONS_REACHED" : undefined,
        venue: "jupiter",
        poolStats: { current: currentPos, max: maxPos },
      };
    }

    const venue = venueRouter.getVenueForMarket(market);
    const pool = venueRouter.getCapitalPool(market, this.fullConfig);
    const exposure = this.getVenueExposure(openPositions);
    const venueExposure = exposure[venue];

    // Check position count limit for this venue
    if (venueExposure.positions >= pool.maxPositions) {
      return {
        allowed: false,
        reason: `MAX_POSITIONS_${venue.toUpperCase()}`,
        venue,
        poolStats: {
          current: venueExposure.positions,
          max: pool.maxPositions,
          collateral: venueExposure.collateral,
          balance: pool.balance,
        },
      };
    }

    // Check collateral doesn't exceed pool balance
    const newTotalCollateral = venueExposure.collateral + collateralUsd;
    if (newTotalCollateral > pool.balance) {
      return {
        allowed: false,
        reason: `INSUFFICIENT_CAPITAL_${venue.toUpperCase()}`,
        venue,
        poolStats: {
          current: venueExposure.collateral,
          requested: collateralUsd,
          available: pool.balance - venueExposure.collateral,
          balance: pool.balance,
        },
      };
    }

    return {
      allowed: true,
      venue,
      poolStats: {
        current: venueExposure.positions,
        max: pool.maxPositions,
        collateral: venueExposure.collateral,
        balance: pool.balance,
        availableCapital: pool.balance - venueExposure.collateral,
      },
    };
  }

  /**
   * Get available capital for a specific venue/pool
   * @param {string} market - Target market (determines venue)
   * @param {Array} openPositions - Current open positions
   * @returns {number} Available capital in USD
   */
  getAvailableCapitalForMarket(market, openPositions) {
    const venueRouter = this._getVenueRouter();
    if (!venueRouter) {
      // Fallback: use global balance
      const totalCollateral = this._sumCollateral(openPositions);
      return (this.fullConfig.paperBalance || 1000) - totalCollateral;
    }

    const venue = venueRouter.getVenueForMarket(market);
    const pool = venueRouter.getCapitalPool(market, this.fullConfig);
    const exposure = this.getVenueExposure(openPositions);
    const venueExposure = exposure[venue];

    return Math.max(0, pool.balance - venueExposure.collateral);
  }

  /**
   * Helper: Sum collateral across positions
   */
  _sumCollateral(positions) {
    return positions.reduce((sum, p) => sum + (p.collateral || 0), 0);
  }
}

module.exports = RiskManager;
