// src/core/etl/writer.ts
// 批量写入大表:按 5000 行/批 insertBatch(事务),每批回报进度。
// 列类型直接用 SQLite 原生类型字符串(不用自造类型枚举)。
// 金额列声明 INTEGER —— 实测 better-sqlite3 v13 无类型列会把整数存成 REAL,
// 必须声明 INTEGER 才能保证「金额整数分」硬约束。
import type Database from 'better-sqlite3';
import { createTableIfNotExists, insertBatch } from '../db/database';

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
