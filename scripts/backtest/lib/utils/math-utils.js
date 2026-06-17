/**
 * Mathematical utility functions for backtesting
 */

/**
 * Generate a random number from a Gaussian (normal) distribution using Box-Muller transform
 * @param {number} mean - The mean of the distribution
 * @param {number} std - The standard deviation of the distribution
 * @returns {number} A random number from the Gaussian distribution
 */
function gaussian(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); // Converting [0,1) to (0,1)
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + z * std;
}

module.exports = { gaussian };
