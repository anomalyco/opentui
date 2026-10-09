import { describe, expect, it } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { For, createSignal, onCleanup, onMount } from "solid-js"
import { render } from "../index.js"

describe("Renderer destroy with pending Solid updates", () => {
  it("disposes Solid root when renderer is destroyed externally", async () => {
    const testSetup = await createTestRenderer({
      width: 40,
      height: 20,
    })

    const startedAt = Date.now()
    const log = (message: string) => {
      const elapsed = Date.now() - startedAt
      console.debug(`[solid-destroy-debug +${elapsed}ms] ${message}`)
    }

    let cleanupCalls = 0
    let destroyEvents = 0
    let intervalTicks = 0
    let intervalTicksAfterDestroy = 0
    let destroyCalled = false

    testSetup.renderer.on("destroy", () => {
      destroyEvents += 1
      log(`renderer destroy event fired (#${destroyEvents})`)
    })

    function App() {
      const [lines, setLines] = createSignal<string[]>([])
      let interval: ReturnType<typeof setInterval> | undefined

      onMount(() => {
        log("app mounted, starting interval")
        interval = setInterval(() => {
          intervalTicks += 1
          if (destroyCalled) {
            intervalTicksAfterDestroy += 1
          }

          log(`interval tick #${intervalTicks} (destroyCalled=${destroyCalled})`)
          setLines((prev) => [...prev, `Line ${prev.length + 1}`])
        }, 5)
      })

      onCleanup(() => {
        cleanupCalls += 1
        log(`app cleanup called (#${cleanupCalls}), clearing interval`)

        if (interval) {
          clearInterval(interval)
          interval = undefined
        }
      })

      return (
        <box flexDirection="column" border borderStyle="single">
          <text bold>Solid destroy repro</text>
          <For each={lines().slice(-10)}>{(line) => <text>{line}</text>}</For>
        </box>
      )
    }

    try {
      await render(() => <App />, testSetup.renderer)

      await testSetup.renderOnce()
      await Bun.sleep(30)
      await testSetup.renderOnce()

      log(`ticks before destroy: ${intervalTicks}`)
      destroyCalled = true
      log("calling renderer.destroy()")
      testSetup.renderer.destroy()
      await render(() => <App />, testSetup.renderer)

      await Bun.sleep(30)
      const ticksSoonAfterDestroy = intervalTicks
      log(`ticks soon after destroy: ${ticksSoonAfterDestroy}`)

      await Bun.sleep(60)
      const ticksLaterAfterDestroy = intervalTicks
      log(`ticks later after destroy: ${ticksLaterAfterDestroy}`)

      expect(destroyEvents).toBe(1)
      expect(cleanupCalls).toBe(1)
      expect(testSetup.renderer.isDestroyed).toBe(true)
      expect(ticksLaterAfterDestroy).toBe(ticksSoonAfterDestroy)
      expect(intervalTicksAfterDestroy).toBeLessThanOrEqual(1)
    } finally {
      if (!testSetup.renderer.isDestroyed) {
        testSetup.renderer.destroy()
      }
    }
  })
})
