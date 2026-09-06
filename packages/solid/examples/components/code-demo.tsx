import { SyntaxStyle, RGBA, RenderableEvents, type CodeRenderable } from "@opentui/core"
import { onCleanup } from "solid-js"
import { useRenderer } from "@opentui/solid"

export function CodeDemo() {
  const renderer = useRenderer()
  const syntaxStyle = SyntaxStyle.fromStyles(
    {
      keyword: { fg: RGBA.fromHex("#ff6b6b"), bold: true }, // red, bold
      string: { fg: RGBA.fromHex("#51cf66") }, // green
      comment: { fg: RGBA.fromHex("#868e96"), italic: true }, // gray, italic
      number: { fg: RGBA.fromHex("#ffd43b") }, // yellow
      default: { fg: RGBA.fromHex("#ffffff") }, // white
    },
    renderer.nativeScene!,
  )
  let code: CodeRenderable | undefined
  onCleanup(() => {
    // Solid defers node removal; keep the style until Code releases its buffers.
    if (code && !code.isDestroyed) code.once(RenderableEvents.DESTROYED, () => syntaxStyle.destroy())
    else syntaxStyle.destroy()
  })

  const codeExample = `function hello() {
  // This is a comment
  const message = "Hello, world!"
  const count = 42
  return message + " " + count
}`

  return (
    <box title="Code Syntax Highlighting Demo" width={60} height={15}>
      <code ref={(node) => (code = node)} content={codeExample} filetype="javascript" syntaxStyle={syntaxStyle} />
    </box>
  )
}
