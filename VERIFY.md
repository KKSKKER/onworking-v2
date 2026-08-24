# OnWorking V2 — 数据层核心验证指南

> P0+P1 已完成:分叉 + 脚手架 + 7 个数据层模块,每个模块独立测试。**尚未集成**(按你的要求)。
> 你回来后,按下面顺序逐模块验证。全量:运行 `npm test`(25 个测试)。

## 模块清单(自底向上)

| 模块 | 源码 | 测试 | 验证命令 | 验证点 |
|---|---|---|---|---|
| T2 db 层 | `src/core/db/database.ts` | `tests/core/db.test.ts` | `npx vitest run tests/core/db.test.ts` | 批量事务写入,失败整批回滚 |
| T3 工作区+大表 | `src/core/workspace/` `src/core/bigtable/` | `tests/core/workspace.test.ts` `tests/core/bigtable.test.ts` | `npx vitest run tests/core/workspace.test.ts tests/core/bigtable.test.ts` | 工作区 init/open、settings(aiOpenMode)、大表 schema/校验/存取 |
| T4 ingest | `src/core/ingest/` | `tests/core/ingest.test.ts` | `npx vitest run tests/core/ingest.test.ts` | 扫描;Excel raw:true 保留原生类型;CSV 全字符串保留(防日期误判) |
| T5 ETL | `src/core/etl/` | `tests/core/etl.test.ts` | `npx vitest run tests/core/etl.test.ts` | 映射/类型转换(cents/date);5000 行/批写入 + INTEGER 列 + 进度 |
| T6 血缘 | `src/core/lineage/lineage.ts` | `tests/core/lineage.test.ts` | `npx vitest run tests/core/lineage.test.ts` | 行级来源列 __source_file/row/extracted_at |
| T7 版本管理 | `src/core/versioning/git.ts` | `tests/core/versioning.test.ts` | `npx vitest run tests/core/versioning.test.ts` | git init/status/commit 追踪 .onworking |
| T-log 日志模块 | `src/core/logging/` | `tests/core/logging.test.ts` | `npx vitest run tests/core/logging.test.ts` | 结构化 Logger + 级别过滤 + sink 机制 |
| T-err 错误捕获 | `src/core/errors/` | `tests/core/errors.test.ts` | `npx vitest run tests/core/errors.test.ts` | AppError(code/module/data) + captureError 入日志 |
| T-graph 血缘网络 | `src/core/lineage/graph.ts` | `tests/core/lineage-graph.test.ts` | `npx vitest run tests/core/lineage-graph.test.ts` | 有向图:upstream/downstream/getAffected/拓扑重算序 |
| T-wire 接入 | `src/core/etl/writer.ts` | `tests/core/etl.test.ts` | `npx vitest run tests/core/etl.test.ts` | writer 接入 logger + captureError(insert 失败进日志) |
| T-hdr 表头检测 | `src/core/ingest/header-detect.ts` | `tests/core/header-detect.test.ts` | `npx vitest run tests/core/header-detect.test.ts` | 前N行打分锁定表头,找不到返回 -1 |
| T-tpl 模板系统 | `src/core/template/store.ts` | `tests/core/template.test.ts` | `npx vitest run tests/core/template.test.ts` | 映射模板 save/apply(匹配反馈 matched/skipped) |
| T-st 项目状态机 | `src/core/state/project.ts` | `tests/core/project-state.test.ts` | `npx vitest run tests/core/project-state.test.ts` | 大表 phase 转移校验 + 持久化 + getSummary(Agent 读当前状态) |

## 实现时的关键决定(请确认是否符合预期)

1. **better-sqlite3 升到 v13**(Node 24 无 v11 预编译,已实测 v13 可用)。
2. **CSV 手写解析、全按字符串保留** —— 因为 SheetJS 会把 `2024-01`(期间)误判成日期序列号 45292(实测发现的坑),类型转换统一交给 ETL 层。
3. **大表文件夹位置**:`.onworking/bigtables/<folder>/bigtable.json`(git 可追踪的元数据区)。
4. **列类型用数据库原生类型字符串**(`sqlType: 'INTEGER'/'TEXT'/'REAL'`),不维护自造类型枚举。
   - 实测:better-sqlite3 v13 在**无类型列**上会把整数存成 REAL,所以金额列必须声明 `INTEGER` 才能保证"金额整数分"硬约束。
   - 语义类型(text/cents/number/date)→ 数据库类型 由 `dbTypeFor()` 映射(cents→INTEGER, number→REAL, text/date→TEXT)。

## 尚未做(等你确认后继续)

- **T8 集成**:scanner→parse→transform→lineage→write 全链路 + 真实数据性能测量(`demo:import`)。
- 管线引擎(把血缘有向图接进真实管线)、前端外壳、AI 开放模式、MCP —— 后续计划。
