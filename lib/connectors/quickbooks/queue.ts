import type { AccountingSyncType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

export async function queueQuickBooksSync(params: {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
}): Promise<void> {
  await db.accountingSyncLog.create({
    data: {
      connector: 'quickbooks',
      type: params.type,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      payload: params.payload as never,
    },
  })
}
