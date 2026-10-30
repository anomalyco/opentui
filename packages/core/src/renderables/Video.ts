import type { OptimizedBuffer } from "../buffer.js"
import { Renderable, type NativeRenderableIntegration, type RenderableOptions } from "../Renderable.js"
import type { RenderContext } from "../types.js"
import type { NativeVideoState } from "../zig.js"
import type { ImageFit } from "./Image.js"

export interface VideoMetadata {
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
}

export interface VideoRenderableOptions extends RenderableOptions<VideoRenderable> {
  /** Path of an MP4 (H.264/AAC) file. */
  source?: string
  fit?: ImageFit
  /** Plays each source once it opens. */
  autoplay?: boolean
  loop?: boolean
  muted?: boolean
  volume?: number
  /** Positive values show frames earlier relative to the audio. */
  avSyncOffsetMs?: number
  /** Upper bound of the presentation rate, an integer from 1 to 120. Defaults to 30. */
  maxFps?: number
  onReady?: (metadata: VideoMetadata) => void
  onError?: (error: Error) => void
  onEnd?: () => void
  onPlay?: () => void
  onPause?: () => void
  onSeek?: (time: number) => void
  onTimeUpdate?: (time: number) => void
}

// Native code takes the volume as a 32-bit float and the offset within ±60 s.
function validateVolume(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 3.4028234663852886e38)
    throw new RangeError("volume must be a finite, non-negative 32-bit float")
}

function validateAvSyncOffset(value: number): void {
  if (!Number.isFinite(value) || Math.abs(value) > 60_000)
    throw new RangeError("avSyncOffsetMs must be from -60000 to 60000")
}

function validateMaxFps(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 120)
    throw new RangeError("maxFps must be an integer from 1 to 120")
}

function toMicroseconds(seconds: number, label: string): bigint {
  const value = Math.round(seconds * 1_000_000)
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(value)) throw new RangeError(`${label} must be finite`)
  return BigInt(value)
}

/**
 * Plays a video file in a native scene node. Decoding, the media clock, and frame drawing stay native;
 * this wrapper sends control calls and reads playback state on the animation clock while playing.
 */
export class VideoRenderable extends Renderable {
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    kind: "video",
    body: { native: this.prototype.renderSelf, buffered: true },
    bufferComposition: "native",
  }

  private _source: string | undefined
  private _fit: ImageFit
  private _loop: boolean
  private _muted: boolean
  private _volume: number
  private _avSyncOffsetMs: number
  private _maxFps: number
  private _autoplay: boolean
  private _metadata: VideoMetadata | null = null
  // Playback requested while no source is open; native state is the truth once one is.
  private _playRequested = false
  // Playback polls native state on the renderer's animation clock, drawn or not.
  private stopTick?: () => void
  // Counts reported pauses, so a deferred onPlay that a pause overtook is dropped.
  private _pauses = 0
  public onReady?: (metadata: VideoMetadata) => void
  public onError?: (error: Error) => void
  public onEnd?: () => void
  public onPlay?: () => void
  public onPause?: () => void
  public onSeek?: (time: number) => void
  public onTimeUpdate?: (time: number) => void

  constructor(ctx: RenderContext, options: VideoRenderableOptions) {
    super(ctx, options)
    try {
      this._fit = options.fit ?? "fit"
      this._loop = options.loop ?? false
      this._muted = options.muted ?? false
      this._volume = options.volume ?? 1
      validateVolume(this._volume)
      this._avSyncOffsetMs = options.avSyncOffsetMs ?? 0
      validateAvSyncOffset(this._avSyncOffsetMs)
      this._maxFps = options.maxFps ?? 30
      validateMaxFps(this._maxFps)
      this._autoplay = options.autoplay ?? false
      this.onReady = options.onReady
      this.onError = options.onError
      this.onEnd = options.onEnd
      this.onPlay = options.onPlay
      this.onPause = options.onPause
      this.onSeek = options.onSeek
      this.onTimeUpdate = options.onTimeUpdate
      this.setNativeSceneVideo()
      if (options.source !== undefined) this.source = options.source
    } catch (error) {
      this.abortConstruction(error, () => this.destroySelf())
    }
  }

  public get source(): string | undefined {
    return this._source
  }

  /** Opens a new source; playback intent carries over to it. */
  public set source(value: string | null | undefined) {
    value ??= undefined
    // The same source opens again after a playback failure.
    if ((value === this._source && !this.failed()) || this.isDestroyed) return
    this.open(value, this.playing)
  }

  private open(value: string | undefined, resume: boolean): void {
    this._source = value
    this._metadata = null
    this._playRequested = resume
    const native = this.native()
    try {
      const info = native.lib.videoOpen(native.context, native.node, value ?? "")
      // An empty path closes the player, like no source.
      if (!value) return
      this._playRequested = false
      this._metadata = {
        width: info.width,
        height: info.height,
        fps: info.fpsDen > 0 ? info.fpsNum / info.fpsDen : 0,
        duration: Number(info.durationUs) / 1_000_000,
        hasAudio: info.hasAudio,
      }
      native.lib.videoSetLoop(native.context, native.node, this._loop)
      native.lib.videoSetMuted(native.context, native.node, this._muted)
      native.lib.videoSetVolume(native.context, native.node, this._volume)
      native.lib.videoSetAvSyncOffset(
        native.context,
        native.node,
        toMicroseconds(this._avSyncOffsetMs / 1000, "avSyncOffsetMs"),
      )
      native.lib.videoSetMaxFps(native.context, native.node, this._maxFps)
      const play = resume || this._autoplay
      if (play) native.lib.videoCall(native.context, native.node, "ot_video_play")
      const metadata = { ...this._metadata }
      // Frameworks assign handlers after the source; report the open once they are set.
      const pauses = this._pauses
      this.afterOpen(value, () => {
        this.onReady?.(metadata)
        // A pause before this report already told handlers; a stale onPlay would contradict it.
        if (play && pauses === this._pauses) this.onPlay?.()
      })
    } catch (error) {
      this._metadata = null
      this._playRequested = false
      const detail = this.errorDetail("")
      this.afterOpen(value, () => this.reportError(error, detail))
    } finally {
      this.syncPlayback()
      this.requestRender()
    }
  }

  public get fit(): ImageFit {
    return this._fit
  }

  public set fit(value: ImageFit | null | undefined) {
    const next = value ?? "fit"
    if (this._fit === next || this.isDestroyed) return
    this.setNativeSceneVideo(next)
    this._fit = next
    this.requestRender()
  }

  public get loop(): boolean {
    return this._loop
  }

  public set loop(value: boolean | null | undefined) {
    const next = value ?? false
    if (this._loop === next || this.isDestroyed) return
    if (this.applyOption((native) => native.lib.videoSetLoop(native.context, native.node, next))) this._loop = next
  }

  public get muted(): boolean {
    return this._muted
  }

  public set muted(value: boolean | null | undefined) {
    const next = value ?? false
    if (this._muted === next || this.isDestroyed) return
    if (this.applyOption((native) => native.lib.videoSetMuted(native.context, native.node, next))) this._muted = next
  }

  public get volume(): number {
    return this._volume
  }

  public set volume(value: number | null | undefined) {
    const next = value ?? 1
    validateVolume(next)
    if (this._volume === next || this.isDestroyed) return
    if (this.applyOption((native) => native.lib.videoSetVolume(native.context, native.node, next))) this._volume = next
  }

  public get avSyncOffsetMs(): number {
    return this._avSyncOffsetMs
  }

  public set avSyncOffsetMs(value: number | null | undefined) {
    const next = value ?? 0
    validateAvSyncOffset(next)
    if (this._avSyncOffsetMs === next || this.isDestroyed) return
    const offset = toMicroseconds(next / 1000, "avSyncOffsetMs")
    if (this.applyOption((native) => native.lib.videoSetAvSyncOffset(native.context, native.node, offset)))
      this._avSyncOffsetMs = next
  }

  public get maxFps(): number {
    return this._maxFps
  }

  public set maxFps(value: number | null | undefined) {
    const next = value ?? 30
    validateMaxFps(next)
    if (this._maxFps === next || this.isDestroyed) return
    if (!this.applyOption((native) => native.lib.videoSetMaxFps(native.context, native.node, next))) return
    this._maxFps = next
    this.syncPlayback()
  }

  /** Applies to the next source that opens, and to an open source that has not started yet. */
  public get autoplay(): boolean {
    return this._autoplay
  }

  public set autoplay(value: boolean | null | undefined) {
    const next = value ?? false
    if (this._autoplay === next || this.isDestroyed) return
    this._autoplay = next
    // Frameworks may set autoplay after the source.
    if (!next || !this._metadata) return
    const started = this.control((native) => {
      const state = native.lib.videoGetState(native.context, native.node)
      if (state.playing || state.ended || state.currentTimeUs !== 0n) return false
      native.lib.videoCall(native.context, native.node, "ot_video_play")
    })
    // Handlers may follow autoplay as well.
    const pauses = this._pauses
    if (started) this.afterOpen(this._source, () => pauses === this._pauses && this.onPlay?.())
  }

  public get ready(): boolean {
    return this._metadata !== null
  }

  public get videoMetadata(): Readonly<VideoMetadata> | null {
    return this._metadata ? { ...this._metadata } : null
  }

  public get playing(): boolean {
    if (this.isDestroyed) return false
    return this._metadata ? this.readState().playing : this._playRequested
  }

  public get paused(): boolean {
    return !this.playing
  }

  public get ended(): boolean {
    return this._metadata !== null && !this.isDestroyed && this.readState().ended
  }

  public get duration(): number {
    return this._metadata?.duration ?? 0
  }

  public get durationMs(): number {
    return this.duration * 1000
  }

  public get currentTime(): number {
    if (!this._metadata || this.isDestroyed) return 0
    return Number(this.readState().currentTimeUs) / 1_000_000
  }

  /** Seeks; a nullish write is ignored. */
  public set currentTime(value: number | null | undefined) {
    if (value == null) return
    this.seek(value)
  }

  /** Adaptive quality tier: 0 decodes at full size; higher tiers decode smaller while output cannot keep up. */
  public get qualityTier(): number {
    if (!this._metadata || this.isDestroyed) return 0
    return this.readState().qualityTier
  }

  public get currentTimeMs(): number {
    return this.currentTime * 1000
  }

  public play(): void {
    if (this.isDestroyed) return
    if (!this._metadata) {
      // A failed open retries and reports its failure again.
      if (this._source !== undefined) this.open(this._source, true)
      else this._playRequested = true
      return
    }
    const started = this.control((native) => {
      if (native.lib.videoGetState(native.context, native.node).playing) return false
      native.lib.videoCall(native.context, native.node, "ot_video_play")
    })
    if (started) this.onPlay?.()
  }

  public resume(): void {
    this.play()
  }

  public pause(): void {
    if (this.isDestroyed) return
    if (!this._metadata) {
      this._playRequested = false
      return
    }
    const paused = this.control((native) => {
      if (!native.lib.videoGetState(native.context, native.node).playing) return false
      native.lib.videoCall(native.context, native.node, "ot_video_pause")
    })
    if (!paused) return
    this._pauses++
    const time = this.currentTime
    this.onPause?.()
    this.onTimeUpdate?.(time)
  }

  public toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  public seek(time: number): void {
    const target = toMicroseconds(time, "Video time")
    if (!this._metadata || this.isDestroyed) return
    if (!this.control((native) => native.lib.videoSeek(native.context, native.node, target))) return
    const position = this.currentTime
    this.onSeek?.(position)
    this.onTimeUpdate?.(position)
  }

  public seekBy(delta: number): void {
    if (!Number.isFinite(delta)) throw new RangeError("Video seek delta must be finite")
    this.seek(this.currentTime + delta)
  }

  public seekToMs(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) throw new RangeError("Video time must be finite")
    this.seek(milliseconds / 1000)
  }

  protected override createFrameBuffer(): void {
    const previous = this.frameBuffer
    super.createFrameBuffer()
    // Base construction can allocate before Video options are initialized.
    if (this._fit === undefined || this.frameBuffer === previous) return
    this.setNativeSceneVideo()
  }

  // Native code draws the frame; this keeps the body native.
  protected renderSelf(_buffer: OptimizedBuffer): void {}

  private poll(): void {
    if (!this._metadata || this.isDestroyed) return
    let state: NativeVideoState
    try {
      state = this.readState()
    } catch (error) {
      this.reportError(error)
      this.syncPlayback(false)
      return
    }
    if (state.failed) {
      this.reportError(new Error(this.errorDetail("Video playback failed")))
      this.syncPlayback()
      return
    }
    this.onTimeUpdate?.(Number(state.currentTimeUs) / 1_000_000)
    if (state.ended) {
      this.syncPlayback()
      this.onEnd?.()
    }
  }

  private native() {
    return this._ctx.nativeScene.videoNode(this)
  }

  private readState(): NativeVideoState {
    const native = this.native()
    return native.lib.videoGetState(native.context, native.node)
  }

  // Playback failed after a successful open. Frameworks may assign the same source again
  // while mounting, so a failed open retries through play() instead.
  private failed(): boolean {
    if (!this._metadata) return false
    try {
      return this.readState().failed
    } catch {
      return true
    }
  }

  private errorDetail(fallback: string): string {
    try {
      const native = this.native()
      return native.lib.videoGetError(native.context, native.node) || fallback
    } catch {
      return fallback
    }
  }

  // Without a player the option waits for the next open, which applies every stored option.
  // Returns false when the call failed, so the option keeps its applied value.
  private applyOption(call: (native: ReturnType<VideoRenderable["native"]>) => void): boolean {
    return !this._metadata || this.control(call)
  }

  // Returns false when the call failed, which is reported, or returned false.
  private control(call: (native: ReturnType<VideoRenderable["native"]>) => false | void): boolean {
    let reported = false
    try {
      return call(this.native()) !== false
    } catch (error) {
      reported = true
      this.reportError(error)
      return false
    } finally {
      this.syncPlayback(!reported)
      this.requestRender()
    }
  }

  // Playback ticks at maxFps, which paints each frame and advances, ends or loops playback. A
  // caller that already reported a failure passes report = false, so it reports once.
  private syncPlayback(report = true): void {
    if (this.isDestroyed) return
    let active = false
    try {
      active = this._metadata !== null && this.readState().playing
    } catch (error) {
      if (report) this.reportError(error)
    }
    this.stopTick?.()
    this.stopTick = active ? this._ctx.onAnimationTick(this._maxFps, () => this.poll()) : undefined
  }

  private setNativeSceneVideo(fit: ImageFit = this._fit): void {
    this._ctx.nativeScene.setVideo(this, fit, this.buffered ? this.frameBuffer : null)
  }

  private afterOpen(source: string | undefined, report: () => void): void {
    queueMicrotask(() => {
      if (this._source === source && !this.isDestroyed) report()
    })
  }

  private reportError(error: unknown, detail = this.errorDetail("")): void {
    const value = error instanceof Error ? error : new Error(String(error))
    this.onError?.(detail && !value.message.includes(detail) ? new Error(`${value.message}: ${detail}`) : value)
  }

  protected destroySelf(): void {
    this.runCleanup((run) => {
      run(() => this.stopTick?.())
      run(() => super.destroySelf())
    })
  }
}
