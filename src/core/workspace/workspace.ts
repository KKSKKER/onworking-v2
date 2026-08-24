// src/core/workspace/workspace.ts
// 工作区生命周期:检测 / 初始化 / 打开。`.onworking/` 为工作区元数据目录。
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export interface Workspace {
  root: string;
  onworkingDir: string;
}

export function isWorkspace(root: string): boolean {
  return existsSync(join(root, '.onworking'));
}

export function initWorkspace(root: string): Workspace {
  const onworkingDir = join(root, '.onworking');
  for (const sub of ['db', 'bigtables', 'pipelines']) {
    mkdirSync(join(onworkingDir, sub), { recursive: true });
  }
  return { root, onworkingDir };
}

export function openWorkspace(root: string): Workspace {
  return isWorkspace(root)
    ? { root, onworkingDir: join(root, '.onworking') }
    : initWorkspace(root);
}
