/**
 * Representative strategy excerpt adapted from the live strategy layer.
 * The production system runs multiple strategies, each with its own
 * thresholds and filters. This sample shows the shape of the gating logic.
 */

class StrategySignalEngine {
  constructor(config = {}) {
    this.config = {
      adxMin: config.adxMin ?? 20,
      rsiLong: config.rsiLong ?? 60,
      rsiShort: config.rsiShort ?? 40,
      minConfidence: config.minConfidence ?? 1.0,
    };
  }

  getSignal(state) {
    if (!state.ready) {
      return { action: "hold", reason: "warmup_incomplete" };
    }

    if (state.hasPosition) {
      return this.getExitSignal(state);
    }

    const longGate = this.passesLongGate(state);
    const shortGate = this.passesShortGate(state);

    if (!longGate && !shortGate) {
      return { action: "hold", reason: "entry_gates_blocked" };
    }

    const side = longGate ? "long" : "short";
    const confidence = this.scoreSignal(state, side);

    if (confidence < this.config.minConfidence) {
      return { action: "hold", reason: "low_confidence" };
    }

    return {
      action: "open",
      side,
      confidence,
      reason: `${side}_confluence`,
    };
  }

  getExitSignal(state) {
    if (state.stopLossHit) return { action: "close", reason: "stop_loss" };
    if (state.takeProfitHit) return { action: "close", reason: "take_profit" };
    if (state.adxWeakens) return { action: "close", reason: "trend_decay" };
    if (state.timeStopHit) return { action: "close", reason: "time_stop" };
    return { action: "hold", reason: "position_active" };
  }

  passesLongGate(state) {
    return (
      state.emaFastAboveSlow &&
      state.adx >= this.config.adxMin &&
      state.rsi >= this.config.rsiLong &&
      state.donchianBreakout &&
      state.volumeOk &&
      state.volatilityOk &&
      state.higherTimeframeAligned &&
      !state.inCooldown
    );
  }

  passesShortGate(state) {
    return (
      state.emaFastBelowSlow &&
      state.adx >= this.config.adxMin &&
      state.rsi <= this.config.rsiShort &&
      state.donchianBreakdown &&
      state.volumeOk &&
      state.volatilityOk &&
      state.higherTimeframeAligned &&
      !state.inCooldown
    );
  }

  scoreSignal(state, side) {
    const direction = side === "long" ? 1 : -1;
    const trendScore = Math.max(0, (state.adx - this.config.adxMin) / 10);
    const momentumScore = direction === 1
      ? Math.max(0, (state.rsi - this.config.rsiLong) / 10)
      : Math.max(0, (this.config.rsiShort - state.rsi) / 10);
    const volatilityScore = state.atrPct >= 0.0035 ? 0.5 : 0;
    const volumeScore = state.volumeSpike ? 0.5 : 0;
    return Number((trendScore + momentumScore + volatilityScore + volumeScore).toFixed(2));
  }
}

module.exports = StrategySignalEngine;
