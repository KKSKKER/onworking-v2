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

function parseExcelWorkbook(filePath: string, opts?: ParseOptions): ParsedSheet[] {
  const wb = XLSX.readFile(filePath);
  const headerRowIdx = (opts?.headerRow ?? 1) - 1;
  return wb.SheetNames.map((sheetName) => {
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }) as unknown[][];
    const headers = (aoa[headerRowIdx] ?? []).map((h) => String(h ?? '').trim());
    const rows = aoa.slice(headerRowIdx + 1);
    return { sheetName, headers, rows };
  });
}

export function parseExcelFile(filePath: string, opts?: ParseOptions): ParsedSheet[] {
  return parseExcelWorkbook(filePath, opts);
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
