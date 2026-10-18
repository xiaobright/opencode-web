import { test, expect } from "../runtime-fold/deps.mjs"
import { timeline, processes } from "./fixtures"
const enabled = (process.env.OCW_GROUP_MODE ?? "grouped") === "grouped"
test("one process group starts, expands and collapses without measuring hidden content", async ({ page }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await timeline.setupTimeline(page, { sessionMessages: processes(1), viewport: { width: 1280, height: 760 }, reducedMotion: true })
  await expect(page.getByText("实验最终回答 0。", { exact: true })).toBeVisible()
  if (enabled) {
    const button = page.getByRole("button", { name: /用时.*10 次工具调用/ })
    await expect(button).toBeVisible()
    await expect(page.getByText(/^过程 0\/0：/)).toHaveCount(0)
    const initialY = (await button.boundingBox()).y
    await button.click()
    await expect(button).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByText(/^过程 0\/0：/)).toBeVisible()
    await expect.poll(async () => Math.abs((await button.boundingBox()).y - initialY)).toBeLessThanOrEqual(1)
    await button.click()
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByText(/^过程 0\/0：/)).toHaveCount(0)
    await expect(page.getByText("实验最终回答 0。", { exact: true })).toBeVisible()
  }
  expect(errors).toEqual([])
})

test("running process stays visible until the successful completion event", async ({ page }) => {
  const messages = processes(1)
  const completed = messages[1]
  messages[1] = { ...completed, time: { created: completed.time.created } }
  const run = await timeline.setupTimeline(page, { sessionMessages: messages, viewport: { width: 1280, height: 760 }, reducedMotion: true })
  await expect(page.getByText("实验最终回答 0。", { exact: true })).toBeVisible()
  await expect(page.locator("[data-ocw-toggle]")).toHaveCount(0)
  await run.send(timeline.messageUpdated(completed))
  await run.send(timeline.status("idle"))
  if (enabled) {
    await expect(page.locator("[data-ocw-toggle]")).toHaveCount(1)
    await expect(page.getByText(/^过程 0\/0：/)).toHaveCount(0)
    await expect(page.getByText("实验最终回答 0。", { exact: true })).toBeVisible()
  }
})
