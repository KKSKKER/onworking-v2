// src/core/etl/writer.ts
// 批量写入大表:按 5000 行/批 insertBatch(事务),每批回报进度。
// 列定义带 SQL 类型,保证金额列(INTEGER)原生整数分存储。
import type Database from 'better-sqlite3';
import { createTableIfNotExists, insertBatch } from '../db/database';

export type SqlType = 'TEXT' | 'INTEGER' | 'REAL';

export interface ColumnDef {
  name: string;
  sqlType: SqlType;
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

export async function writeBigTable(
  db: Database.Database,
  tableName: string,
  colDefs: ColumnDef[],
  rows: Record<string, unknown>[],
  onProgress?: (p: WriteProgress) => void,
): Promise<WriteResult> {
  const columns = colDefs.map((c) => c.name);
  const colDefsSql = colDefs.map((c) => `"${c.name}" ${c.sqlType}`);
  createTableIfNotExists(db, tableName, colDefsSql);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows
      .slice(i, i + BATCH_SIZE)
      .map((r) => columns.map((c) => (r[c] === undefined ? null : r[c])));
    insertBatch(db, tableName, columns, batch);
    inserted += batch.length;
    onProgress?.({
      insertedRows: inserted,
      totalRows: rows.length,
      percent: rows.length === 0 ? 100 : Math.round((inserted / rows.length) * 100),
    });
  }

  return { tableName, rowsInserted: inserted };
}
