import { test, expect } from "bun:test"
import { pathToFileURL } from "node:url"
import { upstream } from "../runtime-fold/deps.mjs"
import { createGroups } from "./groups.mjs"
import { patch } from "./patch.mjs"
const { Timeline } = await import(pathToFileURL(`${upstream}/packages/session-ui/src/timeline/projection.ts`).href)
const { userMessage, assistantMessage, textPart, toolPart } = await import(pathToFileURL(`${upstream}/packages/app/e2e/utils/timeline.ts`).href)
function fixture(state = "completed") {
  return [userMessage(), assistantMessage([
    textPart("before", "Intermediate explanation"),
    toolPart("read", "read", state, { filePath: "file.ts" }, state === "error" ? { error: "Read failed" } : { output: "content" }),
    textPart("answer1", "Final answer paragraph one"),
    textPart("answer2", "Final answer paragraph two"),
  ])]
}
test("summary is an actual list row; preserves all final text and restores original process rows", () => {
  const messages = fixture()
  const saved = JSON.stringify(messages)
  const original = Timeline.constructSessionMessageRows(messages, true, { type: "idle" })
  const group = createGroups()
  const closed = group(original, messages, { type: "idle" }, Timeline, () => false)
  expect(closed.projection.rows.length).toBe(4)
  expect(closed.projection.rows[1].group.ocw.tools).toBe(1)
  expect(closed.projection.rows.slice(-2)).toEqual(original.rows.slice(-2))
  const open = group(original, messages, { type: "idle" }, Timeline, () => true)
  expect(open.projection.rows.filter((r) => !r.group?.ocw)).toEqual(original.rows)
  expect(open.stats.cacheHits).toBe(1)
  expect(JSON.stringify(messages)).toBe(saved)
})
test("active, interrupted, and failed tools stay visible; cache invalidates status changes", () => {
  for (const state of ["running", "error", "busy"]) {
    const messages = fixture(state === "busy" ? "completed" : state)
    const status = { type: state === "busy" ? "busy" : "idle" }
    const original = Timeline.constructSessionMessageRows(messages, true, status)
    expect(createGroups()(original, messages, status, Timeline, () => false).stats.turns).toEqual([])
  }
  const messages = fixture()
  const group = createGroups()
  const args = [Timeline.constructSessionMessageRows(messages, true, { type: "idle" }), messages, { type: "idle" }, Timeline, () => false]
  expect(group(...args).stats.turns.length).toBe(1)
  messages[1].content[1].state.status = "running"
  expect(group(...args).stats.turns.length).toBe(0)
})
test("an unfinished or failed assistant cannot fold merely because its tools completed", () => {
  for (const incomplete of [true, false]) {
    const messages = fixture()
    const original = Timeline.constructSessionMessageRows(messages, true, { type: "idle" })
    if (incomplete) delete messages[1].time.completed
    else messages[1].error = { name: "MessageAbortedError", data: { message: "Interrupted" } }
    const result = createGroups()(original, messages, { type: "idle" }, Timeline, () => false)
    expect(result.projection.rows).toEqual(original.rows)
  }
})

test("release patch syntax and byte-for-byte fallback on unknown or already patched builds", async () => {
  const official = await Bun.file(new URL("../runtime-fold/.cache/official.js", import.meta.url)).text()
  for (const mode of ["baseline", "grouped"]) {
    const result = patch(official, mode)
    expect(result.applied).toBe(true)
    new Bun.Transpiler({ loader: "js" }).scan(result.code)
    expect(patch(result.code).code).toBe(result.code)
  }
  expect(patch(official + "\n").applied).toBe(false)
})
