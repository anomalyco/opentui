# CliRenderer

Main renderer class that manages the terminal output, input handling, and render loop.

## Constructor

```typescript
new CliRenderer(lib: RenderLib, rendererPtr: Pointer, stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, width: number, height: number, config: CliRendererConfig)
```

### Parameters

#### lib

Type: `RenderLib`

#### rendererPtr

Type: `Pointer`

#### stdin

Type: `NodeJS.ReadStream`

#### stdout

Type: `NodeJS.WriteStream`

#### width

Type: `number`

#### height

Type: `number`

#### config

Type: `CliRendererConfig`

## Properties

### rendererPtr

Type: `Pointer`

### nextRenderBuffer

Type: `OptimizedBuffer`

Buffer being prepared for next frame

### currentRenderBuffer

Type: `OptimizedBuffer`

Currently displayed buffer

### root

Type: `RootRenderable`

Root renderable that contains all UI components

### width

Type: `number`

Current terminal width in characters

### height

Type: `number`

Current terminal height in characters

### debugOverlay

Type: `any`

Debug information overlay component

## Methods

### needsUpdate()

Mark the renderer as needing to re-render

#### Signature

```typescript
needsUpdate(): void
```

### setMemorySnapshotInterval()

#### Signature

```typescript
setMemorySnapshotInterval(interval: number): void
```

#### Parameters

- **interval**: `number`

### setBackgroundColor()

Set the default background color

#### Signature

```typescript
setBackgroundColor(color: ColorInput): void
```

#### Parameters

- **color**: `ColorInput`

### toggleDebugOverlay()

Toggle debug information display

#### Signature

```typescript
toggleDebugOverlay(): void
```

### configureDebugOverlay()

#### Signature

```typescript
configureDebugOverlay(options: { enabled?: boolean; corner?: DebugOverlayCorner }): void
```

#### Parameters

- **options**: `{ enabled?: boolean; corner?: DebugOverlayCorner }`

### clearTerminal()

#### Signature

```typescript
clearTerminal(): void
```

### dumpHitGrid()

#### Signature

```typescript
dumpHitGrid(): void
```

### dumpBuffers()

#### Signature

```typescript
dumpBuffers(timestamp: number): void
```

#### Parameters

- **timestamp**: `number`

### dumpStdoutBuffer()

#### Signature

```typescript
dumpStdoutBuffer(timestamp: number): void
```

#### Parameters

- **timestamp**: `number`

### setCursorPosition()

#### Signature

```typescript
setCursorPosition(x: number, y: number, visible: boolean): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **visible**: `boolean`

### setCursorStyle()

#### Signature

```typescript
setCursorStyle(style: CursorStyle, blinking: boolean, color: RGBA): void
```

#### Parameters

- **style**: `CursorStyle`
- **blinking**: `boolean`
- **color**: `RGBA`

### setCursorColor()

#### Signature

```typescript
setCursorColor(color: RGBA): void
```

#### Parameters

- **color**: `RGBA`

### setCursorPosition()

#### Signature

```typescript
setCursorPosition(x: number, y: number, visible: boolean): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **visible**: `boolean`

### setCursorStyle()

#### Signature

```typescript
setCursorStyle(style: CursorStyle, blinking: boolean, color: RGBA): void
```

#### Parameters

- **style**: `CursorStyle`
- **blinking**: `boolean`
- **color**: `RGBA`

### setCursorColor()

#### Signature

```typescript
setCursorColor(color: RGBA): void
```

#### Parameters

- **color**: `RGBA`

### addPostProcessFn()

#### Signature

```typescript
addPostProcessFn(processFn: (buffer: OptimizedBuffer, deltaTime: number) => void): void
```

#### Parameters

- **processFn**: `(buffer: OptimizedBuffer, deltaTime: number) => void`

### removePostProcessFn()

#### Signature

```typescript
removePostProcessFn(processFn: (buffer: OptimizedBuffer, deltaTime: number) => void): void
```

#### Parameters

- **processFn**: `(buffer: OptimizedBuffer, deltaTime: number) => void`

### clearPostProcessFns()

#### Signature

```typescript
clearPostProcessFns(): void
```

### setFrameCallback()

#### Signature

```typescript
setFrameCallback(callback: (deltaTime: number) => Promise<void>): void
```

#### Parameters

- **callback**: `(deltaTime: number) => Promise<void>`

### removeFrameCallback()

#### Signature

```typescript
removeFrameCallback(callback: (deltaTime: number) => Promise<void>): void
```

#### Parameters

- **callback**: `(deltaTime: number) => Promise<void>`

### clearFrameCallbacks()

#### Signature

```typescript
clearFrameCallbacks(): void
```

### requestLive()

#### Signature

```typescript
requestLive(): void
```

### dropLive()

#### Signature

```typescript
dropLive(): void
```

### start()

Start the render loop

#### Signature

```typescript
start(): void
```

### pause()

#### Signature

```typescript
pause(): void
```

### stop()

Stop the render loop and clean up

#### Signature

```typescript
stop(): void
```

### destroy()

#### Signature

```typescript
destroy(): void
```

### intermediateRender()

#### Signature

```typescript
intermediateRender(): void
```

### getStats()

#### Signature

```typescript
getStats(): { fps: number; frameCount: number; frameTimes: number[]; averageFrameTime: number; minFrameTime: number; maxFrameTime: number; }
```

#### Returns

`{ fps: number; frameCount: number; frameTimes: number[]; averageFrameTime: number; minFrameTime: number; maxFrameTime: number; }`

### resetStats()

#### Signature

```typescript
resetStats(): void
```

### setGatherStats()

#### Signature

```typescript
setGatherStats(enabled: boolean): void
```

#### Parameters

- **enabled**: `boolean`

### getSelection()

#### Signature

```typescript
getSelection(): Selection
```

#### Returns

`Selection`

### getSelectionContainer()

#### Signature

```typescript
getSelectionContainer(): Renderable
```

#### Returns

`Renderable`

### hasSelection()

#### Signature

```typescript
hasSelection(): boolean
```

#### Returns

`boolean`

### clearSelection()

#### Signature

```typescript
clearSelection(): void
```

## Examples

```typescript
// Create and configure renderer
const renderer = new CliRenderer(lib, ptr, stdin, stdout, 80, 24, {
  backgroundColor: '#1e1e1e',
  showFPS: true,
  debugOverlayCorner: DebugOverlayCorner.TOP_RIGHT
});

// Add components
renderer.root.add(new BoxRenderable('main', {
  width: '100%',
  height: '100%',
  border: true,
  borderStyle: 'rounded'
}));

// Start rendering
renderer.start();
```

## See Also

