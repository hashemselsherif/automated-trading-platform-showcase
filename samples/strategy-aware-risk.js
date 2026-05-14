/**
 * Representative excerpt adapted from the production risk layer.
 * Risk rules vary by strategy because holding periods, volatility tolerance,
 * and exit logic differ across momentum, breakout, and mean-reversion styles.
 */

const RISK_BY_STRATEGY = {
  momentum: {
    stopLossPercent: 5,
    takeProfitPercent: 15,
    riskPerTradePercent: 0.05,
    maxPositionHours: 72,
  },
  scalping: {
    stopLossPercent: 0.15,
    takeProfitPercent: 1.2,
    riskPerTradePercent: 0.015,
    maxPositionHours: 1,
  },
  "rsi-reversion": {
    stopLossPercent: 5,
    takeProfitPercent: 15,
    riskPerTradePercent: 0.05,
    maxPositionHours: 72,
  },
  "btc-breakout": {
    stopLossPercent: 8,
    takeProfitPercent: 10,
    riskPerTradePercent: 0.05,
    maxPositionHours: 168,
  },
};

function getRiskConfig(strategyType) {
  return RISK_BY_STRATEGY[strategyType] || RISK_BY_STRATEGY.momentum;
}

function sizePosition({
  strategyType,
  equity,
  entryPrice,
  stopDistance,
  expectedLeverage = 3,
  maxNotionalUsd = 10000,
}) {
  const risk = getRiskConfig(strategyType);
  const riskBudgetUsd = equity * risk.riskPerTradePercent;
  const targetNotionalUsd = (riskBudgetUsd * entryPrice) / stopDistance;
  const cappedNotionalUsd = Math.min(targetNotionalUsd, maxNotionalUsd);
  const collateralUsd = cappedNotionalUsd / expectedLeverage;

  return {
    strategyType,
    riskBudgetUsd: round(riskBudgetUsd),
    notionalUsd: round(cappedNotionalUsd),
    collateralUsd: round(collateralUsd),
    stopLossPercent: risk.stopLossPercent,
    takeProfitPercent: risk.takeProfitPercent,
    maxPositionHours: risk.maxPositionHours,
  };
}

function round(value) {
  return Number(value.toFixed(2));
}

module.exports = {
  getRiskConfig,
  sizePosition,
};
