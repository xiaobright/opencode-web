// Pure projection transform. Original objects and API messages are never mutated.
export function foldProjection(projection, args, api, isOpen) {
  const messages = args[0]
  const status = args[2]
  const byID = new Map(messages.map((message) => [message.id, message]))
  const assistantsByTurn = new Map()
  let owner
  for (const message of messages) {
    if (message.type === "user") owner = message.id
    if (message.type === "shell") owner = undefined
    if (message.type !== "assistant") continue
    owner ??= message.id
    const list = assistantsByTurn.get(owner) ?? []
    list.push(message)
    assistantsByTurn.set(owner, list)
  }
  const groups = new Map()
  for (const row of projection.rows) {
    const list = groups.get(row.userMessageID) ?? []
    list.push(row)
    groups.set(row.userMessageID, list)
  }
  const removed = new Set()
  const turns = []
  for (const [id, rows] of groups) {
    if (byID.get(id)?.type !== "user") continue
    if (status.type !== "idle" && id === projection.activeMessageID) continue
    const assistants = assistantsByTurn.get(id) ?? []
    if (!assistants.length || assistants.some((message) => message.time.completed === undefined || message.error || message.retry)) continue
    if (assistants.some((message) => message.content.some((part) => part.type === "tool" && part.state.status !== "completed"))) continue
    // Errors and special rows remain visible. Only ordinary assistant process rows are folded.
    const final = rows.findLastIndex((row) => {
      if (row._tag !== "AssistantPart" || row.group.type !== "part") return false
      const part = api.resolveContent(byID.get(row.group.ref.messageID), row.group.ref.partID)
      return part?.type === "text" && !!part.text.trim()
    })
    if (final < 0) continue
    const process = rows.slice(0, final).filter((row) => row._tag === "AssistantPart")
    if (!process.length) continue
    turns.push({ id, processRows: process.length, open: isOpen(id) })
    if (!isOpen(id)) process.forEach((row) => removed.add(row))
  }
  return { projection: { ...projection, rows: projection.rows.filter((row) => !removed.has(row)) }, turns, before: projection.rows.length, after: projection.rows.length - removed.size }
}
