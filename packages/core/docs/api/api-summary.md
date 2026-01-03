# OpenTUI API Summary

## Classes

### Renderable

**Constructor:**
```typescript
constructor(id: string, options: RenderableOptions)
```

**Properties:**
- `renderablesByNumber: Map<number, Renderable>`
- `id: string`
- `num: number`
- `selectable: boolean`
- `parent: Renderable | null`

**Methods:**
- `hasSelection(): boolean`
- `onSelectionChanged(selection: SelectionState | null): boolean`
- `getSelectedText(): string`
- `shouldStartSelection(x: number, y: number): boolean`
- `focus(): void`
- `blur(): void`
- `handleKeyPress(key: ParsedKey | string): boolean`
- `needsUpdate(): void`
- `requestZIndexSort(): void`
- `setPosition(position: Position): void`
- `getLayoutNode(): TrackedNode<NodeMetadata>`
- `updateFromLayout(): void`
- `add(obj: Renderable, index: number): number`
- `insertBefore(obj: Renderable, anchor: Renderable): number`
- `propagateContext(ctx: RenderContext | null): void`
- `getRenderable(id: string): Renderable`
- `remove(id: string): void`
- `getChildren(): Renderable[]`
- `render(buffer: OptimizedBuffer, deltaTime: number): void`
- `destroy(): void`
- `destroyRecursively(): void`
- `processMouseEvent(event: MouseEvent): void`

### RootRenderable

**Constructor:**
```typescript
constructor(width: number, height: number, ctx: RenderContext, rootContext: RootContext)
```

**Methods:**
- `requestLayout(): void`
- `calculateLayout(): void`
- `resize(width: number, height: number): void`

### MouseEvent

**Constructor:**
```typescript
constructor(target: Renderable | null, attributes: RawMouseEvent & { source?: Renderable })
```

**Properties:**
- `type: MouseEventType`
- `button: number`
- `x: number`
- `y: number`
- `source: Renderable`
- `modifiers: {
    shift: boolean
    alt: boolean
    ctrl: boolean
  }`
- `scroll: ScrollInfo`
- `target: Renderable | null`

**Methods:**
- `preventDefault(): void`

### CliRenderer

**Constructor:**
```typescript
constructor(lib: RenderLib, rendererPtr: Pointer, stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, width: number, height: number, config: CliRendererConfig)
```

**Properties:**
- `rendererPtr: Pointer`
- `nextRenderBuffer: OptimizedBuffer`
- `currentRenderBuffer: OptimizedBuffer`
- `root: RootRenderable`
- `width: number`
- `height: number`
- `debugOverlay: any`

**Methods:**
- `needsUpdate(): void`
- `setMemorySnapshotInterval(interval: number): void`
- `setBackgroundColor(color: ColorInput): void`
- `toggleDebugOverlay(): void`
- `configureDebugOverlay(options: { enabled?: boolean; corner?: DebugOverlayCorner }): void`
- `clearTerminal(): void`
- `dumpHitGrid(): void`
- `dumpBuffers(timestamp: number): void`
- `dumpStdoutBuffer(timestamp: number): void`
- `setCursorPosition(x: number, y: number, visible: boolean): void`
- `setCursorStyle(style: CursorStyle, blinking: boolean, color: RGBA): void`
- `setCursorColor(color: RGBA): void`
- `setCursorPosition(x: number, y: number, visible: boolean): void`
- `setCursorStyle(style: CursorStyle, blinking: boolean, color: RGBA): void`
- `setCursorColor(color: RGBA): void`
- `addPostProcessFn(processFn: (buffer: OptimizedBuffer, deltaTime: number) => void): void`
- `removePostProcessFn(processFn: (buffer: OptimizedBuffer, deltaTime: number) => void): void`
- `clearPostProcessFns(): void`
- `setFrameCallback(callback: (deltaTime: number) => Promise<void>): void`
- `removeFrameCallback(callback: (deltaTime: number) => Promise<void>): void`
- `clearFrameCallbacks(): void`
- `requestLive(): void`
- `dropLive(): void`
- `start(): void`
- `pause(): void`
- `stop(): void`
- `destroy(): void`
- `intermediateRender(): void`
- `getStats(): { fps: number; frameCount: number; frameTimes: number[]; averageFrameTime: number; minFrameTime: number; maxFrameTime: number; }`
- `resetStats(): void`
- `setGatherStats(enabled: boolean): void`
- `getSelection(): Selection`
- `getSelectionContainer(): Renderable`
- `hasSelection(): boolean`
- `clearSelection(): void`

### OptimizedBuffer

**Constructor:**
```typescript
constructor(lib: RenderLib, ptr: Pointer, buffer: {
      char: Uint32Array
      fg: Float32Array
      bg: Float32Array
      attributes: Uint8Array
    }, width: number, height: number, options: { respectAlpha?: boolean })
```

**Properties:**
- `id: string`
- `lib: RenderLib`
- `respectAlpha: boolean`

**Methods:**
- `create(width: number, height: number, options: { respectAlpha?: boolean }): OptimizedBuffer`
- `getWidth(): number`
- `getHeight(): number`
- `setRespectAlpha(respectAlpha: boolean): void`
- `clear(bg: RGBA, clearChar: string): void`
- `clearLocal(bg: RGBA, clearChar: string): void`
- `setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number): void`
- `get(x: number, y: number): { char: number; fg: RGBA; bg: RGBA; attributes: number; }`
- `setCellWithAlphaBlending(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number): void`
- `setCellWithAlphaBlendingLocal(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number): void`
- `drawText(text: string, x: number, y: number, fg: RGBA, bg: RGBA, attributes: number, selection: { start: number; end: number; bgColor?: RGBA; fgColor?: RGBA } | null): void`
- `fillRect(x: number, y: number, width: number, height: number, bg: RGBA): void`
- `fillRectLocal(x: number, y: number, width: number, height: number, bg: RGBA): void`
- `drawFrameBuffer(destX: number, destY: number, frameBuffer: OptimizedBuffer, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number): void`
- `drawFrameBufferLocal(destX: number, destY: number, frameBuffer: OptimizedBuffer, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number): void`
- `destroy(): void`
- `drawTextBuffer(textBuffer: TextBuffer, x: number, y: number, clipRect: { x: number; y: number; width: number; height: number }): void`
- `drawSuperSampleBuffer(x: number, y: number, pixelDataPtr: Pointer, pixelDataLength: number, format: "bgra8unorm" | "rgba8unorm", alignedBytesPerRow: number): void`
- `drawSuperSampleBufferFFI(x: number, y: number, pixelDataPtr: Pointer, pixelDataLength: number, format: "bgra8unorm" | "rgba8unorm", alignedBytesPerRow: number): void`
- `drawPackedBuffer(dataPtr: Pointer, dataLen: number, posX: number, posY: number, terminalWidthCells: number, terminalHeightCells: number): void`
- `setCellWithAlphaBlendingFFI(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number): void`
- `fillRectFFI(x: number, y: number, width: number, height: number, bg: RGBA): void`
- `resize(width: number, height: number): void`
- `clearFFI(bg: RGBA): void`
- `drawTextFFI(text: string, x: number, y: number, fg: RGBA, bg: RGBA, attributes: number): void`
- `drawFrameBufferFFI(destX: number, destY: number, frameBuffer: OptimizedBuffer, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number): void`
- `drawBox(options: {
    x: number
    y: number
    width: number
    height: number
    borderStyle?: BorderStyle
    customBorderChars?: Uint32Array
    border: boolean | BorderSides[]
    borderColor: RGBA
    backgroundColor: RGBA
    shouldFill?: boolean
    title?: string
    titleAlignment?: "left" | "center" | "right"
  }): void`

### BoxRenderable

**Constructor:**
```typescript
constructor(id: string, options: BoxOptions)
```

**Properties:**
- `shouldFill: boolean`

### TextRenderable

**Constructor:**
```typescript
constructor(id: string, options: TextOptions)
```

**Properties:**
- `selectable: boolean`

**Methods:**
- `shouldStartSelection(x: number, y: number): boolean`
- `onSelectionChanged(selection: SelectionState | null): boolean`
- `getSelectedText(): string`
- `hasSelection(): boolean`
- `destroy(): void`

### ASCIIFontRenderable

**Constructor:**
```typescript
constructor(id: string, options: ASCIIFontOptions)
```

**Properties:**
- `selectable: boolean`

**Methods:**
- `shouldStartSelection(x: number, y: number): boolean`
- `onSelectionChanged(selection: SelectionState | null): boolean`
- `getSelectedText(): string`
- `hasSelection(): boolean`

### InputRenderable

**Constructor:**
```typescript
constructor(id: string, options: InputRenderableOptions)
```

**Methods:**
- `focus(): void`
- `blur(): void`
- `handleKeyPress(key: ParsedKey | string): boolean`

### Timeline

**Constructor:**
```typescript
constructor(options: TimelineOptions)
```

**Properties:**
- `items: (TimelineAnimationItem | TimelineCallbackItem)[]`
- `subTimelines: TimelineTimelineItem[]`
- `currentTime: number`
- `isPlaying: boolean`
- `isComplete: boolean`
- `duration: number`
- `loop: boolean`
- `synced: boolean`

**Methods:**
- `add(target: any, properties: AnimationOptions, startTime: number | string): this`
- `once(target: any, properties: AnimationOptions): this`
- `call(callback: () => void, startTime: number | string): this`
- `sync(timeline: Timeline, startTime: number): this`
- `play(): this`
- `pause(): this`
- `resetItems(): void`
- `restart(): this`
- `update(deltaTime: number): void`

## Interfaces

### RootContext

- `requestLive: void`
- `dropLive: void`

### Position

- `top: number | "auto" | `${number}%``
- `right: number | "auto" | `${number}%``
- `bottom: number | "auto" | `${number}%``
- `left: number | "auto" | `${number}%``

### LayoutOptions

- `flexGrow: number`
- `flexShrink: number`
- `flexDirection: FlexDirectionString`
- `alignItems: AlignString`
- `justifyContent: JustifyString`
- `flexBasis: number | "auto" | undefined`
- `position: PositionTypeString`
- `top: number | "auto" | `${number}%``
- `right: number | "auto" | `${number}%``
- `bottom: number | "auto" | `${number}%``
- `left: number | "auto" | `${number}%``
- `minWidth: number`
- `minHeight: number`
- `maxWidth: number`
- `maxHeight: number`
- `margin: number | "auto" | `${number}%``
- `marginTop: number | "auto" | `${number}%``
- `marginRight: number | "auto" | `${number}%``
- `marginBottom: number | "auto" | `${number}%``
- `marginLeft: number | "auto" | `${number}%``
- `padding: number | `${number}%``
- `paddingTop: number | `${number}%``
- `paddingRight: number | `${number}%``
- `paddingBottom: number | `${number}%``
- `paddingLeft: number | `${number}%``
- `enableLayout: boolean`

### RenderableOptions

- `width: number | "auto" | `${number}%``
- `height: number | "auto" | `${number}%``
- `zIndex: number`
- `visible: boolean`
- `buffered: boolean`
- `live: boolean`
- `onMouseDown: (event: MouseEvent) => void`
- `onMouseUp: (event: MouseEvent) => void`
- `onMouseMove: (event: MouseEvent) => void`
- `onMouseDrag: (event: MouseEvent) => void`
- `onMouseDragEnd: (event: MouseEvent) => void`
- `onMouseDrop: (event: MouseEvent) => void`
- `onMouseOver: (event: MouseEvent) => void`
- `onMouseOut: (event: MouseEvent) => void`
- `onMouseScroll: (event: MouseEvent) => void`
- `onKeyDown: (key: ParsedKey) => void`

### CliRendererConfig

- `stdin: NodeJS.ReadStream`
- `stdout: NodeJS.WriteStream`
- `exitOnCtrlC: boolean`
- `debounceDelay: number`
- `targetFps: number`
- `memorySnapshotInterval: number`
- `useThread: boolean`
- `gatherStats: boolean`
- `maxStatSamples: number`
- `consoleOptions: ConsoleOptions`
- `postProcessFns: ((buffer: OptimizedBuffer, deltaTime: number) => void)[]`
- `enableMouseMovement: boolean`
- `useMouse: boolean`
- `useAlternateScreen: boolean`
- `useConsole: boolean`
- `experimental_splitHeight: number`

### BoxOptions

- `backgroundColor: string | RGBA`
- `borderStyle: BorderStyle`
- `border: boolean | BorderSides[]`
- `borderColor: string | RGBA`
- `customBorderChars: BorderCharacters`
- `shouldFill: boolean`
- `title: string`
- `titleAlignment: "left" | "center" | "right"`
- `focusedBorderColor: ColorInput`

### TextOptions

- `content: StyledText | string`
- `fg: string | RGBA`
- `bg: string | RGBA`
- `selectionBg: string | RGBA`
- `selectionFg: string | RGBA`
- `selectable: boolean`
- `attributes: number`

### ASCIIFontOptions

- `text: string`
- `font: "tiny" | "block" | "shade" | "slick"`
- `fg: RGBA | RGBA[]`
- `bg: RGBA`
- `selectionBg: string | RGBA`
- `selectionFg: string | RGBA`
- `selectable: boolean`

### InputRenderableOptions

- `backgroundColor: ColorInput`
- `textColor: ColorInput`
- `focusedBackgroundColor: ColorInput`
- `focusedTextColor: ColorInput`
- `placeholder: string`
- `placeholderColor: ColorInput`
- `cursorColor: ColorInput`
- `maxLength: number`
- `value: string`

### TimelineOptions

- `duration: number`
- `loop: boolean`
- `autoplay: boolean`
- `onComplete: () => void`
- `onPause: () => void`

### AnimationOptions

- `duration: number`
- `ease: EasingFunctions`
- `onUpdate: (animation: JSAnimation) => void`
- `onComplete: () => void`
- `onStart: () => void`
- `onLoop: () => void`
- `loop: boolean | number`
- `loopDelay: number`
- `alternate: boolean`
- `once: boolean`
- `: any`

### JSAnimation

- `targets: any[]`
- `deltaTime: number`
- `progress: number`
- `currentTime: number`

