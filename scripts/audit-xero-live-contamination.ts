/**
 * o3d-t74p — READ-ONLY audit of the e2e contamination sitting in the LIVE Xero organisation.
 *
 * Between 2026-07-15 20:49 and 2026-07-26 07:55 the e2e instance was connected to the LIVE Xero
 * org and posted 553 objects into it. This script reads that org and reports, per object, what is
 * actually there now — so the cleanup worklist is built from Xero's answer rather than from a name
 * search in the UI. It writes NOTHING, anywhere.
 *
 * WHY IT DOES NOT IMPORT lib/connectors/xero/*
 * -------------------------------------------
 * Every helper there resolves auth through getAccessToken() -> db.accountingToken
 * (lib/connectors/xero/auth.ts:76). Using them would mean writing a LIVE-tenant token into an IMS
 * database, which is precisely the act that caused this incident. This script therefore carries its
 * own OAuth and its own fetch, and the fetch helper can only issue GET — there is no code path here
 * that can mutate the live ledger, whatever it is pointed at.
 *
 * It also asks Xero for READ-ONLY scopes. A token minted by this script is incapable of writing even
 * if some later edit tried to.
 *
 * CALL BUDGET (Xero: 60/min, 5,000/day, per tenant per app)
 * --------------------------------------------------------
 * ~32 calls for the full sweep: invoices and credit notes are fetched in batched IDs= filters,
 * manual journals are paged with If-Modified-Since rather than fetched one by one. Only the
 * per-minute ceiling is reachable, so calls are paced and 429 Retry-After is honoured.
 *
 * USAGE
 *   # one-time: add the loopback redirect URI below to the Xero app in the developer portal
 *   SETTINGS_ENCRYPTION_KEY=... DATABASE_URL=postgresql://.../onetwo3d_ims_e2e \
 *     node_modules/.bin/tsx scripts/audit-xero-live-contamination.ts --tenant "Your Live Org Ltd"
 *
 * The consent step assumes NOTHING about where your browser is. A localhost redirect resolves in
 * the browser's own machine, so a laptop browser cannot reach a listener on this server — and Xero
 * allows plain http only for localhost, so a LAN address is not permitted either. The script
 * therefore waits on the loopback listener AND on stdin at the same time: if the redirect fails to
 * load, paste the browser's address bar back in and it proceeds. An SSH tunnel
 * (`ssh -L 53100:localhost:53100 <host>`) makes the listener work directly instead.
 *
 *   --csv <path>       contamination CSV (default /root/xero-live-e2e-contamination-20260804.csv)
 *   --out <path>       reconciliation CSV to write (default ./xero-live-reconciliation-<date>.csv)
 *   --tenant <name>    which connected organisation to audit; required when >1 is authorised
 *   --port <n>         loopback port for the OAuth callback (default 53100)
 *   --token-file <p>   where to cache the audit token (default /root/.xero-audit-token.json, 0600)
 *   --allow-demo       permit auditing Demo Company (UK); refused by default as a mistake-catcher
 *   --max-calls <n>    hard ceiling on API calls (default 500)
 *
 * The credentials come from the e2e database's own settings (xero_client_id / xero_client_secret,
 * decrypted with SETTINGS_ENCRYPTION_KEY) so no secret needs to be pasted on a command line;
 * XERO_AUDIT_CLIENT_ID / XERO_AUDIT_CLIENT_SECRET override them.
 */
import { Client } from 'pg'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'

/**
 * READ-ONLY scopes, one per endpoint family this audit reads. Nothing here grants write access —
 * that is the point of the whole script.
 *
 * NOT accounting.transactions.read, which is the obvious choice and which Xero REJECTS for this
 * app with invalid_scope. Probed against the live authorize endpoint: accounting.transactions,
 * accounting.transactions.read, accounting.journals.read and accounting.reports.read are all
 * refused, while the granular per-endpoint family below is accepted — the same vocabulary
 * XERO_REQUESTED_SCOPES already uses (lib/connectors/xero/scopes.ts). Whatever the app was
 * registered as, that is the vocabulary it has.
 *
 *   accounting.invoices.read       Invoices (ACCREC + ACCPAY) AND CreditNotes — scopes.ts:27
 *                                  records that accounting.invoices spans both.
 *   accounting.payments.read       Payments.
 *   accounting.manualjournals.read ManualJournals.
 *   accounting.contacts.read       Contacts.
 *   accounting.settings.read       Organisation (incl. the lock dates) and Items.
 */
const AUDIT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.invoices.read',
  'accounting.payments.read',
  'accounting.manualjournals.read',
  'accounting.contacts.read',
  'accounting.settings.read',
].join(' ')

/** The window the e2e instance was pointed at the live org, per o3d-t74p. */
const CONTAMINATION_START = '2026-07-15T00:00:00Z'

const DEMO_TENANT_NAME = 'Demo Company (UK)'
/** e2e fixtures name every contact and SKU with this prefix. */
const E2E_PREFIX = 'E2E'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const FLAG_ALLOW_DEMO = process.argv.includes('--allow-demo')
/** Cost and classify the sweep without authorising or touching the network. */
const PLAN_ONLY = process.argv.includes('--plan-only')
const CSV_PATH = arg('csv', '/root/xero-live-e2e-contamination-20260804.csv')!
const OUT_PATH = arg('out', `./xero-live-reconciliation-${new Date().toISOString().slice(0, 10)}.csv`)!
const CALLBACK_PORT = Number(arg('port', '53100'))
const TOKEN_FILE = arg('token-file', '/root/.xero-audit-token.json')!
const MAX_CALLS = Number(arg('max-calls', '500'))
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`

// ---------------------------------------------------------------------------
// Secrets: a local copy of lib/secrets' decrypt, so this file imports nothing
// from the app (see header).
// ---------------------------------------------------------------------------
const ENCRYPTED_PREFIX = 'enc:v1:'

function resolveEncryptionKey(): Buffer | null {
  const raw = (process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY ?? '').trim()
  if (!raw) return null
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  const b64 = Buffer.from(raw, 'base64')
  if (b64.length === 32) return b64
  const utf8 = Buffer.from(raw, 'utf8')
  return utf8.length === 32 ? utf8 : null
}

function decryptSecret(value: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value
  const key = resolveEncryptionKey()
  if (!key) throw new Error('SETTINGS_ENCRYPTION_KEY is required to read xero_client_secret')
  const payload = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
  decipher.setAuthTag(payload.subarray(12, 28))
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// Contamination CSV
// ---------------------------------------------------------------------------
type ContaminationRow = {
  createdAt: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string
}

/**
 * Which Xero entity each AccountingSyncType became. Mirrors the dispatch in
 * lib/connectors/xero/sync-processor.ts: anything not an invoice, credit note or payment went to
 * pushManualJournal, so the journal bucket is the DEFAULT rather than an enumerated list — a sync
 * type added later lands in the right bucket instead of being silently dropped from the audit.
 */
type Entity = 'invoice' | 'creditnote' | 'payment' | 'journal'

function entityFor(type: string): Entity {
  if (type === 'SALES_INVOICE' || type === 'SALES_INVOICE_UPDATE') return 'invoice'
  if (type === 'PURCHASE_INVOICE' || type === 'PURCHASE_INVOICE_UPDATE') return 'invoice'
  if (type === 'CREDIT_NOTE' || type === 'PURCHASE_CREDIT_NOTE') return 'creditnote'
  if (type === 'INVOICE_PAYMENT' || type === 'BILL_PAYMENT') return 'payment'
  return 'journal'
}

function parseCsv(path: string): ContaminationRow[] {
  const text = readFileSync(path, 'utf8').trim()
  const [header, ...lines] = text.split(/\r?\n/)
  const cols = header.split(',')
  return lines.map((line) => {
    // The export contains no quoted commas; assert that rather than assume it.
    const parts = line.split(',')
    if (parts.length !== cols.length) {
      throw new Error(`Malformed CSV line (${parts.length} fields, expected ${cols.length}): ${line}`)
    }
    return Object.fromEntries(cols.map((c, i) => [c, parts[i]])) as ContaminationRow
  })
}

// ---------------------------------------------------------------------------
// OAuth (authorization code + loopback listener)
// ---------------------------------------------------------------------------
type StoredToken = { accessToken: string; refreshToken: string; tenantId: string; tenantName: string; expiresAt: number }

async function readCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const envId = process.env.XERO_AUDIT_CLIENT_ID
  const envSecret = process.env.XERO_AUDIT_CLIENT_SECRET
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Set DATABASE_URL (the e2e database) or XERO_AUDIT_CLIENT_ID/SECRET')
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    const res = await db.query<{ key: string; value: string }>(
      `select key, value from settings where key in ('xero_client_id','xero_client_secret')`,
    )
    const map = new Map(res.rows.map((r) => [r.key, r.value]))
    const clientId = map.get('xero_client_id')
    const clientSecret = map.get('xero_client_secret')
    if (!clientId || !clientSecret) throw new Error('xero_client_id / xero_client_secret not found in settings')
    return { clientId: decryptSecret(clientId), clientSecret: decryptSecret(clientSecret) }
  } finally {
    await db.end()
  }
}

function loadCachedToken(): StoredToken | null {
  if (!existsSync(TOKEN_FILE)) return null
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as StoredToken
  } catch {
    return null
  }
}

function saveToken(token: StoredToken): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)
}

/**
 * Wait for Xero to redirect back to the loopback listener, and hand back the code.
 *
 * Only reachable when the BROWSER runs on this machine, or through an SSH tunnel
 * (`ssh -L <port>:localhost:<port> <host>`). A redirect to localhost resolves in the browser's
 * own machine, so a laptop browser hitting a server-side listener sees nothing — which is why
 * awaitPastedCode runs alongside this rather than instead of it. Xero permits plain http only for
 * localhost/127.0.0.1, so pointing the redirect at the server's LAN address is not an option.
 */
function awaitAuthorizationCode(expectedState: string): { promise: Promise<string>; cancel: () => void } {
  let cancel = () => {}
  const promise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found')
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      if (error) {
        res.end(`Xero returned an error: ${error}. You can close this tab.`)
        server.close()
        reject(new Error(`Xero authorization failed: ${error}`))
        return
      }
      // CSRF / mix-up protection, same reason the app validates state in its own callback.
      if (!state || state !== expectedState) {
        res.end('State mismatch — authorization rejected. You can close this tab.')
        server.close()
        reject(new Error('OAuth state mismatch'))
        return
      }
      if (!code) {
        res.end('No authorization code returned. You can close this tab.')
        server.close()
        reject(new Error('No authorization code in callback'))
        return
      }
      res.end('Authorized. You can close this tab and return to the terminal.')
      server.close()
      resolve(code)
    })
    // A port already in use must NOT kill the attempt — the paste path still works, and on a
    // headless box it is the path that was always going to be used.
    server.on('error', (e) => {
      console.log(`  (loopback listener unavailable: ${e.message} — use the paste option below)`)
    })
    server.listen(CALLBACK_PORT)
    cancel = () => server.close()
  })
  return { promise, cancel }
}

/**
 * The fallback for the normal case: script on a server, browser on a laptop. The redirect fails to
 * load (nothing listens on the laptop's port), but the address bar still holds ?code=...&state=...,
 * so the operator can paste the URL straight back. Requires nothing of the network.
 */
function awaitPastedCode(expectedState: string): { promise: Promise<string>; cancel: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const promise = new Promise<string>((resolve, reject) => {
    rl.on('line', (line) => {
      const input = line.trim()
      if (!input) return

      let code = input
      let state: string | null = null
      // Accept the whole redirect URL, or a bare code for the case where the browser ate it.
      if (input.includes('code=')) {
        try {
          const url = new URL(input.startsWith('http') ? input : `http://localhost/?${input.replace(/^\?/, '')}`)
          code = url.searchParams.get('code') ?? ''
          state = url.searchParams.get('state')
          const error = url.searchParams.get('error')
          if (error) {
            reject(new Error(`Xero authorization failed: ${error}`))
            return
          }
        } catch {
          console.log('  could not parse that as a URL — paste the whole address, or just the code value')
          return
        }
      }

      if (!code) {
        console.log('  no code found in that input, try again')
        return
      }
      // A mistyped line must not be spent as if it were the code: consuming it ends the run and
      // forces the whole consent round trip again. Authorization codes are long and unbroken, so
      // anything with whitespace or obviously too short gets a hint and another chance.
      if (/\s/.test(code) || code.length < 20) {
        console.log(`  "${code.slice(0, 40)}" does not look like an authorization code — paste the full`)
        console.log('  redirect URL from the browser address bar, or just the code= value from it')
        return
      }
      // Only enforceable when the full URL was pasted; a bare code carries no state to check.
      if (state && state !== expectedState) {
        reject(new Error('OAuth state mismatch — the pasted URL is not from this authorization attempt'))
        return
      }
      resolve(code)
    })
  })
  return { promise, cancel: () => rl.close() }
}

/**
 * Whichever arrives first wins: the loopback callback (browser on this box, or an SSH tunnel) or a
 * pasted redirect URL (browser anywhere else). The operator does not have to declare which setup
 * they are in.
 */
async function obtainAuthorizationCode(expectedState: string): Promise<string> {
  const listener = awaitAuthorizationCode(expectedState)
  const paste = awaitPastedCode(expectedState)
  try {
    return await Promise.race([listener.promise, paste.promise])
  } finally {
    listener.cancel()
    paste.cancel()
  }
}

async function exchange(
  clientId: string,
  clientSecret: string,
  body: Record<string, string>,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Token endpoint returned HTTP ${res.status}: ${text}`)
  return JSON.parse(text)
}

async function authorize(): Promise<StoredToken> {
  const { clientId, clientSecret } = await readCredentials()

  const cached = loadCachedToken()
  if (cached?.refreshToken) {
    try {
      const t = await exchange(clientId, clientSecret, { grant_type: 'refresh_token', refresh_token: cached.refreshToken })
      const token: StoredToken = { ...cached, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 }
      saveToken(token)
      console.log(`Reusing cached audit connection to "${token.tenantName}".`)
      return token
    } catch (e) {
      console.log(`Cached token could not be refreshed (${(e as Error).message}); re-authorizing.`)
    }
  }

  const state = randomBytes(16).toString('hex')
  const authUrl = `${XERO_AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: AUDIT_SCOPES,
    state,
  })}`

  console.log('\n--- AUTHORIZE (read-only) ---')
  console.log(`This asks Xero for READ-ONLY scopes:\n  ${AUDIT_SCOPES}`)
  console.log(`\nRegister this redirect URI on the Xero app first (developer.xero.com):\n  ${REDIRECT_URI}`)
  console.log('\nOpen this URL in a browser and pick the LIVE organisation:\n')
  console.log(authUrl)
  console.log(`\nThen EITHER:`)
  console.log(`  (a) if that browser runs on THIS machine, or you opened an SSH tunnel with`)
  console.log(`      ssh -L ${CALLBACK_PORT}:localhost:${CALLBACK_PORT} <this-host>`)
  console.log(`      — nothing more to do, the callback lands here automatically; or`)
  console.log(`  (b) if the browser is elsewhere, the redirect will fail to load ("can't reach this`)
  console.log(`      page") — that is expected. Copy the FULL address from the browser's address`)
  console.log(`      bar and paste it below. It contains the code; the failed page load does not`)
  console.log(`      matter.`)
  console.log('\nWaiting for the callback, or for a pasted URL...\n')

  const code = await obtainAuthorizationCode(state)
  const t = await exchange(clientId, clientSecret, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  })

  const connRes = await fetch(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
  })
  if (!connRes.ok) throw new Error(`GET /connections returned HTTP ${connRes.status}`)
  const connections = (await connRes.json()) as Array<{ tenantId: string; tenantName: string }>
  if (!connections.length) throw new Error('No Xero organisations authorised')

  const wanted = arg('tenant')
  let conn = connections[0]
  if (wanted) {
    const match = connections.find((c) => c.tenantName === wanted)
    if (!match) {
      throw new Error(`No authorised organisation named "${wanted}". Authorised: ${connections.map((c) => c.tenantName).join(', ')}`)
    }
    conn = match
  } else if (connections.length > 1) {
    throw new Error(
      `${connections.length} organisations are authorised — pass --tenant "<name>" to choose. ` +
        `Authorised: ${connections.map((c) => c.tenantName).join(', ')}`,
    )
  }

  const token: StoredToken = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    tenantId: conn.tenantId,
    tenantName: conn.tenantName,
    expiresAt: Date.now() + t.expires_in * 1000,
  }
  saveToken(token)
  return token
}

// ---------------------------------------------------------------------------
// GET-only Xero client
// ---------------------------------------------------------------------------
let callCount = 0
let lastCallAt = 0
/** 60 calls/minute is the binding limit; pace at ~1.1s so a burst can never trip it. */
const MIN_CALL_INTERVAL_MS = 1100

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The ONLY way this script talks to Xero. There is deliberately no post/put/delete counterpart:
 * the audit cannot mutate the live ledger even by mistake.
 */
async function xeroGet<T>(
  token: StoredToken,
  path: string,
  opts?: { ifModifiedSince?: string },
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  if (callCount >= MAX_CALLS) throw new Error(`API call ceiling (${MAX_CALLS}) reached — aborting rather than spending more budget`)

  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallAt)
  if (wait > 0) await sleep(wait)

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token.accessToken}`,
    'Xero-Tenant-Id': token.tenantId,
    'Accept': 'application/json',
  }
  if (opts?.ifModifiedSince) headers['If-Modified-Since'] = opts.ifModifiedSince

  callCount++
  lastCallAt = Date.now()
  const res = await fetch(`${XERO_API_BASE}/${path}`, { method: 'GET', headers })

  if (res.status === 429) {
    // Retry-After on the daily cap is measured in HOURS. Surface it rather than sleeping blind
    // (o3d-98q: an unbudgeted sleep here is indistinguishable from a hung script).
    const retryAfter = Number(res.headers.get('Retry-After') ?? '0')
    if (retryAfter > 120) {
      throw new Error(`Xero rate limit hit; Retry-After is ${retryAfter}s (${(retryAfter / 3600).toFixed(1)}h). Stopping after ${callCount} calls.`)
    }
    console.log(`  rate limited, sleeping ${retryAfter}s...`)
    await sleep((retryAfter + 1) * 1000)
    callCount--
    return xeroGet<T>(token, path, opts)
  }

  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) }
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) as T }
  } catch {
    return { ok: false, status: res.status, error: `Non-JSON response: ${text.slice(0, 200)}` }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------
type XeroInvoice = {
  InvoiceID: string
  Type: string
  InvoiceNumber?: string
  Status: string
  Date?: string
  Total?: number
  AmountPaid?: number
  AmountDue?: number
  CurrencyCode?: string
  Contact?: { Name?: string }
  Payments?: Array<{ PaymentID: string; Amount: number }>
  CreditNotes?: Array<{ CreditNoteID: string; AppliedAmount: number }>
}
type XeroCreditNote = {
  CreditNoteID: string
  Type: string
  CreditNoteNumber?: string
  Status: string
  Date?: string
  Total?: number
  RemainingCredit?: number
  CurrencyCode?: string
  Contact?: { Name?: string }
  Allocations?: Array<{ Amount: number; Invoice?: { InvoiceID: string } }>
  Payments?: Array<{ PaymentID: string; Amount: number }>
}
type XeroPayment = {
  PaymentID: string
  Status: string
  Date?: string
  Amount?: number
  CurrencyRate?: number
  PaymentType?: string
  Invoice?: { InvoiceID: string; InvoiceNumber?: string; Contact?: { Name?: string } }
}
type XeroManualJournal = {
  ManualJournalID: string
  Status: string
  Date?: string
  Narration?: string
  UpdatedDateUTC?: string
}
type XeroContact = { ContactID: string; Name: string; ContactStatus: string; UpdatedDateUTC?: string }
type XeroItem = { ItemID: string; Code: string; Name?: string; UpdatedDateUTC?: string }

type Finding = {
  uuid: string
  entity: Entity
  syncType: string
  postedAt: string
  actualStatus: string
  xeroType: string
  number: string
  date: string
  total: string
  currency: string
  contact: string
  blockers: string
  note: string
}

/** Xero renders dates as /Date(1234567890000+0000)/. */
function xeroDate(value?: string): string {
  if (!value) return ''
  const m = /\/Date\((-?\d+)/.exec(value)
  if (!m) return value
  return new Date(Number(m[1])).toISOString().slice(0, 10)
}

async function sweepInvoices(token: StoredToken, rows: ContaminationRow[]): Promise<Finding[]> {
  const findings: Finding[] = []
  const byId = new Map(rows.map((r) => [r.externalTransactionId, r]))
  const found = new Set<string>()

  for (const batch of chunk([...byId.keys()], 40)) {
    const res = await xeroGet<{ Invoices?: XeroInvoice[] }>(token, `Invoices?IDs=${batch.join(',')}`)
    if (!res.ok) {
      console.log(`  ! invoice batch failed (HTTP ${res.status}): ${res.error}`)
      continue
    }
    for (const inv of res.data?.Invoices ?? []) {
      found.add(inv.InvoiceID)
      const row = byId.get(inv.InvoiceID)!
      // What must be undone BEFORE this invoice can be voided, in Xero's own terms.
      const blockers: string[] = []
      for (const p of inv.Payments ?? []) blockers.push(`payment:${p.PaymentID}`)
      for (const c of inv.CreditNotes ?? []) blockers.push(`creditnote:${c.CreditNoteID}`)
      findings.push({
        uuid: inv.InvoiceID,
        entity: 'invoice',
        syncType: row.type,
        postedAt: row.createdAt,
        actualStatus: inv.Status,
        xeroType: inv.Type,
        number: inv.InvoiceNumber ?? '',
        date: xeroDate(inv.Date),
        total: String(inv.Total ?? ''),
        currency: inv.CurrencyCode ?? '',
        contact: inv.Contact?.Name ?? '',
        blockers: blockers.join(' '),
        note: '',
      })
    }
  }

  for (const [id, row] of byId) {
    if (found.has(id)) continue
    findings.push({
      uuid: id, entity: 'invoice', syncType: row.type, postedAt: row.createdAt,
      actualStatus: 'NOT_FOUND', xeroType: '', number: '', date: '', total: '', currency: '',
      contact: '', blockers: '', note: 'not returned by Xero (never landed, or hard-deleted)',
    })
  }
  return findings
}

async function sweepCreditNotes(token: StoredToken, rows: ContaminationRow[]): Promise<Finding[]> {
  const findings: Finding[] = []
  const byId = new Map(rows.map((r) => [r.externalTransactionId, r]))
  const found = new Set<string>()

  // Try the batched IDs filter first; fall back to per-id GETs if this Xero endpoint rejects it.
  let batchWorks = true
  for (const batch of chunk([...byId.keys()], 40)) {
    const res = await xeroGet<{ CreditNotes?: XeroCreditNote[] }>(token, `CreditNotes?IDs=${batch.join(',')}`)
    if (!res.ok) {
      console.log(`  ! credit-note batch failed (HTTP ${res.status}) — falling back to per-id reads`)
      batchWorks = false
      break
    }
    for (const cn of res.data?.CreditNotes ?? []) {
      found.add(cn.CreditNoteID)
      findings.push(creditNoteFinding(cn, byId.get(cn.CreditNoteID)!))
    }
  }

  if (!batchWorks) {
    found.clear()
    findings.length = 0
    for (const [id, row] of byId) {
      const res = await xeroGet<{ CreditNotes?: XeroCreditNote[] }>(token, `CreditNotes/${id}`)
      const cn = res.data?.CreditNotes?.[0]
      if (res.ok && cn) {
        found.add(id)
        findings.push(creditNoteFinding(cn, row))
      }
    }
  }

  for (const [id, row] of byId) {
    if (found.has(id)) continue
    findings.push({
      uuid: id, entity: 'creditnote', syncType: row.type, postedAt: row.createdAt,
      actualStatus: 'NOT_FOUND', xeroType: '', number: '', date: '', total: '', currency: '',
      contact: '', blockers: '', note: 'not returned by Xero (never landed, or hard-deleted)',
    })
  }
  return findings
}

function creditNoteFinding(cn: XeroCreditNote, row: ContaminationRow): Finding {
  const blockers: string[] = []
  for (const a of cn.Allocations ?? []) {
    if (a.Invoice?.InvoiceID) blockers.push(`allocated-to:${a.Invoice.InvoiceID}`)
  }
  for (const p of cn.Payments ?? []) blockers.push(`refund:${p.PaymentID}`)
  return {
    uuid: cn.CreditNoteID,
    entity: 'creditnote',
    syncType: row.type,
    postedAt: row.createdAt,
    actualStatus: cn.Status,
    xeroType: cn.Type,
    number: cn.CreditNoteNumber ?? '',
    date: xeroDate(cn.Date),
    total: String(cn.Total ?? ''),
    currency: cn.CurrencyCode ?? '',
    contact: cn.Contact?.Name ?? '',
    blockers: blockers.join(' '),
    note: '',
  }
}

async function sweepPayments(token: StoredToken, rows: ContaminationRow[]): Promise<Finding[]> {
  const findings: Finding[] = []
  for (const row of rows) {
    const res = await xeroGet<{ Payments?: XeroPayment[] }>(token, `Payments/${row.externalTransactionId}`)
    const p = res.data?.Payments?.[0]
    if (!res.ok || !p) {
      findings.push({
        uuid: row.externalTransactionId, entity: 'payment', syncType: row.type, postedAt: row.createdAt,
        actualStatus: 'NOT_FOUND', xeroType: '', number: '', date: '', total: '', currency: '',
        contact: '', blockers: '', note: res.ok ? 'no payment in response' : `HTTP ${res.status}`,
      })
      continue
    }
    findings.push({
      uuid: p.PaymentID, entity: 'payment', syncType: row.type, postedAt: row.createdAt,
      actualStatus: p.Status, xeroType: p.PaymentType ?? '', number: p.Invoice?.InvoiceNumber ?? '',
      date: xeroDate(p.Date), total: String(p.Amount ?? ''), currency: '',
      contact: p.Invoice?.Contact?.Name ?? '',
      blockers: p.Invoice?.InvoiceID ? `settles:${p.Invoice.InvoiceID}` : '',
      note: 'DELETE THIS FIRST — a payment blocks its invoice from being voided',
    })
  }
  return findings
}

/**
 * Journals are paged rather than fetched per id: 251 individual GETs would be most of a day's
 * budget, and paging also surfaces journals in the window that we have no local record of.
 */
async function sweepJournals(
  token: StoredToken,
  rows: ContaminationRow[],
): Promise<{ findings: Finding[]; unknownInWindow: XeroManualJournal[] }> {
  const byId = new Map(rows.map((r) => [r.externalTransactionId, r]))
  const seen = new Map<string, XeroManualJournal>()
  const unknownInWindow: XeroManualJournal[] = []
  const ifModifiedSince = new Date(CONTAMINATION_START).toUTCString()

  for (let page = 1; ; page++) {
    const res = await xeroGet<{ ManualJournals?: XeroManualJournal[] }>(
      token,
      `ManualJournals?page=${page}`,
      { ifModifiedSince },
    )
    if (!res.ok) {
      console.log(`  ! manual journal page ${page} failed (HTTP ${res.status}): ${res.error}`)
      break
    }
    const batch = res.data?.ManualJournals ?? []
    if (!batch.length) break
    for (const mj of batch) {
      if (byId.has(mj.ManualJournalID)) seen.set(mj.ManualJournalID, mj)
      else unknownInWindow.push(mj)
    }
    if (batch.length < 100) break
  }

  const findings: Finding[] = []
  for (const [id, row] of byId) {
    const mj = seen.get(id)
    findings.push({
      uuid: id, entity: 'journal', syncType: row.type, postedAt: row.createdAt,
      actualStatus: mj?.Status ?? 'NOT_FOUND',
      xeroType: 'MANUAL_JOURNAL', number: '',
      date: xeroDate(mj?.Date), total: '', currency: '',
      contact: '', blockers: '',
      note: mj ? (mj.Narration ?? '').slice(0, 80) : 'not seen in any page modified since 2026-07-15',
    })
  }
  return { findings, unknownInWindow }
}

async function sweepContacts(token: StoredToken): Promise<XeroContact[]> {
  const out: XeroContact[] = []
  const where = encodeURIComponent(`Name.StartsWith("${E2E_PREFIX}")`)
  for (let page = 1; ; page++) {
    const res = await xeroGet<{ Contacts?: XeroContact[] }>(token, `Contacts?where=${where}&page=${page}`)
    if (!res.ok) {
      console.log(`  ! contact page ${page} failed (HTTP ${res.status}): ${res.error}`)
      break
    }
    const batch = res.data?.Contacts ?? []
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

async function sweepItems(token: StoredToken): Promise<XeroItem[]> {
  const res = await xeroGet<{ Items?: XeroItem[] }>(token, 'Items')
  if (!res.ok) {
    console.log(`  ! items read failed (HTTP ${res.status}): ${res.error}`)
    return []
  }
  return (res.data?.Items ?? []).filter((i) => (i.Code ?? '').startsWith(`${E2E_PREFIX}-`))
}

// ---------------------------------------------------------------------------
function toCsv(findings: Finding[]): string {
  const cols: Array<keyof Finding> = [
    'uuid', 'entity', 'syncType', 'postedAt', 'actualStatus', 'xeroType',
    'number', 'date', 'total', 'currency', 'contact', 'blockers', 'note',
  ]
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [cols.join(','), ...findings.map((f) => cols.map((c) => esc(String(f[c] ?? ''))).join(','))].join('\n')
}

function tally(findings: Finding[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const f of findings) {
    const key = `${f.entity}/${f.actualStatus}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * What the sweep will do, costed, with no network access and no consent. Worth having on its own:
 * the operator can see the whole shape of the audit before authorising anything against the live
 * organisation.
 */
function reportPlan(grouped: Map<Entity, ContaminationRow[]>): void {
  const n = (e: Entity) => grouped.get(e)?.length ?? 0
  const invoiceCalls = Math.ceil(n('invoice') / 40)
  const creditNoteCalls = Math.ceil(n('creditnote') / 40)
  const paymentCalls = n('payment')
  const journalCalls = Math.max(1, Math.ceil(n('journal') / 100))

  console.log('\n=== PLAN (no network, nothing authorised) ===')
  console.log(`  GET Organisation                             1 call`)
  console.log(`  GET Payments/{id}       x ${String(n('payment')).padStart(4)}        ${String(paymentCalls).padStart(3)} calls`)
  console.log(`  GET Invoices?IDs=       x ${String(n('invoice')).padStart(4)} @40/batch ${String(invoiceCalls).padStart(3)} calls`)
  console.log(`  GET CreditNotes?IDs=    x ${String(n('creditnote')).padStart(4)} @40/batch ${String(creditNoteCalls).padStart(3)} calls`)
  console.log(`  GET ManualJournals?page x ${String(n('journal')).padStart(4)} @100/page ${String(journalCalls).padStart(3)} calls (min; more if the org has others in the window)`)
  console.log(`  GET Contacts (E2E*)                        ~2 calls`)
  console.log(`  GET Items                                   1 call`)
  const total = 1 + paymentCalls + invoiceCalls + creditNoteCalls + journalCalls + 3
  console.log(`  ------------------------------------------------`)
  console.log(`  approx total                              ~${total} calls, against a 5,000/day and 60/min limit`)
  console.log(`  paced at ${MIN_CALL_INTERVAL_MS}ms between calls => ~${Math.ceil((total * MIN_CALL_INTERVAL_MS) / 1000)}s wall clock`)
  console.log(`\n  Every call is a GET. This script has no post/put/delete helper, and asks Xero`)
  console.log(`  for read-only scopes:\n    ${AUDIT_SCOPES}`)
}

async function main() {
  const rows = parseCsv(CSV_PATH)
  console.log(`Loaded ${rows.length} contaminated ids from ${CSV_PATH}`)

  const grouped = new Map<Entity, ContaminationRow[]>()
  for (const r of rows) {
    const e = entityFor(r.type)
    if (!grouped.has(e)) grouped.set(e, [])
    grouped.get(e)!.push(r)
  }

  const byType = new Map<string, number>()
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + 1)
  console.log('\nBy sync type -> Xero entity:')
  for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${type.padEnd(36)} -> ${entityFor(type)}`)
  }

  if (PLAN_ONLY) {
    reportPlan(grouped)
    return
  }

  const token = await authorize()

  // Confirm the organisation from Xero itself before reading anything else. A stale token row is
  // not evidence of which org we are on — the same reasoning as provision-xero-demo's guard.
  const org = await xeroGet<{ Organisations?: Array<{ Name: string; PeriodLockDate?: string; EndOfYearLockDate?: string; BaseCurrency?: string }> }>(token, 'Organisation')
  if (!org.ok || !org.data?.Organisations?.length) {
    throw new Error(`Could not read the organisation: HTTP ${org.status} ${org.error ?? ''}`)
  }
  const o = org.data.Organisations[0]
  console.log(`\n=== ORGANISATION: ${o.Name} (${token.tenantId}) ===`)
  console.log(`Base currency:        ${o.BaseCurrency ?? '?'}`)
  console.log(`Period lock date:     ${xeroDate(o.PeriodLockDate) || '(none)'}`)
  console.log(`End-of-year lock:     ${xeroDate(o.EndOfYearLockDate) || '(none)'}`)
  if (!xeroDate(o.PeriodLockDate) && !xeroDate(o.EndOfYearLockDate)) {
    console.log('=> No lock date: voiding is available, no reversing journals needed.')
  } else {
    console.log('=> A lock date is set. If it covers 2026-07-15..26, void will be refused and these must be REVERSED in an open period instead.')
  }

  if (o.Name === DEMO_TENANT_NAME && !FLAG_ALLOW_DEMO) {
    throw new Error(`Connected to "${DEMO_TENANT_NAME}", not the live organisation. This audit is meaningless against Demo. Re-authorize and pick the live org (or pass --allow-demo).`)
  }

  console.log('\n--- payments (read first: they gate everything else) ---')
  const paymentFindings = await sweepPayments(token, grouped.get('payment') ?? [])
  console.log('--- invoices and bills ---')
  const invoiceFindings = await sweepInvoices(token, grouped.get('invoice') ?? [])
  console.log('--- credit notes ---')
  const creditNoteFindings = await sweepCreditNotes(token, grouped.get('creditnote') ?? [])
  console.log('--- manual journals ---')
  const { findings: journalFindings, unknownInWindow } = await sweepJournals(token, grouped.get('journal') ?? [])
  console.log('--- E2E contacts ---')
  const contacts = await sweepContacts(token)
  console.log('--- E2E items ---')
  const items = await sweepItems(token)

  const findings = [...paymentFindings, ...invoiceFindings, ...creditNoteFindings, ...journalFindings]
  writeFileSync(OUT_PATH, toCsv(findings))

  console.log(`\n=== RECONCILIATION (${findings.length} of ${rows.length} ids) ===`)
  for (const [key, count] of [...tally(findings)].sort()) console.log(`  ${String(count).padStart(4)}  ${key}`)

  const live = findings.filter((f) => !['NOT_FOUND', 'VOIDED', 'DELETED'].includes(f.actualStatus))
  console.log(`\nStill present and not voided: ${live.length}`)
  console.log(`Already gone or voided:       ${findings.length - live.length}`)

  console.log(`\n=== NOT IN THE CSV ===`)
  console.log(`  E2E-named contacts:                 ${contacts.length} (${contacts.filter((c) => c.ContactStatus === 'ACTIVE').length} active)`)
  console.log(`  E2E-coded items:                    ${items.length}`)
  console.log(`  Manual journals in window, unknown: ${unknownInWindow.length}`)
  if (unknownInWindow.length) {
    console.log('    (these are journals the live org has that we have no local record of — check before assuming they are ours)')
    for (const mj of unknownInWindow.slice(0, 10)) {
      console.log(`      ${mj.ManualJournalID} ${xeroDate(mj.Date)} ${mj.Status} ${(mj.Narration ?? '').slice(0, 60)}`)
    }
    if (unknownInWindow.length > 10) console.log(`      ... and ${unknownInWindow.length - 10} more`)
  }

  console.log(`\nWrote ${OUT_PATH}`)
  console.log(`API calls used: ${callCount} (ceiling ${MAX_CALLS})`)
  console.log(`\nThe audit token is cached at ${TOKEN_FILE}. Delete it when the cleanup is done.`)
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`)
  process.exit(1)
})
