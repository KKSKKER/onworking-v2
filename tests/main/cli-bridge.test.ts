import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitLines, createCliBridge } from '../../src/main/cli-bridge';

describe('cli-bridge', () => {
  it('splitLines splits accumulated buffer into lines + rest', () => {
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], rest: '' });
    expect(splitLines('a\nb')).toEqual({ lines: ['a'], rest: 'b' });
    expect(splitLines('abc')).toEqual({ lines: [], rest: 'abc' });
  });

  it('spawns the CLI, forwards requests, and delivers response lines', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'bridge-'));
    const bridge = createCliBridge({ command: 'npm', args: ['run', '--silent', 'onw', '--', 'open'], shell: process.platform === 'win32' });
    const got: string[] = [];
    bridge.onLine((l) => got.push(l));
    bridge.open(ws);
    await new Promise((r) => setTimeout(r, 1500)); // 等 CLI 起
    bridge.send({ cmd: 'state.summary', reqId: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    bridge.close();
    rmSync(ws, { recursive: true, force: true });
    expect(got.some((l) => l.includes('"reqId":1') && l.includes('"ok":true'))).toBe(true);
  });

  it('with authSecret, forwards requests as trusted (human) past the AI gate', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'bridge-auth-'));
    const bridge = createCliBridge({
      command: 'npm',
      args: ['run', '--silent', 'onw', '--', 'open'],
      shell: process.platform === 'win32',
      env: { ONW_AUTH_SECRET: 'xyz' },
      authSecret: 'xyz',
    });
    const got: string[] = [];
    bridge.onLine((l) => got.push(l));
    bridge.open(ws);
    await new Promise((r) => setTimeout(r, 1500)); // 等 CLI 起
    bridge.send({ cmd: 'bigtable.list', reqId: 11 }); // 带章=人类,真实数据命令也放行
    await new Promise((r) => setTimeout(r, 1500));
    bridge.close();
    rmSync(ws, { recursive: true, force: true });
    const line = got.find((l) => l.includes('"reqId":11'));
    expect(line).toBeTruthy();
    expect(line!).toContain('"ok":true');
  });

  it('without authSecret, forwards requests as AI and restricted commands are blocked', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'bridge-ai-'));
    const bridge = createCliBridge({ command: 'npm', args: ['run', '--silent', 'onw', '--', 'open'], shell: process.platform === 'win32' });
    const got: string[] = [];
    bridge.onLine((l) => got.push(l));
    bridge.open(ws);
    await new Promise((r) => setTimeout(r, 1500)); // 等 CLI 起
    bridge.send({ cmd: 'query.run', sql: 'SELECT 1', reqId: 12 }); // 无章=AI,external 下真实数据命令受限
    await new Promise((r) => setTimeout(r, 1500));
    bridge.close();
    rmSync(ws, { recursive: true, force: true });
    const line = got.find((l) => l.includes('"reqId":12'));
    expect(line).toBeTruthy();
    expect(line!).toContain('AI_MODE_RESTRICTED');
  });
});
