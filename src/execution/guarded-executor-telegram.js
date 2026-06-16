// guarded-executor-telegram.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Try to use config, fallback to process.env for standalone usage
let config;
try {
  config = require('../../config');
} catch (e) {
  config = null;
}

class GuardedExecutorTelegram {
  constructor(telegramControl, cfg = {}) {
    this.tg = telegramControl;
    // Use config if available, otherwise fallback to process.env
    this.mode = config ? config.executionMode.toLowerCase() : (process.env.EXECUTION_MODE || 'paper').toLowerCase(); // paper | guarded | auto
    this.queuePath = path.join(process.cwd(), 'approvals', 'pending.json');
    const dir = path.dirname(this.queuePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.queuePath)) fs.writeFileSync(this.queuePath, '[]');
  }

  _read() { return JSON.parse(fs.readFileSync(this.queuePath, 'utf8')); }
  _write(items) { fs.writeFileSync(this.queuePath, JSON.stringify(items, null, 2)); }

  async guard(kind, payload) {
    if (this.mode === 'paper') return { approved: true };

    const req = { id: `${Date.now()}`, ts: new Date().toISOString(), kind, payload };
    const q = this._read(); q.push(req); this._write(q);

    if (this.mode === 'auto') return { approved: true };

    // First try Telegram
    if (this.tg?.enabled) {
      const ok = await this.tg.approve(kind, payload);
      return { approved: !!ok };
    }

    // Fallback: console prompt
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));
    console.log(`\n🔒 Approval required:\n${JSON.stringify(req, null, 2)}\n`);
    const ans = (await ask('Approve? (y/N) ')).trim().toLowerCase();
    rl.close();
    return { approved: ans === 'y' || ans === 'yes' };
  }
}

module.exports = GuardedExecutorTelegram;

