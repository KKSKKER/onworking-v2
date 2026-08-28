// src/core/pipeline/sql-clean-runner.ts
// SQL 清洗管线(大表 → 总表):ATTACH 各大表独立 DB → 执行清洗/汇总 SQL(SELECT)→ 手动物化到总表 DB。
// 这是独立于查询管线的步骤(SVG「大表之间插入 SQL 管道做清洗」)。
// 手动物化(SELECT 读 ATTACH 库 → INSERT 进总表),规避 CREATE TABLE AS 对 ATTACH 库的解析问题。
// 内存有界:读连接流式迭代(不物化全量),5000 行一批事务写主库。
// 双连接:better-sqlite3 同一连接上 iterate() 迭代器未耗尽时不能执行其他语句("busy"),
// 所以 ATTACH + SELECT 游标放独立的只读连接,主库连接专职 DROP/CREATE/INSERT 分批物化。
import type Database from 'better-sqlite3';
import { bigTableDbPath } from '../bigtable/store';
import { AppError } from '../errors';
import type { Workspace } from '../workspace/workspace';
import { masterDbPath } from '../workspace/workspace';
import { openDatabase } from '../db/database';
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
  if (!cfg.resultTable || !cfg.resultTable.trim()) {
    throw new AppError({
      module: 'pipeline/sql-clean',
      code: 'SQLCLEAN_NO_RESULT_TABLE',
      message: 'sql-clean pipeline requires a non-empty resultTable',
      data: { pipelineId: cfg.id },
    });
  }
  if (!/^(SELECT|WITH)\b/i.test(cfg.sql.trim())) {
    throw new AppError({
      module: 'pipeline/sql-clean',
      code: 'SQLCLEAN_NOT_SELECT',
      message: 'sql-clean pipeline sql must start with SELECT or WITH',
      data: { pipelineId: cfg.id },
    });
  }

  // 1. 读连接:ATTACH 各大表 DB(别名 = bt_<大表>;SQL 用 "bt_序时账".seq 引用)
  //    读连接与写连接(masterDb)指向同一 master.db 文件;SELECT 只读 ATTACH 库,不锁主库,
  //    journal 模式下写连接可并发 DROP/CREATE/INSERT(见 tests/core/pipeline-engine.test.ts 用例)。
  const readDb = openDatabase(masterDbPath(ws), { wal: false });
  let iter: IterableIterator<Record<string, unknown>> | null = null;
  try {
    for (const folder of cfg.bigTables) {
      const path = bigTableDbPath(ws, folder).replace(/\\/g, '/').replace(/'/g, "''");
      const alias = aliasOf(folder);
      try {
        readDb.exec(`ATTACH DATABASE '${path}' AS "${qt(alias)}"`);
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

    // 2. 执行清洗/汇总 SQL(读 ATTACH 库),游标取结果(不物化全量,峰值内存与行数无关)
    const stmt = readDb.prepare(cfg.sql);
    iter = stmt.iterate() as IterableIterator<Record<string, unknown>>;

    // 3. 物化到总表(覆盖式)。显式 "main". 限定,避免误删附加库(大表)的同名表。
    const mainTable = `main."${qt(cfg.resultTable)}"`;
    const first = iter.next();
    if (first.done) {
      // 空结果集:保留旧行为 —— 建 (empty INTEGER) 占位表
      masterDb.exec(`DROP TABLE IF EXISTS ${mainTable}`);
      masterDb.exec(`CREATE TABLE ${mainTable} (empty INTEGER)`);
      return { pipelineId: cfg.id, rows: 0 };
    }
    const columns = stmt.columns().map((c) => c.name);
    masterDb.exec(`DROP TABLE IF EXISTS ${mainTable}`);
    const colDefs = columns.map((c) => `"${qt(c)}"`).join(', ');
    masterDb.exec(`CREATE TABLE ${mainTable} (${colDefs})`);
    const insert = masterDb.prepare(
      `INSERT INTO ${mainTable} VALUES (${columns.map(() => '?').join(', ')})`,
    );
    const tx = masterDb.transaction((batch: Record<string, unknown>[]) => {
      for (const r of batch) insert.run(columns.map((c) => (r[c] === undefined ? null : r[c])));
    });

    // 5000 行一批事务:读连接逐行流式消费 → 写连接分批物化。undefined → null 与旧 .all() 语义一致。
    // first.value 已放入首批,inserted 从 0 起算,避免重复计数。
    let inserted = 0;
    let batch: Record<string, unknown>[] = [first.value];
    for (const row of iter) {
      batch.push(row);
      if (batch.length >= 5000) { tx(batch); inserted += batch.length; batch = []; }
    }
    if (batch.length > 0) { tx(batch); inserted += batch.length; }

    return { pipelineId: cfg.id, rows: inserted };
  } finally {
    // 释放读连接:先 return() 游标(未耗尽时也必须,否则连接保持 busy),再关闭 → 自动 DETACH 各大表
    if (iter) {
      try { iter.return?.(); } catch { /* ignore */ }
    }
    readDb.close();
  }
}
