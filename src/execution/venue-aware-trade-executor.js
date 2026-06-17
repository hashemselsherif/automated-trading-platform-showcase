/**
 * Venue-Aware Trade Executor
 * 
 * Routes trades to the correct execution venue (Jupiter or Drift) based on:
 * 1. Market type (majors → Jupiter, alts → Drift by default)
 * 2. DRIFT_LIVE_STATE (shadow_only, limited_live, full_live)
 * 3. Per-market overrides (VENUE_OVERRIDE_${MARKET}_PERP)
 * 
 * This is the critical integration layer that was missing between:
 * - venue-router.js (routing logic)
 * - perps-live-client.js (Jupiter execution)
 * - perps-drift-client.js (Drift execution)
 * - limited-live.js (gate control)
 */

const EventEmitter = require('events');
const venueRouter = require('../../utils/venue-router');

// Error classification and collateral lock
const { classifyError, isInsufficientCollateral, isPerpMarketNotFound, isPostOnlyFailure } = require('../../utils/drift-error-classifier');
const { getCollateralLockManager } = require('../../utils/drift-collateral-lock');

// Strategy-scoped environment manager for isolated configs per strategy
let strategyEnv = null;
try {
  strategyEnv = require('../../utils/strategy-env-manager');
} catch (e) {
  // Not available, use process.env fallback
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VenueAwareTradeExecutor extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.jupiterClient - LivePerpsClient instance for Jupiter
   * @param {Object} options.driftClient - DriftPerpsClient instance for Drift (optional)
   * @param {Object} options.limitedLiveController - Limited live gate controller
   * @param {Object} options.shadowManager - Shadow mode manager
   * @param {Object} options.logger - Logger instance
   * @param {number} options.openRetries - Retries for open operations
   * @param {number} options.closeRetries - Retries for close operations
   * @param {number} options.retryDelayMs - Delay between retries
   */
  constructor(options = {}) {
    super();
    
    if (!options.jupiterClient) {
      throw new Error('VenueAwareTradeExecutor requires a Jupiter client instance');
    }
    
    this.jupiterClient = options.jupiterClient;
    this.driftClient = options.driftClient || null;
    this.limitedLiveController = options.limitedLiveController || null;
    this.shadowManager = options.shadowManager || null;
    this.logger = options.logger || console;
    
    this.options = {
      openRetries: Math.max(1, Number(options.openRetries) || 1),
      closeRetries: Math.max(1, Number(options.closeRetries) || 1),
      retryDelayMs: Math.max(0, Number(options.retryDelayMs) || 1500),
    };
    
    // Track which venue was used for each position (for correct close routing)
    this.positionVenueMap = new Map(); // positionId -> 'jupiter' | 'drift'
    
    // Collateral lock manager for InsufficientCollateral gating
    this.collateralLock = getCollateralLockManager({
      maxLockDurationMs: Number(process.env.COLLATERAL_LOCK_MAX_DURATION_MS) || 30 * 60 * 1000, // 30 min
      minLockIntervalMs: Number(process.env.COLLATERAL_LOCK_MIN_INTERVAL_MS) || 5000,
      log: (msg) => this._log('collateral_lock', { message: msg }),
    });
    
    // Listen for collateral lock events
    this.collateralLock.on('locked', (data) => {
      this.emit('collateralLocked', data);
    });
    this.collateralLock.on('unlocked', (data) => {
      this.emit('collateralUnlocked', data);
    });
    
    // Disabled markets (due to PerpMarketNotFound errors)
    this.disabledMarkets = new Map(); // marketSymbol -> { disabledAt, reason }
    
    // Stats
    this.stats = {
      jupiterOpens: 0,
      driftOpens: 0,
      shadowTrades: 0,
      blockedByGate: 0,
      blockedByCollateralLock: 0,
      blockedByDisabledMarket: 0,
      venueRoutingErrors: 0,
    };
    
    this._log('init', { 
      hasJupiter: true, 
      hasDrift: !!this.driftClient,
      hasLimitedLive: !!this.limitedLiveController,
      hasShadow: !!this.shadowManager,
    });
  }
  
  /**
   * Initialize the executor (and underlying clients)
   */
  async initialize() {
    // Initialize Drift client if available
    if (this.driftClient && typeof this.driftClient.initialize === 'function') {
      try {
        await this.driftClient.initialize();
        this._log('drift_client_init', { success: true });
      } catch (err) {
        this._log('drift_client_init_error', { error: err.message }, true);
        // Don't throw - Drift is optional, Jupiter will still work
      }
    }
  }
  
  /**
   * Open a position with venue-aware routing
   * 
   * @param {string} side - 'long' or 'short'
   * @param {number} collateralUsd - Collateral amount in USD
   * @param {number} leverage - Leverage multiplier
   * @param {number} priceLimit - Current market price
   * @param {string} clientOrderId - Client order ID
   * @param {string} marketSymbol - Market symbol (e.g., 'SOL-PERP', 'JTO-PERP')
   * @returns {Promise<Object>} Position object
   */
  async openPosition(side, collateralUsd, leverage, priceLimit, clientOrderId, marketSymbol) {
    const baseCtx = {
      side,
      collateralUsd,
      leverage,
      priceLimit,
      clientOrderId,
      marketSymbol,
    };
    
    // Determine venue for this market
    const venue = venueRouter.getVenueForMarket(marketSymbol);
    baseCtx.venue = venue;
    
    this._log('open:route', baseCtx);
    this.emit('open:route', baseCtx);
    
    // Route to appropriate client
    if (venue === venueRouter.VENUE.DRIFT) {
      return this._openDrift(side, collateralUsd, leverage, priceLimit, clientOrderId, marketSymbol, baseCtx);
    } else {
      return this._openJupiter(side, collateralUsd, leverage, priceLimit, clientOrderId, marketSymbol, baseCtx);
    }
  }
  
  /**
   * Open position on Jupiter (majors)
   */
  async _openJupiter(side, collateralUsd, leverage, priceLimit, clientOrderId, marketSymbol, baseCtx) {
    this._log('open:jupiter:start', baseCtx);
    this.emit('open:start', { ...baseCtx, venue: 'jupiter' });
    
    let attempt = 0;
    let lastError = null;
    
    while (attempt < this.options.openRetries) {
      attempt += 1;
      const attemptCtx = { ...baseCtx, attempt };
      this._log('open:attempt', attemptCtx);
      this.emit('open:attempt', attemptCtx);
      
      const started = Date.now();
      try {
        const position = await this.jupiterClient.openPosition(
          side,
          collateralUsd,
          leverage,
          priceLimit,
          clientOrderId,
          marketSymbol
        );
        
        // Track venue for this position
        if (position?.positionId) {
          this.positionVenueMap.set(position.positionId, 'jupiter');
          position.venue = 'jupiter';
        }
        
        this.stats.jupiterOpens++;
        
        const successCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          positionId: position?.positionId,
          venue: 'jupiter',
        };
        this._log('open:success', successCtx);
        this.emit('open:success', successCtx);
        
        return position;
      } catch (error) {
        lastError = error;
        const errorCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          error: error?.message || 'unknown error',
          venue: 'jupiter',
        };
        this._log('open:error', errorCtx, true);
        this.emit('open:error', errorCtx);
        
        if (attempt >= this.options.openRetries) break;
        if (this.options.retryDelayMs > 0) {
          await sleep(this.options.retryDelayMs);
        }
      }
    }
    
    const failure = new Error(
      `openPosition (Jupiter) failed after ${attempt} attempt(s): ${lastError?.message || 'unknown error'}`
    );
    failure.cause = lastError;
    failure.venue = 'jupiter';
    this.emit('open:failure', { ...baseCtx, attempts: attempt, error: failure.message, venue: 'jupiter' });
    throw failure;
  }
  
  /**
   * Open position on Drift (alts) - with limited-live/shadow gate
   */
  async _openDrift(side, collateralUsd, leverage, priceLimit, clientOrderId, marketSymbol, baseCtx) {
    const notionalSize = collateralUsd * leverage;
    
    // Check if market is disabled (due to PerpMarketNotFound or other fatal errors)
    const disabledInfo = this.disabledMarkets.get(marketSymbol);
    if (disabledInfo) {
      const disabledCtx = {
        ...baseCtx,
        reason: `Market disabled: ${disabledInfo.reason}`,
        disabledAt: disabledInfo.disabledAt,
        venue: 'drift',
      };
      this._log('open:drift:market_disabled', disabledCtx);
      this.emit('open:blocked', disabledCtx);
      this.stats.blockedByDisabledMarket++;
      throw new Error(`Drift position blocked: market ${marketSymbol} is disabled (${disabledInfo.reason})`);
    }
    
    // Check collateral lock BEFORE attempting to open
    // This prevents retry storms when account has insufficient collateral
    let currentOpenPositionsCount = 0;
    try {
      if (this.driftClient && typeof this.driftClient.getAllOpenPositions === 'function') {
        const positions = await this.driftClient.getAllOpenPositions();
        currentOpenPositionsCount = positions.length;
      }
    } catch (e) {
      // Ignore errors getting position count - we'll still check lock state
      this._log('open:drift:positions_check_failed', { error: e.message });
    }
    
    const collateralCheck = this.collateralLock.canOpen(currentOpenPositionsCount);
    if (!collateralCheck.allowed) {
      const lockCtx = {
        ...baseCtx,
        reason: collateralCheck.reason,
        currentOpenPositions: currentOpenPositionsCount,
        venue: 'drift',
      };
      this._log('open:drift:collateral_locked', lockCtx);
      this.emit('open:blocked', lockCtx);
      this.stats.blockedByCollateralLock++;
      throw new Error(`Drift position blocked: ${collateralCheck.reason}`);
    }
    
    // Check limited-live gate
    if (this.limitedLiveController) {
      const canOpen = this.limitedLiveController.canOpenPosition(marketSymbol, notionalSize);
      
      if (!canOpen.allowed) {
        const gateCtx = {
          ...baseCtx,
          reason: canOpen.reason,
          state: this.limitedLiveController.state,
          venue: 'drift',
        };
        
        this._log('open:drift:blocked', gateCtx);
        this.emit('open:blocked', gateCtx);
        this.stats.blockedByGate++;
        
        // Record shadow trade if shadow manager is enabled
        if (this.shadowManager && this.shadowManager.enabled) {
          this._recordShadowOpen(side, collateralUsd, leverage, priceLimit, marketSymbol);
          this.stats.shadowTrades++;
        }
        
        throw new Error(`Drift position blocked: ${canOpen.reason}`);
      }
    }
    
    // Check if Drift client is available
    if (!this.driftClient) {
      const noDriftCtx = {
        ...baseCtx,
        reason: 'Drift client not initialized',
        venue: 'drift',
      };
      this._log('open:drift:no_client', noDriftCtx, true);
      this.emit('open:error', noDriftCtx);
      this.stats.venueRoutingErrors++;
      throw new Error(`Cannot open Drift position for ${marketSymbol}: Drift client not initialized`);
    }
    
    // Execute on Drift
    this._log('open:drift:start', baseCtx);
    this.emit('open:start', { ...baseCtx, venue: 'drift' });
    
    let attempt = 0;
    let lastError = null;
    let lastClassifiedError = null;
    
    while (attempt < this.options.openRetries) {
      attempt += 1;
      const attemptCtx = { ...baseCtx, attempt };
      this._log('open:attempt', attemptCtx);
      this.emit('open:attempt', attemptCtx);
      
      const started = Date.now();
      try {
        const position = await this.driftClient.openPosition(
          side,
          collateralUsd,
          leverage,
          priceLimit,
          clientOrderId,
          { market: marketSymbol }
        );
        
        // Track venue for this position
        if (position?.positionId) {
          this.positionVenueMap.set(position.positionId, 'drift');
          position.venue = 'drift';
        }
        
        // Update limited-live exposure tracking
        if (this.limitedLiveController && typeof this.limitedLiveController.recordTrade === 'function') {
          this.limitedLiveController.recordTrade({
            market: marketSymbol,
            side,
            size: notionalSize,
            type: 'open',
          });
        }
        
        // CRITICAL: Release collateral lock on successful open
        // This handles cases where a cooldown retry succeeded, proving collateral is available
        if (this.collateralLock.isLocked()) {
          this._log('open:drift:releasing_collateral_lock', { 
            ...baseCtx, 
            reason: 'successful_open',
          });
          this.collateralLock.forceRelease('successful_drift_open');
        }
        
        this.stats.driftOpens++;
        
        const successCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          positionId: position?.positionId,
          venue: 'drift',
        };
        this._log('open:success', successCtx);
        this.emit('open:success', successCtx);
        
        return position;
      } catch (error) {
        lastError = error;
        
        // Classify the error to determine action
        lastClassifiedError = classifyError(error);
        
        const errorCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          error: error?.message || 'unknown error',
          errorKind: lastClassifiedError.kind,
          driftCode: lastClassifiedError.driftCode,
          driftErrorName: lastClassifiedError.driftErrorName,
          retriable: lastClassifiedError.retriable,
          action: lastClassifiedError.action,
          venue: 'drift',
        };
        this._log('open:error', errorCtx, true);
        this.emit('open:error', errorCtx);
        
        // Handle InsufficientCollateral: acquire lock and stop retrying
        if (isInsufficientCollateral(error)) {
          this._log('open:drift:insufficient_collateral', {
            ...baseCtx,
            message: 'Acquiring collateral lock - no retries until position closes',
            openPositions: currentOpenPositionsCount,
          }, true);
          this.collateralLock.acquireLock(currentOpenPositionsCount, error?.message);
          break; // Don't retry
        }
        
        // Handle PerpMarketNotFound: disable market and stop retrying
        if (isPerpMarketNotFound(error)) {
          this._log('open:drift:market_not_found', {
            ...baseCtx,
            message: `Disabling market ${marketSymbol} due to PerpMarketNotFound`,
          }, true);
          this.disabledMarkets.set(marketSymbol, {
            disabledAt: new Date().toISOString(),
            reason: 'PerpMarketNotFound',
            error: error?.message,
          });
          this.emit('marketDisabled', { market: marketSymbol, reason: 'PerpMarketNotFound' });
          break; // Don't retry
        }
        
        // Check if error is retriable
        if (!lastClassifiedError.retriable) {
          this._log('open:drift:non_retriable', {
            ...baseCtx,
            errorName: lastClassifiedError.driftErrorName || lastClassifiedError.rpcCode,
            action: lastClassifiedError.action,
          });
          break; // Don't retry non-retriable errors
        }
        
        if (attempt >= this.options.openRetries) break;
        if (this.options.retryDelayMs > 0) {
          await sleep(this.options.retryDelayMs);
        }
      }
    }
    
    const failure = new Error(
      `openPosition (Drift) failed after ${attempt} attempt(s): ${lastError?.message || 'unknown error'}`
    );
    failure.cause = lastError;
    failure.venue = 'drift';
    failure.classifiedError = lastClassifiedError;
    this.emit('open:failure', { 
      ...baseCtx, 
      attempts: attempt, 
      error: failure.message, 
      venue: 'drift',
      errorKind: lastClassifiedError?.kind,
      driftCode: lastClassifiedError?.driftCode,
    });
    throw failure;
  }
  
  /**
   * Record a shadow trade for blocked Drift positions
   */
  _recordShadowOpen(side, collateralUsd, leverage, priceLimit, marketSymbol) {
    if (!this.shadowManager || typeof this.shadowManager.recordShadowTrade !== 'function') {
      return;
    }
    
    try {
      const { calculateTradingFee } = require('../../scripts/backtest/lib/utils/fee-calculator');
      const notionalSize = collateralUsd * leverage;
      
      // Use market-specific exec mode from isolated strategy env to prevent bleeding
      const execMode = strategyEnv 
        ? strategyEnv.getMarketConfig(marketSymbol, 'EXEC_MODE', 'maker').toLowerCase()
        : (process.env.EXEC_MODE || 'maker').toLowerCase();
      const tier = strategyEnv
        ? strategyEnv.getMarketConfig(marketSymbol, 'DRIFT_TIER', 'rookie').toLowerCase()
        : (process.env.DRIFT_TIER || 'rookie').toLowerCase();
      
      const feeRes = calculateTradingFee(notionalSize, 'open', {
        model: 'drift',
        execMode,
        tier,
        enablePriceImpactFee: false,
      });
      
      this.shadowManager.recordShadowTrade({
        market: marketSymbol,
        side: side.toUpperCase(),
        size: notionalSize,
        entryPrice: priceLimit,
        oraclePrice: priceLimit, // Could be enhanced with actual oracle price
        execMode,
        fees: feeRes?.fee || 0,
      });
      
      this._log('shadow:recorded', {
        market: marketSymbol,
        side,
        size: notionalSize,
        execMode,
        fee: feeRes?.fee || 0,
      });
    } catch (err) {
      this._log('shadow:record_error', { error: err.message }, true);
    }
  }
  
  /**
   * Close a position with venue-aware routing
   * 
   * @param {Object} position - Position to close
   * @param {number} priceLimit - Current market price
   * @returns {Promise<Object>} Close result
   */
  async closePosition(position, priceLimit) {
    const baseCtx = {
      positionId: position?.positionId,
      market: position?.market,
      priceLimit,
    };
    
    // Determine venue from position or venue map
    let venue = position?.venue || this.positionVenueMap.get(position?.positionId);
    
    // Fallback to venue router if not tracked
    if (!venue && position?.market) {
      venue = venueRouter.getVenueForMarket(position.market);
    }
    
    baseCtx.venue = venue || 'unknown';
    
    this._log('close:route', baseCtx);
    this.emit('close:start', baseCtx);
    
    // Route to appropriate client
    if (venue === 'drift' && this.driftClient) {
      return this._closeDrift(position, priceLimit, baseCtx);
    } else {
      return this._closeJupiter(position, priceLimit, baseCtx);
    }
  }
  
  /**
   * Close position on Jupiter
   */
  async _closeJupiter(position, priceLimit, baseCtx) {
    this._log('close:jupiter:start', baseCtx);
    
    // Check kill switch status
    if (this.jupiterClient?.closeKillSwitchTripped) {
      const killSwitchCtx = {
        ...baseCtx,
        killSwitchActive: true,
        lastKillSwitchError: this.jupiterClient._lastKillSwitchError || 'unknown',
      };
      this._log('close:killswitch', killSwitchCtx, true);
      this.emit('close:killswitch', killSwitchCtx);
    }
    
    let attempt = 0;
    let lastError = null;
    
    while (attempt < this.options.closeRetries) {
      attempt += 1;
      const attemptCtx = { ...baseCtx, attempt };
      this._log('close:attempt', attemptCtx);
      this.emit('close:attempt', attemptCtx);
      
      const started = Date.now();
      try {
        const result = await this._invokeClose(this.jupiterClient, position, priceLimit);
        
        // Clean up venue tracking
        if (position?.positionId) {
          this.positionVenueMap.delete(position.positionId);
        }
        
        const successCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          signature: result?.sig || result?.signature || null,
          venue: 'jupiter',
        };
        this._log('close:success', successCtx);
        this.emit('close:success', successCtx);
        
        return result;
      } catch (error) {
        lastError = error;
        const isKillSwitch = error?.message?.includes('KILL SWITCH');
        const errorCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          error: error?.message || 'unknown error',
          isKillSwitchError: isKillSwitch,
          venue: 'jupiter',
        };
        this._log('close:error', errorCtx, true);
        this.emit('close:error', errorCtx);
        
        if (isKillSwitch) break; // Don't retry kill switch errors
        if (attempt >= this.options.closeRetries) break;
        if (this.options.retryDelayMs > 0) {
          await sleep(this.options.retryDelayMs);
        }
      }
    }
    
    const failure = new Error(
      `closePosition (Jupiter) failed after ${attempt} attempt(s): ${lastError?.message || 'unknown error'}`
    );
    failure.cause = lastError;
    failure.venue = 'jupiter';
    this.emit('close:failure', { ...baseCtx, attempts: attempt, error: failure.message, venue: 'jupiter' });
    throw failure;
  }
  
  /**
   * Close position on Drift
   */
  async _closeDrift(position, priceLimit, baseCtx) {
    this._log('close:drift:start', baseCtx);
    
    // CRITICAL FIX: Ensure position has baseSize before attempting close
    // closePosition() requires baseSize to know how many units to close
    // If missing, fetch from on-chain position data
    let enrichedPosition = position;
    const baseSize = Number(position?.baseSize || position?.sizeBase || 0);
    if (!baseSize || !Number.isFinite(baseSize) || baseSize <= 0) {
      this._log('close:drift:fetching_baseSize', { 
        ...baseCtx, 
        reason: 'baseSize missing from position object',
        providedBaseSize: position?.baseSize,
        providedSizeBase: position?.sizeBase,
      });
      
      try {
        // Fetch on-chain positions to get accurate baseSize
        const onChainPositions = await this.driftClient.getAllOpenPositions();
        const matchingPos = onChainPositions.find(p => 
          (p.positionId === position.positionId) ||
          (p.market === position.market && 
           p.side?.toLowerCase() === position.side?.toLowerCase())
        );
        
        if (matchingPos) {
          const onChainBaseSize = Number(matchingPos.baseSize || matchingPos.sizeBase || 0);
          if (onChainBaseSize > 0) {
            enrichedPosition = {
              ...position,
              baseSize: onChainBaseSize,
              sizeBase: onChainBaseSize,
              marketIndex: matchingPos.marketIndex || position.marketIndex,
            };
            this._log('close:drift:enriched', { 
              ...baseCtx, 
              fetchedBaseSize: onChainBaseSize,
              marketIndex: enrichedPosition.marketIndex,
            });
          } else {
            this._log('close:drift:no_baseSize_on_chain', { 
              ...baseCtx, 
              error: 'On-chain position found but baseSize is still invalid',
            }, true);
          }
        } else {
          this._log('close:drift:no_matching_position', { 
            ...baseCtx, 
            error: 'No matching on-chain position found',
          }, true);
        }
      } catch (fetchErr) {
        this._log('close:drift:fetch_error', { 
          ...baseCtx, 
          error: fetchErr.message,
        }, true);
        // Continue with original position - closePosition will throw if baseSize is invalid
      }
    }
    
    let attempt = 0;
    let lastError = null;
    
    while (attempt < this.options.closeRetries) {
      attempt += 1;
      const attemptCtx = { ...baseCtx, attempt };
      this._log('close:attempt', attemptCtx);
      this.emit('close:attempt', attemptCtx);
      
      const started = Date.now();
      try {
        const result = await this.driftClient.closePosition(enrichedPosition, priceLimit, {
          reason: enrichedPosition?.closeReason || 'bot_close',
        });
        
        // Clean up venue tracking
        if (position?.positionId) {
          this.positionVenueMap.delete(position.positionId);
        }
        
        // Update limited-live exposure tracking
        if (this.limitedLiveController && typeof this.limitedLiveController.recordTrade === 'function') {
          this.limitedLiveController.recordTrade({
            market: position.market,
            side: position.side,
            size: position.size || (position.collateral * position.leverage),
            type: 'close',
            pnl: result?.pnl || 0,
          });
        }
        
        const successCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          pnl: result?.pnl,
          execMode: result?.execMode,
          venue: 'drift',
        };
        this._log('close:success', successCtx);
        this.emit('close:success', successCtx);
        
        return result;
      } catch (error) {
        lastError = error;
        const errorCtx = {
          ...attemptCtx,
          durationMs: Date.now() - started,
          error: error?.message || 'unknown error',
          venue: 'drift',
        };
        this._log('close:error', errorCtx, true);
        this.emit('close:error', errorCtx);
        
        if (attempt >= this.options.closeRetries) break;
        if (this.options.retryDelayMs > 0) {
          await sleep(this.options.retryDelayMs);
        }
      }
    }
    
    const failure = new Error(
      `closePosition (Drift) failed after ${attempt} attempt(s): ${lastError?.message || 'unknown error'}`
    );
    failure.cause = lastError;
    failure.venue = 'drift';
    this.emit('close:failure', { ...baseCtx, attempts: attempt, error: failure.message, venue: 'drift' });
    throw failure;
  }
  
  /**
   * Invoke close with correct signature based on client
   * 
   * CRITICAL: Always pass position to ensure we close the CORRECT position.
   * perps-live-client.js now supports closePosition(position, priceLimit) signature
   * to prevent closing the wrong position when multiple positions exist (long + short).
   */
  async _invokeClose(client, position, priceLimit) {
    if (!client?.closePosition) {
      throw new Error('Client does not implement closePosition');
    }
    // ALWAYS pass position first to ensure correct position is closed
    // perps-live-client.js now handles both signatures:
    // - closePosition(position, priceLimit) - new, preferred
    // - closePosition(priceLimit) - legacy, falls back to first position
    return client.closePosition(position, priceLimit);
  }
  
  /**
   * Get all open positions from both venues
   */
  async getAllOpenPositions() {
    const positions = [];
    
    // Jupiter positions
    if (this.jupiterClient && typeof this.jupiterClient.getAllOpenPositions === 'function') {
      try {
        const jupPositions = await this.jupiterClient.getAllOpenPositions();
        for (const pos of jupPositions) {
          pos.venue = 'jupiter';
          positions.push(pos);
        }
      } catch (err) {
        this._log('get_positions:jupiter:error', { error: err.message }, true);
      }
    }
    
    // Drift positions
    if (this.driftClient && typeof this.driftClient.getAllOpenPositions === 'function') {
      try {
        const driftPositions = await this.driftClient.getAllOpenPositions();
        for (const pos of driftPositions) {
          pos.venue = 'drift';
          positions.push(pos);
        }
      } catch (err) {
        this._log('get_positions:drift:error', { error: err.message }, true);
      }
    }
    
    return positions;
  }
  
  /**
   * Get venue for a market (exposed for external use)
   */
  getVenueForMarket(market) {
    return venueRouter.getVenueForMarket(market);
  }
  
  /**
   * Get executor statistics
   */
  getStats() {
    return {
      ...this.stats,
      trackedPositions: this.positionVenueMap.size,
      jupiterClientReady: !!this.jupiterClient,
      driftClientReady: !!this.driftClient,
      limitedLiveState: this.limitedLiveController?.state || 'unknown',
      shadowEnabled: this.shadowManager?.enabled || false,
      collateralLockState: this.collateralLock.getLockState(),
      disabledMarketsCount: this.disabledMarkets.size,
      disabledMarkets: Array.from(this.disabledMarkets.entries()).map(([market, info]) => ({
        market,
        ...info,
      })),
    };
  }
  
  /**
   * Enable a previously disabled market
   * @param {string} marketSymbol - Market to re-enable
   * @returns {boolean} True if market was enabled, false if it wasn't disabled
   */
  enableMarket(marketSymbol) {
    if (!this.disabledMarkets.has(marketSymbol)) {
      return false;
    }
    
    this.disabledMarkets.delete(marketSymbol);
    this._log('market_enabled', { market: marketSymbol });
    this.emit('marketEnabled', { market: marketSymbol });
    return true;
  }
  
  /**
   * Check if a market is disabled
   * @param {string} marketSymbol - Market to check
   * @returns {boolean}
   */
  isMarketDisabled(marketSymbol) {
    return this.disabledMarkets.has(marketSymbol);
  }
  
  /**
   * Get list of disabled markets
   * @returns {Array<{market: string, disabledAt: string, reason: string}>}
   */
  getDisabledMarkets() {
    return Array.from(this.disabledMarkets.entries()).map(([market, info]) => ({
      market,
      ...info,
    }));
  }
  
  /**
   * Force release the collateral lock (manual override)
   * @param {string} reason - Reason for force release
   */
  forceReleaseCollateralLock(reason = 'manual_override') {
    this.collateralLock.forceRelease(reason);
  }
  
  /**
   * Get collateral lock state
   * @returns {Object}
   */
  getCollateralLockState() {
    return this.collateralLock.getLockState();
  }
  
  /**
   * Internal logging helper
   */
  _log(event, payload, isError = false) {
    if (this.logger) {
      const fn = isError && this.logger.error ? this.logger.error : this.logger.log || console.log;
      fn.call(this.logger, `[VenueAwareTradeExecutor] ${event}`, payload);
    }
  }
}

module.exports = VenueAwareTradeExecutor;

