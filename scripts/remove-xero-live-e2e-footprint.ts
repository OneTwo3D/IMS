/**
 * o3d-t74p — remove the e2e footprint from the LIVE Xero organisation.
 *
 * This is the ONLY script in this set that writes, and what it writes CANNOT BE UNDONE. Every
 * boundary it depends on lives in scripts/lib/xero-live-safety.ts and is covered by
 * tests/scripts/xero-live-safety.test.ts — see that file for the contract in full. The short form:
 *
 *   PLAN FIRST, ALWAYS.  The whole read-only plan is built and validated before the first mutation.
 *                        A page that fails, or a page ceiling, aborts — it can no longer degrade
 *                        into "mutate whatever we happened to read".
 *   EXACT GRAMMAR.       Selection is the full fixture form `E2E E2E-FC-<runId>` (contacts) and
 *                        `E2E-FC-<RUNID>-<LABEL>` (items), not the `E2E `/`E2E-` namespace. A name
 *                        that is E2E-ish but not the exact form ABORTS the run rather than being
 *                        swept into an irreversible void. `E2E Consulting Ltd` is a plausible real
 *                        supplier and the previous prefix would have matched it.
 *   REVIEWED MANIFEST.   --apply requires --manifest: the tenant-stamped CSV that
 *                        audit-xero-live-e2e-footprint.ts writes, after a human has read it. An
 *                        object selected live but absent from the manifest is fatal.
 *   RE-READ BEFORE EACH WRITE.  Every object is GET-ed again immediately before it is mutated and
 *                        must be identical to the plan — status, contact, blockers, UpdatedDateUTC.
 *                        The failure this closes is a document re-contacted to a GENUINE customer
 *                        between plan and write: still in a valid status, so Xero accepts the void.
 *                        That is a wrong write, not a rejected one.
 *   NO SUCCESSFUL PARTIAL.  Any failure exits non-zero and the banner says PARTIALLY APPLIED.
 *
 * WHAT "DELETE" CAN AND CANNOT MEAN HERE
 * --------------------------------------
 * Xero only permits hard deletion of DRAFT/SUBMITTED documents. An AUTHORISED invoice can be
 * VOIDED, never removed — it stays visible in Xero with status VOIDED and no effect on the ledger.
 * So AUTHORISED invoices end as VOIDED records, not as absences. That is the strongest removal the
 * API allows, and it is not reversible: a voided document cannot be un-voided.
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
 * scopes, obtained by this script's own consent and stored apart.
 *
 * CALL BUDGET. Re-reading every object before mutating it roughly doubles the call count against
 * the previous implementation — that is the price of not voiding a stale snapshot. Xero's daily
 * limit is as low as 1,000/org/24h on some plans, so cost the run with a dry run first (it prints
 * the plan size) and raise --max-calls deliberately.
 *
 * USAGE
 *   node_modules/.bin/tsx scripts/remove-xero-live-e2e-footprint.ts                    # dry run
 *   node_modules/.bin/tsx scripts/remove-xero-live-e2e-footprint.ts \
 *     --manifest ./xero-live-e2e-footprint-<date>.csv --apply                          # writes
 *   ... --steps 1,2,3        run only some phases (default: all)
 *   ... --plan-out <path>    where to persist the reviewed plan (default ./xero-live-cleanup-plan-<date>.json)
 */
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { Client } from 'pg'

import {
  assertExpectedTenant,
  assertManifestTenant,
  assertNoNearMisses,
  assertPlanWithinManifest,
  assertStillFixtureContact,
  assertUnchanged,
  classifyContactName,
  classifyItemCode,
  createXeroTransport,
  isFixtureContactName,
  isFixtureItemCode,
  pageAllComplete,
  parseWriteManifest,
  runOutcome,
  SafetyViolationError,
  statusesAfterReleasingBlockers,
  type TransportToken,
  type WriteManifest,
} from './lib/xero-live-safety'

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'

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
 * The SERVER-SIDE filter only. Xero's `where` has no exact-match on a whole name, so the query is
 * necessarily a prefix — but nothing is selected on the strength of it. Everything the filter
 * returns is classified locally against the exact fixture grammar, and an E2E-ish near miss aborts.
 */
const CONTACT_QUERY_PREFIX = 'E2E '
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
const MANIFEST_PATH = arg('manifest')
const PLAN_OUT = arg('plan-out', `./xero-live-cleanup-plan-${new Date().toISOString().slice(0, 10)}.json`)!
const CALLBACK_PORT = Number(arg('port', '53100'))
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`
const MAX_CALLS = Number(arg('max-calls', '3000'))
const STEPS = new Set((arg('steps', '1,2,3,4,5')!).split(',').map((s) => s.trim()))

type Token = TransportToken & { refreshToken?: string; tenantName: string; expiresAt?: number }

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
// Transport. `apply` is passed explicitly; the transport throws on any non-GET without it.
// ---------------------------------------------------------------------------
const transport = createXeroTransport({
  apply: APPLY,
  maxCalls: MAX_CALLS,
  log: (m) => console.log(m),
})

// ---------------------------------------------------------------------------
type CreditNote = { CreditNoteID: string; CreditNoteNumber?: string; Status: string; Total?: number; UpdatedDateUTC?: string; Contact?: { Name?: string }; Allocations?: Array<{ AllocationID?: string; Amount: number; Invoice?: { InvoiceID: string } }>; Payments?: Array<{ PaymentID: string; Amount: number }> }
type Invoice = { InvoiceID: string; InvoiceNumber?: string; Status: string; Total?: number; UpdatedDateUTC?: string; Contact?: { Name?: string }; Payments?: Array<{ PaymentID: string }>; CreditNotes?: Array<{ CreditNoteID: string }> }
type Contact = { ContactID: string; Name: string; ContactStatus: string; UpdatedDateUTC?: string }
type Item = { ItemID: string; Code: string; UpdatedDateUTC?: string }

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
 * That is what left 13 SUBMITTED credit notes behind on the 2026-08-10 run — the request was simply
 * the wrong transition for their status, not a permissions or ordering problem.
 */
function terminalStatusFor(status: string): 'VOIDED' | 'DELETED' {
  return status === 'DRAFT' || status === 'SUBMITTED' ? 'DELETED' : 'VOIDED'
}

const cnBlockers = (cn: CreditNote): string[] => [
  ...(cn.Allocations ?? []).map((a) => `allocation:${a.AllocationID ?? '?'}`),
  ...(cn.Payments ?? []).map((p) => `refund:${p.PaymentID}`),
]
const invBlockers = (inv: Invoice): string[] => [
  ...(inv.Payments ?? []).map((p) => `payment:${p.PaymentID}`),
  ...(inv.CreditNotes ?? []).map((c) => `creditnote:${c.CreditNoteID}`),
]

// ---------------------------------------------------------------------------
// Per-object re-read, immediately before the mutation
// ---------------------------------------------------------------------------
async function reread<T>(token: Token, path: string, key: string): Promise<T | null> {
  const res = await transport.request<Record<string, T[]>>(token, 'GET', path)
  if (!res.ok) return null
  return res.data?.[key]?.[0] ?? null
}

async function main() {
  if (!existsSync(READ_TOKEN_FILE)) throw new Error(`No read token at ${READ_TOKEN_FILE}`)
  const readToken = JSON.parse(readFileSync(READ_TOKEN_FILE, 'utf8')) as Token

  // The manifest is loaded and validated BEFORE any write token is minted: a run that cannot be
  // authorised by a reviewed manifest should never even ask for write consent.
  let manifest: WriteManifest | null = null
  if (APPLY) {
    if (!MANIFEST_PATH) {
      throw new SafetyViolationError(
        'ABORT: --apply requires --manifest <path>. Run scripts/audit-xero-live-e2e-footprint.ts, ' +
          'READ the CSV it writes, and pass it here. Selection by name alone does not authorise an ' +
          'irreversible write against a real ledger.',
      )
    }
    if (!existsSync(MANIFEST_PATH)) throw new SafetyViolationError(`ABORT: no manifest at ${MANIFEST_PATH}`)
    manifest = parseWriteManifest(readFileSync(MANIFEST_PATH, 'utf8'))
    assertManifestTenant(manifest, EXPECTED_TENANT_ID)
    console.log(`Manifest: ${manifest.entries.size} reviewed object(s) for tenant ${manifest.tenantId} (${MANIFEST_PATH})`)
  }

  // Plan on the read-only token; only mint a write token when actually applying.
  const token: Token = APPLY ? await getWriteToken() : readToken

  const org = await transport.request<{ Organisations?: Array<{ Name: string }> }>(token, 'GET', 'Organisation')
  // Distinguish "could not ask" from "asked and got the wrong org". Both must stop the run, but
  // reporting an expired token as connected to "undefined" sends the operator hunting a tenant
  // mix-up that never happened. Access tokens last 30 minutes.
  if (!org.ok) {
    throw new Error(`ABORT: could not read the organisation (HTTP ${org.status}). ${org.status === 401 ? 'The token has expired — re-authorize.' : org.error ?? ''}`)
  }
  const orgName = org.data?.Organisations?.[0]?.Name
  assertExpectedTenant({
    tokenTenantId: token.tenantId,
    organisationName: orgName,
    expectedTenantId: EXPECTED_TENANT_ID,
    expectedTenantName: EXPECTED_TENANT_NAME,
  })
  console.log(`=== ${orgName} (${token.tenantId}) ===`)
  console.log(APPLY ? '*** APPLY MODE — this will modify the live ledger ***' : '*** DRY RUN — nothing will be written ***')

  // =========================================================================
  // PHASE A — build a COMPLETE, validated, read-only plan. No mutation happens
  // until this whole section has succeeded.
  // =========================================================================
  console.log('\n=== PHASE A: planning (read-only) ===')
  const read = transport.reader(token)
  const where = encodeURIComponent(`Contact.Name.StartsWith("${CONTACT_QUERY_PREFIX}")`)

  const allCreditNotes = await pageAllComplete<CreditNote>({
    read, path: `CreditNotes?where=${where}`, key: 'CreditNotes', idOf: (c) => c.CreditNoteID, log: (m) => console.log(m),
  })
  const allInvoices = await pageAllComplete<Invoice>({
    read, path: `Invoices?where=${where}`, key: 'Invoices', idOf: (i) => i.InvoiceID, log: (m) => console.log(m),
  })
  const allContacts = await pageAllComplete<Contact>({
    read, path: `Contacts?where=${encodeURIComponent(`Name.StartsWith("${CONTACT_QUERY_PREFIX}")`)}`,
    key: 'Contacts', idOf: (c) => c.ContactID, log: (m) => console.log(m),
  })
  // Items: paged like everything else rather than read unpaged. An unpaged Xero GET is silently
  // truncated on the collections that page, and this endpoint's behaviour is not something to
  // assume either way — pageAllComplete proves completeness whether or not `page` is honoured.
  const allItems = await pageAllComplete<Item>({
    read, path: 'Items', key: 'Items', idOf: (i) => i.ItemID, log: (m) => console.log(m),
  })

  console.log(`  server-side filter returned ${allInvoices.length} invoices, ${allCreditNotes.length} credit notes, ${allContacts.length} contacts; ${allItems.length} items in the org`)

  // A near miss is a hard stop, in either direction: the run neither voids it nor quietly ignores it.
  assertNoNearMisses(allCreditNotes.map((c) => ({ label: c.CreditNoteNumber ?? c.CreditNoteID, value: c.Contact?.Name })), classifyContactName, 'credit-note contacts')
  assertNoNearMisses(allInvoices.map((i) => ({ label: i.InvoiceNumber ?? i.InvoiceID, value: i.Contact?.Name })), classifyContactName, 'invoice contacts')
  assertNoNearMisses(allContacts.map((c) => ({ label: c.ContactID, value: c.Name })), classifyContactName, 'contacts')
  assertNoNearMisses(allItems.map((i) => ({ label: i.ItemID, value: i.Code })), classifyItemCode, 'item codes')

  const creditNotes = allCreditNotes.filter((c) => isFixtureContactName(c.Contact?.Name))
  const invoices = allInvoices.filter((i) => isFixtureContactName(i.Contact?.Name))
  const contacts = allContacts.filter((c) => isFixtureContactName(c.Name))
  const items = allItems.filter((i) => isFixtureItemCode(i.Code))

  console.log(`  exact fixture grammar selects ${invoices.length} invoices, ${creditNotes.length} credit notes, ${contacts.length} contacts, ${items.length} items`)

  const plan = [
    ...creditNotes.map((c) => ({ uuid: c.CreditNoteID, entity: 'creditnote', label: c.CreditNoteNumber ?? '' })),
    ...invoices.map((i) => ({ uuid: i.InvoiceID, entity: 'invoice', label: i.InvoiceNumber ?? '' })),
    ...contacts.map((c) => ({ uuid: c.ContactID, entity: 'contact', label: c.Name })),
    ...items.map((i) => ({ uuid: i.ItemID, entity: 'item', label: i.Code })),
  ]

  if (manifest) {
    const { missingFromLedger } = assertPlanWithinManifest(plan, manifest)
    console.log(`  manifest check: all ${plan.length} planned object(s) are reviewed; ${missingFromLedger.length} manifest id(s) are no longer in the org (already cleaned up).`)
  }

  // Persist the reviewed plan before the first write, so a run that dies part-way leaves behind
  // exactly what it intended to do.
  writeFileSync(PLAN_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    tenantId: token.tenantId,
    tenantName: orgName,
    apply: APPLY,
    manifest: MANIFEST_PATH ?? null,
    plan,
  }, null, 2))
  console.log(`  plan persisted to ${PLAN_OUT}`)

  // =========================================================================
  // PHASE B — mutate. Every object is re-read immediately before it is touched.
  // =========================================================================
  console.log(`\n=== PHASE B: ${APPLY ? 'applying' : 'dry run'} ===`)

  // --- step 1: release allocations (they block BOTH sides from being voided)
  if (STEPS.has('1')) {
    console.log('\n--- step 1: delete credit-note allocations and refunds ---')
    for (const planned of creditNotes) {
      if ((planned.Allocations ?? []).length === 0 && (planned.Payments ?? []).length === 0) continue

      let live = planned
      if (APPLY) {
        const fresh = await reread<CreditNote>(token, `CreditNotes/${planned.CreditNoteID}`, 'CreditNotes')
        assertStillFixtureContact(planned.CreditNoteID, fresh?.Contact?.Name)
        // Nothing has touched this document yet, so it must be EXACTLY as planned — status,
        // contact, blockers and UpdatedDateUTC all unchanged.
        assertUnchanged(
          {
            id: planned.CreditNoteID,
            allowedStatuses: [planned.Status],
            contactName: planned.Contact?.Name,
            blockers: cnBlockers(planned),
            blockerPolicy: 'exact',
            updatedDateUtc: planned.UpdatedDateUTC,
          },
          fresh ? { id: fresh.CreditNoteID, status: fresh.Status, contactName: fresh.Contact?.Name, blockers: cnBlockers(fresh), updatedDateUtc: fresh.UpdatedDateUTC } : null,
        )
        live = fresh!
      }

      for (const alloc of live.Allocations ?? []) {
        if (!alloc.AllocationID) {
          failures.push(`${live.CreditNoteNumber}: allocation without an AllocationID — remove by hand`)
          stats.failed++
          continue
        }
        act(`delete allocation ${alloc.AllocationID} (${alloc.Amount}) on ${live.CreditNoteNumber} -> invoice ${alloc.Invoice?.InvoiceID}`)
        if (!APPLY) { stats.allocationsDeleted++; continue }
        const res = await transport.request(token, 'DELETE', `CreditNotes/${live.CreditNoteID}/Allocations/${alloc.AllocationID}`)
        if (res.ok) stats.allocationsDeleted++
        else { stats.failed++; failures.push(`allocation ${alloc.AllocationID} on ${live.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
      }

      // A refund paid out against the credit note blocks the void the same way an allocation does.
      // Xero has no DELETE verb for a payment — the reversal is a POST moving it to DELETED.
      for (const payment of live.Payments ?? []) {
        act(`delete refund payment ${payment.PaymentID} (${payment.Amount}) on ${live.CreditNoteNumber}`)
        if (!APPLY) { stats.refundsDeleted++; continue }
        const res = await transport.request(token, 'POST', `Payments/${payment.PaymentID}`, { Status: 'DELETED' })
        if (res.ok) stats.refundsDeleted++
        else { stats.failed++; failures.push(`refund ${payment.PaymentID} on ${live.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
      }
    }
  }

  // --- step 2: void credit notes
  if (STEPS.has('2')) {
    console.log('\n--- step 2: void credit notes ---')
    for (const planned of creditNotes) {
      if (TERMINAL.has(planned.Status)) { stats.skipped++; continue }
      let current = planned
      if (APPLY) {
        const fresh = await reread<CreditNote>(token, `CreditNotes/${planned.CreditNoteID}`, 'CreditNotes')
        assertStillFixtureContact(planned.CreditNoteID, fresh?.Contact?.Name)
        // Step 1 legitimately released this document's allocations and refunds, which also moves a
        // PAID credit note to AUTHORISED. Those are the only changes allowed: a blocker that did
        // not exist at plan time, or any other status, means someone else is working on it.
        assertUnchanged(
          {
            id: planned.CreditNoteID,
            allowedStatuses: statusesAfterReleasingBlockers(planned.Status),
            contactName: planned.Contact?.Name,
            blockers: cnBlockers(planned),
            blockerPolicy: 'subset',
          },
          fresh ? { id: fresh.CreditNoteID, status: fresh.Status, contactName: fresh.Contact?.Name, blockers: cnBlockers(fresh) } : null,
        )
        current = fresh!
      }
      const target = terminalStatusFor(current.Status)
      act(`${target === 'DELETED' ? 'delete' : 'void'} credit note ${current.CreditNoteNumber} (${current.Status}, ${current.Total})`)
      if (!APPLY) { stats.creditNotesVoided++; continue }
      const res = await transport.request(token, 'POST', `CreditNotes/${current.CreditNoteID}`, { Status: target })
      if (res.ok) stats.creditNotesVoided++
      else { stats.failed++; failures.push(`credit note ${current.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
    }
  }

  // --- step 3: void invoices
  if (STEPS.has('3')) {
    console.log('\n--- step 3: void invoices ---')
    for (const planned of invoices) {
      if (TERMINAL.has(planned.Status)) { stats.skipped++; continue }
      let current = planned
      if (APPLY) {
        const fresh = await reread<Invoice>(token, `Invoices/${planned.InvoiceID}`, 'Invoices')
        assertStillFixtureContact(planned.InvoiceID, fresh?.Contact?.Name)
        // Steps 1-2 legitimately released this invoice's credit notes and payments, which also moves
        // a PAID invoice to AUTHORISED. Nothing else may have changed.
        assertUnchanged(
          {
            id: planned.InvoiceID,
            allowedStatuses: statusesAfterReleasingBlockers(planned.Status),
            contactName: planned.Contact?.Name,
            blockers: invBlockers(planned),
            blockerPolicy: 'subset',
          },
          fresh ? { id: fresh.InvoiceID, status: fresh.Status, contactName: fresh.Contact?.Name, blockers: invBlockers(fresh) } : null,
        )
        current = fresh!
      }
      const target = terminalStatusFor(current.Status)
      act(`${target === 'DELETED' ? 'delete' : 'void'} invoice ${current.InvoiceNumber} (${current.Status}, ${current.Total})`)
      if (!APPLY) { stats.invoicesVoided++; continue }
      const res = await transport.request(token, 'POST', `Invoices/${current.InvoiceID}`, { Status: target })
      if (res.ok) stats.invoicesVoided++
      else { stats.failed++; failures.push(`invoice ${current.InvoiceNumber}: HTTP ${res.status} ${res.error}`) }
    }
  }

  // --- step 4: archive contacts
  if (STEPS.has('4')) {
    console.log('\n--- step 4: archive E2E contacts ---')
    for (const planned of contacts) {
      if (planned.ContactStatus === 'ARCHIVED') { stats.skipped++; continue }
      let current = planned
      if (APPLY) {
        const fresh = await reread<Contact>(token, `Contacts/${planned.ContactID}`, 'Contacts')
        assertStillFixtureContact(planned.ContactID, fresh?.Name)
        assertUnchanged(
          {
            id: planned.ContactID,
            allowedStatuses: [planned.ContactStatus],
            contactName: planned.Name,
            updatedDateUtc: planned.UpdatedDateUTC,
          },
          fresh ? { id: fresh.ContactID, status: fresh.ContactStatus, contactName: fresh.Name, updatedDateUtc: fresh.UpdatedDateUTC } : null,
        )
        current = fresh!
      }
      act(`archive contact ${current.Name}`)
      if (!APPLY) { stats.contactsArchived++; continue }
      const res = await transport.request(token, 'POST', `Contacts/${current.ContactID}`, { ContactStatus: 'ARCHIVED' })
      if (res.ok) stats.contactsArchived++
      else { stats.failed++; failures.push(`contact ${current.Name}: HTTP ${res.status} ${res.error}`) }
    }
  }

  // --- step 5: delete items
  if (STEPS.has('5')) {
    console.log('\n--- step 5: delete E2E items ---')
    for (const planned of items) {
      if (APPLY) {
        const fresh = await reread<Item>(token, `Items/${planned.ItemID}`, 'Items')
        if (!fresh || !isFixtureItemCode(fresh.Code) || fresh.Code !== planned.Code) {
          throw new SafetyViolationError(
            `ABORT: item ${planned.ItemID} re-read as ${JSON.stringify(fresh?.Code ?? '(unreadable)')}, not the ` +
              `planned full-chain fixture code ${JSON.stringify(planned.Code)}. Nothing further was written.`,
          )
        }
      }
      act(`delete item ${planned.Code}`)
      if (!APPLY) { stats.itemsDeleted++; continue }
      const res = await transport.request(token, 'DELETE', `Items/${planned.ItemID}`)
      if (res.ok) stats.itemsDeleted++
      else {
        // Expected for any item still referenced by a (now voided) document. It is still a failure
        // to complete the plan, so it counts and the run exits non-zero.
        stats.failed++
        failures.push(`item ${planned.Code}: HTTP ${res.status} ${res.error}`)
      }
    }
  }

  const outcome = runOutcome({ apply: APPLY, failed: stats.failed })
  console.log(`\n=== ${outcome.label} ===`)
  console.log(`  allocations deleted: ${stats.allocationsDeleted}`)
  console.log(`  refund payments deleted: ${stats.refundsDeleted}`)
  console.log(`  credit notes voided: ${stats.creditNotesVoided}`)
  console.log(`  invoices voided:     ${stats.invoicesVoided}`)
  console.log(`  contacts archived:   ${stats.contactsArchived}`)
  console.log(`  items deleted:       ${stats.itemsDeleted}`)
  console.log(`  skipped (already terminal): ${stats.skipped}`)
  console.log(`  failed:              ${stats.failed}`)
  if (failures.length) {
    console.log('\nfailures:')
    for (const f of failures.slice(0, 40)) console.log(`  - ${f}`)
    if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`)
  }
  console.log(`\nAPI calls used: ${transport.callCount}`)
  if (!APPLY) console.log(`\nReview ${PLAN_OUT}, then re-run with --manifest <reviewed csv> --apply.`)
  if (outcome.exitCode !== 0) {
    console.error(`\nThe footprint was NOT fully removed. Re-run the read-only footprint audit before trying again.`)
    process.exitCode = outcome.exitCode
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
