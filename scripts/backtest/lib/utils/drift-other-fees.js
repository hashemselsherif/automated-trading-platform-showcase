/**
 * Drift "Other Trading Fees" (Perps) helper.
 *
 * Source: Drift docs → Other Trading Fees (Perp): liquidator_fee, insurance_fee
 * https://docs.drift.trade/trading/other-trading-fees
 *
 * Notes:
 * - These fees are typically relevant on LIQUIDATION events (liquidator takeover premium + insurance fee).
 * - Drift docs list per-market fee rates (e.g. 0.025). We treat these as decimal fractions of notional
 *   (0.025 => 2.5% of notional). If Drift changes units, update here accordingly.
 */

function normalizePerpMarket(market) {
  if (!market) return null;
  const m = String(market).toUpperCase().trim();
  if (m.endsWith('-PERP')) return m;
  return `${m}-PERP`;
}

// Subset map for markets used by this repo frequently.
// Add more as needed. Unknown markets default to 0 unless overridden via env.
const OTHER_PERP_FEES = {
  // Provided set (alts basket)
  'JTO-PERP': { liquidatorFee: 0.025, insuranceFee: 0.025 },
  'XRP-PERP': { liquidatorFee: 0.01, insuranceFee: 0.02 },
  'HYPE-PERP': { liquidatorFee: 0.01, insuranceFee: 0.05 },
  'SUI-PERP': { liquidatorFee: 0.01, insuranceFee: 0.02 },
  'ARB-PERP': { liquidatorFee: 0.01, insuranceFee: 0.025 },
  'LINK-PERP': { liquidatorFee: 0.02, insuranceFee: 0.02 },
  'JUP-PERP': { liquidatorFee: 0.02, insuranceFee: 0.025 },
  'DOGE-PERP': { liquidatorFee: 0.01, insuranceFee: 0.025 },
  'HNT-PERP': { liquidatorFee: 0.025, insuranceFee: 0.025 },
  'TAO-PERP': { liquidatorFee: 0.025, insuranceFee: 0.045 },
  'APT-PERP': { liquidatorFee: 0.01, insuranceFee: 0.025 },
  'ZEC-PERP': { liquidatorFee: 0.02, insuranceFee: 0.02 },

  // Some common majors (useful for other runs)
  'SOL-PERP': { liquidatorFee: 0.0075, insuranceFee: 0.0075 },
  'BTC-PERP': { liquidatorFee: 0.005, insuranceFee: 0.0075 },
  'ETH-PERP': { liquidatorFee: 0.005, insuranceFee: 0.0075 },
};

/**
 * Get Drift perps liquidation/insurance fee rates.
 * @param {string} market - e.g. 'SOL-PERP' or 'SOL'
 * @returns {{ liquidatorFee: number, insuranceFee: number, source: string }}
 */
function getOtherPerpFees(market) {
  const m = normalizePerpMarket(market);
  if (!m) return { liquidatorFee: 0, insuranceFee: 0, source: 'none' };

  // Per-market override via env (example: DRIFT_OTHER_FEES_JTO_LIQUIDATOR=0.03)
  const base = m.replace('-PERP', '');
  const envLiq = Number(process.env[`DRIFT_OTHER_FEES_${base}_LIQUIDATOR`]);
  const envIns = Number(process.env[`DRIFT_OTHER_FEES_${base}_INSURANCE`]);

  const defaultLiq = Number(process.env.DRIFT_OTHER_FEES_DEFAULT_LIQUIDATOR || 0);
  const defaultIns = Number(process.env.DRIFT_OTHER_FEES_DEFAULT_INSURANCE || 0);

  const fromMap = OTHER_PERP_FEES[m];
  const liquidatorFee =
    Number.isFinite(envLiq) ? envLiq : (fromMap?.liquidatorFee ?? defaultLiq);
  const insuranceFee =
    Number.isFinite(envIns) ? envIns : (fromMap?.insuranceFee ?? defaultIns);

  const source =
    Number.isFinite(envLiq) || Number.isFinite(envIns)
      ? 'env_override'
      : (fromMap ? 'docs_map' : 'default');

  return {
    liquidatorFee: Number.isFinite(liquidatorFee) ? liquidatorFee : 0,
    insuranceFee: Number.isFinite(insuranceFee) ? insuranceFee : 0,
    source,
  };
}

module.exports = {
  normalizePerpMarket,
  getOtherPerpFees,
  OTHER_PERP_FEES,
};


