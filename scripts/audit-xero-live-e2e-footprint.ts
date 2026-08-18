/**
 * o3d-t74p — READ-ONLY discovery of the e2e footprint in the LIVE Xero organisation.
 *
 * WHY THIS EXISTS ALONGSIDE audit-xero-live-contamination.ts
 * ----------------------------------------------------------
 * That script looks up the 553 externalTransactionIds recorded in the e2e database. Run against
 * the live org (One Two Enterprises Ltd, dd2af957-3438-4010-8e85-7841c33c8328) not one of them
 * came back present — while the same org demonstrably held 150 E2E invoices dated inside the
 * incident window. The stored ids are NOT this organisation's objects; they belong to the Demo
 * tenant the instance spent most of that period pointed at.
 *
 * THE ORG HAS SINCE BEEN WRITTEN TO. A cleanup ran against it on 2026-08-10 between 08:01 and
 * 08:43 (o3d-7thb), so every count in this header describes the org BEFORE that run, not now:
 * those 150 invoices are VOIDED, 35 of 36 non-SUBMITTED credit notes are VOIDED, the 111 contacts
 * are archived and the 217 items are deleted. 13 SUBMITTED and 1 AUTHORISED credit note remain
 * (o3d-k8ic). Re-run this script before quoting any number from it.
 *
 * HOW STRONG IS "NOT ONE OF THEM CAME BACK"
 * -----------------------------------------
 * Stronger from THIS script than from the id lookups, and it is worth being exact about which.
 * Of the 553, only 14 (the payments) were confirmed by an HTTP 404 on their own id; 288 were
 * merely absent from a collection read, and 251 (the manual journals) were never fetched by id at
 * all — see the header of audit-xero-live-contamination.ts, which now reports that distinction
 * per row. What actually carries the Demo attribution is the CROSS-CHECK below: this script indexes
 * the org by the fixtures' own naming, entirely independently of the sync log, and finds 0 of the
 * 553 among the objects it holds. Two unrelated indexes agreeing is the evidence.
 *
 * That cross-check does NOT cover manual journals — they carry no contact, so they are not in this
 * footprint at all. For the 251 journal ids the honest verdict is UNKNOWN unless the contamination
 * audit is re-run with its per-id confirmation enabled.
 *
 * CALL BUDGET. Xero's daily cap is as low as 1,000/org/rolling-24h on some plans. A full re-audit
 * (this script, plus audit-xero-live-contamination.ts with per-id confirmation, plus a cleanup dry
 * run) is on the order of a thousand calls between them. Sequence them across days rather than
 * discovering the cap mid-run.
 *
 * So the sync log is the wrong index for "what is in the live org", and any cleanup driven from it
 * would have touched nothing while reporting success. The only reliable index is the ORGANISATION
 * ITSELF, keyed on the one thing the fixtures always stamp: the full-chain naming grammar.
 *
 * THIS SCRIPT'S OUTPUT IS THE WRITE MANIFEST. remove-xero-live-e2e-footprint.ts refuses to --apply
 * without it, so the CSV carries a `tenantId` column on every row: an id list that cannot say which
 * organisation it describes is exactly the defect (o3d-s36z) that produced this incident, and it
 * may not authorise an irreversible write. READ the CSV before passing it to the writer.
 *
 * Everything here is a GET. There is no post/put/delete helper, by construction.
 *
 * USAGE
 *   node_modules/.bin/tsx scripts/audit-xero-live-e2e-footprint.ts [--out <path>] [--csv <path>]
 *
 * Reuses the cached read-only token from audit-xero-live-contamination.ts
 * (/root/.xero-audit-token.json), so it needs no consent of its own.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

import {
  assertNoNearMisses,
  classifyContactName,
  classifyItemCode,
  createXeroTransport,
  creditNoteBlockers,
  formatBlockers,
  invoiceBlockers,
  isFixtureContactName,
  isFixtureItemCode,
  pageAllComplete,
} from './lib/xero-live-safety'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const TOKEN_FILE = arg('token-file', '/root/.xero-audit-token.json')!
const OUT_PATH = arg('out', `./xero-live-e2e-footprint-${new Date().toISOString().slice(0, 10)}.csv`)!
const CSV_PATH = arg('csv', '/root/xero-live-e2e-contamination-20260804.csv')!
const MAX_CALLS = Number(arg('max-calls', '400'))

/**
 * The SERVER-SIDE filter only. Xero's `where` cannot express an exact whole-name match, so the
 * query is necessarily a prefix — but nothing is SELECTED on the strength of it. Everything the
 * filter returns is classified locally against the exact fixture grammar in
 * scripts/lib/xero-live-safety.ts (`E2E E2E-FC-<runId>` / `E2E-FC-<RUNID>-<LABEL>`), and anything
 * that carries the E2E token without matching that grammar ABORTS this script rather than being
 * written into the manifest. `E2E Consulting Ltd` is a perfectly plausible real supplier and the
 * prefix would match it; the writer this feeds VOIDS what the manifest lists.
 */
const CONTACT_QUERY_PREFIX = 'E2E '
const WINDOW_FROM = '2026-07-15'
const WINDOW_TO = '2026-07-27'

type StoredToken = { accessToken: string; tenantId: string; tenantName: string }

/**
 * The shared transport, built read-only (`apply: false`), so this file cannot alter the live ledger
 * — the transport THROWS on any verb other than GET without --apply, and this script never passes
 * one. It replaces a hand-rolled client that was a copy of the writer's, including the writer's
 * since-fixed 429 defect: the retry refunded the call budget (`callCount--`) and recursed with no
 * retry counter, so an endpoint answering 429 indefinitely retried for ever and the call ceiling —
 * the one thing that could have stopped it — could never be reached. There is now one client, so
 * that defect cannot be fixed in one copy and left in another.
 */
const transport = createXeroTransport({
  apply: false,
  maxCalls: MAX_CALLS,
  minIntervalMs: 1200,
  log: (m) => console.log(m),
})

const xeroGet = <T,>(token: StoredToken, path: string) => transport.request<T>(token, 'GET', path)

/**
 * Page to proven completeness, via the shared helper. Three endings, and only two are success: an
 * empty page (collection exhausted), or a page that repeats the previous one (Xero ignored `page`,
 * so page 1 was already the whole collection). A failed page or the page ceiling THROWS — a
 * truncated read here becomes an under-reported manifest, and an object missing from the manifest
 * is a footprint left behind in a real ledger.
 */
async function pageAll<T>(token: StoredToken, path: string, key: string, idOf: (row: T) => string): Promise<T[]> {
  return pageAllComplete<T>({
    read: <R,>(p: string) => xeroGet<R>(token, p),
    path,
    key,
    idOf,
    log: (m) => console.log(m),
  })
}

function xeroDate(value?: string): string {
  if (!value) return ''
  const m = /\/Date\((-?\d+)/.exec(value)
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : value
}

/**
 * A manifest row. `tenantId`, `status`, `contact`, `blockers` and `updatedDateUtc` are not
 * decoration — they are the STATE the reviewer signs off, and the writer refuses to act on any
 * object that has moved away from them. A uuid alone says which object a human approved; it cannot
 * say what they approved doing to it, so a credit note reviewed as SUBMITTED and since approved by
 * a person would still be authorised by its uuid.
 */
type Row = {
  /** Which organisation this row describes. Mandatory: the manifest is worthless without it. */
  tenantId: string
  entity: string
  uuid: string
  number: string
  status: string
  /** The document's own date (invoices/credit notes) or last-updated day. Informational. */
  date: string
  /** Xero's RAW UpdatedDateUTC. Compared byte-for-byte by the writer, so it is not reformatted. */
  updatedDateUtc: string
  total: string
  currency: string
  contact: string
  blockers: string
  cleanupStep: string
  note: string
}

function toCsv(rows: Row[]): string {
  const cols: Array<keyof Row> = ['tenantId', 'cleanupStep', 'entity', 'uuid', 'number', 'status', 'date', 'updatedDateUtc', 'total', 'currency', 'contact', 'blockers', 'note']
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(String(r[c] ?? ''))).join(','))].join('\n')
}

async function main() {
  if (!existsSync(TOKEN_FILE)) throw new Error(`No cached token at ${TOKEN_FILE}. Run audit-xero-live-contamination.ts first to authorize.`)
  const token = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as StoredToken

  const org = await xeroGet<{ Organisations?: Array<{ Name: string; PeriodLockDate?: string; EndOfYearLockDate?: string }> }>(token, 'Organisation')
  if (!org.ok || !org.data?.Organisations?.length) throw new Error(`Could not read Organisation: HTTP ${org.status}`)
  const o = org.data.Organisations[0]
  const lock = xeroDate(o.PeriodLockDate) || xeroDate(o.EndOfYearLockDate)
  console.log(`=== ${o.Name} (${token.tenantId}) ===`)
  console.log(`Lock date: ${lock || '(none)'} — the window is ${WINDOW_FROM}..${WINDOW_TO}`)
  console.log(lock && lock >= WINDOW_FROM
    ? '  => lock COVERS the window: void will be refused, these must be reversed instead'
    : '  => lock does NOT cover the window: void/delete is available')

  const contactWhere = encodeURIComponent(`Contact.Name.StartsWith("${CONTACT_QUERY_PREFIX}")`)
  const rows: Row[] = []

  console.log('\n--- invoices with an E2E contact ---')
  type Inv = { InvoiceID: string; Type: string; InvoiceNumber?: string; Status: string; Date?: string; UpdatedDateUTC?: string; Total?: number; AmountPaid?: number; CurrencyCode?: string; Contact?: { Name?: string }; Payments?: Array<{ PaymentID: string }>; CreditNotes?: Array<{ CreditNoteID: string }> }
  const allInvoices = await pageAll<Inv>(token, `Invoices?where=${contactWhere}`, 'Invoices', (i) => i.InvoiceID)
  assertNoNearMisses(allInvoices.map((i) => ({ label: i.InvoiceNumber ?? i.InvoiceID, value: i.Contact?.Name })), classifyContactName, 'invoice contacts')
  const invoices = allInvoices.filter((i) => isFixtureContactName(i.Contact?.Name))
  console.log(`  ${invoices.length} (of ${allInvoices.length} returned by the prefix filter)`)
  for (const i of invoices) {
    // The SHARED blocker grammar. The writer derives its blocker sets with the same function and
    // refuses any object whose set has moved, so the two files have to name blockers identically —
    // two spellings of the same allocation would make every document look changed and turn the
    // check into noise, which is how a safety check ends up switched off.
    const blockers = invoiceBlockers(i)
    rows.push({
      tenantId: token.tenantId,
      entity: i.Type === 'ACCPAY' ? 'bill' : 'invoice',
      uuid: i.InvoiceID, number: i.InvoiceNumber ?? '', status: i.Status,
      date: xeroDate(i.Date), updatedDateUtc: i.UpdatedDateUTC ?? '',
      total: String(i.Total ?? ''), currency: i.CurrencyCode ?? '',
      contact: i.Contact?.Name ?? '', blockers: formatBlockers(blockers),
      // Anything holding an allocation or payment must be released before the void is accepted.
      cleanupStep: blockers.length ? '3-void-after-releasing-blockers' : '3-void',
      note: '',
    })
  }

  console.log('--- credit notes with an E2E contact ---')
  // Payments on a credit note are REFUNDS, and a refund blocks the void exactly as an allocation
  // does. The writer counts them as blockers, so the manifest has to record them too — otherwise
  // every credit note carrying one reads as "changed since review" for a difference that is only
  // in what the two scripts bothered to look at.
  type CN = { CreditNoteID: string; Type: string; CreditNoteNumber?: string; Status: string; Date?: string; UpdatedDateUTC?: string; Total?: number; CurrencyCode?: string; Contact?: { Name?: string }; Allocations?: Array<{ AllocationID?: string; Invoice?: { InvoiceID: string } }>; Payments?: Array<{ PaymentID: string }> }
  const allCreditNotes = await pageAll<CN>(token, `CreditNotes?where=${contactWhere}`, 'CreditNotes', (c) => c.CreditNoteID)
  assertNoNearMisses(allCreditNotes.map((c) => ({ label: c.CreditNoteNumber ?? c.CreditNoteID, value: c.Contact?.Name })), classifyContactName, 'credit-note contacts')
  const creditNotes = allCreditNotes.filter((c) => isFixtureContactName(c.Contact?.Name))
  console.log(`  ${creditNotes.length} (of ${allCreditNotes.length} returned by the prefix filter)`)
  for (const c of creditNotes) {
    const blockers = creditNoteBlockers(c)
    rows.push({
      tenantId: token.tenantId,
      entity: 'creditnote', uuid: c.CreditNoteID, number: c.CreditNoteNumber ?? '', status: c.Status,
      date: xeroDate(c.Date), updatedDateUtc: c.UpdatedDateUTC ?? '',
      total: String(c.Total ?? ''), currency: c.CurrencyCode ?? '',
      contact: c.Contact?.Name ?? '', blockers: formatBlockers(blockers),
      cleanupStep: blockers.length ? '2-remove-allocation-then-void' : '2-void',
      note: '',
    })
  }

  console.log('--- E2E contacts ---')
  type Ct = { ContactID: string; Name: string; ContactStatus: string; UpdatedDateUTC?: string; IsCustomer?: boolean; IsSupplier?: boolean }
  const allContacts = await pageAll<Ct>(token, `Contacts?where=${encodeURIComponent(`Name.StartsWith("${CONTACT_QUERY_PREFIX}")`)}`, 'Contacts', (c) => c.ContactID)
  assertNoNearMisses(allContacts.map((c) => ({ label: c.ContactID, value: c.Name })), classifyContactName, 'contacts')
  const contacts = allContacts.filter((c) => isFixtureContactName(c.Name))
  console.log(`  ${contacts.length} (of ${allContacts.length} returned by the prefix filter)`)
  for (const c of contacts) {
    rows.push({
      tenantId: token.tenantId,
      entity: 'contact', uuid: c.ContactID, number: '', status: c.ContactStatus,
      date: xeroDate(c.UpdatedDateUTC), updatedDateUtc: c.UpdatedDateUTC ?? '',
      total: '', currency: '', contact: c.Name,
      blockers: '', cleanupStep: '4-archive',
      note: 'a contact with transactions cannot be deleted, only archived',
    })
  }

  console.log('--- E2E items ---')
  type It = { ItemID: string; Code: string; Name?: string; UpdatedDateUTC?: string }
  // PAGED, not an unpaged GET. An unpaged Xero read over a collection that pages is silently
  // truncated to the oldest 100, and this manifest is what the writer deletes from — an item
  // missing here is an item left behind in the live ledger while the run reports success.
  const allItems = await pageAll<It>(token, 'Items', 'Items', (i) => i.ItemID)
  assertNoNearMisses(allItems.map((i) => ({ label: i.ItemID, value: i.Code })), classifyItemCode, 'item codes')
  const items = allItems.filter((i) => isFixtureItemCode(i.Code))
  console.log(`  ${items.length} of ${allItems.length} total`)
  for (const i of items) {
    rows.push({
      tenantId: token.tenantId,
      entity: 'item', uuid: i.ItemID, number: i.Code, status: '', date: xeroDate(i.UpdatedDateUTC),
      updatedDateUtc: i.UpdatedDateUTC ?? '',
      // An item has no contact. The writer plans it with an empty contact too, so the manifest
      // comparison is exact rather than "empty means unchecked" — the item's NAME is not a contact
      // and must not be recorded in a column the writer treats as one.
      total: '', currency: '', contact: '', blockers: '', cleanupStep: '5-delete',
      note: `${i.Name ? `"${i.Name}" — ` : ''}delete only after the documents referencing it are voided`,
    })
  }

  writeFileSync(OUT_PATH, toCsv(rows))

  // ---- summary
  const tally = (pred: (r: Row) => boolean) => rows.filter(pred).length
  const money = new Map<string, number>()
  for (const r of rows) {
    if (r.entity !== 'invoice' && r.entity !== 'bill') continue
    money.set(r.currency, (money.get(r.currency) ?? 0) + Number(r.total || 0))
  }
  console.log(`\n=== E2E FOOTPRINT IN ${o.Name} ===`)
  console.log(`  invoices (ACCREC):  ${tally((r) => r.entity === 'invoice')}`)
  console.log(`  bills (ACCPAY):     ${tally((r) => r.entity === 'bill')}`)
  console.log(`  credit notes:       ${tally((r) => r.entity === 'creditnote')}`)
  console.log(`  contacts:           ${tally((r) => r.entity === 'contact')}`)
  console.log(`  items:              ${tally((r) => r.entity === 'item')}`)
  console.log(`  invoice value:      ${[...money].map(([c, v]) => `${c} ${v.toFixed(2)}`).join(', ')}`)
  console.log(`  needing a blocker released first: ${tally((r) => r.blockers !== '')}`)

  // ---- cross-check against the sync-log export, which is what made this script necessary
  if (existsSync(CSV_PATH)) {
    const text = readFileSync(CSV_PATH, 'utf8').trim().split(/\r?\n/)
    const idx = text[0].split(',').indexOf('externalTransactionId')
    const csvIds = new Set(text.slice(1).map((l) => l.split(',')[idx]).filter(Boolean))
    const liveIds = new Set(rows.map((r) => r.uuid))
    let overlap = 0
    for (const id of csvIds) if (liveIds.has(id)) overlap++
    console.log(`\n=== CROSS-CHECK vs the e2e sync log ===`)
    console.log(`  ids in the sync-log export:            ${csvIds.size}`)
    console.log(`  of those, present in this org:         ${overlap}`)
    console.log(overlap === 0
      ? '  => CONFIRMED: the sync log indexes a DIFFERENT tenant (Demo). It cannot drive this cleanup.'
      : '  => partial overlap — investigate before trusting either index.')
  }

  console.log(`\nWrote ${OUT_PATH}`)
  console.log(`  Every row is stamped tenantId=${token.tenantId}. READ this file, then pass it to`)
  console.log(`  remove-xero-live-e2e-footprint.ts as --manifest to authorise the (irreversible) cleanup.`)
  console.log(`API calls used: ${transport.callCount}`)
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`)
  process.exit(1)
})
