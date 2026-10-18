# opencode-web

给 opencode 后台服务配一个**本地网页入口**和一个**任务栏图标**。没有 Electron，没有第三方依赖，也不动 opencode 本身。

- 界面直接反代 opencode 自己那套 WebUI，**不带任何界面副本**，升级 opencode 自动跟着变。
- 想改界面就往 `webui/` 里放文件，按路径覆盖官方资源，放一个换一个。
- 默认图标跟着后台服务走；待用模式下图标和网页代理常驻，打开网页才启动后台。
- 点图标就打开 WebUI，同源反代 + 自动带密码，**免登录、免配置**。
- 手动启动脚本照样能用，服务/网页都会拉起。

## 结构

```
opencode-web/
├── src/
│   ├── start.mjs        无界面入口：起本地服务、拉起并探测 opencode、打开浏览器
│   ├── ui-server.mjs    反代 opencode（注入 Authorization），先查 webui/ 覆盖层
│   └── service.mjs      发现/启动 opencode 后台服务（读 service.json）
├── tray/tray.ps1        托盘图标：跟随服务、管理 WebUI、菜单
├── hook/opencode-web-tray.js   opencode 插件：服务被使用时拉起托盘
├── scripts/
│   ├── tray.mjs         启动托盘（优先 pwsh，回退 powershell.exe）
│   └── install-hook.mjs 安装/卸载上面那个插件
├── icons/opencode.ico   托盘图标：opencode 官方应用图标
├── webui/               覆盖层，默认空：放了什么就替换官方的什么（`styles/`、`scripts/` 是注入进去，不是替换）
├── start.vbs            日常用：托盘 + WebUI + 浏览器（无窗口）
├── start-lazy.vbs       自启用：只起托盘和网页代理，点击图标后启动后台
├── start.cmd            只起 WebUI（有控制台，方便看日志）
├── stop.cmd             停止托盘和 WebUI（加 --service 连后台服务一起停）
└── README.md
```

零依赖，只要本机有 `bun` 和 `opencode`。

## 用法

| 想干什么 | 怎么做 |
| --- | --- |
| 日常启动 | 双击 `start.vbs`（图标 + WebUI + 浏览器） |
| 待用／开机自启 | 双击 `start-lazy.vbs`，或 `bun run standby`（图标 + 代理，后台按需启动） |
| 只起代理待用 | `bun run start -- --lazy`（不打开浏览器，不启动后台） |
| 只看网页 | 双击 `start.cmd`，或 `bun run start` |
| 打开 WebUI | 点托盘图标，或右键菜单「打开 WebUI」 |
| 关闭图标 | 右键菜单「仅关闭图标」（服务和 Web 继续跑） |
| 全关掉 | 右键菜单「退出」（停 Web + 停后台服务） |
| 命令行停止 | `stop.cmd`，`stop.cmd --service` 连服务一起停 |
| 装上钩子 | `bun run install-hook`（卸载：`bun run uninstall-hook`） |
| 换个端口 | `bun run start -- --port 8080` |

重复启动不会起第二个进程：托盘靠互斥量保证单实例，本地服务靠 `/__opencode-web` 探活。

### 待用模式

`start-lazy.vbs` 只启动本地网页代理和托盘，启动时不打开浏览器、不探测或启动 OpenCode。点击托盘图标后，网页先显示 OpenCode 标识和“正在加载”，再发现已有服务或执行 `opencode service start`。就绪后自动进入官方网页，已有会话链接、查询参数和锚点保留。多个网页同时打开共用一次启动；失败时留在加载页，显示“重试”。

适合自启：按 `Win+R` 输入 `shell:startup`，把 `start-lazy.vbs` 的快捷方式放进去。代码已提供入口，未自动修改 Windows 自启设置。配置新模式前先退出已有的默认托盘／代理；重复启动会复用已有进程，不切换其模式。

待用模式的图标不会随 OpenCode 停止而消失，代理也继续运行，下次打开网页可再次拉起后台。加载画面仅用于后台尚未就绪的启动阶段，正常会话仍由官方页面显示。探活、图标及 API 请求都不会单独触发后台启动。默认 `start.vbs`／`start.cmd` 仍采用原来的立即启动方式。

本地验证见 [tests/startup/README.md](tests/startup/README.md)。

## 它怎么工作

**1. 找服务。** `src/service.mjs` 读 `~/.local/state/opencode/service*.json`（opencode 自己写的服务注册文件，含 url / pid / password），用 `/api/info` 探活；没有健康的就执行 `opencode service start` 并轮询等待。托盘里是同一套逻辑的 PowerShell 版。

**2. 起网页。** `src/ui-server.mjs` 在 `127.0.0.1:53123` 起本地 HTTP 服务：

- `/api/*`、`/auth/*`、`/openapi.json` → 转发到 opencode，并补上 `Authorization: Basic opencode:<密码>`；
- 其它路径 → 先看 `webui/` 覆盖层里有没有对应文件，有就直接给，没有就原样转给 opencode 后台；
- `/__opencode-web` → 探活标记。

界面是 opencode 后台**自己**提供的，本地服务只是把它转出来，所以永远和当前安装的 opencode 版本一致：升级 opencode 不用做任何事，也不存在「抽取出来的界面过期了」。

UI 和 API 同源，所以界面用 `location.origin` 直连后台，**不用登录**。代理每次请求都重新解析当前服务，opencode 重启、换端口都不用重启本进程。

**3. 默认图标跟着服务。** `tray/tray.ps1` 每 2 秒探一次服务：

- 探到 → 显示图标（提示里带版本和地址）；
- 连续失败 2 次（约 4 秒）→ 隐藏图标（服务重启时不会闪）；
- 连续失败 5 次（约 10 秒）→ 图标自己退出，WebUI 也一起收掉。

关闭窗口/图标不会影响 opencode 后台服务，除非你选「退出」。

传入 `--lazy`（PowerShell 参数 `-Lazy`）后，托盘只查看网页代理的状态，不直接探测后台，不随后台退出。此模式也会禁止启动时自动打开浏览器。`--no-service` 则保留“跟随已有后台”的原义，网页代理不会再绕过它主动启动后台。

**4. 钩子。** opencode 的插件 API **没有服务启动/停止的生命周期钩子**（hook 都挂在 tool / session / permission / shell / aisdk 这些域上）。但插件的 `setup` 会在**服务第一次为某个目录构建服务图时**执行 —— 也就是 TUI / 桌面端 / 网页端一开始用这个服务的那一刻。所以 `hook/opencode-web-tray.js` 就挂在这里：服务被用到 → 拉起托盘（已经在跑就跳过）。托盘再自己盯着服务，服务没了就退。这样就有「后台一启动它就常驻，随后台服务一起退出」的效果，还不需要开机自启。

`bun run install-hook` 会把插件写到全局插件目录 `~/.config/opencode/plugin/opencode-web-tray.js`（所有 opencode 客户端共用同一个服务，所以影响范围正好是全机）。删掉文件或 `bun run uninstall-hook` 即可还原。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_WEB_PORT` | 本地网页端口，默认 53123 |
| `OPENCODE_BIN` | opencode 可执行文件路径，默认 `%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`，找不到就用 PATH 里的 `opencode` |
| `OPENCODE_WEB_SHELL` | 跑托盘的 shell，默认优先 `pwsh`，回退 `powershell.exe` |

日志：托盘写在项目下 `.tray.log`，钩子写在 `%TEMP%\opencode-web-hook.log`。

## 换成自己的 WebUI

界面默认就是 opencode 官方那套，不用自带、不用抽取、不用同步。改法是往 `webui/` 里放文件，**按 URL 路径覆盖**：

| 放这个 | 效果 |
| --- | --- |
| `webui/index.html` | 换掉整个页面外壳（之后所有 HTML 响应都用它，包括客户端路由的深链接） |
| `webui/_assets/app-x1y2.js` | 只换这一个官方资源，其它仍来自官方 |
| `webui/style.css` | 加一个官方没有的文件 |
| `webui/styles/codex.css` | 只换外观：链进官方外壳，外壳还是官方的（见下） |
| `webui/scripts/codex-shell.js` | 只加骨架：插进官方外壳，外壳还是官方的（见下） |

放一个换一个，没放的照旧走官方 —— 想全换就把自己的整套产物摊进 `webui/`。覆盖层文件每次请求现查、不带缓存，改完刷新即可，**不用重启**。细节写在 `webui/README.md`。

`webui/styles/*.css` 和 `webui/scripts/*.js` 是另外两种用法：官方外壳的资源名带内容哈希，复制一份外壳会在 opencode 升级后指向不存在的文件，所以它们都**不落副本**，而是每次请求现取官方 HTML、改写后再发 —— `.css` 链进 `</head>` 前，`.js` 插在 `</body>` 前（经典脚本，先于官方的 deferred bundle 执行）。外壳因此永远来自当前安装的版本。

现在里面有两个，合起来就是 Codex 那套版式：

- `webui/styles/codex.css` —— 外观（平白实体面、近单色强调、细边、系统字体、去掉外壳外缝），图标栏/侧栏的长相，草稿屏那行「你想让我们在 X 中构建什么？」。
- `webui/scripts/codex-shell.js` —— 骨架：建出左边那条图标栏和「工作区 → 会话」侧栏，官方主区整体右移让位；列表读 `/api/project` 和 `/api/session`，点会话用 `history.pushState` + `popstate` 驱动官方路由；「新聊天」借官方 `mod+t` 键位开草稿（**点了不落库**，真正发送时官方才建会话），冷启动落 `/` 时也转进草稿；图标栏上一颗独立按钮切明暗。**对话、消息渲染、工具卡片、diff、权限、终端全部仍是官方的**，这里一个都没碰。
- 另外，脚本顶部还有个**必要补丁**：给 `/api/event` 补上 `Accept: text/event-stream`。本机 Chrome 对 SSE 响应的 `Accept` 匹配很窄，没这个补丁官方事件流永远连不上，模型列表是空的、发送会被拦、首页停在"加载中"。

另外，`webui/scripts/activity-model.js`、`activity-status.js` 和 `webui/styles/activity-status.css` 会根据已有事件，把通用“工作中”细化为思考、生成回答、工具执行或等待模型输出等状态。它不新增后台请求，也不改变时间线高度；[显示规则与验证方式](webui/README.md#具体工作状态)见覆盖层说明。

想恢复官方界面：把 `webui/styles/` 和 `webui/scripts/` 移出去，刷新即可，不用重启。注意**移出 `scripts/` 会一并失去那个 `Accept` 补丁**，界面会退化成用不了（只移 `styles/` 则只丢外观）。方案与取舍记在 `docs/codex-style-plan.md`。

## 注意

- **不要**去 patch opencode 官方二进制换界面：官方版本会把界面编译进可执行文件，改了升级就没了；这个项目不动它，界面直接从后台服务转发。
- 托盘图标用的是 opencode 官方应用图标（和桌面端、浏览器标签页同一张图，深色圆角方块 + 白色方框），存在 `icons/opencode.ico`。**不**从 `opencode.exe` 里取图标：那个二进制挂的是 Bun 的图标，跟 opencode 没关系。
- `sw.js` / `registerSW.js` 默认返回 404（除非你在 `webui/` 里自己放一个）：避免 Service Worker 预缓存住官方资源，导致覆盖层文件不生效。
- 托盘用的是 Windows 自带 PowerShell（5.1 也能跑，脚本带 UTF-8 BOM），不依赖 Electron 或任何 npm 包。
- `stop.cmd` 不会停 opencode 后台服务（TUI 和其它客户端还在用），需要时加 `--service`。
