// SK-1 instruction set: registers, opcode table, encoder and decoder.
// docs/ISA.md is the human-readable spec; keep the two in sync.
//
// The SK-1 is a one-accumulator machine in the spirit of TIS-100: few
// instructions, operands in `MOV src, dst` order, and no flags (conditional
// jumps test ACC). Every instruction is 1 byte, or 3 bytes when it carries a
// little-endian 16-bit operand.

export const REG_NAMES = ['ACC', 'PTR', 'SP'] as const;
export type RegName = (typeof REG_NAMES)[number];
export const ACC = 0;
export const PTR = 1;
export const SP = 2;

/**
 * Operand shapes:
 *  none   NOP, PUSH, SWP ...         1 byte
 *  imm    MOV 0x3B, ACC / ADD 2      3 bytes: op lo hi
 *  rel    JMP loop / CALL win        3 bytes: op lo hi, signed offset from the next instruction
 */
export type Form = 'none' | 'imm' | 'rel';

export type InsnId =
  | 'nop' | 'mov_i' | 'mov_sp' | 'mov_acc' | 'swp'
  | 'add' | 'sub' | 'ld' | 'st'
  | 'push' | 'pop' | 'adj'
  | 'jmp' | 'jez' | 'jnz' | 'call' | 'ret' | 'sys';

export interface InsnDef {
  id: InsnId; // unique key, also used for i18n of the description
  mn: string;
  /** Operand template as written in assembly; `v` = imm16, `rel` = jump target. */
  syntax: string;
  op: number;
  form: Form;
  cycles: number;
}

export interface Insn {
  id: InsnId;
  /** imm16 (0..0xFFFF) for `imm`, signed offset (-0x8000..0x7FFF) for `rel`. */
  imm?: number;
}

export const INSN_DEFS: InsnDef[] = [
  { id: 'nop', mn: 'NOP', syntax: '', op: 0x90, form: 'none', cycles: 1 },
  { id: 'mov_i', mn: 'MOV', syntax: 'v, ACC', op: 0xb8, form: 'imm', cycles: 1 },
  { id: 'mov_sp', mn: 'MOV', syntax: 'SP, ACC', op: 0x89, form: 'none', cycles: 1 },
  { id: 'mov_acc', mn: 'MOV', syntax: 'ACC, SP', op: 0x94, form: 'none', cycles: 1 },
  { id: 'swp', mn: 'SWP', syntax: '', op: 0x92, form: 'none', cycles: 1 },
  { id: 'add', mn: 'ADD', syntax: 'v', op: 0x05, form: 'imm', cycles: 1 },
  { id: 'sub', mn: 'SUB', syntax: 'v', op: 0x2d, form: 'imm', cycles: 1 },
  { id: 'ld', mn: 'LD', syntax: '', op: 0xad, form: 'none', cycles: 2 },
  { id: 'st', mn: 'ST', syntax: '', op: 0xab, form: 'none', cycles: 2 },
  { id: 'push', mn: 'PUSH', syntax: '', op: 0x50, form: 'none', cycles: 2 },
  { id: 'pop', mn: 'POP', syntax: '', op: 0x58, form: 'none', cycles: 2 },
  { id: 'adj', mn: 'ADJ', syntax: 'v', op: 0x81, form: 'imm', cycles: 1 },
  { id: 'jmp', mn: 'JMP', syntax: 'rel', op: 0xe9, form: 'rel', cycles: 1 },
  { id: 'jez', mn: 'JEZ', syntax: 'rel', op: 0x74, form: 'rel', cycles: 1 },
  { id: 'jnz', mn: 'JNZ', syntax: 'rel', op: 0x75, form: 'rel', cycles: 1 },
  { id: 'call', mn: 'CALL', syntax: 'rel', op: 0xe8, form: 'rel', cycles: 2 },
  { id: 'ret', mn: 'RET', syntax: '', op: 0xc3, form: 'none', cycles: 2 },
  { id: 'sys', mn: 'SYS', syntax: '', op: 0xcd, form: 'none', cycles: 5 },
];

const BY_ID = new Map(INSN_DEFS.map((d) => [d.id, d]));
const BY_OP = new Map(INSN_DEFS.map((d) => [d.op, d]));

export function defOf(id: InsnId): InsnDef {
  return BY_ID.get(id)!;
}

export function sizeOf(def: InsnDef): number {
  return def.form === 'none' ? 1 : 3;
}

export function cyclesOf(insn: Insn): number {
  return defOf(insn.id).cycles;
}

/** "MOV v, ACC" style label for palettes and the manual. */
export function syntaxOf(def: InsnDef): string {
  return def.syntax ? `${def.mn} ${def.syntax}` : def.mn;
}

export class EncodeError extends Error {}

/** Encode one instruction to bytes. Throws EncodeError on an out-of-range operand. */
export function encode(insn: Insn): number[] {
  const def = BY_ID.get(insn.id);
  if (!def) throw new EncodeError(`unknown instruction ${insn.id}`);
  if (def.form === 'none') return [def.op];
  const v = insn.imm ?? 0;
  if (def.form === 'rel' && (v < -0x8000 || v > 0x7fff)) throw new EncodeError(`jump offset ${v} out of range`);
  return [def.op, v & 0xff, (v >> 8) & 0xff];
}

export interface Decoded {
  ok: true;
  insn: Insn;
  len: number;
}
export interface DecodeFail {
  ok: false;
  len: 1;
}

const signed16 = (w: number) => (w & 0x8000 ? w - 0x10000 : w);

/**
 * Decode the instruction at `addr`. `fetch` may throw (e.g. a fault on a
 * non-executable page); the CPU relies on that so each byte is permission-checked.
 */
export function decode(fetch: (addr: number) => number, addr: number): Decoded | DecodeFail {
  const def = BY_OP.get(fetch(addr & 0xffff));
  if (!def) return { ok: false, len: 1 };
  if (def.form === 'none') return { ok: true, insn: { id: def.id }, len: 1 };
  const w = fetch((addr + 1) & 0xffff) | (fetch((addr + 2) & 0xffff) << 8);
  return { ok: true, insn: { id: def.id, imm: def.form === 'rel' ? signed16(w) : w }, len: 3 };
}

export const hex2 = (v: number) => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
export const hex4 = (v: number) => (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');

/** Signed decimal for ADJ operands: 0xFFF6 → "-10". */
export const signedText = (v: number) => {
  const s = signed16(v & 0xffff);
  return s > 0 ? `+${s}` : `${s}`;
};

/**
 * Text form of an instruction. With `addr` (the instruction's own address),
 * relative jumps are shown as absolute targets, like objdump.
 */
export function formatInsn(insn: Insn, addr?: number, labels?: Map<number, string>): string {
  const def = defOf(insn.id);
  const v = insn.imm ?? 0;
  switch (def.form) {
    case 'none':
      return syntaxOf(def);
    case 'imm': {
      const text = def.id === 'adj' ? signedText(v) : `0x${hex4(v)}`;
      return syntaxOf(def).replace('v', text);
    }
    case 'rel': {
      if (addr === undefined) return `${def.mn} ${v >= 0 ? '+' : ''}${v}`;
      const t = (addr + 3 + v) & 0xffff;
      const name = labels?.get(t);
      return `${def.mn} 0x${hex4(t)}${name ? ` <${name}>` : ''}`;
    }
  }
}
