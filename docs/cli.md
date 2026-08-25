# Onworking CLI 命令行清单

> 版本：0.2.0 · 契约来源：`src/ipc/contracts.ts`（`CommandPayloads`/`CommandResults` 两张映射表是唯一事实来源）
> CLI 实现：`src/cli/index.ts`（NDJSON 命令循环）· MCP 实现：`src/mcp/server.ts`

CLI 是同一个 `dispatch` 的 stdio 前端：Electron 渲染层、CLI、MCP 走同一套 `ApiCommand` 契约（「一切操作都是 API」）。CLI 适合调试、脚本化、AI 工具调用。

---

## 1. 启动与协议

```bash
# 打开工作区,之后从 stdin 逐行读命令(交互式)
npm run onw -- open /path/to/workspace

# 非交互:管道喂命令,一行一命令,stdout 一行一响应
echo '{"reqId":1,"cmd":"state.summary"}' | npm run onw -- open /path/to/workspace

# 一次多命令
printf '%s\n%s\n' \
  '{"reqId":1,"cmd":"bigtable.list"}' \
  '{"reqId":2,"cmd":"pipeline.list"}' \
  | npm run onw -- open /path/to/workspace
```

**协议（NDJSON）：**
- stdin 每行一条 `IpcRequest` JSON = `ApiCommand & { reqId: number }`
- stdout 每行一条 `IpcResponse` JSON：`{ reqId, result }`（`result` 是 `ApiResult<unknown>`）
- 进度/日志事件走 stderr（`{ event: 'progress', payload }`）；解析失败的错误也走 stderr
- 退出码 `0` = 正常；`1` = 启动/未捕获错误

**引导：**
- `onw open <path>` 立即建 ctx（等同 Electron main 持有 ctx）
- 也可以把 `{"cmd":"workspace.open","path":"..."}` 作为第一条 stdin 行来引导

**reqId 对账：** 响应回填同 reqId，异步/并发下可对齐请求与响应。

---

## 2. 命令清单

### 工作区

| 命令 | 载荷 | 返回 |
|---|---|---|
| `workspace.open` | `{ path: string }` | `Workspace`（`{ root, onworkingDir }`） |

> `workspace.pick` 已并入 `workspace.open`：目录选择是 Electron UI 专属的 `pickWorkspace` 桥（`window.onw.pickWorkspace()`），返回 `string | null` 后再走 `workspace.open`。CLI 没有 pick。

```bash
echo '{"reqId":1,"cmd":"workspace.open","path":"D:/ws"}' | npm run onw -- open D:/ws
```

### 大表

| 命令 | 载荷 | 返回 |
|---|---|---|
| `bigtable.list` | `{}` | `string[]`（大表文件夹名） |
| `bigtable.get` | `{ folder }` | `BigTableConfig`（`{ tableName, fields, autoIncrement }`） |
| `bigtable.save` | `{ folder, config: BigTableConfig }` | `{ saved: folder }` |
| `bigtable.sourceFiles` | `{ folder }` | `string[]`（源文件绝对路径） |
| `bigtable.previewRows` | `{ folder, limit?, offset? }` | `{ columns, rows, rowCount, total }`（只读查大表 DB） |
| `bigtable.addFiles` | `{ folder, files: string[], overwrite? }` | `{ added, overwritten, skipped }`（拷贝源文件到大表 `source/` 目录） |

```bash
# 预览大表清洗结果(前 20 行)
echo '{"reqId":1,"cmd":"bigtable.previewRows","folder":"seq","limit":20}' \
  | npm run onw -- open D:/ws

# 给大表增加源文件(默认不覆盖同名文件)
echo '{"reqId":1,"cmd":"bigtable.addFiles","folder":"seq","files":["D:/data/a.xlsx","D:/data/b.xlsx"]}' \
  | npm run onw -- open D:/ws
# → {"added":["a.xlsx","b.xlsx"],"overwritten":[],"skipped":[]}

# 同名文件强制覆盖
echo '{"reqId":1,"cmd":"bigtable.addFiles","folder":"seq","files":["D:/data/a.xlsx"],"overwrite":true}' \
  | npm run onw -- open D:/ws
# → {"added":[],"overwritten":["a.xlsx"],"skipped":[]}
```

> `bigtable.addFiles` 只负责把文件拷贝进大表的 `source/` 目录（文件管理）。加完后需重跑 `pipeline.run` 才导入数据；`bigtable.sourceFiles` 会列出已加文件（仅扫描 `.xlsx/.xls/.csv`）。同名文件：`overwrite` 缺省 `false` → 跳过并计入 `skipped`，`true` → 覆盖并计入 `overwritten`。

### 字段映射（规则 YAML）

| 命令 | 载荷 | 返回 |
|---|---|---|
| `mapping.save` | `{ folder, headerRow?, mappings: FieldMapping[], ruleName? }` | `{ ruleFile: string }` |

- `mappings`：`{ sourceHeader, outputName, transform }[]`，`transform ∈ 'none' | 'to-cents' | 'normalize-date' | 'trim'`
- `ruleName` 缺省 `<folder>_rule`；传不同 `ruleName` = 追加第 N 份映射（不覆盖）。clean 运行时会合并所有规则（按 source key / outputName 去重）。
- 只写 `rules/*.yaml`，不生成管线。

```bash
echo '{"reqId":1,"cmd":"mapping.save","folder":"seq","headerRow":1,"mappings":[{"sourceHeader":"日期","outputName":"date","transform":"normalize-date"}]}' \
  | npm run onw -- open D:/ws
```

### 管线（pipeline）

| 命令 | 载荷 | 返回 |
|---|---|---|
| `pipeline.list` | `{}` | `string[]`（pipeline id） |
| `pipeline.save` | `{ config: PipelineConfig }` | `{ pipelineId: string }`（id 由调用方显式传入） |
| `pipeline.delete` | `{ id }` | `{ deleted: id }` |
| `pipeline.run` | `{ id }` | `RunSummary`：`{ pipelineId, kind, ok, rows?, error? }` |
| `pipeline.mergeBigTable` | `{ folder }` | `RunSummary[]`（跑该大表所有 clean 管线） |
| `pipeline.mergeAll` | `{}` | `RunSummary[]`（跑所有 clean 管线） |
| `pipeline.buildMasterBigTable` | `{ folder }` | `RunSummary[]`（跑含该大表的 sql-clean 管线） |
| `pipeline.buildMasterAll` | `{}` | `RunSummary[]`（跑所有 sql-clean 管线） |
| `pipeline.recomputeAll` | `{}` | `RunSummary[]`（按血缘拓扑跑全部管线） |
| `pipeline.recomputeByDependency` | `{ trigger }` | `RunSummary[]`（按血缘自动重算下游） |

`PipelineConfig` 三种 kind：
- `clean`：`{ kind:'clean', id, label, bigTableFolder, sourceDir, createdAt }`（映射走规则 YAML，不带 mappings/headerRow）
- `sql-clean`：`{ kind:'sql-clean', id, label, bigTables[], sql, resultTable, createdAt }`（大表 DB → 总表 DB）
- `query`：`{ kind:'query', id, label, sql, dependencies[], resultTable, createdAt }`（SQL → 物化结果表）

```bash
echo '{"reqId":1,"cmd":"pipeline.run","id":"c1"}' | npm run onw -- open D:/ws
```

### 文件设置（setup）

| 命令 | 载荷 | 返回 |
|---|---|---|
| `setup.sheets` | `{ filePath }` | `string[]`（sheet 名） |
| `setup.detectSource` | `{ filePath, sheetName? }` | `SourceConfig`：`{ sheetName, headerRow, headers[] }` |
| `setup.preview` | `{ filePath, sheetName?, headerRow?, offset?, limit? }` | `{ sheetName, headerRow, headers[], rows[][], total }` |

```bash
echo '{"reqId":1,"cmd":"setup.detectSource","filePath":"D:/data/a.xlsx"}' \
  | npm run onw -- open D:/ws
```

### 查询（总表 DB）

| 命令 | 载荷 | 返回 |
|---|---|---|
| `query.run` | `{ sql, limit? }` | `{ columns[], rows[], rowCount }` |

- 仅允许 `SELECT`/`WITH`（否则错误码 `QUERY_NOT_SELECT`）
- 跑在**总表 DB** 上（临时查询，不建管线）；`limit` 载荷字段当前保留但未生效（引擎默认 500 行）

```bash
echo '{"reqId":1,"cmd":"query.run","sql":"SELECT date, debit FROM seq ORDER BY date"}' \
  | npm run onw -- open D:/ws
```

### 模板

| 命令 | 载荷 | 返回 |
|---|---|---|
| `template.list` | `{}` | `string[]`（模板名） |
| `template.save` | `{ template: MappingTemplate }` | `{ saved: name }` |
| `template.apply` | `{ name, sheet: ParsedSheet }` | `{ mappings[], matched, skipped[] }` |

### 状态 / 元数据 / 版本

| 命令 | 载荷 | 返回 |
|---|---|---|
| `state.summary` | `{}` | `string`（项目状态机摘要，Agent 据此决定下一步） |
| `schema.tables` | `{}` | `{ name }[]`（总表 DB 表清单） |
| `vcs.status` | `{}` | `{ staged[], unstaged[], untracked[] }` |

```bash
echo '{"reqId":1,"cmd":"state.summary"}' | npm run onw -- open D:/ws
# → {"reqId":1,"result":{"ok":true,"data":"workspace=ws\n..."}}
```

---

## 3. 错误响应

失败时 `result = { ok:false, error: { code, message } }`。常见错误码：

| 码 | 含义 |
|---|---|
| `UNKNOWN_CMD` | 未知命令名 |
| `NO_WORKSPACE` | 尚未 `open` 就发命令 |
| `OPEN_AT_TRANSPORT` | 把 `workspace.open` 直接交给 `dispatch`（应由传输层引导） |
| `QUERY_NOT_SELECT` | `query.run` 非 SELECT/WITH |
| `CLEAN_NO_RULE` | clean 管线没有规则 YAML |
| `PIPELINE_NOT_FOUND` / `PIPELINE_BAD_ID` | 管线不存在 / id 非法 |
| `TEMPLATE_NOT_FOUND` / `TEMPLATE_BAD_NAME` | 模板不存在 / 名字非法 |

---

## 4. MCP 子命令（JSON-RPC 2.0 / stdio）

```bash
npm run onw -- mcp /path/to/workspace
```

- stdin/stdout 走 JSON-RPC 2.0（newline-delimited），每个 `ApiCommand` 映射成一个 MCP tool
- 支持：`initialize`、`tools/list`、`tools/call`；`notifications/*` 不回包
- 用 MCP 客户端连接后即可把命令当作工具调用（工具名 = 命令名）

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"state.summary","arguments":{}}}' \
  | npm run onw -- mcp D:/ws
```

---

## 5. 快速参考：一个完整调试会话

```bash
# 1) 打开工作区并查状态
echo '{"reqId":1,"cmd":"state.summary"}' | npm run onw -- open D:/ws

# 2) 建大表
echo '{"reqId":1,"cmd":"bigtable.save","folder":"seq","config":{"tableName":"seq","fields":[{"name":"date","type":"TEXT","order":1},{"name":"debit","type":"INTEGER","order":2}],"autoIncrement":true}}' \
  | npm run onw -- open D:/ws

# 3) 写映射规则 + 建 clean 管线
echo '{"reqId":1,"cmd":"mapping.save","folder":"seq","headerRow":1,"mappings":[{"sourceHeader":"日期","outputName":"date","transform":"normalize-date"},{"sourceHeader":"借方金额","outputName":"debit","transform":"to-cents"}]}' \
  | npm run onw -- open D:/ws
echo '{"reqId":1,"cmd":"pipeline.save","config":{"kind":"clean","id":"c1","label":"seq 清洗","bigTableFolder":"seq","sourceDir":"D:/data","createdAt":"2026-08-25"}}' \
  | npm run onw -- open D:/ws

# 4) 清洗入大表 → 预览结果 → 临时查询
echo '{"reqId":1,"cmd":"pipeline.run","id":"c1"}' | npm run onw -- open D:/ws
echo '{"reqId":1,"cmd":"bigtable.previewRows","folder":"seq"}' | npm run onw -- open D:/ws
echo '{"reqId":1,"cmd":"query.run","sql":"SELECT * FROM seq LIMIT 5"}' | npm run onw -- open D:/ws
```
