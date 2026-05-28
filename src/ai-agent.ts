import Anthropic from '@anthropic-ai/sdk';
import { TipStats } from './tip-calculator';
import { LifecycleEntry, AiDecision, FailureType } from './lifecycle';

const client = new Anthropic();

export async function runAiAgent(
  failureType: FailureType,
  failureReason: string,
  tipStats: TipStats,
  currentSlot: number,
  lastEntry: LifecycleEntry,
  attemptNumber: number,
): Promise<AiDecision> {
  const lastLanded = lastEntry.status === 'landed';

  const prompt = `You are a Solana transaction operations agent managing Jito bundle submissions.

## Current Situation
- Attempt number: ${attemptNumber}
- Failure type: ${failureType}
- Failure reason: ${failureReason}
- Current slot: ${currentSlot}
- Network congestion: ${tipStats.congestion}

## Tip Market Data (lamports)
- p50: ${tipStats.p50}
- p75: ${tipStats.p75}  
- p90: ${tipStats.p90}

## Last Bundle Result
- Status: ${lastEntry.status}
- Tip used: ${lastEntry.tipLamports} lamports
- Last landed: ${lastLanded ? 'YES' : 'NO'}
${lastEntry.confirmedDelta ? `- processed→confirmed delta: ${lastEntry.confirmedDelta}ms` : ''}

## Your Task
Decide whether to retry or abort this bundle submission, and if retrying, what tip to use.

Rules:
- BLOCKHASH_NOT_FOUND → always retry with fresh blockhash, keep same tip
- BUNDLE_DROPPED → retry with tip at least p75, leader skipped their slot
- INSUFFICIENT_FUNDS → abort, cannot fix with tip adjustment
- COMPUTE_BUDGET_EXCEEDED → abort, transaction needs to be rebuilt
- After 5 failed attempts → abort
- HIGH congestion → use at least p75 tip
- If last bundle landed at a tip, use that as floor

Respond ONLY with valid JSON, no markdown:
{"action":"retry"|"abort","newTip":<lamports>,"confidence":<0.0-1.0>,"reasoning":"<one sentence>"}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = (response.content[0] as any).text.trim();
    const decision: AiDecision = JSON.parse(text);

    console.log(`\n🤖 [AI Agent] Decision for attempt ${attemptNumber}:`);
    console.log(`   Action     : ${decision.action}`);
    console.log(`   New tip    : ${decision.newTip} lamports`);
    console.log(`   Confidence : ${(decision.confidence * 100).toFixed(0)}%`);
    console.log(`   Reasoning  : ${decision.reasoning}`);

    return decision;
  } catch (e: any) {
  
    console.warn('[AI Agent] Claude call failed, using heuristic fallback:', e.message);
    return heuristicFallback(failureType, tipStats, attemptNumber);
  }
}

function heuristicFallback(
  failureType: FailureType,
  tipStats: TipStats,
  attempt: number,
): AiDecision {
  if (['INSUFFICIENT_FUNDS', 'COMPUTE_BUDGET_EXCEEDED'].includes(failureType) || attempt >= 5) {
    return { action: 'abort', newTip: 0, confidence: 0.95, reasoning: `Unrecoverable failure: ${failureType}` };
  }
  const newTip = tipStats.congestion === 'HIGH' ? tipStats.p90 : tipStats.p75;
  return { action: 'retry', newTip, confidence: 0.7, reasoning: `Heuristic retry at p${tipStats.congestion === 'HIGH' ? 90 : 75} tip` };
}
