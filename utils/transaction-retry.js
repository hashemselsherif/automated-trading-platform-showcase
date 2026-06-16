// Transaction retry utility with exponential backoff
const { Connection } = require('@solana/web3.js');

/**
 * Retry a transaction with exponential backoff
 * @param {Function} fn - Function that returns a transaction
 * @param {Object} options - Retry options
 * @returns {Promise} Transaction result
 */
async function retryTransaction(fn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    onRetry = null,
  } = options;

  let lastError;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0 && onRetry) {
        onRetry({ attempt, success: true });
      }
      return result;
    } catch (error) {
      lastError = error;
      
      // Don't retry on certain errors
      if (error.message?.includes('insufficient funds') ||
          error.message?.includes('user rejected') ||
          error.message?.includes('User rejected')) {
        throw error;
      }

      if (attempt < maxRetries) {
        if (onRetry) {
          onRetry({ attempt: attempt + 1, error: error.message, delay });
        }
        
        await sleep(delay);
        delay = Math.min(delay * backoffMultiplier, maxDelay);
      }
    }
  }

  throw lastError;
}

/**
 * Send transaction with retry and confirmation monitoring
 * @param {Connection} connection - Solana connection
 * @param {Buffer|Uint8Array} rawTx - Serialized transaction
 * @param {Object} options - Send options
 * @returns {Promise<string>} Transaction signature
 */
async function sendTransactionWithRetry(connection, rawTx, options = {}) {
  const {
    skipPreflight = false,
    preflightCommitment = 'confirmed',
    maxRetries = 3,
    confirmTimeout = 30000,
    onStatus = null,
  } = options;

  let sig;

  // Retry sending the transaction
  const sendTx = async () => {
    sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight,
      preflightCommitment,
      maxRetries: 0, // We handle retries ourselves
    });
    
    if (onStatus) onStatus({ status: 'sent', sig });
    
    // Monitor confirmation
    const confirmation = await Promise.race([
      connection.confirmTransaction(sig, 'confirmed'),
      sleep(confirmTimeout).then(() => {
        throw new Error(`Transaction confirmation timeout: ${sig}`);
      }),
    ]);

    if (onStatus) {
      onStatus({ 
        status: 'confirmed', 
        sig, 
        slot: confirmation?.slot,
        err: confirmation?.value?.err,
      });
    }

    if (confirmation?.value?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    return sig;
  };

  return retryTransaction(sendTx, {
    maxRetries,
    onRetry: (info) => {
      if (onStatus) {
        onStatus({ status: 'retry', attempt: info.attempt, delay: info.delay });
      }
    },
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  retryTransaction,
  sendTransactionWithRetry,
  sleep,
};

