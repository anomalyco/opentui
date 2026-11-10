# Keymap engine (`opentui::keymap`)

`opentui::keymap` ports OpenTUI's `@opentui/keymap` (`packages/keymap` in OpenTUI) to Rust: layered bindings,
named commands, multi-key sequences, tokens such as `<leader>`, and runtime conditions such as modes. It is pure
Rust. It does not call the native library and does not own an event loop: the app feeds it key events, focus, and
time, and it reports whether each key was consumed.

The first user is OpenCode's Rust TUI, which needs the behavior of `packages/tui/src/context/keymap.tsx` in
OpenCode: 244 configurable command names with default bindings, user overrides, layers registered by
components, an input mode stack, and a timed leader key. This note maps that file's use of `@opentui/keymap` to
this module.

## Model

The Rust engine keeps the TypeScript engine's data model and dispatch rules, so key sequences resolve to the same
commands.

- A `Keymap<T>` is a cheap-to-clone handle to shared state. `T` identifies focus targets (a widget id). Commands,
  conditions, and intercepts are closures that may call back into the keymap (set data, register layers,
  dispatch a command) while a key is dispatched; the engine never holds its internal borrow across a callback.
- A `Layer<T>` has an optional `target` and `TargetMode` (`FocusWithin` by default, or `Focus`), a `priority`, an
  `enabled` condition, data requirements (`require("opencode.mode", "base")`), `bindings`, and `commands`.
  Layers sort by priority, then newest first, as in TypeScript.
- A `Binding<T>` has a key (`"ctrl+x"`, `"<leader>n"`, `"gg"`, or a `Stroke`), a command (a command name or an
  inline handler), `press` or `release`, `prevent_default` (default true), `fallthrough` (default false), and the
  metadata fields `desc` and `group`.
- A `Command<T>` has a name, a handler that returns handled or rejected, the metadata fields `title`, `desc`,
  `category`, and `namespace`, an `enabled` condition, and an opaque `data` value for the app (OpenCode keeps its
  `KeymapCommand` there, as the TypeScript client keeps it in `command.opencode`).
- A string binding command is visible only while a command of that name is reachable: registered in an active,
  enabled layer. The first reachable command of a name wins; a rejected command falls through to the next one of
  the same name.

Focus comes from the app: `set_focus(path)` takes the focused target followed by its ancestors. A focus change
clears a pending sequence, as the TypeScript host's focus event does.

Dispatch follows `services/dispatch.ts`: key intercepts by priority; then, with a pending sequence, the captures
advance and the best match wins; otherwise each layer in order either starts a sequence (a prefix collects
continuations from every lower layer too) or runs its exact bindings. Without a disambiguation resolver an
exact binding and a prefix in different layers resolve to the prefix, as in TypeScript; in one layer they are a
compile error. A key that does not continue a pending sequence clears it and is not consumed.

## API

| `@opentui/keymap`                                                                        | `opentui::keymap`                                                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `createDefaultOpenTuiKeymap(renderer)`                                                   | `Keymap::new()`: default parser, default event matcher, `enabled` and metadata fields built in              |
| `registerLayer(layer)`                                                                   | `keymap.register_layer(layer) -> Disposer`; dropping the `Disposer` unregisters, `forget()` keeps the layer |
| `registerLayerFields({ mode })` + `setData`                                              | `Layer::require(name, value)` + `keymap.set_data(name, value)`                                              |
| `registerToken`, `registerLeader`                                                        | `keymap.register_token(name, key)`, `addons::leader`                                                        |
| `appendBindingExpander`                                                                  | `keymap.append_binding_expander(f)`                                                                         |
| `appendEventMatchResolver`                                                               | `keymap.append_event_match_resolver(f)`                                                                     |
| `intercept("key", f, { priority, release })`                                             | `keymap.intercept_key(priority, release, f)`                                                                |
| host key listener                                                                        | `keymap.handle_key(&KeyEvent) -> KeyResult`                                                                 |
| host focus listener                                                                      | `keymap.set_focus(path)`                                                                                    |
| `dispatchCommand`, `runCommand`                                                          | `keymap.dispatch_command(name)`, `keymap.run_command(name)`                                                 |
| `getCommands`, `getCommandEntries`, `getCommandBindings`                                 | `commands(query)`, `command_entries(query)`, `command_bindings(visibility, names)`                          |
| `getPendingSequence`, `hasPendingSequence`, `clearPendingSequence`, `popPendingSequence` | same names in snake case                                                                                    |
| `getActiveKeys({ includeBindings, includeMetadata })`                                    | `active_keys(options)`                                                                                      |
| `createKeyMatcher`, `parseKeySequence`, `formatKey`                                      | `parse_key` (compare its `stroke`), `parse_key_sequence`, `format_key`                                      |
| `on("state")`, `on("pendingSequence")`, `on("warning" / "error")`                        | `on_state`, `on_pending_sequence`, `on_diagnostic`; `revision()` counts state changes                       |
| `stringifyKeyStroke`                                                                     | `Stroke`'s `Display`                                                                                        |
| extras `createBindingLookup`                                                             | `extras::BindingLookup`                                                                                     |
| extras `formatKeySequence`, `formatCommandBindings`                                      | `extras::format_key_sequence`, `extras::format_command_bindings`                                            |

Key events: `Stroke::from_event` maps a `opentui::input::KeyEvent` to Core's key names (`return`, `escape`,
`pageup`, Shift+letter as `shift` plus the lower-case letter, Alt or Meta as `meta`), so binding strings mean what
they mean in TypeScript.

## Addons OpenCode uses (`keymap.tsx:4-14`)

| TypeScript                                            | Rust                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerCommaBindings`                               | `addons::comma_bindings`                                                                                                                                                     |
| the alias expander (`enter`, `esc`, `pgdown`, `pgup`) | an app expander through `append_binding_expander`; `addons::key_aliases` provides it                                                                                         |
| `registerBaseLayoutFallback`                          | `addons::base_layout_fallback`, from `KeyEvent::base_layout`                                                                                                                 |
| `registerEscapeClearsPendingSequence`                 | `addons::escape_clears_pending_sequence`                                                                                                                                     |
| `registerBackspacePopsPendingSequence`                | `addons::backspace_pops_pending_sequence`                                                                                                                                    |
| `registerManagedTextareaLayer`                        | `addons::managed_textarea_layer`: the `input.*` commands and Core's default textarea bindings, with the app's overrides first; the commands call back with an `EditorAction` |
| `registerTimedLeader`                                 | `addons::timed_leader`: returns a `TimedLeader` whose `deadline()` the app schedules and whose `expire(now)` clears the leader sequence                                      |

## Not ported

OpenCode does not use these, so they are left out: sequence patterns (`{count}`), disambiguation resolvers,
command resolvers, binding, layer-bindings, and command transformers, custom binding parsers, custom field
compilers (typed fields replace them), `key:after` and raw intercepts, layer analyzers, the graph and HTML
extras, and the Solid and React adapters. Commands are synchronous, so async results and their errors do not
apply. A binding that uses an unregistered `{pattern}` is skipped with an unknown-token warning, as TypeScript
does when the pattern is missing.
