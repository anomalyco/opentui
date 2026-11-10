// Keep these ambient asset types here so keymap declaration emit still works
// when workspace @opentui/core source pulls in Tree-sitter .scm/.wasm assets.
declare module "*.scm" {
  const value: string
  export default value
}

declare module "*.wasm" {
  const value: string
  export default value
}
