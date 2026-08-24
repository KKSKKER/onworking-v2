// src/main/preload.ts — 安全桥:渲染层只能经 window.onw 调 IPC。
import { contextBridge, ipcRenderer } from 'electron';
import type { ApiCommand, ApiResult } from '../ipc/contracts';

contextBridge.exposeInMainWorld('onw', {
  invoke: (command: ApiCommand): Promise<ApiResult<unknown>> =>
    ipcRenderer.invoke('onw:invoke', command) as Promise<ApiResult<unknown>>,
  onProgress: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on('onw:progress', listener);
    return () => ipcRenderer.removeListener('onw:progress', listener);
  },
});
