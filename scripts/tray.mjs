// Launches the tray icon, hidden. Prefers PowerShell 7 and falls back to Windows PowerShell, which is
// always present; OPENCODE_WEB_SHELL points it at any other shell.
//
//   bun run tray                  start the icon (and with it the web UI)
//   bun run tray -- --no-browser  do not open the browser

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const shell = process.env.OPENCODE_WEB_SHELL ?? Bun.which("pwsh") ?? "powershell.exe"

// PowerShell binds `--no-browser` to $args, not to -NoBrowser, and says nothing about it, so a kebab-case
// flag would silently do nothing. Turn it into the parameter name the script declares.
const args = process.argv.slice(2).map((arg) => (arg.startsWith("--") ? "-" + arg.slice(2).replaceAll("-", "") : arg))

spawn(
  shell,
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "tray", "tray.ps1"), ...args],
  { stdio: "ignore", windowsHide: true },
).unref()
