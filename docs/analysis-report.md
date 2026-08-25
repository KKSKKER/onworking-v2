# Onworking V2 架构分析报告

> 分析对象：[activity.svg](activity.svg)（Agent App ↔ Auditor ↔ Onworking 交互泳道图）
> 分析日期：2026-08-25
> 代码基线：`main`（commit `244c9d1`）

本文围绕四个问题展开：

1. 当前代码能否**完整实现**图里设计的 17 处「接口」？
2. 有哪些**多余功能**可以删除或合并？
3. 各接口的**参数与返回值**是否设计完整？
4. 若采用「**先 CLI、后前端**」的调试方式，架构上需要怎么走？

---

## 1. 背景与范围

`activity.svg` 画的是「AI 智能体（Agent App）→ Onworking 本体」的交互流程，分几个泳道：

- **导入新文件 / 字段映射**：导入源文件 → 检测表头 → 生成映射 YAML → 设计大表字段 → 模板复用。
- **数据清洗 pipeline**：源文件按规则加载进大表 → 清洗 → 归集。
- **数据查询 pipeline**：新建查询 → 执行查询，跑在总表 DB 上。

图中「接口」标注在 **Onworking 泳道**上，对应代码里的两个层次：

| 层次 | 文件 | 说明 |
|---|---|---|
| **IPC 契约/处理器** | [src/ipc/contracts.ts](../src/ipc/contracts.ts)、[src/ipc/handlers.ts](../src/ipc/handlers.ts) | Onworking 对外暴露的「一切操作都是 API」，`ApiCommand` → `dispatch` → `ApiResult` |
| **AI 工具层** | [src/core/agent/tools.ts](../src/core/agent/tools.ts) | 泳道图里 Agent「调用 tool」的函数封装，IPC handler 内部委托给它 |

两者不是两套逻辑：handler 是入口，内部复用 `tool*` 函数，最终落到 core 层（pipeline / ingest / etl / rule / bigtable / state）。

---

## 2. 接口清单与代码映射

图中一共 **17 处**「接口」，逐一映射如下：

| # | 接口（图） | tool 函数 | IPC 命令 | 状态 |
|---|---|---|---|---|
| 1 | 通过 API 返回状态信息 | `toolGetProjectState` [tools.ts:32](../src/core/agent/tools.ts#L32) | `state.summary` | ✅ |
| 2 | 调整活跃工作区 | `toolOpenWorkspace` [tools.ts:27](../src/core/agent/tools.ts#L27) | `workspace.open` | ✅ |
| 3 | 创建新大表 | `toolCreateBigTable` [tools.ts:37](../src/core/agent/tools.ts#L37) | `bigtable.save` | ✅ |
| 4 | 导入文件 | `toolImportFiles` [tools.ts:61](../src/core/agent/tools.ts#L61) | —（无独立命令） | ⚠️ 语义不完整 |
| 5 | 确定文件表头的脚本 | `toolGetFileHeaders` [tools.ts:52](../src/core/agent/tools.ts#L52) → `detectSourceConfig`/`detectHeaderRow` | `setup.detectSource` / `setup.sheets` | ✅ |
| 6 | 生成修改工作表映射 YAML | `toolSetMapping` [tools.ts:77](../src/core/agent/tools.ts#L77) → `saveRule` | `mapping.save` | ✅ |
| 7 | 生成大表字段配置 | `toolSetBigTableFields` [tools.ts:42](../src/core/agent/tools.ts#L42) | `bigtable.save` | ✅ |
| 8 | 增加一份映射设置 | 复用 `toolSetMapping`/`saveRule` | `mapping.save` | ⚠️ 无「追加」语义 |
| 9 | 新增模板 | `saveTemplate` [store.ts:48](../src/core/template/store.ts#L48) | `template.save` | ⚠️ tool 层未封装 |
| 10 | 应用模板 | `toolApplyTemplate` [tools.ts:119](../src/core/agent/tools.ts#L119) | `template.apply` | ✅ |
| 11 | 增加数据清洗管线（带 SQL） | `toolCreateCleaningPipeline` [tools.ts:101](../src/core/agent/tools.ts#L101) / `toolCreateSqlCleanPipeline` [tools.ts:223](../src/core/agent/tools.ts#L223) | `pipeline.save` | ✅ |
| 12 | 根据规则加载至大表 | `toolRunCleaning` [tools.ts:130](../src/core/agent/tools.ts#L130) → `runCleanPipeline` | `pipeline.run`(clean) | ✅ |
| 13 | 清洗结果预览 | —（最接近 `toolVerifyData` 只返回行数） | — | ⚠️ 缺失 |
| 14 | 生成设置文件 | `savePipeline` [store.ts:41](../src/core/pipeline/store.ts#L41)（落盘 `.json`） | `pipeline.save` | ✅ 语义待确认 |
| 15 | 执行清洗并归集 | `toolMergeBigTable` [tools.ts:151](../src/core/agent/tools.ts#L151) / `toolMergeAll` [tools.ts:160](../src/core/agent/tools.ts#L160) | `pipeline.mergeBigTable` / `pipeline.mergeAll` | ✅ |
| 16 | 新建查询管线（带 SQL） | `toolCreateQueryPipeline` [tools.ts:205](../src/core/agent/tools.ts#L205) | `pipeline.save`(query) | ✅ |
| 17 | 执行查询管线 | `toolRunQueryPipeline` [tools.ts:241](../src/core/agent/tools.ts#L241) | `pipeline.run`(query) | ✅ |

**小结：13 处已完整实现，4 处存在缺口或语义偏差**（#4、#8、#9、#13）。

---

## 3. 可行性分析

**结论：设计可以完整实现，且主体已落地并带测试。**

核心数据链路已不是空壳，各环节都有实现：

| 环节 | 实现文件 |
|---|---|
| 扫描源目录 | [scanner.ts](../src/core/ingest/scanner.ts) |
| Excel/CSV 解析 | [parser.ts](../src/core/ingest/parser.ts) |
| 表头自动检测 | [header-detect.ts](../src/core/ingest/header-detect.ts) |
| 值转换（金额转分/日期归一/trim） | [transform.ts](../src/core/etl/transform.ts) |
| 批量写大表（5000 行/批） | [writer.ts](../src/core/etl/writer.ts) |
| 清洗执行器（源→大表独立 DB） | [clean-runner.ts](../src/core/pipeline/clean-runner.ts) |
| SQL 清洗执行器（大表→总表，ATTACH） | [sql-clean-runner.ts](../src/core/pipeline/sql-clean-runner.ts) |
| 查询执行器（CTAS 物化结果表） | [query-runner.ts](../src/core/pipeline/query-runner.ts) |
| 编排 + 按依赖重算 | [engine.ts](../src/core/pipeline/engine.ts) |
| 项目状态机 | [project.ts](../src/core/state/project.ts) |
| 端到端流程 | [flow.ts](../src/core/agent/flow.ts) 的 `runInitialSetupFlow` |

`tests/core/` 下已有对应单测（clean-runner、query-runner、pipeline-engine、header-detect、etl、ingest 等）。

**真正缺失/不完整的只有 4 处：**

1. **#13 清洗结果预览** —— 没有「查某大表 DB 清洗后结果」的只读工具/命令；`toolVerifyData` 只回两个行数，`engine.query` 查的是总表 DB 而非大表 DB。
2. **#9 新增模板** —— `saveTemplate` 只在 IPC 层（`template.save`），`tools.ts` 没有 `toolSaveTemplate`，AI/flow 无法直接「存模板」。
3. **#8 增加一份映射设置** —— `saveRule` 用固定文件名 `rule_<name>.yaml`，同名覆盖，不是「追加第 N 份映射」；`RuleYaml.sources` 是数组但 `toolSetMapping` 只填一个 source。
4. **「连接 MCP」** —— 图里明确有「连接 MCP」节点，但代码里**没有任何 MCP server**，只有 `tool*` 函数与 IPC。需补一层 MCP 适配（见 §6）。

---

## 4. 冗余分析（可删除/合并）

代码是「先做功能、后补抽象」的产物，存在几处明显重复：

| 冗余点 | 说明 | 建议 |
|---|---|---|
| **3 个相同执行器** `toolRunCleaning` [tools.ts:130](../src/core/agent/tools.ts#L130)、`toolBuildMasterTable` [tools.ts:166](../src/core/agent/tools.ts#L166)、`toolRunQueryPipeline` [tools.ts:241](../src/core/agent/tools.ts#L241) | 函数体一模一样，都是 `new PipelineEngine(ws).run(id)`；`pipeline.run` handler 已按 `kind` 分发 | 合并成一个 `toolRunPipeline(ws, id)`，按 kind 交给 `engine.run` |
| **4 个批量合并工具** `toolMergeBigTable`/`toolMergeAll`/`toolBuildMasterForBigTable`/`toolBuildMasterAll` [tools.ts:151-202](../src/core/agent/tools.ts#L151) | 本质是「按过滤条件跑一批管线」，与 `engine.recomputeAll/recomputeMany/recomputeByDependency` 重叠 | 收敛为一个 `toolRunPipelines(ws, filter)`，或直接复用 engine |
| **映射双轨表达** `CleanPipelineConfig.mappings` + `headerRow` [config.ts:16-18](../src/core/pipeline/config.ts#L16) vs 规则 YAML | [clean-runner.ts:99-117](../src/core/pipeline/clean-runner.ts#L99) 里「优先规则 YAML，否则 cfg.mappings」两条分支；图明确走 YAML，`mappings`/`headerRow` 是旧路 | 删 cfg 驱动分支（[clean-runner.ts:148-165](../src/core/pipeline/clean-runner.ts#L148)）与 `detectSourceConfig` 内联 headerRow，统一由规则 YAML 的 `sources[].headerRow` 驱动 |
| `onw-mock.ts` [onw-mock.ts](../src/renderer/mock/onw-mock.ts) | 浏览器 vite 开发用的假 `window.onw`，维护成本高、易与真实契约漂移 | 决定 CLI 先行后可删，或改造成「用 CLI 输出做 mock」 |
| `workspace.pick` [contracts.ts:15](../src/ipc/contracts.ts#L15) | 只是 `workspace.open` 的对话框变体，handler 还散在 [main/index.ts:41](../src/main/index.ts#L41) 而非 handlers.ts | 合并进 `workspace.open` |
| `toolVerifyData` [tools.ts:264](../src/core/agent/tools.ts#L264) | 只返回两个行数 | 等 #13 预览实现后吸收进去 |
| `toolListContext` [tools.ts:284](../src/core/agent/tools.ts#L284) | 未找到调用方 | 疑似死代码，确认后删 |

> 说明：`FieldMapping`（[transform.ts:8](../src/core/etl/transform.ts#L8)）与 `RuleField/RuleYaml`（[rule.ts:23](../src/core/rule/rule.ts#L23)）是同一概念的两种形态（持久化 YAML vs 内存可执行），中间靠 `compileRule`/`transformToKind` 桥接。这是**有意的分层**，不算冗余，但桥接要保留好。

---

## 5. 参数与返回值完整性

**结论：不完整，且类型偏松。** 逐项：

1. **类型松散** —— `mapping.save` 的 `mappings: unknown[]` [contracts.ts:20](../src/ipc/contracts.ts#L20)；handlers 里大量 `as never`/`as unknown` 强转 [handlers.ts:60](../src/ipc/handlers.ts#L60)、[handlers.ts:136](../src/ipc/handlers.ts#L136)；`dispatch` 返回 `ApiResult<unknown>`。CLI/调试场景下每个命令的入参/出参都应是确定类型。

2. **ID 非确定** —— `toolCreateCleaningPipeline` 用 `Date.now()` 生成 id [tools.ts:106](../src/core/agent/tools.ts#L106)，而 `toolCreateSqlCleanPipeline`/`toolCreateQueryPipeline` 是调用方显式传 id；flow.ts 还硬编码 `m_${Date.now()}`。不可复现，调试吃亏。应统一为调用方显式传 id。

3. **`toolImportFiles` 是假实现** —— [tools.ts:61-74](../src/core/agent/tools.ts#L61) 里 `void ws; void bigTableFolder` 忽略前两个参数，只 `scanSourceDir` 返回清单，**没有持久化导入、也没推进状态机到 `files-imported`**。`registerFiles` 只在清洗时被调 [engine.ts:96](../src/core/pipeline/engine.ts#L96)。「导入文件」接口语义不完整。

4. **`toolGetFileHeaders` 返回形状不对** —— [tools.ts:52](../src/core/agent/tools.ts#L52) 返回的 `detected` 只覆盖第一个 sheet，而 `sheets` 是列表，多 sheet 对不上。

5. **`toolApplyTemplate` 重复解析文件** —— [tools.ts:124](../src/core/agent/tools.ts#L124) 又 parse 一遍，应改为接受 `ParsedSheet` 或表头。

6. **进度是旁路、无结构化返回** —— 清洗进度走 `emitProgress` 侧信道（只在 Electron main 接线，`dispatch` 内部没有），返回值里无进度字段。CLI 下需改成 stdout 事件流或结构化 progress。

7. **`reqId` 被忽略** —— [contracts.ts:43](../src/ipc/contracts.ts#L43) 定义了 `IpcRequest.reqId`，但 `dispatch` 不回填，异步/并发下无法对账。

---

## 6. CLI 先行架构建议

**关键判断：这套代码已经是「命令总线」架构，天然适合 CLI 先行。**

[contracts.ts:3](../src/ipc/contracts.ts#L3) 的注释自己写着「一切操作都是 API —— UI / 插件 / AI 走同一个入口」。当前形态：

```
ApiCommand（联合类型） → dispatch(command, ctx) → ApiResult
```

Electron main 只是 `dispatch` 的一个前端（`onw:invoke` handler [main/index.ts:36](../src/main/index.ts#L36)），`ctx`（工作区状态）存在进程内存里。**CLI 就是给同一个 `dispatch` 再加一个 stdio 前端**，风险极低。

落地路径：

1. **抽出 `createContext`** —— [context.ts](../src/main/context.ts) 只依赖 core（`openWorkspace` + `PipelineEngine`），零 Electron import，可迁到 `src/app/context.ts`，CLI 与 Electron 共用。

2. **新增 `src/cli/index.ts`**，做成 NDJSON 命令循环：
   - `onw open <path>` → 建 ctx（持久在进程内，等同 Electron main 持有 ctx）
   - 之后从 stdin 读每行一条 `ApiCommand` JSON → `dispatch(command, ctx)` → 一行 `ApiResult` JSON 到 stdout，错误到 stderr + 非零退出码
   - 例：`echo '{"cmd":"bigtable.list"}' | onw open /path/to/ws`

3. **前端降级为薄客户端**，两种终态任选：
   - (a) 保持 Electron main 原样（本来就委托 `dispatch`），前端走 IPC；CLI 作为第二个入口
   - (b) 前端 spawn CLI 进程、走 stdio 传 JSON（即「前端向命令行传命令」）
   - 推荐 **(a) 做 UI、(b) 做调试**，因为两者共享同一个 `dispatch` 和同一套 `ApiCommand` 契约，不会出现两套逻辑。

4. **先收契约，再写 CLI** —— 在做 CLI 前先把 §5 的 1（强类型）、2（显式 id）、7（reqId 对账）修掉，否则 CLI 的 JSON I/O 契约就是「松散 unknown」，白搭。

5. **MCP 顺势封装** —— 图里的「连接 MCP」之后可用同一套 `dispatch` 包成 MCP server（每个 command 映射成一个 MCP tool），是命令总线架构的自然延伸，无需重构。

---

## 7. 建议实施顺序

1. **收契约** —— 强类型 `ApiCommand`/`ApiResult`、显式 id、`reqId` 对账。
2. **抽 context + 写 CLI** —— 迁移 `createContext`，新增 `src/cli/index.ts`，跑通 NDJSON 调试闭环。
3. **删冗余** —— 合并 3 个执行器 / 4 个批量工具 / cfg 映射双轨，删死代码。
4. **补缺口** —— #13 清洗结果预览、#9 存模板 tool、#8 多映射追加、MCP server。

CLI 一跑通，3、4 的调试与验证速度会快很多，所以 2 应尽量前置。
