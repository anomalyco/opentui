import { ImageRenderable, TextNodeRenderable, TextRenderable, type Renderable } from "@opentui/core"
import pkgJson from "../../package.json" with { type: "json" }
import { createContext } from "react"
import type { HostConfig, ReactContext } from "react-reconciler"
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants.js"
import { getComponentCatalogue } from "../components/index.js"
import { textNodeKeys, type TextNodeKey } from "../components/text.js"
import type { Container, HostContext, Instance, Props, PublicInstance, TextInstance, Type } from "../types/host.js"
import { getNextId } from "../utils/id.js"
import { setInitialProperties, updateProperties } from "../utils/index.js"

let currentUpdatePriority = NoEventPriority

function initialInstanceProps(type: Type, props: Props): Props {
  if (type !== "image" || props.source === undefined) return props
  return { ...props, source: undefined }
}

// Required by the reconciler at runtime but missing from @types/react-reconciler.
// Remove this intersection when DefinitelyTyped catches up.
type ReconcilerExtensions = {
  maySuspendCommitOnUpdate(type: Type, oldProps: Props, newProps: Props): boolean
  maySuspendCommitInSyncRender(type: Type, props: Props): boolean
  rendererPackageName: string
  rendererVersion: string
}

// https://github.com/facebook/react/tree/main/packages/react-reconciler#practical-examples
export const hostConfig: HostConfig<
  Type,
  Props,
  Container,
  Instance,
  TextInstance,
  unknown, // SuspenseInstance
  unknown, // HydratableInstance
  unknown, // FormInstance
  PublicInstance,
  HostContext,
  unknown, // ChildSet
  unknown, // TimeoutHandle
  unknown, // NoTimeout
  unknown // TransitionStatus
> &
  ReconcilerExtensions = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,

  // Create instances of opentui components
  createInstance(type: Type, props: Props, rootContainerInstance: Container, hostContext: HostContext) {
    if (textNodeKeys.includes(type as TextNodeKey) && !hostContext.isInsideText) {
      throw new Error(`Component of type "${type}" must be created inside of a text node`)
    }

    const id = getNextId(type)
    const components = getComponentCatalogue()

    if (!components[type]) {
      throw new Error(`Unknown component type: ${type}`)
    }

    return new components[type](rootContainerInstance.ctx, {
      id,
      ...initialInstanceProps(type, props),
    })
  },

  // Append a child to a parent
  appendChild(parent: Instance, child: Instance) {
    parent.add(child)
  },

  // Remove a child from a parent. During coordinated teardown (for example
  // renderer.destroy() triggering root.unmount() via onDestroy) the renderable
  // tree may already be destroyed when React commits its deletion effects, so
  // an already-detached child is expected and must not be re-removed.
  removeChild(parent: Instance, child: Instance) {
    if (!child.parent) return
    parent.remove(child)
  },

  // Insert a child before another child
  insertBefore(parent: Instance, child: Instance, beforeChild: Instance) {
    parent.insertBefore(child, beforeChild)
  },

  // Insert a child at a specific index
  insertInContainerBefore(parent: Container, child: Instance, beforeChild: Instance) {
    parent.insertBefore(child, beforeChild)
  },

  // Remove a child from container. Skips children that were already detached
  // by renderer teardown; see removeChild.
  removeChildFromContainer(parent: Container, child: Instance) {
    if (!child.parent) return
    parent.remove(child)
  },

  // Prepare for commit
  prepareForCommit(containerInfo: Container) {
    return null
  },

  // Reset after commit
  resetAfterCommit(containerInfo: Container) {
    // Trigger a render update if needed
    containerInfo.requestRender()
  },

  // Get root container
  getRootHostContext(rootContainerInstance: Container) {
    return { isInsideText: false }
  },

  // Get child context
  getChildHostContext(parentHostContext: HostContext, type: Type, rootContainerInstance: Container) {
    const isInsideText = ["text", ...textNodeKeys].includes(type)
    return { ...parentHostContext, isInsideText }
  },

  // Should set text content
  shouldSetTextContent(type: Type, props: Props) {
    return false
  },

  // Create text instance
  createTextInstance(text: string, rootContainerInstance: Container, hostContext: HostContext) {
    if (!hostContext.isInsideText) {
      throw new Error("Text must be created inside of a text node")
    }

    return TextNodeRenderable.fromString(text)
  },

  // Schedule timeout
  scheduleTimeout: setTimeout,

  // Cancel timeout
  cancelTimeout: clearTimeout,

  // No timeout
  noTimeout: -1,

  shouldAttemptEagerTransition() {
    return true
  },

  // Finalize initial children
  finalizeInitialChildren(
    instance: Instance,
    type: Type,
    props: Props,
    rootContainerInstance: Container,
    hostContext: HostContext,
  ) {
    setInitialProperties(instance, type, initialInstanceProps(type, props))
    return type === "image" && props.source !== undefined
  },

  // Commit mount
  commitMount(instance: Instance, type: Type, props: Props, internalInstanceHandle: any) {
    if (instance instanceof ImageRenderable) instance.source = props.source
    // We could focus the instance here, but we're handling focus in setInitialProperties
  },

  // No explicit requestRender() needed in commit methods — core's property setters
  // already call requestRender() internally, and resetAfterCommit handles the frame trigger.
  commitUpdate(instance: Instance, type: Type, oldProps: Props, newProps: Props, internalInstanceHandle: any) {
    updateProperties(instance, type, oldProps, newProps)
  },

  commitTextUpdate(textInstance: TextInstance, oldText: string, newText: string) {
    textInstance.children = [newText]
  },

  // Append child to container
  appendChildToContainer(container: Container, child: Instance) {
    container.add(child)
  },

  appendInitialChild(parent: Instance, child: Instance) {
    parent.add(child)
  },

  // Visibility setters in core call requestRender() internally.
  hideInstance(instance: Instance) {
    instance.visible = false
  },

  unhideInstance(instance: Instance, props: Props) {
    instance.visible = true
  },

  hideTextInstance(textInstance: TextInstance) {
    textInstance.visible = false
  },

  unhideTextInstance(textInstance: TextInstance, text: string) {
    textInstance.visible = true
  },

  // Clear container
  clearContainer(container: Container) {
    // Remove all children
    const children = container.getChildren()
    children.forEach((child) => container.remove(child))
  },

  // Misc
  setCurrentUpdatePriority(newPriority: number) {
    currentUpdatePriority = newPriority
  },

  getCurrentUpdatePriority: () => currentUpdatePriority,

  resolveUpdatePriority() {
    if (currentUpdatePriority !== NoEventPriority) {
      return currentUpdatePriority
    }

    return DefaultEventPriority
  },

  maySuspendCommit() {
    return false
  },

  maySuspendCommitOnUpdate() {
    return false
  },

  maySuspendCommitInSyncRender() {
    return false
  },

  NotPendingTransition: null,

  HostTransitionContext: createContext(null) as unknown as ReactContext<null>,

  resetFormInstance() {},

  requestPostPaintCallback() {},

  trackSchedulerEvent() {},

  resolveEventType() {
    return null
  },

  resolveEventTimeStamp() {
    return -1.1
  },

  preloadInstance() {
    return true
  },

  startSuspendingCommit() {},

  suspendInstance() {},

  waitForCommitToBeReady() {
    return null
  },

  detachDeletedInstance(instance: Instance) {
    if (!instance.parent) {
      instance.destroyRecursively()
    }
  },

  getPublicInstance(instance: Renderable | TextRenderable) {
    return instance
  },

  preparePortalMount(containerInfo: Container) {},

  isPrimaryRenderer: true,

  getInstanceFromNode() {
    return null
  },

  beforeActiveInstanceBlur() {},

  afterActiveInstanceBlur() {},

  prepareScopeUpdate() {},

  getInstanceFromScope() {
    return null
  },

  rendererPackageName: "@opentui/react",
  rendererVersion: pkgJson.version,
}
