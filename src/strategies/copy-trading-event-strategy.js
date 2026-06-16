"use strict";

const CopyTradingStrategy = require("./copy-trading-strategy");
const {
  evaluateEventSignal,
  normalizeEventModelConfig,
} = require("../../utils/copy-trading-event-model");

function groupAcceptedEventDecisions(decisions) {
  const grouped = new Map();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!decision?.ok) continue;
    const side = String(decision?.features?.side || "").toLowerCase();
    if (side !== "long" && side !== "short") continue;
    if (!grouped.has(side)) {
      grouped.set(side, {
        side,
        support: 0,
        accepted: [],
        best: null,
      });
    }
    const bucket = grouped.get(side);
    const score = Number.isFinite(decision.score) ? Number(decision.score) : 0;
    const sizeFraction = Number.isFinite(decision.sizeFraction) ? Number(decision.sizeFraction) : 0;
    bucket.support += Math.max(0, score) * Math.max(0, sizeFraction);
    bucket.accepted.push(decision);
    if (!bucket.best || score > bucket.best.score) bucket.best = decision;
  }
  return Array.from(grouped.values()).sort((left, right) => {
    if (right.support !== left.support) return right.support - left.support;
    return (right.best?.score || 0) - (left.best?.score || 0);
  });
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

class CopyTradingEventStrategy extends CopyTradingStrategy {
  constructor(options = {}) {
    super(options);
    this.type = "copy-trading-event";
    this.signalFamily = "eventMeta";
    this.eventSignalProvider =
      typeof options.eventSignalProvider === "function" ? options.eventSignalProvider : null;
    this.eventConfig = normalizeEventModelConfig(options);
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

    if (!this.eventSignalProvider) {
      return { action: "hold", reason: "no_event_provider" };
    }

    const rawCandidates = this.eventSignalProvider({
      symbol: this.symbol,
      ts,
      price,
      ctx,
    });
    const candidates = Array.isArray(rawCandidates)
      ? rawCandidates
      : rawCandidates && typeof rawCandidates === "object"
        ? [rawCandidates]
        : [];

    if (!candidates.length) {
      return { action: "hold", reason: "no_event_signal" };
    }

    const decisions = candidates.map((event) => ({
      ...evaluateEventSignal({ event, config: this.eventConfig }),
      sourceEvent: event,
    }));
    const rankedAccepted = groupAcceptedEventDecisions(decisions);
    if (!rankedAccepted.length) {
      const rejected = decisions
        .filter((decision) => decision && typeof decision === "object")
        .sort((left, right) => (right?.score || 0) - (left?.score || 0));
      const topReject = rejected[0] || null;
      return {
        action: "hold",
        reason: `event_meta_${topReject?.reasons?.[0] || "rejected"}`,
        eventDecision: topReject,
        eventDecisions: decisions,
      };
    }

    const winner = rankedAccepted[0].best;
    const side = String(winner?.features?.side || "").toLowerCase();
    if (side !== "long" && side !== "short") {
      return {
        action: "hold",
        reason: "event_meta_invalid_side",
        eventDecision: winner || null,
        eventDecisions: decisions,
      };
    }

    this._pending = null;
    this._lastDirection = side === "long" ? 1 : -1;
    return {
      action: "open",
      side,
      confidence: Number.isFinite(winner?.score) ? winner.score : 0,
      reason: `event_meta_${winner?.decision || "accepted"}`,
      sizeFraction: Number.isFinite(winner?.sizeFraction) ? winner.sizeFraction : 1,
      strategyType: this.type,
      eventDecision: winner,
      eventDecisions: decisions,
      selectedEvent: winner?.features || null,
      entryGuard: {
        eventTs: firstFinite(winner?.sourceEvent?.ts, winner?.sourceEvent?.time, ts),
        referencePrice: firstFinite(
          winner?.sourceEvent?.price,
          winner?.sourceEvent?.nextEntryPx,
          winner?.sourceEvent?.prevEntryPx
        ),
        leaderWallet: winner?.sourceEvent?.wallet || winner?.sourceEvent?.user || null,
        eventType: winner?.sourceEvent?.eventType || winner?.features?.eventType || null,
      },
    };
  }

  shouldClose(position, currentPrice, ctx = {}) {
    const base = super.shouldClose(position, currentPrice, ctx);
    if (base?.shouldClose) return base;
    return { shouldClose: false, reason: base?.reason || "event_hold" };
  }
}

module.exports = CopyTradingEventStrategy;
