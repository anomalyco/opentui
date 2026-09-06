import { expect, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { getYogaNode } from "../lib/renderable-layout.js"
import { h } from "../renderables/composition/vnode.js"
import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import Yoga, { YogaError, YogaStatus } from "../yoga.js"
import { FFIRenderLib, NativeStatus } from "../zig.js"

test("nested callback failures preserve thrown undefined and remain isolated by owner", () => {
  const lib = new FFIRenderLib()
  const other = new FFIRenderLib()
  const host = lib.getYogaHost()
  let continued = false
  try {
    host.invokeCallback(() => {
      host.invokeCallback(() => {
        throw undefined
      })
      host.throwCallbackError()
      continued = true
      throw new Error("later failure")
    })
    expect(continued).toBe(true)
    other.getYogaHost().throwCallbackError()
    assert.throws(
      () => host.throwCallbackError(),
      (error) => error === undefined,
    )
    host.throwCallbackError()
    host.assertMutable()
  } finally {
    lib.dispose()
    other.dispose()
  }
})

test("default config replacement does not alias an explicit config at the reused address", () => {
  const lib = new FFIRenderLib()
  let release: ReturnType<typeof spyOn> | undefined
  let allocate: ReturnType<typeof spyOn> | undefined
  try {
    const host = lib.getYogaHost()
    const original = host.getDefaultConfig()
    // Hold the allocation so address reuse is deterministic without a fake native pointer.
    release = spyOn(lib, "yogaConfigFree")
    allocate = spyOn(lib, "yogaConfigCreate")
    release.mockImplementation(() => {})
    allocate.mockImplementation(() => {
      allocate!.mockRestore()
      return original.ptr
    })
    original.free()
    const explicit = Yoga.Config.create(lib)
    expect(explicit.ptr).toBe(original.ptr)
    const replacement = host.getDefaultConfig()
    replacement.assertAlive()
    expect(replacement.ptr).not.toBe(explicit.ptr)
  } finally {
    allocate?.mockRestore()
    release?.mockRestore()
    lib.dispose()
  }
})

test.each(["allocation", "installation"])("callback %s failure releases partial acquisitions", (step) => {
  const lib = new FFIRenderLib()
  let pointer: ReturnType<FFIRenderLib["yogaConfigCreate"]> | undefined
  let config: ReturnType<typeof Yoga.Config.fromBorrowedPointer> | undefined
  const mocks: ReturnType<typeof spyOn>[] = []
  const closed: ReturnType<typeof spyOn>[] = []
  try {
    pointer = lib.yogaConfigCreate()
    config = Yoga.Config.fromBorrowedPointer(pointer, lib)
    const createMeasure = lib.createYogaMeasureCallback.bind(lib)
    const createDirtied = lib.createYogaDirtiedCallback.bind(lib)
    const clearCallbacks = lib.yogaConfigClearCallbacks.bind(lib)
    const measure = spyOn(lib, "createYogaMeasureCallback")
    mocks.push(measure)
    measure.mockImplementation((callback) => {
      const handle = createMeasure(callback)
      closed.push(spyOn(handle, "close"))
      return handle
    })
    const dirtied = spyOn(lib, "createYogaDirtiedCallback")
    mocks.push(dirtied)
    dirtied.mockImplementation((callback) => {
      if (step === "allocation" && closed.length === 1) throw new Error("allocation failed")
      const handle = createDirtied(callback)
      closed.push(spyOn(handle, "close"))
      return handle
    })
    const install = spyOn(lib, "yogaConfigSetCallbacks")
    mocks.push(install)
    if (step === "installation") install.mockImplementation(() => false)
    const clear = spyOn(lib, "yogaConfigClearCallbacks")
    mocks.push(clear)
    clear.mockImplementation((...args) => {
      expect(closed.at(-1)).not.toHaveBeenCalled()
      expect(closed.at(-2)).not.toHaveBeenCalled()
      return clearCallbacks(...args)
    })
    expect(() => config!.ensureCallbacks()).toThrow(step === "allocation" ? "allocation failed" : "owned by another")
    for (const close of closed) expect(close).toHaveBeenCalledTimes(1)
    install.mockRestore()
    config.ensureCallbacks()
    config.ensureCallbacks()
    expect(measure).toHaveBeenCalledTimes(2)
    config.free()
    expect(clear).toHaveBeenCalledTimes(1)
    for (const close of closed) expect(close).toHaveBeenCalledTimes(1)
  } finally {
    for (const mock of mocks) mock.mockRestore()
    config?.free()
    for (const close of closed) close.mockRestore()
    if (pointer !== undefined) lib.yogaConfigFree(pointer)
    lib.dispose()
  }
})

test("checked Yoga reports native and callback failures together and consumes both", () => {
  const lib = new FFIRenderLib()
  const config = Yoga.Config.create(lib)
  const node = Yoga.Node.create(config)
  const failure = new Error("measure failed")
  node.setMeasureFunc(() => {
    throw failure
  })
  const symbols = Reflect.get(lib, "opentui").symbols
  const calculate = symbols.yogaNodeCalculateLayoutChecked
  const native = spyOn(symbols, "yogaNodeCalculateLayoutChecked").mockImplementation((...args: unknown[]) => {
    expect(calculate(...args)).toBe(YogaStatus.Ok)
    return YogaStatus.OutOfMemory
  })
  try {
    assert.throws(
      () => node.calculateLayout(),
      (error) => {
        expect(error).toBeInstanceOf(AggregateError)
        expect((error as AggregateError).errors).toEqual([
          new YogaError("yogaNodeCalculateLayoutChecked", YogaStatus.OutOfMemory),
          failure,
        ])
        return true
      },
    )
    native.mockRestore()
    node.setMeasureFunc(() => ({ width: 3, height: 2 }))
    node.markDirty()
    node.calculateLayout()
    expect(node.getComputedWidth()).toBe(3)
  } finally {
    native.mockRestore()
    node.free()
    config.free()
    lib.dispose()
  }
})

test("a rejected reset keeps real measure and dirtied callbacks", () => {
  const lib = new FFIRenderLib()
  const config = Yoga.Config.create(lib)
  const parent = Yoga.Node.create(config)
  const node = Yoga.Node.create(config)
  parent.insertChild(node, 0)
  let dirtied = 0
  node.setMeasureFunc(() => ({ width: 3, height: 2 }))
  node.setDirtiedFunc(() => dirtied++)
  try {
    expect(() => node.reset()).toThrow(YogaError)
    parent.calculateLayout()
    node.markDirty()
    expect(dirtied).toBe(1)
    parent.calculateLayout()
    expect(node.getComputedWidth()).toBe(3)
  } finally {
    parent.freeRecursive()
    config.free()
    lib.dispose()
  }
})

test("measurement reentry leaves renderer projections, topology and VNode factories untouched", async () => {
  const { renderer } = await createTestRenderer({ width: 20, height: 10 })
  const scene = renderer.nativeScene
  const parent = new BoxRenderable(renderer, {})
  const other = new BoxRenderable(renderer, {})
  const child = new BoxRenderable(renderer, { width: 2, height: 1 })
  const observer = new BoxRenderable(renderer, { alignSelf: "flex-start" })
  renderer.root.add(parent)
  renderer.root.add(other)
  renderer.root.add(observer)
  parent.add(child)
  const factory = h(() => {
    throw new Error("VNode factory must not run")
  })
  try {
    for (const mutate of [
      () => {
        child.width = 4
      },
      () => {
        child.height = 2
      },
      () => {
        child.visible = false
      },
      () => {
        child.position = "absolute"
      },
      () => {
        child.overflow = "hidden"
      },
      () => {
        child.flexShrink = 1
      },
      () => child.setPosition({ left: 1, top: 2 }),
      () => other.add(child),
      () => parent.remove(child),
      () => parent.add(factory),
      () => parent.insertBefore(factory, child),
    ]) {
      observer.setMeasureProvider(() => {
        child.width = 2
        expect(child.getChildren()).toEqual([])
        mutate()
        return { width: 1, height: 1 }
      })
      expect(() => scene.measureSnapshot(observer)).toThrow("Cannot mutate Yoga during a callback")
      expect(scene.hasStagedMutations).toBe(false)
      expect([child.width, child.height, child.visible, child.overflow]).toEqual([2, 1, true, "visible"])
      expect(getYogaNode(child).getPositionType()).toBe(Yoga.PositionType.Relative)
      expect(getYogaNode(child).getFlexShrink()).toBe(0)
      expect(parent.getChildren()).toEqual([child])
      expect(other.getChildren()).toEqual([])
      expect(child.parent).toBe(parent)
    }
    other.add(child)
    expect(child.parent).toBe(other)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("native move rejection preserves live and focus ownership; accepted removal hooks can blur", async () => {
  const { renderer } = await createTestRenderer({ width: 20, height: 10 })
  let move: ReturnType<typeof spyOn> | undefined
  try {
    const parent = new BoxRenderable(renderer, { focusable: true })
    const target = new BoxRenderable(renderer, { focusable: true })
    class Child extends BoxRenderable {
      protected override onRemove() {
        this.blur()
      }
    }
    const child = new Child(renderer, { focusable: true, live: true })
    renderer.root.add(parent)
    renderer.root.add(target)
    parent.add(child)
    child.onLifecyclePass = () => {}
    child.focus()
    const symbols = Reflect.get(renderer.nativeScene.driver.renderLib, "opentui").symbols
    move = spyOn(symbols, "ot_scene_move_node")
    move.mockImplementation(() => NativeStatus.OutOfMemory)
    assert.throws(() => target.add(child), { status: NativeStatus.OutOfMemory })
    expect(child.parent).toBe(parent)
    expect([parent.liveCount, target.liveCount]).toEqual([1, 0])
    expect([parent.hasFocusedDescendant, target.hasFocusedDescendant, child.focused]).toEqual([true, false, true])
    expect(renderer.getLifecyclePasses().has(child)).toBe(true)
    move.mockRestore()
    target.add(child)
    expect(child.parent).toBe(target)
    expect([parent.liveCount, target.liveCount]).toEqual([0, 1])
    expect([parent.hasFocusedDescendant, target.hasFocusedDescendant, child.focused]).toEqual([false, false, false])
    expect(renderer.getLifecyclePasses().has(child)).toBe(true)
  } finally {
    move?.mockRestore()
    renderer.destroy()
    await renderer.closed
  }
})

test("rejected dimension flush retains implicit flex-shrink through unchanged and later writes", async () => {
  const { renderer } = await createTestRenderer({ width: 40, height: 10 })
  const scene = renderer.nativeScene
  const box = new BoxRenderable(renderer, { width: 10, height: 1 })
  renderer.root.add(box)
  const symbols = Reflect.get(scene.driver.renderLib, "opentui").symbols
  try {
    for (const next of [20, 30]) {
      box.width = 10
      box.flexShrink = 1
      scene.flushStaged()
      box.width = 20
      const reject = spyOn(symbols, "ot_scene_flush").mockImplementation((...args: any[]) => {
        args[7][0] = 0
        return NativeStatus.OutOfMemory
      })
      try {
        assert.throws(() => box.width, { status: NativeStatus.OutOfMemory })
        expect(scene.hasStagedMutations).toBe(true)
      } finally {
        reject.mockRestore()
      }
      box.width = next
      expect(getYogaNode(box).getWidth().value).toBe(next)
      expect(getYogaNode(box).getFlexShrink()).toBe(0)
      expect(scene.hasStagedMutations).toBe(false)
    }
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
