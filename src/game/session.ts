// A Session is one run of a level's program against a payload in one environment.
// The debugger drives a Session step by step; verify() runs Sessions headless.

import { assemble, type Program } from '../cpu/asm';
import { CPU } from '../cpu/cpu';
import { BP } from '../cpu/isa';
import { Memory, R, W, X } from '../cpu/memory';
import { DATA_BASE, STACK_BASE, STACK_TOP, TEXT_BASE, type LevelDef, type Metrics } from './level';

const programCache = new Map<string, Program>();

export function programOf(level: LevelDef): Program {
  let p = programCache.get(level.id);
  if (!p) {
    p = assemble({
      text: { base: TEXT_BASE, src: level.text },
      data: { base: DATA_BASE, src: level.data },
    });
    programCache.set(level.id, p);
  }
  return p;
}

/** Address → name, for functions and data labels (used by disassembly views). */
export function labelsOf(level: LevelDef): Map<number, string> {
  const m = new Map<number, string>();
  for (const [name, addr] of programOf(level).symbols) if (!m.has(addr)) m.set(addr, name);
  return m;
}

export function envBlock(env: string[]): number[] {
  const bytes: number[] = [];
  for (const s of env) {
    for (const ch of s) bytes.push(ch.charCodeAt(0) & 0xff);
    bytes.push(0);
  }
  return bytes;
}

/** Initial SP for an environment: just below the env strings, rounded down to even. */
export function initialSP(env: string[]): number {
  return (STACK_TOP - envBlock(env).length) & 0xfffe;
}

export interface Region {
  name: string;
  start: number;
  end: number; // exclusive
  perms: number;
}

export class Session {
  readonly cpu: CPU;
  readonly program: Program;
  readonly regions: Region[];
  readonly entrySP: number;
  goalReached = false;
  goalAt?: { cycles: number; steps: number };
  /** BP of the annotated frame once its prologue has run. */
  frameBP?: number;

  constructor(
    readonly level: LevelDef,
    readonly payload: number[],
    readonly envIndex = 0,
  ) {
    this.program = programOf(level);
    const mem = new Memory();
    const text = this.program.sections.text;
    const data = this.program.sections.data;
    const pageUp = (n: number) => Math.max(0x100, (n + 0xff) & ~0xff);
    const stackPerms = R | W | (level.stackExec ? X : 0);
    this.regions = [
      { name: '.text', start: TEXT_BASE, end: TEXT_BASE + pageUp(text.bytes.length), perms: R | X },
      { name: '.data', start: DATA_BASE, end: DATA_BASE + pageUp(data.bytes.length), perms: R | W },
      { name: 'stack', start: STACK_BASE, end: STACK_TOP, perms: stackPerms },
    ];
    for (const r of this.regions) mem.map(r.start, r.end - r.start, r.perms);
    mem.load(TEXT_BASE, text.bytes);
    mem.load(DATA_BASE, data.bytes);
    const env = level.envs[envIndex];
    mem.load(STACK_TOP - envBlock(env).length, envBlock(env));

    this.cpu = new CPU(mem, level.maxCycles ?? 5000);
    this.cpu.stdin = [...payload];
    this.entrySP = initialSP(env);
    this.cpu.regs[4] = this.entrySP;
    this.cpu.ip = this.program.symbols.get('_start')!;
  }

  sym(name: string): number {
    const v = this.program.symbols.get(name);
    if (v === undefined) throw new Error(`no symbol ${name}`);
    return v;
  }

  get done(): boolean {
    return this.cpu.status !== 'running';
  }

  /** Stack shift relative to environment 0 (positive = stack is lower). */
  get stackShift(): number {
    return initialSP(this.level.envs[0]) - this.entrySP;
  }

  step(): void {
    const cpu = this.cpu;
    if (cpu.status !== 'running') return;
    const goal = this.level.goal;
    if (goal.type === 'reach' && !this.goalReached && cpu.ip === this.sym(goal.symbol)) this.markGoal();
    cpu.step();
    // After PUSH BP; MOV BP, SP (3 bytes) the frame pointer is established.
    if (this.frameBP === undefined && cpu.ip === this.sym(this.level.frame.fn) + 3) this.frameBP = cpu.regs[BP];
    if (goal.type === 'shell' && cpu.status === 'shell' && !this.goalReached) this.markGoal();
  }

  private markGoal(): void {
    this.goalReached = true;
    this.goalAt = { cycles: this.cpu.cycles, steps: this.cpu.steps };
  }

  runToEnd(maxSteps = 200000): void {
    for (let i = 0; i < maxSteps && !this.done; i++) this.step();
  }

  /** Replay from scratch up to `steps` instructions (used for "step back"). */
  static replay(level: LevelDef, payload: number[], envIndex: number, steps: number): Session {
    const s = new Session(level, payload, envIndex);
    while (!s.done && s.cpu.steps < steps) s.step();
    return s;
  }
}

export interface RunResult {
  envIndex: number;
  success: boolean;
  session: Session;
}

export interface Verdict {
  success: boolean;
  runs: RunResult[];
  metrics?: Metrics;
}

/** Run the payload in every environment of the level. All must reach the goal. */
export function verify(level: LevelDef, payload: number[]): Verdict {
  const runs: RunResult[] = level.envs.map((_, envIndex) => {
    const session = new Session(level, payload, envIndex);
    session.runToEnd();
    return { envIndex, success: session.goalReached, session };
  });
  const success = runs.every((r) => r.success);
  if (!success) return { success, runs };
  return {
    success,
    runs,
    metrics: {
      bytes: payload.length,
      cycles: Math.max(...runs.map((r) => r.session.goalAt!.cycles)),
      insns: Math.max(...runs.map((r) => r.session.goalAt!.steps)),
    },
  };
}
