import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { buildColIndex, applyMappingRow, type FieldMapping } from '../../src/core/etl/transform';
import { insertRowsInBatches } from '../../src/core/etl/writer';
import { openDatabase } from '../../src/core/db/database';
import { logger } from '../../src/core/logging';
import { arraySink } from '../../src/core/logging/sinks';
import type { LogEntry } from '../../src/core/logging/logger';

const MAPPINGS: FieldMapping[] = [
  { sourceHeader: 'date', outputName: 'date', transform: 'normalize-date' },
  { sourceHeader: 'debit', outputName: 'debit', transform: 'to-cents' },
  { sourceHeader: '备注', outputName: 'note', transform: 'none' },
];

describe('applyMappingRow', () => {
  it('与 applyMapping 的逐行逻辑一致(transform 应用、缺列→null)', () => {
    const headers = ['date', 'debit', '备注'];
    const row = ['2024-01-15', '100.00', '报销  "a,b"'];
    const single = applyMappingRow(row, buildColIndex(headers), MAPPINGS);
    expect(single).toEqual({
      date: '2024-01-15',
      debit: 10000,
      note: '报销  "a,b"',
    });
    // 缺列:sourceHeader 不在表头 → raw undefined → applyTransform → null
    const miss = applyMappingRow(['x'], buildColIndex(['x']), MAPPINGS);
    expect(miss).toEqual({ date: null, debit: null, note: null });
  });
});

describe('insertRowsInBatches', () => {
  it('异步生成器流式写库:12000 行全入库 + onBatch 分批回调', async () => {
    const db = openDatabase(':memory:');
    const res = await insertRowsInBatches(db, 't', [
      { name: 'n', sqlType: 'TEXT' },
      { name: 'v', sqlType: 'INTEGER' },
    ], (async function* () {
      for (let i = 0; i < 12000; i++) yield { n: `r${i}`, v: i };
    })(), {
      dropExisting: true,
      onBatch: (n) => { expect(n).toBeGreaterThan(0); },
    });
    expect(res.rowsInserted).toBe(12000);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    expect(total).toBe(12000);
    const first = db.prepare('SELECT n, v FROM t WHERE v = 0').get();
    expect(first).toMatchObject({ n: 'r0', v: 0 });
    const last = db.prepare('SELECT n FROM t WHERE v = 11999').get();
    expect(last).toMatchObject({ n: 'r11999' });
    db.close();
  });

  it('同步数组输入 + dropExisting=false 追加', async () => {
    const db = openDatabase(':memory:');
    await insertRowsInBatches(db, 't', [{ name: 'n', sqlType: 'TEXT' }], [{ n: 'a' }]);
    await insertRowsInBatches(db, 't', [{ name: 'n', sqlType: 'TEXT' }], [{ n: 'b' }]);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    expect(total).toBe(2);
    db.close();
  });

  it('空流:dropExisting 建表后 0 行', async () => {
    const db = openDatabase(':memory:');
    const r = await insertRowsInBatches(db, 't', [{ name: 'n', sqlType: 'TEXT' }], [], { dropExisting: true });
    expect(r.rowsInserted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    db.close();
  });

  it('insert 失败整批抛出 ETL_INSERT_FAILED 并记日志(与 writeBigTable 一致)', async () => {
    // 注意:SQLite 列亲和性会把 'not-an-int' 存进 INTEGER 列而不报错,必须用 NOT NULL + null 强制失败。
    const db = openDatabase(':memory:');
    const out: LogEntry[] = [];
    logger.addSink(arraySink(out));
    await expect(
      insertRowsInBatches(db, 't', [{ name: 'n', sqlType: 'TEXT NOT NULL' }], [{ n: 'a' }, { n: null }, { n: 'c' }], {})
    ).rejects.toThrow();
    expect(out.some((e) => e.level === 'error' && e.module === 'etl/writer')).toBe(true);
    logger.clearSinks();
    db.close();
  });
});
