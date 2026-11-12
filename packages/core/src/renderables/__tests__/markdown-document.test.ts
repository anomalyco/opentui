import { afterEach, beforeEach, expect, test } from "bun:test"
import { ResourceContext } from "../../buffer.js"
import { NativeError, type NativeMarkdownOptions } from "../../zig.js"
import { MarkdownDocument } from "../markdown-document.js"

let resources: ResourceContext
beforeEach(() => {
  resources = new ResourceContext({ objectCapacity: 64, renderCellsMax: 256 })
})
afterEach(() => resources.destroy())

const create = (options: NativeMarkdownOptions) => new MarkdownDocument(resources.renderLib, resources.context, options)

// Seeded model: a host that learns blocks only from the change reports holds the engine's blocks, and its content is
// the engine's source, after every call: appends, replaces, the end of the stream and a new one, option changes and
// rejected calls (a document whose source limit the call passes). MODEL_SEED=<s> replays one seed; MODEL_SEEDS=<n>.
test("the host's blocks and content equal a fresh document's after every call", () => {
  const pieces = ["- ", "> ", "```\n", "| a | b |\n", "|--|--|\n", "[x]", "[x]: /u\n", "**", "`", "$", "$$\n"]
  pieces.push("10. ", "===\n", "\t", "\r\n", "\n", "\n\n", "word ", "ses_a ", "# ", "~~", "<a>\n", "- [x] ")
  const seeds = process.env.MODEL_SEED
    ? [Number(process.env.MODEL_SEED)]
    : Array.from({ length: Number(process.env.MODEL_SEEDS ?? 64) }, (_, i) => i + 1)
  let rejected = 0
  for (const seed of seeds) {
    let state = seed * 2654435761
    const random = () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) / 4294967296
    }
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    const options = (): NativeMarkdownOptions => ({
      flags: Math.floor(random() * 16),
      syntaxStyle: null,
      hookFilter: random() < 0.5 ? ["ses_"] : undefined,
      sourceByteLimit: 400,
    })
    let current = options()
    const doc = create(current)
    let streaming = true
    // Whether the document should be finished: what the last accepted write asked for.
    let finished = false
    const trace: string[] = []
    for (let step = 0; step < 40; step++) {
      const roll = random()
      let content = doc.content
      if (roll < 0.6) content += pick(pieces)
      else if (roll < 0.68) content = content.trimEnd()
      else if (roll < 0.72) content = pick(pieces) + content
      else if (roll < 0.74) content += "x".repeat(400)
      else if (roll < 0.84) streaming = !streaming
      // A replayed seed traces whole contents.
      const shown = process.env.MODEL_SEED ? content : content.slice(-12)
      trace.push(`${roll < 0.84 ? JSON.stringify(shown) : `streaming ${streaming}`}`)
      try {
        if (roll < 0.92) {
          doc.write(content, streaming)
          finished = !streaming
        } else {
          current = options()
          trace.push(`options ${current.flags}`)
          doc.setOptions(current)
        }
      } catch (error) {
        // Only the source limit rejects these calls.
        if (!(error instanceof NativeError)) throw error
        trace.push("rejected")
        rejected++
      }
      const fresh = create(current)
      fresh.write(doc.source(), !finished)
      const failure = `seed ${seed} after ${trace.join(" | ")}`
      expect(doc.finished, failure).toBe(finished)
      expect(doc.content, failure).toBe(doc.source())
      expect(doc.blocks, failure).toEqual(fresh.blocks)
      expect(doc.committed, failure).toBe(fresh.committed)
      fresh.destroy()
    }
    doc.destroy()
  }
  if (!process.env.MODEL_SEED) expect(rejected).toBeGreaterThan(0)
})
