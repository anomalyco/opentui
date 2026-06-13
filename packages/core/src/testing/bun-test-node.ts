import { AsyncLocalStorage } from "node:async_hooks"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { after, afterEach, before, beforeEach, describe as nodeDescribe, test as nodeTest } from "node:test"
import { fileURLToPath } from "node:url"
import { inspect, isDeepStrictEqual } from "node:util"

type AnyFunction = (...args: any[]) => any
type ThrowMatcher = RegExp | string | Error | ((value: unknown) => boolean) | (new (...args: any[]) => Error)
const asymmetricMatcher = Symbol("asymmetricMatcher")

interface AsymmetricMatcher {
  readonly [asymmetricMatcher]: true
  matches(received: unknown): boolean
}

interface SnapshotTestContext {
  filePath: string
  fullTestName: string
}

interface MockedFunction<Fn extends AnyFunction = AnyFunction> {
  (...args: Parameters<Fn>): ReturnType<Fn>
  mock: {
    calls: unknown[][]
  }
  mockImplementation(implementation: Fn): MockedFunction<Fn>
  mockRestore(): void
  mockClear(): void
}

function fail(message: string): never {
  throw new assert.AssertionError({ message })
}

function formatValue(value: unknown): string {
  return inspect(value, { depth: 5 })
}

const snapshotContextStorage = new AsyncLocalStorage<SnapshotTestContext>()
const snapshotFileCache = new Map<string, Map<string, string>>()
const snapshotCounters = new Map<string, number>()
const describeNameStack: string[] = []

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n")
}

function serializeSnapshotValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${normalizeNewlines(value).replace(/\\/g, "\\\\")}"`
  }

  return normalizeNewlines(formatValue(value))
}

function normalizeInlineSnapshot(snapshot: string): string {
  const lines = normalizeNewlines(snapshot).split("\n")
  const hasWrapperWhitespace = lines.length >= 2 && lines[0]?.trim() === "" && lines.at(-1)?.trim() === ""

  if (!hasWrapperWhitespace) {
    return lines.join("\n").replace(/\\/g, "\\\\")
  }

  lines.shift()
  lines.pop()

  const indentation = lines.reduce((smallest, line) => {
    if (line.trim() === "") {
      return smallest
    }

    const lineIndentation = line.match(/^\s*/)?.[0].length ?? 0
    return Math.min(smallest, lineIndentation)
  }, Number.POSITIVE_INFINITY)

  if (!Number.isFinite(indentation)) {
    return lines.join("\n")
  }

  return lines
    .map((line) => line.slice(indentation))
    .join("\n")
    .replace(/\\/g, "\\\\")
}

function getSnapshotContext(): SnapshotTestContext {
  const context = snapshotContextStorage.getStore()
  if (!context) {
    fail("Snapshot matchers can only be used inside a test callback")
  }

  return context
}

function getSnapshotFilePath(testFilePath: string): string {
  const emittedMarker = `${path.sep}.node-test${path.sep}`
  const normalizedFilePath = testFilePath.includes(emittedMarker)
    ? testFilePath.replace(emittedMarker, path.sep)
    : testFilePath
  const sourceFilePath = normalizedFilePath.endsWith(".js")
    ? `${normalizedFilePath.slice(0, -3)}.ts`
    : normalizedFilePath

  return path.join(path.dirname(sourceFilePath), "__snapshots__", `${path.basename(sourceFilePath)}.snap`)
}

function readSnapshotFile(snapshotPath: string): Map<string, string> {
  const cached = snapshotFileCache.get(snapshotPath)
  if (cached) {
    return cached
  }

  const snapshots = new Map<string, string>()

  if (existsSync(snapshotPath)) {
    const contents = normalizeNewlines(readFileSync(snapshotPath, "utf8"))
    const snapshotPattern = /exports\[`([\s\S]*?)`\] = `\n([\s\S]*?)\n`;/g

    for (const match of contents.matchAll(snapshotPattern)) {
      snapshots.set(match[1], match[2])
    }
  }

  snapshotFileCache.set(snapshotPath, snapshots)
  return snapshots
}

function nextSnapshotIndex(filePath: string, snapshotName: string): number {
  const counterKey = `${filePath}\u0000${snapshotName}`
  const nextIndex = (snapshotCounters.get(counterKey) ?? 0) + 1
  snapshotCounters.set(counterKey, nextIndex)
  return nextIndex
}

function assertSnapshotMatch(received: unknown, expected: string, label: string, inverted: boolean): void {
  if (inverted) {
    fail(`Snapshot negation is not supported for ${label}`)
  }

  const actual = serializeSnapshotValue(received)
  if (actual !== expected) {
    fail(`Expected ${label} to match\n\nExpected:\n${expected}\n\nReceived:\n${actual}`)
  }
}

function parseStackFilePath(candidate: string): string {
  return candidate.startsWith("file://") ? fileURLToPath(candidate) : candidate
}

function getRegistrationFilePath(): string {
  const stack = new Error().stack?.split("\n") ?? []

  for (const line of stack.slice(1)) {
    const match = line.match(/\((file:\/\/.+?|\/.+?):\d+:\d+\)$/) ?? line.match(/at (file:\/\/.+?|\/.+?):\d+:\d+$/)
    if (!match) {
      continue
    }

    const filePath = parseStackFilePath(match[1])
    const fileName = path.basename(filePath)
    if (fileName === "bun-test-node.ts" || fileName === "bun-test-node.js") {
      continue
    }

    return filePath
  }

  fail("Could not determine the current test file")
}

function wrapTestCallback(filePath: string, fullTestName: string, callback: AnyFunction): AnyFunction {
  return function wrappedTestCallback(this: unknown, ...args: unknown[]) {
    return snapshotContextStorage.run({ filePath, fullTestName }, () => callback.apply(this, args))
  }
}

function getFullTestName(name: string): string {
  return [...describeNameStack, name].join(" ")
}

function registerTest(base: AnyFunction, name: string, optionsOrFn?: unknown, maybeFn?: unknown): unknown {
  const filePath = getRegistrationFilePath()
  const fullTestName = getFullTestName(name)

  if (typeof optionsOrFn === "function") {
    return base(name, wrapTestCallback(filePath, fullTestName, optionsOrFn as AnyFunction))
  }

  if (typeof maybeFn === "function") {
    return base(name, optionsOrFn, wrapTestCallback(filePath, fullTestName, maybeFn as AnyFunction))
  }

  return base(name, optionsOrFn, maybeFn)
}

function wrapDescribeCallback(name: string, callback: AnyFunction): AnyFunction {
  return function wrappedDescribeCallback(this: unknown, ...args: unknown[]) {
    describeNameStack.push(name)

    try {
      return callback.apply(this, args)
    } finally {
      describeNameStack.pop()
    }
  }
}

function registerDescribe(base: AnyFunction, name: string, optionsOrFn?: unknown, maybeFn?: unknown): unknown {
  if (typeof optionsOrFn === "function") {
    return base(name, wrapDescribeCallback(name, optionsOrFn as AnyFunction))
  }

  if (typeof maybeFn === "function") {
    return base(name, optionsOrFn, wrapDescribeCallback(name, maybeFn as AnyFunction))
  }

  return base(name, optionsOrFn, maybeFn)
}

function createTestVariant(base: AnyFunction): AnyFunction {
  return function wrappedTest(name: string, optionsOrFn?: unknown, maybeFn?: unknown): unknown {
    return registerTest(base, name, optionsOrFn, maybeFn)
  }
}

function formatEachName(name: string, args: readonly unknown[]): string {
  let index = 0

  return name.replace(/%s/g, () => String(args[index++]))
}

function createEach(base: AnyFunction) {
  return (cases: readonly unknown[]) => {
    return (name: string, optionsOrFn?: unknown, maybeFn?: unknown): void => {
      for (const testCase of cases) {
        const args = Array.isArray(testCase) ? [...testCase] : [testCase]
        const testName = formatEachName(name, args)

        if (typeof optionsOrFn === "function") {
          registerTest(base, testName, function eachCallback(this: unknown) {
            return (optionsOrFn as AnyFunction).apply(this, args)
          })
          continue
        }

        if (typeof maybeFn === "function") {
          registerTest(base, testName, optionsOrFn, function eachCallback(this: unknown) {
            return (maybeFn as AnyFunction).apply(this, args)
          })
          continue
        }

        registerTest(base, testName, optionsOrFn, maybeFn)
      }
    }
  }
}

function attachEach(target: AnyFunction, base: AnyFunction): void {
  ;(target as AnyFunction & { each?: ReturnType<typeof createEach> }).each = createEach(base)
}

function createTest(base: typeof nodeTest): typeof nodeTest {
  const wrapped = createTestVariant(base) as typeof nodeTest

  Object.assign(wrapped, base)
  attachEach(wrapped, base)

  if (typeof base.skip === "function") {
    wrapped.skip = createTestVariant(base.skip) as typeof base.skip
    attachEach(wrapped.skip as AnyFunction, base.skip)
  }

  if (typeof base.only === "function") {
    wrapped.only = createTestVariant(base.only) as typeof base.only
    attachEach(wrapped.only as AnyFunction, base.only)
  }

  if (typeof base.todo === "function") {
    wrapped.todo = createTestVariant(base.todo) as typeof base.todo
    attachEach(wrapped.todo as AnyFunction, base.todo)
  }

  return wrapped
}

function createDescribeVariant(base: AnyFunction): AnyFunction {
  return function wrappedDescribe(name: string, optionsOrFn?: unknown, maybeFn?: unknown): unknown {
    return registerDescribe(base, name, optionsOrFn, maybeFn)
  }
}

function createDescribe(base: typeof nodeDescribe): typeof nodeDescribe {
  const wrapped = createDescribeVariant(base) as typeof nodeDescribe

  Object.assign(wrapped, base)

  if (typeof base.skip === "function") {
    wrapped.skip = createDescribeVariant(base.skip) as typeof base.skip
  }

  if (typeof base.only === "function") {
    wrapped.only = createDescribeVariant(base.only) as typeof base.only
  }

  if (typeof base.todo === "function") {
    wrapped.todo = createDescribeVariant(base.todo) as typeof base.todo
  }

  return wrapped
}

function hasLength(value: unknown): value is { length: number } {
  return value != null && typeof (value as { length?: unknown }).length === "number"
}

function isComparable(value: unknown): value is number | bigint {
  return typeof value === "number" || typeof value === "bigint"
}

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null
}

function isAsymmetricMatcher(value: unknown): value is AsymmetricMatcher {
  return isObjectLike(value) && value[asymmetricMatcher] === true && typeof value.matches === "function"
}

function createAnyMatcher(expectedType: unknown): AsymmetricMatcher {
  if (typeof expectedType !== "function") {
    fail("expect.any() requires a constructor")
  }

  return {
    [asymmetricMatcher]: true,
    matches(received) {
      if (expectedType === Number) return typeof received === "number" || received instanceof Number
      if (expectedType === String) return typeof received === "string" || received instanceof String
      if (expectedType === Boolean) return typeof received === "boolean" || received instanceof Boolean
      if (expectedType === BigInt) return typeof received === "bigint"
      if (expectedType === Symbol) return typeof received === "symbol"

      return received instanceof expectedType
    },
  }
}

function valuesEqual(received: unknown, expected: unknown): boolean {
  if (isAsymmetricMatcher(expected)) {
    return expected.matches(received)
  }

  if (Array.isArray(received) && Array.isArray(expected)) {
    if (received.length !== expected.length) {
      return false
    }

    for (let index = 0; index < expected.length; index += 1) {
      if (!valuesEqual(received[index], expected[index])) {
        return false
      }
    }

    return true
  }

  return isDeepStrictEqual(received, expected)
}

function objectMatches(received: unknown, expected: unknown): boolean {
  if (isAsymmetricMatcher(expected)) {
    return expected.matches(received)
  }

  if (!isObjectLike(expected)) {
    return valuesEqual(received, expected)
  }

  if (!isObjectLike(received)) {
    return false
  }

  for (const key of Reflect.ownKeys(expected)) {
    if (!Object.hasOwn(received, key)) {
      return false
    }

    if (!objectMatches(received[key], expected[key])) {
      return false
    }
  }

  return true
}

function createMock<Fn extends AnyFunction>(implementation: Fn, restore?: () => void): MockedFunction<Fn> {
  const calls: unknown[][] = []
  let currentImplementation = implementation

  const mocked = function (this: unknown, ...args: Parameters<Fn>): ReturnType<Fn> {
    calls.push(args)
    return currentImplementation.apply(this, args)
  } as MockedFunction<Fn>

  mocked.mock = { calls }
  mocked.mockImplementation = (nextImplementation: Fn) => {
    currentImplementation = nextImplementation
    return mocked
  }
  mocked.mockRestore = () => {
    calls.length = 0
    currentImplementation = implementation
    restore?.()
  }
  mocked.mockClear = () => {
    calls.length = 0
  }

  return mocked
}

function getMockCalls(received: unknown): unknown[][] {
  const calls = (received as MockedFunction | undefined)?.mock?.calls

  if (!Array.isArray(calls)) {
    fail(`Expected ${formatValue(received)} to be a mock or spy`)
  }

  return calls
}

function isErrorConstructor(matcher: ThrowMatcher): matcher is new (...args: any[]) => Error {
  return typeof matcher === "function" && matcher.prototype instanceof Error
}

function matchesThrow(error: unknown, expected?: ThrowMatcher): boolean {
  if (expected == null) {
    return true
  }

  if (typeof expected === "string") {
    return String(error instanceof Error ? error.message : error).includes(expected)
  }

  if (expected instanceof RegExp) {
    return expected.test(String(error instanceof Error ? error.message : error))
  }

  if (expected instanceof Error) {
    return (
      error === expected ||
      (error instanceof Error && error.name === expected.name && error.message === expected.message)
    )
  }

  if (isErrorConstructor(expected)) {
    return error instanceof expected
  }

  return Boolean(expected(error))
}

function formatThrowMatcher(expected?: ThrowMatcher): string {
  if (expected == null) {
    return ""
  }

  return ` matching ${formatValue(expected)}`
}

class AsyncExpectation<T> {
  constructor(
    private readonly received: PromiseLike<T> | T,
    private readonly mode: "resolves" | "rejects",
    private readonly inverted = false,
  ) {}

  get not(): AsyncExpectation<T> {
    return new AsyncExpectation(this.received, this.mode, !this.inverted)
  }

  async toBe(expected: unknown): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toBe(expected)
  }

  async toEqual(expected: unknown): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toEqual(expected)
  }

  async toBeNull(): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toBeNull()
  }

  async toBeUndefined(): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toBeUndefined()
  }

  async toContain(expected: unknown): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toContain(expected)
  }

  async toMatchSnapshot(snapshotName?: string): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toMatchSnapshot(snapshotName)
  }

  async toMatchInlineSnapshot(snapshot: string): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toMatchInlineSnapshot(snapshot)
  }

  async toThrow(expected?: ThrowMatcher): Promise<void> {
    const error = await this.unwrap()
    new Expectation(() => {
      throw error
    }, this.inverted).toThrow(expected)
  }

  async toHaveBeenCalled(): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toHaveBeenCalled()
  }

  async toHaveBeenCalledTimes(expected: number): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toHaveBeenCalledTimes(expected)
  }

  async toHaveBeenCalledWith(...expectedArgs: unknown[]): Promise<void> {
    new Expectation(await this.unwrap(), this.inverted).toHaveBeenCalledWith(...expectedArgs)
  }

  private async unwrap(): Promise<unknown> {
    try {
      const value = await this.received

      if (this.mode === "rejects") {
        fail(`Expected promise to reject but it resolved to ${formatValue(value)}`)
      }

      return value
    } catch (error) {
      if (this.mode === "resolves") {
        fail(`Expected promise to resolve but it rejected with ${formatValue(error)}`)
      }

      return error
    }
  }
}

class Expectation<T> {
  constructor(
    private readonly received: T,
    private readonly inverted = false,
  ) {}

  get not(): Expectation<T> {
    return new Expectation(this.received, !this.inverted)
  }

  get resolves(): AsyncExpectation<T> {
    return new AsyncExpectation(this.received, "resolves", this.inverted)
  }

  get rejects(): AsyncExpectation<T> {
    return new AsyncExpectation(this.received, "rejects", this.inverted)
  }

  toBe(expected: unknown): void {
    this.assertMatch(
      Object.is(this.received, expected),
      `Expected ${formatValue(this.received)} to be ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to be ${formatValue(expected)}`,
    )
  }

  toEqual(expected: unknown): void {
    this.assertMatch(
      valuesEqual(this.received, expected),
      `Expected ${formatValue(this.received)} to equal ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to equal ${formatValue(expected)}`,
    )
  }

  toBeNull(): void {
    this.assertMatch(
      this.received === null,
      `Expected ${formatValue(this.received)} to be null`,
      `Expected ${formatValue(this.received)} not to be null`,
    )
  }

  toBeUndefined(): void {
    this.assertMatch(
      this.received === undefined,
      `Expected ${formatValue(this.received)} to be undefined`,
      `Expected ${formatValue(this.received)} not to be undefined`,
    )
  }

  toBeDefined(): void {
    this.assertMatch(
      this.received !== undefined,
      `Expected ${formatValue(this.received)} to be defined`,
      `Expected ${formatValue(this.received)} not to be defined`,
    )
  }

  toContain(expected: unknown): void {
    if (typeof this.received === "string") {
      this.assertMatch(
        this.received.includes(String(expected)),
        `Expected ${formatValue(this.received)} to contain ${formatValue(expected)}`,
        `Expected ${formatValue(this.received)} not to contain ${formatValue(expected)}`,
      )
      return
    }

    if (Array.isArray(this.received)) {
      this.assertMatch(
        this.received.some((value) => isDeepStrictEqual(value, expected)),
        `Expected ${formatValue(this.received)} to contain ${formatValue(expected)}`,
        `Expected ${formatValue(this.received)} not to contain ${formatValue(expected)}`,
      )
      return
    }

    fail(`Expected ${formatValue(this.received)} to support toContain()`)
  }

  toHaveLength(expected: number): void {
    if (!hasLength(this.received)) {
      fail(`Expected ${formatValue(this.received)} to have a length property`)
    }

    this.assertMatch(
      this.received.length === expected,
      `Expected ${formatValue(this.received)} to have length ${expected} but got ${this.received.length}`,
      `Expected ${formatValue(this.received)} not to have length ${expected}`,
    )
  }

  toBeInstanceOf(expected: new (...args: any[]) => unknown): void {
    this.assertMatch(
      this.received instanceof expected,
      `Expected ${formatValue(this.received)} to be an instance of ${expected.name}`,
      `Expected ${formatValue(this.received)} not to be an instance of ${expected.name}`,
    )
  }

  toMatchObject(expected: object): void {
    this.assertMatch(
      objectMatches(this.received, expected),
      `Expected ${formatValue(this.received)} to match object ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to match object ${formatValue(expected)}`,
    )
  }

  toBeTruthy(): void {
    this.assertMatch(
      Boolean(this.received),
      `Expected ${formatValue(this.received)} to be truthy`,
      `Expected ${formatValue(this.received)} not to be truthy`,
    )
  }

  toBeFalsy(): void {
    this.assertMatch(
      !this.received,
      `Expected ${formatValue(this.received)} to be falsy`,
      `Expected ${formatValue(this.received)} not to be falsy`,
    )
  }

  toBeGreaterThan(expected: number | bigint): void {
    if (!isComparable(this.received) || !isComparable(expected)) {
      fail(`Expected ${formatValue(this.received)} and ${formatValue(expected)} to be comparable numbers`)
    }

    this.assertMatch(
      this.received > expected,
      `Expected ${formatValue(this.received)} to be greater than ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to be greater than ${formatValue(expected)}`,
    )
  }

  toBeGreaterThanOrEqual(expected: number | bigint): void {
    if (!isComparable(this.received) || !isComparable(expected)) {
      fail(`Expected ${formatValue(this.received)} and ${formatValue(expected)} to be comparable numbers`)
    }

    this.assertMatch(
      this.received >= expected,
      `Expected ${formatValue(this.received)} to be greater than or equal to ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to be greater than or equal to ${formatValue(expected)}`,
    )
  }

  toBeLessThan(expected: number | bigint): void {
    if (!isComparable(this.received) || !isComparable(expected)) {
      fail(`Expected ${formatValue(this.received)} and ${formatValue(expected)} to be comparable numbers`)
    }

    this.assertMatch(
      this.received < expected,
      `Expected ${formatValue(this.received)} to be less than ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to be less than ${formatValue(expected)}`,
    )
  }

  toBeLessThanOrEqual(expected: number | bigint): void {
    if (!isComparable(this.received) || !isComparable(expected)) {
      fail(`Expected ${formatValue(this.received)} and ${formatValue(expected)} to be comparable numbers`)
    }

    this.assertMatch(
      this.received <= expected,
      `Expected ${formatValue(this.received)} to be less than or equal to ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to be less than or equal to ${formatValue(expected)}`,
    )
  }

  toBeCloseTo(expected: number, precision = 2): void {
    if (typeof this.received !== "number" || typeof expected !== "number") {
      fail(`Expected ${formatValue(this.received)} and ${formatValue(expected)} to be numbers`)
    }

    const threshold = 0.5 * 10 ** -precision
    const difference = Math.abs(this.received - expected)

    this.assertMatch(
      difference <= threshold,
      `Expected ${formatValue(this.received)} to be close to ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to be close to ${formatValue(expected)}`,
    )
  }

  toMatch(expected: RegExp | string): void {
    if (typeof this.received !== "string") {
      fail(`Expected ${formatValue(this.received)} to be a string for toMatch()`)
    }

    const matches = typeof expected === "string" ? this.received.includes(expected) : expected.test(this.received)

    this.assertMatch(
      matches,
      `Expected ${formatValue(this.received)} to match ${formatValue(expected)}`,
      `Expected ${formatValue(this.received)} not to match ${formatValue(expected)}`,
    )
  }

  toMatchSnapshot(snapshotName?: string): void {
    const { filePath, fullTestName } = getSnapshotContext()
    const snapshotBaseName = snapshotName ? `${fullTestName}: ${snapshotName}` : fullTestName
    const snapshotIndex = nextSnapshotIndex(filePath, snapshotBaseName)
    const snapshotKey = `${snapshotBaseName} ${snapshotIndex}`
    const snapshotPath = getSnapshotFilePath(filePath)
    const snapshot = readSnapshotFile(snapshotPath).get(snapshotKey)

    if (snapshot === undefined) {
      fail(`Snapshot ${formatValue(snapshotKey)} not found in ${snapshotPath}`)
    }

    assertSnapshotMatch(this.received, snapshot, `snapshot ${formatValue(snapshotKey)}`, this.inverted)
  }

  toMatchInlineSnapshot(snapshot: string): void {
    assertSnapshotMatch(this.received, normalizeInlineSnapshot(snapshot), "inline snapshot", this.inverted)
  }

  toThrow(expected?: ThrowMatcher): void {
    if (typeof this.received !== "function") {
      fail(`Expected ${formatValue(this.received)} to be a function for toThrow()`)
    }

    let thrown = false
    let error: unknown

    try {
      ;(this.received as AnyFunction)()
    } catch (caughtError) {
      thrown = true
      error = caughtError
    }

    this.assertMatch(
      thrown && matchesThrow(error, expected),
      `Expected function to throw${formatThrowMatcher(expected)}`,
      `Expected function not to throw${formatThrowMatcher(expected)}`,
    )
  }

  toHaveBeenCalled(): void {
    const calls = getMockCalls(this.received)

    this.assertMatch(calls.length > 0, `Expected mock to have been called`, `Expected mock not to have been called`)
  }

  toHaveBeenCalledTimes(expected: number): void {
    const calls = getMockCalls(this.received)

    this.assertMatch(
      calls.length === expected,
      `Expected mock to have been called ${expected} times but it was called ${calls.length} times`,
      `Expected mock not to have been called ${expected} times`,
    )
  }

  toHaveBeenCalledWith(...expectedArgs: unknown[]): void {
    const calls = getMockCalls(this.received)

    this.assertMatch(
      calls.some((args) => isDeepStrictEqual(args, expectedArgs)),
      `Expected mock to have been called with ${formatValue(expectedArgs)} but got ${formatValue(calls)}`,
      `Expected mock not to have been called with ${formatValue(expectedArgs)}`,
    )
  }

  toHaveProperty(property: PropertyKey, expectedValue?: unknown): void {
    if (!isObjectLike(this.received)) {
      fail(`Expected ${formatValue(this.received)} to be an object for toHaveProperty()`)
    }

    const received = this.received as Record<PropertyKey, unknown>
    const hasProperty = property in received
    const matchesValue = arguments.length < 2 || valuesEqual(received[property], expectedValue)

    this.assertMatch(
      hasProperty && matchesValue,
      `Expected ${formatValue(this.received)} to have property ${String(property)}`,
      `Expected ${formatValue(this.received)} not to have property ${String(property)}`,
    )
  }

  private assertMatch(condition: boolean, positiveMessage: string, negativeMessage: string): void {
    if (this.inverted ? condition : !condition) {
      fail(this.inverted ? negativeMessage : positiveMessage)
    }
  }
}

interface ExpectApi {
  <T>(received: T): Expectation<T>
  any(expectedType: unknown): AsymmetricMatcher
}

export const expect = Object.assign(<T>(received: T): Expectation<T> => new Expectation(received), {
  any: createAnyMatcher,
}) as ExpectApi

export function mock<Fn extends AnyFunction = () => undefined>(
  implementation = (() => undefined) as Fn,
): MockedFunction<Fn> {
  return createMock(implementation)
}

export function spyOn(object: object, key: string | symbol): MockedFunction {
  const record = object as Record<string | symbol, unknown>
  const original = record[key]

  assert.strictEqual(typeof original, "function", `Cannot spy on ${String(key)} because it is not a function`)

  const spy = createMock(
    function (this: unknown, ...args: unknown[]) {
      return (original as AnyFunction).apply(this, args)
    },
    () => {
      record[key] = original
    },
  )

  record[key] = spy
  return spy
}

export const beforeAll = before
export const afterAll = after
export const test = createTest(nodeTest) as typeof nodeTest & { each: ReturnType<typeof createEach> }
export const it = test
export const describe = createDescribe(nodeDescribe)
export { afterEach, beforeEach }
