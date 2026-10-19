# webui/ — 覆盖层

这个目录**默认是空的**，空着就用 opencode 自己那套界面（本地服务直接反代 `opencode` 后台的 `/`、`/_assets/*`，所以永远和当前安装的 opencode 版本一致，不用同步、不用重新抽取）。

往这里放文件就会**按 URL 路径**覆盖官方界面的同名文件：

| 放这个文件 | 效果 |
| --- | --- |
| `webui/index.html` | 换掉整个页面外壳（之后所有 HTML 响应都用它，客户端路由的深链接也是） |
| `webui/_assets/app-xxxx.js` | 只换这一个官方资源，其余仍来自官方构建 |
| `webui/logo.svg` | 加一个官方没有的文件，访问 `/logo.svg` 就能拿到 |
| `webui/styles/*.css` | **不换外壳**，把样式表链进官方外壳里（见下一节） |
| `webui/scripts/*.js` | **不换外壳**，把脚本插进官方外壳里（见「换个骨架」） |

改完**不用重启**：覆盖层文件是每次请求现查的，而且不带缓存（`cache-control: no-cache`），刷一下浏览器就是最新的。

## 换个外观：`webui/styles/`

放进去的 `.css` 会被**链进官方外壳**（反代回来的 HTML 的 `</head>` 前插一批 `<link>`），外壳本身仍然是当前安装的 opencode 提供的。

为什么不是直接换 `index.html`：外壳里引用的资源名带内容哈希（`_assets/index-BktYfxi_.css`）。复制一份外壳，opencode 一升级哈希就变，那份副本会指向不存在的文件，页面直接白屏 —— 正好是这个项目最想避免的。插 `<link>` 没有这个问题：外壳随版本走，只有样式表是你的。

- **按文件名排序**，所以用数字前缀控制层叠顺序，例如 `00-base.css`、`10-codex.css`。
- 官方 token 写在 `@layer theme` 里，注入的样式**不在任何层**。按 CSS 层叠规则，未分层的声明胜过所有分层声明，所以皮肤不用比官方更具体就能覆盖 token。
- 官方外壳带 CSP（`style-src 'self' 'unsafe-inline'`），`/styles/*.css` 是同源，正常加载。
- 只在**页面导航请求**（`Accept` 里含 `text/html`）上注入，并且会为这类请求去掉 `accept-encoding` 以便改写响应体；`/_assets/*` 的压缩和缓存都不受影响。
- 如果 `webui/index.html` 也存在，它优先，而且**不再注入**：外壳换成你自己的，链什么由你决定。
- `webui/styles/codex.css` 提供 Codex 皮肤、图标栏/侧栏的骨架样式、草稿屏提问和过渡遮罩；`activity-status.css` 提供具体工作状态样式；`overlay-layout.css` 修正官方弹层相对右侧内容区的位置。

## 换个骨架：`webui/scripts/`

放进去的 `.js` 会被插进**官方外壳的 `</body>` 前**，同样是每次请求现取官方 HTML 再改写，外壳本身仍来自当前安装的 opencode。

样式表能改的只有长相。链进来的脚本能做样式做不到的事：往页面上**加真实的 DOM**（图标栏、按工作区分组的会话侧栏），并把官方内容整体右移让位。

- **经典脚本**（不是 `module`），而且在 `</body>` 前，所以它先于 Vite 打进 `_assets/` 的 deferred module 执行 —— 可以在官方界面挂载之前就把状态准备好。
- **按文件名排序**，和样式表一致。
- 官方外壳的 CSP 是 `script-src 'self' 'sha256-…'`，同源外链脚本被 `'self'` 放行，不需要改 CSP。
- 官方给界面留的钩子（`data-slot="titlebar-v2"`、`data-component="new-session-wordmark"` 等）都是稳定的选择器，脚本靠它们定位，不靠结构猜。
- 外壳脚本是 `webui/scripts/codex-shell.js`，具体工作状态由下节介绍的两个活动状态脚本补充。外壳脚本做三件核心的事 —— 建 rail 和侧栏的 DOM（从 `/api/project` + `/api/session` 读列表，点会话时用 `history.pushState` + `popstate` 驱动官方路由）；**开一张官方草稿**（借 `mod+t` 键位触发官方的 `tab.new`，所以点「新聊天」不落库；顺带冷启动落 `/` 时转进草稿、草稿屏补一行 Codex 式提问、图标栏上加一颗明暗切换）；以及给事件流补上 `Accept: text/event-stream`（没有它官方界面用不了，见下）。**对话、消息渲染、工具卡片、diff、权限、终端全部仍是官方的**。

> ⚠️ 这个脚本同时是一个**必要的兼容补丁**：官方 `request-queue.ts` 对 `/api/event` 直通时那个 `Request` 没有 `Accept` 头，本机 Chrome 只在 `Accept` 恰好是 `text/event-stream` 时才把该 MIME 的响应交给 `fetch`，于是事件流永远连不上 → 模型列表空、发送被拦、首页停在"加载中"。脚本顶部包了一层 `window.fetch` 专门给这个路径补 `Accept`。**所以移出 `webui/scripts/` 不只是丢外观，界面会退化成用不了**（只移 `webui/styles/` 则只丢外观）。细节见 `docs/codex-style-plan.md` 第五节。

## 弹层布局

官方图片预览和对话框通过 Portal 挂在页面外层，固定定位不会继承主区的左侧留白。`styles/overlay-layout.css` 复用 `--ocw-gutter`，让图片预览、通用对话框及命令面板在右侧可用区域居中，并限制宽度。小窗口底部抽屉也从右侧内容区开始，通知宽度给侧栏留位。侧栏层级为 40，低于官方弹层的 50，因此图片和浮层不会再被侧栏遮住，模态遮罩仍覆盖整个窗口。

这些规则只在 `#ocw` 存在时生效，侧栏展开/收起和窗口缩放自动沿用相同的留白，无额外脚本或轮询。贴着按钮显示的菜单、下拉框和提示继续由官方定位，不额外平移。

验证方法和覆盖范围见 `tests/overlays/README.md`：图片预览使用保存的官方 2.0.30 页面验证实际交互；其余弹层使用官方源码样式和结构检查布局。

## 具体工作状态

`scripts/activity-model.js`、`scripts/activity-status.js` 和 `styles/activity-status.css` 将官方通用的“工作中”提示细化为当前阶段。它们通过同一条 `/api/event` 流观察已有事件，不另开连接、不轮询后台，也不修改官方发布脚本或虚拟列表。

- 明确收到思考/正文事件后显示“思考中”/“生成回答中”。
- 工具参数生成期间显示“准备工具调用”；收到执行事件后显示“执行命令中”“读取文件中”等；并行工具显示数量。
- 尚未收到下一段内容时显示“等待模型输出”，不将上游内部思考、准备请求和网络等待误判为同一种状态。悬停可查看解释。
- 已有重试、上下文压缩和授权事件也有对应提示。断线会清除旧阶段，避免把已失去连接的状态继续当作实时状态。
- 首次打开/刷新时复用官方首批消息响应恢复运行中的工具；新事件优先于较早请求返回的消息。不保存正文、工具参数或输出，不增加历史请求；最多保留 64 个会话的轻量状态。

这层只替换官方通用状态行中的文字，保留原高度和可访问的 `role="status"`。官方显示更具体的工具卡片、权限或错误提示时，仍采用官方的显示规则；不会强行额外插入一条状态行。缺少可判断的数据时保留官方提示。收到思考开始后，若上游一直不发后续状态，也无法仅凭前端知道它是否卡住。

侧栏里的会话行也吃同一份状态：`scripts/progress-grid.js` 复刻官方的「像素格」工作动画（`SessionProgressIndicatorV2`，36 帧 @30fps 的 16×16 APNG，经 `feFlood`+`feComposite` 用 `currentColor` 染色、5×5 方块 `clipPath` 裁边）。滤镜/裁剪/图片数据全文档只挂一份 defs，每行会话只放一个 `<use>` 引用；`codex-shell.js` 依据 `activity-model.js` 暴露的 `busy(sessionID)` 给行切换 `data-busy`，动画节点常驻、由 CSS 控制显隐。系统开启「减少动态效果」时退化为官方同款的静止中心点。

刷新网页即可加载这些文件，无需重启后台。移除这些活动状态文件即可停用此功能；保留 `codex-shell.js` 中原有的 SSE Accept 兼容补丁。

## 后台任务（MCP 委派）

图标栏只有三颗导航：**折叠 / 前台任务 / 后台任务**。新聊天留在侧栏里，搜索进各自栏位，模型顺序是后台任务的一部分（切到后台栏位后出现在侧栏头部）。

- **前台任务**：侧栏是工作区分组（含「新聊天」和搜索），右侧是官方界面。
- **后台任务**：侧栏换成 MCP 委派的会话列表（带自己的搜索框和空态），右侧是监视页。点任一后台任务、点新聊天、或发生真实跳转（快捷键/官方标签）都会回到前台——后台视图不会盖住导航。

判定依据是会话的 `metadata.origin === "opencode-delegate"`，不需要登记表；TUI 自己开的会话不会被误判。监视页每 2.5 秒读一次 `/api/session`、`/api/session/active` 和各会话最近 8 条消息：显示标题、调用方、模型、目录、最近一轮工具流程（`shell → edit`）、token/成本、完成状态，点卡片直接进会话，Esc 关闭。运行状态优先取 `/api/session/active`（权威），事件流负责即时熄灯——`activity-model.js` 的 `known()` 让「刚跑完」不必等下一次列表刷新。

## 模型顺序

切到后台栏位后，侧栏头部的叠层按钮（或 `?ocw=models`）打开免费模型排序页：列出 `/api/model` 里免费、已启用、支持工具的模型，上下移动调整顺序。连续调整会按操作顺序保存，显示「已保存」后，排第一的就是下一次 MCP 委派用的模型。顺序经网关的 `GET/POST /__opencode-web/models` 读写 `.state/model-ranking.json`（POST 带同源校验），MCP 读同一个文件（`src/models.mjs`）；还没排过时 DeepSeek V4.1 Flash 排第一。刷新按钮重新拉取目录，保存中保留当前顺序，服务休眠时给出提示而不是空列表。

本地验证：在 `tests/activity` 目录运行 `bun test ./model.test.mjs` 和 `bun run run.mjs`。浏览器检查使用已保留的 2.0.30 静态资源快照与官方事件夹具，独立端口 53128；不启动后台或调用真实模型。状态流的原字节、错误和取消继续传给官方客户端。首批消息兼容 `response.json()` 和 `response.text()`：当前 SDK 使用后者，因此会额外解析一次这批 JSON，读取元数据后立即释放，不再读取或复制响应流。

## 一些细节

- 路径就是你想要的那个 URL 路径去掉开头的 `/`，所以 `/_assets/foo.js` 对应 `webui/_assets/foo.js`，`/` 对应 `webui/index.html`。
- 覆盖层没提供的路径一律转发给后台服务；官方界面自己的 SPA 回落、404 行为都保留。
- 只要 `webui/index.html` 存在，它就会接管所有 HTML 响应（包括官方那套 SPA 回落），否则一个客户端路由会悄悄加载回官方页面。
- `sw.js` / `registerSW.js` 默认返回 404，除非你在覆盖层里自己放一个：Service Worker 的预缓存会让「换了 `_assets/` 里的文件但界面没变」这种坑反复出现。
- 覆盖层返回的文件不带官方的 CSP 头（官方那份 `script-src 'self' 'sha256-…'` 会挡掉内联脚本）。需要 CSP 就自己加。
- 想在浏览器里排查注入脚本：DevTools 里搜 `#ocw` 就是它建出来的那层；`document.documentElement.style.getPropertyValue("--ocw-gutter")` 是官方内容右移的宽度。
- 想看官方原始文件长什么样：`curl http://127.0.0.1:53123/_assets/xxx.js` 就是官方版本，或者直接去后台服务地址取。

## 官方资源清单

```bash
curl -s http://127.0.0.1:53123/ | grep -o -E '(src|href)="[^"]+"'
```
