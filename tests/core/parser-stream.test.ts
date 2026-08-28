import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { readExcelSheetStream, parseExcelFile } from '../../src/core/ingest/parser';

let dir: string;
const F = (name: string): string => join(dir, name);

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ow-stream-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function makeXlsx(name: string, aoa: unknown[][], opts: { bookSST?: boolean } = {}): string {
  const ws = XLSX.utils.aoa_to_sheet(aoa as unknown[][]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const file = F(name);
  XLSX.writeFile(wb, file, opts);
  return file;
}

describe('readExcelSheetStream', () => {
  it('与 parseExcelFile 行数/表头/单元格完全一致(含内部空行→[]、尾部空行丢弃)', async () => {
    // 注意:XLSX.writeFile 默认内联字符串(无 sharedStrings.xml),走 XML 流式解析
    const file = makeXlsx('parity.xlsx', [
      ['科目', '金额'],
      ['工资', 100],
      ['', ''],
      ['报销', -5],
      ['', ''],
    ]);
    const a = parseExcelFile(file)[0];
    const s = await readExcelSheetStream(file);
    expect(s).not.toBeNull();
    expect(s!.sheetName).toBe('Sheet1');
    expect(s!.headers).toEqual(a.headers);
    const rows: unknown[][] = [];
    for await (const r of s!.rows) rows.push(r);
    expect(rows).toEqual(a.rows); // [[工资,100], [], [报销,-5]] —— 尾空行不入
  });

  it('headerRow(1 基)取指定行表头;多 sheet 按名定位;不存在返回 null;缺省取第一个', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['标题', '忽略'],
      ['date', 'debit'],
      ['2024-01', 1],
    ]), 'S1');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x'], [1]]), 'S2');
    const file = F('multi.xlsx');
    XLSX.writeFile(wb, file);
    const s = await readExcelSheetStream(file, 'S1', { headerRow: 2 });
    expect(s!.headers).toEqual(['date', 'debit']);
    const rows: unknown[][] = [];
    for await (const r of s!.rows) rows.push(r);
    expect(rows).toEqual([['2024-01', 1]]);
    expect(await readExcelSheetStream(file, 'NOPE')).toBeNull();
    const s0 = await readExcelSheetStream(file); // 缺省 → 第一个 sheet
    expect(s0!.sheetName).toBe('S1');
  });

  it('.xls 回退:SheetJS 同步读,行为与 parseExcelFile 一致', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name', 'score'],
      ['张三', 90],
      ['李四', 80],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = F('old.xls');
    XLSX.writeFile(wb, file, { bookType: 'xls' });
    const s = await readExcelSheetStream(file);
    expect(s).not.toBeNull();
    expect(s!.headers).toEqual(['name', 'score']);
    const rows: unknown[][] = [];
    for await (const r of s!.rows) rows.push(r);
    expect(rows).toEqual([['张三', 90], ['李四', 80]]);
  });

  it('共享字符串(bookSST)整条流式读不产生 U+FFFD(覆盖自研解码器)', async () => {
    // 必须 bookSST:默认内联字符串不走 sharedStrings 解码器,测不到共享字符串路径。
    // 7000×400 字符 ≈ 3MB,保证 unzipper 分块切在多字节中间(直击流式 TextDecoder)。
    const aoa: unknown[][] = [['科目']];
    for (let i = 0; i < 7000; i++) aoa.push([`第${i}行-管理费用/职工薪酬-${'值'.repeat(400)}`]);
    const file = makeXlsx('sst.xlsx', aoa, { bookSST: true });
    expect(readFileSync(file).includes(Buffer.from('sharedStrings.xml'))).toBe(true); // fixture 守卫
    const s = await readExcelSheetStream(file);
    let n = 0;
    for await (const r of s!.rows) {
      n++;
      expect(r[0]).toContain('管理费用/职工薪酬');
      expect(r[0]).not.toContain('�');
    }
    expect(n).toBe(7000);
  });
});
