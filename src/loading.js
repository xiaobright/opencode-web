;(function () {
  "use strict"
  var status = document.getElementById("status")
  var description = document.getElementById("description")
  var spinner = document.querySelector(".spinner")
  var retry = document.getElementById("retry")
  var busy = false

  async function start() {
    if (busy) return
    busy = true
    retry.hidden = true
    spinner.hidden = false
    status.textContent = "正在加载…"
    description.textContent = "正在启动 OpenCode，稍后自动进入会话。"
    try {
      var response = await fetch("/__opencode-web/start", { method: "POST", signal: AbortSignal.timeout(150000) })
      var result = await response.json()
      if (!response.ok || !result.ready) throw new Error("后台服务未就绪")
      status.textContent = "正在打开会话…"
      // Keep the requested route, query and hash, including saved deep links.
      location.reload()
    } catch (error) {
      spinner.hidden = true
      status.textContent = "OpenCode 启动失败"
      description.textContent = "请确认 OpenCode 已安装且可以启动，然后重试。"
      retry.hidden = false
    } finally {
      busy = false
    }
  }
  retry.addEventListener("click", start)
  start()
})()
