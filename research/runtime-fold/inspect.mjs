import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { discover, authorization } from "../../src/service.mjs"

const service = await discover()
if (!service) throw new Error("No running service; this experiment never starts one")
const headers = { authorization: authorization(service) }
const read = async (path) => {
  const response = await fetch(new URL(path, service.url), { headers, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Asset ${path}: HTTP ${response.status}`)
  return response.text()
}
const html = await read("/")
const entry = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)][0]?.[1]
if (!entry) throw new Error("No module entry")
const main = await read(entry)
const candidates = [...new Set([...main.matchAll(/["'`]((?:_assets\/|\.\/)route-[^"'`]+\.js)["'`]/g)].map((m) => "/_assets/" + m[1].split("/").at(-1)))]
const matches = []
for (const path of candidates) {
  const code = await read(path)
  if (!code.includes("constructSessionMessageRows")) continue
  matches.push({ path, code })
}
if (matches.length !== 1) throw new Error(`Expected one timeline module; got ${matches.length}`)
const { path, code } = matches[0]
const cache = new URL("./.cache/", import.meta.url)
await mkdir(cache, { recursive: true })
await writeFile(new URL("official.js", cache), code)
const manifest = { version: service.version, entry, asset: path, sha256: createHash("sha256").update(code).digest("hex"), bytes: Buffer.byteLength(code) }
await writeFile(new URL("manifest.json", cache), JSON.stringify(manifest, null, 2) + "\n")
console.log(JSON.stringify(manifest))
for (const marker of [".constructSessionMessageRows=", ".size<=", "shouldAdjustScrollPositionOnItemSizeChange="]) {
  const index = code.indexOf(marker)
  console.log(marker, index, code.slice(Math.max(0, index - 160), index + 400))
}
