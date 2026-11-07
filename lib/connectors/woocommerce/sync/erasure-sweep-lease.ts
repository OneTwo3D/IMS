/**
 * THE SINGLE-OWNER LEASE OF THE ANONYMISATION SWEEP. The cron tick and a manual reconcile can both start the sweep; each would spend its own page
 * budget and race the other on the shared cursor. The lease is a SESSION advisory lock (pg_try_advisory_lock) on a dedicated session-lock pool (the
 * affinity-checked factory, honouring DATABASE_SESSION_LOCK_URL; the pool has headroom so a second caller gets its own connection and is refused by the try-lock, not queued), never a connection of the application pool. A run that cannot take it does nothing:
 * no request, no state write. Released in a finally; a connection whose unlock does not confirm is destroyed, which ends the session and the lock.
 */

import type { Pool } from 'pg'
import { WC_ERASURE_SWEEP_LEASE_NAMESPACE } from '@/lib/db/advisory-locks'
import { createSessionAdvisoryLockPool } from '@/lib/db/session-lock-pool'

let leasePool: Pool | null = null
function getLeasePool(): Pool {
  if (!leasePool) leasePool = createSessionAdvisoryLockPool('the WooCommerce anonymisation sweep lease', 4)
  return leasePool
}

/** Returns the release function, or null when another run holds the lease (or no lock connection could be had). */
export async function tryAcquireWcErasureSweepLease(): Promise<(() => Promise<void>) | null> {
  let client
  try {
    client = await getLeasePool().connect()
  } catch {
    return null
  }
  let held = false
  try {
    const got = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [WC_ERASURE_SWEEP_LEASE_NAMESPACE, 0])
    held = Boolean(got.rows[0]?.locked)
  } catch {
    client.release(true)
    return null
  }
  if (!held) { client.release(); return null }
  let released = false
  return async () => {
    if (released) return
    released = true
    let destroy = false
    try {
      const result = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1, $2) AS unlocked', [WC_ERASURE_SWEEP_LEASE_NAMESPACE, 0])
      if (!result.rows[0]?.unlocked) destroy = true
    } catch {
      destroy = true
    }
    client.release(destroy)
  }
}
