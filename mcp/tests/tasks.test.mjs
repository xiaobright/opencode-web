import { expect, test } from "bun:test"
import { readOutput, stateFromMessages } from "../tasks.mjs"

const assistant = (id, text) => ({ id, type: "assistant", content: [{ type: "text", text }] })

test("the latest persisted user message bounds the answer and excludes an old idle marker", () => {
  const history = [
    { id: "second-user", type: "user" },
    { id: "old-idle", type: "idle", outcome: "succeeded" },
    assistant("old-answer", "old answer"),
    { id: "first-user", type: "user" },
  ]
  expect(stateFromMessages(history)).toBe("running")
  expect(readOutput(history).text).toBe("")
  history.unshift(assistant("step", "step output"))
  history.unshift(assistant("answer", "new answer"))
  history.unshift({ id: "new-idle", type: "idle", outcome: "failed" })
  expect(stateFromMessages(history)).toBe("failed")
  expect(readOutput(history).text).toBe("step output\n\nnew answer")
  expect(readOutput(history, { cursor: "step" }).text).toBe("new answer")
})
