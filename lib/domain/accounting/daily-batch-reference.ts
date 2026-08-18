/**
 * Daily-batch reference identity (o3d-0qoo).
 *
 * A daily batch's IDENTITY is its `AccountingSyncLog.referenceId`. It used to be
 * re-DERIVED by every consumer from the row's stage stamp — and that derivation is
 * wrong whenever a run crosses UTC midnight: both daily-sync implementations capture
 * the batch date ONCE at run start and write the per-row stage stamps with later
 * `new Date()` calls, so a batch keyed `A2-2026-07-20-<digest>` can leave behind a
 * stamp of `2026-07-21T00:0x:xxZ`. Every consumer that re-derives then looks for a
 * batch that does not exist.
 *
 * The daily-sync writers now persist the EXACT referenceId alongside the stamp
 * (SalesOrder.revenueDeferredBatchRef / .inventoryAllocatedBatchRef,
 * Shipment.shipmentJournalBatchRef), in the same transaction. This module turns that
 * persisted reference back into (a) the batch's own date and (b) the set of
 * referenceIds a consumer must look for. The derive-from-stamp path survives ONLY as
 * a fallback for pre-migration rows.
 *
 * Reference shapes in the wild:
 *   Xero        `<group>-<YYYY-MM-DD>-<8 lowercase hex>`  (buildDailyBatchReferenceId)
 *   QuickBooks  `<group>-<YYYY-MM-DD>`
 * where group is A1 (revenue deferral), A2 (inventory allocation) or B (shipment COGS).
 */

export type DailyBatchGroupCode = 'A1' | 'A2' | 'B'

export type ParsedDailyBatchReference = {
  group: DailyBatchGroupCode
  /** The BATCH's own date, `YYYY-MM-DD`. Not the stage stamp's date. */
  date: string
  /** The 8-hex entity digest (Xero), or null for the bare QuickBooks shape. */
  digest: string | null
}

const DAILY_BATCH_REFERENCE_PATTERN = /^(A1|A2|B)-(\d{4})-(\d{2})-(\d{2})(?:-([0-9a-f]{8}))?$/

/**
 * Parse a persisted daily-batch referenceId.
 *
 * REFUSES (returns null) rather than salvaging a substring, because the caller uses the
 * result as a journal date and as a journal identity — a half-understood reference must
 * fall back to the old derive-from-stamp behaviour, not post a journal on a date nobody
 * chose. Refused: null/empty, a shape that is not exactly `<group>-<date>[-<8 hex>]`, a
 * group other than A1/A2/B, an impossible calendar date (`2026-02-30`), a digest that is
 * not exactly 8 lowercase hex, any trailing junk, and — when `expectedGroup` is given — a
 * reference belonging to a different group than the column it was read from.
 */
export function parseDailyBatchReference(
  referenceId: string | null | undefined,
  expectedGroup?: DailyBatchGroupCode,
): ParsedDailyBatchReference | null {
  if (!referenceId) return null
  const match = DAILY_BATCH_REFERENCE_PATTERN.exec(referenceId)
  if (!match) return null
  const [, group, year, month, day, digest] = match
  const date = `${year}-${month}-${day}`
  // Reject impossible calendar dates the regex happily accepts (2026-02-30, 2026-13-01).
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  if (expectedGroup && group !== expectedGroup) return null
  return { group: group as DailyBatchGroupCode, date, digest: digest ?? null }
}

/** The batch's own date (`YYYY-MM-DD`) from a persisted reference, or null when it refuses. */
export function dailyBatchReferenceDate(
  referenceId: string | null | undefined,
  expectedGroup?: DailyBatchGroupCode,
): string | null {
  return parseDailyBatchReference(referenceId, expectedGroup)?.date ?? null
}

/** `YYYY-MM-DD` key derived from a stage stamp — the pre-migration fallback only. */
export function dailyBatchStampKey(stagedAt: Date | null | undefined): string | null {
  if (!stagedAt) return null
  const time = stagedAt.getTime()
  if (Number.isNaN(time)) return null
  return stagedAt.toISOString().slice(0, 10)
}

/**
 * One recreate bucket: the rows of a single daily batch, plus everything needed to
 * decide whether that batch is still live and to rebuild it under its own identity.
 */
export type DailyBatchRecreateBucket<TSummary> = {
  /** The referenceId a recreated log is written under: the persisted one when there is one. */
  referenceId: string
  /** The payload date: the BATCH's own date, falling back to the stamp key for legacy rows. */
  date: string
  /**
   * Where this bucket's identity came from. 'persisted' means `referenceId` IS the id the
   * batch's log was created under, so the probe can and MUST match it exactly; 'derived'
   * means the identity was reconstructed from a stage stamp and only approximates it.
   */
  identity: 'persisted' | 'derived'
  /** Persisted referenceIds seen on this bucket's rows — matched EXACTLY. */
  exactRefs: Set<string>
  /** Derived `<group>-<date>` keys from this bucket's stage stamps — matched as before. */
  derivedRefs: Set<string>
  summary: TSummary
}

/**
 * The referenceIds a live-log probe must cover for a bucket.
 *
 * The recreate sweep RE-POSTS journals, so a live log it fails to see becomes a DUPLICATE
 * journal nothing can take back out. That argues for probing as widely as possible — but
 * width has a symmetric failure the other way, and for a bucket whose identity is KNOWN it
 * is the worse of the two:
 *
 *   A split batch writes A1-D-aaaa and A1-D-bbbb on the same date. If the bbbb log is
 *   missing while aaaa is live, a probe that also matches the derived `A1-D` prefix sees
 *   aaaa, calls bbbb live, and bbbb's value is NEVER rebuilt — an understated ledger, and
 *   silent, because the sweep reports nothing to recreate.
 *
 * So: a bucket keyed on a PERSISTED reference probes that reference and nothing else. That
 * is not a narrowing in any meaningful sense — the persisted reference is by construction
 * the exact id its log was created under (the writers stamp the very string they hand to
 * createPendingSyncLog), so an exact match sees every log the batch could have. Nothing
 * rewrites a referenceId after the fact.
 *
 * Derived matching — the bare key AND, on Xero, the `<key>-<digest>` prefix that scjz.37
 * added — is what a bucket gets when its identity is NOT known: pre-migration rows, and
 * rows whose persisted reference refuses to parse. There, approximating widely is right,
 * because the alternative is posting a duplicate. An unparseable reference is still added
 * to `exact` on top, so those buckets only ever widen.
 *
 * Found by Codex adversarial review of this change (o3d-0qoo r1).
 */
export type DailyBatchLiveRefs = {
  /** Matched exactly. */
  exact: string[]
  /** Matched bare AND (Xero) as a `<key>-<digest>` prefix. Empty for a persisted identity. */
  derived: string[]
}

export function dailyBatchLiveRefs(bucket: {
  identity: 'persisted' | 'derived'
  exactRefs: Set<string>
  derivedRefs: Set<string>
}): DailyBatchLiveRefs {
  return {
    exact: [...bucket.exactRefs],
    derived: bucket.identity === 'persisted' ? [] : [...bucket.derivedRefs],
  }
}

/**
 * Fold one staged row into its batch's bucket, creating the bucket on first sight.
 *
 * Bucket key = the persisted reference when it parses, else the derived `<group>-<date>`
 * key (identical to the pre-persistence bucketing, so legacy rows behave exactly as they
 * did). A persisted reference that REFUSES to parse falls back to the derived key too,
 * but is still added to `exactRefs` so that bucket's live-log probe only ever widens.
 *
 * Splits matter here: two batches of the same group and date differ only by digest, so
 * they get two buckets and each must be probed on its OWN identity — see
 * `DailyBatchLiveRefs` for why a shared derived key would let a surviving split silently
 * suppress a missing one.
 *
 * Returns the bucket's summary for the caller to accumulate into, or null when the row
 * has no usable stage stamp (which the callers' queries already exclude).
 */
export function foldDailyBatchRow<TSummary>(
  buckets: Map<string, DailyBatchRecreateBucket<TSummary>>,
  group: DailyBatchGroupCode,
  row: { stagedAt: Date | null | undefined; persistedRef: string | null | undefined },
  makeSummary: () => TSummary,
): TSummary | null {
  const stampKey = dailyBatchStampKey(row.stagedAt)
  if (!stampKey) return null
  const derivedRef = `${group}-${stampKey}`
  const batchDate = dailyBatchReferenceDate(row.persistedRef, group)
  const usePersisted = batchDate !== null && !!row.persistedRef
  const key = usePersisted ? row.persistedRef! : derivedRef

  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = {
      referenceId: key,
      date: usePersisted ? batchDate! : stampKey,
      identity: usePersisted ? 'persisted' : 'derived',
      exactRefs: new Set<string>(),
      derivedRefs: new Set<string>(),
      summary: makeSummary(),
    }
    buckets.set(key, bucket)
  }
  if (row.persistedRef) bucket.exactRefs.add(row.persistedRef)
  bucket.derivedRefs.add(derivedRef)
  return bucket.summary
}
