import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import { CliRenderEvents } from "../renderer.js"
import { createTestRenderer, MouseButtons, type MockInput, type MockMouse, type TestRenderer } from "../testing.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { BoxRenderable } from "../renderables/Box.js"
import { InputRenderable } from "../renderables/Input.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextRenderable } from "../renderables/Text.js"

let testRenderer: TestRenderer
let mockMouse: MockMouse
let mockInput: MockInput

beforeEach(async () => {
  ;({
    renderer: testRenderer,
    mockMouse,
    mockInput,
  } = await createTestRenderer({
    width: 50,
    height: 30,
  }))
})

afterEach(() => {
  testRenderer.destroy()
})

test.each(["previous-blur", "renderer-focus", "renderer-blur"] as const)(
  "focus transitions complete after %s listener failures",
  async (phase) => {
    const first = new BoxRenderable(testRenderer, { focusable: true })
    const second = new BoxRenderable(testRenderer, { focusable: true })
    const keys: string[] = []
    first.handleKeyPress = () => {
      keys.push("first")
      return true
    }
    second.handleKeyPress = () => {
      keys.push("second")
      return true
    }
    testRenderer.root.add(first)
    testRenderer.root.add(second)
    const failure = new Error(`fixture ${phase}`)
    if (phase !== "renderer-focus") first.focus()
    if (phase === "previous-blur")
      first.on("blurred", () => {
        throw failure
      })
    else
      testRenderer.on(CliRenderEvents.FOCUSED_RENDERABLE, (current) => {
        if (current === (phase === "renderer-blur" ? null : first)) throw failure
      })
    expect(() =>
      phase === "previous-blur" ? second.focus() : phase === "renderer-focus" ? first.focus() : first.blur(),
    ).toThrow(failure)
    expect(testRenderer.currentFocusedRenderable).toBe(
      phase === "renderer-blur" ? null : phase === "previous-blur" ? second : first,
    )
    await mockInput.pressKey("x")
    expect(keys).toEqual(phase === "renderer-blur" ? [] : [phase === "previous-blur" ? "second" : "first"])
    expect(first.focused).toBe(phase === "renderer-focus")
    expect(second.focused).toBe(phase === "previous-blur")
  },
)

test("focus reentry during previous blur leaves only the final recipient subscribed", async () => {
  const nodes = ["first", "second", "third"].map((id) => new BoxRenderable(testRenderer, { id, focusable: true }))
  const keys: string[] = []
  for (const node of nodes) {
    testRenderer.root.add(node)
    node.handleKeyPress = () => {
      keys.push(node.id)
      return true
    }
  }
  const [first, second, third] = nodes
  first.focus()
  const events: string[] = []
  testRenderer.on(CliRenderEvents.FOCUSED_RENDERABLE, (current) => {
    if (current) events.push(current.id)
  })
  first.on("blurred", () => third.focus())
  second.focus()
  await mockInput.pressKey("x")
  expect(keys).toEqual(["third"])
  expect(events).toEqual(["third"])
  expect(nodes.map((node) => node.focused)).toEqual([false, false, true])
  expect(testRenderer.currentFocusedRenderable).toBe(third)
})

test("detaching a focused child clears former ancestor focus projections", () => {
  const parent = new BoxRenderable(testRenderer, { focusable: true })
  const child = new BoxRenderable(testRenderer, { focusable: true })
  testRenderer.root.add(parent)
  parent.add(child)
  child.focus()
  expect(parent.hasFocusedDescendant).toBe(true)
  parent.remove(child)
  expect(parent.hasFocusedDescendant).toBe(false)
  expect(testRenderer.root.hasFocusedDescendant).toBe(false)
  expect(child.focused).toBe(true)
  parent.add(child)
  expect(parent.hasFocusedDescendant).toBe(true)
})

test("same-node focus reentry does not install a second input subscription", async () => {
  const box = new BoxRenderable(testRenderer, { focusable: true })
  let keys = 0
  box.handleKeyPress = () => {
    keys++
    return true
  }
  testRenderer.root.add(box)
  testRenderer.once(CliRenderEvents.FOCUSED_RENDERABLE, () => {
    box.blur()
    box.focus()
  })
  box.focus()
  await mockInput.pressKey("x")
  expect(box.focused).toBe(true)
  expect(testRenderer.currentFocusedRenderable).toBe(box)
  expect(keys).toBe(1)
})

test("disabling focusability releases focus and input subscriptions", async () => {
  const box = new BoxRenderable(testRenderer, { focusable: true })
  let keys = 0
  box.handleKeyPress = () => {
    keys++
    return true
  }
  testRenderer.root.add(box)
  box.focus()
  box.focusable = false
  expect(box.focused).toBe(false)
  expect(testRenderer.currentFocusedRenderable).toBeNull()
  await mockInput.pressKey("x")
  expect(keys).toBe(0)
})

test("a renderer blur observer can refocus the node without losing its new handlers", async () => {
  const box = new BoxRenderable(testRenderer, { focusable: true })
  let keys = 0
  box.handleKeyPress = () => {
    keys++
    return true
  }
  testRenderer.root.add(box)
  box.focus()
  testRenderer.once(CliRenderEvents.FOCUSED_RENDERABLE, (current) => {
    if (!current) box.focus()
  })
  box.blur()
  expect(box.focused).toBe(true)
  expect(testRenderer.currentFocusedRenderable).toBe(box)
  await mockInput.pressKey("x")
  expect(keys).toBe(1)
})

test("click on focusable element focuses it", async () => {
  const scrollbox = new ScrollBoxRenderable(testRenderer, {
    id: "focusable-box",
    width: 20,
    height: 10,
  })
  testRenderer.root.add(scrollbox)
  await testRenderer.idle()

  expect(scrollbox.focused).toBe(false)

  await mockMouse.click(scrollbox.x + 1, scrollbox.y + 1)

  expect(scrollbox.focused).toBe(true)
})

test("click on child bubbles up to focusable parent", async () => {
  const scrollbox = new ScrollBoxRenderable(testRenderer, {
    id: "parent-box",
    width: 20,
    height: 10,
  })
  testRenderer.root.add(scrollbox)

  const text = new TextRenderable(testRenderer, {
    id: "child-text",
    content: "Click me",
  })
  scrollbox.add(text)
  await testRenderer.idle()

  expect(scrollbox.focused).toBe(false)

  await mockMouse.click(text.x + 1, text.y)

  expect(scrollbox.focused).toBe(true)
})

test("click on non-focusable with no focusable parent does nothing", async () => {
  const box = new BoxRenderable(testRenderer, {
    id: "plain-box",
    width: 20,
    height: 10,
  })
  testRenderer.root.add(box)
  await testRenderer.idle()

  expect(box.focusable).toBe(false)

  await mockMouse.click(box.x + 1, box.y + 1)

  expect(box.focused).toBe(false)
})

test("preventDefault on mousedown prevents auto-focus", async () => {
  const scrollbox = new ScrollBoxRenderable(testRenderer, {
    id: "focusable-box",
    width: 20,
    height: 10,
    onMouseDown: (event) => {
      event.preventDefault()
    },
  })
  testRenderer.root.add(scrollbox)
  await testRenderer.idle()

  expect(scrollbox.focused).toBe(false)

  await mockMouse.click(scrollbox.x + 1, scrollbox.y + 1)

  expect(scrollbox.focused).toBe(false)
})

test("mousedown handler is only called once per click", async () => {
  let mouseDownCount = 0
  const box = new BoxRenderable(testRenderer, {
    id: "click-box",
    width: 20,
    height: 10,
    onMouseDown: () => {
      mouseDownCount++
    },
  })
  testRenderer.root.add(box)
  await testRenderer.idle()

  await mockMouse.click(box.x + 1, box.y + 1)

  expect(mouseDownCount).toBe(1)
})

test("non-left click does not auto-focus", async () => {
  const scrollbox = new ScrollBoxRenderable(testRenderer, {
    id: "focusable-box",
    width: 20,
    height: 10,
  })
  testRenderer.root.add(scrollbox)
  await testRenderer.idle()

  await mockMouse.click(scrollbox.x + 1, scrollbox.y + 1, MouseButtons.RIGHT)
  expect(scrollbox.focused).toBe(false)

  await mockMouse.click(scrollbox.x + 2, scrollbox.y + 2, MouseButtons.MIDDLE)
  expect(scrollbox.focused).toBe(false)
})

test("preventDefault on ancestor blocks auto-focus", async () => {
  let childDown = false
  const parent = new BoxRenderable(testRenderer, {
    id: "focus-parent",
    position: "absolute",
    left: 2,
    top: 2,
    width: 20,
    height: 10,
    focusable: true,
    onMouseDown: (event) => {
      event.preventDefault()
    },
  })
  const child = new BoxRenderable(testRenderer, {
    id: "focus-child",
    position: "absolute",
    left: 1,
    top: 1,
    width: 6,
    height: 3,
    onMouseDown: () => {
      childDown = true
    },
  })
  parent.add(child)
  testRenderer.root.add(parent)
  await testRenderer.idle()

  await mockMouse.click(child.x + 1, child.y + 1)

  expect(childDown).toBe(true)
  expect(parent.focused).toBe(false)
  expect(child.focused).toBe(false)
})

test("dragging over focusable target does not auto-focus", async () => {
  const start = new BoxRenderable(testRenderer, {
    id: "drag-start",
    position: "absolute",
    left: 1,
    top: 1,
    width: 6,
    height: 4,
  })
  const focusable = new BoxRenderable(testRenderer, {
    id: "drag-focusable",
    position: "absolute",
    left: 12,
    top: 1,
    width: 6,
    height: 4,
    focusable: true,
  })
  testRenderer.root.add(start)
  testRenderer.root.add(focusable)
  await testRenderer.idle()

  await mockMouse.pressDown(start.x + 1, start.y + 1)
  await mockMouse.moveTo(focusable.x + 1, focusable.y + 1)
  await mockMouse.release(focusable.x + 1, focusable.y + 1)

  expect(focusable.focused).toBe(false)
})

test("clicking empty space does not auto-focus", async () => {
  const box = new BoxRenderable(testRenderer, {
    id: "focusable-box",
    position: "absolute",
    left: 1,
    top: 1,
    width: 8,
    height: 4,
    focusable: true,
  })
  testRenderer.root.add(box)
  await testRenderer.idle()

  await mockMouse.click(testRenderer.width - 1, testRenderer.height - 1)

  expect(box.focused).toBe(false)
})

test("autoFocus=false prevents click focus changes", async () => {
  const { renderer, mockMouse } = await createTestRenderer({
    width: 50,
    height: 30,
    autoFocus: false,
  })

  try {
    const first = new BoxRenderable(renderer, {
      id: "focus-first",
      position: "absolute",
      left: 1,
      top: 1,
      width: 8,
      height: 4,
      focusable: true,
    })
    const second = new BoxRenderable(renderer, {
      id: "focus-second",
      position: "absolute",
      left: 12,
      top: 1,
      width: 8,
      height: 4,
      focusable: true,
    })
    renderer.root.add(first)
    renderer.root.add(second)
    await renderer.idle()

    first.focus()
    expect(first.focused).toBe(true)

    await mockMouse.click(second.x + 1, second.y + 1)

    expect(first.focused).toBe(true)
    expect(second.focused).toBe(false)
  } finally {
    renderer.destroy()
  }
})

test("focused_editor event emits on editor focus changes", async () => {
  const events: Array<[string | null, string | null]> = []
  const box = new BoxRenderable(testRenderer, {
    id: "plain-box",
    width: 10,
    height: 2,
    focusable: true,
  })
  const textarea = new TextareaRenderable(testRenderer, {
    id: "editor-a",
    width: 20,
    height: 3,
  })
  const input = new InputRenderable(testRenderer, {
    id: "editor-b",
    width: 20,
  })

  testRenderer.on(CliRenderEvents.FOCUSED_EDITOR, (current, previous) => {
    events.push([current?.id ?? null, previous?.id ?? null])
  })

  testRenderer.root.add(box)
  testRenderer.root.add(textarea)
  testRenderer.root.add(input)
  await testRenderer.idle()

  textarea.focus()
  box.focus()
  input.focus()
  input.focus()

  expect(events).toEqual([
    ["editor-a", null],
    [null, "editor-a"],
    ["editor-b", null],
  ])
  expect(testRenderer.currentFocusedEditor?.id).toBe("editor-b")
})

test("focused_renderable event emits once per focus change and direct blur", async () => {
  const events: Array<[string | null, string | null]> = []
  const first = new BoxRenderable(testRenderer, {
    id: "first-box",
    width: 10,
    height: 2,
    focusable: true,
  })
  const second = new BoxRenderable(testRenderer, {
    id: "second-box",
    width: 10,
    height: 2,
    focusable: true,
  })

  testRenderer.on(CliRenderEvents.FOCUSED_RENDERABLE, (current, previous) => {
    events.push([current?.id ?? null, previous?.id ?? null])
  })

  testRenderer.root.add(first)
  testRenderer.root.add(second)
  await testRenderer.idle()

  first.focus()
  second.focus()
  second.blur()

  expect(events).toEqual([
    ["first-box", null],
    ["second-box", "first-box"],
    [null, "second-box"],
  ])
  expect(testRenderer.currentFocusedRenderable).toBeNull()
})
