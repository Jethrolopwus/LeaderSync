import { StreamState } from './yellowstone';

export interface TipStats {
  p50: number;
  p75: number;
  p90: number;
  congestion: 'LOW' | 'NORMAL' | 'HIGH';
}

const MIN_TIP = 1_000;        
const BASE_TIP = 10_000;      
const HIGH_CONGESTION_TIP = 100_000; 

export function computeTipStats(state: StreamState): TipStats {
  const balances = [...state.tipBalances.values()]
    .map(b => Number(b))
    .filter(b => b > 0)
    .sort((a, b) => a - b);

  if (balances.length === 0) {
    return { p50: BASE_TIP, p75: BASE_TIP * 2, p90: BASE_TIP * 5, congestion: 'NORMAL' };
  }

  const p = (pct: number) => balances[Math.floor(balances.length * pct)] ?? balances.at(-1)!;

  const p50 = p(0.5);
  const p75 = p(0.75);
  const p90 = p(0.9);

  
  const recent = state.recentSlots.slice(-20);
  let congestion: TipStats['congestion'] = 'NORMAL';
  if (recent.length >= 2) {
    const gaps = recent.slice(1).map((s, i) => s.timestamp - recent[i].timestamp);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (avgGap > 800) congestion = 'HIGH';
    else if (avgGap < 450) congestion = 'LOW';
  }

  return { p50, p75, p90, congestion };
}

export function suggestBaseTip(stats: TipStats): number {
  switch (stats.congestion) {
    case 'HIGH':   return Math.max(stats.p75, HIGH_CONGESTION_TIP);
    case 'LOW':    return Math.max(stats.p50, MIN_TIP);
    default:       return Math.max(stats.p50, BASE_TIP);
  }
}
