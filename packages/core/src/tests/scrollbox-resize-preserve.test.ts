import { test, expect } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { ScrollBoxRenderable, type ScrollBoxOptions } from "../renderables/ScrollBox.js"
import { TextRenderable } from "../renderables/Text.js"

export interface ResizeSize {
  width: number
  height: number
}

interface AnchorSnapshot {
  id: string
  offsetWithinViewport: number
}

interface MessageSpec {
  id?: string
  content: string
}

interface ResizeScenarioOptions {
  initialSize?: ResizeSize
  stickyScroll?: boolean
  stickyStart?: ScrollBoxOptions["stickyStart"]
  messageCount?: number
  messageFactory?: (index: number) => MessageSpec
  scrollBoxOptions?: Omit<ScrollBoxOptions, "width" | "height" | "stickyScroll" | "stickyStart">
}

interface ResizeManyOptions {
  settleEachStep?: boolean
}

function defaultMessageFactory(index: number): MessageSpec {
  return {
    id: `message-${index}`,
    content: `Message ${index} ${"wrap ".repeat(30)}`,
  }
}

function repeatResizePattern(pattern: ResizeSize[], repeats: number): ResizeSize[] {
  const result: ResizeSize[] = []
  for (let i = 0; i < repeats; i++) {
    for (const step of pattern) result.push({ ...step })
  }
  return result
}

class ScrollBoxResizeScenario {
  public readonly renderer: TestRenderer
  public readonly scrollBox: ScrollBoxRenderable

  private readonly resizeFn: (width: number, height: number) => void
  private readonly messageFactory: (index: number) => MessageSpec

  private constructor(
    renderer: TestRenderer,
    resizeFn: (width: number, height: number) => void,
    scrollBox: ScrollBoxRenderable,
    messageFactory: (index: number) => MessageSpec,
  ) {
    this.renderer = renderer
    this.resizeFn = resizeFn
    this.scrollBox = scrollBox
    this.messageFactory = messageFactory
  }

  public static async create(options: ResizeScenarioOptions = {}): Promise<ScrollBoxResizeScenario> {
    const {
      initialSize = { width: 120, height: 12 },
      stickyScroll = false,
      stickyStart,
      messageCount = 60,
      messageFactory = defaultMessageFactory,
      scrollBoxOptions,
    } = options

    const { renderer, resize } = await createTestRenderer({
      width: initialSize.width,
      height: initialSize.height,
    })

    const scrollBox = new ScrollBoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      stickyScroll,
      stickyStart,
      ...(scrollBoxOptions ?? {}),
    })

    renderer.root.add(scrollBox)

    const scenario = new ScrollBoxResizeScenario(renderer, resize, scrollBox, messageFactory)

    if (messageCount > 0) {
      await scenario.addMessages(messageCount)
    } else {
      await scenario.settle()
    }

    return scenario
  }

  public destroy(): void {
    this.renderer.destroy()
  }

  public async settle(): Promise<void> {
    await this.renderer.idle()
  }

  public get maxScrollTop(): number {
    return Math.max(0, this.scrollBox.scrollHeight - this.scrollBox.viewport.height)
  }

  public get distanceFromBottom(): number {
    return Math.max(0, this.maxScrollTop - this.scrollBox.scrollTop)
  }

  public get hasManualScroll(): boolean {
    const internal = this.scrollBox as unknown as { _hasManualScroll?: boolean }
    return Boolean(internal._hasManualScroll)
  }

  public captureAnchor(): AnchorSnapshot {
    const viewportTop = this.scrollBox.viewport.y
    const viewportBottom = viewportTop + this.scrollBox.viewport.height

    const firstVisible = this.scrollBox.content
      .getChildrenSortedByPrimaryAxis()
      .find((child) => child.y + child.height > viewportTop && child.y < viewportBottom)

    if (!firstVisible) {
      throw new Error("No visible child found to capture anchor")
    }

    return {
      id: firstVisible.id,
      offsetWithinViewport: viewportTop - firstVisible.y,
    }
  }

  public expectAnchorPreserved(anchor: AnchorSnapshot, tolerance = 1): void {
    const anchoredAfter = this.scrollBox.getChildren().find((child) => child.id === anchor.id)
    expect(anchoredAfter).toBeTruthy()
    if (!anchoredAfter) return

    const offsetAfter = this.scrollBox.viewport.y - anchoredAfter.y
    expect(Math.abs(offsetAfter - anchor.offsetWithinViewport)).toBeLessThanOrEqual(tolerance)
  }

  public expectPinnedBottom(): void {
    expect(this.scrollBox.scrollTop).toBe(this.maxScrollTop)
  }

  public expectDistanceFromBottomPreserved(before: number): void {
    expect(this.maxScrollTop).toBeGreaterThan(before)
    expect(this.scrollBox.scrollTop).toBe(this.maxScrollTop - before)
  }

  public async scrollTo(top: number): Promise<void> {
    this.scrollBox.scrollTop = top
    await this.settle()
  }

  public async scrollToManualOffsetFromBottom(distanceFromBottom: number): Promise<void> {
    this.scrollBox.scrollTop = Math.max(1, this.maxScrollTop - distanceFromBottom)
    await this.settle()
  }

  public async addMessages(
    count: number,
    factory: (index: number) => MessageSpec = this.messageFactory,
  ): Promise<void> {
    const startIndex = this.scrollBox.getChildren().length
    for (let i = 0; i < count; i++) {
      const absoluteIndex = startIndex + i
      const message = factory(absoluteIndex)

      this.scrollBox.add(
        new TextRenderable(this.renderer, {
          id: message.id ?? `msg-${absoluteIndex}`,
          content: message.content,
        }),
      )
    }

    await this.settle()
  }

  public async resizeTo(size: ResizeSize): Promise<void> {
    this.resizeFn(size.width, size.height)
    await this.settle()
  }

  public async resizeMany(sizes: ResizeSize[], options: ResizeManyOptions = {}): Promise<void> {
    const { settleEachStep = false } = options

    for (const size of sizes) {
      this.resizeFn(size.width, size.height)
      if (settleEachStep) await this.settle()
    }

    if (!settleEachStep) await this.settle()
  }
}

async function withScenario(options: ResizeScenarioOptions, run: (s: ScrollBoxResizeScenario) => Promise<void>) {
  const s = await ScrollBoxResizeScenario.create(options)
  try {
    await run(s)
  } finally {
    s.destroy()
  }
}

test("sticky bottom manual preserves distance from bottom on single resize when anchor unavailable", async () => {
  await withScenario(
    {
      stickyScroll: true,
      stickyStart: "bottom",
      initialSize: { width: 120, height: 10 },
      messageCount: 30,
      messageFactory: (index) => ({
        id: "",
        content: `Line ${index} ${"x".repeat(90)}`,
      }),
    },
    async (s) => {
      await s.scrollTo(10)
      expect(s.hasManualScroll).toBe(true)

      const before = s.distanceFromBottom
      await s.resizeTo({ width: 40, height: 40 })

      s.expectDistanceFromBottomPreserved(before)
    },
  )
})

test("non-sticky preserves distance from bottom on single resize when anchor unavailable", async () => {
  await withScenario(
    {
      stickyScroll: false,
      initialSize: { width: 120, height: 12 },
      messageCount: 30,
      messageFactory: (index) => ({
        id: "",
        content: `Line ${index} ${"x".repeat(90)}`,
      }),
    },
    async (s) => {
      await s.scrollTo(10)

      const before = s.distanceFromBottom
      await s.resizeTo({ width: 40, height: 40 })

      s.expectDistanceFromBottomPreserved(before)
    },
  )
})

test("sticky bottom manual preserves first visible anchor on single resize", async () => {
  await withScenario(
    {
      stickyScroll: true,
      stickyStart: "bottom",
      initialSize: { width: 120, height: 12 },
      messageCount: 60,
    },
    async (s) => {
      await s.scrollToManualOffsetFromBottom(20)
      expect(s.hasManualScroll).toBe(true)

      const anchor = s.captureAnchor()
      await s.resizeTo({ width: 40, height: 40 })

      s.expectAnchorPreserved(anchor)
    },
  )
})

test("non-sticky preserves first visible anchor on single resize", async () => {
  await withScenario(
    {
      stickyScroll: false,
      initialSize: { width: 120, height: 12 },
      messageCount: 60,
    },
    async (s) => {
      await s.scrollToManualOffsetFromBottom(20)

      const anchor = s.captureAnchor()
      await s.resizeTo({ width: 40, height: 40 })

      s.expectAnchorPreserved(anchor)
    },
  )
})

test("sticky bottom auto remains pinned on single resize", async () => {
  await withScenario(
    {
      stickyScroll: true,
      stickyStart: "bottom",
      initialSize: { width: 120, height: 10 },
      messageCount: 40,
    },
    async (s) => {
      s.expectPinnedBottom()
      expect(s.hasManualScroll).toBe(false)

      await s.resizeTo({ width: 40, height: 40 })

      s.expectPinnedBottom()
      expect(s.hasManualScroll).toBe(false)
    },
  )
})

test("non-sticky preserves first visible anchor across resize storm", async () => {
  await withScenario(
    {
      stickyScroll: false,
      initialSize: { width: 140, height: 14 },
      messageCount: 120,
    },
    async (s) => {
      await s.scrollToManualOffsetFromBottom(25)
      const anchor = s.captureAnchor()

      await s.resizeMany(
        [
          { width: 110, height: 18 },
          { width: 80, height: 22 },
          { width: 40, height: 40 },
        ],
        { settleEachStep: true },
      )

      s.expectAnchorPreserved(anchor)
    },
  )
})

test("non-sticky preserves first visible anchor across resize storm with deep history", async () => {
  await withScenario(
    {
      stickyScroll: false,
      initialSize: { width: 160, height: 20 },
      messageCount: 180,
    },
    async (s) => {
      await s.scrollToManualOffsetFromBottom(35)
      const anchor = s.captureAnchor()

      const storm = repeatResizePattern(
        [
          { width: 140, height: 18 },
          { width: 120, height: 24 },
          { width: 90, height: 28 },
          { width: 60, height: 34 },
          { width: 40, height: 40 },
        ],
        6,
      )

      await s.resizeMany(storm)
      s.expectAnchorPreserved(anchor, 1)
    },
  )
})

test("non-sticky preserves partially visible anchor offset on single resize", async () => {
  await withScenario(
    {
      stickyScroll: false,
      initialSize: { width: 120, height: 12 },
      messageCount: 90,
      messageFactory: (index) => ({
        id: `message-${index}`,
        content: `Message ${index} ${"very long wrapped segment ".repeat(20)}`,
      }),
    },
    async (s) => {
      await s.scrollToManualOffsetFromBottom(27)

      let anchor = s.captureAnchor()
      for (let attempt = 0; attempt < 6 && anchor.offsetWithinViewport === 0; attempt++) {
        await s.scrollTo(s.scrollBox.scrollTop + 1)
        anchor = s.captureAnchor()
      }

      expect(anchor.offsetWithinViewport).toBeGreaterThan(0)

      await s.resizeTo({ width: 45, height: 36 })
      s.expectAnchorPreserved(anchor)
    },
  )
})

test("sticky bottom manual preserves first visible anchor across staged resize storm", async () => {
  await withScenario(
    {
      stickyScroll: true,
      stickyStart: "bottom",
      initialSize: { width: 140, height: 14 },
      messageCount: 120,
    },
    async (s) => {
      await s.scrollToManualOffsetFromBottom(25)
      expect(s.hasManualScroll).toBe(true)
      const anchor = s.captureAnchor()

      await s.resizeMany(
        [
          { width: 110, height: 18 },
          { width: 80, height: 22 },
          { width: 40, height: 40 },
        ],
        { settleEachStep: true },
      )

      s.expectAnchorPreserved(anchor)
    },
  )
})

test("sticky bottom manual preserves first visible anchor across batched resize storm", async () => {
  await withScenario(
    {
      stickyScroll: true,
      stickyStart: "bottom",
      initialSize: { width: 160, height: 20 },
      messageCount: 180,
    },
    async (s) => {
      await s.scrollToManualOffsetFromBottom(35)
      expect(s.hasManualScroll).toBe(true)
      const anchor = s.captureAnchor()

      const storm = repeatResizePattern(
        [
          { width: 140, height: 18 },
          { width: 120, height: 24 },
          { width: 90, height: 28 },
          { width: 60, height: 34 },
          { width: 40, height: 40 },
        ],
        6,
      )

      await s.resizeMany(storm)
      s.expectAnchorPreserved(anchor, 1)
    },
  )
})
