import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

const fence = ["```bash", "$ " + "x".repeat(200), "```"].join("\n")

function audit(root: any): string[] {
  const bad: string[] = []
  const walk = (n: any, pw: number | null, px: number | null) => {
    if (typeof n.width === "number" && typeof n.x === "number" && pw !== null && px !== null && n.x + n.width > px + pw) {
      bad.push(`${n.constructor.name}[${n.x},${n.width}] in [${px},${pw}]`)
    }
    n.getChildren().forEach((c: any) => walk(c, typeof n.width === "number" ? n.width : pw, typeof n.x === "number" ? n.x : px))
  }
  walk(root, null, null)
  return bad
}

describe("ScrollBox viewport keeps content inside", () => {
  beforeEach(async () => {
    if (testSetup) testSetup.renderer.destroy()
  })
  afterEach(() => {
    if (testSetup) testSetup.renderer.destroy()
  })

  it("visible scrollbar keeps code inside markdown", async () => {
    testSetup = await testRender(
      () => (
        <box width={116}>
          <scrollbox
            maxHeight={20}
            viewportOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{ paddingLeft: 1, visible: true }}
          >
            <markdown content={fence} streaming={false} internalBlockMode="top-level" />
          </scrollbox>
        </box>
      ),
      { width: 120, height: 30 },
    )
    await testSetup.waitForFrame((f: string) => f.includes("xxx"))
    expect(audit(testSetup.renderer.root)).toEqual([])
  })
})
