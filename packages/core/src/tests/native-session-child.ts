import assert from "node:assert/strict"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { resolveNativeLibraryPath } from "#opentui/runtime-assets"
import {
  FFIRenderLib,
  NativeError,
  NativeSessionState,
  NativeStatus,
  type NativeContextHandle,
  type NativeSessionBufferLease,
  type SessionHandle,
} from "../zig.js"

const contextOptions = { objectCapacity: 2, renderCellsMax: 16 }
const sessionOptions = { chunkSize: 4, spanCapacity: 2, maxBytes: 8n }

switch (process.argv[2]) {
  case "contexts": {
    const owner = new FFIRenderLib()
    let other: FFIRenderLib | undefined
    let context: NativeContextHandle | null = null
    try {
      const peer = (other = new FFIRenderLib())
      const original = (context = owner.createContext(contextOptions))
      const config = owner.getYogaHost().getDefaultConfig()
      assert.equal(typeof original, "object")
      assert.throws(() => owner.dispose(), { status: NativeStatus.ContextBusy })
      config.assertAlive()
      const session = owner.createSession(original, sessionOptions)
      for (const invalid of [{ ...original }, null, 1n] as NativeContextHandle[]) {
        assert.throws(() => owner.destroyContext(invalid), NativeError)
      }
      assert.throws(() => peer.destroyContext(original), { status: NativeStatus.WrongContext })
      assert.throws(() => peer.createSession(original, sessionOptions), { status: NativeStatus.WrongContext })
      assert.throws(() => peer.sessionGetState(original, session), { status: NativeStatus.WrongContext })
      assert.equal(owner.sessionGetState(original, session), NativeSessionState.Open)
      const reentrant = {
        ...session,
        get generation() {
          owner.destroyContext(original)
          context = null
          return session.generation
        },
      }
      assert.throws(() => owner.sessionGetState(original, reentrant), { status: NativeStatus.WrongContext })
      context = owner.createContext(contextOptions)
      assert.notEqual(context, original)
      assert.throws(() => owner.destroyContext(original), { status: NativeStatus.WrongContext })
      assert.throws(() => owner.sessionGetState(context!, session), { status: NativeStatus.WrongContext })
      owner.destroyContext(context)
      context = null
      assert.throws(
        () =>
          owner.createContext({
            ...contextOptions,
            get objectCapacity() {
              owner.dispose()
              return 1
            },
          }),
        /disposed/,
      )
      assert.throws(() => owner.createContext(contextOptions), /disposed/)
      assert.throws(() => owner.sessionGetState(original, session), { status: NativeStatus.WrongContext })
    } finally {
      if (context) owner.destroyContext(context)
      owner.dispose()
      other?.dispose()
    }
    break
  }
  case "libraries": {
    const directory = mkdtempSync(join(process.env.OTUI_RUNTIME_ASSET_TEST_TMPDIR ?? tmpdir(), "opentui-session-"))
    const owners: {
      lib: FFIRenderLib
      context?: NativeContextHandle
      session?: SessionHandle
      lease?: NativeSessionBufferLease
    }[] = []
    try {
      const source = await resolveNativeLibraryPath()
      for (const name of ["first", "second"]) {
        const path = join(directory, `${name}-${basename(source)}`)
        copyFileSync(source, path)
        owners.push({ lib: new FFIRenderLib(path) })
        const owner = owners.at(-1)!
        owner.context = owner.lib.createContext(contextOptions)
        owner.session = owner.lib.createSession(owner.context, sessionOptions)
        owner.lib.sessionAttachRenderer(owner.context, owner.session, { width: 1, height: 1, remote: true })
        owner.lease = owner.lib.sessionAcquireBufferLease(owner.context, owner.session, "next")
      }
      const [{ lib: first, context: a, session: sa, lease: la }, { lib: second, context: b, session: sb, lease: lb }] =
        owners
      assert.ok(a && b && sa && sb && la && lb)
      assert.equal(sa.contextId, sb.contextId)
      assert.equal(sa.slot, sb.slot)
      assert.equal(sa.generation, sb.generation)
      assert.deepEqual(
        [la.handle.contextId, la.handle.slot, la.handle.generation],
        [lb.handle.contextId, lb.handle.slot, lb.handle.generation],
      )
      assert.throws(() => second.contextValidateBufferLease(b, { ...la.handle }), { status: NativeStatus.WrongContext })
      assert.throws(() => second.contextReleaseBufferLease(b, { ...la.handle }), { status: NativeStatus.WrongContext })
      assert.throws(() => second.contextValidateBufferLease(a, la.handle), { status: NativeStatus.WrongContext })
      first.contextValidateBufferLease(a, la.handle)
      second.contextValidateBufferLease(b, lb.handle)
      assert.throws(() => first.dispose(), { status: NativeStatus.ContextBusy })
      first.sessionWrite(a, sa, Uint8Array.of(65))
      second.sessionWrite(b, sb, Uint8Array.of(66))
      const firstOutput = new Uint8Array(1)
      const secondOutput = new Uint8Array(1)
      const ta = first.sessionReadOutput(a, sa, firstOutput)
      const tb = second.sessionReadOutput(b, sb, secondOutput)
      assert.ok(ta && tb)
      assert.equal(ta.requestId, tb.requestId)
      assert.equal(ta.byteCount, tb.byteCount)
      assert.deepEqual(firstOutput, Uint8Array.of(65))
      assert.deepEqual(secondOutput, Uint8Array.of(66))
      assert.throws(() => second.sessionWrite(b, { ...sa }, Uint8Array.of(99)), { status: NativeStatus.WrongContext })
      assert.throws(() => second.sessionCompleteOutput(b, sb, { ...ta, session: { ...ta.session } }, true), {
        status: NativeStatus.WrongContext,
      })
      assert.throws(() => second.sessionCompleteOutput(b, { ...sa }, tb, true), { status: NativeStatus.WrongContext })
      assert.throws(() => second.destroySession(b, { ...sa }), { status: NativeStatus.WrongContext })
      assert.equal(second.sessionGetState(b, sb), NativeSessionState.Open)
      assert.throws(() => second.sessionReadOutput(b, sb, secondOutput), { status: NativeStatus.OutputBusy })
      first.sessionCompleteOutput(a, { ...sa }, { ...ta, session: { ...ta.session } }, true)
      second.sessionCompleteOutput(b, { ...sb }, { ...tb, session: { ...tb.session } }, true)
      assert.equal(first.sessionReadOutput(a, sa, firstOutput), null)
      assert.equal(second.sessionReadOutput(b, sb, secondOutput), null)
    } finally {
      try {
        for (const { lib, context, session, lease } of owners) {
          if (context) {
            if (lease) lib.contextReleaseBufferLease(context, lease.handle)
            if (session) lib.sessionCancel(context, session)
            lib.destroyContext(context)
          }
          lib.dispose()
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    break
  }
  default:
    throw new Error(`Unknown native session scenario: ${process.argv[2]}`)
}

console.log("Native session lifecycle passed")
