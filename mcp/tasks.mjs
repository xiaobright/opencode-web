// Delegation bookkeeping: what a task is, how its state is derived from opencode's
// messages, and how its output is paged. The registry is only a convenience index —
// the durable identity is the opencode sessionID, which survives this process.

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const moduleDir = dirname(fileURLToPath(import.meta.url))

export function newTaskId() {
  return `task_${randomBytes(4).toString("hex")}`
}

export function deriveTitle(task) {
  const first = String(task ?? "").trim().split(/\r?\n/).find((line) => line.trim().length > 0) ?? "delegated task"
  const plain = first.replace(/^[#>*\-\s]+/, "").replace(/[`*_]/g, "").trim()
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

/**
 * Chronological view of one session's turns (oldest first), one entry per assistant
 * message plus the idle marker that closes a run.
 */
export function timeline(messagesNewestFirst) {
  return [...(messagesNewestFirst ?? [])].reverse().map((message) => ({
    id: message.id,
    type: message.type,
    at: message.time?.created ?? 0,
    completed: message.time?.completed !== undefined,
    text: message.type === "assistant" ? messageText(message) : "",
    tools: message.type === "assistant" ? toolNames(message) : [],
    finish: message.finish ?? null,
    outcome: message.outcome ?? null,
    tokens: message.tokens ?? null,
    cost: typeof message.cost === "number" ? message.cost : null,
  }))
}

/** Last assistant turn's metadata, used for the task summary line. */
export function lastTurn(messagesNewestFirst) {
  const assistant = (messagesNewestFirst ?? []).find((message) => message.type === "assistant")
  if (!assistant) return undefined
  return {
    at: assistant.time?.created ?? 0,
    finish: assistant.finish ?? null,
    tokens: assistant.tokens ?? null,
    cost: typeof assistant.cost === "number" ? assistant.cost : null,
    tools: toolNames(assistant),
  }
}

const OUTCOMES = { succeeded: "done", failed: "failed", interrupted: "cancelled" }

/** State of the last run, from the newest idle marker unless the loop is running now. */
export function stateFromMessages(messagesNewestFirst, { active = false } = {}) {
  if (active) return "running"
  const idle = (messagesNewestFirst ?? []).find((message) => message.type === "idle")
  if (idle) return OUTCOMES[idle.outcome] ?? "idle"
  const anyMessage = (messagesNewestFirst ?? []).length > 0
  return anyMessage ? "running" : "pending"
}

/**
 * Assistant text of the span after `cursor` (a message id), oldest first. Without a
 * cursor the whole readable window is returned. `truncated` says the span did not fit.
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
    const text = messageText(message)
    if (text) pieces.push(text)
  }

  const joined = pieces.join("\n\n")
  const truncated = joined.length > maxChars
  const text = truncated ? joined.slice(joined.length - maxChars) : joined
  const nextCursor = span.length > 0 ? span[span.length - 1].id : cursor

  return {
    text,
    nextCursor,
    truncated,
    messages: span.length,
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

/**
 * Small JSON registry so a restarted MCP process can still list and address past
 * delegations. Writes are atomic (temp file + rename) and never block a tool call.
 */
export class DelegationStore {
  constructor({ path } = {}) {
    // Next to this package, not the MCP client's cwd: agents spawn servers from arbitrary
    // project directories, and the registry must not litter them.
    this.path = path ?? join(moduleDir, ".state", "tasks.json")
    this.records = new Map()
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"))
      for (const record of parsed?.tasks ?? []) {
        if (record && typeof record.taskId === "string" && typeof record.sessionID === "string")
          this.records.set(record.taskId, record)
      }
    } catch {
      // A missing or corrupt registry only loses convenience, never sessions.
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({ tasks: [...this.records.values()] }, null, 2))
      renameSync(temp, this.path)
    } catch {
      // Best effort: the tool response already carries the durable sessionID.
    }
  }

  add(record) {
    this.records.set(record.taskId, record)
    this.save()
    return record
  }

  update(taskId, patch) {
    const record = this.records.get(taskId)
    if (!record) return undefined
    Object.assign(record, patch, { updatedAt: Date.now() })
    this.save()
    return record
  }

  list({ limit = 20 } = {}) {
    return [...this.records.values()]
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, limit)
  }

  /** Accepts a local task id or a durable session id. */
  find(ref) {
    if (!ref) return undefined
    const text = String(ref)
    if (this.records.has(text)) return this.records.get(text)
    return [...this.records.values()].find((record) => record.sessionID === text)
  }
}
