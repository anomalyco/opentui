import type { KeyEvent, Renderable } from "@opentui/core"
import {
  type ActiveKey,
  type ActiveKeyOptions,
  type Layer,
  type Keymap,
  type ReactiveMatcher,
  type KeySequencePart,
  type TargetMode,
} from "../index.js"
import { createLayerSlot } from "../services/extension-context.js"
import {
  createElement,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type DependencyList,
  type ReactNode,
} from "react"

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>

const KeymapContext = createContext<OpenTuiKeymap | null>(null)

export interface KeymapProviderProps {
  keymap: OpenTuiKeymap
  children?: ReactNode
}

export function KeymapProvider({ keymap, children }: KeymapProviderProps) {
  return createElement(KeymapContext.Provider, { value: keymap }, children)
}

export interface UseBindingsTargetRef<TRenderable extends Renderable = Renderable> {
  current: TRenderable | null
}

export interface UseBindingsLayer<TRenderable extends Renderable = Renderable> extends Omit<
  Layer<Renderable, KeyEvent>,
  "target" | "targetMode"
> {
  targetRef?: UseBindingsTargetRef<TRenderable>
  targetMode?: TargetMode
}

function resolveBindingsTarget(targetRef: UseBindingsTargetRef | undefined): Renderable | undefined {
  return targetRef?.current ?? undefined
}

export const useKeymap = (): OpenTuiKeymap => {
  const keymap = useContext(KeymapContext)

  if (!keymap) {
    throw new Error("Keymap not found. Wrap the tree in <KeymapProvider>.")
  }

  return keymap
}

// Use the batched `state` event for derived reads. Pending-sequence changes
// already flow through `state`, so subscribing to both would duplicate work.
function useKeymapStateVersion(keymap: OpenTuiKeymap): number {
  const [version, bumpVersion] = useReducer((value: number) => value + 1, 0)

  useLayoutEffect(() => {
    const dispose = keymap.on("state", () => {
      bumpVersion()
    })

    return () => {
      dispose()
    }
  }, [keymap])

  return version
}

export const useActiveKeys = (options?: ActiveKeyOptions): readonly ActiveKey[] => {
  const keymap = useKeymap()
  const version = useKeymapStateVersion(keymap)

  return useMemo(() => {
    void version
    return keymap.getActiveKeys(options)
  }, [keymap, options, version])
}

export const usePendingSequence = (): readonly KeySequencePart[] => {
  const keymap = useKeymap()
  const version = useKeymapStateVersion(keymap)

  return useMemo(() => {
    void version
    return keymap.getPendingSequence()
  }, [keymap, version])
}

export function useBindings<TRenderable extends Renderable = Renderable>(
  createLayer: () => UseBindingsLayer<TRenderable>,
  deps: DependencyList = [],
): void {
  const keymap = useKeymap()
  const layer = useMemo(createLayer, deps)
  const replaceLayer = useMemo(() => createLayerSlot(keymap), [keymap])
  const registeredRef = useRef<{ layer: typeof layer; targetMode?: TargetMode; target?: Renderable } | undefined>(
    undefined,
  )

  useEffect(() => {
    return () => {
      replaceLayer(undefined)
      registeredRef.current = undefined
    }
  }, [replaceLayer])

  useEffect(() => {
    const hasExplicitTarget = layer.targetRef !== undefined
    const explicitTarget = resolveBindingsTarget(layer.targetRef)
    const targetMode = layer.targetMode ?? (hasExplicitTarget ? "focus-within" : undefined)
    const target = targetMode ? explicitTarget : undefined

    if (!hasExplicitTarget && targetMode) {
      throw new Error("useBindings local bindings need a targetRef")
    }

    const registered = registeredRef.current
    if (registered?.layer === layer && registered.targetMode === targetMode && registered.target === target) {
      return
    }

    registeredRef.current = { layer, targetMode, target }
    const { targetRef: _targetRef, targetMode: _targetMode, ...baseLayer } = layer
    replaceLayer(targetMode ? target && { ...baseLayer, target, targetMode } : baseLayer)
  })
}

/**
 * Adapts any `subscribe` + `getSnapshot` store to
 * `ReactiveMatcher`. Pass `predicate` when the snapshot value is not
 * already boolean.
 */
export function reactiveMatcherFromStore<T>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  predicate?: (value: T) => boolean,
): ReactiveMatcher {
  return {
    get() {
      return predicate ? predicate(getSnapshot()) : Boolean(getSnapshot())
    },
    subscribe(onChange) {
      return subscribe(onChange)
    },
  }
}
