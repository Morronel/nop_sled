// Payload editor: chunk strip + hex keypad + opcode palette. No free typing.

import { encode, hex2, hex4, INSN_DEFS, REG_NAMES, type Form, type InsnDef, type Insn } from '../cpu/isa';
import { chunkLength, flatten, type Chunk } from '../game/payload';
import { fmt, S } from '../i18n';
import type { Strings } from '../i18n/en';
import { button, h, replace } from './dom';

type Mode = 'byte' | 'word' | 'asm';

const GROUPS: Record<'data' | 'alu' | 'flow' | 'stack', string[]> = {
  data: ['nop', 'mov_ri', 'mov_rr', 'ld', 'st'],
  alu: ['add_rr', 'sub_rr', 'and_rr', 'xor_rr', 'cmp_rr', 'add_ri', 'sub_ri', 'and_ri', 'xor_ri', 'cmp_ri'],
  flow: ['jmp_rel', 'jz', 'jnz', 'jmp_r', 'call', 'ret', 'leave'],
  stack: ['push', 'pop', 'syscall'],
};

const REPS = [1, 2, 4, 8, 16, 32];

/** Operand template per form: register slots and how many hex digits. */
function slots(form: Form): { regs: number; digits: number } {
  switch (form) {
    case 'none':
      return { regs: 0, digits: 0 };
    case 'r_imm':
      return { regs: 1, digits: 4 };
    case 'r_r':
    case 'r_mem':
    case 'mem_r':
      return { regs: 2, digits: 0 };
    case 'rel8':
      return { regs: 0, digits: 2 };
    case 'rel16':
      return { regs: 0, digits: 4 };
    case 'r':
      return { regs: 1, digits: 0 };
  }
}

/** Short palette label, e.g. "MOV r,imm". */
function paletteLabel(def: InsnDef): string {
  const ops: Record<Form, string> = {
    none: '',
    r_imm: ' r,imm',
    r_r: ' d,s',
    r_mem: ' d,[s]',
    mem_r: ' [d],s',
    rel8: ' rel8',
    rel16: ' rel16',
    r: ' r',
  };
  return def.mn + ops[def.form];
}

function signed8(v: number): number {
  return v & 0x80 ? v - 0x100 : v;
}

export class PayloadEditor {
  readonly el = h('div', { class: 'editor' });
  private mode: Mode = 'byte';
  private digits = '';
  private tpl?: InsnDef;
  private regs: number[] = [];
  private rep = 1;
  private sel: number;
  private clearArmed = false;

  constructor(
    public chunks: Chunk[],
    private onChange: (chunks: Chunk[]) => void,
  ) {
    this.sel = chunks.length - 1;
    this.render();
  }

  get bytes(): number[] {
    return flatten(this.chunks);
  }

  private changed(): void {
    this.onChange(this.chunks);
    this.render();
  }

  private insert(chunk: Chunk): void {
    this.chunks.splice(this.sel + 1, 0, chunk);
    this.sel++;
    this.rep = 1;
    this.digits = '';
    this.regs = [];
    this.changed();
  }

  private pressDigit(d: string): void {
    const need = this.mode === 'byte' ? 2 : this.mode === 'word' ? 4 : this.tpl ? slots(this.tpl.form).digits : 0;
    if (this.digits.length >= need) return;
    this.digits += d;
    this.tryComplete();
    this.render();
  }

  private tryComplete(): void {
    if (this.mode === 'byte' && this.digits.length === 2) {
      const b = parseInt(this.digits, 16);
      this.insert({ bytes: [b], label: `db ${hex2(b)}`, rep: this.rep });
    } else if (this.mode === 'word' && this.digits.length === 4) {
      const w = parseInt(this.digits, 16);
      this.insert({ bytes: [w & 0xff, w >> 8], label: `dw 0x${hex4(w)}`, rep: this.rep });
    } else if (this.mode === 'asm' && this.tpl) {
      const need = slots(this.tpl.form);
      if (this.regs.length === need.regs && this.digits.length === need.digits) {
        const insn = this.buildInsn(this.tpl);
        this.insert({ bytes: encode(insn), label: this.insnText(this.tpl), rep: this.rep });
      }
    }
  }

  private buildInsn(def: InsnDef): Insn {
    const raw = this.digits ? parseInt(this.digits, 16) : 0;
    const insn: Insn = { mn: def.mn, form: def.form, d: this.regs[0], s: this.regs[1] };
    if (def.form === 'rel8') insn.imm = signed8(raw);
    else if (def.form === 'rel16') insn.imm = raw & 0x8000 ? raw - 0x10000 : raw;
    else insn.imm = raw;
    return insn;
  }

  /** Template text with filled-in operands, blanks shown as _. */
  private insnText(def: InsnDef): string {
    const need = slots(def.form);
    const r = (i: number) => (this.regs[i] !== undefined ? REG_NAMES[this.regs[i]] : '_');
    const digits = this.digits.padEnd(need.digits, '_');
    switch (def.form) {
      case 'none':
        return def.mn;
      case 'r_imm':
        return `${def.mn} ${r(0)}, 0x${digits}`;
      case 'r_r':
        return `${def.mn} ${r(0)}, ${r(1)}`;
      case 'r_mem':
        return `${def.mn} ${r(0)}, [${r(1)}]`;
      case 'mem_r':
        return `${def.mn} [${r(0)}], ${r(1)}`;
      case 'rel8':
      case 'rel16': {
        if (this.digits.length < need.digits) return `${def.mn} 0x${digits}`;
        const v = this.buildInsn(def).imm ?? 0;
        return `${def.mn} ${v >= 0 ? '+' : ''}${v}`;
      }
      case 'r':
        return `${def.mn} ${r(0)}`;
    }
  }

  private chooseTemplate(def: InsnDef): void {
    this.tpl = def;
    this.regs = [];
    this.digits = '';
    if (slots(def.form).regs === 0 && slots(def.form).digits === 0) this.tryComplete();
    this.render();
  }

  private pickReg(r: number): void {
    if (!this.tpl || this.regs.length >= slots(this.tpl.form).regs) return;
    this.regs.push(r);
    this.tryComplete();
    this.render();
  }

  private backspace(): void {
    if (this.digits) this.digits = this.digits.slice(0, -1);
    else if (this.regs.length) this.regs.pop();
    this.render();
  }

  render(): void {
    const t = S().editor;
    const total = this.bytes.length;

    // Chunk strip with running offsets.
    let offset = 0;
    const tiles = this.chunks.map((c, i) => {
      const at = offset;
      offset += chunkLength(c);
      const bytes = c.rep > 1 ? `${c.bytes.map(hex2).join(' ')} ×${c.rep}` : c.bytes.map(hex2).join(' ');
      return h(
        'button',
        { type: 'button', class: `chunk${i === this.sel ? ' sel' : ''}`, onclick: () => ((this.sel = i), this.render()) },
        h('span', { class: 'chunk-off' }, `+${at}`),
        h('span', { class: 'chunk-bytes' }, bytes),
        h('span', { class: 'chunk-label' }, c.rep > 1 ? `${c.label} ×${c.rep}` : c.label),
      );
    });
    const startTile = h(
      'button',
      { type: 'button', class: `chunk start${this.sel === -1 ? ' sel' : ''}`, title: t.startTitle, onclick: () => ((this.sel = -1), this.render()) },
      t.start,
    );

    const selChunk = this.chunks[this.sel];
    const chunkTools = h(
      'div',
      { class: 'row tools' },
      h('span', { class: 'len' }, fmt(t.length, { n: total })),
      selChunk && [
        button('−1', () => {
          if (selChunk.rep > 1) selChunk.rep--;
          this.changed();
        }, 'small'),
        button('+1', () => {
          selChunk.rep++;
          this.changed();
        }, 'small'),
        button(t.del, () => {
          this.chunks.splice(this.sel, 1);
          this.sel = Math.min(this.sel, this.chunks.length - 1);
          if (this.sel < -1) this.sel = -1;
          this.changed();
        }, 'small'),
      ],
      total > 0 &&
        button(this.clearArmed ? t.clearConfirm : t.clear, () => {
          if (!this.clearArmed) {
            this.clearArmed = true;
            this.render();
            setTimeout(() => ((this.clearArmed = false), this.render()), 2500);
            return;
          }
          this.clearArmed = false;
          this.chunks.splice(0);
          this.sel = -1;
          this.changed();
        }, 'small danger'),
    );

    // Hex dump of the flattened payload, 8 bytes per row.
    const flat = this.bytes;
    const dump = h('div', { class: 'hexdump' });
    for (let i = 0; i < flat.length; i += 8) {
      dump.append(h('div', null, h('span', { class: 'dim' }, `${i.toString().padStart(3, ' ')}│ `), flat.slice(i, i + 8).map(hex2).join(' ')));
    }

    // Mode switch.
    const modes = h(
      'div',
      { class: 'row seg' },
      (['byte', 'word', 'asm'] as Mode[]).map((m) =>
        button(t[m], () => {
          this.mode = m;
          this.digits = '';
          this.regs = [];
          this.render();
        }, this.mode === m ? 'on' : ''),
      ),
    );

    // Composer line.
    let composer: string;
    let hint = '';
    if (this.mode === 'byte') {
      composer = `db ${this.digits.padEnd(2, '_')}`;
      hint = fmt(t.typeDigits, { n: 2 });
    } else if (this.mode === 'word') {
      composer = `dw 0x${this.digits.padEnd(4, '_')}`;
      const w = this.digits.padEnd(4, '0');
      hint = fmt(t.wordHint, { word: `0x${w.toUpperCase()}`, bytes: `${w.slice(2)} ${w.slice(0, 2)}`.toUpperCase() });
    } else if (this.tpl) {
      composer = this.insnText(this.tpl);
      const need = slots(this.tpl.form);
      if (this.regs.length < need.regs) hint = t.pickReg;
      else if (this.tpl.form === 'rel8' || this.tpl.form === 'rel16') hint = t.relHint;
      else if (need.digits) hint = fmt(t.typeDigits, { n: need.digits });
      hint = `${this.tpl.encoding} · ${hint}`;
    } else {
      composer = t.chooseInsn;
    }

    const palette =
      this.mode === 'asm' &&
      h(
        'div',
        { class: 'palette' },
        (Object.keys(GROUPS) as (keyof typeof GROUPS)[]).map((g) =>
          h(
            'div',
            { class: 'pal-group' },
            h('div', { class: 'pal-title' }, t.groups[g]),
            h(
              'div',
              { class: 'pal-btns' },
              GROUPS[g].map((id) => {
                const def = INSN_DEFS.find((d) => d.id === id)!;
                return button(paletteLabel(def), () => this.chooseTemplate(def), this.tpl?.id === id ? 'on op' : 'op', {
                  title: S().insn[id as keyof Strings['insn']],
                });
              }),
            ),
          ),
        ),
      );

    const needRegs = this.mode === 'asm' && this.tpl && slots(this.tpl.form).regs > this.regs.length;
    const regRow =
      this.mode === 'asm' &&
      this.tpl &&
      slots(this.tpl.form).regs > 0 &&
      h('div', { class: 'row regs' }, REG_NAMES.map((n, i) => button(n, () => this.pickReg(i), needRegs ? 'reg' : 'reg dim', { disabled: !needRegs })));

    const needDigits =
      this.mode !== 'asm' || (this.tpl && slots(this.tpl.form).digits > this.digits.length && this.regs.length === slots(this.tpl.form).regs);
    const keypad = h(
      'div',
      { class: 'keypad' },
      '0123456789ABCDEF'.split('').map((d) => button(d, () => this.pressDigit(d), 'key', { disabled: !needDigits })),
    );

    const repRow = h(
      'div',
      { class: 'row reps' },
      h('span', { class: 'dim' }, t.rep),
      REPS.map((n) => button(`×${n}`, () => ((this.rep = n), this.render()), this.rep === n ? 'on small' : 'small')),
      button('⌫', () => this.backspace(), 'small'),
    );

    replace(
      this.el,
      h('div', { class: 'strip' }, startTile, tiles, total === 0 && h('span', { class: 'dim empty' }, t.empty)),
      chunkTools,
      flat.length > 0 && dump,
      modes,
      h('div', { class: 'composer' }, h('div', { class: 'composer-text' }, composer), h('div', { class: 'dim small' }, hint)),
      palette,
      regRow,
      keypad,
      repRow,
    );
  }
}
