// Audit logging for security-sensitive operations
const fs = require('fs');
const path = require('path');

const AUDIT_LOG_PATH = path.join(__dirname, '../logs', 'audit.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

// Ensure log directory exists
const logDir = path.dirname(AUDIT_LOG_PATH);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

/**
 * Audit log entry structure
 */
function createAuditEntry(action, details = {}) {
  return {
    timestamp: new Date().toISOString(),
    action,
    ...details,
  };
}

/**
 * Write audit log entry
 */
function log(action, details = {}) {
  try {
    const entry = createAuditEntry(action, details);
    const logLine = JSON.stringify(entry) + '\n';

    // Rotate log if too large
    if (fs.existsSync(AUDIT_LOG_PATH)) {
      const stats = fs.statSync(AUDIT_LOG_PATH);
      if (stats.size > MAX_LOG_SIZE) {
        const backupPath = AUDIT_LOG_PATH + '.' + Date.now();
        fs.renameSync(AUDIT_LOG_PATH, backupPath);
      }
    }

    fs.appendFileSync(AUDIT_LOG_PATH, logLine, { flag: 'a' });
  } catch (e) {
    console.error('Failed to write audit log:', e.message);
  }
}

/**
 * Log authentication attempts
 */
function logAuth(attempt, success, details = {}) {
  log('auth_attempt', {
    success,
    ...details,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log security events
 */
function logSecurityEvent(event, details = {}) {
  log('security_event', {
    event,
    ...details,
    severity: details.severity || 'medium',
  });
}

/**
 * Log transaction operations
 */
function logTransaction(action, details = {}) {
  log('transaction', {
    action,
    ...details,
  });
}

/**
 * Log configuration changes
 */
function logConfigChange(action, details = {}) {
  log('config_change', {
    action,
    ...details,
  });
}

/**
 * Log API access
 */
function logApiAccess(endpoint, method, details = {}) {
  log('api_access', {
    endpoint,
    method,
    ...details,
  });
}

/**
 * Log command execution
 */
function logCommand(command, source, details = {}) {
  log('command', {
    command,
    source,
    ...details,
  });
}

module.exports = {
  log,
  logAuth,
  logSecurityEvent,
  logTransaction,
  logConfigChange,
  logApiAccess,
  logCommand,
  AUDIT_LOG_PATH,
};

