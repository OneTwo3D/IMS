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
 *                        object selected live but absent from the manifest is fatal — and so is one
 *                        whose STATE has moved since it was reviewed. The manifest records status,
 *                        contact, blockers and UpdatedDateUTC, and the plan must match all of them.
 *                        A uuid says which object a human approved; it cannot say what they
 *                        approved doing to it, and a credit note reviewed as SUBMITTED (no GL
 *                        effect, deletable) that a person has since APPROVED is a different
 *                        proposition wearing the same id.
 *   RE-READ BEFORE EACH WRITE.  Every object is GET-ed again immediately before it is mutated and
 *                        must be identical to the plan — status, contact, blockers, UpdatedDateUTC.
 *                        The failure this closes is a document re-contacted to a GENUINE customer
 *                        between plan and write: still in a valid status, so Xero accepts the void.
 *                        That is a wrong write, not a rejected one. The version is a REQUIRED field
 *                        of that expectation, never an optional one: it is the catch-all for the
 *                        changes the named fields cannot express, and an optional field a call site
 *                        omits is indistinguishable from one that matched. The only alternative to
 *                        an exact version is a NAMED exemption, which the run counts and prints.
 *   ONLY THIS RUN'S OWN CHANGES ARE FORGIVEN.  Step 1 legitimately moves a PAID document to
 *                        AUTHORISED, so later steps have to tolerate that transition — but only on
 *                        the documents where THIS RUN recorded the successful delete. The same
 *                        transition caused by somebody else, in the Xero UI, while this run was
 *                        part-way through, stops it. "It happened" is not "we did it".
 *   NO SUCCESSFUL PARTIAL.  Any failure exits non-zero and the banner says PARTIALLY APPLIED —
 *                        including when the run THROWS after writing. An abort that prints only an
 *                        error message leaves the operator with no idea that eighty invoices are
 *                        already irreversibly voided.
 *   NOTHING IS CALLED "NOT WRITTEN" UNLESS XERO SAID SO.  Every write goes through `settleWrite`,
 *                        which knows three answers rather than two. A request whose response was
 *                        lost — a gateway timeout, a dropped connection — MAY have been applied,
 *                        so it is recorded as UNKNOWN, it stops the run, and the banner says
 *                        PARTIALLY APPLIED and names the object. "The run was a no-op" is the
 *                        worst thing this tooling can say about a ledger it might have changed.
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
  allocationBlocker,
  allowedStatusesAfterRun,
  assertExpectedTenant,
  assertManifestTenant,
  assertNoNearMisses,
  assertPlanAuthorizedByManifest,
  assertStillFixtureContact,
  assertUnchanged,
  classifyContactName,
  classifyItemCode,
  createXeroTransport,
  creditNoteBlockers,
  invoiceBlockers,
  isFixtureContactName,
  isFixtureItemCode,
  MutationJournal,
  pageAllComplete,
  parseWriteManifest,
  runOutcome,
  SafetyViolationError,
  settleWrite,
  type PlannedObject,
  type TransportToken,
  type VersionExpectation,
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
/** `Type` is ACCREC (sales invoice) or ACCPAY (bill). The manifest files them under those names. */
type Invoice = { InvoiceID: string; Type?: string; InvoiceNumber?: string; Status: string; Total?: number; UpdatedDateUTC?: string; Contact?: { Name?: string }; Payments?: Array<{ PaymentID: string }>; CreditNotes?: Array<{ CreditNoteID: string }> }
type Contact = { ContactID: string; Name: string; ContactStatus: string; UpdatedDateUTC?: string }
type Item = { ItemID: string; Code: string; UpdatedDateUTC?: string }

const TERMINAL = new Set(['VOIDED', 'DELETED'])

const stats = {
  allocationsDeleted: 0, refundsDeleted: 0, creditNotesVoided: 0, invoicesVoided: 0,
  contactsArchived: 0, itemsDeleted: 0, skipped: 0, failed: 0,
  /**
   * Objects written under a RELAXED version check — ones this run had itself already modified, so
   * their UpdatedDateUTC could not be required to equal the reviewed one. Counted and printed
   * because a waived catch-all is something the operator is entitled to know the size of.
   */
  versionRelaxed: 0,
}
const failures: string[] = []

/**
 * What this run has actually done, so far. Two jobs, one fact:
 *   • it is the record of which blockers THIS RUN released, so a later step can tell a status this
 *     run caused from one that merely happened;
 *   • it is the count of irreversible writes already made, so a run that throws can still report
 *     how much of the ledger it had already destroyed.
 * Only SUCCEEDED writes go in. An attempted delete that failed explains nothing.
 */
const journal = new MutationJournal()

/** Journal keys. A single allocation delete releases both sides, so both are recorded. */
const cnKey = (id: string) => `creditnote:${id}`
const invKey = (id: string) => `invoice:${id}`

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

/**
 * The SHARED blocker grammar (scripts/lib/xero-live-safety.ts), not a local one. The manifest
 * records the blocker set a human reviewed and this script refuses any object whose set has moved,
 * so the audit that writes the CSV and the writer that reads it have to name blockers identically.
 * They previously did not — the audit wrote `allocated-to:<invoiceId>` where this file wrote
 * `allocation:<AllocationID>` — and comparing those two would have reported every allocated credit
 * note as changed, for a difference that is purely in vocabulary.
 */
const cnBlockers = creditNoteBlockers
const invBlockers = invoiceBlockers

// ---------------------------------------------------------------------------
// Per-object re-read, immediately before the mutation
// ---------------------------------------------------------------------------
async function reread<T>(token: Token, path: string, key: string): Promise<T | null> {
  const res = await transport.request<Record<string, T[]>>(token, 'GET', path)
  if (!res.ok) return null
  return res.data?.[key]?.[0] ?? null
}

/**
 * The version this object must be at when we write to it.
 *
 * Two cases, and the code has to say which one it is claiming — the field is required, so there is
 * no third case where the check simply is not there:
 *
 *   • THIS RUN HAS NOT TOUCHED IT. Byte-identical to the reviewed plan, full stop. This is every
 *     object in steps 3, 4 and 5, and every credit note in step 2 that had no allocations.
 *   • THIS RUN RELEASED A BLOCKER OFF IT in step 1. Xero re-stamps UpdatedDateUTC when it does
 *     that, so byte-equality is arithmetically impossible and demanding it would abort every real
 *     apply. The version must still be readable and must not have gone backwards, and the object
 *     is counted so the banner can say how many writes went out under the weaker check.
 *
 * `journal.causedRelease` is the gate, and it is fed only by DELETEs that Xero CONFIRMED. An
 * attempted release, or one whose response was lost, licenses nothing — the run aborts on the
 * latter long before it reaches here.
 */
function versionFor(subjectKey: string, plannedUpdatedDateUtc?: string): VersionExpectation {
  if (!journal.causedRelease(subjectKey)) {
    return { policy: 'unchanged', updatedDateUtc: plannedUpdatedDateUtc ?? '' }
  }
  stats.versionRelaxed++
  return {
    policy: 'moved-by-this-run',
    plannedUpdatedDateUtc: plannedUpdatedDateUtc ?? '',
    because: journal.releasedFor(subjectKey),
  }
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

  // The plan carries STATE, not just identity, because that is what the manifest authorises. Every
  // field here has a counterpart column in the CSV a human read.
  const plan: PlannedObject[] = [
    ...creditNotes.map((c) => ({
      uuid: c.CreditNoteID, entity: 'creditnote', label: c.CreditNoteNumber ?? '',
      status: c.Status, contactName: c.Contact?.Name ?? '', blockers: cnBlockers(c), updatedDateUtc: c.UpdatedDateUTC ?? '',
    })),
    ...invoices.map((i) => ({
      // The audit files ACCPAY under `bill`; the entity name is compared, so it has to agree.
      uuid: i.InvoiceID, entity: i.Type === 'ACCPAY' ? 'bill' : 'invoice', label: i.InvoiceNumber ?? '',
      status: i.Status, contactName: i.Contact?.Name ?? '', blockers: invBlockers(i), updatedDateUtc: i.UpdatedDateUTC ?? '',
    })),
    ...contacts.map((c) => ({
      uuid: c.ContactID, entity: 'contact', label: c.Name,
      status: c.ContactStatus, contactName: c.Name, blockers: [], updatedDateUtc: c.UpdatedDateUTC ?? '',
    })),
    ...items.map((i) => ({
      uuid: i.ItemID, entity: 'item', label: i.Code,
      status: '', contactName: '', blockers: [], updatedDateUtc: i.UpdatedDateUTC ?? '',
    })),
  ]

  if (manifest) {
    // Identity AND state. An object that has moved since the review is refused here, BEFORE the
    // first mutation, rather than discovered half-way through by the per-object re-read.
    const { missingFromLedger } = assertPlanAuthorizedByManifest(plan, manifest)
    console.log(`  manifest check: all ${plan.length} planned object(s) are reviewed AND still in the reviewed state; ${missingFromLedger.length} manifest id(s) are no longer in the org (already cleaned up).`)
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
            // Nothing in this run has written to this document yet, so the catch-all is exact.
            version: { policy: 'unchanged', updatedDateUtc: planned.UpdatedDateUTC ?? '' },
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
        // settleWrite, not `res.ok`: a DELETE whose response was lost may have released the
        // allocation, and "it failed" would license step 2 to expect a blocker that is gone.
        if (settleWrite({ res, journal, kind: 'allocation deleted', label: `${live.CreditNoteNumber} -> invoice ${alloc.Invoice?.InvoiceID ?? '?'}` })) {
          stats.allocationsDeleted++
          // Recorded against BOTH sides: deleting the allocation releases the credit note and the
          // invoice at once, and each of them may legitimately move PAID -> AUTHORISED as a result.
          // This — a succeeded DELETE, in this process — is the ONLY thing that later licenses
          // either document to have moved.
          journal.recordRelease(cnKey(live.CreditNoteID), allocationBlocker(alloc))
          if (alloc.Invoice?.InvoiceID) {
            journal.recordRelease(invKey(alloc.Invoice.InvoiceID), `creditnote:${live.CreditNoteID}`)
          }
        } else { stats.failed++; failures.push(`allocation ${alloc.AllocationID} on ${live.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
      }

      // A refund paid out against the credit note blocks the void the same way an allocation does.
      // Xero has no DELETE verb for a payment — the reversal is a POST moving it to DELETED.
      for (const payment of live.Payments ?? []) {
        act(`delete refund payment ${payment.PaymentID} (${payment.Amount}) on ${live.CreditNoteNumber}`)
        if (!APPLY) { stats.refundsDeleted++; continue }
        const res = await transport.request(token, 'POST', `Payments/${payment.PaymentID}`, { Status: 'DELETED' })
        if (settleWrite({ res, journal, kind: 'refund deleted', label: `${payment.PaymentID} on ${live.CreditNoteNumber}` })) {
          stats.refundsDeleted++
          journal.recordRelease(cnKey(live.CreditNoteID), `refund:${payment.PaymentID}`)
        } else { stats.failed++; failures.push(`refund ${payment.PaymentID} on ${live.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
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
        // PAID credit note to AUTHORISED — but ONLY on the documents where step 1's DELETE actually
        // succeeded, and only for the blockers it actually removed. Both facts come from this run's
        // own journal. A document that moved for any other reason, or lost a blocker this run did
        // not delete, is a document somebody else is working on while we hold a write token.
        const released = journal.releasedFor(cnKey(planned.CreditNoteID))
        assertUnchanged(
          {
            id: planned.CreditNoteID,
            allowedStatuses: allowedStatusesAfterRun(planned.Status, journal.causedRelease(cnKey(planned.CreditNoteID))),
            contactName: planned.Contact?.Name,
            blockers: cnBlockers(planned),
            blockerPolicy: 'released',
            releasedBlockers: released,
            // The catch-all, at the write. Exact unless step 1 released something off this exact
            // document — the same journal fact that widens the status set, applied to the version.
            version: versionFor(cnKey(planned.CreditNoteID), planned.UpdatedDateUTC),
          },
          fresh ? { id: fresh.CreditNoteID, status: fresh.Status, contactName: fresh.Contact?.Name, blockers: cnBlockers(fresh), updatedDateUtc: fresh.UpdatedDateUTC } : null,
        )
        current = fresh!
      }
      const target = terminalStatusFor(current.Status)
      act(`${target === 'DELETED' ? 'delete' : 'void'} credit note ${current.CreditNoteNumber} (${current.Status}, ${current.Total})`)
      if (!APPLY) { stats.creditNotesVoided++; continue }
      const res = await transport.request(token, 'POST', `CreditNotes/${current.CreditNoteID}`, { Status: target })
      if (settleWrite({
        res, journal,
        kind: target === 'DELETED' ? 'credit note deleted' : 'credit note voided',
        label: current.CreditNoteNumber ?? current.CreditNoteID,
      })) {
        stats.creditNotesVoided++
      } else { stats.failed++; failures.push(`credit note ${current.CreditNoteNumber}: HTTP ${res.status} ${res.error}`) }
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
        // Step 1 legitimately released the credit notes allocated to this invoice, which also moves
        // a PAID invoice to AUTHORISED — but only where this run's own DELETE succeeded. Note what
        // is NOT forgiven: no step here deletes a PAYMENT against an invoice, so an invoice that
        // has stopped being PAID without this run releasing a credit note was settled or unsettled
        // by someone else, and voiding it on a stale plan is the wrong write.
        const released = journal.releasedFor(invKey(planned.InvoiceID))
        assertUnchanged(
          {
            id: planned.InvoiceID,
            allowedStatuses: allowedStatusesAfterRun(planned.Status, journal.causedRelease(invKey(planned.InvoiceID))),
            contactName: planned.Contact?.Name,
            blockers: invBlockers(planned),
            blockerPolicy: 'released',
            releasedBlockers: released,
            // Exact unless step 1 deleted an allocation that pointed AT this invoice. Most
            // invoices in a run never get one, so most of these are the strong check.
            version: versionFor(invKey(planned.InvoiceID), planned.UpdatedDateUTC),
          },
          fresh ? { id: fresh.InvoiceID, status: fresh.Status, contactName: fresh.Contact?.Name, blockers: invBlockers(fresh), updatedDateUtc: fresh.UpdatedDateUTC } : null,
        )
        current = fresh!
      }
      const target = terminalStatusFor(current.Status)
      act(`${target === 'DELETED' ? 'delete' : 'void'} invoice ${current.InvoiceNumber} (${current.Status}, ${current.Total})`)
      if (!APPLY) { stats.invoicesVoided++; continue }
      const res = await transport.request(token, 'POST', `Invoices/${current.InvoiceID}`, { Status: target })
      if (settleWrite({
        res, journal,
        kind: target === 'DELETED' ? 'invoice deleted' : 'invoice voided',
        label: current.InvoiceNumber ?? current.InvoiceID,
      })) {
        stats.invoicesVoided++
      } else { stats.failed++; failures.push(`invoice ${current.InvoiceNumber}: HTTP ${res.status} ${res.error}`) }
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
            // No step touches contacts before this one, so the catch-all is exact.
            version: { policy: 'unchanged', updatedDateUtc: planned.UpdatedDateUTC ?? '' },
          },
          fresh ? { id: fresh.ContactID, status: fresh.ContactStatus, contactName: fresh.Name, updatedDateUtc: fresh.UpdatedDateUTC } : null,
        )
        current = fresh!
      }
      act(`archive contact ${current.Name}`)
      if (!APPLY) { stats.contactsArchived++; continue }
      const res = await transport.request(token, 'POST', `Contacts/${current.ContactID}`, { ContactStatus: 'ARCHIVED' })
      if (settleWrite({ res, journal, kind: 'contact archived', label: current.Name })) {
        stats.contactsArchived++
      } else { stats.failed++; failures.push(`contact ${current.Name}: HTTP ${res.status} ${res.error}`) }
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
        // An item deletion is irreversible too, and the code is the only field the check above can
        // see. Everything else about an item — its accounts, its tax rates, whether a real document
        // now references it — moves UpdatedDateUTC and nothing else, which is exactly what the
        // catch-all is for. Items have no status or contact, so those sides are empty on both.
        assertUnchanged(
          {
            id: planned.ItemID,
            allowedStatuses: [''],
            version: { policy: 'unchanged', updatedDateUtc: planned.UpdatedDateUTC ?? '' },
          },
          { id: fresh.ItemID, status: '', updatedDateUtc: fresh.UpdatedDateUTC },
        )
      }
      act(`delete item ${planned.Code}`)
      if (!APPLY) { stats.itemsDeleted++; continue }
      const res = await transport.request(token, 'DELETE', `Items/${planned.ItemID}`)
      if (settleWrite({ res, journal, kind: 'item deleted', label: planned.Code })) {
        stats.itemsDeleted++
      } else {
        // Expected for any item still referenced by a (now voided) document. It is still a failure
        // to complete the plan, so it counts and the run exits non-zero.
        stats.failed++
        failures.push(`item ${planned.Code}: HTTP ${res.status} ${res.error}`)
      }
    }
  }
}

/**
 * The end-of-run banner. It is a separate function, and it is called from the abort path as well
 * as the normal one, because those are the two ways this script stops and only one of them used
 * to say anything about the ledger.
 *
 * A guard that fires half-way through step 3 is doing its job — but the process then threw, the
 * `catch` printed one line about one credit note, and nothing on screen said that eighty invoices
 * were already irreversibly voided. The reporting that exists precisely to say "destruction was
 * partial" was bypassed by the exception. So: same summary, both paths, and when the run aborted
 * after writing, the banner leads with PARTIALLY APPLIED and the count of irreversible writes.
 */
function report(aborted: boolean, error?: unknown): number {
  const outcome = runOutcome({
    apply: APPLY,
    failed: stats.failed,
    aborted,
    writesMade: journal.writeCount,
    unknownWrites: journal.unknownCount,
  })
  console.log(`\n=== ${outcome.label} ===`)
  if (aborted) {
    console.log(`  ABORTED: ${error instanceof Error ? error.message : String(error)}`)
    console.log(journal.writeCount > 0
      ? `  ${journal.writeCount} irreversible write(s) had ALREADY SUCCEEDED before the run stopped. They cannot be undone.`
      : journal.unknownCount > 0
        // "Nothing was written" is a claim about the live ledger, and with an unresolved request
        // outstanding it is a claim this process is not entitled to make.
        ? '  No write was CONFIRMED before the run stopped — but see the unknown outcome(s) below; the ledger may have changed.'
        : '  Nothing had been written when the run stopped.')
  }
  console.log(`  allocations deleted: ${stats.allocationsDeleted}`)
  console.log(`  refund payments deleted: ${stats.refundsDeleted}`)
  console.log(`  credit notes voided: ${stats.creditNotesVoided}`)
  console.log(`  invoices voided:     ${stats.invoicesVoided}`)
  console.log(`  contacts archived:   ${stats.contactsArchived}`)
  console.log(`  items deleted:       ${stats.itemsDeleted}`)
  console.log(`  skipped (already terminal): ${stats.skipped}`)
  console.log(`  failed:              ${stats.failed}`)
  console.log(`  UNKNOWN OUTCOME:     ${journal.unknownCount}`)
  if (stats.versionRelaxed > 0) {
    console.log(`  written under a relaxed UpdatedDateUTC check (this run had already moved them): ${stats.versionRelaxed}`)
  }
  if (journal.unknownCount > 0) {
    console.log('\nWRITES WHOSE OUTCOME IS UNKNOWN — these may or may not be in the ledger:')
    for (const u of journal.unknownRecords) console.log(`  - ${u.kind}: ${u.label} (${u.reason})`)
    console.log(
      '\n  Recover by READING, not by re-running: open each object above in Xero, or re-run\n' +
      '  scripts/audit-xero-live-e2e-footprint.ts, and compare its status against the plan in\n' +
      `  ${PLAN_OUT}. Only once every one of them is accounted for is a new manifest — and a new\n` +
      '  --apply — safe. Re-running against the OLD manifest would plan from a state nobody confirmed.',
    )
  }
  if (failures.length) {
    console.log('\nfailures:')
    for (const f of failures.slice(0, 40)) console.log(`  - ${f}`)
    if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`)
  }
  if (aborted && journal.writeCount > 0) {
    console.log('\nirreversible writes already made:')
    for (const w of journal.writeRecords.slice(0, 40)) console.log(`  - ${w.kind}: ${w.label}`)
    if (journal.writeCount > 40) console.log(`  ... and ${journal.writeCount - 40} more`)
  }
  console.log(`\nAPI calls used: ${transport.callCount}`)
  if (!APPLY && !aborted) console.log(`\nReview ${PLAN_OUT}, then re-run with --manifest <reviewed csv> --apply.`)
  if (outcome.exitCode !== 0) {
    console.error(`\nThe footprint was NOT fully removed. Re-run the read-only footprint audit before trying again.`)
  }
  return outcome.exitCode
}

main()
  .then(() => { process.exitCode = report(false) })
  .catch((e) => {
    console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = report(true, e)
  })
