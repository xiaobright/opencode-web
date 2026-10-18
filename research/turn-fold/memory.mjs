import { execFile } from "node:child_process"
import { promisify } from "node:util"
const exec = promisify(execFile)
export async function browserMemory(browser) {
  if (process.platform !== "win32") return null
  const cdp = await browser.newBrowserCDPSession()
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo")
  await cdp.detach()
  const ids = processInfo.map((p) => Number(p.id)).filter(Number.isSafeInteger)
  const { stdout } = await exec("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", `$idsForBenchmark = @(${ids.join(",")}); @(Get-Process -Id $idsForBenchmark -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ id=$_.Id; working=$_.WorkingSet64; private=$_.PrivateMemorySize64 } }) | ConvertTo-Json -Compress`], { windowsHide: true })
  const entries = JSON.parse(stdout)
  const rendererIDs = new Set(processInfo.filter((p) => p.type === "renderer").map((p) => Number(p.id)))
  const sum = (values, key) => values.reduce((n, p) => n + p[key], 0) / 1048576
  return { processes: entries.length, rendererProcesses: entries.filter((p) => rendererIDs.has(p.id)).length, totalWorkingMiB: sum(entries, "working"), totalPrivateMiB: sum(entries, "private"), rendererWorkingMiB: sum(entries.filter((p) => rendererIDs.has(p.id)), "working"), rendererPrivateMiB: sum(entries.filter((p) => rendererIDs.has(p.id)), "private") }
}
