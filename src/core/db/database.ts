// src/core/db/database.ts
// SQLite 打开 + 批量事务写入(性能核心)。
// 批量写入用 prepare() + transaction():一次调用整批提交,失败整批回滚。
// 本层纯 better-sqlite3 进程内操作;worker 线程封装在 Electron 组装层。
import Database from 'better-sqlite3';

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function createTableIfNotExists(
  db: Database.Database,
  table: string,
  colDefs: string[],
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')})`);
}

export function insertBatch(
  db: Database.Database,
  table: string,
  columns: string[],
  rows: unknown[][],
): number {
  if (rows.length === 0) return 0;
  const cols = columns.map((c) => `"${c}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`);
  const insertMany = db.transaction((batch: unknown[][]) => {
    for (const row of batch) stmt.run(...row);
  });
  insertMany(rows);
  return rows.length;
}
