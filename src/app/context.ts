// src/app/context.ts
// 构造 ApiContext:打开工作区 + 惰性引擎(单例缓存)。零 Electron 依赖,CLI 与 Electron 共用。
import { openWorkspace, masterDbPath } from '../core/workspace/workspace';
import { PipelineEngine } from '../core/pipeline/engine';
import type { ApiContext } from '../ipc/handlers';

export function createContext(workspacePath: string): ApiContext {
  const ws = openWorkspace(workspacePath);
  const dbPath = masterDbPath(ws);
  let engine: PipelineEngine | null = null;
  return {
    ws,
    dbPath,
    getEngine: () => (engine ??= new PipelineEngine(ws)),
  };
}
