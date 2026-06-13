import { createEffect, createMemo, getOwner, onCleanup, runWithOwner, splitProps, untrack } from "solid-js"
import { createSlotNode, createElement, insert, spread, type DomNode } from "../reconciler.js"
import type { JSX } from "../../jsx-runtime.js"
import type { ValidComponent, ComponentProps } from "solid-js"
import { useRenderer } from "./hooks.js"

/**
 * Renders components somewhere else in the DOM
 *
 * Useful for inserting modals and tooltips outside of an cropping layout. If no mount point is given, the portal is inserted on the root renderable; it is wrapped in a `<box>`
 *
 * @description https://docs.solidjs.com/reference/components/portal
 */
export function Portal(props: { mount?: DomNode; ref?: (el: {}) => void; children: JSX.Element }): JSX.Element {
  const renderer = useRenderer()

  const marker = createSlotNode(),
    mount = () => props.mount || renderer.root,
    owner = getOwner()
  let content: undefined | (() => JSX.Element)

  createEffect(
    () => {
      // basically we backdoor into a sort of renderEffect here
      content || (content = runWithOwner(owner, () => createMemo(() => props.children)))
      const el = mount()
      const container = createElement("box"),
        renderRoot = container

      Object.defineProperty(container, "_$host", {
        get() {
          return marker.parent
        },
        configurable: true,
      })
      insert(renderRoot, content)
      el.add(container)
      props.ref && (props as any).ref(container)
      onCleanup(() => el.remove(container.id))
    },
    undefined,
    { render: true },
  )
  // The reconciler consumes this marker as the runtime representation of the portal JSX node.
  return marker as unknown as JSX.Element
}

export type DynamicProps<T extends ValidComponent, P = ComponentProps<T>> = {
  [K in keyof P]: P[K]
} & {
  component: T | undefined
}

/**
 * Renders an arbitrary component or element with the given props
 *
 * This is a lower level version of the `Dynamic` component, useful for
 * performance optimizations in libraries. Do not use this unless you know
 * what you are doing.
 * ```typescript
 * const element = () => multiline() ? 'textarea' : 'input';
 * createDynamic(element, { value: value() });
 * ```
 * @description https://docs.solidjs.com/reference/components/dynamic
 */
export function createDynamic<T extends ValidComponent>(
  component: () => T | undefined,
  props: ComponentProps<T>,
): JSX.Element {
  const cached = createMemo<Function | string | undefined>(component)
  return createMemo(() => {
    const component = cached()
    switch (typeof component) {
      case "function":
        // if (isDev) Object.assign(component, { [$DEVCOMP]: true })
        return untrack(() => component(props))

      case "string":
        const el = createElement(component)
        spread(el, props)
        return el

      default:
        break
    }
  }) as unknown as JSX.Element
}

/**
 * Renders an arbitrary custom or native component and passes the other props
 * ```typescript
 * <Dynamic component={multiline() ? 'textarea' : 'input'} value={value()} />
 * ```
 * @description https://docs.solidjs.com/reference/components/dynamic
 */
export function Dynamic<T extends ValidComponent>(props: DynamicProps<T>): JSX.Element {
  const [, others] = splitProps(props, ["component"])
  return createDynamic(() => props.component, others as ComponentProps<T>)
}
