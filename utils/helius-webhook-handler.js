/**
 * Helius Webhook Handler
 * 
 * Receives and processes webhook events from Helius for Jupiter execution confirmations.
 * 
 * Setup:
 *   1. Configure webhook in Helius dashboard (see docs/HELIUS_WEBHOOK_SETUP.md)
 *   2. Set HELIUS_WEBHOOK_SECRET in .env
 *   3. Add route to ui-server.js: app.use('/webhooks', heliusWebhookHandler.router)
 */

const express = require('express');

class HeliusWebhookHandler {
  constructor(options = {}) {
    this.bot = options.bot || null;
    this.secret = options.secret || process.env.HELIUS_WEBHOOK_SECRET;
    this.enabled = options.enabled !== false && process.env.HELIUS_WEBHOOK_ENABLED !== 'false';
    
    // Track pending/confirmed executions
    this.pendingExecutions = new Map(); // txSignature -> { symbol, side, size, timestamp }
    this.confirmedExecutions = []; // Recent confirmed executions for debugging
    this.maxConfirmedHistory = 100;
    
    // Stats
    this.stats = {
      received: 0,
      processed: 0,
      errors: 0,
      lastEventTime: null
    };
    
    // Create Express router
    this.router = express.Router();
    this._setupRoutes();
    
    console.log(`[HeliusWebhook] Initialized (enabled: ${this.enabled})`);
  }

  _setupRoutes() {
    // Main webhook endpoint
    this.router.post('/helius', express.json({ limit: '10mb' }), (req, res) => {
      this._handleWebhook(req, res);
    });
    
    // Health check endpoint
    this.router.get('/helius/health', (req, res) => {
      res.json({
        enabled: this.enabled,
        stats: this.stats,
        pendingCount: this.pendingExecutions.size,
        recentConfirmed: this.confirmedExecutions.slice(0, 5)
      });
    });
  }

  _handleWebhook(req, res) {
    try {
      // Validate auth header if secret is configured
      if (this.secret) {
        const authHeader = req.headers['authorization'];
        if (authHeader !== this.secret && authHeader !== `Bearer ${this.secret}`) {
          console.warn('[HeliusWebhook] Unauthorized request - invalid auth header');
          return res.status(401).json({ error: 'Unauthorized' });
        }
      }

      const events = Array.isArray(req.body) ? req.body : [req.body];
      this.stats.received += events.length;
      this.stats.lastEventTime = new Date().toISOString();

      console.log(`[HeliusWebhook] Received ${events.length} event(s)`);

      for (const event of events) {
        this._processEvent(event);
      }

      this.stats.processed += events.length;
      res.status(200).json({ success: true, processed: events.length });
    } catch (error) {
      this.stats.errors++;
      console.error('[HeliusWebhook] Error processing webhook:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  _processEvent(event) {
    // Log event type for debugging
    const eventType = event.type || event.transactionType || 'unknown';
    const signature = event.signature || event.txSignature || 'unknown';
    
    console.log(`[HeliusWebhook] Processing: type=${eventType}, sig=${signature.slice(0, 20)}...`);

    // Check if this is a Jupiter perps transaction
    if (this._isJupiterPerpsEvent(event)) {
      this._processJupiterExecution(event);
    }
  }

  _isJupiterPerpsEvent(event) {
    // Jupiter Perps program IDs
    const JUPITER_PERPS_PROGRAMS = [
      'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu', // Jupiter Perps v1
      'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu', // Jupiter Perps v2
    ];

    // Check program involvement
    const programs = event.accountData?.map(a => a.account) || [];
    const instructions = event.instructions || [];
    
    for (const programId of JUPITER_PERPS_PROGRAMS) {
      if (programs.includes(programId)) return true;
      if (instructions.some(ix => ix.programId === programId)) return true;
    }

    // Check source field (enhanced webhook type)
    if (event.source === 'JUPITER_PERPS' || event.source === 'JUPITER') {
      return true;
    }

    // Check transaction type
    if (event.type === 'SWAP' && event.description?.toLowerCase().includes('perp')) {
      return true;
    }

    return false;
  }

  _processJupiterExecution(event) {
    const signature = event.signature || event.txSignature;
    const timestamp = event.timestamp || Date.now();

    // Extract execution details from enhanced event
    const execution = {
      txSignature: signature,
      timestamp,
      slot: event.slot,
      type: event.type,
      source: event.source,
      fee: event.fee,
      feePayer: event.feePayer,
      // Token transfers for position sizing
      tokenTransfers: event.tokenTransfers || [],
      // Native transfers
      nativeTransfers: event.nativeTransfers || [],
      // Account data changes
      accountData: event.accountData || [],
      // Raw instructions if available
      instructions: event.instructions || []
    };

    console.log(`[HeliusWebhook] Jupiter execution confirmed: ${signature.slice(0, 20)}...`);

    // Store in confirmed history
    this.confirmedExecutions.unshift({
      ...execution,
      processedAt: new Date().toISOString()
    });
    
    // Trim history
    if (this.confirmedExecutions.length > this.maxConfirmedHistory) {
      this.confirmedExecutions = this.confirmedExecutions.slice(0, this.maxConfirmedHistory);
    }

    // Notify bot if connected
    if (this.bot && typeof this.bot.onExecutionConfirmed === 'function') {
      try {
        this.bot.onExecutionConfirmed(execution);
      } catch (error) {
        console.error('[HeliusWebhook] Error notifying bot:', error.message);
      }
    }

    // Remove from pending if tracked
    if (this.pendingExecutions.has(signature)) {
      this.pendingExecutions.delete(signature);
      console.log(`[HeliusWebhook] Removed from pending: ${signature.slice(0, 20)}...`);
    }
  }

  /**
   * Track a pending execution (called by bot when submitting tx)
   */
  trackPendingExecution(txSignature, details) {
    this.pendingExecutions.set(txSignature, {
      ...details,
      trackedAt: Date.now()
    });
    console.log(`[HeliusWebhook] Tracking pending: ${txSignature.slice(0, 20)}...`);
  }

  /**
   * Check if an execution has been confirmed
   */
  isConfirmed(txSignature) {
    return this.confirmedExecutions.some(e => e.txSignature === txSignature);
  }

  /**
   * Get handler stats
   */
  getStats() {
    return {
      ...this.stats,
      pendingCount: this.pendingExecutions.size,
      confirmedCount: this.confirmedExecutions.length
    };
  }

  /**
   * Connect to bot instance
   */
  setBot(bot) {
    this.bot = bot;
    console.log('[HeliusWebhook] Connected to bot instance');
  }
}

// Singleton instance
let instance = null;

function getHeliusWebhookHandler(options = {}) {
  if (!instance) {
    instance = new HeliusWebhookHandler(options);
  }
  return instance;
}

module.exports = { HeliusWebhookHandler, getHeliusWebhookHandler };

