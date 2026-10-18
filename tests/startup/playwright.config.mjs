import { defineConfig } from "../../research/runtime-fold/deps.mjs"
import { fileURLToPath } from "node:url"
const directory = fileURLToPath(new URL(".", import.meta.url))
export default defineConfig({
  testDir: directory, testMatch: "*.spec.ts", workers: 1, retries: 0, timeout: 30000,
  outputDir: `${directory}/test-results`, reporter: "line",
  use: { baseURL: "http://127.0.0.1:53130", browserName: "chromium", serviceWorkers: "block", screenshot: "only-on-failure" },
  webServer: { command: "bun server.mjs", cwd: directory, url: "http://127.0.0.1:53130/__test/state", reuseExistingServer: false },
})
