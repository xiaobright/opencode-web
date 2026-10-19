// Working agreement for delegated sessions, and the progress that comes back.
//
// opencode V2 removed the todowrite tool (see REMOVED_TOOLS in the v1 migration), so
// requiring a todo list would send the agent hunting for a tool that does not exist.
// The durable protocol is text: a one-line plan, then one `progress:` line per step.
// When a todo tool does exist, the agent mirrors the plan there as well.

export const AGREEMENT = [
  "[Delegation protocol]",
  "- BEFORE calling any tool, your first output must be one plain-text line: `plan: 1) ... 2) ...`, at most 6 steps. A tool call is not a plan.",
  "- Work one step at a time. Before starting the next step, write one plain-text line: `progress: n/N <what changed> -> <next>`.",
  "- If a todo/task-list tool exists, mirror the plan there and update it as you go. If not, do not search for one; the plan and progress lines are enough.",
  "- Never leave a finished step marked as in progress; if the plan changes, say so in the next progress line.",
  "- Keep the final answer short and skip restating this protocol.",
].join("\n")

export const REMINDER = [
  "[reminder] You have not reported progress for a while.",
  "Before your next tool call, stop and write one plain-text line: `progress: n/N <what changed> -> <next>`.",
  "If you have not written a `plan:` line yet, write it now too. If you have a todo list, update it. Do not restate anything else.",
].join("\n")

const PLAN_LINE = /(?:^|\n)\s*(?:\*\*)?plan(?:\*\*)?\s*[:：]\s*(.+)/i
const PROGRESS_LINE = /(?:^|\n)\s*(?:\*\*)?progress(?:\*\*)?\s*[:：]\s*(.+)/i
const PROGRESS_ANY = /(?:^|\n)\s*(?:\*\*)?(?:progress|进度)(?:\*\*)?\s*[:：]\s*(.+)/i

function textOf(message) {
  // Text plus reasoning: a reasoning model may keep its plan line in the thinking,
  // and surfacing only that matched line is harmless. Nothing else from reasoning is shown.
  return (message?.content ?? [])
    .filter((part) => (part.type === "text" || part.type === "reasoning") && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

/** Newest `plan:` line across assistant messages, parsed into steps. */
export function parsePlan(messagesNewestFirst) {
  for (const message of messagesNewestFirst ?? []) {
    if (message.type !== "assistant") continue
    const match = PLAN_LINE.exec(textOf(message))
    if (match) return splitSteps(match[1])
  }
  return []
}

function splitSteps(line) {
  const text = line.replace(/\s+/g, " ").trim()
  const parts = text.split(/\s*(?:;|；|\||\d+[).、]\s*)/).map((part) => part.replace(/^[-\s]+/, "").trim())
  return parts.filter(Boolean).slice(0, 8)
}

/** Latest `progress:` line, with the n/N counter when the agent kept one. */
export function parseProgress(messagesNewestFirst) {
  for (const message of messagesNewestFirst ?? []) {
    if (message.type !== "assistant") continue
    const match = PROGRESS_ANY.exec(textOf(message))
    if (!match) continue
    const line = match[1].trim()
    const counter = /^(\d+)\s*\/\s*(\d+)\b/.exec(line)
    return {
      line,
      done: counter ? Number(counter[1]) : undefined,
      total: counter ? Number(counter[2]) : undefined,
    }
  }
  return undefined
}

/** Newest todo list from a todowrite part, for sessions on builds that still have it. */
export function parseTodos(messagesNewestFirst) {
  for (const message of messagesNewestFirst ?? []) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type !== "tool" || part.name !== "todowrite") continue
      const todos = part.state?.input?.todos
      if (Array.isArray(todos) && todos.length > 0)
        return todos.map((todo) => ({
          text: String(todo.content ?? todo.text ?? todo.title ?? "").trim(),
          status: String(todo.status ?? "pending"),
        }))
    }
  }
  return []
}

/** The tool step running right now (streaming/running), with a one-line argument. */
export function currentTool(messagesNewestFirst) {
  for (const message of messagesNewestFirst ?? []) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue
      const status = part.state?.status
      if (status !== "streaming" && status !== "running") continue
      return { name: part.name, status, summary: summarizeInput(part.state?.input), since: part.time?.ran ?? part.time?.created }
    }
  }
  return undefined
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return ""
  const pick = input.command ?? input.cmd ?? input.code ?? input.path ?? input.filePath ?? input.pattern ?? input.query ?? input.url
  if (typeof pick === "string") return pick.replace(/\s+/g, " ").trim().slice(0, 70)
  const key = Object.keys(input)[0]
  return key ? `${key}=${String(input[key]).slice(0, 40)}` : ""
}

const MARK = { completed: "✓", in_progress: "▶", pending: "·", cancelled: "✕" }

/**
 * The progress block a caller sees: plan checklist, the running step, the latest
 * progress line, and how many files changed. Kept around 100 tokens; the caller's
 * own header carries the session id, state and elapsed time.
 */
export function renderProgress({ messages, files, state }) {
  const lines = []

  const todos = parseTodos(messages)
  if (todos.length > 0) {
    const done = todos.filter((todo) => todo.status === "completed").length
    const shown = todos.slice(0, 6).map((todo) => `${MARK[todo.status] ?? "·"} ${todo.text.slice(0, 40)}`)
    lines.push(`Todo ${done}/${todos.length}: ${shown.join(" · ")}${todos.length > 6 ? " · …" : ""}`)
  } else {
    const plan = parsePlan(messages)
    if (plan.length > 0) lines.push(`Plan: ${plan.slice(0, 6).map((step, index) => `${index + 1}) ${step.slice(0, 40)}`).join(" · ")}`)
  }

  // A finished session still has the last tool part in history; only a running one has work in flight.
  const tool = state === "running" ? currentTool(messages) : undefined
  if (tool) lines.push(`Now: ${tool.name}${tool.summary ? ` "${tool.summary}"` : ""} (${tool.status})`)

  const progress = parseProgress(messages)
  if (progress) lines.push(`Progress: ${progress.line.slice(0, 160)}`)
  else if (!tool) lines.push("Progress: nothing reported yet")

  if (files && files.count > 0)
    lines.push(`Files: ${files.count} changed +${files.additions} −${files.deletions}${files.names ? ` (${files.names})` : ""}`)

  return lines.join("\n")
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`
}

/** True when the agent has not produced any assistant message for a while. */
export function isSilent({ messages, now = Date.now(), thresholdMs = 60_000 }) {
  const newest = newTime(messages)
  return newest === undefined || now - newest >= thresholdMs
}

function newTime(messages) {
  for (const message of messages ?? []) {
    if (message.type !== "assistant") continue
    const time = message.time ?? {}
    const stamp = time.completed ?? time.streamed ?? time.created
    if (typeof stamp === "number") return stamp
  }
  return undefined
}

/** Remove the protocol lines from a final answer: they belong to status, not to the reply. */
export function stripProtocol(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\*\*)?(?:plan|progress|进度)(?:\*\*)?\s*[:：]/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Plan mode: produce a plan, stop, wait for approval; then execute with the usual progress lines. */
export const PLAN_AGREEMENT = [
  "[Delegation protocol — plan mode]",
  "- Do not call tools and do not start the work yet.",
  "- Reply with one plan line `plan: 1) ... 2) ...` (at most 6 steps) and one short sentence on assumptions or risks.",
  "- Then stop and wait for approval. Do not ask anything else.",
  "- After approval: execute one step at a time, and before each next step write one plain-text line: `progress: n/N <what changed> -> <next>`.",
  "- Keep the final answer short and skip restating this protocol.",
].join("\n")
