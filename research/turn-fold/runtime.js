(() => {
  // GROUP_ENGINE
  const enabled = __GROUP_ENABLED__
  const opened = new Set()
  const anchorOffsets = new Map()
  const hook = globalThis.__ocwGroup = {
    stats: {}, calls: [], revisions: 0,
    wrap(original, api, signal) {
      const [revision, refresh] = signal(0)
      const group = createGroups()
      hook.toggle = (id) => { opened.has(id) ? opened.delete(id) : opened.add(id); refresh((n) => n + 1) }
      return function (...args) {
        revision()
        const start = performance.now()
        const projection = original.apply(this, args)
        const nativeMs = performance.now() - start
        const result = enabled ? group(projection, args[0], args[2], api, (id) => opened.has(id)) : { projection, stats: { before: projection.rows.length, after: projection.rows.length, turns: [] } }
        hook.stats = { ...result.stats, messages: args[0].length }
        hook.revisions++
        hook.calls.push({ nativeMs, groupMs: performance.now() - start - nativeMs, messages: args[0].length, partsAnalysed: result.stats.analysedParts ?? 0 })
        if (hook.calls.length > 2000) hook.calls.shift()
        return result.projection
      }
    },
    render(original, row, onSizeChange, anchorChange) {
      const info = row().group?.ocw
      if (!info) return original(row, onSizeChange)
      const root = document.createElement("div")
      root.dataset.timelineRow = "process-summary"
      root.dataset.messageId = info.id
      root.dataset.ocwProcess = info.id
      root.dataset.timelinePartId = `ocw-summary:${info.id}`
      root.style.cssText = "height:40px;width:100%;max-width:768px;margin-inline:auto;padding:4px 24px;box-sizing:border-box;"
      root.style.scrollMarginTop = `${anchorOffsets.get(info.id) ?? 0}px`
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.ocwToggle = info.id
      button.setAttribute("aria-expanded", String(info.open))
      const seconds = Math.round(info.durationMs / 1000)
      const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
      button.textContent = `${info.open ? "▾" : "▸"} 用时 ${duration} · ${info.tools} 次工具调用 · ${info.open ? "收起过程" : "展开过程"}`
      button.style.cssText = "display:block;width:100%;height:32px;line-height:30px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:6px;padding:0 10px;background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;cursor:pointer;font-size:13px;"
      button.onclick = () => {
        const viewport = root.closest(".scroll-view__viewport")
        const offset = viewport ? Math.max(0, root.getBoundingClientRect().top - viewport.getBoundingClientRect().top) : 0
        anchorOffsets.set(info.id, offset)
        root.style.scrollMarginTop = `${offset}px`
        anchorChange(root.dataset.timelinePartId, () => hook.toggle(info.id))
        onSizeChange?.()
      }
      root.append(button)
      return root
    },
  }
})()
