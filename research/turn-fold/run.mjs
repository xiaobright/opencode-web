import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { requireUpstream } from "../runtime-fold/deps.mjs"
const child = spawn(process.execPath, [requireUpstream.resolve("@playwright/test/cli"), "test", "--config", fileURLToPath(new URL("./playwright.config.mjs", import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true, env: process.env })
child.on("exit", (code) => process.exit(code ?? 1))
