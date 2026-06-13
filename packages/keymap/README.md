# @opentui/keymap

A host-agnostic keymap engine for terminal and DOM apps. Same core, multiple adapters.

It models keybindings as priority-ordered, focus-scoped layers attached to targets (terminal renderables or DOM elements). The core is intentionally bare; everything beyond raw key dispatch is opt-in via addons, parsers, expanders, resolvers, and field compilers.

## Highlights

- **Host-agnostic core** over a small `KeymapHost` interface with host metadata, focus, parent traversal, target destruction, key press/release, optional raw input, and synthetic command events.
- **Target-aware focus routing** for global layers plus local `focus` / `focus-within` layers that follow the active target's parent chain.
- **Layered bindings** with priority ordering, newest-first ties, `fallthrough`, and `preventDefault` control.
- **Branch-aware multi-key sequences** over flat compiled bindings, with a public pending-sequence API, synchronous `pendingSequence` events, active continuation queries, and automatic invalidation on focus changes.
- **Programmable exact-vs-prefix disambiguation** (e.g. `g` vs `gg`) with `runExact`, `continueSequence`, `clear`, and deferred `AbortSignal` + `sleep` decisions. Ships a Neovim-style timeout resolver.
- **Pluggable binding language**: stackable binding parsers, key expanders, layer-binding transformers, binding transformers, command resolvers, command transformers, and ordered event-match resolvers.
- **Extensible schema and activation**: register custom fields on layers, bindings, and commands. Field compilers can emit `attrs`; all field kinds can gate activation via `require(...)` and `activeWhen(matcher)`.
- **Reactive matchers** with subscription-driven state notifications, plus React store and Solid signal helpers.
- **Raw and key intercepts** before and after normal binding dispatch, including pre-binding `consume({ preventDefault, stopPropagation })`, post-dispatch handled/no-match outcomes, and raw input `stop()` handling.
- **Command catalog and dispatch** with named commands, inline command handlers, command chains, namespaces, search, visibility tiers (`registered` / `reachable` / `active`), binding queries, `runCommand`, and focus-aware `dispatchCommand`.
- **Opt-in graph snapshots and diagnostics** for layers, commands, bindings, sequence nodes, pending paths, inactive reasons, shadowing, stable warning/error codes, and lint-style layer analyzers.
- **Broad key coverage** in the default parser, including function keys, navigation/editing keys, numpad keys, media keys, left/right modifiers, `super`, `hyper`, and literal `+` bindings.
- **Platform-aware modifier aliases** via `registerModBindings`, resolving `mod+...` from host metadata while preserving display strings.

## Addons

`@opentui/keymap/addons` ships ready-made building blocks:

- `registerDefaultKeys` — `ctrl+shift+s` style parser and event matching.
- `registerLeader`, `registerTimedLeader` — leader tokens with optional timeout.
- `registerEmacsBindings` — `ctrl+x ctrl+s` chords.
- `registerExCommands` — `:write`-style commands with `aliases` and `nargs`.
- `registerCommaBindings`, `registerModBindings`, `registerAliasesField`, `registerBindingOverrides`.
- `registerEnabledFields`, `registerMetadataFields` (`desc`, `group`, `title`, `category`).
- `registerNeovimDisambiguation`, `registerEscapeClearsPendingSequence`, `registerBackspacePopsPendingSequence`.
- `registerDeadBindingWarnings`, `registerUnresolvedCommandWarnings`.

`@opentui/keymap/addons/opentui` adds OpenTUI-specific pieces: layout-independent matching via `event.baseCode`, and pre-wired textarea / edit-buffer commands. Direct event matches win before fallback matches, even across layers.

## Entry Points

- `@opentui/keymap` — core API
- `@opentui/keymap/addons` — universal addons
- `@opentui/keymap/addons/opentui` — universal + OpenTUI addons
- `@opentui/keymap/extras/graph` — graph snapshot helpers for debug and graph UIs
- `@opentui/keymap/testing` — host-agnostic fake keymap host and diagnostics for addon tests
- `@opentui/keymap/html` — HTML adapter
- `@opentui/keymap/opentui` — OpenTUI adapter
- `@opentui/keymap/react` — `KeymapProvider`, `useKeymap`, `useBindings`, `useActiveKeys`, `usePendingSequence`, `reactiveMatcherFromStore`
- `@opentui/keymap/solid` — `KeymapProvider`, `useKeymap`, `useKeymapSelector`, `useBindings`, `reactiveMatcherFromSignal`
- `@opentui/keymap/extras` — helpers for cheat-sheet UIs (`createBindingLookup`, `commandBindings`, `formatCommandBindings`)

## Usage

```tsx
import { registerDefaultKeys } from "@opentui/keymap/addons"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"

const keymap = createOpenTuiKeymap(renderer)
registerDefaultKeys(keymap)

createRoot(renderer).render(
  <KeymapProvider keymap={keymap}>
    <App />
  </KeymapProvider>,
)
```

Create a keymap, install the addons you want, then pass the configured instance to your app. The React and Solid entrypoints consume a pre-created OpenTUI keymap through context.

`Keymap` is the core runtime. Pass feature factories to its constructor when you need graph snapshots or layer analyzers.

## Adapters

Adapters implement a small `KeymapHost` interface (`metadata`, `rootTarget`, `getFocusedTarget`, `getParentTarget`, `onKeyPress`, `onKeyRelease`, `onFocusChange`, `onTargetDestroy`, ...). The HTML adapter normalizes DOM key names (`Escape` → `escape`, `ArrowUp` → `up`, `Meta` → `super`, `Alt` → `meta`) and tracks targets via `MutationObserver`. The OpenTUI adapter hooks `CliRenderer` `keypress`, `keyrelease`, focus, destroy, target destroy, and raw input events.

## Formatting Keys

Use `keymap.formatKey` when displaying raw binding strings. It runs them through the keymap's parsers and tokens before stringifying.

```ts
keymap.formatKey("<leader>s", { separator: " " }) // "space s"
keymap.formatKey("<leader>s", { preferDisplay: true }) // "<leader>s"
```

## Re-entry

Runtime/data re-entry is supported during dispatch: command handlers, intercepts, and pending-sequence listeners may read or write runtime data and pending-sequence state.

Structural re-entry is **not** supported. Do not register or unregister layers, tokens, parsers, or resolvers while a dispatch is in flight.

## Installation

```bash
bun install @opentui/keymap
```

## Development

```bash
bun run build
bun run test
bun src/keymap-benchmark.ts
```

The HTML demo lives in the docs app at `/demos/keymap-html/` under `packages/web`.
