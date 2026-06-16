const EventEmitter = require("events");

let WebSocketImpl = global.WebSocket;
if (!WebSocketImpl) {
  try {
    WebSocketImpl = require("ws");
  } catch (e) {
    console.error("[Hyperliquid WS] Missing WebSocket implementation. Install `ws` or use Node with global WebSocket.");
    throw e;
  }
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function toUser(x) {
  const s = String(x || "").toLowerCase().trim();
  return s.startsWith("0x") ? s : null;
}

class HyperliquidWebSocketClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.wsUrl = options.wsUrl || process.env.HYPERLIQUID_WS_URL || "wss://api.hyperliquid.xyz/ws";
    this.logger = options.logger || console;

    this.reconnectDelayMs = Math.max(500, num(options.reconnectDelayMs, 5_000));
    this.maxReconnectAttempts = Math.max(0, num(options.maxReconnectAttempts, 100));
    this.shouldReconnect = options.shouldReconnect !== false;

    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;

    this.lastMessageMs = null;
    this.lastUserUpdateMs = new Map();
    this.subscriptions = [];
    this.subscriptionKeys = new Set();
  }

  connect() {
    if (this.ws && this.connected) return;
    if (this.ws) this._cleanupSocket();

    this.logger.log(`[Hyperliquid WS] Connecting to ${this.wsUrl}...`);
    this.ws = new WebSocketImpl(this.wsUrl);
    this._bindSocketEvents(this.ws);
  }

  disconnect() {
    this.shouldReconnect = false;
    this._clearReconnect();
    if (this.ws) {
      try {
        this.ws.close(1000, "Intentional disconnect");
      } catch {
        // ignore
      }
    }
  }

  isConnected() {
    return this.connected;
  }

  getLastUserUpdateMs(user) {
    const u = toUser(user);
    return u ? this.lastUserUpdateMs.get(u) || null : null;
  }

  subscribe(subscription) {
    if (!subscription || typeof subscription !== "object") return;
    const key = JSON.stringify(subscription);
    if (this.subscriptionKeys.has(key)) return;
    this.subscriptionKeys.add(key);
    this.subscriptions.push(subscription);
    if (this.connected && this.ws) {
      this._send({ method: "subscribe", subscription });
    }
  }

  subscribeClearinghouseState(user) {
    const u = toUser(user);
    if (!u) return;
    this.subscribe({ type: "clearinghouseState", user: u });
  }

  subscribeWebData2(user) {
    const u = toUser(user);
    if (!u) return;
    this.subscribe({ type: "webData2", user: u });
  }

  subscribeUserFills(user) {
    const u = toUser(user);
    if (!u) return;
    this.subscribe({ type: "userFills", user: u });
  }

  subscribeTrades(symbol) {
    const coin = String(symbol || "").toUpperCase().trim();
    if (!coin) return;
    this.subscribe({ type: "trades", coin });
  }

  _handleOpen() {
    this.connected = true;
    this.reconnectAttempts = 0;
    this.logger.log("[Hyperliquid WS] ✅ Connected");
    for (const sub of this.subscriptions) {
      this._send({ method: "subscribe", subscription: sub });
    }
    this.emit("connected");
  }

  _handleMessage(data) {
    this.lastMessageMs = Date.now();
    let msg = null;
    try {
      msg = JSON.parse(String(data));
    } catch {
      this.emit("message", { raw: data, parsed: null });
      return;
    }

    const channel =
      msg?.channel ||
      msg?.type ||
      msg?.data?.type ||
      msg?.subscription?.type ||
      msg?.result?.type ||
      null;

    const user =
      (typeof msg?.data?.user === "string" && msg.data.user) ||
      (typeof msg?.user === "string" && msg.user) ||
      (typeof msg?.subscription?.user === "string" && msg.subscription.user) ||
      null;

    if (user && user.startsWith("0x")) {
      this.lastUserUpdateMs.set(user.toLowerCase(), Date.now());
    }

    this.emit("message", { raw: msg, channel, user });
    if (channel === "error") {
      this.emit("hl_error", msg);
      return;
    }
    if (channel) this.emit(channel, msg);
  }

  _handleClose(code, reason) {
    this.connected = false;
    this.logger.warn("[Hyperliquid WS] closed", { code, reason: String(reason || "") });
    this.emit("disconnected", { code, reason: String(reason || "") });
    this._scheduleReconnect();
  }

  _handleError(err) {
    this.logger.error("[Hyperliquid WS] error:", err?.message || err);
    this.emit("error", err);
  }

  _bindSocketEvents(socket) {
    const onOpen = () => this._handleOpen();
    const onMessage = (evt) => {
      const data = evt && evt.data !== undefined ? evt.data : evt;
      this._handleMessage(data);
    };
    const onClose = (evt) => {
      const code = evt && evt.code !== undefined ? evt.code : undefined;
      const reason = evt && evt.reason !== undefined ? evt.reason : undefined;
      this._handleClose(code, reason);
    };
    const onError = (evt) => {
      const err = evt && evt.error ? evt.error : evt;
      this._handleError(err);
    };

    if (typeof socket.on === "function") {
      socket.on("open", onOpen);
      socket.on("message", onMessage);
      socket.on("close", onClose);
      socket.on("error", onError);
      return;
    }

    if (typeof socket.addEventListener === "function") {
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      return;
    }

    throw new Error("Unsupported WebSocket implementation: missing .on/.addEventListener");
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocketImpl.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (e) {
      this.logger.error("[Hyperliquid WS] send failed:", e?.message || e);
    }
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this._clearReconnect();
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelayMs);
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _cleanupSocket() {
    try {
      if (this.ws) {
        this.ws.removeAllListeners?.();
        if (typeof this.ws.removeEventListener === "function") {
          this.ws.removeEventListener("open", this._handleOpen);
          this.ws.removeEventListener("message", this._handleMessage);
          this.ws.removeEventListener("close", this._handleClose);
          this.ws.removeEventListener("error", this._handleError);
        }
        this.ws.terminate?.();
      }
    } catch {
      // ignore
    } finally {
      this.ws = null;
      this.connected = false;
    }
  }
}

module.exports = {
  HyperliquidWebSocketClient,
};
