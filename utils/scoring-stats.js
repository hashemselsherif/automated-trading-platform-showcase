/**
 * Scoring Statistics Helper Module
 * 
 * Provides tail-risk aware statistical functions for the scoring system.
 * All functions handle small-N cases safely (return 0 when N < minSamples).
 */

// Minimum sample sizes for various calculations
const MIN_SAMPLES_BASIC = 3;
const MIN_SAMPLES_SKEW = 30;
const MIN_SAMPLES_KURTOSIS = 30;
const MIN_SAMPLES_CVAR = 20;

/**
 * Calculate mean of an array
 */
function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate sample standard deviation
 */
function std(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Calculate median of an array
 */
function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Calculate quantile (0-1)
 * @param {number[]} arr - Array of values
 * @param {number} q - Quantile (0-1), e.g., 0.05 for 5th percentile
 */
function quantile(arr, q) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  if (q <= 0) return Math.min(...arr);
  if (q >= 1) return Math.max(...arr);
  
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Calculate sample skewness (third standardized moment)
 * Positive skew = right tail (good for PnL)
 * Negative skew = left tail (bad for PnL - "steamroller" pattern)
 * 
 * Returns 0 for small samples to avoid false signals
 */
function skewness(arr, minSamples = MIN_SAMPLES_SKEW) {
  if (!Array.isArray(arr) || arr.length < minSamples) return 0;
  
  const n = arr.length;
  const m = mean(arr);
  const s = std(arr);
  if (s === 0) return 0;
  
  // Sample skewness with bias correction (Fisher's formula)
  const m3 = arr.reduce((sum, v) => sum + Math.pow((v - m) / s, 3), 0) / n;
  const adjustment = Math.sqrt(n * (n - 1)) / (n - 2);
  
  const result = m3 * adjustment;
  return Number.isFinite(result) ? result : 0;
}

/**
 * Calculate excess kurtosis (fourth standardized moment minus 3)
 * Positive excess kurtosis = fat tails (more extreme events)
 * Negative excess kurtosis = thin tails
 * Normal distribution has excess kurtosis = 0
 * 
 * Returns 0 for small samples
 */
function excessKurtosis(arr, minSamples = MIN_SAMPLES_KURTOSIS) {
  if (!Array.isArray(arr) || arr.length < minSamples) return 0;
  
  const n = arr.length;
  const m = mean(arr);
  const s = std(arr);
  if (s === 0) return 0;
  
  // Sample kurtosis with bias correction
  const m4 = arr.reduce((sum, v) => sum + Math.pow((v - m) / s, 4), 0) / n;
  
  // Fisher's correction for sample kurtosis
  const g2 = ((n + 1) * m4 - 3 * (n - 1)) * (n - 1) / ((n - 2) * (n - 3));
  const excessK = g2; // Already excess (subtracts 3 effectively)
  
  return Number.isFinite(excessK) ? excessK : 0;
}

/**
 * Calculate Expected Shortfall (CVaR) at given confidence level
 * ES@95% = mean of worst 5% of returns (negative number for losses)
 * 
 * This is a tail risk measure - more negative = worse tail risk
 * 
 * @param {number[]} returns - Array of per-trade returns (or PnL)
 * @param {number} alpha - Confidence level (0.95 = 95%, measures worst 5%)
 */
function expectedShortfall(returns, alpha = 0.95, minSamples = MIN_SAMPLES_CVAR) {
  if (!Array.isArray(returns) || returns.length < minSamples) return 0;
  
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = Math.max(1, Math.floor(sorted.length * (1 - alpha)));
  const tail = sorted.slice(0, cutoff);
  
  if (tail.length === 0) return 0;
  return mean(tail);
}

/**
 * Calculate what fraction of total value comes from top K items
 * Used to detect PnL concentration (fragility)
 * 
 * @param {number[]} values - Array of values (e.g., trade PnLs)
 * @param {number} k - Number of top items to consider
 * @returns {number} Fraction (0-1) of total contributed by top K
 */
function topKShare(values, k = 5) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  if (k <= 0) return 0;
  
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0; // Only meaningful for positive total
  
  // Sort descending by absolute value, but sum the actual values for top performers
  const sorted = [...values].sort((a, b) => b - a);
  const topK = sorted.slice(0, Math.min(k, sorted.length));
  const topSum = topK.reduce((a, b) => a + Math.max(0, b), 0); // Only count positive contributions
  
  return topSum / total;
}

/**
 * Compute all tail-risk metrics for a set of trade returns
 * Convenience function that bundles all tail metrics
 * 
 * @param {Object[]} trades - Array of trade objects with pnlUsd
 * @param {number} initialCapital - Starting capital for return calculations
 * @returns {Object} Tail risk metrics
 */
function computeTailMetrics(trades, initialCapital = 1000) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      pnlSkewness: 0,
      pnlExcessKurtosis: 0,
      cvar95: 0,
      worstTrade: 0,
      avgWin: 0,
      avgLoss: 0,
      lossTailToAvgWin: 0,
      pnlConcentrationTop5: 0,
    };
  }
  
  const pnls = trades.map(t => t.pnlUsd || t.totalPnlUsd || t.pnl || 0);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  
  // Per-trade returns (normalized by initial capital as proxy for position size)
  // This gives us comparable return percentages across different position sizes
  const returns = pnls.map(p => p / initialCapital);
  
  // Basic win/loss averages
  const avgWinVal = wins.length > 0 ? mean(wins) : 0;
  const avgLossVal = losses.length > 0 ? Math.abs(mean(losses)) : 0;
  
  // Tail risk metrics
  const skew = skewness(returns);
  const kurtosis = excessKurtosis(returns);
  const cvar = expectedShortfall(returns, 0.95);
  const worst = returns.length > 0 ? Math.min(...returns) : 0;
  
  // Loss tail to average win ratio (using return-normalized CVaR)
  // Higher = worse tail risk relative to typical wins
  const lossTailRatio = avgWinVal > 0 ? Math.abs(cvar * initialCapital) / avgWinVal : 0;
  
  // PnL concentration - fragility detector
  const concentration = topKShare(pnls, 5);
  
  return {
    pnlSkewness: Number.isFinite(skew) ? skew : 0,
    pnlExcessKurtosis: Number.isFinite(kurtosis) ? kurtosis : 0,
    cvar95: Number.isFinite(cvar) ? cvar : 0,
    worstTrade: Number.isFinite(worst) ? worst : 0,
    avgWin: Number.isFinite(avgWinVal) ? avgWinVal : 0,
    avgLoss: Number.isFinite(avgLossVal) ? avgLossVal : 0,
    lossTailToAvgWin: Number.isFinite(lossTailRatio) ? lossTailRatio : 0,
    pnlConcentrationTop5: Number.isFinite(concentration) ? concentration : 0,
  };
}

/**
 * Compute sample confidence multiplier dynamically based on trades/day
 * 
 * For multi-market strategies, trade frequency varies widely:
 * - High frequency: 2+ trades/day
 * - Medium: 0.5-2 trades/day  
 * - Low (swing): 0.1-0.5 trades/day
 * 
 * Formula: sqrt(tradesPerDay / targetTradesPerDay)
 * - tradesPerDay >= targetTradesPerDay -> 1.0 (full confidence)
 * - tradesPerDay = 0.1 * targetTradesPerDay -> ~0.32 (low confidence)
 * 
 * @param {number} trades - Total trade count
 * @param {number} days - Backtest duration in days
 * @param {number} targetTradesPerDay - Target frequency (default 0.5 = 1 trade per 2 days)
 * @returns {number} Sample confidence multiplier (0.25-1.0)
 */
function computeSampleConfidence(trades, days, targetTradesPerDay = 0.5) {
  if (!trades || !days || days <= 0) return 0.25;
  
  const tradesPerDay = trades / days;
  // Allow very low frequency (0.1 trades/day = 1 trade per 10 days)
  // Full confidence at targetTradesPerDay (default 0.5)
  const ratio = tradesPerDay / targetTradesPerDay;
  return clamp(Math.sqrt(ratio), 0.25, 1.0);
}

/**
 * Score metrics from a single fold/result using consistent scoring algorithm
 * Used for WFA fold scoring
 * 
 * @param {Object} m - Metrics object with sqn, sharpe, maxDD, pf, etc.
 * @param {Object} options - Optional config { days, targetTradesPerDay }
 * @returns {number} Score value
 */
function scoreFromMetrics(m, options = {}) {
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  
  const sqn = Number.isFinite(m.sqn) ? m.sqn : 0;
  const sharpe = Number.isFinite(m.sharpe) ? m.sharpe : 0;
  const recoveryFactor = Number.isFinite(m.recoveryFactor) ? m.recoveryFactor : 0;
  const dd = Number.isFinite(m.maxDD) ? m.maxDD : (Number.isFinite(m.maxDrawdown) ? m.maxDrawdown : 0.40);
  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor : (Number.isFinite(m.pf) ? m.pf : 1);
  const trades = m.trades || m.count || m.totalTrades || 0;
  const pnl = m.pnl || m.pnlUsd || m.totalPnL || 0;
  const days = m.days || options.days || 180; // Default to 180 days if not provided
  const targetTradesPerDay = options.targetTradesPerDay || 0.5;
  
  // Convert percentage DD to decimal if needed
  const ddDecimal = dd > 1 ? dd / 100 : dd;

  // Hard gate: drawdowns above 20% are considered non-viable.
  // Return a negative score so downstream ranking deprioritizes these configs.
  if (ddDecimal > 0.20) {
    const base = Math.max(Math.abs(sqn) / 2, 0.5);
    return -base;
  }
  
  // SQN base (primary metric)
  const sqnBase = sqn / 2.0;
  
  // Sharpe multiplier (log-dampened)
  const sharpeMultiplier = sharpe >= 0
    ? clamp(1.0 + Math.log1p(sharpe) * 0.3, 0.7, 1.6)
    : Math.max(0.5, 1.0 + sharpe * 0.1);
  
  // RF multiplier (log-dampened)
  const rfMultiplier = clamp(0.8 + Math.log1p(Math.max(0, recoveryFactor)) / 2, 0.6, 1.5);
  
  // DD penalty (exponential)
  const ddExcess = Math.max(0, ddDecimal - 0.10);
  const ddPenalty = clamp(Math.exp(-6 * ddExcess), 0.02, 1.0);
  
  // PF multiplier (log-dampened)
  const pfMultiplier = pf >= 1
    ? clamp(Math.log1p(pf), 0.7, 1.6)
    : clamp(pf, 0.1, 1.0);
  
  // Sample confidence - dynamic based on trades/day
  const sampleMult = computeSampleConfidence(trades, days, targetTradesPerDay);
  
  const score = sqnBase * sharpeMultiplier * rfMultiplier * ddPenalty * pfMultiplier * sampleMult;
  
  return Number.isFinite(score) ? score : 0;
}

/**
 * Compute WFA aggregate score from fold results
 * Uses median + worst-fold + dispersion penalties
 * 
 * @param {Object[]} folds - Array of fold result objects
 * @returns {Object} WFA score components and final score
 */
function computeWfaScore(folds) {
  if (!Array.isArray(folds) || folds.length < 3) {
    return { 
      finalScore: 0, 
      medianFoldScore: 0, 
      worstFoldScore: 0, 
      dispersionPenalty: 1, 
      worstPenalty: 1,
      foldScores: [],
      isValid: false,
    };
  }
  
  // Score each fold
  const foldScores = folds.map(f => {
    const m = {
      sqn: f.oosSqn || f.testSqn || f.sqn || 0,
      sharpe: f.oosSharpe || f.testSharpe || f.sharpe || 0,
      recoveryFactor: f.oosRecoveryFactor || f.recoveryFactor || 0,
      maxDD: f.oosMaxDrawdown || f.testMaxDD || f.maxDD || 0.40,
      profitFactor: f.oosProfitFactor || f.profitFactor || 1,
      trades: f.oosTrades || f.testTrades || f.trades || 0,
      pnl: f.oosPnL || f.testPnL || f.pnl || 0,
    };
    return scoreFromMetrics(m);
  });
  
  const medianScore = median(foldScores);
  const worstScore = Math.min(...foldScores);
  const meanScore = mean(foldScores);
  const stdScore = std(foldScores);
  
  // Dispersion penalty: high variance across folds = overfit/unstable
  const dispersion = Math.abs(meanScore) > 1e-9 ? stdScore / Math.abs(meanScore) : 0;
  const dispersionPenalty = clamp(1 - dispersion, 0.4, 1.0);
  
  // Worst-fold penalty: if worst is too negative relative to median, punish hard
  const worstPenalty = medianScore !== 0 ? clamp(worstScore / medianScore, 0.25, 1.0) : 0.5;
  
  // Final WFA score
  const finalScore = medianScore * dispersionPenalty * worstPenalty;
  
  return {
    finalScore: Number.isFinite(finalScore) ? finalScore : 0,
    medianFoldScore: medianScore,
    worstFoldScore: worstScore,
    dispersionPenalty,
    worstPenalty,
    foldScores,
    isValid: true,
  };
}

// Utility: clamp helper exported for convenience
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

module.exports = {
  // Basic stats
  mean,
  std,
  median,
  quantile,
  
  // Higher moments
  skewness,
  excessKurtosis,
  
  // Tail risk
  expectedShortfall,
  topKShare,
  computeTailMetrics,
  
  // Scoring helpers
  computeSampleConfidence,
  scoreFromMetrics,
  computeWfaScore,
  
  // Utility
  clamp,
  
  // Constants for tuning
  MIN_SAMPLES_BASIC,
  MIN_SAMPLES_SKEW,
  MIN_SAMPLES_KURTOSIS,
  MIN_SAMPLES_CVAR,
};
