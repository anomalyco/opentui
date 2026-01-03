# InputRenderable

Single-line text input component with cursor management, selection, and validation support. Provides a terminal-based text field similar to HTML input elements.

## Constructor

```typescript
new InputRenderable(id: string, options: InputRenderableOptions)
```

### Parameters

#### id

Type: `string`

Unique identifier for this input component

#### options

Type: `InputRenderableOptions`

Configuration options for the input field. Key properties include:

| Property | Type | Description |
|----------|------|-------------|
| `value` | `string` | Initial input value |
| `placeholder` | `string` | Placeholder text when empty |
| `maxLength` | `number` | Maximum character limit |
| `password` | `boolean` | Mask input for passwords |
| `cursorStyle` | `'block' \| 'line' \| 'underline'` | Cursor appearance |
| `cursorColor` | `string \| RGBA` | Cursor color |
| `focusedBorderColor` | `string \| RGBA` | Border color when focused |
| `backgroundColor` | `string \| RGBA` | Input background color |
| `textColor` | `string \| RGBA` | Input text color |
| `placeholderColor` | `string \| RGBA` | Placeholder text color |
| `pattern` | `RegExp` | Validation pattern |
| `onChange` | `(value: string) => void` | Value change callback |
| `onSubmit` | `(value: string) => void` | Enter key callback |

## Properties

### value

Type: `string`

Current input value

### cursorPosition

Type: `number`

Current cursor position in the text

### selectionStart

Type: `number`

Start position of text selection

### selectionEnd

Type: `number`

End position of text selection

## Methods

### focus()

Give keyboard focus to the input field

#### Signature

```typescript
focus(): void
```

### blur()

Remove keyboard focus from the input field

#### Signature

```typescript
blur(): void
```

### setValue()

Set the input value programmatically

#### Signature

```typescript
setValue(value: string): void
```

#### Parameters

- **value**: `string` - New value to set

### clear()

Clear the input value

#### Signature

```typescript
clear(): void
```

### selectAll()

Select all text in the input

#### Signature

```typescript
selectAll(): void
```

### setCursorPosition()

Move cursor to specific position

#### Signature

```typescript
setCursorPosition(position: number): void
```

#### Parameters

- **position**: `number` - Character position (0-based)

### insertText()

Insert text at cursor position

#### Signature

```typescript
insertText(text: string): void
```

#### Parameters

- **text**: `string` - Text to insert

### deleteSelection()

Delete currently selected text

#### Signature

```typescript
deleteSelection(): void
```

### handleKeyPress()

Process keyboard input

#### Signature

```typescript
handleKeyPress(key: ParsedKey | string): boolean
```

#### Parameters

- **key**: `ParsedKey | string` - Keyboard event

#### Returns

`boolean` - True if the input handled the key

### validate()

Check if current value is valid

#### Signature

```typescript
validate(): boolean
```

#### Returns

`boolean` - True if value passes validation

## Examples

### Basic Input Field

```typescript
const nameInput = new InputRenderable('name', {
  placeholder: 'Enter your name...',
  width: 30,
  onChange: (value) => {
    console.log('Name:', value);
  }
});
```

### Password Input

```typescript
const passwordInput = new InputRenderable('password', {
  placeholder: 'Password',
  password: true,
  minLength: 8,
  maxLength: 32,
  onSubmit: (value) => {
    login(value);
  }
});
```

### Validated Input

```typescript
const emailInput = new InputRenderable('email', {
  placeholder: 'Email address',
  pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  onChange: (value) => {
    if (!emailInput.validate()) {
      emailInput.setBorderColor('#ff0000');
    } else {
      emailInput.setBorderColor('#00ff00');
    }
  }
});
```

### Styled Input

```typescript
const styledInput = new InputRenderable('styled', {
  value: 'Initial text',
  backgroundColor: '#2e2e2e',
  textColor: '#ffffff',
  cursorColor: '#00ff00',
  cursorStyle: 'block',
  focusedBorderColor: '#00aaff',
  border: true,
  borderStyle: 'rounded',
  padding: 1
});
```

### Form with Multiple Inputs

```typescript
class LoginForm extends BoxRenderable {
  private usernameInput: InputRenderable;
  private passwordInput: InputRenderable;
  
  constructor() {
    super('login-form', {
      flexDirection: 'column',
      gap: 1,
      padding: 2,
      border: true,
      title: 'Login'
    });
    
    this.usernameInput = new InputRenderable('username', {
      placeholder: 'Username',
      width: '100%',
      onSubmit: () => this.passwordInput.focus()
    });
    
    this.passwordInput = new InputRenderable('password', {
      placeholder: 'Password',
      password: true,
      width: '100%',
      onSubmit: () => this.submit()
    });
    
    this.add(this.usernameInput, 0);
    this.add(this.passwordInput, 1);
  }
  
  private submit() {
    const username = this.usernameInput.value;
    const password = this.passwordInput.value;
    // Handle login
  }
}
```

## Keyboard Shortcuts

- **Left/Right Arrow** - Move cursor
- **Home/End** - Jump to start/end
- **Backspace** - Delete before cursor
- **Delete** - Delete after cursor
- **Ctrl+A** - Select all
- **Ctrl+C** - Copy selection
- **Ctrl+V** - Paste
- **Ctrl+X** - Cut selection
- **Enter** - Submit (triggers onSubmit)
- **Escape** - Blur input

## See Also

- [InputRenderableOptions](../interfaces/InputRenderableOptions.md) - Configuration options
- [Renderable](./Renderable.md) - Base component class
- [TextRenderable](./TextRenderable.md) - Text display component