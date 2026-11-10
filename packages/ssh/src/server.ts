import ssh2 from "ssh2"
import { formatBanner } from "./banner.js"
import { createConnectionHandler } from "./connection.js"
import type { RuntimeMiddleware } from "./run-session.js"
import { resolveRuntime } from "./runtime.js"
import type {
  AuthConfig,
  AuthMethods,
  Identity,
  IdentityFor,
  ListenInfo,
  MiddlewareFunction,
  Server,
  ServerBuilder,
  ServerConfig,
  SessionHandler,
} from "./types.js"

const { Server: Ssh2Server } = ssh2

/** Loopback listeners skip the no-auth exposure warning. */
const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost"

/**
 * Build the running server. Reached only via the builder's `serve()`, so the
 * handler is always present. `resolveRuntime` derives everything from config
 * (host key, authenticator, idle budget, banner) and `createConnectionHandler`
 * owns the per-connection ssh2 lifecycle; this wires them into the ssh2 `Server`
 * and the `listen`/`close` lifecycle.
 */
function buildServer<Id extends Identity>(
  config: ServerConfig<AuthConfig>,
  middlewares: RuntimeMiddleware<Id>[],
  handler: SessionHandler<Id>,
): Server {
  const runtime = resolveRuntime(config)
  const connectionHandler = createConnectionHandler({
    authenticator: runtime.authenticator,
    middlewares: middlewares as RuntimeMiddleware[],
    handler: handler as SessionHandler,
    safe: runtime.safe,
    idleTimeoutMs: runtime.idleTimeoutMs,
    maxTimeoutMs: runtime.maxTimeoutMs,
    sessionLimits: runtime.sessionLimits,
  })

  const sshServer = new Ssh2Server({ hostKeys: runtime.hostKeys }, connectionHandler.onConnection)
  let reportsServerErrors = false
  let bindingAttempts = 0
  sshServer.on("error", (err: Error) => {
    if (bindingAttempts === 0 && reportsServerErrors) runtime.safe.report(err)
  })

  return {
    listen(port = 2222, host = "127.0.0.1") {
      return new Promise<ListenInfo>((resolve, reject) => {
        // Convenience default is no auth; warn (don't block) when that combines
        // with a listener outside localhost. This is only a heuristic: containers,
        // tunnels, and proxies can expose localhost listeners too.
        if (runtime.noneOnly && !isLoopback(host)) {
          console.warn(
            `@opentui/ssh: no authentication configured while listening on ${host}. ` +
              "Anyone who can reach this port, including through published container ports, tunnels, " +
              "or proxies, gets a session. Set `auth` to restrict access.",
          )
        }
        bindingAttempts++
        const onError = (err: Error) => {
          bindingAttempts--
          reject(err)
        }
        sshServer.once("error", onError)
        try {
          sshServer.listen(port, host, () => {
            bindingAttempts--
            sshServer.removeListener("error", onError)
            reportsServerErrors = true
            connectionHandler.setAccepting(true)
            const addressInfo = sshServer.address()
            const actualPort = typeof addressInfo === "object" && addressInfo ? addressInfo.port : port
            const boundHost = typeof addressInfo === "object" && addressInfo ? addressInfo.address : host
            const info: ListenInfo = { host: boundHost, port: actualPort, fingerprints: runtime.fingerprints }
            if (config.startupBanner !== false) {
              console.log(formatBanner(info, runtime.banner).join("\n"))
            }
            resolve(info)
          })
        } catch (error) {
          bindingAttempts--
          sshServer.removeListener("error", onError)
          reject(error)
        }
      })
    },
    async close() {
      await connectionHandler.closeAll()
      return new Promise<void>((resolve) => {
        sshServer.close(() => resolve())
      })
    },
  }
}

/**
 * The immutable builder behind `createServer`. Each `.use(mw)` returns a NEW
 * builder over the appended chain, re-typed so `Ctx` accumulates this link's
 * contribution; `.serve(handler)` seals it. The only state is the growing
 * middleware array threaded through.
 */
function makeBuilder<Id extends Identity, Ctx extends object>(
  config: ServerConfig<AuthConfig>,
  middlewares: RuntimeMiddleware<Id>[],
): ServerBuilder<Id, Ctx> {
  return {
    use<Add extends object>(mw: MiddlewareFunction<Id, Ctx, Add>): ServerBuilder<Id, Ctx & Add> {
      // The cast is the erasure boundary: `MiddlewareFunction` proved the types at the
      // call site; the chain runs the link erased.
      return makeBuilder<Id, Ctx & Add>(config, [...middlewares, mw as unknown as RuntimeMiddleware<Id>])
    },
    serve(handler: SessionHandler<Id, Ctx>): Server {
      return buildServer<Id>(config, middlewares, handler as SessionHandler<Id>)
    },
  }
}

/**
 * Create a server builder. Configure auth/host-key/etc. in the config object,
 * then chain `.use(mw)` for each cross-cutting concern and seal with
 * `serve(handler)`. `serve` takes the handler so the builder can flow the typed
 * `context` the chain accumulates (via `next({ ... })`) into it; the builder has
 * no `listen`, so a missing handler is a compile error.
 *
 * Inline middleware need no type arguments: `identity`/`context` flow from the
 * builder, the contribution is inferred from `next({ ... })`. Author a reusable one
 * by typing it as {@link Middleware} (or {@link MiddlewareFunction} when it reads
 * upstream context). `.use(...)` order is execution order, first is OUTERMOST.
 * `session.context` is the accumulation of every link's contribution.
 *
 * ```ts
 * const server = createServer({ auth: { publicKey: "any" } })
 *   .use(async (s, next) => {
 *     const user = await lookup(s.identity.fingerprint)
 *     if (!user) s.deny("unknown key")
 *     return next({ user })
 *   })
 *   .serve((s) => mountApp(s.renderer, s.context.user))
 * await server.listen()
 * ```
 */
// Specific overloads preserve inline contextual typing; the generic overload
// accepts already-typed config objects. All start with an empty `{}` context.
export function createServer(
  config?: Omit<ServerConfig, "auth"> & { auth?: "open" },
): ServerBuilder<IdentityFor<"open">>
export function createServer<A extends AuthMethods>(
  config: Omit<ServerConfig, "auth"> & { auth: A },
): ServerBuilder<IdentityFor<A>>
export function createServer<A extends AuthConfig>(config: ServerConfig<A>): ServerBuilder<IdentityFor<A | "open">>
export function createServer<A extends AuthConfig = "open">(
  config: ServerConfig<A> = {},
): ServerBuilder<IdentityFor<A>> {
  return makeBuilder<IdentityFor<A>, {}>(config, [])
}
