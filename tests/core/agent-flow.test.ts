import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { runInitialSetupFlow } from '../../src/core/agent/flow';
import { toolCreateQueryPipeline, toolRunPipeline, toolQuery } from '../../src/core/agent/tools';
import { openWorkspace } from '../../src/core/workspace/workspace';
import { loadRules } from '../../src/core/rule/store';

describe('agent flow (initial setup via AI tools)', () => {
  let root: string;
  let sourceDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-'));
    sourceDir = join(root, 'src');
    mkdirSync(sourceDir, { recursive: true });
    const ws = XLSX.utils.aoa_to_sheet([
      ['日期', '借方金额', '摘要'],
      ['2024-01-15', 123.45, '工资'],
      ['2024-02-20', 100, '报销'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'a.xlsx'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runs the full initial-setup flow end-to-end via tool functions', async () => {
    const result = await runInitialSetupFlow({
      workspacePath: join(root, 'ws'),
      bigTableFolder: '序时账',
      sourceDir,
      tableName: 'seq',
    });

    expect(result.success).toBe(true);
    // 每个关键 AI tool 都被调用并成功
    const toolNames = result.steps.map((s) => s.tool);
    for (const t of ['openWorkspace', 'createBigTable', 'importFiles', 'getFileHeaders', 'setBigTableFields', 'setMapping', 'createCleaningPipeline', 'runCleaning', 'buildMasterTable', 'previewCleanResult']) {
      expect(toolNames).toContain(t);
    }
    expect(result.steps.every((s) => s.ok)).toBe(true);
    // 数据落库:大表 DB + 总表 DB
    expect(result.bigTableRows).toBe(2);
    expect(result.masterRows).toBe(2);

    // 查询管线:建 → 跑 → 查结果
    const ws = openWorkspace(join(root, 'ws'));
    toolCreateQueryPipeline(ws, 'q1', {
      sql: 'SELECT COUNT(*) AS n, SUM("借方金额") AS total FROM seq',
      dependencies: ['seq'],
      resultTable: 'q_result',
    });
    const qr = await toolRunPipeline(ws, 'q1');
    expect(qr.ok).toBe(true);
    const out = toolQuery(ws, 'SELECT * FROM q_result');
    expect(out.rowCount).toBe(1);
    expect(out.rows[0].total).toBe(22345); // 123.45 + 100 元 → 分
  });

  it('initial setup on a duplicate-header file generates numbered sourceHeaders (姓名_1/姓名_2/姓名_3)', async () => {
    rmSync(join(sourceDir, 'a.xlsx')); // 只留重复表头文件,保证 getFileHeaders 扫到它(而非 a.xlsx)
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'dup.xlsx'));

    const result = await runInitialSetupFlow({
      workspacePath: join(root, 'ws'),
      bigTableFolder: '序时账',
      sourceDir,
      tableName: 'seq',
    });
    expect(result.success).toBe(true);
    expect(result.bigTableRows).toBe(2);

    // 读取保存的规则,断言 sourceHeader 用了编号名(姓名_1/姓名_2/姓名_3)
    const ws = openWorkspace(join(root, 'ws'));
    const rules = loadRules(ws, '序时账');
    const headers = rules.flatMap((r) => r.fields ?? []).map((f) => f.sourceHeader);
    expect(headers).toContain('姓名_1');
    expect(headers).toContain('姓名_2');
    expect(headers).toContain('姓名_3');
  });
});
