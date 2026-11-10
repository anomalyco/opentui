import { extend } from "@opentui/react"
import { QRCodeRenderable } from "./renderables/QRCode.js"

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "qr-code": typeof QRCodeRenderable
  }
}

export function registerQRCode(): void {
  extend({ "qr-code": QRCodeRenderable })
}

export * from "./index.js"
