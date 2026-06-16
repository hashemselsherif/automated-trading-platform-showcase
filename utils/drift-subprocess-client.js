/**
 * Drift Subprocess Client
 * 
 * Spawns and communicates with the isolated Drift SDK subprocess.
 * Uses JSON-based IPC over stdin/stdout.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

const SUBPROCESS_DIR = path.join(__dirname, '..', 'drift-subprocess');
const DEFAULT_TIMEOUT = 30000; // 30 seconds

// Command-specific timeouts (longer for operations that may take time)
const COMMAND_TIMEOUTS = {
  getOpenOrders: 60000,    // 60 seconds - network operations may be slow
  getPositions: 60000,     // 60 seconds - network operations may be slow
  init: 45000,             // 45 seconds - SDK initialization takes time
  subscribe: 60000,        // 60 seconds - subscription is CPU-intensive
  ping: 5000,              // 5 seconds - health checks should be fast
  placeLimitOrder: 60000,  // 60 seconds - tx submission can be slow during congestion
  placeMarketOrder: 60000, // 60 seconds - tx submission can be slow during congestion
  cancelOrder: 45000,      // 45 seconds - cancel operations may need multiple retries
  closePosition: 60000,    // 60 seconds - closing positions is critical
};

// Circuit breaker state
const CIRCUIT_BREAKER_STATES = {
  CLOSED: 'closed',     // Normal operation
  OPEN: 'open',         // Failing - reject requests
  HALF_OPEN: 'half_open', // Testing if recovered
};

class DriftSubprocessClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      timeout: options.timeout || DEFAULT_TIMEOUT,
      logLevel: options.logLevel || 'info',
      walletPassword: options.walletPassword || null, // Store securely, not in env
    };
    
    this.process = null;
    this.rl = null;
    this.pendingRequests = new Map();
    this.requestQueue = [];
    this.coalescedQueue = new Map();
    this.MAX_INFLIGHT = options.maxInflight || 50;
    this.MAX_QUEUE = options.maxQueue || 500;
    this.COALESCE_ACTIONS = new Set(['getOpenOrders', 'getPositions']);
    this.ready = false;
    this.sdkLoaded = false;
    this.sdkError = null;
    
    // Circuit breaker state
    this.circuitState = CIRCUIT_BREAKER_STATES.CLOSED;
    this.circuitFailures = 0;
    this.circuitSuccesses = 0;
    this.circuitLastFailure = null;
    this.circuitOpenUntil = null;
    
    // Circuit breaker thresholds
    this.CIRCUIT_FAILURE_THRESHOLD = 3; // Open after 3 consecutive failures
    this.CIRCUIT_HALF_OPEN_TIMEOUT = 30000; // 30s before trying half-open
    this.CIRCUIT_SUCCESS_THRESHOLD = 2; // Close after 2 consecutive successes
  }

  log(level, ...args) {
    if (this.options.logLevel === 'debug' || level !== 'debug') {
      console.log(`[DriftClient:${level}]`, ...args);
    }
  }

  /**
   * Start the subprocess
   */
  async start() {
    if (this.process) {
      throw new Error('Subprocess already running');
    }

    return new Promise((resolve, reject) => {
      const indexPath = path.join(SUBPROCESS_DIR, 'index.js');
      
      this.log('info', 'Spawning Drift subprocess...');
      this.log('debug', 'Path:', indexPath);

      // Create subprocess environment WITHOUT wallet password initially
      const subprocessEnv = { ...process.env };
      
      // Only set password temporarily if provided (will be cleared after init)
      if (this.options.walletPassword) {
        subprocessEnv.WALLET_PASSWORD = this.options.walletPassword;
        this.log('debug', 'Wallet password provided to subprocess (will be cleared after init)');
      }

      this.process = spawn('node', [indexPath], {
        cwd: SUBPROCESS_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: subprocessEnv,
      });

      // Handle stderr (logs from subprocess)
      this.process.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          this.log('debug', '[subprocess]', line);
        }
      });

      // Parse stdout as JSON messages
      this.rl = readline.createInterface({
        input: this.process.stdout,
        terminal: false,
      });

      this.rl.on('line', (line) => {
        this.handleMessage(line);
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        this.log('info', `Subprocess exited (code=${code}, signal=${signal})`);
        this.cleanup();
        this.emit('exit', { code, signal });
      });

      this.process.on('error', (err) => {
        this.log('error', 'Subprocess error:', err.message);
        reject(err);
      });

      // Wait for ready event
      const timeout = setTimeout(() => {
        reject(new Error('Subprocess startup timeout'));
        this.stop();
      }, 10000);

      this.once('ready', (data) => {
        clearTimeout(timeout);
        this.ready = true;
        this.sdkLoaded = data.sdkLoaded;
        this.sdkError = data.sdkError;
        resolve(data);
      });
    });
  }

  /**
   * Handle incoming message from subprocess
   */
  handleMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.log('debug', 'Non-JSON from subprocess:', line);
      return;
    }

    const { type, id, success, data, error, event } = msg;

    if (type === 'response') {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        if (success) {
          pending.resolve(data);
        } else {
          pending.reject(new Error(error || 'Unknown error'));
        }
        this._processQueue();
      }
    } else if (type === 'event') {
      this.emit(event, data);
    }
  }

  _enqueueRequest(action, params) {
    if (this.requestQueue.length >= this.MAX_QUEUE) {
      const error = new Error(`Request queue overflow (${this.MAX_QUEUE})`);
      error.code = 'QUEUE_OVERFLOW';
      return Promise.reject(error);
    }

    if (this.COALESCE_ACTIONS.has(action)) {
      const existing = this.coalescedQueue.get(action);
      if (existing) {
        existing.params = params;
        return existing.promise;
      }
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry = { action, params, resolve, reject, promise };
    this.requestQueue.push(entry);
    if (this.COALESCE_ACTIONS.has(action)) {
      this.coalescedQueue.set(action, entry);
    }

    this._processQueue();
    return promise;
  }

  _dispatchRequest(action, params) {
    const id = uuidv4();
    const msg = { type: 'command', id, action, params };
    const timeoutMs = this._getCommandTimeout(action);

    // Debug: Log what we're sending for order commands
    if (action === 'placeLimitOrder' || action === 'placeMarketOrder') {
      const msgJson = JSON.stringify(msg);
      console.log(`[DriftSubprocessClient] Sending ${action}: ${msgJson.slice(0, 500)}`);
      console.log(`[DriftSubprocessClient] Params keys: ${Object.keys(params).join(', ')}`);
      console.log(`[DriftSubprocessClient] Params values: marketIndex=${params.marketIndex}, side=${params.side}, baseAssetAmount=${params.baseAssetAmount}, price=${params.price}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          this._recordFailure();
          const error = new Error(`Command timeout: ${action} (${timeoutMs}ms)`);
          error.code = 'TIMEOUT';
          error.action = action;
          reject(error);
          this._processQueue();
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout, action, startTime: Date.now() });

      try {
        this.process.stdin.write(JSON.stringify(msg) + '\n');
      } catch (writeErr) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        this._recordFailure();
        const error = new Error(`Failed to send command: ${writeErr.message}`);
        error.code = 'WRITE_ERROR';
        reject(error);
        this._processQueue();
      }
    }).then((result) => {
      this._recordSuccess();
      return result;
    }).catch((error) => {
      if (error.code === 'TIMEOUT' || error.code === 'WRITE_ERROR' || error.message.includes('terminated')) {
        this._recordFailure();
      }
      throw error;
    });
  }

  _processQueue() {
    while (this.pendingRequests.size < this.MAX_INFLIGHT && this.requestQueue.length > 0) {
      const entry = this.requestQueue.shift();
      if (!entry) break;
      if (this.COALESCE_ACTIONS.has(entry.action)) {
        this.coalescedQueue.delete(entry.action);
      }

      this._dispatchRequest(entry.action, entry.params)
        .then(entry.resolve)
        .catch(entry.reject);
    }
  }

  /**
   * Check circuit breaker state
   */
  _checkCircuitBreaker() {
    const now = Date.now();
    
    // If circuit is open, check if we should try half-open
    if (this.circuitState === CIRCUIT_BREAKER_STATES.OPEN) {
      if (this.circuitOpenUntil && now >= this.circuitOpenUntil) {
        this.log('info', `Circuit breaker entering half-open state (testing recovery)`);
        this.circuitState = CIRCUIT_BREAKER_STATES.HALF_OPEN;
        this.circuitSuccesses = 0;
        return true; // Allow one request through
      }
      return false; // Reject all requests while open
    }
    
    // If circuit is half-open, allow requests
    if (this.circuitState === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
      return true;
    }
    
    // Circuit is closed - allow all requests
    return true;
  }

  /**
   * Record circuit breaker failure
   */
  _recordFailure() {
    this.circuitFailures++;
    this.circuitLastFailure = Date.now();
    
    if (this.circuitState === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
      // Half-open request failed - open circuit again
      this.log('warn', `Circuit breaker: half-open test failed, opening circuit`);
      this.circuitState = CIRCUIT_BREAKER_STATES.OPEN;
      this.circuitOpenUntil = Date.now() + this.CIRCUIT_HALF_OPEN_TIMEOUT;
      this.circuitFailures = 0;
      this.circuitSuccesses = 0;
    } else if (this.circuitFailures >= this.CIRCUIT_FAILURE_THRESHOLD) {
      // Too many failures - open circuit
      this.log('warn', `Circuit breaker: ${this.circuitFailures} failures, opening circuit`);
      this.circuitState = CIRCUIT_BREAKER_STATES.OPEN;
      this.circuitOpenUntil = Date.now() + this.CIRCUIT_HALF_OPEN_TIMEOUT;
      this.circuitFailures = 0;
    }
  }

  /**
   * Record circuit breaker success
   */
  _recordSuccess() {
    if (this.circuitState === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
      this.circuitSuccesses++;
      if (this.circuitSuccesses >= this.CIRCUIT_SUCCESS_THRESHOLD) {
        // Half-open requests succeeded - close circuit
        this.log('info', `Circuit breaker: ${this.circuitSuccesses} successes, closing circuit`);
        this.circuitState = CIRCUIT_BREAKER_STATES.CLOSED;
        this.circuitFailures = 0;
        this.circuitSuccesses = 0;
      }
    } else if (this.circuitState === CIRCUIT_BREAKER_STATES.CLOSED) {
      // Reset failure count on success
      this.circuitFailures = Math.max(0, this.circuitFailures - 1);
    }
  }

  /**
   * Get timeout for a specific command
   */
  _getCommandTimeout(action) {
    return COMMAND_TIMEOUTS[action] || this.options.timeout;
  }

  /**
   * Send a command to the subprocess
   */
  async send(action, params = {}) {
    if (!this.process) {
      throw new Error('Subprocess not running');
    }

    // Check circuit breaker
    if (!this._checkCircuitBreaker()) {
      const error = new Error(`Circuit breaker is OPEN - subprocess may be unresponsive. Last failure: ${this.circuitLastFailure ? new Date(this.circuitLastFailure).toISOString() : 'never'}`);
      error.code = 'CIRCUIT_OPEN';
      throw error;
    }

    if (this.pendingRequests.size >= this.MAX_INFLIGHT || this.requestQueue.length > 0) {
      return this._enqueueRequest(action, params);
    }

    return this._dispatchRequest(action, params);
  }

  /**
   * Stop the subprocess
   */
  async stop() {
    if (!this.process) return;

    try {
      await this.send('shutdown', {});
    } catch (err) {
      // Ignore errors during shutdown
    }

    this.process.kill();
    this.cleanup();
  }

  cleanup() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.process = null;
    this.ready = false;

    // Reject pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      const elapsed = Date.now() - (pending.startTime || Date.now());
      const error = new Error(`Subprocess terminated (request was pending for ${elapsed}ms)`);
      error.code = 'SUBPROCESS_TERMINATED';
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const entry of this.requestQueue) {
      const error = new Error('Subprocess terminated (request was queued)');
      error.code = 'SUBPROCESS_TERMINATED';
      entry.reject(error);
    }
    this.requestQueue = [];
    this.coalescedQueue.clear();
    
    // Reset circuit breaker on cleanup
    this.circuitState = CIRCUIT_BREAKER_STATES.CLOSED;
    this.circuitFailures = 0;
    this.circuitSuccesses = 0;
    this.circuitLastFailure = null;
    this.circuitOpenUntil = null;
  }

  // ========== High-level API ==========

  async ping() {
    return this.send('ping');
  }

  async getSdkStatus() {
    return this.send('getSdkStatus');
  }

  async initConnection(rpcUrl, env = 'devnet') {
    return this.send('initConnection', { rpcUrl, env });
  }

  async getPerpMarkets(env = 'mainnet-beta') {
    return this.send('getPerpMarkets', { env });
  }

  async getSpotMarkets(env = 'mainnet-beta') {
    return this.send('getSpotMarkets', { env });
  }

  async getMarketIndexMap(env = 'mainnet-beta') {
    return this.send('getMarketIndexMap', { env });
  }

  async validateMarket(symbol, env = 'mainnet-beta') {
    return this.send('validateMarket', { symbol, env });
  }

  async getFeeInfo() {
    return this.send('getFeeInfo');
  }

  async getAllPerpMarketsDetailed(env = 'mainnet-beta') {
    return this.send('getAllPerpMarketsDetailed', { env });
  }
}

module.exports = { DriftSubprocessClient };
