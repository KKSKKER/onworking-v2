// src/core/pipeline/store.ts
// 管线配置存取:`.onworking/pipelines/<id>.json`(纯文本,git 可管)。
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import type { Workspace } from '../workspace/workspace';
import type { PipelineConfig } from './config';
import { AppError } from '../errors';

function pipelinesDir(ws: Workspace): string {
  const dir = join(ws.onworkingDir, 'pipelines');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function assertSafeId(id: string): void {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new AppError({
      module: 'pipeline',
      code: 'PIPELINE_BAD_ID',
      message: `invalid pipeline id: ${id}`,
      data: { id },
    });
  }
}

export function listPipelines(ws: Workspace): string[] {
  const dir = pipelinesDir(ws);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function savePipeline(ws: Workspace, cfg: PipelineConfig): void {
  assertSafeId(cfg.id);
  writeFileSync(
    join(pipelinesDir(ws), `${cfg.id}.json`),
    JSON.stringify(cfg, null, 2),
    'utf-8',
  );
}

export function loadPipeline(ws: Workspace, id: string): PipelineConfig {
  assertSafeId(id);
  const p = join(pipelinesDir(ws), `${id}.json`);
  if (!existsSync(p)) {
    throw new AppError({
      module: 'pipeline',
      code: 'PIPELINE_NOT_FOUND',
      message: `pipeline not found: ${id}`,
      data: { id },
    });
  }
  return JSON.parse(readFileSync(p, 'utf-8')) as PipelineConfig;
}

export function deletePipeline(ws: Workspace, id: string): void {
  assertSafeId(id);
  rmSync(join(pipelinesDir(ws), `${id}.json`), { force: true });
}
