import { postWorkerMessage } from "../platform/worker.js"
import { resolveRenderLib } from "../zig.js"

resolveRenderLib()
postWorkerMessage("ready")
