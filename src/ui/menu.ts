// Level select: eight chapters, the playable ones unlock in order.

import { CHAPTER_COUNT, LEVELS } from '../game/levels';
import { levelSave } from '../game/save';
import { fmt, levelText, S } from '../i18n';
import type { Strings } from '../i18n/en';
import { button, h } from './dom';

export function isUnlocked(index: number): boolean {
  if (index === 0 || new URLSearchParams(location.search).has('unlock')) return true;
  return !!levelSave(LEVELS[index - 1].id).solved;
}

export function menuView(open: (id: string) => void): HTMLElement {
  const t = S().menu;
  const chapters = [];
  for (let c = 1; c <= CHAPTER_COUNT; c++) {
    const ch = S().chapters[`c${c}` as keyof Strings['chapters']];
    const levels = LEVELS.map((l, i) => ({ l, i })).filter(({ l }) => l.chapter === c);
    chapters.push(
      h(
        'section',
        { class: `card chapter${levels.length ? '' : ' classified'}` },
        h('div', { class: 'ch-head' }, h('span', { class: 'dim small' }, fmt(t.chapter, { n: c })), h('h3', null, ch.title)),
        h('div', { class: 'dim small' }, ch.constraint),
        levels.length === 0 && h('div', { class: 'redacted' }, `█████ ${t.classified} █████`),
        levels.map(({ l, i }) => {
          const s = levelSave(l.id);
          const unlocked = isUnlocked(i);
          return h(
            'div',
            { class: 'level-row' },
            h(
              'div',
              null,
              h('strong', null, levelText(l.id).title),
              s.solved && h('span', { class: 'badge' }, t.solved),
              s.best && h('div', { class: 'dim small' }, fmt(t.best, { ...s.best })),
            ),
            button(unlocked ? t.open : `🔒 ${t.locked}`, () => open(l.id), unlocked ? 'primary' : '', { disabled: !unlocked }),
          );
        }),
      ),
    );
  }
  return h('div', { class: 'menu' }, h('p', { class: 'intro' }, t.intro), chapters);
}
