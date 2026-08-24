import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/core/db/database';
import { runCleanPipeline } from '../../src/core/pipeline/clean-runner';
import type { CleanPipelineConfig } from '../../src/core/pipeline/config';
import type { BigTableConfig } from '../../src/core/bigtable/schema';

describe('clean pipeline runner', () => {
  let dir: string;
  let sourceDir: string;
  let db: Database.Database;
  let cfg: CleanPipelineConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cl-'));
    sourceDir = join(dir, 'src');
    mkdirSync(sourceDir, { recursive: true });
    db = openDatabase(':memory:');
    const ws = XLSX.utils.aoa_to_sheet([
      ['日期', '借方金额', '摘要'],
      ['2024-01-15', 123.45, '工资'],
      ['2024-02-20', 100, '报销'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'a.xlsx'));
    cfg = {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir,
      headerRow: 1,
      mappings: [
        { sourceHeader: '日期', outputName: 'date', type: 'date' },
        { sourceHeader: '借方金额', outputName: 'debit', type: 'cents' },
        { sourceHeader: '摘要', outputName: 'note', type: 'text' },
      ],
      createdAt: '',
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const bigTable: BigTableConfig = {
    tableName: 'seq',
    autoIncrement: true,
    fields: [
      { name: 'date', type: 'date', order: 1 },
      { name: 'debit', type: 'cents', order: 2 },
      { name: 'note', type: 'text', order: 3 },
    ],
  };

  it('scans, parses, maps, attaches lineage, and writes into the big table', async () => {
    const res = await runCleanPipeline(db, cfg, bigTable);
    expect(res.files).toBe(1);
    expect(res.rowsInserted).toBe(2);
    const rows = db.prepare('SELECT * FROM seq ORDER BY date').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0].debit).toBe(12345); // 元→分,整数
    expect(rows[0].note).toBe('工资');
    expect(String(rows[0].__source_file)).toContain('a.xlsx');
    expect(rows[0].__source_row).toBe(2); // 数据从第 2 行起
    expect(typeof rows[0].debit).toBe('number');
  });

  it('reports write progress reaching 100', async () => {
    const stages: string[] = [];
    await runCleanPipeline(db, cfg, bigTable, (p) => stages.push(`${p.stage}:${p.percent}`));
    expect(stages.join(',')).toMatch(/write:100/);
  });

  it('throws when the source dir has no supported files', async () => {
    const empty: CleanPipelineConfig = {
      ...cfg,
      sourceDir: join(dir, 'empty'),
    };
    await expect(runCleanPipeline(db, empty, bigTable)).rejects.toThrow();
  });
});
