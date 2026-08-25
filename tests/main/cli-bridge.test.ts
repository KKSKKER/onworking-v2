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
    const bridge = createCliBridge({ command: 'npm', args: ['run', '--silent', 'onw', '--', 'open'] });
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
});
