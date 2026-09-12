# JSON Highlight Fixtures

These unmodified fixtures match the grammar and query used by OpenCode's JSON
parser configuration. Keeping them local makes the styled-text regression
deterministic and compatible with the permission-restricted Node test runner.
They are test-only, not registered as default parsers or included in the package.

- `tree-sitter-json.wasm`: [tree-sitter-json v0.24.8](https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm), MIT license (`LICENSE-GRAMMAR`).
- `highlights.scm`: [nvim-treesitter cf12346a3414fa1b06af75c79faebe7f76df080a](https://github.com/nvim-treesitter/nvim-treesitter/blob/cf12346a3414fa1b06af75c79faebe7f76df080a/queries/json/highlights.scm), Apache 2.0 license (`LICENSE-QUERY`).
