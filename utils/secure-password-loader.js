#!/usr/bin/env node
/**
 * Secure Password Loader
 * 
 * Loads sensitive passwords securely with multiple fallback strategies:
 * 1. From encrypted .secrets.enc.json file (most secure)
 * 2. From environment variables (backward compatibility)
 * 3. Prompt user at runtime (interactive mode)
 * 
 * Usage:
 *   const { getWalletPassword, getManualTradePassword } = require('./utils/secure-password-loader');
 *   const walletPassword = await getWalletPassword();
 */

const fs = require('fs');
const path = require('path');

// Import encryption functions from secrets-manager
const { loadSecretsFile, SECRETS_FILE } = require('../tools/secrets-manager');

// Cache for loaded passwords (in memory only, cleared on process exit)
const passwordCache = {
  wallet: null,
  manualTrade: null,
  masterPassword: null,
};

/**
 * Check if running under PM2
 */
function isRunningInPM2() {
  return !!(process.env.PM2_HOME || process.env.pm_id !== undefined || process.env.name);
}

/**
 * Prompt for password in terminal (hidden input)
 */
function askPassword(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    
    // Check if stdin is a TTY (interactive terminal)
    if (!stdin.isTTY) {
      // Detect PM2 and provide specific guidance
      if (isRunningInPM2()) {
        const error = new Error(
          '\n' +
          '═══════════════════════════════════════════════════════════════════\n' +
          '❌ PM2 DAEMON MODE DOES NOT SUPPORT INTERACTIVE PROMPTS\n' +
          '═══════════════════════════════════════════════════════════════════\n' +
          '\n' +
          'PM2 runs in background (daemon) mode without terminal input.\n' +
          'You must set the master password using one of these methods:\n' +
          '\n' +
          '📋 Solution 1: PM2 Environment Variable (Recommended)\n' +
          '   pm2 set jupiter-perps-bot:SECRETS_MASTER_PASSWORD "your_master_password"\n' +
          '   pm2 restart jupiter-perps-bot --update-env\n' +
          '\n' +
          '📋 Solution 2: Export Before Starting\n' +
          '   export SECRETS_MASTER_PASSWORD="your_master_password"\n' +
          '   pm2 restart jupiter-perps-bot --update-env\n' +
          '\n' +
          '📋 Solution 3: Update ecosystem.config.js\n' +
          '   Add to env_production:\n' +
          '   SECRETS_MASTER_PASSWORD: "your_master_password"\n' +
          '\n' +
          '📋 Solution 4: Run Without PM2 (Interactive)\n' +
          '   pm2 stop jupiter-perps-bot\n' +
          '   node bot.js\n' +
          '   # Bot will prompt for password\n' +
          '\n' +
          '💡 Tip: Check if password is set:\n' +
          '   pm2 env 0  # Look for SECRETS_MASTER_PASSWORD\n' +
          '\n' +
          '═══════════════════════════════════════════════════════════════════\n'
        );
        error.code = 'PM2_NO_INTERACTIVE';
        reject(error);
        return;
      }
      
      // Non-PM2 non-interactive mode (CI/CD, systemd, etc.)
      const error = new Error(
        '\n' +
        '❌ No interactive terminal available (stdin is not a TTY).\n' +
        'Set SECRETS_MASTER_PASSWORD environment variable before starting:\n' +
        '  export SECRETS_MASTER_PASSWORD="your_master_password"\n' +
        '  node bot.js\n'
      );
      error.code = 'NO_TTY';
      reject(error);
      return;
    }
    
    stdout.write(question);
    
    stdin.setRawMode(true);
    stdin.resume();
    
    let password = '';
    function onData(char) {
      char = char.toString('utf8');
      
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(password);
          break;
        case '\u0003': // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(null);
          break;
        case '\u007f': // Backspace
          password = password.slice(0, -1);
          stdout.clearLine();
          stdout.cursorTo(0);
          stdout.write(question + '*'.repeat(password.length));
          break;
        default:
          password += char;
          stdout.write('*');
          break;
      }
    }
    
    stdin.on('data', onData);
  });
}

/**
 * Check if running in non-interactive environment (Render, CI/CD, etc.)
 */
function isNonInteractive() {
  return !process.stdin.isTTY || 
         process.env.RENDER === 'true' || 
         process.env.CI === 'true' ||
         process.env.NODE_ENV === 'production';
}

/**
 * Get master password for encrypted secrets file
 */
async function getMasterPassword() {
  if (passwordCache.masterPassword) {
    return passwordCache.masterPassword;
  }
  
  // Try environment variable first (for automation/testing)
  const masterPasswordFromEnv = process.env.SECRETS_MASTER_PASSWORD;
  if (masterPasswordFromEnv) {
    console.log('✅ [SECURE] Master password loaded from environment variable');
    passwordCache.masterPassword = masterPasswordFromEnv;
    return passwordCache.masterPassword;
  }
  
  // Try Render Secret File (for Render deployments using Secret Files)
  const renderSecretPath = '/etc/secrets/SECRETS_MASTER_PASSWORD';
  if (fs.existsSync(renderSecretPath)) {
    try {
      const masterPasswordFromFile = fs.readFileSync(renderSecretPath, 'utf8').trim();
      if (masterPasswordFromFile) {
        console.log('✅ [SECURE] Master password loaded from Render Secret File');
        passwordCache.masterPassword = masterPasswordFromFile;
        return passwordCache.masterPassword;
      }
    } catch (fileError) {
      console.warn('⚠️  [SECURE] Could not read Render Secret File:', fileError.message);
    }
  }
  
  // Debug: Log available env vars (without values) for troubleshooting
  if (isNonInteractive()) {
    const envKeys = Object.keys(process.env).filter(k => k.includes('SECRET') || k.includes('PASSWORD'));
    console.log('🔍 [DEBUG] Environment variables containing SECRET/PASSWORD:', envKeys.length > 0 ? envKeys.join(', ') : 'none found');
    console.log('🔍 [DEBUG] SECRETS_MASTER_PASSWORD is set:', !!process.env.SECRETS_MASTER_PASSWORD);
    console.log('🔍 [DEBUG] Render Secret File exists:', fs.existsSync(renderSecretPath));
    
    // Fail fast on non-interactive environments (Render, CI/CD)
    const error = new Error(
      '\n' +
      '═══════════════════════════════════════════════════════════════════\n' +
      '❌ SECRETS_MASTER_PASSWORD not found\n' +
      '═══════════════════════════════════════════════════════════════════\n' +
      '\n' +
      'Running in non-interactive environment (Render/CI/CD).\n' +
      'Interactive prompts are not available.\n' +
      '\n' +
      '📋 Solution: Set SECRETS_MASTER_PASSWORD using one of these methods:\n' +
      '\n' +
      'For Render (Option 1 - Recommended):\n' +
      '  1. Go to Render Dashboard → Your Service → Environment\n' +
      '  2. Add Environment Variable:\n' +
      '     Key: SECRETS_MASTER_PASSWORD\n' +
      '     Value: your_master_password\n' +
      '     ✅ Check "Secret" (hides from logs)\n' +
      '  3. Save Changes (auto-redeploys)\n' +
      '\n' +
      'For Render (Option 2 - Secret File):\n' +
      '  1. Go to Render Dashboard → Your Service → Environment\n' +
      '  2. Scroll to "Secret Files" section\n' +
      '  3. Add Secret File:\n' +
      '     Filename: SECRETS_MASTER_PASSWORD\n' +
      '     Contents: your_master_password\n' +
      '  4. Save Changes (auto-redeploys)\n' +
      '\n' +
      'For CI/CD:\n' +
      '  export SECRETS_MASTER_PASSWORD="your_master_password"\n' +
      '\n' +
      '═══════════════════════════════════════════════════════════════════\n'
    );
    error.code = 'NO_MASTER_PASSWORD';
    throw error;
  }
  
  // Prompt user (only in interactive environments)
  const password = await askPassword('🔐 Enter master password for encrypted secrets: ');
  if (password) {
    passwordCache.masterPassword = password;
  }
  
  return password;
}

/**
 * Get wallet password from secure sources
 * 
 * Priority:
 * 1. Cached in memory
 * 2. From encrypted .secrets.enc.json
 * 3. From WALLET_PASSWORD environment variable
 * 4. From Render Secret File (/etc/secrets/WALLET_PASSWORD)
 * 5. Prompt user interactively
 * 
 * @param {boolean} allowPrompt - Allow prompting user (default: true)
 * @returns {Promise<string|null>} Wallet password or null
 */
async function getWalletPassword(allowPrompt = true) {
  // 1. Check cache
  if (passwordCache.wallet) {
    return passwordCache.wallet;
  }
  
  // 2. Try loading from encrypted secrets file
  if (fs.existsSync(SECRETS_FILE)) {
    try {
      const masterPassword = await getMasterPassword();
      if (masterPassword) {
        try {
          const secrets = loadSecretsFile(masterPassword);
          if (secrets?.wallet?.password) {
            passwordCache.wallet = secrets.wallet.password;
            console.log('✅ [SECURE] Wallet password loaded from encrypted storage');
            return passwordCache.wallet;
          } else {
            console.warn('⚠️  [SECURE] Encrypted secrets file exists but wallet password not found in it');
            console.warn('   Falling back to WALLET_PASSWORD environment variable...');
          }
        } catch (decryptError) {
          console.error('❌ [SECURE] Failed to decrypt secrets file:', decryptError.message);
          if (isNonInteractive()) {
            console.error('   This usually means SECRETS_MASTER_PASSWORD is incorrect or the secrets file was encrypted with a different password');
            console.error('   Falling back to WALLET_PASSWORD environment variable...');
          }
          // Don't throw - fall through to check WALLET_PASSWORD env var
        }
      }
    } catch (masterPasswordError) {
      // getMasterPassword() throws NO_MASTER_PASSWORD error on non-interactive environments
      // Only re-throw if we're in non-interactive mode (Render/CI/CD) - this means master password is required
      // In interactive mode, we can fall back to WALLET_PASSWORD or prompt
      if (masterPasswordError.code === 'NO_MASTER_PASSWORD' && isNonInteractive()) {
        // On Render/CI/CD, if secrets file exists but master password is missing, that's an error
        throw masterPasswordError;
      }
      // Otherwise, log and fall through to check WALLET_PASSWORD
      console.warn('⚠️  [SECURE] Could not get master password:', masterPasswordError.message);
      console.warn('   Falling back to WALLET_PASSWORD environment variable...');
    }
  } else {
    if (isNonInteractive()) {
      console.log('ℹ️  [SECURE] Encrypted secrets file (.secrets.enc.json) not found');
      console.log('   Using WALLET_PASSWORD environment variable instead');
      console.log('   (To use encrypted storage, commit .secrets.enc.json to your repository)');
    }
  }
  
  // 3. Try environment variable (backward compatibility)
  if (process.env.WALLET_PASSWORD) {
    console.warn('⚠️  [SECURITY] Using WALLET_PASSWORD from environment variables');
    console.warn('   Consider using encrypted storage: npm run secrets (option 2)');
    passwordCache.wallet = process.env.WALLET_PASSWORD;
    return passwordCache.wallet;
  }
  
  // 4. Try Render Secret File for WALLET_PASSWORD
  const walletSecretPath = '/etc/secrets/WALLET_PASSWORD';
  if (fs.existsSync(walletSecretPath)) {
    try {
      const walletPasswordFromFile = fs.readFileSync(walletSecretPath, 'utf8').trim();
      if (walletPasswordFromFile) {
        console.warn('⚠️  [SECURITY] Using WALLET_PASSWORD from Render Secret File');
        console.warn('   Consider using encrypted storage: npm run secrets (option 2)');
        passwordCache.wallet = walletPasswordFromFile;
        return passwordCache.wallet;
      }
    } catch (fileError) {
      console.warn('⚠️  [SECURE] Could not read WALLET_PASSWORD from Render Secret File:', fileError.message);
    }
  }
  
  // 5. Prompt user (only in interactive mode, never on Render/CI/CD)
  if (allowPrompt && !isNonInteractive()) {
    console.log('🔐 [SECURE] Wallet password not found in encrypted storage or environment');
    const password = await askPassword('Enter wallet password: ');
    if (password) {
      passwordCache.wallet = password;
      return password;
    }
  }
  
  // On non-interactive environments, return null (error will be thrown by caller)
  if (isNonInteractive()) {
    console.error('❌ [SECURE] Wallet password not found and cannot prompt in non-interactive environment');
  }
  
  return null;
}

/**
 * Get manual trade password from secure sources
 * 
 * Priority:
 * 1. Cached in memory
 * 2. From encrypted .secrets.enc.json
 * 3. From MANUAL_TRADE_PASSWORD environment variable
 * 4. From API_KEY environment variable (fallback)
 * 5. Prompt user interactively
 * 
 * @param {boolean} allowPrompt - Allow prompting user (default: true)
 * @returns {Promise<string|null>} Manual trade password or null
 */
async function getManualTradePassword(allowPrompt = true) {
  // 1. Check cache
  if (passwordCache.manualTrade) {
    return passwordCache.manualTrade;
  }
  
  // 2. Try loading from encrypted secrets file
  if (fs.existsSync(SECRETS_FILE)) {
    const masterPassword = await getMasterPassword();
    if (masterPassword) {
      const secrets = loadSecretsFile(masterPassword);
      if (secrets?.manualTrade?.password) {
        passwordCache.manualTrade = secrets.manualTrade.password;
        console.log('✅ [SECURE] Manual trade password loaded from encrypted storage');
        return passwordCache.manualTrade;
      }
      // Try API key from secrets as fallback
      if (secrets?.api?.key) {
        passwordCache.manualTrade = secrets.api.key;
        console.log('✅ [SECURE] Using API_KEY from encrypted storage for manual trades');
        return passwordCache.manualTrade;
      }
    }
  }
  
  // 3. Try environment variable
  if (process.env.MANUAL_TRADE_PASSWORD) {
    console.warn('⚠️  [SECURITY] Using MANUAL_TRADE_PASSWORD from environment variables');
    console.warn('   Consider using encrypted storage: npm run secrets (option 2)');
    passwordCache.manualTrade = process.env.MANUAL_TRADE_PASSWORD;
    return passwordCache.manualTrade;
  }
  
  // 4. Try API_KEY as fallback
  if (process.env.API_KEY) {
    passwordCache.manualTrade = process.env.API_KEY;
    return passwordCache.manualTrade;
  }
  
  // 5. Prompt user (only in interactive mode)
  if (allowPrompt) {
    console.log('🔐 [SECURE] Manual trade password not found in encrypted storage or environment');
    const password = await askPassword('Enter manual trade password: ');
    if (password) {
      passwordCache.manualTrade = password;
      return password;
    }
  }
  
  return null;
}

/**
 * Check if encrypted secrets file exists
 */
function hasEncryptedSecrets() {
  return fs.existsSync(SECRETS_FILE);
}

/**
 * Clear password cache (useful for testing or security)
 */
function clearCache() {
  passwordCache.wallet = null;
  passwordCache.manualTrade = null;
  passwordCache.masterPassword = null;
}

/**
 * Get synchronous password (for compatibility with non-async code)
 * Only works if password is cached or in environment
 */
function getWalletPasswordSync() {
  if (passwordCache.wallet) {
    return passwordCache.wallet;
  }
  
  if (process.env.WALLET_PASSWORD) {
    return process.env.WALLET_PASSWORD;
  }
  
  return null;
}

/**
 * Get synchronous manual trade password
 * Only works if password is cached or in environment
 */
function getManualTradePasswordSync() {
  if (passwordCache.manualTrade) {
    return passwordCache.manualTrade;
  }
  
  if (process.env.MANUAL_TRADE_PASSWORD) {
    return process.env.MANUAL_TRADE_PASSWORD;
  }
  
  if (process.env.API_KEY) {
    return process.env.API_KEY;
  }
  
  return null;
}

module.exports = {
  getWalletPassword,
  getManualTradePassword,
  hasEncryptedSecrets,
  clearCache,
  getWalletPasswordSync,
  getManualTradePasswordSync,
};

