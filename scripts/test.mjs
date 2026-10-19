#!/usr/bin/env node
// One entry point for every suite in this repository.
//
// The browser suites use fixed, separate ports (53128/53129/53130) and isolated state,
// so they can run at the same time as each other and as the unit suites. That turns the
// serial wall time (~110s) into roughly the slowest suite (~35s).

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = new Set(process.argv.slice(2))
const fast = args.has("--fast") || args.has("--no-browser")
const live = args.has("--live")
const verbose = args.has("--verbose") || args.has("-v")
const only = [...args].find((arg) => arg.startsWith("--only="))?.slice(7).split(",").map((item) => item.trim()).filter(Boolean)

const suites = [
  { name: "mcp", cwd: root, command: "bun", args: ["test", "mcp/tests"] },
  { name: "startup-unit", cwd: resolve(root, "tests/startup"), command: "bun", args: ["test", "./backend.test.mjs", "./cli.test.mjs", "./idle.test.mjs", "./models.test.mjs"] },
  { name: "activity-unit", cwd: resolve(root, "tests/activity"), command: "bun", args: ["test", "./background-data.test.mjs", "./model.test.mjs"] },
  { name: "tray-policy", cwd: resolve(root, "tests/startup"), command: "pwsh", args: ["-NoProfile", "-File", "tray-policy.ps1"], platform: "win32" },
  { name: "startup-browser", cwd: resolve(root, "tests/startup"), command: "node", args: ["run.mjs"], browser: true },
  { name: "overlays-browser", cwd: resolve(root, "tests/overlays"), command: "node", args: ["run.mjs"], browser: true },
  { name: "activity-browser", cwd: resolve(root, "tests/activity"), command: "node", args: ["run.mjs"], browser: true },
]

function selected(suite) {
  if (suite.browser && fast) return false
  if (suite.platform && process.platform !== suite.platform) return false
  if (only) return only.includes(suite.name)
  return true
}

function run(suite) {
  return new Promise((done) => {
    const started = performance.now()
    const child = spawn(suite.command, suite.args, { cwd: suite.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const collect = (chunk) => {
      output += chunk.toString("utf8")
      if (verbose) process.stdout.write(`[${suite.name}] ${chunk}`)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.on("error", (error) => done({ suite, ok: false, ms: performance.now() - started, output: `${output}\n${error.message}` }))
    child.on("close", (code) => done({ suite, ok: code === 0, ms: performance.now() - started, output, code }))
  })
}

function summaryLine(result) {
  const seconds = (result.ms / 1000).toFixed(1).padStart(5)
  const name = result.suite.name.padEnd(17)
  if (result.ok) {
    const passed = /(\d+) pass/.exec(result.output)?.[1]
    const skipped = /(\d+) skipped/.exec(result.output)?.[1]
    return `  ok   ${name} ${seconds}s${passed ? `  ${passed} passed` : ""}${skipped ? `  ${skipped} skipped` : ""}`
  }
  return `  FAIL ${name} ${seconds}s${result.code === undefined ? "" : `  exit ${result.code}`}`
}

const queue = suites.filter(selected)
if (!queue.length) {
  console.error("No suites selected.")
  process.exit(2)
}

console.log(`Running ${queue.length} suite(s) in parallel${fast ? " (fast: browser suites skipped)" : ""}\n`)
const started = performance.now()
const results = await Promise.all(queue.map(run))
results.sort((left, right) => left.ms - right.ms)

let failed = 0
for (const result of results) {
  console.log(summaryLine(result))
  if (!result.ok) failed++
}

if (live) {
  // Real free-model acceptance: opt-in, serial, and last, because it uses the real service.
  console.log("\nRunning live acceptance against the real service...")
  const result = await run({ name: "live", cwd: root, command: "node", args: ["mcp/live-smoke.mjs", "--run"] })
  console.log(summaryLine(result))
  if (!result.ok) {
    failed++
    console.log(result.output.split("\n").slice(-25).join("\n"))
  }
}

const total = ((performance.now() - started) / 1000).toFixed(1)
if (failed) {
  console.log(`\n${failed} suite(s) failed in ${total}s. Output of the first failure:\n`)
  const first = results.find((result) => !result.ok)
  console.log(first.output.split("\n").slice(-40).join("\n"))
  process.exit(1)
}
console.log(`\nAll ${results.length} suite(s) passed in ${total}s.`)
