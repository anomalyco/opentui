// The Bun sidecar helper: JSON-RPC 2.0 over stdin/stdout, one message per line; stderr is its log. No dependencies.
// Run: bun helper.ts

const METHODS = ["echo", "stream", "sleep", "crash", "embed"]
const CANCELLED = -32800

type Id = number | string | null

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n")
const reply = (id: Id, result: unknown) => send({ jsonrpc: "2.0", id, result })
const fail = (id: Id, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } })

// The same numbers as helpers/rust/embed.rs: 256 FNV-1a hashes of the UTF-8 bytes, one per seed, L2-normalized.
const encoder = new TextEncoder()
const embed = (text: string): number[] => {
  const bytes = encoder.encode(text)
  const v = new Array<number>(256)
  for (let i = 0; i < 256; i++) {
    let h = 0x811c9dc5 ^ Math.imul(i, 0x9e3779b9)
    for (let j = 0; j < bytes.length; j++) h = Math.imul(h ^ bytes[j]!, 0x01000193)
    v[i] = ((h >>> 0) / 4294967296) * 2 - 1
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

// The `sleep` calls in progress: id → cancel.
const sleeps = new Map<Id, () => void>()

const handle = (line: string) => {
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch (e) {
    return fail(null, -32700, String(e))
  }
  const { id = null, method, params } = msg
  switch (method) {
    case "$/cancel":
      return sleeps.get(params?.id)?.()
    case "initialize":
      return reply(id, { protocol: 0, methods: METHODS })
    case "echo":
      return reply(id, params)
    case "stream": {
      const n = params?.n ?? 0
      for (let i = 0; i < n; i++) send({ jsonrpc: "2.0", method: "$/chunk", params: { id, chunk: { i } } })
      return reply(id, { count: n })
    }
    case "sleep": {
      const timer = setTimeout(() => {
        sleeps.delete(id)
        reply(id, null)
      }, params?.ms ?? 0)
      sleeps.set(id, () => {
        clearTimeout(timer)
        sleeps.delete(id)
        fail(id, CANCELLED, "cancelled")
      })
      return
    }
    case "crash":
      return params?.how === "abort" ? process.abort() : process.exit(1)
    case "embed": {
      const vector = embed(String(params?.text ?? ""))
      return reply(id, { dim: vector.length, vector })
    }
    default:
      if (id !== null) fail(id, -32601, `no method ${method}`)
  }
}

const decoder = new TextDecoder()
let buffered = ""
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true })
  let end: number
  while ((end = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, end)
    buffered = buffered.slice(end + 1)
    if (line.trim()) handle(line)
  }
}
// EOF: the host closed our stdin, so it is gone or wants us gone.
process.exit(0)

// A module, for the top-level await.
export {}
