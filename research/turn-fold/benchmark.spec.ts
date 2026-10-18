import { test, expect } from "../runtime-fold/deps.mjs"
import { timeline, history, processes } from "./fixtures"
import { browserMemory } from "./memory.mjs"
const mode = process.env.OCW_GROUP_MODE ?? "grouped"

async function prepare(page) {
  const errors = []
  page.on("pageerror", (error) => { errors.push(error.message); console.log("PAGE_ERROR", error.message.slice(0, 240)) })
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    return ["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol) ? route.fallback() : route.abort()
  })
  await page.addInitScript(() => {
    globalThis.__perf = { longTasks: [], frameGaps: [], last: 0 }
    new PerformanceObserver((list) => { for (const item of list.getEntries()) globalThis.__perf.longTasks.push({ start: item.startTime, ms: item.duration }) }).observe({ type: "longtask", buffered: true })
    // rAF here measures frames; it is never a readiness gate.
    const frame = (time) => { if (globalThis.__perf.last && time - globalThis.__perf.last > 50) globalThis.__perf.frameGaps.push(time - globalThis.__perf.last); globalThis.__perf.last = time; requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  return { errors, cdp }
}
async function metrics(page, cdp, collect = false) {
  if (collect) await cdp.send("HeapProfiler.collectGarbage")
  const raw = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]))
  const dom = await cdp.send("Memory.getDOMCounters")
  const view = await page.evaluate(() => ({ nodes: document.querySelectorAll("*").length, mountedRows: document.querySelectorAll("[data-timeline-key]").length, projection: globalThis.__ocwGroup?.stats, calls: globalThis.__ocwGroup?.calls, longTasks: globalThis.__perf.longTasks, frameGaps: globalThis.__perf.frameGaps }))
  return { heapMiB: raw.JSHeapUsedSize / 1048576, heapCapacityMiB: raw.JSHeapTotalSize / 1048576, layoutMs: raw.LayoutDuration * 1000, scriptMs: raw.ScriptDuration * 1000, taskMs: raw.TaskDuration * 1000, dom, browser: await browserMemory(page.context().browser()), ...view }
}
function scroller(page) { return page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-key]") }) }
async function settle(page) {
  await page.evaluate(() => document.fonts.ready)
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-timeline-key]")].filter((row) => Math.abs(Number.parseFloat(row.style.height) - (row.firstElementChild as HTMLElement).offsetHeight) > 1).length)).toBe(0)
}
async function wheel(page, delta) {
  const scroll = scroller(page)
  await scroll.evaluate((el) => {
    // A delayed scrollend from the previous input must not finish this sample.
    const state = globalThis.__wheelSample = { input: false, scrolled: false, ended: false }
    el.addEventListener("wheel", () => { state.input = true }, { once: true, capture: true })
    const onScroll = () => { if (state.input) state.scrolled = true }
    const onEnd = () => {
      if (!state.input || !state.scrolled) return
      state.ended = true
      el.removeEventListener("scroll", onScroll)
      el.removeEventListener("scrollend", onEnd)
    }
    el.addEventListener("scroll", onScroll)
    el.addEventListener("scrollend", onEnd)
  })
  const box = await scroll.boundingBox()
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6)
  await page.mouse.wheel(0, delta)
  await expect.poll(() => page.evaluate(() => globalThis.__wheelSample.ended)).toBe(true)
}
async function sample(page) {
  return scroller(page).evaluate((el) => {
    const view = el.getBoundingClientRect()
    return { top: el.scrollTop, height: el.scrollHeight, view: { top: view.top, bottom: view.bottom }, rows: Object.fromEntries([...el.querySelectorAll<HTMLElement>("[data-timeline-key]")].map((r) => { const b = r.getBoundingClientRect(); return [r.dataset.timelineKey, { top: b.top, bottom: b.bottom }] })) }
  })
}
async function scrollBenchmark(page) {
  await wheel(page, -1800)
  const observations = []
  for (let step = 0; step < 18; step++) {
    const before = await sample(page)
    if (before.top < 600) break
    await wheel(page, -240)
    const after = await sample(page)
    const drift = Object.entries(after.rows).filter(([key, r]: any) => before.rows[key] && before.rows[key].bottom > before.view.top && before.rows[key].top < before.view.bottom && r.bottom > after.view.top && r.top < after.view.bottom).map(([key, r]: any) => ({ key, px: r.top - before.rows[key].top - 240 }))
    observations.push({ step, scrollDelta: before.top - after.top, heightDelta: after.height - before.height, drift })
  }
  const samples = observations.flatMap((s) => s.drift)
  expect(samples.length).toBeGreaterThan(0)
  return { maxDrift: Math.max(...samples.map((s) => Math.abs(s.px))), samples: samples.length, observations }
}
async function report(info, data) {
  await info.attach("benchmark", { body: JSON.stringify(data, null, 2), contentType: "application/json" })
  console.log("BENCHMARK", JSON.stringify({ case: data.case, mode, initialMs: data.initialMs, loadAllMs: data.loadAllMs, firstHeapMiB: data.initial.heapMiB, finalHeapMiB: data.final.heapMiB, messages: data.final.projection.messages, rows: data.final.projection.after, maxDrift: data.scroll?.maxDrift, errors: data.errors }))
}

for (const dataset of ["hy3-full", "process-full"]) test(`${dataset}: initial load, scrolling, retained memory`, async ({ page }, info) => {
  const { errors, cdp } = await prepare(page)
  const messages = dataset === "hy3-full" ? history() : processes(100)
  const started = performance.now()
  await timeline.setupTimeline(page, { sessionMessages: messages, viewport: { width: 1280, height: 760 }, reducedMotion: true, locale: "zh" })
  await expect.poll(() => page.evaluate(() => globalThis.__ocwGroup?.stats.messages)).toBe(messages.length)
  await settle(page)
  const initialMs = performance.now() - started
  const initial = await metrics(page, cdp)
  const scroll = await scrollBenchmark(page)
  let interaction
  if (mode === "grouped" && dataset === "process-full") {
    const visible = page.locator("button[data-ocw-toggle]:visible")
    // Select an actually visible summary, not an offscreen overscan row.
    const id = await visible.evaluateAll((buttons) => buttons.find((b) => { const r = b.getBoundingClientRect(); return r.top > 100 && r.bottom < innerHeight - 120 })?.getAttribute("data-ocw-toggle"))
    expect(id).toBeTruthy()
    const button = page.locator(`button[data-ocw-toggle="${id}"]`)
    const before = await metrics(page, cdp, true)
    const cycles = []
    for (let i = 0; i < 8; i++) {
      const positionBefore = (await button.boundingBox()).y
      const start = performance.now()
      await button.click()
      await expect(button).toHaveAttribute("aria-expanded", "true")
      await expect(page.getByText(new RegExp(`^过程 ${Number(id.split("_")[1])}/0：`))).toBeAttached()
      await settle(page)
      const expandedMs = performance.now() - start
      const expandedDrift = (await button.boundingBox()).y - positionBefore
      if (i === 0) await page.screenshot({ path: info.outputPath("expanded-process.png") })
      const closeStart = performance.now()
      await button.click()
      await expect(button).toHaveAttribute("aria-expanded", "false")
      await settle(page)
      cycles.push({ expandedMs, collapsedMs: performance.now() - closeStart, expandedDrift, collapsedDrift: (await button.boundingBox()).y - positionBefore })
    }
    interaction = { before, after: await metrics(page, cdp, true), cycles }
    await page.screenshot({ path: info.outputPath("grouped-process.png") })
  }
  const final = await metrics(page, cdp, true)
  const data = { case: dataset, mode, initialMs, initial, scroll, interaction, final, errors }
  await report(info, data)
  expect(errors).toEqual([])
})

test("hy3-paged: native history pagination to oldest message", async ({ page }, info) => {
  const { errors, cdp } = await prepare(page)
  const messages = history()
  const index = new Map(messages.map((m, i) => [m.id, i]))
  const pages = []
  let loaded = 0
  const started = performance.now()
  await timeline.setupTimeline(page, { sessionMessages: messages, viewport: { width: 1280, height: 760 }, reducedMotion: true, locale: "zh", pageMessages: (_id, limit, before) => {
    const end = before ? index.get(before) : messages.length
    const start = Math.max(0, end - limit)
    loaded = Math.max(loaded, messages.length - start)
    pages.push({ limit, start, end, loaded, ms: performance.now() - started })
    return { items: messages.slice(start, end), cursor: start > 0 ? messages[start].id : undefined }
  } })
  await settle(page)
  const initialMs = performance.now() - started
  const initial = await metrics(page, cdp)
  const loadStart = performance.now()
  while (loaded < messages.length) {
    const prior = loaded
    await scroller(page).hover()
    await page.mouse.wheel(0, -100000)
    await expect.poll(() => loaded).toBeGreaterThan(prior)
    await expect.poll(() => page.evaluate(() => globalThis.__ocwGroup.stats.messages)).toBeGreaterThanOrEqual(loaded)
  }
  await settle(page)
  const loadAllMs = performance.now() - loadStart
  const final = await metrics(page, cdp, true)
  await report(info, { case: "hy3-paged", mode, initialMs, loadAllMs, pages, initial, final, errors })
  expect(final.projection.messages).toBe(messages.length)
  expect(errors).toEqual([])
})
