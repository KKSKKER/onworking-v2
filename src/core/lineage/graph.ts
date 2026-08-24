// src/core/lineage/graph.ts
// 血缘网络:管线/大表/源文件之间的有向图。
// 边 from → to 表示「from 是 to 的上游,to 依赖 from」。
// 核心应用:源数据/清洗规则变更时,沿有向图找出受影响的下游并给出重算顺序(按依赖自动重算)。
import { AppError } from '../errors';

export type LineageNodeKind =
  | 'source'
  | 'bigtable'
  | 'clean-pipeline'
  | 'query-pipeline';

export interface LineageNode {
  id: string;
  kind: LineageNodeKind;
  label?: string;
}

export interface LineageEdge {
  from: string;
  to: string;
}

export interface LineageGraphData {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export class LineageGraph {
  private nodes = new Map<string, LineageNode>();
  private downstream = new Map<string, string[]>();
  private upstream = new Map<string, string[]>();

  addNode(node: LineageNode): void {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
      this.downstream.set(node.id, []);
      this.upstream.set(node.id, []);
    }
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  addEdge(from: string, to: string): void {
    if (!this.nodes.has(from)) {
      throw new AppError({
        module: 'lineage/graph',
        code: 'LINEAGE_NODE_MISSING',
        message: `lineage node not found: ${from}`,
        data: { from },
      });
    }
    if (!this.nodes.has(to)) {
      throw new AppError({
        module: 'lineage/graph',
        code: 'LINEAGE_NODE_MISSING',
        message: `lineage node not found: ${to}`,
        data: { to },
      });
    }
    if (!this.downstream.get(from)!.includes(to)) {
      this.downstream.get(from)!.push(to);
    }
    if (!this.upstream.get(to)!.includes(from)) {
      this.upstream.get(to)!.push(from);
    }
  }

  /** 直接上游(该节点依赖谁)。 */
  getUpstream(id: string): string[] {
    return this.upstream.get(id) ?? [];
  }

  /** 直接下游(谁依赖该节点)。 */
  getDownstream(id: string): string[] {
    return this.downstream.get(id) ?? [];
  }

  /** 变更 id 后所有受影响的下游节点(传递闭包,不含自身)。这是「按依赖自动重算」要找的集合。 */
  getAffected(id: string): string[] {
    const affected = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of this.getDownstream(cur)) {
        if (!affected.has(next)) {
          affected.add(next);
          queue.push(next);
        }
      }
    }
    return [...affected];
  }

  /** 受影响节点的重算顺序(拓扑序:上游先算)。 */
  getRecomputeOrder(id: string): string[] {
    const affected = new Set(this.getAffected(id));
    const visited = new Set<string>();
    const order: string[] = [];
    const visit = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      for (const up of this.getUpstream(nodeId)) {
        if (affected.has(up) && !visited.has(up)) visit(up);
      }
      order.push(nodeId);
    };
    for (const a of [...affected].sort()) visit(a);
    return order;
  }

  serialize(): LineageGraphData {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.downstream.entries()].flatMap(([from, tos]) =>
        tos.map((to) => ({ from, to })),
      ),
    };
  }

  static deserialize(data: LineageGraphData): LineageGraph {
    const g = new LineageGraph();
    for (const n of data.nodes) g.addNode(n);
    for (const e of data.edges) g.addEdge(e.from, e.to);
    return g;
  }
}
