/**
 * THE PER-STOREFRONT-ORDER LOCK THAT SERIALISES FIRST IMPORTS.
 *
 * Two deliveries of an order IMS has never seen (one WooCommerce-anonymised, one not) used to both run the customer step before either created the
 * order, so the loser of the create left a customer row and link holding the subject's identity, and a marked loser was acknowledged while the
 * winning order stayed identifiable. Under this lock the second contender re-asks whether IMS holds the order after the first has committed and
 * takes the UPDATE path, so it never writes a customer.
 *
 * WHY A SESSION LOCK ON ITS OWN POOL, NOT A TRANSACTION ON THE APPLICATION POOL. The lock is held for the whole import, and a held Prisma transaction
 * is a held connection of the main pool (DB_POOL_MAX): a burst of first imports would occupy every connection with a lock holder and then block on
 * its own next query. The lock lives on a dedicated, bounded session-lock pool (createSessionAdvisoryLockPool: the affinity-checked factory every
 * session lock here uses, honouring DATABASE_SESSION_LOCK_URL). When that pool is full an import waits on IT (bounded by the factory's acquisition
 * deadline), never on the main pool.
 *
 * BOUNDED. The wait for the lock itself is bounded by lock_timeout; on expiry, or when no lock connection could be obtained in time, this THROWS, the
 * delivery fails, and WooCommerce redelivers. Nothing is written on that path.
 */

import type { Pool, PoolClient } from 'pg'
import { WC_FIRST_IMPORT_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { createSessionAdvisoryLockPool } from '@/lib/db/session-lock-pool'

/** Concurrent first imports that can hold the lock at once; more wait on the lock pool, not on the application pool. */
export const WC_FIRST_IMPORT_LOCK_POOL_MAX = 20
/** How long one import waits for another import of the SAME storefront order to finish before giving up (the delivery is then retried). */
export const WC_FIRST_IMPORT_LOCK_WAIT_MS = 60_000

export class WcFirstImportLockUnavailable extends Error {
  constructor() {
    super('Another import of this WooCommerce order is still running; this delivery will be retried')
    this.name = 'WcFirstImportLockUnavailable'
  }
}

/** Stable signed int4 key for a storefront order id (a hash: a collision only serialises two unrelated orders). */
export function wcFirstImportLockKey(externalOrderId: number | string): number {
  const text = String(externalOrderId)
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash, 31) + text.charCodeAt(i)
    hash |= 0
  }
  return hash
}

let lockPool: Pool | null = null
function getLockPool(): Pool {
  if (!lockPool) lockPool = createSessionAdvisoryLockPool('the WooCommerce first-import lock', WC_FIRST_IMPORT_LOCK_POOL_MAX)
  return lockPool
}

/** Take the lock; returns the release function. Throws WcFirstImportLockUnavailable when it cannot be had in time. */
export async function acquireWcFirstImportLock(externalOrderId: number | string, waitMs: number = WC_FIRST_IMPORT_LOCK_WAIT_MS): Promise<() => Promise<void>> {
  const key = wcFirstImportLockKey(externalOrderId)
  let client: PoolClient
  try {
    client = await getLockPool().connect()
  } catch {
    throw new WcFirstImportLockUnavailable()
  }
  let held = false
  try {
    // lock_timeout bounds the wait on the advisory lock itself (it applies to advisory locks as to any lock); the value is a number we built.
    await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(waitMs))}`)
    try {
      await client.query('SELECT pg_advisory_lock($1, $2)', [WC_FIRST_IMPORT_LOCK_NAMESPACE, key])
      held = true
    } catch {
      throw new WcFirstImportLockUnavailable()
    }
    await client.query('RESET lock_timeout')
  } catch (e) {
    // Never return a connection that may hold the lock, or a failed one, to the pool.
    client.release(true)
    throw e instanceof WcFirstImportLockUnavailable ? e : new WcFirstImportLockUnavailable()
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    let destroy = false
    try {
      const result = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1, $2) AS unlocked', [WC_FIRST_IMPORT_LOCK_NAMESPACE, key])
      if (!result.rows[0]?.unlocked) destroy = true
    } catch {
      destroy = true
    }
    // A connection whose unlock did not confirm is destroyed: ending the session releases every lock it holds.
    client.release(destroy || !held)
  }
}
