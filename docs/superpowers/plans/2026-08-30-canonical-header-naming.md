# 重复表头统一编号命名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重复表头按 `姓名_1..N` 统一编号，YAML 可写编号名精确指列；裸名遇重复时整个 clean run 失败（ok:false）并在返回值报错，消除"静默取最右错列"。

**Architecture:** 新增纯函数模块 `src/core/etl/headers.ts`（`canonicalizeHeaders` + `resolveHeaderIndex`）作为唯一事实来源；`buildColIndex` 改为基于规范名构建（不再遍历覆盖）；clean-runner 对每条映射做解析，遇 `duplicate-bare` 抛 `AppError`（engine 已把 runCleanPipeline 的抛错包成 `ok:false`）；mapping.save 校验、模板匹配、预览、映射 UI、自动映射全部改用同一套规范名。

**Tech Stack:** TypeScript / better-sqlite3 / vitest / xlsx(SheetJS, 仅测试 fixture 与旧解析路径)

**Spec:** [docs/superpowers/specs/2026-08-30-canonical-header-naming-design.md](../specs/2026-08-30-canonical-header-naming-design.md)

## Global Constraints

- 命名契约：无重复 → 裸名（`姓名`）；有重复 → `姓名_1..姓名_N`（1-based 按列序，从左到右）。
- 裸名 + 重复 → clean 管线**整个 run 失败**（`ok:false`），错误信息进返回值；错误文案唯一来源是 `resolveHeaderIndex`。
- 编号只作用于 sourceHeader 解析；`outputName`（大表列名）不变。
- 兼容性：无重复表头的文件/现有 YAML 行为完全不变。
- 测试夹具陷阱：xlsx 读取器有"孤值列"规则（count<2 的列不进 `effColCount`）——空数据的重复列若在所有有数据列的右侧会被**丢弃**，`stream.headers` 里就没有重复了。测试 fixture 必须在重复列右侧放一个有数据列（或让重复列至少有一个数据格），保证重复表头存活。

---

### Task 1: `src/core/etl/headers.ts` — 规范化表头 + 统一解析器（新模块）

**Files:**
- Create: `src/core/etl/headers.ts`
- Test: `tests/core/headers.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，零依赖）
- Produces（后续所有任务依赖）：
  ```ts
  export interface CanonicalHeaders {
    names: string[];                     // 规范化后名字列表（与 raw 同长同序，元素唯一）
    duplicateOf: Map<string, string[]>;  // 裸名 → 该组编号名（仅出现>1次；姓名 → [姓名_1,姓名_2,姓名_3]）
  }
  export function canonicalizeHeaders(raw: string[]): CanonicalHeaders;
  export function resolveHeaderIndex(canonical: CanonicalHeaders, sourceHeader: string):
    | { kind: 'ok'; index: number | undefined }      // 命中编号名/单例裸名 → index；名字不存在 → undefined（宽容路径）
    | { kind: 'duplicate-bare'; error: string };     // 裸名存在于 duplicateOf → 报错
  ```

- [x] **Step 1: 写失败测试 `tests/core/headers.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { canonicalizeHeaders, resolveHeaderIndex } from '../../src/core/etl/headers';

describe('canonicalizeHeaders', () => {
  it('keeps single-occurrence headers unchanged', () => {
    expect(canonicalizeHeaders(['日期', '借方金额']).names).toEqual(['日期', '借方金额']);
    expect(canonicalizeHeaders(['日期']).duplicateOf.size).toBe(0);
  });
  it('numbers duplicate headers 姓名_1..N in column order', () => {
    const c = canonicalizeHeaders(['姓名', '出生日期', '姓名', '账号', '姓名']);
    expect(c.names).toEqual(['姓名_1', '出生日期', '姓名_2', '账号', '姓名_3']);
    expect(c.duplicateOf.get('姓名')).toEqual(['姓名_1', '姓名_2', '姓名_3']);
  });
  it('handles mixed duplicates and singles', () => {
    expect(canonicalizeHeaders(['姓名', '姓名', '账号']).names).toEqual(['姓名_1', '姓名_2', '账号']);
  });
  it('skips a suffix that collides with an existing raw header', () => {
    // 原始表头恰好有 姓名_1(独立列) + 两个裸 姓名 → 裸名组编号顺延为 姓名_2/姓名_3
    const c = canonicalizeHeaders(['姓名', '姓名_1', '姓名']);
    expect(c.names).toEqual(['姓名_2', '姓名_1', '姓名_3']);
    expect(c.duplicateOf.get('姓名')).toEqual(['姓名_2', '姓名_3']);
  });
  it('returns empty arrays for empty input', () => {
    const c = canonicalizeHeaders([]);
    expect(c.names).toEqual([]);
    expect(c.duplicateOf.size).toBe(0);
  });
});

describe('resolveHeaderIndex', () => {
  const canonical = canonicalizeHeaders(['姓名', '出生日期', '姓名', '账号', '姓名']);
  it('resolves a numbered name to its column index', () => {
    expect(resolveHeaderIndex(canonical, '姓名_2')).toEqual({ kind: 'ok', index: 2 });
    expect(resolveHeaderIndex(canonical, '出生日期')).toEqual({ kind: 'ok', index: 1 });
  });
  it('returns duplicate-bare error when a bare name has duplicates', () => {
    const r = resolveHeaderIndex(canonical, '姓名');
    expect(r.kind).toBe('duplicate-bare');
    if (r.kind === 'duplicate-bare') {
      expect(r.error).toContain('姓名_1');
      expect(r.error).toContain('姓名_2');
      expect(r.error).toContain('姓名_3');
    }
  });
  it('returns ok with undefined index for an absent name (lenient)', () => {
    expect(resolveHeaderIndex(canonical, '不存在')).toEqual({ kind: 'ok', index: undefined });
  });
  it('resolves a bare name to index when no duplicates exist', () => {
    const single = canonicalizeHeaders(['姓名', '账号']);
    expect(resolveHeaderIndex(single, '姓名')).toEqual({ kind: 'ok', index: 0 });
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/headers.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/etl/headers'`

- [x] **Step 3: 实现 `src/core/etl/headers.ts`**

```ts
// src/core/etl/headers.ts
// 重复表头统一编号命名(canonical header naming):
//   无重复 → 表头名保持裸名;有重复 → 按列序编号 姓名_1..N(1-based)。
//   全链路(预览/映射UI/导入/校验/模板/unusedHeaders)只认这一份规范化结果。
// 算法保证确定性、不覆盖任何名字(编号名与既有表头冲突时顺延)。

export interface CanonicalHeaders {
  /** 规范化后名字列表(与 raw 同长同序,元素唯一)。 */
  names: string[];
  /** 裸名 → 该组编号名(仅出现 >1 次的表头;如 姓名 → [姓名_1, 姓名_2, 姓名_3])。 */
  duplicateOf: Map<string, string[]>;
}

export function canonicalizeHeaders(raw: string[]): CanonicalHeaders {
  const count = new Map<string, number>();
  for (const h of raw) count.set(h, (count.get(h) ?? 0) + 1);
  const used = new Set<string>(raw);            // 已占用名:编号名不得与任何既有表头冲突
  const usedCount = new Map<string, number>();  // 每个重复组已分配到的编号
  const names: string[] = [];
  const duplicateOf = new Map<string, string[]>();
  for (const h of raw) {
    if ((count.get(h) ?? 0) <= 1) {
      names.push(h);
      continue;
    }
    let k = (usedCount.get(h) ?? 0) + 1;
    let candidate = `${h}_${k}`;
    while (used.has(candidate)) { k += 1; candidate = `${h}_${k}`; } // 冲突顺延
    usedCount.set(h, k);
    used.add(candidate);
    names.push(candidate);
    const list = duplicateOf.get(h) ?? [];
    list.push(candidate);
    duplicateOf.set(h, list);
  }
  return { names, duplicateOf };
}

export function resolveHeaderIndex(
  canonical: CanonicalHeaders,
  sourceHeader: string,
):
  | { kind: 'ok'; index: number | undefined }
  | { kind: 'duplicate-bare'; error: string } {
  const idx = canonical.names.indexOf(sourceHeader);
  if (idx !== -1) return { kind: 'ok', index: idx };
  const dup = canonical.duplicateOf.get(sourceHeader);
  if (dup && dup.length > 0) {
    return {
      kind: 'duplicate-bare',
      error: `源文件表头「${sourceHeader}」出现 ${dup.length} 次,映射 sourceHeader「${sourceHeader}」未指定编号。请在 YAML 写 ${dup.join(' / ')} 精确指定要映射的列。`,
    };
  }
  return { kind: 'ok', index: undefined }; // 名字不存在 → 宽容路径(缺列 → null)
}
```

- [x] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/headers.test.ts`
Expected: PASS（5 + 4 用例全绿）

- [x] **Step 5: 提交**

```bash
git add src/core/etl/headers.ts tests/core/headers.test.ts
git commit -m "feat(etl): 重复表头统一编号 canonicalizeHeaders + resolveHeaderIndex"
```

---

### Task 2: `src/core/etl/transform.ts` — buildColIndex 改为规范名

**Files:**
- Modify: `src/core/etl/transform.ts:18-23`（`buildColIndex`；删除"遍历覆盖/末次出现"注释），新增 import
- Test: `tests/core/etl.test.ts`

**Interfaces:**
- Consumes: `canonicalizeHeaders`（Task 1）
- Produces: `buildColIndex(headers: string[]): Map<string, number>` 签名不变，但内部先规范化 → 名字唯一、无覆盖；`姓名_2` 精确命中，裸 `姓名` 在重复场景下 `get` 返回 `undefined`（不再指向最右）

- [x] **Step 1: 写失败测试（追加到 `tests/core/etl.test.ts` 末尾 describe 内）**

```ts
import { applyMapping, buildColIndex, centsToInt, normalizeDate, type FieldMapping } from '../../src/core/etl/transform';
// 修改第 3 行 import,补 buildColIndex

  it('buildColIndex maps numbered duplicates exactly (no last-wins overwrite)', () => {
    const idx = buildColIndex(['姓名', '出生日期', '姓名', '账号', '姓名']);
    expect(idx.get('姓名_2')).toBe(2);
    expect(idx.get('姓名')).toBeUndefined(); // 裸名不再指向最右
    expect(idx.get('账号')).toBe(3);
  });
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/etl.test.ts`
Expected: FAIL — `expect(idx.get('姓名_2')).toBe(2)` 得到 `undefined`（当前 buildColIndex 不产生编号名）

- [x] **Step 3: 实现**

`transform.ts` 顶部新增：`import { canonicalizeHeaders } from './headers';`
替换 `buildColIndex` 为：

```ts
/** 表头 → 列号索引:先规范化(重复表头编号 姓名_1..N),再精确映射;名字唯一,无覆盖。 */
export function buildColIndex(headers: string[]): Map<string, number> {
  const { names } = canonicalizeHeaders(headers);
  const colIndex = new Map<string, number>();
  names.forEach((h, i) => colIndex.set(h, i));
  return colIndex;
}
```

- [x] **Step 4: 运行确认通过 + 既有用例回归**

Run: `npx vitest run tests/core/etl.test.ts tests/core/etl-stream.test.ts`
Expected: PASS（新增用例 + 全部既有用例；`applyMapping` 路径在无重复表头下行为不变）

- [x] **Step 5: 提交**

```bash
git add src/core/etl/transform.ts tests/core/etl.test.ts
git commit -m "feat(etl): buildColIndex 基于规范名构建,消除重复表头静默覆盖"
```

---

### Task 3: `src/core/pipeline/clean-runner.ts` — 统一解析 + 裸名遇重复整个 run 失败

**Files:**
- Modify: `src/core/pipeline/clean-runner.ts`
  - 新增 import：`import { canonicalizeHeaders, resolveHeaderIndex } from '../etl/headers';`
  - 重构文件循环体（当前 129-176 行）：把"建 stream"与"逐行读"两个 try 拆开，解析检查放在两者之间、**不落入**按文件 catch 的"跳过"分支
  - 删除旧的"映射只取其一"告警（154-159 行）
  - `unusedHeaders` 改用 `canonical.names`
- Test: `tests/core/clean-runner.test.ts`、`tests/core/pipeline-engine.test.ts`

**Interfaces:**
- Consumes: `canonicalizeHeaders` / `resolveHeaderIndex`（Task 1）、`buildColIndex`（Task 2，签名不变）
- Produces: `runCleanPipeline` 抛 `AppError{ code:'CLEAN_DUPLICATE_HEADER' }`；engine（已存在 catch）将其包成 `RunSummary{ ok:false, error }` —— 即用户要的"整个 run 失败、错误进返回值"

- [x] **Step 1: 写失败测试（追加到 `tests/core/clean-runner.test.ts`）**

复制现有 `beforeEach` 的夹具模式。每条新用例用**独立 `dupDir` + `dupCfg`**（不要写进共享 `sourceDir`，否则 pattern `**/*` 会连 beforeEach 的 a.xlsx 一起匹配，行数断言会错）。fixture 关键：第 2 个「姓名」列有数据；右侧「备注」有数据列保证空重复列不被读取器孤值列规则丢弃（xlsx-reader.ts:276 `maxCol = 最右 count≥2 的列`）。

```ts
  it('fails the whole run when a bare sourceHeader matches duplicate headers', async () => {
    const dupDir = join(dir, 'dup-src');
    mkdirSync(dupDir, { recursive: true });
    // 3 个「姓名」列:第 2 个有数据,其余空;右侧「备注」有数据保证重复列存活
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(dupDir, 'dup.xlsx'));
    saveRule(workspace, 'seq', {
      name: 'seq_rule',
      display: '重复表头',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '姓名', outputName: 'name', included: true, order: 1, transforms: [{ kind: 'coerce_string' }] },
      ],
    });
    const dupCfg: CleanPipelineConfig = { kind: 'clean', id: 'c4', label: '', bigTableFolder: 'seq', sourceDir: dupDir, createdAt: '' };
    // 裸名「姓名」+ 重复表头 → 整个 run 失败(抛 CLEAN_DUPLICATE_HEADER,不进"跳过该文件"分支)
    const err = await runCleanPipeline(workspace, db, dupCfg, bigTable).then(
      () => null,
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'CLEAN_DUPLICATE_HEADER' });
    expect(err.message).toMatch(/姓名_1/);
  });

  it('resolves a numbered sourceHeader to the exact duplicate column', async () => {
    const dupDir = join(dir, 'dup-src2');
    mkdirSync(dupDir, { recursive: true });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(dupDir, 'dup.xlsx'));
    saveRule(workspace, 'seq', {
      name: 'seq_rule',
      display: '重复表头',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '姓名_2', outputName: 'name', included: true, order: 1, transforms: [{ kind: 'coerce_string' }] },
      ],
    });
    const dupCfg: CleanPipelineConfig = { kind: 'clean', id: 'c5', label: '', bigTableFolder: 'seq', sourceDir: dupDir, createdAt: '' };
    // 大表 fields 需含 name 列:复用共享 bigTable 追加一个
    const bt: BigTableConfig = { ...bigTable, fields: [...bigTable.fields, { name: 'name', type: 'TEXT', order: 4 }] };
    const res = await runCleanPipeline(workspace, db, dupCfg, bt);
    expect(res.rowsInserted).toBe(2);
    const rows = db.prepare('SELECT name FROM seq').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['张三', '李四']); // 取的是第 2 个姓名列
  });
```

- [x] **Step 1b: 更新既有『重复表头只取其一』告警用例（行为已改为整体报错）**

现有 `warns when a mapped source header is duplicated in the source`（clean-runner.test.ts:144-167）断言「裸名 `其他` + 重复表头」仍成功且出告警 —— 与新契约直接冲突（会回归失败），必须改为报错断言。id 沿用 c2 覆盖原用例：

```ts
  it('bare sourceHeader on duplicated headers fails the run (was: take-one warning)', async () => {
    const dupDir = join(dir, 'dup-src');
    mkdirSync(dupDir, { recursive: true });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['日期', '其他', '借方金额', '其他'],
      ['2024-01', 'x', 100, 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(dupDir, 'dup.xlsx'));
    saveRule(workspace, 'seq', {
      name: 'seq_dup_rule',
      display: '重复表头',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
        { sourceHeader: '其他', outputName: 'other', included: true, order: 2, transforms: [{ kind: 'none' }] },
      ],
    });
    const dupCfg: CleanPipelineConfig = { kind: 'clean', id: 'c2', label: '', bigTableFolder: 'seq', sourceDir: dupDir, createdAt: '' };
    const err = await runCleanPipeline(workspace, db, dupCfg, bigTable).then(
      () => null,
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'CLEAN_DUPLICATE_HEADER' });
    expect(err.message).toMatch(/其他_1/);
  });
```

（`其他` 两列各有 1 个数据格 → 不被孤值列规则丢弃；规范化为 `其他_1/其他_2`。注意 beforeEach 已有一条 `seq_rule`，loadRules 会加载两条规则，`seq_dup_rule` 的裸 `其他` 触发报错即可。）

另在 `tests/core/pipeline-engine.test.ts` 加一条"返回值 ok:false"用例（引擎层，直接验证用户要求）。beforeEach 已建 bigTable seq（date/debit）+ 管线 c1 + sourceDir a.xlsx；本用例加重复表头文件 + 覆盖规则为裸名 `姓名`，并补大表 config 的 name 字段：

```ts
  it('clean run with bare sourceHeader on duplicate headers returns ok:false with error', async () => {
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'dup.xlsx'));
    saveBigTableConfig(ws, 'seq', {
      tableName: 'seq',
      autoIncrement: true,
      fields: [
        { name: 'date', type: 'TEXT', order: 1 },
        { name: 'debit', type: 'INTEGER', order: 2 },
        { name: 'name', type: 'TEXT', order: 3 },
      ],
    });
    saveRule(ws, 'seq', {
      name: 'seq_rule',
      display: '重复表头',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '姓名', outputName: 'name', included: true, order: 1, transforms: [{ kind: 'coerce_string' }] },
      ],
    });
    const eng = new PipelineEngine(ws);
    const r = await eng.run('c1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/姓名_1/);
    eng.close();
  });
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/clean-runner.test.ts tests/core/pipeline-engine.test.ts`
Expected: FAIL
- 裸名用例：当前不抛错，`rejects` 断言失败（数据被静默取到最右空列）
- 编号名用例：当前 `姓名_2` 在 colIndex 里不存在 → name 列为 null，断言失败

- [x] **Step 3: 实现（重构 clean-runner 文件循环体）**

把当前 129-176 行的循环体整体替换为（保留 `csvRows` 辅助函数不动）：

```ts
        for (const file of matched) {
          processedFiles++;
          onProgress?.({ stage: 'parse', percent: Math.round((processedFiles / files.length) * 70) });
          let stream: SheetRowStream | null;
          try {
            // 有 sheetName → 只解析该 sheet(避免全表解析被「格式蔓延」的假大范围拖慢);否则取第一张
            const isCsv = file.path.toLowerCase().endsWith('.csv');
            if (isCsv) {
              const sheets = parseCsvFile(file.path, { headerRow: source.headerRow });
              const sheet = source.sheetName
                ? sheets.find((s) => s.sheetName === source.sheetName)
                : sheets[0];
              stream = sheet
                ? { sheetName: sheet.sheetName, headers: sheet.headers, rows: csvRows(sheet.rows) }
                : null;
            } else {
              stream = await readExcelSheetStream(file.path, source.sheetName, { headerRow: source.headerRow });
            }
          } catch (e) {
            // 单个文件读不了(如密码保护/损坏)不拖垮整条管线:跳过并在告警里说明
            warnings.add(`跳过无法读取的文件 ${basename(file.path)}: ${(e as Error).message}`);
            continue;
          }
          if (!stream) continue; // 目标 sheet 不存在 → 该文件跳过

          // 统一规范化表头 + 解析映射:裸名命中重复表头 → 整个 run 失败(配置错误,
          // 必须抛错,不落入上面"跳过文件"的 catch 分支 → engine 包成 ok:false)
          const canonical = canonicalizeHeaders(stream.headers);
          for (const m of ruleMappings) {
            const r = resolveHeaderIndex(canonical, m.sourceHeader);
            if (r.kind === 'duplicate-bare') {
              throw new AppError({
                module: 'pipeline/clean',
                code: 'CLEAN_DUPLICATE_HEADER',
                message: r.error,
                data: { sourceFile: file.path, sourceHeader: m.sourceHeader },
              });
            }
          }
          // 未用表头检测:源表头(规范名)里没被当前规则任一映射 sourceHeader 引用的,
          // 数据不会进大表 —— 收集起来返回给 agent(可能有映射漏写/拼写不匹配)
          const mappedHeaders = new Set(ruleMappings.map((m) => m.sourceHeader));
          for (const h of canonical.names) {
            if (!mappedHeaders.has(h)) unusedHeaders.add(h);
          }
          const colIndex = buildColIndex(canonical.names);
          let rowNo = 0;
          try {
            for await (const row of stream.rows) {
              const mapped = applyMappingRow(row, colIndex, ruleMappings);
              attachLineage([mapped], {
                sourceFile: file.path,
                sourceSheet: stream.sheetName,
                sourceRow: source.headerRow + 1 + rowNo,
              }, extractedAt);
              rowNo++;
              yield mapped;
            }
          } catch (e) {
            warnings.add(`跳过无法读取的文件 ${basename(file.path)}: ${(e as Error).message}`);
          }
        }
```

- [x] **Step 4: 运行确认通过 + 回归**

Run: `npx vitest run tests/core/clean-runner.test.ts tests/core/pipeline-engine.test.ts`
Expected: PASS（新用例绿；既有 clean/engine 用例不受影响——无重复表头路径行为不变）

- [x] **Step 5: 提交**

```bash
git add src/core/pipeline/clean-runner.ts tests/core/clean-runner.test.ts tests/core/pipeline-engine.test.ts
git commit -m "feat(pipeline): 裸 sourceHeader 命中重复表头 → CLEAN_DUPLICATE_HEADER 整个 run 失败"
```

---

### Task 4: `src/core/agent/tools.ts` — mapping.save 校验用规范名，写规则时提前拦裸名+重复

**Files:**
- Modify: `src/core/agent/tools.ts:326-353`（`findMissingSourceHeaders`）、`399-407`（`toolSetMapping` 的 missing 检查）
- Test: `tests/core/tools.test.ts`

**Interfaces:**
- Consumes: `canonicalizeHeaders` / `resolveHeaderIndex`（Task 1）
- Produces: `findMissingSourceHeaders` 返回 `{ missing: string[]; duplicate: string[]; actual: string[] }`；`toolSetMapping` 对 `duplicate.length>0` 抛 `AppError{ code:'MAPPING_DUPLICATE_HEADER', message: 首个 duplicate 文案 }`

- [x] **Step 1: 写失败测试（追加到 `tests/core/tools.test.ts`）**

```ts
  it('toolSetMapping accepts a numbered sourceHeader on duplicate-header files', () => {
    const src = bigTableSourceDir(ws, 'seq'); // findMissingSourceHeaders 扫的是大表自己的 source 目录
    mkdirSync(src, { recursive: true });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(src, 'dup.xlsx'));

    const { ruleFile } = toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '姓名_2', outputName: 'name', transform: 'none' },
    ], { pattern: 'dup.xlsx', sheetName: 'Sheet1' });
    expect(ruleFile).toMatch(/\.yaml$/);
  });

  it('toolSetMapping rejects a bare sourceHeader on duplicate-header files (MAPPING_DUPLICATE_HEADER)', () => {
    const src = bigTableSourceDir(ws, 'seq');
    mkdirSync(src, { recursive: true });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(src, 'dup.xlsx'));

    expect(() => toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '姓名', outputName: 'name', transform: 'none' },
    ], { pattern: 'dup.xlsx', sheetName: 'Sheet1' })).toThrowError(/MAPPING_DUPLICATE_HEADER|姓名_1/);
  });
```

（`姓名_2` 对 dup.xlsx 精确命中 → 校验通过；裸 `姓名` 对 dup.xlsx 返回 `duplicate-bare` → 抛错。**fixture 必须写进 `bigTableSourceDir(ws, 'seq')`**（大表自己的 source 目录，与真实 addFiles 流程一致），否则 `findMissingSourceHeaders` 扫不到 → 校验被静默跳过 → 两条用例假绿。

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/tools.test.ts`
Expected: FAIL
- 编号名用例：`姓名_2` 不在原始 headers 里 → 现有校验报 `MAPPING_HEADER_MISMATCH` 而非通过
- 裸名用例：裸名在原始 headers 里 → 现有校验通过（错误地接受），断言不抛错

- [x] **Step 3: 实现**

在 tools.ts 顶部（import 区）加 `import { canonicalizeHeaders, resolveHeaderIndex } from '../etl/headers';`

整体替换 `findMissingSourceHeaders`（当前 324-353 行）为（返回值类型与所有提前返回都要加 `duplicate`）：

```ts
/** 校验规则的 sourceHeader 是否存在于规则匹配的实际文件的表头。
 *  返回缺失的 sourceHeader、裸名命中重复表头的报错文案、目标表头合集(规范名);
 *  无法解析(无匹配文件/密码保护/读不了)时返回空(跳过校验)。 */
function findMissingSourceHeaders(
  ws: Workspace,
  bigTableFolder: string,
  pattern: string,
  sheetName: string | undefined,
  headerRow: number,
  mappings: FieldMapping[],
): { missing: string[]; duplicate: string[]; actual: string[] } {
  const dir = bigTableSourceDir(ws, bigTableFolder);
  if (!existsSync(dir)) return { missing: [], duplicate: [], actual: [] };
  const re = patternToRegex(pattern);
  const files = scanSourceDir(dir).filter((f) => re.test(f.relPath) || re.test(f.path));
  if (files.length === 0) return { missing: [], duplicate: [], actual: [] };
  const parsedSheets: ParsedSheet[] = [];
  for (const file of files) {
    try {
      const isCsv = file.path.toLowerCase().endsWith('.csv');
      const sheet = sheetName
        ? (isCsv ? parseCsvFile(file.path, { headerRow }).find((s) => s.sheetName === sheetName) : parseExcelSheet(file.path, sheetName, { headerRow }))
        : (isCsv ? parseCsvFile(file.path, { headerRow })[0] : parseExcelFile(file.path, { headerRow })[0]);
      if (sheet) parsedSheets.push(sheet);
    } catch { /* 单文件读不了跳过 */ }
  }
  if (parsedSheets.length === 0) return { missing: [], duplicate: [], actual: [] }; // 无法解析 → 跳过校验
  const canonicalSheets = parsedSheets.map((s) => canonicalizeHeaders(s.headers));
  const actual = [...new Set(canonicalSheets.flatMap((c) => c.names))].filter((h) => h !== '');
  const missing: string[] = [];
  const duplicate: string[] = [];
  for (const m of mappings) {
    const results = canonicalSheets.map((c) => resolveHeaderIndex(c, m.sourceHeader));
    if (results.some((r) => r.kind === 'ok' && r.index !== undefined)) continue; // 任一文件精确命中(编号名/单例裸名)即合法
    const dup = results.find((r) => r.kind === 'duplicate-bare');
    if (dup && dup.kind === 'duplicate-bare') {
      duplicate.push(dup.error); // 全部没命中 + 有文件是「裸名 + 重复」→ 必须写编号名
      continue;
    }
    missing.push(m.sourceHeader);
  }
  return { missing, duplicate, actual };
}
```

替换 `toolSetMapping` 中 `const { missing, actual } = ...`（399 行）起为：

```ts
  const { missing, duplicate, actual } = findMissingSourceHeaders(ws, bigTableFolder, opts?.pattern ?? '**/*', opts?.sheetName, headerRow, mappings);
  if (duplicate.length > 0) {
    throw new AppError({
      module: 'agent',
      code: 'MAPPING_DUPLICATE_HEADER',
      message: duplicate[0],
      data: { duplicate },
    });
  }
  if (missing.length > 0) {
    throw new AppError({
      module: 'agent',
      code: 'MAPPING_HEADER_MISMATCH',
      message: `映射的源字段在目标文件表头中不存在: ${missing.join(', ')}\n目标表头有: ${actual.slice(0, 40).join('、')}。请核对源字段(注意前导 0 / 空格 / 换行差异)`,
      data: { missing },
    });
  }
```

- [x] **Step 4: 运行确认通过 + 回归**

Run: `npx vitest run tests/core/tools.test.ts`
Expected: PASS（新增 2 用例绿；既有 toolSetMapping 用例不受影响——无重复表头时 `duplicate=[]`，走原逻辑）

- [x] **Step 5: 提交**

```bash
git add src/core/agent/tools.ts tests/core/tools.test.ts
git commit -m "feat(agent): mapping.save 校验规范名,裸名+重复 → MAPPING_DUPLICATE_HEADER 提前拦错"
```

---

### Task 5: `src/core/template/store.ts` — 模板匹配用规范名

**Files:**
- Modify: `src/core/template/store.ts:77`（`applyTemplateToSheet`）
- Test: `tests/core/template.test.ts`

**Interfaces:**
- Consumes: `canonicalizeHeaders`（Task 1）
- Produces: `applyTemplateToSheet` 对模板 `sourceHeader` 用规范名精确匹配；`姓名_2` 命中重复表头第 2 列，裸 `姓名` 在重复表头上进 `skipped`

- [x] **Step 1: 写失败测试（追加到 `tests/core/template.test.ts`）**

```ts
  it('applyTemplateToSheet matches numbered sourceHeaders on duplicate-header sheets', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['姓名', '出生日期', '姓名', '账号', '姓名'],
      rows: [],
    };
    const r = applyTemplateToSheet(sheet, {
      name: 't',
      createdAt: '',
      mappings: [
        { sourceHeader: '姓名_2', outputName: 'name', transform: 'none' as const },
        { sourceHeader: '出生日期', outputName: 'birth', transform: 'normalize-date' as const },
      ],
    });
    expect(r.matched).toBe(2);
    expect(r.skipped).toEqual([]);
  });

  it('applyTemplateToSheet skips a bare sourceHeader that is duplicated on the sheet', () => {
    const sheet: ParsedSheet = {
      sheetName: 's',
      headers: ['姓名', '出生日期', '姓名'],
      rows: [],
    };
    const r = applyTemplateToSheet(sheet, {
      name: 't',
      createdAt: '',
      mappings: [{ sourceHeader: '姓名', outputName: 'name', transform: 'none' as const }],
    });
    expect(r.matched).toBe(0);
    expect(r.skipped).toEqual(['姓名']);
  });
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/template.test.ts`
Expected: FAIL（当前用原始 headers 精确匹配：`姓名_2` 匹配不到 → matched 0；裸 `姓名` 能匹配到 → matched 1）

- [x] **Step 3: 实现**

`store.ts` 顶部新增 `import { canonicalizeHeaders } from '../etl/headers';`
替换 `applyTemplateToSheet` 内 `const headers = new Set(sheet.headers);` 为：

```ts
  const headers = new Set(canonicalizeHeaders(sheet.headers).names);
```

- [x] **Step 4: 运行确认通过 + 回归**

Run: `npx vitest run tests/core/template.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/core/template/store.ts tests/core/template.test.ts
git commit -m "feat(template): 模板匹配用规范名,支持 姓名_2 精确指列"
```

---

### Task 6: `src/renderer/views/PreviewView.tsx` — 预览列名与 YAML 一致

**Files:**
- Modify: `src/renderer/views/PreviewView.tsx:21-29`（删除本地 `dedupeHeaders`）、`:113`（改用共享函数）
- Test: 无 React 组件单测基建；由 Task 1 的 `canonicalizeHeaders` 单测 + `npm run typecheck` 覆盖（视图改动为机械替换）

**Interfaces:**
- Consumes: `canonicalizeHeaders`（Task 1）
- Produces: 预览列名显示 `姓名_1, 姓名_2, 姓名_3`，与 YAML 可写名完全对齐

- [x] **Step 1: 改代码**

删除 `dedupeHeaders`（21-29 行整段）。`PreviewView.tsx` 顶部 import 区加：

```ts
import { canonicalizeHeaders } from '../../core/etl/headers';
```

`:113` 行 `const cols = dedupeHeaders(d.headers);` 改为：

```ts
const cols = canonicalizeHeaders(d.headers).names;
```

- [x] **Step 2: typecheck + 全量测试**

Run: `npm run typecheck`
Expected: 无错误

- [x] **Step 3: 提交**

```bash
git add src/renderer/views/PreviewView.tsx
git commit -m "feat(renderer): 预览重复表头改用 canonicalizeHeaders,列名 姓名_1..N"
```

---

### Task 7: `src/core/agent/flow.ts` + `src/renderer/views/MappingView.tsx` — 自动映射用规范名

**Files:**
- Modify: `src/core/agent/flow.ts:45-49`（`guessFieldsAndMappings`）、`src/renderer/views/MappingView.tsx:176-183`（自动回填）
- Test: `tests/core/agent-flow.test.ts`

**Interfaces:**
- Consumes: `canonicalizeHeaders`（Task 1）
- Produces: 自动生成的 `sourceHeader`/字段名用规范名，重复列显示为 `姓名_1/姓名_2/姓名_3`（依赖 Task 4 的校验放行）

- [x] **Step 1: 写失败测试（追加到 `tests/core/agent-flow.test.ts`）**

```ts
  it('initial setup on a duplicate-header file generates numbered sourceHeaders (姓名_1/姓名_2)', async () => {
    rmSync(join(sourceDir, 'a.xlsx')); // 只留重复表头文件,保证 getFileHeaders 扫到它(而非 a.xlsx)
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'dup.xlsx'));

    const result = await runInitialSetupFlow({
      workspacePath: join(root, 'ws'),
      bigTableFolder: '序时账',
      sourceDir,
      tableName: 'seq',
    });
    expect(result.success).toBe(true);
    expect(result.bigTableRows).toBe(2);

    // 读取保存的规则,断言 sourceHeader 用了编号名(姓名_1/姓名_2/姓名_3)
    const ws = openWorkspace(join(root, 'ws'));
    const rules = loadRules(ws, '序时账');
    const headers = rules.flatMap((r) => r.fields ?? []).map((f) => f.sourceHeader);
    expect(headers).toContain('姓名_1');
    expect(headers).toContain('姓名_2');
    expect(headers).toContain('姓名_3');
  });
```

（import 区需补：`import { loadRules } from '../../src/core/rule/store';`。`rmSync`、`join`、`openWorkspace` 均已 import。）

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/agent-flow.test.ts`
Expected: FAIL — 当前自动映射用原始 headers，生成的 sourceHeader 是裸 `姓名`（×3），断言 `姓名_1` 失败

- [x] **Step 3: 实现**

`flow.ts` 顶部加 `import { canonicalizeHeaders } from '../etl/headers';`，替换 `guessFieldsAndMappings` 内 `headers.forEach(...)` 为：

```ts
  const { names } = canonicalizeHeaders(headers);
  names.forEach((h, i) => {
    const isAmount = /金额|借方|贷方|余额|amount|amt/i.test(h);
    fields.push({ name: h, type: isAmount ? 'INTEGER' : 'TEXT', order: i + 1 });
    mappings.push({ sourceHeader: h, outputName: h, transform: isAmount ? 'to-cents' : 'none' });
  });
```

`MappingView.tsx` 顶部加 `import { canonicalizeHeaders } from '../../core/etl/headers';`，把 `:177` `d.headers.map((h) => ({` 改为：

```ts
      canonicalizeHeaders(d.headers).names.map((h) => ({
```

- [x] **Step 4: 运行确认通过 + 回归**

Run: `npx vitest run tests/core/agent-flow.test.ts && npm run typecheck`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/core/agent/flow.ts src/renderer/views/MappingView.tsx tests/core/agent-flow.test.ts
git commit -m "feat(agent/renderer): 自动映射用规范名,重复表头生成 姓名_1..N"
```

---

### Task 8: 文档同步 — 告警语义变更

**Files:**
- Modify: `src/mcp/manual.ts:32`（"重复表头只取其一"的 agent 指引，行为已改为报错）
- Modify: `agents.md`（如含"重复表头只取其一"表述）
- Test: `npm run typecheck`（manual.ts 是源码，改文案需编译通过）

- [x] **Step 1: 查现状**

Run: `grep -rn "重复表头只取其一\|只取其一" src/mcp/manual.ts agents.md`
Expected: 命中 manual.ts:32 及可能 agents.md

- [x] **Step 2: 改文案**

`manual.ts:32` 中"重复表头只取其一"改为：

> 重复表头(如三个「姓名」列)按列编号 姓名_1..姓名_N;映射须写编号名(如 姓名_2)精确指定;写裸名「姓名」时 clean 整个 run 失败(ok:false)并报错提示编号。跑完管线必读返回的 warnings 与错误并汇报。

`agents.md` 若有"重复表头只取其一"类表述，同步改为上述语义。

- [x] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 无错误

- [x] **Step 4: 提交**

```bash
git add src/mcp/manual.ts agents.md
git commit -m "docs(agent): 重复表头映射改为编号名语义,更新告警指引"
```

---

### Task 9: 全量验收

**Files:**
- 无（验收）

- [x] **Step 1: 全量测试 + 类型检查**

Run: `npm test` && `npm run typecheck`
Expected: 全部通过（重点回归：无重复表头的既有 clean / tools / template / etl / agent-flow 用例）

- [x] **Step 2: 手工冒烟（可选，若有真实重复表头文件）**

用带 3 个「姓名」列的真实文件跑一条 clean：确认裸名规则报错、改成 `姓名_2` 后取到对应列数据、预览列名显示 `姓名_1..N`。

- [x] **Step 3: 提交（若本任务有任何改动）**

```bash
git status
git add -A
git commit -m "chore: 全量回归通过"
```
