import { describe, expect, test } from "bun:test"
import { Emitter } from "../emitter.js"

interface TestEvents {
  value: number
  done: void
  other: { name: string }
}

describe("keymap emitter", () => {
  test("starts empty and supports no-op off, emit, and clear", () => {
    const errors: Array<{ name: keyof TestEvents; error: unknown }> = []
    const emitter = new Emitter<TestEvents>((name, error) => {
      errors.push({ name, error })
    })
    const listener = (_value: number) => {}

    expect(emitter.has("value")).toBe(false)
    expect(emitter.has("done")).toBe(false)
    expect(emitter.has("other")).toBe(false)

    emitter.off("value", listener)
    emitter.emit("value", 1)
    emitter.emit("done")
    emitter.clear()

    expect(emitter.has("value")).toBe(false)
    expect(emitter.has("done")).toBe(false)
    expect(errors).toEqual([])
  })

  test("emits listeners in registration order and keeps events isolated", () => {
    const emitter = new Emitter<TestEvents>(() => {})
    const calls: string[] = []

    emitter.hook("value", (value) => {
      calls.push(`value:first:${value}`)
    })
    emitter.hook("value", (value) => {
      calls.push(`value:second:${value}`)
    })
    emitter.hook("other", (value) => {
      calls.push(`other:${value.name}`)
    })

    emitter.emit("value", 3)
    emitter.emit("other", { name: "x" })

    expect(calls).toEqual(["value:first:3", "value:second:3", "other:x"])
    expect(emitter.has("value")).toBe(true)
    expect(emitter.has("other")).toBe(true)
    expect(emitter.has("done")).toBe(false)
  })

  test("supports void events", () => {
    const emitter = new Emitter<TestEvents>(() => {})
    const calls: string[] = []

    emitter.hook("done", () => {
      calls.push("done")
    })

    emitter.emit("done")

    expect(calls).toEqual(["done"])
  })

  test("off and returned unhook remove all matching registrations and stay idempotent", () => {
    const emitter = new Emitter<TestEvents>(() => {})
    const calls: string[] = []
    const listener = (value: number) => {
      calls.push(`value:${value}`)
    }

    emitter.hook("value", listener)
    emitter.hook("value", listener)
    emitter.off("value", listener)

    emitter.emit("value", 1)

    expect(calls).toEqual([])
    expect(emitter.has("value")).toBe(false)

    const offFirst = emitter.hook("value", listener)
    const offSecond = emitter.hook("value", listener)

    offFirst()
    offFirst()
    offSecond()

    emitter.emit("value", 2)

    expect(calls).toEqual([])
    expect(emitter.has("value")).toBe(false)
  })

  test("uses snapshot semantics while emitting", () => {
    const emitter = new Emitter<TestEvents>(() => {})
    const calls: string[] = []
    const listenerB = (value: number) => {
      calls.push(`b:${value}`)
    }
    const listenerC = (value: number) => {
      calls.push(`c:${value}`)
    }
    let offA = () => {}
    const listenerA = (value: number) => {
      calls.push(`a:${value}`)
      offA()
      emitter.hook("value", listenerC)
      emitter.off("value", listenerB)
    }

    offA = emitter.hook("value", listenerA)
    emitter.hook("value", listenerB)

    emitter.emit("value", 1)
    emitter.emit("value", 2)

    expect(calls).toEqual(["a:1", "b:1", "c:2"])
  })

  test("clear during emit only affects future emits", () => {
    const emitter = new Emitter<TestEvents>(() => {})
    const calls: string[] = []

    emitter.hook("value", (value) => {
      calls.push(`first:${value}`)
      emitter.clear()
    })
    emitter.hook("value", (value) => {
      calls.push(`second:${value}`)
    })

    emitter.emit("value", 1)
    emitter.emit("value", 2)

    expect(calls).toEqual(["first:1", "second:1"])
    expect(emitter.has("value")).toBe(false)
    expect(emitter.has("done")).toBe(false)
  })

  test("reports listener errors and continues emitting later listeners", () => {
    const errors: Array<{ name: keyof TestEvents; error: unknown }> = []
    const emitter = new Emitter<TestEvents>((name, error) => {
      errors.push({ name, error })
    })
    const boom = new Error("boom")
    const calls: string[] = []

    emitter.hook("value", () => {
      throw boom
    })
    emitter.hook("value", (value) => {
      calls.push(`value:${value}`)
    })

    emitter.emit("value", 7)

    expect(calls).toEqual(["value:7"])
    expect(errors).toEqual([{ name: "value", error: boom }])
  })
})
