// src/main/cli-bridge.ts
// CLI 子进程桥:main 不再直接 dispatch,而是 spawn onw CLI 子进程(NDJSON),
// 转发 IpcRequest 到 stdin,把 stdout/stderr 逐行回调给上层。
import { spawn, type ChildProcess } from 'node:child_process';
import type { IpcRequest } from '../ipc/contracts';

export interface CliBridgeOptions {
  /** 要 spawn 的命令,如 'node';args 前段,如 ['dist/main/cli/index.js','open'];open 时追加工作区路径。 */
  command: string;
  args: string[];
  /** 是否经 shell 启动。spawn 真实 exe(如 node)必须 false,否则路径带空格(Program Files)会被拆坏;测试 spawn npm 才用 true。 */
  shell?: boolean;
}

export interface CliBridge {
  open(wsPath: string): void;
  /** 写一行 JSON 到 CLI stdin;无进程返回 false。 */
  send(request: IpcRequest): boolean;
  onLine(cb: (line: string) => void): void;
  onError(cb: (line: string) => void): void;
  close(): void;
}

/** 把累计 buffer 按行切开,返回完整行 + 剩余残段。 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const idx = buffer.lastIndexOf('\n');
  if (idx === -1) return { lines: [], rest: buffer };
  const rest = buffer.slice(idx + 1);
  const full = buffer.slice(0, idx);
  const lines = full === '' ? [] : full.split('\n');
  return { lines, rest };
}

export function createCliBridge(opts: CliBridgeOptions): CliBridge {
  let child: ChildProcess | null = null;
  let stdoutBuf = '';
  let stderrBuf = '';
  const lineCbs: ((line: string) => void)[] = [];
  const errCbs: ((line: string) => void)[] = [];

  function open(wsPath: string): void {
    if (child && !child.killed) child.kill();
    child = spawn(opts.command, [...opts.args, wsPath], {
      shell: opts.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdoutBuf = '';
    stderrBuf = '';
    child.stdout!.on('data', (d: Buffer) => {
      const { lines, rest } = splitLines(stdoutBuf + d.toString());
      stdoutBuf = rest;
      for (const l of lines) if (l.trim()) for (const cb of lineCbs) cb(l);
    });
    child.stderr!.on('data', (d: Buffer) => {
      const { lines, rest } = splitLines(stderrBuf + d.toString());
      stderrBuf = rest;
      for (const l of lines) if (l.trim()) for (const cb of errCbs) cb(l);
    });
    child.on('exit', (code) => {
      for (const cb of errCbs) cb(`CLI 进程退出 code=${code}`);
      child = null;
    });
  }

  function send(request: IpcRequest): boolean {
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    child.stdin.write(JSON.stringify(request) + '\n');
    return true;
  }

  return {
    open,
    send,
    onLine: (cb) => { lineCbs.push(cb); },
    onError: (cb) => { errCbs.push(cb); },
    close: () => { if (child && !child.killed) child.kill(); child = null; },
  };
}
