// src/core/versioning/workspace-vcs.ts
// 工作区版本追踪助手:确保 git 仓库 + .gitignore(忽略 db/ 二进制),提交配置文本变更。
// 设计意图:工作区 `.onworking/` 的配置(settings/bigtables/pipelines/templates/state)
// 纳入版本追踪,git diff 即变更审查界面;二进制 DB 不入库(可由源+配置重放重建)。
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import type { Workspace } from '../workspace/workspace';
import { gitInit, gitStatus, gitCommitAll } from './git';

const WORKSPACE_GITIGNORE = ['db/', 'node_modules/'].join('\n') + '\n';

export function ensureWorkspaceVcs(ws: Workspace): void {
  gitInit(ws);
  const gi = join(ws.root, '.gitignore');
  if (!existsSync(gi)) {
    writeFileSync(gi, WORKSPACE_GITIGNORE, 'utf-8');
  }
}

/** 提交工作区配置变更;无变更返回 false。 */
export function commitWorkspaceChanges(ws: Workspace, message: string): boolean {
  ensureWorkspaceVcs(ws);
  const st = gitStatus(ws);
  if (st.staged.length === 0 && st.unstaged.length === 0 && st.untracked.length === 0) {
    return false;
  }
  gitCommitAll(ws, message);
  return true;
}
