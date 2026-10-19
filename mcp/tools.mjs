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
// step, stored as an API instruction entry when available. These are display hints;
// native Inbox, active execution and idle messages determine lifecycle state.

import { normalizeDirectory } from "./opencode.mjs"
import { deriveTitle, formatAge, readOutput, latestInput, readSnapshot } from "./tasks.mjs"
import { AGREEMENT, formatDuration, renderProgress } from "./progress.mjs"
import { rankingPath, readRanking, selectModel } from "../src/models.mjs"

// Sessions created here carry this metadata origin, which is how the web UI and the tray
// tell delegated background work apart from sessions a human opened.
export const BACKGROUND_ORIGIN = "opencode-delegate"

const ACTIONS = ["status", "wait", "message", "cancel"]

/** Default per-call wait budget. Keep it well under the SDK's 60s request timeout. */
export const DEFAULT_WAIT_MS = 30_000

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
    // The SDK defaults to a 60s request timeout; leave time for discovery and reporting.
    waitMs: number("OPENCODE_MCP_WAIT_MS", DEFAULT_WAIT_MS),
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

  function fields(snap) {
    return { state: snap.state, input_id: snap.inputID, input_status: snap.inputStatus, pending_inputs: snap.pending, last_outcome: snap.lastOutcome, input_outcome: snap.inputOutcome, input_error: snap.inputError, history_truncated: snap.historyTruncated }
  }

  function inputLine(snap) {
    const line = `Input ${snap.inputID ?? "unknown"} · ${snap.inputStatus}${snap.inputOutcome ? ` (${snap.inputOutcome})` : ""} · ${snap.pending} pending`
    return snap.inputError ? `${line}\nError: ${snap.inputError.type}${snap.inputError.status ? ` (${snap.inputError.status})` : ""}: ${snap.inputError.message}` : line
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

  async function report(sessionID, snap, detail, extra = {}) {
    const structured = { session_id: sessionID, ...fields(snap), ...extra }
    // A completed input keeps its answer even while other inputs are queued/running.
    if (snap.inputStatus !== "settled") {
      const guidance = snap.state === "running"
        ? 'Still running; call action="wait" again to keep waiting.'
        : snap.state === "queued"
          ? 'Input remains in Inbox. wait observes execution; it does not resume parked input. cancel only interrupts active execution.'
          : snap.historyTruncated
            ? 'Input boundary is outside the 1000-message read limit. Inspect the session history; no unrelated answer is returned.'
            : 'No confirmed idle boundary for this input. Inspect the session before resubmitting; the service may have restarted.'
      return { text: `${await progressText(sessionID, snap.state, snap.messages)}\n${inputLine(snap)}\n\n${guidance}`, structured }
    }
    const output = readOutput(snap.messages, { inputID: snap.inputID, maxChars: config.maxChars, protocol: config.protocol })
    return {
      text: withBody(`${head(sessionID, snap.state, detail)}\n${inputLine(snap)}`, output.text, output.truncated),
      structured: { ...structured, text: output.text, truncated: output.truncated },
    }
  }

  async function observe(sessionID, inputID, ms) {
    try {
      const waited = await api.wait(sessionID, ms)
      const snap = await readSnapshot(api, sessionID, inputID)
      return { waited, snap }
    } catch (error) {
      throw new Error(`Session ${sessionID}, input ${inputID ?? "unknown"}: ${error.message}. Admission is not rolled back; inspect this session before resubmitting.`, { cause: error })
    }
  }

  /* ── opencode_delegate ───────────────────────────────────────────────── */

  async function delegate(args = {}) {
    const tool = "opencode_delegate"
    rejectUnexpected(args, ["task", "directory"], tool)
    const task = requireString(args, "task", tool)
    const directory = normalizeDirectory(
      (args.directory === undefined ? undefined : requireString(args, "directory", tool)) ||
        config.directory ||
        fail(tool, "pass directory or set OPENCODE_MCP_DIRECTORY: delegated sessions need an explicit working directory."),
    )
    const capabilities = await api.capabilities()
    const model = await resolveModel()

    const session = await api.createSession({
      title: deriveTitle(task),
      directory,
      model,
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      metadata: { origin: BACKGROUND_ORIGIN, caller: config.caller },
    })
    let admitted
    try {
      if (config.protocol && capabilities.instructions) await api.setInstruction(session.id, "delegation-protocol", AGREEMENT)
      const preamble = config.protocol && !capabilities.instructions ? AGREEMENT : undefined
      admitted = await api.prompt(session.id, preamble ? `${preamble}\n\n---\n\n${task}` : task)
    } catch (error) {
      // The prompt may already be queued. Keep the handle available instead of inviting
      // another delegation (and another execution) after a lost response.
      throw new Error(`Session ${session.id}: ${error.message}. Check this session before sending the task again.`, { cause: error })
    }

    // A short wait makes a quick task a single round-trip; anything longer becomes a
    // session to poll, which is the normal way to talk to a subagent.
    const { waited, snap } = await observe(session.id, admitted.id, config.delegateWaitMs)
    return report(session.id, snap, `${(waited.waitedMs / 1000).toFixed(1)}s`)
  }

  /* ── opencode_session ────────────────────────────────────────────────── */

  async function session(args = {}) {
    const tool = "opencode_session"
    rejectUnexpected(args, ["action", "session_id", "text"], tool)
    const action = oneOf(args.action, ACTIONS, tool, "action")
    const sessionID = requireString(args, "session_id", tool)

    const followUp = action === "message" ? requireString(args, "text", tool) : undefined
    await api.capabilities()
    // Freeze the input before waiting: a later concurrent sender must not change which
    // answer this invocation reads. A fresh invocation recovers the latest durable input.
    let inputID = action === "message" ? undefined : await latestInput(api, sessionID)
    if (action === "status") {
      const snap = await readSnapshot(api, sessionID, inputID)
      const updated = snap.messages[0]?.time?.created ?? 0
      return {
        text: [await progressText(sessionID, snap.state, snap.messages), inputLine(snap), updated ? `Last update ${formatAge(updated)} ago` : ""].filter(Boolean).join("\n"),
        structured: { session_id: sessionID, ...fields(snap) },
      }
    }
    if (action === "message") inputID = (await api.prompt(sessionID, followUp)).id
    if (action === "cancel") await api.interrupt(sessionID)
    const { waited, snap } = await observe(sessionID, inputID, action === "cancel" ? 15_000 : config.waitMs)
    const result = await report(sessionID, snap, `waited ${(waited.waitedMs / 1000).toFixed(1)}s`, { waited_ms: waited.waitedMs })
    if (action === "cancel") result.text += `\n\nInterruption requested for active execution; ${snap.pending} pending input(s) retained.`
    return result
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
          directory: { type: "string", description: "Existing absolute working directory for the task." },
        },
        required: ["task"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      handler: delegate,
    },
    opencode_session: {
      title: "Talk to a delegated session",
      description: "Check a session or wait for execution, steer with a follow-up, or interrupt active execution (pending Inbox inputs are retained).",
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
