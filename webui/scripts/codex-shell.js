/* Codex 外壳 v1 —— 由 webui/scripts/ 注入官方页面
   ---------------------------------------------------------------------------
   这个脚本不替换官方界面，它围绕官方界面**补**上 Codex 那个「图标栏 + 工作区/会话侧栏」。

   为什么不自己写一份 index.html：官方外壳里引用的资源名带内容哈希，写死一份副本，
   opencode 一升级就会指向不存在的文件、直接白屏。这里走的是同一条注入通道（服务端每次
   导航请求都去拉官方 HTML、改写、再吐出去），所以外壳永远来自当前安装版本。

   它不做的事：对话、消息渲染、工具、diff、权限、终端、路由 —— 全部是官方在跑。
   它只做三件：① 建 rail 和侧栏的 DOM；② 从 /api/project 和 /api/session 读列表；
                ③ 点击会话时驱动官方路由（pushState + popstate），并把官方内容右移。
   --------------------------------------------------------------------------- */

;(function () {
  "use strict"

  if (window.__ocwShell) return
  window.__ocwShell = true

  /* ── 补丁：给事件流请求补上 Accept: text/event-stream ─────────────────────────
     官方订阅事件流走的是 request-queue.ts:125 的 `base(request)` —— 直接把一个 Request
     交给 fetch，Request 上没有 Accept 头，浏览器给补的是通配值。而本机 Chrome 155 只在
     请求 Accept **恰好等于** text/event-stream 时才把 text/event-stream 的响应交给 fetch，
     否则 fetch 永不 resolve（静默挂到调用方超时）。实测（第一列是请求 Accept 头）：
       通配                + text/event-stream 响应 → 卡死
       text/event-stream,通配                        → 卡死
       text/event-stream                             → 7ms 正常
       通配                + text/plain 流式响应      → 6ms 正常（所以只和这个 MIME 有关）

     后果远不止"少个实时刷新"：事件流连不上 → 连接状态永远到不了 connected →
     bootstrapInstance 被 `if (!connected()) return` 挡掉 → data.location.sync() 从不执行 →
     provider/model 目录为空 → providers.ready() 为 false → composer 的 model.loading 恒为真 →
     模型选择器被隐藏、选择为空、发送被拦；首页也停在"加载中"。

     所以这里在最早的时机（经典脚本，先于官方的延迟 module 包）只给 /api/event 换掉 Accept，
     其余请求一个字节都不动。request-queue 在创建时就抓住了 globalThis.fetch，因此能拦住它。
     --------------------------------------------------------------------------- */
  ;(function patchEventAccept() {
    var originalFetch = window.fetch
    if (typeof originalFetch !== "function") return

    var EVENT_PATH = "/api/event"

    function isEventRequest(resource) {
      try {
        return new URL(resource, location.href).pathname === EVENT_PATH
      } catch (error) {
        return false
      }
    }

    function withAccept(headers) {
      var next = new Headers(headers)
      next.set("accept", "text/event-stream")
      return next
    }

    window.fetch = function (input, init) {
      try {
        if (input instanceof Request && isEventRequest(input.url))
          // 从原 Request 重建：headers 被替换，method / signal / mode / credentials 全部保留。
          return originalFetch.call(this, new Request(input, { headers: withAccept(input.headers) }), init)

        if (typeof input === "string" || input instanceof URL)
          if (isEventRequest(input))
            return originalFetch.call(this, input, Object.assign({}, init, { headers: withAccept(init && init.headers) }))
      } catch (error) {
        // 补丁自身出问题也绝不能让请求发不出去，落到下面原样透传。
      }

      return originalFetch.call(this, input, init)
    }
  })()

  var RAIL = 52
  var SIDEBAR = 260
  var COLLAPSE_KEY = "opencode-web.codex-shell.collapsed"

  /* ── 和官方 @opencode/util/encode 的 base64Encode 一致：UTF-8 → base64url ── */
  function b64url(value) {
    var bytes = new TextEncoder().encode(value)
    var binary = ""
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
  }

  // 官方路由里的 serverKey 就是 base64url(serverUrl)，而 web 构建里 serverUrl 就是 location.origin。
  // 当前 URL 里已经有那一段时优先复用它，省得猜。
  var cachedKey = ""
  function keySegment() {
    var match = /^\/server\/([^/]+)\//.exec(location.pathname)
    if (match) return (cachedKey = match[1])
    if (!cachedKey) cachedKey = b64url(location.origin)
    return cachedKey
  }

  /* ── 官方内容让位：外壳根节点上带官方写的行内变量，样式表拿它当锚点（见 codex.css） ── */
  function collapsed() {
    return document.documentElement.hasAttribute("data-ocw-collapsed")
  }

  function setGutter() {
    document.documentElement.style.setProperty("--ocw-gutter", (RAIL + (collapsed() ? 0 : SIDEBAR)) + "px")
  }

  /* ── 图标：手写的极简描边图形 ── */
  var ICONS = {
    home: '<path d="M3.2 10.4 12 3.2l8.8 7.2"/><path d="M5.6 9.6V20.4h12.8V9.6"/>',
    panel: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.2"/><path d="M9.4 4.6v14.8"/>',
    search: '<circle cx="11" cy="11" r="6.4"/><path d="m15.8 15.8 3.9 3.9"/>',
    // 齿轮（不是太阳）：左下角那个位置对应的是「设置」
    settings:
      '<circle cx="12" cy="12" r="3.1"/><path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.9 1.9 0 0 1-3.8 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.9 1.9 0 0 1 0-3.8h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.9 1.9 0 0 1 3.8 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.9 1.9 0 0 1 0 3.8h-.1a1.5 1.5 0 0 0-1.4.9z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/>',
    moon: '<path d="M20.4 13.6A8.6 8.6 0 1 1 10.4 3.6a6.8 6.8 0 0 0 10 10z"/>',
    compose: '<path d="M4.2 19.8h3.6L18.4 9.2a1.9 1.9 0 0 0-2.7-2.7L5.1 17.1z"/><path d="M14.6 7.4 17 9.8"/>',
    plus: '<path d="M12 5.6v12.8M5.6 12h12.8"/>',
    folder: '<path d="M3.4 8.2a2 2 0 0 1 2-2h3l1.6 2h7.6a2 2 0 0 1 2 2v6.6a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z"/>',
    chevron: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
    // 心跳线：后台任务监视（MCP 委派出去的会话）
    pulse: '<path d="M2.8 12h3.3l2.2-5.6 4.2 11.2 2.3-5.6h6.4"/>',
    // 叠层：免费模型的排序
    layers: '<path d="m12 3.6 8.4 4.6-8.4 4.6L3.6 8.2z"/><path d="m3.6 12.4 8.4 4.6 8.4-4.6"/><path d="m3.6 16.6 8.4 4.6 8.4-4.6"/>',
    up: '<path d="m6 14.5 6-6.5 6 6.5"/>',
    down: '<path d="m6 9.5 6 6.5 6-6.5"/>',
    refresh: '<path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4"/><path d="M19.6 4.6V10H14"/>',
    rows: '<path d="M4 6h.01M4 12h.01M4 18h.01M8.5 6H20M8.5 12H20M8.5 18H20"/>',
    // 行尾的三点菜单（会话 / 工作区）
    more: '<circle cx="5.2" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.8" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
  }

  function icon(name, size) {
    return (
      '<svg viewBox="0 0 24 24" width="' +
      (size || 18) +
      '" height="' +
      (size || 18) +
      '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[name] +
      "</svg>"
    )
  }

  function el(tag, className, html) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (html !== undefined) node.innerHTML = html
    return node
  }

  var ui = null
  var state = {
    groups: [],
    background: [],
    activeIds: new Set(),
    scope: "foreground",
    loaded: false,
    loading: false,
    error: "",
    workspace: "",
  }
  var collapsedGroups = new Set() // 用户手动折起来的工作区
  var showAllGroups = new Set() // 用户手动展开到底的工作区
  var LIMIT = 8 // 每个工作区默认露几条，其余收在「还有 N 个」后面

  // MCP 委派的会话在创建时写入 metadata.origin（见 mcp/tools.mjs）。侧栏据此把
  // 后台任务从工作区分组里摘出来单独放，不让它们散落在各项目下面。
  var BACKGROUND_ORIGIN = "opencode-delegate"

  function isBackground(session) {
    return Boolean(session && session.metadata && session.metadata.origin === BACKGROUND_ORIGIN)
  }

  /* ── 建壳 ── */
  function build() {
    var root = el("div", "ocw")
    root.id = "ocw"

    var rail = el("nav", "ocw-rail")
    rail.setAttribute("aria-label", "主导航")

    var top = el("div", "ocw-rail-group")
    var bottom = el("div", "ocw-rail-group ocw-rail-bottom")

    // 顶部三颗是导航本身：折叠、前台任务、后台任务。新聊天留在侧栏里，
    // 搜索进各自栏位，模型顺序是后台任务的一部分（见侧栏头部）。
    top.appendChild(railButton("panel", "折叠 / 展开侧栏", "panel", toggleSidebar))
    top.appendChild(railButton("rows", "前台任务", "foreground", function () { setScope("foreground") }))
    var backgroundButton = railButton("pulse", "后台任务", "background", function () { setScope("background") })
    var backgroundBadge = el("span", "ocw-rail-badge")
    backgroundBadge.hidden = true
    backgroundButton.appendChild(backgroundBadge)
    top.appendChild(backgroundButton)
    bottom.appendChild(railButton("sun", "切换明暗主题", "theme", toggleTheme))
    bottom.appendChild(railButton("settings", "设置", "settings", function () { go("/settings") }))

    rail.appendChild(top)
    rail.appendChild(bottom)

    var sidebar = el("aside", "ocw-sidebar")
    sidebar.id = "ocw-sidebar"

    var head = el("div", "ocw-sidebar-head")
    var title = el("span", "ocw-sidebar-title")
    title.textContent = "opencode"
    var headActions = el("div", "ocw-sidebar-actions")
    // 模型顺序只在后台任务栏位里有意义：它是 MCP 委派用哪个模型的决定项。
    var modelsButton = iconButton("layers", "模型顺序", openModels)
    modelsButton.hidden = true
    headActions.appendChild(modelsButton)
    headActions.appendChild(iconButton("search", "搜索", openSearch))
    head.appendChild(title)
    head.appendChild(headActions)

    var newChat = el("button", "ocw-new")
    newChat.type = "button"
    newChat.innerHTML = icon("compose", 17) + "<span>新聊天</span>"
    newChat.addEventListener("click", function () {
      if (state.scope !== "foreground") setScope("foreground")
      openDraft("")
    })

    var filter = el("input", "ocw-filter")
    filter.type = "search"
    filter.placeholder = "搜索会话…"
    filter.hidden = true
    filter.addEventListener("input", function () { renderList(query()) })
    filter.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeSearch()
    })

    var list = el("div", "ocw-list")
    list.id = "ocw-list"

    sidebar.appendChild(head)
    sidebar.appendChild(newChat)
    sidebar.appendChild(filter)
    sidebar.appendChild(list)

    root.appendChild(rail)
    root.appendChild(sidebar)
    ;(document.body || document.documentElement).appendChild(root)

    ui = {
      root: root,
      rail: rail,
      list: list,
      filter: filter,
      newChat: newChat,
      title: title,
      modelsButton: modelsButton,
    }
    setGutter()
    return ui
  }

  function railButton(name, label, id, onClick) {
    var button = el("button", "ocw-rail-btn", icon(name))
    button.type = "button"
    button.title = label
    button.setAttribute("aria-label", label)
    button.setAttribute("data-rail", id)
    button.addEventListener("click", onClick)
    return button
  }

  function iconButton(name, label, onClick) {
    var button = el("button", "ocw-icon-btn", icon(name, 16))
    button.type = "button"
    button.title = label
    button.setAttribute("aria-label", label)
    if (onClick) button.addEventListener("click", onClick)
    return button
  }

  /* ── 侧栏折叠与搜索 ── */
  function toggleSidebar() {
    var now = document.documentElement.toggleAttribute("data-ocw-collapsed")
    try {
      localStorage.setItem(COLLAPSE_KEY, now ? "1" : "0")
    } catch (error) {
      void error
    }
    setGutter()
  }

  function query() {
    return ui && !ui.filter.hidden ? ui.filter.value.trim().toLowerCase() : ""
  }

  function openSearch() {
    if (collapsed()) toggleSidebar()
    ui.filter.hidden = false
    ui.filter.focus()
    ui.filter.select()
  }

  function closeSearch() {
    ui.filter.hidden = true
    ui.filter.value = ""
    renderList("")
  }

  /* ── 导航：驱动官方路由（@solidjs/router 的 history 集成监听 popstate） ── */
  function go(url) {
    if (location.pathname + location.search === url) return void syncActive()

    history.pushState(null, "", url)
    dispatchEvent(new PopStateEvent("popstate"))
    syncActive()
    void refresh()
  }

  /* ── 数据 ── */
  function basename(path) {
    var parts = String(path || "").split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || String(path || "")
  }

  function updated(session) {
    var time = session && session.time
    return (time && (time.updated || time.created || time.idle || time.viewed)) || 0
  }

  function group(projects, sessions) {
    var byProject = new Map()
    for (var i = 0; i < sessions.length; i++) {
      var session = sessions[i]
      // 子会话（子代理）不进侧栏，否则一个任务会淹掉整个列表
      if (!session || session.parentID) continue
      if (session.time && session.time.archived) continue
      if (!byProject.has(session.projectID)) byProject.set(session.projectID, [])
      byProject.get(session.projectID).push(session)
    }

    var groups = []
    for (var j = 0; j < projects.length; j++) {
      var project = projects[j]
      var list = byProject.get(project.id)
      if (!list || !list.length) continue
      list.sort(function (a, b) {
        return updated(b) - updated(a)
      })
      groups.push({
        id: project.id,
        name: project.name || basename(project.canonical),
        path: project.canonical,
        sessions: list,
        at: updated(list[0]),
      })
    }

    groups.sort(function (a, b) {
      return b.at - a.at
    })

    return groups
  }

  async function refresh(force) {
    if (state.loading) return
    state.loading = true
    try {
      var responses = await Promise.all([
        fetch("/api/project", { headers: { accept: "application/json" } }),
        window.__ocwBackground.refresh(force),
      ])
      if (!responses[0].ok) throw new Error("HTTP " + responses[0].status)
      var projects = await responses[0].json()
      var data = responses[1]
      state.activeIds = new Set(Object.keys(data.active))
      state.background = data.items
      state.backgroundNext = data.next
      state.groups = group(Array.isArray(projects) ? projects : [], data.all.filter(function (session) { return !isBackground(session) }))
      state.error = ""
      state.loaded = true
    } catch (error) {
      state.error = String((error && error.message) || error)
    } finally {
      state.loading = false
      renderList(query())
      syncActive()
      forwardHomeOnce()
    }
  }

  /* 冷启动落在官方首页（/）时，直接开一张草稿 —— 也就是 Codex 那种「居中品牌标 +
     完整 composer」的屏。只做一次：万一开不出来（比如一条会话都没有），就老老实实
     把官方首页留给用户，避免和官方的 <Navigate href="/" /> 来回打转。 */
  var forwardedHome = false

  function forwardHomeOnce() {
    if (forwardedHome) return
    if (!state.loaded || !state.groups.length) return
    if (state.scope === "background") return
    if (location.pathname !== "/") return
    forwardedHome = true
    openDraft("")
  }

  /* ── 新建会话：走官方的草稿，点击不落库 ──
     /new-session 的 DraftRoute 要求 tabs store 里已经有对应 draftID 的草稿标签，直接改 URL 进不去
     （会被 <Navigate href="/" /> 弹回首页）。所以这里合成官方的 mod+t 键位，让官方自己走
     tabs.newDraft()：点「新聊天」不会多出空会话，只有真正发送那一刻官方才 POST /api/session。

     官方那个 handler 按当前路由决定草稿落在哪个目录：会话路由用它所在的工作区，首页 / 设置则用
     layout.home.selection()（这个 web 构建里常常是空的，等于静默失败）。所以目标工作区和当前
     路由不一致时，先切到那个工作区最近的会话，等它挂载好再按键。 */
  function activeDirectory() {
    var id = currentSessionId()
    for (var i = 0; i < state.groups.length; i++) {
      for (var j = 0; j < state.groups[i].sessions.length; j++) {
        if (state.groups[i].sessions[j].id === id) return state.groups[i].path
      }
    }
    // 没在会话里就落在最近用过的那个工作区
    return state.groups.length ? state.groups[0].path : ""
  }

  function routeDirectory() {
    var id = currentSessionId()
    if (!id) return ""
    for (var i = 0; i < state.groups.length; i++) {
      for (var j = 0; j < state.groups[i].sessions.length; j++) {
        if (state.groups[i].sessions[j].id === id) return state.groups[i].path
      }
    }
    return ""
  }

  function sessionsOf(path) {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].path === path) return state.groups[i].sessions
    }
    return []
  }

  function sessionUrl(id) {
    return "/server/" + keySegment() + "/session/" + id
  }

  function isDraftRoute() {
    return /^\/new-session/.test(location.pathname)
  }

  function setDrafting(on) {
    document.documentElement.toggleAttribute("data-ocw-drafting", !!on)
    if (on)
      // 别把界面永久挡住：兜底解掉（真进了草稿屏也会在 syncActive 里立刻解掉）
      setTimeout(function () {
        setDrafting(false)
      }, 3000)
  }

  function pressNewTabKey() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    )
  }

  var draftTicks = 0

  function openDraft(directory) {
    var want = directory || activeDirectory()

    // 已经就在这个工作区的草稿屏上 → 什么都不用做
    if (isDraftRoute() && (!want || want === state.workspace)) {
      draftTicks = 0
      setDrafting(false)
      if (ui) ui.newChat.classList.remove("is-busy")
      return
    }
    if (draftTicks >= 6) {
      draftTicks = 0
      setDrafting(false)
      if (ui) ui.newChat.classList.remove("is-busy")
      return
    }
    draftTicks++
    setDrafting(true)
    if (ui) ui.newChat.classList.add("is-busy")

    // 目标工作区和当前路由不一致（在别的会话里、在官方首页、或在别的工作区的草稿上）：
    // 先切到那个工作区最近的会话，让官方路由把目录带进去，再按键。
    if (want && routeDirectory() !== want) {
      var target = sessionsOf(want)[0]
      if (target) {
        go(sessionUrl(target.id))
        setTimeout(function () {
          openDraft(want)
        }, 450)
        return
      }
    }

    state.workspace = want || state.workspace
    pressNewTabKey()
    setTimeout(function () {
      openDraft(want)
    }, 450)
  }

  /* ── 明暗主题：拨官方那个存储键，再补一个 storage 事件 ──
     官方把颜色方案存在 localStorage 的 opencode-color-scheme（light | dark | system），
     由主题 store 驱动 applyTheme（CSS 变量 + data-theme + data-color-scheme）。
     那个 store 监听的是 window 的 storage 事件，而同文档里写 localStorage 并不会触发它，
     所以这里手动补一个 StorageEvent，让官方自己走完整套应用流程（设置页里也会同步显示）。 */
  function currentScheme() {
    var applied = document.documentElement.getAttribute("data-color-scheme")
    if (applied === "light" || applied === "dark") return applied
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }

  function toggleTheme() {
    var next = currentScheme() === "dark" ? "light" : "dark"
    try {
      localStorage.setItem("opencode-color-scheme", next)
    } catch (error) {
      void error
    }
    try {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "opencode-color-scheme", newValue: next, storageArea: localStorage }),
      )
    } catch (error) {
      void error
    }
    syncThemeIcon()
    setTimeout(syncThemeIcon, 120)
  }

  var themeIconMode = ""

  function syncThemeIcon() {
    var button = ui && ui.rail.querySelector('[data-rail="theme"]')
    if (!button) return
    var dark = currentScheme() === "dark"
    var mode = dark ? "dark" : "light"
    if (mode === themeIconMode) return // 轮询每 350ms 叫一次，别反复重画
    themeIconMode = mode
    button.innerHTML = icon(dark ? "moon" : "sun")
    button.title = dark ? "切换到浅色" : "切换到暗色"
    button.setAttribute("aria-label", button.title)
  }

  /* ── 草稿屏那行提问（对齐 Codex：居中品牌标 + 你想让我们在 X 中构建什么？） ── */
  var hero = null
  var heroText = ""

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    })
  }

  function activeWorkspaceName() {
    var path = routeDirectory() || state.workspace || activeDirectory()
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].path === path) return state.groups[i].name
    }
    return ""
  }

  function syncHero() {
    var wordmark = document.querySelector(
      '[data-component="new-session"] [data-component="new-session-wordmark"]',
    )
    if (!wordmark) {
      hero = null
      heroText = ""
      return
    }
    if (!hero || !hero.isConnected) {
      hero = el("div", "ocw-hero")
      wordmark.parentElement.insertBefore(hero, wordmark.nextSibling)
      heroText = ""
    }
    var name = activeWorkspaceName()
    var next = name
      ? "你想让我们在 <code>" + escapeHtml(name) + "</code> 中构建什么？"
      : "你想让我们构建什么？"
    if (next !== heroText) {
      heroText = next
      hero.innerHTML = next
    }
  }

  /* ── 渲染 ── */
  function currentSessionId() {
    var match = /\/session\/([^/?#]+)/.exec(location.pathname)
    return match ? match[1] : ""
  }

  /* ── 两个栏位：前台任务 / 后台任务 ────────────────────────────────────
     切换是整页语义：侧栏换成对应列表，右侧换成对应视图。后台视图不会
     盖住导航——任何一次真正的会话跳转都先回到前台。 */
  function setScope(scope) {
    var next = scope === "background" ? "background" : "foreground"
    if (state.scope === next) {
      if (next === "background") openMonitor()
      return
    }
    state.scope = next
    state.scopeSince = Date.now()
    document.documentElement.setAttribute("data-ocw-scope", next)
    ui.title.textContent = next === "background" ? "后台任务" : "opencode"
    ui.modelsButton.hidden = next !== "background"
    ui.newChat.hidden = next === "background"
    ui.filter.placeholder = next === "background" ? "搜索后台任务…" : "搜索会话…"
    ui.filter.hidden = true
    ui.filter.value = ""
    setRailActive("foreground", next === "foreground")
    setRailActive("background", next === "background")
    if (next === "background") openMonitor()
    else {
      closeMonitor()
      closeModels()
    }
    renderList("")
  }

  function renderList(filterText) {
    var list = ui.list
    list.textContent = ""

    if (!state.loaded) {
      list.appendChild(message(state.error ? "列表读取失败：" + state.error : "正在读取会话…"))
      return
    }

    var activeId = currentSessionId()

    if (state.scope === "background") {
      renderBackgroundLane(list, filterText, activeId)
      return
    }

    if (!state.groups.length) {
      list.appendChild(message(state.error ? "列表读取失败：" + state.error : "还没有会话"))
      return
    }

    var shown = 0
    var hidden = 0

    for (var i = 0; i < state.groups.length; i++) {
      var item = state.groups[i]
      var sessions = item.sessions

      // 隐藏只作用于浏览：搜索时仍然能翻到，否则“藏起来”会变成“找不到”。
      if (!filterText && hiddenGroups.has(item.id)) {
        hidden++
        continue
      }

      if (filterText) {
        sessions = sessions.filter(function (session) {
          return String(session.title || "").toLowerCase().indexOf(filterText) !== -1
        })
        if (!sessions.length) continue
      }

      var hasActive = sessions.some(function (session) {
        return session.id === activeId
      })
      // 默认全部展开（参考图里每个工作区都摊开），折叠是用户手动动作；搜索时一律展开
      var isCollapsed = !filterText && collapsedGroups.has(item.id)

      var section = el("section", "ocw-group")
      section.setAttribute("data-group-id", item.id)
      if (isCollapsed) section.classList.add("is-collapsed")
      if (hasActive) section.classList.add("has-active")

      var row = el("div", "ocw-group-row")

      var head = el("button", "ocw-group-head")
      head.type = "button"
      head.title = item.path
      head.innerHTML =
        '<span class="ocw-caret">' + icon("chevron", 13) + "</span>" +
        '<span class="ocw-group-icon">' + icon("folder", 15) + "</span>" +
        '<span class="ocw-group-name"></span>'
      head.querySelector(".ocw-group-name").textContent = item.name
      head.addEventListener("click", function (id) {
        return function () {
          if (collapsedGroups.has(id)) collapsedGroups.delete(id)
          else collapsedGroups.add(id)
          renderList(query())
        }
      }(item.id))

      // 每个工作区自带一个「在这里新建会话」。做成 head 的兄弟节点而不是嵌进去，
      // 免得出现按钮套按钮这种非法结构。
      var add = el("button", "ocw-group-new", icon("plus", 14))
      add.type = "button"
      add.title = "在 " + item.name + " 里新建会话"
      add.setAttribute("aria-label", add.title)
      add.addEventListener("click", function (path) {
        return function () {
          openDraft(path)
        }
      }(item.path))

      row.appendChild(head)
      row.appendChild(add)

      var groupMenu = el("button", "ocw-group-menu", icon("more", 16))
      groupMenu.type = "button"
      groupMenu.title = item.name + " 的操作"
      groupMenu.setAttribute("aria-label", groupMenu.title)
      groupMenu.addEventListener("click", function (button, group) {
        return function (event) {
          event.preventDefault()
          event.stopPropagation()
          openGroupMenu(button, group)
        }
      }(groupMenu, item))
      row.appendChild(groupMenu)

      row.addEventListener("contextmenu", function (element, group) {
        return function (event) {
          event.preventDefault()
          openGroupMenu(element, group)
        }
      }(row, item))

      section.appendChild(row)

      if (!isCollapsed) {
        var visible = filterText || showAllGroups.has(item.id) ? sessions : sessions.slice(0, LIMIT)

        for (var j = 0; j < visible.length; j++) {
          section.appendChild(sessionRow(visible[j], activeId))
          shown++
        }

        if (visible.length < sessions.length) section.appendChild(moreRow(item.id, sessions.length - visible.length))
      }

      list.appendChild(section)
    }

    if (!shown && !hidden) list.appendChild(message(filterText ? "没有匹配的会话" : "还没有会话"))
    if (hidden) list.appendChild(hiddenRow(hidden))

    syncBusy()
  }

  function hiddenRow(count) {
    var row = el("button", "ocw-more ocw-unhide")
    row.type = "button"
    row.textContent = "显示 " + count + " 个已隐藏的工作区"
    row.addEventListener("click", function () { showHiddenGroups() })
    return row
  }

  /* 后台任务栏位：MCP 委派出去的会话，按调用方/模型标注，运行中复用行左侧的像素格。 */
  function renderBackgroundLane(list, filterText, activeId) {
    var sessions = state.background
    if (state.error) list.appendChild(message("读取失败，保留上次结果：" + state.error))
    if (filterText) {
      var needle = String(filterText).toLowerCase()
      sessions = sessions.filter(function (session) {
        return String(session.title || "").toLowerCase().indexOf(needle) !== -1
      })
    }

    if (!sessions.length) {
      if (!state.error) list.appendChild(message(filterText ? "没有匹配的后台任务" : "还没有后台任务。用 MCP 委派后，这里会按会话列出。"))
      if (state.backgroundNext) list.appendChild(historyButton())
      return
    }

    for (var i = 0; i < sessions.length; i++) list.appendChild(sessionRow(sessions[i], activeId, { background: true }))
    if (state.backgroundNext) list.appendChild(historyButton())
    syncBusy()
  }

  function moreRow(groupId, remaining) {
    var row = el("button", "ocw-more")
    row.type = "button"
    row.textContent = "还有 " + remaining + " 个会话"
    row.addEventListener("click", function () {
      showAllGroups.add(groupId)
      renderList(query())
    })
    return row
  }

  function sessionRow(session, activeId, options) {
    var background = options && options.background
    // 行本身是按钮（点击进会话），菜单按钮不能嵌进去，所以外面再包一层定位容器。
    var wrap = el("div", "ocw-session-wrap")
    wrap.setAttribute("data-session-id", session.id)
    var row = el("button", "ocw-session")
    row.type = "button"
    row.setAttribute("data-id", session.id)
    if (background) {
      row.setAttribute("data-background", "true")
      row.classList.add("is-background")
    }
    if (session.id === activeId) row.classList.add("is-active")

    // 会话名左边留的 33px 空槽：会话在工作时这里放官方那颗像素格动画（见 progress-grid.js）。
    // 节点常驻、由 data-busy 控制显隐，免得每次状态翻转都重建 DOM 打断动画。
    var status = el("span", "ocw-session-status")
    if (window.__ocwProgressGrid) status.appendChild(window.__ocwProgressGrid(14))
    row.appendChild(status)

    var label = el("span", "ocw-session-title")
    label.textContent = session.title || "未命名会话"
    row.appendChild(label)

    // 后台任务多一行来源标签：谁派的、用的哪个模型。工作区里的会话保持单行。
    var caller = session.metadata && session.metadata.caller
    var model = session.model && (session.model.id || session.model)
    if (background && (caller || model)) {
      var sub = el("span", "ocw-session-sub")
      sub.textContent = [caller || "mcp", model || ""].filter(Boolean).join(" · ")
      row.appendChild(sub)
    }

    var details = [session.title || session.id]
    if (caller) details.push("调用方：" + caller)
    if (model) details.push("模型：" + model)
    if (session.metadata && session.metadata.taskId) details.push("任务：" + session.metadata.taskId)
    if (session.location && session.location.directory) details.push("目录：" + session.location.directory)
    row.title = details.join("\n")

    row.addEventListener("click", function () {
      // 打开会话永远回到前台：后台视图不留在右边。
      if (state.scope !== "foreground") setScope("foreground")
      go("/server/" + keySegment() + "/session/" + session.id)
    })
    // 右键等价于点三点：同一份菜单，位置贴着这一行。
    row.addEventListener("contextmenu", function (event) {
      event.preventDefault()
      openSessionMenu(row, session)
    })

    var more = el("button", "ocw-row-menu", icon("more", 16))
    more.type = "button"
    more.title = "会话操作"
    more.setAttribute("aria-label", more.title)
    more.addEventListener("click", function (event) {
      event.preventDefault()
      event.stopPropagation()
      openSessionMenu(more, session)
    })

    wrap.appendChild(row)
    wrap.appendChild(more)
    return wrap
  }

  /* ── 行尾菜单：会话（重命名 / 移动 / 删除）与工作区（重命名 / 隐藏 / 清空） ── */

  var rowMenu = null

  function closeRowMenu() {
    if (!rowMenu) return
    rowMenu.remove()
    rowMenu = null
    document.removeEventListener("mousedown", onMenuOutside, true)
    document.removeEventListener("keydown", onMenuKey, true)
    window.removeEventListener("resize", closeRowMenu)
  }

  function onMenuOutside(event) {
    if (rowMenu && !rowMenu.contains(event.target)) closeRowMenu()
  }

  function onMenuKey(event) {
    if (event.key !== "Escape") return
    event.stopPropagation()
    closeRowMenu()
  }

  function openRowMenu(anchor, build) {
    closeRowMenu()
    var menu = el("div", "ocw-menu")
    menu.setAttribute("role", "menu")
    build(menu)
    document.body.appendChild(menu)

    // 贴着按钮放；右边或下边放不下时翻到另一侧，别跑出窗口。
    var rect = anchor.getBoundingClientRect()
    var box = menu.getBoundingClientRect()
    var left = Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))
    var top = rect.bottom + 4
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 4)
    menu.style.left = left + "px"
    menu.style.top = top + "px"

    rowMenu = menu
    document.addEventListener("mousedown", onMenuOutside, true)
    document.addEventListener("keydown", onMenuKey, true)
    window.addEventListener("resize", closeRowMenu)
    return menu
  }

  function menuItem(menu, label, options) {
    var settings = options || {}
    var item = el("button", "ocw-menu-item")
    item.type = "button"
    item.setAttribute("role", "menuitem")
    if (settings.danger) item.classList.add("is-danger")
    item.textContent = label
    item.addEventListener("click", function (event) {
      event.preventDefault()
      event.stopPropagation()
      // keep：留在同一个弹层里换内容（移动目标列表、返回上一级）
      if (!settings.keep) closeRowMenu()
      if (settings.onSelect) settings.onSelect()
    })
    menu.appendChild(item)
    return item
  }

  function menuNote(menu, text) {
    var note = el("div", "ocw-menu-note")
    note.textContent = text
    menu.appendChild(note)
    return note
  }

  async function mutate(path, options) {
    var settings = options || {}
    var response = await fetch(path, {
      method: settings.method || "POST",
      headers: {
        accept: "application/json",
        ...(settings.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
    })
    if (!response.ok) throw new Error("HTTP " + response.status)
    if (response.status === 204) return null
    return response.json().catch(function () { return null })
  }

  function openSessionMenu(anchor, session) {
    openRowMenu(anchor, function (menu) {
      renderSessionMenu(menu, session)
    })
  }

  function renderSessionMenu(menu, session) {
    menu.textContent = ""
    menuItem(menu, "重命名", { onSelect: function () { renameSession(session) } })
    menuItem(menu, "移动到工作区…", {
      keep: true,
      onSelect: function () { void renderMoveTargets(menu, session) },
    })
    menuItem(menu, "删除会话", { danger: true, onSelect: function () { void removeSession(session) } })
  }

  async function renderMoveTargets(menu, session) {
    menu.textContent = ""
    menuItem(menu, "← 返回", { keep: true, onSelect: function () { renderSessionMenu(menu, session) } })
    menuNote(menu, "正在读取工作区…")
    try {
      var response = await fetch("/api/project", { headers: { accept: "application/json" } })
      if (!response.ok) throw new Error("HTTP " + response.status)
      var projects = await response.json()
      var current = session.location && session.location.directory
      // 目录不存在时 /move 会返回 400（已实测），所以这里不猜哪些项目还“活着”，
      // 直接列出全部候选；真的移不过去会弹错误，而不是悄悄消失。
      var seen = new Set()
      var live = new Set()
      state.groups.forEach(function (group) { live.add(group.path) })
      state.background.forEach(function (item) {
        if (item.location && item.location.directory) live.add(item.location.directory)
      })
      var label = function (project) { return String(project.name || basename(project.canonical)) }
      var targets = (Array.isArray(projects) ? projects : [])
        .filter(function (project) {
          if (!project || !project.canonical || project.canonical === current) return false
          if (seen.has(project.canonical)) return false
          seen.add(project.canonical)
          return true
        })
        .sort(function (a, b) {
          // 有会话的工作区排前面，其余按名字排：常用目标不用翻。
          var weight = Number(live.has(b.canonical)) - Number(live.has(a.canonical))
          return weight || label(a).localeCompare(label(b), "zh")
        })
      menu.textContent = ""
      menuItem(menu, "← 返回", { keep: true, onSelect: function () { renderSessionMenu(menu, session) } })
      if (!targets.length) {
        menuNote(menu, "没有其他工作区")
        return
      }
      targets.forEach(function (project) {
        menuItem(menu, project.name || basename(project.canonical), {
          onSelect: function () { void moveSession(session, project) },
        })
      })
    } catch (error) {
      menu.textContent = ""
      menuItem(menu, "← 返回", { keep: true, onSelect: function () { renderSessionMenu(menu, session) } })
      menuNote(menu, "读取工作区失败：" + String((error && error.message) || error))
    }
  }

  function renameSession(session) {
    var host = document.querySelector('.ocw-session-wrap[data-session-id="' + session.id + '"]')
    if (!host) return
    startRename(host, session.title || "", function (title) {
      return mutate("/api/session/" + encodeURIComponent(session.id), { method: "PATCH", body: { title } }).then(function () {
        // 先改本地缓存再刷新：否则下一帧会先跳回旧标题。
        if (window.__ocwBackground) window.__ocwBackground.patch(session.id, { title: title })
      })
    })
  }

  async function moveSession(session, project) {
    try {
      await mutate("/api/session/" + encodeURIComponent(session.id) + "/move", { body: { directory: project.canonical } })
      if (window.__ocwBackground) window.__ocwBackground.patch(session.id, { location: { directory: project.canonical } })
      await refresh(true)
    } catch (error) {
      window.alert("移动失败：" + String((error && error.message) || error))
    }
  }

  async function removeSession(session) {
    var name = session.title || "未命名会话"
    if (!window.confirm("删除会话「" + name + "」？此操作不可撤销。")) return
    try {
      await mutate("/api/session/" + encodeURIComponent(session.id), { method: "DELETE" })
      if (window.__ocwBackground) window.__ocwBackground.forget(session.id)
      if (currentSessionId() === session.id) go("/")
      await refresh(true)
    } catch (error) {
      window.alert("删除失败：" + String((error && error.message) || error))
    }
  }

  function openGroupMenu(anchor, group) {
    openRowMenu(anchor, function (menu) {
      menuItem(menu, "重命名工作区", { onSelect: function () { renameGroup(group) } })
      menuItem(menu, "隐藏工作区", { onSelect: function () { hideGroup(group.id) } })
      menuItem(menu, "删除全部会话（" + group.sessions.length + "）", {
        danger: true,
        onSelect: function () { void removeGroupSessions(group) },
      })
    })
  }

  function renameGroup(group) {
    var host = document.querySelector('.ocw-group[data-group-id="' + group.id + '"] .ocw-group-row')
    if (!host) return
    startRename(host, group.name, function (name) {
      return mutate("/api/project/" + encodeURIComponent(group.id), { method: "PATCH", body: { name } })
    })
  }

  async function removeGroupSessions(group) {
    if (!window.confirm("删除「" + group.name + "」下的 " + group.sessions.length + " 个会话？此操作不可撤销。")) return
    var active = currentSessionId()
    var deletedActive = false
    try {
      for (var i = 0; i < group.sessions.length; i++) {
        var session = group.sessions[i]
        await mutate("/api/session/" + encodeURIComponent(session.id), { method: "DELETE" })
        if (window.__ocwBackground) window.__ocwBackground.forget(session.id)
        if (session.id === active) deletedActive = true
      }
      if (deletedActive) go("/")
      await refresh(true)
    } catch (error) {
      window.alert("删除失败：" + String((error && error.message) || error))
      await refresh(true)
    }
  }

  /** 就地改名：输入框盖在行上，Enter / 失焦保存，Esc 取消。 */
  function startRename(host, value, save) {
    if (host.querySelector(".ocw-rename")) return
    var input = el("input", "ocw-rename")
    input.type = "text"
    input.value = value
    input.setAttribute("aria-label", "重命名")
    var settled = false

    function finish(commit) {
      if (settled) return
      settled = true
      var next = input.value.trim()
      input.remove()
      host.classList.remove("is-renaming")
      if (!commit || !next || next === value) {
        renderList(query())
        return
      }
      Promise.resolve()
        .then(function () { return save(next) })
        .then(function () { return refresh(true) })
        .catch(function (error) {
          window.alert("重命名失败：" + String((error && error.message) || error))
          renderList(query())
        })
    }

    input.addEventListener("keydown", function (event) {
      event.stopPropagation()
      if (event.key === "Enter") {
        event.preventDefault()
        finish(true)
      } else if (event.key === "Escape") {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener("click", function (event) { event.stopPropagation() })
    input.addEventListener("blur", function () { finish(true) })

    host.classList.add("is-renaming")
    host.appendChild(input)
    input.focus()
    input.select()
  }

  /* 隐藏工作区只写本机 localStorage：项目实体没有删除接口，隐藏是唯一的“关掉它”。 */
  var HIDDEN_KEY = "ocw-hidden-groups"
  var hiddenGroups = readHiddenGroups()

  function readHiddenGroups() {
    try {
      var stored = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")
      return new Set(Array.isArray(stored) ? stored : [])
    } catch (error) {
      return new Set()
    }
  }

  function writeHiddenGroups() {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(hiddenGroups))) } catch (error) { }
  }

  function hideGroup(id) {
    hiddenGroups.add(id)
    writeHiddenGroups()
    renderList(query())
  }

  function showHiddenGroups() {
    hiddenGroups.clear()
    writeHiddenGroups()
    renderList(query())
  }

  /* ── 侧栏工作指示：事件流（实时）+ /api/session/active（权威）两条来源。
     订阅推送 + 350ms 轮询兜底（新渲染出的行、漏掉的终态都靠轮询自愈）。 ── */
  function isBusy(id) {
    var activity = window.__ocwActivity
    // 事件流已经收到这个会话的收尾状态：立即熄灯，不等下一次列表刷新。
    if (activity && activity.known && activity.known(id) && !activity.busy(id)) return false
    if (state.activeIds.has(id)) return true
    return Boolean(activity && activity.busy(id))
  }

  function syncBusy() {
    if (!ui) return
    var rows = ui.list.querySelectorAll(".ocw-session[data-id]")
    for (var i = 0; i < rows.length; i++) {
      rows[i].toggleAttribute("data-busy", isBusy(rows[i].getAttribute("data-id")))
    }

    // 图标栏那颗心跳按钮上的角标：正在跑的后台任务数（按已加载的会话算，不额外请求）。
    var running = 0
    for (var j = 0; j < state.background.length; j++) if (isBusy(state.background[j].id)) running++
    var badge = ui.rail.querySelector('[data-rail="background"] .ocw-rail-badge')
    if (badge) {
      badge.textContent = running ? String(running) : ""
      badge.hidden = running === 0
    }
  }

  /* ── 后台任务监视页 ─────────────────────────────────────────────────────
     覆盖右侧内容区的只读面板：列出 metadata.origin = opencode-delegate 的会话，
     显示调用方、模型、目录、最近一轮的工具流程、token / 成本，2.5 秒轮询一次。
     打开方式：图标栏心跳按钮、侧栏「后台任务」的监视按钮、托盘菜单
     （URL 带 ?ocw=background）、Esc 关闭。 */
  var monitor = null
  var monitorTimer = null
  var monitorBusy = false

  function ago(timestamp) {
    if (!timestamp) return "刚刚"
    var seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
    if (seconds < 45) return "刚刚"
    if (seconds < 3600) return Math.round(seconds / 60) + " 分钟前"
    if (seconds < 86400) return Math.round(seconds / 3600) + " 小时前"
    return Math.round(seconds / 86400) + " 天前"
  }

  function compact(value) {
    var number = Number(value) || 0
    if (number < 1000) return String(number)
    if (number < 1000000) return (number / 1000).toFixed(number < 10000 ? 1 : 0) + "k"
    return (number / 1000000).toFixed(1) + "M"
  }

  function idleLabel(messages) {
    var idle = (messages || []).find(function (message) {
      return message.type === "idle" || message.type === "user"
    })
    if (!idle || idle.type === "user") return "结果待确认"
    if (idle.outcome === "succeeded") return "已完成"
    if (idle.outcome === "failed") return "失败"
    if (idle.outcome === "interrupted") return "已取消"
    return "空闲"
  }

  function flowOf(messages) {
    var assistant = (messages || []).find(function (message) {
      return message.type === "assistant"
    })
    if (!assistant) return []
    return (assistant.content || [])
      .filter(function (part) {
        return part.type === "tool" && part.name
      })
      .map(function (part) {
        return { name: part.name, running: Boolean(part.state && part.state.status === "running") }
      })
  }

  function ensureMonitor() {
    if (monitor && monitor.isConnected) return monitor

    var panel = el("div", "ocw-panel ocw-monitor")
    panel.id = "ocw-monitor"
    panel.hidden = true
    panel.innerHTML =
      '<header class="ocw-panel-head">' +
      '<div class="ocw-panel-heading">' +
      '<span class="ocw-panel-title">后台任务</span>' +
      '<span class="ocw-panel-count"></span>' +
      "</div>" +
      '<button type="button" class="ocw-icon-btn" data-monitor-close aria-label="关闭监视页">' +
      icon("x", 16) +
      "</button>" +
      "</header>" +
      '<div class="ocw-panel-sub"></div>' +
      '<div class="ocw-panel-body"><div class="ocw-panel-list"></div></div>'
    panel.querySelector("[data-monitor-close]").addEventListener("click", function () {
      setScope("foreground")
    })
    ;(document.body || document.documentElement).appendChild(panel)
    monitor = panel
    return panel
  }

  function openMonitor() {
    closeModels()
    var panel = ensureMonitor()
    if (!panel.hidden) {
      refreshMonitor()
      return
    }
    panel.hidden = false
    document.documentElement.setAttribute("data-ocw-monitor", "")
    panel.querySelector(".ocw-panel-list").textContent = ""
    panel.querySelector(".ocw-panel-list").appendChild(message("正在读取后台任务…"))
    refreshMonitor()
    if (monitorTimer) clearInterval(monitorTimer)
    monitorTimer = setInterval(refreshMonitor, 2500)
  }

  function closeMonitor() {
    if (monitor) monitor.hidden = true
    document.documentElement.removeAttribute("data-ocw-monitor")
    if (monitorTimer) {
      clearInterval(monitorTimer)
      monitorTimer = null
    }
  }

  async function refreshMonitor(more) {
    if (!monitor || monitor.hidden || monitorBusy) return
    monitorBusy = true
    try {
      var data = await (more === true ? window.__ocwBackground.loadMore() : window.__ocwBackground.refresh())
      var details = await window.__ocwBackground.details(data.items)
      state.activeIds = new Set(Object.keys(data.active))
      state.background = data.items
      state.backgroundNext = data.next
      state.error = ""
      renderList(query())
      renderMonitor(data.items, data.active, details, data.next)
    } catch (error) {
      monitor.querySelector(".ocw-panel-sub").textContent = "读取失败，保留上次结果：" + String(error.message || error)
    } finally {
      monitorBusy = false
    }
  }

  function historyButton() {
    var button = el("button", "ocw-more")
    button.type = "button"
    button.textContent = "加载更多历史"
    button.addEventListener("click", function () { refreshMonitor(true) })
    return button
  }

  function renderMonitor(items, active, details, next) {
    if (!monitor) return
    var running = items.filter(function (session) {
      return active[session.id]
    }).length
    monitor.querySelector(".ocw-panel-count").textContent = items.length ? String(items.length) : ""
    monitor.querySelector(".ocw-panel-sub").textContent =
      "MCP 委派 · " +
      (running ? running + " 个在运行" : "当前没有运行中的任务") +
      " · 每 2.5 秒刷新" + (details.some(function (item) { return item.error }) ? " · 部分详情读取失败，状态待确认" : "")

    var list = monitor.querySelector(".ocw-panel-list")
    list.textContent = ""
    if (!items.length) {
      list.appendChild(message("还没有后台任务。用 MCP 委派后，这里会按会话显示运行状态、目录和工具流程。"))
      if (next) list.appendChild(historyButton())
      return
    }
    items.forEach(function (session, index) {
      list.appendChild(taskCard(session, Boolean(active[session.id]), details[index]))
    })
    if (next) list.appendChild(historyButton())
  }

  function taskCard(session, running, detail) {
    var messages = detail.messages
    var card = el("article", "ocw-task")
    card.setAttribute("data-id", session.id)
    if (running) card.classList.add("is-running")

    var head = el("div", "ocw-task-head")
    head.appendChild(el("span", "ocw-task-dot"))
    var title = el("span", "ocw-task-title")
    title.textContent = session.title || "未命名会话"
    title.title = title.textContent
    head.appendChild(title)
    var state = el("span", "ocw-task-state")
    state.textContent = detail.error ? "状态待确认" : (running ? "运行中" : detail.pending ? "等待投递" : idleLabel(messages))
    if (detail.pending) state.textContent += " · " + detail.pending + " 条待处理"
    head.appendChild(state)

    var meta = el("div", "ocw-task-meta")
    var caller = el("span", "ocw-task-caller")
    caller.textContent = (session.metadata && session.metadata.caller) || "mcp"
    var model = el("span", "ocw-task-model")
    model.textContent = (session.model && (session.model.id || session.model)) || "?"
    meta.appendChild(caller)
    meta.appendChild(model)

    var flow = el("div", "ocw-task-flow")
    var steps = flowOf(messages)
    if (steps.length) {
      steps.slice(0, 6).forEach(function (step, index) {
        if (index) flow.appendChild(el("span", "ocw-task-arrow", "→"))
        var chip = el("span", "ocw-flow-step")
        if (running && !detail.error && step.running) chip.classList.add("is-running")
        chip.textContent = step.name
        flow.appendChild(chip)
      })
      if (steps.length > 6) flow.appendChild(el("span", "ocw-task-arrow", "…"))
    } else {
      flow.appendChild(el("span", "ocw-task-flow-empty", "还没有工具调用"))
    }

    var directory = el("div", "ocw-task-dir")
    directory.textContent = (session.location && session.location.directory) || "未知目录"
    directory.title = directory.textContent

    var foot = el("div", "ocw-task-foot")
    var tokens = session.tokens || {}
    var pieces = [
      ago(session.time && session.time.updated),
      compact(tokens.input) + " in / " + compact(tokens.output) + " out",
    ]
    if (typeof session.cost === "number" && session.cost > 0) pieces.push("cost " + session.cost.toFixed(4))
    else pieces.push("cost 0")
    if (session.metadata && session.metadata.taskId) pieces.push(session.metadata.taskId)
    foot.textContent = pieces.join(" · ")

    card.appendChild(head)
    card.appendChild(meta)
    card.appendChild(flow)
    card.appendChild(directory)
    card.appendChild(foot)
    card.addEventListener("click", function () {
      // 点卡片就是进入那个会话：回前台，别让后台视图留在右边。
      setScope("foreground")
      go(sessionUrl(session.id))
    })
    return card
  }

  /* ── 模型顺序 ─────────────────────────────────────────────────────────
     免费模型的排序表，排第一的就是下一次委派会用的模型。排序存在
     .state/model-ranking.json（网页写、MCP 读），这里只负责编辑它。 */
  var modelsPanel = null
  var modelsState = { items: [], saved: "", available: false }
  var rankingSaveQueue = Promise.resolve()
  var rankingRevision = 0
  var rankingPending = 0

  function ensureModelsPanel() {
    if (modelsPanel && modelsPanel.isConnected) return modelsPanel

    var panel = el("div", "ocw-panel ocw-models")
    panel.id = "ocw-models"
    panel.hidden = true
    panel.innerHTML =
      '<header class="ocw-panel-head">' +
      '<div class="ocw-panel-heading">' +
      '<span class="ocw-panel-title">模型顺序</span>' +
      '<span class="ocw-panel-count"></span>' +
      "</div>" +
      '<button type="button" class="ocw-icon-btn" data-models-refresh aria-label="刷新模型列表">' +
      icon("refresh", 16) +
      "</button>" +
      '<button type="button" class="ocw-icon-btn" data-models-close aria-label="关闭">' +
      icon("x", 16) +
      "</button>" +
      "</header>" +
      '<div class="ocw-panel-sub"></div>' +
      '<div class="ocw-panel-body"><div class="ocw-panel-list"></div></div>' +
      '<div class="ocw-panel-status"></div>'
    panel.querySelector("[data-models-close]").addEventListener("click", closeModels)
    panel.querySelector("[data-models-refresh]").addEventListener("click", function () {
      void loadModels()
    })
    ;(document.body || document.documentElement).appendChild(panel)
    modelsPanel = panel
    return panel
  }

  function openModels() {
    closeMonitor()
    var panel = ensureModelsPanel()
    panel.hidden = false
    document.documentElement.setAttribute("data-ocw-models", "")
    void loadModels()
  }

  function closeModels() {
    if (modelsPanel) modelsPanel.hidden = true
    document.documentElement.removeAttribute("data-ocw-models")
  }

  async function loadModels() {
    if (!modelsPanel) return
    // Keep the optimistic order until its queued saves finish, including on reopen.
    if (rankingPending) {
      renderModels("")
      return
    }
    var revision = rankingRevision
    renderModels("正在读取模型列表…")
    try {
      var response = await fetch("/__opencode-web/models", { headers: { accept: "application/json" } })
      var data = await response.json()
      if (revision !== rankingRevision) return
      modelsState.items = Array.isArray(data.models) ? data.models : []
      modelsState.available = Boolean(data.available)
      modelsState.saved = ""
      renderModels(modelsState.available ? "" : "后台服务未运行，读不到模型列表。打开一个会话后点刷新。")
    } catch (error) {
      if (revision !== rankingRevision) return
      modelsState.items = []
      renderModels("读取失败：" + ((error && error.message) || error))
    }
  }

  function modelRefOf(model) {
    return model.providerID + "/" + model.id
  }

  function moveModel(index, delta) {
    var items = modelsState.items.slice()
    var target = index + delta
    if (target < 0 || target >= items.length) return
    var moved = items.splice(index, 1)[0]
    items.splice(target, 0, moved)
    modelsState.items = items
    renderModels("")
    void saveRanking(items)
  }

  function saveRanking(items) {
    var revision = ++rankingRevision
    var ranking = items.map(modelRefOf)
    rankingPending++
    modelsState.saved = "正在保存…"
    renderModels("")
    // Only one POST is in flight. An older order cannot arrive after a newer one.
    rankingSaveQueue = rankingSaveQueue.then(async function () {
      var notice
      try {
        var response = await fetch("/__opencode-web/models", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ ranking: ranking }),
        })
        notice = response.ok ? "已保存 · 下一次委派生效" : "保存失败（HTTP " + response.status + "）"
      } catch (error) {
        notice = "保存失败：" + ((error && error.message) || error)
      }
      rankingPending--
      if (revision === rankingRevision) {
        modelsState.saved = notice
        renderModels("")
      }
    })
    return rankingSaveQueue
  }

  function renderModels(notice) {
    var panel = modelsPanel
    if (!panel) return
    panel.querySelector(".ocw-panel-count").textContent = modelsState.items.length ? String(modelsState.items.length) : ""
    panel.querySelector(".ocw-panel-sub").textContent = "排第一的会被新委派使用 · 数据来自 opencode · 调整后立即生效"
    var list = panel.querySelector(".ocw-panel-list")
    list.textContent = ""
    if (modelsState.items.length === 0) list.appendChild(message(notice || "没有可用的免费模型。"))
    else
      modelsState.items.forEach(function (model, index) {
        list.appendChild(modelRow(model, index))
      })
    panel.querySelector(".ocw-panel-status").textContent = modelsState.saved || notice || ""
  }

  function modelRow(model, index) {
    var row = el("div", "ocw-model")
    if (index === 0) row.classList.add("is-first")
    row.appendChild(el("span", "ocw-model-rank", String(index + 1)))

    var main = el("div", "ocw-model-main")
    var name = el("span", "ocw-model-name")
    name.textContent = model.name || model.id
    var meta = el("span", "ocw-model-meta")
    meta.textContent = [modelRefOf(model), model.context ? Math.round(model.context / 1000) + "k ctx" : "", "tools"]
      .filter(Boolean)
      .join(" · ")
    main.appendChild(name)
    main.appendChild(meta)
    row.appendChild(main)

    if (index === 0) row.appendChild(el("span", "ocw-model-badge", "首选"))

    var move = el("div", "ocw-model-move")
    var up = el("button", "", icon("up", 14))
    up.type = "button"
    up.title = "上移"
    up.setAttribute("aria-label", "上移")
    up.disabled = index === 0
    up.addEventListener("click", function () {
      moveModel(index, -1)
    })
    var down = el("button", "", icon("down", 14))
    down.type = "button"
    down.title = "下移"
    down.setAttribute("aria-label", "下移")
    down.disabled = index === modelsState.items.length - 1
    down.addEventListener("click", function () {
      moveModel(index, 1)
    })
    move.appendChild(up)
    move.appendChild(down)
    row.appendChild(move)
    return row
  }

  function message(text) {
    var node = el("div", "ocw-empty")
    node.textContent = text
    return node
  }

  function syncActive() {
    var activeId = currentSessionId()
    var rows = ui.list.querySelectorAll(".ocw-session[data-id]")
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("is-active", rows[i].getAttribute("data-id") === activeId)
    }

    var onDraft = isDraftRoute()
    if (onDraft) setDrafting(false)
    // 会话路由是最可靠的「当前工作区」来源；草稿屏期间保留上一次记下的那个
    var dir = routeDirectory()
    if (dir) state.workspace = dir
    setRailActive("foreground", state.scope === "foreground")
    setRailActive("background", state.scope === "background")
    setRailActive("settings", location.pathname === "/settings")
    syncThemeIcon()
    syncHero()
    syncBusy()
  }

  function setRailActive(id, active) {
    var button = ui.rail.querySelector('[data-rail="' + id + '"]')
    if (button) button.classList.toggle("is-active", active)
  }

  /* ── 启动 ── */
  function start() {
    try {
      if (localStorage.getItem(COLLAPSE_KEY) === "1") document.documentElement.setAttribute("data-ocw-collapsed", "")
    } catch (error) {
      void error
    }

    build()
    document.documentElement.setAttribute("data-ocw-scope", "foreground")
    void refresh()

    // 托盘菜单用 ?ocw=background 打开监视页；模型顺序用 ?ocw=models。打开后把参数摘掉。
    var panel = new URLSearchParams(location.search).get("ocw")
    if (panel) {
      try {
        history.replaceState(null, "", location.pathname + location.hash)
      } catch (error) {
        void error
      }
      if (panel === "background") setScope("background")
      if (panel === "models") {
        setScope("background")
        openModels()
      }
    }

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return
      if (modelsPanel && !modelsPanel.hidden) {
        closeModels()
        if (state.scope === "background") openMonitor()
        return
      }
      if (state.scope === "background") setScope("foreground")
    })

    // 活动状态推送一来就点灯/熄灯（activity-model.js 按文件名顺序先于本脚本加载）
    if (window.__ocwActivity && typeof window.__ocwActivity.subscribe === "function")
      window.__ocwActivity.subscribe(syncBusy)

    addEventListener("popstate", function () {
      syncActive()
    })

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") void refresh()
    })

    // 官方自己也会改 URL（点标签、点主页按钮），轮询比挂一堆钩子稳。
    // 顺带每次都 syncActive：首页一旦被官方弹回来、或草稿屏那行提问被重渲染刷掉，都靠它自愈。
    var lastPath = location.pathname
    setInterval(function () {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname
        // 后台视图打开期间发生的真实跳转（官方快捷键、标签）也回前台，别把导航盖住。
        if (state.scope === "background" && Date.now() - (state.scopeSince || 0) > 1200) setScope("foreground")
        void refresh()
      }
      syncActive()
    }, 350)

    setInterval(function () {
      void refresh()
    }, 20000)
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()
