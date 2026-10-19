// Source baseline: OpenCode 654b79b (2026-10-15), Protocol groups/session + message.
// Route/shape checks establish API availability, not exactly-once tool side effects.
export const BASELINE = "654b79b"

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
  for (const [path, fields] of [["/api/session", ["id", "metadata", "location"]], ["/api/session/{sessionID}/prompt", ["id", "metadata", "delivery", "resume"]]]) {
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
