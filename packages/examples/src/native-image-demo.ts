#!/usr/bin/env bun

import { createServer, type Server } from "node:http"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import {
  BoxRenderable,
  CliRenderer,
  CliRenderEvents,
  ImageRenderable,
  RGBA,
  TextAttributes,
  TextRenderable,
  createCliRenderer,
  type ImageSource,
  type ImageRenderProtocol,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import gifPath from "./assets/image-demo.gif" with { type: "image/gif" }
// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import pngPath from "./assets/image-demo.png" with { type: "image/png" }
// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import jpegPath from "./assets/dragon.jpg" with { type: "image/jpeg" }
// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import webpPath from "./assets/image-demo.webp" with { type: "image/webp" }

const P = {
  page: "#090d18",
  header: "#10172a",
  footer: "#0d1323",
  text: "#f4f7ff",
  muted: "#8d98b5",
  cyan: "#55d6d0",
  violet: "#a78bfa",
  coral: "#fb7185",
  lime: "#a3e635",
  cards: ["#111c2d", "#17192e", "#211827", "#14231f"],
} as const

type FitMode = "fit" | "cover"

interface GalleryItem {
  name: string
  sourceType: string
  source: ImageSource
  accent: string
  card: string
}

let root: BoxRenderable | null = null
let server: Server | null = null
let keyListener: ((key: KeyEvent) => void) | null = null
let rendererDestroyHandler: (() => void) | null = null
let controlsText: TextRenderable | null = null
let previews: ImageRenderable[] = []
let overlayBox: BoxRenderable | null = null
let fitMode: FitMode = "fit"
let protocol: ImageRenderProtocol = "auto"
let overlayVisible = true
let overlayX = 2
let overlayY = 9
let boxAlphaIndex = 1
let runGeneration = 0

const protocols: ImageRenderProtocol[] = ["auto", "kitty", "sixel", "blocks"]
const boxAlphas = [0, 0.5, 1]
const overlayWidth = 24
const overlayHeight = 8
const headerHeight = 4
const footerHeight = 3

function updateControls(): void {
  if (!controlsText) return
  controlsText.content = `F  ${fitMode.toUpperCase()}   P  ${protocol.toUpperCase()}   O  ${overlayVisible ? "ON" : "OFF"}   A  ${boxAlphas[boxAlphaIndex]}   ARROWS  MOVE   ESC  MENU`
}

function updateOverlay(): void {
  if (overlayBox) {
    if (root && root.width > 0 && root.height > 0) {
      overlayX = Math.max(0, Math.min(overlayX, Math.max(0, root.width - overlayWidth)))
      overlayY = Math.max(
        headerHeight,
        Math.min(overlayY, Math.max(headerHeight, root.height - footerHeight - overlayHeight)),
      )
    }
    overlayBox.left = overlayX
    overlayBox.top = overlayY
    overlayBox.title = `OVERLAY ${overlayX},${overlayY}`
    overlayBox.backgroundColor = RGBA.fromValues(0.15, 0.55, 0.95, boxAlphas[boxAlphaIndex])
    overlayBox.visible = overlayVisible
  }
  updateControls()
}

function createCard(renderer: CliRenderer, item: GalleryItem, index: number): BoxRenderable {
  const card = new BoxRenderable(renderer, {
    id: `native-image-card-${index}`,
    width: "auto",
    height: "100%",
    minWidth: 18,
    flexBasis: 24,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    backgroundColor: item.card,
  })

  card.add(
    new BoxRenderable(renderer, {
      id: `native-image-accent-${index}`,
      width: "100%",
      height: 1,
      flexGrow: 0,
      flexShrink: 0,
      backgroundColor: item.accent,
    }),
  )

  const heading = new BoxRenderable(renderer, {
    id: `native-image-heading-${index}`,
    width: "100%",
    height: 4,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "column",
    paddingLeft: 2,
    paddingTop: 1,
    backgroundColor: item.card,
  })
  heading.add(
    new TextRenderable(renderer, {
      id: `native-image-title-${index}`,
      content: item.name,
      fg: P.text,
      attributes: TextAttributes.BOLD,
    }),
  )
  heading.add(
    new TextRenderable(renderer, {
      id: `native-image-source-${index}`,
      content: item.sourceType,
      fg: item.accent,
    }),
  )
  card.add(heading)

  const metadata = new TextRenderable(renderer, {
    id: `native-image-metadata-${index}`,
    content: "LOADING\nNative decoder",
    width: "100%",
    height: 4,
    flexGrow: 0,
    flexShrink: 0,
    paddingLeft: 2,
    paddingTop: 1,
    fg: P.muted,
    bg: item.card,
  })

  const preview = new ImageRenderable(renderer, {
    id: `native-image-preview-${index}`,
    source: item.source,
    fit: fitMode,
    protocol,
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 5,
    onLoad: (image) => {
      const info = image.info()
      metadata.content = `${info.format.toUpperCase()}  ${info.width}×${info.height}\nRGBA8  ${info.hasAlpha ? "ALPHA" : "OPAQUE"}`
    },
    onError: (error) => {
      metadata.content = `LOAD FAILED\n${error instanceof Error ? error.message : String(error)}`
      metadata.fg = P.coral
    },
  })
  previews.push(preview)
  card.add(preview)
  card.add(metadata)
  return card
}

async function startImageServer(gif: Uint8Array): Promise<{ server: Server; url: string }> {
  const imageServer = createServer((request, response) => {
    if (request.url !== "/image") {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.end(gif)
  })
  await new Promise<void>((resolve, reject) => {
    imageServer.once("error", reject)
    imageServer.listen(0, "127.0.0.1", () => {
      imageServer.off("error", reject)
      resolve()
    })
  })
  const address = imageServer.address()
  if (!address || typeof address === "string") {
    imageServer.close()
    throw new Error("Image demo server did not expose a TCP port")
  }
  return { server: imageServer, url: `http://127.0.0.1:${address.port}/image` }
}

export async function run(renderer: CliRenderer): Promise<void> {
  rendererDestroyHandler = () => destroy(renderer)
  renderer.on(CliRenderEvents.DESTROY, rendererDestroyHandler)
  const generation = ++runGeneration
  renderer.start()
  renderer.setBackgroundColor(P.page)

  const [webpBytes, gifBytes] = await Promise.all([readFile(webpPath), readFile(gifPath)])
  if (generation !== runGeneration) return
  const imageServer = await startImageServer(gifBytes)
  if (generation !== runGeneration) {
    imageServer.server.close()
    return
  }
  server = imageServer.server
  const gifUrl = imageServer.url

  root = new BoxRenderable(renderer, {
    id: "native-image-demo",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: P.page,
  })
  renderer.root.add(root)

  const header = new BoxRenderable(renderer, {
    id: "native-image-header",
    width: "100%",
    height: 4,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 3,
    paddingRight: 3,
    backgroundColor: P.header,
  })
  header.add(
    new TextRenderable(renderer, {
      id: "native-image-heading",
      content: "NATIVE IMAGE LAB",
      fg: P.text,
      attributes: TextAttributes.BOLD,
    }),
  )
  root.add(header)

  const gallery = new BoxRenderable(renderer, {
    id: "native-image-gallery",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: P.page,
  })
  root.add(gallery)

  const items: GalleryItem[] = [
    { name: "LOCAL PNG", sourceType: "filesystem path", source: pngPath, accent: P.cyan, card: P.cards[0] },
    {
      name: "JPEG URL",
      sourceType: "file: URL",
      source: pathToFileURL(jpegPath),
      accent: P.violet,
      card: P.cards[1],
    },
    { name: "WEBP BYTES", sourceType: "Uint8Array", source: webpBytes, accent: P.coral, card: P.cards[2] },
    { name: "GIF FETCH", sourceType: "HTTP URL", source: gifUrl, accent: P.lime, card: P.cards[3] },
  ]
  for (const [index, item] of items.entries()) gallery.add(createCard(renderer, item, index))

  const footer = new BoxRenderable(renderer, {
    id: "native-image-footer",
    width: "100%",
    height: 3,
    flexGrow: 0,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: P.footer,
  })
  controlsText = new TextRenderable(renderer, {
    id: "native-image-controls",
    content: "",
    fg: P.muted,
    attributes: TextAttributes.BOLD,
  })
  footer.add(controlsText)
  root.add(footer)

  overlayBox = new BoxRenderable(renderer, {
    id: "native-image-overlay",
    position: "absolute",
    left: overlayX,
    top: overlayY,
    width: overlayWidth,
    height: overlayHeight,
    zIndex: 100,
    visible: overlayVisible,
    border: true,
    borderColor: P.text,
    title: "OVERLAY",
    shouldFill: true,
  })
  root.add(overlayBox)
  updateOverlay()

  keyListener = (key: KeyEvent) => {
    if (key.name === "f") {
      fitMode = fitMode === "fit" ? "cover" : "fit"
      for (const preview of previews) preview.fit = fitMode
    } else if (key.name === "p") {
      protocol = protocols[(protocols.indexOf(protocol) + 1) % protocols.length]
      for (const preview of previews) preview.protocol = protocol
    } else if (key.name === "o") overlayVisible = !overlayVisible
    else if (key.name === "a") boxAlphaIndex = (boxAlphaIndex + 1) % boxAlphas.length
    else if (key.name === "left") overlayX -= 2
    else if (key.name === "right") overlayX += 2
    else if (key.name === "up") overlayY -= 1
    else if (key.name === "down") overlayY += 1
    else return

    updateOverlay()
  }
  renderer.keyInput.on("keypress", keyListener)
}

export function destroy(renderer: CliRenderer): void {
  runGeneration++
  if (rendererDestroyHandler) renderer.off(CliRenderEvents.DESTROY, rendererDestroyHandler)
  rendererDestroyHandler = null
  if (keyListener) renderer.keyInput.off("keypress", keyListener)
  keyListener = null
  root?.destroyRecursively()
  root = null
  previews = []
  overlayBox = null
  controlsText = null
  fitMode = "fit"
  protocol = "auto"
  overlayVisible = true
  overlayX = 2
  overlayY = 9
  boxAlphaIndex = 1
  server?.close()
  server = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
