import { existsSync } from "node:fs"
import { resolveHostKey } from "../../keys.js"

const [, , path, barrier] = process.argv
if (!path || !barrier) throw new Error("expected host-key and barrier paths")

while (!existsSync(barrier)) await Bun.sleep(1)
const result = resolveHostKey({ hostKey: { path } })
process.stdout.write(JSON.stringify({ fingerprint: result.fingerprints[0] }))
