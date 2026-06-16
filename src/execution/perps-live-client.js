/*************************************************************
 * Jupiter Perps Live Client — robust auto-integration layer
 * - Finds SDK entry (even with no package exports)
 * - Detects client constructor/factory across variants
 * - Discovers Group + Market with multiple aliases
 * - Finds increase/decrease request builders by name
 * - Handles Transaction | {tx} | {transactions[]} | IX[]
 *************************************************************/
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const config = require("../../config");
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  VersionedTransaction,
  SendTransactionError,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const RPCManager = require("../../utils/rpc-manager");
const axios = require("axios");
const {
  PERPS_PROGRAM,
  derivePerpetualsPda,
  derivePositionPda,
  derivePositionRequestPda,
  deriveEventAuthorityPda,
} = require("./pda-utils");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* ----------------- Utility ----------------- */

const isFn = (f) => typeof f === "function";
const isObj = (o) => o && typeof o === "object";
const envOrDefault = (key, fallback, options = {}) => {
  if (process.env[key] && process.env[key].trim()) return process.env[key].trim();
  if (options.required && (fallback === undefined || fallback === null)) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return fallback;
};
const parsePubkey = (value, label) => {
  try {
    return new PublicKey(value);
  } catch (err) {
    throw new Error(`Invalid ${label || "public key"} value: ${value}`);
  }
};
const loadAddress = (key, fallback, options = {}) => {
  const raw = envOrDefault(key, fallback, options);
  if (!raw) throw new Error(`Missing address for ${options.label || key}`);
  if (!process.env[key] && fallback && raw === fallback && options.logFallback !== false) {
    console.warn(`ℹ️  ${key} not set; using fallback value ${fallback}`);
  }
  return parsePubkey(raw, options.label || key);
};
const toNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};
const splitList = (value = "") =>
  value
    .split(/[, \s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
const tryParsePubkey = (value, label) => {
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch (err) {
    console.warn(`⚠️  Invalid ${label || "pubkey"} entry skipped: ${value}`);
    return null;
  }
};
const envTipAccountsRaw = (process.env.SOLANA_TIP_ACCOUNTS || process.env.TIP_ACCOUNTS || "").trim();
console.log(`[TIP_ACCOUNTS] Raw env value: "${envTipAccountsRaw.substring(0, 100)}${envTipAccountsRaw.length > 100 ? '...' : ''}"`);
const ENV_TIP_ACCOUNTS = envTipAccountsRaw
  ? splitList(envTipAccountsRaw)
      .map((entry) => tryParsePubkey(entry, "SOLANA_TIP_ACCOUNTS"))
      .filter(Boolean)
  : [];
console.log(`[TIP_ACCOUNTS] Parsed ${ENV_TIP_ACCOUNTS.length} tip accounts from env`);
const rawTipUrl = (process.env.TIP_ACCOUNTS_URL || "").trim();
const TIP_ACCOUNTS_URL = rawTipUrl.toLowerCase() === "none" ? "" : rawTipUrl || "https://tip.jito.wtf/api/v1/tip_accounts";
const TIP_ACCOUNTS_TIMEOUT_MS = toNumber(process.env.TIP_ACCOUNTS_TIMEOUT_MS, 2500);
const TIP_ACCOUNTS_PER_TX_DEFAULT = Math.max(1, toNumber(process.env.TIP_ACCOUNTS_PER_TX, 1));

const PROGRAM_ID = loadAddress("PERPS_PROGRAM", PERPS_PROGRAM.toBase58(), { required: true, label: "PERPS_PROGRAM" });
const POOL_ADDRESS = loadAddress("PERPS_POOL_ADDRESS", "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq", {
  required: true,
  label: "PERPS_POOL_ADDRESS",
});

const usdcMintStr = envOrDefault(
  "QUOTE_MINT",
  envOrDefault("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", { required: true }),
  { required: true }
);
const collateralMint = parsePubkey(usdcMintStr, "QUOTE_MINT/USDC_MINT");
const collateralCustody = loadAddress(
  "COLLATERAL_CUSTODY",
  "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa", // Official USDC custody from Jupiter
  { required: true, label: "COLLATERAL_CUSTODY" }
);

// USDT custody (for future use)
const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const USDT_CUSTODY = loadAddress(
  "USDT_CUSTODY",
  "4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk",
  { required: false, label: "USDT_CUSTODY" }
);

const SOL_MINT = loadAddress("SOL_MINT", "So11111111111111111111111111111111111111112", {
  required: true,
  label: "SOL_MINT",
});
const BTC_MINT = loadAddress("BTC_MINT", "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", {
  required: true,
  label: "BTC_MINT",
});
const ETH_MINT = loadAddress("ETH_MINT", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", {
  required: true,
  label: "ETH_MINT",
});

const COLLATERAL = {
  mint: collateralMint,
  custody: collateralCustody,
};

// Helper to build market entry with ui-server compatible structure
function buildMarketEntry(symbol, custodyEnvKey, custodyFallback, mint, oracleEnvKey, oracleFallback) {
  const custody = loadAddress(custodyEnvKey, custodyFallback, {
    label: custodyEnvKey,
    logFallback: false,
  });
  const oracleAccount = loadAddress(oracleEnvKey, oracleFallback, {
    label: oracleEnvKey,
    logFallback: false,
  });
  
  return {
    symbol,
    market: custody, // ui-server expects 'market' field as unique key
    custody,
    mint,
    oracleAccount,
  };
}

const MARKET_REGISTRY = {
  "SOL-PERP": buildMarketEntry(
    "SOL-PERP",
    "SOL_PERP_CUSTODY", "7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz",
    SOL_MINT,
    "SOL_PERP_ORACLE", "FYq2BWQ1V5P1WFBqr3qB2Kb5yHVvSv7upzKodgQE5zXh"
  ),
  "BTC-PERP": buildMarketEntry(
    "BTC-PERP",
    "BTC_PERP_CUSTODY", "5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm",
    BTC_MINT,
    "BTC_PERP_ORACLE", "hUqAT1KQ7eW1i6Csp9CXYtpPfSAvi835V7wKi5fRfmC"
  ),
  "ETH-PERP": buildMarketEntry(
    "ETH-PERP",
    "ETH_PERP_CUSTODY", "AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn",
    ETH_MINT,
    "ETH_PERP_ORACLE", "AFZnHPzy4mvVCffrVwhewHbFc93uTHvDSFrVH7GtfXF1"
  ),
};

// Export the market registry for UI server
// Export MARKET_REGISTRY (actual export is at the end of file)
const NONE_OPTION = { __option: "None" };
const SOME_TRUE = { __option: "Some", value: true };

/* ----------------- SDK AUTO-LOAD ----------------- */

async function loadSDK() {
  // 1) Try dynamic import for ESM packages first (jup-perps-client is ESM-only)
  try {
    const m = await import("jup-perps-client");
    console.log(`✅ Loaded Perps SDK via dynamic import: jup-perps-client`);
    return { sdk: m.default || m, source: "jup-perps-client" };
  } catch (err) {
    console.log(`⚠️  Failed to dynamically import "jup-perps-client": ${err.message}`);
  }

  // 2) Try requiring CommonJS packages
  const pkgRoots = [
    "@jup-ag/perps-client",
    "@jupiter/perps-sdk",
    "perps-sdk",
  ];

  for (const mod of pkgRoots) {
    try {
      const m = require(mod);
      console.log(`✅ Loaded Perps SDK via package: ${mod}`);
      return { sdk: m, source: mod };
    } catch (err) {
      // continue trying other package roots
    }
  }

  // 2) Try direct-file inside node_modules/jup-perps-client
  const base = path.join(__dirname, "node_modules", "jup-perps-client");
  
  // Check if package directory exists
  if (!fs.existsSync(base)) {
    const nodeModulesPath = path.join(__dirname, "node_modules");
    const diagnostic = [
      "❌ Jupiter Perps SDK package not found.",
      "",
      "Package directory missing: " + base,
      "",
      "Diagnostics:",
      "  - Current directory: " + __dirname,
      "  - Working directory: " + process.cwd(),
      "  - node_modules exists: " + (fs.existsSync(nodeModulesPath) ? "YES" : "NO"),
      "",
      "Solution:",
      "  1. Run: npm install",
      "  2. Verify package.json includes: \"jup-perps-client\": \"^1.0.0\"",
      "  3. On Render: Check build logs - ensure 'npm ci' completes successfully",
      "  4. On Render: Verify package-lock.json is committed to git",
    ].join("\n");
    throw new Error(diagnostic);
  }

  const tryFiles = [
    "dist/index.js",
    "dist/client.js",
    "lib/client.js",
    "lib/index.js",
    "index.js",
  ];
  
  let lastError = null;
  for (const rel of tryFiles) {
    const full = path.join(base, rel);
    if (!fs.existsSync(full)) continue;
    try {
      // Try require first (for CommonJS files)
      const m = require(full);
      console.log(`✅ Loaded Perps SDK via file: jup-perps-client/${rel}`);
      return { sdk: m, source: `jup-perps-client/${rel}` };
    } catch (err) {
      // If require fails with ESM error, try dynamic import
      if (err.message && err.message.includes("ES Module")) {
        try {
          const fileUrl = `file://${full}`;
          const m = await import(fileUrl);
          console.log(`✅ Loaded Perps SDK via dynamic import: jup-perps-client/${rel}`);
          return { sdk: m.default || m, source: `jup-perps-client/${rel}` };
        } catch (importErr) {
          lastError = importErr;
          console.log(`⚠️  Failed to dynamically import jup-perps-client/${rel}: ${importErr.message}`);
        }
      } else {
        lastError = err;
      }
    }
  }

  // Final diagnostic error
  const distPath = path.join(base, "dist");
  const distExists = fs.existsSync(distPath);
  const distContents = distExists ? fs.readdirSync(distPath).join(", ") : "N/A";
  
  const diagnostic = [
    "❌ Jupiter Perps SDK found but could not be loaded.",
    "",
    "Package location: " + base,
    "dist/ directory exists: " + (distExists ? "YES" : "NO"),
    "dist/ contents: " + distContents,
    "",
    "Tried files:",
    ...tryFiles.map(f => {
      const exists = fs.existsSync(path.join(base, f));
      return "  - " + f + (exists ? " (exists)" : " (missing)");
    }),
    "",
    lastError ? "Last error: " + lastError.message : "",
    "",
    "Solution:",
    "  1. Verify package is installed: npm list jup-perps-client",
    "  2. Check package structure: ls -la node_modules/jup-perps-client/dist/",
    "  3. On Render: Check build logs for installation errors",
    "  4. If ESM module error: Package may need dynamic import (contact maintainer)",
  ].filter(Boolean).join("\n");
  
  throw new Error(diagnostic);
}

function normalizeTxPayload(txOrObj) {
  // Accept: Transaction | VersionedTransaction | { tx } | { transaction } | { transactions: [..] } | [ix...]
  if (!txOrObj) throw new Error("Empty tx payload");

  if (txOrObj instanceof Transaction || txOrObj instanceof VersionedTransaction) return txOrObj;

  if (Array.isArray(txOrObj)) {
    const t = new Transaction();
    for (const ix of txOrObj) t.add(ix);
    return t;
  }

  if (isObj(txOrObj)) {
    if (txOrObj.tx) return txOrObj.tx;
    if (txOrObj.transaction) return txOrObj.transaction;
    if (Array.isArray(txOrObj.transactions) && txOrObj.transactions.length > 0) {
      return normalizeTxPayload(txOrObj.transactions[0]);
    }
    if (Array.isArray(txOrObj.ixs)) {
      const t = new Transaction();
      for (const ix of txOrObj.ixs) t.add(ix);
      return t;
    }
  }

  throw new Error("Unsupported tx payload shape from SDK");
}

/* ----------------- Wallet ----------------- */

function loadWallet() {
  const p = process.env.WALLET_PRIVATE_KEY_PATH || "perps-wallet.json";
  if (!fs.existsSync(p)) throw new Error(`❌ Wallet not found at ${p}`);
  
  // Check if wallet is encrypted
  const walletEncryption = require('../../utils/wallet-encryption');
  const walletPassword = process.env.WALLET_PASSWORD;
  
  if (walletEncryption.isEncrypted(p)) {
    console.log(`🔐 [perps-live-client] Wallet is encrypted: ${p}`);
    console.log(`🔑 [perps-live-client] Password available: ${walletPassword ? 'YES' : 'NO'}`);
    
    if (!walletPassword) {
      throw new Error('Wallet file is encrypted but WALLET_PASSWORD environment variable is not set.');
    }
    
    try {
      const secret = walletEncryption.loadEncryptedWallet(p, walletPassword);
      const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      console.log(`✅ [perps-live-client] Decrypted wallet: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (error) {
      console.error(`❌ [perps-live-client] Wallet decryption failed: ${error.message}`);
      throw error;
    }
  } else {
    // Plain JSON wallet
    console.log(`📄 [perps-live-client] Wallet is plaintext: ${p}`);
    const secret = JSON.parse(fs.readFileSync(p, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
}

/* ----------------- Main client class ----------------- */

class JupiterPerpsLive {
  constructor(walletKp, options = {}) {
    this.wallet = walletKp || loadWallet();

    // Initialize RPC Manager for multi-provider support with failover
    // Disable health checks for this secondary instance to avoid duplicates
    // (Primary instance in PaperPerpsClient handles health checks)
    this.rpcManager = new RPCManager({ enableHealthChecks: false });
    this.connection = this.rpcManager.getConnection();
    
    this.marketSymbol = (config.market || process.env.MARKET || "SOL-PERP").toUpperCase();
    this.slippageBps = config.risk.slippageBps;
    this.priorityFee = config.priorityFeeMicrolamps;
    this.basePriorityFee = this.priorityFee;
    this.computeUnitLimit =
      Number.isFinite(config?.fees?.solanaTxFee?.cuLimit) && config.fees.solanaTxFee.cuLimit > 0
        ? config.fees.solanaTxFee.cuLimit
        : 200_000;
    
    // Use config priority steps or default
    this.closePrioritySteps = config.closePrioritySteps.length > 0 
      ? [...config.closePrioritySteps]
      : [this.basePriorityFee || 0];
    
    if (this.closePrioritySteps.length === 0) this.closePrioritySteps = [this.basePriorityFee || 0];
    if (this.closePrioritySteps[0] !== this.basePriorityFee) {
      this.closePrioritySteps = [this.basePriorityFee, ...this.closePrioritySteps];
    }
    
    // Calculate closeMaxAttempts and closeKillSwitchAfter if not explicitly set in config
    this.closeMaxAttempts = config.closeMaxAttempts !== null 
      ? config.closeMaxAttempts 
      : this.closePrioritySteps.length;
    this.closeKillSwitchAfter = config.closeKillSwitchAfter !== null 
      ? config.closeKillSwitchAfter 
      : Math.max(this.closeMaxAttempts, this.closePrioritySteps.length);
    this.closeRetryDelayMs = config.closeRetryDelayMs;
    this.closeKillSwitchTripped = false;
    this._lastKillSwitchTime = null; // Track when kill switch was tripped for auto-reset
    this._lastKillSwitchError = null; // Track the error that triggered the kill switch
    this.tipAccountsPerTx = Math.max(
      1,
      Number.isFinite(config.tipAccountsPerTx) ? config.tipAccountsPerTx : TIP_ACCOUNTS_PER_TX_DEFAULT
    );
    this._tipAccounts = ENV_TIP_ACCOUNTS.length ? [...ENV_TIP_ACCOUNTS] : [];
    this._tipCursor = 0;
    this._tipFetchPromise = null;
    this._txTelemetry = [];
    this._maxTxTelemetry = 100;
    // Request counter fix: Use small incremental counters instead of timestamps
    // On-chain counters are in the 1e8-1e9 range, not millisecond timestamps (~1.7e12)
    // Start from a random base in the valid range to avoid collisions
    this._requestCounter = BigInt(Math.floor(Math.random() * 900_000_000) + 100_000_000);
    this._keeperSubId = null;
    this._keeperListeners = new Set();

    // Position tracking options
    this._db = options.db || null; // Optional database instance for automatic tracking
    this._enableAutoTracking = options.enableAutoTracking !== false; // Default: true
    this._tradeMetadata = {
      mode: options.mode || 'live', // 'live' or 'paper'
      trade_type: options.trade_type || 'automated', // 'automated' or 'manual'
      environment: options.environment || process.env.ENVIRONMENT || 'local',
      instance_id: options.instance_id || null,
    };

    // SDK will be loaded asynchronously in init() method
    this._sdkModule = null;
    this._sdkSource = null;

    this.sdk = null;
    this.group = null;
    this.market = null;
    this._builders = {
      increase: null,
      decrease: null,
    };
    this._positionDecoder = null;
    this._perpetualsPda = null;
    this._eventAuthorityPda = null;
    this._positionPda = null;
    this._positionRequestPda = null;
    this._initialized = false; // Track if init() completed successfully
    this._initPromise = null; // Track ongoing init() to prevent concurrent calls
    
    // RACE CONDITION FIXES: Market operation mutex to prevent concurrent trades from clobbering each other
    this._marketOperationLock = null; // Promise-based lock for market context operations
    this._operationIdCounter = 0; // Counter for unique operation IDs
    
    // AbortController for cancellable operations
    this._activeAbortControllers = new Map(); // operationId -> AbortController
  }

  /**
   * Acquire a lock for market-sensitive operations.
   * This prevents concurrent trades from clobbering each other's market context.
   * @returns {Promise<{release: Function, operationId: number, abortController: AbortController}>}
   */
  async _acquireMarketLock() {
    const operationId = ++this._operationIdCounter;
    const abortController = new AbortController();
    this._activeAbortControllers.set(operationId, abortController);
    
    // Wait for any existing lock to be released
    while (this._marketOperationLock) {
      try {
        await this._marketOperationLock;
      } catch (e) {
        // Previous operation failed, continue
      }
    }
    
    // Create new lock
    let releaseLock;
    this._marketOperationLock = new Promise(resolve => {
      releaseLock = () => {
        if (this._marketOperationLock === resolve.promise) {
          this._marketOperationLock = null;
        }
        this._activeAbortControllers.delete(operationId);
        resolve();
      };
    });
    // Store reference to promise on the resolve function for comparison
    releaseLock.promise = this._marketOperationLock;
    
    return {
      release: releaseLock,
      operationId,
      abortController,
    };
  }

  async init() {
    if (this._initialized) return;
    if (this._initPromise) {
      await this._initPromise;
      return;
    }

    this._initPromise = (async () => {
    if (!this._sdkModule) {
      const { sdk, source } = await loadSDK();
      this._sdkModule = sdk;
      this._sdkSource = source;
    }

      this.sdk = this._sdkModule;
      this._configureManualMode();
      this._initialized = true;
      this._initPromise = null;
    })().catch((error) => {
      this._initPromise = null;
      throw error;
    });

    await this._initPromise;
  }

  /**
   * Finalize a transaction-like object into a signed Transaction
   * @param {Transaction|VersionedTransaction|Object} txLike - Transaction to finalize
   * @param {Object} options - Options
   * @param {number} [options.priorityFee] - Priority fee override (avoids reading from this.priorityFee)
   */
  async _finalizeTxLike(txLike, options = {}) {
    // RACE CONDITION FIX: Use passed priorityFee instead of reading from this.priorityFee
    // This prevents issues when multiple concurrent operations are using different priority fees
    const effectivePriorityFee = Number.isFinite(options.priorityFee) ? options.priorityFee : this.priorityFee;
    
    // Normalize to Transaction (or VersionedTransaction)
    let tx = normalizeTxPayload(txLike);
    
    // CRITICAL FIX: Clone Transaction to avoid mutating the original during retries
    // This prevents duplicate instructions when retrying failed transactions
    if (tx instanceof Transaction) {
      const clonedTx = new Transaction();
      // Copy all instructions from original
      for (const ix of tx.instructions) {
        clonedTx.add(ix);
      }
      // Copy fee payer if set
      if (tx.feePayer) {
        clonedTx.feePayer = tx.feePayer;
      }
      // Copy recent blockhash if set (will be updated below)
      if (tx.recentBlockhash) {
        clonedTx.recentBlockhash = tx.recentBlockhash;
      }
      tx = clonedTx;
    }

    // Only apply priority fee instructions if priority fee is actually enabled (> 0)
    if (Number.isFinite(effectivePriorityFee) && effectivePriorityFee > 0) {
      if (tx instanceof Transaction) {
        await this._applyPriorityFeeInstructions(tx, effectivePriorityFee);
      } else {
        console.warn("⚠️  Priority fee configured but cannot attach tip accounts to a versioned transaction; proceeding without tip boost.");
      }
    }

    // v0 vs legacy
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.wallet]); // partialSign not on VersionedTransaction
      return tx;
    }

    tx.feePayer = this.wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    tx.partialSign(this.wallet);
    this._validateTransaction(tx);
    return tx;
  }

  /**
   * Validate transaction before signing
   */
  _validateTransaction(tx) {
    if (!tx) {
      throw new Error('Transaction is null or undefined');
    }

    // Validate fee payer is our wallet
    if (tx instanceof Transaction && tx.feePayer) {
      if (!tx.feePayer.equals(this.wallet.publicKey)) {
        throw new Error('Transaction fee payer does not match wallet public key');
      }
    }

    // Whitelist allowed program IDs (configure via environment)
    const allowedProgramIds = (process.env.ALLOWED_PROGRAM_IDS || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
      .map((id) => {
        try {
          return new PublicKey(id);
        } catch (err) {
          console.warn(`⚠️  Invalid ALLOWED_PROGRAM_IDS entry skipped: ${id}`);
          return null;
        }
      })
      .filter(Boolean);
    if (!allowedProgramIds.some((pk) => pk.equals(PROGRAM_ID))) {
      allowedProgramIds.push(PROGRAM_ID);
    }

    if (allowedProgramIds.length > 0) {
      const programIds = tx.instructions.map(ix => ix.programId);
      for (const programId of programIds) {
        // Allow system program and this wallet's programs
        const systemProgram = SystemProgram.programId;
        if (!programId.equals(systemProgram) && 
            !programId.equals(this.wallet.publicKey) &&
            !allowedProgramIds.some(allowed => programId.equals(allowed))) {
          console.warn(`⚠️  Transaction contains instruction from non-whitelisted program: ${programId.toString()}`);
          if (process.env.ENFORCE_PROGRAM_WHITELIST === 'true') {
            throw new Error(`Program ID ${programId.toString()} not in whitelist`);
          }
        }
      }
    }

    // Validate transaction size
    const maxSize = 1232; // Solana transaction size limit
    const serializedSize = tx.serialize().length;
    if (serializedSize > maxSize) {
      throw new Error(`Transaction too large: ${serializedSize} bytes (max ${maxSize})`);
    }
  }

  /* ----------------- Manual fallback helpers ----------------- */

  _configureManualMode() {
    // Use REQUEST-based instructions (client-side), Jupiter API will convert to instant + co-sign
    const increaseBuilder = this.sdk?.getCreateIncreasePositionMarketRequestInstruction;
    const decreaseBuilder = this.sdk?.getCreateDecreasePositionMarketRequestInstruction;
    if (!isFn(increaseBuilder) || !isFn(decreaseBuilder)) {
      throw new Error("jup-perps-client is missing required instruction builders; cannot operate in manual mode.");
    }

    console.log("✅ Using request-based instructions");
    this._builders = {
      increase: increaseBuilder,
      decrease: decreaseBuilder,
    };

    this.group = {
      label: "Jupiter Perps Manual",
      programId: PROGRAM_ID.toBase58(),
      poolAddress: POOL_ADDRESS.toBase58(),
      collateralMint: COLLATERAL.mint.toBase58(),
      collateralCustody: COLLATERAL.custody.toBase58(),
    };

    this.pool = POOL_ADDRESS; // Pool PublicKey for PDA derivation
    this.market = this._formatManualMarket(this.marketSymbol);
    this._perpetualsPda = derivePerpetualsPda(PROGRAM_ID);
    this._eventAuthorityPda = deriveEventAuthorityPda(PROGRAM_ID);
    
    // Position PDAs are derived per-market and per-side, so we'll derive them dynamically in the request builders
    // Store references for later use
    this._positionPdaCache = new Map(); // key: `${custody}:${collateralCustody}:${side}`
    this._positionRequestPdaCache = new Map(); // key: `${custody}:${collateralCustody}:${side}:${counter}`

    this._positionDecoder = this._resolvePositionDecoder();
    if (!this._positionDecoder) {
      throw new Error("jup-perps-client cannot decode Position accounts; update the SDK bundle.");
    }

    console.log(`⚙️  Manual instruction builder mode enabled (source: ${this._sdkSource || "cached module"})`);
  }

  _formatManualMarket(input) {
    const symbol = (typeof input === "string" ? input : input?.symbol || this.marketSymbol || "SOL-PERP").toUpperCase();
    const entry = MARKET_REGISTRY[symbol];
    if (!entry) {
      throw new Error(`Unsupported Jupiter Perps market: ${symbol}`);
    }
    return {
      symbol: entry.symbol,
      custody: entry.custody,
      mint: entry.mint,
      oracleAccount: entry.oracleAccount,
      address: entry.custody,
      marketAddress: entry.custody.toBase58(),
      poolAddress: POOL_ADDRESS.toBase58(),
      collateralMint: COLLATERAL.mint.toBase58(),
      collateralCustody: COLLATERAL.custody.toBase58(),
    };
  }

  /**
   * Dynamically switch the market context for the next trade
   * @param {string} marketSymbol - The new market symbol (e.g., "BTC-PERP", "ETH-PERP")
   */
  _switchMarket(marketSymbol) {
    const normalizedSymbol = marketSymbol.toUpperCase();
    // CRITICAL: Validate market FIRST before updating marketSymbol
    // This prevents a failed market switch from leaving marketSymbol out of sync with this.market
    // Bug fix: Previously, marketSymbol was set before _formatManualMarket, so if JTO-PERP failed,
    // marketSymbol would be 'JTO-PERP' but this.market would still be SOL-PERP object
    const newMarket = this._formatManualMarket(normalizedSymbol);
    this.marketSymbol = normalizedSymbol;
    this.market = newMarket;
    
    // Clear position PDA (will be re-derived for new market)
    if (this._positionPda) {
      // Remove existing keeper subscription if active
      if (this._keeperSubId !== null) {
        this.connection.removeAccountChangeListener(this._keeperSubId).catch(() => {});
        this._keeperSubId = null;
      }
      this._positionPda = null;
    }
    
    console.log(`✅ Market context switched to: ${normalizedSymbol}`);
  }

  _resolvePositionDecoder() {
    if (isFn(this.sdk?.decodePosition)) {
      return (address, accountInfo) => {
        const encoded = {
          address: address.toBase58(),
          executable: accountInfo.executable,
          lamports: accountInfo.lamports,
          owner: accountInfo.owner,
          data: accountInfo.data,
        };
        const decoded = this.sdk.decodePosition(encoded);
        return decoded?.account?.data || decoded?.data || decoded || null;
      };
    }
    if (isFn(this.sdk?.getPositionDecoder)) {
      const decoder = this.sdk.getPositionDecoder();
      if (decoder?.decode) {
        return (_, accountInfo) => decoder.decode(accountInfo.data);
      }
    }
    return null;
  }

  _decodePositionAccount(address, info) {
    if (!this._positionDecoder) return null;
    try {
      return this._positionDecoder(address, info);
    } catch (err) {
      console.warn("⚠️  Failed to decode position account:", err.message);
      return null;
    }
  }

  /**
   * Derives a Position PDA for a specific market, collateral, and side
   * Caches results to avoid redundant derivations
   */
  _derivePositionPda(custody, collateralCustody, side) {
    const cacheKey = `${custody.toBase58()}:${collateralCustody.toBase58()}:${side}`;
    if (this._positionPdaCache.has(cacheKey)) {
      return this._positionPdaCache.get(cacheKey);
    }
    const pda = derivePositionPda(this.wallet.publicKey, this.pool, custody, collateralCustody, side, PROGRAM_ID);
    this._positionPdaCache.set(cacheKey, pda);
    return pda;
  }

  /**
   * Derives a PositionRequest PDA for a specific market, collateral, side, and counter
   * Each counter creates a unique request PDA
   * @param {PublicKey} positionPda - Position account
   * @param {number|bigint} counter - Random counter for uniqueness
   * @param {string|number} requestChange - 'increase'/1 or 'decrease'/2
   */
  _derivePositionRequestPda(positionPda, counter, requestChange) {
    const cacheKey = `${positionPda.toBase58()}:${counter}:${requestChange}`;
    if (this._positionRequestPdaCache.has(cacheKey)) {
      return this._positionRequestPdaCache.get(cacheKey);
    }
    const pda = derivePositionRequestPda(positionPda, counter, requestChange, PROGRAM_ID);
    this._positionRequestPdaCache.set(cacheKey, pda);
    return pda;
  }

  async _manualGetUserState(walletPk) {
    const owner = walletPk instanceof PublicKey ? walletPk : new PublicKey(walletPk);
    
    // Build list of all possible position PDAs for this user across all markets and sides
    const positionPdas = [];
    const positionMetadata = []; // Track market and side for each PDA
    
    for (const marketKey of Object.keys(MARKET_REGISTRY)) {
      const market = MARKET_REGISTRY[marketKey];
      for (const side of ["long", "short"]) {
        const collateralCustody = side === "long" ? market.custody : COLLATERAL.custody;
        const positionPda = derivePositionPda(owner, this.pool, market.custody, collateralCustody, side, PROGRAM_ID);
        positionPdas.push(positionPda);
        positionMetadata.push({ marketKey, market, side, collateralCustody });
      }
    }
    
    // Batch fetch position accounts in chunks of 4 (RPC limit is 5, using 4 to be safe)
    // This avoids hitting the "getMultipleAccounts is limited to a 5 range" error
    const BATCH_SIZE = 4;
    const BATCH_DELAY_MS = 200; // Delay between batches to avoid rate limits
    let accountsInfo = [];
    
    try {
      // Process in batches with delays to avoid 429 rate limits
      for (let i = 0; i < positionPdas.length; i += BATCH_SIZE) {
        const batch = positionPdas.slice(i, i + BATCH_SIZE);
        
        // Add delay between batches (except for the first one) to avoid rate limiting
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
        
        const batchResults = await this.connection.getMultipleAccountsInfo(batch, 'confirmed');
        accountsInfo.push(...batchResults);
      }
    } catch (error) {
      console.warn(`⚠️  Failed to batch fetch position accounts: ${error.message}. Falling back to sequential queries with rate limiting...`);
      // Fallback to SEQUENTIAL queries with delays to avoid rate limiting
      // When using public RPC, parallel requests trigger 429 errors immediately
      accountsInfo = [];
      const QUERY_DELAY_MS = 500; // 500ms delay between requests to avoid rate limits
      for (let i = 0; i < positionPdas.length; i++) {
        const pda = positionPdas[i];
        try {
          // Add delay between requests (except for the first one)
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, QUERY_DELAY_MS));
          }
          const info = await this._getAccountInfoWithFailover(pda, 'confirmed');
          accountsInfo.push(info);
        } catch (err) {
          console.warn(`⚠️  Failed to fetch position account ${pda.toBase58().slice(0, 8)}...: ${err.message}`);
          accountsInfo.push(null);
        }
      }
    }
    
    // Process all found positions
    const positions = [];
    for (let i = 0; i < accountsInfo.length; i++) {
      const info = accountsInfo[i];
      if (!info) continue; // Account doesn't exist or fetch failed
      
      const { marketKey, market, side, collateralCustody } = positionMetadata[i];
      const positionPda = positionPdas[i];
      
      try {
        const decoded = this._decodePositionAccount(positionPda, info);
        if (!decoded) {
          console.warn(`⚠️  Failed to decode position account ${positionPda.toBase58().slice(0, 8)}... for ${marketKey} ${side}`);
          continue;
        }
        
        const formatted = this._formatDecodedPosition(decoded, owner, positionPda, marketKey, market.custody);
        if (!formatted) {
          console.warn(`⚠️  Failed to format position account ${positionPda.toBase58().slice(0, 8)}... for ${marketKey} ${side}`);
          continue;
        }
        
        const sizeUsd = Number(formatted.sizeUsd || 0);
        if (sizeUsd > 0) {
          positions.push(formatted);
          console.log(`✅ Found position: ${positionPda.toBase58().slice(0, 8)}... (${marketKey}, ${formatted.side}, size: $${sizeUsd.toFixed(2)})`);
        }
      } catch (error) {
        console.warn(`⚠️  Error processing position account ${positionPda.toBase58().slice(0, 8)}... for ${marketKey} ${side}: ${error.message}`);
      }
    }
    
    console.log(`📊 Total positions found: ${positions.length} across ${new Set(positions.map(p => p.marketSymbol)).size} market(s)`);
    return { positions };
  }

  _formatDecodedPosition(data, owner, address, marketSymbol = null, marketCustody = null) {
    if (!data) return null;
    const toNumber = (val) => Number(val ?? 0n) / 1_000_000;
    const toStringValue = (val) =>
      typeof val === "bigint" ? val.toString() : (val && val.toString ? val.toString() : String(val ?? ""));
    // Side enum: None=0, Long=1, Short=2
    const sideValue = typeof data.side === "string"
      ? data.side
      : typeof data.side === "number"
        ? (data.side === 2 ? "short" : data.side === 1 ? "long" : "none")
        : "long";
    
    // Determine market symbol from provided param or custody address
    let finalMarketSymbol = marketSymbol || this.marketSymbol || "SOL-PERP";
    if (!marketSymbol && marketCustody) {
      // Find market symbol from custody address
      for (const [key, market] of Object.entries(MARKET_REGISTRY)) {
        if (market.custody.equals(marketCustody)) {
          finalMarketSymbol = key;
          break;
        }
      }
    }
    
    const marketAddress = marketCustody?.toBase58?.() || marketCustody?.toString?.() || this.market?.address?.toString?.() || this.market?.custody?.toString?.();
    
    return {
      owner: owner?.toBase58?.() || null,
      address: address?.toBase58?.() || null,
      id: address?.toBase58?.() || null,
      positionId: address?.toBase58?.() || null,
      market: marketAddress,
      marketSymbol: finalMarketSymbol,
      side: sideValue.toUpperCase(),
      sizeUsd: toNumber(data.sizeUsd),
      collateralUsd: toNumber(data.collateralUsd),
      entryPrice: toNumber(data.price),
      updateTime: Number(data.updateTime ?? data.openTime ?? 0),
      raw: {
        sizeUsd: toStringValue(data.sizeUsd),
        collateralUsd: toStringValue(data.collateralUsd),
        price: toStringValue(data.price),
      },
    };
  }

  async _manualCreateIncreaseRequest(req = {}) {
    const builderStart = Date.now();
    this._recordTelemetry({
      stage: "builder_start",
      type: "increase",
      market: this.marketSymbol,
      side: req.side,
      collateralUsd: req.collateralUsd,
      leverage: req.leverage,
    });
    const market = req.market?.symbol ? this._formatManualMarket(req.market.symbol) : this._formatManualMarket(this.marketSymbol);
    const side = (req.side || "long").toLowerCase().includes("short") ? "short" : "long";
    const collateralUsd = Number(req.collateralUsd || req.collateral || 0);
    const leverage = Number(req.leverage || 1);
    if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) {
      throw new Error("Invalid collateral amount for manual increase request");
    }
    if (!Number.isFinite(leverage) || leverage <= 0) {
      throw new Error("Invalid leverage for manual increase request");
    }

    // Build increase position transaction
    console.log(`[MANUAL_BUILDER] Building increase position manually...`);
    const owner = this.wallet.publicKey;
    // Side enum: None=0, Long=1, Short=2
    const sideNum = side === "short" ? 2 : 1;
    
    // Derive collateral custody based on side and user preference
    // IMPORTANT: Jupiter Perps program requires LONG positions to use market asset as collateral
    // However, we can deposit USDC and let the program swap it to the market asset
    // For SHORT positions, USDC is always used as collateral
    let collateralCustody;
    // More robust check for USE_USDC_COLLATERAL_ALWAYS (handle whitespace, case, etc.)
    const useUsdcEnv = String(process.env.USE_USDC_COLLATERAL_ALWAYS || '').trim().toLowerCase();
    const useUsdcForAll = useUsdcEnv === 'true' || useUsdcEnv === '1' || process.env.TEST_COLLATERAL_MODE === 'always_usdc';
    console.log(`🔍 [COLLATERAL_CHECK] USE_USDC_COLLATERAL_ALWAYS="${process.env.USE_USDC_COLLATERAL_ALWAYS}" → parsed as: ${useUsdcForAll}`);
    
    if (useUsdcForAll && side === "long") {
      // User wants USDC, but program requires market asset for LONG
      // We'll deposit USDC (inputMint) and let program swap to market asset (collateralCustody)
      collateralCustody = market.custody; // Program requirement for LONG
      console.log('✅ Using USDC as input (will be swapped to market asset for LONG position)');
    } else if (useUsdcForAll && side === "short") {
      // SHORT positions can use USDC directly
      collateralCustody = COLLATERAL.custody;
      console.log('✅ Using USDC custody for SHORT position');
    } else {
      // Standard perps flow: Longs use market asset, shorts use USDC
      collateralCustody = side === "long" ? market.custody : COLLATERAL.custody;
      console.log(`✅ Using ${side === 'long' ? 'market asset' : 'USDC'} as collateral (standard perps flow)`);
    }
    
    // Generate unique counter for this request
    const counter = this._nextRequestCounter();
    
    // Derive position and position request PDAs with correct seeds
    const positionPda = this._derivePositionPda(market.custody, collateralCustody, side);
    const positionRequestPda = this._derivePositionRequestPda(positionPda, counter, 'increase');
    
    // CRITICAL FIX: Update _positionPda so keeper subscription watches the correct account
    // This was previously null, causing the keeper subscription to silently fail
    // and forcing reliance on slow polling (900ms interval)
    this._positionPda = positionPda;
    // Reset keeper subscription to force re-subscribe to new position account
    if (this._keeperSubId !== null) {
      try {
        await this.connection.removeAccountChangeListener(this._keeperSubId);
      } catch (e) {
        console.warn('⚠️  Failed to remove old keeper subscription:', e.message);
      }
      this._keeperSubId = null;
    }
    
    console.log('🔍 PDA Derivation Debug:');
    console.log('   Position PDA:', positionPda.toBase58());
    console.log('   Position Request PDA:', positionRequestPda.toBase58());
    console.log('   Counter:', counter);
    console.log('   Request Change: increase (1)');
    
    // Determine inputMint based on user preference
    // If USE_USDC_COLLATERAL_ALWAYS=true, always use USDC as input (even for LONG positions)
    // The program will swap USDC → market asset for LONG positions automatically
    let inputMint;
    const testInputMint = String(process.env.TEST_INPUT_MINT || '').trim();
    if (testInputMint === 'market_mint') {
      console.log('🧪 TEST MODE: Using market mint as inputMint (TEST_INPUT_MINT override)');
      inputMint = market.mint;
    } else if (testInputMint === 'collateral_mint') {
      console.log('🧪 TEST MODE: Using collateral custody mint as inputMint (TEST_INPUT_MINT override)');
      inputMint = collateralCustody === COLLATERAL.custody ? COLLATERAL.mint : market.mint;
    } else if (useUsdcForAll) {
      // User wants USDC for all positions - FORCE USDC regardless of side
      inputMint = COLLATERAL.mint;
      console.log(`✅ [FORCED] Using USDC as inputMint (USE_USDC_COLLATERAL_ALWAYS=true, side=${side})`);
      console.log(`   USDC Mint: ${COLLATERAL.mint.toBase58()}`);
      console.log(`   Market Mint: ${market.mint.toBase58()}`);
    } else {
      // Standard flow: Match inputMint to collateral custody mint (no swap needed)
      inputMint = collateralCustody === COLLATERAL.custody ? COLLATERAL.mint : market.mint;
      const inputMintSymbol = inputMint.equals(COLLATERAL.mint) ? 'USDC' : market.symbol.split('-')[0];
      console.log(`✅ Using ${inputMintSymbol} as inputMint (matches collateral custody, no swap needed)`);
    }
    
    // CRITICAL VALIDATION: Ensure we're using USDC if USE_USDC_COLLATERAL_ALWAYS is set
    if (useUsdcForAll && !inputMint.equals(COLLATERAL.mint)) {
      console.error(`❌ [ERROR] USE_USDC_COLLATERAL_ALWAYS=true but inputMint is ${inputMint.toBase58()} (expected USDC: ${COLLATERAL.mint.toBase58()})`);
      console.error(`   This is a bug - forcing USDC mint...`);
      inputMint = COLLATERAL.mint;
      console.log(`✅ [FIXED] Forced inputMint to USDC: ${inputMint.toBase58()}`);
    }
    
    const fundingAta = getAssociatedTokenAddressSync(
      inputMint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const positionRequestAta = getAssociatedTokenAddressSync(
      inputMint,
      positionRequestPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const instructions = [];
    const ataOwnerIx = await this._ensureAta(fundingAta, owner, inputMint);
    if (ataOwnerIx) instructions.push(ataOwnerIx);
    const ataReqIx = await this._ensureAta(positionRequestAta, positionRequestPda, inputMint, true);
    if (ataReqIx) instructions.push(ataReqIx);

    const builder = this._builders?.increase;
    if (!isFn(builder)) throw new Error("Manual increase builder unavailable");

    const slippageBps = Number.isFinite(req.slippageBps) ? req.slippageBps : this.slippageBps || 50;
    const sizeUsdDelta = this._usdToU64(collateralUsd * leverage);
    // FIX: Declare collateralTokenDelta BEFORE it's used in balance verification
    const collateralTokenDelta = this._usdToU64(collateralUsd);
    
    // CRITICAL: Verify funding account has sufficient balance before building transaction
    // This prevents "insufficient funds" errors during simulation
    try {
      const fundingAccountInfo = await this._getAccountInfoWithFailover(fundingAta);
      if (!fundingAccountInfo) {
        throw new Error(`Funding account ATA does not exist: ${fundingAta.toBase58()}. ATA creation instruction should have been above.`);
      }
      
      // Parse token account balance
      const tokenAccountData = fundingAccountInfo.data;
      const balanceBytes = tokenAccountData.slice(64, 72);
      const currentBalance = Number(BigInt('0x' + Buffer.from(balanceBytes).reverse().toString('hex')));
      
      // Get token decimals to calculate required amount properly
      const { getMint } = require('@solana/spl-token');
      let tokenDecimals = 6; // Default to USDC decimals
      try {
        const mintInfo = await getMint(this.connection, inputMint);
        tokenDecimals = mintInfo.decimals;
      } catch (err) {
        console.warn(`⚠️  Could not fetch mint info for ${inputMint.toBase58()}, assuming ${tokenDecimals} decimals`);
      }
      
      // Calculate required token amount based on actual token decimals
      // collateralTokenDelta is in USD terms (6 decimals), but we need actual token amount
      let requiredTokenAmount;
      if (inputMint.equals(COLLATERAL.mint)) {
        // USDC: 1 USD = 1 USDC, so collateralTokenDelta is already correct
        requiredTokenAmount = Number(collateralTokenDelta);
      } else {
        // For other tokens, need to convert USD to token amount using current price
        const currentPrice = await this._fetchOraclePrice(market.oracleAccount);
        if (!currentPrice || currentPrice === 0) {
          throw new Error(`Failed to fetch oracle price for balance verification`);
        }
        // Convert USD collateral to token amount
        const tokenAmountUsd = Number(collateralTokenDelta) / 1e6; // Convert from 6 decimals to USD
        requiredTokenAmount = Math.ceil((tokenAmountUsd / currentPrice) * Math.pow(10, tokenDecimals));
      }
      
      if (currentBalance < requiredTokenAmount) {
        const currentBalanceFormatted = currentBalance / Math.pow(10, tokenDecimals);
        const requiredFormatted = requiredTokenAmount / Math.pow(10, tokenDecimals);
        const tokenSymbol = inputMint.equals(COLLATERAL.mint) ? 'USDC' : market.symbol.split('-')[0];
        throw new Error(
          `Insufficient token balance in funding account: ` +
          `${currentBalanceFormatted.toFixed(6)} ${tokenSymbol} (required: ${requiredFormatted.toFixed(6)} ${tokenSymbol} for ${collateralUsd} USD collateral). ` +
          `Funding account: ${fundingAta.toBase58()}`
        );
      }
      
      console.log(`✅ Funding account balance verified: ${(currentBalance / Math.pow(10, tokenDecimals)).toFixed(6)} tokens (required: ${(requiredTokenAmount / Math.pow(10, tokenDecimals)).toFixed(6)})`);
    } catch (error) {
      if (error.message.includes('Insufficient token balance')) {
        throw error; // Re-throw balance errors
      }
      console.warn(`⚠️  Could not verify funding account balance: ${error.message}. Proceeding anyway...`);
    }
    
    // Calculate priceSlippage as actual USD price (not basis points!)
    // For LONG: max acceptable price = currentPrice * (1 + slippage%)
    // For SHORT: min acceptable price = currentPrice * (1 - slippage%)
    let priceSlippageU64;
    
    // Fetch actual oracle price - REQUIRED, no fallbacks
    if (!market.oracleAccount) {
      throw new Error(`No oracle account configured for ${market.symbol}`);
    }
    
    const currentPrice = await this._fetchOraclePrice(market.oracleAccount);
    if (!currentPrice || currentPrice === 0) {
      throw new Error(`Failed to fetch oracle price for ${market.symbol}. Cannot open position without valid price.`);
    }
    
    console.log(`📊 Using oracle price for ${market.symbol}: $${currentPrice.toFixed(2)}`);
    
    // Calculate price with slippage
    const slippageMultiplier = side === "long" 
      ? (1 + slippageBps / 10000)  // Long: max acceptable price
      : (1 - slippageBps / 10000); // Short: min acceptable price
    
    const priceWithSlippage = currentPrice * slippageMultiplier;
    priceSlippageU64 = BigInt(Math.floor(priceWithSlippage * 1_000_000));
    
    console.log(`✅ Price Slippage Calculated:`);
    console.log(`   Current Price: $${currentPrice.toFixed(2)}`);
    console.log(`   Slippage: ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%)`);
    console.log(`   Price with Slippage: $${priceWithSlippage.toFixed(2)}`);
    console.log(`   U64 Value: ${priceSlippageU64}`);
    
    // Get collateral custody mint to check if swap is needed
    const collateralCustodyMint = this._getCollateralCustodyMint(collateralCustody);
    const swapNeeded = collateralCustodyMint && !inputMint.equals(collateralCustodyMint);
    
    // Fetch jupiterMinimumOut only if swap is required
    // For standard perps positions (LONG with market asset, SHORT with USDC), no swap is needed
    let jupiterMinimumOut = null;
    if (swapNeeded && collateralCustodyMint) {
      console.log(`🔄 Swap required: ${inputMint.toBase58()} → ${collateralCustodyMint.toBase58()}`);
      console.log(`   Fetching jupiterMinimumOut from Jupiter Quote API...`);
      jupiterMinimumOut = await this._fetchJupiterMinimumOut(
        inputMint,
        collateralCustodyMint,
        collateralTokenDelta,
        slippageBps
      );
      if (jupiterMinimumOut) {
        console.log(`✅ jupiterMinimumOut: ${jupiterMinimumOut.toString()}`);
      } else {
        console.warn(`⚠️  Failed to fetch jupiterMinimumOut, transaction may fail if swap is required`);
      }
    } else {
      console.log(`✅ No swap needed: inputMint matches collateral custody mint`);
    }
    
    console.log("📊 Instruction Parameters:");
    console.log(`   collateralUsd: ${collateralUsd}`);
    console.log(`   leverage: ${leverage}`);
    console.log(`   sizeUsdDelta: ${sizeUsdDelta}`);
    console.log(`   collateralTokenDelta: ${collateralTokenDelta}`);
    console.log(`   side: ${side} (${sideNum})`);
    console.log(`   slippageBps: ${slippageBps} bps`);
    console.log(`   priceSlippage (U64): ${priceSlippageU64}`);
    console.log(`   collateralCustody: ${collateralCustody.toBase58()}`);
    console.log(`   inputMint: ${inputMint.toBase58()}`);
    console.log(`   swapNeeded: ${swapNeeded}`);
    console.log(`   jupiterMinimumOut: ${jupiterMinimumOut ? jupiterMinimumOut.toString() : 'null'}`);
    
    const builderInput = {
        owner,
        fundingAccount: fundingAta,
        perpetuals: this._perpetualsPda,
        pool: POOL_ADDRESS,
        position: positionPda,
        positionRequest: positionRequestPda,
        positionRequestAta,
        custody: market.custody,
        collateralCustody: collateralCustody,
        inputMint: inputMint,
        referral: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        eventAuthority: this._eventAuthorityPda,
        program: PROGRAM_ID,
        sizeUsdDelta,
        collateralTokenDelta,
        side: sideNum,
        priceSlippage: priceSlippageU64,
        jupiterMinimumOut: jupiterMinimumOut,
        counter: BigInt(counter),
      };
    console.log("[BUILDER_ARGS][increase]", {
      sizeUsdDelta: Number(sizeUsdDelta),
      collateralTokenDelta: Number(collateralTokenDelta),
      sideNum,
      priceSlippageU64: priceSlippageU64.toString(),
      jupiterMinimumOut: jupiterMinimumOut ? jupiterMinimumOut.toString() : null,
      counter,
    });
    let ix;
    try {
      ix = builder(builderInput, { programAddress: PROGRAM_ID.toBase58() });
    } catch (err) {
      this._recordTelemetry({
        stage: "builder_error",
        type: "increase",
        error: err.message,
      });
      console.error("❌ SDK builder error:", err.message);
      console.error("Builder args:", {
        owner: owner.toBase58(),
        fundingAccount: fundingAta.toBase58(),
        perpetuals: this._perpetualsPda.toBase58(),
        pool: POOL_ADDRESS.toBase58(),
        position: positionPda.toBase58(),
        positionRequest: positionRequestPda.toBase58(),
        positionRequestAta: positionRequestAta.toBase58(),
        custody: market.custody.toBase58(),
        collateralCustody: collateralCustody.toBase58(),
        inputMint: inputMint.toBase58(),
        inputMintIsUSDC: inputMint.equals(COLLATERAL.mint),
        side: side,
        sideNum: sideNum,
        counter: counter,
        useUsdcForAll: useUsdcForAll,
      });
      throw err;
    }

    const mainIx = this._toTransactionInstruction(ix);
    
    // Ensure critical accounts are marked as writable
    // - position: will be created/updated by the program
    // - positionRequest: will be created by the program
    // - fundingAccount: will be debited for collateral
    for (const key of mainIx.keys) {
      if (key.pubkey.equals(positionPda) || key.pubkey.equals(positionRequestPda) || key.pubkey.equals(fundingAta)) {
        key.isWritable = true;
      }
    }
    
    instructions.push(mainIx);
    const tx = new Transaction();
    for (const instruction of instructions) {
      tx.add(instruction);
    }
    this._recordTelemetry({
      stage: "builder_success",
      type: "increase",
      durationMs: Date.now() - builderStart,
      instructions: tx.instructions.length,
      ataInstructions: instructions.length - 1, // best effort
    });
    
    // Return both transaction and positionPda so caller can pre-register position in DB
    return { tx, positionPda: positionPda.toBase58() };
  }

  async _manualCreateDecreaseRequest(req = {}) {
    const owner = this.wallet.publicKey;
    
    const builder = this._builders?.decrease;
    if (!isFn(builder)) throw new Error("Manual decrease builder unavailable");

    // CRITICAL FIX: Refresh position data right before building transaction
    // This ensures we have the latest position state (important for funding fees, etc.)
    // Similar to how open position works - we fetch fresh data when needed
    const current = await this._manualGetUserState(owner);
    const allPositions = current.positions || [];
    
    // CRITICAL FIX: Find the CORRECT position to close based on targetPosition
    // This prevents closing the wrong position when multiple positions exist on same market (long + short)
    let activePos = null;
    
    if (req.targetPosition) {
      // Target position provided - match by side (and optionally market/positionId)
      const targetSide = String(req.targetPosition.side || '').toLowerCase();
      const targetMarket = req.targetPosition.market || null;
      const targetPosId = req.targetPosition.positionId || req.targetPosition.address || null;
      
      console.log(`[DECREASE_REQUEST] Looking for position: side=${targetSide}, market=${targetMarket || 'any'}, posId=${targetPosId?.slice(0, 8) || 'any'}...`);
      
      // First, try to match by positionId if available
      if (targetPosId) {
        activePos = allPositions.find(p => {
          const posId = p.positionId || p.address || p.id || '';
          return posId === targetPosId || posId.startsWith(targetPosId) || targetPosId.startsWith(posId);
        });
      }
      
      // If not found by positionId, match by side (and optionally market)
      if (!activePos && targetSide) {
        activePos = allPositions.find(p => {
          const posSide = String(p.side || '').toLowerCase();
          const posMarket = p.market || p.marketSymbol || null;
          
          // Must match side
          if (posSide !== targetSide && posSide !== (targetSide === 'long' ? '1' : '2')) {
            return false;
          }
          
          // Optionally match market if specified
          if (targetMarket && posMarket) {
            return posMarket.toUpperCase() === targetMarket.toUpperCase();
          }
          
          return true;
        });
      }
      
      if (activePos) {
        console.log(`✅ [DECREASE_REQUEST] Found matching position: side=${activePos.side}, market=${activePos.market || activePos.marketSymbol || 'unknown'}`);
      } else {
        console.warn(`⚠️  [DECREASE_REQUEST] No position found matching target (side=${targetSide}). Falling back to first position.`);
      }
    }
    
    // Fallback to first position if no match found (legacy behavior)
    if (!activePos) {
      activePos = allPositions[0];
    }
    
    // Legacy support for positionOverride
    if (!activePos && req.positionOverride) {
      activePos = req.positionOverride;
    }
    
    if (!activePos) {
      throw new Error("No open manual position to close");
    }
    
    // Log which position we're closing for audit trail
    console.log(`[DECREASE_REQUEST] Closing position: side=${activePos.side}, market=${activePos.market || activePos.marketSymbol || 'unknown'}, size=${activePos.sizeUsd || activePos.size || 'unknown'}`);
    if (allPositions.length > 1) {
      console.log(`   (${allPositions.length} total positions on wallet - closing only the matched one)`);
    }
    
    // CRITICAL FIX: Determine the market from the position data, not from this.market
    // The position might be in a different market than the client's default market
    let positionMarketSymbol = activePos.marketSymbol;
    
    // If marketSymbol is not directly available, try to determine it from market address/custody
    if (!positionMarketSymbol || !MARKET_REGISTRY[positionMarketSymbol]) {
      const marketAddress = activePos.market || activePos.marketPk || activePos.marketAddress || activePos.custody;
      if (marketAddress) {
        // Convert to PublicKey for comparison if needed
        let marketPk;
        try {
          marketPk = marketAddress instanceof PublicKey ? marketAddress : new PublicKey(marketAddress);
        } catch (e) {
          // If it's not a valid PublicKey, try string matching
          marketPk = null;
        }
        
        // Find market by matching custody address (exact match)
        for (const [key, market] of Object.entries(MARKET_REGISTRY)) {
          if (marketPk && market.custody && market.custody.equals(marketPk)) {
            positionMarketSymbol = key;
            break;
          } else if (!marketPk) {
            // Fallback to string comparison
            const marketAddr = market.custody?.toString() || market.address?.toString();
            if (marketAddr && String(marketAddress) === marketAddr) {
              positionMarketSymbol = key;
              break;
            }
          }
        }
      }
    }
    
    // Default to current market if still not found
    if (!positionMarketSymbol || !MARKET_REGISTRY[positionMarketSymbol]) {
      positionMarketSymbol = this.marketSymbol;
      console.warn(`⚠️  Could not determine position market from position data, using current market: ${positionMarketSymbol}`);
    } else {
      // Switch to the position's market if it's different from current market
      if (positionMarketSymbol.toUpperCase() !== this.marketSymbol.toUpperCase()) {
        console.log(`🔄 Switching market context for close: ${this.marketSymbol} → ${positionMarketSymbol.toUpperCase()}`);
        this._switchMarket(positionMarketSymbol);
      }
    }
    
    // Determine side from active position FIRST (needed for PDA derivation)
    const side = activePos.side === "short" || activePos.side === 2 || (typeof activePos.side === 'string' && activePos.side.toUpperCase() === 'SHORT') ? "short" : "long";
    // Side enum: None=0, Long=1, Short=2
    const sideNum = side === "short" ? 2 : 1;
    
    // Derive collateral custody based on side (now using correct market)
    const collateralCustody = side === "long" ? this.market.custody : COLLATERAL.custody;
    
    // Derive position PDA to fetch fresh position data directly from chain (now using correct market)
    const positionPda = this._derivePositionPda(this.market.custody, collateralCustody, side);
    
    // CRITICAL FIX: Fetch fresh position data directly from chain right before building
    // This matches the pattern used in open position and ensures we have the latest state
    let freshPositionData = null;
    try {
      const positionInfo = await this._getAccountInfoWithFailover(positionPda);
      if (positionInfo) {
        const decoded = this._decodePositionAccount(positionPda, positionInfo);
        // Pass the correct market symbol and custody to ensure proper formatting
        freshPositionData = this._formatDecodedPosition(decoded, owner, positionPda, positionMarketSymbol, this.market.custody);
        if (freshPositionData && Number(freshPositionData.sizeUsd || 0) > 0) {
          // Use fresh data from chain
          activePos = freshPositionData;
          console.log(`✅ Fetched fresh position data from chain`);
        }
      }
    } catch (err) {
      console.warn(`⚠️  Could not fetch fresh position data, using cached: ${err.message}`);
    }
    
    // CRITICAL FIX: Ensure position has valid size/collateral data
    // Position data format may vary, so we need to handle multiple field names
    const sizeUsd = Number(activePos.sizeUsd ?? activePos.size ?? 0);
    const collateralUsd = Number(activePos.collateralUsd ?? activePos.collateral ?? 0);
    
    // Validate position data - both must be > 0
    if (sizeUsd <= 0 || collateralUsd <= 0) {
      console.error(`❌ Invalid position data: sizeUsd=${sizeUsd}, collateralUsd=${collateralUsd}`);
      console.error(`   Position data:`, JSON.stringify(activePos, null, 2));
      throw new Error(`Invalid position data: size=${sizeUsd}, collateral=${collateralUsd}. Position may be already closed or data corrupted.`);
    }
    
    console.log(`📊 Position data for close: sizeUsd=${sizeUsd.toFixed(2)}, collateralUsd=${collateralUsd.toFixed(2)}`);

    // Build decrease position transaction
    console.log(`[MANUAL_BUILDER] Building decrease position manually...`);
    
    // Generate unique counter for this request
    const counter = this._nextRequestCounter();
    
    // Derive position request PDA with correct seeds
    const positionRequestPda = this._derivePositionRequestPda(positionPda, counter, 'decrease');
    
    // CRITICAL FIX: Update _positionPda for keeper subscription (same as increase)
    this._positionPda = positionPda;
    // Reset keeper subscription to watch the correct position
    if (this._keeperSubId !== null) {
      try {
        await this.connection.removeAccountChangeListener(this._keeperSubId);
      } catch (e) {
        console.warn('⚠️  Failed to remove old keeper subscription:', e.message);
      }
      this._keeperSubId = null;
    }
    
    const receivingAta = getAssociatedTokenAddressSync(
      COLLATERAL.mint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const positionRequestAta = getAssociatedTokenAddressSync(
      COLLATERAL.mint,
      positionRequestPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const instructions = [];
    const ataOwnerIx = await this._ensureAta(receivingAta, owner, COLLATERAL.mint);
    if (ataOwnerIx) instructions.push(ataOwnerIx);
    const ataReqIx = await this._ensureAta(positionRequestAta, positionRequestPda, COLLATERAL.mint, true);
    if (ataReqIx) instructions.push(ataReqIx);

    const slippageBps = Number.isFinite(req.slippageBps) ? req.slippageBps : this.slippageBps || 50;
    
    // Calculate priceSlippage as actual USD price (not basis points!)
    // For closing LONG: min acceptable price = currentPrice * (1 - slippage%)
    // For closing SHORT: max acceptable price = currentPrice * (1 + slippage%)
    let priceSlippageU64;
    
    // Fetch current oracle price - REQUIRED, no fallbacks
    if (!this.market.oracleAccount) {
      throw new Error(`No oracle account configured for ${this.market.symbol}`);
    }
    
    const currentPrice = await this._fetchOraclePrice(this.market.oracleAccount);
    if (!currentPrice || currentPrice === 0) {
      throw new Error(`Failed to fetch oracle price for ${this.market.symbol}. Cannot close position without valid price.`);
    }
    
    console.log(`📊 Using oracle price for ${this.market.symbol} (close): $${currentPrice.toFixed(2)}`);
    
    // Calculate price with slippage
    const slippageMultiplier = side === "long" 
      ? (1 - slippageBps / 10000)  // Long close: min acceptable price
      : (1 + slippageBps / 10000); // Short close: max acceptable price
    
    const priceWithSlippage = currentPrice * slippageMultiplier;
    priceSlippageU64 = BigInt(Math.floor(priceWithSlippage * 1_000_000));
    
    console.log(`✅ Close Price Slippage Calculated:`);
    console.log(`   Current Price: $${currentPrice.toFixed(2)}`);
    console.log(`   Slippage: ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%)`);
    console.log(`   Price with Slippage: $${priceWithSlippage.toFixed(2)}`);
    console.log(`   U64 Value: ${priceSlippageU64}`);
    
    // For close operations with entirePosition=true, jupiterMinimumOut should be null
    // The program handles the swap internally without needing this parameter
    const jupiterMinimumOut = null;
    
    // CRITICAL FIX: When closing entire position (entirePosition=true), the program expects:
    // - sizeUsdDelta: full position size (non-zero)
    // - collateralUsdDelta: 0 (the program calculates the actual collateral to return)
    // The error "Left: 0" vs "Right: 85901810" indicates the program validates collateralUsdDelta=0
    // for entire position closes. Setting it to the full collateral amount causes InvalidArgument error.
    const sizeUsdDelta = this._usdToU64(sizeUsd);
    // Set collateralUsdDelta to 0 for entire position closes (program requirement)
    const collateralUsdDelta = BigInt(0);
    
    // Validate sizeUsdDelta is non-zero
    if (sizeUsdDelta === BigInt(0)) {
      throw new Error(`Invalid position size: sizeUsdDelta=0 (position size: ${sizeUsd.toFixed(2)} USD). Position may already be closed or data is invalid.`);
    }
    
    console.log(`📊 Close Request Parameters:`);
    console.log(`   Position sizeUsd: ${sizeUsd.toFixed(2)} USD`);
    console.log(`   Position collateralUsd: ${collateralUsd.toFixed(2)} USD`);
    console.log(`   collateralUsdDelta (u64): ${collateralUsdDelta.toString()} (0 for entire position close - program calculates actual return)`);
    console.log(`   sizeUsdDelta (u64): ${sizeUsdDelta.toString()} (full position size)`);
    console.log(`   entirePosition: true`);
    console.log(`   priceSlippage (u64): ${priceSlippageU64.toString()}`);
    console.log(`   counter: ${counter.toString()}`);
    
    // Build instruction with detailed error handling
    let ix;
    try {
      ix = builder({
        owner,
        receivingAccount: receivingAta,
        perpetuals: this._perpetualsPda,
        pool: POOL_ADDRESS,
        position: positionPda,
        positionRequest: positionRequestPda,
        positionRequestAta,
        custody: this.market.custody,
        collateralCustody: collateralCustody,
        desiredMint: COLLATERAL.mint,
        referral: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        eventAuthority: this._eventAuthorityPda,
        program: PROGRAM_ID,
        collateralUsdDelta: collateralUsdDelta,
        sizeUsdDelta: sizeUsdDelta,
        priceSlippage: priceSlippageU64,
        jupiterMinimumOut: jupiterMinimumOut ? BigInt(jupiterMinimumOut) : null,
        entirePosition: true,
        counter: BigInt(counter),
      }, { programAddress: PROGRAM_ID.toBase58() });
    } catch (builderError) {
      console.error(`❌ Builder error when creating decrease position request:`, builderError.message);
      console.error(`   Position data: sizeUsd=${sizeUsd}, collateralUsd=${collateralUsd}`);
      console.error(`   Calculated deltas: sizeUsdDelta=${sizeUsdDelta.toString()}, collateralUsdDelta=${collateralUsdDelta.toString()}`);
      throw new Error(`Failed to build decrease position instruction: ${builderError.message}`);
    }

    const mainIx = this._toTransactionInstruction(ix);
    
    // Ensure critical accounts are marked as writable
    // - position: will be updated by the program
    // - positionRequest: will be created by the program
    // - receivingAccount: will be credited with returned collateral
    for (const key of mainIx.keys) {
      if (key.pubkey.equals(positionPda) || key.pubkey.equals(positionRequestPda) || key.pubkey.equals(receivingAta)) {
        key.isWritable = true;
      }
    }
    
    instructions.push(mainIx);
    const tx = new Transaction();
    for (const instruction of instructions) {
      tx.add(instruction);
    }
    
    return tx;
  }

  _normalizeAccountMeta(meta) {
    if (!meta) return null;
    let pk = null;
    if (meta.pubkey) {
      pk = meta.pubkey;
    } else if (meta.publicKey) {
      pk = meta.publicKey;
    } else if (meta.address) {
      pk = meta.address;
    } else if (typeof meta === "string") {
      pk = meta;
    } else if (meta instanceof PublicKey) {
      pk = meta;
    }
    if (!pk) return null;
    const pubkey = pk instanceof PublicKey ? pk : new PublicKey(pk);
    const isSigner =
      typeof meta.isSigner === "boolean"
        ? meta.isSigner
        : typeof meta.signer === "boolean"
        ? meta.signer
        : false;
    const isWritable =
      typeof meta.isWritable === "boolean"
        ? meta.isWritable
        : typeof meta.writable === "boolean"
        ? meta.writable
        : false;
    return { pubkey, isSigner, isWritable };
  }

  _toTransactionInstruction(ix) {
    if (!ix) throw new Error("Empty instruction payload");
    const programIdValue = ix.programId || ix.programAddress || ix.program || PROGRAM_ID;
    const programId = programIdValue instanceof PublicKey ? programIdValue : new PublicKey(programIdValue);
    const rawKeys = ix.accounts || ix.keys || [];
    const keys = [];
    for (const rawMeta of rawKeys) {
      const meta = this._normalizeAccountMeta(rawMeta);
      if (meta) keys.push(meta);
    }
    if (!keys.length) {
      console.warn("⚠️  Instruction has no account metas after normalization.");
    }
    const data = Buffer.isBuffer(ix.data) ? ix.data : Buffer.from(ix.data ?? []);
    return new TransactionInstruction({
      programId,
      keys,
      data,
    });
  }

  async _ensureAta(address, owner, mint) {
    try {
      const exists = await this._accountExists(address);
      if (exists) return null;
      return createAssociatedTokenAccountInstruction(
        this.wallet.publicKey,
        address,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    } catch (error) {
      // If we can't determine if account exists due to network issues,
      // it's safer to add the ATA creation instruction (idempotent operation)
      // This prevents blocking position opens due to transient RPC failures
      console.warn(`⚠️  [ATA] Could not verify account existence for ${address.toBase58()}: ${error.message}. Adding ATA creation instruction as fallback.`);
      return createAssociatedTokenAccountInstruction(
        this.wallet.publicKey,
        address,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    }
  }

  /**
   * Get account info with automatic RPC failover
   * Wraps connection.getAccountInfo with RPCManager's executeWithFailover
   */
  async _getAccountInfoWithFailover(address, commitment = 'confirmed') {
    if (this.rpcManager && typeof this.rpcManager.executeWithFailover === 'function') {
      return await this.rpcManager.executeWithFailover(
        (connection) => connection.getAccountInfo(address, commitment),
        `get-account-${address.toBase58().slice(0, 8)}`
      );
    }
    // Fallback to direct connection if RPCManager unavailable
    return await this.connection.getAccountInfo(address, commitment);
  }

  async _accountExists(address) {
    // Use RPCManager's executeWithFailover for automatic provider switching
    // This ensures we try all available RPC providers before giving up
    if (this.rpcManager && typeof this.rpcManager.executeWithFailover === 'function') {
      try {
        const info = await this._getAccountInfoWithFailover(address, 'confirmed');
        return Boolean(info);
      } catch (error) {
        // If all RPCs fail, assume account doesn't exist to allow ATA creation (safe operation)
        console.warn(`⚠️  [RPC] All RPC providers failed checking account ${address.toBase58()}: ${error.message}. Assuming account doesn't exist.`);
        return false;
      }
    }
    
    // Fallback: Use direct connection with manual retry logic
    // (This code path is used if RPCManager is not available)
    const maxRetries = 3;
    const initialDelay = 500;
    const maxDelay = 5000;
    const backoffMultiplier = 2;
    
    let lastError;
    let delay = initialDelay;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Add timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('RPC request timeout')), 10000);
        });
        
        // IMPORTANT: Call connection directly here, NOT through wrapper
        // (wrapper would just delegate back to this.connection anyway since RPCManager is unavailable)
        const infoPromise = this.connection.getAccountInfo(address, {
          commitment: 'confirmed'
        });
        
        const info = await Promise.race([infoPromise, timeoutPromise]);
        return Boolean(info);
      } catch (error) {
        lastError = error;
        
        // Don't retry on certain errors (account doesn't exist is not an error)
        if (error.message?.includes('AccountNotFound') || 
            error.message?.includes('account not found')) {
          return false; // Account doesn't exist, return false
        }
        
        // Log retry attempts
        if (attempt < maxRetries) {
          console.warn(`⚠️  [RPC] Account check failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${delay}ms...`);
          await sleep(delay);
          delay = Math.min(delay * backoffMultiplier, maxDelay);
        } else {
          console.error(`❌ [RPC] Account check failed after ${maxRetries + 1} attempts: ${error.message}`);
          // For network errors, we'll assume account doesn't exist to avoid blocking
          // This allows the ATA creation instruction to be added (safe operation)
          if (error.message?.includes('fetch failed') || 
              error.message?.includes('timeout') ||
              error.message?.includes('network')) {
            console.warn(`⚠️  [RPC] Network error detected, assuming account doesn't exist to allow ATA creation`);
            return false;
          }
          // Re-throw other errors
          throw new Error(`Failed to check account existence after ${maxRetries + 1} attempts: ${error.message}`, { cause: error });
        }
      }
    }
    
    throw lastError;
  }

  _usdToU64(amount) {
    const num = Number(amount || 0);
    if (!Number.isFinite(num) || num <= 0) return BigInt(0);
    return BigInt(Math.round(num * 1_000_000));
  }

  async _fetchOraclePrice(oracleAccount) {
    try {
      const accountInfo = await this._getAccountInfoWithFailover(oracleAccount);
      if (!accountInfo) {
        console.warn(`⚠️  Oracle account not found: ${oracleAccount.toBase58()}`);
        return null;
      }

      // Parse Doves/Jupiter oracle format
      // The oracle account is managed by Jupiter's custom oracle program
      const data = accountInfo.data;
      
      console.log(`📊 Oracle account data length: ${data.length} bytes`);
      console.log(`📊 Oracle owner: ${accountInfo.owner.toBase58()}`);
      
      if (data.length < 128) {
        console.warn(`⚠️  Oracle account data too short: ${data.length} bytes`);
        return null;
      }
      
      // Doves Oracle Format (used by Jupiter Perps)
      // Discovered structure through binary analysis:
      //   - Offset 168: price as u64 with 8 decimal places
      //   - Example: 14212202367 / 10^8 = $142.122024
      
      const DOVES_PRICE_OFFSET = 168;
      const DOVES_PRICE_DECIMALS = 8;
      
      if (data.length >= DOVES_PRICE_OFFSET + 8) {
        try {
          const priceRaw = data.readBigUInt64LE(DOVES_PRICE_OFFSET);
          const price = Number(priceRaw) / Math.pow(10, DOVES_PRICE_DECIMALS);
          
          console.log(`📊 Doves Oracle Parse:`);
          console.log(`   Raw price (u64): ${priceRaw}`);
          console.log(`   Calculated price: $${price.toFixed(6)} (${DOVES_PRICE_DECIMALS} decimals)`);
          
          // Validate: should be positive and reasonable ($0.01 to $1M)
          if (price > 0.01 && price < 1_000_000) {
            console.log(`✅ Doves Oracle Price: $${price.toFixed(2)}`);
            return price;
          } else {
            console.warn(`⚠️  Price out of valid range: $${price.toFixed(2)}`);
          }
        } catch (e) {
          console.warn(`⚠️  Doves oracle parse failed: ${e.message}`);
        }
      }
      
      console.error(`❌ Could not parse oracle price from Doves format`);
      console.error(`   Data length: ${data.length} bytes`);
      console.error(`   Expected at least ${DOVES_PRICE_OFFSET + 8} bytes`);
      return null;
    } catch (err) {
      console.error(`❌ Error fetching oracle price: ${err.message}`);
      return null;
    }
  }

  /**
   * Get the mint address for a collateral custody
   * @param {PublicKey} collateralCustody - The collateral custody public key
   * @returns {PublicKey|null} - The mint address, or null if not found
   */
  _getCollateralCustodyMint(collateralCustody) {
    // Check if it's the USDC collateral custody
    if (collateralCustody.equals(COLLATERAL.custody)) {
      return COLLATERAL.mint;
    }
    
    // Check if it's a market custody (SOL/ETH/BTC)
    for (const [symbol, market] of Object.entries(MARKET_REGISTRY)) {
      if (market.custody.equals(collateralCustody)) {
        return market.mint;
      }
    }
    
    console.warn(`⚠️  Could not determine mint for collateral custody: ${collateralCustody.toBase58()}`);
    return null;
  }

  /**
   * Fetch jupiterMinimumOut from Jupiter Quote API when a swap is required
   * Reference: https://station.jup.ag/api-v6/get-quote
   * @param {PublicKey} inputMint - The input token mint
   * @param {PublicKey} outputMint - The output token mint (collateral custody mint)
   * @param {BigInt} inputAmount - The input amount in token's native units
   * @param {number} slippageBps - Slippage tolerance in basis points (default: 50 = 0.5%)
   * @returns {BigInt|null} - The minimum output amount, or null if swap not needed or quote failed
   */
  async _fetchJupiterMinimumOut(inputMint, outputMint, inputAmount, slippageBps = 50) {
    try {
      // If input and output are the same, no swap needed
      if (inputMint.equals(outputMint)) {
        console.log(`ℹ️  No swap needed: inputMint === outputMint (${inputMint.toBase58()})`);
        return null;
      }

      // Use Jupiter Swap Quote API (not Perps API) for swap quotes
      // Official endpoint: https://api.jup.ag/quote/v6/quote
      const jupiterQuoteApiUrl = process.env.JUPITER_QUOTE_API_URL || 'https://api.jup.ag/quote/v6';
      const url = jupiterQuoteApiUrl.endsWith('/quote') ? jupiterQuoteApiUrl : `${jupiterQuoteApiUrl}/quote`;
      
      const params = new URLSearchParams({
        inputMint: inputMint.toBase58(),
        outputMint: outputMint.toBase58(),
        amount: inputAmount.toString(),
        slippageBps: String(slippageBps),
      });

      console.log(`📡 Fetching Jupiter quote for swap: ${inputMint.toBase58()} -> ${outputMint.toBase58()}`);
      console.log(`   Input amount: ${inputAmount.toString()}`);
      console.log(`   Slippage: ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%)`);

      const response = await axios.get(`${url}?${params.toString()}`, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.data || !response.data.outAmount) {
        console.warn(`⚠️  Jupiter quote response missing outAmount`);
        return null;
      }

      // Calculate minimum output with slippage
      // outAmount is the expected output, we need to apply slippage to get minimum
      const outAmount = BigInt(response.data.outAmount);
      const slippageMultiplier = BigInt(10000 - slippageBps); // e.g., 9950 for 50 bps slippage
      const minimumOut = (outAmount * slippageMultiplier) / BigInt(10000);

      console.log(`✅ Jupiter quote received:`);
      console.log(`   Expected output: ${outAmount.toString()}`);
      console.log(`   Minimum output (with ${slippageBps} bps slippage): ${minimumOut.toString()}`);

      return minimumOut;
    } catch (err) {
      console.error(`❌ Error fetching Jupiter quote: ${err.message}`);
      if (err.response) {
        console.error(`   Status: ${err.response.status}`);
        console.error(`   Data: ${JSON.stringify(err.response.data)}`);
      }
      
      // Fallback: Estimate jupiterMinimumOut based on current market price
      // This is a rough estimate - ideally we'd get the quote from the API
      // For USDC -> SOL: $10 USDC / $150 SOL ≈ 0.0667 SOL (with slippage)
      console.warn(`⚠️  Quote API failed, using price-based estimate for jupiterMinimumOut`);
      
      // Rough price estimates (can be improved with oracle prices)
      const priceEstimates = {
        'So11111111111111111111111111111111111111112': 150, // SOL
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 3100, // ETH
        '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 95000, // BTC
      };
      
      const outputPrice = priceEstimates[outputMint.toBase58()];
      if (outputPrice) {
        // USDC has 6 decimals, output token typically has 9 decimals (SOL) or 8 (ETH/BTC)
        const inputUsd = Number(inputAmount) / 1_000_000; // USDC amount in USD
        const outputAmountUsd = inputUsd / outputPrice; // Output amount in tokens
        const outputDecimals = outputMint.toBase58() === 'So11111111111111111111111111111111111111112' ? 9 : 8;
        const outputAmountRaw = BigInt(Math.floor(outputAmountUsd * Math.pow(10, outputDecimals)));
        // Apply slippage (subtract slippageBps)
        const slippageMultiplier = BigInt(10000 - slippageBps);
        const estimatedMinimumOut = (outputAmountRaw * slippageMultiplier) / BigInt(10000);
        
        console.log(`   Estimated minimum output: ${estimatedMinimumOut.toString()} (based on $${outputPrice} price)`);
        return estimatedMinimumOut;
      }
      
      // Return null if we can't estimate
      console.warn(`⚠️  Cannot estimate jupiterMinimumOut - transaction may fail`);
      return null;
    }
  }

  /**
   * Apply priority fee instructions to a transaction
   * @param {Transaction} tx - Transaction to modify
   * @param {number} priorityFeeOverride - Priority fee to use (avoids reading from this.priorityFee for thread safety)
   */
  async _applyPriorityFeeInstructions(tx, priorityFeeOverride = null) {
    // RACE CONDITION FIX: Use passed priority fee instead of this.priorityFee
    const effectivePriorityFee = Number.isFinite(priorityFeeOverride) ? priorityFeeOverride : this.priorityFee;
    
    console.log(
      `[PRIORITY_FEE] _applyPriorityFeeInstructions called: priorityFee=${effectivePriorityFee}, isTransaction=${tx instanceof Transaction}`
    );
    if (!(tx instanceof Transaction)) return;
    if (!Number.isFinite(effectivePriorityFee) || effectivePriorityFee <= 0) {
      console.log(`[PRIORITY_FEE] Skipping priority fee (value <= 0)`);
      return;
    }

    const tipAccounts = await this._ensureTipAccounts();
    console.log(`[PRIORITY_FEE] Loaded ${tipAccounts.length} tip accounts from config`);
    if (!tipAccounts.length) {
      console.warn("⚠️  Priority fee configured but no tip accounts available; skipping tip boost.");
      return;
    }

    const selected = this._selectTipAccounts(Math.min(this.tipAccountsPerTx, tipAccounts.length));
    console.log(`[PRIORITY_FEE] Selected ${selected.length} tip account(s) for this transaction`);
    if (!selected.length) return;

    // Calculate tip amount using the passed priority fee
    const computeLimit = Number.isFinite(this.computeUnitLimit) && this.computeUnitLimit > 0 ? this.computeUnitLimit : 200_000;
    const totalTipLamports = Math.max(
      1,
      Math.ceil((Number(effectivePriorityFee) * computeLimit) / 1_000_000)
    );
    const perAccountLamports = Math.max(1, Math.floor(totalTipLamports / selected.length));
    console.log(`[PRIORITY_FEE] Total tip: ${totalTipLamports} lamports (${perAccountLamports} per account)`);

    // Add tip transfer instructions FIRST (these make tip accounts writable in the transaction)
    selected.forEach((account, idx) => {
      const lamports =
        idx === selected.length - 1
          ? Math.max(1, totalTipLamports - perAccountLamports * (selected.length - 1))
          : perAccountLamports;
      tx.instructions.unshift(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey: account,
          lamports,
        })
      );
      console.log(`[PRIORITY_FEE] Added tip transfer: ${lamports} lamports → ${account.toBase58().substring(0, 8)}...`);
    });

    // Add compute budget instructions AFTER tip transfers
    // (unshift adds to beginning, so these end up before the transfers)
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: computeLimit,
    });
    tx.instructions.unshift(computeLimitIx);
    console.log(`[PRIORITY_FEE] Added compute unit limit: ${computeLimit}`);

    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: effectivePriorityFee,
    });
    tx.instructions.unshift(computePriceIx);
    console.log(`[PRIORITY_FEE] Added compute unit price: ${effectivePriorityFee} microLamports`);

    // Explicitly add tip accounts as writable to the compute price instruction
    // This ensures Solana's preflight check sees them as writable accounts
    const tipAccountMetas = selected.map(pubkey => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    }));
    computePriceIx.keys.push(...tipAccountMetas);
    console.log(`[PRIORITY_FEE] Attached ${tipAccountMetas.length} writable tip account(s) to compute price instruction`);
  }

  async _ensureTipAccounts() {
    if (this._tipAccounts?.length) {
      return this._tipAccounts;
    }
    if (ENV_TIP_ACCOUNTS.length && !this._tipAccounts?.length) {
      this._tipAccounts = [...ENV_TIP_ACCOUNTS];
      console.log(`ℹ️  Loaded ${this._tipAccounts.length} tip account(s) from SOLANA_TIP_ACCOUNTS.`);
      return this._tipAccounts;
    }
    if (!TIP_ACCOUNTS_URL) {
      this._tipAccounts = [];
      return this._tipAccounts;
    }
    if (!this._tipFetchPromise) {
      this._tipFetchPromise = this._fetchTipAccountsFromUrl().finally(() => {
        this._tipFetchPromise = null;
      });
    }
    const remote = await this._tipFetchPromise;
    if (remote.length) {
      this._tipAccounts = remote;
      console.log(`ℹ️  Loaded ${remote.length} tip account(s) from ${TIP_ACCOUNTS_URL}`);
    } else if (!this._tipAccounts?.length) {
      this._tipAccounts = [];
    }
    return this._tipAccounts;
  }

  async _fetchTipAccountsFromUrl() {
    if (!TIP_ACCOUNTS_URL || typeof fetch !== "function") {
      return [];
    }
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), TIP_ACCOUNTS_TIMEOUT_MS) : null;
    try {
      const response = await fetch(TIP_ACCOUNTS_URL, controller ? { signal: controller.signal } : undefined);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = await response.json().catch(() => null);
      const candidates = this._coerceTipAccountPayload(body);
      const parsed = candidates
        .map((value) => tryParsePubkey(value, "TIP_ACCOUNTS_URL"))
        .filter(Boolean);
      return parsed;
    } catch (err) {
      console.warn(`⚠️  Failed to fetch tip accounts (${TIP_ACCOUNTS_URL}): ${err.message}`);
      return [];
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  _coerceTipAccountPayload(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (typeof payload === "string") return splitList(payload);
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.tip_accounts)) return payload.tip_accounts;
    if (Array.isArray(payload.tipAccounts)) return payload.tipAccounts;
    if (Array.isArray(payload.accounts)) return payload.accounts;
    if (payload?.data?.tip_accounts && Array.isArray(payload.data.tip_accounts)) return payload.data.tip_accounts;
    if (payload?.data?.tipAccounts && Array.isArray(payload.data.tipAccounts)) return payload.data.tipAccounts;
    if (typeof payload.data === "string") return splitList(payload.data);
    return [];
  }

  _selectTipAccounts(count = 1) {
    if (!this._tipAccounts?.length) return [];
    const picks = [];
    for (let i = 0; i < count; i += 1) {
      const idx = (this._tipCursor + i) % this._tipAccounts.length;
      picks.push(this._tipAccounts[idx]);
    }
    this._tipCursor = (this._tipCursor + count) % this._tipAccounts.length;
    return picks;
  }

  async _sendAndConfirm(txLike, options = {}) {
    const { retryTransaction } = require("../../utils/transaction-retry");
    
    // RACE CONDITION FIX: Capture priority fee at call time, don't mutate this.priorityFee
    // This prevents concurrent operations from seeing inconsistent priority fee values
    const effectivePriorityFee = Number.isFinite(options.priorityFee) ? options.priorityFee : this.priorityFee;

    this._recordTelemetry({
      stage: "send_start",
      priorityFee: effectivePriorityFee,
      txType: txLike?.constructor?.name || typeof txLike,
    });

    const sendStart = Date.now();
    const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 3;
    const confirmTimeout = Number.isFinite(options.confirmTimeout) ? options.confirmTimeout : 30_000;

    try {
      // Retry logic with fresh blockhash on each attempt
      const sig = await retryTransaction(async () => {
        // Finalize with fresh blockhash on each retry, passing priority fee
        const tx = await this._finalizeTxLike(txLike, { priorityFee: effectivePriorityFee });
        this._recordTelemetry({
          stage: "finalize_success",
          priorityFee: effectivePriorityFee,
          instructions: tx.instructions?.length || tx.message?.instructions?.length || 0,
        });
        
        const raw = tx.serialize();
        
        // Send transaction
        const sendSig = await this.connection.sendRawTransaction(raw, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0, // We handle retries ourselves
        });

        // Wait for confirmation
        const confirmation = await Promise.race([
          this.connection.confirmTransaction(sendSig, 'confirmed'),
          new Promise((_, reject) =>
            setTimeout(() => {
              const err = new Error(`Transaction confirmation timeout: ${sendSig}`);
              err.signature = sendSig;
              err.isConfirmationTimeout = true;
              reject(err);
            }, confirmTimeout)
          ),
        ]);

        if (confirmation?.value?.err) {
          const err = new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
          err.signature = sendSig;
          err.isConfirmedFailure = true;
          throw err;
        }

        return sendSig;
      }, {
        maxRetries,
        initialDelay: 1000,
        maxDelay: 5000,
        backoffMultiplier: 1.5,
        onRetry: (info) => {
          if (info.attempt) {
            console.log(`🔄 Retrying transaction (attempt ${info.attempt})...`);
          }
        },
      });

      this._recordTelemetry({
        stage: "send_success",
        signature: sig,
        durationMs: Date.now() - sendStart,
        priorityFee: effectivePriorityFee,
      });
      return sig;
    } catch (error) {
      this._recordTelemetry({
        stage: "send_error",
        priorityFee: effectivePriorityFee,
        error: error?.message || "unknown",
      });
      await this._logSendTransactionError(error);
      throw error;
    }
  }

  async _logSendTransactionError(error) {
    if (!(error instanceof SendTransactionError)) {
      return;
    }
    console.error(`❌ SendTransactionError: ${error.message}`);
    try {
      const logs = await error.getLogs(this.connection);
      if (Array.isArray(logs) && logs.length) {
        console.error("📝 Solana logs:");
        logs.forEach((line) => console.error("  ", line));
        
        // Check for insufficient funds in logs
        const hasInsufficientFunds = logs.some(log => 
          log.includes('insufficient funds') || 
          log.includes('Insufficient funds') ||
          log.includes('Error: insufficient funds')
        );
        
        if (hasInsufficientFunds) {
          console.error("\n⚠️  INSUFFICIENT FUNDS DETECTED IN TRANSACTION LOGS");
          console.error("   This usually means:");
          console.error("   1. Not enough SOL for transaction fees (need ~0.001 SOL minimum)");
          console.error("   2. Not enough token balance (USDC or market asset) for the position collateral");
          console.error("   Please check your wallet balances and ensure you have sufficient funds.");
        }
      }
    } catch (logErr) {
      console.error(`⚠️  Unable to fetch transaction logs: ${logErr.message}`);
    }
  }

  _recordTelemetry(event = {}) {
    if (!this._txTelemetry) this._txTelemetry = [];
    const payload = { ts: Date.now(), ...event };
    this._txTelemetry.push(payload);
    if (this._txTelemetry.length > this._maxTxTelemetry) {
      this._txTelemetry.shift();
    }
    console.log("[LIVE_TRADE]", payload);
  }

  _nextRequestCounter() {
    // Use small incremental counters (1e8-1e9 range) instead of timestamps
    // This matches observed on-chain behavior from position request samples
    if (typeof this._requestCounter !== "bigint") {
      // Initialize with random value in valid range (100M - 1B)
      this._requestCounter = BigInt(Math.floor(Math.random() * 900_000_000) + 100_000_000);
    }
    const current = this._requestCounter;
    this._requestCounter += 1n;
    
    // Log counter for debugging
    console.log(`🔢 Request counter: ${current} (${current.toString()})`);
    
    return current;
  }

  _notifyKeeperListeners(data) {
    if (!this._keeperListeners || this._keeperListeners.size === 0) return;
    for (const listener of [...this._keeperListeners]) {
      try {
        listener(data);
      } catch (err) {
        console.warn("⚠️  Keeper listener error:", err.message);
      }
    }
  }

  async _ensureKeeperSubscription() {
    if (this._keeperSubId !== null) return;
    if (!this.connection || !this._positionPda) return;
    this._keeperSubId = this.connection.onAccountChange(
      this._positionPda,
      (info) => {
        const decoded = this._decodePositionAccount(this._positionPda, info);
        const formatted = this._formatDecodedPosition(decoded, this.wallet.publicKey, this._positionPda);
        if (formatted) {
          this._recordTelemetry({
            stage: "keeper_event",
            sizeUsd: Number(formatted.sizeUsd || formatted.size || 0),
          });
          this._notifyKeeperListeners(formatted);
        }
      },
      "confirmed"
    );
    this._recordTelemetry({ stage: "keeper_subscribed", subId: this._keeperSubId });
  }

  /**
   * Wait for a position to be filled by the keeper
   * @param {number|null} timeoutMs - Timeout in ms (default from env)
   * @param {number} pollMs - Poll interval in ms
   * @param {Set} existingPositionIds - Set of existing position IDs to exclude
   * @param {AbortController} [abortController] - Optional AbortController to cancel the wait
   */
  async _waitForFill(timeoutMs = null, pollMs = 900, existingPositionIds = new Set(), abortController = null) {
    // Default timeout: 60s (configurable via KEEPER_FILL_TIMEOUT_MS)
    // Jupiter keepers can be slow during high volatility/congestion
    // Increased from 25s to 60s to reduce false timeouts
    if (!timeoutMs) {
      timeoutMs = Number(process.env.KEEPER_FILL_TIMEOUT_MS || 60_000);
    }
    
    await this._ensureKeeperSubscription();
    console.log(`⏳ Waiting for keeper to fill position (timeout: ${(timeoutMs/1000).toFixed(0)}s)...`);
    
    return new Promise((resolve, reject) => {
      let settled = false;
      let attempts = 0;

      const cleanup = () => {
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        if (keeperListener) {
          this._keeperListeners.delete(keeperListener);
        }
        // Remove abort listener if we set one
        if (abortController) {
          abortController.signal.removeEventListener('abort', abortHandler);
        }
      };
      
      // ABORT HANDLER: Allow external cancellation (e.g., when client is destroyed)
      const abortHandler = () => {
        if (settled) return;
        cleanup();
        const err = new Error('Wait for fill aborted');
        err.isAborted = true;
        reject(err);
      };
      
      if (abortController) {
        if (abortController.signal.aborted) {
          // Already aborted before we started
          return reject(new Error('Wait for fill aborted before start'));
        }
        abortController.signal.addEventListener('abort', abortHandler);
      }

      const formatPosition = (pos) => ({
        positionId: pos.id?.toString?.() || pos.positionId || `${Date.now()}`,
        side: (pos.side || "").toString().toUpperCase(),
        size: Number(pos.sizeUsd || pos.size || 0),
        entryPrice: Number(pos.entryPrice || 0),
        leverage: Number(pos.leverage || 0),
        collateral: Number(pos.collateralUsd || pos.collateral || 0),
        liquidationPrice: Number(pos.liqPrice || 0),
      });

      const resolveSuccess = (pos, source) => {
        if (settled) return;
        cleanup();
        this._recordTelemetry({
          stage: "fill_success",
          attempts,
          sizeUsd: Number(pos.sizeUsd || pos.size || 0),
          source,
        });
        resolve(formatPosition(pos));
      };

      const keeperListener = (data) => {
        if (settled) return;
        if (Number(data.sizeUsd || data.size || 0) > 0) {
          resolveSuccess(data, "keeper");
        }
      };

      this._keeperListeners.add(keeperListener);

      const poll = async () => {
        if (settled) return;
        attempts += 1;
        
        // Log progress every 10 attempts (~9 seconds)
        if (attempts % 10 === 0) {
          const elapsed = ((attempts * pollMs) / 1000).toFixed(0);
          console.log(`   ⏳ Still waiting... (${elapsed}s elapsed, ${attempts} checks)`);
        }
        
        try {
          // Get ALL positions for this market to find the NEW one
          const allPositions = await this.getAllOpenPositions().catch(() => []);
          const target = (this.market?.marketAddress || this.market?.address || this.marketSymbol).toString();
          
          // Find positions for this market
          const marketPositions = allPositions.filter(
            (p) => String(p.market || p.marketPk || p.marketAddress || p.custody) === target
          );
          
          // Find a NEW position (one that wasn't in the existing set)
          let newPosition = null;
          if (existingPositionIds.size > 0) {
            // Look for a position that's not in the existing set
            newPosition = marketPositions.find(p => {
              const posId = p.positionId || p.id || p.address;
              return posId && !existingPositionIds.has(posId) && Number(p.sizeUsd || p.size || 0) > 0;
            });
          } else {
            // If we don't have existing positions, just use the first valid one
            // (fallback for backward compatibility)
            newPosition = marketPositions.find(p => Number(p.sizeUsd || p.size || 0) > 0);
          }
          
          if (newPosition) {
            console.log(`   ✅ Position filled after ${((attempts * pollMs) / 1000).toFixed(1)}s (${attempts} checks)`);
            resolveSuccess(newPosition, "poll");
          }
        } catch (err) {
          console.warn("⚠️  Polling positions failed:", err.message);
        }
      };

      const pollTimer = setInterval(() => {
        poll().catch((err) => console.warn("⚠️  Poll interval error:", err.message));
      }, pollMs);

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        const elapsed = (timeoutMs / 1000).toFixed(0);
        console.error(`   ❌ Keeper timeout after ${elapsed}s (${attempts} checks)`);
        console.error(`   💡 Tip: Keeper may be slow. Check position manually or increase KEEPER_FILL_TIMEOUT_MS`);
        this._recordTelemetry({
          stage: "fill_timeout",
          attempts,
          timeoutMs,
        });
        reject(new Error(`⏳ Keeper fill timeout (waited ${elapsed}s)`));
      }, timeoutMs);

      poll().catch((err) => console.warn("⚠️  Initial poll error:", err.message));
    });
  }

  /**
   * Wait for a position to be closed by the keeper
   * @param {number|null} timeoutMs - Timeout in ms (default from env)
   * @param {number} pollMs - Poll interval in ms
   * @param {AbortController} [abortController] - Optional AbortController to cancel the wait
   */
  async _waitForClose(timeoutMs = null, pollMs = 900, abortController = null) {
    // Default timeout: 60s (configurable via KEEPER_CLOSE_TIMEOUT_MS)
    if (!timeoutMs) {
      timeoutMs = Number(process.env.KEEPER_CLOSE_TIMEOUT_MS || 60_000);
    }
    
    await this._ensureKeeperSubscription();
    console.log(`⏳ Waiting for keeper to close position (timeout: ${(timeoutMs/1000).toFixed(0)}s)...`);
    
    return new Promise((resolve, reject) => {
      let settled = false;
      let attempts = 0;

      const cleanup = () => {
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        if (keeperListener) {
          this._keeperListeners.delete(keeperListener);
        }
        // Remove abort listener if we set one
        if (abortController) {
          abortController.signal.removeEventListener('abort', abortHandler);
        }
      };
      
      // ABORT HANDLER: Allow external cancellation (e.g., when client is destroyed)
      const abortHandler = () => {
        if (settled) return;
        cleanup();
        const err = new Error('Wait for close aborted');
        err.isAborted = true;
        reject(err);
      };
      
      if (abortController) {
        if (abortController.signal.aborted) {
          // Already aborted before we started
          return reject(new Error('Wait for close aborted before start'));
        }
        abortController.signal.addEventListener('abort', abortHandler);
      }

      const resolveSuccess = (source) => {
        if (settled) return;
        cleanup();
        this._recordTelemetry({
          stage: "close_success",
          attempts,
          source,
        });
        resolve({ ok: true, closed: true, source });
      };

      const keeperListener = (data) => {
        if (settled) return;
        // Position closed when size is 0 or position doesn't exist
        if (Number(data.sizeUsd || data.size || 0) === 0) {
          resolveSuccess("keeper");
        }
      };

      this._keeperListeners.add(keeperListener);

      const poll = async () => {
        if (settled) return;
        attempts += 1;
        try {
          const pos = await this.getOpenPosition().catch(() => null);
          // Position is closed if it doesn't exist or has 0 size
          if (!pos || Number(pos.sizeUsd || pos.size || 0) === 0) {
            resolveSuccess("poll");
          }
        } catch (err) {
          console.warn("⚠️  Polling getOpenPosition failed:", err.message);
        }
      };

      const pollTimer = setInterval(() => {
        poll().catch((err) => console.warn("⚠️  Poll interval error:", err.message));
      }, pollMs);

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        this._recordTelemetry({
          stage: "close_timeout",
          attempts,
          timeoutMs,
        });
        reject(new Error("⏳ Keeper close timeout"));
      }, timeoutMs);

      poll().catch((err) => console.warn("⚠️  Initial poll error:", err.message));
    });
  }

  async getOpenPosition() {
    // FIX: Ensure init() is called before accessing position data
    await this.init();
    const user = await this._manualGetUserState(this.wallet.publicKey);
    const positions = user?.positions || [];
    const target = (this.market?.marketAddress || this.market?.address || this.marketSymbol).toString();
    return positions.find(
      (p) => String(p.market || p.marketPk || p.marketAddress || p.custody) === target
    ) || null;
  }

  /**
   * Get all open positions across all markets
   * Used for position recovery on bot restart
   */
  async getAllOpenPositions() {
    await this.init();
    const user = await this._manualGetUserState(this.wallet.publicKey);
    return user?.positions || [];
  }

  /**
   * Cleanup resources and subscriptions.
   * Should be called when the client instance is no longer needed.
   * Prevents WebSocket leaks and orphaned listeners.
   */
  async destroy() {
    console.log('[CLEANUP] Destroying JupiterPerpsLive client...');
    
    // Cancel any active operations
    for (const [opId, controller] of this._activeAbortControllers) {
      console.log(`[CLEANUP] Aborting operation ${opId}`);
      controller.abort();
    }
    this._activeAbortControllers.clear();
    
    // Remove WebSocket subscription for keeper updates
    if (this._keeperSubId !== null) {
      try {
        await this.connection.removeAccountChangeListener(this._keeperSubId);
        console.log(`[CLEANUP] Removed keeper subscription ${this._keeperSubId}`);
      } catch (err) {
        console.warn(`⚠️  Failed to remove keeper subscription: ${err.message}`);
      }
      this._keeperSubId = null;
    }
    
    // Clear all keeper listeners
    this._keeperListeners.clear();
    
    // Clear caches
    if (this._positionPdaCache) this._positionPdaCache.clear();
    if (this._positionRequestPdaCache) this._positionRequestPdaCache.clear();
    
    // Release any pending market lock
    if (this._marketOperationLock) {
      this._marketOperationLock = null;
    }
    
    // Clear telemetry
    this._txTelemetry = [];
    
    // Mark as uninitialized (allows re-init if needed)
    this._initialized = false;
    this._initPromise = null;
    
    console.log('[CLEANUP] JupiterPerpsLive client destroyed');
  }

  /**
   * Check if wallet has sufficient balances for opening a position
   * @param {number} collateralUsd - Required collateral in USD
   * @param {string} side - Position side ('long' or 'short')
   * @param {Object} market - Market object (optional, uses current market if not provided)
   * @returns {Promise<{sufficient: boolean, errors: string[], solBalance: number, tokenBalance: number, requiredSol: number, requiredToken: number}>}
   */
  async _checkBalanceForPosition(collateralUsd, side, market = null) {
    const marketObj = market || this.market;
    const normalizedSide = String(side || "long").toLowerCase().includes("short") ? "short" : "long";
    
    // Determine which token is needed based on side and configuration
    // More robust check for USE_USDC_COLLATERAL_ALWAYS (handle whitespace, case, etc.)
    const useUsdcEnv = String(process.env.USE_USDC_COLLATERAL_ALWAYS || '').trim().toLowerCase();
    const useUsdcForAll = useUsdcEnv === 'true' || useUsdcEnv === '1' || process.env.TEST_COLLATERAL_MODE === 'always_usdc';
    
    let requiredTokenMint;
    let tokenSymbol;
    
    if (useUsdcForAll) {
      // FORCE USDC regardless of side when USE_USDC_COLLATERAL_ALWAYS is true
      requiredTokenMint = COLLATERAL.mint;
      tokenSymbol = 'USDC';
      console.log(`🔍 [BALANCE_CHECK] USE_USDC_COLLATERAL_ALWAYS=true → checking USDC balance (side: ${normalizedSide})`);
    } else {
      // Standard perps flow: Longs use market asset, shorts use USDC
      requiredTokenMint = normalizedSide === "long" ? marketObj.mint : COLLATERAL.mint;
      tokenSymbol = normalizedSide === "long" ? marketObj.symbol.split('-')[0] : 'USDC';
      console.log(`🔍 [BALANCE_CHECK] Standard flow → checking ${tokenSymbol} balance (side: ${normalizedSide})`);
    }
    
    // Calculate required amounts
    // SOL: Need enough for transaction fees (0.01 SOL should be plenty, but check for at least 0.001 SOL)
    const MIN_SOL_BALANCE = 0.001; // 0.001 SOL minimum for fees
    const REQUIRED_SOL_LAMPORTS = Math.ceil(MIN_SOL_BALANCE * 1e9); // Convert to lamports
    
    // Token decimals: use on-chain mint decimals (avoids false "insufficient funds")
    const { getMint } = require('@solana/spl-token');
    let tokenDecimals = 6; // USDC default
    try {
      const mintInfo = await getMint(this.connection, requiredTokenMint);
      if (Number.isFinite(mintInfo?.decimals)) tokenDecimals = mintInfo.decimals;
    } catch (err) {
      console.warn(`⚠️  Could not fetch mint info for ${requiredTokenMint?.toBase58?.() || String(requiredTokenMint)}, assuming ${tokenDecimals} decimals`);
    }
    
    // Token: Need collateral amount in token units
    // For USDC: 1 USD = 1 USDC (6 decimals)
    // For other tokens: Convert USD to token amount using current price + mint decimals
    let requiredTokenAmount;
    if (requiredTokenMint.equals(COLLATERAL.mint)) {
      // USDC: 1 USD = 1 USDC (6 decimals)
      requiredTokenAmount = Math.ceil(collateralUsd * 1e6);
    } else {
      // Market asset: Need to get current price and convert
      try {
        const currentPrice = await this._fetchOraclePrice(marketObj.oracleAccount);
        if (!currentPrice || currentPrice === 0) {
          throw new Error(`Failed to fetch oracle price for ${marketObj.symbol}`);
        }
        // Convert USD to token amount using mint decimals
        requiredTokenAmount = Math.ceil((collateralUsd / currentPrice) * Math.pow(10, tokenDecimals));
      } catch (error) {
        console.warn(`⚠️  Could not fetch price for balance check: ${error.message}`);
        // Fallback: assume 1:1 ratio if price fetch fails
        requiredTokenAmount = Math.ceil(collateralUsd * Math.pow(10, tokenDecimals));
      }
    }
    
    // Check SOL balance
    const solBalance = await this.connection.getBalance(this.wallet.publicKey);
    const solBalanceSol = solBalance / 1e9;
    
    // Check token balance
    let tokenBalance = 0;
    let ataExists = false;
    try {
      const tokenAta = getAssociatedTokenAddressSync(
        requiredTokenMint,
        this.wallet.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const tokenAccountInfo = await this._getAccountInfoWithFailover(tokenAta);
      if (tokenAccountInfo) {
        ataExists = true;
        // Parse token account balance
        const tokenAccountData = tokenAccountInfo.data;
        // Token account balance is at offset 64 (8 bytes, big-endian)
        const balanceBytes = tokenAccountData.slice(64, 72);
        tokenBalance = Number(BigInt('0x' + Buffer.from(balanceBytes).reverse().toString('hex')));
      } else {
        // ATA doesn't exist - will need to be created (requires ~0.002 SOL rent)
        ataExists = false;
        console.log(`ℹ️  Token ATA doesn't exist yet - will be created (requires ~0.002 SOL rent)`);
      }
    } catch (error) {
      console.warn(`⚠️  Could not check token balance: ${error.message}`);
      // If ATA doesn't exist, balance is 0
      tokenBalance = 0;
      ataExists = false;
    }
    
    const errors = [];
    // If ATA doesn't exist, we need additional SOL for rent
    const ATA_RENT_SOL = 0.00203928; // Approximate rent for ATA creation
    const requiredSolWithRent = ataExists ? MIN_SOL_BALANCE : MIN_SOL_BALANCE + ATA_RENT_SOL;
    const requiredSolLamports = Math.ceil(requiredSolWithRent * 1e9);
    
    if (solBalance < requiredSolLamports) {
      if (!ataExists) {
        errors.push(`Insufficient SOL balance: ${solBalanceSol.toFixed(6)} SOL (required: ${requiredSolWithRent.toFixed(6)} SOL including ~${ATA_RENT_SOL.toFixed(6)} SOL for ATA creation rent)`);
      } else {
        errors.push(`Insufficient SOL balance: ${solBalanceSol.toFixed(6)} SOL (required: ${MIN_SOL_BALANCE} SOL for transaction fees)`);
      }
    }
    if (tokenBalance < requiredTokenAmount) {
      const tokenBalanceFormatted = tokenBalance / Math.pow(10, tokenDecimals);
      const requiredTokenFormatted = requiredTokenAmount / Math.pow(10, tokenDecimals);
      errors.push(`Insufficient ${tokenSymbol} balance: ${tokenBalanceFormatted.toFixed(6)} ${tokenSymbol} (required: ${requiredTokenFormatted.toFixed(6)} ${tokenSymbol} for ${collateralUsd} USD collateral)`);
    }
    
    return {
      sufficient: errors.length === 0,
      errors,
      solBalance: solBalanceSol,
      tokenBalance: tokenBalance / Math.pow(10, tokenDecimals),
      requiredSol: MIN_SOL_BALANCE,
      requiredToken: requiredTokenAmount / Math.pow(10, tokenDecimals),
      tokenSymbol,
      tokenDecimals,
      requiredTokenMint: requiredTokenMint?.toBase58?.() || null,
    };
  }

  // ---------- Public API ----------

  async openPosition(side, collateralUsd = 5, leverage = 1, priceLimit, clientOrderId, marketSymbol = null) {
    await this.init();

    // RACE CONDITION FIX: Acquire market lock before any market-sensitive operations
    // This prevents concurrent trades from clobbering each other's market context
    const lock = await this._acquireMarketLock();
    const { release: releaseLock, operationId, abortController } = lock;
    
    try {
      console.log(`[OPEN_POSITION] Starting operation ${operationId}`);
      
      // Switch market context if provided (now protected by lock)
      if (marketSymbol && marketSymbol.toUpperCase() !== this.marketSymbol) {
        console.log(`🔄 Switching market context: ${this.marketSymbol} → ${marketSymbol.toUpperCase()}`);
        this._switchMarket(marketSymbol);
      }
      
      // Capture market context at operation start to pass through the call chain
      // This prevents issues if another operation changes the market mid-flight
      const operationMarket = { ...this.market };
      const operationMarketSymbol = this.marketSymbol;

      const normalizedSide = String(side || "long").toLowerCase().includes("short") ? "short" : "long";
      const collateral = Number(collateralUsd);
      const lev = Number(leverage);
      if (!Number.isFinite(collateral) || collateral <= 0) {
        throw new Error("Invalid collateralUsd: must be a positive number");
      }
      if (!Number.isFinite(lev) || lev <= 0) {
        throw new Error("Invalid leverage: must be a positive number");
      }

      // Check balance before attempting to open position
      try {
        const balanceCheck = await this._checkBalanceForPosition(collateral, normalizedSide, operationMarket);
        if (!balanceCheck.sufficient) {
          const errorMsg = `Insufficient funds to open position:\n${balanceCheck.errors.join('\n')}\n\nCurrent balances:\n  SOL: ${balanceCheck.solBalance.toFixed(6)} SOL\n  ${balanceCheck.tokenSymbol}: ${balanceCheck.tokenBalance.toFixed(6)} ${balanceCheck.tokenSymbol}`;
          console.error(`❌ [OPEN_POSITION] ${errorMsg}`);
          throw new Error(errorMsg);
        }
        console.log(`✅ Balance check passed: SOL ${balanceCheck.solBalance.toFixed(6)}, ${balanceCheck.tokenSymbol} ${balanceCheck.tokenBalance.toFixed(6)}`);
      } catch (error) {
        // If balance check itself fails, log but don't block (might be network issue)
        if (error.message.includes('Insufficient funds')) {
          throw error; // Re-throw balance errors
        }
        console.warn(`⚠️  Balance check failed: ${error.message}. Proceeding anyway...`);
      }

      const req = {
        market: operationMarket, // Use captured market context
        side: normalizedSide,
        collateralUsd: collateral,
        leverage: lev,
        slippageBps: Number.isFinite(this.slippageBps) ? this.slippageBps : 0,
        priceLimit: priceLimit || undefined,
        clientOrderId,
      };

    // Capture existing positions BEFORE opening to detect the new one (critical for correctness)
    let existingPositionIds = new Set();
    try {
      const existingPositions = await this.getAllOpenPositions();
      existingPositionIds = new Set(
        existingPositions.map(p => p.positionId || p.id || p.address).filter(Boolean)
      );
    } catch (err) {
      console.warn(`⚠️  Could not fetch existing positions before send: ${err.message}`);
    }

    let tx, sig, positionPda;
    let confirmationUncertain = false;
    try {
      const buildResult = await this._manualCreateIncreaseRequest(req);
      tx = buildResult.tx;
      positionPda = buildResult.positionPda;
      
      // CRITICAL: Pre-register position in database BEFORE sending transaction
      // This prevents race condition where sync marks the position as "manual" 
      // because it finds the position on-chain but not in DB during _waitForFill
      if (this._enableAutoTracking && this._db && typeof this._db.logOpen === 'function') {
        try {
          console.log(`📝 [PRE-REGISTER] Pre-registering position ${positionPda?.slice(0, 8)}... in DB before send`);
          this._db.logOpen({
            positionId: positionPda,
            clientOrderId: clientOrderId,
            market: operationMarketSymbol, // Use captured market context
            side: normalizedSide.toUpperCase(),
            entryPrice: 0, // Will be updated after fill
            collateral: collateral,
            leverage: lev,
            size: collateral * lev,
            openTime: Date.now(),
            trade_type: 'automated', // CRITICAL: Mark as bot-opened
            status: 'pending', // Mark as pending until fill confirmed
            ...this._tradeMetadata,
          });
        } catch (dbError) {
          console.warn(`⚠️  Failed to pre-register position in database: ${dbError.message}`);
          // Continue anyway - sync will mark as manual if this fails, but trade still proceeds
        }
      }
      
      sig = await this._sendAndConfirm(tx);
      console.log(`📤 Increase request sent: ${sig}`);
    } catch (error) {
      // Check for insufficient funds error and provide detailed diagnostics
      const isInsufficientFunds = error.message?.includes('insufficient funds') || 
                                   error.message?.includes('0x1') ||
                                   error.message?.includes('Insufficient funds');
      const maybeSig = error?.signature || (typeof error?.message === 'string'
        ? (error.message.match(/Transaction confirmation timeout:\s*([1-9A-HJ-NP-Za-km-z]{20,})/) || [])[1]
        : null);
      const isConfirmTimeout = Boolean(error?.isConfirmationTimeout) || /confirmation timeout/i.test(error?.message || '');
      
      if (isInsufficientFunds) {
        // CRITICAL: "Insufficient funds" might mean the position ALREADY opened!
        // Before cleaning up, check if the position exists on-chain
        console.log(`⚠️  [OPEN_POSITION] Insufficient funds detected. Checking if position already exists on-chain...`);
        
        try {
          const currentPositions = await this.getAllOpenPositions();
          const existsOnChain = currentPositions.some(p => {
            const posId = p.positionId || p.id || p.address || '';
            // Match by positionPda or by market+side (in case PDA differs)
            return posId === positionPda || 
                   posId.startsWith(positionPda?.slice(0, 8) || '___') ||
                   (p.market === operationMarketSymbol && p.side?.toLowerCase() === normalizedSide);
          });
          
          if (existsOnChain) {
            // Position exists! This "insufficient funds" is because the position already opened
            console.log(`✅ [OPEN_POSITION] Position already exists on-chain! Previous attempt succeeded.`);
            const existingPos = currentPositions.find(p => {
              const posId = p.positionId || p.id || p.address || '';
              return posId === positionPda || 
                     posId.startsWith(positionPda?.slice(0, 8) || '___') ||
                     (p.market === operationMarketSymbol && p.side?.toLowerCase() === normalizedSide);
            });
            
            // Update the pre-registered DB entry with actual fill data instead of cleaning up
            if (this._enableAutoTracking && this._db && typeof this._db.logOpen === 'function' && existingPos) {
              try {
                const actualPosId = existingPos.positionId || existingPos.id || existingPos.address;
                // CRITICAL: Use the on-chain position's market, NOT this.marketSymbol
                // Bug fix: this.marketSymbol could be stale/wrong if a previous market switch failed
                const actualMarket = existingPos.marketSymbol || existingPos.market || operationMarketSymbol;
                this._db.logOpen({
                  positionId: actualPosId,
                  clientOrderId: clientOrderId,
                  market: actualMarket,
                  side: existingPos.side || normalizedSide.toUpperCase(),
                  entryPrice: existingPos.entryPrice || 0,
                  collateral: existingPos.collateral || collateral,
                  leverage: existingPos.leverage || lev,
                  size: existingPos.size || (collateral * lev),
                  openTime: existingPos.openTime || Date.now(),
                  trade_type: 'automated', // Mark as bot-opened
                  ...this._tradeMetadata,
                });
                console.log(`📊 Position reconciled to database: ${actualPosId?.slice(0, 8)}... (market: ${actualMarket})`);
              } catch (dbErr) {
                console.warn(`⚠️  Failed to reconcile position to DB: ${dbErr.message}`);
              }
            }
            
            // Return the existing position as if we just opened it
            // CRITICAL: Use the on-chain position's market, NOT this.marketSymbol
            const actualMarket = existingPos.marketSymbol || existingPos.market || operationMarketSymbol;
            return {
              ...existingPos,
              clientOrderId: clientOrderId || existingPos.clientOrderId,
              openTime: existingPos.openTime || Date.now(),
              market: actualMarket,
              marketSymbol: actualMarket,
              reconciled: true, // Flag that this was reconciled from on-chain
            };
          }
        } catch (checkErr) {
          console.warn(`⚠️  Failed to check for existing positions: ${checkErr.message}`);
        }
        
        // Position doesn't exist on-chain - clean up pre-registered DB entry
        if (positionPda && this._db && typeof this._db.removeOpen === 'function') {
          try {
            this._db.removeOpen(positionPda);
            console.log(`🧹 [CLEANUP] Removed pre-registered DB entry for ${positionPda?.slice(0, 8)}... (position not found on-chain)`);
          } catch (cleanupError) {
            console.warn(`⚠️  Failed to cleanup pre-registered DB entry: ${cleanupError.message}`);
          }
        }
        
        // Re-check balance to provide current state
        try {
          const balanceCheck = await this._checkBalanceForPosition(collateral, normalizedSide);
          console.error(`❌ [OPEN_POSITION] Insufficient funds error detected. Current balances:`);
          console.error(`   SOL: ${balanceCheck.solBalance.toFixed(6)} SOL (required: ${balanceCheck.requiredSol} SOL)`);
          console.error(`   ${balanceCheck.tokenSymbol}: ${balanceCheck.tokenBalance.toFixed(6)} ${balanceCheck.tokenSymbol} (required: ${balanceCheck.requiredToken.toFixed(6)} ${balanceCheck.tokenSymbol})`);
          console.error(`   Position requires: ${collateral} USD collateral`);
          
          const errorMsg = `Insufficient funds to open position:\n${balanceCheck.errors.join('\n')}\n\nCurrent balances:\n  SOL: ${balanceCheck.solBalance.toFixed(6)} SOL\n  ${balanceCheck.tokenSymbol}: ${balanceCheck.tokenBalance.toFixed(6)} ${balanceCheck.tokenSymbol}\n\nPlease ensure you have sufficient ${balanceCheck.tokenSymbol} for the ${collateral} USD collateral and at least ${balanceCheck.requiredSol} SOL for transaction fees.`;
          throw new Error(errorMsg);
        } catch (balanceError) {
          // If balance re-check fails, use original error but enhance message
          console.error(`❌ [OPEN_POSITION] Failed to create/send increase request:`, {
            market: operationMarketSymbol,
            side: normalizedSide,
            collateralUsd: collateral,
            leverage: lev,
            error: error.message,
            balanceCheckError: balanceError.message,
          });
          throw new Error(`Insufficient funds: ${error.message}. Please check your wallet has enough ${normalizedSide === 'long' ? 'SOL' : 'USDC'} for the position and SOL for transaction fees.`, { cause: error });
        }
      }
      
      // If the transaction was likely submitted but confirmation was uncertain, reconcile via on-chain fill.
      if (maybeSig && isConfirmTimeout) {
        sig = maybeSig;
        confirmationUncertain = true;
        console.warn(`⚠️  [OPEN_POSITION] Confirmation uncertain (${error.message}). Attempting on-chain fill reconciliation for sig=${sig}...`);
      } else {
        // Cleanup pre-registered DB entry on definite failure (no signature means tx didn't land)
        if (positionPda && !maybeSig && this._db && typeof this._db.removeOpen === 'function') {
          try {
            this._db.removeOpen(positionPda);
            console.log(`🧹 [CLEANUP] Removed pre-registered DB entry for ${positionPda?.slice(0, 8)}... after tx failure`);
          } catch (cleanupError) {
            console.warn(`⚠️  Failed to cleanup pre-registered DB entry: ${cleanupError.message}`);
          }
        }
        
        console.error(`❌ [OPEN_POSITION] Failed to create/send increase request:`, {
          market: operationMarketSymbol,
          side: normalizedSide,
          collateralUsd: collateral,
          leverage: lev,
          error: error.message,
          stack: error.stack,
          signature: maybeSig || null,
        });
        throw new Error(`Failed to create/send position request: ${error.message}`, { cause: error });
      }
      
    }

    let filled;
    try {
      // Pass existing position IDs so _waitForFill can detect the NEW position
      filled = await this._waitForFill(null, 900, existingPositionIds);
    } catch (error) {
      console.error(`⚠️  [OPEN_POSITION] Wait for fill failed. Attempting on-chain reconciliation...`);
      
      // Before giving up, check if the position actually exists on-chain
      try {
        const currentPositions = await this.getAllOpenPositions();
        const newPosition = currentPositions.find(p => {
          const posId = p.positionId || p.id || p.address || '';
          // Check if this position is NEW (wasn't in existingPositionIds)
          const isNew = !existingPositionIds.has(posId);
          // Also check by market+side if it's for our market (use captured context)
          const isOurMarket = p.market === operationMarketSymbol && p.side?.toLowerCase() === normalizedSide;
          return isNew && isOurMarket;
        });
        
        if (newPosition) {
          console.log(`✅ [OPEN_POSITION] Found position on-chain via reconciliation!`);
          filled = newPosition;
        } else {
          // Still not found - position truly didn't open
          console.error(`❌ [OPEN_POSITION] Position not found on-chain after reconciliation attempt`);
          throw error;
        }
      } catch (reconcileErr) {
        if (reconcileErr === error) throw error; // Re-throw original
        console.error(`❌ [OPEN_POSITION] Failed to wait for fill:`, {
          market: operationMarketSymbol,
          side: normalizedSide,
          collateralUsd: collateral,
          leverage: lev,
          transactionSignature: sig,
          error: error.message,
          reconcileError: reconcileErr.message,
        });
        throw new Error(`Position request sent but fill timeout/failed: ${error.message}`, { cause: error });
      }
    }
    
      const enriched = {
        ...filled,
        clientOrderId: clientOrderId || filled.clientOrderId,
        openTime: Date.now(), // Required for MAX_POSITION_HOURS time-based exit
        market: operationMarketSymbol, // Use captured market context, not this.marketSymbol
        signature: sig || null,
        confirmationUncertain,
      };
      console.log("✅ Position filled:", enriched);
      
      // Automatic position tracking if database is available
      // This UPDATE will merge with the pre-registered entry (uses ON CONFLICT DO UPDATE)
      if (this._enableAutoTracking && this._db && typeof this._db.logOpen === 'function') {
        try {
          // Use derived positionPda if filled position ID matches (first 8 chars), otherwise use filled ID
          const filledPosId = enriched.positionId || enriched.address;
          const finalPosId = (positionPda && filledPosId?.startsWith(positionPda.slice(0, 8))) 
            ? positionPda // Use full PDA to ensure DB consistency
            : filledPosId || Date.now().toString();
            
          this._db.logOpen({
            positionId: finalPosId,
            clientOrderId: enriched.clientOrderId,
            market: operationMarketSymbol, // Use captured market context
            side: enriched.side,
            entryPrice: enriched.entryPrice,
            collateral: enriched.collateral,
            leverage: enriched.leverage || (enriched.size / enriched.collateral),
            size: enriched.size,
            openTime: enriched.openTime,
            trade_type: 'automated', // Ensure we mark as automated on successful fill
            ...this._tradeMetadata,
          });
          console.log(`📊 Position logged to database: ${finalPosId?.slice(0, 8)}... (updated from pre-registration)`);
        } catch (dbError) {
          console.warn(`⚠️  Failed to log position to database: ${dbError.message}`);
        }
      }
      
      return enriched;
    } finally {
      // CRITICAL: Always release the market lock, even if an error occurred
      console.log(`[OPEN_POSITION] Releasing lock for operation ${operationId}`);
      releaseLock();
    }
  }

  /**
   * Reset the close kill switch manually
   * Useful for recovery after fixing underlying issues
   */
  resetCloseKillSwitch() {
    const wasTripped = this.closeKillSwitchTripped;
    const lastError = this._lastKillSwitchError;
    this.closeKillSwitchTripped = false;
    this._lastKillSwitchTime = null;
    this._lastKillSwitchError = null;
    if (wasTripped) {
      console.log('✅ Close kill switch manually reset');
      if (lastError) {
        console.log(`   Previous error that triggered kill switch: ${lastError}`);
      }
    }
    return wasTripped;
  }

  /**
   * Get kill switch status for diagnostics
   */
  getKillSwitchStatus() {
    if (!this.closeKillSwitchTripped) {
      return {
        active: false,
        tripped: false,
        lastError: null,
        lastTriggerTime: null,
        timeSinceTrigger: null,
        timeUntilAutoReset: null,
        threshold: this.closeKillSwitchAfter,
      };
    }
    
    const KILL_SWITCH_RESET_MS = 5 * 60 * 1000; // 5 minutes
    const timeSinceKillSwitch = this._lastKillSwitchTime 
      ? Date.now() - this._lastKillSwitchTime 
      : null;
    const timeUntilAutoReset = timeSinceKillSwitch 
      ? Math.max(0, KILL_SWITCH_RESET_MS - timeSinceKillSwitch) 
      : null;
    
    return {
      active: true,
      tripped: true,
      lastError: this._lastKillSwitchError || null,
      lastTriggerTime: this._lastKillSwitchTime || null,
      timeSinceTrigger: timeSinceKillSwitch ? Math.round(timeSinceKillSwitch / 1000 / 60) : null,
      timeUntilAutoReset: timeUntilAutoReset ? Math.round(timeUntilAutoReset / 1000 / 60) : null,
      threshold: this.closeKillSwitchAfter,
    };
  }

  /**
   * Close a specific position on Jupiter Perps
   * 
   * @param {Object|number} positionOrPriceLimit - Position object to close, or price limit (for backwards compatibility)
   * @param {number} [priceLimit] - Price limit for the close order (optional)
   * @returns {Promise<Object>} Close result
   * 
   * CRITICAL: If position is provided, this will close ONLY that specific position (matched by side).
   * If only priceLimit is provided (backwards compat), it will close the first position found.
   */
  async closePosition(positionOrPriceLimit, priceLimit) {
    await this.init();
    
    // Handle backwards compatibility: closePosition(priceLimit) vs closePosition(position, priceLimit)
    let targetPosition = null;
    let actualPriceLimit = priceLimit;
    
    if (positionOrPriceLimit && typeof positionOrPriceLimit === 'object') {
      // New signature: closePosition(position, priceLimit)
      targetPosition = positionOrPriceLimit;
      actualPriceLimit = priceLimit;
      console.log(`[CLOSE_POSITION] Targeting specific position: side=${targetPosition.side}, positionId=${targetPosition.positionId?.slice(0, 8) || 'unknown'}...`);
    } else if (typeof positionOrPriceLimit === 'number') {
      // Old signature: closePosition(priceLimit)
      actualPriceLimit = positionOrPriceLimit;
      console.log(`[CLOSE_POSITION] No target position specified - will close first position found (legacy mode)`);
    }
    
    // CRITICAL FIX: Reset kill switch if enough time has passed since last failure
    // This allows retry after transient errors without manual intervention
    const KILL_SWITCH_RESET_MS = 5 * 60 * 1000; // 5 minutes
    if (this.closeKillSwitchTripped && this._lastKillSwitchTime) {
      const timeSinceKillSwitch = Date.now() - this._lastKillSwitchTime;
      if (timeSinceKillSwitch > KILL_SWITCH_RESET_MS) {
        const resetMsg = `🔄 Kill switch auto-reset after ${(timeSinceKillSwitch / 1000 / 60).toFixed(1)} minutes`;
        console.log(resetMsg);
        this.closeKillSwitchTripped = false;
        this._lastKillSwitchTime = null;
        this._lastKillSwitchError = null; // Clear the error context
      } else {
        // Kill switch is still active - provide detailed error message
        const timeRemaining = Math.ceil((KILL_SWITCH_RESET_MS - timeSinceKillSwitch) / 1000 / 60);
        const lastError = this._lastKillSwitchError || 'unknown error';
        const errorMsg = `🚨 CLOSE KILL SWITCH ACTIVE - Position closing is blocked\n` +
          `   Reason: Kill switch was triggered after ${this.closeKillSwitchAfter || 'N/A'} failed close attempts\n` +
          `   Last error: ${lastError}\n` +
          `   Time remaining until auto-reset: ${timeRemaining} minute(s)\n` +
          `   Action: Wait for auto-reset or manually reset via resetCloseKillSwitch()`;
        console.error(`\n${errorMsg}\n`);
        throw new Error(errorMsg);
      }
    }
    
    if (this.closeKillSwitchTripped) {
      const lastError = this._lastKillSwitchError || 'unknown error';
      const errorMsg = `🚨 CLOSE KILL SWITCH ACTIVE - Position closing is blocked\n` +
        `   Reason: Kill switch was triggered after ${this.closeKillSwitchAfter || 'N/A'} failed close attempts\n` +
        `   Last error: ${lastError}\n` +
        `   Action: Wait for auto-reset (5 minutes) or manually reset via resetCloseKillSwitch()`;
      console.error(`\n${errorMsg}\n`);
      throw new Error(errorMsg);
    }

    // Get position data before closing for database logging and error reporting
    let positionBeforeClose = null;
    if (this._enableAutoTracking && this._db && typeof this._db.logClose === 'function') {
      try {
        positionBeforeClose = await this.getOpenPosition();
      } catch (err) {
        console.warn(`⚠️  Could not fetch position before close: ${err.message}`);
      }
    }
    
    // Also fetch position for error reporting (even if DB tracking is disabled)
    if (!positionBeforeClose) {
      try {
        positionBeforeClose = await this.getOpenPosition();
      } catch (err) {
        console.warn(`⚠️  Could not fetch position for error reporting: ${err.message}`);
      }
    }

    const req = {
      slippageBps: Number.isFinite(this.slippageBps) ? this.slippageBps : 0,
      priceLimit: actualPriceLimit || undefined,
      // CRITICAL: Pass target position to ensure we close the CORRECT position
      // This prevents closing the wrong position when multiple positions exist on same market
      targetPosition: targetPosition || null,
    };

    let attempts = 0;
    let lastError = null;
    const fees = this.closePrioritySteps;
    const maxAttempts = Math.max(this.closeMaxAttempts, fees.length);

    while (attempts < maxAttempts) {
      attempts += 1;
      const fee = fees[Math.min(attempts - 1, fees.length - 1)];

      try {
        const tx = await this._manualCreateDecreaseRequest(req);
        const sig = await this._sendAndConfirm(tx, {
          priorityFee: Number.isFinite(fee) ? fee : undefined,
        });
        console.log(`📤 Decrease request sent: ${sig} (attempt ${attempts}, priority ${fee || 0})`);
        
        // Wait for keeper to execute the close (same pattern as openPosition)
        const closeResult = await this._waitForClose();
        
        // Reset kill switch on successful close
        if (this.closeKillSwitchTripped) {
          console.log(`✅ Kill switch reset after successful close`);
          this.closeKillSwitchTripped = false;
          this._lastKillSwitchTime = null;
          this._lastKillSwitchError = null;
        }
        
        // Automatic position tracking if database is available
        if (this._enableAutoTracking && this._db && typeof this._db.logClose === 'function' && positionBeforeClose) {
          try {
            // Fetch current price for P&L calculation
            let exitPrice = 0;
            try {
              const currentPos = await this.getOpenPosition();
              exitPrice = currentPos?.entryPrice || positionBeforeClose.entryPrice;
            } catch {
              exitPrice = positionBeforeClose.entryPrice;
            }
            
            this._db.logClose(
              {
                positionId: positionBeforeClose.address || positionBeforeClose.positionId,
                clientOrderId: positionBeforeClose.clientOrderId,
                market: this.marketSymbol,
                ...this._tradeMetadata,
              },
              positionBeforeClose.entryPrice,
              exitPrice,
              'auto_close'
            );
            console.log(`📊 Position close logged to database`);
          } catch (dbError) {
            console.warn(`⚠️  Failed to log close to database: ${dbError.message}`);
          }
        }
        
        return { 
          ok: true, 
          sig, 
          signature: sig,
          attempts, 
          priorityFee: fee || 0,
          ...closeResult
        };
      } catch (error) {
        lastError = error;
        
        // ROOT CAUSE FIX: Don't count "already closed" errors as failures
        // These indicate the position was already closed on-chain, which is a success case
        const errorMsg = String(error?.message || '');
        const isAlreadyClosedError = errorMsg.includes('No open manual position to close') ||
                                     errorMsg.includes('no open manual position') ||
                                     errorMsg.includes('position may have already been closed');
        
        if (isAlreadyClosedError) {
          // Position already closed - this is a success case, not a failure
          // Return success immediately without triggering kill switch
          console.log(`✅ Position already closed on-chain. Treating as successful close.`);
          return { 
            ok: true, 
            sig: 'already_closed', 
            signature: 'already_closed',
            attempts, 
            priorityFee: fee || 0,
            alreadyClosed: true
          };
        }
        
        // Enhanced error logging for SendTransactionError
        if (error instanceof SendTransactionError) {
          console.error(`❌ SendTransactionError on close attempt ${attempts}:`, error.message);
          await this._logSendTransactionError(error);
          
          // Check for specific InvalidArgument error in logs
          try {
            const logs = await error.getLogs(this.connection);
            if (Array.isArray(logs)) {
              const hasInvalidArgument = logs.some(log => 
                log.includes('InvalidArgument') || 
                log.includes('Invalid argument') ||
                log.includes('6015')
              );
              if (hasInvalidArgument) {
                console.error(`\n🔍 InvalidArgument error detected - this usually indicates:`);
                console.error(`   1. Position data mismatch (sizeUsdDelta or collateralUsdDelta)`);
                console.error(`   2. Position may have already been closed`);
                console.error(`   3. Position data may be stale - try refreshing position state`);
                const posSizeUsd = positionBeforeClose?.sizeUsd || positionBeforeClose?.size || 'N/A';
                const posCollateralUsd = positionBeforeClose?.collateralUsd || positionBeforeClose?.collateral || 'N/A';
                console.error(`   Position data used: sizeUsd=${typeof posSizeUsd === 'number' ? posSizeUsd.toFixed(2) : posSizeUsd}, collateralUsd=${typeof posCollateralUsd === 'number' ? posCollateralUsd.toFixed(2) : posCollateralUsd}`);
                
                // Suggest refreshing position data
                console.error(`\n💡 Suggestion: Verify position still exists with: await client.getOpenPosition()`);
              }
            }
          } catch (logErr) {
            // Ignore log fetch errors, we already logged the main error
          }
        } else {
          console.warn(`⚠️ Close attempt ${attempts} failed${Number.isFinite(fee) ? ` (priority ${fee})` : ''}: ${error.message}`);
        }
        
        // Only count real failures toward kill switch threshold
        // "Already closed" errors are handled above and don't reach here
        if (attempts >= this.closeKillSwitchAfter) {
          this.closeKillSwitchTripped = true;
          this._lastKillSwitchTime = Date.now();
          // Store the error message for better diagnostics
          const errorSummary = error instanceof SendTransactionError 
            ? `SendTransactionError: ${error.message}`
            : error.message || 'Unknown error';
          this._lastKillSwitchError = errorSummary;
          
          // Enhanced error logging with full context
          console.error(`\n🚨 ========== CLOSE KILL SWITCH ACTIVATED ==========`);
          console.error(`   Attempts: ${attempts} (threshold: ${this.closeKillSwitchAfter})`);
          console.error(`   Error: ${errorSummary}`);
          if (positionBeforeClose) {
            console.error(`   Position: ${positionBeforeClose.positionId || 'N/A'}`);
            console.error(`   Market: ${this.marketSymbol || 'N/A'}`);
            console.error(`   Size: ${positionBeforeClose.sizeUsd || positionBeforeClose.size || 'N/A'}`);
          }
          console.error(`   Auto-reset: 5 minutes from now`);
          console.error(`   Manual reset: Call resetCloseKillSwitch() or use /api/reset-kill-switch`);
          console.error(`==================================================\n`);
          
          const killSwitchError = new Error(
            `🚨 CLOSE KILL SWITCH TRIGGERED after ${attempts} failed attempts\n` +
            `   Last error: ${errorSummary}\n` +
            `   Kill switch will auto-reset in 5 minutes\n` +
            `   To reset manually: Call resetCloseKillSwitch() or use /api/reset-kill-switch`
          );
          killSwitchError.name = 'CloseKillSwitchError';
          killSwitchError.attempts = attempts;
          killSwitchError.lastError = errorSummary;
          killSwitchError.positionId = positionBeforeClose?.positionId;
          throw killSwitchError;
        }
        if (attempts >= maxAttempts) {
          break;
        }
        if (this.closeRetryDelayMs > 0) {
          await sleep(this.closeRetryDelayMs);
        }
      }
    }

    // CLOSE RECONCILIATION: Before throwing, check if position actually closed on-chain
    // This handles timeout cases where the transaction succeeded but confirmation failed
    console.log(`🔍 [CLOSE_RECONCILIATION] Checking if position actually closed on-chain...`);
    try {
      const currentPositions = await this.getAllOpenPositions().catch(() => []);
      let positionStillExists = false;
      
      if (targetPosition) {
        // Check for the specific target position
        positionStillExists = currentPositions.some(p => {
          const posId = p.positionId || p.id || p.address || '';
          return (posId === targetPosition.positionId) ||
                 (p.marketIndex === targetPosition.marketIndex && p.side === targetPosition.side);
        });
      } else {
        // Check for any position on current market
        const target = (this.market?.marketAddress || this.market?.address || this.marketSymbol).toString();
        positionStillExists = currentPositions.some(p => 
          String(p.market || p.marketPk || p.marketAddress || p.custody) === target
        );
      }
      
      if (!positionStillExists) {
        // Position is actually closed! Transaction must have succeeded despite confirmation timeout
        console.log(`✅ [CLOSE_RECONCILIATION] Position confirmed closed on-chain despite tx errors`);
        return { 
          ok: true, 
          sig: 'reconciled_closed', 
          signature: 'reconciled_closed',
          attempts, 
          priorityFee: this.closePrioritySteps[Math.min(attempts - 1, this.closePrioritySteps.length - 1)] || 0,
          reconciled: true,
          note: 'Position confirmed closed via on-chain reconciliation after tx timeout/error'
        };
      } else {
        console.log(`❌ [CLOSE_RECONCILIATION] Position still exists on-chain - close truly failed`);
      }
    } catch (reconcileErr) {
      console.warn(`⚠️  [CLOSE_RECONCILIATION] Failed to verify on-chain state: ${reconcileErr.message}`);
    }

    throw new Error(`Close failed after ${attempts} attempts: ${lastError?.message || 'unknown error'}`);
  }
}

module.exports = JupiterPerpsLive;
module.exports.MARKET_REGISTRY = MARKET_REGISTRY;

