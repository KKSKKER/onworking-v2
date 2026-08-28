# ETL 流式内存优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Excel 解析、clean 管线、CSV 导出、sql-clean 全链路改成真正流式,峰值内存与文件大小解耦(≤250MB),并给工作台查询加 5000 行自动封顶。

**Architecture:** 用自研读取器(unzipper 流式解压 + saxes 逐块 XML 解析)一行一行读 `.xlsx`(saxes 即 ExcelJS 内部解析器,流式 `TextDecoder` 从根上消除多字节 U+FFFD,无需补丁;行为与 SheetJS `parseExcelFile` 逐单元格精确对齐);clean-runner 从「全部物化 + 先 transform 后写库」改成「`produceRows()` async generator → `insertRowsInBatches` 边解析边写库」;CSV 导出改为 better-sqlite3 游标 + WriteStream 流式落盘;sql-clean 改为 `stmt.iterate()` + 5000 批事务。

**Tech Stack:** unzipper@^0.12.5 + saxes@^5.0.1(新增,均纯 JS,无原生绑定)、better-sqlite3(已有,`iterate()`/`stmt.columns()`)、xlsx 0.18.5(已有,.xls 回退)、vitest(已有)、Electron 31。

**Spec:** [2026-08-28-etl-streaming-memory-design.md](../specs/2026-08-28-etl-streaming-memory-design.md)(已提交 b47762587,权威依据)

## Global Constraints

以下约束逐字抄自 spec,每个任务的验收都隐含包含本节:

- **内存验收(关键):** 导入 207,508 行真实序时账文件全程峰值内存 **≤250MB**;sql-clean 处理同类大表 **<200MB**。低配 2 核 4 线程 / 8GB ThinkPad 上单文件导入墙钟时间 **≤60s**。
- **边界:**
  - 尾部空行:`rowEnd` 之后不产出(position 定位,非缓冲);内部空行 → `[]` 落库(gap-fill,与 parseExcelFile 一致)。孤值列与 SheetJS **精确一致**:count<2 的列不进 `effColCount`,孤值格被丢弃(orphan fixture 0 差异)。
  - `.xls`(BIFF):SheetJS `parseExcelFile` 回退,行为不变。
  - CRLF→LF 归一化:**已接受**(saxes 按 XML 1.0 把字面 CR 归一化为 LF,3770 格有差异,不预处理 `0x0D→&#13;`)。
- **正确性:** 所有中文字符串**禁止出现 U+FFFD**;写入行数与旧行为一致(207,508 行);全链路 `npm test` + `npm run typecheck` 通过。
- **查询封顶:** 工作台查询引擎 `queryOn` 对无 LIMIT 的 SELECT 自动注入 `LIMIT 5000`(语句自带 LIMIT 或显式传 limit 则不注入),并返回 `truncated` 标记;前端提示「结果已截断到 5000 行」。
- **导出:** CSV 导出流式(游标逐行写盘),**不封顶、不物化、不逐行 JSON over IPC**;前端通过保存对话框选路径。
- **依赖:** 仅新增 `unzipper`(pin `^0.12.5`)+ `saxes`(pin `^5.0.1`),均纯 JS。unzipper 无类型声明,**必须**补 `src/types/unzipper.d.ts`,否则 typecheck 红。
- **sql-clean:** 保留 DROP+重建 resultTable、ATTACH/DETACH、`main."…"` 限定、**空结果集建 `(empty INTEGER)` 行为**。
- **提交规范:** 每个任务一个语义化 commit(feat/fix/chore/test),英文或中文均可,必须能对应到本计划的验收标准。

---

### Task 1: 自研 `.xlsx` 流式读取器 xlsx-reader.ts(unzipper + saxes)

**Files:**
- Modify: `package.json`(dependencies 加 `"unzipper": "^0.12.5"`、`"saxes": "^5.0.1"`)
- Create: `src/types/unzipper.d.ts`(unzipper 无类型声明,补子集)
- Create: `src/core/ingest/xlsx-reader.ts`(自研读取器,核心资产)
- Test: `tests/core/xlsx-reader.test.ts`(新文件)

**Interfaces:**
- Consumes: 无
- Produces(供 Task 2 `readExcelSheetStream` 消费):
  - `RBErr: Record<string, number>` —— SheetJS 错误文本→数值码表
  - `class CellError { constructor(public readonly code: number) }` —— 公式错误格
  - `toOutputValue(v: unknown): unknown` —— 错误码 0(#NULL!)→ `null`,其余错误 → `''`
  - `resolveCellValue(t, isInline, raw, sharedStrings): unknown` —— 逐类型复刻 SheetJS
  - `trimTrailingEmpty(arr: unknown[]): unknown[]`
  - `interface SheetPlan { headerAbs: number; rowEnd: number; effColCount: number }`
  - `interface XlsxWorkbook { byPath: Map<string, Entry>; sharedStrings: string[] | null }`
  - `openXlsxWorkbook(filePath: string): Promise<XlsxWorkbook>`
  - `listWorkbookSheets(byPath: Map<string, Entry>): Promise<{ name: string; path: string }[]>` —— 解析 `xl/workbook.xml` + rels,按顺序返回 sheet 名→工作表 XML 路径(Task 2 按名定位用)
  - `scanSheetRows(entry, sharedStrings, onDimension?): AsyncGenerator<{rowIdx, cells}>`
  - `planSheetRange(entry, sharedStrings, headerRowIdx): Promise<SheetPlan>`
  - `readSheetRows(entry, sharedStrings, plan): AsyncGenerator<unknown[]>`

**背景(为什么是自研,为什么现在已稳):** 旧方案依赖 ExcelJS 4.4.0 `WorkbookReader`,需 postinstall 打 `{stream:true}` 解码补丁才能避免多字节切裂 U+FFFD,且 spike 实测其在 SheetJS 写的文件上崩溃。改为自研 `unzip+saxes` 读取器:saxes 正是 ExcelJS 内部用的 XML 解析器,读取器以 `TextDecoder.decode(chunk, {stream:true})` 逐块喂入,块边界永不切裂多字节字符,U+FFFD 从机制上消除,**不碰 node_modules、无补丁**。本设计已用 `%TEMP%\final-design-verify.js` 全量验证:11 个 fixture(含 207,508 行真文件、前导空行 dimRowStart>0、行缺失 gap、孤值列、错误/布尔单元格、单格 dimension)与旧 `parseExcelFile` **全 0 差异**(CRLF→LF 归一化后);`%TEMP%\measure-final.js` 实测 3.2s / 最终堆 19.1MB。本任务把该已验证代码正式落为仓库模块 + 测试。**行为契约(必须逐字实现,已实证):** 旧 parseExcelFile 是**位置化**的——`buildRange` 裁出 `[s.r, rowEnd]×[s.c, colEnd]` 后 `sheet_to_json` 逐格产出(空行 = defval 数组),再 `slice(headerRowIdx+1)` 裁剪;本读取器用 `planSheetRange`(复刻 buildRange)+ `readSheetRows`(positional gap-fill)精确复刻。

- [ ] **Step 1: 装依赖 unzipper + saxes**

`unzipper@0.12.5` 已随 app-builder-lib 传递装在 `node_modules`(project-lock 已含),只差升为直接依赖;`saxes` 需全新装。手工把下面两行加进 `package.json` 的 `dependencies`(手动编辑):

```json
"unzipper": "^0.12.5",
"saxes": "^5.0.1"
```

然后(若 `npm install` 在 `better-sqlite3-electron@11.10.0` 私源上 404,走下面的隔离目录回退):

```bash
mkdir -p $TEMP/ow-xlsx-install && cd $TEMP/ow-xlsx-install
npm init -y
npm install saxes@5.0.1 --no-save
```

把装好的 saxes 拷进项目并验证(Windows Git Bash;PowerShell 用 `Copy-Item -Recurse $TEMP/ow-xlsx-install/node_modules/saxes d:/Jeffrey/onworking-v2/node_modules/`):

```bash
cp -r node_modules/saxes /d/Jeffrey/onworking-v2/node_modules/saxes
cd /d/Jeffrey/onworking-v2
node -e "console.log('unzipper', require('unzipper/package.json').version, '| saxes', require('saxes/package.json').version)"
```

Expected: `unzipper 0.12.5 | saxes 5.0.1`(unzipper 已在 node_modules,无需动作;saxes 5.0.1 自带 `saxes.d.ts`,开箱有类型)。若后续某次正常 `npm install` 成功,`package-lock.json` 会补齐 saxes 条目;本次锁未更新也没关系,以 node_modules 实装为准。

- [ ] **Step 2: 写类型声明 `src/types/unzipper.d.ts`**

unzipper 的 `package.json` 是 `types: NONE`,必须补声明否则 typecheck 红。本项目只用 `Open.file` → `dir.files[]` → `entry.stream()/buffer()` 子集;tsconfig `include: ["src"]` 会自动收录 `src/types/*.d.ts`:

```ts
// src/types/unzipper.d.ts
// unzipper@0.12.5 无类型声明,声明本项目用到的子集(Open.file → files[] → stream/buffer)。
declare module 'unzipper' {
  export interface Entry {
    path: string;
    type: 'File' | 'Directory';
    stream(): NodeJS.ReadableStream;
    buffer(): Promise<Buffer>;
  }
  export interface CentralDirectory {
    files: Entry[];
  }
  export const Open: {
    file(filePath: string): Promise<CentralDirectory>;
  };
}
```

- [ ] **Step 3: 写失败测试 `tests/core/xlsx-reader.test.ts`**

```ts
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
      expect(String(r[0])).not.toContain('\uFFFD');
    }
    expect(n).toBe(7000);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run tests/core/xlsx-reader.test.ts`
Expected: FAIL(`xlsx-reader` 模块不存在,Cannot find module)。

- [ ] **Step 5: 实现 `src/core/ingest/xlsx-reader.ts`**

```ts
// src/core/ingest/xlsx-reader.ts
// 自研 .xlsx 流式读取器:unzipper 流式解压 + saxes 逐块 XML 解析。
// 目标:峰值内存与文件大小解耦(工作表 XML 逐块消费,从不整份物化)。
// 正确性:与 SheetJS parseExcelFile 逐单元格精确对齐(11 fixture 全 0 差异,含 207,508 行真文件)。
// 已验收的边界算法(勿改):planSheetRange 复刻 dataBounds+buildRange;readSheetRows 为
// positional gap-fill(缺失 <row> → [],到达 rowEnd 即断,尾空不产出)。
import { Open, type Entry } from 'unzipper';
import { SaxesParser } from 'saxes';
import { TextDecoder } from 'node:util';

/** SheetJS RBErr:错误文本 → 数值错误码(parse_ws_xml_data 的 p.v)。 */
export const RBErr: Record<string, number> = {
  '#NULL!': 0,
  '#DIV/0!': 7,
  '#VALUE!': 15,
  '#REF!': 23,
  '#NAME?': 29,
  '#NUM!': 36,
  '#N/A': 42,
  '#GETTING_DATA': 43,
  '#WTF?': 255,
};

/** 公式错误单元格:dataBounds 按数值码计数(非空),输出时码 0 → null、其余 → ''(SheetJS 双态)。 */
export class CellError {
  constructor(public readonly code: number) {}
}

/** 单元格 → 输出值:CellError 码 0(#NULL!)→ null,其余错误 → '';其余原样。 */
export function toOutputValue(v: unknown): unknown {
  return v instanceof CellError ? (v.code === 0 ? null : '') : v;
}

/** 裁剪尾部空单元格(与 parser.ts 同语义,避免循环依赖故本地一份)。 */
export function trimTrailingEmpty(arr: unknown[]): unknown[] {
  let end = arr.length;
  while (end > 0 && (arr[end - 1] === '' || arr[end - 1] === null || arr[end - 1] === undefined)) end--;
  return arr.slice(0, end);
}

/** 列名 → 0 基列号('A'→0)。 */
function colsFromRef(ref: string): number {
  let c = 0;
  for (let i = 0; i < ref.length && ref[i] >= 'A' && ref[i] <= 'Z'; i++) c = c * 26 + (ref.charCodeAt(i) - 64);
  return c - 1;
}

/** 单元格原始值解析:逐类型复刻 SheetJS(parse_ws_xml_data / parsexmlbool / RBErr)。 */
export function resolveCellValue(
  t: string,
  isInline: boolean,
  raw: string,
  sharedStrings: string[] | null,
): unknown {
  if (isInline) return raw;
  switch (t) {
    case 's': return raw === '' ? '' : (sharedStrings ? sharedStrings[Number(raw)] : '') ?? '';
    case 'str': return raw;
    case 'b': return raw === '1' || raw === 'TRUE' || raw === 'true';
    case 'e': return Object.prototype.hasOwnProperty.call(RBErr, raw) ? new CellError(RBErr[raw]) : '';
    default: return raw === '' ? '' : parseFloat(raw);
  }
}

export interface Dimension {
  rowStart: number; // 0 基
  rowEnd: number;   // 0 基(含)
  colEnd: number;   // 0 基(含)
}

export interface SheetPlan {
  headerAbs: number;   // 表头 0 基物理行号 = dim.rowStart + headerRowIdx
  rowEnd: number;      // 数据末尾 0 基物理行号(含)
  effColCount: number; // 输出列数 = min(dim.colEnd, realCol) + 1
}

interface ScanRow { rowIdx: number; cells: unknown[]; }

/** 工作表 XML → saxes 事件 → queue(每行一个 {rowIdx, cells},cells 为稀疏数组,holes 即缺失列)。 */
function buildSheetParser(
  sharedStrings: string[] | null,
  onDimension: (d: Dimension) => void,
  queue: ScanRow[],
): SaxesParser {
  let rowIdx = -1;
  let curRow: unknown[] | null = null;
  let curCol = -1;
  let curT = 'n';
  let curV = '';
  let hasIs = false;
  let curIs = '';
  let vInProgress = false;
  const p = new SaxesParser();
  p.on('opentag', (t) => {
    if (t.name === 'dimension' && t.attributes.ref) {
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(String(t.attributes.ref));
      if (m) {
        const colStart = colsFromRef(m[1]);
        const rowStart = Number(m[2]) - 1;
        const colEnd = m[3] !== undefined ? colsFromRef(m[3]) : colStart;
        const rowEnd = m[4] !== undefined ? Number(m[4]) - 1 : rowStart;
        onDimension({ rowStart, rowEnd, colEnd });
      }
    } else if (t.name === 'row') {
      const r = t.attributes.r;
      rowIdx = r !== undefined ? Number(r) - 1 : rowIdx + 1;
      curRow = [];
    } else if (t.name === 'c') {
      curCol = colsFromRef(String(t.attributes.r ?? 'A'));
      curT = String(t.attributes.t ?? 'n');
      curV = '';
      hasIs = false;
      curIs = '';
      vInProgress = false;
    } else if (t.name === 'v') {
      vInProgress = true;
    } else if (t.name === 'is') {
      hasIs = true;
    } else if (t.name === 't' && hasIs) {
      vInProgress = true;
    }
  });
  p.on('text', (tx) => {
    if (vInProgress) {
      if (hasIs) curIs += tx;
      else curV += tx;
    }
  });
  p.on('closetag', (t) => {
    const name = t.name;
    if (name === 'v') vInProgress = false;
    else if (name === 't' && hasIs) vInProgress = false;
    else if (name === 'c') {
      if (curRow && curCol >= 0) curRow[curCol] = resolveCellValue(curT, hasIs, hasIs ? curIs : curV, sharedStrings);
      curCol = -1;
      hasIs = false;
    } else if (name === 'row') {
      if (curRow) {
        queue.push({ rowIdx, cells: curRow });
        curRow = null;
      }
    }
  });
  p.on('error', (e) => {
    throw e;
  });
  return p;
}

/** 逐块流式扫工作表 XML,产出每行 {rowIdx, cells}。拉式:消费方 next() 才读下一块(天然背压)。 */
export async function* scanSheetRows(
  entry: Entry,
  sharedStrings: string[] | null,
  onDimension?: (d: Dimension) => void,
): AsyncGenerator<ScanRow> {
  const decoder = new TextDecoder('utf-8');
  const st = entry.stream();
  const queue: ScanRow[] = [];
  const p = buildSheetParser(sharedStrings, onDimension ?? (() => {}), queue);
  const it = st[Symbol.asyncIterator]();
  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as ScanRow;
        continue;
      }
      const { value, done } = await it.next();
      if (done) break;
      p.write(decoder.decode(value, { stream: true }));
    }
    p.write(decoder.decode());
    p.close();
    while (queue.length > 0) yield queue.shift() as ScanRow;
  } finally {
    st.destroy();
  }
}

export interface XlsxWorkbook {
  byPath: Map<string, Entry>;
  sharedStrings: string[] | null;
}

/** 打开 .xlsx:unzipper 解中央目录(zip 路径归一化 \\→/ 兼容 Compress-Archive/WinRAR),收集共享字符串(如有)。 */
export async function openXlsxWorkbook(filePath: string): Promise<XlsxWorkbook> {
  const dir = await Open.file(filePath);
  const byPath = new Map<string, Entry>(dir.files.map((f) => [f.path.replace(/\\/g, '/'), f]));
  const ssFile = byPath.get('xl/sharedStrings.xml');
  let sharedStrings: string[] | null = null;
  if (ssFile) {
    sharedStrings = [];
    let cur: string | null = null;
    let inT = false;
    const p = new SaxesParser();
    p.on('opentag', (t) => {
      if (t.name === 'si') cur = '';
      else if (t.name === 't') inT = true;
    });
    p.on('closetag', (t) => {
      if (t.name === 'si') {
        sharedStrings?.push(cur ?? '');
        cur = null;
      } else if (t.name === 't') {
        inT = false;
      }
    });
    p.on('text', (tx) => {
      if (inT && cur !== null) cur += tx; // 多 run <r><t> 自动拼接
    });
    const d = new TextDecoder('utf-8');
    const buf = await ssFile.buffer();
    p.write(d.decode(buf));
    p.close();
  }
  return { byPath, sharedStrings };
}

/** 解析 xl/workbook.xml + _rels/workbook.xml.rels,按顺序返回 sheet 名 → 工作表 XML 路径(相对 zip 根)。 */
export async function listWorkbookSheets(
  byPath: Map<string, Entry>,
): Promise<{ name: string; path: string }[]> {
  const sheets: { name: string; path: string }[] = [];
  const wbXml = byPath.get('xl/workbook.xml');
  if (!wbXml) return sheets;
  const rels = new Map<string, string>();
  const relsFile = byPath.get('xl/_rels/workbook.xml.rels');
  if (relsFile) {
    const p = new SaxesParser();
    p.on('opentag', (t) => {
      if (t.name === 'Relationship' && t.attributes.Id && t.attributes.Target) {
        rels.set(String(t.attributes.Id), String(t.attributes.Target));
      }
    });
    const d = new TextDecoder('utf-8');
    p.write(d.decode(await relsFile.buffer()));
    p.close();
  }
  const p = new SaxesParser();
  p.on('opentag', (t) => {
    if (t.name === 'sheet') {
      const name = String(t.attributes.name ?? '');
      const rid = t.attributes['r:id'] !== undefined ? String(t.attributes['r:id']) : '';
      const target = rels.get(rid);
      const path = target
        ? target.replace(/\\/g, '/').replace(/^\/+/, '') // rels Target 相对 xl/,去前导斜杠/反斜杠
        : `xl/worksheets/sheet${sheets.length + 1}.xml`; // 无 r:id 时的回退(按 sheet 顺序)
      sheets.push({ name, path: /^xl\//.test(path) ? path : `xl/${path}` });
    }
  });
  const d = new TextDecoder('utf-8');
  p.write(d.decode(await wbXml.buffer()));
  p.close();
  return sheets;
}

/** 第一遍:流式统计 maxRow/maxCol + 捕获 dimension,复刻 SheetJS buildRange 得 SheetPlan。 */
export async function planSheetRange(
  entry: Entry,
  sharedStrings: string[] | null,
  headerRowIdx: number,
): Promise<SheetPlan> {
  const colCount = new Map<number, number>();
  let maxRow = -1;
  let dim: Dimension | null = null;
  for await (const { rowIdx, cells } of scanSheetRows(entry, sharedStrings, (d) => { dim = d; })) {
    for (let c = 0; c < cells.length; c++) {
      const v = cells[c];
      if (v === '' || v === undefined || v === null) continue;
      if (rowIdx > maxRow) maxRow = rowIdx;
      colCount.set(c, (colCount.get(c) ?? 0) + 1);
    }
  }
  let maxCol = -1;
  for (const [c, n] of colCount) if (n >= 2 && c > maxCol) maxCol = c;
  const realRow = Math.max(maxRow, headerRowIdx);
  const rowEnd = dim ? Math.min(dim.rowEnd, realRow) : realRow;
  const realCol = maxCol >= 0 ? maxCol : (dim ? dim.colEnd : -1);
  const colEnd = dim ? Math.min(dim.colEnd, realCol) : realCol;
  const headerAbs = (dim ? dim.rowStart : 0) + headerRowIdx;
  return { headerAbs, rowEnd, effColCount: colEnd + 1 };
}

/** 第二遍:positional gap-fill 输出。产出 headerAbs..rowEnd 全部物理行;缺失行 → [];到达 rowEnd 即断。 */
export async function* readSheetRows(
  entry: Entry,
  sharedStrings: string[] | null,
  plan: SheetPlan,
): AsyncGenerator<unknown[]> {
  const { headerAbs, rowEnd, effColCount } = plan;
  const capPad = (cells: unknown[]): unknown[] => {
    const row: unknown[] = [];
    for (let c = 0; c < effColCount; c++) row.push(c < cells.length && cells[c] !== undefined ? toOutputValue(cells[c]) : '');
    return row;
  };
  let pos = 0;
  for await (const { rowIdx, cells } of scanSheetRows(entry, sharedStrings)) {
    if (rowIdx > rowEnd) break;
    for (; pos < rowIdx && pos <= rowEnd; pos++) {
      if (pos === headerAbs || pos > headerAbs) yield [];
    }
    const row = capPad(cells);
    if (rowIdx >= headerAbs) yield trimTrailingEmpty(row);
    pos = rowIdx + 1;
  }
  for (; pos <= rowEnd; pos++) {
    if (pos === headerAbs || pos > headerAbs) yield [];
  }
}
```

> **实现要点(为什么这样写):**
> 1. **两遍读,都流式**:`planSheetRange` 先全表扫一遍算 `rowEnd/effColCount/headerAbs`(复刻 `dataBounds`+`buildRange`);`readSheetRows` 再扫一遍定位输出。两遍各自逐块拉流,堆里从无整份 XML。
> 2. **positional gap-fill(核心)**:旧 parseExcelFile 是位置化的——`sheet_to_json({range, defval:''})` 对 range 内每个物理位置都产出(缺失 `<row>` → 空数组),再 `slice(headerRowIdx+1)`。`readSheetRows` 的 `pos` 游标逐物理行推进,缺的用 `yield []` 补齐;`rowEnd` 之后不产出(尾空丢弃);行宽按 `effColCount` 截/补 `''` 再 `trimTrailingEmpty`(与旧版一致)。
> 3. **错误/布尔单元格**:SheetJS 对 `t="e"` 的错误格在 dataBounds 里**计数**(v=数值码非空)但在输出行时**码 0 → null、其余 → ''**。`resolveCellValue` 产 `CellError(码)` 满足计数,`toOutputValue` 在输出时转换——两处各司其职。
> 4. **CRLF→LF**:saxes 按 XML 1.0 把字面 CR 归一化为 LF,与旧 ExcelJS 方案同源;parity 测试的 `norm` 只对 string 值归一化(真文件 3770 格差异已由 spec 接受,不做字节复刻)。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/core/xlsx-reader.test.ts`
Expected: 7 个 `it` 全 PASS(解析速度:7000 行 bookSST 用例 <10s)。

- [ ] **Step 7: typecheck**

Run: `npm run typecheck`
Expected: 无错误(重点验证 `src/types/unzipper.d.ts` 被收录、saxes 类型化 `on('opentag')` handler 通过)。

- [ ] **Step 8: 真实文件 parity 复核(手工,强烈建议)**

用 207,508 行真文件把读取器与旧 `parseExcelFile` 全量对比(复制到 `%TEMP%\verify-reader.ts`,`npx tsx` 运行):

```ts
import { parseExcelFile } from '../d:/Jeffrey/onworking-v2/src/core/ingest/parser';
import { openXlsxWorkbook, planSheetRange, readSheetRows } from '../d:/Jeffrey/onworking-v2/src/core/ingest/xlsx-reader';
const f = 'D:/Jeffrey/onworking-v2/workspaces/特瑞药业/.onworking/bigtables/seq/source/特瑞序时账24-2603.xlsx';
const norm = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : v);
const a = parseExcelFile(f)[0];
const wb = await openXlsxWorkbook(f);
const plan = await planSheetRange(wb.byPath.get('xl/worksheets/sheet1.xml')!, wb.sharedStrings, 0);
const gen = readSheetRows(wb.byPath.get('xl/worksheets/sheet1.xml')!, wb.sharedStrings, plan);
const first = await gen.next();
const hdr = first.done ? [] : first.value.map((h) => String(h ?? '').trim());
if (hdr.length !== a.headers.length || hdr.some((h, i) => h !== a.headers[i])) throw new Error('HEADERS DIFF');
let i = 0;
for await (const r of gen) {
  const o = a.rows[i++];
  if (!o || r.length !== o.length || r.some((v, c) => norm(v) !== norm(o[c]))) throw new Error(`ROW ${i} DIFF`);
}
if (i !== a.rows.length) throw new Error(`COUNT ${i} vs ${a.rows.length}`);
console.log(`OK: ${a.headers.length} headers, ${i} rows, 0 差异`);
```

Expected: `OK: N headers, 207508 rows, 0 差异`。此步是「行为不变」的最终背书,做完再提交。

- [ ] **Step 9: 提交**

```bash
git add package.json src/types/unzipper.d.ts src/core/ingest/xlsx-reader.ts tests/core/xlsx-reader.test.ts
git commit -m "feat(ingest): 自研 .xlsx 流式读取器 xlsx-reader(unzip+saxes,与 parseExcelFile 逐单元格一致)"
```

---

### Task 2: parser 新增流式解析 `readExcelSheetStream`(委托自研读取器)

**Files:**
- Modify: `src/core/ingest/parser.ts`(追加,不动现有导出)
- Test: `tests/core/parser-stream.test.ts`(新文件;测试文件路径是**扁平**的 `tests/core/`,不是 `tests/core/ingest/`)

**Interfaces:**
- Consumes: Task 1(`openXlsxWorkbook` / `listWorkbookSheets` / `planSheetRange` / `readSheetRows`)
- Produces:
  - `interface SheetRowStream { sheetName: string; headers: string[]; rows: AsyncGenerator<unknown[]> }`
  - `async function readExcelSheetStream(filePath: string, sheetName?: string, opts?: { headerRow?: number }): Promise<SheetRowStream | null>` —— sheet 不存在返回 `null`;`.xls` 走 SheetJS 同步回退包装。
  - **`opts.headerRow` 是 1 基**(与 parser 既有 `ParseOptions` 一致):内部转 `headerRowIdx = (opts.headerRow ?? 1) - 1`。`headers` 为该行 trim 后的字符串数组(该行空 → `[]`)。
  - 私有细节: `sheetStreamFromAoa(sheetName, headers, rows)`(.xls 回退包装)。

**流式边界算法(parser 不再实现,全部由 Task 1 读取器保证):**
- `.xlsx`:`planSheetRange` 复刻 `dataBounds` + `buildRange`(行/列边界、孤值列、`<dimension>` 取小);`readSheetRows` 做 positional gap-fill(内部空行/行缺失 → `[]`,`rowEnd` 之后不产出 = 尾空丢弃)。parser 只是「按名定位 → 拿 entry → 两遍读 → 消费表头」,不再有 pending/blankCount 或迭代器单例这类逻辑。
- sheet 定位:`listWorkbookSheets` 解析 `xl/workbook.xml` + `_rels/workbook.xml.rels` 得 sheet 名→路径;`sheetName` 缺省取第一个;找不到返回 `null`。

- [ ] **Step 1: 写失败测试 `tests/core/parser-stream.test.ts`**

```ts
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
      expect(r[0]).not.toContain('\uFFFD');
    }
    expect(n).toBe(7000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/parser-stream.test.ts`
Expected: FAIL(`readExcelSheetStream` 未定义)。

- [ ] **Step 3: 在 `src/core/ingest/parser.ts` 追加实现**

顶部加 `import { openXlsxWorkbook, listWorkbookSheets, planSheetRange, readSheetRows } from './xlsx-reader';`(同目录相对导入)。在文件末尾追加:

```ts
/** 流式解析产出的一行:headers 为指定 headerRow 行的表头,rows 为逐行异步生成器。 */
export interface SheetRowStream {
  sheetName: string;
  headers: string[];
  rows: AsyncGenerator<unknown[]>;
}

/** 把已物化的 aoa(headers + rows,首行为表头)包装成同构流(用于 .xls 回退)。 */
function sheetStreamFromAoa(sheetName: string, headers: string[], rows: unknown[][]): SheetRowStream {
  async function* gen(): AsyncGenerator<unknown[]> {
    for (const r of rows) yield r;
  }
  return { sheetName, headers, rows: gen() };
}

/**
 * 流式解析 Excel 文件的一个 sheet。
 * - .xlsx:自研读取器 openXlsxWorkbook → listWorkbookSheets 按名定位(缺省第一 sheet)
 *          → planSheetRange(复刻 dataBounds+buildRange)→ readSheetRows(positional gap-fill)。
 *          边界(尾空丢弃 / 内部空行 [] / 行缺失 gap [] / 孤值列与 SheetJS 一致)全部由 Task 1 读取器保证。
 * - .xls:SheetJS 同步读后包装成同构流(行为与 parseExcelFile 一致)
 * - sheet 不存在:返回 null
 * headerRow 为 1 基(与 ParseOptions 一致)。
 */
export async function readExcelSheetStream(
  filePath: string,
  sheetName?: string,
  opts: { headerRow?: number } = {}
): Promise<SheetRowStream | null> {
  const headerRowIdx = (opts.headerRow ?? 1) - 1;
  const isXls = /\.xls$/i.test(filePath);
  if (isXls) {
    const sheets = parseExcelFile(filePath, { headerRow: headerRowIdx + 1 });
    const sheet = sheetName ? sheets.find((s) => s.sheetName === sheetName) : sheets[0];
    if (!sheet) return null;
    return sheetStreamFromAoa(sheet.sheetName, sheet.headers, sheet.rows);
  }

  const wb = await openXlsxWorkbook(filePath);
  const list = await listWorkbookSheets(wb.byPath);
  const target = sheetName ? list.find((s) => s.name === sheetName) : list[0];
  if (!target) return null;
  const entry = wb.byPath.get(target.path);
  if (!entry) return null;
  const plan = await planSheetRange(entry, wb.sharedStrings, headerRowIdx);
  const gen = readSheetRows(entry, wb.sharedStrings, plan);
  const first = await gen.next();
  const headers = first.done ? [] : first.value.map((h) => String(h ?? '').trim());
  return { sheetName: target.name, headers, rows: gen };
}
```

> **实现要点(为什么这样写):**
> 1. **parser 不再实现任何边界算法**:`planSheetRange`(复刻 `dataBounds`+`buildRange`)与 `readSheetRows`(positional gap-fill)是 Task 1 已全量验证的读取器,parser 只做「按名定位 → 两遍读 → 消费表头」。旧方案的 pending/blankCount、单迭代器、`row.values[0]` 占位符等坑随 ExcelJS 一并消失。
> 2. **按名定位**:`listWorkbookSheets` 解析 `xl/workbook.xml` + `_rels/workbook.xml.rels` 得 sheet 名→路径;`sheetName` 缺省取第一个;找不到 → `null`。
> 3. **表头预取即消费生成器头**:`readSheetRows` 先产出表头行(物理行 `headerAbs`),`await gen.next()` 消费它得到 `headers`(trim 后),把剩余生成器直接交还调用方逐行迭代——单生成器贯穿,无缝衔接,不重复产出表头。
> 4. **`.xls` 回退**:`parseExcelFile` 同步读后包 `sheetStreamFromAoa`,API 形状一致;峰值不封顶(已知限制)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/parser-stream.test.ts`
Expected: 4 个用例全 PASS。

- [ ] **Step 5: 跑既有 parser 测试确认无回归**

Run: `npx vitest run tests/core/parser.test.ts`
Expected: PASS(现有 `parseExcelFile/parseCsvFile` 未动)。

- [ ] **Step 6: 提交**

```bash
git add src/core/ingest/parser.ts tests/core/parser-stream.test.ts
git commit -m "feat(parser): readExcelSheetStream 流式解析(.xlsx 自研读取器 / .xls SheetJS 回退)"
```

---

### Task 3: 逐行 transform + 批写基础设施

**Files:**
- Modify: `src/core/etl/transform.ts`(追加 `buildColIndex`/`applyMappingRow`,现有 `applyMapping` 委托复用)
- Modify: `src/core/etl/writer.ts`(抽出 `insertRowsInBatches`,`writeBigTable` 委托)
- Test: `tests/core/etl-stream.test.ts`(新文件;**扁平路径**,不是 `tests/core/etl/etl-stream.test.ts`)

**Interfaces:**
- Consumes: 无外部(纯自身改造)
- Produces:
  - `function buildColIndex(headers: string[]): Map<string, number>` —— 末次出现位置(与现有 `applyMapping` 的 `colIndex` 构建一致:遍历时后者覆盖前者)。
  - `function applyMappingRow(row: unknown[], colIndex: Map<string, number>, mappings: FieldMapping[]): TransformedRow` —— 与现有 `applyMapping` 的逐行逻辑**完全一致**:`const ci = colIndex.get(m.sourceHeader); const raw = ci === undefined ? undefined : row[ci]; out[m.outputName] = applyTransform(raw, m.transform)`。**`applyTransform` 只收 2 个参数**(`v, transform`),没有第 3 个 outputName 参数。
  - `async function insertRowsInBatches(db: Database.Database, tableName: string, colDefs: ColumnDef[], rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>, opts?: { dropExisting?: boolean; onBatch?: (inserted: number) => void }): Promise<WriteResult>` —— `WriteResult {tableName, rowsInserted}`;`dropExisting` 时 DROP+createTableIfNotExists;内部 `BATCH_SIZE=5000`、`insertBatch`、**失败必须 `throw captureError(err, {module:'etl/writer', code:'ETL_INSERT_FAILED', message:'insert batch failed for table ${tableName}', data:{table: tableName, batchStart: inserted}})`**(不能 catch-and-continue——既有 etl.test.ts 要求 writeBigTable 对失败 insert **rejects**)、每个 batch 后 `setImmediate`;`onBatch` 每批回调**累计**已插入数。
  - 既有 `writeBigTable` 签名与进度语义**保持不变**(委托 `insertRowsInBatches`;`onProgress` 每批回调 `{insertedRows: inserted, totalRows: rows.length, percent: rows.length===0 ? 100 : Math.round(inserted/rows.length*100)}`)。

- [ ] **Step 1: 写失败测试 `tests/core/etl-stream.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { buildColIndex, applyMappingRow, type FieldMapping } from '../../src/core/etl/transform';
import { insertRowsInBatches } from '../../src/core/etl/writer';
import { openDatabase } from '../../src/core/db/database';
import { logger } from '../../src/core/logging';
import { arraySink } from '../../src/core/logging/sinks';
import type { LogEntry } from '../../src/core/logging/logger';

const MAPPINGS: FieldMapping[] = [
  { sourceHeader: 'date', outputName: 'date', transform: 'normalize-date' },
  { sourceHeader: 'debit', outputName: 'debit', transform: 'to-cents' },
  { sourceHeader: '备注', outputName: 'note', transform: 'none' },
];

describe('applyMappingRow', () => {
  it('与 applyMapping 的逐行逻辑一致(transform 应用、缺列→null)', () => {
    const headers = ['date', 'debit', '备注'];
    const row = ['2024-01-15', '100.00', '报销  "a,b"'];
    const single = applyMappingRow(row, buildColIndex(headers), MAPPINGS);
    expect(single).toEqual({
      date: '2024-01-15',
      debit: 10000,
      note: '报销  "a,b"',
    });
    // 缺列:sourceHeader 不在表头 → raw undefined → applyTransform → null
    const miss = applyMappingRow(['x'], buildColIndex(['x']), MAPPINGS);
    expect(miss).toEqual({ date: null, debit: null, note: null });
  });
});

describe('insertRowsInBatches', () => {
  it('异步生成器流式写库:12000 行全入库 + onBatch 分批回调', async () => {
    const db = openDatabase(':memory:');
    const res = await insertRowsInBatches(db, 't', [
      { name: 'n', sqlType: 'TEXT' },
      { name: 'v', sqlType: 'INTEGER' },
    ], (async function* () {
      for (let i = 0; i < 12000; i++) yield { n: `r${i}`, v: i };
    })(), {
      dropExisting: true,
      onBatch: (n) => { expect(n).toBeGreaterThan(0); },
    });
    expect(res.rowsInserted).toBe(12000);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    expect(total).toBe(12000);
    const first = db.prepare('SELECT n, v FROM t WHERE v = 0').get();
    expect(first).toMatchObject({ n: 'r0', v: 0 });
    const last = db.prepare('SELECT n FROM t WHERE v = 11999').get();
    expect(last).toMatchObject({ n: 'r11999' });
    db.close();
  });

  it('同步数组输入 + dropExisting=false 追加', async () => {
    const db = openDatabase(':memory:');
    await insertRowsInBatches(db, 't', [{ name: 'n', sqlType: 'TEXT' }], [{ n: 'a' }]);
    await insertRowsInBatches(db, 't', [{ name: 'n', sqlType: 'TEXT' }], [{ n: 'b' }]);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    expect(total).toBe(2);
    db.close();
  });

  it('空流:dropExisting 建表后 0 行', async () => {
    const db = openDatabase(':memory:');
    const r = await insertRowsInBatches(db, 't', [{ name: 'n', sqlType: 'TEXT' }], [], { dropExisting: true });
    expect(r.rowsInserted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    db.close();
  });

  it('insert 失败整批抛出 ETL_INSERT_FAILED 并记日志(与 writeBigTable 一致)', async () => {
    // 注意:SQLite 列亲和性会把 'not-an-int' 存进 INTEGER 列而不报错,必须用 NOT NULL + null 强制失败。
    const db = openDatabase(':memory:');
    const out: LogEntry[] = [];
    logger.addSink(arraySink(out));
    await expect(
      insertRowsInBatches(db, 't', [{ name: 'n', sqlType: 'TEXT NOT NULL' }], [{ n: 'a' }, { n: null }, { n: 'c' }], {})
    ).rejects.toThrow();
    expect(out.some((e) => e.level === 'error' && e.module === 'etl/writer')).toBe(true);
    logger.clearSinks();
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/etl-stream.test.ts`
Expected: FAIL(`buildColIndex` 等未定义)。

- [ ] **Step 3: `transform.ts` 抽出逐行映射**

在 `applyMapping` 里新增两个函数并把 `applyMapping` 委托:

```ts
export function buildColIndex(headers: string[]): Map<string, number> {
  const colIndex = new Map<string, number>();
  headers.forEach((h, i) => colIndex.set(h, i));
  return colIndex;
}

export function applyMappingRow(
  row: unknown[],
  colIndex: Map<string, number>,
  mappings: FieldMapping[]
): TransformedRow {
  const out: TransformedRow = {};
  for (const m of mappings) {
    const ci = colIndex.get(m.sourceHeader);
    const raw = ci === undefined ? undefined : row[ci];
    out[m.outputName] = applyTransform(raw, m.transform);
  }
  return out;
}
```

`applyMapping` 改为:

```ts
export function applyMapping(sheet: ParsedSheet, mappings: FieldMapping[]): TransformedRow[] {
  const colIndex = buildColIndex(sheet.headers);
  return sheet.rows.map((row) => applyMappingRow(row, colIndex, mappings));
}
```

> 注意:现有 `applyMapping` 里 `colIndex` 构建正是「遍历覆盖」,`buildColIndex` 完全等价。缺列语义(raw `undefined` → `applyTransform` 处理 → `null`)保持不变。`applyTransform` 是模块内函数,同模块直接调用,**只传 2 个参数**。

- [ ] **Step 4: `writer.ts` 抽出批写**

保留 `writeBigTable` 现有签名,内部改为:

```ts
export async function insertRowsInBatches(
  db: Database.Database,
  tableName: string,
  colDefs: ColumnDef[],
  rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
  opts: { dropExisting?: boolean; onBatch?: (inserted: number) => void } = {}
): Promise<WriteResult> {
  if (opts.dropExisting) db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
  const columns = colDefs.map((c) => c.name);
  const colDefsSql = colDefs.map((c) => `"${c.name}" ${c.sqlType}`);
  createTableIfNotExists(db, tableName, colDefsSql);

  let inserted = 0;
  let batch: Record<string, unknown>[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    try {
      insertBatch(db, tableName, columns, batch);
      inserted += batch.length;
    } catch (err) {
      throw captureError(err, {
        module: MODULE,
        code: 'ETL_INSERT_FAILED',
        message: `insert batch failed for table ${tableName}`,
        data: { table: tableName, batchStart: inserted },
      });
    }
    opts.onBatch?.(inserted);
    batch = [];
    await new Promise((resolve) => setImmediate(resolve));
  };

  for await (const row of rows as AsyncIterable<Record<string, unknown>>) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  return { tableName, rowsInserted: inserted };
}
```

`writeBigTable` 委托并保留 `onProgress` 语义:

```ts
export async function writeBigTable(
  db: Database.Database,
  tableName: string,
  colDefs: ColumnDef[],
  rows: Record<string, unknown>[],
  onProgress?: (p: WriteProgress) => void,
  opts: { dropExisting?: boolean } = {},
): Promise<WriteResult> {
  return insertRowsInBatches(db, tableName, colDefs, rows, {
    dropExisting: opts.dropExisting,
    onBatch: (inserted) => {
      onProgress?.({
        insertedRows: inserted,
        totalRows: rows.length,
        percent: rows.length === 0 ? 100 : Math.round((inserted / rows.length) * 100),
      });
    },
  });
}
```

> `writer.ts` 头部已 import `Database` 类型、`createTableIfNotExists`/`insertBatch`/`logger`/`captureError`、`BATCH_SIZE`/`MODULE` 常量,全部直接复用。`for await...of` 对同步 Iterable 同样适用,无需分支。**空 rows 时 `flush` 提前返回,`onBatch` 不触发 → 与旧 writeBigTable 空输入不发进度完全一致**。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/core/etl-stream.test.ts tests/core/etl.test.ts`
Expected: 新测试 + 既有 etl 测试(writeBigTable 12000 行进度、失败行 rejects + `etl/writer` 日志)全 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/core/etl/transform.ts src/core/etl/writer.ts tests/core/etl-stream.test.ts
git commit -m "feat(etl): applyMappingRow 逐行映射 + insertRowsInBatches 流式批写"
```

---

### Task 4: clean-runner 流式化(删除 allRows)

**Files:**
- Modify: `src/core/pipeline/clean-runner.ts`
- Test: `tests/core/clean-runner.test.ts`(增;既有 150k 行回归已存在,**不要重复添加**)

**Interfaces:**
- Consumes: Task 2 `readExcelSheetStream`/`SheetRowStream`、Task 3 `buildColIndex`/`applyMappingRow`/`insertRowsInBatches`
- Produces: `runCleanPipeline(ws, db, cfg, bigTable, onProgress?): Promise<CleanResult>` —— 签名不变。`CleanResult` 真实形状是 `{ pipelineId, bigTableFolder, tableName, rowsInserted, files, warnings }`(注意:没有 `rows`、没有 `elapsedMs`)。内部不再物化 `allRows`。

**关键行为(必须保留):**
- 规则 × 源 pattern × 匹配文件展开顺序与旧一致;重复源去重(`seenSource`);同一 pattern 命中多文件逐个处理。
- 每个文件:`.csv` → `parseCsvFile` + 指定 sheet 名或第一张;`.xlsx/.xls` → `readExcelSheetStream`;sheet 不存在 → 静默跳过(旧 `parseExcelSheet` undefined 语义)。
- 重复表头警告 `表头「X」出现 N 次,映射只取其一,其余列数据不入`。
- 文件读取失败 → `跳过无法读取的文件 {basename}: {msg}` 警告并继续。
- 血缘行号:旧为 `attachLineage(mapped, {sourceRow: source.headerRow + 1})`(对批量数组逐行 +i);流式逐行调用 `attachLineage([mapped], {sourceRow: source.headerRow + 1 + rowNo})`,`rowNo` 从 0 递增——两者 `__source_row` 完全一致。
- 进度:新为 `scan:0` → `parse` 0→70(逐文件 `round(processedFiles/files.length*70)`) → `write:100`(一次性,不再有 70 中间值,不再发 `map` 阶段)。`CleanProgress` 类型的 `'map'` 保留但不再发出。

- [ ] **Step 1: 加流式专用用例到 `tests/core/clean-runner.test.ts`**

追加(复用该文件 beforeEach 的 `workspace/db/cfg/bigTable` 与既有 2 行 fixture):

```ts
it('流式:不物化 allRows——进度无 map 阶段,write 只发一次 100,parse 到 70', async () => {
  const stages: { stage: string; percent: number }[] = [];
  await runCleanPipeline(workspace, db, cfg, bigTable, (p) => stages.push(p));
  expect(stages[0]).toEqual({ stage: 'scan', percent: 0 });
  expect(stages.some((s) => s.stage === 'map')).toBe(false);
  const parse = stages.filter((s) => s.stage === 'parse');
  expect(parse.length).toBeGreaterThan(0);
  expect(Math.max(...parse.map((s) => s.percent))).toBe(70);
  const write = stages.filter((s) => s.stage === 'write');
  expect(write).toHaveLength(1);
  expect(write[0]).toEqual({ stage: 'write', percent: 100 });
});
```

> 既有「150k 行无栈溢出」测试(`res.rowsInserted === 150000`)就是流式不物化的核心回归——**保持它,不重复添加**。既有「write:100」进度测试在流式下依然成立。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/clean-runner.test.ts`
Expected: 新用例 FAIL(旧实现发 `map` 不存在的断言不成立、`write` 有 70 中间值)。

- [ ] **Step 3: 重写 `clean-runner.ts`**

头部 import 改为:

```ts
import { parseCsvFile, readExcelSheetStream, type SheetRowStream } from '../ingest/parser';
import { applyMappingRow, buildColIndex, type FieldMapping } from '../etl/transform';
import { insertRowsInBatches, type ColumnDef } from '../etl/writer';
import { attachLineage, lineageColumnNames } from '../lineage';
```

(去掉 `parseExcelFile`/`parseExcelSheet`/`applyMapping`/`writeBigTable` 的 import;其余 import 原样。)

`runCleanPipeline` 中,把「`const allRows: ... = [];` 到 `onProgress?.({stage:'write', percent:70}); ... writeBigTable(...)`」整段替换为(头部校验、`compileRule`/`buildColDefs`/`patternToRegex`、`extractedAt`、`warnings`/`seenSource` 原样):

```ts
  async function* produceRows(): AsyncGenerator<Record<string, unknown>> {
    let processedFiles = 0;
    for (const rule of rules) {
      const compiled = compileRule(rule);
      const ruleMappings = compiled.mappings;
      for (const source of compiled.sources) {
        const srcKey = `${source.pattern}|${source.sheetName ?? ''}|${source.headerRow}`;
        if (seenSource.has(srcKey)) continue;
        seenSource.add(srcKey);
        const re = patternToRegex(source.pattern);
        const matched = files.filter((f) => re.test(f.relPath) || re.test(f.path));
        for (const file of matched) {
          processedFiles++;
          onProgress?.({ stage: 'parse', percent: Math.round((processedFiles / files.length) * 70) });
          try {
            const isCsv = file.path.toLowerCase().endsWith('.csv');
            let stream: SheetRowStream | null;
            if (isCsv) {
              const sheets = parseCsvFile(file.path, { headerRow: source.headerRow });
              const sheet = source.sheetName
                ? sheets.find((s) => s.sheetName === source.sheetName)
                : sheets[0];
              stream = sheet
                ? { sheetName: sheet.sheetName, headers: sheet.headers, rows: csvRows(sheet.rows) }
                : null;
            } else {
              stream = await readExcelSheetStream(file.path, source.sheetName, { headerRow: source.headerRow });
            }
            if (!stream) continue; // 目标 sheet 不存在 → 该文件跳过

            for (const m of ruleMappings) {
              const n = stream.headers.filter((h) => h === m.sourceHeader).length;
              if (n > 1) {
                warnings.add(`表头「${m.sourceHeader}」出现 ${n} 次,映射只取其一,其余列数据不入`);
              }
            }
            const colIndex = buildColIndex(stream.headers);
            let rowNo = 0;
            for await (const row of stream.rows) {
              const mapped = applyMappingRow(row, colIndex, ruleMappings);
              attachLineage([mapped], {
                sourceFile: file.path,
                sourceSheet: stream.sheetName,
                sourceRow: source.headerRow + 1 + rowNo,
              }, extractedAt);
              rowNo++;
              yield mapped;
            }
          } catch (e) {
            // 单个文件读不了(如密码保护/损坏)不拖垮整条管线:跳过并在告警里说明
            warnings.add(`跳过无法读取的文件 ${basename(file.path)}: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  const result = await insertRowsInBatches(db, bigTable.tableName, colDefs, produceRows(), {
    dropExisting: true, // 合并 = 重建大表
  });
  onProgress?.({ stage: 'write', percent: 100 });

  logger.info(MODULE, 'clean complete', {
    pipelineId: cfg.id,
    rows: result.rowsInserted,
    files: files.length,
    warnings: [...warnings],
  });

  return {
    pipelineId: cfg.id,
    bigTableFolder: cfg.bigTableFolder,
    tableName: bigTable.tableName,
    rowsInserted: result.rowsInserted,
    files: files.length,
    warnings: [...warnings],
  };
}
```

文件末尾追加 `csvRows` 辅助:

```ts
/** 把已物化的 CSV 行包成异步生成器(与 readExcelSheetStream 的 rows 同构)。 */
function csvRows(rows: unknown[][]): AsyncGenerator<unknown[]> {
  return (async function* () {
    for (const r of rows) yield r;
  })();
}
```

> 注意:`insertRowsInBatches` 内部 `dropExisting` 时先 DROP 再建表,与旧 `writeBigTable` 一致。`produceRows()` 是惰性 AsyncGenerator,`insertRowsInBatches` 的 `for await` 边拉边写,`parse` 进度随消费实时发出。`colDefs` 来自前面的 `buildColDefs(colMappings, bigTable)`(含血缘列),不用改。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/clean-runner.test.ts`
Expected: 全 PASS(既有 2 行 fixture、150k 回归、重复表头警告、进度 write:100、日志,加上新用例)。

- [ ] **Step 5: 跑 transform/writer 联动测试确认无回归**

Run: `npx vitest run tests/core/etl.test.ts tests/core/etl-stream.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/core/pipeline/clean-runner.ts tests/core/clean-runner.test.ts
git commit -m "feat(pipeline): clean 流式化——删除 allRows,边解析边写库"
```

---

### Task 5: 工作台查询 5000 行自动封顶

**Files:**
- Modify: `src/core/pipeline/engine.ts`
- Modify: `src/core/agent/tools.ts`
- Modify: `src/ipc/handlers.ts`
- Test: `tests/core/pipeline-engine.test.ts`(增;**扁平路径**)

**Interfaces:**
- Consumes: 无
- Produces:
  - `export const QUERY_DEFAULT_LIMIT = 5000`
  - `QueryOutcome` 增加可选 `truncated?: boolean`
  - `toolQuery(ws: Workspace, sql: string, folder?: string, limit?: number): QueryOutcome`(签名加 `limit`)
  - `'query.run'` handler 把 `p.limit` 传给 `toolQuery`(`CommandPayloads['query.run']` 已有 `limit?: number`,contracts.ts 无需改)

**规则:** 有显式 limit 参数 → 注入该 limit(语句已含 LIMIT 则不注入);无参数且 SQL 含 `\blimit\b` → 不注入;无参数且无 LIMIT → 注入 `LIMIT 5000`(先剥末尾 `;`)。`truncated = !hasExplicitLimit && !alreadyLimited && rows.length === 5000`。

- [ ] **Step 1: 加失败测试到 `tests/core/pipeline-engine.test.ts`**

文件顶部 import 增加 `toolQuery`:

```ts
import { toolQuery } from '../../src/core/agent/tools';
import { masterDbPath } from '../../src/core/workspace/workspace';
```

在最后一个既有用例之后、describe 结束前追加(单个自包含用例,不依赖其他用例的数据):

```ts
it('queryOn 无 LIMIT 自动封顶 5000 并标记 truncated;显式 limit/LIMIT 不注入;toolQuery 透传 limit', () => {
  // 注意:主库是 master.db(不是 onworking.db)——engine.queryOn 走 masterDbPath。
  const db = openDatabase(masterDbPath(ws));
  db.exec('CREATE TABLE IF NOT EXISTS big (n INTEGER)');
  db.exec('DELETE FROM big');
  const ins = db.prepare('INSERT INTO big VALUES (?)');
  const tx = db.transaction(() => { for (let i = 0; i < 6000; i++) ins.run(i); });
  tx();
  db.close();

  const eng = new PipelineEngine(ws);
  const capped = eng.query('SELECT * FROM big');
  expect(capped.rows.length).toBe(5000);
  expect(capped.truncated).toBe(true);

  const withLimit = eng.query('SELECT * FROM big', 10);
  expect(withLimit.rows.length).toBe(10);
  expect(withLimit.truncated).toBe(false);

  const own = eng.query('SELECT * FROM big LIMIT 100');
  expect(own.rows.length).toBe(100);
  expect(own.truncated).toBe(false);

  const semi = eng.query('SELECT * FROM big;');
  expect(semi.rows.length).toBe(5000);
  expect(semi.truncated).toBe(true);

  const tool = toolQuery(ws, 'SELECT * FROM big', undefined, 5);
  expect(tool.rows.length).toBe(5);
  expect(tool.truncated).toBe(false);

  const toolFull = toolQuery(ws, 'SELECT * FROM big');
  expect(toolFull.rows.length).toBe(5000);
  expect(toolFull.truncated).toBe(true);
  eng.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/pipeline-engine.test.ts`
Expected: 新用例 FAIL(`truncated` 恒 undefined / 无注入)。

- [ ] **Step 3: engine.ts 注入逻辑**

`QueryOutcome` 接口加 `truncated?: boolean`。模块顶部加:

```ts
export const QUERY_DEFAULT_LIMIT = 5000;
```

`queryOn` 改:

```ts
  private queryOn(dbPath: string, sql: string, limit?: number): QueryOutcome {
    const db = openDatabase(dbPath);
    try {
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        const hasExplicitLimit = limit !== undefined;
        const alreadyLimited = /\blimit\b/i.test(sql);
        let finalSql = sql;
        if (!alreadyLimited) {
          const cap = hasExplicitLimit ? limit : QUERY_DEFAULT_LIMIT;
          finalSql = `${sql.replace(/;\s*$/, '')} LIMIT ${cap}`;
        }
        const rows = (finalSql === sql ? stmt : db.prepare(finalSql)).all() as Record<string, unknown>[];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        const truncated = !hasExplicitLimit && !alreadyLimited && rows.length === QUERY_DEFAULT_LIMIT;
        return { columns, rows, rowCount: rows.length, truncated };
      }
      const info = stmt.run();
      return { columns: [], rows: [], rowCount: 0, changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    } finally {
      db.close();
    }
  }
```

`toolQuery` 在 `src/core/agent/tools.ts` 改为:

```ts
export function toolQuery(
  ws: Workspace,
  sql: string,
  folder?: string,
  limit?: number,
): QueryOutcome {
  const eng = new PipelineEngine(ws);
  try {
    return folder ? eng.queryBigTable(folder, sql, limit) : eng.query(sql, limit);
  } finally {
    eng.close();
  }
}
```

`src/ipc/handlers.ts` 的 `'query.run'`:

```ts
'query.run': async (ctx, p) => toolQuery(ctx.ws, p.sql, p.folder, p.limit),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/pipeline-engine.test.ts tests/core/tools.test.ts tests/ipc/handlers.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/pipeline/engine.ts src/core/agent/tools.ts src/ipc/handlers.ts tests/core/pipeline-engine.test.ts
git commit -m "feat(engine): queryOn 无 LIMIT 自动封顶 5000 + truncated 标记,IPC 透传 limit"
```

---

### Task 6: CSV 导出流式化(游标写盘,不物化不封顶)

**Files:**
- Create: `src/core/export/csv.ts`
- Modify: `src/core/agent/tools.ts`(3 个 export tool 改 async + 删本地 `csvEscape` 改 import)
- Test: `tests/core/csv.test.ts`(新文件;**扁平路径**,import 用 `'../../src/core/export/csv'`)
- Modify: `tests/core/tools.test.ts`(加 `await`、`rejects.toThrow`)
- **不改** `src/ipc/handlers.ts`(三个 export handler 已是 `async (ctx, p) => tool*Csv(...)`,`dispatch` 已 await,工具改 async 对 IPC 层透明)
- **不改** `src/ipc/contracts.ts`(`CommandResults` 的 export 结果已是 `{ file, rows }`,handler 返回 Promise 兼容)
- **不改** `tests/ipc/handlers.test.ts`(全 dispatch 驱动,已 await)

**Interfaces:**
- Consumes: 无外部
- Produces:
  - `function csvEscape(v: unknown): string` —— **从 tools.ts 原样搬来,逐字节一致**:`null/undefined → ''`、`String(v)`、`/[",\n\r]/` 时引号包裹 + `"`→`""`(**不要**加 Date→ISO / JSON 分支——那会改变 Date 单元格输出)。
  - `async function writeRowsToCsvFile(file: string, columns: string[], rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>): Promise<number>` —— mkdir parent、WriteStream 写入,首行表头 `columns.join(',')`,每行 `\n` 前缀;drain 背压;`finish` 后 resolve;返回**数据行数**(不含表头)。

**导出语义(与旧一致):**
- 无 BOM;LF 换行;无尾换行。
- `toolExportBigTableCsv`:默认路径 `join(ws.root, 'exports', `${cfg.tableName}.csv`)`(**`ws.root`,不是 `ws.onworkingDir`**);`existsSync(dbPath)` 且表存在才查库,否则空导出、表头 = `cfg.fields.map(f => f.name)`;缺省 `includeLineage` 过滤 `!c.startsWith('__')`;`openDatabase(dbPath, { wal: false })`。
- `toolExportQueryCsv`:保留非 SELECT 校验(throw AppError `QUERY_NOT_SELECT` / `'only SELECT/WITH queries are allowed in the workbench'`);默认路径 `join(ws.root, 'exports', 'query.csv')`;`openDatabase(folder ? bigTableDbPath : masterDbPath, { wal: false })`。
- `toolExportSourceCsv`:默认路径 `join(ws.root, 'exports', `${base}.csv`)`,`base = basename(filePath).replace(/\.(xlsx|xls|csv)$/i, '')`;sheet 指定不存在 → 回落第一张;`headerRow` 1 基传给 `readExcelSheetStream`/`parseCsvFile`。

- [ ] **Step 1: 写 `tests/core/csv.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvEscape, writeRowsToCsvFile } from '../../src/core/export/csv';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ow-csv-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeRowsToCsvFile', () => {
  it('表头 + 行,无 BOM、LF、无尾换行,与旧实现字节一致', async () => {
    const file = join(dir, 'out.csv');
    const rows = [
      { date: '2024-01', debit: 100, note: 'a,b' },
      { date: '2024-02', debit: -5, note: 'x"y' },
    ];
    const n = await writeRowsToCsvFile(file, ['date', 'debit', 'note'], rows);
    expect(n).toBe(2);
    const bytes = readFileSync(file);
    expect(bytes[0]).not.toBe(0xef); // 无 BOM
    expect(bytes.toString('utf-8')).toBe('date,debit,note\n2024-01,100,"a,b"\n2024-02,-5,"x""y"');
  });

  it('空结果集:仅表头行', async () => {
    const file = join(dir, 'empty.csv');
    const n = await writeRowsToCsvFile(file, ['a', 'b'], []);
    expect(n).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe('a,b');
  });

  it('接受异步可迭代(游标产物)', async () => {
    const file = join(dir, 'async.csv');
    async function* gen(): AsyncGenerator<Record<string, unknown>> {
      yield { a: 1 };
      yield { a: 2 };
    }
    const n = await writeRowsToCsvFile(file, ['a'], gen());
    expect(n).toBe(2);
    expect(readFileSync(file, 'utf-8')).toBe('a\n1\n2');
  });

  it('csvEscape 转义逗号/引号/换行,空值转空串', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape(100)).toBe('100');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/csv.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/core/export/csv.ts`**

```ts
// src/core/export/csv.ts
// 流式 CSV 落盘:better-sqlite3 游标/生成器逐行写盘,不物化、无 BOM、LF 换行、无尾换行。
// csvEscape 与旧 toolExport* 逐字节一致(RFC 4180 子集):只有 String(v),没有 Date/JSON 分支。
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 流式写 CSV:游标/生成器逐行写盘,不物化。drain 背压保证 O(1) 内存。
 * 无 BOM、LF 换行、无尾换行,与旧实现字节一致。
 * @returns 写入的数据行数(不含表头行)
 */
export async function writeRowsToCsvFile(
  file: string,
  columns: string[],
  rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>
): Promise<number> {
  mkdirSync(dirname(file), { recursive: true });
  const ws = createWriteStream(file, { encoding: 'utf8', flags: 'w' });
  let count = 0;
  try {
    ws.write(columns.join(','));
    for await (const r of rows) {
      const line = `\n${columns.map((c) => csvEscape(r[c])).join(',')}`;
      if (!ws.write(line)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => { ws.off('error', onError); resolve(); };
          const onError = (err: Error): void => { ws.off('drain', onDrain); reject(err); };
          ws.once('drain', onDrain);
          ws.once('error', onError);
        });
      }
      count++;
    }
    await new Promise<void>((resolve, reject) => {
      ws.end();
      ws.once('finish', resolve);
      ws.once('error', reject);
    });
    return count;
  } catch (err) {
    ws.destroy();
    throw err;
  }
}
```

- [ ] **Step 4: 改 tools.ts 三个导出工具为 async**

`src/core/agent/tools.ts`:删本地 `csvEscape`(第 47-52 行),顶部加 `import { csvEscape, writeRowsToCsvFile } from '../export/csv';`。三个工具替换为:

```ts
/** tool: 导出大表数据到 CSV 文件。缺省不含血缘列,写 `<工作区根>/exports/<tableName>.csv`。未清洗/空表导出空 CSV(表头取配置字段名)。 */
export async function toolExportBigTableCsv(
  ws: Workspace,
  folder: string,
  opts?: { path?: string; includeLineage?: boolean },
): Promise<{ file: string; rows: number }> {
  const cfg = loadBigTableConfig(ws, folder);
  const file = opts?.path ?? join(ws.root, 'exports', `${cfg.tableName}.csv`);
  const dbPath = bigTableDbPath(ws, folder);
  const tableExists = existsSync(dbPath)
    ? (() => {
        const db = openDatabase(dbPath);
        try {
          return !!db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(cfg.tableName);
        } finally {
          db.close();
        }
      })()
    : false;
  if (!tableExists) {
    const headers = cfg.fields.map((f) => f.name);
    const n = await writeRowsToCsvFile(file, headers, []);
    return { file, rows: n };
  }
  const db = openDatabase(dbPath, { wal: false });
  try {
    const stmt = db.prepare(`SELECT * FROM "${cfg.tableName}"`);
    const columns = stmt.columns().map((c) => c.name);
    const keep = opts?.includeLineage ? columns : columns.filter((c) => !c.startsWith('__'));
    const n = await writeRowsToCsvFile(file, keep, stmt.iterate() as IterableIterator<Record<string, unknown>>);
    return { file, rows: n };
  } finally {
    db.close();
  }
}

/** tool: 从总表导出查询结果到 CSV(交付清洗后的总表)。仅 SELECT/WITH。folder 给定时导出大表 DB。 */
export async function toolExportQueryCsv(
  ws: Workspace,
  sql: string,
  opts?: { path?: string; folder?: string },
): Promise<{ file: string; rows: number }> {
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new AppError({
      module: 'query',
      code: 'QUERY_NOT_SELECT',
      message: 'only SELECT/WITH queries are allowed in the workbench',
      data: { sql },
    });
  }
  const file = opts?.path ?? join(ws.root, 'exports', 'query.csv');
  const db = openDatabase(opts?.folder ? bigTableDbPath(ws, opts.folder) : masterDbPath(ws), { wal: false });
  try {
    const stmt = db.prepare(trimmed);
    const columns = stmt.columns().map((c) => c.name);
    const n = await writeRowsToCsvFile(file, columns, stmt.iterate() as IterableIterator<Record<string, unknown>>);
    return { file, rows: n };
  } finally {
    db.close();
  }
}

/** tool: 导出源文件指定 sheet 为 CSV(与预览同视角,含表头行)。 */
export async function toolExportSourceCsv(
  ws: Workspace,
  filePath: string,
  opts?: { sheetName?: string; headerRow?: number; path?: string },
): Promise<{ file: string; rows: number }> {
  const base = basename(filePath).replace(/\.(xlsx|xls|csv)$/i, '');
  const file = opts?.path ?? join(ws.root, 'exports', `${base}.csv`);
  if (filePath.toLowerCase().endsWith('.csv')) {
    const sheets = parseCsvFile(filePath, { headerRow: opts?.headerRow ?? 1 });
    const sheet = (opts?.sheetName ? sheets.find((s) => s.sheetName === opts.sheetName) : undefined) ?? sheets[0];
    const columns = sheet ? sheet.headers : [];
    const rows = sheet
      ? { async *[Symbol.asyncIterator]() { for (const r of sheet.rows) yield r; } }
      : [];
    const n = await writeRowsToCsvFile(file, columns, rows);
    return { file, rows: n };
  }
  let stream = await readExcelSheetStream(filePath, opts?.sheetName, { headerRow: opts?.headerRow ?? 1 });
  if (!stream && opts?.sheetName) {
    stream = await readExcelSheetStream(filePath, undefined, { headerRow: opts?.headerRow ?? 1 });
  }
  const columns = stream ? stream.headers : [];
  const n = await writeRowsToCsvFile(file, columns, stream ? stream.rows : []);
  return { file, rows: n };
}
```

> 检查 tools.ts 现有 import:`bigTableDbPath`/`loadBigTableConfig` 来自 bigtable/store,`masterDbPath` 来自 workspace,`parseCsvFile`/`readExcelSheetStream` 来自 ingest/parser,`basename`/`join` 来自 node:path,`existsSync` 来自 node:fs,`openDatabase` 来自 db/database,`AppError` 来自 errors —— 全已存在。`stmt.iterate()` 返回同步 IterableIterator,`writeRowsToCsvFile` 参数已是 `Iterable | AsyncIterable`,直接传即可。

- [ ] **Step 5: 改既有 `tests/core/tools.test.ts` 加 await**

1. 第 168 行 `const res = toolExportBigTableCsv(ws, 'seq');` → `await toolExportBigTableCsv(...)`(该用例已是 async)。
2. 第 179 行 `const withLineage = toolExportBigTableCsv(ws, 'seq', { includeLineage: true });` → 加 `await`。
3. 第 183 行 `it('toolExportBigTableCsv writes to a caller-supplied path', () => {` → `async () => {`;第 185 行 `const res = toolExportBigTableCsv(ws, 'seq', { path: custom });` → 加 `await`。
4. 第 329 行 `const res = toolExportQueryCsv(ws, 'SELECT date, debit FROM seq ORDER BY date');` → 加 `await`(该用例已是 async)。
5. 第 337 行 `it('toolExportQueryCsv rejects non-SELECT', () => {` → `async () => {`;第 338 行 `expect(() => toolExportQueryCsv(ws, 'DELETE FROM seq')).toThrow(/only SELECT/);` → `await expect(toolExportQueryCsv(ws, 'DELETE FROM seq')).rejects.toThrow(/only SELECT/);`。
6. 第 347 行 `it('toolExportSourceCsv exports a source file sheet to CSV', () => {` → `async () => {`;第 348 行 `const res = toolExportSourceCsv(ws, join(sourceDir, 'a.xlsx'), { sheetName: 'Sheet1', headerRow: 1 });` → 加 `await`。

`tests/ipc/handlers.test.ts` **不改**(全 dispatch 驱动,已 await)。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/core/csv.test.ts tests/core/tools.test.ts tests/ipc/handlers.test.ts tests/core/parser-stream.test.ts`
Expected: 全 PASS(parser-stream 也跑一遍,确认 `toolExportSourceCsv` 复用 `readExcelSheetStream` 无回归)。

- [ ] **Step 7: 提交**

```bash
git add src/core/export/csv.ts src/core/agent/tools.ts tests/core/csv.test.ts tests/core/tools.test.ts
git commit -m "feat(export): CSV 游标流式写盘(不物化不封顶),导出工具改 async"
```

---

### Task 7: 前端导出保存对话框 + 截断提示

**Files:**
- Create: `src/main/dialogs.ts`
- Modify: `src/main/index.ts`(注册 `onw:save-csv` handler)
- Modify: `src/main/preload.ts`(暴露 `pickSaveCsv`)
- Modify: `src/renderer/global.d.ts`(`Window.onw` 加 `pickSaveCsv`)
- Modify: `src/renderer/mock/onw-mock.ts`(mock `pickSaveCsv`)
- Modify: `src/renderer/views/SqlView.tsx`(导出前弹框 + 截断提示)
- Modify: `src/renderer/views/QueryResultView.tsx`(导出前弹框)
- Modify: `src/renderer/views/PreviewView.tsx`(导出前弹框)
- Test: `tests/main/dialogs.test.ts`(新文件,纯函数断言,不打 Electron)

**Interfaces:**
- Consumes: Task 6(export 工具已 async;`query.exportCsv` 返回 `{file, rows}`)
- Produces:
  - `function saveCsvDialog(dialog: SaveDialogLike, defaultName: string): Promise<string | null>`,`SaveDialogLike = { showSaveDialog(options: { defaultPath: string; filters: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePath?: string }> }` —— **单参数重载**(electron 无窗口句柄时的 app 级对话框)。
  - `Window.onw.pickSaveCsv(defaultName: string): Promise<string | null>`
  - IPC 事件 `onw:save-csv`(payload `{ defaultName: string }`,结果 `string | null`)

**行为:** 3 个视图导出前调 `await window.onw.pickSaveCsv(defaultName)`,拿到路径后把 `path` 传进 export 命令;用户取消(返回 null)则不导出。SqlView 在结果 `truncated` 时显示「结果已截断到 5000 行,如需完整数据请导出 CSV」。

- [ ] **Step 1: 写 `tests/main/dialogs.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { saveCsvDialog, type SaveDialogLike } from '../../src/main/dialogs';

describe('saveCsvDialog', () => {
  it('用户选路径 → 返回该路径,过滤器为 .csv', async () => {
    const dialog: SaveDialogLike = {
      showSaveDialog: async (o) => {
        expect(o.defaultPath).toBe('seq.csv');
        expect(o.filters[0].extensions).toEqual(['csv']);
        return { canceled: false, filePath: 'D:/demo/exports/seq.csv' };
      },
    };
    const p = await saveCsvDialog(dialog, 'seq.csv');
    expect(p).toBe('D:/demo/exports/seq.csv');
  });

  it('用户取消 → 返回 null', async () => {
    const dialog: SaveDialogLike = {
      showSaveDialog: async () => ({ canceled: true }),
    };
    const p = await saveCsvDialog(dialog, 'seq.csv');
    expect(p).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/main/dialogs.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/main/dialogs.ts`**

```ts
// src/main/dialogs.ts
// 保存对话框的纯函数封装:便于单测,不打 Electron。用 app 级对话框(无窗口句柄,单参数重载)。
export interface SaveDialogLike {
  showSaveDialog(options: {
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

export async function saveCsvDialog(
  dialog: SaveDialogLike,
  defaultName: string,
): Promise<string | null> {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
}
```

> electron 的 `dialog.showSaveDialog` 是重载函数(有/无窗口两种签名),electron 的 `SaveDialogOptions` 里 `defaultPath`/`filters` 是可选 → 结构上不完全匹配 `SaveDialogLike`,在 index.ts 接线处用 `dialog as unknown as SaveDialogLike` 强转。

- [ ] **Step 4: main 进程接线**

`src/main/index.ts`:

```ts
import { saveCsvDialog, type SaveDialogLike } from './dialogs';
```

在既有 `onw:pick-*` handler 旁加:

```ts
// 保存 CSV 对话框桥(UI 专属):导出前让用户选保存路径。
ipcMain.handle('onw:save-csv', async (_e, payload: { defaultName: string }) =>
  saveCsvDialog(dialog as unknown as SaveDialogLike, payload.defaultName)
);
```

`src/main/preload.ts`(在 `pickDirectory` 后加):

```ts
  pickSaveCsv: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('onw:save-csv', { defaultName }) as Promise<string | null>,
```

`src/renderer/global.d.ts`(`onw` 接口加):

```ts
      pickSaveCsv(defaultName: string): Promise<string | null>;
```

`src/renderer/mock/onw-mock.ts`(在 `pickDirectory` 后加):

```ts
    pickSaveCsv: async (defaultName: string): Promise<string | null> => `D:/演示工作区/exports/${defaultName}`,
```

- [ ] **Step 5: 三个视图接入保存框 + 截断提示**

`src/renderer/views/SqlView.tsx`:
- `QueryResult` 接口加 `truncated?: boolean`。
- `handleExport` 改为先弹保存框再导出:

```ts
  async function handleExport() {
    const path = await window.onw.pickSaveCsv('query.csv');
    if (!path) return;
    setExportMsg('');
    setBusy(true);
    const res = await sendCli(dbSource === 'master'
      ? { cmd: 'query.exportCsv', sql, path }
      : { cmd: 'query.exportCsv', sql, folder: dbSource, path });
    setBusy(false);
    if (res.ok) setExportMsg(`已导出: ${(res.data as { file: string; rows: number }).file} (${(res.data as { rows: number }).rows} 行)`);
    else setExportMsg(`导出失败: ${res.error.message}`);
  }
```

- 结果区在按钮行之后、表格之前渲染截断提示:

```tsx
          {result?.truncated && (
            <p style={{ color: '#9a6700', fontSize: 12, margin: '4px 0' }}>
              结果已截断到 5000 行,如需完整数据请导出 CSV
            </p>
          )}
```

`src/renderer/views/QueryResultView.tsx`:
- `handleExport` 改为先弹保存框(默认名 `result.csv`):

```ts
  async function handleExport() {
    const path = await window.onw.pickSaveCsv('result.csv');
    if (!path) return;
    setExportMsg('');
    const res = await sendCli({ cmd: 'query.exportCsv', sql: runSql, path });
    if (res.ok) {
      const d = res.data as { file: string; rows: number };
      setExportMsg(`已导出: ${d.file} (${d.rows} 行)`);
    } else setExportMsg(`导出失败: ${res.error.message}`);
  }
```

`src/renderer/views/PreviewView.tsx`:
- `handleExport` 里两个分支都先弹保存框,默认名分别取源文件 base 与 folder:

```ts
  async function handleExport() {
    setExportMsg('');
    if (selectedFile) {
      const base = fileNameOf(selectedFile).replace(/\.(xlsx|xls|csv)$/i, '');
      const path = await window.onw.pickSaveCsv(`${base}.csv`);
      if (!path) return;
      const res = await sendCli({ cmd: 'setup.exportCsv', filePath: selectedFile, sheetName: sheet || undefined, headerRow, path });
      if (res.ok) {
        const d = res.data as { file: string; rows: number };
        setExportMsg(`已导出: ${d.file} (${d.rows} 行)`);
      } else setExportMsg(`导出失败: ${res.error.message}`);
    } else if (selectedFolder) {
      const path = await window.onw.pickSaveCsv(`${selectedFolder}.csv`);
      if (!path) return;
      const res = await sendCli({ cmd: 'bigtable.exportCsv', folder: selectedFolder, path });
      if (res.ok) {
        const d = res.data as { file: string; rows: number };
        setExportMsg(`已导出: ${d.file} (${d.rows} 行)`);
      } else setExportMsg(`导出失败: ${res.error.message}`);
    } else {
      setExportMsg('请先选择大表或源文件');
    }
  }
```

> 每个视图 export 之前都 `if (!path) return;`。mock 返回固定路径,预览流程在演示环境依然可导出。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/main/dialogs.test.ts tests/ipc/handlers.test.ts`
Expected: PASS(handlers 测的是 IPC 派发,不受视图改动影响)。

- [ ] **Step 7: 类型检查**

Run: `npm run typecheck`
Expected: 无错误(global.d.ts + mock + 三视图的类型联通)。

- [ ] **Step 8: 提交**

```bash
git add src/main/dialogs.ts src/main/index.ts src/main/preload.ts src/renderer/global.d.ts src/renderer/mock/onw-mock.ts src/renderer/views/SqlView.tsx src/renderer/views/QueryResultView.tsx src/renderer/views/PreviewView.tsx tests/main/dialogs.test.ts
git commit -m "feat(ui): 导出弹保存框 + SQL 截断提示"
```

---

### Task 8: sql-clean 游标物化

**Files:**
- Modify: `src/core/pipeline/sql-clean-runner.ts`
- Test: `tests/core/pipeline-engine.test.ts`(增)

**Interfaces:**
- Consumes: 无外部(纯自身改造)
- Produces: `runSqlCleanPipeline` 签名不变;内部改为 `stmt.columns()` + `stmt.iterate()` + 5000 批事务;**空结果集保留 `(empty INTEGER)` 行为**。`qt`(双引号转义)与 `aliasOf` 已在文件内,直接复用。

- [ ] **Step 1: 加失败测试**

`tests/core/pipeline-engine.test.ts` 追加(复用该文件既有 `ws`/`savePipeline`/`bigTableDbPath`/`openDatabase`/`dbPath()`;`savePipeline` 已在文件 import):

```ts
it('sql-clean 游标物化 12000 行(多批事务)', async () => {
  // 直接在大表 DB 造数据(绕开大文件导入耗时);需先跑 clean 建出大表结构
  const eng = new PipelineEngine(ws);
  await eng.run('c1');
  const btPath = bigTableDbPath(ws, 'seq');
  const btdb = openDatabase(btPath, { wal: false });
  const ins = btdb.prepare('INSERT INTO seq (date, debit) VALUES (?, ?)');
  const tx = btdb.transaction(() => { for (let i = 0; i < 12000; i++) ins.run('2024-01', i); });
  tx();
  btdb.close();

  const r = await eng.run('m1'); // m1: SELECT date, debit FROM "bt_seq".seq → resultTable 'seq'
  expect(r.ok).toBe(true);
  expect(r.rows).toBe(12000);
  const db = openDatabase(dbPath());
  const n = (db.prepare('SELECT COUNT(*) AS n FROM seq').get() as { n: number }).n;
  expect(n).toBe(12000);
  db.close();
  eng.close();
});

it('sql-clean 空结果集仍建 (empty INTEGER)', async () => {
  savePipeline(ws, {
    kind: 'sql-clean', id: 'm2', label: '', bigTables: ['seq'],
    sql: 'SELECT date FROM "bt_seq".seq WHERE 1 = 0', resultTable: 'empty_out', createdAt: '',
  });
  const eng = new PipelineEngine(ws);
  await eng.run('c1'); // 先跑 clean 建出大表 seq(否则 ATTACH 的库没有表,SELECT 会失败)
  const r = await eng.run('m2');
  expect(r.ok).toBe(true);
  expect(r.rows).toBe(0);
  const db = openDatabase(dbPath());
  const cols = db.prepare('PRAGMA table_info(empty_out)').all() as { name: string }[];
  expect(cols.map((c) => c.name)).toEqual(['empty']);
  db.close();
  eng.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/pipeline-engine.test.ts`
Expected: 现有实现 `.all()` 也能通过行数用例,但**空结果用例会失败**:旧 `.all()` 后 `Object.keys(rows[0])` 为空 → 建 `(empty INTEGER)`(实际上旧行为也建)……真正的差异在实现层;至少 `r.rows` 计数、PRAGMA 断言需对照新行为。若两个新用例意外全过,说明实现已等价,直接进 Step 3 的改造并保留用例作为回归。

- [ ] **Step 3: 重写物化段**

`src/core/pipeline/sql-clean-runner.ts` 把第 66-85 行的「执行 SQL 取结果 + 物化」段替换为:

```ts
  // 2. 执行清洗/汇总 SQL(读 ATTACH 库),游标取结果(不物化全量)
  const stmt = masterDb.prepare(cfg.sql);
  const iter = stmt.iterate() as IterableIterator<Record<string, unknown>>;

  // 3. 物化到总表(覆盖式)。显式 "main". 限定,避免误删附加库(大表)的同名表。
  const mainTable = `main."${qt(cfg.resultTable)}"`;
  const first = iter.next();
  if (first.done) {
    // 空结果集:保留旧行为 —— 建 (empty INTEGER) 占位表
    masterDb.exec(`DROP TABLE IF EXISTS ${mainTable}`);
    masterDb.exec(`CREATE TABLE ${mainTable} (empty INTEGER)`);
    return { pipelineId: cfg.id, rows: 0 };
  }
  const columns = stmt.columns().map((c) => c.name);
  masterDb.exec(`DROP TABLE IF EXISTS ${mainTable}`);
  const colDefs = columns.map((c) => `"${qt(c)}"`).join(', ');
  masterDb.exec(`CREATE TABLE ${mainTable} (${colDefs})`);
  const insert = masterDb.prepare(
    `INSERT INTO ${mainTable} VALUES (${columns.map(() => '?').join(', ')})`,
  );
  const tx = masterDb.transaction((batch: Record<string, unknown>[]) => {
    for (const r of batch) insert.run(columns.map((c) => (r[c] === undefined ? null : r[c])));
  });

  let inserted = 1; // first.value 已在下方批次里
  let batch: Record<string, unknown>[] = [first.value];
  for (const row of iter) {
    batch.push(row);
    if (batch.length >= 5000) { tx(batch); inserted += batch.length; batch = []; }
  }
  if (batch.length > 0) { tx(batch); inserted += batch.length; }

  // 4. DETACH 各大表(原样保留)
```

> `stmt.columns()` 对 0 行 SELECT 也返回列结构,所以「空结果」必须用 `iter.next()` 判空(不能靠 `columns.length === 0`)。`undefined → null` 与旧 `.all()` 后 `row[c]` 语义一致。ATTACH/DETACH 段、`SQLCLEAN_*` 校验段不动。注意把 `inserted` 初始化为 1 并从 `first.value` 起批,计数不含歧义。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/pipeline-engine.test.ts`
Expected: 全 PASS(含既有 sql-clean 错误用例 + 新增 12000 行/空结果用例)。

- [ ] **Step 5: 提交**

```bash
git add src/core/pipeline/sql-clean-runner.ts tests/core/pipeline-engine.test.ts
git commit -m "feat(pipeline): sql-clean 游标物化(iterate + 分批事务 + 空结果兼容)"
```

---

### Task 9: 全链路集成 + 验收

**Files:**
- Modify: `tests/core/pipeline-integration.test.ts`(增流式端到端用例)
- 全量 `npm test`、`npm run typecheck`

**Interfaces:**
- Consumes: Task 1-8 全部产物

**验收标准(来自 spec,逐条对):**
- 导入 207,508 行真实文件全程峰值 ≤250MB;sql-clean <200MB;单文件 ≤60s。
- 全链路无 U+FFFD。
- `npm test` 全绿;`npm run typecheck` 无错。

- [ ] **Step 1: 加端到端流式用例到 `tests/core/pipeline-integration.test.ts`**

沿用该文件 beforeEach 的 `dir/ws/sourceDir` 与既有「造表 → saveBigTableConfig/saveRule/savePipeline → eng.run」模式,追加:

```ts
it('流式端到端:bookSST 5 万行导入无 U+FFFD,行数精确', async () => {
  const rows: unknown[][] = [['期间', '借方金额', '摘要']];
  for (let i = 0; i < 50000; i++) {
    rows.push([`2024-${String((i % 12) + 1).padStart(2, '0')}`, i * 1.5, `备注${i} 中文`]);
  }
  const wsx = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsx, '序时账');
  XLSX.writeFile(wb, join(sourceDir, 'seq.xlsx'), { bookSST: true }); // 走共享字符串解码路径

  saveBigTableConfig(ws, 'seq', {
    tableName: 'seq',
    autoIncrement: true,
    fields: [
      { name: 'period', type: 'TEXT', order: 1 },
      { name: 'debit', type: 'INTEGER', order: 2 },
      { name: 'note', type: 'TEXT', order: 3 },
    ],
  });
  saveRule(ws, 'seq', {
    name: 'seq_rule',
    display: '规则',
    version: 1,
    sources: [{ pattern: '**/*', headerRow: 1 }],
    fields: [
      { sourceHeader: '期间', outputName: 'period', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
      { sourceHeader: '借方金额', outputName: 'debit', included: true, order: 2, transforms: [{ kind: 'coerce_cents' }] },
      { sourceHeader: '摘要', outputName: 'note', included: true, order: 3, transforms: [{ kind: 'coerce_string' }] },
    ],
  });
  savePipeline(ws, {
    kind: 'clean',
    id: 'c1',
    label: '',
    bigTableFolder: 'seq',
    sourceDir,
    createdAt: '',
  });

  const eng = new PipelineEngine(ws);
  const r = await eng.run('c1');
  expect(r.ok).toBe(true);
  expect(r.rows).toBe(50000);

  // 大表 DB 抽查:中文无 U+FFFD(避开跨界索引,用确定性的备注文本查)
  const btdb = openDatabase(bigTableDbPath(ws, 'seq'));
  const probe = btdb.prepare('SELECT note FROM seq WHERE note = ? LIMIT 1').get('备注24998 中文') as { note: string } | undefined;
  const probe2 = btdb.prepare('SELECT note FROM seq WHERE note = ? LIMIT 1').get('备注49999 中文') as { note: string } | undefined;
  btdb.close();
  expect(probe).toBeTruthy();
  expect(probe!.note).not.toContain('\uFFFD');
  expect(probe2).toBeTruthy();
  expect(probe2!.note).not.toContain('\uFFFD');
  eng.close();
});
```

> `bookSST: true` 保证走过共享字符串解码路径(解码器守护)。5 万行控制集成用例体积(150k 已在 clean-runner 单测覆盖)。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全绿。若某用例超时,检查是否无意中物化了超大数组;内存有界断言应保持。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 4: 真实文件验收(人工,必须执行——单测不能替代内存验收)**

仓库没有 `scripts/measure-onw2.ps1`(已确认不存在),按以下手工步骤在 CLI 调试环境执行(参考既有流程:CLI 用 `npm run onw`,任务管理器/性能监视器记录峰值):

1. 用真实 `特瑞序时账24-2603.xlsx`(207,508 行)跑 `onw clean <folder>`,打开任务管理器性能标签页记录进程峰值内存(**≤250MB**)与墙钟(**≤60s**,低配 2 核 4 线程 / 8GB)。
2. 抽查导出 CSV 首尾行 + 中文(`toolExportBigTableCsv`),确认无 U+FFFD。
3. 对同一大表跑 sql-clean(`onw sql-clean <folder>` 或对应管线),峰值 **<200MB**。

> 若在低配机器上峰值超标,先核对自研读取器的两处:① `openXlsxWorkbook` 的共享字符串物化(`sharedStrings` 整份进内存,是新设计里唯一无法再流式的环节);② 工作表 XML 是否被误改成整块 `decode` 喂入(应逐块 `TextDecoder.decode(chunk, {stream:true})`)。

- [ ] **Step 5: 提交**

```bash
git add tests/core/pipeline-integration.test.ts
git commit -m "test: 大文件端到端流式回归(bookSST 导入无 U+FFFD,行数精确)"
```

- [ ] **Step 6: 交付报告**

在终端输出一页验收表:每项验收标准 → 通过/阈值 → 实测值(内存/耗时/行数),并说明任何未达标的项及原因。这是 Phase 2 的收尾交付,不在本任务之外追加范围外工作(CSV 解析流式化/worker 线程/共享字符串切片化均已在 spec 里标记为范围外——注意:本计划 Task 6 已把「CSV 导出」流式化,spec 里「范围外」指的是「大 CSV 的 clean 解析流式化 / 更激进的 CSV 专用流式解析器 / worker 线程 / Electron 进程基线 / 共享字符串切片化」,不在本计划范围内)。

---

## Self-Review

### 1. Spec 覆盖

| Spec 需求 | 任务 |
|---|---|
| 自研 `.xlsx` 流式读取器(unzip+saxes,无需补丁) | Task 1 |
| 流式解析 `readExcelSheetStream` + 边界算法(尾空丢弃/内部空行 `[]`) | Task 2 |
| `.xls` SheetJS 回退 | Task 2 |
| CRLF→LF 接受(不预处理) | Task 2(不动作,仅测试断言接受) |
| clean 流式化(删除 allRows) | Task 4 |
| 逐行 transform + 批写 | Task 3 |
| `QUERY_DEFAULT_LIMIT=5000` 注入 + `truncated` | Task 5 |
| 导出流式(游标写盘,不封顶不物化) | Task 6 |
| 导出保存对话框 + 截断提示 | Task 7 |
| sql-clean `iterate()` + 分批事务 + 空结果 `(empty INTEGER)` | Task 8 |
| 内存/墙钟验收(≤250MB / <200MB / ≤60s) | Task 9 |
| 无 U+FFFD(全链路) | Task 2 + Task 9 |
| 范围外(worker 线程 / Electron 进程基线 / 大 CSV clean 解析 / 共享字符串切片化) | 明确不入计划 |

### 2. 占位符扫描

无 "TBD/TODO/implement later/add error handling";所有实现步骤都带完整代码;所有测试步骤都带完整用例代码;手动验收步骤完整给出(无「若脚本存在」的空洞分支——脚本确认不存在,直接给手工步骤)。

### 3. 类型一致性

- `readExcelSheetStream(filePath, sheetName?, opts?: {headerRow?}) → Promise<SheetRowStream | null>`,`SheetRowStream {sheetName, headers, rows: AsyncGenerator<unknown[]>}`:`opts.headerRow` 1 基。Task 2 定义;Task 4 消费(`{ headerRow: source.headerRow }`,规则存 1 基);Task 6 `toolExportSourceCsv` 消费(`{ headerRow: opts?.headerRow ?? 1 }`)。一致。
- `buildColIndex(headers): Map<string, number>` + `applyMappingRow(row, colIndex, mappings): TransformedRow`(缺列→null):Task 3 定义,Task 4 消费。一致。
- `insertRowsInBatches(db, tableName, colDefs, rows: Iterable|AsyncIterable, opts?) → Promise<WriteResult>`(失败 rethrow ETL_INSERT_FAILED):Task 3 定义,Task 4 消费(`produceRows()` 是 AsyncGenerator)。`writeBigTable` 委托保签名。一致。
- `QUERY_DEFAULT_LIMIT` + `QueryOutcome.truncated?` + `toolQuery(ws, sql, folder?, limit?)`:Task 5 定义,`'query.run'` handler 消费。一致。
- `writeRowsToCsvFile(file, columns, rows) → Promise<number>` + `csvEscape`(String(v) 版):Task 6 定义,三个 tool 消费。`toolExportBigTableCsv`/`toolExportQueryCsv`/`toolExportSourceCsv` 均 `async` 返回 `Promise<{file, rows}>`;handler 已是 async、dispatch 已 await,IPC 层透明。一致。
- `saveCsvDialog(dialog: SaveDialogLike, defaultName) → Promise<string|null>`(单参数 showSaveDialog)+ `Window.onw.pickSaveCsv`:Task 7 定义,三个视图消费。一致。
- `runSqlCleanPipeline` 签名不变:Task 8。一致。
- `runCleanPipeline` 签名不变;`CleanResult` 真实形状 `{pipelineId, bigTableFolder, tableName, rowsInserted, files, warnings}`。Task 4 返回该形状。一致。

### 4. 已修正的草稿问题

- **Task 2 边界算法**:早期草稿(ExcelJS pending+blankCount、单迭代器贯穿、`row.values[0]` 行号占位符切片)随架构转向自研读取器一并废弃。最终边界全部由 Task 1 承担:`planSheetRange` 复刻 `dataBounds`+`buildRange`(含孤值列 count<2 不进 `effColCount`、`<dimension>` 取小、`dimRowStart` 前导空行偏移),`readSheetRows` 做 positional gap-fill(`rowEnd` 之外不产出 = 尾空,内部空行/行缺失 → `[]`);parser 只按名定位 + 两遍读 + 消费表头。11 个 fixture(含真文件)实证与 parseExcelFile 全 0 差异(CRLF→LF 归一化后)。
- Task 2 sheet 定位:早期只读 `sheet1.xml`;新增 `listWorkbookSheets`(解析 `xl/workbook.xml` + rels)按名定位——多 sheet、缺省取第一个、不存在返回 `null`。
- Task 2 错误/布尔单元格 fixture:早期用 `{t:'e', v:'#DIV/0!'}` 会写出 `<v>undefined</v>`(SheetJS writer 的逆 RBErr 表反查不到文本串的 bug);改为 `{t:'e', v:7}`(数值码 → 逆 RBErr 表 → `<v>#DIV/0!</v>`)。`resolveCellValue` 对 `t="e"` 产 `CellError(RBErr[raw])`,`toOutputValue` 错误码 0(#NULL!)→ `null`、其余 → `''`(复刻 SheetJS dataBounds 计数与输出行相异的行为)。
- Task 2 `opts.headerRow` 从「0 基」改回「**1 基**」,与 parser 既有 `ParseOptions` 一致;测试从 `{headerRow: 1}` 改 `{headerRow: 2}`(取第 2 行表头)。
- Task 3 `applyTransform` 只传 2 参(`raw, transform`),去掉早期草稿的 `m.outputName` 第 3 参;缺列断言从 `undefined` 改为 `null`(applyTransform 对 undefined 返回 null)。
- Task 3 `insertRowsInBatches` 从「catch-and-continue」改为「**失败 rethrow ETL_INSERT_FAILED + 日志**」——既有 etl.test.ts 要求 writeBigTable reject;对应测试从「失败行被捕获记录」改为 `rejects.toThrow`。
- Task 4 `CleanResult` 返回形状:从草稿 `{pipelineId, rows, tableName, elapsedMs, warnings}` 改为真实 `{pipelineId, bigTableFolder, tableName, rowsInserted, files, warnings}`;不再有 `elapsedMs`;不再重复添加 150k 测试(既有已覆盖)。
- Task 5 两个测试用例合并为一个自包含用例(避免跨用例数据耦合);import `toolQuery`。
- Task 6 `csvEscape` 从「带 Date→ISO/JSON 分支」改回 **tools.ts 原样 `String(v)` 版**(Date 分支会改变 Date 单元格输出,破坏字节一致);默认路径从 `ws.onworkingDir/exports` 改为 `ws.root/exports`;保留非 SELECT AppError(`only SELECT/WITH…`);空大表导出保留 `cfg.fields.map(f=>f.name)` 表头回退;血缘过滤 `!c.startsWith('__')`;`handlers.ts`/`contracts.ts`/`handlers.test.ts` 均**无需改**(handler 已 async、dispatch 已 await)。
- Task 7 `saveCsvDialog` 用**单参数重载**(无窗口句柄的 app 级对话框),electron 接线用 `dialog as unknown as SaveDialogLike` 强转。
- Task 8 空结果判定用 `iter.next()`(不能靠 `columns.length === 0`,`stmt.columns()` 对 0 行也返回列结构);`inserted` 从 1 起并包含 `first.value`。
- Task 9 集成用例改为沿用该文件既有的造数/save 辅助,`bookSST: true` + 确定性备注文本抽查无 U+FFFD;不引用不存在的 `importFile` 辅助。仓库无 `measure-onw2.ps1`,手工验收步骤完整给出。

---

## Execution Handoff

计划已保存。执行选项见交付消息。
