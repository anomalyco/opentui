# Agent Guidelines for opentui

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

NOTE: When only changing typescript, you do NOT need to run the build script.
The build is only needed when changing native code.

## APIs

Don't use bun-specific APIs. Generated code should work in Bun, Node.js and Deno runtimes.

## Portable FFI Types

- In portable FFI code, stay within the `node:ffi`/`bun:ffi` type intersection.
- Avoid backend-specific ABI names in shared definitions: no `usize`, `napi_env`, or `napi_value`. Use explicit widths like `u32`/`u64`.
- Treat `i64`/`u64` as `bigint`, and native booleans as `0`/`1`.
- For pointer params, pass `ptr(view)` explicitly and keep shared `Pointer` values as `number | bigint`.
- For C strings, encode to bytes and pass pointers; do not assume raw JS strings or portable native string return normalization.
- Create callbacks through the loaded library/platform facade, not `new JSCallback(...)`, and only assume same-thread callback behavior.

## Testing

Use `bun test` to run tests from the packages directories for a specific package.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Build/Test Commands

To build the project (before running typescript tests), run
`bun run build`
FROM THE REPO ROOT to make sure all packages are built correctly.

To run native tests for `packages/core`, run
`bun run test:native`
FROM THE `packages/core` DIRECTORY.

To filter native tests, use:
`bun run test:native -Dtest-filter="test name"`
FROM THE `packages/core` DIRECTORY.

## Typescript Code Style

- **Runtime**: Bun with TypeScript
- **Formatting**: oxfmt (semi: false, printWidth: 120)
- **Imports**: Use explicit imports, group by: built-ins, external deps, internal modules
- **Types**: Strict TypeScript, use interfaces for options/configs, explicit return types for public APIs
- **Naming**: camelCase for variables/functions, PascalCase for classes/interfaces, UPPER_CASE for constants
- **Error Handling**: Use proper Error objects, avoid silent failures
- **Async**: Prefer async/await over Promises, handle errors explicitly
- **Comments**: Minimal comments, NO JSDoc
- **File Structure**: Index files for clean exports, group related functionality
- **Testing**: Bun test framework, descriptive test names, use beforeEach/afterEach for setup

## Debugging

- NOTE this is a terminal UI lib and when running examples or apps built with it,
  you cannot currently see log output like console.log. Ask the user to run the example/app and provide the output.
- Reproduce the issue in a test case. Do NOT start fixing without a reproducible test case.
  Use debug logs to see what is actually happening. DO NOT GUESS.
