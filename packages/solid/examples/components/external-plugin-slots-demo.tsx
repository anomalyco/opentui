import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import "./external-plugin-runtime"
import { createSlotRegistry } from "@opentui/core"
import { Slot, type SlotMode, type SolidPlugin, useKeyboard, useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { resolveExternalPluginCandidates } from "./external-plugin-path.js"

const STATUSBAR_LABEL = "host-status"
const SIDEBAR_SECTION = "external-plugins"
const EXTERNAL_PLUGIN_PATH_ENV = "OPENTUI_SOLID_EXTERNAL_PLUGIN_PATH"
const EXTERNAL_PLUGIN_PACKAGE_JSON = "package.json"
const MAX_INSTALL_OUTPUT_LENGTH = 1200
const BUN_INSTALL_COMMAND = ["install", "--no-save"]
const BUN_BE_BUN_ENV = "BUN_BE_BUN"
const NODE_MODULES_DIR = "node_modules"

const installedPluginDependencyManifestsByDir = new Map<string, string>()

type ExternalPluginSlots = {
  statusbar: { label: string }
  sidebar: { section: string }
}

type ExternalPluginContext = {
  appName: string
  version: string
}

type ExternalPluginModule = {
  loadExternalPlugin(): SolidPlugin<ExternalPluginSlots, ExternalPluginContext>
}

function resolveExternalPluginPath(): string {
  const candidates = resolveExternalPluginCandidates({
    cwd: process.cwd(),
    execPath: process.execPath,
    moduleUrl: import.meta.url,
    envPath: process.env[EXTERNAL_PLUGIN_PATH_ENV],
  })

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`Unable to locate external plugin. Checked: ${candidates.join(", ")}`)
}

function formatInstallOutput(stdout: string, stderr: string): string {
  const output = [stdout.trim(), stderr.trim()].filter((line) => line.length > 0).join("\n")

  if (output.length <= MAX_INSTALL_OUTPUT_LENGTH) {
    return output
  }

  return `${output.slice(0, MAX_INSTALL_OUTPUT_LENGTH)}\n...(truncated)...`
}

function readPluginPackageManifest(packageJsonPath: string): string {
  try {
    return readFileSync(packageJsonPath, "utf8")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read external plugin package manifest at ${packageJsonPath}: ${message}`)
  }
}

function ensureExternalPluginDependencies(pluginEntryPath: string): void {
  const pluginDir = dirname(pluginEntryPath)
  const pluginPackageJson = join(pluginDir, EXTERNAL_PLUGIN_PACKAGE_JSON)
  const pluginNodeModulesDir = join(pluginDir, NODE_MODULES_DIR)

  if (!existsSync(pluginPackageJson)) {
    return
  }

  const packageManifest = readPluginPackageManifest(pluginPackageJson)
  const cachedManifest = installedPluginDependencyManifestsByDir.get(pluginDir)

  if (cachedManifest === packageManifest && existsSync(pluginNodeModulesDir)) {
    return
  }

  const install = Bun.spawnSync([process.execPath, ...BUN_INSTALL_COMMAND], {
    cwd: pluginDir,
    env: {
      ...process.env,
      [BUN_BE_BUN_ENV]: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  if (install.exitCode !== 0) {
    const output = formatInstallOutput(install.stdout.toString(), install.stderr.toString())
    const details = output.length > 0 ? `\n${output}` : ""
    throw new Error(`Failed to install external plugin dependencies in ${pluginDir}.${details}`)
  }

  installedPluginDependencyManifestsByDir.set(pluginDir, packageManifest)
}

async function loadExternalPluginFromDisk(
  nonce: number,
): Promise<{ path: string; plugin: SolidPlugin<ExternalPluginSlots, ExternalPluginContext> }> {
  const path = resolveExternalPluginPath()
  ensureExternalPluginDependencies(path)
  const url = pathToFileURL(path)
  url.searchParams.set("reload", `${nonce}`)
  url.searchParams.set("ts", `${Date.now()}`)

  const externalModule = (await import(url.href)) as Partial<ExternalPluginModule>

  if (typeof externalModule.loadExternalPlugin !== "function") {
    throw new Error("External plugin module does not export loadExternalPlugin()")
  }

  return {
    path,
    plugin: externalModule.loadExternalPlugin(),
  }
}

const hostContext: ExternalPluginContext = {
  appName: "solid-external-plugin-demo",
  version: "1.0.0",
}

function nextStatusbarMode(mode: SlotMode): SlotMode {
  if (mode === "append") {
    return "replace"
  }

  if (mode === "replace") {
    return "single_winner"
  }

  return "append"
}

export default function ExternalPluginSlotsDemo() {
  const renderer = useRenderer()
  const registry = createSlotRegistry<JSX.Element, ExternalPluginSlots, ExternalPluginContext>(
    renderer,
    "solid:external-plugin-demo",
    hostContext,
  )
  const AppSlot = Slot<ExternalPluginSlots, ExternalPluginContext>

  const [statusbarMode, setStatusbarMode] = createSignal<SlotMode>("append")
  const [pluginEnabled, setPluginEnabled] = createSignal(true)
  const [reloadNonce, setReloadNonce] = createSignal(0)
  const [loadedPluginPath, setLoadedPluginPath] = createSignal("(not loaded yet)")
  const [lastPluginId, setLastPluginId] = createSignal("(none)")
  const [lastLoadError, setLastLoadError] = createSignal<string | null>(null)

  onMount(() => {
    renderer.setBackgroundColor("#000000")
  })

  const unsubscribePluginErrors = registry.onPluginError((event) => {
    setLastLoadError(`${event.phase}: ${event.error.message}`)
  })
  onCleanup(unsubscribePluginErrors)

  createEffect(
    on(
      [pluginEnabled, reloadNonce],
      ([currentPluginEnabled, currentReloadNonce]) => {
        let cleanedUp = false
        let unregisterPlugin: (() => void) | null = null

        if (!currentPluginEnabled) {
          setLastPluginId("(disabled)")
          setLastLoadError(null)
          return
        }

        setLastLoadError(null)

        void (async () => {
          try {
            const { path, plugin } = await loadExternalPluginFromDisk(currentReloadNonce)
            if (cleanedUp) {
              return
            }

            const unregister = registry.register(plugin)
            unregisterPlugin = () => {
              unregister()
            }

            setLoadedPluginPath(path)
            setLastPluginId(plugin.id)
            setLastLoadError(null)
          } catch (error) {
            const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            setLastPluginId("(load failed)")
            setLastLoadError(message)
          }
        })()

        onCleanup(() => {
          cleanedUp = true
          if (unregisterPlugin) {
            unregisterPlugin()
            unregisterPlugin = null
          }
        })
      },
      { defer: false },
    ),
  )

  useKeyboard((key) => {
    switch (key.name) {
      case "m":
        setStatusbarMode((current) => nextStatusbarMode(current))
        return
      case "p":
        setPluginEnabled((current) => !current)
        return
      case "r":
        setReloadNonce((current) => current + 1)
        return
      case "c":
        if (key.ctrl) {
          key.preventDefault()
          renderer.destroy()
        }
        return
    }
  })

  const info = createMemo(() => {
    return [
      "Solid External Plugin Slot Demo",
      "",
      `External plugin env override: ${EXTERNAL_PLUGIN_PATH_ENV}`,
      `External plugin resolved path: ${loadedPluginPath()}`,
      `Last loaded plugin id: ${lastPluginId()}`,
      `Last plugin load error: ${lastLoadError() ?? "(none)"}`,
      "",
      `Plugin enabled: ${pluginEnabled() ? "ON" : "OFF"} (press p)`,
      `Statusbar mode: ${statusbarMode().toUpperCase()} (press m to cycle)`,
      "Press r to reload external plugin from disk and re-register.",
      "",
      `Statusbar slot label: ${STATUSBAR_LABEL}`,
      `Sidebar slot section: ${SIDEBAR_SECTION}`,
      "",
      "The plugin renders external JSX components for both slots.",
    ].join("\n")
  })

  return (
    <box width="100%" height="100%" flexDirection="column" padding={1} backgroundColor="#020617">
      <box
        height={5}
        width="100%"
        border
        borderStyle="single"
        borderColor="#334155"
        alignItems="center"
        flexDirection="row"
        paddingLeft={1}
        marginBottom={1}
      >
        <Show when={statusbarMode()} keyed>
          {(currentMode: SlotMode) => (
            <AppSlot registry={registry} name="statusbar" label={STATUSBAR_LABEL} mode={currentMode}>
              <text fg="#94a3b8">Fallback statusbar content</text>
            </AppSlot>
          )}
        </Show>
      </box>

      <box width="100%" flexGrow={1} flexDirection="row">
        <box
          width={44}
          border
          borderStyle="single"
          borderColor="#334155"
          flexDirection="column"
          padding={1}
          marginRight={1}
        >
          <AppSlot registry={registry} name="sidebar" section={SIDEBAR_SECTION} mode="replace">
            <text fg="#94a3b8">No external sidebar plugin loaded</text>
          </AppSlot>
        </box>

        <box flexGrow={1} border borderStyle="single" borderColor="#334155" flexDirection="column" padding={1}>
          <text fg="#e2e8f0" content={info()} />
        </box>
      </box>
    </box>
  )
}
