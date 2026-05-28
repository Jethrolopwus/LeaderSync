import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import bs58 from 'bs58';
import { JITO_TIP_ACCOUNTS } from './yellowstone';

export interface BundleResult {
  bundleId: string;
  signature: string;
  tipLamports: number;
  submittedAt: number;
  slot: number;
}

function randomTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
}

export async function buildAndSendBundle(
  connection: Connection,
  payer: Keypair,
  destination: PublicKey,
  transferLamports: number,
  tipLamports: number,
  blockEngineUrl: string,
  currentSlot: number,
): Promise<BundleResult> {
  // 1. Fresh blockhash at `confirmed` (never finalized — see README)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  // 2. Main instruction: transfer to destination
  const transferIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: destination,
    lamports: transferLamports,
  });

  // 3. Tip instruction to a random Jito tip account
  const tipIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: randomTipAccount(),
    lamports: tipLamports,
  });

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [transferIx, tipIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  // 4. Submit via Jito block engine
  const searcher = searcherClient(blockEngineUrl);
  const bundle = new Bundle([tx], 5);

  const result = await searcher.sendBundle(bundle);
  if (!result.ok) throw new Error(`sendBundle failed: ${result.error.message}`);
  const bundleId = result.value;

  const signature = bs58.encode(tx.signatures[0]);

  return {
    bundleId,
    signature,
    tipLamports,
    submittedAt: Date.now(),
    slot: currentSlot,
  };
}
