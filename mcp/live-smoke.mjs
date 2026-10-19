// Explicit opt-in acceptance against the real local service and a free model.
// Runs only harmless prompts in a new temporary directory; keeps session IDs as evidence.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import * as api from "./opencode.mjs"
import { createTools } from "./tools.mjs"
import { modelRef, usableModels } from "../src/models.mjs"

if (!process.argv.includes("--run")) {
  console.error("Explicit opt-in required: node mcp/live-smoke.mjs --run [--model=opencode/deepseek-v4.1-flash-free]")
  process.exit(2)
}
const chosen = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ?? "opencode/deepseek-v4.1-flash-free"
const models = usableModels(await api.catalog())
const model = models.find((item) => modelRef(item) === chosen)
assert.ok(model, `Not an available free tool-capable model: ${chosen}`)
const { version, pid } = await api.connection()
const directory = mkdtempSync(join(tmpdir(), "ocw-live-smoke-"))
const marker = `OCW_${randomUUID().slice(0, 8)}`
writeFileSync(join(directory, "marker.txt"), marker, "utf8")
const reportPath = resolve(fileURLToPath(new URL("../.state/", import.meta.url)), `live-smoke-${Date.now()}.json`)
mkdirSync(dirname(reportPath), { recursive: true })
const report = { started: new Date().toISOString(), service: { version, pid }, model: chosen, directory, checks: [] }
function record(name, value) {
  report.checks.push({ name, ...value })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ name, ...value }))
}
const env = { ...process.env, OPENCODE_MCP_DIRECTORY: directory, OPENCODE_MCP_MODEL: chosen, OPENCODE_MCP_CALLER: "live-smoke", OPENCODE_MCP_DELEGATE_WAIT_MS: "25", OPENCODE_MCP_WAIT_MS: "60000", OPENCODE_MCP_PROTOCOL: "on" }
async function connect() {
  const client = new Client({ name: "live-smoke", version: "1" })
  const transport = new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("./index.mjs", import.meta.url))], env, stderr: "pipe" })
  await client.connect(transport)
  return client
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 })
  assert.ok(!result.isError && result.structuredContent, JSON.stringify(result))
  return result.structuredContent
}
async function settle(client, result) {
  // Do not resubmit or poll a still-running task more often than once a minute.
  for (let attempt = 0; result.input_status !== "settled" && attempt < 4; attempt++) {
    await new Promise((done) => setTimeout(done, 60_000))
    result = await call(client, "opencode_session", { action: "wait", session_id: result.session_id })
  }
  assert.equal(result.input_status, "settled", JSON.stringify(result))
  return result
}
let client
try {
  client = await connect()
  const first = await call(client, "opencode_delegate", { task: "Acceptance check: read marker.txt with a file-reading tool, then reply LIVE_DELEGATE_OK:<file contents>. Do not modify files or use network tools." })
  record("delegate-start", first)
  await client.close()
  client = await connect()
  const completed = await settle(client, first)
  assert.equal(completed.input_outcome, "succeeded", JSON.stringify(completed))
  assert.ok(completed.text.includes(`LIVE_DELEGATE_OK:${marker}`), completed.text)
  const history = await api.messages(first.session_id, 200)
  assert.ok(history.some((message) => message.content?.some((part) => part.type === "tool")), "No real tool call recorded")
  record("delegate-after-reconnect", completed)

  const followUp = await settle(client, await call(client, "opencode_session", { action: "message", session_id: first.session_id, text: `Reply LIVE_FOLLOWUP_OK:${marker}. No tools are needed.` }))
  assert.equal(followUp.input_outcome, "succeeded", JSON.stringify(followUp))
  assert.notEqual(followUp.input_id, first.input_id)
  assert.ok(followUp.text.includes(`LIVE_FOLLOWUP_OK:${marker}`), followUp.text)
  assert.ok(!followUp.text.includes("LIVE_DELEGATE_OK"), followUp.text)
  record("follow-up", followUp)

  const inputID = `msg_${randomUUID()}`
  const inputText = "Reply LIVE_IDEMPOTENT_OK. No tools are needed."
  await api.prompt(first.session_id, inputText, { id: inputID, resume: false })
  await api.prompt(first.session_id, inputText, { id: inputID, resume: false })
  assert.equal((await api.inbox(first.session_id)).filter((item) => item.id === inputID).length, 1)
  await api.prompt(first.session_id, inputText, { id: inputID })
  const retried = await settle(client, await call(client, "opencode_session", { action: "wait", session_id: first.session_id }))
  assert.equal(retried.input_outcome, "succeeded", JSON.stringify(retried))
  assert.ok(retried.text.includes("LIVE_IDEMPOTENT_OK"), JSON.stringify(retried))
  assert.equal((await api.messagePage(first.session_id, { type: "user" })).data.filter((item) => item.id === inputID).length, 1)
  record("stable-input-retry", retried)

  // Reproduce the old client-ID regression through the real provider, without altering
  // credentials or service configuration. If upstream policy changes, retain that result.
  const bad = (await api.request("/api/session", { method: "POST", body: { id: `ses_${randomUUID()}`, title: "live-smoke client-ID negative control", location: { directory }, model: { providerID: model.providerID, id: model.id }, metadata: { origin: "opencode-delegate", caller: "live-smoke" } } })).data
  const negative = await settle(client, await call(client, "opencode_session", { action: "message", session_id: bad.id, text: "Reply LIVE_NEGATIVE_CONTROL. Do not use any tools." }))
  if (negative.input_outcome === "failed") {
    assert.equal(negative.input_error?.type, "provider.auth", JSON.stringify(negative))
    assert.equal(negative.input_error.status, 403, JSON.stringify(negative))
    assert.ok(negative.input_error.message, JSON.stringify(negative))
  } else {
    assert.equal(negative.input_outcome, "succeeded", JSON.stringify(negative))
    assert.ok(negative.text.includes("LIVE_NEGATIVE_CONTROL"), JSON.stringify(negative))
  }
  record("client-ID-negative-control", negative)

  // Use the real service, pausing a later input exactly between wait and report to make
  // the otherwise timing-dependent settled+pending boundary deterministic.
  let parkedID
  const boundaryTools = createTools({ env: { ...env, OPENCODE_MCP_DELEGATE_WAIT_MS: "60000" }, api: { ...api, wait: async (id, ms) => {
    const waited = await api.wait(id, ms)
    assert.ok(waited.completed, "Live boundary task exceeded its wait budget")
    parkedID = (await api.prompt(id, "Acceptance check left paused; reply LIVE_PARKED if explicitly resumed. No tools.", { delivery: "queue", resume: false })).id
    return waited
  } } })
  const boundary = await boundaryTools.opencode_delegate.handler({ task: "Reply LIVE_BOUNDARY_OK. No tools are needed." })
  record("settled-with-pending", { ...boundary.structured, parked_id: parkedID })
  assert.equal(boundary.structured.state, "queued")
  assert.equal(boundary.structured.input_outcome, "succeeded")
  assert.ok(boundary.structured.text.includes("LIVE_BOUNDARY_OK"), JSON.stringify(boundary))
  assert.ok((await api.inbox(boundary.structured.session_id)).some((item) => item.id === parkedID))
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.message
  throw error
} finally {
  await client?.close().catch(() => {})
  report.finished = new Date().toISOString()
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
  console.log(`Live acceptance report: ${reportPath}`)
}
