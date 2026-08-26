import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { parseWorkbook, parseExcelFile, parseExcelSheet } from '../../src/core/ingest/parser';

describe('excel parser bounded range', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'parser-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('不会物化「格式蔓延」的假大范围(!ref 故意撑到百万行/万列也快速返回)', () => {
    const wb = XLSX.utils.book_new();
    // 真实数据:表头行 + 2 行
    const ws = XLSX.utils.aoa_to_sheet([['姓名', '金额'], ['张三', 100], ['李四', 200]]);
    // 模拟格式蔓延:把 !ref 撑到 100 万行 × 16383 列
    ws['!ref'] = 'A1:XFD1000000';
    XLSX.utils.book_append_sheet(wb, ws, '工资');

    const start = Date.now();
    const sheets = parseWorkbook(wb, { headerRow: 1 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // 快速返回,不能卡死
    expect(sheets).toHaveLength(1);
    expect(sheets[0].headers).toEqual(['姓名', '金额']);
    // 行数按真实数据范围返回(2 行),而不是 100 万行 —— 无上限也不物化假范围
    expect(sheets[0].rows.length).toBe(2);
  });

  it('parseExcelSheet 只解析指定 sheet', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), '目标');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x'], [9]]), '别的');
    const file = join(dir, 'multi.xlsx');
    XLSX.writeFile(wb, file);

    const sheet = parseExcelSheet(file, '目标', { headerRow: 1 });
    expect(sheet?.headers).toEqual(['a', 'b']);
    expect(sheet?.rows).toEqual([[1, 2]]);
    expect(parseExcelSheet(file, '不存在')).toBeUndefined();
  });
});
