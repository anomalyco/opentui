import { expect, test } from "bun:test"

import { documentedSymbols } from "./api-index-symbols"

const source = `
## Entry point index

| Package entry point | Runtime | Canonical documentation |
| --- | --- | --- |
| \`@opentui/core\` | Bun | [Renderer](/docs/core-concepts/renderer) |

## \`@opentui/core\`

### Renderer

| Area | Symbols | Class | Canonical documentation |
| --- | --- | --- | --- |
| Renderer | \`CliRenderer\`, \`createCliRenderer()\` | Supported | [Renderer](/docs/core-concepts/renderer#setup) |
| Leak | All runtime values from \`@opentui/react\` | Implementation | [Renderer](/docs/core-concepts/renderer) |
| Union | \`A \\| B\` | Supported | [Types](/docs/types) |

## Other \`@opentui/core\` entry points

### Testing

\`@opentui/core/testing\` works in Bun and Node.js.

| Area | Symbols | Class | Canonical documentation |
| --- | --- | --- | --- |
| Setup | \`createTestRenderer\` | Supported | [Testing](/docs/core-concepts/testing) |

### Yoga

\`@opentui/core/yoga\` works everywhere. See [Yoga API](/docs/reference/yoga).

| Purpose | Symbols | Class |
| --- | --- | --- |
| Objects | \`Node\` | Advanced |

### Runtime plugin support

| Package entry point | Symbols | Class | Canonical documentation |
| --- | --- | --- | --- |
| \`@opentui/core/runtime-plugin\` | \`createRuntimePlugin\` | Advanced | [Runtime modules](/docs/extend/runtime-plugins) |
`

test("documented symbols take their module from the section or the row and their page from the row", () => {
  expect(documentedSymbols(source)).toEqual([
    { module: "@opentui/core", name: "CliRenderer", page: "/docs/core-concepts/renderer" },
    { module: "@opentui/core", name: "createCliRenderer", page: "/docs/core-concepts/renderer" },
    { module: "@opentui/core/testing", name: "createTestRenderer", page: "/docs/core-concepts/testing" },
    { module: "@opentui/core/yoga", name: "Node", page: "/docs/reference/yoga" },
    { module: "@opentui/core/runtime-plugin", name: "createRuntimePlugin", page: "/docs/extend/runtime-plugins" },
  ])
})
