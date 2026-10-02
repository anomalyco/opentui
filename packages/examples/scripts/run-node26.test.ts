import { expect, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"

test.each([{ args: [] }, { args: ["--help"] }])("Node launcher forwards browser arguments %j", async ({ args }) => {
  const argv = process.argv
  const path = process.env.PATH
  const stop = new Error("launcher exited")
  const spawn = spyOn(childProcess, "spawnSync").mockImplementation(((_command: string, args: string[]) => ({
    status: 0,
    stdout: args.includes("--eval") ? JSON.stringify({ version: "v26.4.0", execPath: "/node26" }) : "",
  })) as typeof childProcess.spawnSync)
  const copy = spyOn(fs, "cpSync").mockImplementation(() => {})
  const mkdir = spyOn(fs, "mkdirSync").mockImplementation(() => undefined)
  const remove = spyOn(fs, "rmSync").mockImplementation(() => {})
  const exit = spyOn(process, "exit").mockImplementation(() => {
    throw stop
  })
  try {
    process.argv = [process.execPath, fileURLToPath(new URL("./run-node26.mjs", import.meta.url)), ...args]
    await expect(import(`./run-node26.mjs?args=${args.join(",")}`)).rejects.toBe(stop)
    expect(spawn.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "/node26",
      ["--experimental-ffi", "--no-warnings", fileURLToPath(new URL("../.node/index.js", import.meta.url)), ...args],
    ])
  } finally {
    process.argv = argv
    process.env.PATH = path
    spawn.mockRestore()
    copy.mockRestore()
    mkdir.mockRestore()
    remove.mockRestore()
    exit.mockRestore()
  }
})
