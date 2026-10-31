// A small two-pass assembler for SK-1. Level programs are written with it, so
// the disassembly the player reads is generated from the same bytes that run.
//
// Syntax:   label:  MNEM op, op   ; comment
// Forms:    NOP SWP LD ST PUSH POP RET SYS
//           MOV v, ACC | MOV SP, ACC | MOV ACC, SP
//           ADD v | SUB v | ADJ v
//           JMP t | JEZ t | JNZ t | CALL t     (t is an absolute target; encoded relative)
// Values:   0x1F, 31, -2, 'A', label, label+2, end-start
// Directives (any section): .ascii "s"  .asciz "s"  .byte 1,2  .word 0x1337  .zero 8

import { encode, INSN_DEFS, sizeOf, type InsnDef } from './isa';

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

interface Item {
  section: string;
  line: number;
  addr: number;
  size: number;
  label?: string;
  source: string;
  emit: (sym: (e: string) => number) => number[];
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

const MNEMONICS = new Set(INSN_DEFS.map((d) => d.mn));

/** Pick the instruction definition for a mnemonic and its operand texts. */
function instructionDef(mn: string, ops: string[]): { def: InsnDef; expr?: string } {
  const up = ops.map((o) => o.toUpperCase());
  const find = (pred: (d: InsnDef) => boolean) => INSN_DEFS.find((d) => d.mn === mn && pred(d));
  let def: InsnDef | undefined;
  let expr: string | undefined;
  if (ops.length === 0) {
    def = find((d) => d.syntax === '');
  } else if (mn === 'MOV' && ops.length === 2) {
    if (up[0] === 'SP' && up[1] === 'ACC') def = find((d) => d.id === 'mov_sp');
    else if (up[0] === 'ACC' && up[1] === 'SP') def = find((d) => d.id === 'mov_acc');
    else if (up[1] === 'ACC') {
      def = find((d) => d.id === 'mov_i');
      expr = ops[0];
    }
  } else if (ops.length === 1) {
    def = find((d) => d.form !== 'none');
    expr = ops[0];
  }
  if (!def) throw new Error(`bad operands for ${mn}: ${ops.join(', ')}`);
  return { def, expr };
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
        const mn = word.toUpperCase();
        if (!MNEMONICS.has(mn)) fail(`unknown mnemonic ${word}`);
        const { def, expr } = instructionDef(mn, splitOperands(rest));
        const at = addr;
        const size = sizeOf(def);
        push(size, (sym) => {
          if (expr === undefined) return encode({ id: def.id });
          const v = sym(expr);
          return encode({ id: def.id, imm: def.form === 'rel' ? v - (at + size) : v & 0xffff });
        });
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
