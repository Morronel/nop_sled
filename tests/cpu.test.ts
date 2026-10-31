import { describe, expect, it } from 'vitest';
import { assemble } from '../src/cpu/asm';
import { CPU, ERR } from '../src/cpu/cpu';
import { ACC, decode, encode, formatInsn, INSN_DEFS, PTR, SP, sizeOf, type Insn } from '../src/cpu/isa';
import { Memory, R, W, X } from '../src/cpu/memory';

function machine(src: string, opts: { stackPerms?: number } = {}) {
  const prog = assemble({ text: { base: 0x1000, src } });
  const mem = new Memory();
  mem.map(0x1000, 0x100, R | X);
  mem.map(0xf000, 0x1000, opts.stackPerms ?? (R | W));
  mem.load(0x1000, prog.sections.text.bytes);
  const cpu = new CPU(mem);
  cpu.regs[SP] = 0xff00;
  cpu.ip = 0x1000;
  return { cpu, mem, prog };
}

describe('encoding', () => {
  it('uses the x86-flavoured bytes from the spec', () => {
    expect(encode({ id: 'nop' })).toEqual([0x90]);
    expect(encode({ id: 'ret' })).toEqual([0xc3]);
    expect(encode({ id: 'push' })).toEqual([0x50]);
    expect(encode({ id: 'pop' })).toEqual([0x58]);
    expect(encode({ id: 'mov_i', imm: 0x1337 })).toEqual([0xb8, 0x37, 0x13]);
    expect(encode({ id: 'adj', imm: -10 & 0xffff })).toEqual([0x81, 0xf6, 0xff]);
    expect(encode({ id: 'jmp', imm: -3 })).toEqual([0xe9, 0xfd, 0xff]);
    expect(encode({ id: 'sys' })).toEqual([0xcd]);
  });

  it('has 1-byte and 3-byte instructions only, with unique opcodes', () => {
    const ops = new Set(INSN_DEFS.map((d) => d.op));
    expect(ops.size).toBe(INSN_DEFS.length);
    for (const d of INSN_DEFS) expect(encode({ id: d.id, imm: 0x10 }).length).toBe(sizeOf(d));
  });

  it('round-trips every instruction through decode', () => {
    for (const def of INSN_DEFS) {
      const insn: Insn = { id: def.id };
      if (def.form === 'imm') insn.imm = 0x1234;
      if (def.form === 'rel') insn.imm = -300;
      const bytes = encode(insn);
      const d = decode((a) => bytes[a], 0);
      expect(d.ok).toBe(true);
      if (d.ok) expect(formatInsn(d.insn)).toBe(formatInsn(insn));
    }
  });

  it('never uses 0x00 or 0x0A as an opcode', () => {
    for (const def of INSN_DEFS) expect([0x00, 0x0a]).not.toContain(def.op);
  });

  it('treats 0x00 and other undefined bytes as illegal', () => {
    expect(decode(() => 0x00, 0).ok).toBe(false);
    expect(decode(() => 0x41, 0).ok).toBe(false);
  });

  it('formats jumps as absolute targets and ADJ as signed', () => {
    expect(formatInsn({ id: 'jnz', imm: 7 }, 0x1000)).toBe('JNZ 0x100A');
    expect(formatInsn({ id: 'adj', imm: 0xfff6 })).toBe('ADJ -10');
    expect(formatInsn({ id: 'mov_i', imm: 0x3b })).toBe('MOV 0x003B, ACC');
  });

  it('finds the hidden POP; RET inside MOV 0xC358, ACC', () => {
    const bytes = encode({ id: 'mov_i', imm: 0xc358 });
    const pop = decode((a) => bytes[a], 1);
    const ret = decode((a) => bytes[a], 2);
    expect(pop.ok && formatInsn(pop.insn)).toBe('POP');
    expect(ret.ok && formatInsn(ret.insn)).toBe('RET');
  });
});

describe('assembler', () => {
  it('encodes jumps relative to the next instruction', () => {
    const { prog } = machine(`
    top:
      NOP
      JMP top
      JEZ end
    end:
      RET
    `);
    expect(prog.sections.text.bytes).toEqual([0x90, 0xe9, 0xfc, 0xff, 0x74, 0x00, 0x00, 0xc3]);
  });

  it('rejects unknown forms', () => {
    expect(() => assemble({ text: { base: 0x1000, src: 'MOV 5, SP' } })).toThrow();
    expect(() => assemble({ text: { base: 0x1000, src: 'ADD' } })).toThrow();
  });
});

describe('execution', () => {
  it('does wrapping arithmetic on ACC and swaps with PTR', () => {
    const { cpu } = machine(`
      MOV 5, ACC
      SUB 6
      SWP
      ADD 1
    `);
    cpu.run(2);
    expect(cpu.regs[ACC]).toBe(0xffff);
    cpu.run(2);
    expect(cpu.regs[PTR]).toBe(0xffff);
    expect(cpu.regs[ACC]).toBe(1);
  });

  it('JEZ and JNZ test ACC', () => {
    const { cpu } = machine(`
      MOV 3, ACC
    loop:
      SUB 1
      JNZ loop
      JEZ done
      NOP
    done:
      RET
    `);
    cpu.run(8);
    expect(cpu.regs[ACC]).toBe(0);
    expect(cpu.lastInsn?.id).toBe('jez');
    expect(cpu.ip).toBe(0x100d);
  });

  it('stores little-endian, loads through PTR and grows the stack down', () => {
    const { cpu, mem } = machine(`
      MOV 0x1337, ACC
      PUSH
      MOV SP, ACC
      SWP
      LD
    `);
    cpu.run(2);
    expect(cpu.regs[SP]).toBe(0xfefe);
    expect(mem.bytes[0xfefe]).toBe(0x37);
    expect(mem.bytes[0xfeff]).toBe(0x13);
    cpu.run(3);
    expect(cpu.regs[ACC]).toBe(0x1337);
  });

  it('ADJ moves SP and MOV ACC, SP pivots it', () => {
    const { cpu } = machine(`
      ADJ -10
      MOV SP, ACC
      ADD 0x20
      MOV ACC, SP
    `);
    cpu.run(1);
    expect(cpu.regs[SP]).toBe(0xfef6);
    cpu.run(3);
    expect(cpu.regs[SP]).toBe(0xff16);
  });

  it('CALL pushes the return address and RET trusts it', () => {
    const { cpu, prog } = machine(`
      CALL f
      NOP
    f:
      MOV SP, ACC
      SWP
      MOV 0x1234, ACC
      ST
      RET
    `);
    cpu.run(6);
    expect(cpu.ip).toBe(0x1234);
    expect(prog.symbols.get('f')).toBe(0x1004);
  });

  it('faults on NX, unmapped reads and illegal opcodes', () => {
    const a = machine(`
      MOV 0xFE00, ACC
      PUSH
      RET
    `);
    a.cpu.run();
    expect(a.cpu.fault).toMatchObject({ signal: 'SIGSEGV', kind: 'exec', ip: 0xfe00 });

    const b = machine(`LD`);
    b.cpu.run();
    expect(b.cpu.fault).toMatchObject({ signal: 'SIGSEGV', kind: 'read', addr: 0 });

    const c = machine(`NOP`);
    c.cpu.run();
    expect(c.cpu.fault).toMatchObject({ signal: 'SIGILL', ip: 0x1001 });
  });

  it('read() takes its arguments from the stack, taints input and returns negative errno', () => {
    const { cpu, mem } = machine(`
      MOV 4, ACC
      PUSH
      MOV 0xFE00, ACC
      PUSH
      MOV 0, ACC
      PUSH
      SYS
      ADJ 6
      MOV 4, ACC
      PUSH
      MOV 0x0010, ACC
      PUSH
      MOV 0, ACC
      PUSH
      SYS
    `);
    cpu.stdin = [1, 2, 3, 4, 5, 6];
    cpu.run(7);
    expect(cpu.regs[ACC]).toBe(4);
    expect([...mem.bytes.slice(0xfe00, 0xfe04)]).toEqual([1, 2, 3, 4]);
    expect(mem.taint[0xfe00]).toBe(1);
    cpu.run(8);
    expect(cpu.regs[ACC]).toBe(ERR.EFAULT);
  });

  it('execve("/bin/sh") needs valid argv/envp', () => {
    const src = (argv: string) => `
      MOV 0, ACC
      PUSH
      MOV ${argv}, ACC
      PUSH
      MOV sh, ACC
      PUSH
      MOV 0x3B, ACC
      SYS
      RET
    sh: .asciz "/bin/sh"
    `;
    const ok = machine(src('0'));
    ok.cpu.run();
    expect(ok.cpu.status).toBe('shell');

    const bad = machine(src('0x9090'));
    bad.cpu.run(8);
    expect(bad.cpu.status).toBe('running');
    expect(bad.cpu.regs[ACC]).toBe(ERR.EFAULT);
  });

  it('stops at the watchdog', () => {
    const { cpu } = machine(`loop: JMP loop`);
    cpu.maxCycles = 50;
    cpu.run();
    expect(cpu.status).toBe('timeout');
  });
});
