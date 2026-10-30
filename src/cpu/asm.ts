// A small two-pass assembler for SK-16. Level programs are written with it, so
// the disassembly the player reads is generated from the same bytes that run.
//
// Syntax:   label:  MNEM op, op   ; comment
// Operands: A B C D SP BP | [reg] | 0x1F, 31, -2, 'A' | label, label+2, label-1
// Directives (any section): .ascii "s"  .asciz "s"  .byte 1,2  .word 0x1337  .zero 8

import { REG_NAMES, encode, findDef, type Form, type Insn, type Mnemonic } from './isa';

export interface ListingLine {
  addr: number;
  bytes: number[];
  source: string;
  label?: string;
}

export interface Section {
  base: number;
  bytes: number[];
  listing: ListingLine[];
}

export interface Program {
  sections: Record<string, Section>;
  symbols: Map<string, number>;
}

export class AsmError extends Error {
  constructor(msg: string, public line: number, public section: string) {
    super(`${section}:${line}: ${msg}`);
  }
}

type Operand =
  | { k: 'reg'; r: number }
  | { k: 'mem'; r: number }
  | { k: 'expr'; text: string };

interface Item {
  section: string;
  line: number;
  addr: number;
  size: number;
  label?: string;
  source: string;
  emit: (sym: (e: string) => number) => number[];
}

const MNEMONICS = new Set<Mnemonic>([
  'NOP', 'MOV', 'LD', 'ST', 'ADD', 'SUB', 'AND', 'XOR', 'CMP',
  'JMP', 'JZ', 'JNZ', 'CALL', 'RET', 'LEAVE', 'PUSH', 'POP', 'SYSCALL',
]);

function regIndex(t: string): number {
  return (REG_NAMES as readonly string[]).indexOf(t.toUpperCase());
}

function parseOperand(t: string): Operand {
  t = t.trim();
  const m = /^\[\s*(\w+)\s*\]$/.exec(t);
  if (m) {
    const r = regIndex(m[1]);
    if (r < 0) throw new Error(`bad memory operand ${t}`);
    return { k: 'mem', r };
  }
  const r = regIndex(t);
  if (r >= 0) return { k: 'reg', r };
  return { k: 'expr', text: t };
}

function parseNumber(t: string): number | undefined {
  t = t.trim();
  if (/^-?0x[0-9a-f]+$/i.test(t)) return t.startsWith('-') ? -parseInt(t.slice(3), 16) : parseInt(t, 16);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  const c = /^'(.)'$/.exec(t);
  if (c) return c[1].charCodeAt(0);
  return undefined;
}

/** Evaluate `term ((+|-) term)*` where a term is a number or a symbol. */
function evalExpr(text: string, symbols: Map<string, number>): number {
  const parts = text.replace(/\s+/g, '').split(/(?=[+-])/);
  let total = 0;
  for (const part of parts) {
    const sign = part.startsWith('-') ? -1 : 1;
    const body = part.replace(/^[+-]/, '');
    const n = parseNumber(body);
    if (n !== undefined) total += sign * n;
    else if (symbols.has(body)) total += sign * symbols.get(body)!;
    else throw new Error(`unknown symbol ${body}`);
  }
  return total;
}

function unescape(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (ch === '\\') {
      const n = s[++i];
      ch = n === 'n' ? '\n' : n === '0' ? '\0' : n === 't' ? '\t' : n;
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return out;
}

function stripComment(raw: string): string {
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"' && raw[i - 1] !== '\\') inStr = !inStr;
    else if (raw[i] === ';' && !inStr) return raw.slice(0, i);
  }
  return raw;
}

function splitOperands(s: string): string[] {
  if (!s.trim()) return [];
  return s.split(',').map((x) => x.trim());
}

function instructionItem(mn: Mnemonic, ops: Operand[]): { size: number; build: (sym: (e: string) => number, addr: number) => Insn } {
  const kinds = ops.map((o) => o.k).join(',');
  let form: Form;
  if (ops.length === 0) form = 'none';
  else if (kinds === 'reg') form = 'r';
  else if (kinds === 'reg,reg') form = 'r_r';
  else if (kinds === 'reg,expr') form = 'r_imm';
  else if (kinds === 'reg,mem') form = 'r_mem';
  else if (kinds === 'mem,reg') form = 'mem_r';
  else if (kinds === 'expr') form = mn === 'CALL' ? 'rel16' : 'rel8';
  else throw new Error(`bad operands for ${mn}`);
  const def = findDef(mn, form);
  if (!def) throw new Error(`${mn} has no ${form} form`);
  const reg = (o: Operand) => (o.k === 'expr' ? 0 : o.r);
  return {
    size: def.size,
    build: (sym, addr) => {
      const insn: Insn = { mn, form };
      if (ops[0] && ops[0].k !== 'expr') insn.d = reg(ops[0]);
      if (ops[1] && ops[1].k !== 'expr') insn.s = reg(ops[1]);
      const ex = ops.find((o) => o.k === 'expr') as { k: 'expr'; text: string } | undefined;
      if (ex) {
        const v = sym(ex.text);
        if (form === 'rel8' || form === 'rel16') insn.imm = v - (addr + def.size);
        else insn.imm = v & 0xffff;
        if (form === 'rel16') insn.imm &= 0xffff;
      }
      return insn;
    },
  };
}

export function assemble(sources: Record<string, { base: number; src: string }>): Program {
  const items: Item[] = [];
  const symbols = new Map<string, number>();

  for (const [section, { base, src }] of Object.entries(sources)) {
    let addr = base;
    src.split('\n').forEach((raw, idx) => {
      const lineNo = idx + 1;
      const fail = (msg: string) => {
        throw new AsmError(msg, lineNo, section);
      };
      let line = stripComment(raw).trim();
      if (!line) return;
      let label: string | undefined;
      const lm = /^([A-Za-z_.][\w.]*):\s*(.*)$/.exec(line);
      if (lm) {
        label = lm[1];
        if (symbols.has(label)) fail(`duplicate label ${label}`);
        symbols.set(label, addr);
        line = lm[2].trim();
        if (!line) {
          items.push({ section, line: lineNo, addr, size: 0, label, source: '', emit: () => [] });
          return;
        }
      }
      const sm = /^(\.?\w+)\s*(.*)$/.exec(line);
      if (!sm) fail(`cannot parse: ${line}`);
      const word = sm![1];
      const rest = sm![2];
      const push = (size: number, emit: Item['emit']) => {
        items.push({ section, line: lineNo, addr, size, label, source: line, emit });
        addr += size;
      };
      try {
        if (word.startsWith('.')) {
          switch (word) {
            case '.ascii':
            case '.asciz': {
              const sq = /^"(.*)"$/.exec(rest.trim());
              if (!sq) fail('expected a string');
              const bytes = unescape(sq![1]);
              if (word === '.asciz') bytes.push(0);
              push(bytes.length, () => bytes);
              break;
            }
            case '.byte': {
              const ops = splitOperands(rest);
              push(ops.length, (sym) => ops.map((o) => sym(o) & 0xff));
              break;
            }
            case '.word': {
              const ops = splitOperands(rest);
              push(ops.length * 2, (sym) => ops.flatMap((o) => {
                const v = sym(o) & 0xffff;
                return [v & 0xff, v >> 8];
              }));
              break;
            }
            case '.zero': {
              const n = parseNumber(rest) ?? fail('expected a count');
              push(n as number, () => new Array(n as number).fill(0));
              break;
            }
            default:
              fail(`unknown directive ${word}`);
          }
          return;
        }
        const mn = word.toUpperCase() as Mnemonic;
        if (!MNEMONICS.has(mn)) fail(`unknown mnemonic ${word}`);
        const ops = splitOperands(rest).map(parseOperand);
        const it = instructionItem(mn, ops);
        const at = addr;
        push(it.size, (sym) => encode(it.build(sym, at)));
      } catch (e) {
        if (e instanceof AsmError) throw e;
        fail((e as Error).message);
      }
    });
  }

  const program: Program = { sections: {}, symbols };
  for (const [section, { base }] of Object.entries(sources)) {
    program.sections[section] = { base, bytes: [], listing: [] };
  }
  let pendingLabel: string | undefined;
  for (const it of items) {
    let bytes: number[];
    try {
      bytes = it.emit((e) => evalExpr(e, symbols));
    } catch (e) {
      throw new AsmError((e as Error).message, it.line, it.section);
    }
    if (bytes.length !== it.size) throw new AsmError('size mismatch', it.line, it.section);
    const sec = program.sections[it.section];
    sec.bytes.push(...bytes);
    if (!it.source) {
      pendingLabel = it.label;
      continue;
    }
    sec.listing.push({ addr: it.addr, bytes, source: it.source, label: it.label ?? pendingLabel });
    pendingLabel = undefined;
  }
  return program;
}
