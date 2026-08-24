import { describe, it, expect } from 'vitest';
import { detectHeaderRow, scoreHeaderCandidate } from '../../src/core/ingest/header-detect';
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
