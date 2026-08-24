// src/core/ingest/header-detect.ts
// 表头自动检测:在前 N 行中给每行打分,锁定「最像表头」的那一行。
// 表头通常是字符串标签(日期/借方/贷方),数据行多为数字或空。返回 0-based 行号;
// 找不到(最佳分=0,全是数字/空)返回 -1,交由人工输入。
import type { ParsedSheet } from './parser';

const DEFAULT_SCAN_ROWS = 10;

/** 给一行打分:字符串单元格 +2,其他非空 +1,纯数字/空 0。 */
export function scoreHeaderCandidate(row: unknown[]): number {
  let score = 0;
  for (const cell of row) {
    if (cell === null || cell === undefined) continue;
    const s = String(cell).trim();
    if (s === '') continue;
    if (/^-?\d+([.,]\d+)?$/.test(s)) continue; // 纯数字不像表头
    score += typeof cell === 'string' ? 2 : 1;
  }
  return score;
}

/** 在前 scanRows 行内返回得分最高的行号(0-based);找不到表头返回 -1。 */
export function detectHeaderRow(sheet: ParsedSheet, scanRows = DEFAULT_SCAN_ROWS): number {
  const limit = Math.min(scanRows, sheet.rows.length);
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < limit; i++) {
    const score = scoreHeaderCandidate(sheet.rows[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}
