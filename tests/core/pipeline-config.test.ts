import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import {
  validatePipeline,
  type CleanPipelineConfig,
  type QueryPipelineConfig,
} from '../../src/core/pipeline/config';
import {
  listPipelines,
  savePipeline,
  loadPipeline,
  deletePipeline,
} from '../../src/core/pipeline/store';

const cleanCfg = (): CleanPipelineConfig => ({
  kind: 'clean',
  id: 'c1',
  label: 'seq 清洗',
  bigTableFolder: 'seq',
  sourceDir: '/data/seq',
  createdAt: '2026-08-24',
});

const queryCfg = (): QueryPipelineConfig => ({
  kind: 'query',
  id: 'q1',
  label: '余额查询',
  sql: 'SELECT date, SUM(debit) AS total FROM seq GROUP BY date',
  dependencies: ['seq'],
  resultTable: 'balance',
  createdAt: '2026-08-24',
});

describe('pipeline config', () => {
  it('validates a clean pipeline', () => {
    expect(validatePipeline(cleanCfg())).toEqual([]);
    expect(validatePipeline({ ...cleanCfg(), id: '' })).toContain('id');
    expect(validatePipeline({ ...cleanCfg(), sourceDir: '' })).toContain('sourceDir');
    // 映射走规则 YAML(规则驱动),但 bigTableFolder 必填
    expect(validatePipeline({ ...cleanCfg(), bigTableFolder: '' })).toContain('bigTableFolder');
  });

  it('validates a query pipeline', () => {
    expect(validatePipeline(queryCfg())).toEqual([]);
    expect(validatePipeline({ ...queryCfg(), sql: '  ' })).toContain('sql');
    expect(validatePipeline({ ...queryCfg(), resultTable: '' })).toContain('resultTable');
  });
});

describe('pipeline store', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-'));
    ws = initWorkspace(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves, lists, loads, deletes a pipeline', () => {
    savePipeline(ws, cleanCfg());
    savePipeline(ws, queryCfg());
    expect(listPipelines(ws)).toEqual(['c1', 'q1']);
    expect(loadPipeline(ws, 'c1')).toMatchObject({ id: 'c1', kind: 'clean' });
    expect(loadPipeline(ws, 'q1').kind).toBe('query');
    deletePipeline(ws, 'c1');
    expect(listPipelines(ws)).toEqual(['q1']);
  });

  it('loadPipeline throws for a missing pipeline', () => {
    expect(() => loadPipeline(ws, 'nope')).toThrow();
  });
});
