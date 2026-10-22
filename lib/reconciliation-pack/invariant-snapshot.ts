/**
 * ONE SNAPSHOT FOR THE WHOLE INVARIANT RUN THAT R3, R4 AND R15 READ.
 *
 * The scheduled invariant check reads its three reports concurrently, the inventory one in pages, each read through the
 * application's `db` client in its own implicit transaction. Clean reports taken at different instants are not proof that any
 * single database state was clean: a row that moves between two reads can be missed by both. The pack therefore runs the check
 * inside ONE `REPEATABLE READ READ ONLY` transaction, and binds the application's `db` to that transaction for the duration, so
 * every read the reports make (including the ones deep in settings, connector and GL-reconciliation helpers) sees one snapshot by
 * construction rather than by threading a client through each of them.
 *
 * How the binding works: lib/db/index.ts exports `db = globalThis.prisma ?? createPrismaClient()`. The transaction client is put
 * on `globalThis.prisma` BEFORE lib/db is first imported, so the module's `db` IS the transaction client. That only holds if
 * nothing imported lib/db earlier, so it is not assumed: inside the transaction the module's `db` is compared with the
 * transaction client, and the run gets no proof unless they are the same object.
 *
 * The proof attached to the evidence (`snapshot`) is read from PostgreSQL itself at the start and at the end of the run: the
 * isolation level, the read-only flag and pg_current_snapshot(), which under REPEATABLE READ stays the same for the whole
 * transaction. The item runners (invariant-items.ts readRun) refuse to pass without it. Any write the reports attempted fails
 * on the read-only transaction, which the check records as a report error: inconclusive, never a pass.
 */

import { PrismaPg } from '@prisma/adapter-pg'

import { Prisma, PrismaClient } from '@/app/generated/prisma/client'
import { pgConnectionConfig, prismaAdapterSchemaOptions } from '@/lib/db/database-url-schema.mjs'

/** Long enough for a full-history inventory scan; the transaction holds one read snapshot, never a lock on a row. */
export const INVARIANT_SNAPSHOT_TIMEOUT_MS = 30 * 60_000
const CONNECT_WAIT_MS = 10_000

export type InvariantSnapshotProof = { isolation: 'repeatable read'; readOnly: true; snapshot: string; boundToApplicationClient: true }

export type SnapshotTx = {
  $executeRawUnsafe(sql: string): Promise<unknown>
  $queryRawUnsafe(sql: string): Promise<unknown>
}
export type SnapshotClient = {
  $transaction<T>(fn: (tx: SnapshotTx) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait: number }): Promise<T>
  $disconnect(): Promise<void>
}
export type InvariantSnapshotDeps = {
  client?: SnapshotClient
  /** Returns the `db` lib/db exports, imported AFTER the binding. */
  loadApplicationDb?: () => Promise<unknown>
}

const PROOF_SQL = "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only, pg_current_snapshot()::text AS snapshot"

type ProofRead = { isolation: string; readOnly: string; snapshot: string }
function readProof(rows: unknown): ProofRead | null {
  if (!Array.isArray(rows) || rows.length !== 1) return null
  const row = rows[0] as Record<string, unknown> | null
  if (typeof row !== 'object' || row === null) return null
  const { isolation, read_only: readOnly, snapshot } = row
  return typeof isolation === 'string' && typeof readOnly === 'string' && typeof snapshot === 'string' && snapshot !== '' ? { isolation, readOnly, snapshot } : null
}

/** A dedicated single-connection client, built the way lib/db builds the application's (config form, schema options). */
function createSnapshotClient(): SnapshotClient {
  const url = process.env.DATABASE_URL
  const adapter = new PrismaPg({ ...pgConnectionConfig(url), max: 1, connectionTimeoutMillis: CONNECT_WAIT_MS }, prismaAdapterSchemaOptions(url))
  return new PrismaClient({ adapter }) as unknown as SnapshotClient
}

const holder = globalThis as unknown as { prisma?: unknown }

/**
 * Runs `run` with the application's `db` bound to one REPEATABLE READ READ ONLY transaction and returns its evidence with
 * `snapshot` set to the proof, or to null when any part of the proof is missing. Throws (and the item runners then see no
 * evidence at all) if the application client was already created, since it could not then be bound.
 */
export async function runInvariantInOneSnapshot(run: () => Promise<unknown>, deps: InvariantSnapshotDeps = {}): Promise<unknown> {
  if (holder.prisma !== undefined) throw new Error('the application database client already exists, so the invariant run cannot be bound to one snapshot')
  const client = deps.client ?? createSnapshotClient()
  const loadApplicationDb = deps.loadApplicationDb ?? (async () => (await import('@/lib/db')).db)
  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      const start = readProof(await tx.$queryRawUnsafe(PROOF_SQL))
      holder.prisma = tx
      const bound = (await loadApplicationDb()) === tx
      const evidence = await run()
      const end = readProof(await tx.$queryRawUnsafe(PROOF_SQL))
      const proven = bound && start !== null && end !== null && start.isolation === 'repeatable read' && start.readOnly === 'on'
        && end.isolation === start.isolation && end.readOnly === start.readOnly && end.snapshot === start.snapshot
      const snapshot: InvariantSnapshotProof | null = proven ? { isolation: 'repeatable read', readOnly: true, snapshot: start.snapshot, boundToApplicationClient: true } : null
      return typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence) ? { ...evidence, snapshot } : evidence
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: INVARIANT_SNAPSHOT_TIMEOUT_MS, maxWait: CONNECT_WAIT_MS })
  } finally {
    await client.$disconnect()
  }
}
