import type { EventData, KeymapEvent } from "../types.js"
import type { ActivationService } from "./activation.js"
import type { NotificationService } from "./notify.js"
import type { State } from "./state.js"

export interface RuntimeService<TTarget extends object, TEvent extends KeymapEvent> {
  getData(name: string): unknown
  setData(name: string, value: unknown): void
  getReadonlyData(): Readonly<EventData>
}

export function createRuntimeService<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  notify: NotificationService<TTarget, TEvent>,
  activation: ActivationService<TTarget, TEvent>,
): RuntimeService<TTarget, TEvent> {
  return {
    getData(name) {
      return state.data[name]
    },
    setData(name, value) {
      notify.runWithStateChangeBatch(() => {
        if (value === undefined) {
          if (!(name in state.data)) {
            return
          }

          delete state.data[name]
          state.dataVersion += 1
          activation.ensureValidPendingSequence()
          notify.queueStateChange()
          return
        }

        if (Object.is(state.data[name], value)) {
          return
        }

        state.data[name] = value
        state.dataVersion += 1
        activation.ensureValidPendingSequence()
        notify.queueStateChange()
      })
    },
    getReadonlyData() {
      if (state.readonlyDataVersion === state.dataVersion) {
        return state.readonlyData
      }

      state.readonlyData = Object.freeze({ ...state.data })
      state.readonlyDataVersion = state.dataVersion
      return state.readonlyData
    },
  }
}
