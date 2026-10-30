// Tiny i18n: typed access to the current language's strings, plus {param} formatting.

import { en, type Strings } from './en';
import { uk } from './uk';

export type Lang = 'en' | 'uk';
export const LANGS: Record<Lang, Strings> = { en, uk };

let current: Lang = 'en';

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
}

export function getLang(): Lang {
  return current;
}

export function detectLang(): Lang {
  return navigator.language?.toLowerCase().startsWith('uk') ? 'uk' : 'en';
}

/** Strings for the current language. */
export function S(): Strings {
  return LANGS[current];
}

/** Replace {name} placeholders. */
export function fmt(s: string, params: Record<string, string | number> = {}): string {
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

export function levelText(id: string) {
  return S().levels[id] ?? en.levels[id];
}
