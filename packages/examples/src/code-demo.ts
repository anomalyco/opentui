import {
  CliRenderer,
  CliRenderEvents,
  createCliRenderer,
  CodeRenderable,
  BoxRenderable,
  TextRenderable,
  type ParsedKey,
  ScrollBoxRenderable,
  LineNumberRenderable,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { parseColor } from "@opentui/core"
import { SyntaxStyle } from "@opentui/core"

// Code examples to cycle through
const examples = [
  {
    name: "TypeScript",
    filetype: "typescript" as const,
    code: `interface User {
  name: string;
  age: number;
  email?: string;
}

class UserManager {
  private users: User[] = [];

  constructor(initialUsers: User[] = []) {
    this.users = initialUsers;
  }

  addUser(user: User): void {
    if (!user.name || user.age < 0) {
      throw new Error("Invalid user data");
    }
    this.users.push(user);
  }

  findUser(name: string): User | undefined {
    return this.users.find(u => u.name === name);
  }

  getUserCount(): number {
    return this.users.length;
  }

  // Get users over a certain age
  getAdults(minAge: number = 18): User[] {
    return this.users.filter(user => user.age >= minAge);
  }
}

// Usage example
const manager = new UserManager();
manager.addUser({ name: "Alice", age: 25, email: "alice@example.com" });
manager.addUser({ name: "Bob", age: 17 });

console.log(\`Total users: \${manager.getUserCount()}\`);
console.log(\`Adults: \${manager.getAdults().length}\`);`,
  },
  {
    name: "JavaScript",
    filetype: "javascript" as const,
    code: `// React Component Example
import React, { useState, useEffect } from 'react';

function TodoApp() {
  const [todos, setTodos] = useState([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    // Load todos from localStorage
    const saved = localStorage.getItem('todos');
    if (saved) {
      setTodos(JSON.parse(saved));
    }
  }, []);

  const addTodo = () => {
    if (input.trim()) {
      const newTodo = {
        id: Date.now(),
        text: input,
        completed: false
      };
      setTodos([...todos, newTodo]);
      setInput('');
    }
  };

  const toggleTodo = (id) => {
    setTodos(todos.map(todo =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    ));
  };

  return (
    <div className="todo-app">
      <h1>My Todo List</h1>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyPress={(e) => e.key === 'Enter' && addTodo()}
      />
      <button onClick={addTodo}>Add</button>
      <ul>
        {todos.map(todo => (
          <li key={todo.id} onClick={() => toggleTodo(todo.id)}>
            {todo.completed ? '✓' : '○'} {todo.text}
          </li>
        ))}
      </ul>
    </div>
  );
}`,
  },
  {
    name: "Markdown",
    filetype: "markdown" as const,
    code: `# OpenTUI Documentation

## Getting Started

OpenTUI is a modern terminal UI framework built on **tree-sitter** and WebGPU.

### Features

- 🚀 Fast rendering with WebGPU
- 🎨 Syntax highlighting via tree-sitter
- 📦 Component-based architecture
- ⌨️ Rich keyboard input handling

### Installation

\`\`\`bash
bun install opentui
\`\`\`

### Quick Example

\`\`\`typescript
import { createCliRenderer, BoxRenderable } from 'opentui';

const renderer = await createCliRenderer();
const box = new BoxRenderable(renderer, {
  border: true,
  title: "Hello World"
});
renderer.root.add(box);
\`\`\`

## API Reference

### CodeRenderable

The \`CodeRenderable\` component provides syntax highlighting:

| Property | Type | Description |
|----------|------|-------------|
| content | string | Code to display |
| filetype | string | Language type |
| syntaxStyle | SyntaxStyle | Styling rules |

> **Note**: Tree-sitter parsers are loaded lazily for performance.

CJK: 알겠습니다. Task 에이전트에 ktlint + detekt 검사를 위임하겠습니다.

---

For more info, visit [github.com/opentui](https://github.com)`,
  },
  {
    name: "Zig",
    filetype: "zig" as const,
    code: `const std = @import("std");
const Allocator = std.mem.Allocator;

/// A simple text buffer implementation
pub const TextBuffer = struct {
    allocator: Allocator,
    lines: std.ArrayList([]u8),
    dirty: bool,

    pub fn init(allocator: Allocator) !TextBuffer {
        return TextBuffer{
            .allocator = allocator,
            .lines = std.ArrayList([]u8).init(allocator),
            .dirty = false,
        };
    }

    pub fn deinit(self: *TextBuffer) void {
        for (self.lines.items) |line| {
            self.allocator.free(line);
        }
        self.lines.deinit();
    }

    /// Insert a line at the specified position
    pub fn insertLine(self: *TextBuffer, line_num: usize, content: []const u8) !void {
        const line = try self.allocator.dupe(u8, content);
        errdefer self.allocator.free(line);

        try self.lines.insert(line_num, line);
        self.dirty = true;
    }

    /// Get the content of a line
    pub fn getLine(self: *const TextBuffer, line_num: usize) ?[]const u8 {
        if (line_num >= self.lines.items.len) return null;
        return self.lines.items[line_num];
    }

    /// Count total characters in buffer
    pub fn countChars(self: *const TextBuffer) usize {
        var total: usize = 0;
        for (self.lines.items) |line| {
            total += line.len;
        }
        return total;
    }
};

test "TextBuffer basic operations" {
    const allocator = std.testing.allocator;
    var buffer = try TextBuffer.init(allocator);
    defer buffer.deinit();

    try buffer.insertLine(0, "Hello, World!");
    try buffer.insertLine(1, "This is Zig.");

    try std.testing.expectEqual(@as(usize, 2), buffer.lines.items.len);
    try std.testing.expect(buffer.dirty);
    
    const first_line = buffer.getLine(0).?;
    try std.testing.expectEqualStrings("Hello, World!", first_line);
}`,
  },
]

interface SyntaxPalette {
  keyword: string
  keywordCoroutine: string
  operatorKeyword: string
  string: string
  comment: string
  number: string
  function: string
  constructor: string
  type: string
  operator: string
  variable: string
  property: string
  bracket: string
  delimiter: string
  heading1: string
  heading2: string
  heading3: string
  heading4: string
  heading5: string
  heading6: string
  list: string
  quote: string
  raw: string
  rawBg: string
  link: string
  label: string
  conceal: string
  default: string
}

interface CodeDemoTheme {
  name: string
  backgroundColor: string
  panelBackgroundColor: string
  titleBorderColor: string
  codeBorderColor: string
  instructionsColor: string
  helpTextColor: string
  timingColor: string
  lineNumberFg: string
  lineNumberBg: string
  selectionBg: string
  selectionFg: string
  syntaxOverrides?: Partial<SyntaxPalette>
}

const BASE_SYNTAX_PALETTE: SyntaxPalette = {
  keyword: "#FF7B72",
  keywordCoroutine: "#FF9492",
  operatorKeyword: "#FF7B72",
  string: "#A5D6FF",
  comment: "#8B949E",
  number: "#79C0FF",
  function: "#D2A8FF",
  constructor: "#FFA657",
  type: "#FFA657",
  operator: "#FF7B72",
  variable: "#E6EDF3",
  property: "#79C0FF",
  bracket: "#F0F6FC",
  delimiter: "#C9D1D9",
  heading1: "#00FF88",
  heading2: "#00D7FF",
  heading3: "#FF69B4",
  heading4: "#FFA657",
  heading5: "#FF7B72",
  heading6: "#8B949E",
  list: "#FF7B72",
  quote: "#8B949E",
  raw: "#A5D6FF",
  rawBg: "#161B22",
  link: "#58A6FF",
  label: "#7EE787",
  conceal: "#6E7681",
  default: "#E6EDF3",
}

const themes: CodeDemoTheme[] = [
  {
    name: "GitHub Dark",
    backgroundColor: "#0D1117",
    panelBackgroundColor: "#0D1117",
    titleBorderColor: "#4ECDC4",
    codeBorderColor: "#6BCF7F",
    instructionsColor: "#888888",
    helpTextColor: "#E6EDF3",
    timingColor: "#A5D6FF",
    lineNumberFg: "#6b7280",
    lineNumberBg: "#161b22",
    selectionBg: "#264F78",
    selectionFg: "#FFFFFF",
  },
  {
    name: "Monokai",
    backgroundColor: "#272822",
    panelBackgroundColor: "#272822",
    titleBorderColor: "#FD971F",
    codeBorderColor: "#A6E22E",
    instructionsColor: "#75715E",
    helpTextColor: "#F8F8F2",
    timingColor: "#66D9EF",
    lineNumberFg: "#75715E",
    lineNumberBg: "#1E1F1C",
    selectionBg: "#49483E",
    selectionFg: "#F8F8F2",
    syntaxOverrides: {
      keyword: "#F92672",
      keywordCoroutine: "#F92672",
      operatorKeyword: "#F92672",
      string: "#E6DB74",
      comment: "#75715E",
      number: "#AE81FF",
      function: "#A6E22E",
      constructor: "#FD971F",
      type: "#66D9EF",
      operator: "#F92672",
      variable: "#F8F8F2",
      property: "#66D9EF",
      bracket: "#F8F8F2",
      delimiter: "#F8F8F2",
      heading1: "#A6E22E",
      heading2: "#66D9EF",
      heading3: "#FD971F",
      heading4: "#E6DB74",
      heading5: "#F92672",
      heading6: "#AE81FF",
      list: "#FD971F",
      quote: "#75715E",
      raw: "#E6DB74",
      rawBg: "#1E1F1C",
      link: "#66D9EF",
      label: "#A6E22E",
      conceal: "#75715E",
      default: "#F8F8F2",
    },
  },
  {
    name: "Dracula",
    backgroundColor: "#282A36",
    panelBackgroundColor: "#282A36",
    titleBorderColor: "#BD93F9",
    codeBorderColor: "#50FA7B",
    instructionsColor: "#6272A4",
    helpTextColor: "#F8F8F2",
    timingColor: "#8BE9FD",
    lineNumberFg: "#6272A4",
    lineNumberBg: "#21222C",
    selectionBg: "#44475A",
    selectionFg: "#F8F8F2",
    syntaxOverrides: {
      keyword: "#FF79C6",
      keywordCoroutine: "#FF79C6",
      operatorKeyword: "#FF79C6",
      string: "#F1FA8C",
      comment: "#6272A4",
      number: "#BD93F9",
      function: "#50FA7B",
      constructor: "#FFB86C",
      type: "#8BE9FD",
      operator: "#FF79C6",
      variable: "#F8F8F2",
      property: "#8BE9FD",
      bracket: "#F8F8F2",
      delimiter: "#F8F8F2",
      heading1: "#50FA7B",
      heading2: "#8BE9FD",
      heading3: "#FF79C6",
      heading4: "#FFB86C",
      heading5: "#BD93F9",
      heading6: "#6272A4",
      list: "#FF79C6",
      quote: "#6272A4",
      raw: "#F1FA8C",
      rawBg: "#21222C",
      link: "#8BE9FD",
      label: "#50FA7B",
      conceal: "#6272A4",
      default: "#F8F8F2",
    },
  },
  {
    name: "Solarized Dark",
    backgroundColor: "#002b36",
    panelBackgroundColor: "#002b36",
    titleBorderColor: "#2aa198",
    codeBorderColor: "#859900",
    instructionsColor: "#586e75",
    helpTextColor: "#93a1a1",
    timingColor: "#2aa198",
    lineNumberFg: "#586e75",
    lineNumberBg: "#073642",
    selectionBg: "#073642",
    selectionFg: "#93a1a1",
    syntaxOverrides: {
      keyword: "#859900",
      keywordCoroutine: "#859900",
      operatorKeyword: "#859900",
      string: "#2aa198",
      comment: "#586e75",
      number: "#d33682",
      function: "#268bd2",
      constructor: "#cb4b16",
      type: "#cb4b16",
      operator: "#859900",
      variable: "#839496",
      property: "#268bd2",
      bracket: "#839496",
      delimiter: "#839496",
      heading1: "#859900",
      heading2: "#2aa198",
      heading3: "#268bd2",
      heading4: "#b58900",
      heading5: "#cb4b16",
      heading6: "#586e75",
      list: "#cb4b16",
      quote: "#586e75",
      raw: "#2aa198",
      rawBg: "#073642",
      link: "#268bd2",
      label: "#859900",
      conceal: "#586e75",
      default: "#839496",
    },
  },
  {
    name: "One Dark",
    backgroundColor: "#282c34",
    panelBackgroundColor: "#282c34",
    titleBorderColor: "#61afef",
    codeBorderColor: "#98c379",
    instructionsColor: "#5c6370",
    helpTextColor: "#abb2bf",
    timingColor: "#61afef",
    lineNumberFg: "#636d83",
    lineNumberBg: "#21252b",
    selectionBg: "#3E4451",
    selectionFg: "#abb2bf",
    syntaxOverrides: {
      keyword: "#c678dd",
      keywordCoroutine: "#c678dd",
      operatorKeyword: "#c678dd",
      string: "#98c379",
      comment: "#5c6370",
      number: "#d19a66",
      function: "#61afef",
      constructor: "#e5c07b",
      type: "#e5c07b",
      operator: "#56b6c2",
      variable: "#abb2bf",
      property: "#e06c75",
      bracket: "#abb2bf",
      delimiter: "#abb2bf",
      heading1: "#98c379",
      heading2: "#61afef",
      heading3: "#c678dd",
      heading4: "#e5c07b",
      heading5: "#e06c75",
      heading6: "#5c6370",
      list: "#e06c75",
      quote: "#5c6370",
      raw: "#98c379",
      rawBg: "#21252b",
      link: "#61afef",
      label: "#98c379",
      conceal: "#5c6370",
      default: "#abb2bf",
    },
  },
]

function createSyntaxStyle(theme: CodeDemoTheme, renderer: CliRenderer): SyntaxStyle {
  const palette = {
    ...BASE_SYNTAX_PALETTE,
    ...theme.syntaxOverrides,
  }

  return SyntaxStyle.fromStyles(
    {
      keyword: { fg: parseColor(palette.keyword), bold: true },
      "keyword.import": { fg: parseColor(palette.keyword), bold: true },
      "keyword.coroutine": { fg: parseColor(palette.keywordCoroutine) },
      "keyword.operator": { fg: parseColor(palette.operatorKeyword) },
      string: { fg: parseColor(palette.string) },
      comment: { fg: parseColor(palette.comment), italic: true },
      number: { fg: parseColor(palette.number) },
      boolean: { fg: parseColor(palette.number) },
      constant: { fg: parseColor(palette.number) },
      function: { fg: parseColor(palette.function) },
      "function.call": { fg: parseColor(palette.function) },
      "function.method.call": { fg: parseColor(palette.function) },
      constructor: { fg: parseColor(palette.constructor) },
      type: { fg: parseColor(palette.type) },
      operator: { fg: parseColor(palette.operator) },
      variable: { fg: parseColor(palette.variable) },
      "variable.member": { fg: parseColor(palette.property) },
      property: { fg: parseColor(palette.property) },
      bracket: { fg: parseColor(palette.bracket) },
      "punctuation.bracket": { fg: parseColor(palette.bracket) },
      "punctuation.delimiter": { fg: parseColor(palette.delimiter) },
      punctuation: { fg: parseColor(palette.bracket) },

      "markup.heading": { fg: parseColor(palette.heading2), bold: true },
      "markup.heading.1": { fg: parseColor(palette.heading1), bold: true, underline: true },
      "markup.heading.2": { fg: parseColor(palette.heading2), bold: true },
      "markup.heading.3": { fg: parseColor(palette.heading3) },
      "markup.heading.4": { fg: parseColor(palette.heading4), bold: true },
      "markup.heading.5": { fg: parseColor(palette.heading5), bold: true },
      "markup.heading.6": { fg: parseColor(palette.heading6), bold: true },
      "markup.bold": { fg: parseColor(palette.default), bold: true },
      "markup.strong": { fg: parseColor(palette.default), bold: true },
      "markup.italic": { fg: parseColor(palette.default), italic: true },
      "markup.list": { fg: parseColor(palette.list) },
      "markup.quote": { fg: parseColor(palette.quote), italic: true },
      "markup.raw": { fg: parseColor(palette.raw), bg: parseColor(palette.rawBg) },
      "markup.raw.block": { fg: parseColor(palette.raw), bg: parseColor(palette.rawBg) },
      "markup.raw.inline": { fg: parseColor(palette.raw), bg: parseColor(palette.rawBg) },
      "markup.link": { fg: parseColor(palette.link), underline: true },
      "markup.link.label": { fg: parseColor(palette.link), underline: true },
      "markup.link.url": { fg: parseColor(palette.link), underline: true },
      label: { fg: parseColor(palette.label) },
      spell: { fg: parseColor(palette.default) },
      nospell: { fg: parseColor(palette.default) },
      conceal: { fg: parseColor(palette.conceal) },
      "punctuation.special": { fg: parseColor(palette.quote) },

      default: { fg: parseColor(palette.default) },
    },
    renderer.nativeScene!,
  )
}

let renderer: CliRenderer | null = null
let keyboardHandler: ((key: ParsedKey) => void) | null = null
let destroyHandler: (() => void) | null = null
let parentContainer: BoxRenderable | null = null
let codeScrollBox: ScrollBoxRenderable | null = null
let codeDisplay: CodeRenderable | null = null
let codeWithLineNumbers: LineNumberRenderable | null = null
let timingText: TextRenderable | null = null
let syntaxStyle: SyntaxStyle | null = null
let helpModal: BoxRenderable | null = null

export async function run(rendererInstance: CliRenderer): Promise<void> {
  let currentExampleIndex = 0
  let currentThemeIndex = 0
  let concealEnabled = true
  let highlightsEnabled = false
  let diagnosticsEnabled = false
  let showingHelp = false
  renderer = rendererInstance
  destroyHandler = () => destroy(rendererInstance)
  rendererInstance.once(CliRenderEvents.DESTROY, destroyHandler)
  renderer.start()
  const getCurrentTheme = () => themes[currentThemeIndex]
  renderer.setBackgroundColor(getCurrentTheme().backgroundColor)

  parentContainer = new BoxRenderable(renderer, {
    id: "parent-container",
    zIndex: 10,
    padding: 1,
  })
  renderer.root.add(parentContainer)

  const titleBox = new BoxRenderable(renderer, {
    id: "title-box",
    height: 3,
    borderStyle: "double",
    borderColor: getCurrentTheme().titleBorderColor,
    backgroundColor: getCurrentTheme().panelBackgroundColor,
    title: `Code Demo - ${getCurrentTheme().name}`,
    titleAlignment: "center",
    border: true,
  })
  parentContainer.add(titleBox)

  const instructionsText = new TextRenderable(renderer, {
    id: "instructions",
    content: "ESC to return | Press ? for keybindings",
    fg: getCurrentTheme().instructionsColor,
  })
  titleBox.add(instructionsText)

  // Create help modal (hidden by default)
  helpModal = new BoxRenderable(renderer, {
    id: "help-modal",
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 60,
    height: 18,
    marginLeft: -30, // Center horizontally
    marginTop: -9, // Center vertically
    border: true,
    borderStyle: "double",
    borderColor: getCurrentTheme().titleBorderColor,
    backgroundColor: getCurrentTheme().panelBackgroundColor,
    title: "Keybindings",
    titleAlignment: "center",
    padding: 2,
    zIndex: 100,
    visible: false,
  })

  const helpContent = new TextRenderable(renderer, {
    id: "help-content",
    content: `Navigation:
  ← → : Switch between code examples

View Controls:
  L : Toggle line numbers
  C : Toggle concealment (Markdown links, etc.)
  T : Cycle themes

Diff Highlighting:
  H : Toggle diff highlights (+ green, - red)

Diagnostics:
  D : Toggle diagnostic signs (❌ ⚠️  💡)

Other:
  ? : Toggle this help screen
  ESC : Return to main menu`,
    fg: getCurrentTheme().helpTextColor,
  })

  helpModal.add(helpContent)
  renderer.root.add(helpModal)

  codeScrollBox = new ScrollBoxRenderable(renderer, {
    id: "code-scroll-box",
    borderStyle: "single",
    borderColor: getCurrentTheme().codeBorderColor,
    backgroundColor: getCurrentTheme().panelBackgroundColor,
    title: `${examples[currentExampleIndex].name} (CodeRenderable) - ${getCurrentTheme().name}`,
    titleAlignment: "left",
    border: true,
    scrollY: true,
    scrollX: false,
    flexGrow: 1,
    flexShrink: 1,
  })
  parentContainer.add(codeScrollBox)

  syntaxStyle = createSyntaxStyle(getCurrentTheme(), renderer)

  // Create code display using CodeRenderable wrapped in LineNumberRenderable
  codeDisplay = new CodeRenderable(renderer, {
    id: "code-display",
    content: examples[currentExampleIndex].code,
    filetype: examples[currentExampleIndex].filetype,
    syntaxStyle,
    selectable: true,
    selectionBg: getCurrentTheme().selectionBg,
    selectionFg: getCurrentTheme().selectionFg,
    conceal: concealEnabled,
    width: "100%",
  })

  codeWithLineNumbers = new LineNumberRenderable(renderer, {
    id: "code-with-lines",
    target: codeDisplay,
    minWidth: 3,
    paddingRight: 1,
    fg: getCurrentTheme().lineNumberFg,
    bg: getCurrentTheme().lineNumberBg,
    width: "100%",
  })

  codeScrollBox.add(codeWithLineNumbers)

  timingText = new TextRenderable(renderer, {
    id: "timing-display",
    content: "Initializing...",
    fg: getCurrentTheme().timingColor,
    wrapMode: "word",
    flexShrink: 0,
  })
  parentContainer.add(timingText)

  const updateCodeTitle = () => {
    const example = examples[currentExampleIndex]
    const theme = getCurrentTheme()
    if (codeScrollBox) {
      codeScrollBox.title = `${example.name} (CodeRenderable) - ${theme.name}`
    }
  }

  const updateTimingText = () => {
    if (timingText) {
      const theme = getCurrentTheme()
      const lineNums = codeWithLineNumbers?.showLineNumbers ? "ON" : "OFF"
      const diff = highlightsEnabled ? "ON" : "OFF"
      const diag = diagnosticsEnabled ? "ON" : "OFF"
      timingText.content = `${examples[currentExampleIndex].name} (${currentExampleIndex + 1}/${examples.length}) | Theme: ${theme.name} (${currentThemeIndex + 1}/${themes.length}) | Conceal: ${concealEnabled ? "ON" : "OFF"} | Lines: ${lineNums} | Diff: ${diff} | Diag: ${diag}`
    }
  }

  const applyTheme = () => {
    const theme = getCurrentTheme()
    renderer?.setBackgroundColor(theme.backgroundColor)

    titleBox.title = `Code Demo - ${theme.name}`
    titleBox.borderColor = theme.titleBorderColor
    titleBox.backgroundColor = theme.panelBackgroundColor
    instructionsText.fg = theme.instructionsColor

    if (helpModal) {
      helpModal.borderColor = theme.titleBorderColor
      helpModal.backgroundColor = theme.panelBackgroundColor
    }
    helpContent.fg = theme.helpTextColor

    if (codeScrollBox) {
      codeScrollBox.borderColor = theme.codeBorderColor
      codeScrollBox.backgroundColor = theme.panelBackgroundColor
    }

    updateCodeTitle()

    if (timingText) {
      timingText.fg = theme.timingColor
    }

    if (codeWithLineNumbers) {
      codeWithLineNumbers.fg = theme.lineNumberFg
      codeWithLineNumbers.bg = theme.lineNumberBg
    }

    if (codeDisplay) {
      codeDisplay.selectionBg = theme.selectionBg
      codeDisplay.selectionFg = theme.selectionFg
    }

    const previousSyntaxStyle = syntaxStyle
    const nextSyntaxStyle = createSyntaxStyle(theme, rendererInstance)
    syntaxStyle = nextSyntaxStyle
    if (codeDisplay) {
      codeDisplay.syntaxStyle = nextSyntaxStyle
    }
    previousSyntaxStyle?.destroy()

    updateTimingText()
  }

  updateCodeTitle()
  updateTimingText()

  keyboardHandler = (key: ParsedKey) => {
    // Handle help modal toggle
    if (key.raw === "?" && helpModal) {
      showingHelp = !showingHelp
      helpModal.visible = showingHelp
      return
    }

    // Don't process other keys when help is showing
    if (showingHelp) return

    if (key.name === "right" || key.name === "left") {
      // Navigate between examples
      if (key.name === "right") {
        currentExampleIndex = (currentExampleIndex + 1) % examples.length
      } else {
        currentExampleIndex = (currentExampleIndex - 1 + examples.length) % examples.length
      }

      updateCodeTitle()

      if (codeDisplay) {
        const example = examples[currentExampleIndex]
        codeDisplay.content = example.code
        codeDisplay.filetype = example.filetype
        updateTimingText()
      }
    } else if (key.name === "c" && !key.ctrl && !key.meta) {
      // Toggle conceal
      concealEnabled = !concealEnabled
      if (codeDisplay) {
        codeDisplay.conceal = concealEnabled
      }
      updateTimingText()
    } else if (key.name === "l" && !key.ctrl && !key.meta) {
      // Toggle line numbers
      if (codeWithLineNumbers) {
        codeWithLineNumbers.showLineNumbers = !codeWithLineNumbers.showLineNumbers
      }
      updateTimingText()
    } else if (key.name === "t" && !key.ctrl && !key.meta) {
      currentThemeIndex = (currentThemeIndex + 1) % themes.length
      applyTheme()
    } else if (key.name === "h" && !key.ctrl && !key.meta) {
      // Toggle diff highlights
      if (codeWithLineNumbers && codeDisplay) {
        highlightsEnabled = !highlightsEnabled
        if (highlightsEnabled) {
          // Add diff-style highlights for demonstration
          const lineCount = codeDisplay.virtualLineCount
          for (let i = 0; i < lineCount; i += 7) {
            if (i % 14 === 0) {
              codeWithLineNumbers.setLineColor(i, "#1a4d1a")
              codeWithLineNumbers.setLineSign(i, { after: " +", afterColor: "#22c55e" })
            } else {
              codeWithLineNumbers.setLineColor(i, "#4d1a1a")
              codeWithLineNumbers.setLineSign(i, { after: " -", afterColor: "#ef4444" })
            }
          }
        } else {
          codeWithLineNumbers.clearAllLineColors()
          // Clear only after signs
          const currentSigns = codeWithLineNumbers.getLineSigns()
          for (const [line, sign] of currentSigns) {
            if (sign.after) {
              if (sign.before) {
                codeWithLineNumbers.setLineSign(line, { before: sign.before, beforeColor: sign.beforeColor })
              } else {
                codeWithLineNumbers.clearLineSign(line)
              }
            }
          }
        }
      }
      updateTimingText()
    } else if (key.name === "d" && !key.ctrl && !key.meta) {
      // Toggle diagnostics
      if (codeWithLineNumbers && codeDisplay) {
        diagnosticsEnabled = !diagnosticsEnabled
        if (diagnosticsEnabled) {
          // Add diagnostic signs for demonstration
          const lineCount = codeDisplay.virtualLineCount
          for (let i = 0; i < lineCount; i += 9) {
            if (i % 27 === 0) {
              codeWithLineNumbers.setLineSign(i, { before: "❌", beforeColor: "#ef4444" })
            } else if (i % 18 === 0) {
              codeWithLineNumbers.setLineSign(i, { before: "⚠️", beforeColor: "#f59e0b" })
            } else {
              codeWithLineNumbers.setLineSign(i, { before: "💡", beforeColor: "#3b82f6" })
            }
          }
        } else {
          // Clear only before signs
          const currentSigns = codeWithLineNumbers.getLineSigns()
          for (const [line, sign] of currentSigns) {
            if (sign.before) {
              if (sign.after) {
                codeWithLineNumbers.setLineSign(line, { after: sign.after, afterColor: sign.afterColor })
              } else {
                codeWithLineNumbers.clearLineSign(line)
              }
            }
          }
        }
      }
      updateTimingText()
    }
  }

  rendererInstance.keyInput.on("keypress", keyboardHandler)
}

export function destroy(rendererInstance: CliRenderer): void {
  if (renderer !== rendererInstance) return
  if (destroyHandler) {
    rendererInstance.off(CliRenderEvents.DESTROY, destroyHandler)
    destroyHandler = null
  }
  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  parentContainer?.destroyRecursively()
  helpModal?.destroyRecursively()
  syntaxStyle?.destroy()
  parentContainer = null
  codeScrollBox = null
  codeDisplay = null
  codeWithLineNumbers = null
  timingText = null
  syntaxStyle = null
  helpModal = null

  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
