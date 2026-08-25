// src/main/preload.ts — 安全桥:渲染层只能经 window.onw 调 IPC。
// 新模型:前端经 CLI 桥执行(cli:command 发送 → cli:event/cli:stderr 逐行回推);旧 invoke/onProgress/onLog 临时保留(T9 移除)。
import { contextBridge, ipcRenderer } from 'electron';
import type { ApiCommand, ApiResult, IpcRequest } from '../ipc/contracts';

contextBridge.exposeInMainWorld('onw', {
  // ---- 新 API:CLI 桥 ----
  cli: (request: IpcRequest): void => ipcRenderer.send('cli:command', request),
  onCliEvent: (cb: (line: string) => void): (() => void) => {
    const listener = (_e: unknown, line: string): void => cb(line);
    ipcRenderer.on('cli:event', listener);
    return () => ipcRenderer.removeListener('cli:event', listener);
  },
  onCliError: (cb: (line: string) => void): (() => void) => {
    const listener = (_e: unknown, line: string): void => cb(line);
    ipcRenderer.on('cli:stderr', listener);
    return () => ipcRenderer.removeListener('cli:stderr', listener);
  },
  onWorkspaceChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('workspace:changed', listener);
    return () => ipcRenderer.removeListener('workspace:changed', listener);
  },
  openWorkspace: (path: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('cli:open', path) as Promise<{ ok: boolean }>,
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('onw:pick-workspace') as Promise<string | null>,

  // ---- 旧 API(临时保留,T9 移除) ----
  invoke: (command: ApiCommand): Promise<ApiResult<unknown>> =>
    ipcRenderer.invoke('onw:invoke', command) as Promise<ApiResult<unknown>>,
  onProgress: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on('onw:progress', listener);
    return () => ipcRenderer.removeListener('onw:progress', listener);
  },
  onLog: (cb: (entry: unknown) => void): (() => void) => {
    const listener = (_e: unknown, entry: unknown): void => cb(entry);
    ipcRenderer.on('onw:log', listener);
    return () => ipcRenderer.removeListener('onw:log', listener);
  },
});
