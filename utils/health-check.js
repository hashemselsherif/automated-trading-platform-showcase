// Health check utility for RPC and API connectivity
const { Connection } = require('@solana/web3.js');
const axios = require('axios');

/**
 * Health check manager
 */
class HealthCheckManager {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl;
    this.jupiterApiUrl = options.jupiterApiUrl || 'https://lite-api.jup.ag/swap/v1';
    this.checkInterval = options.checkInterval || 30000; // 30 seconds
    this.timeout = options.timeout || 5000;
    this.connection = null;
    this.priceClient = options.priceClient; // Share price client to coordinate rate limiting
    this.status = {
      rpc: { healthy: null, lastCheck: null, errors: [] },
      api: { healthy: null, lastCheck: null, errors: [] },
    };
  }

  /**
   * Check RPC connectivity
   */
  async checkRPC() {
    if (!this.connection && this.rpcUrl) {
      this.connection = new Connection(this.rpcUrl, 'confirmed');
    }

    if (!this.connection) {
      return {
        healthy: false,
        error: 'No RPC connection configured',
      };
    }

    try {
      const start = Date.now();
      const slot = await Promise.race([
        this.connection.getSlot('confirmed'),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('RPC timeout')), this.timeout)
        ),
      ]);
      const latency = Date.now() - start;

      this.status.rpc = {
        healthy: true,
        lastCheck: new Date().toISOString(),
        latency,
        slot,
        errors: [],
      };

      return {
        healthy: true,
        latency,
        slot,
      };
    } catch (error) {
      const errors = this.status.rpc.errors || [];
      errors.push({
        timestamp: new Date().toISOString(),
        error: error.message,
      });
      
      // Keep last 10 errors
      if (errors.length > 10) errors.shift();

      this.status.rpc = {
        healthy: false,
        lastCheck: new Date().toISOString(),
        errors,
      };

      return {
        healthy: false,
        error: error.message,
      };
    }
  }

  /**
   * Check Jupiter API connectivity
   * CHANGED: Uses batched Jupiter Price API instead of Swap Quote API
   * Smart: Skips check if price was recently fetched (avoids duplicate API calls)
   */
  async checkJupiterAPI() {
    try {
      // Smart health check: If price client exists and recently fetched, assume healthy
      // This prevents duplicate API calls to the same endpoint
      if (this.priceClient && this.priceClient.multiPriceFeed) {
        const jupiterHealth = this.priceClient.multiPriceFeed.sourceHealth?.jupiter;
        if (jupiterHealth) {
          const timeSinceSuccess = jupiterHealth.lastSuccess ? Date.now() - jupiterHealth.lastSuccess : Infinity;
          const timeSinceFailure = jupiterHealth.lastFailure ? Date.now() - jupiterHealth.lastFailure : Infinity;
          
          // If successful price fetch in last 60 seconds, use that as health indicator
          if (timeSinceSuccess < 60000) {
            const healthy = jupiterHealth.consecutiveFailures === 0;
            this.status.api = {
              healthy,
              lastCheck: new Date().toISOString(),
              latency: jupiterHealth.avgLatency || null,
              status: 200,
              errors: [],
              source: 'price_feed',
            };
            
            return {
              healthy,
              latency: jupiterHealth.avgLatency || null,
              status: 200,
              source: 'price_feed',
            };
          }
        }
      }
      
      // Fallback: Direct API call if no recent price fetch data available
      const start = Date.now();
      const response = await axios.get(`https://lite-api.jup.ag/price/v3`, {
        params: { ids: 'SOL' }, // Simple test query
        timeout: this.timeout,
        validateStatus: () => true, // Accept any status
      });
      const latency = Date.now() - start;

      // Healthy if we get 200 and valid data structure
      const healthy = response.status === 200 && response.data?.data?.SOL;

      this.status.api = {
        healthy,
        lastCheck: new Date().toISOString(),
        latency,
        status: response.status,
        errors: [],
        source: 'direct',
      };

      return {
        healthy,
        latency,
        status: response.status,
        source: 'direct',
      };
    } catch (error) {
      const errors = this.status.api.errors || [];
      errors.push({
        timestamp: new Date().toISOString(),
        error: error.message,
      });
      
      if (errors.length > 10) errors.shift();

      this.status.api = {
        healthy: false,
        lastCheck: new Date().toISOString(),
        errors,
      };

      return {
        healthy: false,
        error: error.message,
      };
    }
  }

  /**
   * Run all health checks
   */
  async checkAll() {
    const [rpc, api] = await Promise.allSettled([
      this.checkRPC(),
      this.checkJupiterAPI(),
    ]);

    const rpcResult = rpc.status === 'fulfilled' ? rpc.value : { healthy: false, error: rpc.reason };
    const apiResult = api.status === 'fulfilled' ? api.value : { healthy: false, error: api.reason };

    return {
      rpc: rpcResult,
      api: apiResult,
      overall: rpcResult.healthy && apiResult.healthy,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get current health status
   */
  getStatus() {
    return {
      ...this.status,
      overall: this.status.rpc.healthy && this.status.api.healthy,
    };
  }

  /**
   * Start periodic health checks
   */
  start(interval = null) {
    const checkInterval = interval || this.checkInterval;
    
    this.intervalId = setInterval(async () => {
      await this.checkAll();
    }, checkInterval);

    // Run immediately
    this.checkAll();

    return this.intervalId;
  }

  /**
   * Stop periodic health checks
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

module.exports = HealthCheckManager;

