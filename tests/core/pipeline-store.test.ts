import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { savePipeline, listPipelinesForBigTable } from '../../src/core/pipeline/store';

describe('pipeline store', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pstore-'));
    ws = initWorkspace(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('listPipelinesForBigTable associates clean + sql-clean, never query, and filters by folder', () => {
    savePipeline(ws, { kind: 'clean', id: 'c_salary', label: '', bigTableFolder: 'salary', sourceDir: 's', createdAt: 't' });
    savePipeline(ws, { kind: 'clean', id: 'c_other', label: '', bigTableFolder: 'other', sourceDir: 's', createdAt: 't' });
    savePipeline(ws, { kind: 'sql-clean', id: 'sc_salary', label: '', bigTables: ['salary'], sql: 'S', resultTable: 'r', createdAt: 't' });
    savePipeline(ws, { kind: 'query', id: 'q', label: '', sql: 'S', dependencies: ['sc_salary'], resultTable: 'r', createdAt: 't' });
    const ids = listPipelinesForBigTable(ws, 'salary')
      .map((p) => p.id)
      .sort();
    expect(ids).toEqual(['c_salary', 'sc_salary']);
  });
});
