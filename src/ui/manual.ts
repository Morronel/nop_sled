// The "leaked" SK-16 programmer's manual, generated from the ISA tables.

import { INSN_DEFS, REG_NAMES } from '../cpu/isa';
import { S } from '../i18n';
import type { Strings } from '../i18n/en';
import { h } from './dom';

const FORM_OPS: Record<string, string> = {
  none: '',
  r_imm: ' r, imm16',
  r_r: ' d, s',
  r_mem: ' d, [s]',
  mem_r: ' [d], s',
  rel8: ' rel8',
  rel16: ' rel16',
  r: ' r',
};

const SYSCALLS: [string, keyof Strings['manual']['sys']][] = [
  ['0x00', 'read'],
  ['0x01', 'write'],
  ['0x15', 'access'],
  ['0x3B', 'execve'],
  ['0x3C', 'exit'],
];

export function manualView(): HTMLElement {
  const m = S().manual;
  const regs = [...REG_NAMES, 'IP', 'FLAGS'] as (keyof Strings['manual']['regs'])[];
  return h(
    'div',
    { class: 'manual' },
    h(
      'header',
      { class: 'ds-head' },
      h('div', { class: 'ds-brand' }, m.header),
      h('h2', null, m.title),
      h('div', { class: 'ds-rev' }, m.rev),
      h('div', { class: 'stamp' }, 'CONFIDENTIAL'),
      h('p', { class: 'dim small' }, m.leaked),
    ),
    h('h3', null, m.registers),
    h('table', { class: 'ds' }, h('tbody', null, regs.map((r) => h('tr', null, h('td', { class: 'mono strong' }, r), h('td', null, m.regs[r]))))),
    h('h3', null, m.memory),
    m.memoryText.map((p) => h('p', null, p)),
    h('h3', null, m.insns),
    h('p', { class: 'dim small' }, m.encoding),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'ds' },
        h('thead', null, h('tr', null, [m.cols.insn, m.cols.enc, m.cols.size, m.cols.cyc, m.cols.flags, m.cols.op].map((c) => h('th', null, c)))),
        h(
          'tbody',
          null,
          INSN_DEFS.map((d) =>
            h(
              'tr',
              null,
              h('td', { class: 'mono strong' }, d.mn + FORM_OPS[d.form]),
              h('td', { class: 'mono' }, d.encoding),
              h('td', null, d.size),
              h('td', null, d.cycles),
              h('td', null, d.flags || '–'),
              h('td', null, S().insn[d.id as keyof Strings['insn']]),
            ),
          ),
        ),
      ),
    ),
    h('h3', null, m.syscalls),
    h('table', { class: 'ds' }, h('tbody', null, SYSCALLS.map(([n, k]) => h('tr', null, h('td', { class: 'mono strong' }, n), h('td', null, m.sys[k]))))),
    h('p', { class: 'dim small' }, m.errno),
    h('h3', null, m.abi),
    m.abiText.map((p) => h('p', null, p)),
    h(
      'pre',
      { class: 'frame-diagram' },
      `        ┌──────────────┐
 BP+2 → │ return addr  │ ← RET
 BP+0 → │ saved BP     │ ← LEAVE
 BP-2 → │ locals       │
        │ char buf[]   │ ↑ input
        └──────────────┘ ← SP`,
    ),
  );
}
