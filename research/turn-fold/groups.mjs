// A per-projection-instance cache. Stores references and small summaries, never duplicates tool bodies.
export function createGroups() {
  const analysed = new WeakMap()
  const summaries = new Map()
  return function group(projection, messages, status, api, isOpen) {
    const stats = { scannedMessages: messages.length, analysedParts: 0, cacheHits: 0, turns: [], before: projection.rows.length }
    const owners = new Map()
    let owner
    for (const message of messages) {
      if (message.type === "user") {
        owner = { id: message.id, created: message.time.created, assistants: [], safe: true, tools: 0, parts: 0, ended: 0 }
        owners.set(message.id, owner)
      }
      if (message.type === "shell") owner = undefined
      if (!owner) continue
      if (message.type === "idle" && message.outcome !== "succeeded") owner.safe = false
      if (message.type !== "assistant") continue
      let info = analysed.get(message)
      // Completed parts remain reactive: read their structural/status fields to invalidate changed records.
      const signature = [message.time.completed, message.error, message.retry, message.content, ...message.content.flatMap((p) => [p, p.type === "tool" ? p.state.status : !!p.text.trim()])]
      if (!info || info.signature.length !== signature.length || signature.some((value, i) => value !== info.signature[i])) {
        info = { signature, safe: message.time.completed !== undefined && !message.error && !message.retry && message.content.every((p) => p.type !== "tool" || p.state.status === "completed"), tools: message.content.filter((p) => p.type === "tool").length }
        analysed.set(message, info)
        stats.analysedParts += message.content.length
      } else stats.cacheHits++
      owner.safe &&= info.safe
      owner.tools += info.tools
      owner.parts += message.content.length
      owner.ended = Math.max(owner.ended, message.time.completed ?? 0)
      owner.assistants.push(message)
    }
    const rowsByOwner = new Map()
    for (const row of projection.rows) {
      const list = rowsByOwner.get(row.userMessageID) ?? []
      list.push(row)
      rowsByOwner.set(row.userMessageID, list)
    }
    const removed = new Set()
    const insert = new Map()
    const retained = new Set()
    for (const [id, turn] of owners) {
      if (!turn.safe || !turn.assistants.length || (status.type !== "idle" && id === projection.activeMessageID)) continue
      const rows = rowsByOwner.get(id) ?? []
      // Preserve every trailing text block of the last assistant response. Don't mistake each block for a turn.
      const lastTextMessage = turn.assistants.findLast((m) => m.content.some((p) => p.type === "text" && p.text.trim()))
      if (!lastTextMessage) continue
      const final = rows.findLastIndex((r) => r._tag === "AssistantPart" && r.group.type === "part" && r.group.ref.messageID === lastTextMessage.id && api.resolveContent(lastTextMessage, r.group.ref.partID)?.type === "text")
      if (final < 0) continue
      let firstFinal = final
      while (firstFinal > 0) {
        const r = rows[firstFinal - 1]
        if (r._tag !== "AssistantPart" || r.group.type !== "part" || r.group.ref.messageID !== lastTextMessage.id || api.resolveContent(lastTextMessage, r.group.ref.partID)?.type !== "text") break
        firstFinal--
      }
      const process = rows.slice(0, firstFinal).filter((r) => r._tag === "AssistantPart")
      if (!process.length) continue
      const open = isOpen(id)
      const metadata = { id, open, tools: turn.tools, processRows: process.length, durationMs: Math.max(0, turn.ended - turn.created) }
      const signature = JSON.stringify(metadata)
      let record = summaries.get(id)
      if (record?.signature !== signature) {
        // Use an official row class and a unique key; empty refs keep native tool-group key reuse separate.
        const row = new process[0].constructor({ userMessageID: id, previousAssistantPart: false, group: { type: "context", key: `ocw-process:${id}`, refs: [], ocw: metadata } })
        record = { signature, row }
        summaries.set(id, record)
      }
      retained.add(id)
      insert.set(process[0], record.row)
      if (!open) process.forEach((r) => removed.add(r))
      stats.turns.push(metadata)
    }
    for (const id of summaries.keys()) if (!retained.has(id)) summaries.delete(id)
    const rows = projection.rows.flatMap((row) => [...(insert.has(row) ? [insert.get(row)] : []), ...(removed.has(row) ? [] : [row])])
    stats.after = rows.length
    return { projection: { ...projection, rows }, stats }
  }
}
