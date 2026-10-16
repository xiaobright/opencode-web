// Installs (or removes) the opencode plugin that spawns the tray icon when the service is first used.
//
//   bun run install-hook
//   bun run uninstall-hook
//
// The plugin lands in the global plugin directory, which is per user and shared by every opencode
// client, so the icon follows the one shared background service.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const configDirectory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
const target = join(configDirectory, "plugin", "opencode-web-tray.js")

if (process.argv.includes("--uninstall")) {
  rmSync(target, { force: true })
  console.log(`removed ${target}`)
} else {
  const source = readFileSync(join(root, "hook", "opencode-web-tray.js"), "utf8").replaceAll(
    "__OPENCODE_WEB_ROOT__",
    JSON.stringify(root),
  )
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, source)
  console.log(`installed ${target}`)
  console.log("the icon now appears when the opencode service is first used, and exits with it")
}
