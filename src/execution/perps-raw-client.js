#!/usr/bin/env node
import 'dotenv/config';
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as JUP from 'jup-perps-client';

// ---------- Constants ----------
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1wTbjDe3Jxk5k2vN8a4Wz7oS9pSzs');
const TOKEN_LOADER = new PublicKey('BPFLoader2111111111111111111111111111111111');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const NATIVE_LOADER = new PublicKey('NativeLoader1111111111111111111111111111111');

// ---------- Helpers ----------
const reqEnv = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`Missing required env: ${n}`);
  return v;
};
const bn = (x) => BigInt(x ?? 0);
const pk = (s) => new PublicKey(s);

function deriveAta(owner, mint) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function derivePda(seeds, programId, label) {
  const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
  console.log(`🔹 Derived ${label}: ${pda.toBase58()}`);
  return pda;
}

function createAtaIdempotentIx({ payer, ata, owner, mint }) {
  // spl-associated-token-account v1 "create idempotent" discriminator is 1 byte = 1
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  };
}

async function getInfo(conn, key, options = {}) {
  // Try different commitment levels for system programs
  // Some RPCs may not serve system programs with 'finalized' commitment
  const commitments = options.commitments || ['confirmed', 'finalized'];
  
  for (const commitment of commitments) {
    try {
      const info = await conn.getAccountInfo(key, { commitment });
      if (info) return info;
    } catch (error) {
      // Continue to try next commitment level
      continue;
    }
  }
  
  // If we tried all commitments and got no result, return null
  // System programs should always be available, so this might indicate an RPC issue
  return null;
}

async function auditIxAccounts(conn, items) {
  // Try multiple commitment levels for account checks
  let infos = null;
  let rpcError = null;
  
  // Try confirmed first (more lenient), then finalized
  for (const commitment of ['confirmed', 'finalized']) {
    try {
      infos = await conn.getMultipleAccountsInfo(items.map((x) => x.key), { commitment });
      break; // Success, break out of loop
    } catch (error) {
      rpcError = error;
      // Try next commitment level
    }
  }
  
  if (!infos) {
    console.error('❌ Failed to fetch account information from RPC');
    if (rpcError) console.error(`   RPC error: ${rpcError.message}`);
    return false;
  }
  
  let ok = true;
  for (let i = 0; i < items.length; i++) {
    const { label, key, expectOwner, optional } = items[i];
    const info = infos[i];
    if (!info) {
      if (optional) {
        console.log(`🟡 ${label}: MISSING (optional) — ${key.toBase58()}`);
        continue;
      }
      console.error(`❌ ${label}: MISSING — ${key.toBase58()}`);
      console.error(`   This account is required for the transaction. Verify it exists on-chain.`);
      ok = false;
      continue;
    }
    const owner = info.owner.toBase58();
    console.log(`✅ ${label}: exists — ${key.toBase58()} (owner=${owner})`);
    if (expectOwner && !info.owner.equals(expectOwner)) {
      console.error(`❌ ${label}: owned by ${owner}, expected ${expectOwner.toBase58()}`);
      console.error(`   Account ownership mismatch - verify the correct accounts are being used.`);
      ok = false;
    }
  }
  return ok;
}

function splitSimError(sim) {
  // Return a concise reason and which instruction index failed, if present
  if (!sim?.value) return { idx: null, msg: 'no simulation value' };
  if (sim.value.err && typeof sim.value.err === 'object' && 'InstructionError' in sim.value.err) {
    const [idx, detail] = sim.value.err.InstructionError;
    return { idx, msg: JSON.stringify(detail) };
  }
  return { idx: null, msg: JSON.stringify(sim.value.err ?? null) };
}

// ---------- Main ----------
async function main() {
  const RPC_URL = reqEnv('RPC_URL');
  const PROGRAM_ID = pk(reqEnv('PROGRAM_ID'));
  const OWNER = pk(reqEnv('OWNER'));

  const TEST_POOL = pk(reqEnv('TEST_POOL'));
  const TEST_CUSTODY = pk(reqEnv('TEST_CUSTODY'));
  const TEST_COLLATERAL_CUSTODY = pk(reqEnv('TEST_COLLATERAL_CUSTODY'));
  const TEST_INPUT_MINT = pk(reqEnv('TEST_INPUT_MINT'));

  const SIZE_USD_DELTA = bn(process.env.SIZE_USD_DELTA ?? 1_000_000n);
  const COLLATERAL_TOKENS = bn(process.env.COLLATERAL_TOKENS ?? 1_000_000n);
  const PRICE_SLIPPAGE_BPS = bn(process.env.PRICE_SLIPPAGE_BPS ?? 50n);
  const SIDE = process.env.SIDE?.toLowerCase() === 'short' ? 0 : 1;

  const LIVE = process.env.LIVE === '1';
  const ONLY_CREATE_ATAS = process.env.ONLY_CREATE_ATAS === '1';
  const WALLET_JSON = process.env.WALLET_JSON ?? './perps-wallet.json';

  const connection = new Connection(RPC_URL, { commitment: 'finalized' });

  console.log('✅ Loaded Jupiter Perps ESM module');
  console.log('🌐 RPC:', RPC_URL);
  console.log('🧠 Program ID:', PROGRAM_ID.toBase58());
  console.log('👤 Wallet:', OWNER.toBase58());

  // Quick hard check for the Associated Token Program on your RPC
  {
    console.log('🔍 Checking RPC connectivity and Associated Token Program availability...');
    let atokInfo = null;
    let rpcError = null;
    
    try {
      // Try with multiple commitment levels, starting with confirmed (more lenient)
      atokInfo = await getInfo(connection, ASSOCIATED_TOKEN_PROGRAM_ID, {
        commitments: ['confirmed', 'finalized']
      });
    } catch (error) {
      rpcError = error;
      console.error('⚠️ RPC error during account check:', error.message);
    }
    
    if (!atokInfo) {
      console.error(
        `❌ Associated Token Program account not found on this RPC: ${ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()}\n` +
        `   RPC URL: ${RPC_URL}\n` +
        (rpcError ? `   Error details: ${rpcError.message}\n` : '') +
        `   Troubleshooting:\n` +
        `   - Verify your RPC endpoint is accessible\n` +
        `   - Some RPCs may not serve system program accounts with 'finalized' commitment\n` +
        `   - Try using 'confirmed' commitment level or a different RPC provider\n` +
        `   - Recommended RPCs: QuickNode, Helius, GenesysGo, or official Solana RPC\n`
      );
      process.exit(1);
    }
    
    // Not strictly necessary to check owner here, but helpful:
    const atokOwner = atokInfo.owner.toBase58();
    if (!atokInfo.executable) {
      console.error(
        `❌ Associated Token Program is not executable on this RPC (owner=${atokOwner}).\n` +
        `   This indicates an RPC issue. System programs should always be executable.\n`
      );
      process.exit(1);
    }
    console.log(`✅ Associated Token Program verified (owner=${atokOwner}, executable=true)`);
  }

  // ---------- Derive PDAs ----------
  const PERPETUALS_PDA = derivePda([Buffer.from('perpetuals')], PROGRAM_ID, 'perpetuals');
  const POSITION_PDA = derivePda(
    [Buffer.from('position'), OWNER.toBuffer(), TEST_POOL.toBuffer()],
    PROGRAM_ID,
    'position'
  );
  const POSITION_REQ_PDA = derivePda(
    [Buffer.from('position-request'), OWNER.toBuffer(), TEST_POOL.toBuffer()],
    PROGRAM_ID,
    'positionRequest'
  );
  const EVENT_AUTHORITY_PDA = derivePda([Buffer.from('__event_authority')], PROGRAM_ID, 'eventAuthority');

  const FUNDING_ATA = deriveAta(OWNER, TEST_INPUT_MINT);
  const POSITION_REQ_ATA = deriveAta(POSITION_REQ_PDA, TEST_INPUT_MINT);

  // ---------- Ensure ATAs ----------
  const preIxs = [];
  const [fundInfo, prInfo] = await Promise.all([
    getInfo(connection, FUNDING_ATA),
    getInfo(connection, POSITION_REQ_ATA),
  ]);

  if (!fundInfo) {
    console.log('🧰 Funding ATA does not exist — will create idempotently');
    preIxs.push(createAtaIdempotentIx({ payer: OWNER, ata: FUNDING_ATA, owner: OWNER, mint: TEST_INPUT_MINT }));
  } else {
    console.log('✅ Funding ATA exists:', FUNDING_ATA.toBase58());
  }
  if (!prInfo) {
    console.log('🧰 positionRequest ATA does not exist — will create idempotently');
    preIxs.push(
      createAtaIdempotentIx({
        payer: OWNER,
        ata: POSITION_REQ_ATA,
        owner: POSITION_REQ_PDA,
        mint: TEST_INPUT_MINT,
      })
    );
  } else {
    console.log('✅ positionRequest ATA exists:', POSITION_REQ_ATA.toBase58());
  }

  // ---------- Encode Market Request ----------
  const args = {
    sizeUsdDelta: SIZE_USD_DELTA,
    collateralTokenDelta: COLLATERAL_TOKENS,
    side: SIDE,
    priceSlippage: PRICE_SLIPPAGE_BPS,
    jupiterMinimumOut: { __option: 'None' },
    counter: 0n,
  };
  console.log('🧩 Encoder Debug — encoder fields populated:');
  console.log(JSON.stringify(args, (_, v) => (typeof v === 'bigint' ? `${v}n` : v), 2));
  const encoder = JUP.getCreateIncreasePositionMarketRequestInstructionDataEncoder();
  const data = encoder.encode(args);
  console.log('📏 Encoded data length:', data.length);

  // Accounts as required by SDK for CreateIncreasePositionMarketRequest
  const REFERRAL = OWNER; // self-referral (ok)
  const perpsIx = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: OWNER, isSigner: true, isWritable: true },              // owner
      { pubkey: FUNDING_ATA, isSigner: false, isWritable: true },       // fundingAccount (ATA)
      { pubkey: PERPETUALS_PDA, isSigner: false, isWritable: false },   // perpetuals
      { pubkey: TEST_POOL, isSigner: false, isWritable: true },         // pool
      { pubkey: POSITION_PDA, isSigner: false, isWritable: true },      // position (PDA)
      { pubkey: POSITION_REQ_PDA, isSigner: false, isWritable: true },  // positionRequest (PDA)
      { pubkey: POSITION_REQ_ATA, isSigner: false, isWritable: true },  // positionRequest ATA
      { pubkey: TEST_CUSTODY, isSigner: false, isWritable: true },      // custody
      { pubkey: TEST_COLLATERAL_CUSTODY, isSigner: false, isWritable: true }, // collateral custody
      { pubkey: TEST_INPUT_MINT, isSigner: false, isWritable: false },  // input mint
      { pubkey: REFERRAL, isSigner: false, isWritable: false },         // referral
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // ata program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },     // system program
      { pubkey: EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },         // event authority (PDA)
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },       // program meta
    ],
    data,
  };

  // ---------- Audit (finalized) ----------
  console.log('🔍 Auditing instruction accounts (existence & owners)…');
  const auditOk = await auditIxAccounts(connection, [
    { label: 'owner', key: OWNER },
    { label: 'funding_ata', key: FUNDING_ATA, expectOwner: TOKEN_PROGRAM_ID, optional: true },
    { label: 'perpetuals', key: PERPETUALS_PDA, expectOwner: PROGRAM_ID },
    { label: 'pool', key: TEST_POOL, expectOwner: PROGRAM_ID },
    { label: 'position', key: POSITION_PDA, optional: true },
    { label: 'position_request', key: POSITION_REQ_PDA, optional: true },
    { label: 'position_req_ata', key: POSITION_REQ_ATA, expectOwner: TOKEN_PROGRAM_ID, optional: true },
    { label: 'custody', key: TEST_CUSTODY, expectOwner: PROGRAM_ID },
    { label: 'collateral_custody', key: TEST_COLLATERAL_CUSTODY, expectOwner: PROGRAM_ID },
    { label: 'input_mint', key: TEST_INPUT_MINT },
    { label: 'referral', key: REFERRAL },
    { label: 'token_program', key: TOKEN_PROGRAM_ID, expectOwner: TOKEN_LOADER },
    { label: 'associated_token_program', key: ASSOCIATED_TOKEN_PROGRAM_ID, expectOwner: UPGRADEABLE_LOADER }, // <- now required to exist
    { label: 'system_program', key: SystemProgram.programId, expectOwner: NATIVE_LOADER },
    { label: 'event_authority', key: EVENT_AUTHORITY_PDA, optional: true },
    { label: 'program_meta', key: PROGRAM_ID, expectOwner: UPGRADEABLE_LOADER },
  ]);
  if (!auditOk) {
    console.error('❌ Audit failed — fix the missing/mis-owned accounts above and re-run.');
    process.exit(1);
  }

  // ---------- Build message ----------
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const ixs = ONLY_CREATE_ATAS ? [...preIxs] : [...preIxs, perpsIx];
  const msg = new TransactionMessage({
    payerKey: OWNER,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);

  // ---------- Simulate ----------
  console.log('🧪 Simulating transaction...');
  let sim;
  try {
    sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
  } catch (error) {
    console.error('❌ Simulation failed with RPC error:', error.message);
    console.error('   This could indicate RPC connectivity issues or network problems.');
    console.error('   Try:');
    console.error('   - Checking your RPC endpoint is accessible');
    console.error('   - Verifying network connectivity');
    console.error('   - Trying a different RPC provider');
    process.exit(1);
  }
  
  if (sim.value.err) {
    const det = splitSimError(sim);
    console.error('❌ Simulation error:', JSON.stringify(sim.value.err, null, 2));
    if (det.idx !== null) {
      console.error(`   ↳ Failed at instruction index ${det.idx} (0-based).`);
      const instructionType = ONLY_CREATE_ATAS 
        ? 'ATA creation' 
        : det.idx < preIxs.length 
          ? `ATA creation (pre-instruction ${det.idx})` 
          : 'Perps position request';
      console.error(`   ↳ Instruction type: ${instructionType}`);
      
      if (ONLY_CREATE_ATAS) {
        console.error('   ↳ In ATA-only mode: If this fails, your RPC may not be serving the Associated Token Program properly.');
      } else {
        console.error(`   ↳ Pre-instructions (0-${preIxs.length - 1}): ATA creation(s)`);
        console.error(`   ↳ Main instruction (${preIxs.length}): Perps position request`);
      }
    }
    
    if (sim.value.logs?.length) {
      console.error('   Program logs:');
      console.error('   ' + sim.value.logs.join('\n   '));
    }
    
    console.error('\n   Troubleshooting:');
    console.error('   - Verify all required accounts exist and have correct owners');
    console.error('   - Check account balances and permissions');
    console.error('   - Verify instruction parameters are valid');
    process.exit(1);
  }
  
  const computeUnits = sim.value.unitsConsumed ?? 'unknown';
  console.log(`✅ Simulation OK. Compute units used: ${computeUnits}`);

  if (ONLY_CREATE_ATAS) {
    console.log('ℹ️ ONLY_CREATE_ATAS=1 — not sending perps request in this mode.');
    if (!LIVE) {
      console.log('ℹ️ Set LIVE=1 to actually create the ATAs on-chain.');
      return;
    }
  } else if (!LIVE) {
    console.log('ℹ️ LIVE=0 — not broadcasting. Set LIVE=1 to send.');
    return;
  }

  // ---------- Send (live) ----------
  const secret = JSON.parse(fs.readFileSync(WALLET_JSON, 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const { blockhash: bh2 } = await connection.getLatestBlockhash('finalized');
  const msg2 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: bh2,
    instructions: ixs,
  }).compileToV0Message();
  const vtx2 = new VersionedTransaction(msg2);
  vtx2.sign([payer]);

  try {
    console.log('📤 Broadcasting transaction...');
    const sig = await connection.sendRawTransaction(vtx2.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    console.log('✅ Transaction sent successfully!');
    console.log(`   Signature: ${sig}`);
    console.log(`   View on Solana Explorer: https://solana.fm/tx/${sig}`);
  } catch (e) {
    console.error('❌ Broadcast failed:', e.message);
    if (e.message.includes('timeout') || e.message.includes('network')) {
      console.error('   Network/RPC error detected. Try:');
      console.error('   - Checking RPC endpoint connectivity');
      console.error('   - Verifying your network connection');
      console.error('   - Using a different RPC provider');
    } else if (e.message.includes('insufficient') || e.message.includes('balance')) {
      console.error('   Balance/lamports error detected. Verify:');
      console.error('   - Your wallet has sufficient SOL for transaction fees');
      console.error('   - Account balances are sufficient for the operation');
    } else {
      console.error('   Error details:', e);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌ Main flow error:', e.message || e);
  if (e.stack) {
    console.error('   Stack trace:');
    console.error('   ' + e.stack.split('\n').slice(1, 5).join('\n   ')); // Show first few stack frames
  }
  if (e.message?.includes('Missing required env')) {
    console.error('\n   Troubleshooting:');
    console.error('   - Ensure all required environment variables are set in .env file');
    console.error('   - Required env vars: RPC_URL, PROGRAM_ID, OWNER, TEST_POOL, TEST_CUSTODY, TEST_COLLATERAL_CUSTODY, TEST_INPUT_MINT');
  }
  process.exit(1);
});


