import assert from "node:assert/strict"

// Browser regression for the native overview and embedded-terminal diagrams.
// After navigation and font loading in Playwriter, call this with
// await getCDPSession({ page: state.page }). The caller owns the browser page.
export async function checkProseLayout(cdp) {
  const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", {
    computedStyles: ["overflow-x", "overflow-y"],
    includeDOMRects: true,
  })
  const failures = []
  let figures = 0
  let rows = 0

  for (const { nodes, layout } of snapshot.documents) {
    const text = (index) => snapshot.strings[index] ?? ""
    const positions = new Map(layout.nodeIndex.map((node, index) => [node, index]))
    const attribute = (node, name) => {
      const attributes = nodes.attributes[node] ?? []
      for (let index = 0; index < attributes.length; index += 2) {
        if (text(attributes[index]) === name) return text(attributes[index + 1])
      }
    }
    const inside = (node, parent) => {
      for (; node >= 0; node = nodes.parentIndex[node]) {
        if (node === parent) return true
      }
      return false
    }

    for (const [node, name] of nodes.nodeName.entries()) {
      if (text(name) !== "FIGURE" || !attribute(node, "class")?.split(/\s+/).includes("box-figure")) continue
      figures++
      const figure = positions.get(node)
      if (layout.offsetRects[figure][2] !== layout.clientRects[figure][2]) {
        failures.push(`Figure ${figures} has a vertical scrollbar`)
      }

      for (const [pre, name] of nodes.nodeName.entries()) {
        if (text(name) !== "PRE" || !inside(pre, node)) continue
        const position = positions.get(pre)
        if (layout.styles[position].some((value) => text(value) !== "visible")) {
          failures.push(`Figure ${figures} has an inner code scrollport`)
        }
        if (layout.offsetRects[position][2] !== layout.clientRects[position][2]) {
          failures.push(`Figure ${figures}'s pre has a vertical scrollbar`)
        }
        if (!attribute(pre, "data-code")) continue

        // These authored diagrams use one cell per code point, including arrows.
        // Generated terminal frames can contain wide text and have their own cell widths.
        const lines = layout.text.flatMap((value, index) => {
          const line = text(value)
          return line.trim() && inside(layout.nodeIndex[index], pre)
            ? [{ text: line, width: layout.bounds[index][2] }]
            : []
        })
        assert.ok(lines.length, "The diagram must contain rendered text")
        const cellWidth = lines[0].width / [...lines[0].text].length
        for (const line of lines) {
          rows++
          if (Math.abs(line.width - [...line.text].length * cellWidth) > 0.25) {
            failures.push(`Figure ${figures} has a non-cell-width glyph: ${line.text}`)
          }
        }
      }
    }
  }

  assert.ok(figures > 0 && rows > 0, "Load a documentation page with text diagrams before checking layout")
  assert.deepEqual(failures, [], failures.join("\n"))
  return { figures, rows }
}
