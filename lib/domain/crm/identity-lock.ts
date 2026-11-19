/**
 * THE CRM IDENTITY LOCK (see CRM_IDENTITY_LOCK_NAMESPACE in lib/db/advisory-locks.ts): one global transaction-scoped advisory lock that serialises operator
 * MERGE, operator UNMERGE and the snapshot of a cluster erasure. Take it FIRST in the transaction, before any pair lock.
 */
import type { Prisma } from '@/app/generated/prisma/client'
import { CRM_IDENTITY_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

export async function lockCrmIdentity(tx: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CRM_IDENTITY_LOCK_NAMESPACE}::int, 0)`
}

/**
 * The SHARED mode of the same lock, taken by the WooCommerce order importer when it CREATES a customer. Many importers can hold it together; it conflicts with the
 * exclusive lock of merge, unmerge and the erasure snapshot / completion check, so a customer created while a person is being erased is either committed before
 * that check (and found by it) or created after it. Held to the end of the importer's transaction. Order: this lock first, then any pair lock (merge-service.ts).
 */
export async function lockCrmIdentityShared(tx: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${CRM_IDENTITY_LOCK_NAMESPACE}::int, 0)`
}
