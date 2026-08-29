#!/usr/bin/env node
// src/cli/index.ts
// CLI 前端:同一个 dispatch 的 stdio 版本。NDJSON 命令循环。
//   onw open <path>              → 建 ctx(等同 Electron main 持有 ctx)
//   之后 stdin 每行一条 IpcRequest JSON → stdout 一行 IpcResponse JSON;stderr 出错误。
//   例: echo '{"cmd":"bigtable.list"}' | onw open /path/to/ws
import { createInterface } from 'node:readline';
import { createContext } from '../app/context';
import { dispatchIpc, type ApiContext } from '../ipc/handlers';
import type { IpcRequest } from '../ipc/contracts';
import { handleMcpRequest, type McpRequest, type McpSession } from '../mcp/server';
import { loadSettings } from '../core/workspace/settings';
import { isAiAllowed, buildAiRestrictedError, parseRequestLine } from '../ipc/ai-gate';
import { useConsoleLogging } from '../core/logging';

export interface CliWriter {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliState {
  open(path: string): ApiContext;
  handleRequest(req: IpcRequest, trusted?: boolean): Promise<void>;
  close(): void;
}

export function createCliState(writer: CliWriter): CliState {
  let ctx: ApiContext | null = null;
  return {
    open(path: string): ApiContext {
      ctx = createContext(path);
      ctx.emitProgress = (payload) => writer.stderr(JSON.stringify({ event: 'progress', payload }));
      return ctx;
    },
    async handleRequest(req: IpcRequest, trusted = false): Promise<void> {
      if (req.cmd === 'workspace.open') {
        this.open(req.path);
        writer.stdout(JSON.stringify({ reqId: req.reqId, result: { ok: true, data: ctx!.ws } }));
        return;
      }
      if (!ctx) {
        writer.stdout(
          JSON.stringify({
            reqId: req.reqId,
            result: { ok: false, error: { code: 'NO_WORKSPACE', message: 'no workspace opened; use: onw open <path>' } },
          }),
        );
        return;
      }
      // AI 开放模式门禁:无章(非人类)命令按 aiOpenMode 过滤;带合法章的主进程转发不受限。
      if (!trusted) {
        const mode = loadSettings(ctx.ws).aiOpenMode;
        if (!isAiAllowed(mode, req.cmd)) {
          writer.stdout(
            JSON.stringify({ reqId: req.reqId, result: { ok: false, error: buildAiRestrictedError(mode, req.cmd) } }),
          );
          return;
        }
      }
      const res = await dispatchIpc(req, ctx);
      writer.stdout(JSON.stringify(res));
    },
    close(): void {},
  };
}

// 空闲退出阈值(ms):部分 harness 用管道喂完一批 NDJSON 后不关闭 stdin,
// readline 读不到 EOF → 命令循环永不结束 → 进程挂起,harness 超时强杀报
// "pipes did not close after process exit"。命令批之间空闲超过该值即主动终止读取。
const IDLE_EXIT_MS = 500;

export async function main(
  argv: string[],
  stdin: AsyncIterable<string>,
  writer: CliWriter,
  options?: { idleExitMs?: number },
): Promise<number> {
  if (argv[0] === 'mcp') {
    // 不写死工作区:onw mcp 可无路径启动,agent 用 workspace.open 打开/切换
    let ctx: ApiContext | null = argv[1] ? createContext(argv[1]) : null;
    const session: McpSession = {
      open: (path) => (ctx = createContext(path)),
      getCtx: () => ctx,
    };
    for await (const line of stdin) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let req: McpRequest;
      try {
        req = JSON.parse(trimmed) as McpRequest;
      } catch {
        writer.stderr(JSON.stringify({ error: 'invalid JSON', line: trimmed.slice(0, 200) }));
        continue;
      }
      const res = await handleMcpRequest(session, req);
      if (res) writer.stdout(JSON.stringify(res));
    }
    return 0;
  }
  const state = createCliState(writer);
  const openIdx = argv.indexOf('open');
  if (openIdx >= 0 && argv[openIdx + 1]) state.open(argv[openIdx + 1]);

  // 空闲退出:stdin 不关闭(harness 常见)时,不能干等 EOF;命令批之间空闲
  // idleExitMs 即终止读取,走与 EOF 相同的正常退出路径。mcp 分支不受影响(长连接)。
  const idleExitMs = options?.idleExitMs ?? 0;
  const iterator = stdin[Symbol.asyncIterator]();
  let idleTimer: NodeJS.Timeout | null = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    state.close();
  };

  while (!finished) {
    let entry: IteratorResult<string>;
    if (idleExitMs > 0) {
      const idleP = new Promise<'idle'>((resolve) => {
        idleTimer = setTimeout(() => resolve('idle'), idleExitMs);
      });
      const lineP = iterator.next().then((e) => ({ kind: 'line' as const, e }));
      const winner = await Promise.race([lineP, idleP]);
      if (winner === 'idle') {
        void iterator.return?.(); // 终止仍挂起的 next(),释放 stdin(同 EOF)
        break;
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      entry = winner.e;
    } else {
      entry = await iterator.next();
    }
    if (entry.done) break;
    const trimmed = (entry.value ?? '').trim();
    if (!trimmed) continue;
    let req: IpcRequest;
    let trusted = false;
    try {
      ({ req, trusted } = parseRequestLine(trimmed));
    } catch {
      writer.stderr(JSON.stringify({ error: 'invalid JSON', line: trimmed.slice(0, 200) }));
      continue;
    }
    await state.handleRequest(req, trusted);
  }
  finish();
  return 0;
}

// 入口守卫:被直接执行(tsc CommonJS 输出 / tsx)时才启动 stdio 循环;
// vitest import 本模块时 require 未定义或 require.main 非本模块,不触发。
if (typeof require !== 'undefined' && require.main === module) {
  useConsoleLogging('warn');
  const writer: CliWriter = {
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
  };
  main(
    process.argv.slice(2),
    createInterface({ input: process.stdin, crlfDelay: Infinity }),
    writer,
    // 管道输入才启用空闲退出;TTY 交互输入保持"等 EOF"(避免手动输入时被掐断);
    // 长驻调用方(如 cli-bridge)显式置 ONW_CLI_NO_IDLE_EXIT=1 关闭。
    { idleExitMs: process.stdin.isTTY || process.env.ONW_CLI_NO_IDLE_EXIT === '1' ? 0 : IDLE_EXIT_MS },
  )
    .then((code) => { exitAfterFlush(code); })
    .catch((err: unknown) => {
      process.stderr.write(String(err) + '\n');
      exitAfterFlush(1);
    });
}

// 批处理 CLI 必须显式退出:stdin 管道被 harness 保持打开时,进程.stdin 句柄会把事件循环
// 一直挂住(只设 process.exitCode 不够,进程永远不退出 → harness 超时强杀报 "pipes did not close")。
// 先 flush 再退出,避免最后一批 NDJSON 响应还留在缓冲区里被 process.exit() 截断。
function exitAfterFlush(code: number): void {
  const exit = () => process.exit(code);
  const pending: Promise<void>[] = [];
  if (!process.stdout.writableEnded) pending.push(new Promise<void>((resolve) => { process.stdout.end(() => resolve()); }));
  if (!process.stderr.writableEnded) pending.push(new Promise<void>((resolve) => { process.stderr.end(() => resolve()); }));
  if (pending.length === 0) exit();
  else Promise.all(pending).then(exit, exit);
}
