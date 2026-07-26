/**
 * Recovering a Prisma interactive transaction from an expected constraint violation (o3d-slrn).
 *
 * THE PROBLEM
 * -----------
 * PostgreSQL aborts the WHOLE transaction on any error, including a unique violation (23505).
 * Prisma does not wrap individual statements in savepoints, so once a statement inside
 * `db.$transaction(...)` raises, every later statement on that same client fails with 25P02
 * ("current transaction is aborted, commands ignored until end of transaction block") and the
 * COMMIT cannot succeed.
 *
 * That breaks the try/catch idempotency pattern this codebase uses in several places:
 *
 *     try { await tx.thing.create({ data }) }
 *     catch (e) { if (isDuplicate(e)) existing = await tx.thing.findUnique(...) }   // 25P02
 *
 * The catch runs, the guard correctly identifies the duplicate — and then the recovery query,
 * and everything after it, fails anyway. Verified live against `onetwo3d_ims_dev`.
 *
 * This was latent while the P2002 guards never matched (o3d-5od: `meta.target` is empty under
 * `@prisma/adapter-pg`, so they returned false and re-threw). Making them match is necessary but
 * NOT sufficient — it converts a P2002 into a 25P02, which is equally fatal and less informative.
 *
 * THE FIX
 * -------
 * Wrap the statement that may raise in a SAVEPOINT. Rolling back to a savepoint clears the
 * aborted state and leaves the rest of the transaction intact and committable, so the catch
 * block can genuinely recover.
 */

/**
 * A client that can issue raw SQL. Deliberately structural: the transaction clients passed
 * around here are variously typed (`Prisma.TransactionClient`, narrowed per-domain aliases,
 * test doubles), and all this needs is the raw escape hatch.
 */
type RawCapableClient = {
  $executeRawUnsafe?: (query: string) => Promise<unknown>
}

/**
 * Declared as `object` rather than `RawCapableClient` on purpose. Callers pass narrowed,
 * per-domain client aliases (`IntegrationOutboxClient`,
 * `AccountingEventMirrorTransactionClient`) that do not DECLARE `$executeRawUnsafe` even though
 * the runtime value has it. Against an all-optional type TypeScript's weak-type check rejects
 * those as "no properties in common", so the capability is detected at runtime instead — which
 * is what this helper has to do anyway.
 */
function asRawCapable(client: object): RawCapableClient {
  return client as RawCapableClient
}

/**
 * Postgres' `no_active_sql_transaction`: what `SAVEPOINT` raises outside a transaction block.
 *
 * This is the discriminator because there is no reliable STRUCTURAL one. Prisma's TYPE for a
 * transaction client omits `$transaction`, but the runtime object still exposes it as a
 * function — verified live — so `'$transaction' in client` says nothing. Asking the database is
 * the only honest test, and it costs one round trip in the non-transactional case only.
 */
const NO_ACTIVE_TRANSACTION = '25P01'

function isNoActiveTransaction(error: unknown): boolean {
  const err = error as {
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } }
    message?: unknown
  }
  if (err?.meta?.driverAdapterError?.cause?.originalCode === NO_ACTIVE_TRANSACTION) return true
  // The adapter is not guaranteed to structure every error; the code is in the text either way.
  return typeof err?.message === 'string' && err.message.includes(NO_ACTIVE_TRANSACTION)
}

/**
 * Savepoint names must be unique among the savepoints live at one moment: re-using a name
 * SHADOWS the earlier savepoint rather than erroring, so a nested `withSavepoint` sharing a
 * name would release the wrong one. A process-wide counter is enough — a transaction runs its
 * statements sequentially, and the name only has to be unique within a single transaction.
 */
let savepointSeq = 0

/**
 * Run `fn` so that a failure inside it does NOT poison the surrounding transaction.
 *
 * On success the savepoint is released; on failure the transaction is rolled back to it and the
 * error is re-thrown unchanged, leaving the caller free to inspect it and carry on issuing
 * queries on the same client. Use it around any statement whose failure the caller intends to
 * HANDLE rather than propagate — in practice, an insert guarded by a unique constraint.
 *
 * Outside a transaction this is a pass-through: a failed statement on an autocommit connection
 * poisons nothing. That case is detected by ATTEMPTING the savepoint and recognising Postgres'
 * 25P01, because Prisma's transaction client is not structurally distinguishable at runtime.
 * Test doubles without `$executeRawUnsafe` take the pass-through path too, so they keep working
 * unchanged — which does mean a unit-test double cannot prove the savepoint fired. The
 * real-database test in tests/db/savepoint.pg.test.ts is what covers that.
 */
export async function withSavepoint<T>(client: object, fn: () => Promise<T>): Promise<T> {
  const raw = asRawCapable(client)
  // A test double without the raw escape hatch has nothing to protect with.
  if (typeof raw.$executeRawUnsafe !== 'function') return fn()

  // Called as a METHOD, never through an extracted reference: Prisma's client methods are
  // bound to the client, and `const f = client.$executeRawUnsafe` would lose that.
  const runRaw = (sql: string) => raw.$executeRawUnsafe!(sql)
  // Identifier, not a parameter: SAVEPOINT does not accept bind parameters. The name is built
  // here from a counter and never from caller input, so there is nothing to inject.
  const name = `ims_sp_${++savepointSeq}`

  try {
    await runRaw(`SAVEPOINT ${name}`)
  } catch (error) {
    // Not in a transaction: a failed statement on an autocommit connection poisons nothing, so
    // there is nothing to guard and `fn` can simply run. Any OTHER failure is a real problem
    // and must not be swallowed into an unguarded call.
    if (!isNoActiveTransaction(error)) throw error
    return fn()
  }

  try {
    const result = await fn()
    // Releasing keeps the savepoint stack from growing across a long loop of guarded inserts.
    await runRaw(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    // Legal even though the transaction is in the aborted state — this is what clears it.
    await runRaw(`ROLLBACK TO SAVEPOINT ${name}`)
    await runRaw(`RELEASE SAVEPOINT ${name}`)
    throw error
  }
}
