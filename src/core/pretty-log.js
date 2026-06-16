// pretty-log.js
const chalk = require("chalk");
const { formatPriceForDisplay } = require('../../utils/price-formatter');

let ui = null;

// Set UI reference for sending messages
function setUI(uiInstance) {
  ui = uiInstance;
}

/**
 * Format price for display with adaptive precision.
 * NOTE: This is for DISPLAY ONLY - all computations use raw prices.
 * @param {number} price - Raw price value
 * @returns {string} Formatted price string (without $ prefix)
 */
function fmtPrice(price) {
  if (price === undefined || price === null || !Number.isFinite(price)) return 'N/A';
  // Use the centralized formatter but strip the $ prefix for flexibility
  return formatPriceForDisplay(price, { includeSign: false });
}

module.exports = function pretty(event, data = {}) {
  const t = new Date().toLocaleTimeString();

  switch (event) {

    case "starting":
      console.log("");
      console.log(chalk.cyan("🚀 Starting bot..."));
      console.log("");
      if (ui) {
        ui.send("activity", { level: "info", message: "🚀 Starting bot...", data });
      }
      break;

    case "warmup":
      process.stdout.write(
        chalk.yellow(`⏳ Warm-up ${data.done}/${data.total}...\r`)
      );
      if (ui && data.done % 10 === 0) { // Only send every 10th to avoid spam
        ui.send("activity", { level: "info", message: `⏳ Warm-up ${data.done}/${data.total}...`, data });
      }
      break;

    case "ready":
      console.log("");
      console.log(chalk.green("✅ Warm-up complete — live trading started"));
      console.log("");
      if (ui) {
        ui.send("activity", { level: "success", message: "✅ Warm-up complete — live trading started", data });
      }
      break;

    case "price":
      // Price updates are too noisy - only log if explicitly requested
      if (process.env.LOG_PRICE_UPDATES === 'true') {
        const market = data.market || data.symbol || '';
        const priceVal = fmtPrice(data.price);
        process.stdout.write(
          chalk.gray(`[${t}]`) + ` ${market} Price $${priceVal}     \r`
        );
      }
      // Don't send price to activity feed (too frequent)
      break;

    case "signal":
      // Signal is about to be executed - include market and key details
      // NOTE: data.price contains full precision - fmtPrice is display only
      const market = data.market || '';
      const priceStr = fmtPrice(data.price);
      const confStr = data.confidence !== undefined && data.confidence !== null ? ` (conf: ${data.confidence.toFixed(2)})` : '';
      const strategyStr = data.strategyType ? ` [${data.strategyType}]` : '';
      const signalMsg = `📡 Signal → ${data.side.toUpperCase()} ${market} @ $${priceStr}${strategyStr}${confStr}`;
      console.log(chalk.magenta(signalMsg));
      if (ui) {
        ui.send("activity", { level: "signal", message: signalMsg, data });
      }
      break;

    case "open":
      // NOTE: data.entry contains full precision - fmtPrice is display only
      const sizeStr = data.size !== undefined && data.size !== null ? data.size.toFixed(2) : 'N/A';
      const entryStr = fmtPrice(data.entry);
      const openStrategyStr = data.strategyType ? ` [${data.strategyType}]` : '';
      const openPoolStr = data.poolLabel ? ` (${data.poolLabel})` : '';
      const openMsg = `✅ OPEN ${data.side.toUpperCase()}${openStrategyStr}${openPoolStr} • size $${sizeStr} @ $${entryStr}`;
      console.log(chalk.green(openMsg));
      if (ui) {
        ui.send("activity", { level: "success", message: openMsg, data });
      }
      break;

    case "close":
      // NOTE: data.exit contains full precision - fmtPrice is display only
      const pnlColor = (data.pnl !== undefined && data.pnl !== null && data.pnl >= 0) ? chalk.green : chalk.red;
      const pnlStr = data.pnl !== undefined && data.pnl !== null ? data.pnl.toFixed(2) : 'N/A';
      const exitStr = fmtPrice(data.exit);
      const closeStrategyStr = data.strategyType ? ` [${data.strategyType}]` : '';
      const closePoolStr = data.poolLabel ? ` (${data.poolLabel})` : '';
      const closeMsg = `💰 CLOSE ${data.side.toUpperCase()}${closeStrategyStr}${closePoolStr} • PnL $${pnlStr} @ $${exitStr}`;
      console.log(pnlColor(closeMsg));
      if (ui) {
        ui.send("activity", { level: (data.pnl !== undefined && data.pnl !== null && data.pnl >= 0) ? "success" : "error", message: closeMsg, data });
      }
      break;

    case "status":
      // NOTE: data.price contains full precision - fmtPrice is display only
      const statusPriceStr = fmtPrice(data.price);
      const balanceStr = data.balance !== undefined && data.balance !== null ? data.balance.toFixed(2) : 'N/A';
      const statusMsg = `📊 ${data.market} | Mode: ${data.mode} | Price: $${statusPriceStr} | Positions: ${data.pos}/${data.posCap} | Daily: ${data.daily}/${data.dailyCap} | Balance: $${balanceStr}`;
      console.log(chalk.cyan(statusMsg));
      if (ui) {
        ui.send("activity", { level: "info", message: statusMsg, data });
      }
      break;

    case "leverage":
      const leverageMsg = `⚙️ Leverage: ${data.leverage}x (base: ${data.base || data.leverage}x)${data.reason ? ` - ${data.reason}` : ''}`;
      console.log(chalk.blue(leverageMsg));
      if (ui) {
        ui.send("activity", { level: "info", message: leverageMsg, data });
      }
      break;

    case "signal_blocked":
      const blockedMsg = `🚫 Signal BLOCKED: ${data.side?.toUpperCase()} ${data.market || ''} - ${data.reason || 'Unknown reason'}`;
      console.log(chalk.yellow(blockedMsg));
      if (ui) {
        ui.send("activity", { level: "warning", message: blockedMsg, data });
      }
      break;

    case "signal_rejected":
      // NOTE: data.price contains full precision - fmtPrice is display only
      const rejectedPriceStr = fmtPrice(data.price);
      let rejectedMsg = `❌ Signal REJECTED: ${data.side?.toUpperCase()} ${data.market || ''} @ $${rejectedPriceStr} - ${data.reason || 'Unknown reason'}`;

      // Add detailed diagnostics if available (when rejected by allocator)
      if (data.diagnostics) {
        const diag = data.diagnostics;
        const details = [];

        // Show the specific reason
        if (diag.reason) {
          details.push(`Reason: ${diag.reason}`);
        }

        // Show component scores
        if (diag.components) {
          const comp = diag.components;
          details.push(`Components: conf=${comp.confidence?.toFixed(3) || 'N/A'}, ret=${comp.expectedReturn?.toFixed(3) || 'N/A'}, vol=${comp.volatility?.toFixed(3) || 'N/A'}, perf=${comp.performance?.toFixed(3) || 'N/A'}`);
        }

        // Show adjustments
        if (diag.adjustments) {
          const adj = diag.adjustments;
          const adjParts = [];
          if (adj.diversification !== 1.0) adjParts.push(`div=${adj.diversification?.toFixed(2) || 'N/A'}`);
          if (adj.correlation !== 1.0) adjParts.push(`corr=${adj.correlation?.toFixed(2) || 'N/A'}`);
          if (adj.cooldown !== 1.0) adjParts.push(`cooldown=${adj.cooldown?.toFixed(2) || 'N/A'}`);
          if (adj.marketBoost !== 1.0) adjParts.push(`boost=${adj.marketBoost?.toFixed(2) || 'N/A'}`);
          if (adjParts.length > 0) {
            details.push(`Adjustments: ${adjParts.join(', ')}`);
          }
        }

        // Show final score vs threshold
        if (diag.finalScore !== undefined && diag.minScore !== undefined) {
          details.push(`Score: ${diag.finalScore?.toFixed(3)} < ${diag.minScore?.toFixed(3)} (min)`);
        }
        if (diag.confidenceScore !== undefined && diag.minConfidence !== undefined) {
          details.push(`Confidence: ${diag.confidenceScore?.toFixed(3)} < ${diag.minConfidence?.toFixed(3)} (min)`);
        }

        if (details.length > 0) {
          rejectedMsg += '\n   ' + details.join(' | ');
        }
      }

      console.log(chalk.red(rejectedMsg));
      if (ui) {
        ui.send("activity", { level: "warning", message: rejectedMsg, data });
      }
      break;

    default:
      // Handle custom events
      if (data.message) {
        const level = data.level || "info";
        console.log(chalk.gray(`[${event}] ${data.message}`));
        if (ui) {
          ui.send("activity", { level, message: data.message, data });
        }
      }
      break;
  }
};

module.exports.setUI = setUI;
