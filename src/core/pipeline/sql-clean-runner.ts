// src/core/pipeline/sql-clean-runner.ts
// SQL 清洗管线(大表 → 总表):ATTACH 各大表独立 DB → 执行清洗/汇总 SQL(SELECT)→ 手动物化到总表 DB。
// 这是独立于查询管线的步骤(SVG「大表之间插入 SQL 管道做清洗」)。
// 手动物化(SELECT 读 ATTACH 库 → INSERT 进总表),规避 CREATE TABLE AS 对 ATTACH 库的解析问题。
import type Database from 'better-sqlite3';
import { bigTableDbPath } from '../bigtable/store';
import { AppError } from '../errors';
import type { Workspace } from '../workspace/workspace';
import type { SqlCleanPipelineConfig } from './config';

export interface SqlCleanResult {
  pipelineId: string;
  rows: number;
}

const aliasOf = (folder: string): string => `bt_${folder.replace(/[^a-zA-Z0-9一-鿿_]/g, '_')}`;
const qt = (s: string): string => s.replace(/"/g, '""');

export async function runSqlCleanPipeline(
  masterDb: Database.Database,
  ws: Workspace,
  cfg: SqlCleanPipelineConfig,
): Promise<SqlCleanResult> {
  if (!cfg.sql.trim()) {
    throw new AppError({
      module: 'pipeline/sql-clean',
      code: 'SQLCLEAN_EMPTY_SQL',
      message: 'sql-clean pipeline has empty sql',
      data: { pipelineId: cfg.id },
    });
  }

  // 1. ATTACH 各大表 DB(别名 = bt_<大表>;SQL 用 "bt_序时账".seq 引用)
  for (const folder of cfg.bigTables) {
    const path = bigTableDbPath(ws, folder).replace(/\\/g, '/').replace(/'/g, "''");
    const alias = aliasOf(folder);
    try {
      masterDb.exec(`ATTACH DATABASE '${path}' AS "${qt(alias)}"`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AppError({
        module: 'pipeline/sql-clean',
        code: 'SQLCLEAN_ATTACH_FAILED',
        message: `cannot attach big table "${folder}": ${detail}`,
        data: { folder, path },
      });
    }
  }

  // 2. 执行清洗/汇总 SQL(读 ATTACH 库),取结果
  const rows = masterDb.prepare(cfg.sql).all() as Record<string, unknown>[];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  // 3. 物化到总表(覆盖式)。显式 "main". 限定,避免误删附加库(大表)的同名表。
  const mainTable = `main."${qt(cfg.resultTable)}"`;
  masterDb.exec(`DROP TABLE IF EXISTS ${mainTable}`);
  if (columns.length === 0) {
    masterDb.exec(`CREATE TABLE ${mainTable} (empty INTEGER)`);
  } else {
    const colDefs = columns.map((c) => `"${qt(c)}"`).join(', ');
    masterDb.exec(`CREATE TABLE ${mainTable} (${colDefs})`);
    const insert = masterDb.prepare(
      `INSERT INTO ${mainTable} VALUES (${columns.map(() => '?').join(', ')})`,
    );
    const tx = masterDb.transaction((batch: Record<string, unknown>[]) => {
      for (const r of batch) insert.run(columns.map((c) => (r[c] === undefined ? null : r[c])));
    });
    tx(rows);
  }

  // 4. DETACH 各大表
  for (const folder of cfg.bigTables) {
    try {
      masterDb.exec(`DETACH DATABASE "${qt(aliasOf(folder))}"`);
    } catch {
      // ignore
    }
  }

  return { pipelineId: cfg.id, rows: rows.length };
}
