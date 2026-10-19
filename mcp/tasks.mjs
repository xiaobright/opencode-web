// Reading opencode's message stream: turn text, run state, bounded output.
//
// The unit is the opencode session. There is deliberately no local task registry:
// a session already lives in the background service, outlives this MCP process, and
// shows up in the web UI, so a second handle would only be something to lose.

import { stripProtocol } from "./progress.mjs"

export function deriveTitle(task) {
  const first = String(task ?? "").trim().split(/\r?\n/).find((line) => line.trim().length > 0) ?? "delegated task"
  // Strip markdown emphasis, but keep underscores: they belong to code identifiers.
  const plain = first.replace(/^[#>*\-\s]+/, "").replace(/[`*]/g, "").trim()
  return plain.length > 64 ? `${plain.slice(0, 63)}…` : plain || "delegated task"
}

export function partText(part) {
  return part && part.type === "text" && typeof part.text === "string" ? part.text : ""
}

export function messageText(message) {
  return (message?.content ?? []).map(partText).filter(Boolean).join("")
}

export function toolNames(message) {
  return (message?.content ?? [])
    .filter((part) => part.type === "tool" && typeof part.name === "string")
    .map((part) => part.name)
}

/** Text of the newest assistant message, what a status check or a wait reports. */
export function lastAssistantText(messagesNewestFirst) {
  const assistant = (messagesNewestFirst ?? []).find((message) => message.type === "assistant")
  return assistant ? messageText(assistant) : ""
}

/** Last assistant turn's tool names and finish reason. */
export function lastTurn(messagesNewestFirst) {
  const assistant = (messagesNewestFirst ?? []).find((message) => message.type === "assistant")
  if (!assistant) return undefined
  return {
    at: assistant.time?.created ?? 0,
    finish: assistant.finish ?? null,
    tools: toolNames(assistant),
  }
}

const OUTCOMES = { succeeded: "done", failed: "failed", interrupted: "cancelled" }

/** State of the last run, from the newest idle marker unless the loop is running now. */
export function stateFromMessages(messagesNewestFirst, { active = false, pending = 0 } = {}) {
  if (active) return "running"
  if (pending) return "queued"
  for (const message of messagesNewestFirst ?? []) {
    if (message.type === "idle") return OUTCOMES[message.outcome] ?? "idle"
    // Delivery alone proves neither current ownership nor completion after a restart.
    if (message.type === "user") return "unknown"
  }
  return (messagesNewestFirst ?? []).length > 0 ? "unknown" : "pending"
}

/**
 * Assistant text in the latest user turn, oldest first. The boundary is persisted by
 * opencode, so a later wait or a restarted MCP process reads the same turn. An explicit
 * cursor may narrow the span further. `truncated` says the text did not fit.
 */
export function readOutput(messagesNewestFirst, { cursor, inputID, maxChars = 8_000, protocol = true } = {}) {
  const chronological = [...(messagesNewestFirst ?? [])].reverse()
  let start = 0
  for (let index = 0; index < chronological.length; index++) {
    if (chronological[index].type === "user") start = index + 1
  }
  if (inputID) {
    const at = chronological.findIndex((message) => message.id === inputID && message.type === "user")
    if (at < 0) return { text: "", truncated: true, assistantMessages: 0 }
    start = at + 1
  }
  if (cursor) {
    const at = chronological.findIndex((message) => message.id === cursor)
    if (at >= 0) start = Math.max(start, at + 1)
  }

  const span = chronological.slice(start)
  const pieces = []
  for (const message of span) {
    if (message.type === "idle") break
    if (message.type !== "assistant") continue
    const text = protocol ? stripProtocol(messageText(message)) : messageText(message)
    if (text) pieces.push(text)
  }

  const joined = pieces.join("\n\n")
  const truncated = joined.length > maxChars
  return {
    text: truncated ? joined.slice(joined.length - maxChars) : joined,
    truncated,
    assistantMessages: pieces.length,
  }
}

/** Prefer the newest pending user input, otherwise the newest delivered input. */
export async function latestInput(api, sessionID) {
  const pending = await api.inbox(sessionID)
  const queued = pending.filter((item) => item.type === "user").at(-1)
  if (queued) return queued.id
  const users = await api.messagePage(sessionID, { type: "user", limit: 1 })
  // User.time.created is delivery time, Inbox.time.created is admission time; they
  // cannot be sorted together to reconstruct a global admission sequence.
  return users.data[0]?.id
}

/** Inbox, persisted delivery/idle boundaries and live process ownership are separate facts. */
export async function readSnapshot(api, sessionID, inputID) {
  const pending = await api.inbox(sessionID)
  const queued = pending.some((item) => item.id === inputID)
  const messages = []
  let cursor
  let historyTruncated = false
  const seen = new Set()
  for (let page = 0; page < 5; page++) {
    const result = await api.messagePage(sessionID, { cursor })
    messages.push(...result.data.filter((item) => !seen.has(item.id)))
    for (const item of result.data) seen.add(item.id)
    if (queued || !inputID || messages.some((item) => item.id === inputID)) break
    if (!result.cursor.next || result.cursor.next === cursor) break
    cursor = result.cursor.next
    if (page === 4) historyTruncated = true
  }
  // Probe after history: a wait can return before a new execution starts.
  const active = (await api.activeSessions()).has(sessionID)
  const at = inputID ? messages.findIndex((item) => item.id === inputID && item.type === "user") : -1
  const boundary = at < 0 ? undefined : messages.slice(0, at).reverse().find((item) => item.type === "idle")
  const lastIdle = messages.find((item) => item.type === "idle")
  const inputStatus = queued ? "queued" : at >= 0 ? (boundary ? "settled" : "delivered") : "unknown"
  // A process shutdown need not write an idle marker. Never infer success from absence
  // in /active, nor reuse an older input's outcome for a parked/new input.
  let state = stateFromMessages(messages, { active, pending: pending.length })
  if (boundary && !active && !pending.length) state = OUTCOMES[boundary.outcome] ?? "idle"
  if (inputID && inputStatus === "unknown" && !active && !pending.length) state = "unknown"
  return {
    state, messages, inputID, inputStatus, pending: pending.length, historyTruncated,
    lastOutcome: lastIdle?.outcome,
    inputOutcome: boundary?.outcome,
  }
}

export function formatAge(from, now = Date.now()) {
  if (!from) return "unknown"
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}
