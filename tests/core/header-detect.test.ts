import { describe, it, expect } from 'vitest';
import { detectHeaderRow, scoreHeaderCandidate, detectHeaderCandidates } from '../../src/core/ingest/header-detect';
import type { ParsedSheet } from '../../src/core/ingest/parser';

describe('header detect', () => {
  it('detects the string header row over numeric data rows', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: [],
      rows: [
        [123.45, 678, 20240101],
        ['日期', '借方金额', '摘要'],
        ['2024-01', 100.5, '工资'],
      ],
    };
    expect(detectHeaderRow(sheet)).toBe(1);
  });

  it('skips a leading title/blank row to find the header', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: [],
      rows: [
        ['XX公司2024年度序时账'],
        ['', '', ''],
        ['日期', '借方', '贷方'],
        ['2024-01', 1, 2],
      ],
    };
    expect(detectHeaderRow(sheet)).toBe(2);
  });

  it('returns -1 when no header-like row is found in the scan window', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: [],
      rows: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    };
    expect(detectHeaderRow(sheet)).toBe(-1);
  });

  it('scoreHeaderCandidate rewards string cells over numeric cells', () => {
    expect(scoreHeaderCandidate(['日期', '借方', '贷方'])).toBeGreaterThan(
      scoreHeaderCandidate([1, 2, 3]),
    );
  });
});

describe('detectHeaderCandidates', () => {
  it('finds both stacked table headers across the whole sheet (row 1 and row 15)', () => {
    const table1Data = Array.from({ length: 9 }, (_, i) => [20240101 + i, 100 + i, 50 + i]);
    const table2Data = Array.from({ length: 5 }, (_, i) => [i + 1, 500 + i, '']);
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['日期', '借方金额', '摘要'], // 行 1:表 1 表头
      rows: [
        ...table1Data, // 行 2-10
        ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], // 行 11-14 空行
        ['序号', '金额', '备注'], // 行 15:表 2 表头
        ...table2Data, // 行 16-20
      ],
    };
    expect(detectHeaderCandidates(sheet).map((c) => c.rowNumber)).toEqual([1, 15]);
  });

  it('trims trailing empty rows so they never become candidates', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['日期', '借方金额'],
      rows: [
        [20240101, 100],
        [20240102, 200],
        [20240103, 300],
        ['', ''],
        ['', ''],
        ['', ''],
      ],
    };
    expect(detectHeaderCandidates(sheet).map((c) => c.rowNumber)).toEqual([1]);
  });

  it('returns empty for an all-numeric sheet (no header-like deviation)', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['1', '2'],
      rows: [
        [3, 4],
        [5, 6],
      ],
    };
    expect(detectHeaderCandidates(sheet)).toEqual([]);
  });

  it('does not misreport a single-cell title row (low deviation)', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['XX公司2024年度序时账'], // 标题:单格字符串,偏离不足
      rows: [
        ['', '', ''],
        ['日期', '借方', '贷方'], // 真正的表头,行 3
        [20240101, 100, 50],
        [20240102, 200, 60],
      ],
    };
    expect(detectHeaderCandidates(sheet).map((c) => c.rowNumber)).toEqual([3]);
  });

  it('returns empty when every row is string-heavy (no data baseline to deviate from)', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['苹果', '香蕉'],
      rows: [
        ['红色', '黄色'],
        ['绿色', '蓝色'],
      ],
    };
    expect(detectHeaderCandidates(sheet)).toEqual([]);
  });

  it('returns cells (stringified) sorted by deviation descending, strongest first', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['日期', '借方金额'], // 行 1,score 4
      rows: [
        [20240101, 100], // 行 2,score 0
        ['日期', '贷方金额', '摘要', '经办人', '备注'], // 行 3,score 10
        [20240102, 200], // 行 4,score 0
        [20240103, 300], // 行 5,score 0
        ['月份'], // 行 6,score 2 → 偏离不足
        [20240104, 400], // 行 7,score 0
      ],
    };
    const cands = detectHeaderCandidates(sheet);
    expect(cands.map((c) => c.rowNumber)).toEqual([3, 1]);
    expect(cands[0].cells).toEqual(['日期', '贷方金额', '摘要', '经办人', '备注']);
    expect(cands[0].deviation).toBe(10);
    expect(cands[1].deviation).toBe(4);
  });

  it('truncates long cells to bound the output size', () => {
    const long = '摘要'.repeat(50); // 100 字符
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: [long, '金额'],
      rows: [
        [20240101, 100],
        [20240102, 200],
        [20240103, 300],
      ],
    };
    const cands = detectHeaderCandidates(sheet);
    expect(cands.length).toBe(1);
    expect(cands[0].cells[0].length).toBeLessThanOrEqual(60);
  });
});
