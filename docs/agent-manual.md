# Onworking Agent 操作手册

> 适用对象：所有操作 Onworking 工作区的 AI Agent。
> 接口来源：`src/ipc/contracts.ts`（`CommandPayloads`/`CommandResults`）；通过 MCP tools（工具名 = 命令名）或 CLI（NDJSON）调用同一套命令。

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

- **总表 master.db 不会自动生成**。只有建了 sql-clean 管线并跑它，才会把大表数据汇进总表。`query.run` / `schema.tables` 查的都是 master.db —— 没走到 ② 之前总表是空的，`schema.tables` 查不到表。
- `pipeline.run` 写哪个 DB 由管线 kind 决定：`clean` → 大表 DB；`sql-clean` / `query` → 总表 DB。
- **生成总表是铁律（见 §2 铁律第 5 条）**：任何数据任务必须走到 ②（总表）；需要结果表/查数再走 ③。做到大表就停 = 任务没完成。
- `bigtable.previewRows` 预览的是大表 DB（①→② 的中间产物）；`query.run` / `schema.tables` 查的是总表（② 之后的最终库）。

**一句话标准链：** 打开工作区 → 建大表 → 加文件 → 写映射 → 建并跑 clean（进大表）→ 建并跑 sql-clean（进总表）→ 建并跑 query / query.run 查数。

---

## 2. 铁律（不可违反）

1. **禁止用 shell / 终端 / 文件工具读文件**：`cat` / `ls` / `find` / `grep` / `head` / `tail` / `type` / `more` / 打开文件查看 等，一律禁止。
2. **禁止用 shell / 终端 / 文件工具写、删、改文件**：`touch` / `echo >` / `rm` / `mv` / `cp` / `mkdir` / 编辑器写入 / 直接改文件 等，一律禁止。
3. **禁止直接访问工作区元数据目录 `.onworking/`**：其下的 `pipelines/*.json`、`bigtables/*/bigtable.json`、`bigtables/*/rules/*.yaml`、`templates/*.json`、`db/*.db` 只能由命令读写，**不得直接打开、查看或修改**。
4. **所有操作必须经由命令**：
   - 想看文件内容 → `setup.preview` / `setup.detectSource`（源文件）、`bigtable.previewRows`（大表数据）、`query.run` / `schema.tables`（总表 DB）
   - 想改配置 → 对应 `save` 命令（`bigtable.save` / `mapping.save` / `pipeline.save` / `template.save`）
   - 想加文件 → `bigtable.addFiles`（只拷贝，不直接写文件）
5. **任何数据导入/清洗任务必须生成总表 master.db**（硬性要求，不可省略）：
   - 只把数据做到大表（`bigtable.previewRows` 有数据）**不算完成**。
   - 必须建 sql-clean 管线（`pipeline.save`，`kind:'sql-clean'`）并 `pipeline.run`，把大表汇进总表。
   - **完成判据**：`schema.tables` 在总表能查到结果表、`query.run` 能查到数据。二者任一不满足，任务未完成，继续补建/重跑，不得宣告完成。

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
| `mapping.save {folder, headerRow?, mappings[], ruleName?, sheetName?}` | 写字段映射规则（唯一改映射的途径）；不同 `ruleName` = 追加第 N 份；`sheetName` = 只导入指定 sheet |

### 管线
| 命令 | 用途 |
|---|---|
| `pipeline.list` | 列管线 id |
| `pipeline.save {config}` | 建管线（id 由调用方显式传入） |
| `pipeline.delete {id}` | 删管线 |
| `pipeline.run {id}` | 运行任意管线 |
| `pipeline.mergeBigTable {folder}` / `pipeline.mergeAll` | 跑该大表 / 全部 clean 管线 |
| `pipeline.buildMasterBigTable {folder}` / `pipeline.buildMasterAll` | 跑该大表 / 全部 sql-clean 管线 |
| `pipeline.recomputeAll` / `pipeline.recomputeByDependency {trigger}` | 按血缘重算 |

### 文件设置 / 查询 / 模板 / 状态
| 命令 | 用途 |
|---|---|
| `setup.sheets {filePath}` / `setup.detectSource {filePath}` / `setup.preview {filePath}` | 读源文件表头/预览 |
| `query.run {sql}` | 总表 DB 临时查询（仅 SELECT/WITH） |
| `template.list` / `template.save {template}` / `template.apply {name, sheet}` | 映射模板管理 |
| `schema.tables` | 总表 DB 表清单 |
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

---

## 4. 标准工作流

以「新建一个大表并导入数据」为例（每一步用命令，不得绕过）：

1. `workspace.open {path}` —— 打开工作区（MCP 下服务器无路径启动时，这是第一个动作；要换工作区就再调一次）
2. `state.summary` —— 看当前状态
3. `bigtable.save {folder, config}` —— 建大表（`config.tableName/fields/autoIncrement`）
4. `bigtable.addFiles {folder, files[]}` —— 把源文件加进大表 source/ 目录
5. `setup.detectSource {filePath}` —— 检测源文件表头行与表头
6. `mapping.save {folder, headerRow, mappings[], sheetName?}` —— 写字段映射（源表头→大表列）；多 sheet 文件用 `sheetName` 指定要导入的那张，不指定则只导第一张
7. `pipeline.save` —— 建 clean 管线（`kind:'clean'`, `sourceDir` 指向源目录）
8. `pipeline.run {id}` —— 清洗入大表
9. `bigtable.previewRows {folder}` —— 验证清洗结果
10. `bigtable.exportCsv {folder}` —— （可选）导出清洗结果为 CSV，交付放 `<工作区根>/exports/`
11. `pipeline.save` —— 建 sql-clean 管线（大表→总表），`pipeline.run`
12. `schema.tables` / `query.run` —— 在总表上查数验证

> **强制：必须生成总表（铁律第 5 条）**。第 8~10 步只是完成「大表」，此时总表 master.db 还没生成。**任何数据任务都必须继续第 11 步（sql-clean → 总表）和第 12 步**，否则不算完成。完成判据：`schema.tables` 在总表查到结果表、`query.run` 查到数据。只汇报「大表已生成」= 未完成任务。

---

## 5. 关键语义（容易踩坑，务必牢记）

- **大表是重建式的**：`pipeline.run` 每次先删旧表再写，行数 = 源目录所有匹配文件合计，**不是追加**。
- **加文件 ≠ 导入**：`bigtable.addFiles` 只拷贝文件到 `source/` 目录；**必须重跑 `pipeline.run` 才导入数据**。
- **`overwrite` 缺省 `false`**：`bigtable.addFiles` 遇到同名文件默认跳过（`skipped`）；要覆盖必须显式 `overwrite:true`。
- **规则 YAML 是 clean 映射的唯一事实来源**：不要指望管线 config 里带映射；改映射只能 `mapping.save`。
- **`sourceDir` 决定源文件，规则 `sources[].pattern` 决定匹配**：想加别处文件，拷进 sourceDir 或改规则。
- **血缘列自动附加**：`__source_file` / `__source_row` / `__extracted_at` 每行都有，可用于追溯；`bigtable.exportCsv` 默认不含它们（`includeLineage:true` 才带）。
- **多 sheet 文件**：`mapping.save` 传 `sheetName` 指定导入哪张表；不传则每文件只导**第一张**（`sheets.slice(0,1)`）。
- **导出用命令**：`bigtable.exportCsv` 落盘 CSV，缺省 `<工作区根>/exports/<tableName>.csv`；禁止自己拼 CSV 写文件。
- **`previewRows` 语义**：`rowCount`=当页行数、`total`=总数（分页时两者不同）。
- **小计/页脚/空行不会自动剔除**：若源表含「小计」行、签名行、空行，需在后续处理中过滤（当前无内置过滤，属已知限制）。
- **重复表头会歧义**：同一列名出现两次时按 `sourceHeader` 映射无法区分（属已知限制，需先处理源文件）。
- **pipeline id 由调用方显式传入**：禁止用 `Date.now()` 等不可复现的 id。
- **`query.run` 只读**：只允许 `SELECT`/`WITH`，不可用 `DELETE`/`UPDATE`/`INSERT` 等。

---

## 6. 约束如何执行

1. **注入**：本手册全文作为 Agent 的 system prompt 前置约束。
2. **运行侧拦截**：工具权限只放行清单内命令（MCP tools），shell/文件编辑工具直接拒绝，从机制上杜绝绕过。
3. **违规对照**（看到这些动作立即改为命令）：

| 想做 | 禁止这么做 | 应该用 |
|---|---|---|
| 看源文件表头 | `cat a.xlsx` / 读文件 | `setup.detectSource` |
| 看大表数据 | `ls .onworking/bigtables/seq` / 打开 db | `bigtable.previewRows` |
| 看总表有哪些表 | 读 master.db | `schema.tables` |
| 查总表数据 | 直接开 sqlite | `query.run` |
| 加源文件 | `cp x.xlsx …/source/` | `bigtable.addFiles` |
| 导出数据到 CSV | 自己拼字符串写文件 | `bigtable.exportCsv` |
| 指定导入某个 sheet | 只导第一张将就 | `mapping.save` 的 `sheetName` |
| 改映射 | 手写 rules/*.yaml | `mapping.save` |
| 建/改管线 | 手写 pipelines/*.json | `pipeline.save` |

---

## 7. 排查（常见错误码）

| 码 | 含义 | 处理 |
|---|---|---|
| `UNKNOWN_CMD` | 命令名错误 | 对照第 3 节清单 |
| `NO_WORKSPACE` | 未打开工作区 | 先 `workspace.open` |
| `CLEAN_NO_RULE` | clean 管线没有规则 YAML | `mapping.save` 写映射 |
| `FILE_NOT_FOUND` | `bigtable.addFiles` 源文件不存在 | 检查文件路径 |
| `QUERY_NOT_SELECT` | `query.run` 非 SELECT/WITH | 改查询语句 |
| `TEMPLATE_NOT_FOUND` | 模板不存在 | `template.list` 查名 |
| 环境：`better-sqlite3` ABI 不匹配 | 报 `NODE_MODULE_VERSION` 不符 | 跑 `npm run rebuild:node`（测试/CLI 用）；跑 Electron 应用前需 `npm run rebuild:electron`（两者互斥，按用途重建） |
