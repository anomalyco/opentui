import assert from "node:assert/strict"
import { after, afterEach, before, beforeEach, describe, it, test } from "node:test"

type ThrowMatcher = RegExp | string | Error | ((value: unknown) => boolean) | (new (...args: any[]) => Error)

class Expectation<T> {
  constructor(private readonly received: T) {}

  toBe(expected: T): void {
    assert.strictEqual(this.received, expected)
  }

  toBeNull(): void {
    assert.strictEqual(this.received, null)
  }

  toEqual(expected: unknown): void {
    assert.deepStrictEqual(this.received, expected)
  }

  toThrow(expected?: ThrowMatcher): void {
    assert.strictEqual(typeof this.received, "function", "Expected a function for toThrow()")

    if (expected == null) {
      assert.throws(this.received as () => unknown)
      return
    }

    if (typeof expected === "string") {
      assert.throws(
        this.received as () => unknown,
        (error: unknown) => error instanceof Error && error.message.includes(expected),
      )
      return
    }

    assert.throws(this.received as () => unknown, expected as Exclude<ThrowMatcher, string>)
  }
}

export function expect<T>(received: T): Expectation<T> {
  return new Expectation(received)
}

export { after, afterEach, before, beforeEach, describe, it, test }
