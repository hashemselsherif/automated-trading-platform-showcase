// utils/rpc-manager.js
const { Connection } = require('@solana/web3.js');

/**
 * RPC Manager with Multi-Provider Support and Automatic Failover
 * 
 * Features:
 * - Multiple RPC providers (Helius, QuickNode, Triton, fallback)
 * - Automatic failover on timeout/error
 * - Latency monitoring and tracking
 * - Rate limiting per provider
 * - Health checks
 * 
 * Usage:
 *   const rpcManager = new RPCManager();
 *   const connection = rpcManager.getConnection();
 *   const latency = rpcManager.getAverageLatency();
 */

class RPCManager {
  constructor(options = {}) {
    // Configuration
    this.providers = this._initializeProviders(options);
    this.currentProviderIndex = 0;
    this.timeout = options.timeout || Number(process.env.RPC_TIMEOUT_MS) || 5000;
    this.maxRetries = options.maxRetries || Number(process.env.RPC_MAX_RETRIES) || 3;
    this.enableFailover = options.enableFailover !== false && process.env.RPC_ENABLE_FAILOVER !== 'false';
    
    // Health check configuration
    // Allow disabling health checks for secondary instances to avoid duplicates
    this.enableHealthChecks = options.enableHealthChecks !== false; // Default: enabled
    
    // Monitoring
    this.stats = new Map(); // provider -> { requests, errors, latencies, lastError }
    this.healthCheckInterval = null;
    this.healthCheckIntervalMs = 60000; // 1 minute
    
    // Initialize stats for each provider
    for (const provider of this.providers) {
      this.stats.set(provider.name, {
        requests: 0,
        errors: 0,
        latencies: [],
        maxLatencies: 100, // Keep last 100 latencies
        lastError: null,
        lastHealthCheck: null,
        healthy: true,
      });
    }
    
    // Start health checks (only if enabled and failover is enabled)
    if (this.enableHealthChecks && this.enableFailover) {
      this._startHealthChecks();
    }
    
    console.log(`[RPCManager] Initialized with ${this.providers.length} providers`);
    console.log(`[RPCManager] Current: ${this.getCurrentProvider().name}`);
    console.log(`[RPCManager] Failover: ${this.enableFailover ? 'enabled' : 'disabled'}`);
    if (!this.enableHealthChecks) {
      console.log(`[RPCManager] Health checks: disabled (secondary instance)`);
    }
  }
  
  /**
   * Detect if RPC URL has API key
   */
  _hasApiKey(url) {
    if (!url) return false;
    return url.includes('api-key=') || 
           url.includes('quiknode.pro') || 
           (url.includes('/') && url.split('/').length > 3); // QuickNode/Triton format
  }

  /**
   * Convert WebSocket URL to HTTP for Connection class
   */
  _toHttpUrl(url) {
    return url.replace('wss://', 'https://').replace('ws://', 'http://');
  }

  /**
   * Check if QuickNode URL supports Priority Fee API
   */
  _hasPriorityFeeAPI(url) {
    if (!url) return false;
    return url.includes('quiknode.pro');
  }

  /**
   * Initialize RPC providers from environment variables
   * Automatically prioritizes RPCs with API keys first
   * Priority order: API key RPCs > Public RPCs
   * Within API key RPCs: Priority Fee API > Lower latency > Lower error rate
   */
  _initializeProviders(options) {
    const providers = [];
    
    // Helper to add provider
    const addProvider = (name, url, basePriority) => {
      if (!url) return;
      
      const httpUrl = this._toHttpUrl(url);
      const hasApiKey = this._hasApiKey(url);
      const hasPriorityFeeAPI = this._hasPriorityFeeAPI(url);
      
      // Calculate dynamic priority:
      // - API key RPCs: 1-10 (lower = higher priority)
      // - Public RPCs: 20+ (lower = higher priority)
      // - Priority Fee API bonus: -2 (makes it higher priority)
      let priority = hasApiKey ? basePriority : basePriority + 20;
      if (hasPriorityFeeAPI && hasApiKey) {
        priority -= 2; // QuickNode with Priority Fee API gets highest priority
      }
      
      providers.push({
        name,
        url: httpUrl,
        originalUrl: url,
        hasApiKey,
        hasPriorityFeeAPI,
        connection: new Connection(httpUrl, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: this.timeout,
        }),
        priority,
        basePriority, // Store original priority for reordering
      });
    };
    
    // 1. API Key RPCs (Priority 1-3) - Load ALL available API key RPCs
    // These are automatically prioritized over public RPCs

    // Syndica (primary)
    addProvider('syndica', process.env.RPC_SYNDICA_URL, 0);
    
    // Helius with optional backrun rebates
    // See: https://www.helius.dev/docs/sending-transactions/backrun-rebates
    const heliusUrl = process.env.RPC_HELIUS_URL;
    const rebateAddress = process.env.HELIUS_REBATE_ADDRESS;
    if (heliusUrl && rebateAddress) {
      // Append rebate-address param for MEV rebates (50% of trade MEV paid to wallet)
      const urlWithRebate = heliusUrl.includes('?') 
        ? `${heliusUrl}&rebate-address=${rebateAddress}`
        : `${heliusUrl}?rebate-address=${rebateAddress}`;
      addProvider('helius', urlWithRebate, 1);
      console.log(`[RPCManager] Helius backrun rebates enabled: ${rebateAddress.slice(0, 8)}...${rebateAddress.slice(-4)}`);
    } else {
      addProvider('helius', heliusUrl, 1);
    }
    
    addProvider('quicknode', process.env.RPC_QUICKNODE_URL, 2);
    addProvider('triton', process.env.RPC_TRITON_URL, 3);
    
    // Tatum RPC with header-based authentication
    const tatumUrl = process.env.RPC_TATUM_URL;
    const tatumApiKey = process.env.RPC_TATUM_API_KEY;
    if (tatumUrl && tatumApiKey) {
      // Tatum requires x-api-key header, create connection with custom fetch
      const tatumHttpUrl = this._toHttpUrl(tatumUrl);
      providers.push({
        name: 'tatum',
        url: tatumHttpUrl,
        originalUrl: tatumUrl,
        hasApiKey: true,
        hasPriorityFeeAPI: false,
        connection: new Connection(tatumHttpUrl, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: this.timeout,
          httpHeaders: {
            'x-api-key': tatumApiKey,
          },
        }),
        priority: 4, // After helius, quicknode, triton
        basePriority: 4,
      });
      console.log(`[RPCManager] Tatum RPC configured with API key`);
    }
    
    // If preferred provider is set, ensure it's first among API key RPCs
    const preferredProvider = options.provider || process.env.RPC_PROVIDER;
    const supportedPreferred = ['syndica', 'helius', 'quicknode', 'triton', 'tatum'];
    if (preferredProvider && supportedPreferred.includes(preferredProvider)) {
      // Reorder: move preferred provider to front
      const preferredIndex = providers.findIndex(p => p.name === preferredProvider);
      if (preferredIndex > 0 && preferredIndex < providers.length) {
        const preferred = providers.splice(preferredIndex, 1)[0];
        preferred.priority = -1; // Highest priority (even above Priority Fee API)
        preferred.basePriority = 0;
        // Adjust other API key RPCs
        providers.forEach(p => {
          if (p.hasApiKey && p.name !== preferredProvider) {
            p.priority = Math.min(p.priority + 1, 10);
          }
        });
        providers.unshift(preferred);
      }
    }
    
    // 2. Fallback RPC (if configured)
    addProvider('fallback', process.env.RPC_FALLBACK_URL, 20);
    
    // 3. Default public RPC (lowest priority)
    if (providers.length === 0) {
      console.warn('[RPCManager] No RPC providers configured, using default public RPC');
      addProvider('default', 'https://api.mainnet-beta.solana.com', 30);
    } else {
      // Add default as last resort fallback
      addProvider('default', process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 30);
    }
    
    // Sort by priority (lower = higher priority)
    // API key RPCs (priority 1-10) come before public RPCs (priority 20+)
    const sorted = providers.sort((a, b) => a.priority - b.priority);
    
    // Log initialization order
    console.log('[RPCManager] Provider order:');
    sorted.forEach((p, i) => {
      const apiKeyStatus = p.hasApiKey ? '✅ API Key' : '❌ Public';
      const priorityFeeStatus = p.hasPriorityFeeAPI ? ' (Priority Fee API)' : '';
      console.log(`  ${i + 1}. ${p.name} (priority ${p.priority}, ${apiKeyStatus}${priorityFeeStatus})`);
    });
    
    return sorted;
  }
  
  /**
   * Get current active RPC connection
   */
  getConnection() {
    return this.getCurrentProvider().connection;
  }
  
  /**
   * Get current provider info
   */
  getCurrentProvider() {
    return this.providers[this.currentProviderIndex];
  }
  
  /**
   * Execute RPC call with automatic failover
   */
  async executeWithFailover(fn, context = 'rpc-call') {
    let lastError = null;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let provider = this.getCurrentProvider();
      let stats = this.stats.get(provider.name);
      
      // CRITICAL FIX: Skip unhealthy providers BEFORE attempting
      // If current provider is marked unhealthy (within last 60s), switch immediately
      if (this.enableFailover && !stats.healthy && stats.lastError && 
          (Date.now() - stats.lastError.time) < 60000) {
        console.log(`[RPCManager] Skipping unhealthy provider ${provider.name}, switching...`);
        this._switchToNextProvider();
        provider = this.getCurrentProvider();
        stats = this.stats.get(provider.name);
        console.log(`[RPCManager] Now using ${provider.name}`);
      }
      
      const startTime = Date.now();
      
      try {
        stats.requests++;
        
        // Execute the function with timeout
        const result = await Promise.race([
          fn(provider.connection),
          this._timeout(this.timeout, `${context} timeout after ${this.timeout}ms`),
        ]);
        
        // Record latency
        const latency = Date.now() - startTime;
        this._recordLatency(provider.name, latency);
        
        // Mark as healthy
        stats.healthy = true;
        
        return result;
        
      } catch (error) {
        lastError = error;
        stats.errors++;
        stats.healthy = false; // Mark as unhealthy on failure
        stats.lastError = {
          message: error.message,
          time: Date.now(),
        };
        
        // Check for rate limit (429) errors - need longer backoff
        const is429 = error.message?.includes('429') || error.message?.includes('Too Many Requests');
        if (is429) {
          // Exponential backoff for rate limit errors: 2s, 4s, 8s
          const backoffMs = Math.min(2000 * Math.pow(2, attempt), 10000);
          console.warn(`[RPCManager] Rate limited (429) on ${provider.name}, waiting ${backoffMs}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
        
        console.error(`[RPCManager] ${provider.name} error (attempt ${attempt + 1}/${this.maxRetries}):`, error.message);
        
        // Try next provider if failover is enabled
        if (this.enableFailover && attempt < this.maxRetries - 1) {
          this._switchToNextProvider();
          console.log(`[RPCManager] Switched to ${this.getCurrentProvider().name}`);
        }
      }
    }
    
    // All retries failed
    throw new Error(`RPC call failed after ${this.maxRetries} retries: ${lastError?.message || 'Unknown error'}`);
  }
  
  /**
   * Calculate performance score for a provider
   * Higher score = better performance
   */
  _calculatePerformanceScore(provider) {
    const stats = this.stats.get(provider.name);
    if (!stats) return 0;
    
    let score = 0;
    
    // API key bonus (huge priority)
    if (provider.hasApiKey) score += 1000;
    
    // Priority Fee API bonus
    if (provider.hasPriorityFeeAPI) score += 50;
    
    // Latency score (lower latency = higher score)
    const avgLatency = this.getAverageLatency(provider.name);
    if (avgLatency !== null) {
      score += Math.max(0, 200 - avgLatency); // Max 200 points for latency
    }
    
    // Error rate score (lower error rate = higher score)
    const errorRate = stats.requests > 0 ? (stats.errors / stats.requests) * 100 : 0;
    score += Math.max(0, 100 - errorRate); // Max 100 points for reliability
    
    // Health bonus
    if (stats.healthy) score += 10;
    
    return score;
  }

  /**
   * Reorder providers based on performance metrics
   * Called periodically to optimize RPC selection
   */
  _reorderProvidersByPerformance() {
    // Calculate scores for all providers
    const scored = this.providers.map(p => ({
      provider: p,
      score: this._calculatePerformanceScore(p),
    }));
    
    // Sort by score (highest first), but maintain API key priority
    scored.sort((a, b) => {
      // API key RPCs always come before public RPCs
      if (a.provider.hasApiKey && !b.provider.hasApiKey) return -1;
      if (!a.provider.hasApiKey && b.provider.hasApiKey) return 1;
      
      // Within same category, sort by score
      return b.score - a.score;
    });
    
    // Update provider order
    const newOrder = scored.map(s => s.provider);
    const currentProvider = this.getCurrentProvider();
    
    // Only reorder if it would improve performance
    if (newOrder[0].name !== this.providers[0].name) {
      this.providers = newOrder;
      const newIndex = this.providers.findIndex(p => p.name === currentProvider.name);
      if (newIndex >= 0) {
        this.currentProviderIndex = newIndex;
      }
      
      console.log(`[RPCManager] Reordered providers. New primary: ${newOrder[0].name} (score: ${scored[0].score.toFixed(0)})`);
    }
  }

  /**
   * Switch to next available provider
   * Now uses performance-based selection
   */
  _switchToNextProvider() {
    const originalIndex = this.currentProviderIndex;
    
    // First, try to reorder by performance
    this._reorderProvidersByPerformance();
    
    // Try each provider once, prioritizing healthy ones
    for (let i = 0; i < this.providers.length; i++) {
      this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
      
      const provider = this.getCurrentProvider();
      const stats = this.stats.get(provider.name);
      
      // Skip if recently unhealthy (within last minute)
      if (!stats.healthy && stats.lastError && (Date.now() - stats.lastError.time) < 60000) {
        continue;
      }
      
      // Found a potentially healthy provider
      if (this.currentProviderIndex !== originalIndex) {
        return;
      }
    }
    
    // No healthy providers found, stay on current (will retry)
    console.warn('[RPCManager] No healthy providers available, staying on current');
  }
  
  /**
   * Record latency for a provider
   */
  _recordLatency(providerName, latency) {
    const stats = this.stats.get(providerName);
    if (!stats) return;
    
    stats.latencies.push(latency);
    
    // Keep only last N latencies
    if (stats.latencies.length > stats.maxLatencies) {
      stats.latencies.shift();
    }
  }
  
  /**
   * Get average latency for a provider (or current if not specified)
   */
  getAverageLatency(providerName = null) {
    const name = providerName || this.getCurrentProvider().name;
    const stats = this.stats.get(name);
    
    if (!stats || stats.latencies.length === 0) {
      return null;
    }
    
    const sum = stats.latencies.reduce((a, b) => a + b, 0);
    return Math.round(sum / stats.latencies.length);
  }
  
  /**
   * Get stats for all providers
   */
  getAllStats() {
    const result = {};
    
    for (const provider of this.providers) {
      const stats = this.stats.get(provider.name);
      const performanceScore = this._calculatePerformanceScore(provider);
      
      result[provider.name] = {
        url: provider.url,
        priority: provider.priority,
        hasApiKey: provider.hasApiKey,
        hasPriorityFeeAPI: provider.hasPriorityFeeAPI,
        performanceScore: Math.round(performanceScore),
        requests: stats.requests,
        errors: stats.errors,
        errorRate: stats.requests > 0 ? (stats.errors / stats.requests * 100).toFixed(2) + '%' : '0%',
        avgLatency: this.getAverageLatency(provider.name),
        healthy: stats.healthy,
        lastError: stats.lastError,
        lastHealthCheck: stats.lastHealthCheck,
      };
    }
    
    return result;
  }
  
  /**
   * Start periodic health checks
   */
  _startHealthChecks() {
    this.healthCheckInterval = setInterval(() => {
      this._performHealthChecks();
    }, this.healthCheckIntervalMs);
  }
  
  /**
   * Perform health checks on all providers
   * Also reorders providers based on performance after health checks
   */
  async _performHealthChecks() {
    console.log('[RPCManager] Performing health checks...');
    
    for (const provider of this.providers) {
      try {
        const startTime = Date.now();
        await provider.connection.getSlot();
        const latency = Date.now() - startTime;
        
        const stats = this.stats.get(provider.name);
        stats.healthy = true;
        stats.lastHealthCheck = Date.now();
        this._recordLatency(provider.name, latency);
        
        console.log(`[RPCManager] ${provider.name}: healthy (${latency}ms)`);
        
      } catch (error) {
        const stats = this.stats.get(provider.name);
        stats.healthy = false;
        stats.lastHealthCheck = Date.now();
        
        console.warn(`[RPCManager] ${provider.name}: unhealthy - ${error.message}`);
      }
    }
    
    // Reorder providers based on performance after health checks
    this._reorderProvidersByPerformance();
  }
  
  /**
   * Helper: Create a timeout promise
   */
  _timeout(ms, message) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }
  
  /**
   * Cleanup
   */
  shutdown() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    console.log('[RPCManager] Shutdown complete');
  }
}

module.exports = RPCManager;
