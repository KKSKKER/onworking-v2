// src/core/rule/compile.ts
// 规则编译:RuleYaml → 可执行的 sources(文件匹配/sheet/表头)+ fields 映射。
import type { FieldMapping, ValueTransform } from '../etl/transform';
import type { RuleTransformKind, RuleYaml } from './rule';

export interface CompiledSource {
  pattern: string;
  sheetIndex?: number;
  sheetName?: string;
  headerRow: number;
  endRow?: number;
}

export interface CompiledRule {
  sources: CompiledSource[];
  mappings: FieldMapping[];
}

const KIND_TO_TRANSFORM: Record<string, ValueTransform> = {
  coerce_cents: 'to-cents',
  coerce_date: 'normalize-date',
  coerce_string: 'trim',
  none: 'none',
};

export function compileRule(rule: RuleYaml): CompiledRule {
  const sources = rule.sources.map((s) => ({
    pattern: s.pattern,
    sheetIndex: s.sheetIndex,
    sheetName: s.sheetName,
    headerRow: s.headerRow,
    endRow: s.endRow,
  }));
  const mappings: FieldMapping[] = rule.fields
    .filter((f) => f.included !== false)
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      sourceHeader: f.sourceHeader,
      outputName: f.outputName,
      transform: KIND_TO_TRANSFORM[f.transforms?.[0]?.kind ?? 'none'] ?? 'none',
    }));
  return { sources, mappings };
}

/** 值转换 → 规则 transform kind(写规则用)。 */
export function transformToKind(t: ValueTransform): RuleTransformKind {
  switch (t) {
    case 'to-cents':
      return 'coerce_cents';
    case 'normalize-date':
      return 'coerce_date';
    case 'trim':
      return 'coerce_string';
    case 'none':
      return 'none';
  }
}
