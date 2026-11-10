import { describe, expect, it } from "bun:test"
import { getComponentCatalogue as getRootComponentCatalogue } from "../index.js"
import { getComponentCatalogue as getComponentsEntrypointCatalogue } from "../components.js"

describe("components entrypoint", () => {
  it("shares the root component catalogue", () => {
    expect(getComponentsEntrypointCatalogue()).toBe(getRootComponentCatalogue())
  })
})
