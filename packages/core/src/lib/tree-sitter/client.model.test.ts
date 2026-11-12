import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TreeSitterClient } from "./client.js"
import type { TreeSitterWorkerRequest as Request, TreeSitterWorkerResponse as Response } from "./types.js"

// The client's buffer lifecycle against a fake worker, with random commands and replies in any order. The fake keeps
// the real worker's contract: a buffer's messages run one at a time in the order they came, other messages at once,
// and a started message can pause (on a grammar load) while others run. Every parser and tree it makes has one owner
// in a ledger: a buffer, a one-shot request or the parser cache. The ledger owns the buffer state; the client's copy
// is a cache of it. A test row next to this one runs the real worker and counts its real trees and parsers.

const SEEDS = Number(process.env.MODEL_SEEDS ?? 1000)
const STEPS = Number(process.env.MODEL_STEPS ?? 60)
const dataPath = join(tmpdir(), "tree-sitter-styled-text-test")

type Command = { op: string; id: number; n: number }
type State = { parser: string; tree: string; version: number; content: string; broken: boolean }

class Failure extends Error {}
const check = (ok: unknown, message: string) => {
  if (!ok) throw new Failure(message)
}

class FakeWorker {
  onmessage: ((event: { data: Response }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  ledger = new Map<string, string>()
  buffers = new Map<number, State>()
  cache = new Map<string, string>()
  queues = new Map<number, Generator<void>[]>()
  running: Generator<void>[] = []
  terminated = false
  private next = 0

  postMessage(message: Request) {
    if (this.terminated) return
    const job = this.handle(message)
    if (!("bufferId" in message)) return void (job.next().done || this.running.push(job))
    const queue = this.queues.get(message.bufferId) ?? []
    this.queues.set(message.bufferId, [...queue, job])
  }
  terminate() {
    // The worker's memory goes with it.
    this.terminated = true
    for (const map of [this.ledger, this.buffers, this.cache, this.queues]) map.clear()
    this.running = []
    return Promise.resolve(0)
  }
  runnable() {
    return [...this.running, ...[...this.queues.values()].map((queue) => queue[0]!)]
  }
  // Runs one step of the k-th runnable message.
  step(k: number) {
    const jobs = this.runnable()
    const job = jobs[k % jobs.length]
    if (!job || !job.next().done) return
    this.running = this.running.filter((other) => other !== job)
    for (const [id, queue] of this.queues) {
      if (queue[0] === job) queue.length > 1 ? queue.shift() : this.queues.delete(id)
    }
  }
  // Each reply is its own task, as a message event is.
  private post(data: Response) {
    if (!this.terminated) setImmediate(() => this.onmessage?.({ data }))
  }
  private make(kind: string, owner: string) {
    const name = `${kind}${this.next++}`
    this.ledger.set(name, owner)
    return name
  }
  private free(name: string) {
    check(this.ledger.delete(name), `ledger: ${name} freed twice`)
  }
  // A reply carries the text it highlights. An edit's reply covers only the edited range, so it also carries the
  // version it edited: it is right only on top of that version's highlights.
  private highlight(bufferId: number, version: number, content: string, base?: number): Response {
    const groups = base === undefined ? [content] : [content, `${base}`]
    const line = { line: 0, highlights: groups.map((group) => ({ startCol: 0, endCol: 0, group })) }
    return { type: "HIGHLIGHT_RESPONSE", bufferId, version, highlights: [{ ...line, droppedHighlights: [] }] }
  }

  private *handle(m: Request): Generator<void> {
    switch (m.type) {
      case "INIT":
        return this.post({ type: "INIT_RESPONSE" })
      case "INITIALIZE_PARSER": {
        yield
        // A grammar whose setup throws answers with an error, as an unsupported ABI version does.
        if (m.filetype === "bad")
          return this.post({ type: "ERROR", bufferId: m.bufferId, messageId: m.messageId, error: "bad grammar" })
        const hasParser = m.filetype === "js"
        this.post({ type: "PARSER_INIT_RESPONSE", bufferId: m.bufferId, messageId: m.messageId, hasParser })
        if (!hasParser) return
        const owner = `buffer ${m.bufferId}`
        const state = { parser: this.make("p", owner), tree: this.make("t", owner), broken: false }
        this.buffers.set(m.bufferId, { ...state, version: m.version, content: m.content })
        yield
        return this.post(this.highlight(m.bufferId, m.version, m.content))
      }
      case "HANDLE_EDITS":
      case "RESET_BUFFER": {
        const state = this.buffers.get(m.bufferId)
        if (!state) throw new Failure(`warning: ${m.type} ${m.bufferId} came after the buffer was disposed (487)`)
        check(m.version >= state.version, `version: buffer ${m.bufferId} went from ${state.version} to ${m.version}`)
        // An edit made to other text than the tree's breaks the parser for good, as a markdown tree does (489).
        const [edit] = m.edits
        const edited =
          edit && state.content.slice(0, edit.startIndex) + m.content.slice(edit.startIndex, edit.newEndIndex)
        state.broken ||= m.type === "HANDLE_EDITS" && edited + state.content.slice(edit!.oldEndIndex) !== m.content
        if (state.broken) return this.post({ type: "ERROR", bufferId: m.bufferId, error: "parse trapped" })
        const base = m.type === "HANDLE_EDITS" ? state.version : undefined
        const tree = this.make("t", `buffer ${m.bufferId}`)
        this.free(state.tree)
        Object.assign(state, { tree, version: m.version, content: m.content })
        yield
        return this.post(this.highlight(m.bufferId, m.version, m.content, base))
      }
      case "DISPOSE_BUFFER": {
        const state = this.buffers.get(m.bufferId)
        if (state) [state.tree, state.parser].forEach((name) => this.free(name))
        this.buffers.delete(m.bufferId)
        return this.post({ type: "BUFFER_DISPOSED", bufferId: m.bufferId })
      }
      case "ONESHOT_HIGHLIGHT": {
        yield
        const hasParser = m.filetype === "js"
        if (hasParser && !this.cache.has(m.filetype)) this.cache.set(m.filetype, this.make("p", "cache"))
        const tree = hasParser && this.make("t", `request ${m.messageId}`)
        yield
        if (tree) this.free(tree)
        return this.post({ type: "ONESHOT_HIGHLIGHT_RESPONSE", messageId: m.messageId, hasParser, highlights: [] })
      }
      case "CLEAR_CACHE":
        yield
        for (const parser of this.cache.values()) this.free(parser)
        this.cache.clear()
        return this.post({ type: "CLEAR_CACHE_RESPONSE", messageId: m.messageId })
      case "UPDATE_DATA_PATH":
        yield
        return this.post({ type: "UPDATE_DATA_PATH_RESPONSE", messageId: m.messageId })
    }
  }
}

// Each worker the client starts is a fake, wired as startWorker wires a real one.
function modelClient(workers: FakeWorker[]) {
  const client = new TreeSitterClient({ dataPath }, { autoStartWorker: false })
  const internals = client as unknown as {
    worker?: FakeWorker
    startWorker(): void
    handleWorkerMessage(event: unknown): void
    handleWorkerFailure(worker: FakeWorker, error: Error): void
  }
  internals.startWorker = () => {
    if (internals.worker) return
    const worker = new FakeWorker()
    workers.push((internals.worker = worker))
    worker.onmessage = (event) => internals.worker === worker && internals.handleWorkerMessage(event)
    worker.onerror = (event) =>
      internals.worker === worker && internals.handleWorkerFailure(worker, new Error(event.message))
  }
  return client
}

// Timers run on a clock that only the test moves, so a 3 s timeout costs nothing.
const clock = { now: 0, next: 1, timers: new Map<number, { at: number; run: () => void }>() }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
async function wait(ms: number) {
  const end = clock.now + ms
  for (;;) {
    const due = [...clock.timers].filter(([, t]) => t.at <= end).sort(([, a], [, b]) => a.at - b.at)[0]
    if (!due) break
    clock.timers.delete(due[0])
    clock.now = due[1].at
    due[1].run()
    await flush()
  }
  clock.now = end
}

// Weights: buffer commands and worker steps are common, lifecycle commands are rare.
const OPS = "create 8 update 12 reset 4 remove 5 step 20 wait 3 once 2 clear 1 path 1 other 1 destroy 1 crash 1"
function generate(seed: number): Command[] {
  let s = seed * 2654435761 + 1
  const r = (n: number) => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) % n
  }
  const ops = OPS.match(/\w+ \d+/g)!.flatMap((entry) => Array(Number(entry.split(" ")[1])).fill(entry.split(" ")[0]))
  return Array.from({ length: STEPS }, () => ({ op: ops[r(ops.length)]!, id: r(2), n: r(1000) }))
}

async function run(commands: Command[]) {
  const workers: FakeWorker[] = []
  const client = modelClient(workers)
  const worker = () => workers.at(-1)!
  // What the caller asked for: the text and version it last sent, and whether its create resolved with a parser.
  const docs = new Map<number, { content: string; version: number; live: boolean }>()
  const pending: { name: string; settled: boolean }[] = []
  const late: unknown[] = []
  const fail = (message: string) => void late.push(new Failure(message))
  // A destroy or a worker crash may reject any call made before it; otherwise a call rejects only when `rejects` says so.
  let epoch = 0
  const track = (name: string, promise: Promise<unknown>, then = (_: unknown) => {}, rejects = (_: Error) => false) => {
    const entry = { name, settled: false }
    const at = epoch
    pending.push(entry)
    promise
      .then(then, (error) => void (at === epoch && !rejects(error) && fail(`result: ${name} rejected: ${error}`)))
      .catch((error) => late.push(error))
      .finally(() => (entry.settled = true))
  }
  // What a consumer that merges the replies shows; an edit's reply on top of another version breaks it until a full one.
  // The client forwards only replies at the version the caller last sent to a buffer it has not removed.
  const shown = new Map<number, { version: number; content?: string }>()
  client.on("highlights:response", (id, version, highlights) => {
    const doc = docs.get(id)
    if (!doc?.live || doc.version !== version)
      fail(`event: highlight ${id}@${version}, caller has ${JSON.stringify(doc)}`)
    const [content, base] = highlights[0]!.highlights.map((range) => range.group)
    const right = base === undefined || shown.get(id)?.version === Number(base)
    shown.set(id, right ? { version, content } : { version: -1 })
  })
  client.on("buffer:initialized", (id) => void (docs.has(id) || fail(`event: buffer:initialized for removed ${id}`)))
  // Time passes before the worker gets to its queue, then the worker drains and the client's timers run out.
  const settle = async () => {
    await wait(20)
    for (let idle = 0; idle < 4; ) {
      await flush()
      const busy = workers.some((w) => !w.terminated && w.runnable().length > 0)
      for (const w of workers) while (!w.terminated && w.runnable().length > 0) w.step(0)
      idle = busy ? 0 : idle + 1
      if (idle === 3) await wait(3001)
    }
  }
  // The client's buffers are a cache of the worker's: equal once the worker is idle.
  const consistent = () => {
    if (late[0]) throw late[0]
    for (const p of pending) check(p.settled, `settle: ${p.name} never settled`)
    const w = worker()
    const owners = [...w.ledger.values()]
    for (const owner of owners)
      check(owner === "cache" || owner.startsWith("buffer "), `ledger: ${owner} after settling`)
    const listed = client.getAllBuffers().map((buffer) => buffer.id)
    check(listed.sort().join() === [0, 1].filter((id) => client.getBuffer(id)).join(), `cache: getAllBuffers ${listed}`)
    for (const id of [0, 1]) {
      const doc = docs.get(id)
      const cached = client.getBuffer(id)
      const state = w.terminated ? undefined : w.buffers.get(id)
      const owned = owners.filter((owner) => owner === `buffer ${id}`).length
      check(owned === (state ? 2 : 0), `ledger: buffer ${id} owns ${owned} objects`)
      check(!state?.broken, `trap: buffer ${id}`)
      check(doc || !cached, `gone: buffer ${id} was removed, the client still has ${JSON.stringify(cached)}`)
      check(!doc?.live || state, `live: buffer ${id} resolved with a parser, the worker has none`)
      check(!!cached?.hasParser === !!state, `cache: buffer ${id} client ${JSON.stringify(cached)}, worker ${!!state}`)
      if (!state || !cached) continue
      check(cached.version === state.version && cached.content === state.content, `cache: buffer ${id} differs`)
      if (doc?.live) check(doc.version === state.version && doc.content === state.content, `live: buffer ${id} lags`)
      const last = shown.get(id)
      const shows = `highlight: buffer ${id} shows ${JSON.stringify(last)}`
      check(last?.version === state.version && last.content === state.content, shows)
    }
  }

  try {
    await client.initialize()
    for (const [at, { op, id, n }] of commands.entries()) {
      const doc = docs.get(id)
      const piece = ["a", "\n", "bc", ""][n % 4]!
      if (op === "create" && (!doc || doc.live)) {
        const record = { content: piece + n, version: 1 + (n % 3), live: false }
        const filetype = ["none", "bad", "js", "js", "js", "js", "js"][n % 7]!
        const destroying = (client as unknown as { destroyPromise?: unknown }).destroyPromise !== undefined
        const [at, ready] = [epoch, client.isInitialized()]
        if (!doc) docs.set(id, record)
        const created = client.createBuffer(id, record.content, filetype, record.version)
        const then = (hasParser: unknown) => {
          check(!doc, `duplicate: create ${id} of a live buffer resolved`)
          // A destroy or a crash rejects a create that is waiting for the worker.
          check(!ready || at === epoch, `result: create ${id} resolved ${hasParser} after a destroy or crash`)
          if (docs.get(id) !== record) return
          // Nothing removed or replaced this create, so only a destroy in progress makes a `js` create fail.
          check(hasParser || filetype !== "js" || destroying, `result: create ${id} resolved false`)
          record.live = hasParser === true
          // A create with no parser keeps its record; one that failed leaves none.
          if (!hasParser && filetype === "js") docs.delete(id)
        }
        // A duplicate rejects and keeps the live buffer; a grammar error rejects and leaves no record.
        const rejects = (error: Error) =>
          doc ? /already exists/.test(error.message) : (docs.get(id) === record && docs.delete(id), filetype === "bad")
        track(`create ${id}`, created, then, rejects)
      } else if ((op === "update" || op === "reset") && (!doc || doc.live)) {
        const old = doc?.content ?? ""
        const start = n % (old.length + 1)
        const end = op === "reset" ? old.length : start + ((n >> 2) % (old.length - start + 1))
        const content = op === "reset" ? `${piece}${n}` : old.slice(0, start) + piece + old.slice(end)
        const version = (doc?.version ?? 0) + 1
        if (doc) Object.assign(doc, { content, version })
        if (op === "reset") track(`reset ${id}`, client.resetBuffer(id, version, content))
        const at0 = { row: 0, column: 0 }
        const edit = { startIndex: start, oldEndIndex: end, newEndIndex: start + piece.length }
        const edits = [{ ...edit, startPosition: at0, oldEndPosition: at0, newEndPosition: at0 }]
        if (op === "update") track(`update ${id}`, client.updateBuffer(id, edits, content, version))
        const cached = client.getBuffer(id)
        check(!doc || (cached?.version === version && cached.content === content), `cache: ${op} ${id} not stored`)
      } else if (op === "remove") {
        docs.delete(id)
        shown.delete(id)
        track(`remove ${id}`, client.removeBuffer(id))
      } else if (op === "step") {
        worker().step(n)
      } else if (op === "wait") {
        await wait([1, 20, 3001][n % 3]!)
      } else if (op === "once") {
        track("highlightOnce", client.highlightOnce("a", n % 2 ? "js" : "none"))
      } else if (op === "clear") {
        // A clear frees every parser the cache held when it was asked; it rejects only on a client not initialized.
        const [w, ready, parsers] = [worker(), client.isInitialized(), [...worker().cache.values()]]
        const freed = () =>
          check(
            parsers.every((p) => !w.ledger.has(p)),
            `clear: resolved with ${parsers} cached`,
          )
        track("clearCache", client.clearCache(), freed, () => !ready)
      } else if (op === "path") {
        track("setDataPath", client.setDataPath(`${dataPath}-${n}`))
      } else if (op === "other") {
        const other = modelClient([])
        await other.initialize()
        await other.destroy()
      } else if (op === "destroy" || op === "crash") {
        // A destroy during a destroy only joins it, and a crash needs a running worker: neither clears anything then.
        const destroying = (client as unknown as { destroyPromise?: unknown }).destroyPromise !== undefined
        if (op === "destroy" ? !destroying : worker().onerror) (docs.clear(), shown.clear(), epoch++)
        if (op === "destroy") track("destroy", client.destroy())
        else worker().onerror?.({ message: "worker crashed" })
      }
      // Some commands run in the same task as the next one, while the client still awaits.
      if (n % 3) await flush()
      for (const w of workers) for (const state of w.buffers.values()) check(!state.broken, `trap: step ${at} ${op}`)
    }
    await settle()
    consistent()
    // Every buffer removed and the cache cleared: nothing is left in the ledger.
    for (const id of [0, 1]) (docs.delete(id), track(`remove ${id}`, client.removeBuffer(id)))
    if (client.isInitialized()) track("clearCache", client.clearCache())
    await settle()
    consistent()
    check(worker().terminated || worker().ledger.size === 0, `drain: ${JSON.stringify([...worker().ledger])}`)
    track("destroy", client.destroy())
    await settle()
    consistent()
  } finally {
    await client.destroy()
  }
}

async function failure(commands: Command[]) {
  try {
    await run(commands)
  } catch (error) {
    if (error instanceof Failure) return error.message
    throw error
  }
}

// Removes chunks of commands, from half the list down to one command, while the same property still fails.
async function shrink(commands: Command[], message: string) {
  const property = message.split(":")[0]
  for (let size = commands.length >> 1; size >= 1; size >>= 1) {
    for (let at = 0; at + size <= commands.length; ) {
      const candidate = [...commands.slice(0, at), ...commands.slice(at + size)]
      if ((await failure(candidate))?.startsWith(`${property}:`)) commands = candidate
      else at += size
    }
  }
  return commands
}

test(`tree-sitter client buffers follow the worker's ledger (${SEEDS} seeds x ${STEPS} steps)`, async () => {
  const { setTimeout, clearTimeout } = globalThis
  // The client warns when a removal times out and logs worker crashes; the properties say what matters.
  const { warn, error } = console
  Object.assign(console, { warn: () => {}, error: () => {} })
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    clock.timers.set(clock.next, { at: clock.now + ms, run })
    return clock.next++
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => void clock.timers.delete(id)) as typeof clearTimeout
  try {
    for (let seed = 0; seed < SEEDS; seed++) {
      const message = await failure(generate(seed))
      if (!message) continue
      const shrunk = await shrink(generate(seed), message)
      const steps = shrunk.map(({ op, id, n }) => `${op} ${id} ${n}`).join(", ")
      expect(`seed ${seed}: ${message}`).toBe(`no failure; shrunk: ${steps} -> ${await failure(shrunk)}`)
    }
  } finally {
    Object.assign(globalThis, { setTimeout, clearTimeout })
    Object.assign(console, { warn, error })
  }
}, 60000)
