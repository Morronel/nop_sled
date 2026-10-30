// Mock "other players" score distributions, deterministic per level and metric.
// Replace with real data once there is a backend (there isn't one, by design).

import type { LevelDef, Metrics } from './level';

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface Histogram {
  bins: { from: number; to: number; count: number }[];
  playerBin: number;
  /** Share of simulated players with a strictly worse (higher) score, 0..100. */
  percentile: number;
}

const SAMPLES = 500;

export function histogram(level: LevelDef, metric: keyof Metrics, value: number, binCount = 12): Histogram {
  const rnd = mulberry32(hash(level.id + ':' + metric));
  const par = Math.max(1, level.par[metric]);
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    // Log-normal-ish tail above par; a few players beat par slightly.
    const g = Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const v = par * Math.exp(Math.abs(g) * 0.35) * (0.93 + rnd() * 0.1);
    samples.push(Math.max(1, Math.round(v)));
  }
  const lo = Math.min(value, ...samples);
  const hi = Math.max(value, ...samples);
  const width = Math.max(1, Math.ceil((hi - lo + 1) / binCount));
  const bins = Array.from({ length: binCount }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width - 1, count: 0 }));
  const binOf = (v: number) => Math.min(binCount - 1, Math.floor((v - lo) / width));
  for (const s of samples) bins[binOf(s)].count++;
  const worse = samples.filter((s) => s > value).length;
  return { bins, playerBin: binOf(value), percentile: Math.round((worse / SAMPLES) * 100) };
}
