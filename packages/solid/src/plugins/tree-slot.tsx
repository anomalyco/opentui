// A Solid slot over core's hierarchical slot tree (`SlotTree`). The registry-based `Slot` in `slot.tsx` is separate.
import {
  isRenderable,
  isTextNodeRenderable,
  type ResolvedSlotClaim,
  type SlotPlaced,
  type SlotTree,
  type SlotTreeErrorEvent,
} from "@opentui/core"
import {
  children,
  createComponent,
  createContext,
  createMemo,
  createSignal,
  ErrorBoundary,
  mapArray,
  mergeProps,
  onCleanup,
  Show,
  useContext,
  type JSX,
} from "solid-js"

type Tree = SlotTree<JSX.Element, any>
type Entry = ResolvedSlotClaim<JSX.Element, any>

/** A slot map whose inputs are objects, so a claim's input reads the slot's current one. */
type TreeSlots<TSlots> = { [Path in keyof TSlots]: object }

/** `input` is required exactly when the path's input type has a required field. */
type InputProp<T> = {} extends T ? { input?: T } : { input: T }

export type TreeSlotProps<TSlots extends TreeSlots<TSlots>, Path extends keyof TSlots> = {
  path: Path
  children?: JSX.Element
} & InputProp<TSlots[Path]>

export interface TreeSlotOptions<TSlots extends TreeSlots<TSlots> = any> {
  /** Renders in place of a claim that failed. */
  placeholder?: (failure: SlotTreeErrorEvent<JSX.Element, TSlots>) => JSX.Element
}

// The nearest enclosing slot, which a nested slot's path must extend.
const SlotParent = createContext<{ tree: Tree; path: string }>()

/**
 * A `<Slot path input>` component for `tree`. It renders `before`, then the `replace` claim or `prepend`, the
 * children and `append`, then `after`. Each claim mounts once, in its own error boundary, and reads the slot's
 * current input, which is an object for that reason.
 *
 * A Solid tree slot is a layout slot: Solid gives a component no view of its host parent, so a claim must render
 * renderables, with any text inside its own `<text>`. Do not place one inside `<text>`: a text claim there fails into
 * its placeholder, and a renderable claim throws as the host inserts it, outside the claim's boundary. React's slot
 * has no such limit.
 */
export function createTreeSlot<TSlots extends TreeSlots<TSlots>>(
  tree: SlotTree<JSX.Element, TSlots>,
  options: TreeSlotOptions<TSlots> = {},
): <Path extends keyof TSlots>(props: TreeSlotProps<TSlots, Path>) => JSX.Element {
  return (props) => {
    const path = () => String(props.path)
    // A new path is a new mount.
    return (
      <Show keyed when={path()}>
        {(path: string) => <MountedSlot tree={tree} path={path} slot={props as MountedProps} options={options} />}
      </Show>
    )
  }
}

type MountedProps = { children?: JSX.Element; input?: object }

function MountedSlot(props: { tree: Tree; path: string; slot: MountedProps; options: TreeSlotOptions }): JSX.Element {
  const { tree, path, options } = props
  const parent = useContext(SlotParent)
  onCleanup(tree.mount(path, { within: parent?.tree === tree ? parent.path : undefined }))
  const [version, setVersion] = createSignal(0)
  // A claim that mounts a nested slot changes this slot's claims while it maps them; Solid would map again inside
  // that map and mount claims twice. The change waits until the map ends.
  let mapping = 0
  let missed = false
  const bump = () => setVersion((current) => current + 1)
  onCleanup(tree.subscribe(() => (mapping > 0 ? (missed = true) : bump())))
  const placed = createMemo(
    () => {
      version()
      return tree.placed(path)
    },
    undefined,
    { equals: samePlaced },
  )
  const input = mergeProps(() => props.slot.input ?? {})

  const placeholder = (entry: Entry, error: unknown): JSX.Element => {
    const failure = tree.reportError(entry, path, error)
    if (!options.placeholder) return null
    try {
      return options.placeholder(failure)
    } catch (error) {
      tree.reportError(entry, path, error, "placeholder")
      return null
    }
  }

  // Each claim mounts once, untracked, so a claim's own state lives as long as the claim does.
  const contribution = (entry: Entry): JSX.Element => (
    <ErrorBoundary fallback={(error: unknown) => placeholder(entry, error)}>
      {checked(createComponent((input: object) => entry.claim.render(input), input))}
    </ErrorBoundary>
  )
  const mount = (select: (placed: SlotPlaced<Entry>) => readonly Entry[]) => {
    // While a change waits, a claim the tree no longer places here leaves this list at the change: it never mounts.
    const mapped = mapArray(
      () => select(placed()),
      (entry) => children(() => (missed && !select(tree.placed(path)).includes(entry) ? null : contribution(entry))),
    )
    return createMemo(() => {
      mapping += 1
      try {
        return mapped().flatMap((resolved) => resolved.toArray())
      } finally {
        mapping -= 1
        if (mapping === 0 && missed) {
          missed = false
          bump()
        }
      }
    })
  }

  const before = mount((placed) => placed.before)
  const after = mount((placed) => placed.after)
  // Called inside the provider, as `inside` is: a slot that a claim there mounts must extend this one.
  const body = () => {
    const replaced = mount((placed) => (placed.replace ? [placed.replace] : []))
    return (
      <Show when={placed().replace} fallback={inside()}>
        {replaced()}
      </Show>
    )
  }
  const inside = () => {
    // The children first: a nested slot mounts its path there, so its claims never land here degraded.
    const own = children(() => props.slot.children)
    const prepend = mount((placed) => placed.prepend)
    const append = mount((placed) => placed.append)
    return (
      <>
        {prepend()}
        {own()}
        {append()}
      </>
    )
  }

  return (
    <>
      {before()}
      <SlotParent.Provider value={{ tree, path }}>{body()}</SlotParent.Provider>
      {after()}
    </>
  )
}

// Only renderables mount, and text only under <text>. The host would throw on the rest while it inserts them,
// outside the claim's boundary, and take the app down; checked here, the failure stays the claim's own. The memo is
// the child, as Solid's own `Show` returns its memo, so a new output does not mount the claim again.
function checked(output: JSX.Element): JSX.Element {
  const resolved = children(() => output)
  return createMemo(() => {
    const nodes = resolved.toArray()
    for (const node of nodes) {
      if (node === null || node === undefined || typeof node === "boolean") continue
      if (typeof node === "string" || typeof node === "number") {
        const text = Array.from(String(node))
        const quote = text.length > 40 ? `${text.slice(0, 40).join("")}…` : text.join("")
        throw new Error(`A slot claim rendered bare text "${quote}"; wrap it in <text>`)
      }
      if (isTextNodeRenderable(node))
        throw new Error("A slot claim rendered a text node outside <text>; wrap it in <text>")
      if (!isRenderable(node)) throw new Error(`A slot claim rendered ${String(node)}, which is not a renderable`)
    }
    return nodes
  }) as unknown as JSX.Element
}

function samePlaced(a: SlotPlaced<Entry>, b: SlotPlaced<Entry>): boolean {
  const same = (x: readonly Entry[], y: readonly Entry[]) =>
    x.length === y.length && x.every((item, i) => item === y[i])
  return (
    a.replace === b.replace &&
    same(a.before, b.before) &&
    same(a.prepend, b.prepend) &&
    same(a.append, b.append) &&
    same(a.after, b.after)
  )
}
