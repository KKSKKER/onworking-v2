import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createContext } from '../../src/app/context';
import type { ApiContext } from '../../src/ipc/handlers';
import { handleMcpRequest, type McpSession } from '../../src/mcp/server';

describe('mcp server', () => {
  let dir: string;
  let session: McpSession;
  const opened: ApiContext[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    let current: ApiContext | null = null;
    session = {
      open: (path: string): ApiContext => {
        const ctx = createContext(path);
        opened.push(ctx);
        current = ctx;
        return ctx;
      },
      getCtx: (): ApiContext | null => current,
    };
    session.open(dir); // 预打开一个工作区,供大多数用例使用
  });

  afterEach(() => {
    for (const ctx of opened) ctx.getEngine().close();
    opened.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers initialize with protocol version', async () => {
    const res = await handleMcpRequest(session, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res?.id).toBe(1);
    expect((res?.result as { protocolVersion?: string })?.protocolVersion).toBeTruthy();
  });

  it('lists one tool per api command including workspace.open', async () => {
    const res = await handleMcpRequest(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res?.result as { tools: { name: string }[] }).tools;
    expect(tools.length).toBeGreaterThan(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain('workspace.open');
    expect(names).toContain('state.summary');
  });

  it('tools/list exposes input schemas with properties and required', async () => {
    const res = await handleMcpRequest(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res?.result as {
      tools: { name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }[];
    }).tools;
    const open = tools.find((t) => t.name === 'workspace.open');
    expect(open?.inputSchema.properties?.path).toBeTruthy();
    expect(open?.inputSchema.required).toContain('path');
    const preview = tools.find((t) => t.name === 'bigtable.previewRows');
    expect(preview?.inputSchema.properties?.folder).toBeTruthy();
    expect(preview?.inputSchema.properties?.limit).toBeTruthy();
    expect(preview?.inputSchema.required).toEqual(['folder']);
  });

  it('calls a tool and returns the dispatch result as text content', async () => {
    const res = await handleMcpRequest(session, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'state.summary', arguments: {} },
    });
    const content = (res?.result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('workspace');
  });

  it('tools/call workspace.open opens a workspace and returns it', async () => {
    const res = await handleMcpRequest(session, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'workspace.open', arguments: { path: dir } },
    });
    const text = String((res?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? '');
    expect((JSON.parse(text) as { root: string }).root).toBe(dir);
  });

  it('tools/call workspace.open switches the active workspace', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'mcp2-'));
    try {
      await handleMcpRequest(session, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'workspace.open', arguments: { path: dir2 } },
      });
      const s = await handleMcpRequest(session, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'state.summary', arguments: {} },
      });
      const sText = String((s?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? '');
      expect(sText).toContain(basename(dir2));
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('returns NO_WORKSPACE for data tools before any workspace.open', async () => {
    const fresh: McpSession = { open: (p) => createContext(p), getCtx: () => null };
    const res = await handleMcpRequest(fresh, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'state.summary', arguments: {} },
    });
    const content = (res?.result as { content?: { text?: string }[]; isError?: boolean } | undefined);
    expect(content?.isError).toBe(true);
    expect(String(content?.content?.[0]?.text ?? '')).toContain('NO_WORKSPACE');
  });

  it('workspace.open without a path returns -32602', async () => {
    const res = await handleMcpRequest(session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'workspace.open', arguments: {} },
    });
    expect(res?.error?.code).toBe(-32602);
  });

  it('returns a JSON-RPC error for unknown method or tool', async () => {
    const unknownMethod = await handleMcpRequest(session, { jsonrpc: '2.0', id: 4, method: 'nope' });
    expect(unknownMethod?.error?.code).toBe(-32601);
    const unknownTool = await handleMcpRequest(session, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'no.such.tool', arguments: {} },
    });
    expect(unknownTool?.error?.code).toBe(-32602);
  });

  it('returns null for notifications (no reply expected)', async () => {
    const res = await handleMcpRequest(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
  });

  it('exposes the operations manual as a resource', async () => {
    const list = await handleMcpRequest(session, { jsonrpc: '2.0', id: 1, method: 'resources/list' });
    const res = (list?.result as { resources: { uri: string }[] }).resources;
    expect(res[0].uri).toBe('onworking://manual');
    const read = await handleMcpRequest(session, { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'onworking://manual' } });
    const text = (read?.result as { contents: { text: string }[] }).contents[0].text;
    expect(text).toContain('铁律');
    expect(text).toContain('总表 master.db');
  });

  it('exposes the operations manual as a prompt', async () => {
    const list = await handleMcpRequest(session, { jsonrpc: '2.0', id: 1, method: 'prompts/list' });
    const names = (list?.result as { prompts: { name: string }[] }).prompts.map((p) => p.name);
    expect(names).toContain('onworking-manual');
    const get = await handleMcpRequest(session, { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'onworking-manual' } });
    const text = (get?.result as { messages: { content: { text: string }[] }[] }).messages[0].content[0].text;
    expect(text).toContain('铁律');
  });
});
