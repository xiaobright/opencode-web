import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { upstream } from "../runtime-fold/deps.mjs"
export const timeline = await import(pathToFileURL(`${upstream}/packages/app/e2e/utils/timeline.ts`).href)
export function history() { return JSON.parse(readFileSync(new URL("./.cache/hy3.json", import.meta.url), "utf8")).messages }
export function processes(count = 100) {
  const { userMessage, userText, assistantMessage, textPart, toolPart } = timeline
  return Array.from({ length: count }, (_, index) => {
    const id = `msg_${String(index).padStart(4, "0")}_user`
    const created = 1690000000000 + index * 60000
    const steps = Array.from({ length: 10 }, (_, step) => [
      textPart(`p_${index}_${step}`, `过程 ${index}/${step}：检查文件与结果。${"这部分是可折叠的中途说明。".repeat(14)}`),
      toolPart(`t_${index}_${step}`, "read", "completed", { filePath: `src/example-${step}.ts` }, { output: "export const example = 1\n".repeat(150) }),
    ]).flat()
    return [userMessage([userText(`实验问题 ${index}`)], { id, created }), assistantMessage([...steps, textPart(`final_${index}`, `实验最终回答 ${index}。\n\n${"这段最终回答应该始终显示。".repeat(12 + index % 6)}`)], { id: `msg_${String(index).padStart(4, "0")}_assistant`, parentID: id, created: created + 1000 })]
  }).flat()
}
