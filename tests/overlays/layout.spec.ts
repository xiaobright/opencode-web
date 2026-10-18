import { test, expect, upstream } from "../../research/runtime-fold/deps.mjs"
import { pathToFileURL } from "node:url"
import { readFileSync } from "node:fs"
const timeline = await import(pathToFileURL(`${upstream}/packages/app/e2e/utils/timeline.ts`).href)
const { timelinePresets } = await import(pathToFileURL(`${upstream}/packages/session-ui/src/timeline/detail.ts`).href)
const imageData = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="1200" height="700" fill="#e5edf8"/><rect x="40" y="40" width="1120" height="620" rx="24" fill="#ffffff" stroke="#52698d" stroke-width="4"/><path d="M600 40v620M40 350h1120" stroke="#d6dfea" stroke-width="3"/><text x="600" y="320" text-anchor="middle" font-family="sans-serif" font-size="52" fill="#263d60">Image preview layout</text><text x="600" y="410" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#52698d">1200 x 700 synthetic fixture</text></svg>').toString("base64")
const baseline = process.env.OCW_OVERLAY_MODE === "baseline"

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    return ["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol) ? route.fallback() : route.abort()
  })
  if (baseline) {
    await page.route("**/styles/overlay-layout.css", (route) => route.fulfill({ contentType: "text/css", body: "" }))
    await page.route("**/styles/codex.css", async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, body: (await response.text()).replace("z-index: 40;", "z-index: 60;") })
    })
  }
})

async function setup(page, width = 1280, collapsed = false) {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript((collapsed) => localStorage.setItem("opencode-web.codex-shell.collapsed", collapsed ? "1" : "0"), collapsed)
  await timeline.setupTimeline(page, {
    viewport: { width, height: 760 }, locale: "zh", reducedMotion: true,
    settings: { timelineDetail: timelinePresets.find((preset) => preset.id === "everything").value },
    messages: [timeline.userMessage(), timeline.assistantMessage([
      timeline.toolPart("read-picture", "read", "completed", { path: "assets/preview.svg" }),
      timeline.textPart("final", "图片已读取。"),
    ])],
    fileContent: (path) => path.endsWith("preview.svg") ? { type: "binary", content: imageData, encoding: "base64", mimeType: "image/svg+xml" } : undefined,
  })
  await expect(page.locator("#ocw")).toBeVisible()
  return errors
}

async function centered(page, selector) {
  await expect.poll(async () => {
    const box = await page.locator(selector).boundingBox()
    const gutter = await page.locator("#ocw").evaluate((node) => node.getBoundingClientRect().right)
    return box ? Math.abs(box.x + box.width / 2 - (gutter + page.viewportSize().width) / 2) : Infinity
  }).toBeLessThan(1)
  const box = await page.locator(selector).boundingBox()
  const gutter = await page.locator("#ocw").evaluate((node) => node.getBoundingClientRect().right)
  expect(box.x).toBeGreaterThanOrEqual(gutter + 15)
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width - 15)
}

async function openImage(page) {
  const image = page.locator('[data-component="read-image"] img')
  if (!(await image.isVisible())) await page.getByRole("button", { name: /preview\.svg/ }).first().click()
  await expect(image).toHaveJSProperty("naturalWidth", 1200)
  await image.click()
  await expect(page.locator('[data-slot="image-preview-content"]')).toBeVisible()
}

test("reproduces full-window image centering and sidebar occlusion before the fix", async ({ page }, info) => {
  test.skip(!baseline)
  await setup(page)
  await openImage(page)
  const box = await page.locator('[data-slot="image-preview-content"]').boundingBox()
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(1)
  expect(box.x).toBeLessThan(312)
  // Kobalte disables pointer events outside its modal, so hit-testing cannot
  // detect a sidebar that still paints above it. Compare the stacking layers.
  const layers = await page.evaluate(() => ({
    sidebar: Number(getComputedStyle(document.querySelector("#ocw")).zIndex),
    dialog: Number(getComputedStyle(document.querySelector('[data-dialog-layer]')).zIndex),
  }))
  expect(layers.sidebar).toBeGreaterThan(layers.dialog)
  await page.screenshot({ path: info.outputPath("before.png") })
})

for (const [width, collapsed] of [[1280, false], [1280, true], [800, false], [520, false], [390, true]] as const) {
  test(`image preview fits the right area at ${width}px, sidebar ${collapsed ? "collapsed" : "expanded"}`, async ({ page }, info) => {
    test.skip(baseline)
    const errors = await setup(page, width, collapsed)
    await openImage(page)
    await centered(page, '[data-slot="image-preview-content"]')
    const close = page.locator('[data-slot="image-preview-close"]')
    await expect(close).toBeVisible()
    await expect(page.locator('[data-component="dialog-overlay"]')).toHaveCSS("left", "0px")
    const sidebarCovered = await page.evaluate(() => !!document.elementFromPoint(25, 400)?.closest('[data-component="dialog-overlay"]'))
    expect(sidebarCovered).toBe(true)
    if (width === 1280 && !collapsed) await page.screenshot({ path: info.outputPath("after.png") })
    await close.click()
    await expect(page.locator('[data-slot="image-preview-content"]')).toHaveCount(0)
    await expect(page.locator('[data-component="read-image"] img')).toBeFocused()
    await openImage(page)
    await page.keyboard.press("Escape")
    await expect(page.locator('[data-slot="image-preview-content"]')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test("open image preview follows window resizing and closes on backdrop click", async ({ page }) => {
  test.skip(baseline)
  const errors = await setup(page)
  await openImage(page)
  await page.setViewportSize({ width: 800, height: 760 })
  await centered(page, '[data-slot="image-preview-content"]')
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-slot="image-preview-content"]')).toHaveCount(0)
  await page.getByRole("button", { name: "折叠 / 展开侧栏", exact: true }).click()
  await openImage(page)
  await centered(page, '[data-slot="image-preview-content"]')
  await page.setViewportSize({ width: 390, height: 760 })
  await centered(page, '[data-slot="image-preview-content"]')
  await page.mouse.click(370, 700)
  await expect(page.locator('[data-slot="image-preview-content"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

// The saved release snapshot lacks the lazily loaded command/model dialog
// bundles. Exercise their real source styles and DOM contracts separately;
// this fixture verifies geometry only, not those components' runtime behavior.
for (const [width, collapsed] of [[1280, false], [800, false], [520, false], [390, true]] as const) {
  test(`shared dialog, palette, drawer and toast geometry at ${width}px`, async ({ page }) => {
    test.skip(baseline)
    const css = [
      "packages/ui/src/overlays/dialog/dialog.css",
      "packages/app/src/shell/commands/dialog.css",
      "packages/app/src/shell/mobile-drawer.css",
      "packages/ui/src/feedback/toast/toast.css",
    ].map((path) => readFileSync(`${upstream}/${path}`, "utf8")).join("\n") + "\n*, *::before, *::after { box-sizing: border-box; }"
    await page.route("**/__test/geometry", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style><link rel="stylesheet" href="/styles/codex.css"><link rel="stylesheet" href="/styles/overlay-layout.css"></head><body><div id="ocw"><div class="ocw-rail"></div><div class="ocw-sidebar"></div></div><div data-dialog-layer="0" style="position:fixed;inset:0;display:flex;justify-content:center;align-items:center;z-index:50"><div data-component="dialog-v2"><div data-slot="dialog-container"><div data-slot="dialog-content">Geometry fixture</div></div></div></div></body></html>` }))
    await page.setViewportSize({ width, height: 760 })
    await page.goto("/__test/geometry")
    await page.evaluate((collapsed) => {
      document.documentElement.toggleAttribute("data-ocw-collapsed", collapsed)
      document.documentElement.style.setProperty("--ocw-gutter", collapsed ? "52px" : "312px")
    }, collapsed)
    for (const size of ["normal", "large", "x-large", "palette", "custom"]) {
      await page.evaluate((size) => {
        document.querySelector('[data-component="dialog-v2"]').setAttribute("data-size", size)
        document.querySelector('[data-slot="dialog-content"]').classList.toggle("command-palette", size === "palette")
        const container = document.querySelector<HTMLElement>('[data-slot="dialog-container"]')
        container.style.width = size === "custom" ? "980px" : ""
      }, size)
      await centered(page, '[data-slot="dialog-container"]')
    }
    await expect(page.locator('[data-dialog-layer]')).toHaveCSS("left", collapsed ? "52px" : "312px")
    await page.evaluate(() => {
      document.querySelector('[data-dialog-layer]').remove()
      const drawer = document.createElement("div")
      drawer.setAttribute("data-slot", "mobile-drawer-content")
      drawer.textContent = "Drawer geometry"
      const toast = document.createElement("div")
      toast.className = "toast-v2-region"
      toast.style.cssText = `position:fixed;right:${innerWidth <= 600 ? 16 : 32}px;bottom:48px;width:320px`
      toast.innerHTML = '<div class="toast-v2">Toast geometry</div>'
      document.body.append(drawer, toast)
    })
    const gutter = collapsed ? 52 : 312
    const drawer = await page.locator('[data-slot="mobile-drawer-content"]').boundingBox()
    expect(drawer.x).toBe(gutter)
    expect(drawer.x + drawer.width).toBe(width)
    const toast = await page.locator(".toast-v2").boundingBox()
    expect(toast.x).toBeGreaterThanOrEqual(gutter + 15)
    expect(toast.x + toast.width).toBeLessThanOrEqual(width - 15)
  })
}
