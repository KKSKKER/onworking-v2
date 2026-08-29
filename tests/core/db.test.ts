import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  insertBatch,
  createTableIfNotExists,
  closeAllOpenConnections,
  SQLITE_BUSY_TIMEOUT_MS,
} from '../../src/core/db/database';

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

describe('openDatabase journal mode, busy timeout & exit cleanup', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('新库首次打开即 WAL(与旧 wal:false 路径的 DELETE 模式一刀两断)', () => {
    const db = openDatabase(join(dir, 'm.db'));
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('显式设置 busy_timeout(瞬时并发重试,而非默认 5s 后立即 SQLITE_BUSY)', () => {
    const db = openDatabase(join(dir, 'b.db'));
    try {
      expect(db.pragma('busy_timeout', { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  it('closeAllOpenConnections 回滚未提交写事务并释放写锁(进程退出兜底)', () => {
    const path = join(dir, 'l.db');
    const a = openDatabase(path);
    a.exec('CREATE TABLE t(x)'); // 自动提交,表已存在
    a.exec('BEGIN IMMEDIATE'); // 开写事务
    a.exec('INSERT INTO t VALUES (1)'); // 未提交 → a 持写锁("database is locked" 根因)
    closeAllOpenConnections(); // 模拟进程退出兜底:回滚并关闭所有连接
    const b = openDatabase(path);
    expect(() => b.exec('INSERT INTO t VALUES (2)')).not.toThrow(); // 锁已释放
    const rows = b.prepare('SELECT x FROM t ORDER BY x').all() as { x: number }[];
    expect(rows).toEqual([{ x: 2 }]); // a 的事务被回滚,1 未落库
    b.close();
  });
});
