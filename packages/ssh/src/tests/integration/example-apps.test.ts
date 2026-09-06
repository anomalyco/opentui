import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { Client, type ClientChannel } from "ssh2"
import { createHarness, HOST_KEY, waitFor } from "../support.js"
import { createTerminal } from "../terminal.js"

const { tmpDir } = createHarness()

for (const example of ["imperative.ts", "react.tsx", "solid.tsx"] as const) {
  test(`SSH ${example} entrypoint mounts, updates, isolates sessions, and restores on quit/shutdown`, async () => {
    let port: number | undefined
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        `${import.meta.dir}/example-apps.fixture.ts`,
        `${import.meta.dir}/../../../examples/${example}`,
      ],
      {
        cwd: tmpDir("opentui-ssh-example-"),
        env: { ...process.env, PORT: "0" },
        stdout: "ignore",
        stderr: "pipe",
        ipc(message: { port: number }) {
          port = message.port
        },
      },
    )
    const stderr = new Response(child.stderr).text()
    const terminals: Awaited<ReturnType<typeof createTerminal>>[] = []
    const clients: Client[] = []
    const connect = async (username: string) => {
      const client = new Client()
      clients.push(client)
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.on("ready", () => {
          client.shell({ term: "xterm-256color", cols: 100, rows: 30 }, (error, channel) =>
            error ? reject(error) : resolve(channel),
          )
        })
        client.on("error", reject)
        client.connect({ host: "127.0.0.1", port: port!, username, privateKey: HOST_KEY })
      })
      let output = ""
      let closed = false
      let exitCode: number | undefined
      stream.on("close", () => {
        closed = true
      })
      stream.on("exit", (code: number) => {
        exitCode = code
      })
      const terminal = await createTerminal(stream, 100, 30)
      terminals.push(terminal)
      stream.on("data", (bytes: Buffer) => {
        output += bytes.toString()
      })
      return { stream, terminal, output: () => output, closed: () => closed, exitCode: () => exitCode }
    }
    try {
      await waitFor(() => port !== undefined || child.exitCode !== null)
      expect(child.exitCode, child.exitCode === null ? "" : await stderr).toBeNull()
      const first = await connect("alpha")
      const second = await connect("beta")
      await first.terminal.contains("Hello, alpha!")
      await second.terminal.contains("Hello, beta!")
      expect(first.output()).not.toContain("beta")
      expect(second.output()).not.toContain("alpha")
      if (example === "react.tsx") {
        await first.terminal.contains("to recolor", RGBA.fromHex("#22c55e"))
        first.stream.write("\x1b[A")
        await first.terminal.contains("to recolor", RGBA.fromHex("#06b6d4"))
        await second.terminal.contains("to recolor", RGBA.fromHex("#22c55e"))
        first.stream.write("\x1b[B")
        await first.terminal.contains("to recolor", RGBA.fromHex("#22c55e"))
      } else if (example === "solid.tsx") {
        await first.terminal.contains("connected for 1s")
      }
      await first.terminal.resize(110, 32)
      first.stream.setWindow(32, 110, 0, 0)
      await first.terminal.contains(example === "imperative.ts" ? "110 \u00d7 32" : "Hello, alpha!")
      first.stream.write(example === "solid.tsx" ? "\x03" : "q")
      await waitFor(first.closed)
      expect(first.exitCode()).toBe(0)
      expect(first.output()).toContain("\x1b[?1049l")
      expect(first.output()).toContain("\x1b[?2004l")
      expect(second.closed()).toBe(false)
      await second.terminal.contains("Hello, beta!")
      child.kill("SIGINT")
      await waitFor(() => child.exitCode !== null)
      expect(await child.exited).toBe(0)
      await waitFor(second.closed)
      expect(second.exitCode()).toBe(0)
      expect(second.output()).toContain("\x1b[?1049l")
      expect(second.output()).toContain("\x1b[?2004l")
      expect(await stderr).toBe("")
    } finally {
      for (const client of clients) client.destroy()
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await stderr
      for (const terminal of terminals) await terminal.destroy()
    }
  }, 20_000)
}
