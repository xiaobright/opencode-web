// HTTP client for the local opencode background service.
//
// Discovery and start/stop reuse the gateway's service module: the MCP server shares one
// background service with the TUI, the desktop app and the web UI. The service may be
// asleep (the web gateway stops it when idle), so every call resolves it first and a
// dropped connection gets one retry with a fresh discovery.

import { existsSync, statSync } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"
import { resolve } from "../src/service.mjs"

const CONNECTION_TTL_MS = 5_000

let cached
let cachedAt = 0

export async function connection({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CONNECTION_TTL_MS) return cached

  const found = await resolve()
  cached = {
    url: found.url,
    authorization: `Basic ${Buffer.from(`opencode:${found.password}`).toString("base64")}`,
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
  const first = await connection()
  try {
    return await fetchOnce(first, path, options)
  } catch (error) {
    if (!isConnectionError(error) || options.retry === false) throw error
    // The service was restarted or auto-slept between calls; resolve once more.
    return await fetchOnce(await connection({ force: true }), path, options)
  }
}

const sessionPath = (sessionID, suffix = "") => `/api/session/${encodeURIComponent(sessionID)}${suffix}`

export async function createSession({ title, directory, model, agent, permissions }) {
  const body = await request("/api/session", {
    method: "POST",
    body: {
      title,
      location: { directory },
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      ...(permissions ? { permissions } : {}),
    },
  })
  return body.data
}

export async function prompt(sessionID, text) {
  const body = await request(sessionPath(sessionID, "/prompt"), { method: "POST", body: { text } })
  return body.data
}

/** Newest first, like the endpoint itself. */
export async function messages(sessionID, limit = 100) {
  const body = await request(sessionPath(sessionID, `/message?limit=${limit}`))
  return Array.isArray(body?.data) ? body.data : []
}

export async function sessionInfo(sessionID) {
  const body = await request(sessionPath(sessionID))
  return body.data
}

export async function activeSessions() {
  const body = await request("/api/session/active")
  return new Set(Object.keys(body?.data ?? {}))
}

export async function interrupt(sessionID) {
  return request(sessionPath(sessionID, "/interrupt"), { method: "POST" })
}

/** Resolves when the session agent loop is idle; never throws on timeout. */
export async function wait(sessionID, timeoutMs) {
  const started = Date.now()
  try {
    await request(`/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, {
      method: "POST",
      timeoutMs,
    })
    return { completed: true, waitedMs: Date.now() - started }
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError")
      return { completed: false, waitedMs: Date.now() - started }
    // A loop that has not registered yet cannot be awaited; treat it as still starting.
    if (error?.status === 503) return { completed: false, waitedMs: Date.now() - started }
    throw error
  }
}

export async function catalog() {
  const body = await request("/api/model")
  return Array.isArray(body?.data) ? body.data.map(normalizeModel) : []
}

export function normalizeModel(model) {
  const cost = Array.isArray(model.cost) ? model.cost : []
  return {
    id: model.modelID ?? model.id,
    providerID: model.providerID,
    name: model.name ?? model.modelID ?? model.id,
    context: model.limit?.context ?? null,
    tools: Boolean(model.capabilities?.tools),
    free: cost.length > 0 && cost.every((entry) => (entry.input ?? 0) === 0 && (entry.output ?? 0) === 0),
    status: model.status ?? "unknown",
    enabled: model.enabled !== false,
  }
}

/**
 * Accepts "provider/modelID" or a bare "modelID" (opencode provider wins a tie).
 * Returns the Model.Ref the session API expects.
 */
export function parseModelRef(ref, models) {
  const text = String(ref ?? "").trim()
  if (!text) throw new Error("model must not be empty")

  const slash = text.indexOf("/")
  if (slash > 0) {
    const providerID = text.slice(0, slash)
    const id = text.slice(slash + 1)
    const found = models.find((model) => model.providerID === providerID && model.id === id)
    if (!found) throw new Error(`unknown model ${text}; run opencode_models to list available models`)
    return { providerID, id }
  }

  const matches = models.filter((model) => model.id === text || model.name === text)
  const found = matches.find((model) => model.providerID === "opencode") ?? matches[0]
  if (!found) throw new Error(`unknown model ${text}; run opencode_models to list available models`)
  return { providerID: found.providerID, id: found.id }
}

export function freeModels(models) {
  return models.filter((model) => model.free && model.enabled && model.tools)
}

/** The default free model, with a fallback when the pinned one disappears from the catalog. */
export function defaultModel(models, preferred) {
  const free = freeModels(models)
  const wanted = preferred ? parseModelRefOrUndefined(preferred, models) : undefined
  if (wanted) return wanted
  if (free.length > 0) return { providerID: free[0].providerID, id: free[0].id }
  throw new Error("no free tool-capable model is available; run opencode_models to inspect the catalog")
}

function parseModelRefOrUndefined(ref, models) {
  try {
    return parseModelRef(ref, models)
  } catch {
    return undefined
  }
}

export function normalizeDirectory(directory) {
  const text = String(directory ?? "").trim()
  if (!text) throw new Error("directory must not be empty")
  const absolute = isAbsolute(text) ? resolvePath(text) : resolvePath(process.cwd(), text)
  if (!existsSync(absolute)) throw new Error(`directory does not exist: ${absolute}`)
  if (!statSync(absolute).isDirectory()) throw new Error(`not a directory: ${absolute}`)
  return absolute
}
