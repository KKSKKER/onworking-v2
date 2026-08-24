// src/core/etl/transform.ts
// 字段映射 + 类型转换。金额 → 整数分(cents),日期 → YYYY-MM-DD,空值 → null。
import type { ParsedSheet } from '../ingest/parser';
import type { FieldType } from '../bigtable/schema';

export interface FieldMapping {
  sourceHeader: string;
  outputName: string;
  type: FieldType;
}

export interface TransformedRow {
  [outputName: string]: string | number | null;
}

export function applyMapping(sheet: ParsedSheet, mappings: FieldMapping[]): TransformedRow[] {
  const colIndex = new Map<string, number>();
  sheet.headers.forEach((h, i) => colIndex.set(h, i));
  return sheet.rows.map((row) => {
    const out: TransformedRow = {};
    for (const m of mappings) {
      const idx = colIndex.get(m.sourceHeader);
      const raw = idx === undefined ? undefined : row[idx];
      out[m.outputName] = convertByType(raw, m.type);
    }
    return out;
  });
}

function convertByType(v: unknown, type: FieldType): string | number | null {
  switch (type) {
    case 'cents':
      return centsToInt(v);
    case 'date':
      return normalizeDate(v);
    case 'number':
      return toNumber(v);
    case 'text':
      return toText(v);
  }
}

/** 金额 → 整数分。支持 number / 字符串(含千分位与人民币符号)。 */
export function centsToInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,¥￥\s]/g, ''));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

/** 日期 → YYYY-MM-DD。支持字符串、Date、Excel 日期序列号;YYYY-MM(期间)原样保留。 */
export function normalizeDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 20000) {
    // Excel 日期序列号(1900 系统)
    const date = new Date(Math.round((Number(s) - 25569) * 86400 * 1000));
    return date.toISOString().slice(0, 10);
  }
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}$/.test(s)) return s; // 期间字段
  return s;
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,¥￥\s]/g, ''));
  return Number.isNaN(n) ? null : n;
}

export function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** 语义类型 → SQLite 原生列类型。金额→INTEGER(整数分),数字→REAL,文本/日期→TEXT。 */
export function dbTypeFor(type: FieldType): string {
  switch (type) {
    case 'cents':
      return 'INTEGER';
    case 'number':
      return 'REAL';
    case 'text':
      return 'TEXT';
    case 'date':
      return 'TEXT';
  }
}
