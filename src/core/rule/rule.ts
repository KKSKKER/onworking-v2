// src/core/rule/rule.ts
// 提取规则 YAML 类型(参考 V1):sources(文件匹配/sheet/表头/截止)+ fields(字段映射+transforms)。
export interface RuleSource {
  /** 与源目录相对的 glob,如「任意目录/序时账*.XLS」。 */
  pattern: string;
  sheetIndex?: number;
  sheetName?: string;
  /** 表头行(1-based)。 */
  headerRow: number;
  endRow?: number;
}

export type RuleTransformKind = 'coerce_cents' | 'coerce_date' | 'coerce_string' | 'none';

export interface RuleField {
  sourceHeader: string;
  outputName: string;
  included?: boolean;
  order: number;
  transforms?: { kind: RuleTransformKind; [k: string]: unknown }[];
}

export interface RuleYaml {
  name: string;
  display?: string;
  version?: number;
  sources: RuleSource[];
  fields: RuleField[];
}
