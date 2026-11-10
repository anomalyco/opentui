import { afterEach, expect, test } from "bun:test"
import { Client, Server as Ssh2Server } from "ssh2"
import type { Connection } from "ssh2"
import { deferred, HOST_KEY } from "../support.js"

/**
 * `closeAll` (connection.ts) force-destroys sockets via ssh2's private `_sock`
 * because `client.end()` alone leaves `Server.close()` hanging on a vanished
 * peer. That field is undocumented, so an ssh2 rename would turn the
 * optional-chained call into a silent no-op and bring the hang back — this
 * asserts the shape it depends on still exists.
 */

let server: Ssh2Server | undefined

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

test("ssh2 Connection still exposes a destroyable `_sock` (closeAll's shutdown internal)", async () => {
  const captured = deferred<Connection>()
  server = new Ssh2Server({ hostKeys: [HOST_KEY] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept())
    client.on("error", () => {}) // a torn-down socket emits ECONNRESET; ignore
    captured.resolve(client)
  })
  const srv = server

  const port = await new Promise<number>((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      resolve(typeof addr === "object" && addr ? addr.port : 0)
    })
  })

  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.on("ready", resolve).on("error", reject).connect({ host: "127.0.0.1", port, username: "guest" })
  })

  const serverSide = await captured.promise
  const sock = (serverSide as unknown as { _sock?: { destroy?: unknown } })._sock

  expect(
    sock,
    "ssh2 Connection._sock is gone — closeAll() can no longer force sockets shut (connection.ts)",
  ).toBeDefined()
  expect(
    typeof sock?.destroy,
    "ssh2 Connection._sock.destroy is no longer a function — closeAll()'s force-close is a silent no-op (connection.ts)",
  ).toBe("function")

  client.end()
})
