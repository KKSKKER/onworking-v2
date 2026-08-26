// src/core/ingest/parser.ts
// Excel/CSV 解析。
// - Excel:sheet_to_json 用 raw:true 保留原生类型(数字/日期),避免 V1 先转字符串再转类型。
// - CSV:手写解析、全按字符串保留 —— CSV 无类型系统,SheetJS 的自动类型推断会把
//   "2024-01"(期间)误判成日期序列号,损坏金融数据。类型转换交给 ETL 层。
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';

export interface ParsedSheet {
  sheetName: string;
  headers: string[];
  rows: unknown[][];
  /** 是否因安全上限被截断(rows/cols):仅当数据真实超过上限时为 true,用于告警不静默丢数据。 */
  truncated?: { rows?: boolean; cols?: boolean };
}

export interface ParseOptions {
  /** 表头行(1-based),默认 1。 */
  headerRow?: number;
}

/** 安全上限:真实数据超过它才截断并告警(格式蔓延的假大范围不在此列,按真实数据范围处理)。 */
export const MAX_PARSE_ROWS = 100_000;
export const MAX_PARSE_COLS = 100;

/** 统计真实数据范围:最大「有值」行 + 「有 ≥2 个值」的最右列。
 *  单值列(如格式残留的最后一个 0)视为孤值,不计入真实列范围。 */
function dataBounds(ws: XLSX.WorkSheet): { maxRow: number; maxCol: number } {
  const colCount = new Map<number, number>();
  let maxRow = -1;
  for (const key of Object.keys(ws)) {
    if (key.startsWith('!')) continue;
    const c = ws[key];
    if (!c || c.v === undefined || c.v === '') continue; // 只看有值格子
    const addr = XLSX.utils.decode_cell(key);
    if (addr.r > maxRow) maxRow = addr.r;
    colCount.set(addr.c, (colCount.get(addr.c) ?? 0) + 1);
  }
  let maxCol = -1;
  for (const [c, n] of colCount) if (n >= 2 && c > maxCol) maxCol = c;
  return { maxRow, maxCol };
}

function buildRange(
  ref: string | undefined,
  headerRowIdx: number,
  bounds: { maxRow: number; maxCol: number },
): { range: string | undefined; truncated: { rows?: boolean; cols?: boolean } } {
  const truncated: { rows?: boolean; cols?: boolean } = {};
  if (!ref) return { range: undefined, truncated };
  const r = XLSX.utils.decode_range(ref);
  // 行:真实有值行(含表头)与声明的 range 取小,再封顶
  const realRow = Math.max(bounds.maxRow, headerRowIdx);
  const rowCap = headerRowIdx + MAX_PARSE_ROWS - 1;
  const rowEnd = Math.min(r.e.r, realRow, rowCap);
  if (realRow > rowCap) truncated.rows = true; // 真实数据超过上限 → 截断并告警
  // 列:真实列(≥2 值)与声明的 range 取小,再封顶
  const realCol = bounds.maxCol >= 0 ? bounds.maxCol : r.e.c;
  const colCap = MAX_PARSE_COLS - 1;
  const colEnd = Math.min(r.e.c, realCol, colCap);
  if (realCol > colCap) truncated.cols = true;
  if (rowEnd < r.s.r || colEnd < r.s.c) return { range: undefined, truncated };
  return { range: XLSX.utils.encode_range({ s: r.s, e: { r: rowEnd, c: colEnd } }), truncated };
}

/** 裁剪尾部空单元格(range 截断后出现的 '' 尾巴),只留真实数据列。 */
function trimTrailingEmpty(arr: unknown[]): unknown[] {
  let end = arr.length;
  while (end > 0 && (arr[end - 1] === '' || arr[end - 1] === null || arr[end - 1] === undefined)) end--;
  return arr.slice(0, end);
}

function parseWorkSheet(ws: XLSX.WorkSheet, sheetName: string, headerRowIdx: number): ParsedSheet {
  const { range, truncated } = buildRange(ws['!ref'], headerRowIdx, dataBounds(ws));
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, range }) as unknown[][];
  const headers = trimTrailingEmpty(aoa[headerRowIdx] ?? []).map((h) => String(h ?? '').trim());
  const rows = aoa.slice(headerRowIdx + 1).map((r) => trimTrailingEmpty(r));
  return { sheetName, headers, rows, truncated };
}

/** 解析内存 workbook(便于测试;文件版 parseExcelFile 读盘后走这里)。 */
export function parseWorkbook(wb: XLSX.WorkBook, opts?: ParseOptions): ParsedSheet[] {
  const headerRowIdx = (opts?.headerRow ?? 1) - 1;
  return wb.SheetNames.map((sheetName) => parseWorkSheet(wb.Sheets[sheetName], sheetName, headerRowIdx));
}

export function parseExcelFile(filePath: string, opts?: ParseOptions): ParsedSheet[] {
  return parseWorkbook(XLSX.readFile(filePath), opts);
}

/** 只解析指定 sheet(清洗管线按规则的 sheetName 定向解析,避免全表解析拖慢)。sheet 不存在返回 undefined。 */
export function parseExcelSheet(filePath: string, sheetName: string, opts?: ParseOptions): ParsedSheet | undefined {
  const wb = XLSX.readFile(filePath);
  const headerRowIdx = (opts?.headerRow ?? 1) - 1;
  const ws = wb.Sheets[sheetName];
  if (!ws) return undefined;
  return parseWorkSheet(ws, sheetName, headerRowIdx);
}

/** 手写 CSV 解析:支持引号包裹字段(含内嵌逗号/换行/双引号转义)。 */
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

export function parseCsvFile(filePath: string, opts?: ParseOptions): ParsedSheet[] {
  const text = readFileSync(filePath, 'utf-8');
  const table = parseCsvText(text);
  const headerRowIdx = (opts?.headerRow ?? 1) - 1;
  const headers = (table[headerRowIdx] ?? []).map((h) => h.trim());
  const rows = table.slice(headerRowIdx + 1);
  return [{ sheetName: 'csv', headers, rows }];
}
