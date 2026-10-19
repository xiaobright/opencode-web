import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

test("old active metadata refreshes on completion, later edits and deletion", async () => {
  let now = 100_000
  let active = true
  let title = "running"
  let deleted = false
  let metadataReads = 0
  const context = {
    window: {}, Map, Set, Array, Object, Number, String, Boolean, Promise, AbortSignal,
    Date: { now: () => now },
    fetch: async (path) => {
      let data
      let status = 200
      if (path === "/api/session?order=desc") data = { data: [], cursor: {} }
      else if (path === "/api/session/active") data = { data: active ? { ses_old: {} } : {} }
      else if (path === "/api/session/ses_old") {
        metadataReads++
        status = deleted ? 404 : 200
        data = { data: { id: "ses_old", title, metadata: { origin: "opencode-delegate" }, time: { updated: now } } }
      } else throw new Error(`Unexpected request ${path}`)
      return { ok: status === 200, status, json: async () => data }
    },
  }
  runInNewContext(readFileSync(new URL("../../webui/scripts/background-data.js", import.meta.url), "utf8"), context)
  const store = context.window.__ocwBackground
  expect((await store.refresh()).items[0].title).toBe("running")
  active = false
  title = "completed"
  now += 2500
  expect((await store.refresh()).items[0].title).toBe("completed")
  now += 2500
  await store.refresh()
  expect(metadataReads).toBe(2)
  title = "renamed elsewhere"
  now += 60_000
  expect((await store.refresh()).items[0].title).toBe("renamed elsewhere")
  deleted = true
  now += 60_000
  expect((await store.refresh()).items).toHaveLength(0)
})
