# opencode-delegate MCP

把活派给本机 opencode 后台服务和它的**免费模型**（默认 `opencode/deepseek-v4.1-flash-free`，当前还有 MiMo / GLM / Big Pickle 等免费项），并管理这些委派。四个工具，一个 server。

## 它解决什么

opencode 里能白嫖一批免费模型（`/api/model` 里 `cost.input == 0 && cost.output == 0`），但只能在 opencode 内部用。这个 MCP 就是出口：

- 任何支持 MCP 的 agent 都能把一整段任务**派出去**，拿到最终答复；
- 委派跑的是真实 opencode 会话（`build` agent，能读文件、改代码、跑命令），会话也会出现在 opencode 网页侧栏里，可以人工接手；
- **默认会话级预授权**（`permissions: allow`）：无人值守的委派不会卡在工具审批上；
- 任务、状态、增量输出、续聊、取消都有管理入口，`session_id` 跨 MCP 重启有效。

## 注册

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["E:\\Desktop\\mytests\\opencode-web\\mcp\\index.mjs"],
      "env": {
        "OPENCODE_MCP_DIRECTORY": "E:\\Desktop\\mytests\\opencode-web"
      }
    }
  }
}
```

首次使用先在该目录装依赖：`npm install`（只有 `@modelcontextprotocol/sdk` 一个直接依赖）。

无需配置 opencode 地址和密码：server 直接读 `~/.local/state/opencode/service*.json` 的服务注册文件，和 TUI / 桌面端 / 网页端共用同一个后台服务。服务被网页网关自动休眠后，下一次工具调用会自动 `opencode service start` 拉起，不需要手动干预。

## 工具

| 工具 | 作用 |
| --- | --- |
| `opencode_delegate` | 开新会话发任务。`mode="sync"` 等答复（默认 120s 预算），`mode="async"` 立刻返回 task id |
| `opencode_task` | `action="list" / "status" / "wait" / "output" / "message" / "cancel"` |
| `opencode_models` | 列出模型（默认只看免费、支持工具、已启用的），标出默认项 |
| `opencode_help` | 使用说明，无副作用 |

### 委派

```json
{
  "task": "把 src/ui-server.mjs 里重复的 JSON 响应头抽成 helper，跑一遍现有测试",
  "directory": "E:\\Desktop\\mytests\\opencode-web",
  "mode": "sync",
  "timeout_ms": 180000
}
```

- `directory` 必须是已存在的绝对路径：它是 agent 的工作目录，也是 opencode 会话归属的项目。**没有隐式 cwd 回退**——不传就得配 `OPENCODE_MCP_DIRECTORY`，否则直接报错，会话不会落到意料之外的项目里。
- `model` 接受 `provider/modelID` 或裸 model id；默认 `opencode/deepseek-v4.1-flash-free`，模型下架时自动回落到目录里第一个免费可用项。
- `caller` 记录是哪个 agent 派的任务（默认取 `OPENCODE_MCP_CALLER`，再退到 `mcp`）。它和 `origin`、`taskId` 一起写进 `session.metadata`：网页侧栏据此把会话归到「后台任务」，监视页和托盘也按它显示调用方。
- `mode="sync"` 的 `timeout_ms` 默认取 `OPENCODE_MCP_DEFAULT_WAIT_MS`（120000），上限 `OPENCODE_MCP_MAX_WAIT_MS`（540000）。预算用完**不代表失败**：任务还在跑，返回里带 `task_id`；`on_timeout="interrupt"` 才会中断。
- `permissions="allow"`（默认）预授权所有工具；`"default"` 保留 opencode 原生的审批流程（无人值守时可能卡住）。

### 在网页和托盘里看

委派产生的会话带着 `metadata: { origin: "opencode-delegate", caller, taskId }`，所以：

- **侧栏**：后台会话不散落在各工作区里，统一进顶部「后台任务」分组，每行标注 `caller · model`，运行中复用行左侧的像素格动画；
- **监视页**：图标栏心跳按钮（侧栏分组的监视按钮也行）打开，按会话显示运行状态、调用方、模型、目录、最近一轮工具流程、token/成本，2.5 秒刷新，点卡片跳进会话；
- **托盘**：右键菜单实时显示「后台任务：N 个在跑」，点击直接打开监视页（`?ocw=background`），图标提示也会带上数量。

不需要任何额外登记：判定完全来自会话 metadata，TUI 自己开的会话不会被误认成后台任务。

### 管理

```json
{ "action": "wait", "task_id": "task_9daed7a8", "wait_ms": 60000 }
```

- `wait` 阻塞到会话 agent 循环空闲；超时只说明等待预算用完，会话继续跑，再调一次即可。
- `output` 按 `cursor`（消息 id）增量读取，每次返回 `nextCursor`；`read_mode="full"` 忽略游标读整个窗口，`tail_chars` 只取末尾。
- `message` 往同一个会话追加提示并（默认）等答复 —— 迭代式修改就走这条，不必每次重开任务。
- `cancel` 只中断当前回合，会话和文件都保留。
- 状态来自 opencode 的 idle 标记：`done` / `failed` / `cancelled`；循环还在跑时如实返回 `running`。
- `task_id` 是本进程的便利句柄（持久化在 `mcp/.state/tasks.json`，重启后 `list` 仍在）；**`session_id` 才是持久身份**，任何动作都接受。

### 输出约定

- 只返回 assistant 正文，工具调用在头部摘要里（`tools shell, edit`），不把工具输出灌进上下文。
- `max_chars` 默认 8000、上限 32000；`truncated` 明确标出截断。
- 会话是只追加的，游标读取不会丢内容；游标比 100 条窗口更旧时退回整窗口。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_MCP_DIRECTORY` | 默认工作目录；不设则每次委派都必须显式传 `directory` |
| `OPENCODE_MCP_CALLER` | 记录调用方（写进会话 metadata），默认 `mcp`；每个客户端的 MCP 配置里设成自己的名字 |
| `OPENCODE_MCP_MODEL` | 默认模型，默认 `opencode/deepseek-v4.1-flash-free` |
| `OPENCODE_MCP_DEFAULT_WAIT_MS` | `sync` / `wait` / `message` 的默认等待，默认 120000 |
| `OPENCODE_MCP_MAX_WAIT_MS` | 单次等待上限，默认 540000 |
| `OPENCODE_MCP_STATE_PATH` | 任务注册表路径，默认 `mcp/.state/tasks.json` |
| `OPENCODE_BIN` | 透传给服务发现层，指定 opencode 可执行文件 |

## 测试

```bash
cd mcp && npm install && bun test ./tests
```

- `tests/tools.test.mjs`：用假 opencode 服务覆盖委派、异步等待、增量输出、续聊、取消、状态推导、模型列表/回落、参数校验、注册表持久化。
- `tests/server.test.mjs`：用官方 SDK 客户端通过 stdio 启动真实 server，验证 `tools/list` 与 `tools/call` 全链路（`XDG_STATE_HOME` 指向夹具，不碰真实服务）。

真实链路（免费模型、文件落盘）另外在本机验证过：3.7 秒完成一次「创建文件并回复」的委派，219 输入 token、0 成本。

## 边界

- 委派消耗的是 opencode 账号的免费额度；免费模型会变动，用 `opencode_models` 查当前可用项。
- MCP 进程退出不影响已在跑的会话：会话在后台服务里，重连后按 `session_id` 继续管理。
- 会话级预授权意味着被委派的 agent 可以执行它想执行的任何工具；只把任务派给可信的目录。
