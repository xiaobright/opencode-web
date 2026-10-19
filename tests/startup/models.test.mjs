import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createBackend } from "../../src/backend.mjs"
import { createUiServer } from "../../src/ui-server.mjs"
import { normalizeModel, rankModels, readRanking, selectModel, usableModels, writeRanking } from "../../src/models.mjs"

const overlayDir = fileURLToPath(new URL("../../webui", import.meta.url))
const stateDir = mkdtempSync(join(tmpdir(), "ocw-models-"))
const rankingFile = join(stateDir, "model-ranking.json")

const RAW = [
  { modelID: "alpha-free", providerID: "opencode", name: "Alpha Free", limit: { context: 200_000 }, capabilities: { tools: true }, cost: [{ input: 0, output: 0 }], status: "active", enabled: true },
  { modelID: "beta-free", providerID: "opencode", name: "Beta Free", limit: { context: 128_000 }, capabilities: { tools: true }, cost: [{ input: 0, output: 0 }], status: "active", enabled: true },
  { modelID: "paid", providerID: "opencode", name: "Paid", limit: { context: 100_000 }, capabilities: { tools: true }, cost: [{ input: 3, output: 15 }], status: "active", enabled: true },
  { modelID: "no-tools", providerID: "opencode", name: "No Tools", limit: { context: 100_000 }, capabilities: { tools: false }, cost: [{ input: 0, output: 0 }], status: "active", enabled: true },
  { modelID: "off", providerID: "opencode", name: "Disabled", limit: { context: 100_000 }, capabilities: { tools: true }, cost: [{ input: 0, output: 0 }], status: "active", enabled: false },
]

let upstream
let server
let url

beforeAll(async () => {
  process.env.OPENCODE_WEB_STATE_DIR = stateDir
  upstream = createServer((request, response) => {
    if (request.url === "/api/model") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: RAW }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done))
  const info = { url: `http://127.0.0.1:${upstream.address().port}`, password: "fixture" }
  const backend = createBackend({ service: { discover: async () => info, resolve: async () => info, stop: async () => {} } })
  server = createUiServer({ overlayDir, backend, idleMs: 0 })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  url = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  upstream.closeAllConnections()
  await new Promise((done) => upstream.close(done))
  delete process.env.OPENCODE_WEB_STATE_DIR
})

test("only free, enabled, tool-capable models are offered, in ranking order", () => {
  const models = RAW.map(normalizeModel)
  expect(usableModels(models).map((model) => model.id)).toEqual(["alpha-free", "beta-free"])
  const ranked = rankModels(usableModels(models), ["opencode/beta-free"])
  expect(ranked.map((model) => model.id)).toEqual(["beta-free", "alpha-free"])
  expect(selectModel(models, ["opencode/beta-free"]).id).toBe("beta-free")
  expect(selectModel(models, []).id).toBe("alpha-free")
  expect(selectModel(models, ["opencode/beta-free"], "opencode/alpha-free").id).toBe("alpha-free")
  expect(selectModel(models, [], "opencode/retired").id).toBe("alpha-free")
})

test("ranking round-trips through one file and deduplicates", () => {
  const path = join(stateDir, "roundtrip.json")
  expect(readRanking(path)).toEqual([])
  expect(writeRanking(["opencode/b", "opencode/a", "opencode/b"], path)).toEqual(["opencode/b", "opencode/a"])
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ranking: ["opencode/b", "opencode/a"] })
  expect(readRanking(path)).toEqual(["opencode/b", "opencode/a"])
})

test("the gateway serves the live catalog, saves an order, and rejects foreign writes", async () => {
  const first = await (await fetch(`${url}/__opencode-web/models`)).json()
  expect(first.available).toBe(true)
  expect(first.models.map((model) => model.id)).toEqual(["alpha-free", "beta-free"])
  expect(first.selected).toBe("opencode/alpha-free")

  const saved = await fetch(`${url}/__opencode-web/models`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ ranking: ["opencode/beta-free", "opencode/alpha-free"] }),
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({ ok: true, ranking: ["opencode/beta-free", "opencode/alpha-free"] })
  expect(readRanking(rankingFile)).toEqual(["opencode/beta-free", "opencode/alpha-free"])

  const second = await (await fetch(`${url}/__opencode-web/models`)).json()
  expect(second.models.map((model) => model.id)).toEqual(["beta-free", "alpha-free"])
  expect(second.selected).toBe("opencode/beta-free")

  const foreign = await fetch(`${url}/__opencode-web/models`, {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ ranking: ["opencode/alpha-free"] }),
  })
  expect(foreign.status).toBe(403)

  const bad = await fetch(`${url}/__opencode-web/models`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ ranking: "nope" }),
  })
  expect(bad.status).toBe(400)
})
