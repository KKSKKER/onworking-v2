import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBigTableConfig, type BigTableConfig } from '../../src/core/bigtable/schema';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import {
  listBigTables,
  loadBigTableConfig,
  saveBigTableConfig,
} from '../../src/core/bigtable/store';

describe('bigtable schema', () => {
  it('rejects empty table name', () => {
    const cfg: BigTableConfig = { tableName: '', fields: [], autoIncrement: false };
    expect(validateBigTableConfig(cfg)).toContain('tableName');
  });

  it('rejects zero fields', () => {
    const cfg: BigTableConfig = { tableName: 't', fields: [], autoIncrement: false };
    expect(validateBigTableConfig(cfg)).toContain('fields');
  });

  it('valid config passes', () => {
    const cfg: BigTableConfig = {
      tableName: 't',
      autoIncrement: true,
      fields: [{ name: 'date', type: 'date', order: 1 }],
    };
    expect(validateBigTableConfig(cfg)).toEqual([]);
  });
});

describe('bigtable store', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bt-'));
    ws = initWorkspace(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves and reloads a bigtable config; lists folders', () => {
    const cfg: BigTableConfig = {
      tableName: 'seq',
      autoIncrement: true,
      fields: [
        { name: 'date', type: 'date', order: 1, primaryKey: true },
        { name: 'debit', type: 'cents', order: 2 },
      ],
    };
    saveBigTableConfig(ws, 'seq', cfg);
    expect(listBigTables(ws)).toContain('seq');
    expect(loadBigTableConfig(ws, 'seq')).toEqual(cfg);
  });
});
