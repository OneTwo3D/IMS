import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WC_COUPON_CUTOFF_FLOOR,
  WC_COUPON_NEAR_CUTOFF_MS,
  buildWcCouponAllowlistEntry,
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
    discountModel: null,
    importedAt: new Date(CUTOFF.getTime() - 60_000),
    alreadyBackfilled: false,
    liveInvoiceJobs: 0,
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
    nearCutoff: false,
    ...over,
  }
}

function file(over: Record<string, unknown> = {}) {
  return {
    version: 1,
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

test('a file from another build version is refused', () => {
  const parsed = parseWcCouponAllowlist(file({ version: 2 }))

  assert.equal(parsed.ok, false)
  assert.equal(!parsed.ok && parsed.reason, 'UNSUPPORTED_VERSION')
})

test('a file with no lists at all is refused rather than treated as empty', () => {
  const parsed = parseWcCouponAllowlist({ version: 1, reviewed: true, reviewedBy: 'Jan' })

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
