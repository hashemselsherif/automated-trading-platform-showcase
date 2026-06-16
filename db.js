// db.js
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

// Support configurable DB path for Render persistent disk
// Set DATABASE_PATH=/data/trades.sqlite when using Render disk mount
const DB_PATH = process.env.DATABASE_PATH 
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(process.cwd(), 'logs', 'trades.sqlite');

// Log DB path on startup for debugging
console.log(`📦 [DB] Using database path: ${DB_PATH}`);

function connect() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades_open (
      id TEXT PRIMARY KEY,
      client_order_id TEXT,
      ts INTEGER,
      side TEXT,
      entry REAL,
      collateral REAL,
      leverage REAL,
      size REAL
    );
    CREATE TABLE IF NOT EXISTS trades_close (
      id TEXT,
      client_order_id TEXT,
      ts INTEGER,
      exit REAL,
      pnl REAL,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS order_guard (
      client_order_id TEXT PRIMARY KEY,
      ts INTEGER
    );
    /* Analytics tables */
    CREATE TABLE IF NOT EXISTS gate_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      market TEXT,
      side TEXT,
      reason TEXT,
      price REAL,
      adx REAL,
      atr REAL,
      rsi REAL,
      tick INTEGER,
      context TEXT
    );
    CREATE TABLE IF NOT EXISTS allocator_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      market TEXT,
      side TEXT,
      confidence REAL,
      score REAL,
      selected INTEGER,
      reason TEXT,
      price REAL,
      adx REAL,
      atr REAL,
      rsi REAL,
      positions_in_market INTEGER,
      max_positions INTEGER,
      available_slots INTEGER,
      portfolio_exposure REAL,
      signals_count INTEGER
    );
    /* Market data table for OHLCV candles */
    CREATE TABLE IF NOT EXISTS market_data (
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      open_time INTEGER NOT NULL,
      close_time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      base_volume REAL,
      quote_volume REAL,
      trade_count INTEGER,
      taker_base_volume REAL,
      taker_quote_volume REAL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      PRIMARY KEY (symbol, interval, close_time)
    );
    CREATE INDEX IF NOT EXISTS market_data_symbol_interval_time_idx 
      ON market_data(symbol, interval, close_time);
    /* Bot instance lock table - prevents multiple instances from running */
    CREATE TABLE IF NOT EXISTS bot_instances (
      instance_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      hostname TEXT,
      started_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL,
      environment TEXT
    );
    CREATE INDEX IF NOT EXISTS bot_instances_last_heartbeat_idx 
      ON bot_instances(last_heartbeat);
    CREATE TABLE IF NOT EXISTS copy_topk_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      topk_count INTEGER,
      top_wallet TEXT,
      top_wallet_weight REAL,
      top_wallets_json TEXT,
      topk_json TEXT,
      weights_json TEXT,
      elite_json TEXT,
      overrides_json TEXT,
      snapshot_file TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS copy_topk_snapshots_ts_idx
      ON copy_topk_snapshots(ts);
  `);

  const ensureColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
    }
  };

  try {
    ensureColumn('trades_open', 'client_order_id', 'TEXT');
    ensureColumn('trades_close', 'client_order_id', 'TEXT');
    // Add market column for multi-market support
    ensureColumn('trades_open', 'market', 'TEXT');
    ensureColumn('trades_close', 'market', 'TEXT');
    // Add mode column for live/paper tracking
    ensureColumn('trades_open', 'mode', 'TEXT');
    ensureColumn('trades_close', 'mode', 'TEXT');
    // Add trade_type column for automated/manual tracking
    ensureColumn('trades_open', 'trade_type', 'TEXT DEFAULT "automated"');
    ensureColumn('trades_close', 'trade_type', 'TEXT');
    // Add environment tracking (local/render/test)
    ensureColumn('trades_open', 'environment', 'TEXT');
    ensureColumn('trades_close', 'environment', 'TEXT');
    // Add instance ID for multi-instance tracking
    ensureColumn('trades_open', 'instance_id', 'TEXT');
    ensureColumn('trades_close', 'instance_id', 'TEXT');
    // Add venue tracking (jupiter/drift)
    ensureColumn('trades_open', 'venue', 'TEXT');
    ensureColumn('trades_close', 'venue', 'TEXT');
    // Add strategy type tracking
    ensureColumn('trades_open', 'strategy_type', 'TEXT');
    ensureColumn('trades_close', 'strategy_type', 'TEXT');
    // Add standardized timestamps
    ensureColumn('trades_open', 'created_at', 'INTEGER');
    ensureColumn('trades_open', 'updated_at', 'INTEGER');
    ensureColumn('trades_close', 'created_at', 'INTEGER');
    ensureColumn('order_guard', 'created_at', 'INTEGER');
    ensureColumn('gate_events', 'created_at', 'INTEGER');
    ensureColumn('allocator_decisions', 'created_at', 'INTEGER');
    // Add PnL columns for better data tracking
    ensureColumn('trades_close', 'pnl_percent', 'REAL');
    ensureColumn('trades_close', 'pnl_usd', 'REAL');
    // Add status column for tracking pending/filled maker orders
    // pending = limit order placed but not filled, filled = order filled
    ensureColumn('trades_open', 'status', 'TEXT DEFAULT "filled"');
    
    // Add analytics columns on gate_events (idempotent)
    ensureColumn('gate_events', 'long_ok', 'INTEGER');
    ensureColumn('gate_events', 'short_ok', 'INTEGER');
    ensureColumn('gate_events', 'above_ma', 'INTEGER');
    ensureColumn('gate_events', 'below_ma', 'INTEGER');
    ensureColumn('gate_events', 'adx_ok', 'INTEGER');
    ensureColumn('gate_events', 'time_gate_ok', 'INTEGER');
    ensureColumn('gate_events', 'cooldown_ok_long', 'INTEGER');
    ensureColumn('gate_events', 'cooldown_ok_short', 'INTEGER');
    ensureColumn('gate_events', 'don_break_up', 'INTEGER');
    ensureColumn('gate_events', 'don_break_dn', 'INTEGER');
    ensureColumn('copy_topk_snapshots', 'topk_count', 'INTEGER');
    ensureColumn('copy_topk_snapshots', 'top_wallet', 'TEXT');
    ensureColumn('copy_topk_snapshots', 'top_wallet_weight', 'REAL');
    ensureColumn('copy_topk_snapshots', 'top_wallets_json', 'TEXT');
    ensureColumn('copy_topk_snapshots', 'topk_json', 'TEXT');
    ensureColumn('copy_topk_snapshots', 'weights_json', 'TEXT');
    ensureColumn('copy_topk_snapshots', 'elite_json', 'TEXT');
    ensureColumn('copy_topk_snapshots', 'overrides_json', 'TEXT');
    ensureColumn('copy_topk_snapshots', 'snapshot_file', 'TEXT');
    ensureColumn('copy_topk_snapshots', 'created_at', 'INTEGER');
  } catch (e) {
    console.warn('⚠️  DB schema migration warning:', e.message);
  }

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS trades_open_client_order_id_idx ON trades_open(client_order_id);`);

  return db;
}

const db = connect();

module.exports = {
  reserveOrder(clientOrderId) {
    if (!clientOrderId) return false;
    try {
      const now = Date.now();
      // Insert created_at if column exists
      const cols = db.prepare(`PRAGMA table_info(order_guard)`).all();
      const hasCreatedAt = cols.some((c) => c.name === 'created_at');
      if (hasCreatedAt) {
        db.prepare(`INSERT INTO order_guard (client_order_id, ts, created_at) VALUES (?, ?, ?)`)
          .run(clientOrderId, now, now);
      } else {
        db.prepare(`INSERT INTO order_guard (client_order_id, ts) VALUES (?, ?)`)
          .run(clientOrderId, now);
      }
      return true;
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
      throw err;
    }
  },
  releaseOrder(clientOrderId) {
    if (!clientOrderId) return;
    db.prepare(`DELETE FROM order_guard WHERE client_order_id = ?`).run(clientOrderId);
  },
  logOpen(p) {
    const now = Date.now();
    const payload = {
      id: p.positionId,
      client_order_id: p.clientOrderId || null,
      ts: p.openTime || now,
      side: p.side,
      entry: p.entryPrice,
      collateral: p.collateral,
      leverage: p.leverage,
      size: p.size,
      market: p.market || null,
      mode: p.mode || null, // 'live' or 'paper'
      trade_type: p.trade_type || p.tradeType || 'automated', // 'automated' or 'manual'
      environment: p.environment || null, // 'local', 'render', 'test'
      instance_id: p.instance_id || null, // Unique instance identifier
      venue: p.venue || null, // 'jupiter' or 'drift'
      strategy_type: p.strategyType || p.strategy_type || null, // e.g. 'momentum', 'rsi-reversion'
      status: p.status || 'filled', // 'pending' for unfilled maker orders, 'filled' for completed
      created_at: now,
      updated_at: now,
    };

    // Check which columns exist (for backwards compatibility)
    const cols = db.prepare(`PRAGMA table_info(trades_open)`).all();
    const hasMarket = cols.some((c) => c.name === 'market');
    const hasMode = cols.some((c) => c.name === 'mode');
    const hasTradeType = cols.some((c) => c.name === 'trade_type');
    const hasEnvironment = cols.some((c) => c.name === 'environment');
    const hasInstanceId = cols.some((c) => c.name === 'instance_id');
    const hasStatus = cols.some((c) => c.name === 'status');

    // Build dynamic SQL based on available columns
    const columns = ['id', 'client_order_id', 'ts', 'side', 'entry', 'collateral', 'leverage', 'size', 'created_at', 'updated_at'];
    const placeholders = columns.map(c => `@${c}`);
    
    if (hasMarket) {
      columns.splice(8, 0, 'market');
      placeholders.splice(8, 0, '@market');
    }
    if (hasMode) {
      columns.splice(hasMarket ? 9 : 8, 0, 'mode');
      placeholders.splice(hasMarket ? 9 : 8, 0, '@mode');
    }
    if (hasTradeType) {
      columns.push('trade_type');
      placeholders.push('@trade_type');
    }
    if (hasEnvironment) {
      columns.push('environment');
      placeholders.push('@environment');
    }
    if (hasInstanceId) {
      columns.push('instance_id');
      placeholders.push('@instance_id');
    }
    if (hasStatus) {
      columns.push('status');
      placeholders.push('@status');
    }
    
    const updateColumns = columns.filter(c => c !== 'id' && c !== 'created_at');
    const updateSet = updateColumns.map(c => `${c} = excluded.${c}`).join(', ');
    
    const sql = `
      INSERT INTO trades_open (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${updateSet}
    `;
    
    db.prepare(sql).run(payload);
  },
  
  /**
   * Remove an open position from trades_open (for cleanup of pre-registered positions that failed)
   * @param {string} positionId - The position ID to remove
   */
  removeOpen(positionId) {
    if (!positionId) return;
    try {
      db.prepare(`DELETE FROM trades_open WHERE id = ?`).run(positionId);
    } catch (err) {
      console.warn(`⚠️  Failed to remove open position ${positionId}: ${err.message}`);
    }
  },
  
  /**
   * Update an existing open position in trades_open
   * @param {string} positionId - The position ID to update
   * @param {Object} updates - Object with fields to update (trade_type, entry, size, status, etc.)
   */
  updateOpen(positionId, updates) {
    if (!positionId || !updates || Object.keys(updates).length === 0) return;
    
    try {
      const now = Date.now();
      // status column added to track pending/filled state for maker orders
      const validColumns = ['trade_type', 'entry', 'size', 'collateral', 'leverage', 'side', 'market', 'mode', 'client_order_id', 'status'];
      const setClauses = [];
      const values = [];
      
      for (const [key, value] of Object.entries(updates)) {
        // Map JS property names to DB column names
        const columnMap = {
          'entryPrice': 'entry',
          'clientOrderId': 'client_order_id',
          'tradeType': 'trade_type',
        };
        const column = columnMap[key] || key;
        
        if (validColumns.includes(column) && value !== undefined) {
          setClauses.push(`${column} = ?`);
          values.push(value);
        }
      }
      
      if (setClauses.length === 0) return;
      
      // Always update updated_at
      setClauses.push('updated_at = ?');
      values.push(now);
      
      // Add positionId for WHERE clause
      values.push(positionId);
      
      const sql = `UPDATE trades_open SET ${setClauses.join(', ')} WHERE id = ?`;
      const result = db.prepare(sql).run(...values);
      
      if (result.changes > 0) {
        console.log(`📝 [DB] Updated position ${positionId.slice(0, 8)}...: ${Object.keys(updates).join(', ')}`);
      }
    } catch (err) {
      console.warn(`⚠️  Failed to update open position ${positionId}: ${err.message}`);
    }
  },
  
  logClose(p, exit, pnl, reason) {
    const ts = Date.now();
    const createdAt = ts;
    const market = p.market || null;
    const mode = p.mode || null; // 'live' or 'paper'
    const trade_type = p.trade_type || p.tradeType || 'automated'; // 'automated' or 'manual'
    const venue = p.venue || null; // 'jupiter' or 'drift'
    const strategy_type = p.strategyType || p.strategy_type || null; // e.g. 'momentum', 'rsi-reversion'
    
    // Check which columns exist (for backwards compatibility)
    const cols = db.prepare(`PRAGMA table_info(trades_close)`).all();
    const hasMarket = cols.some((c) => c.name === 'market');
    const hasMode = cols.some((c) => c.name === 'mode');
    const hasTradeType = cols.some((c) => c.name === 'trade_type');
    const hasVenue = cols.some((c) => c.name === 'venue');
    const hasStrategyType = cols.some((c) => c.name === 'strategy_type');
    const hasCreatedAt = cols.some((c) => c.name === 'created_at');
    const hasPnLPercent = cols.some((c) => c.name === 'pnl_percent');
    const hasPnLUSD = cols.some((c) => c.name === 'pnl_usd');
    
    // pnl parameter is now always percentage (from bot.js conversion)
    // p.pnlUSD contains the USD value if available (for storing in pnl_usd column)
    let pnlPercent = pnl; // Primary: percentage
    let pnlUSD = p.pnlUSD; // Optional: USD value
    
    // If pnlUSD not provided but we have collateral, calculate from percentage
    if (!Number.isFinite(pnlUSD) && p.collateral && Number.isFinite(p.collateral) && p.collateral > 0) {
      pnlUSD = (pnlPercent / 100) * p.collateral;
    }
    
    // For backward compatibility, store in pnl column as percentage (primary format)
    const pnlToStore = pnlPercent;
    
    // Build column lists based on available columns
    const baseCols = ['id', 'client_order_id', 'ts', 'exit', 'pnl', 'reason'];
    const baseVals = [p.positionId, p.clientOrderId || null, ts, exit, pnlToStore, reason || null];
    
    if (hasMarket) {
      baseCols.push('market');
      baseVals.push(market);
    }
    if (hasMode) {
      baseCols.push('mode');
      baseVals.push(mode);
    }
    if (hasTradeType) {
      baseCols.push('trade_type');
      baseVals.push(trade_type);
    }
    if (hasVenue) {
      baseCols.push('venue');
      baseVals.push(venue);
    }
    if (hasStrategyType) {
      baseCols.push('strategy_type');
      baseVals.push(strategy_type);
    }
    if (hasCreatedAt) {
      baseCols.push('created_at');
      baseVals.push(createdAt);
    }
    if (hasPnLPercent) {
      baseCols.push('pnl_percent');
      baseVals.push(pnlPercent);
    }
    if (hasPnLUSD) {
      baseCols.push('pnl_usd');
      baseVals.push(pnlUSD);
    }
    
    const placeholders = baseCols.map(() => '?').join(',');
    const sql = `INSERT INTO trades_close (${baseCols.join(', ')}) VALUES (${placeholders})`;
    db.prepare(sql).run(...baseVals);
    db.prepare(`DELETE FROM trades_open WHERE id=?`).run(p.positionId);
  },
  // --------------------------------------------------------------------------
  // Analytics logging
  // --------------------------------------------------------------------------
  logGateEvent(event) {
    try {
      const stmt = db.prepare(`
        INSERT INTO gate_events (
          ts, market, side, reason, price, adx, atr, rsi, tick, context,
          long_ok, short_ok, above_ma, below_ma, adx_ok, time_gate_ok,
          cooldown_ok_long, cooldown_ok_short, don_break_up, don_break_dn,
          created_at
        ) VALUES (
          @ts, @market, @side, @reason, @price, @adx, @atr, @rsi, @tick, @context,
          @long_ok, @short_ok, @above_ma, @below_ma, @adx_ok, @time_gate_ok,
          @cooldown_ok_long, @cooldown_ok_short, @don_break_up, @don_break_dn,
          @created_at
        )
      `);
      const payload = {
        ts: event.ts || Date.now(),
        market: event.market || null,
        side: event.side || null,
        reason: event.reason || null,
        price: Number.isFinite(event.price) ? event.price : null,
        adx: Number.isFinite(event.adx) ? event.adx : null,
        atr: Number.isFinite(event.atr) ? event.atr : null,
        rsi: Number.isFinite(event.rsi) ? event.rsi : null,
        tick: Number.isFinite(event.tick) ? event.tick : null,
        context: event.context ? JSON.stringify(event.context) : null,
        long_ok: event.long_ok ? 1 : 0,
        short_ok: event.short_ok ? 1 : 0,
        above_ma: event.above_ma ? 1 : 0,
        below_ma: event.below_ma ? 1 : 0,
        adx_ok: event.adx_ok ? 1 : 0,
        time_gate_ok: event.time_gate_ok ? 1 : 0,
        cooldown_ok_long: event.cooldown_ok_long ? 1 : 0,
        cooldown_ok_short: event.cooldown_ok_short ? 1 : 0,
        don_break_up: event.don_break_up ? 1 : 0,
        don_break_dn: event.don_break_dn ? 1 : 0,
        created_at: Date.now(),
      };
      stmt.run(payload);
    } catch (e) {
      console.warn('⚠️  Failed to log gate event:', e.message);
    }
  },
  logAllocatorDecision(decision) {
    try {
      const stmt = db.prepare(`
        INSERT INTO allocator_decisions (
          ts, market, side, confidence, score, selected, reason,
          price, adx, atr, rsi,
          positions_in_market, max_positions, available_slots, portfolio_exposure, signals_count,
          created_at
        ) VALUES (
          @ts, @market, @side, @confidence, @score, @selected, @reason,
          @price, @adx, @atr, @rsi,
          @positions_in_market, @max_positions, @available_slots, @portfolio_exposure, @signals_count,
          @created_at
        )
      `);
      const payload = {
        ts: decision.ts || Date.now(),
        market: decision.market || null,
        side: decision.side || null,
        confidence: Number.isFinite(decision.confidence) ? decision.confidence : null,
        score: Number.isFinite(decision.score) ? decision.score : null,
        selected: decision.selected ? 1 : 0,
        reason: decision.reason || null,
        price: Number.isFinite(decision.price) ? decision.price : null,
        adx: Number.isFinite(decision.adx) ? decision.adx : null,
        atr: Number.isFinite(decision.atr) ? decision.atr : null,
        rsi: Number.isFinite(decision.rsi) ? decision.rsi : null,
        positions_in_market: Number.isFinite(decision.positions_in_market) ? decision.positions_in_market : null,
        max_positions: Number.isFinite(decision.max_positions) ? decision.max_positions : null,
        available_slots: Number.isFinite(decision.available_slots) ? decision.available_slots : null,
        portfolio_exposure: Number.isFinite(decision.portfolio_exposure) ? decision.portfolio_exposure : null,
        signals_count: Number.isFinite(decision.signals_count) ? decision.signals_count : null,
        created_at: Date.now(),
      };
      stmt.run(payload);
    } catch (e) {
      console.warn('⚠️  Failed to log allocator decision:', e.message);
    }
  },
  logCopyTopKSnapshot(snapshot = {}) {
    try {
      const ts = Number.isFinite(snapshot.ts) ? snapshot.ts : Date.now();
      const payload = {
        ts,
        topk_count: Number.isFinite(snapshot.topkCount) ? snapshot.topkCount : null,
        top_wallet: snapshot.topWallet || null,
        top_wallet_weight: Number.isFinite(snapshot.topWalletWeight) ? snapshot.topWalletWeight : null,
        top_wallets_json: snapshot.topWalletsJson || null,
        topk_json: snapshot.topkJson || null,
        weights_json: snapshot.weightsJson || null,
        elite_json: snapshot.eliteJson || null,
        overrides_json: snapshot.overridesJson || null,
        snapshot_file: snapshot.snapshotFile || null,
        created_at: ts,
      };
      const stmt = db.prepare(`
        INSERT INTO copy_topk_snapshots (
          ts,
          topk_count,
          top_wallet,
          top_wallet_weight,
          top_wallets_json,
          topk_json,
          weights_json,
          elite_json,
          overrides_json,
          snapshot_file,
          created_at
        ) VALUES (
          @ts,
          @topk_count,
          @top_wallet,
          @top_wallet_weight,
          @top_wallets_json,
          @topk_json,
          @weights_json,
          @elite_json,
          @overrides_json,
          @snapshot_file,
          @created_at
        )
      `);
      stmt.run(payload);
    } catch (e) {
      console.warn('⚠️  Failed to log copy topk snapshot:', e.message);
    }
  },
  listOpen() {
    return db.prepare(`SELECT * FROM trades_open ORDER BY ts DESC`).all();
  },
  listOpenSince(sinceMs) {
    return db.prepare(`SELECT * FROM trades_open WHERE ts >= ? ORDER BY ts ASC`).all(sinceMs);
  },
  listClosed(limit = 100) {
    return db.prepare(`SELECT * FROM trades_close ORDER BY ts DESC LIMIT ?`).all(limit);
  },
  listClosedSince(sinceMs) {
    return db.prepare(`SELECT * FROM trades_close WHERE ts >= ? ORDER BY ts ASC`).all(sinceMs);
  },
  summarizePnL(sinceMs = Date.now() - 86400000) {
    // For historical compatibility, we need to normalize PnL values
    // Use a query that checks if we can normalize based on collateral
    const cols = db.prepare(`PRAGMA table_info(trades_close)`).all();
    const hasPnLPercent = cols.some((c) => c.name === 'pnl_percent');
    
    if (hasPnLPercent) {
      // New format: prefer pnl_percent column
      const row = db.prepare(`
        SELECT COALESCE(SUM(COALESCE(c.pnl_percent, c.pnl)), 0) AS pnl
        FROM trades_close c
        LEFT JOIN trades_open o ON c.id = o.id
        WHERE c.ts >= ?
      `).get(sinceMs);
      return row?.pnl || 0;
    } else {
      // Legacy format: try to normalize using collateral if available
      // For now, return raw value and let caller handle normalization if needed
      const row = db.prepare(`SELECT COALESCE(SUM(pnl),0) AS pnl FROM trades_close WHERE ts >= ?`).get(sinceMs);
      return row?.pnl || 0;
    }
  },
  
  // ============================================================================
  // Query Helpers - Easy methods for common queries
  // ============================================================================
  
  /**
   * Normalize PnL value from database to percentage format
   * Historical data may be stored as USD, so we need to convert it
   * @param {number} pnl - PnL value from database
   * @param {number} collateral - Position collateral (for conversion)
   * @param {boolean} hasPnLPercent - Whether pnl_percent column exists and has value
   * @param {number} pnlPercent - Value from pnl_percent column if available
   * @returns {number} Normalized PnL as percentage
   */
  normalizePnLToPercent(pnl, collateral, hasPnLPercent = false, pnlPercent = null) {
    // If pnl_percent column exists and has a value, use it (new format)
    if (hasPnLPercent && Number.isFinite(pnlPercent)) {
      return pnlPercent;
    }
    
    // Check if pnl is already in percentage format (heuristic)
    // Percentage values are typically between -200% and +200% (allowing for high leverage)
    // USD values depend on collateral size
    const pnlAbs = Math.abs(pnl);
    const collateralAbs = Math.abs(collateral) || 1; // Avoid division by zero
    
    // Heuristic: If |pnl| > |collateral| * 3, it's likely already percentage
    // Otherwise, assume it's USD and convert
    if (pnlAbs > collateralAbs * 3 || pnlAbs === 0) {
      // Already percentage or zero
      return pnl;
    } else {
      // Likely USD, convert to percentage
      return (pnl / collateralAbs) * 100;
    }
  },
  
  /**
   * Get all closed trades with full details (joined open + close data)
   * @param {Object} options - Query options
   * @param {number} options.limit - Maximum number of results
   * @param {number} options.offset - Offset for pagination
   * @param {number} options.sinceMs - Only return trades since this timestamp
   * @param {string} options.market - Filter by market
   * @param {string} options.side - Filter by side (long/short)
   * @param {string} options.mode - Filter by mode ('live' or 'paper')
   * @param {string} options.orderBy - Order by field (ts, pnl, entry, exit)
   * @param {string} options.orderDir - Order direction (ASC/DESC)
   * @returns {Array} Array of trade objects
   */
  getClosedTrades(options = {}) {
    const {
      limit = 1000,
      offset = 0,
      sinceMs = null,
      market = null,
      side = null,
      mode = null,
      orderBy = 'ts',
      orderDir = 'DESC',
    } = options;
    
    // Check if pnl_percent column exists
    const cols = db.prepare(`PRAGMA table_info(trades_close)`).all();
    const hasPnLPercent = cols.some((c) => c.name === 'pnl_percent');
    
    let query = `
      SELECT 
        o.id,
        o.client_order_id,
        o.ts AS open_ts,
        c.ts AS close_ts,
        o.side,
        o.entry,
        c.exit,
        o.collateral,
        o.leverage,
        o.size,
        c.pnl,
        ${hasPnLPercent ? 'c.pnl_percent,' : ''}
        c.reason,
        o.market,
        COALESCE(o.mode, c.mode, 'unknown') AS mode
      FROM trades_close c
      INNER JOIN trades_open o ON c.id = o.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (sinceMs) {
      query += ` AND c.ts >= ?`;
      params.push(sinceMs);
    }
    
    if (market) {
      query += ` AND o.market = ?`;
      params.push(market);
    }
    
    if (side) {
      query += ` AND o.side = ?`;
      params.push(side);
    }
    
    if (mode) {
      query += ` AND (o.mode = ? OR c.mode = ?)`;
      params.push(mode, mode);
    }
    
    // Validate orderBy to prevent SQL injection
    const validOrderBy = ['ts', 'close_ts', 'open_ts', 'pnl', 'entry', 'exit', 'market', 'side'];
    const orderByField = validOrderBy.includes(orderBy) ? orderBy : 'ts';
    const orderDirField = orderDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    query += ` ORDER BY ${orderByField === 'ts' ? 'c.ts' : orderByField} ${orderDirField}`;
    query += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    
    const trades = db.prepare(query).all(...params);
    
    // Normalize PnL values to percentage format (handle historical USD data)
    return trades.map(trade => {
      if (trade.collateral && Number.isFinite(trade.collateral)) {
        const normalizedPnL = this.normalizePnLToPercent(
          trade.pnl,
          trade.collateral,
          hasPnLPercent,
          trade.pnl_percent
        );
        return { ...trade, pnl: normalizedPnL };
      }
      return trade;
    });
  },
  
  /**
   * Get performance statistics grouped by time period
   * @param {Object} options - Query options
   * @param {number} options.sinceMs - Start timestamp
   * @param {string} options.groupBy - Group by period: 'hour', 'day', 'week', 'month'
   * @param {string} options.market - Filter by market
   * @param {string} options.mode - Filter by mode ('live' or 'paper')
   * @returns {Array} Array of performance stats per period
   */
  getPerformanceByPeriod(options = {}) {
    const {
      sinceMs = Date.now() - 86400000 * 30, // Default: last 30 days
      groupBy = 'day',
      market = null,
      mode = null,
    } = options;
    
    let timeFormat;
    switch (groupBy) {
      case 'hour':
        timeFormat = "strftime('%Y-%m-%d %H:00:00', datetime(c.ts/1000, 'unixepoch'))";
        break;
      case 'day':
        timeFormat = "date(datetime(c.ts/1000, 'unixepoch'))";
        break;
      case 'week':
        timeFormat = "strftime('%Y-W%W', datetime(c.ts/1000, 'unixepoch'))";
        break;
      case 'month':
        timeFormat = "strftime('%Y-%m', datetime(c.ts/1000, 'unixepoch'))";
        break;
      default:
        timeFormat = "date(datetime(c.ts/1000, 'unixepoch'))";
    }
    
    // Check if pnl_percent column exists for normalization
    const cols = db.prepare(`PRAGMA table_info(trades_close)`).all();
    const hasPnLPercent = cols.some((c) => c.name === 'pnl_percent');
    
    // Build PnL normalization expression
    // Use pnl_percent if available, otherwise try to normalize from pnl column
    const pnlExpr = hasPnLPercent
      ? `COALESCE(c.pnl_percent, 
          CASE 
            WHEN o.collateral > 0 AND ABS(c.pnl) < ABS(o.collateral) * 3 
            THEN (c.pnl / o.collateral) * 100 
            ELSE c.pnl 
          END)`
      : `CASE 
          WHEN o.collateral > 0 AND ABS(c.pnl) < ABS(o.collateral) * 3 
          THEN (c.pnl / o.collateral) * 100 
          ELSE c.pnl 
        END`;
    
    let query = `
      SELECT 
        ${timeFormat} AS period,
        COUNT(*) AS total_trades,
        SUM(CASE WHEN ${pnlExpr} > 0 THEN 1 ELSE 0 END) AS winning_trades,
        SUM(CASE WHEN ${pnlExpr} < 0 THEN 1 ELSE 0 END) AS losing_trades,
        SUM(${pnlExpr}) AS total_pnl,
        AVG(${pnlExpr}) AS avg_pnl,
        MIN(${pnlExpr}) AS min_pnl,
        MAX(${pnlExpr}) AS max_pnl,
        SUM(CASE WHEN o.side = 'long' THEN 1 ELSE 0 END) AS long_trades,
        SUM(CASE WHEN o.side = 'short' THEN 1 ELSE 0 END) AS short_trades
      FROM trades_close c
      LEFT JOIN trades_open o ON c.id = o.id
      WHERE c.ts >= ?
    `;
    
    const params = [sinceMs];
    
    if (market) {
      query += ` AND o.market = ?`;
      params.push(market);
    }
    
    if (mode) {
      query += ` AND (o.mode = ? OR c.mode = ?)`;
      params.push(mode, mode);
    }
    
    query += ` GROUP BY period ORDER BY period ASC`;
    
    return db.prepare(query).all(...params);
  },
  
  /**
   * Get performance statistics by market
   * @param {Object} options - Query options
   * @param {number} options.sinceMs - Start timestamp
   * @param {string} options.mode - Filter by mode ('live' or 'paper')
   * @returns {Array} Array of performance stats per market
   */
  getPerformanceByMarket(options = {}) {
    const {
      sinceMs = null,
      mode = null,
    } = options;
    
    // Check if pnl_percent column exists for normalization
    const cols = db.prepare(`PRAGMA table_info(trades_close)`).all();
    const hasPnLPercent = cols.some((c) => c.name === 'pnl_percent');
    
    // Build PnL normalization expression
    const pnlExpr = hasPnLPercent
      ? `COALESCE(c.pnl_percent, 
          CASE 
            WHEN o.collateral > 0 AND ABS(c.pnl) < ABS(o.collateral) * 3 
            THEN (c.pnl / o.collateral) * 100 
            ELSE c.pnl 
          END)`
      : `CASE 
          WHEN o.collateral > 0 AND ABS(c.pnl) < ABS(o.collateral) * 3 
          THEN (c.pnl / o.collateral) * 100 
          ELSE c.pnl 
        END`;
    
    let query = `
      SELECT 
        COALESCE(o.market, 'unknown') AS market,
        COUNT(*) AS total_trades,
        SUM(CASE WHEN ${pnlExpr} > 0 THEN 1 ELSE 0 END) AS winning_trades,
        SUM(CASE WHEN ${pnlExpr} < 0 THEN 1 ELSE 0 END) AS losing_trades,
        SUM(CASE WHEN ${pnlExpr} = 0 THEN 1 ELSE 0 END) AS break_even_trades,
        SUM(${pnlExpr}) AS total_pnl,
        AVG(${pnlExpr}) AS avg_pnl,
        MIN(${pnlExpr}) AS min_pnl,
        MAX(${pnlExpr}) AS max_pnl,
        SUM(CASE WHEN o.side = 'long' THEN ${pnlExpr} ELSE 0 END) AS long_pnl,
        SUM(CASE WHEN o.side = 'short' THEN ${pnlExpr} ELSE 0 END) AS short_pnl,
        SUM(CASE WHEN o.side = 'long' THEN 1 ELSE 0 END) AS long_trades,
        SUM(CASE WHEN o.side = 'short' THEN 1 ELSE 0 END) AS short_trades
      FROM trades_close c
      LEFT JOIN trades_open o ON c.id = o.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (sinceMs) {
      query += ` AND c.ts >= ?`;
      params.push(sinceMs);
    }
    
    if (mode) {
      query += ` AND (o.mode = ? OR c.mode = ?)`;
      params.push(mode, mode);
    }
    
    query += ` GROUP BY COALESCE(o.market, 'unknown') ORDER BY total_pnl DESC`;
    
    return db.prepare(query).all(...params);
  },
  
  /**
   * Get cumulative PnL over time (for equity curve)
   * @param {Object} options - Query options
   * @param {number} options.sinceMs - Start timestamp
   * @param {string} options.market - Filter by market
   * @param {string} options.mode - Filter by mode ('live' or 'paper')
   * @returns {Array} Array of {ts, cumulative_pnl, trade_count} objects
   */
  getCumulativePnL(options = {}) {
    const {
      sinceMs = null,
      market = null,
      mode = null,
    } = options;
    
    // Check if pnl_percent column exists for normalization
    const cols = db.prepare(`PRAGMA table_info(trades_close)`).all();
    const hasPnLPercent = cols.some((c) => c.name === 'pnl_percent');
    
    // Build PnL normalization expression
    const pnlExpr = hasPnLPercent
      ? `COALESCE(c.pnl_percent, 
          CASE 
            WHEN o.collateral > 0 AND ABS(c.pnl) < ABS(o.collateral) * 3 
            THEN (c.pnl / o.collateral) * 100 
            ELSE c.pnl 
          END)`
      : `CASE 
          WHEN o.collateral > 0 AND ABS(c.pnl) < ABS(o.collateral) * 3 
          THEN (c.pnl / o.collateral) * 100 
          ELSE c.pnl 
        END`;
    
    let query = `
      SELECT 
        c.ts,
        ${pnlExpr} AS pnl,
        o.market,
        COALESCE(o.mode, c.mode, 'unknown') AS mode
      FROM trades_close c
      LEFT JOIN trades_open o ON c.id = o.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (sinceMs) {
      query += ` AND c.ts >= ?`;
      params.push(sinceMs);
    }
    
    if (market) {
      query += ` AND o.market = ?`;
      params.push(market);
    }
    
    if (mode) {
      query += ` AND (o.mode = ? OR c.mode = ?)`;
      params.push(mode, mode);
    }
    
    query += ` ORDER BY c.ts ASC`;
    
    const trades = db.prepare(query).all(...params);
    
    // Calculate cumulative PnL
    let cumulative = 0;
    return trades.map(trade => {
      cumulative += trade.pnl;
      return {
        ts: trade.ts,
        pnl: trade.pnl,
        cumulative_pnl: cumulative,
        market: trade.market,
        mode: trade.mode,
      };
    });
  },
  
  /**
   * Get win rate statistics
   * @param {Object} options - Query options
   * @param {number} options.sinceMs - Start timestamp
   * @param {string} options.market - Filter by market
   * @param {string} options.side - Filter by side
   * @param {string} options.mode - Filter by mode ('live' or 'paper')
   * @returns {Object} Win rate statistics
   */
  getWinRateStats(options = {}) {
    const {
      sinceMs = null,
      market = null,
      side = null,
      mode = null,
    } = options;
    
    // Check if pnl_percent column exists for normalization
    const cols = db.prepare(`PRAGMA table_info(trades_close)`).all();
    const hasPnLPercent = cols.some((c) => c.name === 'pnl_percent');
    
    // Build PnL normalization expression
    const pnlExpr = hasPnLPercent
      ? `COALESCE(c.pnl_percent, 
          CASE 
            WHEN o.collateral > 0 AND ABS(c.pnl) < ABS(o.collateral) * 3 
            THEN (c.pnl / o.collateral) * 100 
            ELSE c.pnl 
          END)`
      : `CASE 
          WHEN o.collateral > 0 AND ABS(c.pnl) < ABS(o.collateral) * 3 
          THEN (c.pnl / o.collateral) * 100 
          ELSE c.pnl 
        END`;
    
    let query = `
      SELECT 
        COUNT(*) AS total_trades,
        SUM(CASE WHEN ${pnlExpr} > 0 THEN 1 ELSE 0 END) AS winning_trades,
        SUM(CASE WHEN ${pnlExpr} < 0 THEN 1 ELSE 0 END) AS losing_trades,
        SUM(CASE WHEN ${pnlExpr} = 0 THEN 1 ELSE 0 END) AS break_even_trades,
        SUM(${pnlExpr}) AS total_pnl,
        AVG(${pnlExpr}) AS avg_pnl
      FROM trades_close c
      LEFT JOIN trades_open o ON c.id = o.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (sinceMs) {
      query += ` AND c.ts >= ?`;
      params.push(sinceMs);
    }
    
    if (market) {
      query += ` AND o.market = ?`;
      params.push(market);
    }
    
    if (side) {
      query += ` AND o.side = ?`;
      params.push(side);
    }
    
    if (mode) {
      query += ` AND (o.mode = ? OR c.mode = ?)`;
      params.push(mode, mode);
    }
    
    const result = db.prepare(query).get(...params);
    
    if (!result || result.total_trades === 0) {
      return {
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        break_even_trades: 0,
        win_rate: 0,
        loss_rate: 0,
        total_pnl: 0,
        avg_pnl: 0,
      };
    }
    
    return {
      total_trades: result.total_trades,
      winning_trades: result.winning_trades,
      losing_trades: result.losing_trades,
      break_even_trades: result.break_even_trades,
      win_rate: (result.winning_trades / result.total_trades) * 100,
      loss_rate: (result.losing_trades / result.total_trades) * 100,
      total_pnl: result.total_pnl || 0,
      avg_pnl: result.avg_pnl || 0,
    };
  },
  
  /**
   * Get recent trades for a specific time range
   * @param {number} sinceMs - Start timestamp
   * @param {number} untilMs - End timestamp (optional)
   * @param {Object} filters - Additional filters (market, side, etc.)
   * @returns {Array} Array of trades
   */
  getTradesInRange(sinceMs, untilMs = null, filters = {}) {
    return this.getClosedTrades({
      sinceMs,
      ...filters,
      orderBy: 'ts',
      orderDir: 'ASC',
      limit: 10000, // Large limit for range queries
    }).filter(trade => {
      if (untilMs && trade.close_ts > untilMs) return false;
      return true;
    });
  },
  
  /**
   * Execute a custom SQL query (use with caution!)
   * @param {string} sql - SQL query string
   * @param {Array} params - Query parameters
   * @returns {Array|Object} Query results
   */
  query(sql, params = []) {
    try {
      const stmt = db.prepare(sql);
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        return stmt.all(...params);
      } else {
        return stmt.run(...params);
      }
    } catch (err) {
      console.error('Database query error:', err);
      throw err;
    }
  },
  
  /**
   * Store candles in the database
   * @param {string} symbol - Trading symbol (e.g., 'BTCUSDC')
   * @param {string} interval - Candle interval (e.g., '5m')
   * @param {Array} candles - Array of candle objects
   * @returns {number} Number of candles inserted
   */
  storeCandles(symbol, interval, candles) {
    if (!candles || candles.length === 0) return 0;
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO market_data (
        symbol, interval, open_time, close_time,
        open, high, low, close,
        base_volume, quote_volume, trade_count,
        taker_base_volume, taker_quote_volume
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = db.transaction((candles) => {
      let count = 0;
      for (const candle of candles) {
        stmt.run(
          symbol,
          interval,
          candle.openTime,
          candle.closeTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.baseVolume || candle.volume || 0,
          candle.quoteVolume || candle.takerQuoteVolume || 0,
          candle.tradeCount || candle.trades || 0,
          candle.takerBaseVolume || candle.takerBase || 0,
          candle.takerQuoteVolume || candle.takerQuote || 0
        );
        count++;
      }
      return count;
    });
    
    return insertMany(candles);
  },
  
  /**
   * Retrieve candles from the database
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Candle interval
   * @param {number} startTime - Start timestamp (ms)
   * @param {number} endTime - End timestamp (ms)
   * @returns {Array} Array of candle objects
   */
  getCandles(symbol, interval, startTime, endTime) {
    const stmt = db.prepare(`
      SELECT 
        open_time as openTime,
        close_time as closeTime,
        open, high, low, close,
        base_volume as baseVolume,
        quote_volume as quoteVolume,
        trade_count as tradeCount,
        taker_base_volume as takerBaseVolume,
        taker_quote_volume as takerQuoteVolume
      FROM market_data
      WHERE symbol = ? 
        AND interval = ?
        AND close_time >= ?
        AND close_time <= ?
      ORDER BY close_time ASC
    `);
    
    return stmt.all(symbol, interval, startTime, endTime);
  },
  
  /**
   * Check if candles exist for a given range
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Candle interval
   * @param {number} startTime - Start timestamp (ms)
   * @param {number} endTime - End timestamp (ms)
   * @returns {Object} { exists: boolean, count: number, coverage: number }
   */
  checkCandleCoverage(symbol, interval, startTime, endTime) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM market_data
      WHERE symbol = ? 
        AND interval = ?
        AND close_time >= ?
        AND close_time <= ?
    `);
    
    const result = stmt.get(symbol, interval, startTime, endTime);
    const count = result.count || 0;
    
    // Calculate expected candles based on interval
    const intervalMs = {
      '1m': 60000,
      '5m': 300000,
      '15m': 900000,
      '1h': 3600000,
      '4h': 14400000,
      '1d': 86400000,
    }[interval] || 300000;
    
    const expectedCount = Math.floor((endTime - startTime) / intervalMs);
    const coverage = expectedCount > 0 ? (count / expectedCount) : 0;
    
    return {
      exists: count > 0,
      count,
      expectedCount,
      coverage: Math.min(coverage, 1.0),
    };
  },
  
  /**
   * Delete old candles to save space
   * @param {number} olderThanMs - Delete candles older than this timestamp
   * @returns {number} Number of candles deleted
   */
  deleteOldCandles(olderThanMs) {
    const stmt = db.prepare(`
      DELETE FROM market_data
      WHERE close_time < ?
    `);
    
    const result = stmt.run(olderThanMs);
    return result.changes;
  },
  
  /**
   * Bot instance lock management - prevents multiple instances from running
   * Works across containers by using shared database
   */
  
  /**
   * Try to acquire instance lock (singleton pattern)
   * @param {string} instanceId - Unique instance identifier
   * @param {number} pid - Process ID
   * @param {string} environment - Environment (local/render)
   * @param {number} staleThresholdMs - Consider instances stale if heartbeat older than this (default: 60s)
   * @returns {boolean} true if lock acquired, false if another instance is running
   */
  acquireInstanceLock(instanceId, pid, environment = 'local', staleThresholdMs = 60000) {
    const now = Date.now();
    const staleThreshold = now - staleThresholdMs;
    
    // Clean up stale instances (haven't sent heartbeat in threshold time)
    const cleanupStmt = db.prepare(`
      DELETE FROM bot_instances 
      WHERE last_heartbeat < ?
    `);
    cleanupStmt.run(staleThreshold);
    
    // Check for existing active instances
    const checkStmt = db.prepare(`
      SELECT instance_id, pid, hostname, last_heartbeat, environment
      FROM bot_instances
      WHERE last_heartbeat >= ?
      ORDER BY last_heartbeat DESC
      LIMIT 1
    `);
    const existing = checkStmt.get(staleThreshold);
    
    if (existing) {
      // Another instance is active
      return false;
    }
    
    // Try to insert our instance (will fail if another instance inserted between check and insert)
    try {
      const insertStmt = db.prepare(`
        INSERT INTO bot_instances (instance_id, pid, hostname, started_at, last_heartbeat, environment)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const hostname = require('os').hostname();
      insertStmt.run(instanceId, pid, hostname, now, now, environment);
      return true;
    } catch (err) {
      // Another instance inserted first (race condition)
      if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return false;
      }
      throw err;
    }
  },
  
  /**
   * Update heartbeat for this instance
   * @param {string} instanceId - Instance identifier
   * @returns {boolean} true if heartbeat updated, false if instance not found
   */
  updateInstanceHeartbeat(instanceId) {
    const now = Date.now();
    const stmt = db.prepare(`
      UPDATE bot_instances 
      SET last_heartbeat = ?
      WHERE instance_id = ?
    `);
    const result = stmt.run(now, instanceId);
    return result.changes > 0;
  },
  
  /**
   * Release instance lock
   * @param {string} instanceId - Instance identifier
   */
  releaseInstanceLock(instanceId) {
    const stmt = db.prepare(`
      DELETE FROM bot_instances 
      WHERE instance_id = ?
    `);
    stmt.run(instanceId);
  },
  
  /**
   * Get all active instances
   * @param {number} staleThresholdMs - Consider instances stale if heartbeat older than this
   * @returns {Array} List of active instances
   */
  getActiveInstances(staleThresholdMs = 60000) {
    const now = Date.now();
    const staleThreshold = now - staleThresholdMs;
    const stmt = db.prepare(`
      SELECT instance_id, pid, hostname, started_at, last_heartbeat, environment
      FROM bot_instances
      WHERE last_heartbeat >= ?
      ORDER BY last_heartbeat DESC
    `);
    return stmt.all(staleThreshold);
  },
  
  path: DB_PATH,
};
