// Child of the stdout writer unload test: fd 1 is a pty whose output the parent stopped with XOFF. The writer
// thread blocks in write(2); the Session is cancelled and the library disposed while it is blocked.
import { writeFileSync } from "node:fs"
import { NativeSession } from "../NativeSession.js"
import { resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
const driver = new NativeSession(process.stdout, {
  output: { chunkSize: 65_536, spanCapacity: 128, maxBytes: 8_388_608n, controlCapacity: 4096 },
})
for (let part = 0; part < 4; part++) driver.write(new Uint8Array(32_768).fill(0x61 + part))
await new Promise((resolve) => setTimeout(resolve, 200))
driver.dispose()
lib.dispose()
writeFileSync(process.argv[2]!, "disposed")
// The parent resumes output now: the blocked write returns into the library, which must still be mapped.
await new Promise((resolve) => setTimeout(resolve, 500))
process.exit(0)
