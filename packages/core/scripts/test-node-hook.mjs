import { registerHooks } from "node:module"

const bunTestUrl = new URL("../.node-test/src/testing/bun-test-node.js", import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "bun:test") {
      return {
        shortCircuit: true,
        url: bunTestUrl,
      }
    }

    return nextResolve(specifier, context)
  },
})
