// src/core/pipeline/engine.ts
// 重算编排引擎:单跑/多跑/全跑/按依赖自动重算。
// 数据架构:源文件→(规则)→大表(每大表独立 DB)→(SQL清洗)→总表 DB→(查询)。
// clean 管线写各自大表的 DB;query/sql-clean 用总表 DB。引擎不持有常驻 DB,按需开关。
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openDatabase } from '../db/database';
import type { Workspace } from '../workspace/workspace';
import { masterDbPath } from '../workspace/workspace';
import { LineageGraph } from '../lineage/graph';
import { listBigTables, loadBigTableConfig, bigTableDbPath } from '../bigtable/store';
import { listPipelines, loadPipeline } from './store';
import { loadRules } from '../rule/store';
import { buildLineageGraph } from './registry';
import { runCleanPipeline } from './clean-runner';
import { runQueryPipeline } from './query-runner';
import { runSqlCleanPipeline } from './sql-clean-runner';
import { ProjectState } from '../state/project';
import { captureError } from '../errors';
import { logger } from '../logging';
import { commitWorkspaceChanges } from '../versioning/workspace-vcs';
import type { PipelineKind } from './config';
import type { CleanProgress } from './clean-runner';

const MODULE = 'pipeline/engine';

export interface RunSummary {
  pipelineId: string;
  kind: PipelineKind;
  ok: boolean;
  rows?: number;
  error?: string;
  /** 运行告警(如清洗入库时重复表头导致丢列)。 */
  warnings?: string[];
}

export interface QueryOutcome {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export class PipelineEngine {
  private ws: Workspace;
  private graph: LineageGraph;

  constructor(ws: Workspace) {
    this.ws = ws;
    const pipelines = listPipelines(ws).map((id) => loadPipeline(ws, id));
    const bigTables = listBigTables(ws).map((folder) => {
      const cfg = loadBigTableConfig(ws, folder);
      return { folder, tableName: cfg.tableName };
    });
    this.graph = buildLineageGraph(pipelines, bigTables);
  }

  /** 无常驻 DB,close 为兼容占位。 */
  close(): void {}

  graphView(): LineageGraph {
    return this.graph;
  }

  masterDb(): string {
    return masterDbPath(this.ws);
  }

  private bigTableDb(folder: string): Database.Database {
    const path = bigTableDbPath(this.ws, folder);
    mkdirSync(dirname(path), { recursive: true }); // 确保 db/ 目录存在
    return openDatabase(path, { wal: false }); // 非 WAL:保证 sql-clean ATTACH 可靠
  }

  private pipelineNodeIds(): string[] {
    return this.graph
      .serialize()
      .nodes.filter(
        (n) =>
          n.kind === 'clean-pipeline' || n.kind === 'query-pipeline' || n.kind === 'sql-clean-pipeline',
      )
      .map((n) => n.id);
  }

  async run(id: string, onProgress?: (p: CleanProgress) => void): Promise<RunSummary> {
    const cfg = loadPipeline(this.ws, id);
    try {
      if (cfg.kind === 'clean') {
        const bigTable = loadBigTableConfig(this.ws, cfg.bigTableFolder);
        const db = this.bigTableDb(cfg.bigTableFolder);
        let result;
        try {
          result = await runCleanPipeline(this.ws, db, cfg, bigTable, onProgress);
        } finally {
          db.close();
        }
        const st = new ProjectState(this.ws);
        st.setPhase(cfg.bigTableFolder, 'cleaned');
        st.registerFiles(cfg.bigTableFolder, result.files);
        st.registerMapping(cfg.bigTableFolder, loadRules(this.ws, cfg.bigTableFolder).length);
        st.save();
        commitWorkspaceChanges(this.ws, `pipeline ${id} (clean) ran`);
        logger.info(MODULE, 'run ok', { pipelineId: id, kind: 'clean', rows: result.rowsInserted, warnings: result.warnings });
        return { pipelineId: id, kind: 'clean', ok: true, rows: result.rowsInserted, warnings: result.warnings };
      }
      // query / sql-clean:用总表 DB
      const db = openDatabase(this.masterDb(), { wal: false });
      try {
        if (cfg.kind === 'query') {
          const result = await runQueryPipeline(db, cfg);
          commitWorkspaceChanges(this.ws, `pipeline ${id} (query) ran`);
          logger.info(MODULE, 'run ok', { pipelineId: id, kind: 'query', rows: result.rows });
          return { pipelineId: id, kind: 'query', ok: true, rows: result.rows };
        }
        // sql-clean(R2-T3 实现):ATTACH 各大表 → 跑 SQL → 物化总表
        const result = await runSqlCleanPipeline(db, this.ws, cfg);
        commitWorkspaceChanges(this.ws, `pipeline ${id} (sql-clean) ran`);
        logger.info(MODULE, 'run ok', { pipelineId: id, kind: 'sql-clean', rows: result.rows });
        return { pipelineId: id, kind: 'sql-clean', ok: true, rows: result.rows };
      } finally {
        db.close();
      }
    } catch (err) {
      const appErr = captureError(err, {
        module: 'pipeline/engine',
        code: 'PIPELINE_RUN_FAILED',
        message: `pipeline ${id} failed`,
        data: { pipelineId: id },
      });
      return { pipelineId: id, kind: cfg.kind, ok: false, error: appErr.message };
    }
  }

  /** 临时 SQL 查询(工作台),跑在总表 DB。limit 缺省不限(由前端分页/导出控制)。 */
  query(sql: string, limit?: number): QueryOutcome {
    const db = openDatabase(this.masterDb(), { wal: false });
    try {
      const finalSql = limit === undefined ? sql : (/\blimit\b/i.test(sql) ? sql : `${sql} LIMIT ${limit}`);
      const rows = db.prepare(finalSql).all() as Record<string, unknown>[];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { columns, rows, rowCount: rows.length };
    } finally {
      db.close();
    }
  }

  /** 总表表清单(含各表列结构,供前端侧边栏展示)。 */
  schemaTables(): { name: string; columns: { name: string; type: string }[] }[] {
    const db = openDatabase(this.masterDb(), { wal: false });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      return tables.map((t) => {
        const cols = db
          .prepare(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`)
          .all() as { name: string; type: string }[];
        return { name: t.name, columns: cols.map((c) => ({ name: c.name, type: c.type })) };
      });
    } finally {
      db.close();
    }
  }

  async recomputeMany(ids: string[]): Promise<RunSummary[]> {
    const order = this.topoOrder(ids);
    const summaries: RunSummary[] = [];
    for (const id of order) summaries.push(await this.run(id));
    return summaries;
  }

  async recomputeAll(): Promise<RunSummary[]> {
    return this.recomputeMany(this.pipelineNodeIds());
  }

  async recomputeByDependency(triggerId: string): Promise<RunSummary[]> {
    const pipelineIds = new Set(this.pipelineNodeIds());
    const order = this.graph
      .getRecomputeOrder(triggerId)
      .filter((id) => pipelineIds.has(id));
    const summaries: RunSummary[] = [];
    for (const id of order) summaries.push(await this.run(id));
    return summaries;
  }

  private topoOrder(ids: string[]): string[] {
    const wanted = new Set(ids);
    const indegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const id of ids) {
      indegree.set(id, 0);
      adj.set(id, []);
    }
    for (const a of ids) {
      for (const b of this.graph.getAffected(a)) {
        if (a === b || !wanted.has(b)) continue;
        if (!adj.get(a)!.includes(b)) {
          adj.get(a)!.push(b);
          indegree.set(b, indegree.get(b)! + 1);
        }
      }
    }
    const queue = ids.filter((id) => indegree.get(id) === 0).sort();
    const order: string[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      order.push(cur);
      for (const next of adj.get(cur)!) {
        indegree.set(next, indegree.get(next)! - 1);
        if (indegree.get(next) === 0) queue.push(next);
      }
      queue.sort();
    }
    for (const id of ids) if (!order.includes(id)) order.push(id);
    return order;
  }
}
