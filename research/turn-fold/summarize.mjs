import { readFile, writeFile } from "node:fs/promises"
const runs = process.argv.slice(2)
if (!runs.length) throw new Error("Pass completed run names, without .json")
const results = []
function specs(suite) { return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specs)] }
const total = (values, field) => values.reduce((sum, item) => sum + (item[field] ?? 0), 0)
const max = (values) => Math.max(0, ...values)
const round = (n) => Math.round(n * 100) / 100
for (const run of runs) {
  const document = JSON.parse(await readFile(new URL(`./test-results/${run}.json`, import.meta.url)))
  const cases = []
  for (const spec of document.suites.flatMap(specs)) {
    for (const test of spec.tests) for (const result of test.results) {
      if (result.status !== "passed") throw new Error(`Incomplete acceptance: ${run}/${spec.title}/${result.status}`)
      for (const attachment of result.attachments ?? []) {
        if (attachment.name !== "benchmark") continue
        const raw = attachment.body ? Buffer.from(attachment.body, "base64").toString("utf8") : await readFile(attachment.path, "utf8")
        const data = JSON.parse(raw)
        cases.push({
          case: data.case, mode: data.mode, readyMs: round(data.initialMs), loadAllMs: data.loadAllMs === undefined ? undefined : round(data.loadAllMs),
          pages: data.pages?.length, firstMessages: data.initial.projection.messages, messages: data.final.projection.messages,
          originalRows: data.final.projection.before, rows: data.final.projection.after, groups: data.final.projection.turns.length,
          initial: { heapMiB: round(data.initial.heapMiB), mountedRows: data.initial.mountedRows, domElements: data.initial.nodes, browser: data.initial.browser },
          final: { heapAfterGCMiB: round(data.final.heapMiB), mountedRows: data.final.mountedRows, domElements: data.final.nodes, browser: data.final.browser },
          projection: { calls: data.final.calls.length, nativeTotalMs: round(total(data.final.calls, "nativeMs")), groupTotalMs: round(total(data.final.calls, "groupMs")), groupMaxMs: round(max(data.final.calls.map((c) => c.groupMs))), initialGroupMs: round(total(data.initial.calls, "groupMs")) },
          browserWork: { taskMs: round(data.final.taskMs), scriptMs: round(data.final.scriptMs), layoutMs: round(data.final.layoutMs), longTasks: data.final.longTasks.length, maxLongTaskMs: max(data.final.longTasks.map((t) => t.ms)), maxFrameGapMs: round(max(data.final.frameGaps)) },
          wheel: data.scroll && { maxExtraDisplacementPx: data.scroll.maxDrift, samples: data.scroll.samples, operations: data.scroll.observations.length, nonzeroSamples: data.scroll.observations.flatMap((s) => s.drift).filter((s) => Math.abs(s.px) > 1).length },
          interaction: data.interaction && { cycles: data.interaction.cycles, beforeGCMiB: round(data.interaction.before.heapMiB), afterGCMiB: round(data.interaction.after.heapMiB), deltaGCMiB: round(data.interaction.after.heapMiB - data.interaction.before.heapMiB), maxHeaderDisplacementPx: max(data.interaction.cycles.flatMap((c) => [Math.abs(c.expandedDrift ?? 0), Math.abs(c.collapsedDrift ?? 0)])) },
          errors: data.errors,
        })
      }
    }
  }
  results.push({ run, durationMs: document.stats.duration, passed: document.stats.expected, cases })
}
const capture = JSON.parse(await readFile(new URL("./.cache/capture.json", import.meta.url)))
const evidence = { capturedSession: capture, generatedAt: new Date().toISOString(), runs: results }
await writeFile(new URL("./evidence.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n")
for (const result of results) for (const row of result.cases) console.log(JSON.stringify({ run: result.run, ...row }))
