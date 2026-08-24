import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/core/db/database';
import { runQueryPipeline } from '../../src/core/pipeline/query-runner';
import type { QueryPipelineConfig } from '../../src/core/pipeline/config';

describe('query pipeline runner', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openDatabase(':memory:');
    db.exec('CREATE TABLE seq (date TEXT, debit INTEGER)');
    db.prepare('INSERT INTO seq (date, debit) VALUES (?, ?)').run('2024-01', 10000);
    db.prepare('INSERT INTO seq (date, debit) VALUES (?, ?)').run('2024-02', 20000);
  });

  afterAll(() => db.close());

  const cfg = (sql: string): QueryPipelineConfig => ({
    kind: 'query',
    id: 'q1',
    label: '',
    sql,
    dependencies: ['seq'],
    resultTable: 'balance',
    createdAt: '',
  });

  it('runs a SELECT and materializes the result into the result table', async () => {
    const res = await runQueryPipeline(
      db,
      cfg('SELECT date, SUM(debit) AS total FROM seq GROUP BY date'),
    );
    expect(res.resultTable).toBe('balance');
    expect(res.rows).toBe(2);
    const rows = db
      .prepare('SELECT * FROM balance ORDER BY date')
      .all() as Record<string, unknown>[];
    expect(rows[0].total).toBe(10000);
  });

  it('re-runs replace the previous result table (no duplicates)', async () => {
    const sql = 'SELECT date, SUM(debit) AS total FROM seq GROUP BY date';
    await runQueryPipeline(db, cfg(sql));
    const res = await runQueryPipeline(db, cfg(sql));
    expect(res.rows).toBe(2); // 覆盖,不追加
    const n = (db.prepare('SELECT COUNT(*) AS n FROM balance').get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it('rejects non-SELECT sql', async () => {
    await expect(runQueryPipeline(db, cfg('DELETE FROM seq'))).rejects.toThrow();
  });
});
