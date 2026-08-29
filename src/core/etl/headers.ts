// src/core/etl/headers.ts
// 重复表头统一编号命名(canonical header naming):
//   无重复 → 表头名保持裸名;有重复 → 按列序编号 姓名_1..N(1-based)。
//   全链路(预览/映射UI/导入/校验/模板/unusedHeaders)只认这一份规范化结果。
// 算法保证确定性、不覆盖任何名字(编号名与既有表头冲突时顺延)。

export interface CanonicalHeaders {
  /** 规范化后名字列表(与 raw 同长同序,元素唯一)。 */
  names: string[];
  /** 裸名 → 该组编号名(仅出现 >1 次的表头;如 姓名 → [姓名_1, 姓名_2, 姓名_3])。 */
  duplicateOf: Map<string, string[]>;
}

export function canonicalizeHeaders(raw: string[]): CanonicalHeaders {
  const count = new Map<string, number>();
  for (const h of raw) count.set(h, (count.get(h) ?? 0) + 1);
  const used = new Set<string>(raw);            // 已占用名:编号名不得与任何既有表头冲突
  const usedCount = new Map<string, number>();  // 每个重复组已分配到的编号
  const names: string[] = [];
  const duplicateOf = new Map<string, string[]>();
  for (const h of raw) {
    if ((count.get(h) ?? 0) <= 1) {
      names.push(h);
      continue;
    }
    let k = (usedCount.get(h) ?? 0) + 1;
    let candidate = `${h}_${k}`;
    while (used.has(candidate)) { k += 1; candidate = `${h}_${k}`; } // 冲突顺延
    usedCount.set(h, k);
    used.add(candidate);
    names.push(candidate);
    const list = duplicateOf.get(h) ?? [];
    list.push(candidate);
    duplicateOf.set(h, list);
  }
  return { names, duplicateOf };
}

export function resolveHeaderIndex(
  canonical: CanonicalHeaders,
  sourceHeader: string,
):
  | { kind: 'ok'; index: number | undefined }
  | { kind: 'duplicate-bare'; error: string } {
  const idx = canonical.names.indexOf(sourceHeader);
  if (idx !== -1) return { kind: 'ok', index: idx };
  const dup = canonical.duplicateOf.get(sourceHeader);
  if (dup && dup.length > 0) {
    return {
      kind: 'duplicate-bare',
      error: `源文件表头「${sourceHeader}」出现 ${dup.length} 次,映射 sourceHeader「${sourceHeader}」未指定编号。请在 YAML 写 ${dup.join(' / ')} 精确指定要映射的列。`,
    };
  }
  return { kind: 'ok', index: undefined }; // 名字不存在 → 宽容路径(缺列 → null)
}
