// scripts/mcp-client-test.ts
// 最小 MCP 客户端:充当真实客户端,spawn `onw mcp <ws>` 作为 stdio 子进程(客户端绑定模型,
// 客户端启动 → MCP 服务器启动),走完整握手 initialize → notifications/initialized →
// tools/list → tools/call,逐项断言。失败退出码非 0。
// 用法: npm run test:mcp
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), 'onw-mcp-client-'));
  console.log(`工作区: ${ws}`);
  console.log('== MCP 客户端绑定测试(onw mcp <ws>) ==');

  const child = spawn('npm', ['run', '--silent', 'onw', '--', 'mcp', ws], {
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // stdout 解析:newline-delimited JSON-RPC,按 id 对账
  const pending = new Map<number | string, (msg: JsonRpc) => void>();
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: JsonRpc;
      try {
        msg = JSON.parse(line) as JsonRpc;
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!;
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const send = (id: number, method: string, params: Record<string, unknown> = {}): Promise<JsonRpc> =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  try {
    // 1) initialize
    const init = await send(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'onw-mcp-client-test', version: '1.0.0' },
    });
    check('initialize 返回 protocolVersion', !!((init.result as { protocolVersion?: string } | undefined)?.protocolVersion), JSON.stringify(init.result ?? init.error));
    check('serverInfo.name === onworking', (init.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo?.name === 'onworking', JSON.stringify((init.result as { serverInfo?: unknown } | undefined)?.serverInfo));

    // 2) notifications/initialized(无响应,不回包)
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // 3) tools/list
    const list = await send(2, 'tools/list', {});
    const tools = (list.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    check('tools/list 返回工具列表', tools.length > 0, `count=${tools.length}`);
    const names = tools.map((t) => t.name);
    check('含 state.summary / bigtable.list', names.includes('state.summary') && names.includes('bigtable.list'), names.join(','));

    // 4) tools/call:state.summary
    const summary = await send(3, 'tools/call', { name: 'state.summary', arguments: {} });
    const summaryText = String((summary.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? '');
    check('tools/call state.summary 返回文本', summaryText.length > 0, summaryText.slice(0, 60));
    check('state.summary 内容含 workspace', summaryText.includes('workspace'));

    // 5) tools/call:bigtable.save → bigtable.list
    const save = await send(4, 'tools/call', {
      name: 'bigtable.save',
      arguments: {
        folder: 'seq',
        config: { tableName: 'seq', fields: [{ name: 'date', type: 'TEXT', order: 1 }], autoIncrement: false },
      },
    });
    check('tools/call bigtable.save 成功', (save.result as { isError?: boolean } | undefined)?.isError !== true, JSON.stringify(save.result ?? save.error));
    const btList = await send(5, 'tools/call', { name: 'bigtable.list', arguments: {} });
    const btText = String((btList.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? '');
    check('bigtable.list 含 seq', btText.includes('seq'), btText);

    // 6) tools/call:未知工具 → -32602
    const bad = await send(6, 'tools/call', { name: 'no.such.tool', arguments: {} });
    check('未知工具返回 -32602', bad.error?.code === -32602, JSON.stringify(bad.error));

    // 7) 未知方法 → -32601
    const unknown = await send(7, 'nope', {});
    check('未知方法返回 -32601', unknown.error?.code === -32601, JSON.stringify(unknown.error));
  } finally {
    // 关闭 stdin 让服务器退出
    child.stdin!.end();
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(() => resolve(), 5000); // 兜底超时
    });
    rmSync(ws, { recursive: true, force: true });
  }

  console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
