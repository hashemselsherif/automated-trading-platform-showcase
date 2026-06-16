// Slippage validation utility
const axios = require('axios');

const DEFAULT_IMPACT_STEPS = [0.25, 0.5, 0.75, 1];

const toNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const impactPctToBps = (value) => {
  const num = toNumber(value);
  if (num === null) return null;

  // If value is already expressed in percent (e.g. 0.35 => 0.35%), multiply by 100
  // otherwise treat as ratio (e.g. 0.0035 => 0.35%) and multiply by 10_000
  if (Math.abs(num) >= 1) {
    return Math.abs(num) * 100;
  }
  return Math.abs(num) * 10_000;
};

/**
 * Validate slippage and market impact before order execution
 */
class SlippageValidator {
  constructor(options = {}) {
    this.defaultMaxSlippageBps = options.maxSlippageBps || 50; // 0.5%
    this.volatilityMultiplier = options.volatilityMultiplier || 2;
    this.jupiterApiUrl = options.jupiterApiUrl || 'https://lite-api.jup.ag/swap/v1';
    this.maxMarketImpactBps = options.maxMarketImpactBps || 30; // 0.30%
    this.impactSteps = Array.isArray(options.impactSteps) && options.impactSteps.length
      ? options.impactSteps.filter((v) => Number.isFinite(v) && v > 0 && v <= 1)
      : DEFAULT_IMPACT_STEPS;
  }

  /**
   * Get quote with slippage & route information
   * NOTE: This still uses Jupiter Swap Quote API but ONLY for pre-trade validation
   * This is the intended use case for this API (actual trade quotes, not price polling)
   * Called only before opening/closing positions, not during warmup or price fetching
   */
  async getQuote(inputMint, outputMint, amount, slippageBps = null, params = {}) {
    try {
      const slippage = slippageBps || this.defaultMaxSlippageBps;
      const query = new URLSearchParams();
      query.set('inputMint', inputMint);
      query.set('outputMint', outputMint);
      query.set('amount', String(amount));
      query.set('slippageBps', String(slippage));

      Object.entries(params || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return;
        query.set(key, String(value));
      });

      const url = `${this.jupiterApiUrl}/quote?${query.toString()}`;
      const response = await axios.get(url, { timeout: 10000 });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get quote: ${error.message}`);
    }
  }

  /**
   * Calculate expected slippage from quote
   */
  calculateSlippage(quote, expectedPrice) {
    if (!quote || !expectedPrice) return null;

    const actualPrice = toNumber(quote.price) || (toNumber(quote.outAmount) && toNumber(quote.inAmount)
      ? toNumber(quote.outAmount) / toNumber(quote.inAmount)
      : null);
    const slippage = Math.abs((actualPrice - expectedPrice) / expectedPrice) * 10000; // in bps

    return {
      slippageBps: slippage,
      slippagePercent: slippage / 100,
      expectedPrice,
      actualPrice,
      acceptable: slippage <= this.defaultMaxSlippageBps,
    };
  }

  /**
   * Adjust slippage based on market volatility
   */
  adjustSlippageForVolatility(baseSlippageBps, volatility) {
    // Higher volatility = allow more slippage
    const adjusted = Math.min(
      baseSlippageBps * (1 + volatility * this.volatilityMultiplier),
      baseSlippageBps * 3 // Cap at 3x
    );
    return Math.round(adjusted);
  }

  /**
   * Validate slippage before execution
   */
  async validateSlippage(inputMint, outputMint, amount, expectedPrice, maxSlippageBps = null, params = {}) {
    const maxSlippage = maxSlippageBps || this.defaultMaxSlippageBps;

    try {
      const quote = await this.getQuote(inputMint, outputMint, amount, maxSlippage, params);
      const slippageInfo = this.calculateSlippage(quote, expectedPrice);

      if (!slippageInfo) {
        return {
          valid: false,
          reason: 'could_not_calculate_slippage',
          quote,
        };
      }

      const valid = slippageInfo.slippageBps <= maxSlippage;

      return {
        valid,
        slippage: slippageInfo,
        quote,
        recommendation: valid
          ? 'proceed'
          : `slippage_too_high_${slippageInfo.slippageBps}_bps_>_${maxSlippage}_bps`,
      };
    } catch (error) {
      return {
        valid: false,
        reason: 'quote_fetch_failed',
        error: error.message,
      };
    }
  }

  /**
   * Check liquidity before execution
   */
  async checkLiquidity(inputMint, outputMint, amount) {
    try {
      const quote = await this.getQuote(inputMint, outputMint, amount, null, {
        onlyDirectRoutes: false,
        enforceBestRoutes: true,
      });
      
      // Basic liquidity check - verify we can get a quote
      const hasLiquidity = quote && quote.outAmount && quote.outAmount > 0;
      
      return {
        hasLiquidity,
        quote,
        minOutput: quote?.outAmount || 0,
      };
    } catch (error) {
      return {
        hasLiquidity: false,
        error: error.message,
      };
    }
  }

  _scaledAmount(amount, ratio) {
    const numericAmount = toNumber(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null;
    const scaled = numericAmount * ratio;
    if (!Number.isFinite(scaled) || scaled <= 0) return null;
    // Preserve original precision by rounding to integer if original looked like integer
    if (Number.isInteger(numericAmount)) {
      return Math.max(1, Math.round(scaled));
    }
    return scaled;
  }

  _extractRouteLevels(quote) {
    if (!quote || !Array.isArray(quote.routePlan)) return [];
    return quote.routePlan.slice(0, 10).map((entry, idx) => {
      const info = entry?.swapInfo || entry;
      const inAmount = toNumber(info?.inAmount || info?.inputAmount);
      const outAmount = toNumber(info?.outAmount || info?.outputAmount);
      const impact = impactPctToBps(info?.priceImpactPct);
      return {
        level: idx + 1,
        label: info?.label || info?.marketMeta?.label || info?.ammKey || info?.programId || 'unknown',
        inAmount,
        outAmount,
        impactBps: impact,
      };
    });
  }

  _impactBpsFromQuote(quote, slippageInfo) {
    if (!quote && !slippageInfo) return null;
    const impactFromQuote = impactPctToBps(quote?.priceImpactPct ?? quote?.priceImpactPercentage);
    if (impactFromQuote !== null) return impactFromQuote;
    if (slippageInfo?.slippageBps !== undefined) {
      return Math.abs(slippageInfo.slippageBps);
    }
    const expected = slippageInfo?.expectedPrice;
    const actual = slippageInfo?.actualPrice;
    if (expected && actual) {
      return Math.abs((actual - expected) / expected) * 10_000;
    }
    return null;
  }

  async assessMarketImpact({
    inputMint,
    outputMint,
    amount,
    expectedPrice,
    maxImpactBps = null,
    quote = null,
    steps = null,
    params = {},
  }) {
    const threshold = Number.isFinite(maxImpactBps) ? maxImpactBps : this.maxMarketImpactBps;
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return {
        valid: true,
        thresholdBps: null,
        maxImpactBps: null,
        steps: [],
        reason: 'threshold_not_set',
      };
    }

    const simulationSteps = (steps && steps.length ? steps : this.impactSteps)
      .filter((v) => Number.isFinite(v) && v > 0 && v <= 1)
      .sort((a, b) => a - b);

    if (!simulationSteps.length) {
      simulationSteps.push(1);
    }

    const results = [];
    let maxObservedImpact = null;
    let hadError = false;

    for (const ratio of simulationSteps) {
      const scaledAmount = this._scaledAmount(amount, ratio);
      if (!scaledAmount) {
        results.push({
          ratio,
          acceptable: false,
          reason: 'invalid_amount',
        });
        hadError = true;
        continue;
      }

      let partialQuote = quote && ratio === 1 ? quote : null;
      let partialError = null;

      if (!partialQuote) {
        try {
          partialQuote = await this.getQuote(
            inputMint,
            outputMint,
            scaledAmount,
            null,
            {
              onlyDirectRoutes: false,
              enforceBestRoutes: true,
              swapMode: 'ExactIn',
              showRoutePlan: true,
              ...params,
            },
          );
        } catch (error) {
          partialError = error;
        }
      }

      if (!partialQuote || partialError) {
        results.push({
          ratio,
          acceptable: false,
          reason: 'quote_fetch_failed',
          error: partialError ? partialError.message : 'missing_quote',
        });
        hadError = true;
        continue;
      }

      const slippageInfo = expectedPrice
        ? this.calculateSlippage(partialQuote, expectedPrice)
        : null;
      const impactBps = this._impactBpsFromQuote(partialQuote, slippageInfo);
      const acceptable = Number.isFinite(impactBps) ? impactBps <= threshold : false;

      if (Number.isFinite(impactBps)) {
        maxObservedImpact = maxObservedImpact === null
          ? impactBps
          : Math.max(maxObservedImpact, impactBps);
      }

      if (!acceptable) {
        hadError = true;
      }

      results.push({
        ratio,
        amount: scaledAmount,
        inAmount: toNumber(partialQuote.inAmount) ?? scaledAmount,
        outAmount: toNumber(partialQuote.outAmount),
        impactBps,
        acceptable,
        routeLevels: this._extractRouteLevels(partialQuote),
      });
    }

    const valid = !hadError && Number.isFinite(maxObservedImpact) && maxObservedImpact <= threshold;

    return {
      valid,
      thresholdBps: threshold,
      maxImpactBps: maxObservedImpact,
      steps: results,
      reason: valid ? 'ok' : 'impact_exceeds_threshold',
    };
  }
}

module.exports = SlippageValidator;

