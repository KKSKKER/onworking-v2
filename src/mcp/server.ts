// src/mcp/server.ts
// MCP 适配:同一个 dispatch 包成 MCP server(JSON-RPC 2.0 / stdio 子集)。
// 每个 ApiCommand 映射成一个 MCP tool;tools/call 委托 dispatchIpc。零新依赖。
import { dispatchIpc, handlers } from '../ipc/handlers';
import type { ApiResult, IpcRequest } from '../ipc/contracts';
import type { ApiContext } from '../ipc/handlers';

const PROTOCOL_VERSION = '2024-11-05';

export interface McpRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** MCP 会话:持有可变更的工作区 ctx,agent 可随时用 workspace.open 打开/切换。 */
export interface McpSession {
  open(path: string): ApiContext;
  getCtx(): ApiContext | null;
}

/** 注册的所有命令名(来自 handler 表 + 引导命令 workspace.open)。 */
export const commandKinds = ['workspace.open', ...Object.keys(handlers).sort()];

/** 处理一条 JSON-RPC 请求;notification 无 id,返回 null 表示不回包。 */
export async function handleMcpRequest(
  session: McpSession,
  req: McpRequest,
): Promise<McpResponse | null> {
  const id = req.id ?? null;
  if (req.method.startsWith('notifications/')) return null;

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'onworking', version: '0.2.0' },
      },
    };
  }

  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: commandKinds.map((name) => ({
          name,
          description: `onworking command: ${name}`,
          inputSchema: { type: 'object' },
        })),
      },
    };
  }

  if (req.method === 'tools/call') {
    const name = req.params?.name as string | undefined;
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    if (!name || !commandKinds.includes(name)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${String(name)}` } };
    }

    // workspace.open 由会话层处理(打开/切换工作区),不进 dispatch
    if (name === 'workspace.open') {
      const path = args.path as string | undefined;
      if (!path) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'workspace.open requires a path argument' } };
      }
      const ctx = session.open(path);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(ctx.ws) }] },
      };
    }

    const ctx = session.getCtx();
    if (!ctx) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ code: 'NO_WORKSPACE', message: 'no workspace opened; call workspace.open first' }) }],
          isError: true,
        },
      };
    }

    // name 已在上方用 commandKinds 校验过,拼装后按契约强转
    const request = { ...(args as Record<string, unknown>), cmd: name, reqId: 1 } as IpcRequest;
    const env = (await dispatchIpc(request, ctx)) as { reqId: number; result: ApiResult<unknown> };
    return {
      jsonrpc: '2.0',
      id,
      result: env.result.ok
        ? { content: [{ type: 'text', text: JSON.stringify(env.result.data) }] }
        : { content: [{ type: 'text', text: JSON.stringify(env.result.error) }], isError: true },
    };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${req.method}` } };
}
