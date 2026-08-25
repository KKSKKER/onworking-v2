// src/main/index.ts — Electron 主进程
// 窗口 + IPC 路由。前端经 CLI 桥执行:main 持有 onw CLI 子进程,转发 IpcRequest 并逐行回推输出。
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join } from 'node:path';
import { watch } from 'node:fs';
import { dispatch, type ApiContext } from '../ipc/handlers';
import { createContext } from '../app/context';
import { useConsoleLogging, logger } from '../core/logging';
import { createCliBridge } from './cli-bridge';
import type { IpcRequest } from '../ipc/contracts';

useConsoleLogging('info');

let ctx: ApiContext | null = null;

// ---- CLI 桥:前端 → onw CLI 子进程(NDJSON),main 只转发 + 回推 ----
const bridge = createCliBridge({
  command: process.execPath,
  args: [join(app.getAppPath(), 'dist', 'main', 'cli', 'index.js'), 'open'],
});
let watchTimer: NodeJS.Timeout | null = null;

function watchWorkspace(wsPath: string): void {
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  try {
    watch(join(wsPath, '.onworking'), { recursive: true }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) win.webContents.send('workspace:changed');
      }, 300);
    });
  } catch { /* 目录不存在则忽略 */ }
}

function broadcastCliLine(channel: 'cli:event' | 'cli:stderr', line: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(channel, line);
}
bridge.onLine((line) => broadcastCliLine('cli:event', line));
bridge.onError((line) => broadcastCliLine('cli:stderr', line));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(join(__dirname, '../../renderer/index.html'));
  }

  // 核心日志转发到渲染层日志栏(onw:log 事件)
  logger.addSink((entry) => {
    if (!win.isDestroyed()) win.webContents.send('onw:log', entry);
  });
}

ipcMain.handle('onw:invoke', async (_event, command: { cmd: string; [k: string]: unknown }) => {
  const reqId = command && typeof command === 'object' && 'reqId' in command
    ? (command as { reqId?: number }).reqId
    : undefined;
  const open = (path: string) => {
    ctx = createContext(path);
    return { ok: true, data: ctx.ws };
  };
  if (command?.cmd === 'workspace.open') return open(String(command.path));
  if (!ctx) {
    return { ok: false, error: { code: 'NO_WORKSPACE', message: 'no workspace opened' } };
  }
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) {
    ctx.emitProgress = (payload) => win.webContents.send('onw:progress', payload);
  }
  const result = await dispatch(command as never, ctx);
  return reqId === undefined ? result : { reqId, result };
});

// 目录选择桥(UI 专属):渲染层先 pickWorkspace() 拿路径,再 openWorkspace。
ipcMain.handle('onw:pick-workspace', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});

// CLI 桥通道:前端命令经 CLI 子进程执行,结果经 cli:event/cli:stderr 逐行回推。
ipcMain.on('cli:command', (_event, request: IpcRequest) => {
  const ok = bridge.send(request);
  if (!ok) {
    broadcastCliLine('cli:event', JSON.stringify({
      reqId: request?.reqId,
      result: { ok: false, error: { code: 'NO_WORKSPACE', message: 'no workspace opened; open a workspace first' } },
    }));
  }
});
ipcMain.handle('cli:open', (_event, path: string) => {
  bridge.open(path);
  watchWorkspace(path);
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
