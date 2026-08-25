import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installMockOnw } from './mock/onw-mock';
import { initCliClient } from './cli';

// 浏览器开发用 mock(真实 Electron 由 preload 提供 window.onw,mock 自动跳过)
installMockOnw();
// 接入 CLI 输出流 + reqId 对账
initCliClient();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
