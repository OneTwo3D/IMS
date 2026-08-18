/**
 * o3d-t74p — READ-ONLY audit of the e2e contamination sitting in the LIVE Xero organisation.
 *
 * Between 2026-07-15 20:49 and 2026-07-26 07:55 the e2e instance was connected to the LIVE Xero
 * org and posted 553 objects into it. This script reads that org and reports, per object, what is
 * actually there now — so the cleanup worklist is built from Xero's answer rather than from a name
 * search in the UI. It writes NOTHING, anywhere.
 *
 * ABSENCE IS A CLAIM, AND IT HAS TO BE EARNED
 * -------------------------------------------
 * Every id ends in one of four states, and they are not interchangeable:
 *
 *   PRESENT     Xero returned the object.
 *   NOT_FOUND   a GET on the id ITSELF answered HTTP 404. The only proof of absence there is.
 *   UNKNOWN     no read conclusively resolved it — a collection read did not mention it and no
 *               per-id read confirmed that, or a 200 came back with no object in it.
 *   ERROR       a read failed. Says nothing whatsoever about whether the object exists.
 *
 * The `evidence` column records which read produced the verdict. This matters because the first
 * version of this script did not make the distinction, and the conclusion drawn from its output —
 * "all 553 ids return 404 against the live org, so they are Demo ids" — was true of 14 of them.
 * The other 539 were absent from a COLLECTION read, and 251 of those (the manual journals) were
 * never fetched by id at all: they were labelled NOT_FOUND for not appearing in the pages the
 * script happened to read before it stopped at the first page shorter than 100. A failed batch
 * produced exactly the same NOT_FOUND as a successful one, so up to 40 false absences could be
 * manufactured per failed request.
 *
 * Both are fixed here: collection reads are only used to find what IS present, everything else is
 * settled by a per-id GET (bounded retry, --no-confirm-absence to skip at the cost of UNKNOWN
 * verdicts), paging runs to an EMPTY page, and a run with ANY unresolved id prints INCONCLUSIVE
 * and exits non-zero rather than publishing a reconciliation.
 *
 * WHY IT DOES NOT IMPORT lib/connectors/xero/*
 * -------------------------------------------
 * Every helper there resolves auth through getAccessToken() -> db.accountingToken
 * (lib/connectors/xero/auth.ts:76). Using them would mean writing a LIVE-tenant token into an IMS
 * database, which is precisely the act that caused this incident. This script therefore carries its
 * own OAuth, and reads through the shared transport in scripts/lib/xero-live-safety.ts built with
 * `apply: false` — which THROWS on any verb but GET. There is no code path here that can mutate the
 * live ledger, whatever it is pointed at.
 *
 * It does NOT carry its own HTTP client any more. It used to, and so did the footprint audit, and
 * all three copies had the same 429 handling; when that was fixed in the writer the two audits kept
 * the broken version, where the retry refunded the call budget and recursed without a counter, so a
 * permanently rate-limited endpoint retried for ever with nothing able to stop it. One client.
 *
 * It also asks Xero for READ-ONLY scopes. A token minted by this script is incapable of writing even
 * if some later edit tried to.
 *
 * CALL BUDGET (Xero: 60/min, 5,000/day, per tenant per app)
 * --------------------------------------------------------
 * Collection reads are cheap — invoices and credit notes in batched IDs= filters, manual journals
 * paged with If-Modified-Since — but confirming an absence costs one GET per unresolved id, so a
 * sweep where most ids are gone costs roughly one call per id. Budget for that: run --plan-only
 * first, and note that Xero's daily cap is as low as 1,000/org/24h on some plans. Calls are paced
 * and 429 Retry-After is honoured.
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
 *   --max-calls <n>    hard ceiling on API calls (default 2000)
 *   --no-confirm-absence   skip the per-id confirmation GETs. Cheaper, but then nothing can be
 *                          reported as NOT_FOUND — those ids come back UNKNOWN and the run is
 *                          INCONCLUSIVE by construction.
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

import {
  createXeroTransport,
  isConclusive,
  pageAllComplete,
  parseCollectionPage,
  resolveById,
  type Resolution,
} from './lib/xero-live-safety'


const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'

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
const MAX_CALLS = Number(arg('max-calls', '2000'))
/**
 * Confirm every id a collection read did not return with a GET on the id itself. ON by default:
 * without it the audit cannot say NOT_FOUND about anything, only UNKNOWN. Turning it off is a
 * budget decision, and it degrades the verdicts rather than changing them.
 */
const CONFIRM_ABSENCE = !process.argv.includes('--no-confirm-absence')
/** Manual journals page until EMPTY; this is only the runaway stop, and hitting it is an error. */
const JOURNAL_PAGE_CEILING = Number(arg('journal-page-ceiling', '50'))
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`

// ---------------------------------------------------------------------------
// Secrets: a local copy of lib/secrets' decrypt, so this file imports nothing
// from the app (see header).
// ---------------------------------------------------------------------------
/**
 * Settings-table ciphertext, per lib/security/encrypted-settings.ts. Two things here are easy to
 * get wrong and both fail SILENTLY into a wrong secret rather than an error:
 *
 *  1. The current prefix is `enc:setting:v1:`, not the legacy `enc:v1:` from lib/secrets.ts. A
 *     decrypt keyed on the legacy prefix does not throw on a settings value — it falls through and
 *     returns the CIPHERTEXT as if it were plaintext, which then goes out as the client secret and
 *     comes back from Xero as an opaque invalid_request.
 *  2. The settings format binds AAD = `setting:<key>`. Decrypting without it fails the auth tag.
 */
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
  const prefix = value.startsWith(ENCRYPTED_SETTING_PREFIX)
    ? ENCRYPTED_SETTING_PREFIX
    : value.startsWith(DRAFT_ENCRYPTED_SETTING_PREFIX)
      ? DRAFT_ENCRYPTED_SETTING_PREFIX
      : value.startsWith(LEGACY_ENCRYPTED_PREFIX)
        ? LEGACY_ENCRYPTED_PREFIX
        : null

  // Plaintext — xero_client_id is stored unencrypted, so this is a normal path, not a fallback.
  if (!prefix) return value

  const key = resolveEncryptionKey()
  if (!key) throw new Error(`SETTINGS_ENCRYPTION_KEY is required to read ${settingKey}`)

  const payload = Buffer.from(value.slice(prefix.length), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
  // The legacy lib/secrets format binds no AAD; both settings formats bind the key name.
  if (prefix !== LEGACY_ENCRYPTED_PREFIX) {
    decipher.setAAD(Buffer.from(`setting:${settingKey}`, 'utf8'))
  }
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
    return {
      clientId: decryptSettingValue('xero_client_id', clientId),
      clientSecret: decryptSettingValue('xero_client_secret', clientSecret),
    }
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
 * ONE readline over stdin for the whole run. Two separate prompts read from it — the pasted
 * redirect URL, then the choice of organisation — and closing it after the first would make the
 * second unreadable, so it is created once and closed only when authorization is finished.
 */
let sharedRl: ReturnType<typeof createInterface> | null = null
function sharedStdin() {
  if (!sharedRl) sharedRl = createInterface({ input: process.stdin, output: process.stdout })
  return sharedRl
}
function closeSharedStdin() {
  sharedRl?.close()
  sharedRl = null
}

/** Read a single line, for prompts that come after the authorization code. */
function askLine(): Promise<string> {
  const rl = sharedStdin()
  return new Promise((resolve) => {
    const onLine = (line: string) => {
      const value = line.trim()
      if (!value) return
      rl.off('line', onLine)
      resolve(value)
    }
    rl.on('line', onLine)
  })
}

/**
 * The fallback for the normal case: script on a server, browser on a laptop. The redirect fails to
 * load (nothing listens on the laptop's port), but the address bar still holds ?code=...&state=...,
 * so the operator can paste the URL straight back. Requires nothing of the network.
 */
function awaitPastedCode(expectedState: string): { promise: Promise<string>; cancel: () => void } {
  const rl = sharedStdin()
  let cancelPaste = () => {}
  const promise = new Promise<string>((resolve, reject) => {
    const onLine = (line: string) => {
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
    }
    rl.on('line', onLine)
    // Detach the listener rather than closing stdin: the same channel is used again straight
    // after, to choose which connected organisation to audit.
    cancelPaste = () => rl.off('line', onLine)
  })
  return { promise, cancel: () => cancelPaste() }
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
    // ASK rather than abort. Consent is expensive here — every authorization re-establishes a
    // connection to the live organisation — so throwing at this point would waste the whole round
    // trip over a name we can simply read out and let the operator pick from.
    console.log(`\n${connections.length} organisations are authorised for this app:\n`)
    connections.forEach((c, i) => console.log(`  ${i + 1}) ${c.tenantName}   [${c.tenantId}]`))
    console.log('\nEnter the NUMBER of the organisation to audit (the LIVE one, not Demo):')
    for (;;) {
      const answer = await askLine()
      const pick = Number(answer)
      if (Number.isInteger(pick) && pick >= 1 && pick <= connections.length) {
        conn = connections[pick - 1]
        break
      }
      const byName = connections.find((c) => c.tenantName === answer)
      if (byName) {
        conn = byName
        break
      }
      console.log(`  "${answer}" is not one of 1..${connections.length} or an exact name — try again`)
    }
    console.log(`\nSelected: ${conn.tenantName}`)
  }

  const token: StoredToken = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    tenantId: conn.tenantId,
    tenantName: conn.tenantName,
    expiresAt: Date.now() + t.expires_in * 1000,
  }
  saveToken(token)
  // Nothing else reads stdin; leaving it open would hold the process alive after the sweep.
  closeSharedStdin()
  return token
}

// ---------------------------------------------------------------------------
// GET-only Xero client
// ---------------------------------------------------------------------------
/**
 * The If-Modified-Since header, for the one sweep that uses it. It is set immediately before that
 * sweep and cleared after, so it cannot leak onto an unrelated read.
 */
let ifModifiedSinceHeader: string | null = null

/**
 * The ONLY way this script talks to Xero, and it is the SHARED transport built read-only
 * (`apply: false`) — it throws on any verb other than GET without --apply, and this script never
 * passes one. The audit cannot mutate the live ledger even by mistake.
 *
 * This replaces a hand-rolled client that was a copy of the writer's, carrying the writer's
 * since-fixed 429 defect: the retry refunded the call budget (`callCount--`) and recursed with no
 * retry counter, so an endpoint answering 429 indefinitely retried for ever and the call ceiling —
 * the only thing that could have stopped it — could never be reached. Three copies of one client
 * meant fixing it in one of them left the other two broken, which is exactly what happened.
 */
/** 60 calls/minute is the binding limit; pace at ~1.1s so a burst can never trip it. */
const MIN_CALL_INTERVAL_MS = 1100

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const transport = createXeroTransport({
  apply: false,
  maxCalls: MAX_CALLS,
  minIntervalMs: MIN_CALL_INTERVAL_MS,
  log: (m) => console.log(m),
  headersFor: (): Record<string, string> =>
    ifModifiedSinceHeader ? { 'If-Modified-Since': ifModifiedSinceHeader } : {},
})

const xeroGet = <T,>(token: StoredToken, path: string) => transport.request<T>(token, 'GET', path)

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
  /** PRESENT: the Xero status. Otherwise the Resolution — NOT_FOUND / UNKNOWN / ERROR. */
  actualStatus: string
  /**
   * How that verdict was reached, in its own column so a reader never has to infer it from prose.
   *   per-id-404          a GET by id answered HTTP 404. The only proof of absence.
   *   per-id-200          a GET by id returned the object.
   *   collection-hit      the object came back in a batched/paged collection read.
   *   collection-miss     a SUCCESSFUL collection read did not contain it, and no per-id read was
   *                       done. Suggestive, not conclusive.
   *   read-failed         a read errored. Says nothing at all about whether the object exists.
   */
  evidence: string
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

function unresolvedFinding(id: string, row: ContaminationRow, entity: Entity, resolution: Resolution, evidence: string, note: string): Finding {
  return {
    uuid: id, entity, syncType: row.type, postedAt: row.createdAt,
    actualStatus: resolution, evidence, xeroType: '', number: '', date: '', total: '', currency: '',
    contact: '', blockers: '', note,
  }
}

/**
 * Confirm, by a GET on the id itself, whether an object that a collection read did not return
 * actually exists.
 *
 * This is the whole of findings 5 and 6. A collection read that does not mention an id is not
 * evidence that the id is gone: the batch may have failed, the filter may have been ignored, the
 * paging may have stopped early. Only `GET <Endpoint>/{id}` -> 404 says the object is absent, and
 * only that is allowed to print NOT_FOUND. Everything else is UNKNOWN, and an UNKNOWN anywhere
 * makes the whole reconciliation inconclusive and the exit code non-zero.
 */
async function confirmAbsence<T>(
  token: StoredToken,
  endpoint: string,
  key: string,
  id: string,
): Promise<{ resolution: Resolution; evidence: string; note: string; object?: T }> {
  if (!CONFIRM_ABSENCE) {
    return {
      resolution: 'UNKNOWN',
      evidence: 'collection-miss',
      note: 'not returned by a collection read; per-id confirmation skipped (--no-confirm-absence)',
    }
  }
  // A bounded retry, because a single transient 5xx must not decide the verdict either way.
  let last: { ok: boolean; status: number; error?: string; data?: Record<string, T[]> } | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await xeroGet<Record<string, T[]>>(token, `${endpoint}/${id}`)
    last = res
    if (res.ok || res.status === 404) break
    if (attempt < 3) await sleep(1500 * attempt)
  }
  const object = last?.data?.[key]?.[0]
  const resolution = resolveById(last!, !!object)
  if (resolution === 'PRESENT') return { resolution, evidence: 'per-id-200', note: '', object }
  if (resolution === 'NOT_FOUND') {
    return { resolution, evidence: 'per-id-404', note: 'GET by id returned HTTP 404 — confirmed absent' }
  }
  if (last!.ok) {
    return { resolution: 'UNKNOWN', evidence: 'per-id-200', note: 'HTTP 200 but no object in the response' }
  }
  return { resolution: 'ERROR', evidence: 'read-failed', note: `per-id read failed: HTTP ${last!.status}` }
}

async function sweepInvoices(token: StoredToken, rows: ContaminationRow[]): Promise<Finding[]> {
  const findings: Finding[] = []
  const byId = new Map(rows.map((r) => [r.externalTransactionId, r]))
  const found = new Set<string>()

  for (const batch of chunk([...byId.keys()], 40)) {
    const res = await xeroGet<{ Invoices?: XeroInvoice[] }>(token, `Invoices?IDs=${batch.join(',')}`)
    if (!res.ok) {
      // The batch is simply not evidence. Every id in it falls through to per-id confirmation
      // below rather than being emitted as an absence — a transient 5xx used to manufacture up to
      // 40 false "already gone" verdicts per request.
      console.log(`  ! invoice batch failed (HTTP ${res.status}): ${res.error} — ${batch.length} id(s) fall back to per-id reads`)
      continue
    }
    for (const inv of res.data?.Invoices ?? []) {
      // Never index blind on a server-supplied id. If Xero ignores an unsupported filter it
      // answers with the WHOLE collection, and a non-null assertion here turns that into a crash
      // mid-sweep (which is exactly what CreditNotes did).
      const row = byId.get(inv.InvoiceID)
      if (!row) continue
      found.add(inv.InvoiceID)
      findings.push(invoiceFinding(inv, row, 'collection-hit'))
    }
  }

  for (const [id, row] of byId) {
    if (found.has(id)) continue
    const c = await confirmAbsence<XeroInvoice>(token, 'Invoices', 'Invoices', id)
    if (c.object) findings.push(invoiceFinding(c.object, row, c.evidence))
    else findings.push(unresolvedFinding(id, row, 'invoice', c.resolution, c.evidence, c.note))
  }
  return findings
}

function invoiceFinding(inv: XeroInvoice, row: ContaminationRow, evidence: string): Finding {
  // What must be undone BEFORE this invoice can be voided, in Xero's own terms.
  const blockers: string[] = []
  for (const p of inv.Payments ?? []) blockers.push(`payment:${p.PaymentID}`)
  for (const c of inv.CreditNotes ?? []) blockers.push(`creditnote:${c.CreditNoteID}`)
  return {
    uuid: inv.InvoiceID,
    entity: 'invoice',
    syncType: row.type,
    postedAt: row.createdAt,
    actualStatus: inv.Status,
    evidence,
    xeroType: inv.Type,
    number: inv.InvoiceNumber ?? '',
    date: xeroDate(inv.Date),
    total: String(inv.Total ?? ''),
    currency: inv.CurrencyCode ?? '',
    contact: inv.Contact?.Name ?? '',
    blockers: blockers.join(' '),
    note: '',
  }
}

async function sweepCreditNotes(token: StoredToken, rows: ContaminationRow[]): Promise<Finding[]> {
  const findings: Finding[] = []
  const byId = new Map(rows.map((r) => [r.externalTransactionId, r]))
  const found = new Set<string>()

  // Try the batched IDs filter first, then verify it was actually HONOURED.
  //
  // CreditNotes does not support IDs=. Xero does not reject the unknown parameter — it returns 200
  // with the org's ENTIRE credit-note collection, which silently looks like success. Detect it by
  // the only reliable signal available: a returned id that we never asked for.
  let batchWorks = true
  for (const batch of chunk([...byId.keys()], 40)) {
    const res = await xeroGet<{ CreditNotes?: XeroCreditNote[] }>(token, `CreditNotes?IDs=${batch.join(',')}`)
    if (!res.ok) {
      console.log(`  ! credit-note batch failed (HTTP ${res.status}) — falling back to per-id reads`)
      batchWorks = false
      break
    }
    const returned = res.data?.CreditNotes ?? []
    if (returned.some((cn) => !byId.has(cn.CreditNoteID))) {
      console.log('  ! CreditNotes ignored the IDs filter (returned unrequested ids) — falling back to per-id reads')
      batchWorks = false
      break
    }
    for (const cn of returned) {
      const row = byId.get(cn.CreditNoteID)
      if (!row) continue
      found.add(cn.CreditNoteID)
      findings.push(creditNoteFinding(cn, row, 'collection-hit'))
    }
  }

  if (!batchWorks) {
    found.clear()
    findings.length = 0
  }

  for (const [id, row] of byId) {
    if (found.has(id)) continue
    const c = await confirmAbsence<XeroCreditNote>(token, 'CreditNotes', 'CreditNotes', id)
    if (c.object) findings.push(creditNoteFinding(c.object, row, c.evidence))
    else findings.push(unresolvedFinding(id, row, 'creditnote', c.resolution, c.evidence, c.note))
  }
  return findings
}

function creditNoteFinding(cn: XeroCreditNote, row: ContaminationRow, evidence: string): Finding {
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
    evidence,
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
    const id = row.externalTransactionId
    const c = await confirmAbsence<XeroPayment>(token, 'Payments', 'Payments', id)
    const p = c.object
    if (!p) {
      // A payment that errored is ERROR, not NOT_FOUND. The previous code collapsed every non-200
      // into "gone" and stamped `HTTP ${status}` into a free-text note nobody aggregates.
      findings.push(unresolvedFinding(id, row, 'payment', c.resolution, c.evidence, c.note))
      continue
    }
    findings.push({
      uuid: p.PaymentID, entity: 'payment', syncType: row.type, postedAt: row.createdAt,
      actualStatus: p.Status, evidence: c.evidence, xeroType: p.PaymentType ?? '',
      number: p.Invoice?.InvoiceNumber ?? '',
      date: xeroDate(p.Date), total: String(p.Amount ?? ''), currency: '',
      contact: p.Invoice?.Contact?.Name ?? '',
      blockers: p.Invoice?.InvoiceID ? `settles:${p.Invoice.InvoiceID}` : '',
      note: 'DELETE THIS FIRST — a payment blocks its invoice from being voided',
    })
  }
  return findings
}

/**
 * Manual journals: paged for discovery, then CONFIRMED PER ID.
 *
 * The previous implementation paged `ManualJournals` with If-Modified-Since, stopped at the first
 * page shorter than 100, and labelled every id it had not seen `NOT_FOUND`. Three things were
 * wrong with that at once: a short non-empty page is not a terminal guarantee, a failed page ended
 * the walk without a trace in the result, and "not seen in the pages I read" was published as
 * absence. 251 of the 553 ids — 45% of the set — reached their verdict that way, and the claim
 * that all 553 returned 404 was never true of any of them.
 *
 * So the paging is now only a cheap way to find the ones that ARE present (and to surface journals
 * the org has that we have no record of). Anything the pages did not account for is settled by a
 * GET on its own id, which is the only read that can return a 404.
 */
async function sweepJournals(
  token: StoredToken,
  rows: ContaminationRow[],
): Promise<{ findings: Finding[]; unknownInWindow: XeroManualJournal[]; pagingComplete: boolean }> {
  const byId = new Map(rows.map((r) => [r.externalTransactionId, r]))
  const seen = new Map<string, XeroManualJournal>()
  const unknownInWindow: XeroManualJournal[] = []
  const seenPageIds = new Set<string>()
  let pagingComplete = false

  // Scoped to this sweep only, and cleared in the `finally` below, so no other read can pick it up.
  ifModifiedSinceHeader = new Date(CONTAMINATION_START).toUTCString()
  try {
  for (let page = 1; page <= JOURNAL_PAGE_CEILING; page++) {
    const res = await xeroGet<{ ManualJournals?: XeroManualJournal[] }>(
      token,
      `ManualJournals?page=${page}`,
    )
    if (!res.ok) {
      console.log(`  ! manual journal page ${page} failed (HTTP ${res.status}): ${res.error} — enumeration is INCOMPLETE`)
      break
    }
    // A 2xx whose body we cannot read is NOT an empty page. `res.data?.ManualJournals ?? []`
    // could not tell `{"ManualJournals":[]}` — the enumeration genuinely finishing — from an
    // unparseable body, and the difference is published: the empty branch sets pagingComplete,
    // which is this script's claim to have seen the whole collection. That claim is the entire
    // reason the 251 journals were reported the way they were.
    const parsed = parseCollectionPage<XeroManualJournal>(res.data, 'ManualJournals')
    if (!parsed.ok) {
      console.log(`  ! manual journal page ${page} answered HTTP ${res.status} but ${parsed.reason} — enumeration is INCOMPLETE`)
      break
    }
    const batch = parsed.rows
    // Only an EMPTY page ends the walk. A short page does not: the page size is not a guarantee,
    // and treating "fewer than 100" as terminal is what dropped the older pages.
    if (!batch.length) { pagingComplete = true; break }
    let fresh = 0
    for (const mj of batch) {
      if (seenPageIds.has(mj.ManualJournalID)) continue
      seenPageIds.add(mj.ManualJournalID)
      fresh++
      if (byId.has(mj.ManualJournalID)) seen.set(mj.ManualJournalID, mj)
      else unknownInWindow.push(mj)
    }
    if (fresh === 0) {
      // Xero ignored `page` and re-served the same collection: page 1 already was the whole set.
      console.log(`  (ManualJournals: page ${page} repeated page ${page - 1} — \`page\` is being ignored; the first response was complete)`)
      pagingComplete = true
      break
    }
    if (page === JOURNAL_PAGE_CEILING) {
      console.log(`  ! manual journals hit the ${JOURNAL_PAGE_CEILING}-page ceiling — enumeration is INCOMPLETE`)
    }
  }
  } finally {
    // The per-id confirmations below must NOT carry If-Modified-Since: a 304 on a per-id GET is
    // not a 404, and this whole function exists because "not seen" was published as "absent".
    ifModifiedSinceHeader = null
  }

  const findings: Finding[] = []
  for (const [id, row] of byId) {
    const mj = seen.get(id)
    if (mj) {
      findings.push({
        uuid: id, entity: 'journal', syncType: row.type, postedAt: row.createdAt,
        actualStatus: mj.Status, evidence: 'collection-hit',
        xeroType: 'MANUAL_JOURNAL', number: '',
        date: xeroDate(mj.Date), total: '', currency: '',
        contact: '', blockers: '', note: (mj.Narration ?? '').slice(0, 80),
      })
      continue
    }
    const c = await confirmAbsence<XeroManualJournal>(token, 'ManualJournals', 'ManualJournals', id)
    if (c.object) {
      findings.push({
        uuid: id, entity: 'journal', syncType: row.type, postedAt: row.createdAt,
        actualStatus: c.object.Status, evidence: c.evidence,
        xeroType: 'MANUAL_JOURNAL', number: '',
        date: xeroDate(c.object.Date), total: '', currency: '',
        contact: '', blockers: '', note: (c.object.Narration ?? '').slice(0, 80),
      })
      continue
    }
    findings.push(unresolvedFinding(id, row, 'journal', c.resolution, c.evidence, c.note))
  }
  return { findings, unknownInWindow, pagingComplete }
}

/**
 * Page to an EMPTY page and throw if the read cannot be proven complete. An under-reported contact
 * or item list feeds the cleanup worklist, so a silent truncation here is a footprint left behind.
 */
async function pageComplete<T>(token: StoredToken, path: string, key: string, idOf: (row: T) => string): Promise<T[]> {
  return pageAllComplete<T>({
    read: <R,>(p: string) => xeroGet<R>(token, p),
    path,
    key,
    idOf,
    log: (m) => console.log(m),
  })
}

async function sweepContacts(token: StoredToken): Promise<XeroContact[]> {
  const where = encodeURIComponent(`Name.StartsWith("${E2E_PREFIX}")`)
  return pageComplete<XeroContact>(token, `Contacts?where=${where}`, 'Contacts', (c) => c.ContactID)
}

/**
 * Items are PAGED, not read unpaged.
 *
 * An unpaged Xero GET over a collection that pages is silently truncated to the oldest 100, and
 * "at most 100 items exist" is not something this audit gets to assume on the org's behalf —
 * whatever this endpoint happened to do on one run. pageAllComplete proves completeness either
 * way: it walks to an empty page, and recognises the case where Xero ignores `page` entirely and
 * the first response was already the whole collection.
 */
async function sweepItems(token: StoredToken): Promise<XeroItem[]> {
  const all = await pageComplete<XeroItem>(token, 'Items', 'Items', (i) => i.ItemID)
  return all.filter((i) => (i.Code ?? '').startsWith(`${E2E_PREFIX}-`))
}

// ---------------------------------------------------------------------------
function toCsv(findings: Finding[]): string {
  const cols: Array<keyof Finding> = [
    'uuid', 'entity', 'syncType', 'postedAt', 'actualStatus', 'evidence', 'xeroType',
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
  console.log(`  + one GET per id a collection read does not return, to turn "not seen" into a real 404`)
  console.log(`    (worst case ${String(n('invoice') + n('creditnote') + n('journal')).padStart(4)} more calls; --no-confirm-absence skips them and downgrades those verdicts to UNKNOWN)`)
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
  const { findings: journalFindings, unknownInWindow, pagingComplete } = await sweepJournals(token, grouped.get('journal') ?? [])
  console.log('--- E2E contacts ---')
  const contacts = await sweepContacts(token)
  console.log('--- E2E items ---')
  const items = await sweepItems(token)

  const findings = [...paymentFindings, ...invoiceFindings, ...creditNoteFindings, ...journalFindings]
  writeFileSync(OUT_PATH, toCsv(findings))

  console.log(`\n=== RECONCILIATION (${findings.length} of ${rows.length} ids) ===`)
  for (const [key, count] of [...tally(findings)].sort()) console.log(`  ${String(count).padStart(4)}  ${key}`)

  // The three buckets that matter, and they are NOT "present" and "gone". An id that no read
  // conclusively resolved belongs to neither, and lumping it in with "already gone" is how a
  // transient 5xx becomes a reconciliation conclusion.
  const unknown = findings.filter((f) => f.actualStatus === 'UNKNOWN')
  const errored = findings.filter((f) => f.actualStatus === 'ERROR')
  // Anything Xero returned carries a real status and is conclusive by construction; the two
  // buckets above are exactly the ids `isConclusive` rejects.
  const unresolvedIds = findings.filter((f) => ['NOT_FOUND', 'UNKNOWN', 'ERROR'].includes(f.actualStatus) && !isConclusive(f.actualStatus as Resolution))
  const confirmedAbsent = findings.filter((f) => f.actualStatus === 'NOT_FOUND')
  const live = findings.filter((f) => !['NOT_FOUND', 'UNKNOWN', 'ERROR', 'VOIDED', 'DELETED'].includes(f.actualStatus))
  const voided = findings.filter((f) => ['VOIDED', 'DELETED'].includes(f.actualStatus))

  console.log(`\nStill present and not voided:   ${live.length}`)
  console.log(`Present but already voided:     ${voided.length}`)
  console.log(`Confirmed absent (per-id 404):  ${confirmedAbsent.length}`)
  console.log(`UNKNOWN (not conclusively resolved): ${unknown.length}`)
  console.log(`ERROR (a read failed):          ${errored.length}`)

  console.log('\n--- by evidence ---')
  const byEvidence = new Map<string, number>()
  for (const f of findings) byEvidence.set(f.evidence, (byEvidence.get(f.evidence) ?? 0) + 1)
  for (const [k, v] of [...byEvidence].sort()) console.log(`  ${String(v).padStart(4)}  ${k}`)

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
  console.log(`API calls used: ${transport.callCount} (ceiling ${MAX_CALLS})`)
  console.log(`\nThe audit token is cached at ${TOKEN_FILE}. Delete it when the cleanup is done.`)

  // A reconciliation with an unresolved id is not a reconciliation. Say so, loudly, and exit
  // non-zero so no caller and no reader can take the summary above as a settled answer.
  const unresolved = unresolvedIds.length
  if (unresolved !== unknown.length + errored.length) throw new Error('BUG: unresolved bucket disagrees with UNKNOWN+ERROR')
  if (unresolved || !pagingComplete) {
    console.error(
      `\n=== INCONCLUSIVE ===\n` +
        (unresolved ? `  ${unresolved} of ${findings.length} id(s) were not conclusively resolved.\n` : '') +
        (!pagingComplete ? `  Manual-journal enumeration did not reach an empty page, so the page walk is incomplete.\n` : '') +
        `  Do NOT quote "everything is gone" from this run. Re-run it${CONFIRM_ABSENCE ? '' : ' without --no-confirm-absence'}.`,
    )
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`)
  process.exit(1)
})
