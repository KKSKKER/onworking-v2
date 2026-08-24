// src/core/i18n.ts
// 极简 i18n:单一真源 JSON(zh.json / en.json),纯 TS 无 Electron 依赖。
// 缺 key 时返回 key 本身,开发期暴露漏翻译。改文案只动 catalogs/*.json。
import zhCatalog from './i18n/catalogs/zh.json';
import enCatalog from './i18n/catalogs/en.json';

const catalogs = { zh: zhCatalog, en: enCatalog } as const;

let catalog: Record<string, unknown> = {};

export function setCatalog(c: Record<string, unknown>): void {
  catalog = c;
}

export type Lang = keyof typeof catalogs;

export function loadCatalog(lang: Lang): void {
  setCatalog(catalogs[lang] as Record<string, unknown>);
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = key
    .split('.')
    .reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), catalog);
  if (typeof raw !== 'string') return key; // 缺 key 或误引用命名空间时返回 key
  return vars
    ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`))
    : raw;
}
