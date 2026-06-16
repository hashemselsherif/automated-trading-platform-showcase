const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { loadWsCache } = require("../utils/hyperliquid-ws-cache");

test("loadWsCache supports channel-selective snapshot loading", () => {
  const fixtureDir = path.join(__dirname, "fixtures", "hyperliquid-ws-cache");

  const both = loadWsCache(fixtureDir, { symbols: ["BTC"] });
  const clearinghouseOnly = loadWsCache(fixtureDir, {
    symbols: ["BTC"],
    includeWebData2: false,
  });
  const webDataOnly = loadWsCache(fixtureDir, {
    symbols: ["BTC"],
    includeClearinghouseState: false,
  });

  assert.ok(both.snapshots.length > 0);
  assert.ok(clearinghouseOnly.snapshots.length > 0);
  assert.ok(webDataOnly.snapshots.length > 0);
  assert.ok(
    both.snapshots.length >= Math.max(clearinghouseOnly.snapshots.length, webDataOnly.snapshots.length)
  );
});
