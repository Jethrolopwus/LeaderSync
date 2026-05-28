import { Connection } from '@solana/web3.js';

const FALLBACK_JITO_VALIDATORS = new Set([
  'GZctHpWXmsZC1YHACTGGcHhYxjdRqQARTHebnAXFSVbK',
  'J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8BGUJ17v',
  'Fv5GiCXJKnMxEMMbMFkpBGFBkCRqFBBgBKoMnTCCCnNa',
  'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy',
]);

let jitoValidators = new Set(FALLBACK_JITO_VALIDATORS);
let validatorRefreshAt = 0;
const VALIDATOR_REFRESH_MS = 10 * 60 * 1000; 

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
    
  }
}

export interface LeaderScheduleCache {
  epochFirstSlot: number;   
  slotsPerEpoch: number;
  jitoSlots: number[];
  fetchedAt: number;
}

let cache: LeaderScheduleCache | null = null;

export async function getLeaderSchedule(connection: Connection, currentSlot: number): Promise<LeaderScheduleCache> {

  if (cache && currentSlot < cache.epochFirstSlot + cache.slotsPerEpoch) {
    return cache;
  }

  await refreshJitoValidators();

  const epochInfo = await connection.getEpochInfo('confirmed');
  const epochFirstSlot = currentSlot - epochInfo.slotIndex;

  const schedule = await connection.getLeaderSchedule();
  if (!schedule) {
    
    return cache ?? { epochFirstSlot, slotsPerEpoch: epochInfo.slotsInEpoch, jitoSlots: [], fetchedAt: Date.now() };
  }

  const jitoSlots: number[] = [];
  for (const [validator, relativeSlots] of Object.entries(schedule)) {
    if (jitoValidators.has(validator)) {
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


export function findNextJitoSlot(currentSlot: number, jitoSlots: number[]): number | null {
  return jitoSlots.find(s => s > currentSlot) ?? null;
}

export function isInSubmissionWindow(currentSlot: number, nextJitoSlot: number): boolean {
  const delta = nextJitoSlot - currentSlot;
  return delta >= 2 && delta <= 4;
}
