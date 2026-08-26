import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig, bigTableDbPath } from '../../src/core/bigtable/store';
import { openDatabase } from '../../src/core/db/database';
import { savePipeline } from '../../src/core/pipeline/store';
import { saveRule } from '../../src/core/rule/store';
import { PipelineEngine } from '../../src/core/pipeline/engine';
import { ProjectState } from '../../src/core/state/project';

describe('pipeline integration (end-to-end)', () => {
  let dir: string;
  let ws: Workspace;
  let sourceDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'int-'));
    ws = initWorkspace(dir);
    sourceDir = join(dir, 'src');
    mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('imports 20k rows end-to-end with lineage and integer cents', async () => {
    // 造 2 万行序时账样表
    const rows: unknown[][] = [['期间', '借方金额', '摘要']];
    for (let i = 0; i < 20000; i++) {
      rows.push([`2024-${String((i % 12) + 1).padStart(2, '0')}`, i * 1.5, `摘要${i}`]);
    }
    const wsx = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, '序时账');
    XLSX.writeFile(wb, join(sourceDir, 'seq.xlsx'));

    saveBigTableConfig(ws, 'seq', {
      tableName: 'seq',
      autoIncrement: true,
      fields: [
        { name: 'period', type: 'TEXT', order: 1 },
        { name: 'debit', type: 'INTEGER', order: 2 },
        { name: 'note', type: 'TEXT', order: 3 },
      ],
    });
    saveRule(ws, 'seq', {
      name: 'seq_rule',
      display: '规则',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '期间', outputName: 'period', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
        { sourceHeader: '借方金额', outputName: 'debit', included: true, order: 2, transforms: [{ kind: 'coerce_cents' }] },
        { sourceHeader: '摘要', outputName: 'note', included: true, order: 3, transforms: [{ kind: 'coerce_string' }] },
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

    const t0 = Date.now();
    const eng = new PipelineEngine(ws);
    const results = await eng.recomputeAll();
    const elapsed = Date.now() - t0;
    const r = results[0];
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(20000);

    // 大表数据落在它自己的 DB(每大表独立)
    const btdb = openDatabase(bigTableDbPath(ws, 'seq'));
    const row = btdb.prepare('SELECT * FROM seq LIMIT 1').get() as Record<string, unknown>;
    btdb.close();
    expect(row.__source_file).toBeTruthy(); // 血缘来源
    expect(typeof row.__source_row).toBe('number'); // 血缘行号是整数
    expect(typeof row.debit).toBe('number'); // 整数分

    // mappedFields 应是大表配置的字段数,而不是规则文件数
    const st = new ProjectState(ws);
    expect(st.getBigTable('seq')?.mappedFields).toBe(3);

    console.log(`[integration] 20k 行导入耗时 ${elapsed}ms (${Math.round((20000 / elapsed) * 1000)} 行/秒)`);
    eng.close();
  });
});
