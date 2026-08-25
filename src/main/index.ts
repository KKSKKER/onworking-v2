// src/main/index.ts — Electron 主进程
// 窗口 + IPC 路由(一切操作都是 API:渲染层经 window.onw 调这里 → handlers → 核心)。
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join } from 'node:path';
import { dispatch, type ApiContext } from '../ipc/handlers';
import { createContext } from '../app/context';
import { useConsoleLogging, logger } from '../core/logging';

useConsoleLogging('info');

let ctx: ApiContext | null = null;

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
  if (command?.cmd === 'workspace.pick') {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) {
      return { ok: false, error: { code: 'CANCELLED', message: 'cancelled' } };
    }
    return open(res.filePaths[0]);
  }
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
