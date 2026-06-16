/**
 * Backtest Logger
 * Provides structured logging for backtest operations with configurable log levels
 */
class BacktestLogger {
  constructor(options = {}) {
    this.debugEnabled = options.debug || false;
    this.verboseEnabled = options.verbose || false;
    this.silent = options.silent || false;
    this.prefix = options.prefix || '[BACKTEST]';
  }

  /**
   * Debug level logging (only shown when debug=true)
   */
  debug(msg, ...args) {
    if (this.silent || !this.debugEnabled) return;
    console.log(`${this.prefix}-DEBUG ${msg}`, ...args);
  }

  /**
   * Info level logging
   */
  info(msg, ...args) {
    if (this.silent) return;
    console.log(`${this.prefix} ${msg}`, ...args);
  }

  /**
   * Warning level logging
   */
  warn(msg, ...args) {
    if (this.silent) return;
    console.warn(`${this.prefix}-WARN ${msg}`, ...args);
  }

  /**
   * Error level logging
   */
  error(msg, ...args) {
    if (this.silent) return;
    console.error(`${this.prefix}-ERROR ${msg}`, ...args);
  }

  /**
   * Verbose logging (detailed information)
   */
  verbose(msg, ...args) {
    if (this.silent || !this.verboseEnabled) return;
    console.log(`${this.prefix}-VERBOSE ${msg}`, ...args);
  }

  /**
   * Log with custom level
   */
  log(level, msg, ...args) {
    if (this.silent) return;
    const levelUpper = level.toUpperCase();
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logFn(`${this.prefix}-${levelUpper} ${msg}`, ...args);
  }
}

module.exports = BacktestLogger;
