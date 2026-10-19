import { expect, test } from "bun:test"

import { currentTool, isSilent, parsePlan, parseProgress, parseTodos, renderProgress } from "../progress.mjs"

const assistant = (text, { id = "msg_1", created = Date.now(), tool } = {}) => ({
  id,
  type: "assistant",
  time: { created },
  content: [...(text ? [{ type: "text", text }] : []), ...(tool ? [tool] : [])],
})

test("plan and progress lines are parsed from the newest assistant text", () => {
  const messages = [
    assistant("earlier noise", { id: "m3", created: 300 }),
    assistant("progress: 2/3 改完了 -> 跑测试", { id: "m2", created: 200 }),
    assistant("plan: 1) 读代码 2) 改代码 3) 跑测试", { id: "m1", created: 100 }),
  ]
  expect(parsePlan(messages)).toEqual(["读代码", "改代码", "跑测试"])
  expect(parseProgress(messages)).toEqual({ line: "2/3 改完了 -> 跑测试", done: 2, total: 3 })

  // Chinese label works too.
  expect(parseProgress([assistant("进度: 1/2 开始")])?.line).toBe("1/2 开始")
})

test("a todowrite part wins over the text plan, for builds that still have the tool", () => {
  const todo = {
    type: "tool",
    name: "todowrite",
    state: { status: "completed", input: { todos: [
      { content: "读代码", status: "completed" },
      { content: "改代码", status: "in_progress" },
      { content: "跑测试", status: "pending" },
    ] } },
  }
  expect(parseTodos([assistant("", { tool: todo })])).toEqual([
    { text: "读代码", status: "completed" },
    { text: "改代码", status: "in_progress" },
    { text: "跑测试", status: "pending" },
  ])
})

test("the running tool is summarized, and only while the session is running", () => {
  const tool = { type: "tool", name: "shell", state: { status: "running", input: { command: "npm test" } }, time: { created: 42 } }
  const messages = [assistant("working", { tool })]
  expect(currentTool(messages)).toEqual({ name: "shell", status: "running", summary: "npm test", since: 42 })

  const rendered = renderProgress({ messages, files: { count: 2, additions: 31, deletions: 4, names: "a.js, b.js" }, state: "running" })
  expect(rendered).toContain('Now: shell "npm test" (running)')
  expect(rendered).toContain("Files: 2 changed +31 −4 (a.js, b.js)")

  // A finished session must not claim work is in flight.
  const done = renderProgress({ messages, files: undefined, state: "done" })
  expect(done).not.toContain("Now:")
})

test("silence is measured from the newest assistant message", () => {
  const now = 1_000_000
  expect(isSilent({ messages: [], now, thresholdMs: 60_000 })).toBe(true)
  expect(isSilent({ messages: [assistant("hi", { created: now - 90_000 })], now, thresholdMs: 60_000 })).toBe(true)
  expect(isSilent({ messages: [assistant("hi", { created: now - 10_000 })], now, thresholdMs: 60_000 })).toBe(false)
})
