import { test, expect, upstream } from "../../research/runtime-fold/deps.mjs"
import { pathToFileURL } from "node:url"
import { readFileSync } from "node:fs"
const timeline = await import(pathToFileURL(`${upstream}/packages/app/e2e/utils/timeline.ts`).href)
const { timelinePresets } = await import(pathToFileURL(`${upstream}/packages/session-ui/src/timeline/detail.ts`).href)
const enabled = process.env.OCW_ACTIVITY_MODE !== "baseline"
const quiet = timelinePresets.find((preset) => preset.id === "quiet").value
const footer = (page) => page.locator('[data-component="session-working"] .ocw-activity-label')

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    return ["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol) ? route.fallback() : route.abort()
  })
})

test("loading baseline: same 1393-message release UI with or without activity overlay", async ({ page }, info) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  const messages = JSON.parse(readFileSync(new URL("../../research/turn-fold/.cache/hy3.json", import.meta.url), "utf8")).messages
  const started = performance.now()
  const run = await timeline.setupTimeline(page, { sessionMessages: messages, viewport: { width: 1280, height: 760 }, locale: "zh", reducedMotion: true })
  await expect(page.locator("#ocw-sidebar")).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-timeline-key]")].filter((row) => Math.abs(Number.parseFloat(row.style.height) - (row.firstElementChild as HTMLElement).offsetHeight) > 1).length)).toBe(0)
  const readyMs = performance.now() - started
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.collectGarbage")
  const heap = await cdp.send("Runtime.getHeapUsage")
  const metrics = { enabled, readyMs, heapMiB: heap.usedSize / 1048576, connections: (await run.transport.connections()).length, errors }
  await info.attach("loading", { body: JSON.stringify(metrics), contentType: "application/json" })
  console.log("ACTIVITY_LOADING", JSON.stringify(metrics))
  expect(metrics.connections).toBe(1)
  expect(errors).toEqual([])
})

test("existing footer follows explicit thinking, command and completion events without changing row height", async ({ page }, info) => {
  test.skip(!enabled)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  const message = timeline.assistantMessage([], { completed: false })
  const run = await timeline.setupTimeline(page, { sessionMessages: [timeline.userMessage(), message], settings: { timelineDetail: quiet }, locale: "zh", viewport: { width: 1280, height: 760 } })
  await expect(footer(page)).toHaveText("等待模型输出")
  const initialHeight = (await page.locator('[data-component="session-working"]').boundingBox()).height
  const ids = { sessionID: timeline.sessionID, assistantMessageID: message.id }
  await run.send(timeline.event("session.reasoning.started", { ...ids, ordinal: 0 }))
  await expect(footer(page)).toHaveText("思考中")
  await run.send(timeline.event("session.reasoning.ended", { ...ids, ordinal: 0, text: "思考内容" }))
  await run.send(timeline.event("session.tool.input.started", { ...ids, id: "command-one", name: "bash" }))
  await expect(footer(page)).toHaveText("准备工具调用")
  await run.send(timeline.event("session.tool.input.ended", { ...ids, id: "command-one", text: '{"command":"echo test"}' }))
  await run.send(timeline.event("session.tool.called", { ...ids, id: "command-one", input: { command: "echo test" }, executed: false }))
  await expect(footer(page)).toHaveText("执行命令中")
  expect((await page.locator('[data-component="session-working"]').boundingBox()).height).toBe(initialHeight)
  await page.screenshot({ path: info.outputPath("command-status.png") })
  await run.send(timeline.event("session.tool.success", { ...ids, id: "command-one", content: [{ type: "text", text: "test" }], executed: false }))
  await expect(footer(page)).toHaveText("等待模型输出")
  await run.send(timeline.event("session.text.started", { ...ids, ordinal: 0 }))
  await expect(footer(page)).toHaveText("生成回答中")
  await run.send(timeline.event("session.text.delta", { ...ids, ordinal: 0, delta: "状态测试回答" }))
  await expect(page.getByText("状态测试回答", { exact: true })).toBeVisible()
  await run.send(timeline.messageUpdated({ ...message, time: { ...message.time, completed: message.time.created + 5000 } }))
  await run.send(timeline.status("idle"))
  await expect(page.locator('[data-component="session-working"]')).toHaveCount(0)
  expect((await run.transport.connections()).length).toBe(1)
  expect(errors).toEqual([])
})

test("initial message snapshot restores an already running tool without a second API request", async ({ page }) => {
  test.skip(!enabled)
  let pages = 0
  const message = timeline.assistantMessage([timeline.toolPart("read-one", "read", "running", { filePath: "example.ts" })], { completed: false })
  await timeline.setupTimeline(page, { sessionMessages: [timeline.userMessage(), message], onMessages: ({ phase }) => { if (phase === "start") pages++ }, settings: { timelineDetail: quiet }, locale: "zh" })
  await expect(footer(page)).toHaveText("读取文件中")
  expect(pages).toBe(1)
})

test("split UTF-8 SSE frames reach both the native UI and status observer; connection loss clears the old phase", async ({ page }) => {
  test.skip(!enabled)
  const message = timeline.assistantMessage([], { completed: false })
  const run = await timeline.setupTimeline(page, { sessionMessages: [timeline.userMessage(), message], settings: { timelineDetail: quiet }, locale: "zh", eventRetry: 60000 })
  const ids = { sessionID: timeline.sessionID, assistantMessageID: message.id }
  const event = timeline.event("session.reasoning.started", { ...ids, ordinal: 0 })
  await run.transport.split(event, [1, 7, 23, 51])
  await expect(footer(page)).toHaveText("思考中")
  await run.send(timeline.event("session.text.started", { ...ids, ordinal: 0 }))
  const delta = timeline.event("session.text.delta", { ...ids, ordinal: 0, delta: "分片中文内容" })
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(delta)}\n\n`)
  const chinese = bytes.findIndex((byte) => byte > 127)
  await run.transport.split(delta, [1, chinese + 1, chinese + 2, bytes.length - 1])
  await expect(page.getByText("分片中文内容", { exact: true })).toBeVisible()
  await run.send(timeline.event("session.text.ended", { ...ids, ordinal: 0, text: "分片中文内容" }))
  await run.send(timeline.event("session.step.streamed", ids))
  await expect(footer(page)).toHaveText("处理中")
  await run.transport.disconnect()
  await expect(footer(page)).toHaveText("状态连接已断开")
})
