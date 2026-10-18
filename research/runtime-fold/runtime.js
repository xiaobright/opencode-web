(() => {
  let mode = "closed"
  const opened = new Set()
  let refresh
  let scheduled = false
  let toolbar
  // PROJECT_FUNCTION
  const hook = globalThis.__ocwFold = {
    stats: null,
    setAll(open) { mode = open ? "open" : "closed"; opened.clear(); refresh?.((value) => value + 1) },
    toggle(id) { opened.has(id) ? opened.delete(id) : opened.add(id); refresh?.((value) => value + 1) },
    wrap(original, api, createSignal) {
      const [revision, setRevision] = createSignal(0)
      refresh = setRevision
      return function (...args) {
        revision()
        const result = foldProjection(original.apply(this, args), args, api, (id) => mode === "open" ? !opened.has(id) : opened.has(id))
        hook.stats = { before: result.before, after: result.after, turns: result.turns }
        if (!scheduled) {
          scheduled = true
          queueMicrotask(() => { scheduled = false; renderToolbar() })
        }
        return result.projection
      }
    },
  }
  function renderToolbar() {
    if (!toolbar) {
      toolbar = document.createElement("aside")
      toolbar.id = "ocw-fold-research"
      toolbar.setAttribute("aria-label", "折叠实验控制")
      toolbar.style.cssText = "position:fixed;right:12px;top:60px;z-index:100000;background:Canvas;color:CanvasText;border:1px solid GrayText;padding:8px;max-width:320px;font:13px system-ui"
      const label = document.createElement("div")
      label.textContent = "实验：在官方生成行时折叠"
      toolbar.append(label)
      for (const [text, open] of [["展开全部过程", true], ["收起全部过程", false]]) {
        const button = document.createElement("button")
        button.textContent = text
        button.onclick = () => hook.setAll(open)
        toolbar.append(button)
      }
      const select = document.createElement("select")
      select.setAttribute("aria-label", "选择折叠轮次")
      toolbar.append(select)
      const toggle = document.createElement("button")
      toggle.textContent = "切换所选轮次"
      toggle.onclick = () => hook.toggle(select.value)
      toolbar.append(toggle)
      const output = document.createElement("output")
      output.style.display = "block"
      toolbar.append(output)
      document.body.append(toolbar)
    }
    toolbar.querySelector("output").textContent = `时间线行数 ${hook.stats.before} → ${hook.stats.after}`
    const select = toolbar.querySelector("select")
    const selected = select.value
    select.replaceChildren(...hook.stats.turns.map((turn, index) => {
      const option = document.createElement("option")
      option.value = turn.id
      option.textContent = `第 ${index + 1} 轮（${turn.open ? "展开" : "收起"}）`
      return option
    }))
    if (hook.stats.turns.some((turn) => turn.id === selected)) select.value = selected
  }
})()
