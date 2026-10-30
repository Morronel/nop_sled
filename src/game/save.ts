// Progress and settings in localStorage. Every access is wrapped: storage can be
// missing, full, or blocked (private mode), and the game must still work.

import type { Lang } from '../i18n';
import type { Metrics } from './level';
import { isChunkList, type Chunk } from './payload';

const KEY = 'nopsled:v1';

export interface LevelSave {
  solved?: boolean;
  best?: Metrics;
  payload?: Chunk[];
}

export interface SaveData {
  lang?: Lang;
  theme?: 'amber' | 'green';
  crt?: boolean;
  levels: Record<string, LevelSave>;
}

let data: SaveData = { levels: {} };

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.levels && typeof parsed.levels === 'object') {
        for (const l of Object.values(parsed.levels) as LevelSave[]) {
          if (l.payload && !isChunkList(l.payload)) delete l.payload;
        }
        data = parsed;
      }
    }
  } catch {
    // Corrupt or unavailable storage: start fresh.
  }
  return data;
}

export function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked: progress just won't persist.
  }
}

export function saveData(): SaveData {
  return data;
}

export function levelSave(id: string): LevelSave {
  return (data.levels[id] ??= {});
}

/** Record a solve; returns which metrics improved. */
export function recordSolve(id: string, m: Metrics): Partial<Record<keyof Metrics, boolean>> {
  const s = levelSave(id);
  const improved: Partial<Record<keyof Metrics, boolean>> = {};
  const best = s.best ?? { bytes: Infinity, cycles: Infinity, insns: Infinity };
  for (const k of ['bytes', 'cycles', 'insns'] as const) {
    if (m[k] < best[k]) {
      improved[k] = !!s.best;
      best[k] = m[k];
    }
  }
  s.best = best;
  s.solved = true;
  save();
  return improved;
}
