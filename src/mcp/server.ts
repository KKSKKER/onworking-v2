// src/mcp/server.ts
// MCP 适配:同一个 dispatch 包成 MCP server(JSON-RPC 2.0 / stdio 子集)。
// 每个 ApiCommand 映射成一个 MCP tool;tools/call 委托 dispatchIpc。零新依赖。
import { dispatchIpc, handlers } from '../ipc/handlers';
import type { ApiResult, IpcRequest } from '../ipc/contracts';
import type { ApiContext } from '../ipc/handlers';
import { loadSettings } from '../core/workspace/settings';
import { isAiAllowed, buildAiRestrictedError } from '../ipc/ai-gate';
import { MANUAL_TEXT } from './manual';

// ---- AI 开放模式门禁 ----
// 非 local 模式下调「真实数据」API 返回 AI_MODE_RESTRICTED;UI 不受影响。
// 门禁逻辑集中在 src/ipc/ai-gate.ts(CLI 与 MCP 共用)。

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

/** 注册的所有命令名(来自 handler 表 + 引导命令 workspace.open + 手册读取工具 manual.read)。 */
export const commandKinds = ['workspace.open', 'manual.read', ...Object.keys(handlers).sort()];

// ---- 工具 inputSchema(运行时 JSON Schema,让 MCP 客户端能正确传参) ----
interface Prop {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';
  items?: Prop;
}
interface ToolSchema {
  type: 'object';
  properties: Record<string, Prop>;
  required: string[];
}

const str: Prop = { type: 'string' };
const int: Prop = { type: 'integer' };
const bool: Prop = { type: 'boolean' };
const obj: Prop = { type: 'object' };
const objArr: Prop = { type: 'array', items: obj };

function schema(properties: Record<string, Prop>, required: string[] = []): ToolSchema {
  return { type: 'object', properties, required };
}

/** 每个命令的入参 JSON Schema(与 CommandPayloads 对齐)。 */
export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  'workspace.open': schema({ path: str }, ['path']),
  'manual.read': schema({}),
  'bigtable.list': schema({}),
  'bigtable.get': schema({ folder: str }, ['folder']),
  'bigtable.save': schema({ folder: str, config: obj }, ['folder', 'config']),
  'bigtable.sourceFiles': schema({ folder: str }, ['folder']),
  'bigtable.previewRows': schema({ folder: str, limit: int, offset: int }, ['folder']),
  'bigtable.addFiles': schema({ folder: str, files: objArr, overwrite: bool }, ['folder', 'files']),
  'bigtable.exportCsv': schema({ folder: str, path: str, includeLineage: bool }, ['folder']),
  'bigtable.config': schema({ folder: str }, ['folder']),
  'bigtable.delete': schema({ folder: str }, ['folder']),
  'bigtable.deleteSourceFile': schema({ folder: str, file: str }, ['folder', 'file']),
  'mapping.save': schema({ folder: str, headerRow: int, mappings: objArr, ruleName: str, sheetName: str, pattern: str }, ['folder', 'mappings']),
  'pipeline.list': schema({}),
  'pipeline.configs': schema({}),
  'pipeline.save': schema({ config: obj }, ['config']),
  'pipeline.delete': schema({ id: str }, ['id']),
  'pipeline.run': schema({ id: str }, ['id']),
  'pipeline.mergeBigTable': schema({ folder: str }, ['folder']),
  'pipeline.mergeAll': schema({}),
  'pipeline.buildMasterBigTable': schema({ folder: str }, ['folder']),
  'pipeline.buildMasterAll': schema({}),
  'pipeline.recomputeAll': schema({}),
  'pipeline.recomputeByDependency': schema({ trigger: str }, ['trigger']),
  'setup.detectSource': schema({ filePath: str, sheetName: str }, ['filePath']),
  'setup.sheets': schema({ filePath: str }, ['filePath']),
  'setup.preview': schema({ filePath: str, sheetName: str, headerRow: int, offset: int, limit: int }, ['filePath']),
  'setup.exportCsv': schema({ filePath: str, sheetName: str, headerRow: int, path: str }, ['filePath']),
  'query.run': schema({ sql: str, limit: int }, ['sql']),
  'query.exportCsv': schema({ sql: str, path: str }, ['sql']),
  'template.list': schema({}),
  'template.save': schema({ template: obj }, ['template']),
  'template.apply': schema({ name: str, sheet: obj }, ['name', 'sheet']),
  'schema.tables': schema({ folder: str }),
  'state.summary': schema({}),
  'vcs.status': schema({}),
  'settings.get': schema({}),
  'settings.setAiMode': schema({ mode: str }, ['mode']),
};

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
          inputSchema: TOOL_SCHEMAS[name] ?? { type: 'object' },
        })),
      },
    };
  }

  // 资源:Agent 可读操作须知(手册)。注意:MCP 无法强制模型读取,客户端侧注入才是硬保证。
  if (req.method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          { uri: 'onworking://manual', name: 'Agent 操作须知', description: 'Onworking Agent 操作须知(浓缩版,完整见 docs/agent-manual.md)', mimeType: 'text/markdown' },
        ],
      },
    };
  }

  if (req.method === 'resources/read') {
    const uri = req.params?.uri as string | undefined;
    if (uri === 'onworking://manual') {
      return { jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'text/markdown', text: MANUAL_TEXT }] } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32002, message: `resource not found: ${String(uri)}` } };
  }

  // 提示词:Agent 可调 prompts/get 取操作须知。
  if (req.method === 'prompts/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        prompts: [
          { name: 'onworking-manual', description: 'Onworking Agent 操作须知(完整见 docs/agent-manual.md)', arguments: [] },
        ],
      },
    };
  }

  if (req.method === 'prompts/get') {
    const name = req.params?.name as string | undefined;
    if (name === 'onworking-manual') {
      return {
        jsonrpc: '2.0',
        id,
        result: { messages: [{ role: 'user', content: [{ type: 'text', text: MANUAL_TEXT }] }] },
      };
    }
    return { jsonrpc: '2.0', id, error: { code: -32002, message: `prompt not found: ${String(name)}` } };
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

    // manual.read:返回 Agent 操作须知(AI 可经此工具读到手册并遵守)
    if (name === 'manual.read') {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: MANUAL_TEXT }] } };
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

    // AI 开放模式门禁:非 local 模式下,数据/写 API 对 AI 禁用(UI 不受影响)
    const aiMode = loadSettings(ctx.ws).aiOpenMode;
    if (!isAiAllowed(aiMode, name)) {
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(buildAiRestrictedError(aiMode, name)) }],
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
