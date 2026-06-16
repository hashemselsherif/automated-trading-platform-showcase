// telegram-control.js
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { isValidTelegramUser, rateLimiter } = require('../../utils/auth');
const { sanitizeTelegramCallback } = require('../../utils/input-validator');
const { logCommand, logSecurityEvent, logAuth } = require('../../utils/audit-logger');

class TelegramControl {
  constructor(options = {}) {
    // Consistent environment detection across the codebase
    this.instanceEnvironment = this._detectEnvironment(options.environment);
    this.instanceId = options.instanceId || process.env.BOT_INSTANCE_ID || `${this.instanceEnvironment}-${process.pid}`;
    this.instanceScopeRaw = options.instanceScope || process.env.TELEGRAM_INSTANCE_SCOPE || 'auto';
    this.instanceScope = String(this.instanceScopeRaw).toLowerCase();
    this.instanceLabel = options.instanceLabel || this._formatInstanceLabel(this.instanceEnvironment);
    this.isRenderEnvironment = this.instanceEnvironment === 'render';
    this.lockPath = process.env.TELEGRAM_LOCK_PATH || '/tmp/jpbot-telegram.lock';
    this._lockRelease = null;
    this._lockFd = null;
    this._instanceAnnouncementSent = false;
    this._disabledReasons = [];

    // Trim token to avoid whitespace issues
    this.token = process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.trim() : null;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    const enabledByEnv = (process.env.TELEGRAM_ENABLED || 'true').toLowerCase() !== 'false';
    const environmentAllowed = this._isEnvironmentAllowed();

    // Log environment detection for debugging
    console.log(`📱 Telegram Environment Detection:`);
    console.log(`   Environment: ${this.instanceEnvironment} (${this.instanceLabel})`);
    console.log(`   Instance ID: ${this.instanceId}`);
    console.log(`   Instance Scope: ${this.instanceScopeRaw} (${this.instanceScope})`);
    console.log(`   Is Render: ${this.isRenderEnvironment}`);
    console.log(`   Token present: ${!!this.token}`);
    console.log(`   Chat ID present: ${!!this.chatId}`);

    if (!environmentAllowed) {
      this._disabledReasons.push(`environment '${this.instanceEnvironment}' not allowed by TELEGRAM_INSTANCE_SCOPE='${this.instanceScopeRaw}'`);
    }
    if (!enabledByEnv) {
      this._disabledReasons.push('explicitly disabled via TELEGRAM_ENABLED=false');
    }
    if (!(this.token && this.chatId)) {
      this._disabledReasons.push('missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    }
    this.enabled = enabledByEnv && environmentAllowed && !!(this.token && this.chatId);

    console.log(`   Telegram ${this.enabled ? 'ENABLED' : 'DISABLED'}`);
    if (!this.enabled && this._disabledReasons.length > 0) {
      console.log(`   Disabled reasons: ${this._disabledReasons.join('; ')}`);
    }

    this._bot = null;
    this._pendingApprovals = new Map(); // id -> {resolve,reject}
    this._commandCooldowns = new Map(); // userId -> lastCommandTime
    this.COOLDOWN_MS = Number(process.env.TELEGRAM_COMMAND_COOLDOWN_MS || 1000); // 1 second cooldown
    this._pollingActive = false; // Track polling state
  }

  _getSnapshotMarketPrice(snapshot, market) {
    const price = snapshot?.marketPrices?.[market]?.price;
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  async _resolveMarketPrice(botCtx, snapshot, market) {
    const snapPrice = this._getSnapshotMarketPrice(snapshot, market);
    if (snapPrice) return snapPrice;

    if (botCtx && typeof botCtx.getMarketPrice === 'function') {
      try {
        const price = await botCtx.getMarketPrice(market);
        return Number.isFinite(price) && price > 0 ? price : null;
      } catch (_) {
        // Ignore and return null
      }
    }
    return null;
  }

  _formatAgeMs(ageMs) {
    if (!Number.isFinite(ageMs) || ageMs < 0) return 'n/a';
    const seconds = Math.floor(ageMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  _formatPct(value, digits = 1) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
  }

  _shortWallet(wallet) {
    const value = String(wallet || '');
    if (value.length <= 14) return value;
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }

  _parseEnvBoolean(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return null;
  }

  _detectEnvironment(override) {
    // Allow explicit override first
    if (override) return String(override).toLowerCase().trim();

    // Check BOT_ENVIRONMENT env var
    if (process.env.BOT_ENVIRONMENT) {
      return String(process.env.BOT_ENVIRONMENT).toLowerCase().trim();
    }

    // Respect explicit render flags even if other indicators exist
    const renderFlag = this._parseEnvBoolean(process.env.RENDER);
    if (renderFlag === true) return 'render';
    if (renderFlag === false) return 'local';

    const isRenderFlag = this._parseEnvBoolean(process.env.IS_RENDER);
    if (isRenderFlag === true) return 'render';
    if (isRenderFlag === false) return 'local';

    // Render-specific hints (only used if no explicit flag set to false)
    const renderIndicators = [
      String(process.env.RENDER || '').trim().toLowerCase() === 'render',
      process.env.RENDER_MCP_API_KEY, // Render-specific env var
      process.env.RENDER_URL, // User-set Render URL
      process.env.UI_SERVER_URL && process.env.UI_SERVER_URL.includes('onrender.com'),
    ];

    if (renderIndicators.some(Boolean)) {
      return 'render';
    }

    // Default to local
    return 'local';
  }

  _isEnvironmentAllowed() {
    if (!this.instanceScope || this.instanceScope === 'auto') {
      return true;
    }

    const allowed = String(this.instanceScope)
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (allowed.length === 0) return true;
    return allowed.includes(this.instanceEnvironment);
  }

  _formatInstanceLabel(env) {
    if (!env) return null;
    const normalized = String(env).trim().toLowerCase();
    switch (normalized) {
      case 'render':
        return 'RENDER';
      case 'local':
        return 'LOCAL';
      case 'test':
        return 'TEST';
      default:
        return normalized.toUpperCase();
    }
  }

  async _announceInstanceOnline() {
    if (!this.enabled || this._instanceAnnouncementSent) return;
    this._instanceAnnouncementSent = true;

    const lines = [
      '🚀 *Telegram Controls Ready*',
      this.instanceLabel ? `*Environment:* ${this.instanceLabel}` : null,
      this.instanceId ? `*Instance ID:* \`${this.instanceId}\`` : null,
    ];

    if (this.instanceScope && this.instanceScope !== 'auto') {
      lines.push(`*Scope:* ${this.instanceScopeRaw}`);
    }

    const message = lines.filter(Boolean).join('\n');
    await this.say(message, { disableInstancePrefix: true });
  }

  // Force-cancel any existing long-polling connections by making a short getUpdates call
  async _cancelExistingPolling() {
    try {
      console.log('🔄 Cancelling any existing polling connections...');
      // Make a quick getUpdates call with offset=-1 and timeout=0
      // This forces Telegram to drop any ongoing long-poll and return immediately
      const response = await axios.get(`https://api.telegram.org/bot${this.token}/getUpdates`, {
        params: { offset: -1, timeout: 0 },
        timeout: Number(process.env.TELEGRAM_HTTP_TIMEOUT_MS || 5000),
      });
      const data = response.data;
      
      if (data.ok) {
        console.log('✅ Successfully cancelled existing polling connections');
        return true;
      } else {
        console.warn('⚠️ Failed to cancel polling:', data.description);
        return false;
      }
    } catch (error) {
      console.warn('⚠️ Error cancelling polling:', error.message);
      return false;
    }
  }

  // Verify bot is accessible and healthy before starting polling
  async _verifyBotHealth() {
    try {
      console.log('🏥 Verifying bot health...');
      const me = await this._bot.getMe();
      console.log(`✅ Bot verified: @${me.username} (${me.first_name})`);
      return true;
    } catch (error) {
      console.error('❌ Bot health check failed:', error.message);
      return false;
    }
  }

  // Start polling with robust retry logic to handle 409 conflicts on restart
  async _startPollingWithRetry(maxRetries = 8, initialDelay = 5000) {
    console.log('🔄 Attempting to start Telegram polling...');
    
    // Step 0: Verify bot is accessible
    const isHealthy = await this._verifyBotHealth();
    if (!isHealthy) {
      throw new Error('Bot health check failed - check TELEGRAM_BOT_TOKEN');
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Step 1: Delete any existing webhook and drop pending updates
        // This is CRITICAL - drop_pending_updates clears the update queue
        console.log(`[Attempt ${attempt}/${maxRetries}] Deleting webhook and clearing updates...`);
        await this._bot.deleteWebHook({ drop_pending_updates: true });
        
        // Step 2: Force-cancel any existing long-polling connections
        // This makes Telegram drop any ongoing getUpdates calls from previous instances
        console.log(`[Attempt ${attempt}/${maxRetries}] Cancelling existing polling...`);
        await this._cancelExistingPolling();
        
        // Step 3: Wait for Telegram to fully release the previous polling connection
        // Telegram's long-polling can hold connections for up to 30 seconds
        // We use exponential backoff: first attempt waits longer, then increases
        const delay = attempt === 1 
          ? initialDelay  // First attempt: wait 5 seconds
          : initialDelay * Math.pow(1.5, attempt - 1); // Subsequent: exponential backoff
        
        console.log(`[Attempt ${attempt}/${maxRetries}] Waiting ${Math.round(delay/1000)}s for connection release...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Step 4: Start polling
        console.log(`[Attempt ${attempt}/${maxRetries}] Starting polling...`);
        await this._bot.startPolling();
        this._pollingActive = true;
        console.log('✅ Telegram polling started successfully');
        
        // Verify polling is working by listening for first update
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            console.log('✅ Polling active (no test message needed)');
            resolve();
          }, 2000);
          
          this._bot.once('message', () => {
            clearTimeout(timeout);
            console.log('✅ Polling verified - received test message');
            resolve();
          });
        });
        
        return;
      } catch (error) {
        console.error(`[Attempt ${attempt}/${maxRetries}] Failed to start polling:`, error.message);
        
        // Stop any partial polling that might have started
        if (this._pollingActive) {
          try {
            await this._bot.stopPolling();
            this._pollingActive = false;
          } catch (e) {
            // Ignore errors when stopping
          }
        }
        
        // If this is a 409 error and not the last attempt, retry with longer delay
        if (error.message && error.message.includes('409') && attempt < maxRetries) {
          const retryDelay = initialDelay * Math.pow(1.8, attempt); // Aggressive exponential backoff
          console.log(`⏳ 409 Conflict detected. Retrying in ${Math.round(retryDelay/1000)}s...`);
          console.log(`   This usually means a previous instance is still polling.`);
          console.log(`   Waiting for Telegram to release the connection...`);
          
          // Alert on first 409 (with throttling)
          if (attempt === 1) {
            this.alert409(attempt, maxRetries, retryDelay).catch(() => {});
          }
          
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }
        
        // If we've exhausted retries or it's a different error, throw
        if (attempt === maxRetries) {
          throw new Error(`Failed to start Telegram polling after ${maxRetries} attempts: ${error.message}`);
        }
        
        // For non-409 errors, retry with normal delay
        if (attempt < maxRetries) {
          const retryDelay = 3000;
          console.log(`⏳ Retrying in ${retryDelay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
  }

  // Graceful shutdown - stop polling properly and clear state
  async shutdown() {
    if (!this._bot) {
      console.log('ℹ️ Telegram bot not initialized, nothing to shut down');
      return;
    }
    
    try {
      console.log('🛑 Stopping Telegram polling gracefully...');
      
      // Step 1: Stop polling if active
      if (this._pollingActive) {
        await this._bot.stopPolling({ cancel: true, reason: 'Graceful shutdown' });
        this._pollingActive = false;
        console.log('✅ Polling stopped');
      }
      
      // Step 2: Force-cancel any remaining polling connections
      await this._cancelExistingPolling();
      
      // Step 3: Clear pending approvals to prevent memory leaks
      if (this._pendingApprovals && this._pendingApprovals.size > 0) {
        console.log(`🧹 Clearing ${this._pendingApprovals.size} pending approvals`);
        this._pendingApprovals.clear();
      }
      
      if (this._lockRelease) {
        this._lockRelease();
        this._lockRelease = null;
      }
      
      // Step 4: Wait a moment to ensure cleanup completes
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log('✅ Telegram shutdown complete');
    } catch (error) {
      console.error('⚠️ Error during Telegram shutdown:', error.message);
      // Continue anyway - we're shutting down
    }
  }

  init(botCtx) {
    console.log(`📱 Telegram init → environment='${this.instanceEnvironment}', scope='${this.instanceScopeRaw}', instanceId='${this.instanceId}'`);
    
    // Store bot context for command handlers
    this.botContext = botCtx;
    
    if (!this.enabled) {
      const reason = this._disabledReasons.length ? this._disabledReasons.join('; ') : 'unknown reason';
      console.warn(`Telegram disabled: ${reason}`);
      return;
    }
    
    console.log(`📱 Telegram initialization starting...`);
    
    // Single-instance guard: prevent multiple processes from polling simultaneously
    // NOTE: This only works for local/same-machine instances, not for Render deployments
    // For Render, ensure only ONE service has TELEGRAM_POLLING=true (or omit for default true)
    const lockPath = this.lockPath;
    const isRender = this.isRenderEnvironment;
    
    // Skip lock file on Render - each deployment gets its own container
    if (!isRender) {
      try {
        const acquireLock = () => {
          this._lockFd = fs.openSync(lockPath, 'wx');
          fs.writeFileSync(this._lockFd, String(process.pid));
          // Ensure lock is released on exit
          this._lockRelease = () => {
            try {
              if (this._lockFd !== null && this._lockFd !== undefined) {
                fs.closeSync(this._lockFd);
                this._lockFd = null;
              }
            } catch (_) {}
            try { fs.unlinkSync(lockPath); } catch (_) {}
          };
          process.on('exit', this._lockRelease);
          process.on('SIGTERM', () => { this._lockRelease?.(); process.exit(0); });
          process.on('SIGINT', () => { this._lockRelease?.(); process.exit(0); });
          console.log('🔒 Acquired Telegram lock file - this instance will handle polling');
        };

        try {
          acquireLock();
        } catch (lockErr) {
          if (lockErr.code === 'EEXIST') {
            let existingPid = null;
            try {
              const contents = fs.readFileSync(lockPath, 'utf8').trim();
              existingPid = Number(contents);
            } catch (_) {
              existingPid = null;
            }

            if (existingPid) {
              try {
                process.kill(existingPid, 0);
                console.warn(`Telegram control not started: existing local instance (pid ${existingPid}) holds lock at ${lockPath}`);
                console.warn('   If you want this instance to handle Telegram, stop the other instance first.');
                return;
              } catch (_) {
                console.warn(`⚠️ Detected stale Telegram lock file with pid ${existingPid}. Cleaning up...`);
              }
            } else {
              console.warn('⚠️ Detected stale Telegram lock file (missing pid). Cleaning up...');
            }

            try { fs.unlinkSync(lockPath); } catch (_) {}
            acquireLock();
          } else {
            throw lockErr;
          }
        }
      } catch (e) {
        console.warn(`Telegram control not started: unable to acquire lock at ${lockPath}`);
        console.warn(`   Reason: ${e.message}`);
        return;
      }
    } else {
      console.log('🌐 Running on Render - no lock file needed (isolated containers)');
    }

    // Determine if polling should be enabled
    // Default: true for both local and render, but can be explicitly disabled
    let pollingEnabled = (process.env.TELEGRAM_POLLING || 'true').toLowerCase() !== 'false';

    // Auto-disable local polling if we detect Render might be running, unless explicitly forced local
    if (!isRender && pollingEnabled) {
      const renderIndicators = [
        process.env.RENDER_MCP_API_KEY,
        process.env.RENDER_URL,
        process.env.UI_SERVER_URL?.includes('onrender.com')
      ].filter(Boolean);

      const explicitRenderFlag = this._parseEnvBoolean(process.env.RENDER);
      const explicitBotEnv = process.env.BOT_ENVIRONMENT ? String(process.env.BOT_ENVIRONMENT).trim().toLowerCase() : null;
      const explicitlyLocal = explicitRenderFlag === false || explicitBotEnv === 'local';

      if (!explicitlyLocal && renderIndicators.length > 0) {
        console.warn('⚠️ Detected Render environment indicators while running locally');
        console.warn('   This suggests Render deployment may be active. To avoid 409 conflicts:');
        console.warn('   - Either stop the Render deployment, OR');
        console.warn('   - Set TELEGRAM_POLLING=false in local .env file');
        console.warn('   Auto-disabling local polling to prevent conflicts...');
        pollingEnabled = false;
      }
    }
    
    // Validate token format before creating bot
    if (!this.token || !this.token.includes(':')) {
      console.error('❌ TELEGRAM_BOT_TOKEN is invalid. Format should be: 123456789:ABCdef...');
      console.error('   Get a new token from @BotFather: https://t.me/BotFather');
      return;
    }
    
    try {
      console.log(`📱 Polling decision: ${pollingEnabled ? 'ENABLED' : 'DISABLED'}`);

      // Always create the bot instance for sending messages, regardless of polling
      this._bot = new TelegramBot(this.token, { polling: { autoStart: false } });

      if (!pollingEnabled) {
        const reason = process.env.TELEGRAM_POLLING ?
          'explicitly disabled via TELEGRAM_POLLING=false' :
          'auto-disabled due to Render environment indicators';
        console.warn(`Telegram polling disabled: ${reason}`);
        console.warn('   This instance will not poll for messages, but can still send notifications');
        // Skip polling setup but keep bot for sending messages
        return;
      }

      // Create bot without auto-start; clear webhook explicitly to avoid 409 conflicts

      // Robust webhook deletion with retry and delay to avoid 409 conflicts
      // This is critical for Render/cloud deployments where restarts are frequent
      this._startPollingWithRetry()
        .then(() => this._announceInstanceOnline())
        .catch((e) => {
          console.error('Failed to start Telegram polling after retries:', e.message);
        });

      // Handle polling errors
      this._bot.on('polling_error', (error) => {
        if (error.code === 'ETELEGRAM' && error.message.includes('401')) {
          console.error('\n❌ TELEGRAM BOT TOKEN INVALID!\n');
          console.error('   Error: 401 Unauthorized - invalid token specified');
          console.error('\n   Possible causes:');
          console.error('   1. Token copied incorrectly (extra spaces, missing characters)');
          console.error('   2. Token was revoked or regenerated');
          console.error('   3. Wrong token in .env file');
          console.error('\n   Solutions:');
          console.error('   1. Check your .env file - remove any extra spaces');
          console.error('   2. Get a new token from @BotFather:');
          console.error('      - Message @BotFather on Telegram');
          console.error('      - Send: /token');
          console.error('      - Select your bot');
          console.error('      - Copy the new token');
          console.error('   3. Validate token: npm run validate-telegram-token');
          console.error('\n');
          
          // Alert critical error
          this.alertCriticalError(error, {
            category: 'Telegram',
            severity: 'CRITICAL',
            action: 'Check TELEGRAM_BOT_TOKEN',
            impact: 'Telegram commands unavailable'
          }).catch(() => {});
        } else if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
          console.error('Telegram polling error: 409 Conflict – another instance is calling getUpdates or a webhook is configured.');
          console.error('   Actions: ensure only one deployment uses this bot token, or disable polling (TELEGRAM_POLLING=false) in non-primary envs.');
          console.error('   If a webhook was configured previously, it will be cleared on startup; wait a few seconds and the error should stop if no other pollers exist.');
          // Note: 409 alerts are sent from _startPollingWithRetry, not here (avoid spam)
        } else {
          console.error('Telegram polling error:', error.message);
          
          // Alert network issues
          if (error.code === 'EFATAL' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
            this.alertNetworkIssue(`Telegram ${error.code}: ${error.message}`, 0).catch(() => {});
          }
        }
      });
    } catch (error) {
      console.error('Failed to initialize Telegram bot:', error.message);
      return;
    }

    // Helper to check authorization and rate limiting
    const checkAuthAndRateLimit = (msg, command) => {
      const userId = msg.from?.id;
      
      if (!userId) {
        logAuth(false, { source: 'telegram', command, reason: 'no_user_id' });
        return false;
      }

      // Check user authorization
      if (!isValidTelegramUser(userId)) {
        logAuth(false, { source: 'telegram', command, userId, reason: 'unauthorized_user' });
        this.say(`❌ Unauthorized. Your user ID ${userId} is not in the allowed users list.`);
        return false;
      }

      // Rate limiting check
      if (!rateLimiter.isAllowed(`telegram:${userId}`)) {
        logSecurityEvent('rate_limit_exceeded', { source: 'telegram', userId, command });
        this.say('⚠️ Rate limit exceeded. Please wait before sending another command.');
        return false;
      }

      // Cooldown check for critical commands
      if (['pause', 'resume', 'closeall'].includes(command)) {
        const lastCommand = this._commandCooldowns.get(userId) || 0;
        const timeSinceLastCommand = Date.now() - lastCommand;
        
        if (timeSinceLastCommand < this.COOLDOWN_MS) {
          const waitTime = Math.ceil((this.COOLDOWN_MS - timeSinceLastCommand) / 1000);
          this.say(`⏳ Please wait ${waitTime} second(s) before using this command again.`);
          return false;
        }
        
        this._commandCooldowns.set(userId, Date.now());
      }

      return true;
    };

    // Commands
    this._bot.onText(/^\/start$/i, (msg) => {
      const userId = msg.from?.id;
      logCommand('start', 'telegram', { userId });
      
      if (checkAuthAndRateLimit(msg, 'start')) {
        const s = botCtx.statusSnapshot();
        const mode = s.mode.toUpperCase();
        const status = s.paused ? 'PAUSED ⏸️' : 'RUNNING ▶️';
        this.say(
          `🤖 *Jupiter Perps Bot*\n\n` +
          `Status: ${status}\n` +
          `Mode: ${mode}\n` +
          `Markets: ${s.markets.length}\n` +
          `Positions: ${s.positions}/${s.posCap}\n\n` +
          `Use /help to see available commands.`
        );
      }
    });

    this._bot.onText(/^\/help$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'help')) return;
      
      logCommand('help', 'telegram', { userId: msg.from?.id });
      this.say(
        `📚 *Available Commands*\n\n` +
        `*Status & Info*\n` +
        `/status - Full bot status\n` +
        `/leaders - Wallet-following leaders\n` +
        `/followhealth - Wallet-following tracker health\n` +
        `/markets - All market prices\n` +
        `/positions - Open positions details\n` +
        `/manual - Manual positions only\n` +
        `/performance - Performance metrics\n` +
        `/portfolio - Portfolio risk analysis\n\n` +
        `*Manual Trading*\n` +
        `/open - Open manual position\n` +
        `/close - Close specific position\n\n` +
        `*Control*\n` +
        `/pause - Pause trading\n` +
        `/resume - Resume trading\n` +
        `/closeall - Close all positions\n\n` +
        `*Other*\n` +
        `/help - Show this message\n` +
        `/ping - Check bot responsiveness`
      );
    });

    this._bot.onText(/^\/ping$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'ping')) return;
      
      logCommand('ping', 'telegram', { userId: msg.from?.id });
      const startTime = Date.now();
      this.say('🏓 Pong!').then(() => {
        const latency = Date.now() - startTime;
        this.say(`Response time: ${latency}ms`);
      });
    });

    this._bot.onText(/^\/status$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'status')) return;
      
      logCommand('status', 'telegram', { userId: msg.from?.id });
      try {
        const s = botCtx.statusSnapshot();
        const freeCapital = s.freeCapital !== undefined ? s.freeCapital : (s.balance || 0);
        const lockedCapital = s.lockedCapital || 0;
        const totalEquity = s.totalEquity || (freeCapital + lockedCapital);
        const utilizationPct = totalEquity > 0 ? (lockedCapital / totalEquity * 100) : 0;
        const walletFollowing = s.walletFollowing || null;
        const tracker = walletFollowing?.tracker || null;
        const sourceType = tracker?.source?.type === 'wallet-following-watchlist' ? 'WATCHLIST' : 'TOPK';
        const sourceSymbol = tracker?.source?.symbol || tracker?.targetSymbols?.[0] || null;
        const trackerLabel = tracker?.product === 'btc_read_only_wallet_following' ? 'BTC Read-Only' : 'Wallet Following';
        
        // Calculate total P&L from positions
        let totalUnrealizedPnL = 0;
        const positions = s.openPositions || [];
        positions.forEach(p => {
          const market = p.market || s.market;
          const currentPrice = this._getSnapshotMarketPrice(s, market);
          if (currentPrice && p.entryPrice && p.size) {
            const pnl = p.side.toLowerCase() === 'long' 
              ? (currentPrice - p.entryPrice) * (p.size / p.entryPrice)
              : (p.entryPrice - currentPrice) * (p.size / p.entryPrice);
            totalUnrealizedPnL += pnl;
          }
        });
        
        // Format time since last tick
        const lastTickAgo = s.lastTickTs ? Math.floor((Date.now() - s.lastTickTs) / 1000) : 0;
        const tickStatus = lastTickAgo < 30 ? '🟢' : lastTickAgo < 60 ? '🟡' : '🔴';
        
        this.say(
          `📈 *Bot Status* ${s.paused ? '⏸️' : '▶️'}\n\n` +
          `*System*\n` +
          `Mode: ${s.mode.toUpperCase()}/${s.execMode.toUpperCase()}\n` +
          `Status: ${s.paused ? 'PAUSED' : 'ACTIVE'}\n` +
          `Last Update: ${tickStatus} ${lastTickAgo}s ago\n\n` +
          `*Trading*\n` +
          `Markets: ${s.markets.join(', ')}\n` +
          `Positions: ${s.positions}/${s.posCap}\n` +
          `Daily Trades: ${s.dailyTrades}/${s.dailyCap}\n\n` +
          (tracker
            ? `*${trackerLabel}*\n` +
              `Source: ${sourceType}${sourceSymbol ? ` (${sourceSymbol})` : ''}\n` +
              `Core ${tracker.coreTopK || 0} | Watch ${tracker.watchTopK || tracker.topK || 0}\n` +
              `Watch Health: ${tracker.active} active / ${tracker.stale} stale / ${tracker.missing} missing\n` +
              `Core Health: ${(tracker.core?.active || 0)} active / ${(tracker.core?.stale || 0)} stale / ${(tracker.core?.missing || 0)} missing\n\n`
            : '') +
          `*Capital*\n` +
          `Total Equity: $${totalEquity.toFixed(2)}\n` +
          `Free Capital: $${freeCapital.toFixed(2)}\n` +
          `Locked: $${lockedCapital.toFixed(2)} (${utilizationPct.toFixed(1)}%)\n` +
          (totalUnrealizedPnL !== 0 ? `Unrealized P&L: ${totalUnrealizedPnL >= 0 ? '+' : ''}$${totalUnrealizedPnL.toFixed(2)}\n` : '') +
          (s.mode === 'paper' ? `\n💰 Paper Balance: $${s.balance.toFixed(2)}` : '')
        );
      } catch (error) {
        console.error('Error in /status command:', error);
        this.say('❌ Error fetching status. Please try again.');
      }
    });

    this._bot.onText(/^\/leaders(?:\s+(.+))?$/i, (msg, match) => {
      if (!checkAuthAndRateLimit(msg, 'leaders')) return;

      logCommand('leaders', 'telegram', { userId: msg.from?.id, rawArgs: match?.[1] || null });
      try {
        const s = botCtx.statusSnapshot();
        const walletFollowing = s.walletFollowing || null;
        const tracker = walletFollowing?.tracker || null;
        const leadersBySymbol = walletFollowing?.leadersBySymbol || {};
        const coreLeadersBySymbol = walletFollowing?.coreLeadersBySymbol || {};
        const tokens = String(match?.[1] || '')
          .trim()
          .split(/\s+/)
          .map((token) => token.trim())
          .filter(Boolean);
        const requestedTier = tokens.find((token) => /^(core|watch)$/i.test(token)) || 'core';
        const requestedSymbol =
          tokens
            .map((token) => token.toUpperCase().replace(/-PERP$/i, ''))
            .find((token) => /^[A-Z]{2,10}$/.test(token) && !['CORE', 'WATCH'].includes(token)) || '';
        const defaultSymbol =
          requestedSymbol ||
          tracker?.source?.symbol ||
          tracker?.targetSymbols?.[0] ||
          Object.keys(leadersBySymbol)[0] ||
          'BTC';
        const tier = requestedTier.toLowerCase() === 'watch' ? 'watch' : 'core';
        const leadersSource = tier === 'core' ? coreLeadersBySymbol : leadersBySymbol;
        const leaders = Array.isArray(leadersSource[defaultSymbol]) ? leadersSource[defaultSymbol] : [];

        if (!tracker) {
          return this.say('ℹ️ Wallet-following tracker is not available in the current bot status.');
        }

        if (!leaders.length) {
          const available = Object.keys(leadersBySymbol);
          return this.say(
            `ℹ️ No leaders available for ${defaultSymbol}.` +
            (available.length ? ` Available symbols: ${available.join(', ')}` : '')
          );
        }

        const lines = [
          `📡 *Wallet Leaders* (${defaultSymbol} / ${tier.toUpperCase()})`,
          `Product: ${tracker?.product === 'btc_read_only_wallet_following' ? 'BTC read-only wallet following' : 'wallet following'}`,
          `Source: ${tracker?.source?.type === 'wallet-following-watchlist' ? 'WATCHLIST' : 'TOPK'}`,
          `Generated: ${tracker?.source?.generatedAt ? this._formatAgeMs(Date.now() - Date.parse(tracker.source.generatedAt)) + ' ago' : 'n/a'}`,
          `Health: ${tier === 'core'
            ? `${tracker.core?.active || 0} active / ${tracker.core?.stale || 0} stale / ${tracker.core?.missing || 0} missing`
            : `${tracker.active} active / ${tracker.stale} stale / ${tracker.missing} missing`}`,
          '',
        ];

        for (const leader of leaders.slice(0, tier === 'core' ? 6 : 10)) {
          const sideEmoji =
            leader.positionDir === 'long' ? '🟢' : leader.positionDir === 'short' ? '🔴' : '⚪️';
          const statusEmoji =
            leader.status === 'active' ? '🟢' : leader.status === 'stale' ? '🟡' : '🔴';
          lines.push(
            `${leader.rank}. \`${this._shortWallet(leader.wallet)}\` ${statusEmoji} ${sideEmoji} ${leader.positionDir.toUpperCase()}`
          );
          lines.push(
            `w ${this._formatPct(leader.weight, 1)} | inv ${Number(leader.metadata?.investableScore || 0).toFixed(3)} | score ${Number(leader.metadata?.score || 0).toFixed(3)} | trades ${leader.metadata?.trades || 0}`
          );
          lines.push(
            `exp ${leader.metadata?.expectancyUsd != null ? `$${Number(leader.metadata.expectancyUsd).toFixed(2)}` : 'n/a'} | persist ${leader.metadata?.persistenceScore != null ? Number(leader.metadata.persistenceScore).toFixed(2) : 'n/a'} | last fill ${leader.metadata?.lastFillAgeDays != null ? `${Number(leader.metadata.lastFillAgeDays).toFixed(1)}d` : 'n/a'}`
          );
          lines.push(
            `cluster ${leader.metadata?.clusterId || 'n/a'} | family ${leader.metadata?.familyId || 'n/a'} | pos $${Number(leader.positionNotional || 0).toFixed(0)} | ws ${this._formatAgeMs(leader.lastUpdateAgeMs)} ago`
          );
          lines.push('');
        }

        this.say(lines.join('\n'));
      } catch (error) {
        console.error('Error in /leaders command:', error);
        this.say('❌ Error fetching wallet-following leaders. Please try again.');
      }
    });

    this._bot.onText(/^\/followhealth$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'followhealth')) return;

      logCommand('followhealth', 'telegram', { userId: msg.from?.id });
      try {
        const s = botCtx.statusSnapshot();
        const tracker = s.walletFollowing?.tracker || null;
        if (!tracker) {
          return this.say('ℹ️ Wallet-following tracker is not available in the current bot status.');
        }

        const source = tracker.source || {};
        const generatedAtMs = source.generatedAt ? Date.parse(source.generatedAt) : null;
        const meta = source.meta || {};
        const wsEmoji = tracker.wsConnected ? '🟢' : '🔴';

        this.say(
          `🩺 *Wallet-Following Health*\n\n` +
          `Product: ${tracker.product === 'btc_read_only_wallet_following' ? 'BTC read-only wallet following' : 'wallet following'}\n` +
          `Mode: ${(tracker.mode || 'read_only').toUpperCase()}\n` +
          `Source: ${(source.type || 'unknown').toUpperCase()}\n` +
          `Symbol: ${source.symbol || tracker.targetSymbols?.join(', ') || 'n/a'}\n` +
          `Generated: ${generatedAtMs ? `${this._formatAgeMs(Date.now() - generatedAtMs)} ago` : 'n/a'}\n` +
          `WS: ${wsEmoji} ${tracker.wsConnected ? 'connected' : 'disconnected'}\n\n` +
          `Core Leaders: ${tracker.coreTopK || 0}\n` +
          `Watch Leaders: ${tracker.watchTopK || tracker.topK || 0}\n` +
          `Core Health: ${(tracker.core?.active || 0)} active / ${(tracker.core?.stale || 0)} stale / ${(tracker.core?.missing || 0)} missing\n` +
          `Watch Health: ${tracker.active} active / ${tracker.stale} stale / ${tracker.missing} missing\n` +
          `Tracked Positions: ${tracker.positions}\n\n` +
          `Selection: ${meta.selectionLookbackDays || 'n/a'}d ${meta.rankMetric || 'n/a'} / ${meta.weightMode || 'n/a'}\n` +
          `Ranking Model: ${meta.rankingModel || 'n/a'}\n` +
          `Core/Watch Requested: ${meta.coreTopKRequested || tracker.coreTopK || 0} / ${meta.watchTopKRequested || tracker.watchTopK || tracker.topK || 0}\n` +
          `Freshness Gate: ${meta.selectionMaxLastFillAgeDays ?? 'n/a'}d\n` +
          `Min Trades: ${meta.selectionMinTrades ?? 'n/a'}\n` +
          `Activity Days Floor: ${meta.selectionMinActivityDays ?? 'n/a'}\n` +
          `Core Caps: cluster ${meta.coreCaps?.maxPerCluster ?? 'n/a'} / family ${meta.coreCaps?.maxPerFamily ?? 'n/a'}\n` +
          `Watch Caps: cluster ${meta.watchCaps?.maxPerCluster ?? 'n/a'} / family ${meta.watchCaps?.maxPerFamily ?? 'n/a'}\n` +
          `Alert Policy: core-only, rel ${tracker.alertPolicy?.relativeSizeThreshold ?? 'n/a'}, abs $${tracker.alertPolicy?.absoluteNotionalFloorUsd ?? 'n/a'}, normal ${tracker.alertPolicy?.leaderNormalSizeFloorPct ?? 'n/a'}`
        );
      } catch (error) {
        console.error('Error in /followhealth command:', error);
        this.say('❌ Error fetching wallet-following health. Please try again.');
      }
    });

    this._bot.onText(/^\/markets$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'markets')) return;
      
      logCommand('markets', 'telegram', { userId: msg.from?.id });
      try {
        const s = botCtx.statusSnapshot();
        const markets = s.markets || [];
        
        if (!markets.length) {
          return this.say('No markets configured.');
        }
        
        let marketText = `📊 *Market Prices*\n\n`;
        
        for (const market of markets) {
          const priceData = s.marketPrices[market];
          const perfData = s.marketPerformance[market] || {};
          
          if (priceData) {
            const price = priceData.price;
            const volume = priceData.volume ? `$${(priceData.volume / 1000000).toFixed(2)}M` : 'N/A';
            const winRate = perfData.totalTrades > 0 ? `${(perfData.winRate * 100).toFixed(1)}%` : 'N/A';
            const trades = perfData.totalTrades || 0;
            
            marketText += `*${market}*\n`;
            marketText += `Price: $${price.toFixed(4)}\n`;
            marketText += `Volume: ${volume}\n`;
            marketText += `Win Rate: ${winRate} (${trades} trades)\n\n`;
          }
        }
        
        this.say(marketText);
      } catch (error) {
        console.error('Error in /markets command:', error);
        this.say('❌ Error fetching market data. Please try again.');
      }
    });

    this._bot.onText(/^\/positions$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'positions')) return;
      
      logCommand('positions', 'telegram', { userId: msg.from?.id });
      try {
        const s = botCtx.statusSnapshot();
        const list = s.openPositions || [];
        
        if (!list.length) {
          return this.say('📭 No open positions.');
        }
        
        let posText = `📊 *Open Positions* (${list.length}/${s.posCap})\n\n`;
        
        list.forEach((p, idx) => {
          const market = p.market || s.market;
          const currentPrice = this._getSnapshotMarketPrice(s, market);
          const side = p.side.toUpperCase();
          const sideEmoji = side === 'LONG' ? '🟢' : '🔴';
          
          // Calculate P&L
          let pnl = 0;
          let pnlPct = 0;
          if (currentPrice && p.entryPrice && p.size) {
            pnl = p.side.toLowerCase() === 'long' 
              ? (currentPrice - p.entryPrice) * (p.size / p.entryPrice)
              : (p.entryPrice - currentPrice) * (p.size / p.entryPrice);
            pnlPct = (pnl / p.collateral) * 100;
          }
          
          const pnlSign = pnl >= 0 ? '+' : '';
          const pnlEmoji = pnl >= 0 ? '💚' : '💔';
          
          // Calculate duration
          const duration = p.openTime ? Math.floor((Date.now() - p.openTime) / 1000 / 60) : 0;
          const durationText = duration < 60 ? `${duration}m` : `${Math.floor(duration / 60)}h ${duration % 60}m`;
          
          posText += `${sideEmoji} *${market}* ${side}\n`;
          posText += `ID: \`${p.positionId.slice(0, 8)}\`\n`;
          posText += `Entry: $${(p.entryPrice || 0).toFixed(4)}\n`;
          posText += `Current: $${(currentPrice || 0).toFixed(4)}\n`;
          posText += `Size: $${(p.size || 0).toFixed(2)} (${p.leverage}x)\n`;
          posText += `Collateral: $${(p.collateral || 0).toFixed(2)}\n`;
          posText += `${pnlEmoji} P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)\n`;
          posText += `Liq: $${(p.liquidationPrice || 0).toFixed(4)}\n`;
          posText += `Duration: ${durationText}\n`;
          
          if (idx < list.length - 1) posText += '\n';
        });
        
        this.say(posText);
      } catch (error) {
        console.error('Error in /positions command:', error);
        this.say('❌ Error fetching positions. Please try again.');
      }
    });

    this._bot.onText(/^\/performance$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'performance')) return;
      
      logCommand('performance', 'telegram', { userId: msg.from?.id });
      try {
        const s = botCtx.statusSnapshot();
        const perf = s.marketPerformance || {};
        
        // Aggregate performance across all markets
        let totalTrades = 0;
        let totalWins = 0;
        let totalPnL = 0;
        
        Object.values(perf).forEach(m => {
          totalTrades += m.totalTrades || 0;
          totalWins += Math.round((m.winRate || 0) * (m.totalTrades || 0));
          totalPnL += (m.avgPnL || 0) * (m.totalTrades || 0);
        });
        
        const winRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
        const avgPnL = totalTrades > 0 ? (totalPnL / totalTrades) : 0;
        
        let perfText = `📈 *Performance Summary*\n\n`;
        perfText += `*Overall*\n`;
        perfText += `Total Trades: ${totalTrades}\n`;
        perfText += `Win Rate: ${winRate.toFixed(1)}%\n`;
        perfText += `Avg P&L: $${avgPnL.toFixed(2)}\n`;
        perfText += `Total P&L: $${totalPnL.toFixed(2)}\n\n`;
        
        perfText += `*Per Market*\n`;
        Object.entries(perf).forEach(([market, data]) => {
          if (data.totalTrades > 0) {
            perfText += `${market}: ${(data.winRate * 100).toFixed(1)}% (${data.totalTrades} trades)\n`;
          }
        });
        
        this.say(perfText);
      } catch (error) {
        console.error('Error in /performance command:', error);
        this.say('❌ Error fetching performance data. Please try again.');
      }
    });

    this._bot.onText(/^\/portfolio$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'portfolio')) return;
      
      logCommand('portfolio', 'telegram', { userId: msg.from?.id });
      try {
        const s = botCtx.statusSnapshot();
        const portfolio = s.portfolio || {};
        
        let portText = `💼 *Portfolio Risk*\n\n`;
        
        if (portfolio.totalLeverage !== undefined) {
          portText += `Total Leverage: ${portfolio.totalLeverage.toFixed(2)}x\n`;
        }
        if (portfolio.totalExposure !== undefined) {
          portText += `Total Exposure: $${portfolio.totalExposure.toFixed(2)}\n`;
        }
        if (portfolio.concentrationRisk !== undefined) {
          portText += `Concentration Risk: ${(portfolio.concentrationRisk * 100).toFixed(1)}%\n`;
        }
        if (portfolio.marginUtilization !== undefined) {
          portText += `Margin Utilization: ${(portfolio.marginUtilization * 100).toFixed(1)}%\n`;
        }
        
        // Position distribution
        const positions = s.openPositions || [];
        if (positions.length > 0) {
          const longs = positions.filter(p => p.side.toLowerCase() === 'long').length;
          const shorts = positions.filter(p => p.side.toLowerCase() === 'short').length;
          portText += `\nPosition Distribution:\n`;
          portText += `🟢 Longs: ${longs}\n`;
          portText += `🔴 Shorts: ${shorts}\n`;
        }
        
        this.say(portText);
      } catch (error) {
        console.error('Error in /portfolio command:', error);
        this.say('❌ Error fetching portfolio data. Please try again.');
      }
    });

    this._bot.onText(/^\/pause$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'pause')) return;
      
      logCommand('pause', 'telegram', { userId: msg.from?.id });
      logSecurityEvent('bot_pause', { source: 'telegram', userId: msg.from?.id });
      
      try {
        const s = botCtx.statusSnapshot();
        if (s.paused) {
          return this.say('ℹ️ Bot is already paused.');
        }
        
        botCtx.pause();
        this.say(
          `⏸️ *Bot Paused*\n\n` +
          `Trading suspended.\n` +
          `Open positions: ${s.positions}\n` +
          `Use /resume to continue trading.`
        );
      } catch (error) {
        console.error('Error in /pause command:', error);
        this.say('❌ Error pausing bot. Please try again.');
      }
    });

    this._bot.onText(/^\/resume$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'resume')) return;
      
      logCommand('resume', 'telegram', { userId: msg.from?.id });
      logSecurityEvent('bot_resume', { source: 'telegram', userId: msg.from?.id });
      
      try {
        const s = botCtx.statusSnapshot();
        if (!s.paused) {
          return this.say('ℹ️ Bot is already running.');
        }
        
        botCtx.resume();
        this.say(
          `▶️ *Bot Resumed*\n\n` +
          `Trading active.\n` +
          `Markets: ${s.markets.join(', ')}\n` +
          `Daily trades: ${s.dailyTrades}/${s.dailyCap}`
        );
      } catch (error) {
        console.error('Error in /resume command:', error);
        this.say('❌ Error resuming bot. Please try again.');
      }
    });

    this._bot.onText(/^\/closeall$/i, async (msg) => {
      if (!checkAuthAndRateLimit(msg, 'closeall')) return;
      
      const userId = msg.from?.id;
      logCommand('closeall', 'telegram', { userId });
      
      try {
        const s = botCtx.statusSnapshot();
        const positions = s.openPositions || [];
        
        if (positions.length === 0) {
          return this.say('ℹ️ No open positions to close.');
        }
        
        // Calculate total locked capital
        let totalLocked = 0;
        let totalPnL = 0;
        positions.forEach(p => {
          totalLocked += p.collateral || 0;
          const market = p.market || s.market;
          const currentPrice = this._getSnapshotMarketPrice(s, market);
          if (currentPrice && p.entryPrice && p.size) {
            const pnl = p.side.toLowerCase() === 'long' 
              ? (currentPrice - p.entryPrice) * (p.size / p.entryPrice)
              : (p.entryPrice - currentPrice) * (p.size / p.entryPrice);
            totalPnL += pnl;
          }
        });
        
        logSecurityEvent('close_all_positions', { source: 'telegram', userId, positionCount: positions.length });
        
        // Critical command - require confirmation with details
        const pnlText = totalPnL >= 0 
          ? `+$${totalPnL.toFixed(2)} 💚` 
          : `-$${Math.abs(totalPnL).toFixed(2)} 💔`;
        
        this.say(
          `⚠️ *WARNING: Close ALL Positions*\n\n` +
          `This will close ${positions.length} position(s):\n` +
          `Locked Capital: $${totalLocked.toFixed(2)}\n` +
          `Current P&L: ${pnlText}\n\n` +
          `Reply with "CONFIRM" to proceed,\n` +
          `or anything else to cancel.\n\n` +
          `⏰ Timeout: 60 seconds`,
          {
            reply_markup: {
              force_reply: true,
            },
          }
        );

        // Wait for confirmation with timeout
        const confirmTimeout = setTimeout(() => {
          this.say('⏰ Close all request timed out. Operation cancelled.');
        }, 60000);

        this._bot.once('message', async (confirmMsg) => {
          clearTimeout(confirmTimeout);
          
          if (confirmMsg.from?.id !== userId) return; // Only accept from same user
          
          if (confirmMsg.text?.toUpperCase() === 'CONFIRM') {
            this.say('🔄 Closing positions...');
            try {
              await botCtx.closeAll('telegram_closeall');
              this.say(
                `✅ *All Positions Closed*\n\n` +
                `Closed: ${positions.length} position(s)\n` +
                `Released Capital: $${totalLocked.toFixed(2)}\n` +
                `Final P&L: ${pnlText}`
              );
            } catch (error) {
              console.error('Error closing positions:', error);
              this.say('❌ Error closing positions. Some positions may still be open. Check /positions.');
            }
          } else {
            this.say('❌ Close all operation cancelled.');
          }
        });
      } catch (error) {
        console.error('Error in /closeall command:', error);
        this.say('❌ Error processing close all request. Please try again.');
      }
    });

    // Manual Trade Commands
    this._bot.onText(/^\/manual$/i, (msg) => {
      if (!checkAuthAndRateLimit(msg, 'manual')) return;
      
      logCommand('manual', 'telegram', { userId: msg.from?.id });
      try {
        const s = botCtx.statusSnapshot();
        const positions = (s.openPositions || []).filter(p => p.trade_type === 'manual' || p.mode === 'manual');
        
        if (positions.length === 0) {
          return this.say('ℹ️ No manual positions open.\n\nUse /open to create one.');
        }
        
        let msg = `📊 *Manual Positions (${positions.length})*\n\n`;
        
        positions.forEach((p, idx) => {
          const market = p.market || s.market;
          const currentPrice = this._getSnapshotMarketPrice(s, market);
          const sideEmoji = p.side.toLowerCase() === 'long' ? '🟢' : '🔴';
          
          let pnlUsd = 0;
          let pnlPct = 0;
          if (currentPrice && p.entryPrice && p.size) {
            pnlUsd = p.side.toLowerCase() === 'long' 
              ? (currentPrice - p.entryPrice) * (p.size / p.entryPrice)
              : (p.entryPrice - currentPrice) * (p.size / p.entryPrice);
            pnlPct = p.collateral ? (pnlUsd / p.collateral) * 100 : 0;
          }
          
          const pnlText = pnlUsd >= 0 
            ? `+$${pnlUsd.toFixed(2)} (+${pnlPct.toFixed(1)}%)` 
            : `-$${Math.abs(pnlUsd).toFixed(2)} (${pnlPct.toFixed(1)}%)`;
          
          msg += `${idx + 1}. ${sideEmoji} *${market} ${p.side.toUpperCase()}*\n`;
          msg += `   Collateral: $${p.collateral?.toFixed(2) || 'N/A'}\n`;
          msg += `   Leverage: ${p.leverage}x\n`;
          msg += `   Entry: $${p.entryPrice?.toFixed(4) || 'N/A'}\n`;
          msg += `   Current: $${currentPrice?.toFixed(4) || 'N/A'}\n`;
          msg += `   P&L: ${pnlText}\n`;
          msg += `   ID: \`${p.positionId?.substring(0, 8)}...\`\n\n`;
        });
        
        msg += `Use /close to close a position.`;
        this.say(msg);
      } catch (error) {
        console.error('Error in /manual command:', error);
        this.say('❌ Error fetching manual positions.');
      }
    });

    this._bot.onText(/^\/open$/i, async (msg) => {
      if (!checkAuthAndRateLimit(msg, 'open')) return;
      
      const userId = msg.from?.id;
      logCommand('open', 'telegram', { userId });
      
      try {
        const s = botCtx.statusSnapshot();
        
        // Check if bot is paused
        if (s.paused) {
          return this.say('⏸️ Bot is paused. Resume first with /resume');
        }
        
        // Show market selection
        const markets = s.markets || ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];
        const keyboard = markets.map(m => [{
          text: m,
          callback_data: `manual_market_${m}`
        }]);
        
        keyboard.push([{ text: '❌ Cancel', callback_data: 'manual_cancel' }]);
        
        this.say(
          `📈 *Open Manual Position*\n\n` +
          `Step 1/4: Select Market\n` +
          `Current positions: ${s.positions}/${s.posCap}`,
          {
            reply_markup: {
              inline_keyboard: keyboard
            }
          }
        );
        
        // Store pending trade in memory
        if (!this._pendingManualTrades) this._pendingManualTrades = new Map();
        this._pendingManualTrades.set(userId, { step: 'market', timestamp: Date.now() });
        
      } catch (error) {
        console.error('Error in /open command:', error);
        this.say('❌ Error starting manual trade.');
      }
    });

    this._bot.onText(/^\/close$/i, async (msg) => {
      if (!checkAuthAndRateLimit(msg, 'close')) return;
      
      const userId = msg.from?.id;
      logCommand('close', 'telegram', { userId });
      
      try {
        const s = botCtx.statusSnapshot();
        const positions = s.openPositions || [];
        
        if (positions.length === 0) {
          return this.say('ℹ️ No positions to close.');
        }
        
        // Create inline keyboard with positions
        const keyboard = positions.map((p, idx) => {
          const market = p.market || s.market;
          const sideEmoji = p.side.toLowerCase() === 'long' ? '🟢' : '🔴';
          const manualTag = (p.trade_type === 'manual' || p.mode === 'manual') ? ' [M]' : '';
          return [{
            text: `${sideEmoji} ${market} ${p.side.toUpperCase()}${manualTag} - $${p.collateral?.toFixed(0) || 'N/A'}`,
            callback_data: `close_position_${p.positionId?.substring(0, 20)}`
          }];
        });
        
        keyboard.push([{ text: '❌ Cancel', callback_data: 'close_cancel' }]);
        
        this.say(
          `📉 *Close Position*\n\n` +
          `Select position to close:\n` +
          `([M] = Manual position)`,
          {
            reply_markup: {
              inline_keyboard: keyboard
            }
          }
        );
      } catch (error) {
        console.error('Error in /close command:', error);
        this.say('❌ Error loading positions.');
      }
    });

    // Inline button callback approvals
    this._bot.on('callback_query', (q) => {
      const userId = q.from?.id;
      
      if (!userId || !isValidTelegramUser(userId)) {
        logAuth(false, { source: 'telegram_callback', userId, reason: 'unauthorized_user' });
        this._bot.answerCallbackQuery(q.id, { text: 'Unauthorized' }).catch(()=>{});
        return;
      }

      // Sanitize callback data
      const sanitized = sanitizeTelegramCallback(q.data);
      if (!sanitized) {
        logSecurityEvent('invalid_callback_data', { userId, data: q.data });
        this._bot.answerCallbackQuery(q.id, { text: 'Invalid request' }).catch(()=>{});
        return;
      }

      // Handle manual trade callbacks
      if (sanitized.startsWith('manual_')) {
        this._handleManualTradeCallback(q, sanitized, userId);
        return;
      }

      // Handle close position callbacks
      if (sanitized.startsWith('close_')) {
        this._handleClosePositionCallback(q, sanitized, userId);
        return;
      }

      if (!sanitized.startsWith('APPROVAL:')) return;
      
      const [, id, decision] = sanitized.split(':');
      const pending = this._pendingApprovals.get(id);
      
      if (pending) {
        logCommand('approval_callback', 'telegram', { userId, decision, approvalId: id });
        pending.resolve(decision === 'yes');
        this._pendingApprovals.delete(id);
        this._bot.answerCallbackQuery(q.id, { text: decision === 'yes' ? 'Approved ✅' : 'Rejected ❌' }).catch(()=>{});
        this._bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(()=>{});
      }
    });
  }

  async _handleManualTradeCallback(q, data, userId) {
    try {
      if (!this._pendingManualTrades) this._pendingManualTrades = new Map();
      const trade = this._pendingManualTrades.get(userId) || {};
      
      // Cancel
      if (data === 'manual_cancel') {
        this._pendingManualTrades.delete(userId);
        this._bot.answerCallbackQuery(q.id, { text: 'Cancelled' }).catch(()=>{});
        this._bot.editMessageText('❌ Manual trade cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
        }).catch(()=>{});
        return;
      }

      // Step 1: Market selected
      if (data.startsWith('manual_market_')) {
        const market = data.replace('manual_market_', '');
        trade.market = market;
        trade.step = 'side';
        this._pendingManualTrades.set(userId, trade);
        
        this._bot.answerCallbackQuery(q.id, { text: `Selected: ${market}` }).catch(()=>{});
        this._bot.editMessageText(
          `📈 *Open Manual Position*\n\n` +
          `Market: ${market}\n` +
          `Step 2/4: Select Side`,
          {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🟢 LONG', callback_data: 'manual_side_long' }],
                [{ text: '🔴 SHORT', callback_data: 'manual_side_short' }],
                [{ text: '❌ Cancel', callback_data: 'manual_cancel' }]
              ]
            }
          }
        ).catch(()=>{});
        return;
      }

      // Step 2: Side selected
      if (data.startsWith('manual_side_')) {
        const side = data.replace('manual_side_', '');
        trade.side = side;
        trade.step = 'collateral';
        this._pendingManualTrades.set(userId, trade);
        
        const sideEmoji = side === 'long' ? '🟢' : '🔴';
        this._bot.answerCallbackQuery(q.id, { text: `Selected: ${side.toUpperCase()}` }).catch(()=>{});
        this._bot.editMessageText(
          `📈 *Open Manual Position*\n\n` +
          `Market: ${trade.market}\n` +
          `Side: ${sideEmoji} ${side.toUpperCase()}\n` +
          `Step 3/4: Select Collateral (USD)`,
          {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '$10', callback_data: 'manual_collateral_10' },
                  { text: '$25', callback_data: 'manual_collateral_25' },
                  { text: '$50', callback_data: 'manual_collateral_50' }
                ],
                [
                  { text: '$100', callback_data: 'manual_collateral_100' },
                  { text: '$250', callback_data: 'manual_collateral_250' },
                  { text: '$500', callback_data: 'manual_collateral_500' }
                ],
                [{ text: '❌ Cancel', callback_data: 'manual_cancel' }]
              ]
            }
          }
        ).catch(()=>{});
        return;
      }

      // Step 3: Collateral selected
      if (data.startsWith('manual_collateral_')) {
        const collateral = parseInt(data.replace('manual_collateral_', ''));
        trade.collateral = collateral;
        trade.step = 'leverage';
        this._pendingManualTrades.set(userId, trade);
        
        this._bot.answerCallbackQuery(q.id, { text: `Selected: $${collateral}` }).catch(()=>{});
        this._bot.editMessageText(
          `📈 *Open Manual Position*\n\n` +
          `Market: ${trade.market}\n` +
          `Side: ${trade.side.toUpperCase()}\n` +
          `Collateral: $${collateral}\n` +
          `Step 4/4: Select Leverage`,
          {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '2x', callback_data: 'manual_leverage_2' },
                  { text: '3x', callback_data: 'manual_leverage_3' },
                  { text: '5x', callback_data: 'manual_leverage_5' }
                ],
                [
                  { text: '10x', callback_data: 'manual_leverage_10' },
                  { text: '15x', callback_data: 'manual_leverage_15' },
                  { text: '20x', callback_data: 'manual_leverage_20' }
                ],
                [{ text: '❌ Cancel', callback_data: 'manual_cancel' }]
              ]
            }
          }
        ).catch(()=>{});
        return;
      }

      // Step 4: Leverage selected - show confirmation
      if (data.startsWith('manual_leverage_')) {
        const leverage = parseInt(data.replace('manual_leverage_', ''));
        trade.leverage = leverage;
        trade.step = 'confirm';
        this._pendingManualTrades.set(userId, trade);
        
        const positionSize = trade.collateral * leverage;
        const sideEmoji = trade.side === 'long' ? '🟢' : '🔴';
        
        this._bot.answerCallbackQuery(q.id, { text: `Selected: ${leverage}x` }).catch(()=>{});
        this._bot.editMessageText(
          `⚠️ *Confirm Manual Trade*\n\n` +
          `${sideEmoji} ${trade.market} ${trade.side.toUpperCase()}\n\n` +
          `Collateral: $${trade.collateral}\n` +
          `Leverage: ${leverage}x\n` +
          `Position Size: $${positionSize}\n\n` +
          `⚠️ This will execute with your wallet.\n` +
          `Confirm to proceed.`,
          {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ CONFIRM TRADE', callback_data: 'manual_confirm' }],
                [{ text: '❌ Cancel', callback_data: 'manual_cancel' }]
              ]
            }
          }
        ).catch(()=>{});
        return;
      }

      // Final confirmation - execute trade via API
      if (data === 'manual_confirm') {
        this._bot.answerCallbackQuery(q.id, { text: 'Executing...' }).catch(()=>{});
        this._bot.editMessageText(
          `🔄 Executing manual trade...\n\n` +
          `${trade.market} ${trade.side.toUpperCase()}\n` +
          `$${trade.collateral} @ ${trade.leverage}x`,
          {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
          }
        ).catch(()=>{});
        
        // Note: This would need API integration to build/sign/submit transaction
        // For now, show message that this requires CLI/UI
        this.say(
          `⚠️ *Manual trades via Telegram require setup*\n\n` +
          `Please use:\n` +
          `• Terminal CLI: \`node scripts/manual-trade.js\`\n` +
          `• Web UI: Connect wallet and use Manual Trade form\n\n` +
          `Both support transaction signing and execution.\n\n` +
          `Trade parameters saved:\n` +
          `Market: ${trade.market}\n` +
          `Side: ${trade.side.toUpperCase()}\n` +
          `Collateral: $${trade.collateral}\n` +
          `Leverage: ${trade.leverage}x`
        );
        
        this._pendingManualTrades.delete(userId);
        return;
      }
    } catch (error) {
      console.error('Error in manual trade callback:', error);
      this._bot.answerCallbackQuery(q.id, { text: 'Error occurred' }).catch(()=>{});
    }
  }

  async _handleClosePositionCallback(q, data, userId) {
    try {
      if (data === 'close_cancel') {
        this._bot.answerCallbackQuery(q.id, { text: 'Cancelled' }).catch(()=>{});
        this._bot.editMessageText('❌ Position close cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
        }).catch(()=>{});
        return;
      }

      if (data.startsWith('close_position_')) {
        const positionId = data.replace('close_position_', '');
        const botCtx = this.botContext;
        
        if (!botCtx) {
          this._bot.answerCallbackQuery(q.id, { text: 'Bot not available' }).catch(()=>{});
          return;
        }

        const s = botCtx.statusSnapshot();
        const position = (s.openPositions || []).find(p => p.positionId?.startsWith(positionId));
        
        if (!position) {
          this._bot.answerCallbackQuery(q.id, { text: 'Position not found' }).catch(()=>{});
          return;
        }

        // Check if it's a manual position
        if (position.trade_type === 'manual' || position.mode === 'manual') {
          // Manual positions need wallet signature - can't close via Telegram
          this._bot.answerCallbackQuery(q.id, { text: 'Manual positions require CLI/UI' }).catch(()=>{});
          this._bot.editMessageText(
            `⚠️ *Manual Position Requires Wallet*\n\n` +
            `Position: ${position.market} ${position.side.toUpperCase()}\n` +
            `ID: \`${position.positionId?.substring(0, 8)}...\`\n\n` +
            `Manual positions require wallet signature to close.\n\n` +
            `Please use:\n` +
            `• Terminal: \`node scripts/manual-trade.js close\`\n` +
            `• Web UI: Manual Trade section`,
            {
              chat_id: q.message.chat.id,
              message_id: q.message.message_id,
              parse_mode: 'Markdown'
            }
          ).catch(()=>{});
          return;
        }

        // For non-manual positions, close normally
        try {
          this._bot.answerCallbackQuery(q.id, { text: 'Closing...' }).catch(()=>{});
          this._bot.editMessageText(
            `🔄 Closing position...\n${position.market} ${position.side.toUpperCase()}`,
            {
              chat_id: q.message.chat.id,
              message_id: q.message.message_id
            }
          ).catch(()=>{});

          const market = position.market || s.market;
          const currentPrice = await this._resolveMarketPrice(botCtx, s, market);
          if (!currentPrice) {
            throw new Error(`No price available for ${market}`);
          }
          await botCtx.closePosition(position, currentPrice, 'telegram_close');
          
          this.say(`✅ Position closed successfully!`);
        } catch (error) {
          console.error('Error closing position:', error);
          this.say(`❌ Error closing position: ${error.message}`);
        }
      }
    } catch (error) {
      console.error('Error in close position callback:', error);
      this._bot.answerCallbackQuery(q.id, { text: 'Error occurred' }).catch(()=>{});
    }
  }

  async say(text, opts = {}) {
    if (!this.enabled) return;
    if (!this._bot) {
      console.warn('Telegram bot not initialized yet, skipping message');
      return;
    }
    try {
      const { disableInstancePrefix, ...sendOpts } = opts;
      let message = typeof text === 'string' ? text : String(text);

      const parseMode = (sendOpts.parse_mode || 'Markdown').toLowerCase();
      const canPrefix = !disableInstancePrefix && this.instanceLabel && parseMode.startsWith('markdown');
      if (canPrefix) {
        const header = `*Instance:* ${this.instanceLabel}`;
        message = `${header}\n\n${message}`;
      }

      await this._bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown', ...sendOpts });
    } catch (e) {
      // If Markdown parse error, try sending as plain text
      if (e.code === 'ETELEGRAM' && e.message && (e.message.includes('parse entities') || e.message.includes('Can\'t find end'))) {
        console.warn('Telegram Markdown parse error, retrying as plain text:', e.message);
        console.warn('Original message (first 200 chars):', typeof text === 'string' ? text.substring(0, 200) : 'N/A');
        try {
          const plainMessage = typeof text === 'string' ? text : String(text);
          // Remove all Markdown formatting for plain text
          const cleanMessage = plainMessage
            .replace(/\*\*/g, '')
            .replace(/\*/g, '')
            .replace(/`/g, '')
            .replace(/_/g, '');
          await this._bot.sendMessage(this.chatId, cleanMessage, { parse_mode: undefined, ...opts });
        } catch (e2) {
          console.error('Telegram send error (plain text fallback):', e2.message);
        }
      } else {
        console.warn('Telegram send error:', e.message);
        if (e.code === 'ETELEGRAM') {
          console.warn('Error code: ETELEGRAM');
        }
      }
    }
  }

  // Critical alert methods - auto-throttle to avoid spam
  _alertThrottleKey(type) {
    return `alert:${type}`;
  }

  _shouldAlert(type, throttleMs = 300000) {
    // Default 5-minute throttle between same alert types
    const lastAlert = this._commandCooldowns.get(this._alertThrottleKey(type));
    if (lastAlert && Date.now() - lastAlert < throttleMs) {
      return false;
    }
    return true;
  }

  _markAlert(type) {
    this._commandCooldowns.set(this._alertThrottleKey(type), Date.now());
  }

  /**
   * Alert for 409 Telegram conflicts
   */
  async alert409(attempt, maxRetries, delay) {
    if (!this._shouldAlert('409', 600000)) return; // 10-minute throttle
    
    try {
      await this.say(
        `⚠️ *Telegram 409 Conflict*\n\n` +
        `Attempt: ${attempt}/${maxRetries}\n` +
        `Status: Auto-retrying in ${Math.round(delay/1000)}s\n` +
        `Reason: Previous instance still polling\n\n` +
        `This is normal during restarts.\n` +
        `No action needed.`
      );
      this._markAlert('409');
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  /**
   * Alert for 429 rate limits
   */
  async alert429(source, endpoint, context = {}) {
    const alertKey = `429:${source}`;
    if (!this._shouldAlert(alertKey, 900000)) return; // 15-minute throttle
    
    try {
      await this.say(
        `🚨 *Rate Limit (429)*\n\n` +
        `Source: ${source}\n` +
        `Endpoint: ${endpoint}\n` +
        (context.retryAfter ? `Retry After: ${context.retryAfter}s\n` : '') +
        (context.count ? `Occurrences: ${context.count}\n` : '') +
        `\n` +
        `Action: ${context.action || 'Retrying with backoff'}` +
        (context.circuitBreaker ? `\n⚡ Circuit breaker may trip if this continues` : '')
      );
      this._markAlert(alertKey);
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  /**
   * Alert for circuit breaker trips
   */
  async alertCircuitBreaker(source, failures, cooldownSeconds) {
    const alertKey = `circuit:${source}`;
    if (!this._shouldAlert(alertKey, 1800000)) return; // 30-minute throttle
    
    try {
      const emoji = cooldownSeconds > 120 ? '🔥' : '⚡';
      await this.say(
        `${emoji} *Circuit Breaker TRIPPED*\n\n` +
        `Source: ${source}\n` +
        `Failures: ${failures} consecutive\n` +
        `Cooldown: ${Math.round(cooldownSeconds / 60)}min\n` +
        `Recovery: ${new Date(Date.now() + cooldownSeconds * 1000).toLocaleTimeString()}\n\n` +
        `Action: Automatic failover to backup sources\n` +
        `Status: Will auto-retry after cooldown`
      );
      this._markAlert(alertKey);
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  /**
   * Alert for circuit breaker recovery
   */
  async alertCircuitBreakerRecovery(source) {
    const alertKey = `circuit-recovery:${source}`;
    if (!this._shouldAlert(alertKey, 3600000)) return; // 1-hour throttle
    
    try {
      await this.say(
        `✅ *Circuit Breaker RECOVERED*\n\n` +
        `Source: ${source}\n` +
        `Status: Back online\n` +
        `Action: Resuming normal operations`
      );
      this._markAlert(alertKey);
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  /**
   * Alert for critical errors
   */
  async alertCriticalError(error, context = {}) {
    const alertKey = `critical:${context.category || 'unknown'}`;
    if (!this._shouldAlert(alertKey, 300000)) return; // 5-minute throttle
    
    try {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const truncated = errorMsg.length > 200 ? errorMsg.substring(0, 200) + '...' : errorMsg;
      
      await this.say(
        `💥 *Critical Error*\n\n` +
        `Category: ${context.category || 'Unknown'}\n` +
        `Severity: ${context.severity || 'HIGH'}\n` +
        `Error: \`${truncated}\`\n` +
        (context.action ? `\nAction: ${context.action}` : '') +
        (context.impact ? `\nImpact: ${context.impact}` : '') +
        `\n\nCheck logs for details.`
      );
      this._markAlert(alertKey);
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  /**
   * Alert for risk violations
   */
  async alertRiskViolation(type, details) {
    const alertKey = `risk:${type}`;
    if (!this._shouldAlert(alertKey, 300000)) return; // 5-minute throttle
    
    try {
      await this.say(
        `⛔ *Risk Violation*\n\n` +
        `Type: ${type}\n` +
        `Details: ${details}\n\n` +
        `Action: Trade blocked for safety`
      );
      this._markAlert(alertKey);
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  /**
   * Alert for position liquidation risk
   */
  async alertLiquidationRisk(position, currentPrice, liquidationPrice) {
    const alertKey = `liquidation:${position.positionId}`;
    if (!this._shouldAlert(alertKey, 600000)) return; // 10-minute throttle
    
    try {
      const distance = Math.abs((currentPrice - liquidationPrice) / currentPrice * 100);
      const emoji = distance < 5 ? '🚨' : distance < 10 ? '⚠️' : '⚡';
      
      await this.say(
        `${emoji} *Liquidation Risk*\n\n` +
        `Market: ${position.market}\n` +
        `Side: ${position.side.toUpperCase()}\n` +
        `Current: $${currentPrice.toFixed(4)}\n` +
        `Liq Price: $${liquidationPrice.toFixed(4)}\n` +
        `Distance: ${distance.toFixed(2)}%\n\n` +
        `Action: Consider closing position`
      );
      this._markAlert(alertKey);
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  /**
   * Alert for unexpected bot restarts
   */
  async alertRestart(reason, stats = {}) {
    try {
      await this.say(
        `🔄 *Bot Restarted*\n\n` +
        `Reason: ${reason}\n` +
        (stats.uptime ? `Previous Uptime: ${Math.round(stats.uptime / 3600000)}h\n` : '') +
        (stats.positions ? `Open Positions: ${stats.positions}\n` : '') +
        (stats.dailyTrades ? `Daily Trades: ${stats.dailyTrades}\n` : '') +
        `\nStatus: Initializing...`
      );
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  /**
   * Alert for network issues
   */
  async alertNetworkIssue(issue, retryCount = 0) {
    const alertKey = `network:${issue}`;
    if (!this._shouldAlert(alertKey, 600000)) return; // 10-minute throttle
    
    try {
      await this.say(
        `🌐 *Network Issue*\n\n` +
        `Issue: ${issue}\n` +
        (retryCount > 0 ? `Retries: ${retryCount}\n` : '') +
        `\n` +
        `Action: Auto-retry with backoff`
      );
      this._markAlert(alertKey);
    } catch (e) {
      // Ignore errors in alert itself
    }
  }

  async approve(kind, payload) {
    if (!this.enabled) return null; // fall back to console guard
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pretty =
      `🔒 *Approval Required*\n` +
      `Type: ${kind.toUpperCase()}\n` +
      (payload.side ? `Side: ${payload.side}\n` : '') +
      (payload.leverage ? `Lev: ${payload.leverage}\n` : '') +
      (payload.collateral ? `Collat: $${payload.collateral}\n` : '') +
      (payload.price ? `Price: $${payload.price}\n` : '') +
      (payload.reason ? `Reason: ${payload.reason}\n` : '') +
      (payload.positionId ? `Pos: ${payload.positionId}\n` : '');

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `APPROVAL:${id}:yes` },
        { text: '❌ Reject',  callback_data: `APPROVAL:${id}:no` }
      ]]
    };
    await this.say(pretty, { reply_markup: keyboard });

    return new Promise((resolve) => {
      this._pendingApprovals.set(id, { resolve });
      // auto-expire after 2 minutes
      setTimeout(() => {
        if (this._pendingApprovals.has(id)) {
          this._pendingApprovals.delete(id);
          resolve(false);
        }
      }, 120000);
    });
  }
}

module.exports = TelegramControl;
