import { postWorkerMessage, setWorkerMessageHandler } from "./worker.js"

postWorkerMessage({ type: "IMPORT_STARTED" })

await new Promise((resolve) => setTimeout(resolve, 50))

setWorkerMessageHandler<number>((event) => {
  postWorkerMessage({ type: "RECEIVED", value: event.data })
})
