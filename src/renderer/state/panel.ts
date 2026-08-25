// src/renderer/state/panel.ts
// 动态面板打开器:管线管理视图执行查询管线后,打开一个「查询结果」Tab(名称 = 结果表名)。
// App.tsx 在 dockview ready 时注入真正的 opener。
export interface QueryResultPanel {
  tableName: string;
  sql: string;
}

let openQueryResultFn: ((r: QueryResultPanel) => void) | null = null;

export function setOpenQueryResult(fn: (r: QueryResultPanel) => void): void {
  openQueryResultFn = fn;
}

export function openQueryResult(r: QueryResultPanel): void {
  openQueryResultFn?.(r);
}
