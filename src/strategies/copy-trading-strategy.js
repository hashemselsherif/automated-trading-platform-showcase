/**
 * CopyTradingStrategy (Skeleton)
 *
 * Purpose:
 * - Provide a strategy-shaped surface area (getSignal/shouldClose/update/updateTick)
 * - Allow simulation of strategy effectiveness BEFORE wiring to Hyperliquid WS.
 *
 * This strategy consumes a consensus provider:
 *   consensusProvider({ symbol, ts }) -> { cTop, kTop, cWorst, kWorst }
 *
 * Later, we can replace the consensus provider with HyperliquidLeaderTracker (WS-first)
 * without changing the rest of the bot integration.
 */

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

class CopyTradingStrategy {
  constructor(options = {}) {
    this.type = "copy-trading";

    const rawSymbol = String(options.symbol || options.market || "BTC");
    this.symbol = rawSymbol.replace(/-PERP$/i, "").toUpperCase();
    this.consensusProvider =
      typeof options.consensusProvider === "function" ? options.consensusProvider : null;

    // Thresholds (defaults tuned for simulation; final values will come from env)
    this.enterThreshold = Number.isFinite(options.enterThreshold) ? options.enterThreshold : 0.65;
    this.exitThreshold = Number.isFinite(options.exitThreshold) ? options.exitThreshold : 0.55;
    this.minLeaders = Number.isFinite(options.minLeaders) ? options.minLeaders : 7;
    this.minEffectiveN = Math.max(0, num(options.minEffectiveN, 0));
    this.confirmMs = Number.isFinite(options.confirmMs) ? options.confirmMs : 60_000;
    this.signalIntervalMs = Number.isFinite(options.signalIntervalMs)
      ? options.signalIntervalMs
      : 0;
    this.longEnterThreshold = clamp(num(options.longEnterThreshold, this.enterThreshold), 0, 1);
    this.shortEnterThreshold = clamp(num(options.shortEnterThreshold, this.enterThreshold), 0, 1);
    this.longExitThreshold = clamp(num(options.longExitThreshold, this.exitThreshold), 0, 1);
    this.shortExitThreshold = clamp(num(options.shortExitThreshold, this.exitThreshold), 0, 1);
    this.longMinLeaders = Math.max(1, Math.floor(num(options.longMinLeaders, this.minLeaders)));
    this.shortMinLeaders = Math.max(1, Math.floor(num(options.shortMinLeaders, this.minLeaders)));
    this.longMinEffectiveN = Math.max(0, num(options.longMinEffectiveN, this.minEffectiveN));
    this.shortMinEffectiveN = Math.max(0, num(options.shortMinEffectiveN, this.minEffectiveN));
    this.maxActiveWeightShare = clamp(
      num(options.signalMaxActiveWeightShare, num(options.maxActiveWeightShare, 1)),
      0,
      1
    );
    this.longMaxActiveWeightShare = clamp(
      num(
        options.longSignalMaxActiveWeightShare,
        num(options.longMaxActiveWeightShare, this.maxActiveWeightShare)
      ),
      0,
      1
    );
    this.shortMaxActiveWeightShare = clamp(
      num(
        options.shortSignalMaxActiveWeightShare,
        num(options.shortMaxActiveWeightShare, this.maxActiveWeightShare)
      ),
      0,
      1
    );
    this.maxClusterWeightShare = clamp(
      num(options.signalMaxClusterWeightShare, num(options.maxClusterWeightShare, 1)),
      0,
      1
    );
    this.longMaxClusterWeightShare = clamp(
      num(
        options.longSignalMaxClusterWeightShare,
        num(options.longMaxClusterWeightShare, this.maxClusterWeightShare)
      ),
      0,
      1
    );
    this.shortMaxClusterWeightShare = clamp(
      num(
        options.shortSignalMaxClusterWeightShare,
        num(options.shortMaxClusterWeightShare, this.maxClusterWeightShare)
      ),
      0,
      1
    );
    this.maxLeaderFamilyWeightShare = clamp(num(options.maxLeaderFamilyWeightShare, 1), 0, 1);
    this.longMaxLeaderFamilyWeightShare = clamp(
      num(options.longMaxLeaderFamilyWeightShare, this.maxLeaderFamilyWeightShare),
      0,
      1
    );
    this.shortMaxLeaderFamilyWeightShare = clamp(
      num(options.shortMaxLeaderFamilyWeightShare, this.maxLeaderFamilyWeightShare),
      0,
      1
    );
    this.regimeFilterEnabled = options.regimeFilterEnabled === true;
    this.regimeRequireReady = options.regimeRequireReady !== false;
    this.regimeLookbackBars = Math.max(5, Math.floor(num(options.regimeLookbackBars, 24)));
    this.regimeMinTrendStrength = clamp(num(options.regimeMinTrendStrength, 0.15), 0, 1);
    this.longMinTrendReturnPct = Math.max(0, num(options.longMinTrendReturnPct, 0));
    this.shortMinTrendReturnPct = Math.max(0, num(options.shortMinTrendReturnPct, 0));
    this.regimeMinVolPct = Math.max(0, num(options.regimeMinVolPct, 0));
    this.regimeMaxVolPct = Math.max(
      this.regimeMinVolPct,
      num(options.regimeMaxVolPct, Number.POSITIVE_INFINITY)
    );
    this.maxHoldHours = Math.max(0, num(options.maxHoldHours, 0));
    this.maxHoldMs = this.maxHoldHours > 0 ? this.maxHoldHours * 3_600_000 : 0;
    this.adverseMoveStopPercent = Math.max(0, num(options.adverseMoveStopPercent, 0));
    this.takeProfitPercent = Math.max(0, num(options.takeProfitPercent, 0));
    this.trailingStopPercent = Math.max(0, num(options.trailingStopPercent, 0));
    this.trailActivateAfterProfitPercent = Math.max(
      0,
      num(options.trailActivateAfterProfitPercent, 0)
    );
    this.breakevenAfterHours = Math.max(0, num(options.breakevenAfterHours, 0));
    this.breakevenAfterMs = this.breakevenAfterHours > 0 ? this.breakevenAfterHours * 3_600_000 : 0;
    this.followerOwnedExitMode = bool(options.followerOwnedExitMode, false);
    this.atrPeriod = Number.isFinite(options.atrPeriod) ? options.atrPeriod : 14;
    this.atrStopMultiplier = Number.isFinite(options.atrStopMultiplier)
      ? options.atrStopMultiplier
      : 2.5;
    this.hardStopEnabled = options.hardStopEnabled === true;
    this.hardStopPercent = Number.isFinite(options.hardStopPercent) ? options.hardStopPercent : 0;
    this.hardStopAtrMult = Number.isFinite(options.hardStopAtrMult) ? options.hardStopAtrMult : 0;
    this.enableAtrTrail = options.enableAtrTrail === true;
    this.trailAtrMult = Number.isFinite(options.trailAtrMult) ? options.trailAtrMult : 1.5;
    this.circuitBreakerEnabled = options.circuitBreakerEnabled !== false;
    this.maxConsecutiveLosses = Number.isFinite(options.maxConsecutiveLosses)
      ? options.maxConsecutiveLosses
      : 3;
    this.circuitBreakerCooldownMs = Number.isFinite(options.circuitBreakerCooldownMs)
      ? options.circuitBreakerCooldownMs
      : 180000;

    this.fadeWorstEnabled = options.fadeWorstEnabled === true;
    this.safeModeOnStale = options.safeModeOnStale !== false;

    // Simple hysteresis state to prevent flicker
    this._pending = null; // { side: 'long'|'short', startedAt }
    this._lastDirection = 0; // -1,0,+1
    this._lastSignalTs = 0;
    this._prevClose = null;
    this._trueRanges = [];
    this._closeHistory = [];
    this.atr = null;
    this.consecutiveLosses = 0;
    this.circuitBreakerActive = false;
    this.circuitBreakerUntil = null;
    this._maxCloseHistory = Math.max(this.regimeLookbackBars + 5, this.atrPeriod + 5);
    this.cfg = {
      atrPeriod: this.atrPeriod,
      atrStopMultiplier: this.atrStopMultiplier,
      hardStopEnabled: this.hardStopEnabled,
      hardStopPercent: this.hardStopPercent,
      hardStopAtrMult: this.hardStopAtrMult,
      enableAtrTrail: this.enableAtrTrail,
      trailAtrMult: this.trailAtrMult,
      trailingStopPercent: this.trailingStopPercent,
      trailActivateAfterProfitPercent: this.trailActivateAfterProfitPercent,
      breakevenAfterHours: this.breakevenAfterHours,
      circuitBreakerEnabled: this.circuitBreakerEnabled,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      circuitBreakerCooldownMs: this.circuitBreakerCooldownMs,
    };
  }

  update(bar) {
    if (!bar) return;
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return;
    const prevClose = Number.isFinite(this._prevClose) ? this._prevClose : close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    this._trueRanges.push(tr);
    if (this._trueRanges.length > this.atrPeriod * 2) this._trueRanges.shift();
    if (this._trueRanges.length >= this.atrPeriod) {
      if (this.atr == null) {
        const recent = this._trueRanges.slice(-this.atrPeriod);
        this.atr = recent.reduce((a, b) => a + b, 0) / recent.length;
      } else {
        this.atr = (this.atr * (this.atrPeriod - 1) + tr) / this.atrPeriod;
      }
    }
    this._prevClose = close;
    this._closeHistory.push(close);
    if (this._closeHistory.length > this._maxCloseHistory) this._closeHistory.shift();
  }
  updateTick(_tick) {}

  /**
   * Return signal object or { action: 'hold' }.
   * This mirrors other strategies' shape in this repo.
   */
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
    const c = this._getConsensus(ts);

    if (!this._isConsensusUsable(c)) {
      return {
        action: "hold",
        reason: c ? "consensus_not_ok" : "no_consensus",
        consensusMeta: c?.meta || null,
      };
    }

    const { cTop, kTop, cWorst, kWorst } = c;
    const absTop = Math.abs(cTop);
    if (absTop > 0) {
      const side = cTop > 0 ? "long" : "short";
      const enterThreshold = this._getEnterThreshold(side);
      if (absTop >= enterThreshold) {
        const gate = this._evaluateSignalGate({
          side,
          price,
          consensus: c,
          leaders: kTop,
          allowEliteLeaderBypass: true,
        });
        if (gate.ok) {
          return this._confirmedEntry(side, ts, {
            reason: c?.meta?.eliteUsed === true ? "follow_top_elite" : "follow_top",
            confidence: absTop,
            consensus: c,
          });
        }
        return {
          action: "hold",
          reason: gate.reason,
          consensusMeta: c?.meta || null,
          regimeMeta: gate.regime ?? null,
        };
      }
    }

    const weakestExitThreshold = Math.min(this.longExitThreshold, this.shortExitThreshold);

    // Fade worst only when top weak/flat
    if (this.fadeWorstEnabled && absTop < weakestExitThreshold && Math.abs(cWorst) > 0) {
      const side = cWorst > 0 ? "short" : "long";
      const enterThreshold = this._getEnterThreshold(side);
      if (kWorst >= this._getMinLeaders(side) && Math.abs(cWorst) >= enterThreshold) {
        const gate = this._evaluateSignalGate({
          side,
          price,
          consensus: c,
          leaders: kWorst,
          allowEliteLeaderBypass: false,
          skipConcentrationGate: true,
        });
        if (gate.ok) {
          return this._confirmedEntry(side, ts, {
            reason: "fade_worst",
            confidence: Math.abs(cWorst),
            consensus: c,
          });
        }
        return {
          action: "hold",
          reason: gate.reason,
          consensusMeta: c?.meta || null,
          regimeMeta: gate.regime ?? null,
        };
      }
    }

    // Otherwise hold
    this._pending = null;
    return { action: "hold", reason: "no_edge" };
  }

  /**
   * Should we close an existing position?
   * Return { shouldClose: boolean, reason?: string }
   */
  shouldClose(position, _currentPrice, ctx = {}) {
    const ts = Number.isFinite(ctx.ts) ? ctx.ts : Date.now();
    const price = Number.isFinite(ctx.price) ? Number(ctx.price) : _currentPrice;
    if (position && Number.isFinite(price) && price > 0) {
      const entry = Number(position.entryPrice);
      const side = String(position.side || "").toLowerCase();
      const lev = Number(position.leverage);
      const leverage = Number.isFinite(lev) && lev > 0 ? lev : 1;
      const openTime = Number(position.openTime);
      if (this.maxHoldMs > 0 && Number.isFinite(openTime) && ts - openTime >= this.maxHoldMs) {
        return { shouldClose: true, reason: "copy_time_stop" };
      }
      if (this.adverseMoveStopPercent > 0 && entry > 0) {
        const pricePct = this.adverseMoveStopPercent / 100;
        if (side === "long" && price <= entry * (1 - pricePct)) {
          return { shouldClose: true, reason: "copy_adverse_move_stop" };
        }
        if (side === "short" && price >= entry * (1 + pricePct)) {
          return { shouldClose: true, reason: "copy_adverse_move_stop" };
        }
      }
      const takeProfitPct =
        Number.isFinite(position.takeProfitPercentOverride) &&
        position.takeProfitPercentOverride > 0
          ? Number(position.takeProfitPercentOverride)
          : this.takeProfitPercent;
      if (Number.isFinite(takeProfitPct) && takeProfitPct > 0 && entry > 0) {
        const pricePct = takeProfitPct / 100 / leverage;
        if (side === "long" && price >= entry * (1 + pricePct)) {
          return { shouldClose: true, reason: "copy_take_profit_percent" };
        }
        if (side === "short" && price <= entry * (1 - pricePct)) {
          return { shouldClose: true, reason: "copy_take_profit_percent" };
        }
      }
      if (
        this.breakevenAfterMs > 0 &&
        Number.isFinite(openTime) &&
        ts - openTime >= this.breakevenAfterMs &&
        entry > 0
      ) {
        const favorableReached =
          side === "long"
            ? Number.isFinite(position.highWaterMark) && position.highWaterMark > entry
            : side === "short"
              ? Number.isFinite(position.lowWaterMark) && position.lowWaterMark < entry
              : false;
        if (favorableReached) {
          if (side === "long" && price <= entry) {
            return { shouldClose: true, reason: "copy_breakeven_stop" };
          }
          if (side === "short" && price >= entry) {
            return { shouldClose: true, reason: "copy_breakeven_stop" };
          }
        }
      }
      const hardStopPct =
        Number.isFinite(position.stopLossPercentOverride) && position.stopLossPercentOverride > 0
          ? Number(position.stopLossPercentOverride)
          : this.hardStopPercent;
      if (this.hardStopEnabled && Number.isFinite(hardStopPct) && hardStopPct > 0 && entry > 0) {
        const pricePct = hardStopPct / 100 / leverage;
        if (side === "long" && price <= entry * (1 - pricePct)) {
          return { shouldClose: true, reason: "copy_hard_stop_percent" };
        }
        if (side === "short" && price >= entry * (1 + pricePct)) {
          return { shouldClose: true, reason: "copy_hard_stop_percent" };
        }
      }

      const atrMult =
        Number.isFinite(position.hardStopAtrMultOverride) && position.hardStopAtrMultOverride > 0
          ? Number(position.hardStopAtrMultOverride)
          : this.hardStopAtrMult;
      const atrAtEntry = Number(position.atrAtEntry);
      const atr = Number.isFinite(atrAtEntry) && atrAtEntry > 0 ? atrAtEntry : this.atr;
      if (Number.isFinite(atrMult) && atrMult > 0 && Number.isFinite(atr) && atr > 0 && entry > 0) {
        const adverse = side === "short" ? price - entry : entry - price;
        if (Number.isFinite(adverse) && adverse >= atr * atrMult) {
          return { shouldClose: true, reason: "copy_hard_stop_atr" };
        }
      }

      const trailingStopPct = Number(
        Number.isFinite(position.trailingStopPercentOverride) &&
          position.trailingStopPercentOverride > 0
          ? position.trailingStopPercentOverride
          : this.trailingStopPercent
      );
      const trailActivatePct = Number(
        Number.isFinite(position.trailActivateAfterProfitPercentOverride) &&
          position.trailActivateAfterProfitPercentOverride > 0
          ? position.trailActivateAfterProfitPercentOverride
          : this.trailActivateAfterProfitPercent
      );
      if (Number.isFinite(trailingStopPct) && trailingStopPct > 0 && entry > 0) {
        const activationPricePct = trailActivatePct > 0 ? trailActivatePct / 100 / leverage : 0;
        const trailingPricePct = trailingStopPct / 100 / leverage;
        const trailActivated =
          side === "long"
            ? Number.isFinite(position.highWaterMark) &&
              position.highWaterMark >= entry * (1 + activationPricePct)
            : side === "short"
              ? Number.isFinite(position.lowWaterMark) &&
                position.lowWaterMark <= entry * (1 - activationPricePct)
              : false;
        if (trailActivated) {
          if (
            side === "long" &&
            Number.isFinite(position.highWaterMark) &&
            price <= position.highWaterMark * (1 - trailingPricePct)
          ) {
            return { shouldClose: true, reason: "copy_trailing_stop" };
          }
          if (
            side === "short" &&
            Number.isFinite(position.lowWaterMark) &&
            price >= position.lowWaterMark * (1 + trailingPricePct)
          ) {
            return { shouldClose: true, reason: "copy_trailing_stop" };
          }
        }
      }

      if (this.enableAtrTrail && Number.isFinite(this.atr) && this.atr > 0) {
        const activationPricePct =
          this.trailActivateAfterProfitPercent > 0
            ? this.trailActivateAfterProfitPercent / 100 / leverage
            : 0;
        const trailActivated =
          side === "long"
            ? Number.isFinite(position.highWaterMark) &&
              position.highWaterMark >= entry * (1 + activationPricePct)
            : side === "short"
              ? Number.isFinite(position.lowWaterMark) &&
                position.lowWaterMark <= entry * (1 - activationPricePct)
              : false;
        if (trailActivated) {
          const trailDistance = this.atr * this.trailAtrMult;
          if (side === "long" && Number.isFinite(position.highWaterMark)) {
            if (price <= position.highWaterMark - trailDistance) {
              return { shouldClose: true, reason: "copy_atr_trail" };
            }
          }
          if (side === "short" && Number.isFinite(position.lowWaterMark)) {
            if (price >= position.lowWaterMark + trailDistance) {
              return { shouldClose: true, reason: "copy_atr_trail" };
            }
          }
        }
      }
    }
    if (this.followerOwnedExitMode) {
      return { shouldClose: false, reason: "follower_owned_exit_hold" };
    }
    const c = this._getConsensus(ts);
    if (!c) {
      return { shouldClose: false, reason: "no_consensus" };
    }

    const posSide = String(position?.side || "").toLowerCase();
    if (posSide === "long" || posSide === "short") {
      const gate = this._evaluateSignalGate({
        side: posSide,
        price,
        consensus: c,
        leaders: c.kTop,
        allowEliteLeaderBypass: true,
      });
      if (!gate.ok) {
        return { shouldClose: true, reason: gate.reason };
      }
    }

    const absTop = Math.abs(c.cTop);
    const exitThreshold = this._getExitThreshold(posSide);

    // Exit when top signal weak/flat (hysteresis)
    if (absTop < exitThreshold) {
      return { shouldClose: true, reason: "consensus_weak" };
    }

    // Exit if signal flips hard against our side
    const dir = c.cTop > 0 ? 1 : c.cTop < 0 ? -1 : 0;
    const flipEnterThreshold = this._getEnterThreshold(dir > 0 ? "long" : "short");
    if (posSide === "long" && dir < 0 && absTop >= flipEnterThreshold) {
      return { shouldClose: true, reason: "flip_to_short" };
    }
    if (posSide === "short" && dir > 0 && absTop >= flipEnterThreshold) {
      return { shouldClose: true, reason: "flip_to_long" };
    }

    return { shouldClose: false };
  }

  _isCircuitBreakerActive(ts = Date.now()) {
    if (!this.circuitBreakerEnabled) return false;
    if (!this.circuitBreakerActive) return false;
    if (ts >= this.circuitBreakerUntil) {
      this.circuitBreakerActive = false;
      this.circuitBreakerUntil = null;
      this.consecutiveLosses = 0;
      return false;
    }
    return true;
  }

  recordTrade(trade = {}) {
    if (!this.circuitBreakerEnabled) return;
    const ts = Number.isFinite(trade.ts)
      ? Number(trade.ts)
      : Number.isFinite(trade.exitTime)
        ? Number(trade.exitTime)
        : Date.now();
    const pnl = Number.isFinite(trade.pnlUsd)
      ? trade.pnlUsd
      : Number.isFinite(trade.pnl)
        ? trade.pnl
        : null;
    if (!Number.isFinite(pnl)) return;

    if (pnl < 0) {
      this.consecutiveLosses += 1;
      if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
        this.circuitBreakerActive = true;
        this.circuitBreakerUntil = ts + this.circuitBreakerCooldownMs;
      }
    } else {
      this.consecutiveLosses = 0;
    }
  }

  _getConsensus(ts) {
    if (!this.consensusProvider) return null;
    const out = this.consensusProvider({ symbol: this.symbol, ts });
    if (!out || typeof out !== "object") return null;
    return {
      cTop: Number(out.cTop ?? out.C_top ?? 0) || 0,
      kTop: Number(out.kTop ?? out.K_top ?? 0) || 0,
      cWorst: Number(out.cWorst ?? out.C_worst ?? 0) || 0,
      kWorst: Number(out.kWorst ?? out.K_worst ?? 0) || 0,
      meta: out.meta || null,
    };
  }

  _isConsensusUsable(consensus) {
    if (!consensus || typeof consensus !== "object") return false;
    if (!this.safeModeOnStale) return true;
    if (consensus.meta && consensus.meta.ok === false) return false;
    return true;
  }

  _getEnterThreshold(side) {
    return side === "short" ? this.shortEnterThreshold : this.longEnterThreshold;
  }

  _getExitThreshold(side) {
    return side === "short" ? this.shortExitThreshold : this.longExitThreshold;
  }

  _getMinLeaders(side) {
    return side === "short" ? this.shortMinLeaders : this.longMinLeaders;
  }

  _getMinEffectiveN(side) {
    return side === "short" ? this.shortMinEffectiveN : this.longMinEffectiveN;
  }

  _getMaxActiveWeightShare(side) {
    return side === "short" ? this.shortMaxActiveWeightShare : this.longMaxActiveWeightShare;
  }

  _getMaxClusterWeightShare(side) {
    return side === "short" ? this.shortMaxClusterWeightShare : this.longMaxClusterWeightShare;
  }

  _getMaxLeaderFamilyWeightShare(side) {
    return side === "short"
      ? this.shortMaxLeaderFamilyWeightShare
      : this.longMaxLeaderFamilyWeightShare;
  }

  _normalizeConsensusMeta(consensus, leadersOverride = null) {
    const meta = consensus?.meta && typeof consensus.meta === "object" ? consensus.meta : {};
    return {
      eliteUsed: meta.eliteUsed === true,
      contributors: Number.isFinite(leadersOverride)
        ? Math.max(0, Number(leadersOverride))
        : Math.max(0, num(meta.contributors, num(consensus?.kTop, 0))),
      effectiveN: Math.max(0, num(meta.effectiveN, 0)),
      maxWeightShare: meta.maxWeightShare == null ? null : clamp(num(meta.maxWeightShare, 0), 0, 1),
      maxClusterWeightShare:
        meta.maxClusterWeightShare == null ? null : clamp(num(meta.maxClusterWeightShare, 0), 0, 1),
      maxFamilyWeightShare:
        meta.maxFamilyWeightShare == null ? null : clamp(num(meta.maxFamilyWeightShare, 0), 0, 1),
    };
  }

  _computeRegimeMetrics(price) {
    const closes = this._closeHistory;
    const lookback = Math.max(5, this.regimeLookbackBars);
    const px =
      Number.isFinite(price) && price > 0
        ? price
        : closes.length
          ? closes[closes.length - 1]
          : null;
    const atrPct =
      Number.isFinite(this.atr) && Number.isFinite(px) && px > 0 ? (this.atr / px) * 100 : null;
    if (closes.length < lookback + 1) {
      return {
        ready: false,
        lookbackBars: lookback,
        trendReturnPct: null,
        trendStrength: null,
        realizedVolPct: null,
        atrPct,
        volProxyPct: atrPct,
      };
    }

    const recent = closes.slice(-(lookback + 1));
    let pathPct = 0;
    const returnsPct = [];
    for (let i = 1; i < recent.length; i += 1) {
      const prev = recent[i - 1];
      const cur = recent[i];
      if (!(prev > 0) || !(cur > 0)) continue;
      const stepPct = ((cur - prev) / prev) * 100;
      pathPct += Math.abs(stepPct);
      returnsPct.push(stepPct);
    }

    const start = recent[0];
    const end = recent[recent.length - 1];
    const trendReturnPct = start > 0 && end > 0 ? ((end - start) / start) * 100 : 0;
    const trendStrength = pathPct > 0 ? clamp(Math.abs(trendReturnPct) / pathPct, 0, 1) : 0;
    const mean = returnsPct.length
      ? returnsPct.reduce((sum, value) => sum + value, 0) / returnsPct.length
      : 0;
    const variance = returnsPct.length
      ? returnsPct.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returnsPct.length
      : 0;
    const realizedVolPct = Math.sqrt(Math.max(0, variance));
    const volProxyPct = Number.isFinite(atrPct) ? atrPct : realizedVolPct;

    return {
      ready: true,
      lookbackBars: lookback,
      trendReturnPct,
      trendStrength,
      realizedVolPct,
      atrPct,
      volProxyPct,
    };
  }

  _evaluateRegime(side, price) {
    const metrics = this._computeRegimeMetrics(price);
    if (!this.regimeFilterEnabled) {
      return { ok: true, metrics };
    }
    if (!metrics.ready) {
      return { ok: !this.regimeRequireReady, reason: "regime_not_ready", metrics };
    }
    if (metrics.trendStrength < this.regimeMinTrendStrength) {
      return { ok: false, reason: "regime_trend_strength_low", metrics };
    }
    if (Number.isFinite(metrics.volProxyPct) && metrics.volProxyPct < this.regimeMinVolPct) {
      return { ok: false, reason: "regime_vol_too_low", metrics };
    }
    if (Number.isFinite(metrics.volProxyPct) && metrics.volProxyPct > this.regimeMaxVolPct) {
      return { ok: false, reason: "regime_vol_too_high", metrics };
    }

    const minTrendReturnPct =
      side === "short" ? this.shortMinTrendReturnPct : this.longMinTrendReturnPct;
    if (side === "long" && metrics.trendReturnPct < minTrendReturnPct) {
      return { ok: false, reason: "regime_long_misaligned", metrics };
    }
    if (side === "short" && metrics.trendReturnPct > -minTrendReturnPct) {
      return { ok: false, reason: "regime_short_misaligned", metrics };
    }
    return { ok: true, metrics };
  }

  _evaluateSignalGate({
    side,
    price,
    consensus,
    leaders,
    allowEliteLeaderBypass = true,
    skipConcentrationGate = false,
  }) {
    const meta = this._normalizeConsensusMeta(consensus, leaders);
    if (
      !(allowEliteLeaderBypass && meta.eliteUsed) &&
      meta.contributors < this._getMinLeaders(side)
    ) {
      return { ok: false, reason: "leaders_below_min" };
    }
    if (meta.effectiveN < this._getMinEffectiveN(side)) {
      return { ok: false, reason: "effective_n_below_min" };
    }
    if (
      !skipConcentrationGate &&
      meta.maxWeightShare != null &&
      meta.maxWeightShare > this._getMaxActiveWeightShare(side)
    ) {
      return { ok: false, reason: "leader_concentration" };
    }
    if (
      !skipConcentrationGate &&
      meta.maxClusterWeightShare != null &&
      meta.maxClusterWeightShare > this._getMaxClusterWeightShare(side)
    ) {
      return { ok: false, reason: "leader_cluster_concentration" };
    }
    if (
      !skipConcentrationGate &&
      meta.maxFamilyWeightShare != null &&
      meta.maxFamilyWeightShare > this._getMaxLeaderFamilyWeightShare(side)
    ) {
      return { ok: false, reason: "leader_family_concentration" };
    }
    const regime = this._evaluateRegime(side, price);
    if (!regime.ok) {
      return { ok: false, reason: regime.reason, regime: regime.metrics };
    }
    return { ok: true, regime: regime.metrics };
  }

  _confirmedEntry(side, ts, meta = {}) {
    // Confirmation timer to avoid transient flips
    if (!this._pending || this._pending.side !== side) {
      this._pending = { side, startedAt: ts };
      return { action: "hold", reason: "confirming", confirmSide: side };
    }

    const elapsed = ts - this._pending.startedAt;
    if (elapsed < this.confirmMs) {
      return {
        action: "hold",
        reason: "confirming",
        confirmSide: side,
        confirmMsRemaining: this.confirmMs - elapsed,
      };
    }

    this._pending = null;
    const dir = side === "long" ? 1 : -1;
    this._lastDirection = dir;

    return {
      action: "open",
      side,
      confidence: meta.confidence ?? 0.5,
      reason: meta.reason ?? "signal",
      consensus: meta.consensus ?? null,
      leaderLeverage: meta?.consensus?.meta?.leaderLeverage ?? null,
      strategyType: this.type,
    };
  }
}

module.exports = CopyTradingStrategy;
