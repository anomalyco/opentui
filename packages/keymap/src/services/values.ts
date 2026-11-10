function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const DEPTH_MAX = 16
// Compiled data nests the checked data a few levels deeper; the bound only stops cycles a compile hook made.
const COMPILED_DEPTH_MAX = 32
const PLAIN_FUNCTION_KEYS = new Set<PropertyKey>(["length", "name", "prototype"])

// Whether a value is plain data: plain objects, arrays and primitives with enumerable string-keyed data
// properties, and functions with no own properties of their own. Anything else (other prototypes, frozen,
// sealed or non-extensible objects, accessors, symbol, non-enumerable or `__proto__` keys, cycles or data
// deeper than 16) is not, and neither is a value that throws while read. The top-level `identityKey` value
// is not checked (a layer's target).
export function isPlainData(value: unknown, identityKey?: string): boolean {
  try {
    return checkPlainData(value, identityKey, 0)
  } catch {
    return false
  }
}

function checkPlainData(value: unknown, identityKey: string | undefined, depth: number): boolean {
  if (typeof value === "function") return isPlainFunction(value)
  if (typeof value !== "object" || value === null) return true

  const isArray = Array.isArray(value)
  const plain = isArray ? Object.getPrototypeOf(value) === Array.prototype : isPlainObject(value)
  if (!plain || !Object.isExtensible(value) || depth >= DEPTH_MAX) return false

  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== "string" || key === "__proto__" || !("value" in descriptor)) return false
    if (!descriptor.enumerable && !(isArray && key === "length")) return false
    return (depth === 0 && key === identityKey) || checkPlainData(Reflect.get(value, key), undefined, depth + 1)
  })
}

// Stable functions that call their current target; a kept layer keeps them and moves their targets.
const forwardTargets = new WeakMap<object, { target: unknown }>()

export function createForwarder<T>(target: T): T {
  const cell = { target }
  const forward = function (this: unknown, ...args: unknown[]) {
    return Reflect.apply(cell.target as (...args: unknown[]) => unknown, this, args)
  }
  forwardTargets.set(forward, cell)
  return forward as T
}

// Objects that the caller or a compile hook supplied while a layer compiles: they compare by identity.
let external: WeakSet<object> | undefined

export function collectExternal<T>(objects: WeakSet<object>, compile: () => T): T {
  const previous = external
  external = objects
  try {
    return compile()
  } finally {
    external = previous
  }
}

// Marks a value a field compiler supplied (a requirement or an attr) as external, a function too: the keymap
// compares requirements with `Object.is` and hands attrs out as they are.
export function markSupplied(value: unknown): void {
  if (typeof value === "function" || (typeof value === "object" && value !== null)) external?.add(value)
}

// Marks a supplied value and the arrays and plain objects inside it as external.
export function markExternal(value: unknown, depth = 0): void {
  if (!external || typeof value !== "object" || value === null || external.has(value)) return
  external.add(value)
  try {
    if (depth >= DEPTH_MAX || !(Array.isArray(value) || isPlainObject(value))) return
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor && "value" in descriptor) markExternal(descriptor.value, depth + 1)
    }
  } catch {
    // An object that cannot be read is marked; whatever it holds stays unread.
  }
}

// Whether new compiled layer data equals the kept data, so the kept layer can stay whole. Reads property
// descriptors only, so no getter runs. Values in `external` (supplied by the caller or a hook) compare by
// identity; other arrays and plain objects (made by the compile, frozen ones too) by their enumerable
// string-keyed data properties; primitives by value. Two functions without own properties are equal: for a
// forwarder, `moves` gets its new target; otherwise the new function goes into the kept container, unless
// it is frozen, sealed or non-extensible, which makes the data unequal.
// Anything else, or data deeper than 32, is unequal.
export function sameCompiledData(
  left: unknown,
  right: unknown,
  external: WeakSet<object>,
  moves: [object, string, unknown][],
  depth = 0,
): boolean {
  if (Object.is(left, right)) return true
  if (external.has(left as object) || external.has(right as object)) return false
  if (typeof left === "function") return typeof right === "function" && isPlainFunction(left) && isPlainFunction(right)
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false
  if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) return false
  if (depth >= COMPILED_DEPTH_MAX) return false

  const keys = Reflect.ownKeys(left)
  return (
    keys.length === Reflect.ownKeys(right).length &&
    keys.every((key) => {
      const before = Object.getOwnPropertyDescriptor(left, key)
      const after = Object.getOwnPropertyDescriptor(right, key)
      if (typeof key !== "string" || !before || !after || !("value" in before) || !("value" in after)) return false
      const enumerable = before.enumerable || (Array.isArray(left) && key === "length")
      if (!enumerable || after.enumerable !== before.enumerable) return false
      if (!sameCompiledData(before.value, after.value, external, moves, depth + 1)) return false
      if (typeof before.value !== "function" || before.value === after.value) return true
      const cell = forwardTargets.get(before.value)
      const nextCell = forwardTargets.get(after.value as object)
      if (cell && nextCell) moves.push([cell, "target", nextCell.target])
      else if (!cell && Object.isExtensible(left)) moves.push([left, key, after.value])
      else return false
      return true
    })
  )
}

function isPlainFunction(value: object): boolean {
  return Reflect.ownKeys(value).every((key) => PLAIN_FUNCTION_KEYS.has(key))
}

function isContainer(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && (Array.isArray(value) || isPlainObject(value))
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export function isPromiseLike(value: unknown): value is Promise<unknown> {
  if (!value) {
    return false
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return false
  }

  return typeof (value as { then?: unknown }).then === "function"
}

export function snapshotDataValue(
  value: unknown,
  options?: {
    deep?: boolean
    freeze?: boolean
    preserveNonPlainObjects?: boolean
  },
): unknown {
  const deep = options?.deep === true
  const freeze = options?.freeze === true
  const preserveNonPlainObjects = options?.preserveNonPlainObjects === true

  if (Array.isArray(value)) {
    const cloned = deep ? value.map((entry) => snapshotDataValue(entry, options)) : [...value]
    return freeze ? Object.freeze(cloned) : cloned
  }

  if (value && typeof value === "object") {
    if (preserveNonPlainObjects && !isPlainObject(value)) {
      return value
    }

    const cloned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      cloned[key] = deep ? snapshotDataValue(entry, options) : entry
    }

    return freeze ? Object.freeze(cloned) : cloned
  }

  return value
}
