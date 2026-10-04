/**
 * o3d-6thk1 round 3 — THE FENCE FOR "FETCH FROM XERO, WRITE LATER".
 *
 * Anything that reads organisation-keyed data from Xero and persists it afterwards has a window between the
 * read and the write in which an operator can rebind the instance to a DIFFERENT organisation. The write
 * then lands the previous organisation's data under the new binding, after the binding's own clear has
 * committed (the cached chart offered to the re-map, a tax type written onto an IMS rate, a balance snapshot
 * for the wrong ledger). The binding transaction takes the mapping-selection lock, so the cure is the
 * mirror image of it:
 *
 *   1. CAPTURE the connection (tenant id AND connection generation) BEFORE the fetch;
 *   2. in the WRITE transaction take the SAME lock (`lockAccountingMappingSelection`), re-read the bound
 *      connection, and REFUSE (discard the fetch) when either differs.
 *
 * The generation is compared as well as the tenant because a re-consent to the same organisation mints a new
 * one; refusing that is spurious but harmless (the refresh simply runs again), and "same tenant" is not
 * proof the data was fetched under the connection now bound. Not-connected at capture and not-connected at
 * write is the same state and passes.
 *
 * The cached chart (`accounting_accounts`) has no tenant column, and adding one is a migration this fix does
 * not take; the fence is what keeps the cache single-organisation instead.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { lockAccountingMappingSelection } from '@/lib/integration-plugin-selection-lock'

export type XeroConnectionStamp = { tenantId: string; connectionGeneration: string | null }

export const XERO_CONNECTION_CHANGED_MESSAGE =
  'The connected Xero organisation changed while this was running, so the data fetched from the previous '
  + 'connection was DISCARDED and nothing was stored. Run it again against the organisation now connected.'

export class XeroConnectionChangedError extends Error {
  constructor() {
    super(XERO_CONNECTION_CHANGED_MESSAGE)
    this.name = 'XeroConnectionChangedError'
  }
}

type ConnectionReader = {
  accountingToken: {
    findUnique(args: { where: { connector: string }; select: { tenantId: true; connectionGeneration: true } }): Promise<{ tenantId: string; connectionGeneration: string | null } | null>
  }
}

export type XeroFenceTx = ConnectionReader & {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
}

async function readConnection(client: ConnectionReader): Promise<XeroConnectionStamp | null> {
  const row = await client.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true, connectionGeneration: true } })
  return row ? { tenantId: row.tenantId, connectionGeneration: row.connectionGeneration ?? null } : null
}

/** The connection to remember BEFORE a fetch. */
export async function captureXeroConnection(client: ConnectionReader = db as unknown as ConnectionReader): Promise<XeroConnectionStamp | null> {
  return readConnection(client)
}

/**
 * Inside a transaction: take the mapping lock, then throw {@link XeroConnectionChangedError} unless the
 * bound connection is still the captured one. The lock is held to commit, so a binding cannot interleave
 * between this check and the caller's writes.
 */
export async function assertXeroConnectionUnchanged(tx: XeroFenceTx, captured: XeroConnectionStamp | null): Promise<void> {
  await lockAccountingMappingSelection(tx as never, 'xero')
  const now = await readConnection(tx)
  const same = captured === null
    ? now === null
    : now !== null && now.tenantId === captured.tenantId && now.connectionGeneration === captured.connectionGeneration
  if (!same) throw new XeroConnectionChangedError()
}

/** Run `fn` in a transaction behind the fence. A changed connection is reported, not thrown. */
export async function withXeroConnectionFence<T>(
  captured: XeroConnectionStamp | null,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const value = await db.$transaction(async (tx) => {
      await assertXeroConnectionUnchanged(tx as unknown as XeroFenceTx, captured)
      return fn(tx)
    }, { timeout: options.timeoutMs ?? 60_000, maxWait: 20_000 })
    return { ok: true, value }
  } catch (error) {
    if (error instanceof XeroConnectionChangedError) return { ok: false, error: error.message }
    throw error
  }
}
