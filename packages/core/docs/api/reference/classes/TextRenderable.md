# TextRenderable

Text display component with support for styling, word wrapping, and text selection. Extends Renderable to provide rich text rendering capabilities in the terminal.

## Constructor

```typescript
new TextRenderable(id: string, options: TextOptions)
```

### Parameters

#### id

Type: `string`

Unique identifier for this text component

#### options

Type: `TextOptions`

Configuration options for the text component. Key properties include:

| Property | Type | Description |
|----------|------|-------------|
| `text` | `string` | The text content to display |
| `color` | `string \| RGBA` | Text foreground color |
| `backgroundColor` | `string \| RGBA` | Text background color |
| `align` | `'left' \| 'center' \| 'right'` | Text alignment |
| `wrap` | `boolean` | Enable word wrapping |
| `selectable` | `boolean` | Allow text selection |
| `bold` | `boolean` | Bold text style |
| `italic` | `boolean` | Italic text style |
| `underline` | `boolean` | Underline text style |
| `parseMarkup` | `boolean` | Parse style markup in text |

## Properties

### selectable

Type: `boolean`

Whether text selection is enabled for this component

### text

Type: `string`

The current text content

### wrap

Type: `boolean`

Whether word wrapping is enabled

## Methods

### setText()

Update the text content

#### Signature

```typescript
setText(text: string): void
```

#### Parameters

- **text**: `string` - New text content to display

### shouldStartSelection()

Determine if selection should start at given coordinates

#### Signature

```typescript
shouldStartSelection(x: number, y: number): boolean
```

#### Parameters

- **x**: `number` - X coordinate relative to component
- **y**: `number` - Y coordinate relative to component

#### Returns

`boolean` - True if selection can start at this position

### onSelectionChanged()

Handle selection state changes

#### Signature

```typescript
onSelectionChanged(selection: SelectionState | null): boolean
```

#### Parameters

- **selection**: `SelectionState | null` - New selection state or null to clear

#### Returns

`boolean` - True if selection was handled

### getSelectedText()

Get currently selected text

#### Signature

```typescript
getSelectedText(): string
```

#### Returns

`string` - The selected text content, empty string if no selection

### hasSelection()

Check if any text is currently selected

#### Signature

```typescript
hasSelection(): boolean
```

#### Returns

`boolean` - True if text is selected

### destroy()

Clean up resources and remove from parent

#### Signature

```typescript
destroy(): void
```

## Examples

### Basic Text

```typescript
const label = new TextRenderable('label', {
  text: 'Hello World',
  color: '#ffffff',
  backgroundColor: '#0000ff'
});
```

### Centered Text with Wrapping

```typescript
const paragraph = new TextRenderable('paragraph', {
  text: 'This is a long paragraph that will wrap to multiple lines when displayed in the terminal.',
  align: 'center',
  wrap: true,
  width: 40
});
```

### Styled Text with Markup

```typescript
const styledText = new TextRenderable('styled', {
  text: '{bold}Important:{/} {red}Error{/} - {underline}Please fix{/}',
  parseMarkup: true
});
```

### Selectable Text

```typescript
const selectableText = new TextRenderable('selectable', {
  text: 'You can select this text with the mouse',
  selectable: true,
  selectionBg: '#ffff00',
  selectionFg: '#000000',
  onSelectionChanged: (selection) => {
    if (selection) {
      console.log('Selected:', selectableText.getSelectedText());
    }
  }
});
```

### Dynamic Text Updates

```typescript
const counter = new TextRenderable('counter', {
  text: 'Count: 0',
  color: '#00ff00'
});

let count = 0;
setInterval(() => {
  count++;
  counter.setText(`Count: ${count}`);
  counter.needsUpdate();
}, 1000);
```

## Markup Syntax

When `parseMarkup` is enabled, you can use inline styles:

- `{bold}text{/}` - Bold text
- `{italic}text{/}` - Italic text
- `{underline}text{/}` - Underlined text
- `{red}text{/}` - Red text (supports all CSS color names)
- `{#ff0000}text{/}` - Hex color codes
- `{bg:blue}text{/}` - Background colors

## See Also

- [TextOptions](../interfaces/TextOptions.md) - Configuration options
- [Renderable](./Renderable.md) - Base component class
- [RGBA](./RGBA.md) - Color utilities