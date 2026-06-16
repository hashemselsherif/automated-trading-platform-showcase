// journal.js
const fs = require('fs');
const path = require('path');

const ensure = (p) => { const d = path.dirname(p); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };

const CSV_PATH = path.join(process.cwd(), 'logs', 'trades.csv');
const JSONL_PATH = path.join(process.cwd(), 'logs', 'trades.jsonl');

function init() {
  ensure(CSV_PATH); ensure(JSONL_PATH);
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, 'ts,event,positionId,side,entry,exit,collateral,leverage,size,pnl,reason\n');
  }
}

function appendCSV(obj) {
  const esc = (x) => (x === undefined || x === null ? '' : String(x).replace(/,/g, ''));
  const line = [
    new Date().toISOString(),
    esc(obj.event),
    esc(obj.positionId),
    esc(obj.side),
    esc(obj.entry),
    esc(obj.exit),
    esc(obj.collateral),
    esc(obj.leverage),
    esc(obj.size),
    esc(obj.pnl),
    esc(obj.reason),
  ].join(',') + '\n';
  fs.appendFileSync(CSV_PATH, line);
}

function appendJSONL(obj) {
  fs.appendFileSync(JSONL_PATH, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

module.exports = {
  init,
  logOpen(position) {
    appendCSV({
      event: 'open',
      positionId: position.positionId,
      side: position.side,
      entry: position.entryPrice,
      collateral: position.collateral,
      leverage: position.leverage,
      size: position.size,
    });
    appendJSONL({ event: 'open', ...position });
  },
  logClose(position, exit, pnl, reason) {
    appendCSV({
      event: 'close',
      positionId: position.positionId,
      side: position.side,
      entry: position.entryPrice,
      exit,
      collateral: position.collateral,
      leverage: position.leverage,
      size: position.size,
      pnl,
      reason,
    });
    appendJSONL({ event: 'close', positionId: position.positionId, side: position.side, exit, pnl, reason });
  },
  paths: { CSV_PATH, JSONL_PATH },
};

