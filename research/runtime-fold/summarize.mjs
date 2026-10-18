import { readFile, writeFile } from "node:fs/promises"
const names = process.argv.slice(2)
const runs = []
for (const name of names) {
  const report = JSON.parse(await readFile(new URL(`./test-results/${name}.json`, import.meta.url), "utf8"))
  const tests = report.suites.flatMap((suite) => suite.specs.flatMap((spec) => spec.tests.flatMap((test) => test.results.map((result) => ({ title: spec.title, status: result.status, durationMs: result.duration, stdout: result.stdout })))))
  const measurements = tests.flatMap((test) => test.stdout.flatMap((item) => {
    const text = item.text ?? (item.buffer ? Buffer.from(item.buffer, "base64").toString("utf8") : "")
    const position = text.indexOf("WHEEL_RESULT ")
    return position < 0 ? [] : [JSON.parse(text.slice(position + 13).trim())]
  }))
  runs.push({ name, stats: report.stats, tests: tests.map(({ stdout, ...test }) => test), measurements })
}
const manifest = JSON.parse(await readFile(new URL("./.cache/manifest.json", import.meta.url), "utf8"))
const evidence = { manifest, runs }
await writeFile(new URL("./evidence.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n")
console.log(JSON.stringify(runs.map((run) => ({ name: run.name, tests: run.tests.map((test) => [test.title, test.status]), measurements: run.measurements.map(({ observations, ...summary }) => summary) })), null, 2))
