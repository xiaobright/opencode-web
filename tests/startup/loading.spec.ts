import { test, expect } from "../../research/runtime-fold/deps.mjs"

test.beforeEach(async ({ request }) => { await request.get("/__test/reset") })

test("cold opening paints OpenCode before backend readiness, shares activation and preserves deep links", async ({ page, request }, info) => {
  expect((await (await request.get("/__opencode-web")).json()).mode).toBe("lazy")
  expect((await (await request.get("/__test/state")).json()).calls).toBe(0)
  await page.goto("/server/test/session/example?view=review#anchor")
  await expect(page.getByRole("heading", { name: "opencode", exact: true })).toBeVisible()
  await expect(page.getByRole("status")).toHaveText("正在加载…")
  await expect.poll(async () => (await (await request.get("/__test/state")).json()).calls).toBe(1)
  await page.screenshot({ path: info.outputPath("loading.png") })
  const second = await page.context().newPage()
  await second.goto("/")
  await expect(second.getByRole("status")).toHaveText("正在加载…")
  expect((await (await request.get("/__test/state")).json()).calls).toBe(1)
  await request.get("/__test/release")
  await expect(page.getByRole("heading", { name: "Official OpenCode fixture" })).toBeVisible()
  await expect(page.locator("#route")).toHaveText("/server/test/session/example?view=review#anchor")
  await expect(second.getByRole("heading", { name: "Official OpenCode fixture" })).toBeVisible()
  await second.close()
})

test("failed startup stays on the loading page and retry can succeed", async ({ page, request }) => {
  await page.goto("/")
  await expect.poll(async () => (await (await request.get("/__test/state")).json()).calls).toBe(1)
  await request.get("/__test/fail")
  await expect(page.getByRole("status")).toHaveText("OpenCode 启动失败")
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect.poll(async () => (await (await request.get("/__test/state")).json()).calls).toBe(2)
  await request.get("/__test/release")
  await expect(page.getByRole("heading", { name: "Official OpenCode fixture" })).toBeVisible()
})
