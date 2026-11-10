import assert from "node:assert/strict"
import { after, afterEach, before, beforeEach, describe, test } from "node:test"
import { inspect, isDeepStrictEqual } from "node:util"

function fail(message: string): never {
  throw new assert.AssertionError({ message })
}

function formatValue(value: unknown): string {
  return inspect(value, { depth: 5 })
}

function createMatchers(received: unknown, inverted = false) {
  const assertMatch = (pass: boolean, message: string): void => {
    if (inverted ? pass : !pass) {
      fail(message)
    }
  }

  return {
    get not() {
      return createMatchers(received, !inverted)
    },
    toBe(expected: unknown) {
      assertMatch(
        Object.is(received, expected),
        `Expected ${formatValue(received)} ${inverted ? "not " : ""}to be ${formatValue(expected)}`,
      )
    },
    toBeInstanceOf(expected: new (...args: any[]) => unknown) {
      assertMatch(
        received instanceof expected,
        `Expected ${formatValue(received)} to be an instance of ${expected.name}`,
      )
    },
    toBeDefined() {
      assertMatch(received !== undefined, `Expected value ${inverted ? "not " : ""}to be defined`)
    },
    toBeFalsy() {
      assertMatch(!received, `Expected ${formatValue(received)} ${inverted ? "not " : ""}to be falsy`)
    },
    toBeTruthy() {
      assertMatch(Boolean(received), `Expected ${formatValue(received)} ${inverted ? "not " : ""}to be truthy`)
    },
    toBeNull() {
      assertMatch(received === null, `Expected ${formatValue(received)} ${inverted ? "not " : ""}to be null`)
    },
    toContain(expected: unknown) {
      const pass =
        typeof received === "string"
          ? received.includes(String(expected))
          : Array.isArray(received)
            ? received.includes(expected)
            : false

      assertMatch(
        pass,
        `Expected ${formatValue(received)} ${inverted ? "not " : ""}to contain ${formatValue(expected)}`,
      )
    },
    toEqual(expected: unknown) {
      assertMatch(
        isDeepStrictEqual(received, expected),
        `Expected ${formatValue(received)} ${inverted ? "not " : ""}to equal ${formatValue(expected)}`,
      )
    },
    toThrow(expected?: string | RegExp) {
      let thrown: unknown
      try {
        ;(received as () => unknown)()
      } catch (error) {
        thrown = error
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      const matches =
        thrown !== undefined &&
        (expected === undefined || (typeof expected === "string" ? message.includes(expected) : expected.test(message)))
      assertMatch(matches, `Expected function ${inverted ? "not " : ""}to throw ${formatValue(expected)}`)
    },
  }
}

export { after as afterAll, afterEach, before as beforeAll, beforeEach, describe, test }
export const it = test

export function expect(received: unknown) {
  return createMatchers(received)
}
