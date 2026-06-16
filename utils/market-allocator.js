// utils/market-allocator.js
//
// Market Allocation Strategy
// Evaluates opportunities across all markets and intelligently distributes trades
// to maximize P&L while finding the optimal strategy for each token.
//
// The allocator scores each market opportunity based on:
//   - Signal confidence
//   - Expected return (ATR, trend strength, ADX, etc.)
//   - Risk-adjusted metrics (Sharpe-like ratio)
//   - Market volatility (lower volatility = better)
//   - Current position exposure per market
//   - Recent performance per market (win rate, avg P&L)

class MarketAllocator {
  constructor(config = {}, options = {}) {
    const numEnv = (key, fallback) => {
      const v = Number(process.env[key]);
      return Number.isFinite(v) ? v : fallback;
    };
    const boolEnv = (key, fallback = false) => {
      const v = process.env[key];
      if (v === undefined) return fallback;
      const s = String(v).trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'y';
    };
    const symEnvNum = (prefix, sym, fallback) => {
      // Supports both:
      // - ALLOCATOR_RISK_LEVERAGE_MULT_MIN_BTC
      // - ALLOCATOR_RISK_LEVERAGE_MULT_MIN_BTC_PERP
      const s = String(sym || '').trim().toUpperCase();
      if (!s) return fallback;
      const direct = `${prefix}_${s}`;
      const perp = `${prefix}_${s}_PERP`;
      if (process.env[direct] !== undefined) return numEnv(direct, fallback);
      if (process.env[perp] !== undefined) return numEnv(perp, fallback);
      return fallback;
    };
    
    // Get markets from config or default to all known markets
    this.markets = config.markets || ['SOL-PERP', 'ETH-PERP', 'BTC-PERP'];
    
    // Strategy factory (optional, for determining strategy type per market)
    this.strategyFactory = options.strategyFactory || null;
    
    // Build default correlation matrix if not provided
    // Includes majors AND alt coins with realistic correlations
    const defaultCorrelationMatrix = {};
    const defaultCorrelations = {
      // === MAJORS ===
      'SOL-PERP': { 'ETH-PERP': 0.7, 'BTC-PERP': 0.6 },
      'ETH-PERP': { 'SOL-PERP': 0.7, 'BTC-PERP': 0.85 },
      'BTC-PERP': { 'SOL-PERP': 0.6, 'ETH-PERP': 0.85 },
      
      // === ALT COINS ===
      // Alt coins are generally highly correlated with each other (0.7-0.85)
      // and moderately correlated with majors (0.5-0.7)
      // Grouped by sector for more accurate correlations
      
      // L1 Chains (high inter-correlation ~0.8)
      'SUI-PERP': { 'APT-PERP': 0.85, 'TAO-PERP': 0.75, 'INJ-PERP': 0.7, 'SOL-PERP': 0.65, 'ETH-PERP': 0.6 },
      'APT-PERP': { 'SUI-PERP': 0.85, 'TAO-PERP': 0.75, 'INJ-PERP': 0.7, 'SOL-PERP': 0.65, 'ETH-PERP': 0.6 },
      'TAO-PERP': { 'SUI-PERP': 0.75, 'APT-PERP': 0.75, 'RENDER-PERP': 0.7, 'IO-PERP': 0.7 }, // AI-adjacent
      'INJ-PERP': { 'SUI-PERP': 0.7, 'APT-PERP': 0.7, 'SOL-PERP': 0.6 },
      
      // DeFi / L2s (high inter-correlation ~0.75)
      'ARB-PERP': { 'OP-PERP': 0.85, 'POL-PERP': 0.75, 'ETH-PERP': 0.7, 'LINK-PERP': 0.65 },
      'OP-PERP': { 'ARB-PERP': 0.85, 'POL-PERP': 0.75, 'ETH-PERP': 0.7, 'LINK-PERP': 0.65 },
      'POL-PERP': { 'ARB-PERP': 0.75, 'OP-PERP': 0.75, 'ETH-PERP': 0.7, 'LINK-PERP': 0.6 },
      'LINK-PERP': { 'ARB-PERP': 0.65, 'OP-PERP': 0.65, 'POL-PERP': 0.6, 'ETH-PERP': 0.65 },
      
      // AI / Compute (high inter-correlation ~0.8)
      'RENDER-PERP': { 'IO-PERP': 0.8, 'TAO-PERP': 0.7, 'HNT-PERP': 0.6 },
      'IO-PERP': { 'RENDER-PERP': 0.8, 'TAO-PERP': 0.7, 'HNT-PERP': 0.55 },
      
      // Infrastructure / IoT
      'HNT-PERP': { 'RENDER-PERP': 0.6, 'IO-PERP': 0.55, 'LINK-PERP': 0.5 },
      
      // Meme / High-Beta (correlated with BTC sentiment)
      'DOGE-PERP': { 'BTC-PERP': 0.6, 'SOL-PERP': 0.55, 'XRP-PERP': 0.5 },
      
      // Legacy / Large Cap
      'XRP-PERP': { 'BTC-PERP': 0.55, 'ETH-PERP': 0.5, 'DOGE-PERP': 0.5 },
      'BNB-PERP': { 'BTC-PERP': 0.65, 'ETH-PERP': 0.6, 'SOL-PERP': 0.55 },
      
      // Solana Ecosystem
      'RAY-PERP': { 'SOL-PERP': 0.8, 'JUP-PERP': 0.75, 'BONK-PERP': 0.65 },
      'JUP-PERP': { 'SOL-PERP': 0.8, 'RAY-PERP': 0.75, 'BONK-PERP': 0.6 },
      'BONK-PERP': { 'SOL-PERP': 0.7, 'RAY-PERP': 0.65, 'JUP-PERP': 0.6, 'DOGE-PERP': 0.55 },
    };
    
    // Initialize correlation matrix for all configured markets
    for (const market of this.markets) {
      defaultCorrelationMatrix[market] = {};
      for (const otherMarket of this.markets) {
        if (market !== otherMarket) {
          // Use provided correlation or default from known pairs
          defaultCorrelationMatrix[market][otherMarket] = 
            config.correlationMatrix?.[market]?.[otherMarket] ||
            defaultCorrelations[market]?.[otherMarket] ||
            defaultCorrelations[otherMarket]?.[market] ||
            0.5; // Default moderate correlation if unknown
        }
      }
    }
    
    // Strategy-aware scoring weights
    this.scoringWeights = {
      momentum: this._extractMomentumWeights(config, numEnv),
      scalping: this._extractScalpingWeights(config, numEnv),
      'rsi-reversion': this._extractReversionWeights(config, numEnv),
      'rsi-reversion-alt': this._extractReversionWeights(config, numEnv), // Same weights as rsi-reversion
      'btc-breakout': this._extractBreakoutWeights(config, numEnv),
      'ichimoku-cloud': this._extractIchimokuWeights(config, numEnv),
    };
    
    this.config = {
      // Diversification settings
      maxPositionsPerMarket: config.maxPositionsPerMarket || 3, // Max positions in single market
      diversificationBonus: config.diversificationBonus || 1.1, // 10% bonus for diversification
      
      // Correlation settings (dynamically built for configured markets)
      correlationMatrix: config.correlationMatrix || defaultCorrelationMatrix,
      maxCorrelatedExposure: config.maxCorrelatedExposure || 0.6, // Max 60% in correlated markets
      
      // Performance weighting (momentum defaults, kept for backward compatibility)
      performanceWeight: config.performanceWeight ?? numEnv('ALLOCATOR_PERFORMANCE_WEIGHT', 0.35),
      confidenceWeight: config.confidenceWeight ?? numEnv('ALLOCATOR_CONFIDENCE_WEIGHT', 0.20),
      riskAdjustedWeight: config.riskAdjustedWeight ?? numEnv('ALLOCATOR_RISKADJUSTED_WEIGHT', 0.25),
      volatilityWeight: config.volatilityWeight ?? numEnv('ALLOCATOR_VOLATILITY_WEIGHT', 0.20),
      
      // Minimum thresholds
      minConfidence: config.minConfidence ?? 0.00, // Minimum normalized confidence (0-1 scale)
      minScore: config.minScore ?? 0.00, // Minimum overall score to trade

      // RSI-Reversion specific thresholds (allow looser/bypass for counter-trend signals)
      reversionMinConfidence: numEnv('REVERSION_ALLOCATOR_MIN_CONFIDENCE', 0.00),
      reversionMinScore: numEnv('REVERSION_ALLOCATOR_MIN_SCORE', 0.00),
      reversionBypassThreshold: process.env.REVERSION_ALLOCATOR_BYPASS_THRESHOLD === 'true',

      // Ichimoku-specific thresholds (defaults to global thresholds unless explicitly tightened)
      ichimokuMinConfidence:
        config.ichimokuMinConfidence ??
        numEnv('ICHIMOKU_ALLOCATOR_MIN_CONFIDENCE', config.minConfidence ?? 0.00),
      ichimokuMinScore:
        config.ichimokuMinScore ??
        numEnv('ICHIMOKU_ALLOCATOR_MIN_SCORE', config.minScore ?? 0.00),

      // Cooldown settings per market after loss/win
      cooldownLossPenalty: config.cooldownLossPenalty ?? -0.10, // -10% score penalty after loss
      cooldownWinBonus: config.cooldownWinBonus ?? 0.10, // +10% score bonus after win
      cooldownWindowMs: config.cooldownWindowMs ?? 15 * 60 * 1000, // 15 minutes
      exploreProbability: config.exploreProbability ?? 0.08, // 8% ε-greedy exploration
    };

    // Ichimoku allocator config: bar-based breakout signal quality.
    // Uses signal.indicators first to avoid relying on tick-level enrichment.
    this.ichimokuAlloc = {
      // Gates (defaults: conservative but not over-filtering)
      enableAdxGate: boolEnv('ICHIMOKU_ALLOCATOR_ENABLE_ADX_GATE', true),
      enableLateEntryVeto: boolEnv('ICHIMOKU_ALLOCATOR_ENABLE_LATE_ENTRY_VETO', true),
      enableCloudThicknessVeto: boolEnv('ICHIMOKU_ALLOCATOR_ENABLE_CLOUD_THICKNESS_VETO', false),
      enableHtfBiasGate: boolEnv('ICHIMOKU_ALLOCATOR_ENABLE_HTF_BIAS_GATE', false),
      enableVolumeBonus: boolEnv('ICHIMOKU_ALLOCATOR_ENABLE_VOLUME_BONUS', false),

      // Thresholds
      adxMin: numEnv('ICHIMOKU_ALLOCATOR_ADX_MIN', 18),
      adxSaturation: numEnv('ICHIMOKU_ALLOCATOR_ADX_SAT', 40),
      maxKijunDistAtr: numEnv('ICHIMOKU_ALLOCATOR_MAX_KIJUN_DIST_ATR', 2.0),
      maxCloudThicknessAtr: numEnv('ICHIMOKU_ALLOCATOR_MAX_CLOUD_THICKNESS_ATR', 3.5),

      // Breakout follow-through "bump" shape (ATR units)
      breakoutLeftAtr: numEnv('ICHIMOKU_ALLOCATOR_BREAKOUT_LEFT_ATR', 0.05),
      breakoutPeakAtr: numEnv('ICHIMOKU_ALLOCATOR_BREAKOUT_PEAK_ATR', 0.50),
      breakoutRightAtr: numEnv('ICHIMOKU_ALLOCATOR_BREAKOUT_RIGHT_ATR', 1.50),

      // Volatility regime (ATR% on 15m)
      atrPctMin: numEnv('ICHIMOKU_ALLOCATOR_ATR_PCT_MIN', 0.3),
      atrPctSweetMin: numEnv('ICHIMOKU_ALLOCATOR_ATR_PCT_SWEET_MIN', 0.8),
      atrPctSweetMax: numEnv('ICHIMOKU_ALLOCATOR_ATR_PCT_SWEET_MAX', 6.0),
      atrPctMax: numEnv('ICHIMOKU_ALLOCATOR_ATR_PCT_MAX', 10.0),

      // Component weights (must sum ~1; keep simple)
      wTrend: numEnv('ICHIMOKU_ALLOCATOR_W_TREND', 0.35),
      wBreakout: numEnv('ICHIMOKU_ALLOCATOR_W_BREAKOUT', 0.30),
      wStructure: numEnv('ICHIMOKU_ALLOCATOR_W_STRUCTURE', 0.20),
      wVol: numEnv('ICHIMOKU_ALLOCATOR_W_VOL', 0.15),

      // Small bonuses/penalties
      volumeBonus: numEnv('ICHIMOKU_ALLOCATOR_VOLUME_BONUS', 0.05),
      htfBiasBonus: numEnv('ICHIMOKU_ALLOCATOR_HTF_BIAS_BONUS', 0.10),
      htfBiasPenalty: numEnv('ICHIMOKU_ALLOCATOR_HTF_BIAS_PENALTY', 0.20),
    };
    
    // ------------------------------------------------------------
    // Market Tiers - prioritize historically profitable markets
    // ------------------------------------------------------------
    // Tier A: Top performers (1.2x score multiplier)
    // Tier B: Solid performers (1.0x - no adjustment)
    // Tier C: Lower edge (0.8x score multiplier)
    // Tier D: Untested/risky (0.6x score multiplier)
    this.marketTiers = this._buildMarketTiers(config, numEnv);
    
    // ------------------------------------------------------------
    // Historical Performance Boost - per-market score multipliers
    // ------------------------------------------------------------
    // Based on backtest results: markets with higher edge get boosted
    // Format: { SYMBOL: multiplier } where 1.0 = neutral
    this.historicalPerformanceBoost = this._buildHistoricalPerformanceBoost(config, numEnv);

    // ------------------------------------------------------------
    // Allocator-driven risk recommendation (post-selection)
    // ------------------------------------------------------------
    // This does NOT affect scoring/selection. It only maps an already-selected
    // opportunity into execution parameters (size/leverage/stops).
    //
    // Defaults are conservative multipliers around "base" values supplied by the caller.
    // Caller can optionally disable this entirely (or force neutral behavior) in backtests.
    this.riskRecommendation = {
      enabled: config.riskRecommendation?.enabled ?? boolEnv('ALLOCATOR_RISK_ENABLED', false),
      neutral: config.riskRecommendation?.neutral ?? boolEnv('ALLOCATOR_RISK_NEUTRAL', false),

      // Quality: blend of allocator score and signal confidence, then apply gamma curve.
      // scoreNormalized uses a soft cap of 2.0 (allocator already caps scores to 2.0).
      quality: {
        scoreWeight: config.riskRecommendation?.quality?.scoreWeight ?? numEnv('ALLOCATOR_RISK_QUALITY_SCORE_WEIGHT', 1.0),
        confidenceWeight: config.riskRecommendation?.quality?.confidenceWeight ?? numEnv('ALLOCATOR_RISK_QUALITY_CONF_WEIGHT', 0.0),
        gamma: config.riskRecommendation?.quality?.gamma ?? numEnv('ALLOCATOR_RISK_QUALITY_GAMMA', 1.0),
      },

      // Size%: multiplier applied to baseSizePct (caller-provided).
      // Example: base=80%, mult=0.8 => 64%.
      size: {
        multMin: config.riskRecommendation?.size?.multMin ?? numEnv('ALLOCATOR_RISK_SIZE_MULT_MIN', 0.7),
        multMax: config.riskRecommendation?.size?.multMax ?? numEnv('ALLOCATOR_RISK_SIZE_MULT_MAX', 1.1),
        pctMin: config.riskRecommendation?.size?.pctMin ?? numEnv('ALLOCATOR_RISK_SIZE_PCT_MIN', 1.0),
        pctMax: config.riskRecommendation?.size?.pctMax ?? numEnv('ALLOCATOR_RISK_SIZE_PCT_MAX', 100.0),
      },

      // Leverage: multiplier applied to baseLeverage (caller-provided).
      leverage: {
        multMin: config.riskRecommendation?.leverage?.multMin ?? numEnv('ALLOCATOR_RISK_LEVERAGE_MULT_MIN', 0.7),
        multMax: config.riskRecommendation?.leverage?.multMax ?? numEnv('ALLOCATOR_RISK_LEVERAGE_MULT_MAX', 1.1),
        min: config.riskRecommendation?.leverage?.min ?? numEnv('ALLOCATOR_RISK_LEVERAGE_MIN', 1.0),
        max: config.riskRecommendation?.leverage?.max ?? numEnv('ALLOCATOR_RISK_LEVERAGE_MAX', 20.0),
        // Optional rounding step; e.g. 1.0 => integer leverage
        roundStep: config.riskRecommendation?.leverage?.roundStep ?? numEnv('ALLOCATOR_RISK_LEVERAGE_ROUND_STEP', 1.0),
      },
      // Optional per-market leverage multiplier overrides.
      // Use-case: keep BTC conservative (or allow deleveraging) while scaling ETH/SOL up.
      leverageByMarket: (() => {
        const fromConfig = config.riskRecommendation?.leverageByMarket;
        if (fromConfig && typeof fromConfig === 'object') return fromConfig;
        // Build from env if any are provided; otherwise return null
        const mk = (sym) => ({
          multMin: symEnvNum('ALLOCATOR_RISK_LEVERAGE_MULT_MIN', sym, NaN),
          multMax: symEnvNum('ALLOCATOR_RISK_LEVERAGE_MULT_MAX', sym, NaN),
        });
        const btc = mk('BTC');
        const eth = mk('ETH');
        const sol = mk('SOL');
        const hasAny =
          Number.isFinite(btc.multMin) || Number.isFinite(btc.multMax) ||
          Number.isFinite(eth.multMin) || Number.isFinite(eth.multMax) ||
          Number.isFinite(sol.multMin) || Number.isFinite(sol.multMax);
        if (!hasAny) return null;
        const clean = (o) => ({
          ...(Number.isFinite(o.multMin) ? { multMin: o.multMin } : {}),
          ...(Number.isFinite(o.multMax) ? { multMax: o.multMax } : {}),
        });
        return {
          BTC: clean(btc),
          ETH: clean(eth),
          SOL: clean(sol),
        };
      })(),

      // Hard stop percent (collateral %): multiplier applied to baseHardStopPercent.
      stopPercent: {
        multMin: config.riskRecommendation?.stopPercent?.multMin ?? numEnv('ALLOCATOR_RISK_STOP_PCT_MULT_MIN', 0.6),
        multMax: config.riskRecommendation?.stopPercent?.multMax ?? numEnv('ALLOCATOR_RISK_STOP_PCT_MULT_MAX', 1.2),
        min: config.riskRecommendation?.stopPercent?.min ?? numEnv('ALLOCATOR_RISK_STOP_PCT_MIN', 0.0),
        max: config.riskRecommendation?.stopPercent?.max ?? numEnv('ALLOCATOR_RISK_STOP_PCT_MAX', 100.0),
      },

      // Hard stop ATR multiplier: multiplier applied to baseHardStopAtrMult.
      stopAtr: {
        multMin: config.riskRecommendation?.stopAtr?.multMin ?? numEnv('ALLOCATOR_RISK_STOP_ATR_MULT_MIN', 0.6),
        multMax: config.riskRecommendation?.stopAtr?.multMax ?? numEnv('ALLOCATOR_RISK_STOP_ATR_MULT_MAX', 1.2),
        min: config.riskRecommendation?.stopAtr?.min ?? numEnv('ALLOCATOR_RISK_STOP_ATR_MIN', 0.0),
        max: config.riskRecommendation?.stopAtr?.max ?? numEnv('ALLOCATOR_RISK_STOP_ATR_MAX', 50.0),
      },

      // Ichimoku-specific: drive risk from breakout quality + confidence/score.
      // Rank tilt is mean-preserving across the selected batch (e.g., MAX_POSITIONS=2).
      ichimoku: {
        enabled: boolEnv(
          'ICHIMOKU_ALLOCATOR_RISK_ENABLED',
          config.riskRecommendation?.enabled ?? boolEnv('ALLOCATOR_RISK_ENABLED', false)
        ),
        wScore: numEnv('ICHIMOKU_ALLOCATOR_RISK_W_SCORE', 0.35),
        wConf: numEnv('ICHIMOKU_ALLOCATOR_RISK_W_CONF', 0.15),
        wIchi: numEnv('ICHIMOKU_ALLOCATOR_RISK_W_ICHI', 0.50),
        gamma: numEnv('ICHIMOKU_ALLOCATOR_RISK_GAMMA', 1.0),
        sizeMultMin: numEnv('ICHIMOKU_ALLOCATOR_RISK_SIZE_MULT_MIN', 0.7),
        sizeMultMax: numEnv('ICHIMOKU_ALLOCATOR_RISK_SIZE_MULT_MAX', 1.1),
        levMultMin: numEnv('ICHIMOKU_ALLOCATOR_RISK_LEV_MULT_MIN', 0.9),
        levMultMax: numEnv('ICHIMOKU_ALLOCATOR_RISK_LEV_MULT_MAX', 1.1),
        // Rank allocation across the selected batch.
        // rankTilt=0 => no relative adjustment; 1 => full proportional allocation.
        rankTilt: numEnv('ICHIMOKU_ALLOCATOR_RISK_RANK_TILT', 0.5),
        rankPower: numEnv('ICHIMOKU_ALLOCATOR_RISK_RANK_POWER', 2.0),
        // Hard minimum/maximum multiplier applied on top of base quality multipliers.
        rankMinMult: numEnv('ICHIMOKU_ALLOCATOR_RISK_RANK_MIN_MULT', 0.7),
        rankMaxMult: numEnv('ICHIMOKU_ALLOCATOR_RISK_RANK_MAX_MULT', 1.3),
      },
    };
    
    // Track recent trade outcomes per market (map of market+side to outcome+timestamp)
    this.recentTradeOutcomes = new Map();
    
    // Dynamic correlation tracking: rolling returns per market
    this.rollingReturns = new Map(); // Map<market, Array<{timestamp, return}>>
    this.dynamicCorrelations = new Map(); // Cache of calculated correlations
    
    // Only log allocator initialization when DEBUG_MARKET_ALLOCATOR is enabled
    if (process.env.DEBUG_ALLOCATOR_RISK === 'true' || process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
      console.log('[MarketAllocator] Initialized with strategy-aware scoring weights');
      console.log('[MarketAllocator] Momentum weights:', this.scoringWeights.momentum);
      console.log('[MarketAllocator] Scalping weights:', this.scoringWeights.scalping);
      console.log('[MarketAllocator] RSI-Reversion weights:', this.scoringWeights['rsi-reversion']);
      console.log('[MarketAllocator] BTC-Breakout weights:', this.scoringWeights['btc-breakout']);
      console.log('[MarketAllocator] Market tiers:', this.marketTiers);
      console.log('[MarketAllocator] Historical performance boost:', this.historicalPerformanceBoost);
      console.log('[MarketAllocator] Risk recommendation config:', {
        enabled: this.riskRecommendation.enabled,
        neutral: this.riskRecommendation.neutral,
        sizeMultRange: `${this.riskRecommendation.size.multMin}-${this.riskRecommendation.size.multMax}`,
        levMultRange: `${this.riskRecommendation.leverage.multMin}-${this.riskRecommendation.leverage.multMax}`,
        qualityGamma: this.riskRecommendation.quality.gamma,
      });
    }
  }

  // ------------------------------------------------------------
  // Risk recommendation helpers (post-selection)
  // ------------------------------------------------------------
  _clamp(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.min(Math.max(v, min), max);
  }

  _lerp(a, b, t) {
    return a + (b - a) * t;
  }

  _normalizeQuality({ score, confidence }) {
    const rw = this.riskRecommendation?.quality?.scoreWeight ?? 1.0;
    const cw = this.riskRecommendation?.quality?.confidenceWeight ?? 0.0;
    const gamma = this.riskRecommendation?.quality?.gamma ?? 1.0;

    // score is capped at 2.0 elsewhere, normalize to [0,1]
    const s = Number.isFinite(score) ? this._clamp(score / 2.0, 0, 1) : 0;

    // confidence is typically in [-3, +3], normalize abs to [0,1]
    const c = Number.isFinite(confidence) ? this._clamp(Math.abs(confidence) / 3.0, 0, 1) : 0;

    const denom = Math.max(1e-9, rw + cw);
    const mixed = this._clamp((s * rw + c * cw) / denom, 0, 1);
    const g = Number.isFinite(gamma) && gamma > 0 ? gamma : 1.0;
    return this._clamp(Math.pow(mixed, g), 0, 1);
  }

  _ichimokuVolScoreFromAtrPct(atrPct) {
    const cfg = this.ichimokuAlloc;
    const v = Number(atrPct);
    if (!Number.isFinite(v) || v <= 0) return 0.5;
    const min = Number(cfg?.atrPctMin);
    const sweetMin = Number(cfg?.atrPctSweetMin);
    const sweetMax = Number(cfg?.atrPctSweetMax);
    const max = Number(cfg?.atrPctMax);
    if (!Number.isFinite(min) || !Number.isFinite(sweetMin) || !Number.isFinite(sweetMax) || !Number.isFinite(max))
      return 0.5;
    if (v <= min || v >= max) return 0;
    if (v >= sweetMin && v <= sweetMax) return 1;
    if (v < sweetMin) return this._clamp01((v - min) / Math.max(1e-9, sweetMin - min));
    // v > sweetMax
    return this._clamp01((max - v) / Math.max(1e-9, max - sweetMax));
  }

  _ichimokuQuality01FromSignal(signal, priceData) {
    const ichi = this._ichimokuInputs(signal, priceData);
    const cfg = this.ichimokuAlloc;
    const side = String(signal?.side || '').toLowerCase();

    const adx = ichi?.adx;
    const thickness = ichi?.cloudThicknessAtr;
    const breakoutDistAtr = ichi?.breakoutDistAtr;
    const kijunDistAtr = ichi?.kijunDistAtr;

    const trendScore = Number.isFinite(adx)
      ? this._clamp01((adx - cfg.adxMin) / Math.max(1e-9, cfg.adxSaturation - cfg.adxMin))
      : 0;
    const breakoutScore = this._bump(breakoutDistAtr, cfg.breakoutLeftAtr, cfg.breakoutPeakAtr, cfg.breakoutRightAtr);
    const structureScore = Number.isFinite(thickness)
      ? this._clamp01(1.0 - Math.max(0, thickness - 1.0) / Math.max(1e-9, cfg.maxCloudThicknessAtr - 1.0))
      : 0.5;
    const volScore = this._ichimokuVolScoreFromAtrPct(ichi?.atrPct);

    // Soft late-entry penalty (even if not vetoed)
    const latePenalty = Number.isFinite(kijunDistAtr) && Number.isFinite(cfg.maxKijunDistAtr) && cfg.maxKijunDistAtr > 0
      ? this._clamp01(1.0 - Math.max(0, kijunDistAtr - 0.5) / cfg.maxKijunDistAtr)
      : 1.0;

    const wSum = (cfg.wTrend + cfg.wBreakout + cfg.wStructure + cfg.wVol) || 1;
    let q =
      (trendScore * cfg.wTrend +
        breakoutScore * cfg.wBreakout +
        structureScore * cfg.wStructure +
        volScore * cfg.wVol) / wSum;
    q *= latePenalty;

    if (cfg.enableVolumeBonus) {
      const ratio = Number(ichi?.volumeRatio);
      const thr = Number(ichi?.volumeSpikeThreshold);
      const denom = Number.isFinite(thr) && thr > 1 ? thr - 1 : 0.5;
      const vScore = Number.isFinite(ratio) ? this._clamp01((ratio - 1) / Math.max(1e-9, denom)) : (ichi?.volumeSpike ? 1 : 0);
      q = Math.min(1, q + cfg.volumeBonus * vScore);
    }

    if (typeof ichi?.htfBias === 'string') {
      if ((side === 'long' && ichi.htfBias === 'bullish') || (side === 'short' && ichi.htfBias === 'bearish')) {
        q = Math.min(1, q + cfg.htfBiasBonus);
      }
      if ((side === 'long' && ichi.htfBias === 'bearish') || (side === 'short' && ichi.htfBias === 'bullish')) {
        q = Math.max(0, q - cfg.htfBiasPenalty);
      }
    }

    return this._clamp01(q);
  }

  _ichimokuRiskQuality01({ score, confidence, signal, priceData }) {
    const cfg = this.riskRecommendation?.ichimoku || {};
    const s01 = Number.isFinite(score) ? this._clamp(Number(score) / 2.0, 0, 1) : 0;
    const c01 = Number.isFinite(confidence) ? this._clamp(Math.abs(Number(confidence)) / 3.0, 0, 1) : 0;
    const ichi01 = this._ichimokuQuality01FromSignal(signal, priceData);

    const wScore = Number(cfg.wScore);
    const wConf = Number(cfg.wConf);
    const wIchi = Number(cfg.wIchi);
    const denom = Math.max(1e-9, (Number.isFinite(wScore) ? wScore : 0) + (Number.isFinite(wConf) ? wConf : 0) + (Number.isFinite(wIchi) ? wIchi : 0));
    const mixed = this._clamp((s01 * (Number.isFinite(wScore) ? wScore : 0) + c01 * (Number.isFinite(wConf) ? wConf : 0) + ichi01 * (Number.isFinite(wIchi) ? wIchi : 0)) / denom, 0, 1);
    const gamma = Number.isFinite(cfg.gamma) && cfg.gamma > 0 ? cfg.gamma : 1.0;
    return this._clamp(Math.pow(mixed, gamma), 0, 1);
  }

  /**
   * Strategy-aware risk multipliers (no base values needed).
   * Returned multipliers are intended to be applied by the caller to its own base
   * size% and leverage, and (for Ichimoku) to scale hard-stop percent proportionally
   * with leverage to keep a constant price-space stop distance.
   */
  recommendRiskMultipliers({ market, signal, priceData, score, strategyType }) {
    const rawConf = Number(signal?.confidence);
    const isIchi = this.isIchimokuStrategy(strategyType);

    // Fail-safe neutral defaults
    const neutralOut = {
      market,
      side: String(signal?.side || '').toLowerCase(),
      strategyType,
      quality: 0,
      sizeMult: 1.0,
      levMult: 1.0,
      rankMult: 1.0,
      finalSizeMult: 1.0,
      finalLevMult: 1.0,
    };

    const cfg = this.riskRecommendation;
    if (cfg?.neutral) return neutralOut;
    // Allow Ichimoku risk to be enabled independently of the global switch.
    if (!cfg?.enabled && !(isIchi && cfg?.ichimoku?.enabled)) return neutralOut;

    if (!isIchi) {
      // Keep generic risk system unchanged for other strategies.
      const q = this._normalizeQuality({ score, confidence: rawConf });
      const sizeMult = this._lerp(cfg.size.multMin, cfg.size.multMax, q);
      const levMult = this._lerp(cfg.leverage.multMin, cfg.leverage.multMax, q);
      return {
        ...neutralOut,
        quality: q,
        sizeMult,
        levMult,
        finalSizeMult: sizeMult,
        finalLevMult: levMult,
      };
    }

    const ichiCfg = cfg.ichimoku || {};
    if (!ichiCfg.enabled) return neutralOut;

    const q = this._ichimokuRiskQuality01({ score, confidence: rawConf, signal, priceData });
    const sizeMult = this._lerp(ichiCfg.sizeMultMin, ichiCfg.sizeMultMax, q);
    const levMult = this._lerp(ichiCfg.levMultMin, ichiCfg.levMultMax, q);
    return {
      ...neutralOut,
      quality: q,
      sizeMult,
      levMult,
      finalSizeMult: sizeMult,
      finalLevMult: levMult,
    };
  }

  /**
   * Batch multipliers with mean-preserving rank tilt (used when MAX_POSITIONS>1).
   * The inferior opportunity gets de-risked (size/leverage) relative to the best.
   *
   * @param {Array<{market:string,signal:Object,priceData:Object,score:number,strategyType:string}>} opportunities
   * @returns {Map<string, {quality:number,sizeMult:number,levMult:number,rankMult:number,finalSizeMult:number,finalLevMult:number}>}
   */
  recommendRiskMultipliersBatch(opportunities) {
    const out = new Map();
    const list = Array.isArray(opportunities) ? opportunities : [];
    if (list.length === 0) return out;

    const cfg = this.riskRecommendation;
    const ichiEnabled = cfg?.ichimoku?.enabled === true;
    if (cfg?.neutral || (!cfg?.enabled && !ichiEnabled)) {
      for (const o of list) {
        const key = `${o.market}:${String(o.signal?.side || '').toLowerCase()}`;
        out.set(key, {
          quality: 0,
          sizeMult: 1,
          levMult: 1,
          rankMult: 1,
          finalSizeMult: 1,
          finalLevMult: 1,
        });
      }
      return out;
    }

    // First pass: per-opportunity base multipliers
    const computed = list.map((o) => {
      const rec = this.recommendRiskMultipliers(o);
      const key = `${o.market}:${String(o.signal?.side || '').toLowerCase()}`;
      return { key, market: o.market, side: rec.side, strategyType: o.strategyType, rec };
    });

    // Second pass: apply rank tilt within Ichimoku subset
    const ichiIdx = [];
    for (let i = 0; i < computed.length; i++) {
      if (this.isIchimokuStrategy(computed[i].strategyType)) ichiIdx.push(i);
    }

    const ichiCfg = cfg.ichimoku || {};
    const tilt = Number(ichiCfg.rankTilt);
    const power = Number(ichiCfg.rankPower);
    const rankMin = Number(ichiCfg.rankMinMult);
    const rankMax = Number(ichiCfg.rankMaxMult);

    let rankMultByIndex = new Map();
    if (ichiIdx.length >= 2 && Number.isFinite(tilt) && tilt > 0) {
      const p = Number.isFinite(power) && power > 0 ? power : 1.0;
      const weights = ichiIdx.map((i) => {
        const q = Number(computed[i].rec?.quality);
        return Number.isFinite(q) && q > 0 ? Math.pow(q, p) : 0;
      });
      const sumW = weights.reduce((a, b) => a + b, 0);
      for (let k = 0; k < ichiIdx.length; k++) {
        const i = ichiIdx[k];
        const share = sumW > 0 ? weights[k] / sumW : 1 / ichiIdx.length;
        const raw = ichiIdx.length * share; // mean=1
        let rm = 1 + tilt * (raw - 1);
        if (Number.isFinite(rankMin) || Number.isFinite(rankMax)) {
          rm = this._clamp(rm, Number.isFinite(rankMin) ? rankMin : rm, Number.isFinite(rankMax) ? rankMax : rm);
        }
        rankMultByIndex.set(i, rm);
      }
    }

    for (let i = 0; i < computed.length; i++) {
      const rec = computed[i].rec;
      const rm = rankMultByIndex.get(i) || 1.0;
      // Clamp final multipliers to keep the layer bounded and avoid accidental over-risking.
      const isIchi = this.isIchimokuStrategy(computed[i].strategyType);
      const finalSizeMult = isIchi
        ? this._clamp(rec.finalSizeMult * rm, ichiCfg.sizeMultMin * (ichiCfg.rankMinMult || 1), ichiCfg.sizeMultMax * (ichiCfg.rankMaxMult || 1))
        : rec.finalSizeMult;
      const finalLevMult = isIchi
        ? this._clamp(rec.finalLevMult * rm, ichiCfg.levMultMin * (ichiCfg.rankMinMult || 1), ichiCfg.levMultMax * (ichiCfg.rankMaxMult || 1))
        : rec.finalLevMult;

      out.set(computed[i].key, {
        quality: rec.quality,
        sizeMult: rec.sizeMult,
        levMult: rec.levMult,
        rankMult: rm,
        finalSizeMult,
        finalLevMult,
      });
    }

    return out;
  }

  /**
   * Recommend risk parameters for an already-selected opportunity.
   * This does NOT affect scoring/selection.
   *
   * Caller should provide "base" values (from existing config/per-market overrides)
   * so that multiplier ranges can preserve parity when set to 1.0.
   *
   * @param {object} args
   * @param {string} args.market
   * @param {object} args.signal
   * @param {object} args.priceData
   * @param {number} args.score - allocator score (0..2)
   * @param {string} args.strategyType
   * @param {object} args.base - base risk values from caller
   * @param {number} args.base.sizePct - base position size percent (0..100)
   * @param {number} args.base.leverage - base leverage (>=1)
   * @param {number} args.base.hardStopPercent - base hard stop percent (collateral %)
   * @param {number} args.base.hardStopAtrMult - base hard stop ATR multiple
   * @returns {{quality:number,sizePct:number,leverage:number,hardStopPercent:number,hardStopAtrMult:number}}
   */
  recommendRisk({ market, signal, priceData, score, strategyType, base = {} }) {
    const cfg = this.riskRecommendation;
    const rawConf = Number(signal?.confidence);
    const isIchi = this.isIchimokuStrategy(strategyType);
    const q = isIchi && cfg?.ichimoku?.enabled
      ? this._ichimokuRiskQuality01({ score, confidence: rawConf, signal, priceData })
      : this._normalizeQuality({ score, confidence: rawConf });

    // Neutral mode: always return base values (parity/debug)
    if (cfg?.neutral || (!cfg?.enabled && !(isIchi && cfg?.ichimoku?.enabled))) {
      return {
        quality: q,
        sizePct: Number.isFinite(base.sizePct) ? base.sizePct : 0,
        leverage: Number.isFinite(base.leverage) ? base.leverage : 1,
        hardStopPercent: Number.isFinite(base.hardStopPercent) ? base.hardStopPercent : 0,
        hardStopAtrMult: Number.isFinite(base.hardStopAtrMult) ? base.hardStopAtrMult : 0,
      };
    }

    const marketSym = String(market || '').toUpperCase().split('-')[0] || null;

    // Map quality -> multipliers
    const sizeMult = isIchi && cfg?.ichimoku?.enabled
      ? this._lerp(cfg.ichimoku.sizeMultMin, cfg.ichimoku.sizeMultMax, q)
      : this._lerp(cfg.size.multMin, cfg.size.multMax, q);
    // Per-market leverage multiplier overrides (if configured)
    const levCfg = (cfg.leverageByMarket && marketSym && cfg.leverageByMarket[marketSym])
      ? { ...cfg.leverage, ...cfg.leverageByMarket[marketSym] }
      : cfg.leverage;
    const levMult = isIchi && cfg?.ichimoku?.enabled
      ? this._lerp(cfg.ichimoku.levMultMin, cfg.ichimoku.levMultMax, q)
      : this._lerp(levCfg.multMin, levCfg.multMax, q);
    const stopPctMult = this._lerp(cfg.stopPercent.multMin, cfg.stopPercent.multMax, q);
    const stopAtrMult = this._lerp(cfg.stopAtr.multMin, cfg.stopAtr.multMax, q);

    // Apply multipliers around caller-provided bases
    const baseSizePct = Number.isFinite(base.sizePct) ? base.sizePct : 0;
    const baseLev = Number.isFinite(base.leverage) ? base.leverage : 1;
    const baseStopPct = Number.isFinite(base.hardStopPercent) ? base.hardStopPercent : 0;
    const baseStopAtr = Number.isFinite(base.hardStopAtrMult) ? base.hardStopAtrMult : 0;

    let sizePct = baseSizePct * sizeMult;
    sizePct = this._clamp(sizePct, cfg.size.pctMin, cfg.size.pctMax);

    let leverage = baseLev * levMult;
    leverage = this._clamp(leverage, cfg.leverage.min, cfg.leverage.max);
    const step = Number.isFinite(cfg.leverage.roundStep) && cfg.leverage.roundStep > 0 ? cfg.leverage.roundStep : 0;
    if (step > 0) {
      leverage = Math.round(leverage / step) * step;
      leverage = this._clamp(leverage, cfg.leverage.min, cfg.leverage.max);
    }

    let hardStopPercent;
    if (isIchi) {
      // Ichimoku: keep constant price-space stop distance when leverage changes.
      // baseStopPct is collateral PnL%; convert to price % by dividing by leverage.
      hardStopPercent = baseStopPct * (leverage / Math.max(1e-9, baseLev));
      hardStopPercent = this._clamp(hardStopPercent, cfg.stopPercent.min, cfg.stopPercent.max);
    } else {
      hardStopPercent = baseStopPct * stopPctMult;
      hardStopPercent = this._clamp(hardStopPercent, cfg.stopPercent.min, cfg.stopPercent.max);
    }

    let hardStopAtrMult = baseStopAtr * stopAtrMult;
    hardStopAtrMult = this._clamp(hardStopAtrMult, cfg.stopAtr.min, cfg.stopAtr.max);

    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true' || process.env.DEBUG_ALLOCATOR_RISK === 'true') {
      console.log('[ALLOCATOR] recommendRisk:', {
        market,
        strategyType,
        score,
        confidence: rawConf,
        quality: q,
        base,
        out: { sizePct, leverage, hardStopPercent, hardStopAtrMult },
      });
    }

    return { quality: q, sizePct, leverage, hardStopPercent, hardStopAtrMult };
  }
  
  /**
   * Extract momentum scoring weights
   * Momentum values: trend strength, volatility, longer-term patterns
   */
  _extractMomentumWeights(config, numEnv) {
    return {
      performanceWeight: config.performanceWeight ?? numEnv('ALLOCATOR_PERFORMANCE_WEIGHT', 0.35),
      confidenceWeight: config.confidenceWeight ?? numEnv('ALLOCATOR_CONFIDENCE_WEIGHT', 0.20),
      riskAdjustedWeight: config.riskAdjustedWeight ?? numEnv('ALLOCATOR_RISKADJUSTED_WEIGHT', 0.25),
      volatilityWeight: config.volatilityWeight ?? numEnv('ALLOCATOR_VOLATILITY_WEIGHT', 0.20),
    };
  }
  
  /**
   * Extract scalping scoring weights
   * Scalping values: liquidity, tight spreads, volume, fast execution
   */
  _extractScalpingWeights(config, numEnv) {
    return {
      // Scalping prioritizes confidence and performance over volatility
      performanceWeight: numEnv('SCALPING_ALLOCATOR_PERFORMANCE_WEIGHT', 0.30), // 30% (recent performance)
      confidenceWeight: numEnv('SCALPING_ALLOCATOR_CONFIDENCE_WEIGHT', 0.35), // 35% (signal quality)
      riskAdjustedWeight: numEnv('SCALPING_ALLOCATOR_RISKADJUSTED_WEIGHT', 0.20), // 20% (expected return)
      volatilityWeight: numEnv('SCALPING_ALLOCATOR_VOLATILITY_WEIGHT', 0.15), // 15% (lower priority - scalping thrives on volatility)
    };
  }
  
  /**
   * Extract RSI mean-reversion scoring weights
   * Reversion values: signal specificity (RSI extremes), moderate volatility, low trend strength
   * Key difference: High ADX (trend strength) is BAD for reversion - we want ranging markets
   */
  _extractReversionWeights(config, numEnv) {
    return {
      // Reversion prioritizes confidence highly - RSI extreme+recovery is a very specific condition
      performanceWeight: numEnv('REVERSION_ALLOCATOR_PERFORMANCE_WEIGHT', 0.25), // 25% - track record matters but less than momentum
      confidenceWeight: numEnv('REVERSION_ALLOCATOR_CONFIDENCE_WEIGHT', 0.35), // 35% - signal quality is paramount for counter-trend
      riskAdjustedWeight: numEnv('REVERSION_ALLOCATOR_RISKADJUSTED_WEIGHT', 0.15), // 15% - lower; ADX logic inverted for reversion
      volatilityWeight: numEnv('REVERSION_ALLOCATOR_VOLATILITY_WEIGHT', 0.25), // 25% - needs volatility for RSI swings but not trending
    };
  }

  _extractBreakoutWeights(config, numEnv) {
    return {
      performanceWeight: numEnv('BREAKOUT_ALLOCATOR_PERFORMANCE_WEIGHT', 0.30),
      confidenceWeight: numEnv('BREAKOUT_ALLOCATOR_CONFIDENCE_WEIGHT', 0.25),
      riskAdjustedWeight: numEnv('BREAKOUT_ALLOCATOR_RISKADJUSTED_WEIGHT', 0.25),
      volatilityWeight: numEnv('BREAKOUT_ALLOCATOR_VOLATILITY_WEIGHT', 0.20),
    };
  }

  /**
   * Extract Ichimoku breakout scoring weights
   * Breakouts value: trend strength + clean structures more than "low vol".
   */
  _extractIchimokuWeights(config, numEnv) {
    return {
      performanceWeight: numEnv('ICHIMOKU_ALLOCATOR_PERFORMANCE_WEIGHT', 0.25),
      confidenceWeight: numEnv('ICHIMOKU_ALLOCATOR_CONFIDENCE_WEIGHT', 0.25),
      riskAdjustedWeight: numEnv('ICHIMOKU_ALLOCATOR_RISKADJUSTED_WEIGHT', 0.30),
      volatilityWeight: numEnv('ICHIMOKU_ALLOCATOR_VOLATILITY_WEIGHT', 0.20),
    };
  }
  
  /**
   * Build market tiers from env configuration
   * Tiers determine score multipliers for prioritizing historically profitable markets
   * 
   * Tier A: 1.2x (top performers)
   * Tier B: 1.0x (solid performers - default)
   * Tier C: 0.8x (lower edge)
   * Tier D: 0.6x (untested/risky)
   * 
   * @param {Object} config - Config object
   * @param {Function} numEnv - Env number parser
   * @returns {Object} { tiers: {A: [...], B: [...], C: [...], D: [...]}, multipliers: {A: 1.2, ...} }
   */
  _buildMarketTiers(config, numEnv) {
    // Tier multipliers (configurable via env)
    const multipliers = {
      A: numEnv('ALLOCATOR_TIER_A_MULT', 1.25),  // Top performers get 25% boost
      B: numEnv('ALLOCATOR_TIER_B_MULT', 1.0),   // Solid performers - neutral
      C: numEnv('ALLOCATOR_TIER_C_MULT', 0.8),   // Lower edge - 20% penalty
      D: numEnv('ALLOCATOR_TIER_D_MULT', 0.6),   // Untested/risky - 40% penalty
    };
    
    // Parse tier assignments from env (comma-separated symbols)
    const parseList = (envKey) => {
      const val = process.env[envKey] || '';
      return val.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    };
    
    const tiers = {
      A: config.tierA || parseList('ALLOCATOR_TIER_A_MARKETS'),
      B: config.tierB || parseList('ALLOCATOR_TIER_B_MARKETS'),
      C: config.tierC || parseList('ALLOCATOR_TIER_C_MARKETS'),
      D: config.tierD || parseList('ALLOCATOR_TIER_D_MARKETS'),
    };
    
    // Default tier for markets not explicitly assigned
    const defaultTier = (process.env.ALLOCATOR_DEFAULT_TIER || 'B').toUpperCase();
    
    return { tiers, multipliers, defaultTier };
  }
  
  /**
   * Get tier multiplier for a market
   * @param {string} market - Market symbol (e.g., 'SOL-PERP' or 'SOL')
   * @returns {number} Score multiplier (0.6 - 1.25)
   */
  getTierMultiplier(market) {
    if (!this.marketTiers) return 1.0;
    
    // Normalize market symbol (remove -PERP suffix for matching)
    const sym = String(market).replace(/-PERP$/i, '').toUpperCase();
    const symPerp = `${sym}-PERP`;
    
    const { tiers, multipliers, defaultTier } = this.marketTiers;
    
    // Check each tier for the symbol
    for (const tier of ['A', 'B', 'C', 'D']) {
      const tierMarkets = tiers[tier] || [];
      if (tierMarkets.some(m => m === sym || m === symPerp || m === `${sym}_PERP`)) {
        return multipliers[tier];
      }
    }
    
    // Return default tier multiplier
    return multipliers[defaultTier] || 1.0;
  }
  
  /**
   * Build historical performance boost from env configuration
   * Per-market multipliers based on backtest PnL/edge
   * 
   * @param {Object} config - Config object  
   * @param {Function} numEnv - Env number parser
   * @returns {Object} { enabled: boolean, boosts: { SYMBOL: multiplier } }
   */
  _buildHistoricalPerformanceBoost(config, numEnv) {
    const enabled = process.env.ALLOCATOR_HISTORICAL_BOOST_ENABLED !== 'false';
    
    // Parse per-market boosts from env
    // Format: ALLOCATOR_HISTORICAL_BOOST_HNT=1.3 (HNT gets 30% boost)
    const boosts = {};
    
    // Check for per-market env vars
    const envPrefix = 'ALLOCATOR_HISTORICAL_BOOST_';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(envPrefix) && key !== 'ALLOCATOR_HISTORICAL_BOOST_ENABLED') {
        const symbol = key.slice(envPrefix.length).toUpperCase();
        const val = parseFloat(process.env[key]);
        if (Number.isFinite(val) && val > 0) {
          boosts[symbol] = val;
        }
      }
    }
    
    // Also accept config object boosts
    if (config.historicalBoosts && typeof config.historicalBoosts === 'object') {
      for (const [sym, mult] of Object.entries(config.historicalBoosts)) {
        if (Number.isFinite(mult) && mult > 0) {
          boosts[sym.toUpperCase()] = mult;
        }
      }
    }
    
    // Clamp boosts to reasonable range (0.5 - 2.0)
    for (const sym of Object.keys(boosts)) {
      boosts[sym] = Math.max(0.5, Math.min(2.0, boosts[sym]));
    }
    
    return { enabled, boosts };
  }
  
  /**
   * Get historical performance boost for a market
   * @param {string} market - Market symbol (e.g., 'SOL-PERP' or 'SOL')
   * @returns {number} Score multiplier (0.5 - 2.0), 1.0 = neutral
   */
  getHistoricalBoost(market) {
    if (!this.historicalPerformanceBoost?.enabled) return 1.0;
    
    // Normalize market symbol
    const sym = String(market).replace(/-PERP$/i, '').toUpperCase();
    const symPerp = `${sym}-PERP`;
    const symPerp2 = `${sym}_PERP`;
    
    const { boosts } = this.historicalPerformanceBoost;
    
    // Try different formats
    return boosts[sym] || boosts[symPerp] || boosts[symPerp2] || 1.0;
  }
  
  /**
   * Get combined tier + historical boost multiplier for a market
   * @param {string} market - Market symbol
   * @returns {{ tierMult: number, histBoost: number, combined: number }}
   */
  getMarketBoostMultiplier(market) {
    const tierMult = this.getTierMultiplier(market);
    const histBoost = this.getHistoricalBoost(market);
    
    // Combined: multiply both, but cap at 1.5x to avoid extreme dominance
    const combined = Math.min(tierMult * histBoost, 1.5);
    
    return { tierMult, histBoost, combined };
  }
  
  /**
   * Get scoring weights for a strategy type
   */
  getScoringWeights(strategyType) {
    return this.scoringWeights[strategyType] || this.scoringWeights.momentum;
  }
  
  /**
   * Get scoring weights for a market (uses strategy factory to determine strategy type)
   * @param {string} market - Market symbol
   * @param {string} explicitStrategyType - Optional explicit strategy type (for multi-strategy mode)
   */
  getScoringWeightsForMarket(market, explicitStrategyType = null) {
    // If explicit strategy type provided (multi-strategy mode), use it directly
    if (explicitStrategyType) {
      return this.getScoringWeights(explicitStrategyType);
    }
    
    if (!this.strategyFactory) {
      // Fallback to momentum weights if no factory
      return this.scoringWeights.momentum;
    }
    
    const strategyType = this.strategyFactory.getStrategyType(market);
    return this.getScoringWeights(strategyType);
  }
  
  /**
   * Check if a strategy type is a mean-reversion strategy
   * Used to adjust scoring logic (e.g., invert ADX treatment)
   */
  isReversionStrategy(strategyType) {
    return strategyType === 'rsi-reversion' || strategyType === 'rsi-reversion-alt' || strategyType === 'reversion';
  }

  isIchimokuStrategy(strategyType) {
    return strategyType === 'ichimoku-cloud';
  }

  _clamp01(x) {
    if (!Number.isFinite(x)) return 0;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return x;
  }

  // Simple triangular bump function: 0 at [left,right], 1 at peak.
  _bump(x, left, peak, right) {
    if (!Number.isFinite(x) || !Number.isFinite(left) || !Number.isFinite(peak) || !Number.isFinite(right)) return 0;
    if (right <= left) return 0;
    if (x <= left || x >= right) return 0;
    if (x === peak) return 1;
    if (x < peak) return this._clamp01((x - left) / Math.max(1e-9, peak - left));
    return this._clamp01((right - x) / Math.max(1e-9, right - peak));
  }

  // For Ichimoku, prefer bar-based strategy signal diagnostics to avoid relying on tick enrichment.
  _ichimokuInputs(signal, priceData) {
    const ind = signal?.indicators || {};
    const price = Number.isFinite(priceData?.price) ? priceData.price : (Number.isFinite(ind.price) ? ind.price : null);
    const atr = Number.isFinite(priceData?.atr) ? priceData.atr : (Number.isFinite(ind.atr) ? ind.atr : null);
    const adx = Number.isFinite(priceData?.adx) ? priceData.adx : (Number.isFinite(ind.adx) ? ind.adx : null);
    const atrPct =
      Number.isFinite(ind.atrPct) ? ind.atrPct : (atr && price && price > 0 ? (atr / price) * 100 : null);
    return {
      price,
      atr,
      adx,
      atrPct,
      breakoutDistAtr: Number.isFinite(ind.breakoutDistAtr) ? ind.breakoutDistAtr : null,
      kijunDistAtr: Number.isFinite(ind.kijunDistAtr) ? ind.kijunDistAtr : null,
      cloudThicknessAtr: Number.isFinite(ind.cloudThicknessAtr) ? ind.cloudThicknessAtr : null,
      htfBias: typeof ind?.htf?.bias === 'string' ? ind.htf.bias : null,
      volumeSpike: ind.volumeSpike === true,
      volumeRatio: Number.isFinite(ind.volumeRatio) ? ind.volumeRatio : null,
      volumeSpikeThreshold: Number.isFinite(ind.volumeSpikeThreshold) ? ind.volumeSpikeThreshold : null,
    };
  }
  
  /**
   * Set strategy factory (for runtime integration)
   */
  setStrategyFactory(factory) {
    this.strategyFactory = factory;
  }
  
  /**
   * Update rolling returns for a market
   * @param {string} market - Market symbol
   * @param {number} price - Current price
   * @param {number} timestamp - Current timestamp
   */
  updateReturns(market, price, timestamp) {
    if (!this.rollingReturns.has(market)) {
      this.rollingReturns.set(market, []);
    }
    
    const returns = this.rollingReturns.get(market);
    const windowMs = 30 * 60 * 1000; // 30 minutes
    
    // Calculate return
    if (returns.length > 0) {
      const lastPrice = returns[returns.length - 1].price;
      const returnPct = (price - lastPrice) / lastPrice;
      returns.push({ timestamp, return: returnPct, price });
    } else {
      returns.push({ timestamp, return: 0, price });
    }
    
    // Remove old data
    const cutoff = timestamp - windowMs;
    while (returns.length > 0 && returns[0].timestamp < cutoff) {
      returns.shift();
    }
  }
  
  /**
   * Calculate rolling Pearson correlation between two markets
   * @param {string} market1 - First market
   * @param {string} market2 - Second market
   * @returns {number} Correlation coefficient (-1 to 1)
   */
  _calculateDynamicCorrelation(market1, market2) {
    const returns1 = this.rollingReturns.get(market1) || [];
    const returns2 = this.rollingReturns.get(market2) || [];
    
    if (returns1.length < 3 || returns2.length < 3) {
      // Fall back to static correlation if insufficient data
      return this.config.correlationMatrix[market1]?.[market2] ?? 
             this.config.correlationMatrix[market2]?.[market1] ?? 
             0;
    }
    
    // Align timestamps and calculate covariance
    const aligned = [];
    const len = Math.min(returns1.length, returns2.length);
    
    // Take the most recent aligned returns
    for (let i = 0; i < len; i++) {
      const idx1 = returns1.length - len + i;
      const idx2 = returns2.length - len + i;
      
      // Only include if timestamps are close (within 5 minutes)
      const timeDiff = Math.abs(returns1[idx1].timestamp - returns2[idx2].timestamp);
      if (timeDiff < 5 * 60 * 1000) {
        aligned.push({
          r1: returns1[idx1].return,
          r2: returns2[idx2].return,
        });
      }
    }
    
    if (aligned.length < 3) {
      // Fall back to static correlation if insufficient data
      return this.config.correlationMatrix[market1]?.[market2] ?? 
             this.config.correlationMatrix[market2]?.[market1] ?? 
             0;
    }
    
    // Calculate Pearson correlation
    const mean1 = aligned.reduce((sum, v) => sum + v.r1, 0) / aligned.length;
    const mean2 = aligned.reduce((sum, v) => sum + v.r2, 0) / aligned.length;
    
    let covariance = 0;
    let var1 = 0;
    let var2 = 0;
    
    for (const v of aligned) {
      const d1 = v.r1 - mean1;
      const d2 = v.r2 - mean2;
      covariance += d1 * d2;
      var1 += d1 * d1;
      var2 += d2 * d2;
    }
    
    const std1 = Math.sqrt(var1 / aligned.length);
    const std2 = Math.sqrt(var2 / aligned.length);
    
    if (std1 === 0 || std2 === 0) {
      return 0;
    }
    
    return covariance / (aligned.length * std1 * std2);
  }
  
  /**
   * Get current correlation between two markets (with dynamic calculation)
   * @param {string} market1 - First market
   * @param {string} market2 - Second market
   * @returns {number} Correlation coefficient
   */
  getCorrelation(market1, market2) {
    const key = `${market1}:${market2}`;
    const reverseKey = `${market2}:${market1}`;
    
    // Check cache first
    if (this.dynamicCorrelations.has(key)) {
      return this.dynamicCorrelations.get(key);
    }
    
    // Calculate dynamic correlation
    const corr = this._calculateDynamicCorrelation(market1, market2);
    
    // Cache result
    this.dynamicCorrelations.set(key, corr);
    this.dynamicCorrelations.set(reverseKey, corr);
    
    return corr;
  }
  
  /**
   * Clear correlation cache (call periodically to refresh)
   */
  clearCorrelationCache() {
    this.dynamicCorrelations.clear();
  }

  /**
   * Get rejection diagnostics for a market+side combination
   * Returns null if no diagnostics available (signal wasn't evaluated or passed)
   * @param {string} market - Market symbol
   * @param {string} side - Trade side (long/short)
   * @returns {Object|null} Rejection diagnostics or null
   */
  getRejectionDiagnostics(market, side) {
    if (!this._rejectionDiagnostics) return null;
    const key = `${market}:${side}`;
    return this._rejectionDiagnostics.get(key) || null;
  }

  /**
   * Clear rejection diagnostics cache (call periodically to avoid memory leak)
   */
  clearRejectionDiagnostics() {
    if (this._rejectionDiagnostics) {
      this._rejectionDiagnostics.clear();
    }
  }

  /**
   * Calculate cooldown adjustment based on recent trade outcomes per market/side
   * @param {string} market - Market symbol
   * @param {string} side - Trade side (long/short)
   * @returns {number} Multiplier to apply to score
   */
  _calculateCooldownAdjustment(market, side) {
    const key = `${market}:${side.toLowerCase()}`;
    const outcome = this.recentTradeOutcomes.get(key);
    
    if (!outcome) {
      return 1.0; // No recent trades, no adjustment
    }
    
    const timeSinceTrade = Date.now() - outcome.timestamp;
    
    // Check if within cooldown window
    if (timeSinceTrade > this.config.cooldownWindowMs) {
      this.recentTradeOutcomes.delete(key); // Clean up stale entries
      return 1.0;
    }
    
    // Apply penalty/bonus based on outcome
    // Linear decay over window
    const timeDecay = 1 - (timeSinceTrade / this.config.cooldownWindowMs);
    
    if (outcome.win) {
      const bonus = this.config.cooldownWinBonus * timeDecay;
      return 1.0 + bonus;
    } else {
      const penalty = this.config.cooldownLossPenalty * timeDecay;
      return 1.0 + penalty; // penalty is negative, so this reduces score
    }
  }
  
  /**
   * Record a trade outcome for cooldown tracking
   * @param {string} market - Market symbol
   * @param {string} side - Trade side (long/short)
   * @param {boolean} won - Whether the trade was profitable
   */
  recordTradeOutcome(market, side, won) {
    const key = `${market}:${side.toLowerCase()}`;
    this.recentTradeOutcomes.set(key, {
      win: won,
      timestamp: Date.now(),
    });
  }

  /**
   * Calculate market score based on signal, price data, and historical performance
   * @param {string} market - Market symbol (e.g., 'SOL-PERP')
   * @param {Object} signal - Strategy signal with confidence, reason, indicators
   * @param {Object} priceData - Current price, markPrice, volume, indicators (ATR, ADX, RSI)
   * @param {Object} performance - Historical performance metrics for this market
   * @param {number} currentExposure - Current USD exposure in this market
   * @param {number} totalExposure - Total USD exposure across all markets
   * @param {number} normalizedExpectedReturn - Pre-normalized expected return (z-score)
   * @param {Object} exposureByMarket - Optional map of market -> exposure for correlation calc
   * @returns {number} Score (0-1+)
   */
  calculateMarketScore(market, signal, priceData, performance, currentExposure, totalExposure, normalizedExpectedReturn = 0, exposureByMarket = {}) {
    if (!signal || signal.action === 'hold' || signal.action === 'close') {
      return 0;
    }

    // Get strategy type - prefer signal's strategyType (multi-strategy mode) over market default
    const strategyType = signal.strategyType || (this.strategyFactory ? this.strategyFactory.getStrategyType(market) : 'momentum');
    
    // Get strategy-aware scoring weights for this market and strategy type
    const weights = this.getScoringWeightsForMarket(market, strategyType);
    
    // Check if this is a reversion strategy (affects how we score certain factors)
    const isReversionStrategy = this.isReversionStrategy(strategyType);
    const isIchimoku = this.isIchimokuStrategy(strategyType);
    const ichi = isIchimoku ? this._ichimokuInputs(signal, priceData) : null;

    // Base confidence score (0-1) with safe fallback
    // Use absolute value since negative confidence indicates short direction, not low quality
    // FIX: Ensure monotonicity - higher abs(confidence) should always produce higher score
    const rawConfidence = Number(signal.confidence);
    const absConfidence = Number.isFinite(rawConfidence) ? Math.abs(rawConfidence) : 1.0;
    // Monotonic mapping: confidence 0→0, 1→0.33, 2→0.67, 3+→1.0
    // Use smooth mapping that's always increasing
    const CONFIDENCE_SCALE = 3.0;
    const confidenceScore = Math.min(absConfidence / CONFIDENCE_SCALE, 1.0);
    
    // Log strategy-level confidence (from entry pattern)
    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true' || process.env.DEBUG_SCORING === 'true') {
      console.log('[ALLOCATOR] Stage 1 - Strategy Entry Pattern:', {
        market,
        strategyType,
        pattern: signal.reason,
        strategyConfidence: rawConfidence.toFixed(3),
        normalizedConfidence: confidenceScore.toFixed(3),
        side: signal.side,
      });
    }

    // Risk-adjusted return estimate - use pre-normalized value if provided
    let expectedReturn = normalizedExpectedReturn;

    // Volatility score - strategy-dependent interpretation
    let volatilityScore = 1.0;
    {
      const volatilityPercent = isIchimoku
        ? ichi?.atrPct
        : (priceData.atr && priceData.price ? (priceData.atr / priceData.price) * 100 : null);

      if (Number.isFinite(volatilityPercent)) {
        if (isReversionStrategy) {
        // Reversion prefers MODERATE volatility (need RSI swings, but not trending)
        // Sweet spot: 1-4% volatility = highest score
        // Too low (<0.5%): insufficient movement for mean reversion
        // Too high (>5%): likely trending, bad for counter-trend
        if (volatilityPercent < 0.5) {
          volatilityScore = 0.5; // Too quiet
        } else if (volatilityPercent < 1.0) {
          volatilityScore = 0.7; // Low but acceptable
        } else if (volatilityPercent <= 4.0) {
          volatilityScore = 1.0; // Sweet spot for reversion
        } else if (volatilityPercent <= 6.0) {
          volatilityScore = 0.8; // Slightly high but still OK
        } else {
          volatilityScore = Math.max(0.4, 1.0 - (volatilityPercent - 4) / 10); // Penalize high volatility more for reversion
        }
      } else if (isIchimoku) {
        // Ichimoku breakouts prefer "enough movement to trend", but not extreme whipsaw.
        const cfg = this.ichimokuAlloc;
        if (volatilityPercent < cfg.atrPctMin) {
          volatilityScore = 0.4;
        } else if (volatilityPercent < cfg.atrPctSweetMin) {
          volatilityScore = 0.7;
        } else if (volatilityPercent <= cfg.atrPctSweetMax) {
          volatilityScore = 1.0;
        } else if (volatilityPercent <= cfg.atrPctMax) {
          volatilityScore = 0.85;
        } else {
          volatilityScore = Math.max(0.55, 0.85 - (volatilityPercent - cfg.atrPctMax) / 20);
        }
      } else {
        // Momentum/Scalping: lower volatility = higher score (breakouts work in calmer markets)
        // Normalize: 0-5% volatility = 1.0, 10%+ = 0.5
        volatilityScore = Math.max(0.5, 1.0 - (volatilityPercent - 5) / 10);
      }
      }
    }

    // Performance score (0-1) with Bayesian shrinkage for stability
    // FIX: Use shrinkage to avoid small-sample noise dominating scores
    let performanceScore = 0.5; // Neutral prior
    if (performance) {
      const rawWinRate = performance.winRate || 0;
      const avgPnL = performance.avgPnL || 0;
      const recentTrades = performance.recentTrades || 0;
      const recentTradesCount = Array.isArray(recentTrades) ? recentTrades.length : (typeof recentTrades === 'number' ? recentTrades : 0);
      
      // Minimum trades gate: require at least 3 trades for any performance signal
      const MIN_TRADES_FOR_PERFORMANCE = 3;
      
      if (recentTradesCount < MIN_TRADES_FOR_PERFORMANCE) {
        // Insufficient history - stay at neutral prior
        performanceScore = 0.5;
      } else {
        // Beta-Binomial shrinkage for win rate
        // Prior: Beta(α=5, β=5) -> prior mean = 0.5 (neutral)
        // Posterior mean = (α + wins) / (α + β + n)
        const BETA_ALPHA = 5;
        const BETA_BETA = 5;
        const wins = Math.round(rawWinRate * recentTradesCount);
        const losses = recentTradesCount - wins;
        const posteriorWinRate = (BETA_ALPHA + wins) / (BETA_ALPHA + BETA_BETA + recentTradesCount);
        
        // Normalize posterior win rate to 0-1 score
        // 40% -> 0, 60% -> 1.0 (shrunk towards 0.5)
        const winRateScore = Math.max(0, Math.min(1, (posteriorWinRate - 0.4) / 0.2));
        
        // Winsorize avgPnL to clip extreme outliers (±100% range)
        const PNL_CLIP = 100;
        const clippedPnL = Math.max(-PNL_CLIP, Math.min(PNL_CLIP, avgPnL));
        const pnlScore = Math.max(0, Math.min(1, (clippedPnL / (2 * PNL_CLIP)) + 0.5)); // -100% -> 0, +100% -> 1
        
        // Sample-size weighting: more trades = more weight on observed data vs prior
        // asymptotes to 1.0 as n → ∞ (diminishing returns after ~20 trades)
        const reliabilityWeight = Math.min(recentTradesCount / 20, 1.0);
        
        // Blend with prior: (1 - reliability) * prior + reliability * observed
        const observedScore = winRateScore * 0.6 + pnlScore * 0.4;
        performanceScore = (1 - reliabilityWeight) * 0.5 + reliabilityWeight * observedScore;
        
        // Ensure monotonicity: higher observed performance should never decrease score
        performanceScore = Math.max(performanceScore, 0.5 * (1 - reliabilityWeight)); // Floor at shrunk-toward-prior
      }
    }

    // Diversification bonus/penalty
    let diversificationScore = 1.0;
    if (totalExposure > 0) {
      const marketExposureRatio = currentExposure / totalExposure;
      // Penalty if too much exposure in this market
      if (marketExposureRatio > 0.5) {
        diversificationScore = 0.7; // 30% penalty
      } else if (marketExposureRatio > 0.33) {
        diversificationScore = 0.85; // 15% penalty
      } else {
        diversificationScore = this.config.diversificationBonus; // Bonus for diversification
      }
    }

    // Correlation penalty
    // Check if we have correlated positions (pass exposureByMarket for proper basket calculation)
    const correlationPenalty = this._calculateCorrelationPenalty(market, currentExposure, totalExposure, exposureByMarket);

    // Combine scores
    // Expected return is pre-normalized z-score, clamp to reasonable range for score contribution
    // Normalize expected return to 0-1 range: z-score of 0 = 0.5, +2 = 1.0, -2 = 0.0
    const expectedReturnNormalized = Math.max(0, Math.min(1, (Math.max(-2, Math.min(2, expectedReturn)) / 4) + 0.5));
    // Side-aware adjustments: admit quality shorts
    const isShort = String(signal.side || '').toLowerCase() === 'short';
    // Overbought bias for shorts using RSI if available (RSI>55 boosts, 70+ stronger)
    let shortBias = 1.0;
    if (isShort && typeof priceData.rsi === 'number') {
      const rsi = priceData.rsi;
      if (rsi >= 55) shortBias += Math.min((rsi - 55) / 45, 0.25); // up to +25%
    }
    // Trend strength bias for shorts when ADX is strong
    if (isShort && typeof priceData.adx === 'number') {
      const adx = priceData.adx;
      if (adx >= 20) shortBias += Math.min((adx - 20) / 80, 0.15); // up to +15%
    }

	    let baseScore = (
	      confidenceScore * weights.confidenceWeight +
	      expectedReturnNormalized * weights.riskAdjustedWeight +
	      volatilityScore * weights.volatilityWeight +
	      performanceScore * weights.performanceWeight
	    );

	    // Ichimoku: prioritize higher-quality breakout signals when multiple markets fire on the same bar.
	    // Apply as a multiplier so portfolio controls (correlation/cooldown) still matter.
	    if (isIchimoku) {
	      const cfg = this.ichimokuAlloc;
	      const side = String(signal.side || '').toLowerCase();
	      const adx = ichi?.adx;
	      const thickness = ichi?.cloudThicknessAtr;
	      const breakoutDistAtr = ichi?.breakoutDistAtr;
	      const kijunDistAtr = ichi?.kijunDistAtr;

	      // Optional hard gates
	      if (cfg.enableAdxGate && Number.isFinite(adx) && adx < cfg.adxMin) return 0;
	      if (cfg.enableLateEntryVeto && Number.isFinite(kijunDistAtr) && kijunDistAtr > cfg.maxKijunDistAtr) return 0;
	      if (cfg.enableCloudThicknessVeto && Number.isFinite(thickness) && thickness > cfg.maxCloudThicknessAtr) return 0;
	      if (cfg.enableHtfBiasGate) {
	        const bias = ichi?.htfBias;
	        if (bias === 'choppy') return 0;
	        if (side === 'long' && bias === 'bearish') return 0;
	        if (side === 'short' && bias === 'bullish') return 0;
	      }

	      // Component scores (0..1), monotonic / single-bump
	      const trendScore = Number.isFinite(adx)
	        ? this._clamp01((adx - cfg.adxMin) / Math.max(1e-9, cfg.adxSaturation - cfg.adxMin))
	        : 0;
	      const breakoutScore = this._bump(breakoutDistAtr, cfg.breakoutLeftAtr, cfg.breakoutPeakAtr, cfg.breakoutRightAtr);
	      const structureScore = Number.isFinite(thickness)
	        ? this._clamp01(1.0 - Math.max(0, thickness - 1.0) / Math.max(1e-9, cfg.maxCloudThicknessAtr - 1.0))
	        : 0.5;
	      const volScore = volatilityScore;

	      // Late-entry penalty (soft) to discourage chasing far from Kijun even if not vetoed.
	      const latePenalty = Number.isFinite(kijunDistAtr) && Number.isFinite(cfg.maxKijunDistAtr) && cfg.maxKijunDistAtr > 0
	        ? this._clamp01(1.0 - Math.max(0, kijunDistAtr - 0.5) / cfg.maxKijunDistAtr)
	        : 1.0;

	      const wSum = (cfg.wTrend + cfg.wBreakout + cfg.wStructure + cfg.wVol) || 1;
	      let q =
	        (trendScore * cfg.wTrend +
	          breakoutScore * cfg.wBreakout +
	          structureScore * cfg.wStructure +
	          volScore * cfg.wVol) / wSum;
	      q *= latePenalty;

	      if (cfg.enableVolumeBonus && ichi?.volumeSpike === true) q = Math.min(1, q + cfg.volumeBonus);

	      // Soft HTF adjustment (if present)
	      if (typeof ichi?.htfBias === 'string') {
	        if ((side === 'long' && ichi.htfBias === 'bullish') || (side === 'short' && ichi.htfBias === 'bearish')) {
	          q = Math.min(1, q + cfg.htfBiasBonus);
	        }
	        if ((side === 'long' && ichi.htfBias === 'bearish') || (side === 'short' && ichi.htfBias === 'bullish')) {
	          q = Math.max(0, q - cfg.htfBiasPenalty);
	        }
	      }

	      // Multiplier in [0.7..1.4] to meaningfully rank, not dominate.
	      baseScore *= 0.7 + 0.7 * this._clamp01(q);
	    }

    // Apply cooldown adjustment (based on recent loss/win)
    const cooldownAdjustment = this._calculateCooldownAdjustment(market, signal.side);
    
    // Apply market tier and historical performance boost
    const { tierMult, histBoost, combined: marketBoost } = this.getMarketBoostMultiplier(market);

    // Apply diversification, correlation, cooldown, and market boost adjustments
    let finalScore = baseScore * diversificationScore * correlationPenalty * cooldownAdjustment * marketBoost;
    if (isShort) {
      finalScore *= shortBias;
      // Ensure quality shorts with sufficient conditions get a floor score
      const rsi = typeof priceData.rsi === 'number' ? priceData.rsi : null;
      const adx = typeof priceData.adx === 'number' ? priceData.adx : null;
      if ((rsi !== null && rsi >= 50) && (adx !== null && adx >= 15)) {
        finalScore = Math.max(finalScore, 0.05);
      }
    }
    
    // FIX: Final bounds check - ensure score is finite and in reasonable range
    if (!Number.isFinite(finalScore)) {
      finalScore = 0;
    }
    // Soft cap at 2.0 to prevent extreme scores from dominating
    finalScore = Math.min(finalScore, 2.0);
    
    // Minimum threshold check
    // RSI-Reversion bypass: pass all signals if REVERSION_ALLOCATOR_BYPASS_THRESHOLD=true
    if (isReversionStrategy && this.config.reversionBypassThreshold) {
      if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
        console.log('[ALLOCATOR] calculateMarketScore: RSI-reversion bypass enabled, passing signal', {
          market,
          side: signal.side,
          finalScore,
          strategyType,
        });
      }
      // Return at least a minimum score to ensure signal passes through
      return Math.max(finalScore, 0.01);
    }
    
    // Side-aware thresholds: be a bit more permissive on shorts
    // For RSI-reversion, use strategy-specific thresholds
    // FIX: Define minScore/minConfidence BEFORE debug log that references them
    let minScore, minConfidence;
    if (isReversionStrategy) {
      minScore = this.config.reversionMinScore ?? 0;
      minConfidence = this.config.reversionMinConfidence ?? 0;
    } else if (isIchimoku) {
      minScore = this.config.ichimokuMinScore ?? this.config.minScore;
      minConfidence = this.config.ichimokuMinConfidence ?? this.config.minConfidence;
    } else {
      minScore = isShort ? Math.max(0, this.config.minScore * 0.7) : this.config.minScore;
      minConfidence = isShort ? Math.max(0, this.config.minConfidence * 0.7) : this.config.minConfidence;
    }
    
    // Log Stage 2 - Market Allocator Cross-Market Scoring (moved after minScore/minConfidence are defined)
    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true' || process.env.DEBUG_SCORING === 'true') {
      console.log('[ALLOCATOR] Stage 2 - Cross-Market Scoring:', {
        market,
        strategyType,
        // Component scores (0-1 scale)
        components: {
          confidence: (confidenceScore * weights.confidenceWeight).toFixed(3) + ` (${(weights.confidenceWeight * 100).toFixed(0)}% weight)`,
          expectedReturn: (expectedReturnNormalized * weights.riskAdjustedWeight).toFixed(3) + ` (${(weights.riskAdjustedWeight * 100).toFixed(0)}% weight)`,
          volatility: (volatilityScore * weights.volatilityWeight).toFixed(3) + ` (${(weights.volatilityWeight * 100).toFixed(0)}% weight)`,
          performance: (performanceScore * weights.performanceWeight).toFixed(3) + ` (${(weights.performanceWeight * 100).toFixed(0)}% weight)`,
        },
        baseScore: baseScore.toFixed(3),
        // Adjustments
        adjustments: {
          diversification: diversificationScore.toFixed(3),
          correlation: correlationPenalty.toFixed(3),
          cooldown: cooldownAdjustment.toFixed(3),
          shortBias: isShort ? shortBias.toFixed(3) : 'N/A',
          tierMult: tierMult.toFixed(3),
          histBoost: histBoost.toFixed(3),
          marketBoost: marketBoost.toFixed(3),
        },
        finalScore: finalScore.toFixed(3),
        // Summary
        summary: {
          strategyConfidence: rawConfidence.toFixed(3),
          allocatorScore: finalScore.toFixed(3),
          willTrade: finalScore >= minScore && confidenceScore >= minConfidence,
          minScore,
          minConfidence,
        },
      });
    }
    
    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
      console.log('[ALLOCATOR] calculateMarketScore details:', {
        market,
        side: signal.side,
        strategyType,
        isReversionStrategy,
        confidenceScore,
        expectedReturnNormalized,
        volatilityScore,
        performanceScore,
        baseScore,
        diversificationScore,
        correlationPenalty,
        cooldownAdjustment,
        shortBias: isShort ? shortBias : 'N/A',
        finalScore,
        minScore,
        minConfidence,
        passesThreshold: finalScore >= minScore && confidenceScore >= minConfidence,
      });
    }
    
    if (finalScore < minScore || confidenceScore < minConfidence) {
      // For shorts, admit small positive score when trend strength present
      if (isShort) {
        const adx = typeof priceData.adx === 'number' ? priceData.adx : null;
        if (adx !== null && adx >= 15) {
          const adjustedScore = Math.max(finalScore || 0, 0.02);
          if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
            console.log('[ALLOCATOR] calculateMarketScore: short adjusted score', { market, adjustedScore, adx });
          }
          return adjustedScore;
        }
      }
      
      // Store rejection diagnostics for later retrieval
      const rejectionDiagnostics = {
        finalScore,
        minScore,
        confidenceScore,
        minConfidence,
        baseScore,
        components: {
          confidence: confidenceScore,
          expectedReturn: expectedReturnNormalized,
          volatility: volatilityScore,
          performance: performanceScore,
        },
        adjustments: {
          diversification: diversificationScore,
          correlation: correlationPenalty,
          cooldown: cooldownAdjustment,
          shortBias: isShort ? shortBias : 1.0,
          tierMult,
          histBoost,
          marketBoost,
        },
        thresholds: {
          minScore,
          minConfidence,
        },
        reason: finalScore < minScore 
          ? `Score ${finalScore.toFixed(3)} < minScore ${minScore.toFixed(3)}`
          : `Confidence ${confidenceScore.toFixed(3)} < minConfidence ${minConfidence.toFixed(3)}`,
      };
      
      // Store diagnostics in a cache keyed by market+side for retrieval
      if (!this._rejectionDiagnostics) {
        this._rejectionDiagnostics = new Map();
      }
      const diagKey = `${market}:${signal.side}`;
      this._rejectionDiagnostics.set(diagKey, rejectionDiagnostics);
      
      if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
        console.log('[ALLOCATOR] calculateMarketScore: returning 0 (below threshold)', {
          market,
          ...rejectionDiagnostics,
        });
      }
      return 0;
    }

    return finalScore;
  }

  /**
   * Calculate correlation penalty if we have too many correlated positions
   * Uses dynamic correlation when available
   * 
   * FIX: Now properly calculates correlated-basket exposure by summing
   * exposure in correlated markets weighted by their correlation strength.
   * 
   * CRITICAL FIX: Venue-aware correlation checks - only checks correlations
   * within the same venue (majors vs alts use separate capital pools, so
   * correlation risk should not bleed between venues).
   * 
   * @param {string} market - Target market
   * @param {number} currentExposure - Current exposure in target market
   * @param {number} totalExposure - Total exposure across all markets (venue-specific)
   * @param {Object} exposureByMarket - Optional map of market -> exposure (for correlated basket calc)
   * @returns {number} Penalty multiplier (0.7-1.0)
   */
  _calculateCorrelationPenalty(market, currentExposure, totalExposure, exposureByMarket = {}) {
    if (totalExposure === 0) return 1.0;
    
    // Correlation floor: below this, correlation is considered negligible
    const CORRELATION_FLOOR = 0.3;
    // Minimum penalty (never penalize more than 30%)
    const MIN_PENALTY_MULTIPLIER = 0.7;
    
    // CRITICAL: Get venue router to filter markets by venue
    // Correlation checks should only apply within the same venue (majors vs alts)
    let venueRouter = null;
    let targetVenue = null;
    try {
      venueRouter = require('./venue-router');
      targetVenue = venueRouter.getVenueForMarket(market);
    } catch (e) {
      // Fallback: if venue-router not available, use all markets (legacy behavior)
      venueRouter = null;
    }
    
    // Filter markets to only those in the same venue as the target market
    const marketsInSameVenue = venueRouter 
      ? this.markets.filter(m => venueRouter.getVenueForMarket(m) === targetVenue)
      : this.markets;
    
    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true' && venueRouter) {
      console.log(`[ALLOCATOR] Correlation check for ${market} (${targetVenue}): checking ${marketsInSameVenue.length}/${this.markets.length} markets in same venue`);
    }
    
    // Calculate correlated-basket exposure:
    // For each correlated market IN THE SAME VENUE, add its exposure weighted by how much
    // the correlation exceeds the floor (normalized to 0-1)
    let correlatedBasketExposure = currentExposure;
    let maxAbsCorr = 0;
    
    for (const otherMarket of marketsInSameVenue) {
      if (otherMarket === market) continue;
      
      const corr = this.getCorrelation(market, otherMarket);
      const absCorr = Math.abs(corr);
      
      if (absCorr > maxAbsCorr) {
        maxAbsCorr = absCorr;
      }
      
      // Only count exposure from significantly correlated markets
      if (absCorr > CORRELATION_FLOOR) {
        const otherExposure = exposureByMarket[otherMarket] || 0;
        // Weight by how much correlation exceeds floor (normalized to 0-1)
        const corrWeight = (absCorr - CORRELATION_FLOOR) / (1 - CORRELATION_FLOOR);
        correlatedBasketExposure += otherExposure * corrWeight;
      }
    }
    
    // Determine effective max correlated exposure
    // If correlations are low overall, allow higher concentration
    let effectiveMaxCorrExposure = this.config.maxCorrelatedExposure;
    if (maxAbsCorr < 0.4 && this.config.maxCorrelatedExposure <= 0.6) {
      effectiveMaxCorrExposure = 0.8;
    }
    
    // Calculate penalty based on correlated basket exposure ratio
    const correlatedExposureRatio = correlatedBasketExposure / totalExposure;
    
    if (correlatedExposureRatio > effectiveMaxCorrExposure) {
      const excessRatio = (correlatedExposureRatio - effectiveMaxCorrExposure) / (1 - effectiveMaxCorrExposure);
      // Penalty scales with excess: 0% penalty at threshold, up to (1-MIN_PENALTY_MULTIPLIER) at 100%
      const penalty = Math.min(excessRatio * (1 - MIN_PENALTY_MULTIPLIER), 1 - MIN_PENALTY_MULTIPLIER);
      return Math.max(MIN_PENALTY_MULTIPLIER, 1.0 - penalty);
    }

    return 1.0;
  }

  /**
   * Evaluate all opportunities from all markets
   * @param {Array} allMarketSignals - Array of {market, signal, priceData}
   * @param {Array} positions - Current open positions
   * @param {Object} portfolioMetrics - Portfolio risk metrics
   * @param {Map} marketPerformance - Map of market -> performance metrics
   * @returns {Array} Ranked opportunities with scores
   */
  evaluateOpportunities(allMarketSignals, positions, portfolioMetrics, marketPerformance) {
    const opportunities = [];
    const positionsByMarket = this._groupPositionsByMarket(positions);
    const exposureByMarket = this._calculateExposureByMarket(positions);
    const totalExposure = Object.values(exposureByMarket).reduce((sum, exp) => sum + exp, 0);

    // CRITICAL: Calculate venue-specific exposure for correlation penalty
    // Majors and alts use separate capital pools, so correlation checks should be venue-aware
    let venueRouter = null;
    let exposureByVenue = { jupiter: 0, drift: 0 };
    try {
      venueRouter = require('./venue-router');
      for (const [market, exposure] of Object.entries(exposureByMarket)) {
        const venue = venueRouter.getVenueForMarket(market);
        exposureByVenue[venue] = (exposureByVenue[venue] || 0) + exposure;
      }
    } catch (e) {
      // Fallback: use total exposure for all markets (legacy behavior)
      venueRouter = null;
    }

    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
      console.log('[ALLOCATOR] evaluateOpportunities called:', {
        signalCount: allMarketSignals.length,
        positionCount: positions.length,
        totalExposure,
        exposureByMarket: Object.fromEntries(Object.entries(exposureByMarket)),
        exposureByVenue: venueRouter ? exposureByVenue : 'venue-router unavailable',
      });
    }

    // First pass: calculate expected returns for all candidates
    const candidates = [];
    let skippedSignals = { hold: 0, close: 0, maxPositions: 0, noSignal: 0 };
    for (const { market, signal, priceData } of allMarketSignals) {
      if (!signal || signal.action === 'hold' || signal.action === 'close') {
        if (!signal) skippedSignals.noSignal++;
        else if (signal.action === 'hold') skippedSignals.hold++;
        else if (signal.action === 'close') skippedSignals.close++;
        if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
          console.log('[ALLOCATOR] Skipping signal:', { market, action: signal?.action, reason: !signal ? 'no signal' : signal.action });
        }
        continue;
      }

      const currentExposure = exposureByMarket[market] || 0;
      const performance = marketPerformance?.get(market) || {};
      const currentPositionsInMarket = (positionsByMarket[market] || []).length;

      // Check per-market position limit
      if (currentPositionsInMarket >= this.config.maxPositionsPerMarket) {
        skippedSignals.maxPositions++;
        if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
          console.log('[ALLOCATOR] Skipping signal (max positions):', { market, currentPositionsInMarket, maxPositionsPerMarket: this.config.maxPositionsPerMarket });
        }
        continue;
      }

	      // Calculate raw expected return
	      // Use signal's strategyType for proper scoring in multi-strategy mode
	      const signalStrategyType = signal.strategyType || (this.strategyFactory ? this.strategyFactory.getStrategyType(market) : 'momentum');
	      const isReversion = this.isReversionStrategy(signalStrategyType);
	      const isIchimoku = this.isIchimokuStrategy(signalStrategyType);
      
      // FIX: Use absolute confidence for expected-return proxy
      // Negative confidence indicates short direction, not low quality
      const rawConf = Number(signal.confidence);
      const absConf = Number.isFinite(rawConf) ? Math.abs(rawConf) : 0;
      const confidenceScore = Math.min(absConf / 3.0, 1.0);
	      let expectedReturn = 0;
	      const ichi = isIchimoku ? this._ichimokuInputs(signal, priceData) : null;
	      const atr = isIchimoku ? ichi?.atr : priceData.atr;
	      const price = isIchimoku ? ichi?.price : priceData.price;
	      if (Number.isFinite(atr) && Number.isFinite(price) && price > 0) {
	        const atrPercent = (atr / price) * 100;
	        
	        if (isReversion) {
          // For reversion: LOW ADX (ranging market) is GOOD, high ADX (trending) is BAD
          // Invert the ADX multiplier: ADX < 20 = bonus, ADX > 30 = penalty
          let adxMultiplier = 1.0;
          if (priceData.adx !== undefined && priceData.adx !== null) {
            const adx = priceData.adx;
            if (adx < 20) {
              // Low ADX = ranging market = good for reversion
              adxMultiplier = 1.3 + (20 - adx) / 50; // Up to 1.7x boost for very low ADX
            } else if (adx < 30) {
              // Moderate ADX = acceptable
              adxMultiplier = 1.0;
            } else {
              // High ADX = trending = bad for reversion
              adxMultiplier = Math.max(0.4, 1.0 - (adx - 30) / 50); // Penalty for trending
            }
          }
	          // Reversion uses moderate volatility as a baseline
	          expectedReturn = atrPercent * adxMultiplier * (confidenceScore * 1.5); // Slightly lower base multiplier
	        } else if (isIchimoku) {
	          // Ichimoku breakout: prefer strong trends + clean breakouts (bar-based inputs only).
	          const cfg = this.ichimokuAlloc;
	          const adx = Number.isFinite(ichi?.adx) ? ichi.adx : Number(priceData.adx);
	          const adxMultiplier = Number.isFinite(adx) ? Math.min(adx / 35, 1.8) : 1.0;

	          // Reward modest follow-through; penalize being too late.
	          let breakoutMultiplier = 1.0;
	          const breakoutDistAtr = Number(ichi?.breakoutDistAtr);
	          if (Number.isFinite(breakoutDistAtr)) {
	            breakoutMultiplier *= Math.max(0.85, Math.min(1.35, 1.0 + breakoutDistAtr / 3));
	          }

	          // Penalize thick clouds (late / messy structure).
	          const thickness = Number(ichi?.cloudThicknessAtr);
	          if (Number.isFinite(thickness) && thickness > 2.5) {
	            breakoutMultiplier *= Math.max(0.7, 1.0 - (thickness - 2.5) / Math.max(1e-9, cfg.maxCloudThicknessAtr));
	          }

	          // Penalize very late entries far from Kijun (even if not vetoed).
	          const kijunDist = Number(ichi?.kijunDistAtr);
	          if (Number.isFinite(kijunDist) && Number.isFinite(cfg.maxKijunDistAtr) && kijunDist > 0.5) {
	            breakoutMultiplier *= Math.max(0.6, 1.0 - (kijunDist - 0.5) / cfg.maxKijunDistAtr);
	          }

	          expectedReturn = atrPercent * adxMultiplier * breakoutMultiplier * (confidenceScore * 2.0);
	        } else {
	          // Momentum/Scalping: high ADX (strong trend) is GOOD
	          const adxMultiplier = priceData.adx ? Math.min(priceData.adx / 40, 1.5) : 1.0;
	          expectedReturn = atrPercent * adxMultiplier * (confidenceScore * 2);
	        }
	      }

      candidates.push({
        market,
        signal,
        priceData,
        currentExposure,
        currentPositionsInMarket,
        performance,
        rawExpectedReturn: expectedReturn,
        strategyType: signalStrategyType, // Include strategy type for debugging
      });
    }

    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
      console.log('[ALLOCATOR] Candidates after first pass:', {
        candidateCount: candidates.length,
        skippedSignals,
        candidates: candidates.map(c => ({
          market: c.market,
          strategyType: c.strategyType,
          action: c.signal.action,
          side: c.signal.side,
          confidence: c.signal.confidence,
          rawExpectedReturn: c.rawExpectedReturn,
          currentPositionsInMarket: c.currentPositionsInMarket,
        })),
      });
    }

    // Normalize expected returns cross-sectionally using z-score
    // FIX: Add NaN hygiene - filter out non-finite values before stats
    const expectedReturns = candidates
      .map(c => c.rawExpectedReturn)
      .filter(v => Number.isFinite(v));
    const stats = this._calculateStats(expectedReturns);
    
    // FIX: Clamp z-scores to avoid extreme values dominating scoring
    const Z_SCORE_CLAMP = 3.0;
    const normalizeExpectedReturn = (raw) => {
      // Handle NaN/Infinity inputs
      if (!Number.isFinite(raw)) return 0;
      if (stats.stdev === 0) return raw > 0 ? 1 : 0;
      const zScore = (raw - stats.mean) / stats.stdev;
      // Clamp to [-Z_SCORE_CLAMP, Z_SCORE_CLAMP] (winsorization)
      return Math.max(-Z_SCORE_CLAMP, Math.min(Z_SCORE_CLAMP, zScore));
    };

    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
      console.log('[ALLOCATOR] Expected return stats:', { mean: stats.mean, stdev: stats.stdev, min: stats.min, max: stats.max });
    }

    // Second pass: score each candidate with normalized expected return
    let scoresZero = 0;
    let scoresPositive = 0;
    for (const candidate of candidates) {
      const normalizedExpectedReturn = normalizeExpectedReturn(candidate.rawExpectedReturn);
      
      // CRITICAL: Use venue-specific exposure for correlation penalty
      // Determine venue for this market and use venue-specific total exposure
      const marketVenue = venueRouter ? venueRouter.getVenueForMarket(candidate.market) : null;
      const venueTotalExposure = marketVenue ? (exposureByVenue[marketVenue] || 0) : totalExposure;
      
      const score = this.calculateMarketScore(
        candidate.market,
        candidate.signal,
        candidate.priceData,
        candidate.performance,
        candidate.currentExposure,
        venueTotalExposure, // CRITICAL: Pass venue-specific exposure, not global
        normalizedExpectedReturn,
        exposureByMarket // FIX: Pass for proper correlation penalty calculation
      );

      if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
        console.log('[ALLOCATOR] Candidate scored:', {
          market: candidate.market,
          venue: marketVenue || 'unknown',
          strategyType: candidate.strategyType,
          side: candidate.signal.side,
          score,
          normalizedExpectedReturn,
          rawExpectedReturn: candidate.rawExpectedReturn,
          currentExposure: candidate.currentExposure,
          venueTotalExposure,
          globalTotalExposure: totalExposure,
        });
      }

      if (score > 0) {
        scoresPositive++;
        opportunities.push({
          market: candidate.market,
          signal: candidate.signal,
          priceData: candidate.priceData,
          score,
          currentExposure: candidate.currentExposure,
          currentPositions: candidate.currentPositionsInMarket,
          strategyType: candidate.strategyType, // Include for multi-strategy mode
        });
      } else {
        scoresZero++;
      }
    }

    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
      console.log('[ALLOCATOR] Opportunities after scoring:', {
        opportunityCount: opportunities.length,
        scoresPositive,
        scoresZero,
        opportunities: opportunities.map(o => ({
          market: o.market,
          strategyType: o.strategyType,
          side: o.signal.side,
          score: o.score,
        })),
      });
    }

    // Sort by score (highest first)
    opportunities.sort((a, b) => b.score - a.score);

    return opportunities;
  }

  /**
   * Select best opportunities given position limits
   * @param {Array} rankedOpportunities - Ranked opportunities from evaluateOpportunities
   * @param {number} maxPositions - Maximum total positions allowed
   * @param {Array} currentPositions - Current open positions
   * @returns {Array} Selected opportunities to trade
   */
  selectBestOpportunities(rankedOpportunities, maxPositions, currentPositions) {
    const selected = [];
    const positionsByMarket = this._groupPositionsByMarket(currentPositions);
    const currentCount = currentPositions.length;
    const availableSlots = maxPositions - currentCount;

    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
      console.log('[ALLOCATOR] selectBestOpportunities called:', {
        rankedOpportunitiesCount: rankedOpportunities.length,
        maxPositions,
        currentCount,
        availableSlots,
      });
    }

    if (availableSlots <= 0) {
      if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
        console.log('[ALLOCATOR] selectBestOpportunities: no available slots');
      }
      return [];
    }

    // ε-greedy exploration: occasional random selection of 2nd-best market
    const shouldExplore = Math.random() < this.config.exploreProbability;
    let exploring = false;

    let skippedReasons = { maxSlots: 0, hardLimit: 0, exploration: 0 };
    for (const opp of rankedOpportunities) {
      if (selected.length >= availableSlots) {
        skippedReasons.maxSlots++;
        if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
          console.log('[ALLOCATOR] selectBestOpportunities: reached max slots', { selectedCount: selected.length, availableSlots });
        }
        break;
      }

      const { market, currentPositions: positionsInMarket, score } = opp;

      // Check total position limit
      if (selected.length + currentCount >= maxPositions) {
        skippedReasons.maxSlots++;
        if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
          console.log('[ALLOCATOR] selectBestOpportunities: total position limit reached', {
            selectedCount: selected.length,
            currentCount,
            maxPositions,
          });
        }
        break;
      }

      // Apply soft-cap diminishing returns instead of hard limit
      const alreadySelectedCount = selected.filter(o => o.market === market).length;
      const totalMarketPositions = positionsInMarket + alreadySelectedCount;
      
      // Diminishing returns penalty per additional position
      // First 2 positions: 100% score, 3rd: 70%, 4th: 50%, 5th+: 30%
      let diversificationPenalty = 1.0;
      if (totalMarketPositions >= 4) {
        diversificationPenalty = 0.3;
      } else if (totalMarketPositions >= 3) {
        diversificationPenalty = 0.5;
      } else if (totalMarketPositions >= 2) {
        diversificationPenalty = 0.7;
      }
      
      // Apply penalty to score for ranking purposes
      const adjustedScore = score * diversificationPenalty;
      
      // Only skip if adjusted score is too low or hard limit exceeded
      if (totalMarketPositions >= this.config.maxPositionsPerMarket * 2) {
        skippedReasons.hardLimit++;
        if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
          console.log('[ALLOCATOR] selectBestOpportunities: hard limit exceeded', {
            market,
            totalMarketPositions,
            maxPositionsPerMarket: this.config.maxPositionsPerMarket,
          });
        }
        continue;
      }

      // ε-greedy exploration: occasionally select second-best market
      if (shouldExplore && !exploring && selected.length === 0 && rankedOpportunities.indexOf(opp) === 1) {
        exploring = true;
        // Boost 2nd-best to ensure it gets selected
        if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
          console.log('[ALLOCATOR] selectBestOpportunities: exploration mode, selecting 2nd best', { market, score });
        }
        selected.push({ ...opp, adjustedScore, exploring: true });
        continue;
      }
      
      // Skip if we're in exploration mode and this is the best market
      if (exploring && rankedOpportunities.indexOf(opp) === 0) {
        skippedReasons.exploration++;
        if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
          console.log('[ALLOCATOR] selectBestOpportunities: skipping best in exploration mode', { market });
        }
        continue;
      }

      if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
        console.log('[ALLOCATOR] selectBestOpportunities: selecting opportunity', {
          market,
          score,
          adjustedScore,
          diversificationPenalty,
          totalMarketPositions,
        });
      }
      selected.push({ ...opp, adjustedScore });
    }

    // Resort by adjusted score if penalties were applied
    if (selected.some(o => o.adjustedScore !== undefined)) {
      selected.sort((a, b) => (b.adjustedScore ?? b.score) - (a.adjustedScore ?? a.score));
    }

    if (process.env.DEBUG_MARKET_ALLOCATOR === 'true') {
      console.log('[ALLOCATOR] selectBestOpportunities result:', {
        selectedCount: selected.length,
        skippedReasons,
        selected: selected.map(s => ({
          market: s.market,
          strategyType: s.strategyType,
          side: s.signal.side,
          score: s.score,
          adjustedScore: s.adjustedScore,
        })),
      });
    }

    return selected;
  }

  /**
   * Group positions by market
   */
  _groupPositionsByMarket(positions) {
    const grouped = {};
    for (const pos of positions) {
      const market = pos.market || 'UNKNOWN';
      if (!grouped[market]) {
        grouped[market] = [];
      }
      grouped[market].push(pos);
    }
    return grouped;
  }

  /**
   * Calculate total USD exposure per market
   */
  /**
   * Calculate total USD exposure per market
   * FIX: Normalize exposure calculation to handle different position shapes:
   * - Live positions: may have `size` (notional), `collateral`, `leverage`
   * - Backtest positions: may have `sizeUsd`, `collateral`, `leverage`
   */
  _calculateExposureByMarket(positions) {
    const exposure = {};
    for (const pos of positions) {
      const market = pos.market || 'UNKNOWN';
      // Try multiple possible fields for notional size
      // Priority: size > sizeUsd > notional > (collateral * leverage)
      let notional = 0;
      if (Number.isFinite(pos.size) && pos.size !== 0) {
        notional = Math.abs(pos.size);
      } else if (Number.isFinite(pos.sizeUsd) && pos.sizeUsd !== 0) {
        notional = Math.abs(pos.sizeUsd);
      } else if (Number.isFinite(pos.notional) && pos.notional !== 0) {
        notional = Math.abs(pos.notional);
      } else if (Number.isFinite(pos.collateral)) {
        const lev = Number.isFinite(pos.leverage) && pos.leverage > 0 ? pos.leverage : 1;
        notional = Math.abs(pos.collateral * lev);
      }
      exposure[market] = (exposure[market] || 0) + notional;
    }
    return exposure;
  }

  /**
   * Calculate mean and standard deviation for array of numbers
   * FIX: Now filters non-finite values and returns min/max for debugging
   */
  _calculateStats(values) {
    if (!values || values.length === 0) {
      return { mean: 0, stdev: 1, min: 0, max: 0, count: 0 };
    }
    
    // Filter out non-finite values
    const cleanValues = values.filter(v => Number.isFinite(v));
    if (cleanValues.length === 0) {
      return { mean: 0, stdev: 1, min: 0, max: 0, count: 0 };
    }
    
    const mean = cleanValues.reduce((sum, val) => sum + val, 0) / cleanValues.length;
    const variance = cleanValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / cleanValues.length;
    const stdev = Math.sqrt(variance);
    const min = Math.min(...cleanValues);
    const max = Math.max(...cleanValues);
    
    return { 
      mean, 
      stdev: stdev || 1, // Avoid division by zero
      min,
      max,
      count: cleanValues.length,
    };
  }
}

module.exports = MarketAllocator;
