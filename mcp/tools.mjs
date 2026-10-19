// Two tools, split by what a caller actually needs:
//
//   opencode_delegate  hand over a task (a sentence and a working directory)
//   opencode_session   talk to that session: status, wait, message, cancel
//
// Nothing here leaks how the delegation is wired. Model choice, permissions, caller
// identity and the title are server-side decisions (environment), not parameters —
// a caller has no way to know which free model is good today, and does not need to.
//
// Delegated sessions get a working agreement: a plan line, then one progress line per
// step. That is what status/wait report back, and what the reminder nudges when the
// agent goes quiet. opencode V2 removed the todo tool, so the protocol is plain text.

import { normalizeDirectory } from "./opencode.mjs"
import { deriveTitle, formatAge, lastAssistantText, readOutput, stateFromMessages } from "./tasks.mjs"
import { AGREEMENT, PLAN_AGREEMENT, REMINDER, formatDuration, isSilent, renderProgress } from "./progress.mjs"
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
    protocol: env.OPENCODE_MCP_PROTOCOL !== "off",
    delegateWaitMs: number("OPENCODE_MCP_DELEGATE_WAIT_MS", 20_000),
    waitMs: number("OPENCODE_MCP_WAIT_MS", 60_000),
    maxChars: number("OPENCODE_MCP_MAX_CHARS", 8_000),
    silentMs: number("OPENCODE_MCP_SILENT_MS", 60_000),
    nudgeMs: number("OPENCODE_MCP_NUDGE_MS", 90_000),
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
  const nudges = new Map()

  // The model is an operator decision: OPENCODE_MCP_MODEL pins one, otherwise the web
  // UI's ranking decides, otherwise the first free tool-capable model in the catalog.
  const resolveModel = async () => {
    const models = await api.catalog()
    const chosen = selectModel(models, readRanking(rankingPath(env)), config.model)
    if (!chosen) throw new Error("no free tool-capable model is available")
    return { providerID: chosen.providerID, id: chosen.id }
  }

  /** State and messages in one read; `completed` skips the active probe. */
  async function snapshot(sessionID, completed, limit = 40) {
    const messages = await api.messages(sessionID, limit)
    // A finished wait still has to read the idle marker: it carries done / failed / cancelled.
    if (completed) return { state: stateFromMessages(messages, { active: false }), messages }
    const active = await api.activeSessions().catch(() => new Set())
    return { state: stateFromMessages(messages, { active: active.has(sessionID) }), messages }
  }

  function elapsedOf(messages) {
    const oldest = messages[messages.length - 1]?.time?.created
    return typeof oldest === "number" ? Date.now() - oldest : undefined
  }

  /** Session header plus the plan / current step / progress / files block. */
  async function progressText(sessionID, state, messages) {
    const elapsed = elapsedOf(messages)
    const files = await api.diff(sessionID).catch(() => undefined)
    const block = renderProgress({ messages, files, state })
    return [head(sessionID, state, elapsed === undefined ? undefined : formatDuration(elapsed)), block].filter(Boolean).join("\n")
  }

  /**
   * The only channel a subagent can reach the caller through is the tool result the
   * caller is blocked on, so a reminder is a mid-run steer: it lands at the next step
   * boundary, never as an extra turn. Rate limited per session.
   */
  async function nudgeIfSilent(sessionID, state, messages) {
    if (!config.protocol || state !== "running") return false
    if (!isSilent({ messages, thresholdMs: config.silentMs })) return false
    const last = nudges.get(sessionID) ?? 0
    if (Date.now() - last < config.nudgeMs) return false
    nudges.set(sessionID, Date.now())
    try {
      await api.prompt(sessionID, REMINDER, { delivery: "steer" })
      return true
    } catch {
      return false
    }
  }

  async function runningReport(sessionID, messages, state, nudged) {
    const text = await progressText(sessionID, state, messages)
    return `${text}\n\nStill running${nudged ? " (progress reminder sent)" : ""}; call action="wait" again to keep waiting.`
  }

  /* ── opencode_delegate ───────────────────────────────────────────────── */

  async function delegate(args = {}) {
    const tool = "opencode_delegate"
    rejectUnexpected(args, ["task", "directory", "plan"], tool)
    const task = requireString(args, "task", tool)
    if (args.plan !== undefined && typeof args.plan !== "boolean") fail(tool, "parameter \"plan\" must be a boolean.")
    const plan = args.plan === true
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
      metadata: { origin: BACKGROUND_ORIGIN, caller: config.caller, ...(plan ? { plan: true } : {}) },
    })
    const preamble = config.protocol ? (plan ? PLAN_AGREEMENT : AGREEMENT) : undefined
    await api.prompt(session.id, preamble ? `${preamble}\n\n---\n\n${task}` : task)

    // A short wait makes a quick task a single round-trip; anything longer becomes a
    // session to poll, which is the normal way to talk to a subagent.
    const waited = await api.wait(session.id, config.delegateWaitMs)
    if (plan && waited.completed) {
      const messages = await api.messages(session.id, 100)
      return {
        text: [
          head(session.id, "planned", `${(waited.waitedMs / 1000).toFixed(1)}s`),
          lastAssistantText(messages) || "(no plan returned)",
          `Approve: opencode_session action="message" session_id="${session.id}" text="approved, go ahead"`,
          "Adjust: send the corrected steps the same way, or action=\"cancel\" to drop it.",
        ].join("\n\n"),
        structured: { session_id: session.id, state: "planned", plan: true },
      }
    }
    if (!waited.completed) {
      const { state, messages } = await snapshot(session.id, false, 40)
      const nudged = await nudgeIfSilent(session.id, state, messages)
      return {
        text: `${await runningReport(session.id, messages, state, nudged)}\n\nTip: session_id="${session.id}"`,
        structured: { session_id: session.id, state },
      }
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
      const { state, messages } = await snapshot(sessionID, false, 40)
      const updated = messages[0]?.time?.created ?? 0
      const text = await progressText(sessionID, state, messages)
      return {
        text: [text, updated ? `Last update ${formatAge(updated)} ago` : ""].filter(Boolean).join("\n"),
        structured: { session_id: sessionID, state },
      }
    }

    if (action === "wait" || action === "message") {
      let cursor
      if (action === "message") {
        const text = requireString(args, "text", tool)
        // Read the boundary first so the reply is the delta, not the previous turn.
        const before = await api.messages(sessionID, 1)
        cursor = before[0]?.id
        await api.prompt(sessionID, text)
      }

      const waited = await api.wait(sessionID, config.waitMs)
      if (!waited.completed) {
        const { state, messages } = await snapshot(sessionID, false, 40)
        const nudged = await nudgeIfSilent(sessionID, state, messages)
        return {
          text: await runningReport(sessionID, messages, state, nudged),
          structured: { session_id: sessionID, state, waited_ms: waited.waitedMs },
        }
      }

      const messages = await api.messages(sessionID, 100)
      const output = readOutput(messages, { cursor, maxChars: config.maxChars })
      return {
        text: withBody(
          head(sessionID, "done", `waited ${(waited.waitedMs / 1000).toFixed(1)}s`),
          output.text,
          output.truncated,
        ),
        structured: { session_id: sessionID, state: "done", text: output.text, truncated: output.truncated, waited_ms: waited.waitedMs },
      }
    }

    // cancel
    await api.interrupt(sessionID)
    const waited = await api.wait(sessionID, 15_000)
    const { state } = await snapshot(sessionID, waited.completed, 20)
    return {
      text: head(sessionID, state),
      structured: { session_id: sessionID, state },
    }
  }

  return {
    opencode_delegate: {
      title: "Delegate a task",
      description:
        "Run one task in a fresh opencode session. Returns the answer, or the session id and its progress while it is still running.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The complete instruction for the agent." },
          directory: { type: "string", description: "Working directory for the task." },
          plan: { type: "boolean", description: "Plan first: return a plan and wait for your approval before doing the work." },
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
