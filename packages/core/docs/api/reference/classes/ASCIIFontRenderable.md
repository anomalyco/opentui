# ASCIIFontRenderable

Renders text using ASCII art fonts for decorative headers and titles. Supports both built-in and custom font definitions.

## Constructor

```typescript
new ASCIIFontRenderable(id: string, options: ASCIIFontOptions)
```

### Parameters

#### id

Type: `string`

Unique identifier for this ASCII font component

#### options

Type: `ASCIIFontOptions`

Configuration options for ASCII font rendering. Key properties include:

| Property | Type | Description |
|----------|------|-------------|
| `text` | `string` | Text to render in ASCII art |
| `font` | `string \| FontDefinition` | Font name or custom font definition |
| `color` | `string \| RGBA` | Text color |
| `backgroundColor` | `string \| RGBA` | Background color |
| `align` | `'left' \| 'center' \| 'right'` | Text alignment |
| `letterSpacing` | `number` | Extra space between characters |
| `lineHeight` | `number` | Multiplier for line spacing |

## Properties

### text

Type: `string`

Current text being displayed

### font

Type: `string | FontDefinition`

Active font for rendering

### height

Type: `number`

Calculated height of the ASCII art text

## Methods

### setText()

Update the displayed text

#### Signature

```typescript
setText(text: string): void
```

#### Parameters

- **text**: `string` - New text to render

### setFont()

Change the font

#### Signature

```typescript
setFont(font: string | FontDefinition): void
```

#### Parameters

- **font**: `string | FontDefinition` - Font name or custom definition

### registerFont()

Register a custom font for use

#### Signature

```typescript
static registerFont(name: string, definition: FontDefinition): void
```

#### Parameters

- **name**: `string` - Name to register the font under
- **definition**: `FontDefinition` - Font character definitions

## Built-in Fonts

OpenTUI includes several built-in ASCII fonts:

### default
Standard block letters, clean and readable

### bulky
Bold, heavy characters for emphasis

### chrome
Metallic-style letters with shine effects

### huge
Extra large letters for maximum impact

## Examples

### Basic ASCII Title

```typescript
const title = new ASCIIFontRenderable('title', {
  text: 'WELCOME',
  font: 'default',
  color: '#00ff00',
  align: 'center'
});
```

### Styled Banner

```typescript
const banner = new ASCIIFontRenderable('banner', {
  text: 'GAME OVER',
  font: 'huge',
  color: '#ff0000',
  backgroundColor: '#000000',
  align: 'center',
  letterSpacing: 1
});
```

### Custom Font Definition

```typescript
const customFont: FontDefinition = {
  height: 5,
  chars: {
    'A': [
      '  █  ',
      ' █ █ ',
      '█████',
      '█   █',
      '█   █'
    ],
    'B': [
      '████ ',
      '█   █',
      '████ ',
      '█   █',
      '████ '
    ]
    // ... more characters
  }
};

const customText = new ASCIIFontRenderable('custom', {
  text: 'AB',
  font: customFont,
  color: '#ffffff'
});
```

### Registering Custom Fonts

```typescript
// Register a custom font globally
ASCIIFontRenderable.registerFont('pixel', {
  height: 3,
  chars: {
    'A': ['█▀█', '███', '▀ ▀'],
    'B': ['██▄', '██▄', '██▀'],
    'C': ['▄██', '█  ', '▀██'],
    // ... more characters
  }
});

// Use the registered font
const pixelText = new ASCIIFontRenderable('pixel-text', {
  text: 'ABC',
  font: 'pixel',
  color: '#00ffff'
});
```

### Animated ASCII Text

```typescript
const animatedTitle = new ASCIIFontRenderable('animated', {
  text: 'LOADING',
  font: 'chrome',
  color: '#ffffff'
});

// Animate color
let hue = 0;
setInterval(() => {
  hue = (hue + 10) % 360;
  animatedTitle.setColor(RGBA.fromHSL(hue, 100, 50));
  animatedTitle.needsUpdate();
}, 100);

// Animate text
const frames = ['LOADING', 'LOADING.', 'LOADING..', 'LOADING...'];
let frame = 0;
setInterval(() => {
  animatedTitle.setText(frames[frame]);
  frame = (frame + 1) % frames.length;
}, 500);
```

## Font Definition Structure

```typescript
interface FontDefinition {
  height: number;  // Height of each character in lines
  chars: {
    [char: string]: string[];  // Array of strings, one per line
  };
  kerning?: {
    [pair: string]: number;  // Spacing adjustment for character pairs
  };
}
```

### Creating Font Definitions

1. Each character is an array of strings
2. All strings must have the same width
3. The array length must match the font height
4. Use Unicode box-drawing characters for best results

```typescript
const miniFont: FontDefinition = {
  height: 3,
  chars: {
    'H': [
      '█ █',
      '███',
      '█ █'
    ],
    'I': [
      '███',
      ' █ ',
      '███'
    ]
  }
};
```

## See Also

- [ASCIIFontOptions](../interfaces/ASCIIFontOptions.md) - Configuration options
- [FontDefinition](../interfaces/FontDefinition.md) - Custom font structure
- [TextRenderable](./TextRenderable.md) - Standard text component
- [Renderable](./Renderable.md) - Base component class