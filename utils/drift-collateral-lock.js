/**
 * Drift Collateral Lock Manager
 * 
 * Implements the policy: When InsufficientCollateral error occurs,
 * block new position opens until an existing position is closed.
 * 
 * This prevents retry storms when the account doesn't have enough
 * collateral to open new positions.
 */

const EventEmitter = require('events');

class CollateralLockManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Maximum lock duration (auto-unlock after this time)
      maxLockDurationMs: options.maxLockDurationMs || 30 * 60 * 1000, // 30 minutes
      // Minimum time between lock acquisitions (debounce)
      minLockIntervalMs: options.minLockIntervalMs || 5000,
      // Cooldown retry: allow one retry attempt after this duration even if position count unchanged
      // This handles cases where the InsufficientCollateral was due to a temporary state
      cooldownRetryMs: options.cooldownRetryMs || 5 * 60 * 1000, // 5 minutes
      // Log function
      log: options.log || console.log,
    };
    
    // Lock state
    this._lock = {
      active: false,
      lockedAt: null,
      lockedAtOpenPositionsCount: null,
      lastError: null,
      lockCount: 0,
      lastLockAt: 0,
      // Cooldown retry tracking
      cooldownRetryAllowed: false,
      lastCooldownRetryAt: 0,
    };
    
    // Stats
    this.stats = {
      totalLocks: 0,
      totalUnlocks: 0,
      blockedOpens: 0,
      autoExpires: 0,
      cooldownRetries: 0,
    };
  }
  
  /**
   * Check if opens are currently blocked due to collateral lock
   * @returns {boolean}
   */
  isLocked() {
    if (!this._lock.active) return false;
    
    // Check for auto-expiry
    const lockAge = Date.now() - this._lock.lockedAt;
    if (lockAge > this.options.maxLockDurationMs) {
      this._autoExpire();
      return false;
    }
    
    return true;
  }
  
  /**
   * Get current lock state
   * @returns {Object} Lock state info
   */
  getLockState() {
    const lockDurationMs = this._lock.active ? Date.now() - this._lock.lockedAt : 0;
    const timeUntilCooldownRetry = this._lock.active 
      ? Math.max(0, this.options.cooldownRetryMs - lockDurationMs)
      : 0;
    
    return {
      active: this._lock.active,
      lockedAt: this._lock.lockedAt,
      lockedAtOpenPositionsCount: this._lock.lockedAtOpenPositionsCount,
      lastError: this._lock.lastError,
      lockCount: this._lock.lockCount,
      lockDurationMs,
      timeUntilCooldownRetryMs: timeUntilCooldownRetry,
      lastCooldownRetryAt: this._lock.lastCooldownRetryAt,
    };
  }
  
  /**
   * Acquire collateral lock after InsufficientCollateral error
   * @param {number} currentOpenPositionsCount - Number of open positions when error occurred
   * @param {string} errorMessage - The error message that triggered the lock
   * @returns {boolean} True if lock was acquired, false if already locked or debounced
   */
  acquireLock(currentOpenPositionsCount, errorMessage) {
    // Already locked
    if (this._lock.active) {
      this.options.log(`[CollateralLock] Lock already active (positions: ${this._lock.lockedAtOpenPositionsCount})`);
      return false;
    }
    
    // Debounce: don't re-lock too quickly
    const timeSinceLastLock = Date.now() - this._lock.lastLockAt;
    if (timeSinceLastLock < this.options.minLockIntervalMs) {
      this.options.log(`[CollateralLock] Lock debounced (${timeSinceLastLock}ms since last lock)`);
      return false;
    }
    
    this._lock.active = true;
    this._lock.lockedAt = Date.now();
    this._lock.lockedAtOpenPositionsCount = currentOpenPositionsCount;
    this._lock.lastError = errorMessage;
    this._lock.lockCount++;
    this._lock.lastLockAt = Date.now();
    
    this.stats.totalLocks++;
    
    this.options.log(
      `[CollateralLock] 🔒 LOCKED - InsufficientCollateral detected. ` +
      `Open positions at lock: ${currentOpenPositionsCount}. ` +
      `New opens blocked until a position closes.`
    );
    
    this.emit('locked', {
      openPositionsCount: currentOpenPositionsCount,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
    
    return true;
  }
  
  /**
   * Try to release the lock if conditions are met
   * @param {number} currentOpenPositionsCount - Current number of open positions
   * @returns {boolean} True if lock was released
   */
  tryRelease(currentOpenPositionsCount) {
    if (!this._lock.active) return false;
    
    const lockAge = Date.now() - this._lock.lockedAt;
    
    // Check if a position was closed (count decreased)
    if (currentOpenPositionsCount < this._lock.lockedAtOpenPositionsCount) {
      this._releaseLock(
        `Position closed (${this._lock.lockedAtOpenPositionsCount} → ${currentOpenPositionsCount})`
      );
      return true;
    }
    
    // Special case: lock acquired with zero open positions.
    // There's no position to close, so treat the lock as a cooldown throttle.
    if (this._lock.lockedAtOpenPositionsCount === 0 && currentOpenPositionsCount === 0) {
      if (lockAge >= this.options.cooldownRetryMs) {
        this._releaseLock('cooldown elapsed with zero positions');
        return true;
      }
    }
    
    // Check for auto-expiry
    if (lockAge > this.options.maxLockDurationMs) {
      this._autoExpire();
      return true;
    }
    
    return false;
  }
  
  /**
   * Force release the lock (manual override)
   * @param {string} reason - Reason for force release
   */
  forceRelease(reason = 'manual_override') {
    if (!this._lock.active) return;
    this._releaseLock(reason);
  }
  
  /**
   * Check if an open should be blocked
   * @param {number} currentOpenPositionsCount - Current number of open positions
   * @returns {{allowed: boolean, reason?: string, isCooldownRetry?: boolean}}
   */
  canOpen(currentOpenPositionsCount) {
    // First, try to release if conditions are met
    this.tryRelease(currentOpenPositionsCount);
    
    if (!this._lock.active) {
      return { allowed: true };
    }
    
    // COOLDOWN RETRY: After the lock has been active for cooldownRetryMs,
    // allow ONE retry attempt (this handles temporary insufficient collateral situations)
    const lockAge = Date.now() - this._lock.lockedAt;
    const timeSinceLastCooldownRetry = Date.now() - (this._lock.lastCooldownRetryAt || 0);
    
    if (lockAge >= this.options.cooldownRetryMs && timeSinceLastCooldownRetry >= this.options.cooldownRetryMs) {
      this._lock.lastCooldownRetryAt = Date.now();
      this._lock.cooldownRetryAllowed = true;
      this.stats.cooldownRetries++;
      
      this.options.log(
        `[CollateralLock] 🔄 COOLDOWN RETRY - Lock has been active for ${Math.round(lockAge / 1000)}s. ` +
        `Allowing one retry attempt to check if collateral situation has improved.`
      );
      
      this.emit('cooldownRetry', {
        lockAgeMs: lockAge,
        timestamp: new Date().toISOString(),
      });
      
      return { allowed: true, isCooldownRetry: true };
    }
    
    this.stats.blockedOpens++;
    
    // Calculate time until next cooldown retry
    const timeUntilCooldownRetry = Math.max(0, this.options.cooldownRetryMs - lockAge);
    const cooldownInfo = timeUntilCooldownRetry > 0 
      ? ` Cooldown retry in ${Math.round(timeUntilCooldownRetry / 1000)}s.`
      : '';
    
    const baseReason = this._lock.lockedAtOpenPositionsCount === 0
      ? `Collateral lock active since ${new Date(this._lock.lockedAt).toISOString()}. ` +
        `Locked at 0 positions (current: 0).`
      : `Collateral lock active since ${new Date(this._lock.lockedAt).toISOString()}. ` +
        `Waiting for position close (locked at ${this._lock.lockedAtOpenPositionsCount} positions, ` +
        `current: ${currentOpenPositionsCount}).`;
    
    return {
      allowed: false,
      reason: `${baseReason} Last error: ${this._lock.lastError?.slice(0, 100)}${cooldownInfo}`,
    };
  }
  
  /**
   * Internal: Release the lock
   * @param {string} reason - Reason for release
   * @private
   */
  _releaseLock(reason) {
    const lockDuration = Date.now() - this._lock.lockedAt;
    
    this.options.log(
      `[CollateralLock] 🔓 UNLOCKED - ${reason}. ` +
      `Lock was active for ${Math.round(lockDuration / 1000)}s. ` +
      `Opens are now allowed.`
    );
    
    this.stats.totalUnlocks++;
    
    this.emit('unlocked', {
      reason,
      lockDurationMs: lockDuration,
      timestamp: new Date().toISOString(),
    });
    
    this._lock.active = false;
    this._lock.lockedAt = null;
    this._lock.lockedAtOpenPositionsCount = null;
    this._lock.lastError = null;
  }
  
  /**
   * Internal: Auto-expire the lock
   * @private
   */
  _autoExpire() {
    this.stats.autoExpires++;
    this._releaseLock(`auto-expired after ${this.options.maxLockDurationMs / 1000}s`);
  }
  
  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      currentLockState: this.getLockState(),
    };
  }
  
  /**
   * Reset all state (for testing)
   */
  reset() {
    this._lock = {
      active: false,
      lockedAt: null,
      lockedAtOpenPositionsCount: null,
      lastError: null,
      lockCount: 0,
      lastLockAt: 0,
      cooldownRetryAllowed: false,
      lastCooldownRetryAt: 0,
    };
    this.stats = {
      totalLocks: 0,
      totalUnlocks: 0,
      blockedOpens: 0,
      autoExpires: 0,
      cooldownRetries: 0,
    };
  }
}

// Singleton instance for global use
let _instance = null;

/**
 * Get the singleton collateral lock manager
 * @param {Object} options - Options (only used on first call)
 * @returns {CollateralLockManager}
 */
function getCollateralLockManager(options = {}) {
  if (!_instance) {
    _instance = new CollateralLockManager(options);
  }
  return _instance;
}

module.exports = {
  CollateralLockManager,
  getCollateralLockManager,
};
