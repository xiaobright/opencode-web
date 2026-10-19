# opencode-delegate MCP

把活派给本机 opencode 后台服务，并像跟子代理沟通一样管理它：**两个工具**，一个派活、一个对话。

```json
{ "mcpServers": { "opencode": {
  "command": "node",
  "args": ["E:\\Desktop\\mytests\\opencode-web\\mcp\\index.mjs"],
  "env": { "OPENCODE_MCP_DIRECTORY": "E:\\Desktop\\mytests\\opencode-web", "OPENCODE_MCP_CALLER": "codebuddy" }
} } }
```

首次使用先在该目录 `npm install`（唯一依赖是 `@modelcontextprotocol/sdk`）。不需要配 opencode 地址和密码：server 直接读 `~/.local/state/opencode/service*.json`，和 TUI / 桌面端 / 网页端共用同一个后台服务；服务被网页网关自动休眠后，下次调用会自动拉起。

## 工具面

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `opencode_delegate` | `task*`、`directory` | 开一个全新会话把任务交出去。短任务直接返回答案；还在跑就返回 `session_id` |
| `opencode_session` | `action*`、`session_id*`、`text` | `status` / `wait` / `message` / `cancel` |

**模型、权限、调用方标识、标题都不在参数里**：这些是服务端（运营者）的决定，调用方不需要知道用哪个免费模型、额度怎么算，也不需要选 agent。

- `directory` 必须是已存在的绝对路径；不传就用 `OPENCODE_MCP_DIRECTORY`，两者都没有会直接报错——**没有隐式 cwd**，会话不会落到意料之外的项目。
- 会话级预授权（工具全放行），无人值守不会卡在审批上。
- `opencode_delegate` 先等 20 秒：够快的一次调用就拿到答案；更久的会返回 `session_id`，后续用 `wait` 续等。
- `wait` 每次最多等 60 秒；超时只表示等待预算用完，会话继续跑，再调一次即可。
- `message` 往同一个会话追加指令并等回复（默认 60 秒），只返回这一问的增量。
- `cancel` 只中断当前回合，会话和文件都保留。

## 模型怎么选

**运营者在网页里排，服务端照办。** 侧栏「模型顺序」面板（图标栏叠层按钮）列出当前可用的免费模型，上下移动调整顺序，排第一的就是下一次委派用的模型；排序存在 `.state/model-ranking.json`，MCP 每次都读同一个文件，改完立即生效。

- 默认（还没排过时）DeepSeek V4.1 Flash 排第一。
- 某个模型下架后自动跳过，不会把委派卡死。
- `OPENCODE_MCP_MODEL=provider/modelID` 是给运维的强制钉死项，优先级高于排序。

## 在网页和托盘里看

委派产生的会话带 `metadata: { origin: "opencode-delegate", caller }`：

- **侧栏**：后台会话不散落在工作区里，统一进顶部「后台任务」组，行内标注 `caller · model`，运行中显示像素格动画；
- **监视页**：图标栏心跳按钮打开，按会话显示运行状态、调用方、模型、目录、最近一轮工具流程、token/成本，2.5 秒刷新，点卡片进会话；
- **托盘**：右键菜单显示「后台任务：N 个在跑」，点击直接进监视页。

判定完全来自会话 metadata，TUI 自己开的会话不会被误认。

## 环境变量（运维侧）

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_MCP_DIRECTORY` | 默认工作目录；不设则每次委派必须传 `directory` |
| `OPENCODE_MCP_CALLER` | 记录调用方（写进会话 metadata），默认 `mcp` |
| `OPENCODE_MCP_MODEL` | 强制钉死模型，优先于网页排序；默认留空 |
| `OPENCODE_WEB_STATE_DIR` | 状态目录（排序文件），默认仓库下 `.state/`；网页网关与 MCP 共用 |
| `OPENCODE_MCP_DELEGATE_WAIT_MS` | 派活后先等多久，默认 20000 |
| `OPENCODE_MCP_WAIT_MS` | 单次 `wait` / `message` 的等待预算，默认 60000 |
| `OPENCODE_MCP_MAX_CHARS` | 单次返回正文上限，默认 8000 |
| `OPENCODE_BIN` | 透传给服务发现层，指定 opencode 可执行文件 |

## 测试

```bash
cd mcp && npm install && bun test ./tests
```

- `tests/tools.test.mjs`：假 opencode 服务覆盖派活、运行中续等、状态、续聊、取消、模型排序/钉死/回落、目录必填、参数隔离（`model`/`caller`/`mode`/`task_id` 都会被拒绝）、输出截断。
- `tests/server.test.mjs`：官方 SDK 客户端通过 stdio 启动真实 server，验证 `tools/list` 只有两个工具、`tools/call` 全链路（`XDG_STATE_HOME` 指向夹具，不碰真实服务）。

## 边界

- 委派消耗 opencode 账号的免费额度；免费清单和可用性以服务端 `/api/model` 为准。
- MCP 进程退出不影响已在跑的会话：会话在后台服务里，重连后按 `session_id` 继续。
- 会话级预授权意味着被委派的 agent 能执行它想执行的任何工具；只把任务派给可信目录。
