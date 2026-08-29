# Onworking Agent 操作手册

> 适用对象：所有操作 Onworking 工作区的 AI Agent。

---

## 打包版本 CLI 使用说明（重要）

本目录是 Onworking 的打包版本。CLI 必须通过 `Onworking.exe` 的 `ELECTRON_RUN_AS_NODE` 模式运行，不能用系统 `node`，否则 SQLite 原生模块会 ABI 不匹配。

### 调用方式（Windows PowerShell）

```powershell
# 1. 设置环境变量（让 Onworking.exe 当 Node 运行）
$env:ELECTRON_RUN_AS_NODE = 1

# 2. 通过管道发送 NDJSON 命令
@(
  '{"reqId":1,"cmd":"workspace.open","path":"D:/path/to/workspace"}',
  '{"reqId":2,"cmd":"state.summary"}',
  '{"reqId":3,"cmd":"query.run","sql":"SELECT * FROM salary_clean LIMIT 10"}'
) | .\Onworking.exe .\resources\app\dist\main\cli\index.js
```

- CLI 入口：`resources\app\dist\main\cli\index.js`
- 工作区通过 `workspace.open` 命令打开，也可以在启动时追加 `open <path>` 参数
- 输出通过 stdout 返回 NDJSON，每行一条响应
- 注意：PowerShell 管道下进程退出码可能异常，用 `2>&1 | Out-File` 重定向到文件可稳定捕获输出

### MCP 模式

```powershell
$env:ELECTRON_RUN_AS_NODE = 1
.\Onworking.exe .\resources\app\dist\main\cli\index.js mcp
```

MCP 模式通过 stdin/stdout 传输 JSON-RPC 2.0，可在任意 MCP 客户端（Claude Desktop、Cursor 等）中配置使用。

---

## 0. 本手册的强制力

本手册是操作 Onworking 工作区的**最高行为约束**。

- **唯一合法操作途径**：只能调用本手册「第 3 节命令清单」列出的命令。
- 除清单内命令外，**禁止**使用任何其他工具、命令行、脚本去查看或修改文件。
- 违反即视为错误操作：停止当前动作，改用清单内命令。

---

## 1. 数据架构与标准使用链（必读）

**数据流向是两段式，最终产物是总表 master.db，不是大表：**

```
源文件(源目录)
   │  ① pipeline.save(kind:'clean') + pipeline.run   —— 按规则 YAML 清洗
   ▼
大表 DB   .onworking/bigtables/<folder>/db/onworking.db   （每大表独立）
   │  ② pipeline.save(kind:'sql-clean') + pipeline.run   —— 大表 → 总表(ATTACH + SQL)
   ▼
总表 master.db   .onworking/db/master.db   （最终可查询库）
   │  ③ pipeline.save(kind:'query') + pipeline.run / query.run
   ▼
查询结果表 / 临时查询
```

**关键认知（避免停在半路）：**

- **总表 master.db 不会自动生成**。只有建了 sql-clean 管线并跑它，才会把大表数据汇进总表。`query.run` / `schema.tables` 不填 `folder` 时查的是 master.db（总表）——没走到 ② 之前总表是空的，`schema.tables` 查不到表；填 `folder` 则查该大表自己的 DB。
- `pipeline.run` 写哪个 DB 由管线 kind 决定：`clean` → 大表 DB；`sql-clean` / `query` → 总表 DB。
- **生成总表是铁律（见 §2 铁律第 5 条）**：任何数据任务必须走到 ②（总表）；需要结果表/查数再走 ③。做到大表就停 = 任务没完成。
- `bigtable.previewRows` 预览的是大表 DB（①→② 的中间产物）；`query.run` / `schema.tables` 查的是总表（② 之后的最终库）。
- **大表 = 初步映射**：每个「文件 × sheet」一条 `mapping.save`（`pattern` + `sheetName`），全部合并进大表，**不做行级清理**。行级清理（剔合计/签名行、加月份列）一律写在 ② 的 sql-clean SQL 里。
- **交付用 `query.exportCsv`**：清洗在总表，导出的 CSV 应从总表来（`query.exportCsv {sql, path?}`），而不是大表。

**一句话标准链：** 打开工作区 → 建大表 → 加文件 → 每个「文件 × sheet」写一条映射 → 建并跑 clean（进大表，初步映射）→ 建并跑 sql-clean（SQL 里选月份 sheet + 加月份列 + 剔垃圾，进总表）→ `query.exportCsv` 导出交付。

---

## 2. 铁律（不可违反）

1. **禁止用 shell / 终端 / 文件工具读文件**：`cat` / `ls` / `find` / `grep` / `head` / `tail` / `type` / `more` / 打开文件查看 等，一律禁止。
2. **禁止用 shell / 终端 / 文件工具写、删、改文件**：`touch` / `echo >` / `rm` / `mv` / `cp` / `mkdir` / 编辑器写入 / 直接改文件 等，一律禁止。
3. **禁止直接访问工作区元数据目录 `.onworking/`**：其下的 `pipelines/*.json`、`bigtables/*/bigtable.json`、`bigtables/*/rules/*.yaml`、`templates/*.json`、`db/*.db` 只能由命令读写，**不得直接打开、查看或修改**。
4. **所有操作必须经由命令**：
   - 想看文件内容 → `setup.preview` / `setup.detectSource`（源文件）、`bigtable.previewRows`（大表数据）、`query.run` / `schema.tables`（总表 DB）
   - 想改配置 → 对应 `save` 命令（`bigtable.save` / `mapping.save` / `pipeline.save` / `template.save`）
   - 想加文件 → `bigtable.addFiles`（只拷贝，不直接写文件）
5. **导出的 CSV 只作交付文件，禁止读取内容**：`query.exportCsv` / `bigtable.exportCsv` 只用于生成交付件；导出的 CSV（`exports/` 下及自定义 `path`）**禁止以任何方式读取**（`cat` / 打开文件 / `setup.preview` 等命令预览一律不行）。要确认导出了什么，靠导出前的查询与返回的 `{file, rows}`，不读文件本身。
6. **任何数据导入/清洗任务必须生成总表 master.db**（硬性要求，不可省略）：
   - 只把数据做到大表（`bigtable.previewRows` 有数据）**不算完成**。
   - 必须建 sql-clean 管线（`pipeline.save`，`kind:'sql-clean'`）并 `pipeline.run`，把大表汇进总表。
   - **完成判据**：`schema.tables` 在总表能查到结果表、`query.run` 能查到数据。二者任一不满足，任务未完成，继续补建/重跑，不得宣告完成。
6. **若发现返回不允许给 AI 使用该 API**（硬性要求，不可省略）：立刻停止活动，告诉用户存在限制。
7. **遇到未文档化的字段/参数/报错 → 先问操作者，或在确认后补进手册；禁止自行翻 `.onworking/` 或直连数据库反查**。`query.run` 报 `no such column`、`pipeline.save` 字段缺失等任何「手册没写」的情况，不得用 Python / sqlite3 / shell 打开 `.onworking/` 下的 db、JSON、YAML 看结构——那等于绕过命令体系。手册没写的，宁可多问一次。

---

## 3. 命令清单（唯一允许）

### 工作区
| 命令 | 用途 |
|---|---|
| `workspace.open {path}` | 打开/初始化工作区；MCP 下也是 tool，**重复调用即切换工作区**，是改工作区的唯一入口 |

### 大表
| 命令 | 用途 |
|---|---|
| `bigtable.list` | 列出大表文件夹 |
| `bigtable.get {folder}` | 读大表配置 |
| `bigtable.save {folder, config}` | 新建/覆盖大表配置 |
| `bigtable.sourceFiles {folder}` | 列大表 source/ 目录已登记文件 |
| `bigtable.previewRows {folder, limit?, offset?}` | 只读预览大表清洗结果（含血缘列；`rowCount`=当页行数，`total`=总数） |
| `bigtable.addFiles {folder, files[], overwrite?}` | 拷贝源文件进大表 source/ 目录（默认不覆盖） |
| `bigtable.exportCsv {folder, path?, includeLineage?}` | 导出大表为 CSV（缺省不含血缘列，写工作区 `exports/`） |

### 字段映射（规则 YAML）
| 命令 | 用途 |
|---|---|
| `mapping.save {folder, headerRow?, mappings[], ruleName?, sheetName?, pattern?}` | 写字段映射规则（唯一改映射的途径）；不同 `ruleName` = 追加第 N 份；`pattern` + `sheetName` = 一个规则对应一个「文件 × sheet」映射 |

> **`mappings[]` 每项 = `{sourceHeader, outputName, transform?}`**：`sourceHeader` = 源文件列名、`outputName` = 目标列名（**必填，字段名是 `outputName` 不是 `targetField`**——写错会静默生成 `undefined` 列、写废整表数据）、`transform ∈ 'none' | 'to-cents' | 'normalize-date' | 'trim'`（缺省 `none`）。

### 管线
| 命令 | 用途 |
|---|---|
| `pipeline.list` | 列管线 id |
| `pipeline.save {config}` | 建管线（id 由调用方显式传入）；`clean` 的 config = `{kind:'clean', id, bigTableFolder, sourceDir}`，`bigTableFolder` 是大表文件夹（**不是 `folder`**）；`sql-clean` 的 config = `{kind:'sql-clean', id, bigTables:['folder1','folder2'], resultTable:'表名', sql:'SELECT ...'}`——**注意是 `bigTables` 数组不是 `bigTableFolder`，必须有非空 `resultTable`，sql 用 SELECT/WITH（不要写 CREATE TABLE），引擎自动建表写入** |
| `pipeline.delete {id}` | 删管线 |
| `pipeline.run {id}` | 运行任意管线 |
| `pipeline.mergeBigTable {folder}` / `pipeline.mergeAll` | 跑该大表 / 全部 clean 管线 |
| `pipeline.buildMasterBigTable {folder}` / `pipeline.buildMasterAll` | 跑该大表 / 全部 sql-clean 管线 |
| `pipeline.recomputeAll` / `pipeline.recomputeByDependency {trigger}` | 按血缘重算 |

### 文件设置 / 查询 / 模板 / 状态
| 命令 | 用途 |
|---|---|
| `setup.sheets {filePath}` / `setup.detectSource {filePath}` / `setup.preview {filePath}` | 读源文件表头/预览 |
| `query.run {sql, folder?}` | 查询/执行 SQL：**不填 `folder` 默认操作总表 master.db**；填 `folder` 则操作该大表自己的 DB。读（SELECT/WITH）返回行；写（INSERT/UPDATE/DELETE/DDL）直接改所选 DB、返回影响行数。写语句谨慎使用 |
| `query.exportCsv {sql, path?, folder?}` | 跑 SELECT 落 CSV：不填 `folder` 从总表导出，填了从该大表 DB 导出 |
| `template.list` / `template.save {template}` / `template.apply {name, sheet}` | 映射模板管理 |
| `schema.tables {folder?}` | DB 表清单：不填 `folder` 列总表，填了列该大表 DB |
| `state.summary` | 项目状态摘要（决定下一步） |
| `vcs.status` | 工作区版本状态 |

完整参数与返回形状见 [docs/cli.md](cli.md) 第 2 节。

### Shell 适配（Windows PowerShell）

环境是 PowerShell（不是 bash）时，注意：`printf`、`&&`、heredoc 不可用。等价写法：

```powershell
# 单命令(单引号包裹 JSON,避免 $ 与引号被解析)
'{"reqId":1,"cmd":"state.summary"}' | npm run --silent onw -- open D:/ws

# 多命令:用数组拼接后管道
@(
  '{"reqId":1,"cmd":"bigtable.list"}',
  '{"reqId":2,"cmd":"pipeline.list"}'
) | npm run --silent onw -- open D:/ws

# 若 JSON 里要带路径等含引号内容,可先写入临时文件再喂:
$lines = @'
{"reqId":1,"cmd":"bigtable.get","folder":"seq"}
'@
$lines | npm run --silent onw -- open D:/ws
```

- 交互式：直接 `npm run --silent onw -- open D:/ws`，之后逐行粘贴 JSON 回车即可。
- 若 `npm` 本身在 PowerShell 管道里有问题，退路是编译产物：`node dist/main/cli/index.js open D:/ws`（先 `npm run build:main`）。

**中文路径乱码（PowerShell 5.1 编码）——调用 CLI 前必读：**

工作区/文件路径含中文（如 `D:\工时表`）时，PowerShell 5.1 有**两层编码陷阱**，否则路径传成 `D:\???`、报 `ENOENT: mkdir 'D:\???.onworking\db'`：

1. **脚本文件读取**：`powershell -File <脚本>.ps1` 读**无 BOM 的 UTF-8** 脚本会按 ANSI/GBK 解码 → 脚本内中文先变乱码。
2. **管道传原生程序**：即使修好脚本编码，PS 5.1 把字符串通过管道交给原生 exe（`Onworking.exe`）时仍用默认 ASCII/系统代码页 → 中文变 `?`。

**解决（三选一或组合）：**

- **脚本存为 UTF-8 带 BOM**（PS 5.1 见到 BOM 才按 UTF-8 读）：
  ```powershell
  $c = Get-Content '<脚本.ps1>' -Raw -Encoding utf8
  [System.IO.File]::WriteAllText('<脚本.ps1>', $c, (New-Object System.Text.UTF8Encoding $true))
  ```
- **脚本开头强制 UTF-8 输出**（在调用 exe 之前）：
  ```powershell
  $OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  ```
- **优先当前会话内联执行**，别包 `powershell -File` 新进程：本会话（Bash 工具/当前 PS）已是 UTF-8，直接跑命令就正常；新开 `-File` 进程用默认代码页才是乱码触发点。命令/JSON 过长（如几百列 mapping）时，按 UTF-8 写临时 NDJSON 文件再喂 stdin，不要内联超长命令。

排查速记：**同一条命令，当前会话能跑通、换成 `powershell -File` 就乱码 → 就是新进程代码页问题，按上面两条编码设置修。**

---

## 4. 标准工作流

以「新建一个大表并导入数据」为例（每一步用命令，不得绕过）：

1. `workspace.open {path}` —— 打开工作区（MCP 下服务器无路径启动时，这是第一个动作；要换工作区就再调一次）
2. `state.summary` —— 看当前状态
3. `bigtable.save {folder, config}` —— 建大表（`config.tableName/fields/autoIncrement`）
4. `bigtable.addFiles {folder, files[]}` —— 把源文件加进大表 source/ 目录
5. `setup.detectSource {filePath}` —— 检测源文件表头行与表头
6. `mapping.save {folder, headerRow, mappings[], sheetName?}` —— 写字段映射（源表头→大表列）；多 sheet 文件用 `sheetName` 指定要导入的那张，不指定则只导第一张
7. `pipeline.save` —— 建 clean 管线（`config = {kind:'clean', id, bigTableFolder, sourceDir}`；`bigTableFolder` = 大表文件夹，`sourceDir` 指向源目录）
8. `pipeline.run {id}` —— 清洗入大表
9. `bigtable.previewRows {folder}` —— 验证清洗结果
10. `bigtable.exportCsv {folder}` —— （可选）导出清洗结果为 CSV，交付放 `<工作区根>/exports/`
11. `pipeline.save` —— 建 sql-clean 管线（大表→总表），`pipeline.run`
    - config = `{kind:'sql-clean', id, bigTables:['大表folder'], resultTable:'结果表名', sql:'SELECT ...'}`（见第 3 节）
    - **宽表转长表**：若大表是宽表（如每个项目一列），在 sql 里用 `UNION ALL` 拼接，每个非固定列写一个 `SELECT 固定列..., '列名' AS 项目, "列名" AS 值 FROM 表 WHERE ...`，用 PowerShell 循环自动生成（同上方「宽表多列自动映射」技巧），`UNION ALL` 连接后整体作为一条 SELECT
    - **加月份/年份列**：从血缘列 `__source_file` 用 `CASE WHEN __source_file LIKE '%202401%' THEN '2024-01' ... END` 推导
    - **行级清洗**：剔合计/签名/空行写在 WHERE 里（`工号 IS NOT NULL AND TRIM(工号)!='' AND 工号 NOT LIKE '%合计%'`），剔零值写 `AND "列名" IS NOT NULL AND "列名" != 0`
12. `schema.tables` / `query.run` —— 在总表上查数验证

> **强制：必须生成总表（铁律第 5 条）**。第 8~10 步只是完成「大表」，此时总表 master.db 还没生成。**任何数据任务都必须继续第 11 步（sql-clean → 总表）和第 12 步**，否则不算完成。完成判据：`schema.tables` 在总表查到结果表、`query.run` 查到数据。只汇报「大表已生成」= 未完成任务。

---

## 5. 写 SQL 清洗前的强制流程（先看大表 → 从严到宽三策略 → 确认后动手）

任何任务涉及**写 SQL 清洗**（sql-clean：大表 → 总表；含工作台临时清洗 SQL）时，**禁止直接凭想象写 WHERE 清洗条件**。必须先走完下面三步，得到操作者明确确认，才进入写 SQL / `pipeline.run` 跑 sql-clean。

### 第 1 步：让操作者亲自看大表现状

请操作者**亲自打开前端界面，在「预览」视图里查看当前大表**（左侧选中大表 → 预览，即 `bigtable.previewRows`）：看实际数据长什么样——有没有合计/签名/说明/小计行、有没有空行、各列真实内容。**这一步不能省，也不能由 Agent 代看**：清洗口径取决于大表里实际有什么，操作者亲眼确认最可靠。

Agent 侧配合：`bigtable.previewRows {folder}` 拉样例 + `schema.tables {folder}` 看列结构，把看到的状况如实告诉操作者，请操作者到前端预览核对。

### 第 2 步：从严到宽给出三个清洗策略

基于大表实际状况，给出**从严格到宽松**三档清洗策略，请操作者选择（或提出自己的口径）：

| 档位 | 清洗口径 | 适用场景 |
|---|---|---|
| **严格** | 关键字段（如姓名/序号/金额）非空 + 剔除所有疑似合计/签名/说明/小计行，宁缺毋滥 | 数据噪音多，可接受少量误剔 |
| **中等**（默认推荐） | 剔明显的合计/签名/空行；只剔关键字段为空的，其余保留 | 平衡数据完整与干净 |
| **宽松** | 只剔空行，其余全保留（含可能的合计/签名行），数据最全 | 先全量入库，后续人工筛选 |

### 第 3 步：确认后才动手

问操作者选哪一档，或请操作者直接给出自己的清洗口径（增删 WHERE 条件、指定剔除规则、指定保留字段）。**得到明确确认后**，才按选定策略写 SQL（见第 4 节第 11 步的清洗技巧）、`pipeline.save` 存 sql-clean 管线、`pipeline.run`。未经确认不得写 SQL。

> 与第 9 节「先粗后细」的关系：整体流程仍先粗后细、不要反复预览拖慢节奏；但**写清洗 SQL 这一步必须先走本流程确认清洗口径**——粗 = 流程推进快，不是随便猜清洗规则。

---

## 6. 关键语义（容易踩坑，务必牢记）

- **大表是重建式的**：`pipeline.run` 每次先删旧表再写，行数 = 源目录所有匹配文件合计，**不是追加**。
- **加文件 ≠ 导入**：`bigtable.addFiles` 只拷贝文件到 `source/` 目录；**必须重跑 `pipeline.run` 才导入数据**。
- **`overwrite` 缺省 `false`**：`bigtable.addFiles` 遇到同名文件默认跳过（`skipped`）；要覆盖必须显式 `overwrite:true`。
- **规则 YAML 是 clean 映射的唯一事实来源**：不要指望管线 config 里带映射；改映射只能 `mapping.save`。
- **`sourceDir` 决定源文件，规则 `sources[].pattern` 决定匹配**：想加别处文件，拷进 sourceDir 或改规则。
- **血缘列自动附加**：`__source_file` / `__source_sheet` / `__source_row` / `__extracted_at` 每行都有，可反查「哪个文件哪个 sheet 哪一行」；`bigtable.exportCsv` 默认不含它们（`includeLineage:true` 才带）。
- **多 sheet 文件**：`mapping.save` 传 `sheetName` 指定导入哪张表；不传则每文件只导**第一张**（`sheets.slice(0,1)`）。
- **映射目标列名写在 `outputName`**：`mapping.save` 的 `mappings[]` 每项是 `{sourceHeader, outputName}`；目标列名只能放 `outputName`，写成 `targetField` 等其它名字会静默生成 `undefined` 列、写废整表。
- **导出用命令**：`bigtable.exportCsv` 落盘 CSV，缺省 `<工作区根>/exports/<tableName>.csv`；禁止自己拼 CSV 写文件。
- **`previewRows` 语义**：`rowCount`=当页行数、`total`=总数（分页时两者不同）。
- **小计/页脚/空行不会自动剔除**：若源表含「小计」行、签名行、空行，需在后续处理中过滤（当前无内置过滤，属已知限制）。
- **重复表头按列编号映射**：同表头出现 N 次 → 规范名 `姓名_1`..`姓名_N`（与预览/模板/自动映射一致）。映射的 `sourceHeader` 必须写编号名（如 `姓名_2`）精确指定列；写裸名「姓名」时 `mapping.save` 抛 `MAPPING_DUPLICATE_HEADER`、clean 抛 `CLEAN_DUPLICATE_HEADER`（整个 run 失败 `ok:false`）。
- **跑完管线必读 `warnings` 并汇报**：`pipeline.run` 的返回里有 `warnings` 数组，可能含「跳过无法读取的文件（密码保护/损坏）」「重复表头未按编号映射」等。**必须把每条告警转告操作者**——被跳过的文件=数据没进，这类尤其要明确报告，不能只说「跑完了」。
- **clean 返回 `unusedHeaders`：源表头没被映射引用 = 数据没进大表**：clean 跑完后 `unusedHeaders` 数组列出**源文件中存在、但没有任何映射 `sourceHeader` 引用的表头**（这些列的数据没进大表），同时 `warnings` 里有「以下源表头未被任何映射使用…」。**非空时必须向操作者汇报**，通常是这几种情况：① 源文件新增了列、映射漏配（补 `mapping.save` 后重跑）；② `sourceHeader` 拼写/换行符不匹配（表头含 `\n` 时容易踩）；③ 操作者本就不需要这些列（在总表 SQL 里也不引用）。不能当没看见就往下走。
- **pipeline id 由调用方显式传入**：禁止用 `Date.now()` 等不可复现的 id。
- **`query.run` 读为主**：读（SELECT/WITH）返回行；写（INSERT/UPDATE/DELETE/DDL）会直接改所选 DB（默认总表 master.db，带 `folder` 改该大表 DB），**除非操作者明确要求，不要用写**。
- **宽表多列（50+ 列）不要手写映射**：当源表列数很多（如工时表 200+ 项目列），手动逐列写 `mapping.save` 的 `mappings[]` 不现实。标准做法：
  1. `setup.detectSource {filePath, sheetName}` 获取全部 `headers`，用 `Out-File` 存到临时文件（NDJSON 格式，每行一条响应）
  2. PowerShell 解析：`Get-Content` 按行读 → 找到 `reqId` 对应行 → `ConvertFrom-Json` → 提取 `headers` 数组
  3. 过滤空列名、去重；前 N 个固定列按已知类型（TEXT/REAL），其余项目列统一设为 REAL
  4. 用循环自动生成 `fields[]`（给 `bigtable.save`）和 `mappings[]`（给 `mapping.save`），`ConvertTo-Json -Depth 10 -Compress` 序列化
  5. 把 `workspace.open` + `bigtable.save` + `mapping.save` 三条命令写入临时文件，`Get-Content | Onworking.exe ...` 一次性管道执行
  - **列名含换行符**：Excel 表头常含 `\n`（如 `RD005\n艾司奥美拉唑镁肠溶片`），`sourceHeader` 必须保留原始换行符才能匹配；`outputName` 建议把 `\n`/`\r` 替换为空格再 `.Trim()`
  - **命令长度**：200+ 列的 `mapping.save` JSON 可达 10万+ 字符，必须走临时文件管道，不能内联在 `@(...)` 数组里

---

## 7. 约束如何执行

1. **注入**：本手册全文作为 Agent 的 system prompt 前置约束。
2. **运行侧拦截**：工具权限只放行清单内命令（MCP tools），shell/文件编辑工具直接拒绝，从机制上杜绝绕过。
3. **违规对照**（看到这些动作立即改为命令）：

| 想做 | 禁止这么做 | 应该用 |
|---|---|---|
| 看源文件表头 | `cat a.xlsx` / 读文件 | `setup.detectSource` |
| 看大表数据 | `ls .onworking/bigtables/seq` / 打开 db | `bigtable.previewRows` |
| 看总表有哪些表 | 读 master.db | `schema.tables` |
| 查总表数据 | 直接开 sqlite | `query.run` |
| 遇到未文档化字段/查结构 | python 连 `.onworking/` 的 db / 翻配置 JSON、YAML | 先问操作者，或在确认后补进手册 |
| 加源文件 | `cp x.xlsx …/source/` | `bigtable.addFiles` |
| 导出数据到 CSV | 自己拼字符串写文件 | `bigtable.exportCsv` |
| 指定导入某个 sheet | 只导第一张将就 | `mapping.save` 的 `sheetName` |
| 改映射 | 手写 rules/*.yaml | `mapping.save` |
| 建/改管线 | 手写 pipelines/*.json | `pipeline.save` |

---

## 8. 排查（常见错误码）

| 码 | 含义 | 处理 |
|---|---|---|
| `UNKNOWN_CMD` | 命令名错误 | 对照第 3 节清单 |
| `NO_WORKSPACE` | 未打开工作区 | 先 `workspace.open` |
| `CLEAN_NO_RULE` | clean 管线没有规则 YAML | `mapping.save` 写映射 |
| `FILE_NOT_FOUND` | `bigtable.addFiles` 源文件不存在 | 检查文件路径 |
| `QUERY_NOT_SELECT` | query 管线(物化结果表)的 SQL 非 SELECT/WITH | 物化须用 SELECT/WITH |
| `TEMPLATE_NOT_FOUND` | 模板不存在 | `template.list` 查名 |
| `p.bigTables is not iterable` | sql-clean config 写错字段 | 用 `bigTables` 数组，不要用 `bigTableFolder` |
| `SQLCLEAN_NO_RESULT_TABLE` | sql-clean 缺少 `resultTable` | config 里加 `"resultTable":"你的表名"` |
| `AI_MODE_RESTRICTED` | 当前模式(external)不允许 AI 调用该 API | `setup.preview` / `bigtable.previewRows` / `query.run` / `setup.exportCsv`（源文件原样导出）在 AI 模式下被禁用；替代：看表头用 `setup.detectSource`，查大表结构用 `schema.tables {folder}`，查总表结构用 `schema.tables`（无 folder），数据量看 `pipeline.run` 返回的 `rows`，导出 CSV 用 `query.exportCsv` / `bigtable.exportCsv`（external 可用，仅 SELECT 落盘） |
| 环境：`better-sqlite3` ABI 不匹配 | 报 `NODE_MODULE_VERSION` 不符（如 `137 vs 125`） | **已双装载免疫**：`sqlite.ts` 按进程 ABI 自动选（系统 node 137 用 `better-sqlite3`，Electron 内置 node 用 `better-sqlite3-electron` 副本——本机 Electron 31.7.7 是 125），客户端怎么 spawn 都通。装完依赖跑一次 `npm run build:dual-abi`（先重建原件到 137、再建副本匹配 Electron；注意原件被 app/MCP 占用时先关掉再跑）。若仍报，先跑 `npm run build:dual-abi` 再试 |

---

## 9. 操作者 → Agent：快速出第一版提示词模板

**先粗后细是默认姿态**：不要反复 `setup.preview` / `bigtable.previewRows` 预览确认——直接建映射 → 跑 clean → 跑 sql-clean → 导出 CSV，粗版出来再按需精修。一次生产实践证明：**「月份 sheet + 姓名/序号/基本工资 非空」一条朴素规则，就能同时挡掉子表、非月份 sheet、合计/签名/空行**，无需逐项排查。

把下面这段（替换 `⟨…⟩`）粘给 Agent：

```
按手册标准链快速出第一版，不要追求完美，后面我再调。
- 表头行号：⟨第 3 行⟩
- 目标 sheet：sheet 名是月份的才导（⟨1月~12月 / 2025XX⟩），其他 sheet 全跳过
- 大表：⟨已建好，字段已定义，直接复用，不要加新字段⟩
- 清洗最低标准：姓名、序号、基本工资 非空即可；月份列从 sheet 名推导（⟨2025 文件→2025-XX⟩）
- 跑完直接 query.exportCsv 导出，不要反复 preview 验证
```

**操作者应预先告诉 Agent 的信息**（填上这些 Agent 就完全不用猜/detect）：

| 信息 | 说明 |
|---|---|
| 表头行号 | 第几行是字段名（省掉 detect） |
| 目标 sheet 规则 | 哪些 sheet 算工资（按月份命名？） |
| 大表字段 | 是否已建好、直接复用还是允许加字段 |
| 清洗容忍度 | 先粗后细 / 一次到位 |
| 月份/年份来源 | 从文件名还是 sheet 名推导 |
