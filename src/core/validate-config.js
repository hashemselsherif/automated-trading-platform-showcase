// validate-config.js
const fs = require('fs');
const path = require('path');

module.exports = function validateConfig(config) {
  const errs = [];

  console.log("### Config Check ###");
  console.log("Mode:", config.paperTradingMode ? "📄 PAPER" : "🔴 LIVE");

  // Required: RPC URL
  if (!config.rpcUrl || config.rpcUrl === '') {
    errs.push("❌ RPC_URL missing (required)");
  } else if (!config.rpcUrl.startsWith('http')) {
    errs.push("❌ RPC_URL must be a valid HTTP/HTTPS URL");
  }

  // Required: Markets
  if (!config.markets || config.markets.length === 0) {
    errs.push("❌ MARKETS missing (required)");
  }

  // Required: Tokens and quote mint (internal config)
  if (!config.tokens?.SOL) errs.push("❌ tokens.SOL missing");
  if (!config.quoteMint) errs.push("❌ quoteMint missing");

  // Required for live trading: Wallet private key
  if (!config.paperTradingMode) {
    const hasWalletKey = !!process.env.WALLET_PRIVATE_KEY;
    const hasWalletPathEnv = !!process.env.WALLET_PRIVATE_KEY_PATH;
    
    // Check if wallet file exists at default or specified path
    let walletFileExists = false;
    if (hasWalletPathEnv) {
      // Check if file exists at the specified path
      walletFileExists = fs.existsSync(process.env.WALLET_PRIVATE_KEY_PATH);
    } else {
      // Check if file exists at default path
      const defaultWalletPath = path.join(process.cwd(), 'perps-wallet.json');
      walletFileExists = fs.existsSync(defaultWalletPath);
    }
    
    if (!hasWalletKey && !hasWalletPathEnv && !walletFileExists) {
      errs.push("❌ WALLET_PRIVATE_KEY or WALLET_PRIVATE_KEY_PATH missing (required for live trading)");
      errs.push("   Options:");
      errs.push("   1. Set WALLET_PRIVATE_KEY environment variable (JSON array or base58 string)");
      errs.push("   2. Set WALLET_PRIVATE_KEY_PATH environment variable pointing to wallet file");
      errs.push("   3. Place wallet file at: " + path.join(process.cwd(), 'perps-wallet.json'));
      errs.push("   4. For Render: Use Render Secret Files or set WALLET_PRIVATE_KEY_PATH=/app/perps-wallet.json");
    }
  }

  // Required for live trading: Perps program ID
  if (!config.paperTradingMode && !config.perpsProgram) {
    errs.push("❌ PERPS_PROGRAM missing (required for live trading)");
  }

  if (errs.length) {
    errs.forEach(e => console.error(e));
    console.error("\n💡 See .env.example and docs/configuration.md for required environment variables");
    process.exit(1);
  }

  console.log("✅ Config OK\n");
};

