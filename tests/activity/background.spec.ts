import { test, expect } from "../../research/runtime-fold/deps.mjs"
import { readFileSync } from "node:fs"

const scripts = ["background-data.js", "codex-shell.js"].map((name) => readFileSync(new URL(`../../webui/scripts/${name}`, import.meta.url), "utf8")).join("\n")
const css = readFileSync(new URL("../../webui/styles/codex.css", import.meta.url), "utf8")
const session = (id, title, stamp = 100) => ({ id, title, metadata: { origin: "opencode-delegate" }, time: { updated: stamp }, location: { directory: "E:\\fixture" } })

test("monitor includes active sessions beyond page one, paginates, caches finished details and preserves errors", async ({ page }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  const recent = session("ses_recent", "近期完成")
  const older = session("ses_older", "历史任务")
  const running = session("ses_running", "首页外运行的任务", 10)
  const reads = { ses_recent: 0, ses_older: 0, ses_running: 0 }
  let active = true
  let failActive = false
  let failDetail = false
  let more = 0
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/background-fixture") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><script>${scripts}</script>` })
    if (url.pathname === "/api/project") return route.fulfill({ json: [] })
    if (url.pathname === "/api/session/active") return route.fulfill({ status: failActive ? 503 : 200, json: { data: active ? { ses_running: {} } : {} } })
    if (url.pathname === "/api/session") {
      if (url.searchParams.has("cursor")) {
        expect(url.searchParams.has("order")).toBe(false)
        expect(url.searchParams.get("cursor")).toBe("opaque +/cursor")
        more++
        return route.fulfill({ json: { data: [recent, older], cursor: {} } })
      }
      // Fifty newer foreground sessions can hide an old active delegation.
      return route.fulfill({ json: { data: [recent, ...Array.from({ length: 49 }, (_, n) => ({ id: `ses_human${n}`, title: "前台", time: { updated: 200 } }))], cursor: { next: "opaque +/cursor" } } })
    }
    const id = url.pathname.split("/")[3]
    if (id in reads) {
      if (url.pathname.endsWith("/message")) {
        reads[id]++
        if (id === "ses_running" && failDetail) return route.fulfill({ status: 503, json: {} })
        return route.fulfill({ json: { data: [{ id: "msg_idle", type: "idle", outcome: "succeeded" }] } })
      }
      if (url.pathname.endsWith("/inbox")) return route.fulfill({ json: { data: id === "ses_older" ? [{ id: "msg_parked" }] : [] } })
      return route.fulfill({ json: { data: running } })
    }
    return route.abort()
  })
  await page.goto("/background-fixture?ocw=background")
  const cards = page.locator(".ocw-task")
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText("首页外运行的任务")
  await expect(page.locator('.ocw-session[data-id="ses_running"]')).toHaveCount(1)
  await expect(page.locator('.ocw-task[data-id="ses_running"] .ocw-task-state')).toHaveText("运行中")
  const firstReads = reads.ses_running
  await expect.poll(() => reads.ses_running).toBeGreaterThan(firstReads)
  expect(reads.ses_recent).toBe(1)
  await page.locator("#ocw-monitor").getByRole("button", { name: "加载更多历史", exact: true }).click()
  await expect(cards).toHaveCount(3)
  expect(more).toBe(1)
  await expect(page.locator('.ocw-task[data-id="ses_older"] .ocw-task-state')).toHaveText("等待投递 · 1 条待处理")
  await expect(page.locator("#ocw-monitor").getByRole("button", { name: "加载更多历史", exact: true })).toHaveCount(0)
  expect(reads.ses_recent).toBe(1)

  failDetail = true
  await expect(page.locator('.ocw-task[data-id="ses_running"] .ocw-task-state')).toHaveText("状态待确认")
  failDetail = false
  active = false
  await expect(page.locator('.ocw-task[data-id="ses_running"] .ocw-task-state')).toHaveText("已完成")
  const finishedReads = reads.ses_running
  // The queued card remains uncached, letting us observe a subsequent poll.
  const queuedReads = reads.ses_older
  await expect.poll(() => reads.ses_older).toBeGreaterThan(queuedReads)
  expect(reads.ses_running).toBe(finishedReads)
  expect(reads.ses_recent).toBe(1)
  failActive = true
  await expect(page.locator("#ocw-monitor .ocw-panel-sub")).toContainText("读取失败，保留上次结果")
  await expect(cards).toHaveCount(3)
  expect(errors).toEqual([])
})

test("an empty first page still offers history pagination and a failed initial read is visible", async ({ page }) => {
  let fail = true
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/background-fixture") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><script>${scripts}</script>` })
    if (url.pathname === "/api/project") return route.fulfill({ json: [] })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session") return route.fulfill({ status: fail ? 500 : 200, json: { data: [], cursor: { next: "older" } } })
    return route.abort()
  })
  await page.goto("/background-fixture?ocw=background")
  await expect(page.locator("#ocw-monitor .ocw-panel-sub")).toContainText("读取失败")
  fail = false
  await expect(page.locator("#ocw-monitor").getByRole("button", { name: "加载更多历史", exact: true })).toBeVisible()
})
