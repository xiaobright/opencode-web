// opencode plugin that keeps the opencode-web tray icon in step with the background service.
//
// The plugin API has no server lifecycle hook, but `setup` runs when the service builds the service
// graph for a directory, which is exactly when a client (TUI, desktop, web) starts using it. So the
// icon is spawned from the first real use of the service and then looks after itself: it polls the
// service and exits on its own once the service is gone.
//
// __OPENCODE_WEB_ROOT__ is filled in by `bun run install-hook`, which copies this file into the global
// plugin directory. Install with `bun run install-hook`, remove with `bun run uninstall-hook`.

import { spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"

const ROOT = __OPENCODE_WEB_ROOT__
const TRAY = join(ROOT, "tray", "tray.ps1")
const PID_FILE = join(ROOT, ".tray.pid")
const LOG = join(tmpdir(), "opencode-web-hook.log")

export default Plugin.define({
  id: "opencode.web-tray",
  setup: async () => {
    if (process.platform !== "win32") return
    if (!existsSync(TRAY)) return note(`no tray script at ${TRAY}`)
    if (running()) return

    // Not detached: a DETACHED_PROCESS PowerShell exits before it can create the icon. The tray
    // outlives this process anyway, and exits on its own once the service is gone.
    const shell = process.env.OPENCODE_WEB_SHELL ?? (typeof Bun === "undefined" ? undefined : Bun.which("pwsh")) ?? "powershell.exe"
    const tray = spawn(
      shell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", TRAY, "-NoBrowser"],
      { stdio: "ignore", windowsHide: true },
    )
    tray.unref()
    note(`spawned the tray (pid ${tray.pid}) with ${shell}`)
  },
})

// The tray holds a mutex as well; this only avoids starting a shell per directory for nothing.
function running() {
  if (!existsSync(PID_FILE)) return false
  const pid = Number(readFileSync(PID_FILE, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A hidden process that fails silently is impossible to debug, so leave a small trail.
function note(message) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}
