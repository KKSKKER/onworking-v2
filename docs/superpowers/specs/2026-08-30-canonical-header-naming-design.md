# 重复表头统一编号命名设计（canonical header naming）

日期：2026-08-30
状态：已批准（命名契约 `姓名_1..N` + 裸名遇重复整个 run 失败，用户拍板）

## 背景与动机

用户真实场景：源 Excel 有 **三个「姓名」列**（从左到右），第一个是满的，但清洗导入后大表的姓名列**全空**。

根因（已定位）：

1. [src/core/etl/transform.ts](src/core/etl/transform.ts) `buildColIndex` 对表头做**遍历覆盖**——`colIndex.set(h, i)` 同名列"后者覆盖前者"，Map 最终指向**最右**那次出现。
2. [src/core/pipeline/clean-runner.ts](src/core/pipeline/clean-runner.ts) 拿这个列号逐行取值 → 取到的是最右（该场景全空）的姓名列。数据没丢，是**列号指错了列**。
3. **预览与导入对重复表头处理不一致**：预览视图 [src/renderer/views/PreviewView.tsx](src/renderer/views/PreviewView.tsx) 的 `dedupeHeaders` 把重复列名加后缀显示成 `姓名, 姓名_2, 姓名_3`（首列裸名）；导入却用裸名覆盖指向最后一列。用户在预览看到"第一个姓名满"，导入却取了第三个（空），两边对不上。
4. 现有重复表头告警（clean-runner「映射只取其一」）只提醒"取其一"，不说取的是哪个，也不帮选到有数据的列。

## 决策记录（用户拍板）

- **命名契约**：无重复的表头保持裸名（`姓名`）；有重复时按列从左到右编号为 `姓名_1, 姓名_2, …, 姓名_N`（1-based）。
- **裸名遇重复 → 整个 run 失败**：YAML 写裸名 `姓名` 而该文件表头存在重复 → clean 管线**整体失败（ok:false）**，错误信息进返回值，提示写 `姓名_1..N` 精确指定。**不静默取列、不猜测、不跳过该文件继续**。
- **编号只作用于 sourceHeader 解析**：`outputName`（大表列名）不受影响，仍由 YAML 决定。
- **编号是全局统一契约**：预览、映射 UI、`mapping.save` 校验、模板匹配、`unusedHeaders` 全部用同一套规范化名字，消除"预览看到 `姓名_2`、导入取的是第三个"的错位。

## 目标与验收标准

1. 三姓名列文件（第一个满）：YAML 写 `姓名_2` → 大表姓名列取到第 2 个姓名列的数据；写裸名 `姓名` → run 失败，返回值 `ok:false`，错误含编号提示。
2. 无重复表头的文件/现有 YAML：行为与现状**完全一致**（单例保持裸名，解析路径不变）。
3. 预览、映射 UI、校验、`unusedHeaders` 与导入使用同一套编号名。
4. `npm test` + `npm run typecheck` 全绿。

## 架构决策

**单一事实来源**：新增纯函数模块 `src/core/etl/headers.ts`，提供规范化表头 + 统一解析器。所有把「原始表头数组」变成「可匹配名字」的层（preview / mapping UI / clean-runner / mapping.save 校验 / 模板匹配 / 自动映射生成）只调用这一个函数，不再各自实现去重/覆盖逻辑。

**解析器统一**：`resolveHeaderIndex` 同时被 clean-runner（导入时）与 mapping.save（写规则时校验）调用，错误文案唯一来源，杜绝两处文案漂移。

## 组件设计

### ① `src/core/etl/headers.ts` — 规范化表头 + 统一解析器（新模块）

```ts
export interface CanonicalHeaders {
  names: string[];                     // 规范化后名字列表（唯一，与 raw 同长同序）
  duplicateOf: Map<string, string[]>;  // 裸名 → 该组编号名（仅重复组：姓名 → [姓名_1, 姓名_2, 姓名_3]）
}
export function canonicalizeHeaders(raw: string[]): CanonicalHeaders;
```

算法：
- 统计每个名字出现次数；出现 1 次 → 保持裸名。
- 出现 N>1 次 → 按列序命名为 `${name}_1..${name}_N`；后缀若与已有表头字符串冲突则顺延（防 `姓名_1` 恰好是另一列的原始名，算法保持确定性、不覆盖任何名字）。
- `duplicateOf` 仅收录出现 >1 次的裸名 → 编号列表。

```ts
export function resolveHeaderIndex(
  canonical: CanonicalHeaders,
  sourceHeader: string,
):
  | { kind: 'ok'; index: number | undefined }   // 命中编号名/单例裸名 → index；名字不存在 → index undefined（宽容路径，映射为 null）
  | { kind: 'duplicate-bare'; error: string };  // 裸名存在于 duplicateOf（有重复但 YAML 没写编号）→ 报错
```

解析语义：
- 精确命中 `canonical.names` 中的编号名（如 `姓名_2`）→ `{ kind:'ok', index }`。
- 命中单例裸名（如唯一 `姓名`）→ `{ kind:'ok', index }`。
- 裸名存在于 `canonical.duplicateOf`（即该文件有重复、YAML 却没写编号）→ `{ kind:'duplicate-bare', error: "源文件表头「姓名」出现 3 次,映射 sourceHeader「姓名」未指定编号。请在 YAML 写 姓名_1 / 姓名_2 / 姓名_3 精确指定要映射的列。" }`。
- 名字根本不存在 → `{ kind:'ok', index: undefined }`：走现有"该文件无此列"的宽容路径（缺列 → null），保持与现状一致（规则 pattern 匹配多文件时，某文件缺某表头属正常）。`resolveHeaderIndex` 只在"存在但重复"时给 `duplicate-bare`。

### ② `src/core/etl/transform.ts` — 列索引构建改为规范名

`buildColIndex(headers: string[]): Map<string, number>` 改为基于 canonical `names` 构建（`names.forEach((h, i) => colIndex.set(h, i))`）。名字唯一 → 无覆盖问题，`姓名_2` 精确命中。`applyMappingRow` 不变（仍是 `colIndex.get(m.sourceHeader)`）。

### ③ `src/core/pipeline/clean-runner.ts` — 导入时统一解析 + 整体失败

- 每文件读入后调一次 `canonicalizeHeaders(stream.headers)`，得到 `{ names, duplicateOf }`。
- `buildColIndex(names)`。
- `unusedHeaders` 改用 `names` 收集（重复列未映射时报 `姓名_2` 等编号名，更精确）。
- 旧的"映射只取其一"告警（154-159 行）**删除**，替换为：对每条 ruleMapping 调 `resolveHeaderIndex`；返回 `error` → **抛错，整个 run 失败**（`ok:false`，error message 即解析器文案），不落入按文件 catch 的"跳过该文件"分支。
- 其余（血缘列、批写入、`dropExisting`、进度契约）不变。

### ④ `src/core/agent/tools.ts` — mapping.save 校验提前拦错

[validateMappings / 表头校验](src/core/agent/tools.ts)（`parsedSheets.some((s) => s.headers.includes(m.sourceHeader))`）改为：对每个匹配 sheet 调 `canonicalizeHeaders`，校验 `m.sourceHeader` 命中 `names` 或（裸名）命中单例。命中重复组的裸名 → 拒绝保存并给编号提示；编号名 `姓名_2` 命中 → 通过。写规则时就拦下错误，而非留到 run 时。

### ⑤ `src/core/template/store.ts` — 模板匹配用规范名

`headers.has(m.sourceHeader)` → `canonicalizeHeaders(sheet.headers).names.has(...)`。

### ⑥ `src/renderer/views/PreviewView.tsx` — 预览列名与 YAML 一致

删本地 `dedupeHeaders`（22-29 行），预览列名改用共享 `canonicalizeHeaders(...).names`。预览显示 `姓名_1, 姓名_2, 姓名_3`，与 YAML 可写名完全对齐。

### ⑦ `src/renderer/views/MappingView.tsx` + `src/core/agent/flow.ts` — 自动映射用规范名

- MappingView 自动回填（176-183 行 `sourceHeader: h`）与 flow.ts `guessFieldsAndMappings`（45-49 行）的 headers 先过 `canonicalizeHeaders(...).names`，重复列显示为 `姓名_1/姓名_2/姓名_3`，UI 下拉/字段表可精确选第 N 列。
- `outputName` 沿用规范名（有重复时大表列即为 `姓名_1` 等，语义清晰）；agent/用户可在 UI 改 outputName。

### ⑧ `src/core/pipeline/setup.ts` — 不动

`detectSourceConfig` 返回原始 headers，消费方（PreviewView / MappingView）各自 canonicalize，本模块不背去重逻辑。

## 测试计划（TDD，先写失败测试）

- `tests/core/headers.test.ts`（新）：
  - `canonicalizeHeaders`：无重复（原样）/ 有重复（`姓名_1.._3` 按列序）/ 混合 / 后缀与既有名冲突（确定性顺延）/ 空数组。
  - `resolveHeaderIndex`：编号名命中 / 单例裸名命中 / 裸名+重复 → error 且文案含编号提示 / 不存在 → 不报错（宽容路径）。
- `tests/core/etl.test.ts`：`buildColIndex` 基于规范名精确解析（`姓名_2` → 正确列号；无覆盖）。
- `tests/core/pipeline-clean-stream.test.ts`（或 clean-runner.test）：
  - 三姓名列（首列满）+ 裸名 `姓名` → run 失败，返回 `ok:false`，error 含"姓名_1 / 姓名_2 / 姓名_3"。
  - 三姓名列 + `姓名_2` → 大表该列取第 2 列数据。
  - 单表头文件 + 裸名 → 行为与现状一致（回归）。
- `tests/core/agent-tools.test.ts`：mapping.save 接受 `姓名_2`；拒绝"裸名+重复"并给编号提示。
- `tests/core/template-store.test.ts`：模板匹配命中规范名。
- unusedHeaders 断言：重复列未映射时报告编号名（如 `姓名_2`）。

## 验收与回归

1. 现有 `npm test` + `npm run typecheck` 全绿（重点回归：无重复表头的既有 clean/模板/预览用例）。
2. 新用例覆盖上述契约（整体失败 / 编号名精确取值 / 单例回归）。

## 范围外（本次明确不做）

- **编号名之外的新 YAML 字段**（如 `sourceCol` 列号、`sourceHeaderIndex`）：命名契约已满足需求，不引入平行机制。
- 大表 `outputName` 的自动去重/改名策略：outputName 仍由 YAML 决定，本次不自动改列名。
- 预览/UI 对"选中哪个重复列"的交互增强（如下拉自动提示重复组）：当前规范名已可精确表达，交互增强留给后续。

## 风险

- **既有 YAML 用裸名 + 文件有重复**：行为从"静默取最右"变为"整个 run 失败"——这是预期行为变化（消除静默错列），但 agent 需按错误提示改写 YAML；风险=存量规则一次性报错，缓解=错误文案直接给出编号列表，改起来明确。
- **后缀冲突**（原表头恰为 `姓名_1`）：规范化顺延策略保证确定性且不覆盖任何名字；用测试兜底。
- **多文件 pattern 混有/无重复**：`姓名_1` 对无重复文件解析为缺列 → null（沿用现状宽容语义）；规则本就按文件形态拆分（pattern/sheetName），文档化即可，不改变行为。
