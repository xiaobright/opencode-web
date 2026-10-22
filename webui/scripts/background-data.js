/* Shared, read-only session data for the sidebar and background monitor. */
;(function () {
  "use strict"
  var history = new Map()
  var cache = new Map()
  var metadataAt = new Map()
  var active = {}
  var next
  var paged = false
  var refreshed = 0
  var refreshing
  var loadingMore

  async function get(path, optional) {
    var response = await fetch(path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) })
    if (optional && response.status === 404) return undefined
    if (!response.ok) throw new Error("HTTP " + response.status)
    return response.json()
  }
  function array(body) {
    if (!Array.isArray(body && body.data)) throw new Error("会话数据格式不兼容")
    return body.data
  }
  async function parallel(items, work) {
    var index = 0
    var output = new Array(items.length)
    await Promise.all(Array.from({ length: Math.min(items.length, 4) }, async function () {
      while (index < items.length) {
        var at = index++
        output[at] = await work(items[at])
      }
    }))
    return output
  }
  function snapshot() {
    var all = Array.from(history.values()).filter(function (item) { return !(item.time && item.time.archived) })
    all.sort(function (a, b) {
      return Number(Boolean(active[b.id])) - Number(Boolean(active[a.id])) || ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0)
    })
    return {
      all: all,
      items: all.filter(function (item) { return item.metadata && item.metadata.origin === "opencode-delegate" && !item.parentID }),
      active: active,
      next: next,
    }
  }
  async function refresh(force) {
    if (refreshing) return refreshing
    if (!force && Date.now() - refreshed < 1000) return snapshot()
    refreshing = (async function () {
      var bodies = await Promise.all([get("/api/session?order=desc"), get("/api/session/active")])
      var listed = array(bodies[0])
      var running = bodies[1] && bodies[1].data
      if (!running || Array.isArray(running) || typeof running !== "object") throw new Error("运行状态格式不兼容")
      var ids = new Set(listed.map(function (item) { return item.id }))
      // The first page is not an inventory of running work. Resolve every missing
      // active session, with bounded concurrency, before deciding its origin.
      var missing = new Set(Object.keys(running).concat(Object.keys(active)))
      for (var item of history.values()) {
        if (item.metadata && item.metadata.origin === "opencode-delegate" && Date.now() - (metadataAt.get(item.id) || 0) >= 60000) missing.add(item.id)
      }
      var extra = await parallel(Array.from(missing).filter(function (id) { return !ids.has(id) }), async function (id) {
        var body = await get("/api/session/" + encodeURIComponent(id), true)
        if (body && (!body.data || body.data.id !== id)) throw new Error("会话详情格式不兼容")
        return { id: id, data: body && body.data }
      })
      for (var id of Object.keys(active)) if (!running[id]) cache.delete(id)
      for (var id of Object.keys(running)) cache.delete(id)
      active = running
      for (var entry of extra) {
        if (entry.data) listed.push(entry.data)
        else { history.delete(entry.id); cache.delete(entry.id); metadataAt.delete(entry.id) }
      }
      for (var item of listed) { history.set(item.id, item); metadataAt.set(item.id, Date.now()) }
      if (!paged) next = bodies[0].cursor && bodies[0].cursor.next
      refreshed = Date.now()
      return snapshot()
    })()
    try { return await refreshing } finally { refreshing = null }
  }
  async function loadMore() {
    if (loadingMore) return loadingMore
    loadingMore = (async function () {
      await refresh()
      if (!next) return snapshot()
      var cursor = next
      var body = await get("/api/session?cursor=" + encodeURIComponent(cursor))
      var items = array(body)
      for (var item of items) { history.set(item.id, item); metadataAt.set(item.id, Date.now()) }
      next = body.cursor && body.cursor.next
      if (next === cursor) next = undefined
      paged = true
      return snapshot()
    })()
    try { return await loadingMore } finally { loadingMore = null }
  }
  async function details(items) {
    return parallel(items, async function (session) {
      var previous = cache.get(session.id)
      var stamp = session.time && session.time.updated
      if (!active[session.id] && stamp !== undefined && previous && previous.stamp === stamp && !previous.error && !previous.pending) return previous
      try {
        var base = "/api/session/" + encodeURIComponent(session.id)
        var bodies = await Promise.all([get(base + "/message?limit=8"), get(base + "/inbox")])
        var detail = { stamp: stamp, messages: array(bodies[0]), pending: array(bodies[1]).length }
        cache.delete(session.id)
        cache.set(session.id, detail)
        while (cache.size > 200) cache.delete(cache.keys().next().value)
        return detail
      } catch (error) {
        return { messages: previous ? previous.messages : [], pending: previous && previous.pending, error: String(error.message || error) }
      }
    })
  }
  // 改名/移动之后直接改本地缓存：等下一次整表刷新会让标题先跳回旧的。
  function patchSession(id, changes) {
    var item = history.get(id)
    if (item) history.set(id, Object.assign({}, item, changes))
    cache.delete(id)
    return snapshot()
  }

  // 删除的会话不会出现在下一页里，历史表得主动清，否则它会一直留在侧栏。
  function forgetSession(id) {
    history.delete(id)
    cache.delete(id)
    metadataAt.delete(id)
    return snapshot()
  }

  window.__ocwBackground = { refresh: refresh, loadMore: loadMore, details: details, patch: patchSession, forget: forgetSession }
})()
