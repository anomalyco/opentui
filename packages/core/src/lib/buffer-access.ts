import type { BufferAccess } from "../buffer.js"
import { toArrayBuffer } from "../platform/ffi.js"
import type { NativeContextBufferLease, NativeContextHandle, RenderLib } from "../zig.js"

type BufferSnapshot = Omit<NativeContextBufferLease, "handle">

export function withBufferAccess<T>(
  lib: RenderLib,
  context: NativeContextHandle,
  lease: NativeContextBufferLease,
  callback: (cells: BufferAccess) => T,
): T {
  try {
    return withLazyBufferAccess(
      lease,
      (getCells) => callback(getCells()),
      () => lib.contextValidateBufferLease(context, lease.handle),
    )
  } finally {
    lib.contextReleaseBufferLease(context, lease.handle)
  }
}

export function withLazyBufferAccess<T>(
  snapshot: BufferSnapshot | (() => BufferSnapshot),
  callback: (getCells: () => BufferAccess) => T,
  validate: () => void,
): T {
  let active = true
  let cells: BufferAccess | undefined
  const getCells = () => {
    if (!active) throw new Error("Buffer access scope has ended")
    if (cells) return cells
    const value = typeof snapshot === "function" ? snapshot() : snapshot
    let char: Uint32Array | undefined
    let fg: Uint16Array | undefined
    let bg: Uint16Array | undefined
    let attributes: Uint32Array | undefined
    const guard = () => {
      if (!active) throw new Error("Buffer access scope has ended")
    }
    cells = {
      width: value.width,
      height: value.height,
      generation: value.generation,
      get char() {
        guard()
        return (char ??= new Uint32Array(toArrayBuffer(value.char, 0, value.width * value.height * 4)))
      },
      get fg() {
        guard()
        return (fg ??= new Uint16Array(toArrayBuffer(value.fg, 0, value.width * value.height * 8)))
      },
      get bg() {
        guard()
        return (bg ??= new Uint16Array(toArrayBuffer(value.bg, 0, value.width * value.height * 8)))
      },
      get attributes() {
        guard()
        return (attributes ??= new Uint32Array(toArrayBuffer(value.attributes, 0, value.width * value.height * 4)))
      },
    }
    return cells
  }
  try {
    const result = callback(getCells)
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      void Promise.resolve(result).catch(() => {})
      throw new TypeError("Buffer access callbacks must be synchronous")
    }
    validate()
    return result
  } finally {
    active = false
  }
}
