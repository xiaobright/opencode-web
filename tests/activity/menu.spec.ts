import { test, expect } from "../../research/runtime-fold/deps.mjs"
import { readFileSync } from "node:fs"

const scripts = ["background-data.js", "codex-shell.js"].map((name) => readFileSync(new URL(`../../webui/scripts/${name}`, import.meta.url), "utf8")).join("\n")
const css = readFileSync(new URL("../../webui/styles/codex.css", import.meta.url), "utf8")

const alpha = { id: "p1", canonical: "E:\\alpha" }
const beta = { id: "p2", canonical: "E:\\beta", name: "Beta 工作区" }
const probe = { id: "ses_a", title: "原始标题", projectID: "p1", time: { updated: 100 }, location: { directory: "E:\\alpha" } }
const keep = { id: "ses_keep", title: "保留的会话", projectID: "p1", time: { updated: 90 }, location: { directory: "E:\\alpha" } }

test("session and workspace menus rename, move, delete and hide", async ({ page }) => {
  const calls = []
  let list = [probe, keep]
  page.on("dialog", (dialog) => void dialog.accept())

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : null
    if (url.pathname === "/menu-fixture") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><script>${scripts}</script>` })
    }
    if (url.pathname === "/api/project" && method === "GET") return route.fulfill({ json: [alpha, beta] })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session" && method === "GET") return route.fulfill({ json: { data: list, cursor: {} } })
    if (url.pathname === "/api/session/ses_a" && method === "PATCH") {
      calls.push(["rename", body])
      list = [{ ...probe, title: body.title }, keep]
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/api/session/ses_a/move" && method === "POST") {
      calls.push(["move", body])
      list = [{ ...probe, title: "已移动", projectID: "p2", location: { directory: "E:\\beta" } }, keep]
      return route.fulfill({ json: {} })
    }
    if (url.pathname === "/api/session/ses_a" && method === "DELETE") {
      calls.push(["delete"])
      list = [keep]
      return route.fulfill({ status: 204, body: "" })
    }
    if (url.pathname.endsWith("/message") || url.pathname.endsWith("/inbox")) return route.fulfill({ json: { data: [] } })
    return route.abort()
  })

  await page.goto("/menu-fixture")
  const row = () => page.locator('.ocw-session-wrap[data-session-id="ses_a"]')
  await expect(row()).toHaveCount(1)

  // 重命名：行内输入框，Enter 保存，标题立刻更新（不等下一次整表刷新）
  await row().hover()
  await row().locator(".ocw-row-menu").click()
  await page.getByRole("menuitem", { name: "重命名" }).click()
  const input = page.locator(".ocw-rename")
  await expect(input).toBeVisible()
  await input.fill("改过的标题")
  await input.press("Enter")
  await expect.poll(() => calls.filter((call) => call[0] === "rename").length).toBe(1)
  expect(calls[0][1]).toEqual({ title: "改过的标题" })
  await expect(row()).toContainText("改过的标题")

  // 移动：只列当前确实有会话的其他工作区
  await row().hover()
  await row().locator(".ocw-row-menu").click()
  await page.getByRole("menuitem", { name: "移动到工作区…" }).click()
  await expect(page.getByRole("menuitem", { name: "Beta 工作区" })).toBeVisible()
  await page.getByRole("menuitem", { name: "Beta 工作区" }).click()
  await expect.poll(() => calls.filter((call) => call[0] === "move").length).toBe(1)
  expect(calls.find((call) => call[0] === "move")[1]).toEqual({ directory: "E:\\beta" })
  await expect(page.locator('.ocw-group[data-group-id="p2"]')).toContainText("已移动")

  // 删除：确认框走完才发 DELETE，行随即消失
  await row().hover()
  await row().locator(".ocw-row-menu").click()
  await page.getByRole("menuitem", { name: "删除会话" }).click()
  await expect.poll(() => calls.filter((call) => call[0] === "delete").length).toBe(1)
  await expect(row()).toHaveCount(0)

  // 隐藏工作区：从列表消失，底部出现恢复入口
  const group = page.locator('.ocw-group[data-group-id="p1"]')
  await expect(group).toHaveCount(1)
  await group.locator(".ocw-group-row").hover()
  await group.locator(".ocw-group-menu").click()
  await page.getByRole("menuitem", { name: "隐藏工作区" }).click()
  await expect(page.locator('.ocw-group[data-group-id="p1"]')).toHaveCount(0)
  const restore = page.locator(".ocw-unhide")
  await expect(restore).toHaveText("显示 1 个已隐藏的工作区")
  await restore.click()
  await expect(page.locator('.ocw-group[data-group-id="p1"]')).toHaveCount(1)
})
