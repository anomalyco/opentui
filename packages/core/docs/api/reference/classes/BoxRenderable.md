# BoxRenderable

Container component that provides borders, padding, and flexbox layout. The most fundamental building block for OpenTUI interfaces, similar to a `div` element in HTML.

## Constructor

```typescript
new BoxRenderable(id: string, options: BoxOptions)
```

### Parameters

#### id

Type: `string`

Unique identifier for this box component

#### options

Type: `BoxOptions`

Configuration options for the box. See [BoxOptions](../interfaces/BoxOptions.md) for full details.

## Properties

### border

Type: `boolean | [boolean, boolean, boolean, boolean]`

Border configuration - either all sides or [top, right, bottom, left]

### borderStyle

Type: `BorderStyle`

Style of border characters ('single', 'double', 'rounded', 'heavy')

### title

Type: `string`

Optional title displayed in the top border

### padding

Type: `number | { top: number, right: number, bottom: number, left: number }`

Internal spacing between border and content

### children

Type: `Renderable[]`

Child components contained within this box

## Methods

### setBorderStyle()

Change the border style

#### Signature

```typescript
setBorderStyle(style: BorderStyle): void
```

#### Parameters

- **style**: `BorderStyle` - New border style to apply

### setTitle()

Update the box title

#### Signature

```typescript
setTitle(title: string): void
```

#### Parameters

- **title**: `string` - New title text

### setPadding()

Adjust internal padding

#### Signature

```typescript
setPadding(padding: number | { top: number, right: number, bottom: number, left: number }): void
```

#### Parameters

- **padding**: `number | object` - Uniform padding or individual sides

### showBorder()

Show or hide the border

#### Signature

```typescript
showBorder(show: boolean): void
```

#### Parameters

- **show**: `boolean` - Whether to display the border

## Layout Properties

BoxRenderable supports flexbox layout for arranging child components:

### flexDirection
- `'row'` - Horizontal layout (default)
- `'column'` - Vertical layout
- `'row-reverse'` - Horizontal, reversed
- `'column-reverse'` - Vertical, reversed

### justifyContent
- `'flex-start'` - Align to start
- `'flex-end'` - Align to end
- `'center'` - Center items
- `'space-between'` - Space between items
- `'space-around'` - Space around items
- `'space-evenly'` - Even spacing

### alignItems
- `'flex-start'` - Align to cross-axis start
- `'flex-end'` - Align to cross-axis end
- `'center'` - Center on cross-axis
- `'stretch'` - Stretch to fill
- `'baseline'` - Align text baselines

## Examples

### Basic Container

```typescript
const container = new BoxRenderable('container', {
  width: 50,
  height: 10,
  border: true,
  borderStyle: 'single'
});
```

### Titled Panel

```typescript
const panel = new BoxRenderable('panel', {
  width: '100%',
  height: 20,
  border: true,
  borderStyle: 'double',
  title: '⚙ Settings',
  titleAlignment: 'center',
  padding: 2,
  backgroundColor: '#1e1e1e'
});
```

### Flexbox Layout

```typescript
const layout = new BoxRenderable('layout', {
  width: '100%',
  height: '100%',
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: 1
});

// Add child components
const sidebar = new BoxRenderable('sidebar', {
  width: 20,
  height: '100%',
  border: true,
  borderStyle: 'single'
});

const content = new BoxRenderable('content', {
  flexGrow: 1,
  height: '100%',
  border: true,
  borderStyle: 'single',
  margin: { left: 1 }
});

layout.add(sidebar, 0);
layout.add(content, 1);
```

### Nested Boxes

```typescript
const outer = new BoxRenderable('outer', {
  width: 60,
  height: 30,
  border: true,
  borderStyle: 'heavy',
  borderColor: '#ff0000',
  padding: 2
});

const inner = new BoxRenderable('inner', {
  width: '100%',
  height: '100%',
  border: true,
  borderStyle: 'rounded',
  borderColor: '#00ff00',
  backgroundColor: '#002200',
  padding: 1
});

outer.add(inner, 0);
```

### Custom Border Characters

```typescript
const customBox = new BoxRenderable('custom', {
  width: 40,
  height: 10,
  border: true,
  customBorderChars: {
    topLeft: '╔',
    topRight: '╗',
    bottomLeft: '╚',
    bottomRight: '╝',
    horizontal: '═',
    vertical: '║',
    topT: '╦',
    bottomT: '╩',
    leftT: '╠',
    rightT: '╣',
    cross: '╬'
  }
});
```

### Interactive Box

```typescript
const interactive = new BoxRenderable('interactive', {
  width: 30,
  height: 10,
  border: true,
  borderColor: '#808080',
  focusedBorderColor: '#00ff00',
  backgroundColor: '#1e1e1e',
  padding: 1,
  
  onMouseDown: (event) => {
    console.log('Box clicked at:', event.x, event.y);
  },
  
  onMouseOver: (event) => {
    interactive.setBorderColor('#ffff00');
    interactive.needsUpdate();
  },
  
  onMouseOut: (event) => {
    interactive.setBorderColor('#808080');
    interactive.needsUpdate();
  },
  
  onKeyDown: (key) => {
    if (key.name === 'space') {
      // Handle spacebar
    }
  }
});

// Make it focusable
interactive.focus();
```

### Responsive Grid

```typescript
class GridLayout extends BoxRenderable {
  constructor() {
    super('grid', {
      width: '100%',
      height: '100%',
      flexDirection: 'column'
    });
    
    // Create rows
    for (let row = 0; row < 3; row++) {
      const rowBox = new BoxRenderable(`row-${row}`, {
        width: '100%',
        flexGrow: 1,
        flexDirection: 'row'
      });
      
      // Create columns in each row
      for (let col = 0; col < 3; col++) {
        const cell = new BoxRenderable(`cell-${row}-${col}`, {
          flexGrow: 1,
          height: '100%',
          border: true,
          borderStyle: 'single',
          padding: 1,
          margin: 0.5
        });
        
        rowBox.add(cell, col);
      }
      
      this.add(rowBox, row);
    }
  }
}
```

## Styling Priority

When multiple style properties conflict, they are applied in this order:
1. Inline styles (set via methods)
2. Focus styles (when component has focus)
3. Hover styles (when mouse is over)
4. Default styles (from options)

## Performance Tips

1. Use `buffered: true` for boxes that update frequently
2. Minimize deeply nested boxes for better rendering performance
3. Use percentage-based sizing for responsive layouts
4. Enable `shouldFill: false` if the box doesn't need to clear its background

## See Also

- [BoxOptions](../interfaces/BoxOptions.md) - Configuration options
- [BorderStyle](../types/BorderStyle.md) - Border style types
- [Renderable](./Renderable.md) - Base component class
- [TextRenderable](./TextRenderable.md) - Text content component