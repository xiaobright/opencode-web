# 把前端工作台做成 Codex 版式 —— 方案与实现记录

> 语境：本机安装 opencode `v2.0.30`（UI 编译期嵌进二进制），源码树 `2.0.29`。
> **opencode-web 是底座**；`/api`、`/auth/`、`/openapi.json` 这层契约原样保留，一个字不动。

---

## 一、决定性的那条约束

opencode 官方外壳里引用的资源名带内容哈希（`_assets/index-DSXrPRcR.js`）。**任何"复制一份外壳"的做法都会在 opencode 升级后指向不存在的文件，页面直接白屏。**

这一条把方案空间切成两半：

| 做法 | 升级后 | 结论 |
| --- | --- | --- |
| 复制官方 HTML 进 `webui/index.html` | 资源哈希变了 → 白屏 | ❌ |
| 自建前端（把对话也自己渲染） | 不白屏，但官方 UI 的免费收益全丢 | ❌ 见下 |
| **每次请求现取官方 HTML、改写后转发** | 外壳永远来自当前安装版本 | ✅ **采用** |

所以最终形态是**覆盖层注入**：不动官方外壳，只往里插两样东西 —— 样式表（`<link>`）和脚本（`<script>`）。外壳本身、路由、对话渲染、工具卡片、diff、权限、终端，全部还是官方在跑。

### 为什么放弃了"自建前端"

早先的方案是搭一个 Vite + React + Tailwind 工程产出 `webui/`。放弃的理由不是工作量大，而是**长期成本**：

- 今天反代官方 UI 意味着**升级即得新功能**（消息渲染、工具卡片、diff、权限、终端都是官方在维护）。
- 自建前端之后，opencode 每加一个功能，我们都要自己跟一遍。
- 而扒来的第三方代码恰好**最不能直接抄的就是对话那一层**（见第三节的耦合度实测）。

外壳看着唬人但好做；对话时间线的流式、工具调用、diff、权限才是时间黑洞。用注入就不必碰它。

---

## 二、实现：两层注入

### 传输层（`src/ui-server.mjs`）

```
localhost:PORT
├── /api/*  /auth/*  /openapi.json   → 转发 opencode 后台服务，注入凭据    ← 契约，保留
├── /                       → 取官方 HTML，插 <link> + <script>，再发出去
├── /styles/*.css           → webui/styles/ 里的文件
├── /scripts/*.js           → webui/scripts/ 里的文件
└── 其余                    → webui/<path> 有就用，没有回落官方
```

- 注入只在**页面导航请求**（`Accept` 含 `text/html`）上做，这类请求会去掉 `accept-encoding` 以便改写响应体；`/_assets/*` 的压缩与缓存不受影响。
- 改写时删掉上游的 `transfer-encoding` / `content-encoding`，自设 `content-length`。
- `webui/index.html` 一旦存在就优先，且**不再注入** —— 所以现在刻意不建这个文件。
- 前端因此可以**同源**调 `/api/*`：不需要 CORS、不需要登录，反代已经带鉴权。

### 样式层（`webui/styles/codex.css`）

- 插在 `</head>` 前。
- 官方 token 在 `@layer theme` 里，本文件**不在任何层** —— 按层叠规则未分层声明胜过所有分层声明，所以不需要比官方更具体就能覆盖 token。
- 唯一需要 `!important` 的地方：官方把 `--shell-*-inset` 写在**行内 style** 上。

### 脚本层（`webui/scripts/codex-shell.js`）

- 插在 `</body>` 前，**经典脚本**（不是 `module`）：官方的 bundle 是 deferred，所以这个脚本先执行。
- 官方 CSP 是 `script-src 'self' 'sha256-…'`，同源外链脚本被 `'self'` 放行，**不用改 CSP**（已实测）。
- 它做这几件事：
  1. 修事件流的 `Accept`（**第五节**，没这一条官方界面根本用不了）；
  2. 建出图标栏（rail）和「工作区 → 会话」侧栏的 DOM；
  3. 从 `/api/project` + `/api/session` 读列表，按 `projectID` 分组；
  4. 点会话时驱动官方路由，并把官方内容整体右移让位；
  5. 「新聊天」/ 工作区「+」→ 借官方键位开一张草稿（点了不落库）；冷启动落在 `/` 时也转进草稿，并补一行 Codex 式提问；
  6. 图标栏那颗独立按钮切明暗（写官方那个存储键 + 补 `storage` 事件）。

---

## 三、扒来的结论：OpenChamber 的组件按耦合度分三档

这是调研里最值钱的一条。`openchamber/openchamber`（MIT、`@opencode/client` 与源码树同版）的组件**不是均匀可拆的**：

### 第 1 档 · 直接抄（低耦合）

| 扒什么 | 来源 | 为什么能抄 |
| --- | --- | --- |
| 52 个 shadcn 基础件 | `packages/ui/src/components/ui/` | 标准 shadcn + Radix，不碰业务 |
| 主题引擎 | `packages/ui/src/lib/theme/`（`definition.ts`、`color.ts`、`cssGenerator.ts`） | **纯函数，零 store 依赖** |
| 主题预设 | `lib/theme/themes/*.json`（35 个） | `vercel-light`（近白细边）最接近 Codex |
| Markdown / 代码高亮主题 | `chat/markdown/markdownTheme.ts` | 独立小模块 |
| 图标集 | `components/icons/` | 纯 SVG |

### 第 2 档 · 抄了改（中耦合）

Diff 视图（`views/DiffView.tsx`、`PierreDiffViewer.tsx`）、消息体与工具卡片（`chat/message/MessageBody.tsx`、`message/parts/*`）、外壳件（`layout/Sidebar.tsx`、`ContextPanelRail.tsx`）—— 都要剥掉 context / store hook，改成受控组件。

### 第 3 档 · 只借形，不借码（高耦合）

| 组件 | 实测耦合 |
| --- | --- |
| `chat/MessageList.tsx` | `@legendapp/list/react` + 10 个内部模块 |
| `chat/ChatInput.tsx` | **8 个 zustand store** + sync 层 + `@openchamber/sdk` |
| `chat/ChatMessage.tsx` | **6 个 zustand store** |

**这三档的处理方式完全不同。** 第 3 档正是不做自建方案的原因 —— 而本次采用的注入路线连第 1、2 档都不需要了：外观照抄，骨架只借形，逻辑全归官方。

> 另一个结论：OpenChamber 的**扩展系统不是出路**。`packages/extensions` 是沙箱 iframe 面板，官方明说"不向 iframe 暴露私有 store"，只能加面板，改不了主壳。

---

## 四、用到的官方钩子（全部实测）

### 路由与 serverKey

```ts
// packages/util/src/encode.ts —— base64Encode 是 base64url
btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")

// packages/app/src/runtime/platform/web.ts —— web 构建里 serverUrl 就是页面自身 origin
currentServerUrl: getCurrentServerUrl()

// packages/app/src/shell/routes/session.ts
sessionHref() = `/server/${base64Encode(serverKey)}/session/${sessionID}`
```

所以脚本里 `serverKey = base64url(location.origin)`。已实测：在 `http://127.0.0.1:53500` 上生成的段是 `aHR0cDovLzEyNy4wLjAuMTo1MzUwMA`，解得正是 `http://127.0.0.1:53500`。

### 导航

用 `history.pushState` + 派发 `PopStateEvent("popstate")` 驱动 —— 官方用 `@solidjs/router` 的 history 集成，监听的是 `popstate`，所以这样能真正切开会话。**已实测**：`/` → `/server/<key>/session/<id>`，主区渲染出会话面板与 Composer。

> 侧栏里那行会话本身是 `<button>`，不是 `<a href>`，所以没有可以直接借用的链接语义。

### 让位锚点

`shell.tsx` 把 `--shell-inline-inset` 等写成行内 style，注入的样式用它当选择器（`[style*="--shell-inline-inset"]`）给根节点加 `padding-left: var(--ocw-gutter)`，官方主区自动右移 —— 不改它的 DOM，也不改它的路由。

### 要收掉的官方件

| 选择器 | 是什么 | 处理 |
| --- | --- | --- |
| `[data-slot="titlebar-tabs"]` | 横向标签栏根节点（class `relative min-w-0`） | 隐藏（和侧栏重复） |
| `[data-slot="titlebar-v2"] > div > *` | 标题栏内除右插槽之外的一切 | 隐藏，只留 `:last-child`（右插槽）和 `.flex-1`（撑开元素） |
| `[data-slot="vertical-tabs-sidebar"]` | 竖向标签栏 | 隐藏（万一开到这模式，别和侧栏叠） |

右插槽是官方 JSX 的**最后一个子节点**（`titlebar.tsx:766` 起），所以 `:last-child` 是结构保证的。隐藏标签栏不丢功能：关闭标签的命令 `tab.close` 键位还在（默认 `Ctrl+W`），命令面板里也有。

### 建会话：走官方的草稿，点了不落库

`/new-session` **不能靠 URL 进**：

```tsx
// packages/app/src/new-session/route.tsx
<Show when={tabs.store.find(t => t.type === "draft" && t.draftID === search.draftId)}
      fallback={tabs.ready() && <Navigate href="/" />}>
```

它要求内存里的 tabs store 已存在对应 draftID 的草稿标签，而那个只能由官方界面内部调 `tabs.newDraft()` 建出来。所以直接改 URL 会被弹回 `/`。

用不了 URL，那就**借官方的键位**：官方命令 `tab.new`（`keybind: "mod+t,mod+n"`，`titlebar.tsx`）走的正是 `openNewTab() → tabs.newDraft()`。键位签名是 `${key}:${mask}`（mask = `ctrl | meta<<1 | shift<<2 | alt<<3`），Windows 上 Ctrl+T 就是 `t:1`；`handleKeyDown` 不校验 `isTrusted`，所以合成一个 `KeyboardEvent` 派发到 `document` 就能触发：

```js
document.dispatchEvent(new KeyboardEvent("keydown", {
  key: "t", code: "KeyT", ctrlKey: true, bubbles: true, cancelable: true, composed: true,
}))
```

`openNewTab()` 按当前路由决定草稿落在哪个目录：

| 当前路由 | 目录来源 | 实测 |
| --- | --- | --- |
| 会话 | 该会话的 `activeSession.directory` | ✅ 直接可用 |
| `/`（官方首页） | `layout.home.selection()` | ❌ web 构建里常为空 → 静默失败 |
| `/settings` 等 | 同上 | ❌ 同上 |

所以脚本里的 `openDraft(dir)`：**目标工作区和当前路由不一致时，先 `go()` 到那个工作区最近的一条会话，等它挂载，再按键**；一致就直接按。用 `draftTicks` 上限兜底（6 次 × 450ms ≈ 2.7s），失败就放弃。

好处：**点「新聊天」不再落库**，空会话只在真正发送那一刻才由官方 POST 出来（已实测：草稿屏输入 → 点发送 → 才出现 `ses_…`，标题由官方生成）。

> 这替掉了早先「直接 `POST /api/session`」的做法，也就消掉了"点了不用会留一个空会话"的旧取舍。
> 唯一的空洞：整个应用里一条会话都没有时（全新安装），没有会话可借路由带出目录，草稿开不出来 —— 这种情况把官方首页原样留给你，在官方首页里加项目即可。

### 首页不再是官方那个首页

冷启动落在 `/` 时，`refresh()` 拿到列表后自动 `openDraft("")`，于是落地页就是 Codex 那种「居中品牌标 + 完整 composer」。**只做一次**：万一开不出来就把官方首页原样留着，免得和官方草稿路由的 `<Navigate href="/" />` 来回打转。

过渡期间给根节点挂 `data-ocw-drafting`，CSS 借它把 `[data-slot="home-panel"]` / `[data-slot="session-chat-panel"]` 藏住 —— 否则会先闪一下官方首页、再闪一下被借道的那条会话。草稿屏一出现（或 3 秒兜底）就撤掉这个标记。

草稿屏那行提问是**插进去的一行 DOM**：官方这块本来只有一枚淡色 ASCII 品牌标 + composer，我们在 `[data-component="new-session-wordmark"]` 之后插一行

```
你想让我们在 <code>工作区目录名</code> 中构建什么？
```

工作区名优先取当前会话所在分组（草稿屏上取"上次记下的那个"），拿不到就退化成「你想让我们构建什么？」。官方重渲染把它刷掉也没事 —— 350ms 那圈轮询会调 `syncHero()` 自动补回。

---

## 五、一个必须打的补丁：事件流的 `Accept`

这一条是本次最关键的发现，**没有它整个官方界面都用不了**（模型选择器是空的、发送被拦、首页永远"加载中"）。

### 症状链

```
[global-sdk] event stream disconnected {"attempt":n,"error":"Timed out connecting to server"}
  → 官方 connection.connectTimeout = 2000 到点 abort（CDP 里 /api/event 一直 net::ERR_ABORTED）
  → connection.status() 永远到不了 connected
  → bootstrapInstance 被 if (!connected()) return 挡掉
  → data.location.sync() 从不执行 → 不发 /api/provider、/api/model、/api/agent
  → providers.ready() 恒 false → model.loading 恒真
  → 模型控件被隐藏、选择为空 → 发送被 missingSelection 拦下
```

服务端完全无辜：curl/Node 直连 53500、53510、53520 都是 8~12ms 拿到 `server.connected`；上游 0~1ms 给出响应头，代理 `writeHead` 在 +2ms 完成。

### 真因

`packages/app/src/runtime/server/request-queue.ts` 对事件流是**直通**的：

```ts
if (pathname === "/api/event") return base(request)
```

这个 `Request` 没有 `Accept` 头，浏览器给它补成通配值。而本机 `Chrome/155.0.8059.40` 只在请求的 `Accept` **恰好等于** `text/event-stream` 时才把该 MIME 的响应交给 `fetch` —— 否则一直卡到上游关闭。最小复现矩阵（自建服务器，逐个变量单测）：

| 请求 `Accept` | 响应 `content-type` | 结果 |
| --- | --- | --- |
| 通配 | `text/event-stream` | ❌ 卡死 |
| `text/event-stream` | 通配 | ❌ 卡死 |
| `text/event-stream` | `text/event-stream` | ✅ 7ms |
| 通配 | `text/plain`（流式） | ✅ 6ms |

与 `nosniff`、`vary`、`transfer-encoding`、`keep-alive`、`fetch(Request)` vs 字符串 URL 都无关；headless 与否、干净 profile、`--disable-extensions` 都不影响。

### 补丁

`codex-shell.js` 顶部（**最早时机**，官方 bundle 是 deferred，经典脚本先执行）包一层 `window.fetch`，只给 `pathname === "/api/event"` 的请求把 `Accept` 强制成 `text/event-stream`：`input instanceof Request` 时用 `new Request(input, { headers })` 重建（保留 method/signal/mode/credentials），字符串/URL 走 init 分支，任何异常都原样透传。

关键是**时机**：官方 `request-queue` 在创建时就抓住 `globalThis.fetch`，所以必须赶在它之前包好。

> 因此这个皮肤不是"纯外观"了：**移出 `webui/scripts/` 会同时失去这个补丁**，界面会退回"用不了"的状态（`webui/styles/` 单独移出则只丢外观）。

---

## 六、接口侧

118 个端点，够用：

```
GET  /api/project                              → 项目数组（id, canonical, name, vcs, time）
GET  /api/session?order=&limit=&project=       → { data: Session.Info[], cursor }
GET  /api/session/{id}/message?limit=&order=   → { data: Session.Message.Info[], cursor }
GET  /api/event                                → SSE
POST /api/session                              → 建会话
POST /api/session/{id}/prompt  /interrupt
GET  /api/session/{id}/diff  /context  /inbox  /permission
GET  /api/agent /api/model /api/provider /api/command /api/mcp /api/config
GET  /api/fs/*  /api/vcs/*  /api/worktree  /api/pty  /api/shell
```

会话列表实际用到的字段：`id`、`projectID`、`title`、`parentID`（子会话不进侧栏）、`time.{updated,created,archived}`。

（这里的 SSE 指**我们侧栏自己**没接 —— 官方的 `/api/event` 是官方应用在用，见第五节那个 `Accept` 补丁。侧栏靠"路由变化时刷新 + 20 秒轮询"更新，够用且简单。）

---

## 七、二次折叠：一轮的全部过程收成一行「用时 …」

官方自己只折到"单行工具组"这一层。再往上折一层，还是同一条原则：**只动 DOM 表现，不碰官方数据**。

| 实测到的事实 | 怎么用 |
| --- | --- |
| 一轮里每一行都是虚拟列表里独立的一块（`[data-timeline-key] > [data-index] > [data-message-id][data-timeline-row]`），但共用 `data-message-id` = 该轮 user 消息 id | 按它分组，"一轮"在 DOM 里就可辨 |
| 被 `ResizeObserver` 量的是 `[data-index]` | 把它压成 `height: 0; overflow: hidden`（外加 `content-visibility: hidden` 省渲染）→ 量到 0 → 虚拟列表自己 `resizeItem(0)`，高度就塌了 |
| 行键（`data-timeline-key`）随行稳定，重新挂载还是同一个 | 隐藏规则按**行键**写进一张动态 `<style>`：行重新挂上来时样式早就在，不会先露一下再收回去 |
| 官方把这一轮的用时写在最终正文的 `[data-slot="text-part-meta"]` 上（本地化文本："9 分钟 38 秒"） | 读出数字重排成 Codex 的 `用时 9m 38s`；读不到就用回退文案 `已折叠 N 步` |

折叠规则：

- **最终回复** = 这一组里最后一个含 `[data-slot="session-turn-assistant-content"] [data-component="text-part"]` 的行（工具卡片里的文本不算）。
- 表头插在**这一轮第一个过程行**里面（不是另起一行）：那行的高度就成了表头高度，于是收起后看到的顺序是
  `用户消息 → 用时 … › → 最终回复`；展开时表头还在最上面，和 Codex 一致。
- **最终回复之后**的行（改动清单、收尾提示）保持可见：那些更像"结果"，而且里面可能有子会话面板之类不该压掉的东西。
- 这一轮里只要有 `Shell`（子会话面板）或 `CompactionQueued`（正在压缩）就整轮不折；**正在跑的轮**（官方在这一轮正文上打了 `aria-hidden="true"`）也不折，跑完下一拍自动折起来。
- 折叠判定**记在内存里**（`foldRows`：轮 → 已折行键集合 + 表头行 + 文案）：行是虚拟的，滚出视口就卸载，"只挂了几行"和"没得折"看起来一样，每次现算会让折叠在滚动时一闪一闪。
- 压缩块复用同一张样式表：`[data-ocw-compact]` 收起时只剩「会话已压缩 · 13万 输入 · 6132 输出」那一条线（点它展开总结，线尾带箭头），「会话压缩已开始」与总结正文藏起来；展开就是官方原样。压缩块本身又是这一轮里的一个过程行，所以会被二次折叠一起收进去 —— 和「使用了 xxx」同级。

开关与维护：

- 表头是真的 `<button class="ocw-turn-toggle">`，点击在**捕获阶段**处理（抢在官方时间线那个清选区的 `onClick` 之前），切 `turnOpen[key]` 后下一帧重算。
- 维护时机：`MutationObserver(childList)` 盯 `[data-timeline-virtual-content]` 的行增删（表头要在行一出现时就在），外加 `syncActive()` 那 350ms 一拍兜底。
- 换会话清空折叠状态；`foldRows` 超过 200 轮丢最旧的，单轮行数封顶 400 —— 不让样式表随会话长度无限长。

刻意不做：不删除任何行、不改官方数据、不加高度过渡动画（虚拟列表自己会重算高度并做滚动锚定，加 CSS 过渡会和它抢）。

---

## 八、验收记录

用无头 Chrome 通过 CDP 驱动真实交互（`bun`/`node` 起一个测试实例在 53500，官方实例 53123 保持不动）：

| 验的什么 | 结果 |
| --- | --- |
| 注入是否生效 | 页面 HTML 里有 `<link .../styles/codex.css>` 和 `<script src="/scripts/codex-shell.js">`；同源脚本能取到（200，`application/javascript`） |
| CSP 是否放行 | 放行（脚本执行、壳建出来了） |
| 官方内容是否让位 | `--ocw-gutter: 312px` → 官方 `main.left = 313`；折叠时 `53`（侧栏 260 → 0） |
| 事件流（`Accept` 补丁） | 不再出现 `event stream disconnected`；`/api/event` 建连成功；`/api/location`、`/api/provider`、`/api/model`、`/api/agent`、`/api/command`、`/api/integration`、`/api/mcp`、`/api/skill` 全部 200 |
| 模型选择器 | `[data-slot="composer-controls"]` 里出现 `data-action="composer-model"`，文案 `DeepSeek V4.1 Flash Free High` |
| 点侧栏会话能否切路由 | `/` → `/server/aHR0cDovLzEyNy4wLjAuMTo1MzUwMA/session/ses_…`，`session-chat-panel` 与 `composer` 都在，正文是真实对话 |
| 当前会话高亮 | 只有一行 `is-active`，且 id 与被点的行一致 |
| 折叠 | `312px` → `52px`，侧栏 `display: none`，主区让位同步 |
| 搜索 | 32 行 → 假关键词 0 行 → "model-gateway" 1 行（只剩那一个工作区）→ 清空回到 32 行 |
| 工作区折叠 | 该组行数 `1 → 0 → 1` |
| **冷启动落首页** | 开 `http://…:53500/` → 自动落到 `/new-session?draftId=…`（官方首页不再当落地页） |
| **草稿屏提问行** | 品牌标 + Composer 都在；插入的行读作「你想让我们在 `opencode-web` 中构建什么？」 |
| **新聊天不落库** | 点侧栏「新聊天」→ 只换 `draftId`，会话总数不变；点工作区「+」（`CLIProxyAPI`）→ 草稿落在该工作区，提问行的目录名跟着变 |
| **真发一条** | 草稿屏输入「只回复两个字：你好」→ 点发送 → 官方建出 `ses_…`（标题「要求仅回复你好」）→ 收到回复「你好」→ 删除该会话（204） |
| 测试残留 | 会话数核对：默认列表 50 条（接口上限）+ 全量 286 条，无标题的空会话 0 条 |
| 深浅色 | 都是正常 token；点图标栏那颗独立按钮：`data-color-scheme` 在 `light ⇄ dark` 间切，图标/标题同步，`localStorage["opencode-color-scheme"]` 跟着写 |
| **二次折叠** | 同一会话 5 轮实测：收起后每轮 = `用户消息 → 用时 … › → 最终回复`（表头行 30/46px、中间各行 `[data-index]` 高 0、末行正文 1497/1513px 原样）；点表头 → 首行 30 → 91px、被折行回到 44px，再点收回 |
| **压缩块折叠** | 5 个压缩块都收成 48px 一条线（「会话压缩已开始 / 会话已压缩 · 15.6万 输入 · 3223 输出」等）；点线 → 3832px、总结与起始分隔线 `display: block`；再点回 48px、总结 `display: none` |
| **用时从哪来** | 直接读官方 `[data-slot="text-part-meta"]`：`用时 2m 15s` / `3m 15s` / `44m 56s` / `14m 30s`；更早、已被压缩带走的轮读不到 → `已折叠 2 步` |
| **注入脚本自身异常** | 无。页面里只有官方那个 `sw.js` 404 的报错（见下） |

### 已解决的历史问题

- **首页一直停在"加载中"、模型控件是空的、发送被 `missingSelection` 拦下** —— 真因就是第五节那个 `Accept` 问题，补丁后全部消失（首页/模型/发送都正常）。不是环境问题。
- `sw.js` 的 404 与对应控制台报错，是 `ui-server.mjs` 故意返回的（避免 Service Worker 预缓存官方资源）。

---

## 九、已知取舍与后续

| 项 | 现状 | 后续可做 |
| --- | --- | --- |
| 新聊天 | 走官方草稿，点了不落库 | — |
| 二次折叠的用时 | 只认官方写在最终正文 meta 上的那个（被压缩带走的轮拿不到 → 回退 `已折叠 N 步`） | 想自己算是可以的（`/api/session/{id}/message`），但压缩消息会打乱列表顺序、位置对不上轮次，暂不做 |
| 折叠的收放 | 瞬时，没有过渡动画 | 虚拟列表自己重算高度并做滚动锚定，加 CSS 过渡会和它抢 |
| 折叠与搜索/跳转 | 官方搜索跳到的行如果落在被折的轮里，仍然是被折着的 | 可考虑在官方 `reveal` 时自动展开那一轮 |
| 草稿开不出来时 | 一条会话都没有（全新安装）就借不到目录 → 草稿开不出来，官方首页原样留着 | 可考虑从官方首页那颗 `data-action="home-project-new-session"` 上想办法 |
| 标题栏裁剪 | 依赖"右插槽是最后一个子节点" | 官方结构若变，这条要跟着看 |
| 侧栏更新 | 路由变化 + 20 秒轮询 | 接 `/api/event` SSE |
| 窄屏 / 移动端 | **未验证** | 官方移动端是另一套分支，需单独处理 |
| 官方首页的"项目/设置"列 | 与侧栏有重复，未处理 | 可按需隐藏 |
| 关掉整套皮肤 | 移出 `webui/styles/` 与 `webui/scripts/`，刷新即可 | 注意：**移出 `scripts/` 会一同失去事件流 `Accept` 补丁**，界面会退化成用不了 |

### 许可

扒取 OpenChamber 代码时：MIT，需保留 LICENSE 与出处；async-code 为 Apache-2.0，需保留 NOTICE；**`claudecodeui` 是 AGPL-3.0，不要抄它的代码**。

### 变更文件

- `src/ui-server.mjs` —— `overlayScripts()`、`rewriteShell()`、`injectOverlay()`（原 `injectStyles()`）。
- `src/start.mjs` —— 启动日志带上注入清单。
- `webui/styles/codex.css` —— 观感 + 骨架样式 + 草稿屏提问行 + 开草稿时的过渡遮罩 + 二次折叠（表头、压缩块开关）。
- `webui/scripts/codex-shell.js` —— 图标栏与侧栏；`patchEventAccept()`（第五节）、`openDraft()` / `forwardHomeOnce()`、`toggleTheme()`；二次折叠（第七节：`syncTurns()` / `syncCompactions()` / `syncFold()` / `foldClick()`）。
- `webui/README.md`、`README.md` —— 文档。
