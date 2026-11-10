import type { Keymap } from "../keymap.js"
import type {
  BindingCommand,
  Command,
  CommandContext,
  CommandHandler,
  CommandResult,
  BindingState,
  KeymapEvent,
  RegisteredLayer,
  RunCommandOptions,
  RunCommandResult,
} from "../types.js"
import { normalizeBindingCommand } from "./primitives/command-normalization.js"
import type { CommandCatalogService } from "./command-catalog.js"
import type { ActivationService } from "./activation.js"
import type { NotificationService } from "./notify.js"
import type { RuntimeService } from "./runtime.js"
import { isPromiseLike } from "./values.js"

interface CommandExecutionResult<TTarget extends object, TEvent extends KeymapEvent> {
  status: "handled" | "rejected" | "error"
  result: RunCommandResult<TTarget, TEvent>
}

interface CommandExecutorOptions<TTarget extends object, TEvent extends KeymapEvent> {
  keymap: Keymap<TTarget, TEvent>
  createCommandEvent: () => TEvent
}

export interface CommandExecutorService<TTarget extends object, TEvent extends KeymapEvent> {
  runCommand(cmd: string, options?: RunCommandOptions<TTarget, TEvent>): RunCommandResult<TTarget, TEvent>
  dispatchCommand(cmd: string, options?: RunCommandOptions<TTarget, TEvent>): RunCommandResult<TTarget, TEvent>
  runBinding(
    bindingLayer: RegisteredLayer<TTarget, TEvent>,
    binding: BindingState<TTarget, TEvent>,
    event: TEvent,
    focused: TTarget | null,
    payload?: unknown,
  ): boolean
}

export function createCommandExecutorService<TTarget extends object, TEvent extends KeymapEvent>(
  notify: NotificationService<TTarget, TEvent>,
  runtime: RuntimeService<TTarget, TEvent>,
  activation: ActivationService<TTarget, TEvent>,
  catalog: CommandCatalogService<TTarget, TEvent>,
  options: CommandExecutorOptions<TTarget, TEvent>,
): CommandExecutorService<TTarget, TEvent> {
  const createCommandContext = (
    event: TEvent,
    focused: TTarget | null,
    target: TTarget | null,
    data: Readonly<Record<string, unknown>>,
    input: string,
    payload: unknown,
  ): CommandContext<TTarget, TEvent> => {
    return {
      keymap: options.keymap,
      event,
      focused,
      target,
      data,
      input,
      payload,
    }
  }

  const executeResolvedCommand = (
    commandName: string,
    command: Command<TTarget, TEvent> | CommandHandler<TTarget, TEvent>,
    context: CommandContext<TTarget, TEvent>,
    includeCommand: boolean,
  ): CommandExecutionResult<TTarget, TEvent> => {
    const commandView = typeof command === "function" ? undefined : command
    const run = typeof command === "function" ? command : command.run
    const resultCommand = includeCommand ? commandView : undefined
    let result: CommandResult<TTarget, TEvent>

    try {
      result = run(commandView ? { ...context, command: commandView } : context)
    } catch (error) {
      notify.emitError("command-execution-error", error, `[Keymap] Error running command "${commandName}":`)
      return {
        status: "error",
        result: resultCommand ? { ok: false, reason: "error", command: resultCommand } : { ok: false, reason: "error" },
      }
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        notify.emitError("async-command-error", error, `[Keymap] Async error in command "${commandName}":`)
      })

      return {
        status: "handled",
        result: resultCommand ? { ok: true, command: resultCommand } : { ok: true },
      }
    }

    if (isRunCommandResult(result)) {
      let commandResult: RunCommandResult<TTarget, TEvent> = result
      if (!result.ok && result.reason !== "not-found" && includeCommand && commandView && !result.command) {
        commandResult = { ...result, command: commandView }
      } else if (result.ok && includeCommand && commandView && !result.command) {
        commandResult = { ...result, command: commandView }
      }

      return {
        status: result.ok ? "handled" : "rejected",
        result: commandResult,
      }
    }

    if (result === false) {
      return {
        status: "rejected",
        result: resultCommand
          ? { ok: false, reason: "rejected", command: resultCommand }
          : { ok: false, reason: "rejected" },
      }
    }

    return {
      status: "handled",
      result: resultCommand ? { ok: true, command: resultCommand } : { ok: true },
    }
  }

  const executeCommandChain = (
    commandName: string,
    chain: readonly { target?: TTarget; command: Command<TTarget, TEvent> }[] | undefined,
    event: TEvent,
    focused: TTarget | null,
    target: TTarget | null | undefined,
    data: Readonly<Record<string, unknown>>,
    payload: unknown,
    includeCommand: boolean,
  ): [RunCommandResult<TTarget, TEvent> | undefined, RunCommandResult<TTarget, TEvent> | undefined] => {
    let rejected: RunCommandResult<TTarget, TEvent> | undefined
    for (const entry of chain ?? []) {
      const executed = executeResolvedCommand(
        commandName,
        entry.command,
        createCommandContext(event, focused, target ?? entry.target ?? null, data, commandName, payload),
        includeCommand,
      )

      if (executed.status === "handled" || executed.status === "error") {
        return [executed.result, rejected]
      }

      rejected = executed.result
    }

    return [undefined, rejected]
  }

  const executeProgrammaticCommand = (
    cmd: string,
    commandOptions: RunCommandOptions<TTarget, TEvent> | undefined,
    mode: "registered" | "active",
  ): RunCommandResult<TTarget, TEvent> => {
    let normalized: BindingCommand<TTarget, TEvent> | undefined

    try {
      normalized = normalizeBindingCommand(cmd)
    } catch {
      return { ok: false, reason: "invalid-args" }
    }

    if (typeof normalized !== "string") {
      return { ok: false, reason: "not-found" }
    }

    const includeCommand = commandOptions?.includeCommand === true
    const focused = commandOptions?.focused ?? activation.getFocusedTargetIfAvailable()
    const event = commandOptions?.event ?? options.createCommandEvent()
    const data = runtime.getReadonlyData()
    const payload = commandOptions?.payload
    const chain =
      mode === "registered"
        ? catalog.getRegisteredResolvedEntries(normalized)
        : catalog.getActiveRegisteredResolvedEntries(normalized, focused)
    const [done, rejected] = executeCommandChain(
      normalized,
      chain,
      event,
      focused,
      commandOptions?.target,
      data,
      payload,
      includeCommand,
    )
    if (done) {
      return done
    }

    let rejectedResult = rejected
    const fallback =
      mode === "registered"
        ? catalog.resolveRegisteredResolverFallback(normalized, { input: normalized, payload })
        : catalog.resolveActiveResolverFallback(normalized, focused, { input: normalized, payload })
    if (fallback.resolved) {
      const result = executeResolvedCommand(
        normalized,
        fallback.resolved.command,
        createCommandContext(
          event,
          focused,
          commandOptions?.target ?? fallback.resolved.target ?? null,
          data,
          fallback.resolved.input ?? normalized,
          fallback.resolved.payload,
        ),
        includeCommand,
      )

      if (result.status === "handled" || result.status === "error") {
        return result.result
      }

      rejectedResult = result.result
    }

    if (fallback.hadError) {
      return { ok: false, reason: "error" }
    }

    if (mode === "active") {
      const unavailable = catalog.getDispatchUnavailableCommandState(normalized, focused, includeCommand)
      if (unavailable) {
        return unavailable.command
          ? { ok: false, reason: unavailable.reason, command: unavailable.command }
          : { ok: false, reason: unavailable.reason }
      }
    }

    return rejectedResult ?? { ok: false, reason: "not-found" }
  }

  return {
    runCommand(cmd, commandOptions) {
      return executeProgrammaticCommand(cmd, commandOptions, "registered")
    },
    dispatchCommand(cmd, commandOptions) {
      return executeProgrammaticCommand(cmd, commandOptions, "active")
    },
    runBinding(bindingLayer, binding, event, focused, payload) {
      const data = runtime.getReadonlyData()

      if (binding.run) {
        const result = executeResolvedCommand(
          typeof binding.command === "string" ? binding.command : "<function>",
          binding.run,
          createCommandContext(
            event,
            focused,
            bindingLayer.target ?? null,
            data,
            typeof binding.command === "string" ? binding.command : "<function>",
            payload,
          ),
          false,
        )

        if (result.status === "rejected") {
          return false
        }

        applyBindingEventEffects(binding, event)
        return true
      }

      if (typeof binding.command !== "string") {
        return false
      }

      const chain = catalog.getResolvedCommandChain(
        binding.command,
        focused,
        payload === undefined ? undefined : { input: binding.command, payload },
      ).entries
      for (const entry of chain ?? []) {
        const result = executeResolvedCommand(
          binding.command,
          entry.command,
          createCommandContext(
            event,
            focused,
            entry.target ?? bindingLayer.target ?? null,
            data,
            entry.input ?? binding.command,
            entry.payload,
          ),
          false,
        )
        if (result.status === "rejected") {
          continue
        }

        applyBindingEventEffects(binding, event)
        return true
      }

      return false
    },
  }
}

function isRunCommandResult<TTarget extends object, TEvent extends KeymapEvent>(
  value: CommandResult<TTarget, TEvent>,
): value is RunCommandResult<TTarget, TEvent> {
  return typeof value === "object" && value !== null && "ok" in value
}

function applyBindingEventEffects<TTarget extends object, TEvent extends KeymapEvent>(
  binding: BindingState<TTarget, TEvent>,
  event: TEvent,
): void {
  if (!binding.preventDefault) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
}
