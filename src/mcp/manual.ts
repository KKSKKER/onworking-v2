// src/mcp/manual.ts
// 内置 Agent 操作须知:通过 MCP resources/prompts 暴露给连接进来的 Agent。
// 这是 docs/agent-manual.md 的操作性浓缩版;完整版见 docs/agent-manual.md(两者需保持同步)。
export const MANUAL_TEXT = `# Onworking Agent 操作须知(浓缩版)

## 铁律(不可违反)
1. 唯一合法操作途径:只能调用本 MCP 暴露的命令工具。禁止用任何 shell/终端/文件工具查看或修改文件。
2. 禁止直接访问工作区元数据目录 .onworking/ 下的文件(pipelines/*.json、bigtables/*/bigtable.json、rules/*.yaml、templates/*.json、db/*.db),只能经命令读写。
3. 想看数据用命令:源文件→setup.preview/setup.detectSource;大表→bigtable.previewRows;总表→query.run/schema.tables。改配置→对应 save 命令。加文件→bigtable.addFiles。

## 数据链(两段式,最终产物是总表 master.db)
源文件 → ① clean 管线 → 大表 DB(初步映射) → ② sql-clean 管线 → 总表 master.db → ③ query 管线/query.run。
- 总表 master.db 不会自动生成:必须建 sql-clean 管线并跑它。
- 大表=初步映射:每个「文件 × sheet」一条 mapping.save(pattern+sheetName),不清理。
- 行级清理(剔合计/签名行、加月份列)写在 ② 的 sql-clean SQL 里。
- 交付用 query.exportCsv(从总表导)。

## 完成判据(铁律)
任何数据任务必须生成总表:query.run/schema.tables 能在总表查到数据才算完成。只做到大表=未完成,不得宣告完成。

## 关键语义
- 大表是重建式的:pipeline.run 每次先删后写,行数=源目录所有匹配文件合计。
- 加文件 ≠ 导入:bigtable.addFiles 只拷贝到 source/,必须重跑 pipeline.run。
- overwrite 缺省 false:同名文件跳过;要覆盖显式 true。
- 规则 YAML 是 clean 映射唯一事实来源:改映射只能 mapping.save。
- 血缘列自动附加:__source_file/__source_sheet/__source_row/__extracted_at。
- pipeline id 由调用方显式传入,禁止用 Date.now() 等不可复现 id。
- query.run 只读,仅 SELECT/WITH。
- 每文件多 sheet:用 mapping.save 的 sheetName 指定;不指定只导第一张。

## 工作流
打开工作区(workspace.open)→ 建大表(bigtable.save)→ 加文件(bigtable.addFiles)→ 每文件每 sheet 写映射(mapping.save)→ 建并跑 clean(进大表)→ 建并跑 sql-clean(SQL 里选 sheet/加月份/剔垃圾,进总表)→ query.exportCsv 导出交付。`;
