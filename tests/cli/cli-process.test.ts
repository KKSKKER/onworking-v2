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

  it('exits on its own after idle when stdin is left open (harness never EOFs)', async () => {
    // 复现用户场景:harness 喂完命令后不关闭 stdin,进程必须自行退出(exit 0)并交出全部响应。
    const child: ChildProcess = spawn(
      'npm',
      ['run', '--silent', 'onw', '--', 'open', dir],
      { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stdin!.write('{"reqId":5,"cmd":"state.summary"}\n');
    // 故意不 end() stdin —— 模拟 harness 保持 stdin 打开。
    let timer: ReturnType<typeof setTimeout> | null = null;
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => { if (timer) clearTimeout(timer); resolve(code); });
      timer = setTimeout(() => { child.kill(); resolve(child.exitCode ?? -99); }, 8000);
    });
    child.stdin!.destroy();
    expect(exitCode).toBe(0);
    const parsed = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed.some((l) => l.reqId === 5 && l.result && l.result.ok === true)).toBe(true);
  });
});
