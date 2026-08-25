import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('cli process smoke', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'clip-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips an NDJSON command over real stdio', async () => {
    const child: ChildProcess = spawn(
      'npm',
      ['run', '--silent', 'onw', '--', 'open', dir],
      { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdin!.write('{"reqId":3,"cmd":"state.summary"}\n');
    child.stdin!.end();
    const stdout = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      child.stdout!.on('end', () => resolve(out));
      child.on('error', reject);
    });
    const parsed = stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(parsed.some((l) => l.reqId === 3 && l.result && l.result.ok === true)).toBe(true);
  });
});
