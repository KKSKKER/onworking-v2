import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, insertBatch, createTableIfNotExists } from '../../src/core/db/database';

describe('db batch insert', () => {
  let db: Database.Database;
  beforeAll(() => {
    db = openDatabase(':memory:');
  });
  afterAll(() => {
    db.close();
  });

  it('creates table and batch-inserts rows in one transaction', () => {
    createTableIfNotExists(db, 't', ['"a" TEXT', '"b" INTEGER']);
    const n = insertBatch(db, 't', ['a', 'b'], [
      ['x', 1],
      ['y', 2],
      ['z', 3],
    ]);
    expect(n).toBe(3);
    const rows = db.prepare('SELECT * FROM t ORDER BY b').all() as { a: string; b: number }[];
    expect(rows).toEqual([
      { a: 'x', b: 1 },
      { a: 'y', b: 2 },
      { a: 'z', b: 3 },
    ]);
  });

  it('rolls back the whole batch if any row fails', () => {
    createTableIfNotExists(db, 't2', ['"a" TEXT NOT NULL']);
    expect(() => insertBatch(db, 't2', ['a'], [['ok'], [null]])).toThrow();
    const n = (db.prepare('SELECT COUNT(*) AS n FROM t2').get() as { n: number }).n;
    expect(n).toBe(0); // NOT NULL 约束失败 → 整批回滚
  });

  it('is a no-op for an empty batch', () => {
    createTableIfNotExists(db, 't3', ['"a" TEXT']);
    expect(insertBatch(db, 't3', ['a'], [])).toBe(0);
  });
});
