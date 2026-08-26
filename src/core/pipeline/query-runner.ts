// src/core/pipeline/query-runner.ts
// 查询管线执行器:执行 SQL,把结果物化到结果表(CREATE TABLE AS),覆盖式重跑。
import type Database from 'better-sqlite3';
import { AppError } from '../errors';
import { logger } from '../logging';
import type { QueryPipelineConfig } from './config';

const MODULE = 'pipeline/query';

export interface QueryResult {
  pipelineId: string;
  resultTable: string;
  rows: number;
}

export async function runQueryPipeline(
  db: Database.Database,
  cfg: QueryPipelineConfig,
): Promise<QueryResult> {
  const sql = cfg.sql.trim();
  logger.info(MODULE, 'query start', { pipelineId: cfg.id, resultTable: cfg.resultTable });
  if (!/^(SELECT|WITH)\b/i.test(sql)) {
    throw new AppError({
      module: 'pipeline/query',
      code: 'QUERY_NOT_SELECT',
      message: 'query pipeline sql must start with SELECT or WITH',
      data: { sql },
    });
  }
  if (!cfg.resultTable || !cfg.resultTable.trim()) {
    throw new AppError({
      module: 'pipeline/query',
      code: 'QUERY_NO_RESULT_TABLE',
      message: 'query pipeline requires a non-empty resultTable',
      data: { pipelineId: cfg.id },
    });
  }
  db.exec(`DROP TABLE IF EXISTS "${cfg.resultTable}"`);
  db.exec(`CREATE TABLE "${cfg.resultTable}" AS ${sql}`);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM "${cfg.resultTable}"`)
    .get() as { n: number };
  logger.info(MODULE, 'query complete', { pipelineId: cfg.id, rows: row.n });
  return { pipelineId: cfg.id, resultTable: cfg.resultTable, rows: row.n };
}
