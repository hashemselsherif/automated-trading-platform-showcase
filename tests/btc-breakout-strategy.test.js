const test = require("node:test");

const { breakoutStrategyTestCases } = require("../scripts/test/test-btc-breakout-strategy");

for (const testCase of breakoutStrategyTestCases) {
  test(testCase.name, () => {
    testCase.fn();
  });
}
