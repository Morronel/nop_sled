import type { LevelDef } from '../level';
import { c1Badge } from './c1_badge';
import { c2Echo } from './c2_echo';
import { c3Greeter } from './c3_greeter';

export const LEVELS: LevelDef[] = [c1Badge, c2Echo, c3Greeter];

export const CHAPTER_COUNT = 8;

export function levelById(id: string): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}
