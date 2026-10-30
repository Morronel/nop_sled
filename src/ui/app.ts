// Top-level shell: header with settings, and screen routing.

import { LEVELS, levelById } from '../game/levels';
import { save, saveData } from '../game/save';
import { getLang, S, setLang } from '../i18n';
import { button, h, replace } from './dom';
import { LevelScreen } from './levelScreen';
import { manualView } from './manual';
import { isUnlocked, menuView } from './menu';

type Screen = { kind: 'menu' } | { kind: 'level'; id: string } | { kind: 'manual' };

export class App {
  private screen: Screen = { kind: 'menu' };
  private prev: Screen = { kind: 'menu' };
  private levelScreen?: LevelScreen;

  constructor(private root: HTMLElement) {
    this.applySettings();
    this.render();
  }

  private applySettings(): void {
    const d = saveData();
    document.documentElement.dataset.theme = d.theme ?? 'amber';
    document.documentElement.dataset.crt = d.crt === false ? 'off' : 'on';
  }

  private go(screen: Screen): void {
    if (screen.kind !== 'level' || (this.levelScreen && this.levelScreen.level.id !== screen.id)) {
      this.levelScreen?.destroy();
      this.levelScreen = undefined;
    }
    this.prev = this.screen;
    this.screen = screen;
    this.render();
    window.scrollTo(0, 0);
  }

  openLevel(id: string): void {
    this.go({ kind: 'level', id });
  }

  private render(): void {
    const t = S().app;
    const d = saveData();
    const back =
      this.screen.kind !== 'menu' &&
      button(t.back, () => this.go(this.screen.kind === 'manual' && this.prev.kind === 'level' ? this.prev : { kind: 'menu' }), 'ghost');
    const header = h(
      'header',
      { class: 'topbar' },
      back || h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, '\\x90'), t.title),
      h(
        'div',
        { class: 'top-actions' },
        this.screen.kind !== 'manual' && button(t.manual, () => this.go({ kind: 'manual' }), 'ghost'),
        button(S().lang.other, () => {
          setLang(getLang() === 'en' ? 'uk' : 'en');
          d.lang = getLang();
          save();
          this.render();
        }, 'ghost'),
        button(d.theme === 'green' ? '◐' : '◑', () => {
          d.theme = d.theme === 'green' ? 'amber' : 'green';
          save();
          this.applySettings();
        }, 'ghost', { title: `${t.theme}: ${d.theme === 'green' ? t.green : t.amber}` }),
        button(t.crt, () => {
          d.crt = d.crt === false;
          save();
          this.applySettings();
        }, `ghost${d.crt === false ? ' dim' : ''}`, { title: `${t.crt}: ${d.crt === false ? t.off : t.on}` }),
      ),
    );

    let main: HTMLElement;
    switch (this.screen.kind) {
      case 'menu':
        main = h('main', null, h('div', { class: 'hero' }, h('h1', null, t.title), h('p', { class: 'dim' }, t.tagline)), menuView((id) => this.openLevel(id)));
        break;
      case 'manual':
        main = h('main', null, manualView());
        break;
      case 'level': {
        const level = levelById(this.screen.id)!;
        const index = LEVELS.indexOf(level);
        const nextLevel = LEVELS[index + 1];
        this.levelScreen ??= new LevelScreen(level, {
          next: nextLevel ? () => isUnlocked(index + 1) && this.openLevel(nextLevel.id) : undefined,
          menu: () => this.go({ kind: 'menu' }),
        });
        this.levelScreen.render();
        main = h('main', { class: 'has-tabbar' }, this.levelScreen.el);
        break;
      }
    }
    replace(this.root, header, main);
  }
}
