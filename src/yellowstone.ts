import { EventEmitter } from 'events';

// Jito tip accounts (mainnet)
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'r3mEwJ3X3KFHPKqU2688dHMCApFAGbGQAkjCgCKBBBw',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
];

export interface SlotUpdate {
  slot: number;
  parent: number;
  status: 'processed' | 'confirmed' | 'finalized';
  timestamp: number;
}

export interface TipAccountUpdate {
  pubkey: string;
  lamports: bigint;
  slot: number;
}

export interface StreamState {
  currentSlot: number;
  tipBalances: Map<string, bigint>;
  recentSlots: SlotUpdate[];
}

/**
 * YellowstoneClient wraps @triton-one/yellowstone-grpc.
 * It emits 'slot' and 'tip' events consumed by the rest of the stack.
 * When the real gRPC package is unavailable it falls back to RPC polling.
 */
export class YellowstoneClient extends EventEmitter {
  private endpoint: string;
  private token: string;
  private rpcUrl: string;
  private client: any = null;
  private pollInterval: NodeJS.Timeout | null = null;

  readonly state: StreamState = {
    currentSlot: 0,
    tipBalances: new Map(),
    recentSlots: [],
  };

  constructor(endpoint: string, token: string, rpcUrl: string) {
    super();
    this.endpoint = endpoint;
    this.token = token;
    this.rpcUrl = rpcUrl;
  }

  async connect(): Promise<void> {
    try {
      // Try real Yellowstone gRPC first
      const { default: Client } = await import('@triton-one/yellowstone-grpc');
      this.client = new Client(this.endpoint, this.token, {});
      await this._subscribeGrpc();
      console.log('[Yellowstone] Connected via gRPC');
    } catch {
      // Fallback: poll via JSON-RPC
      console.warn('[Yellowstone] gRPC unavailable — falling back to RPC polling');
      this._startRpcPolling();
    }
  }

  private async _subscribeGrpc(): Promise<void> {
    const stream = await this.client.subscribe();

    stream.on('data', (data: any) => {
      // Slot update
      if (data.slotStatus) {
        const s = data.slotStatus;
        const update: SlotUpdate = {
          slot: Number(s.slot),
          parent: Number(s.parent ?? 0),
          status: s.status?.toLowerCase() ?? 'processed',
          timestamp: Date.now(),
        };
        this._handleSlot(update);
      }
      // Account update (tip accounts)
      if (data.account?.account) {
        const acc = data.account.account;
        const pubkey: string = acc.pubkey;
        if (JITO_TIP_ACCOUNTS.includes(pubkey)) {
          const tip: TipAccountUpdate = {
            pubkey,
            lamports: BigInt(acc.lamports ?? 0),
            slot: Number(acc.slot ?? this.state.currentSlot),
          };
          this._handleTip(tip);
        }
      }
    });

    // Subscribe to slots + tip accounts
    await stream.write({
      slots: { slotStatus: {} },
      accounts: {
        account: {
          account: JITO_TIP_ACCOUNTS,
          filters: [],
          dataSlice: null,
          nonemptyTxnSignature: null,
        },
      },
    });
  }

  private _startRpcPolling(): void {
    const poll = async () => {
      try {
        const slotRes = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'processed' }] }),
        });
        const { result: slot } = await slotRes.json() as any;

        const update: SlotUpdate = { slot, parent: slot - 1, status: 'processed', timestamp: Date.now() };
        this._handleSlot(update);

        // Poll tip account balances
        for (const pubkey of JITO_TIP_ACCOUNTS.slice(0, 2)) {
          const balRes = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey, { commitment: 'processed' }] }),
          });
          const { result } = await balRes.json() as any;
          this._handleTip({ pubkey, lamports: BigInt(result?.value ?? 0), slot });
        }
      } catch (e) {
        console.error('[Yellowstone] Poll error:', e);
      }
    };

    poll();
    this.pollInterval = setInterval(poll, 400); 
  }

  private _handleSlot(update: SlotUpdate): void {
    this.state.currentSlot = Math.max(this.state.currentSlot, update.slot);
    this.state.recentSlots.push(update);
    if (this.state.recentSlots.length > 100) this.state.recentSlots.shift();
    this.emit('slot', update);
  }

  private _handleTip(update: TipAccountUpdate): void {
    this.state.tipBalances.set(update.pubkey, update.lamports);
    this.emit('tip', update);
  }

  disconnect(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.client) this.client.close?.();
  }
}
