// src/core/workspace/settings.ts
// 工作区设置,存 `.onworking/settings.json`。`aiOpenMode` 为 AI 开放模式(AI 权限管理)。
import { join, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Workspace } from './workspace';

export type AiOpenMode = 'external' | 'local';

export interface WorkspaceSettings {
  name: string;
  aiOpenMode: AiOpenMode;
  [k: string]: unknown;
}

function defaultSettings(root: string): WorkspaceSettings {
  return { name: basename(root), aiOpenMode: 'external' };
}

const VALID_MODES: ReadonlySet<string> = new Set<AiOpenMode>(['external', 'local']);

export function loadSettings(ws: Workspace): WorkspaceSettings {
  const p = join(ws.onworkingDir, 'settings.json');
  if (!existsSync(p)) return defaultSettings(ws.root);
  try {
    const stored = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
    // 取消「关闭」状态后,残留的 'off' 归一化回 external
    if (stored.aiOpenMode !== undefined && !VALID_MODES.has(stored.aiOpenMode as string)) {
      stored.aiOpenMode = 'external';
    }
    return { ...defaultSettings(ws.root), ...stored } as WorkspaceSettings;
  } catch {
    return defaultSettings(ws.root); // 损坏则回退默认
  }
}

export function saveSettings(ws: Workspace, s: WorkspaceSettings): void {
  writeFileSync(join(ws.onworkingDir, 'settings.json'), JSON.stringify(s, null, 2), 'utf-8');
}
