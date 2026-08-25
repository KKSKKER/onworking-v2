import { describe, it, expect, afterEach } from 'vitest';
import { handleCliLine, sendCli, initCliClient } from '../../src/renderer/cli';
import type { ApiResult } from '../../src/ipc/contracts';

interface FakeOnw {
  cli: (req: { cmd: string; reqId: number }) => void;
  onCliEvent: (cb: (line: string) => void) => () => void;
  onCliError: (cb: (line: string) => void) => () => void;
}

function stubWindow(): { cliEventCb: (line: string) => void; box: { sent: { cmd: string; reqId: number } | null } } {
  const box = { sent: null as { cmd: string; reqId: number } | null };
  let cliEventCb: ((line: string) => void) | null = null;
  (globalThis as { window?: unknown }).window = {
    onw: {
      cli: (req: { cmd: string; reqId: number }) => { box.sent = req; },
      onCliEvent: (cb: (line: string) => void) => { cliEventCb = cb; return () => {}; },
      onCliError: () => () => {},
    } as FakeOnw,
  };
  return {
    cliEventCb: (line: string) => cliEventCb?.(line),
    box,
  };
}

describe('renderer cli', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('handleCliLine resolves a pending request by reqId', () => {
    const pending = new Map<number, (r: ApiResult<unknown>) => void>();
    let resolved: ApiResult<unknown> | null = null;
    pending.set(7, (r) => { resolved = r; });
    handleCliLine('{"reqId":7,"result":{"ok":true,"data":"x"}}', pending);
    expect(resolved).toEqual({ ok: true, data: 'x' });
    expect(pending.size).toBe(0);
  });

  it('handleCliLine ignores non-result lines', () => {
    const pending = new Map<number, (r: ApiResult<unknown>) => void>();
    handleCliLine('not json', pending);
    handleCliLine('{"reqId":99}', pending);
    expect(pending.size).toBe(0);
  });

  it('sendCli resolves via the stubbed onCliEvent stream', async () => {
    const w = stubWindow();
    initCliClient();
    const p = sendCli({ cmd: 'state.summary' });
    expect(w.box.sent?.cmd).toBe('state.summary');
    w.cliEventCb(JSON.stringify({ reqId: w.box.sent!.reqId, result: { ok: true, data: 'ok' } }));
    expect(await p).toEqual({ ok: true, data: 'ok' });
  });
});
