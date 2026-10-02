import { beforeAll, describe, expect, test } from "bun:test"
import {
  compileHeader,
  generateNativeABI,
  generateRustConstants,
  verifyNativeABI,
  verifyRustConstants,
  type HeaderABI,
} from "./native-abi.js"

let abi: HeaderABI

beforeAll(() => {
  abi = compileHeader()
}, 120_000)

describe("checked native ABI generation", () => {
  test("the committed output matches every header symbol and record", async () => {
    verifyNativeABI(await generateNativeABI(abi))
    verifyRustConstants(abi)
  }, 120_000)

  test.skipIf(Boolean(process.env.OPENTUI_RUST_DIR))(
    "Rust constant generation is skipped without OPENTUI_RUST_DIR",
    () => {
      expect(generateRustConstants(abi).size).toBe(0)
    },
  )
})
