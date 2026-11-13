// Shared parts of the Code model tests: a fake grammar and its render, a worker whose replies a test releases in any
// order, a seeded generator, failure reporting and a command-list shrinker.
import { TreeSitterClient } from "../../lib/tree-sitter/client.js"
import type { SimpleHighlight } from "../../lib/tree-sitter/types.js"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------------------------------------------
// Fake grammar. "hide" conceals every line that starts with '#' (with its newline) and every '*', and colors 'x'.
// "plain" answers no highlights. The block's painted text under "hide" therefore differs from its source, and its
// height drops by one row per '#' line, which is what the culled-height and blank-frame bugs are about.

export type Filetype = "hide" | "plain" | undefined

export function grammar(content: string, filetype: string): SimpleHighlight[] {
  if (filetype !== "hide") return []
  const out: SimpleHighlight[] = []
  let start = 0
  while (start <= content.length) {
    const nl = content.indexOf("\n", start)
    const end = nl === -1 ? content.length : nl
    if (content[start] === "#") out.push([start, end, "conceal", { conceal: "", concealLines: "" }])
    else
      for (let i = start; i < end; i++) {
        if (content[i] === "*") out.push([i, i + 1, "conceal", { conceal: "" }])
        else if (content[i] === "x") out.push([i, i + 1, "keyword"])
      }
    if (nl === -1) break
    start = nl + 1
  }
  return out
}

// What the block should paint for a state, as rows.
export function rendered(content: string, filetype: Filetype, conceal: boolean): string[] {
  if (filetype !== "hide" || !conceal) return content.split("\n")
  let text = ""
  let start = 0
  while (start <= content.length) {
    const nl = content.indexOf("\n", start)
    const end = nl === -1 ? content.length : nl
    if (content[start] === "#") {
      if (nl === -1) break
    } else {
      text += content.slice(start, end).replaceAll("*", "")
      if (nl !== -1) text += "\n"
    }
    if (nl === -1) break
    start = nl + 1
  }
  return text.split("\n")
}

// A worker whose replies the test releases one by one, in any order.
export interface Pending {
  id: number
  content: string
  filetype: string
  // What the model was when the block asked: a reply is current while the tag is.
  tag: unknown
  resolve: (r: { highlights?: SimpleHighlight[]; error?: string }) => void
  reject: (e: Error) => void
}

export class ModelClient extends TreeSitterClient {
  pending: Pending[] = []
  calls = 0
  tag: (content: string) => unknown = () => undefined
  constructor() {
    // The Node runner allows this data path; the worker never starts.
    super({ dataPath: join(tmpdir(), "tree-sitter-styled-text-test") }, { autoStartWorker: false })
  }
  override async highlightOnce(content: string, filetype: string) {
    const { promise, resolve, reject } = Promise.withResolvers<{ highlights?: SimpleHighlight[]; error?: string }>()
    this.pending.push({ id: this.calls++, content, filetype, tag: this.tag(content), resolve, reject })
    return promise
  }
  // Told of every successful reply's tag.
  answered: (tag: unknown) => void = () => {}
  reply(index: number) {
    const [item] = this.pending.splice(index, 1)
    if (item) this.answered(item.tag)
    item?.resolve({ highlights: grammar(item.content, item.filetype) })
  }
  // A worker rejects, or answers with an error as a parse failure does.
  fail(index: number, answer: boolean) {
    const [item] = this.pending.splice(index, 1)
    if (answer) item?.resolve({ error: "Failed to parse content" })
    else item?.reject(new Error("worker failed"))
  }
}

export function rng(seed: number) {
  let s = seed * 2654435761 + 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

export const pieces = ["a", "x", "*", "#", "\n", "ab", "\n#h", "\n*"]
export function text(r: () => number, max: number): string {
  let out = ""
  const n = 1 + Math.floor(r() * max)
  for (let i = 0; i < n; i++) out += pieces[Math.floor(r() * pieces.length)]
  return out
}

export class Failure extends Error {
  constructor(
    readonly property: string,
    message: string,
  ) {
    super(`${property}: ${message}`)
  }
}

// MODEL_SKIP=a,b turns properties off, to look for failures behind a known one.
export const SKIP = new Set((process.env.MODEL_SKIP ?? "").split(",").filter(Boolean))
export function fail(property: string, message: string): void {
  if (!SKIP.has(property)) throw new Failure(property, message)
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

// Removes chunks of commands, from half the list down to single commands, while `same` still fails the same way.
export async function removeChunks<C>(commands: C[], same: (candidate: C[]) => Promise<boolean>): Promise<C[]> {
  let best = commands
  for (let size = Math.floor(best.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let at = 0; at + size <= best.length; ) {
      const candidate = [...best.slice(0, at), ...best.slice(at + size)]
      if (await same(candidate)) best = candidate
      else at += size
    }
  }
  return best
}
