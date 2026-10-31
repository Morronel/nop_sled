// Payload editor: chunk strip + hex keypad + opcode palette. No free typing.

import { encode, hex2, hex4, INSN_DEFS, syntaxOf, type InsnDef, type InsnId, type Insn } from '../cpu/isa';
import { chunkLength, flatten, type Chunk } from '../game/payload';
import { fmt, S } from '../i18n';
import { button, h, replace } from './dom';

type Mode = 'byte' | 'word' | 'asm';

const GROUPS: Record<'data' | 'math' | 'flow' | 'stack', InsnId[]> = {
  data: ['nop', 'mov_i', 'mov_sp', 'mov_acc', 'swp', 'ld', 'st'],
  math: ['add', 'sub', 'adj'],
  flow: ['jmp', 'jez', 'jnz', 'call', 'ret'],
  stack: ['push', 'pop', 'sys'],
};

const REPS = [1, 2, 4, 8, 16, 32];

/** Hex digits the operand of an instruction needs (0 or 4). */
const digitsOf = (def: InsnDef) => (def.form === 'none' ? 0 : 4);

export class PayloadEditor {
  readonly el = h('div', { class: 'editor' });
  private mode: Mode = 'byte';
  private digits = '';
  private tpl?: InsnDef;
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
    this.changed();
  }

  private pressDigit(d: string): void {
    const need = this.mode === 'byte' ? 2 : this.mode === 'word' ? 4 : this.tpl ? digitsOf(this.tpl) : 0;
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
      if (this.digits.length === digitsOf(this.tpl)) {
        const insn = this.buildInsn(this.tpl);
        this.insert({ bytes: encode(insn), label: this.insnText(this.tpl), rep: this.rep });
      }
    }
  }

  private buildInsn(def: InsnDef): Insn {
    const raw = this.digits ? parseInt(this.digits, 16) : 0;
    return { id: def.id, imm: def.form === 'rel' && raw & 0x8000 ? raw - 0x10000 : raw };
  }

  /** Template text with the operand filled in so far, blanks shown as _. */
  private insnText(def: InsnDef): string {
    if (def.form === 'none') return syntaxOf(def);
    if (this.digits.length < 4) {
      const v = `0x${this.digits.padEnd(4, '_')}`;
      return def.form === 'rel' ? `${def.mn} ${v}` : syntaxOf(def).replace('v', v);
    }
    const insn = this.buildInsn(def);
    if (def.form === 'rel') return `${def.mn} ${insn.imm! >= 0 ? '+' : ''}${insn.imm}`;
    return syntaxOf(def).replace('v', `0x${hex4(insn.imm!)}`);
  }

  private chooseTemplate(def: InsnDef): void {
    this.tpl = def;
    this.digits = '';
    if (digitsOf(def) === 0) this.tryComplete();
    this.render();
  }

  private backspace(): void {
    if (this.digits) this.digits = this.digits.slice(0, -1);
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
      const enc = `${hex2(this.tpl.op)}${this.tpl.form === 'none' ? '' : ' lo hi'}`;
      if (this.tpl.form === 'rel') hint = t.relHint;
      else if (this.tpl.form === 'imm') hint = this.tpl.id === 'adj' ? t.adjHint : fmt(t.typeDigits, { n: 4 });
      hint = hint ? `${enc} · ${hint}` : enc;
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
                return button(syntaxOf(def), () => this.chooseTemplate(def), this.tpl?.id === id ? 'on op' : 'op', {
                  title: S().insn[id],
                });
              }),
            ),
          ),
        ),
      );

    const needDigits =
      this.mode !== 'asm' || (this.tpl && digitsOf(this.tpl) > this.digits.length);
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
      keypad,
      repRow,
    );
  }
}
