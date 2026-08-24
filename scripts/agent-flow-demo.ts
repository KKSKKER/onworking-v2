// scripts/agent-flow-demo.ts
// 用 AI 工具函数直接跑通「初次设置」全流程,不依赖前端。
// 用法: npm run demo:agent -- <工作区> <源目录> [大表名]
import { rmSync } from 'node:fs';
import { runInitialSetupFlow } from '../src/core/agent/flow';
import { useConsoleLogging } from '../src/core/logging';

useConsoleLogging('info');

const workspacePath = process.argv[2];
const sourceDir = process.argv[3];
const bigTableFolder = process.argv[4] ?? '序时账';
if (!workspacePath || !sourceDir) {
  console.error('用法: npm run demo:agent -- <工作区> <源目录> [大表名]');
  process.exit(1);
}

async function main(): Promise<void> {
  rmSync(workspacePath, { recursive: true, force: true }); // 从干净工作区开始
  const t0 = Date.now();
  const result = await runInitialSetupFlow({ workspacePath, bigTableFolder, sourceDir, tableName: 'seq' });
  const elapsed = Date.now() - t0;

  console.log(`\n===== AI 工具函数全流程 ===== (${elapsed}ms)`);
  for (const s of result.steps) {
    const mark = s.ok ? '✓' : '✗';
    console.log(`  ${mark} ${s.tool}: ${s.detail.slice(0, 120)}`);
  }
  console.log(`\n结果: ${result.success ? '成功' : '失败'}`);
  console.log(`大表(${result.bigTableFolder})行数: ${result.bigTableRows}`);
  console.log(`总表行数: ${result.masterRows}`);
  if (result.error) console.log(`错误: ${result.error}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
