// A React slot over core's hierarchical slot tree (`SlotTree`). The registry-based `Slot` in `slot.tsx` is separate.
import type { ResolvedSlotClaim, SlotPlaced, SlotTree, SlotTreeErrorEvent } from "@opentui/core"
import React, { createContext, Fragment, useContext, useLayoutEffect, useState } from "react"
import type { ReactNode } from "react"

type Tree = SlotTree<ReactNode, any>
type Entry = ResolvedSlotClaim<ReactNode, any>

/** A slot map whose inputs are objects, as in the Solid slot. */
type TreeSlots<TSlots> = { [Path in keyof TSlots]: object }

/** `input` is required exactly when the path's input type has a required field. */
type InputProp<T> = {} extends T ? { input?: T } : { input: T }

export type TreeSlotProps<TSlots extends TreeSlots<TSlots>, Path extends keyof TSlots> = {
  path: Path
  children?: ReactNode
} & InputProp<TSlots[Path]>

export interface TreeSlotOptions<TSlots extends TreeSlots<TSlots> = any> {
  /** Renders in place of a claim that failed. */
  placeholder?: (failure: SlotTreeErrorEvent<ReactNode, TSlots>) => ReactNode
}

type BoundaryProps = { tree: Tree; entry: Entry; path: string; input: object; options: TreeSlotOptions }

function ClaimView(props: { entry: Entry; input: object }): ReactNode {
  return props.entry.claim.render(props.input)
}

// One claim's boundary: a claim that throws renders its placeholder, and the rest stay. The placeholder is made once,
// when the boundary catches, so a placeholder that throws is reported once.
class ClaimBoundary extends React.Component<BoundaryProps, { failed: { node: ReactNode } | null }> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { failed: null }
  }

  override componentDidCatch(error: Error): void {
    const { tree, entry, path, options } = this.props
    const failure = tree.reportError(entry, path, error)
    let node: ReactNode = null
    try {
      node = options.placeholder?.(failure)
    } catch (error) {
      tree.reportError(entry, path, error, "placeholder")
    }
    this.setState({ failed: { node } })
  }

  override render(): ReactNode {
    const { failed } = this.state
    return failed ? failed.node : <ClaimView entry={this.props.entry} input={this.props.input} />
  }
}

// A key per claim object, so a claim keeps its instance while others come, go or move.
const claimKeys = new WeakMap<Entry, number>()
let nextClaimKey = 0
function claimKey(entry: Entry): number {
  let key = claimKeys.get(entry)
  if (key === undefined) claimKeys.set(entry, (key = nextClaimKey++))
  return key
}

const UNMOUNTED: SlotPlaced<Entry> = { before: [], prepend: [], append: [], after: [] }

// The nearest enclosing slot, which a nested slot's path must extend.
const SlotParent = createContext<{ tree: Tree; path: string } | undefined>(undefined)

/**
 * A `<Slot path input>` component for `tree`. It renders `before`, then the `replace` claim or `prepend`, the
 * children and `append`, then `after`. Each claim mounts in its own error boundary and keeps its mount while it shows
 * here. A claim on a slot that another claim renders shows degraded here until that slot mounts, in the same commit:
 * it mounts twice, and nothing draws in between.
 */
export function createTreeSlot<TSlots extends TreeSlots<TSlots>>(
  tree: SlotTree<ReactNode, TSlots>,
  options: TreeSlotOptions<TSlots> = {},
): <Path extends keyof TSlots>(props: TreeSlotProps<TSlots, Path>) => ReactNode {
  return function TreeSlot(props) {
    const path = String(props.path)
    const parent = useContext(SlotParent)
    const within = parent?.tree === tree ? parent.path : undefined
    const [, setVersion] = useState(0)
    const [mounted, setMounted] = useState<string | null>(null)

    useLayoutEffect(() => tree.subscribe(() => setVersion((current) => current + 1)), [])
    useLayoutEffect(() => {
      const release = tree.mount(path as keyof TSlots & string, { within: within as keyof TSlots & string })
      setMounted(path)
      return release
    }, [path, within])

    // A path mounts in a layout effect. Until then the slot renders only its children, so a nested slot mounts in
    // the same commit and its claims never show here degraded.
    const placed = mounted === path ? tree.placed(path as keyof TSlots & string) : UNMOUNTED
    const input = (props as { input?: object }).input ?? {}
    const view = (entry: Entry) => (
      <ClaimBoundary key={claimKey(entry)} tree={tree} entry={entry} path={path} input={input} options={options} />
    )
    const body = placed.replace
      ? view(placed.replace)
      : [...placed.prepend.map(view), <Fragment key="children">{props.children}</Fragment>, ...placed.append.map(view)]

    return (
      <>
        {placed.before.map(view)}
        <SlotParent.Provider value={{ tree, path }}>{body}</SlotParent.Provider>
        {placed.after.map(view)}
      </>
    )
  }
}
