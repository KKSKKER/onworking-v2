// src/core/etl/writer.ts
// 批量写入大表:按 5000 行/批 insertBatch(事务),每批回报进度。
// 列类型直接用 SQLite 原生类型字符串(不用自造类型枚举)。
// 金额列声明 INTEGER —— 实测 better-sqlite3 v13 无类型列会把整数存成 REAL,
// 必须声明 INTEGER 才能保证「金额整数分」硬约束。
// 接入日志模块(开始/批进度/完成)与错误捕获(insert 失败 captureError 并抛出)。
import type Database from 'better-sqlite3';
import { createTableIfNotExists, insertBatch } from '../db/database';
import { logger } from '../logging';
import { captureError } from '../errors';

export interface ColumnDef {
  name: string;
  sqlType: string; // SQLite 原生列类型,如 'TEXT' | 'INTEGER' | 'REAL'
}

export interface WriteProgress {
  insertedRows: number;
  totalRows: number;
  percent: number;
}

export interface WriteResult {
  tableName: string;
  rowsInserted: number;
}

const BATCH_SIZE = 5000;
const MODULE = 'etl/writer';

export async function writeBigTable(
  db: Database.Database,
  tableName: string,
  colDefs: ColumnDef[],
  rows: Record<string, unknown>[],
  onProgress?: (p: WriteProgress) => void,
  opts?: { dropExisting?: boolean },
): Promise<WriteResult> {
  // 重建语义:先 DROP 再建(列名随当前映射,避免旧表结构漂移/重复追加)
  if (opts?.dropExisting) db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
  const columns = colDefs.map((c) => c.name);
  const colDefsSql = colDefs.map((c) => `"${c.name}" ${c.sqlType}`);
  logger.info(MODULE, 'write start', { table: tableName, rows: rows.length });
  createTableIfNotExists(db, tableName, colDefsSql);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows
      .slice(i, i + BATCH_SIZE)
      .map((r) => columns.map((c) => (r[c] === undefined ? null : r[c])));
    try {
      insertBatch(db, tableName, columns, batch);
    } catch (err) {
      throw captureError(err, {
        module: MODULE,
        code: 'ETL_INSERT_FAILED',
        message: `insert batch failed for table ${tableName}`,
        data: { table: tableName, batchStart: i },
      });
    }
    inserted += batch.length;
    onProgress?.({
      insertedRows: inserted,
      totalRows: rows.length,
      percent: rows.length === 0 ? 100 : Math.round((inserted / rows.length) * 100),
    });
    logger.debug(MODULE, 'batch inserted', { table: tableName, inserted, total: rows.length });
    // 每批让出事件循环:使 IPC 进度消息能流式送达渲染层(主进程不被整段阻塞)
    await new Promise((resolve) => setImmediate(resolve));
  }

  logger.info(MODULE, 'write complete', { table: tableName, inserted });
  return { tableName, rowsInserted: inserted };
}
