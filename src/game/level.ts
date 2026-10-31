// Level definition shared by all chapters.

export interface FrameSlot {
  /** i18n-free variable name as it appears in the C source, e.g. "badge[8]". */
  name: string;
  /**
   * Offset from the vulnerable function's return-address slot (negative:
   * locals sit below it). The SK-1 has no frame pointer.
   */
  offset: number;
  size: number;
}

export type Goal = { type: 'reach'; symbol: string } | { type: 'shell' };

export interface Metrics {
  bytes: number;
  cycles: number;
  insns: number;
}

export interface LevelDef {
  id: string;
  chapter: number;
  /** C-like source shown to the player. Code is not translated, like real code. */
  source: string;
  text: string; // .text assembly
  data: string; // .data assembly
  stackExec: boolean;
  /** One environment per test run; their sizes shift the stack. */
  envs: string[][];
  goal: Goal;
  /** The function whose frame the debugger annotates. */
  frame: { fn: string; slots: FrameSlot[] };
  /** "Typical good solution" used to centre the mocked score histograms. */
  par: Metrics;
  maxCycles?: number;
}

export const TEXT_BASE = 0x1000;
export const DATA_BASE = 0x2000;
export const STACK_BASE = 0xf000;
export const STACK_TOP = 0x10000;

/** Common process entry: exit(main()). */
export const CRT0 = `
_start:
    CALL main
    PUSH                ; status = main()
    MOV  0x3C, ACC      ; SYS_exit
    SYS
`;
