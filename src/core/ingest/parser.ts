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
}

export interface ParseOptions {
  /** 表头行(1-based),默认 1。 */
  headerRow?: number;
}

/** 防止「格式蔓延」的假大范围:某些 sheet 因格式延伸 !ref 动辄 100 万行/16383 列,
 *  sheet_to_json 会物化整个范围 → 亿级格子导致卡死/内存暴涨。真实业务表远小于此上限,超出视为格式残留丢弃。 */
const MAX_PARSE_ROWS = 100_000;
const MAX_PARSE_COLS = 100;

function boundedRange(ws: XLSX.WorkSheet, headerRowIdx: number): string | undefined {
  const ref = ws['!ref'];
  if (!ref) return undefined;
  const r = XLSX.utils.decode_range(ref);
  const e = {
    r: Math.min(r.e.r, headerRowIdx + MAX_PARSE_ROWS),
    c: Math.min(r.e.c, MAX_PARSE_COLS),
  };
  if (e.r < r.s.r || e.c < r.s.c) return undefined;
  return XLSX.utils.encode_range({ s: r.s, e });
}

/** 裁剪尾部空单元格(range 截断后出现的 '' 尾巴),只留真实数据列。 */
function trimTrailingEmpty(arr: unknown[]): unknown[] {
  let end = arr.length;
  while (end > 0 && (arr[end - 1] === '' || arr[end - 1] === null || arr[end - 1] === undefined)) end--;
  return arr.slice(0, end);
}

function parseWorkSheet(ws: XLSX.WorkSheet, sheetName: string, headerRowIdx: number): ParsedSheet {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, range: boundedRange(ws, headerRowIdx) }) as unknown[][];
  const headers = trimTrailingEmpty(aoa[headerRowIdx] ?? []).map((h) => String(h ?? '').trim());
  const rows = aoa.slice(headerRowIdx + 1).map((r) => trimTrailingEmpty(r));
  return { sheetName, headers, rows };
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
