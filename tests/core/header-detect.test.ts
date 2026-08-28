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

  it('uses the mode as baseline: a majority-score data crowd is excluded, only the rare high header survives', () => {
    // 模拟「董监高控制表」:表头 22 分(唯一),数据行 20 分 ×4(同分大队=众数但出现>2 次),低分行 ×5 把 median 拉低
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['序号', '姓名', '关系', '甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'], // 11 字符串 → 22
      rows: [
        ['1', '初虹', '控股股东', '是', '是', '是', '是', '是', '是', '是', '是'], // '1' 是纯数字跳过,10 字符串 → 20
        ['2', '曾德利', '董事长', '是', '是', '是', '是', '是', '是', '是', '是'],
        ['3', '曾嵘', '总经理', '是', '是', '是', '是', '是', '是', '是', '是'],
        ['4', '黄福明', '股东', '是', '是', '是', '是', '是', '是', '是', '是'],
        ['总体要求', '适用'], // 2 字符串 → 4 (低分行)
        ['总体要求', '适用'],
        ['总体要求', '适用'],
        ['总体要求', '适用'],
        ['总体要求', '适用'],
      ],
    };
    const cands = detectHeaderCandidates(sheet);
    expect(cands.map((c) => c.rowNumber)).toEqual([1]);
  });

  it('keeps both headers when two stacked tables share the same score (frequency 2)', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['日期', '借方金额', '摘要'], // 行 1 → 6
      rows: [
        [20240101, 100, 50], // 行 2 → 0
        [20240102, 200, 60], // 行 3 → 0
        [20240103, 300, 70], // 行 4 → 0
        ['序号', '金额', '备注'], // 行 5 → 6 (表 2 表头,同分,freq=2)
        [1, 500, 'x'], // 行 6 → 'x' 字符串 → 2
        [2, 600, 'y'], // 行 7 → 2
      ],
    };
    const cands = detectHeaderCandidates(sheet);
    expect(cands.map((c) => c.rowNumber)).toEqual([1, 5]);
  });

  it('breaks mode ties toward the higher score (fewer, cleaner candidates)', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['甲', '乙', '丙'], // 6
      rows: [
        ['丁', '戊', '己'], // 6 (与表头同分,freq 并列众数)
        ['庚', '辛'], // 4
        ['壬', '癸'], // 4
        ['子', '丑', '寅', '卯', '辰'], // 10 → 唯一的稀有高分行
      ],
    };
    // 众数并列 6 与 4(各 2 次)→ 取较大者 6 → 只保留 10 分行
    const cands = detectHeaderCandidates(sheet);
    expect(cands.map((c) => c.rowNumber)).toEqual([5]);
    expect(cands[0].deviation).toBe(4);
  });
});
