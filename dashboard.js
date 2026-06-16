#!/usr/bin/env node
// Interactive Terminal Dashboard for Jupiter Perps Bot
//
// DATA FLOW (Source of Truth):
// 1. PRIMARY: WebSocket receives real-time updates from bot.statusSnapshot()
// 2. FALLBACK: HTTP API polls /api/status every 1 second (if WebSocket drops)
// 3. PM2: Process stats every 5 seconds for uptime/stability
// 4. CONFIG: Bot configuration every 60 seconds (rarely changes)
//
// The bot's statusSnapshot() method is the single source of truth for all trading data.
// All dashboard panels pull from currentStatus, which is updated via WebSocket or API.
// See docs/DASHBOARD_ARCHITECTURE.md for detailed information.

require('dotenv').config();
const blessed = require('blessed');
const contrib = require('blessed-contrib');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { URL } = require('url');

// Determine API base URL and WebSocket URL
// Priority: DASHBOARD_API_URL > BOT_SERVICE_URL > UI_SERVER_URL > localhost
// Note: The bot service runs the UI server, so we can connect directly to it
let API_BASE, WS_URL;

const dashboardUrl = process.env.DASHBOARD_API_URL || process.env.BOT_SERVICE_URL || process.env.UI_SERVER_URL;

if (dashboardUrl) {
  // Parse the provided URL
  let parsedUrl;
  try {
    // If it's already a full URL, use it directly
    if (dashboardUrl.startsWith('http://') || dashboardUrl.startsWith('https://')) {
      parsedUrl = new URL(dashboardUrl);
    } else if (dashboardUrl.startsWith('ws://') || dashboardUrl.startsWith('wss://')) {
      // Convert WebSocket URL to HTTP for API calls
      const httpUrl = dashboardUrl.replace('ws://', 'http://').replace('wss://', 'https://');
      parsedUrl = new URL(httpUrl);
      WS_URL = dashboardUrl; // Use the original WebSocket URL
    } else {
      // Assume it's a hostname, add protocol (prefer HTTPS for Render)
      parsedUrl = new URL(`https://${dashboardUrl}`);
    }
    
    // Build API base URL
    const protocol = parsedUrl.protocol === 'https:' ? 'https:' : 'http:';
    const port = parsedUrl.port || (protocol === 'https:' ? 443 : 80);
    const host = parsedUrl.hostname;
    
    API_BASE = `${protocol}//${host}${port && port !== 443 && port !== 80 ? `:${port}` : ''}/api`;
    
    // Build WebSocket URL if not already set
    // The bot service exposes WebSocket on the same URL as the HTTP API
    if (!WS_URL) {
      const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
      WS_URL = `${wsProtocol}//${host}${port && port !== 443 && port !== 80 ? `:${port}` : ''}`;
    }
  } catch (e) {
    console.error(`⚠️  Invalid URL format: ${dashboardUrl}, falling back to localhost`);
    const UI_PORT = process.env.UI_PORT || 3000;
    API_BASE = `http://localhost:${UI_PORT}/api`;
    WS_URL = `ws://localhost:${UI_PORT}`;
  }
} else {
  // Default to localhost
  const UI_PORT = process.env.UI_PORT || 3000;
  API_BASE = `http://localhost:${UI_PORT}/api`;
  WS_URL = `ws://localhost:${UI_PORT}`;
}

console.log(`📡 Dashboard connecting to bot service: ${API_BASE}`);
console.log(`🔌 WebSocket URL: ${WS_URL}`);
console.log(`ℹ️  Note: Bot service runs the UI server, so WebSocket is available on the same URL`);
if (isRemoteConnection) {
  const apiKey = process.env.API_KEY || process.env.DASHBOARD_API_KEY;
  if (apiKey) {
    console.log(`🔐 API key authentication: ✅ Configured`);
  } else {
    console.log(`⚠️  API key authentication: ❌ Not configured (set API_KEY or DASHBOARD_API_KEY env var)`);
  }
}

// Check if connecting to remote instance (not localhost)
const isRemoteConnection = !API_BASE.includes('localhost') && !API_BASE.includes('127.0.0.1');

// Create screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'Jupiter Perps Bot - Live Dashboard',
  fullUnicode: true,
});

// Create grid - increased rows for better spacing
const grid = new contrib.grid({
  rows: 18,
  cols: 12,
  screen: screen,
});

// Top row: Operational Stats Panel (colored, prominent)
const operationalStatsBox = grid.set(0, 0, 2, 12, blessed.box, {
  label: 'Operational Status',
  content: 'Loading...',
  tags: true,
  style: { fg: 'white', border: { fg: 'cyan' }, bg: 'black' },
});

// Second row: Key Configuration (left) and Market Prices (right)
const configBox = grid.set(2, 0, 4, 6, blessed.box, {
  label: 'Key Configuration',
  content: 'Loading...',
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: ' ', inverse: true },
  style: { fg: 'white', border: { fg: 'green' } },
});

const marketPricesBox = grid.set(2, 6, 4, 6, contrib.table, {
  label: 'Market Prices',
  keys: true,
  fg: 'white',
  columnSpacing: 3,
  columnWidth: [15, 18, 15],
});

// Third row: Entry Signals (left) and Positions (right)
const entrySignalsBox = grid.set(6, 0, 3, 6, contrib.table, {
  label: 'Entry Signals & Gate Status',
  keys: true,
  fg: 'white',
  columnSpacing: 2,
  columnWidth: [14, 12, 38],
});

const positionsBox = grid.set(6, 6, 3, 6, contrib.table, {
  label: 'Open Positions',
  keys: true,
  fg: 'white',
  columnSpacing: 3,
  columnWidth: [14, 10, 14, 14],
});

// Fourth row: Portfolio Metrics (full width)
const portfolioBox = grid.set(9, 0, 3, 12, blessed.box, {
  label: 'Portfolio Metrics',
  content: 'Loading...',
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: ' ', inverse: true },
  style: { fg: 'white', border: { fg: 'cyan' } },
});

// Commands Menu
const commandsBox = grid.set(12, 0, 2, 12, blessed.box, {
  label: 'Commands (Press Number)',
  content: '',
  tags: true,
  scrollable: false,
  style: { fg: 'yellow', border: { fg: 'yellow' } },
});

// Activity Feed (bottom)
const activityFeed = grid.set(14, 0, 4, 12, contrib.log, {
  label: 'Activity Feed',
  fg: 'green',
  selectedFg: 'black',
  selectedBg: 'yellow',
});

// Key bindings
screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
screen.key(['1'], () => startBot());
screen.key(['2'], () => stopBot());
screen.key(['3'], () => restartBot());
screen.key(['4'], () => pauseBot());
screen.key(['5'], () => resumeBot());
screen.key(['6'], () => closeAllPositions());
screen.key(['7'], () => refreshStatus());
screen.key(['8'], () => showHelp());
screen.key(['h'], () => showHelp());
screen.key(['p'], () => pauseBot());
screen.key(['r'], () => resumeBot());
screen.key(['c'], () => closeAllPositions());
screen.key(['s'], () => refreshStatus());

// State
let currentStatus = {};
let currentConfig = {};
let gateBlockingStats = {}; // Track which gates block most often
let lastUpdateTime = Date.now();
let ws = null;
let reconnectInterval = null;
let pm2Stats = null; // PM2 process stats
let botStartTime = Date.now(); // Track bot start time

// Initialize
initializeDashboard();

function initializeDashboard() {
  // Initialize with placeholder data for immediate display
  updateCommandsMenu();
  updateOperationalStats();
  updateMarketPrices();
  updatePositions();
  updateEntrySignals();
  updatePortfolioMetrics();
  updateConfig();
  
  operationalStatsBox.setContent('{center}{yellow-fg}Connecting to bot...{/yellow-fg}{/center}');
  activityFeed.log('{cyan-fg}📡 Dashboard initializing...{/cyan-fg}');
  screen.render();
  
  // Connect asynchronously (don't block rendering)
  setTimeout(async () => {
    // Connect WebSocket for real-time updates (source of truth)
    connectWebSocket();
    
    // Get initial data immediately
    await refreshPM2Stats();
    await refreshStatus();
    await refreshConfig();
    
    activityFeed.log('{green-fg}✅ Dashboard connected to bot{/green-fg}');
  }, 50);
  
  // Refresh PM2 stats every 5 seconds (for uptime/stability)
  setInterval(refreshPM2Stats, 5000);
  
  // Refresh status every 1 second as fallback (if WebSocket drops)
  // WebSocket is primary - this is backup
  setInterval(refreshStatus, 1000);
  
  // Refresh config every 60 seconds (config rarely changes)
  setInterval(refreshConfig, 60000);
  
  // Update operational stats display every 500ms for live feel
  setInterval(() => {
    updateOperationalStats();
    screen.render();
  }, 500);
}

function connectWebSocket() {
  try {
    // Close existing connection if any
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
    
    // Add API key authentication if available
    let wsUrl = WS_URL;
    const apiKey = process.env.API_KEY || process.env.DASHBOARD_API_KEY;
    if (apiKey && isRemoteConnection) {
      // Add API key as query parameter for WebSocket authentication
      const separator = wsUrl.includes('?') ? '&' : '?';
      wsUrl = `${wsUrl}${separator}apiKey=${encodeURIComponent(apiKey)}`;
    }
    
    ws = new WebSocket(wsUrl);
    
    // Set connection timeout
    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        statusBar.setContent('{center}{yellow-fg}○{/yellow-fg} WebSocket timeout - Using polling mode{/center}');
        screen.render();
      }
    }, 3000);
    
    ws.on('open', () => {
      clearTimeout(connectTimeout);
      updateOperationalStats();
      screen.render();
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        handleWebSocketMessage(msg);
      } catch (e) {
        // Ignore parse errors
      }
    });
    
    ws.on('error', (err) => {
      clearTimeout(connectTimeout);
      // Don't show error immediately - might just be bot not started
      if (ws.readyState === WebSocket.CLOSED) {
        updateOperationalStats();
        screen.render();
      }
    });
    
    ws.on('close', () => {
      clearTimeout(connectTimeout);
      updateOperationalStats();
      screen.render();
      
      // Reconnect after 5 seconds (longer delay to avoid spam)
      if (reconnectInterval) clearTimeout(reconnectInterval);
      reconnectInterval = setTimeout(connectWebSocket, 5000);
    });
  } catch (e) {
    // Connection failed - continue with polling mode
    updateOperationalStats();
    screen.render();
  }
}

function handleWebSocketMessage(msg) {
  if (msg.ev === 'status') {
    // Direct update from bot - this is the source of truth
    currentStatus = msg.data;
    lastUpdateTime = Date.now();
    updateDashboard();
  } else if (msg.ev === 'open') {
    const market = msg.data.market || 'UNKNOWN';
    activityFeed.log(`{green-fg}✅ OPEN{/green-fg} ${msg.data.side?.toUpperCase()} ${market} @ $${msg.data.entry?.toFixed(4)}`);
    // Refresh status immediately after position open
    setTimeout(refreshStatus, 100);
  } else if (msg.ev === 'close') {
    const pnl = msg.data.pnl || 0;
    const pnlColor = pnl >= 0 ? 'green' : 'red';
    const pnlSign = pnl >= 0 ? '+' : '';
    const market = msg.data.market || 'UNKNOWN';
    activityFeed.log(`{${pnlColor}-fg}${pnl >= 0 ? '💰' : '📉'} CLOSE{/} ${msg.data.side?.toUpperCase()} ${market} @ $${msg.data.exit?.toFixed(4)} | PnL: ${pnlSign}$${pnl.toFixed(2)} | ${msg.data.reason || ''}`);
    // Refresh status immediately after position close
    setTimeout(refreshStatus, 100);
  } else if (msg.ev === 'signal') {
    const market = msg.data.market || 'UNKNOWN';
    const side = msg.data.side?.toUpperCase() || 'UNKNOWN';
    activityFeed.log(`{cyan-fg}📊 SIGNAL{/cyan-fg} ${side} ${market} | ADX:${msg.data.adx || 'N/A'} RSI:${msg.data.rsi || 'N/A'}`);
  } else if (msg.ev === 'activity' || msg.ev === 'log') {
    const level = msg.data.level || 'info';
    const message = msg.data.message || JSON.stringify(msg.data);
    const color = level === 'error' ? 'red' : level === 'warning' ? 'yellow' : 'green';
    activityFeed.log(`{${color}-fg}[${level.toUpperCase()}]{/} ${message}`);
  }
}

async function refreshStatus() {
  try {
    // Direct API call to bot - this is the source of truth
    const status = await apiRequest('GET', '/status');
    if (status && typeof status === 'object') {
      currentStatus = status;
      lastUpdateTime = Date.now();
      updateDashboard();
    }
  } catch (e) {
    // Don't spam error messages - only show if no recent updates
    if (Date.now() - lastUpdateTime > 10000) {
      activityFeed.log(`{red-fg}⚠️  Connection error - retrying...{/red-fg}`);
      updateOperationalStats();
      screen.render();
    }
  }
}

function updateDashboard() {
  // Update all panels with latest data from currentStatus (source of truth)
  try {
    updateOperationalStats();
    updateMarketPrices();
    updatePositions();
    updateEntrySignals();
    updatePortfolioMetrics();
    updateConfig();
    screen.render();
  } catch (e) {
    activityFeed.log(`{red-fg}⚠️  Display error: ${e.message}{/red-fg}`);
  }
}

async function refreshPM2Stats() {
  try {
    const { execSync } = require('child_process');
    const output = execSync('pm2 jlist', { encoding: 'utf-8', stdio: 'pipe' });
    const processes = JSON.parse(output);
    const bot = processes.find(p => p.name === 'jupiter-perps-bot');
    pm2Stats = bot;
    
    if (bot && bot.pm2_env?.pm_uptime) {
      botStartTime = bot.pm2_env.pm_uptime;
    }
  } catch (e) {
    // PM2 not available, that's okay
  }
}

function updateOperationalStats() {
  // Pull data directly from currentStatus (bot's statusSnapshot)
  const isRunning = pm2Stats?.pm2_env?.status === 'online';
  const botPaused = currentStatus.paused === true;
  
  // Use currentStatus as source of truth (from bot.statusSnapshot())
  const mode = currentStatus.mode || (currentConfig.paperTradingMode ? 'paper' : 'live');
  const execMode = currentStatus.execMode || currentStatus.executionMode || currentConfig.executionMode || 'unknown';
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  // Calculate uptime
  let uptimeStr = 'N/A';
  let stability = 'N/A';
  if (pm2Stats) {
    const pmUptime = pm2Stats.pm2_env?.pm_uptime;
    const restarts = pm2Stats.pm2_env?.restart_time || 0;
    
    // Calculate current session uptime (time since last restart)
    const uptime = pmUptime ? Date.now() - pmUptime : 0;
    
    if (uptime > 0) {
      const hours = Math.floor(uptime / 3600000);
      const minutes = Math.floor((uptime % 3600000) / 60000);
      uptimeStr = `${hours}h ${minutes}m`;
      
      // Stability calculation: judge based on current session uptime
      // Total restarts are cumulative, so we judge stability by how long current session has been running
      const uptimeMinutes = uptime / 60000;
      
      if (restarts === 0) {
        stability = '{green-fg}Perfect{/green-fg}';
      } else if (uptimeMinutes >= 60) {
        // Been running for over an hour - stable despite historical restarts
        stability = '{green-fg}Stable{/green-fg}';
      } else if (uptimeMinutes >= 30) {
        // Been running for 30+ minutes - stable
        stability = '{green-fg}Stable{/green-fg}';
      } else if (uptimeMinutes >= 10) {
        // Been running for 10+ minutes - likely stable now
        stability = '{green-fg}Stable{/green-fg}';
      } else if (uptimeMinutes >= 5) {
        // Been running 5-10 minutes - recovering (was unstable earlier but stabilizing)
        stability = '{yellow-fg}Recovering{/yellow-fg}';
      } else {
        // Just restarted (< 5 minutes) - check if this is a crash loop
        // Critical only if there are MANY restarts AND current session is very short
        if (restarts > 20 && uptimeMinutes < 2) {
          stability = '{red-fg}Critical{/red-fg}';
        } else if (restarts > 10 && uptimeMinutes < 3) {
          stability = '{red-fg}Critical{/red-fg}';
        } else if (restarts > 5) {
          stability = '{yellow-fg}Unstable{/yellow-fg}';
        } else {
          stability = '{yellow-fg}Starting{/yellow-fg}';
        }
      }
    }
  }
  
  // Status indicator with color coding
  let statusIndicator = '';
  let statusColor = 'red';
  let statusText = 'OFFLINE';
  
  if (isRunning) {
    if (botPaused) {
      statusColor = 'yellow';
      statusText = 'PAUSED';
      statusIndicator = '⏸️';
    } else {
      statusColor = 'green';
      statusText = 'RUNNING';
      statusIndicator = '▶️';
    }
  } else {
    statusIndicator = '⏹️';
  }
  
  // WebSocket connection status
  const wsStatus = ws && ws.readyState === WebSocket.OPEN ? '{green-fg}●{/green-fg} Connected' : '{yellow-fg}○{/yellow-fg} Polling';
  
  // Calculate seconds since last update (data freshness indicator)
  const secondsSinceUpdate = Math.floor((Date.now() - lastUpdateTime) / 1000);
  const freshness = secondsSinceUpdate < 3 ? '{green-fg}LIVE{/green-fg}' : 
                    secondsSinceUpdate < 10 ? `{yellow-fg}${secondsSinceUpdate}s ago{/yellow-fg}` : 
                    `{red-fg}${secondsSinceUpdate}s ago{/red-fg}`;
  
  const content = [
    `{bold}Status:{/bold} {${statusColor}-fg}${statusIndicator} ${statusText}{/${statusColor}-fg}  |  {bold}Uptime:{/bold} ${uptimeStr}  |  {bold}Restarts:{/bold} ${pm2Stats?.pm2_env?.restart_time || 0}  |  {bold}Stability:{/bold} ${stability}  |  {bold}Data:{/bold} ${freshness}`,
    ``,
    `{bold}Mode:{/bold} {cyan-fg}${mode.toUpperCase()}{/cyan-fg}  |  {bold}Execution:{/bold} {cyan-fg}${execMode.toUpperCase()}{/cyan-fg}  |  {bold}Node Env:{/bold} {cyan-fg}${nodeEnv.toUpperCase()}{/cyan-fg}  |  {bold}Connection:{/bold} ${wsStatus}`,
    ``,
    `{bold}Positions:{/bold} ${currentStatus.positions || 0}/${currentStatus.posCap || 0}  |  {bold}Daily Trades:{/bold} ${currentStatus.dailyTrades || 0}/${currentStatus.dailyCap || 0}  |  {bold}Equity:{/bold} {green-fg}$${((currentStatus.totalEquity || 0)).toFixed(2)}{/green-fg}`,
  ];
  
  operationalStatsBox.setContent(content.join('\n'));
}

function updateMarketPrices() {
  if (!currentStatus.marketPrices || !currentStatus.markets) {
    marketPricesBox.setData({
      headers: ['Market', 'Price', 'Volume'],
      data: [['Loading...', 'Connecting...', '']],
    });
    return;
  }
  
  const markets = currentStatus.markets || [];
  const data = markets.map(market => {
    const priceData = currentStatus.marketPrices[market];
    if (!priceData) return [market, 'N/A', 'N/A'];
    
    const price = priceData.price || 0;
    const volume = priceData.volume ? `${(priceData.volume / 1000000).toFixed(2)}M` : 'N/A';
    
    return [
      market.padEnd(12),
      `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`,
      `Vol: ${volume}`,
    ];
  });
  
  marketPricesBox.setData({
    headers: ['Market', 'Price', 'Volume'],
    data: data.length > 0 ? data : [['No markets', 'No data', '']],
  });
}

function updatePositions() {
  const positions = currentStatus.openPositions || [];
  
  if (positions.length === 0) {
    positionsBox.setData({
      headers: ['Market', 'Side', 'Entry', 'Unrealized PnL'],
      data: [['No open positions', '', '', '']],
    });
    return;
  }
  
  const data = positions.map(pos => {
    const pnl = pos.unrealizedPnl || 0;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `$${pnl.toFixed(2)}`;
    const pnlColor = pnl >= 0 ? '✓' : '✗';
    
    return [
      (pos.market || 'N/A').padEnd(12),
      (pos.side?.toUpperCase() || 'N/A').padEnd(8),
      `$${(pos.entryPrice || 0).toFixed(2)}`,
      `${pnlColor} ${pnlStr}`,
    ];
  });
  
  positionsBox.setData({
    headers: ['Market', 'Side', 'Entry', 'Unrealized PnL'],
    data: data,
  });
}

function updateEntrySignals() {
  const markets = currentStatus.markets || [];
  const marketPrices = currentStatus.marketPrices || {};
  
  if (markets.length === 0 || Object.keys(marketPrices).length === 0) {
    entrySignalsBox.setData({
      headers: ['Market', 'Status', 'Indicators & Gates'],
      data: [['Loading...', 'Connecting...', 'Waiting for market data...']],
    });
    return;
  }
  
  // Build entry signal data
  const signals = [];
  
  for (const market of markets) {
    const priceData = marketPrices[market];
    if (!priceData) {
      signals.push([
        market.padEnd(12),
        '⏳ Waiting',
        'No price data available',
      ]);
      continue;
    }
    
    // Check if we have strategy indicators
    const hasSignal = priceData.adx !== undefined || priceData.rsi !== undefined;
    
    if (hasSignal) {
      const adx = priceData.adx ? priceData.adx.toFixed(1) : 'N/A';
      const rsi = priceData.rsi ? priceData.rsi.toFixed(1) : 'N/A';
      const atr = priceData.atr ? priceData.atr.toFixed(4) : 'N/A';
      
      // Determine signal status
      let signalStatus = '✓ Monitoring';
      let detailsStr = `ADX:${adx} RSI:${rsi} ATR:${atr}`;
      
      // Check if we have gate blocking stats
      const gateKey = `${market}_long`;
      if (gateBlockingStats[gateKey]) {
        const topGate = Object.entries(gateBlockingStats[gateKey])
          .sort((a, b) => b[1] - a[1])[0];
        if (topGate && topGate[1] > 5) {
          detailsStr += ` | Blocked: ${topGate[0]}`;
          signalStatus = '❌ Blocked';
        }
      }
      
      signals.push([
        market.padEnd(12),
        signalStatus,
        detailsStr,
      ]);
    } else {
      signals.push([
        market.padEnd(12),
        '⏳ Warming',
        'Strategy indicators initializing...',
      ]);
    }
  }
  
  if (signals.length === 0) {
    signals.push(['No markets', 'N/A', 'No trading markets configured']);
  }
  
  entrySignalsBox.setData({
    headers: ['Market', 'Status', 'Indicators & Gates'],
    data: signals,
  });
}

function updatePortfolioMetrics() {
  const portfolio = currentStatus.portfolio || {};
  const freeCapital = currentStatus.freeCapital !== undefined ? currentStatus.freeCapital : (currentStatus.balance || 0);
  const lockedCapital = currentStatus.lockedCapital || 0;
  const totalEquity = currentStatus.totalEquity || (freeCapital + lockedCapital);
  
  const content = [
    `{bold}Capital Management:{/bold}`,
    `  Available (Free):     ${formatCurrency(freeCapital).padStart(12)}    Locked in Positions:  ${formatCurrency(lockedCapital).padStart(12)}    Total Equity:         ${formatCurrency(totalEquity).padStart(12)}`,
    ``,
    `{bold}Risk & Exposure:{/bold}`,
    `  Total Exposure:       ${formatCurrency(portfolio.totalExposure || 0).padStart(12)}    Portfolio Leverage:   ${((portfolio.totalLeverage || 0).toFixed(2) + 'x').padStart(12)}`,
    `  Max Pos:   ${currentStatus.posCap || 0}`,
    `  Max Lever: ${(portfolio.maxLeverage || 0).toFixed(2)}x`,
    ``,
    `{bold}Performance:{/bold}`,
    `  Win Rate:  ${(portfolio.winRate || 0).toFixed(1)}%`,
    `  Avg PnL:   ${formatCurrency(portfolio.avgPnL || 0)}`,
    `  Total Trades: ${portfolio.totalTrades || 0}`,
  ];
  
  portfolioBox.setContent(content.join('\n'));
}

async function refreshConfig() {
  try {
    const config = await apiRequest('GET', '/config');
    currentConfig = config;
    updateConfig();
  } catch (e) {
    // Config might not be available, that's okay
  }
}

function updateConfig() {
  const risk = currentConfig.risk || {};
  const leverage = currentConfig.leverage || {};
  const strategy = currentConfig.strategy || {};
  
  // Environment info
  const nodeEnv = process.env.NODE_ENV || 'development';
  const tradingMode = currentConfig.paperTradingMode ? 'paper' : 'live';
  const execMode = currentConfig.executionMode || currentStatus.execMode || 'unknown';
  
  // Determine sizing method - check actual config values from API
  let sizingMethod = risk.sizingMethod || risk.forceSizingMethod;
  if (!sizingMethod) {
    sizingMethod = 'equal-risk'; // Default fallback
  }
  
  const riskPerTrade = risk.riskPerTradePercent || 0;
  const positionSizePercent = risk.positionSizePercent || null;
  
  // Leverage info
  const leverageType = leverage.dynamic ? 'Dynamic' : 'Static';
  const leverageRange = leverage.minLeverage && leverage.maxLeverage 
    ? `${leverage.minLeverage}x-${leverage.maxLeverage}x`
    : leverage.baseLeverage 
      ? `${leverage.baseLeverage}x`
      : leverage.long
        ? `${leverage.long}x`
        : 'N/A';
  
  // Strategy type
  const strategyType = 'Enhanced Momentum';
  
  // Markets
  const markets = currentConfig.markets || currentStatus.markets || [];
  const marketsStr = markets.length > 0 ? markets.join(', ') : 'N/A';
  
  // Show sizing details based on method
  let sizingDetails = ` Method: ${sizingMethod}`;
  if (sizingMethod === 'percent' && positionSizePercent) {
    sizingDetails += `\n Size: ${positionSizePercent}%`;
  } else if (riskPerTrade > 0) {
    sizingDetails += `\n Risk/Trade: ${riskPerTrade}%`;
  }
  
  const content = [
    `{bold}Environment:{/bold}`,
    ` Node Env: ${nodeEnv}`,
    ` Trading: ${tradingMode}`,
    ` Execution: ${execMode}`,
    ``,
    `{bold}Sizing:{/bold}`,
    sizingDetails,
    ``,
    `{bold}Leverage:{/bold}`,
    ` Type: ${leverageType}`,
    ` Range: ${leverageRange}`,
    ``,
    `{bold}Strategy:{/bold}`,
    ` Type: ${strategyType}`,
    ` Markets: ${marketsStr.substring(0, 25)}${marketsStr.length > 25 ? '...' : ''}`,
    ``,
    `{bold}Limits:{/bold}`,
    ` Max Pos: ${currentConfig.maxOpenPositions || risk.maxPositions || 'N/A'}`,
    ` Daily Trades: ${currentConfig.dailyTradeLimit || 'N/A'}`,
  ];
  
  configBox.setContent(content.join('\n'));
}

function updateCommandsMenu() {
  const commands = [
    '{bold}Commands:{/bold}',
    '  {yellow-fg}[1]{/} Start Bot    {yellow-fg}[2]{/} Stop Bot    {yellow-fg}[3]{/} Restart',
    '  {yellow-fg}[4]{/} Pause        {yellow-fg}[5]{/} Resume      {yellow-fg}[6]{/} Close All',
    '  {yellow-fg}[7]{/} Refresh      {yellow-fg}[8] or [h]{/} Help    {yellow-fg}[q]{/} Quit',
  ];
  
  commandsBox.setContent(commands.join('\n'));
}

function formatCurrency(value) {
  const sign = value >= 0 ? '' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function updateGateStats() {
  // This would need to be implemented by adding gate tracking to the bot
  // For now, we'll parse activity feed for gate blocking messages
  // In a real implementation, the bot should send gate blocking events
}

// API helpers
function apiRequest(method, endpoint, data = null) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${endpoint}`;
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;
    
    // Add API key authentication for remote connections
    const apiKey = process.env.API_KEY || process.env.DASHBOARD_API_KEY;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && isRemoteConnection) {
      headers['X-API-Key'] = apiKey;
      // Also add to query string as fallback
      if (!parsedUrl.search) {
        parsedUrl.search = `?apiKey=${encodeURIComponent(apiKey)}`;
      } else {
        parsedUrl.search += `&apiKey=${encodeURIComponent(apiKey)}`;
      }
    }
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers,
    };

    const req = requestModule.request(options, (res) => {
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

    req.on('error', (err) => {
      // Silent reject for connection errors - don't spam logs
      reject(err);
    });
    
    // Set timeout
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function pauseBot() {
  try {
    await apiRequest('POST', '/pause');
    activityFeed.log('{yellow-fg}⏸️ Bot paused{/}');
  } catch (e) {
    activityFeed.log(`{red-fg}❌ Failed to pause: ${e.message}{/}`);
  }
}

async function resumeBot() {
  try {
    await apiRequest('POST', '/resume');
    activityFeed.log('{green-fg}▶️ Bot resumed{/}');
  } catch (e) {
    activityFeed.log(`{red-fg}❌ Failed to resume: ${e.message}{/}`);
  }
}

async function closeAllPositions() {
  activityFeed.log('{yellow-fg}⚠️ Closing all positions...{/}');
  try {
    await apiRequest('POST', '/closeall');
    activityFeed.log('{green-fg}✅ All positions closed{/}');
  } catch (e) {
    activityFeed.log(`{red-fg}❌ Failed to close positions: ${e.message}{/}`);
  }
}

async function startBot() {
  if (isRemoteConnection) {
    activityFeed.log('{yellow-fg}⚠️  Cannot start bot: Connected to remote instance. Use Render Dashboard to start the bot.{/}');
    return;
  }
  activityFeed.log('{yellow-fg}🚀 Starting bot...{/}');
  try {
    const { execSync } = require('child_process');
    execSync('pm2 start jupiter-perps-bot', { stdio: 'pipe' });
    activityFeed.log('{green-fg}✅ Bot started{/}');
    setTimeout(refreshStatus, 2000);
  } catch (e) {
    activityFeed.log(`{red-fg}❌ Failed to start: ${e.message}{/}`);
  }
}

async function stopBot() {
  if (isRemoteConnection) {
    activityFeed.log('{yellow-fg}⚠️  Cannot stop bot: Connected to remote instance. Use Render Dashboard to stop the bot.{/}');
    return;
  }
  activityFeed.log('{yellow-fg}🛑 Stopping bot...{/}');
  try {
    const { execSync } = require('child_process');
    execSync('pm2 stop jupiter-perps-bot', { stdio: 'pipe' });
    activityFeed.log('{green-fg}✅ Bot stopped{/}');
    setTimeout(refreshStatus, 2000);
  } catch (e) {
    activityFeed.log(`{red-fg}❌ Failed to stop: ${e.message}{/}`);
  }
}

async function restartBot() {
  if (isRemoteConnection) {
    // Try to use the API endpoint if available
    try {
      activityFeed.log('{yellow-fg}🔄 Restarting bot via API...{/}');
      await apiRequest('POST', '/render/restart-bot');
      activityFeed.log('{green-fg}✅ Bot restart triggered{/}');
      setTimeout(refreshStatus, 2000);
    } catch (e) {
      activityFeed.log('{yellow-fg}⚠️  Cannot restart bot: Connected to remote instance. Use Render Dashboard to restart the bot.{/}');
    }
    return;
  }
  activityFeed.log('{yellow-fg}🔄 Restarting bot...{/}');
  try {
    const { execSync } = require('child_process');
    execSync('pm2 restart jupiter-perps-bot', { stdio: 'pipe' });
    activityFeed.log('{green-fg}✅ Bot restarted{/}');
    setTimeout(refreshStatus, 2000);
  } catch (e) {
    activityFeed.log(`{red-fg}❌ Failed to restart: ${e.message}{/}`);
  }
}

function showHelp() {
  const helpText = [
    '{bold}Jupiter Perps Bot Dashboard Help{/bold}',
    '',
    '{bold}Commands:{/bold}',
    '  [1] Start Bot - Start the bot via PM2',
    '  [2] Stop Bot - Stop the bot via PM2',
    '  [3] Restart Bot - Restart the bot via PM2',
    '  [4] Pause Trading - Pause trading (no new positions)',
    '  [5] Resume Trading - Resume trading',
    '  [6] Close All Positions - Close all open positions',
    '  [7] Refresh Status - Manually refresh bot status',
    '  [8] or [h] Show Help - Display this help',
    '  [q] Quit - Exit dashboard',
    '',
    '{bold}Keyboard Shortcuts:{/bold}',
    '  [p] Pause trading',
    '  [r] Resume trading',
    '  [c] Close all positions',
    '  [s] Refresh status',
    '',
    '{bold}Display Sections:{/bold}',
    '  - Market Prices: Real-time prices for all markets',
    '  - Open Positions: Current positions with PnL',
    '  - Entry Signals: Current signal status and gate blocking',
    '  - Portfolio Metrics: Risk and performance metrics',
    '  - Key Configuration: Active bot settings',
    '  - Activity Feed: Real-time bot events',
    '',
    'Press any key to close...',
  ];
  
  const helpBox = blessed.box({
    top: 'center',
    left: 'center',
    width: '80%',
    height: '80%',
    content: helpText.join('\n'),
    tags: true,
    border: { type: 'line' },
    style: {
      fg: 'white',
      bg: 'blue',
      border: { fg: 'yellow' },
    },
    keys: true,
    vi: true,
  });
  
  screen.append(helpBox);
  helpBox.focus();
  
  helpBox.key(['escape', 'q', 'enter', 'space'], () => {
    screen.remove(helpBox);
    screen.render();
  });
  
  screen.render();
}

// Start dashboard
screen.render();

