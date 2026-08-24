import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { scanSourceDir } from '../../src/core/ingest/scanner';
import { parseCsvFile, parseExcelFile } from '../../src/core/ingest/parser';

describe('scanner', () => {
  it('finds xlsx/xls/csv recursively, ignores others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ing-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.xlsx'), '');
    writeFileSync(join(dir, 'b.csv'), '');
    writeFileSync(join(dir, 'sub', 'c.xls'), '');
    writeFileSync(join(dir, 'd.txt'), '');
    const found = scanSourceDir(dir).map((f) => f.relPath);
    expect(found).toContain('a.xlsx');
    expect(found).toContain('b.csv');
    expect(found).toContain(join('sub', 'c.xls'));
    expect(found).not.toContain('d.txt');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('parser', () => {
  it('parses csv with header + rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-'));
    const p = join(dir, 'x.csv');
    writeFileSync(p, 'date,amount\n2024-01,100\n2024-02,200\n');
    const [sheet] = parseCsvFile(p);
    expect(sheet.sheetName).toBeTruthy();
    expect(sheet.headers).toEqual(['date', 'amount']);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0][0]).toBe('2024-01');
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses xlsx with raw:true keeping native number type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
    const p = join(dir, 't.xlsx');
    const ws = XLSX.utils.aoa_to_sheet([
      ['date', 'amount'],
      ['2024-01-01', 123.45],
      ['2024-02-01', 200],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, p);
    const [sheet] = parseExcelFile(p);
    expect(sheet.headers).toEqual(['date', 'amount']);
    expect(typeof sheet.rows[0][1]).toBe('number'); // raw:true → 123.45 保持 number
    expect(sheet.rows[1][1]).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  });
});
