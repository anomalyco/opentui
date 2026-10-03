import { describe, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { OptimizedBuffer, ResourceContext } from "./buffer.js"
import { RGBA } from "./lib/RGBA.js"
import { TextBuffer } from "./text-buffer.js"
import { TextBufferView } from "./text-buffer-view.js"
import { EditBuffer } from "./edit-buffer.js"
import { EditorView } from "./editor-view.js"
import { Config, Node } from "./yoga.js"
import { nativeLayouts } from "./native-abi.generated.js"
import {
  FFIRenderLib,
  LogLevel,
  NativeEditCommand,
  NativeStatus,
  resolveRenderLib,
  setRenderLibPath,
  type ContextTextBufferHandle,
  type NativeContextHandle,
  type NativeSceneFrameRequest,
} from "./zig.js"

type Lib = ReturnType<typeof resolveRenderLib>
// Rows mix handle kinds on purpose: each test passes one kind's handle to another kind's calls.
type Handle = any

// Each row creates a live handle of one resource kind, reads it, and destroys it.
const resourceKinds: [
  name: string,
  create: (lib: Lib, context: NativeContextHandle) => Handle,
  read: (lib: Lib, context: NativeContextHandle, handle: Handle) => unknown,
  destroy: (lib: Lib, context: NativeContextHandle, handle: Handle) => void,
][] = [
  [
    "text buffer",
    (lib, context) => lib.createContextTextBuffer(context),
    (lib, context, handle) => lib.contextTextBufferGetText(context, handle),
    (lib, context, handle) => lib.destroyContextTextBuffer(context, handle),
  ],
  [
    "edit buffer",
    (lib, context) => lib.createContextEditBuffer(context),
    (lib, context, handle) => lib.contextEditBufferGetText(context, handle),
    (lib, context, handle) => lib.destroyContextEditBuffer(context, handle),
  ],
  [
    "text view",
    (lib, context) => lib.createContextTextBufferView(context, lib.createContextTextBuffer(context)),
    (lib, context, handle) => lib.contextTextBufferViewGetInfo(context, handle),
    (lib, context, handle) => lib.destroyContextTextBufferView(context, handle),
  ],
  [
    "editor view",
    (lib, context) => lib.createContextEditorView(context, lib.createContextEditBuffer(context), 4, 2),
    (lib, context, handle) => lib.contextEditorViewGetInfo(context, handle),
    (lib, context, handle) => lib.destroyContextEditorView(context, handle),
  ],
  [
    "syntax style",
    (lib, context) => lib.createContextSyntaxStyle(context),
    (lib, context, handle) => lib.contextSyntaxStyleGetStyleCount(context, handle),
    (lib, context, handle) => lib.destroyContextSyntaxStyle(context, handle),
  ],
  [
    "buffer",
    (lib, context) => lib.createContextBuffer(context, { width: 2, height: 1 }),
    (lib, context, handle) =>
      lib.contextReleaseBufferLease(context, lib.contextAcquireBufferLease(context, handle).handle),
    (lib, context, handle) => lib.destroyContextBuffer(context, handle),
  ],
  [
    "unicode",
    (lib, context) => lib.createContextUnicode(context, "a", "unicode"),
    (lib, context, handle) => lib.getContextUnicode(context, handle),
    (lib, context, handle) => lib.destroyContextUnicode(context, handle),
  ],
  [
    "embedded terminal",
    (lib, context) => lib.createContextEmbeddedTerminal(context, { cols: 4, rows: 1 }),
    (lib, context, handle) => lib.contextEmbeddedTerminalWrite(context, handle, "x"),
    (lib, context, handle) => lib.destroyContextEmbeddedTerminal(context, handle),
  ],
]

describe("native handles", () => {
  test.each(resourceKinds.map((kind, index) => [kind[0], kind, resourceKinds[(index + 1) % resourceKinds.length]!]))(
    "%s handles reject wrong kinds, stale access, and double destroy",
    (_, [, create, read, destroy], [, createOther, readOther]) => {
      const lib = resolveRenderLib()
      const context = lib.createContext({ objectCapacity: 8, renderCellsMax: 32 })
      try {
        const handle = create(lib, context)
        const other = createOther(lib, context)
        read(lib, context, handle)
        expect(() => read(lib, context, other)).toThrow("WrongKind")
        expect(() => destroy(lib, context, other)).toThrow("WrongKind")
        readOther(lib, context, other)
        destroy(lib, context, handle)
        expect(() => read(lib, context, handle)).toThrow("StaleHandle")
        expect(() => destroy(lib, context, handle)).toThrow("StaleHandle")
      } finally {
        lib.destroyContext(context)
      }
    },
  )

  test.each([
    ["a copy", () => ({}), null],
    ["the next generation", (text) => ({ generation: text.generation + 1 }), "StaleHandle"],
    ["the largest slot", () => ({ slot: 0xffff_ffff }), "StaleHandle"],
    ["a low contextId bit flipped", (text) => ({ contextId: text.contextId ^ 1n }), "WrongContext"],
    ["a high contextId bit flipped", (text) => ({ contextId: text.contextId ^ (1n << 40n) }), "WrongContext"],
    ["an all-zero handle", () => ({ contextId: 0n, slot: 0, generation: 0 }), "WrongContext"],
    ["a negative slot", () => ({ slot: -1 }), RangeError],
    ["a fractional generation", () => ({ generation: 0.5 }), RangeError],
    ["a negative contextId", () => ({ contextId: -1n }), RangeError],
    ["a contextId above u64", () => ({ contextId: 1n << 64n }), RangeError],
    ["a number contextId", (text) => ({ contextId: Number(text.contextId) }), RangeError],
  ] as const satisfies readonly [string, (text: ContextTextBufferHandle) => object, unknown][])(
    "a handle object with %s is encoded from its own fields",
    (_, fields, expected) => {
      const lib = resolveRenderLib()
      const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 1 })
      try {
        const text = lib.createContextTextBuffer(context)
        lib.contextTextBufferSetText(context, text, lib.encoder.encode("live"))
        const read = () => lib.contextTextBufferGetText(context, { ...text, ...fields(text) } as never)
        if (expected === null) expect(read()).toBe("live")
        else expect(read).toThrow(expected)
      } finally {
        lib.destroyContext(context)
      }
    },
  )

  test("a handle from another Context is rejected before native access", () => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 1 })
    const other = lib.createContext({ objectCapacity: 1, renderCellsMax: 1 })
    try {
      const text = lib.createContextTextBuffer(context)
      expect(() => lib.contextTextBufferGetText(other, text)).toThrow("Context handle failed: WrongContext")
    } finally {
      lib.destroyContext(other)
      lib.destroyContext(context)
    }
  })

  test("destroying a buffer invalidates its views", () => {
    const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: 1 })
    const { renderLib: lib, context } = owner
    try {
      const text = TextBuffer.create("unicode", owner)
      const edit = EditBuffer.create("unicode", owner)
      const view = TextBufferView.create(text)
      const editor = EditorView.create(edit, 8, 2)
      const viewHandle = view._getSceneHandle(owner)
      const editorHandle = editor._getSceneHandle(owner)
      text.destroy()
      edit.destroy()
      expect(() => lib.contextTextBufferViewGetInfo(context, viewHandle)).toThrow("StaleHandle")
      expect(() => lib.contextEditorViewGetInfo(context, editorHandle)).toThrow("StaleHandle")
      expect(() => view.getPlainText()).toThrow("destroyed")
      expect(() => editor.getVirtualLineCount()).toThrow("destroyed")
      view.destroy()
      editor.destroy()
    } finally {
      owner.destroy()
    }
  })

  test("buffer leases retain their issuing library and release after callback failures", () => {
    const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: 4 })
    const lib = owner.renderLib
    const other = new FFIRenderLib()
    const buffer = OptimizedBuffer.create(2, 2, "unicode", { owner })
    try {
      const lease = lib.contextAcquireBufferLease(owner.context, buffer._getSceneHandle(owner))
      expect(() => other.contextReleaseBufferLease(owner.context, lease.handle)).toThrow()
      expect(() => owner.destroy()).toThrow("ContextBusy")
      lib.contextReleaseBufferLease(owner.context, lease.handle)
      expect(() => lib.contextReleaseBufferLease(owner.context, lease.handle)).toThrow("StaleHandle")
      const failure = new Error("leased callback failed")
      expect(() =>
        buffer.withBuffers(() => {
          throw failure
        }),
      ).toThrow(failure)
      const acquire = lib.contextAcquireBufferLease.bind(lib)
      const mapping = spyOn(lib, "contextAcquireBufferLease").mockImplementation((...args) => ({
        ...acquire(...args),
        get char(): never {
          throw failure
        },
      }))
      try {
        expect(() => buffer.withBuffers((cells) => cells.char[0])).toThrow(failure)
      } finally {
        mapping.mockRestore()
      }
      buffer.destroy()
      expect(() => owner.destroy()).not.toThrow()
    } finally {
      buffer.destroy()
      owner.destroy()
      other.dispose()
    }
  })

  test("Session buffer wrappers follow resized storage and reject destroyed owners", () => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 32 })
    try {
      const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
      lib.sessionAttachRenderer(context, session, { width: 4, height: 3, remote: true })
      const current = OptimizedBuffer.fromSession(lib, context, session, "current")
      const next = OptimizedBuffer.fromSession(lib, context, session, "next")
      const generation = current.withBuffers((cells) => cells.generation)
      lib.sessionResizeRenderer(context, session, 7, 2)
      for (const buffer of [current, next]) {
        expect([buffer.width, buffer.height]).toEqual([7, 2])
        buffer.withBuffers((cells) => {
          expect([cells.width, cells.height, cells.char.length]).toEqual([7, 2, 14])
          expect(cells.generation > generation).toBe(true)
        })
      }
      expect(current.getSpanLines()).toHaveLength(2)
      let retained = 0
      expect(() =>
        next.withBuffers((cells) => {
          const chars = cells.char
          chars[0] = 65
          lib.destroySession(context, session)
          const second = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
          expect(second.slot).toBe(session.slot)
          expect(second.generation).not.toBe(session.generation)
          lib.sessionAttachRenderer(context, second, { width: 4, height: 3, remote: true })
          const before = lib.sceneGetCursorState(context, second)
          expect(() => lib.sessionSetCursor(context, session, { position: { x: 2, y: 2, visible: true } })).toThrow(
            "StaleHandle",
          )
          expect(lib.sceneGetCursorState(context, second)).toEqual(before)
          retained = chars[0]
        }),
      ).toThrow("StaleLease")
      expect(retained).toBe(65)
      expect(() => current.withBuffers(() => {})).toThrow("StaleHandle")
      expect(() => lib.sessionSetCursor(context, session, { position: { x: 1, y: 1, visible: true } })).toThrow(
        "StaleHandle",
      )
      expect(() => lib.destroySession(context, session)).toThrow("StaleHandle")
    } finally {
      lib.destroyContext(context)
    }
  })

  test.each([
    [
      "a live Context",
      "ContextBusy",
      (lib: FFIRenderLib) => {
        const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 1 })
        return () => lib.destroyContext(context)
      },
    ],
    [
      "an active Yoga node",
      "Yoga nodes are active",
      (lib: FFIRenderLib) => {
        const config = Config.create(lib)
        const node = Node.create(config)
        return () => {
          node.free()
          config.free()
        }
      },
    ],
  ] as const)("a dispose refused by %s keeps audio engines", (_, reason, hold) => {
    const lib = new FFIRenderLib()
    const engine = lib.createAudioEngine()!
    const release = hold(lib)
    expect(() => lib.dispose()).toThrow(reason)
    expect(lib.audioGetStats(engine)).not.toBeNull()
    release()
    lib.dispose()
    expect(() => lib.createContext({ objectCapacity: 1, renderCellsMax: 1 })).toThrow("disposed")
  })

  test("the process log callback survives Worker exit and disposal of other libraries", () => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const runtimeArgs = "bun" in process.versions ? [] : process.execArgv.filter((arg) => !arg.startsWith("--test"))
    const child = spawnSync(
      process.execPath,
      [...runtimeArgs, fileURLToPath(new URL(`tests/native-log-worker-child.${extension}`, import.meta.url))],
      { encoding: "utf8", timeout: 10_000, env: { ...process.env, OTUI_GHOSTTY_LOG_LEVEL: "warn" } },
    )
    expect({ status: child.status, signal: child.signal, stdout: child.stdout.trim() }).toEqual({
      status: 0,
      signal: null,
      stdout: "native log survived",
    })
    expect(child.stderr).toContain("(stream) unimplemented CSI action")
  })

  test("render library path cannot change after native use", () => {
    resolveRenderLib()
    expect(() => setRenderLibPath("/tmp/opentui-unused-native-library.so")).toThrow(
      "setRenderLibPath() must be called before resolveRenderLib()",
    )
  })
})

describe("context diagnostics", () => {
  test("debugLogRope drains every queued record in order, and a level filter drains without logging", () => {
    const owner = new ResourceContext({ objectCapacity: 2, renderCellsMax: 1 })
    const { renderLib: lib, context } = owner
    const edit = EditBuffer.create("unicode", owner)
    const debug = spyOn(console, "debug").mockImplementation(() => {})
    try {
      edit.setText("ab")
      const handle = edit._getSceneHandle(owner)
      // Two rope dumps queue 12 records, more than one drain batch.
      lib.contextEditBufferCommand(context, handle, NativeEditCommand.DebugRope)
      edit.debugLogRope()
      const messages = debug.mock.calls.map(([message]) => message)
      expect(messages).toHaveLength(12)
      expect(messages.slice(6)).toEqual(messages.slice(0, 6))
      expect([messages[0], messages[1], messages[5]]).toEqual([
        "=== TextBuffer Rope Debug ===",
        "Line count: 1",
        "=== End Rope Debug ===",
      ])
      debug.mockClear()
      lib.contextEditBufferCommand(context, handle, NativeEditCommand.DebugRope)
      lib.logContextDiagnostics(context, LogLevel.Warn)
      lib.logContextDiagnostics(context)
      expect(debug).not.toHaveBeenCalled()
    } finally {
      debug.mockRestore()
      edit.destroy()
      owner.destroy()
    }
  })

  test("errors and warnings reach their console methods until a console handler destroys the Context", () => {
    const lib = resolveRenderLib()
    const symbols = (lib as unknown as { opentui: { symbols: Record<string, unknown> } }).opentui.symbols
    const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 1 })
    const record = nativeLayouts.ot_diagnostic
    const fields = nativeLayouts.ot_diagnostic_drain.fields
    // Levels cycle error, warning, info, debug; 9 records need two drain batches.
    const queued = Array.from({ length: 9 }, (_, index) => ({ level: index % 4, message: `record ${index}` }))
    const original = symbols.ot_context_drain_diagnostics
    symbols.ot_context_drain_diagnostics = (
      _: unknown,
      records: Uint32Array,
      capacity: number,
      out: BigUint64Array,
    ) => {
      const batch = queued.splice(0, capacity)
      batch.forEach(({ level, message }, index) => {
        const base = index * record.size
        const bytes = new TextEncoder().encode(message)
        records[(base + record.fields.level.offset) / 4] = level
        records[(base + record.fields.message_len.offset) / 4] = bytes.length
        new Uint8Array(records.buffer, records.byteOffset + base + record.fields.message.offset).set(bytes)
      })
      const words = new Uint32Array(out.buffer, out.byteOffset)
      words[fields.count.offset / 4] = batch.length
      words[fields.remaining.offset / 4] = queued.length
      return NativeStatus.Ok
    }
    const consoles = (["error", "warn", "info", "debug"] as const).map((name) => spyOn(console, name))
    consoles[1]!.mockImplementation((message) => {
      if (message === "record 5") lib.destroyContext(context)
    })
    for (const method of [consoles[0]!, ...consoles.slice(2)]) method.mockImplementation(() => {})
    try {
      lib.logContextDiagnostics(context, LogLevel.Warn)
      expect(consoles.map((method) => method.mock.calls.map(([message]) => message))).toEqual([
        ["record 0", "record 4"],
        ["record 1", "record 5"],
        [],
        [],
      ])
      expect(queued).toHaveLength(1)
    } finally {
      symbols.ot_context_drain_diagnostics = original
      for (const method of consoles) method.mockRestore()
    }
  })
})

describe("scene measure target ownership", () => {
  test.each(["buffers", "views"] as const)("scene measurement detaches when its %s are destroyed", (destroyed) => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 16, renderCellsMax: 32 })
    try {
      const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
      lib.sessionAttachRenderer(context, session, { width: 8, height: 4, remote: true })
      const root = lib.sceneCreateNode(context, session, "root", 1)
      const textNode = lib.sceneCreateNode(context, session, "text_view", 2)
      const editorNode = lib.sceneCreateNode(context, session, "editor", 3)
      lib.sceneMoveNode(context, textNode, root, 0)
      lib.sceneMoveNode(context, editorNode, root, 1)
      const text = lib.createContextTextBuffer(context)
      const textView = lib.createContextTextBufferView(context, text)
      const edit = lib.createContextEditBuffer(context)
      const editorView = lib.createContextEditorView(context, edit, 8, 4)
      lib.contextTextBufferSetText(context, text, Buffer.from("abc\ndef"))
      lib.contextEditBufferSetText(context, edit, Buffer.from("ghi\njkl"))
      const options = {
        background: RGBA.fromInts(0, 0, 0),
        useMouse: false,
        excludedHitNum: 0,
        maxLayoutRounds: 8,
        maxHostRequests: 64,
      }
      const readFrame = (frame: NativeSceneFrameRequest) => {
        expect(frame.kind).toBe(0)
        const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
        try {
          const bytes = new Uint8Array(128)
          const length = lib.contextBufferLeaseWriteResolvedChars(context, lease.handle, bytes, true)
          return lib.decoder.decode(bytes.subarray(0, length))
        } finally {
          lib.contextReleaseBufferLease(context, lease.handle)
        }
      }

      lib.sceneSetTextView(context, textNode, textView)
      lib.sceneSetEditorView(context, editorNode, editorView)
      let frame = lib.sceneFrameStep(context, session, null, options)
      expect(lib.sceneGetLayout(context, textNode).height).toBe(2)
      expect(lib.sceneGetLayout(context, editorNode).height).toBe(2)
      const paintedText = "abc     \ndef     \nghi     \njkl     \n"
      expect(readFrame(frame)).toBe(paintedText)
      lib.sceneFrameCancel(context, session, frame.frameId)
      expect(() => lib.sceneSetTextView(context, textNode, edit as never)).toThrow("WrongKind")
      expect(() => lib.sceneSetEditorView(context, editorNode, text as never)).toThrow("WrongKind")
      frame = lib.sceneFrameStep(context, session, null, options)
      expect(readFrame(frame)).toBe(paintedText)
      lib.sceneSetTextView(context, textNode, null)
      lib.sceneSetEditorView(context, editorNode, null)
      expect(lib.sceneHasMeasure(context, textNode)).toBe(false)
      expect(lib.sceneHasMeasure(context, editorNode)).toBe(false)
      lib.sceneSetTextView(context, textNode, textView)
      lib.sceneSetEditorView(context, editorNode, editorView)

      if (destroyed === "buffers") {
        lib.destroyContextTextBuffer(context, text)
        lib.destroyContextEditBuffer(context, edit)
      } else {
        lib.destroyContextTextBufferView(context, textView)
        lib.destroyContextEditorView(context, editorView)
      }
      expect(() => lib.sceneSetTextView(context, textNode, textView)).toThrow("StaleHandle")
      expect(() => lib.sceneSetEditorView(context, editorNode, editorView)).toThrow("StaleHandle")
      expect(readFrame(frame)).toBe(paintedText)
      lib.sceneFrameCancel(context, session, frame.frameId)
      frame = lib.sceneFrameStep(context, session, null, options)
      expect(readFrame(frame)).toBe("        \n".repeat(4))
      lib.sceneFrameCancel(context, session, frame.frameId)
      for (const node of [textNode, editorNode]) {
        expect(lib.sceneHasMeasure(context, node)).toBe(false)
        expect(lib.sceneGetLayout(context, node).height).toBe(1)
        lib.sceneDestroyNode(context, node)
        expect(() => lib.sceneGetLayout(context, node)).toThrow("StaleHandle")
        expect(() => lib.sceneDestroyNode(context, node)).toThrow("StaleHandle")
      }
    } finally {
      lib.destroyContext(context)
    }
  })
})
