// Seeded model tests: a generator of commands per seed, a run that throws a Failure naming the property it breaks, and
// a shrinker that keeps a shorter command list only while it fails the same property. MODEL_SEED=<s> replays one seed,
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

/**
 * Runs `run` on each seed's commands; on a failure, shrinks the commands to the shortest list that fails the same
 * property and throws with that trace.
 */
export async function check<C>(
  count: number,
  generate: (seed: number) => C[],
  run: (commands: C[]) => Promise<void>,
): Promise<void> {
  for (const seed of seeds(count)) {
    const commands = generate(seed)
    let failure: Failure | undefined
    try {
      await run(commands)
    } catch (error) {
      if (!(error instanceof Failure)) throw error
      failure = error
    }
    if (!failure) continue
    const property = failure.property
    const same = async (candidate: C[]) => {
      try {
        await run(candidate)
        return false
      } catch (error) {
        return error instanceof Failure && error.property === property
      }
    }
    const shrunk = await removeChunks(commands, same)
    let message = failure.message
    try {
      await run(shrunk)
    } catch (error) {
      if (error instanceof Failure) message = error.message
    }
    throw new Error(`seed ${seed}: ${message}\n${shrunk.map((command) => JSON.stringify(command)).join("\n")}`)
  }
}
