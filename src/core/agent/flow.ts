// src/core/agent/flow.ts
// 流程编排:把「初次设置」全流程用 AI 工具函数串起来(打开工作区→建大表→导入→表头→
// 字段→映射→清洗→总表→验证)。函数直调即可跑通,不依赖前端。
import type { Workspace } from '../workspace/workspace';
import type { ScannedFile } from '../ingest/scanner';
import type { BigTableConfig, BigTableField } from '../bigtable/schema';
import type { FieldMapping } from '../etl/transform';
import type { RunSummary } from '../pipeline/engine';
import { savePipeline } from '../pipeline/store';
import {
  toolOpenWorkspace,
  toolCreateBigTable,
  toolImportFiles,
  toolGetFileHeaders,
  toolSetBigTableFields,
  toolSetMapping,
  toolCreateCleaningPipeline,
  toolRunCleaning,
  toolBuildMasterTable,
  toolVerifyData,
} from './tools';

export interface SetupStep {
  tool: string;
  ok: boolean;
  detail: string;
}

export interface SetupFlowResult {
  success: boolean;
  steps: SetupStep[];
  bigTableRows: number;
  masterRows: number;
  bigTableFolder: string;
  workspacePath: string;
  error?: string;
}

function guessFieldsAndMappings(headers: string[]): {
  fields: BigTableField[];
  mappings: FieldMapping[];
} {
  const fields: BigTableField[] = [];
  const mappings: FieldMapping[] = [];
  headers.forEach((h, i) => {
    const isAmount = /金额|借方|贷方|余额|amount|amt/i.test(h);
    fields.push({ name: h, type: isAmount ? 'INTEGER' : 'TEXT', order: i + 1 });
    mappings.push({ sourceHeader: h, outputName: h, transform: isAmount ? 'to-cents' : 'none' });
  });
  return { fields, mappings };
}

function summarize(r: unknown): string {
  if (r === null || r === undefined) return 'ok';
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}

export async function runInitialSetupFlow(opts: {
  workspacePath: string;
  bigTableFolder: string;
  sourceDir: string;
  tableName?: string;
}): Promise<SetupFlowResult> {
  const { workspacePath, bigTableFolder, sourceDir, tableName } = opts;
  const steps: SetupStep[] = [];
  const push = async (tool: string, fn: () => unknown): Promise<unknown> => {
    try {
      const r = await fn();
      steps.push({ tool, ok: true, detail: summarize(r) });
      return r;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      steps.push({ tool, ok: false, detail: m });
      throw err;
    }
  };

  try {
    const ws = (await push('openWorkspace', () => toolOpenWorkspace(workspacePath))) as Workspace;

    await push('createBigTable', () =>
      toolCreateBigTable(ws, bigTableFolder, {
        tableName: tableName ?? 'seq',
        autoIncrement: true,
        fields: [],
      } as BigTableConfig),
    );

    const files = (await push('importFiles', () => toolImportFiles(ws, bigTableFolder, sourceDir))) as ScannedFile[];
    const headers = (await push('getFileHeaders', () => toolGetFileHeaders(files[0].path))) as ReturnType<
      typeof toolGetFileHeaders
    >;

    const { fields, mappings } = guessFieldsAndMappings(headers.detected.headers);
    await push('setBigTableFields', () => toolSetBigTableFields(ws, bigTableFolder, fields));
    await push('setMapping', () => toolSetMapping(ws, bigTableFolder, headers.detected.headerRow, mappings));
    const { pipelineId } = (await push('createCleaningPipeline', () =>
      toolCreateCleaningPipeline(ws, bigTableFolder, sourceDir),
    )) as { pipelineId: string };

    // 建立 SQL 清洗管线(大表 → 总表)
    const sqlId = `m_${Date.now()}`;
    const alias = `bt_${bigTableFolder.replace(/[^a-zA-Z0-9一-鿿_]/g, '_')}`;
    savePipeline(ws, {
      kind: 'sql-clean',
      id: sqlId,
      label: '构建总表',
      bigTables: [bigTableFolder],
      // SELECT * 复制全部列,任何列名都兼容
      sql: `SELECT * FROM "${alias}".${tableName ?? 'seq'}`,
      resultTable: tableName ?? 'seq',
      createdAt: new Date().toISOString(),
    });
    steps.push({ tool: 'saveSqlClean', ok: true, detail: sqlId });

    const cleanRes = (await push('runCleaning', async () => toolRunCleaning(ws, pipelineId))) as RunSummary;
    const masterRes = (await push('buildMasterTable', async () =>
      toolBuildMasterTable(ws, sqlId),
    )) as RunSummary;
    void cleanRes;
    void masterRes;

    const verify = (await push('verifyData', () => toolVerifyData(ws, bigTableFolder))) as {
      rows: number;
      masterRows: number;
    };

    return {
      success: true,
      steps,
      bigTableRows: verify.rows,
      masterRows: verify.masterRows,
      bigTableFolder,
      workspacePath,
    };
  } catch (err) {
    return {
      success: false,
      steps,
      bigTableRows: -1,
      masterRows: -1,
      bigTableFolder,
      workspacePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
