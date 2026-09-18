import type { Prisma } from '@/app/generated/prisma/client'
import { accountingPostingKeyForRow } from '@/lib/accounting/posting-key'
import { withSavepoint } from '@/lib/db/savepoint'
import { clearAccountingPostingRefusal, type PostingRefusalClient } from '@/lib/domain/accounting/posting-refusal-inbox'

/**
 * o3d-j625 r6 (review H3) — THE ONE PLACE AN ACCOUNTING SYNC ROW IS CREATED, AND THEREFORE THE ONE PLACE A
 * REFUSED POSTING IS CLEARED.
 *
 * r5 cleared an outstanding refusal from the two facade enqueues only. Rows are also written by the
 * connector queues, the daily batches and — the finding — the follow-up enqueues in both sync processors.
 * The supplier-credit-note allocation sweep recorded a refusal "keyed exactly as the allocation's own
 * enqueue", and that enqueue is `enqueueFollowUpSyncLog`, which never cleared anything: a row that could
 * not clear, under inbox copy saying it would.
 *
 * So the clear moved to the write. Every `accountingSyncLog.create` in app/ and lib/ goes through this
 * function (tests/accounting/sync-log-row-primitive.test.ts fails on one that does not), and this function
 * clears the refusal whose key the new row carries — derived from the row's own fields by
 * `accountingPostingKeyForRow`, which equals the key the enqueue's params produce. Whatever path queues a
 * posting, its outstanding row clears, and a row that is unclearable by construction cannot recur.
 *
 * IN THE SAME CLIENT, UNDER A SAVEPOINT. The clear commits or rolls back with the row it is about (a clear
 * that survived a rolled-back create would mark the debt paid over a posting never written), and a failure
 * in it cannot abort the caller's transaction (25P02) — see posting-refusal-inbox.ts. On an autocommit
 * client the savepoint helper simply runs the statement.
 */
export type SyncLogRowClient = {
  accountingSyncLog: { create(args: { data: Prisma.AccountingSyncLogUncheckedCreateInput }): Promise<{ id: string }> }
}

export async function createAccountingSyncLogRow<T extends { id: string }>(
  client: SyncLogRowClient,
  data: Prisma.AccountingSyncLogUncheckedCreateInput,
  options?: {
    /**
     * Wrap the INSERT itself in a savepoint — for a caller that expects a unique-index collision and handles
     * it (the in-transaction enqueue does). The clear always runs in its own.
     */
    createInSavepoint?: boolean
  },
): Promise<T> {
  const create = () => client.accountingSyncLog.create({ data }) as Promise<T>
  const row = options?.createInSavepoint ? await withSavepoint(client, create) : await create()
  await clearAccountingPostingRefusal(
    client as unknown as PostingRefusalClient,
    accountingPostingKeyForRow({
      type: String(data.type),
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      payload: data.payload,
    }),
    { withSavepoint: <R,>(fn: () => Promise<R>) => withSavepoint(client, fn) },
  )
  return row
}
