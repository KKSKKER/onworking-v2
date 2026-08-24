// src/core/bigtable/schema.ts
// 大表模型:字段/类型/主键 + 配置校验。
// 类型直接用 SQLite 原生列类型(不用自造语义类型)。
export type FieldType = 'TEXT' | 'INTEGER' | 'REAL';

export interface BigTableField {
  name: string;
  type: FieldType;
  order: number;
  primaryKey?: boolean;
}

export interface BigTableConfig {
  tableName: string;
  fields: BigTableField[];
  autoIncrement: boolean;
}

/** 返回错误字符串数组;空数组 = 配置合法。 */
export function validateBigTableConfig(cfg: BigTableConfig): string[] {
  const errors: string[] = [];
  if (!cfg.tableName || !cfg.tableName.trim()) errors.push('tableName');
  if (!cfg.fields || cfg.fields.length === 0) errors.push('fields');
  return errors;
}
