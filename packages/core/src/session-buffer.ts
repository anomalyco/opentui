import type {
  NativeContextBufferLease,
  NativeContextHandle,
  NativeSceneFrameRequest,
  RenderLib,
  SessionBuffer,
  SessionHandle,
} from "./zig.js"

/** @internal Acquires Session storage, optionally qualified by a painted scene ticket.
 * Release with contextReleaseBufferLease on every exit path, including stale validation. */
export function acquireSessionBufferLease(
  lib: RenderLib,
  context: NativeContextHandle,
  session: SessionHandle,
  which: SessionBuffer,
  frame: NativeSceneFrameRequest | null = null,
): NativeContextBufferLease {
  return frame
    ? lib.sceneFrameAcquireBufferLease(context, session, frame, which)
    : lib.sessionAcquireBufferLease(context, session, which)
}
