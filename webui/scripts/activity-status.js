/* 观察官方已有请求；流按原字节转交，不另开事件连接、不保存历史内容。 */
;(function () {
  "use strict"
  var activity = window.__ocwActivity
  if (!activity || window.__ocwActivityStatus) return
  window.__ocwActivityStatus = true
  var originalFetch = window.fetch
  var streamGeneration = 0
  var selector = '[data-component="session-working"]'
  var nodes = new Set()
  var scheduled = false

  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(function () { scheduled = false; render() })
  }
  function render() {
    var match = /\/session\/([^/?#]+)/.exec(location.pathname)
    var label = activity.label(match ? decodeURIComponent(match[1]) : "")
    nodes.forEach(function (node) {
      if (!node.isConnected) { nodes.delete(node); return }
      var own = node.querySelector(".ocw-activity-label")
      if (!label) { node.removeAttribute("data-ocw-activity"); if (own) own.remove(); return }
      if (!own) { own = document.createElement("span"); own.className = "ocw-activity-label"; node.appendChild(own) }
      if (own.textContent !== label.text) own.textContent = label.text
      if (own.title !== label.title) own.title = label.title
      node.setAttribute("data-ocw-activity", "true")
    })
  }
  function register(root) {
    if (root.nodeType !== 1) return
    if (root.matches(selector)) nodes.add(root)
    root.querySelectorAll(selector).forEach(function (node) { nodes.add(node) })
  }
  register(document.documentElement)
  new MutationObserver(function (changes) {
    var found = false
    changes.forEach(function (change) {
      change.addedNodes.forEach(function (node) {
        if (node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))) { register(node); found = true }
      })
    })
    if (found) schedule()
  }).observe(document.documentElement, { childList: true, subtree: true })
  activity.subscribe(schedule)
  addEventListener("popstate", schedule)
  ;["pushState", "replaceState"].forEach(function (name) {
    var original = history[name]
    history[name] = function () { var result = original.apply(this, arguments); schedule(); return result }
  })

  function observeStream(response) {
    var generation = ++streamGeneration
    activity.connection(true)
    var reader = response.body.getReader()
    var decoder = new TextDecoder()
    var buffer = ""
    var skipping = false
    var limit = 256 * 1024
    function disconnected() { if (generation === streamGeneration) activity.connection(false) }
    function inspect(bytes) {
      if (generation !== streamGeneration) return
      buffer += decoder.decode(bytes, { stream: true })
      var boundary
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        var frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (!skipping && frame.length <= limit) {
          var data = frame.split(/\r\n|\n|\r/).filter(function (line) { return line.startsWith("data:") }).map(function (line) { return line.slice(5).replace(/^ /, "") }).join("\n")
          if (data) { try { activity.accept(JSON.parse(data)) } catch (error) { /* 不影响官方消费原始事件。 */ } }
        } else activity.connection(true)
        skipping = false
      }
      // 大型工具结果只透传；未完成事件最多保留 256K 字符，超限回退通用状态。
      if (buffer.length > limit) { buffer = buffer.slice(-3); skipping = true; activity.connection(true) }
    }
    var body = new ReadableStream({
      async pull(controller) {
        try {
          var result = await reader.read()
          if (result.done) { disconnected(); controller.close(); return }
          controller.enqueue(result.value)
          try { inspect(result.value) } catch (error) { /* 状态增强不能中断正文流。 */ }
        } catch (error) { disconnected(); controller.error(error) }
      },
      cancel(reason) { disconnected(); return reader.cancel(reason) },
    })
    var observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    ;["url", "redirected", "type"].forEach(function (key) { Object.defineProperty(observed, key, { value: response[key] }) })
    return observed
  }
  window.fetch = function (input, init) {
    var url
    try { url = new URL(input instanceof Request ? input.url : input, location.href) } catch (error) { return originalFetch.call(this, input, init) }
    if (url.origin !== location.origin) return originalFetch.call(this, input, init)
    var eventStream = url.pathname === "/api/event"
    var messages = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (!eventStream && (!messages || url.searchParams.has("cursor"))) return originalFetch.call(this, input, init)
    var ticket = activity.version()
    return originalFetch.call(this, input, init).then(function (response) {
      if (eventStream && response.ok && response.body && (response.headers.get("content-type") || "").includes("text/event-stream")) return observeStream(response)
      if (messages && response.ok) {
        ;["json", "text"].forEach(function (method) {
          var read = response[method].bind(response)
          response[method] = async function () {
            var value = await read()
            try {
              // 当前 SDK 用 text() 后自行解析；不另外读取/复制响应流。
              var data = method === "text" ? JSON.parse(value) : value
              activity.seed(decodeURIComponent(messages[1]), data.data, ticket)
            } catch (error) { /* 未知消息结构回退为官方状态。 */ }
            return value
          }
        })
      }
      return response
    })
  }
  schedule()
})()
