import { test, expect } from "bun:test"
import { pathToFileURL } from "node:url"
import { upstream } from "./deps.mjs"
import { foldProjection } from "./project.mjs"
const { Timeline } = await import(pathToFileURL(`${upstream}/packages/session-ui/src/timeline/projection.ts`).href)
const { userMessage, assistantMessage, textPart, toolPart } = await import(pathToFileURL(`${upstream}/packages/app/e2e/utils/timeline.ts`).href)

function fixture(state = "completed") {
  return [userMessage(), assistantMessage([
    textPart("prt_before", "Intermediate explanation"),
    toolPart("prt_read", "read", state, { filePath: "file.ts" }, state === "error" ? { error: "Read failed" } : { output: "content" }),
    textPart("prt_answer", "Final answer"),
  ])]
}
test("folds existing rows without modifying messages and restores original row identities", () => {
  const messages = fixture()
  const snapshot = JSON.stringify(messages)
  const args = [messages, true, { type: "idle" }]
  const original = Timeline.constructSessionMessageRows(...args)
  const folded = foldProjection(original, args, Timeline, () => false)
  expect(folded.after).toBe(2)
  expect(folded.before).toBe(4)
  expect(folded.projection.rows[0]).toBe(original.rows[0])
  expect(folded.projection.rows[1]).toBe(original.rows.at(-1))
  expect(foldProjection(original, args, Timeline, () => true).projection.rows).toEqual(original.rows)
  expect(JSON.stringify(messages)).toBe(snapshot)
})
test("busy, errored, and pending-tool turns stay intact", () => {
  for (const state of ["busy", "error", "running"]) {
    const messages = fixture(state === "busy" ? "completed" : state)
    const args = [messages, true, { type: state === "busy" ? "busy" : "idle" }]
    const original = Timeline.constructSessionMessageRows(...args)
    expect(foldProjection(original, args, Timeline, () => false).projection.rows).toEqual(original.rows)
  }
})
