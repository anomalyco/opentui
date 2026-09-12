import { expect, test } from "bun:test"

import { TextAttributes } from "../types.js"
import { reverse } from "./styled-text.js"

test("reverse applies the inverse text attribute", () => {
  expect(reverse("status").attributes).toBe(TextAttributes.INVERSE)
})
