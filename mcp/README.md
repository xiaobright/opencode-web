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
- `wait` 默认每次等 30 秒，为 MCP 客户端常见的 60 秒请求超时留出状态查询和传输余量；等待预算用完时会话继续跑，再调一次即可。调大服务端等待预算前，也需相应调大客户端请求超时。
- `message` 往同一个会话追加指令并等回复（默认 30 秒），只返回这一问的增量；超时后通过 `wait` 续等或 MCP 重连，也从持久消息恢复这一轮的输出边界。
- `cancel` 只中断当前回合，会话和文件都保留。
- 已结束的回合按后台结果返回 `done` / `failed` / `cancelled`，等待结束不等于执行成功。
- 连接丢失时，只有查询和只读等待自动重试；创建会话、发送指令、取消都不自动重发。写请求报错时可能已被后台接受，应先检查会话，避免重复提交。

## 工作协议（让 status 有东西可抓）

opencode V2 移除了 `todowrite`（v1 迁移里的 `REMOVED_TOOLS`），所以协议不走工具，走纯文本：

- MCP 注入不了子代理的系统提示词，所以要求跟着**任务消息**一起发过去：任务前面附一段 `[Delegation protocol]`，**调用任何工具之前**先输出一行 `plan: 1) … 2) …`；
- 每完成一步、开始下一步之前，输出一行 `progress: n/N <做了什么> -> <下一步>`；
- 当前版本如果有 todo 工具就同步过去；没有就不要去找（避免模型把回合浪费在搜索不存在的工具上）。

`status`、`wait` 超时、`delegate` 超时返回同一块进度：

```
Session ses_x · running · 1m12s
Plan: 1) 读代码 · 2) 改代码 · 3) 跑测试
Now: shell "npm test" (running)
Progress: 2/3 改完了 -> 跑测试
Files: 2 changed +31 −4 (a.js, b.js)
```

- `plan:` / `progress:` 行只进 status，最终答复里会被剥掉；
- 解析时也会看 `reasoning`（只取匹配到的 plan/progress 行），推理模型把计划写在思考里也能抓到；
- 关掉协议：`OPENCODE_MCP_PROTOCOL=off`。

## 模型怎么选

**运营者在网页里排，服务端照办。** 切到「后台任务」栏位后，侧栏头部的叠层按钮打开模型顺序面板：列出当前可用的免费模型，上下移动调整顺序，排第一的就是下一次委派用的模型；排序存在 `.state/model-ranking.json`，MCP 每次都读同一个文件，改完立即生效。

- 默认（还没排过时）DeepSeek V4.1 Flash 排第一。
- 某个模型下架后自动跳过，不会把委派卡死。
- `OPENCODE_MCP_MODEL=provider/modelID` 是给运维的强制钉死项，优先级高于排序。

## 在网页和托盘里看

委派产生的会话带 `metadata: { origin: "opencode-delegate", caller }`：

- **侧栏**：图标栏分「前台任务 / 后台任务」两个栏位；后台栏位只列委派会话（标注 `caller · model`，运行中显示像素格动画），工作区里的会话不受影响；
- **监视页**：后台栏位的右侧视图，按会话显示运行状态、调用方、模型、目录、最近一轮工具流程、token/成本，2.5 秒刷新，点卡片进会话；
- **托盘**：右键菜单显示「后台任务：N 个在跑」，点击直接进后台栏位。

判定完全来自会话 metadata，TUI 自己开的会话不会被误认。

## 环境变量（运维侧）

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_MCP_DIRECTORY` | 默认工作目录；不设则每次委派必须传 `directory` |
| `OPENCODE_MCP_CALLER` | 记录调用方（写进会话 metadata），默认 `mcp` |
| `OPENCODE_MCP_MODEL` | 强制钉死模型，优先于网页排序；默认留空 |
| `OPENCODE_WEB_STATE_DIR` | 状态目录（排序文件），默认仓库下 `.state/`；网页网关与 MCP 共用 |
| `OPENCODE_MCP_DELEGATE_WAIT_MS` | 派活后先等多久，默认 20000 |
| `OPENCODE_MCP_WAIT_MS` | 单次 `wait` / `message` 的等待预算，默认 30000；调大时需给客户端请求超时留出余量 |
| `OPENCODE_MCP_MAX_CHARS` | 单次返回正文上限，默认 8000 |
| `OPENCODE_MCP_PROTOCOL` | 设为 `off` 关掉 plan/progress 工作协议 |
| `OPENCODE_BIN` | 透传给服务发现层，指定 opencode 可执行文件 |

## 测试

```bash
cd mcp && npm install && bun test ./tests
```

- `tests/tools.test.mjs` / `tests/tasks.test.mjs`：假 opencode 服务覆盖派活、续等、失败/取消结果、续聊超时后的输出边界、模型排序/钉死/回落、绝对目录校验、参数隔离、输出截断。
- `tests/client.test.mjs`：真实 Node HTTP 客户端验证丢失响应后的重试策略，确保已接收的写请求不被重复提交。
- `tests/server.test.mjs`：官方 SDK 客户端通过 Node stdio 启动真实 server，验证两个工具、默认 30 秒续等及 MCP 进程重连（`XDG_STATE_HOME` 指向夹具，不碰真实服务）；整组测试约需 35 秒。

## 边界

- 委派消耗 opencode 账号的免费额度；免费清单和可用性以服务端 `/api/model` 为准。
- MCP 进程退出不影响已在跑的会话：会话在后台服务里，重连后按 `session_id` 继续。
- 会话级预授权意味着被委派的 agent 能执行它想执行的任何工具；只把任务派给可信目录。
