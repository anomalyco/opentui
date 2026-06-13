# @opentui/react

A React renderer for building terminal user interfaces using [OpenTUI core](https://github.com/anomalyco/opentui). Create rich, interactive console applications with familiar React patterns and components.

## Installation

Quick start with [bun](https://bun.sh) and [create-tui](https://github.com/msmps/create-tui):

```bash
bun create tui --template react
```

Manual installation:

```bash
bun install @opentui/react @opentui/core react
```

## Quick Start

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return <text>Hello, world!</text>
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

## TypeScript Configuration

For optimal TypeScript support, configure your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "strict": true,
    "skipLibCheck": true
  }
}
```

## Table of Contents

- [Core Concepts](#core-concepts)
  - [Components](#components)
  - [Styling](#styling)
- [API Reference](#api-reference)
  - [createRoot(renderer)](#createrootrenderer)
  - [render(element, config?)](#renderelement-config-deprecated)
  - [Hooks](#hooks)
    - [useRenderer()](#userenderer)
    - [useKeyboard(handler, options?)](#usekeyboardhandler-options)
    - [usePaste(handler)](#usepastehandler)
    - [useFocus(handler)](#usefocushandler)
    - [useBlur(handler)](#useblurhandler)
    - [useSelectionHandler(handler)](#useselectionhandlerhandler)
    - [useOnResize(callback)](#useonresizecallback)
    - [useTerminalDimensions()](#useterminaldimensions)
    - [useTimeline(options?)](#usetimelineoptions)
- [Components](#components-1)
  - [Layout & Display Components](#layout--display-components)
    - [Text Component](#text-component)
    - [Box Component](#box-component)
    - [Scrollbox Component](#scrollbox-component)
    - [ASCII Font Component](#ascii-font-component)
  - [Input Components](#input-components)
    - [Input Component](#input-component)
    - [Textarea Component](#textarea-component)
    - [Select Component](#select-component)
  - [Code & Diff Components](#code--diff-components)
    - [Code Component](#code-component)
    - [Line Number Component](#line-number-component)
    - [Diff Component](#diff-component)
- [Examples](#examples)
  - [Login Form](#login-form)
  - [Counter with Timer](#counter-with-timer)
  - [System Monitor Animation](#system-monitor-animation)
  - [Styled Text Showcase](#styled-text-showcase)
- [Component Extension](#component-extension)
- [Using React DevTools](#using-react-devtools)

## Core Concepts

### Components

OpenTUI React provides several built-in components that map to OpenTUI core renderables:

**Layout & Display:**

- **`<text>`** - Display text with styling
- **`<box>`** - Container with borders and layout
- **`<scrollbox>`** - A scrollable box
- **`<ascii-font>`** - Display ASCII art text with different font styles

QR code support is available from `@opentui/qrcode/react` and must be registered explicitly with `registerQRCode()`.

**Input Components:**

- **`<input>`** - Text input field
- **`<textarea>`** - Multi-line text input field
- **`<select>`** - Selection dropdown
- **`<tab-select>`** - Tab-based selection

**Code & Diff Components:**

- **`<code>`** - Code block with syntax highlighting
- **`<line-number>`** - Code display with line numbers, diff highlights, and diagnostics
- **`<diff>`** - Unified or split diff viewer with syntax highlighting

**Helpers:**

- **`<span>`, `<strong>`, `<em>`, `<u>`, `<b>`, `<i>`, `<br>`** - Text modifiers (_must be used inside of the text component_)

### Styling

Components can be styled using props or the `style` prop:

```tsx
// Direct props
<box backgroundColor="blue" padding={2}>
  <text>Hello, world!</text>
</box>

// Style prop
<box style={{ backgroundColor: "blue", padding: 2 }}>
  <text>Hello, world!</text>
</box>
```

## API Reference

### `createRoot(renderer)`

Creates a root for rendering a React tree with the given CLI renderer.

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

const renderer = await createCliRenderer({
  // Optional renderer configuration
  exitOnCtrlC: false,
})
createRoot(renderer).render(<App />)
```

**Parameters:**

- `renderer`: A `CliRenderer` instance (typically created with `createCliRenderer()`)

**Returns:** An object with a `render` method that accepts a React element.

### `render(element, config?)` (Deprecated)

> **Deprecated:** Use `createRoot(renderer).render(node)` instead.

Renders a React element to the terminal. This function is deprecated in favor of `createRoot`.

### Hooks

#### `useRenderer()`

Access the OpenTUI renderer instance.

```tsx
import { useRenderer } from "@opentui/react"

function App() {
  const renderer = useRenderer()

  useEffect(() => {
    renderer.console.show()
    console.log("Hello, from the console!")
  }, [])

  return <box />
}
```

#### `useKeyboard(handler, options?)`

Handle keyboard events.

```tsx
import { useKeyboard } from "@opentui/react"

function App() {
  useKeyboard((key) => {
    if (key.name === "escape") {
      process.exit(0)
    }
  })

  return <text>Press ESC to exit</text>
}
```

**Parameters:**

- `handler`: Callback function that receives a `KeyEvent` object
- `options?`: Optional configuration object:
  - `release?`: Boolean to include key release events (default: `false`)

By default, only receives press events (including key repeats with `repeated: true`). Set `options.release` to `true` to also receive release events.

**Example with release events:**

```tsx
import { useKeyboard } from "@opentui/react"
import { useState } from "react"

function App() {
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set())

  useKeyboard(
    (event) => {
      setPressedKeys((keys) => {
        const newKeys = new Set(keys)
        if (event.eventType === "release") {
          newKeys.delete(event.name)
        } else {
          newKeys.add(event.name)
        }
        return newKeys
      })
    },
    { release: true },
  )

  return (
    <box>
      <text>Currently pressed: {Array.from(pressedKeys).join(", ") || "none"}</text>
    </box>
  )
}
```

#### `usePaste(handler)`

Handle terminal paste events (bracketed paste).

```tsx
import { decodePasteBytes } from "@opentui/core"
import { usePaste } from "@opentui/react"

function App() {
  usePaste((event) => {
    const text = decodePasteBytes(event.bytes)
    console.log("Pasted text:", text)
  })

  return <text>Paste something into the terminal</text>
}
```

**Parameters:**

- `handler`: Callback function that receives a `PasteEvent` object with `bytes: Uint8Array` (decode with `decodePasteBytes` from `@opentui/core`)

#### `useFocus(handler)`

Subscribe to terminal window focus events. Fires when the terminal window gains focus.

```tsx
import { useFocus } from "@opentui/react"

function App() {
  useFocus(() => {
    console.log("Terminal gained focus")
  })

  return <text>Focus-aware component</text>
}
```

**Parameters:**

- `handler`: Callback function invoked when the terminal gains focus

#### `useBlur(handler)`

Subscribe to terminal window blur events. Fires when the terminal window loses focus.

```tsx
import { useBlur } from "@opentui/react"

function App() {
  useBlur(() => {
    console.log("Terminal lost focus")
  })

  return <text>Blur-aware component</text>
}
```

**Parameters:**

- `handler`: Callback function invoked when the terminal loses focus

#### `useSelectionHandler(handler)`

Handle text selection events (e.g., when the user selects text via mouse drag).

```tsx
import { useSelectionHandler } from "@opentui/react"

function App() {
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText()
    console.log("Selected:", text)
  })

  return <text selectable>Select this text with your mouse</text>
}
```

**Parameters:**

- `handler`: Callback function that receives a `Selection` object with methods like `getSelectedText()`

#### `useOnResize(callback)`

Handle terminal resize events.

```tsx
import { useOnResize, useRenderer } from "@opentui/react"
import { useEffect } from "react"

function App() {
  const renderer = useRenderer()

  useEffect(() => {
    renderer.console.show()
  }, [renderer])

  useOnResize((width, height) => {
    console.log(`Terminal resized to ${width}x${height}`)
  })

  return <text>Resize-aware component</text>
}
```

#### `useTerminalDimensions()`

Get current terminal dimensions and automatically update when the terminal is resized.

```tsx
import { useTerminalDimensions } from "@opentui/react"

function App() {
  const { width, height } = useTerminalDimensions()

  return (
    <box>
      <text>
        Terminal dimensions: {width}x{height}
      </text>
      <box style={{ width: Math.floor(width / 2), height: Math.floor(height / 3) }}>
        <text>Half-width, third-height box</text>
      </box>
    </box>
  )
}
```

**Returns:** An object with `width` and `height` properties representing the current terminal dimensions.

#### `useTimeline(options?)`

Create and manage animations using OpenTUI's timeline system. This hook automatically registers and unregisters the timeline with the animation engine.

```tsx
import { useTimeline } from "@opentui/react"
import { useEffect, useState } from "react"

function App() {
  const [width, setWidth] = useState(0)

  const timeline = useTimeline({
    duration: 2000,
    loop: false,
  })

  useEffect(() => {
    timeline.add(
      {
        width,
      },
      {
        width: 50,
        duration: 2000,
        ease: "linear",
        onUpdate: (animation) => {
          setWidth(animation.targets[0].width)
        },
      },
    )
  }, [])

  return <box style={{ width, backgroundColor: "#6a5acd" }} />
}
```

**Parameters:**

- `options?`: Optional `TimelineOptions` object with properties:
  - `duration?`: Animation duration in milliseconds (default: 1000)
  - `loop?`: Whether the timeline should loop (default: false)
  - `autoplay?`: Whether to automatically start the timeline (default: true)
  - `onComplete?`: Callback when timeline completes
  - `onPause?`: Callback when timeline is paused

**Returns:** A `Timeline` instance with methods:

- `add(target, properties, startTime)`: Add animation to timeline
- `play()`: Start the timeline
- `pause()`: Pause the timeline
- `restart()`: Restart the timeline from beginning

## Components

### Layout & Display Components

#### Text Component

Display text with rich formatting.

```tsx
function App() {
  return (
    <box>
      {/* Simple text */}
      <text>Hello World</text>

      {/* Rich text with children */}
      <text>
        <span fg="red">Red Text</span>
      </text>

      {/* Text modifiers */}
      <text>
        <strong>Bold</strong>, <em>Italic</em>, and <u>Underlined</u>
      </text>
    </box>
  )
}
```

#### Box Component

Container with borders and layout capabilities.

```tsx
function App() {
  return (
    <box flexDirection="column">
      {/* Basic box */}
      <box border>
        <text>Simple box</text>
      </box>

      {/* Box with title and styling */}
      <box title="Settings" titleColor="yellow" border borderStyle="double" padding={2} backgroundColor="blue">
        <text>Box content</text>
      </box>

      {/* Styled box */}
      <box
        style={{
          border: true,
          width: 40,
          height: 10,
          margin: 1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <text>Centered content</text>
      </box>
    </box>
  )
}
```

#### Scrollbox Component

A scrollable box.

```tsx
function App() {
  return (
    <scrollbox
      style={{
        rootOptions: {
          backgroundColor: "#24283b",
        },
        wrapperOptions: {
          backgroundColor: "#1f2335",
        },
        viewportOptions: {
          backgroundColor: "#1a1b26",
        },
        contentOptions: {
          backgroundColor: "#16161e",
        },
        scrollbarOptions: {
          showArrows: true,
          trackOptions: {
            foregroundColor: "#7aa2f7",
            backgroundColor: "#414868",
          },
        },
      }}
      focused
    >
      {Array.from({ length: 1000 }).map((_, i) => (
        <box
          key={i}
          style={{ width: "100%", padding: 1, marginBottom: 1, backgroundColor: i % 2 === 0 ? "#292e42" : "#2f3449" }}
        >
          <text content={`Box ${i}`} />
        </box>
      ))}
    </scrollbox>
  )
}
```

#### ASCII Font Component

Display ASCII art text with different font styles.

```tsx
import { useState } from "react"

function App() {
  const text = "ASCII"
  const [font, setFont] = useState<"block" | "shade" | "slick" | "tiny">("tiny")

  return (
    <box style={{ border: true, paddingLeft: 1, paddingRight: 1 }}>
      <box
        style={{
          height: 8,
          border: true,
          marginBottom: 1,
        }}
      >
        <select
          focused
          onChange={(_, option) => setFont(option?.value)}
          showScrollIndicator
          options={[
            {
              name: "Tiny",
              description: "Tiny font",
              value: "tiny",
            },
            {
              name: "Block",
              description: "Block font",
              value: "block",
            },
            {
              name: "Slick",
              description: "Slick font",
              value: "slick",
            },
            {
              name: "Shade",
              description: "Shade font",
              value: "shade",
            },
          ]}
          style={{ flexGrow: 1 }}
        />
      </box>

      <ascii-font text={text} font={font} />
    </box>
  )
}
```

### Input Components

#### Input Component

Text input field with event handling.

```tsx
import { useState } from "react"

function App() {
  const [value, setValue] = useState("")

  return (
    <box title="Enter your name" style={{ border: true, height: 3 }}>
      <input
        placeholder="Type here..."
        focused
        onInput={setValue}
        onSubmit={(value) => console.log("Submitted:", value)}
      />
    </box>
  )
}
```

#### Textarea Component

```tsx
import type { TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useRef } from "react"

function App() {
  const renderer = useRenderer()
  const textareaRef = useRef<TextareaRenderable>(null)

  useEffect(() => {
    renderer.console.show()
  }, [renderer])

  useKeyboard((key) => {
    if (key.name === "return") {
      console.log(textareaRef.current?.plainText)
    }
  })

  return (
    <box title="Interactive Editor" style={{ border: true, flexGrow: 1 }}>
      <textarea ref={textareaRef} placeholder="Type here..." focused />
    </box>
  )
}
```

#### Select Component

Dropdown selection component.

```tsx
import type { SelectOption } from "@opentui/core"
import { useState } from "react"

function App() {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const options: SelectOption[] = [
    { name: "Option 1", description: "Option 1 description", value: "opt1" },
    { name: "Option 2", description: "Option 2 description", value: "opt2" },
    { name: "Option 3", description: "Option 3 description", value: "opt3" },
  ]

  return (
    <box style={{ border: true, height: 24 }}>
      <select
        style={{ height: 22 }}
        options={options}
        focused={true}
        onChange={(index, option) => {
          setSelectedIndex(index)
          console.log("Selected:", option)
        }}
      />
    </box>
  )
}
```

### Code & Diff Components

#### Code Component

```tsx
import { RGBA, SyntaxStyle } from "@opentui/core"

const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { fg: RGBA.fromHex("#ff6b6b"), bold: true }, // red, bold
  string: { fg: RGBA.fromHex("#51cf66") }, // green
  comment: { fg: RGBA.fromHex("#868e96"), italic: true }, // gray, italic
  number: { fg: RGBA.fromHex("#ffd43b") }, // yellow
  default: { fg: RGBA.fromHex("#ffffff") }, // white
})

const codeExample = `function hello() {
  // This is a comment

  const message = "Hello, world!"
  const count = 42

  return message + " " + count
}`

function App() {
  return (
    <box style={{ border: true, flexGrow: 1 }}>
      <code content={codeExample} filetype="javascript" syntaxStyle={syntaxStyle} />
    </box>
  )
}
```

#### Line Number Component

Display code with line numbers, and optionally add diff highlights or diagnostic indicators.

```tsx
import type { LineNumberRenderable } from "@opentui/core"
import { RGBA, SyntaxStyle } from "@opentui/core"
import { useEffect, useRef } from "react"

function App() {
  const lineNumberRef = useRef<LineNumberRenderable>(null)

  const syntaxStyle = SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex("#C792EA") },
    string: { fg: RGBA.fromHex("#C3E88D") },
    number: { fg: RGBA.fromHex("#F78C6C") },
    default: { fg: RGBA.fromHex("#A6ACCD") },
  })

  const codeContent = `function fibonacci(n: number): number {
  if (n <= 1) return n
  return fibonacci(n - 1) + fibonacci(n - 2)
}

console.log(fibonacci(10))`

  useEffect(() => {
    // Add diff highlight - line was added
    lineNumberRef.current?.setLineColor(1, "#1a4d1a")
    lineNumberRef.current?.setLineSign(1, { after: " +", afterColor: "#22c55e" })

    // Add diagnostic indicator
    lineNumberRef.current?.setLineSign(4, { before: "⚠️", beforeColor: "#f59e0b" })
  }, [])

  return (
    <box style={{ border: true, flexGrow: 1 }}>
      <line-number
        ref={lineNumberRef}
        fg="#6b7280"
        bg="#161b22"
        minWidth={3}
        paddingRight={1}
        showLineNumbers={true}
        width="100%"
        height="100%"
      >
        <code content={codeContent} filetype="typescript" syntaxStyle={syntaxStyle} width="100%" height="100%" />
      </line-number>
    </box>
  )
}
```

For a more complete example with interactive diff highlights and diagnostics, see [`examples/line-number.tsx`](examples/line-number.tsx).

#### Diff Component

Display unified or split-view diffs with syntax highlighting, customizable themes, and line number support. Supports multiple view modes (unified/split), word wrapping, and theme customization.

For a complete interactive example with theme switching and keybindings, see [`examples/diff.tsx`](examples/diff.tsx).

## Examples

### Login Form

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useCallback, useState } from "react"

function App() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [focused, setFocused] = useState<"username" | "password">("username")
  const [status, setStatus] = useState("idle")

  useKeyboard((key) => {
    if (key.name === "tab") {
      setFocused((prev) => (prev === "username" ? "password" : "username"))
    }
  })

  const handleSubmit = useCallback(() => {
    if (username === "admin" && password === "secret") {
      setStatus("success")
    } else {
      setStatus("error")
    }
  }, [username, password])

  return (
    <box style={{ border: true, padding: 2, flexDirection: "column", gap: 1 }}>
      <text fg="#FFFF00">Login Form</text>

      <box title="Username" style={{ border: true, width: 40, height: 3 }}>
        <input
          placeholder="Enter username..."
          onInput={setUsername}
          onSubmit={handleSubmit}
          focused={focused === "username"}
        />
      </box>

      <box title="Password" style={{ border: true, width: 40, height: 3 }}>
        <input
          placeholder="Enter password..."
          onInput={setPassword}
          onSubmit={handleSubmit}
          focused={focused === "password"}
        />
      </box>

      <text
        style={{
          fg: status === "success" ? "green" : status === "error" ? "red" : "#999",
        }}
      >
        {status.toUpperCase()}
      </text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

### Counter with Timer

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { useEffect, useState } from "react"

function App() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setCount((prev) => prev + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  return (
    <box title="Counter" style={{ padding: 2 }}>
      <text fg="#00FF00">{`Count: ${count}`}</text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

### System Monitor Animation

```tsx
import { createCliRenderer, TextAttributes } from "@opentui/core"
import { createRoot, useTimeline } from "@opentui/react"
import { useEffect, useState } from "react"

type Stats = {
  cpu: number
  memory: number
  network: number
  disk: number
}

export const App = () => {
  const [stats, setAnimatedStats] = useState<Stats>({
    cpu: 0,
    memory: 0,
    network: 0,
    disk: 0,
  })

  const timeline = useTimeline({
    duration: 3000,
    loop: false,
  })

  useEffect(() => {
    timeline.add(
      stats,
      {
        cpu: 85,
        memory: 70,
        network: 95,
        disk: 60,
        duration: 3000,
        ease: "linear",
        onUpdate: (values) => {
          setAnimatedStats({ ...values.targets[0] })
        },
      },
      0,
    )
  }, [])

  const statsMap = [
    { name: "CPU", key: "cpu", color: "#6a5acd" },
    { name: "Memory", key: "memory", color: "#4682b4" },
    { name: "Network", key: "network", color: "#20b2aa" },
    { name: "Disk", key: "disk", color: "#daa520" },
  ]

  return (
    <box
      title="System Monitor"
      style={{
        margin: 1,
        padding: 1,
        border: true,
        marginLeft: 2,
        marginRight: 2,
        borderStyle: "single",
        borderColor: "#4a4a4a",
      }}
    >
      {statsMap.map((stat) => (
        <box key={stat.key}>
          <box flexDirection="row" justifyContent="space-between">
            <text>{stat.name}</text>
            <text attributes={TextAttributes.DIM}>{Math.round(stats[stat.key as keyof Stats])}%</text>
          </box>
          <box style={{ backgroundColor: "#333333" }}>
            <box style={{ width: `${stats[stat.key as keyof Stats]}%`, height: 1, backgroundColor: stat.color }} />
          </box>
        </box>
      ))}
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

### Styled Text Showcase

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return (
    <>
      <text>Simple text</text>
      <text>
        <strong>Bold text</strong>
      </text>
      <text>
        <u>Underlined text</u>
      </text>
      <text>
        <span fg="red">Red text</span>
      </text>
      <text>
        <span fg="blue">Blue text</span>
      </text>
      <text>
        <strong fg="red">Bold red text</strong>
      </text>
      <text>
        <strong>Bold</strong> and <span fg="blue">blue</span> combined
      </text>
    </>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

## Component Extension

You can create custom components by extending OpenTUIs base renderables:

```tsx
import {
  BoxRenderable,
  createCliRenderer,
  OptimizedBuffer,
  RGBA,
  type BoxOptions,
  type RenderContext,
} from "@opentui/core"
import { createRoot, extend } from "@opentui/react"

// Create custom component class
class ButtonRenderable extends BoxRenderable {
  private _label: string = "Button"

  constructor(ctx: RenderContext, options: BoxOptions & { label?: string }) {
    super(ctx, {
      border: true,
      borderStyle: "single",
      minHeight: 3,
      ...options,
    })

    if (options.label) {
      this._label = options.label
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)

    const centerX = this.x + Math.floor(this.width / 2 - this._label.length / 2)
    const centerY = this.y + Math.floor(this.height / 2)

    buffer.drawText(this._label, centerX, centerY, RGBA.fromInts(255, 255, 255, 255))
  }

  set label(value: string) {
    this._label = value
    this.requestRender()
  }
}

// Add TypeScript support
declare module "@opentui/react" {
  interface OpenTUIComponents {
    consoleButton: typeof ButtonRenderable
  }
}

// Register the component
extend({ consoleButton: ButtonRenderable })

// Use in JSX
function App() {
  return (
    <box>
      <consoleButton label="Click me!" style={{ backgroundColor: "blue" }} />
      <consoleButton label="Another button" style={{ backgroundColor: "green" }} />
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

## Using React DevTools

OpenTUI React supports [React DevTools](https://github.com/facebook/react/tree/master/packages/react-devtools) for debugging your terminal applications. To enable DevTools integration:

1. Install the optional peer dependency:

```bash
bun add --dev react-devtools-core@7
```

2. Start the standalone React DevTools:

```bash
npx react-devtools@7
```

3. Run your app with the `DEV` environment variable:

```bash
DEV=true bun run your-app.ts
```

After the app starts, you should see the component tree in React DevTools. You can inspect and modify props in real-time, and changes will be reflected immediately in your terminal UI.

### Process Exit with DevTools

When DevTools is connected, the WebSocket connection may prevent your process from exiting naturally.
