// src/main/preload.ts — 安全桥:渲染层只能经 window.onw 调 IPC。
// 前端经 CLI 桥执行:cli:command 发送 → cli:event/cli:stderr 逐行回推;fs.watch 同步工作区变化。
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRequest } from '../ipc/contracts';

contextBridge.exposeInMainWorld('onw', {
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
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('onw:pick-files') as Promise<string[]>,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('onw:pick-directory') as Promise<string | null>,
});
