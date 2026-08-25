import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { PipelineEngine } from '../../src/core/pipeline/engine';
import type { ApiContext } from '../../src/ipc/handlers';
import { handleMcpRequest } from '../../src/mcp/server';

describe('mcp server', () => {
  let dir: string;
  let ws: Workspace;
  let ctx: ApiContext;
  let engine: PipelineEngine | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    ws = initWorkspace(dir);
    ctx = {
      ws,
      dbPath: join(ws.onworkingDir, 'db', 'master.db'),
      getEngine: () => (engine ??= new PipelineEngine(ws)),
    };
  });

  afterEach(() => {
    engine?.close();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers initialize with protocol version', async () => {
    const res = await handleMcpRequest(ctx, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res?.id).toBe(1);
    expect((res?.result as { protocolVersion?: string })?.protocolVersion).toBeTruthy();
  });

  it('lists one tool per api command', async () => {
    const res = await handleMcpRequest(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res?.result as { tools: { name: string }[] }).tools;
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.map((t) => t.name)).toContain('state.summary');
  });

  it('calls a tool and returns the dispatch result as text content', async () => {
    const res = await handleMcpRequest(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'state.summary', arguments: {} },
    });
    const content = (res?.result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('workspace');
  });

  it('returns a JSON-RPC error for unknown method or tool', async () => {
    const unknownMethod = await handleMcpRequest(ctx, { jsonrpc: '2.0', id: 4, method: 'nope' });
    expect(unknownMethod?.error?.code).toBe(-32601);
    const unknownTool = await handleMcpRequest(ctx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'no.such.tool', arguments: {} },
    });
    expect(unknownTool?.error?.code).toBe(-32602);
  });

  it('returns null for notifications (no reply expected)', async () => {
    const res = await handleMcpRequest(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
  });
});
