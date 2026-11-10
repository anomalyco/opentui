import { isRenderable, Renderable, type RenderableOptions } from "../../Renderable.js"
import type { RenderContext } from "../../types.js"
import util from "node:util"

export type VChild = VNode | Renderable | VChild[] | null | undefined | false

export interface PendingCall {
  method: string
  args: any[]
  isProperty?: boolean
}

const BrandedVNode: unique symbol = Symbol.for("@opentui/core/VNode")

export interface VNode<P = any, C = VChild[]> {
  [BrandedVNode]: true
  type: Construct<P>
  props?: P
  children?: C
  __delegateMap?: Record<string, string>
  __pendingCalls?: PendingCall[]
}

// Type that represents a VNode with Renderable methods available for chaining
export type ProxiedVNode<TCtor extends RenderableConstructor<any>> = VNode<
  TCtor extends RenderableConstructor<infer P> ? P : any
> & {
  [K in keyof InstanceType<TCtor>]: InstanceType<TCtor>[K] extends (...args: infer Args) => any
    ? (...args: Args) => ProxiedVNode<TCtor>
    : InstanceType<TCtor>[K]
}

export interface RenderableConstructor<P extends RenderableOptions<any> = RenderableOptions<any>> {
  new (ctx: RenderContext, options: P): Renderable
}

export type FunctionalConstruct<P = any> = (props: P, children?: VChild[]) => VNode

export type Construct<P = any> =
  | RenderableConstructor<P extends RenderableOptions<any> ? P : never>
  | FunctionalConstruct<P>

function isRenderableConstructor<P extends RenderableOptions<any> = RenderableOptions<any>>(
  value: any,
): value is RenderableConstructor<P> {
  return typeof value === "function" && value.prototype && Renderable.prototype.isPrototypeOf(value.prototype)
}

function flattenChildren(children: VChild[]): VChild[] {
  const result: VChild[] = []
  for (const child of children) {
    if (Array.isArray(child)) {
      result.push(...flattenChildren(child))
    } else if (child !== null && child !== undefined && child !== false) {
      result.push(child)
    }
  }
  return result
}

// Overloads for proper typing
export function h<TCtor extends RenderableConstructor<any>>(
  type: TCtor,
  props?: TCtor extends RenderableConstructor<infer P> ? P : never,
  ...children: VChild[]
): ProxiedVNode<TCtor>
export function h<P>(type: FunctionalConstruct<P>, props?: P, ...children: VChild[]): VNode<P>
export function h<P>(type: Construct<P>, props?: P, ...children: VChild[]): VNode<P> | ProxiedVNode<any>
export function h<P>(type: Construct<P>, props?: P, ...children: VChild[]): any {
  if (typeof type !== "function") {
    throw new TypeError("h() received an invalid vnode type")
  }

  const vnode: VNode<P> = {
    [BrandedVNode]: true,
    type,
    props,
    children: flattenChildren(children),
    __pendingCalls: [],
  }

  if (isRenderableConstructor(type)) {
    return new Proxy(vnode, {
      get(target, prop, receiver) {
        // Return VNode properties directly
        if (prop in target) {
          return Reflect.get(target, prop, receiver)
        }

        if (typeof prop === "string") {
          const prototype = type.prototype
          const hasMethod =
            prototype &&
            (typeof prototype[prop] === "function" ||
              Object.getOwnPropertyDescriptor(prototype, prop) ||
              Object.getOwnPropertyDescriptor(Object.getPrototypeOf(prototype), prop))

          if (hasMethod) {
            return (...args: any[]) => {
              target.__pendingCalls = target.__pendingCalls || []
              target.__pendingCalls.push({ method: prop, args })
              return target
            }
          }
        }

        return Reflect.get(target, prop, receiver)
      },

      set(target, prop, value, receiver) {
        if (typeof prop === "string" && isRenderableConstructor(type)) {
          const prototype = type.prototype
          const descriptor =
            Object.getOwnPropertyDescriptor(prototype, prop) ||
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(prototype), prop)

          if (descriptor && descriptor.set) {
            target.__pendingCalls = target.__pendingCalls || []
            target.__pendingCalls.push({ method: prop, args: [value], isProperty: true })
            return true
          }
        }

        return Reflect.set(target, prop, value, receiver)
      },
    })
  }

  return vnode
}

export function isVNode(node: any): node is VNode {
  return node && node[BrandedVNode]
}

export function maybeMakeRenderable(
  ctx: RenderContext,
  node: Renderable | VNode<any, any[]> | unknown,
): Renderable | null {
  if (isRenderable(node)) return node
  if (isVNode(node)) return instantiate(ctx, node)
  if (process.env.NODE_ENV !== "production") {
    console.warn("maybeMakeRenderable received an invalid node", util.inspect(node, { depth: 2 }))
  }
  return null
}

export function wrapWithDelegates<T extends InstanceType<RenderableConstructor>>(
  instance: T,
  delegateMap: Record<string, string> | undefined,
): T {
  if (!delegateMap || Object.keys(delegateMap).length === 0) return instance

  const getDescendant = (id: string): Renderable | undefined => {
    return (instance as Renderable).findDescendantById(id)
  }

  const proxy = new Proxy(instance as any, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && delegateMap[prop]) {
        const host = getDescendant(delegateMap[prop])
        if (host) {
          const value = (host as any)[prop]
          if (typeof value === "function") {
            return value.bind(host)
          }
          return value
        }
      }
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value, receiver) {
      if (typeof prop === "string" && delegateMap[prop]) {
        const host = getDescendant(delegateMap[prop])
        if (host) {
          return Reflect.set(host as any, prop, value)
        }
      }
      return Reflect.set(target, prop, value, receiver)
    },
  })
  return proxy
}

export type InstantiateFn<NodeType extends VNode | Renderable> = Renderable & { __node?: NodeType }

export function instantiate<NodeType extends VNode | Renderable>(
  ctx: RenderContext,
  node: NodeType,
): InstantiateFn<NodeType> {
  if (isRenderable(node)) return node

  if (!node || typeof node !== "object") {
    throw new TypeError("mount() received an invalid vnode")
  }

  const vnode = node as VNode
  const { type, props } = vnode
  const children = flattenChildren(vnode.children || [])
  const delegateMap = (vnode as any).__delegateMap as Record<string, string> | undefined

  if (isRenderableConstructor(type)) {
    const instance = new type(ctx, (props || {}) as any)

    for (const child of children) {
      if (isRenderable(child)) {
        instance.add(child)
      } else {
        const mounted = instantiate(ctx, child as NodeType)
        instance.add(mounted)
      }
    }

    const delegatedInstance = wrapWithDelegates(instance, delegateMap)

    const pendingCalls = (vnode as any).__pendingCalls as PendingCall[] | undefined
    if (pendingCalls) {
      for (const call of pendingCalls) {
        if (call.isProperty) {
          ;(delegatedInstance as any)[call.method] = call.args[0]
        } else {
          ;(delegatedInstance as any)[call.method].apply(delegatedInstance, call.args)
        }
      }
    }

    return delegatedInstance
  }

  // Functional construct: resolve to a concrete vnode and mount it
  const resolved = (type as FunctionalConstruct)(props || ({} as any), children)
  const inst = instantiate(ctx, resolved)

  return wrapWithDelegates(inst, delegateMap) as InstantiateFn<NodeType>
}

export type DelegateMap<T> = Partial<Record<keyof T, string>>

export type ValidateShape<Given, AllowedKeys> = {
  [K in keyof Given]: K extends keyof AllowedKeys ? NonNullable<Given[K]> : never
}

type InferNode<T> = T extends InstantiateFn<infer U> ? U : never

export function delegate<
  Factory extends InstantiateFn<any>,
  InnerNode extends InferNode<Factory>,
  TargetMap extends Record<keyof InnerNode, string>,
  const Mapping extends Partial<TargetMap>,
>(mapping: ValidateShape<Mapping, TargetMap>, vnode: Factory): Renderable

export function delegate<
  ConstructorType extends RenderableConstructor<any>,
  TargetMap extends Record<keyof InstanceType<ConstructorType>, string>,
  const Mapping extends Partial<TargetMap>,
>(mapping: ValidateShape<Mapping, TargetMap>, vnode: ProxiedVNode<ConstructorType>): ProxiedVNode<ConstructorType>

export function delegate<
  ConstructorType extends RenderableConstructor<any>,
  const Mapping extends DelegateMap<InstanceType<ConstructorType>>,
>(mapping: ValidateShape<Mapping, string>, vnode: VNode & { type: ConstructorType }): VNode

/**
 * Controlled delegation that routes selected properties/methods
 * to a descendant renderable identified by ID.
 */
export function delegate<NodeType extends VNode | Renderable | InstantiateFn<any>>(
  mapping: Record<string, string>,
  vnode: NodeType,
): VNode | Renderable {
  if (isRenderable(vnode)) {
    return wrapWithDelegates(vnode, mapping)
  }
  if (!vnode || typeof vnode !== "object") return vnode
  vnode.__delegateMap = { ...(vnode.__delegateMap || {}), ...mapping }
  return vnode
}
