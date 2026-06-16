const crypto = require("crypto");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function serializeParams(params, { encodeValues = true, prefixWith = "?" } = {}) {
  if (!params || typeof params !== "object") return "";
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort();
  const qs = keys
    .map((k) => {
      const v = String(params[k]);
      const enc = encodeValues ? encodeURIComponent(v) : v;
      return `${k}=${enc}`;
    })
    .join("&");
  return qs ? `${prefixWith}${qs}` : "";
}

function signBitgetV2({ timestampMs, method, endpointPath, queryStringOrBody, apiSecret }) {
  const payload = `${timestampMs}${method.toUpperCase()}${endpointPath}${queryStringOrBody || ""}`;
  return crypto.createHmac("sha256", apiSecret).update(payload).digest("base64");
}

async function bitgetV2Request({
  baseUrl = "https://api.bitget.com",
  method = "GET",
  endpointPath,
  params,
  body,
  apiKey,
  apiSecret,
  apiPassphrase,
  timeoutMs = 30_000,
  userAgent = "jupiter-perps-bot/bitget-v2",
  rateLimitMs = 0,
  isPublic = false,
}) {
  if (!endpointPath || typeof endpointPath !== "string" || !endpointPath.startsWith("/")) {
    throw new Error(`Invalid endpointPath: ${endpointPath}`);
  }

  if (rateLimitMs > 0) await sleep(rateLimitMs);

  const urlBase = String(baseUrl || "").replace(/\/$/, "");
  const ts = Date.now();

  let queryStringOrBody = "";
  let url = `${urlBase}${endpointPath}`;
  const headers = { "content-type": "application/json", "user-agent": userAgent };

  if (method.toUpperCase() === "GET") {
    queryStringOrBody = serializeParams(params, { prefixWith: "?" });
    url = `${url}${queryStringOrBody}`;
  } else if (body !== undefined) {
    queryStringOrBody = JSON.stringify(body) || "";
  } else if (params && typeof params === "object") {
    queryStringOrBody = JSON.stringify(params) || "";
  }

  if (!isPublic) {
    if (!apiKey || !apiSecret || !apiPassphrase) {
      throw new Error(
        "Bitget v2 private request requires BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE"
      );
    }
    const accessSign = signBitgetV2({
      timestampMs: ts,
      method,
      endpointPath,
      queryStringOrBody,
      apiSecret,
    });
    headers["ACCESS-KEY"] = apiKey;
    headers["ACCESS-PASSPHRASE"] = apiPassphrase;
    headers["ACCESS-TIMESTAMP"] = String(ts);
    headers["ACCESS-SIGN"] = accessSign;
  }

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method.toUpperCase() === "GET" ? undefined : queryStringOrBody || undefined,
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - start;
    const txt = await res.text();
    let json = null;
    try {
      json = JSON.parse(txt);
    } catch {
      // ignore
    }
    return { status: res.status, ok: res.ok, url, method, json, txt: txt.slice(0, 800), latencyMs };
  } finally {
    clearTimeout(to);
  }
}

module.exports = {
  bitgetV2Request,
  serializeParams,
  signBitgetV2,
};
