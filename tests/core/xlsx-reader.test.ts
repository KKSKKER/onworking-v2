import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { parseExcelFile } from '../../src/core/ingest/parser';
import {
  CellError, RBErr, resolveCellValue, toOutputValue,
  openXlsxWorkbook, listWorkbookSheets, planSheetRange, readSheetRows,
} from '../../src/core/ingest/xlsx-reader';

let dir: string;
const F = (name: string): string => join(dir, name);

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ow-xlsx-reader-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function makeXlsx(name: string, aoa: unknown[][], opts: { bookSST?: boolean } = {}): string {
  const ws = XLSX.utils.aoa_to_sheet(aoa as unknown[][]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const file = F(name);
  XLSX.writeFile(wb, file, opts);
  return file;
}

/** 用自研读取器按 parseExcelFile 同口径产出 {headers, rows}(headerRow 1 基)。 */
async function readViaReader(file: string, headerRow = 1): Promise<{ headers: unknown[]; rows: unknown[][] }> {
  const headerRowIdx = headerRow - 1;
  const wb = await openXlsxWorkbook(file);
  const sheet = wb.byPath.get('xl/worksheets/sheet1.xml');
  expect(sheet).toBeDefined();
  const plan = await planSheetRange(sheet!, wb.sharedStrings, headerRowIdx);
  const gen = readSheetRows(sheet!, wb.sharedStrings, plan);
  const first = await gen.next();
  const headers = first.done ? [] : first.value.map((h) => String(h ?? '').trim());
  const rows: unknown[][] = [];
  for await (const r of gen) rows.push(r);
  return { headers, rows };
}

const norm = (v: unknown): unknown => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : v);

describe('resolveCellValue / toOutputValue', () => {
  it('逐类型与 SheetJS 语义一致', () => {
    expect(resolveCellValue('s', false, '0', ['中文'])).toBe('中文');
    expect(resolveCellValue('s', false, '', ['中文'])).toBe('');
    expect(resolveCellValue('s', false, '99', null)).toBe('');
    expect(resolveCellValue('str', false, 'hello', null)).toBe('hello');
    expect(resolveCellValue('b', false, '1', null)).toBe(true);
    expect(resolveCellValue('b', false, 'TRUE', null)).toBe(true);
    expect(resolveCellValue('b', false, '0', null)).toBe(false); // parsexmlbool:非 1/true/TRUE → false
    expect(resolveCellValue('b', false, 'false', null)).toBe(false);
    expect(resolveCellValue('e', false, '#DIV/0!', null)).toBeInstanceOf(CellError);
    expect((resolveCellValue('e', false, '#DIV/0!', null) as CellError).code).toBe(RBErr['#DIV/0!']);
    expect(resolveCellValue('e', false, '#NOT_A_CODE', null)).toBe('');
    expect(resolveCellValue('n', false, '12.5', null)).toBe(12.5);
    expect(resolveCellValue('n', false, '', null)).toBe('');
    expect(resolveCellValue('n', true, '内联串', null)).toBe('内联串'); // inlineStr
  });

  it('toOutputValue:错误码 0 → null,其余错误 → \'\'', () => {
    expect(toOutputValue(new CellError(0))).toBeNull();
    expect(toOutputValue(new CellError(7))).toBe('');
    expect(toOutputValue(3)).toBe(3);
    expect(toOutputValue('x')).toBe('x');
  });
});

describe('与 parseExcelFile 逐单元格一致', () => {
  it('基础数据 + 内部空行 + 尾部空行 + 布尔(默认内联字符串)', async () => {
    const file = makeXlsx('parity.xlsx', [
      ['科目', '金额', 'ok'],
      ['工资', 100, true],
      ['', '', ''],
      ['报销', -5, false],
      ['', '', ''],
    ]);
    const a = parseExcelFile(file)[0];
    const s = await readViaReader(file, 1);
    expect(s.headers).toEqual(a.headers);
    expect(s.rows).toEqual(a.rows); // [[工资,100,true], [], [报销,-5,false]] —— 尾空不入
  });

  it('错误单元格(错误码 0 / 7)与布尔混合:输出与 parseExcelFile 一致', async () => {
    // SheetJS writer 对 {t:'e', v:7} 写出 <c t="e"><v>#DIV/0!</v></c>(反查 RBErr 表),v:0 → #NULL!。
    // 读取方:SheetJS 用 RBErr[文本] 还原数值码并计入 dataBounds,输出时码 0 → null、其余 → '';
    // 自研读取器:CellError(码) → toOutputValue 同语义。两方逐格一致。
    const ws = XLSX.utils.aoa_to_sheet([
      ['科目', 'err', 'note'],
      ['工资', '', 'x'],
    ]);
    ws.B1 = { t: 'e', v: 7 }; // #DIV/0! → 表头格输出 ''
    ws.B2 = { t: 'e', v: 0 }; // #NULL! → 数据格输出 null(尾列 'x' 保它不被 trim 裁掉)
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = F('err.xlsx');
    XLSX.writeFile(wb, file);
    const a = parseExcelFile(file)[0];
    const s = await readViaReader(file, 1);
    expect(s.headers).toEqual(a.headers);
    expect(s.rows).toEqual(a.rows); // [[工资, null, 'x']]
  });

  it('listWorkbookSheets:多 sheet 按顺序返回名→路径', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a'], [1]]), '甲');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['b'], [2]]), '乙');
    const file = F('multi.xlsx');
    XLSX.writeFile(wb, file);
    const opened = await openXlsxWorkbook(file);
    const sheets = await listWorkbookSheets(opened.byPath);
    expect(sheets.map((s) => s.name)).toEqual(['甲', '乙']);
    expect(sheets[0].path).toBe('xl/worksheets/sheet1.xml');
    expect(sheets[1].path).toBe('xl/worksheets/sheet2.xml');
  });

  it('headerRow(1 基)取表头 + 行缺失 gap 用 [] 补齐', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['标题', '忽略'], ['date', 'debit'], ['2024-01', 1]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = F('hdr.xlsx');
    XLSX.writeFile(wb, file);
    const s = await readViaReader(file, 2);
    expect(s.headers).toEqual(['date', 'debit']);
    expect(s.rows).toEqual([['2024-01', 1]]);
  });

  it('bookSST 中文共享字符串整条流式读不产生 U+FFFD', async () => {
    // 7000×400 字符 ≈ 3MB,保证 unzipper 分块切在多字节字符中间,直击流式解码路径。
    const aoa: unknown[][] = [['科目']];
    for (let i = 0; i < 7000; i++) aoa.push([`第${i}行-管理费用/职工薪酬-${'值'.repeat(400)}`]);
    const file = makeXlsx('sst.xlsx', aoa, { bookSST: true });
    expect(readFileSync(file).includes(Buffer.from('sharedStrings.xml'))).toBe(true); // fixture 守卫
    const s = await readViaReader(file, 1);
    let n = 0;
    for (const r of s.rows) {
      n++;
      expect(norm(r[0])).toContain('管理费用/职工薪酬');
      expect(String(r[0])).not.toContain('�');
    }
    expect(n).toBe(7000);
  });
});
