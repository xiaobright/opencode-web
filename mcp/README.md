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
- `message` 以官方默认的 `steer` 语义追加指令：先持久接收，再在安全步骤边界投递，默认等待 30 秒。本次调用固定输入 ID，返回其投递之后、下一条 idle 之前的输出；并发 steer 可以共享一轮执行与答案，不保证一问对应一个独立回合。
- 新的 `status` / `wait` 或 MCP 重连，优先选择 Inbox 中最后一个待处理用户输入；没有时选择最新投递的用户消息。不会混排接收时间和投递时间，也不按 ID 字典顺序推断时间。
- `cancel` 只请求中断当前执行；会话、文件和 **Inbox 中尚未投递的输入都保留**，返回中会说明数量。`wait` 只观察，不唤醒停放的输入；需要继续时可在官方会话中恢复，或用 `message` 发送新的继续指令（也会唤醒同一 Inbox）。
- 已结束的回合按后台结果返回 `done` / `failed` / `cancelled`，等待结束不等于执行成功。
- **会话 ID 由服务端分配**：真实免费模型验收中，自带 session ID 会返回 `provider.auth` 403，服务端分配的 ID 则正常。这是已观测到的上游行为，不能仅凭 OpenAPI 接受 `id` 就认定可用。创建会话不自带 ID，因此**创建请求不重试**——连接丢失时提示会话可能已创建，应先查看会话列表，避免重复创建。
- 提交输入的 ID 由 MCP 生成，同一 ID 重试只入队一次；查询、只读等待、同键同值的指令写入可重试；中断请求不重试，以免中断后续执行。超时或再次失败会带上已知 Session/input ID，应先检查会话。
- 同一请求的重试不会重复入队，但不保证工具副作用 exactly-once，也不合并两次独立的 MCP `tools/call`。

## 输入与执行状态

结构化结果保留原有字段，并增加：

| 字段 | 含义 |
| --- | --- |
| `input_id` | 本次观察的官方输入 / 用户消息 ID |
| `input_status` | `queued` 尚在 Inbox；`delivered` 已投递、未确认结束；`settled` 已找到下一条 idle；`unknown` 未找到投递边界 |
| `pending_inputs` | Inbox 内所有待处理输入数量（也包含官方控制输入） |
| `last_outcome` | 最近一轮执行的官方结果，仅作历史说明 |
| `input_outcome` | 所选输入投递后的第一条 idle 结果；多个 steer 可共享 |
| `input_error` | 所选输入结束时的错误：`type`（最多 100 字符）、`message`（最多 1000 字符）及可选 HTTP `status`；没有错误时省略，不返回上游原始响应体 |
| `history_truncated` | 为定位输入最多读取 5 页、每页 200 条；超出窗口时为 true |

`state` 优先报告会话 `running`，其次为 `queued`；空闲且确认所选输入结束时，按它自己的结果返回 `done` / `failed` / `cancelled`，后来别的输入失败不会改写原输入的结果。进程不活跃却缺失结束边界时返回 `unknown`，没有输入时为 `pending`。官方 wait 返回只代表当前执行空闲，不能当作输入已处理或执行成功。历史窗口找不到输入时不返回别的回合的答案；正文长度仍受 `OPENCODE_MCP_MAX_CHARS` 限制。

`delegate` / `message` / `wait` 在所选输入 `settled` 后返回其答案，即使其他输入使会话仍为 `queued` 或 `running`。这只表示所选输入已结束；其他工作仍由 `state` 和 `pending_inputs` 表示。错误同时出现在可读文本和结构化结果中，`status` 也会返回所选输入的错误，方便区分鉴权失败、模型错误与仍在执行。

## 工作协议（让 status 有东西可抓）

opencode V2 移除了 `todowrite`（v1 迁移里的 `REMOVED_TOOLS`），所以协议不走工具，走纯文本：

- 优先通过官方 `PUT /api/experimental/session/{sessionID}/instructions/entries/delegation-protocol` 保存持久指令，继续影响后续回合。兼容性检查确认没有这个可选入口时，才回退到首条任务消息的 `[Delegation protocol]` 前缀；写入失败不会静默降级。要求**调用任何工具之前**先输出一行 `plan: 1) … 2) …`；
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

- `plan:` / `progress:` 是展示提示；运行状态以官方 active、Inbox、idle 为准，不从文本猜测完成。启用协议时，最终答复剥去代码围栏之外的协议行；关闭协议时保留原文；
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
- **监视页**：每 2.5 秒刷新，合并历史首页与全部活跃会话，运行中优先，可“加载更多历史”。显示 Inbox 待处理数量，结束时刷新详情，未变化的已完成详情缓存复用（最多 200 项）；已加载的旧会话元数据每分钟更新。读取失败保留上一帧并标记状态待确认；
- **托盘**：右键菜单显示「后台任务：N 个在跑」，点击直接进后台栏位。

判定完全来自会话 metadata，TUI 自己开的会话不会被误认。

## 休眠与上游兼容性

网关休眠前额外读取 `/api/session/active`：任何正在执行的会话（包括前台和后台）都会阻止此次休眠；探测失败或格式不兼容也保持运行。只有停放的 Inbox 不永久阻止休眠，仍遵循默认 15 分钟无访问/无更新窗口；输入由官方持久保存，`wait` 本身不会恢复执行。

本地源码基线为 **OpenCode `654b79b27e79da735d6b07d766c8d7431a71d1b7`（2026-10-15）**，不是安装版本探测结果。首次使用读取 `/openapi.json`，检查 Session、active、Inbox、消息分页、等待、中断、模型和输入 ID 入参；必要能力缺失时在提交任务前明确报错，指令入口可选。能力检查与写入前检查共用一份进程内缓存，按 URL、认证信息、服务版本和 PID 区分，成功结果保留 10 分钟（最多 4 个服务身份），并发探测合并，失败不缓存。连接发现仍为 5 秒缓存；发现服务身份变化后检查新目标，连接丢失后的幂等写入重试会强制重新验证。OpenAPI 的版本字符串只作信息，不代替能力判断，也不能证明所有运行语义。

`tests/openapi-baseline.json` 提取自该提交的 `packages/protocol/openapi.json`，保留操作输入及递归引用的 schema。语义对照 `specs/v2/session.md`、`packages/core/test/session-prompt.test.ts`、`session-wait.test.ts` 和 `session-instructions.test.ts`。上游升级时先比较这些契约并运行下列隔离测试，再用新版本的测试服务验收；未知能力不会静默降级。

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

- `tests/tools.test.mjs` / `tests/tasks.test.mjs`：假 opencode 服务覆盖派活、续等、失败/取消结果、续聊超时后的输出边界、模型排序/钉死/回落、绝对目录校验、参数隔离、输出截断；包含所选输入已结束而其他输入仍排队/执行、错误诊断限长且不返回原始响应体。夹具只注入 HTTP 传输，使用生产 API 包装器；区分接收/投递/结束，覆盖并发重试、保留队列、长历史分页和未知状态。
- `tests/client.test.mjs`：真实 Node HTTP 客户端及生产重试代码验证输入 ID 重试只入队一次、创建请求不携带 session ID、创建响应丢失后不重试、中断不重试，以及契约读取丢失响应后安全重试、超过连接 TTL 后仍复用契约缓存。
- `tests/compatibility.test.mjs`：直接使用官方生成 OpenAPI 的契约快照，检查能力识别、缺失能力时不创建会话，以及契约缓存的并发合并、10 分钟过期、服务身份隔离和失败恢复。
- `tests/server.test.mjs`：官方 SDK 客户端通过 Node stdio 启动真实 server，验证两个工具、丢失响应后的稳定输入 ID、默认等待预算上限、短预算续等、取消保留队列及 MCP 进程重连（`XDG_STATE_HOME` 指向夹具，不碰真实服务）；整组测试约需 40 秒。
- 网关休眠：仓库根目录运行 `bun test ./tests/startup/idle.test.mjs`；后台监控与排序：在 `tests/activity` 运行 `bun run run.mjs background.spec.ts ranking.spec.ts`。均使用隔离夹具，不调用真实模型。

真实免费模型验收需显式运行（仓库根目录）：

```bash
node mcp/live-smoke.mjs --run
# 可选：--model=opencode/其他免费模型ID
```

默认使用 `opencode/deepseek-v4.1-flash-free`，开始前确认模型免费、启用且支持工具。脚本在新临时目录里要求模型读一个标记文件，验证首次委派、MCP 重连、续聊输出边界、稳定输入 ID 去重、已结束输入与停放输入并存，并发出自带 session ID 的对照请求检查错误诊断。该检查会启动本机服务（若尚未运行）并消耗免费额度；不修改账号或模型排序。JSON 结果写入 `.state/live-smoke-*.json`，保留测试会话、临时目录及一个无副作用的停放输入供核对。普通 `bun test` 不运行此脚本。

## 边界

- 委派消耗 opencode 账号的免费额度；免费清单和可用性以服务端 `/api/model` 为准。
- MCP 进程退出不影响已在跑的会话：会话在后台服务里，重连后按 `session_id` 继续。
- 会话级预授权意味着被委派的 agent 能执行它想执行的任何工具；只把任务派给可信目录。
