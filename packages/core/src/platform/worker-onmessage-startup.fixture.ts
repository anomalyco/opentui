import { postWorkerMessage } from "./worker.js"

postWorkerMessage({ type: "WAITING_FOR_MESSAGE" })

await new Promise<void>((resolve) => {
  ;(globalThis as unknown as { onmessage?: (event: { data: number }) => void }).onmessage = (event) => {
    postWorkerMessage({ type: "RECEIVED", value: event.data })
    resolve()
  }
})
