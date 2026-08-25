import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
import { saveRule } from '../../src/core/rule/store';
import { toolRunPipeline, toolRunPipelines, toolPreviewCleanResult, toolSaveTemplate } from '../../src/core/agent/tools';
import { listTemplates } from '../../src/core/template/store';

describe('tools', () => {
  let dir: string;
  let ws: Workspace;
  let sourceDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tools-'));
    ws = initWorkspace(dir);
    sourceDir = join(dir, 'src');
    mkdirSync(sourceDir, { recursive: true });
    saveBigTableConfig(ws, 'seq', {
      tableName: 'seq',
      autoIncrement: true,
      fields: [
        { name: 'date', type: 'TEXT', order: 1 },
        { name: 'debit', type: 'INTEGER', order: 2 },
      ],
    });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['日期', '借方金额'],
      ['2024-01', 100],
      ['2024-02', 200],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'a.xlsx'));
    saveRule(ws, 'seq', {
      name: 'seq_rule',
      display: '规则',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
        { sourceHeader: '借方金额', outputName: 'debit', included: true, order: 2, transforms: [{ kind: 'coerce_cents' }] },
      ],
    });
    savePipeline(ws, {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir,
      createdAt: '',
    });
    savePipeline(ws, {
      kind: 'sql-clean',
      id: 'm1',
      label: '',
      bigTables: ['seq'],
      sql: 'SELECT date, debit FROM "bt_seq".seq',
      resultTable: 'seq',
      createdAt: '',
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('toolRunPipeline runs any kind by id', async () => {
    const clean = await toolRunPipeline(ws, 'c1');
    expect(clean.ok).toBe(true);
    expect(clean.rows).toBe(2);
    const master = await toolRunPipeline(ws, 'm1');
    expect(master.ok).toBe(true);
  });

  it('toolRunPipelines filters pipelines by kind and folder', async () => {
    const cleanOnly = await toolRunPipelines(ws, { kind: 'clean' });
    expect(cleanOnly.map((r) => r.pipelineId)).toEqual(['c1']);

    const masterOne = await toolRunPipelines(ws, { kind: 'sql-clean', bigTableFolder: 'seq' });
    expect(masterOne.map((r) => r.pipelineId)).toEqual(['m1']);

    const none = await toolRunPipelines(ws, { kind: 'clean', bigTableFolder: 'other' });
    expect(none).toEqual([]);
  });

  it('toolPreviewCleanResult reads the big table DB read-only', async () => {
    await toolRunPipeline(ws, 'c1');
    const res = toolPreviewCleanResult(ws, 'seq');
    expect(res.columns).toContain('date');
    expect(res.total).toBe(2);
    expect(res.rows).toHaveLength(2);
    const paged = toolPreviewCleanResult(ws, 'seq', { limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
  });

  it('toolSaveTemplate persists a mapping template', () => {
    const res = toolSaveTemplate(ws, { name: 'tpl1', mappings: [], createdAt: '2026-08-25T00:00:00.000Z' });
    expect(res).toEqual({ saved: 'tpl1' });
    expect(listTemplates(ws)).toContain('tpl1');
  });
});
