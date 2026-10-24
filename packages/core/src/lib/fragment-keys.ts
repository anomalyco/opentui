/**
 * Assigns numeric keys to application `metadata` values so native cells can carry them.
 *
 * Native code stores only the key, inside the cell's link id. This registry maps a key back to
 * its value and to the scope that installed it. A scope is the install owner: a text buffer, a
 * scene text node, or a table. Within one scope, the same value (by identity) always yields the
 * same live key; different scopes get different keys, so a key also identifies who drew it.
 * Install owners hold one reference per key-carrying chunk; a key is freed when its last
 * reference is released.
 */
export class FragmentKeyRegistry {
  private readonly byScope = new WeakMap<object, Map<unknown, Entry>>()
  private readonly byKey = new Map<number, Entry>()
  private nextKey = 1

  /** Number of live keys. */
  get size(): number {
    return this.byKey.size
  }

  /** Returns the key for `value` in `scope`, adding one reference. Throws RangeError when no key is free. */
  retain(value: unknown, scope: object): number {
    let values = this.byScope.get(scope)
    const existing = values?.get(value)
    if (existing) {
      existing.refs++
      return existing.key
    }
    if (this.byKey.size >= KEY_MAX) throw new RangeError("Fragment metadata key space is exhausted")
    // Keys wrap around past the u32 limit and skip keys that are still live.
    let key = this.nextKey
    while (this.byKey.has(key)) key = key === KEY_MAX ? 1 : key + 1
    this.nextKey = key === KEY_MAX ? 1 : key + 1
    if (!values) {
      values = new Map()
      this.byScope.set(scope, values)
    }
    const entry: Entry = { key, value, scope, refs: 1 }
    values.set(value, entry)
    this.byKey.set(key, entry)
    return key
  }

  /** Drops one reference to `key`. Unknown keys and 0 are ignored. */
  release(key: number): void {
    const entry = this.byKey.get(key)
    if (!entry || --entry.refs > 0) return
    this.byKey.delete(key)
    const values = this.byScope.get(entry.scope)!
    values.delete(entry.value)
    if (values.size === 0) this.byScope.delete(entry.scope)
  }

  /** Releases one reference for every non-zero key in `keys`. */
  releaseAll(keys: ArrayLike<number>): void {
    for (let index = 0; index < keys.length; index++) this.release(keys[index]!)
  }

  /** The value for `key`, or undefined when the key is 0, unknown, or released. */
  resolve(key: number): unknown {
    return this.byKey.get(key)?.value
  }

  /** The scope that holds `key`, or undefined when the key is 0, unknown, or released. */
  scopeOf(key: number): object | undefined {
    return this.byKey.get(key)?.scope
  }

  /** A view that retains keys in `scope`. Encoders take this so they cannot pick a scope themselves. */
  forScope(scope: object): FragmentKeySink {
    return { retain: (value) => this.retain(value, scope), releaseAll: (keys) => this.releaseAll(keys) }
  }
}

/** Retains keys for one install owner and releases them if the install fails. */
export interface FragmentKeySink {
  retain(value: unknown): number
  releaseAll(keys: ArrayLike<number>): void
}

interface Entry {
  readonly key: number
  readonly value: unknown
  readonly scope: object
  refs: number
}

/** Keys are native u32 values; 0 means "no key". */
const KEY_MAX = 0xffff_ffff

const registries = new WeakMap<object, FragmentKeyRegistry>()

/** The registry for one native Context. Keys are meaningful only within that Context. */
export function fragmentKeysFor(context: object): FragmentKeyRegistry {
  let registry = registries.get(context)
  if (!registry) {
    registry = new FragmentKeyRegistry()
    registries.set(context, registry)
  }
  return registry
}
