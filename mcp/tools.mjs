// Two tools, split by what a caller actually needs:
//
//   opencode_delegate  hand over a task (a sentence and a working directory)
//   opencode_session   talk to that session: status, wait, message, cancel
//
// Nothing here leaks how the delegation is wired. Model choice, permissions, caller
// identity and the title are server-side decisions (environment), not parameters —
// a caller has no way to know which free model is good today, and does not need to.

import { normalizeDirectory } from "./opencode.mjs"
import { deriveTitle, formatAge, lastAssistantText, readOutput, stateFromMessages } from "./tasks.mjs"
import { rankingPath, readRanking, selectModel } from "../src/models.mjs"

// Sessions created here carry this metadata origin, which is how the web UI and the tray
// tell delegated background work apart from sessions a human opened.
export const BACKGROUND_ORIGIN = "opencode-delegate"

const ACTIONS = ["status", "wait", "message", "cancel"]

function settings(env) {
  const number = (key, fallback) => {
    const value = Number(env[key])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    // Empty means "no pin": the web UI's ranking decides.
    model: env.OPENCODE_MCP_MODEL || "",
    // Delegated work must run in a directory the caller chose: an implicit cwd scatters
    // sessions into whatever directory the MCP client happened to spawn the server in.
    directory: env.OPENCODE_MCP_DIRECTORY || "",
    caller: env.OPENCODE_MCP_CALLER || "mcp",
    delegateWaitMs: number("OPENCODE_MCP_DELEGATE_WAIT_MS", 20_000),
    waitMs: number("OPENCODE_MCP_WAIT_MS", 60_000),
    maxChars: number("OPENCODE_MCP_MAX_CHARS", 8_000),
  }
}

function fail(tool, message) {
  const error = new Error(`${tool}: ${message}`)
  error.toolError = true
  throw error
}

function rejectUnexpected(args, allowed, tool) {
  const unexpected = Object.keys(args ?? {}).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0)
    fail(tool, `unexpected parameter(s): ${unexpected.join(", ")}. Allowed: ${[...allowed].sort().join(", ")}.`)
}

function requireString(args, key, tool) {
  const value = args?.[key]
  if (typeof value !== "string" || value.trim().length === 0)
    fail(tool, `parameter "${key}" is required and must be a non-empty string.`)
  return value
}

function optionalString(args, key) {
  return typeof args?.[key] === "string" ? args[key] : undefined
}

function oneOf(value, allowed, tool, key) {
  if (value === undefined) fail(tool, `parameter "${key}" is required and must be one of: ${allowed.join(", ")}.`)
  if (!allowed.includes(value)) fail(tool, `parameter "${key}" must be one of: ${allowed.join(", ")}.`)
  return value
}

/** One line of identity, then whatever the caller asked for; no wiring details. */
function head(sessionID, state, detail) {
  return `Session ${sessionID} · ${state}${detail ? ` · ${detail}` : ""}`
}

function withBody(line, text, truncated) {
  const body = text || "(no output yet)"
  return `${line}\n\n${body}${truncated ? "\n\n[output truncated]" : ""}`
}

export function createTools({ api, env = process.env } = {}) {
  const config = settings(env)

  // The model is an operator decision: OPENCODE_MCP_MODEL pins one, otherwise the web
  // UI's ranking decides, otherwise the first free tool-capable model in the catalog.
  const resolveModel = async () => {
    const models = await api.catalog()
    const chosen = selectModel(models, readRanking(rankingPath(env)), config.model)
    if (!chosen) throw new Error("no free tool-capable model is available")
    return { providerID: chosen.providerID, id: chosen.id }
  }

  async function currentState(sessionID, completed) {
    if (completed) return "done"
    const active = await api.activeSessions().catch(() => new Set())
    const messages = await api.messages(sessionID, 20)
    return stateFromMessages(messages, { active: active.has(sessionID) })
  }

  /* ── opencode_delegate ───────────────────────────────────────────────── */

  async function delegate(args = {}) {
    const tool = "opencode_delegate"
    rejectUnexpected(args, ["task", "directory"], tool)
    const task = requireString(args, "task", tool)
    const directory = normalizeDirectory(
      optionalString(args, "directory") ||
        config.directory ||
        fail(tool, "pass directory or set OPENCODE_MCP_DIRECTORY: delegated sessions need an explicit working directory."),
    )
    const model = await resolveModel()

    const session = await api.createSession({
      title: deriveTitle(task),
      directory,
      model,
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      metadata: { origin: BACKGROUND_ORIGIN, caller: config.caller },
    })
    await api.prompt(session.id, task)

    // A short wait makes a quick task a single round-trip; anything longer becomes a
    // session to poll, which is the normal way to talk to a subagent.
    const waited = await api.wait(session.id, config.delegateWaitMs)
    if (!waited.completed)
      return {
        text: `${head(session.id, "running")}\n\nContinue: opencode_session action="wait" session_id="${session.id}"`,
        structured: { session_id: session.id, state: "running" },
      }

    const messages = await api.messages(session.id, 100)
    const output = readOutput(messages, { maxChars: config.maxChars })
    return {
      text: withBody(head(session.id, "done", `${(waited.waitedMs / 1000).toFixed(1)}s`), output.text, output.truncated),
      structured: { session_id: session.id, state: "done", text: output.text, truncated: output.truncated },
    }
  }

  /* ── opencode_session ────────────────────────────────────────────────── */

  async function session(args = {}) {
    const tool = "opencode_session"
    rejectUnexpected(args, ["action", "session_id", "text"], tool)
    const action = oneOf(args.action, ACTIONS, tool, "action")
    const sessionID = requireString(args, "session_id", tool)

    if (action === "status") {
      const messages = await api.messages(sessionID, 20)
      const active = await api.activeSessions().catch(() => new Set())
      const state = stateFromMessages(messages, { active: active.has(sessionID) })
      const updated = messages[0]?.time?.created ?? 0
      const detail = updated ? `${formatAge(updated)} ago` : undefined
      return {
        text: withBody(head(sessionID, state, detail), lastAssistantText(messages)),
        structured: { session_id: sessionID, state, text: lastAssistantText(messages) },
      }
    }

    if (action === "wait") {
      const waited = await api.wait(sessionID, config.waitMs)
      const messages = await api.messages(sessionID, 100)
      const state = await currentState(sessionID, waited.completed)
      if (!waited.completed)
        return {
          text: `${head(sessionID, state)}\n\nStill running; call action="wait" again to keep waiting.`,
          structured: { session_id: sessionID, state, waited_ms: waited.waitedMs },
        }
      const output = readOutput(messages, { maxChars: config.maxChars })
      return {
        text: withBody(head(sessionID, state, `waited ${(waited.waitedMs / 1000).toFixed(1)}s`), output.text, output.truncated),
        structured: { session_id: sessionID, state, text: output.text, truncated: output.truncated, waited_ms: waited.waitedMs },
      }
    }

    if (action === "message") {
      const text = requireString(args, "text", tool)
      // Read the boundary first so the reply is the delta, not the previous turn.
      const before = await api.messages(sessionID, 1)
      const cursor = before[0]?.id
      await api.prompt(sessionID, text)
      const waited = await api.wait(sessionID, config.waitMs)
      const messages = await api.messages(sessionID, 100)
      const state = await currentState(sessionID, waited.completed)
      if (!waited.completed)
        return {
          text: `${head(sessionID, state)}\n\nStill running; call action="wait" again to keep waiting.`,
          structured: { session_id: sessionID, state, waited_ms: waited.waitedMs },
        }
      const output = readOutput(messages, { cursor, maxChars: config.maxChars })
      return {
        text: withBody(head(sessionID, state, `waited ${(waited.waitedMs / 1000).toFixed(1)}s`), output.text, output.truncated),
        structured: { session_id: sessionID, state, text: output.text, truncated: output.truncated, waited_ms: waited.waitedMs },
      }
    }

    // cancel
    await api.interrupt(sessionID)
    const waited = await api.wait(sessionID, 15_000)
    const messages = await api.messages(sessionID, 20)
    const active = waited.completed ? false : (await api.activeSessions().catch(() => new Set())).has(sessionID)
    const state = stateFromMessages(messages, { active })
    return {
      text: head(sessionID, state),
      structured: { session_id: sessionID, state },
    }
  }

  return {
    opencode_delegate: {
      title: "Delegate a task",
      description:
        "Run one task in a fresh opencode session. Returns the answer, or the session id while it is still running.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The complete instruction for the agent." },
          directory: { type: "string", description: "Working directory for the task." },
        },
        required: ["task"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      handler: delegate,
    },
    opencode_session: {
      title: "Talk to a delegated session",
      description: "Check a delegated session, wait for it, send a follow-up, or cancel it.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ACTIONS, description: "status, wait, message or cancel." },
          session_id: { type: "string", description: "Session id returned by opencode_delegate." },
          text: { type: "string", description: 'Follow-up instruction for action="message".' },
        },
        required: ["action", "session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      handler: session,
    },
  }
}
