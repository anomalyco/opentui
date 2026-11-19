// Seeded model tests: a generator of commands per seed, a run that throws a Failure naming the property it breaks (any
// other throw is the property "throws"), and a shrinker that keeps a shorter command list only while it fails the same
// property at the same kind of command. MODEL_STATS=1 prints the counts a test made. MODEL_SEED=<s> replays one seed,
// MODEL_SEEDS=<n> runs more, MODEL_SKIP=a,b turns properties off to look for failures behind a known one.

export function rng(seed: number): () => number {
  let s = seed * 2654435761 + 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

export class Failure extends Error {
  constructor(
    readonly property: string,
    message: string,
  ) {
    super(`${property}: ${message}`)
  }
}

export const SKIP = new Set((process.env.MODEL_SKIP ?? "").split(",").filter(Boolean))

export function fail(property: string, message: string): void {
  if (!SKIP.has(property)) throw new Failure(property, message)
}

// How often a command took effect or a property compared, as a test counts them: a check that never runs passes too.
const counts = new Map<string, number>()
export function count(name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1)
}

/** The seeds to run: MODEL_SEED alone, else 1..MODEL_SEEDS, else 1..count. */
export function seeds(count: number): number[] {
  if (process.env.MODEL_SEED) return [Number(process.env.MODEL_SEED)]
  return Array.from({ length: Number(process.env.MODEL_SEEDS ?? count) }, (_, i) => i + 1)
}

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

// The Failure a run throws (a crash in the system is one too, the property "throws"), and the kind of the command the
// run read last ("end" once a loop has gone past the last one): two bugs that break one property at different kinds of
// command stay two while shrinking.
async function failureOf<C>(run: (commands: C[]) => Promise<void>, commands: C[], kind: (command: C) => unknown) {
  let read = -1
  const tracked = new Proxy(commands, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) read = Number(key)
      // An iterator reads the length after the last command once more, to end: what fails then follows the loop.
      else if (key === "length" && read === target.length - 1) read = target.length
      return Reflect.get(target, key, receiver)
    },
  })
  try {
    await run(tracked)
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure("throws", String((error as Error)?.stack ?? error))
    return { failure, kind: read < 0 ? undefined : read === commands.length ? "end" : kind(commands[read]!) }
  }
}

/**
 * Runs `run` on each seed's commands; on a failure, shrinks the commands to the shortest list that fails the same
 * property at the same `kind` of command and throws with that trace.
 */
export async function check<C>(
  count: number,
  generate: (seed: number) => C[],
  run: (commands: C[]) => Promise<void>,
  kind: (command: C) => unknown = (command: any) => command?.k ?? command?.op ?? command,
): Promise<void> {
  counts.clear()
  for (const seed of seeds(count)) {
    const commands = generate(seed)
    const first = await failureOf(run, commands, kind)
    if (!first || SKIP.has(first.failure.property)) continue
    const same = async (candidate: C[]) => {
      const found = await failureOf(run, candidate, kind)
      return found?.failure.property === first.failure.property && found.kind === first.kind
    }
    const shrunk = await removeChunks(commands, same)
    const message = (await failureOf(run, shrunk, kind))?.failure.message ?? first.failure.message
    throw new Error(`seed ${seed}: ${message}\n${shrunk.map((command) => JSON.stringify(command)).join("\n")}`)
  }
  if (process.env.MODEL_STATS)
    console.log(
      [...counts]
        .sort()
        .map(([name, n]) => `${name}: ${n}`)
        .join("\n"),
    )
}
