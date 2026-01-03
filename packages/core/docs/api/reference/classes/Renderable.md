# Renderable

Base class for all visual components in OpenTUI. Provides layout, rendering, and event handling capabilities.

## Constructor

```typescript
new Renderable(id: string, options: RenderableOptions)
```

### Parameters

#### id

Type: `string`

#### options

Type: `RenderableOptions`

Available options:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `alignItems` | `AlignString` |  |  |
| `bottom` | `any` |  |  |
| `buffered` | `boolean` |  |  |
| `enableLayout` | `boolean` |  |  |
| `flexBasis` | `any` |  |  |
| `flexDirection` | `FlexDirectionString` |  |  |
| `flexGrow` | `number` |  |  |
| `flexShrink` | `number` |  |  |
| `height` | `any` |  |  |
| `justifyContent` | `JustifyString` |  |  |

...and 32 more properties

## Properties

### renderablesByNumber

Type: `Map<number, Renderable>`

Static map for fast renderable lookups by numeric ID

### id

Type: `string`

Unique identifier for this renderable

### num

Type: `number`

Internal numeric identifier used for fast lookups

### selectable

Type: `boolean`

Whether this component can receive text selection

### parent

Type: `Renderable | null`

Parent renderable in the component tree

## Methods

### hasSelection()

Check if this renderable has active text selection

#### Signature

```typescript
hasSelection(): boolean
```

#### Returns

`boolean`

### onSelectionChanged()

#### Signature

```typescript
onSelectionChanged(selection: SelectionState | null): boolean
```

#### Parameters

- **selection**: `SelectionState | null`

#### Returns

`boolean`

### getSelectedText()

Get currently selected text if any

#### Signature

```typescript
getSelectedText(): string
```

#### Returns

`string`

### shouldStartSelection()

#### Signature

```typescript
shouldStartSelection(x: number, y: number): boolean
```

#### Parameters

- **x**: `number`
- **y**: `number`

#### Returns

`boolean`

### focus()

Give keyboard focus to this renderable

#### Signature

```typescript
focus(): void
```

### blur()

Remove keyboard focus from this renderable

#### Signature

```typescript
blur(): void
```

### handleKeyPress()

Process keyboard input - returns true if handled

#### Signature

```typescript
handleKeyPress(key: ParsedKey | string): boolean
```

#### Parameters

- **key**: `ParsedKey | string`

#### Returns

`boolean`

### needsUpdate()

Mark this renderable as needing re-render

#### Signature

```typescript
needsUpdate(): void
```

### requestZIndexSort()

#### Signature

```typescript
requestZIndexSort(): void
```

### setPosition()

#### Signature

```typescript
setPosition(position: Position): void
```

#### Parameters

- **position**: `Position`

### getLayoutNode()

#### Signature

```typescript
getLayoutNode(): TrackedNode<NodeMetadata>
```

#### Returns

`TrackedNode<NodeMetadata>`

### updateFromLayout()

#### Signature

```typescript
updateFromLayout(): void
```

### add()

Add a child renderable at the specified index

#### Signature

```typescript
add(obj: Renderable, index: number): number
```

#### Parameters

- **obj**: `Renderable`
- **index**: `number`

#### Returns

`number`

### insertBefore()

#### Signature

```typescript
insertBefore(obj: Renderable, anchor: Renderable): number
```

#### Parameters

- **obj**: `Renderable`
- **anchor**: `Renderable`

#### Returns

`number`

### propagateContext()

#### Signature

```typescript
propagateContext(ctx: RenderContext | null): void
```

#### Parameters

- **ctx**: `RenderContext | null`

### getRenderable()

#### Signature

```typescript
getRenderable(id: string): Renderable
```

#### Parameters

- **id**: `string`

#### Returns

`Renderable`

### remove()

Remove a child renderable by ID

#### Signature

```typescript
remove(id: string): void
```

#### Parameters

- **id**: `string`

### getChildren()

#### Signature

```typescript
getChildren(): Renderable[]
```

#### Returns

`Renderable[]`

### render()

Render this component and its children to the buffer

#### Signature

```typescript
render(buffer: OptimizedBuffer, deltaTime: number): void
```

#### Parameters

- **buffer**: `OptimizedBuffer`
- **deltaTime**: `number`

### destroy()

Clean up resources and remove from parent

#### Signature

```typescript
destroy(): void
```

### destroyRecursively()

#### Signature

```typescript
destroyRecursively(): void
```

### processMouseEvent()

Process mouse events and propagate to children

#### Signature

```typescript
processMouseEvent(event: MouseEvent): void
```

#### Parameters

- **event**: `MouseEvent`

## Examples

```typescript
// Create a custom renderable
class MyComponent extends Renderable {
  constructor(id: string, options: RenderableOptions) {
    super(id, options);
  }
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Custom rendering logic
    buffer.drawText('Hello World', this.x, this.y, RGBA.white());
  }
}

// Add event handlers
const component = new MyComponent('my-comp', {
  width: 20,
  height: 10,
  onMouseDown: (event) => {
    console.log('Clicked!');
  },
  onKeyDown: (key) => {
    if (key.name === 'escape') {
      component.blur();
    }
  }
});
```

## See Also

- [RenderableOptions](../interfaces/RenderableOptions.md) - Configuration options
- [MouseEvent](./MouseEvent.md) - Mouse event handling
- [OptimizedBuffer](./OptimizedBuffer.md) - Rendering target
