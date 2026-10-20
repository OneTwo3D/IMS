/**
 * ONE READ ONLY, REPEATABLE READ TRANSACTION, BOUNDED BY A STATEMENT TIMEOUT, FOR EVERY IMS READ OF A PACK BASIS.
 *
 * Two reads in two transactions can straddle a commit (a settings change, a snapshot pull landing between the ledger
 * balances and the subledger), and the pair is then a basis nobody ever had. Everything an item compares on is read
 * inside the function handed to `withReadOnlySnapshot`, so it is one view of the database.
 *
 * The transaction is asked to be READ ONLY and REPEATABLE READ and then ASKED WHAT IT IS before the caller's first
 * read: a mode that did not take (a driver that ignored the isolation level, a pooler that rewrote the statement)
 * throws, and nothing is read in it. The statement timeout is `SET LOCAL`, so the SERVER cancels a statement that
 * overruns instead of a client waiting on it.
 *
 * It writes nothing and calls nothing outside the database.
 */

export const PACK_READ_STATEMENT_TIMEOUT_MS = 20_000
export const PACK_READ_TX_BOUNDS = { maxWait: 10_000, timeout: 60_000 } as const

/** What the caller's reads may use: the transaction client, typed loosely so a test can hand a double. */
export type ReadTx = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

export class ReadTxModeError extends Error {}

export type ReadTxClient = {
  $transaction<T>(fn: (tx: never) => Promise<T>, options?: { isolationLevel?: unknown; maxWait?: number; timeout?: number }): Promise<T>
}

export async function withReadOnlySnapshot<T, Tx extends ReadTx = ReadTx>(
  fn: (tx: Tx) => Promise<T>,
  options: { client?: ReadTxClient; statementTimeoutMs?: number; isolationLevel?: unknown } = {},
): Promise<T> {
  const timeoutMs = Math.trunc(options.statementTimeoutMs ?? PACK_READ_STATEMENT_TIMEOUT_MS)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new ReadTxModeError('the statement timeout must be a positive whole number of milliseconds')
  const client = options.client ?? ((await import('@/lib/db')).db as unknown as ReadTxClient)
  const isolationLevel = options.isolationLevel ?? (await import('@/app/generated/prisma/client')).Prisma.TransactionIsolationLevel.RepeatableRead
  return client.$transaction(async (raw) => {
    const tx = raw as unknown as Tx
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`)
    const mode = await tx.$queryRawUnsafe<Array<{ isolation: string; readOnly: string; timeout: string }>>(
      `SELECT current_setting('transaction_isolation') AS "isolation", current_setting('transaction_read_only') AS "readOnly", current_setting('statement_timeout') AS "timeout"`,
    )
    const row = mode[0]
    if (!Array.isArray(mode) || mode.length !== 1 || !row || row.isolation !== 'repeatable read' || row.readOnly !== 'on' || typeof row.timeout !== 'string' || row.timeout === '0') {
      throw new ReadTxModeError('the pack read transaction is not read-only repeatable read')
    }
    return fn(tx)
  }, { isolationLevel, ...PACK_READ_TX_BOUNDS })
}
