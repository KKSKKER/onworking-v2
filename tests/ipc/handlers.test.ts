import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
import { PipelineEngine } from '../../src/core/pipeline/engine';
import { dispatch, type ApiContext } from '../../src/ipc/handlers';

describe('ipc handlers', () => {
  let dir: string;
  let ws: Workspace;
  let sourceDir: string;
  let ctx: ApiContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ipc-'));
    ws = initWorkspace(dir);
    sourceDir = join(dir, 'src');
    mkdirSync(sourceDir, { recursive: true });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['日期', '借方金额'],
      ['2024-01', 100],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'a.xlsx'));
    saveBigTableConfig(ws, 'seq', {
      tableName: 'seq',
      autoIncrement: true,
      fields: [
        { name: 'date', type: 'date', order: 1 },
        { name: 'debit', type: 'cents', order: 2 },
      ],
    });
    savePipeline(ws, {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir,
      headerRow: 1,
      mappings: [
        { sourceHeader: '日期', outputName: 'date', type: 'date' },
        { sourceHeader: '借方金额', outputName: 'debit', type: 'cents' },
      ],
      createdAt: '',
    });
    const dbPath = join(ws.onworkingDir, 'db', 'onworking.db');
    ctx = { ws, dbPath, getEngine: () => new PipelineEngine(ws, dbPath) };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists big tables', async () => {
    const res = await dispatch({ cmd: 'bigtable.list' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual(['seq']);
  });

  it('runs a pipeline end-to-end via ipc', async () => {
    const res = await dispatch({ cmd: 'pipeline.run', id: 'c1' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ pipelineId: 'c1', ok: true, rows: 1 });
  });

  it('detects source config via ipc', async () => {
    const res = await dispatch(
      { cmd: 'setup.detectSource', filePath: join(sourceDir, 'a.xlsx') },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { headers: string[] }).headers).toEqual(['日期', '借方金额']);
  });

  it('returns an error result for a failing command', async () => {
    const res = await dispatch({ cmd: 'bigtable.get', folder: 'missing' }, ctx);
    expect(res.ok).toBe(false);
  });

  it('returns an unknown-command error', async () => {
    const res = await dispatch({ cmd: 'nope' } as never, ctx);
    expect(res.ok).toBe(false);
  });

  it('state summary via ipc', async () => {
    const res = await dispatch({ cmd: 'state.summary' }, ctx);
    expect(res.ok).toBe(true);
  });
});
