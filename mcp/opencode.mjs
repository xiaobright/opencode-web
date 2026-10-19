// HTTP client for the local opencode background service.
//
// Discovery and start/stop reuse the gateway's service module: the MCP server shares one
// background service with the TUI, the desktop app and the web UI. The service may be
// asleep (the web gateway stops it when idle), so every call resolves it first and a
// dropped connection gets one retry with a fresh discovery only for safe requests.

import { existsSync, statSync } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"
import { resolve } from "../src/service.mjs"
import { normalizeModel } from "../src/models.mjs"
import { randomUUID } from "node:crypto"
import { contractCache, inspectContract } from "./compatibility.mjs"

export { normalizeModel }

const CONNECTION_TTL_MS = 5_000

let cached
let cachedAt = 0

export async function connection({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CONNECTION_TTL_MS) return cached

  const found = await resolve()
  cached = {
    url: found.url,
    authorization: `Basic ${Buffer.from(`opencode:${found.password}`).toString("base64")}`,
    version: found.info?.version,
    pid: found.info?.pid,
  }
  cachedAt = Date.now()
  return cached
}

function isConnectionError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return false
  return error instanceof TypeError || error?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED"
}

async function fetchOnce(target, path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const response = await fetch(target.url + path, {
    method,
    headers: {
      authorization: target.authorization,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const error = new Error(`${method} ${path} returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`)
    error.status = response.status
    throw error
  }

  if (response.status === 204) return undefined
  const type = response.headers.get("content-type") ?? ""
  return type.includes("application/json") ? response.json() : response.text()
}

export async function request(path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase()
  const safe = method === "GET" || method === "HEAD" || options.retry === true
  const first = await connection()
  if (options.contract) await checkTarget(first)
  try {
    return await fetchOnce(first, path, options)
  } catch (error) {
    if (!isConnectionError(error) || options.retry === false) throw error
    if (!safe)
      throw new Error(`${method} ${path}: connection lost; the request may have been accepted and was not retried. Check the session before submitting again.`, { cause: error })
    // The service was restarted or auto-slept between calls; resolve once more.
    const next = await connection({ force: true })
    if (options.contract) await checkTarget(next, { force: true })
    return await fetchOnce(next, path, options)
  }
}

const checkTarget = contractCache((target) => fetchOnce(target, "/openapi.json"))

const sessionPath = (sessionID, suffix = "") => `/api/session/${encodeURIComponent(sessionID)}${suffix}`

/** Inject only HTTP transport in tests; route, payload and retry policy stay production code. */
export function createApi(call = request) {
  async function capabilities() {
    // The production transport and mutation checks share the same identity-scoped cache.
    // Injected HTTP transports (fixtures) supply their own target and need no discovery.
    if (call !== request) return inspectContract(await call("/openapi.json"))
    try {
      return await checkTarget(await connection())
    } catch (error) {
      // The contract read is safe to retry if discovery raced with service shutdown.
      if (!isConnectionError(error)) throw error
      return checkTarget(await connection({ force: true }), { force: true })
    }
  }
  async function write(path, body, identity) {
    await capabilities()
    try {
      const result = (await call(path, { method: "POST", body, retry: true, contract: true }))?.data
      if (result?.id !== body.id) throw new Error("OpenCode did not preserve the supplied ID; incompatible admission response")
      return result
    } catch (error) {
      throw new Error(`${identity}: ${error.message}. Admission may have succeeded; inspect this session before submitting a new input.`, { cause: error })
    }
  }
  async function createSession({ title, directory, model, agent, permissions, metadata }) {
    await capabilities()
    // Free-model acceptance returned 403 provider.auth for caller-supplied session ids.
    // Let the service mint them. Without a stable id the POST cannot be retried, so a
    // lost response is reported instead of risking a second session.
    try {
      const result = (await call("/api/session", {
        method: "POST",
        body: { title, location: { directory }, model, agent, permissions, metadata },
        contract: true,
      }))?.data
      if (typeof result?.id !== "string" || !result.id) throw new Error("OpenCode returned no session id")
      return result
    } catch (error) {
      throw new Error(`Session creation: ${error.message}. The service may have created it; list sessions before creating another.`, { cause: error })
    }
  }
  async function prompt(sessionID, text, { id = `msg_${randomUUID()}`, delivery = "steer", metadata, resume } = {}) {
    return write(sessionPath(sessionID, "/prompt"), { id, text, delivery, metadata, resume }, `Session ${sessionID}, input ${id}`)
  }
  async function messagePage(sessionID, { limit = 200, cursor, type } = {}) {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : { order: "desc" }), ...(type ? { type } : {}) })
    const body = await call(sessionPath(sessionID, `/message?${query}`))
    if (!Array.isArray(body?.data)) throw new Error("Invalid OpenCode messages response")
    return { data: body.data, cursor: body.cursor ?? {} }
  }
  async function inbox(sessionID) {
    const body = await call(sessionPath(sessionID, "/inbox"))
    if (!Array.isArray(body?.data)) throw new Error("Invalid OpenCode inbox response")
    return body.data
  }
  async function activeSessions() {
    const body = await call("/api/session/active")
    if (!body?.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new Error("Invalid OpenCode active sessions response")
    return new Set(Object.keys(body.data))
  }
  async function wait(sessionID, timeoutMs) {
    const started = Date.now()
    try {
      await call(`/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, { method: "POST", timeoutMs, retry: true })
      return { completed: true, waitedMs: Date.now() - started }
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError" || error?.status === 503)
        return { completed: false, waitedMs: Date.now() - started }
      throw error
    }
  }
  return {
    capabilities, createSession, prompt, messagePage, inbox, activeSessions, wait,
    messages: async (id, limit = 100) => (await messagePage(id, { limit })).data,
    sessionInfo: async (id) => (await call(sessionPath(id))).data,
    diff: async (id) => summarizeDiff((await call(sessionPath(id, "/diff"))).data),
    interrupt: (id) => call(sessionPath(id, "/interrupt"), { method: "POST" }),
    setInstruction: (id, key, value) => call(`/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/${encodeURIComponent(key)}`, { method: "PUT", body: { value }, retry: true, contract: true }),
    catalog: async () => (await call("/api/model")).data.map(normalizeModel),
  }
}

export const { capabilities, createSession, prompt, messagePage, inbox, activeSessions, wait, messages, sessionInfo, diff, interrupt, setInstruction, catalog } = createApi()

/** One-line summary of a session diff, shared with the test fixture. */
export function summarizeDiff(files) {
  const list = Array.isArray(files) ? files : []
  const additions = list.reduce((sum, file) => sum + (Number(file.additions) || 0), 0)
  const deletions = list.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0)
  const names = list
    .slice(0, 3)
    .map((file) => String(file.file ?? "").replaceAll("\\", "/").split("/").pop())
    .filter(Boolean)
    .join(", ")
  return { count: list.length, additions, deletions, names }
}

export function normalizeDirectory(directory) {
  if (typeof directory !== "string") throw new Error("directory must be an absolute path string")
  const text = directory.trim()
  if (!text) throw new Error("directory must not be empty")
  // A Windows rooted path without a drive still depends on the launch drive.
  if (!isAbsolute(text) || (process.platform === "win32" && /^[\\/](?![\\/])/.test(text)))
    throw new Error("directory must be an absolute path (including a drive or UNC share on Windows)")
  const absolute = resolvePath(text)
  if (!existsSync(absolute)) throw new Error(`directory does not exist: ${absolute}`)
  if (!statSync(absolute).isDirectory()) throw new Error(`not a directory: ${absolute}`)
  return absolute
}
