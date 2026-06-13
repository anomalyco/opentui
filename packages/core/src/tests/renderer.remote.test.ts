import { describe, expect, test } from "bun:test"

type RendererFactory = "test" | "direct-process-memory" | "cli-custom-memory" | "cli-custom-feed"

async function getCapabilitiesFromChild(
  options: { remote?: boolean },
  env: Record<string, string>,
  factory: RendererFactory = "test",
): Promise<any> {
  const rendererUrl = new URL("../renderer.ts", import.meta.url).href
  const testRendererUrl = new URL("../testing/test-renderer.ts", import.meta.url).href
  const testStreamsUrl = new URL("../testing/test-streams.ts", import.meta.url).href
  const script = `
    import { CliRenderer, createCliRenderer } from ${JSON.stringify(rendererUrl)}
    import { createTestRenderer } from ${JSON.stringify(testRendererUrl)}
    import { createTestStdin, createTestStdout } from ${JSON.stringify(testStreamsUrl)}

    const options = ${JSON.stringify(options)}
    let renderer
    if (${JSON.stringify(factory)} === "test") {
      ;({ renderer } = await createTestRenderer(options))
    } else if (${JSON.stringify(factory)} === "direct-process-memory") {
      renderer = new CliRenderer(createTestStdin(), process.stdout, 80, 24, {
        ...options,
        bufferedOutput: "memory",
        consoleMode: "disabled",
      })
    } else if (${JSON.stringify(factory)} === "cli-custom-memory") {
      renderer = await createCliRenderer({
        ...options,
        stdin: createTestStdin(),
        stdout: createTestStdout(80, 24),
        bufferedOutput: "memory",
        consoleMode: "disabled",
      })
    } else if (${JSON.stringify(factory)} === "cli-custom-feed") {
      renderer = await createCliRenderer({
        ...options,
        stdin: createTestStdin(),
        stdout: createTestStdout(80, 24),
        consoleMode: "disabled",
      })
    } else {
      throw new Error("unknown renderer factory")
    }

    try {
      const internals = renderer
      const caps = internals.lib.getTerminalCapabilities(renderer.rendererPtr)
      process.stdout.write(JSON.stringify(caps) + "\\n")
    } finally {
      renderer.destroy()
    }
  `
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`Child renderer failed with exit ${exitCode}: ${stderr}`)
  }

  const line = stdout.trim().split(/\r?\n/).at(-1)
  if (!line) {
    throw new Error(`Child renderer did not emit capabilities: ${stderr}`)
  }
  return JSON.parse(line)
}

describe("remote detection", () => {
  test("auto remote mode detects SSH and skips default terminal env forwarding", async () => {
    const caps = await getCapabilitiesFromChild(
      {},
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        SSH_CONNECTION: "192.0.2.1 54231 192.0.2.2 22",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
      },
    )

    expect(caps.remote).toBe(true)
    expect(caps.ansi256).toBe(false)
    expect(caps.notifications).toBe(false)
    expect(caps.terminal.name).toBe("")
  })

  test("explicit local mode overrides SSH remote detection", async () => {
    const caps = await getCapabilitiesFromChild(
      { remote: false },
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        SSH_TTY: "/dev/pts/1",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
      },
    )

    expect(caps.remote).toBe(false)
    expect(caps.ansi256).toBe(true)
    expect(caps.notifications).toBe(true)
    expect(caps.terminal.name).toBe("ghostty")
  })

  test("explicit local mode detects Zellij and suppresses inherited host notification heuristics", async () => {
    const caps = await getCapabilitiesFromChild(
      { remote: false },
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        ZELLIJ: "0",
        ZELLIJ_SESSION_NAME: "test-session",
        ZELLIJ_PANE_ID: "1",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
        WT_SESSION: "outer-windows-terminal-session",
        TERM_FEATURES: "T2NoH",
      },
    )

    expect(caps.remote).toBe(false)
    expect(caps.multiplexer).toBe("zellij")
    expect(caps.notifications).toBe(false)
    expect(caps.terminal.name).toBe("Zellij")
  })

  test("explicit remote mode does not require SSH environment", async () => {
    const caps = await getCapabilitiesFromChild(
      { remote: true },
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
      },
    )

    expect(caps.remote).toBe(true)
    expect(caps.ansi256).toBe(false)
    expect(caps.notifications).toBe(false)
    expect(caps.terminal.name).toBe("")
  })

  test("process stdout with memory output preserves auto remote detection", async () => {
    const caps = await getCapabilitiesFromChild(
      {},
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        SSH_CONNECTION: "192.0.2.1 54231 192.0.2.2 22",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
      },
      "direct-process-memory",
    )

    expect(caps.remote).toBe(true)
    expect(caps.ansi256).toBe(false)
    expect(caps.notifications).toBe(false)
    expect(caps.terminal.name).toBe("")
  })

  test("custom stdout with memory output preserves auto remote detection", async () => {
    const caps = await getCapabilitiesFromChild(
      {},
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        SSH_CONNECTION: "192.0.2.1 54231 192.0.2.2 22",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
      },
      "cli-custom-memory",
    )

    expect(caps.remote).toBe(true)
    // createCliRenderer runs terminal setup; Windows ConPTY setup enables color
    // capabilities even when remote mode suppresses env-derived terminal data.
    expect(caps.notifications).toBe(false)
    expect(caps.terminal.name).toBe("")
  })

  test("custom stdout feed output defaults to remote without SSH environment", async () => {
    const caps = await getCapabilitiesFromChild(
      {},
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
      },
      "cli-custom-feed",
    )

    expect(caps.remote).toBe(true)
    // createCliRenderer runs terminal setup; Windows ConPTY setup enables color
    // capabilities even when remote mode suppresses env-derived terminal data.
    expect(caps.notifications).toBe(false)
    expect(caps.terminal.name).toBe("")
  })

  test("custom stdout feed output respects explicit local mode", async () => {
    const caps = await getCapabilitiesFromChild(
      { remote: false },
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        SSH_TTY: "/dev/pts/1",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
      },
      "cli-custom-feed",
    )

    expect(caps.remote).toBe(false)
    expect(caps.ansi256).toBe(true)
    expect(caps.notifications).toBe(true)
    expect(caps.terminal.name).toBe("ghostty")
  })
})
