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
 *                     tenant-stamped id manifest. An object that is live-selected but absent from
 *                     the manifest is fatal.
 *   5. COMPLETENESS   a read that could not be proven complete is an error, never an empty result.
 *   6. REVALIDATION   each object is re-read immediately before it is mutated and must be
 *                     byte-for-byte the object that was planned.
 *   7. OUTCOME        a run with any failure exits non-zero and does not report success.
 */

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
/** A planned object is not covered by the reviewed manifest. */
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
 *   • an EMPTY page                — the collection is exhausted. This is the only success.
 *   • a page of only already-seen ids — Xero ignored `page` and answered with the whole collection
 *     (it drops unknown query params rather than rejecting them). Page 1 therefore already WAS the
 *     whole collection, so this is also complete — but it has to be recognised, or the walk spins
 *     to the ceiling.
 *   • anything else                — a non-2xx page, or the page ceiling. NOT complete, so it
 *     throws. The previous implementation `break`-ed on a failed page and returned the partial
 *     accumulation as if it were the whole set, which is what let a failed read become a partial
 *     irreversible apply.
 *
 * It deliberately does NOT stop on a short-but-non-empty page: the page size is not a guarantee,
 * and treating "fewer than 100" as terminal is the same class of mistake as trusting an ignored
 * filter. That assumption is exactly what makes the manual-journal `NOT_FOUND` unsound.
 */
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
    const list = res.data?.[key] ?? []
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
// 4. MANIFEST — a reviewed, tenant-stamped id list
// ---------------------------------------------------------------------------
export type ManifestEntry = { uuid: string; entity: string; status: string; contact: string; number: string }
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
      status: iStatus >= 0 ? (f[iStatus] ?? '').trim() : '',
      contact: iContact >= 0 ? (f[iContact] ?? '').trim() : '',
      number: iNumber >= 0 ? (f[iNumber] ?? '').trim() : '',
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

/**
 * Nothing gets mutated unless a human already looked at it.
 *
 * The asymmetry is deliberate and is the whole point:
 *   • a planned object that is NOT in the manifest is FATAL — it appeared after the review, so no
 *     one has agreed it is test residue;
 *   • a manifest id not present live is fine — it was already cleaned up, or never existed.
 */
export function assertPlanWithinManifest(
  plan: Array<{ uuid: string; entity: string; label: string }>,
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
   * payments off a PAID document leaves it AUTHORISED. Only transitions THIS RUN caused belong
   * here — a SUBMITTED document that has become AUTHORISED was approved by a human, and that is
   * exactly the divergence worth stopping for.
   */
  allowedStatuses: string[]
  contactName?: string
  blockers?: string[]
  /**
   * 'exact'  — the blocker set must be unchanged (nothing has touched it yet).
   * 'subset' — the live set may only be a subset of the plan's: an earlier step is allowed to have
   *            released blockers, but a NEW one appearing means someone else is working on this
   *            document and the run stops.
   */
  blockerPolicy?: 'exact' | 'subset'
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
    const allowed = new Set(expected.blockers ?? [])
    const added = (live.blockers ?? []).filter((b) => !allowed.has(b))
    if (added.length) diffs.push(`new blocker(s) appeared since the plan: ${added.join(', ')}`)
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
// 7. OUTCOME
// ---------------------------------------------------------------------------
export type RunOutcome = { label: string; exitCode: number }

/**
 * A run that failed anywhere does not get to print APPLIED and exit 0. Partial destruction reported
 * as success is the single worst shape this tooling can take.
 */
export function runOutcome(args: { apply: boolean; failed: number; incomplete?: boolean }): RunOutcome {
  const { apply, failed, incomplete = false } = args
  if (!apply) return { label: failed || incomplete ? 'DRY RUN — INCOMPLETE' : 'DRY RUN', exitCode: failed || incomplete ? 1 : 0 }
  if (failed || incomplete) return { label: `PARTIALLY APPLIED — ${failed} FAILURE(S)`, exitCode: 1 }
  return { label: 'APPLIED', exitCode: 0 }
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
  authorizedBy: string
  authorizedAt: string
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
  const required = ['token', 'tenantId', 'database', 'ids', 'authorizedBy', 'authorizedAt']
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
  return {
    token: fields.get('token')!,
    tenantId: fields.get('tenantId')!,
    database: fields.get('database')!,
    ids,
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
  /** How many ids the CSV actually resolved to. */
  idCount: number
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
    tenantRows, expectedTenantId, idCount,
  } = input

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

  // The approval covered a specific id set of a specific size. A CSV that has since grown is not
  // the set that was approved.
  if (authorization.ids !== idCount) {
    throw new RetirementRefusedError(
      `REFUSED: the authorization covers ${authorization.ids} id(s) but the CSV resolves to ${idCount}. ` +
        'Re-review and re-authorize.',
    )
  }
}
