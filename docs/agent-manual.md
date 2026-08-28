# Onworking Agent 操作须知（完整版）

> 这是暴露给 MCP 连接进来的 Agent 的完整操作手册；`src/mcp/manual.ts` 的 `MANUAL_TEXT` 是其操作性浓缩版。
> 改本文件时需保持两者同步（尤其铁律与命令语义）。

## 铁律（不可违反）

1. **唯一合法操作途径**：只能调用本 MCP 暴露的命令工具。禁止用任何 shell / 终端 / 文件工具查看或修改文件。
2. **禁止直接访问工作区元数据目录** `.onworking/` 下的文件（`pipelines/*.json`、`bigtables/*/bigtable.json`、`rules/*.yaml`、`templates/*.json`、`db/*.db`），只能经命令读写。
3. **想看数据用命令**：
   - 源文件：`setup.sheets` / `setup.preview` / `setup.detectSource` / `setup.detectHeaders`
   - 大表：`bigtable.previewRows`
   - 总表：`query.run` / `schema.tables`
   - 改配置：对应 `*.save` 命令；加文件：`bigtable.addFiles`。
4. **一个 sheet 纵向堆叠多张表时**，用 `setup.detectHeaders` 列出全部候选表头行（含偏离值证据），挑出你要的那张表的表头行号再 `mapping.save`。

## 数据链（两段式，最终产物是总表 master.db）

```
源文件 → ① clean 管线 → 大表 DB（初步映射） → ② sql-clean 管线 → 总表 master.db → ③ query 管线 / query.run
```

- **总表 master.db 不会自动生成**：必须建 sql-clean 管线并跑它。
- **大表 = 初步映射**：每个「文件 × sheet」一条 `mapping.save`（pattern + sheetName），不清理。
- **行级清理**（剔合计/签名行、加月份列等）写在 ② 的 sql-clean SQL 里。
- **交付**用 `query.exportCsv`（从总表导）。

## 完成判据（铁律）

任何数据任务必须生成总表：`query.run` / `schema.tables` 能在总表查到数据才算完成。
**只做到大表 = 未完成，不得宣告完成。**

## 命令速查

### 工作区与会话
- `workspace.open`（传输层命令，打开/切换工作区）
- `manual.read`（读本手册）
- `state.summary` / `vcs.status` / `settings.get`

### 大表（初步映射）
- `bigtable.save`（建大表，folder + config）、`bigtable.list` / `bigtable.get` / `bigtable.sourceFiles` / `bigtable.config`
- `bigtable.addFiles`（拷贝源文件到 source/，**不等于导入**，必须重跑 `pipeline.run`）
- `bigtable.previewRows`（预览大表行）、`bigtable.exportCsv`
- `bigtable.delete` / `bigtable.deleteSourceFile`

### 源文件探查
- `setup.sheets`（列出 sheet 名）
- `setup.detectSource`（检测单一表头行号，返回 detected）
- **`setup.detectHeaders`**（候选表头行列表；见下方「堆叠多表」章节）
- `setup.preview`（按表头行号预览）
- `setup.exportCsv`

### 映射与模板
- `mapping.save`（写 clean 映射规则；`mapping.delete` 删）
- `template.list` / `template.save` / `template.apply`

### 管线
- `pipeline.save` / `pipeline.list` / `pipeline.configs` / `pipeline.delete` / `pipeline.run`
- `pipeline.mergeBigTable`（重跑 clean）、`pipeline.buildMasterBigTable`（重跑 sql-clean）
- `pipeline.mergeAll` / `pipeline.buildMasterAll` / `pipeline.recomputeAll` / `pipeline.recomputeByDependency`

### 总表
- `query.run`（读为主：SELECT/WITH 返回行）
- `query.exportCsv`（从总表导交付件）
- `schema.tables`（看表结构）

## 关键语义

- **大表是重建式的**：`pipeline.run` 每次先删后写，行数 = 源目录所有匹配文件合计。
- **加文件 ≠ 导入**：`bigtable.addFiles` 只拷贝到 `source/`，必须重跑 `pipeline.run`。
- **overwrite 缺省 false**：同名文件跳过；要覆盖显式 `true`。
- **规则 YAML 是 clean 映射唯一事实来源**：改映射只能 `mapping.save`。
- **`mapping.save` 的 `mappings[]` 每项** = `{ sourceHeader, outputName, transform? }`：
  - `outputName` 是目标列名（**必填**；字段名是 `outputName` 不是 `targetField`）；
  - `transform` 缺省 `none`。
- **clean 管线 config** 用 `{ kind: 'clean', id, bigTableFolder, sourceDir }`：大表字段名是 `bigTableFolder`（不是 `folder`）。
- **血缘列自动附加**：`__source_file` / `__source_sheet` / `__source_row` / `__extracted_at`。
- **pipeline id 由调用方显式传入**，禁止用 `Date.now()` 等不可复现 id。
- **query.run 读为主**（SELECT/WITH 返回行）；写（INSERT/UPDATE/DELETE/DDL）会直接改总表 master.db，除非操作者明确要求不要用写。
- **跑完管线必读返回的 warnings 并向操作者汇报**：跳过文件（密码保护/损坏 = 数据没进）、行/列超上限截断（数据被切）、重复表头只取其一。不能只说「跑完了」。
- **每文件多 sheet**：用 `mapping.save` 的 `sheetName` 指定；不指定只导第一张。

## 堆叠多表（setup.detectHeaders）

一个 sheet 里纵向堆叠多张表时，`setup.detectSource` 只认第一张的表头就停，看不到后面的表。此时用 `setup.detectHeaders`：

- **读全表**：从第一行扫到末尾（先裁掉尾部空行），给每个非空行打分。
- **打分**：字符串单元格 +2、其他非空 +1、纯数字/空 0 —— 表头行通常是全字符串列，分数最高。
- **基线 = 众数**：全表非空行分数的众数（出现最多的分数）代表「常规数据行」的格式，`deviation = 该行分数 − 众数`。
- **候选 = 稀有高分行**：`score ≥ minScore(默认 3)` 且 `score > 众数` 且**该分数出现 ≤ 2 次**。数据行格式一致会大量同分（出现 >2 次被排除），表头是「少数派高分行」自然入选，一次只返回 1~几个，不会水漫金山。
- **返回**：候选表头行数组，每项含 `rowNumber`（1-based）、`score`、`deviation`、`cells`（该行单元格内容，超长截断，供你判断）。按 deviation 降序、再按行号升序排列，最可能是表头的排最前。
- **挑哪个**：看 `cells` 内容认列名，挑你要的那张表的表头行号，再 `mapping.save` 里用 `headerRow` 指定。

**调参**（可选）：候选太多就把 `limit` 收紧；数据行文本注释列很多时把 `minScore` 调低可放行更弱的表头。退化情况（几乎全是字符串、没有稳定的数据行基线）按设计返回空数组，此时回退用 `setup.detectSource`。

## 工作流

打开工作区（`workspace.open`）→ 建大表（`bigtable.save`）→ 加文件（`bigtable.addFiles`）→ 每文件每 sheet 写映射（`mapping.save`；堆叠表先 `setup.detectHeaders` 拿表头行号）→ 建并跑 clean（进大表）→ 建并跑 sql-clean（SQL 里选 sheet / 加月份 / 剔垃圾，进总表）→ `query.exportCsv` 导出交付。
