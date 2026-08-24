// src/main/context.ts
// 构造 ApiContext:打开工作区 + 惰性引擎(单例缓存)。
import { join } from 'node:path';
import { openWorkspace } from '../core/workspace/workspace';
import { PipelineEngine } from '../core/pipeline/engine';
import type { ApiContext } from '../ipc/handlers';

export function createContext(workspacePath: string): ApiContext {
  const ws = openWorkspace(workspacePath);
  const dbPath = join(ws.onworkingDir, 'db', 'onworking.db');
  let engine: PipelineEngine | null = null;
  return {
    ws,
    dbPath,
    getEngine: () => (engine ??= new PipelineEngine(ws, dbPath)),
  };
}
