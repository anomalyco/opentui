#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  VideoRenderable,
  createCliRenderer,
  type CliRenderer,
  type ImageFit,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { listVideoDirectory, resolveVideoDirectoryPath } from "./lib/video-file-browser.js"

// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import dragonPath from "./assets/dragon.mp4" with { type: "file" }

const FITS: ImageFit[] = ["fit", "cover", "fill"]
const PLAYER_HELP =
  "Space play/pause | ←/→ 0.25s | Shift+←/→ 5s | [/] A/V sync | ↑/↓ volume | M mute | L loop | F fit | O open | Home restart"
const BROWSER_HELP = "Enter open | Backspace parent | G go to path | R refresh | Esc close"

let root: BoxRenderable | null = null
let video: VideoRenderable | null = null
let browser: BoxRenderable | null = null
let browserPath: TextRenderable | null = null
let browserInput: InputRenderable | null = null
let browserList: SelectRenderable | null = null
let status: TextRenderable | null = null
let help: TextRenderable | null = null
let keyListener: ((key: KeyEvent) => void) | null = null
let rendererDestroyHandler: (() => void) | null = null
let message = "Ready"
let directory = process.cwd()
let browseRequest = 0
let resumeAfterBrowse = false

// FFmpeg opens only real files: a compiled binary embeds the clip in Bun's virtual file system, and a Node
// bundle names it relative to the bundle.
function dragonFile(): string {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), dragonPath as string)
  if (!/\$bunfs|^B:[\\/]~BUN/i.test(path)) return path
  const file = join(tmpdir(), basename(path))
  if (!existsSync(file)) writeFileSync(file, readFileSync(path))
  return file
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

function updateStatus(): void {
  if (!status || !video) return
  const state = video.ended ? "ended" : video.playing ? "playing" : "paused"
  const sourceFps = video.videoMetadata?.fps ?? 0
  const fps = sourceFps > 0 ? Math.min(sourceFps, video.maxFps) : video.maxFps
  const sync = `${video.avSyncOffsetMs >= 0 ? "+" : ""}${video.avSyncOffsetMs}ms`
  status.content = `${state} ${formatTime(video.currentTime)} / ${formatTime(video.duration)} | ${fps.toFixed(1)} fps | quality ${
    video.qualityTier
  } | sync ${sync} | fit ${video.fit} | ${video.muted ? "muted" : `volume ${Math.round(video.volume * 100)}%`} | loop ${
    video.loop ? "on" : "off"
  } | ${message}`
}

async function showDirectory(next: string): Promise<boolean> {
  const request = ++browseRequest
  try {
    const entries = await listVideoDirectory(next)
    if (request !== browseRequest || !browserList || !browserPath) return false
    directory = resolve(next)
    const parent = dirname(directory)
    const options: SelectOption[] = parent === directory ? [] : [{ name: "../", description: "", value: parent }]
    for (const entry of entries) {
      options.push({ name: entry.type === "directory" ? `${entry.name}/` : entry.name, description: "", value: entry })
    }
    if (options.length === 0) options.push({ name: "No MP4 or MOV files here", description: "", value: null })
    browserList.options = options
    browserList.setSelectedIndex(0)
    browserPath.content = directory
    return true
  } catch (error) {
    if (request === browseRequest && browserPath) {
      browserPath.content = `Cannot read ${next}: ${error instanceof Error ? error.message : String(error)}`
    }
    return false
  }
}

function openBrowser(): void {
  if (!video || !browser || !browserList || !help) return
  resumeAfterBrowse = video.playing
  video.pause()
  video.visible = false
  browser.visible = true
  browserList.focus()
  help.content = BROWSER_HELP
  void showDirectory(directory)
}

function closeBrowser(resume = resumeAfterBrowse): void {
  if (!video || !browser || !browserList || !browserInput || !help) return
  browseRequest++
  browserInput.blur()
  browserInput.visible = false
  browserList.blur()
  browser.visible = false
  video.visible = true
  help.content = PLAYER_HELP
  if (resume) video.play()
  resumeAfterBrowse = false
}

function choose(option: SelectOption | null): void {
  const value = option?.value
  if (!value || !video) return
  if (typeof value === "string") {
    void showDirectory(value)
  } else if (value.type === "directory") {
    void showDirectory(value.path)
  } else {
    // Opening is synchronous; failures arrive through onError.
    const resume = resumeAfterBrowse
    message = value.name
    video.autoplay = resume
    video.source = value.path
    closeBrowser(resume)
    updateStatus()
  }
}

export async function run(renderer: CliRenderer): Promise<void> {
  rendererDestroyHandler = () => destroy(renderer)
  renderer.on(CliRenderEvents.DESTROY, rendererDestroyHandler)
  renderer.start()
  const source = process.argv.slice(2).find((argument) => !argument.startsWith("-")) ?? dragonFile()

  root = new BoxRenderable(renderer, { id: "video-demo", width: "100%", height: "100%", flexDirection: "column" })
  video = new VideoRenderable(renderer, {
    id: "video-demo-player",
    source,
    width: "100%",
    flexGrow: 1,
    minHeight: 0,
    autoplay: true,
    loop: true,
    onError: (error) => {
      message = error.message
      updateStatus()
    },
    onTimeUpdate: updateStatus,
    onEnd: updateStatus,
  })
  browser = new BoxRenderable(renderer, {
    id: "video-demo-browser",
    width: "100%",
    flexGrow: 1,
    minHeight: 0,
    flexDirection: "column",
    visible: false,
  })
  browserPath = new TextRenderable(renderer, { id: "video-demo-browser-path", width: "100%", height: 1, fg: "#7fd4ff" })
  browserInput = new InputRenderable(renderer, {
    id: "video-demo-browser-input",
    width: "100%",
    placeholder: "Absolute or relative directory",
    visible: false,
  })
  browserInput.on(InputRenderableEvents.ENTER, (value: string) => {
    if (!value.trim()) return
    void showDirectory(resolveVideoDirectoryPath(directory, value)).then((shown) => {
      if (!shown || !browserInput || !browserList) return
      browserInput.blur()
      browserInput.visible = false
      browserList.focus()
    })
  })
  browserList = new SelectRenderable(renderer, {
    id: "video-demo-browser-list",
    width: "100%",
    flexGrow: 1,
    options: [],
    showDescription: false,
    showScrollIndicator: true,
    wrapSelection: true,
  })
  browserList.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption | null) => choose(option))
  browser.add(browserPath)
  browser.add(browserInput)
  browser.add(browserList)
  status = new TextRenderable(renderer, { id: "video-demo-status", width: "100%", flexShrink: 0, fg: "#c7d8e2" })
  help = new TextRenderable(renderer, {
    id: "video-demo-help",
    width: "100%",
    flexShrink: 0,
    fg: "#7f8c99",
    content: PLAYER_HELP,
  })
  root.add(video)
  root.add(browser)
  root.add(status)
  root.add(help)
  renderer.root.add(root)

  keyListener = (key: KeyEvent) => {
    if (!video) return
    if (browser?.visible) {
      if (browserInput?.visible) {
        if (key.name !== "escape") return
        browserInput.blur()
        browserInput.visible = false
        browserList?.focus()
      } else if (key.name === "escape") closeBrowser()
      else if (key.name === "backspace") void showDirectory(dirname(directory))
      else if (key.name === "r") void showDirectory(directory)
      else if (key.name === "g" && browserInput && browserList) {
        browserList.blur()
        browserInput.visible = true
        browserInput.value = directory
        browserInput.focus()
        browserInput.selectAll()
      } else return
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (key.name === "space") video.toggle()
    else if (key.name === "left") video.seekBy(key.shift ? -5 : -0.25)
    else if (key.name === "right") video.seekBy(key.shift ? 5 : 0.25)
    else if (key.raw === "[") video.avSyncOffsetMs -= 10
    else if (key.raw === "]") video.avSyncOffsetMs += 10
    else if (key.name === "up") video.volume = Math.min(2, video.volume + 0.1)
    else if (key.name === "down") video.volume = Math.max(0, video.volume - 0.1)
    else if (key.name === "m") video.muted = !video.muted
    else if (key.name === "l") video.loop = !video.loop
    else if (key.name === "f") video.fit = FITS[(FITS.indexOf(video.fit) + 1) % FITS.length]
    else if (key.name === "o") openBrowser()
    else if (key.name === "home") video.seek(0)
    else return
    key.preventDefault()
    key.stopPropagation()
    updateStatus()
  }
  renderer.keyInput.prependListener("keypress", keyListener)
  updateStatus()
}

export function destroy(renderer: CliRenderer): void {
  if (rendererDestroyHandler) renderer.off(CliRenderEvents.DESTROY, rendererDestroyHandler)
  rendererDestroyHandler = null
  if (keyListener) renderer.keyInput.off("keypress", keyListener)
  keyListener = null
  browseRequest++
  root?.destroyRecursively()
  root = null
  video = null
  browser = null
  browserPath = null
  browserInput = null
  browserList = null
  status = null
  help = null
  message = "Ready"
  resumeAfterBrowse = false
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
