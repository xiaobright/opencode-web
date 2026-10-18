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
  var state = { groups: [], loaded: false, loading: false, error: "", workspace: "" }
  var collapsedGroups = new Set() // 用户手动折起来的工作区
  var showAllGroups = new Set() // 用户手动展开到底的工作区
  var LIMIT = 8 // 每个工作区默认露几条，其余收在「还有 N 个」后面

  /* ── 建壳 ── */
  function build() {
    var root = el("div", "ocw")
    root.id = "ocw"

    var rail = el("nav", "ocw-rail")
    rail.setAttribute("aria-label", "主导航")

    var top = el("div", "ocw-rail-group")
    var bottom = el("div", "ocw-rail-group ocw-rail-bottom")

    // 顶部这一颗是「新聊天」：点它进官方的草稿屏（居中品牌标 + 完整 composer），
    // 会话要到真正发送时才落库。官方那个首页（/）不再从这里进。
    top.appendChild(railButton("compose", "新聊天", "newchat", function () { openDraft("") }))
    top.appendChild(railButton("panel", "折叠 / 展开侧栏", "panel", toggleSidebar))
    top.appendChild(railButton("search", "搜索会话", "search", openSearch))
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
    headActions.appendChild(iconButton("search", "搜索会话", openSearch))
    head.appendChild(title)
    head.appendChild(headActions)

    var newChat = el("button", "ocw-new")
    newChat.type = "button"
    newChat.innerHTML = icon("compose", 17) + "<span>新聊天</span>"
    newChat.addEventListener("click", function () {
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

    ui = { root: root, rail: rail, list: list, filter: filter, newChat: newChat }
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

  async function refresh() {
    if (state.loading) return
    state.loading = true
    try {
      var responses = await Promise.all([
        fetch("/api/project", { headers: { accept: "application/json" } }),
        fetch("/api/session?order=desc", { headers: { accept: "application/json" } }),
      ])
      if (!responses[0].ok || !responses[1].ok) throw new Error("HTTP " + responses[0].status + "/" + responses[1].status)
      var projects = await responses[0].json()
      var sessions = await responses[1].json()
      state.groups = group(Array.isArray(projects) ? projects : [], (sessions && sessions.data) || [])
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

  function renderList(filterText) {
    var list = ui.list
    list.textContent = ""

    if (!state.loaded) {
      list.appendChild(message(state.error ? "列表读取失败：" + state.error : "正在读取会话…"))
      return
    }

    if (!state.groups.length) {
      list.appendChild(message(state.error ? "列表读取失败：" + state.error : "还没有会话"))
      return
    }

    var activeId = currentSessionId()
    var shown = 0

    for (var i = 0; i < state.groups.length; i++) {
      var item = state.groups[i]
      var sessions = item.sessions

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

    if (!shown) list.appendChild(message(filterText ? "没有匹配的会话" : "还没有会话"))

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

  function sessionRow(session, activeId) {
    var row = el("button", "ocw-session")
    row.type = "button"
    row.title = session.title || session.id
    row.setAttribute("data-id", session.id)
    if (session.id === activeId) row.classList.add("is-active")

    // 会话名左边留的 33px 空槽：会话在工作时这里放官方那颗像素格动画（见 progress-grid.js）。
    // 节点常驻、由 data-busy 控制显隐，免得每次状态翻转都重建 DOM 打断动画。
    var status = el("span", "ocw-session-status")
    if (window.__ocwProgressGrid) status.appendChild(window.__ocwProgressGrid(14))
    row.appendChild(status)

    var label = el("span", "ocw-session-title")
    label.textContent = session.title || "未命名会话"
    row.appendChild(label)

    row.addEventListener("click", function () {
      go("/server/" + keySegment() + "/session/" + session.id)
    })

    return row
  }

  /* ── 侧栏工作指示：activity-model 已经替我们盯着事件流，这里只按 sessionID 点灯。
     订阅推送 + 350ms 轮询兜底（新渲染出的行、漏掉的终态都靠轮询自愈）。 ── */
  function syncBusy() {
    var activity = window.__ocwActivity
    if (!activity || !ui) return
    var rows = ui.list.querySelectorAll(".ocw-session[data-id]")
    for (var i = 0; i < rows.length; i++) {
      var busy = activity.busy(rows[i].getAttribute("data-id"))
      rows[i].toggleAttribute("data-busy", busy)
    }
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
    setRailActive("newchat", onDraft)
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
    void refresh()

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
