#!/usr/bin/env bun

import {
  BoxRenderable,
  CliRenderEvents,
  StyledText,
  TextRenderable,
  VideoRenderable,
  bold,
  createCliRenderer,
  fg,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core"
import { dragonFile } from "./lib/dragon-clip.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

// A sliding puzzle whose tiles are live video. Every tile is its own VideoRenderable that crops its share of
// the clip, so a 3x3 board runs nine decoders at once. A tile out of place plays at its own moment of the clip;
// once it slides home it seeks onto a shared clock, and the picture reassembles in space and time.

const SIDEBAR_WIDTH = 34
// Cells between tiles: a scrambled board spreads them apart; a solved one keeps a one-cell divider.
const GAP = 2
const DIVIDER = 1
// A home tile further than this from the shared clock seeks back onto it: one frame of the 24 fps clip.
const SYNC_TOLERANCE = 0.042
const SEEK_COOLDOWN_MS = 400
// Seeks on a clip with one keyframe decode from its start, so a tick starts only a few of them.
const SEEKS_PER_TICK = 2
const TICK_FPS = 30
const SCRAMBLE_STEP_MS = 45
const SOLVE_STEP_MS = 170
const HELP = [
  "←↑↓→ / hjkl  slide a tile",
  "click        slide a row or column",
  "r            scramble",
  "a            solve it for me",
  "space        freeze time",
  "m            sound",
  "3 4 5        board size",
  "q / Esc      quit / menu",
]

type Direction = "up" | "down" | "left" | "right"

const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" }
const STEP: Record<Direction, [number, number]> = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }

interface Tile {
  home: number
  slot: number
  box: BoxRenderable
  video: VideoRenderable
  // Seconds ahead of the shared clock while out of place; 0 at home.
  offset: number
  x: number
  y: number
  lastSeek: number
}

interface Geometry {
  cellAspect: number
  tileWidth: number
  tileHeight: number
  boardWidth: number
  boardHeight: number
}

let renderer: CliRenderer | null = null
let root: BoxRenderable | null = null
let board: BoxRenderable | null = null
let mapText: TextRenderable | null = null
let statsText: TextRenderable | null = null
let tiles: Tile[] = []
let slots: number[] = []
let size = 3
let holeSlot = 0
let geometry: Geometry = { cellAspect: 2, tileWidth: 1, tileHeight: 1, boardWidth: 1, boardHeight: 1 }
let duration = 6
let epoch = 0
let frozenAt: number | null = null
let history: Direction[] = []
let queue: Direction[] = []
let mode: "play" | "scramble" | "solve" = "play"
let nextStep = 0
let moves = 0
let seeks = 0
let sound = false
let solvedOnce = false
let closed = false
let message = ""
let stopTick: (() => void) | null = null
let keyListener: ((key: KeyEvent) => void) | null = null
let resizeListener: (() => void) | null = null
let destroyListener: (() => void) | null = null

function wrap(value: number): number {
  return ((value % duration) + duration) % duration
}

function wrapSigned(value: number): number {
  const wrapped = wrap(value)
  return wrapped > duration / 2 ? wrapped - duration : wrapped
}

function clock(): number {
  return frozenAt ?? wrap((performance.now() - epoch) / 1000)
}

function holeTile(): Tile {
  return tiles[tiles.length - 1]
}

function solved(): boolean {
  return tiles.every((tile) => tile.home === tile.slot || tile === holeTile())
}

function cellAspect(): number {
  const resolution = renderer?.resolution
  if (!renderer || !resolution || resolution.width <= 0) return 2
  return resolution.height / renderer.height / (resolution.width / renderer.width)
}

function computeGeometry(): Geometry {
  if (!renderer) return geometry
  const metadata = tiles[0]?.video.videoMetadata
  const videoAspect = metadata && metadata.height > 0 ? metadata.width / metadata.height : 768 / 1168
  const aspect = cellAspect()
  const availableWidth = Math.max(size * 3, renderer.width - SIDEBAR_WIDTH - 4)
  const availableHeight = Math.max(size * 2, renderer.height - 2)
  let boardHeight = availableHeight
  let boardWidth = Math.round(boardHeight * videoAspect * aspect)
  if (boardWidth > availableWidth) {
    boardWidth = availableWidth
    boardHeight = Math.round(boardWidth / (videoAspect * aspect))
  }
  const tileWidth = Math.max(2, Math.floor((boardWidth - GAP * (size - 1)) / size))
  const tileHeight = Math.max(1, Math.floor((boardHeight - GAP * (size - 1)) / size))
  return {
    cellAspect: aspect,
    tileWidth,
    tileHeight,
    boardWidth: tileWidth * size + GAP * (size - 1),
    boardHeight: tileHeight * size + GAP * (size - 1),
  }
}

// A solved board closes up to its dividers, centered where the board was.
function slotPosition(slot: number): [number, number] {
  const row = Math.floor(slot / size)
  const column = slot % size
  const gap = closed ? DIVIDER : GAP
  const inset = closed ? Math.floor(((GAP - DIVIDER) * (size - 1)) / 2) : 0
  return [inset + column * (geometry.tileWidth + gap), inset + row * (geometry.tileHeight + gap)]
}

// The solved board, dividers included, covers the source like fit "cover", and each tile crops the source pixels
// under its cells. A divider hides the pixels behind it like a window frame, so lines in the picture continue
// straight across it; neighbours share the divider's edges. Each tile decodes and sends only its own region.
function homeCrop(home: number): { left: number; top: number; width: number; height: number } | undefined {
  const metadata = tiles[0]?.video.videoMetadata
  if (!metadata || metadata.width <= 0 || metadata.height <= 0) return undefined
  const { tileWidth, tileHeight, cellAspect } = geometry
  const columns = size * tileWidth + (size - 1) * DIVIDER
  const rows = size * tileHeight + (size - 1) * DIVIDER
  const sourceWidth = Math.min(metadata.width, (metadata.height * columns) / (rows * cellAspect))
  const sourceHeight = (sourceWidth * rows * cellAspect) / columns
  // The source pixel at a cell edge of the solved board.
  const x = (cell: number) => Math.round((metadata.width - sourceWidth) / 2 + (cell * sourceWidth) / columns)
  const y = (cell: number) => Math.round((metadata.height - sourceHeight) / 2 + (cell * sourceHeight) / rows)
  const column = (home % size) * (tileWidth + DIVIDER)
  const row = Math.floor(home / size) * (tileHeight + DIVIDER)
  return {
    left: x(column),
    top: y(row),
    width: x(column + tileWidth) - x(column),
    height: y(row + tileHeight) - y(row),
  }
}

function layout(): void {
  if (!board) return
  geometry = computeGeometry()
  board.width = geometry.boardWidth
  board.height = geometry.boardHeight
  for (const tile of tiles) {
    const [x, y] = slotPosition(tile.slot)
    tile.x = x
    tile.y = y
    tile.box.left = x
    tile.box.top = y
    tile.box.width = geometry.tileWidth
    tile.box.height = geometry.tileHeight
    tile.video.crop = homeCrop(tile.home)
  }
}

function createTiles(): void {
  if (!renderer || !board) return
  const source = process.argv.slice(2).find((argument) => !argument.startsWith("-")) ?? dragonFile()
  for (let home = 0; home < size * size; home++) {
    const box = new BoxRenderable(renderer, {
      id: `video-puzzle-tile-${home}`,
      position: "absolute",
      backgroundColor: "#05070b",
    })
    // Only the tile that carries sound opens an audio device; the others follow the wall clock.
    const video = new VideoRenderable(renderer, {
      id: `video-puzzle-video-${home}`,
      source,
      width: "100%",
      height: "100%",
      fit: "fill",
      loop: true,
      audio: sound && home === 0,
      maxFps: TICK_FPS,
      onError: (error) => {
        message = error.message
      },
    })
    box.add(video)
    const tile: Tile = { home, slot: home, box, video, offset: 0, x: 0, y: 0, lastSeek: 0 }
    box.onMouseDown = () => clickTile(tile)
    board.add(box)
    tiles.push(tile)
  }
  slots = tiles.map((tile) => tile.home)
  holeSlot = size * size - 1
  closed = false
  duration = tiles[0].video.duration || duration
  epoch = performance.now()
  frozenAt = null
  layout()
  for (const tile of tiles) tile.video.play()
}

function destroyTiles(): void {
  for (const tile of tiles) tile.box.destroyRecursively()
  tiles = []
  slots = []
  history = []
  queue = []
  mode = "play"
}

function rebuild(nextSize: number): void {
  destroyTiles()
  size = nextSize
  moves = 0
  solvedOnce = false
  createTiles()
  startScramble()
}

function setHoleShown(shown: boolean): void {
  const hole = holeTile()
  if (hole.box.visible === shown) return
  hole.box.visible = shown
  if (!shown) {
    hole.video.pause()
    return
  }
  hole.offset = 0
  hole.lastSeek = performance.now()
  seeks++
  hole.video.seek(clock())
  if (frozenAt === null) hole.video.play()
}

function move(direction: Direction, record = true): boolean {
  const [dRow, dColumn] = STEP[direction]
  const row = Math.floor(holeSlot / size) + dRow
  const column = (holeSlot % size) + dColumn
  if (row < 0 || row >= size || column < 0 || column >= size) return false
  setHoleShown(false)
  closed = false
  const from = row * size + column
  const tile = tiles[slots[from]]
  const wasHome = tile.slot === tile.home
  slots[holeSlot] = tile.home
  slots[from] = holeTile().home
  tile.slot = holeSlot
  holeTile().slot = from
  holeSlot = from
  if (tile.slot === tile.home) tile.offset = 0
  else if (wasHome) tile.offset = duration * (0.2 + Math.random() * 0.6)
  if (record) {
    if (history.at(-1) === OPPOSITE[direction]) history.pop()
    else history.push(direction)
  }
  if (mode === "play") moves++
  return true
}

// Keys and clicks name the way a tile slides, so the hole moves the other way.
function slide(direction: Direction): void {
  if (mode !== "play") stopAutomation()
  move(OPPOSITE[direction])
  checkSolved()
}

function clickTile(tile: Tile): void {
  if (tile === holeTile() || !board) return
  if (mode !== "play") stopAutomation()
  const row = Math.floor(tile.slot / size)
  const column = tile.slot % size
  const holeRow = Math.floor(holeSlot / size)
  const holeColumn = holeSlot % size
  // The hole walks to the clicked tile, sliding every tile between them.
  let direction: Direction
  if (row === holeRow) direction = column < holeColumn ? "left" : "right"
  else if (column === holeColumn) direction = row < holeRow ? "up" : "down"
  else return
  const steps = Math.abs(row - holeRow) + Math.abs(column - holeColumn)
  for (let count = 0; count < steps; count++) move(direction)
  checkSolved()
}

function checkSolved(): void {
  if (mode !== "play" || !solved()) return
  setHoleShown(true)
  closed = true
  if (moves > 0) {
    solvedOnce = true
    message = `Solved in ${moves} moves`
  }
}

function startScramble(): void {
  stopAutomation()
  moves = 0
  message = "Scrambling"
  let last: Direction | null = null
  const options: Direction[] = ["up", "down", "left", "right"]
  let hole = holeSlot
  queue = []
  for (let count = 0; count < size * size * 6; ) {
    const direction = options[Math.floor(Math.random() * options.length)]
    if (last && direction === OPPOSITE[last]) continue
    const [dRow, dColumn] = STEP[direction]
    const row = Math.floor(hole / size) + dRow
    const column = (hole % size) + dColumn
    if (row < 0 || row >= size || column < 0 || column >= size) continue
    hole = row * size + column
    queue.push(direction)
    last = direction
    count++
  }
  mode = "scramble"
  nextStep = performance.now() + 600
}

function startSolve(): void {
  if (solved()) return
  stopAutomation()
  queue = history
    .slice()
    .reverse()
    .map((direction) => OPPOSITE[direction])
  mode = "solve"
  message = `Solving in ${queue.length} moves`
  nextStep = performance.now()
}

function stopAutomation(): void {
  if (mode === "scramble") message = ""
  mode = "play"
  queue = []
}

function setFrozen(frozen: boolean): void {
  if (frozen === (frozenAt !== null)) return
  if (frozen) {
    frozenAt = clock()
    // Each player stops at its own clock; a paused seek puts every tile on the same frame.
    for (const tile of tiles) {
      tile.video.pause()
      if (tile.box.visible) tile.video.seek(wrap(frozenAt + tile.offset))
    }
    return
  }
  epoch = performance.now() - (frozenAt ?? 0) * 1000
  frozenAt = null
  for (const tile of tiles) if (tile.box.visible) tile.video.play()
}

function setSound(on: boolean): void {
  sound = on
  // Turning audio on or off reopens the source; synchronize() seeks it back onto the clock.
  if (tiles[0]) tiles[0].video.audio = on
}

// Each video keeps its own media clock, and players that loop together stay together. A tile that strays from
// the shared clock plus its offset seeks onto it: after it slides, after a freeze, or when sound reopens it.
function synchronize(now: number): void {
  if (mode === "scramble" || frozenAt !== null) return
  let started = 0
  for (const tile of tiles) {
    if (!tile.box.visible || now - tile.lastSeek < SEEK_COOLDOWN_MS) continue
    // A seek waits for the decoder to stop, so read the clock again for every tile.
    const desired = wrap(clock() + tile.offset)
    if (Math.abs(wrapSigned(tile.video.currentTime - desired)) <= SYNC_TOLERANCE) continue
    tile.lastSeek = now
    seeks++
    tile.video.seek(desired)
    if (++started >= SEEKS_PER_TICK) break
  }
}

function animate(deltaTime: number): void {
  const rate = mode === "scramble" ? 40 : 22
  const blend = Math.min(1, (deltaTime / 1000) * rate)
  for (const tile of tiles) {
    const [x, y] = slotPosition(tile.slot)
    tile.x = Math.abs(x - tile.x) < 0.5 ? x : tile.x + (x - tile.x) * blend
    tile.y = Math.abs(y - tile.y) < 0.5 ? y : tile.y + (y - tile.y) * blend
    tile.box.left = Math.round(tile.x)
    tile.box.top = Math.round(tile.y)
  }
}

function step(now: number): void {
  if (mode === "play" || now < nextStep) return
  const direction = queue.shift()
  if (direction) {
    move(direction, mode === "scramble")
    if (mode === "solve") history.pop()
  }
  nextStep = now + (mode === "scramble" ? SCRAMBLE_STEP_MS : SOLVE_STEP_MS)
  if (queue.length > 0) return
  const finished = mode
  mode = "play"
  moves = 0
  if (finished === "scramble") message = "Your move"
  else {
    checkSolved()
    message = "Solved by the machine"
  }
}

function formatDrift(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  if (Math.abs(ms) >= 1000) return `${ms > 0 ? "+" : "-"}${(Math.abs(ms) / 1000).toFixed(1)}s`
  return `${ms >= 0 ? "+" : "-"}${Math.abs(ms)}ms`
}

function updateSidebar(): void {
  if (!mapText || !statsText) return
  const target = clock()
  const chunks: TextChunk[] = []
  let worst = 0
  let inPlace = 0
  for (let slot = 0; slot < size * size; slot++) {
    if (slot > 0 && slot % size === 0) chunks.push(fg("#c9d1d9")("\n"))
    const tile = tiles[slots[slot]]
    if (!tile) continue
    if (tile === holeTile() && !tile.box.visible) {
      chunks.push(fg("#3a4250")("   ·    "))
      continue
    }
    const drift = wrapSigned(tile.video.currentTime - target)
    const home = tile.slot === tile.home
    if (home) {
      inPlace++
      worst = Math.max(worst, Math.abs(drift))
    }
    const color = home ? (Math.abs(drift) <= SYNC_TOLERANCE ? "#7ee787" : "#f2cc60") : "#ff7b72"
    chunks.push(fg("#c9d1d9")(String(tile.home + 1).padStart(2)), fg(color)(` ${formatDrift(drift).padStart(6)}`))
  }
  mapText.content = new StyledText(chunks)
  const state = frozenAt !== null ? "frozen" : mode === "play" ? "playing" : mode
  statsText.content = new StyledText([
    fg("#8b949e")("clock    "),
    fg("#c9d1d9")(`${target.toFixed(2)}s / ${duration.toFixed(2)}s  ${state}\n`),
    fg("#8b949e")("players  "),
    fg("#c9d1d9")(`${tiles.filter((tile) => tile.video.playing).length} of ${tiles.length} decoding\n`),
    fg("#8b949e")("in place "),
    fg("#c9d1d9")(`${inPlace}, worst drift ${Math.round(worst * 1000)}ms\n`),
    fg("#8b949e")("moves    "),
    fg("#c9d1d9")(`${moves}   seeks ${seeks}\n`),
    fg("#8b949e")("sound    "),
    fg("#c9d1d9")(`${sound ? "on" : "off"}${solvedOnce ? "   ★ solved" : ""}\n`),
    fg("#f2cc60")(message),
  ])
}

function tick(deltaTime: number): void {
  const now = performance.now()
  // The terminal reports its pixel size after the first frames; the crops follow the cell shape.
  if (cellAspect() !== geometry.cellAspect) layout()
  step(now)
  animate(deltaTime)
  synchronize(now)
  updateSidebar()
}

export async function run(rendererInstance: CliRenderer): Promise<void> {
  renderer = rendererInstance
  renderer.start()
  destroyListener = () => destroy(rendererInstance)
  renderer.on(CliRenderEvents.DESTROY, destroyListener)

  root = new BoxRenderable(renderer, {
    id: "video-puzzle",
    width: "100%",
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    backgroundColor: "#0d1117",
  })
  board = new BoxRenderable(renderer, { id: "video-puzzle-board", position: "relative", flexShrink: 0 })
  const sidebar = new BoxRenderable(renderer, {
    id: "video-puzzle-sidebar",
    width: SIDEBAR_WIDTH,
    flexShrink: 0,
    flexDirection: "column",
    gap: 1,
  })
  sidebar.add(
    new TextRenderable(renderer, {
      id: "video-puzzle-title",
      content: new StyledText([
        bold(fg("#ff7b72")("SLIDE THE DRAGON\n")),
        fg("#8b949e")(
          "Every tile is its own video player.\nOut of place, a tile plays its own\nmoment; home, it locks to the clock.",
        ),
      ]),
    }),
  )
  mapText = new TextRenderable(renderer, { id: "video-puzzle-map" })
  statsText = new TextRenderable(renderer, { id: "video-puzzle-stats" })
  sidebar.add(mapText)
  sidebar.add(statsText)
  sidebar.add(new TextRenderable(renderer, { id: "video-puzzle-help", fg: "#6e7681", content: HELP.join("\n") }))
  root.add(board)
  root.add(sidebar)
  renderer.root.add(root)

  createTiles()
  startScramble()

  stopTick = renderer.onAnimationTick(TICK_FPS, tick)
  resizeListener = () => layout()
  renderer.on(CliRenderEvents.RESIZE, resizeListener)
  keyListener = (key: KeyEvent) => {
    const name = key.name
    if (name === "left" || name === "h") slide("left")
    else if (name === "right" || name === "l") slide("right")
    else if (name === "up" || name === "k") slide("up")
    else if (name === "down" || name === "j") slide("down")
    else if (name === "r") startScramble()
    else if (name === "a") startSolve()
    else if (name === "space") setFrozen(frozenAt === null)
    else if (name === "m") setSound(!sound)
    else if (name === "3" || name === "4" || name === "5") rebuild(Number(name))
    else return
    key.preventDefault()
    key.stopPropagation()
    updateSidebar()
  }
  renderer.keyInput.prependListener("keypress", keyListener)
  updateSidebar()
}

export function destroy(rendererInstance: CliRenderer): void {
  if (destroyListener) rendererInstance.off(CliRenderEvents.DESTROY, destroyListener)
  if (resizeListener) rendererInstance.off(CliRenderEvents.RESIZE, resizeListener)
  if (keyListener) rendererInstance.keyInput.off("keypress", keyListener)
  stopTick?.()
  destroyListener = null
  resizeListener = null
  keyListener = null
  stopTick = null
  destroyTiles()
  root?.destroyRecursively()
  root = null
  board = null
  mapText = null
  statsText = null
  renderer = null
  size = 3
  moves = 0
  seeks = 0
  sound = false
  solvedOnce = false
  closed = false
  message = ""
  frozenAt = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  await run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "q" || key.name === "escape") renderer.destroy()
  })
}
