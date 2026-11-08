import type { Prisma } from '@/app/generated/prisma/client'
import { WC_CUSTOMER_KEY_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

/**
 * THE STOREFRONT-CUSTOMER KEY LOCK. A customer erasure and the import of one of that customer's orders must not interleave: under READ COMMITTED the importer
 * can read "no tombstone", the erasure can then commit (deleting the storefront link and clearing the email), and the importer's customer step would mint a
 * fresh customer and a live order from the original payload, outside the completed erasure's sweep.
 *
 * So both sides take a transaction-scoped advisory lock on (connector, storefront customer id): the ERASURE for every id it tombstones, BEFORE it locks the
 * customer row; the IMPORTER inside its order-create transaction, BEFORE it reads the tombstone and before its customer step (only when the payload names
 * a customer). Whichever is second waits for the first to COMMIT and then sees its effect: the importer sees the tombstone (and retries through the
 * erased-on-create path), or the erasure sees the order the importer committed (and erases it).
 *
 * GLOBAL LOCK ORDER, everywhere: first-import session lock -> this key lock (ids in ascending key order) -> customer row -> sales_order rows (id order) -> linked rows.
 * Manual erasure, the storefront mirror, imports and customer edits all follow it, so no cycle exists; customer edits take only the customer row.
 */
export function wcCustomerKeyLockKey(storefrontCustomerId: string): number {
  const text = `woocommerce:${storefrontCustomerId}`
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash, 31) + text.charCodeAt(i)
    hash |= 0
  }
  return hash
}

type Tx = Pick<Prisma.TransactionClient, '$executeRaw' | 'customer' | 'shoppingCustomerLink'>

/** Take the key lock for each id (deduplicated, in ascending key order so two takers cannot deadlock on each other). */
export async function lockStorefrontCustomerKeys(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, ids: Array<string | number | null | undefined>): Promise<string[]> {
  const unique = [...new Set(ids.map((v) => (v == null ? '' : String(v).trim())).filter((v) => /^[1-9][0-9]*$/.test(v)))]
  unique.sort((a, b) => wcCustomerKeyLockKey(a) - wcCustomerKeyLockKey(b) || (a < b ? -1 : 1))
  for (const id of unique) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_CUSTOMER_KEY_LOCK_NAMESPACE}::int, ${wcCustomerKeyLockKey(id)}::int)`
  return unique
}

/** The storefront customer ids a customer is known by right now: its own integer and every storefront link. */
export async function readStorefrontCustomerIds(tx: Pick<Tx, 'customer' | 'shoppingCustomerLink'>, customerId: string): Promise<string[]> {
  const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { externalCustomerId: true } })
  const links = await tx.shoppingCustomerLink.findMany({ where: { customerId }, select: { externalCustomerId: true } })
  return [...new Set([customer?.externalCustomerId, ...links.map((l) => l.externalCustomerId)].map((v) => (v == null ? '' : String(v).trim())).filter((v) => /^[1-9][0-9]*$/.test(v)))]
}

/** Thrown when a customer gained a storefront id between the unlocked read and the customer row lock: the erasure transaction is retried. */
export class CustomerKeysChanged extends Error {
  constructor() {
    super('The customer gained a storefront id while the erasure was taking its locks')
    this.name = 'CustomerKeysChanged'
  }
}
