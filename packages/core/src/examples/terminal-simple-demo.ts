import {
  createCliRenderer,
  StatelessTerminalRenderable,
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
} from "../index"
import { TextRenderable } from "../renderables/Text"
import { setupCommonDemoKeys } from "./lib/standalone-keys"

let renderer: CliRenderer | null = null
let terminalDisplay: StatelessTerminalRenderable | null = null
let scrollBox: ScrollBoxRenderable | null = null
let statusDisplay: TextRenderable | null = null

const SAMPLE_ANSI = `\x1b[1;32muser@hostname\x1b[0m:\x1b[1;34m~/projects/my-app\x1b[0m$ ls -la
total 128
drwxr-xr-x  12 user user  4096 Nov 26 10:30 \x1b[1;34m.\x1b[0m
drwxr-xr-x   5 user user  4096 Nov 25 14:22 \x1b[1;34m..\x1b[0m
-rw-r--r--   1 user user   234 Nov 26 10:30 .gitignore
drwxr-xr-x   8 user user  4096 Nov 26 10:28 \x1b[1;34m.git\x1b[0m
-rw-r--r--   1 user user  1842 Nov 26 09:15 package.json

\x1b[1;32muser@hostname\x1b[0m:\x1b[1;34m~/projects/my-app\x1b[0m$ git status
On branch \x1b[1;36mmain\x1b[0m
Changes to be committed:
	\x1b[32mmodified:   src/index.ts\x1b[0m
	\x1b[32mnew file:   src/utils.ts\x1b[0m

Changes not staged for commit:
	\x1b[31mmodified:   package.json\x1b[0m

\x1b[1;32muser@hostname\x1b[0m:\x1b[1;34m~/projects/my-app\x1b[0m$ npm run build
\x1b[1;33m[WARN]\x1b[0m Deprecation warning: 'fs.exists' is deprecated
\x1b[1;36m[INFO]\x1b[0m Compiling TypeScript files...
\x1b[1;32m[SUCCESS]\x1b[0m Build completed in 2.34s

\x1b[1;32muser@hostname\x1b[0m:\x1b[1;34m~/projects/my-app\x1b[0m$ echo "Style showcase:"
Style showcase:

\x1b[1mBold text\x1b[0m
\x1b[2mFaint/dim text\x1b[0m
\x1b[3mItalic text\x1b[0m
\x1b[4mUnderlined text\x1b[0m
\x1b[7mInverse/reverse text\x1b[0m
\x1b[9mStrikethrough text\x1b[0m

\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m \x1b[33mYellow\x1b[0m \x1b[34mBlue\x1b[0m \x1b[35mMagenta\x1b[0m \x1b[36mCyan\x1b[0m
\x1b[38;5;208mOrange (256 color)\x1b[0m
\x1b[38;2;255;105;180mHot Pink (RGB)\x1b[0m
`

let currentAnsi = SAMPLE_ANSI
let prefixCount = 0

export function run(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#0d1117")

  const container = new BoxRenderable(renderer, {
    id: "container",
    flexDirection: "column",
    flexGrow: 1,
  })
  renderer.root.add(container)

  statusDisplay = new TextRenderable(renderer, {
    id: "status",
    content: "Press 'p' to add prefix | 't' scroll top | 'b' scroll bottom | 'q' to quit",
    height: 1,
    fg: "#8b949e",
    padding: 1,
  })
  container.add(statusDisplay)

  scrollBox = new ScrollBoxRenderable(renderer, {
    id: "scroll-box",
    flexGrow: 1,
    padding: 1,
  })
  container.add(scrollBox)

  terminalDisplay = new StatelessTerminalRenderable(renderer, {
    id: "terminal",
    ansi: currentAnsi,
    cols: 120,
    rows: 100,
    trimEnd: true,
  })
  scrollBox.add(terminalDisplay)

  rendererInstance.keyInput.on("keypress", handleKey)
}

function handleKey(key: KeyEvent): void {
  if (key.name === "q" || key.name === "escape") {
    process.exit(0)
  }

  if (key.name === "p" && terminalDisplay) {
    prefixCount++
    const prefix = `\x1b[1;35m[PREFIX ${prefixCount}]\x1b[0m\n`
    currentAnsi = prefix + currentAnsi
    terminalDisplay.ansi = currentAnsi
    updateStatus()
  }

  if (key.name === "t" && scrollBox) {
    scrollBox.scrollTo(0)
  }

  if (key.name === "b" && scrollBox && terminalDisplay) {
    const lastLine = terminalDisplay.lineCount - 1
    const scrollPos = terminalDisplay.getScrollPositionForLine(lastLine)
    scrollBox.scrollTo(scrollPos)
  }
}

function updateStatus(): void {
  if (statusDisplay && terminalDisplay) {
    statusDisplay.content = `Press 'p' to add prefix | 't' top | 'b' bottom | 'q' quit | Prefixes: ${prefixCount} | Lines: ${terminalDisplay.lineCount}`
  }
}

export function destroy(rendererInstance: CliRenderer): void {
  rendererInstance.keyInput.off("keypress", handleKey)

  if (terminalDisplay) {
    terminalDisplay.destroy()
    terminalDisplay = null
  }

  if (scrollBox) {
    scrollBox.destroy()
    scrollBox = null
  }

  if (statusDisplay) {
    statusDisplay.destroy()
    statusDisplay = null
  }

  rendererInstance.root.remove("container")
  renderer = null
}

if (import.meta.main) {
  const inputFile = process.argv[2]
  if (inputFile) {
    const fs = await import("fs")
    currentAnsi = fs.readFileSync(inputFile, "utf-8")
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
