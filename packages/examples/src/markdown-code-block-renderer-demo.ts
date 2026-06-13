import {
  BoxRenderable,
  CliRenderer,
  MarkdownRenderable,
  RGBA,
  SyntaxStyle,
  TextRenderable,
  createCliRenderer,
  createMarkdownCodeBlockRenderer,
  type MarkdownCodeBlockRenderer,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

interface TaskFlowStep {
  label: string
  status: "done" | "active" | "queued" | "blocked"
}

interface TaskFlowDocument {
  title: string
  owner: string
  steps: TaskFlowStep[]
}

const markdownContent = `# Markdown Code Block Renderers

This markdown document contains a fenced \`taskflow\` block. The source stays plain text, but the markdown renderer swaps that single language into a custom OpenTUI widget.

\`\`\`taskflow
title Ship markdown plug-ins
owner terminal team
step Parse fenced language done
step Render custom widget active
step Capture screenshot queued
step Open pull request queued
\`\`\`

Everything around the custom fence is still rendered by the normal markdown pipeline, including **bold text**, links, and ordinary code fences.

\`\`\`ts
const renderNode = createMarkdownCodeBlockRenderer({ taskflow: renderTaskFlow })
\`\`\`
`

let root: BoxRenderable | null = null
let syntaxStyle: SyntaxStyle | null = null

function createSyntaxStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex("#DDE7FF") },
    "markup.heading": { fg: RGBA.fromHex("#93C5FD"), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex("#67E8F9"), bold: true },
    "markup.raw": { fg: RGBA.fromHex("#A7F3D0") },
    "markup.strong": { fg: RGBA.fromHex("#FDE68A"), bold: true },
    "markup.link": { fg: RGBA.fromHex("#C4B5FD"), underline: true },
    "markup.list": { fg: RGBA.fromHex("#F9A8D4") },
  })
}

function parseTaskFlow(source: string): TaskFlowDocument {
  const document: TaskFlowDocument = {
    title: "Untitled taskflow",
    owner: "unknown",
    steps: [],
  }

  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("title ")) {
      document.title = trimmed.slice("title ".length)
      continue
    }

    if (trimmed.startsWith("owner ")) {
      document.owner = trimmed.slice("owner ".length)
      continue
    }

    if (trimmed.startsWith("step ")) {
      const rest = trimmed.slice("step ".length)
      const statusStart = rest.lastIndexOf(" ")
      if (statusStart === -1) continue

      const label = rest.slice(0, statusStart)
      const status = rest.slice(statusStart + 1) as TaskFlowStep["status"]
      if (status === "done" || status === "active" || status === "queued" || status === "blocked") {
        document.steps.push({ label, status })
      }
    }
  }

  return document
}

function stepStyle(status: TaskFlowStep["status"]): { marker: string; color: string } {
  if (status === "done") return { marker: "OK", color: "#86EFAC" }
  if (status === "active") return { marker: ">>", color: "#67E8F9" }
  if (status === "blocked") return { marker: "!!", color: "#FDA4AF" }
  return { marker: "--", color: "#CBD5E1" }
}

function createTaskFlowRenderer(renderer: CliRenderer): MarkdownCodeBlockRenderer {
  return (token) => {
    const flow = parseTaskFlow(token.text)
    const card = new BoxRenderable(renderer, {
      id: "taskflow-card",
      width: "100%",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: "#38BDF8",
      backgroundColor: "#07111F",
      paddingX: 2,
      paddingY: 1,
      marginBottom: 1,
      title: `taskflow: ${flow.title}`,
      titleAlignment: "left",
    })

    card.add(
      new TextRenderable(renderer, {
        content: `owner ${flow.owner}  |  ${flow.steps.length} steps`,
        fg: "#93A4B8",
        width: "100%",
      }),
    )

    for (const step of flow.steps) {
      const style = stepStyle(step.status)
      card.add(
        new TextRenderable(renderer, {
          content: `${style.marker} ${step.label.padEnd(28)} ${step.status}`,
          fg: style.color,
          width: "100%",
        }),
      )
    }

    return card
  }
}

export function run(renderer: CliRenderer): void {
  renderer.start()
  renderer.setBackgroundColor("#020617")
  syntaxStyle = createSyntaxStyle()

  root = new BoxRenderable(renderer, {
    id: "markdown-code-block-renderer-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingX: 2,
    paddingY: 1,
    backgroundColor: "#020617",
  })
  renderer.root.add(root)

  root.add(
    new MarkdownRenderable(renderer, {
      id: "markdown-code-block-renderer-doc",
      content: markdownContent,
      syntaxStyle,
      fg: "#DDE7FF",
      bg: "#020617",
      width: "100%",
      renderNode: createMarkdownCodeBlockRenderer({
        taskflow: createTaskFlowRenderer(renderer),
      }),
    }),
  )
}

export function destroy(): void {
  root?.destroyRecursively()
  syntaxStyle?.destroy()
  root = null
  syntaxStyle = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
