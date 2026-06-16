#!/usr/bin/env node
/**
 * Centralized Secrets Manager
 * Secure management and viewing of all critical credentials
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const readline = require('readline');
const { loadEncryptedWallet, isEncrypted, saveEncryptedWallet } = require('../utils/wallet-encryption');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

const SECRETS_FILE = path.join(process.cwd(), '.secrets.enc.json');
const ENV_FILE = path.join(process.cwd(), '.env');

// Color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

function printHeader() {
  console.log(colorize('\n╔═══════════════════════════════════════════════════════╗', 'cyan'));
  console.log(colorize('║        🔐 SECRETS MANAGER - Jupiter Perps Bot       ║', 'cyan'));
  console.log(colorize('╚═══════════════════════════════════════════════════════╝\n', 'cyan'));
}

function printSection(title) {
  console.log(colorize(`\n━━━ ${title} ━━━`, 'blue'));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function askPassword(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();

    let password = '';
    stdin.on('data', function onData(char) {
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
          process.exit();
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
    });
  });
}

// Robust line-based question that avoids readline/zsh quirks after raw-mode use
function askLine(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    // Ensure cooked mode
    if (stdin.isTTY) {
      try { stdin.setRawMode(false); } catch {}
    }
    stdin.resume();
    let buffer = '';
    function onData(chunk) {
      const s = chunk.toString('utf8');
      // Handle CR/LF
      if (s.includes('\n') || s.includes('\r')) {
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(buffer.trim());
        return;
      }
      buffer += s;
    }
    stdin.on('data', onData);
  });
}

// Encryption utilities for secrets file
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const ITERATIONS = 100000;

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

function encryptSecrets(secrets, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const dataString = JSON.stringify(secrets);
  let encrypted = cipher.update(dataString, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  const combined = Buffer.concat([
    salt,
    iv,
    tag,
    Buffer.from(encrypted, 'hex')
  ]);

  return {
    encrypted: combined.toString('hex'),
    algorithm: ALGORITHM,
    iterations: ITERATIONS,
    createdAt: new Date().toISOString(),
  };
}

function decryptSecrets(encryptedData, password) {
  try {
    const combined = Buffer.from(encryptedData.encrypted, 'hex');

    const salt = combined.slice(0, SALT_LENGTH);
    const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = combined.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = combined.slice(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    const key = deriveKey(password, salt);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted.toString('hex'), 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  } catch (e) {
    throw new Error('Decryption failed: Invalid password or corrupted file.');
  }
}

// Load secrets from encrypted file
function loadSecretsFile(password) {
  if (!fs.existsSync(SECRETS_FILE)) {
    return null;
  }

  const encryptedData = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  return decryptSecrets(encryptedData, password);
}

// Save secrets to encrypted file
function saveSecretsFile(secrets, password) {
  const encrypted = encryptSecrets(secrets, password);
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}

// Collect all secrets from environment and files
async function collectSecrets() {
  const secrets = {
    wallet: {},
    api: {},
    manualTrade: {},
    telegram: {},
    rpc: {},
    drift: {},  // Drift Protocol credentials
    security: {},
    metadata: {
      collectedAt: new Date().toISOString(),
    },
  };

  // Load .env file (force override so changes in this session are visible)
  if (fs.existsSync(ENV_FILE)) {
    dotenv.config({ override: true });
  }

  printSection('Collecting Wallet Information');

  // Check wallet file
  const walletPath = process.env.WALLET_PRIVATE_KEY_PATH || path.join(process.cwd(), 'perps-wallet.json');
  if (fs.existsSync(walletPath)) {
    if (isEncrypted(walletPath)) {
      console.log(colorize('✓', 'green') + ' Wallet file found (encrypted)');
      secrets.wallet.encrypted = true;
      secrets.wallet.path = walletPath;

      const walletPassword = process.env.WALLET_PASSWORD;
      if (walletPassword) {
        try {
          const decrypted = loadEncryptedWallet(walletPath, walletPassword);
          const keypair = Keypair.fromSecretKey(Uint8Array.from(decrypted));
          secrets.wallet.publicKey = keypair.publicKey.toBase58();
          console.log(colorize('✓', 'green') + ' Wallet decrypted successfully');
          console.log(colorize('  Public Key:', 'cyan'), secrets.wallet.publicKey);
        } catch (e) {
          console.log(colorize('✗', 'red') + ' Failed to decrypt wallet: ' + e.message);
        }
      } else {
        console.log(colorize('⚠', 'yellow') + ' WALLET_PASSWORD not set in environment');
      }
    } else {
      console.log(colorize('⚠', 'yellow') + ' Wallet file found but NOT ENCRYPTED');
      console.log(colorize('  Run: node tools/encrypt-wallet.js', 'yellow'));
      secrets.wallet.encrypted = false;
      secrets.wallet.path = walletPath;
    }
  } else {
    console.log(colorize('✗', 'red') + ' Wallet file not found at: ' + walletPath);
  }

  printSection('Collecting API Keys');

  // API Key
  if (process.env.API_KEY) {
    secrets.api.key = process.env.API_KEY;
    console.log(colorize('✓', 'green') + ' API_KEY found');
    console.log(colorize('  Length:', 'cyan'), process.env.API_KEY.length, 'characters');
    console.log(colorize('  Preview:', 'cyan'), process.env.API_KEY.slice(0, 8) + '...' + process.env.API_KEY.slice(-8));

    if (process.env.API_KEY.length < 32) {
      console.log(colorize('  ⚠ WARNING: API key is too short (< 32 chars)', 'yellow'));
    }
  } else {
    console.log(colorize('✗', 'red') + ' API_KEY not set');
    console.log(colorize('  Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"', 'cyan'));
  }

  // Manual Trade Password
  if (process.env.MANUAL_TRADE_PASSWORD) {
    secrets.manualTrade.password = process.env.MANUAL_TRADE_PASSWORD;
    console.log(colorize('✓', 'green') + ' MANUAL_TRADE_PASSWORD found');
    console.log(colorize('  Preview:', 'cyan'), process.env.MANUAL_TRADE_PASSWORD.slice(0, 4) + '...' + process.env.MANUAL_TRADE_PASSWORD.slice(-4));
  } else {
    console.log(colorize('ℹ', 'cyan') + ' MANUAL_TRADE_PASSWORD not set (will use API_KEY as fallback)');
  }

  printSection('Collecting Telegram Configuration');

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    secrets.telegram.token = process.env.TELEGRAM_BOT_TOKEN;
    console.log(colorize('✓', 'green') + ' TELEGRAM_BOT_TOKEN found');
    const parts = process.env.TELEGRAM_BOT_TOKEN.split(':');
    if (parts.length === 2) {
      console.log(colorize('  Bot ID:', 'cyan'), parts[0]);
      console.log(colorize('  Token Preview:', 'cyan'), parts[1].slice(0, 8) + '...');
    }
  } else {
    console.log(colorize('✗', 'red') + ' TELEGRAM_BOT_TOKEN not set');
  }

  if (process.env.TELEGRAM_CHAT_ID) {
    secrets.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
    console.log(colorize('✓', 'green') + ' TELEGRAM_CHAT_ID found:', process.env.TELEGRAM_CHAT_ID);
  } else {
    console.log(colorize('⚠', 'yellow') + ' TELEGRAM_CHAT_ID not set');
  }

  if (process.env.TELEGRAM_ALLOWED_USERS) {
    secrets.telegram.allowedUsers = process.env.TELEGRAM_ALLOWED_USERS.split(',').map(u => u.trim());
    console.log(colorize('✓', 'green') + ' TELEGRAM_ALLOWED_USERS found:', secrets.telegram.allowedUsers.length, 'users');
    console.log(colorize('  Users:', 'cyan'), secrets.telegram.allowedUsers.join(', '));
  } else {
    console.log(colorize('⚠', 'yellow') + ' TELEGRAM_ALLOWED_USERS not set (bot will deny all commands)');
  }

  printSection('Collecting RPC Configuration');

  // RPC
  if (process.env.RPC_URL) {
    secrets.rpc.url = process.env.RPC_URL;
    console.log(colorize('✓', 'green') + ' RPC_URL found');
    console.log(colorize('  URL:', 'cyan'), process.env.RPC_URL);

    // Check if it's a public or private endpoint
    const publicEndpoints = [
      'https://api.mainnet-beta.solana.com',
      'https://api.devnet.solana.com',
      'https://api.testnet.solana.com',
    ];

    if (publicEndpoints.includes(process.env.RPC_URL)) {
      console.log(colorize('  ⚠ WARNING: Using public RPC (rate-limited, unreliable)', 'yellow'));
      console.log(colorize('  Consider using private RPC (QuickNode, Alchemy, Helius)', 'yellow'));
    } else {
      console.log(colorize('  ✓ Using private RPC endpoint', 'green'));
    }
  } else {
    console.log(colorize('⚠', 'yellow') + ' RPC_URL not set (using default public endpoint)');
  }

  printSection('Drift Protocol Configuration');

  // Drift credentials
  if (process.env.DRIFT_PRIVATE_KEY) {
    secrets.drift.privateKey = process.env.DRIFT_PRIVATE_KEY;
    console.log(colorize('✓', 'green') + ' DRIFT_PRIVATE_KEY found');
    console.log(colorize('  Preview:', 'cyan'), process.env.DRIFT_PRIVATE_KEY.slice(0, 8) + '...' + process.env.DRIFT_PRIVATE_KEY.slice(-8));
  } else {
    console.log(colorize('ℹ', 'cyan') + ' DRIFT_PRIVATE_KEY not set (will use main wallet for Drift)');
  }

  if (process.env.DRIFT_SUBACCOUNT) {
    secrets.drift.subaccount = process.env.DRIFT_SUBACCOUNT;
    console.log(colorize('✓', 'green') + ' DRIFT_SUBACCOUNT:', process.env.DRIFT_SUBACCOUNT);
  }

  if (process.env.DRIFT_RPC_URL) {
    secrets.drift.rpcUrl = process.env.DRIFT_RPC_URL;
    console.log(colorize('✓', 'green') + ' DRIFT_RPC_URL found');
    console.log(colorize('  URL:', 'cyan'), process.env.DRIFT_RPC_URL);
  }

  printSection('Security Configuration');

  // Security settings
  secrets.security.nodeEnv = process.env.NODE_ENV || 'development';
  console.log(colorize('  NODE_ENV:', 'cyan'), secrets.security.nodeEnv);

  if (process.env.ENFORCE_WALLET_PERMISSIONS) {
    secrets.security.enforceWalletPermissions = process.env.ENFORCE_WALLET_PERMISSIONS;
    console.log(colorize('  ENFORCE_WALLET_PERMISSIONS:', 'cyan'), secrets.security.enforceWalletPermissions);
  }

  if (process.env.RATE_LIMIT_MAX_REQUESTS) {
    secrets.security.rateLimitMaxRequests = process.env.RATE_LIMIT_MAX_REQUESTS;
    console.log(colorize('  RATE_LIMIT_MAX_REQUESTS:', 'cyan'), secrets.security.rateLimitMaxRequests);
  }
  if (process.env.REQUIRE_API_AUTH) {
    secrets.security.requireApiAuth = process.env.REQUIRE_API_AUTH;
    console.log(colorize('  REQUIRE_API_AUTH:', 'cyan'), secrets.security.requireApiAuth);
  }

  return secrets;
}

// Display all secrets
function displaySecrets(secrets, showSensitive = false) {
  printSection('Wallet Information');
  console.log(colorize('  Encrypted:', 'cyan'), secrets.wallet.encrypted ? colorize('✓ Yes', 'green') : colorize('✗ No', 'red'));
  if (secrets.wallet.path) {
    console.log(colorize('  Path:', 'cyan'), secrets.wallet.path);
  }
  if (secrets.wallet.publicKey) {
    console.log(colorize('  Public Key:', 'cyan'), secrets.wallet.publicKey);
  }
  if (secrets.wallet.password) {
    if (showSensitive) {
      console.log(colorize('  Password:', 'cyan'), secrets.wallet.password);
    } else {
      console.log(colorize('  Password:', 'cyan'), '******* ' + colorize('(stored in encrypted file)', 'green'));
    }
  }

  printSection('API Keys');
  if (secrets.api.key) {
    if (showSensitive) {
      console.log(colorize('  API_KEY:', 'cyan'), secrets.api.key);
    } else {
      console.log(colorize('  API_KEY:', 'cyan'), secrets.api.key.slice(0, 8) + '...' + secrets.api.key.slice(-8), colorize('(masked)', 'yellow'));
    }
  } else {
    console.log(colorize('  API_KEY:', 'red'), 'Not set');
  }

  if (secrets.manualTrade?.password) {
    if (showSensitive) {
      console.log(colorize('  MANUAL_TRADE_PASSWORD:', 'cyan'), secrets.manualTrade.password);
    } else {
      console.log(colorize('  MANUAL_TRADE_PASSWORD:', 'cyan'), secrets.manualTrade.password.slice(0, 4) + '...' + secrets.manualTrade.password.slice(-4), colorize('(masked)', 'yellow'));
    }
  }

  printSection('Telegram Configuration');
  if (secrets.telegram.token) {
    if (showSensitive) {
      console.log(colorize('  Token:', 'cyan'), secrets.telegram.token);
    } else {
      const parts = secrets.telegram.token.split(':');
      console.log(colorize('  Token:', 'cyan'), parts[0] + ':' + parts[1]?.slice(0, 8) + '...', colorize('(masked)', 'yellow'));
    }
  }
  if (secrets.telegram.chatId) {
    console.log(colorize('  Chat ID:', 'cyan'), secrets.telegram.chatId);
  }
  if (secrets.telegram.allowedUsers) {
    console.log(colorize('  Allowed Users:', 'cyan'), secrets.telegram.allowedUsers.join(', '));
  }

  printSection('RPC Configuration');
  if (secrets.rpc.url) {
    console.log(colorize('  RPC URL:', 'cyan'), secrets.rpc.url);
  }

  printSection('Security Settings');
  console.log(colorize('  Environment:', 'cyan'), secrets.security.nodeEnv);
  if (secrets.security.enforceWalletPermissions) {
    console.log(colorize('  Wallet Permissions:', 'cyan'), secrets.security.enforceWalletPermissions);
  }
  if (secrets.security.rateLimitMaxRequests) {
    console.log(colorize('  Rate Limit:', 'cyan'), secrets.security.rateLimitMaxRequests, 'requests');
  }

  if (secrets.metadata?.collectedAt) {
    console.log(colorize('\n  Collected:', 'cyan'), new Date(secrets.metadata.collectedAt).toLocaleString());
  }
}

// Export secrets to .env file
// Build updates map for secret keys only (no non-sensitive config)
function buildSecretEnvUpdates(secrets, extraUpdates = {}) {
  const updates = {};
  // Wallet
  if (secrets.wallet.path) updates.WALLET_PRIVATE_KEY_PATH = secrets.wallet.path;
  // Prefer wallet password from encrypted secrets file if present (avoid env circular dependency)
  if (secrets.wallet && typeof secrets.wallet.password === 'string' && secrets.wallet.password !== '') {
    updates.WALLET_PASSWORD = secrets.wallet.password;
  }
  // API
  if (secrets.api.key) updates.API_KEY = secrets.api.key;
  // Manual Trade
  if (secrets.manualTrade?.password) updates.MANUAL_TRADE_PASSWORD = secrets.manualTrade.password;
  // Telegram
  if (secrets.telegram.token) updates.TELEGRAM_BOT_TOKEN = secrets.telegram.token;
  if (secrets.telegram.chatId) updates.TELEGRAM_CHAT_ID = secrets.telegram.chatId;
  if (secrets.telegram.allowedUsers) updates.TELEGRAM_ALLOWED_USERS = secrets.telegram.allowedUsers.join(',');
  // RPC
  if (secrets.rpc.url) updates.RPC_URL = secrets.rpc.url;
  // Security (optional)
  if (secrets.security?.nodeEnv) updates.NODE_ENV = secrets.security.nodeEnv;
  if (secrets.security?.enforceWalletPermissions) updates.ENFORCE_WALLET_PERMISSIONS = secrets.security.enforceWalletPermissions;
  if (secrets.security?.rateLimitMaxRequests) updates.RATE_LIMIT_MAX_REQUESTS = secrets.security.rateLimitMaxRequests;
  // Optionally include REQUIRE_API_AUTH when present in secrets.security
  if (secrets.security?.requireApiAuth) updates.REQUIRE_API_AUTH = secrets.security.requireApiAuth;
  // Apply any explicit overrides provided by caller
  for (const [k, v] of Object.entries(extraUpdates)) {
    if (v !== undefined && v !== null && v !== '') updates[k] = v;
  }
  return updates;
}

// Merge updates into existing .env content (replace or append keys)
function mergeEnvContent(existingContent, updates) {
  // Serialize and escape env values safely; quote when needed
  function serializeEnvValue(value) {
    const str = String(value);
    // Safe if strictly alphanum, underscore, dot, slash, colon, dash
    if (/^[A-Za-z0-9_./:-]+$/.test(str)) return str;
    // Otherwise quote and escape
    return '"' + str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      + '"';
  }

  let content = existingContent || '';
  const lines = content.split('\n');
  const updatedKeys = new Set();

  // Process each line and update matching keys
  const processedLines = lines.map(line => {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) return line;

    // Check if this line matches any key we want to update
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === null || value === '') continue;

      // Match: key=value or key = value (with optional spaces)
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=\\s*.*$`);

      if (pattern.test(line)) {
        updatedKeys.add(key);
        // Preserve leading whitespace and comment if present
        const indent = line.match(/^\s*/)?.[0] || '';
        const hasExport = /^\s*export\s+/.test(line);
        const commentMatch = line.match(/#.*$/);
        const comment = commentMatch ? ' ' + commentMatch[0] : '';
        const rendered = `${key}=${serializeEnvValue(value)}`;
        return `${indent}${hasExport ? 'export ' : ''}${rendered}${comment}`;
      }
    }
    return line;
  });

  // Add any keys that weren't found (append at end)
  let result = processedLines.join('\n');
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') continue;
    if (!updatedKeys.has(key)) {
      if (result.length > 0 && !result.endsWith('\n')) result += '\n';
      const rendered = `${key}=${serializeEnvValue(value)}`;
      result += `${rendered}\n`;
    }
  }

  return result;
}

// Main menu
async function mainMenu() {
  printHeader();

  console.log('This tool helps you manage all sensitive credentials in one secure place.\n');
  console.log('Options:');
  console.log('  1. View all secrets (current environment)');
  console.log('  2. Save secrets to encrypted file');
  console.log('  3. Load secrets from encrypted file');
  console.log('  4. Export secrets to .env file');
  console.log('  5. Generate new API key');
  console.log('  6. Generate new wallet');
  console.log('  7. Security health check');
  console.log('  8. Remove passwords from .env (move to encrypted storage)');
  console.log('  9. Exit\n');

  const choice = await ask('Select option (1-9): ');

  switch (choice.trim()) {
    case '1':
      await viewSecrets();
      break;
    case '2':
      await saveSecrets();
      break;
    case '3':
      await loadSecrets();
      break;
    case '4':
      await exportSecrets();
      break;
    case '5':
      await generateApiKey();
      break;
    case '6':
      await generateWallet();
      break;
    case '7':
      await healthCheck();
      break;
    case '8':
      await removePasswordsFromEnv();
      break;
    case '9':
      console.log(colorize('\n👋 Goodbye!\n', 'cyan'));
      rl.close();
      process.exit(0);
      break;
    default:
      console.log(colorize('\n✗ Invalid option\n', 'red'));
      await mainMenu();
  }
}

async function viewSecrets() {
  printHeader();
  console.log('Loading secrets from current environment...\n');

  const secrets = await collectSecrets();

  const showSensitive = await ask('\nShow full credentials? (yes/no): ');
  displaySecrets(secrets, showSensitive.toLowerCase() === 'yes');

  console.log('\n');
  await ask('Press Enter to continue...');
  await mainMenu();
}

async function saveSecrets() {
  printHeader();
  console.log('Save current secrets to encrypted file.\n');

  const secrets = await collectSecrets();

  console.log(colorize('\n✓ Secrets collected', 'green'));

  const password = await askPassword('\nEnter master password (min 12 characters): ');

  if (password.length < 12) {
    console.log(colorize('\n✗ Password too short (minimum 12 characters)\n', 'red'));
    await ask('Press Enter to continue...');
    await mainMenu();
    return;
  }

  const confirmPassword = await askPassword('Confirm password: ');

  if (password !== confirmPassword) {
    console.log(colorize('\n✗ Passwords do not match\n', 'red'));
    await ask('Press Enter to continue...');
    await mainMenu();
    return;
  }

  try {
    // Offer to include WALLET_PASSWORD in encrypted secrets to avoid env dependency later
    if (!secrets.wallet.password && process.env.WALLET_PASSWORD) {
      secrets.wallet.password = process.env.WALLET_PASSWORD;
      console.log(colorize('✓', 'green') + ' Including WALLET_PASSWORD from environment');
    } else if (!secrets.wallet.password) {
      const includePw = await askLine('Include WALLET_PASSWORD in encrypted secrets? (yes/no): ');
      if (includePw.toLowerCase() === 'yes') {
        const pw = await askPassword('Enter WALLET_PASSWORD to store (input hidden): ');
        if (pw && pw.length > 0) {
          secrets.wallet.password = pw;
        }
      }
    }

    // Offer to include MANUAL_TRADE_PASSWORD
    if (!secrets.manualTrade.password && process.env.MANUAL_TRADE_PASSWORD) {
      secrets.manualTrade.password = process.env.MANUAL_TRADE_PASSWORD;
      console.log(colorize('✓', 'green') + ' Including MANUAL_TRADE_PASSWORD from environment');
    } else if (!secrets.manualTrade.password) {
      const includeManual = await askLine('Include MANUAL_TRADE_PASSWORD in encrypted secrets? (yes/no): ');
      if (includeManual.toLowerCase() === 'yes') {
        const pw = await askPassword('Enter MANUAL_TRADE_PASSWORD to store (input hidden): ');
        if (pw && pw.length > 0) {
          secrets.manualTrade.password = pw;
        }
      }
    }

    saveSecretsFile(secrets, password);
    console.log(colorize('\n✓ Secrets saved to: ' + SECRETS_FILE, 'green'));
    console.log(colorize('  Keep your master password secure!\n', 'yellow'));
  } catch (e) {
    console.log(colorize('\n✗ Failed to save: ' + e.message + '\n', 'red'));
  }

  await ask('Press Enter to continue...');
  await mainMenu();
}

async function loadSecrets() {
  printHeader();
  console.log('Load secrets from encrypted file.\n');

  if (!fs.existsSync(SECRETS_FILE)) {
    console.log(colorize('✗ Encrypted secrets file not found: ' + SECRETS_FILE, 'red'));
    console.log(colorize('  Use option 2 to save secrets first.\n', 'yellow'));
    await ask('Press Enter to continue...');
    await mainMenu();
    return;
  }

  const password = await askPassword('Enter master password: ');

  try {
    const secrets = loadSecretsFile(password);
    console.log(colorize('\n✓ Secrets loaded successfully\n', 'green'));

    displaySecrets(secrets, true);

    const writeEnv = await askLine('\n\nMerge secrets into .env (only relevant keys)? (yes/no): ');
    if (writeEnv.toLowerCase() === 'yes') {
      // If WALLET_PASSWORD is not present in encrypted secrets, offer to capture it now for .env
      let extra = {};
      if (!secrets.wallet || !secrets.wallet.password) {
        const addNow = await askLine('WALLET_PASSWORD not found in encrypted secrets. Add to .env now? (yes/no): ');
        if (addNow.toLowerCase() === 'yes') {
          const pw = await askPassword('Enter WALLET_PASSWORD (input hidden): ');
          if (pw && pw.length > 0) extra.WALLET_PASSWORD = pw;
        }
      }
      const updates = buildSecretEnvUpdates(secrets, extra);
      let existing = '';
      if (fs.existsSync(ENV_FILE)) existing = fs.readFileSync(ENV_FILE, 'utf8');
      const merged = mergeEnvContent(existing, updates);
      fs.writeFileSync(ENV_FILE, merged, { mode: 0o600 });
      console.log(colorize('\n✓ Secrets merged into: ' + ENV_FILE, 'green'));
      console.log(colorize('  Only relevant keys were updated; other fields preserved.\n', 'green'));
      // Reload env for current session so subsequent operations see updated values
      dotenv.config({ override: true });
    }
  } catch (e) {
    console.log(colorize('\n✗ ' + e.message + '\n', 'red'));
  }

  await ask('\nPress Enter to continue...');
  await mainMenu();
}

async function exportSecrets() {
  printHeader();
  console.log('Export secrets to .env file.\n');

  const secrets = await collectSecrets();
  let extra = {};
  if (!process.env.WALLET_PASSWORD) {
    const addPw = await askLine('WALLET_PASSWORD not set. Add it to .env now? (yes/no): ');
    if (addPw.toLowerCase() === 'yes') {
      const pw = await askPassword('Enter WALLET_PASSWORD (input hidden): ');
      if (pw && pw.length > 0) extra.WALLET_PASSWORD = pw;
    }
  }
  const updates = buildSecretEnvUpdates(secrets, extra);
  let existing = '';
  if (fs.existsSync(ENV_FILE)) existing = fs.readFileSync(ENV_FILE, 'utf8');
  const merged = mergeEnvContent(existing, updates);
  fs.writeFileSync(ENV_FILE, merged, { mode: 0o600 });
  console.log(colorize('\n✓ Secrets merged into: ' + ENV_FILE, 'green'));
  console.log(colorize('  Only relevant keys were updated; other fields preserved.\n', 'green'));
  // Reload env for current session so subsequent operations see updated values
  dotenv.config({ override: true });

  await ask('Press Enter to continue...');
  await mainMenu();
}

async function generateApiKey() {
  printHeader();
  console.log('Generate new API key.\n');

  const newKey = crypto.randomBytes(32).toString('hex');

  console.log(colorize('New API Key:', 'green'));
  console.log(colorize(newKey, 'bright'));
  console.log();
  console.log(colorize('Length:', 'cyan'), newKey.length, 'characters');
  console.log(colorize('Strength:', 'cyan'), '256 bits (cryptographically secure)');
  console.log();
  console.log(colorize('Add to .env file:', 'yellow'));
  console.log(colorize(`API_KEY=${newKey}`, 'bright'));
  console.log();

  const save = await ask('Save to .env file? (yes/no): ');
  if (save.toLowerCase() === 'yes') {
    const updates = { API_KEY: newKey };
    let existing = '';
    if (fs.existsSync(ENV_FILE)) existing = fs.readFileSync(ENV_FILE, 'utf8');
    const merged = mergeEnvContent(existing, updates);
    fs.writeFileSync(ENV_FILE, merged, { mode: 0o600 });
    console.log(colorize('\n✓ API key saved to .env file\n', 'green'));
  }

  await ask('Press Enter to continue...');
  await mainMenu();
}

async function generateWallet() {
  printHeader();
  console.log('Generate new Solana wallet.\n');

  console.log(colorize('⚠️  WARNING: This will create a NEW wallet', 'yellow'));
  console.log(colorize('   If you have an existing wallet, back it up first!\n', 'yellow'));

  const walletPath = process.env.WALLET_PRIVATE_KEY_PATH || path.join(process.cwd(), 'perps-wallet.json');

  // Check if wallet already exists
  if (fs.existsSync(walletPath)) {
    console.log(colorize(`✗ Wallet already exists at: ${walletPath}`, 'red'));
    console.log(colorize('  Options:', 'yellow'));
    console.log(colorize('  1. Back it up first, then delete it', 'yellow'));
    console.log(colorize('  2. Specify a different path in WALLET_PRIVATE_KEY_PATH', 'yellow'));
    console.log();

    const overwrite = await ask('Overwrite existing wallet? Type "YES I AM SURE" to confirm: ');
    if (overwrite !== 'YES I AM SURE') {
      console.log(colorize('\n✗ Cancelled. Existing wallet preserved.\n', 'green'));
      await ask('Press Enter to continue...');
      await mainMenu();
      return;
    }

    // Create backup before overwriting
    const backupPath = walletPath + '.backup.' + Date.now();
    fs.copyFileSync(walletPath, backupPath);
    console.log(colorize(`\n✓ Backup created: ${backupPath}`, 'green'));
  }

  // Generate new keypair
  console.log(colorize('\n🎲 Generating new keypair...', 'cyan'));
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const secretArray = Array.from(keypair.secretKey);

  console.log(colorize('\n✓ New wallet generated!', 'green'));
  console.log(colorize('  Public Address:', 'cyan'), publicKey);
  console.log();

  // Show different formats
  const showFormats = await ask('Show private key formats? (yes/no): ');
  if (showFormats.toLowerCase() === 'yes') {
    console.log(colorize('\n📋 Private Key Formats (⚠️  Keep these secure!):', 'yellow'));
    console.log(colorize('\n  JSON Array (for perps-wallet.json):', 'cyan'));
    console.log('  ' + JSON.stringify(secretArray));

    console.log(colorize('\n  Base58:', 'cyan'));
    const base58Key = bs58.encode(Buffer.from(secretArray));
    console.log('  ' + base58Key);

    console.log(colorize('\n  ⚠️  Never share these with anyone!', 'red'));
    console.log();
  }

  // Ask how to save
  console.log(colorize('💾 Save Options:', 'blue'));
  console.log('  1. Encrypted (RECOMMENDED) - Password-protected AES-256-GCM');
  console.log('  2. Plain JSON (Development only) - Unencrypted');
  console.log('  3. Cancel (don\'t save)\n');

  const saveChoice = await ask('Select option (1-3): ');

  if (saveChoice === '1') {
    // Save encrypted
    console.log(colorize('\n🔐 Encrypting wallet...', 'cyan'));
    console.log(colorize('  Create a strong password (16+ characters recommended)\n', 'yellow'));

    const password = await askPassword('Enter password (min 8 characters): ');

    if (password.length < 8) {
      console.log(colorize('\n✗ Password too short (minimum 8 characters)', 'red'));
      console.log(colorize('  Wallet NOT saved. Run this option again.\n', 'red'));
      await ask('Press Enter to continue...');
      await mainMenu();
      return;
    }

    if (password.length < 16) {
      console.log(colorize('  ⚠️  Short password detected. Consider using 16+ characters.', 'yellow'));
    }

    const confirmPassword = await askPassword('Confirm password: ');

    if (password !== confirmPassword) {
      console.log(colorize('\n✗ Passwords do not match', 'red'));
      console.log(colorize('  Wallet NOT saved. Run this option again.\n', 'red'));
      await ask('Press Enter to continue...');
      await mainMenu();
      return;
    }

    try {
      saveEncryptedWallet(walletPath, secretArray, password);
      console.log(colorize('\n✅ Wallet encrypted and saved successfully!', 'green'));
      console.log(colorize(`   File: ${walletPath}`, 'cyan'));
      console.log(colorize(`   Public Key: ${publicKey}`, 'cyan'));

      // Offer to save password to .env
      const saveToEnv = await askLine('\nSave WALLET_PASSWORD to .env file? (yes/no): ');
      if (saveToEnv.toLowerCase() === 'yes') {
        const updates = {
          WALLET_PASSWORD: password,
          WALLET_PRIVATE_KEY_PATH: walletPath
        };
        let existing = '';
        if (fs.existsSync(ENV_FILE)) existing = fs.readFileSync(ENV_FILE, 'utf8');
        const merged = mergeEnvContent(existing, updates);
        fs.writeFileSync(ENV_FILE, merged, { mode: 0o600 });
        console.log(colorize('\n✓ Credentials saved to .env file', 'green'));
      } else {
        console.log(colorize('\n📝 Add to .env manually:', 'yellow'));
        console.log(colorize(`   WALLET_PASSWORD="${password}"`, 'bright'));
        console.log(colorize(`   WALLET_PRIVATE_KEY_PATH="${walletPath}"`, 'bright'));
      }

      console.log(colorize('\n🎯 Next Steps:', 'blue'));
      console.log(colorize('  1. Fund your wallet with SOL:', 'cyan'));
      console.log(colorize(`     ${publicKey}`, 'bright'));
      console.log(colorize('  2. Start the bot with npm start', 'cyan'));
      console.log(colorize('  3. Keep your password secure (use a password manager)', 'cyan'));

    } catch (e) {
      console.log(colorize(`\n✗ Failed to save encrypted wallet: ${e.message}`, 'red'));
    }

  } else if (saveChoice === '2') {
    // Save plain
    console.log(colorize('\n⚠️  WARNING: Plain JSON wallets are UNENCRYPTED!', 'red'));
    console.log(colorize('   Only use for development/testing.', 'yellow'));
    console.log(colorize('   NEVER commit to git or share publicly.\n', 'yellow'));

    const proceed = await ask('Type "I understand the risks" to continue: ');
    if (proceed !== 'I understand the risks') {
      console.log(colorize('\n✗ Cancelled.\n', 'yellow'));
      await ask('Press Enter to continue...');
      await mainMenu();
      return;
    }

    try {
      fs.writeFileSync(walletPath, JSON.stringify(secretArray, null, 2), { mode: 0o600 });
      console.log(colorize('\n✅ Wallet saved as plain JSON!', 'green'));
      console.log(colorize(`   File: ${walletPath}`, 'cyan'));
      console.log(colorize(`   Public Key: ${publicKey}`, 'cyan'));

      console.log(colorize('\n🎯 Next Steps:', 'blue'));
      console.log(colorize('  1. Verify .gitignore includes:', 'cyan'));
      console.log(colorize('     perps-wallet.json', 'bright'));
      console.log(colorize('     **/wallet*.json', 'bright'));
      console.log(colorize('  2. Fund your wallet with SOL:', 'cyan'));
      console.log(colorize(`     ${publicKey}`, 'bright'));
      console.log(colorize('  3. RECOMMENDED: Encrypt it:', 'cyan'));
      console.log(colorize('     npm run encrypt-wallet', 'bright'));

    } catch (e) {
      console.log(colorize(`\n✗ Failed to save wallet: ${e.message}`, 'red'));
    }

  } else {
    console.log(colorize('\n✗ Wallet not saved.', 'yellow'));
    console.log(colorize('  The keypair was generated but not written to disk.', 'yellow'));
    console.log(colorize('  Run this option again to create and save a new wallet.\n', 'yellow'));
  }

  console.log();
  await ask('Press Enter to continue...');
  await mainMenu();
}

async function healthCheck() {
  printHeader();
  console.log('Running security health check...\n');

  const secrets = await collectSecrets();

  let score = 0;
  let maxScore = 0;
  const issues = [];
  const warnings = [];

  // Check wallet encryption
  maxScore += 20;
  if (secrets.wallet.encrypted) {
    score += 20;
    console.log(colorize('✓', 'green') + ' Wallet is encrypted (+20 points)');
  } else {
    console.log(colorize('✗', 'red') + ' Wallet is NOT encrypted (0 points)');
    issues.push('Encrypt wallet file: node tools/encrypt-wallet.js');
  }

  // Check API key
  maxScore += 20;
  if (secrets.api.key) {
    if (secrets.api.key.length >= 32) {
      score += 20;
      console.log(colorize('✓', 'green') + ' API key is strong (+20 points)');
    } else {
      score += 10;
      console.log(colorize('⚠', 'yellow') + ' API key is weak (+10 points)');
      warnings.push('API key should be at least 32 characters');
    }
  } else {
    console.log(colorize('✗', 'red') + ' API key not set (0 points)');
    issues.push('Generate API key: node tools/secrets-manager.js (option 5)');
  }

  // Check Telegram whitelist
  maxScore += 15;
  if (secrets.telegram.token) {
    if (secrets.telegram.allowedUsers && secrets.telegram.allowedUsers.length > 0) {
      score += 15;
      console.log(colorize('✓', 'green') + ' Telegram whitelist configured (+15 points)');
    } else {
      console.log(colorize('✗', 'red') + ' Telegram whitelist NOT set (0 points)');
      issues.push('Set TELEGRAM_ALLOWED_USERS in .env');
    }
  } else {
    score += 15;
    console.log(colorize('○', 'cyan') + ' Telegram not configured (+15 points, N/A)');
  }

  // Check RPC endpoint
  maxScore += 15;
  if (secrets.rpc.url) {
    const publicEndpoints = [
      'https://api.mainnet-beta.solana.com',
      'https://api.devnet.solana.com',
      'https://api.testnet.solana.com',
    ];

    if (!publicEndpoints.includes(secrets.rpc.url)) {
      score += 15;
      console.log(colorize('✓', 'green') + ' Private RPC endpoint configured (+15 points)');
    } else {
      score += 7;
      console.log(colorize('⚠', 'yellow') + ' Using public RPC (+7 points)');
      warnings.push('Consider using private RPC (QuickNode, Alchemy, Helius)');
    }
  } else {
    console.log(colorize('⚠', 'yellow') + ' RPC not configured (+7 points, using default)');
    score += 7;
    warnings.push('Set RPC_URL in .env for better reliability');
  }

  // Check NODE_ENV
  maxScore += 10;
  if (secrets.security.nodeEnv === 'production') {
    score += 10;
    console.log(colorize('✓', 'green') + ' NODE_ENV=production (+10 points)');
  } else {
    score += 5;
    console.log(colorize('⚠', 'yellow') + ' NODE_ENV not set to production (+5 points)');
    warnings.push('Set NODE_ENV=production for enhanced security');
  }

  // Check file permissions
  maxScore += 10;
  const walletPath = secrets.wallet.path;
  if (walletPath && fs.existsSync(walletPath) && process.platform !== 'win32') {
    const stats = fs.statSync(walletPath);
    const mode = stats.mode & parseInt('777', 8);
    if (mode === parseInt('600', 8)) {
      score += 10;
      console.log(colorize('✓', 'green') + ' Wallet file permissions correct (600) (+10 points)');
    } else {
      score += 5;
      console.log(colorize('⚠', 'yellow') + ` Wallet file permissions are ${mode.toString(8)} (+5 points)`);
      warnings.push(`Fix wallet permissions: chmod 600 ${walletPath}`);
    }
  } else {
    score += 10;
    console.log(colorize('○', 'cyan') + ' File permissions check skipped (+10 points, Windows or N/A)');
  }

  // Check .gitignore
  maxScore += 10;
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    if (gitignore.includes('.env') && gitignore.includes('perps-wallet.json')) {
      score += 10;
      console.log(colorize('✓', 'green') + ' .gitignore properly configured (+10 points)');
    } else {
      score += 5;
      console.log(colorize('⚠', 'yellow') + ' .gitignore incomplete (+5 points)');
      warnings.push('Ensure .env and perps-wallet.json are in .gitignore');
    }
  } else {
    console.log(colorize('✗', 'red') + ' .gitignore not found (0 points)');
    issues.push('Create .gitignore to prevent committing secrets');
  }

  // Calculate percentage
  const percentage = Math.round((score / maxScore) * 100);

  console.log('\n' + '='.repeat(50));
  console.log(colorize(`\nSecurity Score: ${score}/${maxScore} (${percentage}%)`, 'bright'));

  let rating, ratingColor;
  if (percentage >= 90) {
    rating = 'EXCELLENT 🟢';
    ratingColor = 'green';
  } else if (percentage >= 70) {
    rating = 'GOOD 🟡';
    ratingColor = 'yellow';
  } else if (percentage >= 50) {
    rating = 'FAIR 🟠';
    ratingColor = 'yellow';
  } else {
    rating = 'POOR 🔴';
    ratingColor = 'red';
  }

  console.log(colorize(`Rating: ${rating}\n`, ratingColor));

  if (issues.length > 0) {
    console.log(colorize('Critical Issues:', 'red'));
    issues.forEach((issue, i) => {
      console.log(colorize(`  ${i + 1}. ${issue}`, 'red'));
    });
    console.log();
  }

  if (warnings.length > 0) {
    console.log(colorize('Warnings:', 'yellow'));
    warnings.forEach((warning, i) => {
      console.log(colorize(`  ${i + 1}. ${warning}`, 'yellow'));
    });
    console.log();
  }

  if (percentage === 100) {
    console.log(colorize('🎉 Perfect security score! All checks passed.', 'green'));
  } else if (percentage >= 90) {
    console.log(colorize('Great job! Just a few minor improvements suggested.', 'green'));
  } else if (percentage >= 70) {
    console.log(colorize('Good security posture. Address warnings for better protection.', 'yellow'));
  } else {
    console.log(colorize('⚠️  Security needs improvement. Address critical issues immediately.', 'red'));
  }

  console.log('\n');
  await ask('Press Enter to continue...');
  await mainMenu();
}

async function removePasswordsFromEnv() {
  printHeader();
  console.log('Remove passwords from .env and store in encrypted file.\n');
  console.log(colorize('This will:', 'cyan'));
  console.log('  1. Save passwords to encrypted .secrets.enc.json');
  console.log('  2. Comment out passwords in .env file');
  console.log('  3. Add instructions for using secure password loader\n');

  // Force reload .env file to get latest changes
  if (fs.existsSync(ENV_FILE)) {
    const envConfig = dotenv.parse(fs.readFileSync(ENV_FILE, 'utf8'));
    // Manually merge into process.env
    Object.assign(process.env, envConfig);
    console.log(colorize('✓', 'cyan') + ' Reloaded .env file\n');
  }

  // Check if we have passwords in .env
  const hasWalletPassword = !!process.env.WALLET_PASSWORD && process.env.WALLET_PASSWORD.trim() !== '';
  const hasManualPassword = !!process.env.MANUAL_TRADE_PASSWORD && process.env.MANUAL_TRADE_PASSWORD.trim() !== '';

  if (!hasWalletPassword && !hasManualPassword) {
    console.log(colorize('✗ No passwords found in .env file', 'yellow'));
    console.log(colorize('  WALLET_PASSWORD and MANUAL_TRADE_PASSWORD are already removed or empty.\n', 'yellow'));
    console.log(colorize('  Debug Info:', 'cyan'));
    console.log(colorize('    WALLET_PASSWORD value: "' + (process.env.WALLET_PASSWORD || '(not set)') + '"', 'cyan'));
    console.log(colorize('    MANUAL_TRADE_PASSWORD value: "' + (process.env.MANUAL_TRADE_PASSWORD || '(not set)') + '"', 'cyan'));
    console.log();
    await ask('Press Enter to continue...');
    await mainMenu();
    return;
  }

  console.log(colorize('Passwords found in .env:', 'yellow'));
  if (hasWalletPassword) {
    console.log(colorize('  ✓ WALLET_PASSWORD', 'yellow'));
    console.log(colorize('    Preview: ' + process.env.WALLET_PASSWORD.slice(0, 4) + '***', 'cyan'));
  }
  if (hasManualPassword) {
    console.log(colorize('  ✓ MANUAL_TRADE_PASSWORD', 'yellow'));
    console.log(colorize('    Preview: ' + process.env.MANUAL_TRADE_PASSWORD.slice(0, 4) + '***', 'cyan'));
  }
  console.log();

  const proceed = await ask('Continue? (yes/no): ');
  if (proceed.toLowerCase() !== 'yes') {
    console.log(colorize('\n✗ Cancelled\n', 'yellow'));
    await ask('Press Enter to continue...');
    await mainMenu();
    return;
  }

  // Check if encrypted file already exists
  if (fs.existsSync(SECRETS_FILE)) {
    console.log(colorize('\n✓ Encrypted secrets file already exists', 'green'));
    const update = await ask('Update existing file? (yes/no): ');

    if (update.toLowerCase() === 'yes') {
      const masterPassword = await askPassword('Enter master password: ');
      try {
        const secrets = loadSecretsFile(masterPassword);

        // Add passwords from .env
        if (hasWalletPassword) {
          secrets.wallet.password = process.env.WALLET_PASSWORD;
          console.log(colorize('✓', 'green') + ' Added WALLET_PASSWORD to encrypted file');
        }
        if (hasManualPassword) {
          if (!secrets.manualTrade) secrets.manualTrade = {};
          secrets.manualTrade.password = process.env.MANUAL_TRADE_PASSWORD;
          console.log(colorize('✓', 'green') + ' Added MANUAL_TRADE_PASSWORD to encrypted file');
        }

        // Update metadata
        secrets.metadata = secrets.metadata || {};
        secrets.metadata.updatedAt = new Date().toISOString();

        // Save updated secrets
        saveSecretsFile(secrets, masterPassword);
        console.log(colorize('✓', 'green') + ' Encrypted file updated');
      } catch (e) {
        console.log(colorize('\n✗ ' + e.message, 'red'));
        console.log(colorize('  Unable to update encrypted file.\n', 'red'));
        await ask('Press Enter to continue...');
        await mainMenu();
        return;
      }
    }
  } else {
    // Create new encrypted file
    console.log(colorize('\nCreating new encrypted secrets file...', 'cyan'));
    const masterPassword = await askPassword('Enter master password (min 12 characters): ');

    if (masterPassword.length < 12) {
      console.log(colorize('\n✗ Password too short (minimum 12 characters)\n', 'red'));
      await ask('Press Enter to continue...');
      await mainMenu();
      return;
    }

    const confirmPassword = await askPassword('Confirm password: ');

    if (masterPassword !== confirmPassword) {
      console.log(colorize('\n✗ Passwords do not match\n', 'red'));
      await ask('Press Enter to continue...');
      await mainMenu();
      return;
    }

    // Collect all secrets including passwords
    const secrets = await collectSecrets();

    // Ensure passwords are captured
    if (hasWalletPassword) {
      secrets.wallet.password = process.env.WALLET_PASSWORD;
    }
    if (hasManualPassword) {
      secrets.manualTrade.password = process.env.MANUAL_TRADE_PASSWORD;
    }

    try {
      saveSecretsFile(secrets, masterPassword);
      console.log(colorize('✓', 'green') + ' Encrypted secrets file created');
    } catch (e) {
      console.log(colorize('\n✗ Failed to create encrypted file: ' + e.message, 'red'));
      await ask('Press Enter to continue...');
      await mainMenu();
      return;
    }
  }

  // Now update .env file to comment out passwords
  if (fs.existsSync(ENV_FILE)) {
    let envContent = fs.readFileSync(ENV_FILE, 'utf8');
    const lines = envContent.split('\n');
    const updatedLines = lines.map(line => {
      const trimmed = line.trim();

      // Comment out WALLET_PASSWORD
      if (/^WALLET_PASSWORD\s*=/.test(trimmed)) {
        return `# ${line} # REMOVED: Now stored in encrypted .secrets.enc.json`;
      }

      // Comment out MANUAL_TRADE_PASSWORD
      if (/^MANUAL_TRADE_PASSWORD\s*=/.test(trimmed)) {
        return `# ${line} # REMOVED: Now stored in encrypted .secrets.enc.json`;
      }

      return line;
    });

    // Add security note at the top if not present
    const securityNote = `# ========================================
# SECURITY: Passwords are stored in encrypted .secrets.enc.json
# ========================================
# WALLET_PASSWORD and MANUAL_TRADE_PASSWORD have been moved to encrypted storage.
# The bot will automatically load them from .secrets.enc.json at runtime.
#
# To manage secrets: npm run secrets
# To view secrets: node tools/secrets-manager.js (option 1)
#
# For runtime password loading, the bot uses utils/secure-password-loader.js
# which will prompt for the master password if needed.
# ========================================

`;

    if (!envContent.includes('stored in encrypted .secrets.enc.json')) {
      updatedLines.unshift(securityNote);
    }

    fs.writeFileSync(ENV_FILE, updatedLines.join('\n'), { mode: 0o600 });
    console.log(colorize('✓', 'green') + ' Passwords removed from .env file');
    console.log(colorize('✓', 'green') + ' Security instructions added to .env');
  }

  console.log(colorize('\n✅ Success! Passwords are now secured.\n', 'green'));
  console.log(colorize('📝 Next Steps:', 'blue'));
  console.log(colorize('  1. Keep your master password secure (use a password manager)', 'cyan'));
  console.log(colorize('  2. The bot will prompt for master password on startup', 'cyan'));
  console.log(colorize('  3. Or set SECRETS_MASTER_PASSWORD environment variable', 'cyan'));
  console.log(colorize('\n  Example: SECRETS_MASTER_PASSWORD=your_master_password node bot.js\n', 'bright'));

  await ask('Press Enter to continue...');
  await mainMenu();
}

// Export functions for use as module
module.exports = {
  encryptSecrets,
  decryptSecrets,
  loadSecretsFile,
  saveSecretsFile,
  collectSecrets,
  SECRETS_FILE,
};

// Start if run directly
if (require.main === module) {
(async function main() {
  try {
    await mainMenu();
  } catch (e) {
    console.error(colorize('\nError: ' + e.message, 'red'));
    rl.close();
    process.exit(1);
  }
})();
}
