// src/renderer/views/useApi.ts
// 轻量 hook:调 window.onw.invoke 取数据,带 reload。
import { useCallback, useEffect, useState } from 'react';
import type { ApiCommand } from '../../ipc/contracts';

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
    window.onw
      .invoke(command)
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

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
