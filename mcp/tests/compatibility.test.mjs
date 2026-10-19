import { expect, test } from "bun:test"
import { inspectContract } from "../compatibility.mjs"
import * as module from "../opencode.mjs"
import { createTools } from "../tools.mjs"
import { BASELINE_DOCUMENT, fixtureApi, startFixture } from "./fixture.mjs"

test("capabilities match the upstream generated OpenAPI baseline, including local refs", () => {
  expect(inspectContract(BASELINE_DOCUMENT)).toMatchObject({ baseline: "654b79b", instructions: true })
  const document = structuredClone(BASELINE_DOCUMENT)
  delete document.paths["/api/experimental/session/{sessionID}/instructions/entries/{key}"]
  expect(inspectContract(document).instructions).toBe(false)
  const operation = document.paths["/api/session/{sessionID}/prompt"].post
  document.components.schemas.TestPayload = operation.requestBody.content["application/json"].schema
  operation.requestBody.content["application/json"].schema = { $ref: "#/components/schemas/TestPayload" }
  expect(inspectContract(document).baseline).toBe("654b79b")
  delete document.components.schemas.TestPayload.properties.id
  expect(() => inspectContract(document)).toThrow("payload.id")
})

test("missing lifecycle capability fails before any session or prompt is created", async () => {
  const document = structuredClone(BASELINE_DOCUMENT)
  delete document.paths["/api/session/{sessionID}/inbox"]
  const fixture = await startFixture({ document })
  try {
    const api = fixtureApi(module, fixture.url)
    const tools = createTools({ api, env: { OPENCODE_MCP_DIRECTORY: process.cwd() } })
    await expect(tools.opencode_delegate.handler({ task: "must not run" })).rejects.toThrow(/Unsupported OpenCode API.*inbox/)
    expect(fixture.state.created).toBe(0)
    expect(fixture.state.prompts).toBe(0)
  } finally { await fixture.close() }
})
