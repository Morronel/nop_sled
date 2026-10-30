// One level: brief, source, payload editor and debugger as tabs (bottom nav on phones).

import { hex2, hex4 } from '../cpu/isa';
import { permString } from '../cpu/memory';
import type { LevelDef, Metrics } from '../game/level';
import { flatten } from '../game/payload';
import { levelSave, recordSolve, save } from '../game/save';
import { Session, verify, type Verdict } from '../game/session';
import { fmt, levelText, S } from '../i18n';
import { DebuggerView } from './debuggerView';
import { button, h, replace, rich } from './dom';
import { PayloadEditor } from './payloadEditor';
import { resultsView } from './results';

type Tab = 'brief' | 'source' | 'payload' | 'debug';

export interface LevelNav {
  next?: () => void;
  menu: () => void;
}

export class LevelScreen {
  readonly el = h('div', { class: 'level' });
  private tab: Tab = 'brief';
  private editor: PayloadEditor;
  private debugger: DebuggerView;
  private hintShown = false;
  private result?: { verdict: Verdict; improved: Partial<Record<keyof Metrics, boolean>> };
  private payloadDirty = false;

  constructor(
    readonly level: LevelDef,
    private nav: LevelNav,
  ) {
    const saved = levelSave(level.id);
    this.editor = new PayloadEditor(saved.payload ? structuredClone(saved.payload) : [], (chunks) => {
      levelSave(level.id).payload = chunks;
      save();
      this.payloadDirty = true;
      this.renderHeader();
    });
    this.debugger = new DebuggerView(level, () => flatten(this.editor.chunks));
    this.render();
  }

  destroy(): void {
    this.debugger.stop();
  }

  private setTab(tab: Tab): void {
    if (tab === 'debug' && this.payloadDirty) {
      this.debugger.reset();
      this.payloadDirty = false;
    }
    if (tab !== 'debug') this.debugger.stop();
    this.tab = tab;
    this.render();
    window.scrollTo(0, 0);
  }

  private submit(): void {
    this.debugger.stop();
    const verdict = verify(this.level, flatten(this.editor.chunks));
    const improved = verdict.success && verdict.metrics ? recordSolve(this.level.id, verdict.metrics) : {};
    this.result = { verdict, improved };
    this.render();
  }

  private header = h('div', { class: 'level-head' });

  private renderHeader(): void {
    const lt = levelText(this.level.id);
    const ch = S().chapters[`c${this.level.chapter}` as keyof ReturnType<typeof S>['chapters']];
    replace(
      this.header,
      h('div', { class: 'lh-title' }, h('div', { class: 'dim small' }, `${fmt(S().menu.chapter, { n: this.level.chapter })} · ${ch.title}`), h('strong', null, lt.title)),
      button(`${S().brief.submit} ▸`, () => this.submit(), 'primary submit', { disabled: this.editor.chunks.length === 0 }),
    );
  }

  render(): void {
    this.renderHeader();
    const t = S().tabs;
    const content = h('div', { class: 'tab-body' });
    switch (this.tab) {
      case 'brief':
        content.append(this.renderBrief());
        break;
      case 'source':
        content.append(this.renderSource());
        break;
      case 'payload':
        this.editor.render();
        content.append(this.editor.el);
        break;
      case 'debug':
        this.debugger.render();
        content.append(this.debugger.el);
        break;
    }
    const tabs = h(
      'nav',
      { class: 'tabbar' },
      (['brief', 'source', 'payload', 'debug'] as Tab[]).map((k) => button(t[k], () => this.setTab(k), this.tab === k ? 'on' : '')),
    );
    const overlay =
      this.result &&
      resultsView(this.level, this.result.verdict, this.result.improved, {
        next: this.result.verdict.success ? this.nav.next : undefined,
        menu: this.nav.menu,
        close: () => {
          this.result = undefined;
          this.render();
        },
        debugEnv: (env) => {
          this.result = undefined;
          this.debugger.reset(env);
          this.payloadDirty = false;
          this.tab = 'debug';
          this.render();
        },
      });
    replace(this.el, this.header, content, tabs, overlay);
  }

  private renderBrief(): HTMLElement {
    const b = S().brief;
    const lt = levelText(this.level.id);
    const goal = this.level.goal;
    return h(
      'div',
      { class: 'brief' },
      h('section', { class: 'card' }, lt.brief.map((p) => h('p', null, rich(p)))),
      h(
        'section',
        { class: 'card objective' },
        h('h3', null, b.objective),
        h('p', null, goal.type === 'reach' ? fmt(b.goalReach, { symbol: goal.symbol }) : b.goalShell),
        this.level.envs.length > 1 && h('p', { class: 'dim' }, fmt(b.envs, { n: this.level.envs.length })),
      ),
      h(
        'section',
        { class: 'card' },
        h('h3', null, b.hint),
        this.hintShown ? h('p', null, rich(lt.hint)) : button(b.showHint, () => ((this.hintShown = true), this.render()), 'small'),
      ),
      h('section', { class: 'card reality' }, h('h3', null, b.reality), h('p', null, rich(lt.reality))),
    );
  }

  private renderSource(): HTMLElement {
    const t = S().source;
    const session = new Session(this.level, []);
    const prog = session.program;
    const symbols = [...prog.symbols.entries()].filter(([n]) => !n.endsWith('_end')).sort((a, b) => a[1] - b[1]);
    const listing = (sec: 'text' | 'data') =>
      prog.sections[sec].listing.flatMap((l) => [
        l.label ? h('div', { class: 'lbl' }, `${l.label}:`) : null,
        h(
          'div',
          { class: 'ln' },
          h('span', { class: 'addr' }, hex4(l.addr)),
          h('span', { class: 'bytes' }, l.bytes.length > 6 ? `${l.bytes.slice(0, 6).map(hex2).join(' ')} …` : l.bytes.map(hex2).join(' ')),
          h('span', { class: 'asm' }, l.source),
        ),
      ]);
    return h(
      'div',
      { class: 'source' },
      h('section', { class: 'card' }, h('h3', null, t.code), h('pre', { class: 'csrc' }, this.level.source)),
      h(
        'section',
        { class: 'card' },
        h('h3', null, t.symbols),
        h('div', { class: 'symtab' }, symbols.map(([n, a]) => h('div', null, h('span', { class: 'addr' }, `0x${hex4(a)}`), ` ${n}`))),
      ),
      h(
        'section',
        { class: 'card' },
        h('h3', null, t.memmap),
        h(
          'div',
          { class: 'symtab' },
          session.regions.map((r) => h('div', null, h('span', { class: 'addr' }, `${hex4(r.start)}–${hex4(r.end - 1)}`), ` ${permString(r.perms)} ${r.name}`)),
        ),
      ),
      h('section', { class: 'card' }, h('h3', null, t.disasm), h('div', { class: 'listing' }, listing('text'))),
      h('section', { class: 'card' }, h('h3', null, t.data), h('div', { class: 'listing' }, listing('data'))),
    );
  }
}
