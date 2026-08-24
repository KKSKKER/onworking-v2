// scripts/agent-flow-demo.ts
// 用 AI 工具函数直接跑通「初次设置」全流程,不依赖前端。
// 用法: npm run demo:agent -- <工作区> <源目录> [大表名]
import { rmSync } from 'node:fs';
import { runInitialSetupFlow } from '../src/core/agent/flow';
import { toolCreateQueryPipeline, toolRunQueryPipeline, toolQuery } from '../src/core/agent/tools';
import { openWorkspace } from '../src/core/workspace/workspace';
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

  // ===== 查询管线(泳道图查询流程) =====
  if (result.success) {
    const ws = openWorkspace(workspacePath);
    console.log(`\n===== 查询管线 =====`);
    // 1. 先看总表列名
    const probe = toolQuery(ws, 'SELECT * FROM seq LIMIT 1');
    console.log(`  ✓ adHocQuery(probe): 列=${probe.columns.join(', ')}`);
    // 2. 创建查询管线(AI 生成 SQL → 保存 pipeline 配置)
    const amountCol = probe.columns.find((c) => /金额|借方|贷方|余额|amount|amt/i.test(c)) ?? probe.columns[0];
    toolCreateQueryPipeline(ws, 'q_total', {
      sql: `SELECT SUM("${amountCol}") AS total, COUNT(*) AS n FROM seq`,
      dependencies: ['seq'],
      resultTable: 'total',
    });
    console.log(`  ✓ createQueryPipeline: q_total (SUM "${amountCol}")`);
    // 3. 运行查询管线 → 生成查询表
    const qr = await toolRunQueryPipeline(ws, 'q_total');
    console.log(`  ✓ runQueryPipeline: ${qr.ok ? `OK ${qr.rows} 行` : `失败 ${qr.error}`}`);
    // 4. ad-hoc 查询结果
    const q = toolQuery(ws, 'SELECT * FROM total');
    console.log(`  ✓ adHocQuery: ${q.rowCount} 行, 列=${q.columns.join(', ')}`);
    if (q.rows[0]) console.log(`    结果示例: ${JSON.stringify(q.rows[0])}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
