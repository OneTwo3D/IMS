/**
 * o3d-t74p — READ-ONLY discovery of the e2e footprint in the LIVE Xero organisation.
 *
 * WHY THIS EXISTS ALONGSIDE audit-xero-live-contamination.ts
 * ----------------------------------------------------------
 * That script looks up the 553 externalTransactionIds recorded in the e2e database. Run against
 * the live org (One Two Enterprises Ltd, dd2af957-3438-4010-8e85-7841c33c8328) every single one
 * returns 404 — while the same org demonstrably holds 150 E2E invoices dated inside the incident
 * window. The stored ids are NOT this organisation's objects; they belong to the Demo tenant the
 * instance spent most of that period pointed at.
 *
 * So the sync log is the wrong index for "what is in the live org", and any cleanup driven from it
 * would have touched nothing while reporting success. The only reliable index is the ORGANISATION
 * ITSELF, keyed on the one thing the fixtures always stamp: the `E2E ` contact-name prefix and the
 * `E2E-` item-code prefix.
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

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const TOKEN_FILE = arg('token-file', '/root/.xero-audit-token.json')!
const OUT_PATH = arg('out', `./xero-live-e2e-footprint-${new Date().toISOString().slice(0, 10)}.csv`)!
const CSV_PATH = arg('csv', '/root/xero-live-e2e-contamination-20260804.csv')!
const MAX_CALLS = Number(arg('max-calls', '400'))

/** The e2e fixtures stamp every contact and SKU with these. They are the only durable handle. */
const CONTACT_PREFIX = 'E2E'
const ITEM_PREFIX = 'E2E-'
const WINDOW_FROM = '2026-07-15'
const WINDOW_TO = '2026-07-27'

type StoredToken = { accessToken: string; tenantId: string; tenantName: string }

let callCount = 0
let lastCallAt = 0
const MIN_CALL_INTERVAL_MS = 1200
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** GET only. Deliberately no write counterpart — this file cannot alter the live ledger. */
async function xeroGet<T>(token: StoredToken, path: string): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  if (callCount >= MAX_CALLS) throw new Error(`API call ceiling (${MAX_CALLS}) reached`)
  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallAt)
  if (wait > 0) await sleep(wait)

  callCount++
  lastCallAt = Date.now()
  const res = await fetch(`${XERO_API_BASE}/${path}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token.accessToken}`,
      'Xero-Tenant-Id': token.tenantId,
      'Accept': 'application/json',
    },
  })

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '0')
    if (retryAfter > 120) throw new Error(`Rate limited; Retry-After ${retryAfter}s. Stopped after ${callCount} calls.`)
    await sleep((retryAfter + 1) * 1000)
    callCount--
    return xeroGet<T>(token, path)
  }

  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) }
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) as T }
  } catch {
    return { ok: false, status: res.status, error: `Non-JSON: ${text.slice(0, 200)}` }
  }
}

/**
 * Page until a page comes back empty.
 *
 * NOT "until a page is short": Xero's page size is not guaranteed to be the 100 you assume, and a
 * short-but-non-empty page would end the walk early and silently under-report — the same class of
 * mistake as trusting an ignored filter.
 */
async function pageAll<T>(token: StoredToken, path: string, key: string, maxPages = 25): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await xeroGet<Record<string, T[]>>(token, `${path}${path.includes('?') ? '&' : '?'}page=${page}`)
    if (!res.ok) {
      console.log(`  ! ${path} page ${page} failed (HTTP ${res.status}): ${res.error}`)
      break
    }
    const list = res.data?.[key] ?? []
    if (list.length === 0) break
    out.push(...list)
    if (page === maxPages) console.log(`  ! hit the ${maxPages}-page ceiling on ${path} — result may be truncated`)
  }
  return out
}

function xeroDate(value?: string): string {
  if (!value) return ''
  const m = /\/Date\((-?\d+)/.exec(value)
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : value
}

type Row = {
  entity: string
  uuid: string
  number: string
  status: string
  date: string
  total: string
  currency: string
  contact: string
  blockers: string
  cleanupStep: string
  note: string
}

function toCsv(rows: Row[]): string {
  const cols: Array<keyof Row> = ['cleanupStep', 'entity', 'uuid', 'number', 'status', 'date', 'total', 'currency', 'contact', 'blockers', 'note']
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

  const contactWhere = encodeURIComponent(`Contact.Name.StartsWith("${CONTACT_PREFIX}")`)
  const rows: Row[] = []

  console.log('\n--- invoices with an E2E contact ---')
  type Inv = { InvoiceID: string; Type: string; InvoiceNumber?: string; Status: string; Date?: string; Total?: number; AmountPaid?: number; CurrencyCode?: string; Contact?: { Name?: string }; Payments?: Array<{ PaymentID: string }>; CreditNotes?: Array<{ CreditNoteID: string }> }
  const invoices = await pageAll<Inv>(token, `Invoices?where=${contactWhere}`, 'Invoices')
  console.log(`  ${invoices.length}`)
  for (const i of invoices) {
    const blockers = [
      ...(i.Payments ?? []).map((p) => `payment:${p.PaymentID}`),
      ...(i.CreditNotes ?? []).map((c) => `creditnote:${c.CreditNoteID}`),
    ]
    rows.push({
      entity: i.Type === 'ACCPAY' ? 'bill' : 'invoice',
      uuid: i.InvoiceID, number: i.InvoiceNumber ?? '', status: i.Status,
      date: xeroDate(i.Date), total: String(i.Total ?? ''), currency: i.CurrencyCode ?? '',
      contact: i.Contact?.Name ?? '', blockers: blockers.join(' '),
      // Anything holding an allocation or payment must be released before the void is accepted.
      cleanupStep: blockers.length ? '3-void-after-releasing-blockers' : '3-void',
      note: '',
    })
  }

  console.log('--- credit notes with an E2E contact ---')
  type CN = { CreditNoteID: string; Type: string; CreditNoteNumber?: string; Status: string; Date?: string; Total?: number; CurrencyCode?: string; Contact?: { Name?: string }; Allocations?: Array<{ Invoice?: { InvoiceID: string } }> }
  const creditNotes = await pageAll<CN>(token, `CreditNotes?where=${contactWhere}`, 'CreditNotes')
  console.log(`  ${creditNotes.length}`)
  for (const c of creditNotes) {
    const allocs = (c.Allocations ?? []).filter((a) => a.Invoice?.InvoiceID).map((a) => `allocated-to:${a.Invoice!.InvoiceID}`)
    rows.push({
      entity: 'creditnote', uuid: c.CreditNoteID, number: c.CreditNoteNumber ?? '', status: c.Status,
      date: xeroDate(c.Date), total: String(c.Total ?? ''), currency: c.CurrencyCode ?? '',
      contact: c.Contact?.Name ?? '', blockers: allocs.join(' '),
      cleanupStep: allocs.length ? '2-remove-allocation-then-void' : '2-void',
      note: '',
    })
  }

  console.log('--- E2E contacts ---')
  type Ct = { ContactID: string; Name: string; ContactStatus: string; UpdatedDateUTC?: string; IsCustomer?: boolean; IsSupplier?: boolean }
  const contacts = await pageAll<Ct>(token, `Contacts?where=${encodeURIComponent(`Name.StartsWith("${CONTACT_PREFIX}")`)}`, 'Contacts')
  console.log(`  ${contacts.length}`)
  for (const c of contacts) {
    rows.push({
      entity: 'contact', uuid: c.ContactID, number: '', status: c.ContactStatus,
      date: xeroDate(c.UpdatedDateUTC), total: '', currency: '', contact: c.Name,
      blockers: '', cleanupStep: '4-archive',
      note: 'a contact with transactions cannot be deleted, only archived',
    })
  }

  console.log('--- E2E items ---')
  type It = { ItemID: string; Code: string; Name?: string; UpdatedDateUTC?: string }
  const allItems = await xeroGet<{ Items?: It[] }>(token, 'Items')
  const items = (allItems.data?.Items ?? []).filter((i) => (i.Code ?? '').startsWith(ITEM_PREFIX))
  console.log(`  ${items.length} of ${allItems.data?.Items?.length ?? 0} total`)
  for (const i of items) {
    rows.push({
      entity: 'item', uuid: i.ItemID, number: i.Code, status: '', date: xeroDate(i.UpdatedDateUTC),
      total: '', currency: '', contact: i.Name ?? '', blockers: '', cleanupStep: '5-delete',
      note: 'delete only after the documents referencing it are voided',
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
  console.log(`API calls used: ${callCount}`)
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`)
  process.exit(1)
})
