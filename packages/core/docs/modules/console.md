# Console Module

The console module provides a terminal-based console window for debugging and logging, with output capture, filtering, and visual inspection capabilities.

## Overview

The console module intercepts standard console output and displays it in a customizable terminal panel. It includes caller information tracking, log level filtering, and automatic scrolling.

## Core Components

### Console Capture

Automatic capture of console output:

```typescript
import { capture } from '@opentui/core/console'

// Console output is automatically captured
console.log('This is captured')
console.error('Errors too')

// Access captured output
const stdout = capture.getStdout()
const stderr = capture.getStderr()

// Clear capture buffers
capture.clear()
```

### Terminal Console

Visual console window in the terminal:

```typescript
import { TerminalConsole, ConsolePosition } from '@opentui/core'

const terminalConsole = new TerminalConsole(renderer, {
  position: ConsolePosition.BOTTOM,
  sizePercent: 30,
  zIndex: Infinity,
  backgroundColor: '#1a1a1a',
  startInDebugMode: false
})

// Show/hide console
terminalConsole.show()
terminalConsole.hide()
terminalConsole.toggle()
```

## Configuration

### Console Options

```typescript
interface ConsoleOptions {
  position?: ConsolePosition        // TOP, BOTTOM, LEFT, RIGHT
  sizePercent?: number              // Size as percentage of screen (default: 30)
  zIndex?: number                   // Layer order (default: Infinity)
  
  // Colors for log levels
  colorInfo?: ColorInput            // Cyan default
  colorWarn?: ColorInput            // Yellow default
  colorError?: ColorInput           // Red default
  colorDebug?: ColorInput           // Gray default
  colorDefault?: ColorInput         // White default
  
  backgroundColor?: ColorInput      // Panel background
  titleBarColor?: ColorInput        // Title bar color
  titleBarTextColor?: ColorInput    // Title text color
  cursorColor?: ColorInput          // Cursor/selection color
  
  title?: string                    // Console title (default: "Console")
  startInDebugMode?: boolean        // Enable debug info on start
  maxStoredLogs?: number            // Max logs to keep (default: 2000)
  maxDisplayLines?: number          // Max lines to display (default: 3000)
}
```

### Default Configuration

```typescript
const DEFAULT_CONSOLE_OPTIONS = {
  position: ConsolePosition.BOTTOM,
  sizePercent: 30,
  zIndex: Infinity,
  colorInfo: "#00FFFF",     // Cyan
  colorWarn: "#FFFF00",     // Yellow
  colorError: "#FF0000",    // Red
  colorDebug: "#808080",    // Gray
  colorDefault: "#FFFFFF",  // White
  backgroundColor: RGBA.fromValues(0.1, 0.1, 0.1, 0.7),
  title: "Console",
  titleBarColor: RGBA.fromValues(0.05, 0.05, 0.05, 0.7),
  titleBarTextColor: "#FFFFFF",
  cursorColor: "#00A0FF",
  maxStoredLogs: 2000,
  maxDisplayLines: 3000
}
```

## Console Cache

### Log Entry Management

The console cache stores all console output:

```typescript
// Internal cache management
class TerminalConsoleCache extends EventEmitter {
  private _cachedLogs: [Date, LogLevel, any[], CallerInfo | null][]
  private readonly MAX_CACHE_SIZE = 1000
  
  // Enable/disable caching
  setCachingEnabled(enabled: boolean): void
  
  // Clear all cached logs
  clearConsole(): void
  
  // Enable caller info collection (debug mode)
  setCollectCallerInfo(enabled: boolean): void
}
```

### Caller Information

Debug mode captures detailed caller information:

```typescript
interface CallerInfo {
  functionName: string    // Function that called console
  fullPath: string       // Full file path
  fileName: string       // Just the filename
  lineNumber: number     // Line number in file
  columnNumber: number   // Column number
}

// Enable debug mode to collect caller info
terminalConsole.setDebugMode(true)
```

## Display Management

### Scrolling

Console supports smooth scrolling:

```typescript
// Scroll controls
terminalConsole.scrollUp(lines?: number)    // Default: 1 line
terminalConsole.scrollDown(lines?: number)
terminalConsole.scrollToTop()
terminalConsole.scrollToBottom()
terminalConsole.pageUp()    // Scroll by visible height
terminalConsole.pageDown()

// Auto-scroll to bottom on new logs
terminalConsole.setAutoScroll(true)
```

### Filtering

Filter logs by level:

```typescript
// Show only specific log levels
terminalConsole.setLogLevelFilter([
  LogLevel.ERROR,
  LogLevel.WARN
])

// Or use convenience methods
terminalConsole.showOnlyErrors()
terminalConsole.showAll()
```

### Search

Search through console output:

```typescript
// Search for text
terminalConsole.search('error')
terminalConsole.searchNext()
terminalConsole.searchPrevious()
terminalConsole.clearSearch()
```

## Keyboard Shortcuts

Built-in keyboard navigation:

```
Escape     - Close console
Tab        - Toggle focus
D          - Toggle debug mode
C          - Clear console
↑/↓        - Scroll up/down
Page Up/Dn - Page scroll
Home/End   - Jump to top/bottom
/          - Start search
n/N        - Next/previous search result
```

## Rendering

### Frame Buffer

Console uses optimized rendering:

```typescript
// Console maintains its own frame buffer
private frameBuffer: OptimizedBuffer | null
private _needsFrameBufferUpdate: boolean

// Mark for re-render
private markNeedsUpdate(): void {
  this._needsFrameBufferUpdate = true
  this.renderer.needsUpdate()
}
```

### Display Lines

Log entries are formatted for display:

```typescript
interface DisplayLine {
  text: string      // Formatted text
  level: LogLevel   // Log level for coloring
  indent: boolean   // Whether to indent (for multi-line)
}
```

## Output Capture

### Captured Streams

Intercept stdout/stderr:

```typescript
// Automatic stream capture
const mockStdout = new CapturedWritableStream("stdout", capture)
const mockStderr = new CapturedWritableStream("stderr", capture)

// Global console replacement
global.console = new console.Console({
  stdout: mockStdout,
  stderr: mockStderr,
  colorMode: true,
  inspectOptions: {
    compact: false,
    breakLength: 80,
    depth: 2
  }
})
```

### Environment Variables

Control console behavior:

```bash
# Skip console capture
SKIP_CONSOLE_CACHE=true

# Auto-show console on start
SHOW_CONSOLE=true
```

## Integration

### With Renderer

```typescript
class MyApp {
  private renderer: CliRenderer
  private console: TerminalConsole
  
  constructor() {
    this.renderer = new CliRenderer()
    this.console = new TerminalConsole(this.renderer, {
      position: ConsolePosition.BOTTOM,
      sizePercent: 25
    })
    
    // Console renders automatically when visible
    this.console.show()
  }
  
  handleError(error: Error) {
    console.error('Application error:', error)
    this.console.show() // Show console on error
  }
}
```

### With Logging

```typescript
// Custom log formatting
terminalConsole.on('entry', (entry) => {
  const [date, level, args, caller] = entry
  
  // Save to file
  fs.appendFileSync('app.log', 
    `${date.toISOString()} [${level}] ${args.join(' ')}\n`
  )
})
```

## Advanced Features

### Debug Mode

Enhanced debugging information:

```typescript
// Toggle debug mode
terminalConsole.toggleDebugMode()

// When enabled, shows:
// - Function names
// - File paths
// - Line/column numbers
// - Stack traces for errors
```

### Export Logs

Export console content:

```typescript
// Get all logs
const logs = terminalConsole.exportLogs()

// Get filtered logs
const errors = terminalConsole.exportLogs({
  levels: [LogLevel.ERROR],
  limit: 100
})

// Save to file
terminalConsole.saveLogsToFile('debug.log')
```

## API Reference

### Classes

- `TerminalConsole` - Main console window class
- `TerminalConsoleCache` - Console output cache
- `Capture` - Output capture manager
- `CapturedWritableStream` - Stream interceptor

### Enums

- `LogLevel` - LOG, INFO, WARN, ERROR, DEBUG
- `ConsolePosition` - TOP, BOTTOM, LEFT, RIGHT

### Functions

- `getCallerInfo(): CallerInfo | null` - Extract caller information

### Exports

- `capture` - Global capture instance
- `terminalConsoleCache` - Global cache instance

## Related Modules

- [Rendering](./rendering.md) - Console rendering integration
- [Buffer](./buffer.md) - Frame buffer management
- [Lib](./lib.md) - Color parsing and utilities