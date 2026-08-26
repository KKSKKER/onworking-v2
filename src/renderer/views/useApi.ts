// src/renderer/views/useApi.ts
// 轻量 hook:经 CLI(sendCli)取数据,带 reload;订阅 workspace:changed 自动刷新(同步 AI 执行)。
import { useCallback, useEffect, useState } from 'react';
import type { ApiCommand } from '../../ipc/contracts';
import { sendCli } from '../cli';
import { subscribeRefresh } from '../refresh';

export function useApi<T>(command: ApiCommand, enabled = true): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    sendCli(command)
      .then((res) => {
        if (!alive) return;
        if (res.ok) {
          setData(res.data as T);
          setError(null);
        } else {
          setError(res.error.message);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick, enabled, JSON.stringify(command)]);

  // 刷新源:① 全局刷新总线(UI 写命令完成 / 打开工作区,时机准确) ② workspace:changed(外部/AI 改文件)
  useEffect(() => {
    if (!enabled) return;
    const unsubBus = subscribeRefresh(() => setTick((t) => t + 1));
    const unsubWs = window.onw.onWorkspaceChanged(() => setTick((t) => t + 1));
    return () => { unsubBus(); unsubWs(); };
  }, [enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
