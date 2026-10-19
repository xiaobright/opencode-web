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
export function stateFromMessages(messagesNewestFirst, { active = false } = {}) {
  if (active) return "running"
  const idle = (messagesNewestFirst ?? []).find((message) => message.type === "idle")
  if (idle) return OUTCOMES[idle.outcome] ?? "idle"
  return (messagesNewestFirst ?? []).length > 0 ? "running" : "pending"
}

/**
 * Assistant text after `cursor` (a message id), oldest first; without a cursor the whole
 * readable window. `truncated` says the span did not fit.
 */
export function readOutput(messagesNewestFirst, { cursor, maxChars = 8_000 } = {}) {
  const chronological = [...(messagesNewestFirst ?? [])].reverse()
  let start = 0
  if (cursor) {
    const at = chronological.findIndex((message) => message.id === cursor)
    if (at >= 0) start = at + 1
  }

  const span = chronological.slice(start)
  const pieces = []
  for (const message of span) {
    if (message.type !== "assistant") continue
    const text = stripProtocol(messageText(message))
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

export function formatAge(from, now = Date.now()) {
  if (!from) return "unknown"
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}
