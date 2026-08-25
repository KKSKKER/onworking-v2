import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
import { PipelineEngine } from '../../src/core/pipeline/engine';
import { dispatch, dispatchIpc, type ApiContext } from '../../src/ipc/handlers';

describe('ipc handlers', () => {
  let dir: string;
  let ws: Workspace;
  let sourceDir: string;
  let ctx: ApiContext;
  let engine: PipelineEngine | null = null;

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
        { name: 'date', type: 'TEXT', order: 1 },
        { name: 'debit', type: 'INTEGER', order: 2 },
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
        { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
        { sourceHeader: '借方金额', outputName: 'debit', transform: 'to-cents' },
      ],
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
    const dbPath = join(ws.onworkingDir, 'db', 'master.db');
    ctx = {
      ws,
      dbPath,
      getEngine: () => (engine ??= new PipelineEngine(ws)),
    };
  });

  afterEach(() => {
    engine?.close();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

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

  it('query.run executes real SQL and returns rows', async () => {
    // 先跑 clean(大表 DB)+ sql-clean(总表 DB),再查
    await dispatch({ cmd: 'pipeline.run', id: 'c1' }, ctx);
    await dispatch({ cmd: 'pipeline.run', id: 'm1' }, ctx);
    const res = await dispatch({ cmd: 'query.run', sql: 'SELECT date, debit FROM seq ORDER BY date' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { columns: string[]; rows: Record<string, unknown>[] };
      expect(d.columns).toContain('date');
      expect(d.rows.length).toBe(1);
      expect(d.rows[0].debit).toBe(10000); // 100 元 → 分
    }
  });

  it('query.run rejects non-SELECT sql', async () => {
    const res = await dispatch({ cmd: 'query.run', sql: 'DELETE FROM seq' }, ctx);
    expect(res.ok).toBe(false);
  });

  it('pipeline.save honours the caller-supplied id for clean pipelines', async () => {
    const res = await dispatch(
      {
        cmd: 'pipeline.save',
        config: {
          kind: 'clean',
          id: 'my-clean',
          label: '',
          bigTableFolder: 'seq',
          sourceDir,
          createdAt: '',
        },
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ pipelineId: 'my-clean' });
  });

  it('dispatchIpc echoes reqId so async requests can be reconciled', async () => {
    const res = await dispatchIpc({ cmd: 'state.summary', reqId: 42 }, ctx);
    expect(res.reqId).toBe(42);
    if (!('result' in res)) throw new Error('expected a result envelope');
    expect(res.result.ok).toBe(true);
  });

  it('setup.preview returns headers and rows for a source file', async () => {
    const res = await dispatch(
      { cmd: 'setup.preview', filePath: join(sourceDir, 'a.xlsx'), headerRow: 1, limit: 10 },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { headers: string[]; rows: unknown[][] };
      expect(d.headers).toEqual(['日期', '借方金额']);
      expect(d.rows.length).toBe(1);
    }
  });
});
