// src/renderer/mock/onw-mock.ts
// 浏览器开发 mock:模拟 window.onw(真实环境由 Electron preload 提供)。
// 只在 window.onw 不存在时安装(浏览器 vite dev)。
import type { ApiCommand, ApiResult } from '../../ipc/contracts';

const SAMPLE_TABLES = ['seq', 'balance', 'total'];

export function installMockOnw(): void {
  const w = window as unknown as { onw?: unknown };
  if (w.onw) return;
  w.onw = {
    invoke: (command: ApiCommand): Promise<ApiResult<unknown>> => mockDispatch(command),
    pickWorkspace: async (): Promise<string | null> => 'D:/演示工作区',
    onProgress: () => () => {},
    onLog: () => () => {},
  };
}

async function mockDispatch(command: ApiCommand): Promise<ApiResult<unknown>> {
  await new Promise((r) => setTimeout(r, 150));
  switch (command.cmd) {
    case 'workspace.open':
      return ok({ root: 'D:/演示工作区', onworkingDir: 'D:/演示工作区/.onworking' });
    case 'bigtable.list':
      return ok(['序时账', '科目余额']);
    case 'bigtable.get': {
      const isBalance = command.folder === '科目余额';
      return ok({
        tableName: isBalance ? 'balance' : 'seq',
        autoIncrement: true,
        fields: [
          { name: 'date', type: 'TEXT', order: 1 },
          { name: isBalance ? 'amount' : 'debit', type: 'INTEGER', order: 2 },
          { name: 'note', type: 'TEXT', order: 3 },
        ],
      });
    }
    case 'bigtable.save':
      return ok({ saved: command.folder });
    case 'bigtable.sourceFiles':
      return ok(['序时账.xlsx', '序时账2025.XLS', '科目余额.csv']);
    case 'pipeline.list':
      return ok(['c1', 'q1']);
    case 'pipeline.save':
      return ok({ saved: (command.config as { id: string }).id });
    case 'pipeline.delete':
      return ok({ deleted: command.id });
    case 'pipeline.run':
      return ok({ pipelineId: command.id, kind: 'clean', ok: true, rows: 12345 });
    case 'pipeline.recomputeAll':
      return ok([
        { pipelineId: 'c1', kind: 'clean', ok: true, rows: 12345 },
        { pipelineId: 'q1', kind: 'query', ok: true, rows: 56 },
      ]);
    case 'pipeline.recomputeByDependency':
      return ok([]);
    case 'setup.sheets':
      return ok(['序时账', '科目余额表', '凭证明细']);
    case 'setup.detectSource':
      return ok({ sheetName: '序时账', headerRow: 1, headers: ['日期', '借方金额', '摘要'] });
    case 'setup.preview':
      return ok({
        sheetName: '序时账',
        headerRow: 1,
        headers: ['日期', '借方金额', '摘要'],
        rows: [
          ['2024-01-15', 123456, '计提工资'],
          ['2024-01-16', 8200, '差旅报销'],
        ],
        total: 11110,
      });
    case 'query.run':
      return ok({
        columns: ['date', 'total'],
        rows: [
          { date: '2024-01', total: 123456 },
          { date: '2024-02', total: 8200 },
        ],
        rowCount: 2,
      });
    case 'template.list':
      return ok([]);
    case 'template.save':
      return ok({ saved: command.template.name });
    case 'template.apply':
      return ok({ mappings: [], matched: 0, skipped: [] });
    case 'schema.tables':
      return ok(SAMPLE_TABLES.map((name) => ({ name })));
    case 'state.summary':
      return ok('workspace=演示\n序时账: cleaned (files=3, mappedFields=3, pipelines=1)');
    case 'vcs.status':
      return ok({ staged: [], unstaged: [], untracked: ['settings.json'] });
    default:
      return err('UNKNOWN_CMD', `unknown command: ${(command as { cmd: string }).cmd}`);
  }
}

function ok(data: unknown): ApiResult<unknown> {
  return { ok: true, data };
}
function err(code: string, message: string): ApiResult<unknown> {
  return { ok: false, error: { code, message } };
}
