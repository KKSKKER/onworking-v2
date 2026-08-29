import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliState, main, type CliWriter } from '../../src/cli/index';

function memWriter(): { writer: CliWriter; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { writer: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) }, stdout, stderr };
}

describe('cli', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cli-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a workspace and dispatches commands, echoing reqId', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    state.open(dir);
    await state.handleRequest({ cmd: 'state.summary', reqId: 7 });
    const line = JSON.parse(stdout[stdout.length - 1]);
    expect(line.reqId).toBe(7);
    expect(line.result.ok).toBe(true);
  });

  it('reports NO_WORKSPACE before any open', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    await state.handleRequest({ cmd: 'bigtable.list', reqId: 1 });
    const line = JSON.parse(stdout[0]);
    expect(line.result.ok).toBe(false);
    expect(line.result.error.code).toBe('NO_WORKSPACE');
  });

  it('treats a piped workspace.open line as the bootstrap', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    await state.handleRequest({ cmd: 'workspace.open', path: dir, reqId: 2 });
    expect(JSON.parse(stdout[0]).result.ok).toBe(true);
    await state.handleRequest({ cmd: 'state.summary', reqId: 3 });
    expect(JSON.parse(stdout[1]).result.ok).toBe(true);
  });

  it('main() reads lines from an async iterable and writes NDJSON responses', async () => {
    const { writer, stdout } = memWriter();
    async function* lines() {
      yield '{"reqId":1,"cmd":"state.summary"}';
    }
    const code = await main(['open', dir], lines(), writer);
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes('"reqId":1'))).toBe(true);
  });

  it('force-exits after idleExitMs when stdin never EOFs (harness keeps stdin open)', async () => {
    const { writer, stdout } = memWriter();
    let returned = 0;
    let i = 0;
    const lines = [
      JSON.stringify({ cmd: 'workspace.open', path: dir, reqId: 1 }),
      JSON.stringify({ cmd: 'state.summary', reqId: 2 }),
    ];
    // 模拟 harness:发完一批命令后不关闭 stdin —— next() 在耗尽行后永远 pending。
    const stdin: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            i < lines.length
              ? Promise.resolve({ done: false, value: lines[i++] })
              : new Promise(() => { /* 永不结束 */ }),
          return: async () => {
            returned++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const started = Date.now();
    const code = await main(['open', dir], stdin, writer, { idleExitMs: 60 });
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(returned).toBe(1); // 空闲退出主动终止了迭代器,而不是等 EOF
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    expect(stdout.some((l) => l.includes('"reqId":2'))).toBe(true);
  });
});
