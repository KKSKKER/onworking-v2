import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../src/core/workspace/workspace';
import {
  gitInit,
  gitStatus,
  gitCommitAll,
  gitCurrentCommit,
} from '../../src/core/versioning/git';

describe('versioning', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ver-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('init → status → commit → current commit non-null', () => {
    const ws = initWorkspace(dir);
    gitInit(ws);
    writeFileSync(join(ws.onworkingDir, 'settings.json'), '{"name":"demo"}');
    const s = gitStatus(ws);
    expect(s.untracked.length).toBeGreaterThan(0);
    gitCommitAll(ws, 'init');
    expect(gitCurrentCommit(ws)).toBeTruthy();
  });

  it('gitStatus is empty before any change after a commit', () => {
    const ws = initWorkspace(dir);
    gitInit(ws);
    writeFileSync(join(ws.onworkingDir, 'settings.json'), '{"name":"demo"}');
    gitCommitAll(ws, 'init');
    const s = gitStatus(ws);
    expect(s.untracked.length).toBe(0);
    expect(s.staged.length).toBe(0);
    expect(s.unstaged.length).toBe(0);
  });
});
