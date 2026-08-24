import { describe, it, expect } from 'vitest';
import { buildLineageGraph, findTriggerSources } from '../../src/core/pipeline/registry';
import type { CleanPipelineConfig, QueryPipelineConfig } from '../../src/core/pipeline/config';

describe('pipeline registry', () => {
  it('builds source→clean→bigtable→query graph', () => {
    const clean: CleanPipelineConfig = {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir: '/d/seq',
      headerRow: 1,
      mappings: [],
      createdAt: '',
    };
    const q1: QueryPipelineConfig = {
      kind: 'query',
      id: 'q1',
      label: '',
      sql: '',
      dependencies: ['seq'],
      resultTable: 'r1',
      createdAt: '',
    };
    const q2: QueryPipelineConfig = {
      kind: 'query',
      id: 'q2',
      label: '',
      sql: '',
      dependencies: ['r1'], // q1 的结果表
      resultTable: 'r2',
      createdAt: '',
    };
    const g = buildLineageGraph([clean, q1, q2], [{ folder: 'seq', tableName: 'seq' }]);
    expect(g.getDownstream('c1')).toEqual(['seq']); // clean → bigtable
    expect(g.getDownstream('seq')).toContain('q1'); // bigtable → query
    expect(g.getDownstream('q1')).toContain('q2'); // query → query(经结果表)
    // 更新源 → 全链路受影响
    expect(g.getAffected('src:/d/seq')).toEqual(
      expect.arrayContaining(['c1', 'seq', 'q1', 'q2']),
    );
    expect(findTriggerSources(g)).toEqual(['src:/d/seq']);
  });

  it('skips dependencies with no matching node (does not throw)', () => {
    const q: QueryPipelineConfig = {
      kind: 'query',
      id: 'q1',
      label: '',
      sql: '',
      dependencies: ['missing-table'],
      resultTable: 'r1',
      createdAt: '',
    };
    const g = buildLineageGraph([q], []);
    expect(g.has('q1')).toBe(true);
  });
});
