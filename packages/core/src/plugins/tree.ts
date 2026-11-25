// A hierarchical slot tree. A host mounts named paths ("prompt.footer", "prompt.footer.status"); a path contains
// every path it prefixes. Owners (plugins) claim places relative to a path, and a pure resolver turns the mounted
// paths and the ordered claims into what each mounted path renders. The tree needs no renderer. The slot registry
// does not use it.

export type SlotPlacementKind = "before" | "prepend" | "append" | "after" | "replace"

const PLACEMENTS: readonly SlotPlacementKind[] = ["before", "prepend", "append", "after", "replace"]

export type SlotClaimRender<TNode, TInput> = (input: TInput) => TNode

type ExactlyOne<T> = { [K in keyof T]: Pick<T, K> & { [O in Exclude<keyof T, K>]?: never } }[keyof T]

/** Exactly one placement key naming `Path`; an app builds its own claim type on it. */
export type SlotPlacementOf<Path> = Readonly<ExactlyOne<Record<SlotPlacementKind, Path>>>

/** One claim: exactly one placement key names the target path; `render` gets that path's input. */
export type SlotClaim<TNode, TSlots extends object> = {
  [Path in keyof TSlots]: { readonly render: SlotClaimRender<TNode, TSlots[Path]> } & SlotPlacementOf<Path>
}[keyof TSlots]

/** What the resolver reads of a claim. */
export interface SlotClaimPlacement {
  readonly kind: SlotPlacementKind
  readonly target: string
}

/** A claim as the tree holds it: its owner and its placement. */
export interface ResolvedSlotClaim<TNode = unknown, TSlots extends object = any> extends SlotClaimPlacement {
  readonly owner: string
  readonly claim: SlotClaim<TNode, TSlots>
}

/** What one mounted path renders besides its own children. */
export interface SlotPlaced<T> {
  readonly before: readonly T[]
  readonly prepend: readonly T[]
  readonly append: readonly T[]
  readonly after: readonly T[]
  readonly replace?: T
}

export interface SlotResolution<T> {
  /** Each targeted path's claims; an untargeted path is absent and renders only its children. */
  readonly placed: ReadonlyMap<string, SlotPlaced<T>>
  /** A suppressed claim and the claim that won, if any; none when the target and its ancestors are not mounted. */
  readonly suppressed: ReadonlyArray<{ readonly claim: T; readonly by?: T }>
  /** A claim whose target is not mounted, appended to this mounted ancestor instead. */
  readonly degraded: ReadonlyArray<{ readonly claim: T; readonly to: string }>
}

/** A claim that failed to render in the mounted `path` (`render`), or whose placeholder failed (`placeholder`). */
export interface SlotTreeErrorEvent<TNode = unknown, TSlots extends object = any> {
  readonly owner: string
  readonly path: string
  readonly claim: SlotClaim<TNode, TSlots>
  readonly phase: "render" | "placeholder"
  readonly error: Error
}

export interface SlotTreeOptions<TNode = unknown, TSlots extends object = any> {
  onError?: (event: SlotTreeErrorEvent<TNode, TSlots>) => void
}

export interface SlotOwner<TNode, TSlots extends object> {
  /** Adds one claim after the owner's others, shown at once. The returned function removes it. */
  claim(claim: SlotClaim<TNode, TSlots>): () => void
  /** Opens a stage, whose claims show only once it commits: an activation that can still fail. */
  stage(): SlotStage<TNode, TSlots>
  /** Drops the owner's claims and ends its stages; the owner keeps its place: a hot reload or a disable. */
  reset(): void
  /** Forgets the owner. Its handle and its stages do nothing after this. */
  remove(): void
}

/** One generation of an owner's claims, such as one activation of a plugin. */
export interface SlotStage<TNode, TSlots extends object> {
  /**
   * Adds one claim: held until `commit()`, shown at once after it, ignored once the stage ended. The returned function
   * removes it.
   */
  claim(claim: SlotClaim<TNode, TSlots>): () => void
  /**
   * Replaces the owner's claims with this stage's in one change, and ends the owner's other stages. A claim object the
   * owner shows already keeps its place in the tree, so a slot keeps its mount.
   */
  commit(): void
  /**
   * Ends the stage. Held claims never show; a committed stage's claims are the owner's, and drop as `reset()` drops
   * them. The owner's other stages stay open.
   */
  dispose(): void
}

const EMPTY: SlotPlaced<never> = { before: [], prepend: [], append: [], after: [] }

/** Whether `path` is strictly inside `ancestor`. */
export function slotPathContains(ancestor: string, path: string): boolean {
  return path.startsWith(ancestor + ".")
}

/**
 * Resolves `claims`, in order, against the mounted `paths`. Per target the last `replace` wins; an accepted
 * `replace` suppresses every claim inside it whatever the order; an additive claim on a path that is not mounted
 * appends to its nearest mounted ancestor; a `replace` on a path that is not mounted is suppressed.
 */
export function resolveSlotClaims<T extends SlotClaimPlacement>(input: {
  readonly paths: ReadonlySet<string>
  readonly claims: ReadonlyArray<T>
}): SlotResolution<T> {
  const suppressed: { claim: T; by?: T }[] = []
  const degraded: { claim: T; to: string }[] = []

  // Replacement boundaries: the last claim per target, then shallow boundaries first so a nested one meets its
  // container.
  // A replaced claim's winner is known once the boundaries are: its entry is filled in then.
  const winners = new Map<string, T>()
  const displaced: { claim: T; by?: T }[] = []
  for (const claim of input.claims) {
    if (claim.kind !== "replace") continue
    if (!input.paths.has(claim.target)) {
      suppressed.push({ claim })
      continue
    }
    const prior = winners.get(claim.target)
    if (prior) {
      const entry = { claim: prior }
      suppressed.push(entry)
      displaced.push(entry)
    }
    winners.set(claim.target, claim)
  }
  const boundaries = new Map<string, T>()
  const containing = (path: string) => {
    for (const [boundary, winner] of boundaries) if (slotPathContains(boundary, path)) return winner
    return undefined
  }
  for (const [path, winner] of [...winners].sort((a, b) => depth(a[0]) - depth(b[0]))) {
    const outer = containing(path)
    if (outer) suppressed.push({ claim: winner, by: outer })
    else boundaries.set(path, winner)
  }
  for (const entry of displaced) entry.by = boundaries.get(entry.claim.target) ?? containing(entry.claim.target)

  const placed = new Map<string, { before: T[]; prepend: T[]; append: T[]; after: T[]; replace?: T }>()
  const bucket = (path: string) => {
    let lists = placed.get(path)
    if (!lists) placed.set(path, (lists = { before: [], prepend: [], append: [], after: [] }))
    return lists
  }
  for (const claim of input.claims) {
    const kind = claim.kind
    if (kind === "replace") continue
    // Inside placements on a replaced boundary are its contents; siblings of the boundary stay outside it.
    const inside = kind === "prepend" || kind === "append" ? boundaries.get(claim.target) : undefined
    const outer = inside ?? containing(claim.target)
    if (outer) {
      suppressed.push({ claim, by: outer })
      continue
    }
    if (input.paths.has(claim.target)) {
      bucket(claim.target)[kind].push(claim)
      continue
    }
    const ancestor = mountedAncestor(claim.target, input.paths)
    if (ancestor === undefined) {
      suppressed.push({ claim })
      continue
    }
    // The ancestor is never a replaced boundary: `containing` caught that.
    degraded.push({ claim, to: ancestor })
    bucket(ancestor).append.push(claim)
  }
  for (const [path, winner] of boundaries) bucket(path).replace = winner
  return { placed, suppressed, degraded }
}

function depth(path: string): number {
  return path.split(".").length
}

function mountedAncestor(path: string, paths: ReadonlySet<string>): string | undefined {
  // `lastIndexOf` clamps a negative start to 0, so the walk stops itself after the dot at 0.
  for (let index = path.lastIndexOf("."); index !== -1; index = index > 0 ? path.lastIndexOf(".", index - 1) : -1) {
    const ancestor = path.slice(0, index)
    if (paths.has(ancestor)) return ancestor
  }
  return undefined
}

/** Returns `path` if it is names joined by dots, none of them empty; throws otherwise. */
function checkPath(path: string): string {
  if (!/^[^.]+(\.[^.]+)*$/.test(path)) throw new Error(`"${path}" is not a slot path: a name between dots is empty`)
  return path
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === "string") return new Error(error)
  return new Error(`Unknown plugin error: ${String(error)}`)
}

interface OwnerState<TNode, TSlots extends object> {
  id: string
  claims: ResolvedSlotClaim<TNode, TSlots>[]
  /** Counts the times `claims` was replaced or dropped; a claim's release works only in its own generation. */
  generation: number
  /** The stages that have not ended. A committed stage holds nothing; its claims show at once. */
  stages: Set<Stage<TNode, TSlots>>
  handle: SlotOwner<TNode, TSlots>
}

interface Stage<TNode, TSlots extends object> {
  held: ResolvedSlotClaim<TNode, TSlots>[] | null
  /** The generation it committed in, and for each held claim the shown claim its commit kept in its place. */
  generation: number
  kept: Map<ResolvedSlotClaim<TNode, TSlots>, ResolvedSlotClaim<TNode, TSlots>>
}

const ignore = () => {}

/**
 * The slot tree: owners and their claims, the mounted paths, and the resolution of both. Claims are in the owners'
 * order, then in the order each owner made them.
 */
export class SlotTree<TNode, TSlots extends object> {
  private options: SlotTreeOptions<TNode, TSlots>
  /** The owners, in order. */
  private owners = new Map<string, OwnerState<TNode, TSlots>>()
  /** The latest `order()` list, which also places owners created after it. */
  private ranking: readonly string[] = []
  private mounted = new Map<string, number>()
  private cached: SlotResolution<ResolvedSlotClaim<TNode, TSlots>> | null = null
  private listeners = new Set<() => void>()
  private batchDepth = 0
  private pending = false

  constructor(options: SlotTreeOptions<TNode, TSlots> = {}) {
    this.options = { ...options }
  }

  /**
   * The owner `id`, opened if it is new. A new owner listed in `order()` goes before the first owner listed after it,
   * and last otherwise; no other owner moves.
   */
  public owner(id: string): SlotOwner<TNode, TSlots> {
    const existing = this.owners.get(id)
    if (existing) return existing.handle
    const state: OwnerState<TNode, TSlots> = { id, claims: [], generation: 0, stages: new Set(), handle: undefined! }
    const live = () => this.owners.get(id) === state
    state.handle = {
      claim: (claim) => {
        const entry = this.entry(id, claim)
        return live() ? this.show(state, entry) : ignore
      },
      stage: () => this.stage(state, live()),
      reset: () => {
        if (this.end(state)) this.changed()
      },
      remove: () => {
        if (!live()) return
        this.owners.delete(id)
        if (this.end(state)) this.changed()
      },
    }
    const at = this.ranking.indexOf(id)
    const next = at === -1 ? undefined : this.ranking.slice(at + 1).find((other) => this.owners.has(other))
    const owners = [...this.owners]
    owners.splice(next === undefined ? owners.length : owners.findIndex(([other]) => other === next), 0, [id, state])
    this.owners = new Map(owners)
    return state.handle
  }

  /** Forgets every owner, as `remove()` on each does. The `order()` list stays. */
  public clear(): void {
    const states = [...this.owners.values()]
    this.owners = new Map()
    if (states.map((state) => this.end(state)).includes(true)) this.changed()
  }

  /**
   * Sets the owners' order. Listed owners take the places the listed owners hold, in list order; the rest stay. The
   * list is kept: a listed owner created or created again later takes its place in it.
   */
  public order(ids: readonly string[]): void {
    this.ranking = [...new Set(ids)]
    const listed = new Set(this.ranking)
    const order = this.ranking.filter((id) => this.owners.has(id))
    let moved = false
    const owners = [...this.owners].map(([id, state]): [string, OwnerState<TNode, TSlots>] => {
      if (!listed.has(id)) return [id, state]
      const next = order.shift()!
      moved ||= next !== id
      return [next, this.owners.get(next)!]
    })
    this.owners = new Map(owners)
    if (moved) this.changed()
  }

  /** Checks a claim and makes the tree's object for it. */
  private entry(owner: string, claim: SlotClaim<TNode, TSlots>): ResolvedSlotClaim<TNode, TSlots> {
    const kinds = PLACEMENTS.filter(
      (kind) => (claim as Partial<Record<SlotPlacementKind, unknown>>)[kind] !== undefined,
    )
    if (kinds.length !== 1) throw new Error(`A slot claim needs exactly one placement, got ${kinds.length}`)
    const kind = kinds[0]!
    return { owner, kind, target: checkPath(String((claim as Record<SlotPlacementKind, unknown>)[kind])), claim }
  }

  /** Shows `entry` now. Its release works until the owner's claims are replaced or dropped. */
  private show(state: OwnerState<TNode, TSlots>, entry: ResolvedSlotClaim<TNode, TSlots>): () => void {
    state.claims.push(entry)
    this.changed()
    const generation = state.generation
    return () => this.drop(state, entry, generation)
  }

  private drop(state: OwnerState<TNode, TSlots>, entry: ResolvedSlotClaim<TNode, TSlots>, generation: number): void {
    const index = state.generation === generation ? state.claims.indexOf(entry) : -1
    if (index === -1) return
    state.claims.splice(index, 1)
    this.changed()
  }

  /** Drops an owner's claims and ends its stages. Returns whether it showed a claim. */
  private end(state: OwnerState<TNode, TSlots>): boolean {
    state.generation += 1
    state.stages.clear()
    return state.claims.splice(0).length > 0
  }

  private stage(state: OwnerState<TNode, TSlots>, open: boolean): SlotStage<TNode, TSlots> {
    const stage: Stage<TNode, TSlots> = { held: [], generation: -1, kept: new Map() }
    if (open) state.stages.add(stage)
    return {
      claim: (claim) => {
        const entry = this.entry(state.id, claim)
        if (!state.stages.has(stage)) return ignore
        if (!stage.held) return this.show(state, entry)
        stage.held.push(entry)
        return () => {
          if (!stage.held) return this.drop(state, stage.kept.get(entry) ?? entry, stage.generation)
          const index = stage.held.indexOf(entry)
          if (index !== -1) stage.held.splice(index, 1)
        }
      },
      commit: () => {
        if (!state.stages.has(stage) || !stage.held) return
        const shown = [...state.claims]
        const claims = stage.held.map((entry) => {
          const index = shown.findIndex((old) => old.claim === entry.claim)
          if (index === -1) return entry
          const old = shown.splice(index, 1)[0]!
          stage.kept.set(entry, old)
          return old
        })
        const same = claims.length === state.claims.length && claims.every((entry, i) => entry === state.claims[i])
        state.generation += 1
        state.stages = new Set([stage])
        state.claims = claims
        stage.held = null
        stage.generation = state.generation
        if (!same) this.changed()
      },
      dispose: () => {
        if (!state.stages.delete(stage) || stage.held) return
        state.generation += 1
        if (state.claims.splice(0).length > 0) this.changed()
      },
    }
  }

  /** Counts one mounted instance of `path`. Throws unless `path` extends `within`. */
  public mount(path: keyof TSlots & string, options: { within?: keyof TSlots & string } = {}): () => void {
    checkPath(path)
    if (options.within !== undefined && !slotPathContains(options.within, path)) {
      throw new Error(`Slot "${path}" is mounted inside "${options.within}" but its path does not extend it`)
    }
    const count = this.mounted.get(path) ?? 0
    this.mounted.set(path, count + 1)
    if (count === 0) this.changed()
    let done = false
    return () => {
      if (done) return
      done = true
      const left = this.mounted.get(path)! - 1
      if (left > 0) {
        this.mounted.set(path, left)
        return
      }
      this.mounted.delete(path)
      this.changed()
    }
  }

  /** The claims of the mounted paths: placed, suppressed and degraded. */
  public resolution(): SlotResolution<ResolvedSlotClaim<TNode, TSlots>> {
    this.cached ??= resolveSlotClaims({
      paths: new Set(this.mounted.keys()),
      claims: [...this.owners.values()].flatMap((state) => state.claims),
    })
    return this.cached
  }

  /** What the mounted `path` renders besides its children. */
  public placed(path: keyof TSlots & string): SlotPlaced<ResolvedSlotClaim<TNode, TSlots>> {
    return this.resolution().placed.get(path) ?? EMPTY
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Runs `run` and notifies the listeners once at the end, if anything changed. */
  public batch<T>(run: () => T): T {
    this.batchDepth += 1
    try {
      return run()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0 && this.pending) {
        this.pending = false
        this.notify()
      }
    }
  }

  /** Reports that `claim` or its placeholder failed in the mounted `path`: calls `onError` and returns the event. */
  public reportError(
    claim: ResolvedSlotClaim<TNode, TSlots>,
    path: string,
    error: unknown,
    phase: SlotTreeErrorEvent["phase"] = "render",
  ): SlotTreeErrorEvent<TNode, TSlots> {
    const event = { owner: claim.owner, path, claim: claim.claim, phase, error: normalizeError(error) }
    try {
      this.options.onError?.(event)
    } catch (error) {
      console.error("Error in slot error callback:", error)
    }
    return event
  }

  /** Drops the cached resolution and notifies the listeners. */
  private changed(): void {
    this.cached = null
    if (this.batchDepth > 0) {
      this.pending = true
      return
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error("Error in slot tree listener:", error)
      }
    }
  }
}
