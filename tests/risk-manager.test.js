const test = require("node:test");
const assert = require("node:assert/strict");

const RiskManager = require("../risk-manager");

function buildRiskManager(riskOverrides = {}, leverageOverrides = {}) {
  return new RiskManager({
    risk: {
      stopLossPercent: 10,
      takeProfitPercent: 20,
      trailingStopPercent: 1,
      useTrailingStop: true,
      positionSizePercent: 10,
      riskPerTradePercent: 0.05,
      maxPositionSize: 10000,
      ...riskOverrides,
    },
    leverage: {
      maxLeverage: 5,
      long: 5,
      short: 5,
      ...leverageOverrides,
    },
  });
}

test("position sizing respects max notional with leverage", () => {
  const riskManager = buildRiskManager({
    positionSizePercent: 50,
    sizingMethod: "percent",
    maxPositionSize: 500,
  });

  const baseSize = riskManager.calculatePositionSize(1000, {
    price: 100,
    leverage: 5,
    forceSizingMethod: "percent",
  });

  assert.equal(baseSize, 100);
});

test("risk sizing respects leverage constraints", () => {
  const riskManager = buildRiskManager(
    {
      positionSizePercent: 100,
      riskPerTradePercent: 0.1,
      sizingMethod: "risk",
      maxPositionSize: 1000,
    },
    {
      maxLeverage: 10,
    }
  );

  const baseSize = riskManager.calculatePositionSize(1000, {
    price: 100,
    stopDistance: 5,
    leverage: 10,
  });

  assert.equal(baseSize, 100);
});

test("percent sizing scales collateral by signal size fraction", () => {
  const riskManager = buildRiskManager({
    positionSizePercent: 40,
    sizingMethod: "percent",
    maxPositionSize: 5000,
  });

  const baseSize = riskManager.calculatePositionSize(1000, {
    price: 100,
    leverage: 5,
    forceSizingMethod: "percent",
    sizeFraction: 0.5,
  });

  assert.equal(baseSize, 200);
});

test("equal-risk sizing scales risk budget by signal size fraction", () => {
  const riskManager = buildRiskManager(
    {
      positionSizePercent: 100,
      riskPerTradePercent: 0.1,
      sizingMethod: "risk",
      maxPositionSize: 5000,
    },
    {
      maxLeverage: 10,
    }
  );

  const baseSize = riskManager.calculatePositionSize(1000, {
    price: 100,
    stopDistance: 5,
    leverage: 10,
    sizeFraction: 0.5,
  });

  assert.equal(baseSize, 100);
});

test("stop loss override applies to leveraged PnL", () => {
  const riskManager = buildRiskManager({
    stopLossPercent: 10,
  });

  const mockPerpsClient = {
    calculatePnL: () => -6,
    isNearLiquidation: () => false,
  };

  const position = {
    market: "BTC-PERP",
    strategyType: "copy-trading",
    stopLossPercentOverride: 5,
  };

  const result = riskManager.shouldStopLoss(position, 100, mockPerpsClient);
  assert.equal(result.should, true);
  assert.equal(result.reason, "STOP_LOSS");
});
