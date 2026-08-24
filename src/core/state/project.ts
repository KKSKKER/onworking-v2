// src/core/state/project.ts
// 项目状态机:记录每个大表的处理阶段(created→files-imported→mapped→cleaned→queryable),
// 校验阶段转移,持久化到 `.onworking/state.json`。
// 用途:Agent 靠它「准备软件当前状态信息」决定下一步;UI 可展示项目进度。
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Workspace } from '../workspace/workspace';
import { AppError } from '../errors';

export type BigTablePhase =
  | 'created'
  | 'files-imported'
  | 'mapped'
  | 'cleaned'
  | 'queryable';

const PHASE_ORDER: BigTablePhase[] = [
  'created',
  'files-imported',
  'mapped',
  'cleaned',
  'queryable',
];

export interface BigTableState {
  phase: BigTablePhase;
  files: number;
  mappedFields: number;
  pipelines: string[];
}

export interface ProjectStateData {
  workspaceName: string;
  updatedAt: string;
  bigTables: Record<string, BigTableState>;
}

function defaultBigTable(): BigTableState {
  return { phase: 'created', files: 0, mappedFields: 0, pipelines: [] };
}

function workspaceNameOf(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'workspace';
}

export class ProjectState {
  private ws: Workspace;
  private data: ProjectStateData;

  constructor(ws: Workspace) {
    this.ws = ws;
    this.data = this.load();
  }

  private statePath(): string {
    return join(this.ws.onworkingDir, 'state.json');
  }

  private load(): ProjectStateData {
    const p = this.statePath();
    if (!existsSync(p)) {
      return {
        workspaceName: workspaceNameOf(this.ws.root),
        updatedAt: new Date().toISOString(),
        bigTables: {},
      };
    }
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as ProjectStateData;
    } catch {
      return {
        workspaceName: workspaceNameOf(this.ws.root),
        updatedAt: new Date().toISOString(),
        bigTables: {},
      };
    }
  }

  save(): void {
    this.data.updatedAt = new Date().toISOString();
    writeFileSync(this.statePath(), JSON.stringify(this.data, null, 2), 'utf-8');
  }

  addBigTable(folder: string): void {
    if (!this.data.bigTables[folder]) {
      this.data.bigTables[folder] = defaultBigTable();
    }
  }

  getBigTable(folder: string): BigTableState | undefined {
    return this.data.bigTables[folder];
  }

  listBigTables(): string[] {
    return Object.keys(this.data.bigTables).sort();
  }

  /** 状态转移:只允许前进或保持(by phase order)。回退抛 AppError。 */
  setPhase(folder: string, phase: BigTablePhase): void {
    this.addBigTable(folder);
    const current = this.data.bigTables[folder].phase;
    const cur = PHASE_ORDER.indexOf(current);
    const next = PHASE_ORDER.indexOf(phase);
    if (next < cur) {
      throw new AppError({
        module: 'state',
        code: 'STATE_BAD_TRANSITION',
        message: `cannot move ${folder} from ${current} to ${phase}`,
        data: { folder, current, phase },
      });
    }
    this.data.bigTables[folder].phase = phase;
  }

  /** 回到 created(源数据大改需要重新走流程)。 */
  resetPhase(folder: string): void {
    this.addBigTable(folder);
    this.data.bigTables[folder].phase = 'created';
  }

  registerFiles(folder: string, count: number): void {
    this.addBigTable(folder);
    this.data.bigTables[folder].files = count;
  }

  registerMapping(folder: string, count: number): void {
    this.addBigTable(folder);
    this.data.bigTables[folder].mappedFields = count;
  }

  attachPipeline(folder: string, pipelineId: string): void {
    this.addBigTable(folder);
    const bt = this.data.bigTables[folder];
    if (!bt.pipelines.includes(pipelineId)) bt.pipelines.push(pipelineId);
  }

  /** 人类/AI 可读的当前状态摘要。 */
  getSummary(): string {
    const lines = Object.entries(this.data.bigTables).map(([f, s]) =>
      `${f}: ${s.phase} (files=${s.files}, mappedFields=${s.mappedFields}, pipelines=${s.pipelines.length})`,
    );
    return `workspace=${this.data.workspaceName}\n${lines.join('\n')}`;
  }
}
