// src/renderer/refresh.ts
// 全局刷新总线:任何「工作区数据变了」的时刻 triggerRefresh(),useApi 订阅后统一重载。
// 解决零散 reload() 时机不可靠、打开工作区不刷新、fs.watch 过早/漏刷的问题。
type RefreshListener = () => void;
const listeners = new Set<RefreshListener>();

export function subscribeRefresh(fn: RefreshListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function triggerRefresh(): void {
  for (const fn of [...listeners]) fn();
}
