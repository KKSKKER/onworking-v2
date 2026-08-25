# Onworking Agent 操作手册

> 适用对象：所有操作 Onworking 工作区的 AI Agent。
> 接口来源：`src/ipc/contracts.ts`（`CommandPayloads`/`CommandResults`）；通过 MCP tools（工具名 = 命令名）或 CLI（NDJSON）调用同一套命令。

---

## 0. 本手册的强制力

本手册是操作 Onworking 工作区的**最高行为约束**。

- **唯一合法操作途径**：只能调用本手册「第 2 节命令清单」列出的命令。
- 除清单内命令外，**禁止**使用任何其他工具、命令行、脚本去查看或修改文件。
- 违反即视为错误操作：停止当前动作，改用清单内命令。

---

## 1. 铁律（不可违反）

1. **禁止用 shell / 终端 / 文件工具读文件**：`cat` / `ls` / `find` / `grep` / `head` / `tail` / `type` / `more` / 打开文件查看 等，一律禁止。
2. **禁止用 shell / 终端 / 文件工具写、删、改文件**：`touch` / `echo >` / `rm` / `mv` / `cp` / `mkdir` / 编辑器写入 / 直接改文件 等，一律禁止。
3. **禁止直接访问工作区元数据目录 `.onworking/`**：其下的 `pipelines/*.json`、`bigtables/*/bigtable.json`、`bigtables/*/rules/*.yaml`、`templates/*.json`、`db/*.db` 只能由命令读写，**不得直接打开、查看或修改**。
4. **所有操作必须经由命令**：
   - 想看文件内容 → `setup.preview` / `setup.detectSource`（源文件）、`bigtable.previewRows`（大表数据）、`query.run` / `schema.tables`（总表 DB）
   - 想改配置 → 对应 `save` 命令（`bigtable.save` / `mapping.save` / `pipeline.save` / `template.save`）
   - 想加文件 → `bigtable.addFiles`（只拷贝，不直接写文件）

---

## 2. 命令清单（唯一允许）

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
| `bigtable.previewRows {folder, limit?, offset?}` | 只读预览大表清洗结果（含血缘列） |
| `bigtable.addFiles {folder, files[], overwrite?}` | 拷贝源文件进大表 source/ 目录（默认不覆盖） |

### 字段映射（规则 YAML）
| 命令 | 用途 |
|---|---|
| `mapping.save {folder, headerRow?, mappings[], ruleName?}` | 写字段映射规则（唯一改映射的途径）；不同 `ruleName` = 追加第 N 份 |

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

---

## 3. 标准工作流

以「新建一个大表并导入数据」为例（每一步用命令，不得绕过）：

1. `workspace.open {path}` —— 打开工作区（MCP 下服务器无路径启动时，这是第一个动作；要换工作区就再调一次）
2. `state.summary` —— 看当前状态
3. `bigtable.save {folder, config}` —— 建大表（`config.tableName/fields/autoIncrement`）
4. `bigtable.addFiles {folder, files[]}` —— 把源文件加进大表 source/ 目录
5. `setup.detectSource {filePath}` —— 检测源文件表头行与表头
6. `mapping.save {folder, headerRow, mappings[]}` —— 写字段映射（源表头→大表列）
7. `pipeline.save` —— 建 clean 管线（`kind:'clean'`, `sourceDir` 指向源目录）
8. `pipeline.run {id}` —— 清洗入大表
9. `bigtable.previewRows {folder}` —— 验证清洗结果
10. `pipeline.save` —— 建 sql-clean 管线（大表→总表），`pipeline.run`
11. `schema.tables` / `query.run` —— 在总表上查数验证

---

## 4. 关键语义（容易踩坑，务必牢记）

- **大表是重建式的**：`pipeline.run` 每次先删旧表再写，行数 = 源目录所有匹配文件合计，**不是追加**。
- **加文件 ≠ 导入**：`bigtable.addFiles` 只拷贝文件到 `source/` 目录；**必须重跑 `pipeline.run` 才导入数据**。
- **`overwrite` 缺省 `false`**：`bigtable.addFiles` 遇到同名文件默认跳过（`skipped`）；要覆盖必须显式 `overwrite:true`。
- **规则 YAML 是 clean 映射的唯一事实来源**：不要指望管线 config 里带映射；改映射只能 `mapping.save`。
- **`sourceDir` 决定源文件，规则 `sources[].pattern` 决定匹配**：想加别处文件，拷进 sourceDir 或改规则。
- **血缘列自动附加**：`__source_file` / `__source_row` / `__extracted_at` 每行都有，可用于追溯。
- **pipeline id 由调用方显式传入**：禁止用 `Date.now()` 等不可复现的 id。
- **`query.run` 只读**：只允许 `SELECT`/`WITH`，不可用 `DELETE`/`UPDATE`/`INSERT` 等。

---

## 5. 约束如何执行

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
| 改映射 | 手写 rules/*.yaml | `mapping.save` |
| 建/改管线 | 手写 pipelines/*.json | `pipeline.save` |

---

## 6. 排查（常见错误码）

| 码 | 含义 | 处理 |
|---|---|---|
| `UNKNOWN_CMD` | 命令名错误 | 对照第 2 节清单 |
| `NO_WORKSPACE` | 未打开工作区 | 先 `workspace.open` |
| `CLEAN_NO_RULE` | clean 管线没有规则 YAML | `mapping.save` 写映射 |
| `FILE_NOT_FOUND` | `bigtable.addFiles` 源文件不存在 | 检查文件路径 |
| `QUERY_NOT_SELECT` | `query.run` 非 SELECT/WITH | 改查询语句 |
| `TEMPLATE_NOT_FOUND` | 模板不存在 | `template.list` 查名 |
