import { expect, test } from "bun:test"
import { Client } from "ssh2"
import { createHarness, SHELL_PTY } from "../support.js"

/**
 * Session behaviors beyond the renderer:
 *   - session.write(bytes) sends raw terminal control the renderer doesn't model
 *     (OSC 52 clipboard, title, bell) straight to the client.
 *   - No exec/subsystem listener is registered, so ssh2 auto-rejects the request
 *     and `ssh host somecmd` fails cleanly rather than hangs.
 */

const { mkServer, connect, conns } = createHarness()

test("session.write sends raw bytes straight to the client terminal", async () => {
  const server = mkServer((s) => {
    s.write("RAW-WRITE-OK")
  })
  const conn = await connect(server)

  const received = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no raw bytes")), 5000)
    conn.shell(SHELL_PTY, (err, stream) => {
      if (err) return reject(err)
      let buf = ""
      stream.on("data", (d: Buffer) => {
        buf += d.toString("utf8")
        if (buf.includes("RAW-WRITE-OK")) {
          clearTimeout(timer)
          resolve(buf)
        }
      })
    })
  })
  expect(received).toContain("RAW-WRITE-OK")
}, 10000)

test("exec is rejected cleanly (no command mode), never hangs the client", async () => {
  const server = mkServer(() => {})
  const conn = await connect(server)

  const result = await new Promise<string>((resolve, reject) => {
    // If exec ever hung (an accept-but-strand handler), this timer fails the test.
    const timer = setTimeout(() => reject(new Error("exec hung — never accepted or rejected")), 4000)
    conn.exec("noop", (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return resolve("rejected")
      }
      stream.on("close", () => {
        clearTimeout(timer)
        resolve("closed")
      })
    })
  })
  expect(result).toMatch(/rejected|closed/)
}, 10000)

test("a shell without pty exposes hasPty=false and default dimensions", async () => {
  let hasPty: boolean | undefined
  let cols = 0
  let rows = 0
  const server = mkServer((s) => {
    hasPty = s.hasPty
    cols = s.cols
    rows = s.rows
    s.end()
  })
  const { port } = await server.listen(0)
  const conn = new Client()
  conns.push(conn)

  await new Promise<void>((resolve, reject) => {
    conn
      .on("ready", () => {
        conn.shell(false, (err, stream) => {
          if (err) return reject(err)
          stream.on("exit", () => resolve())
          stream.on("close", () => resolve())
        })
      })
      .on("error", reject)
      .connect({ host: "127.0.0.1", port, username: "no-pty" })
  })

  expect(hasPty).toBe(false)
  expect(cols).toBe(80)
  expect(rows).toBe(24)
}, 10000)
