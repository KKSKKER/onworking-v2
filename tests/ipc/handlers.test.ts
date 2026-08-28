import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
import { saveRule } from '../../src/core/rule/store';
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

  it('setup.detectHeaders lists stacked table header candidates via ipc', async () => {
    const f = join(dir, 'stacked.xlsx');
    const aoa = [
      ['日期', '借方金额'], // row 1:表1 表头
      [20240101, 100],
      [20240102, 200],
      [20240103, 300],
      ['', ''],
      ['', ''],
      ['序号', '金额'], // row 7:表2 表头
      [1, 5],
      [2, 6],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
    XLSX.writeFile(wb, f);
    const res = await dispatch({ cmd: 'setup.detectHeaders', filePath: f }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { candidates: { rowNumber: number; deviation: number; cells: string[] }[] };
      expect(d.candidates.map((c) => c.rowNumber)).toEqual([1, 7]);
      expect(d.candidates[0].cells).toEqual(['日期', '借方金额']);
    }
  });

  it('setup.detectSource honors sheetName', async () => {
    const f = join(dir, 'multi.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['A1', 'A2'], ['v1', 'v2']]), 'Sheet1');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['B1', 'B2'], ['w1', 'w2']]), 'Sheet2');
    XLSX.writeFile(wb, f);
    const res = await dispatch({ cmd: 'setup.detectSource', filePath: f, sheetName: 'Sheet2' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { sheetName: string; headers: string[] };
      expect(d.sheetName).toBe('Sheet2');
      expect(d.headers).toEqual(['B1', 'B2']);
    }
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

  it('query.run now allows write statements (returns changes)', async () => {
    await dispatch({ cmd: 'pipeline.run', id: 'c1' }, ctx);
    await dispatch({ cmd: 'pipeline.run', id: 'm1' }, ctx);
    const res = await dispatch({ cmd: 'query.run', sql: "UPDATE seq SET debit = 1 WHERE date = '2024-01'" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { changes?: number };
      expect(d.changes).toBe(1);
    }
    // 再读,确认写生效
    const read = await dispatch({ cmd: 'query.run', sql: "SELECT debit FROM seq WHERE date = '2024-01'" }, ctx);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect((read.data as { rows: { debit: number }[] }).rows[0].debit).toBe(1);
    }
  });

  it('query.exportCsv exports the master table via ipc', async () => {
    await dispatch({ cmd: 'pipeline.run', id: 'c1' }, ctx);
    await dispatch({ cmd: 'pipeline.run', id: 'm1' }, ctx);
    const res = await dispatch({ cmd: 'query.exportCsv', sql: 'SELECT date, debit FROM seq' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { file: string; rows: number };
      expect(d.rows).toBe(1);
      expect(existsSync(d.file)).toBe(true);
    }
  });

  it('bigtable.exportCsv exports via ipc', async () => {
    await dispatch({ cmd: 'pipeline.run', id: 'c1' }, ctx);
    const res = await dispatch({ cmd: 'bigtable.exportCsv', folder: 'seq' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { file: string; rows: number };
      expect(d.rows).toBe(1);
      expect(existsSync(d.file)).toBe(true);
    }
  });

  it('bigtable.addFiles copies files into the big table source dir via ipc', async () => {
    const srcFile = join(dir, 'new.xlsx');
    writeFileSync(srcFile, 'x');
    const res = await dispatch({ cmd: 'bigtable.addFiles', folder: 'seq', files: [srcFile] }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ added: ['new.xlsx'], overwritten: [], skipped: [] });
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
