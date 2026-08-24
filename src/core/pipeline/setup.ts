// src/core/pipeline/setup.ts
// 管线配置助手(供 UI/IPC 配置流程调用):
// - detectSourceConfig:一键获取文件表头(SVG「每个 sheet 前 N 行锁定最可能的表头」)。
// - applyMappingTemplate:套用已存模板(SVG「保存为模板/应用模板」)。
import { parseCsvFile, parseExcelFile, type ParsedSheet } from '../ingest/parser';
import { detectHeaderRow } from '../ingest/header-detect';
import type { Workspace } from '../workspace/workspace';
import { loadTemplate, applyTemplateToSheet } from '../template/store';
import type { FieldMapping } from '../etl/transform';

export interface SourceConfig {
  sheetName: string;
  /** 表头行(1-based)。 */
  headerRow: number;
  headers: string[];
}

/** 解析源文件,自动检测表头行并返回表头。 */
export function detectSourceConfig(filePath: string, sheetName?: string): SourceConfig {
  const sheets =
    filePath.toLowerCase().endsWith('.csv')
      ? parseCsvFile(filePath)
      : parseExcelFile(filePath);
  const sheet =
    (sheetName ? sheets.find((s) => s.sheetName === sheetName) : undefined) ?? sheets[0];
  const fullRows = [sheet.headers, ...sheet.rows];
  const idx = detectHeaderRow({ sheetName: sheet.sheetName, headers: [], rows: fullRows });
  const headerRow = idx === -1 ? 1 : idx + 1;
  const headers =
    headerRow <= 1 ? sheet.headers : fullRows[headerRow - 1].map((c) => String(c));
  return { sheetName: sheet.sheetName, headerRow, headers };
}

/** 套用已保存的映射模板到某 sheet,返回匹配结果。 */
export function applyMappingTemplate(
  ws: Workspace,
  sheet: ParsedSheet,
  templateName: string,
): { mappings: FieldMapping[]; matched: number; skipped: string[] } {
  return applyTemplateToSheet(sheet, loadTemplate(ws, templateName));
}
