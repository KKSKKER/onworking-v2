import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveRule, loadRules, listRules } from '../../src/core/rule/store';
import { compileRule } from '../../src/core/rule/compile';
import type { RuleYaml } from '../../src/core/rule/rule';

const sampleRule = (): RuleYaml => ({
  name: 'seq_rule',
  version: 1,
  sources: [{ pattern: '**/*', sheetName: 'Sheet1', headerRow: 1 }],
  fields: [
    { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
    { sourceHeader: '借方金额', outputName: 'debit', included: true, order: 2, transforms: [{ kind: 'coerce_cents' }] },
    { sourceHeader: '备注', outputName: 'note', included: false, order: 3 },
  ],
});

describe('rule yaml', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rule-'));
    ws = initWorkspace(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves and reloads a rule as YAML', () => {
    const file = saveRule(ws, 'seq', sampleRule());
    expect(file.endsWith('.yaml')).toBe(true);
    expect(listRules(ws, 'seq')).toContain(file);
    const loaded = loadRules(ws, 'seq');
    expect(loaded.length).toBe(1);
    expect(loaded[0].fields[0].sourceHeader).toBe('日期');
  });

  it('compiles rule fields to mappings (only included, with transform kinds)', () => {
    const compiled = compileRule(sampleRule());
    expect(compiled.sources[0].headerRow).toBe(1);
    expect(compiled.mappings.map((m) => m.outputName)).toEqual(['date', 'debit']);
    expect(compiled.mappings[0].transform).toBe('normalize-date');
    expect(compiled.mappings[1].transform).toBe('to-cents');
  });
});
