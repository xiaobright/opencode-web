import { expect, test } from "bun:test"
import { contractCache, inspectContract } from "../compatibility.mjs"
import * as module from "../opencode.mjs"
import { createTools } from "../tools.mjs"
import { BASELINE_DOCUMENT, fixtureApi, startFixture } from "./fixture.mjs"

test("capabilities match the upstream generated OpenAPI baseline, including local refs", () => {
  expect(inspectContract(BASELINE_DOCUMENT)).toMatchObject({ baseline: "654b79b", instructions: true })
  const document = structuredClone(BASELINE_DOCUMENT)
  delete document.paths["/api/session"].post.requestBody.content["application/json"].schema.properties.id
  expect(inspectContract(document).baseline).toBe("654b79b")
  delete document.paths["/api/experimental/session/{sessionID}/instructions/entries/{key}"]
  expect(inspectContract(document).instructions).toBe(false)
  const operation = document.paths["/api/session/{sessionID}/prompt"].post
  document.components.schemas.TestPayload = operation.requestBody.content["application/json"].schema
  operation.requestBody.content["application/json"].schema = { $ref: "#/components/schemas/TestPayload" }
  expect(inspectContract(document).baseline).toBe("654b79b")
  delete document.components.schemas.TestPayload.properties.id
  expect(() => inspectContract(document)).toThrow("payload.id")
})

test("contract cache expires, isolates service identities and never caches failed probes", async () => {
  let now = 1000
  let reads = 0
  let fail = false
  const probe = contractCache(async () => { reads++; if (fail) throw new Error("offline"); return BASELINE_DOCUMENT }, { now: () => now })
  const target = { url: "http://fixture", authorization: "first", pid: 1, version: "1" }
  await Promise.all([probe(target), probe(target), probe(target)])
  expect(reads).toBe(1)
  now += 599_999
  await probe(target)
  expect(reads).toBe(1)
  now++
  await probe(target)
  expect(reads).toBe(2)
  await probe(target, { force: true })
  expect(reads).toBe(3)
  fail = true
  await expect(probe(target, { force: true })).rejects.toThrow("offline")
  fail = false
  await probe(target)
  expect(reads).toBe(5)
  for (const change of [{ authorization: "second" }, { url: "http://another" }, { pid: 2 }, { version: "2" }]) await probe({ ...target, ...change })
  expect(reads).toBe(9)
})

test("missing lifecycle capability fails before any session or prompt is created", async () => {
  const document = structuredClone(BASELINE_DOCUMENT)
  delete document.paths["/api/session/{sessionID}/inbox"]
  const fixture = await startFixture({ document })
  try {
    const api = fixtureApi(module, fixture.url)
    const tools = createTools({ api, env: {} })
    await expect(tools.opencode_delegate.handler({ directory: process.cwd(), task: "must not run" })).rejects.toThrow(/Unsupported OpenCode API.*inbox/)
    expect(fixture.state.created).toBe(0)
    expect(fixture.state.prompts).toBe(0)
  } finally { await fixture.close() }
})
