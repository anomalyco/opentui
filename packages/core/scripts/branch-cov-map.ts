// Maps byte offsets in the JavaScript Bun runs back to the TypeScript source, by aligning tokens.
//
// Bun's transpiler does not expose its source map, but it keeps token order (it strips types,
// rewrites `true` to `!0`, hoists and reindents). So: tokenize both texts with the TypeScript
// parser, align the two token streams with a Myers diff, and map each JS token to its TS token.
// A JS offset maps to the TS start of the nearest aligned token at or before it.
import ts from "typescript"

export type Tok = { text: string; start: number }

export function tokenize(text: string, kind: ts.ScriptKind): Tok[] {
  const sf = ts.createSourceFile("x", text, ts.ScriptTarget.ESNext, false, kind)
  const out: Tok[] = []
  const walk = (node: ts.Node) => {
    const children = node.getChildren(sf)
    if (children.length === 0) {
      const start = node.getStart(sf)
      if (node.end > start) {
        const t = text.slice(start, node.end)
        if (t.trim()) out.push({ text: t, start })
      }
      return
    }
    for (const c of children) walk(c)
  }
  walk(sf)
  return out
}

const norm = (t: string) => (t === "!0" ? "true" : t === "!1" ? "false" : t)

// Myers O(ND) diff over normalized token text; returns matched (aIndex, bIndex) pairs.
function alignTokens(a: Tok[], b: Tok[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const an = a.map((t) => norm(t.text))
  const bn = b.map((t) => norm(t.text))
  const max = n + m
  const offset = max
  let v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  outer: for (let d = 0; d <= max; d++) {
    // Only the band [-d, d] of `v` is live at step d; store that slice.
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    const nv = new Int32Array(v)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && an[x] === bn[y]) {
        x++
        y++
      }
      nv[offset + k] = x
      if (x >= n && y >= m) {
        v = nv
        trace.push(v.slice(offset - d - 2, offset + d + 3))
        break outer
      }
    }
    v = nv
  }
  // Backtrack.
  const pairs: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]
    const base = d + 1 // trace[d] holds v[offset-d-1 .. offset+d+1]; index k maps to k + base
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vd[k - 1 + base] < vd[k + 1 + base])) prevK = k + 1
    else prevK = k - 1
    const prevX = vd[prevK + base]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      pairs.push([x, y])
    }
    x = prevX
    y = prevY
  }
  pairs.reverse()
  return pairs
}

export type OffsetMapper = (jsOffset: number) => number | null

/** Build a JS offset -> TS offset mapper for one source file. */
export function buildMapper(tsSource: string, jsSource: string): OffsetMapper {
  const a = tokenize(tsSource, ts.ScriptKind.TS)
  const b = tokenize(jsSource, ts.ScriptKind.JS)
  const pairs = alignTokens(a, b)
  const jsStarts = pairs.map(([, j]) => b[j].start)
  const tsStarts = pairs.map(([i]) => a[i].start)
  return (off) => {
    // nearest aligned JS token at or after `off` (the arm's first token), falling back to before
    let lo = 0
    let hi = jsStarts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (jsStarts[mid] < off) lo = mid + 1
      else hi = mid
    }
    if (lo < jsStarts.length && jsStarts[lo] - off <= 64) return tsStarts[lo]
    if (lo > 0) return tsStarts[lo - 1]
    return null
  }
}
