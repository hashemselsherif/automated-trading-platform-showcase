// ui-server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
let compression;
try {
  compression = require('compression');
} catch (e) {
  // Optional dependency; if missing we skip compression
}
const config = require('../../config');
const { PublicKey } = require('@solana/web3.js');
const JupiterPerpsLive = require('../execution/perps-live-client');
const { MARKET_REGISTRY } = require('../execution/perps-live-client');
const { getManualTradePasswordSync, getManualTradePassword } = require('../../utils/secure-password-loader');

let perpsClientPromise = null;
let perpsMarketCache = null;
let perpsMarketCacheLoadedAt = 0;
const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Initialize API_KEY from encrypted storage if not already set
 * This allows the server to use SECRETS_MASTER_PASSWORD to decrypt .secrets.enc.json
 */
async function initializeApiKey() {
  // Only load if not already set in environment
  if (process.env.API_KEY) {
    return; // Already set, no need to load from encrypted storage
  }

  try {
    // Try to load from encrypted storage using secure password loader
    const apiKey = await getManualTradePassword(false); // Don't prompt in server
    
    if (apiKey) {
      process.env.API_KEY = apiKey;
      console.log('✅ [SECURE] API_KEY loaded from encrypted storage');
      return;
    }
  } catch (error) {
    // If secure loader fails (e.g., no SECRETS_MASTER_PASSWORD), that's okay
    // We'll fall back to checking if it's set as env var or secret file
    console.log('ℹ️  [SECURE] Could not load API_KEY from encrypted storage:', error.message);
  }

  // Fallback: Try Render secret file
  const fs = require('fs');
  const renderApiKeyPath = '/etc/secrets/API_KEY';
  if (fs.existsSync(renderApiKeyPath)) {
    try {
      const apiKey = fs.readFileSync(renderApiKeyPath, 'utf-8').trim();
      if (apiKey) {
        process.env.API_KEY = apiKey;
        console.log('✅ [SECURE] API_KEY loaded from Render secret file');
        return;
      }
    } catch (error) {
      // Silent fail
    }
  }

  // If still not set, that's okay - authentication will be disabled or use UI_PASSWORD
  if (!process.env.API_KEY) {
    console.log('ℹ️  [SECURE] API_KEY not found in encrypted storage or secret files');
    console.log('   Server will use UI_PASSWORD for authentication if set, or disable auth for localhost');
  } else {
    // Log that API_KEY is set (first 4 chars only for security)
    const preview = process.env.API_KEY.substring(0, 4);
    console.log(`✅ [SECURE] API_KEY initialized (${process.env.API_KEY.length} chars, starts with: ${preview}...)`);
  }
}

async function getPerpsClient() {
  if (!perpsClientPromise) {
    console.log('🔄 Creating new Jupiter Perps client...');
    perpsClientPromise = (async () => {
      const client = new JupiterPerpsLive();
      await client.init();
      console.log('✅ Jupiter Perps client initialized');
      return client;
    })();

    perpsClientPromise.catch((error) => {
      console.error('❌ Perps client initialization failed:', error.message);
      perpsClientPromise = null;
    });
  }
  return perpsClientPromise;
}

const MARKET_ADDRESS_KEYS = [
  'address',
  'market',
  'marketAddress',
  'marketPk',
  'marketPublicKey',
  'publicKey',
  'pubkey',
];

function toStringKey(value) {
  if (!value) return null;
  try {
    if (typeof value === 'string') return value;
    if (typeof value.toBase58 === 'function') return value.toBase58();
    if (typeof value.toString === 'function') return value.toString();
    return String(value);
  } catch {
    return null;
  }
}

function recordMarket(map, market, fallbackSymbol) {
  if (!market) return;
  const keyCandidate = MARKET_ADDRESS_KEYS
    .map((k) => toStringKey(market[k]))
    .find((val) => val);

  const key = keyCandidate || toStringKey(market);
  if (!key) return;

  const symbolCandidate = [
    market.symbol,
    market.name,
    market.marketSymbol,
    market.ticker,
    fallbackSymbol,
  ].find((val) => typeof val === 'string' && val.trim().length > 0);

  const symbol = symbolCandidate ? symbolCandidate.toUpperCase() : key;

  if (!map.has(key)) {
    map.set(key, { symbol, raw: market });
  }
}

async function getPerpsMarketCache(client) {
  const now = Date.now();
  if (perpsMarketCache && now - perpsMarketCacheLoadedAt < MARKET_CACHE_TTL_MS) {
    return perpsMarketCache;
  }

  const map = new Map();
  const configuredMarkets = Array.isArray(config.markets) && config.markets.length > 0
    ? config.markets
    : [config.market].filter(Boolean);

  try {
    const listMarkets = client?._meth?.listMarkets?.fn || (
      typeof client?._meth?.listMarkets === 'function' ? client._meth.listMarkets : null
    );
    if (typeof listMarkets === 'function') {
      const markets = await listMarkets(client.group);
      if (Array.isArray(markets)) {
        for (const market of markets) {
          recordMarket(map, market);
        }
      }
    }
  } catch (error) {
    console.warn('⚠️  Failed to list perps markets:', error.message);
  }

  if (Array.isArray(configuredMarkets)) {
    for (const symbol of configuredMarkets) {
      if (!symbol) continue;
      const getBySymbol = client?._meth?.getMarketBySymbol;
      if (getBySymbol?.fn) {
        try {
          const market = await getBySymbol.fn(symbol, client.group);
          recordMarket(map, market, symbol);
        } catch (error) {
          console.warn(`⚠️  Failed to resolve market ${symbol}:`, error.message);
        }
      }
    }
  }

  // Always include markets from MARKET_REGISTRY when in manual builder mode
  if (MARKET_REGISTRY && Object.keys(MARKET_REGISTRY).length > 0) {
    console.log('📋 Using manual market registry (jup-perps-client mode)');
    for (const [symbol, marketConfig] of Object.entries(MARKET_REGISTRY)) {
      recordMarket(map, marketConfig, symbol);
    }
  } else if (map.size === 0 && client.market) {
    // Fallback: use client's configured market
    recordMarket(map, client.market, client.marketSymbol || config.market);
  }

  perpsMarketCache = map;
  perpsMarketCacheLoadedAt = now;
  return perpsMarketCache;
}

function normalizeSide(side) {
  if (typeof side === 'string') {
    if (side.toLowerCase().includes('short')) return 'short';
    if (side.toLowerCase().includes('long')) return 'long';
  }
  if (typeof side === 'number') {
    if (side === 0) return 'short';
    if (side === 1) return 'long';
    return side > 0 ? 'long' : 'short';
  }
  return 'long';
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toTimestamp(value) {
  const now = Date.now();
  if (value === null || value === undefined) return now;
  const num = Number(value);
  if (!Number.isFinite(num)) return now;
  if (num > 1e12) return Math.round(num);
  if (num > 1e9) return Math.round(num * 1000);
  if (num < 1e6) return now;
  return Math.round(num);
}

async function fetchWalletPositions(walletPublicKey) {
  const client = await getPerpsClient();
  if (!client?._meth?.getUserState?.fn) {
    throw new Error('Perps client does not expose getUserState');
  }

  const userState = await client._meth.getUserState.fn(client.group, walletPublicKey);
  const marketCache = await getPerpsMarketCache(client);

  const rawPositions = Array.isArray(userState?.positions)
    ? userState.positions
    : Array.isArray(userState?.openPositions)
      ? userState.openPositions
      : [];

  return rawPositions
    .map((pos) => {
      const marketKeyCandidate = MARKET_ADDRESS_KEYS
        .map((k) => toStringKey(pos?.[k]))
        .find((val) => val);
      const marketKey = marketKeyCandidate || toStringKey(pos?.marketAddress || pos?.market);
      const marketMeta = marketKey ? marketCache.get(marketKey) : null;
      const marketSymbol = (marketMeta?.symbol || pos?.symbol || pos?.marketSymbol || config.market || 'UNKNOWN').toUpperCase();

      const baseSize = toNumber(
        pos?.size ??
        pos?.basePosition ??
        pos?.baseSize ??
        pos?.quantity ??
        pos?.base ??
        0,
        0
      );

      let sizeUsd = toNumber(
        pos?.sizeUsd ??
        pos?.notionalUsd ??
        pos?.positionUsd ??
        pos?.notional_value ??
        0,
        0
      );

      const entryPrice = toNumber(pos?.entryPrice ?? pos?.avgEntryPrice ?? pos?.avgPrice ?? pos?.price, 0);
      const collateral = toNumber(pos?.collateralUsd ?? pos?.collateral ?? pos?.margin ?? 0, 0);
      let leverage = toNumber(pos?.leverage, 0);
      if (!Number.isFinite(leverage) || leverage <= 0) {
        leverage = collateral > 0 ? sizeUsd / Math.max(collateral, 1e-9) : 0;
      }
      const liquidationPrice = toNumber(pos?.liqPrice ?? pos?.liquidationPrice ?? pos?.liquidation ?? 0, 0) || undefined;

      if (sizeUsd <= 0 && entryPrice > 0 && baseSize > 0) {
        sizeUsd = baseSize * entryPrice;
      }
      if (sizeUsd <= 0 && baseSize > 0) {
        sizeUsd = baseSize;
      }

      const positionId = String(
        pos?.positionId ??
        pos?.id ??
        pos?.position_id ??
        `${marketSymbol}-${walletPublicKey.toBase58().slice(0, 8)}`
      );

      const clientOrderId = String(
        pos?.clientOrderId ??
        pos?.client_order_id ??
        pos?.orderId ??
        ''
      );

      return {
        positionId,
        clientOrderId,
        market: marketSymbol,
        side: normalizeSide(pos?.side),
        size: sizeUsd,
        notionalUsd: sizeUsd,
        baseSize,
        entryPrice,
        collateral,
        leverage,
        openTime: toTimestamp(pos?.openTime ?? pos?.timestamp ?? pos?.openTs ?? pos?.ts ?? pos?.time),
        liquidationPrice,
        source: 'wallet',
      };
    })
    .filter((pos) => Number.isFinite(pos.size) && pos.size > 0);
}

// Security utilities (optional - may not exist)
let authenticateApiKey, rateLimiter, validateWebSocketMessage, validateTransactionParams, logApiAccess, logSecurityEvent, logTransaction;
try {
  const auth = require('../../utils/auth');
  authenticateApiKey = auth.authenticateApiKey;
  rateLimiter = auth.rateLimiter;
} catch (e) {
  // Auth utilities not available, use fallback
}

try {
  const validator = require('../../utils/input-validator');
  validateWebSocketMessage = validator.validateWebSocketMessage;
  validateTransactionParams = validator.validateTransactionParams;
} catch (e) {
  // Validator utilities not available
}

try {
  const logger = require('../../utils/audit-logger');
  logApiAccess = logger.logApiAccess;
  logSecurityEvent = logger.logSecurityEvent;
  logTransaction = logger.logTransaction;
} catch (e) {
  // Logger utilities not available
}

// Use config.js as single source of truth
const PORT = config.uiPort;
const MAX_CONNECTIONS = config.wsMaxConnections;
const MESSAGE_SIZE_LIMIT = config.messageSizeLimit;

// global state
let handlers = {
  pause: () => {},
  resume: () => {},
  closeAll: () => {},
  closePosition: () => {},
  status: () => ({}),
  getConfig: () => ({}),
  updateConfig: () => {},
};

// Cache for gate analytics from bot (updated via WebSocket)
let cachedGateAnalytics = null;
let cachedGateAnalyticsTimestamp = 0;

const app = express();
const server = http.createServer(app);

// Trust proxy (required for Cloudflare Tunnel, nginx, etc.)
// Configure via TRUST_PROXY env var; default to safe presets
const trustProxySetting = (() => {
  const raw = process.env.TRUST_PROXY;
  if (!raw) {
    return process.env.NODE_ENV === 'production' ? 1 : 'loopback';
  }

  const normalized = raw.trim().toLowerCase();

  if (['false', 'off', 'no'].includes(normalized)) {
    return false;
  }

  if (['true', 'on', 'yes'].includes(normalized)) {
    return 1;
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return false;
  }

  return parts.length === 1 ? parts[0] : parts;
})();

app.set('trust proxy', trustProxySetting);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://s3.tradingview.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://s3.tradingview.com"],
      imgSrc: ["'self'", "data:", "https:", "https://s3.tradingview.com"],
      fontSrc: ["'self'", "data:", "https://r2cdn.perplexity.ai", "https://s3.tradingview.com"],
      connectSrc: ["'self'", "ws:", "wss:", "https:", "https://s3.tradingview.com"],
      frameSrc: ["'self'", "https://s.tradingview.com", "https://www.tradingview.com"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:", "https://s.tradingview.com"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// Enable gzip compression if available
if (compression && typeof compression === 'function') {
  app.use(compression({ threshold: 0 }));
}

// CORS configuration
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, static assets, etc.)
    // Also allow localhost on any port for development
    if (!origin || 
        allowedOrigins.includes(origin) || 
        process.env.NODE_ENV === 'development' ||
        (origin && origin.startsWith('http://localhost'))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Body parser with size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000), // 1 minute
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 100), // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Health check endpoint - always available without auth for deployment health checks
app.get('/api/status', async (req, res) => {
  try {
    // If handlers are set, use them (bot is running in same process)
    if (handlers.status && typeof handlers.status === 'function') {
      res.json(handlers.status());
      return;
    }
    
    // Handlers not set - check if bot is connected via WebSocket
    if (botWs && botWs.readyState === 1) {
      // Bot is connected via WebSocket - request status
      try {
        botWs.send(JSON.stringify({ ev: 'command', cmd: 'get_status' }));
        // Return minimal status - real status will come via WebSocket broadcast
        // This is a fallback, the UI should use WebSocket for real-time updates
        res.json({
          status: 'ok',
          initialized: true,
          botRunning: true,
          botStatus: 'connected',
          mode: 'unknown',
          execMode: 'unknown',
          paused: false,
          markets: [],
          marketPrices: {},
          marketPerformance: {},
          openPositions: [],
          portfolio: {},
          totalEquity: 0,
          freeCapital: 0,
          lockedCapital: 0,
          positions: 0,
          posCap: 0,
          dailyTrades: 0,
          dailyCap: 0,
        });
        return;
      } catch (e) {
        console.warn('Failed to request status from bot via WebSocket:', e.message);
      }
    }
    
    // Try to check PM2 status (for local development)
    try {
      const processes = await getPM2Processes();
      const bot = processes.find(p => p.name === 'jupiter-perps-bot');
      
      if (bot && bot.pm2_env && bot.pm2_env.status === 'online') {
        // Bot is running via PM2 but handlers not set (separate processes)
        // Return minimal status indicating bot is running but not connected
        res.json({
          status: 'ok',
          initialized: false,
          botRunning: true,
          botStatus: 'online',
          mode: 'unknown',
          execMode: 'unknown',
          paused: false,
          markets: [],
          marketPrices: {},
          marketPerformance: {},
          openPositions: [],
          portfolio: {},
          totalEquity: 0,
          freeCapital: 0,
          lockedCapital: 0,
          positions: 0,
          posCap: 0,
          dailyTrades: 0,
          dailyCap: 0,
        });
        return;
      }
    } catch (pm2Error) {
      // PM2 not available (expected on Render where services are separate)
      // This is fine - just return minimal status
    }
    
    // Bot not running or PM2 not available - return minimal status
    res.json({
      status: 'ok',
      initialized: false,
      botRunning: false,
      botStatus: 'offline',
      mode: 'unknown',
      execMode: 'unknown',
      paused: false,
      markets: [],
      marketPrices: {},
      marketPerformance: {},
      openPositions: [],
      portfolio: {},
      totalEquity: 0,
      freeCapital: 0,
      lockedCapital: 0,
      positions: 0,
      posCap: 0,
      dailyTrades: 0,
      dailyCap: 0,
    });
  } catch (e) {
    // Even on error, return 200 for health check (but log the error)
    console.error('Health check error:', e.message);
    res.status(200).json({ 
      status: 'ok', 
      initialized: false,
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message 
    });
  }
});

// Protected status endpoint (requires authentication) - for actual bot status
app.get('/api/status/detailed', optionalAuth, async (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/status/detailed', 'GET', { ip: req.ip });
    }
    if (handlers.status && typeof handlers.status === 'function') {
      res.json(handlers.status());
    } else {
      // Return minimal status if handlers not set (bot service not connected)
      // Try to check PM2 status for local development
      try {
        const processes = await getPM2Processes();
        const bot = processes.find(p => p.name === 'jupiter-perps-bot');
        
        if (bot && bot.pm2_env && bot.pm2_env.status === 'online') {
          res.json({
            initialized: false,
            botRunning: true,
            botStatus: 'online',
            mode: 'unknown',
            execMode: 'unknown',
            paused: false,
            markets: [],
            marketPrices: {},
            marketPerformance: {},
            openPositions: [],
            portfolio: {},
            totalEquity: 0,
            freeCapital: 0,
            lockedCapital: 0,
            positions: 0,
            posCap: 0,
            dailyTrades: 0,
            dailyCap: 0,
          });
        } else {
          res.json({
            initialized: false,
            botRunning: false,
            botStatus: 'offline',
            mode: 'unknown',
            execMode: 'unknown',
            paused: false,
            markets: [],
            marketPrices: {},
            marketPerformance: {},
            openPositions: [],
            portfolio: {},
            totalEquity: 0,
            freeCapital: 0,
            lockedCapital: 0,
            positions: 0,
            posCap: 0,
            dailyTrades: 0,
            dailyCap: 0,
          });
        }
      } catch (pm2Error) {
        // PM2 not available - return minimal status
        res.json({
          initialized: false,
          botRunning: false,
          botStatus: 'unknown',
          mode: 'unknown',
          execMode: 'unknown',
          paused: false,
          markets: [],
          marketPrices: {},
          marketPerformance: {},
          openPositions: [],
          portfolio: {},
          totalEquity: 0,
          freeCapital: 0,
          lockedCapital: 0,
          positions: 0,
          posCap: 0,
          dailyTrades: 0,
          dailyCap: 0,
        });
      }
    }
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Require auth middleware - allow localhost without auth for development
function optionalAuth(req, res, next) {
  const localHosts = ['localhost', '127.0.0.1'];
  const localIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const hostname = String(req.hostname || '').toLowerCase();
  const ip = req.ip || req.connection?.remoteAddress;
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();

  const isLocalHost = localHosts.some((h) => hostname === h || hostname.startsWith(`${h}:`) || hostHeader.startsWith(h));
  const isLocalIp = localIps.some((local) => (ip && ip.includes(local)) || (forwarded && forwarded.includes(local)));

  const authDisabled = process.env.REQUIRE_API_AUTH === 'false';
  const isLocalRequest = isLocalHost || isLocalIp;

  if (authDisabled || isLocalRequest) {
    return next();
  }

  const expectedKey = process.env.API_KEY && process.env.API_KEY.trim();
  if (!expectedKey) {
    console.error('❌ API_KEY is not configured but authentication is required.');
    console.error('   Check if initializeApiKey() completed successfully during server startup.');
    return res.status(500).json({
      error: 'Server authentication misconfigured',
      message: 'API_KEY environment variable must be set when REQUIRE_API_AUTH is enabled.',
    });
  }

  if (authenticateApiKey && typeof authenticateApiKey === 'function') {
    return authenticateApiKey(req, res, next);
  }

  const headerApiKey = Array.isArray(req.headers['x-api-key'])
    ? req.headers['x-api-key'][0]
    : req.headers['x-api-key'];
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  let providedKey = headerApiKey || req.query.apiKey;

  if (!providedKey && typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      providedKey = trimmed.slice(7).trim();
    }
  }

  if (providedKey === expectedKey) {
    return next();
  }

  // Log authentication failure with debug info (first 4 chars only for security)
  const expectedPreview = expectedKey ? `${expectedKey.substring(0, 4)}...` : 'not set';
  const providedPreview = providedKey ? `${providedKey.substring(0, 4)}...` : 'not provided';
  console.warn(`⚠️  [AUTH] Authentication failed for ${req.path}`);
  console.warn(`   Expected: ${expectedPreview} (length: ${expectedKey?.length || 0})`);
  console.warn(`   Provided: ${providedPreview} (length: ${providedKey?.length || 0})`);
  console.warn(`   Header present: ${!!headerApiKey}, Query param: ${!!req.query.apiKey}, Bearer: ${!!(authHeader && authHeader.toLowerCase().startsWith('bearer '))}`);

  if (logSecurityEvent) {
    logSecurityEvent('http_auth_failed', { ip: req.ip, path: req.path });
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Provide valid API key via X-API-Key header, Bearer token, or apiKey query parameter.',
  });
}

app.get('/api/perps/positions/:walletAddress', optionalAuth, async (req, res) => {
  const walletAddress = String(req.params.walletAddress || '').trim();

  if (!walletAddress) {
    res.status(400).json({ error: 'walletAddress parameter is required' });
    return;
  }

  let publicKey;
  try {
    publicKey = new PublicKey(walletAddress);
  } catch (error) {
    res.status(400).json({ error: 'Invalid Solana wallet address' });
    return;
  }

  try {
    const positions = await fetchWalletPositions(publicKey);
    res.json({
      wallet: walletAddress,
      positions,
      fetchedAt: Date.now(),
    });
  } catch (error) {
    console.error(`❌ Failed to fetch wallet positions for ${walletAddress}:`, error);
    const message = process.env.NODE_ENV === 'production'
      ? 'Unable to fetch wallet positions'
      : error.message;
    res.status(502).json({ error: message });
  }
});

// Manual trade endpoints (wallet-based, separate from bot)
const txBuilder = require('../../utils/perps-transaction-builder');

/**
 * POST /api/perps/manual/open
 * Open a manual position using connected wallet
 * Body: { walletAddress, market, side, collateralUsd, leverage, priceLimit?, password }
 */
app.post('/api/perps/manual/open', optionalAuth, async (req, res) => {
  if (logApiAccess) logApiAccess('/api/perps/manual/open', 'POST', { ip: req.ip });
  if (logSecurityEvent) logSecurityEvent('manual_position_open', { source: 'api', ip: req.ip });

  const {
    walletAddress,
    market,
    side,
    collateralUsd,
    leverage,
    priceLimit,
    password,
  } = req.body || {};

  // Validate required fields
  if (!walletAddress || !market || !side || !collateralUsd || !leverage) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['walletAddress', 'market', 'side', 'collateralUsd', 'leverage'],
    });
  }

  // Validate password (basic check - enhance with actual auth)
  const expectedPassword = process.env.UI_PASSWORD || process.env.API_KEY;
  if (expectedPassword && password !== expectedPassword) {
    if (logSecurityEvent) {
      logSecurityEvent('manual_trade_auth_failed', {
        source: 'api',
        ip: req.ip,
        wallet: walletAddress,
      });
    }
    return res.status(401).json({ error: 'Invalid password' });
  }

  try {
    // Validate parameters
    txBuilder.validateOpenPositionParams({
      side,
      collateralUsd,
      leverage,
      market,
    });

    // Get perps client
    const client = await getPerpsClient();
    if (!client) {
      return res.status(503).json({ error: 'Perps client not available' });
    }

    // Get market metadata
    const marketCache = await getPerpsMarketCache(client);
    const marketSymbol = market.toUpperCase();
    let marketObj = null;

    for (const [_, entry] of marketCache) {
      if (entry.symbol === marketSymbol) {
        marketObj = entry.raw;
        break;
      }
    }

    if (!marketObj) {
      return res.status(400).json({
        error: `Market ${marketSymbol} not found`,
        availableMarkets: Array.from(marketCache.values()).map(e => e.symbol),
      });
    }

    // Build transaction request
    const clientOrderId = txBuilder.generateClientOrderId('manual');
    
    // Build transaction with perps-live-client (request-based)
    {
      const request = txBuilder.buildOpenPositionRequest({
        group: client.group,
        market: marketObj,
        side,
        collateralUsd,
        leverage,
        slippageBps: config.risk?.slippageBps || 50,
        priceLimit,
        clientOrderId,
      });

      if (client._manualCreateIncreaseRequest && typeof client._manualCreateIncreaseRequest === 'function') {
        // Use manual builder (jup-perps-client)
        txLike = await client._manualCreateIncreaseRequest(request);
      } else if (client._meth?.createIncreaseReq && typeof client._meth.createIncreaseReq.fn === 'function') {
        // Use SDK method (legacy)
        txLike = await client._meth.createIncreaseReq.fn(request);
      } else {
        return res.status(503).json({ error: 'SDK increase method not available' });
      }
    }

    // Return unsigned transaction for wallet to sign
    // The UI will handle signing and submission via wallet adapter
    const normalizedTx = txBuilder.normalizeTxPayload(txLike);
    
    // Add recent blockhash if this is a legacy Transaction
    if (normalizedTx.recentBlockhash === undefined && !normalizedTx.message) {
      const { blockhash } = await client.connection.getLatestBlockhash('confirmed');
      normalizedTx.recentBlockhash = blockhash;
      normalizedTx.feePayer = new PublicKey(walletAddress);
    }
    
    // Serialize transaction for client
    let serializedTx;
    if (normalizedTx.serialize) {
      serializedTx = normalizedTx.serialize({ requireAllSignatures: false }).toString('base64');
    } else if (normalizedTx.message) {
      serializedTx = Buffer.from(normalizedTx.message.serialize()).toString('base64');
    } else {
      return res.status(500).json({ error: 'Unable to serialize transaction' });
    }

    res.json({
      ok: true,
      transaction: serializedTx,
      clientOrderId,
      request: {
        market: marketSymbol,
        side,
        collateralUsd,
        leverage,
        priceLimit,
      },
      message: 'Transaction ready for wallet signature',
    });
  } catch (error) {
    console.error('❌ Manual position open failed:', error);
    
    // Parse common errors and provide helpful messages
    let userMessage = 'Failed to create position';
    let details = error.message;
    
    // Insufficient funds
    if (error.message?.includes('insufficient') || 
        error.message?.includes('Insufficient') ||
        error.message?.includes('0x1') || // Solana insufficient funds error code
        error.message?.toLowerCase().includes('balance')) {
      userMessage = 'Insufficient balance';
      details = `Your wallet doesn't have enough SOL or collateral for this trade. Required: ~$${collateralUsd} + gas fees (~0.01 SOL)`;
    }
    // Position too small
    else if (error.message?.includes('minimum') || 
             error.message?.includes('too small') ||
             error.message?.includes('MIN_')) {
      userMessage = 'Position size too small';
      details = 'The position size is below the minimum required by the protocol. Try increasing your collateral.';
    }
    // Slippage
    else if (error.message?.includes('slippage') || 
             error.message?.includes('price') ||
             error.message?.includes('Slippage')) {
      userMessage = 'Price slippage exceeded';
      details = 'The price moved too much. Try again with a higher slippage tolerance or different price limit.';
    }
    // Network/RPC errors
    else if (error.message?.includes('network') || 
             error.message?.includes('timeout') ||
             error.message?.includes('RPC') ||
             error.message?.includes('connection')) {
      userMessage = 'Network error';
      details = 'Failed to connect to Solana network. Check your RPC endpoint and try again.';
    }
    // Transaction simulation failure
    else if (error.message?.includes('simulation') || 
             error.message?.includes('simulate')) {
      userMessage = 'Transaction simulation failed';
      details = error.message;
    }
    
    res.status(500).json({ 
      error: userMessage,
      details: details,
      rawError: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

/**
 * POST /api/perps/manual/close
 * Close a manual position using connected wallet
 * Body: { walletAddress, market, priceLimit?, password }
 */
app.post('/api/perps/manual/close', optionalAuth, async (req, res) => {
  if (logApiAccess) logApiAccess('/api/perps/manual/close', 'POST', { ip: req.ip });
  if (logSecurityEvent) logSecurityEvent('manual_position_close', { source: 'api', ip: req.ip });

  const {
    walletAddress,
    market,
    priceLimit,
    password,
  } = req.body || {};

  // Validate required fields
  if (!walletAddress || !market) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['walletAddress', 'market'],
    });
  }

  // Validate password
  const expectedPassword = process.env.UI_PASSWORD || process.env.API_KEY;
  if (expectedPassword && password !== expectedPassword) {
    if (logSecurityEvent) {
      logSecurityEvent('manual_trade_auth_failed', {
        source: 'api',
        ip: req.ip,
        wallet: walletAddress,
      });
    }
    return res.status(401).json({ error: 'Invalid password' });
  }

  try {
    // Validate parameters
    txBuilder.validateClosePositionParams({ market });

    // Get perps client
    const client = await getPerpsClient();
    if (!client) {
      return res.status(503).json({ error: 'Perps client not available' });
    }

    // Get market metadata
    const marketCache = await getPerpsMarketCache(client);
    const marketSymbol = market.toUpperCase();
    let marketObj = null;

    for (const [_, entry] of marketCache) {
      if (entry.symbol === marketSymbol) {
        marketObj = entry.raw;
        break;
      }
    }

    if (!marketObj) {
      return res.status(400).json({
        error: `Market ${marketSymbol} not found`,
        availableMarkets: Array.from(marketCache.values()).map(e => e.symbol),
      });
    }

    // Build transaction request
    const request = txBuilder.buildClosePositionRequest({
      group: client.group,
      market: marketObj,
      slippageBps: config.risk?.slippageBps || 50,
      priceLimit,
    });

    // Create decrease request using SDK or manual builder
    let txLike;
    
    if (client._manualCreateDecreaseRequest && typeof client._manualCreateDecreaseRequest === 'function') {
      // Use manual builder (jup-perps-client)
      txLike = await client._manualCreateDecreaseRequest(request);
    } else if (client._meth?.createDecreaseReq && typeof client._meth.createDecreaseReq.fn === 'function') {
      // Use SDK method (legacy)
      txLike = await client._meth.createDecreaseReq.fn(request);
    } else {
      return res.status(503).json({ error: 'SDK decrease method not available' });
    }

    // Return unsigned transaction for wallet to sign
    const normalizedTx = txBuilder.normalizeTxPayload(txLike);
    
    // Add recent blockhash if this is a legacy Transaction
    if (normalizedTx.recentBlockhash === undefined && !normalizedTx.message) {
      const { blockhash } = await client.connection.getLatestBlockhash('confirmed');
      normalizedTx.recentBlockhash = blockhash;
      normalizedTx.feePayer = new PublicKey(walletAddress);
    }
    
    // Serialize transaction for client
    let serializedTx;
    if (normalizedTx.serialize) {
      serializedTx = normalizedTx.serialize({ requireAllSignatures: false }).toString('base64');
    } else if (normalizedTx.message) {
      serializedTx = Buffer.from(normalizedTx.message.serialize()).toString('base64');
    } else {
      return res.status(500).json({ error: 'Unable to serialize transaction' });
    }

    res.json({
      ok: true,
      transaction: serializedTx,
      request: {
        market: marketSymbol,
        priceLimit,
      },
      message: 'Transaction ready for wallet signature',
    });
  } catch (error) {
    console.error('❌ Manual position close failed:', error);
    const message = process.env.NODE_ENV === 'production'
      ? 'Failed to close position'
      : error.message;
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/manual/track
 * Register a manually-opened position with the bot for tracking
 * Called after user signs and submits transaction
 * Body: { positionId, clientOrderId, market, side, collateralUsd, leverage, entryPrice, signature, walletAddress, password }
 */
app.post('/api/manual/track', optionalAuth, async (req, res) => {
  if (logApiAccess) logApiAccess('/api/manual/track', 'POST', { ip: req.ip });
  if (logSecurityEvent) logSecurityEvent('manual_position_track', { source: 'api', ip: req.ip });

  const {
    positionId,
    clientOrderId,
    market,
    side,
    collateralUsd,
    leverage,
    entryPrice,
    signature,
    walletAddress,
    password,
  } = req.body || {};

  // Validate required fields
  if (!positionId || !market || !side || !collateralUsd || !leverage || !entryPrice || !signature) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['positionId', 'market', 'side', 'collateralUsd', 'leverage', 'entryPrice', 'signature'],
    });
  }

  // Validate password
  const expectedPassword = process.env.UI_PASSWORD || process.env.API_KEY;
  if (expectedPassword && password !== expectedPassword) {
    if (logSecurityEvent) {
      logSecurityEvent('manual_track_auth_failed', {
        source: 'api',
        ip: req.ip,
        wallet: walletAddress,
      });
    }
    return res.status(401).json({ error: 'Invalid password' });
  }

  try {
    // Call bot via WebSocket to track position
    if (botWs && botWs.readyState === 1) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve();
          res.status(504).json({ error: 'Bot tracking timeout - position may not be tracked' });
        }, 10000); // 10 second timeout

        const responseHandler = (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.ev === 'command_response' && message.cmd === 'manual_track') {
              clearTimeout(timeout);
              botWs.removeListener('message', responseHandler);

              if (message.ok) {
                resolve();
                res.json({
                  ok: true,
                  position: message.data,
                  message: 'Position registered with bot for tracking',
                });
              } else {
                resolve();
                res.status(500).json({ error: message.error || 'Failed to track position' });
              }
            }
          } catch (e) {
            // Not our message, ignore
          }
        };

        botWs.on('message', responseHandler);
        
        // Send track command to bot
        botWs.send(JSON.stringify({
          ev: 'command',
          cmd: 'manual_track',
          params: {
            positionId,
            clientOrderId,
            market,
            side,
            collateralUsd,
            leverage,
            entryPrice,
            signature,
            walletAddress,
          },
        }));
      });
    } else if (handlers.bot && typeof handlers.bot.trackManualPosition === 'function') {
      // Fallback: direct call if bot is in same process
      const position = await handlers.bot.trackManualPosition({
        positionId,
        clientOrderId,
        market,
        side,
        collateralUsd,
        leverage,
        entryPrice,
        signature,
        walletAddress,
      });

      res.json({
        ok: true,
        position,
        message: 'Position registered with bot for tracking',
      });
    } else {
      return res.status(503).json({
        error: 'Bot service not connected',
        message: 'Cannot track position - bot may not be running or connected.',
      });
    }
  } catch (error) {
    console.error('❌ Manual position tracking failed:', error);
    const message = process.env.NODE_ENV === 'production'
      ? 'Failed to track position'
      : error.message;
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/manual/close
 * Close a manually-tracked position via bot
 * Body: { positionId, password }
 */
app.post('/api/manual/close', optionalAuth, async (req, res) => {
  if (logApiAccess) logApiAccess('/api/manual/close', 'POST', { ip: req.ip });
  if (logSecurityEvent) logSecurityEvent('manual_position_close_tracked', { source: 'api', ip: req.ip });

  const { positionId, password } = req.body || {};

  // Validate required fields
  if (!positionId) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['positionId'],
    });
  }

  // Validate password
  const expectedPassword = process.env.UI_PASSWORD || process.env.API_KEY;
  if (expectedPassword && password !== expectedPassword) {
    if (logSecurityEvent) {
      logSecurityEvent('manual_close_auth_failed', {
        source: 'api',
        ip: req.ip,
      });
    }
    return res.status(401).json({ error: 'Invalid password' });
  }

  try {
    // Call bot via WebSocket to close position
    if (botWs && botWs.readyState === 1) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve();
          res.status(504).json({ error: 'Bot response timeout - position may still be open' });
        }, 15000); // 15 second timeout

        const responseHandler = (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.ev === 'command_response' && message.cmd === 'manual_close') {
              clearTimeout(timeout);
              botWs.removeListener('message', responseHandler);

              if (message.ok) {
                resolve();
                res.json({
                  ok: true,
                  result: message.data,
                  message: 'Position closed successfully',
                });
              } else {
                resolve();
                res.status(500).json({ error: message.error || 'Failed to close position' });
              }
            }
          } catch (e) {
            // Not our message, ignore
          }
        };

        botWs.on('message', responseHandler);
        
        // Send close command to bot
        botWs.send(JSON.stringify({
          ev: 'command',
          cmd: 'manual_close',
          params: { positionId, reason: 'manual_ui_close' },
        }));
      });
    } else if (handlers.bot && typeof handlers.bot.closeManualPosition === 'function') {
      // Fallback: direct call if bot is in same process
      const result = await handlers.bot.closeManualPosition(positionId, 'manual_ui_close');

      res.json({
        ok: true,
        result,
        message: 'Position closed successfully',
      });
    } else {
      return res.status(503).json({
        error: 'Bot service not connected',
        message: 'Cannot close position - bot may not be running or connected.',
      });
    }
  } catch (error) {
    console.error('❌ Manual position close failed:', error);
    const message = process.env.NODE_ENV === 'production'
      ? 'Failed to close position'
      : error.message;
    res.status(500).json({ error: message });
  }
});

// Protected endpoints (require authentication in production)
app.post('/api/pause', optionalAuth, (req, res) => {
  try {
    if (logApiAccess) logApiAccess('/api/pause', 'POST', { ip: req.ip });
    if (logSecurityEvent) logSecurityEvent('bot_pause', { source: 'api', ip: req.ip });
    
    if (!handlers.pause || typeof handlers.pause !== 'function') {
      return res.status(503).json({ 
        error: 'Bot service not connected',
        message: 'Cannot pause bot - handlers not initialized. Bot service may not be running or connected.'
      });
    }
    
    handlers.pause();
    res.json({ ok: true });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

app.post('/api/resume', optionalAuth, (req, res) => {
  try {
    if (logApiAccess) logApiAccess('/api/resume', 'POST', { ip: req.ip });
    if (logSecurityEvent) logSecurityEvent('bot_resume', { source: 'api', ip: req.ip });
    
    if (!handlers.resume || typeof handlers.resume !== 'function') {
      return res.status(503).json({ 
        error: 'Bot service not connected',
        message: 'Cannot resume bot - handlers not initialized. Bot service may not be running or connected.'
      });
    }
    
    handlers.resume();
    res.json({ ok: true });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

app.post('/api/render/restart-bot', optionalAuth, async (req, res) => {
  try {
    if (logApiAccess) logApiAccess('/api/render/restart-bot', 'POST', { ip: req.ip });
    if (logSecurityEvent) logSecurityEvent('bot_restart_render', { source: 'api', ip: req.ip });
    
    const deployHookUrl = process.env.BOT_DEPLOY_HOOK_URL;
    
    if (!deployHookUrl) {
      return res.status(501).json({ 
        error: 'Restart not available',
        message: 'BOT_DEPLOY_HOOK_URL environment variable not configured'
      });
    }
    
    // Trigger Render deploy hook (which restarts the service)
    const axios = require('axios');
    await axios.post(deployHookUrl);
    
    res.json({ 
      ok: true,
      message: 'Bot restart triggered on Render. This may take 1-2 minutes to complete.'
    });
  } catch (e) {
    console.error('Failed to trigger bot restart:', e.message);
    const errorMsg = process.env.NODE_ENV === 'production' 
      ? 'Failed to trigger restart' 
      : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

app.post('/api/closeall', optionalAuth, async (req, res) => {
  try {
    if (logApiAccess) logApiAccess('/api/closeall', 'POST', { ip: req.ip });
    if (logSecurityEvent) logSecurityEvent('close_all_positions', { source: 'api', ip: req.ip });
    if (logTransaction) logTransaction('close_all', { source: 'api', ip: req.ip });
    
    if (!handlers.closeAll || typeof handlers.closeAll !== 'function') {
      return res.status(503).json({ 
        error: 'Bot service not connected',
        message: 'Cannot close positions - handlers not initialized. Bot service may not be running or connected.'
      });
    }
    
    await handlers.closeAll();
    res.json({ ok: true });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

/**
 * POST /api/reset-kill-switch
 * Reset the close kill switch that prevents position closing after multiple failures
 */
app.post('/api/reset-kill-switch', optionalAuth, async (req, res) => {
  try {
    if (logApiAccess) logApiAccess('/api/reset-kill-switch', 'POST', { ip: req.ip });
    if (logSecurityEvent) logSecurityEvent('reset_kill_switch', { source: 'api', ip: req.ip });
    
    // Try to access bot instance directly first
    let botInstance = null;
    if (handlers.bot && handlers.bot.tradeClient) {
      botInstance = handlers.bot;
    } else if (global.bot && global.bot.tradeClient) {
      botInstance = global.bot;
    }
    
    // If bot is available directly, reset immediately
    if (botInstance && botInstance.tradeClient) {
      const wasTripped = botInstance.tradeClient.closeKillSwitchTripped || false;
      const lastTriggerTime = botInstance.tradeClient._lastKillSwitchTime;
      const reset = botInstance.tradeClient.resetCloseKillSwitch();
      
      return res.json({ 
        ok: true, 
        wasTripped,
        reset,
        lastTriggerTime: lastTriggerTime || null,
        message: wasTripped ? 'Kill switch reset successfully' : 'Kill switch was not tripped'
      });
    }
    
    // Otherwise, use WebSocket command pattern
    if (!botWs || botWs.readyState !== 1) {
      return res.status(503).json({ 
        error: 'Bot service not connected',
        message: 'Cannot reset kill switch - bot WebSocket not connected.'
      });
    }
    
    // Send command via WebSocket
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Reset kill switch timeout - bot did not respond'));
      }, 10000);
      
      const messageHandler = (message) => {
        try {
          const data = JSON.parse(message);
          if (data.ev === 'command_response' && data.cmd === 'reset_kill_switch') {
            clearTimeout(timeout);
            botWs.removeListener('message', messageHandler);
            if (data.ok) {
              resolve(res.json({ 
                ok: true, 
                wasTripped: data.wasTripped || false,
                reset: data.reset || false,
                lastTriggerTime: data.lastTriggerTime || null,
                message: data.message || 'Kill switch reset'
              }));
            } else {
              resolve(res.status(500).json({ error: data.error || 'Failed to reset kill switch' }));
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      };
      
      botWs.on('message', messageHandler);
      botWs.send(JSON.stringify({ ev: 'command', cmd: 'reset_kill_switch' }));
    });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

app.post('/api/position/close', optionalAuth, async (req, res) => {
  try {
    const { positionId } = req.body;
    
    if (!positionId) {
      return res.status(400).json({ error: 'positionId is required' });
    }
    
    if (logApiAccess) logApiAccess('/api/position/close', 'POST', { ip: req.ip, positionId });
    if (logSecurityEvent) logSecurityEvent('close_position', { source: 'api', ip: req.ip, positionId });
    if (logTransaction) logTransaction('close_position', { source: 'api', ip: req.ip, positionId });
    
    if (!handlers.closePosition || typeof handlers.closePosition !== 'function') {
      console.error('[CLOSE_POSITION_API] Handler not available');
      return res.status(503).json({ error: 'Position closing not available - bot not connected' });
    }
    
    console.log(`[CLOSE_POSITION_API] Calling handler for position ${positionId}`);
    await handlers.closePosition(positionId);
    console.log(`[CLOSE_POSITION_API] Successfully closed position ${positionId}`);
    res.json({ ok: true, positionId });
  } catch (e) {
    console.error('[CLOSE_POSITION_API] Error:', e);
    // Always send the actual error message - it's more helpful than hiding it
    const errorMsg = e?.message || e?.error || String(e) || 'Unknown error closing position';
    res.status(500).json({ error: errorMsg });
  }
});

/**
 * GET /api/auth/key
 * Get API key for frontend authentication (same-origin only)
 * This allows the frontend to authenticate API requests without exposing the key publicly
 */
app.get('/api/auth/key', (req, res) => {
  try {
    // Only allow same-origin requests for security
    const origin = req.headers.origin || req.headers.referer;
    const host = req.headers.host;
    
    // Check if request is from same origin
    const isSameOrigin = !origin || origin.includes(host) || 
                        req.headers['sec-fetch-site'] === 'same-origin' ||
                        req.headers['sec-fetch-site'] === 'none';
    
    if (!isSameOrigin && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Forbidden: API key only available for same-origin requests' });
    }
    
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      return res.status(404).json({ error: 'API key not configured' });
    }
    
    res.json({ apiKey });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/config', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/config', 'GET', { ip: req.ip });
    }
    
    // If handlers not set, return minimal config from config.js
    if (!handlers.getConfig || typeof handlers.getConfig !== 'function') {
      const minimalConfig = {
        initialized: false,
        botRunning: false,
        // Return basic config structure
        markets: config.markets || [],
        paperTradingMode: config.paperTradingMode,
        executionMode: config.executionMode,
        botLoopMs: config.botLoopMs,
        dailyTradeLimit: config.dailyTradeLimit,
        maxOpenPositions: config.maxOpenPositions,
      };
      res.json(minimalConfig);
      return;
    }
    
    const configData = handlers.getConfig();
    // Remove sensitive fields in production
    if (process.env.NODE_ENV === 'production') {
      delete configData.wallet;
      delete configData.privateKey;
    }
    res.json(configData);
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

app.post('/api/config', optionalAuth, async (req, res) => {
  try {
    // Basic validation - ensure it's an object
    if (!req.body || typeof req.body !== 'object') {
      throw new Error('Invalid configuration: expected an object');
    }
    
    // Validate numeric fields if present
    if (req.body.risk) {
      const risk = req.body.risk;
      const numericFields = [
        'riskPerTradePercent', 'maxPositionSize', 'takeProfitPercent', 
        'stopLossPercent', 'trailingStopPercent', 'maxFundingRatePercent',
        'maxPositionHours', 'maxTotalLeverage', 'maxTotalExposure', 'maxPositions'
      ];
      for (const field of numericFields) {
        if (risk[field] !== undefined && risk[field] !== null) {
          const value = Number(risk[field]);
          if (isNaN(value) || value < 0) {
            throw new Error(`Invalid risk.${field}: must be a non-negative number, got ${risk[field]}`);
          }
        }
      }
    }
    
    // Validate leverage fields if present
    if (req.body.leverage) {
      const leverage = req.body.leverage;
      const numericFields = [
        'long', 'short', 'baseLeverage', 'minLeverage', 'maxLeverage'
      ];
      for (const field of numericFields) {
        if (leverage[field] !== undefined && leverage[field] !== null) {
          const value = Number(leverage[field]);
          if (isNaN(value) || value < 1 || value > 20) {
            throw new Error(`Invalid leverage.${field}: must be between 1 and 20, got ${leverage[field]}`);
          }
        }
      }
    }
    
    // Validate other numeric fields
    if (req.body.botLoopMs !== undefined && req.body.botLoopMs !== null) {
      const value = Number(req.body.botLoopMs);
      if (isNaN(value) || value < 1000 || value > 60000) {
        throw new Error(`Invalid botLoopMs: must be between 1000 and 60000, got ${req.body.botLoopMs}`);
      }
    }
    if (req.body.dailyTradeLimit !== undefined && req.body.dailyTradeLimit !== null) {
      const value = Number(req.body.dailyTradeLimit);
      if (isNaN(value) || value < 0 || value > 100) {
        throw new Error(`Invalid dailyTradeLimit: must be between 0 and 100, got ${req.body.dailyTradeLimit}`);
      }
    }
    if (req.body.paperBalance !== undefined && req.body.paperBalance !== null) {
      const value = Number(req.body.paperBalance);
      if (isNaN(value) || value < 0) {
        throw new Error(`Invalid paperBalance: must be a non-negative number, got ${req.body.paperBalance}`);
      }
    }
    if (req.body.maxOpenPositions !== undefined && req.body.maxOpenPositions !== null) {
      const value = Number(req.body.maxOpenPositions);
      if (isNaN(value) || value < 0 || value > 20) {
        throw new Error(`Invalid maxOpenPositions: must be between 0 and 20, got ${req.body.maxOpenPositions}`);
      }
    }
    
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/config', 'POST', { ip: req.ip });
    }
    if (typeof logSecurityEvent === 'function') {
      logSecurityEvent('config_update', { source: 'api', ip: req.ip });
    }
    
    // Log the config being sent (for debugging)
    console.log('📝 Updating config:', JSON.stringify(req.body, null, 2));
    
    // Configuration is read-only - return informative error
    res.status(400).json({ 
      error: 'Configuration is read-only. Update environment variables and restart the bot to change settings.',
      readOnly: true
    });
  } catch (e) {
    console.error('❌ Config update error:', e.message);
    console.error('Stack:', e.stack);
    // Always return detailed error in dev, generic in prod
    const errorMsg = e.message || 'Internal server error';
    res.status(400).json({ error: errorMsg });
  }
});

// PM2 API endpoints
async function getPM2Processes() {
  try {
    const { execSync } = require('child_process');
    const output = execSync('pm2 jlist', { encoding: 'utf-8', stdio: 'pipe' });
    return JSON.parse(output);
  } catch (e) {
    return [];
  }
}

async function getPM2ProcessInfo(name) {
  try {
    const { execSync } = require('child_process');
    const output = execSync(`pm2 describe ${name}`, { encoding: 'utf-8', stdio: 'pipe' });
    const processes = await getPM2Processes();
    return processes.find(p => p.name === name) || null;
  } catch (e) {
    return null;
  }
}

// Get PM2 status
app.get('/api/pm2/status', optionalAuth, async (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/pm2/status', 'GET', { ip: req.ip });
    }
    const processes = await getPM2Processes();
    const bot = processes.find(p => p.name === 'jupiter-perps-bot');
    
    if (!bot) {
      return res.json({ 
        status: 'offline',
        process: null,
        available: false
      });
    }
    
    const pm2_env = bot.pm2_env || {};
    const monit = bot.monit || {};
    
    // Calculate uptime
    const uptime = pm2_env.pm_uptime ? Date.now() - pm2_env.pm_uptime : 0;
    const uptimeStr = uptime > 0 ? formatUptime(uptime) : 'N/A';
    
    // Calculate stability
    const restarts = pm2_env.restart_time || 0;
    const uptimeMinutes = uptime / 60000;
    let stability = 'unknown';
    if (restarts === 0) {
      stability = 'perfect';
    } else if (uptimeMinutes >= 60) {
      stability = 'stable';
    } else if (uptimeMinutes >= 30) {
      stability = 'stable';
    } else if (uptimeMinutes >= 10) {
      stability = 'stable';
    } else if (uptimeMinutes >= 5) {
      stability = 'recovering';
    } else {
      if (restarts > 20 && uptimeMinutes < 2) {
        stability = 'critical';
      } else if (restarts > 10 && uptimeMinutes < 3) {
        stability = 'critical';
      } else if (restarts > 5) {
        stability = 'unstable';
      } else {
        stability = 'starting';
      }
    }
    
    res.json({
      status: pm2_env.status || 'unknown',
      process: {
        name: bot.name,
        pid: bot.pid,
        pmId: bot.pm_id,
        uptime: uptime,
        uptimeStr: uptimeStr,
        restarts: restarts,
        stability: stability,
        memory: {
          usage: monit.memory || 0,
          usageMB: (monit.memory || 0) / 1024 / 1024,
        },
        cpu: {
          usage: monit.cpu || 0,
        },
        mode: pm2_env.exec_mode || 'fork',
        instances: pm2_env.instances || 1,
        nodeVersion: pm2_env.node_version || 'unknown',
        createdAt: pm2_env.created_at || null,
        pmUptime: pm2_env.pm_uptime || null,
      },
      available: true
    });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg, available: false });
  }
});

function formatUptime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

// PM2 control actions
app.post('/api/pm2/control', optionalAuth, async (req, res) => {
  try {
    const { action, name } = req.body;
    
    if (!action || !['start', 'stop', 'restart', 'reload', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be: start, stop, restart, reload, or delete' });
    }
    
    const processName = name || 'jupiter-perps-bot';
    
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/pm2/control', 'POST', { ip: req.ip, action, processName });
    }
    if (typeof logSecurityEvent === 'function') {
      logSecurityEvent('pm2_control', { source: 'api', ip: req.ip, action, processName });
    }
    
    const { execSync } = require('child_process');
    let command;
    
    switch (action) {
      case 'start':
        // Use ecosystem config if available, otherwise use process name
        command = `pm2 start ecosystem.config.js --only ${processName} || pm2 start ${processName}`;
        break;
      case 'stop':
        command = `pm2 stop ${processName}`;
        break;
      case 'restart':
        command = `pm2 restart ${processName}`;
        break;
      case 'reload':
        command = `pm2 reload ${processName}`;
        break;
      case 'delete':
        command = `pm2 delete ${processName}`;
        break;
    }
    
    try {
      execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
      res.json({ ok: true, message: `${action} command executed successfully` });
    } catch (e) {
      res.status(500).json({ error: `Failed to ${action} process: ${e.message}` });
    }
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Get PM2 logs
app.get('/api/pm2/logs', optionalAuth, async (req, res) => {
  try {
    const { lines = 100, name = 'jupiter-perps-bot' } = req.query;
    
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/pm2/logs', 'GET', { ip: req.ip });
    }
    
    const { execSync } = require('child_process');
    try {
      const output = execSync(`pm2 logs ${name} --lines ${lines} --nostream --format`, { 
        encoding: 'utf-8', 
        stdio: 'pipe',
        maxBuffer: 1024 * 1024 // 1MB buffer
      });
      res.json({ logs: output.split('\n').filter(line => line.trim()) });
    } catch (e) {
      // PM2 logs command might fail if process doesn't exist
      res.json({ logs: [], error: e.message });
    }
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// ============================================================================
// Historical Performance API Endpoints
// ============================================================================

const db = require('../../db');

// Get closed trades with filters
app.get('/api/performance/trades', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/performance/trades', 'GET', { ip: req.ip });
    }
    
    const {
      limit = 1000,
      offset = 0,
      sinceMs = null,
      untilMs = null,
      market = null,
      side = null,
      mode = null,
      orderBy = 'ts',
      orderDir = 'DESC',
    } = req.query;
    
    const options = {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      sinceMs: sinceMs ? parseInt(sinceMs, 10) : null,
      market: market || null,
      side: side || null,
      mode: mode || null,
      orderBy: orderBy || 'ts',
      orderDir: orderDir || 'DESC',
    };
    
    let trades = db.getClosedTrades(options);
    
    // Filter by untilMs if provided
    if (untilMs) {
      const until = parseInt(untilMs, 10);
      trades = trades.filter(t => t.close_ts <= until);
    }
    
    res.json({ trades, count: trades.length });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Get performance by time period
app.get('/api/performance/period', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/performance/period', 'GET', { ip: req.ip });
    }
    
    const {
      sinceMs = Date.now() - 86400000 * 30, // Default: last 30 days
      groupBy = 'day',
      market = null,
      mode = null,
    } = req.query;
    
    const options = {
      sinceMs: parseInt(sinceMs, 10),
      groupBy: groupBy || 'day',
      market: market || null,
      mode: mode || null,
    };
    
    const data = db.getPerformanceByPeriod(options);
    res.json({ data, period: groupBy });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Get performance by market
app.get('/api/performance/markets', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/performance/markets', 'GET', { ip: req.ip });
    }
    
    const { sinceMs = null, mode = null } = req.query;
    
    const options = {
      sinceMs: sinceMs ? parseInt(sinceMs, 10) : null,
      mode: mode || null,
    };
    
    const data = db.getPerformanceByMarket(options);
    res.json({ data });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Get cumulative PnL (equity curve)
app.get('/api/performance/cumulative', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/performance/cumulative', 'GET', { ip: req.ip });
    }
    
    const {
      sinceMs = null,
      market = null,
      mode = null,
    } = req.query;
    
    const options = {
      sinceMs: sinceMs ? parseInt(sinceMs, 10) : null,
      market: market || null,
      mode: mode || null,
    };
    
    const data = db.getCumulativePnL(options);
    res.json({ data });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Get gate analytics statistics
app.get('/api/analytics/gates', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/analytics/gates', 'GET', { ip: req.ip });
    }
    
    const { market = null, side = null, timeWindow = '24h' } = req.query;
    
    // Parse time window (e.g., '1h', '24h', '7d')
    let timeWindowMs = 24 * 60 * 60 * 1000; // Default 24 hours
    if (timeWindow === '1h') timeWindowMs = 60 * 60 * 1000;
    else if (timeWindow === '6h') timeWindowMs = 6 * 60 * 60 * 1000;
    else if (timeWindow === '24h') timeWindowMs = 24 * 60 * 60 * 1000;
    else if (timeWindow === '7d') timeWindowMs = 7 * 24 * 60 * 60 * 1000;
    else if (timeWindow === '30d') timeWindowMs = 30 * 24 * 60 * 60 * 1000;
    
    // Try to use cached gate analytics from bot first (for Render deployment)
    if (cachedGateAnalytics && cachedGateAnalytics.stats && cachedGateAnalytics.summary) {
      // Filter stats by market and side if requested
      let stats = cachedGateAnalytics.stats;
      let summary = cachedGateAnalytics.summary;
      
      // If different time window requested, try to get from local instance as fallback
      // Otherwise use cached data (which is for 24h default)
      if (timeWindowMs === cachedGateAnalytics.timeWindowMs || timeWindow === '24h') {
        // Filter by market if requested
        if (market) {
          const filteredStats = {};
          if (stats[market]) {
            filteredStats[market] = stats[market];
            // Filter by side if requested
            if (side && filteredStats[market][side]) {
              const originalSides = filteredStats[market];
              filteredStats[market] = { [side]: originalSides[side] };
            }
          }
          stats = filteredStats;
        } else if (side) {
          // Filter by side only (across all markets)
          const filteredStats = {};
          for (const [mkt, sides] of Object.entries(stats)) {
            if (sides[side]) {
              filteredStats[mkt] = { [side]: sides[side] };
            }
          }
          stats = filteredStats;
        }
        
        return res.json({
          stats,
          summary,
          timeWindow,
          timeWindowMs: cachedGateAnalytics.timeWindowMs,
          cached: true,
        });
      }
    }
    
    // Fallback: Try to get from local gate analytics instance (for local development)
    // This won't work on Render if bot and UI server are separate services
    try {
      const { getGateAnalytics } = require('../../utils/gate-analytics');
      const gateAnalytics = getGateAnalytics();
      
      const stats = gateAnalytics.getStats(market, side, timeWindowMs);
      const summary = gateAnalytics.getSummary(timeWindowMs);
      
      return res.json({
        stats,
        summary,
        timeWindow,
        timeWindowMs,
        cached: false,
      });
    } catch (e) {
      // If local instance fails and no cached data, return empty/error
      if (!cachedGateAnalytics) {
        console.warn('Gate analytics not available - bot may not be connected or gate analytics not initialized');
        return res.json({
          stats: {},
          summary: {
            topGates: [],
            totalBlocks: 0,
            totalEvaluations: 0,
            overallPassRate: '0.0',
            markets: 0,
          },
          timeWindow,
          timeWindowMs,
          cached: false,
          error: 'Gate analytics not available - bot service may not be connected',
        });
      }
      
      // If we have cached data but different time window requested, return cached with warning
      return res.json({
        stats: cachedGateAnalytics.stats || {},
        summary: cachedGateAnalytics.summary || {
          topGates: [],
          totalBlocks: 0,
          totalEvaluations: 0,
          overallPassRate: '0.0',
          markets: 0,
        },
        timeWindow: '24h', // Return cached window
        timeWindowMs: cachedGateAnalytics.timeWindowMs || 24 * 60 * 60 * 1000,
        cached: true,
        warning: `Requested time window ${timeWindow} not available, returning cached 24h data`,
      });
    }
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Get win rate statistics
app.get('/api/performance/winrate', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/performance/winrate', 'GET', { ip: req.ip });
    }
    
    const {
      sinceMs = null,
      market = null,
      side = null,
      mode = null,
    } = req.query;
    
    const options = {
      sinceMs: sinceMs ? parseInt(sinceMs, 10) : null,
      market: market || null,
      side: side || null,
      mode: mode || null,
    };
    
    const data = db.getWinRateStats(options);
    res.json({ data });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Get summary statistics
app.get('/api/performance/summary', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/performance/summary', 'GET', { ip: req.ip });
    }
    
    const {
      sinceMs = null,
      market = null,
      mode = null,
    } = req.query;
    
    const options = {
      sinceMs: sinceMs ? parseInt(sinceMs, 10) : null,
      market: market || null,
      mode: mode || null,
    };
    
    const winRateStats = db.getWinRateStats(options);
    const marketStats = db.getPerformanceByMarket(options);
    const cumulativeData = db.getCumulativePnL(options);
    
    // Calculate additional metrics
    const totalPnL = winRateStats.total_pnl || 0;
    const avgPnL = winRateStats.avg_pnl || 0;
    const totalTrades = winRateStats.total_trades || 0;
    
    // Get best and worst trades
    const trades = db.getClosedTrades({
      sinceMs: options.sinceMs,
      market: options.market,
      limit: 10000,
      orderBy: 'pnl',
      orderDir: 'DESC',
    });
    
    const bestTrade = trades.length > 0 ? trades[0] : null;
    const worstTrade = trades.length > 0 ? trades[trades.length - 1] : null;
    
    // Calculate current equity (starting from 0, add cumulative PnL)
    const currentEquity = cumulativeData.length > 0 
      ? cumulativeData[cumulativeData.length - 1].cumulative_pnl 
      : 0;
    
    res.json({
      summary: {
        total_trades: totalTrades,
        win_rate: winRateStats.win_rate,
        total_pnl: totalPnL,
        avg_pnl: avgPnL,
        current_equity: currentEquity,
        best_trade: bestTrade,
        worst_trade: worstTrade,
      },
      markets: marketStats,
      win_rate_stats: winRateStats,
    });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Trade history endpoint
app.get('/api/analytics/trades', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/analytics/trades', 'GET', { ip: req.ip });
    }
    
    const {
      market = null,
      timeWindow = '7d',
      limit = 100,
      offset = 0,
      mode = null,
    } = req.query;
    
    // Parse time window - if "all", don't filter by time
    let sinceMs = null;
    if (timeWindow !== 'all') {
      const timeWindowMs = (() => {
        const match = timeWindow.match(/^(\d+)([hdwmy])$/);
        if (!match) return 7 * 24 * 60 * 60 * 1000; // Default 7 days
        const [, num, unit] = match;
        const multipliers = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
        return parseInt(num) * multipliers[unit];
      })();
      
      sinceMs = Date.now() - timeWindowMs;
    }
    
    const trades = db.getClosedTrades({
      sinceMs,
      market: market || null,
      mode: mode || null,
      limit: parseInt(limit),
      offset: parseInt(offset),
      orderBy: 'ts',
      orderDir: 'DESC',
    });
    
    // Get summary stats
    const winRateStats = db.getWinRateStats({
      sinceMs,
      market: market || null,
      mode: mode || null,
    });
    
    res.json({
      trades,
      total: trades.length,
      summary: {
        total: winRateStats.total_trades || 0,
        wins: winRateStats.wins || 0,
        losses: winRateStats.losses || 0,
        avgPnL: winRateStats.avg_pnl || 0,
        winRate: winRateStats.win_rate || 0,
      },
    });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Performance analytics endpoint
app.get('/api/analytics/performance', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/analytics/performance', 'GET', { ip: req.ip });
    }
    
    const {
      market = null,
      timeWindow = '7d',
      mode = null,
    } = req.query;
    
    // Parse time window
    const timeWindowMs = (() => {
      const match = timeWindow.match(/^(\d+)([hdwmy])$/);
      if (!match) return 7 * 24 * 60 * 60 * 1000;
      const [, num, unit] = match;
      const multipliers = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
      return parseInt(num) * multipliers[unit];
    })();
    
    const sinceMs = Date.now() - timeWindowMs;
    
    const options = {
      sinceMs,
      market: market || null,
      mode: mode || null,
    };
    
    const winRateStats = db.getWinRateStats(options);
    const marketStats = db.getPerformanceByMarket(options);
    const cumulativeData = db.getCumulativePnL(options);
    
    // Get best and worst trades
    const trades = db.getClosedTrades({
      sinceMs: options.sinceMs,
      market: options.market,
      mode: options.mode,
      limit: 10000,
      orderBy: 'pnl',
      orderDir: 'DESC',
    });
    
    const bestTrade = trades.length > 0 ? trades[0] : null;
    const worstTrade = trades.length > 0 ? trades[trades.length - 1] : null;
    
    // Calculate profit factor
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const totalWins = wins.reduce((sum, t) => sum + t.pnl, 0);
    const totalLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;
    
    // Get daily PnL for chart
    const dailyPnL = cumulativeData.map(d => ({
      date: d.date,
      pnl: d.daily_pnl,
      cumulativePnL: d.cumulative_pnl,
    }));
    
    res.json({
      winRate: winRateStats.win_rate || 0,
      avgPnL: winRateStats.avg_pnl || 0,
      totalTrades: winRateStats.total_trades || 0,
      totalPnL: winRateStats.total_pnl || 0,
      bestTrade,
      worstTrade,
      profitFactor,
      dailyPnL,
      marketStats,
    });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Runtime stats endpoint
app.get('/api/runtime/stats', optionalAuth, (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/runtime/stats', 'GET', { ip: req.ip });
    }
    
    // Get runtime stats from bot status
    const status = handlers.status ? handlers.status() : {};
    
    res.json({
      uptime: status.uptime || 0,
      loopCount: status.loopCount || 0,
      avgLoopDuration: status.avgLoopDuration || 0,
      lastError: status.lastError || null,
      circuitBreaker: status.circuitBreaker || { active: false },
      rateLimit: status.rateLimit || { remaining: 0, resetAt: null },
      memory: status.memory || 0,
    });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Historical price data endpoint for charts
app.get('/api/chart/history', optionalAuth, async (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/chart/history', 'GET', { ip: req.ip, query: req.query });
    }
    
    const { market, resolution = '5', bars = '100' } = req.query;
    
    if (!market) {
      return res.status(400).json({ error: 'Market parameter required (e.g., SOL-PERP)' });
    }
    
    // Extract base symbol from market (SOL-PERP -> SOL)
    const symbol = market.split('-')[0];
    
    // Import Pyth historical fetcher
    const { PythHistoricalFetcher } = require('../../utils/pyth-historical');
    const fetcher = new PythHistoricalFetcher();
    
    const barsNeeded = parseInt(bars, 10) || 100;
    const candles = await fetcher.fetchHistoricalData(symbol, barsNeeded, resolution);
    
    // Convert to TradingView Lightweight Charts format
    const chartData = candles.map(c => ({
      time: Math.floor(c.ts / 1000), // Lightweight Charts expects seconds
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    
    res.json({
      market,
      resolution,
      bars: chartData.length,
      data: chartData,
    });
  } catch (e) {
    console.error('Failed to fetch historical data:', e);
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// Solana network health endpoint
app.get('/api/solana/health', optionalAuth, async (req, res) => {
  try {
    if (typeof logApiAccess === 'function') {
      logApiAccess('/api/solana/health', 'GET', { ip: req.ip });
    }
    
    const { Connection } = require('@solana/web3.js');
    const rpcUrl = config.rpcUrl || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    
    const connection = new Connection(rpcUrl, 'confirmed');
    
    // Measure RPC latency
    const start = Date.now();
    const slot = await connection.getSlot();
    const latency = Date.now() - start;
    
    // Get epoch info
    const epochInfo = await connection.getEpochInfo();
    
    // Get recent performance samples
    const perfSamples = await connection.getRecentPerformanceSamples(1);
    const tps = perfSamples.length > 0 ? perfSamples[0].numTransactions / perfSamples[0].samplePeriodSecs : 0;
    
    // Get recent blockhash age
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const currentBlockHeight = await connection.getBlockHeight();
    const blockhashAge = currentBlockHeight - lastValidBlockHeight;
    
    // Determine health status
    const health = latency < 500 ? 'online' : latency < 2000 ? 'degraded' : 'offline';
    
    // TODO: Add Jupiter funding rates (requires Jupiter API integration)
    const fundingRates = {
      'SOL-PERP': { rate: 0.01, nextFunding: Date.now() + 2 * 60 * 60 * 1000 },
      'BTC-PERP': { rate: -0.005, nextFunding: Date.now() + 2 * 60 * 60 * 1000 },
      'ETH-PERP': { rate: 0.008, nextFunding: Date.now() + 2 * 60 * 60 * 1000 },
    };
    
    res.json({
      rpc: {
        latency,
        slot,
        epoch: epochInfo.epoch,
        health,
      },
      network: {
        tps: Math.round(tps),
        congestion: blockhashAge > 150 ? 'high' : blockhashAge > 50 ? 'medium' : 'low',
        blockhashAge,
      },
      jupiter: {
        fundingRates,
        liquidity: {}, // TODO: Add liquidity data
      },
    });
  } catch (e) {
    const errorMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;
    res.status(500).json({ error: errorMsg });
  }
});

// WebSocket server with authentication
const wss = new WebSocket.Server({ 
  server,
  clientTracking: true,
  maxPayload: MESSAGE_SIZE_LIMIT,
});

const clients = new Map(); // ws -> { authenticated: boolean, ip: string, isBot: boolean }
let botWs = null; // WebSocket connection from bot service

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const localHosts = ['localhost', '127.0.0.1'];
  const localIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const isLocalHost = localHosts.some((h) => hostHeader === h || hostHeader.startsWith(`${h}:`));
  const isLocalIp = localIps.some((local) => (ip && ip.includes(local)) || (forwarded && forwarded.includes(local)));
  let authenticated = false;

  // Check for bot client identifier
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isBot = url.searchParams.get('client') === 'bot';

  // Check connection limit (only for non-bot clients)
  if (!isBot && wss.clients.size > MAX_CONNECTIONS) {
    logSecurityEvent('ws_connection_rejected', { reason: 'max_connections', ip });
    ws.close(1008, 'Maximum connections exceeded');
    return;
  }

  clients.set(ws, { authenticated: false, ip, connectedAt: Date.now(), isBot });

  // Check for authentication token in query string
  const apiKey = url.searchParams.get('apiKey') || url.searchParams.get('token');

  const authDisabled = process.env.REQUIRE_API_AUTH === 'false';
  const isLocalRequest = isLocalHost || isLocalIp;
  const expectedKey = process.env.API_KEY && process.env.API_KEY.trim();

  const headerApiKey = Array.isArray(req.headers['x-api-key'])
    ? req.headers['x-api-key'][0]
    : req.headers['x-api-key'];
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const cookieHeader = Array.isArray(req.headers.cookie)
    ? req.headers.cookie.join(';')
    : req.headers.cookie;

  const cookieApiKey = (() => {
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const cookie of cookies) {
      if (!cookie) continue;
      const [name, value] = cookie.split('=');
      if (name === 'apiKey' && value) {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    }
    return null;
  })();

  let providedKey = url.searchParams.get('apiKey') || url.searchParams.get('token') || headerApiKey || cookieApiKey;

  if (!providedKey && typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      providedKey = trimmed.slice(7).trim();
    }
  }

  const requireAuth = !authDisabled && !isLocalRequest;

  if (!requireAuth) {
    authenticated = true;
    clients.set(ws, { authenticated: true, ip, connectedAt: Date.now(), isBot });
  } else {
    if (!expectedKey) {
      console.error('❌ API_KEY is not configured but WebSocket authentication is required.');
      ws.close(1011, 'Server authentication misconfigured. API_KEY must be set.');
      return;
    }

    if (providedKey && providedKey === expectedKey) {
      authenticated = true;
      clients.set(ws, { authenticated: true, ip, connectedAt: Date.now(), isBot });
      if (typeof logSecurityEvent === 'function') {
        logSecurityEvent('ws_connection_authenticated', { ip });
      }
    } else {
      if (typeof logSecurityEvent === 'function') {
        logSecurityEvent('ws_connection_unauthenticated', { ip });
      }
      ws.close(1008, 'Authentication required. Provide API key via query parameter, X-API-Key header, or Bearer token.');
      return;
    }
  }

  // Track bot connection (requires authentication unless explicitly disabled/local)
  if (authenticated && isBot) {
    botWs = ws;
    console.log('✅ Bot service connected via WebSocket');
    
    // Set handlers to use WebSocket
    handlers.status = () => {
      // Return cached status or request from bot
      return {};
    };
    handlers.pause = () => {
      if (botWs && botWs.readyState === 1) {
        botWs.send(JSON.stringify({ ev: 'command', cmd: 'pause' }));
      }
    };
    handlers.resume = () => {
      if (botWs && botWs.readyState === 1) {
        botWs.send(JSON.stringify({ ev: 'command', cmd: 'resume' }));
      }
    };
    handlers.closeAll = async () => {
      return new Promise((resolve, reject) => {
        if (!botWs || botWs.readyState !== 1) {
          reject(new Error('Bot not connected'));
          return;
        }
        
        // Set up one-time listener for response
        const timeout = setTimeout(() => {
          reject(new Error('Close all positions timeout - bot did not respond'));
        }, 15000); // 15 second timeout (longer for multiple positions)
        
        const responseHandler = (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.ev === 'command_response' && message.cmd === 'closeall') {
              clearTimeout(timeout);
              botWs.removeListener('message', responseHandler);
              
              if (message.ok) {
                resolve();
              } else {
                reject(new Error(message.error || 'Failed to close all positions'));
              }
            }
          } catch (e) {
            // Not our message, ignore
          }
        };
        
        botWs.on('message', responseHandler);
        botWs.send(JSON.stringify({ ev: 'command', cmd: 'closeall' }));
      });
    };
    handlers.closePosition = async (positionId) => {
      return new Promise((resolve, reject) => {
        console.log(`[HANDLER] closePosition called for ${positionId}`);
        
        if (!botWs || botWs.readyState !== 1) {
          console.error('[HANDLER] Bot WebSocket not connected, readyState:', botWs?.readyState);
          reject(new Error('Bot not connected via WebSocket'));
          return;
        }
        
        console.log('[HANDLER] Bot WebSocket connected, setting up response listener');
        
        // Set up one-time listener for response
        const timeout = setTimeout(() => {
          console.error(`[HANDLER] Timeout waiting for bot response for position ${positionId}`);
          botWs.removeListener('message', responseHandler);
          reject(new Error('Close position timeout - bot did not respond within 10 seconds'));
        }, 10000); // 10 second timeout
        
        const responseHandler = (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.ev === 'command_response' && message.cmd === 'closeposition') {
              console.log(`[HANDLER] Received response for closeposition:`, message);
              clearTimeout(timeout);
              botWs.removeListener('message', responseHandler);
              
              if (message.ok) {
                console.log(`[HANDLER] Position ${positionId} closed successfully`);
                resolve();
              } else {
                console.error(`[HANDLER] Bot returned error:`, message.error);
                reject(new Error(message.error || 'Bot failed to close position'));
              }
            }
          } catch (e) {
            // Not our message, ignore
            console.debug('[HANDLER] Ignoring non-JSON or irrelevant message');
          }
        };
        
        botWs.on('message', responseHandler);
        console.log(`[HANDLER] Sending closeposition command to bot for ${positionId}`);
        try {
          botWs.send(JSON.stringify({ ev: 'command', cmd: 'closeposition', params: { positionId } }));
          console.log('[HANDLER] Command sent successfully');
        } catch (sendError) {
          console.error('[HANDLER] Error sending command:', sendError);
          clearTimeout(timeout);
          botWs.removeListener('message', responseHandler);
          reject(new Error(`Failed to send command to bot: ${sendError.message}`));
        }
      });
    };
    handlers.getConfig = () => {
      // Request config from bot
      if (botWs && botWs.readyState === 1) {
        botWs.send(JSON.stringify({ ev: 'command', cmd: 'get_config' }));
      }
      return {};
    };
  }

  ws.on('message', (data) => {
    const clientInfo = clients.get(ws);
    if (!clientInfo || !clientInfo.authenticated) {
      if (typeof logSecurityEvent === 'function') {
        logSecurityEvent('ws_message_unauthenticated', { ip });
      }
      ws.close(1008, 'Authentication required');
      return;
    }

    // Handle messages from bot service
    if (clientInfo.isBot) {
      try {
        const message = JSON.parse(data.toString());
        
        // Handle bot status updates
        if (message.ev === 'bot_status' && message.data) {
          // Cache gate analytics if present in status
          if (message.data.gateAnalytics) {
            cachedGateAnalytics = message.data.gateAnalytics;
            cachedGateAnalyticsTimestamp = Date.now();
          }
          
          // Broadcast status to all UI clients
          broadcast('status', message.data);
          
          // Update handlers to return cached status
          handlers.status = () => message.data;
        }
        
        // Handle bot config updates
        if (message.ev === 'bot_config' && message.data) {
          handlers.getConfig = () => message.data;
        }
        
        // Handle trade openings - save to UI server's database
        if (message.ev === 'trade_opened' && message.data) {
          try {
            const trade = message.data;
            console.log(`📥 Received trade open from bot: ${trade.id?.slice(0, 8)}... ${trade.market} ${trade.side} @ $${trade.entry?.toFixed(4)}`);
            
            // Save to UI server's database so historical queries work
            db.logOpen({
              positionId: trade.id,
              clientOrderId: trade.client_order_id,
              market: trade.market,
              side: trade.side,
              entryPrice: trade.entry,
              collateral: trade.collateral,
              leverage: trade.leverage,
              size: trade.size,
              openTime: trade.open_ts,
              mode: trade.mode,
              environment: trade.environment,
              instance_id: trade.instance_id
            });
            
            // Broadcast trade open to all UI clients
            broadcast('trade_opened', trade);
          } catch (e) {
            console.error('❌ [UI-SERVER] CRITICAL: Failed to save trade open to UI database!');
            console.error('   Error:', e.message);
            console.error('   Stack:', e.stack);
            console.error('   Trade data:', trade);
          }
        }
        
        // Handle trade closures - save to UI server's database
        if (message.ev === 'trade_closed' && message.data) {
          try {
            const trade = message.data;
            console.log(`📥 Received trade closure from bot: ${trade.id?.slice(0, 8)}... PnL: $${trade.pnl_usd?.toFixed(2)} (${trade.pnl?.toFixed(2)}%)`);
            
            // Save to UI server's database so historical queries work
            db.logClose(
              {
                positionId: trade.id,
                clientOrderId: trade.client_order_id,
                market: trade.market,
                side: trade.side,
                entryPrice: trade.entry,
                collateral: trade.collateral,
                leverage: trade.leverage,
                size: trade.size,
                openTime: trade.open_ts,
                mode: trade.mode,
                pnlUSD: trade.pnl_usd, // USD for display/reference
              },
              trade.exit,
              trade.pnl, // Percentage format for database consistency
              trade.reason
            );
            
            // Broadcast trade closure to all UI clients (with both USD and %)
            broadcast('trade_closed', trade);
          } catch (e) {
            console.error('Error saving trade closure to UI database:', e.message);
            console.error('Trade data:', trade);
          }
        }
        
        // Handle log batches from bot
        if (message.ev === 'logs_batch' && Array.isArray(message.data)) {
          // Forward each log to UI clients individually
          message.data.forEach(log => {
            broadcast('log', log);
          });
        }
        
        // Handle command responses (for future use)
        if (message.ev === 'command_response') {
          // Could broadcast to UI clients if needed
        }
      } catch (e) {
        console.error('Error processing bot WebSocket message:', e.message);
      }
      return;
    }

    // Validate message structure only if validator exists (for UI clients)
    if (typeof validateWebSocketMessage === 'function') {
      try {
        const validation = validateWebSocketMessage(data);
        if (!validation.valid) {
          if (typeof logSecurityEvent === 'function') {
            logSecurityEvent('ws_invalid_message', { ip, error: validation.error });
          }
          // Don't close connection, just log warning
          console.warn('Invalid WebSocket message:', validation.error);
          return;
        }
      } catch (e) {
        console.warn('WebSocket message validation error:', e.message);
      }
    }

    // Message is valid, process if needed (currently server doesn't process incoming messages from UI clients)
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (clientInfo && clientInfo.isBot) {
      botWs = null;
      console.log('⚠️  Bot service disconnected from WebSocket');
      
      // Reset handlers to empty
      handlers.status = () => ({});
      handlers.pause = () => {};
      handlers.resume = () => {};
      handlers.closeAll = () => {};
      handlers.closePosition = () => {};
      handlers.getConfig = () => ({});
    }
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    logSecurityEvent('ws_error', { ip, error: error.message });
    clients.delete(ws);
  });

  // Send initial status only if authenticated
  if (authenticated) {
    try {
      if (handlers.status && typeof handlers.status === 'function') {
        ws.send(JSON.stringify({ ev: 'status', data: handlers.status() }));
      } else {
        // Send minimal status if handlers not set (bot service not connected)
        ws.send(JSON.stringify({ 
          ev: 'status', 
          data: {
            initialized: false,
            botRunning: false,
            botStatus: 'offline',
            mode: 'unknown',
            execMode: 'unknown',
            paused: false,
            markets: [],
            marketPrices: {},
            marketPerformance: {},
            openPositions: [],
            portfolio: {},
            totalEquity: 0,
            freeCapital: 0,
            lockedCapital: 0,
            positions: 0,
            posCap: 0,
            dailyTrades: 0,
            dailyCap: 0,
          }
        }));
      }
    } catch (e) {
      console.error('Failed to send initial status:', e.message);
    }
  }
});

function broadcast(ev, data) {
  // Skip validation for activity/log messages (they have different structure)
  if (ev === 'activity' || ev === 'log') {
    // Activity messages have different structure - send directly
    const msg = JSON.stringify({ ev, data, ts: Date.now() });
    let sent = 0;
    for (const [ws, clientInfo] of clients.entries()) {
      if (clientInfo.authenticated && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
          sent++;
        } catch (e) {
          console.error('Failed to send activity message:', e.message);
        }
      }
    }
    return;
  }
  
  const msg = JSON.stringify({ ev, data, ts: Date.now() });
  
  // Validate message before sending (skip for server broadcasts)
  if (typeof validateWebSocketMessage === 'function') {
    const validation = validateWebSocketMessage(msg);
    if (!validation.valid) {
      // Don't log security events for validation errors in broadcasts
      console.warn('Broadcast message validation failed:', validation.error);
      // Continue anyway - don't block broadcasts
    }
  }

  let sent = 0;
  for (const [ws, clientInfo] of clients.entries()) {
    // Only send to authenticated clients
    if (clientInfo.authenticated && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(msg);
        sent++;
      } catch (e) {
        console.error('Failed to send message to client:', e.message);
      }
    }
  }
  
  if (sent > 0 && typeof logApiAccess === 'function') {
    logApiAccess('ws_broadcast', 'SEND', { event: ev, recipients: sent });
  }
}

function setHandlers(h) { handlers = { ...handlers, ...h }; }

// Static file serving - MUST come AFTER all API routes
// Serve static files without authentication for localhost/development
app.use((req, res, next) => {
  // Cache policy: index.html and HTML files no-cache; assets long cache
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Serve old UI at /legacy route
app.use('/legacy', express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const longCache = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2'];
    if (longCache.includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Serve new React UI at root (check if build exists)
const newUIPath = path.join(__dirname, 'ui/out');
const fs = require('fs');
if (fs.existsSync(newUIPath)) {
  console.log('✅ Serving new React UI from ui/out');
  app.use(express.static(newUIPath, {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const longCache = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2'];
      if (longCache.includes(ext)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
  
  // Fallback to index.html for SPA routing (must be after API routes)
  // Note: This must be placed AFTER all API routes are defined
  app.use((req, res, next) => {
    // Don't intercept API routes or legacy routes
    if (req.path.startsWith('/api') || req.path.startsWith('/legacy')) {
      return next();
    }
    // Serve index.html for all other routes (SPA routing)
    res.sendFile(path.join(newUIPath, 'index.html'));
  });
} else {
  console.log('⚠️  New UI not built yet, serving old UI from public/');
  console.log('   Run: cd ui && npm run build');
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const longCache = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2'];
    if (longCache.includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));
}

// Server startup - rely on start.sh to clear port, just wait and retry
let serverStarted = false;
let retryCount = 0;
const maxRetries = 15;

// Check if port is available using native Node.js
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const testServer = require('http').createServer();
    testServer.listen(port, () => {
      testServer.once('close', () => resolve(true));
      testServer.close();
    });
    testServer.on('error', () => resolve(false));
  });
}

async function startServer() {
  if (serverStarted) return;
  
  // Initialize API_KEY from encrypted storage before starting server
  try {
    await initializeApiKey();
  } catch (error) {
    // Log error but don't fail server startup - auth will be disabled or use UI_PASSWORD
    console.warn('⚠️  [SECURE] Failed to initialize API_KEY from encrypted storage:', error.message);
    console.warn('   Server will continue, but authentication may be limited');
  }
  
  // Bind to 0.0.0.0 for Render and other cloud platforms
  // This allows external connections, not just localhost
  const host = process.env.HOST || '0.0.0.0';
  
  // In production (Render), skip port availability check and try to bind directly
  // Render manages ports for us, so we don't need to check availability
  if (process.env.NODE_ENV === 'production') {
    // Set error handler before listening
    server.once('error', (err) => {
      console.error('❌ Failed to start UI server:', err.message);
      // In production, exit on error so Render knows deployment failed
      process.exit(1);
    });
    
    // Start server immediately in production
    server.listen(PORT, host, () => {
      console.log(`🌐 UI server listening on http://${host}:${PORT}`);
      serverStarted = true;
    });
    return;
  }
  
  // Development: Check if port is available before trying to bind
  const available = await isPortAvailable(PORT);
  
  if (!available) {
    retryCount++;
    if (retryCount < maxRetries) {
      const delay = 1000; // Fixed 1 second delay
      console.log(`⏳ Port ${PORT} still in use, waiting ${delay/1000}s... (${retryCount}/${maxRetries})`);
      setTimeout(startServer, delay);
      return;
    } else {
      console.error(`❌ Port ${PORT} is still in use after ${maxRetries} attempts.`);
      console.error(`   The start script should have cleared it. Please check:`);
      console.error(`   - Is another bot instance running?`);
      console.error(`   - Run: lsof -ti:${PORT} | xargs kill -9`);
      console.error(`   - Or change UI_PORT in .env to use a different port`);
      console.error(`   ⚠️  Bot will continue without UI server (operations will work, but UI won't be accessible)`);
      // Don't exit - let bot continue without UI server instead of crashing
      return;
    }
  }
  
  // Set error handler for development (retry logic)
  server.once('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount < maxRetries) {
        const delay = 1000;
        console.log(`⏳ Port ${PORT} became in use, waiting ${delay/1000}s... (${retryCount}/${maxRetries})`);
        setTimeout(startServer, delay);
      } else {
        console.error(`❌ Port ${PORT} is already in use after ${maxRetries} attempts.`);
        console.error(`   Run: lsof -ti:${PORT} | xargs kill -9`);
        console.error(`   ⚠️  Bot will continue without UI server (operations will work, but UI won't be accessible)`);
        // Don't exit - let bot continue without UI server instead of crashing
      }
    } else {
      console.error('❌ Failed to start UI server:', err.message);
      console.error(`   ⚠️  Bot will continue without UI server (operations will work, but UI won't be accessible)`);
      // Don't exit on non-port errors either - log and continue
    }
  });
  
  // Start server in development
  try {
    server.listen(PORT, host, () => {
      console.log(`🌐 UI server listening on http://${host}:${PORT}`);
      serverStarted = true;
    });
  } catch (err) {
    // This catch block handles synchronous errors (unlikely with listen, but safe)
    console.error('❌ Failed to start UI server:', err.message);
    console.error(`   ⚠️  Bot will continue without UI server (operations will work, but UI won't be accessible)`);
  }
}

// Start server immediately in production (Render needs fast startup)
// In development, wait a bit to allow start.sh to clear the port
const startupDelay = process.env.NODE_ENV === 'production' ? 0 : 1000;
if (startupDelay > 0) {
  setTimeout(() => startServer(), startupDelay);
} else {
  // Start immediately in production
  startServer();
}

module.exports = {
  send: broadcast,
  setHandlers,
};

