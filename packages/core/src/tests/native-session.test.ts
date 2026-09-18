import { test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { NativeSession } from "../NativeSession.js"

test("invalid environment rejects before attachment", () => {
  const sink = new Writable({ write: (_bytes, _encoding, done) => done() })
  const driver = new NativeSession(sink)
  try {
    for (const environment of [{ "": "1" }, { "a=b": "1" }, { "a\0": "1" }, { a: "\0" }]) {
      assert.throws(() => driver.attachRenderer({ width: 4, height: 2, environment }))
    }
    driver.attachRenderer({ width: 4, height: 2, environment: { TERM: "xterm" } })
  } finally {
    driver.dispose()
  }
})
