// Tool surface: four tools, one job each.
//
//   opencode_delegate  start work in a fresh session and (optionally) wait for the answer
//   opencode_task      manage delegations: list, status, wait, output, message, cancel
//   opencode_models    which models exist, which are free, which one is the default
//   opencode_help      usage notes, no side effects
//
// Handlers are pure functions over an injected API so tests can run them against a
// fixture service without the MCP protocol in the way.

import {
  freeModels,
  normalizeDirectory,
  parseModelRef,
  defaultModel,
} from "./opencode.mjs"
import {
  DelegationStore,
  deriveTitle,
  formatAge,
  lastTurn,
  newTaskId,
  readOutput,
  stateFromMessages,
} from "./tasks.mjs"

const ACTIONS = ["list", "status", "wait", "output", "message", "cancel"]

function settings(env, cwd) {
  const number = (key, fallback) => {
    const value = Number(env[key])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    defaultModel: env.OPENCODE_MCP_MODEL || "opencode/deepseek-v4.1-flash-free",
    defaultWaitMs: number("OPENCODE_MCP_DEFAULT_WAIT_MS", 120_000),
    maxWaitMs: number("OPENCODE_MCP_MAX_WAIT_MS", 540_000),
    directory: env.OPENCODE_MCP_DIRECTORY || cwd,
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

function optionalNumber(args, key, tool) {
  const value = args?.[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) fail(tool, `parameter "${key}" must be a number.`)
  return value
}

function oneOf(value, allowed, fallback, tool, key) {
  if (value === undefined) return fallback
  if (!allowed.includes(value)) fail(tool, `parameter "${key}" must be one of: ${allowed.join(", ")}.`)
  return value
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function describeTurn(turn) {
  if (!turn) return ""
  const pieces = []
  if (turn.tokens) {
    const input = turn.tokens.input ?? 0
    const output = turn.tokens.output ?? 0
    pieces.push(`tokens ${input} in / ${output} out`)
  }
  if (turn.cost !== null && turn.cost !== undefined) pieces.push(`cost ${turn.cost}`)
  if (turn.tools?.length) pieces.push(`tools ${turn.tools.join(", ")}`)
  if (turn.finish) pieces.push(`finish ${turn.finish}`)
  return pieces.join(" · ")
}

function header({ taskId, sessionID, title, model, directory, state, waitedMs, turn }) {
  const elapsed = waitedMs === undefined ? "" : ` · ${(waitedMs / 1000).toFixed(1)}s`
  const lines = [`Task ${taskId ?? sessionID} · ${state}${elapsed}`]
  const context = [`session ${sessionID}`, model ? `model ${model}` : "", directory ? `dir ${directory}` : ""]
    .filter(Boolean)
    .join(" · ")
  lines.push(context)
  if (title) lines.push(`title ${title}`)
  const detail = describeTurn(turn)
  if (detail) lines.push(detail)
  return lines.join("\n")
}

export function createTools({ api, env = process.env, cwd = process.cwd(), store } = {}) {
  const config = settings(env, cwd)
  const registry = store ?? new DelegationStore({ path: env.OPENCODE_MCP_STATE_PATH })
  const resolveModel = async (ref) => {
    const models = await api.catalog()
    return ref ? parseModelRef(ref, models) : defaultModel(models, config.defaultModel)
  }

  const resolveSession = (ref, tool) => {
    if (!ref) fail(tool, 'pass task_id (local handle) or session_id (durable opencode session).')
    const record = registry.find(ref)
    if (record) return { sessionID: record.sessionID, record }
    if (String(ref).startsWith("ses_")) return { sessionID: String(ref), record: undefined }
    fail(tool, `unknown task "${ref}"; use action="list" or pass an opencode session id (ses_…).`)
  }

  async function readSession(sessionID, { limit = 100 } = {}) {
    const messages = await api.messages(sessionID, limit)
    return messages
  }

  async function settle(sessionID, record) {
    const active = await api.activeSessions().catch(() => new Set())
    const messages = await readSession(sessionID, { limit: 100 })
    const state = stateFromMessages(messages, { active: active.has(sessionID) })
    if (record) registry.update(record.taskId, { state })
    return { messages, state, turn: lastTurn(messages) }
  }

  /* ── opencode_delegate ───────────────────────────────────────────────── */

  async function delegate(args = {}) {
    const tool = "opencode_delegate"
    rejectUnexpected(
      args,
      ["task", "title", "directory", "model", "agent", "mode", "timeout_ms", "on_timeout", "permissions"],
      tool,
    )
    const task = requireString(args, "task", tool)
    const mode = oneOf(args.mode, ["sync", "async"], "sync", tool, "mode")
    const onTimeout = oneOf(args.on_timeout, ["detach", "interrupt"], "detach", tool, "on_timeout")
    const directory = normalizeDirectory(optionalString(args, "directory") ?? config.directory)
    const model = await resolveModel(optionalString(args, "model"))
    const timeoutMs = clamp(optionalNumber(args, "timeout_ms", tool) ?? config.defaultWaitMs, 1_000, config.maxWaitMs)
    const permissions =
      oneOf(args.permissions, ["allow", "default"], "allow", tool, "permissions") === "allow"
        ? [{ action: "*", resource: "*", effect: "allow" }]
        : undefined
    const title = optionalString(args, "title") ?? deriveTitle(task)

    const session = await api.createSession({
      title,
      directory,
      model,
      agent: optionalString(args, "agent"),
      permissions,
    })
    await api.prompt(session.id, task)

    const record = registry.add({
      taskId: newTaskId(),
      sessionID: session.id,
      title,
      model: `${model.providerID}/${model.id}`,
      directory,
      agent: optionalString(args, "agent") ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: "running",
      lastCursor: undefined,
    })

    if (mode === "async")
      return {
        text: [
          `Task ${record.taskId} · started (async)`,
          `session ${session.id} · model ${record.model} · dir ${directory}`,
          `Continue: opencode_task action="wait" task_id="${record.taskId}" wait_ms=60000`,
        ].join("\n"),
        structured: { taskId: record.taskId, sessionID: session.id, state: "running", model: record.model, directory, title },
      }

    let waited = await api.wait(session.id, timeoutMs)
    if (!waited.completed && onTimeout === "interrupt") {
      await api.interrupt(session.id).catch(() => {})
      waited = await api.wait(session.id, 15_000)
    }

    const active = waited.completed ? false : (await api.activeSessions().catch(() => new Set())).has(session.id)
    const messages = await readSession(session.id, { limit: 100 })
    const state = stateFromMessages(messages, { active })
    const turn = lastTurn(messages)
    const output = readOutput(messages, { maxChars: 8_000 })
    registry.update(record.taskId, { state, lastCursor: output.nextCursor })

    if (!waited.completed)
      return {
        text: [
          header({ ...record, sessionID: session.id, state, waitedMs: waited.waitedMs, turn }),
          "still running: this wait returned on its timeout; the session keeps going",
          `Continue: opencode_task action="wait" task_id="${record.taskId}" wait_ms=60000`,
        ].join("\n\n"),
        structured: {
          taskId: record.taskId,
          sessionID: session.id,
          state,
          completed: false,
          timedOut: true,
          waitedMs: waited.waitedMs,
          text: output.text,
          nextCursor: output.nextCursor,
        },
      }

    return {
      text: [header({ ...record, sessionID: session.id, state, waitedMs: waited.waitedMs, turn }), output.text || "(no assistant text)"].join(
        "\n\n",
      ),
      structured: {
        taskId: record.taskId,
        sessionID: session.id,
        state,
        completed: true,
        waitedMs: waited.waitedMs,
        model: record.model,
        directory,
        title,
        tokens: turn?.tokens ?? null,
        cost: turn?.cost ?? null,
        tools: turn?.tools ?? [],
        text: output.text,
        nextCursor: output.nextCursor,
      },
    }
  }

  /* ── opencode_task ───────────────────────────────────────────────────── */

  async function manage(args = {}) {
    const tool = "opencode_task"
    rejectUnexpected(
      args,
      ["action", "task_id", "session_id", "wait_ms", "text", "cursor", "read_mode", "tail_chars", "max_chars", "limit"],
      tool,
    )
    const action = oneOf(args.action, ACTIONS, undefined, tool, "action")
    if (!action) fail(tool, `parameter "action" is required and must be one of: ${ACTIONS.join(", ")}.`)

    if (action === "list") {
      const limit = clamp(optionalNumber(args, "limit", tool) ?? 20, 1, 100)
      const records = registry.list({ limit })
      if (records.length === 0) return { text: "No delegations recorded by this MCP process yet.", structured: { tasks: [] } }
      const active = await api.activeSessions().catch(() => new Set())
      const lines = records.map((record) => {
        const state = active.has(record.sessionID) ? "running" : (record.state ?? "unknown")
        return `${record.taskId} · ${state} · ${record.title ?? "(untitled)"} · ${record.model ?? "?"} · ${formatAge(record.createdAt)} ago · ${record.sessionID}`
      })
      return {
        text: ["Delegations (newest first):", ...lines].join("\n"),
        structured: {
          tasks: records.map((record) => ({
            ...record,
            state: active.has(record.sessionID) ? "running" : (record.state ?? "unknown"),
          })),
        },
      }
    }

    const ref = optionalString(args, "task_id") ?? optionalString(args, "session_id")
    const { sessionID, record } = resolveSession(ref, tool)

    if (action === "status") {
      const info = await api.sessionInfo(sessionID).catch(() => undefined)
      const { messages, state, turn } = await settle(sessionID, record)
      const updated = info?.time?.updated
      return {
        text: [
          header({
            taskId: record?.taskId,
            sessionID,
            title: info?.title ?? record?.title,
            model: record?.model,
            directory: info?.location?.directory ?? record?.directory,
            state,
            turn,
          }),
          updated ? `last update ${new Date(updated).toISOString()} (${formatAge(updated)} ago)` : "",
          messages.length === 0 ? "no messages yet" : "",
        ]
          .filter(Boolean)
          .join("\n"),
        structured: {
          taskId: record?.taskId,
          sessionID,
          state,
          title: info?.title ?? record?.title ?? null,
          model: record?.model ?? null,
          directory: info?.location?.directory ?? record?.directory ?? null,
          lastUpdate: updated ?? null,
          tokens: info?.tokens ?? turn?.tokens ?? null,
          cost: info?.cost ?? turn?.cost ?? null,
        },
      }
    }

    if (action === "wait") {
      const waitMs = clamp(optionalNumber(args, "wait_ms", tool) ?? 60_000, 1_000, config.maxWaitMs)
      const waited = await api.wait(sessionID, waitMs)
      const messages = await readSession(sessionID, { limit: 100 })
      const active = waited.completed ? false : (await api.activeSessions().catch(() => new Set())).has(sessionID)
      const state = stateFromMessages(messages, { active })
      const output = readOutput(messages, {
        cursor: optionalString(args, "cursor") ?? record?.lastCursor,
        maxChars: clamp(optionalNumber(args, "max_chars", tool) ?? 8_000, 500, 32_000),
      })
      registry.update(record?.taskId, { state, lastCursor: output.nextCursor })
      const summary = header({
        taskId: record?.taskId,
        sessionID,
        title: record?.title,
        model: record?.model,
        directory: record?.directory,
        state,
        waitedMs: waited.waitedMs,
        turn: lastTurn(messages),
      })
      return {
        text: [
          summary,
          waited.completed ? "" : `still running after the ${waitMs} ms wait budget; the session keeps going`,
          output.text,
          `cursor ${output.nextCursor ?? "(none)"}${output.truncated ? " · output truncated" : ""}`,
          `Continue: opencode_task action="output" task_id="${record?.taskId ?? sessionID}" cursor="${output.nextCursor ?? ""}"`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        structured: {
          taskId: record?.taskId ?? null,
          sessionID,
          state,
          completed: waited.completed,
          timedOut: !waited.completed,
          waitedMs: waited.waitedMs,
          text: output.text,
          nextCursor: output.nextCursor,
          truncated: output.truncated,
        },
      }
    }

    if (action === "output") {
      const readMode = oneOf(args.read_mode, ["delta", "full"], "delta", tool, "read_mode")
      const maxChars = clamp(optionalNumber(args, "max_chars", tool) ?? 8_000, 500, 32_000)
      const messages = await readSession(sessionID, { limit: 100 })
      const cursor = readMode === "full" ? undefined : (optionalString(args, "cursor") ?? record?.lastCursor)
      let output = readOutput(messages, { cursor, maxChars })
      const tail = optionalNumber(args, "tail_chars", tool)
      if (tail !== undefined && output.text.length > tail) output = { ...output, text: output.text.slice(-clamp(tail, 100, maxChars)), truncated: true }
      const state = stateFromMessages(messages, { active: (await api.activeSessions().catch(() => new Set())).has(sessionID) })
      registry.update(record?.taskId, { state, lastCursor: output.nextCursor })
      return {
        text: [
          header({ taskId: record?.taskId, sessionID, title: record?.title, model: record?.model, state }),
          output.text || "(no assistant text in this span)",
          `cursor ${output.nextCursor ?? "(none)"} · ${output.assistantMessages} assistant message(s)${output.truncated ? " · truncated" : ""}`,
        ].join("\n\n"),
        structured: {
          taskId: record?.taskId ?? null,
          sessionID,
          state,
          text: output.text,
          nextCursor: output.nextCursor,
          truncated: output.truncated,
          readMode,
        },
      }
    }

    if (action === "message") {
      const text = requireString(args, "text", tool)
      const before = await readSession(sessionID, { limit: 1 })
      const cursor = before[0]?.id
      await api.prompt(sessionID, text)
      const waitMs = args.wait_ms === 0 ? 0 : clamp(optionalNumber(args, "wait_ms", tool) ?? 60_000, 1_000, config.maxWaitMs)
      if (waitMs === 0)
        return {
          text: `Sent to ${sessionID}. Continue: opencode_task action="wait" session_id="${sessionID}" wait_ms=60000`,
          structured: { taskId: record?.taskId ?? null, sessionID, state: "running", completed: false },
        }
      const waited = await api.wait(sessionID, waitMs)
      const messages = await readSession(sessionID, { limit: 100 })
      const active = waited.completed ? false : (await api.activeSessions().catch(() => new Set())).has(sessionID)
      const state = stateFromMessages(messages, { active })
      const output = readOutput(messages, { cursor, maxChars: 8_000 })
      registry.update(record?.taskId, { state, lastCursor: output.nextCursor })
      return {
        text: [
          header({
            taskId: record?.taskId,
            sessionID,
            title: record?.title,
            model: record?.model,
            state,
            waitedMs: waited.waitedMs,
            turn: lastTurn(messages),
          }),
          output.text || "(no new assistant text)",
        ].join("\n\n"),
        structured: {
          taskId: record?.taskId ?? null,
          sessionID,
          state,
          completed: waited.completed,
          timedOut: !waited.completed,
          waitedMs: waited.waitedMs,
          text: output.text,
          nextCursor: output.nextCursor,
        },
      }
    }

    // cancel
    await api.interrupt(sessionID)
    const waited = await api.wait(sessionID, 15_000)
    const messages = await readSession(sessionID, { limit: 20 })
    const state = stateFromMessages(messages, { active: !waited.completed })
    registry.update(record?.taskId, { state })
    return {
      text: header({
        taskId: record?.taskId,
        sessionID,
        title: record?.title,
        model: record?.model,
        state,
        waitedMs: waited.waitedMs,
      }),
      structured: { taskId: record?.taskId ?? null, sessionID, state, cancelled: true },
    }
  }

  /* ── opencode_models ─────────────────────────────────────────────────── */

  async function models(args = {}) {
    const tool = "opencode_models"
    rejectUnexpected(args, ["free_only", "limit"], tool)
    const freeOnly = args.free_only !== false
    const models = await api.catalog()
    const list = freeOnly ? freeModels(models) : models.filter((model) => model.enabled)
    const preferred = (() => {
      try {
        return parseModelRef(config.defaultModel, models)
      } catch {
        return undefined
      }
    })()
    const limit = clamp(optionalNumber(args, "limit", tool) ?? 40, 1, 200)
    const lines = list.slice(0, limit).map((model) => {
      const isDefault = preferred && model.providerID === preferred.providerID && model.id === preferred.id
      const context = model.context ? `${Math.round(model.context / 1000)}k` : "?"
      return `${isDefault ? "*" : " "} ${model.providerID}/${model.id} · ${model.name} · ctx ${context} · ${model.free ? "free" : "paid"}${model.tools ? "" : " · no tools"}`
    })
    return {
      text: [
        `${list.length} ${freeOnly ? "free" : "enabled"} model(s)${list.length > limit ? ` (showing ${limit})` : ""}${preferred ? `; default ${preferred.providerID}/${preferred.id}` : ""}`,
        ...lines,
      ].join("\n"),
      structured: { models: list.slice(0, limit), default: preferred ?? null },
    }
  }

  /* ── opencode_help ───────────────────────────────────────────────────── */

  const helpTopics = {
    overview: [
      "This server delegates work to the local opencode background service and its free models (default opencode/deepseek-v4.1-flash-free).",
      'opencode_delegate starts a session and sends a task; mode="sync" waits for the answer, mode="async" returns a task id at once.',
      "The delegated agent runs real tools (shell, edit, read) in the directory you pass, with permissions pre-approved so it never blocks on approvals.",
      'opencode_task manages work: action="list" | "status" | "wait" | "output" | "message" | "cancel". Follow up with action="message" to continue the same session.',
      "Sessions are durable opencode sessions and also appear in the opencode web UI. task_id is a local handle; session_id works anywhere, even after this MCP restarts.",
      "Help topics: overview, delegate, manage, models, output. Ordinary calls are self-contained.",
    ],
    delegate: [
      'opencode_delegate { task, directory?, model?, title?, mode?, timeout_ms?, on_timeout?, permissions? }',
      'directory must be an absolute path of an existing project directory; it is the agent\'s working directory. Default: OPENCODE_MCP_DIRECTORY or the MCP process cwd.',
      'model accepts "provider/modelID" or a bare model id; default opencode/deepseek-v4.1-flash-free. Use opencode_models to see free ones.',
      'mode="sync" (default) waits up to timeout_ms (default 120000, cap OPENCODE_MCP_MAX_WAIT_MS=540000). If the budget runs out the task keeps running; on_timeout="interrupt" stops it instead.',
      'mode="async" returns immediately with task_id and session_id. Prefer async for long builds or research, then poll with action="wait" (60s budgets).',
      'permissions="allow" (default) pre-approves tools; "default" leaves opencode asking, which can stall an unattended delegation.',
    ],
    manage: [
      'opencode_task action="list" shows delegations recorded by this MCP process (newest first, cached states; one /api/session/active probe refreshes running flags).',
      'action="status" reads the session live: state, title, model, directory, last turn tokens/cost. Accepts task_id or session_id.',
      'action="wait" blocks up to wait_ms (default 60000) for the agent loop to go idle; a timeout means "still running", not failure. Call again to continue waiting.',
      'action="message" sends a follow-up prompt into the same session and (by default) waits for the reply; wait_ms=0 just acknowledges.',
      'action="cancel" interrupts the running turn; the session and its files stay.',
      'A finished task state comes from opencode\'s idle marker: done, failed or cancelled. running is the honest answer whenever the loop is still active.',
    ],
    models: [
      "opencode_models lists models from the running service; free_only defaults to true.",
      "Free models change over time; the pinned default falls back to the first free tool-capable model when it disappears.",
      "Delegated sessions bill nothing on free models; tokens and cost are reported per turn anyway.",
    ],
    output: [
      "Output is assistant text only, oldest first within the span; tool calls are summarized in the header, not inlined.",
      "Every read returns nextCursor (a message id). Pass it back as cursor to get only what arrived later; read_mode=\"full\" ignores the cursor.",
      "max_chars defaults to 8000 (cap 32000). tail_chars keeps only the end of the span when you need the latest lines.",
      "Sessions are append-only, so cursor reads never lose data; if a cursor is older than the 100-message window the span falls back to the whole window.",
    ],
  }

  async function help(args = {}) {
    const tool = "opencode_help"
    rejectUnexpected(args, ["topic"], tool)
    const topic = oneOf(args.topic, Object.keys(helpTopics), "overview", tool, "topic")
    return { text: helpTopics[topic].join("\n"), structured: { topic } }
  }

  return {
    opencode_help: {
      title: "OpenCode Delegation Help",
      description: "Read concise usage notes for this delegation server. Optional; ordinary calls are self-contained.",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string", enum: Object.keys(helpTopics), default: "overview" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: help,
    },
    opencode_models: {
      title: "OpenCode Models",
      description: "List models available to the local opencode service, with free/paid and context size. Free ones are the point of this server.",
      inputSchema: {
        type: "object",
        properties: {
          free_only: { type: "boolean", default: true, description: "Only free, enabled, tool-capable models." },
          limit: { type: "number", minimum: 1, maximum: 200, description: "Maximum entries to return." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: models,
    },
    opencode_delegate: {
      title: "Delegate to OpenCode",
      description:
        "Start a task in a fresh opencode session and run it on a free model (default opencode/deepseek-v4.1-flash-free). Sync waits for the answer; async returns a task id.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The complete instruction for the delegated agent." },
          title: { type: "string", description: "Session title shown in the opencode UI. Defaults to the task's first line." },
          directory: { type: "string", description: "Absolute working directory for the agent. Defaults to OPENCODE_MCP_DIRECTORY or the MCP cwd." },
          model: { type: "string", description: 'Model ref, e.g. "opencode/deepseek-v4.1-flash-free" or a bare model id.' },
          agent: { type: "string", description: "opencode agent name (default: opencode's own default)." },
          mode: { type: "string", enum: ["sync", "async"], default: "sync", description: "sync waits for the reply; async returns a task id immediately." },
          timeout_ms: { type: "number", minimum: 1000, description: "Wait budget for mode=sync; capped by OPENCODE_MCP_MAX_WAIT_MS." },
          on_timeout: { type: "string", enum: ["detach", "interrupt"], default: "detach", description: "When the wait budget runs out: keep the session running or interrupt it." },
          permissions: { type: "string", enum: ["allow", "default"], default: "allow", description: "allow pre-approves tools so unattended work never blocks; default keeps opencode's approval flow." },
        },
        required: ["task"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      handler: delegate,
    },
    opencode_task: {
      title: "Manage OpenCode Delegations",
      description:
        'Manage delegated sessions: action="list" | "status" | "wait" | "output" | "message" | "cancel". Accepts task_id or session_id; session_id works across MCP restarts.',
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ACTIONS, description: "What to do." },
          task_id: { type: "string", description: "Local task handle returned by opencode_delegate." },
          session_id: { type: "string", description: "Durable opencode session id (ses_…)." },
          wait_ms: { type: "number", minimum: 0, description: "Wait budget in ms for action=wait (default 60000) or action=message (0 = do not wait)." },
          text: { type: "string", description: 'Follow-up prompt for action="message".' },
          cursor: { type: "string", description: "Message id returned as nextCursor; reads only what arrived after it." },
          read_mode: { type: "string", enum: ["delta", "full"], default: "delta", description: 'action="output": delta from the cursor, or the whole window.' },
          tail_chars: { type: "number", minimum: 100, description: "Keep only the end of the output span." },
          max_chars: { type: "number", minimum: 500, maximum: 32000, description: "Output cap (default 8000)." },
          limit: { type: "number", minimum: 1, maximum: 100, description: 'action="list": maximum entries.' },
        },
        required: ["action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      handler: manage,
    },
  }
}
