import { setTimeout as sleep } from "node:timers/promises"

import { expect, test } from "bun:test"

import {
  FFIRenderLib,
  NativeClipboardCopyStatus,
  NativeClipboardDestroyStatus,
  NativeClipboardOperationStatus,
  NativeClipboardShutdownStatus,
  NativeClipboardStartStatus,
  resolveRenderLib,
  type ClipboardOperationHandle,
  type ClipboardServiceHandle,
  type RenderLib,
} from "../zig.js"

const READ_REQUEST = Uint8Array.of(1, 0, 0, 0, 10, 0, 0, 0, ...new TextEncoder().encode("text/plain"))

test("native clipboard production-symbol ABI lifecycle", async () => {
  const lib = resolveRenderLib()
  let service = lib.clipboardServiceCreate(3, 2)
  if (!service) throw new Error("failed to create clipboard service")
  const operations = new Set<ClipboardOperationHandle>()
  try {
    expect(() => (lib as typeof lib & { dispose(): void }).dispose()).toThrow(
      /clipboard services are active|dispose failed: ContextBusy/,
    )
    expect(lib.clipboardServiceDrain(service)).not.toBe(2)
    const starts = [
      lib.clipboardReadOperationStart(service, READ_REQUEST, 0, 1024, 4096, 8192, 0),
      lib.clipboardWriteOperationStart(service, new TextEncoder().encode("text"), 0, 0),
      lib.clipboardClearOperationStart(service, 0, 0),
    ]
    for (const { operation } of starts) {
      if (operation) operations.add(operation)
    }
    expect(starts.map(({ status }) => status)).toEqual(Array(3).fill(NativeClipboardStartStatus.Ok))
    expect(operations.size).toBe(3)
    for (const operation of operations) {
      expect(lib.clipboardOperationPoll(operation)).toBe(NativeClipboardOperationStatus.TimedOut)
    }
    const [operation, ...remaining] = operations
    expect(lib.clipboardOperationResultMimeLength(operation!).status).toBe(NativeClipboardCopyStatus.InvalidState)
    expect(lib.clipboardOperationDestroy(operation!)).toBe(NativeClipboardDestroyStatus.Destroyed)
    expect(lib.clipboardOperationPoll(operation!)).toBe(NativeClipboardOperationStatus.InvalidHandle)
    expect(lib.clipboardOperationDestroy(operation!)).toBe(NativeClipboardDestroyStatus.InvalidHandle)
    for (const handle of remaining) {
      expect(lib.clipboardOperationDestroy(handle)).toBe(NativeClipboardDestroyStatus.Destroyed)
    }
    operations.clear()

    expect(lib.clipboardServiceBeginShutdown(service)).toBe(NativeClipboardShutdownStatus.Pending)
    expect(lib.clipboardClearOperationStart(service, 0, 0).status).toBe(NativeClipboardStartStatus.ShuttingDown)
    const destroyedService = service
    const destroyStatus = await finishShutdown(destroyedService)
    service = null
    expect(destroyStatus).toBe(NativeClipboardDestroyStatus.Destroyed)
    expect(lib.clipboardServicePollShutdown(destroyedService)).toBe(NativeClipboardShutdownStatus.InvalidHandle)
  } finally {
    for (const operation of operations) lib.clipboardOperationDestroy(operation)
    if (service) {
      lib.clipboardServiceBeginShutdown(service)
      await finishShutdown(service)
    }
  }
})

async function finishShutdown(
  service: ClipboardServiceHandle,
  lib: RenderLib = resolveRenderLib(),
): Promise<NativeClipboardDestroyStatus> {
  let status = lib.clipboardServicePollShutdown(service)
  for (let attempt = 0; status === NativeClipboardShutdownStatus.Pending && attempt < 2_000; attempt += 1) {
    await sleep(1)
    status = lib.clipboardServicePollShutdown(service)
  }
  expect(status).toBe(NativeClipboardShutdownStatus.Ready)
  return lib.clipboardServiceDestroy(service)
}

test("native clipboard handles reject foreign libraries and reused operations", async () => {
  const first = new FFIRenderLib()
  const second = new FFIRenderLib()
  const service = first.clipboardServiceCreate(1, 1)!
  const other = second.clipboardServiceCreate(1, 1)!
  try {
    expect(second.clipboardClearOperationStart(service, 0, 0).status).toBe(NativeClipboardStartStatus.InvalidService)
    const operation = first.clipboardClearOperationStart(service, 0, 0).operation!
    expect(first.clipboardOperationDestroy(operation)).toBe(NativeClipboardDestroyStatus.Destroyed)
    const replacement = first.clipboardClearOperationStart(service, 0, 0).operation!
    expect(replacement).not.toBe(operation)
    expect(first.clipboardOperationPoll(operation)).toBe(NativeClipboardOperationStatus.InvalidHandle)
    first.clipboardServiceBeginShutdown(service)
    await finishShutdown(service, first)
    expect(first.clipboardOperationPoll(replacement)).toBe(NativeClipboardOperationStatus.InvalidHandle)
  } finally {
    second.clipboardServiceBeginShutdown(other)
    await finishShutdown(other, second)
    first.dispose()
    second.dispose()
  }
})
