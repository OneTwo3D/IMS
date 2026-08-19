import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WC_COUPON_CUTOFF_FLOOR,
  WC_COUPON_ID_CHUNK_SIZE,
  WC_COUPON_MAX_CANDIDATES,
  WC_COUPON_NEAR_CUTOFF_MS,
  WC_COUPON_SCAN_PAGE_SIZE,
  buildWcCouponAllowlistEntry,
  chunkWcCouponIds,
  collectWcCouponCandidates,
  decideWcCouponBackfill,
  isNearWcCouponCutoff,
  parseWcCouponAllowlist,
  parseWcCouponCutoff,
  type WcCouponAllowlistEntry,
  type WcCouponBackfillRow,
} from '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'

/**
 * Codex round 1, finding 3. The provenance classifier (o3d-9te) narrows the candidate set; it does
 * not establish it, and the earlier build treated "pre-cutoff and unmarked" as proof that a row was
 * written by the pre-fix importer. Two things falsify that, and NEITHER is visible on the row:
 *
 *   • the database does not enforce that `discountAmount` is write-once. A row corrected by hand —
 *     raw SQL, an ad-hoc script, anything outside the application — is still unmarked and still
 *     pre-cutoff, and re-deriving it turns a correct residual of 6 into 2 and then stamps that
 *     permanently;
 *   • `development` shipped the FIXED importer before it stamped the marker, so a cutoff even
 *     slightly later than that rollout's true earliest moment misclassifies correct, unmarked
 *     imports from the interval in between.
 *
 * So apply consumes a REVIEWED ALLOWLIST rather than a scan. This file covers the three things that
 * makes safe: the cutoff cannot be given ambiguously, the file cannot be acted on unsigned, and the
 * rows the cutoff CHOICE decided are flagged for individual review rather than swept in.
 */

const CUTOFF = new Date('2026-07-25T14:00:00.000Z')
const NOW = new Date('2026-08-16T00:00:00.000Z')

// ---------------------------------------------------------------------------
// The cutoff must be unambiguous
// ---------------------------------------------------------------------------

test('a bare date is REJECTED as ambiguous, not read as UTC midnight (Codex r1 F3)', () => {
  // The failure this prevents is silent: `new Date('2026-07-25')` is UTC midnight, the operator
  // means their local midnight, and every order imported in the hours between is classified by the
  // difference. A refusal costs one re-run; a wrong boundary destroys residuals.
  const parsed = parseWcCouponCutoff('2026-07-25', NOW)

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'AMBIGUOUS_FORMAT')
})

test('a human-readable date is REJECTED — its parse is implementation-defined (Codex r1 F3)', () => {
  const parsed = parseWcCouponCutoff('July 25 2026 14:00', NOW)

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'AMBIGUOUS_FORMAT')
})

test('an ISO instant is accepted, with Z or an explicit offset (Codex r1 F3)', () => {
  const utc = parseWcCouponCutoff('2026-07-25T14:00:00Z', NOW)
  const offset = parseWcCouponCutoff('2026-07-25T15:00:00+01:00', NOW)

  assert.equal(utc.ok, true)
  assert.equal(offset.ok, true)
  assert.equal(
    utc.ok && offset.ok && utc.cutoff.getTime(),
    offset.ok ? offset.cutoff.getTime() : -1,
    'the same instant, spelled two ways — both unambiguous',
  )
})

test('a FUTURE cutoff is rejected: it would classify every unmarked row as legacy (Codex r1 F3)', () => {
  const parsed = parseWcCouponCutoff('2027-01-01T00:00:00Z', NOW)

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'IN_THE_FUTURE')
})

test('an implausibly early cutoff is rejected as a typo (Codex r1 F3)', () => {
  const parsed = parseWcCouponCutoff('0226-07-25T14:00:00Z', NOW)

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'IMPLAUSIBLY_EARLY')
  assert.ok(WC_COUPON_CUTOFF_FLOOR.getTime() > 0)
})

test('a well-formed date that is not real is rejected, not ROLLED OVER (Codex r1 F3)', () => {
  // V8 turns 2026-02-31 into 3 March without complaint — six days of imports on the wrong side of
  // the boundary, from a typo that looks like a date.
  const parsed = parseWcCouponCutoff('2026-02-31T14:00:00Z', NOW)

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'NOT_A_DATE')
})

// ---------------------------------------------------------------------------
// The markerless interval — the rows the cutoff CHOICE decides
// ---------------------------------------------------------------------------

test('an import shortly BEFORE the cutoff is flagged near-cutoff (Codex r1 F3)', () => {
  // These are the ones `development`'s markerless fixed importer could have written. They are still
  // proposed, but the reviewer is told the verdict rests on the cutoff being exactly right.
  const near = new Date(CUTOFF.getTime() - WC_COUPON_NEAR_CUTOFF_MS + 1000)

  assert.equal(isNearWcCouponCutoff(near, CUTOFF), true)
})

test('an import comfortably before the cutoff is NOT flagged', () => {
  const old = new Date(CUTOFF.getTime() - WC_COUPON_NEAR_CUTOFF_MS - 1000)

  assert.equal(isNearWcCouponCutoff(old, CUTOFF), false)
})

test('an import AFTER the cutoff is not "near" it — it is post-fix and never a candidate', () => {
  assert.equal(isNearWcCouponCutoff(new Date(CUTOFF.getTime() + 1000), CUTOFF), false)
})

test('with no cutoff nothing is near it', () => {
  assert.equal(isNearWcCouponCutoff(new Date(), null), false)
  assert.equal(isNearWcCouponCutoff(null, CUTOFF), false)
})

test('the proposal entry carries the near-cutoff flag and the evidence it was decided on', () => {
  const row: WcCouponBackfillRow = {
    orderId: 'order-1',
    orderNumber: 'WC-1001',
    externalOrderNumber: '1001',
    currency: 'GBP',
    storedOrderDiscount: 10,
    lineDiscountTotal: 10,
    accountingInvoiceId: 'INV-9',
    postedInvoiceExternalIds: ['INV-9-UNLINKED'],
    discountModel: null,
    importedAt: new Date(CUTOFF.getTime() - 60_000),
    alreadyBackfilled: false,
    liveInvoiceJobs: 0,
    revenueDeferredBatchRef: 'A1-2026-07-01-aaaabbbb',
    liveBatchDeferralJobs: 0,
    refunds: { disposition: 'FULL', refundIds: ['refund-2', 'refund-1'], postedCreditNoteExternalIds: ['CN-7'], unresolvedRefundParkExternalIds: [] },
  }
  const decision = decideWcCouponBackfill(row, { importedBefore: CUTOFF })
  assert.equal(decision.action, 'CORRECT')
  if (decision.action !== 'CORRECT') return

  const entry = buildWcCouponAllowlistEntry(row, decision, CUTOFF)

  assert.equal(entry.nearCutoff, true, 'imported a minute before the cutoff: the choice decided it')
  assert.equal(entry.importedAt, row.importedAt?.toISOString())
  assert.equal(entry.storedOrderDiscount, 10)
  assert.equal(entry.lineDiscountTotal, 10)
  assert.equal(entry.keptOrderLevel, 0)
  assert.equal(entry.accountingInvoiceId, 'INV-9', 'so the reviewer sees the ledger is already wrong')
  assert.equal(
    entry.revenueDeferredBatchRef,
    'A1-2026-07-01-aaaabbbb',
    'and the SECOND accounting artefact derived from the same amount — the daily revenue deferral ' +
      '— which apply also compares against live state (o3d-y14 r2)',
  )
  assert.deepEqual(
    entry.refunds,
    { disposition: 'FULL', refundIds: ['refund-1', 'refund-2'], postedCreditNoteExternalIds: ['CN-7'], unresolvedRefundParkExternalIds: [] },
    'and the REFUND position, canonicalised — it decides whether the handoff may prescribe any ' +
      'remedy at all, and apply refuses the row if it has moved since (o3d-y14 r6 F1)',
  )
})

// ---------------------------------------------------------------------------
// The allowlist itself
// ---------------------------------------------------------------------------

function entry(over: Partial<WcCouponAllowlistEntry> = {}): WcCouponAllowlistEntry {
  return {
    orderId: 'order-1',
    orderNumber: 'WC-1001',
    externalOrderNumber: '1001',
    currency: 'GBP',
    storedOrderDiscount: 10,
    lineDiscountTotal: 10,
    importedAt: '2026-05-01T00:00:00.000Z',
    keptOrderLevel: 0,
    clearedBy: 10,
    partial: false,
    accountingInvoiceId: null,
    postedInvoiceExternalIds: [],
    revenueDeferredBatchRef: null,
    refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
    nearCutoff: false,
    ...over,
  }
}

function file(over: Record<string, unknown> = {}) {
  return {
    version: 4,
    generatedAt: '2026-08-16T09:00:00.000Z',
    cutoff: CUTOFF.toISOString(),
    reviewed: true,
    reviewedBy: 'Jan',
    reviewedAt: '2026-08-16T10:00:00.000Z',
    stampOnly: [],
    clear: [entry()],
    ...over,
  }
}

test('an UNSIGNED proposal is refused — the file is the only consent that exists (Codex r1 F3)', () => {
  // The dry run emits `reviewed: false`. Applying it unchanged would be the old
  // "every pre-cutoff null row" behaviour with extra steps.
  const parsed = parseWcCouponAllowlist(file({ reviewed: false, reviewedBy: null, reviewedAt: null }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'NOT_REVIEWED')
})

test('reviewed:true with no reviewer named is still refused', () => {
  const parsed = parseWcCouponAllowlist(file({ reviewedBy: '   ' }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'NOT_REVIEWED')
})

test('a signed allowlist parses, keeping both lists distinct', () => {
  const parsed = parseWcCouponAllowlist(
    file({ stampOnly: [entry({ orderId: 'order-2', storedOrderDiscount: 6, lineDiscountTotal: 4 })] }),
  )

  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.allowlist.clear.length, 1)
  assert.equal(parsed.allowlist.stampOnly.length, 1)
  assert.equal(parsed.allowlist.reviewedBy, 'Jan')
})

test('an order in BOTH lists is refused — which one wins decides whether money moves', () => {
  const parsed = parseWcCouponAllowlist(file({ stampOnly: [entry()] }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'DUPLICATE_ORDER')
})

test('an entry missing its evidence is refused, not defaulted', () => {
  // A defaulted `lineDiscountTotal` of 0 would make the re-verification vacuous: it would compare
  // the live lines against a number nobody reviewed.
  const withoutLines: Record<string, unknown> = { ...entry() }
  delete withoutLines.lineDiscountTotal
  const parsed = parseWcCouponAllowlist(file({ clear: [withoutLines] }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'MALFORMED')
})

test('an entry missing its DEFERRAL evidence is refused too (o3d-y14 r2 F2)', () => {
  // An absent `revenueDeferredBatchRef` is indistinguishable from "no batch has taken this order",
  // and apply compares that field against live state — so defaulting it would silently assert that
  // the reviewer saw no deferral on a row whose deferral was never shown to them.
  const withoutBatch: Record<string, unknown> = { ...entry() }
  delete withoutBatch.revenueDeferredBatchRef
  const parsed = parseWcCouponAllowlist(file({ clear: [withoutBatch] }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'MALFORMED')
})

// ---------------------------------------------------------------------------
// Bounding the scan (o3d-y14 r2 finding 3)
// ---------------------------------------------------------------------------

test('id lists are chunked below the bind-parameter ceiling (o3d-y14 r2 F3)', () => {
  // The report used ONE `IN (…)` over every candidate. PostgreSQL caps a statement at 65535 bound
  // parameters, so past that the query does not run slowly — it fails, in the phase an operator has
  // no reason to expect can fail at all.
  const ids = Array.from({ length: 1201 }, (_, index) => `order-${index}`)

  const batches = chunkWcCouponIds(ids)

  assert.equal(batches.length, 3, `${ids.length} ids at ${WC_COUPON_ID_CHUNK_SIZE} per statement`)
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [500, 500, 201],
  )
  assert.deepEqual(batches.flat(), ids, 'every id appears exactly once and in order — nothing dropped')
  assert.ok(
    WC_COUPON_ID_CHUNK_SIZE < 65535,
    'the chunk must stay under the protocol ceiling, or chunking achieves nothing',
  )
})

test('chunking an empty list yields no statements at all', () => {
  // Not cosmetic: one empty batch would issue an `IN ()` query per lookup on a run with no
  // candidates, and `IN ()` is a syntax error rather than an empty result.
  assert.deepEqual(chunkWcCouponIds([]), [])
})

test('the report PAGES its scan and CHUNKS every id lookup (o3d-y14 r2 F3)', async () => {
  // Asserted against the source, like the o3d-9te candidate-query test above, because the
  // alternative is a live database with production-scale cardinality. What matters is that no
  // statement is built from the WHOLE candidate set: the report previously used `orderIds` directly
  // in two `IN` lists, which is a bind-parameter count set by the catalogue.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  assert.match(src, /take: WC_COUPON_SCAN_PAGE_SIZE/, 'the candidate scan is paged')
  assert.match(src, /id: \{ gt: afterId \}/, 'and paged by KEYSET — an offset walk re-scans what it skipped')
  assert.match(src, /WC_COUPON_MAX_CANDIDATES/, 'and bounded by a refusal')
  assert.match(
    src,
    /collectWcCouponCandidates/,
    'and it drives the SHARED walk, so the tested loop is the one that runs',
  )

  assert.doesNotMatch(src, /\{ in: orderIds \}/, 'no statement takes the whole candidate id list')
  assert.equal(
    src.split('for (const batch of chunkWcCouponIds(').length - 1,
    7,
    'all seven id-keyed lookups — the backfill marker, the invoice count, the POSTED-invoice external ' +
      'ids (o3d-y14 r3 F2), the batch count, the REFUND rows and their SYNCED credit notes ' +
      '(o3d-y14 r6 F1), and the unresolved refund PARKS (o3d-y14 r7 F1) — are chunked',
  )
  assert.doesNotMatch(
    src,
    /\{ in: \[\.\.\.refundIdToOrderId\.keys\(\)\] \}/,
    'and the refund-id lookup is not a whole-set IN list either',
  )
})

// The walk itself, driven for real. The source assertions above prove the script uses a keyset page
// and a ceiling; only these can prove the WALK is right — the first revision checked its ceiling
// after the exhausted-page break, so a short final page could carry the total past it and leave, and
// every source-shaped assertion passed on that.

/** A fake catalogue of `total` ids, served in keyset pages of `pageSize`. */
function pagedCatalogue(total: number, pageSize: number) {
  const ids = Array.from({ length: total }, (_, index) => `order-${String(index).padStart(6, '0')}`)
  const cursors: Array<string | null> = []
  return {
    cursors,
    fetchPage: async (afterId: string | null) => {
      cursors.push(afterId)
      const start = afterId === null ? 0 : ids.indexOf(afterId) + 1
      return ids.slice(start, start + pageSize).map((id) => ({ id }))
    },
  }
}

test('the scan walks every page and asks for each one AFTER the last id it saw (o3d-y14 r2 F3)', async () => {
  const catalogue = pagedCatalogue(25, 10)

  const scan = await collectWcCouponCandidates(catalogue.fetchPage, { pageSize: 10, max: 1000 })

  assert.equal(scan.ok, true)
  assert.equal(scan.ok && scan.rows.length, 25, 'nothing dropped between pages')
  assert.deepEqual(
    catalogue.cursors,
    [null, 'order-000009', 'order-000019'],
    'each page is fetched from the previous page\'s last id — a keyset walk, not an offset one',
  )
})

test('a catalogue that ends exactly on a page boundary terminates (o3d-y14 r2 F3)', async () => {
  // The boundary the `page.length < pageSize` test turns on: the walk must ask once more and stop on
  // the empty page rather than either looping or dropping the last full page.
  const catalogue = pagedCatalogue(20, 10)

  const scan = await collectWcCouponCandidates(catalogue.fetchPage, { pageSize: 10, max: 1000 })

  assert.equal(scan.ok && scan.rows.length, 20)
  assert.equal(catalogue.cursors.length, 3, 'three fetches: two full pages and the empty one that ends it')
})

test('a candidate set past the ceiling is REFUSED, never truncated (o3d-y14 r2 F3)', async () => {
  const catalogue = pagedCatalogue(60, 10)

  const scan = await collectWcCouponCandidates(catalogue.fetchPage, { pageSize: 10, max: 25 })

  assert.equal(scan.ok, false)
  assert.equal(!scan.ok && scan.reason, 'TOO_MANY_CANDIDATES')
  assert.equal(!scan.ok && scan.scanned, 30, 'it stops at the first page that crosses, and reports the count')
})

test('the ceiling is enforced on a SHORT final page too (o3d-y14 r2 F3)', async () => {
  // The off-by-one this function exists to make testable. 24 rows in pages of 10: the third page is
  // short, so a ceiling checked only after the exhausted-page break never sees the overshoot and the
  // report comes back looking complete.
  const catalogue = pagedCatalogue(24, 10)

  const scan = await collectWcCouponCandidates(catalogue.fetchPage, { pageSize: 10, max: 20 })

  assert.equal(scan.ok, false, 'a short page that crosses the ceiling still refuses')
  assert.equal(!scan.ok && scan.scanned, 24)
})

test('a set exactly AT the ceiling is accepted — the refusal is for exceeding it (o3d-y14 r2 F3)', async () => {
  const catalogue = pagedCatalogue(20, 10)

  const scan = await collectWcCouponCandidates(catalogue.fetchPage, { pageSize: 10, max: 20 })

  assert.equal(scan.ok, true)
  assert.equal(scan.ok && scan.rows.length, 20)
})

test('a cursor that stops advancing is stopped by the ceiling, not left looping (o3d-y14 r2 F3)', async () => {
  // The ceiling is the termination guard as well as the sanity bound: a fetcher that keeps handing
  // back full pages must end the run rather than spin until the process is killed.
  let calls = 0
  const scan = await collectWcCouponCandidates(
    async () => {
      calls += 1
      return Array.from({ length: 10 }, (_, index) => ({ id: `stuck-${index}` }))
    },
    { pageSize: 10, max: 25 },
  )

  assert.equal(scan.ok, false)
  assert.equal(calls, 3, 'it gave up instead of looping forever')
})

test('an empty catalogue scans once and returns nothing (o3d-y14 r2 F3)', async () => {
  const catalogue = pagedCatalogue(0, 10)

  const scan = await collectWcCouponCandidates(catalogue.fetchPage, { pageSize: 10, max: 20 })

  assert.deepEqual(scan.ok && scan.rows, [])
  assert.deepEqual(catalogue.cursors, [null])
})

test('the scan page is smaller than the refusal ceiling (o3d-y14 r2 F3)', () => {
  // The report pages by WC_COUPON_SCAN_PAGE_SIZE and refuses past WC_COUPON_MAX_CANDIDATES. If the
  // page were the larger of the two the ceiling could be overshot by a whole page before anything
  // noticed, which is the truncation the refusal exists to avoid.
  assert.ok(WC_COUPON_SCAN_PAGE_SIZE > 0)
  assert.ok(WC_COUPON_SCAN_PAGE_SIZE < WC_COUPON_MAX_CANDIDATES)
})

test('a file from another build version is refused', () => {
  const parsed = parseWcCouponAllowlist(file({ version: 5 }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'UNSUPPORTED_VERSION')
})

test('a file with no lists at all is refused rather than treated as empty', () => {
  const parsed = parseWcCouponAllowlist({ version: 4, reviewed: true, reviewedBy: 'Jan' })

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'MALFORMED')
})

// ---------------------------------------------------------------------------
// The script's shape: apply may not re-derive its own candidate set
// ---------------------------------------------------------------------------

test('apply refuses to run without an allowlist, and never re-scans (Codex r1 F3)', async () => {
  // Asserted against the source because the alternative is a live database. The property is
  // structural: `apply()` must not contain the candidate query, or the review would be advisory.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  const applyFn = src.slice(src.indexOf('async function apply('), src.indexOf('async function report('))

  assert.ok(applyFn.length > 0, 'apply() exists as its own function')
  // The slice has to BE apply(), or a function inserted between the two would widen it and the two
  // assertions below would be about somebody else's code. Adding `reprint()` between them did
  // exactly that once.
  assert.doesNotMatch(applyFn.slice(1), /^async function /m, 'the slice contains apply() and nothing else')
  assert.doesNotMatch(applyFn, /db\.salesOrder\.findMany/, 'apply must not select its own candidates')
  assert.doesNotMatch(applyFn, /decideWcCouponBackfill/, 'apply must not re-decide what was reviewed')
  assert.match(applyFn, /parseWcCouponAllowlist/, 'apply validates the signed file')
  assert.match(applyFn, /REFUSING to apply|process\.exitCode = 1/, 'and refuses an invalid one')

  const mainFn = src.slice(src.indexOf('async function main('))
  assert.match(mainFn, /REFUSING to apply without --allowlist/, '--apply without a list is refused')
})

test('the proposal the dry run writes is UNSIGNED', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  const proposal = src.slice(src.indexOf('const proposal: WcCouponAllowlist = {'), src.indexOf('writeFileSync(allowlistOut'))

  assert.match(proposal, /reviewed: false/)
  assert.match(proposal, /reviewedBy: null/)
  assert.match(proposal, /stampOnly: \[\]/, 'nothing is pre-approved as already-correct either')
})

test('stamping runs BEFORE clearing, so protected rows are protected first (Codex r1 F3)', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  const stampAt = src.indexOf('stampWcCouponDiscountModel(tx, entry)')
  const clearAt = src.indexOf('applyWcCouponCorrection(tx, entry)')

  assert.ok(stampAt > 0 && clearAt > 0)
  assert.ok(stampAt < clearAt, 'a half-finished run must leave the never-re-derive rows already stamped')
})

test('the report READS the posted-but-unlinked invoice evidence apply compares against (o3d-y14 r3 F2)', async () => {
  // Source-asserted for the same reason the paging assertions above are: the report's queries run
  // against a live database. What matters is that the evidence apply refuses on is evidence the
  // REPORT can show — otherwise the o3d-9kek row is re-proposed with the same incomplete evidence
  // on every run and refused every time, which is a row that can never be applied and never be seen
  // to be stuck.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  assert.match(src, /POSTED_SALES_INVOICE_STATUSES/, 'the report reads SYNCED sales-invoice rows')
  assert.match(
    src,
    /externalTransactionId: \{ not: null \}/,
    'and only those carrying an external id — a SYNCED row without one is not a document',
  )
  assert.match(
    src,
    /postedInvoiceExternalIds: sortedPostedInvoiceIds\(/,
    'and the ids reach the row the proposal is built from, sorted as apply compares them',
  )
})

test('the REPORT reads the refund position and hands it to the classifier (o3d-y14 r6 F1)', async () => {
  // The report is a script against a live database, so what it PASSES to the handoff can only be
  // asserted at the source. It matters as much as apply does: the handoff prescribes a different job
  // for a refunded order, and a report that omitted the refund position would print the unrefunded
  // remedy — "raise a further invoice" — beside an order whose customer has already been refunded.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  assert.match(src, /refundStatus: true/, 'the candidate scan reads the order\'s refund disposition')
  assert.match(src, /db\.salesOrderRefund\.findMany/, 'and the refund rows behind it')
  assert.match(
    src,
    /referenceType: 'SalesOrderRefund'/,
    'and the SYNCED credit notes for those refunds — the id a refund row can deny (o3d-9kek)',
  )
  assert.match(
    src,
    /refunds: row\.refunds,/,
    'and the position reaches the ledger handoff, which prescribes nothing when it is non-empty',
  )
  assert.match(
    src,
    /isWcCouponOrderRefunded\(entry\.row\.refunds\)/,
    'and a refunded order is IN the classified set even with no invoice evidence at all',
  )
})

test('the entry carries the posted-but-unlinked ids the reviewer was shown (o3d-y14 r3 F2)', () => {
  const row: WcCouponBackfillRow = {
    orderId: 'order-1',
    orderNumber: 'WC-1001',
    externalOrderNumber: '1001',
    currency: 'GBP',
    storedOrderDiscount: 10,
    lineDiscountTotal: 10,
    accountingInvoiceId: null,
    // Deliberately unsorted and duplicated: the proposal must carry the canonical form, because
    // apply compares this against a separately-ordered live read.
    postedInvoiceExternalIds: ['INV-B', 'INV-A', 'INV-B'],
    discountModel: null,
    importedAt: new Date(CUTOFF.getTime() - 60_000),
    alreadyBackfilled: false,
    liveInvoiceJobs: 0,
    revenueDeferredBatchRef: null,
    liveBatchDeferralJobs: 0,
    refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
  }
  const decision = decideWcCouponBackfill(row, { importedBefore: CUTOFF })
  assert.equal(decision.action, 'CORRECT')
  if (decision.action !== 'CORRECT') return

  const built = buildWcCouponAllowlistEntry(row, decision, CUTOFF)

  assert.deepEqual(built.postedInvoiceExternalIds, ['INV-A', 'INV-B'])
})

test('an allowlist entry without the posted-invoice evidence is MALFORMED, never defaulted (o3d-y14 r3 F2)', () => {
  // Defaulting an absent list to `[]` would assert on the reviewer's behalf that they saw no
  // unlinked posted invoice — about the one row where that is most likely to be false.
  const { postedInvoiceExternalIds: _dropped, ...withoutEvidence } = entry()
  const parsed = parseWcCouponAllowlist(file({ clear: [withoutEvidence] }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'MALFORMED')
})

test('an allowlist entry without the REFUND evidence is MALFORMED, never defaulted (o3d-y14 r6 F1)', () => {
  // The most expensive of the three defaults: an absent refund position would read as "the reviewer
  // saw an order nobody had been refunded on", which is the assertion that lets the handoff tell an
  // operator to bill an already-refunded customer again.
  const { refunds: _dropped, ...withoutRefunds } = entry()
  const parsed = parseWcCouponAllowlist(file({ clear: [withoutRefunds] }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'MALFORMED')
})

test('an entry without the PARKED refund evidence is MALFORMED, never defaulted (o3d-y14 r7 F1)', () => {
  // The fourth signal, and the same argument as the other three: an absent list would read as "the
  // reviewer saw no refund that IMS failed to record", and those are the orders whose money has
  // already left the business — the ones a remedy must never reach.
  const withParks = entry()
  const { unresolvedRefundParkExternalIds: _dropped, ...refundsWithoutParks } = withParks.refunds
  const parsed = parseWcCouponAllowlist(
    file({ clear: [{ ...withParks, refunds: refundsWithoutParks }] }),
  )

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'MALFORMED')
})

test('an entry whose refund disposition is not one this build knows is MALFORMED (o3d-y14 r6 F1)', () => {
  const parsed = parseWcCouponAllowlist(
    file({ clear: [entry({ refunds: { disposition: 'PARTIALLY', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] } } as never)] }),
  )

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'MALFORMED')
})

test('a version-3 file is refused — it predates the PARKED refund evidence (o3d-y14 r7 F1)', () => {
  // The upgrade path for a proposal generated before the parks were read. A v3 entry carries the
  // three refund signals and not the fourth, and reading the fourth's absence as "no refund arrived
  // that IMS could not record" is exactly the finding: those are the orders whose money has already
  // left the business, and the ones the full "raise a further invoice" remedy would reach.
  const parsed = parseWcCouponAllowlist(file({ version: 3 }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'UNSUPPORTED_VERSION')
  assert.match(!parsed.ok ? parsed.detail : '', /PARKED refund evidence/)
  assert.match(!parsed.ok ? parsed.detail : '', /Re-run the dry run/)
})

test('a version-2 file is refused — it predates the refund evidence (o3d-y14 r6 F1)', () => {
  // Same upgrade path as v1, for the same reason: a v2 entry carries no refund position, and
  // reading its absence as "not refunded" is exactly the finding.
  const parsed = parseWcCouponAllowlist(file({ version: 2 }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'UNSUPPORTED_VERSION')
  assert.match(!parsed.ok ? parsed.detail : '', /predates the refund evidence entirely/)
  assert.match(!parsed.ok ? parsed.detail : '', /Re-run the dry run/)
})

test('a version-1 file is refused with an instruction to re-run the report (o3d-y14 r3 F2)', () => {
  // The upgrade path for a proposal generated before the evidence existed. Refusing on the version
  // is what stops a v1 entry being read as "reviewed, and no posted invoice was seen".
  const parsed = parseWcCouponAllowlist(file({ version: 1 }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'UNSUPPORTED_VERSION')
  assert.match(!parsed.ok ? parsed.detail : '', /Re-run the dry run/)
})

// ---------------------------------------------------------------------------
// o3d-y14 r8 finding 4 — the signature gate, and the ONE path it does not stand in
// ---------------------------------------------------------------------------

test('an UNSIGNED file parses for the read-only reprint path, and only when asked (r8 F4)', () => {
  const unsigned = file({ reviewed: false, reviewedBy: null })

  // The default is unchanged, and it is what apply uses.
  assert.equal(parseWcCouponAllowlist(unsigned).ok, false)
  assert.equal(!parseWcCouponAllowlist(unsigned).ok && (parseWcCouponAllowlist(unsigned) as { reason: string }).reason, 'NOT_REVIEWED')
  assert.equal(parseWcCouponAllowlist(unsigned, { requireSignature: true }).ok, false)

  // The relaxation has to be asked for explicitly, and it relaxes NOTHING else.
  const lenient = parseWcCouponAllowlist(unsigned, { requireSignature: false })
  assert.equal(lenient.ok, true)
  assert.equal(lenient.ok && lenient.allowlist.reviewed, false, 'and it does not pretend the file was signed')
  assert.equal(lenient.ok && lenient.allowlist.reviewedBy, null)
  assert.equal(parseWcCouponAllowlist(file({ version: 5 }), { requireSignature: false }).ok, false, 'version still gates')
  assert.equal(
    parseWcCouponAllowlist({ version: 4, reviewed: true, reviewedBy: 'Jan' }, { requireSignature: false }).ok,
    false,
    'structure still gates',
  )
})

test('APPLY still parses with the signature required — the gate did not move (r8 F4)', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'scripts/backfill-wc-coupon-order-discount.ts'), 'utf8')

  const applyFn = src.slice(src.indexOf('async function apply('), src.indexOf('async function report('))
  const reprintFn = src.slice(src.indexOf('async function reprint('), src.indexOf('async function main('))

  assert.match(applyFn, /parseWcCouponAllowlist\(parsedJson\)/)
  assert.doesNotMatch(applyFn, /requireSignature/, 'apply must never relax the signature')
  assert.match(reprintFn, /parseWcCouponAllowlist\(parsedJson, \{ requireSignature: false \}\)/)
})
