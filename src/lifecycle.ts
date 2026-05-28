import { Connection } from '@solana/web3.js';
import * as fs from 'fs';

export type Commitment = 'processed' | 'confirmed' | 'finalized';
export type FailureType =
  | 'BLOCKHASH_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'COMPUTE_BUDGET_EXCEEDED'
  | 'BUNDLE_DROPPED'
  | 'SIMULATION_FAILED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface LifecycleEntry {
  bundleId: string;
  signature: string;
  tipLamports: number;
  submittedSlot: number;
  submittedAt: number;
  expectedLeaderSlot?: number;  // the Jito leader slot we targeted
  processedAt?: number;
  confirmedAt?: number;
  finalizedAt?: number;
  processedSlot?: number;
  confirmedSlot?: number;
  finalizedSlot?: number;
  // deltas in ms
  processedDelta?: number;   // submittedAt → processedAt
  confirmedDelta?: number;   // processedAt → confirmedAt
  finalizedDelta?: number;   // confirmedAt → finalizedAt
  status: 'pending' | 'landed' | 'failed';
  failureType?: FailureType;
  failureReason?: string;
  aiDecision?: AiDecision;
}

export interface AiDecision {
  action: 'retry' | 'abort';
  newTip: number;
  reasoning: string;
  confidence: number;
}

const LOG_FILE = './lifecycle-log.json';

export class LifecycleTracker {
  private entries: Map<string, LifecycleEntry> = new Map();
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
    this._loadFromDisk();
  }

  track(entry: Omit<LifecycleEntry, 'status'>): void {
    this.entries.set(entry.bundleId, { ...entry, status: 'pending' });
    this._saveToDisk();
    console.log(`[Lifecycle] Tracking bundle ${entry.bundleId} | sig: ${entry.signature}`);
  }

  async poll(bundleId: string, currentSlot?: number): Promise<LifecycleEntry | null> {
    const entry = this.entries.get(bundleId);
    if (!entry || entry.status !== 'pending') return entry ?? null;

    try {
      const statuses = await this.connection.getSignatureStatuses([entry.signature], { searchTransactionHistory: true });
      const status = statuses.value[0];

      if (!status) {
        // Slot-based skip detection: 6 slots past expected leader slot
        const slotSkipped = entry.expectedLeaderSlot != null && currentSlot != null
          && currentSlot > entry.expectedLeaderSlot + 6;
        // Wall-clock fallback: 60s with no confirmation
        const timedOut = Date.now() - entry.submittedAt > 60_000;

        if (slotSkipped || timedOut) {
          entry.status = 'failed';
          entry.failureType = 'BUNDLE_DROPPED';
          entry.failureReason = slotSkipped
            ? `Leader skipped slot ${entry.expectedLeaderSlot} (current: ${currentSlot})`
            : 'No confirmation within 60s — leader likely skipped slot';
          this._log(entry);
        }
        return entry;
      }

      const now = Date.now();

      if (status.confirmationStatus === 'processed' && !entry.processedAt) {
        entry.processedAt = now;
        entry.processedSlot = status.slot;
        entry.processedDelta = now - entry.submittedAt;
        console.log(`[Lifecycle] ${bundleId} PROCESSED | slot ${status.slot} | +${entry.processedDelta}ms`);
      }

      if (status.confirmationStatus === 'confirmed' && !entry.confirmedAt) {
        entry.confirmedAt = now;
        entry.confirmedSlot = status.slot;
        entry.confirmedDelta = entry.processedAt ? now - entry.processedAt : undefined;
        console.log(`[Lifecycle] ${bundleId} CONFIRMED | slot ${status.slot} | +${entry.confirmedDelta}ms since processed`);
      }

      if (status.confirmationStatus === 'finalized') {
        entry.finalizedAt = now;
        entry.finalizedSlot = status.slot;
        entry.finalizedDelta = entry.confirmedAt ? now - entry.confirmedAt : undefined;
        entry.status = 'landed';
        console.log(`[Lifecycle] ${bundleId} FINALIZED | slot ${status.slot} | +${entry.finalizedDelta}ms since confirmed`);
        this._log(entry);
      }

      if (status.err) {
        entry.status = 'failed';
        entry.failureType = classifyError(status.err);
        entry.failureReason = JSON.stringify(status.err);
        this._log(entry);
      }
    } catch (e: any) {
      console.error('[Lifecycle] Poll error:', e.message);
    }

    this._saveToDisk();
    return entry;
  }

  getAll(): LifecycleEntry[] {
    return [...this.entries.values()];
  }

  getLanded(): LifecycleEntry[] {
    return this.getAll().filter(e => e.status === 'landed');
  }

  private _log(entry: LifecycleEntry): void {
    const icon = entry.status === 'landed' ? '✅' : '❌';
    console.log(`\n${icon} [Lifecycle] Bundle ${entry.bundleId} → ${entry.status.toUpperCase()}`);
    if (entry.status === 'landed') {
      console.log(`   processed→confirmed delta : ${entry.confirmedDelta ?? '?'}ms`);
      console.log(`   confirmed→finalized delta : ${entry.finalizedDelta ?? '?'}ms`);
    } else {
      console.log(`   Failure: ${entry.failureType} — ${entry.failureReason}`);
    }
  }

  private _saveToDisk(): void {
    fs.writeFileSync(LOG_FILE, JSON.stringify([...this.entries.values()], null, 2));
  }

  private _loadFromDisk(): void {
    if (!fs.existsSync(LOG_FILE)) return;
    try {
      const data: LifecycleEntry[] = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
      data.forEach(e => this.entries.set(e.bundleId, e));
      console.log(`[Lifecycle] Loaded ${data.length} entries from disk`);
    } catch { /* ignore corrupt file */ }
  }
}

export function classifyError(err: any): FailureType {
  const msg = JSON.stringify(err).toLowerCase();
  if (msg.includes('blockhash') || msg.includes('blockhashnot')) return 'BLOCKHASH_NOT_FOUND';
  if (msg.includes('insufficientfunds') || msg.includes('insufficient funds')) return 'INSUFFICIENT_FUNDS';
  if (msg.includes('computebudget') || msg.includes('compute budget')) return 'COMPUTE_BUDGET_EXCEEDED';
  if (msg.includes('simulation')) return 'SIMULATION_FAILED';
  if (msg.includes('dropped') || msg.includes('bundle')) return 'BUNDLE_DROPPED';
  return 'UNKNOWN';
}
