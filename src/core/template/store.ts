// src/core/template/store.ts
// 字段映射模板:同构文件一键套用映射。存 `.onworking/templates/<name>.json`(纯文本,git 可管)。
import { join, sep } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import type { Workspace } from '../workspace/workspace';
import type { FieldMapping } from '../etl/transform';
import { canonicalizeHeaders } from '../etl/headers';
import type { ParsedSheet } from '../ingest/parser';
import { AppError } from '../errors';

export interface MappingTemplate {
  name: string;
  mappings: FieldMapping[];
  createdAt: string;
}

function templatesDir(ws: Workspace): string {
  const dir = join(ws.onworkingDir, 'templates');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function assertSafeName(name: string): void {
  if (!name || name.includes(sep) || name.includes('/') || name.includes('..')) {
    throw new AppError({
      module: 'template',
      code: 'TEMPLATE_BAD_NAME',
      message: `invalid template name: ${name}`,
      data: { name },
    });
  }
}

export function listTemplates(ws: Workspace): string[] {
  const dir = templatesDir(ws);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function saveTemplate(ws: Workspace, tpl: MappingTemplate): void {
  assertSafeName(tpl.name);
  writeFileSync(join(templatesDir(ws), `${tpl.name}.json`), JSON.stringify(tpl, null, 2), 'utf-8');
}

export function loadTemplate(ws: Workspace, name: string): MappingTemplate {
  assertSafeName(name);
  const p = join(templatesDir(ws), `${name}.json`);
  if (!existsSync(p)) {
    throw new AppError({
      module: 'template',
      code: 'TEMPLATE_NOT_FOUND',
      message: `template not found: ${name}`,
      data: { name },
    });
  }
  return JSON.parse(readFileSync(p, 'utf-8')) as MappingTemplate;
}

export function deleteTemplate(ws: Workspace, name: string): void {
  assertSafeName(name);
  rmSync(join(templatesDir(ws), `${name}.json`), { force: true });
}

/** 按 sourceHeader 匹配模板映射到 sheet;匹配不到的跳过并反馈。 */
export function applyTemplateToSheet(
  sheet: ParsedSheet,
  tpl: MappingTemplate,
): { mappings: FieldMapping[]; matched: number; skipped: string[] } {
  // 用规范名匹配:模板可写编号名(姓名_2)精确命中重复列;裸名不会误命中重复表头(进 skipped)
  const headers = new Set(canonicalizeHeaders(sheet.headers).names);
  const mappings: FieldMapping[] = [];
  const skipped: string[] = [];
  for (const m of tpl.mappings) {
    if (headers.has(m.sourceHeader)) mappings.push(m);
    else skipped.push(m.sourceHeader);
  }
  return { mappings, matched: mappings.length, skipped };
}
