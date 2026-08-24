// scripts/agent-task.ts
// 验收:整个流程只调用封装好的工具函数(不许其他操作),按泳道图一步步执行。
// 用法: npm run demo:task -- <工作区> <源目录>
import {
  toolOpenWorkspace,
  toolCreateBigTable,
  toolImportFiles,
  toolGetFileHeaders,
  toolSetBigTableFields,
  toolSetupMapping,
  toolRunCleaning,
  toolCreateSqlCleanPipeline,
  toolBuildMasterTable,
  toolCreateQueryPipeline,
  toolRunQueryPipeline,
  toolQuery,
} from '../src/core/agent/tools';
import { useConsoleLogging } from '../src/core/logging';

useConsoleLogging('info');

const wsPath = process.argv[2];
const sourceDir = process.argv[3];
if (!wsPath || !sourceDir) {
  console.error('用法: npm run demo:task -- <工作区> <源目录>');
  process.exit(1);
}
const BIG_TABLE = '序时账';

async function main(): Promise<void> {
  // 第 1 步:打开工作区(文件夹由 toolOpenWorkspace 创建)
  const ws = toolOpenWorkspace(wsPath);
  console.log('✓ ① toolOpenWorkspace');

  // 第 2 步:导入文件
  const files = toolImportFiles(ws, BIG_TABLE, sourceDir);
  console.log(`✓ ② toolImportFiles: ${files.length} 个文件`);

  // 第 3 步:表头检测
  const headers = toolGetFileHeaders(files[0].path);
  console.log(`✓ ③ toolGetFileHeaders: 表头行 ${headers.detected.headerRow}`);

  // 第 4 步:创建大表字段(只要 借方余额 / 贷方余额 / 年份)
  toolCreateBigTable(ws, BIG_TABLE, { tableName: 'seq', autoIncrement: true, fields: [] });
  toolSetBigTableFields(ws, BIG_TABLE, [
    { name: '借方余额', type: 'INTEGER', order: 1 },
    { name: '贷方余额', type: 'INTEGER', order: 2 },
    { name: '年份', type: 'TEXT', order: 3 },
  ]);
  console.log('✓ ④ toolSetBigTableFields: 借方余额 / 贷方余额 / 年份');

  // 第 5 步:创建映射(写 YAML 规则 + 清洗管线)
  const { pipelineId } = toolSetupMapping(ws, BIG_TABLE, sourceDir, headers.detected.headerRow, [
    { sourceHeader: '借方金额合计', outputName: '借方余额', transform: 'to-cents' },
    { sourceHeader: '贷方金额合计', outputName: '贷方余额', transform: 'to-cents' },
    { sourceHeader: '年度', outputName: '年份', transform: 'none' },
  ]);
  console.log(`✓ ⑤ toolSetupMapping: ${pipelineId}`);

  // 第 6 步:清洗入大表
  const clean = await toolRunCleaning(ws, pipelineId);
  console.log(`✓ ⑥ toolRunCleaning: ${clean.rows} 行`);

  // 第 7 步:SQL 清洗管线 → 总表 master
  const { pipelineId: mId } = toolCreateSqlCleanPipeline(ws, 'm1', {
    bigTables: [BIG_TABLE],
    sql: 'SELECT "借方余额", "贷方余额", "年份" FROM "bt_序时账".seq',
    resultTable: 'seq',
  });
  const master = await toolBuildMasterTable(ws, mId);
  console.log(`✓ ⑦ toolBuildMasterTable: ${master.rows} 行`);

  // 第 8 步:查询管线 —— 借方余额 5000 元一档,记个数
  toolCreateQueryPipeline(ws, 'q_bucket', {
    sql: 'SELECT CAST(CAST("借方余额" AS REAL)/100/5000 AS INTEGER) AS bucket, COUNT(*) AS n FROM seq WHERE "借方余额" IS NOT NULL GROUP BY bucket ORDER BY bucket',
    dependencies: ['seq'],
    resultTable: 'buckets',
  });
  const qr = await toolRunQueryPipeline(ws, 'q_bucket');
  console.log(`✓ ⑧ toolRunQueryPipeline: ${qr.ok ? `OK ${qr.rows} 行` : `失败 ${qr.error}`}`);

  // 第 9 步:取查询结果(结果已保存到总表 DB 的 buckets 表)
  const result = toolQuery(ws, 'SELECT * FROM buckets ORDER BY bucket');
  console.log('\n===== 借方余额区间分布(5000 元/档)=====');
  let total = 0;
  for (const r of result.rows) {
    const b = Number(r.bucket);
    const n = Number(r.n);
    total += n;
    console.log(`  ${b * 5000} ~ ${b * 5000 + 4999} 元 : ${n} 条`);
  }
  console.log(`  总计: ${total} 条`);
  console.log('\n查询结果已保存到总表 DB 的 buckets 表。');
}

main().catch((e) => {
  console.error('流程失败:', e);
  process.exit(1);
});
