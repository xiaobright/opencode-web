/* 只保留阶段、工具名和 ID，不保存正文、命令参数或工具输出。 */
;(function () {
  "use strict"
  if (window.__ocwActivity) return
  var sessions = new Map()
  var version = 0
  var resetVersion = 0
  var disconnected = false
  var listeners = new Set()
  function notify() { listeners.forEach(function (listener) { listener() }) }
  function fresh(id) {
    var state = { phase: "waiting", tools: new Map(), permissions: new Set(), version: ++version }
    sessions.delete(id)
    sessions.set(id, state)
    if (sessions.size > 64) sessions.delete(sessions.keys().next().value)
    return state
  }
  function accept(event) {
    if (event.type === "server.connected") return
    var data = event.data
    if (!data || typeof data.sessionID !== "string") return
    var type = event.type
    if (!/^session\.(execution|step|text|reasoning|tool|retry|compaction)\./.test(type) && !/^permission\./.test(type)) return
    var id = data.sessionID
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(type) || type === "session.step.failed") {
      fresh(id).phase = "idle"
      notify()
      return
    }
    var state = sessions.get(id) || fresh(id)
    state.version = ++version
    if (type === "session.execution.started" || type === "session.step.started") state = fresh(id)
    if (/^session\.reasoning\.(started|delta)$/.test(type)) state.phase = "thinking"
    if (/^session\.text\.(started|delta)$/.test(type)) state.phase = "answer"
    if (/^session\.(reasoning|text)\.ended$/.test(type)) state.phase = "waiting"
    if (type === "session.step.streamed") state.phase = "working"
    if (type === "session.step.ended") { state.tools.clear(); state.phase = "waiting" }
    if (type === "session.retry.scheduled") state.phase = "retry"
    if (type === "session.compaction.started" || type === "session.compaction.delta") state.phase = "compacting"
    if (type === "session.compaction.ended" || type === "session.compaction.failed") state.phase = "waiting"
    if (type === "session.tool.input.started") state.tools.set(data.id, { name: data.name, running: false })
    if (type === "session.tool.called" || type === "session.tool.progress") {
      var tool = state.tools.get(data.id) || { name: "", running: true }
      tool.running = true
      state.tools.set(data.id, tool)
    }
    if (type === "session.tool.success" || type === "session.tool.failed") { state.tools.delete(data.id); state.phase = "waiting" }
    if (type === "permission.asked") state.permissions.add(data.id)
    if (type === "permission.replied") state.permissions.delete(data.requestID)
    notify()
  }
  // 侧栏的像素格动画只看这个：有状态且不在收尾态就亮。断线时一律视为空闲，
  // 否则恢复前所有行都会闪。idle 的状态留在表里只为节流，不算忙。
  function busy(id) {
    if (!id || disconnected) return false
    var state = sessions.get(id)
    return !!state && state.phase !== "idle"
  }
  // 事件流是否已经为这个会话收到过状态：用来让"收尾"立即可见，不必等下一次列表刷新。
  function known(id) {
    return !disconnected && sessions.has(id)
  }
  function label(id) {
    if (!id) return null
    if (disconnected) return { text: "状态连接已断开", title: "尚未恢复实时状态，不能确认任务当前阶段。" }
    var state = sessions.get(id)
    if (!state) return null
    if (state.permissions.size) return { text: "等待你的授权", title: "工具正在等待权限确认。" }
    var tools = Array.from(state.tools.values())
    var running = tools.filter(function (tool) { return tool.running })
    if (running.length > 1) return { text: "执行工具中（" + running.length + " 项）", title: "有多个尚未结束的工具调用。" }
    if (running.length) {
      var name = running[0].name || ""
      var names = { bash: "执行命令中", shell: "执行命令中", read: "读取文件中", glob: "搜索文件中", grep: "搜索文件中", edit: "修改文件中", write: "修改文件中", apply_patch: "修改文件中", webfetch: "检索资料中", websearch: "检索资料中", task: "子代理工作中", subagent: "子代理工作中", question: "等待你的回答" }
      return { text: names[name] || "执行工具中", title: name ? "当前工具：" + name.slice(0, 80) : "已收到工具执行事件。" }
    }
    if (tools.length) return { text: "准备工具调用", title: "模型正在生成工具参数，工具尚未开始执行。" }
    var phases = {
      thinking: ["思考中", "已收到模型的思考内容或思考开始事件。"],
      answer: ["生成回答中", "已收到模型的正文输出。"],
      waiting: ["等待模型输出", "暂未收到下一段模型内容；可能正在准备请求、等待响应，或上游正在内部计算。"],
      working: ["处理中", "模型本次输出已结束，任务仍在处理。"],
      retry: ["等待重试", "上游调用失败，任务已安排重试。"],
      compacting: ["整理上下文中", "正在压缩会话上下文。"],
    }
    var phase = phases[state.phase]
    return phase ? { text: phase[0], title: phase[1] } : null
  }
  // 从官方首批消息恢复刷新后的状态；较新的实时事件优先。
  function seed(id, messages, ticket) {
    if (!Array.isArray(messages) || ticket < resetVersion || (sessions.get(id)?.version || 0) > ticket) return
    var assistant = messages.filter(function (message) { return message.type === "assistant" }).sort(function (a, b) { return b.time.created - a.time.created })[0]
    if (!assistant || assistant.time.completed !== undefined || assistant.error) return
    var state = fresh(id)
    state.phase = assistant.retry ? "retry" : assistant.time.streamed !== undefined ? "working" : "waiting"
    ;(assistant.content || []).forEach(function (part) {
      if (part.type === "tool" && /^(streaming|running)$/.test(part.state.status)) state.tools.set(part.id, { name: part.name, running: part.state.status === "running" })
    })
    var last = (assistant.content || []).at(-1)
    if (!assistant.retry && assistant.time.streamed === undefined && last && last.time?.completed === undefined) {
      if (last.type === "reasoning") state.phase = "thinking"
      if (last.type === "text" && last.text) state.phase = "answer"
    }
    notify()
  }
  window.__ocwActivity = {
    accept: accept, label: label, seed: seed, busy: busy, known: known,
    version: function () { return version },
    subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener) } },
    connection: function (connected) { sessions.clear(); resetVersion = ++version; disconnected = !connected; notify() },
  }
})()
