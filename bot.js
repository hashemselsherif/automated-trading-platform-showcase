// bot.js
console.log("🚀 [STARTUP] Bot.js loading...");
console.log(`   Node version: ${process.version}`);
console.log(`   Platform: ${process.platform}`);
console.log(`   CWD: ${process.cwd()}`);

// Load main .env file
require("dotenv").config();
console.log("✅ [STARTUP] Main .env loaded");
const baseRequireSingleStrategyPerMarket = process.env.REQUIRE_SINGLE_STRATEGY_PER_MARKET;

// Check for multi-strategy mode (must be set in .env before strategy files)
const multiStrategyMode = (process.env.MULTI_STRATEGY_MODE || "false").toLowerCase() === "true";

if (multiStrategyMode) {
  // Multi-strategy mode: Load ALL enabled strategy configs
  // Direction controls (ALLOW_LONGS/ALLOW_SHORTS) should be in base .env for global control
  // or set per-strategy using strategy-specific prefixes
  console.log("🔄 [STARTUP] MULTI-STRATEGY mode enabled");

  const strategyEnvFiles = [];
  if ((process.env.ENABLE_MOMENTUM_STRATEGY || "true").toLowerCase() === "true") {
    strategyEnvFiles.push(".env.momentum");
  }
  if ((process.env.ENABLE_SCALPING_STRATEGY || "false").toLowerCase() === "true") {
    strategyEnvFiles.push(".env.scalping");
  }
  if ((process.env.ENABLE_RSI_REVERSION_STRATEGY || "false").toLowerCase() === "true") {
    strategyEnvFiles.push(".env.rsi-reversion");
  }
  if ((process.env.ENABLE_RSI_REVERSION_ALTS_STRATEGY || "false").toLowerCase() === "true") {
    // IMPORTANT: load alts BEFORE majors so majors remain the "base" env for legacy single-strategy reads.
    // The alts strategy reads its own env snapshot from disk (see StrategyFactory).
    strategyEnvFiles.unshift(".env.rsi-reversion-alts");
  }
  if ((process.env.ENABLE_BTC_BREAKOUT_STRATEGY || "false").toLowerCase() === "true") {
    strategyEnvFiles.push(".env.btc-breakout");
  }
  if ((process.env.ENABLE_ICHIMOKU_STRATEGY || "false").toLowerCase() === "true") {
    strategyEnvFiles.push(".env.ichimoku");
  }
  if ((process.env.ENABLE_PREDICTA_STRATEGY || "false").toLowerCase() === "true") {
    strategyEnvFiles.push(".env.predicta");
  }
  if ((process.env.ENABLE_COPY_TRADING_STRATEGY || "false").toLowerCase() === "true") {
    strategyEnvFiles.push(".env.copy-trading");
  }

  console.log(
    `📋 [STARTUP] Loading ${strategyEnvFiles.length} strategy configs: ${strategyEnvFiles.join(", ")}`
  );

  for (const envFile of strategyEnvFiles) {
    const envPath = require("path").join(process.cwd(), envFile);
    try {
      if (require("fs").existsSync(envPath)) {
        require("dotenv").config({ path: envPath, override: true });
        console.log(`✅ [STARTUP] Loaded: ${envFile}`);
      } else {
        console.log(`⚠️  [STARTUP] Not found: ${envFile}`);
      }
    } catch (e) {
      console.warn(`⚠️  [STARTUP] Failed to load ${envFile}: ${e.message}`);
    }
  }

  if (baseRequireSingleStrategyPerMarket !== undefined) {
    process.env.REQUIRE_SINGLE_STRATEGY_PER_MARKET = baseRequireSingleStrategyPerMarket;
  } else if (process.env.REQUIRE_SINGLE_STRATEGY_PER_MARKET !== undefined) {
    delete process.env.REQUIRE_SINGLE_STRATEGY_PER_MARKET;
  }
} else {
  // Single-strategy mode: Use STRATEGY_TYPE first, then ENABLE_*_STRATEGY toggles
  // IMPORTANT: STRATEGY_TYPE or ENABLE_RSI_REVERSION_STRATEGY or ENABLE_PREDICTA_STRATEGY must be in base .env
  //            (not in strategy-specific env file) for detection to work!
  const momentumEnabled = (process.env.ENABLE_MOMENTUM_STRATEGY || "true").toLowerCase() === "true";
  const scalpingEnabled =
    (process.env.ENABLE_SCALPING_STRATEGY || "false").toLowerCase() === "true";
  const rsiEnabled =
    (process.env.ENABLE_RSI_REVERSION_STRATEGY || "false").toLowerCase() === "true";
  const btcBreakoutEnabled =
    (process.env.ENABLE_BTC_BREAKOUT_STRATEGY || "false").toLowerCase() === "true";
  const predictaEnabled =
    (process.env.ENABLE_PREDICTA_STRATEGY || "false").toLowerCase() === "true";
  const copyEnabled =
    (process.env.ENABLE_COPY_TRADING_STRATEGY || "false").toLowerCase() === "true";

  let strategyType = process.env.STRATEGY_TYPE;

  // Log what we're seeing from env vars (helps debug loading issues)
  console.log(
    `📋 [STARTUP] Env check: STRATEGY_TYPE=${process.env.STRATEGY_TYPE || "NOT SET"}, ` +
      `ENABLE_MOMENTUM_STRATEGY=${process.env.ENABLE_MOMENTUM_STRATEGY || "NOT SET"}, ` +
      `ENABLE_RSI_REVERSION_STRATEGY=${process.env.ENABLE_RSI_REVERSION_STRATEGY || "NOT SET"}, ` +
      `ENABLE_BTC_BREAKOUT_STRATEGY=${process.env.ENABLE_BTC_BREAKOUT_STRATEGY || "NOT SET"}, ` +
      `ENABLE_PREDICTA_STRATEGY=${process.env.ENABLE_PREDICTA_STRATEGY || "NOT SET"}`
  );

  // If no explicit STRATEGY_TYPE, infer from enabled strategy toggles
  // Priority: predicta > btc-breakout > rsi-reversion > scalping > copy-trading > momentum
  if (!strategyType) {
    if (predictaEnabled && !momentumEnabled) {
      strategyType = "predicta";
    } else if (
      btcBreakoutEnabled &&
      !momentumEnabled &&
      !rsiEnabled &&
      !scalpingEnabled &&
      !predictaEnabled
    ) {
      strategyType = "btc-breakout";
    } else if (rsiEnabled && !momentumEnabled && !scalpingEnabled && !predictaEnabled) {
      strategyType = "rsi-reversion";
    } else if (scalpingEnabled && !momentumEnabled && !rsiEnabled && !predictaEnabled) {
      strategyType = "scalping";
    } else if (
      copyEnabled &&
      !momentumEnabled &&
      !rsiEnabled &&
      !scalpingEnabled &&
      !predictaEnabled
    ) {
      strategyType = "copy-trading";
    } else if (!momentumEnabled && rsiEnabled) {
      strategyType = "rsi-reversion"; // Prefer RSI if momentum disabled
    } else if (!momentumEnabled && btcBreakoutEnabled) {
      strategyType = "btc-breakout";
    } else if (!momentumEnabled && scalpingEnabled) {
      strategyType = "scalping";
    } else {
      strategyType = "momentum"; // Default
    }
    console.log(`📋 [STARTUP] Inferred strategy type from toggles: ${strategyType}`);
  }

  // Allow explicit env overlay selection (supports variants like `.env.rsi-reversion-alts`)
  // This keeps account-level and non-strategy keys in base `.env`, while allowing
  // strategy overlays to remain strategy-scoped.
  const fs = require("fs");
  const path = require("path");
  const envFileFromEnv = (process.env.ENV_FILE || "").trim();
  let strategyEnvFile = envFileFromEnv || `.env.${strategyType}`;

  // Back-compat / alias support for the alt RSI variant:
  // Strategy identity: rsi-reversion-alt
  // Overlay file: .env.rsi-reversion-alts
  if (!envFileFromEnv && strategyType === "rsi-reversion-alt") {
    const singular = path.join(process.cwd(), ".env.rsi-reversion-alt");
    const plural = path.join(process.cwd(), ".env.rsi-reversion-alts");
    if (!fs.existsSync(singular) && fs.existsSync(plural)) {
      strategyEnvFile = ".env.rsi-reversion-alts";
    }
  }

  const strategyEnvPath = path.join(process.cwd(), strategyEnvFile);
  console.log(`📋 [STARTUP] Single-strategy mode: ${strategyType}`);
  console.log(
    `📋 [STARTUP] Strategy toggles: momentum=${momentumEnabled}, scalping=${scalpingEnabled}, rsi=${rsiEnabled}, breakout=${btcBreakoutEnabled}`
  );

  try {
    if (require("fs").existsSync(strategyEnvPath)) {
      require("dotenv").config({ path: strategyEnvPath, override: true });
      console.log(`✅ [STARTUP] Strategy config loaded: ${strategyEnvFile}`);

      // Log key RSI config values after loading (helps verify per-market overrides)
      if (strategyType === "rsi-reversion") {
        console.log(
          `📋 [STARTUP] RSI globals after loading: RSI_OVERBOUGHT_EXTREME=${process.env.RSI_OVERBOUGHT_EXTREME || "NOT SET"}, ` +
            `RSI_OVERBOUGHT_RECOVERY=${process.env.RSI_OVERBOUGHT_RECOVERY || "NOT SET"}`
        );
        console.log(
          `📋 [STARTUP] RSI markets: STRATEGY_MARKETS=${process.env.STRATEGY_MARKETS || "NOT SET"}, ` +
            `RSI_REVERSION_MARKETS=${process.env.RSI_REVERSION_MARKETS || "NOT SET"}`
        );
        // Check for per-market overrides
        const markets = ["SOL_PERP", "ETH_PERP", "BTC_PERP"];
        for (const m of markets) {
          const override = process.env[`STRATEGY_${m}_RSI_OVERBOUGHT_EXTREME`];
          if (override) {
            console.log(`📋 [STARTUP] RSI per-market: ${m}: overboughtExtreme=${override}`);
          }
        }
      } else if (strategyType === "btc-breakout") {
        console.log(
          `📋 [STARTUP] BTC-Breakout globals after loading: TREND_EMA=${process.env.BREAKOUT_TREND_EMA_PERIOD || "NOT SET"}, ` +
            `ENTRY=${process.env.BREAKOUT_ENTRY_CHANNEL || "NOT SET"}, EXIT=${process.env.BREAKOUT_EXIT_CHANNEL || "NOT SET"}`
        );
        console.log(
          `📋 [STARTUP] BTC-Breakout markets: STRATEGY_MARKETS=${process.env.STRATEGY_MARKETS || "NOT SET"}, ` +
            `ALLOW_LONGS=${process.env.ALLOW_LONGS || "NOT SET"}, ALLOW_SHORTS=${process.env.ALLOW_SHORTS || "NOT SET"}`
        );
      }
    } else {
      console.log(`⚠️  [STARTUP] Strategy config not found: .env.${strategyType} (using defaults)`);
    }
  } catch (e) {
    console.warn(`⚠️  [STARTUP] Failed to load strategy config: ${e.message}`);
  }
}

console.log("✅ [STARTUP] All environment configs loaded");

// Multi-strategy env validation: ensure critical per-venue keys are correctly isolated
if (multiStrategyMode) {
  console.log("🔍 [STARTUP] Validating multi-strategy env isolation...");

  // In multi-strategy mode, StrategyFactory loads separate env snapshots for each strategy.
  // However, process.env reflects the LAST loaded file (majors), which could cause confusion.
  // Validate that venue-specific keys exist and warn about potential issues.

  const warnings = [];

  // Check that alts-specific keys are set (these shouldn't be in majors file)
  if (!process.env.PAPER_BALANCE_ALTS) {
    warnings.push("PAPER_BALANCE_ALTS not set - Drift alts will use fallback capital");
  }

  // Check that the strategy factory has been designed to handle env isolation
  // (it loads separate snapshots from .env.rsi-reversion and .env.rsi-reversion-alts)
  console.log(
    `📋 [STARTUP] process.env.FEE_MODEL=${process.env.FEE_MODEL} (reflects last loaded env file)`
  );
  console.log(
    `📋 [STARTUP] process.env.EXEC_MODE=${process.env.EXEC_MODE} (reflects last loaded env file)`
  );
  console.log(
    `⚠️  [STARTUP] NOTE: In multi-strategy mode, per-venue config is handled by StrategyFactory env snapshots.`
  );
  console.log(
    `⚠️  [STARTUP] Use venueRouter.getFeeModelForMarket(market) for correct per-market fee model.`
  );

  if (warnings.length > 0) {
    console.log("⚠️  [STARTUP] Multi-strategy warnings:");
    warnings.forEach((w) => console.log(`   - ${w}`));
  } else {
    console.log("✅ [STARTUP] Multi-strategy env isolation validated");
  }
}

// Log critical direction settings after all configs are loaded
console.log(
  `📋 [STARTUP] Direction settings: ALLOW_LONGS=${process.env.ALLOW_LONGS}, ALLOW_SHORTS=${process.env.ALLOW_SHORTS}`
);

// Guardrail: do NOT run both trailing stop systems simultaneously
// - Percent trailing (risk manager): USE_TRAILING_STOP + TRAILING_STOP_PERCENT
// - ATR trailing (Predicta strategy): PREDICTA_ENABLE_TRAILING_STOP + PREDICTA_TRAILING_ATR_MULT
const _useRiskTrailing =
  String(process.env.USE_TRAILING_STOP || "")
    .trim()
    .toLowerCase() === "true";
const _usePredictaAtrTrailing =
  String(process.env.PREDICTA_ENABLE_TRAILING_STOP || "")
    .trim()
    .toLowerCase() === "true";
if (_useRiskTrailing && _usePredictaAtrTrailing) {
  console.error(
    "❌ Invalid config: both USE_TRAILING_STOP=true and PREDICTA_ENABLE_TRAILING_STOP=true are enabled. Disable one trailing system."
  );
  process.exit(1);
}

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Keypair } = require("@solana/web3.js");
console.log("✅ [STARTUP] Core dependencies loaded");

// --- Local modules
console.log("📦 [STARTUP] Loading config...");
const config = require("./config");
console.log("✅ [STARTUP] Config loaded");

console.log("📦 [STARTUP] Validating config...");
const validateConfig = require("./src/core/validate-config");
console.log("✅ [STARTUP] Config validator loaded");

console.log("📦 [STARTUP] Loading pretty-log...");
const pretty = require("./src/core/pretty-log");
console.log("✅ [STARTUP] Pretty-log loaded");

// Set UI reference for pretty logs
console.log("📦 [STARTUP] Loading ui-server...");
const uiRef = require("./src/operations/ui-server");
console.log("✅ [STARTUP] UI server loaded");
pretty.setUI(uiRef);

// --- New utility modules
console.log("📦 [STARTUP] Loading utility modules...");
const { errorHandler, Severity, Category } = require("./utils/error-handler");
const PortfolioRiskManager = require("./utils/portfolio-risk");
const { FundingRateMonitor } = require("./utils/funding-rate");
const SlippageValidator = require("./utils/slippage-validator");
// Mark price feed removed - not needed (API returns 404, bot works fine with regular price)
// const MarkPriceFeed = require("./utils/mark-price");
const HealthCheckManager = require("./utils/health-check");
const DynamicLeverageManager = require("./utils/dynamic-leverage");
const marketDataProvider = require("./utils/market-data");
const MarketAllocator = require("./utils/market-allocator");
const PythWebSocketClient = require("./utils/pyth-websocket-client");
const PriceProvider = require("./utils/price-provider");
const StrategyFactory = require("./utils/strategy-factory");
const StrategyManager = require("./utils/strategy-manager");
console.log("✅ [STARTUP] Utility modules loaded");

// optional (if present in your repo)
let log = () => {};
try {
  log = require("./src/core/logger");
} catch {
  log = () => {};
}

// Always use Enhanced Momentum Breakout Strategy
console.log("📦 [STARTUP] Loading strategy modules...");
const USE_ENHANCED_STRATEGY = true;
const EnhancedMomentumBreakoutStrategy = require("./src/strategies/enhanced-momentum-strategy");
const RiskManager = require("./risk-manager");
const journal = require("./src/core/journal");
const db = require("./db");
console.log("✅ [STARTUP] Strategy modules loaded");

console.log("📦 [STARTUP] Loading Telegram control...");
const TelegramControl = require("./src/operations/telegram-control");
const GuardedExecutorTelegram = require("./src/execution/guarded-executor-telegram");
console.log("✅ [STARTUP] Telegram control loaded");

// Strategy environment manager (isolated env per strategy to prevent bleeding)
console.log("📦 [STARTUP] Initializing strategy env manager...");
const strategyEnvManager = require("./utils/strategy-env-manager");
strategyEnvManager.initialize();
console.log("✅ [STARTUP] Strategy env manager initialized");

// Dump configs in debug mode
if ((process.env.DEBUG_ENV || "false").toLowerCase() === "true") {
  strategyEnvManager.dumpConfigs();
}

// Price + paper simulator
console.log("📦 [STARTUP] Loading perps clients...");
const PaperPerpsClient = require("./src/execution/perps-client");
// Live execution helper (Jupiter majors)
const LivePerpsClient = require("./src/execution/perps-live-client");
// Drift execution client (alts)
const DriftPerpsClient = require("./src/execution/perps-drift-client");
// Venue-aware executor (routes to Jupiter or Drift based on market)
// NOTE: TradeExecutionService is DEPRECATED - all trades go through VenueAwareTradeExecutor
const VenueAwareTradeExecutor = require("./src/execution/venue-aware-trade-executor");
console.log("✅ [STARTUP] Perps clients loaded");

// Web UI server
console.log("📦 [STARTUP] Loading UI server...");
const ui = require("./src/operations/ui-server");
console.log("✅ [STARTUP] UI server loaded");

// ---------- Validate config ----------
console.log("🔍 [STARTUP] Validating configuration...");
try {
  validateConfig(config);
  console.log("✅ [STARTUP] Configuration validated successfully");
} catch (error) {
  console.error("❌ [STARTUP] Configuration validation failed:", error.message);
  console.error("   Stack:", error.stack);
  process.exit(1);
}

// ---------- Initialize config manager ----------
const { createConfigManager } = require("./backtest/config-manager");
const cfgManager = createConfigManager(config);

// ---------- Environment & constants ----------
// Use config manager for unified access (still uses config.js as source of truth)
const EXEC_MODE = config.executionMode.toLowerCase();
let LOOP_MS = config.botLoopMs;
const WARMUP_TICKS = config.warmupTicks;
const MARKET = config.market; // For backward compatibility
const MARKETS = config.markets || [MARKET]; // Multi-market support

// DIAGNOSTIC: Log critical config values to verify env vars are being read
console.log("🔧 Configuration loaded:");
console.log(`   BOT_LOOP_MS env: ${process.env.BOT_LOOP_MS || "NOT SET"}`);
console.log(`   BOT_LOOP_MS actual: ${LOOP_MS}ms (${(LOOP_MS / 1000).toFixed(1)}s)`);
console.log(`   JUP_API_MIN_MS env: ${process.env.JUP_API_MIN_MS || "NOT SET"}`);
console.log(`   WARMUP_TICKS env: ${process.env.WARMUP_TICKS || "NOT SET"}`);
console.log(`   WARMUP_TICKS actual: ${WARMUP_TICKS}`);
console.log(`   MARKETS: ${MARKETS.join(", ")}`);
if (LOOP_MS < 10000) {
  console.warn(
    `⚠️  WARNING: BOT_LOOP_MS is ${LOOP_MS}ms (${(LOOP_MS / 1000).toFixed(1)}s) - this may cause rate limit issues!`
  );
  console.warn(`   Recommended: Set BOT_LOOP_MS=15000 in Render environment variables`);
}

// Use config manager for trading limits (consistent with backtest)
const tradingLimits = cfgManager.getTradingLimits();
let DAILY_TRADE_LIMIT = tradingLimits.dailyTradeLimit;
let MAX_POSITIONS = tradingLimits.maxPositions;

// Log format: 'compact' for 2-line-per-market, 'verbose' for full detailed output
const LOG_FORMAT = (process.env.LOG_FORMAT || "compact").toLowerCase();

const VOLUME_FALLBACK_THRESHOLD = config.volumeFallbackThreshold;
const MAX_SLIPPAGE_BPS = config.risk.slippageBps;
const MAX_MARKET_IMPACT_BPS = config.risk.maxMarketImpactBps;
const MARKET_IMPACT_STEPS = config.marketImpactSteps.length > 0 ? config.marketImpactSteps : [];

// ---------- Wallet ----------
async function loadWallet() {
  console.log("📦 [WALLET] Loading wallet configuration...");

  // Support environment variable for private key (for CI/CD, containers)
  const privateKeyEnv = process.env.WALLET_PRIVATE_KEY;
  if (privateKeyEnv) {
    console.log("   Using WALLET_PRIVATE_KEY from environment");
    try {
      // Try parsing as JSON array first
      const secret = JSON.parse(privateKeyEnv);
      const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      console.log(`✅ [WALLET] Loaded from WALLET_PRIVATE_KEY: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (e) {
      // Try parsing as base58 string
      try {
        const bs58 = require("bs58").default || require("bs58");
        const secret = bs58.decode(privateKeyEnv);
        const keypair = Keypair.fromSecretKey(secret);
        console.log(
          `✅ [WALLET] Loaded from WALLET_PRIVATE_KEY (base58): ${keypair.publicKey.toBase58()}`
        );
        return keypair;
      } catch (e2) {
        console.error("❌ [WALLET] Invalid WALLET_PRIVATE_KEY format");
        console.error("   Must be JSON array [1,2,3,...] or base58 string");
        console.error("   Parse error:", e2.message);
        throw new Error(`Invalid WALLET_PRIVATE_KEY format. Use JSON array or base58 string.`);
      }
    }
  }

  // Fall back to file-based loading
  const walletPath =
    process.env.WALLET_PRIVATE_KEY_PATH || path.join(process.cwd(), "perps-wallet.json");
  console.log(`   Looking for wallet file: ${walletPath}`);

  if (!fs.existsSync(walletPath)) {
    console.error(`❌ [WALLET] Wallet file not found: ${walletPath}`);
    if (config.paperTradingMode) {
      console.warn("⚠️  [WALLET] Paper trading mode - generating random keypair");
      const keypair = Keypair.generate();
      console.log(`   Generated keypair: ${keypair.publicKey.toBase58()}`);
      return keypair;
    }
    console.error("\n💡 [WALLET] For Render deployment:");
    console.error("   Set WALLET_PRIVATE_KEY environment variable in Render Dashboard");
    console.error("   Format: JSON array like [1,2,3,...] (64 numbers)");
    console.error("   See docs/WALLET_DEPLOYMENT_SETUP.md for details\n");
    throw new Error(
      `Wallet keypair not found: ${walletPath}. Set WALLET_PRIVATE_KEY environment variable for containerized deployments.`
    );
  }

  console.log(`✅ [WALLET] Found wallet file: ${walletPath}`);

  // Check file permissions (should be 600 on Unix systems) - ENFORCE in production
  // Allow 640 for Render secret files (/etc/secrets/) as they're mounted by Render
  if (process.platform !== "win32") {
    try {
      const stats = fs.statSync(walletPath);
      const mode = stats.mode & parseInt("777", 8);
      const requiredMode = parseInt("600", 8);
      const renderSecretMode = parseInt("640", 8);

      // Check if this is a Render secret file (could be in /etc/secrets/ or deployed location)
      const isRenderEnvironment =
        process.env.RENDER === "true" || process.env.IS_PULL_REQUEST === "true";
      const isRenderSecretFile = walletPath.startsWith("/etc/secrets/") || isRenderEnvironment;

      // Enforce correct permissions in production
      // Allow 600 (most secure) or 640 (Render secret files)
      const isValidMode =
        mode === requiredMode || (isRenderSecretFile && mode === renderSecretMode);

      if (!isValidMode) {
        const errorMsg = `Wallet file permissions are ${mode.toString(8)}, must be 600 for security${isRenderSecretFile ? " (or 640 for Render secret files)" : ""}. Run: chmod 600 ${walletPath}`;

        if (
          process.env.NODE_ENV === "production" ||
          process.env.ENFORCE_WALLET_PERMISSIONS === "true"
        ) {
          throw new Error(errorMsg);
        } else {
          console.warn(`⚠️  ${errorMsg}`);
        }
      }
    } catch (e) {
      if (e.message.includes("Wallet file permissions")) {
        throw e; // Re-throw permission errors
      }
      // Ignore other errors (file doesn't exist, etc.)
    }
  }

  // Try to load encrypted wallet first
  console.log("📦 [WALLET] Checking if wallet is encrypted...");
  const walletEncryption = require("./utils/wallet-encryption");

  if (walletEncryption.isEncrypted(walletPath)) {
    console.log("🔐 [WALLET] Wallet file is encrypted, loading password securely...");

    // Try to get password from secure loader (supports encrypted storage + env vars)
    let walletPassword;
    try {
      const { getWalletPasswordSync } = require("./utils/secure-password-loader");
      walletPassword = getWalletPasswordSync();

      if (!walletPassword) {
        // Fallback: Try loading from encrypted storage asynchronously
        console.log("🔐 [WALLET] Password not in cache/env, trying encrypted storage...");
        const { getWalletPassword } = require("./utils/secure-password-loader");
        // Allow prompting - will throw PM2-specific error if no TTY
        walletPassword = await getWalletPassword(true);
      }
    } catch (loaderError) {
      // Check if it's a master password error (rethrow with helpful message)
      if (
        loaderError.code === "NO_MASTER_PASSWORD" ||
        loaderError.code === "PM2_NO_INTERACTIVE" ||
        loaderError.code === "NO_TTY"
      ) {
        throw loaderError; // Propagate the helpful error
      }
      // Other errors: fall back to env var
      console.warn("⚠️  [WALLET] Secure password loader error:", loaderError.message);
      console.warn("   Falling back to WALLET_PASSWORD environment variable...");
      walletPassword = process.env.WALLET_PASSWORD;
    }

    if (!walletPassword) {
      console.error("❌ [WALLET] WALLET_PASSWORD not found!");
      console.error("   Options to fix:");
      console.error("   1. Set WALLET_PASSWORD in .env file");
      console.error("   2. Run: npm run secrets (select option 8 to encrypt passwords)");
      console.error("   3. Set SECRETS_MASTER_PASSWORD to load from encrypted storage");
      console.error("   4. For Render: Set WALLET_PASSWORD in environment variables");
      throw new Error(
        "Wallet file is encrypted but WALLET_PASSWORD not found in environment or encrypted storage."
      );
    }

    console.log("🔑 [WALLET] Password loaded, decrypting wallet...");

    // NOTE: Password is NOT set in process.env for security
    // Instead, it's passed directly to DriftSubprocessClient when needed
    // This prevents exposure in logs, error dumps, and child processes

    try {
      const decrypted = walletEncryption.loadEncryptedWallet(walletPath, walletPassword);
      const secret = Uint8Array.from(decrypted);

      // Clear password from memory (best effort)
      walletPassword = null;
      if (global.gc) global.gc();

      const keypair = Keypair.fromSecretKey(secret);
      console.log(`✅ [WALLET] Successfully decrypted wallet: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (e) {
      console.error("❌ [WALLET] Failed to decrypt wallet!");
      console.error("   Error:", e.message);
      console.error("   This could mean:");
      console.error("   1. WALLET_PASSWORD is incorrect");
      console.error("   2. Wallet file is corrupted");
      console.error("   3. Wallet file format is invalid");
      throw new Error(`Failed to decrypt wallet: ${e.message}`);
    }
  } else {
    // Plaintext wallet (legacy support)
    console.log("📄 [WALLET] Wallet file is NOT encrypted (plaintext)");
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "⚠️  WARNING: Using unencrypted wallet file in production. Consider encrypting it."
      );
    }

    try {
      const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
      const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      console.log(`✅ [WALLET] Loaded plaintext wallet: ${keypair.publicKey.toBase58()}`);

      // Clear secret from memory (best effort)
      if (global.gc) global.gc();

      return keypair;
    } catch (e) {
      console.error("❌ [WALLET] Failed to load plaintext wallet!");
      console.error("   Error:", e.message);
      console.error("   File path:", walletPath);
      throw new Error(`Failed to load wallet from ${walletPath}: ${e.message}`);
    }
  }
}

class PerpsBot {
  /**
   * Create a new PerpsBot instance asynchronously (factory method)
   * This allows for async wallet loading with secure password management
   */
  static async create() {
    console.log("📦 [FACTORY] Creating PerpsBot instance...");

    // Load wallet asynchronously (supports encrypted storage)
    console.log("📦 [FACTORY] Loading wallet with secure password loader...");
    let wallet;
    try {
      wallet = await loadWallet();
    } catch (error) {
      // Check if it's a master password error (Render/CI/CD)
      if (error.code === "NO_MASTER_PASSWORD") {
        console.error(error.message);
        throw error; // Already has helpful message
      }

      // Check if it's a PM2-specific error
      if (error.code === "PM2_NO_INTERACTIVE") {
        console.error(error.message);
        throw new Error("PM2 requires SECRETS_MASTER_PASSWORD to be set. See instructions above.");
      }

      // Check if it's a non-TTY error
      if (error.code === "NO_TTY") {
        console.error(error.message);
        throw new Error(
          "Interactive prompt not available. Set SECRETS_MASTER_PASSWORD environment variable."
        );
      }

      // Generic wallet loading error
      console.error("💥 [FACTORY] FATAL: Failed to load wallet");
      console.error("   Error:", error.message);

      console.error("\n🔧 [FACTORY] Troubleshooting:");
      console.error("   1. If using encrypted storage:");
      console.error("      - Set SECRETS_MASTER_PASSWORD environment variable");
      console.error(
        '      - For PM2: pm2 set jupiter-perps-bot:SECRETS_MASTER_PASSWORD "your_password"'
      );
      console.error("   2. Or use plaintext password (less secure):");
      console.error("      - Set WALLET_PASSWORD in .env file");
      console.error("   3. To encrypt passwords: npm run secrets (option 8)");
      console.error(
        "   4. For Render: Set SECRETS_MASTER_PASSWORD in environment (marked as Secret)"
      );
      console.error("   5. For paper trading: Set TRADING_MODE=paper\n");
      throw error;
    }

    console.log("✅ [FACTORY] Wallet loaded successfully");
    return new PerpsBot(wallet);
  }

  constructor(wallet) {
    if (!wallet) {
      throw new Error("Wallet is required. Use PerpsBot.create() instead of new PerpsBot()");
    }

    // --- Config ---
    this.config = config; // Store config reference for compounding control via ENABLE_COMPOUNDING

    // --- Environment Detection ---
    // Consistent environment detection across the codebase
    this.environment = this._detectEnvironment();
    this.instanceId =
      process.env.BOT_INSTANCE_ID ||
      `${this.environment}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`🔧 Bot Environment: ${this.environment} (Instance: ${this.instanceId})`);

    // --- State ---
    console.log("📦 [CONSTRUCTOR] Using pre-loaded wallet...");
    this.wallet = wallet;
    console.log(`✅ [CONSTRUCTOR] Wallet loaded: ${this.wallet.publicKey.toBase58()}`);

    // --- Runtime Stats ---
    this._startTime = Date.now();
    this._loopCount = 0;
    this._loopDurations = [];
    this._avgLoopDuration = 0;
    this._priceRoutingLogged = false;

    // --- Position Opening Queue (Sequential Execution) ---
    this._openPositionQueue = [];
    this._openPositionInProgress = false;
    console.log("📦 [CONSTRUCTOR] Sequential position opening queue initialized");

    // Strategy Factory & Manager for multi-strategy support (Phase 6 + Multi-Strategy Enhancement)
    console.log("📦 [CONSTRUCTOR] Initializing Strategy Factory & Manager...");
    this.strategyFactory = new StrategyFactory(config);
    this.multiStrategyMode = config.multiStrategyMode || false;
    // Safety guard (reversible): prevent accidentally running multiple strategies on the same market.
    // Enable with REQUIRE_SINGLE_STRATEGY_PER_MARKET=true.
    this._requireSingleStrategyPerMarket =
      this.multiStrategyMode &&
      String(process.env.REQUIRE_SINGLE_STRATEGY_PER_MARKET || "false").toLowerCase() === "true";
    this.strategyManager = new StrategyManager(this.strategyFactory, {
      multiStrategyMode: this.multiStrategyMode,
      markets: MARKETS,
    });

    // Legacy: Keep strategies Map for backward compatibility
    // In multi-strategy mode: market -> [{ type, strategy }, ...]
    // In single-strategy mode: market -> strategy
    this.strategies = new Map();
    this.marketPerformance = new Map();

    // Initialize bar aggregators per market (discrete 5-minute bars)
    // AND tick buffers (rolling window for current bar data)
    // This hybrid approach: discrete bars for bar counting + rolling window for current data
    const BarAggregator = require("./utils/bar-aggregator");
    const TickBuffer = require("./utils/tick-buffer");
    this.barAggregators = new Map();
    this.tickBuffers = new Map();

    // Parse trading interval from config (e.g., '5m', '15m', '1h')
    this.tradingInterval = config.tradingInterval || "5m";
    this.barDurationMs = this._parseIntervalToMs(this.tradingInterval);
    // In multi-strategy mode we may run different intervals per market (e.g., 1h majors + 5m alts).
    // Keep this feature easy to revert by disabling via PER_MARKET_INTERVALS=false.
    this._perMarketIntervalsEnabled =
      this.multiStrategyMode &&
      String(process.env.PER_MARKET_INTERVALS || "true").toLowerCase() !== "false";

    if (this._perMarketIntervalsEnabled) {
      console.log(
        `[BOT] Hybrid approach: ${LOOP_MS}ms ticks → per-market bars + rolling window (PER_MARKET_INTERVALS=true)`
      );
    } else {
      console.log(
        `[BOT] Hybrid approach: ${LOOP_MS}ms ticks → ${this.tradingInterval} (${this.barDurationMs}ms) bars + rolling window for dynamic indicators`
      );
    }

    // Log multi-strategy mode status
    if (this.multiStrategyMode) {
      const enabledStrategies = this.strategyFactory.getEnabledStrategies();
      console.log(
        `[BOT] 🔄 MULTI-STRATEGY MODE: ${enabledStrategies.length} strategies enabled per market: ${enabledStrategies.join(", ")}`
      );
    }

    // Track strategy types per market for logging
    const marketStrategyTypes = new Map();
    // Track per-market interval config (only used when PER_MARKET_INTERVALS=true)
    this._marketIntervals = new Map(); // market -> interval string (e.g., '5m', '1h')
    this._marketBarDurationMs = new Map(); // market -> duration ms

    for (const market of MARKETS) {
      // Add market to strategy manager (will create appropriate strategy type)
      this.strategyManager.addMarket(market);

      if (this.multiStrategyMode) {
        // Multi-strategy mode: create ALL enabled strategies for this market
        const marketStrategies = this.strategyFactory.createAllStrategies(market);
        this.strategies.set(market, marketStrategies);

        // Track strategy types for this market
        const types = marketStrategies.map((s) => s.type);
        marketStrategyTypes.set(market, types);

        // Log each strategy created
        for (const { type, strategy } of marketStrategies) {
          pretty("strategy", {
            type,
            market,
            strategyClass: strategy.constructor.name,
            mode: "multi-strategy",
          });
        }
      } else {
        // Single-strategy mode (legacy): create one strategy per market
        const strategyType = this.strategyFactory.getStrategyType(market);
        const strategy = this.strategyFactory.createStrategy(market);
        this.strategies.set(market, strategy);

        // Track strategy type for this market
        marketStrategyTypes.set(market, [strategyType]);

        pretty("strategy", {
          type: strategyType,
          market,
          strategyClass: strategy.constructor.name,
        });
      }

      // Apply per-market allow settings if available
      if (config.perMarketStrategy && config.perMarketStrategy[market]) {
        const marketOverride = config.perMarketStrategy[market];
        if (marketOverride.allowShorts !== undefined || marketOverride.allowLongs !== undefined) {
          // Store per-market allow settings for later use
          if (!this.perMarketAllowSettings) this.perMarketAllowSettings = new Map();
          this.perMarketAllowSettings.set(market, {
            allowShorts:
              marketOverride.allowShorts !== undefined ? marketOverride.allowShorts : true,
            allowLongs: marketOverride.allowLongs !== undefined ? marketOverride.allowLongs : true,
          });
        }
      }

      // Initialize bar aggregator per market (discrete bars)
      const marketInterval = this._resolveTradingIntervalForMarket(market);
      const marketBarDurationMs = this._perMarketIntervalsEnabled
        ? this._parseIntervalToMs(marketInterval)
        : this.barDurationMs;
      this._marketIntervals.set(market, marketInterval);
      this._marketBarDurationMs.set(market, marketBarDurationMs);

      this.barAggregators.set(
        market,
        new BarAggregator({
          barDurationMs: marketBarDurationMs,
          maxCompletedBars: 1000,
        })
      );

      // Initialize tick buffer per market (rolling window for current data)
      this.tickBuffers.set(
        market,
        new TickBuffer({
          windowMs: marketBarDurationMs,
          maxTicks: 1000,
        })
      );

      // Initialize performance tracking per market
      this.marketPerformance.set(market, {
        winRate: 0.5, // Start neutral
        avgPnL: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalPnL: 0,
        recentTrades: [],
      });
    }

    if (this._requireSingleStrategyPerMarket) {
      const offending = [];
      for (const market of MARKETS) {
        const s = this.strategies.get(market);
        if (Array.isArray(s) && s.length > 1) {
          offending.push(`${market}=[${s.map((x) => x.type).join(",")}]`);
        }
      }
      if (offending.length > 0) {
        throw new Error(
          `[BOT] REQUIRE_SINGLE_STRATEGY_PER_MARKET=true but multiple strategies were created for: ${offending.join(" ")}. ` +
            `Fix by disabling strategies or setting disjoint STRATEGY_MARKETS per strategy env file.`
        );
      }
    }

    // Store strategy types per market for status logging
    this.marketStrategyTypes = marketStrategyTypes;

    // Log strategy summary with clean, multi-strategy aware format
    console.log("\n" + "═".repeat(60));
    console.log("📊 STRATEGY CONFIGURATION");
    console.log("═".repeat(60));

    if (this.multiStrategyMode) {
      const enabledStrategies = this.strategyFactory.getEnabledStrategies();
      console.log(`   Mode: MULTI-STRATEGY`);
      console.log(`   Enabled: ${enabledStrategies.join(", ")}`);
    } else {
      console.log(`   Mode: SINGLE-STRATEGY`);
    }

    console.log(`   Markets: ${MARKETS.join(", ")}`);
    console.log("");
    console.log("   Per-Market Breakdown:");
    for (const [market, types] of marketStrategyTypes.entries()) {
      const typesStr = types.length > 1 ? types.join(" + ") : types[0];
      console.log(`     ${market}: ${typesStr}`);
    }
    console.log("═".repeat(60) + "\n");

    // Log per-market interval + venue (only when per-market intervals are enabled)
    if (this._perMarketIntervalsEnabled) {
      const venueRouter = require("./utils/venue-router");
      console.log("═".repeat(60));
      console.log("📊 PER-MARKET INTERVALS");
      console.log("═".repeat(60));
      for (const market of MARKETS) {
        const interval = this._marketIntervals.get(market) || this.tradingInterval;
        const venue = venueRouter.getVenueForMarket(market);
        console.log(`     ${market}: ${interval} (${venue})`);
      }
      console.log("═".repeat(60) + "\n");
    }

    // Log enabled strategy configs
    if (this.multiStrategyMode) {
      const enabledStrategies = this.strategyFactory.getEnabledStrategies();
      for (const stratType of enabledStrategies) {
        if (stratType === "momentum") {
          const mCfg = this.strategyFactory.momentumConfig;
          console.log(
            `[${stratType.toUpperCase()}] Config: TP=${mCfg.takeProfitPercent}% SL=${mCfg.stopLossPercent}% RSI=[${mCfg.rsiLong},${mCfg.rsiShort}] ADX>${mCfg.adxThreshold} Donchian=${mCfg.donchianPeriod}`
          );
        } else if (stratType === "rsi-reversion") {
          const rCfg = this.strategyFactory.rsiReversionConfig;
          console.log(
            `[${stratType.toUpperCase()}] Config: RSI=${rCfg.rsiPeriod} Oversold=[${rCfg.rsiOversoldExtreme}-${rCfg.rsiOversoldRecovery}] Overbought=[${rCfg.rsiOverboughtExtreme}-${rCfg.rsiOverboughtRecovery}] SMA=${rCfg.rsiUseSma !== false ? "Yes" : "Wilder"}`
          );
        } else if (stratType === "rsi-reversion-alt") {
          const rCfg = this.strategyFactory.rsiReversionAltConfig;
          console.log(
            `[${stratType.toUpperCase()}] Config: RSI=${rCfg?.rsiStrategy?.rsiPeriod ?? 14} Oversold=[${rCfg?.rsiStrategy?.rsiOversoldExtreme ?? 20}-${rCfg?.rsiStrategy?.rsiOversoldRecovery ?? 25}] Overbought=[${rCfg?.rsiStrategy?.rsiOverboughtExtreme ?? 80}-${rCfg?.rsiStrategy?.rsiOverboughtRecovery ?? 75}]`
          );
        } else if (stratType === "btc-breakout") {
          const bCfg = this.strategyFactory.btcBreakoutConfig?.breakoutStrategy || {};
          console.log(
            `[${stratType.toUpperCase()}] Config: EMA=${bCfg.trendEmaPeriod ?? 200} Entry=${bCfg.entryChannel ?? 20} Exit=${bCfg.exitChannel ?? 10} ATR=${bCfg.atrPeriod ?? 20} Dirs=${bCfg.allowLongs !== false ? "L" : "-"}${bCfg.allowShorts === true ? "S" : "-"}`
          );
        }
        // Note: Scalping strategy info only shown if explicitly enabled
      }
    }
    console.log("✅ [CONSTRUCTOR] Strategy Factory & Manager initialized");

    // Market allocator for intelligent trade distribution (Phase 9: strategy-aware)
    // Use config.allocator settings (env-driven with optimized defaults)
    // Pass MARKETS list to allocator for dynamic market support
    // Pass strategy factory for strategy-aware scoring
    this.marketAllocator = new MarketAllocator(
      {
        ...(config.allocator || {}),
        markets: MARKETS, // Pass actual markets from env/config
        maxPositionsPerMarket: config.allocator?.maxPositionsPerMarket || 3,
      },
      {
        strategyFactory: this.strategyFactory, // Phase 9: strategy-aware scoring
      }
    );

    // Use config manager for risk and portfolio risk configs (Phase 8: strategy-aware)
    this.riskManager = new RiskManager(cfgManager.getRiskConfig(), {
      strategyFactory: this.strategyFactory, // Phase 8: strategy-aware risk
    });
    this.portfolioRisk = new PortfolioRiskManager(
      cfgManager.getPortfolioRiskConfig({
        maxTotalLeverage: Number(process.env.MAX_TOTAL_LEVERAGE || 10),
        maxTotalExposure: Number(process.env.MAX_TOTAL_EXPOSURE || 5000),
      })
    );
    // Align portfolio maxPositions with total cap for consistency
    this.portfolioRisk.config.maxPositions = MAX_POSITIONS;

    // Use config manager for leverage config
    const leverageConfig = cfgManager.getLeverageConfig({
      portfolioLeverageThreshold: config.risk.maxTotalLeverage * 0.7,
      maxFundingRatePercent: config.risk.maxFundingRatePercent || 0.1,
      drawdownThreshold: 0.15,
      trackPerformance: true,
    });

    this.leverageManager = new DynamicLeverageManager(leverageConfig);

    // Clean leverage config log
    console.log(
      `[LEVERAGE] Mode: ${config.leverage.dynamic !== false ? "Dynamic" : "Static"} | Base: ${leverageConfig.baseLeverage}x | Range: [${leverageConfig.minLeverage}x - ${leverageConfig.maxLeverage}x]`
    );

    // Controls / approvals - Initialize FIRST so we can pass to components
    this.tg = new TelegramControl();
    this.tg.init(this);
    this.guard = new GuardedExecutorTelegram(this.tg);

    // Connect error handler to Telegram for critical alerts
    errorHandler.setTelegram(this.tg);

    // Price source always available (also acts as paper trade engine)
    // Pass telegram instance to price client for alerts
    this.priceClient = new PaperPerpsClient(config, this.wallet, this.tg);

    // Unified Price Provider (Pyth WebSocket + Jupiter API fallback)
    // Pyth WebSocket is PRIMARY source for all strategies (most efficient, what Jupiter uses)
    console.log("[PRICE PROVIDER] Initializing unified price provider...");
    this.priceProvider = new PriceProvider({
      markets: MARKETS,
      jupiterClient: this.priceClient,
      enablePythWS: process.env.ENABLE_PYTH_WS !== "false", // Default: enabled (can disable with env var)
    });

    // Legacy: Keep pythWS reference for backward compatibility (will be set after start())
    this.pythWS = null;

    console.log("[PRICE PROVIDER] ✅ Initialized (Pyth WebSocket as primary source)");

    // Funding rate monitoring
    this.fundingMonitor = new FundingRateMonitor({
      apiUrl: config.jupiterApiUrl,
    });

    // Slippage validation
    this.slippageValidator = new SlippageValidator({
      maxSlippageBps: MAX_SLIPPAGE_BPS,
      jupiterApiUrl: config.jupiterApiUrl,
      maxMarketImpactBps: MAX_MARKET_IMPACT_BPS,
      impactSteps: MARKET_IMPACT_STEPS,
    });

    // Health checks
    this.healthCheck = new HealthCheckManager({
      rpcUrl: config.rpcUrl,
      jupiterApiUrl: config.jupiterApiUrl,
      priceClient: this.priceClient, // Share price client for coordinated rate limiting
    });

    // Trade executor switches by mode
    this.liveMode = !config.paperTradingMode;

    // ------------------------------------------------------------
    // Drift rollout controls: Shadow mode + Limited Live gate
    // MOVED UP: Must initialize before VenueAwareTradeExecutor
    // ------------------------------------------------------------
    try {
      const { getShadowModeManager } = require("./utils/shadow-mode");
      const { getLimitedLiveController } = require("./utils/limited-live");

      const trackingDays = Number(process.env.SHADOW_TRACKING_PERIOD_DAYS || 7);
      const trackingPeriodMs =
        (Number.isFinite(trackingDays) && trackingDays > 0 ? trackingDays : 7) *
        24 *
        60 *
        60 *
        1000;

      this.shadowManager = getShadowModeManager({
        enabled: (process.env.SHADOW_MODE_ENABLED || "false").toLowerCase() === "true",
        trackingPeriodMs,
        maxAcceptableSlippageBps: Number(process.env.SHADOW_MAX_SLIPPAGE_BPS || 50),
        maxOracleDeviationBps: Number(process.env.SHADOW_MAX_ORACLE_DEVIATION_BPS || 30),
        minMakerFillRate: Number(process.env.SHADOW_MIN_MAKER_FILL_RATE || 0.7),
      });
      this.shadowManager.start();

      this.limitedLiveController = getLimitedLiveController();
      if (
        this.limitedLiveController &&
        typeof this.limitedLiveController.getStatus === "function"
      ) {
        const st = this.limitedLiveController.getStatus();
        const logPrefix = st.state === "full_live" ? "[DriftLive]" : "[LimitedLive]";

        // In full_live mode: all markets allowed, totalCap irrelevant
        // In limited_live mode: market whitelist + caps enforced
        if (st.state === "full_live") {
          console.log(
            `${logPrefix} Initialized: state=${st.state} (all markets allowed) ` +
              `capDefault=$${Number(st.positionCaps?.default || 0).toFixed(0)}`
          );
        } else if (st.state === "limited_live") {
          console.log(
            `${logPrefix} Initialized: state=${st.state} enabledMarkets=${(st.enabledMarkets || []).length} ` +
              `capDefault=$${Number(st.positionCaps?.default || 0).toFixed(0)} totalCap=$${Number(st.totalExposureCap || 0).toFixed(0)}`
          );
        } else {
          console.log(
            `${logPrefix} Initialized: state=${st.state} ` +
              `capDefault=$${Number(st.positionCaps?.default || 0).toFixed(0)} totalCap=$${Number(st.totalExposureCap || 0).toFixed(0)}`
          );
        }
      } else {
        console.log("[LimitedLive] Initialized (no status available)");
      }
    } catch (e) {
      console.warn("[ShadowMode/LimitedLive] init skipped:", e?.message || e);
      this.shadowManager = null;
      this.limitedLiveController = null;
    }

    // ------------------------------------------------------------
    // Create Jupiter client (majors: SOL, BTC, ETH)
    // ------------------------------------------------------------
    this.jupiterClient = this.liveMode
      ? new LivePerpsClient(this.wallet, {
          db: db,
          enableAutoTracking: true,
          mode: "live",
          trade_type: "automated",
          environment: this.environment,
          instance_id: this.instanceId,
        })
      : this.priceClient;

    // Backwards compatibility alias
    this.tradeClient = this.jupiterClient;

    // ------------------------------------------------------------
    // Create Drift client (alts) - only if DRIFT_LIVE_STATE is not disabled
    // ------------------------------------------------------------
    this.driftClient = null;
    const driftLiveState = (process.env.DRIFT_LIVE_STATE || "shadow_only").toLowerCase();
    const driftEnabled = driftLiveState !== "disabled";

    if (this.liveMode && driftEnabled) {
      try {
        // Pass active markets to optimize DLOB subscription (only subscribe to what's being traded)
        this.driftClient = new DriftPerpsClient(
          { paperTradingMode: config.paperTradingMode },
          this.wallet,
          this.telegram,
          {
            activeMarkets: MARKETS, // Pass MARKETS for optimized DLOB subscription
            priceProvider: this.priceProvider,
          }
        );
        console.log(`[DriftClient] Created (state=${driftLiveState})`);
      } catch (e) {
        console.warn(`[DriftClient] Failed to create: ${e?.message || e}`);
        this.driftClient = null;
      }
    } else {
      console.log(
        `[DriftClient] Skipped (liveMode=${this.liveMode}, driftEnabled=${driftEnabled})`
      );
    }

    // ------------------------------------------------------------
    // Create Venue-Aware Trade Executor
    // Routes trades to Jupiter or Drift based on market
    // ------------------------------------------------------------
    this.tradeExecutor = new VenueAwareTradeExecutor({
      jupiterClient: this.jupiterClient,
      driftClient: this.driftClient,
      limitedLiveController: this.limitedLiveController,
      shadowManager: this.shadowManager,
      openRetries: Number(process.env.OPEN_POSITION_MAX_RETRIES || 2),
      closeRetries: Number(process.env.CLOSE_POSITION_MAX_RETRIES || 2),
      retryDelayMs: Number(process.env.TRADE_RETRY_DELAY_MS || 1500),
      logger: console,
    });

    this.tradeExecutor.on("open:attempt", (evt) =>
      this._recordOpenDiagnostic({ stage: "executor_attempt", ...evt })
    );
    this.tradeExecutor.on("open:error", (evt) =>
      this._recordOpenDiagnostic({ stage: "executor_error", ...evt })
    );
    this.tradeExecutor.on("open:success", (evt) =>
      this._recordOpenDiagnostic({ stage: "executor_success", ...evt })
    );
    this.tradeExecutor.on("open:route", (evt) =>
      this._recordOpenDiagnostic({ stage: "venue_route", ...evt })
    );
    this.tradeExecutor.on("open:blocked", (evt) =>
      this._recordOpenDiagnostic({ stage: "drift_blocked", ...evt })
    );

    // CRITICAL FIX: Listen to DriftClient's positionOpened event for maker→taker fallback
    // When maker orders fallback to taker, the position is created asynchronously in DriftClient.
    // Without this listener, the position would be missed and later classified as manual.
    if (this.driftClient) {
      this.driftClient.on("positionOpened", async (position) => {
        console.log(
          `[DRIFT_EVENT] positionOpened: ${position.market} ${position.side} @ $${position.entryPrice?.toFixed(4) || "N/A"}`
        );

        // Find and update any pending position for this market/side
        const existingIdx = this.openPositions.findIndex(
          (p) =>
            (p.market === position.market || p.marketSymbol === position.market) &&
            p.side?.toLowerCase() === position.side?.toLowerCase() &&
            (p.status === "pending" || p.execMode === "maker")
        );

        if (existingIdx >= 0) {
          // Update pending position with filled data
          const existing = this.openPositions[existingIdx];
          const wasPending = existing.status === "pending";
          const updated = {
            ...existing,
            ...position,
            status: "filled",
            trade_type: "automated",
            positionId: position.positionId || existing.positionId,
            clientOrderId: position.clientOrderId || existing.clientOrderId,
          };
          this.openPositions[existingIdx] = updated;
          console.log(
            `[DRIFT_EVENT] Updated pending → filled: ${position.market} ${position.side} (positionId: ${updated.positionId?.slice(0, 8)}...)`
          );

          // Update database
          try {
            db.updateOpen(updated.positionId, {
              trade_type: "automated",
              entry: updated.entryPrice,
              size: updated.size,
              status: "filled",
            });
          } catch (e) {
            console.warn(`[DRIFT_EVENT] DB update failed: ${e.message}`);
          }

          // CRITICAL FIX: Send Telegram FILL notification for maker orders
          // This only fires when a pending limit order gets filled
          if (wasPending && this.tg && this.tg.enabled) {
            const execMode = position.execMode || "maker";
            const execLabel = execMode === "taker" ? "TAKER FALLBACK" : "MAKER";
            this.tg
              .say(
                `✅ *FILLED ${position.side?.toUpperCase()} (${execLabel})*\n` +
                  `Market: ${position.market}\n` +
                  `Entry: $${position.entryPrice?.toFixed?.(4) ?? "N/A"}\n` +
                  `Size: $${updated.size?.toFixed?.(2) ?? "N/A"}\n` +
                  `Collateral: $${updated.collateral?.toFixed?.(2) ?? "N/A"}`
              )
              .catch((err) => {
                console.warn(`[DRIFT_EVENT] Telegram fill notification failed: ${err.message}`);
              });
          }
        } else {
          // Position was created via fallback without a pending position in openPositions
          // This can happen if the pending position was never added or was removed
          console.log(
            `[DRIFT_EVENT] New position from Drift (no pending found): ${position.market} ${position.side}`
          );

          // Mark as automated and add safely
          position.trade_type = "automated";
          position.strategyType = this.strategyFactory.getStrategyType(position.market);

          if (this._addPositionSafely(position)) {
            console.log(
              `[DRIFT_EVENT] Added position to tracking: ${position.positionId?.slice(0, 8)}...`
            );

            // Log to database
            try {
              db.logOpen({
                ...position,
                mode: this.liveMode ? "live" : "paper",
                trade_type: "automated",
                environment: this.environment,
                instance_id: this.instanceId,
              });
            } catch (e) {
              console.warn(`[DRIFT_EVENT] Failed to log to DB: ${e.message}`);
            }

            // Send Telegram notification for new position (typically from taker fallback)
            if (this.tg && this.tg.enabled) {
              const execMode = position.execMode || "taker";
              const execLabel = execMode === "maker" ? "MAKER" : "TAKER";
              this.tg
                .say(
                  `✅ *OPEN ${position.side?.toUpperCase()} (${execLabel})*\n` +
                    `Market: ${position.market}\n` +
                    `Entry: $${position.entryPrice?.toFixed?.(4) ?? "N/A"}\n` +
                    `Size: $${position.size?.toFixed?.(2) ?? "N/A"}\n` +
                    `Collateral: $${position.collateral?.toFixed?.(2) ?? "N/A"}`
                )
                .catch((err) => {
                  console.warn(
                    `[DRIFT_EVENT] Telegram position notification failed: ${err.message}`
                  );
                });
            }
          }
        }
      });

      // Also listen for positionClosed events from DriftClient
      // Drift emits positionClosed for BOTH bot-initiated and external closures.
      // We only finalize/notify here for maker-exit lifecycle closes (closePosition returned early).
      // For taker closes handled by closePosition(), skip to avoid double accounting/notifications.
      this.driftClient.on("positionClosed", (evt) => {
        try {
          const pnl = evt.pnl;
          const market = evt.market || evt.position?.market;
          const posId = evt.positionId || evt.position?.positionId;
          console.log(
            `[DRIFT_EVENT] positionClosed: ${market} (pnl: $${pnl?.toFixed?.(2) || "N/A"})`
          );

          const existingPos = this.openPositions.find(
            (p) =>
              p.positionId === posId ||
              (market &&
                p.market === market &&
                (p.venue === "drift" || p.marketIndex !== undefined))
          );

          // If this was a maker-exit flow (exitOrderPlaced was emitted), finalize here to produce summary + DB updates.
          if (posId && this._pendingDriftCloseByPositionId.has(posId) && existingPos) {
            const pending = this._pendingDriftCloseByPositionId.get(posId);
            this._pendingDriftCloseByPositionId.delete(posId);
            const normalizedEvt =
              pending && !evt.exitReason
                ? { ...evt, exitReason: pending.exitReason || evt.exitReason }
                : evt;
            this._finalizeClosedPositionFromDriftEvent(existingPos, normalizedEvt).catch((e) => {
              console.error(
                `[DRIFT_EVENT] Failed to finalize maker close for ${posId}: ${e.message}`
              );
            });
            return;
          }

          // If bot recently initiated a close for this positionId, closePosition() will handle accounting/notifications.
          if (posId) {
            const key = this._actionKey("close", { id: posId });
            if (this._dup(key)) {
              return;
            }
          }

          // External close fallback: remove from tracking and update realized PnL if provided.
          if (existingPos) {
            if (typeof pnl === "number" && Number.isFinite(pnl)) {
              this._driftRealizedPnL = (this._driftRealizedPnL || 0) + pnl;
              this._automatedRealizedPnL = (this._automatedRealizedPnL || 0) + pnl;
              console.log(
                `[CAPITAL] Drift position closed (external): PnL $${pnl.toFixed(2)}, Drift pool: $${this._driftRealizedPnL.toFixed(2)}`
              );
            }
            const idx = this.openPositions.indexOf(existingPos);
            if (idx >= 0) {
              this.openPositions.splice(idx, 1);
              console.log(
                `[DRIFT_EVENT] Removed externally-closed position from tracking: ${posId?.slice(0, 8) || market}`
              );
            }
          }
        } catch (e) {
          console.error(`[DRIFT_EVENT] positionClosed handler error: ${e.message}`);
        }
      });

      // CRITICAL FIX: Listen for phantomPositionRemoved events from DriftClient
      // This fires when trying to close a position that no longer exists on-chain
      // We need to clean up ALL matching positions in openPositions (handles duplicates)
      this.driftClient.on("phantomPositionRemoved", (evt) => {
        const { market, marketIndex, positionId, side, reason } = evt;
        console.log(`[DRIFT_EVENT] phantomPositionRemoved: ${market} ${side} (reason: ${reason})`);

        // CRITICAL: Add to phantom markets map to prevent sync from re-adding
        // Use market+side+venue as key to allow same market with different side
        // NOTE: Default to 'long' to match _addPositionSafely's default for consistency
        const phantomKey = `${market}:${(side || "long").toLowerCase()}:drift`;
        this._phantomMarkets.set(phantomKey, Date.now());
        console.log(
          `[DRIFT_EVENT] Added ${phantomKey} to phantom markets (grace period: ${this._PHANTOM_GRACE_PERIOD_MS / 1000}s)`
        );

        // Remove ALL positions matching this market+venue (clean up duplicates)
        const beforeCount = this.openPositions.length;
        this.openPositions = this.openPositions.filter((p) => {
          const isMatch =
            p.positionId === positionId ||
            (p.market === market && (p.venue === "drift" || p.marketIndex === marketIndex));
          if (isMatch) {
            console.log(
              `[DRIFT_EVENT] Removing phantom position from tracking: ${p.positionId?.slice(0, 12) || "unknown"} (${p.market})`
            );
          }
          return !isMatch;
        });
        const removed = beforeCount - this.openPositions.length;
        if (removed > 0) {
          console.log(`[DRIFT_EVENT] Cleaned up ${removed} phantom position(s) for ${market}`);
        }
      });

      // Listen for exitOrderPlaced events from DriftClient (maker mode exits)
      // This sends an intermediate notification when the exit limit order is placed
      // (similar to entry flow), before the order fills
      this.driftClient.on("exitOrderPlaced", (evt) => {
        const { position, limitPrice, market, side, orderId, execMode, exitReason } = evt;
        console.log(
          `[DRIFT_EVENT] exitOrderPlaced: ${market} ${side} @ $${limitPrice?.toFixed(4) || "N/A"} (${execMode})`
        );

        const posId = position?.positionId;
        if (posId) {
          const existing = this._pendingDriftCloseByPositionId.get(posId);
          const now = Date.now();
          if (existing && now - (existing.notifiedAt || existing.startedAt || 0) < 60_000) {
            // Dedup intermediate notifications under double-emission/reregistration scenarios.
            return;
          }
          this._pendingDriftCloseByPositionId.set(posId, {
            startedAt: existing?.startedAt || now,
            market: market || position?.market,
            exitReason: exitReason || existing?.exitReason || null,
            notifiedAt: now,
          });
        }

        // Send intermediate Telegram notification
        if (this.tg && this.tg.enabled) {
          const intermediateMsg =
            `📤 *EXIT ORDER PLACED*\n` +
            `Market: ${market}\n` +
            `Side: ${side.toUpperCase()}\n` +
            `Entry: $${position.entryPrice?.toFixed(4) || "N/A"}\n` +
            `Target Exit: $${limitPrice?.toFixed(4) || "N/A"}\n` +
            `Mode: Maker (limit order)\n` +
            `Status: Waiting for fill...`;
          this.tg.say(intermediateMsg).catch((err) => {
            console.error(`[DRIFT_EVENT] Failed to send exit order placed notification:`, err);
          });
        }
      });

      console.log("[DRIFT_EVENT] Registered event listeners for DriftClient position events");
    }

    console.log(
      `[VenueAwareTradeExecutor] Initialized: jupiter=${!!this.jupiterClient} drift=${!!this.driftClient}`
    );

    // Journaling
    try {
      journal.init();
    } catch {}

    // Runtime - capital now loaded from strategy env files
    // Uses STARTING_BALANCE_USD or PAPER_BALANCE from strategy-specific config
    const startingBalance = Number(config.startingBalanceUsd || config.paperBalance || 1000);
    this.paperBalance = startingBalance;
    this.initialPaperBalance = startingBalance; // Store initial balance for non-compounding mode
    // Live mode capital tracking
    this.liveBalance = this.liveMode ? startingBalance : null;
    this.initialLiveBalance = this.liveMode ? startingBalance : null; // Store initial balance for non-compounding mode in live
    const copyStartingBalance = Number(
      config.startingBalanceCopy || config.paperBalanceCopy || startingBalance
    );
    this.paperBalanceCopy = copyStartingBalance;
    this.initialPaperBalanceCopy = copyStartingBalance;
    this.liveBalanceCopy = this.liveMode ? copyStartingBalance : null;
    this.initialLiveBalanceCopy = this.liveMode ? copyStartingBalance : null;

    // Track realized PnL from AUTOMATED trades only (for compounding)
    // This is updated when automated positions close, NOT from wallet balance
    this._automatedRealizedPnL = 0;

    // Per-venue PnL tracking for proper capital pool management
    // Each pool (Jupiter/majors, Drift/alts) should track its own realized PnL
    this._jupiterRealizedPnL = 0;
    this._driftRealizedPnL = 0;
    this._copyRealizedPnL = 0;

    this.openPositions = [];
    // Track recovered positions to skip time-based exits (openTime may be inaccurate)
    this._recoveredPositionIds = new Set();
    // CRITICAL FIX: Track phantom markets to prevent sync from re-adding them
    // Key: market+side, Value: timestamp when phantom was detected
    // Entries older than PHANTOM_GRACE_PERIOD_MS (5 min) are cleaned up
    this._phantomMarkets = new Map();
    this._PHANTOM_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
    this.dailyTrades = 0;
    // Track UTC day for automatic daily trade counter reset
    this._dailyKey = new Date().toISOString().slice(0, 10);
    this._copyDailyKey = this._dailyKey;
    this._copyDailyLossUsd = 0;
    this._copyDailyBaseline = this._getCopyPoolEquity();
    this._copyDailyLossStopTriggered = false;

    // Multi-market price tracking
    this._lastPrices = new Map(); // Map<market, {price, volume, volumeMeta, ...}>
    this._lastVolumeSnapshot = new Map(); // Map<market, { openTime, baseVolume, quoteVolume }>
    // For backward compatibility, keep single price vars pointing to first market
    this._lastPrice = null;
    this._lastVolume = null;
    this._lastPriceFetchMeta = null;

    this._ticks = 0;
    this._lastTickTimestamp = null;
    this.paused = false;
    this._recentActions = new Map();
    this._recentActionsTtlMs = Math.max(5000, Number(process.env.RECENT_ACTIONS_TTL_MS) || 60000);
    this._maxRecentActions = Math.max(100, Number(process.env.RECENT_ACTIONS_MAX) || 500);
    this._pendingDriftCloseByPositionId = new Map(); // positionId -> { startedAt, market, exitReason, notifiedAt }
    this._finalizedCloseByPositionId = new Map(); // positionId -> ts
    this._finalizedCloseDedupMs = Math.max(
      30000,
      Number(process.env.POSITION_CLOSE_DEDUP_MS) || 5 * 60 * 1000
    );
    this._healthCheckInterval = null;
    this._tickInterval = null;
    this._copyTrackerHealthInterval = null;
    this._copyTrackerLastAlertAt = 0;
    this._copyTrackerHealthDegraded = false;
    this._volumeFallbackCount = 0;
    this._volumeFallbackAlerted = false;
    this._openDiagnostics = [];
    this._maxOpenDiagnostics = 50;

    this._tickInflight = new Map(); // Now per-market: Map<market, timestamp>
    this._pendingTickReplay = new Map(); // Now per-market: Map<market, boolean>

    // Mark price feed removed - not needed (API returns 404, bot works fine with regular price)
    // this.markPriceFeed = new MarkPriceFeed({
    //   apiUrl: process.env.JUPITER_PERPS_API_URL,
    // });

    // Config is now read-only from env/defaults (single source of truth)

    // UI handlers
    ui.setHandlers({
      pause: () => this.pause(),
      resume: () => this.resume(),
      closeAll: () => this.closeAll("ui"),
      closePosition: async (positionId) => {
        const position = this.openPositions.find((p) => p.positionId === positionId);
        if (!position) {
          throw new Error(`Position ${positionId} not found`);
        }
        const market = position.market || MARKET;
        const priceData = this._lastPrices.get(market);
        const price = priceData?.price || this._lastPrice || position.entryPrice;
        await this.closePosition(position, price, "ui_manual");
      },
      status: () => this.statusSnapshot(),
      getConfig: () => this.getConfigSnapshot(),
      updateConfig: (config) => this.updateConfig(config),
    });

    pretty("starting");
    log("bot_start", {
      mode: this.liveMode ? "live" : "paper",
      exec_mode: EXEC_MODE,
      market: MARKET, // Backward compatibility
      markets: MARKETS,
      marketsCount: MARKETS.length,
      strategy: "enhanced",
    });
  }

  // ---------- Helpers ----------
  _parseEnvBoolean(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    return null;
  }

  _getCopyStrategyEnv() {
    if (strategyEnvManager?.getEnvForStrategy) {
      return strategyEnvManager.getEnvForStrategy("copy-trading") || process.env;
    }
    return process.env;
  }

  _getCopyPoolEquity() {
    const availableCapital = this.getAvailableCapital({
      provider: "copy-trading",
      strategyType: "copy-trading",
    });
    const copyLocked = this._getAutomatedPositions()
      .filter((position) => position.strategyType === "copy-trading")
      .reduce((sum, position) => sum + (position.collateral || 0), 0);
    return availableCapital + copyLocked;
  }

  _resetCopyDailyLossIfNeeded(nowMs = Date.now()) {
    const dailyKey = new Date(nowMs).toISOString().slice(0, 10);
    if (this._copyDailyKey !== dailyKey) {
      this._copyDailyKey = dailyKey;
      this._copyDailyLossUsd = 0;
      this._copyDailyBaseline = this._getCopyPoolEquity();
      this._copyDailyLossStopTriggered = false;
    }
  }

  _getCopyDailyLossConfig() {
    const env = this._getCopyStrategyEnv();
    const rawPercent = env.COPY_DAILY_LOSS_STOP_PERCENT;
    const percentValue = Number(rawPercent);
    if (!Number.isFinite(percentValue) || percentValue <= 0) {
      return { enabled: false, percent: 0, maxLossUsd: 0, baseline: 0 };
    }
    const baseline =
      Number.isFinite(this._copyDailyBaseline) && this._copyDailyBaseline > 0
        ? this._copyDailyBaseline
        : this._getCopyPoolEquity();
    const maxLossUsd = baseline * (percentValue / 100);
    return {
      enabled: Number.isFinite(maxLossUsd) && maxLossUsd > 0,
      percent: percentValue,
      maxLossUsd,
      baseline,
    };
  }

  _getCopyTrackerHealthConfig() {
    const env = this._getCopyStrategyEnv();
    const parseNumber = (value, fallback) => {
      if (value === undefined || value === null || value === "") return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const checkIntervalMs = Math.max(15_000, parseNumber(env.COPY_WS_HEALTH_CHECK_MS, 60_000));
    const alertStalePct = Math.max(0, Math.min(1, parseNumber(env.COPY_WS_ALERT_STALE_PCT, 0.4)));
    const alertMissingPct = Math.max(
      0,
      Math.min(1, parseNumber(env.COPY_WS_ALERT_MISSING_PCT, 0.2))
    );
    const minTopK = Math.max(
      1,
      parseNumber(
        env.COPY_WS_ALERT_MIN_TOPK,
        parseNumber(env.COPY_ENGINE_MIN_LEADERS, parseNumber(env.COPY_MIN_LEADERS, 3))
      )
    );
    const alertCooldownMs = Math.max(
      60_000,
      parseNumber(env.COPY_WS_ALERT_COOLDOWN_MS, 15 * 60_000)
    );

    return {
      checkIntervalMs,
      alertStalePct,
      alertMissingPct,
      minTopK,
      alertCooldownMs,
    };
  }

  _checkCopyTrackerHealth(provider, healthConfig) {
    if (!provider || typeof provider.getTrackerSummary !== "function") return;
    const summary = provider.getTrackerSummary();
    if (!summary) return;

    const topKCount = Number(summary.topK) || 0;
    const staleCount = Number(summary.stale) || 0;
    const missingCount = Number(summary.missing) || 0;
    const activeCount = Number(summary.active) || 0;
    const wsConnected = summary.wsConnected === true;
    const stalePct = topKCount > 0 ? staleCount / topKCount : 1;
    const missingPct = topKCount > 0 ? missingCount / topKCount : 1;
    const belowMinTopK = topKCount < healthConfig.minTopK;

    const degraded =
      !wsConnected ||
      belowMinTopK ||
      stalePct >= healthConfig.alertStalePct ||
      missingPct >= healthConfig.alertMissingPct;

    if (degraded) {
      const nowMs = Date.now();
      const lastAlertAt = this._copyTrackerLastAlertAt || 0;
      const shouldAlert =
        !this._copyTrackerHealthDegraded || nowMs - lastAlertAt >= healthConfig.alertCooldownMs;

      if (shouldAlert) {
        this._copyTrackerLastAlertAt = nowMs;
        const details = {
          topK: topKCount,
          active: activeCount,
          stale: staleCount,
          missing: missingCount,
          wsConnected,
          stalePct: Number((stalePct * 100).toFixed(2)),
          missingPct: Number((missingPct * 100).toFixed(2)),
          staleThresholdPct: Number((healthConfig.alertStalePct * 100).toFixed(2)),
          missingThresholdPct: Number((healthConfig.alertMissingPct * 100).toFixed(2)),
          minTopK: healthConfig.minTopK,
          reason: !wsConnected
            ? "ws_disconnected"
            : belowMinTopK
              ? "topk_below_min"
              : stalePct >= healthConfig.alertStalePct
                ? "stale_pct"
                : "missing_pct",
        };

        console.warn("[COPY_TRACKER] WS health degraded", details);
        if (this.tg && this.tg.enabled) {
          this.tg.alertRiskViolation("copy_ws_health", details).catch(() => {});
        }
      }
      this._copyTrackerHealthDegraded = true;
    } else if (this._copyTrackerHealthDegraded) {
      this._copyTrackerHealthDegraded = false;
      console.log("[COPY_TRACKER] WS health recovered", {
        topK: topKCount,
        active: activeCount,
        stale: staleCount,
        missing: missingCount,
        wsConnected,
      });
    }
  }

  _startCopyTrackerHealthChecks() {
    if (!this.strategyFactory || typeof this.strategyFactory.getEnabledStrategies !== "function") {
      return;
    }
    const enabledStrategies = this.strategyFactory.getEnabledStrategies();
    if (!enabledStrategies.includes("copy-trading")) return;

    const provider =
      typeof this.strategyFactory.getCopyTradingProvider === "function"
        ? this.strategyFactory.getCopyTradingProvider()
        : null;

    if (!provider || typeof provider.getTrackerSummary !== "function") {
      console.warn("[COPY_TRACKER] Health checks skipped (no consensus provider)");
      return;
    }

    const healthConfig = this._getCopyTrackerHealthConfig();
    if (this._copyTrackerHealthInterval) {
      clearInterval(this._copyTrackerHealthInterval);
    }
    this._copyTrackerHealthInterval = setInterval(() => {
      this._checkCopyTrackerHealth(provider, healthConfig);
    }, healthConfig.checkIntervalMs);
    this._checkCopyTrackerHealth(provider, healthConfig);
  }

  _resolveTradingIntervalForMarket(market) {
    if (!this._perMarketIntervalsEnabled) return this.tradingInterval;
    if (!strategyEnvManager?.getMarketConfig) return this.tradingInterval;
    const raw = strategyEnvManager.getMarketConfig(
      market,
      "TRADING_INTERVAL",
      this.tradingInterval
    );
    return String(raw || this.tradingInterval)
      .trim()
      .toLowerCase();
  }

  _resolveVolumeIntervalForMarket(market) {
    // In multi-strategy mode, avoid global process.env bleed by resolving from the
    // isolated env snapshot for the owning strategy/market.
    const fallback = this._perMarketIntervalsEnabled
      ? this._marketIntervals?.get(market) || this.tradingInterval || "5m"
      : process.env.VOLUME_INTERVAL || this.tradingInterval || "1m";

    if (!this.multiStrategyMode || !strategyEnvManager?.getMarketConfig) {
      return String(fallback).trim().toLowerCase();
    }

    const raw = strategyEnvManager.getMarketConfig(market, "VOLUME_INTERVAL", fallback);
    return String(raw || fallback)
      .trim()
      .toLowerCase();
  }

  _resolveLeverageConfig(strategyType, market) {
    const base = config.leverage || {};
    if (!strategyEnvManager?.getEnvForMarket || !this._isCopyStrategy(strategyType) || !market) {
      return base;
    }
    const env = strategyEnvManager.getEnvForMarket(market, strategyType) || {};
    const num = (v, fallback) => {
      if (v === undefined || v === null || v === "") return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const bool = (v, fallback) => {
      const parsed = this._parseEnvBoolean(v);
      return parsed === null ? fallback : parsed;
    };

    return {
      ...base,
      dynamic: bool(env.COPY_DYNAMIC_LEVERAGE, base.dynamic !== false),
      leverageMode: String(env.COPY_LEVERAGE_MODE || "fixed")
        .trim()
        .toLowerCase(),
      baseLeverage: num(env.COPY_LEVERAGE_BASE, base.baseLeverage),
      minLeverage: num(env.COPY_LEVERAGE_MIN, base.minLeverage),
      maxLeverage: num(env.COPY_LEVERAGE_MAX, base.maxLeverage),
      long: num(env.COPY_LEVERAGE_LONG, base.long),
      short: num(env.COPY_LEVERAGE_SHORT, base.short),
      volatilityAdjustment: bool(env.COPY_LEVERAGE_VOLATILITY_ADJ, base.volatilityAdjustment),
      adxAdjustment: bool(env.COPY_LEVERAGE_ADX_ADJ, base.adxAdjustment),
      confidenceAdjustment: bool(env.COPY_LEVERAGE_CONFIDENCE_ADJ, base.confidenceAdjustment),
      portfolioRiskAdjustment: bool(env.COPY_LEVERAGE_PORTFOLIO_ADJ, base.portfolioRiskAdjustment),
      fundingAdjustment: bool(env.COPY_LEVERAGE_FUNDING_ADJ, base.fundingAdjustment),
      drawdownProtection: bool(env.COPY_LEVERAGE_DRAWDOWN_PROT, base.drawdownProtection),
      useKelly: bool(env.COPY_LEVERAGE_USE_KELLY, base.useKelly),
    };
  }

  _getStrategyInstanceForMarket(market, strategyType) {
    const entry = this.strategies.get(market);
    if (Array.isArray(entry)) {
      const match = entry.find((s) => s.type === strategyType);
      return match?.strategy || entry[0]?.strategy || null;
    }
    return entry || null;
  }

  _getCopyLeaderLeverage(signal) {
    if (!signal || typeof signal !== "object") return null;
    const direct = Number(signal.leaderLeverage);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const metaLev = Number(signal?.consensus?.meta?.leaderLeverage);
    if (Number.isFinite(metaLev) && metaLev > 0) return metaLev;
    return null;
  }

  /**
   * Parse interval string to milliseconds
   * @param {string} interval - Interval string (e.g., '5m', '15m', '1h', '4h', '1d')
   * @returns {number} Interval in milliseconds
   */
  _parseIntervalToMs(interval) {
    const str = String(interval).trim().toLowerCase();
    if (str.endsWith("ms")) return Number(str.slice(0, -2));
    if (str.endsWith("s")) return Number(str.slice(0, -1)) * 1000;
    if (str.endsWith("m")) return Number(str.slice(0, -1)) * 60_000;
    if (str.endsWith("h")) return Number(str.slice(0, -1)) * 3_600_000;
    if (str.endsWith("d")) return Number(str.slice(0, -1)) * 86_400_000;
    // Default to 5 minutes if unparseable
    console.warn(`[BOT] Could not parse interval '${interval}', defaulting to 5m`);
    return 5 * 60_000;
  }

  _detectEnvironment() {
    // Check BOT_ENVIRONMENT env var first
    if (process.env.BOT_ENVIRONMENT) {
      return String(process.env.BOT_ENVIRONMENT).toLowerCase().trim();
    }

    // Respect explicit render flags even if other indicators exist
    const renderFlag = this._parseEnvBoolean(process.env.RENDER);
    if (renderFlag === true) return "render";
    if (renderFlag === false) return "local";

    const isRenderFlag = this._parseEnvBoolean(process.env.IS_RENDER);
    if (isRenderFlag === true) return "render";
    if (isRenderFlag === false) return "local";

    // Render-specific hints (only used if no explicit flag set to false)
    const renderIndicators = [
      String(process.env.RENDER || "")
        .trim()
        .toLowerCase() === "render",
      process.env.RENDER_MCP_API_KEY,
      process.env.RENDER_URL,
      process.env.UI_SERVER_URL && process.env.UI_SERVER_URL.includes("onrender.com"),
    ];

    if (renderIndicators.some(Boolean)) {
      return "render";
    }

    // Default to local
    return "local";
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }

  /**
   * Calculate liquidation price for a position
   * @param {number} entryPrice - Entry price
   * @param {number} leverage - Leverage
   * @param {string} side - 'long' or 'short'
   * @returns {number} Liquidation price
   */
  _calculateLiquidationPrice(entryPrice, leverage, side) {
    const m = 1 / Math.max(1, leverage);
    const d = entryPrice * m;
    return side?.toLowerCase() === "long" ? Math.max(0.0001, entryPrice - d) : entryPrice + d;
  }

  _isCopyStrategy(strategyType) {
    return String(strategyType || "").toLowerCase() === "copy-trading";
  }

  _getPaperBalanceForStrategy(strategyType) {
    return this._isCopyStrategy(strategyType) ? this.paperBalanceCopy : this.paperBalance;
  }

  _setPaperBalanceForStrategy(strategyType, value) {
    if (this._isCopyStrategy(strategyType)) {
      this.paperBalanceCopy = value;
    } else {
      this.paperBalance = value;
    }
  }

  _getLiveBalanceForStrategy(strategyType) {
    return this._isCopyStrategy(strategyType) ? this.liveBalanceCopy : this.liveBalance;
  }

  _setLiveBalanceForStrategy(strategyType, value) {
    if (this._isCopyStrategy(strategyType)) {
      this.liveBalanceCopy = value;
    } else {
      this.liveBalance = value;
    }
  }

  // Get available capital based on bot's CONFIGURED allocation only.
  /**
   * Get the capital pool allocation for a specific venue
   * CRITICAL: Jupiter and Drift have SEPARATE capital pools from different env variables:
   *   - Jupiter (majors): STARTING_BALANCE_USD / PAPER_BALANCE
   *   - Drift (alts): PAPER_BALANCE_ALTS (always use this for Drift, it's venue-specific)
   *
   * For live mode (TRADING_MODE=live): Use STARTING_BALANCE_USD for Jupiter, PAPER_BALANCE_ALTS for Drift
   * For paper mode: Use PAPER_BALANCE for Jupiter, PAPER_BALANCE_ALTS for Drift
   */
  _getCapitalPoolAllocation(venue, strategyType = null) {
    if (venue === "copy-trading" || this._isCopyStrategy(strategyType)) {
      if (this.liveMode) {
        return Number(
          this.config.startingBalanceCopy ||
            this.config.paperBalanceCopy ||
            this.config.paperBalance ||
            1000
        );
      }
      return Number(
        this.config.paperBalanceCopy ||
          this.config.startingBalanceCopy ||
          this.config.paperBalance ||
          1000
      );
    }
    if (venue === "drift") {
      // Drift ALWAYS uses PAPER_BALANCE_ALTS - this is the Drift-specific env variable
      // The naming is historical but it's the authoritative source for Drift capital
      return Number(this.config.paperBalanceAlts || 1000);
    } else if (venue === "jupiter") {
      // Jupiter uses the main balance variables
      // Live mode: STARTING_BALANCE_USD, Paper mode: PAPER_BALANCE
      if (this.liveMode) {
        return Number(this.config.startingBalanceUsd || this.config.paperBalance || 1000);
      } else {
        return Number(this.config.paperBalance || this.config.startingBalanceUsd || 1000);
      }
    } else {
      // Combined/legacy: use main balance
      return Number(this.config.startingBalanceUsd || this.config.paperBalance || 1000);
    }
  }

  // SECURITY: Never reads actual wallet balance - uses fixed allocation from config.
  // CRITICAL: Manual positions MUST be accounted for when calculating available capital
  // because on-chain balance includes ALL positions (automated + manual).
  // Not accounting for manual positions leads to InsufficientCollateral errors.
  //
  // Provider-aware capital pools:
  //   - 'jupiter' (majors): uses startingBalanceUsd / paperBalance
  //   - 'drift' (alts): uses paperBalanceAlts (ALWAYS - this is Drift-specific)
  //   - null/undefined: returns combined (legacy behavior for backwards compat)
  getAvailableCapital(providerOrMarket, strategyType = null) {
    const venueRouter = require("./utils/venue-router");

    // Determine provider from market if a market string is passed
    let provider = providerOrMarket;
    let market = null;
    if (providerOrMarket && typeof providerOrMarket === "object") {
      market = providerOrMarket.market || null;
      strategyType = providerOrMarket.strategyType || strategyType;
      provider = providerOrMarket.provider || market || providerOrMarket;
    }
    if (provider && typeof provider === "string" && provider.includes("-PERP")) {
      market = provider;
      provider = venueRouter.getVenueForMarket(provider);
    }
    if (this._isCopyStrategy(strategyType)) {
      provider = "copy-trading";
    }

    // Get the bot's configured capital allocation based on provider
    // CRITICAL: Uses _getCapitalPoolAllocation() for consistent venue-specific pools
    const botAllocation = this._getCapitalPoolAllocation(provider, strategyType);

    // Calculate collateral locked in AUTOMATED positions
    const automatedPositions = this._getAutomatedPositions();

    // Filter automated positions by provider if specified
    let relevantAutomatedPositions = automatedPositions;
    if (provider === "copy-trading") {
      relevantAutomatedPositions = automatedPositions.filter(
        (pos) => pos.strategyType === "copy-trading"
      );
    } else if (provider === "drift" || provider === "jupiter") {
      relevantAutomatedPositions = automatedPositions.filter(
        (pos) =>
          venueRouter.getVenueForMarket(pos.market) === provider &&
          pos.strategyType !== "copy-trading"
      );
    }

    const automatedLockedCapital = relevantAutomatedPositions.reduce(
      (sum, pos) => sum + (pos.collateral || 0),
      0
    );

    // CRITICAL FIX: Also account for manual positions' collateral
    // Manual positions consume on-chain collateral, so they must be deducted from available capital
    // to prevent InsufficientCollateral errors when opening new positions
    //
    // SAFETY: This relies on correct position classification via _isManualPosition().
    // The recovery/sync code (recoverPositions() and _syncPositionsFromChain()) has extensive
    // protections to ensure automated positions are NEVER downgraded to manual:
    // - Checks existing position status before classification
    // - Preserves automated status if position has bot clientOrderId pattern
    // - Uses DB trade_type as source of truth
    // - Never downgrades from automated to manual (only upgrades manual to automated)
    // This ensures automated positions remain correctly classified and are NOT counted as manual.
    const manualPositions = this.openPositions.filter((pos) => this._isManualPosition(pos));

    // Filter manual positions by provider if specified
    let relevantManualPositions = manualPositions;
    if (provider === "copy-trading") {
      relevantManualPositions = manualPositions.filter(
        (pos) => pos.strategyType === "copy-trading"
      );
    } else if (provider === "drift" || provider === "jupiter") {
      relevantManualPositions = manualPositions.filter(
        (pos) => venueRouter.getVenueForMarket(pos.market) === provider
      );
    }

    const manualLockedCapital = relevantManualPositions.reduce(
      (sum, pos) => sum + (pos.collateral || 0),
      0
    );

    // Available capital = bot allocation - (automated locked capital + manual locked capital)
    // Both automated and manual positions consume on-chain collateral
    let available = botAllocation - automatedLockedCapital - manualLockedCapital;

    // If compounding is enabled, add realized PnL from closed AUTOMATED trades only
    // Per-pool PnL tracking: each venue has its own realized PnL pool
    const enableCompounding = this.config?.risk?.enableCompounding === true;
    if (enableCompounding) {
      if (provider === "copy-trading" && typeof this._copyRealizedPnL === "number") {
        available += this._copyRealizedPnL;
      } else if (provider === "drift" && typeof this._driftRealizedPnL === "number") {
        available += this._driftRealizedPnL;
      } else if (provider === "jupiter" && typeof this._jupiterRealizedPnL === "number") {
        available += this._jupiterRealizedPnL;
      } else if (!provider && typeof this._automatedRealizedPnL === "number") {
        // Legacy/combined: use total PnL for backwards compat
        available += this._automatedRealizedPnL;
      }
    }

    return Math.max(0, available);
  }

  /**
   * Helper to determine if a position is manual
   * This must be consistent with _isBotOpenedPosition() logic
   */
  _isManualPosition(pos) {
    if (!pos) return false;

    // Source of truth: explicit trade_type (when present).
    // NOTE: clientOrderId patterns are fallbacks only; they must NOT override trade_type,
    // because some automated trades may use non-hash clientOrderId formats (legacy / custom).
    if (pos.trade_type === "manual") return true;
    if (pos.trade_type === "automated" || pos.trade_type === "auto" || pos.trade_type === "bot")
      return false;
    // Backwards compatibility
    if (pos.mode === "manual") return true;

    // Check clientOrderId patterns
    const clientOrderId = pos.clientOrderId;
    if (clientOrderId) {
      // Manual patterns
      if (clientOrderId.startsWith("manual-")) return true;
      // timestamp_* is used by some recovery/sync flows, but can also appear on automated rows.
      // Only treat as manual when we *don't* have trade_type information.
      if (/^\d{13,}_/.test(clientOrderId)) return true; // timestamp_positionId format (synced/unknown positions)

      // Bot-opened: 48-char hex hash - NOT manual
      if (/^[a-f0-9]{48}$/i.test(clientOrderId)) return false;
    }

    // If we can't determine from in-memory state, check database
    try {
      const dbPositions = db.listOpen();
      const dbPos = dbPositions.find((p) => p.id === pos.positionId);
      if (dbPos) {
        const t = String(dbPos.trade_type || "").toLowerCase();
        if (t === "manual") return true;
        if (t === "automated" || t === "auto" || t === "bot") return false;
      }
    } catch (e) {
      // Ignore DB errors - default to treating as manual (safer for risk)
    }

    // Default to true (safer to NOT count unknown positions in portfolio risk)
    // This prevents the bot from over-leveraging due to unclassified external positions
    return true;
  }

  /**
   * Get automated positions only (exclude manual positions from portfolio risk calculations)
   */
  _getAutomatedPositions() {
    return this.openPositions.filter((pos) => !this._isManualPosition(pos));
  }

  /**
   * Calculate locked capital (collateral currently used in ALL open positions)
   * This includes both automated and manual positions - used for display purposes
   */
  getLockedCapital() {
    return this.openPositions.reduce((sum, pos) => {
      return sum + (pos.collateral || 0);
    }, 0);
  }

  /**
   * Calculate locked capital for AUTOMATED positions only
   * Manual positions don't count against the bot's capital allocation
   */
  getAutomatedLockedCapital() {
    const automatedPositions = this._getAutomatedPositions();
    return automatedPositions.reduce((sum, pos) => sum + (pos.collateral || 0), 0);
  }

  /**
   * Get free capital (capital available for new positions)
   * Based on bot's allocation minus automated positions only
   * Manual positions don't reduce the bot's trading budget
   * CRITICAL: Never return negative values - free capital cannot be negative
   */
  getFreeCapital() {
    const available = this.getAvailableCapital(); // Bot allocation minus automated locked
    return Math.max(0, available); // Ensure never negative
  }

  /**
   * Get total equity for the BOT's trading allocation
   * This equals free capital + automated locked capital (excludes manual positions)
   * Note: This does NOT include unrealized PnL (which is correct - unrealized gains
   * cannot be used for new positions as they're already utilized in existing positions)
   */
  getTotalEquity() {
    return this.getFreeCapital() + this.getAutomatedLockedCapital();
  }

  /**
   * Get total wallet equity (all positions, including manual)
   * Used for display purposes only, not for trading decisions
   */
  getTotalWalletEquity() {
    const currentBalance = this.liveMode
      ? (this.liveBalance ?? this.initialLiveBalance ?? 0)
      : (this.paperBalance ?? this.initialPaperBalance ?? 0);
    return currentBalance + this.getLockedCapital();
  }

  getConfigSnapshot() {
    // Return current config state for UI (read-only from env/defaults)
    return {
      paperTradingMode: this.liveMode ? false : true,
      executionMode: EXEC_MODE,
      markets: MARKETS,
      risk: {
        sizingMethod: config.risk.sizingMethod,
        forceSizingMethod: config.risk.forceSizingMethod,
        positionSizePercent: config.risk.positionSizePercent,
        riskPerTradePercent: config.risk.riskPerTradePercent,
        maxPositionSize: config.risk.maxPositionSize,
        takeProfitPercent: config.risk.takeProfitPercent,
        stopLossPercent: config.risk.stopLossPercent,
        trailingStopPercent: config.risk.trailingStopPercent,
        useTrailingStop: config.risk.useTrailingStop,
        maxFundingRatePercent: config.risk.maxFundingRatePercent,
        maxPositionHours: config.risk.maxPositionHours,
        maxTotalLeverage: config.risk.maxTotalLeverage,
        maxTotalExposure: config.risk.maxTotalExposure,
        maxPositions: config.risk.maxPositions,
        enableCompounding: config.risk.enableCompounding,
      },
      leverage: {
        dynamic: config.leverage.dynamic !== false,
        baseLeverage: config.leverage.baseLeverage,
        minLeverage: config.leverage.minLeverage || 1,
        // Use config value if explicitly set (even if 0), otherwise use default
        // This ensures LEVERAGE_MAX env var is respected
        maxLeverage:
          config.leverage.maxLeverage !== undefined && config.leverage.maxLeverage !== null
            ? config.leverage.maxLeverage
            : 5,
        volatilityAdjustment: config.leverage.volatilityAdjustment !== false,
        adxAdjustment: config.leverage.adxAdjustment !== false,
        confidenceAdjustment: config.leverage.confidenceAdjustment !== false,
        portfolioRiskAdjustment: config.leverage.portfolioRiskAdjustment !== false,
        fundingAdjustment: config.leverage.fundingAdjustment !== false,
        drawdownProtection: config.leverage.drawdownProtection !== false,
      },
      strategy: {
        name: process.env.STRATEGY_TYPE || "momentum",
        enabled: this.strategyEnabled !== false,
        entryThreshold: this.strategy?.entryThreshold,
        exitThreshold: this.strategy?.exitThreshold,
      },
      telegram: {
        enabled: !!(process.env.TELEGRAM_BOT_TOKEN && this.tg),
        botToken: process.env.TELEGRAM_BOT_TOKEN ? "***" : null, // Masked for security
      },
      botLoopMs: LOOP_MS,
      dailyTradeLimit: DAILY_TRADE_LIMIT,
      maxOpenPositions: MAX_POSITIONS,
      paperBalance: this.paperBalance,
    };
  }

  updateConfig(newConfig) {
    // Configuration is read-only - changes require env var updates and restart
    // This method is kept for UI compatibility but returns an error
    throw new Error(
      "Configuration is read-only. Update environment variables and restart the bot to change settings."
    );
  }

  statusSnapshot() {
    const availableCapital = this.getAvailableCapital();
    const freeCapital = this.getFreeCapital();
    const lockedCapital = this.getLockedCapital();
    const totalEquity = this.getTotalEquity();
    // Exclude manual positions from portfolio risk calculations
    const automatedPositions = this._getAutomatedPositions();
    const portfolioMetrics = this.portfolioRisk.getRiskMetrics(
      automatedPositions,
      availableCapital
    );
    const currentMaxPositions = MAX_POSITIONS;
    const currentDailyLimit = DAILY_TRADE_LIMIT;

    // Build per-market price data and strategy info
    const marketPrices = {};
    const marketPerformance = {};
    const marketStrategies = {}; // Strategy types per market
    for (const market of MARKETS) {
      const priceData = this._lastPrices.get(market);
      if (priceData) {
        marketPrices[market] = {
          price: priceData.price,
          volume: priceData.volume,
        };
      }
      const perf = this.marketPerformance.get(market);
      if (perf) {
        marketPerformance[market] = {
          winRate: perf.winRate,
          avgPnL: perf.avgPnL,
          totalTrades: perf.totalTrades,
        };
      }
      // Add strategy types for this market
      if (this.marketStrategyTypes && this.marketStrategyTypes.has(market)) {
        marketStrategies[market] = this.marketStrategyTypes.get(market);
      } else {
        // Fallback: determine from strategy instance
        const strategyOrStrategies = this.strategies.get(market);
        if (Array.isArray(strategyOrStrategies)) {
          marketStrategies[market] = strategyOrStrategies.map((s) => s.type);
        } else if (strategyOrStrategies) {
          marketStrategies[market] = [this.strategyFactory.getStrategyType(market)];
        }
      }
    }

    // Get gate analytics data
    let gateAnalyticsData = null;
    try {
      const { getGateAnalytics } = require("./utils/gate-analytics");
      const gateAnalytics = getGateAnalytics();

      // Get stats for all markets and sides (default 24h window)
      const timeWindowMs = 24 * 60 * 60 * 1000;
      const stats = gateAnalytics.getStats(null, null, timeWindowMs);
      const summary = gateAnalytics.getSummary(timeWindowMs);

      gateAnalyticsData = {
        stats,
        summary,
        timeWindowMs,
      };
    } catch (e) {
      // Gate analytics not available or error - continue without it
      console.warn("Failed to get gate analytics for status:", e.message);
    }

    // Calculate uptime
    const uptime = this._startTime ? Math.floor((Date.now() - this._startTime) / 1000) : 0;

    // Extended telemetry
    const memUsage = process.memoryUsage();
    const telemetry = {
      process: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        rss: memUsage.rss,
        external: memUsage.external,
        heapUsedMB: (memUsage.heapUsed / 1024 / 1024).toFixed(2),
        rssMB: (memUsage.rss / 1024 / 1024).toFixed(2),
      },
      eventLoop: {
        avgLoopDuration: this._avgLoopDuration || 0,
        loopCount: this._loopCount || 0,
        lastTickTs: this._lastTickTimestamp,
      },
      rateLimit: this.rateLimiter?.getStatus() || { remaining: 0, resetAt: null },
      circuitBreaker: this.errorHandler?.getCircuitBreakerStatus() || { active: false },
      subprocess: {
        drift: this.driftClient
          ? {
              connected: true,
              enabled: true,
              venue: "drift",
            }
          : {
              connected: false,
              enabled: false,
              reason: "Not initialized or disabled",
            },
      },
    };

    let walletFollowing = null;
    try {
      const provider =
        this.strategyFactory &&
        typeof this.strategyFactory.getCopyTradingProvider === "function"
          ? this.strategyFactory.getCopyTradingProvider()
          : null;
      if (provider && typeof provider.getTrackerSummary === "function") {
        const tracker = provider.getTrackerSummary();
        const symbols = Array.isArray(tracker?.targetSymbols) ? tracker.targetSymbols : [];
        const leadersBySymbol = {};
        const coreLeadersBySymbol = {};
        if (typeof provider.getTrackedLeaders === "function") {
          for (const symbol of symbols) {
            leadersBySymbol[symbol] = provider.getTrackedLeaders({ symbol });
            coreLeadersBySymbol[symbol] = provider.getTrackedLeaders({ symbol, kind: "core" });
          }
        }
        walletFollowing = {
          tracker,
          leadersBySymbol,
          coreLeadersBySymbol,
        };
      }
    } catch (error) {
      console.warn("Failed to build wallet-following status:", error.message);
    }

    return {
      // Bot status fields
      status: "ok",
      initialized: true,
      botRunning: true, // Bot is running if this method is being called
      botStatus: "online",

      // Market and trading data
      market: MARKET, // Backward compatibility
      markets: MARKETS, // Multi-market support
      price: this._lastPrice, // First market price (backward compatibility)
      marketPrices, // Per-market prices
      positions: this.openPositions.length,
      pos: this.openPositions.length, // Alias for compatibility
      posCap: currentMaxPositions,
      maxOpenPositions: currentMaxPositions, // Alias for compatibility
      dailyTrades: this.dailyTrades,
      daily: this.dailyTrades, // Alias for compatibility
      dailyCap: currentDailyLimit,
      dailyTradeLimit: currentDailyLimit, // Alias for compatibility
      balance: this.liveMode ? undefined : this.paperBalance,
      freeCapital, // Capital available for new positions (equals balance)
      lockedCapital, // Capital locked in open positions
      totalEquity, // Free capital + locked capital (free + locked = total, excluding unrealized PnL)
      mode: this.liveMode ? "live" : "paper",
      executionMode: EXEC_MODE,
      execMode: EXEC_MODE, // Alias for compatibility
      paused: this.paused,
      openPositions: this.listPositions(),
      portfolio: portfolioMetrics,
      marketPerformance, // Per-market performance metrics
      marketStrategies, // Strategy types per market (e.g., { 'SOL-PERP': ['momentum', 'rsi-reversion'] })
      multiStrategyMode: this.multiStrategyMode || false, // Whether multi-strategy mode is enabled
      gateAnalytics: gateAnalyticsData, // Gate analytics data
      lastTickTs: this._lastTickTimestamp,

      // Runtime stats (backward compatible)
      uptime,
      loopCount: this._loopCount || 0,
      avgLoopDuration: this._avgLoopDuration || 0,
      lastError: this._lastError || null,
      circuitBreaker: this.errorHandler?.getCircuitBreakerStatus() || { active: false },
      rateLimit: this.rateLimiter?.getStatus() || { remaining: 0, resetAt: null },
      memory: process.memoryUsage().heapUsed,

      // Extended telemetry (new)
      telemetry,
      walletFollowing,
    };
  }

  listPositions() {
    const now = Date.now();
    return this.openPositions.map((p) => {
      // Calculate hold time
      const holdTimeMs = p.openTime ? now - p.openTime : 0;
      const holdTimeFormatted = this._formatDuration(holdTimeMs);

      // Calculate unrealized PnL if we have current price
      const market = p.market || MARKET;
      const priceData = this._lastPrices?.get(market);
      const currentPrice = priceData?.price || p.entryPrice;
      let unrealizedPnL = null;
      let unrealizedPnLPercent = null;
      if (currentPrice && p.entryPrice && p.collateral) {
        const priceChange = (currentPrice - p.entryPrice) / p.entryPrice;
        const sideMultiplier = String(p.side || "").toLowerCase() === "long" ? 1 : -1;
        unrealizedPnLPercent = priceChange * sideMultiplier * (p.leverage || 1) * 100;
        unrealizedPnL = (p.collateral * unrealizedPnLPercent) / 100;
      }

      // Calculate TP/SL targets and distances
      const riskConfig = this.riskManager?.config || {};
      const tpPercent = p.takeProfitPercentOverride || riskConfig.takeProfitPercent || 0;
      const slPercent = p.stopLossPercentOverride || riskConfig.stopLossPercent || 0;
      const side = String(p.side || "").toLowerCase();
      const leverage = p.leverage || 1;

      let tpPrice = null;
      let slPrice = null;
      let distanceToTpPercent = null;
      let distanceToSlPercent = null;
      let liqDistancePercent = null;

      if (p.entryPrice && currentPrice) {
        // Calculate TP price (price at which PnL% = tpPercent)
        if (tpPercent > 0) {
          if (side === "long") {
            // LONG: TP when price goes UP
            // tpPercent = ((tp - entry) / entry) * leverage * 100
            tpPrice = p.entryPrice * (1 + tpPercent / (leverage * 100));
          } else {
            // SHORT: TP when price goes DOWN
            tpPrice = p.entryPrice * (1 - tpPercent / (leverage * 100));
          }

          // Distance to TP
          if (side === "long") {
            distanceToTpPercent = ((tpPrice - currentPrice) / currentPrice) * 100;
          } else {
            distanceToTpPercent = ((currentPrice - tpPrice) / currentPrice) * 100;
          }
        }

        // Calculate SL price (price at which PnL% = -slPercent)
        if (slPercent > 0) {
          if (side === "long") {
            // LONG: SL when price goes DOWN
            slPrice = p.entryPrice * (1 - slPercent / (leverage * 100));
          } else {
            // SHORT: SL when price goes UP
            slPrice = p.entryPrice * (1 + slPercent / (leverage * 100));
          }

          // Distance to SL
          if (side === "long") {
            distanceToSlPercent = ((currentPrice - slPrice) / currentPrice) * 100;
          } else {
            distanceToSlPercent = ((slPrice - currentPrice) / currentPrice) * 100;
          }
        }

        // Calculate liquidation distance
        if (p.liquidationPrice) {
          liqDistancePercent = Math.abs(((currentPrice - p.liquidationPrice) / currentPrice) * 100);
        }
      }

      return {
        positionId: p.positionId,
        clientOrderId: p.clientOrderId,
        market: market,
        side: p.side,
        size: p.size || p.collateral * (p.leverage || 1),
        entryPrice: p.entryPrice,
        currentPrice: currentPrice,
        markPrice: currentPrice, // alias for compatibility
        collateral: p.collateral,
        leverage: p.leverage,
        openTime: p.openTime,
        holdTimeMs: holdTimeMs,
        holdTime: holdTimeFormatted,
        liquidationPrice: p.liquidationPrice,
        trade_type: p.trade_type || "unknown",
        unrealizedPnL: unrealizedPnL,
        unrealizedPnLPercent: unrealizedPnLPercent,
        venue:
          p.venue ||
          (market?.includes("-PERP") && !["BTC-PERP", "ETH-PERP", "SOL-PERP"].includes(market)
            ? "drift"
            : "jupiter"),
        // TP/SL targets and distances
        tpPrice: tpPrice,
        slPrice: slPrice,
        tpPercent: tpPercent,
        slPercent: slPercent,
        distanceToTpPercent: distanceToTpPercent,
        distanceToSlPercent: distanceToSlPercent,
        liqDistancePercent: liqDistancePercent,
        // Strategy info
        strategyType: p.strategyType || this.strategyFactory?.getStrategyType(market) || "unknown",
      };
    });
  }

  /**
   * Format duration in human-readable format
   */
  _formatDuration(ms) {
    if (!ms || ms < 0) return "0s";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  async closeAll(reason = "manual") {
    for (const p of [...this.openPositions]) {
      const market = p.market || MARKET;
      const priceData = this._lastPrices.get(market);
      let price = priceData?.price;

      // IMPORTANT: Avoid cross-market price bleed from this._lastPrice (MARKETS[0]).
      // If a market-specific price is missing, resolve it explicitly for that market.
      if (!Number.isFinite(price) || price <= 0) {
        try {
          price = await this.getMarketPrice(market);
        } catch (_) {
          // ignore
        }
      }
      if (!Number.isFinite(price) || price <= 0) {
        price = p.entryPrice;
      }
      if (!Number.isFinite(price) || price <= 0) {
        console.warn(
          `[CLOSE_ALL] Skipping close for ${p.positionId} (${market}) - no market-specific price available`
        );
        continue;
      }

      await this.closePosition(p, price, reason);
    }
  }

  /**
   * Get current market price for a symbol
   * Uses Pyth for Drift indicators and oracle/Pyth for Jupiter markets
   * @param {string} market - Market symbol (e.g., 'SOL-PERP', 'JTO-PERP')
   * @returns {Promise<number>} Current market price
   */
  async getMarketPrice(market) {
    const venueRouter = require("./utils/venue-router");
    const venue = venueRouter.getVenueForMarket(market);
    const baseSymbol = market.split("-")[0];

    // For Drift markets, use Pyth via Drift client
    if (venue === "drift" && this.driftClient && this.driftClient.initialized) {
      try {
        // IMPORTANT: Pass full market key to prevent base-symbol alias bleed.
        const pythPrice = await this.driftClient.getMarketPrice(market);
        if (pythPrice !== null && Number.isFinite(pythPrice)) {
          return pythPrice;
        }
      } catch (e) {
        console.warn(`[Bot] Failed to get Drift Pyth price for ${market}: ${e.message}`);
      }
    }

    // For Jupiter markets or as fallback, use price client (Pyth/oracle)
    try {
      return await this.priceClient.getMarketPrice(baseSymbol);
    } catch (e) {
      // Last fallback: cached price
      const cached = this._lastPrices?.get(market);
      if (cached?.price) return cached.price;
      throw new Error(`Unable to get price for ${market}`);
    }
  }

  /**
   * Calculate PnL percentage for a position using current cached prices
   * @param {Object} position - Position object with market, side, entryPrice, leverage
   * @param {number} [currentPrice] - Override price (optional)
   * @returns {number} PnL percentage (leverage-adjusted)
   */
  calculatePnL(position, currentPrice = null) {
    // Use provided price or get from cached prices
    let price = currentPrice;
    if (price === null || price === undefined) {
      const priceData = this._lastPrices?.get(position.market);
      price = priceData?.price || position.entryPrice;
    }

    // Use priceClient's calculation logic (it's generic math, returns leverage-adjusted %)
    if (this.priceClient?.calculatePnL) {
      return this.priceClient.calculatePnL(position, price);
    }

    // Fallback: manual calculation (returns leverage-adjusted %)
    // Formula: ((current - entry) / entry) * leverage * 100 for long, inverse for short
    const side = (position.side || "").toLowerCase();
    const entryPrice = position.entryPrice || 1;
    const leverage = position.leverage || 1;

    const move = (price - entryPrice) / entryPrice;
    return (side === "long" ? move : -move) * leverage * 100;
  }

  /**
   * Calculate PnL with both USD and percentage values
   * @param {Object} position - Position object
   * @param {number} [currentPrice] - Override price (optional)
   * @returns {Object} PnL object with pnlPercent, pnlUsd
   */
  calculatePnLFull(position, currentPrice = null) {
    const pnlPercent = this.calculatePnL(position, currentPrice);
    const pnlUsd = position.collateral ? (position.collateral * pnlPercent) / 100 : 0;
    return { pnlPercent, pnlUsd };
  }

  /**
   * Check if position is near liquidation
   * @param {Object} position - Position object with liquidationPrice
   * @param {number} currentPrice - Current market price
   * @returns {boolean} True if near liquidation (within 5% of liq price)
   */
  isNearLiquidation(position, currentPrice) {
    // Delegate to priceClient if available
    if (this.priceClient?.isNearLiquidation) {
      return this.priceClient.isNearLiquidation(position, currentPrice);
    }

    // Fallback: manual calculation
    if (!position.liquidationPrice) return false;
    const liqPrice = position.liquidationPrice;
    const distance = Math.abs(currentPrice - liqPrice) / liqPrice;
    // Consider "near" if within 5% of liquidation price
    return distance <= 0.05;
  }

  _actionKey(kind, payload) {
    return crypto
      .createHash("sha1")
      .update(JSON.stringify({ kind, payload }))
      .digest("hex")
      .slice(0, 12);
  }
  _dup(key) {
    return Date.now() - (this._recentActions.get(key) || 0) < this._recentActionsTtlMs;
  }
  _mark(key) {
    const now = Date.now();
    this._recentActions.set(key, now);
    if (this._recentActions.size > this._maxRecentActions) {
      for (const [k, ts] of this._recentActions) {
        if (now - ts > this._recentActionsTtlMs * 2) {
          this._recentActions.delete(k);
        }
      }
    }
  }
  _recordOpenDiagnostic(event = {}) {
    if (!this._openDiagnostics) this._openDiagnostics = [];
    const payload = {
      ts: Date.now(),
      ...event,
    };
    this._openDiagnostics.push(payload);
    if (this._openDiagnostics.length > this._maxOpenDiagnostics) {
      this._openDiagnostics.shift();
    }
    console.log("[OPEN_PIPELINE]", payload);
  }

  _stableStringify(value) {
    const seen = new WeakSet();
    const stringify = (val) => {
      if (val === null) return "null";
      const type = typeof val;
      if (type === "number") {
        if (!Number.isFinite(val)) return JSON.stringify(String(val));
        return JSON.stringify(val);
      }
      if (type === "string" || type === "boolean") return JSON.stringify(val);
      if (type === "bigint") return JSON.stringify(val.toString());
      if (type === "function" || type === "undefined") return undefined;
      if (Array.isArray(val)) {
        const arr = val.map((item) => stringify(item)).filter((item) => item !== undefined);
        return `[${arr.join(",")}]`;
      }
      if (type === "object") {
        if (seen.has(val)) return '"[Circular]"';
        seen.add(val);
        const entries = Object.keys(val)
          .filter((key) => {
            const v = val[key];
            return typeof v !== "function" && v !== undefined;
          })
          .sort()
          .map((key) => {
            const strValue = stringify(val[key]);
            if (strValue === undefined) return undefined;
            return `${JSON.stringify(key)}:${strValue}`;
          })
          .filter((entry) => entry !== undefined);
        seen.delete(val);
        return `{${entries.join(",")}}`;
      }
      return JSON.stringify(String(val));
    };

    return stringify(value);
  }

  _clientOrderId({ market, side, timestamp, signal }) {
    const payload = {
      market: market || MARKET, // Ensure market is included
      side: typeof side === "string" ? side.toUpperCase() : side,
      timestamp,
      signal,
    };
    const fingerprint = this._stableStringify(payload);
    return crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 48);
  }

  _acquireTickGuard(market) {
    if (this._tickInflight.get(market)) {
      return false;
    }
    this._tickInflight.set(market, Date.now());
    return true;
  }

  _releaseTickGuard(market) {
    this._tickInflight.delete(market);
  }

  _handleVolumeMeta(meta) {
    if (!meta) {
      this._volumeFallbackCount = 0;
      this._volumeFallbackAlerted = false;
      return;
    }

    const source = meta.source;
    if (source === "cache_stale") {
      this._volumeFallbackCount += 1;

      if (this._volumeFallbackCount >= VOLUME_FALLBACK_THRESHOLD && !this._volumeFallbackAlerted) {
        const message = `Volume provider fallback to cached data detected ${this._volumeFallbackCount} times.`;
        errorHandler.log(new Error(message), {
          category: Category.NETWORK,
          severity: Severity.MEDIUM,
          context: {
            action: "volume_meta",
            upstream: meta.upstreamSymbol,
            error: meta.error,
            count: this._volumeFallbackCount,
          },
        });

        pretty("volume_alert", {
          source,
          count: this._volumeFallbackCount,
          upstream: meta.upstreamSymbol,
        });

        ui.send("alert", {
          type: "volume_fallback",
          count: this._volumeFallbackCount,
          source,
          upstream: meta.upstreamSymbol,
          message,
        });

        this._volumeFallbackAlerted = true;
      }
    } else {
      this._volumeFallbackCount = 0;
      this._volumeFallbackAlerted = false;
    }
  }

  // ---------- Market data ----------
  async _fetchVolumeForMarket(market, price) {
    const baseSymbol = market.split("-")[0];
    let volumeForStrategy = 0;
    let rawVolume = null;
    let volumeMeta = null;
    let volumeInterval = null;
    let volumeWindowBase = null;
    let volumeWindowUsd = null;

    // Optional: Enable volume fetching if ENABLE_VOLUME_FETCH=true
    // Check with case-insensitive and trimmed comparison for robustness
    const enableVolumeFetchRaw = process.env.ENABLE_VOLUME_FETCH;
    const enableVolumeFetch =
      enableVolumeFetchRaw && String(enableVolumeFetchRaw).trim().toLowerCase() === "true";

    if (!enableVolumeFetch) {
      // Log once that volume fetch is disabled (helpful for debugging)
      if (!this._volumeFetchDisabledLogged) {
        this._volumeFetchDisabledLogged = true;
        console.log(
          `ℹ️  [VOLUME] Fetch disabled (ENABLE_VOLUME_FETCH=${enableVolumeFetchRaw || "not set"})`
        );
      }
      return {
        volume: 0,
        rawVolume: null,
        volumeMeta: null,
        volumeInterval: null,
        volumeWindowUsd: null,
      };
    }

    try {
      volumeInterval = this._resolveVolumeIntervalForMarket(market);
      const volumeInfo = await marketDataProvider.getLatestVolume(baseSymbol, price, {
        interval: volumeInterval,
      });
      if (volumeInfo) {
        volumeMeta = volumeInfo.meta || null;
        volumeWindowBase = Number.isFinite(volumeInfo.baseVolume) ? volumeInfo.baseVolume : null;
        rawVolume = volumeWindowBase;
        const quoteVol = Number(volumeInfo.quoteVolume);
        volumeWindowUsd = Number.isFinite(quoteVol)
          ? quoteVol
          : Number.isFinite(volumeWindowBase) && Number.isFinite(price)
            ? volumeWindowBase * price
            : null;

        // IMPORTANT:
        // Strategies consume VOLUME on BAR CLOSE, but the bar aggregators need per-tick DELTAS.
        // MarketDataProvider returns the *current window cumulative* volume (Coinbase candles / Binance klines).
        // Convert that to an incremental delta to avoid overcounting on every bot tick.
        const snapKey = market;
        const openTime = Number.isFinite(Number(volumeInfo.openTime))
          ? Number(volumeInfo.openTime)
          : null;
        const prev = this._lastVolumeSnapshot?.get?.(snapKey) || null;
        let deltaBase = 0;
        if (Number.isFinite(volumeWindowBase) && volumeWindowBase >= 0) {
          if (prev && openTime !== null && prev.openTime === openTime) {
            const prevBase = Number(prev.baseVolume);
            if (Number.isFinite(prevBase)) deltaBase = Math.max(0, volumeWindowBase - prevBase);
            else deltaBase = 0;
          } else {
            deltaBase = volumeWindowBase;
          }
        } else if (Number.isFinite(volumeWindowUsd) && volumeWindowUsd >= 0) {
          const prevUsd =
            prev && Number.isFinite(prev.quoteVolume) ? Number(prev.quoteVolume) : null;
          if (prev && openTime !== null && prev.openTime === openTime && prevUsd !== null) {
            volumeForStrategy = Math.max(0, volumeWindowUsd - prevUsd);
          } else {
            volumeForStrategy = volumeWindowUsd;
          }
        }

        if (Number.isFinite(deltaBase) && deltaBase > 0 && Number.isFinite(price) && price > 0) {
          volumeForStrategy = deltaBase * price;
        }

        if (!this._lastVolumeSnapshot) this._lastVolumeSnapshot = new Map();
        this._lastVolumeSnapshot.set(snapKey, {
          openTime,
          baseVolume: volumeWindowBase,
          quoteVolume: volumeWindowUsd,
        });

        // Log successful volume fetch (only once per market to avoid spam)
        if (!this._volumeFetchLogged || !this._volumeFetchLogged.has(market)) {
          if (!this._volumeFetchLogged) this._volumeFetchLogged = new Set();
          this._volumeFetchLogged.add(market);
          console.log(
            `✅ [VOLUME] Fetch enabled for ${market} [${volumeInterval}]: ` +
              `delta≈$${Number(volumeForStrategy || 0).toFixed(2)} ` +
              `${volumeWindowUsd !== null ? `window≈$${Number(volumeWindowUsd).toFixed(2)} ` : ""}` +
              `(source: ${volumeMeta?.source || "unknown"})`
          );
        }
      } else {
        // Log when volume fetch returns null (only once per market)
        if (!this._volumeFetchNullLogged || !this._volumeFetchNullLogged.has(market)) {
          if (!this._volumeFetchNullLogged) this._volumeFetchNullLogged = new Set();
          this._volumeFetchNullLogged.add(market);
          console.warn(`⚠️  [VOLUME] Fetch enabled for ${market} but returned null`);
        }
      }
      this._handleVolumeMeta(volumeMeta);
    } catch (volumeError) {
      // Log volume fetch errors with more detail (only once per market to avoid spam)
      if (!this._volumeFetchErrorLogged || !this._volumeFetchErrorLogged.has(market)) {
        if (!this._volumeFetchErrorLogged) this._volumeFetchErrorLogged = new Set();
        this._volumeFetchErrorLogged.add(market);
        console.error(`❌ [VOLUME] Fetch failed for ${market}: ${volumeError.message}`);
        if (volumeError.code) {
          console.error(`   Error code: ${volumeError.code}`);
        }
        if (volumeError.response) {
          console.error(`   HTTP status: ${volumeError.response.status}`);
        }
      }

      errorHandler.log(volumeError, {
        category: Category.NETWORK,
        severity: Severity.LOW,
        context: { action: "_fetchVolume", symbol: baseSymbol, market },
      });
    }

    return {
      volume: Number.isFinite(volumeForStrategy) ? volumeForStrategy : 0,
      rawVolume,
      volumeMeta,
      volumeInterval,
      volumeWindowUsd,
    };
  }

  async _fetchPrice(market) {
    const baseSymbol = market.split("-")[0];
    try {
      // Route price fetch based on venue (Drift uses Pyth, Jupiter uses Pyth/Jupiter fallback)
      const venueRouter = require("./utils/venue-router");
      const venue = venueRouter.getVenueForMarket(market);

      let price;
      let priceSource = "unknown";
      if (venue === "drift" && this.driftClient && this.driftClient.initialized) {
        // Use Drift client for Pyth price (WS)
        // IMPORTANT: Pass full market key (e.g., 'PAXG-PERP') to avoid base-symbol alias bleed
        // in upstream price caches (which can force wrong fallback pricing).
        price = await this.driftClient.getMarketPrice(market);
        priceSource = "drift-pyth";
      } else {
        // Use Jupiter/Pyth price client
        price = await this.priceClient.getMarketPrice(baseSymbol);
        priceSource = "pyth";
      }

      // Validate price is within expected range to prevent cross-market contamination
      const expectedRanges = {
        "SOL-PERP": { min: 5, max: 2000 },
        "ETH-PERP": { min: 200, max: 30000 },
        "BTC-PERP": { min: 10000, max: 500000 },
      };
      const range = expectedRanges[market];
      if (range && (price < range.min || price > range.max)) {
        console.error(
          `❌ Invalid price $${price.toFixed(4)} for ${market} (expected: $${range.min}-$${range.max})`
        );
        throw new Error(`Invalid price for ${market}: ${price}`);
      }

      const {
        volume: volumeForStrategy,
        rawVolume,
        volumeMeta,
        volumeInterval,
        volumeWindowUsd,
      } = await this._fetchVolumeForMarket(market, price);

      const priceData = {
        price,
        volume: Number.isFinite(volumeForStrategy) ? volumeForStrategy : 0,
        rawVolume,
        volumeMeta,
        volumeInterval,
        volumeWindowUsd,
        source: priceSource,
      };

      this._lastPrices.set(market, priceData);

      // For backward compatibility, update single vars for first market
      if (market === MARKETS[0]) {
        this._lastPrice = price;
        this._lastVolume = priceData.volume;
      }

      const pricePayload = { market, price };
      if (Number.isFinite(priceData.volume)) {
        pricePayload.volumeUsd = priceData.volume;
      }
      if (volumeMeta?.source) {
        pricePayload.volumeSource = volumeMeta.source;
      }

      pretty("price", pricePayload);
      ui.send("price", pricePayload);

      return priceData;
    } catch (error) {
      await errorHandler.handle(error, {
        category: Category.NETWORK,
        severity: Severity.MEDIUM,
        context: { action: "_fetchPrice", symbol: baseSymbol, market },
      });

      const lastPriceData = this._lastPrices.get(market);
      if (lastPriceData) {
        console.warn(
          `⚠️  Using last known price for ${market}: $${lastPriceData.price.toFixed(2)}`
        );
        return lastPriceData;
      }

      throw error;
    }
  }

  // Fetch prices for all markets using unified PriceProvider (Pyth WS primary + Jupiter fallback)
  async _fetchAllPrices(full = false) {
    const markets = MARKETS.slice();
    let priceDataMap = new Map();
    const fetchMeta = {
      markets: markets.length,
      perMarket: {},
      summary: { live: 0, cache: 0, stale: 0, batch: 0, unknown: 0, pyth_ws: 0 },
      sources: [],
      mode: null,
      missing: [],
    };

    if (!this._priceRoutingLogged) {
      console.log("ℹ️  [PRICE] Drift indicators use Pyth; execution uses DLOB mark");
      this._priceRoutingLogged = true;
    }

    // Use unified PriceProvider (Pyth WS primary, Jupiter fallback)
    try {
      priceDataMap = await this.priceProvider.getAllPrices();

      // Count sources for logging
      for (const [market, data] of priceDataMap.entries()) {
        const source = data.source || "unknown";
        if (source === "pyth-ws") fetchMeta.summary.pyth_ws++;
        else if (source === "jupiter-batch") fetchMeta.summary.batch++;
        else if (source.includes("cache")) fetchMeta.summary.cache++;
      }
    } catch (err) {
      console.warn("⚠️  PriceProvider failed, using fallback:", err.message);
    }

    // Fallback: fetch missing prices concurrently (multi-source with circuit breakers)
    const toFetch = markets.filter((m) => !priceDataMap.has(m));
    if (toFetch.length > 0) {
      const results = await Promise.all(
        toFetch.map((m) =>
          this._fetchPrice(m)
            .then((d) => ({ m, d }))
            .catch((err) => {
              console.error(`Failed to fetch price for ${m}:`, err.message);
              return { m, d: null };
            })
        )
      );
      for (const { m, d } of results) {
        if (d) priceDataMap.set(m, d);
      }
    }

    // Fill any remaining gaps from cache
    for (const m of markets) {
      if (!priceDataMap.has(m)) {
        const cached = this._lastPrices?.get(m);
        if (cached) {
          priceDataMap.set(m, cached);
        }
      }
    }

    // Attach volume to markets that require it (Ichimoku markets) even when price comes from PriceProvider.
    // Without this, volume stays "none" because `_fetchPrice` is only used on fallback paths.
    const enableVolumeFetchRaw = process.env.ENABLE_VOLUME_FETCH;
    const enableVolumeFetch =
      enableVolumeFetchRaw && String(enableVolumeFetchRaw).trim().toLowerCase() === "true";
    if (enableVolumeFetch) {
      const volumeMarkets = markets.filter((market) => {
        const strategyType =
          this.strategyFactory && typeof this.strategyFactory.getStrategyType === "function"
            ? this.strategyFactory.getStrategyType(market)
            : null;
        return strategyType === "ichimoku-cloud";
      });

      const volResults = await Promise.all(
        volumeMarkets.map(async (market) => {
          const pd = priceDataMap.get(market);
          if (!pd || !Number.isFinite(pd.price)) return null;
          const vol = await this._fetchVolumeForMarket(market, pd.price);
          return { market, vol };
        })
      );

      for (const row of volResults) {
        if (!row) continue;
        const prev = priceDataMap.get(row.market);
        if (!prev) continue;
        priceDataMap.set(row.market, { ...prev, ...row.vol });
      }
    }

    // Build detailed metadata for logging
    const sourcesSet = new Set();
    for (const market of markets) {
      // First try to get metadata from the actual price data we fetched
      const priceData = priceDataMap.get(market);

      // Fallback to priceClient metadata if no direct price data
      const symbol = market.split("-")[0].toUpperCase();
      const clientMeta =
        typeof this.priceClient?.getLastPriceMeta === "function"
          ? this.priceClient.getLastPriceMeta(symbol)
          : null;

      // Use price data source first, then client meta as fallback
      const source = priceData?.source || clientMeta?.source || "unknown";
      const hasPriceData = !!priceData;
      const hasClientMeta = !!clientMeta;

      // Infer via from price data or client meta
      let inferredVia = "unknown";
      if (priceData?.source) {
        // Direct from price data - if it's pyth-ws, it's live
        inferredVia = priceData.source.includes("pyth")
          ? "live"
          : priceData.cached
            ? "cache"
            : "live";
      } else if (hasClientMeta) {
        inferredVia = clientMeta.via || (clientMeta.cached ? "cache" : "live");
      }

      const detail = {
        source: source,
        via: inferredVia,
        cached: priceData?.cached || clientMeta?.cached || false,
        stale: priceData?.stale || clientMeta?.stale || false,
        batch: priceData?.batch || clientMeta?.batch || false,
        ageMs: Number.isFinite(priceData?.ageMs)
          ? priceData.ageMs
          : Number.isFinite(clientMeta?.ageMs)
            ? clientMeta.ageMs
            : null,
        price: priceData?.price, // Include price for display
      };
      if (!priceDataMap.has(market)) {
        fetchMeta.missing.push(market);
      }
      if (detail.source && detail.source !== "unknown") {
        sourcesSet.add(detail.source);
      }
      switch (detail.via) {
        case "batch":
          fetchMeta.summary.batch += 1;
          break;
        case "cache":
          fetchMeta.summary.cache += 1;
          break;
        case "stale-cache":
          fetchMeta.summary.cache += 1;
          fetchMeta.summary.stale += 1;
          break;
        case "live":
          fetchMeta.summary.live += 1;
          break;
        default:
          fetchMeta.summary.unknown += 1;
          break;
      }
      fetchMeta.perMarket[market] = detail;
    }
    fetchMeta.sources = Array.from(sourcesSet);
    const modeParts = [];
    if (fetchMeta.summary.batch > 0) modeParts.push("batch");
    if (fetchMeta.summary.live > 0) modeParts.push("live");
    if (fetchMeta.summary.cache > 0 && fetchMeta.summary.stale === 0) modeParts.push("cache");
    if (fetchMeta.summary.stale > 0) modeParts.push("stale");
    if (modeParts.length === 0) modeParts.push("unknown");
    fetchMeta.mode = modeParts.join("+");
    this._lastPriceFetchMeta = fetchMeta;

    return priceDataMap;
  }

  // ---------- Fetch historical data for warmup ----------
  async _fetchHistoricalData(symbol, market, barsNeeded = 100) {
    // Fetch historical OHLCV data from Pyth Network
    // Pyth is secure, reliable, designed for DeFi, and requires no API key

    try {
      const { PythHistoricalFetcher } = require("./utils/pyth-historical");
      // IMPORTANT: reuse a single fetcher instance so rate limiting + cache behave correctly.
      // Creating one per market and running concurrently can trigger upstream throttling and cause empty responses.
      if (!this._pythHistoricalFetcher) {
        this._pythHistoricalFetcher = new PythHistoricalFetcher();
      }
      const pyth = this._pythHistoricalFetcher;

      const interval = this._perMarketIntervalsEnabled
        ? this._marketIntervals.get(market) || this._resolveTradingIntervalForMarket(market)
        : this.tradingInterval;
      const normalized = String(interval || "5m")
        .trim()
        .toLowerCase();

      // Pyth expects resolution in MINUTES (string). Convert '1h' -> '60', '5m' -> '5'.
      let intervalMinutes = "5";
      if (normalized.endsWith("h")) {
        const hours = Number(normalized.slice(0, -1));
        intervalMinutes = String(Number.isFinite(hours) && hours > 0 ? hours * 60 : 60);
      } else if (normalized.endsWith("m")) {
        const minutes = Number(normalized.slice(0, -1));
        intervalMinutes = String(Number.isFinite(minutes) && minutes > 0 ? minutes : 5);
      } else {
        // Fallback: try to parse any numeric component
        const n = Number(normalized.replace(/[^0-9]/g, ""));
        intervalMinutes = String(Number.isFinite(n) && n > 0 ? n : 5);
      }
      const candles = await pyth.fetchHistoricalData(symbol, barsNeeded, intervalMinutes);

      if (candles.length > 0) {
        return candles;
      } else {
        console.warn(`⚠️  Pyth returned no data for ${symbol}, will skip warmup for this market`);
        return [];
      }
    } catch (error) {
      console.warn(`⚠️  Pyth historical fetch failed for ${symbol}: ${error.message}`);
      return [];
    }
  }

  // ---------- Warmup indicators ----------
  async _warmup() {
    console.log(`🔄 [WARMUP] Starting warmup phase (${WARMUP_TICKS} ticks)...`);
    console.log(`   Markets: ${MARKETS.join(", ")}`);

    // Add startup delay on Render to ensure old instance has shut down during deployment
    // Old instance gets SIGTERM and has 30s to gracefully shut down
    // Wait 5-10 seconds to ensure old instance has stopped making API calls
    if (this.environment.includes("render")) {
      const delay = Math.floor(Math.random() * 5000) + 5000; // 5-10 seconds delay
      console.log(
        `⏱️  [RENDER] Waiting ${(delay / 1000).toFixed(1)}s for old instance to shut down...`
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    // Strategy: Use Pyth for bulk historical data (reliable, oracle-quality data)
    const useHistoricalWarmup = process.env.USE_HISTORICAL_WARMUP !== "false"; // Default: enabled

    if (useHistoricalWarmup && WARMUP_TICKS > 10) {
      console.log("📊 Attempting bulk historical data warmup...");
      console.log(
        "   Note: Historical data uses Pyth oracle prices (DLOB mark price is real-time only)"
      );

      // Fetch historical data for markets SEQUENTIALLY (avoid upstream 429/empty responses)
      // NOTE: Historical data comes from Pyth (oracle prices) for ALL markets.
      // Drift DLOB WebSocket only provides real-time mark prices, not historical.
      // This is acceptable for warmup since oracle and mark prices are typically very close.
      const results = [];
      for (const market of MARKETS) {
        const symbol = market.split("-")[0];
        const candles = await this._fetchHistoricalData(symbol, market, WARMUP_TICKS);
        results.push({ market, candles, success: candles.length > 0 });
      }

      // Feed historical data to strategies that succeeded
      const marketsWithHistoricalData = [];
      const marketsNeedingLiveWarmup = [];

      for (const { market, candles, success } of results) {
        if (success) {
          const strategyOrStrategies = this.strategies.get(market);
          const barAggregator = this.barAggregators.get(market);
          const tickBuffer = this.tickBuffers.get(market);

          if (strategyOrStrategies && barAggregator && tickBuffer) {
            // Take the most recent N candles (WARMUP_TICKS)
            const recentCandles = candles.slice(-WARMUP_TICKS);
            const marketBarDurationMs = this._marketBarDurationMs.get(market) || this.barDurationMs;

            // Get all strategies for this market (array in multi-strategy mode)
            const marketStrategies = Array.isArray(strategyOrStrategies)
              ? strategyOrStrategies
              : [{ type: "momentum", strategy: strategyOrStrategies }];

            // Feed historical candles directly to ALL strategies.
            // IMPORTANT: Use bar-close timestamp semantics (match BarAggregator endTime in live).
            for (const candle of recentCandles) {
              const tsOpen = Number(candle.ts);
              const tsClose = Number.isFinite(tsOpen) ? tsOpen + marketBarDurationMs : Date.now();
              for (const { strategy } of marketStrategies) {
                if (!strategy) continue;
                strategy.update({
                  price: candle.close,
                  close: candle.close,
                  high: candle.high,
                  low: candle.low,
                  volume: candle.volume,
                  ts: tsClose,
                });
              }
            }

            // Seed tick buffer with historical bars
            // This converts bars into ticks to populate the rolling window
            tickBuffer.seedFromBars(recentCandles);

            marketsWithHistoricalData.push(market);
            const fromTs = Number(recentCandles[0]?.ts);
            const toOpenTs = Number(recentCandles[recentCandles.length - 1]?.ts);
            const fromIso = Number.isFinite(fromTs)
              ? new Date(fromTs).toISOString().slice(0, 16)
              : "unknown";
            const toIso = Number.isFinite(toOpenTs)
              ? new Date(toOpenTs + marketBarDurationMs).toISOString().slice(0, 16)
              : "unknown";
            pretty("warmup_historical", {
              market,
              candles: recentCandles.length,
              from: fromIso,
              to: toIso,
            });
          }
        } else {
          marketsNeedingLiveWarmup.push(market);
        }
      }

      // If some markets failed, we keep running (they will warm up gradually during normal operation).
      if (marketsNeedingLiveWarmup.length > 0) {
        console.log(
          `⚠️  ${marketsNeedingLiveWarmup.length} market(s) failed historical warmup: ${marketsNeedingLiveWarmup.join(", ")}`
        );
        console.log("⏭️  Those markets will warm up during normal operation");
        console.log(
          '   Note: ADX/ATR require bar-close updates; they may show as "--" until enough bars accumulate'
        );

        // Log information about warmup
        console.log("\n💡 Note: Using Pyth Network for historical data (secure oracle data)");
        console.log("   Some markets may not have historical data available");
        console.log("   Those markets will warm up gradually during normal operation\n");
      }

      console.log(
        `✅ Warmup complete: ${marketsWithHistoricalData.length} historical, ${marketsNeedingLiveWarmup.length} live`
      );

      // Diagnostic: Show RSI/ADX after warmup to verify indicator calculation
      console.log("\n📊 Post-warmup indicator status:");
      for (const market of MARKETS) {
        const strategyOrStrategies = this.strategies.get(market);
        if (!strategyOrStrategies) continue;
        const marketStrategies = Array.isArray(strategyOrStrategies)
          ? strategyOrStrategies
          : [{ type: "unknown", strategy: strategyOrStrategies }];
        for (const { type, strategy } of marketStrategies) {
          const rsi = Number.isFinite(strategy?.rsi) ? strategy.rsi.toFixed(1) : "--";
          const adx = Number.isFinite(strategy?.adx) ? strategy.adx.toFixed(1) : "--";
          const bars = strategy?.prices?.length ?? 0;
          console.log(`   ${market} [${type}]: RSI=${rsi} ADX=${adx} bars=${bars}`);
        }
      }
      console.log("");
    } else {
      // Fallback: Live warmup without Jupiter (Coinbase / Pyth / CoinGecko only)
      console.log("📡 Using non-Jupiter live warmup (Coinbase/Pyth/CoinGecko)…");
      console.log(
        "   Historical warmup (via Pyth) may have failed or be unavailable for these markets\n"
      );

      const warmupFeed = this.priceClient?.multiPriceFeed;
      if (!warmupFeed || typeof warmupFeed.getPrice !== "function") {
        console.warn(
          "⚠️  Warmup feed unavailable; skipping live warmup entirely to avoid Jupiter usage."
        );
      } else {
        const warmupDelay = Math.max(
          1000,
          Math.min(parseInt(process.env.JUP_API_MIN_MS, 10) || 10000, 3000)
        );

        for (let i = 0; i < WARMUP_TICKS; i++) {
          for (const market of MARKETS) {
            const strategyOrStrategies = this.strategies.get(market);
            if (!strategyOrStrategies) continue;

            const symbol = market.split("-")[0]?.toUpperCase();
            if (!symbol) continue;

            // Get all strategies for this market (array in multi-strategy mode)
            const marketStrategies = Array.isArray(strategyOrStrategies)
              ? strategyOrStrategies
              : [{ type: "momentum", strategy: strategyOrStrategies }];

            try {
              // Use Pyth via Drift client for Drift markets, warmup feed for everything else
              const venueRouter = require("./utils/venue-router");
              const venue = venueRouter.getVenueForMarket(market);
              let price = null;
              let volume = 0;

              if (venue === "drift" && this.driftClient && this.driftClient.initialized) {
                const pythPrice = await this.driftClient.getMarketPrice(symbol);
                if (pythPrice !== null && Number.isFinite(pythPrice) && pythPrice > 0) {
                  price = pythPrice;
                }
              }

              // Fallback to warmup feed (Pyth/Coinbase/CoinGecko)
              if (price === null) {
                const priceResult = await warmupFeed.getPrice(symbol);
                if (priceResult && Number.isFinite(priceResult.price)) {
                  price = priceResult.price;
                  volume = Number.isFinite(priceResult.volume) ? priceResult.volume : 0;
                }
              }

              if (price !== null && Number.isFinite(price)) {
                // Update ALL strategies for this market
                for (const { strategy } of marketStrategies) {
                  if (!strategy) continue;
                  strategy.update({
                    price: price,
                    close: price,
                    volume: volume,
                    ts: Date.now(),
                  });
                }
              } else {
                console.warn(`⚠️  Warmup missing price for ${symbol} (${venue})`);
              }
            } catch (err) {
              console.warn(`⚠️  Warmup failed for ${symbol}: ${err.message}`);
            }
          }

          if (i % 10 === 0 || i === WARMUP_TICKS - 1) {
            pretty("warmup", { done: i + 1, total: WARMUP_TICKS, markets: MARKETS.length });
          }

          if (i < WARMUP_TICKS - 1) {
            // Light pacing to avoid hammering backup APIs
            const startupMultiplier = i < 10 ? 1.5 : 1;
            const actualDelay = Math.round(warmupDelay * startupMultiplier);
            await new Promise((r) => setTimeout(r, actualDelay));
          }
        }
      }
    }

    pretty("ready");
    ui.send("status", this.statusSnapshot());
  }

  // ---------- Execution ----------

  /**
   * Queue position opens to execute sequentially (prevents log chaos)
   */
  async _queuePositionOpen(fn) {
    return new Promise((resolve, reject) => {
      const queuePosition = this._openPositionQueue.length + 1;

      // Log queue status if there are pending items
      if (this._openPositionInProgress || this._openPositionQueue.length > 0) {
        console.log(`📋 Position open queued (position ${queuePosition} in queue)`);
      }

      this._openPositionQueue.push({ fn, resolve, reject });
      this._processPositionQueue();
    });
  }

  async _processPositionQueue() {
    // Already processing, exit
    if (this._openPositionInProgress) return;

    // No items in queue, exit
    if (this._openPositionQueue.length === 0) return;

    // Mark as processing
    this._openPositionInProgress = true;

    // Get next item
    const { fn, resolve, reject } = this._openPositionQueue.shift();

    // Log if more items are waiting
    if (this._openPositionQueue.length > 0) {
      console.log(
        `⚙️  Processing position open (${this._openPositionQueue.length} more in queue)...`
      );
    }

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      // Mark as done and process next
      this._openPositionInProgress = false;
      this._processPositionQueue();
    }
  }

  async openPosition(side, price, market, options = {}) {
    // Queue this position open to prevent concurrent execution (cleaner logs)
    return this._queuePositionOpen(() => this._executePositionOpen(side, price, market, options));
  }

  async _executePositionOpen(side, price, market, options = {}) {
    const {
      clientOrderId,
      signal,
      tickTimestamp,
      isPyramid,
      parentPosition,
      allocatorScore,
      priceData,
    } = options;
    const targetMarket = market || MARKET; // Use provided market or fallback
    const strategyType = signal?.strategyType || "momentum";
    const leverageConfig = this._resolveLeverageConfig(strategyType, targetMarket);

    // Per-market leverage override (Render env friendly)
    // Format: STRATEGY_{MARKET}_LEVERAGE, e.g. STRATEGY_SOL_PERP_LEVERAGE=7 for SOL-PERP
    // This is intentionally separate from global LEVERAGE_LONG/LEVERAGE_SHORT/LEVERAGE_MAX.
    // Uses process.env directly (same approach as RiskManager for hard stops) to ensure
    // the override is applied reliably after dotenv loads strategy files.
    const marketKey = String(targetMarket).replace(/-/g, "_"); // SOL-PERP -> SOL_PERP
    const perMarketLevEnvKey = `STRATEGY_${marketKey}_LEVERAGE`;

    // Check process.env directly (reliable - dotenv loads strategy files with override=true)
    // Also check strategyEnvManager snapshot as fallback for isolation
    let perMarketLevEnv = process.env[perMarketLevEnvKey];
    if ((perMarketLevEnv === undefined || perMarketLevEnv === "") && strategyEnvManager) {
      const strategyEnv = strategyEnvManager.getEnvForMarket(targetMarket, strategyType);
      const explicitOverride = strategyEnv?.[perMarketLevEnvKey];
      perMarketLevEnv =
        explicitOverride !== undefined && explicitOverride !== "" ? explicitOverride : null;
    }
    const perMarketLeverage =
      perMarketLevEnv !== undefined && perMarketLevEnv !== null && perMarketLevEnv !== ""
        ? Number(perMarketLevEnv)
        : null;
    const hasPerMarketLeverage = Number.isFinite(perMarketLeverage) && perMarketLeverage > 0;
    let orderId = null;
    let shouldReleaseOrderGuard = false;

    try {
      // Reset daily trade counter at UTC day boundary
      const todayKey = new Date().toISOString().slice(0, 10);
      if (this._dailyKey !== todayKey) {
        this.dailyTrades = 0;
        this._dailyKey = todayKey;
      }
      this._resetCopyDailyLossIfNeeded(Date.now());

      const currentMaxPositions = MAX_POSITIONS;
      const currentDailyLimit = DAILY_TRADE_LIMIT;
      // NEW: Handle pyramiding by adding to existing position
      if (isPyramid && parentPosition && !parentPosition.pyramidAdded) {
        // Calculate pyramid add size
        const pyramidAddPct = config.strategy.pyramidAddPct ?? 50;
        const addCollateral = parentPosition.collateral * (pyramidAddPct / 100);
        const addSize = addCollateral * (parentPosition.leverage || 1);
        const addQty = addSize / price;

        // Calculate weighted average entry price
        // Weighted average = (size1 + size2) / (qty1 + qty2)
        // where qty = size / entryPrice
        const initialSize = parentPosition.size;
        const initialQty = initialSize / parentPosition.entryPrice;
        const totalSize = initialSize + addSize;
        const totalQty = initialQty + addQty;
        const avgEntryPrice = totalSize / totalQty;

        // Add to existing position (don't create new one)
        parentPosition.collateral += addCollateral;
        parentPosition.size += addSize;
        parentPosition.entryPrice = avgEntryPrice; // Update to weighted average
        parentPosition.pyramidAdded = true;
        parentPosition.pyramidPrice = price;
        // Preserve allocator context for auditability (if present)
        if (options.allocatorScore !== undefined)
          parentPosition.allocatorScore = options.allocatorScore;
        if (options.signal?.strategyType)
          parentPosition.allocatorStrategyType = options.signal.strategyType;

        // CRITICAL: Recalculate liquidation price using new weighted average entry price
        // Liquidation price depends on entry price, so it must be updated after pyramiding
        const leverage = parentPosition.leverage || 1;
        const side = parentPosition.side?.toLowerCase();
        const m = 1 / Math.max(1, leverage);
        const d = avgEntryPrice * m;
        parentPosition.liquidationPrice =
          side === "long" ? Math.max(0.0001, avgEntryPrice - d) : avgEntryPrice + d;

        // Deduct collateral from balance (both live and paper)
        if (this.liveMode) {
          const currentLive = this._getLiveBalanceForStrategy(strategyType) || 0;
          this._setLiveBalanceForStrategy(strategyType, currentLive - addCollateral);
        } else {
          // CRITICAL: Validate sufficient balance in paper mode before pyramiding
          const currentBalance = this._getPaperBalanceForStrategy(strategyType) || 0;
          if (currentBalance < addCollateral) {
            console.error(
              "[DIAGNOSTIC] Pyramid blocked: insufficient paper balance:",
              JSON.stringify({
                market: parentPosition.market,
                side: parentPosition.side,
                currentBalance: currentBalance.toFixed(2),
                addCollateral: addCollateral.toFixed(2),
                shortfall: (addCollateral - currentBalance).toFixed(2),
              })
            );
            errorHandler.log(
              new Error(
                `Insufficient paper balance for pyramid: ${currentBalance.toFixed(2)} < ${addCollateral.toFixed(2)}`
              ),
              {
                category: Category.RISK,
                severity: Severity.MEDIUM,
                context: {
                  currentBalance,
                  addCollateral,
                  shortfall: addCollateral - currentBalance,
                },
              }
            );
            return; // Block pyramid if insufficient balance
          }
          // CRITICAL: Ensure paperBalance never goes negative
          this._setPaperBalanceForStrategy(
            strategyType,
            Math.max(0, currentBalance - addCollateral)
          );
        }

        pretty("pyramid_add", {
          side,
          price,
          addCollateral,
          newTotalSize: parentPosition.size,
          newAvgEntry: avgEntryPrice.toFixed(4),
          newLiqPrice: parentPosition.liquidationPrice.toFixed(4),
          reason: signal?.reason || "pyramid_add",
        });

        return; // Done, position updated
      }

      if (this.openPositions.length >= currentMaxPositions) {
        console.error(
          "[DIAGNOSTIC] Position blocked: max positions limit reached:",
          JSON.stringify({
            market: targetMarket,
            side,
            currentPositions: this.openPositions.length,
            maxPositions: currentMaxPositions,
          })
        );
        errorHandler.log(new Error("Max positions limit reached"), {
          category: Category.RISK,
          severity: Severity.LOW,
          context: { maxPositions: currentMaxPositions, current: this.openPositions.length },
        });
        return;
      }
      if (this.dailyTrades >= currentDailyLimit) {
        console.error(
          "[DIAGNOSTIC] Position blocked: daily trade limit reached:",
          JSON.stringify({
            market: targetMarket,
            side,
            currentDailyTrades: this.dailyTrades,
            dailyLimit: currentDailyLimit,
          })
        );
        errorHandler.log(new Error("Daily trade limit reached"), {
          category: Category.RISK,
          severity: Severity.LOW,
          context: { dailyLimit: currentDailyLimit, current: this.dailyTrades },
        });
        return;
      }

      if (this._isCopyStrategy(strategyType)) {
        const dailyLossConfig = this._getCopyDailyLossConfig();
        const dailyLossUsd = Number(this._copyDailyLossUsd) || 0;
        const maxLossUsd = Number(dailyLossConfig.maxLossUsd) || 0;
        if (dailyLossConfig.enabled && maxLossUsd > 0 && dailyLossUsd >= maxLossUsd) {
          const details = {
            market: targetMarket,
            side,
            dailyLossUsd: Number(dailyLossUsd.toFixed(2)),
            maxLossUsd: Number(maxLossUsd.toFixed(2)),
            baselineUsd: Number((dailyLossConfig.baseline || 0).toFixed(2)),
            stopPercent: dailyLossConfig.percent,
          };

          console.error("[DIAGNOSTIC] Copy daily loss stop: new entries blocked", details);
          this._recordOpenDiagnostic({
            stage: "copy_daily_loss_stop",
            market: targetMarket,
            side,
            ...details,
          });
          errorHandler.log(new Error("Copy daily loss stop triggered"), {
            category: Category.RISK,
            severity: Severity.MEDIUM,
            context: details,
          });
          if (!this._copyDailyLossStopTriggered && this.tg && this.tg.enabled) {
            this.tg.alertRiskViolation("copy_daily_loss_stop", details).catch(() => {});
          }
          this._copyDailyLossStopTriggered = true;
          return;
        }
      }

      // Provider-aware capital: pass market to get correct pool (Jupiter vs Drift)
      const venueRouter = require("./utils/venue-router");
      const marketVenue = venueRouter.getVenueForMarket(targetMarket);
      const availableCapital = this.getAvailableCapital({ market: targetMarket, strategyType });
      const poolLabel = this._isCopyStrategy(strategyType) ? "copy-trading" : marketVenue;
      console.log(
        `[CAPITAL_POOL] ${targetMarket} → ${poolLabel} pool | Available: $${availableCapital.toFixed(2)}`
      );
      const stratForMarket = this._getStrategyInstanceForMarket(targetMarket, strategyType);

      // Minimum capital requirement: prevent opening positions with insufficient capital
      const MIN_CAPITAL_REQUIRED = 5.0; // Minimum $5 required to open a position
      if (availableCapital < MIN_CAPITAL_REQUIRED) {
        const reason = `insufficient_available_capital`;
        const diagnostic = {
          market: targetMarket,
          side,
          price,
          availableCapital: availableCapital.toFixed(2),
          minRequired: MIN_CAPITAL_REQUIRED.toFixed(2),
          shortfall: (MIN_CAPITAL_REQUIRED - availableCapital).toFixed(2),
          reason,
        };
        console.warn(`⚠️  [OPEN_POSITION] Blocked: Insufficient available capital`, diagnostic);
        console.warn(
          `   💰 Available: $${availableCapital.toFixed(2)} | Required: $${MIN_CAPITAL_REQUIRED.toFixed(2)} | Shortfall: $${(MIN_CAPITAL_REQUIRED - availableCapital).toFixed(2)}`
        );
        console.warn(`   📝 Action: Close existing positions or add more capital to wallet`);

        this._recordOpenDiagnostic({
          stage: "insufficient_capital",
          market: targetMarket,
          side,
          availableCapital,
          minRequired: MIN_CAPITAL_REQUIRED,
          reason,
        });

        errorHandler.log(
          new Error(
            `Insufficient available capital: $${availableCapital.toFixed(2)} < $${MIN_CAPITAL_REQUIRED.toFixed(2)}`
          ),
          {
            category: Category.RISK,
            severity: Severity.MEDIUM,
            context: diagnostic,
          }
        );

        return; // Exit early - don't attempt to open position
      }

      // Get expected leverage for position sizing (use max leverage as conservative estimate)
      // Risk manager needs this to properly account for leverage constraints
      let expectedLeverage;

      // If per-market leverage is set, use it consistently for sizing and execution.
      if (hasPerMarketLeverage) {
        expectedLeverage = perMarketLeverage;
        console.log(
          "[LEVERAGE_OVERRIDE] Per-market leverage override detected (used for sizing):",
          {
            market: targetMarket,
            side: side?.toLowerCase(),
            perMarketLeverage,
            envKey: `STRATEGY_${marketKey}_LEVERAGE`,
            globalLong: leverageConfig.long,
            globalShort: leverageConfig.short,
            globalMax: leverageConfig.maxLeverage,
            globalMin: leverageConfig.minLeverage,
          }
        );
      } else if (leverageConfig.dynamic !== false && this.leverageManager) {
        // Use max leverage from leverage manager as estimate
        expectedLeverage =
          this.leverageManager.config?.baseLeverage ||
          this.leverageManager.config?.maxLeverage ||
          leverageConfig?.maxLeverage ||
          leverageConfig?.baseLeverage ||
          6;
      } else {
        // Use static leverage from config
        if (side.toLowerCase() === "long" && leverageConfig.long) {
          expectedLeverage = leverageConfig.long;
        } else if (side.toLowerCase() === "short" && leverageConfig.short) {
          expectedLeverage = leverageConfig.short;
        } else {
          expectedLeverage = leverageConfig.baseLeverage || 1;
        }
      }

      // Copy-trading: optional leader leverage mode (static by default)
      const leaderLeverage = this._getCopyLeaderLeverage(signal);
      if (
        this._isCopyStrategy(strategyType) &&
        leverageConfig.leverageMode === "leader" &&
        Number.isFinite(leaderLeverage) &&
        leaderLeverage > 0
      ) {
        const minLev = Number.isFinite(leverageConfig.minLeverage) ? leverageConfig.minLeverage : 1;
        const maxLev = Number.isFinite(leverageConfig.maxLeverage)
          ? leverageConfig.maxLeverage
          : leaderLeverage;
        expectedLeverage = Math.max(minLev, Math.min(maxLev, leaderLeverage));
      }

      // ------------------------------------------------------------
      // Allocator-driven risk recommendation (post-selection)
      // This must NOT affect allocator selection/scoring, only execution.
      // Leverage interaction: allocator applies multipliers on top of this base leverage.
      // ------------------------------------------------------------
      const isRsiReversion =
        strategyType === "rsi-reversion" || strategyType === "rsi-reversion-alt";
      const isIchimoku = strategyType === "ichimoku-cloud";
      let allocatorRisk = null;
      let allocatorRecommendedSizePct = null;
      let allocatorRecommendedHardStopPercent = null;
      let allocatorRecommendedHardStopAtrMult = null;

      if (
        isIchimoku &&
        this.marketAllocator?.riskRecommendation?.ichimoku?.enabled === true &&
        options?.allocatorRiskMult &&
        typeof options.allocatorRiskMult === "object"
      ) {
        try {
          const baseSizePct = Number(config?.risk?.positionSizePercent);
          const baseLev = Number.isFinite(expectedLeverage) ? expectedLeverage : 1;
          const baseHardStopPercent = Number(stratForMarket?.cfg?.hardStopPercent);
          const baseHardStopAtrMult = Number(stratForMarket?.cfg?.hardStopAtrMult);

          const mult = options.allocatorRiskMult;
          const sizeMult = Number.isFinite(mult.finalSizeMult) ? mult.finalSizeMult : 1;
          const levMult = Number.isFinite(mult.finalLevMult) ? mult.finalLevMult : 1;

          allocatorRecommendedSizePct =
            Number.isFinite(baseSizePct) && baseSizePct > 0 ? baseSizePct * sizeMult : null;

          let lev = baseLev * levMult;
          // Mirror allocator rounding/clamps (recommendRisk()).
          const step = Number(this.marketAllocator?.riskRecommendation?.leverage?.roundStep);
          if (Number.isFinite(step) && step > 0) lev = Math.round(lev / step) * step;
          const levMin = Number(this.marketAllocator?.riskRecommendation?.leverage?.min ?? 1);
          const levMax = Number(this.marketAllocator?.riskRecommendation?.leverage?.max ?? 100);
          lev = Math.max(levMin, Math.min(levMax, lev));

          // Apply recommended leverage for sizing + execution.
          expectedLeverage = lev;

          // Price-space invariant: scale hard stop % proportionally with leverage.
          allocatorRecommendedHardStopPercent =
            Number.isFinite(baseHardStopPercent) && baseHardStopPercent > 0 && baseLev > 0
              ? baseHardStopPercent * (lev / baseLev)
              : null;
          allocatorRecommendedHardStopAtrMult =
            Number.isFinite(baseHardStopAtrMult) && baseHardStopAtrMult > 0
              ? baseHardStopAtrMult
              : null;

          allocatorRisk = {
            quality: mult.quality,
            rankMult: mult.rankMult,
            sizePct: allocatorRecommendedSizePct,
            leverage: lev,
            hardStopPercent: allocatorRecommendedHardStopPercent,
            hardStopAtrMult: allocatorRecommendedHardStopAtrMult,
          };

          if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
            console.log("[ALLOCATOR_RISK] multipliers (ICHIMOKU)", {
              market: targetMarket,
              side: side?.toLowerCase(),
              score: allocatorScore,
              base: {
                sizePct: baseSizePct,
                leverage: baseLev,
                hardStopPercent: baseHardStopPercent,
                hardStopAtrMult: baseHardStopAtrMult,
              },
              mult,
              recommended: allocatorRisk,
            });
          }
        } catch (e) {
          // Fail-safe: allocator risk must never block opening a position
          if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
            console.warn("[ALLOCATOR_RISK] recommendRisk failed (ignored):", e?.message || e);
          }
        }
      } else if (
        isRsiReversion &&
        this.marketAllocator &&
        typeof this.marketAllocator.recommendRisk === "function"
      ) {
        try {
          const baseRiskCfg = this.riskManager?.getRiskConfigForMarket
            ? this.riskManager.getRiskConfigForMarket(targetMarket)
            : this.riskManager?.config || {};

          const baseSizePct = Number(config?.risk?.positionSizePercent);
          const baseHardStopPercent = Number(baseRiskCfg?.stopLossPercent);
          const baseHardStopAtrMult = Number(stratForMarket?.cfg?.rsiHardStopAtr);

          const scoreNum = Number(allocatorScore);
          const scoreSafe = Number.isFinite(scoreNum) ? scoreNum : 0;

          allocatorRisk = this.marketAllocator.recommendRisk({
            market: targetMarket,
            signal,
            priceData: priceData || { price },
            score: scoreSafe,
            strategyType,
            base: {
              sizePct: Number.isFinite(baseSizePct) ? baseSizePct : 0,
              leverage: Number.isFinite(expectedLeverage) ? expectedLeverage : 1,
              hardStopPercent: Number.isFinite(baseHardStopPercent) ? baseHardStopPercent : 0,
              hardStopAtrMult: Number.isFinite(baseHardStopAtrMult) ? baseHardStopAtrMult : 0,
            },
          });

          if (allocatorRisk && typeof allocatorRisk === "object") {
            // Capture recommended sizing/stops (applied later when position is created)
            allocatorRecommendedSizePct = Number.isFinite(allocatorRisk.sizePct)
              ? allocatorRisk.sizePct
              : null;
            allocatorRecommendedHardStopPercent = Number.isFinite(allocatorRisk.hardStopPercent)
              ? allocatorRisk.hardStopPercent
              : null;
            allocatorRecommendedHardStopAtrMult = Number.isFinite(allocatorRisk.hardStopAtrMult)
              ? allocatorRisk.hardStopAtrMult
              : null;
          }

          if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
            console.log("[ALLOCATOR_RISK] recommendRisk (RSI)", {
              market: targetMarket,
              side: side?.toLowerCase(),
              score: scoreSafe,
              base: {
                sizePct: baseSizePct,
                leverage: Number.isFinite(expectedLeverage) ? expectedLeverage : null,
                hardStopPercent: baseHardStopPercent,
                hardStopAtrMult: baseHardStopAtrMult,
              },
              recommended: allocatorRisk,
            });
          }
        } catch (e) {
          // Fail-safe: allocator risk must never block opening a position
          if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
            console.warn("[ALLOCATOR_RISK] recommendRisk failed (ignored):", e?.message || e);
          }
        }
      }

      // Position sizing: respect POSITION_SIZING_METHOD config
      // Risk manager now returns base size (collateral) accounting for leverage constraints
      let collateral;
      const atr = stratForMarket?.atr;
      const usedAtrMult =
        stratForMarket?.cfg?.atrStopMultiplier ?? config.strategy.atrStopMultiplier ?? 2.8;
      const stopDistance = Number.isFinite(atr) && atr > 0 ? atr * usedAtrMult : null;

      // Explicitly pass sizing method to ensure it's respected
      const sizingMethod = config.risk.sizingMethod || config.risk.forceSizingMethod || "percent";
      const sizingOpts = {
        price,
        equity: availableCapital,
        leverage: expectedLeverage,
        market: targetMarket,
        strategyType,
        minNotional: config.risk.minPositionSize || 50, // Minimum position size in USD
        forceSizingMethod: sizingMethod, // Explicitly pass sizing method
        // For volatility-scaled sizing
        atr: atr,
        volatilityScaleBase: parseFloat(process.env.VOLATILITY_SCALE_BASE) || 0.015,
        // For kelly sizing
        kellyFraction: parseFloat(process.env.KELLY_FRACTION) || 0.25,
      };
      if (Number.isFinite(Number(signal?.sizeFraction)) && Number(signal.sizeFraction) > 0) {
        sizingOpts.sizeFraction = Number(signal.sizeFraction);
      }
      if (
        (isRsiReversion || isIchimoku) &&
        Number.isFinite(allocatorRecommendedSizePct) &&
        allocatorRecommendedSizePct > 0
      ) {
        sizingOpts.positionSizePercentOverride = allocatorRecommendedSizePct;
      }

      // DEBUG: Log position sizing inputs and verify config
      console.log("[POSITION_SIZING] Inputs:", {
        availableCapital: availableCapital.toFixed(2),
        positionSizePercent: config.risk.positionSizePercent,
        sizingMethod: sizingMethod,
        expectedLeverage: expectedLeverage,
        stopDistance: stopDistance,
        hasStrategyMethod:
          USE_ENHANCED_STRATEGY &&
          ((stratForMarket && typeof stratForMarket.getRecommendedPositionSize === "function") ||
            (this.strategy && typeof this.strategy.getRecommendedPositionSize === "function")),
      });
      // Verify config is correctly read
      console.log("[POSITION_SIZING] Config verification:", {
        "config.risk.positionSizePercent": config.risk.positionSizePercent,
        "config.risk.sizingMethod": config.risk.sizingMethod,
        "config.risk.forceSizingMethod": config.risk.forceSizingMethod,
        "this.config?.risk?.positionSizePercent": this.config?.risk?.positionSizePercent,
        "this.riskManager.config.positionSizePercent":
          this.riskManager?.config?.positionSizePercent,
        "ENV POSITION_SIZE_PERCENT": process.env.POSITION_SIZE_PERCENT,
        "ENV POSITION_SIZING_METHOD": process.env.POSITION_SIZING_METHOD,
      });

      if (sizingMethod === "percent") {
        // Percent-based sizing: ignore stopDistance, use positionSizePercent directly
        console.log("[POSITION_SIZING] Using percent-based sizing path");
        collateral = this.riskManager.calculatePositionSize(availableCapital, sizingOpts);
        console.log("[POSITION_SIZING] Risk manager returned collateral:", collateral.toFixed(2));
      } else if (sizingMethod === "volatility-scaled") {
        // Volatility-scaled sizing: size inversely to ATR
        console.log("[POSITION_SIZING] Using volatility-scaled sizing path");
        collateral = this.riskManager.calculatePositionSize(availableCapital, sizingOpts);
        console.log("[POSITION_SIZING] Risk manager returned collateral:", collateral.toFixed(2));
      } else if (sizingMethod === "kelly") {
        // Kelly criterion sizing
        console.log("[POSITION_SIZING] Using kelly sizing path");
        collateral = this.riskManager.calculatePositionSize(availableCapital, sizingOpts);
        console.log("[POSITION_SIZING] Risk manager returned collateral:", collateral.toFixed(2));
      } else if (Number.isFinite(stopDistance) && stopDistance > 0) {
        // Equal-risk sizing: use ATR stop distance
        console.log("[POSITION_SIZING] Using equal-risk sizing path");
        sizingOpts.stopDistance = stopDistance;
        collateral = this.riskManager.calculatePositionSize(availableCapital, sizingOpts);
        console.log("[POSITION_SIZING] Risk manager returned collateral:", collateral.toFixed(2));
      } else if (
        USE_ENHANCED_STRATEGY &&
        ((stratForMarket && typeof stratForMarket.getRecommendedPositionSize === "function") ||
          (this.strategy && typeof this.strategy.getRecommendedPositionSize === "function"))
      ) {
        console.log(
          "[POSITION_SIZING] Using strategy getRecommendedPositionSize path (BYPASSING RISK MANAGER)"
        );
        const sizingFn =
          stratForMarket && typeof stratForMarket.getRecommendedPositionSize === "function"
            ? stratForMarket.getRecommendedPositionSize.bind(stratForMarket)
            : this.strategy.getRecommendedPositionSize.bind(this.strategy);
        let recommendedSize = sizingFn(price, side.toLowerCase());
        console.log(
          "[POSITION_SIZING] Strategy recommended size (raw):",
          recommendedSize,
          "(percentage)"
        );

        // CRITICAL: Cap strategy recommendation to positionSizePercent BEFORE calculating collateral
        // This prevents the strategy from recommending more than the configured position size
        const positionSizePercentDecimal = config.risk.positionSizePercent / 100;
        if (recommendedSize > positionSizePercentDecimal) {
          console.warn(
            "[POSITION_SIZING] WARNING: Strategy recommended size",
            recommendedSize,
            "exceeds positionSizePercent",
            positionSizePercentDecimal,
            "- capping strategy recommendation"
          );
          recommendedSize = positionSizePercentDecimal;
        }

        console.log(
          "[POSITION_SIZING] Strategy recommended size (capped):",
          recommendedSize,
          "(percentage)"
        );
        console.log("[POSITION_SIZING] Available capital:", availableCapital.toFixed(2));
        console.log(
          "[POSITION_SIZING] Config positionSizePercent:",
          config.risk.positionSizePercent,
          "%"
        );

        // Calculate collateral from capped strategy recommendation
        collateral = availableCapital * recommendedSize;
        console.log(
          "[POSITION_SIZING] Final collateral (availableCapital * cappedRecommendedSize):",
          collateral.toFixed(2)
        );
      } else {
        // Fallback: risk manager will use default sizing method
        console.log("[POSITION_SIZING] Using fallback path (risk manager)");
        collateral = this.riskManager.calculatePositionSize(availableCapital, sizingOpts);
        console.log("[POSITION_SIZING] Risk manager returned collateral:", collateral.toFixed(2));
      }

      // Apply allocator size recommendation as a multiplier for NON-percent sizing methods.
      // For percent sizing, the risk manager already respects positionSizePercentOverride directly.
      if (
        (isRsiReversion || isIchimoku) &&
        sizingMethod !== "percent" &&
        Number.isFinite(allocatorRecommendedSizePct) &&
        allocatorRecommendedSizePct > 0 &&
        Number.isFinite(config?.risk?.positionSizePercent) &&
        config.risk.positionSizePercent > 0
      ) {
        const basePct = Number(config.risk.positionSizePercent);
        const mult = allocatorRecommendedSizePct / basePct;
        if (Number.isFinite(mult) && mult > 0) {
          collateral = collateral * mult;
        }
      }

      // Safety clamp: never exceed available capital after multipliers.
      if (Number.isFinite(collateral) && collateral > availableCapital + 0.01) {
        collateral = Math.max(0, availableCapital * 0.95);
      }

      // Apply min/max constraints (after all sizing adjustments)
      // Use strategy env manager to get market-specific min/max from isolated env (prevents .env bleeding)
      const marketMinPos = strategyEnvManager
        ? Number(
            strategyEnvManager.getMarketConfig(targetMarket, "MIN_POSITION_SIZE", 0, strategyType)
          )
        : Number.isFinite(config?.risk?.minPositionSize)
          ? Number(config.risk.minPositionSize)
          : 0;
      const marketMaxPos = strategyEnvManager
        ? Number(
            strategyEnvManager.getMarketConfig(
              targetMarket,
              "MAX_POSITION_SIZE",
              Infinity,
              strategyType
            )
          )
        : Number.isFinite(config?.risk?.maxPositionSize)
          ? Number(config.risk.maxPositionSize)
          : Infinity;

      console.log("[POSITION_SIZING] Min/max constraints:", {
        market: targetMarket,
        minPos: marketMinPos,
        maxPos: marketMaxPos,
        source: strategyEnvManager ? "strategy-env-manager" : "global-config",
      });

      if (Number.isFinite(collateral)) {
        collateral = Math.max(collateral, marketMinPos);
        collateral = Math.min(collateral, marketMaxPos);
      }

      // CRITICAL: Validate collateral after risk manager calculation
      // Risk manager can return 0 if availableCapital <= 0 or constraints are too restrictive
      if (!Number.isFinite(collateral) || collateral <= 0) {
        console.error(
          "[DIAGNOSTIC] Position blocked: risk manager returned invalid collateral:",
          JSON.stringify({
            market: targetMarket,
            side,
            collateral,
            availableCapital,
            expectedLeverage,
            sizingMethod,
            stopDistance,
          })
        );
        errorHandler.log(new Error("Risk manager returned 0 or invalid collateral"), {
          category: Category.RISK,
          severity: Severity.MEDIUM,
          context: {
            collateral,
            availableCapital,
            expectedLeverage,
            sizingMethod,
            stopDistance,
          },
        });
        return;
      }

      // Calculate actual leverage: dynamic if enabled, otherwise use static
      // This may differ slightly from expectedLeverage, but usually close enough
      let leverage;
      let leverageAdjustments = null;

      // Get market-specific strategy for leverage calculation
      const strategyForLeverage = stratForMarket;

      // DEBUG: Log leverage calculation inputs
      console.log("[LEVERAGE_CALC] Inputs:", {
        dynamic: leverageConfig.dynamic,
        side: side.toLowerCase(),
        "config.leverage.long": leverageConfig.long,
        "config.leverage.short": leverageConfig.short,
        "config.leverage.baseLeverage": leverageConfig.baseLeverage,
        "config.leverage.maxLeverage": leverageConfig.maxLeverage,
        "config.leverage.minLeverage": leverageConfig.minLeverage,
        hasStrategy: !!strategyForLeverage,
      });

      if (leverageConfig.dynamic === true) {
        // Use dynamic leverage calculation
        try {
          // Funding rate disabled to avoid geo-restricted Binance API
          // Not critical for momentum strategy - defaults to 0
          let fundingRate = 0;
          if (process.env.ENABLE_FUNDING_RATE_FETCH === "true") {
            try {
              const fundingInfo = await this.fundingMonitor.getFundingRate(targetMarket);
              fundingRate = fundingInfo || 0;
            } catch (e) {
              // Funding rate unavailable, use 0
            }
          }

          // Get current balance for drawdown protection
          const currentBalance = availableCapital;

          // Calculate dynamic leverage using market-specific strategy
          const leverageResult = this.leverageManager.calculateLeverage({
            price,
            side: side.toLowerCase(),
            strategy: strategyForLeverage, // Use market-specific strategy
            positions: this.openPositions,
            availableCapital,
            portfolioRisk: this.portfolioRisk,
            fundingRate,
            currentBalance,
          });

          leverage = leverageResult.leverage;
          leverageAdjustments = leverageResult.adjustments;

          console.log("[LEVERAGE_CALC] Dynamic leverage result:", {
            leverage,
            baseLeverage: leverageResult.baseLeverage,
            reason: leverageResult.reason,
            adjustments: leverageAdjustments,
          });

          if (config.leverage.verbose !== false) {
            pretty("leverage", {
              side,
              leverage,
              base: leverageResult.baseLeverage,
              reason: leverageResult.reason,
              adjustments: leverageAdjustments,
            });
          }
        } catch (error) {
          // Fallback to static leverage if dynamic calculation fails
          console.error(
            "[LEVERAGE_CALC] Dynamic leverage calculation failed, falling back to static:",
            error.message
          );
          errorHandler.log(error, {
            category: Category.RISK,
            severity: Severity.LOW,
            context: { side, fallbackToStatic: true },
          });
          // Use static leverage as fallback
          if (side.toLowerCase() === "long" && leverageConfig.long) {
            leverage = leverageConfig.long;
          } else if (side.toLowerCase() === "short" && leverageConfig.short) {
            leverage = leverageConfig.short;
          } else {
            leverage = leverageConfig.maxLeverage || leverageConfig.baseLeverage || 1;
          }
        }
      } else {
        // Use static leverage from config (long/short specific, fallback to maxLeverage, then baseLeverage)
        // This ensures LEVERAGE_MAX is respected when LEVERAGE_LONG/LEVERAGE_SHORT are not set
        console.log("[LEVERAGE_CALC] Using static leverage path");
        if (
          side.toLowerCase() === "long" &&
          leverageConfig.long !== undefined &&
          leverageConfig.long !== null
        ) {
          leverage = leverageConfig.long;
          console.log("[LEVERAGE_CALC] Using LEVERAGE_LONG:", leverage);
        } else if (
          side.toLowerCase() === "short" &&
          leverageConfig.short !== undefined &&
          leverageConfig.short !== null
        ) {
          leverage = leverageConfig.short;
          console.log("[LEVERAGE_CALC] Using LEVERAGE_SHORT:", leverage);
        } else {
          // Fallback to maxLeverage (from LEVERAGE_MAX) if set, otherwise use baseLeverage
          leverage = leverageConfig.maxLeverage || leverageConfig.baseLeverage || 1;
          console.log(
            "[LEVERAGE_CALC] Using fallback leverage (maxLeverage/baseLeverage):",
            leverage
          );
        }

        // Cap static leverage at maxLeverage to respect LEVERAGE_MAX setting
        const maxLeverage = leverageConfig.maxLeverage;
        if (maxLeverage !== undefined && maxLeverage !== null && leverage > maxLeverage) {
          console.log(
            "[LEVERAGE_CALC] Capping leverage at maxLeverage:",
            maxLeverage,
            "(was:",
            leverage,
            ")"
          );
          leverage = maxLeverage;
        }

        // Ensure leverage is at least minLeverage
        const minLeverage = leverageConfig.minLeverage;
        if (minLeverage !== undefined && minLeverage !== null && leverage < minLeverage) {
          console.log(
            "[LEVERAGE_CALC] Raising leverage to minLeverage:",
            minLeverage,
            "(was:",
            leverage,
            ")"
          );
          leverage = minLeverage;
        }

        console.log("[LEVERAGE_CALC] Final static leverage:", leverage);
      }

      // Apply per-market leverage override AFTER dynamic/static computation.
      // This ensures overrides work even when global LEVERAGE_MAX/LEVERAGE_LONG/SHORT are fixed.
      if (hasPerMarketLeverage) {
        const oldLeverage = leverage;
        leverage = perMarketLeverage;

        // Safety cap: don't allow per-market leverage to exceed portfolio max leverage config (if set).
        // MAX_TOTAL_LEVERAGE is a portfolio-level guard, but it's a reasonable upper bound for fixed overrides.
        const maxAllowed = this.portfolioRisk?.maxTotalLeverage ?? config.risk?.maxTotalLeverage;
        if (Number.isFinite(maxAllowed) && maxAllowed > 0 && leverage > maxAllowed) {
          console.warn(
            "[LEVERAGE_OVERRIDE] Per-market leverage exceeds maxTotalLeverage, capping:",
            {
              market: targetMarket,
              requested: leverage,
              cappedTo: maxAllowed,
              maxTotalLeverage: maxAllowed,
            }
          );
          leverage = maxAllowed;
        }

        leverageAdjustments = { ...(leverageAdjustments || {}), perMarketOverride: true };
        console.log(
          "[LEVERAGE_OVERRIDE] Applied per-market leverage override (used for execution):",
          {
            market: targetMarket,
            side: side?.toLowerCase(),
            from: oldLeverage,
            to: leverage,
            envKey: `STRATEGY_${marketKey}_LEVERAGE`,
          }
        );
      }

      // Allocator-driven leverage adjustment (post-selection, RSI-only)
      // Apply after dynamic/static/per-market leverage has been determined so allocator acts as a multiplier on that base.
      if (
        isRsiReversion &&
        this.marketAllocator &&
        typeof this.marketAllocator.recommendRisk === "function"
      ) {
        try {
          const baseRiskCfg = this.riskManager?.getRiskConfigForMarket
            ? this.riskManager.getRiskConfigForMarket(targetMarket)
            : this.riskManager?.config || {};
          const baseSizePct = Number(config?.risk?.positionSizePercent);
          const baseHardStopPercent = Number(baseRiskCfg?.stopLossPercent);
          const baseHardStopAtrMult = Number(stratForMarket?.cfg?.rsiHardStopAtr);
          const scoreNum = Number(allocatorScore);
          const scoreSafe = Number.isFinite(scoreNum) ? scoreNum : 0;

          const leverageBeforeAllocator = leverage;
          const lr = this.marketAllocator.recommendRisk({
            market: targetMarket,
            signal,
            priceData: priceData || { price },
            score: scoreSafe,
            strategyType,
            base: {
              sizePct: Number.isFinite(baseSizePct) ? baseSizePct : 0,
              leverage: Number.isFinite(leverage) ? leverage : 1,
              hardStopPercent: Number.isFinite(baseHardStopPercent) ? baseHardStopPercent : 0,
              hardStopAtrMult: Number.isFinite(baseHardStopAtrMult) ? baseHardStopAtrMult : 0,
            },
          });

          if (lr && Number.isFinite(lr.leverage) && lr.leverage > 0) {
            leverage = lr.leverage;
          }
          if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
            console.log("[ALLOCATOR_RISK] leverage adjusted (RSI)", {
              market: targetMarket,
              side: side?.toLowerCase(),
              score: scoreSafe,
              leverageBase: Number.isFinite(leverageBeforeAllocator)
                ? leverageBeforeAllocator
                : null,
              leverageFinal: Number.isFinite(leverage) ? leverage : null,
              quality: lr?.quality,
            });
          }
        } catch (e) {
          if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
            console.warn("[ALLOCATOR_RISK] leverage adjustment failed (ignored):", e?.message || e);
          }
        }
      }

      // Copy-trading: enforce leader leverage mode for execution (if configured)
      if (
        this._isCopyStrategy(strategyType) &&
        leverageConfig.leverageMode === "leader" &&
        Number.isFinite(leaderLeverage) &&
        leaderLeverage > 0
      ) {
        const minLev = Number.isFinite(leverageConfig.minLeverage) ? leverageConfig.minLeverage : 1;
        const maxLev = Number.isFinite(leverageConfig.maxLeverage)
          ? leverageConfig.maxLeverage
          : leaderLeverage;
        const oldLeverage = leverage;
        leverage = Math.max(minLev, Math.min(maxLev, leaderLeverage));
        leverageAdjustments = { ...(leverageAdjustments || {}), leaderLeverage };
        console.log("[COPY_LEVERAGE] Using leader leverage override:", {
          market: targetMarket,
          side: side?.toLowerCase(),
          from: oldLeverage,
          to: leverage,
          leaderLeverage,
          minLev,
          maxLev,
        });
      }

      // CRITICAL: Validate leverage is valid and > 0
      // Leverage must be > 0 to avoid 0-size positions (size = collateral * leverage)

      // Final validation: Log final leverage before opening position
      console.log("[LEVERAGE_CALC] Final leverage for position:", {
        market: targetMarket,
        side,
        leverage,
        expectedLeverage,
        "config.leverage.dynamic": leverageConfig.dynamic,
        "config.leverage.long": leverageConfig.long,
        "config.leverage.short": leverageConfig.short,
        "config.leverage.baseLeverage": leverageConfig.baseLeverage,
        "config.leverage.maxLeverage": leverageConfig.maxLeverage,
        "config.leverage.minLeverage": leverageConfig.minLeverage,
      });

      if (!Number.isFinite(leverage) || leverage <= 0) {
        console.error(
          "[DIAGNOSTIC] Position blocked: invalid leverage:",
          JSON.stringify({
            market: targetMarket,
            side,
            leverage,
            collateral,
            availableCapital,
            "config.leverage.dynamic": leverageConfig.dynamic,
            "config.leverage.long": leverageConfig.long,
            "config.leverage.short": leverageConfig.short,
            "config.leverage.baseLeverage": leverageConfig.baseLeverage,
            "config.leverage.maxLeverage": leverageConfig.maxLeverage,
            "config.leverage.minLeverage": leverageConfig.minLeverage,
          })
        );
        errorHandler.log(new Error("Invalid leverage calculated"), {
          category: Category.RISK,
          severity: Severity.HIGH,
          context: {
            leverage,
            collateral,
            availableCapital,
            side,
          },
        });
        return;
      }

      // Adjust collateral if actual leverage differs significantly from expected
      // (Usually they're close, so this is rarely needed)
      if (Math.abs(leverage - expectedLeverage) > 0.5 && collateral > 0) {
        // Recalculate with actual leverage if difference is significant
        const recalcOpts = {
          price,
          equity: availableCapital,
          leverage: leverage,
          market: targetMarket,
          minNotional: config.risk.minPositionSize || 50, // Minimum position size in USD
          forceSizingMethod: sizingMethod, // Preserve sizing method
        };
        if (
          isRsiReversion &&
          Number.isFinite(allocatorRecommendedSizePct) &&
          allocatorRecommendedSizePct > 0
        ) {
          recalcOpts.positionSizePercentOverride = allocatorRecommendedSizePct;
        }
        if (sizingMethod === "percent") {
          // Percent-based: ignore stopDistance
          collateral = this.riskManager.calculatePositionSize(availableCapital, recalcOpts);
        } else if (Number.isFinite(stopDistance) && stopDistance > 0) {
          // Equal-risk: use stopDistance
          recalcOpts.stopDistance = stopDistance;
          collateral = this.riskManager.calculatePositionSize(availableCapital, recalcOpts);
        } else {
          collateral = this.riskManager.calculatePositionSize(availableCapital, recalcOpts);
        }
      }

      // Portfolio-level risk check (exclude manual positions)
      const automatedPositions = this._getAutomatedPositions();
      const newPosition = {
        side: side.toLowerCase(),
        collateral,
        leverage,
        size: collateral * leverage,
      };
      const portfolioCheck = this.portfolioRisk.canOpenPosition(
        automatedPositions,
        newPosition,
        availableCapital
      );

      if (!portfolioCheck.canOpen) {
        const lockedCapital = this.getLockedCapital();
        const totalEquity = this.getTotalEquity();
        // Include position breakdown for debugging
        const manualPositions = this.openPositions.filter((p) => this._isManualPosition(p));
        console.error(
          "[DIAGNOSTIC] Position blocked: portfolio risk limit exceeded:",
          JSON.stringify({
            market: targetMarket,
            side,
            collateral,
            leverage,
            checks: portfolioCheck.checks,
            totalExposure: portfolioCheck.totalExposure,
            totalLeverage: portfolioCheck.totalLeverage,
            availableCapital,
            lockedCapital,
            totalEquity,
            maxTotalLeverage: this.portfolioRisk.maxTotalLeverage,
            automatedCount: automatedPositions.length,
            manualCount: manualPositions.length,
            totalPositions: this.openPositions.length,
          })
        );
        // Log position details if any automated positions exist
        if (automatedPositions.length > 0) {
          console.error(
            "[DIAGNOSTIC] Automated positions in risk calc:",
            automatedPositions.map((p) => ({
              id: p.positionId?.slice(0, 8),
              market: p.market,
              side: p.side,
              size: p.size,
              collateral: p.collateral,
              trade_type: p.trade_type,
            }))
          );
        }
        errorHandler.log(new Error("Portfolio risk limit exceeded"), {
          category: Category.RISK,
          severity: Severity.MEDIUM,
          context: {
            checks: portfolioCheck.checks,
            totalExposure: portfolioCheck.totalExposure,
            totalLeverage: portfolioCheck.totalLeverage,
          },
        });
        return;
      }

      // Adjust position size based on portfolio limits if needed (exclude manual positions)
      console.log("[POSITION_SIZING] Before portfolio adjustment:", {
        collateral: collateral.toFixed(2),
        leverage: leverage,
        notional: (collateral * leverage).toFixed(2),
      });
      // Reuse automatedPositions from portfolio check above
      const adjusted = this.portfolioRisk.adjustPositionSize(
        collateral * leverage,
        automatedPositions,
        availableCapital
      );
      if (adjusted.reason) {
        const oldCollateral = collateral;
        collateral = adjusted.adjustedSize / leverage;
        console.log("[POSITION_SIZING] Portfolio adjustment applied:", {
          oldCollateral: oldCollateral.toFixed(2),
          newCollateral: collateral.toFixed(2),
          reason: adjusted.reason,
        });
        errorHandler.log(new Error("Position size adjusted due to portfolio limits"), {
          category: Category.RISK,
          severity: Severity.LOW,
          context: {
            requested: collateral * leverage,
            adjusted: adjusted.adjustedSize,
            reason: adjusted.reason,
          },
        });
      } else {
        console.log("[POSITION_SIZING] No portfolio adjustment needed");
      }
      console.log("[POSITION_SIZING] Final collateral:", collateral.toFixed(2));

      // CRITICAL: Validate collateral is valid and positive
      // Portfolio adjustment can reduce collateral to 0, which would create a 0-size position
      if (!Number.isFinite(collateral) || collateral <= 0) {
        console.error(
          "[DIAGNOSTIC] Position blocked: collateral invalid or zero:",
          JSON.stringify({
            market: targetMarket,
            side,
            collateral,
            adjustedSize: adjusted?.adjustedSize,
            leverage,
            availableCapital,
          })
        );
        errorHandler.log(new Error("Position size invalid or zero after portfolio adjustment"), {
          category: Category.RISK,
          severity: Severity.MEDIUM,
          context: {
            collateral,
            adjustedSize: adjusted?.adjustedSize,
            leverage,
            reason: adjusted?.reason,
          },
        });
        return;
      }

      // Slippage & liquidity / impact validation
      // NOTE: Skip slippage validation for perps trades - perps don't go through Jupiter swaps
      // Perps have their own on-chain slippage protection, and Jupiter swap quotes don't apply
      // In paper mode, slippage validation is unnecessary (simulation)
      // In live mode, slippage is handled by the perps protocol itself
      const baseSymbol = targetMarket.split("-")[0];
      const skipSlippageValidation = true; // Always skip for perps (swap quotes don't apply)

      if (!skipSlippageValidation && config.tokens[baseSymbol] && config.quoteMint) {
        const slippageCheck = await this.slippageValidator.validateSlippage(
          config.tokens[baseSymbol],
          config.quoteMint,
          collateral.toString(),
          price,
          MAX_SLIPPAGE_BPS,
          { showRoutePlan: true, swapMode: "ExactIn" }
        );

        if (!slippageCheck.valid) {
          console.error(
            "[DIAGNOSTIC] Position blocked: slippage validation failed:",
            JSON.stringify({
              market: targetMarket,
              side,
              price,
              collateral,
              reason: slippageCheck.reason,
              slippageBps: slippageCheck.slippage?.slippageBps,
            })
          );
          errorHandler.log(new Error(`Slippage validation failed: ${slippageCheck.reason}`), {
            category: Category.VALIDATION,
            severity: Severity.MEDIUM,
            context: { slippageCheck, side, price, collateral },
          });
          pretty("slippage_block", {
            side,
            reason: slippageCheck.reason,
            slippageBps: slippageCheck.slippage?.slippageBps,
          });
          return;
        }

        const impactAssessment = await this.slippageValidator.assessMarketImpact({
          inputMint: config.tokens[baseSymbol],
          outputMint: config.quoteMint,
          amount: collateral.toString(),
          expectedPrice: price,
          maxImpactBps: MAX_MARKET_IMPACT_BPS,
          quote: slippageCheck.quote,
          steps: MARKET_IMPACT_STEPS,
        });

        if (!impactAssessment.valid) {
          console.error(
            "[DIAGNOSTIC] Position blocked: market impact exceeds threshold:",
            JSON.stringify({
              market: targetMarket,
              side,
              price,
              collateral,
              thresholdBps: impactAssessment.thresholdBps,
              maxImpactBps: impactAssessment.maxImpactBps,
              steps: impactAssessment.steps,
            })
          );
          errorHandler.log(new Error("Market impact exceeds threshold"), {
            category: Category.VALIDATION,
            severity: Severity.MEDIUM,
            context: {
              side,
              price,
              collateral,
              impact: impactAssessment,
            },
          });

          pretty("impact_block", {
            side,
            thresholdBps: impactAssessment.thresholdBps,
            maxImpactBps: impactAssessment.maxImpactBps,
            steps: impactAssessment.steps,
          });
          return;
        }

        pretty("impact_ok", {
          side,
          thresholdBps: impactAssessment.thresholdBps,
          maxImpactBps: impactAssessment.maxImpactBps,
        });
      }

      this._recordOpenDiagnostic({
        stage: "pre_guard",
        market: targetMarket,
        side,
        price,
        collateral,
        leverage,
        signalScore: signal?.confidence ?? signal?.score ?? null,
      });

      // Guarded approval
      const approval = await this.guard.guard("open", { side, price, collateral, leverage });
      if (!approval.approved) {
        console.error(
          "[DIAGNOSTIC] Position blocked by guard approval:",
          JSON.stringify({
            market: targetMarket,
            side,
            price,
            collateral,
            leverage,
            mode: this.guard.mode,
          })
        );
        this._recordOpenDiagnostic({
          stage: "guard_block",
          market: targetMarket,
          side,
          reason: approval.reason || approval.detail || "guard_reject",
        });
        return;
      }

      // ------------------------------------------------------------
      // Drift shadow / limited-live gate PRE-CHECK
      // IMPORTANT: Early check before order reservation to avoid wasted work.
      // VenueAwareTradeExecutor will also check and handle shadow recording.
      // ------------------------------------------------------------
      try {
        const venueRouter = require("./utils/venue-router");
        const venue = venueRouter.getVenueForMarket(targetMarket);
        const notionalSize = collateral * leverage;

        if (venue === venueRouter.VENUE.DRIFT) {
          const canOpen =
            this.limitedLiveController &&
            typeof this.limitedLiveController.canOpenPosition === "function"
              ? this.limitedLiveController.canOpenPosition(targetMarket, notionalSize)
              : { allowed: true };

          if (!canOpen.allowed) {
            const reason = canOpen.reason || "blocked_by_limited_live";
            console.log(`[DRIFT] Pre-check blocked: ${targetMarket} (${reason})`);

            this._recordOpenDiagnostic({
              stage: "drift_precheck_blocked",
              market: targetMarket,
              side,
              price,
              collateral,
              leverage,
              notionalSize,
              reason,
              liveState: this.limitedLiveController?.state,
              shadowEnabled: !!this.shadowManager?.enabled,
            });

            // NOTE: Shadow trade recording moved to VenueAwareTradeExecutor
            // Returning early here to avoid order reservation for blocked trades
            return;
          }
        }
      } catch (e) {
        console.warn(
          `[DRIFT] Pre-check failed (continuing, executor will also check): ${e?.message || e}`
        );
      }

      // CRITICAL: Validate sufficient balance (including fees) in paper mode before opening
      if (!this.liveMode) {
        const notionalSize = collateral * leverage;
        const feeCfg = config.fees || {};
        const baseFee = (notionalSize * (feeCfg.openFeeBps || 6)) / 10_000;
        let priceImpactFee = 0;
        if (feeCfg.enablePriceImpactFee !== false) {
          const priceImpactFeeScalar = feeCfg.priceImpactFeeScalar || 125_000_000_000;
          const coefficient = notionalSize / priceImpactFeeScalar;
          priceImpactFee = notionalSize * coefficient;
        }
        const openFee = baseFee + priceImpactFee;
        const totalRequired = collateral + openFee;
        const currentBalance = this.paperBalance || 0;

        if (currentBalance < totalRequired) {
          console.error(
            "[DIAGNOSTIC] Position blocked: insufficient paper balance:",
            JSON.stringify({
              market: targetMarket,
              side,
              currentBalance: currentBalance.toFixed(2),
              collateral: collateral.toFixed(2),
              openFee: openFee.toFixed(2),
              totalRequired: totalRequired.toFixed(2),
              shortfall: (totalRequired - currentBalance).toFixed(2),
            })
          );
          this._recordOpenDiagnostic({
            stage: "balance_block",
            market: targetMarket,
            side,
            collateral,
            leverage,
            balance: currentBalance,
            required: totalRequired,
          });
          errorHandler.log(
            new Error(
              `Insufficient paper balance: ${currentBalance.toFixed(2)} < ${totalRequired.toFixed(2)} (collateral: ${collateral.toFixed(2)} + fee: ${openFee.toFixed(2)})`
            ),
            {
              category: Category.RISK,
              severity: Severity.HIGH,
              context: {
                currentBalance,
                totalRequired,
                collateral,
                openFee,
                shortfall: totalRequired - currentBalance,
              },
            }
          );
          return;
        }
      }

      const normalizedSide = String(side || "").toLowerCase();

      // CRITICAL FIX: Check for ANY existing position in this market (regardless of side)
      // This prevents opening opposite-direction positions while one is already open
      // Jupiter/Drift don't support hedging - you can only have one direction at a time
      const existingPositionAnyDirection = this.openPositions.find(
        (p) => p.market === targetMarket || p.marketSymbol === targetMarket
      );

      if (existingPositionAnyDirection) {
        const existingSide = String(existingPositionAnyDirection.side || "").toLowerCase();
        const isSameDirection = existingSide === normalizedSide;
        const isOppositeDirection = !isSameDirection;

        if (isOppositeDirection) {
          // Trying to open opposite direction while position exists - this is a critical bug if it happens
          console.error(
            `🚨 [OPEN_POSITION] BLOCKED: Cannot open ${side} while ${existingPositionAnyDirection.side} position exists for ${targetMarket}!`
          );
          console.error(
            `   Existing position: ${existingPositionAnyDirection.positionId?.slice(0, 12)}..., side: ${existingPositionAnyDirection.side}, size: $${existingPositionAnyDirection.size?.toFixed(2) || "N/A"}`
          );
          this._recordOpenDiagnostic({
            stage: "opposite_direction_block",
            market: targetMarket,
            requestedSide: side,
            existingSide: existingPositionAnyDirection.side,
            positionId: existingPositionAnyDirection.positionId,
            status: existingPositionAnyDirection.status,
          });
          return;
        }

        // Same direction - existing logic
        console.log(
          `[OPEN_POSITION] Existing ${existingSide} position detected for ${targetMarket} - skipping open`
        );
        this._recordOpenDiagnostic({
          stage: "existing_position_block",
          market: targetMarket,
          side,
          positionId: existingPositionAnyDirection.positionId,
          status: existingPositionAnyDirection.status,
        });
        return;
      }

      const key = this._actionKey("open", { market: targetMarket, side: normalizedSide });
      if (this._dup(key)) {
        console.log(
          `[OPEN_POSITION] Duplicate open detected for ${targetMarket} ${side} @ ${price}, skipping`
        );
        this._recordOpenDiagnostic({
          stage: "duplicate_block",
          market: targetMarket,
          side,
          price,
          collateral,
        });
        return;
      }
      this._mark(key);

      orderId =
        clientOrderId ||
        this._clientOrderId({
          market: targetMarket,
          side,
          timestamp: tickTimestamp || Date.now(),
          signal,
        });

      if (orderId) {
        const reserved = db.reserveOrder(orderId);
        if (!reserved) {
          log("open_skip_duplicate_order", { side, price, orderId });
          this._recordOpenDiagnostic({
            stage: "order_reservation_block",
            market: targetMarket,
            side,
            orderId,
          });
          return;
        }
        shouldReleaseOrderGuard = true;
      }

      // Execute via selected client
      this._recordOpenDiagnostic({
        stage: "trade_client_call",
        market: targetMarket,
        side,
        collateral,
        leverage,
        orderId,
      });
      const openStart = Date.now();
      let position;
      try {
        position = await this.tradeExecutor.openPosition(
          side.toLowerCase(),
          collateral,
          leverage,
          price,
          orderId,
          targetMarket
        );
      } catch (err) {
        // CRITICAL: Log detailed error information to prevent silent failures
        const errorDetails = {
          market: targetMarket,
          side,
          price,
          collateral,
          leverage,
          orderId,
          errorMessage: err.message,
          errorStack: err.stack,
          attempts: err.attempts || 1,
          cause: err.cause?.message || null,
          durationMs: Date.now() - openStart,
        };

        console.error(
          `❌ [OPEN_POSITION] TradeExecutor failed:`,
          JSON.stringify(errorDetails, null, 2)
        );

        this._recordOpenDiagnostic({
          stage: "trade_client_error",
          market: targetMarket,
          side,
          orderId,
          error: err.message,
          attempts: err.attempts || 1,
          cause: err.cause?.message || null,
          durationMs: Date.now() - openStart,
        });

        // Log to error handler with full context
        await errorHandler.handle(err, {
          category: Category.TRANSACTION,
          severity: Severity.HIGH,
          context: {
            action: "tradeExecutor_openPosition",
            market: targetMarket,
            side,
            price,
            collateral,
            leverage,
            orderId,
            attempts: err.attempts || 1,
            cause: err.cause?.message || null,
            durationMs: Date.now() - openStart,
          },
        });

        throw err;
      }
      this._recordOpenDiagnostic({
        stage: "trade_client_success",
        market: targetMarket,
        side,
        orderId: position?.clientOrderId || orderId,
        durationMs: Date.now() - openStart,
        txSig: position?.txSignature || position?.signature || position?.driftOrderId || null,
      });
      position.clientOrderId = orderId || position.clientOrderId || position.positionId;
      position.market = targetMarket; // Tag position with market
      position.trade_type = "automated"; // Tag as automated bot trade

      // Initialize trailing stop watermarks at entry price
      // highWaterMark: tracks highest price for longs (used for trailing stop calculation)
      // lowWaterMark: tracks lowest price for shorts (used for trailing stop calculation)
      const entryPrice = position.entryPrice || price;
      position.highWaterMark = entryPrice;
      position.lowWaterMark = entryPrice;

      // Phase 10 + Multi-Strategy: Tag position with strategy type
      // Use signal's strategyType if available (multi-strategy mode), otherwise fall back to factory
      position.strategyType =
        options?.signal?.strategyType || this.strategyFactory.getStrategyType(targetMarket);

      // Allocator-driven risk outputs (post-selection) for auditability + runtime enforcement.
      // For Ichimoku, tick-based hard stops are enforced by the strategy (bar logic stays bar-based).
      if (
        position.strategyType === "rsi-reversion" ||
        position.strategyType === "rsi-reversion-alt" ||
        position.strategyType === "btc-breakout" ||
        position.strategyType === "ichimoku-cloud" ||
        position.strategyType === "copy-trading"
      ) {
        const atrAtEntry = Number(stratForMarket?.atr);
        position.allocatorScore = allocatorScore;
        position.allocatorQuality = allocatorRisk?.quality;
        position.allocatorSizePct = allocatorRecommendedSizePct;
        position.allocatorLeverage = leverage;
        position.allocatorHardStopPercent = allocatorRecommendedHardStopPercent;
        position.allocatorHardStopAtrMult = allocatorRecommendedHardStopAtrMult;
        position.atrAtEntry = Number.isFinite(atrAtEntry) && atrAtEntry > 0 ? atrAtEntry : null;

        // Stop-loss overrides (leveraged PnL% semantics for collateral).
        // Ichimoku strategy also reads these for tick-based hard stops.
        if (
          Number.isFinite(allocatorRecommendedHardStopPercent) &&
          allocatorRecommendedHardStopPercent > 0
        ) {
          position.stopLossPercentOverride = allocatorRecommendedHardStopPercent;
        }

        // Runtime ATR hard stop enforcement (price distance from entry)
        if (
          Number.isFinite(allocatorRecommendedHardStopAtrMult) &&
          allocatorRecommendedHardStopAtrMult > 0
        ) {
          position.hardStopAtrMultOverride = allocatorRecommendedHardStopAtrMult;
        }

        if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
          console.log("[ALLOCATOR_RISK] attached to position", {
            market: targetMarket,
            side: position.side,
            allocatorScore,
            quality: allocatorRisk?.quality,
            sizePct: allocatorRecommendedSizePct,
            leverage,
            hardStopPercent: allocatorRecommendedHardStopPercent,
            hardStopAtrMult: allocatorRecommendedHardStopAtrMult,
            atrAtEntry: position.atrAtEntry,
          });
        }
      }

      // CRITICAL: Validate market field is set correctly
      if (!position.market) {
        throw new Error(`Failed to set market field on position ${position.positionId}`);
      }
      if (position.market !== targetMarket) {
        throw new Error(
          `Market mismatch: position.market=${position.market}, targetMarket=${targetMarket}`
        );
      }

      shouldReleaseOrderGuard = false;

      // Safely add position, preventing duplicates
      if (!this._addPositionSafely(position)) {
        console.error(
          `❌ CRITICAL: Attempted to open position ${position.positionId.slice(0, 8)}... that already exists!`
        );
        errorHandler.log(new Error("Duplicate position detected during open"), {
          category: Category.VALIDATION,
          severity: Severity.HIGH,
          context: { positionId: position.positionId, market: position.market },
        });
        throw new Error(`Position ${position.positionId} already exists`);
      }

      // CRITICAL: Detect if protocol auto-closed positions in other markets
      // This happens when opening a position causes total exposure/collateral limits to be exceeded
      if (
        this.liveMode &&
        this.tradeExecutor &&
        typeof this.tradeExecutor.getAllOpenPositions === "function"
      ) {
        try {
          // Wait a moment for on-chain state to update
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Use venue-aware executor to get positions from both Jupiter and Drift
          const positionsAfterOpen = await this.tradeExecutor.getAllOpenPositions();
          const positionsAfterOpenIds = new Set(
            positionsAfterOpen.map((p) => p.positionId || p.id || p.address).filter(Boolean)
          );

          // Check if any tracked positions in OTHER markets were closed
          const autoClosedPositions = [];
          for (const trackedPos of this.openPositions) {
            if (trackedPos.market === targetMarket) continue; // Skip the market we just opened in
            if (!positionsAfterOpenIds.has(trackedPos.positionId)) {
              // Try fuzzy matching (short ID vs full address)
              let found = false;
              for (const onChainId of positionsAfterOpenIds) {
                if (
                  onChainId === trackedPos.positionId ||
                  onChainId.startsWith(trackedPos.positionId) ||
                  trackedPos.positionId.startsWith(onChainId) ||
                  onChainId.slice(0, 8) === trackedPos.positionId.slice(0, 8)
                ) {
                  found = true;
                  break;
                }
              }
              if (!found) {
                autoClosedPositions.push(trackedPos);
              }
            }
          }

          if (autoClosedPositions.length > 0) {
            const closedMarkets = autoClosedPositions
              .map((p) => `${p.market} ${p.side}`)
              .join(", ");
            console.error(
              `\n🚨 [PROTOCOL_AUTO_CLOSE] Jupiter Perps protocol automatically closed ${autoClosedPositions.length} position(s) in other market(s) when opening ${targetMarket} ${side}:`
            );
            console.error(`   Closed positions: ${closedMarkets}`);
            console.error(
              `   This is likely due to protocol-level risk limits (total exposure/collateral constraints)`
            );
            console.error(
              `   Consider: Reducing position sizes, closing positions manually before opening new ones, or increasing collateral\n`
            );

            errorHandler.log(
              new Error("Jupiter Perps protocol auto-closed positions in other markets"),
              {
                category: Category.RISK,
                severity: Severity.HIGH,
                context: {
                  action: "protocol_auto_close",
                  openedMarket: targetMarket,
                  openedSide: side,
                  closedPositions: autoClosedPositions.map((p) => ({
                    positionId: p.positionId,
                    market: p.market,
                    side: p.side,
                    collateral: p.collateral,
                  })),
                },
              }
            );

            // Remove auto-closed positions from tracking
            for (const closedPos of autoClosedPositions) {
              this.openPositions = this.openPositions.filter(
                (p) => p.positionId !== closedPos.positionId
              );
              console.log(
                `📝 Removed auto-closed position ${closedPos.positionId.slice(0, 8)}... (${closedPos.market} ${closedPos.side}) from tracking`
              );
            }
          }
        } catch (detectionError) {
          // Don't fail position open if detection fails
          console.warn(`⚠️  Failed to detect protocol auto-closes: ${detectionError.message}`);
        }
      }

      // Deduct collateral from balance (both live and paper)
      // Apply Jupiter Perps open fee (base fee + price impact fee)
      // Source: https://support.jup.ag/hc/en-us/articles/18735045234588-Fees
      const notionalSize = collateral * leverage;
      const feeCfg = config.fees || {};
      // Base fee: 0.06% (6 basis points) of notional position size
      const baseFee = (notionalSize * (feeCfg.openFeeBps || 6)) / 10_000;
      // Price impact fee (if enabled)
      let priceImpactFee = 0;
      if (feeCfg.enablePriceImpactFee !== false) {
        const priceImpactFeeScalar = feeCfg.priceImpactFeeScalar || 125_000_000_000;
        const coefficient = notionalSize / priceImpactFeeScalar;
        priceImpactFee = notionalSize * coefficient;
      }
      const openFee = baseFee + priceImpactFee;
      if (this.liveMode) {
        const currentLive = this._getLiveBalanceForStrategy(strategyType) || 0;
        this._setLiveBalanceForStrategy(strategyType, currentLive - collateral);
        // Note: In live mode, fees are handled by the exchange
      } else {
        // In paper mode, deduct collateral + open fee
        // CRITICAL: Ensure paperBalance never goes negative
        const totalDeduction = collateral + openFee;
        const currentBalance = this._getPaperBalanceForStrategy(strategyType) || 0;
        if (currentBalance < totalDeduction) {
          // Log warning but still deduct (balance will be clamped to 0)
          console.warn(
            `[PAPER_MODE] Insufficient balance for position: balance=${currentBalance.toFixed(2)}, required=${totalDeduction.toFixed(2)}, shortfall=${(totalDeduction - currentBalance).toFixed(2)}`
          );
          errorHandler.log(
            new Error(
              `Insufficient paper balance: ${currentBalance.toFixed(2)} < ${totalDeduction.toFixed(2)}`
            ),
            {
              category: Category.RISK,
              severity: Severity.MEDIUM,
              context: { currentBalance, totalDeduction, collateral, openFee },
            }
          );
        }
        this._setPaperBalanceForStrategy(
          strategyType,
          Math.max(0, currentBalance - totalDeduction)
        );
      }
      this.dailyTrades++;

      // Update performance tracking for leverage manager
      const currentBalance = this.getAvailableCapital();
      this.leverageManager.updatePerformance(currentBalance);

      // Log to journal (optional, can fail)
      try {
        journal.logOpen(position);
      } catch (e) {
        console.error("⚠️ [JOURNAL] Failed to log position open (non-critical):", e.message);
        errorHandler.log(e, {
          category: Category.SYSTEM,
          severity: Severity.LOW,
          context: { action: "logOpen" },
        });
      }

      // Log to database (CRITICAL - must not fail silently)
      try {
        db.logOpen({
          ...position,
          mode: this.liveMode ? "live" : "paper",
          trade_type: "automated", // Mark as automated bot trade
          environment: this.environment,
          instance_id: this.instanceId,
        });
        console.log(`✅ [DB] Logged position open: ${position.positionId.slice(0, 8)}...`);
      } catch (e) {
        console.error("❌ [DB] CRITICAL: Failed to log position open!");
        console.error("   Position ID:", position.positionId);
        console.error("   Error:", e.message);
        console.error("   Stack:", e.stack);
        errorHandler.log(e, {
          category: Category.SYSTEM,
          severity: Severity.HIGH,
          context: { action: "dbLogOpen", positionId: position.positionId },
        });
        // Don't throw - allow trade to continue, but log loudly
      }

      const positionPoolLabel = this._isCopyStrategy(position.strategyType)
        ? "copy-trading"
        : position.venue || (position.marketIndex !== undefined ? "drift" : "jupiter");
      pretty("open", {
        market: targetMarket,
        side,
        size: position.size,
        entry: position.entryPrice,
        orderId: position.clientOrderId,
        strategyType: position.strategyType,
        poolLabel: positionPoolLabel,
      });
      log("open_ok", {
        market: targetMarket,
        side,
        entry: position.entryPrice,
        collateral,
        leverage,
        orderId: position.clientOrderId,
        strategyType: position.strategyType,
        poolLabel,
      });

      // Confirm trade execution on strategy (for RSI-reversion, this consumes the setup)
      // This prevents the same setup from firing again after the trade is taken
      if (
        this.multiStrategyMode &&
        (position.strategyType === "rsi-reversion" || position.strategyType === "rsi-reversion-alt")
      ) {
        try {
          const strategies = this.strategyFactory.getStrategies(targetMarket);
          if (strategies) {
            // Find the matching RSI strategy (either rsi-reversion or rsi-reversion-alt)
            const rsiStrategy = strategies.find(
              (s) => s.type === "rsi-reversion" || s.type === "rsi-reversion-alt"
            );
            if (
              rsiStrategy &&
              rsiStrategy.strategy &&
              typeof rsiStrategy.strategy.confirmTradeExecution === "function"
            ) {
              rsiStrategy.strategy.confirmTradeExecution(side);
              console.log(
                `[RSI-Reversion] Trade confirmed for ${targetMarket} ${side}, setup consumed`
              );
            }
          }
        } catch (confirmErr) {
          // Non-critical - log but don't fail the trade
          console.warn(`[RSI-Reversion] Failed to confirm trade execution: ${confirmErr.message}`);
        }
      }

      // Send position open to UI server via WebSocket
      if (global.botWs && global.botWs.readyState === 1) {
        try {
          global.botWs.send(
            JSON.stringify({
              ev: "trade_opened",
              data: {
                id: position.positionId,
                client_order_id: position.clientOrderId,
                market: targetMarket,
                side,
                entry: position.entryPrice,
                collateral,
                leverage,
                size: position.size,
                open_ts: position.openTime,
                mode: this.liveMode ? "live" : "paper",
                environment: this.environment,
                instance_id: this.instanceId,
              },
              ts: Date.now(),
            })
          );
          console.log(
            `📤 [WS] Sent trade_opened to UI server: ${position.positionId.slice(0, 8)}...`
          );
        } catch (wsError) {
          console.error("⚠️ [WS] Failed to send trade_opened to UI server:", wsError.message);
        }
      }

      // Send Telegram notification
      // CRITICAL FIX: For maker orders (status: 'pending'), only notify that limit order was PLACED
      // The actual FILL notification will be sent when positionOpened event fires from DriftClient
      if (this.tg && this.tg.enabled) {
        const posSize = position.size ?? collateral * leverage;
        const isMakerPending =
          position.status === "pending" || (position.execMode === "maker" && !position.entryPrice);

        if (isMakerPending) {
          // Maker order placed - NOT filled yet
          this.tg
            .say(
              `📋 *LIMIT ORDER PLACED*\n` +
                `Market: ${targetMarket}\n` +
                `Side: ${side.toUpperCase()}\n` +
                `Strategy: ${position.strategyType || "unknown"}\n` +
                `Pool: ${poolLabel}\n` +
                `Limit: $${position.limitPrice?.toFixed?.(4) ?? "N/A"}\n` +
                `Size: $${posSize?.toFixed?.(2) ?? "N/A"}\n` +
                `Leverage: ${leverage}x\n` +
                `Collateral: $${collateral?.toFixed?.(2) ?? "N/A"}\n` +
                `_Waiting for fill..._`
            )
            .catch((err) => {
              errorHandler.log(err, {
                category: Category.SYSTEM,
                severity: Severity.LOW,
                context: { action: "telegramLimitOrderNotification" },
              });
            });
        } else {
          // Taker order - filled immediately
          const posEntry = position.entryPrice ?? 0;
          this.tg
            .say(
              `✅ *OPEN ${side.toUpperCase()} (TAKER)*\n` +
                `Market: ${targetMarket}\n` +
                `Strategy: ${position.strategyType || "unknown"}\n` +
                `Pool: ${poolLabel}\n` +
                `Size: $${posSize?.toFixed?.(2) ?? "N/A"}\n` +
                `Entry: $${posEntry?.toFixed?.(4) ?? "N/A"}\n` +
                `Leverage: ${leverage}x\n` +
                `Collateral: $${collateral?.toFixed?.(2) ?? "N/A"}`
            )
            .catch((err) => {
              errorHandler.log(err, {
                category: Category.SYSTEM,
                severity: Severity.LOW,
                context: { action: "telegramOpenNotification" },
              });
            });
        }
      }

      ui.send("open", {
        side,
        entry: position.entryPrice ?? 0,
        size: position.size ?? collateral * leverage,
        orderId: position.clientOrderId,
      });
      ui.send("status", this.statusSnapshot());
    } catch (error) {
      // If the open may have landed on-chain but we didn't observe it (RPC confirm timeout / fill timeout),
      // DO NOT release the order guard — releasing can cause duplicate opens for the same signal.
      const msg = String(error?.message || "");
      const causeMsg = String(error?.cause?.message || "");
      // CRITICAL: Command timeout means the order MAY have been placed on-chain
      // but we don't know the result. Treat this as uncertain to prevent duplicates.
      const isUncertainOpen =
        /confirmation timeout/i.test(msg) ||
        /confirmation timeout/i.test(causeMsg) ||
        /fill timeout/i.test(msg) ||
        /fill timeout/i.test(causeMsg) ||
        /Position request sent but fill timeout/i.test(msg) ||
        /Command timeout/i.test(msg) ||
        /Command timeout/i.test(causeMsg);

      if (shouldReleaseOrderGuard && orderId && !isUncertainOpen) {
        db.releaseOrder(orderId);
      } else if (shouldReleaseOrderGuard && orderId && isUncertainOpen) {
        console.warn(
          `[OPEN_POSITION] Keeping order guard for ${orderId} due to uncertain open outcome: ${msg || causeMsg || "unknown"}`
        );
      }
      await errorHandler.handle(error, {
        category: Category.TRANSACTION,
        severity: Severity.HIGH,
        context: { action: "openPosition", side, price, orderId },
      });
      throw error;
    }
  }

  async closePosition(position, price, reason) {
    try {
      // SAFETY: Never auto-close positions that were not opened by the bot.
      // (Prevents startup recovery / sync from ever closing user-opened positions.)
      // Explicit user-initiated closes via UI/Telegram are still allowed.
      const isBotOpenedPosition = this._isBotOpenedPosition(position);
      const r = String(reason || "").toLowerCase();
      const isUserInitiatedClose =
        r === "ui" || r.startsWith("ui") || r.startsWith("telegram") || r === "manual";
      if (!isBotOpenedPosition && !isUserInitiatedClose) {
        console.warn(
          `[CLOSE_POSITION] Refusing to auto-close non-bot position ${position?.positionId?.slice(0, 8) || "unknown"}... ` +
            `(reason=${reason || "unknown"}, trade_type=${position?.trade_type || "not set"})`
        );
        return { skipped: true, reason: "non_bot_position" };
      }

      console.log(
        `[CLOSE_POSITION] Starting close for position ${position.positionId}, reason: ${reason}, price: ${price}`
      );
      const approval = await this.guard.guard("close", { id: position.positionId, price, reason });
      if (!approval.approved) {
        console.log(`[CLOSE_POSITION] Guard blocked close for position ${position.positionId}`);
        return;
      }
      console.log(`[CLOSE_POSITION] Guard approved close for position ${position.positionId}`);

      // NOTE: Key by positionId ONLY, not price - prevents race condition where
      // two closes at slightly different prices would both execute
      const key = this._actionKey("close", { id: position.positionId });
      if (this._dup(key)) {
        console.log(
          `[CLOSE_POSITION] Duplicate close detected for position ${position.positionId}, skipping`
        );
        return;
      }
      // CRITICAL FIX: Mark BEFORE attempt to prevent concurrent executions,
      // but clear on failure to allow retry (see catch block below)
      this._mark(key);
      console.log(`[CLOSE_POSITION] Proceeding with close for position ${position.positionId}`);

      // CRITICAL: Validate exit price matches market before calculating PnL
      const market = position.market || MARKET;
      if (!market) {
        throw new Error(`Position ${position.positionId} has no market field`);
      }

      // Wide absolute ranges to catch cross-market bugs while allowing extreme volatility
      const priceRanges = {
        "SOL-PERP": { min: 5, max: 2000 }, // Allows 2x rallies and 50% crashes
        "BTC-PERP": { min: 5000, max: 300000 }, // Allows 3x rallies and 50% crashes
        "ETH-PERP": { min: 200, max: 30000 }, // Allows 2x rallies and 50% crashes
      };

      // Primary validation: Percentage-based check (exit vs entry)
      // This catches cross-market bugs better than absolute ranges
      if (position.entryPrice && price) {
        const entryPrice = position.entryPrice;
        const maxMovePercent = 50; // Allow up to ±50% move (catches the bug: 99.8% drop would fail)
        const minExit = entryPrice * (1 - maxMovePercent / 100);
        const maxExit = entryPrice * (1 + maxMovePercent / 100);

        if (price < minExit || price > maxExit) {
          const priceMovePercent = ((price - entryPrice) / entryPrice) * 100;
          const errorMsg = `❌ CRITICAL: Exit price $${price.toFixed(2)} for ${market} is ${Math.abs(priceMovePercent).toFixed(2)}% from entry $${entryPrice.toFixed(2)} (max allowed: ±${maxMovePercent}%). This indicates a cross-market price bug!`;
          console.error(errorMsg);
          errorHandler.log(new Error(errorMsg), {
            category: Category.VALIDATION,
            severity: Severity.HIGH,
            context: {
              positionId: position.positionId,
              market,
              entryPrice: entryPrice,
              exitPrice: price,
              priceMovePercent: priceMovePercent,
              maxAllowedMove: maxMovePercent,
            },
          });
          throw new Error(
            `Invalid exit price for ${market}: ${price} (entry: ${entryPrice}, move: ${priceMovePercent.toFixed(2)}%, max: ±${maxMovePercent}%)`
          );
        }
      }

      // Secondary validation: Absolute range check (logs warning, doesn't throw)
      // This catches cases where we're using completely wrong market prices
      if (priceRanges[market]) {
        const range = priceRanges[market];
        if (price < range.min || price > range.max) {
          const warningMsg = `⚠️  Exit price $${price.toFixed(2)} for ${market} is outside expected absolute range [${range.min}, ${range.max}]. This may indicate a cross-market price bug or extreme market conditions.`;
          console.warn(warningMsg);
          errorHandler.log(new Error(warningMsg), {
            category: Category.VALIDATION,
            severity: Severity.MEDIUM,
            context: {
              positionId: position.positionId,
              market,
              entryPrice: position.entryPrice,
              exitPrice: price,
              expectedRange: range,
            },
          });
          // Don't throw - might be valid in extreme market conditions
          // But log it so we can investigate
        }
      }

      let res;
      let positionAlreadyClosed = false;

      try {
        // CRITICAL: Always use tradeExecutor for venue-aware routing (Jupiter or Drift)
        res = await this.tradeExecutor.closePosition(position, price);

        // CRITICAL FIX: Handle maker exit working state (limit order placed but not filled yet)
        // When maker mode is enabled for exits, the close may return { working: true } to indicate
        // the limit order was placed but hasn't filled yet. In this case, don't proceed with
        // close notification - wait for actual fill confirmation from positionClosed event.
        if (res?.working === true) {
          console.log(
            `[CLOSE_POSITION] Maker exit order placed for ${position.positionId} - waiting for fill`
          );
          // The exitOrderPlaced event has already sent the intermediate notification
          // Don't complete the close flow yet - return early
          // The positionClosed event will handle the final notification when filled
          return { working: true, orderId: res.orderId };
        }

        // CRITICAL FIX: Handle exit already in progress (prevents duplicate close orders)
        // This happens when maker exit is pending/filling/falling back and strategy triggers another close
        if (res?.exitInProgress === true) {
          console.log(
            `[CLOSE_POSITION] Exit already in progress for ${position.positionId} (${res.existingOrderState}) - skipping duplicate`
          );
          // Don't throw, don't proceed - exit is already being handled
          return { exitInProgress: true, existingOrderId: res.existingOrderId };
        }
        if (res?.pending === true || res?.status === "close_pending") {
          console.log(
            `[CLOSE_POSITION] Close pending for ${position.positionId} - waiting for on-chain confirmation`
          );
          return { pending: true, orderId: res.orderId };
        }

        // CRITICAL FIX: Handle phantom_position_removed status
        // This means the position no longer exists on-chain (already closed/liquidated)
        // We should treat this as a successful close and clean up local tracking
        if (res?.status === "phantom_position_removed" || res?.execMode === "phantom_removed") {
          console.log(
            `[CLOSE_POSITION] Position ${position.positionId} detected as phantom (no longer exists on-chain) - cleaning up tracking`
          );
          positionAlreadyClosed = true;

          // CRITICAL: Add to phantom markets map to prevent sync from re-adding
          const posVenue =
            position.venue || (position.marketIndex !== undefined ? "drift" : "jupiter");
          const phantomKey = `${market}:${(position.side || "long").toLowerCase()}:${posVenue}`;
          this._phantomMarkets.set(phantomKey, Date.now());
          console.log(
            `[CLOSE_POSITION] Added ${phantomKey} to phantom markets (grace period: ${this._PHANTOM_GRACE_PERIOD_MS / 1000}s)`
          );
          // Proceed to remove from openPositions without throwing - position is gone
        }
      } catch (closeError) {
        // ROOT CAUSE FIX: Handle "No open manual position to close" as position already closed
        // This happens when position was closed on-chain but bot state wasn't updated
        const errorMsg = String(closeError?.message || "");
        const isAlreadyClosedError =
          errorMsg.includes("No open manual position to close") ||
          errorMsg.includes("no open manual position") ||
          errorMsg.includes("position may have already been closed");

        if (isAlreadyClosedError) {
          console.log(
            `[CLOSE_POSITION] Position ${position.positionId} appears to be already closed on-chain. Verifying...`
          );

          // Verify position is actually closed on-chain (venue-aware)
          try {
            // Use tradeExecutor.getAllOpenPositions() for multi-venue support
            const allPositions = await this.tradeExecutor.getAllOpenPositions();
            const positionExists = allPositions.some((p) => {
              const pId = p.positionId || p.id || p.address;
              return (
                pId === position.positionId ||
                pId?.startsWith(position.positionId) ||
                position.positionId?.startsWith(pId) ||
                pId?.slice(0, 8) === position.positionId.slice(0, 8)
              );
            });

            if (!positionExists) {
              // Position confirmed closed on-chain - treat as successful close
              console.log(
                `✅ [CLOSE_POSITION] Position ${position.positionId} confirmed closed on-chain. Treating as successful close.`
              );
              positionAlreadyClosed = true;
              // Create a mock result for the rest of the close logic
              res = { ok: true, sig: "already_closed", signature: "already_closed" };
            } else {
              // Position still exists - this is a real error
              console.error(
                `❌ [CLOSE_POSITION] Position ${position.positionId} still exists on-chain despite error. Re-throwing error.`
              );
              throw closeError;
            }
          } catch (verifyError) {
            // If verification fails, log but assume position is closed (safer assumption)
            console.warn(
              `⚠️  [CLOSE_POSITION] Could not verify position state: ${verifyError.message}. Assuming already closed.`
            );
            positionAlreadyClosed = true;
            res = { ok: true, sig: "already_closed", signature: "already_closed" };
          }
        } else {
          // Not an "already closed" error - re-throw
          throw closeError;
        }
      }

      // CRITICAL FIX: Use actual exit price from client if available
      // The Drift client now returns the actual oracle price after the order fills,
      // which is more accurate than the expected price passed in (avoids slippage discrepancy).
      //
      // Priority:
      // 1. Use res.exitPrice (actual price from Drift client after order fills)
      // 2. Fall back to passed-in `price` (expected price before order)
      const actualExitPrice =
        res.exitPrice && Number.isFinite(res.exitPrice) && res.exitPrice > 0
          ? res.exitPrice
          : price;

      // Log if there's a significant price difference (indicates slippage/latency)
      if (res.exitPrice && Math.abs((res.exitPrice - price) / price) > 0.001) {
        const priceDiff = (((res.exitPrice - price) / price) * 100).toFixed(3);
        console.log(
          `[CLOSE_POSITION] Price adjustment: expected $${price.toFixed(4)} → actual $${res.exitPrice.toFixed(4)} (${priceDiff}% diff)`
        );
      }

      // CRITICAL FIX: Calculate PnL if not returned by closePosition (live mode issue)
      // perps-live-client.js doesn't return pnl, so we calculate it manually
      let pnlUSD = res.pnl;
      if (pnlUSD === undefined || pnlUSD === null || !Number.isFinite(pnlUSD)) {
        // Calculate PnL manually using the ACTUAL exit price (not the expected price)
        // Formula: ((exitPrice - entryPrice) / entryPrice) * side_multiplier * leverage * collateral
        const priceChange = (actualExitPrice - position.entryPrice) / position.entryPrice;
        const sideMultiplier = String(position.side || "").toLowerCase() === "long" ? 1 : -1;
        const pnlPercent = priceChange * sideMultiplier * (position.leverage || 1) * 100;
        pnlUSD = (position.collateral * pnlPercent) / 100;
        console.log(
          `[CLOSE_POSITION] Calculated PnL manually: $${pnlUSD.toFixed(2)} (${pnlPercent.toFixed(2)}%) using exit price $${actualExitPrice.toFixed(4)}`
        );
      }

      // Apply Jupiter Perps close fee (base fee + price impact fee)
      // Source: https://support.jup.ag/hc/en-us/articles/18735045234588-Fees
      const notionalSize = position.size || position.collateral * (position.leverage || 1);
      const feeCfg = config.fees || {};
      // Base fee: 0.06% (6 basis points) of notional position size
      const baseFee = (notionalSize * (feeCfg.closeFeeBps || 6)) / 10_000;
      // Price impact fee (if enabled)
      let priceImpactFee = 0;
      if (feeCfg.enablePriceImpactFee !== false) {
        const priceImpactFeeScalar = feeCfg.priceImpactFeeScalar || 125_000_000_000;
        const coefficient = notionalSize / priceImpactFeeScalar;
        priceImpactFee = notionalSize * coefficient;
      }
      const closeFee = baseFee + priceImpactFee;
      if (this.liveMode) {
        // In live mode, fees are handled by the exchange
        // Note: PnL from exchange already accounts for fees, so we don't deduct here
      } else {
        // In paper mode, deduct close fee from PnL
        pnlUSD -= closeFee;
      }

      // CRITICAL FIX: Convert USD PnL to percentage for database storage
      // Database stores PnL as percentage for consistency with exit logic
      // Store both USD and percentage for completeness
      let pnlPercent = 0;
      if (position.collateral && Number.isFinite(position.collateral) && position.collateral > 0) {
        pnlPercent = (pnlUSD / position.collateral) * 100;
      }

      // For backward compatibility, use pnlUSD for balance calculations
      // but store pnlPercent in database
      const pnl = pnlUSD; // Keep USD for balance updates
      const pnlForDB = pnlPercent; // Store percentage in database

      // Notify strategy manager (per-strategy tracking: circuit breakers, stats)
      const isAutomatedPosition = !this._isManualPosition(position);

      if (isAutomatedPosition && position.strategyType === "copy-trading") {
        this._resetCopyDailyLossIfNeeded(Date.now());
        if (Number.isFinite(pnl) && pnl < 0) {
          this._copyDailyLossUsd = (this._copyDailyLossUsd || 0) + Math.abs(pnl);
        }
      }
      if (
        isAutomatedPosition &&
        this.strategyManager &&
        typeof this.strategyManager.recordTrade === "function"
      ) {
        this.strategyManager.recordTrade(position.market || MARKET, {
          strategyType: position.strategyType,
          pnl,
          pnlUsd,
          pnlPercent,
          exitReason: reason,
        });
      }
      if (isAutomatedPosition && !this.multiStrategyMode) {
        const directStrategy = this.strategies.get(position.market || MARKET);
        if (directStrategy && typeof directStrategy.recordTrade === "function") {
          directStrategy.recordTrade({
            pnl,
            pnlUsd,
            pnlPercent,
            exitReason: reason,
            strategyType: position.strategyType,
          });
        }
      }

      // CRITICAL FIX: Notify strategy that position closed (resets same-bar guard)
      // This allows re-entry on same bar after stop loss (e.g., quick stop → new signal)
      const posMarket = position.market || MARKET;
      const strategy = this.strategies.get(posMarket);
      if (strategy && typeof strategy.recordExit === "function") {
        strategy.recordExit(position.side, price);
      }

      // Add back collateral + PnL to balance (both live and paper)
      // Note: PnL only compounds into balance if ENABLE_COMPOUNDING=true
      const enableCompounding = this.config?.risk?.enableCompounding === true;
      if (this.liveMode) {
        const currentLive = this._getLiveBalanceForStrategy(position.strategyType) || 0;
        let nextLive = currentLive + position.collateral;
        if (enableCompounding) {
          nextLive += pnl;
        }
        this._setLiveBalanceForStrategy(position.strategyType, nextLive);
      } else {
        const currentPaper = this._getPaperBalanceForStrategy(position.strategyType) || 0;
        let nextPaper = currentPaper + position.collateral;
        if (enableCompounding) {
          nextPaper += pnl;
        }
        this._setPaperBalanceForStrategy(position.strategyType, nextPaper);
      }

      // Track realized PnL for AUTOMATED positions only (used for capital allocation)
      // Manual positions' PnL does NOT affect the bot's available capital
      if (isAutomatedPosition && Number.isFinite(pnl)) {
        this._automatedRealizedPnL = (this._automatedRealizedPnL || 0) + pnl;

        // Per-pool PnL tracking for venue-specific capital management
        if (position.strategyType === "copy-trading") {
          this._copyRealizedPnL = (this._copyRealizedPnL || 0) + pnl;
          console.log(
            `[CAPITAL] Copy position closed: PnL $${pnl.toFixed(2)}, Copy pool: $${this._copyRealizedPnL.toFixed(2)}, Total: $${this._automatedRealizedPnL.toFixed(2)}`
          );
        } else {
          const venueRouter = require("./utils/venue-router");
          const positionVenue = venueRouter.getVenueForMarket(position.market);
          if (positionVenue === "drift") {
            this._driftRealizedPnL = (this._driftRealizedPnL || 0) + pnl;
            console.log(
              `[CAPITAL] Drift position closed: PnL $${pnl.toFixed(2)}, Drift pool: $${this._driftRealizedPnL.toFixed(2)}, Total: $${this._automatedRealizedPnL.toFixed(2)}`
            );
          } else {
            this._jupiterRealizedPnL = (this._jupiterRealizedPnL || 0) + pnl;
            console.log(
              `[CAPITAL] Jupiter position closed: PnL $${pnl.toFixed(2)}, Jupiter pool: $${this._jupiterRealizedPnL.toFixed(2)}, Total: $${this._automatedRealizedPnL.toFixed(2)}`
            );
          }
        }
      }

      // Update performance tracking for leverage manager
      const currentBalance = this.getAvailableCapital();
      this.leverageManager.updatePerformance(currentBalance);

      // Update market-specific performance tracking
      // Performance attribution must use the position's explicit market only
      const perfMarket = position.market;
      const performance =
        perfMarket && MARKETS.includes(perfMarket) ? this.marketPerformance.get(perfMarket) : null;
      if (performance) {
        performance.totalTrades++;
        performance.totalPnL += pnl;
        if (pnl > 0) {
          performance.winningTrades++;
        } else if (pnl < 0) {
          performance.losingTrades++;
        }
        performance.winRate =
          performance.totalTrades > 0 ? performance.winningTrades / performance.totalTrades : 0.5;
        performance.avgPnL =
          performance.totalTrades > 0 ? performance.totalPnL / performance.totalTrades : 0;

        // Keep recent trades (last 20)
        performance.recentTrades.push({
          pnl,
          timestamp: Date.now(),
          side: position.side,
        });
        if (performance.recentTrades.length > 20) {
          performance.recentTrades.shift();
        }
      } else {
        // Skip performance update if market missing or unknown
        console.warn(
          "[PERF_ATTRIBUTION] Skipping performance update due to invalid market on position close",
          {
            positionId: position.positionId,
            positionMarket: position.market,
            configuredMarkets: MARKETS,
          }
        );
      }

      // Record trade outcome for allocator cooldown tracking
      this.marketAllocator.recordTradeOutcome(market, position.side, pnl > 0);

      // ROOT CAUSE FIX: Update database BEFORE removing from openPositions
      // This ensures if DB update fails, position remains in memory for retry
      let dbUpdateSucceeded = false;
      try {
        // Use actualExitPrice (actual fill price) for accurate journal logging
        journal.logClose(position, actualExitPrice, pnl, reason);
      } catch (e) {
        errorHandler.log(e, {
          category: Category.SYSTEM,
          severity: Severity.LOW,
          context: { action: "logClose" },
        });
      }
      try {
        // Store PnL as percentage in database (with USD backup in position object for conversion)
        // Capture execMode from close result if available, otherwise use position.execMode
        const exitExecMode =
          res?.execMode ||
          position?.exitExecMode ||
          position?.execMode ||
          position?.exec_mode ||
          null;
        // Use actualExitPrice (actual fill price) for accurate database logging
        db.logClose(
          {
            ...position,
            mode: this.liveMode ? "live" : "paper",
            pnlUSD,
            environment: this.environment,
            instance_id: this.instanceId,
            exitExecMode, // Execution mode for exit (maker/taker)
          },
          actualExitPrice,
          pnlForDB,
          reason
        );
        dbUpdateSucceeded = true;
      } catch (e) {
        errorHandler.log(e, {
          category: Category.SYSTEM,
          severity: Severity.HIGH,
          context: { action: "dbLogClose" },
        });
        console.error(
          `[CLOSE_POSITION] CRITICAL: Database update failed for position ${position.positionId}. Position will remain in tracking for retry.`
        );
        // Don't remove from openPositions if DB update failed - allows retry on next sync
        throw new Error(
          `Database update failed: ${e.message}. Position ${position.positionId} remains in tracking.`
        );
      }

      // Only remove from openPositions AFTER database update succeeds
      // This ensures position state is consistent between memory and database
      if (dbUpdateSucceeded) {
        // CRITICAL FIX: Remove by positionId AND clean up any duplicate positions for same market+venue
        // This handles the case where multiple position entries exist for the same on-chain position
        // (e.g., original entry + adopted position after timeout)
        const beforeCount = this.openPositions.length;
        this.openPositions = this.openPositions.filter((p) => {
          // Always remove the exact position being closed
          if (p.positionId === position.positionId) return false;

          // Also remove any other positions for the same market+side+venue (duplicates)
          // Only if we confirmed the position was closed (positionAlreadyClosed or phantom_position_removed)
          const posVenue =
            position.venue || (position.marketIndex !== undefined ? "drift" : "jupiter");
          const pVenue = p.venue || (p.marketIndex !== undefined ? "drift" : "jupiter");
          const isDuplicate =
            p.market === position.market && pVenue === posVenue && p.side === position.side;
          if (isDuplicate && positionAlreadyClosed) {
            console.log(
              `[CLOSE_POSITION] Also removing duplicate position ${p.positionId?.slice(0, 12) || "unknown"} for ${p.market}`
            );
            return false;
          }
          return true;
        });
        const removed = beforeCount - this.openPositions.length;
        if (positionAlreadyClosed) {
          console.log(
            `[CLOSE_POSITION] Position ${position.positionId} removed from tracking (was already closed on-chain). Total removed: ${removed}`
          );
        } else if (removed > 1) {
          console.log(
            `[CLOSE_POSITION] Cleaned up ${removed} position entries for ${position.market}`
          );
        }
      }

      const orderId = position.clientOrderId || position.positionId;
      console.log(
        `[CLOSE_POSITION] Logging close for position ${position.positionId}, PnL: ${pnl}, market: ${market}, exitPrice: ${actualExitPrice}`
      );
      const poolLabel = this._isCopyStrategy(position.strategyType)
        ? "copy-trading"
        : position.venue || (position.marketIndex !== undefined ? "drift" : "jupiter");
      pretty("close", {
        market,
        side: position.side,
        pnl,
        exit: actualExitPrice,
        orderId,
        strategyType: position.strategyType,
        poolLabel,
      });
      log("close_ok", {
        market,
        side: position.side,
        pnl,
        exit: actualExitPrice,
        orderId,
        strategyType: position.strategyType,
        poolLabel,
      });

      // Send Telegram notification
      console.log(
        `[CLOSE_POSITION] Checking Telegram notification - tg exists: ${!!this.tg}, enabled: ${this.tg?.enabled}`
      );
      if (this.tg && this.tg.enabled) {
        const pnlEmoji = pnl >= 0 ? "💰" : "📉";
        const pnlSign = pnl >= 0 ? "+" : "";
        // NOTE: pnl is in USD, pnlForDB is in percentage
        // Use actualExitPrice (actual fill price) instead of expected price
        const telegramMsg =
          `${pnlEmoji} *CLOSE ${position.side.toUpperCase()}*\n` +
          `Market: ${market}\n` +
          `Strategy: ${position.strategyType || "unknown"}\n` +
          `Pool: ${poolLabel}\n` +
          `Entry: $${position.entryPrice.toFixed(4)}\n` +
          `Exit: $${actualExitPrice.toFixed(4)}\n` +
          `PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlForDB.toFixed(2)}%)\n` +
          `Collateral: $${position.collateral.toFixed(2)}\n` +
          `Leverage: ${position.leverage}x\n` +
          `Reason: ${reason || "manual"}`;
        console.log(
          `[CLOSE_POSITION] Sending Telegram notification for position ${position.positionId}`
        );
        this.tg.say(telegramMsg).catch((err) => {
          console.error(`[CLOSE_POSITION] Failed to send Telegram notification:`, err);
          errorHandler.log(err, {
            category: Category.SYSTEM,
            severity: Severity.LOW,
            context: { action: "telegramCloseNotification" },
          });
        });
      } else {
        console.warn(
          `[CLOSE_POSITION] Telegram notification skipped - tg: ${!!this.tg}, enabled: ${this.tg?.enabled}`
        );
      }

      ui.send("close", {
        market,
        side: position.side,
        pnl,
        entry: position.entryPrice,
        exit: actualExitPrice,
        reason: reason,
        orderId,
      });
      ui.send("status", this.statusSnapshot());

      // Send trade closure to UI server via WebSocket (for Render deployment)
      if (global.botWs && global.botWs.readyState === 1) {
        try {
          global.botWs.send(
            JSON.stringify({
              ev: "trade_closed",
              data: {
                id: position.positionId,
                client_order_id: position.clientOrderId,
                market,
                side: position.side,
                entry: position.entryPrice,
                exit: actualExitPrice,
                collateral: position.collateral,
                leverage: position.leverage,
                size: position.size,
                pnl: pnlForDB, // Send percentage format for database consistency
                pnl_usd: pnl, // Also send USD for display purposes
                reason,
                open_ts: position.openTime,
                close_ts: Date.now(),
                mode: this.liveMode ? "live" : "paper",
              },
              ts: Date.now(),
            })
          );
          console.log(
            `[CLOSE_POSITION] Sent trade closure to UI via WebSocket: ${position.positionId}`
          );
        } catch (e) {
          console.warn("Failed to send trade closure to UI via WebSocket:", e.message);
        }
      }

      console.log(
        `[CLOSE_POSITION] Successfully completed close for position ${position.positionId}`
      );
    } catch (error) {
      // Check if this is a kill switch error
      const isKillSwitchError =
        error.message?.includes("KILL SWITCH") ||
        error.name === "CloseKillSwitchError" ||
        error.message?.includes("kill switch");

      if (isKillSwitchError) {
        console.error(
          `\n🚨 [CLOSE_POSITION] KILL SWITCH ERROR for position ${position.positionId}:`
        );
        console.error(`   ${error.message}`);
        console.error(
          `   This means the close operation failed multiple times and was blocked for safety.`
        );
        console.error(
          `   The kill switch will auto-reset in 5 minutes, or you can reset it manually.`
        );
        console.error(`   Position remains open - manual intervention may be required.\n`);

        // Send detailed kill switch notification
        if (this.tg && this.tg.enabled) {
          const killSwitchMsg =
            `🚨 *CLOSE KILL SWITCH TRIGGERED*\n` +
            `Position: ${position.positionId?.slice(0, 8) || "unknown"}\n` +
            `Market: ${position.market || "unknown"}\n` +
            `Side: ${position.side?.toUpperCase() || "unknown"}\n` +
            `Reason: ${reason || "unknown"}\n\n` +
            `The close operation failed multiple times and was blocked for safety.\n` +
            `The kill switch will auto-reset in 5 minutes.\n` +
            `To reset manually: Use /reset_kill_switch command or API endpoint.`;
          this.tg.say(killSwitchMsg).catch((err) => {
            console.error(`[CLOSE_POSITION] Failed to send kill switch notification:`, err);
          });
        }

        // Log with high severity for kill switch errors
        await errorHandler.handle(error, {
          category: Category.TRANSACTION,
          severity: Severity.CRITICAL, // Use CRITICAL for kill switch errors
          context: {
            action: "closePosition",
            positionId: position.positionId,
            reason,
            killSwitchTriggered: true,
            attempts: error.attempts,
            lastError: error.lastError,
          },
        });
      } else {
        // Check if this is an "already closed" error that we should handle gracefully
        const errorMsg = String(error?.message || "");
        const isAlreadyClosedError =
          errorMsg.includes("No open manual position to close") ||
          errorMsg.includes("no open manual position") ||
          errorMsg.includes("position may have already been closed") ||
          errorMsg.includes("Database update failed");

        if (isAlreadyClosedError && errorMsg.includes("Database update failed")) {
          // Database update failed - this is handled above, but we need to restore position
          // The position should still be in openPositions, so we can retry later
          console.error(
            `[CLOSE_POSITION] Database update failed for position ${position.positionId}. Position remains in tracking for retry.`
          );
        } else if (isAlreadyClosedError) {
          // Position already closed - this should have been caught above, but handle gracefully
          console.log(
            `[CLOSE_POSITION] Position ${position.positionId} already closed. This should have been handled earlier.`
          );
          // Don't treat as error - position is closed, just need to sync state
          return { ok: true, alreadyClosed: true };
        } else {
          // Regular error handling
          console.error(`[CLOSE_POSITION] Error closing position ${position.positionId}:`, error);

          // Try to send notification even if there was an error (but position might have been closed)
          // This ensures user is notified of the close attempt even if something went wrong
          if (this.tg && this.tg.enabled) {
            const errorMsg =
              `⚠️ *CLOSE ERROR*\n` +
              `Position: ${position.positionId?.slice(0, 8) || "unknown"}\n` +
              `Market: ${position.market || "unknown"}\n` +
              `Side: ${position.side?.toUpperCase() || "unknown"}\n` +
              `Error: ${error.message || "Unknown error"}\n` +
              `Reason: ${reason || "unknown"}`;
            this.tg.say(errorMsg).catch((err) => {
              console.error(`[CLOSE_POSITION] Failed to send error notification:`, err);
            });
          }

          await errorHandler.handle(error, {
            category: Category.TRANSACTION,
            severity: Severity.HIGH,
            context: { action: "closePosition", positionId: position.positionId, reason },
          });
        }
      }

      // CRITICAL FIX: Clear the duplicate-detection mark on failure
      // This allows retry attempts to proceed (the mark was set before the attempt)
      // Without this, failed closes block all retries for 60 seconds!
      this._recentActions.delete(key);
      console.log(
        `[CLOSE_POSITION] Cleared dedup mark for position ${position.positionId} after failure - retry allowed`
      );

      // Always re-throw to allow caller to handle
      throw error;
    }
  }

  async _finalizeClosedPositionFromDriftEvent(position, evt = {}) {
    if (!position) return;

    const positionId = position.positionId || evt.positionId || evt.position?.positionId;
    if (!positionId) return;

    const now = Date.now();
    const last = this._finalizedCloseByPositionId.get(positionId) || 0;
    if (now - last < this._finalizedCloseDedupMs) {
      return;
    }
    this._finalizedCloseByPositionId.set(positionId, now);
    if (this._finalizedCloseByPositionId.size > 1000) {
      for (const [k, ts] of this._finalizedCloseByPositionId) {
        if (now - ts > this._finalizedCloseDedupMs * 2) {
          this._finalizedCloseByPositionId.delete(k);
        }
      }
    }

    const market = position.market || evt.market || MARKET;
    const reason = evt.exitReason || evt.reason || "unknown";
    const execMode =
      evt.execMode || evt.exec_mode || position.exitExecMode || position.execMode || null;
    const actualExitPrice =
      evt.exitPrice && Number.isFinite(evt.exitPrice) && evt.exitPrice > 0
        ? evt.exitPrice
        : evt.position?.exitPrice &&
            Number.isFinite(evt.position.exitPrice) &&
            evt.position.exitPrice > 0
          ? evt.position.exitPrice
          : position.lastPrice && Number.isFinite(position.lastPrice) && position.lastPrice > 0
            ? position.lastPrice
            : position.entryPrice;

    let pnlUSD = evt.pnl;
    if (pnlUSD === undefined || pnlUSD === null || !Number.isFinite(pnlUSD)) {
      if (position.entryPrice && actualExitPrice && position.collateral) {
        const priceChange = (actualExitPrice - position.entryPrice) / position.entryPrice;
        const sideMultiplier = String(position.side || "").toLowerCase() === "long" ? 1 : -1;
        const pnlPercent = priceChange * sideMultiplier * (position.leverage || 1) * 100;
        pnlUSD = (position.collateral * pnlPercent) / 100;
      } else {
        pnlUSD = 0;
      }
    }

    // Apply Jupiter Perps close fee model only in paper mode (existing behavior).
    const notionalSize = position.size || position.collateral * (position.leverage || 1);
    const feeCfg = config.fees || {};
    const baseFee = (notionalSize * (feeCfg.closeFeeBps || 6)) / 10_000;
    let priceImpactFee = 0;
    if (feeCfg.enablePriceImpactFee !== false) {
      const priceImpactFeeScalar = feeCfg.priceImpactFeeScalar || 125_000_000_000;
      const coefficient = notionalSize / priceImpactFeeScalar;
      priceImpactFee = notionalSize * coefficient;
    }
    const closeFee = baseFee + priceImpactFee;
    if (!this.liveMode) {
      pnlUSD -= closeFee;
    }

    let pnlPercent = 0;
    if (position.collateral && Number.isFinite(position.collateral) && position.collateral > 0) {
      pnlPercent = (pnlUSD / position.collateral) * 100;
    }

    const posMarket = position.market || MARKET;
    const strategy = this.strategies.get(posMarket);
    if (strategy && typeof strategy.recordExit === "function") {
      strategy.recordExit(position.side, actualExitPrice);
    }

    // Balance updates
    const enableCompounding = this.config?.risk?.enableCompounding === true;
    if (this.liveMode) {
      this.liveBalance += position.collateral;
      if (enableCompounding) this.liveBalance += pnlUSD;
    } else {
      this.paperBalance += position.collateral;
      if (enableCompounding) this.paperBalance += pnlUSD;
    }

    const isAutomatedPosition = !this._isManualPosition(position);
    if (isAutomatedPosition && Number.isFinite(pnlUSD)) {
      this._automatedRealizedPnL = (this._automatedRealizedPnL || 0) + pnlUSD;
      const venueRouter = require("./utils/venue-router");
      const positionVenue = venueRouter.getVenueForMarket(position.market);
      if (positionVenue === "drift") {
        this._driftRealizedPnL = (this._driftRealizedPnL || 0) + pnlUSD;
      } else {
        this._jupiterRealizedPnL = (this._jupiterRealizedPnL || 0) + pnlUSD;
      }
    }

    const currentBalance = this.getAvailableCapital();
    this.leverageManager.updatePerformance(currentBalance);

    const perfMarket = position.market;
    const performance =
      perfMarket && MARKETS.includes(perfMarket) ? this.marketPerformance.get(perfMarket) : null;
    if (performance) {
      performance.totalTrades++;
      performance.totalPnL += pnlUSD;
      if (pnlUSD > 0) performance.winningTrades++;
      else if (pnlUSD < 0) performance.losingTrades++;
      performance.winRate =
        performance.totalTrades > 0 ? performance.winningTrades / performance.totalTrades : 0.5;
      performance.avgPnL =
        performance.totalTrades > 0 ? performance.totalPnL / performance.totalTrades : 0;
      performance.recentTrades.push({ pnl: pnlUSD, timestamp: Date.now(), side: position.side });
      if (performance.recentTrades.length > 20) performance.recentTrades.shift();
    }

    this.marketAllocator.recordTradeOutcome(market, position.side, pnlUSD > 0);

    // DB + journal
    try {
      journal.logClose(position, actualExitPrice, pnlUSD, reason);
    } catch (e) {
      errorHandler.log(e, {
        category: Category.SYSTEM,
        severity: Severity.LOW,
        context: { action: "logClose" },
      });
    }

    let dbUpdateSucceeded = false;
    try {
      const exitExecMode = execMode;
      db.logClose(
        {
          ...position,
          mode: this.liveMode ? "live" : "paper",
          pnlUSD,
          environment: this.environment,
          instance_id: this.instanceId,
          exitExecMode,
        },
        actualExitPrice,
        pnlPercent,
        reason
      );
      dbUpdateSucceeded = true;
    } catch (e) {
      errorHandler.log(e, {
        category: Category.SYSTEM,
        severity: Severity.HIGH,
        context: { action: "dbLogClose" },
      });
      console.error(
        `[DRIFT_EVENT] CRITICAL: Database update failed for closed position ${positionId}. Position will remain in tracking for retry.`
      );
    }

    if (dbUpdateSucceeded) {
      const beforeCount = this.openPositions.length;
      const posVenue = position.venue || (position.marketIndex !== undefined ? "drift" : "jupiter");
      this.openPositions = this.openPositions.filter((p) => {
        if (p.positionId === position.positionId) return false;
        const pVenue = p.venue || (p.marketIndex !== undefined ? "drift" : "jupiter");
        const isDuplicate =
          p.market === position.market &&
          pVenue === posVenue &&
          String(p.side || "") === String(position.side || "");
        return !isDuplicate;
      });
      const removed = beforeCount - this.openPositions.length;
      if (removed > 0) {
        console.log(
          `[DRIFT_EVENT] Removed ${removed} closed position entry(s) from tracking: ${positionId}`
        );
      }
    }

    // Telegram summary
    if (this.tg && this.tg.enabled) {
      const pnlEmoji = pnlUSD >= 0 ? "💰" : "📉";
      const pnlSign = pnlUSD >= 0 ? "+" : "";
      const telegramMsg =
        `${pnlEmoji} *CLOSE ${String(position.side || "").toUpperCase()}*\n` +
        `Market: ${market}\n` +
        `Entry: $${position.entryPrice?.toFixed?.(4) ?? "N/A"}\n` +
        `Exit: $${actualExitPrice?.toFixed?.(4) ?? "N/A"}\n` +
        `PnL: ${pnlSign}$${Number(pnlUSD).toFixed(2)} (${pnlSign}${Number(pnlPercent).toFixed(2)}%)\n` +
        `Collateral: $${position.collateral?.toFixed?.(2) ?? "N/A"}\n` +
        `Leverage: ${position.leverage ?? "N/A"}x\n` +
        `Reason: ${reason || "manual"}`;
      this.tg.say(telegramMsg).catch((err) => {
        console.error(`[DRIFT_EVENT] Failed to send Telegram close notification:`, err);
      });
    }

    ui.send("close", {
      market,
      side: position.side,
      pnl: pnlUSD,
      entry: position.entryPrice,
      exit: actualExitPrice,
      reason,
      orderId: position.clientOrderId || position.positionId,
    });
    ui.send("status", this.statusSnapshot());

    if (global.botWs && global.botWs.readyState === 1) {
      try {
        global.botWs.send(
          JSON.stringify({
            ev: "trade_closed",
            data: {
              id: position.positionId,
              client_order_id: position.clientOrderId,
              market,
              side: position.side,
              entry: position.entryPrice,
              exit: actualExitPrice,
              collateral: position.collateral,
              leverage: position.leverage,
              size: position.size,
              pnl: pnlPercent,
              pnl_usd: pnlUSD,
              reason,
              open_ts: position.openTime,
              close_ts: Date.now(),
              mode: this.liveMode ? "live" : "paper",
            },
            ts: Date.now(),
          })
        );
      } catch (e) {
        console.warn("Failed to send trade closure to UI via WebSocket:", e.message);
      }
    }
  }

  // ---------- Manual Trade Management ----------
  /**
   * Track a manually-opened position (after user signs and submits transaction)
   * This allows the bot to monitor manual positions for TP/SL and provide updates
   */
  async trackManualPosition(positionData) {
    try {
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
      } = positionData;

      // Validate required fields
      if (!positionId || !market || !side || !collateralUsd || !leverage || !entryPrice) {
        throw new Error("Missing required position data for manual tracking");
      }

      // Calculate position size
      const size = collateralUsd * leverage;

      // Calculate liquidation price (simplified, actual may differ)
      const liquidationDistance = 1 / leverage;
      const liquidationPrice =
        side.toLowerCase() === "long"
          ? entryPrice * (1 - liquidationDistance)
          : entryPrice * (1 + liquidationDistance);

      // Create position object
      const position = {
        positionId,
        clientOrderId: clientOrderId || `manual-${Date.now()}`,
        market: market.toUpperCase(),
        side: side.toLowerCase(),
        collateral: collateralUsd,
        leverage,
        size,
        entryPrice,
        liquidationPrice,
        openTime: Date.now(),
        mode: "manual", // Keep for backwards compatibility
        trade_type: "manual", // New field for automated vs manual
        signature,
        walletAddress,
      };

      // Add to tracking (with duplicate check)
      if (!this._addPositionSafely(position)) {
        throw new Error(`Position ${position.positionId} already exists`);
      }

      // Log to database
      db.logOpen({
        positionId: position.positionId,
        clientOrderId: position.clientOrderId,
        market: position.market,
        side: position.side,
        entryPrice: position.entryPrice,
        collateral: position.collateral,
        leverage: position.leverage,
        size: position.size,
        openTime: position.openTime,
        mode: this.liveMode ? "live" : "paper", // live/paper mode
        trade_type: "manual", // automated vs manual
        environment: this.liveMode ? "live" : "paper",
        instance_id: process.env.BOT_INSTANCE_ID || "local",
      });

      // Broadcast to UI
      ui.send("open", position);
      ui.send("status", this.statusSnapshot());

      // Send to UI server via WebSocket (for Render deployment)
      if (global.botWs && global.botWs.readyState === 1) {
        try {
          global.botWs.send(
            JSON.stringify({
              ev: "trade_opened",
              data: {
                id: position.positionId,
                client_order_id: position.clientOrderId,
                market: position.market,
                side: position.side,
                entry: position.entryPrice,
                collateral: position.collateral,
                leverage: position.leverage,
                size: position.size,
                open_ts: position.openTime,
                mode: "manual",
              },
              ts: Date.now(),
            })
          );
          console.log(
            `[MANUAL_TRADE] Sent manual position tracking to UI via WebSocket: ${position.positionId}`
          );
        } catch (e) {
          console.warn("Failed to send manual position to UI via WebSocket:", e.message);
        }
      }

      // Send Telegram notification
      if (this.tg && this.tg.enabled) {
        const sideEmoji = side.toLowerCase() === "long" ? "🟢" : "🔴";
        const message =
          `${sideEmoji} *Manual Trade Tracked*\n\n` +
          `Market: ${market}\n` +
          `Side: ${side.toUpperCase()}\n` +
          `Collateral: $${collateralUsd.toFixed(2)}\n` +
          `Leverage: ${leverage}x\n` +
          `Size: $${size.toFixed(2)}\n` +
          `Entry: $${entryPrice.toFixed(4)}\n` +
          `Liq: $${liquidationPrice.toFixed(4)}`;

        this.tg.say(message).catch((err) => {
          console.error("[MANUAL_TRADE] Failed to send Telegram notification:", err);
        });
      }

      console.log(`✅ [MANUAL_TRADE] Tracking manual position: ${positionId}`);
      return position;
    } catch (error) {
      console.error("[MANUAL_TRADE] Error tracking manual position:", error);
      throw error;
    }
  }

  /**
   * Validate manual trade parameters against risk limits
   * Called before building transaction for user to sign
   */
  validateManualTrade({ market, side, collateralUsd, leverage, riskOverride = false }) {
    const errors = [];

    // Basic validation
    if (!market || !MARKETS.includes(market.toUpperCase())) {
      errors.push(`Invalid market: ${market}. Must be one of: ${MARKETS.join(", ")}`);
    }

    if (!side || !["long", "short"].includes(side.toLowerCase())) {
      errors.push(`Invalid side: ${side}. Must be 'long' or 'short'`);
    }

    if (!collateralUsd || collateralUsd < 5) {
      errors.push(`Collateral too low: $${collateralUsd}. Minimum: $5`);
    }

    if (!leverage || leverage < 1 || leverage > 100) {
      errors.push(`Invalid leverage: ${leverage}. Must be between 1 and 100`);
    }

    // Risk management checks (unless overridden)
    if (!riskOverride) {
      // Check position limit
      const currentMaxPositions = MAX_POSITIONS;
      if (this.openPositions.length >= currentMaxPositions) {
        errors.push(`Position limit reached: ${this.openPositions.length}/${currentMaxPositions}`);
      }

      // Check daily trade limit
      const currentDailyLimit = DAILY_TRADE_LIMIT;
      if (this.dailyTrades >= currentDailyLimit) {
        errors.push(`Daily trade limit reached: ${this.dailyTrades}/${currentDailyLimit}`);
      }

      // Check leverage limits
      const maxLev =
        this.config?.risk?.maxLeverage || this.leverageManager?.getMaxLeverage?.() || 20;
      if (leverage > maxLev) {
        errors.push(`Leverage too high: ${leverage}x. Maximum: ${maxLev}x`);
      }

      // Check collateral limits
      const maxPositionSize = this.config?.risk?.maxPositionSize || 1000;
      if (collateralUsd > maxPositionSize) {
        errors.push(`Collateral too high: $${collateralUsd}. Maximum: $${maxPositionSize}`);
      }

      // Check available capital - CRITICAL: Use venue-specific capital
      const venueRouter = require("./utils/venue-router");
      const venue = venueRouter.getVenueForMarket(market);
      const availableCapital = this.getAvailableCapital(venue);
      if (collateralUsd > availableCapital) {
        errors.push(
          `Insufficient ${venue} capital: Need $${collateralUsd}, Available: $${availableCapital.toFixed(2)}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: riskOverride ? ["⚠️ Risk limits overridden"] : [],
    };
  }

  /**
   * Close a manually-tracked position
   * Removes from tracking and logs closure
   */
  async closeManualPosition(positionId, reason = "manual_close") {
    try {
      const position = this.openPositions.find((p) => p.positionId === positionId);

      if (!position) {
        throw new Error(`Position not found: ${positionId}`);
      }

      if (position.mode !== "manual") {
        throw new Error(`Position ${positionId} is not a manual position`);
      }

      // Get current price for the market
      const currentPrice = await this.getMarketPrice(position.market);

      // Calculate PnL
      let pnlUsd = 0;
      if (position.side.toLowerCase() === "long") {
        pnlUsd = (currentPrice - position.entryPrice) * (position.size / position.entryPrice);
      } else {
        pnlUsd = (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
      }

      const pnlPercent = (pnlUsd / position.collateral) * 100;

      // Remove from tracking
      this.openPositions = this.openPositions.filter((p) => p.positionId !== positionId);

      // Log closure
      db.logClose(
        {
          positionId: position.positionId,
          clientOrderId: position.clientOrderId,
          market: position.market,
          side: position.side,
          entryPrice: position.entryPrice,
          collateral: position.collateral,
          leverage: position.leverage,
          size: position.size,
          openTime: position.openTime,
          mode: "manual",
          pnlUSD: pnlUsd,
        },
        currentPrice,
        pnlPercent,
        reason
      );

      // Broadcast to UI
      ui.send("close", {
        market: position.market,
        side: position.side,
        pnl: pnlUsd,
        entry: position.entryPrice,
        exit: currentPrice,
        reason,
        orderId: position.positionId,
      });
      ui.send("status", this.statusSnapshot());

      // Send to UI server via WebSocket
      if (global.botWs && global.botWs.readyState === 1) {
        try {
          global.botWs.send(
            JSON.stringify({
              ev: "trade_closed",
              data: {
                id: position.positionId,
                client_order_id: position.clientOrderId,
                market: position.market,
                side: position.side,
                entry: position.entryPrice,
                exit: currentPrice,
                collateral: position.collateral,
                leverage: position.leverage,
                size: position.size,
                pnl: pnlPercent,
                pnl_usd: pnlUsd,
                reason,
                open_ts: position.openTime,
                close_ts: Date.now(),
                mode: "manual",
              },
              ts: Date.now(),
            })
          );
        } catch (e) {
          console.warn("Failed to send manual position closure to UI via WebSocket:", e.message);
        }
      }

      // Send Telegram notification
      if (this.tg && this.tg.enabled) {
        const pnlEmoji = pnlUsd >= 0 ? "💚" : "💔";
        const pnlSign = pnlUsd >= 0 ? "+" : "";
        const message =
          `${pnlEmoji} *Manual Trade Closed*\n\n` +
          `Market: ${position.market}\n` +
          `Side: ${position.side.toUpperCase()}\n` +
          `Entry: $${position.entryPrice.toFixed(4)}\n` +
          `Exit: $${currentPrice.toFixed(4)}\n` +
          `P&L: ${pnlSign}$${pnlUsd.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(2)}%)\n` +
          `Reason: ${reason}`;

        this.tg.say(message).catch((err) => {
          console.error("[MANUAL_TRADE] Failed to send Telegram notification:", err);
        });
      }

      console.log(
        `✅ [MANUAL_TRADE] Closed manual position: ${positionId}, P&L: $${pnlUsd.toFixed(2)}`
      );
      return { pnlUsd, pnlPercent, currentPrice };
    } catch (error) {
      console.error("[MANUAL_TRADE] Error closing manual position:", error);
      throw error;
    }
  }

  // ---------- Position Recovery ----------
  /**
   * Safely add a position to openPositions array, preventing duplicates
   * @param {Object} position - Position object to add
   * @returns {boolean} - true if position was added, false if it already exists
   */
  /**
   * Aggregate two positions with the same market and side
   * Matches Jupiter Perps behavior where positions are aggregated on-chain
   * @param {Object} existing - Existing position
   * @param {Object} newPos - New position to aggregate
   * @returns {Object} Aggregated position
   */
  _aggregatePositions(existing, newPos) {
    const market = existing.market || newPos.market;
    const side = existing.side || newPos.side;

    // Calculate weighted average entry price
    const size1 = Number(existing.size || 0);
    const size2 = Number(newPos.size || 0);
    const price1 = Number(existing.entryPrice || 0);
    const price2 = Number(newPos.entryPrice || 0);
    const totalSize = size1 + size2;

    let weightedAvgPrice = price1;
    if (totalSize > 0 && price1 > 0 && price2 > 0) {
      weightedAvgPrice = (price1 * size1 + price2 * size2) / totalSize;
    } else if (price2 > 0) {
      weightedAvgPrice = price2; // Use new price if existing is invalid
    }

    // Sum collateral and size
    const totalCollateral = Number(existing.collateral || 0) + Number(newPos.collateral || 0);

    // Recalculate leverage from aggregated size and collateral
    let leverage = 1;
    if (totalSize > 0 && totalCollateral > 0) {
      leverage = totalSize / totalCollateral;
    } else if (existing.leverage) {
      leverage = existing.leverage; // Fallback to existing leverage
    } else if (newPos.leverage) {
      leverage = newPos.leverage; // Fallback to new leverage
    }

    // Use earliest openTime
    const openTime = Math.min(existing.openTime || Date.now(), newPos.openTime || Date.now());

    // Keep the original positionId (on-chain PDA)
    const positionId = existing.positionId || newPos.positionId;

    // CRITICAL FIX: Preserve automated status if EITHER position is automated
    // Bot-opened positions should never lose their automated status when aggregated
    const isExistingAutomated =
      existing.trade_type === "automated" || existing.trade_type === "auto";
    const isNewAutomated = newPos.trade_type === "automated" || newPos.trade_type === "auto";
    const isExistingManual = existing.trade_type === "manual" || existing.mode === "manual";
    const isNewManual = newPos.trade_type === "manual" || newPos.mode === "manual";

    // If either position is automated, result is automated (bot-opened takes precedence)
    // Only mark as manual if BOTH are explicitly manual
    let tradeType;
    let mode;
    if (isExistingAutomated || isNewAutomated) {
      tradeType = "automated";
      mode = existing.mode === "manual" ? undefined : existing.mode || newPos.mode;
    } else if (isExistingManual && isNewManual) {
      tradeType = "manual";
      mode = "manual";
    } else {
      // Default to automated if unclear (safer for bot-opened positions)
      tradeType = existing.trade_type || newPos.trade_type || "automated";
      mode = existing.mode || newPos.mode;
    }

    return {
      ...existing,
      positionId,
      market,
      side,
      entryPrice: weightedAvgPrice,
      collateral: totalCollateral,
      size: totalSize,
      leverage,
      openTime,
      trade_type: tradeType, // Explicitly preserve manual status
      mode: mode, // Explicitly preserve manual mode
      liquidationPrice: this._calculateLiquidationPrice(weightedAvgPrice, leverage, side),
    };
  }

  _addPositionSafely(position) {
    if (!position || !position.positionId) {
      console.warn("⚠️  Attempted to add invalid position (missing positionId)");
      return false;
    }

    // CRITICAL FIX: Check if this market+side is in phantom grace period
    // This prevents sync from re-adding positions that were just removed as phantoms
    const market = position.market || MARKET;
    const side = (position.side || "long").toLowerCase();
    const venue = position.venue || (position.marketIndex !== undefined ? "drift" : "jupiter");
    const phantomKey = `${market}:${side}:${venue}`;

    // Clean up old phantom entries first
    const now = Date.now();
    for (const [key, timestamp] of this._phantomMarkets.entries()) {
      if (now - timestamp > this._PHANTOM_GRACE_PERIOD_MS) {
        this._phantomMarkets.delete(key);
      }
    }

    // Check if position is in phantom grace period
    if (this._phantomMarkets.has(phantomKey)) {
      const phantomTime = this._phantomMarkets.get(phantomKey);
      const remainingMs = this._PHANTOM_GRACE_PERIOD_MS - (now - phantomTime);
      console.log(
        `⚠️  [PHANTOM_GUARD] Blocking re-add of ${market} ${side} (${venue}) - in phantom grace period (${Math.ceil(remainingMs / 1000)}s remaining)`
      );
      return false;
    }

    // Helper to determine if a position is manual
    const isManual = (pos) => {
      return (
        pos.trade_type === "manual" ||
        pos.mode === "manual" ||
        (pos.clientOrderId && pos.clientOrderId.startsWith("manual-"))
      );
    };

    const newPosIsManual = isManual(position);

    // Check if position with same ID already exists (exact match)
    const exactMatch = this.openPositions.find((p) => p.positionId === position.positionId);
    if (exactMatch) {
      console.log(
        `🔄 Position ${position.positionId.slice(0, 8)}... already tracked with same ID, updating with latest on-chain data`
      );
      // Update existing position with latest on-chain data (Jupiter Perps aggregates on-chain)
      const index = this.openPositions.indexOf(exactMatch);
      this.openPositions[index] = this._aggregatePositions(exactMatch, position);
      return true;
    }

    // Check if position with same market and side exists (Jupiter Perps aggregates these)
    // CRITICAL: Only aggregate if both positions have the same trade_type (both manual or both automated)
    // CRITICAL: Also check venue to prevent cross-venue aggregation issues
    // Note: market, side (lowercase), venue already declared above for phantom check
    const sideUpper = (position.side || "LONG").toUpperCase();
    const existingSameMarketSide = this.openPositions.find((p) => {
      const pMarket = p.market || MARKET;
      const pSide = (p.side || "LONG").toUpperCase();
      if (pMarket !== market || pSide !== sideUpper) return false;

      // Check if venue matches (both from same exchange)
      const pVenue = p.venue || (p.marketIndex !== undefined ? "drift" : "jupiter");
      if (pVenue !== venue) {
        // Different venues - don't aggregate
        return false;
      }

      // Check if trade_type matches (both manual or both automated)
      const pIsManual = isManual(p);
      if (pIsManual !== newPosIsManual) {
        // Different trade types - don't aggregate
        return false;
      }
      return true;
    });

    if (existingSameMarketSide) {
      console.log(
        `🔄 Aggregating position: ${position.positionId.slice(0, 8)}... with existing ${existingSameMarketSide.positionId.slice(0, 8)}... (${market}, ${side}, ${newPosIsManual ? "manual" : "automated"})`
      );
      // Aggregate with existing position (matches Jupiter Perps behavior)
      const index = this.openPositions.indexOf(existingSameMarketSide);
      this.openPositions[index] = this._aggregatePositions(existingSameMarketSide, position);
      return true;
    }

    // New position - add it
    this.openPositions.push(position);
    return true;
  }

  /**
   * Check if a position was opened by the bot (not manually)
   * Bot-opened positions have:
   * - trade_type === 'automated'
   * - clientOrderId is a 48-char hex SHA-256 hash
   *
   * Manual/synced positions have:
   * - trade_type === 'manual'
   * - mode === 'manual'
   * - clientOrderId like "1764980267054_5CB1DRzc" (timestamp_positionId)
   * - clientOrderId like "manual-{timestamp}"
   *
   * @param {Object} pos - Position object
   * @returns {boolean} - True if position was opened by bot
   */
  _isBotOpenedPosition(pos) {
    if (!pos) return false;

    // Source of truth: explicit trade_type (when present).
    const tt = pos.trade_type ? String(pos.trade_type).toLowerCase() : null;
    if (tt === "automated" || tt === "auto" || tt === "bot") return true;
    if (tt === "manual") return false;
    // Backwards compatibility
    if (pos.mode === "manual") return false;

    // Check clientOrderId format:
    // Bot-opened: 48-char hex SHA-256 hash (e.g., "a1b2c3d4e5f6...")
    // Manual/synced: timestamp_positionId format (e.g., "1764980267054_5CB1DRzc")
    // Manual via UI: "manual-{timestamp}" format
    const clientOrderId = pos.clientOrderId;
    if (clientOrderId) {
      // Manual patterns
      if (clientOrderId.startsWith("manual-")) return false;
      if (/^\d{13,}_/.test(clientOrderId)) return false; // timestamp_positionId format

      // Bot-opened: 48-char hex hash
      if (/^[a-f0-9]{48}$/i.test(clientOrderId)) return true;
    }

    // If we can't determine, check database
    try {
      const dbPositions = db.listOpen();
      const dbPos = dbPositions.find((p) => p.id === pos.positionId);
      if (dbPos) {
        const t = String(dbPos.trade_type || "").toLowerCase();
        if (t === "automated" || t === "auto" || t === "bot") return true;
        if (t === "manual") return false;
      }
    } catch (e) {
      // Ignore DB errors
    }

    // Default to false (safer to NOT apply automated exits to unknown positions)
    return false;
  }

  /**
   * Remove duplicate positions from openPositions array
   * Keeps the first occurrence of each positionId
   * @returns {number} - Number of duplicates removed
   */
  _removeDuplicatePositions() {
    const seen = new Set();
    const originalLength = this.openPositions.length;
    const unique = [];

    for (const pos of this.openPositions) {
      if (!pos.positionId) {
        console.warn("⚠️  Found position without positionId, removing it");
        continue;
      }

      if (!seen.has(pos.positionId)) {
        seen.add(pos.positionId);
        unique.push(pos);
      } else {
        console.warn(
          `⚠️  Removing duplicate position: ${pos.positionId.slice(0, 8)}... (market: ${pos.market}, side: ${pos.side})`
        );
      }
    }

    const duplicatesRemoved = originalLength - unique.length;
    if (duplicatesRemoved > 0) {
      console.log(`🧹 Removed ${duplicatesRemoved} duplicate position(s) from openPositions`);
      this.openPositions = unique;
    }

    return duplicatesRemoved;
  }

  /**
   * Recover open positions from on-chain and database on startup
   * This handles positions that exist when the bot restarts
   * CRITICAL: Queries ALL on-chain positions first, then syncs with database
   */
  async recoverPositions() {
    try {
      console.log("📦 Starting position recovery...");

      // Step -1: Fix misclassified manual positions (one-time migration)
      // RECOVERY_FIX_MANUAL_POSITIONS=true will convert all manual Drift positions to automated
      // This fixes positions that were incorrectly classified due to position ID mismatch during restart
      if (process.env.RECOVERY_FIX_MANUAL_POSITIONS === "true") {
        try {
          const dbPositionsToFix = db.listOpen();
          let fixedCount = 0;
          for (const dbPos of dbPositionsToFix) {
            const isDrift = dbPos.id?.startsWith("drift-");
            const isManual = dbPos.trade_type === "manual";
            if (isDrift && isManual) {
              db.updateOpen(dbPos.id, { trade_type: "automated" });
              console.log(
                `🔧 [FIX] Converted position ${dbPos.id.slice(0, 12)}... from manual to automated`
              );
              fixedCount++;
            }
          }
          if (fixedCount > 0) {
            console.log(`✅ [FIX] Fixed ${fixedCount} misclassified manual Drift position(s)`);
          }
        } catch (fixErr) {
          console.warn(`⚠️  Failed to fix manual positions: ${fixErr.message}`);
        }
      }

      // Step 0: Clean up any existing duplicates before recovery
      const duplicatesRemoved = this._removeDuplicatePositions();
      if (duplicatesRemoved > 0) {
        console.log(`🧹 Cleaned up ${duplicatesRemoved} duplicate position(s) before recovery`);
      }

      // Step 0.5: Clean up stale pending positions from DB
      // These are maker limit orders that were placed but never filled before restart
      // On restart, the on-chain limit order is gone, so these should be removed from DB
      try {
        const allDbPositions = db.listOpen();
        const pendingPositions = allDbPositions.filter((p) => p.status === "pending");
        if (pendingPositions.length > 0) {
          console.log(
            `🧹 Found ${pendingPositions.length} pending (unfilled) position(s) in DB - will verify on-chain`
          );
        }
      } catch (pendingErr) {
        console.warn(`⚠️  Failed to check pending positions: ${pendingErr.message}`);
      }

      // Step 1: Query all on-chain positions (live mode only)
      // Uses venue-aware executor to get positions from both Jupiter and Drift
      let onChainPositions = [];
      if (
        this.liveMode &&
        this.tradeExecutor &&
        typeof this.tradeExecutor.getAllOpenPositions === "function"
      ) {
        try {
          console.log("🔍 Querying all on-chain positions (Jupiter + Drift)...");
          onChainPositions = await this.tradeExecutor.getAllOpenPositions();
          console.log(`✅ Found ${onChainPositions.length} on-chain position(s)`);
        } catch (onChainError) {
          console.warn(`⚠️  Failed to query on-chain positions: ${onChainError.message}`);
          // Continue with DB recovery as fallback
        }
      }

      // Step 2: Load positions from database
      const dbPositions = db.listOpen();
      console.log(`📊 Found ${dbPositions.length} position(s) in database`);

      // Create a map of database positions by positionId for quick lookup
      const dbPosMap = new Map();
      for (const dbPos of dbPositions) {
        dbPosMap.set(dbPos.id, dbPos);
      }

      // Create a map of on-chain positions by address for quick lookup
      const onChainPosMap = new Map();
      for (const onChainPos of onChainPositions) {
        const posId = onChainPos.positionId || onChainPos.id || onChainPos.address;
        if (posId) {
          onChainPosMap.set(posId, onChainPos);
        }
      }

      // Step 2.5: Clean up stale pending positions
      // These are maker limit orders that were placed but never filled before restart
      // If there's no matching on-chain position, the limit order expired/cancelled
      try {
        const pendingDbPositions = dbPositions.filter((p) => p.status === "pending");
        for (const pendingPos of pendingDbPositions) {
          // Check if there's a matching on-chain position for this market/side
          // We can't match by ID (on-chain IDs change), so match by market+side
          const hasOnChainMatch = onChainPositions.some((ocp) => {
            const ocpMarket = ocp.marketSymbol || ocp.market;
            const ocpSide = (ocp.side || "").toLowerCase();
            return (
              ocpMarket === pendingPos.market && ocpSide === (pendingPos.side || "").toLowerCase()
            );
          });

          if (!hasOnChainMatch) {
            // No on-chain position for this market/side - the limit order never filled
            console.log(
              `🗑️  Removing stale pending position from DB: ${pendingPos.id?.slice(0, 12)}... (${pendingPos.market} ${pendingPos.side}) - no on-chain position found`
            );
            db.removeOpen(pendingPos.id);
          } else {
            // On-chain position exists - update status to filled
            console.log(
              `✅ Pending position ${pendingPos.id?.slice(0, 12)}... has on-chain match - updating status to filled`
            );
            db.updateOpen(pendingPos.id, { status: "filled" });
          }
        }
      } catch (cleanupErr) {
        console.warn(`⚠️  Failed to clean up pending positions: ${cleanupErr.message}`);
      }

      // Step 3: Recover positions from on-chain (authoritative source)
      let recoveredFromOnChain = 0;
      for (const onChainPos of onChainPositions) {
        try {
          const posId = onChainPos.positionId || onChainPos.id || onChainPos.address;
          const dbPos = dbPosMap.get(posId);
          const positionMarket = onChainPos.marketSymbol || dbPos?.market || MARKET;

          // Config: default treatment for on-chain positions that are not in DB (unknown origin).
          // SAFETY DEFAULT: manual (bot will not auto-close).
          const unknownTradeTypeRaw = String(
            process.env.RECOVERY_UNKNOWN_TRADE_TYPE || "manual"
          ).toLowerCase();
          const unknownTradeType =
            unknownTradeTypeRaw === "automated" ||
            unknownTradeTypeRaw === "auto" ||
            unknownTradeTypeRaw === "bot"
              ? "automated"
              : "manual";

          // Determine trade type:
          // - Trust DB if present
          // - If not in DB, treat as manual/external (safest; prevents bot from auto-closing user positions)
          const dbTradeTypeRaw = dbPos?.trade_type || dbPos?.tradeType || null;
          const dbClientOrderId = dbPos?.client_order_id || null;
          const dbClientIdLooksBot =
            !!dbClientOrderId && /^[a-f0-9]{48}$/i.test(String(dbClientOrderId));
          const dbClientIdExplicitManual =
            !!dbClientOrderId && String(dbClientOrderId).startsWith("manual-");

          // Trade type inference rules (recovery):
          // - If DB has an explicit trade_type, TRUST it (do not override based on client_order_id heuristics).
          // - If DB doesn't have trade_type (legacy/malformed), infer:
          //    - manual if client_order_id is explicitly manual-*
          //    - automated if client_order_id looks like bot hash
          //    - otherwise use RECOVERY_UNKNOWN_TRADE_TYPE (safety default: manual)
          const normalizedDbTradeType = dbTradeTypeRaw
            ? String(dbTradeTypeRaw).toLowerCase()
            : null;

          // CRITICAL FIX: For Drift positions, clientOrderId may be null even for bot-opened trades
          // Always trust DB trade_type if it exists, since that was set when the position was opened
          // Only fall back to clientOrderId-based inference when DB has no record or no trade_type
          const inferredTradeType = normalizedDbTradeType
            ? normalizedDbTradeType === "auto" || normalizedDbTradeType === "bot"
              ? "automated"
              : normalizedDbTradeType
            : !dbPos
              ? unknownTradeType
              : dbClientIdExplicitManual
                ? "manual"
                : dbClientIdLooksBot
                  ? "automated"
                  : unknownTradeType;

          // Get size from on-chain (authoritative)
          const sizeUsd = Number(onChainPos.sizeUsd || onChainPos.size || 0);

          // For collateral and leverage: prioritize DB values (what we calculated when opening)
          // For Drift cross-margin, on-chain collateral is dynamically allocated and may differ
          // from our intended collateral. DB stores our calculated values for risk management consistency.
          const dbCollateral = dbPos?.collateral;
          const dbLeverage = dbPos?.leverage;

          let collateralUsd;
          let leverage;

          if (
            dbPos &&
            Number.isFinite(dbCollateral) &&
            dbCollateral > 0 &&
            Number.isFinite(dbLeverage) &&
            dbLeverage > 0
          ) {
            // Trust DB values (our original calculation)
            collateralUsd = dbCollateral;
            leverage = dbLeverage;
            console.log(
              `[RECOVERY] Using DB collateral/leverage for ${posId.slice(0, 8)}...: $${collateralUsd.toFixed(2)} @ ${leverage}x (DB source)`
            );
          } else {
            // Fallback to on-chain values (may be inaccurate for cross-margin)
            collateralUsd = Number(onChainPos.collateralUsd || onChainPos.collateral || 0);
            leverage = Number(onChainPos.leverage || 0);

            // If leverage is 0 or invalid, calculate from size and collateral
            if (!leverage || leverage <= 0) {
              leverage = sizeUsd > 0 && collateralUsd > 0 ? sizeUsd / collateralUsd : 1;
            }
            // Ensure leverage is at least 1 (sanity check)
            if (!leverage || leverage <= 0) {
              console.warn(
                `⚠️  Invalid leverage calculated for position ${posId.slice(0, 8)}..., defaulting to 1. sizeUsd=${sizeUsd}, collateralUsd=${collateralUsd}`
              );
              leverage = 1;
            }
            console.log(
              `[RECOVERY] Using on-chain collateral/leverage for ${posId.slice(0, 8)}...: $${collateralUsd.toFixed(2)} @ ${leverage.toFixed(1)}x (on-chain source)`
            );
          }
          const entryPrice = Number(onChainPos.entryPrice || onChainPos.price || 0);
          const side = (onChainPos.side || "LONG").toUpperCase();

          // Validate critical position data - if invalid, skip recovery to prevent false exits
          if (!entryPrice || entryPrice <= 0) {
            console.error(
              `❌ Skipping recovery of position ${posId.slice(0, 8)}...: invalid entry price (${entryPrice})`
            );
            errorHandler.log(new Error(`Invalid entry price for recovered position`), {
              category: Category.VALIDATION,
              severity: Severity.HIGH,
              context: { positionId: posId, entryPrice, onChainPos: JSON.stringify(onChainPos) },
            });
            continue;
          }

          if (!sizeUsd || sizeUsd <= 0) {
            console.error(
              `❌ Skipping recovery of position ${posId.slice(0, 8)}...: invalid size (${sizeUsd})`
            );
            continue;
          }

          // Use DB timestamp if available (more reliable), otherwise on-chain updateTime, fallback to current time
          // If updateTime is 0 or invalid, prefer DB timestamp
          let openTime = dbPos?.ts;
          if (!openTime || openTime <= 0) {
            const onChainTime = Number(onChainPos.updateTime || 0);
            // If on-chain time is valid (not 0 and reasonable timestamp), use it
            // Check if it's in seconds (Unix timestamp < 1e12) and convert to ms
            if (onChainTime > 0) {
              openTime = onChainTime < 1e12 ? onChainTime * 1000 : onChainTime;
            } else {
              // Last resort: use current time but log warning
              openTime = Date.now();
              console.warn(
                `⚠️  Position ${posId.slice(0, 8)}... has no valid timestamp, using current time. This may affect time-based exits.`
              );
            }
          }

          // CRITICAL FIX: Check if position already exists in openPositions with automated status
          // Never downgrade from automated to manual during recovery
          const existingPos = this.openPositions.find((p) => {
            const trackedId = p.positionId;
            if (!trackedId) return false;
            // Exact match
            if (trackedId === posId) return true;
            // Fuzzy match (handle format variations)
            if (
              trackedId.slice(0, 8) === posId.slice(0, 8) ||
              trackedId.startsWith(posId) ||
              posId.startsWith(trackedId)
            ) {
              return true;
            }
            return false;
          });
          const existingIsAutomated =
            existingPos &&
            (existingPos.trade_type === "automated" || existingPos.trade_type === "auto");

          // CRITICAL: If existing position is automated, preserve that (never downgrade)
          // Only use inferredTradeType if existing position wasn't already automated
          const finalTradeType = existingIsAutomated ? "automated" : inferredTradeType;

          // CRITICAL FIX: Extract baseSize from on-chain position
          // closePosition() requires baseSize to know how many units to close
          // Without this, close fails with "baseSize is invalid"
          const baseSize = Number(onChainPos.baseSize || onChainPos.sizeBase || 0);

          const position = {
            positionId: posId,
            // IMPORTANT:
            // - Preserve DB client_order_id for bot-opened positions
            // - Preserve existing clientOrderId if position was already tracked (bot-opened)
            // - Do NOT generate synthetic clientOrderId for positions not in DB (can be misclassified as bot-opened)
            clientOrderId: existingPos?.clientOrderId || dbPos?.client_order_id || null,
            market: positionMarket,
            marketIndex: onChainPos.marketIndex, // CRITICAL: For Drift closePosition
            side: side,
            entryPrice: entryPrice,
            collateral: collateralUsd,
            leverage: leverage,
            size: sizeUsd,
            sizeUsd: sizeUsd, // Alias for compatibility
            baseSize: baseSize, // CRITICAL: Required by closePosition()
            sizeBase: baseSize, // Alias for compatibility
            openTime: openTime,
            liquidationPrice: this._calculateLiquidationPrice(entryPrice, leverage, side),
            strategyType: this.strategyFactory.getStrategyType(positionMarket),
            trade_type: finalTradeType,
            venue: onChainPos.venue || "drift", // Preserve venue for routing
          };

          // REMOVED: The old logic that "corrected" DB records from automated->manual during sync
          // was causing bot-opened Drift positions (with null clientOrderId) to be misclassified.
          // Now we trust the DB record as the source of truth for trade_type.

          // Log recovered position details for debugging
          if (existingIsAutomated && finalTradeType !== inferredTradeType) {
            console.log(
              `⚠️  [RECOVERY] Preserved automated status for position ${posId.slice(0, 8)}... (was ${inferredTradeType}, now automated)`
            );
          }
          console.log(
            `📋 Recovered position details: ${posId.slice(0, 8)}... entry=$${entryPrice.toFixed(2)}, size=$${sizeUsd.toFixed(2)}, collateral=$${collateralUsd.toFixed(2)}, leverage=${leverage.toFixed(2)}, trade_type=${finalTradeType}, openTime=${new Date(openTime).toISOString()}`
          );

          // _addPositionSafely will aggregate if same market/side exists (matches Jupiter Perps behavior)
          if (!this._addPositionSafely(position)) {
            // Position was aggregated or already exists, continue
            continue;
          }

          // CRITICAL: After adding, ensure automated status is preserved if it was set
          if (existingIsAutomated) {
            const updatedPos = this.openPositions.find((p) => p.positionId === posId);
            if (updatedPos && updatedPos.trade_type !== "automated") {
              updatedPos.trade_type = "automated";
              if (updatedPos.mode === "manual") delete updatedPos.mode;
              console.log(
                `✅ [RECOVERY] Fixed trade_type for position ${posId.slice(0, 8)}... (preserved automated)`
              );
            }
          }

          // Mark as recovered to skip time-based exits (openTime may be inaccurate)
          this._recoveredPositionIds.add(posId);

          // If position not in database, log it
          if (!dbPos) {
            console.log(
              `📝 On-chain position ${posId.slice(0, 8)}... not in database (unknown origin). Logging as ${unknownTradeType} (set RECOVERY_UNKNOWN_TRADE_TYPE=automated to manage unknowns on redeploy)...`
            );
            try {
              db.logOpen({
                positionId: posId,
                // Do not invent a clientOrderId for unknown/manual positions
                clientOrderId: null,
                market: positionMarket,
                side: side,
                entryPrice: entryPrice,
                collateral: collateralUsd,
                leverage: leverage,
                size: sizeUsd,
                openTime: position.openTime,
                mode: this.liveMode ? "live" : "paper",
                trade_type: unknownTradeType,
                environment: this.environment || "live",
                instance_id: this.instanceId || null,
              });
              console.log(`✅ Logged on-chain position to database: ${posId.slice(0, 8)}...`);
            } catch (dbError) {
              console.warn(`⚠️  Failed to log position to database: ${dbError.message}`);
              errorHandler.log(dbError, {
                category: Category.SYSTEM,
                severity: Severity.MEDIUM,
                context: { action: "logOnChainPosition", positionId: posId },
              });
            }
          }

          recoveredFromOnChain++;
          console.log(
            `✅ Recovered position ${posId.slice(0, 8)}... (${positionMarket}, ${side}, $${collateralUsd.toFixed(2)})`
          );
        } catch (e) {
          errorHandler.log(e, {
            category: Category.SYSTEM,
            severity: Severity.MEDIUM,
            context: {
              action: "recoverOnChainPosition",
              positionId: onChainPos.positionId || onChainPos.id,
            },
          });
          console.error(`❌ Failed to recover on-chain position:`, e.message);
        }
      }

      // Step 4: Mark database positions as closed if they don't exist on-chain (live mode)
      let closedFromDb = 0;
      if (this.liveMode && onChainPositions.length > 0) {
        for (const dbPos of dbPositions) {
          const posId = dbPos.id;
          if (!onChainPosMap.has(posId)) {
            // Position in DB but not on-chain - mark as closed
            console.warn(
              `⚠️  Position ${posId.slice(0, 8)}... exists in DB but not on-chain, marking as closed`
            );
            try {
              db.logClose(
                {
                  positionId: posId,
                  clientOrderId: dbPos.client_order_id,
                  market: dbPos.market || MARKET,
                  mode: dbPos.mode || (this.liveMode ? "live" : "paper"),
                },
                dbPos.entry,
                0,
                "recovery_closed_missing"
              );
              closedFromDb++;
            } catch (dbError) {
              console.error(`❌ Failed to close position in DB: ${dbError.message}`);
            }
          }
        }
      } else if (!this.liveMode) {
        // Paper mode: restore all positions from DB
        for (const dbPos of dbPositions) {
          // Skip if already recovered from on-chain
          if (onChainPosMap.has(dbPos.id)) continue;

          try {
            const positionMarket = dbPos.market || MARKET;
            // Ensure leverage is valid - calculate from size/collateral if missing or 0
            let leverage = Number(dbPos.leverage || 0);
            const sizeUsd = Number(dbPos.size || 0);
            const collateralUsd = Number(dbPos.collateral || 0);
            if (!leverage || leverage <= 0) {
              leverage = sizeUsd > 0 && collateralUsd > 0 ? sizeUsd / collateralUsd : 1;
            }
            if (!leverage || leverage <= 0) {
              console.warn(
                `⚠️  Invalid leverage for DB position ${dbPos.id?.slice(0, 8)}..., defaulting to 1. size=${sizeUsd}, collateral=${collateralUsd}`
              );
              leverage = 1;
            }

            const position = {
              positionId: dbPos.id,
              clientOrderId: dbPos.client_order_id,
              market: positionMarket,
              side: dbPos.side,
              entryPrice: dbPos.entry,
              collateral: dbPos.collateral,
              leverage: leverage,
              size: dbPos.size,
              openTime: dbPos.ts || Date.now(),
              liquidationPrice: this.priceClient._liq(dbPos.entry, leverage, dbPos.side),
              strategyType: this.strategyFactory.getStrategyType(positionMarket),
              trade_type: dbPos.trade_type || (dbPos.mode === "manual" ? "manual" : "automated"),
            };

            // _addPositionSafely will aggregate if same market/side exists (matches Jupiter Perps behavior)
            if (this._addPositionSafely(position)) {
              // Mark as recovered to skip time-based exits (openTime may be inaccurate)
              this._recoveredPositionIds.add(position.positionId);

              recoveredFromOnChain++;
              console.log(
                `✅ Recovered position ${position.positionId.slice(0, 8)}... from DB (${positionMarket})`
              );
            } else {
              console.log(
                `🔄 Position ${position.positionId.slice(0, 8)}... aggregated with existing position (${positionMarket})`
              );
            }
          } catch (e) {
            console.error(
              `❌ Failed to recover position ${dbPos.id?.slice(0, 8) || "unknown"}...:`,
              e.message
            );
          }
        }
      }

      // Step 5: Update balance to reflect locked collateral
      for (const pos of this.openPositions) {
        if (this.liveMode) {
          this.liveBalance = Math.max(0, (this.liveBalance || 0) - pos.collateral);
        } else {
          this.paperBalance = Math.max(0, (this.paperBalance || 0) - pos.collateral);
        }
      }

      // Step 6: Aggregate any existing positions with same market/side (Jupiter Perps aggregates on-chain)
      // This ensures positions are aggregated immediately on startup, not waiting for sync
      // CRITICAL: Only aggregate positions with the same trade_type (manual vs automated)
      let existingPositionsAggregated = 0;
      const marketSideMap = new Map();
      const positionsToRemove = [];

      // Helper to determine if a position is manual
      const isManual = (pos) => {
        return (
          pos.trade_type === "manual" ||
          pos.mode === "manual" ||
          (pos.clientOrderId && pos.clientOrderId.startsWith("manual-"))
        );
      };

      for (const pos of this.openPositions) {
        const market = pos.market || MARKET;
        const side = (pos.side || "LONG").toUpperCase();
        const posIsManual = isManual(pos);
        // Include trade_type in key to prevent manual/automated mixing
        const key = `${market}:${side}:${posIsManual ? "manual" : "automated"}`;

        if (!marketSideMap.has(key)) {
          marketSideMap.set(key, pos);
        } else {
          const existing = marketSideMap.get(key);
          const aggregated = this._aggregatePositions(existing, pos);
          marketSideMap.set(key, aggregated);
          positionsToRemove.push(pos);
          existingPositionsAggregated++;
          console.log(
            `🔄 Aggregated existing positions on recovery: ${pos.positionId.slice(0, 8)}... + ${existing.positionId.slice(0, 8)}... (${market}, ${side}, ${posIsManual ? "manual" : "automated"})`
          );
        }
      }

      // Apply aggregations
      if (positionsToRemove.length > 0) {
        this.openPositions = this.openPositions.filter((p) => !positionsToRemove.includes(p));
        // Update with aggregated versions
        for (const [key, aggregated] of marketSideMap.entries()) {
          const [market, side, tradeType] = key.split(":");
          const existingIndex = this.openPositions.findIndex((p) => {
            const pMarket = p.market || MARKET;
            const pSide = (p.side || "LONG").toUpperCase();
            const pIsManual = isManual(p);
            const pTradeType = pIsManual ? "manual" : "automated";
            return pMarket === market && pSide === side && pTradeType === tradeType;
          });
          if (existingIndex >= 0) {
            this.openPositions[existingIndex] = aggregated;
          }
        }
      }

      const recoveredCount = this.openPositions.length;
      const lockedCapital = this.getLockedCapital();
      console.log(`✅ Position recovery complete:`);
      console.log(`   - Recovered from on-chain: ${recoveredFromOnChain}`);
      console.log(`   - Closed from DB (not on-chain): ${closedFromDb}`);
      console.log(`   - Existing positions aggregated: ${existingPositionsAggregated}`);
      console.log(`   - Total active positions: ${recoveredCount}`);
      console.log(`   - Locked capital: $${lockedCapital.toFixed(2)}`);

      // Send Telegram notification if positions recovered
      if (recoveredCount > 0 && this.tg && this.tg.enabled) {
        this.tg
          .say(
            `📦 *Positions Recovered*\n` +
              `On-chain: ${recoveredFromOnChain}\n` +
              `Total Active: ${recoveredCount}\n` +
              `Locked Capital: $${lockedCapital.toFixed(2)}`
          )
          .catch((err) => {
            errorHandler.log(err, {
              category: Category.SYSTEM,
              severity: Severity.LOW,
              context: { action: "telegramRecoveryNotification" },
            });
          });
      }
    } catch (e) {
      errorHandler.log(e, {
        category: Category.SYSTEM,
        severity: Severity.HIGH,
        context: { action: "recoverPositions" },
      });
      console.error("❌ Position recovery failed:", e.message);
      console.error("   Stack:", e.stack);
    }
  }

  /**
   * Periodically sync positions from on-chain to detect manually opened positions
   * This ensures the bot tracks all positions, including those opened outside the bot
   * Runs every 5 minutes (300 ticks with 1s tick interval) to avoid rate limits
   */
  async _syncPositionsFromChain() {
    if (
      !this.liveMode ||
      !this.tradeExecutor ||
      typeof this.tradeExecutor.getAllOpenPositions !== "function"
    ) {
      return; // Only sync in live mode with valid executor
    }

    try {
      // Fetch all on-chain positions (venue-aware: Jupiter + Drift)
      const onChainPositions = await this.tradeExecutor.getAllOpenPositions();
      console.log(
        `🔄 Position sync: Found ${onChainPositions.length} position(s) on-chain (Jupiter + Drift)`
      );

      // Log all on-chain positions for debugging
      if (onChainPositions.length > 0) {
        console.log(`📋 On-chain positions details:`);
        for (const pos of onChainPositions) {
          const posId = pos.positionId || pos.id || pos.address || "unknown";
          const market = pos.marketSymbol || pos.market || "unknown";
          const side = (pos.side || "unknown").toUpperCase();
          const size = Number(pos.sizeUsd || pos.size || 0);
          console.log(
            `   - ${posId.slice(0, 8)}... (${market}, ${side}, size: $${size.toFixed(2)})`
          );
        }
      }

      const onChainPosMap = new Map();

      // Create map of on-chain positions by positionId
      for (const onChainPos of onChainPositions) {
        const posId = onChainPos.positionId || onChainPos.id || onChainPos.address;
        if (posId) {
          onChainPosMap.set(posId, onChainPos);
        }
      }

      console.log(`📊 Currently tracking ${this.openPositions.length} position(s) in bot`);

      // Check for new positions that aren't in openPositions
      let newPositionsAdded = 0;
      for (const onChainPos of onChainPositions) {
        const posId = onChainPos.positionId || onChainPos.id || onChainPos.address;
        if (!posId) {
          console.warn(`⚠️  On-chain position missing positionId: ${JSON.stringify(onChainPos)}`);
          continue;
        }

        // Check if position already tracked (with fuzzy matching for ID format variations)
        const exactMatch = this.openPositions.find((p) => {
          const trackedId = p.positionId;
          if (!trackedId) return false;
          // Exact match
          if (trackedId === posId) return true;
          // Fuzzy match (handle format variations)
          if (
            trackedId.slice(0, 8) === posId.slice(0, 8) ||
            trackedId.startsWith(posId) ||
            posId.startsWith(trackedId)
          ) {
            return true;
          }
          return false;
        });

        const positionMarket = onChainPos.marketSymbol || onChainPos.market || MARKET;
        const side = (onChainPos.side || "LONG").toUpperCase();

        // Check if position with same market and side exists (Jupiter Perps aggregates these on-chain)
        const sameMarketSide = this.openPositions.find((p) => {
          const pMarket = p.market || MARKET;
          const pSide = (p.side || "LONG").toUpperCase();
          return pMarket === positionMarket && pSide === side;
        });

        // If exact match exists, update it with latest on-chain data
        if (exactMatch) {
          console.log(
            `🔄 Updating existing position ${posId.slice(0, 8)}... with latest on-chain data`
          );
          // Update with latest on-chain data (Jupiter Perps may have aggregated on-chain)
          const sizeUsd = Number(onChainPos.sizeUsd || onChainPos.size || 0);
          const collateralUsd = Number(onChainPos.collateralUsd || onChainPos.collateral || 0);
          const entryPrice = Number(onChainPos.entryPrice || onChainPos.price || 0);
          let leverage = Number(onChainPos.leverage || 0);
          if (!leverage || leverage <= 0) {
            leverage =
              sizeUsd > 0 && collateralUsd > 0 ? sizeUsd / collateralUsd : exactMatch.leverage || 1;
          }

          // CRITICAL FIX: Extract baseSize from on-chain position
          const baseSize = Number(onChainPos.baseSize || onChainPos.sizeBase || 0);

          const updatedPosition = {
            ...exactMatch,
            positionId: posId, // Use on-chain positionId
            market: positionMarket,
            marketIndex: onChainPos.marketIndex, // CRITICAL: For Drift closePosition
            side: side,
            entryPrice: entryPrice,
            collateral: collateralUsd,
            leverage: leverage,
            size: sizeUsd,
            sizeUsd: sizeUsd, // Alias for compatibility
            baseSize: baseSize, // CRITICAL: Required by closePosition()
            sizeBase: baseSize, // Alias for compatibility
            venue: onChainPos.venue || exactMatch.venue, // Preserve venue for routing
            liquidationPrice: this._calculateLiquidationPrice(entryPrice, leverage, side),
          };

          // CRITICAL FIX: Preserve automated status if position has bot clientOrderId pattern
          // Check clientOrderId FIRST before DB lookup (bot-opened positions have 48-char hex hash)
          const hasBotClientOrderId =
            updatedPosition.clientOrderId && /^[a-f0-9]{48}$/i.test(updatedPosition.clientOrderId);
          const existingIsAutomated =
            exactMatch.trade_type === "automated" || exactMatch.trade_type === "auto";

          // CRITICAL: Check DB FIRST to see if position was marked as automated there
          // This prevents bot-opened positions from being downgraded even if in-memory state is wrong
          // NOTE: Drift position IDs change between creation and sync (drift-maker-{ts} → drift-{idx}-{side})
          // So we must also check by market+side as a fallback
          let dbSaysAutomated = false;
          try {
            const dbPositions = db.listOpen();
            // Primary lookup by positionId
            let dbPos = dbPositions.find((p) => p.id === posId);
            // Fallback: lookup by market+side (handles Drift ID format changes after restart)
            if (!dbPos && positionMarket) {
              dbPos = dbPositions.find(
                (p) =>
                  p.market === positionMarket && String(p.side).toLowerCase() === side.toLowerCase()
              );
              if (dbPos) {
                console.log(
                  `🔍 [SYNC] Found DB position by market+side fallback: ${positionMarket} ${side}`
                );
              }
            }
            const dbT = dbPos?.trade_type ? String(dbPos.trade_type).toLowerCase() : null;
            dbSaysAutomated = dbT === "automated" || dbT === "auto" || dbT === "bot";
          } catch (e) {
            // Ignore DB errors in this check
          }

          // CRITICAL: Never downgrade from automated to manual during sync
          // If position was already marked automated (in-memory OR DB), ALWAYS preserve that status
          if (hasBotClientOrderId || existingIsAutomated || dbSaysAutomated) {
            updatedPosition.trade_type = "automated";
            if (updatedPosition.mode === "manual") delete updatedPosition.mode;
            const reason = hasBotClientOrderId
              ? "bot clientOrderId"
              : existingIsAutomated
                ? "existing automated"
                : "DB confirmed automated";
            console.log(
              `✅ [SYNC] Preserved automated status for position ${posId.slice(0, 8)}... (${reason})`
            );
          } else {
            // Reconcile trade_type using DB as source-of-truth (fixes cases where recovery/sync heuristics
            // incorrectly marked a bot-opened position as manual due to client_order_id format).
            // CRITICAL: Only upgrade from manual to automated, never downgrade
            try {
              const dbPositions2 = db.listOpen();
              // Primary lookup by positionId, fallback by market+side
              let dbPos = dbPositions2.find((p) => p.id === posId);
              if (!dbPos && positionMarket) {
                dbPos = dbPositions2.find(
                  (p) =>
                    p.market === positionMarket &&
                    String(p.side).toLowerCase() === side.toLowerCase()
                );
              }
              const dbT = dbPos?.trade_type ? String(dbPos.trade_type).toLowerCase() : null;
              if (dbT === "automated" || dbT === "auto" || dbT === "bot") {
                // DB confirms automated - upgrade to automated
                updatedPosition.trade_type = "automated";
                if (updatedPosition.mode === "manual") delete updatedPosition.mode;
                console.log(
                  `✅ [SYNC] Upgraded position ${posId.slice(0, 8)}... to automated (DB confirmed)`
                );
              } else if (dbT === "manual") {
                // Only set to manual if DB explicitly says manual AND existing wasn't automated
                // This prevents downgrading bot-opened positions that were temporarily missing from DB
                if (!existingIsAutomated) {
                  updatedPosition.trade_type = "manual";
                  updatedPosition.mode = "manual"; // backwards compat flag for manual tracking
                  console.log(
                    `📝 [SYNC] Marked position ${posId.slice(0, 8)}... as manual (DB confirmed manual, existing not automated)`
                  );
                } else {
                  // Existing was automated - preserve it even if DB says manual (DB might be stale)
                  updatedPosition.trade_type = "automated";
                  if (updatedPosition.mode === "manual") delete updatedPosition.mode;
                  console.log(
                    `⚠️  [SYNC] Preserved automated status for ${posId.slice(0, 8)}... despite DB saying manual (DB may be stale)`
                  );
                }
              } else {
                // DB has no trade_type - preserve existing status (don't default to manual)
                // CRITICAL: Default to 'automated' if existing is undefined/null (safer for bot-opened positions)
                // Only use 'manual' if existing position was explicitly marked as manual
                const preservedTradeType =
                  exactMatch.trade_type || (exactMatch.mode === "manual" ? "manual" : "automated");
                updatedPosition.trade_type = preservedTradeType;
                if (preservedTradeType === "automated" && updatedPosition.mode === "manual") {
                  delete updatedPosition.mode;
                } else if (preservedTradeType === "manual") {
                  updatedPosition.mode = "manual";
                }
                console.log(
                  `✅ [SYNC] Preserved existing trade_type for position ${posId.slice(0, 8)}... (DB has no trade_type, using: ${preservedTradeType})`
                );
              }
            } catch (e) {
              // Ignore DB errors; preserve existing trade_type (never downgrade to manual)
              updatedPosition.trade_type = exactMatch.trade_type || "automated";
              console.log(
                `✅ [SYNC] Preserved existing trade_type for position ${posId.slice(0, 8)}... (DB error: ${e.message})`
              );
            }
          }

          const index = this.openPositions.indexOf(exactMatch);
          this.openPositions[index] = updatedPosition;
          continue;
        }

        // This is a new position - add it (will aggregate if same market/side exists)
        try {
          // CRITICAL FIX: Check if position already exists in openPositions BEFORE creating new position object
          // This prevents bot-opened positions from being downgraded to manual during sync
          const existingPos = this.openPositions.find((p) => {
            const trackedId = p.positionId;
            if (!trackedId) return false;
            // Exact match
            if (trackedId === posId) return true;
            // Fuzzy match (handle format variations - positionId might be short or full address)
            if (
              trackedId.slice(0, 8) === posId.slice(0, 8) ||
              trackedId.startsWith(posId) ||
              posId.startsWith(trackedId)
            ) {
              return true;
            }
            return false;
          });

          const isExistingAutomated =
            existingPos &&
            (existingPos.trade_type === "automated" || existingPos.trade_type === "auto");
          const isExistingManual =
            existingPos && (existingPos.trade_type === "manual" || existingPos.mode === "manual");

          // CRITICAL FIX: Check if on-chain position reports trade_type (from DriftClient tracking)
          // This handles positions opened via maker→taker fallback where the position was tracked
          // in DriftClient's internal positions map
          const onChainTradeType = onChainPos.trade_type;
          const onChainClientOrderId = onChainPos.clientOrderId;
          const isDriftTrackedAutomated =
            onChainTradeType === "automated" ||
            (onChainClientOrderId &&
              (/^drift-maker-/.test(onChainClientOrderId) ||
                /^drift-taker-/.test(onChainClientOrderId) ||
                /^[a-f0-9]{48}$/i.test(onChainClientOrderId)));

          if (isDriftTrackedAutomated) {
            console.log(
              `[SYNC] Position ${posId.slice(0, 8)}... has DriftClient tracking (clientOrderId: ${onChainClientOrderId?.slice(0, 12)}...)`
            );
          }

          // Config: default treatment for on-chain positions that are not in DB (unknown origin).
          // SAFETY DEFAULT: manual (bot will not auto-close).
          // BUT: If existing position is automated OR DriftClient tracked it as automated, use that instead (never downgrade)
          const unknownTradeTypeRaw = String(
            process.env.RECOVERY_UNKNOWN_TRADE_TYPE || "manual"
          ).toLowerCase();
          const unknownTradeType =
            unknownTradeTypeRaw === "automated" ||
            unknownTradeTypeRaw === "auto" ||
            unknownTradeTypeRaw === "bot"
              ? "automated"
              : "manual";

          const sizeUsd = Number(onChainPos.sizeUsd || onChainPos.size || 0);
          const collateralUsd = Number(onChainPos.collateralUsd || onChainPos.collateral || 0);
          let leverage = Number(onChainPos.leverage || 0);

          // Calculate leverage if missing
          if (!leverage || leverage <= 0) {
            leverage = sizeUsd > 0 && collateralUsd > 0 ? sizeUsd / collateralUsd : 1;
          }
          if (!leverage || leverage <= 0) {
            leverage = 1;
          }

          const entryPrice = Number(onChainPos.entryPrice || onChainPos.price || 0);

          // CRITICAL FIX: Extract baseSize from on-chain position
          const baseSize = Number(onChainPos.baseSize || onChainPos.sizeBase || 0);

          // CRITICAL: If existing position is automated OR DriftClient tracked it, preserve that status (never downgrade)
          // Use existing position's clientOrderId if available (bot-opened positions have 48-char hex hash)
          // Also use clientOrderId from on-chain position if DriftClient tracked it (maker→taker fallback)
          const position = {
            positionId: posId,
            // Preserve clientOrderId from: existing position > on-chain position (DriftClient tracking)
            clientOrderId: existingPos?.clientOrderId || onChainClientOrderId || null,
            market: positionMarket,
            marketIndex: onChainPos.marketIndex, // CRITICAL: For Drift closePosition
            side: side,
            entryPrice: entryPrice,
            collateral: collateralUsd,
            leverage: leverage,
            size: sizeUsd,
            sizeUsd: sizeUsd, // Alias for compatibility
            baseSize: baseSize, // CRITICAL: Required by closePosition()
            sizeBase: baseSize, // Alias for compatibility
            openTime: onChainPos.updateTime || Date.now(),
            liquidationPrice: this._calculateLiquidationPrice(entryPrice, leverage, side),
            strategyType: this.strategyFactory.getStrategyType(positionMarket),
            // CRITICAL: If existing position is automated OR DriftClient tracked it, preserve that (never downgrade to manual)
            // Order of precedence: existing automated > DriftClient tracked > unknownTradeType (default to manual)
            trade_type: isExistingAutomated
              ? "automated"
              : isDriftTrackedAutomated
                ? "automated"
                : unknownTradeType,
            venue: onChainPos.venue || "drift", // Preserve venue for routing
          };

          // If existing position is automated, preserve that (don't downgrade to manual)
          if (isExistingAutomated) {
            position.trade_type = "automated";
            console.log(
              `✅ [SYNC] Preserved automated status for existing position ${posId.slice(0, 8)}... (found via fuzzy match)`
            );
          }

          if (this._addPositionSafely(position)) {
            // Mark as recovered to skip time-based exits (openTime may be inaccurate)
            this._recoveredPositionIds.add(posId);

            // CRITICAL FIX: If existing position was automated, preserve that (don't downgrade)
            // Only preserve manual if it was truly manual (not just missing trade_type)
            if (isExistingAutomated) {
              const updatedPos = this.openPositions.find((p) => p.positionId === posId);
              if (updatedPos) {
                updatedPos.trade_type = "automated";
                if (updatedPos.mode === "manual") delete updatedPos.mode;
                console.log(
                  `✅ [SYNC] Preserved automated status for position ${posId.slice(0, 8)}... during sync`
                );
              }
            } else if (isExistingManual) {
              const updatedPos = this.openPositions.find((p) => p.positionId === posId);
              if (updatedPos) {
                updatedPos.trade_type = "manual";
                updatedPos.mode = "manual";
                console.log(
                  `🛡️  Preserved manual status for position ${posId.slice(0, 8)}... during sync`
                );
              }
            }

            // CRITICAL FIX: Check clientOrderId pattern FIRST (before DB lookup)
            // Bot-opened positions have 48-char hex hash clientOrderId
            const hasBotClientOrderId =
              position.clientOrderId && /^[a-f0-9]{48}$/i.test(position.clientOrderId);

            // Log to database if not already there
            // Check if position was opened by bot (exists in DB with non-manual trade_type)
            try {
              const dbPositions = db.listOpen();
              // Primary lookup by positionId, fallback by market+side (handles Drift ID format changes)
              let existingDbPos = dbPositions.find((p) => p.id === posId);
              if (!existingDbPos && positionMarket) {
                existingDbPos = dbPositions.find(
                  (p) =>
                    p.market === positionMarket &&
                    String(p.side).toLowerCase() === side.toLowerCase()
                );
                if (existingDbPos) {
                  console.log(
                    `🔍 [SYNC] Found DB position by market+side for new position: ${positionMarket} ${side}`
                  );
                }
              }
              // Source of truth: DB trade_type (when present). Do not require client_order_id pattern.
              // Otherwise, we can incorrectly downgrade automated positions into manual when client_order_id
              // uses legacy/custom formats (e.g., timestamp_*).
              const dbTradeType = String(existingDbPos?.trade_type || "").toLowerCase();
              const wasOpenedByBot =
                !!existingDbPos &&
                (dbTradeType === "automated" || dbTradeType === "auto" || dbTradeType === "bot");

              // CRITICAL: Never downgrade from automated to manual during sync
              // If position was already marked automated (in-memory, DB, or DriftClient tracked), preserve that status
              // Only upgrade from manual to automated, never downgrade
              if (
                hasBotClientOrderId ||
                isExistingAutomated ||
                wasOpenedByBot ||
                isDriftTrackedAutomated
              ) {
                position.trade_type = "automated";
                if (position.mode === "manual") delete position.mode;
                position.clientOrderId =
                  existingDbPos?.client_order_id || onChainClientOrderId || position.clientOrderId;
                const reason = hasBotClientOrderId
                  ? "bot clientOrderId"
                  : wasOpenedByBot
                    ? "DB confirmed"
                    : isDriftTrackedAutomated
                      ? "DriftClient tracked"
                      : "existing automated";
                console.log(
                  `✅ [SYNC] Marked position ${posId.slice(0, 8)}... as AUTOMATED (${reason})`
                );

                // Update DB if it has wrong trade_type (upgrade manual to automated, but never downgrade)
                if (
                  existingDbPos &&
                  dbTradeType !== "automated" &&
                  dbTradeType !== "auto" &&
                  dbTradeType !== "bot"
                ) {
                  try {
                    db.updateOpen(posId, { trade_type: "automated" });
                    console.log(
                      `🔧 [SYNC] Fixed DB trade_type for position ${posId.slice(0, 8)}... (was ${dbTradeType}, now automated)`
                    );
                  } catch (e) {
                    console.warn(`⚠️  Failed to update DB trade_type: ${e.message}`);
                  }
                }
              } else if (!existingDbPos) {
                // New position discovered on-chain but NOT in DB:
                // treat as manual/external (safest; prevents bot from auto-closing unknown positions)
                // This includes positions opened through Jupiter perps UI
                const tradeType = unknownTradeType;
                db.logOpen({
                  positionId: posId,
                  // Do not invent a clientOrderId for unknown/manual positions
                  clientOrderId: null,
                  market: positionMarket,
                  side: side,
                  entryPrice: entryPrice,
                  collateral: collateralUsd,
                  leverage: leverage,
                  size: sizeUsd,
                  openTime: position.openTime,
                  mode: this.liveMode ? "live" : "paper",
                  trade_type: tradeType,
                  environment: this.environment || "live",
                  instance_id: this.instanceId || null,
                });
                // Ensure position object is marked as manual
                position.trade_type = tradeType;
                if (tradeType === "manual") {
                  position.mode = "manual";
                  console.log(
                    `📝 [SYNC] Marked position ${posId.slice(0, 8)}... as MANUAL (opened outside bot, e.g., Jupiter perps UI)`
                  );
                }
              } else {
                // Position exists in DB but was marked as manual
                // CRITICAL: Only set to manual if existing position wasn't already automated
                // This prevents downgrading bot-opened positions that were temporarily missing from DB
                if (isExistingAutomated) {
                  // Existing position is automated - preserve that (DB might be stale)
                  position.trade_type = "automated";
                  if (position.mode === "manual") delete position.mode;
                  console.log(
                    `⚠️  [SYNC] Preserved automated status for position ${posId.slice(0, 8)}... despite DB saying manual (DB may be stale)`
                  );
                } else {
                  // Existing position is manual or unknown - set to manual
                  position.trade_type = "manual";
                  position.mode = "manual";
                  console.log(
                    `📝 [SYNC] Marked position ${posId.slice(0, 8)}... as MANUAL (from DB, no existing automated status)`
                  );
                }
              }
            } catch (dbError) {
              console.warn(`⚠️  Failed to log synced position to database: ${dbError.message}`);
            }

            newPositionsAdded++;
            console.log(
              `✅ Synced new position from on-chain: ${posId.slice(0, 8)}... (${positionMarket}, ${side}, $${collateralUsd.toFixed(2)})`
            );
          }
        } catch (e) {
          console.error(
            `❌ Failed to sync position ${posId?.slice(0, 8) || "unknown"}...:`,
            e.message
          );
        }
      }

      // Check for positions that are closed on-chain but still in openPositions
      // CRITICAL: Use fuzzy matching to handle ID format differences (short vs full address)
      let closedPositionsRemoved = 0;
      for (const trackedPos of [...this.openPositions]) {
        const trackedId = trackedPos.positionId;
        if (!trackedId) continue;

        // Try exact match first
        let foundOnChain = onChainPosMap.has(trackedId);

        // If not found, try fuzzy matching (check if any on-chain position ID starts with tracked ID or vice versa)
        if (!foundOnChain) {
          for (const [onChainId, onChainPos] of onChainPosMap.entries()) {
            // Check if IDs match (handles both short and full address formats)
            if (
              onChainId === trackedId ||
              onChainId.startsWith(trackedId) ||
              trackedId.startsWith(onChainId) ||
              onChainId.slice(0, 8) === trackedId.slice(0, 8)
            ) {
              foundOnChain = true;
              // Update the tracked position ID to match the on-chain format for future syncs
              if (trackedId !== onChainId) {
                trackedPos.positionId = onChainId;
                console.log(
                  `🔄 Updated position ID format: ${trackedId.slice(0, 8)}... → ${onChainId.slice(0, 8)}...`
                );
              }
              break;
            }
          }
        }

        // If still not found, verify with direct query before removing (prevents false positives)
        if (!foundOnChain) {
          try {
            // Check if position was recently opened (within last 2 minutes) - don't remove recent positions
            const positionAge = Date.now() - (trackedPos.openTime || 0);
            const RECENT_POSITION_THRESHOLD = 2 * 60 * 1000; // 2 minutes

            if (positionAge < RECENT_POSITION_THRESHOLD) {
              console.log(
                `⏳ Position ${trackedId.slice(0, 8)}... is recent (${Math.round(positionAge / 1000)}s old), skipping removal (may be timing issue)`
              );
              continue;
            }

            // Try direct query to verify position is actually closed
            // Uses venue-aware executor which handles both Jupiter and Drift
            try {
              // Query all positions from both venues
              const verifyPositions = await this.tradeExecutor.getAllOpenPositions();
              const verifyFound = verifyPositions.some((p) => {
                const pId = p.positionId || p.id || p.address;
                return (
                  pId === trackedId ||
                  pId?.startsWith(trackedId) ||
                  trackedId?.startsWith(pId) ||
                  pId?.slice(0, 8) === trackedId.slice(0, 8)
                );
              });

              if (verifyFound) {
                console.log(
                  `✅ Position ${trackedId.slice(0, 8)}... verified on-chain, keeping in tracking`
                );
                continue;
              }
            } catch (verifyError) {
              // If verification fails, err on the side of caution - don't remove the position
              console.warn(
                `⚠️  Could not verify position ${trackedId.slice(0, 8)}... on-chain: ${verifyError.message}. Keeping in tracking to prevent false removal.`
              );
              continue;
            }

            // Position verified as closed on-chain - remove from tracking
            // Log whether this was a manual or automated position to help diagnose external closes
            const posTradeType = trackedPos.trade_type || "unknown";
            const posMarket = trackedPos.market || MARKET;
            const posSide = trackedPos.side || "unknown";
            const wasManual = posTradeType === "manual" || trackedPos.mode === "manual";

            if (wasManual) {
              console.log(
                `📝 [EXTERNAL_CLOSE] Manual position ${trackedId.slice(0, 8)}... (${posMarket} ${posSide}) closed externally (likely protocol liquidation or user action)`
              );
            } else {
              console.log(
                `📝 [EXTERNAL_CLOSE] Bot position ${trackedId.slice(0, 8)}... (${posMarket} ${posSide}) closed externally (possible protocol liquidation or race condition)`
              );
            }

            this.openPositions = this.openPositions.filter((p) => p.positionId !== trackedId);
            closedPositionsRemoved++;
          } catch (error) {
            // If verification fails, err on the side of caution - don't remove the position
            console.warn(
              `⚠️  Error verifying position ${trackedId.slice(0, 8)}...: ${error.message}. Keeping in tracking to prevent false removal.`
            );
          }
        }
      }

      // Step: Aggregate any existing positions with same market/side (Jupiter Perps aggregates on-chain)
      // This handles the case where we had multiple positions tracked but they should be aggregated
      // CRITICAL: Only aggregate positions with the same trade_type (manual vs automated)
      let positionsAggregated = 0;
      const aggregatedPositions = new Map(); // Track aggregated positions by market+side+trade_type key
      const positionsToRemove = [];

      // Helper to determine if a position is manual
      const isManual = (pos) => {
        return (
          pos.trade_type === "manual" ||
          pos.mode === "manual" ||
          (pos.clientOrderId && pos.clientOrderId.startsWith("manual-"))
        );
      };

      for (const pos of this.openPositions) {
        const market = pos.market || MARKET;
        const side = (pos.side || "LONG").toUpperCase();
        const posIsManual = isManual(pos);
        // Include trade_type in key to prevent manual/automated mixing
        const key = `${market}:${side}:${posIsManual ? "manual" : "automated"}`;

        if (!aggregatedPositions.has(key)) {
          // First position for this market+side+trade_type - keep it
          aggregatedPositions.set(key, pos);
        } else {
          // Another position with same market+side+trade_type - aggregate with existing
          const existing = aggregatedPositions.get(key);
          const aggregated = this._aggregatePositions(existing, pos);
          aggregatedPositions.set(key, aggregated);
          positionsToRemove.push(pos);
          positionsAggregated++;
          console.log(
            `🔄 Aggregated existing positions: ${pos.positionId.slice(0, 8)}... + ${existing.positionId.slice(0, 8)}... (${market}, ${side}, ${posIsManual ? "manual" : "automated"})`
          );
        }
      }

      // Remove positions that were aggregated into others
      if (positionsToRemove.length > 0) {
        this.openPositions = this.openPositions.filter((p) => !positionsToRemove.includes(p));
        // Update with aggregated versions
        for (const [key, aggregated] of aggregatedPositions.entries()) {
          const [market, side, tradeType] = key.split(":");
          const existingIndex = this.openPositions.findIndex((p) => {
            const pMarket = p.market || MARKET;
            const pSide = (p.side || "LONG").toUpperCase();
            const pIsManual = isManual(p);
            const pTradeType = pIsManual ? "manual" : "automated";
            return pMarket === market && pSide === side && pTradeType === tradeType;
          });
          if (existingIndex >= 0) {
            this.openPositions[existingIndex] = aggregated;
          }
        }
      }

      if (newPositionsAdded > 0 || closedPositionsRemoved > 0 || positionsAggregated > 0) {
        console.log(
          `🔄 Position sync complete: +${newPositionsAdded} new, -${closedPositionsRemoved} closed, ~${positionsAggregated} aggregated`
        );
      }
    } catch (e) {
      // Don't spam errors for sync failures - log but continue
      console.warn(`⚠️  Position sync failed: ${e.message}`);
      errorHandler.log(e, {
        category: Category.SYSTEM,
        severity: Severity.LOW,
        context: { action: "_syncPositionsFromChain" },
      });
    }
  }

  // ---------- Periodic Summary ----------
  _logPeriodicSummary() {
    try {
      // Use openPositions which is already filtered for open positions
      const openPositions = Array.isArray(this.openPositions) ? this.openPositions : [];
      const prices = {};
      for (const m of MARKETS) {
        const pd = this._lastPrices?.get(m);
        if (pd && pd.price !== undefined && pd.price !== null) {
          prices[m] = `$${pd.price.toFixed(2)}`;
        }
      }

      console.log("\n📊 === Periodic Summary ===");
      const uptimeHours = this._startTime ? (Date.now() - this._startTime) / 3_600_000 : 0;
      console.log(`⏱️  Tick: ${this._ticks} | Uptime: ${uptimeHours.toFixed(1)}h`);
      console.log(`💰 Prices: ${JSON.stringify(prices)}`);
      console.log(`📈 Open Positions: ${openPositions.length}`);

      if (openPositions.length > 0) {
        for (const pos of openPositions) {
          const currentPrice = this._lastPrices?.get(pos.market)?.price;
          if (currentPrice !== undefined && currentPrice !== null) {
            // Use bot's calculatePnL with current cached prices
            const pnlFull = this.calculatePnLFull(pos, currentPrice);
            if (pnlFull && pnlFull.pnlPercent !== undefined && pnlFull.pnlUsd !== undefined) {
              console.log(
                `   ${pos.market} ${pos.side}: PnL ${pnlFull.pnlPercent.toFixed(2)}% ($${pnlFull.pnlUsd.toFixed(2)})`
              );
            }
          }
        }
      }

      // Price feed health
      const health = this.priceClient.multiPriceFeed.getHealthStatus();
      const healthSummary = Object.entries(health)
        .filter(([k]) => !["cacheSize", "cacheTtlMs"].includes(k))
        .map(([_, v]) => `${v.name}: ${v.successRate}`)
        .join(", ");
      console.log(`🏥 Price Feed: ${healthSummary}`);
      console.log("========================\n");
    } catch (err) {
      console.error("Failed to log periodic summary:", err.message);
    }
  }

  _logLoopPulse(pulse) {
    if (!pulse) return;

    // Calculate uptime
    const uptimeMs = this._startTime ? Date.now() - this._startTime : 0;
    const uptimeHrs = (uptimeMs / (1000 * 60 * 60)).toFixed(1);

    // Price status
    const price = pulse.price || {};
    const priceStatus = `${(price.status || "n/a").toUpperCase()}(${price.fetched || 0}/${price.total || MARKETS.length})`;

    // Position info
    const positionsCount =
      typeof pulse.positions === "number" ? pulse.positions : this.openPositions.length;
    const maxPositions = MAX_POSITIONS || 3;
    const positionPct = maxPositions > 0 ? ((positionsCount / maxPositions) * 100).toFixed(0) : 0;

    // Capital info
    const availableCap =
      typeof pulse.availableCapital === "number"
        ? pulse.availableCapital
        : this.getAvailableCapital();
    const totalCap = this.paperBalance || this.initialPaperBalance || 1000;
    const usedCap = totalCap - availableCap;
    const capUsagePct = totalCap > 0 ? ((usedCap / totalCap) * 100).toFixed(0) : 0;

    // Feed health
    const feedStatus =
      Array.isArray(pulse.feed) && pulse.feed.length > 0 ? pulse.feed.join("/") : "unknown";

    // Signals
    const signals = pulse.signals || {};

    // Price details per market
    const priceDetails = [];
    if (price.details && Array.isArray(price.details)) {
      priceDetails.push(...price.details);
    } else {
      // Fallback: show current prices from _lastPrices
      for (const market of MARKETS) {
        const priceData = this._lastPrices.get(market);
        if (priceData) {
          const ageS = priceData.timestamp
            ? ((Date.now() - priceData.timestamp) / 1000).toFixed(1)
            : "?";
          priceDetails.push(
            `${market}: $${priceData.price?.toFixed(2) || "?"} (${priceData.source}, ${ageS}s)`
          );
        } else {
          priceDetails.push(`${market}: NO DATA`);
        }
      }
    }

    // Build comprehensive log
    const lines = [];
    lines.push("");
    lines.push(
      `🫀 ═══ Loop ${pulse.tick ?? this._ticks} ═══ Uptime: ${uptimeHrs}h ═══ ${new Date().toLocaleTimeString()} ═══`
    );
    lines.push(
      `   💰 Capital: $${Math.round(availableCap)}/${totalCap} available (${capUsagePct}% used) | Positions: ${positionsCount}/${maxPositions} (${positionPct}%)`
    );
    lines.push(`   📊 Prices: ${priceStatus} | Feed: ${feedStatus}`);

    // Show price details (one line per market or compact if many)
    if (priceDetails.length <= 3) {
      for (const detail of priceDetails) {
        lines.push(`      ${detail}`);
      }
    } else {
      lines.push(`      ${priceDetails.join(" | ")}`);
    }

    // Signals line
    const signalParts = [
      `generated=${signals.generated ?? 0}`,
      `ranked=${signals.ranked ?? 0}`,
      `selected=${signals.selected ?? 0}`,
      `executed=${signals.executed ?? 0}`,
    ];
    if (signals.blocked) signalParts.push(`blocked=${signals.blocked}`);
    lines.push(`   🎯 Signals: ${signalParts.join(" | ")}`);

    // Gate evaluation status (shows strategy health and why no signals)
    if (pulse.gates && Array.isArray(pulse.gates) && pulse.gates.length > 0) {
      lines.push(
        `   🚪 Gates (${pulse.gates.length} strategy${pulse.gates.length > 1 ? "ies" : "y"}):`
      );
      lines.push(
        `      Legend: [M]=mandatory, [O✓]=optional enabled, [O✗]=optional disabled (OFF)`
      );
      for (const gate of pulse.gates) {
        const readyIcon = gate.ready ? "✅" : "⏳";

        // Check if direction is disabled by config (ALLOW_LONGS/ALLOW_SHORTS)
        const longsDisabled = gate.longsDisabled === true;
        const shortsDisabled = gate.shortsDisabled === true;

        // Show 🚫 if disabled by config, otherwise show signal status
        const longIcon = longsDisabled
          ? "🚫"
          : gate.longOK === true
            ? "✅"
            : gate.longOK === false
              ? "❌"
              : "?";
        const shortIcon = shortsDisabled
          ? "🚫"
          : gate.shortOK === true
            ? "✅"
            : gate.shortOK === false
              ? "❌"
              : "?";
        const ind = gate.indicators || {};

        // Format all indicators
        const price = Number.isFinite(ind.price) ? ind.price.toFixed(2) : "N/A";
        const rsi = Number.isFinite(ind.rsi) ? ind.rsi.toFixed(1) : "N/A";
        const adx = Number.isFinite(ind.adx) ? ind.adx.toFixed(1) : "N/A";
        const atr = Number.isFinite(ind.atr) ? ind.atr.toFixed(2) : "N/A";
        const ma = Number.isFinite(ind.ma) ? ind.ma.toFixed(2) : "N/A";
        const donH = Number.isFinite(ind.donchianHigh) ? ind.donchianHigh.toFixed(2) : "N/A";
        const donL = Number.isFinite(ind.donchianLow) ? ind.donchianLow.toFixed(2) : "N/A";

        // Calculate price position relative to MA and Donchian
        let maPos = "";
        if (Number.isFinite(ind.price) && Number.isFinite(ind.ma)) {
          maPos = ind.price > ind.ma ? "↑" : "↓";
        }

        let donPos = "";
        if (
          Number.isFinite(ind.price) &&
          Number.isFinite(ind.donchianHigh) &&
          Number.isFinite(ind.donchianLow)
        ) {
          if (ind.price > ind.donchianHigh) donPos = "⬆️";
          else if (ind.price < ind.donchianLow) donPos = "⬇️";
          else donPos = "↔️";
        }

        // Show bar aggregation progress
        let barInfo = "";
        if (gate.barAggregation) {
          const ticks = gate.barAggregation.ticksInBar;
          const progress = gate.barAggregation.barProgress;
          barInfo = ` [${ticks}t/${progress}%]`;
        }

        // Show reason if holding
        let reasonStr = "";
        if (gate.action === "hold" && gate.reason) {
          const reasonMap = {
            no_edge_signal: "no edge",
            already_in_position: "in pos",
            same_side_reentry_cooldown: "cooldown",
            same_side_reentry_blocked: "reentry block",
            flip_cooldown_active: "flip cooldown",
            short_hour_throttle: "throttle",
            already_opened_this_bar: "same bar",
          };
          reasonStr = ` (${reasonMap[gate.reason] || gate.reason})`;
        }

        // Line 1: Market, strategy type, gates, and reason
        const strategyTypeLabel = gate.strategyType ? `[${gate.strategyType}]` : "";
        lines.push(
          `      ${gate.market} ${strategyTypeLabel}: ${readyIcon} | L:${longIcon} S:${shortIcon}${barInfo}${reasonStr}`
        );

        // Strategy-specific indicator display
        if (gate.strategyType === "rsi-reversion" || gate.strategyType === "rsi-reversion-alt") {
          // RSI-Reversion specific display
          const rsiCfg = ind.rsiConfig || {};
          const rsiState = ind.rsiState || {};

          // Line 2: RSI with thresholds
          const rsiZone = Number.isFinite(ind.rsi)
            ? ind.rsi <= rsiCfg.oversoldExtreme
              ? "🟢OVERSOLD"
              : ind.rsi >= rsiCfg.overboughtExtreme
                ? "🔴OVERBOUGHT"
                : ind.rsi <= rsiCfg.oversoldRecovery
                  ? "↗️recovering"
                  : ind.rsi >= rsiCfg.overboughtRecovery
                    ? "↘️recovering"
                    : "⚪neutral"
            : "N/A";
          const adx2 = Number.isFinite(ind.adx) ? ind.adx.toFixed(1) : "N/A";
          lines.push(`         RSI:${rsi} [${rsiZone}] ADX:${adx2} ATR:${atr}`);

          // Line 3: RSI thresholds config
          lines.push(
            `         Thresholds: OversoldX:${rsiCfg.oversoldExtreme ?? 20} OversoldR:${rsiCfg.oversoldRecovery ?? 25} | OverboughtX:${rsiCfg.overboughtExtreme ?? 80} OverboughtR:${rsiCfg.overboughtRecovery ?? 75}`
          );

          // Line 4: Volatility filter status
          const vol = ind.volatility || {};
          const volPctStr = Number.isFinite(vol.atrPct) ? vol.atrPct.toFixed(3) : "?";
          const volStatus =
            vol.ok === false
              ? `❌ ATR%=${volPctStr} (need ${vol.minPct}-${vol.maxPct}%)`
              : `✅ ATR%=${volPctStr}`;
          lines.push(`         Volatility: ${volStatus}`);

          // Line 4b: ADX filter status
          const minAdx = rsiCfg.minAdx ?? 0;
          const maxAdx = rsiCfg.maxAdx ?? 100;
          const adxVal = Number.isFinite(ind.adx) ? ind.adx : null;
          const adxOk =
            adxVal === null ? "✅ (N/A)" : adxVal >= minAdx && adxVal <= maxAdx ? "✅" : "❌";
          const adxRange = `${minAdx}-${maxAdx}${maxAdx >= 100 ? " (disabled)" : ""}`;
          lines.push(
            `         ADX Filter: ${adxOk} ADX=${adxVal === null ? "N/A" : adxVal.toFixed(1)} (need ${adxRange})`
          );

          // Line 5: RSI extreme tracking state
          // Use != null (loose equality) to catch both null and undefined
          // Only show as valid (✅) if within entry max bars limit
          const maxBars = rsiCfg.entryMaxBars ?? 2;
          const barsSinceOversold = Number.isFinite(ind.barsSinceOversold)
            ? ind.barsSinceOversold
            : null;
          const barsSinceOverbought = Number.isFinite(ind.barsSinceOverbought)
            ? ind.barsSinceOverbought
            : null;

          let oversoldTrack;
          if (!rsiState.oversoldConsumed && rsiState.lastOversoldBar != null) {
            const rsiStr = Number.isFinite(rsiState.lastOversoldRsi)
              ? rsiState.lastOversoldRsi.toFixed(1)
              : "?";
            if (barsSinceOversold !== null && barsSinceOversold <= maxBars) {
              oversoldTrack = `✅ bar=${rsiState.lastOversoldBar} RSI=${rsiStr} (${barsSinceOversold} bars ago)`;
            } else {
              // Beyond max lookback - don't show nonsensical old data
              oversoldTrack = "❌ none";
            }
          } else {
            oversoldTrack = "❌ none";
          }

          let overboughtTrack;
          if (!rsiState.overboughtConsumed && rsiState.lastOverboughtBar != null) {
            const rsiStr = Number.isFinite(rsiState.lastOverboughtRsi)
              ? rsiState.lastOverboughtRsi.toFixed(1)
              : "?";
            if (barsSinceOverbought !== null && barsSinceOverbought <= maxBars) {
              overboughtTrack = `✅ bar=${rsiState.lastOverboughtBar} RSI=${rsiStr} (${barsSinceOverbought} bars ago)`;
            } else {
              // Beyond max lookback - don't show nonsensical old data
              overboughtTrack = "❌ none";
            }
          } else {
            overboughtTrack = "❌ none";
          }
          lines.push(
            `         LongSetup(oversold): ${oversoldTrack}${vol.ok === false ? " [⚠️ Vol blocked]" : ""}`
          );
          lines.push(
            `         ShortSetup(overbought): ${overboughtTrack}${vol.ok === false ? " [⚠️ Vol blocked]" : ""}`
          );
        } else if (gate.strategyType === "ichimoku-cloud") {
          const fmt = (n, d = 2) => (Number.isFinite(n) ? Number(n).toFixed(d) : "N/A");
          const cloud =
            ind.cloudBullish === true ? "BULL" : ind.cloudBullish === false ? "BEAR" : "N/A";
          const tk = fmt(ind.tenkan, 2);
          const kj = fmt(ind.kijun, 2);
          const sa = fmt(ind.senkouA, 2);
          const sb = fmt(ind.senkouB, 2);
          const ch = fmt(ind.chikouLag, 2);
          const oscRsi = Number.isFinite(ind.oscRsi) ? ind.oscRsi.toFixed(1) : "N/A";
          const macdHist = Number.isFinite(ind.oscMacdHist) ? ind.oscMacdHist.toFixed(4) : "N/A";
          const htf = ind.htf || {};
          const htfParts = [];
          if (Number.isFinite(htf.adx)) htfParts.push(`ADX:${Number(htf.adx).toFixed(1)}`);
          if (Number.isFinite(htf.chop)) htfParts.push(`CHOP:${Number(htf.chop).toFixed(1)}`);
          if (typeof htf.bias === "string" && htf.bias) htfParts.push(`Bias:${htf.bias}`);
          const htfStr = htfParts.length ? ` | HTF ${htfParts.join(" ")}` : "";
          lines.push(`         Ichi:${cloud} TK:${tk} KJ:${kj} SA:${sa} SB:${sb} Ch:${ch}`);
          lines.push(`         ADX:${adx} ATR:${atr} OscRSI:${oscRsi} MACDh:${macdHist}${htfStr}`);
        } else if (gate.strategyType === "btc-breakout") {
          const ema = Number.isFinite(ind.trendEma) ? Number(ind.trendEma).toFixed(2) : "N/A";
          const slope =
            Number.isFinite(ind.trendSlope) ? Number(ind.trendSlope).toFixed(4) : "N/A";
          const regime = ind.regimeBias || "N/A";
          const volRatio =
            Number.isFinite(ind.volumeRatio) ? Number(ind.volumeRatio).toFixed(2) : "N/A";
          const distAtr =
            Number.isFinite(ind.entryDistanceAtr) ? Number(ind.entryDistanceAtr).toFixed(2) : "N/A";
          const breakout =
            ind.priceBreakout === "long"
              ? "LONG"
              : ind.priceBreakout === "short"
                ? "SHORT"
                : "NONE";
          lines.push(
            `         Breakout:${breakout} Regime:${regime} EMA:${ema} Slope:${slope}`
          );
          lines.push(
            `         Entry:[${Number.isFinite(ind.entryChannelLow) ? Number(ind.entryChannelLow).toFixed(2) : "N/A"}-${Number.isFinite(ind.entryChannelHigh) ? Number(ind.entryChannelHigh).toFixed(2) : "N/A"}] Exit:[${Number.isFinite(ind.exitChannelLow) ? Number(ind.exitChannelLow).toFixed(2) : "N/A"}-${Number.isFinite(ind.exitChannelHigh) ? Number(ind.exitChannelHigh).toFixed(2) : "N/A"}] ATR:${atr}`
          );
          lines.push(
            `         Vol:${volRatio}x Spike:${ind.volumeSpike === true ? "Y" : "N"} DistATR:${distAtr}`
          );
        } else {
          // Momentum/other strategy display (original)
          // Line 2: Price and MA
          lines.push(`         P:${price}${maPos} MA:${ma} | Don:[${donL}-${donH}]${donPos}`);

          // Line 3: Indicators
          lines.push(`         RSI:${rsi} ADX:${adx} ATR:${atr}`);
        }

        // Line 4/5: Detailed gate breakdown
        if (gate.gateStatus) {
          const gs = gate.gateStatus;
          const gc = gate.gateConfig || {};
          const formatGate = ({ label, value, invert = false, enabled = true }) => {
            if (!enabled) return `${label}:OFF`;
            if (value === undefined || value === null) return `${label}:?`;
            const pass = invert ? !value : Boolean(value);
            return `${label}:${pass ? "✅" : "❌"}`;
          };
          const buildRow = (title, entries) => {
            const formatted = entries.map(formatGate).filter(Boolean);
            if (formatted.length > 0) {
              lines.push(`         ${title}: ${formatted.join(" ")}`);
            }
          };

          const longMandatoryEntries = [
            { label: "MA↑", value: gs.aboveMA, enabled: true },
            { label: "Slope↑", value: gs.maSlopeUp, enabled: gc.requireMaSlopeLong !== false },
            { label: "Trend", value: gs.trendOK, enabled: true },
            { label: "RSI", value: gs.rsiLongOK, enabled: true },
            { label: "ADX", value: gs.adxLongOK, enabled: true },
            { label: "Band", value: gs.bandLongOK, enabled: true },
            { label: "Cooldown", value: gs.cooldownLongOK, enabled: true },
            { label: "Flip", value: gs.flipLongOK, enabled: true },
            { label: "DI+", value: gs.diLongOK, enabled: true },
          ];
          buildRow("LONG[M]", longMandatoryEntries);

          const longOptionalEntries = [
            { label: "Don", value: gs.donUpOK, enabled: gc.enableDonchianGate === true },
            { label: "Vol", value: gs.regimeLongOK, enabled: gc.useVolRegime === true },
            {
              label: "HTF",
              value: gs.longHTFOK,
              enabled: gc.enableHTFTrend === true && gc.longStrictHTF === true,
            },
            { label: "VolSpike", value: gs.volumeOK, enabled: gc.requireVolumeSpike === true },
            { label: "Retest", value: gs.retestOKlong, enabled: gc.requireRetest === true },
            { label: "ADXSlope", value: gs.adxSlopeOK, enabled: gc.requireAdxSlopeUp === true },
            {
              label: "EntryDist",
              value: gs.entryDistLongOK,
              enabled: gc.entryDistEnabled === true,
            },
            { label: "Time", value: gs.timeGateOK, enabled: gc.enableTimeGate === true },
          ];
          const longOptionalEnabled = longOptionalEntries.filter((entry) => entry.enabled);
          const longOptionalDisabled = longOptionalEntries.filter(
            (entry) => entry.enabled === false
          );
          buildRow("LONG[O✓]", longOptionalEnabled);
          buildRow("LONG[O✗]", longOptionalDisabled);

          const shortMandatoryEntries = [
            { label: "MA↓", value: gs.belowMA, enabled: true },
            { label: "Slope↓", value: gs.maSlopeDn, enabled: gc.requireMaSlopeShort !== false },
            { label: "Trend", value: gs.trendOK, enabled: true },
            { label: "RSI", value: gs.rsiShortOK, enabled: true },
            { label: "ADX", value: gs.adxShortOK, enabled: true },
            { label: "Band", value: gs.bandShortOK, enabled: true },
            { label: "Cooldown", value: gs.cooldownShortOK, enabled: true },
            { label: "Flip", value: gs.flipShortOK, enabled: true },
            { label: "DI-", value: gs.diShortOK, enabled: true },
          ];
          buildRow("SHORT[M]", shortMandatoryEntries);

          const shortOptionalEntries = [
            { label: "Don", value: gs.donDnOK, enabled: gc.enableDonchianGate === true },
            { label: "Vol", value: gs.regimeShortOK, enabled: gc.useVolRegime === true },
            {
              label: "HTF",
              value: gs.shortHTFOK,
              enabled: gc.enableHTFTrend === true && gc.shortStrictHTF === true,
            },
            { label: "VolSpike", value: gs.volumeOK, enabled: gc.requireVolumeSpike === true },
            { label: "Retest", value: gs.retestOKshort, enabled: gc.requireRetest === true },
            { label: "HTFSlope", value: gs.htfSlopeNegative, enabled: gc.enableHTFTrend === true },
            {
              label: "DayVeto",
              value: gs.vetoShortsGreenDay,
              invert: true,
              enabled: gc.enableGreenDayVeto === true,
            },
            { label: "ADXSlope", value: gs.adxSlopeOK, enabled: gc.requireAdxSlopeUp === true },
            {
              label: "EntryDist",
              value: gs.entryDistShortOK,
              enabled: gc.entryDistEnabled === true,
            },
            { label: "Time", value: gs.timeGateOK, enabled: gc.enableTimeGate === true },
          ];
          const shortOptionalEnabled = shortOptionalEntries.filter((entry) => entry.enabled);
          const shortOptionalDisabled = shortOptionalEntries.filter(
            (entry) => entry.enabled === false
          );
          buildRow("SHORT[O✓]", shortOptionalEnabled);
          buildRow("SHORT[O✗]", shortOptionalDisabled);
        }
      }
    }

    // Performance line
    const durMs = typeof pulse.durationMs === "number" ? Math.round(pulse.durationMs) : "?";
    const perfParts = [`duration=${durMs}ms`];
    if (price.missing && Array.isArray(price.missing) && price.missing.length > 0) {
      perfParts.push(`missing=${price.missing.join(",")}`);
    }
    lines.push(`   ⚡ Performance: ${perfParts.join(" | ")}`);

    // Notes/errors line (only if present)
    const issues = [];
    if (Array.isArray(pulse.notes) && pulse.notes.length > 0) {
      issues.push(
        `notes: ${pulse.notes.slice(0, 3).join(", ")}${pulse.notes.length > 3 ? "..." : ""}`
      );
    }
    if (Array.isArray(pulse.errors) && pulse.errors.length > 0) {
      issues.push(
        `errors: ${pulse.errors.slice(0, 2).join(", ")}${pulse.errors.length > 2 ? "..." : ""}`
      );
    }
    if (issues.length > 0) {
      lines.push(`   ⚠️  Issues: ${issues.join(" | ")}`);
    }

    lines.push("");

    // Log all lines
    for (const line of lines) {
      console.log(line);
    }

    if (ui && typeof ui.send === "function") {
      // Send a simplified single-line version to UI/Telegram to avoid parsing issues
      const simpleMsg = `Loop ${pulse.tick ?? this._ticks} | ${priceStatus} | ${feedStatus} | pos=${positionsCount}/${maxPositions} | cap=$${Math.round(availableCap)}/${totalCap} | ${durMs}ms`;
      ui.send("activity", {
        level: pulse.errors && pulse.errors.length > 0 ? "warning" : "info",
        message: simpleMsg,
        data: pulse,
      });
    }
  }

  /**
   * Compact logging (up to 3 lines per market)
   * Groups majors first, then alts
   * Shows: venue, price, signal gates, position, RSI/ADX/ATR, and RSI entry thresholds (extreme→recovery)
   */
  _logCompactLoopPulse(pulse) {
    if (!pulse) return;

    const venueRouter = require("./utils/venue-router");
    const driftLookup = require("./utils/drift-market-lookup");

    // Calculate uptime
    const uptimeMs = this._startTime ? Date.now() - this._startTime : 0;
    const uptimeHrs = (uptimeMs / (1000 * 60 * 60)).toFixed(1);
    const durMs = typeof pulse.durationMs === "number" ? Math.round(pulse.durationMs) : "?";

    // Capital pools - use venue-specific helper for consistency
    const jupPool = this._getCapitalPoolAllocation("jupiter");
    const driftPool = this._getCapitalPoolAllocation("drift");
    const jupUsed = this._getPoolUsed("jupiter");
    const driftUsed = this._getPoolUsed("drift");

    // Position counts per pool
    const jupPositions = this.openPositions.filter(
      (p) => venueRouter.getVenueForMarket(p.market) === "jupiter"
    ).length;
    const driftPositions = this.openPositions.filter(
      (p) => venueRouter.getVenueForMarket(p.market) === "drift"
    ).length;

    // Build gate lookup map for quick access
    const gateMap = new Map();
    if (pulse.gates && Array.isArray(pulse.gates)) {
      for (const gate of pulse.gates) {
        const key = `${gate.market}:${gate.strategyType || "unknown"}`;
        gateMap.set(key, gate);
      }
    }

    // Separate majors and alts
    const majors = MARKETS.filter((m) => venueRouter.isMajor(m));
    const alts = MARKETS.filter((m) => !venueRouter.isMajor(m));

    // Build output lines
    const lines = [];
    lines.push("");
    lines.push(
      `═══ Loop ${pulse.tick ?? this._ticks} ═══ ${new Date().toLocaleTimeString()} ═══ ${uptimeHrs}h ═══ ${durMs}ms ═══`
    );

    // Capital summary line
    // CRITICAL FIX: For compounding mode, show total pool including realized PnL in denominator
    // This fixes the issue where denominator was always showing the initial allocation ($700)
    // instead of reflecting growth from profitable trades
    const enableCompounding = this.config?.risk?.enableCompounding === true;

    // Calculate actual total pool (initial allocation + realized PnL if compounding)
    let jupTotalPool = jupPool;
    let driftTotalPool = driftPool;

    if (enableCompounding) {
      if (typeof this._jupiterRealizedPnL === "number") {
        jupTotalPool += this._jupiterRealizedPnL;
      }
      if (typeof this._driftRealizedPnL === "number") {
        driftTotalPool += this._driftRealizedPnL;
      }
    }

    const jupAvail = Math.max(0, jupTotalPool - jupUsed);
    const driftAvail = Math.max(0, driftTotalPool - driftUsed);

    // Debug capital calculation if enabled
    if (process.env.DEBUG_CAPITAL === "true") {
      console.log(
        `[CAPITAL_DEBUG] Jupiter: initialPool=$${jupPool}, realizedPnL=$${this._jupiterRealizedPnL || 0}, totalPool=$${jupTotalPool.toFixed(2)}, used=$${jupUsed.toFixed(2)}, avail=$${jupAvail.toFixed(2)}`
      );
      console.log(
        `[CAPITAL_DEBUG] Drift: initialPool=$${driftPool}, realizedPnL=$${this._driftRealizedPnL || 0}, totalPool=$${driftTotalPool.toFixed(2)}, used=$${driftUsed.toFixed(2)}, avail=$${driftAvail.toFixed(2)}`
      );
    }

    // Show actual total pool (with compounded PnL) in denominator
    lines.push(
      `💰 Jupiter: $${Math.round(jupAvail)}/$${Math.round(jupTotalPool)} (${jupPositions} pos) │ Drift: $${Math.round(driftAvail)}/$${Math.round(driftTotalPool)} (${driftPositions} pos)`
    );

    // Volume health pulse (compact; bar-based strategies consume volume on bar close, but we track deltas per tick).
    // This is a "trust but verify" line: confirms WS health + whether we're falling back to stale cache/Binance.
    // Default: print only when at least one market completed a bar (i.e., when indicators update).
    // Optional override: VOLUME_PULSE_EVERY_LOOPS=N prints on loop cadence for debugging.
    const envEveryLoops = Number(process.env.VOLUME_PULSE_EVERY_LOOPS);
    const tickNo = Number(pulse.tick ?? this._ticks) || 0;
    const shouldPrintVolumePulse = Number.isFinite(envEveryLoops)
      ? tickNo % Math.max(1, envEveryLoops) === 0
      : (pulse.barsCompleted?.length || 0) > 0;
    if (shouldPrintVolumePulse) {
      const vs = marketDataProvider?.getStats ? marketDataProvider.getStats() : null;
      const pref = String(vs?.volumeSource || process.env.VOLUME_SOURCE || "auto");
      const cbOk = vs?.coinbase?.healthy === true ? "✅" : vs?.coinbase?.initialized ? "⚠️" : "❌";
      const vstats = vs?.volumeStats || {};

      // Show last volume meta source for majors (where Ichimoku runs)
      const majorsForPulse = MARKETS.filter((m) => venueRouter.isMajor(m));
      const countsBySource = new Map();
      for (const m of majorsForPulse) {
        const pd = this._lastPrices?.get(m);
        const src = String(pd?.volumeMeta?.source || "none");
        countsBySource.set(src, (countsBySource.get(src) || 0) + 1);
      }
      const srcSummary = [...countsBySource.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}=${n}`)
        .join(" ");

      lines.push(
        `📊 Volume: pref=${pref} cb=${cbOk} hits=${vstats.coinbaseHits || 0} miss=${vstats.coinbaseMisses || 0} ` +
          `bin=${vstats.binanceHits || 0} bnBad=${vstats.binanceErrors || 0} fb=${vstats.fallbackCount || 0} | majors ${srcSummary}`
      );
    }

    // Helper to format a single market row (up to 3 lines)
    // NOTE: Price formatting is for DISPLAY ONLY - all computations use raw priceData.price
    const { formatPriceCompact, formatPriceForDisplay } = require("./utils/price-formatter");
    const formatMarketRow = (market, venue) => {
      const priceData = this._lastPrices?.get(market);
      // Smart price formatting adapts decimals based on price magnitude (display only)
      const price = priceData?.price
        ? formatPriceCompact(priceData.price, 10)
        : "$---".padStart(10);
      const source = priceData?.source?.substring(0, 3) || "---";

      // Find gate data for this market
      const strategyType =
        this.strategyFactory && typeof this.strategyFactory.getStrategyType === "function"
          ? this.strategyFactory.getStrategyType(market)
          : venue === "jupiter"
            ? "rsi-reversion"
            : "rsi-reversion-alt";
      const gateKey = `${market}:${strategyType}`;
      const gate =
        gateMap.get(gateKey) || Array.from(gateMap.values()).find((g) => g.market === market);

      // Indicators
      const ind = gate?.indicators || {};
      const rsi = Number.isFinite(ind.rsi) ? ind.rsi.toFixed(0) : "--";
      const adx = Number.isFinite(ind.adx) ? ind.adx.toFixed(0) : "--";
      const atrPct = (() => {
        const p = priceData?.price;
        if (!Number.isFinite(ind.atr) || !Number.isFinite(p) || p <= 0) return "--";
        return `${((ind.atr / p) * 100).toFixed(2)}%`;
      })();

      // RSI zone indicator
      const rsiCfg = ind.rsiConfig || {
        oversoldExtreme: 20,
        oversoldRecovery: 25,
        overboughtExtreme: 80,
        overboughtRecovery: 75,
        entryMaxBars: 5,
        entryMaxDeviation: 10,
      };
      let rsiIcon = "⚪";
      let rsiZoneTag = "";
      if (Number.isFinite(ind.rsi)) {
        if (ind.rsi <= (rsiCfg.oversoldExtreme ?? 20)) {
          rsiIcon = "🟢";
          rsiZoneTag = "OS";
        } else if (ind.rsi >= (rsiCfg.overboughtExtreme ?? 80)) {
          rsiIcon = "🔴";
          rsiZoneTag = "OB";
        } else if (ind.rsi <= (rsiCfg.oversoldRecovery ?? 25)) {
          // Between oversold extreme and recovery = "recovering up"
          rsiIcon = "↗️";
          rsiZoneTag = "rec↑";
        } else if (ind.rsi >= (rsiCfg.overboughtRecovery ?? 75)) {
          // Between overbought recovery and extreme = "recovering down"
          rsiIcon = "↘️";
          rsiZoneTag = "rec↓";
        } else {
          rsiZoneTag = "mid";
        }
      }

      // Signal status
      const longIcon = gate?.longsDisabled ? "🚫" : gate?.longOK ? "✅" : "❌";
      const shortIcon = gate?.shortsDisabled ? "🚫" : gate?.shortOK ? "✅" : "❌";

      // Position in this market
      const pos = this.openPositions.find((p) => p.market === market);
      let posStr = "---";
      let posDetails = ""; // Extended position details for second line
      let pnlUsd = null;
      let pnlPctVal = null;
      if (pos) {
        const currentPrice = priceData?.price || pos.entryPrice;
        // Use bot's calculatePnL with current cached prices
        // calculatePnL returns a number (leverage-adjusted %)
        pnlPctVal = this.calculatePnL(pos, currentPrice) || 0;
        const pnlPct = pnlPctVal.toFixed(1);
        const pnlSign = pnlPctVal >= 0 ? "+" : "";
        // Calculate PnL in USD
        pnlUsd = pos.collateral ? (pos.collateral * pnlPctVal) / 100 : null;
        const pnlUsdStr = pnlUsd !== null ? `${pnlSign}$${Math.abs(pnlUsd).toFixed(0)}` : "";
        // Calculate hold time
        const holdTimeMs = pos.openTime ? Date.now() - pos.openTime : 0;
        const holdTimeStr = this._formatDuration(holdTimeMs);
        // Trade type indicator (A=automated, M=manual)
        const typeIcon =
          pos.trade_type === "automated" ? "A" : pos.trade_type === "manual" ? "M" : "?";
        // Position summary: side, PnL%, PnL$
        // CRITICAL FIX: Guard against undefined pos.side
        const sideChar = pos.side ? pos.side.charAt(0).toUpperCase() : "?";
        posStr = `${sideChar} ${pnlSign}${pnlPct}% ${pnlUsdStr}`;
        // Extended details: type, collateral, leverage, size, hold time
        const collStr = pos.collateral ? `$${pos.collateral.toFixed(0)}` : "";
        const sizeStr = pos.size ? `→$${pos.size.toFixed(0)}` : "";
        // Format leverage to 1 decimal place (e.g., 27.5x not 27.573030240366514x)
        const levVal = Number(pos.leverage) || 0;
        const levStr = levVal > 0 ? `${levVal.toFixed(1)}x` : "";
        const entryStr = pos.entryPrice ? `@$${pos.entryPrice.toFixed(2)}` : "";
        posDetails = `📦${typeIcon} ${collStr}${levStr}${sizeStr} ${entryStr} ⏱️${holdTimeStr}`;
      }

      // Leverage cap for Drift
      let levCap = "";
      if (venue === "drift") {
        const maxLev = driftLookup.getMaxLeverage(market);
        levCap = maxLev ? `≤${maxLev}x` : "";
      }

      // Reason if holding
      let reason = "";
      if (gate?.action === "hold" && gate?.reason) {
        const reasonMap = {
          no_edge_signal: "no edge",
          already_in_position: "in pos",
          same_side_reentry_cooldown: "cooldown",
          short_hour_throttle: "throttle",
          already_opened_this_bar: "same bar",
          already_evaluated_bar: "tick (await bar close; 1/bar)",
          warming_up: "warming up",
          cloud_not_ready: "cloud not ready",
          trading_disabled_hour_utc: "blocked hour",
          no_signal: "no signal",
          both_sides: "both sides",
          ichimoku_breakout_long: "breakout L",
          ichimoku_breakout_short: "breakout S",
        };

        const formatIchimokuHoldReason = () => {
          const base = reasonMap[gate.reason] || gate.reason;

          const formatNoSignalDebug = (dbg) => {
            if (!dbg || typeof dbg !== "object" || dbg.kind !== "ichimoku") return "";
            const fmt0 = (n) => (Number.isFinite(n) ? Number(n).toFixed(0) : "--");
            const fmt1 = (n) => (Number.isFinite(n) ? Number(n).toFixed(1) : "--");

            const summarizeSide = (side) => {
              if (!side || typeof side !== "object") return null;
              if (side.allow === false) return "disabled";

              // Breakouts are edge-triggered: show whether we didn't break, or it's a stale break.
              if (side.edge !== true) {
                if (side.breakoutNow === true && side.prevBreakout === true) return "stale break";
                return "no breakout";
              }

              if (side.align !== true) return "TK/KJ";
              if (side.chikouBreakoutEnabled === true && side.chikouBreakoutOk !== true)
                return "ChBO";
              if (side.chikouAboveCloudEnabled === true && side.chikouAboveCloudOk !== true)
                return "ChCloud";
              if (side.vwapConfirmEnabled === true && side.vwapConfirmOk !== true) return "VWAP";
              if (side.adxEnabled === true && side.adxOk !== true)
                return `ADX ${fmt0(side.adx)}<${fmt0(side.adxMin)}`;
              if (side.distEnabled === true && side.distOk !== true)
                return `Dist ${fmt1(side.kijunDistAtr)}>${fmt1(side.maxEntryDistAtr)}`;
              if (side.requireVolumeSpike === true && side.volumeOk !== true) {
                if (
                  Number.isFinite(side.volumeRatio) &&
                  Number.isFinite(side.volumeSpikeThreshold)
                ) {
                  return `Vol ${fmt1(side.volumeRatio)}<${fmt1(side.volumeSpikeThreshold)}`;
                }
                return "Vol";
              }
              if (side.htfEnabled === true && side.htfOk !== true)
                return `HTF ${typeof side.htfBias === "string" && side.htfBias ? side.htfBias : "--"}`;

              return null;
            };

            const l = summarizeSide(dbg.long);
            const s = summarizeSide(dbg.short);
            const parts = [];
            if (l) parts.push(`L:${l}`);
            if (s) parts.push(`S:${s}`);
            return parts.length ? ` ${parts.join(" ")}` : "";
          };

          if (
            gate.reason === "trading_disabled_hour_utc" &&
            Number.isFinite(gate.disabledHourUtc)
          ) {
            return ` (${base}=${Number(gate.disabledHourUtc).toFixed(0)}UTC)`;
          }

          if (gate.reason === "already_evaluated_bar") {
            const ba = gate.barAggregation || {};
            const prog = ba.barProgress != null ? `${ba.barProgress}%` : null;
            const ticks = Number.isFinite(ba.ticksInBar) ? `${ba.ticksInBar}t` : null;
            const tail = [prog, ticks].filter(Boolean).join(" ");
            const lastEval = gate.entryDebug?.lastEval || null;
            if (lastEval && lastEval.reason) {
              const lastReason = reasonMap[lastEval.reason] || lastEval.reason;
              const lastDbg = lastEval.entryDebug || null;
              const lastTail = lastEval.reason === "no_signal" ? formatNoSignalDebug(lastDbg) : "";
              return ` (${base}${tail ? ` ${tail}` : ""}; last=${lastReason}${lastTail})`;
            }
            return ` (${base}${tail ? ` ${tail}` : ""})`;
          }

          if (gate.reason === "no_signal") {
            const dbg = gate.entryDebug || null;
            const dbgStr = formatNoSignalDebug(dbg);
            if (dbgStr) return ` (${base}${dbgStr})`;
          }

          return ` (${base})`;
        };

        reason =
          strategyType === "ichimoku-cloud"
            ? formatIchimokuHoldReason()
            : ` (${reasonMap[gate.reason] || gate.reason})`;
      }

      // Venue indicator
      const venueIcon = venue === "jupiter" ? "J" : "D";
      const venueColor = venue === "jupiter" ? "🟡" : "🔵";

      // PnL indicator icon
      const pnlIcon = pos ? (pnlPctVal >= 0 ? "🟢" : "🔴") : "";

      // Line 1: Market, venue, price, gates
      const marketPad = market.padEnd(12);
      const line1 = `${venueColor}${venueIcon} ${marketPad} ${price.padStart(10)} [${source}] │ L:${longIcon} S:${shortIcon} │ ${pnlIcon}Pos: ${posStr}`;

      // Line 2: Indicators (strategy-specific)
      let line2;
      let hasPendingExtreme = false; // RSI-reversion only
      if (strategyType === "ichimoku-cloud") {
        const fmt = (n) =>
          Number.isFinite(n) ? formatPriceForDisplay(n, { includeSign: false }) : "--";
        const tk = fmt(ind.tenkan);
        const kj = fmt(ind.kijun);
        const sa = fmt(ind.senkouA);
        const sb = fmt(ind.senkouB);
        const ch = fmt(ind.chikouLag);
        const cloud =
          ind.cloudBullish === true ? "BULL" : ind.cloudBullish === false ? "BEAR" : "--";
        const oscRsi = Number.isFinite(ind.oscRsi) ? Number(ind.oscRsi).toFixed(1) : "--";
        const macdHist = Number.isFinite(ind.oscMacdHist)
          ? Number(ind.oscMacdHist).toFixed(4)
          : "--";

        const volMult =
          Number.isFinite(ind.volumeLast) && Number.isFinite(ind.volumeAvg) && ind.volumeAvg > 0
            ? ind.volumeLast / ind.volumeAvg
            : null;
        const volStr =
          volMult === null
            ? ""
            : ` Volx:${volMult.toFixed(2)}${ind.volumeSpike === true ? "⚡" : ""}`;

        const htf = ind.htf || {};
        const hasHtf =
          (typeof htf.bias === "string" && htf.bias) ||
          Number.isFinite(htf.adx) ||
          Number.isFinite(htf.chop);
        const htfStr = hasHtf
          ? ` HTF:${typeof htf.bias === "string" && htf.bias ? htf.bias.toUpperCase() : "--"}` +
            `${Number.isFinite(htf.adx) ? `/${Number(htf.adx).toFixed(0)}` : ""}` +
            `${Number.isFinite(htf.chop) ? ` Ch:${Number(htf.chop).toFixed(0)}` : ""}`
          : "";

        line2 =
          `      Ichi:${cloud} TK:${tk} KJ:${kj} SA:${sa} SB:${sb} Ch:${ch}` +
          ` | ADX:${adx} ATR%:${atrPct} MACDh:${macdHist} RSI:${oscRsi}` +
          `${volStr}${htfStr} ${levCap}${reason}`;
      } else {
        const zoneSuffix = rsiZoneTag ? ` ${rsiZoneTag}` : "";
        line2 = `      RSI:${rsi}${rsiIcon}${zoneSuffix} ADX:${adx} ATR%:${atrPct} ${levCap}${reason}`;
      }

      // Line 2b: Position details on separate line when position exists (more readable)
      const posLine = posDetails ? `      ${posDetails}` : "";

      const isRsiReversion =
        strategyType === "rsi-reversion" || strategyType === "rsi-reversion-alt";
      let line3 = "";
      let oversoldPending = false;
      let overboughtPending = false;
      let barsSinceOversold = null;
      let barsSinceOverbought = null;
      if (isRsiReversion) {
        // Line 3: RSI entry thresholds + recovery/ready status
        const maxBars = Number.isFinite(rsiCfg.entryMaxBars) ? rsiCfg.entryMaxBars : 5;
        const dev = Number.isFinite(rsiCfg.entryMaxDeviation) ? rsiCfg.entryMaxDeviation : 10;
        const osX = Number.isFinite(rsiCfg.oversoldExtreme) ? rsiCfg.oversoldExtreme : 20;
        const osR = Number.isFinite(rsiCfg.oversoldRecovery) ? rsiCfg.oversoldRecovery : 25;
        const obX = Number.isFinite(rsiCfg.overboughtExtreme) ? rsiCfg.overboughtExtreme : 80;
        const obR = Number.isFinite(rsiCfg.overboughtRecovery) ? rsiCfg.overboughtRecovery : 75;

        const rsiState = ind.rsiState || {};
        barsSinceOversold = Number.isFinite(ind.barsSinceOversold) ? ind.barsSinceOversold : null;
        barsSinceOverbought = Number.isFinite(ind.barsSinceOverbought)
          ? ind.barsSinceOverbought
          : null;
        oversoldPending = rsiState.lastOversoldBar != null && rsiState.oversoldConsumed === false;
        overboughtPending =
          rsiState.lastOverboughtBar != null && rsiState.overboughtConsumed === false;
        hasPendingExtreme = oversoldPending || overboughtPending;

        const rsiVal = Number.isFinite(ind.rsi) ? ind.rsi : null;
        const fmtWindow = (barsSince) => (barsSince === null ? "--" : `${barsSince}/${maxBars}`);
        const tagLong = (() => {
          if (!oversoldPending) return "--";
          if (barsSinceOversold !== null && barsSinceOversold > maxBars)
            return `EXP ${fmtWindow(barsSinceOversold)}`;
          if (rsiVal === null) return `PEND ${fmtWindow(barsSinceOversold)}`;
          if (rsiVal <= osX) return `EXT ${fmtWindow(barsSinceOversold)}`;
          if (rsiVal < osR) return `REC ${fmtWindow(barsSinceOversold)}`;
          if (rsiVal <= osR + dev) return `READY ${fmtWindow(barsSinceOversold)}`;
          return `MISS ${fmtWindow(barsSinceOversold)}`;
        })();
        const tagShort = (() => {
          if (!overboughtPending) return "--";
          if (barsSinceOverbought !== null && barsSinceOverbought > maxBars)
            return `EXP ${fmtWindow(barsSinceOverbought)}`;
          if (rsiVal === null) return `PEND ${fmtWindow(barsSinceOverbought)}`;
          if (rsiVal >= obX) return `EXT ${fmtWindow(barsSinceOverbought)}`;
          if (rsiVal > obR) return `REC ${fmtWindow(barsSinceOverbought)}`;
          if (rsiVal >= obR - dev) return `READY ${fmtWindow(barsSinceOverbought)}`;
          return `MISS ${fmtWindow(barsSinceOverbought)}`;
        })();
        line3 = `      Entry: L ${osX}→${osR}(+${dev}) ${tagLong} │ S ${obX}→${obR}(+${dev}) ${tagShort}`;
      }

      // Compact by default: show line1 and line2 only
      // Expanded: add position details and entry thresholds when position or pending signal
      const out = [line1, line2];

      // Add position details line when we have a position
      if (posLine) {
        out.push(posLine);
      }

      // Expanded info only for RSI-reversion while an extreme is pending (or we have a position)
      if (isRsiReversion && (hasPendingExtreme || pos)) {
        out.push(line3);

        // When an extreme is pending, show why entry didn't happen (from strategy) + key thresholds.
        if (hasPendingExtreme) {
          const entryDebug = gate?.entryDebug || null;
          const dbgL = entryDebug?.long || null;
          const dbgS = entryDebug?.short || null;

          const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "--");
          const fmtPct = (n) => (Number.isFinite(n) ? `${Number(n).toFixed(3)}%` : "--");
          const fmtMs = (ms) =>
            Number.isFinite(ms) ? `${Math.max(0, Math.round(ms / 1000))}s` : "--";

          // Volatility gate (ATR%)
          const vol = ind.volatility || {};
          const atrPctNum = vol.atrPct;
          const volMin = Number.isFinite(vol.minPct)
            ? vol.minPct
            : Number.isFinite(rsiCfg.minVolatilityPct)
              ? rsiCfg.minVolatilityPct
              : null;
          const volMax = Number.isFinite(vol.maxPct)
            ? vol.maxPct
            : Number.isFinite(rsiCfg.maxVolatilityPct)
              ? rsiCfg.maxVolatilityPct
              : null;
          const volOk = vol.ok === false ? "❌" : "✅";

          // ADX gate
          const adxNum = Number.isFinite(ind.adx) ? ind.adx : null;
          const adxMin = Number.isFinite(rsiCfg.minAdx) ? rsiCfg.minAdx : null;
          const adxMax = Number.isFinite(rsiCfg.maxAdx) ? rsiCfg.maxAdx : null;
          const adxOk =
            adxNum === null || adxMin === null || adxMax === null
              ? "✅"
              : adxNum >= adxMin && adxNum <= adxMax
                ? "✅"
                : "❌";

          // Human-ish block reason (prefer the side(s) that are pending)
          const summarizeDbg = (dbg) => {
            if (!dbg || !dbg.reason) return "none";
            const map = {
              expired_window: "expired",
              waiting_recovery: "waiting recovery",
              late_entry_rsi_too_high: "late (too high)",
              late_entry_rsi_too_low: "late (too low)",
              crossover_required: "needs crossover",
              cooldown: "cooldown",
              volatility: "volatility",
              adx: "ADX",
              regime: "regime",
            };
            return map[dbg.reason] || dbg.reason;
          };

          const rsiState = ind.rsiState || {};
          const maxBars = Number.isFinite(rsiCfg.entryMaxBars) ? rsiCfg.entryMaxBars : 5;
          const dev = Number.isFinite(rsiCfg.entryMaxDeviation) ? rsiCfg.entryMaxDeviation : 10;
          const osR = Number.isFinite(rsiCfg.oversoldRecovery) ? rsiCfg.oversoldRecovery : 25;
          const obR = Number.isFinite(rsiCfg.overboughtRecovery) ? rsiCfg.overboughtRecovery : 75;
          const rsiVal = Number.isFinite(ind.rsi) ? ind.rsi : null;
          const fmtWindow = (barsSince) => (barsSince === null ? "--" : `${barsSince}/${maxBars}`);

          if (oversoldPending) {
            out.push(
              `      L debug: bars=${fmtWindow(barsSinceOversold)} extreme=${fmt(rsiState.lastOversoldRsi, 1)} now=${fmt(rsiVal, 1)} ` +
                `band=${osR}..${osR + dev} | block=${summarizeDbg(dbgL)}`
            );
          }
          if (overboughtPending) {
            out.push(
              `      S debug: bars=${fmtWindow(barsSinceOverbought)} extreme=${fmt(rsiState.lastOverboughtRsi, 1)} now=${fmt(rsiVal, 1)} ` +
                `band=${obR - dev}..${obR} | block=${summarizeDbg(dbgS)}`
            );
          }

          // Always show the main gate thresholds while we're in a pending setup.
          out.push(
            `      Gates: vol=${volOk} ATR%=${fmtPct(atrPctNum)} (min=${volMin ?? "--"} max=${volMax ?? "--"}) | ` +
              `ADX=${adxOk} ${fmt(adxNum, 0)} (min=${adxMin ?? "--"} max=${adxMax ?? "--"}) | ` +
              `cdL=${fmtMs(dbgL?.cooldownRemainingMs)} cdS=${fmtMs(dbgS?.cooldownRemainingMs)}`
          );
        }
      }

      return { lines: out, hasActivity: !!pos || hasPendingExtreme || gate?.action === "entry" };
    };

    // Majors section
    if (majors.length > 0) {
      lines.push("─── MAJORS (Jupiter) ───");
      for (const market of majors) {
        const { lines: marketLines } = formatMarketRow(market, "jupiter");
        lines.push(...marketLines);
      }
    }

    // Alts section
    if (alts.length > 0) {
      lines.push("─── ALTS (Drift) ───");
      for (const market of alts) {
        const { lines: marketLines } = formatMarketRow(market, "drift");
        lines.push(...marketLines);
      }
    }

    // Signals summary
    const signals = pulse.signals || {};
    if (signals.generated > 0 || signals.executed > 0) {
      lines.push(
        `🎯 Signals: gen=${signals.generated} sel=${signals.selected} exec=${signals.executed}`
      );
    }

    // Errors/warnings
    if (pulse.errors?.length > 0) {
      lines.push(`⚠️  ${pulse.errors.slice(0, 2).join(", ")}`);
    }

    lines.push("");

    // Log all lines
    for (const line of lines) {
      console.log(line);
    }

    // Send to UI
    if (ui && typeof ui.send === "function") {
      const simpleMsg = `Loop ${pulse.tick ?? this._ticks} | Jup:${jupPositions}pos,$${Math.round(jupAvail)} | Drift:${driftPositions}pos,$${Math.round(driftAvail)} | ${durMs}ms`;
      ui.send("activity", {
        level: pulse.errors?.length > 0 ? "warning" : "info",
        message: simpleMsg,
        data: pulse,
      });
    }
  }

  /**
   * Helper to get capital used by a specific pool
   * CRITICAL: Must use collateral, NOT size (size is leveraged notional)
   */
  _getPoolUsed(venue) {
    const venueRouter = require("./utils/venue-router");
    return this.openPositions
      .filter((p) => venueRouter.getVenueForMarket(p.market) === venue)
      .reduce((sum, p) => {
        // BUGFIX: Use collateral only, never fall back to size/sizeUsd (leveraged notional)
        // Position objects use different field names: collateral, collateralUsd, or both
        const collateral = p.collateral || p.collateralUsd || 0;
        if (process.env.DEBUG_CAPITAL === "true") {
          console.log(
            `[CAPITAL_DEBUG] ${p.market}: collateral=$${collateral.toFixed(2)}, size=$${(p.size || p.sizeUsd || 0).toFixed(2)}`
          );
        }
        return sum + collateral;
      }, 0);
  }

  // ---------- Main loop ----------
  async tick() {
    if (this.paused) return;

    const loopStartTime = Date.now();
    const loopPulse = {
      tick: this._ticks + 1,
      price: { total: MARKETS.length, fetched: 0, missing: [] },
      feed: [],
      signals: { generated: 0, ranked: 0, selected: 0, executed: 0, blocked: 0 },
      barsCompleted: [],
      notes: [],
      errors: [],
      positions: this.openPositions.length,
      availableCapital: null,
    };
    let gateEvaluations = []; // Declare at function scope so it's accessible in finally block
    const _captureTickError = (err, ctx) => {
      try {
        const name = err?.name || "Error";
        const msg = err?.message || String(err);
        const market = ctx?.market || "unknown_market";
        const strategyType = ctx?.strategyType || "unknown_strategy";
        const fn = ctx?.fn || "unknown_fn";
        const note = `${market}:${strategyType}:${fn}:${name}: ${msg}`;
        loopPulse.errors.push(note);
        errorHandler.log(err, {
          category: Category.STRATEGY,
          severity: Severity.LOW,
          action: "tick_strategy_call",
          market,
          strategyType,
          fn,
        });
      } catch (_) {
        // Last-resort: never let error reporting throw.
        loopPulse.errors.push("strategy_error_reporting_failed");
      }
    };
    const _safeCall = (fn, ctx) => {
      try {
        return fn();
      } catch (err) {
        _captureTickError(err, ctx);
        return null;
      }
    };

    // Check if any market is in-flight (only block if all are busy)
    const allMarketsBusy = MARKETS.every((m) => this._tickInflight.has(m));
    if (allMarketsBusy && this._tickInflight.size === MARKETS.length) {
      // All markets are processing, skip this tick
      for (const market of MARKETS) {
        this._pendingTickReplay.set(market, true);
      }
      loopPulse.price.status = loopPulse.price.status || "idle";
      loopPulse.notes.push("skip:inflight");
      loopPulse.durationMs = Date.now() - loopStartTime;
      if (!loopPulse.availableCapital && loopPulse.availableCapital !== 0) {
        loopPulse.availableCapital = this.getAvailableCapital();
      }
      if (LOG_FORMAT === "compact") {
        this._logCompactLoopPulse(loopPulse);
      } else {
        this._logLoopPulse(loopPulse);
      }
      return;
    }

    let activeMarkets = [];
    try {
      const tickTimestamp = Date.now();
      this._lastTickTimestamp = tickTimestamp;

      // Acquire guards for all markets
      activeMarkets = MARKETS.filter((m) => {
        if (!this._acquireTickGuard(m)) {
          this._pendingTickReplay.set(m, true);
          return false;
        }
        return true;
      });
      loopPulse.activeMarkets = activeMarkets.length;

      if (activeMarkets.length === 0) {
        // Release any guards we might have acquired
        for (const market of MARKETS) {
          if (this._tickInflight.has(market)) {
            this._releaseTickGuard(market);
          }
        }
        loopPulse.notes.push("no_active_markets");
        return;
      }

      this._ticks++;
      loopPulse.tick = this._ticks;

      // Periodic summary report (every 12 ticks = ~1 hour with 5-min intervals)
      if (this._ticks % 12 === 0) {
        this._logPeriodicSummary();
      }

      // Fetch prices for all markets in parallel
      const priceDataMap = await this._fetchAllPrices();
      for (const [market, data] of priceDataMap.entries()) {
        if (data && Number.isFinite(data.price)) {
          this._lastPrices.set(market, { ...data, timestamp: Date.now() });
        }
      }
      loopPulse.price.fetched = priceDataMap.size;
      const missingMarkets = MARKETS.filter((m) => !priceDataMap.has(m));
      loopPulse.price.missing = missingMarkets;
      loopPulse.price.status = missingMarkets.length === 0 ? "ok" : "warn";
      if (missingMarkets.length > 0) {
        loopPulse.notes.push(
          `price_missing:${missingMarkets.slice(0, 2).join(",")}${missingMarkets.length > 2 ? "+" : ""}`
        );
      }
      if (this._lastPriceFetchMeta) {
        loopPulse.price.fetch = this._lastPriceFetchMeta;
        const detailEntries = [];
        const perMarket = this._lastPriceFetchMeta.perMarket || {};
        for (const market of MARKETS) {
          const info = perMarket[market];
          if (!info) {
            detailEntries.push(`${market}: NO DATA`);
            continue;
          }
          // Show price first, then source and tags
          const priceStr = Number.isFinite(info.price) ? `$${info.price.toFixed(2)}` : "?";
          const tags = [];
          if (info.source && info.source !== "unknown") tags.push(info.source);
          if (info.stale) tags.push("⚠️stale");
          if (Number.isFinite(info.ageMs) && info.ageMs > 500) {
            tags.push(`${(info.ageMs / 1000).toFixed(1)}s`);
          }
          const tagString = tags.length ? ` (${tags.join(", ")})` : "";
          detailEntries.push(`${market}: ${priceStr}${tagString}`);
        }
        loopPulse.price.details = detailEntries;
        loopPulse.price.mode = this._lastPriceFetchMeta.mode;
      }
      if (this.priceClient?.multiPriceFeed?.getHealthStatus) {
        try {
          const health = this.priceClient.multiPriceFeed.getHealthStatus();
          const feedKeys = ["jupiter", "coinbase", "pyth", "coingecko"];
          loopPulse.feed = feedKeys
            .filter((key) => health && health[key])
            .map((key) => {
              const src = health[key];
              const label = src.name
                ? src.name.charAt(0).toUpperCase()
                : key.charAt(0).toUpperCase();
              const rate = src.successRate || "N/A";
              // Add status indicator for better visibility
              let status = "";
              if (rate === "N/A") {
                status = "○"; // Unused
              } else if (parseFloat(rate) === 100) {
                status = "✓"; // Perfect
              } else if (parseFloat(rate) >= 90) {
                status = "~"; // Good
              } else if (parseFloat(rate) >= 50) {
                status = "!"; // Degraded
              } else {
                status = "✗"; // Failing
              }
              return `${label}:${rate}${status}`;
            });
        } catch (e) {
          loopPulse.notes.push("feed_health_error");
        }
      }

      // Update returns for dynamic correlation tracking
      for (const market of activeMarkets) {
        const priceData = priceDataMap.get(market);
        if (priceData && priceData.price) {
          this.marketAllocator.updateReturns(market, priceData.price, tickTimestamp);
        }
      }
      // Clear correlation cache periodically to force recalculation
      if (this._ticks % 12 === 0) {
        // Every 12 ticks (about 1 minute with 5s loop)
        this.marketAllocator.clearCorrelationCache();
      }

      // Update all strategy instances and collect signals
      const allMarketSignals = [];
      const marketPriceDataMap = new Map(); // Store enriched price data with indicators
      gateEvaluations = []; // Reset gate evaluations for this loop (declared at function scope)

      for (const market of activeMarkets) {
        const priceData = priceDataMap.get(market);
        if (!priceData) continue;

        const strategyOrStrategies = this.strategies.get(market);
        const barAggregator = this.barAggregators.get(market);
        const tickBuffer = this.tickBuffers.get(market);
        if (!strategyOrStrategies || !barAggregator || !tickBuffer) continue;

        const { price, volume = 0 } = priceData;

        // Add tick to both systems
        // 1. BarAggregator: Tracks discrete per-market bars (for bar counting)
        const completedBar = barAggregator.addTick({
          price,
          volume,
          timestamp: tickTimestamp,
          high: price,
          low: price,
        });

        if (completedBar) {
          loopPulse.barsCompleted.push({
            market,
            interval: this._marketIntervals?.get(market) || this.tradingInterval,
            ts: completedBar.timestamp,
          });
        }

        // 2. TickBuffer: Maintains rolling window (for current bar data)
        tickBuffer.addTick({
          price,
          volume,
          timestamp: tickTimestamp,
          high: price,
          low: price,
        });

        // Get current rolling window data
        const currentWindow = tickBuffer.getCurrentBar();

        // Determine if we're in multi-strategy mode (array of strategies)
        const marketStrategies = Array.isArray(strategyOrStrategies)
          ? strategyOrStrategies // Multi-strategy: [{ type, strategy }, ...]
          : [
              {
                type: this.strategyFactory.getStrategyType(market),
                strategy: strategyOrStrategies,
              },
            ]; // Single: wrap in array

        // Update ALL strategies for this market
        for (const { type: strategyType, strategy } of marketStrategies) {
          if (!strategy) continue;

          // Update strategy ONLY when a discrete bar completes (market interval).
          // This keeps bar counting correct.
          if (completedBar) {
            _safeCall(
              () =>
                strategy.update({
                  price: completedBar.close,
                  close: completedBar.close,
                  high: completedBar.high,
                  low: completedBar.low,
                  volume: completedBar.volume,
                  ts: completedBar.timestamp,
                }),
              { market, strategyType, fn: "update" }
            );

            // Optional: emit a single machine-parseable line per completed bar so we can
            // validate RSI calculations against production EXACTLY (uses the same bar close
            // series the bot used, not external candles).
            // Enable with: LOG_RSI_BAR_CLOSE=true
            if (process.env.LOG_RSI_BAR_CLOSE === "true") {
              const rsiVal = strategy && Number.isFinite(strategy.rsi) ? strategy.rsi : null;
              console.log(
                `[BAR-CLOSE] market=${market} ts=${new Date(completedBar.timestamp).toISOString()} ` +
                  `close=${Number(completedBar.close).toFixed(6)} rsi=${rsiVal == null ? "null" : Number(rsiVal).toFixed(4)}`
              );
            }
          }

          // Update the LAST bar in strategy's price arrays with current rolling window data
          // This allows MA, Donchian, and ATR to update dynamically mid-bar
          // RSI and ADX remain at their last bar-close values (Wilder's smoothing)
          if (currentWindow && strategy.prices && strategy.prices.length > 0) {
            // Use the strategy's recalculateLastBar method to update
            if (typeof strategy.recalculateLastBar === "function") {
              _safeCall(
                () =>
                  strategy.recalculateLastBar({
                    close: currentWindow.close,
                    high: currentWindow.high,
                    low: currentWindow.low,
                    volume: currentWindow.volume,
                  }),
                { market, strategyType, fn: "recalculateLastBar" }
              );
            }
          }

          // Also call updateTick for strategies that support it (e.g., scalping, RSI-reversion)
          if (typeof strategy.updateTick === "function") {
            _safeCall(() => strategy.updateTick({ price, volume, ts: tickTimestamp }), {
              market,
              strategyType,
              fn: "updateTick",
            });
          }
        }

        // Log bar completion once per market (not per strategy).
        // Default behavior:
        // - Always log Ichimoku markets on bar close (15m) for parity/ops visibility.
        // - Other markets log only when explicitly enabled (LOG_BAR_COMPLETION=true).
        if (completedBar) {
          const interval = this._marketIntervals?.get(market) || this.tradingInterval;
          const logAllBars = process.env.LOG_BAR_COMPLETION === "true";
          const logIchimokuBars = process.env.LOG_ICHIMOKU_BAR_COMPLETION === "true" || logAllBars;

          const isIchimokuMarket =
            (this.strategyFactory &&
              typeof this.strategyFactory.getStrategyType === "function" &&
              this.strategyFactory.getStrategyType(market) === "ichimoku-cloud") ||
            (this.multiStrategyMode &&
              Array.isArray(marketStrategies) &&
              marketStrategies.some((s) => s?.type === "ichimoku-cloud"));

          if (logAllBars || (isIchimokuMarket && logIchimokuBars)) {
            console.log(
              `📊 ${market} [${interval}] bar completed: O:${completedBar.open.toFixed(2)} H:${completedBar.high.toFixed(2)} L:${completedBar.low.toFixed(2)} C:${completedBar.close.toFixed(2)}`
            );
          }
        }

        // Get signals from ALL strategies for this market
        // CRITICAL: Only include AUTOMATED positions - strategies should NOT evaluate manual positions
        // Manual positions are managed by the user, not by strategy exit logic
        const marketPositions = this.openPositions.filter(
          (p) => (p.market || MARKET) === market && !this._isManualPosition(p)
        );
        // Enable gate logging via env var for debugging
        const printGates = process.env.ENABLE_GATE_LOGGING === "true";

        // Collect signals from all strategies (use first strategy for legacy compatibility)
        const primaryStrategy = marketStrategies[0]?.strategy;
        const primaryStrategyType =
          marketStrategies[0]?.type || this.strategyFactory.getStrategyType(market);
        const signal = primaryStrategy
          ? _safeCall(
              () => primaryStrategy.getSignal(price, marketPositions, printGates, this._ticks),
              { market, strategyType: primaryStrategyType, fn: "getSignal" }
            )
          : null;

        // Multi-strategy mode: collect signals from ALL strategies (even if market has only 1)
        if (this.multiStrategyMode && marketStrategies.length >= 1) {
          for (const { type: strategyType, strategy: strat } of marketStrategies) {
            if (!strat) continue;
            const stratSignal = _safeCall(
              () => strat.getSignal(price, marketPositions, printGates, this._ticks),
              { market, strategyType, fn: "getSignal" }
            );
            if (stratSignal && stratSignal.action !== "hold") {
              // Add strategyType to signal and collect
              loopPulse.signals.generated++;
              allMarketSignals.push({
                market,
                strategyType,
                signal: { ...stratSignal, strategyType },
                priceData,
              });
            }
          }
        }

        // For legacy code below, use primaryStrategy as "strategy"
        const strategy = primaryStrategy;

        // Capture gate evaluation status for pulse log (for ALL strategies in multi-mode)
        const allGateEvaluations = [];

        // In multi-strategy mode, evaluate gates for ALL strategies in a unified loop
        // In single-strategy mode, only evaluate the primary strategy
        if (this.multiStrategyMode) {
          // Get current bar for bar aggregation info (shared across all strategies for this market)
          const multiStratCurrentBar = barAggregator.getCurrentBar();

          // Track evaluated strategy types to prevent duplicates
          const evaluatedTypes = new Set();

          for (const { type: strategyType, strategy: strat } of marketStrategies) {
            if (!strat) continue;

            // Skip duplicates (only evaluate each strategy type once per market)
            if (evaluatedTypes.has(strategyType)) continue;
            evaluatedTypes.add(strategyType);

            // Get signal for this strategy to evaluate gates
            const stratSignal = _safeCall(
              () => strat.getSignal(price, marketPositions, false, this._ticks),
              { market, strategyType, fn: "getSignal" }
            );
            if (!stratSignal) continue;

            // Build indicators based on strategy type
            const indicators = {
              price: price,
              rsi: strat.rsi,
              atr: strat.atr,
            };

            // Add strategy-specific indicators
            if (strategyType === "momentum") {
              indicators.adx = strat.adx;
              // Calculate MA from the strategy's _sma method if available
              indicators.ma =
                typeof strat._sma === "function"
                  ? strat._sma(strat.cfg?.maPeriod ?? 70)
                  : undefined;
              indicators.donchianHigh = strat.donchianHigh;
              indicators.donchianLow = strat.donchianLow;
            } else if (strategyType === "rsi-reversion" || strategyType === "rsi-reversion-alt") {
              // RSI reversion specific indicators
              indicators.rsi = strat.rsi;
              indicators.adx = strat.adx;
              indicators.rsiConfig = {
                oversoldExtreme: strat.cfg?.rsiOversoldExtreme ?? 20,
                oversoldRecovery: strat.cfg?.rsiOversoldRecovery ?? 25,
                overboughtExtreme: strat.cfg?.rsiOverboughtExtreme ?? 80,
                overboughtRecovery: strat.cfg?.rsiOverboughtRecovery ?? 75,
                targetNeutral: strat.cfg?.rsiTargetNeutral ?? 50,
                minAdx: strat.cfg?.rsiMinAdx ?? 0,
                maxAdx: strat.cfg?.rsiMaxAdx ?? 100,
                minVolatilityPct: strat.cfg?.rsiMinVolatilityPct ?? 0.2,
                maxVolatilityPct: strat.cfg?.rsiMaxVolatilityPct ?? 5.0,
                entryMaxBars: strat.cfg?.rsiEntryMaxBars ?? 2,
                entryMaxDeviation: strat.cfg?.rsiEntryMaxDeviation ?? 5,
              };
              // RSI extreme tracking state
              indicators.rsiState = {
                lastOversoldBar: strat._lastOversoldBar,
                lastOversoldRsi: strat._lastOversoldRsi,
                oversoldConsumed: strat._oversoldConsumed,
                lastOverboughtBar: strat._lastOverboughtBar,
                lastOverboughtRsi: strat._lastOverboughtRsi,
                overboughtConsumed: strat._overboughtConsumed,
                currentBarIndex: strat._currentBarIndex,
              };
              // Calculate bars since extreme (use != null to catch both null and undefined)
              if (strat._lastOversoldBar != null && !strat._oversoldConsumed) {
                indicators.barsSinceOversold = strat._currentBarIndex - strat._lastOversoldBar;
              }
              if (strat._lastOverboughtBar != null && !strat._overboughtConsumed) {
                indicators.barsSinceOverbought = strat._currentBarIndex - strat._lastOverboughtBar;
              }
              // Volatility check for RSI-reversion
              // Use the already-extracted 'price' variable from outer loop (line 4769) instead of priceData?.price
              const rsiAtr = strat.atr;
              const rsiPrice = price || 0;
              const rsiAtrPct =
                Number.isFinite(rsiAtr) && rsiPrice > 0 ? (rsiAtr / rsiPrice) * 100 : null;
              indicators.volatility = {
                atrPct: rsiAtrPct,
                minPct: strat.cfg?.rsiMinVolatilityPct ?? 0.2,
                maxPct: strat.cfg?.rsiMaxVolatilityPct ?? 5.0,
                ok:
                  rsiAtrPct === null ||
                  (rsiAtrPct >= (strat.cfg?.rsiMinVolatilityPct ?? 0.2) &&
                    rsiAtrPct <= (strat.cfg?.rsiMaxVolatilityPct ?? 5.0)),
              };
            } else if (strategyType === "btc-breakout") {
              const lastVolume = Array.isArray(strat.volumes)
                ? strat.volumes[strat.volumes.length - 1]
                : null;
              const volumeRatio =
                Number.isFinite(lastVolume) &&
                Number.isFinite(strat.volumeAvg) &&
                strat.volumeAvg > 0
                  ? lastVolume / strat.volumeAvg
                  : null;
              indicators.adx = strat.adx;
              indicators.trendEma = strat._ema;
              indicators.trendSlope = strat._emaSlope;
              indicators.entryChannelHigh = strat.entryChannelHigh;
              indicators.entryChannelLow = strat.entryChannelLow;
              indicators.exitChannelHigh = strat.exitChannelHigh;
              indicators.exitChannelLow = strat.exitChannelLow;
              indicators.volumeAvg = strat.volumeAvg;
              indicators.volumeLast = lastVolume;
              indicators.volumeSpike = strat.volumeSpike;
              indicators.volumeRatio = volumeRatio;
              indicators.entryDistanceAtr =
                stratSignal?.breakoutDistanceAtr ??
                stratSignal?.entryDebug?.long?.details?.breakoutDistanceAtr ??
                stratSignal?.entryDebug?.short?.details?.breakoutDistanceAtr ??
                null;
              indicators.priceBreakout =
                stratSignal?.action === "open" ? stratSignal?.side?.toLowerCase() : null;
              indicators.regimeBias =
                Number.isFinite(price) &&
                Number.isFinite(strat._ema) &&
                Number.isFinite(strat._emaSlope)
                  ? price >= strat._ema && strat._emaSlope >= 0
                    ? "bull"
                    : price <= strat._ema && strat._emaSlope <= 0
                      ? "bear"
                      : "mixed"
                  : "N/A";
            } else if (strategyType === "ichimoku-cloud") {
              // Ichimoku cloud breakout indicators (bar-updated values shown per tick)
              indicators.adx = strat.adx;
              indicators.tenkan = strat.tenkan;
              indicators.kijun = strat.kijun;
              indicators.senkouA = strat.senkouA;
              indicators.senkouB = strat.senkouB;
              indicators.cloudTop = strat.cloudTop;
              indicators.cloudBottom = strat.cloudBottom;
              indicators.cloudBullish = strat.cloudBullish;
              indicators.chikouLag = strat.chikouLag;
              indicators.volumeAvg = strat.volumeAvg;
              indicators.volumeLast = strat._lastBarVolume;
              indicators.volumeSpike = strat.volumeSpike;
              indicators.oscRsi = strat.rsi;
              indicators.oscMacdHist = strat._macdHist;
              indicators.htf = {
                adx: strat._htfAdx,
                chop: strat._htfChop,
                bias: strat._htfBias,
              };
            } else if (strategyType === "scalping") {
              // Scalping specific indicators
              indicators.rsi = strat.rsi;
            }

            // Build gateConfig for display (based on strategy's config)
            const volFilterOn = strat.cfg?.enableVolatilityFilter !== false;
            const zFilter = strat.cfg?.zFilter ?? 0;
            const vMin = strat.cfg?.vMin ?? 0;
            const gateConfig = {
              requireMaSlopeLong: strat.cfg?.requireMaSlopeLong !== false,
              requireMaSlopeShort: strat.cfg?.requireMaSlopeShort !== false,
              enableDonchianGate: strat.cfg?.enableDonchianGate !== false,
              useVolRegime: volFilterOn && zFilter > 0 && vMin > 0,
              longStrictHTF: strat.cfg?.longStrictHTF === true,
              shortStrictHTF: strat.cfg?.shortStrictHTF === true,
              enableHTFTrend: strat.cfg?.enableHTFTrend !== false,
              requireVolumeSpike: strat.cfg?.requireVolumeSpike === true,
              requireRetest: strat.cfg?.requireRetest === true,
              requireAdxSlopeUp: strat.cfg?.requireAdxSlopeUp === true,
              entryDistEnabled:
                strat.cfg?.maxEntryDistAtr !== null && strat.cfg?.maxEntryDistAtr !== undefined,
              enableGreenDayVeto: strat.cfg?.enableGreenDayVeto === true,
              enableTimeGate: strat.cfg?.enableTimeGate === true,
            };

            // Check if longs/shorts are disabled (global env or per-market override)
            const marketAllowSettings = this.perMarketAllowSettings?.get(market);
            // Global settings from env (ALLOW_LONGS, ALLOW_SHORTS)
            const globalAllowLongs = process.env.ALLOW_LONGS !== "false";
            const globalAllowShorts = process.env.ALLOW_SHORTS !== "false";
            // Per-market overrides take precedence, otherwise use global
            const longsDisabled = marketAllowSettings?.allowLongs === false || !globalAllowLongs;
            const shortsDisabled = marketAllowSettings?.allowShorts === false || !globalAllowShorts;

            const gateEval = {
              market,
              strategyType,
              ready: strat._ready !== false,
              barCount: strat._barCount || 0,
              longOK: stratSignal.longOK,
              shortOK: stratSignal.shortOK,
              longsDisabled,
              shortsDisabled,
              action: stratSignal.action,
              reason: stratSignal.reason,
              entryDebug: stratSignal.entryDebug || null,
              indicators,
              gateStatus: stratSignal.gateStatus || null,
              gateConfig,
              barAggregation: multiStratCurrentBar
                ? {
                    ticksInBar: multiStratCurrentBar.tickCount,
                    barProgress: (
                      ((tickTimestamp - multiStratCurrentBar.startTime) /
                        (multiStratCurrentBar.endTime - multiStratCurrentBar.startTime)) *
                      100
                    ).toFixed(0),
                  }
                : null,
            };
            allGateEvaluations.push(gateEval);
          }
        } else if (signal) {
          // Single-strategy mode: evaluate only the primary strategy
          const currentBar = barAggregator.getCurrentBar();

          // Calculate MA for display (same as strategy uses)
          const maPeriod = strategy.cfg?.maPeriod || 70;
          let ma = null;
          if (strategy.prices && strategy.prices.length >= maPeriod) {
            const recent = strategy.prices.slice(-maPeriod);
            ma = recent.reduce((a, b) => a + b, 0) / maPeriod;
          }

          const volFilterOn = strategy.cfg?.enableVolatilityFilter !== false;
          const zFilter = strategy.cfg?.zFilter ?? 0;
          const vMin = strategy.cfg?.vMin ?? 0;
          const gateConfig = {
            requireMaSlopeLong: strategy.cfg?.requireMaSlopeLong !== false,
            requireMaSlopeShort: strategy.cfg?.requireMaSlopeShort !== false,
            enableDonchianGate: strategy.cfg?.enableDonchianGate !== false,
            useVolRegime: volFilterOn && zFilter > 0 && vMin > 0,
            longStrictHTF: strategy.cfg?.longStrictHTF === true,
            shortStrictHTF: strategy.cfg?.shortStrictHTF === true,
            enableHTFTrend: strategy.cfg?.enableHTFTrend !== false,
            requireVolumeSpike: strategy.cfg?.requireVolumeSpike === true,
            requireRetest: strategy.cfg?.requireRetest === true,
            requireAdxSlopeUp: strategy.cfg?.requireAdxSlopeUp === true,
            entryDistEnabled:
              strategy.cfg?.maxEntryDistAtr !== null && strategy.cfg?.maxEntryDistAtr !== undefined,
            enableGreenDayVeto: strategy.cfg?.enableGreenDayVeto === true,
            enableTimeGate: strategy.cfg?.enableTimeGate === true,
          };

          // Check if longs/shorts are disabled (global env or per-market override)
          const singleMarketAllowSettings = this.perMarketAllowSettings?.get(market);
          // Global settings from env (ALLOW_LONGS, ALLOW_SHORTS)
          const singleGlobalAllowLongs = process.env.ALLOW_LONGS !== "false";
          const singleGlobalAllowShorts = process.env.ALLOW_SHORTS !== "false";
          // Per-market overrides take precedence, otherwise use global
          const singleLongsDisabled =
            singleMarketAllowSettings?.allowLongs === false || !singleGlobalAllowLongs;
          const singleShortsDisabled =
            singleMarketAllowSettings?.allowShorts === false || !singleGlobalAllowShorts;

          // Build indicators based on strategy type
          const singleIndicators = {
            price: price,
            rsi: strategy.rsi,
            adx: strategy.adx,
            atr: strategy.atr,
            ma: ma,
            donchianHigh: strategy.donchianHigh,
            donchianLow: strategy.donchianLow,
          };

          // Add RSI-reversion specific indicators for single-strategy mode
          if (
            primaryStrategyType === "rsi-reversion" ||
            primaryStrategyType === "rsi-reversion-alt"
          ) {
            singleIndicators.rsiConfig = {
              oversoldExtreme: strategy.cfg?.rsiOversoldExtreme ?? 20,
              oversoldRecovery: strategy.cfg?.rsiOversoldRecovery ?? 25,
              overboughtExtreme: strategy.cfg?.rsiOverboughtExtreme ?? 80,
              overboughtRecovery: strategy.cfg?.rsiOverboughtRecovery ?? 75,
              targetNeutral: strategy.cfg?.rsiTargetNeutral ?? 50,
              minAdx: strategy.cfg?.rsiMinAdx ?? 0,
              maxAdx: strategy.cfg?.rsiMaxAdx ?? 100,
              minVolatilityPct: strategy.cfg?.rsiMinVolatilityPct ?? 0.2,
              maxVolatilityPct: strategy.cfg?.rsiMaxVolatilityPct ?? 5.0,
              entryMaxBars: strategy.cfg?.rsiEntryMaxBars ?? 2,
              entryMaxDeviation: strategy.cfg?.rsiEntryMaxDeviation ?? 5,
            };
            // RSI extreme tracking state
            singleIndicators.rsiState = {
              lastOversoldBar: strategy._lastOversoldBar,
              lastOversoldRsi: strategy._lastOversoldRsi,
              oversoldConsumed: strategy._oversoldConsumed,
              lastOverboughtBar: strategy._lastOverboughtBar,
              lastOverboughtRsi: strategy._lastOverboughtRsi,
              overboughtConsumed: strategy._overboughtConsumed,
              currentBarIndex: strategy._currentBarIndex,
            };
            // Calculate bars since extreme (use != null to catch both null and undefined)
            if (strategy._lastOversoldBar != null && !strategy._oversoldConsumed) {
              singleIndicators.barsSinceOversold =
                strategy._currentBarIndex - strategy._lastOversoldBar;
            }
            if (strategy._lastOverboughtBar != null && !strategy._overboughtConsumed) {
              singleIndicators.barsSinceOverbought =
                strategy._currentBarIndex - strategy._lastOverboughtBar;
            }
            // Volatility check for RSI-reversion
            const singleRsiAtr = strategy.atr;
            const singleRsiPrice = price || 0;
            const singleRsiAtrPct =
              Number.isFinite(singleRsiAtr) && singleRsiPrice > 0
                ? (singleRsiAtr / singleRsiPrice) * 100
                : null;
            singleIndicators.volatility = {
              atrPct: singleRsiAtrPct,
              minPct: strategy.cfg?.rsiMinVolatilityPct ?? 0.2,
              maxPct: strategy.cfg?.rsiMaxVolatilityPct ?? 5.0,
              ok:
                singleRsiAtrPct === null ||
                (singleRsiAtrPct >= (strategy.cfg?.rsiMinVolatilityPct ?? 0.2) &&
                  singleRsiAtrPct <= (strategy.cfg?.rsiMaxVolatilityPct ?? 5.0)),
            };
          } else if (primaryStrategyType === "btc-breakout") {
            const singleLastVolume = Array.isArray(strategy.volumes)
              ? strategy.volumes[strategy.volumes.length - 1]
              : null;
            const singleVolumeRatio =
              Number.isFinite(singleLastVolume) &&
              Number.isFinite(strategy.volumeAvg) &&
              strategy.volumeAvg > 0
                ? singleLastVolume / strategy.volumeAvg
                : null;
            singleIndicators.trendEma = strategy._ema;
            singleIndicators.trendSlope = strategy._emaSlope;
            singleIndicators.entryChannelHigh = strategy.entryChannelHigh;
            singleIndicators.entryChannelLow = strategy.entryChannelLow;
            singleIndicators.exitChannelHigh = strategy.exitChannelHigh;
            singleIndicators.exitChannelLow = strategy.exitChannelLow;
            singleIndicators.volumeAvg = strategy.volumeAvg;
            singleIndicators.volumeLast = singleLastVolume;
            singleIndicators.volumeSpike = strategy.volumeSpike;
            singleIndicators.volumeRatio = singleVolumeRatio;
            singleIndicators.entryDistanceAtr =
              signal?.breakoutDistanceAtr ??
              signal?.entryDebug?.long?.details?.breakoutDistanceAtr ??
              signal?.entryDebug?.short?.details?.breakoutDistanceAtr ??
              null;
            singleIndicators.priceBreakout =
              signal?.action === "open" ? signal?.side?.toLowerCase() : null;
            singleIndicators.regimeBias =
              Number.isFinite(price) &&
              Number.isFinite(strategy._ema) &&
              Number.isFinite(strategy._emaSlope)
                ? price >= strategy._ema && strategy._emaSlope >= 0
                  ? "bull"
                  : price <= strategy._ema && strategy._emaSlope <= 0
                    ? "bear"
                    : "mixed"
                : "N/A";
          }

          const gateEval = {
            market,
            strategyType: primaryStrategyType,
            ready: strategy._ready || false,
            barCount: strategy._barCount || 0,
            longOK: signal.longOK,
            shortOK: signal.shortOK,
            longsDisabled: singleLongsDisabled,
            shortsDisabled: singleShortsDisabled,
            action: signal.action,
            reason: signal.reason,
            entryDebug: signal.entryDebug || null,
            indicators: singleIndicators,
            gateStatus: signal.gateStatus || null,
            gateConfig,
            barAggregation: currentBar
              ? {
                  ticksInBar: currentBar.tickCount,
                  barProgress: (
                    ((tickTimestamp - currentBar.startTime) /
                      (currentBar.endTime - currentBar.startTime)) *
                    100
                  ).toFixed(0),
                }
              : null,
          };
          allGateEvaluations.push(gateEval);
        }

        // Add all gate evaluations to the global array
        gateEvaluations.push(...allGateEvaluations);

        // Track gate analytics (lightweight, optimized for performance)
        // Use sampling to reduce overhead: track all failures + sample passes
        if (
          signal &&
          signal.gateStatus &&
          signal.longOK !== undefined &&
          signal.shortOK !== undefined
        ) {
          const gateAnalytics = require("./utils/gate-analytics").getGateAnalytics();

          // Always track failures (they're rare and important)
          // Sample passes to reduce overhead (configurable via env var, default: 1 in 20 = 5%)
          // Lower values = more accurate but higher overhead
          const SAMPLE_PASS_RATE = parseInt(process.env.GATE_ANALYTICS_SAMPLE_RATE || "20", 10);
          const shouldTrackPass = this._ticks % SAMPLE_PASS_RATE === 0;

          // Track long gates
          if (!signal.longOK) {
            // Always track failures (with full gate status for analysis)
            gateAnalytics.recordEvaluation(
              market,
              "long",
              false,
              signal.gateStatus,
              SAMPLE_PASS_RATE
            );
          } else if (shouldTrackPass) {
            // Sample passes: track as pass but account for sampling in count
            gateAnalytics.recordEvaluation(market, "long", true, null, SAMPLE_PASS_RATE);
          } else {
            // Still increment counter for accurate totals (very lightweight)
            gateAnalytics.incrementEvaluationCount(market, "long", SAMPLE_PASS_RATE);
          }

          // Track short gates
          if (!signal.shortOK) {
            // Always track failures (with full gate status for analysis)
            gateAnalytics.recordEvaluation(
              market,
              "short",
              false,
              signal.gateStatus,
              SAMPLE_PASS_RATE
            );
          } else if (shouldTrackPass) {
            // Sample passes: track as pass but account for sampling in count
            gateAnalytics.recordEvaluation(market, "short", true, null, SAMPLE_PASS_RATE);
          } else {
            // Still increment counter for accurate totals (very lightweight)
            gateAnalytics.incrementEvaluationCount(market, "short", SAMPLE_PASS_RATE);
          }
        }

        // Log gate holds that block opening for parameter tuning
        if (signal && signal.action === "hold") {
          // Enrich with gate flags for richer attribution
          let gate = null;
          try {
            gate =
              typeof strategy.getGateState === "function"
                ? strategy.getGateState(price, false)
                : null;
          } catch {}
          const gateReasonsToLog = new Set([
            "same_side_reentry_cooldown",
            "short_hour_throttle",
            "already_in_position",
          ]);
          if (gateReasonsToLog.has(signal.reason)) {
            try {
              db.logGateEvent({
                ts: tickTimestamp,
                market,
                side: signal.side || null,
                reason: signal.reason,
                price,
                adx: strategy.adx,
                atr: strategy.atr,
                rsi: strategy.rsi,
                tick: this._ticks,
                context: {
                  positionsInMarket: marketPositions.length,
                },
                long_ok: gate?.longOK,
                short_ok: gate?.shortOK,
                above_ma: gate?.aboveMA,
                below_ma: gate?.belowMA,
                adx_ok: gate?.adxLongOK || gate?.adxShortOK,
                time_gate_ok: gate?.timeGateOK,
                cooldown_ok_long: gate?.cooldownLongOK,
                cooldown_ok_short: gate?.cooldownShortOK,
                don_break_up: gate?.donUpOK,
                don_break_dn: gate?.donDnOK,
              });
            } catch {}
          }
          // Optional: log no_edge_signal when explicitly enabled for deeper tuning
          if (signal.reason === "no_edge_signal" && process.env.LOG_NO_EDGE_GATES === "true") {
            try {
              let gate2 = null;
              try {
                gate2 =
                  typeof strategy.getGateState === "function"
                    ? strategy.getGateState(price, false)
                    : null;
              } catch {}
              db.logGateEvent({
                ts: tickTimestamp,
                market,
                side: null,
                reason: signal.reason,
                price,
                adx: strategy.adx,
                atr: strategy.atr,
                rsi: strategy.rsi,
                tick: this._ticks,
                long_ok: gate2?.longOK,
                short_ok: gate2?.shortOK,
                above_ma: gate2?.aboveMA,
                below_ma: gate2?.belowMA,
                adx_ok: gate2?.adxLongOK || gate2?.adxShortOK,
                time_gate_ok: gate2?.timeGateOK,
                cooldown_ok_long: gate2?.cooldownLongOK,
                cooldown_ok_short: gate2?.cooldownShortOK,
                don_break_up: gate2?.donUpOK,
                don_break_dn: gate2?.donDnOK,
              });
            } catch {}
          }
        }

        // Enrich price data with strategy indicators (for market allocator)
        const enrichedPriceData = { ...priceData };
        if (USE_ENHANCED_STRATEGY && strategy.adx !== null) {
          enrichedPriceData.adx = strategy.adx;
        }
        if (USE_ENHANCED_STRATEGY && strategy.atr !== null) {
          enrichedPriceData.atr = strategy.atr;
        }
        if (USE_ENHANCED_STRATEGY && strategy.rsi !== null) {
          enrichedPriceData.rsi = strategy.rsi;
        }

        marketPriceDataMap.set(market, enrichedPriceData);

        // In multi-strategy mode, signals are already collected in the loop above (lines 4726-4739)
        // Only collect primary strategy signal in single-strategy mode to avoid duplicates
        if (
          !this.multiStrategyMode &&
          signal &&
          (signal.action === "open" || signal.action === "pyramid")
        ) {
          loopPulse.signals.generated++;
          allMarketSignals.push({
            market,
            signal,
            priceData: enrichedPriceData,
          });
        } else if (this._ticks % 60 === 0) {
          // Log strategy state every 60 ticks (5 minutes) if no signals
          console.error(
            "[DIAGNOSTIC] No signal generated for",
            market,
            JSON.stringify({
              price,
              adx: enrichedPriceData.adx,
              atr: enrichedPriceData.atr,
              rsi: enrichedPriceData.rsi,
              marketPositions: marketPositions.length,
              tick: this._ticks,
            })
          );
        }
      }

      // Get portfolio metrics for market allocator
      const availableCapital = this.getAvailableCapital();
      loopPulse.availableCapital = availableCapital;
      // Exclude manual positions from portfolio risk calculations
      const automatedPositions = this._getAutomatedPositions();
      const portfolioMetrics = this.portfolioRisk.getRiskMetrics(
        automatedPositions,
        availableCapital
      );

      // Update position PnL for risk management
      for (const pos of this.openPositions) {
        const posMarket = pos.market || MARKET;
        const posPriceData = priceDataMap.get(posMarket);
        if (posPriceData) {
          this.riskManager.updatePosition(pos, posPriceData.price, this.priceClient);
        }
      }

      // CRITICAL: Check for liquidation FIRST (before any other exit logic)
      // Liquidation must be checked immediately to prevent unlimited losses
      for (const pos of [...this.openPositions]) {
        const posMarket = pos.market || MARKET;
        if (!pos.market) {
          console.error(
            `❌ CRITICAL: Position ${pos.positionId} has no market field, falling back to MARKET constant (${MARKET})`
          );
          errorHandler.log(new Error(`Position missing market field`), {
            category: Category.VALIDATION,
            severity: Severity.HIGH,
            context: { positionId: pos.positionId, fallbackMarket: MARKET },
          });
        }
        const priceData = priceDataMap.get(posMarket);
        if (!priceData) {
          console.error(
            `❌ CRITICAL: No price data found for market ${posMarket} (position market: ${pos.market || "missing"})`
          );
          errorHandler.log(new Error(`Missing price data for market`), {
            category: Category.NETWORK,
            severity: Severity.MEDIUM,
            context: { positionId: pos.positionId, market: posMarket, positionMarket: pos.market },
          });
          continue;
        }

        // Check if position has reached liquidation price (exact check, not just "near")
        if (this.priceClient.isLiquidated && this.priceClient.isLiquidated(pos, priceData.price)) {
          // CRITICAL FIX: Skip liquidation close for manual/external positions
          // Bot should NOT auto-close positions it didn't open - they'll be liquidated by the protocol
          // This prevents the bot from interfering with user's manual positions
          const isBotPosition = this._isBotOpenedPosition(pos);
          if (!isBotPosition) {
            console.warn(
              `⚠️  [LIQUIDATION] Manual position ${pos.positionId?.slice(0, 8) || "unknown"}... (${pos.market} ${pos.side}) is at liquidation price. ` +
                `NOT closing - protocol will liquidate if needed. trade_type=${pos.trade_type || "not set"}`
            );
            // Don't continue - let protocol handle it, but skip our close logic
            continue;
          }

          // Force close immediately at liquidation price (position loses entire collateral)
          console.log(
            `🚨 [LIQUIDATION] Bot position ${pos.positionId?.slice(0, 8) || "unknown"}... (${pos.market} ${pos.side}) reached liquidation. Closing...`
          );
          try {
            await this.closePosition(pos, pos.liquidationPrice, "LIQUIDATION");
          } catch (error) {
            console.error(
              `[LIQUIDATION] Failed to close liquidated position ${pos.positionId}:`,
              error.message
            );
            // Don't throw - continue with other positions even if this one fails
            errorHandler.log(error, {
              category: Category.TRANSACTION,
              severity: error.message?.includes("KILL SWITCH")
                ? Severity.CRITICAL
                : Severity.CRITICAL,
              context: {
                action: "closePosition",
                positionId: pos.positionId,
                reason: "LIQUIDATION",
              },
            });
          }
          continue; // Skip rest of exit logic for liquidated position
        }
      }

      // Check exits - strategy exits (per market)
      // When USE_RISK_TP is enabled for a market, disable strategy exits (mutually exclusive with static TP/SL).
      // NOTE: supports both global USE_RISK_TP and per-market STRATEGY_{MARKET}_USE_RISK_TP via strategyEnvManager.
      const useRiskTPGlobal = process.env.USE_RISK_TP === "true" || process.env.USE_RISK_TP === "1";
      for (const pos of [...this.openPositions]) {
        const posMarket = pos.market || MARKET;
        let useRiskTPForMarket = strategyEnvManager?.getMarketConfigBool
          ? strategyEnvManager.getMarketConfigBool(
              posMarket,
              "USE_RISK_TP",
              useRiskTPGlobal,
              pos.strategyType
            )
          : useRiskTPGlobal;
        if (pos.strategyType === "copy-trading" && strategyEnvManager?.getEnvForMarket) {
          const env = strategyEnvManager.getEnvForMarket(posMarket, pos.strategyType);
          if (env && env.COPY_USE_RISK_TP !== undefined && env.COPY_USE_RISK_TP !== "") {
            const s = String(env.COPY_USE_RISK_TP).toLowerCase();
            useRiskTPForMarket = s === "1" || s === "true" || s === "yes" || s === "y";
          }
        }
        if (useRiskTPForMarket) continue;
        if (!pos.market) {
          console.error(
            `❌ CRITICAL: Position ${pos.positionId} has no market field, falling back to MARKET constant (${MARKET})`
          );
          errorHandler.log(new Error(`Position missing market field`), {
            category: Category.VALIDATION,
            severity: Severity.HIGH,
            context: { positionId: pos.positionId, fallbackMarket: MARKET },
          });
        }

        // CRITICAL: Skip strategy exits for manually opened positions
        // Bot-opened positions have clientOrderId that is a 48-char hex SHA-256 hash
        // Manual/synced positions have clientOrderId like "1764980267054_5CB1DRzc" (timestamp_positionId)
        // or "manual-{timestamp}" format
        const isBotOpenedPosition = this._isBotOpenedPosition(pos);
        if (!isBotOpenedPosition) {
          if (process.env.DEBUG_STOP_LOSS === "true") {
            console.log(
              `[STRATEGY_EXIT] Skipping strategy exit for manual position ${pos.positionId?.slice(0, 8)}... (trade_type=${pos.trade_type || "not set"})`
            );
          }
          continue;
        }

        // Multi-strategy mode: find the correct strategy based on position.strategyType
        let strategy = null;
        const strategyOrStrategies = this.strategies.get(posMarket);
        if (Array.isArray(strategyOrStrategies)) {
          // Multi-strategy: find by strategyType
          const posStrategyType = pos.strategyType;
          const match = strategyOrStrategies.find((s) => s.type === posStrategyType);
          strategy = match?.strategy || strategyOrStrategies[0]?.strategy; // Fallback to first if not found
        } else {
          // Single-strategy mode
          strategy = strategyOrStrategies;
        }

        const priceData = priceDataMap.get(posMarket);

        if (!priceData) {
          console.error(
            `❌ CRITICAL: No price data found for market ${posMarket} (position market: ${pos.market || "missing"})`
          );
          errorHandler.log(new Error(`Missing price data for market`), {
            category: Category.NETWORK,
            severity: Severity.MEDIUM,
            context: { positionId: pos.positionId, market: posMarket, positionMarket: pos.market },
          });
          continue;
        }

        if (strategy && priceData) {
          // Update trailing stop water marks before checking shouldClose
          // highWaterMark: tracks highest price for longs (used for trailing stop)
          // lowWaterMark: tracks lowest price for shorts (used for trailing stop)
          const currentPrice = priceData.price;
          if (Number.isFinite(currentPrice) && currentPrice > 0) {
            const side = pos.side?.toLowerCase();
            if (side === "long") {
              // For longs: track highest price reached
              if (!Number.isFinite(pos.highWaterMark) || currentPrice > pos.highWaterMark) {
                pos.highWaterMark = currentPrice;
              }
            } else if (side === "short") {
              // For shorts: track lowest price reached
              if (!Number.isFinite(pos.lowWaterMark) || currentPrice < pos.lowWaterMark) {
                pos.lowWaterMark = currentPrice;
              }
            }
          }

          const closeResult = strategy.shouldClose(pos, priceData.price);
          if (closeResult) {
            // Extract detailed exit reason from strategy
            const exitReason = closeResult.reason || "strategy_exit";
            const exitDetails = {
              reason: exitReason,
              rsi: closeResult.rsi,
              pnlPct: closeResult.pnlPct,
              takeProfit: closeResult.takeProfit,
              stopLoss: closeResult.stopLoss,
              hardStop: closeResult.hardStop,
              timeOut: closeResult.timeOut,
              barsHeld: closeResult.barsHeld,
              stopPrice: closeResult.stopPrice,
            };
            console.log(
              `[STRATEGY_EXIT] Position ${pos.positionId?.slice(0, 12)}... exit triggered:`,
              JSON.stringify(exitDetails, (k, v) => (v === undefined ? undefined : v))
            );
            if (
              pos.strategyType === "copy-trading" &&
              exitReason.startsWith("copy_") &&
              this.tg &&
              this.tg.enabled
            ) {
              const details = `${posMarket} ${pos.side} ${exitReason} price=$${priceData.price.toFixed(4)} entry=$${pos.entryPrice.toFixed(4)}`;
              this.tg.alertRiskViolation("copy_trading_exit", details).catch(() => {});
              console.log(`[COPY_RISK] ${details}`);
            }

            try {
              await this.closePosition(pos, priceData.price, exitReason);
            } catch (error) {
              console.error(
                `[STRATEGY_EXIT] Failed to close position ${pos.positionId}:`,
                error.message
              );
              // Don't throw - continue with other positions even if this one fails
              errorHandler.log(error, {
                category: Category.TRANSACTION,
                severity: error.message?.includes("KILL SWITCH")
                  ? Severity.CRITICAL
                  : Severity.HIGH,
                context: {
                  action: "closePosition",
                  positionId: pos.positionId,
                  reason: exitReason,
                  exitDetails,
                },
              });
            }
          }
        }
      }

      // Periodic cleanup: Remove any duplicate positions that might have slipped through
      // Only run this check occasionally to avoid performance impact (every 100 ticks)
      if (this._ticks % 100 === 0) {
        const duplicatesRemoved = this._removeDuplicatePositions();
        if (duplicatesRemoved > 0) {
          console.warn(
            `⚠️  Removed ${duplicatesRemoved} duplicate position(s) during periodic cleanup`
          );
          errorHandler.log(new Error(`Duplicate positions detected and removed`), {
            category: Category.VALIDATION,
            severity: Severity.MEDIUM,
            context: { duplicatesRemoved, tick: this._ticks },
          });
        }
      }

      // Periodic position sync: Sync with on-chain to detect manually opened positions
      // Run every 5 minutes to avoid rate limits (calculate ticks based on LOOP_MS)
      const syncIntervalTicks = Math.max(1, Math.floor(300_000 / LOOP_MS)); // 5 minutes = 300,000ms
      if (this._ticks % syncIntervalTicks === 0 && this._ticks > 0) {
        await this._syncPositionsFromChain();
      }

      // Check exits - risk management (stop loss, take profit)
      // Always runs (both with and without USE_RISK_TP)
      if (
        process.env.DEBUG_STOP_LOSS === "true" ||
        this.openPositions.some(
          (p) => p.positionId === "6aY2pS1MY81NdvY5qqjLRbXWk2aVXCLJfNF7ArjNJu7B"
        )
      ) {
        console.log(
          `[STOP_LOSS_DEBUG] Checking ${this.openPositions.length} open positions:`,
          this.openPositions.map((p) => ({
            id: p.positionId?.slice(0, 8),
            market: p.market,
            side: p.side,
            entry: p.entryPrice,
            leverage: p.leverage,
            size: p.size,
            collateral: p.collateral,
          }))
        );
      }
      for (const pos of [...this.openPositions]) {
        const posMarket = pos.market || MARKET;
        if (!pos.market) {
          console.error(
            `❌ CRITICAL: Position ${pos.positionId} has no market field, falling back to MARKET constant (${MARKET})`
          );
          errorHandler.log(new Error(`Position missing market field`), {
            category: Category.VALIDATION,
            severity: Severity.HIGH,
            context: { positionId: pos.positionId, fallbackMarket: MARKET },
          });
        }

        // CRITICAL FIX: Recalculate leverage if it's 0 or invalid
        const originalLeverage = pos.leverage;
        if (!pos.leverage || pos.leverage <= 0) {
          const sizeUsd = Number(pos.size || 0);
          const collateralUsd = Number(pos.collateral || 0);
          if (sizeUsd > 0 && collateralUsd > 0) {
            const calculatedLeverage = sizeUsd / collateralUsd;
            pos.leverage = calculatedLeverage;
            console.warn(
              `⚠️  Fixed leverage for position ${pos.positionId?.slice(0, 8)}...: was ${originalLeverage || 0}, now ${calculatedLeverage.toFixed(2)} (calculated from size=${sizeUsd}, collateral=${collateralUsd})`
            );
          } else {
            // Fallback to default leverage if we can't calculate
            pos.leverage = 1;
            console.warn(
              `⚠️  Could not calculate leverage for position ${pos.positionId?.slice(0, 8)}..., defaulting to 1. size=${sizeUsd}, collateral=${collateralUsd}`
            );
          }
        }

        const priceData = priceDataMap.get(posMarket);
        if (!priceData) {
          console.error(
            `❌ CRITICAL: No price data found for market ${posMarket} (position market: ${pos.market || "missing"})`
          );
          errorHandler.log(new Error(`Missing price data for market`), {
            category: Category.NETWORK,
            severity: Severity.MEDIUM,
            context: { positionId: pos.positionId, market: posMarket, positionMarket: pos.market },
          });
          continue;
        }

        // CRITICAL: Ensure entryPrice is set (handle both 'entry' and 'entryPrice' field names)
        if (!pos.entryPrice && pos.entry) {
          pos.entryPrice = Number(pos.entry);
          console.warn(
            `⚠️  Fixed entryPrice field for position ${pos.positionId?.slice(0, 8)}...: mapped 'entry' to 'entryPrice'`
          );
        }

        // Validate entryPrice before stop loss check - if missing, try to recover from current price
        if (!pos.entryPrice || !Number.isFinite(pos.entryPrice) || pos.entryPrice <= 0) {
          // Try to use current price as fallback for entry price (better than skipping entirely)
          const currentPrice = priceData?.price;
          if (currentPrice && Number.isFinite(currentPrice) && currentPrice > 0) {
            console.warn(
              `⚠️  Position ${pos.positionId?.slice(0, 8)}... has null entry price. Using current price $${currentPrice.toFixed(6)} as fallback.`
            );
            pos.entryPrice = currentPrice;

            // Also try to update the entry in our tracking for future iterations
            const posIndex = this.openPositions.findIndex((p) => p.positionId === pos.positionId);
            if (posIndex !== -1) {
              this.openPositions[posIndex].entryPrice = currentPrice;
            }
          } else {
            console.error(
              `❌ Invalid entryPrice for position ${pos.positionId?.slice(0, 8)}...: ${pos.entryPrice}. No current price available. Skipping stop loss check.`
            );
            continue;
          }
        }

        // Only apply TP/SL to positions opened by the bot (not manually opened positions)
        // Bot-opened positions are marked with trade_type: 'automated'
        // Manually opened positions are marked with trade_type: 'manual'
        // If trade_type is not set, check database to determine

        let tradeType = pos.trade_type;
        if (!tradeType) {
          // Check database for trade_type
          try {
            const dbPositions = db.listOpen();
            const dbPos = dbPositions.find((p) => p.id === pos.positionId);
            if (dbPos) {
              tradeType = dbPos.trade_type;
            }
          } catch (e) {
            // Ignore DB errors
          }
        }

        // CRITICAL FIX: Check clientOrderId pattern as fallback for bot-opened positions
        // Bot-opened positions have 48-char hex hash clientOrderId
        const hasBotClientOrderId = pos.clientOrderId && /^[a-f0-9]{48}$/i.test(pos.clientOrderId);

        // If position has bot clientOrderId but trade_type is missing/wrong, treat as automated
        if (hasBotClientOrderId && (!tradeType || tradeType === "manual")) {
          tradeType = "automated";
          // Fix in-memory position
          pos.trade_type = "automated";
          if (pos.mode === "manual") delete pos.mode;
          console.log(
            `🔧 [EXIT_CHECK] Fixed trade_type for position ${pos.positionId?.slice(0, 8)}... (detected bot clientOrderId)`
          );
        }

        // Additional checks for manual positions (check these FIRST to be safe):
        // - Explicitly marked as manual
        // - Has clientOrderId starting with "manual-"
        // - Has mode === 'manual' (backwards compatibility)
        // - Has clientOrderId matching synced manual format (timestamp_positionId) AND confirmed manual in DB
        const isManual =
          tradeType === "manual" ||
          pos.mode === "manual" ||
          (pos.clientOrderId && pos.clientOrderId.startsWith("manual-")) ||
          (pos.clientOrderId && pos.clientOrderId.match(/^\d+_/) && tradeType === "manual");

        // Only apply TP/SL if position was explicitly opened by bot (trade_type === 'automated')
        // Skip if manual, unknown, or not set (safer to skip than apply incorrectly)
        const isBotOpened =
          tradeType === "automated" || tradeType === "auto" || hasBotClientOrderId; // Support both for backwards compatibility

        // Debug logging for position type detection
        const isTargetPosition = pos.positionId === "6aY2pS1MY81NdvY5qqjLRbXWk2aVXCLJfNF7ArjNJu7B";
        if (isTargetPosition || process.env.DEBUG_STOP_LOSS === "true") {
          console.log(
            `[STOP_LOSS_DEBUG] Position ${pos.positionId?.slice(0, 8)}... type check: trade_type=${tradeType || "not set"}, mode=${pos.mode || "not set"}, clientOrderId=${pos.clientOrderId}, isBotOpened=${isBotOpened}, isManual=${isManual}`
          );
        }

        // CRITICAL: Skip TPSL if position is manual OR if we can't confirm it's bot-opened
        // This ensures manually opened positions are NEVER closed by automated TPSL
        if (isManual || !isBotOpened) {
          // Skip all automated risk management (TP/SL, time-based exit, funding exit) for non-bot positions
          if (isTargetPosition || process.env.DEBUG_STOP_LOSS === "true") {
            console.warn(
              `⚠️  [STOP_LOSS_DEBUG] Position ${pos.positionId?.slice(0, 8)}... is NOT bot-opened (trade_type=${tradeType || "not set"}, isManual=${isManual}) - skipping stop loss check`
            );
          }
          continue;
        }

        // Allocator-driven ATR hard stop (RSI only; price-distance stop)
        // Independent from percent stop-loss; whichever triggers first closes the position.
        if (pos.strategyType === "rsi-reversion" || pos.strategyType === "rsi-reversion-alt") {
          const atrAtEntry = Number(pos.atrAtEntry);
          const atrMult = Number(pos.hardStopAtrMultOverride);
          const entryPrice = Number(pos.entryPrice);
          const currentPrice = Number(priceData.price);
          if (
            Number.isFinite(atrAtEntry) &&
            atrAtEntry > 0 &&
            Number.isFinite(atrMult) &&
            atrMult > 0 &&
            Number.isFinite(entryPrice) &&
            entryPrice > 0 &&
            Number.isFinite(currentPrice) &&
            currentPrice > 0
          ) {
            const atrDist = atrAtEntry * atrMult;
            const sideLower = String(pos.side || "").toLowerCase();
            const adverseMove =
              sideLower === "short" ? currentPrice - entryPrice : entryPrice - currentPrice;
            if (Number.isFinite(adverseMove) && adverseMove >= atrDist) {
              if (
                process.env.DEBUG_ALLOCATOR_RISK === "true" ||
                process.env.DEBUG_STOP_LOSS === "true"
              ) {
                console.warn("[ATR_STOP] Triggering ATR hard stop", {
                  market: pos.market || posMarket,
                  side: pos.side,
                  entryPrice,
                  currentPrice,
                  atrAtEntry,
                  atrMult,
                  atrDist,
                  adverseMove,
                });
              }
              try {
                await this.closePosition(pos, currentPrice, "rsi_hard_stop_atr");
              } catch (error) {
                console.error(
                  `[ATR_STOP] Failed to close position ${pos.positionId}:`,
                  error.message
                );
                errorHandler.log(error, {
                  category: Category.TRANSACTION,
                  severity: error.message?.includes("KILL SWITCH")
                    ? Severity.CRITICAL
                    : Severity.HIGH,
                  context: {
                    action: "closePosition",
                    positionId: pos.positionId,
                    reason: "rsi_hard_stop_atr",
                  },
                });
              }
              continue;
            }
          }
        }

        // Use bot's calculatePnL for stop loss checks (current cached prices)
        const stopLoss = this.riskManager.shouldStopLoss(pos, priceData.price, this);
        // Debug logging for stop loss checks - always log for the specific position or when DEBUG_STOP_LOSS is enabled
        if (isTargetPosition || process.env.DEBUG_STOP_LOSS === "true") {
          // calculatePnL returns a number (leverage-adjusted %)
          const pnlPercent = this.calculatePnL(pos, priceData.price) ?? 0;
          const riskConfig = this.riskManager.getRiskConfigForMarket(pos.market || posMarket);
          // For SHORT positions, calculate expected stop loss price
          let expectedStopPrice = null;
          if (pos.side === "SHORT" && pos.entryPrice && riskConfig.stopLossPercent) {
            // For SHORT: stop loss triggers when price goes UP
            // PnL% = -((current - entry) / entry) * leverage * 100
            // When PnL% = -stopLossPercent:
            // -stopLossPercent = -((current - entry) / entry) * leverage * 100
            // stopLossPercent = ((current - entry) / entry) * leverage * 100
            // stopLossPercent / (leverage * 100) = (current - entry) / entry
            // current = entry * (1 + stopLossPercent / (leverage * 100))
            expectedStopPrice =
              pos.entryPrice * (1 + riskConfig.stopLossPercent / (pos.leverage * 100));
          } else if (pos.side === "LONG" && pos.entryPrice && riskConfig.stopLossPercent) {
            // For LONG: stop loss triggers when price goes DOWN
            expectedStopPrice =
              pos.entryPrice * (1 - riskConfig.stopLossPercent / (pos.leverage * 100));
          }
          console.log(
            `[STOP_LOSS_DEBUG] Position ${pos.positionId?.slice(0, 8)}...: PnL=${pnlPercent.toFixed(2)}%, SL=${riskConfig.stopLossPercent}%, should=${stopLoss.should}, entry=${pos.entryPrice}, current=${priceData.price}, expectedStopPrice=${expectedStopPrice?.toFixed(4) || "N/A"}, side=${pos.side}, leverage=${pos.leverage}, market=${posMarket}`
          );
        }
        if (stopLoss.should) {
          // calculatePnL returns a number (leverage-adjusted %)
          const stopPnlPercent = this.calculatePnL(pos, priceData.price) ?? 0;
          console.log(
            `[STOP_LOSS] Triggering close for position ${pos.positionId}, reason: ${stopLoss.reason}, PnL: ${stopPnlPercent.toFixed(2)}%`
          );
          if (pos.strategyType === "copy-trading" && this.tg && this.tg.enabled) {
            const details = `${posMarket} ${pos.side} ${stopLoss.reason} price=$${priceData.price.toFixed(4)} entry=$${pos.entryPrice.toFixed(4)} pnl=${stopPnlPercent.toFixed(2)}%`;
            this.tg.alertRiskViolation("copy_trading_stop_loss", details).catch(() => {});
            console.log(`[COPY_RISK] ${details}`);
          }
          try {
            await this.closePosition(pos, priceData.price, stopLoss.reason);
          } catch (error) {
            console.error(`[STOP_LOSS] Failed to close position ${pos.positionId}:`, error.message);
            // Don't throw - continue with other positions even if this one fails
            errorHandler.log(error, {
              category: Category.TRANSACTION,
              severity: error.message?.includes("KILL SWITCH") ? Severity.CRITICAL : Severity.HIGH,
              context: {
                action: "closePosition",
                positionId: pos.positionId,
                reason: stopLoss.reason,
              },
            });
          }
          continue;
        }

        const takeProfit = this.riskManager.shouldTakeProfit(
          pos,
          priceData.price,
          this.priceClient
        );
        if (takeProfit.should) {
          if (pos.strategyType === "copy-trading" && this.tg && this.tg.enabled) {
            const alertType =
              takeProfit.reason === "TRAILING_STOP"
                ? "copy_trading_trailing_stop"
                : "copy_trading_take_profit";
            const details = `${posMarket} ${pos.side} ${takeProfit.reason} price=$${priceData.price.toFixed(4)} entry=$${pos.entryPrice.toFixed(4)}`;
            this.tg.alertRiskViolation(alertType, details).catch(() => {});
            console.log(`[COPY_RISK] ${details}`);
          }
          try {
            await this.closePosition(pos, priceData.price, takeProfit.reason);
          } catch (error) {
            console.error(
              `[TAKE_PROFIT] Failed to close position ${pos.positionId}:`,
              error.message
            );
            // Don't throw - continue with other positions even if this one fails
            errorHandler.log(error, {
              category: Category.TRANSACTION,
              severity: error.message?.includes("KILL SWITCH") ? Severity.CRITICAL : Severity.HIGH,
              context: {
                action: "closePosition",
                positionId: pos.positionId,
                reason: takeProfit.reason,
              },
            });
          }
          continue;
        }

        // Time-based exit - skip for recovered positions (openTime may be inaccurate)
        // All other risk management (stop loss, take profit, liquidation) still applies
        if (!this._recoveredPositionIds.has(pos.positionId)) {
          const timeExit = this.riskManager.shouldTimeExit(pos);
          if (timeExit.should) {
            if (pos.strategyType === "copy-trading" && this.tg && this.tg.enabled) {
              const details = `${posMarket} ${pos.side} TIME_EXIT hours=${timeExit.hoursOpen?.toFixed(2) || "n/a"} entry=$${pos.entryPrice.toFixed(4)} price=$${priceData.price.toFixed(4)}`;
              this.tg.alertRiskViolation("copy_trading_time_exit", details).catch(() => {});
              console.log(`[COPY_RISK] ${details}`);
            }
            try {
              await this.closePosition(pos, priceData.price, timeExit.reason);
            } catch (error) {
              console.error(
                `[TIME_EXIT] Failed to close position ${pos.positionId}:`,
                error.message
              );
              // Don't throw - continue with other positions even if this one fails
              errorHandler.log(error, {
                category: Category.TRANSACTION,
                severity: error.message?.includes("KILL SWITCH")
                  ? Severity.CRITICAL
                  : Severity.HIGH,
                context: {
                  action: "closePosition",
                  positionId: pos.positionId,
                  reason: timeExit.reason,
                },
              });
            }
            continue;
          }
        }

        // Funding rate check disabled to avoid geo-restricted Binance API
        // Optional: Enable with ENABLE_FUNDING_RATE_FETCH=true
        if (process.env.ENABLE_FUNDING_RATE_FETCH === "true") {
          try {
            const fundingCheck = await this.fundingMonitor.checkFundingRate(
              pos,
              this.riskManager.config.maxFundingRatePercent
            );
            if (fundingCheck.shouldExit && !fundingCheck.error) {
              const result = await this.riskManager.shouldExitFunding(pos, fundingCheck.rate);
              if (result.should) {
                if (pos.strategyType === "copy-trading" && this.tg && this.tg.enabled) {
                  const details = `${posMarket} ${pos.side} ${result.reason} rate=${(result.rate ?? fundingCheck.rate)?.toFixed(4) || "n/a"}`;
                  this.tg.alertRiskViolation("copy_trading_funding_exit", details).catch(() => {});
                  console.log(`[COPY_RISK] ${details}`);
                }
                try {
                  await this.closePosition(pos, priceData.price, result.reason);
                } catch (error) {
                  console.error(
                    `[FUNDING_EXIT] Failed to close position ${pos.positionId}:`,
                    error.message
                  );
                  // Don't throw - continue with other positions even if this one fails
                  errorHandler.log(error, {
                    category: Category.TRANSACTION,
                    severity: error.message?.includes("KILL SWITCH")
                      ? Severity.CRITICAL
                      : Severity.HIGH,
                    context: {
                      action: "closePosition",
                      positionId: pos.positionId,
                      reason: result.reason,
                    },
                  });
                }
                continue;
              }
            }
          } catch (e) {
            errorHandler.log(e, {
              category: Category.NETWORK,
              severity: Severity.LOW,
              context: { action: "checkFundingRate", positionId: pos.positionId },
            });
          }
        }
      }

      // Use market allocator to evaluate and select best opportunities
      // CRITICAL FIX: Check per-venue capital, not combined
      // A signal should proceed if ITS venue has capital (e.g., JTO on Drift should work even if Jupiter is full)
      const venueRouter = require("./utils/venue-router");
      const jupiterCapital = this.getAvailableCapital("jupiter");
      const driftCapital = this.getAvailableCapital("drift");
      const copyCapital = this.getAvailableCapital({
        market: MARKET,
        strategyType: "copy-trading",
      });

      // Filter signals to only those with available capital in their venue
      const signalsWithCapital = allMarketSignals.filter((sig) => {
        const sigStrategyType = sig.strategyType || sig.signal?.strategyType;
        if (this._isCopyStrategy(sigStrategyType)) {
          return copyCapital > 0;
        }
        const venue = venueRouter.getVenueForMarket(sig.market);
        const venueCapital = venue === "drift" ? driftCapital : jupiterCapital;
        return venueCapital > 0;
      });

      loopPulse.jupiterCapital = jupiterCapital;
      loopPulse.driftCapital = driftCapital;
      loopPulse.copyCapital = copyCapital;

      if (signalsWithCapital.length > 0) {
        const rankedOpportunities = this.marketAllocator.evaluateOpportunities(
          signalsWithCapital, // CRITICAL: Only evaluate signals with venue capital
          this.openPositions,
          portfolioMetrics,
          this.marketPerformance
        );
        loopPulse.signals.ranked = rankedOpportunities.length;

        const currentMaxPositions = MAX_POSITIONS;
        const selectedOpportunities = this.marketAllocator.selectBestOpportunities(
          rankedOpportunities,
          currentMaxPositions,
          this.openPositions
        );
        loopPulse.signals.selected = selectedOpportunities.length;
        const availableSlots = Math.max(0, currentMaxPositions - this.openPositions.length);
        if (availableSlots <= 0) {
          loopPulse.notes.push("max_positions");
        }

        // Log allocator decisions for monitoring (always log when signals exist)
        {
          const positionsByMarket = {};
          for (const pos of this.openPositions) {
            const market = pos.market || MARKET;
            positionsByMarket[market] = (positionsByMarket[market] || 0) + 1;
          }

          pretty("allocator", {
            signals: allMarketSignals.length,
            ranked: rankedOpportunities.length,
            selected: selectedOpportunities.length,
            positions: this.openPositions.length,
            positionsByMarket,
            maxPositions: currentMaxPositions,
            signalsByMarket: allMarketSignals.map((s) => s.market),
            selectedMarkets: selectedOpportunities.map((o) => o.market),
          });

          // Log rejection reasons for signals that weren't selected
          // NOTE: Skip 'close' signals - they're intentionally skipped by allocator, not rejected
          if (allMarketSignals.length > 0) {
            const selectedKeys = new Set(
              selectedOpportunities.map((o) => `${o.market}:${o.signal.side}`)
            );
            const rejectedSignals = allMarketSignals.filter((s) => {
              const key = `${s.market}:${s.signal.side}`;
              // Don't count 'close' signals as rejected - they're intentionally skipped
              if (s.signal.action === "close" || s.signal.action === "partial_close") {
                return false;
              }
              return !selectedKeys.has(key);
            });

            // Determine rejection reason for each signal
            for (const signalData of rejectedSignals) {
              const { market, signal } = signalData;
              let rejectionReason = "Not selected by allocator";
              let rejectionDetails = null;

              // Check if it was ranked but not selected
              const wasRanked = rankedOpportunities.some(
                (o) => o.market === market && o.signal.side === signal.side
              );
              if (!wasRanked) {
                // Check why it wasn't ranked
                const positionsInMarket = this.openPositions.filter(
                  (p) => p.market === market
                ).length;
                if (
                  positionsInMarket >= (this.marketAllocator?.config?.maxPositionsPerMarket || 1)
                ) {
                  rejectionReason = `Max positions per market (${positionsInMarket})`;
                } else {
                  rejectionReason = "Score too low or failed evaluation";
                  // Get detailed diagnostics from allocator
                  const diagnostics = this.marketAllocator?.getRejectionDiagnostics(
                    market,
                    signal.side
                  );
                  if (diagnostics) {
                    rejectionDetails = {
                      finalScore: diagnostics.finalScore,
                      minScore: diagnostics.minScore,
                      confidenceScore: diagnostics.confidenceScore,
                      minConfidence: diagnostics.minConfidence,
                      reason: diagnostics.reason,
                      components: diagnostics.components,
                      adjustments: diagnostics.adjustments,
                    };
                    // Enhance rejection reason with specific failure
                    rejectionReason = `${rejectionReason}: ${diagnostics.reason}`;
                  }
                }
              } else if (availableSlots <= 0) {
                rejectionReason = `Max positions reached (${this.openPositions.length}/${currentMaxPositions})`;
              } else {
                rejectionReason = "Lower priority than selected signals";
              }

              const rankedOpp = rankedOpportunities.find(
                (o) => o.market === market && o.signal.side === signal.side
              );
              pretty("signal_rejected", {
                market,
                side: signal.side,
                price: signalData.priceData?.price,
                confidence: signal.confidence,
                reason: rejectionReason,
                score: rankedOpp?.score,
                diagnostics: rejectionDetails,
              });

              // Persist allocator decision (rejection)
              try {
                const strat = this.strategies.get(market);
                const ranked = rankedOpportunities.find(
                  (o) => o.market === market && o.signal.side === signal.side
                );
                db.logAllocatorDecision({
                  ts: tickTimestamp,
                  market,
                  side: signal.side,
                  confidence: signal.confidence,
                  score: ranked?.score,
                  selected: false,
                  reason: rejectionReason,
                  price: signalData.priceData?.price,
                  adx: strat?.adx,
                  atr: strat?.atr,
                  rsi: strat?.rsi,
                  positions_in_market: this.openPositions.filter(
                    (p) => (p.market || MARKET) === market
                  ).length,
                  max_positions: currentMaxPositions,
                  available_slots: availableSlots,
                  portfolio_exposure: portfolioMetrics?.totalExposure,
                  signals_count: allMarketSignals.length,
                  // Include rejection diagnostics if available
                  rejection_diagnostics: rejectionDetails ? JSON.stringify(rejectionDetails) : null,
                });
              } catch {}
            }

            // Clear rejection diagnostics cache after processing (prevent memory leak)
            if (this.marketAllocator) {
              this.marketAllocator.clearRejectionDiagnostics();
            }
          }
        }

        if (allMarketSignals.length > 0 && selectedOpportunities.length === 0) {
          loopPulse.notes.push("allocator_filtered");
        }

        // Allocator-driven risk (batch): compute multipliers once so when multiple markets
        // are selected on the same bar, the inferior pick is de-risked.
        let allocatorRiskMults = null;
        try {
          if (
            this.marketAllocator &&
            typeof this.marketAllocator.recommendRiskMultipliersBatch === "function" &&
            (this.marketAllocator?.riskRecommendation?.enabled === true ||
              this.marketAllocator?.riskRecommendation?.ichimoku?.enabled === true) &&
            selectedOpportunities.length > 0
          ) {
            const batch = selectedOpportunities
              .map((opp) => {
                const market = opp.market;
                const side = String(opp.signal?.side || "").toLowerCase();
                const strategyType = opp.signal?.strategyType || opp.strategyType || "momentum";
                // Best-effort ATR passthrough (Ichimoku prefers signal.indicators anyway).
                const strat = this.strategies.get(market);
                const atr = Array.isArray(strat)
                  ? null
                  : Number.isFinite(strat?.atr)
                    ? strat.atr
                    : null;
                return {
                  market,
                  signal: opp.signal,
                  priceData: { ...(opp.priceData || {}), atr },
                  score: opp.score ?? 0,
                  strategyType,
                };
              })
              .filter((x) => x.market && x.signal && x.signal.action === "open" && x.signal.side);
            allocatorRiskMults = this.marketAllocator.recommendRiskMultipliersBatch(batch);
          }
        } catch (e) {
          if (process.env.DEBUG_ALLOCATOR_RISK === "true") {
            console.warn("[ALLOCATOR_RISK] recommendRiskMultipliersBatch failed (ignored):", e);
          }
          allocatorRiskMults = null;
        }

        // Execute selected opportunities
        for (const opp of selectedOpportunities) {
          const { market, signal, priceData: enrichedData, score } = opp;
          const price = enrichedData.price;

          // Check if longs/shorts are disabled (per-strategy, per-market, or global)
          const execMarketAllowSettings = this.perMarketAllowSettings?.get(market);
          const strategyType = signal.strategyType || opp.strategyType || "momentum";

          // Per-strategy direction controls (e.g., MOMENTUM_ALLOW_LONGS, RSI_ALLOW_LONGS)
          // Falls back to global ALLOW_LONGS if strategy-specific not set
          let execLongsAllowed, execShortsAllowed;

          if (strategyType === "rsi-reversion" || strategyType === "rsi-reversion-alt") {
            // RSI-reversion specific: RSI_ALLOW_LONGS, RSI_ALLOW_SHORTS
            const rsiAllowLongs =
              process.env.RSI_ALLOW_LONGS !== undefined
                ? process.env.RSI_ALLOW_LONGS !== "false"
                : process.env.ALLOW_LONGS !== "false";
            const rsiAllowShorts =
              process.env.RSI_ALLOW_SHORTS !== undefined
                ? process.env.RSI_ALLOW_SHORTS !== "false"
                : process.env.ALLOW_SHORTS !== "false";
            execLongsAllowed = execMarketAllowSettings?.allowLongs !== false && rsiAllowLongs;
            execShortsAllowed = execMarketAllowSettings?.allowShorts !== false && rsiAllowShorts;
          } else if (strategyType === "btc-breakout") {
            const breakoutAllowLongs = strategyEnvManager?.getMarketConfigBool
              ? strategyEnvManager.getMarketConfigBool(
                  market,
                  "ALLOW_LONGS",
                  process.env.ALLOW_LONGS !== "false",
                  strategyType
                )
              : process.env.ALLOW_LONGS !== "false";
            const breakoutAllowShorts = strategyEnvManager?.getMarketConfigBool
              ? strategyEnvManager.getMarketConfigBool(
                  market,
                  "ALLOW_SHORTS",
                  process.env.ALLOW_SHORTS !== "false",
                  strategyType
                )
              : process.env.ALLOW_SHORTS !== "false";
            execLongsAllowed =
              execMarketAllowSettings?.allowLongs !== false && breakoutAllowLongs;
            execShortsAllowed =
              execMarketAllowSettings?.allowShorts !== false && breakoutAllowShorts;
          } else if (strategyType === "momentum") {
            // Momentum specific: MOMENTUM_ALLOW_LONGS, MOMENTUM_ALLOW_SHORTS
            const momentumAllowLongs =
              process.env.MOMENTUM_ALLOW_LONGS !== undefined
                ? process.env.MOMENTUM_ALLOW_LONGS !== "false"
                : process.env.ALLOW_LONGS !== "false";
            const momentumAllowShorts =
              process.env.MOMENTUM_ALLOW_SHORTS !== undefined
                ? process.env.MOMENTUM_ALLOW_SHORTS !== "false"
                : process.env.ALLOW_SHORTS !== "false";
            execLongsAllowed = execMarketAllowSettings?.allowLongs !== false && momentumAllowLongs;
            execShortsAllowed =
              execMarketAllowSettings?.allowShorts !== false && momentumAllowShorts;
          } else {
            // Default: use global settings
            const execGlobalAllowLongs = process.env.ALLOW_LONGS !== "false";
            const execGlobalAllowShorts = process.env.ALLOW_SHORTS !== "false";
            execLongsAllowed =
              execMarketAllowSettings?.allowLongs !== false && execGlobalAllowLongs;
            execShortsAllowed =
              execMarketAllowSettings?.allowShorts !== false && execGlobalAllowShorts;
          }

          const sideLower = signal.side?.toLowerCase();

          if (signal.action === "open") {
            if (!execLongsAllowed && sideLower === "long") {
              pretty("signal_blocked", {
                market,
                side: signal.side,
                price,
                reason: `Longs disabled for ${strategyType}`,
                confidence: signal.confidence,
                strategyType,
              });
              loopPulse.signals.blocked++;
              loopPulse.notes.push(`blocked:${strategyType}_long_disabled`);
              continue; // Skip this opportunity
            }
            if (!execShortsAllowed && sideLower === "short") {
              pretty("signal_blocked", {
                market,
                side: signal.side,
                price,
                reason: `Shorts disabled for ${strategyType}`,
                confidence: signal.confidence,
                strategyType,
              });
              loopPulse.signals.blocked++;
              loopPulse.notes.push(`blocked:${strategyType}_short_disabled`);
              continue; // Skip this opportunity
            }
          }

          // Persist allocator decision (selection)
          try {
            const strat = this.strategies.get(market);
            db.logAllocatorDecision({
              ts: tickTimestamp,
              market,
              side: signal.side,
              confidence: signal.confidence,
              score: score,
              selected: true,
              reason: "selected",
              price,
              adx: strat?.adx,
              atr: strat?.atr,
              rsi: strat?.rsi,
              positions_in_market: this.openPositions.filter((p) => (p.market || MARKET) === market)
                .length,
              max_positions: currentMaxPositions,
              available_slots: Math.max(0, currentMaxPositions - this.openPositions.length),
              portfolio_exposure: portfolioMetrics?.totalExposure,
              signals_count: allMarketSignals.length,
            });
          } catch {}

          // Handle pyramiding
          if (signal.action === "pyramid") {
            const existingPos = this.openPositions.find(
              (p) =>
                p.market === market &&
                p.side?.toLowerCase() === signal.side?.toLowerCase() &&
                !p.exitTime
            );
            if (existingPos && !existingPos.pyramidAdded && config.strategy.pyramidEnable) {
              const pyramidAddPct = config.strategy.pyramidAddPct ?? 50;

              pretty("pyramid", {
                market,
                side: signal.side,
                price,
                existingSize: existingPos.size,
                reason: signal.reason,
              });

              const clientOrderId = this._clientOrderId({
                market,
                side: signal.side,
                timestamp: tickTimestamp,
                signal,
              });

              const beforePositions = this.openPositions.length;
              try {
                await this.openPosition(signal.side.toUpperCase(), price, market, {
                  clientOrderId,
                  signal,
                  tickTimestamp,
                  isPyramid: true,
                  parentPosition: existingPos,
                });
                const afterPositions = this.openPositions.length;
                const pyramidApplied = existingPos && existingPos.pyramidAdded;
                if (afterPositions > beforePositions || pyramidApplied) {
                  loopPulse.signals.executed++;
                } else {
                  loopPulse.signals.blocked++;
                  loopPulse.notes.push(`open_skipped:${market}`);
                }
                loopPulse.positions = this.openPositions.length;
              } catch (err) {
                // CRITICAL: Log detailed error information for pyramid positions
                const errorContext = {
                  market,
                  side: signal.side,
                  price,
                  clientOrderId,
                  isPyramid: true,
                  parentPositionId: existingPos?.positionId,
                  confidence: signal.confidence,
                  reason: signal.reason,
                  errorMessage: err.message,
                  errorStack: err.stack,
                  attempts: err.attempts || 1,
                  cause: err.cause?.message || null,
                };

                console.error(
                  `❌ [AUTO_POSITION_OPEN] Failed to pyramid position:`,
                  JSON.stringify(errorContext, null, 2)
                );

                // Log to error handler with full context
                await errorHandler.handle(err, {
                  category: Category.TRANSACTION,
                  severity: Severity.HIGH,
                  context: {
                    action: "auto_pyramidPosition",
                    market,
                    side: signal.side,
                    price,
                    clientOrderId,
                    isPyramid: true,
                    parentPositionId: existingPos?.positionId,
                    signal: {
                      confidence: signal.confidence,
                      reason: signal.reason,
                    },
                    attempts: err.attempts || 1,
                    cause: err.cause?.message || null,
                  },
                });

                loopPulse.errors.push(err.message || "pyramidPosition_failed");
                // Don't re-throw - let the signal loop continue processing other markets
                // The error has been logged and will be visible in loopPulse.errors
              }
            }
          } else if (signal.action === "open") {
            // Validate price before emitting signal
            if (!Number.isFinite(price) || price <= 0) {
              pretty("signal_blocked", {
                market,
                side: signal.side,
                price,
                reason: `Invalid price: ${price}`,
                confidence: signal.confidence,
              });
              loopPulse.signals.blocked++;
              loopPulse.notes.push("blocked:invalid_price");
              errorHandler.log(new Error(`Invalid price in signal: ${price}`), {
                category: Category.DATA,
                severity: Severity.HIGH,
                context: { market, side: signal.side, price },
              });
              continue; // Skip this signal
            }

            // Additional sanity check: validate price is in reasonable range for the market
            const baseSymbol = market.split("-")[0];
            const knownPriceRanges = {
              SOL: { min: 10, max: 1000 },
              BTC: { min: 10000, max: 200000 },
              ETH: { min: 500, max: 15000 },
            };

            if (knownPriceRanges[baseSymbol]) {
              const range = knownPriceRanges[baseSymbol];
              if (price < range.min || price > range.max) {
                errorHandler.log(
                  new Error(
                    `Price ${price.toFixed(4)} for ${market} is outside expected range [${range.min}, ${range.max}]`
                  ),
                  {
                    category: Category.DATA,
                    severity: Severity.HIGH,
                    context: { market, side: signal.side, price, expectedRange: range },
                  }
                );
                // Log warning but continue - might be valid in extreme market conditions
                console.warn(
                  `⚠️  Price $${price.toFixed(4)} for ${market} is outside expected range [${range.min}, ${range.max}]`
                );
              }
            }

            // Log signal details
            const signalDetails = {
              market,
              side: signal.side,
              price,
              confidence: signal.confidence,
              sizeFraction:
                Number.isFinite(Number(signal.sizeFraction)) && Number(signal.sizeFraction) > 0
                  ? Number(signal.sizeFraction)
                  : undefined,
              reason: signal.reason,
              strategyType: signal.strategyType || opp.strategyType || "unknown",
              score:
                typeof score === "number" && Number.isFinite(score) ? score.toFixed(2) : undefined,
            };

            // Add enhanced strategy metrics if available
            const strategy = this.strategies.get(market);
            if (USE_ENHANCED_STRATEGY && strategy) {
              if (Number.isFinite(strategy.adx)) {
                signalDetails.adx = Number(strategy.adx).toFixed(2);
              }
              if (Number.isFinite(strategy.atr)) {
                signalDetails.atr = Number(strategy.atr).toFixed(4);
              }
              if (Number.isFinite(strategy.donchianHigh)) {
                signalDetails.donchianHigh = Number(strategy.donchianHigh).toFixed(4);
              }
              if (Number.isFinite(strategy.donchianLow)) {
                signalDetails.donchianLow = Number(strategy.donchianLow).toFixed(4);
              }
              if (strategy.volumeSpike !== undefined) {
                signalDetails.volumeSpike = strategy.volumeSpike;
              }
            }

            // Log signal only when it's about to be executed (not just generated)
            pretty("signal", signalDetails);

            const clientOrderId = this._clientOrderId({
              market,
              side: signal.side,
              timestamp: tickTimestamp,
              signal,
            });

            const beforePositions = this.openPositions.length;
            try {
              const allocatorRiskMult = allocatorRiskMults
                ? allocatorRiskMults.get(`${market}:${String(signal.side || "").toLowerCase()}`)
                : null;
              await this.openPosition(signal.side.toUpperCase(), price, market, {
                clientOrderId,
                signal,
                tickTimestamp,
                allocatorScore: score,
                priceData: enrichedData,
                allocatorRiskMult,
              });
              const afterPositions = this.openPositions.length;
              if (afterPositions > beforePositions) {
                loopPulse.signals.executed++;
              } else {
                loopPulse.signals.blocked++;
                loopPulse.notes.push(`open_skipped:${market}`);
              }
              loopPulse.positions = this.openPositions.length;
            } catch (err) {
              // CRITICAL: Log detailed error information to prevent silent failures
              const errorContext = {
                market,
                side: signal.side,
                price,
                clientOrderId,
                confidence: signal.confidence,
                reason: signal.reason,
                errorMessage: err.message,
                errorStack: err.stack,
                attempts: err.attempts || 1,
                cause: err.cause?.message || null,
              };

              console.error(
                `❌ [AUTO_POSITION_OPEN] Failed to open position:`,
                JSON.stringify(errorContext, null, 2)
              );

              // Log to error handler with full context
              await errorHandler.handle(err, {
                category: Category.TRANSACTION,
                severity: Severity.HIGH,
                context: {
                  action: "auto_openPosition",
                  market,
                  side: signal.side,
                  price,
                  clientOrderId,
                  signal: {
                    confidence: signal.confidence,
                    reason: signal.reason,
                  },
                  attempts: err.attempts || 1,
                  cause: err.cause?.message || null,
                },
              });

              loopPulse.errors.push(err.message || "openPosition_failed");
              // Don't re-throw - let the signal loop continue processing other markets
              // The error has been logged and will be visible in loopPulse.errors
            }
          }
        }
      } else if (allMarketSignals.length > 0) {
        // CRITICAL FIX: Check per-venue capital, not combined
        // A signal should only be skipped if ITS venue has no capital
        // e.g., JTO (Drift) should proceed if Drift has capital, even if Jupiter is full
        const signalsWithCapital = allMarketSignals.filter((sig) => {
          const sigStrategyType = sig.strategyType || sig.signal?.strategyType;
          const venueCapital = this.getAvailableCapital({
            market: sig.market,
            strategyType: sigStrategyType,
          });
          return venueCapital > 0;
        });

        if (signalsWithCapital.length === 0) {
          // No signals have available capital in their respective venues
          if (process.env.DEBUG_MARKET_ALLOCATOR === "true") {
            const jupiterCapital = this.getAvailableCapital("jupiter");
            const driftCapital = this.getAvailableCapital("drift");
            const copyCapital = this.getAvailableCapital({
              market: MARKET,
              strategyType: "copy-trading",
            });
            console.log(
              "[ALLOCATOR] Skipping opportunity evaluation: no available capital in any signal venue",
              {
                signals: allMarketSignals.length,
                jupiterCapital: jupiterCapital.toFixed(2),
                driftCapital: driftCapital.toFixed(2),
                copyCapital: copyCapital.toFixed(2),
                positions: this.openPositions.length,
              }
            );
          }
          loopPulse.notes.push("no_capital");
        }
      }

      // Periodic status (approx every 60s)
      if (this._ticks % Math.max(1, Math.floor(60_000 / LOOP_MS)) === 0) {
        // Build strategy summary for status
        const strategySummary = {};
        if (this.marketStrategyTypes) {
          for (const [market, types] of this.marketStrategyTypes.entries()) {
            strategySummary[market] = types.length > 1 ? types.join(" + ") : types[0];
          }
        }

        pretty("status", {
          markets: MARKETS.length,
          positions: this.openPositions.length,
          portfolio: portfolioMetrics,
          strategies: strategySummary, // Show strategy types per market
          multiStrategyMode: this.multiStrategyMode,
        });
        ui.send("status", this.statusSnapshot());
      }
    } catch (error) {
      loopPulse.errors.push(error.message || "tick_error");
      await errorHandler.handle(error, {
        category: Category.SYSTEM,
        severity: Severity.MEDIUM,
        context: { action: "tick", tick: this._ticks, markets: MARKETS.length },
      });
    } finally {
      loopPulse.positions = this.openPositions.length;
      loopPulse.durationMs = Date.now() - loopStartTime;

      // Track loop stats
      this._loopCount++;
      this._loopDurations.push(loopPulse.durationMs);
      if (this._loopDurations.length > 100) this._loopDurations.shift(); // Keep last 100
      this._avgLoopDuration =
        this._loopDurations.reduce((a, b) => a + b, 0) / this._loopDurations.length;

      if (loopPulse.price && !loopPulse.price.status) {
        loopPulse.price.status = loopPulse.price.fetched > 0 ? "ok" : "idle";
      }
      if (loopPulse.availableCapital && loopPulse.availableCapital !== 0) {
        loopPulse.availableCapital = this.getAvailableCapital();
      }
      // Attach gate evaluations if available
      if (typeof gateEvaluations !== "undefined" && gateEvaluations.length > 0) {
        loopPulse.gates = gateEvaluations;
      }
      if (LOG_FORMAT === "compact") {
        this._logCompactLoopPulse(loopPulse);
      } else {
        this._logLoopPulse(loopPulse);
      }

      // Release guards for all markets that were active
      let anyPendingReplay = false;
      for (const market of activeMarkets) {
        const pending = this._pendingTickReplay.get(market);
        this._releaseTickGuard(market);
        this._pendingTickReplay.delete(market);
        if (pending) {
          anyPendingReplay = true;
        }
      }

      // Schedule ONE replay tick if ANY market had a pending replay
      // (prevents multiple tick() calls from being scheduled simultaneously)
      if (anyPendingReplay && !this.paused) {
        setTimeout(() => this.tick(), 0);
      }
    }
  }

  async start() {
    try {
      this._startTime = Date.now();

      // Initialize venue-aware trade executor (connects Drift subprocess if enabled)
      if (this.tradeExecutor && typeof this.tradeExecutor.initialize === "function") {
        try {
          await this.tradeExecutor.initialize();
          console.log("[VenueAwareTradeExecutor] Async initialization complete");
        } catch (e) {
          console.warn(
            `[VenueAwareTradeExecutor] Init warning (Drift may be unavailable): ${e?.message || e}`
          );
        }
      }

      // Recover positions from database before starting
      // This ensures the bot tracks positions that existed before restart
      await this.recoverPositions();

      // Also sync positions from on-chain immediately to catch any positions opened while bot was down
      // This is in addition to recoverPositions() which handles positions from DB
      await this._syncPositionsFromChain();

      // Start health checks (5 minutes instead of 30 seconds to avoid rate limits)
      // Health check makes API calls to Jupiter which count against rate limits
      this._healthCheckInterval = this.healthCheck.start(300000); // Check every 5min

      // Skip health check on startup to avoid 429s during warmup
      // Health check will run after first 5-minute interval
      console.log("⏭️  Skipping startup health check to avoid rate limits during warmup");
      const health = { overall: true, rpc: { healthy: true }, api: { healthy: true } };
      if (!health.overall) {
        errorHandler.log(new Error("Health check failed on startup"), {
          category: Category.SYSTEM,
          severity: Severity.HIGH,
          context: { health },
        });
        console.warn("⚠️  Health check warnings on startup - continuing anyway");
      }

      // Start unified PriceProvider (connects to Pyth WebSocket + sets up fallback)
      console.log("[PRICE PROVIDER] Starting price provider...");
      await this.priceProvider.start();

      // Set pythWS reference for backward compatibility (strategies might use it)
      this.pythWS = this.priceProvider.pythWS;
      console.log("[PRICE PROVIDER] ✅ Started");

      // Initialize Coinbase volume WebSocket when volume fetching is enabled.
      // Without this, the market data provider may fall back to Binance REST (often geo-blocked).
      const enableVolumeFetchRaw = process.env.ENABLE_VOLUME_FETCH;
      const enableVolumeFetch =
        enableVolumeFetchRaw && String(enableVolumeFetchRaw).trim().toLowerCase() === "true";
      const volumeSourcePref = String(process.env.VOLUME_SOURCE || "auto")
        .trim()
        .toLowerCase();
      if (enableVolumeFetch && volumeSourcePref !== "binance") {
        try {
          await marketDataProvider.initializeCoinbaseWS();
        } catch (e) {
          console.warn(
            `[VOLUME] Coinbase WS init failed (VOLUME_SOURCE=${volumeSourcePref}): ${e?.message || e}`
          );
        }
      }

      await this._warmup();

      this._startCopyTrackerHealthChecks();

      // Start main trading loop (now handles all markets)
      this._tickInterval = setInterval(() => this.tick(), LOOP_MS);

      pretty("ready", { health: health.overall ? "healthy" : "degraded" });

      // Send Telegram notification for bot start
      if (this.tg && this.tg.enabled) {
        const mode = this.liveMode ? "LIVE" : "PAPER";
        const markets = MARKETS.length > 1 ? MARKETS.join(", ") : MARKETS[0];
        this.tg
          .say(
            `🚀 *Bot Started*\n` +
              `Mode: ${mode}\n` +
              `Market${MARKETS.length > 1 ? "s" : ""}: ${markets}\n` +
              `Health: ${health.overall ? "✅ Healthy" : "⚠️ Degraded"}`
          )
          .catch((err) => {
            errorHandler.log(err, {
              category: Category.SYSTEM,
              severity: Severity.LOW,
              context: { action: "telegramStartNotification" },
            });
          });
      }
    } catch (error) {
      await errorHandler.handle(error, {
        category: Category.SYSTEM,
        severity: Severity.CRITICAL,
        context: { action: "start" },
      });
      throw error;
    }
  }
}

// ---------- Boot ----------
(async () => {
  console.log("🎯 [BOOT] Starting bot initialization...");

  // Singleton lock mechanism - prevent multiple instances
  // Use database-based lock for Render (works across containers) or file-based for local
  const isRender = process.env.RENDER === "true" || process.env.IS_RENDER === "true";
  const currentPid = process.pid;
  const instanceId =
    process.env.BOT_INSTANCE_ID ||
    `${isRender ? "render" : "local"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let heartbeatInterval = null;

  async function acquireLock() {
    if (isRender) {
      // Database-based lock for Render (works across containers)
      // On Render, old instance gets SIGTERM and releases lock quickly (~1-2s)
      // We retry a few times to wait for old instance to release lock during deployment
      const maxRetries = 3;
      const retryDelay = 2000; // 2 seconds between retries
      let lockAcquired = false;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          lockAcquired = db.acquireInstanceLock(instanceId, currentPid, "render", 60000);

          if (lockAcquired) {
            break; // Success!
          }

          // Check what instance is running
          const activeInstances = db.getActiveInstances(60000);
          if (activeInstances.length === 0) {
            // No active instances - try again (might be race condition)
            if (attempt < maxRetries) {
              console.log(
                `⚠️  [BOOT] No active instances found but lock acquisition failed (attempt ${attempt}/${maxRetries})`
              );
              console.log(`   Retrying in ${retryDelay}ms...`);
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            } else {
              console.error(
                `❌ [BOOT] Failed to acquire instance lock after ${maxRetries} attempts (race condition)`
              );
              process.exit(1);
            }
          }

          const other = activeInstances[0];
          const heartbeatAge = Date.now() - other.last_heartbeat;
          const heartbeatAgeSeconds = Math.floor(heartbeatAge / 1000);

          // If heartbeat is very fresh (< 5 seconds), old instance is likely still running
          // If heartbeat is older (> 5 seconds), old instance might be shutting down
          if (heartbeatAge < 5000 && attempt < maxRetries) {
            // Fresh heartbeat - old instance is definitely still running
            console.log(
              `⚠️  [BOOT] Active instance detected with fresh heartbeat (${heartbeatAgeSeconds}s old)`
            );
            console.log(`   Instance ID: ${other.instance_id}, PID: ${other.pid}`);
            console.log(
              `   Waiting for old instance to release lock (attempt ${attempt}/${maxRetries})...`
            );
            await new Promise((r) => setTimeout(r, retryDelay));
            continue;
          } else if (heartbeatAge >= 5000 && heartbeatAge < 60000) {
            // Heartbeat is stale but not expired - old instance might be shutting down
            // Wait a bit and retry
            if (attempt < maxRetries) {
              console.log(
                `⚠️  [BOOT] Active instance detected with stale heartbeat (${heartbeatAgeSeconds}s old)`
              );
              console.log(`   Instance ID: ${other.instance_id}, PID: ${other.pid}`);
              console.log(
                `   Old instance may be shutting down, waiting for lock release (attempt ${attempt}/${maxRetries})...`
              );
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            }
          }

          // Final attempt or heartbeat is too fresh/stale
          console.error(`❌ [BOOT] Another bot instance is already running!`);
          console.error(`   Instance ID: ${other.instance_id}`);
          console.error(`   PID: ${other.pid}`);
          console.error(`   Hostname: ${other.hostname || "unknown"}`);
          console.error(`   Environment: ${other.environment || "unknown"}`);
          console.error(
            `   Last heartbeat: ${new Date(other.last_heartbeat).toISOString()} (${heartbeatAgeSeconds}s ago)`
          );
          console.error("   This instance will exit to prevent conflicts.");
          console.error(
            "   If you believe this is an error, the lock will auto-expire after 60s of no heartbeat."
          );
          process.exit(1);
        } catch (dbError) {
          if (attempt === maxRetries) {
            console.error(
              `❌ [BOOT] Failed to acquire database lock after ${maxRetries} attempts: ${dbError.message}`
            );
            console.error("   Bot will exit to prevent conflicts.");
            process.exit(1);
          }
          // Retry on database errors
          console.warn(
            `⚠️  [BOOT] Database error during lock acquisition (attempt ${attempt}/${maxRetries}): ${dbError.message}`
          );
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }

      if (!lockAcquired) {
        console.error(`❌ [BOOT] Failed to acquire instance lock after ${maxRetries} attempts`);
        process.exit(1);
      }

      console.log(
        `✅ [BOOT] Database instance lock acquired (Instance: ${instanceId}, PID: ${currentPid})`
      );

      // Start heartbeat to keep lock alive (update every 30 seconds)
      heartbeatInterval = setInterval(() => {
        const updated = db.updateInstanceHeartbeat(instanceId);
        if (!updated) {
          console.warn(`⚠️  [BOOT] Failed to update heartbeat - instance may have been removed`);
        }
      }, 30000);
    } else {
      // File-based lock for local development
      const lockFile = path.join(process.cwd(), ".bot.lock");

      if (fs.existsSync(lockFile)) {
        try {
          const existingPid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);

          // Check if process is still running
          try {
            // On Unix-like systems, sending signal 0 checks if process exists
            process.kill(existingPid, 0);

            // Process exists - another instance is running
            console.error(
              `❌ [BOOT] Another bot instance is already running (PID: ${existingPid})`
            );
            console.error("   This instance will exit to prevent conflicts.");
            console.error("   If you believe this is an error, manually delete: .bot.lock");
            process.exit(1);
          } catch (killError) {
            // Process doesn't exist - stale lock file, safe to remove
            console.log(`⚠️  [BOOT] Found stale lock file (PID: ${existingPid} not running)`);
            fs.unlinkSync(lockFile);
          }
        } catch (readError) {
          // Can't read lock file - assume stale and remove it
          console.log(`⚠️  [BOOT] Found invalid lock file, removing...`);
          try {
            fs.unlinkSync(lockFile);
          } catch (unlinkError) {
            // Ignore - will try to overwrite
          }
        }
      }

      // Create lock file
      try {
        fs.writeFileSync(lockFile, String(currentPid), "utf8");
        console.log(`✅ [BOOT] File instance lock acquired (PID: ${currentPid})`);
      } catch (writeError) {
        console.error(`❌ [BOOT] Failed to create lock file: ${writeError.message}`);
        console.error("   Bot will continue, but duplicate instances may cause conflicts.");
      }
    }
  }

  function releaseLock() {
    if (isRender) {
      // Release database lock
      try {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        db.releaseInstanceLock(instanceId);
        console.log(`✅ [BOOT] Database instance lock released (Instance: ${instanceId})`);
      } catch (error) {
        console.warn(`⚠️  [BOOT] Failed to release database lock: ${error.message}`);
      }
    } else {
      // Release file lock
      try {
        const lockFile = path.join(process.cwd(), ".bot.lock");
        if (fs.existsSync(lockFile)) {
          const lockPid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
          // Only remove if this is our lock file
          if (lockPid === currentPid) {
            fs.unlinkSync(lockFile);
            console.log(`✅ [BOOT] File instance lock released (PID: ${currentPid})`);
          }
        }
      } catch (error) {
        // Ignore errors during cleanup
        console.warn(`⚠️  [BOOT] Failed to release file lock: ${error.message}`);
      }
    }
  }

  // Acquire lock before starting (async for Render retry logic)
  await acquireLock();

  // Release lock on exit (all exit paths)
  process.on("exit", () => releaseLock());
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(0);
  });
  process.on("uncaughtException", () => {
    releaseLock();
  });
  process.on("unhandledRejection", () => {
    releaseLock();
  });

  let bot;
  try {
    console.log("📦 [BOOT] Creating PerpsBot instance with secure password loading...");
    bot = await PerpsBot.create(); // Use async factory method for secure wallet loading
    console.log("✅ [BOOT] PerpsBot instance created successfully");
  } catch (error) {
    console.error("❌ [BOOT] Failed to create PerpsBot instance:", error.message);
    console.error("   Stack:", error.stack);
    releaseLock();
    process.exit(1);
  }

  // Connect to UI server via WebSocket (for Render deployment when services are separate)
  // Low-latency bidirectional communication for real-time status updates and control
  const uiServerUrl = process.env.UI_SERVER_URL;
  let botWs = null;
  let reconnectTimeout = null;
  const uiWsEnabled = (process.env.UI_WS_ENABLED || "true").toLowerCase() === "true";
  const UI_WS_RECONNECT_BASE_MS = Number(process.env.UI_WS_RECONNECT_BASE_MS || 5000);
  const UI_WS_RECONNECT_MAX_MS = Number(process.env.UI_WS_RECONNECT_MAX_MS || 300000); // 5 minutes max
  const UI_WS_429_BACKOFF_MS = Number(process.env.UI_WS_429_BACKOFF_MS || 120000); // 2 minutes on 429
  let uiWsReconnectAttempt = 0;
  let lastUiWsErrorWas429 = false;

  function scheduleUiWsReconnect(reason = "") {
    if (!uiWsEnabled || !uiServerUrl) return;
    if (reconnectTimeout) return;

    // Exponential backoff with jitter; special-case 429 to avoid hammering the UI server / Render edge
    const base = lastUiWsErrorWas429 ? UI_WS_429_BACKOFF_MS : UI_WS_RECONNECT_BASE_MS;
    const exp = Math.min(UI_WS_RECONNECT_MAX_MS, base * Math.pow(2, uiWsReconnectAttempt));
    const jitter = Math.floor(Math.random() * 1000); // 0-999ms
    const delay = Math.min(UI_WS_RECONNECT_MAX_MS, exp + jitter);

    if (reason) {
      console.log(
        `⚠️  UI WS reconnect scheduled in ${Math.round(delay / 1000)}s${lastUiWsErrorWas429 ? " (429 backoff)" : ""}: ${reason}`
      );
    } else {
      console.log(
        `⚠️  UI WS reconnect scheduled in ${Math.round(delay / 1000)}s${lastUiWsErrorWas429 ? " (429 backoff)" : ""}`
      );
    }

    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      uiWsReconnectAttempt = Math.min(uiWsReconnectAttempt + 1, 12);
      connectToUIServer();
    }, delay);
  }

  function connectToUIServer() {
    if (!uiWsEnabled) {
      return;
    }
    if (!uiServerUrl) {
      // No UI server URL configured - skip WebSocket connection
      // This is fine for local development where bot and UI are in same process
      return;
    }

    if (botWs && botWs.readyState === 1) {
      // Already connected
      return;
    }

    try {
      const WebSocket = require("ws");
      const wsUrl =
        uiServerUrl.startsWith("ws://") || uiServerUrl.startsWith("wss://")
          ? uiServerUrl
          : uiServerUrl.startsWith("https://")
            ? uiServerUrl.replace("https://", "wss://")
            : `ws://${uiServerUrl}`;

      // Add bot identifier to URL
      const url = new URL(wsUrl);
      url.searchParams.set("client", "bot");
      if (process.env.API_KEY) {
        url.searchParams.set("apiKey", process.env.API_KEY);
      }

      botWs = new WebSocket(url.toString());

      // Make botWs accessible globally so closePosition can use it
      global.botWs = botWs;

      botWs.on("open", () => {
        console.log("✅ Connected to UI server via WebSocket");
        uiWsReconnectAttempt = 0;
        lastUiWsErrorWas429 = false;
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = null;
        }

        // Send initial status
        try {
          botWs.send(
            JSON.stringify({
              ev: "bot_status",
              data: bot.statusSnapshot(),
            })
          );
        } catch (e) {
          console.error("Failed to send initial status:", e.message);
        }

        // Send initial config
        try {
          const config = bot.getConfigSnapshot();
          delete config.wallet;
          delete config.privateKey;
          botWs.send(
            JSON.stringify({
              ev: "bot_config",
              data: config,
            })
          );
        } catch (e) {
          console.error("Failed to send initial config:", e.message);
        }

        // Setup log forwarding to UI (rate-limited)
        const logQueue = [];
        let logFlushTimer = null;
        const LOG_FLUSH_INTERVAL = 1000; // Flush every 1 second
        const MAX_LOGS_PER_FLUSH = 50; // Max 50 logs per flush

        const originalConsoleLog = console.log;
        const originalConsoleWarn = console.warn;
        const originalConsoleError = console.error;

        const forwardLog = (level, args) => {
          const message = args
            .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
            .join(" ");

          logQueue.push({
            level,
            message,
            ts: Date.now(),
          });

          // Schedule flush if not already scheduled
          if (!logFlushTimer) {
            logFlushTimer = setTimeout(() => {
              if (botWs && botWs.readyState === 1 && logQueue.length > 0) {
                const logsToSend = logQueue.splice(0, MAX_LOGS_PER_FLUSH);
                try {
                  botWs.send(
                    JSON.stringify({
                      ev: "logs_batch",
                      data: logsToSend,
                    })
                  );
                } catch (e) {
                  // Silently fail log forwarding to avoid recursion
                }
              }
              logFlushTimer = null;
            }, LOG_FLUSH_INTERVAL);
          }
        };

        console.log = (...args) => {
          originalConsoleLog(...args);
          forwardLog("info", args);
        };

        console.warn = (...args) => {
          originalConsoleWarn(...args);
          forwardLog("warn", args);
        };

        console.error = (...args) => {
          originalConsoleError(...args);
          forwardLog("error", args);
        };

        // Cleanup on disconnect
        botWs.on("close", () => {
          console.log = originalConsoleLog;
          console.warn = originalConsoleWarn;
          console.error = originalConsoleError;
          if (logFlushTimer) clearTimeout(logFlushTimer);
        });
      });

      botWs.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Handle control commands from UI server
          if (message.ev === "command") {
            const { cmd, params } = message;

            switch (cmd) {
              case "pause":
                bot.pause();
                botWs.send(JSON.stringify({ ev: "command_response", cmd: "pause", ok: true }));
                break;
              case "resume":
                bot.resume();
                botWs.send(JSON.stringify({ ev: "command_response", cmd: "resume", ok: true }));
                break;
              case "closeall":
                try {
                  await bot.closeAll("ui_ws");
                  botWs.send(JSON.stringify({ ev: "command_response", cmd: "closeall", ok: true }));
                } catch (error) {
                  console.error("Error closing all positions:", error);
                  botWs.send(
                    JSON.stringify({
                      ev: "command_response",
                      cmd: "closeall",
                      ok: false,
                      error: error.message || "Failed to close all positions",
                    })
                  );
                }
                break;
              case "closeposition":
                if (params && params.positionId) {
                  const position = bot.openPositions?.find(
                    (p) => p.positionId === params.positionId
                  );
                  if (position) {
                    try {
                      const market = position.market || (MARKETS && MARKETS[0]) || "SOL-PERP";
                      const priceData = bot._lastPrices?.get(market);
                      let price = priceData?.price;
                      // IMPORTANT: Avoid cross-market price bleed from bot._lastPrice (MARKETS[0]).
                      if (!Number.isFinite(price) || price <= 0) {
                        try {
                          price = await bot.getMarketPrice(market);
                        } catch (_) {
                          // ignore
                        }
                      }
                      if (!Number.isFinite(price) || price <= 0) {
                        price = position.entryPrice;
                      }
                      if (!Number.isFinite(price) || price <= 0) {
                        throw new Error(`No price available for ${market}`);
                      }
                      await bot.closePosition(position, price, "ui_ws");
                      botWs.send(
                        JSON.stringify({ ev: "command_response", cmd: "closeposition", ok: true })
                      );
                    } catch (error) {
                      console.error(`Error closing position ${params.positionId}:`, error);
                      botWs.send(
                        JSON.stringify({
                          ev: "command_response",
                          cmd: "closeposition",
                          ok: false,
                          error: error.message || "Failed to close position",
                        })
                      );
                    }
                  } else {
                    botWs.send(
                      JSON.stringify({
                        ev: "command_response",
                        cmd: "closeposition",
                        ok: false,
                        error: "Position not found",
                      })
                    );
                  }
                } else {
                  botWs.send(
                    JSON.stringify({
                      ev: "command_response",
                      cmd: "closeposition",
                      ok: false,
                      error: "Missing positionId parameter",
                    })
                  );
                }
                break;
              case "reset_kill_switch":
                try {
                  if (!bot.tradeClient) {
                    botWs.send(
                      JSON.stringify({
                        ev: "command_response",
                        cmd: "reset_kill_switch",
                        ok: false,
                        error: "Trade client not initialized",
                      })
                    );
                    break;
                  }

                  const wasTripped = bot.tradeClient.closeKillSwitchTripped || false;
                  const lastTriggerTime = bot.tradeClient._lastKillSwitchTime;
                  const reset = bot.tradeClient.resetCloseKillSwitch();

                  botWs.send(
                    JSON.stringify({
                      ev: "command_response",
                      cmd: "reset_kill_switch",
                      ok: true,
                      wasTripped,
                      reset,
                      lastTriggerTime: lastTriggerTime || null,
                      message: wasTripped
                        ? "Kill switch reset successfully"
                        : "Kill switch was not tripped",
                    })
                  );
                } catch (error) {
                  console.error("Error resetting kill switch:", error);
                  botWs.send(
                    JSON.stringify({
                      ev: "command_response",
                      cmd: "reset_kill_switch",
                      ok: false,
                      error: error.message || "Failed to reset kill switch",
                    })
                  );
                }
                break;
              case "get_status":
                botWs.send(JSON.stringify({ ev: "bot_status", data: bot.statusSnapshot() }));
                break;
              case "get_config":
                const config = bot.getConfigSnapshot();
                delete config.wallet;
                delete config.privateKey;
                botWs.send(JSON.stringify({ ev: "bot_config", data: config }));
                break;
              case "manual_track":
                // Track a manually-opened position (after user signs and submits)
                if (params) {
                  try {
                    const position = await bot.trackManualPosition(params);
                    botWs.send(
                      JSON.stringify({
                        ev: "command_response",
                        cmd: "manual_track",
                        ok: true,
                        data: position,
                      })
                    );
                  } catch (error) {
                    console.error("Error tracking manual position:", error);
                    botWs.send(
                      JSON.stringify({
                        ev: "command_response",
                        cmd: "manual_track",
                        ok: false,
                        error: error.message || "Failed to track manual position",
                      })
                    );
                  }
                } else {
                  botWs.send(
                    JSON.stringify({
                      ev: "command_response",
                      cmd: "manual_track",
                      ok: false,
                      error: "Missing position parameters",
                    })
                  );
                }
                break;
              case "manual_close":
                // Close a manually-tracked position
                if (params && params.positionId) {
                  try {
                    const result = await bot.closeManualPosition(
                      params.positionId,
                      params.reason || "manual_close"
                    );
                    botWs.send(
                      JSON.stringify({
                        ev: "command_response",
                        cmd: "manual_close",
                        ok: true,
                        data: result,
                      })
                    );
                  } catch (error) {
                    console.error("Error closing manual position:", error);
                    botWs.send(
                      JSON.stringify({
                        ev: "command_response",
                        cmd: "manual_close",
                        ok: false,
                        error: error.message || "Failed to close manual position",
                      })
                    );
                  }
                } else {
                  botWs.send(
                    JSON.stringify({
                      ev: "command_response",
                      cmd: "manual_close",
                      ok: false,
                      error: "Missing positionId parameter",
                    })
                  );
                }
                break;
              case "manual_validate":
                // Validate manual trade parameters
                if (params) {
                  try {
                    const validation = bot.validateManualTrade(params);
                    botWs.send(
                      JSON.stringify({
                        ev: "command_response",
                        cmd: "manual_validate",
                        ok: true,
                        data: validation,
                      })
                    );
                  } catch (error) {
                    console.error("Error validating manual trade:", error);
                    botWs.send(
                      JSON.stringify({
                        ev: "command_response",
                        cmd: "manual_validate",
                        ok: false,
                        error: error.message || "Failed to validate manual trade",
                      })
                    );
                  }
                } else {
                  botWs.send(
                    JSON.stringify({
                      ev: "command_response",
                      cmd: "manual_validate",
                      ok: false,
                      error: "Missing trade parameters",
                    })
                  );
                }
                break;
            }
          }
        } catch (e) {
          console.error("Error processing WebSocket message:", e.message);
        }
      });

      botWs.on("error", (error) => {
        const msg = error?.message || String(error);
        console.error("WebSocket error:", msg);
        lastUiWsErrorWas429 =
          msg.includes(" 429") || msg.includes("response: 429") || msg.includes("429");
      });

      botWs.on("close", () => {
        console.log("⚠️  Disconnected from UI server");
        botWs = null;
        global.botWs = null;
        scheduleUiWsReconnect("socket closed");
      });
    } catch (e) {
      console.error("Failed to connect to UI server:", e.message);
      lastUiWsErrorWas429 = String(e?.message || e).includes("429");
      scheduleUiWsReconnect("connect failed");
    }
  }

  // Function to send status updates to UI server
  function sendStatusToUI() {
    if (botWs && botWs.readyState === 1) {
      try {
        botWs.send(
          JSON.stringify({
            ev: "bot_status",
            data: bot.statusSnapshot(),
            ts: Date.now(),
          })
        );
      } catch (e) {
        console.error("Failed to send status to UI:", e.message);
      }
    }
  }

  // Connect to UI server after bot starts
  // Use a small delay to ensure bot is initialized
  setTimeout(() => {
    connectToUIServer();

    // Send status updates periodically (every 5 seconds)
    setInterval(() => {
      sendStatusToUI();
    }, 5000);
  }, 2000);

  // Send status on position events
  const originalOpenPosition = bot.openPosition.bind(bot);
  bot.openPosition = async function (...args) {
    const result = await originalOpenPosition(...args);
    sendStatusToUI();
    return result;
  };

  const originalClosePosition = bot.closePosition.bind(bot);
  bot.closePosition = async function (...args) {
    const result = await originalClosePosition(...args);
    sendStatusToUI();
    return result;
  };

  const originalCloseAll = bot.closeAll.bind(bot);
  bot.closeAll = async function (...args) {
    const result = await originalCloseAll(...args);
    sendStatusToUI();
    return result;
  };

  // Graceful shutdown handler
  const shutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

    // IMMEDIATELY stop making API calls (critical for preventing dual-instance 429s during deployment)
    bot.paused = true;
    console.log("⏸️  Bot paused - no more API calls will be made");

    // Stop the tick loop
    if (bot._tickInterval) {
      clearInterval(bot._tickInterval);
      console.log("✅ Tick loop stopped");
    }

    // Stop health checks
    if (bot._healthCheckInterval) {
      clearInterval(bot._healthCheckInterval);
      console.log("✅ Health checks stopped");
    }

    // Stop Drift client (disconnects Solana WS via subprocess + DLOB WS) to avoid overlapping
    // WebSocket subscriptions during rolling restarts (Render can run old+new briefly).
    if (bot.driftClient && typeof bot.driftClient.shutdown === "function") {
      try {
        await bot.driftClient.shutdown();
        console.log("✅ Drift client stopped");
      } catch (e) {
        console.warn("⚠️  Drift client shutdown failed:", e?.message || e);
      }
    }

    // Stop Price Provider (disconnects Pyth WebSocket)
    if (bot.priceProvider) {
      await bot.priceProvider.stop();
      console.log("✅ Price Provider stopped");
    }

    // Wait briefly for any in-flight API calls to complete
    // Reduced to 1s on Render for faster shutdown during deployments
    const shutdownDelay = process.env.RENDER ? 1000 : 2000;
    console.log(`⏳ Waiting ${shutdownDelay}ms for in-flight API calls to complete...`);
    await new Promise((r) => setTimeout(r, shutdownDelay));

    // Send Telegram notification for bot stop
    if (bot.tg && bot.tg.enabled) {
      const stats = bot.statusSnapshot();
      const mode = bot.liveMode ? "LIVE" : "PAPER";
      await bot.tg
        .say(
          `🛑 *Bot Stopped*\n` +
            `Mode: ${mode}\n` +
            `Open Positions: ${stats.positions}\n` +
            `Daily Trades: ${stats.dailyTrades}`
        )
        .catch((err) => {
          console.error("Failed to send Telegram stop notification:", err);
        });
    }

    // Stop Telegram polling gracefully (CRITICAL for avoiding 409 on restart)
    if (bot.tg && bot.tg.shutdown) {
      await bot.tg.shutdown();
    }

    // Close any open positions if needed (optional)
    // await bot.closeAll('shutdown');

    // Release instance lock (critical for preventing "already running" errors on restart)
    releaseLock();

    console.log("✅ Graceful shutdown complete");
    process.exit(0);
  };

  // Register shutdown handlers (remove duplicate handlers since we added them earlier)
  // Note: We already registered handlers above, but shutdown() is more comprehensive
  // Override the simple ones we registered earlier with the full shutdown handler
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Handle uncaught errors
  process.on("uncaughtException", async (error) => {
    console.error("Uncaught Exception:", error);

    // Send Telegram notification for crash
    if (bot.tg && bot.tg.enabled) {
      bot.tg
        .say(
          `💥 *Bot Crashed*\n` +
            `Error: ${error.message}\n` +
            `Stack: ${error.stack?.split("\n")[0] || "N/A"}`
        )
        .catch((err) => {
          console.error("Failed to send Telegram crash notification:", err);
        });
    }

    await errorHandler.handle(error, {
      category: Category.SYSTEM,
      severity: Severity.CRITICAL,
      context: { action: "uncaughtException" },
    });

    // Release lock before exiting
    releaseLock();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);

    // Send Telegram notification for unhandled rejection
    if (bot.tg && bot.tg.enabled) {
      const errorMsg = reason instanceof Error ? reason.message : String(reason);
      bot.tg.say(`⚠️ *Unhandled Rejection*\n` + `Error: ${errorMsg}`).catch((err) => {
        console.error("Failed to send Telegram rejection notification:", err);
      });
    }

    await errorHandler.handle(reason instanceof Error ? reason : new Error(String(reason)), {
      category: Category.SYSTEM,
      severity: Severity.HIGH,
      context: { action: "unhandledRejection" },
    });

    // Note: Don't exit on unhandled rejection, but release lock if process exits
    // The lock will be released on process.exit via the 'exit' handler
  });

  console.log("🚀 [BOOT] Starting bot main loop...");
  try {
    await bot.start();
    console.log("✅ [BOOT] Bot started successfully - entering main loop");
  } catch (error) {
    console.error("❌ [BOOT] Bot start failed:", error.message);
    console.error("   Stack:", error.stack);
    releaseLock();
    process.exit(1);
  }
})().catch((error) => {
  console.error("💥 [BOOT] Fatal error in main async function:", error.message);
  console.error("   Stack:", error.stack);
  // Lock will be cleaned up by 'exit' handler, but try to clean up manually if possible
  // Note: releaseLock is not accessible here since it's inside the async IIFE
  // The 'exit' handler registered above will clean it up
  process.exit(1);
});
