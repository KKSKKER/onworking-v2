import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import type { ParsedSheet } from '../../src/core/ingest/parser';
import {
  saveTemplate,
  listTemplates,
  loadTemplate,
  deleteTemplate,
  applyTemplateToSheet,
} from '../../src/core/template/store';

describe('template store', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tpl-'));
    ws = initWorkspace(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves, lists, loads, deletes a template', () => {
    saveTemplate(ws, {
      name: 'seq',
      createdAt: '2026-08-24',
      mappings: [{ sourceHeader: '日期', outputName: 'date', type: 'date' }],
    });
    expect(listTemplates(ws)).toEqual(['seq']);
    expect(loadTemplate(ws, 'seq').mappings[0].outputName).toBe('date');
    deleteTemplate(ws, 'seq');
    expect(listTemplates(ws)).toEqual([]);
  });

  it('loadTemplate throws for a missing template', () => {
    expect(() => loadTemplate(ws, 'nope')).toThrow();
  });

  it('saveTemplate rejects unsafe names', () => {
    expect(() =>
      saveTemplate(ws, { name: '../evil', createdAt: '', mappings: [] }),
    ).toThrow();
  });

  it('applyTemplateToSheet matches by sourceHeader and reports matched/skipped', () => {
    const tpl = {
      name: 'seq',
      createdAt: '2026-08-24',
      mappings: [
        { sourceHeader: '日期', outputName: 'date', type: 'date' as const },
        { sourceHeader: '借方金额', outputName: 'debit', type: 'cents' as const },
        { sourceHeader: '不存在的列', outputName: 'x', type: 'text' as const },
      ],
    };
    const sheet: ParsedSheet = { sheetName: 's', headers: ['日期', '借方金额', '备注'], rows: [] };
    const res = applyTemplateToSheet(sheet, tpl);
    expect(res.matched).toBe(2);
    expect(res.skipped).toEqual(['不存在的列']);
    expect(res.mappings.map((m) => m.outputName)).toEqual(['date', 'debit']);
  });
});
