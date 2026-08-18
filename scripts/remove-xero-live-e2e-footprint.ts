/**
 * o3d-t74p — remove the e2e footprint from the LIVE Xero organisation.
 *
 * This is the ONLY script in this set that writes. Everything it touches is selected by the
 * fixtures' own marks — the `E2E ` contact-name prefix and the `E2E-` item-code prefix — and every
 * object is re-checked against those marks immediately before it is mutated.
 *
 * WHAT THAT CHECK IS AND IS NOT. The mark is re-read from THIS RUN'S OWN FETCH, not from a stored
 * worklist file, so a stale CSV can never drive a write. It is NOT a per-object re-fetch: the
 * invoice and credit-note lists are read once at the start of the run and every step iterates that
 * snapshot. A document that changed in Xero after the snapshot — voided by hand, re-contacted,
 * paid — is therefore acted on as it looked at fetch time. The window is minutes and the failure
 * mode is a rejected write rather than a wrong one (Xero refuses an invalid transition), which is
 * why this is acceptable here; do not read it as a live re-validation, because it is not one.
 *
 * WHAT "DELETE" CAN AND CANNOT MEAN HERE
 * --------------------------------------
 * Xero only permits hard deletion of DRAFT/SUBMITTED documents. An AUTHORISED invoice can be
 * VOIDED, never removed — it stays visible in Xero with status VOIDED and no effect on the ledger.
 * So 143 AUTHORISED invoices end as VOIDED records, not as absences. That is the strongest removal
 * the API allows, and it is not reversible: a voided document cannot be un-voided.
 *
 * ORDER IS NOT COSMETIC. Xero refuses to void a document that still carries an allocation or a
 * payment, so:
 *   1. delete credit-note allocations   (releases both sides at once)
 *   2. void credit notes
 *   3. void invoices
 *   4. archive contacts                 (a contact with transactions cannot be deleted)
 *   5. delete items                     (fails while any document still references them)
 *
 * TOKENS. Planning runs on the READ-ONLY token minted by audit-xero-live-contamination.ts, so a
 * dry run needs no new consent and cannot write. --apply requires a SEPARATE token carrying write
 * scopes, obtained by this script's own consent and stored apart. The read-only token is never
 * used to write and the write token is never minted unless --apply is passed.
 *
 * USAGE
 *   node_modules/.bin/tsx scripts/remove-xero-live-e2e-footprint.ts              # dry run
 *   node_modules/.bin/tsx scripts/remove-xero-live-e2e-footprint.ts --apply      # writes
 *   ... --steps 1,2,3        run only some phases (default: all)
 */
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { Client } from 'pg'

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'

/**
 * WRITE scopes — the granular family this app accepts (accounting.transactions is refused for it;
 * see lib/connectors/xero/scopes.ts). accounting.invoices covers invoices, credit notes and their
 * allocations; accounting.settings covers Items.
 */
const WRITE_SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'accounting.invoices',
  // A credit note can carry a REFUND payment, which blocks the void exactly as an allocation does.
  // Deleting one needs its own scope: accounting.invoices does not reach /Payments.
  'accounting.payments',
  'accounting.contacts',
  'accounting.settings',
].join(' ')

/**
 * The trailing space is load-bearing. Every one of the 111 contacts in the footprint is
 * "E2E E2E-FC-<id>", so requiring it loses nothing — while bare "E2E" would also match a genuine
 * business contact such as "E2ENetworks Ltd" and sweep it into a void that CANNOT BE UNDONE.
 * On an irreversible write against a real ledger the narrower handle is the only defensible one.
 */
const CONTACT_PREFIX = 'E2E '
const ITEM_PREFIX = 'E2E-'
/** The organisation this cleanup is for. A different tenant is a hard stop, never a prompt. */
const EXPECTED_TENANT_ID = 'dd2af957-3438-4010-8e85-7841c33c8328'
const EXPECTED_TENANT_NAME = 'One Two Enterprises Ltd'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const APPLY = process.argv.includes('--apply')
const READ_TOKEN_FILE = arg('read-token', '/root/.xero-audit-token.json')!
const WRITE_TOKEN_FILE = arg('write-token', '/root/.xero-cleanup-token.json')!
const CALLBACK_PORT = Number(arg('port', '53100'))
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`
const MAX_CALLS = Number(arg('max-calls', '1500'))
const STEPS = new Set((arg('steps', '1,2,3,4,5')!).split(',').map((s) => s.trim()))

type Token = { accessToken: string; refreshToken?: string; tenantId: string; tenantName: string; expiresAt?: number }

// ---------------------------------------------------------------------------
// Settings decryption (mirrors lib/security/encrypted-settings.ts — prefix AND AAD both matter)
// ---------------------------------------------------------------------------
const ENCRYPTED_SETTING_PREFIX = 'enc:setting:v1:'
const DRAFT_ENCRYPTED_SETTING_PREFIX = 'enc:v2:'
const LEGACY_ENCRYPTED_PREFIX = 'enc:v1:'

function resolveEncryptionKey(): Buffer | null {
  const raw = (process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY ?? '').trim()
  if (!raw) return null
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  const b64 = Buffer.from(raw, 'base64')
  if (b64.length === 32) return b64
  const utf8 = Buffer.from(raw, 'utf8')
  return utf8.length === 32 ? utf8 : null
}

function decryptSettingValue(settingKey: string, value: string): string {
  const prefix = value.startsWith(ENCRYPTED_SETTING_PREFIX) ? ENCRYPTED_SETTING_PREFIX
    : value.startsWith(DRAFT_ENCRYPTED_SETTING_PREFIX) ? DRAFT_ENCRYPTED_SETTING_PREFIX
      : value.startsWith(LEGACY_ENCRYPTED_PREFIX) ? LEGACY_ENCRYPTED_PREFIX : null
  if (!prefix) return value
  const key = resolveEncryptionKey()
  if (!key) throw new Error(`SETTINGS_ENCRYPTION_KEY is required to read ${settingKey}`)
  const payload = Buffer.from(value.slice(prefix.length), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
  if (prefix !== LEGACY_ENCRYPTED_PREFIX) decipher.setAAD(Buffer.from(`setting:${settingKey}`, 'utf8'))
  decipher.setAuthTag(payload.subarray(12, 28))
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')
}

async function readCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const envId = process.env.XERO_AUDIT_CLIENT_ID
  const envSecret = process.env.XERO_AUDIT_CLIENT_SECRET
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Set DATABASE_URL or XERO_AUDIT_CLIENT_ID/SECRET')
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    const res = await db.query<{ key: string; value: string }>(
      `select key, value from settings where key in ('xero_client_id','xero_client_secret')`)
    const map = new Map(res.rows.map((r) => [r.key, r.value]))
    const id = map.get('xero_client_id'); const secret = map.get('xero_client_secret')
    if (!id || !secret) throw new Error('xero client credentials not found in settings')
    return {
      clientId: decryptSettingValue('xero_client_id', id),
      clientSecret: decryptSettingValue('xero_client_secret', secret),
    }
  } finally { await db.end() }
}

// ---------------------------------------------------------------------------
// OAuth for the WRITE token (loopback listener or pasted redirect URL)
// ---------------------------------------------------------------------------
let sharedRl: ReturnType<typeof createInterface> | null = null
function sharedStdin() {
  if (!sharedRl) sharedRl = createInterface({ input: process.stdin, output: process.stdout })
  return sharedRl
}

function awaitCode(expectedState: string): { promise: Promise<string>; cancel: () => void } {
  let cancelAll = () => {}
  const promise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('Authorized. Return to the terminal.')
      server.close()
      if (!code || state !== expectedState) { reject(new Error('OAuth state mismatch or missing code')); return }
      resolve(code)
    })
    server.on('error', (e) => console.log(`  (loopback listener unavailable: ${e.message} — paste instead)`))
    server.listen(CALLBACK_PORT)

    const rl = sharedStdin()
    const onLine = (line: string) => {
      const input = line.trim()
      if (!input) return
      let code = input; let state: string | null = null
      if (input.includes('code=')) {
        try {
          const u = new URL(input.startsWith('http') ? input : `http://localhost/?${input.replace(/^\?/, '')}`)
          code = u.searchParams.get('code') ?? ''
          state = u.searchParams.get('state')
        } catch { console.log('  could not parse that URL'); return }
      }
      if (!code || /\s/.test(code) || code.length < 20) {
        console.log('  that does not look like an authorization code — paste the full redirect URL')
        return
      }
      if (state && state !== expectedState) { reject(new Error('OAuth state mismatch')); return }
      resolve(code)
    }
    rl.on('line', onLine)
    cancelAll = () => { server.close(); rl.off('line', onLine) }
  })
  return { promise, cancel: () => cancelAll() }
}

async function exchange(clientId: string, clientSecret: string, body: Record<string, string>) {
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Token endpoint HTTP ${res.status}: ${text}`)
  return JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number }
}

async function getWriteToken(): Promise<Token> {
  const { clientId, clientSecret } = await readCredentials()

  if (existsSync(WRITE_TOKEN_FILE)) {
    const cached = JSON.parse(readFileSync(WRITE_TOKEN_FILE, 'utf8')) as Token
    if (cached.refreshToken) {
      try {
        const t = await exchange(clientId, clientSecret, { grant_type: 'refresh_token', refresh_token: cached.refreshToken })
        const token = { ...cached, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 }
        writeFileSync(WRITE_TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 })
        chmodSync(WRITE_TOKEN_FILE, 0o600)
        console.log(`Reusing cached WRITE connection to "${token.tenantName}".`)
        return token
      } catch (e) { console.log(`Cached write token could not refresh (${(e as Error).message}); re-authorizing.`) }
    }
  }

  const state = randomBytes(16).toString('hex')
  const authUrl = `${XERO_AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, scope: WRITE_SCOPES, state,
  })}`
  console.log('\n--- AUTHORIZE (WRITE — this token can modify the ledger) ---')
  console.log(`Scopes: ${WRITE_SCOPES}`)
  console.log(`\nOpen this and pick ${EXPECTED_TENANT_NAME}:\n\n${authUrl}\n`)
  console.log('The redirect will fail to load; paste the full address bar contents below.\n')

  const waiter = awaitCode(state)
  let code: string
  try { code = await waiter.promise } finally { waiter.cancel() }

  const t = await exchange(clientId, clientSecret, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
  const connRes = await fetch(XERO_CONNECTIONS_URL, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' } })
  const connections = (await connRes.json()) as Array<{ tenantId: string; tenantName: string }>
  const conn = connections.find((c) => c.tenantId === EXPECTED_TENANT_ID)
  if (!conn) {
    throw new Error(`${EXPECTED_TENANT_NAME} (${EXPECTED_TENANT_ID}) was not among the authorised organisations: ${connections.map((c) => c.tenantName).join(', ')}`)
  }
  const token: Token = { accessToken: t.access_token, refreshToken: t.refresh_token, tenantId: conn.tenantId, tenantName: conn.tenantName, expiresAt: Date.now() + t.expires_in * 1000 }
  writeFileSync(WRITE_TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 })
  chmodSync(WRITE_TOKEN_FILE, 0o600)
  sharedRl?.close(); sharedRl = null
  return token
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
let callCount = 0
let lastCallAt = 0
const MIN_CALL_INTERVAL_MS = 1100
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function xero<T>(token: Token, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  if (callCount >= MAX_CALLS) throw new Error(`API call ceiling (${MAX_CALLS}) reached`)
  if (method !== 'GET' && !APPLY) throw new Error(`BUG: attempted ${method} ${path} without --apply`)

  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallAt)
  if (wait > 0) await sleep(wait)
  callCount++; lastCallAt = Date.now()

  const res = await fetch(`${XERO_API_BASE}/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token.accessToken}`,
      'Xero-Tenant-Id': token.tenantId,
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '0')
    if (retryAfter > 120) throw new Error(`Rate limited; Retry-After ${retryAfter}s after ${callCount} calls`)
    await sleep((retryAfter + 1) * 1000)
    callCount--
    return xero<T>(token, method, path, body)
  }

  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) }
  try { return { ok: true, status: res.status, data: text ? JSON.parse(text) as T : undefined } }
  catch { return { ok: true, status: res.status } }
}

async function pageAll<T>(token: Token, path: string, key: string, maxPages = 25): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await xero<Record<string, T[]>>(token, 'GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}`)
    if (!res.ok) { console.log(`  ! ${path} page ${page}: HTTP ${res.status}`); break }
    const list = res.data?.[key] ?? []
    if (list.length === 0) break
    out.push(...list)
  }
  return out
}

// ---------------------------------------------------------------------------
type CreditNote = { CreditNoteID: string; CreditNoteNumber?: string; Status: string; Total?: number; Contact?: { Name?: string }; Allocations?: Array<{ AllocationID?: string; Amount: number; Invoice?: { InvoiceID: string } }>; Payments?: Array<{ PaymentID: string; Amount: number }> }
type Invoice = { InvoiceID: string; InvoiceNumber?: string; Status: string; Total?: number; Contact?: { Name?: string }; Payments?: Array<{ PaymentID: string }>; CreditNotes?: Array<{ CreditNoteID: string }> }
type Contact = { ContactID: string; Name: string; ContactStatus: string }
type Item = { ItemID: string; Code: string }

const isE2eContact = (name?: string) => !!name && name.startsWith(CONTACT_PREFIX)
const TERMINAL = new Set(['VOIDED', 'DELETED'])

const stats = { allocationsDeleted: 0, refundsDeleted: 0, creditNotesVoided: 0, invoicesVoided: 0, contactsArchived: 0, itemsDeleted: 0, skipped: 0, failed: 0 }
const failures: string[] = []

function act(what: string): void {
  console.log(`${APPLY ? '  ' : '  [dry-run] '}${what}`)
}

/**
 * The terminal status Xero will actually accept for a document, which depends on where it already
 * is. VOIDED is only reachable from an approved document; a DRAFT or SUBMITTED one must be DELETED
 * instead, and asking for VOIDED there returns a bare ValidationException that names no field.
 *
 * That is what left 13 SUBMITTED credit notes behind on the first pass — the request was simply
 * the wrong transition for their status, not a permissions or ordering problem.
 */
function terminalStatusFor(status: string): 'VOIDED' | 'DELETED' {
  return status === 'DRAFT' || status === 'SUBMITTED' ? 'DELETED' : 'VOIDED'
}

async function main() {
  if (!existsSync(READ_TOKEN_FILE)) throw new Error(`No read token at ${READ_TOKEN_FILE}`)
  const readToken = JSON.parse(readFileSync(READ_TOKEN_FILE, 'utf8')) as Token

  // Plan on the read-only token; only mint a write token when actually applying.
  const token: Token = APPLY ? await getWriteToken() : readToken

  const org = await xero<{ Organisations?: Array<{ Name: string }> }>(token, 'GET', 'Organisation')
  // Distinguish "could not ask" from "asked and got the wrong org". Both must stop the run, but
  // reporting an expired token as connected to "undefined" sends the operator hunting a tenant
  // mix-up that never happened. Access tokens last 30 minutes.
  if (!org.ok) {
    throw new Error(`ABORT: could not read the organisation (HTTP ${org.status}). ${org.status === 401 ? 'The token has expired — re-authorize.' : org.error ?? ''}`)
  }
  const name = org.data?.Organisations?.[0]?.Name
  if (token.tenantId !== EXPECTED_TENANT_ID || name !== EXPECTED_TENANT_NAME) {
    throw new Error(`ABORT: connected to "${name}" (${token.tenantId}), expected ${EXPECTED_TENANT_NAME} (${EXPECTED_TENANT_ID})`)
  }
  console.log(`=== ${name} (${token.tenantId}) ===`)
  console.log(APPLY ? '*** APPLY MODE — this will modify the live ledger ***' : '*** DRY RUN — nothing will be written ***')

  const where = encodeURIComponent(`Contact.Name.StartsWith("${CONTACT_PREFIX}")`)
  const creditNotes = await pageAll<CreditNote>(token, `CreditNotes?where=${where}`, 'CreditNotes')
  const invoices = await pageAll<Invoice>(token, `Invoices?where=${where}`, 'Invoices')
  console.log(`\nfound ${invoices.length} invoices, ${creditNotes.length} credit notes with an E2E contact`)

  // --- step 1: release allocations (they block BOTH sides from being voided)
  if (STEPS.has('1')) {
    console.log('\n--- step 1: delete credit-note allocations ---')
    for (const cn of creditNotes) {
      if (!isE2eContact(cn.Contact?.Name)) { stats.skipped++; continue }
      for (const alloc of cn.Allocations ?? []) {
        if (!alloc.AllocationID) {
          failures.push(`${cn.CreditNoteNumber}: allocation without an AllocationID — remove by hand`)
          stats.failed++
          continue
        }
        act(`delete allocation ${alloc.AllocationID} (${alloc.Amount}) on ${cn.CreditNoteNumber} -> invoice ${alloc.Invoice?.InvoiceID}`)
        if (!APPLY) { stats.allocationsDeleted++; continue }
        const res = await xero(token, 'DELETE', `CreditNotes/${cn.CreditNoteID}/Allocations/${alloc.AllocationID}`)
        if (res.ok) stats.allocationsDeleted++
        else { stats.failed++; failures.push(`allocation ${alloc.AllocationID} on ${cn.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
      }

      // A refund paid out against the credit note blocks the void the same way an allocation does.
      // Xero has no DELETE verb for a payment — the reversal is a POST moving it to DELETED.
      for (const payment of cn.Payments ?? []) {
        act(`delete refund payment ${payment.PaymentID} (${payment.Amount}) on ${cn.CreditNoteNumber}`)
        if (!APPLY) { stats.refundsDeleted++; continue }
        const res = await xero(token, 'POST', `Payments/${payment.PaymentID}`, { Status: 'DELETED' })
        if (res.ok) stats.refundsDeleted++
        else { stats.failed++; failures.push(`refund ${payment.PaymentID} on ${cn.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
      }
    }
  }

  // --- step 2: void credit notes
  if (STEPS.has('2')) {
    console.log('\n--- step 2: void credit notes ---')
    for (const cn of creditNotes) {
      if (!isE2eContact(cn.Contact?.Name)) { stats.skipped++; continue }
      if (TERMINAL.has(cn.Status)) { stats.skipped++; continue }
      const target = terminalStatusFor(cn.Status)
      act(`${target === 'DELETED' ? 'delete' : 'void'} credit note ${cn.CreditNoteNumber} (${cn.Status}, ${cn.Total})`)
      if (!APPLY) { stats.creditNotesVoided++; continue }
      const res = await xero(token, 'POST', `CreditNotes/${cn.CreditNoteID}`, { Status: target })
      if (res.ok) stats.creditNotesVoided++
      else { stats.failed++; failures.push(`credit note ${cn.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
    }
  }

  // --- step 3: void invoices
  if (STEPS.has('3')) {
    console.log('\n--- step 3: void invoices ---')
    for (const inv of invoices) {
      if (!isE2eContact(inv.Contact?.Name)) { stats.skipped++; continue }
      if (TERMINAL.has(inv.Status)) { stats.skipped++; continue }
      const target = terminalStatusFor(inv.Status)
      act(`${target === 'DELETED' ? 'delete' : 'void'} invoice ${inv.InvoiceNumber} (${inv.Status}, ${inv.Total})`)
      if (!APPLY) { stats.invoicesVoided++; continue }
      const res = await xero(token, 'POST', `Invoices/${inv.InvoiceID}`, { Status: target })
      if (res.ok) stats.invoicesVoided++
      else { stats.failed++; failures.push(`invoice ${inv.InvoiceNumber}: HTTP ${res.status} ${res.error}`) }
    }
  }

  // --- step 4: archive contacts
  if (STEPS.has('4')) {
    console.log('\n--- step 4: archive E2E contacts ---')
    const contacts = await pageAll<Contact>(token, `Contacts?where=${encodeURIComponent(`Name.StartsWith("${CONTACT_PREFIX}")`)}`, 'Contacts')
    for (const c of contacts) {
      if (!isE2eContact(c.Name)) { stats.skipped++; continue }
      if (c.ContactStatus === 'ARCHIVED') { stats.skipped++; continue }
      act(`archive contact ${c.Name}`)
      if (!APPLY) { stats.contactsArchived++; continue }
      const res = await xero(token, 'POST', `Contacts/${c.ContactID}`, { ContactStatus: 'ARCHIVED' })
      if (res.ok) stats.contactsArchived++
      else { stats.failed++; failures.push(`contact ${c.Name}: HTTP ${res.status} ${res.error}`) }
    }
  }

  // --- step 5: delete items
  if (STEPS.has('5')) {
    console.log('\n--- step 5: delete E2E items ---')
    const all = await xero<{ Items?: Item[] }>(token, 'GET', 'Items')
    const items = (all.data?.Items ?? []).filter((i) => (i.Code ?? '').startsWith(ITEM_PREFIX))
    console.log(`  ${items.length} E2E-coded items`)
    for (const i of items) {
      act(`delete item ${i.Code}`)
      if (!APPLY) { stats.itemsDeleted++; continue }
      const res = await xero(token, 'DELETE', `Items/${i.ItemID}`)
      if (res.ok) stats.itemsDeleted++
      else {
        // Expected for any item still referenced by a (now voided) document — report, don't fail.
        stats.failed++
        failures.push(`item ${i.Code}: HTTP ${res.status} ${res.error}`)
      }
    }
  }

  console.log(`\n=== ${APPLY ? 'APPLIED' : 'DRY RUN'} ===`)
  console.log(`  allocations deleted: ${stats.allocationsDeleted}`)
  console.log(`  refund payments deleted: ${stats.refundsDeleted}`)
  console.log(`  credit notes voided: ${stats.creditNotesVoided}`)
  console.log(`  invoices voided:     ${stats.invoicesVoided}`)
  console.log(`  contacts archived:   ${stats.contactsArchived}`)
  console.log(`  items deleted:       ${stats.itemsDeleted}`)
  console.log(`  skipped (already terminal / not E2E): ${stats.skipped}`)
  console.log(`  failed:              ${stats.failed}`)
  if (failures.length) {
    console.log('\nfailures:')
    for (const f of failures.slice(0, 40)) console.log(`  - ${f}`)
    if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`)
  }
  console.log(`\nAPI calls used: ${callCount}`)
  if (!APPLY) console.log('\nRe-run with --apply to perform these changes.')
}

main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1) })
