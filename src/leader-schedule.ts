import { Connection } from '@solana/web3.js';

// Refreshed periodically from https://jito.wtf/api/validators
// Seeded with known mainnet Jito validators as fallback.
const FALLBACK_JITO_VALIDATORS = new Set([
  'GZctHpWXmsZC1YHACTGGcHhYxjdRqQARTHebnAXFSVbK',
  'J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8BGUJ17v',
  'Fv5GiCXJKnMxEMMbMFkpBGFBkCRqFBBgBKoMnTCCCnNa',
  'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy',
]);

let jitoValidators = new Set(FALLBACK_JITO_VALIDATORS);
let validatorRefreshAt = 0;
const VALIDATOR_REFRESH_MS = 10 * 60 * 1000; // 10 min

async function refreshJitoValidators(): Promise<void> {
  if (Date.now() - validatorRefreshAt < VALIDATOR_REFRESH_MS) return;
  try {
    const res = await fetch('https://jito.wtf/api/validators', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const data = await res.json() as any[];
    const pubkeys = data.map((v: any) => v.vote_account ?? v.voteAccount ?? v.pubkey).filter(Boolean);
    if (pubkeys.length > 0) {
      jitoValidators = new Set(pubkeys);
      validatorRefreshAt = Date.now();
      console.log(`[LeaderSchedule] Refreshed ${jitoValidators.size} Jito validators`);
    }
  } catch {
    // keep existing set on failure
  }
}

export interface LeaderScheduleCache {
  epochFirstSlot: number;   // absolute slot of epoch start
  slotsPerEpoch: number;
  // absolute Jito leader slots for this epoch, sorted ascending
  jitoSlots: number[];
  fetchedAt: number;
}

let cache: LeaderScheduleCache | null = null;

export async function getLeaderSchedule(connection: Connection, currentSlot: number): Promise<LeaderScheduleCache> {
  // Refresh at epoch boundaries or on first call
  if (cache && currentSlot < cache.epochFirstSlot + cache.slotsPerEpoch) {
    return cache;
  }

  await refreshJitoValidators();

  const epochInfo = await connection.getEpochInfo('confirmed');
  const epochFirstSlot = currentSlot - epochInfo.slotIndex;

  // getLeaderSchedule() returns relative indices for the current epoch
  const schedule = await connection.getLeaderSchedule();
  if (!schedule) {
    // Return stale cache or empty
    return cache ?? { epochFirstSlot, slotsPerEpoch: epochInfo.slotsInEpoch, jitoSlots: [], fetchedAt: Date.now() };
  }

  const jitoSlots: number[] = [];
  for (const [validator, relativeSlots] of Object.entries(schedule)) {
    if (jitoValidators.has(validator)) {
      // Convert relative indices → absolute slot numbers
      for (const rel of relativeSlots) {
        jitoSlots.push(epochFirstSlot + rel);
      }
    }
  }
  jitoSlots.sort((a, b) => a - b);

  cache = {
    epochFirstSlot,
    slotsPerEpoch: epochInfo.slotsInEpoch,
    jitoSlots,
    fetchedAt: Date.now(),
  };

  console.log(`[LeaderSchedule] Epoch ${epochInfo.epoch}: ${jitoSlots.length} Jito leader slots (first absolute: ${epochFirstSlot})`);
  return cache;
}

/**
 * Returns the next Jito leader slot strictly after currentSlot, or null.
 */
export function findNextJitoSlot(currentSlot: number, jitoSlots: number[]): number | null {
  return jitoSlots.find(s => s > currentSlot) ?? null;
}

/**
 * True when we're 2–4 slots before the start of a Jito leader window.
 * Each leader gets 4 consecutive slots; submit at the earliest opportunity.
 */
export function isInSubmissionWindow(currentSlot: number, nextJitoSlot: number): boolean {
  const delta = nextJitoSlot - currentSlot;
  return delta >= 2 && delta <= 4;
}
