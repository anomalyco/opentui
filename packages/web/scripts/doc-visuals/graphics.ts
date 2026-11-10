import {
  ASCIIFontRenderable,
  EmbeddedTerminalRenderable,
  FrameBufferRenderable,
  ImageRenderable,
  NativeImage,
  RGBA,
} from "@opentui/core"
import { QRCodeRenderable } from "@opentui/qrcode"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const background = RGBA.defaultBackground()
const muted = RGBA.fromIndex(244)

export const graphicsVisuals: DocVisualFixture[] = [
  {
    id: "ascii-font-tiny",
    label: "OPEN drawn with OpenTUI's compact tiny ASCII font",
    width: 16,
    height: 2,
    render({ renderer }) {
      renderer.root.add(
        new ASCIIFontRenderable(renderer, {
          text: "OPEN",
          font: "tiny",
          color: foreground,
        }),
      )
    },
  },
  {
    id: "ascii-font-block",
    label: "OPEN drawn with OpenTUI's six-row block ASCII font",
    width: 38,
    height: 6,
    render({ renderer }) {
      renderer.root.add(
        new ASCIIFontRenderable(renderer, {
          text: "OPEN",
          font: "block",
          color: foreground,
        }),
      )
    },
  },
  {
    id: "frame-buffer-draw",
    label: "Network throughput chart showing receive at 42 MB/s and transmit at 18 MB/s",
    width: 21,
    height: 4,
    render({ renderer }) {
      const canvas = new FrameBufferRenderable(renderer, { width: 21, height: 4 })
      const buffer = canvas.frameBuffer

      buffer.clear(background)
      buffer.drawText("network throughput", 0, 0, foreground, background)
      buffer.drawText("rx", 0, 1, muted, background)
      buffer.drawText("tx", 0, 2, muted, background)
      buffer.drawText("42 MB/s", 14, 1, muted, background)
      buffer.drawText("18 MB/s", 14, 2, muted, background)
      buffer.drawText("8 seconds", 4, 3, muted, background)
      buffer.drawText("now", 18, 3, muted, background)

      for (const [row, bars] of ["▂▄▆█▇▅▃▂", "▃▅▇█▆▄▂▁"].entries()) {
        for (const [column, bar] of [...bars].entries()) {
          buffer.setCell(column + 4, row + 1, bar, foreground, background)
        }
      }

      renderer.root.add(canvas)
    },
  },
  {
    id: "frame-buffer-progress",
    label: "Package download progress at 70%, with 14 of 20 files complete",
    width: 25,
    height: 3,
    render({ renderer }) {
      const canvas = new FrameBufferRenderable(renderer, { width: 25, height: 3 })
      const buffer = canvas.frameBuffer

      buffer.clear(background)
      buffer.drawText("Downloading package", 0, 0, foreground, background)
      buffer.drawText("70%", 22, 1, foreground, background)
      buffer.drawText("14 of 20 files", 0, 2, muted, background)

      for (let column = 0; column < 20; column++) {
        buffer.setCell(column, 1, column < 14 ? "█" : "░", column < 14 ? foreground : muted, background)
      }

      renderer.root.add(canvas)
    },
  },
  {
    id: "embedded-terminal-vt",
    label: "Embedded terminal test run with two passed and zero failed",
    width: 27,
    height: 4,
    inheritTerminalColors: true,
    render({ renderer }) {
      const terminal = new EmbeddedTerminalRenderable(renderer, { width: 27, height: 4 })
      const output = [
        "\x1b[38;5;244m$ \x1b[39mbun test",
        "\x1b[38;5;244m✓\x1b[39m parser accepts UTF-8",
        "\x1b[38;5;244m✓\x1b[39m renderer draws wide cells",
        "\x1b[1m2 passed\x1b[22m, 0 failed",
      ].join("\r\n")

      terminal.write(new TextEncoder().encode(output))
      renderer.root.add(terminal)
    },
  },
  {
    id: "image-blocks",
    label: "Generated RGBA landscape displayed with the Unicode block image protocol",
    width: 24,
    height: 8,
    async render({ renderer }) {
      const width = 48
      const height = 32
      const pixels = new Uint8Array(width * height * 4)

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const ridge = Math.min(8 + Math.abs(x - 14) * 0.62, 11 + Math.abs(x - 33) * 0.5)
          const nearRidge = 16 + Math.abs(x - 28) * 0.52
          const sun = (x - 39) ** 2 + (y - 7) ** 2 <= 16
          const color =
            y >= 25
              ? [34, 197, 94]
              : y >= nearRidge
                ? [30, 64, 175]
                : y >= ridge
                  ? [96, 165, 250]
                  : sun
                    ? [250, 204, 21]
                    : [15, 23, 42]
          const offset = (y * width + x) * 4

          pixels[offset] = color[0]
          pixels[offset + 1] = color[1]
          pixels[offset + 2] = color[2]
          pixels[offset + 3] = 255
        }
      }

      const image = NativeImage.fromRgba(pixels, width, height)
      let renderable: ImageRenderable | undefined

      try {
        renderable = new ImageRenderable(renderer, {
          source: image,
          protocol: "blocks",
          fit: "fill",
          width: 24,
          height: 8,
        })

        renderer.root.add(renderable)
        await renderable.loadPromise
        return () => image.dispose()
      } catch (error) {
        renderable?.destroy()
        image.dispose()
        throw error
      }
    },
  },
  {
    id: "qr-code-version-one",
    label: "Scannable version-one QR code encoding OPENTUI with a four-module white quiet zone",
    width: 29,
    height: 15,
    render({ renderer }) {
      const qr = new QRCodeRenderable(renderer, {
        content: "OPENTUI",
        quietZone: 4,
        scale: 1,
        foregroundColor: "#000000",
        backgroundColor: "#ffffff",
      })

      if (qr.version !== 1) {
        qr.destroy()
        throw new Error(`Expected a version-one QR code, received version ${qr.version}`)
      }

      renderer.root.add(qr)
    },
  },
]
