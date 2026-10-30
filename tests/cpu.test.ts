import { describe, expect, it } from 'vitest';
import { assemble } from '../src/cpu/asm';
import { CPU, ERR } from '../src/cpu/cpu';
import { decode, encode, formatInsn, INSN_DEFS, type Insn } from '../src/cpu/isa';
import { Memory, R, W, X } from '../src/cpu/memory';

function machine(src: string, opts: { stackPerms?: number } = {}) {
  const prog = assemble({ text: { base: 0x1000, src } });
  const mem = new Memory();
  mem.map(0x1000, 0x100, R | X);
  mem.map(0xf000, 0x1000, opts.stackPerms ?? (R | W));
  mem.load(0x1000, prog.sections.text.bytes);
  const cpu = new CPU(mem);
  cpu.regs[4] = 0xff00;
  cpu.ip = 0x1000;
  return { cpu, mem, prog };
}

describe('encoding', () => {
  it('matches the x86-flavoured bytes from the spec', () => {
    expect(encode({ mn: 'NOP', form: 'none' })).toEqual([0x90]);
    expect(encode({ mn: 'MOV', form: 'r_r', d: 5, s: 4 })).toEqual([0x89, 0xe5]); // MOV BP, SP
    expect(encode({ mn: 'XOR', form: 'r_r', d: 0, s: 0 })).toEqual([0x31, 0xc0]);
    expect(encode({ mn: 'SUB', form: 'r_imm', d: 4, imm: 0x10 })).toEqual([0x81, 0xec, 0x10, 0x00]);
    expect(encode({ mn: 'JMP', form: 'r', d: 4 })).toEqual([0xff, 0xe4]); // JMP SP
    expect(encode({ mn: 'PUSH', form: 'r', d: 5 })).toEqual([0x55]);
    expect(encode({ mn: 'POP', form: 'r', d: 0 })).toEqual([0x58]);
    expect(encode({ mn: 'MOV', form: 'r_imm', d: 0, imm: 0x1337 })).toEqual([0xb8, 0x37, 0x13]);
    expect(encode({ mn: 'SYSCALL', form: 'none' })).toEqual([0x0f, 0x05]);
  });

  it('round-trips every form through decode', () => {
    for (const def of INSN_DEFS) {
      const insn: Insn = { mn: def.mn, form: def.form, d: 2, s: 3, imm: def.form === 'rel8' ? -5 : 0x1234 };
      if (def.form === 'rel16') insn.imm = -300;
      const bytes = encode(insn);
      expect(bytes.length).toBe(def.size);
      const d = decode((a) => bytes[a], 0);
      expect(d.ok).toBe(true);
      if (d.ok) expect(formatInsn(d.insn)).toBe(formatInsn(insn));
    }
  });

  it('never emits 0x00 or 0x0A in opcode or reg bytes', () => {
    for (const def of INSN_DEFS) {
      for (let d = 0; d < 6; d++) {
        for (let s = 0; s < 6; s++) {
          const bytes = encode({ mn: def.mn, form: def.form, d, s, imm: def.form === 'rel8' ? 0x41 : 0x4141 });
          expect(bytes.filter((b) => b === 0x00 || b === 0x0a)).toEqual([]);
        }
      }
    }
  });

  it('treats 0x00 and bad register fields as illegal', () => {
    expect(decode(() => 0x00, 0).ok).toBe(false);
    const bytes = [0x89, 0xc6]; // dst register 6
    expect(decode((a) => bytes[a], 0).ok).toBe(false);
  });

  it('finds the hidden POP A; RET inside MOV A, 0xC358', () => {
    const bytes = encode({ mn: 'MOV', form: 'r_imm', d: 0, imm: 0xc358 });
    const pop = decode((a) => bytes[a], 1);
    const ret = decode((a) => bytes[a], 2);
    expect(pop.ok && formatInsn(pop.insn)).toBe('POP A');
    expect(ret.ok && formatInsn(ret.insn)).toBe('RET');
  });
});

describe('execution', () => {
  it('does arithmetic and flags', () => {
    const { cpu } = machine(`
      MOV A, 5
      SUB A, 6
      MOV B, 0xFFFF
      ADD B, 1
    `);
    cpu.step();
    cpu.step();
    expect(cpu.regs[0]).toBe(0xffff);
    expect(cpu.c).toBe(true);
    cpu.step();
    cpu.step();
    expect(cpu.regs[1]).toBe(0);
    expect(cpu.z).toBe(true);
    expect(cpu.c).toBe(true);
  });

  it('stores little-endian and grows the stack down', () => {
    const { cpu, mem } = machine(`
      MOV A, 0x1337
      PUSH A
    `);
    cpu.step();
    cpu.step();
    expect(cpu.regs[4]).toBe(0xfefe);
    expect(mem.bytes[0xfefe]).toBe(0x37);
    expect(mem.bytes[0xfeff]).toBe(0x13);
  });

  it('CALL pushes the return address and RET trusts it', () => {
    const { cpu, prog } = machine(`
      CALL f
      NOP
    f:
      MOV A, 0x1234
      ST [SP], A
      RET
    `);
    cpu.run(4);
    expect(cpu.ip).toBe(0x1234);
    expect(prog.symbols.get('f')).toBe(0x1004);
  });

  it('LEAVE restores SP and BP', () => {
    const { cpu } = machine(`
      PUSH BP
      MOV BP, SP
      SUB SP, 8
      LEAVE
    `);
    cpu.regs[5] = 0xabcd;
    cpu.run(4);
    expect(cpu.regs[4]).toBe(0xff00);
    expect(cpu.regs[5]).toBe(0xabcd);
  });

  it('faults on NX, unmapped reads and illegal opcodes', () => {
    const a = machine(`
      MOV A, 0xFE00
      JMP A
    `);
    a.cpu.run();
    expect(a.cpu.fault).toMatchObject({ signal: 'SIGSEGV', kind: 'exec', ip: 0xfe00 });

    const b = machine(`
      MOV A, 0x0000
      LD B, [A]
    `);
    b.cpu.run();
    expect(b.cpu.fault).toMatchObject({ signal: 'SIGSEGV', kind: 'read', addr: 0 });

    const c = machine(`NOP`);
    c.cpu.run();
    expect(c.cpu.fault).toMatchObject({ signal: 'SIGILL', ip: 0x1001 });
  });

  it('read() copies stdin, taints it and returns errors as negative errno', () => {
    const { cpu, mem } = machine(`
      XOR A, A
      XOR B, B
      MOV C, 0xFE00
      MOV D, 4
      SYSCALL
      MOV C, 0x0010
      XOR A, A
      SYSCALL
    `);
    cpu.stdin = [1, 2, 3, 4, 5, 6];
    cpu.run(5);
    expect(cpu.regs[0]).toBe(4);
    expect([...mem.bytes.slice(0xfe00, 0xfe04)]).toEqual([1, 2, 3, 4]);
    expect(mem.taint[0xfe00]).toBe(1);
    cpu.run(3);
    expect(cpu.regs[0]).toBe(ERR.EFAULT);
  });

  it('execve("/bin/sh") needs valid argv/envp', () => {
    const src = (c: string) => `
      MOV A, 0x3B
      MOV B, sh
      MOV C, ${c}
      XOR D, D
      SYSCALL
      RET
    sh: .asciz "/bin/sh"
    `;
    const ok = machine(src('0'));
    ok.cpu.run();
    expect(ok.cpu.status).toBe('shell');

    const bad = machine(src('0x9090'));
    bad.cpu.run(5);
    expect(bad.cpu.status).toBe('running');
    expect(bad.cpu.regs[0]).toBe(ERR.EFAULT);
  });

  it('stops at the watchdog', () => {
    const { cpu } = machine(`loop: JMP loop`);
    cpu.maxCycles = 50;
    cpu.run();
    expect(cpu.status).toBe('timeout');
  });
});
