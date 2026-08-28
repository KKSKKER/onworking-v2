# ETL 内存流式化设计(Phase 1 + 2 合并:含 ExcelJS 真流式解析)

日期:2026-08-28
状态:待用户审阅
关联:性能问题根因调查(实测数据见下);本版将原「范围外」的 Phase 2(ExcelJS 真流式)纳入主计划。

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

- **Phase 2 纳入主计划**:ExcelJS `stream.xlsx.WorkbookReader` 真流式解析 `.xlsx`,峰值**不再随文件大小涨**(目标 ~200MB)。用户明确要求「必须做 Phase 2」。
- **ExcelJS `{stream:true}` 解码补丁必需**:spike 实测 ExcelJS 4.4.0 流式读 12.5MB sharedStrings.xml 会把多字节字符切裂成 U+FFFD(296 个不同字符串 / 556 格)。根因:`lib/utils/browser-buffer-decode.js` 模块级 `new TextDecoder('utf-8')`,`parse-sax.js` 对每个读块调 `decode(chunk)` 不带 `{stream:true}`,块边界切在多字节序列中间即损坏。补丁改 `decode(chunk, {stream:true})`。**已用真实文件验证**:补丁后行数 207,508 / 表头 / 全部值逐字节一致,真字符差异 = 0。
- **CRLF→LF 归一化接受(用户拍板)**:saxes 按 XML 1.0 规范把字面 CR 归一化为 LF,实测 3770 格(如摘要 `...Nilotinib Hard Capsules\r\n) 欧盟` 变 `\n`)。**不做**字节级复刻(`0x0D→&#13;` 预处理弃用),spec 文档化为已知差异。Excel 渲染无感。
- **`.xls` 旧格式回退 SheetJS 全量解析(用户接受)**:ExcelJS 不读 `.xls`(BIFF)。`.xls` 文件的 clean/导出峰值仍随文件大小涨,文档化为已知限制(真实数据均为 `.xlsx`)。
- 墙钟接受劣化:ExcelJS 流式比 SheetJS 慢,目标 ≤60s(现状 22.5s),换内存有界。

## 目标与验收标准

以真实 `特瑞 seq` 文件(10.75MB / 20.7 万行)为验收基准:

1. **clean 管线峰值内存 ~1,049 MB → ≤ 250 MB(目标 ~200MB),且不随文件大小涨**(ExcelJS 每次只驻留一行单元格)。
2. sql-clean 峰值 **403 MB → < 200 MB**。
3. SQL 工作台无 LIMIT 查询后端自动封顶,不再全表物化 + 119MB JSON 过 IPC。
4. 三条 CSV 导出路径改为流式游标写盘,O(全表)→ O(1);前端弹文件保存框由用户指定路径。
5. **行为不变(含 ExcelJS 路径)**:
   - 行数 207,508、金额分/日期/格式蔓延边界、血缘列、重复表头告警、单文件跳过告警、CSV 字节输出(无 BOM)与现状一致。
   - **已接受例外**:单元格文本内嵌换行 CRLF→LF 归一化;`.xls` 文件峰值不封顶;声明 `<dimension>` 低估数据的罕见畸形文件按真实数据读全。
   - **不得出现 U+FFFD 字符**(补丁失效的强信号)。
6. `npm test` + `npm run typecheck` 全绿;用现有 `measure-onw2.ps1` 复测达标;墙钟记录对比(目标 ≤60s)。

## 架构决策

**解析层**:`.xlsx` 一律走 ExcelJS `WorkbookReader` 流式(clean、source-CSV 导出)。SheetJS 保留给:preview / setup / detectSource 等交互小预览、`.xls` 回退、以及所有现有 `parseExcelFile` / `parseExcelSheet` / `parseCsvFile` 调用点。新增依赖 `exceljs@4.4.0`(纯 JS,无原生绑定)。

**解码补丁**:把 `node_modules/exceljs/lib/utils/browser-buffer-decode.js` 的 `textDecoder.decode(chunk)` 改为 `decode(chunk, {stream:true})`,以 checked-in 补丁文件在 `postinstall`(扩展现有 `scripts/postinstall-dual-abi.js`)里应用,不引 patch-package 新工具。**运行时 monkey-patch 无效**(parse-sax 模块加载时解构导出),必须改源文件。pin exceljs 版本。

**改动边界**:只改核心数据路径(parser / clean-runner / engine / sql-clean-runner / export / 前端导出交互)+ 打包(postinstall 补丁)。小预览路径保留全量 API 不动。

## 组件设计

### ① `src/core/ingest/parser.ts` — 新增 `.xlsx` 流式行读取 API

现有 `parseExcelFile` / `parseExcelSheet` / `parseCsvFile`(供 preview/setup/agent 小预览)**原样保留**。新增:

```ts
export interface SheetRowStream {
  sheetName: string;
  headers: string[];                       // 与现有 trimTrailingEmpty + String().trim() 语义一致
  rows: AsyncIterableIterator<unknown[]>;  // 逐行惰性产出(异步,ExcelJS 流式)
}
export function readExcelSheetStream(
  filePath: string,
  sheetName?: string,                      // 省略 → 第一个 sheet
  opts?: ParseOptions,                     // 仅 headerRow 生效
): Promise<SheetRowStream>
```

**`.xlsx` 路径(ExcelJS 流式)实现要点:**
- `new ExcelJS.stream.xlsx.WorkbookReader(filePath)` → 迭代到目标 sheet;headers 取第 `headerRowIdx` 行(trim + String().trim),后续逐行产出。
- **值兼容层**(与 SheetJS `raw:true` 对齐,逐单元格):
  - 数字/字符串/布尔 → 原样;`null/undefined` → `''`(defval)。
  - `Date` 实例 → Excel 序列号 `(d.getTime()/86400000)+25569`(SheetJS raw 对日期格给序列号;本文件实测日期列直接是数字,兼容层防御性处理)。
  - `{formula, result}` → 取 `result`(缺失 → `''`);富文本 `{richText:[...]}` → 拼接 text;超链接对象 → 取 `.text`。
- **格式蔓延边界(流式版,已用真实文件验证等价)**:
  - `rowEnd` = 最后一个「有值」行;`colEnd` = 有 ≥2 个值的最大列(与 `dataBounds` 同规则,但边流边统计)。
  - 产出所有 `[headerRowIdx+1, rowEnd]` 的行(含中间空行 → `[]`),**丢弃尾部空行**(保持一个尾部空行缓冲,遇非空行 flush、EOF 丢弃)——与 SheetJS `buildRange` 行截断等价。
  - 列:每行按 `trimTrailingEmpty` 裁剪,不显式截 `colEnd`;**孤值列(某列全表 <2 值)里被映射的单元格本应被 SheetJS 丢弃**——此边缘在真实 fixture 与特瑞文件上实测不存在(0 差异),文档化为已知边缘;如 parity 测试暴露,升级为「含 count<2 列单元格的行进 pending 缓冲」方案(有界内存、精确)。
  - 声明 `<dimension>` 不暴露于 WorksheetReader(实测 `dimensions.model` 恒 0),行/列边界全部按流式真实值计算;声明范围低估数据的畸形文件行为略变(按真实数据读全),文档化。
- **不得出现 U+FFFD** —— 由 ⑤ 补丁保证。

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

### ⑤ ExcelJS 解码补丁(patch + postinstall)

- 新增补丁文件 `patches/exceljs+4.4.0-utf8-stream.patch`:`lib/utils/browser-buffer-decode.js` 的 `textDecoder.decode(chunk)` → `textDecoder.decode(chunk, {stream:true})`。
- 扩展现有 `scripts/postinstall-dual-abi.js`(或直接追加到 `package.json` 的 `postinstall`):每次 `npm install` 时对 `node_modules/exceljs` 应用该补丁(patch 前校验文件指纹,已打则跳过)。
- `package.json` 依赖新增 `exceljs: ^4.4.0`(pin 次版本,防 patch 失效)。
- 打包链路:补丁在 `npm run build:dual-abi`/`dist` 之前生效,`node_modules/exceljs` 被 electron-builder 自动打进生产依赖。

## 测试计划(TDD,先写失败测试)

- `tests/core/parser.test.ts`:新增 `readExcelSheetStream` 用例——
  - **ExcelJS 逐字节 parity**:同一 fixture(.xlsx)流式输出与 `parseExcelFile` 输出逐单元格一致(复用现有 fixture 文件);真实 特瑞 文件行数 207,508 / 表头 / 值一致(CR 归一化后相等)。
  - 兼容层:Date 单元格 → 序列号;公式单元格 → result;富文本 → 拼接;null → `''`。
  - 边界:中间空行保留为 `[]`、尾部空行丢弃、headerRow 偏移、首个 sheet 回退、`.xls` 回退路径回归。
  - **孤值列边缘**:构造含 count<2 尾列(有映射表头)的 fixture,断言行为与预期一致(文档化边缘,如触发则升级 pending 缓冲)。
- `tests/core/pipeline-clean-stream.test.ts`(或扩 clean-runner.test.ts):流式 clean 后 DB 行数与 fixture 完全一致;非 5000 整数倍余量 flush;单文件报错跳过与告警保留;血缘列一致。
- `tests/core/etl.test.ts`:`applyMappingRow` 与 `applyMapping` 逐行等价。
- `tests/core/pipeline-integration.test.ts`:clean → sql-clean → query 全链路,行数与值一致。
- `tests/core/pipeline-engine.test.ts`:queryOn 无 LIMIT 注入 5000 + `truncated=true`;显式 limit 优先;已有 LIMIT 不重复注入;尾部分号剥离;非 SELECT 写语句不受影响。
- `tests/core/sql-clean-runner` / query-runner 相关:游标结果与旧 `.all()` 结果一致(空结果集、行数)。
- `tests/core/export`(新):三个导出工具流式输出字节与旧实现逐字节一致(无 BOM、`csvEscape`、列顺序、换行符);空表仅表头。
- **补丁行为测试**:生成一个 sharedStrings >64KB 的 fixture(数千条不同 CJK 字符串,保证读块切到多字节字符),流式解析后**断言无 U+FFFD**;并断言 node_modules 里 `browser-buffer-decode.js` 已含 `{stream:true}`(补丁落地检查)。
- `tests/ipc/handlers.test.ts`/`tests/main/cli-bridge.test.ts` 模式参照:save-csv IPC handler 通过 `dialog.showSaveDialog` mock 测试。

## 验收与回归

1. 现有 `npm test` + `npm run typecheck` 全绿。
2. 用 `%TEMP%\measure-onw2.ps1` 在真实工作区复测:
   - **clean 峰值 ≤250MB**(与 1,049MB 对比),且用更大文件(如 2× 特瑞)验证峰值不随行数线性涨;
   - sql-clean 峰值 <200MB;
   - 行数仍为 207,508;导出 CSV 与旧内容一致(CR 归一化外);
   - 墙钟记录对比,目标 ≤60s。
3. 手工冒烟:SqlView 无 LIMIT 查询显示截断提示;三处 CSV 导出弹保存框、导出文件与旧内容一致;含摘要内嵌换行的行在 Excel 打开正常。

## 范围外(本次明确不做)

- `.xls` 真流式解析(无现成流式 xls 解析器;保持 SheetJS 全量回退)。
- 大 CSV 的 clean 解析流式化(`parseCsvFile` 全量读入)。
- 解析/清洗挪 worker 线程(当前引擎已在独立 node 子进程,收益有限,优先级低)。
- Electron 基线内存优化(需先解决本机打包版启动即退的问题)。
- CRLF 字节级复刻(`0x0D→&#13;` 预处理)。

## 风险

- **ExcelJS 墙钟劣化**(比 SheetJS 慢 2~3x)→ 接受并以 ≤60s 为目标,实现后实测记录;若严重超预期,评估 ExcelJS 流式选项(如 `worksheets: 'emit'`)。
- **补丁脆弱**(exceljs 升级即失效)→ pin 4.4.0 + 补丁落地检查测试 + 无 U+FFFD 行为测试三重兜底。
- **孤值列边缘**(count<2 的映射列单元格)→ 真实数据实测不存在;parity 测试兜底,触发则升级 pending 缓冲方案。
- **`<dimension>` 不暴露** → 边界全部按流式真实值;声明低估数据的畸形文件行为略变(文档化)。
- **公式/富文本/日期单元格兼容** → compat 层 + 专项 fixture 测试。
- 进度语义简化对 UI 的影响 → 实现时确认前端对 stage/percent 的消费方式。
- CSV 字节一致性(BOM、转义)需要逐字节对比测试兜底。
- 自动封顶可能影响用户对聚合/大结果的习惯用法 → 以截断提示 + 引导导出 CSV 缓解,不做隐藏截断。
