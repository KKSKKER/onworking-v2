// src/core/db/database.ts
// SQLite 打开 + 批量事务写入(性能核心)。
// 批量写入用 prepare() + transaction():一次调用整批提交,失败整批回滚。
// 本层纯 better-sqlite3 进程内操作;worker 线程封装在 Electron 组装层。
import type Database from 'better-sqlite3';
import { loadSqlite } from './sqlite';

// 忙等上限(ms):SQLITE_BUSY("database is locked")时重试的上限。
// 默认 5s 偏短,app 与 CLI 并发写同一工作区这类瞬时竞争会过早抛错。
// 注意:真正"活进程持未提交写事务"会一直忙等到超时才抛 —— 那要靠
// closeAllOpenConnections 兜底 + 用户关闭持锁进程,不是加长超时能解决的。
export const SQLITE_BUSY_TIMEOUT_MS = 15000;

// 打开连接注册表:进程退出兜底时统一回滚+关闭。防止"活进程持未提交写事务"
// 把写锁永久占住(读正常、写全部 database is locked 的根因,探针 G)。
const openConnections = new Set<Database.Database>();
let exitCleanupRegistered = false;

export function openDatabase(dbPath: string): Database.Database {
  const Sqlite = loadSqlite(); // 双 ABI:按当前进程 node 自动选 137/115 构建
  const db = new Sqlite(dbPath);
  // 一律 WAL:
  //   - sql-clean 双连接(读连接 iterate + 写连接 DROP/CREATE/INSERT)只在 WAL 下成立;
  //   - 旧 wal:false 会让首次创建的库落入 DELETE,而 DELETE 模式同库"读+写"会
  //     "database is locked"(探针 B)。ATTACH 场景 WAL 也可靠(探针 F/H),统一 WAL。
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  openConnections.add(db);
  registerExitCleanup();
  return db;
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  // 正常退出 / process.exit() 时兜底:回滚未提交事务并释放写锁。
  // 被强杀(SIGKILL)无需处理 —— SQLite 下次打开会做 WAL 崩溃恢复(探针 A)。
  process.on('exit', () => {
    try {
      closeAllOpenConnections();
    } catch {
      /* 退出路径尽力而为 */
    }
  });
}

/** 关闭所有仍打开的连接(回滚未提交事务、释放写锁)。幂等,可重复调用。 */
export function closeAllOpenConnections(): void {
  for (const db of openConnections) {
    try {
      db.close();
    } catch {
      /* 调用方已自行 close,重复关闭抛错,忽略 */
    }
  }
  openConnections.clear();
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
