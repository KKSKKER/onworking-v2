// src/core/etl/transform.ts
// 字段映射 + 值转换。类型用数据库原生类型(存于大表配置);这里只管"值怎么变"。
import type { ParsedSheet } from '../ingest/parser';
import { canonicalizeHeaders } from './headers';

/** 值转换:清洗阶段对源值做的处理。类型与转换解耦。 */
export type ValueTransform = 'none' | 'to-cents' | 'normalize-date' | 'trim';

export interface FieldMapping {
  sourceHeader: string;
  outputName: string;
  transform: ValueTransform;
}

export interface TransformedRow {
  [outputName: string]: string | number | null;
}

/** 表头 → 列号索引:先规范化(重复表头编号 姓名_1..N),再精确映射;名字唯一,无覆盖。 */
export function buildColIndex(headers: string[]): Map<string, number> {
  const { names } = canonicalizeHeaders(headers);
  const colIndex = new Map<string, number>();
  names.forEach((h, i) => colIndex.set(h, i));
  return colIndex;
}

/** 单行映射:与 applyMapping 的逐行逻辑完全一致(缺列 raw undefined → applyTransform → null)。 */
export function applyMappingRow(
  row: unknown[],
  colIndex: Map<string, number>,
  mappings: FieldMapping[],
): TransformedRow {
  const out: TransformedRow = {};
  for (const m of mappings) {
    const idx = colIndex.get(m.sourceHeader);
    const raw = idx === undefined ? undefined : row[idx];
    out[m.outputName] = applyTransform(raw, m.transform);
  }
  return out;
}

export function applyMapping(sheet: ParsedSheet, mappings: FieldMapping[]): TransformedRow[] {
  const colIndex = buildColIndex(sheet.headers);
  return sheet.rows.map((row) => applyMappingRow(row, colIndex, mappings));
}

function applyTransform(v: unknown, transform: ValueTransform): string | number | null {
  switch (transform) {
    case 'to-cents':
      return centsToInt(v);
    case 'normalize-date':
      return normalizeDate(v);
    case 'trim':
      return toText(v);
    case 'none':
      return v === undefined || v === null ? null : (v as string | number);
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
