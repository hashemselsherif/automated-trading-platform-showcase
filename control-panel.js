#!/usr/bin/env node
// Bot Control Panel - Easy bot management from Cursor
require('dotenv').config();
const { execSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');

const BOT_NAME = 'jupiter-perps-bot';
const UI_PORT = process.env.UI_PORT || 3000;
const API_BASE = `http://localhost:${UI_PORT}/api`;

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function colorize(text, color) {
  return `${colors[color] || ''}${text}${colors.reset}`;
}

// Helper to make API requests
function apiRequest(method, endpoint, data = null) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${endpoint}`;
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          resolve(body);
        }
      });
    });

    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

// Check PM2 status
function getPM2Status() {
  try {
    const output = execSync(`pm2 jlist`, { encoding: 'utf-8', stdio: 'pipe' });
    const processes = JSON.parse(output);
    const bot = processes.find(p => p.name === BOT_NAME);
    return bot || null;
  } catch (e) {
    return null;
  }
}

// Format status display
function formatStatus(status) {
  if (!status) return colorize('❌ Bot not running', 'red');
  
  const isRunning = status.pm2_env?.status === 'online';
  const uptime = status.pm2_env?.pm_uptime ? 
    Math.floor((Date.now() - status.pm2_env.pm_uptime) / 1000 / 60) : 0;
  const restarts = status.pm2_env?.restart_time || 0;
  const memory = status.monit?.memory ? 
    (status.monit.memory / 1024 / 1024).toFixed(1) : '?';
  
  const statusColor = isRunning ? 'green' : 'red';
  const statusIcon = isRunning ? '✅' : '❌';
  
  return [
    `${statusIcon} ${colorize(`Bot: ${isRunning ? 'RUNNING' : 'STOPPED'}`, statusColor)}`,
    `   PID: ${status.pid || 'N/A'}`,
    `   Uptime: ${uptime}m`,
    `   Restarts: ${restarts}`,
    `   Memory: ${memory}MB`,
  ].join('\n');
}

// Get bot status via API
async function getBotStatus() {
  try {
    const status = await apiRequest('GET', '/status');
    return status;
  } catch (e) {
    return null;
  }
}

// Display bot status
async function displayStatus() {
  console.log(colorize('\n📊 BOT STATUS', 'bright'));
  console.log('─'.repeat(50));
  
  // PM2 status
  const pm2Status = getPM2Status();
  console.log(formatStatus(pm2Status));
  
  // Bot API status
  const botStatus = await getBotStatus();
  if (botStatus) {
    console.log('\n' + colorize('🤖 Bot Operations:', 'bright'));
    const mode = botStatus.mode || 'unknown';
    const execMode = botStatus.execMode || botStatus.executionMode || 'unknown';
    const paused = botStatus.paused ? '⏸️  PAUSED' : '▶️  RUNNING';
    const pausedColor = botStatus.paused ? 'yellow' : 'green';
    
    console.log(`   Mode: ${colorize(mode, 'cyan')}/${colorize(execMode, 'cyan')}`);
    console.log(`   Status: ${colorize(paused, pausedColor)}`);
    
    // Display all markets being traded
    if (botStatus.markets && botStatus.markets.length > 0) {
      console.log(`   Markets: ${colorize(botStatus.markets.join(', '), 'cyan')} (${botStatus.markets.length} markets)`);
      
      // Display prices for all markets
      if (botStatus.marketPrices && Object.keys(botStatus.marketPrices).length > 0) {
        console.log(`   Market Prices:`);
        for (const market of botStatus.markets) {
          const priceData = botStatus.marketPrices[market];
          if (priceData) {
            const price = priceData.price || 0;
            const volume = priceData.volume ? ` (vol: ${(priceData.volume / 1000).toFixed(1)}k)` : '';
            console.log(`      ${market}: ${colorize(`$${price.toFixed(4)}`, 'yellow')}${volume}`);
          }
        }
      } else {
        // Fallback to single market display
        console.log(`   Market: ${botStatus.market || 'N/A'}`);
        console.log(`   Price: $${botStatus.price?.toFixed(4) || 'N/A'}`);
      }
    } else {
      // Fallback for backward compatibility
      console.log(`   Market: ${botStatus.market || 'N/A'}`);
      console.log(`   Price: $${botStatus.price?.toFixed(4) || 'N/A'}`);
    }
    
    console.log(`   Positions: ${botStatus.positions || 0}/${botStatus.posCap || 0}`);
    console.log(`   Daily Trades: ${botStatus.dailyTrades || 0}/${botStatus.dailyCap || 0}`);
    
    const freeCapital = botStatus.freeCapital !== undefined ? botStatus.freeCapital : (botStatus.balance || 0);
    const lockedCapital = botStatus.lockedCapital || 0;
    const totalEquity = botStatus.totalEquity || (freeCapital + lockedCapital);
    
    console.log(`   Free Capital: ${colorize(`$${freeCapital.toFixed(2)}`, 'green')}`);
    console.log(`   Locked Capital: ${colorize(`$${lockedCapital.toFixed(2)}`, 'yellow')}`);
    console.log(`   Total Equity: ${colorize(`$${totalEquity.toFixed(2)}`, 'bright')}`);
    
    if (botStatus.openPositions && botStatus.openPositions.length > 0) {
      console.log('\n' + colorize('📜 Open Positions:', 'bright'));
      botStatus.openPositions.forEach((pos, i) => {
        const sideColor = pos.side === 'long' ? 'green' : 'red';
        const sideIcon = pos.side === 'long' ? '📈' : '📉';
        console.log(`   ${i + 1}. ${sideIcon} ${colorize(pos.side.toUpperCase(), sideColor)} ${pos.market || ''}`);
        console.log(`      Size: $${pos.size?.toFixed(2) || '0.00'} | Entry: $${pos.entryPrice?.toFixed(4) || '0.0000'}`);
        console.log(`      PnL: ${colorize(`$${pos.unrealizedPnl?.toFixed(2) || '0.00'}`, pos.unrealizedPnl >= 0 ? 'green' : 'red')}`);
      });
    }
  } else {
    console.log(colorize('\n⚠️  Cannot connect to bot API (bot may be starting or stopped)', 'yellow'));
  }
  
  console.log('');
}

// PM2 operations
function startBot() {
  console.log(colorize('\n🚀 Starting bot...', 'bright'));
  try {
    execSync(`pm2 start ${BOT_NAME}`, { stdio: 'inherit' });
    console.log(colorize('✅ Bot started', 'green'));
  } catch (e) {
    console.error(colorize('❌ Failed to start bot:', 'red'), e.message);
  }
}

function stopBot() {
  console.log(colorize('\n🛑 Stopping bot...', 'bright'));
  try {
    execSync(`pm2 stop ${BOT_NAME}`, { stdio: 'inherit' });
    console.log(colorize('✅ Bot stopped', 'green'));
  } catch (e) {
    console.error(colorize('❌ Failed to stop bot:', 'red'), e.message);
  }
}

function restartBot() {
  console.log(colorize('\n🔄 Restarting bot...', 'bright'));
  try {
    execSync(`pm2 restart ${BOT_NAME}`, { stdio: 'inherit' });
    console.log(colorize('✅ Bot restarted', 'green'));
  } catch (e) {
    console.error(colorize('❌ Failed to restart bot:', 'red'), e.message);
  }
}

// Bot operations
async function pauseBot() {
  try {
    await apiRequest('POST', '/pause');
    console.log(colorize('✅ Bot paused', 'green'));
  } catch (e) {
    console.error(colorize('❌ Failed to pause:', 'red'), e.message);
  }
}

async function resumeBot() {
  try {
    await apiRequest('POST', '/resume');
    console.log(colorize('✅ Bot resumed', 'green'));
  } catch (e) {
    console.error(colorize('❌ Failed to resume:', 'red'), e.message);
  }
}

async function closeAllPositions() {
  console.log(colorize('\n⚠️  WARNING: This will close ALL open positions!', 'yellow'));
  console.log(colorize('   Proceeding in 3 seconds... (Ctrl+C to cancel)', 'yellow'));
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  try {
    await apiRequest('POST', '/closeall');
    console.log(colorize('✅ All positions closed', 'green'));
  } catch (e) {
    console.error(colorize('❌ Failed to close positions:', 'red'), e.message);
  }
}

// Show logs
function showLogs(lines = 50) {
  console.log(colorize(`\n📋 Last ${lines} lines of bot logs:`, 'bright'));
  console.log('─'.repeat(50));
  try {
    execSync(`pm2 logs ${BOT_NAME} --lines ${lines} --nostream`, { stdio: 'inherit' });
  } catch (e) {
    console.error(colorize('❌ Failed to show logs:', 'red'), e.message);
  }
}

// Follow logs
function followLogs() {
  console.log(colorize('\n📋 Following bot logs (Ctrl+C to exit):', 'bright'));
  console.log('─'.repeat(50));
  const child = spawn('pm2', ['logs', BOT_NAME, '--lines', '20'], {
    stdio: 'inherit',
    shell: true,
  });
  
  process.on('SIGINT', () => {
    child.kill();
    process.exit(0);
  });
}

// Help
function showHelp() {
  console.log(colorize('\n🤖 Jupiter Perps Bot Control Panel', 'bright'));
  console.log('─'.repeat(50));
  console.log('Usage: node control-panel.js <command>');
  console.log('');
  console.log(colorize('Commands:', 'bright'));
  console.log('  status       Show bot status (PM2 + operations)');
  console.log('  start        Start the bot (PM2)');
  console.log('  stop         Stop the bot (PM2)');
  console.log('  restart      Restart the bot (PM2)');
  console.log('  pause        Pause bot operations (no new trades)');
  console.log('  resume       Resume bot operations');
  console.log('  closeall     Close all open positions');
  console.log('  logs [N]     Show last N lines of logs (default: 50)');
  console.log('  follow       Follow logs in real-time');
  console.log('  help         Show this help message');
  console.log('');
  console.log(colorize('Examples:', 'bright'));
  console.log('  node control-panel.js status');
  console.log('  node control-panel.js pause');
  console.log('  node control-panel.js logs 100');
  console.log('  node control-panel.js follow');
  console.log('');
}

// Main
const command = process.argv[2] || 'status';

(async () => {
  switch (command) {
    case 'status':
      await displayStatus();
      break;
    case 'start':
      startBot();
      await new Promise(resolve => setTimeout(resolve, 2000));
      await displayStatus();
      break;
    case 'stop':
      stopBot();
      break;
    case 'restart':
      restartBot();
      await new Promise(resolve => setTimeout(resolve, 2000));
      await displayStatus();
      break;
    case 'pause':
      await pauseBot();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await displayStatus();
      break;
    case 'resume':
      await resumeBot();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await displayStatus();
      break;
    case 'closeall':
      await closeAllPositions();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await displayStatus();
      break;
    case 'logs':
      const lines = parseInt(process.argv[3]) || 50;
      showLogs(lines);
      break;
    case 'follow':
      followLogs();
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      console.error(colorize(`❌ Unknown command: ${command}`, 'red'));
      console.log('Run "node control-panel.js help" for usage information');
      process.exit(1);
  }
})();

