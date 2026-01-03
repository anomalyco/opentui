# OptimizedBuffer

High-performance buffer for terminal rendering. Manages character cells, colors, and dirty regions for efficient updates.

## Constructor

```typescript
new OptimizedBuffer(lib: RenderLib, ptr: Pointer, buffer: {
      char: Uint32Array
      fg: Float32Array
      bg: Float32Array
      attributes: Uint8Array
    }, width: number, height: number, options: { respectAlpha?: boolean })
```

### Parameters

#### lib

Type: `RenderLib`

#### ptr

Type: `Pointer`

#### buffer

Type: `{
      char: Uint32Array
      fg: Float32Array
      bg: Float32Array
      attributes: Uint8Array
    }`

#### width

Type: `number`

#### height

Type: `number`

#### options

Type: `{ respectAlpha?: boolean }`

## Properties

### id

Type: `string`

### lib

Type: `RenderLib`

### respectAlpha

Type: `boolean`

## Methods

### create()

#### Signature

```typescript
create(width: number, height: number, options: { respectAlpha?: boolean }): OptimizedBuffer
```

#### Parameters

- **width**: `number`
- **height**: `number`
- **options**: `{ respectAlpha?: boolean }`

#### Returns

`OptimizedBuffer`

### getWidth()

#### Signature

```typescript
getWidth(): number
```

#### Returns

`number`

### getHeight()

#### Signature

```typescript
getHeight(): number
```

#### Returns

`number`

### setRespectAlpha()

#### Signature

```typescript
setRespectAlpha(respectAlpha: boolean): void
```

#### Parameters

- **respectAlpha**: `boolean`

### clear()

Clear the entire buffer or a region

#### Signature

```typescript
clear(bg: RGBA, clearChar: string): void
```

#### Parameters

- **bg**: `RGBA`
- **clearChar**: `string`

### clearLocal()

#### Signature

```typescript
clearLocal(bg: RGBA, clearChar: string): void
```

#### Parameters

- **bg**: `RGBA`
- **clearChar**: `string`

### setCell()

Set a single character cell

#### Signature

```typescript
setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **char**: `string`
- **fg**: `RGBA`
- **bg**: `RGBA`
- **attributes**: `number`

### get()

#### Signature

```typescript
get(x: number, y: number): { char: number; fg: RGBA; bg: RGBA; attributes: number; }
```

#### Parameters

- **x**: `number`
- **y**: `number`

#### Returns

`{ char: number; fg: RGBA; bg: RGBA; attributes: number; }`

### setCellWithAlphaBlending()

#### Signature

```typescript
setCellWithAlphaBlending(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **char**: `string`
- **fg**: `RGBA`
- **bg**: `RGBA`
- **attributes**: `number`

### setCellWithAlphaBlendingLocal()

#### Signature

```typescript
setCellWithAlphaBlendingLocal(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **char**: `string`
- **fg**: `RGBA`
- **bg**: `RGBA`
- **attributes**: `number`

### drawText()

Draw text at specified position with color

#### Signature

```typescript
drawText(text: string, x: number, y: number, fg: RGBA, bg: RGBA, attributes: number, selection: { start: number; end: number; bgColor?: RGBA; fgColor?: RGBA } | null): void
```

#### Parameters

- **text**: `string`
- **x**: `number`
- **y**: `number`
- **fg**: `RGBA`
- **bg**: `RGBA`
- **attributes**: `number`
- **selection**: `{ start: number; end: number; bgColor?: RGBA; fgColor?: RGBA } | null`

### fillRect()

#### Signature

```typescript
fillRect(x: number, y: number, width: number, height: number, bg: RGBA): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **width**: `number`
- **height**: `number`
- **bg**: `RGBA`

### fillRectLocal()

#### Signature

```typescript
fillRectLocal(x: number, y: number, width: number, height: number, bg: RGBA): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **width**: `number`
- **height**: `number`
- **bg**: `RGBA`

### drawFrameBuffer()

#### Signature

```typescript
drawFrameBuffer(destX: number, destY: number, frameBuffer: OptimizedBuffer, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number): void
```

#### Parameters

- **destX**: `number`
- **destY**: `number`
- **frameBuffer**: `OptimizedBuffer`
- **sourceX**: `number`
- **sourceY**: `number`
- **sourceWidth**: `number`
- **sourceHeight**: `number`

### drawFrameBufferLocal()

#### Signature

```typescript
drawFrameBufferLocal(destX: number, destY: number, frameBuffer: OptimizedBuffer, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number): void
```

#### Parameters

- **destX**: `number`
- **destY**: `number`
- **frameBuffer**: `OptimizedBuffer`
- **sourceX**: `number`
- **sourceY**: `number`
- **sourceWidth**: `number`
- **sourceHeight**: `number`

### destroy()

#### Signature

```typescript
destroy(): void
```

### drawTextBuffer()

#### Signature

```typescript
drawTextBuffer(textBuffer: TextBuffer, x: number, y: number, clipRect: { x: number; y: number; width: number; height: number }): void
```

#### Parameters

- **textBuffer**: `TextBuffer`
- **x**: `number`
- **y**: `number`
- **clipRect**: `{ x: number; y: number; width: number; height: number }`

### drawSuperSampleBuffer()

#### Signature

```typescript
drawSuperSampleBuffer(x: number, y: number, pixelDataPtr: Pointer, pixelDataLength: number, format: "bgra8unorm" | "rgba8unorm", alignedBytesPerRow: number): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **pixelDataPtr**: `Pointer`
- **pixelDataLength**: `number`
- **format**: `"bgra8unorm" | "rgba8unorm"`
- **alignedBytesPerRow**: `number`

### drawSuperSampleBufferFFI()

#### Signature

```typescript
drawSuperSampleBufferFFI(x: number, y: number, pixelDataPtr: Pointer, pixelDataLength: number, format: "bgra8unorm" | "rgba8unorm", alignedBytesPerRow: number): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **pixelDataPtr**: `Pointer`
- **pixelDataLength**: `number`
- **format**: `"bgra8unorm" | "rgba8unorm"`
- **alignedBytesPerRow**: `number`

### drawPackedBuffer()

#### Signature

```typescript
drawPackedBuffer(dataPtr: Pointer, dataLen: number, posX: number, posY: number, terminalWidthCells: number, terminalHeightCells: number): void
```

#### Parameters

- **dataPtr**: `Pointer`
- **dataLen**: `number`
- **posX**: `number`
- **posY**: `number`
- **terminalWidthCells**: `number`
- **terminalHeightCells**: `number`

### setCellWithAlphaBlendingFFI()

#### Signature

```typescript
setCellWithAlphaBlendingFFI(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **char**: `string`
- **fg**: `RGBA`
- **bg**: `RGBA`
- **attributes**: `number`

### fillRectFFI()

#### Signature

```typescript
fillRectFFI(x: number, y: number, width: number, height: number, bg: RGBA): void
```

#### Parameters

- **x**: `number`
- **y**: `number`
- **width**: `number`
- **height**: `number`
- **bg**: `RGBA`

### resize()

#### Signature

```typescript
resize(width: number, height: number): void
```

#### Parameters

- **width**: `number`
- **height**: `number`

### clearFFI()

#### Signature

```typescript
clearFFI(bg: RGBA): void
```

#### Parameters

- **bg**: `RGBA`

### drawTextFFI()

#### Signature

```typescript
drawTextFFI(text: string, x: number, y: number, fg: RGBA, bg: RGBA, attributes: number): void
```

#### Parameters

- **text**: `string`
- **x**: `number`
- **y**: `number`
- **fg**: `RGBA`
- **bg**: `RGBA`
- **attributes**: `number`

### drawFrameBufferFFI()

#### Signature

```typescript
drawFrameBufferFFI(destX: number, destY: number, frameBuffer: OptimizedBuffer, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number): void
```

#### Parameters

- **destX**: `number`
- **destY**: `number`
- **frameBuffer**: `OptimizedBuffer`
- **sourceX**: `number`
- **sourceY**: `number`
- **sourceWidth**: `number`
- **sourceHeight**: `number`

### drawBox()

Draw a box with optional border

#### Signature

```typescript
drawBox(options: {
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
  }): void
```

#### Parameters

- **options**: `{
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
  }`

## See Also

