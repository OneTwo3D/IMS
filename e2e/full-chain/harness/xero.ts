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
import { getAccessToken } from '../../../lib/connectors/xero/auth.ts'

const XERO_BASE_URL = 'https://api.xero.com/api.xro/2.0'

/**
 * Authenticated DELETE against Xero. The production client (api.ts) only speaks GET/POST/PUT
 * because the app never deletes anything; teardown does — an allocation has to be removed with a
 * real DELETE before its credit note or bill can be voided. Kept here, in test-only cleanup code,
 * rather than widening the production client's verb surface for a need only the harness has.
 *
 * ALWAYS resolves — never rejects. A raw fetch throws on DNS/network/timeout, and this runs OUTSIDE
 * the per-kind try/catch below, so a throw here would abort cleanup of every remaining document and
 * strand it in the shared ledger. Timed out at 30s to match the production transport rather than
 * hang teardown indefinitely.
 */
async function xeroDelete(path: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const auth = await getAccessToken()
  if (!auth) return { ok: false, status: 0, error: 'Not connected to Xero' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${XERO_BASE_URL}/${path}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (res.ok) return { ok: true, status: res.status }
    return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 300) }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

export type XeroDocKind = 'Invoices' | 'CreditNotes' | 'ManualJournals' | 'PurchaseOrders' | 'Payments'

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
  Payments?: Array<{ PaymentID: string; Amount?: number; Date?: string; Account?: { AccountID?: string; Code?: string } }>
  LineItems: XeroLine[]
}
export type XeroCreditNote = {
  CreditNoteID: string
  CreditNoteNumber?: string
  Type: string
  Status: string
  Total: number
  SubTotal: number
  CurrencyCode: string
  Reference?: string
  LineItems: XeroLine[]
  Allocations?: Array<{ AllocationID?: string; Amount?: number; Invoice?: { InvoiceID?: string } }>
}
export type XeroJournalLine = { AccountCode: string; Description?: string; LineAmount: number; TaxType?: string }
export type XeroManualJournal = {
  ManualJournalID: string
  Status: string
  Narration: string
  Date?: string
  JournalLines: XeroJournalLine[]
}

export type XeroTaxComponent = { Name: string; Rate: number; IsCompound?: boolean; IsNonRecoverable?: boolean }
export type XeroTaxRate = {
  Name: string
  TaxType: string
  Status: string
  ReportTaxType?: string
  EffectiveRate?: number
  TaxComponents?: XeroTaxComponent[]
}

/**
 * The live tax rates Xero holds (X-04), minus DELETED/ARCHIVED — matching what the drift sweeper reads
 * (lib/connectors/xero/tax-rates.ts). X-04 mirrors one of these into the IMS to establish a clean
 * (no-drift) baseline, then perturbs the IMS copy to prove the sweep detects the divergence. Reads LIVE
 * (not the cached reference path) so the seed matches exactly what the sweep will compare against.
 */
export async function getXeroTaxRates(): Promise<XeroTaxRate[]> {
  const res = await xeroGet<{ TaxRates?: XeroTaxRate[] }>('TaxRates')
  if (!res.ok) throw new Error(`Xero GET TaxRates failed: ${res.error ?? 'unknown error'}`)
  const rates = (res.data as { TaxRates?: XeroTaxRate[] })?.TaxRates ?? []
  return rates.filter((r) => r.Status !== 'DELETED' && r.Status !== 'ARCHIVED')
}

async function getOne<T>(kind: XeroDocKind, id: string, key: string): Promise<T> {
  const res = await xeroGet<Record<string, T[]>>(`${kind}/${id}`)
  if (!res.ok) throw new Error(`Xero GET ${kind}/${id} failed: ${res.error ?? 'unknown error'}`)
  const list = (res.data as Record<string, unknown>)?.[key] as T[] | undefined
  if (!list?.length) throw new Error(`Xero GET ${kind}/${id} returned no ${key}`)
  return list[0]
}

/** The attachments Xero holds against an invoice/bill — used to prove a BILL_ATTACHMENT rode all the way in. */
export async function getInvoiceAttachments(invoiceId: string): Promise<Array<{ FileName: string; MimeType?: string }>> {
  const res = await xeroGet<{ Attachments?: Array<{ FileName: string; MimeType?: string }> }>(`Invoices/${invoiceId}/Attachments`)
  if (!res.ok) throw new Error(`Xero GET Invoices/${invoiceId}/Attachments failed: ${res.error ?? 'unknown error'}`)
  return res.data?.Attachments ?? []
}

export type XeroPayment = {
  PaymentID: string
  Amount?: number
  Status?: string
  Reference?: string
  // GET /Payments/{id} carries the full bank account (the invoice's own Payments sub-resource does not),
  // which is why a payment assertion on the drawn-from account must read the payment, not the invoice.
  Account?: { AccountID?: string; Code?: string; Name?: string }
  Invoice?: { InvoiceID?: string }
}

export const getInvoice = (id: string) => getOne<XeroInvoice>('Invoices', id, 'Invoices')
export const getCreditNote = (id: string) => getOne<XeroCreditNote>('CreditNotes', id, 'CreditNotes')
export const getManualJournal = (id: string) => getOne<XeroManualJournal>('ManualJournals', id, 'ManualJournals')
export const getPayment = (id: string) => getOne<XeroPayment>('Payments', id, 'Payments')

/**
 * The IMS bill ids on a PO, oldest first.
 *
 * PURCHASE_INVOICE sync logs are keyed on the BILL, not the PO (o3d-9oq), so a test that wants
 * "this PO's bills" has to resolve them itself. That indirection is the point: it means each
 * assertion is about a NAMED bill's own ledger document rather than whichever one a heuristic
 * happened to pick.
 */
export async function billIdsForPo(poId: string): Promise<string[]> {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ id: string }>(
      `select id from purchase_invoices where "poId" = $1 order by "createdAt" asc`,
      [poId],
    )
    return r.rows.map((row) => row.id)
  } finally {
    await db.end()
  }
}

/**
 * Every externalTransactionId of `type` for a reference, oldest first, once at least
 * `expected` have SYNCED.
 *
 * Needed because one reference can legitimately produce SEVERAL documents: STOCK_RECEIPT keys
 * on the PO id (purchase-orders.ts:1980), so a PO received in two deliveries has two receipt
 * journals under the same referenceId. externalIdFor takes `limit 1` ordered by createdAt DESC,
 * so asking it for "the" journal silently answers with the LAST one — a test checking transit
 * across both receipts would read one journal, find it balanced, and pass while the other was
 * missing entirely.
 *
 * Waits for `expected` rather than returning what exists: the sync is asynchronous, so a naive
 * read races the queue and would see one journal simply because the second had not posted yet.
 */
export async function externalIdsFor(opts: {
  type: string
  referenceId: string
  expected: number
  timeoutMs?: number
}): Promise<string[]> {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
    let seen = 0
    while (Date.now() < deadline) {
      const r = await db.query<{ externalTransactionId: string | null; status: string; errorMessage: string | null }>(
        `select "externalTransactionId", status, "errorMessage" from accounting_sync_logs
          where connector = 'xero' and type = $1::"AccountingSyncType" and "referenceId" = $2
          order by "createdAt" asc`,
        [opts.type, opts.referenceId],
      )
      const failed = r.rows.find((row) => row.status === 'FAILED')
      if (failed) {
        throw new Error(`${opts.type} for ${opts.referenceId} FAILED in Xero sync: ${failed.errorMessage ?? 'no error recorded'}`)
      }
      // DEDUPE. Two SYNCED rows can carry the SAME externalTransactionId — that is precisely the
      // o3d-6l3 failure (a second bill upserting over the first and being handed its id back).
      // Counting rows rather than distinct DOCUMENTS would let this test fetch one Xero bill
      // twice, count it as two, and balance it against two receipts. It would pass while the
      // ledger held half the payables.
      const ids = [...new Set(
        r.rows
          .filter((row) => row.status === 'SYNCED' && row.externalTransactionId)
          .map((row) => row.externalTransactionId as string),
      )]
      seen = ids.length
      if (ids.length >= opts.expected) return ids
      await new Promise((res) => setTimeout(res, 2_000))
    }
    throw new Error(
      `Expected ${opts.expected} DISTINCT SYNCED ${opts.type} document(s) for ${opts.referenceId} but saw ${seen} ` +
        `within the timeout. Fewer distinct ids than sync rows means two rows resolved to ONE ledger document.`,
    )
  } finally {
    await db.end()
  }
}

/**
 * The externalTransactionId the IMS recorded for a synced document — the handle that
 * makes read-back possible. Fails loudly rather than returning null: a missing id means
 * the sync did not actually complete, and a test asserting "no document" would be a
 * false pass.
 *
 * Returns the MOST RECENT when several exist for the reference; use externalIdsFor when more
 * than one is expected.
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

/**
 * EVERY accounting_sync_log row of `type` for `referenceId`, whatever its status — the read-back for
 * asserting a document was DELIBERATELY NOT QUEUED (suppression), which externalIdFor cannot express:
 * it waits for a SYNCED row and throws on absence, so it can only prove presence.
 *
 * The three states an assertion must distinguish, and why the row list is what separates them:
 *   - suppressed      -> NO rows at all (the enqueue chokepoint declined it; nothing was ever asked of Xero)
 *   - queued + failed -> a FAILED row (Xero rejected it — the o3d-lgo.6.1 defect looked exactly like this)
 *   - queued + posted -> a SYNCED row carrying an externalTransactionId
 * Asserting only "no POSTED document in Xero" would pass for all three.
 *
 * PROVING ABSENCE, NOT RACING IT. The queue is asynchronous, so an empty list can just mean "not yet".
 * Callers MUST first observe an artifact enqueued by the SAME server action — e.g. PP-08 waits for the
 * BILL_PAYMENT that markBillPaid queues immediately before its FX-journal decision — so by the time this
 * is read, the enqueue that would have written the row has already happened, or been declined.
 */
export async function syncLogRowsFor(opts: {
  type: string
  referenceId: string
}): Promise<Array<{ status: string; externalTransactionId: string | null; errorMessage: string | null }>> {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ status: string; externalTransactionId: string | null; errorMessage: string | null }>(
      `select status, "externalTransactionId", "errorMessage" from accounting_sync_logs
        where connector = 'xero' and type = $1::"AccountingSyncType" and "referenceId" = $2
        order by "createdAt" asc`,
      [opts.type, opts.referenceId],
    )
    return r.rows
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

const ID_FIELD = {
  Invoices: 'InvoiceID',
  CreditNotes: 'CreditNoteID',
  ManualJournals: 'ManualJournalID',
  PurchaseOrders: 'PurchaseOrderID',
  Payments: 'PaymentID',
} as const

/**
 * Kinds that support `GET /{kind}?IDs=a,b,c` — one call for the whole set.
 *
 * ManualJournals is deliberately ABSENT: Xero documents the IDs filter for Invoices and
 * CreditNotes, not for ManualJournals. An unsupported filter is not an error there, it is
 * IGNORED — the endpoint would cheerfully return page 1 of every journal in the org, and we
 * would read a stranger's statuses and "void" nothing. Journals therefore keep one read each.
 */
const SUPPORTS_IDS_FILTER = new Set(['Invoices', 'CreditNotes'])

/**
 * Order kinds so a document is never voided before the things attached to it.
 *
 * This replaces the old blanket `[...tracked].reverse()`, which got the same effect by accident
 * of insertion order. A credit note allocated to a bill must go first, or voiding the bill is
 * rejected while the allocation still points at it. Journals stand alone and can go any time.
 *
 * Payments go FIRST: Xero refuses to void an invoice or bill "as it has a payment … allocated to
 * it", so a tracked payment must be deleted (reversed) before the invoice/bill it settles can be
 * voided in the same teardown pass. A payment is removed with Status=DELETED (there is no VOIDED for
 * payments), which the void loop applies via the same batch POST used for every other kind.
 */
const VOID_ORDER: ReadonlyArray<string> = ['Payments', 'ManualJournals', 'CreditNotes', 'Invoices', 'PurchaseOrders']

/** Read the current status of every tracked document of one kind, in as few calls as possible. */
async function statusesFor(kind: string, ids: string[]): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>()

  if (SUPPORTS_IDS_FILTER.has(kind)) {
    const res = await xeroGet<{ [k: string]: Array<{ Status?: string; [f: string]: unknown }> }>(
      `${kind}?IDs=${ids.join(',')}`,
    )
    if (res.ok) {
      for (const doc of res.data?.[kind] ?? []) {
        const id = String(doc[ID_FIELD[kind as keyof typeof ID_FIELD]] ?? '')
        if (id) out.set(id.toLowerCase(), doc.Status)
      }
      // Anything Xero did not return simply has no status; the caller treats that as unreadable
      // rather than as absent, which is the same conservative behaviour as before.
      return out
    }
    // Fall through to per-document reads: a filter failure must not skip the clean-up entirely.
  }

  for (const id of ids) {
    const res = await xeroGet<{ [k: string]: Array<{ Status?: string }> }>(`${kind}/${id}`)
    out.set(id.toLowerCase(), res.ok ? res.data?.[kind]?.[0]?.Status : undefined)
  }
  return out
}

/**
 * Void/delete everything this run created in Xero.
 *
 * Best-effort per document: one undeletable journal must not strand the rest. Reports
 * what it could not remove instead of failing silently — residue in a SHARED Demo
 * ledger is exactly what breaks the next run's reconciliation assertions.
 *
 * BATCHED, because clean-up was the single biggest consumer of a very small budget. It used to
 * cost TWO calls per document — a GET for the status then a POST to void — so a 15-document run
 * spent ~30 calls tearing down. Xero's free tier allows 1,000 calls per org per ROLLING 24h
 * (cut from 5,000 on 2026-03-02), so teardown alone was ~3% of a day's budget per run and the
 * suite exhausted the org in a day's development (o3d-98q). Reads now go one call per kind where
 * Xero supports an IDs filter, and every write is a single array POST per kind: ~30 calls becomes
 * ~6. Xero accepts an array on these endpoints and reports per-document problems inline when
 * asked not to summarise them.
 */
export async function voidTrackedDocuments(): Promise<{ voided: number; failed: string[] }> {
  const failed: string[] = []
  let voided = 0
  const tracked = readRegistry()

  const byKind = new Map<string, typeof tracked>()
  for (const t of tracked) {
    const list = byKind.get(t.kind) ?? []
    list.push(t)
    byKind.set(t.kind, list)
  }

  // Un-allocate before voiding. An allocation locks BOTH ends: Xero refuses to void a credit note
  // "as it has a payment or credit note allocated to it" and equally refuses the bill it lands on
  // ("VOIDED cannot be applied … it has payments or credit notes allocated"). PP-05 is the first
  // test to create one, so this is the first teardown that has to undo it. Deleting the allocation
  // from the credit-note side frees both, after which the normal void loop below succeeds.
  //
  // Deleting an allocation IRREVERSIBLY mutates a SHARED ledger (the Demo tenant is also stage's),
  // so the finding was right that registry membership of the credit note alone is too weak — a
  // stale/mis-mapped external id could name a real note. The guard is PAIR-OWNERSHIP: delete an
  // allocation only when BOTH ends are ours — the credit note is one WE tracked (we are iterating
  // the registry) AND the allocation's target invoice is ALSO a tracked test bill. A real note's
  // allocations land on real bills, which are never in our tracked set, so they are left untouched
  // (Codex review of PR #495).
  //
  // We deliberately do NOT gate on an "E2E-FC" tag in the credit note's Reference: the IMS-generated
  // return credit note is referenced like "RTN-PO-…", carrying no such prefix, so that check
  // false-rejected the test's own note. The tracked-target-invoice gate is the real, sufficient
  // safety and never false-rejects.
  const trackedInvoiceIds = new Set(
    (byKind.get('Invoices') ?? []).map((t) => t.id.toLowerCase()),
  )
  for (const cn of byKind.get('CreditNotes') ?? []) {
    const res = await xeroGet<{ CreditNotes?: XeroCreditNote[] }>(`CreditNotes/${cn.id}`)
    const note = res.ok ? res.data?.CreditNotes?.[0] : undefined
    if (!note) continue // gone already, or unreadable — the void loop below will report it

    for (const a of note.Allocations ?? []) {
      if (!a.AllocationID) continue
      // Only touch an allocation that lands on a bill we created and tracked.
      const targetInvoiceId = a.Invoice?.InvoiceID?.toLowerCase()
      if (!targetInvoiceId || !trackedInvoiceIds.has(targetInvoiceId)) {
        failed.push(`CreditNotes/${cn.id} (${cn.label}): allocation ${a.AllocationID} targets untracked invoice ${a.Invoice?.InvoiceID ?? '(unknown)'} — refusing to delete (shared ledger)`)
        continue
      }
      const del = await xeroDelete(`CreditNotes/${cn.id}/Allocations/${a.AllocationID}`)
      if (!del.ok) {
        // Isolated per allocation: one failed DELETE is recorded but must not abort cleanup of the
        // remaining credit notes, bills, journals and POs below.
        failed.push(`CreditNotes/${cn.id} (${cn.label}): could not remove allocation ${a.AllocationID}: ${del.error ?? del.status}`)
      }
    }
  }

  const kinds = [...byKind.keys()].sort(
    (a, b) => (VOID_ORDER.indexOf(a) + 1 || 99) - (VOID_ORDER.indexOf(b) + 1 || 99),
  )

  for (const kind of kinds) {
    const docs = byKind.get(kind) ?? []
    const idField = ID_FIELD[kind as keyof typeof ID_FIELD] ?? 'InvoiceID'

    try {
      const statuses = await statusesFor(kind, docs.map((d) => d.id))

      // Xero has no DELETE verb here — status transitions are the delete, and which transition
      // is legal depends on the document's CURRENT state, not just its type:
      //   - already VOIDED/DELETED -> nothing to do (re-voiding is an error, and a document
      //     already out of the ledger is exactly the outcome we want; assuming otherwise
      //     re-reported a cleaned-up journal as stranded on every later run);
      //   - a POSTED manual journal -> VOIDED ("The status 'DELETED' cannot be applied");
      //   - a DRAFT manual journal   -> DELETED.
      // Hardcoding DELETED for journals was invisible while journals never posted; the moment
      // PP-01 got one POSTED it stranded in the Demo ledger.
      const payload: Array<Record<string, string>> = []
      for (const d of docs) {
        const status = statuses.get(d.id.toLowerCase())
        if (status === 'VOIDED' || status === 'DELETED') {
          voided++ // already gone from the ledger
          continue
        }
        payload.push({
          [idField]: d.id,
          // Payments can only be removed with DELETED (there is no VOIDED payment); a DRAFT manual
          // journal is DELETED, a POSTED one is VOIDED; everything else voids.
          Status: kind === 'Payments' ? 'DELETED'
            : kind === 'ManualJournals' && status === 'DRAFT' ? 'DELETED'
            : 'VOIDED',
        })
      }
      if (!payload.length) continue

      // summarizeErrors=false: report per-document problems instead of rejecting the whole
      // array on the first bad one. Without it a single undeletable document would strand every
      // other document in the batch — the exact failure the per-document loop existed to avoid.
      const res = await xeroPost(`${kind}?summarizeErrors=false`, { [kind]: payload })
      if (!res.ok) {
        for (const p of payload) {
          const d = docs.find((x) => x.id === p[idField])
          failed.push(`${kind}/${p[idField]} (${d?.label ?? '?'}): ${res.error ?? 'unknown error'}`)
        }
        continue
      }

      // Trust the ledger, not the HTTP status: with summarizeErrors=false a 200 can still carry
      // documents that were rejected, each with its own ValidationErrors.
      const returned = (res.data as { [k: string]: Array<Record<string, unknown>> } | undefined)?.[kind] ?? []
      for (const p of payload) {
        const d = docs.find((x) => x.id === p[idField])
        const back = returned.find((r) => String(r[idField] ?? '').toLowerCase() === p[idField].toLowerCase())
        const errs = (back?.ValidationErrors as Array<{ Message?: string }> | undefined) ?? []
        if (errs.length) {
          failed.push(`${kind}/${p[idField]} (${d?.label ?? '?'}): ${errs.map((e) => e.Message).join('; ')}`)
        } else if (back?.Status === p.Status || back?.Status === 'VOIDED' || back?.Status === 'DELETED') {
          voided++
        } else {
          failed.push(
            `${kind}/${p[idField]} (${d?.label ?? '?'}): asked for ${p.Status}, ledger says ${String(back?.Status ?? 'nothing')}`,
          )
        }
      }
    } catch (e) {
      for (const d of docs) {
        failed.push(`${kind}/${d.id} (${d.label}): ${e instanceof Error ? e.message : e}`)
      }
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

  // INVOICES + CREDIT NOTES carry our Reference, so Xero can filter them server-side.
  const inv = await xeroGet<{ Invoices?: Array<{ InvoiceID: string; Reference?: string; Status: string }> }>(
    `Invoices?where=${encodeURIComponent(`Reference!=null&&Reference.StartsWith("${tagPrefix}")`)}`,
  )
  for (const i of inv.data?.Invoices ?? []) {
    if (!isGoneFromLedger(i.Status)) out.push(`Invoice ${i.InvoiceID} (${i.Reference}) ${i.Status}`)
  }
  const cn = await xeroGet<{ CreditNotes?: Array<{ CreditNoteID: string; Reference?: string; Status: string }> }>(
    `CreditNotes?where=${encodeURIComponent(`Reference!=null&&Reference.StartsWith("${tagPrefix}")`)}`,
  )
  for (const c of cn.data?.CreditNotes ?? []) {
    if (!isGoneFromLedger(c.Status)) out.push(`CreditNote ${c.CreditNoteID} (${c.Reference}) ${c.Status}`)
  }

  // MANUAL JOURNALS are the gap this closes (o3d-lgo.7.1). They were invisible to this scan, which is the
  // one class of document the tracked-registry teardown can miss: when Xero accepts the POST but the id
  // write-back is lost, NO read of accounting_sync_logs can name the document, so it can only be found from
  // the Xero side. And journals are the most consequential to leave live — X-02's transit reconciliation and
  // the batch tie-outs compare GL movement against the IMS subledger, so a stray journal makes a LATER run
  // fail for reasons that have nothing to do with it.
  //
  // Two reasons this cannot mirror the invoice filter. A ManualJournal has no Reference field at all, only a
  // Narration, and Xero does not support StartsWith filtering on it. So the tag match is client-side over a
  // date-bounded page — journals dated today or later, which is the window a full-chain run posts into.
  const mj = await xeroGet<{ ManualJournals?: Array<{ ManualJournalID: string; Narration?: string; Status: string; Date?: string }> }>(
    `ManualJournals?where=${encodeURIComponent(`Date>=DateTime(${todayForXeroWhere()})`)}`,
  )
  for (const j of mj.data?.ManualJournals ?? []) {
    if (isGoneFromLedger(j.Status)) continue
    // REPORT-ONLY, and tag-matched narrations are reported separately from the rest. A date window is not
    // ownership: the Demo org is shared, and voiding a journal nobody is expecting is worse than listing a
    // straggler (the same principle this scan was built on). An untagged journal in the window is still worth
    // naming, because the narration of an IMS journal usually carries a PO/order reference, not the run tag.
    const tagged = j.Narration?.includes(tagPrefix)
    out.push(
      `ManualJournal ${j.ManualJournalID} (${j.Narration ?? 'no narration'}) ${j.Status}` +
        (tagged ? ' [run-tagged]' : ' [dated in the run window; verify before voiding]'),
    )
  }
  return out
}

/** A document already VOIDED/DELETED is out of the ledger — exactly the outcome teardown wants, not a straggler. */
function isGoneFromLedger(status: string): boolean {
  return status === 'VOIDED' || status === 'DELETED'
}

/**
 * Today as Xero's `DateTime(yyyy,mm,dd)` where-clause literal — its filter syntax takes that form, not an
 * ISO string. Bounded to today because a full-chain run posts documents dated today (or, for a deliberately
 * future-dated payment, later), so this is the narrowest window that cannot miss the run's own journals.
 */
function todayForXeroWhere(): string {
  const now = new Date()
  return `${now.getUTCFullYear()},${now.getUTCMonth() + 1},${now.getUTCDate()}`
}
