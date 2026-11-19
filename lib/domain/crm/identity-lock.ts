/**
 * THE CRM IDENTITY LOCK (see CRM_IDENTITY_LOCK_NAMESPACE in lib/db/advisory-locks.ts): one global transaction-scoped advisory lock that serialises operator
 * MERGE, operator UNMERGE and the snapshot of a cluster erasure. Take it FIRST in the transaction, before any pair lock.
 */
import type { Prisma } from '@/app/generated/prisma/client'
import { CRM_IDENTITY_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

export async function lockCrmIdentity(tx: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CRM_IDENTITY_LOCK_NAMESPACE}::int, 0)`
}
