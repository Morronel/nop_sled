// Results overlay: score histograms on success, per-environment failures otherwise.

import type { LevelDef, Metrics } from '../game/level';
import type { Verdict } from '../game/session';
import { histogram } from '../game/stats';
import { fmt, levelText, S } from '../i18n';
import { button, h } from './dom';
import { statusText } from './format';

export interface ResultActions {
  next?: () => void;
  menu: () => void;
  close: () => void;
  debugEnv: (env: number) => void;
}

function histogramView(level: LevelDef, metric: keyof Metrics, value: number, improved: boolean): HTMLElement {
  const t = S().results;
  const hist = histogram(level, metric, value);
  const max = Math.max(...hist.bins.map((b) => b.count), 1);
  return h(
    'div',
    { class: 'hist' },
    h('div', { class: 'hist-head' }, h('span', null, t[metric]), h('strong', null, String(value)), improved && h('span', { class: 'badge' }, t.newBest)),
    h(
      'div',
      { class: 'bars' },
      hist.bins.map((b, i) =>
        h('div', {
          class: `bar${i === hist.playerBin ? ' you' : ''}`,
          style: { height: `${Math.max(4, (b.count / max) * 100)}%` },
          title: `${b.from}–${b.to}: ${b.count}`,
        }),
      ),
    ),
    h('div', { class: 'hist-axis dim small' }, h('span', null, String(hist.bins[0].from)), h('span', null, fmt(t.better, { p: hist.percentile })), h('span', null, String(hist.bins[hist.bins.length - 1].to))),
  );
}

export function resultsView(
  level: LevelDef,
  verdict: Verdict,
  improved: Partial<Record<keyof Metrics, boolean>>,
  actions: ResultActions,
): HTMLElement {
  const t = S().results;
  const lt = levelText(level.id);
  let body: HTMLElement[];
  if (verdict.success && verdict.metrics) {
    const m = verdict.metrics;
    body = [
      h('h2', { class: 'good' }, t.success),
      histogramView(level, 'bytes', m.bytes, !!improved.bytes),
      histogramView(level, 'cycles', m.cycles, !!improved.cycles),
      histogramView(level, 'insns', m.insns, !!improved.insns),
      h('p', { class: 'dim small' }, t.mock),
      h('div', { class: 'fragment' }, h('div', { class: 'dim small' }, t.fragment), h('p', null, lt.fragment)),
      h(
        'div',
        { class: 'row actions' },
        actions.next ? button(t.next, actions.next, 'primary') : button(t.menu, actions.menu, 'primary'),
        button(t.stay, actions.close),
      ),
    ];
  } else {
    body = [
      h('h2', { class: 'bad' }, t.fail),
      ...verdict.runs.map((r) =>
        h(
          'div',
          { class: `run ${r.success ? 'good' : 'bad'}` },
          h('strong', null, fmt(t.run, { n: r.envIndex + 1 })),
          h('span', null, r.success ? ` ✓ ${t.passed}` : ` ✗ ${statusText(r.session)}`),
          !r.success && button(fmt(t.debugRun, { n: r.envIndex + 1 }), () => actions.debugEnv(r.envIndex), 'small'),
        ),
      ),
      h('div', { class: 'row actions' }, button(t.stay, actions.close, 'primary')),
    ];
  }
  return h('div', { class: 'overlay', onclick: (e: Event) => e.target === e.currentTarget && actions.close() }, h('div', { class: 'modal' }, body));
}
