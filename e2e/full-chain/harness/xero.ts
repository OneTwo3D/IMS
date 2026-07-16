/**
 * Xero read-back + teardown for the full-chain suite (o3d-lgo.4).
 *
 * THIS MODULE IS THE POINT OF THE TIER. Every existing "Xero" assertion in e2e/ stops
 * at the IMS's own accountingSyncLog row or a UI table row (e2e/xero.spec.ts:57
 * expectXeroLogRow). status='SYNCED' proves we SENT something, not that the right
 * document exists in the ledger — a wrong account code, tax type or line amount passes
 * silently. Here we fetch the document back by its externalTransactionId and assert on
 * what Xero actually holds.
 *
 * Everything created is registered with trackDocument() so teardown can void it. The
 * Demo ledger is SHARED with stage, so residue is not merely untidy: it skews the
 * reconciliation sweeps (X-02) that compare GL movement against the IMS subledger.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Client } from 'pg'
import { xeroGet, xeroPost } from '../../../lib/connectors/xero/api.ts'

export type XeroDocKind = 'Invoices' | 'CreditNotes' | 'ManualJournals' | 'PurchaseOrders'

type Tracked = { kind: XeroDocKind; id: string; label: string }

/**
 * The registry is a FILE, not a module-level array.
 *
 * Playwright runs globalTeardown in a DIFFERENT PROCESS from the workers, so an
 * in-memory list is always empty by the time teardown reads it — the documents are
 * silently never voided and pile up in the SHARED Demo ledger. That is exactly what
 * happened: OC-01's first green run left a live AUTHORISED invoice behind while
 * teardown reported success. Cross-process state has to be on disk.
 */
const REGISTRY = '.full-chain-xero-docs.json'

function readRegistry(): Tracked[] {
  try {
    return JSON.parse(readFileSync(REGISTRY, 'utf8')) as Tracked[]
  } catch {
    return []
  }
}

function writeRegistry(docs: Tracked[]): void {
  writeFileSync(REGISTRY, JSON.stringify(docs, null, 2))
}

/** Register a document for teardown. Call as soon as an id is known. */
export function trackDocument(kind: XeroDocKind, id: string, label: string): void {
  if (!id) return
  const docs = readRegistry()
  if (docs.some((t) => t.kind === kind && t.id === id)) return
  docs.push({ kind, id, label })
  writeRegistry(docs)
}

export function trackedDocuments(): ReadonlyArray<Tracked> {
  return readRegistry()
}

// --- read-back ---------------------------------------------------------------

export type XeroLine = {
  Description?: string
  AccountCode?: string
  TaxType?: string
  LineAmount?: number
  Quantity?: number
  UnitAmount?: number
}
export type XeroInvoice = {
  InvoiceID: string
  InvoiceNumber?: string
  Type: string
  Status: string
  Total: number
  SubTotal: number
  TotalTax: number
  CurrencyCode: string
  CurrencyRate?: number
  Reference?: string
  AmountDue?: number
  AmountPaid?: number
  LineItems: XeroLine[]
}
export type XeroCreditNote = {
  CreditNoteID: string
  CreditNoteNumber?: string
  Type: string
  Status: string
  Total: number
  CurrencyCode: string
  Reference?: string
  LineItems: XeroLine[]
}
export type XeroJournalLine = { AccountCode: string; Description?: string; LineAmount: number; TaxType?: string }
export type XeroManualJournal = {
  ManualJournalID: string
  Status: string
  Narration: string
  Date?: string
  JournalLines: XeroJournalLine[]
}

async function getOne<T>(kind: XeroDocKind, id: string, key: string): Promise<T> {
  const res = await xeroGet<Record<string, T[]>>(`${kind}/${id}`)
  if (!res.ok) throw new Error(`Xero GET ${kind}/${id} failed: ${res.error ?? 'unknown error'}`)
  const list = (res.data as Record<string, unknown>)?.[key] as T[] | undefined
  if (!list?.length) throw new Error(`Xero GET ${kind}/${id} returned no ${key}`)
  return list[0]
}

export const getInvoice = (id: string) => getOne<XeroInvoice>('Invoices', id, 'Invoices')
export const getCreditNote = (id: string) => getOne<XeroCreditNote>('CreditNotes', id, 'CreditNotes')
export const getManualJournal = (id: string) => getOne<XeroManualJournal>('ManualJournals', id, 'ManualJournals')

/**
 * The externalTransactionId the IMS recorded for a synced document — the handle that
 * makes read-back possible. Fails loudly rather than returning null: a missing id means
 * the sync did not actually complete, and a test asserting "no document" would be a
 * false pass.
 */
export async function externalIdFor(opts: {
  type: string
  referenceId: string
  timeoutMs?: number
}): Promise<string> {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
    let last: { status: string; error: string | null } | null = null
    while (Date.now() < deadline) {
      const r = await db.query<{ externalTransactionId: string | null; status: string; errorMessage: string | null }>(
        `select "externalTransactionId", status, "errorMessage" from accounting_sync_logs
          where connector = 'xero' and type = $1::"AccountingSyncType" and "referenceId" = $2
          order by "createdAt" desc limit 1`,
        [opts.type, opts.referenceId],
      )
      if (r.rows.length) {
        const row = r.rows[0]
        last = { status: row.status, error: row.errorMessage }
        if (row.status === 'SYNCED' && row.externalTransactionId) return row.externalTransactionId
        if (row.status === 'FAILED') {
          throw new Error(`${opts.type} for ${opts.referenceId} FAILED in Xero sync: ${row.errorMessage ?? 'no error recorded'}`)
        }
      }
      await new Promise((res) => setTimeout(res, 2_000))
    }
    throw new Error(
      `No SYNCED ${opts.type} with an externalTransactionId for ${opts.referenceId} within the timeout` +
        (last ? ` (last seen: status=${last.status}${last.error ? `, error=${last.error}` : ''})` : ' (no sync log row at all — was it ever queued?)'),
    )
  } finally {
    await db.end()
  }
}

// --- assertions --------------------------------------------------------------

/** Assert a line exists on the document with the given account + amount. */
export function expectLine(
  lines: XeroLine[],
  want: { accountCode: string; lineAmount?: number; taxType?: string },
): XeroLine {
  const hit = lines.find(
    (l) =>
      l.AccountCode === want.accountCode &&
      (want.lineAmount === undefined || Math.abs((l.LineAmount ?? 0) - want.lineAmount) < 0.005) &&
      (want.taxType === undefined || l.TaxType === want.taxType),
  )
  if (!hit) {
    throw new Error(
      `No Xero line matching ${JSON.stringify(want)}.\nActual lines:\n` +
        lines.map((l) => `  ${l.AccountCode} ${l.TaxType ?? '-'} ${l.LineAmount} "${l.Description ?? ''}"`).join('\n'),
    )
  }
  return hit
}

/** Assert a manual journal debits/credits an account by an amount (Xero signs LineAmount). */
export function expectJournalLine(
  lines: XeroJournalLine[],
  want: { accountCode: string; debit?: number; credit?: number },
): XeroJournalLine {
  const target = want.debit !== undefined ? want.debit : -(want.credit ?? 0)
  const hit = lines.find((l) => l.AccountCode === want.accountCode && Math.abs(l.LineAmount - target) < 0.005)
  if (!hit) {
    throw new Error(
      `No journal line for account ${want.accountCode} at ${want.debit !== undefined ? `DR ${want.debit}` : `CR ${want.credit}`}.\nActual lines:\n` +
        lines.map((l) => `  ${l.AccountCode} ${l.LineAmount} "${l.Description ?? ''}"`).join('\n'),
    )
  }
  return hit
}

// --- teardown ----------------------------------------------------------------

/**
 * Void/delete everything this run created in Xero.
 *
 * Best-effort per document: one undeletable journal must not strand the rest. Reports
 * what it could not remove instead of failing silently — residue in a SHARED Demo
 * ledger is exactly what breaks the next run's reconciliation assertions.
 */
export async function voidTrackedDocuments(): Promise<{ voided: number; failed: string[] }> {
  const failed: string[] = []
  let voided = 0
  const tracked = readRegistry()
  // Reverse order: allocations/payments before the documents they attach to.
  for (const t of [...tracked].reverse()) {
    try {
      // Xero has no DELETE verb here — status transitions are the delete, and which
      // transition is legal depends on the document's CURRENT state, not just its type.
      // So READ the state rather than assume it:
      //   - already VOIDED/DELETED -> nothing to do (re-voiding is an error, and a
      //     document already out of the ledger is exactly the outcome we want; assuming
      //     otherwise re-reported a cleaned-up journal as stranded on every later run);
      //   - a POSTED manual journal -> VOIDED ("The status 'DELETED' cannot be applied");
      //   - a DRAFT manual journal   -> DELETED.
      // Hardcoding DELETED for journals was invisible while journals never posted; the
      // moment PP-01 got one POSTED it stranded in the Demo ledger.
      const idField = t.kind === 'Invoices' ? 'InvoiceID' : t.kind === 'CreditNotes' ? 'CreditNoteID' : 'ManualJournalID'
      const current = await xeroGet<{ [k: string]: Array<{ Status?: string }> }>(`${t.kind}/${t.id}`)
      const status = current.ok ? current.data?.[t.kind]?.[0]?.Status : undefined

      if (status === 'VOIDED' || status === 'DELETED') {
        voided++ // already gone from the ledger
      } else {
        const target = t.kind === 'ManualJournals' && status === 'DRAFT' ? 'DELETED' : 'VOIDED'
        const res = await xeroPost(`${t.kind}/${t.id}`, { [idField]: t.id, Status: target })
        if (!res.ok) throw new Error(`${res.error ?? 'unknown error'} (document status was ${status ?? 'unreadable'})`)
        voided++
      }
    } catch (e) {
      failed.push(`${t.kind}/${t.id} (${t.label}): ${e instanceof Error ? e.message : e}`)
    }
  }
  // Keep anything we could NOT void, so a later attempt still knows about it; drop the
  // rest. Forgetting a document we failed to void would strand it silently.
  writeRegistry(tracked.filter((t) => failed.some((f) => f.includes(t.id))))
  if (failed.length) {
    console.warn(`[xero-teardown] ${failed.length} document(s) left in the ledger:\n  ${failed.join('\n  ')}`)
  }
  return { voided, failed }
}

/**
 * Find full-chain documents left behind by ANY earlier run — the safety net for a
 * teardown that never ran. Read-only; reports rather than deletes, because voiding a
 * document nobody is expecting is worse than a listed straggler.
 */
export async function findStragglers(tagPrefix = 'E2E-FC'): Promise<string[]> {
  const out: string[] = []
  const inv = await xeroGet<{ Invoices?: Array<{ InvoiceID: string; Reference?: string; Status: string }> }>(
    `Invoices?where=${encodeURIComponent(`Reference!=null&&Reference.StartsWith("${tagPrefix}")`)}`,
  )
  for (const i of inv.data?.Invoices ?? []) {
    if (i.Status !== 'VOIDED' && i.Status !== 'DELETED') out.push(`Invoice ${i.InvoiceID} (${i.Reference}) ${i.Status}`)
  }
  return out
}
