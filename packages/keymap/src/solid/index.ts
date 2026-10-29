import type { KeyEvent, Renderable } from "@opentui/core"
import { type Keymap, type Layer, type ReactiveMatcher, type TargetMode } from "../index.js"
import { createLayerSlot } from "../services/extension-context.js"
import {
  createComponent,
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  on,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js"

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>

const KeymapContext = createContext<OpenTuiKeymap>()

export interface KeymapProviderProps {
  keymap: OpenTuiKeymap
  children: JSX.Element
}

export function KeymapProvider(props: KeymapProviderProps): JSX.Element {
  return createComponent(KeymapContext.Provider, {
    get value() {
      return props.keymap
    },
    get children() {
      return props.children
    },
  })
}

export type UseBindingsTarget<TRenderable extends Renderable = Renderable> = () => TRenderable | null | undefined

export interface UseBindingsLayer<TRenderable extends Renderable = Renderable> extends Omit<
  Layer<Renderable, KeyEvent>,
  "target" | "targetMode"
> {
  target?: UseBindingsTarget<TRenderable>
  targetMode?: TargetMode
}

function resolveBindingsTarget(target: UseBindingsTarget | undefined): Renderable | undefined {
  return target?.() ?? undefined
}

export const useKeymap = (): OpenTuiKeymap => {
  const keymap = useContext(KeymapContext)

  if (!keymap) {
    throw new Error("Keymap not found. Wrap the tree in <KeymapProvider>.")
  }

  return keymap
}

function useKeymapStateVersion(keymap: OpenTuiKeymap): Accessor<number> {
  const [version, setVersion] = createSignal(0)
  let dispose: (() => void) | undefined

  onMount(() => {
    dispose = keymap.on("state", () => {
      setVersion((value) => value + 1)
    })

    setVersion((value) => value + 1)
  })

  onCleanup(() => {
    dispose?.()
  })

  return version
}

/**
 * Reactively derives any view from the current keymap by re-running `selector`
 * on each batched keymap state change.
 */
export const useKeymapSelector = <T>(selector: (keymap: OpenTuiKeymap) => T): Accessor<T> => {
  const keymap = useKeymap()
  const version = useKeymapStateVersion(keymap)

  return createMemo((previous) => {
    version()
    try {
      return selector(keymap)
    } catch (error) {
      if (
        previous !== undefined &&
        error instanceof Error &&
        error.message === "Cannot use a keymap after its host was destroyed"
      ) {
        return previous
      }

      throw error
    }
  })
}

export function useBindings<TRenderable extends Renderable = Renderable>(
  createLayer: () => UseBindingsLayer<TRenderable>,
): void {
  const replaceLayer = createLayerSlot(useKeymap())

  onCleanup(() => replaceLayer(undefined))

  createEffect(() => {
    const layer = createLayer()
    const hasExplicitTarget = layer.target !== undefined
    const explicitTarget = resolveBindingsTarget(layer.target)
    const nextTargetMode: TargetMode | undefined = layer.targetMode ?? (hasExplicitTarget ? "focus-within" : undefined)

    const { target: _target, targetMode: _targetMode, ...baseLayer } = layer
    if (!nextTargetMode) {
      replaceLayer(baseLayer)
      return
    }

    if (!hasExplicitTarget) {
      throw new Error("useBindings local bindings need a target accessor")
    }

    replaceLayer(explicitTarget && { ...baseLayer, target: explicitTarget, targetMode: nextTargetMode })
  })
}

/**
 * Adapts a Solid accessor to `ReactiveMatcher`. The subscription
 * lives in a disposable reactive root so unregistering the layer tears it
 * down. Pass `predicate` when the accessor value is not already boolean.
 */
export function reactiveMatcherFromSignal<T>(
  accessor: Accessor<T>,
  predicate?: (value: T) => boolean,
): ReactiveMatcher {
  return {
    get() {
      return predicate ? predicate(accessor()) : Boolean(accessor())
    },
    subscribe(onChange) {
      return createRoot((dispose) => {
        createEffect(on(accessor, () => onChange(), { defer: true }))
        return dispose
      })
    },
  }
}
