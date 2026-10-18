import { createHash } from "node:crypto"

// This is an explicit compatibility allowlist, not a claim about future versions.
export const supportedHash = "a78015e20f722756818d02ac85641848a202e0afe2518bd51b09ac6db4280f66"

export function patchTimeline(code, { eagerLimit = 0 } = {}) {
  const hash = createHash("sha256").update(code).digest("hex")
  if (hash !== supportedHash) return { code, applied: false, reason: "unknown-sha256", hash }
  const assignments = [...code.matchAll(/([\w$]+)\.constructSessionMessageRows=([\w$]+);/g)]
  const signals = [...code.matchAll(/\[[\w$]+,[\w$]+\]=([\w$]+)\([\w$]+\.size<=[\w$]+\|\|![\w$]+\.deferred\([\w$]+\)\)/g)]
  if (assignments.length !== 1 || signals.length !== 1)
    return { code, applied: false, reason: "non-unique-structure", hash }
  const [match, namespace, original] = assignments[0]
  const replacement = `${namespace}.constructSessionMessageRows=globalThis.__ocwFold.wrap(${original},${namespace},${signals[0][1]});`
  let patched = code.replace(match, replacement)
  if (eagerLimit) {
    const ranges = [...code.matchAll(/:([\w$]+)\(\{\.\.\.([\w$]+),overscan:2\}\)/g)]
    if (ranges.length !== 1) return { code, applied: false, reason: "non-unique-range", hash }
    const [range, extractor, input] = ranges[0]
    patched = patched.replace(range, `:(${input}.count<=${eagerLimit}?Array.from({length:${input}.count},(_,index)=>index):${extractor}({...${input},overscan:2}))`)
  }
  return { code: patched, applied: true, reason: "known-build", hash, original: match, replacement, eagerLimit }
}
