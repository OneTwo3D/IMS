import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { expectedDisposableDatabaseMarker } from '@/lib/disposable-database-marker'

export type InvoiceDocumentResetVerdict =
  | { ok: true; /** True when stored invoice documents exist AND this database is declared disposable, so the reset may delete them. */ mayDeleteDocuments: boolean }
  | { ok: false; reason: string }

/**
 * May a database reset run, given the stored customer invoice / credit note documents?
 *
 * They are a statutory record kept six years, and the foreign keys from them to orders and refunds are RESTRICT, so a reset that reaches the order
 * delete with documents still present would fail MIDWAY, after the earlier deletes (which are separate statements) had already committed. So the
 * question is asked FIRST, before anything is deleted:
 *   - no stored documents: nothing in the way;
 *   - stored documents and the database carries the disposable stamp (`npm run db:stamp-scratch -- <database>`, the repository's one declaration
 *     that a database is destroyable): the reset deletes the documents with everything else;
 *   - stored documents on any other database: REFUSED, with the way forward in the message.
 */
export class InvoiceDocumentsRetainedError extends Error {}

export async function invoiceDocumentResetVerdict(client: Prisma.TransactionClient | typeof db = db): Promise<InvoiceDocumentResetVerdict> {
  const stored = await client.salesOrderInvoiceDocument.count()
  if (stored === 0) return { ok: true, mayDeleteDocuments: false }
  const rows = await client.$queryRaw<Array<{ db: string | null; comment: string | null }>>`
    SELECT current_database()::text AS db, shobj_description(d.oid, 'pg_database') AS comment
    FROM pg_database d WHERE d.datname = current_database()
  `
  const name = rows[0]?.db ?? ''
  if (name && rows[0]?.comment === expectedDisposableDatabaseMarker(name)) return { ok: true, mayDeleteDocuments: true }
  return {
    ok: false,
    reason: `Nothing was deleted. This database holds ${stored} stored customer invoice / credit note document${stored === 1 ? '' : 's'}, which are statutory `
      + 'records kept for six years, and a reset would fail part-way through because orders and refunds cannot be deleted while they are stored. '
      + 'To reset a disposable installation, declare the database destroyable first (`npm run db:stamp-scratch -- <database-name>`) and run the reset '
      + 'again; to keep the records, do not reset this database.',
  }
}
