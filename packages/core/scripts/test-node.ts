import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { requireNode26 } from "../../../scripts/node26.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..")
const workspaceRoot = resolve(packageRoot, "..", "..")
const outDir = resolve(packageRoot, ".node-test")
const treeSitterStyledTextDataPath = resolve(tmpdir(), "tree-sitter-styled-text-test")
const treeSitterCacheTestDataPath = resolve(tmpdir(), "tree-sitter-cache-test")
const treeSitterDefaultDataPath = resolve(tmpdir(), "tree-sitter-default-node-test")
const treeSitterMarkdownRenderableTestDataPath = resolve(tmpdir(), "tree-sitter-markdown-renderable-test-data")
const textBufferTestDataPath = resolve(tmpdir(), "text-buffer-node-test")
const treeSitterClientTestDataPaths = [
  "tree-sitter-shared-test-data",
  "tree-sitter-injections-test-data",
  "tree-sitter-conceal-test-data",
  "tree-sitter-edge-case-test-data",
  "tree-sitter-reactive-data-path-test",
].map((name) => resolve(tmpdir(), name))
const treeSitterTestDataPaths = [
  treeSitterStyledTextDataPath,
  treeSitterCacheTestDataPath,
  treeSitterDefaultDataPath,
  treeSitterMarkdownRenderableTestDataPath,
  textBufferTestDataPath,
  ...treeSitterClientTestDataPaths,
]
const treeSitterCacheTestAddress = "127.0.0.1:55231"
const treeSitterAssetsDir = "src/lib/tree-sitter/assets"
const nodeTestTimeoutMs = 30_000
const nodeProcessTimeoutMs = 10 * 60_000
const nodePath = requireNode26()
const emittedAllowlist = [
  ".node-test/src/platform/ffi.test.js",
  ".node-test/src/platform/runtime.test.js",
  ".node-test/src/platform/worker.node-test.js",
  ".node-test/src/lib/bunfs.test.js",
  ".node-test/src/lib/border.test.js",
  ".node-test/src/lib/clipboard.test.js",
  ".node-test/src/lib/extmarks.test.js",
  ".node-test/src/lib/detect-links.test.js",
  ".node-test/src/lib/extmarks-multiwidth.test.js",
  ".node-test/src/lib/KeyHandler.test.js",
  ".node-test/src/lib/keybinding.internal.test.js",
  ".node-test/src/lib/KeyHandler.integration.test.js",
  ".node-test/src/lib/parse.keypress-kitty.protocol.test.js",
  ".node-test/src/lib/parse.keypress-kitty.test.js",
  ".node-test/src/lib/parse.mouse.test.js",
  ".node-test/src/lib/RGBA.test.js",
  ".node-test/src/lib/tree-sitter/resolve-ft.test.js",
  ".node-test/src/tests/renderer.kitty-flags.test.js",
  ".node-test/src/buffer.test.js",
  ".node-test/src/tests/renderer.idle.test.js",
  ".node-test/src/tests/renderer.notifications.test.js",
  ".node-test/src/tests/renderer.selection.test.js",
  ".node-test/src/console.test.js",
  ".node-test/src/renderables/Box.test.js",
  ".node-test/src/renderables/Code.test.js",
  ".node-test/src/renderables/Diff.regression.test.js",
  ".node-test/src/renderables/Diff.test.js",
  ".node-test/src/renderables/EditBufferRenderable.test.js",
  ".node-test/src/renderables/Input.test.js",
  ".node-test/src/renderables/Select.test.js",
  ".node-test/src/renderables/Slider.test.js",
  ".node-test/src/renderables/TabSelect.test.js",
  ".node-test/src/renderables/__tests__/Code.test.js",
  ".node-test/src/renderables/__tests__/LineNumberRenderable.scrollbox-simple.test.js",
  ".node-test/src/renderables/__tests__/LineNumberRenderable.scrollbox.test.js",
  ".node-test/src/renderables/__tests__/LineNumberRenderable.test.js",
  ".node-test/src/renderables/__tests__/LineNumberRenderable.wrapping.test.js",
  ".node-test/src/renderables/__tests__/Markdown.code-colors.test.js",
  ".node-test/src/renderables/__tests__/Markdown.test.js",
  ".node-test/src/renderables/__tests__/MultiRenderable.selection.test.js",
  ".node-test/src/renderables/__tests__/Textarea.buffer.test.js",
  ".node-test/src/renderables/__tests__/Textarea.destroyed-events.test.js",
  ".node-test/src/renderables/__tests__/Textarea.editing.test.js",
  ".node-test/src/renderables/__tests__/Textarea.error-handling.test.js",
  ".node-test/src/renderables/__tests__/Textarea.events.test.js",
  ".node-test/src/renderables/__tests__/Textarea.highlights.test.js",
  ".node-test/src/renderables/__tests__/Textarea.keybinding.test.js",
  ".node-test/src/renderables/__tests__/Textarea.paste.test.js",
  ".node-test/src/renderables/__tests__/Textarea.rendering.test.js",
  ".node-test/src/renderables/__tests__/Textarea.scroll.test.js",
  ".node-test/src/renderables/__tests__/Textarea.selection.test.js",
  ".node-test/src/renderables/__tests__/Textarea.stress.test.js",
  ".node-test/src/renderables/__tests__/Textarea.undo-redo.test.js",
  ".node-test/src/renderables/__tests__/Textarea.visual-lines.test.js",
  ".node-test/src/renderables/Text.test.js",
  ".node-test/src/renderables/Text.selection-buffer.test.js",
  ".node-test/src/renderables/TextTable.test.js",
  ".node-test/src/animation/Timeline.test.js",
  ".node-test/src/edit-buffer.test.js",
  ".node-test/src/editor-view.test.js",
  ".node-test/src/lib/data-paths.test.js",
  ".node-test/src/lib/env.test.js",
  ".node-test/src/lib/KeyHandler.stopPropagation.test.js",
  ".node-test/src/lib/objects-in-viewport.test.js",
  ".node-test/src/lib/parse.keypress.test.js",
  ".node-test/src/lib/renderable.validations.test.js",
  ".node-test/src/lib/stdin-parser.test.js",
  ".node-test/src/lib/terminal-capability-detection.test.js",
  ".node-test/src/lib/terminal-palette.test.js",
  ".node-test/src/lib/tree-sitter/cache.test.js",
  ".node-test/src/lib/tree-sitter/client.test.js",
  ".node-test/src/lib/tree-sitter-styled-text.test.js",
  ".node-test/src/lib/yoga.options.test.js",
  ".node-test/src/renderables/__tests__/markdown-parser.test.js",
  ".node-test/src/renderables/TextNode.test.js",
  ".node-test/src/syntax-style.test.js",
  ".node-test/src/testing/capture-spans.test.js",
  ".node-test/src/testing/test-recorder.test.js",
  ".node-test/src/testing/integration.test.js",
  ".node-test/src/testing/mock-keys.test.js",
  ".node-test/src/testing/mock-mouse.test.js",
  ".node-test/src/tests/absolute-positioning.snapshot.test.js",
  ".node-test/src/tests/renderable.snapshot.test.js",
  ".node-test/src/tests/allocator-stats.test.js",
  ".node-test/src/tests/audio.test.js",
  ".node-test/src/tests/destroy-on-exit.test.js",
  ".node-test/src/tests/destroy-during-render.test.js",
  ".node-test/src/tests/hover-cursor.test.js",
  ".node-test/src/tests/native-span-feed-async.test.js",
  ".node-test/src/tests/native-span-feed-close.test.js",
  ".node-test/src/tests/native-span-feed-coverage.test.js",
  ".node-test/src/tests/native-span-feed-edge-cases.test.js",
  ".node-test/src/tests/opacity.test.js",
  ".node-test/src/tests/native-span-feed-use-after-free.test.js",
  ".node-test/src/tests/renderable.test.js",
  ".node-test/src/tests/renderer.clock.test.js",
  ".node-test/src/tests/renderer.console-startup.test.js",
  ".node-test/src/tests/renderer.control.test.js",
  ".node-test/src/tests/renderer.core-slot-binding.test.js",
  ".node-test/src/tests/renderer.cursor.test.js",
  ".node-test/src/tests/renderer.destroy-during-render.test.js",
  ".node-test/src/tests/renderer.focus.test.js",
  ".node-test/src/tests/renderer.focus-restore.test.js",
  ".node-test/src/tests/renderer.input.test.js",
  ".node-test/src/tests/renderer.mouse.test.js",
  ".node-test/src/tests/renderer.palette.test.js",
  ".node-test/src/tests/renderer.scrollback-surface.test.js",
  ".node-test/src/tests/renderer.slot-registry.test.js",
  ".node-test/src/tests/renderer.useMouse.test.js",
  ".node-test/src/tests/scrollbox.test.js",
  ".node-test/src/tests/scrollbox-culling-bug.test.js",
  ".node-test/src/tests/scrollbox-hitgrid-resize.test.js",
  ".node-test/src/tests/scrollbox-hitgrid.test.js",
  ".node-test/src/tests/yoga-setters.test.js",
  ".node-test/src/tests/wrap-resize-perf.test.js",
  ".node-test/src/text-buffer.test.js",
  ".node-test/src/text-buffer-view.test.js",
]

let exitCode = 0

try {
  rmSync(outDir, { recursive: true, force: true })

  exitCode = run(process.execPath, ["x", "tsc", "-p", "tsconfig.node-test.json"])

  if (exitCode === 0) {
    cpSync(resolve(packageRoot, treeSitterAssetsDir), resolve(outDir, treeSitterAssetsDir), { recursive: true })
    for (const dataPath of treeSitterTestDataPaths) {
      mkdirSync(dataPath, { recursive: true })
    }

    exitCode = run(
      nodePath,
      [
        "--disable-warning=SecurityWarning",
        "--disable-warning=ExperimentalWarning",
        "--permission",
        `--allow-fs-read=${workspaceRoot}`,
        ...treeSitterTestDataPaths.map((path) => `--allow-fs-read=${path}`),
        ...treeSitterTestDataPaths.map((path) => `--allow-fs-write=${path}`),
        `--allow-net=${treeSitterCacheTestAddress}`,
        "--allow-child-process",
        "--allow-worker",
        "--allow-ffi",
        "--experimental-ffi",
        "--import",
        "./scripts/test-node-hook.mjs",
        "--test-concurrency=1",
        `--test-timeout=${nodeTestTimeoutMs}`,
        "--test",
        ...emittedAllowlist,
      ],
      {
        env: {
          ...process.env,
          OTUI_TEXT_BUFFER_TEST_TMPDIR: textBufferTestDataPath,
          XDG_DATA_HOME: treeSitterDefaultDataPath,
        },
        timeout: nodeProcessTimeoutMs,
      },
    )
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

process.exit(exitCode)

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): number {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
    timeout: options.timeout,
  })

  if (result.error) {
    if (result.error.name === "TimeoutError") {
      console.error(`Command timed out after ${options.timeout}ms: ${command} ${args.join(" ")}`)
    }

    throw result.error
  }

  return result.status ?? 1
}
