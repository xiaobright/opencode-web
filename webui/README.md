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
- 目前只有一个：`webui/styles/codex.css`（Codex 皮肤：观感 + 图标栏/侧栏的骨架样式 + 草稿屏那行提问 + 开草稿时的过渡遮罩）。移出这个目录就恢复官方外观，不用重启。

## 换个骨架：`webui/scripts/`

放进去的 `.js` 会被插进**官方外壳的 `</body>` 前**，同样是每次请求现取官方 HTML 再改写，外壳本身仍来自当前安装的 opencode。

样式表能改的只有长相。链进来的脚本能做样式做不到的事：往页面上**加真实的 DOM**（图标栏、按工作区分组的会话侧栏），并把官方内容整体右移让位。

- **经典脚本**（不是 `module`），而且在 `</body>` 前，所以它先于 Vite 打进 `_assets/` 的 deferred module 执行 —— 可以在官方界面挂载之前就把状态准备好。
- **按文件名排序**，和样式表一致。
- 官方外壳的 CSP 是 `script-src 'self' 'sha256-…'`，同源外链脚本被 `'self'` 放行，不需要改 CSP。
- 官方给界面留的钩子（`data-slot="titlebar-v2"`、`data-component="new-session-wordmark"` 等）都是稳定的选择器，脚本靠它们定位，不靠结构猜。
- 目前只有一个：`webui/scripts/codex-shell.js`。它做三件核心的事 —— 建 rail 和侧栏的 DOM（从 `/api/project` + `/api/session` 读列表，点会话时用 `history.pushState` + `popstate` 驱动官方路由）；**开一张官方草稿**（借 `mod+t` 键位触发官方的 `tab.new`，所以点「新聊天」不落库；顺带冷启动落 `/` 时转进草稿、草稿屏补一行 Codex 式提问、图标栏上加一颗明暗切换）；以及给事件流补上 `Accept: text/event-stream`（没有它官方界面用不了，见下）。**对话、消息渲染、工具卡片、diff、权限、终端全部仍是官方的**。

> ⚠️ 这个脚本同时是一个**必要的兼容补丁**：官方 `request-queue.ts` 对 `/api/event` 直通时那个 `Request` 没有 `Accept` 头，本机 Chrome 只在 `Accept` 恰好是 `text/event-stream` 时才把该 MIME 的响应交给 `fetch`，于是事件流永远连不上 → 模型列表空、发送被拦、首页停在"加载中"。脚本顶部包了一层 `window.fetch` 专门给这个路径补 `Accept`。**所以移出 `webui/scripts/` 不只是丢外观，界面会退化成用不了**（只移 `webui/styles/` 则只丢外观）。细节见 `docs/codex-style-plan.md` 第五节。

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
