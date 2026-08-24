import { describe, it, expect } from 'vitest';
import { LineageGraph } from '../../src/core/lineage/graph';

function sample(): LineageGraph {
  const g = new LineageGraph();
  g.addNode({ id: 'src', kind: 'source' });
  g.addNode({ id: 'bt', kind: 'bigtable' });
  g.addNode({ id: 'clean1', kind: 'clean-pipeline' });
  g.addNode({ id: 'clean2', kind: 'clean-pipeline' });
  g.addNode({ id: 'q1', kind: 'query-pipeline' });
  g.addNode({ id: 'q2', kind: 'query-pipeline' });
  g.addEdge('src', 'bt');
  g.addEdge('bt', 'clean1');
  g.addEdge('bt', 'clean2');
  g.addEdge('clean1', 'q1');
  g.addEdge('clean2', 'q2');
  g.addEdge('q1', 'q2');
  return g;
}

describe('lineage graph', () => {
  it('tracks direct upstream/downstream', () => {
    const g = sample();
    expect(g.getUpstream('q1')).toEqual(['clean1']);
    expect(g.getDownstream('bt')).toEqual(expect.arrayContaining(['clean1', 'clean2']));
  });

  it('getAffected returns transitive downstream, excluding self', () => {
    const g = sample();
    const affected = g.getAffected('bt');
    expect(affected).toEqual(expect.arrayContaining(['clean1', 'clean2', 'q1', 'q2']));
    expect(affected).not.toContain('bt');
  });

  it('getAffected on a source reaches all downstream', () => {
    const g = sample();
    expect(g.getAffected('src')).toEqual(
      expect.arrayContaining(['bt', 'clean1', 'clean2', 'q1', 'q2']),
    );
  });

  it('getRecomputeOrder is topological (upstream first)', () => {
    const g = sample();
    const order = g.getRecomputeOrder('src');
    expect(order.indexOf('bt')).toBeLessThan(order.indexOf('clean1'));
    expect(order.indexOf('clean1')).toBeLessThan(order.indexOf('q1'));
    expect(order.indexOf('q1')).toBeLessThan(order.indexOf('q2'));
  });

  it('serialize/deserialize round-trips the graph', () => {
    const g = sample();
    const g2 = LineageGraph.deserialize(g.serialize());
    expect(g2.getDownstream('bt')).toEqual(expect.arrayContaining(['clean1', 'clean2']));
    expect(g2.getAffected('src')).toEqual(expect.arrayContaining(['q2']));
  });

  it('addEdge rejects unknown nodes', () => {
    const g = new LineageGraph();
    g.addNode({ id: 'a', kind: 'source' });
    expect(() => g.addEdge('a', 'nope')).toThrow();
  });
});
