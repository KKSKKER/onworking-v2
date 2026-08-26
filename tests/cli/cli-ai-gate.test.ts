import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliState, type CliWriter } from '../../src/cli/index';
import { AUTH_SECRET_ENV } from '../../src/ipc/ai-gate';

function memWriter(): { writer: CliWriter; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { writer: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) }, stdout, stderr };
}

describe('cli AI 门禁(无章=AI,有章=人类)', () => {
  let dir: string;
  const oldEnv = process.env[AUTH_SECRET_ENV];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-gate-'));
    process.env[AUTH_SECRET_ENV] = 'test-secret';
  });
  afterEach(() => {
    if (oldEnv === undefined) delete process.env[AUTH_SECRET_ENV];
    else process.env[AUTH_SECRET_ENV] = oldEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认 external 模式:无章真实数据命令被拒(AI_MODE_RESTRICTED)', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    state.open(dir);
    await state.handleRequest({ cmd: 'query.run', sql: 'SELECT 1', reqId: 1 });
    const line = JSON.parse(stdout[stdout.length - 1]);
    expect(line.result.ok).toBe(false);
    expect(line.result.error.code).toBe('AI_MODE_RESTRICTED');
  });

  it('无章但命令在 external 允许集(如 state.summary)→ 放行', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    state.open(dir);
    await state.handleRequest({ cmd: 'state.summary', reqId: 2 });
    const line = JSON.parse(stdout[stdout.length - 1]);
    expect(line.result.ok).toBe(true);
  });

  it('有章(trusted=true)→ 受限命令也放行', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    state.open(dir);
    await state.handleRequest({ cmd: 'query.run', sql: 'SELECT 1', reqId: 3 }, true);
    const line = JSON.parse(stdout[stdout.length - 1]);
    expect(line.result.ok).toBe(true);
  });

  it('无章 settings.setAiMode → 拒绝(仅界面可设置)', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    state.open(dir);
    await state.handleRequest({ cmd: 'settings.setAiMode', mode: 'local', reqId: 4 });
    const line = JSON.parse(stdout[stdout.length - 1]);
    expect(line.result.ok).toBe(false);
    expect(line.result.error.message).toContain('仅界面可设置');
  });

  it('有章 settings.setAiMode → 放行', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    state.open(dir);
    await state.handleRequest({ cmd: 'settings.setAiMode', mode: 'local', reqId: 5 }, true);
    const line = JSON.parse(stdout[stdout.length - 1]);
    expect(line.result.ok).toBe(true);
  });

  it('workspace.open 无论是否有章都放行(引导命令)', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    await state.handleRequest({ cmd: 'workspace.open', path: dir, reqId: 6 });
    expect(JSON.parse(stdout[0]).result.ok).toBe(true);
  });
});
