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
import { useConsoleLogging } from '../core/logging';

export interface CliWriter {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliState {
  open(path: string): ApiContext;
  handleRequest(req: IpcRequest): Promise<void>;
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
    async handleRequest(req: IpcRequest): Promise<void> {
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
      const res = await dispatchIpc(req, ctx);
      writer.stdout(JSON.stringify(res));
    },
    close(): void {},
  };
}

export async function main(
  argv: string[],
  stdin: AsyncIterable<string>,
  writer: CliWriter,
): Promise<number> {
  const state = createCliState(writer);
  const openIdx = argv.indexOf('open');
  if (openIdx >= 0 && argv[openIdx + 1]) state.open(argv[openIdx + 1]);
  for await (const line of stdin) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: IpcRequest;
    try {
      req = JSON.parse(trimmed) as IpcRequest;
    } catch {
      writer.stderr(JSON.stringify({ error: 'invalid JSON', line: trimmed.slice(0, 200) }));
      continue;
    }
    await state.handleRequest(req);
  }
  state.close();
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
  main(process.argv.slice(2), createInterface({ input: process.stdin, crlfDelay: Infinity }), writer)
    .then((code) => { process.exitCode = code; })
    .catch((err: unknown) => { process.stderr.write(String(err) + '\n'); process.exitCode = 1; });
}
