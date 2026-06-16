const EventEmitter = require("events");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TradeExecutionService extends EventEmitter {
  constructor(tradeClient, options = {}) {
    super();
    if (!tradeClient) {
      throw new Error("TradeExecutionService requires a trade client instance");
    }
    this.client = tradeClient;
    this.logger = options.logger || console;
    this.options = {
      openRetries: Math.max(1, Number(options.openRetries) || 1),
      closeRetries: Math.max(1, Number(options.closeRetries) || 1),
      retryDelayMs: Math.max(0, Number(options.retryDelayMs) || 1500),
    };
  }

  async openPosition(side, collateralUsd, leverage, priceLimit, clientOrderId, marketSymbol = null) {
    const baseCtx = {
      side,
      collateralUsd,
      leverage,
      priceLimit,
      clientOrderId,
      marketSymbol,
    };
    this._log("open:start", baseCtx);
    this.emit("open:start", baseCtx);
    let attempt = 0;
    let lastError = null;
    while (attempt < this.options.openRetries) {
      attempt += 1;
      const attemptCtx = { ...baseCtx, attempt };
      this._log("open:attempt", attemptCtx);
      this.emit("open:attempt", attemptCtx);
      const started = Date.now();
      try {
        const position = await this.client.openPosition(
          side,
          collateralUsd,
          leverage,
          priceLimit,
          clientOrderId,
          marketSymbol
        );
        const successCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          positionId: position?.positionId,
        };
        this._log("open:success", successCtx);
        this.emit("open:success", successCtx);
        return position;
      } catch (error) {
        lastError = error;
        const errorCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          error: error?.message || "unknown error",
        };
        this._log("open:error", errorCtx, true);
        this.emit("open:error", errorCtx);
        if (attempt >= this.options.openRetries) {
          break;
        }
        if (this.options.retryDelayMs > 0) {
          await sleep(this.options.retryDelayMs);
        }
      }
    }

    const failure = new Error(
      `openPosition failed after ${attempt} attempt(s): ${lastError?.message || "unknown error"}`
    );
    failure.cause = lastError;
    const failureCtx = { ...baseCtx, attempts: attempt, error: failure.message };
    this._log("open:failure", failureCtx, true);
    this.emit("open:failure", failureCtx);
    throw failure;
  }

  async closePosition(position, priceLimit) {
    const baseCtx = {
      positionId: position?.positionId,
      market: position?.market,
      priceLimit,
    };
    
    // Check kill switch status before attempting close
    if (this.client?.closeKillSwitchTripped) {
      const killSwitchCtx = {
        ...baseCtx,
        killSwitchActive: true,
        lastKillSwitchError: this.client._lastKillSwitchError || 'unknown',
        lastKillSwitchTime: this.client._lastKillSwitchTime || null,
        timeSinceKillSwitch: this.client._lastKillSwitchTime 
          ? Math.round((Date.now() - this.client._lastKillSwitchTime) / 1000 / 60) 
          : null,
      };
      this._log("close:killswitch", killSwitchCtx, true);
      this.emit("close:killswitch", killSwitchCtx);
    }
    
    this._log("close:start", baseCtx);
    this.emit("close:start", baseCtx);
    let attempt = 0;
    let lastError = null;
    while (attempt < this.options.closeRetries) {
      attempt += 1;
      const attemptCtx = { ...baseCtx, attempt };
      this._log("close:attempt", attemptCtx);
      this.emit("close:attempt", attemptCtx);
      const started = Date.now();
      try {
        const result = await this._invokeClose(position, priceLimit);
        const successCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          signature: result?.sig || result?.signature || null,
        };
        this._log("close:success", successCtx);
        this.emit("close:success", successCtx);
        return result;
      } catch (error) {
        lastError = error;
        
        // Enhanced error context for kill switch errors
        const isKillSwitchError = error?.message?.includes('KILL SWITCH') || 
                                  error?.message?.includes('kill switch') ||
                                  error?.name === 'CloseKillSwitchError';
        
        const errorCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          error: error?.message || "unknown error",
          isKillSwitchError,
          killSwitchTripped: this.client?.closeKillSwitchTripped || false,
        };
        
        // Add kill switch details if available
        if (isKillSwitchError && this.client) {
          errorCtx.killSwitchDetails = {
            lastError: this.client._lastKillSwitchError,
            lastTriggerTime: this.client._lastKillSwitchTime,
            attempts: error?.attempts,
          };
        }
        
        this._log("close:error", errorCtx, true);
        this.emit("close:error", errorCtx);
        
        // Don't retry if kill switch is active - it will fail immediately
        if (isKillSwitchError) {
          console.error(`[TradeExecutionService] Kill switch is active - aborting retries. Error: ${error.message}`);
          break;
        }
        
        if (attempt >= this.options.closeRetries) {
          break;
        }
        if (this.options.retryDelayMs > 0) {
          await sleep(this.options.retryDelayMs);
        }
      }
    }

    const failure = new Error(
      `closePosition failed after ${attempt} attempt(s): ${lastError?.message || "unknown error"}`
    );
    failure.cause = lastError;
    const failureCtx = { 
      ...baseCtx, 
      attempts: attempt, 
      error: failure.message,
      isKillSwitchError: lastError?.message?.includes('KILL SWITCH') || lastError?.name === 'CloseKillSwitchError',
    };
    this._log("close:failure", failureCtx, true);
    this.emit("close:failure", failureCtx);
    throw failure;
  }

  async _invokeClose(position, priceLimit) {
    if (!this.client?.closePosition) {
      throw new Error("Underlying trade client does not implement closePosition");
    }
    const expectedArgs = this.client.closePosition.length || 0;
    if (expectedArgs <= 1) {
      return this.client.closePosition(priceLimit);
    }
    return this.client.closePosition(position, priceLimit);
  }

  _log(event, payload, isError = false) {
    if (this.logger) {
      const fn = isError && this.logger.error ? this.logger.error : this.logger.log || console.log;
      fn.call(this.logger, `[TradeExecutionService] ${event}`, payload);
    }
  }
}

module.exports = TradeExecutionService;

