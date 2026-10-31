// Debugger: step through a Session and inspect registers, code, stack and I/O.

import { disassemble } from '../cpu/disasm';
import { hex2, hex4, PTR, REG_NAMES, SP } from '../cpu/isa';
import type { LevelDef } from '../game/level';
import { labelsOf, Session } from '../game/session';
import { fmt, S } from '../i18n';
import { button, h, replace } from './dom';
import { printable, statusText, syscallText } from './format';

const RUN_INTERVAL_MS = 90;

export class DebuggerView {
  readonly el = h('div', { class: 'debugger' });
  session: Session;
  private timer?: number;
  private prevRegs: number[] = [];
  private labels: Map<number, string>;

  constructor(
    private level: LevelDef,
    private payload: () => number[],
    public envIndex = 0,
  ) {
    this.labels = labelsOf(level);
    this.session = new Session(level, payload(), envIndex);
    this.render();
  }

  /** Restart with the current payload (called when the payload changes). */
  reset(envIndex = this.envIndex): void {
    this.stop();
    this.envIndex = envIndex;
    this.session = new Session(this.level, this.payload(), envIndex);
    this.prevRegs = [];
    this.render();
  }

  private snapshot(): void {
    this.prevRegs = [...this.session.cpu.regs, this.session.cpu.ip];
  }

  private step(): void {
    this.snapshot();
    this.session.step();
    this.render();
  }

  private back(): void {
    this.stop();
    const steps = this.session.cpu.steps;
    if (steps === 0) return;
    const prev = Session.replay(this.level, this.payload(), this.envIndex, steps - 2);
    this.prevRegs = [...prev.cpu.regs, prev.cpu.ip];
    this.session = Session.replay(this.level, this.payload(), this.envIndex, steps - 1);
    this.render();
  }

  private toggleRun(): void {
    if (this.timer !== undefined) {
      this.stop();
      this.render();
      return;
    }
    this.timer = window.setInterval(() => {
      if (this.session.done) {
        this.stop();
        this.render();
        return;
      }
      this.step();
    }, RUN_INTERVAL_MS);
    this.render();
  }

  private toEnd(): void {
    this.stop();
    this.snapshot();
    this.session.runToEnd();
    this.render();
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  render(): void {
    const t = S().debug;
    const s = this.session;
    const cpu = s.cpu;
    const scrollers = [...this.el.querySelectorAll('.scroll')].map((e) => e.scrollTop);

    const envs =
      this.level.envs.length > 1 &&
      h(
        'div',
        { class: 'row seg envs' },
        this.level.envs.map((_, i) => {
          const shift = new Session(this.level, [], i).stackShift;
          return button(
            [fmt(t.env, { n: i + 1 }), h('span', { class: 'dim small' }, ` ${fmt(t.shift, { n: shift })}`)],
            () => this.reset(i),
            i === this.envIndex ? 'on' : '',
          );
        }),
      );

    const controls = h(
      'div',
      { class: 'row controls' },
      button(`⟲ ${t.reset}`, () => this.reset()),
      button(`◀ ${t.back}`, () => this.back(), '', { disabled: cpu.steps === 0 }),
      button(`${t.step} ▶`, () => this.step(), 'primary', { disabled: s.done }),
      button(this.timer !== undefined ? `❚❚ ${t.pause}` : `${t.run} ▶▶`, () => this.toggleRun(), '', { disabled: s.done }),
      button(`${t.end} ⏭`, () => this.toEnd(), '', { disabled: s.done }),
    );

    const statusCls = cpu.status === 'faulted' || cpu.status === 'timeout' ? 'bad' : s.goalReached ? 'good' : '';
    const status = h(
      'div',
      { class: `status ${statusCls}` },
      statusText(s),
      h('span', { class: 'dim small counters' }, ` · ${cpu.cycles} ${t.cycles} · ${cpu.steps} ${t.steps}`),
    );

    replace(
      this.el,
      envs,
      controls,
      status,
      this.renderRegs(),
      h('div', { class: 'panes' }, this.renderCode(), this.renderStack()),
      this.renderIO(),
    );
    this.el.querySelectorAll('.scroll').forEach((e, i) => {
      if (scrollers[i] !== undefined) e.scrollTop = scrollers[i];
    });
    // Keep the IP line in view without scrolling the page itself.
    const cur = this.el.querySelector<HTMLElement>('.code .cur');
    const box = cur?.closest<HTMLElement>('.scroll');
    if (cur && box && (cur.offsetTop < box.scrollTop || cur.offsetTop > box.scrollTop + box.clientHeight - cur.offsetHeight)) {
      box.scrollTop = cur.offsetTop - box.clientHeight / 2;
    }
  }

  private renderRegs(): HTMLElement {
    const cpu = this.session.cpu;
    const cells = REG_NAMES.map((n, i) => {
      const changed = this.prevRegs.length > 0 && this.prevRegs[i] !== cpu.regs[i];
      return h('div', { class: `reg${changed ? ' changed' : ''}` }, h('span', { class: 'rn' }, n), `0x${hex4(cpu.regs[i])}`);
    });
    const ipChanged = this.prevRegs.length > 0 && this.prevRegs[REG_NAMES.length] !== cpu.ip;
    cells.push(h('div', { class: `reg${ipChanged ? ' changed' : ''}` }, h('span', { class: 'rn' }, 'IP'), `0x${hex4(cpu.ip)}`));
    return h('section', { class: 'card' }, h('h3', null, S().debug.registers), h('div', { class: 'regs-grid' }, cells));
  }

  private renderCode(): HTMLElement {
    const s = this.session;
    const ip = s.cpu.ip;
    const text = s.program.sections.text;
    const listing = text.listing;
    const idx = listing.findIndex((l) => l.addr === ip);
    let lines: HTMLElement[];
    if (idx >= 0) {
      lines = listing.flatMap((l, i) => {
        const out: HTMLElement[] = [];
        if (l.label) out.push(h('div', { class: 'lbl' }, `${l.label}:`));
        out.push(
          h(
            'div',
            { class: `ln${i === idx ? ' cur' : ''}` },
            h('span', { class: 'addr' }, hex4(l.addr)),
            h('span', { class: 'bytes' }, l.bytes.map(hex2).join(' ')),
            h('span', { class: 'asm' }, l.source),
          ),
        );
        return out;
      });
    } else {
      // Outside the static listing (stack, or mid-instruction): decode live memory.
      const where = s.regions.find((r) => ip >= r.start && ip < r.end)?.name ?? '???';
      lines = [h('div', { class: 'lbl' }, `; live decode @ ${where}`)];
      for (const l of disassemble(s.cpu.mem, ip, 10, this.labels)) {
        lines.push(
          h(
            'div',
            { class: `ln${l.addr === ip ? ' cur' : ''}${l.ok ? '' : ' bad'}` },
            h('span', { class: 'addr' }, hex4(l.addr)),
            h('span', { class: 'bytes' }, l.bytes.map(hex2).join(' ')),
            h('span', { class: 'asm' }, l.text),
          ),
        );
      }
    }
    return h('section', { class: 'card code' }, h('h3', null, S().debug.code), h('div', { class: 'scroll listing' }, lines));
  }

  private renderStack(): HTMLElement {
    const t = S().debug;
    const s = this.session;
    const cpu = s.cpu;
    const mem = cpu.mem;
    const sp = cpu.regs[SP];
    const ra = s.frameRA;
    const slots = this.level.frame.slots;

    // From the lowest interesting address up to the first env word.
    let lo = sp;
    if (ra !== undefined) lo = Math.min(lo, ra + Math.min(...slots.map((x) => x.offset)));
    lo = (lo - 4) & 0xfffe;
    let hi = Math.min(0xfffe, (s.entrySP + 2) & 0xfffe);
    if (hi - lo > 160) hi = Math.min(0xfffe, lo + 160);
    if (hi < lo) hi = Math.min(0xfffe, lo + 32);

    const rows: HTMLElement[] = [];
    for (let a = hi; a >= lo; a -= 2) {
      const notes: string[] = [];
      if (ra !== undefined) {
        if (a === ra) notes.push(t.retAddr);
        for (const slot of slots) {
          const start = ra + slot.offset;
          if (a >= start && a < start + slot.size) notes.push(a === start ? slot.name : '┆');
        }
      }
      const b0 = mem.peek(a);
      const b1 = mem.peek(a + 1);
      const byteSpan = (addr: number, v: number | undefined) =>
        h(
          'span',
          { class: `b${mem.taint[addr & 0xffff] ? ' taint' : ''}${mem.lastWrites.includes(addr & 0xffff) ? ' flash' : ''}` },
          v === undefined ? '··' : hex2(v),
        );
      const word = b0 !== undefined && b1 !== undefined ? b0 | (b1 << 8) : undefined;
      const sym = word !== undefined ? this.labels.get(word) : undefined;
      if (sym) notes.unshift(`→${sym}`);
      rows.push(
        h(
          'div',
          { class: `srow${a === sp ? ' at-sp' : ''}` },
          h('span', { class: 'ptr' }, a === sp ? 'SP▸' : a === cpu.regs[PTR] ? 'PTR▸' : ''),
          h('span', { class: 'addr' }, hex4(a)),
          byteSpan(a, b0),
          byteSpan(a + 1, b1),
          h('span', { class: 'word' }, word === undefined ? '' : `0x${hex4(word)}`),
          h('span', { class: 'note' }, notes.join(' ')),
        ),
      );
    }
    return h(
      'section',
      { class: 'card stack' },
      h('h3', null, t.stack, h('span', { class: 'legend' }, h('span', { class: 'b taint' }, '41'), ` ${t.tainted}`)),
      h('div', { class: 'scroll' }, rows),
    );
  }

  private renderIO(): HTMLElement {
    const t = S().debug;
    const cpu = this.session.cpu;
    const out = printable(cpu.stdout);
    return h(
      'section',
      { class: 'card io' },
      h('h3', null, t.stdout),
      h('pre', { class: 'stdout' }, out || t.none),
      h('h3', null, t.syscalls),
      h('div', { class: 'syscalls' }, cpu.syscalls.length ? cpu.syscalls.map((r) => h('div', null, syscallText(r))) : h('div', { class: 'dim' }, t.none)),
    );
  }
}
