# 安装后：Agent 经 MCP 接入 Onworking

> 适用：打包安装后的 Onworking 应用，如何让你的 AI Agent（MCP 客户端）连上它干活。
> 前置：`npm run dist` 已打出安装包（`release/` 下的 Setup / portable exe），并已安装。

## 1. 打包里 CLI 在哪

`npm run build` 会把 CLI（含 MCP 入口）编进 `dist/main/cli/index.js`；electron-builder 把它打进了 app。

安装后，CLI 入口逻辑路径是（asar 内，`ELECTRON_RUN_AS_NODE` 可读）：

```
<安装目录>/resources/app.asar/dist/main/cli/index.js
```

## 2. 关键：CLI/MCP 一律跑系统 node（单一 ABI，不再来回切）

MCP server 是 stdio 子进程，用 **系统 node** 跑 CLI（`rebuild:node` 编的就是系统 node 版 better-sqlite3，ABI 137；**不要**用 `ELECTRON_RUN_AS_NODE`，那会让子进程跑 Electron 内置 node / ABI 115，与模块 137 冲突）：

```
command: node
args:    [<CLI 入口>, "mcp"]
```

- `mcp` 子命令 = MCP server（JSON-RPC 2.0 / stdio）。
- 每个 Agent 会话由客户端拉起一个 MCP 进程（client-bound）。
- CLI 入口：开发用 `D:/Jeffrey/onworking-v2/dist/main/cli/index.js`（先 `npm run build:main`）；打包后在 `<安装目录>/resources/app.asar/dist/main/cli/index.js`（打包机器需装 node）。

## 3. 具体客户端配置

### claude mcp add（Claude Code）

```bash
claude mcp add onworking -- node "D:/Jeffrey/onworking-v2/dist/main/cli/index.js" mcp
```

验证：`claude mcp list`，然后直接调工具（`bigtable.list` / `mapping.save` / `query.run` …）。

### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "onworking": {
      "command": "node",
      "args": ["D:/Jeffrey/onworking-v2/dist/main/cli/index.js", "mcp"]
    }
  }
}
```

### 通用 stdio MCP（Cursor / IDE / 豆包等支持自定义 stdio 的客户端）

同一份 `{ command, args }` 结构，`command` 一律 `node`。

## 4. 工作区不用写死

`onw mcp` 支持**无路径启动**；Agent 连接后第一个动作调用：

```
tools/call { "name": "workspace.open", "arguments": { "path": "D:/某工作区" } }
```

之后随时再调 `workspace.open` 切换工作区。未打开就调数据工具会返回 `NO_WORKSPACE`。

## 5. 操作手册怎么给 Agent

MCP 侧已内置（`src/mcp/manual.ts`），Agent 可用三种方式读到：

```
tools/call      { "name": "manual.read", "arguments": {} }   → 返回操作须知(markdown)【推荐,Agent 在工具列表里能看到】
resources/read  { "uri": "onworking://manual" }               → 同上,资源形式
prompts/get     { "name": "onworking-manual" }                → 同上,提示词形式
```

`manual.read` 是 tools/list 里的一个工具，AI 直接调用就能读到手册（含铁律/数据链/完成判据/工作流）。

**但注意：MCP 无法「强制」模型读资源/提示词**——Agent 不去读就不会生效。硬保证是把须知注入**客户端系统提示**：

| 客户端 | 做法 |
|---|---|
| Claude Desktop | 设置 → 自定义指令(Custom Instructions) 里贴 `resources/read` 返回的须知 |
| Claude Code | 项目 `CLAUDE.md` / `AGENTS.md` 里放手册,或启动时作为 system prompt |
| 自研客户端 | 把 `MANUAL_TEXT` 注入 system prompt(和工具描述一起) |

**建议组合**：在客户端指令里写「每次会话第一步 `resources/read onworking://manual` 读操作须知并严格遵守」——这样既有 MCP 侧可取，又通过客户端指令让 Agent 每次都去读。

> 须知是 `docs/agent-manual.md` 的浓缩版；完整手册见仓库 `docs/agent-manual.md`。

## 6. 注意事项

- **路径用绝对路径**：`args` 里的 `app.asar` 路径是相对的，客户端工作目录不定，务必写成绝对路径。
- **ABI 双装载（已免疫）**：`src/core/db/sqlite.ts` 按进程 ABI 自动选——系统 node（137）用 `better-sqlite3`，Electron 内置 node（本机 31.7.7 = 125）用 `better-sqlite3-electron` 副本。客户端怎么 spawn 都不怕。装完依赖跑一次 `npm run build:dual-abi`（先重建原件到 137、再 node-gyp 建副本匹配本机 Electron；原件被 app/MCP 占用时先关掉再跑）。
- **Agent 只经命令操作**：接入后 Agent 能看到的工具 = 命令清单，配合 [agent-manual.md](agent-manual.md) 的约束，AI 只能经 MCP 工具读写工作区。
- **不要同时双写**：better-sqlite3 是单进程设计，AI 与界面别在同一瞬间各跑一个写库管线。

## 6. 开发时（未打包）想连 MCP

直接用源码入口，不需要打包：

```bash
claude mcp add onworking -- node "D:/Jeffrey/onworking-v2/dist/main/cli/index.js" mcp
# 或开发热入口:npm run onw -- mcp(无路径,workspace.open 自选)
```
