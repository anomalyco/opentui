import { BoxRenderable, KeyEvent, type Renderable } from "@opentui/core"
import { createOpenTuiKeymap, createDefaultOpenTuiKeymap, createOpenTuiKeymapHost } from "../opentui.js"
import * as addons from "../addons/index.js"
import {
  type ActiveKey,
  type ActiveKeyOptions,
  type BindingParser,
  type ErrorEvent,
  type EventMatchResolverContext,
  Keymap,
  type KeyMatch,
  type ReactiveMatcher,
  type WarningEvent,
} from "../index.js"
import { type TestRenderer } from "@opentui/core/testing"
import { type DiagnosticHarness } from "./diagnostic-harness.js"

export type OpenTuiKeymap = Keymap<Renderable, KeyEvent>

export interface ReactiveBoolean extends ReactiveMatcher {
  set(next: boolean): void
  readonly subscriptions: number
  readonly subscribeCalls: number
  readonly disposeCalls: number
}

export function createKeymapTestHelpers(diagnostics: DiagnosticHarness, getRenderer: () => TestRenderer) {
  function createFocusableBox(id: string): BoxRenderable {
    return new BoxRenderable(getRenderer(), {
      id,
      width: 10,
      height: 4,
      focusable: true,
    })
  }

  function getActiveKey(keymap: OpenTuiKeymap, name: string, options?: ActiveKeyOptions): ActiveKey | undefined {
    return keymap.getActiveKeys(options).find((candidate) => candidate.stroke.name === name)
  }

  function getActiveKeyNames(keymap: OpenTuiKeymap): string[] {
    return keymap
      .getActiveKeys()
      .map((candidate) => candidate.stroke.name)
      .sort()
  }

  function getParserKeymap(): OpenTuiKeymap {
    const keymap: OpenTuiKeymap = createOpenTuiKeymap(getRenderer())
    diagnostics.trackKeymap(keymap)
    addons.registerDefaultKeys(keymap)
    return keymap
  }

  function getKeymap(renderer: TestRenderer): OpenTuiKeymap {
    const keymap: OpenTuiKeymap = createDefaultOpenTuiKeymap(renderer)
    diagnostics.trackKeymap(keymap)
    return keymap
  }

  function getGraphKeymap(renderer: TestRenderer): OpenTuiKeymap {
    const keymap = new Keymap(createOpenTuiKeymapHost(renderer))
    addons.registerDefaultKeys(keymap)
    addons.registerEnabledFields(keymap)
    addons.registerMetadataFields(keymap)
    diagnostics.trackKeymap(keymap)
    return keymap
  }

  function createBareKeymap(renderer: TestRenderer): OpenTuiKeymap {
    const keymap: OpenTuiKeymap = createOpenTuiKeymap(renderer)
    diagnostics.trackKeymap(keymap)
    return keymap
  }

  function getCommand(keymap: OpenTuiKeymap, name: string) {
    return keymap.getCommands().find((candidate) => candidate.name === name)
  }

  function getCommandEntry(keymap: OpenTuiKeymap, name: string) {
    return keymap.getCommandEntries().find((candidate) => candidate.command.name === name)
  }

  function getActiveKeyDisplay(
    keymap: OpenTuiKeymap,
    display: string,
    options?: ActiveKeyOptions,
  ): ActiveKey | undefined {
    return keymap.getActiveKeys(options).find((candidate) => candidate.display === display)
  }

  function captureDiagnostics(keymap: OpenTuiKeymap): {
    warningEvents: WarningEvent[]
    errorEvents: ErrorEvent[]
    warnings: string[]
    errors: string[]
    takeWarnings: () => { warnings: string[]; warningEvents: WarningEvent[] }
    takeErrors: () => { errors: string[]; errorEvents: ErrorEvent[] }
  } {
    return diagnostics.captureDiagnostics(keymap)
  }

  function matchEventAs(ctx: EventMatchResolverContext, event: KeyEvent, name: string): KeyMatch {
    return ctx.resolveKey({
      name,
      ctrl: event.ctrl,
      shift: event.shift,
      meta: event.meta,
      super: event.super ?? false,
      hyper: event.hyper || undefined,
    })
  }

  function createBracketTokenParser(options?: { preserveDisplayCase?: boolean }): BindingParser {
    return ({ input, index, tokens, normalizeTokenName, parseObjectKey }) => {
      if (input[index] !== "[") {
        return undefined
      }

      const end = input.indexOf("]", index)
      if (end === -1) {
        throw new Error(`Invalid key sequence "${input}": unterminated token`)
      }

      const tokenName = input.slice(index + 1, end).trim()
      const normalizedTokenName = normalizeTokenName(tokenName)
      const token = tokens.get(normalizedTokenName)
      if (!token) {
        return {
          parts: [],
          nextIndex: end + 1,
          unknownTokens: [normalizedTokenName],
        }
      }

      return {
        parts: [
          parseObjectKey(token.stroke, {
            display: options?.preserveDisplayCase ? `[${tokenName}]` : `[${normalizedTokenName}]`,
            match: token.match,
            tokenName: normalizedTokenName,
          }),
        ],
        nextIndex: end + 1,
        usedTokens: [normalizedTokenName],
      }
    }
  }

  function createReactiveBoolean(initial: boolean): ReactiveBoolean {
    let current = initial
    const listeners = new Set<() => void>()
    let subscribeCalls = 0
    let disposeCalls = 0

    const matcher: ReactiveBoolean = {
      get() {
        return current
      },
      subscribe(onChange) {
        subscribeCalls += 1
        listeners.add(onChange)
        return () => {
          disposeCalls += 1
          listeners.delete(onChange)
        }
      },
      set(next) {
        if (current === next) {
          return
        }
        current = next
        for (const fn of listeners) {
          fn()
        }
      },
      get subscriptions() {
        return listeners.size
      },
      get subscribeCalls() {
        return subscribeCalls
      },
      get disposeCalls() {
        return disposeCalls
      },
    }

    return matcher
  }

  return {
    createFocusableBox,
    getActiveKey,
    getActiveKeyNames,
    getParserKeymap,
    getKeymap,
    getGraphKeymap,
    createBareKeymap,
    getCommand,
    getCommandEntry,
    getActiveKeyDisplay,
    captureDiagnostics,
    matchEventAs,
    createBracketTokenParser,
    createReactiveBoolean,
  }
}
