// src/ipc/ai-gate.ts
// AI 访问控制:开放模式门禁 + CLI 鉴权信封。
//  - 门禁:非 local 模式下,「真实数据」API 对 AI 禁用(UI/带章的人类不受影响)。
//  - 信封:主进程转发渲染层命令时裹 { __onwAuth, __onwReq }(会话秘密),CLI 校验后放行为人类;
//    外部 AI 自己 spawn 的 CLI 没有秘密,命令一律按 AI 走门禁 —— 堵住 CLI 绕过。
import type { AiOpenMode } from '../core/workspace/settings';
import type { IpcRequest } from './contracts';

/** 会话秘密环境变量名:主进程 spawn CLI 桥时注入,外部 spawn 没有。 */
export const AUTH_SECRET_ENV = 'ONW_AUTH_SECRET';
export const AUTH_ENVELOPE_KEY = '__onwAuth';
export const AUTH_REQUEST_KEY = '__onwReq';

export interface AuthEnvelope {
  __onwAuth: string;
  __onwReq: IpcRequest;
}

/** 主进程把「人类」请求裹成信封,交给 CLI 校验。 */
export function makeEnvelope(secret: string, req: IpcRequest): AuthEnvelope {
  return { [AUTH_ENVELOPE_KEY]: secret, [AUTH_REQUEST_KEY]: req };
}

/** 解析一行 NDJSON:信封且 auth 匹配进程秘密 → 可信(人类);否则按 AI。 */
export function parseRequestLine(line: string): { req: IpcRequest; trusted: boolean } {
  const obj = JSON.parse(line) as Record<string, unknown>;
  const secret = process.env[AUTH_SECRET_ENV];
  const auth = typeof obj?.[AUTH_ENVELOPE_KEY] === 'string' ? (obj[AUTH_ENVELOPE_KEY] as string) : undefined;
  const inner = obj?.[AUTH_REQUEST_KEY] as IpcRequest | undefined;
  if (secret && auth && inner && auth === secret) {
    return { req: inner, trusted: true };
  }
  // 无合法信封 → 作为 AI 的裸请求;若带了信封结构(非法)仍当 AI 处理
  const req = (inner ?? obj) as IpcRequest;
  return { req, trusted: false };
}

// ---- 开放模式门禁 ----
// external:AI 可用「元数据 + schema/配置/管线管理」类命令,真实数据读写仍封。
//   - 元数据:state.summary、bigtable.list、pipeline.list、template.list、vcs.status、schema.tables、settings.get
//   - schema/配置(不碰业务行数据):bigtable.save/get/sourceFiles、setup.sheets/detectSource、mapping.save、template.save、pipeline.delete
//   - 管线管理:bigtable.addFiles(拷贝文件不解析)、pipeline.save/run
//   - 真实数据仍封:query.run/exportCsv(工作台可写,AI 更不能用)、bigtable.previewRows/exportCsv/config、setup.preview/exportCsv 等
//   - 破坏性操作仍封:bigtable.delete、bigtable.deleteSourceFile(删大表/源文件,仅人类 UI)
export const METADATA_ALLOWED = new Set([
  'state.summary', 'bigtable.list', 'pipeline.list', 'template.list', 'vcs.status', 'schema.tables', 'settings.get',
  // schema/配置命令:只写/读大表字段定义、sheet 名、映射规则、模板,不碰业务行数据。
  'bigtable.save', 'bigtable.get', 'bigtable.sourceFiles',
  'setup.sheets', 'setup.detectSource',
  'mapping.save', 'template.save',
  // 管线管理(建/删/跑管线 + 拷贝源文件):external 下开放给 AI。
  'pipeline.save', 'pipeline.run', 'pipeline.delete', 'bigtable.addFiles',
]);

export function isAiAllowed(mode: AiOpenMode, cmd: string): boolean {
  if (mode === 'local') return true;
  return METADATA_ALLOWED.has(cmd); // external:仅 schema/配置/管线管理
}

export function buildAiRestrictedError(mode: AiOpenMode, cmd: string): { code: string; message: string } {
  if (cmd === 'settings.setAiMode') {
    return { code: 'AI_MODE_RESTRICTED', message: 'AI 无权修改开放模式(仅界面可设置)' };
  }
  return { code: 'AI_MODE_RESTRICTED', message: `当前模式(${mode})不允许给 AI 使用该 API: ${cmd}` };
}
