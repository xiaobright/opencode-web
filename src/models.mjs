// Which free model a delegation runs on is an operator decision, not a caller one.
// The order lives in one JSON file that both the web UI (which edits it) and the MCP
// server (which reads it) use, so "the first row in the page" is literally the model
// the next delegation picks.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))

/** <state dir>/model-ranking.json; OPENCODE_WEB_STATE_DIR overrides the .state folder. */
export function rankingPath(env = process.env) {
  return join(env.OPENCODE_WEB_STATE_DIR || join(repoRoot, ".state"), "model-ranking.json")
}

export function normalizeModel(model) {
  const cost = Array.isArray(model.cost) ? model.cost : []
  return {
    id: model.modelID ?? model.id,
    providerID: model.providerID,
    name: model.name ?? model.modelID ?? model.id,
    context: model.limit?.context ?? null,
    tools: Boolean(model.capabilities?.tools),
    free: cost.length > 0 && cost.every((entry) => (entry.input ?? 0) === 0 && (entry.output ?? 0) === 0),
    status: model.status ?? "unknown",
    enabled: model.enabled !== false,
  }
}

/** The models a delegation may use: free, enabled, tool-capable. */
export function usableModels(models) {
  return models.filter((model) => model.free && model.enabled && model.tools)
}

export const modelRef = (model) => `${model.providerID}/${model.id}`

// Until the operator saves an order, prefer the model that has been the default all along.
// The UI receives the same effective order, so its first row matches what a delegation uses.
export const DEFAULT_MODEL_REF = "opencode/deepseek-v4.1-flash-free"

function order(ranking) {
  return ranking.length > 0 ? ranking : [DEFAULT_MODEL_REF]
}

/** Ranking first (in the operator's order), then anything the ranking has not seen. */
export function rankModels(models, ranking = []) {
  const preferred = order(ranking)
  const rank = new Map(preferred.map((ref, index) => [ref, index]))
  return [...models].sort((left, right) => {
    const a = rank.has(modelRef(left)) ? rank.get(modelRef(left)) : preferred.length
    const b = rank.has(modelRef(right)) ? rank.get(modelRef(right)) : preferred.length
    return a - b
  })
}

/**
 * The model a delegation uses: an explicit operator pin wins, otherwise the first ranked
 * usable model, otherwise the first usable one in catalog order. Undefined means the
 * catalog has nothing free to offer.
 */
export function selectModel(models, ranking = [], pin = "") {
  const usable = usableModels(models)
  if (pin) {
    const text = String(pin)
    const bare = text.includes("/") ? undefined : text
    const pinned = usable.find((model) => modelRef(model) === text || (bare && model.id === bare))
    if (pinned) return pinned
  }
  for (const ref of order(ranking)) {
    const hit = usable.find((model) => modelRef(model) === ref)
    if (hit) return hit
  }
  return usable[0]
}

export function readRanking(path = rankingPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return Array.isArray(parsed?.ranking) ? parsed.ranking.filter((ref) => typeof ref === "string") : []
  } catch {
    return []
  }
}

export function writeRanking(ranking, path = rankingPath()) {
  const clean = [...new Set(ranking.filter((ref) => typeof ref === "string" && ref.length > 0))]
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ ranking: clean }, null, 2))
  renameSync(temp, path)
  return clean
}
