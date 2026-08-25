import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../../src/app/context';

describe('createContext', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ctx-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds an ApiContext bound to the workspace path', () => {
    const ctx = createContext(join(dir, 'ws'));
    expect(ctx.ws.onworkingDir).toContain('.onworking');
    expect(ctx.dbPath).toContain('master.db');
    const eng = ctx.getEngine();
    expect(eng.masterDb()).toBe(ctx.dbPath);
    eng.close();
  });
});
