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

/**
 * 流式批写:行来源可为同步数组或异步生成器(逐行产出,物化量 = 单批上限)。
 * dropExisting 时先 DROP 再建(重建语义:列名随当前映射,避免旧表结构漂移/重复追加)。
 * 失败整批抛出 ETL_INSERT_FAILED 并记日志(captureError);每批 setImmediate 让出事件循环。
 * onBatch 每批回调**累计**已插入数。空行流不触发任何批 → onBatch 不发(与旧语义一致)。
 */
export async function insertRowsInBatches(
  db: Database.Database,
  tableName: string,
  colDefs: ColumnDef[],
  rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
  opts: { dropExisting?: boolean; onBatch?: (inserted: number) => void } = {},
): Promise<WriteResult> {
  if (opts.dropExisting) db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
  const columns = colDefs.map((c) => c.name);
  const colDefsSql = colDefs.map((c) => `"${c.name}" ${c.sqlType}`);
  logger.info(MODULE, 'write start', { table: tableName });
  createTableIfNotExists(db, tableName, colDefsSql);

  let inserted = 0;
  let batch: Record<string, unknown>[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    try {
      // insertBatch 收位置数组:record → 按列序转(缺列 undefined → null)
      const rowsSql = batch.map((r) => columns.map((c) => (r[c] === undefined ? null : r[c])));
      insertBatch(db, tableName, columns, rowsSql);
      inserted += batch.length;
    } catch (err) {
      throw captureError(err, {
        module: MODULE,
        code: 'ETL_INSERT_FAILED',
        message: `insert batch failed for table ${tableName}`,
        data: { table: tableName, batchStart: inserted },
      });
    }
    opts.onBatch?.(inserted);
    logger.debug(MODULE, 'batch inserted', { table: tableName, inserted });
    batch = [];
    // 每批让出事件循环:使 IPC 进度消息能流式送达渲染层(主进程不被整段阻塞)
    await new Promise((resolve) => setImmediate(resolve));
  };

  // for await...of 对同步 Iterable 同样适用,无需分支。
  for await (const row of rows as AsyncIterable<Record<string, unknown>>) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  logger.info(MODULE, 'write complete', { table: tableName, inserted });
  return { tableName, rowsInserted: inserted };
}

export async function writeBigTable(
  db: Database.Database,
  tableName: string,
  colDefs: ColumnDef[],
  rows: Record<string, unknown>[],
  onProgress?: (p: WriteProgress) => void,
  opts?: { dropExisting?: boolean },
): Promise<WriteResult> {
  return insertRowsInBatches(db, tableName, colDefs, rows, {
    dropExisting: opts?.dropExisting,
    onBatch: (inserted) => {
      onProgress?.({
        insertedRows: inserted,
        totalRows: rows.length,
        percent: rows.length === 0 ? 100 : Math.round((inserted / rows.length) * 100),
      });
    },
  });
}
