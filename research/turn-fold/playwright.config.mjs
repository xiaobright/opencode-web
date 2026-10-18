import { defineConfig } from "../runtime-fold/deps.mjs"
import { fileURLToPath } from "node:url"
const directory = fileURLToPath(new URL(".", import.meta.url))
const mode = process.env.OCW_GROUP_MODE ?? "grouped"
const port = process.env.OCW_GROUP_PORT ?? "53127"
const run = process.env.OCW_GROUP_RUN ?? `${mode}-${Date.now()}`
process.env.PLAYWRIGHT_SERVER_HOST = "127.0.0.1"
process.env.PLAYWRIGHT_SERVER_PORT = port
export default defineConfig({
  testDir: directory, testMatch: "*.spec.ts", outputDir: `${directory}/test-results/${run}`,
  workers: 1, retries: 0, timeout: 240000, expect: { timeout: 30000 },
  reporter: [["line"], ["json", { outputFile: `${directory}/test-results/${run}.json` }]],
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: "chromium", serviceWorkers: "block", trace: "off", screenshot: "only-on-failure" },
  webServer: { command: "bun server.mjs", cwd: directory, url: `http://127.0.0.1:${port}/__research/status`, reuseExistingServer: false, timeout: 30000, env: { OCW_GROUP_MODE: mode, OCW_GROUP_PORT: port } },
})
