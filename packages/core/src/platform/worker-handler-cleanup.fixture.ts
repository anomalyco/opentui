import { postWorkerMessage, setWorkerMessageHandler } from "./worker.js"

const cleanupFirst = setWorkerMessageHandler(() => {})
const cleanupSecond = setWorkerMessageHandler(() => {})

cleanupFirst()
cleanupSecond()

postWorkerMessage({
  type: "HANDLERS_CLEANED",
  handlerCleared: (globalThis as { onmessage?: unknown }).onmessage == null,
})
