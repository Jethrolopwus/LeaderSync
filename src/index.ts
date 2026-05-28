import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { YellowstoneClient } from './yellowstone';
import { computeTipStats, suggestBaseTip } from './tip-calculator';
import { buildAndSendBundle } from './bundle-builder';
import { LifecycleTracker, LifecycleEntry } from './lifecycle';
import { runAiAgent } from './ai-agent';
import { getLeaderSchedule, findNextJitoSlot, isInSubmissionWindow } from './leader-schedule';

const {
  SOLANA_RPC_URL,
  YELLOWSTONE_ENDPOINT,
  YELLOWSTONE_TOKEN,
  JITO_BLOCK_ENGINE_URL,
  WALLET_PRIVATE_KEY,
  DESTINATION_PUBKEY,
  TRANSFER_AMOUNT_LAMPORTS,
} = process.env as Record<string, string>;

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;
const TARGET_SUBMISSIONS = 10;
const WINDOW_WAIT_TIMEOUT_MS = 30_000; // max wait for a Jito window

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Waits until the Yellowstone slot stream enters a Jito submission window.
 * Returns the target leader slot, or null on timeout.
 */
async function waitForJitoWindow(
  yellowstone: YellowstoneClient,
  connection: Connection,
): Promise<number | null> {
  const schedule = await getLeaderSchedule(connection, yellowstone.state.currentSlot);

  return new Promise<number | null>(resolve => {
    const deadline = setTimeout(() => {
      yellowstone.off('slot', onSlot);
      console.warn('[Main] Timed out waiting for Jito window — submitting anyway');
      resolve(null);
    }, WINDOW_WAIT_TIMEOUT_MS);

    const onSlot = async () => {
      const current = yellowstone.state.currentSlot;

      // Refresh schedule at epoch boundary
      const fresh = await getLeaderSchedule(connection, current);
      const nextJitoSlot = findNextJitoSlot(current, fresh.jitoSlots);

      if (!nextJitoSlot) return; // no upcoming Jito slots this epoch

      if (isInSubmissionWindow(current, nextJitoSlot)) {
        clearTimeout(deadline);
        yellowstone.off('slot', onSlot);
        console.log(`[Main] 🎯 Jito window: current=${current}, leader=${nextJitoSlot} (${nextJitoSlot - current} slots away)`);
        resolve(nextJitoSlot);
      }
    };

    yellowstone.on('slot', onSlot);
    // Check immediately in case we're already in a window
    onSlot();
  });
}

async function main() {
  console.log('🚀 Jito Bundle Agent starting...\n');

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const payer = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
  const destination = new PublicKey(DESTINATION_PUBKEY);
  const transferLamports = parseInt(TRANSFER_AMOUNT_LAMPORTS ?? '1000');

  const yellowstone = new YellowstoneClient(YELLOWSTONE_ENDPOINT, YELLOWSTONE_TOKEN, SOLANA_RPC_URL);
  const tracker = new LifecycleTracker(connection);

  await yellowstone.connect();

  // Wait for first slot
  await new Promise<void>(resolve => {
    const onSlot = () => { yellowstone.off('slot', onSlot); resolve(); };
    yellowstone.on('slot', onSlot);
    setTimeout(resolve, 5000);
  });

  console.log(`[Main] Current slot: ${yellowstone.state.currentSlot}`);

  // Fetch initial leader schedule
  await getLeaderSchedule(connection, yellowstone.state.currentSlot);

  let submissionCount = 0;

  while (submissionCount < TARGET_SUBMISSIONS) {
    submissionCount++;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Main] Submission ${submissionCount}/${TARGET_SUBMISSIONS}`);

    // ── Wait for Jito leader window ──
    const targetLeaderSlot = await waitForJitoWindow(yellowstone, connection);

    let attempt = 0;
    let lastEntry: LifecycleEntry | null = null;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;

      const tipStats = computeTipStats(yellowstone.state);
      let tipLamports = suggestBaseTip(tipStats);

      if (lastEntry?.aiDecision?.action === 'retry') {
        tipLamports = lastEntry.aiDecision.newTip;
      }

      console.log(`\n[Main] Attempt ${attempt} | tip: ${tipLamports} lamports | congestion: ${tipStats.congestion}`);

      try {
        const result = await buildAndSendBundle(
          connection,
          payer,
          destination,
          transferLamports,
          tipLamports,
          JITO_BLOCK_ENGINE_URL,
          yellowstone.state.currentSlot,
        );

        console.log(`[Main] Bundle submitted: ${result.bundleId}`);

        tracker.track({
          bundleId: result.bundleId,
          signature: result.signature,
          tipLamports: result.tipLamports,
          submittedSlot: result.slot,
          submittedAt: result.submittedAt,
          expectedLeaderSlot: targetLeaderSlot ?? undefined,
        });

        // Poll until landed or failed, passing current slot for skip detection
        let entry: LifecycleEntry | null = null;
        for (let p = 0; p < 30; p++) {
          await sleep(POLL_INTERVAL_MS);
          entry = await tracker.poll(result.bundleId, yellowstone.state.currentSlot);
          if (entry?.status !== 'pending') break;
        }

        lastEntry = entry;

        if (entry?.status === 'landed') {
          console.log(`[Main] ✅ Bundle landed on attempt ${attempt}`);
          break;
        }

        if (entry?.status === 'failed') {
          const decision = await runAiAgent(
            entry.failureType ?? 'UNKNOWN',
            entry.failureReason ?? '',
            tipStats,
            yellowstone.state.currentSlot,
            entry,
            attempt,
          );

          entry.aiDecision = decision;

          if (decision.action === 'abort') {
            console.log(`[Main] 🛑 AI agent aborted after attempt ${attempt}`);
            break;
          }

          console.log(`[Main] 🔄 AI agent retrying with tip ${decision.newTip} lamports`);
          // On retry, wait for the next Jito window
          const retrySlot = await waitForJitoWindow(yellowstone, connection);
          if (retrySlot) {
            // Update the tracked entry's expected slot for the retry
            const retryEntry = tracker.getAll().find(e => e.bundleId === result.bundleId);
            if (retryEntry) retryEntry.expectedLeaderSlot = retrySlot;
          }
        }

      } catch (err: any) {
        console.error(`[Main] Bundle submission error (attempt ${attempt}):`, err.message);
        await sleep(2000);
      }
    }

    await sleep(3000);
  }

  // ── Final report ──
  const all = tracker.getAll();
  const landed = tracker.getLanded();

  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 FINAL LIFECYCLE REPORT');
  console.log(`${'═'.repeat(60)}`);
  console.log(`Total submissions : ${all.length}`);
  console.log(`Landed            : ${landed.length}`);
  console.log(`Failed            : ${all.filter(e => e.status === 'failed').length}`);

  if (landed.length > 0) {
    const avgConfirmed = landed
      .filter(e => e.confirmedDelta != null)
      .reduce((s, e) => s + e.confirmedDelta!, 0) / landed.length;
    const avgFinalized = landed
      .filter(e => e.finalizedDelta != null)
      .reduce((s, e) => s + e.finalizedDelta!, 0) / landed.length;
    console.log(`Avg processed→confirmed : ${avgConfirmed.toFixed(0)}ms`);
    console.log(`Avg confirmed→finalized : ${avgFinalized.toFixed(0)}ms`);
  }

  console.log(`\nFull log written to: lifecycle-log.json`);

  yellowstone.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
