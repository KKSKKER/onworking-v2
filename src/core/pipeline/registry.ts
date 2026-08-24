// src/core/pipeline/registry.ts
// 管线注册表:把大表 + 管线构建成 LineageGraph。
// 节点:bigtable(id=表名)、clean-pipeline、query-pipeline、source(源目录)。
// 边:source→clean→bigtable→query;query 可依赖另一 query 的结果表(query→query)。
import { LineageGraph } from '../lineage/graph';
import type { PipelineConfig } from './config';

export interface BigTableRef {
  folder: string;
  tableName: string;
}

export function buildLineageGraph(
  pipelines: PipelineConfig[],
  bigTables: BigTableRef[],
): LineageGraph {
  const g = new LineageGraph();
  const folderToTable = new Map(bigTables.map((b) => [b.folder, b.tableName]));
  const resultOf = new Map<string, string>(); // resultTable → query pipeline id

  // pass 1: 节点
  for (const b of bigTables) g.addNode({ id: b.tableName, kind: 'bigtable', label: b.folder });
  for (const p of pipelines) {
    if (p.kind === 'clean') {
      g.addNode({ id: p.id, kind: 'clean-pipeline', label: p.label });
      const srcId = `src:${p.sourceDir}`;
      if (!g.has(srcId)) g.addNode({ id: srcId, kind: 'source', label: p.sourceDir });
    } else if (p.kind === 'sql-clean') {
      g.addNode({ id: p.id, kind: 'sql-clean-pipeline', label: p.label });
      resultOf.set(p.resultTable, p.id);
    } else {
      g.addNode({ id: p.id, kind: 'query-pipeline', label: p.label });
      resultOf.set(p.resultTable, p.id);
    }
  }

  // pass 2: 边
  for (const p of pipelines) {
    if (p.kind === 'clean') {
      g.addEdge(`src:${p.sourceDir}`, p.id); // source → clean
      const tableName = folderToTable.get(p.bigTableFolder);
      if (tableName && g.has(tableName)) g.addEdge(p.id, tableName); // clean → bigtable
    } else if (p.kind === 'sql-clean') {
      // 每个参与大表 → sql-clean(大表 DB → 总表)
      for (const folder of p.bigTables) {
        const tableName = folderToTable.get(folder);
        if (tableName && g.has(tableName)) g.addEdge(tableName, p.id);
      }
    } else {
      for (const dep of p.dependencies) {
        if (g.has(dep)) g.addEdge(dep, p.id); // bigtable → query
        else {
          const depQuery = resultOf.get(dep);
          if (depQuery) g.addEdge(depQuery, p.id); // query → query(结果表依赖)
        }
      }
    }
  }

  return g;
}

/** 血缘图中所有 source 节点(源目录),即"更新源文件"的触发点。 */
export function findTriggerSources(graph: LineageGraph): string[] {
  return graph
    .serialize()
    .nodes.filter((n) => n.kind === 'source')
    .map((n) => n.id);
}
