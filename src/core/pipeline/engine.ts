// src/core/pipeline/engine.ts
// 重算编排引擎:单跑/多跑/全跑/按依赖自动重算。
// 依赖血缘有向图:recomputeByDependency 用 getRecomputeOrder(上游先),
// 只执行 pipeline 节点(bigtable/source 是数据节点,不执行)。
// 成功跑完清洗管线后更新项目状态机(phase=cleaned, files/mappedFields)。
import type Database from 'better-sqlite3';
import { openDatabase } from '../db/database';
import type { Workspace } from '../workspace/workspace';
import { LineageGraph } from '../lineage/graph';
import { listBigTables, loadBigTableConfig } from '../bigtable/store';
import { listPipelines, loadPipeline } from './store';
import { buildLineageGraph } from './registry';
import { runCleanPipeline } from './clean-runner';
import { runQueryPipeline } from './query-runner';
import { ProjectState } from '../state/project';
import { captureError } from '../errors';
import type { PipelineKind } from './config';

export interface RunSummary {
  pipelineId: string;
  kind: PipelineKind;
  ok: boolean;
  rows?: number;
  error?: string;
}

export class PipelineEngine {
  private ws: Workspace;
  readonly db: Database.Database;
  private graph: LineageGraph;

  constructor(ws: Workspace, dbPath: string) {
    this.ws = ws;
    this.db = openDatabase(dbPath);
    const pipelines = listPipelines(ws).map((id) => loadPipeline(ws, id));
    const bigTables = listBigTables(ws).map((folder) => {
      const cfg = loadBigTableConfig(ws, folder);
      return { folder, tableName: cfg.tableName };
    });
    this.graph = buildLineageGraph(pipelines, bigTables);
  }

  close(): void {
    this.db.close();
  }

  graphView(): LineageGraph {
    return this.graph;
  }

  private pipelineNodeIds(): string[] {
    return this.graph
      .serialize()
      .nodes.filter((n) => n.kind === 'clean-pipeline' || n.kind === 'query-pipeline')
      .map((n) => n.id);
  }

  async run(id: string): Promise<RunSummary> {
    const cfg = loadPipeline(this.ws, id);
    try {
      if (cfg.kind === 'clean') {
        const bigTable = loadBigTableConfig(this.ws, cfg.bigTableFolder);
        const result = await runCleanPipeline(this.db, cfg, bigTable);
        const st = new ProjectState(this.ws);
        st.setPhase(cfg.bigTableFolder, 'cleaned');
        st.registerFiles(cfg.bigTableFolder, result.files);
        st.registerMapping(cfg.bigTableFolder, cfg.mappings.length);
        st.save();
        return { pipelineId: id, kind: 'clean', ok: true, rows: result.rowsInserted };
      }
      const result = await runQueryPipeline(this.db, cfg);
      return { pipelineId: id, kind: 'query', ok: true, rows: result.rows };
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

  /** 多个管线重算:按子集内拓扑序(经完整图可达性)执行。 */
  async recomputeMany(ids: string[]): Promise<RunSummary[]> {
    const order = this.topoOrder(ids);
    const summaries: RunSummary[] = [];
    for (const id of order) summaries.push(await this.run(id));
    return summaries;
  }

  async recomputeAll(): Promise<RunSummary[]> {
    return this.recomputeMany(this.pipelineNodeIds());
  }

  /** 按依赖自动重算:触发点(如源目录)变更 → 沿血缘找受影响管线 → 拓扑序执行。 */
  async recomputeByDependency(triggerId: string): Promise<RunSummary[]> {
    const pipelineIds = new Set(this.pipelineNodeIds());
    const order = this.graph
      .getRecomputeOrder(triggerId)
      .filter((id) => pipelineIds.has(id));
    const summaries: RunSummary[] = [];
    for (const id of order) summaries.push(await this.run(id));
    return summaries;
  }

  /** 选中集合的拓扑序:若 b 在 a 的下游(完整图可达),则 a 先于 b。 */
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
    for (const id of ids) if (!order.includes(id)) order.push(id); // 环兜底
    return order;
  }
}
