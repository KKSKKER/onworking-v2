// src/renderer/cli.ts
// 前端 CLI 客户端:sendCli 按 reqId 对账返回 Promise;全局输出流供输出面板订阅。
import type { ApiCommand, ApiResult, IpcRequest } from '../ipc/contracts';
import { triggerRefresh } from './refresh';

type Resolve = (r: ApiResult<unknown>) => void;
const pending = new Map<number, Resolve>();
const outputSubs = new Set<(line: string) => void>();
let seq = 1;

/** 写命令集合:完成后数据已落盘,统一触发全局刷新(时机准确,不等 fs.watch)。 */
const MUTATING_COMMANDS = new Set<string>([
  'bigtable.save', 'bigtable.addFiles', 'bigtable.delete', 'bigtable.deleteSourceFile',
  'mapping.save', 'template.save', 'settings.setAiMode',
  'pipeline.save', 'pipeline.run', 'pipeline.delete',
  'pipeline.mergeBigTable', 'pipeline.mergeAll',
  'pipeline.buildMasterBigTable', 'pipeline.buildMasterAll',
  'pipeline.recomputeAll', 'pipeline.recomputeByDependency',
]);

/** 解析一行 CLI stdout:若是 { reqId, result } 结果信封,resolve 对应 pending。 */
export function handleCliLine(line: string, pendingMap: Map<number, Resolve>): void {
  let msg: { reqId?: number; result?: ApiResult<unknown> };
  try {
    msg = JSON.parse(line) as { reqId?: number; result?: ApiResult<unknown> };
  } catch {
    return;
  }
  if (msg && typeof msg.reqId === 'number' && msg.result && pendingMap.has(msg.reqId)) {
    const resolve = pendingMap.get(msg.reqId)!;
    pendingMap.delete(msg.reqId);
    resolve(msg.result);
  }
}

/** 输出流订阅:输出面板用它实时渲染。 */
export function subscribeOutput(cb: (line: string) => void): () => void {
  outputSubs.add(cb);
  return () => { outputSubs.delete(cb); };
}

function pushOutput(line: string): void {
  for (const cb of outputSubs) cb(line);
}

/** 发一条命令:分配 reqId,经 window.onw.cli 送进 CLI,结果行回推时按 reqId resolve。
 *  写命令成功后触发全局刷新(数据已就绪,时机准确)。 */
export function sendCli(command: ApiCommand): Promise<ApiResult<unknown>> {
  const reqId = seq++;
  const request: IpcRequest = { ...command, reqId };
  return new Promise<ApiResult<unknown>>((resolve) => {
    pending.set(reqId, resolve);
    window.onw.cli(request);
  }).then((res) => {
    if (res.ok && MUTATING_COMMANDS.has(command.cmd)) triggerRefresh();
    return res;
  });
}

/** 应用启动时调用:把主进程回推的 CLI 输出接入 pending 对账 + 输出流。 */
export function initCliClient(): void {
  window.onw.onCliEvent((line) => {
    pushOutput(line);
    handleCliLine(line, pending);
  });
  window.onw.onCliError((line) => pushOutput(line));
}
