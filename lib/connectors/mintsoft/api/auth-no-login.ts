import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * READ-ONLY AUTHENTICATION FOR SCHEDULED POLLS.
 *
 * `POST /api/Auth` mints a NEW tenant API key and invalidates the old one, so a username/password login is a
 * WRITE with side effects on every other integration sharing the tenant (see auth-lock.ts), even though the
 * request is made on behalf of a read. A scheduled poll that runs unattended and on by default must therefore
 * never be the thing that logs in. Inside `withMintsoftNoLogin` the access-token path uses a fixed API key or an
 * unexpired stored key and otherwise REFUSES, with the sentence below; it never requests `/api/Auth`.
 */
const noLoginScope = new AsyncLocalStorage<true>()

export function withMintsoftNoLogin<T>(run: () => Promise<T>): Promise<T> {
  return noLoginScope.run(true, run)
}

export function isMintsoftLoginForbidden(): boolean {
  return noLoginScope.getStore() === true
}

/** The one sentence an operator reads when a scheduled poll declines to log in. */
export const MINTSOFT_POLL_NEEDS_KEY_TEXT =
  'This scheduled Mintsoft poll did not run: Mintsoft is set to username and password and its stored API key has expired. '
  + 'Logging in would replace the tenant API key for every integration that shares it, so scheduled polls never do that. '
  + 'Switch the Mintsoft connection to a fixed API key and the next poll will run. In username and password mode the key is only renewed when IMS itself next has to log in for another job, such as pushing an order.'
