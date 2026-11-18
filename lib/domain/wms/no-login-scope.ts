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

/**
 * Stable phrase every "declined to log in" message carries. A refusal is an expected state of an unattended
 * read (the stored key expired), not a processing fault, so consumers that count failures toward a retry
 * budget or a dead letter must tell the two apart. The message can be wrapped by a client, so it is matched
 * by phrase rather than by error class.
 */
export const WMS_LOGIN_REFUSED_PHRASE = 'Logging in would replace the tenant API key for every integration that shares it'

export function isWmsLoginRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.includes(WMS_LOGIN_REFUSED_PHRASE)
}
