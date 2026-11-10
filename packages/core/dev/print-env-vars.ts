#!/usr/bin/env bun

/**
 * Development script to print all registered environment variables
 *
 * Usage:
 *   bun dev/print-env-vars.ts          # Colored output (default)
 *   bun dev/print-env-vars.ts --markdown  # Markdown output
 */

import { generateEnvColored, generateEnvMarkdown } from "../src/index.js"

const args = process.argv.slice(2)
const useMarkdown = args.includes("--markdown")

if (useMarkdown) {
  console.log(`${generateEnvMarkdown()}\n---\n_generated via packages/core/dev/print-env-vars.ts_`)
} else {
  console.log(generateEnvColored())
}
