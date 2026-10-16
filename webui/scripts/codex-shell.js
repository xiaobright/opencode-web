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

    var label = el("span", "ocw-session-title")
    label.textContent = session.title || "未命名会话"
    row.appendChild(label)

    row.addEventListener("click", function () {
      go("/server/" + keySegment() + "/session/" + session.id)
    })

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
    setRailActive("newchat", onDraft)
    setRailActive("settings", location.pathname === "/settings")
    syncThemeIcon()
    syncHero()
    syncFold()
  }

  function setRailActive(id, active) {
    var button = ui.rail.querySelector('[data-rail="' + id + '"]')
    if (button) button.classList.toggle("is-active", active)
  }

  /* ── 二次折叠：把一轮里的全部过程折成一行「用时 Xm Ys」 ───────────────────────
     官方把一轮拆成很多行（思考、工具组、途中说明……），这些行在虚拟列表里各自是绝对定位
     的一块，但共用同一个 data-message-id，也就是该轮 user 消息的 id，所以「一轮」在 DOM
     里是可辨的。这里做三件事：

       收起：这一轮里除最终正文外的过程行全部压扁（height:0 + overflow:hidden）。
             被 ResizeObserver 观察的是行内部的 [data-index]，它量到 0 之后虚拟列表自己
             就把高度收掉，所以既不用碰官方的数据，也不用删除任何行。
       表头：插在这一轮第一个过程行里面 —— 那行的高度就成了表头高度，于是收起后看到的
             顺序就是：用户消息 → 用时 … → 最终回复。
       用时：官方本来就把这一轮的用时写在最终正文的 text-part-meta 上（"9 分钟 38 秒"），
             直接读它、统一成 Codex 的 9m 38s；读不到（例如这一轮已经被压缩带走）就退化成
             「已折叠 N 步」。

     压缩块另有一层：官方的「压缩已开始 + 总结全文 + 会话已压缩 · 用量」折成一条线，
     点那条线才展开总结；整块本身又是上面这一轮里的一个过程行，于是会被二次折叠收进去。
     ------------------------------------------------------------------------ */
  var HEAD_CLASS = "ocw-turn-head"
  var turnOpen = Object.create(null) // 轮 key → true：用户手动展开
  var compactOpen = Object.create(null) // 压缩块 key → true：用户手动展开
  // 已判定的折叠：turn key → { rows: {行键:1}, host: 行键, label: 表头文字 }。
  // 之所以记着而不是每次现算：行是虚拟列表里的，滚出视口就卸载，「这一轮现在只挂了几行」
  // 和「这一轮没得折」看起来一样；记下来之后，行重新挂上时那份隐藏样式早就在，
  // 不会先露一下再收回去。
  var foldRows = Object.create(null)
  var foldSession = ""
  var foldSheet = null
  var foldWatch = null
  var foldObserver = null
  var foldFrame = 0

  function cssSafe(value) {
    return String(value).replace(/["\\]/g, "\\$&")
  }

  // 行在虚拟列表里的键：行自己不带，包在外面的盒子带
  function boxKey(node) {
    var box = node && node.closest ? node.closest("[data-timeline-key]") : null
    return box ? box.getAttribute("data-timeline-key") || "" : ""
  }

  // 官方的用时是本地化文本（zh："9 分钟 38 秒"，en："9m 38s"）。
  // 只认「以数字开头、最多两个数字、不带括号」的那一段，然后统一成 Codex 的写法。
  function durationLabel(rows) {
    for (var i = 0; i < rows.length; i++) {
      var meta = rows[i].querySelector('[data-slot="text-part-meta"]')
      if (!meta) continue
      var segments = String(meta.textContent || "").split("\u00B7")
      for (var s = 0; s < segments.length; s++) {
        var text = segments[s].trim()
        if (!text || text.length > 20 || text.indexOf("(") !== -1 || !/^[0-9]/.test(text)) continue
        var numbers = text.match(/[0-9]+/g)
        if (!numbers) continue
        if (numbers.length === 2) return "用时 " + numbers[0] + "m " + numbers[1] + "s"
        if (numbers.length === 1) return "用时 " + numbers[0] + "s"
      }
    }
    return ""
  }

  function foldStyle() {
    if (!foldSheet || !foldSheet.isConnected) {
      foldSheet = document.createElement("style")
      foldSheet.setAttribute("data-ocw-fold", "")
      ;(document.head || document.documentElement).appendChild(foldSheet)
    }
    return foldSheet
  }

  function ensureHead(frame, key, label, open) {
    var cell = frame.parentElement
    if (!cell) return false

    var head = null
    for (var i = 0; i < cell.children.length; i++) {
      if (cell.children[i].classList && cell.children[i].classList.contains(HEAD_CLASS)) head = cell.children[i]
    }

    var added = false
    if (!head) {
      // 和官方内容同一列：官方那几个类（md:max-w-session md:mx-auto / px-4 md:px-6）直接用
      head = el("div", HEAD_CLASS + " min-w-0 w-full max-w-full md:max-w-session md:mx-auto")
      head.innerHTML =
        '<div class="ocw-turn-head-inner px-4 md:px-6">' +
        '<button type="button" class="ocw-turn-toggle">' +
        '<span class="ocw-turn-label"></span>' +
        '<span class="ocw-turn-caret">' +
        icon("chevron", 12) +
        "</span>" +
        "</button></div>"
      cell.insertBefore(head, cell.firstChild)
      added = true
    }

    var toggle = head.querySelector(".ocw-turn-toggle")
    var labelNode = head.querySelector(".ocw-turn-label")
    if (labelNode.textContent !== label) labelNode.textContent = label
    toggle.setAttribute("data-ocw-for", key)
    toggle.setAttribute("aria-expanded", open ? "true" : "false")
    toggle.title = open ? "收起这一轮的过程" : "展开这一轮的过程"
    if (open) toggle.setAttribute("data-ocw-open", "")
    else toggle.removeAttribute("data-ocw-open")
    return added
  }

  // 正在跑的一轮不折，免得和流式渲染抢 —— 但这个判断**不要自己猜**。
  //
  // 早先的写法是读 aria-hidden / data-streaming，结果在空闲会话里也误判：官方那个
  // aria-hidden={workingTurn(...)} 是流式期间打上的，进 idle 之后**行不重挂就不会撤**，
  // 于是「哪些轮是进行中」会随着滚动（行重挂）变化，折叠被反复撤掉又装上 —— 就是往上
  // 滚时的「往回闪」。data-streaming 同理不可靠。
  //
  // 真正可靠的判据其实是官方的「最终回复」标记本身：copy/用时那条 meta 只在
  // copyContentID(...) 非空时渲染，而 copyContentID 在 workingTurn 时直接返回 null。
  // 所以「正在跑的一轮」根本没有 meta → 找不到答案行 → 天然不会被折。这里只留一个
  // 兜底：这一轮里挂着的行如果有还在动的活动面板（子会话 Shell、排队中的压缩），不折。
  function liveTurn(list) {
    for (var i = 0; i < list.length; i++) {
      var kind = list[i].getAttribute("data-timeline-row")
      if (kind === "Shell" || kind === "CompactionQueued") return true
    }
    return false
  }

  // 「最终回复」那一行：官方只在本轮最后一段正文上渲染 copy + 用时那条 meta
  // （见 session-timeline-row 的 copyContentID），进行中的一轮没有。这是与挂载集合
  // 无关的稳定标记 —— 比「当前挂着的最后一段正文」可靠，那个会随滚动飘。
  function answerIndex(rows) {
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].querySelector('[data-slot="text-part-meta"]')) return i
    }
    return -1
  }

  // 把一行记进某一轮的折叠集合。行键只在挂载时认识，所以是「见到就记」的累积；
  // 同时在行的外层盒子上打 data-ocw-fold（样式表里就一条规则管它，不随行数增长）。
  function markHidden(fold, row) {
    if (fold.done >= 400) return false // 单轮行数封顶
    var box = row.closest ? row.closest("[data-timeline-key]") : null
    if (!box) return false
    var key = box.getAttribute("data-timeline-key")
    if (!key || key === fold.host) return false
    box.setAttribute("data-ocw-fold", fold.owner || "")
    if (fold.rows[key]) return false
    fold.rows[key] = 1
    fold.done++
    return true
  }

  // 「要压掉的行全在屏幕之外」才算安全。官方的滚动补偿（virtualizer 的
  // shouldAdjustScrollPositionOnItemSizeChange）只对「整行都在可视顶之上」的行生效
  // （item.end <= scrollOffset），屏幕上还看得见的行一变高／变矮就没人补，于是它下面
  // 的内容整块位移 —— 那就是用户看到的「往回闪」。所以只要有一行还在屏幕上，这一轮就
  // 先放着不折，等它滚出视口再说。会话本来就停在底部时不适用：那时候官方自己会把底部
  // 钉住（pinColdBottom / scrollToEnd），回弹的是「最终回复往上挪」，也就是折叠想要的
  // 效果，而且只发生一次。
  function foldSafe(content, list, count) {
    var root = scrollRoot(content)
    if (!root) return false
    var box = root.getBoundingClientRect()
    var atEnd = root.scrollHeight - root.clientHeight - root.scrollTop <= 2
    for (var i = 0; i < count && i < list.length; i++) {
      var rect = list[i].getBoundingClientRect()
      if (rect.height <= 0) continue // 已经压扁的行本来就是 0 高，不存在位移
      if (rect.bottom > box.top + 1) return atEnd
    }
    return true
  }

  function scrollRoot(node) {
    var n = node && node.parentElement
    while (n) {
      if (n.scrollHeight > n.clientHeight + 100) return n
      n = n.parentElement
    }
    return null
  }

  function syncTurns(content) {
    var session = currentSessionId()
    if (session !== foldSession) {
      // 换会话就别留着上一个会话的折叠状态
      foldSession = session
      foldRows = Object.create(null)
      turnOpen = Object.create(null)
      compactOpen = Object.create(null)
    }

    var rows = content.querySelectorAll('[data-timeline-row][data-message-id]')
    var order = []
    var groups = Object.create(null)

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var tag = row.getAttribute("data-timeline-row")
      // 用户消息、轮间空隙、活动提示都不算「过程」
      if (tag === "UserMessage" || tag === "TurnGap" || tag === "Activity" || tag === "bottom-spacer") continue
      var key = row.getAttribute("data-message-id")
      if (!key) continue
      var group = groups[key]
      if (!group) {
        group = groups[key] = { key: key, rows: [] }
        order.push(key)
      }
      group.rows.push(row)
    }

    var css = []
    var changed = false

    for (var g = 0; g < order.length; g++) {
      var item = groups[order[g]]
      var list = item.rows

      // 这一轮里有还在动的东西（子会话面板、排队中的压缩）：保持原样，别把它们压掉
      if (liveTurn(list)) {
        if (foldRows[item.key]) delete foldRows[item.key]
        continue
      }

      var fold = foldRows[item.key]
      var ai = answerIndex(list)

      // 答案行没挂上（这一轮的过程行还没成形，或者干脆不是一轮完整对话）：不重判。
      // 已经折过的那一轮，把这次挂上来的行直接补进隐藏集合 —— 折过之后这一轮的所有
      // 行都落在同一个偏移上，是成组挂上/卸下的，所以「答案没挂上」意味着挂着的都
      // 在答案之前，压它们不会误伤最终回复。
      if (ai < 0) {
        if (!fold || !fold.host) continue
        // 有还没记过的行才动手，免得每帧都为了这个判断去读布局
        var pending = false
        for (var h1 = 0; h1 < list.length; h1++) if (!fold.rows[boxKey(list[h1])]) pending = true
        if (pending && !foldSafe(content, list, list.length)) continue
        for (var h0 = 0; h0 < list.length; h0++) if (markHidden(fold, list[h0])) changed = true
        continue
      }

      var fresh = !fold
      // 还有过程行在屏幕上就看下一帧（foldSafe 里说明了为什么）
      if (fresh && !foldSafe(content, list, ai)) continue
      if (fresh) {
        fold = foldRows[item.key] = { owner: item.key, rows: Object.create(null), host: "", label: "", done: 0 }
        changed = true
      }

      // 最终回复之前的过程行全部压扁（答案行与它之后的行保持可见）
      for (var h = 0; h < ai; h++) if (markHidden(fold, list[h])) changed = true

      // 表头挂在最终回复那一行里：收起后读起来就是「用户消息 → 用时 … → 最终回复」。
      // 挂在答案行而不是「本轮第一行」，是因为答案行收起/展开都在视口里，表头不会
      // 随着滚动换行 —— 换一次就是两次行高突变，正是抖动的来源。
      var answer = list[ai]
      fold.host = boxKey(answer)
      delete fold.rows[fold.host]
      if (!fold.label) fold.label = durationLabel(list) || "已折叠 " + Math.max(ai, fold.done) + " 步"
      if (ensureHead(answer, item.key, fold.label, !!turnOpen[item.key])) changed = true
    }

    // 会话滚很长时，太旧的轮就不记了：它们本来也在视口外
    var all = Object.keys(foldRows)
    if (all.length > 200) {
      for (var d = 0; d < all.length - 200; d++) delete foldRows[all[d]]
    }

    var keys = Object.keys(foldRows)
    for (var k = 0; k < keys.length; k++) {
      var entry = foldRows[keys[k]]
      if (turnOpen[keys[k]] || !entry.host) continue
      // 按「轮」写的结构规则：这一轮里、最终回复行之外的行，一律压扁。
      // 一条规则覆盖整轮 —— 包括那些还没挂上来的行；这样它们第一次布局时就已经是
      // 压扁的，官方量到 0，不会先记一个 60（估算值）或几百像素再纠正（那次纠正
      // 落在可视区里、官方不补滚动，就是「往回闪」）。
      //   · data-message-id = 这一轮 user 消息的 id，整轮的行共用
      //   · 排除 UserMessage 行（用户气泡本身）
      //   · 排除含 text-part-meta 的行（最终回复行，官方只在本轮最后一段正文上渲染它）
      //
      // 盒子和「被官方量的那一层」一起压扁。盒子那层的高度是官方按它以为的尺寸写在
      // 内联样式上的：刚挂上来的行官方还没量（或者是它估的 60），如果只压里面那层，
      // 画出来的是一条 60px 的空档，后面才被量成 0 收掉 —— 就是那一跳。两层都压掉，
      // 从第一帧起画出来的就是收起的长度。
      var turnSel =
        '[data-timeline-key]:has(>[data-index]>[data-message-id="' +
        cssSafe(keys[k]) +
        '"][data-timeline-row]:not([data-timeline-row="UserMessage"]))' +
        ':not(:has([data-slot="text-part-meta"]))'
      css.push(
        turnSel +
          '{height:0!important;min-height:0!important;padding-top:0!important;padding-bottom:0!important;overflow:hidden!important}',
      )
      css.push(
        turnSel +
          '>[data-index]{height:0!important;min-height:0!important;padding-top:0!important;padding-bottom:0!important;overflow:hidden!important;content-visibility:hidden}',
      )
    }

    // 表头只该留在它那一轮的「最终回复行」里（换轮、展开、行重挂之后都要清干净）
    var heads = content.querySelectorAll("." + HEAD_CLASS)
    for (var c = heads.length - 1; c >= 0; c--) {
      var toggle = heads[c].querySelector(".ocw-turn-toggle")
      var owner = toggle ? toggle.getAttribute("data-ocw-for") : ""
      var record = owner ? foldRows[owner] : null
      if (!record || !record.host || boxKey(heads[c]) !== record.host) heads[c].parentElement.removeChild(heads[c])
    }

    // 兜底标记同理：展开过的那一轮、或已经不再折的那一轮，标记要撤掉；
    // 最终回复行自己永远不压，所以它身上的标记也要撤。
    var marked = content.querySelectorAll("[data-ocw-fold]")
    for (var m = marked.length - 1; m >= 0; m--) {
      var markBox = marked[m]
      var markOwner = markBox.getAttribute("data-ocw-fold") || ""
      var markRecord = markOwner ? foldRows[markOwner] : null
      if (!markRecord || turnOpen[markOwner] || !markRecord.host || boxKey(markBox) === markRecord.host)
        markBox.removeAttribute("data-ocw-fold")
    }

    var sheet = foldStyle()
    var next = css.join("\n")
    if (sheet.textContent !== next) {
      sheet.textContent = next
      changed = true
    }

    return changed
  }

  function syncCompactions(content) {
    var nodes = content.querySelectorAll('[data-component="session-compaction-message"]')

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      var body = node.querySelector(':scope > [data-component="text-part"]')
      // 排队中 / 失败的压缩只有一条线，没有可折的总结
      if (!body || node.children.length < 2) continue

      var lead = node.children[0]
      var tail = node.children[node.children.length - 1]
      if (lead === tail || tail === body) continue

      if (!node.hasAttribute("data-ocw-compact")) {
        node.setAttribute("data-ocw-compact", "")
        lead.setAttribute("data-ocw-compact-lead", "")
        tail.setAttribute("data-ocw-compact-toggle", "")
        var label = tail.querySelector('[data-slot="session-timeline-notice-label"]')
        var holder = label && label.parentElement
        if (holder && !holder.querySelector(".ocw-compact-caret"))
          holder.appendChild(el("span", "ocw-turn-caret ocw-compact-caret", icon("chevron", 12)))
      }

      var key = boxKey(node)
      if (compactOpen[key]) node.setAttribute("data-ocw-open", "")
      else node.removeAttribute("data-ocw-open")
    }
  }

  function syncFold() {
    var content = document.querySelector("[data-timeline-virtual-content]")

    if (!content || !currentSessionId()) {
      if (foldObserver) {
        foldObserver.disconnect()
        foldObserver = null
      }
      foldWatch = null
      if (foldSheet) foldSheet.textContent = ""
      return
    }

    // 行挂上/卸下都要立刻重算，而且要**当场**（MutationObserver 回调是微任务，跑在
    // 这一帧的样式/布局之前）：这样新挂上来的一行在第一次布局时就已经是压扁的样子，
    // 官方量到的就是 0，不会出现「先按原高量一次、随后再收回」的行高突变 —— 那正是
    // 往上滚时看到的抖动。只盯直接子节点，滚起来的成本可以忽略。
    if (foldWatch !== content) {
      if (foldObserver) foldObserver.disconnect()
      foldWatch = content
      if (window.MutationObserver) {
        foldObserver = new MutationObserver(function () {
          syncFold()
        })
        foldObserver.observe(content, { childList: true })
      }
    }

    syncTurns(content)
    syncCompactions(content)
  }

  function scheduleFold() {
    if (foldFrame) return
    foldFrame = requestAnimationFrame(function () {
      foldFrame = 0
      syncFold()
    })
  }

  // 捕获阶段：抢在官方时间线上那个 onClick（点一下会清选区）之前把它吃掉
  function foldClick(event) {
    var target = event.target
    if (!target || !target.closest) return

    var toggle = target.closest(".ocw-turn-toggle")
    if (toggle) {
      var key = toggle.getAttribute("data-ocw-for")
      if (!key) return
      if (turnOpen[key]) delete turnOpen[key]
      else turnOpen[key] = true
      event.preventDefault()
      event.stopPropagation()
      scheduleFold()
      return
    }

    var line = target.closest("[data-ocw-compact-toggle]")
    if (line) {
      var block = line.closest("[data-ocw-compact]")
      var blockKey = boxKey(block)
      if (!blockKey) return
      if (compactOpen[blockKey]) delete compactOpen[blockKey]
      else compactOpen[blockKey] = true
      event.preventDefault()
      event.stopPropagation()
      scheduleFold()
    }
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

    addEventListener("popstate", function () {
      syncActive()
    })

    document.addEventListener("click", foldClick, true)

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
