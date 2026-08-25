# 安装后：Agent 经 MCP 接入 Onworking

> 适用：打包安装后的 Onworking 应用，如何让你的 AI Agent（MCP 客户端）连上它干活。
> 前置：`npm run dist` 已打出安装包（`release/` 下的 Setup / portable exe），并已安装。

## 1. 打包里 CLI 在哪

`npm run build` 会把 CLI（含 MCP 入口）编进 `dist/main/cli/index.js`；electron-builder 把它打进了 app。

安装后，CLI 入口逻辑路径是（asar 内，`ELECTRON_RUN_AS_NODE` 可读）：

```
<安装目录>/resources/app.asar/dist/main/cli/index.js
```

## 2. 关键：用应用自带 Node 跑 CLI（不需要用户装 node）

MCP server 是 stdio 子进程，用 `ELECTRON_RUN_AS_NODE=1` 让 **Onworking.exe 以 Node 模式运行** CLI：

```
command: <安装目录>/Onworking.exe
args:    [<安装目录>/resources/app.asar/dist/main/cli/index.js, "mcp"]
env:     ELECTRON_RUN_AS_NODE=1
```

- `mcp` 子命令 = MCP server（JSON-RPC 2.0 / stdio）。
- 每个 Agent 会话由客户端拉起一个 MCP 进程（client-bound）。

## 3. 具体客户端配置

### claude mcp add（Claude Code）

```bash
claude mcp add onworking \
  --env ELECTRON_RUN_AS_NODE=1 \
  -- "C:/Program Files/Onworking/Onworking.exe" \
     "C:/Program Files/Onworking/resources/app.asar/dist/main/cli/index.js" mcp
```

验证：`claude mcp list`，然后直接调工具（`bigtable.list` / `mapping.save` / `query.run` …）。

### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "onworking": {
      "command": "C:/Program Files/Onworking/Onworking.exe",
      "args": ["C:/Program Files/Onworking/resources/app.asar/dist/main/cli/index.js", "mcp"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### 通用 stdio MCP（Cursor / IDE / 自研）

同一份 `{ command, args, env }` 结构（上面的 JSON 就是通用形状）。

## 4. 工作区不用写死

`onw mcp` 支持**无路径启动**；Agent 连接后第一个动作调用：

```
tools/call { "name": "workspace.open", "arguments": { "path": "D:/某工作区" } }
```

之后随时再调 `workspace.open` 切换工作区。未打开就调数据工具会返回 `NO_WORKSPACE`。

## 5. 操作手册怎么给 Agent

MCP 侧已内置（`src/mcp/manual.ts`），Agent 可读：

```
resources/read  { "uri": "onworking://manual" }   → 返回操作须知(markdown)
prompts/get     { "name": "onworking-manual" }    → 同上,以提示词形式
```

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
- **ABI**：打包时 electron-builder 会把 better-sqlite3 重建成 Electron 版（`npm run dist` 后本地 node_modules 是 Electron ABI，`npm run dev`/测试前需 `npm run rebuild:node`）。打包后的 CLI 用应用自带 Node，ABI 天然匹配，无需处理。
- **Agent 只经命令操作**：接入后 Agent 能看到的工具 = 命令清单，配合 [agent-manual.md](agent-manual.md) 的约束，AI 只能经 MCP 工具读写工作区。
- **不要同时双写**：better-sqlite3 是单进程设计，AI 与界面别在同一瞬间各跑一个写库管线。

## 6. 开发时（未打包）想连 MCP

直接用源码入口，不需要打包：

```bash
claude mcp add onworking -- node "D:/Jeffrey/onworking-v2/dist/main/cli/index.js" mcp
# 或开发热入口:npm run onw -- mcp(无路径,workspace.open 自选)
```
