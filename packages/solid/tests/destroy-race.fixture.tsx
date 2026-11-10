import { createTestRenderer } from "@opentui/core/testing"
import { For, createSignal, onCleanup, onMount } from "solid-js"
import { render, testRender, useRenderer } from "../index.js"

type Mode = "external" | "helper" | "external-onmount" | "helper-onmount" | "external-active" | "helper-active"

const mode = process.argv[2] as Mode | undefined
const startedAt = Date.now()

const log = (message: string): void => {
  const elapsed = Date.now() - startedAt
  console.debug(`[solid-destroy-race-fixture ${mode ?? "unknown"} +${elapsed}ms] ${message}`)
}

let didDestroy = false

function InitialRaceApp() {
  const renderer = useRenderer()
  log("InitialRaceApp render started")

  if (!didDestroy) {
    didDestroy = true
    log("Destroying renderer from render body")
    renderer.destroy()
    log("renderer.destroy() returned")
  }

  return <text>race repro</text>
}

function OnMountRaceApp() {
  const renderer = useRenderer()

  onMount(() => {
    log("OnMountRaceApp mounted, destroying renderer")
    renderer.destroy()
    log("renderer.destroy() returned")
  })

  return <text>onmount race repro</text>
}

let appendLine: ((line: string) => void) | undefined

function ActivePassApp() {
  const [lines, setLines] = createSignal<string[]>([])

  appendLine = (line: string) => {
    setLines((prev) => [...prev, line])
  }

  onMount(() => {
    log("ActivePassApp mounted")
  })

  onCleanup(() => {
    log("ActivePassApp cleanup")
    appendLine = undefined
  })

  return (
    <box flexDirection="column" border borderStyle="single">
      <text>active pass race repro</text>
      <For each={lines().slice(-5)}>{(line) => <text>{line}</text>}</For>
    </box>
  )
}

async function runActivePassScenario(withTestRender: boolean): Promise<void> {
  const testSetup = withTestRender
    ? await testRender(() => <ActivePassApp />, { width: 40, height: 12 })
    : await createTestRenderer({ width: 40, height: 12 })

  if (!withTestRender) {
    await render(() => <ActivePassApp />, testSetup.renderer)
  }

  let frame = 0
  testSetup.renderer.setFrameCallback(async () => {
    frame += 1
    log(
      `frame callback #${frame}, rendering=${String((testSetup.renderer as any).rendering)}, destroyed=${testSetup.renderer.isDestroyed}`,
    )

    if (frame === 1) {
      appendLine?.("frame-1")
      return
    }

    if (frame === 2) {
      log("Destroying renderer from frame callback (active render pass)")
      testSetup.renderer.destroy()
      log(`renderer.destroy() returned (destroyed=${testSetup.renderer.isDestroyed})`)

      appendLine?.("after-destroy-sync")
      queueMicrotask(() => {
        log("queueMicrotask update firing after destroy request")
        appendLine?.("after-destroy-microtask")
      })
      return
    }

    appendLine?.(`frame-${frame}`)
  })

  try {
    await testSetup.renderOnce()
    await testSetup.renderOnce()
    await testSetup.renderOnce()
    await Bun.sleep(30)
    await testSetup.renderOnce()

    log("Active pass scenario completed renderOnce calls")
  } finally {
    if (!testSetup.renderer.isDestroyed) {
      testSetup.renderer.destroy()
    }
  }
}

if (mode === "external") {
  const testSetup = await createTestRenderer({ width: 30, height: 10 })
  await render(() => <InitialRaceApp />, testSetup.renderer)
  await Bun.sleep(10)

  if (!testSetup.renderer.isDestroyed) {
    testSetup.renderer.destroy()
  }

  log("External initial mode completed")
} else if (mode === "helper") {
  const testSetup = await testRender(() => <InitialRaceApp />, { width: 30, height: 10 })

  if (!testSetup.renderer.isDestroyed) {
    await testSetup.renderOnce()
  }

  await Bun.sleep(10)

  if (!testSetup.renderer.isDestroyed) {
    testSetup.renderer.destroy()
  }

  log("Helper initial mode completed")
} else if (mode === "external-onmount") {
  const testSetup = await createTestRenderer({ width: 30, height: 10 })
  await render(() => <OnMountRaceApp />, testSetup.renderer)
  await Bun.sleep(10)

  if (!testSetup.renderer.isDestroyed) {
    testSetup.renderer.destroy()
  }

  log("External onMount mode completed")
} else if (mode === "helper-onmount") {
  const testSetup = await testRender(() => <OnMountRaceApp />, { width: 30, height: 10 })

  if (!testSetup.renderer.isDestroyed) {
    await testSetup.renderOnce()
  }

  await Bun.sleep(10)

  if (!testSetup.renderer.isDestroyed) {
    testSetup.renderer.destroy()
  }

  log("Helper onMount mode completed")
} else if (mode === "external-active") {
  await runActivePassScenario(false)
  log("External active mode completed")
} else if (mode === "helper-active") {
  await runActivePassScenario(true)
  log("Helper active mode completed")
} else {
  throw new Error(`Unknown mode: ${String(mode)}`)
}
