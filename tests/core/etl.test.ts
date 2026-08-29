import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMapping, buildColIndex, centsToInt, normalizeDate, type FieldMapping } from '../../src/core/etl/transform';
import { openDatabase } from '../../src/core/db/database';
import { writeBigTable } from '../../src/core/etl/writer';
import { logger } from '../../src/core/logging';
import { arraySink } from '../../src/core/logging/sinks';
import type { LogEntry } from '../../src/core/logging/logger';
import type { ParsedSheet } from '../../src/core/ingest/parser';

describe('transform', () => {
  const sheet: ParsedSheet = {
    sheetName: 's',
    headers: ['日期', '借方金额', '摘要'],
    rows: [
      ['2024-01-15', 123.45, '工资'],
      ['2024-02-20', -5, ''],
    ],
  };

  it('maps by sourceHeader, converts cents and date', () => {
    const mappings: FieldMapping[] = [
      { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
      { sourceHeader: '借方金额', outputName: 'debit', transform: 'to-cents' },
      { sourceHeader: '摘要', outputName: 'note', transform: 'trim' },
    ];
    const out = applyMapping(sheet, mappings);
    expect(out[0].date).toBe('2024-01-15');
    expect(out[0].debit).toBe(12345); // 元 → 分
    expect(out[1].debit).toBe(-500);
    expect(out[1].note).toBeNull(); // 空字符串 → null
  });

  it('centsToInt converts yuan decimal to integer cents', () => {
    expect(centsToInt(123.45)).toBe(12345);
    expect(centsToInt(-0.05)).toBe(-5);
    expect(centsToInt('100')).toBe(10000);
    expect(centsToInt('')).toBeNull();
  });

  it('normalizeDate handles various inputs', () => {
    expect(normalizeDate('2024-01-15')).toBe('2024-01-15');
    expect(normalizeDate('2024/1/5')).toBe('2024-01-05');
  });

  it('buildColIndex maps numbered duplicates exactly (no last-wins overwrite)', () => {
    const idx = buildColIndex(['姓名', '出生日期', '姓名', '账号', '姓名']);
    expect(idx.get('姓名_2')).toBe(2);
    expect(idx.get('姓名')).toBeUndefined(); // 裸名不再指向最右
    expect(idx.get('账号')).toBe(3);
  });
});

describe('writer', () => {
  it('batch-writes rows with DB-native column types; INTEGER col stores integer', async () => {
    const db = openDatabase(':memory:');
    const rows = Array.from({ length: 12000 }, (_, i) => ({ a: `r${i}`, b: i }));
    const progress: number[] = [];
    const res = await writeBigTable(
      db,
      'big',
      [
        { name: 'a', sqlType: 'TEXT' },
        { name: 'b', sqlType: 'INTEGER' },
      ],
      rows,
      (p) => progress.push(p.percent),
    );
    expect(res.rowsInserted).toBe(12000);
    expect(progress[progress.length - 1]).toBe(100);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM big').get() as { n: number }).n;
    expect(n).toBe(12000);
    // 用数据库原生类型:INTEGER 列存整数,TEXT 列存文本
    const t = (db.prepare('SELECT typeof(b) AS t FROM big LIMIT 1').get() as { t: string }).t;
    expect(t).toBe('integer');
    const ta = (db.prepare('SELECT typeof(a) AS t FROM big LIMIT 1').get() as { t: string }).t;
    expect(ta).toBe('text');
    db.close();
  });

  it('captures a failed insert into the log (error capture wired)', async () => {
    const db = openDatabase(':memory:');
    const out: LogEntry[] = [];
    logger.addSink(arraySink(out));
    const rows = [{ a: null }]; // a 是 NOT NULL
    await expect(
      writeBigTable(db, 't', [{ name: 'a', sqlType: 'TEXT NOT NULL' }], rows),
    ).rejects.toThrow();
    expect(out.some((e) => e.level === 'error' && e.module === 'etl/writer')).toBe(true);
    logger.clearSinks();
    db.close();
  });
});
