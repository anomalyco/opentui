# Tree-sitter Assets

This directory contains downloaded tree-sitter language parsers and highlight queries for the default parsers used by OpenTUI.
They are included in the repository to avoid downloading them every time the project is built or tests are run.

## Asset Management

Parser definitions are configured in `../parsers-config.ts` for OpenTUI's built-in parser set.

### Update Script

The `update.ts` script downloads parsers and queries from the configured URLs and generates the `../default-parsers.ts` file.

#### Usage

**For OpenTUI Core Development (using default paths):**

```bash
# Run from this directory
bun update.ts

# Or from the project root
bun packages/core/src/lib/tree-sitter/assets/update.ts
```

**For Application Developers (using custom paths):**

```bash
# CLI usage with custom paths
bun update.ts \
  --config ./my-parsers-config.json \
  --assets ./src/tree-sitter/assets \
  --output ./src/tree-sitter/parsers.ts

# Show help
bun update.ts --help
```

**Programmatic Usage:**

```typescript
import { updateAssets } from "@opentui/core/tree-sitter/update-assets"

await updateAssets({
  configPath: "./my-parsers-config.json",
  assetsDir: "./src/tree-sitter/assets",
  outputPath: "./src/tree-sitter/parsers.ts",
})
```

#### What it does

1. **Downloads Language Parsers**: Downloads `.wasm` files from GitHub releases
2. **Downloads Query Files**: Downloads `.scm` highlight query files from repositories
3. **Combines Queries**: For languages like TypeScript, combines multiple query files (JS base + TS extensions)
4. **Generates Imports**: Creates a TypeScript file with proper file imports using Bun's `with { type: "file" }` syntax

## Adding New Parsers

### For Application Developers

If you're using OpenTUI in your application and want to add support for additional languages:

#### 1. Create a parsers configuration file

Create a `parsers-config.json` file in your project with the structure:

```json
{
  "parsers": [
    {
      "filetype": "python",
      "wasm": "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.20.4/tree-sitter-python.wasm",
      "queries": {
        "highlights": [
          "https://raw.githubusercontent.com/tree-sitter/tree-sitter-python/refs/heads/master/queries/highlights.scm"
        ]
      }
    }
  ]
}
```

#### 2. Add to your build pipeline

Add the update script to your `package.json`:

```json
{
  "scripts": {
    "prebuild": "bun node_modules/@opentui/core/lib/tree-sitter/update-assets.js --config ./parsers-config.json --assets ./src/parsers --output ./src/parsers.ts",
    "build": "bun build ./src/index.ts"
  }
}
```

#### 3. Use the generated parsers

```typescript
import { getTreeSitterClient } from "@opentui/core"
import { getParsers } from "./parsers"

const client = getTreeSitterClient()

// Register your custom parsers
for (const parser of getParsers()) {
  client.addFiletypeParser(parser)
}
```

For more information about using Tree-Sitter in your application, see the [Tree-Sitter guide](../../../docs/tree-sitter.md).

### For OpenTUI Core Developers

To add a new default parser to OpenTUI Core:

1. **Update Configuration**: Add the new parser to `../parsers-config.ts`
2. **Run Update Script**: Execute `bun update.ts` to download assets and regenerate imports
3. **Commit Generated Assets**: Include the downloaded parser/query files and regenerated `../default-parsers.ts`
