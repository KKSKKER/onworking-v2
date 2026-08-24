// src/core/versioning/git.ts
// git 版本管理:工作区经 git 追踪 `.onworking/` 等文件版本变动。
// 纯 child_process 调用 git,无额外依赖。规则/管线/设置均为纯文本,git diff 即审查界面。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace';

export interface GitStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

function git(ws: Workspace, args: string[]): string {
  return execFileSync('git', args, { cwd: ws.root, encoding: 'utf-8' });
}

export function gitInit(ws: Workspace): void {
  if (!existsSync(join(ws.root, '.git'))) {
    git(ws, ['init', '-q']);
  }
}

export function gitStatus(ws: Workspace): GitStatus {
  const output = git(ws, ['status', '--porcelain']);
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === '??') untracked.push(file);
    else if (code.trim().length > 0) staged.push(file);
    else unstaged.push(file);
  }
  return { staged, unstaged, untracked };
}

export function gitCommitAll(ws: Workspace, message: string): void {
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-q', '-m', message]);
}

export function gitCurrentCommit(ws: Workspace): string | null {
  try {
    return git(ws, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null; // 尚无提交
  }
}
