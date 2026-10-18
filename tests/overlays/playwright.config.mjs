import { defineConfig } from "../../research/runtime-fold/deps.mjs"
import { fileURLToPath } from "node:url"
const directory = fileURLToPath(new URL(".", import.meta.url))
const run = process.env.OCW_OVERLAY_RUN ?? `overlays-${Date.now()}`
process.env.PLAYWRIGHT_SERVER_HOST = "127.0.0.1"
process.env.PLAYWRIGHT_SERVER_PORT = "53129"
process.env.OCW_TEST_PORT = "53129"
export default defineConfig({
  testDir: directory, testMatch: "*.spec.ts", workers: 1, retries: 0,
  timeout: 45000, expect: { timeout: 10000 },
  outputDir: `${directory}/test-results/${run}`,
  reporter: [["line"], ["json", { outputFile: `${directory}/test-results/${run}.json` }]],
  use: { baseURL: "http://127.0.0.1:53129", browserName: "chromium", serviceWorkers: "block", screenshot: "only-on-failure" },
  webServer: { command: "bun ../activity/server.mjs", cwd: directory, url: "http://127.0.0.1:53129/__test/status", reuseExistingServer: false },
})
