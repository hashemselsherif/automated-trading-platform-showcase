"use strict";

const CopyTradingStrategy = require("./copy-trading-strategy");
const {
  normalizeMetaDecisionConfig,
  evaluateMetaSignal,
} = require("./utils/copy-trading-meta-model");

class CopyTradingMetaStrategy extends CopyTradingStrategy {
  constructor(options = {}) {
    super(options);
    this.type = "copy-trading-meta";
    this.signalFamily = "meta";
    this.metaConfig = normalizeMetaDecisionConfig(options);
  }

  getSignal(price, _positions = [], _isBacktest = false, _barIndex = 0, ctx = {}) {
    const ts = Number.isFinite(ctx.ts) ? ctx.ts : Date.now();
    if (this.signalIntervalMs > 0 && ts - this._lastSignalTs < this.signalIntervalMs) {
      return { action: "hold", reason: "throttled" };
    }
    if (this._isCircuitBreakerActive(ts)) {
      return {
        action: "hold",
        reason: "circuit_breaker_active",
        cooldownRemaining: this.circuitBreakerUntil ? this.circuitBreakerUntil - ts : null,
      };
    }
    this._lastSignalTs = ts;
    const consensus = this._getConsensus(ts);
    if (!this._isConsensusUsable(consensus)) {
      return {
        action: "hold",
        reason: consensus ? "consensus_not_ok" : "no_consensus",
        consensusMeta: consensus?.meta || null,
      };
    }

    const absTop = Math.abs(consensus.cTop);
    if (!(absTop > 0)) {
      this._pending = null;
      return { action: "hold", reason: "no_edge" };
    }

    const side = consensus.cTop > 0 ? "long" : "short";
    const enterThreshold = this._getEnterThreshold(side);
    if (absTop < enterThreshold) {
      this._pending = null;
      return { action: "hold", reason: "no_edge" };
    }

    const gate = this._evaluateSignalGate({
      side,
      price,
      consensus,
      leaders: consensus.kTop,
      allowEliteLeaderBypass: true,
    });
    if (!gate.ok) {
      return {
        action: "hold",
        reason: gate.reason,
        consensusMeta: consensus?.meta || null,
        regimeMeta: gate.regime ?? null,
      };
    }

    const decision = evaluateMetaSignal({
      side,
      consensus,
      regime: gate.regime,
      config: this.metaConfig,
    });
    if (!decision.ok) {
      this._pending = null;
      return {
        action: "hold",
        reason: `meta_${decision.reasons[0] || "rejected"}`,
        consensusMeta: consensus?.meta || null,
        regimeMeta: gate.regime ?? null,
        metaDecision: decision,
      };
    }

    const signal = this._confirmedEntry(side, ts, {
      reason: `meta_${decision.decision}`,
      confidence: decision.score,
      consensus,
    });
    if (signal && signal.action === "open") {
      signal.sizeFraction = decision.sizeFraction;
      signal.metaDecision = decision;
    }
    return signal;
  }

  shouldClose(position, currentPrice, ctx = {}) {
    const base = super.shouldClose(position, currentPrice, ctx);
    if (base?.shouldClose) return base;

    const ts = Number.isFinite(ctx.ts) ? ctx.ts : Date.now();
    const price = Number.isFinite(ctx.price) ? Number(ctx.price) : currentPrice;
    const consensus = this._getConsensus(ts);
    if (!consensus) return { shouldClose: false, reason: "no_consensus" };

    const posSide = String(position?.side || "").toLowerCase();
    if (posSide !== "long" && posSide !== "short") return { shouldClose: false };

    const gate = this._evaluateSignalGate({
      side: posSide,
      price,
      consensus,
      leaders: consensus.kTop,
      allowEliteLeaderBypass: true,
    });
    if (!gate.ok) return { shouldClose: true, reason: gate.reason };

    const decision = evaluateMetaSignal({
      side: posSide,
      consensus,
      regime: gate.regime,
      config: this.metaConfig,
    });
    if (!decision.ok || decision.score < this.metaConfig.exitScoreMin) {
      return { shouldClose: true, reason: "meta_filter_exit", metaDecision: decision };
    }

    return { shouldClose: false };
  }
}

module.exports = CopyTradingMetaStrategy;
