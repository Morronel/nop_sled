// SK-16 instruction set: registers, opcode table, encoder and decoder.
// docs/ISA.md is the human-readable spec; keep the two in sync.

export const REG_NAMES = ['A', 'B', 'C', 'D', 'SP', 'BP'] as const;
export type RegName = (typeof REG_NAMES)[number];
export const SP = 4;
export const BP = 5;

export type Mnemonic =
  | 'NOP' | 'MOV' | 'LD' | 'ST'
  | 'ADD' | 'SUB' | 'AND' | 'XOR' | 'CMP'
  | 'JMP' | 'JZ' | 'JNZ' | 'CALL' | 'RET' | 'LEAVE'
  | 'PUSH' | 'POP' | 'SYSCALL';

/**
 * Operand shapes:
 *  none    NOP
 *  r_imm   MOV A, 0x1337
 *  r_r     MOV A, B
 *  r_mem   LD A, [B]
 *  mem_r   ST [A], B
 *  rel8    JMP -4         (signed offset from the next instruction)
 *  rel16   CALL 0x0010
 *  r       PUSH A / JMP A
 */
export type Form = 'none' | 'r_imm' | 'r_r' | 'r_mem' | 'mem_r' | 'rel8' | 'rel16' | 'r';

export interface Insn {
  mn: Mnemonic;
  form: Form;
  d?: number; // destination (or only) register
  s?: number; // source register
  imm?: number; // imm16 (0..0xFFFF) or signed relative offset
}

export interface InsnDef {
  id: string; // unique key, also used for i18n of the description
  mn: Mnemonic;
  form: Form;
  size: number;
  cycles: number;
  flags: string;
  encoding: string; // human-readable, for the manual
}

// Opcodes that take a reg-pair byte (11 sss ddd).
const PAIR_OPS: Partial<Record<Mnemonic, number>> = {
  MOV: 0x89, LD: 0x8b, ST: 0x88, ADD: 0x01, SUB: 0x29, AND: 0x21, XOR: 0x31, CMP: 0x39,
};
// 0x81 group: ALU with imm16. Values are the ooo field.
const GRP81: Partial<Record<Mnemonic, number>> = { ADD: 0, AND: 4, SUB: 5, XOR: 6, CMP: 7 };
const REL8_OPS: Partial<Record<Mnemonic, number>> = { JMP: 0xeb, JZ: 0x74, JNZ: 0x75 };
const SIMPLE_OPS: Partial<Record<Mnemonic, number[]>> = {
  NOP: [0x90], RET: [0xc3], LEAVE: [0xc9], SYSCALL: [0x0f, 0x05],
};

export const INSN_DEFS: InsnDef[] = [
  { id: 'nop', mn: 'NOP', form: 'none', size: 1, cycles: 1, flags: '', encoding: '90' },
  { id: 'mov_ri', mn: 'MOV', form: 'r_imm', size: 3, cycles: 1, flags: '', encoding: 'B8+r lo hi' },
  { id: 'mov_rr', mn: 'MOV', form: 'r_r', size: 2, cycles: 1, flags: '', encoding: '89 /pair' },
  { id: 'ld', mn: 'LD', form: 'r_mem', size: 2, cycles: 2, flags: '', encoding: '8B /pair' },
  { id: 'st', mn: 'ST', form: 'mem_r', size: 2, cycles: 2, flags: '', encoding: '88 /pair' },
  { id: 'add_rr', mn: 'ADD', form: 'r_r', size: 2, cycles: 1, flags: 'Z C', encoding: '01 /pair' },
  { id: 'sub_rr', mn: 'SUB', form: 'r_r', size: 2, cycles: 1, flags: 'Z C', encoding: '29 /pair' },
  { id: 'and_rr', mn: 'AND', form: 'r_r', size: 2, cycles: 1, flags: 'Z', encoding: '21 /pair' },
  { id: 'xor_rr', mn: 'XOR', form: 'r_r', size: 2, cycles: 1, flags: 'Z', encoding: '31 /pair' },
  { id: 'cmp_rr', mn: 'CMP', form: 'r_r', size: 2, cycles: 1, flags: 'Z C', encoding: '39 /pair' },
  { id: 'add_ri', mn: 'ADD', form: 'r_imm', size: 4, cycles: 1, flags: 'Z C', encoding: '81 /0 lo hi' },
  { id: 'and_ri', mn: 'AND', form: 'r_imm', size: 4, cycles: 1, flags: 'Z', encoding: '81 /4 lo hi' },
  { id: 'sub_ri', mn: 'SUB', form: 'r_imm', size: 4, cycles: 1, flags: 'Z C', encoding: '81 /5 lo hi' },
  { id: 'xor_ri', mn: 'XOR', form: 'r_imm', size: 4, cycles: 1, flags: 'Z', encoding: '81 /6 lo hi' },
  { id: 'cmp_ri', mn: 'CMP', form: 'r_imm', size: 4, cycles: 1, flags: 'Z C', encoding: '81 /7 lo hi' },
  { id: 'jmp_rel', mn: 'JMP', form: 'rel8', size: 2, cycles: 1, flags: '', encoding: 'EB rel8' },
  { id: 'jz', mn: 'JZ', form: 'rel8', size: 2, cycles: 1, flags: '', encoding: '74 rel8' },
  { id: 'jnz', mn: 'JNZ', form: 'rel8', size: 2, cycles: 1, flags: '', encoding: '75 rel8' },
  { id: 'jmp_r', mn: 'JMP', form: 'r', size: 2, cycles: 1, flags: '', encoding: 'FF E0+r' },
  { id: 'call', mn: 'CALL', form: 'rel16', size: 3, cycles: 3, flags: '', encoding: 'E8 lo hi' },
  { id: 'ret', mn: 'RET', form: 'none', size: 1, cycles: 3, flags: '', encoding: 'C3' },
  { id: 'leave', mn: 'LEAVE', form: 'none', size: 1, cycles: 3, flags: '', encoding: 'C9' },
  { id: 'push', mn: 'PUSH', form: 'r', size: 1, cycles: 2, flags: '', encoding: '50+r' },
  { id: 'pop', mn: 'POP', form: 'r', size: 1, cycles: 2, flags: '', encoding: '58+r' },
  { id: 'syscall', mn: 'SYSCALL', form: 'none', size: 2, cycles: 10, flags: '', encoding: '0F 05' },
];

export function findDef(mn: Mnemonic, form: Form): InsnDef | undefined {
  return INSN_DEFS.find((d) => d.mn === mn && d.form === form);
}

export function cyclesOf(insn: Insn): number {
  return findDef(insn.mn, insn.form)?.cycles ?? 1;
}

const pair = (d: number, s: number) => 0xc0 | (s << 3) | d;
const lo = (v: number) => v & 0xff;
const hi = (v: number) => (v >> 8) & 0xff;

export class EncodeError extends Error {}

function checkReg(r: number | undefined): number {
  if (r === undefined || r < 0 || r > 5) throw new EncodeError(`bad register ${r}`);
  return r;
}

/** Encode one instruction to bytes. Throws EncodeError on an invalid combination. */
export function encode(insn: Insn): number[] {
  const { mn, form } = insn;
  const imm = (insn.imm ?? 0) & 0xffff;
  if (!findDef(mn, form)) throw new EncodeError(`${mn} has no ${form} form`);
  switch (form) {
    case 'none':
      return [...SIMPLE_OPS[mn]!];
    case 'r_imm': {
      const d = checkReg(insn.d);
      if (mn === 'MOV') return [0xb8 + d, lo(imm), hi(imm)];
      return [0x81, 0xc0 | (GRP81[mn]! << 3) | d, lo(imm), hi(imm)];
    }
    case 'r_r':
    case 'r_mem':
    case 'mem_r':
      return [PAIR_OPS[mn]!, pair(checkReg(insn.d), checkReg(insn.s))];
    case 'rel8': {
      const v = insn.imm ?? 0;
      if (v < -128 || v > 127) throw new EncodeError(`jump offset ${v} out of rel8 range`);
      return [REL8_OPS[mn]!, v & 0xff];
    }
    case 'rel16':
      return [0xe8, lo(imm), hi(imm)];
    case 'r': {
      const r = checkReg(insn.d);
      if (mn === 'PUSH') return [0x50 + r];
      if (mn === 'POP') return [0x58 + r];
      return [0xff, 0xe0 + r];
    }
  }
}

export interface Decoded {
  ok: true;
  insn: Insn;
  len: number;
}
export interface DecodeFail {
  ok: false;
  len: number; // bytes consumed before giving up (>= 1)
}

const signed8 = (b: number) => (b & 0x80 ? b - 0x100 : b);
const signed16 = (w: number) => (w & 0x8000 ? w - 0x10000 : w);

/**
 * Decode the instruction at `addr`. `fetch` may throw (e.g. a fault on a
 * non-executable page); the CPU relies on that so each byte is permission-checked.
 */
export function decode(fetch: (addr: number) => number, addr: number): Decoded | DecodeFail {
  const at = (i: number) => fetch((addr + i) & 0xffff);
  const op = at(0);
  const ok = (insn: Insn, len: number): Decoded => ({ ok: true, insn, len });
  const bad = (len = 1): DecodeFail => ({ ok: false, len });

  if (op === 0x90) return ok({ mn: 'NOP', form: 'none' }, 1);
  if (op === 0xc3) return ok({ mn: 'RET', form: 'none' }, 1);
  if (op === 0xc9) return ok({ mn: 'LEAVE', form: 'none' }, 1);
  if (op >= 0x50 && op <= 0x55) return ok({ mn: 'PUSH', form: 'r', d: op - 0x50 }, 1);
  if (op >= 0x58 && op <= 0x5d) return ok({ mn: 'POP', form: 'r', d: op - 0x58 }, 1);
  if (op >= 0xb8 && op <= 0xbd) {
    return ok({ mn: 'MOV', form: 'r_imm', d: op - 0xb8, imm: at(1) | (at(2) << 8) }, 3);
  }
  if (op === 0x0f) return at(1) === 0x05 ? ok({ mn: 'SYSCALL', form: 'none' }, 2) : bad(2);
  if (op === 0xeb || op === 0x74 || op === 0x75) {
    const mn = op === 0xeb ? 'JMP' : op === 0x74 ? 'JZ' : 'JNZ';
    return ok({ mn, form: 'rel8', imm: signed8(at(1)) }, 2);
  }
  if (op === 0xe8) return ok({ mn: 'CALL', form: 'rel16', imm: signed16(at(1) | (at(2) << 8)) }, 3);

  const pairMn = (Object.keys(PAIR_OPS) as Mnemonic[]).find((m) => PAIR_OPS[m] === op);
  if (pairMn) {
    const b = at(1);
    const d = b & 7;
    const s = (b >> 3) & 7;
    if ((b & 0xc0) !== 0xc0 || d > 5 || s > 5) return bad(2);
    const form: Form = pairMn === 'LD' ? 'r_mem' : pairMn === 'ST' ? 'mem_r' : 'r_r';
    return ok({ mn: pairMn, form, d, s }, 2);
  }
  if (op === 0x81) {
    const b = at(1);
    const d = b & 7;
    const o = (b >> 3) & 7;
    const mn = (Object.keys(GRP81) as Mnemonic[]).find((m) => GRP81[m] === o);
    if ((b & 0xc0) !== 0xc0 || d > 5 || !mn) return bad(2);
    return ok({ mn, form: 'r_imm', d, imm: at(2) | (at(3) << 8) }, 4);
  }
  if (op === 0xff) {
    const b = at(1);
    if (b >= 0xe0 && b <= 0xe5) return ok({ mn: 'JMP', form: 'r', d: b - 0xe0 }, 2);
    return bad(2);
  }
  return bad(1);
}

export const hex2 = (v: number) => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
export const hex4 = (v: number) => (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');

/**
 * Text form of an instruction. With `addr` (the instruction's own address) and
 * its length, relative jumps are shown as absolute targets, like objdump.
 */
export function formatInsn(insn: Insn, addr?: number, len?: number, labels?: Map<number, string>): string {
  const r = (n?: number) => REG_NAMES[n ?? 0];
  const target = (off: number) => {
    // Without an address, show the raw offset (relative to the next instruction).
    if (addr === undefined || len === undefined) return off >= 0 ? `+${off}` : `${off}`;
    const t = (addr + len + off) & 0xffff;
    const name = labels?.get(t);
    return name ? `0x${hex4(t)} <${name}>` : `0x${hex4(t)}`;
  };
  switch (insn.form) {
    case 'none':
      return insn.mn;
    case 'r_imm':
      return `${insn.mn} ${r(insn.d)}, 0x${hex4(insn.imm ?? 0)}`;
    case 'r_r':
      return `${insn.mn} ${r(insn.d)}, ${r(insn.s)}`;
    case 'r_mem':
      return `${insn.mn} ${r(insn.d)}, [${r(insn.s)}]`;
    case 'mem_r':
      return `${insn.mn} [${r(insn.d)}], ${r(insn.s)}`;
    case 'rel8':
    case 'rel16':
      return `${insn.mn} ${target(insn.imm ?? 0)}`;
    case 'r':
      return `${insn.mn} ${r(insn.d)}`;
  }
}
