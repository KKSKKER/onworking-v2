# ETL 内存流式化设计(Phase 1 + 2 合并:含自研流式解析)

日期:2026-08-28
状态:已批准(架构自 ExcelJS 转向自研读取器,2026-08-28 用户批复「继续」)
关联:性能问题根因调查(实测数据见下);本版将原「范围外」的 Phase 2(自研流式读取器)纳入主计划。

## 背景与动机

同事反馈「用了这个软件之后整台电脑变卡」,针对 ThinkPad 级办公本(2 核 4 线程低压 CPU、8GB 内存)做了实测采样。引擎进程(`node dist/main/cli/index.js`,与打包应用内部同一引擎)在真实工作区(特瑞药业,`特瑞序时账24-2603.xlsx` 10.75MB、20.7 万行)上:

| 场景 | 峰值内存 | 墙钟 | CPU |
|---|---|---|---|
| 空闲(打开工作区) | ~68 MB | 常驻 | 0 |
| **clean 清洗管线**(解析 Excel → 写入 76MB 库) | **~1,049 MB** | **22.5 s** | **单核 ~97%** |
| sql-clean 归集(物化 20.7 万行到总表) | ~403 MB | 8.4 s | 68% 单核 |
| SQL 工作台 `SELECT *` 不限行查询 | ~496 MB + 119MB JSON 过 IPC | ~2.2 s | — |
| 连续两次 clean | 峰值 ~1,053 MB(不跨运行累积) | 48.4 s | — |

根因(按贡献排序):
1. **Excel 解析整表物化**:`XLSX.readFile` 把整个 workbook 转成 JS 对象图,10MB xlsx → 数百 MB~1GB;`parseExcelSheet` 的「只解析指定 sheet」不成立(`readFile` 始终解析全部 sheet)。
2. **clean 管线全量驻留**:`allRows` 累积 20.7 万个 JS 对象;峰值时 workbook + sheet_to_json 二维数组 + 映射对象三层同时在堆里。
3. **查询/归集/CSV 导出整表物化**:`engine.queryOn`、`sql-clean-runner`、三个 `toolExport*Csv` 均 `.all()` 全量 + 部分还拼 `lines[]` 数组才写盘。
4. **Electron 底座常年占用**(主进程+渲染+GPU+CLI 子进程,估算 400~700MB,本机无法启动采样,不在本设计处理范围)。

## 决策记录(本版新增)

- **Phase 2 纳入主计划**:自研流式读取器(unzipper 流式解压 + saxes 逐块 XML 解析)真流式解析 `.xlsx`,峰值**不再随文件大小涨**(实测最终堆 19.1MB)。用户明确要求「必须做 Phase 2」。
- **自研读取器替代 ExcelJS(用户拍板,2026-08-28 批复「继续」)**:ExcelJS 4.4.0 `WorkbookReader` 需 postinstall 打 `{stream:true}` 解码补丁避免多字节切裂 U+FFFD,且在 SheetJS 写的文件上实测崩溃;改为自研 `unzip+saxes` 读取器——saxes 正是 ExcelJS 内部用的 XML 解析器,读取器以 `TextDecoder.decode(chunk, {stream:true})` 逐块喂入,U+FFFD 从机制上消除,**不需要任何补丁**。**已用真实文件验证**:11 个 fixture(含 207,508 行真文件、前导空行、行缺失 gap、孤值列、错误/布尔单元格、单格 dimension)与旧 `parseExcelFile` **全 0 差异**(CRLF→LF 归一化后);内存实测 3.2s / 最终堆 19.1MB(512MB 上限下)。
- **CRLF→LF 归一化接受(用户拍板)**:saxes 按 XML 1.0 规范把字面 CR 归一化为 LF,实测 3770 格(如摘要 `...Nilotinib Hard Capsules\r\n) 欧盟` 变 `\n`)。**不做**字节级复刻(`0x0D→&#13;` 预处理弃用),spec 文档化为已知差异。Excel 渲染无感。
- **`.xls` 旧格式回退 SheetJS 全量解析(用户接受)**:自研读取器不读 `.xls`(BIFF)。`.xls` 文件的 clean/导出峰值仍随文件大小涨,文档化为已知限制(真实数据均为 `.xlsx`)。
- 墙钟目标 ≤60s(现状 SheetJS 22.5s;自研读取器实测 **3.2s**,反超 SheetJS,无劣化)。

## 目标与验收标准

以真实 `特瑞 seq` 文件(10.75MB / 20.7 万行)为验收基准:

1. **clean 管线峰值内存 ~1,049 MB → ≤ 250 MB(目标 ~200MB),且不随文件大小涨**(读取器逐块消费工作表 XML,每次只驻留一行单元格)。
2. sql-clean 峰值 **403 MB → < 200 MB**。
3. SQL 工作台无 LIMIT 查询后端自动封顶,不再全表物化 + 119MB JSON 过 IPC。
4. 三条 CSV 导出路径改为流式游标写盘,O(全表)→ O(1);前端弹文件保存框由用户指定路径。
5. **行为不变(含流式路径)**:
   - 行数 207,508、金额分/日期/格式蔓延边界、血缘列、重复表头告警、单文件跳过告警、CSV 字节输出(无 BOM)与现状一致。
   - **已接受例外**:单元格文本内嵌换行 CRLF→LF 归一化;`.xls` 文件峰值不封顶。
   - **不得出现 U+FFFD 字符**(解码器缺陷的强信号)。
6. `npm test` + `npm run typecheck` 全绿;用现有 `measure-onw2.ps1` 复测达标;墙钟记录对比(目标 ≤60s)。

## 架构决策

**解析层**:`.xlsx` 一律走自研读取器流式(`src/core/ingest/xlsx-reader.ts`:unzipper 流式解压 + saxes 逐块 XML 解析;clean、source-CSV 导出)。SheetJS 保留给:preview / setup / detectSource 等交互小预览、`.xls` 回退、以及所有现有 `parseExcelFile` / `parseExcelSheet` / `parseCsvFile` 调用点。新增依赖 `unzipper@^0.12.5`(纯 JS)+ `saxes@^5.0.1`(纯 JS,ExcelJS 同款 XML 解析器);unzipper 无类型声明,补 `src/types/unzipper.d.ts`。

**解码正确性(无需补丁)**:saxes 是 ExcelJS 内部用的 XML 解析器,自研读取器直接以 `TextDecoder.decode(chunk, {stream:true})` 逐块喂给它,块边界永不切裂多字节 UTF-8 —— U+FFFD 从机制上消除,不需要 postinstall 打补丁、不碰 `node_modules`。

**改动边界**:只改核心数据路径(parser / clean-runner / engine / sql-clean-runner / export / 前端导出交互)+ 新增依赖。小预览路径保留全量 API 不动。

## 组件设计

### ① `src/core/ingest/xlsx-reader.ts` — 自研 `.xlsx` 流式行读取器(新模块)

现有 `parseExcelFile` / `parseExcelSheet` / `parseCsvFile`(供 preview/setup/agent 小预览)**原样保留**。新增独立读取器模块;parser 的 `readExcelSheetStream`(见下)委托给它。

**公共类型(供 Task 2 消费):**

```ts
export class CellError { constructor(public readonly code: number) {} }   // 公式错误格,持 SheetJS 内部数值码
export function toOutputValue(v: unknown): unknown;                        // CellError:码 0(#NULL!)→ null,其余 → ''
export function resolveCellValue(t: string, isInline: boolean, raw: string,
                                 sharedStrings: string[] | null): unknown; // 逐类型复刻 SheetJS
export function trimTrailingEmpty(arr: unknown[]): unknown[];
export interface SheetPlan { headerAbs: number; rowEnd: number; effColCount: number; }
export interface XlsxWorkbook { byPath: Map<string, UnzipEntry>; sharedStrings: string[] | null; }
export function openXlsxWorkbook(filePath: string): Promise<XlsxWorkbook>;
export async function* scanSheetRows(entry: UnzipEntry, sharedStrings: string[] | null,
                                     onDimension?: (d: Dimension) => void): AsyncGenerator<{ rowIdx: number; cells: unknown[] }>;
export async function planSheetRange(entry: UnzipEntry, sharedStrings: string[] | null,
                                     headerRowIdx: number): Promise<SheetPlan>;
export async function* readSheetRows(entry: UnzipEntry, sharedStrings: string[] | null,
                                     plan: SheetPlan): AsyncGenerator<unknown[]>;
```

**`.xlsx` 读取流程(两遍:先预扫描定边界,再定位输出,均流式):**
- `openXlsxWorkbook`:unzipper `Open.file` 解出中央目录;zip 路径归一化(`\\`→`/`,兼容 Compress-Archive/WinRAR 存的反斜杠路径);saxes 解析 `xl/sharedStrings.xml` 收集共享字符串(整份驻留——与 SheetJS `readFile` 一致,实测 11.9 万串仍 0 差异;若后续内存验收超限再切片,当前不做)。
- `planSheetRange`(第一遍,拉式流扫):按 `<row r>` 统计 `maxRow`(最后有值行)与 `maxCol`(≥2 值的最右列),同时捕获 `<dimension ref>` 声明;复刻 SheetJS `buildRange`:`rowEnd=min(dim.rowEnd, max(maxRow, headerRowIdx))`、`realCol=maxCol≥0?maxCol:dim.colEnd`、`colEnd=min(dim.colEnd, realCol)`、`effColCount=colEnd+1`、`headerAbs=dim.rowStart+headerRowIdx`。
- `readSheetRows`(第二遍,定位 gap-fill):产出 `headerAbs..rowEnd` 的全部物理行;缺失 `<row>` 的 gap 用 `[]` 补齐(与 SheetJS 位置化 `sheet_to_json` 一致);每行按 `effColCount` 截/补 `''` 再 `trimTrailingEmpty`;到达 `rowEnd` 即断(尾空不产出)。错误/布尔单元格走 `resolveCellValue`(与 SheetJS `parse_ws_xml_data`/`parsexmlbool` 逐类型一致)。
- **孤值列与 SheetJS 精确一致**:count<2 的列不进 `maxCol` → 不出现在 `effColCount`,孤值格被丢弃(orphan fixture 0 差异)。
- **不得出现 U+FFFD** —— saxes + 流式 `TextDecoder` 从机制上保证(无需补丁)。
- **内存**:工作表 XML 逐块喂 saxes(`it.next()` 拉一块 → `p.write`),从未整份物化;真文件实测最终堆 19.1MB、耗时 3.2s。

**`.xls` 路径(回退)**:SheetJS `parseExcelSheet/parseExcelFile` 全量解析后包一层惰性迭代器,API 形状一致、输出一致,峰值不封顶(已知限制)。

### ② `src/core/pipeline/clean-runner.ts` — 边解析边写库,删除 `allRows`

- `src/core/etl/transform.ts` 新增逐行映射 `applyMappingRow(row, colIndex, mappings)`;现有 `applyMapping` 改为构建 colIndex 后委托它,对外签名不变。
- `src/core/etl/writer.ts` 抽出批量写入核心 `insertRowsInBatches(db, tableName, columns, rowsIterable, onBatch?)`:**接受异步迭代器**,满 5000 行一批(事务),每批 `setImmediate` 让出事件循环。`writeBigTable`(数组签名)改调用它,签名不变以兼容测试。
- `runCleanPipeline` 重写:
  - 每匹配文件按扩展名分发:`.xlsx` → `readExcelSheetStream`(流式);`.xls` → `readExcelSheetStream` 回退(SheetJS);`.csv` → 现有 `parseCsvFile`(CSV 流式仍属范围外)。
  - 由 async generator 串联「读一行 → `applyMappingRow` → 附血缘 → yield」,交给 `insertRowsInBatches`。
  - **不再有 `allRows` 数组**;`.xlsx` 时峰值不随文件大小涨(workbook 不入堆)。
  - 保留:DROP+重建大表、血缘列、重复表头告警、单文件读不了跳过并告警、`extractedAt`、批写入错误捕获。
- 进度契约:parse 与 write 流式交织,按「已处理文件数推进」——每处理完一个文件 emit `{stage:'parse', percent: filesDone/files*70}`,全部写毕 emit `{stage:'write', percent:100}`。当前前端无结构化进度条,进度事件仅以原始 JSON 行流入输出面板,只改 percent 数值、不改事件形状。

### ③a `src/core/pipeline/engine.ts` — SQL 工作台无 LIMIT 自动封顶

- 常量 `QUERY_DEFAULT_LIMIT = 5000`。
- `queryOn` 对读语句(`stmt.reader`)取生效 limit:显式传 limit → 尊重;SQL 已含 LIMIT → 不注入;否则去尾部分号注入 ` LIMIT 5000`,结果标记截断候选。
- `.all()` 后行数 === 注入 limit → `truncated = true`;`QueryOutcome` 增 `truncated?: boolean`;`toolQuery` 照常透传。
- 前端 SqlView:显示「结果已截断到 5000 行」提示,引导「需要全量用导出 CSV」(③b 已流式,不封顶)。**不做**「查看全部再放行」按钮。

### ③b CSV 导出流式化 + 前端保存弹框

**后端(3 个导出工具函数)改为游标流式写盘,不封顶不物化:**
- 新增共享工具 `writeRowsToCsvFile(file, columns, iterable)`:开写流,先写表头,逐行 `csvEscape` 增量写盘,完成后返回行数。放 `src/core/export/csv.ts`。
- **字节一致性**:现状导出为**无 BOM 的纯 UTF-8**(README 声称带 BOM,但当前 `toolExport*Csv` 均未写 BOM),流式化保持逐字节一致,**本次不引入 BOM**。
- `toolExportQueryCsv`:`db.prepare(sql).iterate()` 逐行 → 流式写。
- `toolExportBigTableCsv`:`SELECT *` 改 `.iterate()` → 流式写;列名取 `stmt.columns()`(兼容空表)。
- `toolExportSourceCsv`:`.xlsx` 源改用 `readExcelSheetStream` → 流式写;`.xls` 走 SheetJS 回退;CSV 源保留现有 parseCsvFile 路径。
- 空表/空结果集:仍输出仅表头行。

**前端保存弹框(复用现有对话框 IPC 模式):**
- `src/main/index.ts`:新增 `onw:save-csv` handler → `dialog.showSaveDialog({ title, defaultPath, filters: [{ name: 'CSV', extensions: ['csv'] }] })`,返回 `string | null`。
- `src/main/preload.ts`:暴露 `pickSaveCsv(defaultName): Promise<string | null>`;`src/renderer/global.d.ts` 补类型;`src/renderer/mock/onw-mock.ts` mock 返回默认路径。
- 三处导出按钮改「先弹框拿路径,取消则中止,否则带 `path` 调命令」:SqlView `query.exportCsv` → 默认名 `query.csv`;QueryResultView → `result.csv`;PreviewView `setup.exportCsv` / `bigtable.exportCsv` → 源文件名 `.csv` / `{folder}.csv`。

### ④ `src/core/pipeline/sql-clean-runner.ts` — `.all()` 改游标

- `const stmt = masterDb.prepare(cfg.sql); const columns = stmt.columns().map(c => c.name);`
- `for (const row of stmt.iterate())` 逐行 → 满 5000 批事务 INSERT 进总表 → 清空;最后 flush 余量。
- 保留:DROP+重建 resultTable、ATTACH/DETACH、`main."..."` 限定、空结果集建 `(empty INTEGER)` 行为。
- 不物化全表(403MB → <200MB)。

### ⑤ 自研读取器 `xlsx-reader.ts`(无补丁,依赖即正确性)

- 新增依赖:`unzipper: ^0.12.5`(已随 app-builder-lib 传递安装,需升为直接依赖)+ `saxes: ^5.0.1`。两者纯 JS,无原生绑定。
- unzipper 无类型声明(`types: NONE`),新增 `src/types/unzipper.d.ts` 声明本项目用到的子集(`Open.file` → `dir.files[]` → `entry.stream()/buffer()`);tsconfig `include: ["src"]` 自动收录。
- 打包链路:两个依赖被 electron-builder 自动打进生产依赖,无 postinstall 动作。

## 测试计划(TDD,先写失败测试)

- `tests/core/xlsx-reader.test.ts`(新):读取器单元 + parity 用例——
  - **逐字节 parity**:同一 fixture(.xlsx)流式输出与 `parseExcelFile` 输出逐单元格一致;真实 特瑞 文件行数 207,508 / 表头 / 值一致(CR 归一化后相等)。
  - `resolveCellValue` 逐类型:t="s"(共享字符串查表,空 raw→'')、t="str"、t="b"(parsexmlbool 语义:仅 1/true/TRUE 为真)、t="e"(错误文本→数值码 `CellError`)、inlineStr、默认 parseFloat(空→'')。
  - `toOutputValue`:CellError 码 0(#NULL!)→ null,其余 → ''。
  - 边界:中间空行保留为 `[]`、尾部空行丢弃、行缺失 gap 补 `[]`、headerRow 偏移、前导空行(dimRowStart>0)。
  - **孤值列**:构造含 count<2 尾列的 fixture,断言与 `parseExcelFile` 0 差异(orphan 实测通过,不再需要 pending 缓冲升级)。
- `tests/core/parser.test.ts`:新增 `readExcelSheetStream` 用例——首个 sheet 回退、`.xls` 回退路径回归、与 `parseExcelFile` 行数/表头一致。
- `tests/core/pipeline-clean-stream.test.ts`(或扩 clean-runner.test.ts):流式 clean 后 DB 行数与 fixture 完全一致;非 5000 整数倍余量 flush;单文件报错跳过与告警保留;血缘列一致。
- `tests/core/etl.test.ts`:`applyMappingRow` 与 `applyMapping` 逐行等价。
- `tests/core/pipeline-integration.test.ts`:clean → sql-clean → query 全链路,行数与值一致。
- `tests/core/pipeline-engine.test.ts`:queryOn 无 LIMIT 注入 5000 + `truncated=true`;显式 limit 优先;已有 LIMIT 不重复注入;尾部分号剥离;非 SELECT 写语句不受影响。
- `tests/core/sql-clean-runner` / query-runner 相关:游标结果与旧 `.all()` 结果一致(空结果集、行数)。
- `tests/core/export`(新):三个导出工具流式输出字节与旧实现逐字节一致(无 BOM、`csvEscape`、列顺序、换行符);空表仅表头。
- **解码正确性测试**:生成一个 sharedStrings >64KB 的 fixture(数千条不同 CJK 字符串,保证读块切到多字节字符),流式解析后**断言无 U+FFFD**(覆盖 `xlsx-reader` 的流式 `TextDecoder` 路径)。
- `tests/ipc/handlers.test.ts`/`tests/main/cli-bridge.test.ts` 模式参照:save-csv IPC handler 通过 `dialog.showSaveDialog` mock 测试。

## 验收与回归

1. 现有 `npm test` + `npm run typecheck` 全绿。
2. 在真实工作区复测(用 `%TEMP%\measure-onw2.ps1`;该脚本若不存在,按计划 Task 9 手工步骤):
   - **clean 峰值 ≤250MB**(与 1,049MB 对比),且用更大文件(如 2× 特瑞)验证峰值不随行数线性涨;
   - sql-clean 峰值 <200MB;
   - 行数仍为 207,508;导出 CSV 与旧内容一致(CR 归一化外);
   - 墙钟记录对比,目标 ≤60s。
3. 手工冒烟:SqlView 无 LIMIT 查询显示截断提示;三处 CSV 导出弹保存框、导出文件与旧内容一致;含摘要内嵌换行的行在 Excel 打开正常。

## 范围外(本次明确不做)

- `.xls` 真流式解析(无现成流式 xls 解析器;保持 SheetJS 全量回退)。
- 共享字符串切片化/分块(当前整份驻留;实测 11.9 万串仍 0 差异、内存达标,不做;若后续峰值超限再评估)。
- 大 CSV 的 clean 解析流式化(`parseCsvFile` 全量读入)。
- 解析/清洗挪 worker 线程(当前引擎已在独立 node 子进程,收益有限,优先级低)。
- Electron 基线内存优化(需先解决本机打包版启动即退的问题)。
- CRLF 字节级复刻(`0x0D→&#13;` 预处理)。

## 风险

- **流式两遍读**(预扫描 + 输出各一遍 XML)→ 墙钟约 2× 单遍;实测 3.2s 仍远低于 60s 目标,接受。
- **自研解析器正确性风险**(XML 状态机 / 边界算法手写)→ 以 11 个 fixture 全量 parity 测试兜底(含真文件 207,508 行、前导空行、行缺失 gap、孤值列、错误/布尔单元格),任何行为回归立即可见。
- **孤值列边缘**(count<2 的映射列单元格)→ 自研读取器与 SheetJS 同为「count≥2 才入列」,orphan fixture 0 差异;parity 测试兜底。
- **`<dimension>` 解析** → 已从 `<dimension ref>` 捕获行/列声明,行为与 SheetJS `buildRange` 取小一致(single-cell / lead-blank / row-gap fixture 0 差异)。
- **公式错误/布尔/内联字符串单元格** → `resolveCellValue` 逐类型复刻 SheetJS(ezt / err fixture 0 差异)。
- 进度语义简化对 UI 的影响 → 实现时确认前端对 stage/percent 的消费方式。
- 进度语义简化对 UI 的影响 → 实现时确认前端对 stage/percent 的消费方式。
- CSV 字节一致性(BOM、转义)需要逐字节对比测试兜底。
- 自动封顶可能影响用户对聚合/大结果的习惯用法 → 以截断提示 + 引导导出 CSV 缓解,不做隐藏截断。
