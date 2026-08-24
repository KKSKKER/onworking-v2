// src/core/workspace/settings.ts
// 工作区设置,存 `.onworking/settings.json`。`aiOpenMode` 为 AI 开放模式(AI 权限管理)。
import { join, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Workspace } from './workspace';

export type AiOpenMode = 'off' | 'external' | 'local';

export interface WorkspaceSettings {
  name: string;
  aiOpenMode: AiOpenMode;
  [k: string]: unknown;
}

function defaultSettings(root: string): WorkspaceSettings {
  return { name: basename(root), aiOpenMode: 'off' };
}

export function loadSettings(ws: Workspace): WorkspaceSettings {
  const p = join(ws.onworkingDir, 'settings.json');
  if (!existsSync(p)) return defaultSettings(ws.root);
  try {
    return { ...defaultSettings(ws.root), ...JSON.parse(readFileSync(p, 'utf-8')) };
  } catch {
    return defaultSettings(ws.root); // 损坏则回退默认
  }
}

export function saveSettings(ws: Workspace, s: WorkspaceSettings): void {
  writeFileSync(join(ws.onworkingDir, 'settings.json'), JSON.stringify(s, null, 2), 'utf-8');
}
