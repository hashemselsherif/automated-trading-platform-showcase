// perps-client.js
require('dotenv').config();
const axios = require('axios');
const { Connection, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
// Use improved multi-source price feed (Jupiter + Coinbase + Pyth + CoinGecko)
const MultiPriceFeed = require('../../utils/improved-multi-price-feed');
// Note: MultiPriceFeed refers to ImprovedMultiPriceFeed (naming from require statement)
const RPCManager = require('../../utils/rpc-manager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
const withJitter = (ms, j = 0.25) => Math.round(ms + (Math.random()*2-1)*(ms*j));

class JupiterPerpsClient {
  constructor(config, wallet, telegram = null) {
    // Initialize RPC Manager for multi-provider support with failover
    // Note: config.rpcUrl is still checked by RPCManager internally for fallback
    const enableHealthChecks = config?.paperTradingMode === true;
    this.rpcManager = new RPCManager({ enableHealthChecks });
    
    this.config = {
      ...config,
      jupiterApiUrl: config.jupiterApiUrl || 'https://lite-api.jup.ag/swap/v1',
      apiRateLimitMs: Number(process.env.JUP_API_MIN_MS) || config.apiRateLimitMs || 2000,
    };

    this.connection = this.rpcManager.getConnection();
    if (!wallet?.publicKey) throw new Error('Wallet with publicKey required');
    this.wallet = wallet;
    this.telegram = telegram; // Store for alerts

    this.lastApiCallTs = 0;
    this.ongoingPriceRequests = new Map();
    this.priceCache = new Map();
    this.cacheTtlMs = 10_000;

    this.rolling = new Map();
    this.cb = { tripped:false, until:0, errStreak:0 };
    
    // Global request queue to serialize API requests
    this._requestQueue = [];
    this._processingQueue = false;

    this.http = axios.create({
      baseURL: this.config.jupiterApiUrl,
      timeout: 15_000,
      headers: { 'User-Agent':'jupiter-perps-bot/2.0' },
    });
    
    // Initialize multi-source price feed with this client as Jupiter source
    // This provides automatic fallback to Binance/CoinGecko if Jupiter fails
    this.multiPriceFeed = new MultiPriceFeed(this, telegram);
    
    // Track price fetch diagnostics
    this._priceFetchStats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      fallbackToCache: 0,
      lastReportTime: Date.now(),
    };

    this._lastPriceMeta = new Map();
  }

  // --------------------- Anchor plumbing ---------------------
  getProvider() {
    if (!this._provider) {
      const { AnchorProvider } = require('@coral-xyz/anchor');
      const w = {
        publicKey: this.wallet.publicKey,
        signTransaction: tx =>
          this.wallet.signTransaction ? 
            this.wallet.signTransaction(tx) : (tx.sign(this.wallet),tx),
        signAllTransactions: txs =>
          this.wallet.signAllTransactions ? 
            this.wallet.signAllTransactions(txs) : (txs.forEach(t=>t.sign(this.wallet)),txs),
      };
      this._provider = new AnchorProvider(this.connection, w, { commitment:'confirmed' });
    }
    return this._provider;
  }

  getProgram() {
    if (!this._program) {
      const { Program } = require('@coral-xyz/anchor');
      const idl = require('./perps-idl.json'); 
      const programId = new PublicKey(this.config.perpsProgram);
      this._program = new Program(idl, programId, this.getProvider());
    }
    return this._program;
  }

  // --------------------- Price engine ------------------------
  _symbolForMint(mint) {
    const entries = Object.entries(this.config.tokens || {});
    const f = entries.find(([_,m])=>m===mint);
    return f ? f[0] : undefined;
  }

  _resolveDecimals(sym, mint) {
    const d = this.config.tokenDecimals || {};
    // First check symbol-based config (most reliable)
    if (sym && Number.isInteger(d[sym])) {
      return d[sym];
    }
    // Then check mint-based config
    if (mint && Number.isInteger(d[mint])) {
      return d[mint];
    }

    // Hardcoded known mints (fallback)
    if (mint==='So11111111111111111111111111111111111111112') return 9; // SOL
    if (mint==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 6; // USDC
    if (mint==='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 6; // USDT
    if (mint==='7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs') return 8; // ETH
    if (mint==='3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh') return 8; // WBTC/BTC
    
    // Default to 9 decimals (most Solana tokens use 9)
    // This is a fallback - should ideally be caught by config
    console.warn(`⚠️  Using default 9 decimals for ${sym || 'unknown'} (mint: ${mint}). Please add to config.tokenDecimals.`);
    return 9;
  }

  async getMarketPrice(symbol) {
    this._priceFetchStats.totalRequests++;
    
    // Try multi-source price feed first (includes Jupiter, Binance, CoinGecko with fallback)
    try {
      const result = await this.multiPriceFeed.getPrice(symbol);
      try {
        const flagParts = [];
        if (result.cached) flagParts.push('cached');
        if (result.stale) flagParts.push('stale');
        if (Number.isFinite(result.age) && result.age > 0) {
          flagParts.push(`${(result.age / 1000).toFixed(2)}s old`);
        }
        const flags = flagParts.join(', ');
        if (process.env.LOG_PRICE_SOURCES === 'true') {
          console.log(`[PRICE_SRC] ${symbol}: $${Number(result.price).toFixed(4)} from ${result.source}${flags ? ` (${flags})` : ''}`);
        }
      } catch {}
      
      // Update statistics
      if (result.cached && result.stale) {
        this._priceFetchStats.fallbackToCache++;
        console.warn(`⚠️  Using stale cached price for ${symbol} (age: ${(result.age / 1000).toFixed(1)}s)`);
      } else {
        this._priceFetchStats.successfulRequests++;
      }
      
      // Update internal rolling stats for sanity checks
      if (!result.stale) {
        this._push(symbol, result.price);
      }

      this._lastPriceMeta.set(symbol.toUpperCase(), {
        source: result.source || 'unknown',
        cached: !!result.cached,
        stale: !!result.stale,
        ageMs: Number.isFinite(result.age) ? result.age : null,
        latencyMs: Number.isFinite(result.latency) ? result.latency : null,
        via: result.cached ? (result.stale ? 'stale-cache' : 'cache') : 'live',
        batch: !!result.batch,
        timestamp: Date.now(),
      });
      
      // Report diagnostics periodically
      this._maybeReportDiagnostics();
      
      return result.price;
    } catch (multiSourceError) {
      this._priceFetchStats.failedRequests++;
      
      // Log detailed error for debugging
      console.error(`❌ Multi-source price fetch failed for ${symbol}:`, multiSourceError.message);
      
      // CHANGED: Always disable legacy Jupiter Swap Quote API fallback
      // The Swap Quote API is very rate-limited and causes 429s at startup
      // Multi-source feed (Price API + Pyth + Coinbase) is sufficient
      // If all sources fail, use stale cache as last resort
      console.warn(`⚠️  All price sources failed for ${symbol}, checking for stale cache...`);
      
      // Try to use stale cache as last resort (even if expired)
      const staleCached = this.priceCache.get(symbol);
      if (staleCached && staleCached.price && Number.isFinite(staleCached.price)) {
        const cacheAge = Date.now() - staleCached.ts;
        console.warn(`⚠️  Using stale cached price for ${symbol}: $${staleCached.price.toFixed(4)} (${(cacheAge/1000).toFixed(0)}s old)`);
        this._priceFetchStats.fallbackToCache++;
        this._lastPriceMeta.set(symbol.toUpperCase(), {
          source: staleCached.source || 'cache',
          cached: true,
          stale: true,
          ageMs: cacheAge,
          latencyMs: null,
          via: 'stale-cache',
          batch: false,
          timestamp: Date.now(),
        });
        return staleCached.price;
      }
        
        // Report diagnostics on total failure
        this._maybeReportDiagnostics(true);
        
      // No cache available - fail gracefully
      console.error(`❌ Complete price fetch failure for ${symbol} (no cache available)`);
      throw new Error(`All price fetching methods failed for ${symbol}. Multi-source: ${multiSourceError.message}. No cached price available.`);
    }
  }

  // DEPRECATED: Legacy Jupiter Swap Quote API - DO NOT USE
  // This method is kept only for backwards compatibility but should NEVER be called
  // The Swap Quote API is rate-limited and causes 429 errors
  // Use multi-source price feed instead
  async _getMarketPriceJupiterOnly(symbol) {
    console.error(`❌ DEPRECATED: _getMarketPriceJupiterOnly called for ${symbol}`);
    console.error(`   This method uses the rate-limited Jupiter Swap Quote API`);
    console.error(`   Stack trace:`, new Error().stack);
    throw new Error(`DEPRECATED: _getMarketPriceJupiterOnly should not be called. Use multi-source price feed instead.`);
    
    /* DISABLED CODE - DO NOT USE
    const baseMint = this.config.tokens[symbol];
    const quoteMint = this.config.quoteMint || this.config.tokens.USDC;
    if (!baseMint||!quoteMint) throw new Error(`Missing mint for ${symbol}`);

    const cached = this.priceCache.get(symbol);
    if (cached && nowMs()-cached.ts<=this.cacheTtlMs) return cached.price;
    if (this.ongoingPriceRequests.has(symbol)) return this.ongoingPriceRequests.get(symbol);

    const p = (async()=>{
      try {
        const bd = this._resolveDecimals(symbol,baseMint);
        const qSym = this._symbolForMint(quoteMint);
        const qd = this._resolveDecimals(qSym,quoteMint);
        
        if (!qSym) {
          console.warn(`⚠️  Could not resolve symbol for quote mint ${quoteMint}, using default decimals`);
        }
        if (bd === 9 && qd === 9 && quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
          console.error(`❌ CRITICAL: USDC decimal resolution error! Expected 6 decimals, got ${qd}`);
          throw new Error(`USDC decimal resolution failed: expected 6, got ${qd}`);
        }

        const amt = (BigInt(10)**BigInt(bd)).toString();
        const url = `/quote?inputMint=${baseMint}&outputMint=${quoteMint}&amount=${amt}&slippageBps=1`;
        const data = await this._queueRequest(() => this._retryingGet(url));

        const out = BigInt(data.outAmount||0);
        const price = Number(out)/Math.pow(10,qd);

        // Validate price is a finite number
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error(`Invalid price: ${price} (outAmount: ${out}, quoteDecimals: ${qd})`);
        }

        // Enhanced sanity check with price range validation
        // DISABLED: Standard deviation check produces false positives with small samples
        // The rolling stats can have tiny std dev (e.g. 1e-9) causing absurd z-scores
        // Price range checks below are sufficient for catching decimal bugs
        const stat = this._histStats(symbol);
        if (stat) {
          const z = Math.abs(price-stat.median)/(stat.sd||1e-9);
          // Only log for debugging, never throw based on std dev
          if (z>1000 && stat.sd > 0.01) {
            console.warn(`⚠️  Price $${price.toFixed(4)} is ${z.toFixed(2)} std devs from median $${stat.median.toFixed(4)} - std dev: ${stat.sd.toFixed(6)}`);
          }
        }
        
        // Additional validation: check if price is in reasonable range for known tokens
        // This catches decimal resolution errors that might not be caught by historical stats
        // WIDENED ranges to avoid false positives in volatile markets
        const knownPriceRanges = {
          'SOL': { min: 5, max: 2000 },
          'BTC': { min: 10000, max: 500000 },
          'WBTC': { min: 10000, max: 500000 },
          'ETH': { min: 200, max: 30000 },
        };
        
        if (knownPriceRanges[symbol]) {
          const range = knownPriceRanges[symbol];
          if (price < range.min || price > range.max) {
            // Hardened: reject clearly invalid prices to avoid cross-market contamination
            throw new Error(`Price ${price.toFixed(4)} for ${symbol} outside expected range [${range.min}, ${range.max}] (quoteDec: ${qd}, baseDec: ${bd})`);
          }
        }

        this._push(symbol,price);
        this.priceCache.set(symbol,{ts:nowMs(),price});
        return price;
      } finally {
        this.ongoingPriceRequests.delete(symbol);
      }
    })();

    this.ongoingPriceRequests.set(symbol,p);
    return p;
    */
  }
  
  /**
   * Report price fetching diagnostics periodically or on critical failures
   */
  _maybeReportDiagnostics(force = false) {
    const now = Date.now();
    const timeSinceLastReport = now - this._priceFetchStats.lastReportTime;
    const shouldReport = force || timeSinceLastReport > 5 * 60 * 1000; // Every 5 minutes or on force
    
    if (!shouldReport) return;
    
    this._priceFetchStats.lastReportTime = now;
    
    const stats = this._priceFetchStats;
    const successRate = stats.totalRequests > 0 
      ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2)
      : 'N/A';
    
    console.log('\n📊 Price Fetch Diagnostics:');
    console.log(`   Total requests: ${stats.totalRequests}`);
    console.log(`   Successful: ${stats.successfulRequests} (${successRate}%)`);
    console.log(`   Failed: ${stats.failedRequests}`);
    console.log(`   Stale cache fallbacks: ${stats.fallbackToCache}`);
    
    // Also get multi-source health status
    const health = this.multiPriceFeed.getHealthStatus();
    console.log('   Price source health:');
    for (const [source, status] of Object.entries(health)) {
      if (source === 'cacheSize' || source === 'cacheTtlMs') continue;
      const icon = status.available ? '✅' : '🔴';
      console.log(`     ${icon} ${status.name}: ${status.successRate} success, ${status.consecutiveFailures} consecutive failures`);
      if (status.circuitBreaker !== 'OK') {
        console.log(`        ⚠️  Circuit breaker: ${status.circuitBreaker}`);
      }
    }
    console.log('');
  }

  _push(sym,p) {
    const r=this.rolling.get(sym)||{arr:[],max:200};
    r.arr.push(p);
    if(r.arr.length>r.max) r.arr.shift();
    this.rolling.set(sym,r);
  }

  _histStats(sym) {
    const r=this.rolling.get(sym);
    if(!r||r.arr.length<10) return null;
    const arr=[...r.arr].sort((a,b)=>a-b);
    const mid=Math.floor(arr.length/2);
    const median = arr.length%2 ? arr[mid] : (arr[mid-1]+arr[mid])/2;
    const mean = arr.reduce((s,x)=>s+x,0)/arr.length;
    const sd = Math.sqrt(arr.reduce((s,x)=>s+(x-mean)**2,0)/arr.length);
    return {median,sd};
  }

  // --------------------- Trade actions ------------------------
  async openPosition(side,coll,lev,entry,clientOrderId) {
    side=side.toLowerCase();
    if (this.config.paperTradingMode) {
      const positionId = clientOrderId || `paper-${Date.now()}`;
      return {
        positionId,
        clientOrderId: clientOrderId || positionId,
        side,collateral:coll,leverage:lev,
        size:coll*lev,entryPrice:entry,openTime:Date.now(),
        liquidationPrice:this._liq(entry,lev,side)
      };
    }
    const sig=await this._sendOpen(side,coll,lev,entry);
    return {positionId:sig,clientOrderId:clientOrderId||sig,side,collateral:coll,leverage:lev,size:coll*lev,
      entryPrice:entry,openTime:Date.now(),liquidationPrice:this._liq(entry,lev,side)};
  }

  async closePosition(pos,cur) {
    // CRITICAL: Validate price range if market is available
    if (pos.market && pos.entryPrice && cur) {
      // Wide absolute ranges to catch cross-market bugs while allowing extreme volatility
      const priceRanges = {
        'SOL-PERP': { min: 5, max: 2000 },      // Allows 2x rallies and 50% crashes
        'BTC-PERP': { min: 5000, max: 300000 }, // Allows 3x rallies and 50% crashes
        'ETH-PERP': { min: 200, max: 30000 },   // Allows 2x rallies and 50% crashes
      };
      
      // Primary validation: Percentage-based check (exit vs entry)
      // This catches cross-market bugs better than absolute ranges
      const maxMovePercent = 50; // Allow up to ±50% move
      const entryPrice = pos.entryPrice;
      const minExit = entryPrice * (1 - maxMovePercent / 100);
      const maxExit = entryPrice * (1 + maxMovePercent / 100);
      
      if (cur < minExit || cur > maxExit) {
        const priceMovePercent = ((cur - entryPrice) / entryPrice) * 100;
        const errorMsg = `❌ CRITICAL: Exit price $${cur.toFixed(2)} for ${pos.market} is ${Math.abs(priceMovePercent).toFixed(2)}% from entry $${entryPrice.toFixed(2)} (max allowed: ±${maxMovePercent}%). Cross-market price bug detected!`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      // Secondary validation: Absolute range check (logs warning, doesn't throw)
      if (priceRanges[pos.market]) {
        const range = priceRanges[pos.market];
        // Validate entry price (warning only)
        if (pos.entryPrice < range.min || pos.entryPrice > range.max) {
          console.warn(`⚠️  Entry price $${pos.entryPrice.toFixed(2)} for ${pos.market} is outside expected absolute range [${range.min}, ${range.max}]`);
        }
        // Validate exit price (warning only - percentage check is primary)
        if (cur < range.min || cur > range.max) {
          console.warn(`⚠️  Exit price $${cur.toFixed(2)} for ${pos.market} is outside expected absolute range [${range.min}, ${range.max}]. May indicate cross-market bug or extreme conditions.`);
        }
      }
    }
    
    const pnlPct=this._pnl(pos,cur);
    if(this.config.paperTradingMode) {
      // Calculate base PnL
      const basePnl = (pos.collateral * pnlPct) / 100;
      // Apply Jupiter Perps close fee (base fee + price impact fee)
      // Source: https://support.jup.ag/hc/en-us/articles/18735045234588-Fees
      const notionalSize = pos.size || (pos.collateral * (pos.leverage || 1));
      const feeCfg = this.config.fees || {};
      // Base fee: 0.06% (6 basis points) of notional position size
      const baseFee = notionalSize * (feeCfg.closeFeeBps || 6) / 10_000;
      // Price impact fee (if enabled)
      let priceImpactFee = 0;
      if (feeCfg.enablePriceImpactFee !== false) {
        const priceImpactFeeScalar = feeCfg.priceImpactFeeScalar || 125_000_000_000;
        const coefficient = notionalSize / priceImpactFeeScalar;
        priceImpactFee = notionalSize * coefficient;
      }
      const closeFee = baseFee + priceImpactFee;
      return {pnl: basePnl - closeFee};
    }
    const r=await this._sendClose(pos,cur);
    return {pnl:r.pnl};
  }

  async _sendOpen() {
    try {
      const ix = SystemProgram.transfer({fromPubkey:this.wallet.publicKey,toPubkey:this.wallet.publicKey,lamports:0});
      const tx = new Transaction().add(ix);
      tx.feePayer=this.wallet.publicKey;
      const sig = await this.getProvider().sendAndConfirm(tx,[],{skipPreflight:true});
      console.log(`🧾 LIVE OPEN stub tx: ${sig}`);
      return sig;
    } catch(e){ throw new Error('TODO wire Perps open'); }
  }

  async _sendClose(pos,cur) {
    try {
      const pct=this._pnl(pos,cur);
      return {pnl:(pos.collateral*pct)/100};
    } catch(e) { throw new Error('TODO wire Perps close'); }
  }

  // --------------------- Risk math ----------------------------
  _liq(e,l,s){const m=1/Math.max(1,l),d=e*m;return String(s||'').toLowerCase()==='long'?Math.max(0.0001,e-d):e+d;}
  /**
   * Internal PnL calculation using FULL PRECISION prices.
   * IMPORTANT: This uses raw numeric values - never pass formatted strings.
   * @private
   */
  _pnl(p,cur){const m=(cur-p.entryPrice)/p.entryPrice;return (String(p.side||'').toLowerCase()==='long'?m:-m)*p.leverage*100;}
  
  /**
   * Calculate PnL percentage for a position (used by RiskManager)
   * 
   * IMPORTANT: This function uses FULL PRECISION prices for accurate calculations.
   * Price formatting (toFixed, etc.) is ONLY applied for display in logs/UI,
   * never for computations.
   * 
   * @param {Object} position - Position object with entryPrice (full precision)
   * @param {number} currentPrice - Current market price (full precision, NOT formatted)
   * @returns {number} PnL percentage with full precision
   */
  calculatePnL(position, currentPrice) {
    return this._pnl(position, currentPrice);
  }

  /**
   * Get multiple market prices in a single call when supported by the feed
   * @param {string[]} symbols - e.g., ['SOL','ETH','BTC']
   * @returns {Promise<Object>} mapping { symbol: price }
   */
  async getMarketPricesBatch(symbols = []) {
    if (!symbols || symbols.length === 0) return {};
    if (typeof this.multiPriceFeed.getPricesBatch === 'function') {
      const res = await this.multiPriceFeed.getPricesBatch(symbols);
      const out = {};
      for (const s of symbols) {
        if (res[s] && Number.isFinite(res[s].price)) out[s] = res[s].price;
        if (res[s] && Number.isFinite(res[s].price)) {
          this._lastPriceMeta.set(s.toUpperCase(), {
            source: res[s].source || 'unknown',
            cached: !!res[s].cached,
            stale: !!res[s].stale,
            ageMs: Number.isFinite(res[s].age) ? res[s].age : null,
            latencyMs: Number.isFinite(res[s].latency) ? res[s].latency : null,
            via: res[s].cached
              ? (res[s].stale ? 'stale-cache' : 'cache')
              : 'batch',
            batch: !res[s].cached,
            timestamp: Date.now(),
          });
        }
      }
      try {
        if (process.env.LOG_PRICE_SOURCES === 'true') {
          console.log(`[PRICE_SRC_BATCH] ${symbols.join(',')}: ${symbols.map(s=>`${s}=$${Number(out[s]).toFixed(4)}`).join(' ')} (source: mixed)`);
        }
      } catch {}
      return out;
    }
    // Fallback: individual gets
    const out = {};
    for (const s of symbols) {
      out[s] = await this.getMarketPrice(s);
    }
    return out;
  }
  
  /**
   * Check if position is near liquidation (used by RiskManager)
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @returns {boolean} True if near liquidation
   */
  isNearLiquidation(position, currentPrice) {
    if (!position.liquidationPrice) return false;
    const liqPrice = position.liquidationPrice;
    const price = currentPrice;
    const distance = Math.abs(price - liqPrice) / liqPrice;
    // Consider "near" if within 5% of liquidation price
    return distance < 0.05;
  }

  /**
   * Check if position has reached liquidation price (exact check)
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @returns {boolean} True if liquidated (price has reached or exceeded liquidation price)
   */
  isLiquidated(position, currentPrice) {
    if (!position.liquidationPrice || !Number.isFinite(position.liquidationPrice)) return false;
    const side = position.side?.toLowerCase();
    const liqPrice = position.liquidationPrice;
    const price = currentPrice;
    
    // Long position liquidated when price drops to or below liquidation price
    // Short position liquidated when price rises to or above liquidation price
    return side === 'long' 
      ? price <= liqPrice 
      : price >= liqPrice;
  }

  // --------------------- Internals ----------------------------
  async _respectRateLimit() {
    const el = nowMs()-this.lastApiCallTs;
    const wait = this.config.apiRateLimitMs-el;
    if(wait>0) await sleep(wait);
    this.lastApiCallTs=nowMs();
  }

  // Queue-based rate limiting to serialize all API requests
  async _queueRequest(fn) {
    return new Promise((resolve, reject) => {
      this._requestQueue.push({ fn, resolve, reject });
      // Start processing if not already processing
      if (!this._processingQueue) {
        this._processQueue().catch(err => {
          console.error('Error in request queue processing:', err);
        });
      }
    });
  }

  async _processQueue() {
    if (this._processingQueue) return;
    
    this._processingQueue = true;
    
    while (this._requestQueue.length > 0) {
      const { fn, resolve, reject } = this._requestQueue.shift();
      
      try {
        await this._respectRateLimit();
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }
    
    this._processingQueue = false;
  }

  async _retryingGet(url,{max=5,base=800}={}) {
    const wasTripped = this.cb.tripped;
    const inHalfOpen = wasTripped && nowMs() >= this.cb.until;
    
    // Track consecutive 429 errors for circuit breaker
    let consecutive429s = 0;
    
    for(let i=1;i<=max;i++){
      try {
        const r=await this.http.get(url);
        // Success: reset circuit breaker and 429 counter
        this.cb.errStreak=0;
        consecutive429s = 0;
        if(wasTripped) {
          this.cb.tripped=false;
          this.cb.until=0;
          console.log('✅ CB reset (half-open test succeeded)');
        }
        return r.data;
      } catch(e){
        const status=e?.response?.status;
        const ra=Number(e?.response?.headers?.['retry-after']);
        
        // 429 errors are rate limiting, not service failures - handle more gracefully
        const isRateLimit = status === 429;
        
        if (isRateLimit) {
          consecutive429s++;
          
          // Trip circuit breaker if we get too many consecutive 429s
          if (consecutive429s >= 5) {
            this.cb.tripped = true;
            this.cb.until = nowMs() + 10 * 60 * 1000; // 10 minute cooldown
            console.log(`⚠️  Circuit breaker tripped: ${consecutive429s} consecutive 429 errors. Cooldown: 10 minutes`);
            throw new Error(`Rate limit exceeded: ${consecutive429s} consecutive 429 errors`);
          }
          
          // Increase rate limit delay more aggressively when getting 429s
          const oldRateLimit = this.config.apiRateLimitMs;
          this.config.apiRateLimitMs = Math.min(
            Math.max(this.config.apiRateLimitMs * 1.5, 2000), 
            15000
          );
          
          if (this.config.apiRateLimitMs > oldRateLimit) {
            console.log(`📈 Rate limit increased from ${oldRateLimit}ms to ${this.config.apiRateLimitMs}ms due to 429 errors`);
          }
        }
        
        // If we're in half-open state and the test request failed, trip again
        // But be more lenient with 429 errors - they're expected under load
        if(inHalfOpen && i===1 && !isRateLimit) {
          this.cb.errStreak++;
          this.cb.tripped=true;
          this.cb.until=nowMs()+5*60*1000;
          console.log(`⚠️  CB half-open test failed (status: ${status}), tripping again for 5 minutes`);
        }
        
        if(i===max) {
          // Only increment error streak for non-429 errors (rate limits are expected)
          // Only increment if not in half-open (half-open already handled above)
          if(!inHalfOpen && !isRateLimit) {
            this.cb.errStreak++;
            if(this.cb.errStreak>=3){
              this.cb.tripped=true;
              this.cb.until=nowMs()+5*60*1000;
              console.log(`⚠️  CB tripped after ${this.cb.errStreak} consecutive failures (5 min cooldown)`);
            }
          }
          throw new Error(`GET fail ${url} after ${max} attempts`);
        }
        
        // Calculate retry delay
        let d;
        if(isRateLimit){
          // For 429 errors, use retry-after header if available, otherwise use exponential backoff
          // But ensure delay is at least as long as the current rate limit
          const minDelay = this.config.apiRateLimitMs;
          if (ra && ra > 0) {
            d = Math.max(ra * 1000, minDelay);
          } else {
            // Exponential backoff: base * 2^i, but at least apiRateLimitMs
            const expDelay = base * Math.pow(2, i);
            d = Math.max(expDelay, minDelay);
            // Add jitter (10-20% variation)
            d = withJitter(d, 0.15);
          }
          console.log(`Server responded with 429 Too Many Requests. Retrying after ${Math.round(d)}ms delay... (attempt ${i}/${max})`);
        } else {
          d = withJitter(base * Math.pow(2, i));
        }
        
        // Wait for the delay, then respect rate limit before retrying
        await sleep(d);
        await this._respectRateLimit();
      }
    }
  }

  getLastPriceMeta(symbol) {
    if (!symbol) return null;
    return this._lastPriceMeta.get(symbol.toUpperCase()) || null;
  }
}

module.exports = JupiterPerpsClient;
