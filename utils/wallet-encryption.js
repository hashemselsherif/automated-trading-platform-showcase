// Wallet encryption utilities using Node.js crypto
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const ITERATIONS = 100000; // PBKDF2 iterations

/**
 * Derive encryption key from password using PBKDF2
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt wallet data
 */
function encryptWallet(walletData, password) {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  const dataString = JSON.stringify(walletData);
  let encrypted = cipher.update(dataString, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();

  // Combine salt, iv, tag, and encrypted data
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
  };
}

/**
 * Decrypt wallet data
 */
function decryptWallet(encryptedData, password) {
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
    throw new Error(`Decryption failed: ${e.message}. Invalid password or corrupted file.`);
  }
}

/**
 * Load encrypted wallet file
 */
function loadEncryptedWallet(walletPath, password) {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }

  const encryptedData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  
  if (!encryptedData.encrypted || !encryptedData.algorithm) {
    throw new Error('Wallet file does not appear to be encrypted. Use encryption utility first.');
  }

  return decryptWallet(encryptedData, password);
}

/**
 * Save encrypted wallet file
 */
function saveEncryptedWallet(walletPath, walletData, password) {
  const encrypted = encryptWallet(walletData, password);
  
  // Ensure directory exists
  const dir = path.dirname(walletPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write encrypted data
  fs.writeFileSync(walletPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  
  console.log(`✅ Encrypted wallet saved to ${walletPath}`);
}

/**
 * Check if wallet file is encrypted
 */
function isEncrypted(walletPath) {
  if (!fs.existsSync(walletPath)) {
    return false;
  }

  try {
    const data = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    return !!(data.encrypted && data.algorithm);
  } catch {
    return false;
  }
}

module.exports = {
  encryptWallet,
  decryptWallet,
  loadEncryptedWallet,
  saveEncryptedWallet,
  isEncrypted,
};

