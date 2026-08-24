import { describe, it, expect } from 'vitest';
import { attachLineage, lineageColumnNames } from '../../src/core/lineage/lineage';

describe('lineage', () => {
  it('attaches source columns to each row with incrementing row numbers', () => {
    const rows: Record<string, unknown>[] = [{ a: 1 }, { a: 2 }];
    attachLineage(
      rows,
      { sourceFile: 'D:/x/账.xlsx', sourceRow: 10 },
      '2026-08-24T00:00:00Z',
    );
    expect(rows[0]).toMatchObject({
      a: 1,
      __source_file: 'D:/x/账.xlsx',
      __source_row: 10,
      __extracted_at: '2026-08-24T00:00:00Z',
    });
    expect(rows[1].__source_row).toBe(11); // 行号递增
  });

  it('exposes lineage column names', () => {
    expect(lineageColumnNames()).toContain('__source_file');
    expect(lineageColumnNames()).toEqual([
      '__source_file',
      '__source_row',
      '__extracted_at',
    ]);
  });
});
