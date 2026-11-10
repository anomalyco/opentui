import { test, expect } from "bun:test"
import { extensionToFiletype, infoStringToFiletype, pathToFiletype } from "./resolve-ft.js"

test("pathToFiletype only resolves actual paths", () => {
  expect(pathToFiletype("tsx")).toBeUndefined()
  expect(pathToFiletype("components/Button.tsx")).toBe("typescriptreact")
})

test("pathToFiletype resolves common extension aliases to parser ids", () => {
  expect(pathToFiletype("src/index.mjs")).toBe("javascript")
  expect(pathToFiletype("src/index.cts")).toBe("typescript")
  expect(pathToFiletype("src/index.mtsx")).toBe("typescriptreact")
  expect(pathToFiletype("src/module.cc")).toBe("cpp")
  expect(pathToFiletype("src/module.hxx")).toBe("cpp")
  expect(pathToFiletype("src/config.hrl")).toBe("erlang")
  expect(pathToFiletype("src/main.hs")).toBe("haskell")
  expect(pathToFiletype("src/main.ml")).toBe("ocaml")
  expect(pathToFiletype("src/main.scala")).toBe("scala")
  expect(pathToFiletype("src/config.zon")).toBe("zig")
  expect(pathToFiletype("src/script.sh")).toBe("bash")
})

test("pathToFiletype resolves common basenames", () => {
  expect(pathToFiletype("Dockerfile")).toBe("dockerfile")
  expect(pathToFiletype("Containerfile")).toBe("dockerfile")
  expect(pathToFiletype("Makefile")).toBe("make")
  expect(pathToFiletype("Rakefile")).toBe("ruby")
  expect(pathToFiletype(".bashrc")).toBe("bash")
  expect(pathToFiletype(".vimrc")).toBe("vim")
})

test("infoStringToFiletype normalizes markdown fence labels", () => {
  expect(infoStringToFiletype("tsx")).toBe("typescriptreact")
  expect(infoStringToFiletype("TSX title=Button.tsx")).toBe("typescriptreact")
  expect(infoStringToFiletype(".jsx")).toBe("javascriptreact")
  expect(infoStringToFiletype("Button.tsx")).toBe("typescriptreact")
  expect(infoStringToFiletype("Dockerfile")).toBe("dockerfile")
  expect(infoStringToFiletype("bash")).toBe("bash")
})

test("extensionToFiletype can be extended by consumers", () => {
  const previous = extensionToFiletype.get("foo")

  try {
    extensionToFiletype.set("foo", "custom")
    expect(infoStringToFiletype("foo")).toBe("custom")
    expect(pathToFiletype("example.foo")).toBe("custom")
  } finally {
    if (previous === undefined) {
      extensionToFiletype.delete("foo")
    } else {
      extensionToFiletype.set("foo", previous)
    }
  }
})
