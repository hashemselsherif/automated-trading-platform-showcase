/**
 * Secure Wallet Loader
 * 
 * Jupiter-grade wallet loading module that:
 * - Supports WALLET_PRIVATE_KEY env var (JSON array or base58)
 * - Supports WALLET_PRIVATE_KEY_PATH file (plain or encrypted)
 * - Validates file permissions (600 or 640 for Render)
 * - NEVER logs secret key bytes
 * - Can be used by both bot.js and drift-subprocess
 * 
 * Security guarantees:
 * - No private key material in IPC messages
 * - No secret bytes in logs
 * - Enforces file permissions in production
 */

const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

// Constants
const REQUIRED_PERMISSION_MODE = parseInt('600', 8);
const RENDER_SECRET_MODE = parseInt('640', 8);

/**
 * Check if running in Render environment
 */
function isRenderEnvironment() {
  return process.env.RENDER === 'true' || process.env.IS_PULL_REQUEST === 'true';
}

/**
 * Check if a wallet file is encrypted
 */
function isEncrypted(walletPath) {
  try {
    const content = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    return !!(content.encrypted && content.algorithm);
  } catch {
    return false;
  }
}

/**
 * Validate file permissions (Unix only)
 * @param {string} walletPath - Path to wallet file
 * @param {Object} options - Options
 * @param {boolean} options.enforce - Throw on invalid permissions (default: true in production)
 * @throws {Error} If permissions are invalid and enforce is true
 * @returns {{ valid: boolean, mode: number, message?: string }}
 */
function validateFilePermissions(walletPath, options = {}) {
  const enforce = options.enforce ?? (process.env.NODE_ENV === 'production' || process.env.ENFORCE_WALLET_PERMISSIONS === 'true');
  
  // Windows doesn't have Unix-style permissions
  if (process.platform === 'win32') {
    return { valid: true, mode: 0, message: 'Permissions check skipped on Windows' };
  }
  
  try {
    const stats = fs.statSync(walletPath);
    const mode = stats.mode & parseInt('777', 8);
    
    const isRenderSecretFile = walletPath.startsWith('/etc/secrets/') || isRenderEnvironment();
    const isValidMode = mode === REQUIRED_PERMISSION_MODE || (isRenderSecretFile && mode === RENDER_SECRET_MODE);
    
    if (!isValidMode) {
      const message = `Wallet file permissions are ${mode.toString(8)}, must be 600${isRenderSecretFile ? ' (or 640 for Render)' : ''}. Run: chmod 600 ${walletPath}`;
      
      if (enforce) {
        throw new Error(message);
      }
      
      return { valid: false, mode, message };
    }
    
    return { valid: true, mode };
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Wallet file not found: ${walletPath}`);
    }
    throw e;
  }
}

/**
 * Load keypair from environment variable
 * Supports JSON array or base58 string
 * @param {string} privateKeyEnv - Private key from environment
 * @returns {Keypair}
 * @throws {Error} If format is invalid
 */
function loadFromEnvVar(privateKeyEnv) {
  // Try JSON array first
  try {
    const secret = JSON.parse(privateKeyEnv);
    if (!Array.isArray(secret) || secret.length !== 64) {
      throw new Error('JSON must be an array of 64 bytes');
    }
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (jsonError) {
    // Try base58
    try {
      const bs58 = require('bs58').default || require('bs58');
      const secret = bs58.decode(privateKeyEnv);
      return Keypair.fromSecretKey(secret);
    } catch (bs58Error) {
      throw new Error('Invalid WALLET_PRIVATE_KEY format. Must be JSON array [1,2,3,...] or base58 string.');
    }
  }
}

/**
 * Load keypair from file (plain or encrypted)
 * @param {string} walletPath - Path to wallet file
 * @param {Object} options - Options
 * @param {string} options.password - Password for encrypted wallets (or from WALLET_PASSWORD env)
 * @param {boolean} options.validatePermissions - Whether to validate file permissions (default: true)
 * @param {boolean} options.enforcePermissions - Whether to throw on invalid permissions (default: auto based on NODE_ENV)
 * @returns {Keypair}
 * @throws {Error} If file not found, invalid format, or decryption fails
 */
function loadFromFile(walletPath, options = {}) {
  const {
    password = process.env.WALLET_PASSWORD,
    validatePermissions = true,
    enforcePermissions
  } = options;
  
  // Check file exists
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }
  
  // Validate permissions
  if (validatePermissions) {
    const permResult = validateFilePermissions(walletPath, { enforce: enforcePermissions });
    if (!permResult.valid && permResult.message) {
      // Warning is logged at a higher level, not here (to avoid duplicate logging)
    }
  }
  
  // Check if encrypted
  if (isEncrypted(walletPath)) {
    if (!password) {
      throw new Error('Wallet file is encrypted but no password provided. Set WALLET_PASSWORD environment variable.');
    }
    
    try {
      const walletEncryption = require('./wallet-encryption');
      const secret = walletEncryption.loadEncryptedWallet(walletPath, password);
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    } catch (e) {
      throw new Error(`Wallet decryption failed: ${e.message}`);
    }
  }
  
  // Plain JSON wallet
  try {
    const content = fs.readFileSync(walletPath, 'utf8');
    const secret = JSON.parse(content);
    
    if (!Array.isArray(secret)) {
      throw new Error('Wallet file must contain a JSON array of bytes');
    }
    
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (e) {
    if (e.message.includes('JSON array')) {
      throw e;
    }
    throw new Error(`Failed to load wallet file: ${e.message}`);
  }
}

/**
 * Load wallet keypair from environment or file
 * 
 * Priority:
 * 1. WALLET_PRIVATE_KEY env var (if set)
 * 2. WALLET_PRIVATE_KEY_PATH file (or default path)
 * 3. Generate random keypair if allowGenerate is true (for paper trading)
 * 
 * @param {Object} options - Options
 * @param {boolean} options.allowGenerate - Allow generating random keypair if no wallet found (default: false)
 * @param {string} options.defaultPath - Default wallet path if WALLET_PRIVATE_KEY_PATH not set
 * @param {boolean} options.quiet - Suppress non-error logging (default: false)
 * @param {boolean} options.validatePermissions - Whether to validate file permissions (default: true)
 * @param {boolean} options.enforcePermissions - Whether to throw on invalid permissions
 * @returns {{ keypair: Keypair, source: string, pubkey: string }}
 * @throws {Error} If wallet cannot be loaded and allowGenerate is false
 */
function loadWallet(options = {}) {
  const {
    allowGenerate = false,
    defaultPath = path.join(process.cwd(), 'perps-wallet.json'),
    quiet = false,
    validatePermissions = true,
    enforcePermissions
  } = options;
  
  const log = quiet ? () => {} : console.log.bind(console);
  const warn = quiet ? () => {} : console.warn.bind(console);
  
  // 1. Try environment variable
  const privateKeyEnv = process.env.WALLET_PRIVATE_KEY;
  if (privateKeyEnv) {
    log('[SecureWalletLoader] Loading from WALLET_PRIVATE_KEY environment variable');
    const keypair = loadFromEnvVar(privateKeyEnv);
    const pubkey = keypair.publicKey.toBase58();
    log(`[SecureWalletLoader] Loaded wallet: ${pubkey}`);
    return { keypair, source: 'env:WALLET_PRIVATE_KEY', pubkey };
  }
  
  // 2. Try file
  const walletPath = process.env.WALLET_PRIVATE_KEY_PATH || defaultPath;
  
  if (fs.existsSync(walletPath)) {
    log(`[SecureWalletLoader] Loading from file: ${walletPath}`);
    
    // Validate permissions first (log warning if invalid but don't throw unless enforced)
    if (validatePermissions && process.platform !== 'win32') {
      try {
        const permResult = validateFilePermissions(walletPath, { enforce: false });
        if (!permResult.valid && permResult.message) {
          warn(`[SecureWalletLoader] Warning: ${permResult.message}`);
        }
      } catch (e) {
        // Ignore permission check errors at this stage; they'll be caught in loadFromFile if enforced
      }
    }
    
    const keypair = loadFromFile(walletPath, { validatePermissions, enforcePermissions });
    const pubkey = keypair.publicKey.toBase58();
    log(`[SecureWalletLoader] Loaded wallet: ${pubkey}`);
    return { keypair, source: `file:${walletPath}`, pubkey };
  }
  
  // 3. Generate if allowed
  if (allowGenerate) {
    warn('[SecureWalletLoader] No wallet found, generating random keypair (paper trading only)');
    const keypair = Keypair.generate();
    const pubkey = keypair.publicKey.toBase58();
    log(`[SecureWalletLoader] Generated keypair: ${pubkey}`);
    return { keypair, source: 'generated', pubkey };
  }
  
  // 4. Error - no wallet available
  throw new Error(
    `Wallet not found. Set WALLET_PRIVATE_KEY env var or ensure ${walletPath} exists. ` +
    `See docs/WALLET_DEPLOYMENT_SETUP.md for setup instructions.`
  );
}

/**
 * Get wallet public key only (for logging/display without loading full keypair)
 * Useful for verification without exposing secret key in memory longer than needed
 * 
 * @param {Object} options - Same as loadWallet
 * @returns {string} Public key as base58 string
 */
function getWalletPubkey(options = {}) {
  const { keypair } = loadWallet({ ...options, quiet: true });
  return keypair.publicKey.toBase58();
}

/**
 * Verify wallet can be loaded without returning the keypair
 * Returns metadata about the wallet source and pubkey
 * 
 * @param {Object} options - Same as loadWallet
 * @returns {{ success: boolean, source: string, pubkey?: string, error?: string }}
 */
function verifyWallet(options = {}) {
  try {
    const result = loadWallet({ ...options, quiet: true });
    return {
      success: true,
      source: result.source,
      pubkey: result.pubkey
    };
  } catch (e) {
    return {
      success: false,
      source: 'none',
      error: e.message
    };
  }
}

module.exports = {
  loadWallet,
  loadFromFile,
  loadFromEnvVar,
  validateFilePermissions,
  isEncrypted,
  getWalletPubkey,
  verifyWallet,
  isRenderEnvironment,
  
  // Constants for testing
  REQUIRED_PERMISSION_MODE,
  RENDER_SECRET_MODE
};




