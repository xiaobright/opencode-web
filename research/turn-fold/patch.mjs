import { createHash } from "node:crypto"
import { supportedHash } from "../runtime-fold/patch.mjs"

export function patch(code, mode = "grouped") {
  const hash = createHash("sha256").update(code).digest("hex")
  if (hash !== supportedHash) return { applied: false, code, reason: "unknown-build", hash }
  const assignment = [...code.matchAll(/([\w$]+)\.constructSessionMessageRows=([\w$]+);/g)]
  const signals = [...code.matchAll(/\[[\w$]+,[\w$]+\]=([\w$]+)\([\w$]+\.size<=[\w$]+\|\|![\w$]+\.deferred\([\w$]+\)\)/g)]
  if (assignment.length !== 1 || signals.length !== 1) throw new Error("Projection hook is not unique")
  let output = code.replace(assignment[0][0], `${assignment[0][1]}.constructSessionMessageRows=globalThis.__ocwGroup.wrap(${assignment[0][2]},${assignment[0][1]},${signals[0][1]});`)
  if (mode === "grouped") {
    // All identifiers below are verified against the exact allowlisted release, never guessed for other builds.
    const render = "r.renderRow(d,()=>{m(!0),_!==void 0&&cancelAnimationFrame(_),_=requestAnimationFrame(()=>{_=void 0,n()&&a.isConnected&&H.measureElement(a)})})"
    const estimate = "estimateSize:()=>Mg"
    for (const anchor of [render, estimate]) if (code.split(anchor).length !== 2) throw new Error("Layout hook is not unique")
    // Publish the expanded total before unpinning: native unpin is a no-op while a short transcript fits.
    output = output.replace(render, `globalThis.__ocwGroup.render(r.renderRow,d,()=>{m(!0),_!==void 0&&cancelAnimationFrame(_),_=requestAnimationFrame(()=>{_=void 0,n()&&a.isConnected&&H.measureElement(a)})},(partID,change)=>{xe();change();V&&(V.style.height=H.getTotalSize()+"px");e.onUnpin();A("anchor",{key:t.rowKey,partID});ye()})`)
    // ft is untrack from this build's store module; estimates must not subscribe layout effects.
    output = 'import{ft as __ocwUntrack}from"./store-CWFQZoRe.js";' + output.replace(estimate, "estimateSize:index=>__ocwUntrack(()=>j()[index]?.group?.ocw?40:Mg)")
    // Core skips caching a size equal to its estimate. The wrapper must use the SAME estimate,
    // otherwise a 40px summary is queued forever against the wrapper's hardcoded 60px fallback.
    const dedupe = "(H.itemSizeCache.get(a)??Mg)===r"
    if (output.split(dedupe).length !== 2) throw new Error("Measurement deduplication hook is not unique")
    output = output.replace(dedupe, "(H.itemSizeCache.get(a)??(i.group?.ocw?40:Mg))===r")
  }
  return { applied: true, code: output, reason: "known-build", hash }
}
