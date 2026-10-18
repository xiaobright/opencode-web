# 按需启动验证

- `bun test ./backend.test.mjs ./cli.test.mjs`：服务启动合并、失败重试、探活/静态文件/API 不启动后台、启动接口的同源限制、代理保留鉴权和页面注入、默认模式兼容，以及真实 `src/start.mjs --lazy` 入口和重复启动。CLI 使用隔离目录和不存在的后台可执行文件，未调用真实服务。
- `bun run run.mjs`：浏览器先显示 OpenCode 标识与加载状态、后台未就绪时页面可见、多个页共用启动、保留会话深链接、失败后手动重试。使用模拟后台，不调用真实模型。
- `pwsh -NoProfile -File tray-policy.ps1`：从实际托盘脚本提取状态处理函数，确认待用模式始终显示图标且不探测后台，默认模式仍随后台退出。此项不创建真实托盘图标。

本次 4 项逻辑/CLI 测试（36 个断言）、2 项浏览器检查和托盘状态策略检查通过。加载画面截图和 CLI 临时目录保存在忽略的 `test-results/`、`.cache/`。

未自动设置开机自启；未通过真实托盘点击启动用户的 OpenCode 服务。实际启动服务仍复用原有的 `service.mjs`，执行 `opencode service start` 后等待健康注册。
