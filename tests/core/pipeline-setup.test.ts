import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveTemplate } from '../../src/core/template/store';
import { detectSourceConfig, applyMappingTemplate } from '../../src/core/pipeline/setup';
import type { ParsedSheet } from '../../src/core/ingest/parser';

describe('pipeline setup', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'set-'));
    ws = initWorkspace(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detectSourceConfig finds the header row below a title/blank row', () => {
    const f = join(dir, 't.xlsx');
    const wsx = XLSX.utils.aoa_to_sheet([
      ['公司名'],
      ['', ''],
      ['日期', '金额'],
      ['2024-01', 100],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, f);
    const cfg = detectSourceConfig(f);
    expect(cfg.headerRow).toBe(3);
    expect(cfg.headers).toEqual(['日期', '金额']);
  });

  it('applyMappingTemplate loads and applies a saved template', () => {
    saveTemplate(ws, {
      name: 'seq',
      createdAt: '',
      mappings: [
        { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
        { sourceHeader: '不存在的列', outputName: 'x', transform: 'trim' },
      ],
    });
    const sheet: ParsedSheet = { sheetName: 's', headers: ['日期', '金额'], rows: [] };
    const res = applyMappingTemplate(ws, sheet, 'seq');
    expect(res.matched).toBe(1);
    expect(res.mappings[0].outputName).toBe('date');
  });
});
