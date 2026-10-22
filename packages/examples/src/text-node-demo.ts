#!/usr/bin/env bun

import {
  CliRenderer,
  CliRenderEvents,
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  t,
  bold,
  underline,
  green,
  yellow,
  cyan,
  type KeyEvent,
} from "@opentui/core"
import { TextNodeRenderable } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let mainContainer: BoxRenderable | null = null
let demoText: TextRenderable | null = null
let instructionsText: TextRenderable | null = null
let statusText: TextRenderable | null = null
let updateInterval: Timer | null = null

function clearUpdateInterval(): void {
  if (updateInterval) {
    clearInterval(updateInterval)
    updateInterval = null
  }
}

export function run(renderer: CliRenderer): void {
  renderer.setBackgroundColor("#0d1117")

  mainContainer = new BoxRenderable(renderer, {
    id: "mainContainer",
    width: 88,
    height: 32,
    backgroundColor: "#161b22",
    zIndex: 1,
    borderColor: "#50565d",
    title: "TextNode Demo",
    titleAlignment: "center",
    border: true,
  })
  renderer.root.add(mainContainer)

  // Create the main demo text area
  demoText = new TextRenderable(renderer, {
    id: "demoText",
    width: 60,
    height: 20,
    zIndex: 2,
    fg: "#f0f6fc",
  })
  mainContainer.add(demoText)

  // Create instructions
  instructionsText = new TextRenderable(renderer, {
    id: "instructions",
    content: t`${bold(cyan("TextNode Demo"))}
${yellow("•")} Press ${green("1-4")} to see different examples
${yellow("•")} Press ${green("SPACE")} to toggle dynamic updates
${yellow("•")} Press ${green("R")} to reset demo
${yellow("•")} Press ${green("ESC")} to exit

${underline("Current:")} Example 1 - Basic TextNode Creation`,
    fg: "#c9d1d9",
  })
  mainContainer.add(instructionsText)

  // Create status area
  statusText = new TextRenderable(renderer, {
    id: "status",
    content: "Ready - Press 1-4 for examples",
    width: 84,
    height: 3,
    fg: "#58a6ff",
  })
  mainContainer.add(statusText)

  // Initialize with first example
  showExample1()

  // Set up keyboard controls
  const keyHandler = (event: KeyEvent) => {
    const key = event.sequence
    if (key === "1") {
      showExample1()
    } else if (key === "2") {
      showExample2()
    } else if (key === "3") {
      showExample3()
    } else if (key === "4") {
      showExample4()
    } else if (key === " ") {
      toggleDynamicUpdates()
    } else if (key === "r" || key === "R") {
      resetDemo()
    }
  }
  renderer.keyInput.on("keypress", keyHandler)
  mainContainer.once("destroyed", () => renderer.keyInput.off("keypress", keyHandler))
}

function showExample1(): void {
  if (!demoText) return

  // Clear any running intervals
  clearUpdateInterval()

  // Clear existing TextNodes
  demoText.clear()

  // Example 1: Basic TextNode Creation
  const titleNode = TextNodeRenderable.fromString("Basic TextNode Demo", {
    fg: "#58a6ff",
    attributes: 1, // bold
  })

  const subtitleNode = TextNodeRenderable.fromString("\n\nCreating individual TextNodes with different styles:", {
    fg: "#8b949e",
  })

  const redNode = TextNodeRenderable.fromString("\n\nRed Text", {
    fg: "#ff7b72",
  })

  const blueNode = TextNodeRenderable.fromString(" | Blue Text", {
    fg: "#79c0ff",
  })

  const greenNode = TextNodeRenderable.fromString(" | Green Text", {
    fg: "#56d364",
  })

  const yellowNode = TextNodeRenderable.fromString(" | Yellow Background", {
    fg: "#000000",
    bg: "#d29922",
  })

  // Create a container node that holds all the styled nodes
  const containerNode = TextNodeRenderable.fromNodes([
    titleNode,
    subtitleNode,
    redNode,
    blueNode,
    greenNode,
    yellowNode,
  ])

  // Add to TextRenderable
  demoText.add(containerNode)

  updateInstructions(
    "Example 1 - Basic TextNode Creation",
    "Creating individual TextNodes with different colors and styles",
  )
}

function showExample2(): void {
  if (!demoText) return

  // Clear any running intervals
  clearUpdateInterval()

  // Clear existing TextNodes
  demoText.clear()

  // Example 2: Nested TextNode Composition
  const titleNode = TextNodeRenderable.fromString("Nested Composition Demo", {
    fg: "#58a6ff",
    attributes: 1, // bold
  })

  const introNode = TextNodeRenderable.fromString("\n\nBuilding complex text by nesting TextNodes:", {
    fg: "#8b949e",
  })

  // Create nested structure
  const codeBlock = TextNodeRenderable.fromString(
    "\n\nfunction calculateTotal(items) {\n  return items.reduce((sum, item) => {\n    return sum + item.price;\n  }, 0);\n}",
    {
      fg: "#f0f6fc",
      bg: "#0d1117",
    },
  )

  const commentNode = TextNodeRenderable.fromString("\n\n// This is a nested comment", {
    fg: "#8b949e",
  })

  const highlightNode = TextNodeRenderable.fromString(" with ", {
    fg: "#79c0ff",
    attributes: 1, // bold
  })

  const highlightNode2 = TextNodeRenderable.fromString("highlighting", {
    fg: "#ff7b72",
    attributes: 4, // underline
  })

  // Create a sentence that combines multiple styled parts
  const sentenceNode = TextNodeRenderable.fromNodes([
    TextNodeRenderable.fromString("\n\nThis demonstrates ", { fg: "#c9d1d9" }),
    highlightNode,
    TextNodeRenderable.fromString("and ", { fg: "#c9d1d9" }),
    highlightNode2,
    TextNodeRenderable.fromString(" within the same text flow.", { fg: "#c9d1d9" }),
  ])

  // Create the main container
  const containerNode = TextNodeRenderable.fromNodes([titleNode, introNode, codeBlock, commentNode, sentenceNode])

  demoText.add(containerNode)

  updateInstructions(
    "Example 2 - Nested TextNode Composition",
    "Building complex text structures by composing TextNodes together",
  )
}

function showExample3(): void {
  if (!demoText) return

  // Clear any existing intervals before setting up new ones
  clearUpdateInterval()

  // Clear existing TextNodes
  demoText.clear()

  // Example 3: Dynamic TextNode Updates
  const titleNode = TextNodeRenderable.fromString("Dynamic Updates Demo", {
    fg: "#58a6ff",
    attributes: 1, // bold
  })

  const introNode = TextNodeRenderable.fromString("\n\nTextNodes can be updated dynamically:", {
    fg: "#8b949e",
  })

  const counterNode = TextNodeRenderable.fromString(`\n\nCounter: 0`, {
    fg: "#56d364",
    attributes: 1, // bold
  })

  const statusNode = TextNodeRenderable.fromString("\n\nStatus: Idle", {
    fg: "#79c0ff",
  })

  const progressNode = TextNodeRenderable.fromString("\n\nProgress: [          ]", {
    fg: "#d29922",
  })

  // Store references to nodes that will be updated
  const containerNode = TextNodeRenderable.fromNodes([titleNode, introNode, counterNode, statusNode, progressNode])

  demoText.add(containerNode)

  // Set up dynamic updates for this example
  let example3Counter = 0
  const maxCount = 20

  updateInterval = setInterval(() => {
    if (!demoText || !containerNode) return

    example3Counter++
    if (example3Counter > maxCount) {
      example3Counter = 0
    }

    // Update counter node
    counterNode.children = [`\n\nCounter: ${example3Counter}`]

    // Update status based on counter
    const status = example3Counter < 5 ? "Starting" : example3Counter < 15 ? "Running" : "Finishing"
    statusNode.children = [`\n\nStatus: ${status}`]

    // Update progress bar
    const progress = Math.floor((example3Counter / maxCount) * 10)
    const progressBar = "█".repeat(progress).padEnd(10, "░")
    progressNode.children = [`\n\nProgress: [${progressBar}]`]

    // TextRenderable will automatically update from TextNode changes
  }, 100)

  updateInstructions(
    "Example 3 - Dynamic TextNode Updates",
    "TextNodes can be modified and the changes reflected in real-time",
  )
}

function showExample4(): void {
  if (!demoText) return

  // Clear any running intervals
  clearUpdateInterval()

  // Clear existing TextNodes
  demoText.clear()

  // Example 4: Complex Document Structure
  const titleNode = TextNodeRenderable.fromString("Complex Document Demo", {
    fg: "#58a6ff",
    attributes: 1, // bold
  })

  const introNode = TextNodeRenderable.fromString("\n\nBuilding a complete document with TextNodes:", {
    fg: "#8b949e",
  })

  // Document sections
  const headerNode = TextNodeRenderable.fromString("\n\n📋 Project Status Report", {
    fg: "#ffffff",
    attributes: 1, // bold
  })

  const section1Node = TextNodeRenderable.fromNodes([
    TextNodeRenderable.fromString("\n\n🚀 ", { fg: "#56d364" }),
    TextNodeRenderable.fromString("Progress", { fg: "#58a6ff", attributes: 1 }),
    TextNodeRenderable.fromString(": 85% complete", { fg: "#c9d1d9" }),
  ])

  const section2Node = TextNodeRenderable.fromNodes([
    TextNodeRenderable.fromString("\n\n⚠️  ", { fg: "#d29922" }),
    TextNodeRenderable.fromString("Issues", { fg: "#ff7b72", attributes: 1 }),
    TextNodeRenderable.fromString(": 2 minor issues found", { fg: "#c9d1d9" }),
  ])

  const section3Node = TextNodeRenderable.fromNodes([
    TextNodeRenderable.fromString("\n\n✅ ", { fg: "#56d364" }),
    TextNodeRenderable.fromString("Next Steps", { fg: "#58a6ff", attributes: 1 }),
    TextNodeRenderable.fromString(": Code review and testing", { fg: "#c9d1d9" }),
  ])

  const footerNode = TextNodeRenderable.fromString("\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", {
    fg: "#30363d",
  })

  const signatureNode = TextNodeRenderable.fromString("\nGenerated by OpenTUI TextNode Demo", {
    fg: "#8b949e",
    attributes: 2, // italic
  })

  // Combine all sections into the final document
  const documentNode = TextNodeRenderable.fromNodes([
    titleNode,
    introNode,
    headerNode,
    section1Node,
    section2Node,
    section3Node,
    footerNode,
    signatureNode,
  ])

  demoText.add(documentNode)

  updateInstructions(
    "Example 4 - Complex Document Structure",
    "Creating complete documents by composing multiple styled TextNode sections",
  )
}

function toggleDynamicUpdates(): void {
  if (updateInterval) {
    clearUpdateInterval()
    updateStatus("Dynamic updates stopped")
  } else {
    // Restart Example 3 if we're not already on it
    showExample3()
    updateStatus("Dynamic updates started")
  }
}

function resetDemo(): void {
  clearUpdateInterval()
  showExample1()
  updateStatus("Demo reset")
}

function updateInstructions(title: string, description: string): void {
  if (!instructionsText) return

  instructionsText.content = t`${bold(cyan("TextNode Demo"))}
${yellow("•")} Press ${green("1-4")} to see different examples
${yellow("•")} Press ${green("SPACE")} to toggle dynamic updates
${yellow("•")} Press ${green("R")} to reset demo
${yellow("•")} Press ${green("ESC")} to exit

${underline("Current:")} ${title}
${description}`
}

function updateStatus(message: string): void {
  if (!statusText) return
  statusText.content = message
}

export function destroy(renderer: CliRenderer): void {
  clearUpdateInterval()

  mainContainer?.destroyRecursively()
  mainContainer = null
  demoText = null
  instructionsText = null
  statusText = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    targetFps: 30,
    enableMouseMovement: true,
    exitOnCtrlC: true,
  })
  renderer.once(CliRenderEvents.DESTROY, () => destroy(renderer))
  run(renderer)
  setupCommonDemoKeys(renderer)
  // renderer.start()
}
