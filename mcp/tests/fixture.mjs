// A fake opencode background service with the same contract the real one exposes:
// sessions, prompts, a blocking wait, newest-first messages, idle markers and models.

import { randomUUID } from "node:crypto"
import { createServer } from "node:http"

export const AUTH = `Basic ${Buffer.from("opencode:fixture").toString("base64")}`

export const DEFAULT_MODELS = [
  {
    id: "deepseek-v4.1-flash-free",
    modelID: "deepseek-v4.1-flash-free",
    providerID: "opencode",
    name: "DeepSeek V4.1 Flash Free",
    limit: { context: 200_000 },
    capabilities: { tools: true },
    cost: [{ input: 0, output: 0 }],
    status: "active",
    enabled: true,
  },
  {
    id: "big-pickle",
    modelID: "big-pickle",
    providerID: "opencode",
    name: "Big Pickle",
    limit: { context: 200_000 },
    capabilities: { tools: true },
    cost: [{ input: 0, output: 0 }],
    status: "active",
    enabled: true,
  },
  {
    id: "paid-model",
    modelID: "paid-model",
    providerID: "opencode",
    name: "Paid Model",
    limit: { context: 100_000 },
    capabilities: { tools: true },
    cost: [{ input: 3, output: 15 }],
    status: "active",
    enabled: true,
  },
]

export async function startFixture({ replies = ["PONG."], outcomes = ["succeeded"], replyDelayMs = 5, models = DEFAULT_MODELS, progressMode = false, diffFiles = [], dropResponses = {} } = {}) {
  const sessions = new Map()
  const state = { waits: 0, prompts: 0, interrupts: 0, created: 0, messageReads: 0, promptTexts: [], deliveries: [] }
  const waiters = new Map()
  const timers = new Map()
  const drops = { ...dropResponses }

  function drop(kind, request) {
    if (!(drops[kind] > 0)) return false
    drops[kind]--
    request.socket.destroy()
    return true
  }

  function settle(session, outcome) {
    if (!session.running) return
    clearTimeout(timers.get(session.id))
    timers.delete(session.id)
    session.running = false
    const now = Date.now()
    if (outcome === "succeeded") {
      const reply = replies[Math.min(session.turns - 1, replies.length - 1)]
      session.messages.push({
        id: `msg_${randomUUID()}`,
        type: "assistant",
        time: { created: now, completed: now + 1 },
        content: [{ type: "text", text: reply }],
        finish: "stop",
        tokens: { input: 10, output: 2 },
        cost: 0,
      })
    }
    session.messages.push({
      id: `msg_${randomUUID()}`,
      type: "idle",
      outcome,
      time: { created: now + 1 },
    })
    const pending = waiters.get(session.id) ?? []
    waiters.delete(session.id)
    for (const resolve of pending) resolve()
    void state
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture")
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(body === undefined ? "" : JSON.stringify(body))
    }

    if (request.headers.authorization !== AUTH) return json(401, { error: "unauthorized" })

    const sessionID = /\/api\/(?:experimental\/)?session\/([^/]+)/.exec(url.pathname)?.[1]
    const session = sessionID ? sessions.get(decodeURIComponent(sessionID)) : undefined

    if (request.method === "GET" && url.pathname === "/api/info") return json(200, { version: "fixture", pid: process.pid })
    if (request.method === "GET" && url.pathname === "/api/model") return json(200, { data: models })
    if (request.method === "GET" && url.pathname === "/api/session/active")
      return json(200, { data: Object.fromEntries([...sessions.values()].filter((item) => item.running).map((item) => [item.id, { type: "running" }])) })

    if (request.method === "POST" && url.pathname === "/api/session") {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const input = JSON.parse(body || "{}")
        const created = {
          id: `ses_${randomUUID()}`,
          title: input.title ?? "",
          model: input.model,
          location: input.location,
          running: false,
          turns: 0,
          messages: [],
          permissions: input.permissions,
          metadata: input.metadata,
        }
        sessions.set(created.id, created)
        state.created++
        if (drop("create", request)) return
        json(200, { data: created })
      })
      return
    }

    if (!session) return json(404, { error: "session not found" })

    if (request.method === "POST" && url.pathname.endsWith("/prompt")) {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const input = JSON.parse(body || "{}")
        session.turns++
        state.promptTexts.push(input.text)
        state.deliveries.push(input.delivery ?? null)
        session.messages.push({ id: `msg_${randomUUID()}`, type: "user", time: { created: Date.now() }, text: input.text })
        session.running = true
        state.prompts++
        if (progressMode && session.turns === 1) {
          // A running step: plan, progress line and an in-flight tool, before the reply lands.
          const started = Date.now()
          session.messages.push({
            id: `msg_${randomUUID()}`,
            type: "assistant",
            time: { created: started },
            content: [
              { type: "text", text: "plan: 1) 读代码 2) 改代码 3) 跑测试\nprogress: 1/3 读完入口 -> 修改实现" },
              { type: "tool", name: "shell", state: { status: "running", input: { command: "npm test" } }, time: { created: started } },
            ],
          })
        }
        const outcome = outcomes[Math.min(session.turns - 1, outcomes.length - 1)]
        timers.set(session.id, setTimeout(() => settle(session, outcome), replyDelayMs))
        if (drop("prompt", request)) return
        json(200, { data: { id: "inbox" } })
      })
      return
    }

    if (request.method === "POST" && url.pathname === `/api/experimental/session/${session.id}/wait`) {
      state.waits++
      if (drop("wait", request)) return
      if (!session.running) return json(204)
      const pending = waiters.get(session.id) ?? []
      pending.push(() => {
        response.writeHead(204)
        response.end()
      })
      waiters.set(session.id, pending)
      return
    }

    if (request.method === "POST" && url.pathname.endsWith("/interrupt")) {
      state.interrupts++
      settle(session, "interrupted")
      return json(200, { data: { ok: true } })
    }

    if (request.method === "GET" && url.pathname.endsWith("/diff")) return json(200, { data: diffFiles })

    if (request.method === "GET" && url.pathname.endsWith("/message")) {
      state.messageReads++
      if (drop("messages", request)) return
      const limit = Number(url.searchParams.get("limit") ?? 20)
      return json(200, { data: [...session.messages].reverse().slice(0, limit), cursor: {} })
    }

    if (request.method === "GET" && url.pathname === `/api/session/${session.id}`)
      return json(200, { data: { id: session.id, title: session.title, location: session.location, metadata: session.metadata, time: { updated: Date.now() }, tokens: { input: 0, output: 0 }, cost: 0 } })

    return json(404, { error: "not found" })
  })

  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    state,
    sessions,
    finish: (sessionID, outcome = "succeeded") => settle(sessions.get(sessionID), outcome),
    close: () => new Promise((done) => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      server.close(done)
    }),
  }
}

/** An api object with the fixture's address baked in, matching opencode.mjs's exports. */
export function fixtureApi(module, url) {
  const call = async (path, options = {}) => {
    const response = await fetch(url + path, {
      method: options.method ?? "GET",
      headers: {
        authorization: AUTH,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      const error = new Error(`${options.method ?? "GET"} ${path} returned ${response.status}${text ? `: ${text}` : ""}`)
      error.status = response.status
      throw error
    }
    if (response.status === 204) return undefined
    return response.json()
  }
  return {
    ...module,
    request: call,
    // Mirror the real client: the tool layer passes a directory, the client turns it into
    // the location the session API expects.
    createSession: async (input) =>
      (await call("/api/session", { method: "POST", body: { ...input, location: input.location ?? { directory: input.directory } } })).data,
    prompt: async (sessionID, text, options = {}) =>
      (await call(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text, ...(options.delivery ? { delivery: options.delivery } : {}) } })).data,
    messages: async (sessionID, limit = 100) => (await call(`/api/session/${sessionID}/message?limit=${limit}`)).data,
    sessionInfo: async (sessionID) => (await call(`/api/session/${sessionID}`)).data,
    activeSessions: async () => new Set(Object.keys((await call("/api/session/active")).data)),
    interrupt: async (sessionID) => call(`/api/session/${sessionID}/interrupt`, { method: "POST" }),
    wait: async (sessionID, timeoutMs) => {
      const started = Date.now()
      try {
        await call(`/api/experimental/session/${sessionID}/wait`, { method: "POST", timeoutMs })
        return { completed: true, waitedMs: Date.now() - started }
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") return { completed: false, waitedMs: Date.now() - started }
        throw error
      }
    },
    catalog: async () => (await call("/api/model")).data.map(module.normalizeModel),
    diff: async (sessionID) => module.summarizeDiff((await call(`/api/session/${sessionID}/diff`)).data),
  }
}
