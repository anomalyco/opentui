import { expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import { createServer } from "../../index.js"
import { logging } from "../../logging.js"
import type { AuthConfig, Identity, IdentityFor, Middleware, ServerConfig } from "../../types.js"

// Compile-time proof for `IdentityFor<A>`; assertions are checked by `tsc --noEmit`.
// Bun strips types at runtime, so the test body is only a presence check.

type Expect<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type Publickey = Extract<Identity, { method: "publickey" }>
type None = Extract<Identity, { method: "none" }>
type Password = Extract<Identity, { method: "password" }>

// publickey-only → the publickey variant (fingerprint guaranteed).
type _PkOnly = Expect<Equal<IdentityFor<{ publicKey: "any" }>, Publickey>>

// "open" → the none variant (no fingerprint field).
type _NoneOnly = Expect<Equal<IdentityFor<"open">, None>>

// publicKey: { authorizedKeys } → publickey variant.
type _AuthKeys = Expect<Equal<IdentityFor<{ publicKey: { authorizedKeys: "./authorized_keys" } }>, Publickey>>

// publicKey: { allow } → publickey variant.
type _Allow = Expect<Equal<IdentityFor<{ publicKey: { allow: () => boolean } }>, Publickey>>

// publickey + password → a union of both variants.
type _Union = Expect<
  Equal<
    IdentityFor<{ publicKey: "any"; password: (c: { username: string; password: string }) => boolean }>,
    Publickey | Password
  >
>

const idNone: IdentityFor<"open"> = { method: "none", username: "x" }
// @ts-expect-error — `fingerprint` does not exist on the `none` variant
void idNone.fingerprint

// On a union, `fingerprint` is unreadable without narrowing on `method`.
const idUnion: IdentityFor<{ publicKey: "any"; password: (c: { username: string; password: string }) => boolean }> = {
  method: "password",
  username: "x",
}
// @ts-expect-error — could be the password variant; must discriminate on `method` first
void idUnion.fingerprint

const idPk: IdentityFor<{ publicKey: "any" }> = {
  method: "publickey",
  username: "x",
  fingerprint: "SHA256:abc",
  publicKey: { algorithm: "ssh-ed25519", blob: Buffer.alloc(0) },
}
const _fp: string = idPk.fingerprint

// Reference the type-only locals so `verbatimModuleSyntax`/lint stays happy.
type _Used = [_PkOnly, _NoneOnly, _AuthKeys, _Allow, _Union]

// The configured `auth` flows through `createServer` into the handler's
// `session.identity`. Never invoked; `tsc --noEmit` checks the bodies.
function _handlerNarrowing() {
  // publickey-only → publickey variant; fingerprint is present.
  createServer({ auth: { publicKey: "any" } }).serve((s) => {
    const fp: string = s.identity.fingerprint
    void fp
  })

  // "open" → identity has no `fingerprint` field.
  createServer({ auth: "open" }).serve((s) => {
    // @ts-expect-error — `fingerprint` does not exist on the `none` variant
    void s.identity.fingerprint
  })

  // publickey + password → a union; discriminate on `method` first.
  createServer({ auth: { publicKey: "any", password: ({ password }) => password === "x" } }).serve((s) => {
    // @ts-expect-error — could be the password variant; narrow on `method` first
    void s.identity.fingerprint
    if (s.identity.method === "publickey") {
      const fp: string = s.identity.fingerprint // narrowed
      void fp
    }
  })

  // auth omitted → defaults to "open", so identity narrows to the `none` variant.
  createServer().serve((s) => {
    const m: "none" = s.identity.method
    void m
    // @ts-expect-error — the `none` variant has no `fingerprint`
    void s.identity.fingerprint
  })

  // "open" and credentials are mutually exclusive; `none` is not a config key.
  // @ts-expect-error — `none` is not an AuthMethods key; use auth: "open" instead
  createServer({ auth: { none: true, publicKey: "any" } }).serve(() => {})

  // `authorizedKeys` is a sub-policy of publicKey, not a top-level method.
  // @ts-expect-error — authorizedKeys nests under publicKey: { authorizedKeys }
  createServer({ auth: { authorizedKeys: "./authorized_keys" } }).serve(() => {})
  // The nested form narrows identity to the publickey variant.
  createServer({ auth: { publicKey: { authorizedKeys: "./authorized_keys" } } }).serve((s) => {
    const fp: string = s.identity.fingerprint
    void fp
  })
  // The dynamic `allow` predicate also narrows to publickey.
  createServer({ auth: { publicKey: { allow: ({ fingerprint }) => fingerprint === "x" } } }).serve((s) => {
    const fp: string = s.identity.fingerprint
    void fp
  })

  // The handler is required: createServer returns a builder with no `listen`.
  // @ts-expect-error — the builder has no `listen`; you must serve(handler) first
  createServer({ auth: "open" }).listen()
  // Once you serve, you get a Server that does listen.
  void createServer({ auth: "open" }).serve(() => {}).listen

  // Already-typed config objects/wrappers still flow through createServer.
  const config: ServerConfig<AuthConfig> = { auth: Math.random() > 0.5 ? "open" : { password: () => true } }
  createServer(config).serve((s) => {
    const id: Identity = s.identity
    void id
  })

  const omittedAuthConfig: ServerConfig<{ publicKey: "any" }> = {}
  createServer(omittedAuthConfig).serve((s) => {
    // @ts-expect-error — typed configs can omit auth at runtime, so none is still possible
    void s.identity.fingerprint
  })

  createServer({ limits: { session: { perConnection: 2, global: 200 } } }).serve(() => {})
  createServer({ limits: { session: { perConnection: 2 } } }).serve(() => {})
  createServer({ limits: { session: { global: 200 } } }).serve(() => {})
  // @ts-expect-error session limits are numeric
  createServer({ limits: { session: { perConnection: "2" } } }).serve(() => {})
  // @ts-expect-error unlimited session limits are unsupported
  createServer({ limits: { session: { global: null } } }).serve(() => {})
  // @ts-expect-error misspelled session limit field
  createServer({ limits: { session: { perClient: 2 } } }).serve(() => {})
}

// `.use(...)` accumulates each link's contribution (inferred from `next({...})`)
// into a typed `context`: a later link reads what earlier links contributed, the
// handler reads the sum, and nothing un-contributed is readable.
function _contextAccumulation() {
  interface User {
    name: string
  }

  // Id/Ctx flow from the builder; the contribution is inferred from next({...}),
  // so inline arrows need zero type arguments. The chain accumulates user→greeting.
  createServer({ auth: "open" })
    .use((s, next) => next({ user: { name: s.identity.username } as User }))
    .use((s, next) => {
      const u: User = s.context.user // a later link sees the earlier contribution, typed
      void u
      return next({ greeting: `hi ${u.name}` })
    })
    .serve((s) => {
      const u: User = s.context.user
      const g: string = s.context.greeting
      void u
      void g
      // @ts-expect-error — nothing contributed `roles`; it isn't on the context
      void s.context.roles
    })

  // A pure gate contributes nothing; deny() returns never, so it need not be
  // returned, and next() continues with an empty contribution.
  createServer({ auth: "open" })
    .use((s, next) => (s.identity.username === "x" ? s.deny("no") : next()))
    .serve(() => {})

  // A reusable middleware typed with `Middleware` accumulates its contribution too.
  const roles: Middleware<Identity, { roles: string[] }> = (_s, next) => next({ roles: ["admin"] })
  createServer({ auth: "open" })
    .use(roles)
    .serve((s) => {
      const r: string[] = s.context.roles
      void r
    })

  // Returning the handoff is compile-enforced: a middleware that returns void
  // (forgets next()) is rejected.
  createServer({ auth: "open" }).use(
    // @ts-expect-error — Promise<void> is not a Handoff; you must return next()
    async (_s, _next) => {},
  )
}

// The renderer exists only on the handler's session: a middleware receives an
// `MiddlewareSession` (no `renderer`), the handler a `Session` (adds it). The
// lazy-renderer invariant is thus enforced by the type.
function _rendererVisibility() {
  createServer({ auth: "open" })
    .use((s, next) => {
      // @ts-expect-error — a middleware's MiddlewareSession has no `renderer`
      void s.renderer
      return next()
    })
    .serve((s) => {
      const r: CliRenderer = s.renderer
      void r
    })
}

function _loggingIdentityNarrowing() {
  createServer({ auth: { publicKey: "any" } })
    .use(
      logging<Publickey>({
        log(event) {
          const fingerprint: string = event.identity.fingerprint
          const method: "publickey" = event.identity.method
          void fingerprint
          void method
        },
      }),
    )
    .serve(() => {})

  createServer({ auth: "open" })
    .use(
      logging<None>({
        log(event) {
          const method: "none" = event.identity.method
          void method
          // @ts-expect-error open authentication has no public-key fingerprint
          void event.identity.fingerprint
        },
      }),
    )
    .serve(() => {})
}

function _loggingEventNarrowing() {
  logging({
    log(event) {
      if (event.type === "disconnect") {
        const duration: number = event.durationMs
        void duration
      } else {
        const duration: undefined = event.durationMs
        void duration
      }
    },
  })
}

test("type-proof compiles (assertions verified by tsc)", () => {
  expect(typeof _rendererVisibility).toBe("function")
  expect(idNone.method).toBe("none")
  expect(idPk.fingerprint).toBe("SHA256:abc")
  expect(_fp).toBe("SHA256:abc")
  expect(typeof _handlerNarrowing).toBe("function")
  expect(typeof _contextAccumulation).toBe("function")
  expect(typeof _loggingIdentityNarrowing).toBe("function")
  expect(typeof _loggingEventNarrowing).toBe("function")
})
