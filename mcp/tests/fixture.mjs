// A fake opencode background service with the same contract the real one exposes:
// sessions, prompts, a blocking wait, newest-first messages, idle markers and models.

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
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

export const BASELINE_DOCUMENT = JSON.parse(readFileSync(new URL('./openapi-baseline.json', import.meta.url), 'utf8'))

export async function startFixture({ replies = ["PONG."], outcomes = ["succeeded"], errors = [], replyDelayMs = 5, deliveryDelayMs = 0, models = DEFAULT_MODELS, progressMode = false, diffFiles = [], dropResponses = {}, instructions = true, document = BASELINE_DOCUMENT } = {}) {
  const sessions = new Map()
  const state = { waits: 0, prompts: 0, interrupts: 0, created: 0, createBodies: [], openapiReads: 0, messageReads: 0, promptTexts: [], deliveries: [], instructionWrites: 0 }
  const waiters = new Map()
  const timers = new Set()
  const drops = { ...dropResponses }
  const contract = structuredClone(document)
  if (!instructions) delete contract.paths["/api/experimental/session/{sessionID}/instructions/entries/{key}"]
  function later(fn, ms) {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
    timers.add(timer)
    return timer
  }
  function drop(kind, request) {
    if (!(drops[kind] > 0)) return false
    drops[kind]--
    request.socket.destroy()
    return true
  }
  function release(session) {
    for (const done of waiters.get(session.id) ?? []) done()
    waiters.delete(session.id)
  }
  function promote(session, item) {
    if (!session.inbox.has(item.id)) return
    session.inbox.delete(item.id)
    session.messages.push({ id: item.id, type: "user", time: { created: Date.now() }, ...item.payload })
    if (progressMode && session.turns === 1) {
      session.messages.push({ id: `msg_${randomUUID()}`, type: "assistant", time: { created: Date.now() }, content: [
        { type: "text", text: "plan: 1) 读代码 2) 改代码 3) 跑测试\nprogress: 1/3 读完入口 -> 修改实现" },
        { type: "tool", name: "shell", state: { status: "running", input: { command: "npm test" } } },
      ] })
    }
  }
  function wake(session) {
    if (session.running) return
    session.running = true
    session.timer = later(() => {
      if (!session.running) return
      const items = [...session.inbox.values()]
      const steers = items.filter((item) => item.delivery === "steer")
      for (const item of steers.length ? steers : items.slice(0, 1)) promote(session, item)
      session.timer = later(() => settle(session, outcomes[Math.min(session.turns - 1, outcomes.length - 1)]), replyDelayMs)
    }, deliveryDelayMs)
  }
  function settle(session, outcome) {
    if (!session?.running) return
    clearTimeout(session.timer)
    timers.delete(session.timer)
    session.running = false
    const now = Date.now()
    if (outcome === "succeeded") session.messages.push({ id: `msg_${randomUUID()}`, type: "assistant", time: { created: now, completed: now }, content: [{ type: "text", text: replies[Math.min(session.turns - 1, replies.length - 1)] }], finish: "stop" })
    session.messages.push({ id: `msg_${randomUUID()}`, type: "idle", outcome, error: outcome === "failed" ? errors[Math.min(session.turns - 1, errors.length - 1)] : undefined, time: { created: now } })
    if (outcome === "succeeded" && session.inbox.size) wake(session)
    else release(session)
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture")
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(body === undefined ? "" : JSON.stringify(body))
    }
    if (request.headers.authorization !== AUTH) return json(401, { error: "unauthorized" })
    const read = async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      return JSON.parse(Buffer.concat(chunks).toString() || "{}")
    }
    if (url.pathname === "/openapi.json") {
      state.openapiReads++
      if (drop("openapi", request)) return
      return json(200, contract)
    }
    if (url.pathname === "/api/info") return json(200, { version: "fixture", pid: process.pid })
    if (url.pathname === "/api/model") return json(200, { data: models })
    if (url.pathname === "/api/session/active") return json(200, { data: Object.fromEntries([...sessions.values()].filter((item) => item.running).map((item) => [item.id, { type: "running" }])) })
    if (request.method === "POST" && url.pathname === "/api/session") {
      const input = await read()
      state.createBodies.push(input)
      const id = input.id ?? `ses_${randomUUID()}`
      if (!sessions.has(id)) {
        sessions.set(id, { ...input, id, running: false, turns: 0, messages: [], inbox: new Map(), admitted: new Map(), instructions: {} })
        state.created++
      }
      if (drop("create", request)) return
      return json(200, { data: sessions.get(id) })
    }
    const sessionID = /\/api\/(?:experimental\/)?session\/([^/]+)/.exec(url.pathname)?.[1]
    const session = sessions.get(decodeURIComponent(sessionID ?? ""))
    if (!session) return json(404, { error: "session not found" })
    if (request.method === "POST" && url.pathname.endsWith("/prompt")) {
      const input = await read()
      const id = input.id ?? `msg_${randomUUID()}`
      if ([...sessions.values()].some((other) => other.id !== session.id && other.admitted.has(id))) return json(409, { error: "cross-session ID reuse" })
      let item = session.admitted.get(id)
      if (!item) {
        item = { id, sessionID: session.id, type: "user", time: { created: Date.now() }, delivery: input.delivery ?? "steer", payload: { text: input.text, ...(input.metadata ? { metadata: input.metadata } : {}) } }
        session.admitted.set(id, item)
        session.inbox.set(id, item)
        session.turns++
        state.prompts++
        state.promptTexts.push(input.text)
        state.deliveries.push(item.delivery)
      }
      // Core reconciles delivered input from projected history. Its returned time is
      // delivery time; the payload is still the original one. Empty wakes are omitted
      // in this provider-free fixture, but no delivered input is ever reinserted.
      const delivered = session.messages.find((message) => message.id === id && message.type === "user")
      if (delivered) item = { ...item, time: delivered.time, delivery: input.delivery ?? "steer" }
      if (input.resume !== false && session.inbox.has(id)) {
        if (session.running && item.delivery === "steer") later(() => { if (session.running) promote(session, item) }, deliveryDelayMs)
        else wake(session)
      }
      if (drop("prompt", request)) return
      return json(200, { data: item })
    }
    if (request.method === "POST" && url.pathname.endsWith("/wait")) {
      state.waits++
      if (drop("wait", request)) return
      if (!session.running) return json(204)
      const pending = waiters.get(session.id) ?? []
      const done = () => json(204)
      pending.push(done)
      waiters.set(session.id, pending)
      response.on("close", () => { const at = pending.indexOf(done); if (at >= 0) pending.splice(at, 1) })
      return
    }
    if (request.method === "POST" && url.pathname.endsWith("/interrupt")) {
      state.interrupts++
      settle(session, "interrupted")
      if (drop("interrupt", request)) return
      return json(204)
    }
    if (request.method === "PUT" && url.pathname.includes("/instructions/entries/")) {
      if (!instructions) return json(404)
      session.instructions[url.pathname.split("/").at(-1)] = (await read()).value
      state.instructionWrites++
      return json(204)
    }
    if (url.pathname.endsWith("/inbox")) return json(200, { data: [...session.inbox.values()] })
    if (url.pathname.endsWith("/diff")) return json(200, { data: diffFiles })
    if (url.pathname.endsWith("/message")) {
      state.messageReads++
      if (drop("messages", request)) return
      if (url.searchParams.has("cursor") && url.searchParams.has("order")) return json(400, { error: "cursor and order are exclusive" })
      const limit = Number(url.searchParams.get("limit") ?? 20)
      const type = url.searchParams.get("type")
      const all = [...session.messages].reverse().filter((item) => !type || item.type === type)
      const offset = Number(url.searchParams.get("cursor") ?? 0)
      return json(200, { data: all.slice(offset, offset + limit), cursor: offset + limit < all.length ? { next: String(offset + limit) } : {} })
    }
    if (request.method === "GET" && url.pathname === `/api/session/${session.id}`) return json(200, { data: { id: session.id, title: session.title, location: session.location, metadata: session.metadata, time: { updated: session.messages.at(-1)?.time?.created ?? 0 } } })
    return json(404, { error: "not found" })
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return {
    url: `http://127.0.0.1:${server.address().port}`, state, sessions,
    finish: (id, outcome = "succeeded") => settle(sessions.get(id), outcome),
    deliver: (id) => { const session = sessions.get(id); for (const item of session.inbox.values()) promote(session, item) },
    close: () => new Promise((done) => {
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections()
      server.close(done)
    }),
  }
}

export function fixtureApi(module, url) {
  return module.createApi(async (path, options = {}) => {
    const response = await fetch(url + path, {
      method: options.method ?? "GET",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    if (!response.ok) { const error = new Error(`HTTP ${response.status}`); error.status = response.status; throw error }
    return response.status === 204 ? undefined : response.json()
  })
}
