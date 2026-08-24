import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { runInitialSetupFlow } from '../../src/core/agent/flow';

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
    for (const t of ['openWorkspace', 'createBigTable', 'importFiles', 'getFileHeaders', 'setBigTableFields', 'setupMapping', 'runCleaning', 'buildMasterTable', 'verifyData']) {
      expect(toolNames).toContain(t);
    }
    expect(result.steps.every((s) => s.ok)).toBe(true);
    // 数据落库:大表 DB + 总表 DB
    expect(result.bigTableRows).toBe(2);
    expect(result.masterRows).toBe(2);
  });
});
