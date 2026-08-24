// src/core/bigtable/store.ts
// 大表配置存取:每大表一个文件夹 `.onworking/bigtables/<folder>/bigtable.json`。
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Workspace } from '../workspace/workspace';
import type { BigTableConfig } from './schema';

function bigTableDir(ws: Workspace, folder: string): string {
  return join(ws.onworkingDir, 'bigtables', folder);
}

/** 大表自己的 SQLite DB 路径(每大表独立一个 DB)。 */
export function bigTableDbPath(ws: Workspace, folder: string): string {
  return join(bigTableDir(ws, folder), 'db', 'onworking.db');
}

export function listBigTables(ws: Workspace): string[] {
  const dir = join(ws.onworkingDir, 'bigtables');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'bigtable.json')))
    .map((d) => d.name)
    .sort();
}

export function saveBigTableConfig(ws: Workspace, folder: string, cfg: BigTableConfig): void {
  const dir = bigTableDir(ws, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bigtable.json'), JSON.stringify(cfg, null, 2), 'utf-8');
}

export function loadBigTableConfig(ws: Workspace, folder: string): BigTableConfig {
  const p = join(bigTableDir(ws, folder), 'bigtable.json');
  if (!existsSync(p)) throw new Error(`bigtable config not found: ${folder}`);
  return JSON.parse(readFileSync(p, 'utf-8')) as BigTableConfig;
}
