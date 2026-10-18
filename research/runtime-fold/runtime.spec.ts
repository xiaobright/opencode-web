import { test, expect, upstream } from "./deps.mjs"
import { pathToFileURL } from "node:url"
const { setupTimeline, userMessage, assistantMessage, textPart, toolPart, userText } = await import(pathToFileURL(`${upstream}/packages/app/e2e/utils/timeline.ts`).href)
const mode = process.env.OCW_RESEARCH_MODE ?? "patched"
const enabled = ["patched", "eager"].includes(mode)

function messages(count = 1, busy = false) {
  return Array.from({ length: count }, (_, index) => {
    const id = `msg_${String(index).padStart(4, "0")}_research_user`
    return [
      userMessage([userText(`研究问题 ${index}`, { id: `prt_user_${index}` })], { id, created: 1690000000000 + index * 10000 }),
      assistantMessage([
        textPart(`prt_process_${index}`, `过程说明 ${index}：先检查项目文件。`),
        toolPart(`prt_tool_${index}`, "read", "completed", { filePath: "src/example.ts" }, { output: "export const example = 1" }),
        textPart(`prt_final_${index}`, `最终回答 ${index}。\n\n${"这是已经完成的历史消息，用于检查折叠和滚动。".repeat(8)}`),
      ], { id: `msg_${String(index).padStart(4, "0")}_research_assistant`, parentID: id, completed: !(busy && index === count - 1), created: 1690000001000 + index * 10000 }),
    ]
  }).flat()
}

test("completed history: process content is restored by reactive expansion", async ({ page }, info) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await setupTimeline(page, { messages: messages(), locale: "zh", viewport: { width: 1280, height: 850 } })
  await expect(page.getByText("最终回答 0。", { exact: false })).toBeVisible()
  if (!enabled) {
    await expect(page.getByText("过程说明 0：先检查项目文件。", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "展开全部过程" })).toHaveCount(0)
  } else {
    await expect(page.getByText("过程说明 0：先检查项目文件。", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "展开全部过程" })).toBeVisible()
    const collapsed = await page.evaluate(() => globalThis.__ocwFold.stats)
    expect(collapsed.before - collapsed.after).toBe(2)
    await page.screenshot({ path: info.outputPath("collapsed.png") })
    await page.getByRole("button", { name: "展开全部过程" }).click()
    await expect(page.getByText("过程说明 0：先检查项目文件。", { exact: true })).toBeVisible()
    await expect(page.locator('[data-component="collapsed-tool-group"]')).toBeVisible()
    await page.getByRole("button", { name: "收起全部过程" }).click()
    await expect(page.getByText("过程说明 0：先检查项目文件。", { exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "切换所选轮次" }).click()
    await expect(page.getByText("过程说明 0：先检查项目文件。", { exact: true })).toBeVisible()
    await info.attach("projection", { body: JSON.stringify(collapsed, null, 2), contentType: "application/json" })
  }
  expect(errors).toEqual([])
})

test("active turn remains unfolded", async ({ page }) => {
  await setupTimeline(page, { messages: messages(1, true), locale: "zh", viewport: { width: 1280, height: 850 } })
  await expect(page.getByText("过程说明 0：先检查项目文件。", { exact: true })).toBeVisible()
  await expect(page.getByText("最终回答 0。", { exact: false })).toBeVisible()
  if (enabled) await expect.poll(() => page.evaluate(() => globalThis.__ocwFold.stats.turns.length)).toBe(0)
})

test("long history: wheel displacement and visible row drift", async ({ page }, info) => {
  const started = Date.now()
  await setupTimeline(page, { messages: messages(60), locale: "zh", viewport: { width: 1280, height: 700 }, reducedMotion: true })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(4000)
  await expect(page.getByText("最终回答 59。", { exact: false })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  if (mode === "eager") {
    await expect.poll(() => page.evaluate(() => document.querySelectorAll("[data-timeline-key]").length)).toBe(179)
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-timeline-key]")].filter((row) => Math.abs(Number.parseFloat(row.style.height) - (row.firstElementChild as HTMLElement).offsetHeight) > 1).length)).toBe(0)
  }
  const devtools = await page.context().newCDPSession(page)
  await devtools.send("Performance.enable")
  const metrics = Object.fromEntries((await devtools.send("Performance.getMetrics")).metrics.filter((metric) => ["JSHeapUsedSize", "Nodes", "LayoutCount", "RecalcStyleCount"].includes(metric.name)).map((metric) => [metric.name, metric.value]))
  const initial = { setupMs: Date.now() - started, mountedRows: await page.locator("[data-timeline-key]").count(), domNodes: await page.locator("*").count(), ...metrics }
  const sample = () => scroller.evaluate((element) => {
    const view = element.getBoundingClientRect()
    return { scrollTop: element.scrollTop, height: element.scrollHeight, view: { top: view.top, bottom: view.bottom }, rows: Object.fromEntries([...element.querySelectorAll<HTMLElement>("[data-timeline-key]")].map((row) => { const r = row.getBoundingClientRect(); return [row.dataset.timelineKey, { top: r.top, bottom: r.bottom }] })) }
  })
  // An explicit settled scroll operation, not a fixed sleep. Geometry is measured after scrollend.
  const wheel = async (delta) => {
    await scroller.evaluate((element) => { globalThis.__researchScrollEnded = false; element.addEventListener("scrollend", () => { globalThis.__researchScrollEnded = true }, { once: true }) })
    const box = await scroller.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, delta)
    await expect.poll(() => page.evaluate(() => globalThis.__researchScrollEnded)).toBe(true)
  }
  await wheel(-1800)
  const observations = []
  for (let index = 0; index < 10; index++) {
    const before = await sample()
    await wheel(-320)
    const after = await sample()
    const drift = Object.entries(after.rows).filter(([key]) => before.rows[key] && before.rows[key].bottom > before.view.top && before.rows[key].top < before.view.bottom && after.rows[key].bottom > after.view.top && after.rows[key].top < after.view.bottom).map(([key, row]) => ({ key, px: Math.round((row.top - before.rows[key].top - 320) * 10) / 10 }))
    observations.push({ step: index + 1, scrollDelta: before.scrollTop - after.scrollTop, heightDelta: after.height - before.height, drift })
  }
  expect(observations.every((step) => step.scrollDelta > 0)).toBe(true)
  const result = { mode, initial, maxAbsDrift: Math.max(0, ...observations.flatMap((step) => step.drift.map((row) => Math.abs(row.px)))), samples: observations.reduce((n, step) => n + step.drift.length, 0), observations }
  await info.attach("wheel-observations", { body: JSON.stringify(result, null, 2), contentType: "application/json" })
  console.log("WHEEL_RESULT", JSON.stringify(result))
})

test("eager rendering falls back to virtualization above its row limit", async ({ page }) => {
  test.skip(mode !== "eager")
  await setupTimeline(page, { messages: messages(120), viewport: { width: 1280, height: 700 } })
  await expect(page.getByText("最终回答 119。", { exact: false })).toBeVisible()
  await expect.poll(() => page.evaluate(() => globalThis.__ocwFold.stats.after)).toBe(359)
  expect(await page.locator("[data-timeline-key]").count()).toBeLessThan(300)
})
