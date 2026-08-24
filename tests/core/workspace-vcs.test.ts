import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { ensureWorkspaceVcs, commitWorkspaceChanges } from '../../src/core/versioning/workspace-vcs';
import { gitCurrentCommit } from '../../src/core/versioning/git';

describe('workspace vcs', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcs-'));
    ws = initWorkspace(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('commits config changes but ignores the db directory', () => {
    ensureWorkspaceVcs(ws);
    writeFileSync(join(ws.onworkingDir, 'settings.json'), '{"name":"demo"}');
    writeFileSync(join(ws.onworkingDir, 'db', 'onworking.db'), 'binary'); // 应被忽略
    const committed = commitWorkspaceChanges(ws, 'test');
    expect(committed).toBe(true);
    expect(gitCurrentCommit(ws)).toBeTruthy();
    const tracked = execFileSync('git', ['ls-files'], { cwd: ws.root, encoding: 'utf-8' });
    expect(tracked).toContain('.onworking/settings.json');
    expect(tracked).not.toContain('onworking.db'); // db/ 被 gitignore
  });

  it('returns false when nothing changed', () => {
    ensureWorkspaceVcs(ws);
    commitWorkspaceChanges(ws, 'first');
    expect(commitWorkspaceChanges(ws, 'second')).toBe(false);
  });
});
