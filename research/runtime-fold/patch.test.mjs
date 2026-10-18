import { test, expect } from "bun:test"
import { patchTimeline } from "./patch.mjs"
const original = await Bun.file(new URL("./.cache/official.js", import.meta.url)).text()
test("known installed bundle is changed once and remains parseable", () => {
  const result = patchTimeline(original)
  expect(result.applied).toBe(true)
  expect(result.code.split("globalThis.__ocwFold.wrap").length - 1).toBe(1)
  expect(result.code.replace(result.replacement, result.original)).toBe(original)
  new Bun.Transpiler({ loader: "js" }).scan(result.code)
})
test("unknown, already patched, and truncated bundles are returned byte-for-byte", () => {
  for (const candidate of [original + "\n/* changed */", original.slice(0, -40), patchTimeline(original).code]) {
    const result = patchTimeline(candidate)
    expect(result.applied).toBe(false)
    expect(result.code).toBe(candidate)
  }
})
test("bounded eager mode also remains parseable", () => {
  const result = patchTimeline(original, { eagerLimit: 300 })
  expect(result.applied).toBe(true)
  new Bun.Transpiler({ loader: "js" }).scan(result.code)
})
