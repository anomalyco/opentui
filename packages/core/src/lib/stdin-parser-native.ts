// Adapter over the native input parser (packages/native/src/input-parser.zig, see
// packages/native/docs/input-parser.md §12). The Session-owned parser frames and
// decodes the bytes; this file only feeds it, owns the timeout timer, and turns
// native records into the StdinEvent shapes the renderer consumes.

import { Buffer } from "node:buffer"
import { nativeConstants, nativeLayouts } from "../native-abi.generated.js"
import {
  NativeError,
  NativeStatus,
  resolveRenderLib,
  type NativeContextHandle,
  type RenderLib,
  type SessionHandle,
} from "../zig.js"
import { SystemClock, type Clock, type TimerHandle } from "./clock.js"
import { kittyKeyMap, printableKeypadText } from "./parse.keypress-kitty.js"
import type { ParsedKey } from "./parse.keypress.js"
import type { MouseEventType, RawMouseEvent } from "./parse.mouse.js"
import type {
  StdinEvent,
  StdinParserOptions,
  StdinParserProtocolContext,
  StdinResponseProtocol,
} from "./stdin-parser.js"

export interface NativeInputSession {
  lib: RenderLib
  context: NativeContextHandle
  session: SessionHandle
}

export interface NativeStdinParserOptions extends Pick<
  StdinParserOptions,
  "armTimeouts" | "onTimeoutFlush" | "protocolContext" | "clock"
> {
  /** Parse through this Session's input parser. Without one, the parser owns a private Context and Session. */
  session?: NativeInputSession
}

const RECORD_CAPACITY = 64
const PAYLOAD_CAPACITY = 16 * 1024
const RECORD = nativeLayouts.ot_input_event
const FIELD = {
  kind: RECORD.fields.kind.offset,
  action: RECORD.fields.action.offset,
  modifiers: RECORD.fields.modifiers.offset,
  flags: RECORD.fields.flags.offset,
  code: RECORD.fields.code.offset / 4,
  baseCode: RECORD.fields.base_code.offset / 4,
  x: RECORD.fields.x.offset / 2,
  y: RECORD.fields.y.offset / 2,
  rawOffset: RECORD.fields.raw_offset.offset / 4,
  rawLength: RECORD.fields.raw_len.offset / 4,
  textOffset: RECORD.fields.text_offset.offset / 4,
  textLength: RECORD.fields.text_len.offset / 4,
}
const C = nativeConstants
const EMPTY = new Uint8Array(0)
const UTF8 = new TextDecoder()
const MOUSE_TYPES: Record<number, MouseEventType> = {
  [C.OT_INPUT_MOUSE_DOWN]: "down",
  [C.OT_INPUT_MOUSE_UP]: "up",
  [C.OT_INPUT_MOUSE_MOVE]: "move",
  [C.OT_INPUT_MOUSE_DRAG]: "drag",
  [C.OT_INPUT_MOUSE_SCROLL]: "scroll",
}
const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const
const NO_EXPECTATIONS: StdinParserProtocolContext = {
  kittyKeyboardEnabled: false,
  privateCapabilityRepliesActive: false,
  pixelResolutionQueryActive: false,
  explicitWidthCprActive: false,
  startupCursorCprActive: false,
}
const REPLY_PROTOCOLS: Record<number, StdinResponseProtocol> = {
  [C.OT_INPUT_REPLY_CSI]: "csi",
  [C.OT_INPUT_REPLY_SS3]: "unknown",
  [C.OT_INPUT_REPLY_OSC]: "osc",
  [C.OT_INPUT_REPLY_DCS]: "dcs",
  [C.OT_INPUT_REPLY_APC]: "apc",
}
// Core's `code` for legacy sequences: the introducer, number, and final without modifiers.
const LEGACY_CODE_RE = /^\x1b+(O|\[\[?)(?:(\d+)(?:;\d+)?([~^$])|(?:1;)?\d*([a-zA-Z]))/
const LEGACY_SEQUENCE_RE = /^\x1b\x1b?[[O]/
const KEYPAD_TEXT = new Set(Object.values(printableKeypadText))

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")
}

function expectationFlags(context: StdinParserProtocolContext): number {
  const replies =
    context.privateCapabilityRepliesActive ||
    context.pixelResolutionQueryActive ||
    context.explicitWidthCprActive ||
    context.startupCursorCprActive
  return (
    (replies ? C.OT_INPUT_EXPECT_REPLIES : 0) | (context.kittyKeyboardEnabled ? C.OT_INPUT_EXPECT_KITTY_KEYBOARD : 0)
  )
}

/**
 * Same surface as StdinParser for renderer.ts, without the hooks that coordinated
 * parser and renderer state: a deferred reply has no deadline, so suspension, CPR
 * aborts, and pixel queries need no special handling.
 */
export class NativeStdinParser {
  private readonly lib: RenderLib
  private readonly context: NativeContextHandle
  private readonly session: SessionHandle
  private readonly ownsContext: boolean
  private readonly records = new Uint8Array(RECORD_CAPACITY * RECORD.size)
  private readonly words = new Uint32Array(this.records.buffer)
  private readonly halves = new Uint16Array(this.records.buffer)
  private readonly payload = new Uint8Array(PAYLOAD_CAPACITY)
  private readonly events: StdinEvent[] = []
  private readonly clock: Clock
  private readonly armTimeouts: boolean
  private readonly onTimeoutFlush: (() => void) | null
  private protocolContext: StdinParserProtocolContext
  private appliedExpectations = 0
  private timeoutId: TimerHandle | null = null
  private deadlineNs: bigint | null = null
  private lastNs = 0n
  private paste: Uint8Array[] | null = null
  // Input time stands still while suspended, so stale bytes drained on resume can still complete a unit.
  private suspended = false
  // A closed, failed, or destroyed Session parses nothing more; its input is dropped.
  private sessionGone = false
  private destroyed = false

  constructor(options: NativeStdinParserOptions = {}) {
    this.clock = options.clock ?? new SystemClock()
    this.armTimeouts = options.armTimeouts ?? true
    this.onTimeoutFlush = options.onTimeoutFlush ?? null
    this.protocolContext = { ...NO_EXPECTATIONS, ...options.protocolContext }
    if (options.session) {
      this.lib = options.session.lib
      this.context = options.session.context
      this.session = options.session.session
      this.ownsContext = false
    } else {
      this.lib = resolveRenderLib()
      this.context = this.lib.createContext({ objectCapacity: 4, renderCellsMax: 1 })
      try {
        this.session = this.lib.createSession(this.context, { chunkSize: 4096, spanCapacity: 2, maxBytes: 8192n })
      } catch (error) {
        this.destroyContext()
        throw error
      }
      this.ownsContext = true
    }
    try {
      this.applyExpectations()
    } catch (error) {
      if (this.ownsContext) this.destroyContext()
      throw error
    }
  }

  public updateProtocolContext(patch: Partial<StdinParserProtocolContext>): void {
    this.ensureAlive()
    this.protocolContext = { ...this.protocolContext, ...patch }
    this.native(() => {
      this.applyExpectations()
      // Changed expectations can end a deferred unit; native emits it on the next feed.
      this.feed(EMPTY, this.nowNs())
    })
    this.reconcileTimeout()
  }

  public push(data: Uint8Array): void {
    this.ensureAlive()
    this.native(() => this.feed(data, this.nowNs()))
    this.reconcileTimeout()
  }

  public read(): StdinEvent | null {
    this.ensureAlive()
    return this.events.shift() ?? null
  }

  public drain(onEvent: (event: StdinEvent) => void): void {
    this.ensureAlive()
    while (!this.destroyed) {
      const event = this.events.shift()
      if (!event) return
      onEvent(event)
    }
  }

  /** Resolves a partial unit whose deadline has passed at `nowMsValue`. */
  public flushTimeout(nowMsValue: number = this.clock.now()): void {
    this.ensureAlive()
    this.native(() => this.feed(EMPTY, this.toNs(nowMsValue)))
    this.reconcileTimeout()
  }

  /** Stops input time and the timer: a unit pending at suspension can still complete on resume. */
  public suspend(): void {
    this.ensureAlive()
    this.suspended = true
    this.clearTimeout()
  }

  /**
   * Call after feeding the input drained on resume. Units that still wait for
   * their timeout are stale and resolve now; deferred replies keep waiting.
   */
  public resume(): void {
    this.ensureAlive()
    this.suspended = false
    const deadline = this.deadlineNs
    if (deadline !== null) this.native(() => this.feed(EMPTY, deadline > this.lastNs ? deadline : this.lastNs))
    this.reconcileTimeout()
  }

  public reset(): void {
    if (this.destroyed) return
    this.clearTimeout()
    this.native(() => this.lib.sessionInputReset(this.context, this.session))
    this.events.length = 0
    this.paste = null
    this.deadlineNs = null
  }

  public destroy(): void {
    if (this.destroyed) return
    this.clearTimeout()
    this.destroyed = true
    this.events.length = 0
    this.paste = null
    if (this.ownsContext) this.destroyContext()
  }

  private ensureAlive(): void {
    if (this.destroyed) throw new Error("StdinParser has been destroyed")
  }

  /** Runs a native call. A Session or Context that closed, failed, or was destroyed ends parsing quietly. */
  private native(call: () => void): void {
    if (this.sessionGone) return
    try {
      call()
    } catch (error) {
      if (
        !(error instanceof NativeError) ||
        (error.status !== NativeStatus.SessionClosed &&
          error.status !== NativeStatus.OutputFailed &&
          error.status !== NativeStatus.StaleHandle &&
          error.status !== NativeStatus.WrongContext)
      ) {
        throw error
      }
      this.sessionGone = true
      this.deadlineNs = null
      this.paste = null
      this.clearTimeout()
    }
  }

  private destroyContext(): void {
    this.lib.getYogaHost().runMutation(() => this.lib.destroyContext(this.context))
  }

  private applyExpectations(): void {
    const flags = expectationFlags(this.protocolContext)
    if (flags === this.appliedExpectations) return
    this.lib.sessionInputExpect(this.context, this.session, flags)
    this.appliedExpectations = flags
  }

  // Feeds share one monotonic clock; a clock that steps back holds at the last time.
  private toNs(ms: number): bigint {
    const ns = BigInt(Math.max(0, Math.round(ms * 1_000_000)))
    return ns > this.lastNs ? ns : this.lastNs
  }

  private nowNs(): bigint {
    return this.suspended ? this.lastNs : this.toNs(this.clock.now())
  }

  private feed(bytes: Uint8Array, nowNs: bigint): void {
    this.lastNs = nowNs
    let offset = 0
    do {
      const rest = offset === 0 ? bytes : bytes.subarray(offset)
      const drain = this.lib.sessionInputFeed(this.context, this.session, rest, nowNs, this.records, this.payload)
      this.deadlineNs = drain.deadlineNs
      for (let index = 0; index < drain.count; index++) this.translate(index)
      // A call that only reported an expiry can consume nothing; one that does neither is stuck.
      if (drain.consumed === 0 && drain.count === 0 && offset < bytes.length) {
        throw new Error("native input parser made no progress")
      }
      offset += drain.consumed
    } while (offset < bytes.length)
  }

  private reconcileTimeout(): void {
    if (!this.armTimeouts) return
    this.clearTimeout()
    const deadline = this.deadlineNs
    if (deadline === null || this.suspended || this.sessionGone) return
    // The feed that reported the deadline already expired anything due at lastNs.
    const delayMs = Number((deadline - this.lastNs + 999_999n) / 1_000_000n)
    this.timeoutId = this.clock.setTimeout(() => {
      this.timeoutId = null
      if (this.destroyed) return
      try {
        // The timer is the host's statement that the deadline passed, even when
        // its clock sample disagrees slightly with the scheduler's.
        const now = this.nowNs()
        this.native(() => this.feed(EMPTY, now < deadline ? deadline : now))
        this.reconcileTimeout()
        this.onTimeoutFlush?.()
      } catch (error) {
        console.error("stdin parser timeout flush failed", error)
      }
    }, delayMs)
  }

  private clearTimeout(): void {
    if (this.timeoutId === null) return
    this.clock.clearTimeout(this.timeoutId)
    this.timeoutId = null
  }

  private span(offset: number, length: number): Uint8Array {
    return this.payload.subarray(offset, offset + length)
  }

  private translate(index: number): void {
    const base = index * RECORD.size
    const word = base / 4
    const half = base / 2
    const kind = this.records[base + FIELD.kind]!
    const action = this.records[base + FIELD.action]!
    const modifiers = this.records[base + FIELD.modifiers]!
    const flags = this.records[base + FIELD.flags]!
    const code = this.words[word + FIELD.code]!
    const raw = this.span(this.words[word + FIELD.rawOffset]!, this.words[word + FIELD.rawLength]!)
    const text = this.span(this.words[word + FIELD.textOffset]!, this.words[word + FIELD.textLength]!)
    switch (kind) {
      case C.OT_INPUT_KEY: {
        const key = parsedKey(code, this.words[word + FIELD.baseCode]!, action, modifiers, flags, raw, text)
        this.events.push({ type: "key", raw: key.raw, key })
        return
      }
      case C.OT_INPUT_MOUSE: {
        const sequence = latin1(raw)
        const encoding = raw[2] === 0x3c ? "sgr" : "x10"
        const event = rawMouseEvent(
          action,
          code,
          this.halves[half + FIELD.x]!,
          this.halves[half + FIELD.y]!,
          modifiers,
          encoding,
        )
        this.events.push({ type: "mouse", raw: sequence, encoding, event })
        return
      }
      case C.OT_INPUT_PASTE: {
        if (flags & C.OT_INPUT_PASTE_START) this.paste = []
        // The payload buffer is reused by the next feed.
        if (text.length > 0) this.paste!.push(Uint8Array.from(text))
        if (flags & C.OT_INPUT_PASTE_END) {
          const parts = this.paste!
          this.paste = null
          this.events.push({ type: "paste", bytes: parts.length === 1 ? parts[0]! : concat(parts) })
        }
        return
      }
      case C.OT_INPUT_FOCUS:
        // The renderer's focus handler matches the raw sequence.
        this.events.push({ type: "response", protocol: "csi", sequence: latin1(raw) })
        return
      case C.OT_INPUT_REPLY: {
        const protocol: StdinResponseProtocol =
          flags & C.OT_INPUT_REPLY_CURSOR_POSITION
            ? "cpr"
            : flags & C.OT_INPUT_REPLY_FRAGMENT
              ? "unknown"
              : REPLY_PROTOCOLS[code]!
        this.events.push({ type: "response", protocol, sequence: latin1(raw) })
        return
      }
    }
    throw new Error(`Unknown native input event kind: ${kind}`)
  }
}

/** Core's raw string: UTF-8, with a lone eight-bit Alt byte spelled as ESC + ASCII. */
function keyRaw(raw: Uint8Array): string {
  if (raw.length === 1 && raw[0]! >= 0x80) return "\x1b" + String.fromCharCode(raw[0]! & 0x7f)
  return UTF8.decode(raw)
}

function compatCode(raw: string, code: number, kitty: boolean): string | undefined {
  if (kitty) {
    if (!raw.endsWith("u") || kittyKeyMap[code] === undefined) return undefined
    return `[${/^\x1b+\[(\d+)/.exec(raw)![1]}u`
  }
  if (kittyKeyMap[code] === undefined && !KEYPAD_TEXT.has(String.fromCodePoint(code))) return undefined
  const match = LEGACY_CODE_RE.exec(raw)
  return match ? [match[1], match[2], match[3], match[4]].filter(Boolean).join("") : undefined
}

function parsedKey(
  code: number,
  baseCode: number,
  action: number,
  modifiers: number,
  flags: number,
  rawBytes: Uint8Array,
  textBytes: Uint8Array,
): ParsedKey {
  const kitty = (flags & C.OT_INPUT_KEY_KITTY) !== 0
  const raw = keyRaw(rawBytes)
  const text = textBytes.length === 0 ? "" : UTF8.decode(textBytes)
  const alt = (modifiers & C.OT_INPUT_MOD_ALT) !== 0
  // Core sets option for a modifier parameter or an `ESC ESC` key sequence, not for ESC + character.
  const option = alt && (kitty || LEGACY_SEQUENCE_RE.test(raw))
  let shift = (modifiers & C.OT_INPUT_MOD_SHIFT) !== 0
  let name: string
  if (code === 0) {
    name = text
  } else if (kittyKeyMap[code] !== undefined) {
    // Core distinguishes a raw line feed from Enter.
    name = code === C.OT_INPUT_KEY_ENTER && !kitty && raw.endsWith("\n") ? "linefeed" : kittyKeyMap[code]!
  } else if (code === 0x20) {
    name = "space"
  } else {
    name = String.fromCodePoint(code)
    // Core names a typed uppercase letter by its lowercase key with Shift; Alt keeps the case.
    if (!kitty && code >= 0x41 && code <= 0x5a) {
      shift = true
      if (!alt) name = name.toLowerCase()
    }
  }
  const key: ParsedKey = {
    name,
    ctrl: (modifiers & C.OT_INPUT_MOD_CTRL) !== 0,
    meta: alt || (modifiers & C.OT_INPUT_MOD_META) !== 0,
    shift,
    option,
    sequence: text || raw,
    number: /^[0-9]$/.test(name),
    raw,
    eventType: action === C.OT_INPUT_KEY_RELEASE ? "release" : "press",
    source: kitty ? "kitty" : "raw",
    super: (modifiers & C.OT_INPUT_MOD_SUPER) !== 0,
    hyper: (modifiers & C.OT_INPUT_MOD_HYPER) !== 0,
    capsLock: (modifiers & C.OT_INPUT_MOD_CAPS_LOCK) !== 0,
    numLock: (modifiers & C.OT_INPUT_MOD_NUM_LOCK) !== 0,
  }
  if (action === C.OT_INPUT_KEY_REPEAT) key.repeated = true
  if (baseCode !== 0) key.baseCode = baseCode
  const legacy = compatCode(raw, code, kitty)
  if (legacy !== undefined) key.code = legacy
  return key
}

function rawMouseEvent(
  action: number,
  code: number,
  x: number,
  y: number,
  modifiers: number,
  encoding: "sgr" | "x10",
): RawMouseEvent {
  const type = MOUSE_TYPES[action]
  if (!type) throw new Error(`Unknown native mouse action: ${action}`)
  // Core's button numbers: SGR motion and wheels without a button report 0, X10 motion -1.
  let button = code
  if (code === C.OT_INPUT_MOUSE_BUTTON_NONE) button = encoding === "x10" ? -1 : 0
  if (type === "scroll") button = encoding === "x10" || code === 3 ? 0 : code
  const event: RawMouseEvent = {
    type,
    button,
    x,
    y,
    modifiers: {
      shift: (modifiers & C.OT_INPUT_MOD_SHIFT) !== 0,
      alt: (modifiers & C.OT_INPUT_MOD_ALT) !== 0,
      ctrl: (modifiers & C.OT_INPUT_MOD_CTRL) !== 0,
    },
  }
  if (type === "scroll") event.scroll = { direction: SCROLL_DIRECTIONS[code & 3]!, delta: 1 }
  return event
}

const SHADOW_BACKLOG_MAX = 256

function describeEvent(event: StdinEvent): string {
  switch (event.type) {
    case "key": {
      const { name, ctrl, meta, shift, eventType } = event.key
      return JSON.stringify(["key", event.raw, name, ctrl, meta, shift, eventType])
    }
    case "mouse": {
      const { type, button, x, y, modifiers } = event.event
      return JSON.stringify(["mouse", event.raw, type, button, x, y, modifiers.shift, modifiers.alt, modifiers.ctrl])
    }
    case "paste":
      return JSON.stringify(["paste", event.bytes.length, Buffer.from(event.bytes).toString("base64")])
    case "response":
      return JSON.stringify(["response", event.protocol, event.sequence])
  }
}

/**
 * Pairs the events of the delivering parser with the events of a parser that only
 * sees the same input (OTUI_NATIVE_INPUT_SHADOW) and logs one line per difference.
 * Events pair in order, so the parsers' separate timers cannot misalign them.
 */
export class StdinShadowComparator {
  private readonly delivered: string[] = []
  private readonly shadowed: string[] = []

  constructor(
    private readonly primaryName: "legacy" | "native",
    private readonly log: (line: string) => void,
  ) {}

  public primary(event: StdinEvent): void {
    this.queue(this.delivered, event)
  }

  public shadow(event: StdinEvent): void {
    this.queue(this.shadowed, event)
  }

  private queue(events: string[], event: StdinEvent): void {
    events.push(describeEvent(event))
    while (this.delivered.length > 0 && this.shadowed.length > 0) {
      const delivered = this.delivered.shift()!
      const shadowed = this.shadowed.shift()!
      if (delivered !== shadowed) this.report(delivered, shadowed)
    }
    // A parser that stopped producing events must not grow the other's backlog forever.
    if (events.length > SHADOW_BACKLOG_MAX) {
      const dropped = events.shift()!
      if (events === this.delivered) this.report(dropped, "")
      else this.report("", dropped)
    }
  }

  private report(delivered: string, shadowed: string): void {
    const shadowName = this.primaryName === "native" ? "legacy" : "native"
    this.log(`[stdin-shadow] ${this.primaryName}=${delivered || "none"} ${shadowName}=${shadowed || "none"}`)
  }
}
