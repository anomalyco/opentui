// @types/ssh2 (1.15.x) lags the ssh2 1.17 runtime. Re-declare the runtime fields
// it omits so call sites stay cast-free. Drop entries here as DefinitelyTyped
// catches up. This augments ssh2's own types only — nothing here is re-exported.
export {}

declare module "ssh2" {
  interface PseudoTtyInfo {
    /** The client's requested `TERM`. Sent at runtime; omitted by @types/ssh2. */
    term?: string
  }
}
