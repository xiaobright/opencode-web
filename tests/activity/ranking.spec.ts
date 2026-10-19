import { test, expect } from "../../research/runtime-fold/deps.mjs"
import { readFileSync } from "node:fs"

const shell = readFileSync(new URL("../../webui/scripts/codex-shell.js", import.meta.url), "utf8")
const css = readFileSync(new URL("../../webui/styles/codex.css", import.meta.url), "utf8")
const catalog = ["Alpha", "Beta", "Gamma"].map((name) => ({ id: name, name, providerID: "opencode", context: 128000 }))

for (const firstFails of [false, true]) {
  test(`ranking saves stay ordered while clicking, reopening and refreshing (first fails: ${firstFails})`, async ({ page }) => {
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    let stored = catalog.map((model) => `opencode/${model.id}`)
    let releaseFirst
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let posts = 0
    let gets = 0
    let activePosts = 0
    let maxActivePosts = 0
    await page.route("**/*", async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname === "/__opencode-web/models") {
        if (request.method() === "POST") {
          const index = ++posts
          activePosts++
          maxActivePosts = Math.max(maxActivePosts, activePosts)
          if (index === 1) await firstGate
          const failed = index === 1 && firstFails
          if (!failed) stored = request.postDataJSON().ranking
          activePosts--
          return route.fulfill({ status: failed ? 500 : 200, json: { ok: !failed } })
        }
        gets++
        return route.fulfill({ json: { available: true, models: stored.map((ref) => catalog.find((model) => `opencode/${model.id}` === ref)) } })
      }
      if (url.pathname === "/api/project") return route.fulfill({ json: [] })
      if (url.pathname.startsWith("/api/session")) return route.fulfill({ json: { data: url.pathname.endsWith("/active") ? {} : [] } })
      if (url.pathname === "/ranking-fixture")
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><script>${shell}</script>` })
      return route.abort()
    })
    try {
      await page.goto("/ranking-fixture?ocw=models")
      const names = page.locator(".ocw-model-name")
      await expect(names).toHaveText(["Alpha", "Beta", "Gamma"])
      const up = (name) => page.locator(".ocw-model").filter({ has: page.getByText(name, { exact: true }) }).getByRole("button", { name: "上移", exact: true })
      await up("Gamma").click()
      await expect.poll(() => posts).toBe(1)
      await up("Gamma").click()
      await expect(names).toHaveText(["Gamma", "Alpha", "Beta"])
      await expect(page.locator(".ocw-panel-status")).toHaveText("正在保存…")
      await page.getByRole("button", { name: "刷新模型列表", exact: true }).click()
      await page.locator("[data-models-close]").click()
      await page.getByRole("button", { name: "模型顺序", exact: true }).click()
      await expect(names).toHaveText(["Gamma", "Alpha", "Beta"])
      expect(gets).toBe(1)
      expect(posts).toBe(1)
      releaseFirst()
      await expect(page.locator(".ocw-panel-status")).toHaveText("已保存 · 下一次委派生效")
      expect(posts).toBe(2)
      expect(maxActivePosts).toBe(1)
      expect(stored).toEqual(["opencode/Gamma", "opencode/Alpha", "opencode/Beta"])
      await page.getByRole("button", { name: "刷新模型列表", exact: true }).click()
      await expect.poll(() => gets).toBe(2)
      await expect(names).toHaveText(["Gamma", "Alpha", "Beta"])
      expect(errors).toEqual([])
    } finally {
      releaseFirst()
    }
  })
}
