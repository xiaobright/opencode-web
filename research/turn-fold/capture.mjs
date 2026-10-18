import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { discover, authorization } from "../../src/service.mjs"

// Read-only capture of the one explicitly requested session. Never logs credentials or message bodies.
const service = await discover()
if (!service) throw new Error("An existing OpenCode service is required")
const headers = { authorization: authorization(service) }
const requests = []
async function get(path, params = {}) {
  const url = new URL(path, service.url)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const started = performance.now()
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Capture HTTP ${response.status}: ${path}`)
  const body = await response.text()
  requests.push({ path, ms: performance.now() - started, bytes: Buffer.byteLength(body) })
  return JSON.parse(body)
}
const title = "HY3模型评测打分"
const directory = "E:\\Desktop\\mytests\\modeltest"
const found = await get("/api/session", { search: title, limit: "100" })
const matches = found.data.filter((item) => item.title === title && item.location.directory.toLowerCase() === directory.toLowerCase())
if (matches.length !== 1) throw new Error(`Expected one exact session, found ${matches.length}`)
const session = matches[0]
const messages = []
let cursor
const cursors = new Set()
do {
  const page = await get(`/api/session/${session.id}/message`, { limit: "200", ...(cursor ? { cursor } : { order: "asc" }) })
  messages.push(...page.data)
  cursor = page.cursor?.next
  if (cursor && cursors.has(cursor)) throw new Error("Repeated pagination cursor")
  if (cursor) cursors.add(cursor)
} while (cursor)
if (new Set(messages.map((item) => item.id)).size !== messages.length) throw new Error("Duplicate messages across pages")
const types = {}
const parts = {}
let textChars = 0
let toolOutputChars = 0
for (const message of messages) {
  types[message.type] = (types[message.type] ?? 0) + 1
  for (const part of message.content ?? []) {
    parts[part.type] = (parts[part.type] ?? 0) + 1
    textChars += part.text?.length ?? 0
    toolOutputChars += (part.state?.content ?? []).reduce((sum, item) => sum + (item.text?.length ?? 0), 0)
  }
}
const body = JSON.stringify({ session, messages })
const summary = { title, sessionID: session.id, capturedAt: new Date().toISOString(), version: service.version, messages: messages.length, types, parts, textChars, toolOutputChars, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), requests }
await mkdir(new URL("./.cache/", import.meta.url), { recursive: true })
await writeFile(new URL("./.cache/hy3.json", import.meta.url), body)
await writeFile(new URL("./.cache/capture.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n")
console.log(JSON.stringify(summary))
