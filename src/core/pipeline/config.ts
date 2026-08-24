// src/core/pipeline/config.ts
// 管线配置类型与校验:清洗管线(源文件→大表)与查询管线(SQL→结果表)。
import type { FieldMapping } from '../etl/transform';

export type PipelineKind = 'clean' | 'query';

export interface CleanPipelineConfig {
  kind: 'clean';
  id: string;
  label: string;
  /** 输出目标大表文件夹(血缘节点)。 */
  bigTableFolder: string;
  /** 源文件目录(输入)。 */
  sourceDir: string;
  sheetName?: string;
  /** 表头行(1-based)。 */
  headerRow: number;
  mappings: FieldMapping[];
  createdAt: string;
}

export interface QueryPipelineConfig {
  kind: 'query';
  id: string;
  label: string;
  sql: string;
  /** 依赖的大表表名(血缘上游)。 */
  dependencies: string[];
  resultTable: string;
  createdAt: string;
}

export type PipelineConfig = CleanPipelineConfig | QueryPipelineConfig;

/** 返回错误字符串数组;空数组 = 合法。 */
export function validatePipeline(cfg: PipelineConfig): string[] {
  const errors: string[] = [];
  if (!cfg.id || !cfg.id.trim()) errors.push('id');
  if (cfg.kind === 'clean') {
    if (!cfg.bigTableFolder || !cfg.bigTableFolder.trim()) errors.push('bigTableFolder');
    if (!cfg.sourceDir || !cfg.sourceDir.trim()) errors.push('sourceDir');
    if (!(cfg.headerRow >= 1)) errors.push('headerRow');
    if (!cfg.mappings || cfg.mappings.length === 0) errors.push('mappings');
  } else {
    if (!cfg.sql || !cfg.sql.trim()) errors.push('sql');
    if (!cfg.resultTable || !cfg.resultTable.trim()) errors.push('resultTable');
  }
  return errors;
}
