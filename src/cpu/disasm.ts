// Linear-sweep disassembler over live memory (never faults).

import { decode, formatInsn } from './isa';
import type { Memory } from './memory';

export interface DisasmLine {
  addr: number;
  bytes: number[];
  text: string;
  ok: boolean;
}

class Unmapped extends Error {}

export function disassemble(mem: Memory, start: number, count: number, labels?: Map<number, string>): DisasmLine[] {
  const out: DisasmLine[] = [];
  let addr = start & 0xffff;
  for (let i = 0; i < count; i++) {
    if (mem.peek(addr) === undefined) break;
    const peek = (a: number) => {
      const v = mem.peek(a);
      if (v === undefined) throw new Unmapped();
      return v;
    };
    let len = 1;
    let text = '(bad)';
    let ok = false;
    try {
      const d = decode(peek, addr);
      len = d.len;
      if (d.ok) {
        text = formatInsn(d.insn, addr, d.len, labels);
        ok = true;
      }
    } catch {
      text = '(truncated)';
    }
    const bytes: number[] = [];
    for (let j = 0; j < len; j++) bytes.push(mem.peek(addr + j) ?? 0);
    out.push({ addr, bytes, text, ok });
    addr = (addr + len) & 0xffff;
  }
  return out;
}
