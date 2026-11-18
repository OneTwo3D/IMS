import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Connector-agnostic "scheduled READ job" scope. Inside `withWmsNoLogin` a connector whose authentication is a
 * write (Mintsoft: `POST /api/Auth` mints a new tenant key and invalidates the old one) must not log in. Generic
 * sweeps that serve every WMS enter the scope; each connector's auth path asks `isWmsLoginForbidden()`. See
 * lib/connectors/mintsoft/api/auth-no-login.ts for the Mintsoft wording.
 */
const noLoginScope = new AsyncLocalStorage<true>()

export function withWmsNoLogin<T>(run: () => Promise<T>): Promise<T> {
  return noLoginScope.run(true, run)
}

export function isWmsLoginForbidden(): boolean {
  return noLoginScope.getStore() === true
}
