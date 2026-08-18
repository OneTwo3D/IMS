/**
 * o3d-t74p — the safety contract for the LIVE Xero incident scripts.
 *
 * The four `*-xero-live-*` scripts operate on a REAL ledger and one of them writes irreversibly:
 * a voided invoice cannot be un-voided and a deleted item cannot be restored. Every boundary that
 * stands between "read the org" and "destroy part of it" lives in this file rather than inline in
 * the scripts, for one reason: prose in a header is not executable, and the review that merged the
 * first pass missed a one-character predicate bug that would have swept genuine business contacts
 * into an irreversible void. These functions are covered by tests/scripts/xero-live-safety.test.ts.
 *
 * The contract, in the order it is enforced:
 *
 *   1. TRANSPORT      no method other than GET can leave the process unless --apply was passed.
 *   2. TENANT         the organisation Xero reports must be the expected one, by id AND by name.
 *   3. SELECTION      only the exact full-chain fixture naming grammar selects an object, and
 *                     anything that merely looks E2E-ish aborts the run instead of being included
 *                     or silently dropped.
 *   4. MANIFEST       every object about to be mutated must appear in a separately reviewed,
 *                     tenant-stamped manifest AND still be in the state that manifest records.
 *                     An object that is live-selected but absent from the manifest is fatal, and
 *                     so is one whose status, contact, blockers or UpdatedDateUTC have moved since
 *                     the review: a uuid says WHICH object a human approved, never WHAT they
 *                     approved doing to it.
 *   5. COMPLETENESS   a read that could not be proven complete is an error, never an empty result.
 *   6. REVALIDATION   each object is re-read immediately before it is mutated and must be
 *                     byte-for-byte the object that was planned.
 *   7. OUTCOME        a run with any failure exits non-zero and does not report success, and a run
 *                     that THREW after writing says how much it had already destroyed.
 */
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Errors. All safety aborts share a base class so a caller can tell a refusal
// to act from an ordinary transport failure.
// ---------------------------------------------------------------------------
export class SafetyViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}
/** A write was attempted without --apply. This is a programming error, not an operator error. */
export class WriteWithoutApplyError extends SafetyViolationError {}
/** The connected organisation is not the expected one. */
export class TenantMismatchError extends SafetyViolationError {}
/** A read could not be proven complete, so nothing downstream may treat it as the whole set. */
export class ReadIncompleteError extends SafetyViolationError {}
/** Something that looks like a fixture but does not match the grammar exactly. */
export class AmbiguousSelectionError extends SafetyViolationError {}
/** A planned object is not covered by the reviewed manifest, or has moved since it was reviewed. */
export class ManifestViolationError extends SafetyViolationError {}
/** A live object no longer matches the plan that was reviewed. */
export class PlanDivergedError extends SafetyViolationError {}

// ---------------------------------------------------------------------------
// 3. SELECTION — the exact fixture naming grammar
// ---------------------------------------------------------------------------
/**
 * The full-chain harness builds its Woo customer as
 *   `first_name: 'E2E', last_name: runTag(runId)`      e2e/full-chain/harness/wc.ts:122
 *   `runTag(runId) === 'E2E-FC-' + runId`              e2e/full-chain/harness/tag.ts:23-28
 *   `runId === base36(Date.now()) + 4 random base36`   e2e/full-chain/harness/tag.ts:15-21
 * which Xero renders as the contact name `E2E E2E-FC-<runId>`. All 111 contacts in the live
 * footprint match this exactly (verified against xero-live-e2e-footprint-20260810.csv).
 *
 * A namespace prefix would not do. `'E2E'` also matches `E2ENetworks Ltd`; `'E2E '` — the
 * correction made on the first pass — still matches `E2E Consulting Ltd`. Both are plausible names
 * for a real supplier, and the script VOIDS what it matches. Only the full grammar is safe.
 */
export const FIXTURE_CONTACT_NAME = /^E2E E2E-FC-[0-9a-z]+$/

/**
 * `taggedSku` is `E2E-FC-<RUNID>-<LABEL>` upper-cased (tag.ts:31-33), e.g.
 * `E2E-FC-MRMDZZHZHGDF-SMOKE`. All 217 items in the live footprint match. The bare `E2E-`
 * namespace does not qualify on its own.
 */
export const FIXTURE_ITEM_CODE = /^E2E-FC-[0-9A-Z]+(?:-[0-9A-Z]+)+$/

/** Anything carrying the token at all — the trip-wire for a near miss. */
const LOOKS_LIKE_E2E = /e2e/i

export type SelectionClass =
  /** Matches the fixture grammar exactly. Safe to mutate, subject to the manifest. */
  | 'fixture'
  /** Carries the E2E token but is not the fixture grammar. NEVER mutated; aborts the run. */
  | 'near-miss'
  /** Nothing to do with the fixtures. */
  | 'unrelated'

export function classifyContactName(name?: string | null): SelectionClass {
  if (!name) return 'unrelated'
  if (FIXTURE_CONTACT_NAME.test(name)) return 'fixture'
  return LOOKS_LIKE_E2E.test(name) ? 'near-miss' : 'unrelated'
}

export function classifyItemCode(code?: string | null): SelectionClass {
  if (!code) return 'unrelated'
  if (FIXTURE_ITEM_CODE.test(code)) return 'fixture'
  return LOOKS_LIKE_E2E.test(code) ? 'near-miss' : 'unrelated'
}

/** The only predicate that may gate a write. Exact grammar, nothing else. */
export const isFixtureContactName = (name?: string | null): boolean => classifyContactName(name) === 'fixture'
export const isFixtureItemCode = (code?: string | null): boolean => classifyItemCode(code) === 'fixture'

/**
 * A near miss is not a judgement call to be made at 2am against a live ledger. If the server-side
 * `StartsWith` filter hands back anything that is E2E-ish but not the exact fixture form, the whole
 * run stops so a human can look at it.
 */
export function assertNoNearMisses(
  labelled: Array<{ label: string; value?: string | null }>,
  classify: (v?: string | null) => SelectionClass,
  what: string,
): void {
  const nearMisses = labelled.filter((x) => classify(x.value) === 'near-miss')
  if (nearMisses.length === 0) return
  const shown = nearMisses.slice(0, 10).map((x) => `${x.label} => ${JSON.stringify(x.value)}`)
  throw new AmbiguousSelectionError(
    `ABORT: ${nearMisses.length} ${what} carry the E2E token but do not match the fixture grammar, ` +
      `so they are NOT provably test residue:\n  ${shown.join('\n  ')}` +
      (nearMisses.length > shown.length ? `\n  ... and ${nearMisses.length - shown.length} more` : '') +
      `\nResolve these by hand. Nothing was written.`,
  )
}

// ---------------------------------------------------------------------------
// 1. TRANSPORT — the write gate
// ---------------------------------------------------------------------------
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type XeroResult<T> = { ok: boolean; status: number; data?: T; error?: string }
export type TransportToken = { accessToken: string; tenantId: string }

export type XeroTransport = {
  request<T>(token: TransportToken, method: HttpMethod, path: string, body?: unknown): Promise<XeroResult<T>>
  /** GET-only view of `request`, for the pagination helpers and anything that must not write. */
  reader(token: TransportToken): <T>(path: string) => Promise<XeroResult<T>>
  readonly callCount: number
}

export type TransportOptions = {
  /** FALSE unless the operator passed --apply. Defaulting this to false is part of the contract. */
  apply?: boolean
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxCalls?: number
  minIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string) => void
  /** Consecutive 429s tolerated on one call before giving up. */
  maxRateLimitRetries?: number
  /** Extra headers per request, e.g. If-Modified-Since. */
  headersFor?: (path: string) => Record<string, string>
}

const DEFAULT_BASE_URL = 'https://api.xero.com/api.xro/2.0'

export function createXeroTransport(options: TransportOptions = {}): XeroTransport {
  const {
    // `apply` defaults to FALSE. A caller that forgets to pass it gets a read-only transport, not
    // a live one — the failure direction has to be inert, because the other direction is a void.
    apply = false,
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE_URL,
    maxCalls = 1500,
    minIntervalMs = 1100,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    log = () => {},
    maxRateLimitRetries = 5,
    headersFor,
  } = options

  let callCount = 0
  let lastCallAt = 0

  async function request<T>(token: TransportToken, method: HttpMethod, path: string, body?: unknown, rateLimitRetries = 0): Promise<XeroResult<T>> {
    // FIRST, before pacing, before any network work: a non-GET without --apply never happens.
    // This is the last line of defence, so it throws rather than returning an error result — a
    // caller cannot accidentally ignore it the way it can ignore `{ ok: false }`.
    if (method !== 'GET' && !apply) {
      throw new WriteWithoutApplyError(`BUG: attempted ${method} ${path} without --apply`)
    }
    if (callCount >= maxCalls) throw new Error(`API call ceiling (${maxCalls}) reached`)

    const wait = minIntervalMs - (now() - lastCallAt)
    if (wait > 0) await sleep(wait)
    callCount++
    lastCallAt = now()

    const res = await fetchImpl(`${baseUrl}/${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
        'Xero-Tenant-Id': token.tenantId,
        'Accept': 'application/json',
        ...(headersFor?.(path) ?? {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '0')
      // The daily cap's Retry-After is measured in HOURS. Sleeping on it is indistinguishable from
      // a hung script, so surface it instead.
      if (retryAfter > 120) throw new Error(`Rate limited; Retry-After ${retryAfter}s after ${callCount} calls`)
      // Bounded. The retry refunds the budget (`callCount--`) so that a rate-limited call does not
      // eat the ceiling — which means an endpoint stuck at 429 would otherwise retry forever, and
      // `maxCalls` could never stop it.
      if (rateLimitRetries >= maxRateLimitRetries) {
        throw new Error(`Rate limited ${maxRateLimitRetries} times in a row on ${method} ${path}; giving up after ${callCount} calls`)
      }
      log(`  rate limited, sleeping ${retryAfter}s...`)
      await sleep((retryAfter + 1) * 1000)
      callCount--
      return request<T>(token, method, path, body, rateLimitRetries + 1)
    }

    const text = await res.text()
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) }
    if (!text) return { ok: true, status: res.status }
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T }
    } catch {
      // A 200 that is not JSON is not a successful read. Returning ok:true here is how a garbage
      // response becomes "the collection is empty", which is how absence gets manufactured.
      return { ok: false, status: res.status, error: `Non-JSON response: ${text.slice(0, 200)}` }
    }
  }

  return {
    request,
    reader(token: TransportToken) {
      return <T>(path: string) => request<T>(token, 'GET', path)
    },
    get callCount() {
      return callCount
    },
  }
}

// ---------------------------------------------------------------------------
// 2. TENANT
// ---------------------------------------------------------------------------
export function assertExpectedTenant(args: {
  tokenTenantId: string
  organisationName?: string
  expectedTenantId: string
  expectedTenantName: string
}): void {
  const { tokenTenantId, organisationName, expectedTenantId, expectedTenantName } = args
  if (tokenTenantId !== expectedTenantId || organisationName !== expectedTenantName) {
    throw new TenantMismatchError(
      `ABORT: connected to "${organisationName ?? '(unknown)'}" (${tokenTenantId}), ` +
        `expected ${expectedTenantName} (${expectedTenantId})`,
    )
  }
}

// ---------------------------------------------------------------------------
// 5. COMPLETENESS — pagination that cannot silently under-report
// ---------------------------------------------------------------------------
export type Reader = <T>(path: string) => Promise<XeroResult<T>>

/**
 * Page a Xero collection to proven completeness.
 *
 * Three distinct endings, and only one of them is "done":
 *
 *   • an EMPTY `key` array         — the collection is exhausted. This is the only success.
 *   • a page of only already-seen ids — Xero ignored `page` and answered with the whole collection
 *     (it drops unknown query params rather than rejecting them). Page 1 therefore already WAS the
 *     whole collection, so this is also complete — but it has to be recognised, or the walk spins
 *     to the ceiling.
 *   • anything else                — a non-2xx page, a 2xx whose body is not a Xero collection
 *     envelope carrying `key` as an ARRAY, or the page ceiling. NOT complete, so it throws. The
 *     previous implementation `break`-ed on a failed page and returned the partial accumulation as
 *     if it were the whole set, which is what let a failed read become a partial irreversible
 *     apply.
 *
 * The body-shape check is the same defect as the failed page wearing different clothes. `res.data?.
 * [key] ?? []` cannot tell `{"Invoices":[]}` — Xero saying the collection is exhausted — from a
 * 200 carrying an HTML error page, a proxy's `{"message":"..."}`, an empty body, or a response
 * whose collection key we spelled wrong. All four used to read as "nothing there", and "nothing
 * there" is what stops the walk, truncates the manifest, and leaves live objects behind while the
 * run reports success. A response we cannot parse says NOTHING about the collection.
 *
 * It deliberately does NOT stop on a short-but-non-empty page: the page size is not a guarantee,
 * and treating "fewer than 100" as terminal is the same class of mistake as trusting an ignored
 * filter. That assumption is exactly what makes the manual-journal `NOT_FOUND` unsound.
 */
/**
 * Turn a 2xx page into either the collection it claims to be, or a REASON it is not one.
 *
 * Shared, because the "empty means exhausted" defect had two homes: this file's pager and the
 * manual-journal sweep in audit-xero-live-contamination.ts, which set `pagingComplete = true` on a
 * body it could not read. Fixing one and leaving the other is how the 429 defect survived three
 * copies of the same client. The callers differ in what they DO about it — the pager throws, the
 * journal sweep marks the enumeration incomplete and falls through to per-id confirmation — but
 * neither may treat an unreadable body as an answer.
 */
export type CollectionPage<T> = { ok: true; rows: T[] } | { ok: false; reason: string }

export function parseCollectionPage<T>(data: unknown, key: string): CollectionPage<T> {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      reason: `the body is not a Xero collection envelope (${data === undefined ? 'no body' : Array.isArray(data) ? 'a bare array' : typeof data})`,
    }
  }
  const rows = (data as Record<string, unknown>)[key]
  if (!Array.isArray(rows)) {
    const keys = Object.keys(data as Record<string, unknown>)
    return { ok: false, reason: `no \`${key}\` array (top-level keys: ${keys.length ? keys.join(', ') : 'none'})` }
  }
  return { ok: true, rows: rows as T[] }
}

export async function pageAllComplete<T>(args: {
  read: Reader
  path: string
  key: string
  idOf: (row: T) => string
  maxPages?: number
  log?: (m: string) => void
}): Promise<T[]> {
  const { read, path, key, idOf, maxPages = 25, log = () => {} } = args
  const seen = new Set<string>()
  const out: T[] = []

  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await read<Record<string, T[]>>(`${path}${sep}page=${page}`)
    if (!res.ok) {
      throw new ReadIncompleteError(
        `ABORT: ${path} page ${page} failed (HTTP ${res.status}${res.error ? `: ${res.error}` : ''}). ` +
          `The read is incomplete, so no plan built from it can be trusted. Nothing was written.`,
      )
    }
    // A 2xx is not by itself a read. The body has to be a collection envelope carrying `key` as an
    // array before "the array is empty" is allowed to mean the collection is exhausted.
    const parsed = parseCollectionPage<T>(res.data, key)
    if (!parsed.ok) {
      throw new ReadIncompleteError(
        `ABORT: ${path} page ${page} answered HTTP ${res.status} but ${parsed.reason}. A response that cannot ` +
          `be parsed says nothing about the collection — it is NOT an empty one. The read is incomplete, so no ` +
          `plan built from it can be trusted. Nothing was written.`,
      )
    }
    const list = parsed.rows
    if (list.length === 0) return out

    let fresh = 0
    for (const row of list) {
      const id = idOf(row)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(row)
      fresh++
    }
    if (fresh === 0) {
      // Every id on this page was already seen: `page` is not being honoured, and page 1 was the
      // entire collection.
      log(`  (${path}: page ${page} repeated page ${page - 1} — Xero is ignoring \`page\`; the first response was complete)`)
      return out
    }
  }

  throw new ReadIncompleteError(
    `ABORT: ${path} hit the ${maxPages}-page ceiling without an empty page. The read is incomplete ` +
      `and indistinguishable from completion. Raise the ceiling deliberately or narrow the query. Nothing was written.`,
  )
}

// ---------------------------------------------------------------------------
// BLOCKERS — one grammar, shared by the audit that writes the manifest and the
// writer that is authorised by it
// ---------------------------------------------------------------------------
/**
 * A "blocker" is anything Xero requires released before a document can be voided: an allocation,
 * a payment, a refund. The manifest binds the blocker SET a human reviewed, so the audit and the
 * writer have to name blockers the same way — two spellings of the same allocation would make
 * every credit note look changed and reduce the check to noise, which is how a safety check gets
 * switched off.
 *
 * An allocation is named by the INVOICE it links to, not by its own AllocationID: the id is absent
 * from some collection responses, and a set of `allocation:?` entries collapses duplicates and
 * silently agrees with itself. The invoice id is always present and is what actually identifies
 * which link is being released.
 */
export type AllocationLike = { AllocationID?: string; Invoice?: { InvoiceID?: string } }
export type PaymentLike = { PaymentID?: string }
export type CreditNoteRefLike = { CreditNoteID?: string }

export const allocationBlocker = (a: AllocationLike): string =>
  `allocation:${a.Invoice?.InvoiceID ?? a.AllocationID ?? 'unidentified'}`

/** Blockers on a CREDIT NOTE: its allocations to invoices, and any refund paid against it. */
export function creditNoteBlockers(cn: { Allocations?: AllocationLike[]; Payments?: PaymentLike[] }): string[] {
  return [
    ...(cn.Allocations ?? []).map(allocationBlocker),
    ...(cn.Payments ?? []).map((p) => `refund:${p.PaymentID ?? 'unidentified'}`),
  ]
}

/** Blockers on an INVOICE: payments against it, and credit notes allocated to it. */
export function invoiceBlockers(inv: { Payments?: PaymentLike[]; CreditNotes?: CreditNoteRefLike[] }): string[] {
  return [
    ...(inv.Payments ?? []).map((p) => `payment:${p.PaymentID ?? 'unidentified'}`),
    ...(inv.CreditNotes ?? []).map((c) => `creditnote:${c.CreditNoteID ?? 'unidentified'}`),
  ]
}

/** The manifest's on-disk form: sorted so the CSV is order-insensitive by construction. */
export const formatBlockers = (blockers: string[]): string => [...blockers].sort().join(' ')
export const parseBlockers = (field: string): string[] => field.split(/\s+/).filter(Boolean)

// ---------------------------------------------------------------------------
// 4. MANIFEST — a reviewed, tenant-stamped record of objects AND their state
// ---------------------------------------------------------------------------
export type ManifestEntry = {
  uuid: string
  entity: string
  status: string
  contact: string
  number: string
  /** The blocker set as reviewed, in the shared grammar above. */
  blockers: string[]
  /** Xero's raw UpdatedDateUTC as reviewed. Any movement at all is divergence. */
  updatedDateUtc: string
}
export type WriteManifest = {
  tenantId: string
  entries: Map<string, ManifestEntry>
  countsByEntity: Map<string, number>
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Parse the reviewed manifest — the CSV that audit-xero-live-e2e-footprint.ts writes.
 *
 * The `tenantId` column is mandatory and must be single-valued. Without a tenant stamp a manifest
 * is just a list of uuids, and o3d-s36z (nothing records which organisation an id belongs to) is
 * precisely the defect that produced this incident: 553 ids that read as live-org objects and were
 * not. A manifest that cannot say which org it describes may not authorise a write.
 *
 * The STATE columns — status, contact, blockers, updatedDateUtc — are mandatory for the same
 * reason and are just as load-bearing. A manifest of bare uuids authorises "you may act on these
 * objects" forever; what a human actually signed off is "you may act on these objects AS THEY ARE
 * NOW". A credit note reviewed as SUBMITTED (not posted, no GL effect, deletable) and since
 * APPROVED by a person is a different object with the same uuid, and its removal is now a real
 * ledger change. A manifest that cannot state what was reviewed cannot authorise the write, so an
 * older CSV without these columns is refused rather than accepted at reduced strength.
 */
export function parseWriteManifest(csvText: string): WriteManifest {
  const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) throw new ManifestViolationError('ABORT: the manifest is empty.')
  const header = splitCsvLine(lines[0])
  const col = (name: string) => header.indexOf(name)
  const iTenant = col('tenantId')
  const iUuid = col('uuid')
  const iEntity = col('entity')
  if (iTenant < 0) {
    throw new ManifestViolationError(
      'ABORT: the manifest has no tenantId column, so it cannot say which organisation it describes. ' +
        'Regenerate it with audit-xero-live-e2e-footprint.ts.',
    )
  }
  if (iUuid < 0 || iEntity < 0) throw new ManifestViolationError('ABORT: the manifest needs uuid and entity columns.')
  const iStatus = col('status')
  const iContact = col('contact')
  const iNumber = col('number')
  const iBlockers = col('blockers')
  const iUpdated = col('updatedDateUtc')
  // The state columns are what turn a list of uuids into an authorisation. Missing columns are
  // refused rather than defaulted: an empty string would compare equal to an object that genuinely
  // has no blockers, and the check would pass by accident on exactly the manifests it cannot cover.
  const missingState = [
    iStatus < 0 ? 'status' : null,
    iContact < 0 ? 'contact' : null,
    iBlockers < 0 ? 'blockers' : null,
    iUpdated < 0 ? 'updatedDateUtc' : null,
  ].filter(Boolean)
  if (missingState.length) {
    throw new ManifestViolationError(
      `ABORT: the manifest has no ${missingState.join(', ')} column(s), so it records WHICH objects were ` +
        'reviewed but not WHAT STATE they were reviewed in. A uuid on its own authorises acting on an object ' +
        'that a human has since approved, paid or re-contacted. Regenerate the manifest with ' +
        'scripts/audit-xero-live-e2e-footprint.ts and review it again.',
    )
  }

  const entries = new Map<string, ManifestEntry>()
  const countsByEntity = new Map<string, number>()
  const tenants = new Set<string>()

  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line)
    const tenantId = (f[iTenant] ?? '').trim()
    const uuid = (f[iUuid] ?? '').trim()
    if (!uuid) continue
    if (!tenantId) throw new ManifestViolationError(`ABORT: manifest row ${uuid} has no tenantId.`)
    tenants.add(tenantId)
    const entity = (f[iEntity] ?? '').trim()
    entries.set(uuid, {
      uuid,
      entity,
      status: (f[iStatus] ?? '').trim(),
      contact: (f[iContact] ?? '').trim(),
      number: iNumber >= 0 ? (f[iNumber] ?? '').trim() : '',
      blockers: parseBlockers((f[iBlockers] ?? '').trim()),
      updatedDateUtc: (f[iUpdated] ?? '').trim(),
    })
    countsByEntity.set(entity, (countsByEntity.get(entity) ?? 0) + 1)
  }

  if (tenants.size !== 1) {
    throw new ManifestViolationError(
      `ABORT: the manifest spans ${tenants.size} tenants (${[...tenants].join(', ')}). One manifest, one organisation.`,
    )
  }
  if (entries.size === 0) throw new ManifestViolationError('ABORT: the manifest has no rows.')
  return { tenantId: [...tenants][0], entries, countsByEntity }
}

export function assertManifestTenant(manifest: WriteManifest, expectedTenantId: string): void {
  if (manifest.tenantId !== expectedTenantId) {
    throw new ManifestViolationError(
      `ABORT: the manifest describes tenant ${manifest.tenantId}, but this run is connected to ${expectedTenantId}.`,
    )
  }
}

/** An object as the live plan read it, in the same terms the manifest records. */
export type PlannedObject = {
  uuid: string
  entity: string
  /** Human-facing name for the error message — invoice number, contact name, item code. */
  label: string
  status: string
  contactName?: string
  blockers?: string[]
  updatedDateUtc?: string
}

/**
 * Nothing gets mutated unless a human already looked at it — AT THIS STATE.
 *
 * Two separate refusals, and the second is the one that was missing:
 *
 *   • IDENTITY. A planned object that is NOT in the manifest is FATAL. It appeared after the
 *     review, so nobody has agreed it is test residue. (A manifest id no longer present live is
 *     fine — it was already cleaned up, or never existed. That asymmetry is deliberate.)
 *
 *   • STATE. A planned object whose status, contact, blocker set or UpdatedDateUTC differs from
 *     the manifest is FATAL. Binding only the uuid authorises an object that has moved since a
 *     human looked at it: a credit note reviewed as SUBMITTED and since APPROVED by a person, an
 *     invoice re-contacted to a genuine customer, a document that has since been paid, or one that
 *     picked up an allocation nobody in this run created. All of those keep their uuid, all of them
 *     pass an id-only check, and all of them are irreversible when acted on. UpdatedDateUTC is
 *     compared as the catch-all: it moves for changes none of the other columns can express.
 *
 * This runs against the PLAN — the complete read taken at the start of the apply — so it fires
 * once, before the first mutation, rather than after part of the ledger has already been destroyed.
 */
export function assertPlanAuthorizedByManifest(
  plan: PlannedObject[],
  manifest: WriteManifest,
): { covered: number; missingFromLedger: string[] } {
  const unreviewed = plan.filter((p) => !manifest.entries.has(p.uuid))
  if (unreviewed.length) {
    const shown = unreviewed.slice(0, 10).map((p) => `${p.entity} ${p.label} (${p.uuid})`)
    throw new ManifestViolationError(
      `ABORT: ${unreviewed.length} object(s) selected against the live ledger are NOT in the reviewed manifest:\n  ` +
        shown.join('\n  ') +
        (unreviewed.length > shown.length ? `\n  ... and ${unreviewed.length - shown.length} more` : '') +
        `\nThey appeared after the manifest was produced. Re-run the read-only footprint audit, review it, ` +
        `and pass the new manifest. Nothing was written.`,
    )
  }

  const diverged: string[] = []
  for (const p of plan) {
    const reviewed = manifest.entries.get(p.uuid)!
    const diffs: string[] = []
    if (reviewed.entity !== p.entity) diffs.push(`entity ${reviewed.entity} -> ${p.entity}`)
    if (reviewed.status !== p.status) diffs.push(`status ${reviewed.status || '(none)'} -> ${p.status || '(none)'}`)
    if (reviewed.contact !== (p.contactName ?? '')) {
      diffs.push(`contact ${JSON.stringify(reviewed.contact)} -> ${JSON.stringify(p.contactName ?? '')}`)
    }
    if (normaliseBlockers(reviewed.blockers) !== normaliseBlockers(p.blockers)) {
      diffs.push(`blockers [${normaliseBlockers(reviewed.blockers)}] -> [${normaliseBlockers(p.blockers)}]`)
    }
    if (reviewed.updatedDateUtc !== (p.updatedDateUtc ?? '')) {
      diffs.push(`updatedDateUTC ${reviewed.updatedDateUtc || '(none)'} -> ${p.updatedDateUtc || '(none)'}`)
    }
    if (diffs.length) diverged.push(`${p.entity} ${p.label} (${p.uuid}): ${diffs.join('; ')}`)
  }
  if (diverged.length) {
    const shown = diverged.slice(0, 10)
    throw new ManifestViolationError(
      `ABORT: ${diverged.length} object(s) are in the manifest but are NO LONGER IN THE STATE THAT WAS REVIEWED:\n  ` +
        shown.join('\n  ') +
        (diverged.length > shown.length ? `\n  ... and ${diverged.length - shown.length} more` : '') +
        `\nThe manifest authorises acting on these objects as they were when a human read the CSV, not on ` +
        `whatever they have become since. Something — a person approving a document, a payment, a re-contact — ` +
        `has changed them. Re-run the read-only footprint audit, review the new CSV, and pass that. Nothing was written.`,
    )
  }

  const planned = new Set(plan.map((p) => p.uuid))
  const missingFromLedger = [...manifest.entries.keys()].filter((id) => !planned.has(id))
  return { covered: plan.length, missingFromLedger }
}

// ---------------------------------------------------------------------------
// 6. REVALIDATION — the object about to be mutated is the object that was planned
// ---------------------------------------------------------------------------
export type RevalidationSubject = {
  id: string
  status: string
  contactName?: string
  /** Payment / allocation / credit-note ids that gate the transition, order-insensitive. */
  blockers?: string[]
  updatedDateUtc?: string
}

export type RevalidationExpectation = {
  id: string
  /**
   * Every status the object may legitimately be in when we reach it. It is a SET, not a single
   * value, because this script's own earlier steps move a document: releasing the allocations and
   * payments off a PAID document leaves it AUTHORISED. Only transitions THIS RUN ACTUALLY CAUSED
   * belong here — build it with `allowedStatusesAfterRun`, never with `statusesAfterReleasingBlockers`
   * directly, or the set admits the same transition when somebody else caused it.
   */
  allowedStatuses: string[]
  contactName?: string
  blockers?: string[]
  /**
   * 'exact'    — the blocker set must be unchanged (nothing has touched it yet).
   * 'released' — the live set may differ from the plan's ONLY by blockers this run itself released,
   *              listed in `releasedBlockers`. A blocker that appeared, or one that vanished
   *              without this run deleting it, means someone else is working on the document.
   */
  blockerPolicy?: 'exact' | 'released'
  /**
   * The blockers THIS RUN deleted off this object, recorded at the moment the DELETE succeeded.
   * Only meaningful under the 'released' policy. Anything not in here that has gone missing was
   * removed by somebody else.
   */
  releasedBlockers?: string[]
  updatedDateUtc?: string
}

function normaliseBlockers(b?: string[]): string {
  return [...(b ?? [])].sort().join(' ')
}

/** Releasing every blocker off a PAID document leaves it AUTHORISED; nothing else moves. */
export function statusesAfterReleasingBlockers(plannedStatus: string): string[] {
  return plannedStatus === 'PAID' ? ['PAID', 'AUTHORISED'] : [plannedStatus]
}

/**
 * The statuses a document may be in by the time this run reaches it — CONDITIONAL ON THIS RUN
 * HAVING CAUSED THE MOVE.
 *
 * `statusesAfterReleasingBlockers` answers "what could this transition produce". That is a
 * different question from "is this transition explained", and using the first as the answer to the
 * second is how a permissive set gets written: PAID -> AUTHORISED is accepted whether step 1 of
 * this run released the payment or a colleague did it by hand in the Xero UI two minutes ago,
 * while the plan we are about to void was already stale. The run knows which of those happened —
 * it recorded its own successful deletes — so the widened set is only offered when this run is the
 * reason the document could have moved. Otherwise the planned status is the only acceptable one.
 *
 * `thisRunReleasedABlocker` must come from the run's own journal of SUCCEEDED deletes, not from
 * intent: a delete that was attempted and failed explains nothing.
 */
export function allowedStatusesAfterRun(plannedStatus: string, thisRunReleasedABlocker: boolean): string[] {
  return thisRunReleasedABlocker ? statusesAfterReleasingBlockers(plannedStatus) : [plannedStatus]
}

/**
 * Compare the freshly re-read object against the reviewed plan and refuse the write on ANY
 * unexplained difference.
 *
 * The failure this closes is not "Xero rejects an invalid transition". It is the opposite: someone
 * re-assigns a selected document to a genuine contact between the plan read and the write, the
 * document stays in a perfectly valid status, the stale cached `Contact.Name` still satisfies the
 * predicate, and Xero happily voids a real customer's invoice. That is a WRONG write, not a
 * rejected one, and it is irreversible.
 */
export function assertUnchanged(expected: RevalidationExpectation, live: RevalidationSubject | null | undefined): void {
  if (!live) {
    throw new PlanDivergedError(
      `ABORT: ${expected.id} could not be re-read immediately before mutating it. Nothing further was written.`,
    )
  }
  const diffs: string[] = []
  if (live.id !== expected.id) diffs.push(`id ${expected.id} -> ${live.id}`)
  if (!expected.allowedStatuses.includes(live.status)) {
    diffs.push(`status ${live.status} is not one of [${expected.allowedStatuses.join(', ')}]`)
  }
  if ((live.contactName ?? '') !== (expected.contactName ?? '')) {
    diffs.push(`contact ${JSON.stringify(expected.contactName ?? '')} -> ${JSON.stringify(live.contactName ?? '')}`)
  }
  const policy = expected.blockerPolicy ?? 'exact'
  if (policy === 'exact') {
    if (normaliseBlockers(live.blockers) !== normaliseBlockers(expected.blockers)) {
      diffs.push(`blockers [${normaliseBlockers(expected.blockers)}] -> [${normaliseBlockers(live.blockers)}]`)
    }
  } else {
    const plannedSet = new Set(expected.blockers ?? [])
    const liveSet = new Set(live.blockers ?? [])
    const added = [...liveSet].filter((b) => !plannedSet.has(b))
    if (added.length) diffs.push(`new blocker(s) appeared since the plan: ${added.join(', ')}`)
    // A blocker that has GONE is only acceptable if this run is the one that deleted it. The
    // permissive version of this check ("the live set may be any subset of the plan's") accepts a
    // colleague releasing a payment in the Xero UI as readily as it accepts step 1's own DELETE,
    // and then the widened status set accepts the resulting PAID -> AUTHORISED too. Between them
    // that is a document moving under the script and the script agreeing to void it anyway.
    const released = new Set(expected.releasedBlockers ?? [])
    const goneUnexplained = [...plannedSet].filter((b) => !liveSet.has(b) && !released.has(b))
    if (goneUnexplained.length) {
      diffs.push(
        `blocker(s) released by something other than this run: ${goneUnexplained.join(', ')}` +
          (released.size ? ` (this run released: ${[...released].sort().join(', ')})` : ' (this run released nothing here)'),
      )
    }
  }
  if (expected.updatedDateUtc && live.updatedDateUtc && live.updatedDateUtc !== expected.updatedDateUtc) {
    diffs.push(`updatedDateUTC ${expected.updatedDateUtc} -> ${live.updatedDateUtc}`)
  }
  if (diffs.length === 0) return
  throw new PlanDivergedError(
    `ABORT: ${expected.id} changed between the reviewed plan and this write:\n  ${diffs.join('\n  ')}\n` +
      `The whole run stops — a ledger that is moving under the script is not one to keep writing to.`,
  )
}

/** The re-read must also still satisfy the selection grammar, not just match the plan. */
export function assertStillFixtureContact(id: string, liveContactName?: string): void {
  if (isFixtureContactName(liveContactName)) return
  throw new PlanDivergedError(
    `ABORT: ${id} is now contacted to ${JSON.stringify(liveContactName ?? '')}, which is not a full-chain ` +
      `fixture contact. Nothing further was written.`,
  )
}

// ---------------------------------------------------------------------------
// 7. OUTCOME — including the outcome of a run that threw part-way through
// ---------------------------------------------------------------------------
export type RunOutcome = { label: string; exitCode: number }

/**
 * A run that failed anywhere does not get to print APPLIED and exit 0. Partial destruction reported
 * as success is the single worst shape this tooling can take — and so is partial destruction
 * reported as nothing at all, which is what `aborted` exists for.
 *
 * `aborted` means the run threw: a safety guard refused, the ledger moved under it, the token
 * expired. `writesMade` is how many irreversible writes had already succeeded when that happened.
 * An abort after zero writes is a clean refusal; an abort after N writes is a PARTIAL APPLY, and
 * the operator has to be told so in the same breath as the error — otherwise the last thing on
 * screen is a stack-shaped message about one credit note and no indication that eighty invoices
 * are already voided.
 */
export function runOutcome(args: {
  apply: boolean
  failed: number
  incomplete?: boolean
  aborted?: boolean
  writesMade?: number
}): RunOutcome {
  const { apply, failed, incomplete = false, aborted = false, writesMade = 0 } = args
  if (!apply) {
    if (aborted) return { label: 'DRY RUN — ABORTED', exitCode: 1 }
    return { label: failed || incomplete ? 'DRY RUN — INCOMPLETE' : 'DRY RUN', exitCode: failed || incomplete ? 1 : 0 }
  }
  if (aborted) {
    return writesMade > 0
      ? { label: `PARTIALLY APPLIED — ABORTED AFTER ${writesMade} IRREVERSIBLE WRITE(S)`, exitCode: 1 }
      : { label: 'ABORTED — NOTHING WAS WRITTEN', exitCode: 1 }
  }
  if (failed || incomplete) return { label: `PARTIALLY APPLIED — ${failed} FAILURE(S)`, exitCode: 1 }
  return { label: 'APPLIED', exitCode: 0 }
}

/**
 * What this run has actually done to the live ledger, so far.
 *
 * It serves two of the safety checks at once, and they are the same fact seen from two sides:
 *
 *   • CAUSALITY. `recordRelease` is called only when a DELETE has SUCCEEDED, so `releasedFor` can
 *     answer "did this run remove that blocker" — the difference between a document this run moved
 *     and a document that moved for reasons nobody in this process knows about.
 *   • REPORTABILITY. `writeCount` is the number of irreversible writes already made, which is what
 *     turns a thrown exception from "the run failed" into "the run destroyed this much and then
 *     failed".
 *
 * It is deliberately append-only and holds no opinions: the journal records what happened, the
 * guards decide what it permits.
 */
export type MutationRecord = { kind: string; label: string }

export class MutationJournal {
  private readonly writes: MutationRecord[] = []
  private readonly releases = new Map<string, Set<string>>()
  private readonly failures: string[] = []

  /** An irreversible write that SUCCEEDED. Never call this for an attempt. */
  recordWrite(kind: string, label: string): void {
    this.writes.push({ kind, label })
  }

  /**
   * A blocker this run removed, keyed by the object it was removed FROM. A single allocation
   * delete releases both sides, so it is recorded against both the credit note and the invoice.
   */
  recordRelease(subjectKey: string, blocker: string): void {
    const set = this.releases.get(subjectKey) ?? new Set<string>()
    set.add(blocker)
    this.releases.set(subjectKey, set)
  }

  releasedFor(subjectKey: string): string[] {
    return [...(this.releases.get(subjectKey) ?? [])]
  }

  /** Did THIS RUN release anything off this object? The gate for widening the allowed statuses. */
  causedRelease(subjectKey: string): boolean {
    return (this.releases.get(subjectKey)?.size ?? 0) > 0
  }

  recordFailure(message: string): void {
    this.failures.push(message)
  }

  get writeCount(): number { return this.writes.length }
  get writeRecords(): readonly MutationRecord[] { return this.writes }
  get failureCount(): number { return this.failures.length }
  get failureMessages(): readonly string[] { return this.failures }
}

// ---------------------------------------------------------------------------
// Absence classification, shared with the read-only audits
// ---------------------------------------------------------------------------
/**
 * How an id was resolved. The distinction between the last two is the whole of finding 5/6: an
 * object that was ASKED FOR BY ID and answered 404 is gone; an object that merely failed to turn up
 * in a collection read is UNKNOWN, and a collection read that ERRORED says nothing at all.
 */
export type Resolution =
  /** The object was returned by Xero. */
  | 'PRESENT'
  /** A per-id GET returned HTTP 404. This is the ONLY value that means "confirmed absent". */
  | 'NOT_FOUND'
  /** Not seen, and not confirmed by a per-id read. Says nothing about whether it exists. */
  | 'UNKNOWN'
  /** A read failed. Says nothing about whether it exists. */
  | 'ERROR'

export function isConclusive(resolution: Resolution): boolean {
  return resolution === 'PRESENT' || resolution === 'NOT_FOUND'
}

/**
 * Turn a per-id GET into a resolution. Anything that is not a 2xx and not a 404 is an ERROR — a
 * transient 5xx or an expired token must never be published as "this object is gone".
 */
export function resolveById(res: { ok: boolean; status: number }, found: boolean): Resolution {
  if (res.ok) return found ? 'PRESENT' : 'UNKNOWN'
  if (res.status === 404) return 'NOT_FOUND'
  return 'ERROR'
}

// ---------------------------------------------------------------------------
// The retirement refusal (o3d-t74p finding 4)
// ---------------------------------------------------------------------------
/**
 * retire-live-tenant-external-ids.ts nulls the stored Xero ids on 553 local rows. Its premise —
 * that those ids address objects in the LIVE organisation — was DISPROVED: they are Demo-tenant
 * ids, and the instance is connected to Demo, so they are plausibly CURRENT references. Its own
 * documentation says do not run it.
 *
 * A header warning is not a control. This is: the apply path refuses by default and the refusal can
 * only be lifted by a deliberate, documented override that cannot be satisfied by accident —
 * a long exact flag AND a signed-off authorization file AND three positive database/tenant checks
 * that all have to agree with each other.
 */
export class RetirementRefusedError extends SafetyViolationError {}

/** The exact token the authorization file must carry. Nothing else unlocks the apply path. */
export const RETIREMENT_AUTHORIZATION_TOKEN = 'RETIRE-DEMO-HISTORY'
/** The exact flag. Long, specific, and unpleasant to type by mistake — that is the point. */
export const RETIREMENT_OVERRIDE_FLAG = '--i-have-read-o3d-t74p-and-authorize-demo-history-retirement'

export type RetirementAuthorization = {
  token: string
  tenantId: string
  database: string
  ids: number
  /** SHA-256 of the exact id set that was signed off. See `fingerprintIds`. */
  idsSha256: string
  authorizedBy: string
  authorizedAt: string
}

/**
 * The fingerprint of an id SET — order-insensitive, duplicate-insensitive, whitespace-insensitive,
 * so it is a property of the set itself and not of how the CSV happened to be sorted the day it was
 * read.
 *
 * A count is not a binding. `ids: 553` is satisfied by ANY 553 ids: a different export, a CSV
 * regenerated after the underlying data moved, one id swapped for another, or the same file with
 * a row edited. The authorization is supposed to say "I reviewed THESE rows and agreed to null
 * THEM", and only a fingerprint of the actual ids says that. The count is kept as well, because it
 * gives the operator a readable failure ("553 vs 554") before the opaque one.
 */
export function fingerprintIds(ids: Iterable<string>): string {
  const unique = [...new Set([...ids].map((id) => id.trim()).filter((id) => id !== ''))].sort()
  return createHash('sha256').update(unique.join('\n')).digest('hex')
}

export function parseRetirementAuthorization(text: string): RetirementAuthorization {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(':')
    if (at < 0) continue
    fields.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim())
  }
  const required = ['token', 'tenantId', 'database', 'ids', 'idsSha256', 'authorizedBy', 'authorizedAt']
  const missing = required.filter((k) => !fields.get(k))
  if (missing.length) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization file is missing ${missing.join(', ')}. Every field is mandatory.`,
    )
  }
  const ids = Number(fields.get('ids'))
  if (!Number.isInteger(ids) || ids <= 0) {
    throw new RetirementRefusedError(`REFUSED: the authorization file's \`ids\` must be a positive integer.`)
  }
  const idsSha256 = fields.get('idsSha256')!.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(idsSha256)) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization file's \`idsSha256\` must be a 64-character SHA-256 hex digest of the ` +
        `reviewed id set. The dry run prints it.`,
    )
  }
  return {
    token: fields.get('token')!,
    tenantId: fields.get('tenantId')!,
    database: fields.get('database')!,
    ids,
    idsSha256,
    authorizedBy: fields.get('authorizedBy')!,
    authorizedAt: fields.get('authorizedAt')!,
  }
}

export type RetirementGuardInput = {
  /** Was the exact long override flag present on the command line? */
  overrideFlagPresent: boolean
  /** The parsed authorization file, or null if none was supplied. */
  authorization: RetirementAuthorization | null
  /** `select current_database()` — the server's own answer, NOT a substring of DATABASE_URL. */
  currentDatabase: string | null
  expectedDatabase: string
  /** Every Xero token row in the database. */
  tenantRows: Array<{ tenantId: string; tenantName?: string | null }>
  expectedTenantId: string
  /** The ids the CSV actually resolved to — the set, not a count of it. */
  ids: string[]
}

/**
 * Throws unless EVERY condition holds. Each check is positive — it requires proof of the expected
 * state rather than the absence of a wrong one — because the guard this replaces failed open in
 * three separate ways at once:
 *
 *   • it permitted the currently connected Demo tenant, which is the exact state in which the
 *     documented damage occurs;
 *   • it permitted ZERO token rows (`tok.rows.length &&` short-circuits to "fine");
 *   • it checked `DATABASE_URL.includes('onetwo3d_ims_e2e')`, which a username, a password or a
 *     query parameter containing that string satisfies while connected somewhere else entirely.
 */
export function assertRetirementAuthorized(input: RetirementGuardInput): void {
  const {
    overrideFlagPresent, authorization, currentDatabase, expectedDatabase,
    tenantRows, expectedTenantId, ids,
  } = input
  const idCount = new Set(ids.map((id) => id.trim()).filter((id) => id !== '')).size

  if (!overrideFlagPresent || !authorization) {
    throw new RetirementRefusedError(
      'REFUSED: this operation is disabled.\n' +
        '  Its premise was disproved on 2026-08-10: the 553 ids are Demo-tenant ids and the instance is\n' +
        '  connected to Demo, so they are plausibly CURRENT references. Nulling them would delete live\n' +
        '  back-references, not retire dead ones. The script\'s own header says do not run it.\n' +
        `  If a documented decision now authorises dropping the e2e instance's Demo-tenant history, pass\n` +
        `  ${RETIREMENT_OVERRIDE_FLAG}\n` +
        '  together with --authorization <file> carrying token/tenantId/database/ids/authorizedBy/authorizedAt.',
    )
  }

  if (authorization.token !== RETIREMENT_AUTHORIZATION_TOKEN) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization token is ${JSON.stringify(authorization.token)}, not ${RETIREMENT_AUTHORIZATION_TOKEN}.`,
    )
  }

  // The database says what it is. DATABASE_URL is a connection *request*, not an identity.
  if (!currentDatabase) {
    throw new RetirementRefusedError('REFUSED: could not read current_database() from the server.')
  }
  if (currentDatabase !== expectedDatabase) {
    throw new RetirementRefusedError(
      `REFUSED: connected to database ${JSON.stringify(currentDatabase)}, not ${JSON.stringify(expectedDatabase)}.`,
    )
  }
  if (authorization.database !== currentDatabase) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization is for database ${JSON.stringify(authorization.database)}, ` +
        `but this connection is to ${JSON.stringify(currentDatabase)}.`,
    )
  }

  // Exactly one tenant, positively matched. Zero rows is not "safe by default" — it means nothing
  // can confirm which organisation the ids belong to, which is the whole defect (o3d-s36z).
  if (tenantRows.length !== 1) {
    throw new RetirementRefusedError(
      `REFUSED: expected exactly one Xero token row to identify the connected organisation, found ${tenantRows.length}. ` +
        'Nothing can say which tenant these ids belong to.',
    )
  }
  if (tenantRows[0].tenantId !== expectedTenantId) {
    throw new RetirementRefusedError(
      `REFUSED: connected to "${tenantRows[0].tenantName ?? tenantRows[0].tenantId}" (${tenantRows[0].tenantId}), ` +
        `not the authorised tenant ${expectedTenantId}.`,
    )
  }
  if (authorization.tenantId !== tenantRows[0].tenantId) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization is stamped for tenant ${authorization.tenantId}, but this instance is ` +
        `connected to ${tenantRows[0].tenantId}.`,
    )
  }

  // The approval covered a SPECIFIC SET of ids. The count is checked first only because "553 vs
  // 554" is a readable failure; it is not the binding, because any 553 ids satisfy it.
  if (authorization.ids !== idCount) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization covers ${authorization.ids} id(s) but the CSV resolves to ${idCount}. ` +
        'Re-review and re-authorize.',
    )
  }

  // The binding. Without it the authorization is a note saying "some ids were reviewed": point the
  // script at a different CSV of the same size — a re-export after the data moved, one id swapped
  // for another, a hand-edited row — and the same signed file authorises nulling back-references
  // nobody ever looked at. The fingerprint is of the id SET, so re-ordering or re-exporting the
  // same ids still matches, and anything else does not.
  const fingerprint = fingerprintIds(ids)
  if (authorization.idsSha256 !== fingerprint) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization is signed for id set ${authorization.idsSha256}, but the CSV resolves to ` +
        `${fingerprint}. Same count, different ids — this is not the set that was reviewed. Re-review and re-authorize.`,
    )
  }
}
