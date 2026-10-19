// Source baseline: OpenCode 654b79b (2026-10-15), Protocol groups/session + message.
// Route/shape checks establish API availability, not exactly-once tool side effects.
export const BASELINE = "654b79b"

/** Cache successful capability probes per service identity; concurrent callers share one read. */
export function contractCache(load, { now = Date.now, ttlMs = 600_000 } = {}) {
  const entries = new Map()
  return async (target, { force = false } = {}) => {
    const key = JSON.stringify([target.url, target.authorization, target.version, target.pid])
    const previous = entries.get(key)
    if (previous?.pending) return previous.pending
    if (!force && previous && now() - previous.at < ttlMs) return previous.value
    const entry = {}
    entry.pending = Promise.resolve().then(() => load(target)).then(inspectContract)
    entries.set(key, entry)
    while (entries.size > 4) entries.delete(entries.keys().next().value)
    try {
      entry.value = await entry.pending
      entry.at = now()
      return entry.value
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key)
      throw error
    } finally {
      delete entry.pending
    }
  }
}

function dereference(document, schema) {
  const seen = new Set()
  while (schema?.$ref?.startsWith("#/")) {
    if (seen.has(schema.$ref)) return undefined
    seen.add(schema.$ref)
    schema = schema.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], document)
  }
  return schema
}

function properties(document, schema) {
  const value = dereference(document, schema)
  return Object.assign({}, value?.properties, ...(value?.allOf ?? []).map((part) => properties(document, part)))
}

export function inspectContract(document) {
  const paths = document?.paths ?? {}
  const missing = []
  const requireRoute = (path, method) => {
    const operation = paths[path]?.[method]
    if (!operation) missing.push(`${method.toUpperCase()} ${path}`)
    return operation
  }
  for (const [path, method] of [
    ["/api/session/{sessionID}", "get"],
    ["/api/session/active", "get"],
    ["/api/session/{sessionID}/inbox", "get"],
    ["/api/session/{sessionID}/message", "get"],
    ["/api/session/{sessionID}/interrupt", "post"],
    ["/api/experimental/session/{sessionID}/wait", "post"],
    ["/api/model", "get"],
  ]) requireRoute(path, method)
  // Session ids are service-minted (caller-supplied ones failed free-model acceptance); the input
  // id is ours, which is what makes a retried prompt idempotent.
  for (const [path, fields] of [["/api/session", ["metadata", "location"]], ["/api/session/{sessionID}/prompt", ["id", "metadata", "delivery", "resume"]]]) {
    const operation = requireRoute(path, "post")
    const body = dereference(document, operation?.requestBody)
    const fieldsPresent = properties(document, body?.content?.["application/json"]?.schema)
    for (const field of fields) if (!(field in fieldsPresent)) missing.push(`${path} payload.${field}`)
  }
  const messages = paths["/api/session/{sessionID}/message"]?.get
  const query = (messages?.parameters ?? []).map((param) => dereference(document, param)).filter((param) => param?.in === "query")
  for (const field of ["cursor", "type", "order"])
    if (!query.some((param) => param.name === field)) missing.push(`messages query.${field}`)
  if (missing.length) throw new Error(`Unsupported OpenCode API (baseline ${BASELINE}); missing: ${missing.join(", ")}. Update OpenCode to a compatible build.`)
  return {
    baseline: BASELINE,
    version: document.info?.version ?? "unknown",
    instructions: Boolean(paths["/api/experimental/session/{sessionID}/instructions/entries/{key}"]?.put),
  }
}
