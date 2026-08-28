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

/** 候选表头行:供 AI 判读的每行「可能是表头」的证据。rowNumber 为 1-based(与 headerRow 约定一致)。 */
export interface HeaderCandidate {
  rowNumber: number;
  /** scoreHeaderCandidate 得分(字符串密度)。 */
  score: number;
  /** 偏离值 = score − 基线(非空行得分众数):偏离越大越可能是表头。 */
  deviation: number;
  /** 行内容(字符串化,超长格截断),给 AI 看一眼。 */
  cells: string[];
}

export interface DetectCandidatesOptions {
  /** 绝对最低分(挡单格标题等弱行),默认 3。 */
  minScore?: number;
  /** 单格最长字符(含截断标记),默认 60。 */
  cellTruncate?: number;
}

/** 众数;并列取分数较大的那个(阈值更严、候选更少)。 */
function modeScore(scores: number[]): number {
  const counts = new Map<number, number>();
  for (const s of scores) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best = scores[0];
  let bestN = 0;
  for (const [s, n] of counts) {
    if (n > bestN || (n === bestN && s > best)) {
      best = s;
      bestN = n;
    }
  }
  return best;
}

/** 全表扫描列出「可能是表头」的行:裁尾部空行 → 逐行打分(跳过中间空行)→ 基线 = 非空行得分众数
 *  → 候选 = score≥minScore 且 score>基线 且 该分数出现≤2 次,按偏离降序。
 *  基线代表「常规数据行」的分数;表头是「稀有高分行」(同分的少数派),数据行同分会以 >2 次出现被排除。
 *  整表退化(无高于众数的稀有行,如全字符串)时返回空。 */
export function detectHeaderCandidates(
  sheet: ParsedSheet,
  opts: DetectCandidatesOptions = {},
): HeaderCandidate[] {
  const { minScore = 3, cellTruncate = 60 } = opts;
  const fullRows: unknown[][] = [sheet.headers, ...sheet.rows];

  // 裁尾部全空行
  const isEmpty = (r: unknown[]) => r.every((c) => c === null || c === undefined || String(c).trim() === '');
  let end = fullRows.length;
  while (end > 0 && isEmpty(fullRows[end - 1])) end--;

  const scored: { rowNumber: number; score: number; cells: string[] }[] = [];
  for (let i = 0; i < end; i++) {
    const row = fullRows[i];
    if (isEmpty(row)) continue; // 跳过中间空行(分隔两表的空行不参与打分)
    const cells = row.map((c) => {
      const s = c === null || c === undefined ? '' : String(c);
      return s.length > cellTruncate ? `${s.slice(0, cellTruncate - 1)}…` : s;
    });
    scored.push({ rowNumber: i + 1, score: scoreHeaderCandidate(row), cells });
  }
  if (scored.length === 0) return [];

  const mode = modeScore(scored.map((s) => s.score));
  const freq = new Map<number, number>();
  for (const s of scored) freq.set(s.score, (freq.get(s.score) ?? 0) + 1);

  return scored
    .map((s) => ({ ...s, deviation: s.score - mode }))
    .filter((c) => c.score >= minScore && c.score > mode && (freq.get(c.score) ?? 0) <= 2)
    .sort((a, b) => b.deviation - a.deviation || a.rowNumber - b.rowNumber);
}
