# BoxOptions

Configuration options for creating BoxRenderable components. Extends RenderableOptions with box-specific styling like borders, padding, and title support.

## Properties

### alignItems?

**Type:** `AlignString`

Controls alignment of child items along the cross axis in flexbox layout. Options: 'flex-start', 'flex-end', 'center', 'stretch', 'baseline'

### backgroundColor?

**Type:** `string | RGBA`

Background color of the box. Accepts CSS color strings ('#ffffff', 'red') or RGBA objects

### border?

**Type:** `boolean | array`

Enable border rendering. Can be boolean for all sides or array to specify individual sides: [top, right, bottom, left]

### borderColor?

**Type:** `string | RGBA`

Color of the border when enabled. Accepts CSS color strings or RGBA objects

### borderStyle?

**Type:** `BorderStyle`

Style of border characters: 'single' (─│), 'double' (═║), 'rounded' (╭╮), 'heavy' (━┃)

### bottom?

**Type:** `number | string | string`

### buffered?

**Type:** `boolean`

### customBorderChars?

**Type:** `BorderCharacters`

### enableLayout?

**Type:** `boolean`

### flexBasis?

**Type:** `number | string`

### flexDirection?

**Type:** `FlexDirectionString`

### flexGrow?

**Type:** `number`

### flexShrink?

**Type:** `number`

### focusedBorderColor?

**Type:** `ColorInput`

Border color when the box has keyboard focus. Useful for indicating active state

### height?

**Type:** `number | string | string`

### justifyContent?

**Type:** `JustifyString`

### left?

**Type:** `number | string | string`

### live?

**Type:** `boolean`

### margin?

**Type:** `number | string | string`

### marginBottom?

**Type:** `number | string | string`

### marginLeft?

**Type:** `number | string | string`

### marginRight?

**Type:** `number | string | string`

### marginTop?

**Type:** `number | string | string`

### maxHeight?

**Type:** `number`

### maxWidth?

**Type:** `number`

### minHeight?

**Type:** `number`

### minWidth?

**Type:** `number`

### onKeyDown?

**Type:** `object`

(key: ParsedKey) => void

### onMouseDown?

**Type:** `object`

(event: MouseEvent) => void

### onMouseDrag?

**Type:** `object`

(event: MouseEvent) => void

### onMouseDragEnd?

**Type:** `object`

(event: MouseEvent) => void

### onMouseDrop?

**Type:** `object`

(event: MouseEvent) => void

### onMouseMove?

**Type:** `object`

(event: MouseEvent) => void

### onMouseOut?

**Type:** `object`

(event: MouseEvent) => void

### onMouseOver?

**Type:** `object`

(event: MouseEvent) => void

### onMouseScroll?

**Type:** `object`

(event: MouseEvent) => void

### onMouseUp?

**Type:** `object`

(event: MouseEvent) => void

### padding?

**Type:** `number | string`

### paddingBottom?

**Type:** `number | string`

### paddingLeft?

**Type:** `number | string`

### paddingRight?

**Type:** `number | string`

### paddingTop?

**Type:** `number | string`

### position?

**Type:** `PositionTypeString`

### right?

**Type:** `number | string | string`

### shouldFill?

**Type:** `boolean`

### title?

**Type:** `string`

Optional title text displayed in the top border of the box

### titleAlignment?

**Type:** `string`

Alignment of the title within the top border: 'left', 'center', 'right'

### top?

**Type:** `number | string | string`

### visible?

**Type:** `boolean`

### width?

**Type:** `number | string | string`

### zIndex?

**Type:** `number`

Layer order for overlapping components. Higher values appear on top

## Examples

```typescript
// Basic box with border
const box = new BoxRenderable('my-box', {
  width: 40,
  height: 10,
  border: true,
  borderStyle: 'rounded',
  borderColor: '#00ff00'
});

// Box with title and padding
const titledBox = new BoxRenderable('titled', {
  width: '50%',
  height: 15,
  border: true,
  title: 'Settings',
  titleAlignment: 'center',
  padding: 1,
  backgroundColor: '#1e1e1e'
});

// Flexbox container
const container = new BoxRenderable('container', {
  width: '100%',
  height: '100%',
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: 2
});

// Interactive box with focus highlight
const interactiveBox = new BoxRenderable('interactive', {
  width: 30,
  height: 5,
  border: true,
  borderColor: '#808080',
  focusedBorderColor: '#00ff00',
  onMouseDown: (event) => {
    console.log('Box clicked!');
  },
  onKeyDown: (key) => {
    if (key.name === 'enter') {
      // Handle enter key
    }
  }
});
```

## See Also

- [RenderableOptions](./RenderableOptions.md) - Base options inherited by BoxOptions
- [BoxRenderable](../classes/BoxRenderable.md) - Box component class
- [BorderStyle](../types/BorderStyle.md) - Available border styles

