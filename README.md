# Jito Bundle Agent — Architecture Document

## System Overview

A TypeScript agent that submits Solana transactions as Jito bundles with AI-driven tip optimization and full lifecycle tracking.

```
┌─────────────────────────────────────────────────────────────────┐
│                        JITO BUNDLE AGENT                        │
│                                                                 │
│  ┌──────────────┐    slot/tip     ┌──────────────────────────┐  │
│  │  Yellowstone │ ─────events───▶ │    Tip Calculator        │  │
│  │  gRPC Stream │                 │  p50 / p75 / p90         │  │
│  │  (+ RPC poll │                 │  congestion detection    │  │
│  │   fallback)  │                 └────────────┬─────────────┘  │
│  └──────────────┘                              │ suggestBaseTip │
│                                                ▼                │
│  ┌──────────────┐   tip+tx    ┌────────────────────────────┐   │
│  │  AI Agent    │◀──failure── │    Bundle Builder          │   │
│  │  (Claude     │             │  buildAndSendBundle()      │   │
│  │   Sonnet)    │             │  • confirmed blockhash     │   │
│  │              │             │  • transfer ix             │   │
│  │  Returns:    │             │  • tip ix → random Jito    │   │
│  │  action      │             │    tip account             │   │
│  │  newTip      │             │  • sign + sendBundle()     │   │
│  │  reasoning   │             └────────────┬───────────────┘   │
│  └──────┬───────┘                          │ bundleId+sig      │
│         │ retry/abort                      ▼                   │
│         │                   ┌──────────────────────────────┐   │
│         └──────────────────▶│    Lifecycle Tracker         │   │
│                              │  • polls getSignatureStatus  │   │
│                              │  • records processed_at      │   │
│                              │  • records confirmed_at      │   │
│                              │  • records finalized_at      │   │
│                              │  • computes deltas           │   │
│                              │  • classifies failures       │   │
│                              │  • persists lifecycle-log    │   │
│                              └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Breakdown

### 1. `yellowstone.ts` — Stream Client
Connects to a Yellowstone gRPC Geyser node (Triton One or self-hosted). Subscribes to:
- **Slot status updates** → feeds `currentSlot` and congestion detection
- **Jito tip account updates** → feeds real-time tip market data

Falls back to JSON-RPC polling (~400ms interval) if gRPC is unavailable.

### 2. `tip-calculator.ts` — Dynamic Tip Engine
Computes p50/p75/p90 percentiles from live tip account balances. Detects congestion by measuring inter-slot timing gaps:
- `avgGap > 800ms` → HIGH congestion → use p75+ tip
- `avgGap < 450ms` → LOW congestion → use p50 tip

### 3. `bundle-builder.ts` — Transaction Constructor
- Fetches blockhash at **`confirmed`** commitment (never `finalized` — see Q2 below)
- Builds a `SystemProgram.transfer` instruction for the payload
- Appends a tip transfer to a randomly selected Jito tip account
- Submits via `jito-ts` `searcherClient.sendBundle()`

### 4. `lifecycle.ts` — Tracker + Failure Classifier
Polls `getSignatureStatuses` every 2 seconds. Records timestamps at each commitment level and computes:
- `processedDelta` = submittedAt → processedAt
- `confirmedDelta` = processedAt → confirmedAt  
- `finalizedDelta` = confirmedAt → finalizedAt

Persists all entries to `lifecycle-log.json` for the deliverable.

**Failure classification** maps error codes to:
| Code | Meaning |
|------|---------|
| `BLOCKHASH_NOT_FOUND` | Blockhash expired before landing |
| `INSUFFICIENT_FUNDS` | Payer balance too low |
| `COMPUTE_BUDGET_EXCEEDED` | Transaction too compute-heavy |
| `BUNDLE_DROPPED` | Jito leader skipped their slot |
| `SIMULATION_FAILED` | Pre-flight simulation rejected tx |

### 5. `ai-agent.ts` — Claude-Powered Decision Engine
Calls Claude Sonnet with a structured prompt containing:
- Failure type and reason
- Live tip market (p50/p75/p90)
- Current slot and congestion level
- Whether the last bundle landed and at what tip

Returns a structured JSON decision:
```json
{
  "action": "retry",
  "newTip": 85000,
  "confidence": 0.87,
  "reasoning": "BUNDLE_DROPPED with HIGH congestion — escalating to p90 tip to outbid competing bundles"
}
```

The `reasoning` field is logged and stored in the lifecycle entry, making AI decisions fully auditable.

---

## README Answers

### Q1 — What does the `processed_at` → `confirmed_at` delta tell you?

This delta measures **cluster voting speed** — how long it takes validators to reach supermajority (>66% stake) agreement on a block after it is first seen.

- **Delta < 1s**: Healthy network, fast finality, validators are in sync
- **Delta 1–3s**: Normal range under moderate load
- **Delta > 3s**: Network stress — possible fork, high congestion, or slow validators

A large delta is a signal to increase your tip on the next submission, since validators are competing for block space and slower confirmation means more competition.

### Q2 — Why should you never use `finalized` commitment for blockhash fetches?

`finalized` commitment lags approximately **32 slots** (~13 seconds) behind the chain tip. A blockhash expires after **~150 slots** (~60 seconds).

If you fetch a blockhash at `finalized`, you have already consumed ~21% of its validity window before your transaction is even built. Under load, by the time your bundle is submitted, retried, and lands, you may have burned through the remaining window — causing `BLOCKHASH_NOT_FOUND` failures.

**Always use `confirmed`** for blockhash fetches. It is only 1–2 slots behind the tip, giving you the full ~150-slot expiry window.

### Q3 — What happens when a Jito leader skips their slot?

Your bundle is **silently dropped**. The Jito block engine queued the bundle specifically for that leader's slot. If the leader skips (goes offline, produces an empty block, or is forked out), the block engine has no fallback — the bundle is never included.

**Detection**: No `processed` confirmation within ~4 slots (~1.6s) after the expected leader window.

**Recovery strategy** (implemented in this agent):
1. Lifecycle tracker detects timeout → classifies as `BUNDLE_DROPPED`
2. AI agent receives the failure + current tip market
3. Agent decides to retry with escalated tip targeting the **next** Jito leader window
4. Bundle builder fetches a fresh blockhash and resubmits

---

## Running the Agent

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env .env.local
# Edit .env.local with your RPC, Geyser endpoint, wallet key, Anthropic key

# 3. Run
npm start
```

Output: `lifecycle-log.json` with 10+ entries including timestamps, deltas, AI decisions, and failure classifications.
