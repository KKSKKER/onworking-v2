// src/core/lineage/lineage.ts
// 行级血缘:为每行追加来源列,可反查「这个数从哪份文件哪一行来」。
export interface LineageSource {
  sourceFile: string;
  sourceRow: number;
}

export const LINEAGE_COLUMNS = ['__source_file', '__source_row', '__extracted_at'] as const;

export function lineageColumnNames(): string[] {
  return [...LINEAGE_COLUMNS];
}

export function attachLineage(
  rows: Record<string, unknown>[],
  source: LineageSource,
  extractedAt: string,
): void {
  rows.forEach((row, i) => {
    row.__source_file = source.sourceFile;
    row.__source_row = source.sourceRow + i; // 行号从 sourceRow 递增
    row.__extracted_at = extractedAt;
  });
}
