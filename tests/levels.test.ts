import { describe, expect, it } from 'vitest';
import { encode } from '../src/cpu/isa';
import { LEVELS } from '../src/game/levels';
import { Session, initialSP, programOf, verify } from '../src/game/session';

const le = (w: number) => [w & 0xff, w >> 8];
const fill = (n: number, b = 0x41) => new Array(n).fill(b);
const level = (id: string) => LEVELS.find((l) => l.id === id)!;

describe('every level', () => {
  it.each(LEVELS.map((l) => [l.id, l]))('%s assembles and exits cleanly on benign input', (_, l) => {
    programOf(l);
    const v = verify(l, [0x41, 0x42, 0x43]);
    expect(v.success).toBe(false);
    for (const r of v.runs) expect(r.session.cpu.status).toBe('exited');
  });
});

describe('c1: adjacent variable', () => {
  const l = level('c1-1');
  it('is solved by 8 bytes of padding and 0x1337 little-endian', () => {
    const v = verify(l, [...fill(8), ...le(0x1337)]);
    expect(v.success).toBe(true);
    console.log('c1 metrics', v.metrics);
  });
  it('fails with big-endian bytes', () => {
    expect(verify(l, [...fill(8), 0x13, 0x37]).success).toBe(false);
  });
});

describe('c2: return address', () => {
  const l = level('c2-1');
  it('is solved by padding over buf, then win()', () => {
    const win = programOf(l).symbols.get('win')!;
    const v = verify(l, [...fill(8), ...le(win)]);
    expect(v.success).toBe(true);
    console.log('c2 metrics', v.metrics, 'win', win.toString(16));
  });
  it('segfaults on a junk return address', () => {
    const v = verify(l, fill(10));
    expect(v.runs[0].session.cpu.fault?.signal).toBe('SIGSEGV');
  });
});

describe('c3: shellcode + NOP sled', () => {
  const l = level('c3-1');
  const binSh = programOf(l).symbols.get('bin_sh')!;
  const shellcode = [
    ...encode({ id: 'mov_i', imm: 0 }),
    ...encode({ id: 'push' }), // envp = NULL
    ...encode({ id: 'push' }), // argv = NULL
    ...encode({ id: 'mov_i', imm: binSh }),
    ...encode({ id: 'push' }), // path
    ...encode({ id: 'mov_i', imm: 0x3b }),
    ...encode({ id: 'sys' }),
  ];
  const BUF = 48;
  const SLACK = 6;
  const shifts = l.envs.map((e) => initialSP(l.envs[0]) - initialSP(e));
  const spread = Math.max(...shifts) - Math.min(...shifts);

  function bufAddr(env: number) {
    const s = new Session(l, fill(1), env);
    while (s.frameRA === undefined) s.step();
    return s.frameRA - BUF;
  }
  const sledded = (code: number[], slack: number, target: number) => [
    ...fill(BUF - slack - code.length, 0x90),
    ...code,
    ...fill(slack),
    ...le(target),
  ];

  it('has a stack shift that an exact address cannot survive', () => {
    console.log('c3 shifts', shifts, 'spread', spread, 'bin_sh', binSh.toString(16), 'shellcode', shellcode.length);
    expect(spread).toBeGreaterThan(8);
    expect(spread).toBeLessThan(BUF - SLACK - shellcode.length);
    const exact = [...shellcode, ...fill(BUF - shellcode.length), ...le(bufAddr(0))];
    expect(verify(l, exact).success).toBe(false);
  });

  it('is solved by a NOP sled covering the spread', () => {
    // Env 0 has the highest buffer; aiming at its start lands further into the sled elsewhere.
    const v = verify(l, sledded(shellcode, SLACK, bufAddr(0)));
    expect(v.success).toBe(true);
    console.log('c3 metrics', v.metrics);
  });

  it('breaks when the shellcode’s own pushes overwrite it', () => {
    const v = verify(l, sledded(shellcode, 0, bufAddr(0)));
    expect(v.success).toBe(false);
    expect(v.runs[0].session.cpu.fault?.signal).toBe('SIGILL');
  });

  it('fails if argv is left pointing at junk', () => {
    const noNulls = shellcode.slice(5); // skip MOV 0, ACC; PUSH; PUSH
    expect(verify(l, sledded(noNulls, SLACK, bufAddr(0))).success).toBe(false);
  });
});
