// pda-utils.js
const { PublicKey } = require("@solana/web3.js");

// Perps program (mainnet, overrideable via env)
const PROGRAM_ID_STR =
  (process.env && process.env.PERPS_PROGRAM && process.env.PERPS_PROGRAM.trim()) ||
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu";
const PERPS_PROGRAM = new PublicKey(PROGRAM_ID_STR);

const SEEDS = {
  PERPETUALS: Buffer.from("perpetuals"),
  POSITION: Buffer.from("position"),
  POSITION_REQUEST: Buffer.from("position_request"),
  EVENT_AUTHORITY: Buffer.from("__event_authority"),
};

function derivePerpetualsPda(programId = PERPS_PROGRAM) {
  const [pda] = PublicKey.findProgramAddressSync([SEEDS.PERPETUALS], programId);
  return pda;
}

/**
 * Derives the Position PDA according to Jupiter Perpetuals specification
 * CORRECT SEEDS (verified via on-chain testing):
 * 
 * Seeds: ["position", owner, pool, custody, collateralCustody, side]
 * - owner: trader's wallet address
 * - pool: the perpetuals pool account (5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq)
 * - custody: market custody account (SOL/BTC/ETH)
 * - collateralCustody: collateral custody account (USDC for shorts, asset for longs)
 * - side: Side enum (None=0, Long=1, Short=2) - CRITICAL: shorts use 2, not 0!
 */
function derivePositionPda(owner, pool, custody, collateralCustody, side, programId = PERPS_PROGRAM) {
  const sideBuffer = Buffer.alloc(1);
  // Jupiter Perps side enum: None=0, Long=1, Short=2
  // CRITICAL FIX: shorts must use 2, not 0!
  sideBuffer.writeUInt8(side === "short" || side === 2 ? 2 : side === "long" || side === 1 ? 1 : 0, 0);
  
  const [pda] = PublicKey.findProgramAddressSync(
    [
      SEEDS.POSITION,
      owner.toBuffer(),
      pool.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      sideBuffer,
    ],
    programId
  );
  return pda;
}

/**
 * Derives the PositionRequest PDA according to Jupiter Perpetuals specification
 * Source: https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing
 * 
 * Seeds: ["position_request", positionPda, counter, requestChange]
 * - "position_request": constant seed string (first!)
 * - positionPda: the Position account's address
 * - counter: random integer seed (u64 LE) to make each request unique
 * - requestChange: 1 for increase, 2 for decrease (u8)
 */
function derivePositionRequestPda(positionPda, counter, requestChange, programId = PERPS_PROGRAM) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64LE(BigInt(counter), 0);
  
  // requestChange: 1 = increase, 2 = decrease
  const requestChangeBuffer = Buffer.from([requestChange === 'increase' || requestChange === 1 ? 1 : 2]);
  
  const [pda] = PublicKey.findProgramAddressSync(
    [
      SEEDS.POSITION_REQUEST,
      positionPda.toBuffer(),
      counterBuffer,
      requestChangeBuffer,
    ],
    programId
  );
  return pda;
}

function deriveEventAuthorityPda(programId = PERPS_PROGRAM) {
  const [pda] = PublicKey.findProgramAddressSync([SEEDS.EVENT_AUTHORITY], programId);
  return pda;
}

module.exports = {
  PERPS_PROGRAM,
  derivePerpetualsPda,
  derivePositionPda,
  derivePositionRequestPda,
  deriveEventAuthorityPda,
};

