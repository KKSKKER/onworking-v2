import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isWorkspace,
  initWorkspace,
  openWorkspace,
  type Workspace,
} from '../../src/core/workspace/workspace';
import { loadSettings, saveSettings } from '../../src/core/workspace/settings';

describe('workspace', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onw-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('isWorkspace is false before init', () => {
    expect(isWorkspace(dir)).toBe(false);
  });

  it('initWorkspace creates .onworking structure', () => {
    const ws = initWorkspace(dir);
    expect(existsSync(ws.onworkingDir)).toBe(true);
    expect(existsSync(join(ws.onworkingDir, 'db'))).toBe(true);
    expect(existsSync(join(ws.onworkingDir, 'bigtables'))).toBe(true);
    expect(isWorkspace(dir)).toBe(true);
  });

  it('openWorkspace re-opens existing workspace without duplicating', () => {
    initWorkspace(dir);
    const ws: Workspace = openWorkspace(dir);
    expect(ws.root).toBe(dir);
  });

  it('settings round-trip with default aiOpenMode=external(取消关闭状态)', () => {
    const ws = initWorkspace(dir);
    const s = loadSettings(ws);
    expect(s.aiOpenMode).toBe('external');
    s.name = 'demo';
    saveSettings(ws, s);
    expect(loadSettings(ws).name).toBe('demo');
  });

  it('loadSettings 把残留的 off 归一化回 external', () => {
    const ws = initWorkspace(dir);
    saveSettings(ws, { name: 'demo', aiOpenMode: 'off' } as never);
    expect(loadSettings(ws).aiOpenMode).toBe('external');
  });
});
