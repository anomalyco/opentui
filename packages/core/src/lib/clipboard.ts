// OSC 52 clipboard support for terminal applications.
// Delegates to native Zig implementation for ANSI sequence generation.

import type { RendererHandle, RenderLib } from "../zig.js"

export enum ClipboardTarget {
  Clipboard = 0,
  Primary = 1,
  Secondary = 2,
  Query = 3,
}

export function encodeOsc52Payload(text: string, encoder: TextEncoder = new TextEncoder()): Uint8Array {
  const base64 = Buffer.from(text).toString("base64")
  return encoder.encode(base64)
}

export class Clipboard {
  private lib: RenderLib
  private rendererPtr: RendererHandle

  constructor(lib: RenderLib, rendererPtr: RendererHandle) {
    this.lib = lib
    this.rendererPtr = rendererPtr
  }

  public copyToClipboardOSC52(text: string, target: ClipboardTarget = ClipboardTarget.Clipboard): boolean {
    if (!this.isOsc52Supported()) {
      return false
    }
    const payload = encodeOsc52Payload(text, this.lib.encoder)
    return this.lib.copyToClipboardOSC52(this.rendererPtr, target, payload)
  }

  public clearClipboardOSC52(target: ClipboardTarget = ClipboardTarget.Clipboard): boolean {
    if (!this.isOsc52Supported()) {
      return false
    }
    return this.lib.clearClipboardOSC52(this.rendererPtr, target)
  }

  public isOsc52Supported(): boolean {
    const caps = this.lib.getTerminalCapabilities(this.rendererPtr)
    return Boolean(caps?.osc52)
  }
}
