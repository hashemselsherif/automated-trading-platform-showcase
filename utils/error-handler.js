// Comprehensive error handling utility
const fs = require('fs');
const path = require('path');

const ERROR_LOG_PATH = path.join(__dirname, '../logs', 'errors.jsonl');

// Ensure log directory exists
const logDir = path.dirname(ERROR_LOG_PATH);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

/**
 * Error severity levels
 */
const Severity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * Error categories
 */
const Category = {
  NETWORK: 'network',
  TRANSACTION: 'transaction',
  VALIDATION: 'validation',
  RISK: 'risk',
  STRATEGY: 'strategy',
  SYSTEM: 'system',
};

/**
 * Enhanced error logger
 */
class ErrorHandler {
  constructor(options = {}) {
    this.options = {
      logToFile: options.logToFile !== false,
      logToConsole: options.logToConsole !== true,
      maxLogSize: options.maxLogSize || 10 * 1024 * 1024, // 10MB
      ...options,
    };
    this.errorCounts = new Map();
    this.telegram = null; // Set via setTelegram() for alerts
  }
  
  /**
   * Set Telegram instance for alerts
   */
  setTelegram(telegram) {
    this.telegram = telegram;
  }

  /**
   * Sanitize error message for production
   */
  _sanitizeErrorMessage(error, isProduction = false) {
    if (!isProduction) {
      return error?.message || String(error);
    }

    // In production, sanitize error messages to prevent information disclosure
    const message = error?.message || String(error);
    
    // Remove file paths
    const sanitized = message
      .replace(/\/[^\s]+\.js/g, '[file]')
      .replace(/\/Users\/[^\s]+/g, '[path]')
      .replace(/\/home\/[^\s]+/g, '[path]')
      .replace(/at\s+[^\s]+\s+\([^)]+\)/g, 'at [function]')
      .replace(/\n\s+at\s+.+/g, ''); // Remove stack trace lines

    // Don't expose internal error details
    if (message.includes('password') || message.includes('key') || message.includes('secret')) {
      return 'Authentication error';
    }

    if (message.includes('ENOENT') || message.includes('permission')) {
      return 'File access error';
    }

    return sanitized;
  }

  /**
   * Log an error with context
   */
  log(error, context = {}) {
    const isProduction = process.env.NODE_ENV === 'production';
    const sanitizedMessage = this._sanitizeErrorMessage(error, isProduction);

    const errorInfo = {
      timestamp: new Date().toISOString(),
      message: sanitizedMessage,
      stack: isProduction ? undefined : error?.stack, // Never log stack in production
      name: error?.name || 'Error',
      category: context.category || Category.SYSTEM,
      severity: context.severity || Severity.MEDIUM,
      context: {
        ...context,
        category: undefined,
        severity: undefined,
        // Sanitize context to remove sensitive data
        password: context.password ? '[REDACTED]' : undefined,
        privateKey: context.privateKey ? '[REDACTED]' : undefined,
        secret: context.secret ? '[REDACTED]' : undefined,
      },
    };

    // Track error counts
    const key = `${errorInfo.category}:${errorInfo.name}`;
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
    errorInfo.occurrences = this.errorCounts.get(key);

    // Console logging
    if (!this.options.logToConsole) {
      const prefix = `[${errorInfo.severity.toUpperCase()}] [${errorInfo.category}]`;
      console.error(`${prefix} ${errorInfo.message}`);
      if (!isProduction && errorInfo.context && Object.keys(errorInfo.context).length > 0) {
        console.error('Context:', errorInfo.context);
      }
    }
    
    // Telegram alerts for critical/high severity errors
    if (this.telegram && (errorInfo.severity === Severity.CRITICAL || errorInfo.severity === Severity.HIGH)) {
      this.telegram.alertCriticalError(error, {
        category: errorInfo.category,
        severity: errorInfo.severity,
        action: errorInfo.context?.action,
        impact: errorInfo.context?.impact
      }).catch(() => {
        // Ignore errors sending alerts
      });
    }

    // File logging
    if (this.options.logToFile) {
      try {
        const logLine = JSON.stringify(errorInfo) + '\n';
        
        // Rotate if file is too large
        if (fs.existsSync(ERROR_LOG_PATH)) {
          const stats = fs.statSync(ERROR_LOG_PATH);
          if (stats.size > this.options.maxLogSize) {
            const backupPath = ERROR_LOG_PATH + '.backup';
            fs.renameSync(ERROR_LOG_PATH, backupPath);
          }
        }
        
        fs.appendFileSync(ERROR_LOG_PATH, logLine);
      } catch (logError) {
        console.error('Failed to write error log:', logError);
      }
    }

    return errorInfo;
  }

  /**
   * Handle error with recovery strategy
   */
  async handle(error, context = {}, recoveryStrategy = null) {
    const errorInfo = this.log(error, context);

    // Attempt recovery if strategy provided
    if (recoveryStrategy && typeof recoveryStrategy === 'function') {
      try {
        const recovered = await recoveryStrategy(error, errorInfo);
        if (recovered) {
          this.log(new Error('Recovery successful'), {
            category: Category.SYSTEM,
            severity: Severity.LOW,
            originalError: errorInfo.message,
          });
          return { recovered: true, errorInfo };
        }
      } catch (recoveryError) {
        this.log(recoveryError, {
          category: Category.SYSTEM,
          severity: Severity.HIGH,
          context: { originalError: errorInfo.message },
        });
      }
    }

    return { recovered: false, errorInfo };
  }

  /**
   * Wrap async function with error handling
   */
  wrap(fn, context = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        this.handle(error, {
          ...context,
          function: fn.name || 'anonymous',
          args: args.length,
        });
        throw error;
      }
    };
  }

  /**
   * Get error statistics
   */
  getStats() {
    const stats = {};
    for (const [key, count] of this.errorCounts.entries()) {
      stats[key] = count;
    }
    return stats;
  }

  /**
   * Clear error counts
   */
  clearStats() {
    this.errorCounts.clear();
  }
}

// Global error handler instance
const errorHandler = new ErrorHandler();

module.exports = {
  ErrorHandler,
  errorHandler,
  Severity,
  Category,
};

