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
  // 用对象 box 承接回调写入:TS 窄化看不到闭包赋值,直接 let 会被当恒 null(真分支 never)。
  const dimBox: { value: Dimension | null } = { value: null };
  for await (const { rowIdx, cells } of scanSheetRows(entry, sharedStrings, (d) => { dimBox.value = d; })) {
    for (let c = 0; c < cells.length; c++) {
      const v = cells[c];
      if (v === '' || v === undefined || v === null) continue;
      if (rowIdx > maxRow) maxRow = rowIdx;
      colCount.set(c, (colCount.get(c) ?? 0) + 1);
    }
  }
  const dim = dimBox.value;
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
