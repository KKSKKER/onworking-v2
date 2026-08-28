# ETL 内存流式化设计(Phase 1)

日期:2026-08-28
状态:待用户审阅
关联:性能问题根因调查(实测数据见下)

## 背景与动机

同事反馈「用了这个软件之后整台电脑变卡」,针对 ThinkPad 级办公本(2 核 4 线程低压 CPU、8GB 内存)做了实测采样。引擎进程(`node dist/main/cli/index.js`,与打包应用内部同一引擎)在真实工作区(特瑞药业,`特瑞序时账 2024-2603.xlsx` 10.75MB、20.7 万行)上:

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

## 目标与验收标准

以真实 `特瑞 seq` 文件(10.75MB / 20.7 万行)为验收基准:

1. clean 管线峰值内存 **~1,049 MB → ≤ 700 MB**(目标 500~700MB)。
2. sql-clean 峰值 **403 MB → < 200 MB**。
3. SQL 工作台无 LIMIT 查询后端自动封顶,不再全表物化 + 119MB JSON 过 IPC。
4. 三条 CSV 导出路径改为流式游标写盘,O(全表)→ O(1);前端弹文件保存框由用户指定路径。
5. **行为完全不变**:行数 207,508、金额分/日期/格式蔓延边界、血缘列、重复表头告警、单文件跳过告警、CSV 字节输出(含 BOM 语义)与现状一致。
6. `npm test` + `npm run typecheck` 全绿;用现有 `measure-onw2.ps1` 复测达标。

## 架构决策

**Excel 解析**:留用 SheetJS(社区版),新增**流式读取 API + dense 密集模式**,不做全量数组物化。不引入新依赖。ExcelJS 真流式解析(把 workbook 下限也去掉,峰值→~200MB)列为 Phase 2 单独立项,需要先用真实文件建行为验证基准再切。

**改动边界**:只改核心数据路径(parser / clean-runner / engine / sql-clean-runner / export / 前端导出交互)。`setup.preview` / `setup.sheets` / `setup.detectSource` 等小预览路径保留现有全量 API 不动。

## 组件设计

### ① `src/core/ingest/parser.ts` — 新增流式行读取 API

现有 `parseExcelFile` / `parseExcelSheet` / `parseCsvFile`(供 preview/setup/agent 小预览)**原样保留**。新增:

```ts
export interface SheetRowStream {
  sheetName: string;
  headers: string[];              // 与现有 trimTrailingEmpty + String().trim() 语义一致
  rows(): IterableIterator<unknown[]>;  // 逐行惰性产出,已逐行 trimTrailingEmpty,与 headers 对齐
}
export function readExcelSheetStream(
  filePath: string,
  sheetName: string,
  opts?: ParseOptions,            // 仅 headerRow 生效
): SheetRowStream
```

实现要点:
- `XLSX.readFile(filePath, { dense: true })` —— dense 模式用数组存单元格,降低 workbook 对象开销。
- 复用现有 `dataBounds` + `buildRange`(真实有值行/列与 `!ref` 取小)保留**格式蔓延边界**;将有效 range 写回 `ws['!ref']` 后再流式转换。
- `XLSX.stream.to_json(ws, { header: 1, defval: '', raw: true })` 惰性产出行数组;跳过前 `headerRowIdx` 行,第 `headerRowIdx` 行作表头,后续逐行 `yield`。
- 与现有输出**逐字节一致**:表头 trim、逐行 `trimTrailingEmpty`、raw 值语义、边界行为。流式 API 只保证 clean 与导出用,预览路径不动。
- 风险点:`XLSX.stream.to_json` 的 range/迭代方式需在实现时用现有 fixture 验证;若 range 不受支持,采用改写 `ws['!ref']` 方案(已列)。dense 模式下 `sheet_to_json`/stream 均受支持。

### ② `src/core/pipeline/clean-runner.ts` — 边解析边写库,删除 `allRows`

现状 `allRows` 全量累积(1GB 的一半来源)改掉:

- `src/core/etl/transform.ts` 新增逐行映射:`applyMappingRow(row: unknown[], colIndex: Map<string, number>, mappings)`;现有 `applyMapping` 改为构建 colIndex 后委托它,保持对外签名不变。
- `src/core/etl/writer.ts` 抽出批量写入核心 `insertRowsInBatches(db, tableName, columns, rowsIterable, onBatch?)`:满 5000 行一批(事务),每批 `setImmediate` 让出事件循环以保 IPC 进度流式可达。`writeBigTable`(数组签名)改调用它,签名不变以兼容测试。
- `runCleanPipeline` 重写:
  - 每个匹配文件:`readExcelSheetStream(file, sheetName, { headerRow })`(CSV 走现有 `parseCsvFile`,CSV 流式属 Phase 2)。
  - 由 generator 串联「读一行 → `applyMappingRow` → 附血缘 → yield」,交给 `insertRowsInBatches`。
  - **不再有 `allRows` 数组**;workbook 是唯一驻留对象。
  - 保留:DROP+重建大表、血缘列、重复表头告警、单文件读不了跳过并告警、`extractedAt`、批写入错误捕获。
- 进度契约:parse 与 write 流式交织,进度改为「按已处理文件数推进」——`scan` 后每处理完一个文件 emit `{stage:'parse', percent: filesDone/files*70}`,全部文件写毕 emit `{stage:'write', percent:100}`。当前前端无结构化进度条,进度事件仅以原始 JSON 行流入输出面板,此变更只改 percent 数值、不改事件形状。

### ③a `src/core/pipeline/engine.ts` — SQL 工作台无 LIMIT 自动封顶

- 常量 `QUERY_DEFAULT_LIMIT = 5000`。
- `queryOn` 对读语句(`stmt.reader`)取生效 limit:
  - 显式传 `limit` → 尊重之;
  - SQL 已含 `LIMIT` 子句 → 不注入;
  - 否则 → 去尾部分号后注入 ` LIMIT 5000`,结果标记截断候选。
- `.all()` 后若行数 === 注入 limit → `truncated = true`。
- `QueryOutcome` 增加 `truncated?: boolean`;`toolQuery` 照常透传。
- 前端 SqlView:显示「结果已截断到 5000 行」提示,引导「需要全量用导出 CSV」(③b 已流式,不封顶)。**不做**「查看全部再放行」按钮——工作台展示封顶,全量走导出。

### ③b CSV 导出流式化 + 前端保存弹框

**后端(3 个导出工具函数)改为游标流式写盘,不封顶不物化:**
- 新增共享工具 `writeRowsToCsvFile(file, columns, iterable)`:开写流,先写表头,逐行 `csvEscape` 增量写盘,完成后返回行数。放 `src/core/export/csv.ts`。
- **字节一致性**:现状导出为**无 BOM 的纯 UTF-8**(README 声称带 BOM,但当前 `toolExport*Csv` 均未写 BOM),流式化保持逐字节一致,**不在本次引入 BOM**(引入即行为变更,如需留待单独决策)。
- `toolExportQueryCsv`:`db.prepare(sql).iterate()` 逐行 → 流式写。
- `toolExportBigTableCsv`:`SELECT *` 改 `.iterate()` → 流式写;列名取 `stmt.columns()`(不再依赖首行 key,兼容空表)。
- `toolExportSourceCsv`:Excel 源改用 `readExcelSheetStream` → 流式写;CSV 源**保留现有 parseCsvFile 路径**(CSV 流式属 Phase 2),仅接上 `path` 参数。
- 空表/空结果集:仍输出仅表头行,与现状一致。

**前端保存弹框(复用现有对话框 IPC 模式):**
- `src/main/index.ts`:新增 `onw:save-csv` handler → `dialog.showSaveDialog({ title, defaultPath, filters: [{ name: 'CSV', extensions: ['csv'] }] })`,返回 `string | null`。
- `src/main/preload.ts`:暴露 `pickSaveCsv(defaultName: string): Promise<string | null>`。
- `src/renderer/global.d.ts`:补类型。
- `src/renderer/mock/onw-mock.ts`:mock 返回默认路径(演示可用)。
- 三处导出按钮改「先弹框拿路径,取消则中止,否则带 `path` 调命令」:
  - SqlView `query.exportCsv` → 默认名 `query.csv`。
  - QueryResultView `query.exportCsv` → 默认名 `result.csv`。
  - PreviewView `setup.exportCsv` / `bigtable.exportCsv` → 默认名源文件名 `.csv` / `{folder}.csv`。

### ④ `src/core/pipeline/sql-clean-runner.ts` — `.all()` 改游标

- `const stmt = masterDb.prepare(cfg.sql); const columns = stmt.columns().map(c => c.name);`
- `for (const row of stmt.iterate())` 逐行 → 满 5000 批事务 INSERT 进总表 → 清空;最后 flush 余量。
- 保留:DROP+重建 resultTable、ATTACH/DETACH、`main."..."` 限定、空结果集建 `(empty INTEGER)` 行为。
- 不物化全表(403MB → 目标 <200MB)。

## 测试计划(TDD,先写失败测试)

- `tests/core/parser.test.ts`:新增 `readExcelSheetStream` 用例 —— 表头/行值与 `parseExcelFile` 逐字节一致(复用现有 fixture 文件)、格式蔓延边界、只取目标 sheet、headerRow 偏移、空行/尾部空列 trim 一致。
- `tests/core/clean-runner.test.ts`:流式 clean 后 DB 行数与 fixture 完全一致;行数非 5000 整数倍的余量 flush 正确;单文件报错跳过与告警保留;血缘列一致。
- `tests/core/etl.test.ts`:`applyMappingRow` 与 `applyMapping` 逐行等价。
- `tests/core/pipeline-integration.test.ts`:clean → sql-clean → query 全链路,行数与值一致。
- `tests/core/pipeline-engine.test.ts`:queryOn 无 LIMIT 注入 5000 + `truncated=true`;显式 limit 优先;已有 LIMIT 不重复注入;尾部分号剥离;非 SELECT 写语句不受影响。
- `tests/core/sql-clean-runner` / query-runner 相关:游标结果与旧 `.all()` 结果一致(空结果集、行数)。
- `tests/core/export`(新):三个导出工具流式输出字节与旧实现逐字节一致(无 BOM、`csvEscape`、列顺序、换行符);空表仅表头。
- `tests/ipc/handlers.test.ts`/`tests/main/cli-bridge.test.ts` 模式参照:save-csv IPC handler 通过 `dialog.showSaveDialog` mock 测试。

## 验收与回归

1. 现有 `npm test` + `npm run typecheck` 全绿。
2. 用 `%TEMP%\measure-onw2.ps1` 在真实工作区复测:
   - clean 峰值 ≤700MB(与 1,049MB 对比);
   - sql-clean 峰值 <200MB;
   - 行数仍为 207,508;
   - 墙钟不显著劣化(SheetJS dense 通常相当或略快)。
3. 手工冒烟:SqlView 无 LIMIT 查询显示截断提示;三处 CSV 导出弹保存框、导出文件与旧内容一致。

## 范围外(Phase 2 单独立项)

- ExcelJS 真流式解析(去 workbook 下限,峰值 →~200MB)。
- 大 CSV 的 clean 解析流式化(`parseCsvFile` 全量读入)。
- 解析/清洗挪 worker 线程(降低单核饱和;当前引擎已在独立 node 子进程,收益有限,优先级低)。
- Electron 基线内存优化(需先解决本机打包版启动即退的问题)。

## 风险

- `XLSX.stream.to_json` 的 range 语义与 dense 模式兼容性 → 用现有 fixture 先行验证,失败则走 `ws['!ref']` 改写方案。
- 进度语义简化对 UI 的影响 → 实现时确认前端对 stage/percent 的消费方式。
- CSV 字节一致性(BOM、转义)需要逐字节对比测试兜底,避免导出内容悄悄变化。
- 自动封顶可能影响用户对聚合/大结果的习惯用法 → 以截断提示 + 引导导出 CSV 缓解,不做隐藏截断。
