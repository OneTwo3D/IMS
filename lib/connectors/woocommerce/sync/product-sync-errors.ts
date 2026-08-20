/**
 * Typed WooCommerce → IMS product-sync failures, and the permanent/transient split
 * (o3d-fsi, o3d-gtk).
 *
 * o3d-i0y makes a failed product webhook retryable (HTTP 500) instead of acking it 200 and
 * stranding the product. That is right for a transient failure — a dropped connection, a lock
 * timeout, a WooCommerce 5xx — but wrong for a failure that re-runs to the identical outcome
 * every time. Those retry ~24 times into the inbox dead-letter queue and tell the operator
 * nothing they could not have been told on the first attempt.
 *
 * Two families of failure here are provably deterministic.
 */

// ---------------------------------------------------------------------------
// SKU ownership (o3d-fsi)
// ---------------------------------------------------------------------------

/**
 * `syncWcProductToIms` resolves every row it writes BY SKU, then takes an update branch
 * that overwrites `type`, `parentId` and `externalProductId`. That is correct while the
 * SKU it matched belongs to the WooCommerce object being imported. It is silent data
 * corruption when it does not: the import STEALS a row another WooCommerce product or
 * variation already owns, reparenting it and moving its external mapping.
 *
 * o3d-uh2's advisory locks (covering the parent SKU and every variation SKU) remove the
 * concurrency path into that state. This error covers the remaining, deterministic path:
 * WooCommerce genuinely holding one SKU on two different objects.
 *
 * Deterministic by construction: both claimants are identified by committed state, so a
 * retry re-reads the same rows and reaches the same conclusion. Nothing in the sync path
 * releases an `externalProductId`, so it stays true until someone fixes the SKU in
 * WooCommerce or unmaps the IMS row.
 */
export class WcSkuOwnershipConflictError extends Error {
  readonly sku: string
  /** The WooCommerce product/variation id that already owns the IMS row. */
  readonly claimedByWcId: string
  /** The WooCommerce product/variation id the current payload is importing. */
  readonly incomingWcId: string
  /** The IMS product id that would have been reparented. */
  readonly imsProductId: string

  constructor(args: { sku: string; claimedByWcId: string; incomingWcId: string; imsProductId: string }) {
    super(
      `SKU "${args.sku}" is already mapped to WooCommerce object ${args.claimedByWcId} ` +
        `(IMS product ${args.imsProductId}); refusing to reassign it to ${args.incomingWcId}. ` +
        `Resolve the duplicate SKU in WooCommerce, or clear the IMS product's external mapping.`,
    )
    this.name = 'WcSkuOwnershipConflictError'
    this.sku = args.sku
    this.claimedByWcId = args.claimedByWcId
    this.incomingWcId = args.incomingWcId
    this.imsProductId = args.imsProductId
  }
}

/** Duck-typed so a structured-clone / re-thrown copy across a boundary still matches. */
export function isWcSkuOwnershipConflict(error: unknown): boolean {
  return (
    error instanceof WcSkuOwnershipConflictError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'WcSkuOwnershipConflictError')
  )
}

/**
 * Throw unless the matched IMS row is free for this WooCommerce payload to write.
 *
 * A row is writable when it is UNCLAIMED (`externalProductId` null — the ordinary
 * adopt-an-existing-IMS-product path on first import) or already claimed by one of the
 * `claimants`: the WooCommerce object ids in THIS payload that legitimately resolve to
 * this SKU. Any other value means a different WooCommerce product or variation owns it.
 *
 * `claimants` is a SET, not a single id, because WooCommerce permits one SKU on several
 * variations of a single parent. The sync has always resolved that last-one-wins, so the
 * surviving row carries the LAST variation's id. Checking against only the variation
 * currently being applied would reject that row on every subsequent re-sync — the first
 * duplicate would find a row mapped to its sibling and refuse — turning a tolerated WC
 * quirk into a permanent import failure. Every id in the duplicate group is accepted.
 *
 * Residual (deliberate): an unclaimed row is adopted even if it currently sits under a
 * different IMS parent. That is the initial-import path — an IMS-native catalogue being
 * taken over by WooCommerce — and blocking it would break the first sync of every
 * variable product. Only rows another WooCommerce object has already mapped are refused.
 */
export function assertWcRowNotClaimedByAnotherWcObject(
  row: { id: string; sku: string; externalProductId?: bigint | number | string | null },
  claimants: number | bigint | ReadonlySet<bigint>,
): void {
  // `== null` on purpose: an unset mapping reaches here as null from Prisma and as
  // undefined from any caller that selected a narrower row shape. Both mean UNCLAIMED,
  // and coercing undefined through BigInt() would throw a TypeError instead.
  if (row.externalProductId == null) return

  const accepted: ReadonlySet<bigint> =
    typeof claimants === 'object' ? claimants : new Set([BigInt(claimants)])

  const claimedBy = BigInt(row.externalProductId)
  if (accepted.has(claimedBy)) return

  throw new WcSkuOwnershipConflictError({
    sku: row.sku,
    claimedByWcId: String(claimedBy),
    incomingWcId: [...accepted].map(String).join(', '),
    imsProductId: row.id,
  })
}

// ---------------------------------------------------------------------------
// Variation-count limits (o3d-jcx)
// ---------------------------------------------------------------------------

/**
 * The product has more variations than this sync is built to apply ATOMICALLY (o3d-jcx).
 *
 * fetchAllWcVariations trusted WooCommerce's `x-wp-totalpages` and retained every page in one
 * array with no page, item or time limit; the write transaction then built a second array from
 * it, issued one unbounded `sku IN (...)`, acquired one advisory lock per SKU and did 1-4
 * sequential writes per variation — all inside a 60-second budget. A large enough product
 * exhausted worker memory or ran the transaction out of time AFTER holding the parent lock and
 * every earlier variation row lock for most of a minute, and then rolled back and did it again.
 *
 * REFUSING BEFORE THE FIRST WRITE is strictly better than that, and better than the obvious
 * alternative of truncating: applying half a product's variations and reporting success is the
 * silent-incompleteness failure this connector's whole error story exists to avoid.
 *
 * PERMANENT, because it is a property of the product rather than of the moment: re-reading the
 * same product reaches the same count, so 24 retries into the dead-letter queue tell the operator
 * nothing the first attempt did not. The remedy is a person deciding — raise the supported limit
 * (and the transaction budget with it) or split the product in WooCommerce.
 */
export class WcVariationLimitExceededError extends Error {
  readonly wcParentId: number
  /** The limit that was breached. */
  readonly limit: number
  /** What WooCommerce reported or served. */
  readonly observed: number
  readonly unit: 'variations' | 'pages'

  constructor(args: { wcParentId: number; limit: number; observed: number; unit: 'variations' | 'pages' }) {
    super(
      `WooCommerce product ${args.wcParentId} has ${args.observed} ${args.unit} of variations, above the ` +
        `${args.limit} this sync can import in one atomic transaction. Nothing was written — importing ` +
        'part of a product and reporting success would leave the catalogue silently incomplete. Either ' +
        'split the product in WooCommerce, or raise MAX_WC_VARIATIONS_PER_PRODUCT together with ' +
        'PRODUCT_WRITE_TX_TIMEOUT_MS, which is the budget that limit is derived from.',
    )
    this.name = 'WcVariationLimitExceededError'
    this.wcParentId = args.wcParentId
    this.limit = args.limit
    this.observed = args.observed
    this.unit = args.unit
  }
}

/** Duck-typed so a structured-clone / re-thrown copy across a boundary still matches. */
export function isWcVariationLimitExceeded(error: unknown): boolean {
  return (
    error instanceof WcVariationLimitExceededError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'WcVariationLimitExceededError')
  )
}

// ---------------------------------------------------------------------------
// Unique-constraint conflicts (o3d-gtk)
// ---------------------------------------------------------------------------

/**
 * The other deterministic family is a Postgres unique-constraint violation (Prisma P2002)
 * on a MAPPING field of `Product`:
 *
 *   - `barcode` — the WC GTIN (`global_unique_id`) is already held by a DIFFERENT IMS product.
 *   - `externalProductId` — this WC product/variation id is already mapped to a DIFFERENT IMS
 *     product (typically a SKU rename in WooCommerce leaving the old row holding the id).
 *
 * WHY THOSE TWO ARE DETERMINISTIC, and `sku` is NOT
 * -------------------------------------------------
 * Postgres only raises 23505 against a COMMITTED row: a second inserter blocks on the unique
 * index until the first transaction commits (→ 23505) or aborts (→ it proceeds cleanly). So a
 * P2002 always means "some other row, already committed, holds this value". The question is
 * only whether a RETRY of this same payload would then succeed.
 *
 * `syncWcProductToIms` resolves its target row BY SKU. So:
 *
 *   - P2002 on `sku`: the committed row IS the row this payload wants. A retry finds it and
 *     takes the UPDATE branch, and succeeds. This is exactly the concurrent-create race, and it
 *     is why classifying P2002 wholesale as permanent would DISCARD a legitimate update.
 *     o3d-uh2's advisory locks — which since o3d-fsi cover the parent SKU AND every variation
 *     SKU — remove that race BETWEEN TWO WC SYNCS, and the o3d-fsi ownership guard turns the
 *     cross-object case into an explicit `WcSkuOwnershipConflictError` rather than a P2002.
 *     But the lock is COOPERATIVE and other `Product` writers do not take it: a manual create
 *     (app/actions/products.ts) or a CSV import landing between the lookup and the create
 *     still raises this. That is a live, modelled path — o3d-42hw — and it is precisely a
 *     recoverable race, because the retry finds the committed row and, since a manually
 *     created row carries no `externalProductId`, the ownership guard ADOPTS it. So `sku`
 *     stays TRANSIENT: retrying is not merely safe here, it is the fix.
 *
 *   - P2002 on `barcode` / `externalProductId`: the committed row is a DIFFERENT product (a
 *     different SKU). A retry looks the target up by SKU again, misses again, takes the create
 *     branch again, and re-hits the identical constraint. The value is never released on this
 *     path either — `barcode` is only ever written when the existing row has none, and never
 *     cleared. So the retry outcome is provably identical: PERMANENT.
 *
 * Marking only these two is the safe direction, matching `isPermanentStatusTransitionError`
 * (o3d-bx9): anything unrecognised stays transient and keeps retrying, so a new failure mode is
 * never silently acknowledged and lost.
 */

/** Product mapping columns whose unique violation is a deterministic conflict, not a race. */
const PERMANENT_CONFLICT_FIELDS = new Set(['barcode', 'externalProductId'])

/**
 * The same constraints by Postgres name, for the error shapes that report the constraint rather
 * than the column list. `Product` is `@@map`-less but its table is `products`.
 */
const PERMANENT_CONSTRAINT_NAMES = new Set(['products_barcode_key', 'products_externalProductId_key'])

const PERMANENT_CONSTRAINT_NAME_PATTERN = /unique constraint "(products_(?:barcode|externalProductId)_key)"/

type PrismaErrorish = {
  code?: unknown
  message?: unknown
  meta?: {
    modelName?: unknown
    target?: unknown
    driverAdapterError?: { cause?: { constraint?: { fields?: unknown }; originalMessage?: unknown } }
  }
}

/** P2002 is Prisma's unique-constraint violation. Duck-typed so a re-thrown copy still matches. */
function isUniqueConstraintViolation(error: unknown): error is PrismaErrorish {
  return typeof error === 'object' && error !== null && (error as PrismaErrorish).code === 'P2002'
}

/** `["\"externalProductId\""]` → `externalProductId`. The pg adapter quotes camelCase columns. */
function normalizeConflictName(raw: unknown): string {
  return String(raw).trim().replace(/^"+|"+$/g, '')
}

/**
 * The column list (or constraint name) the violation names, or null when the error does not say.
 *
 * Two shapes are handled because they are genuinely both live:
 *   - `meta.driverAdapterError.cause.constraint.fields` — what Prisma 7 + `@prisma/adapter-pg`
 *     actually produces here. Verified against the live database: a duplicate barcode yields
 *     `{ constraint: { fields: ["barcode"] } }` and NO `meta.target` at all.
 *   - `meta.target` — the classic query-engine shape, kept so this keeps working if the adapter
 *     is swapped out and so hand-built test doubles can use the documented field.
 */
function extractConflictNames(error: PrismaErrorish): string[] | null {
  const adapterFields = error.meta?.driverAdapterError?.cause?.constraint?.fields
  if (Array.isArray(adapterFields)) return adapterFields.map(normalizeConflictName)

  const target = error.meta?.target
  if (Array.isArray(target)) return target.map(normalizeConflictName)
  if (typeof target === 'string') return [normalizeConflictName(target)]

  return null
}

/**
 * Is this product-sync failure a permanent mapping conflict?
 *
 * Deliberately conservative. Beyond the explicit `WcSkuOwnershipConflictError`, it returns
 * true ONLY for a single-column P2002 on `Product.barcode` or `Product.externalProductId`; a
 * multi-column target (e.g. `ShoppingProductLink`'s `[connector, externalProductId]`), a
 * different model, a P2002 on `sku`, or an error that does not identify its constraint at all
 * all stay TRANSIENT and keep retrying.
 */
export function isPermanentProductSyncConflict(error: unknown): boolean {
  // o3d-fsi: raised only after both claimants have been read from committed state under the
  // SKU advisory locks, so a retry reaches the identical conclusion. Retrying it 24 times
  // tells nobody anything the first attempt did not.
  if (isWcSkuOwnershipConflict(error)) return true

  // o3d-jcx: a property of the product, not of the moment. Re-reading it reaches the same count.
  if (isWcVariationLimitExceeded(error)) return true

  if (!isUniqueConstraintViolation(error)) return false

  const modelName = error.meta?.modelName
  if (typeof modelName === 'string' && modelName !== 'Product') return false

  const names = extractConflictNames(error)
  if (names) {
    // A composite constraint can never be one of ours, and treating it as one would misclassify
    // another model's `[connector, externalProductId]` violation.
    if (names.length !== 1) return false
    return PERMANENT_CONFLICT_FIELDS.has(names[0]) || PERMANENT_CONSTRAINT_NAMES.has(names[0])
  }

  // Nothing structured to read: fall back to the constraint name Postgres puts in the message.
  const rawMessage = error.meta?.driverAdapterError?.cause?.originalMessage ?? error.message
  const match = typeof rawMessage === 'string' ? PERMANENT_CONSTRAINT_NAME_PATTERN.exec(rawMessage) : null
  return match !== null
}

/**
 * A transform the connector was CLEARED to make, refused because a blocker turned up after the
 * check (o3d-y89x r3/r4, Codex findings 2).
 *
 * Raised at two points, distinguished by `phase`, because the two have different answers:
 *
 *   - `'write'` — the conditional `UPDATE` matched zero rows. `PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE`
 *     is ANDed into the same statement that guards ownership, so a blocker committed before that
 *     statement's snapshot makes it match nothing and NOTHING WAS WRITTEN. The caller catches
 *     this, decides again WITH the summary, and reaches the identical outcome the pre-check
 *     would have reached — same refusal, same operator message, same quarantine.
 *   - `'commit'` — the re-assertion made as the transaction's last act, over every row this
 *     transaction structurally transformed. By then the writes ARE in the transaction, so there
 *     is no graceful second decision to take: the only correct answer is to abort the whole
 *     import and let the next attempt's pre-check refuse it properly. This one is deliberately
 *     NOT caught; it escapes to the top-level handler as a transient failure.
 *
 * NOT in {@link isPermanentProductSyncConflict}, and that is right for both phases: a blocker
 * clears by itself when the order ships or the stock moves, so a later retry can succeed.
 */
export class WcProductTransformBlockedError extends Error {
  readonly imsProductId: string
  readonly sku: string
  /** The editor's own operator-facing blocker summary, read under the write's transaction. */
  readonly summary: string
  /** Where the blocker was found: at the conditional write, or at the pre-commit re-assertion. */
  readonly phase: 'write' | 'commit'

  constructor(args: { imsProductId: string; sku: string; summary: string; phase?: 'write' | 'commit' }) {
    const phase = args.phase ?? 'write'
    super(
      phase === 'commit'
        ? `IMS product ${args.imsProductId} (SKU "${args.sku}") became live (${args.summary}) after this `
          + 'import had already transformed it, so the whole import was rolled back rather than committed '
          + 'against a row the product editor would now refuse to change. It will be retried.'
        : `IMS product ${args.imsProductId} (SKU "${args.sku}") became live while it was being imported `
          + `(${args.summary}); the structural write was refused by its own condition.`,
    )
    this.name = 'WcProductTransformBlockedError'
    this.imsProductId = args.imsProductId
    this.sku = args.sku
    this.summary = args.summary
    this.phase = phase
  }
}

/**
 * A conditional write matched zero rows and, by the time it was re-read, NO CAUSE COULD BE
 * OBSERVED AT ALL (o3d-y89x r4, Codex finding 3).
 *
 * The zero-row path diagnoses in order — row deleted, ownership taken, transform blocker — and
 * used to fall through to {@link WcSkuOwnershipConflictError} when none of them answered. That
 * is wrong in both halves. It is factually wrong: ownership had just been re-checked and found
 * INTACT, so the message named `externalProductId` as the claimant when that value is either
 * null or one of this very payload's ids. And it is wrong in kind: ownership conflicts are
 * PERMANENT (o3d-gtk), so a webhook was acknowledged and the operator sent to fix a duplicate
 * WooCommerce SKU that does not exist — for a condition that had already cleared itself.
 *
 * The state this really describes is a race that resolved: a blocker that appeared for the
 * UPDATE's snapshot and was gone again by the diagnostic SELECT (stock moving 0 → 5 → 0 is
 * enough), or a mapping reassigned and reassigned back. A cause that can no longer be observed
 * cannot be attributed, and the honest classification for "the condition moved under us" is
 * TRANSIENT — an immediate retry re-reads current state and can legitimately succeed.
 */
export class WcProductWriteRaceError extends Error {
  readonly imsProductId: string
  readonly sku: string

  constructor(args: { imsProductId: string; sku: string }) {
    super(
      `IMS product ${args.imsProductId} (SKU "${args.sku}") did not match its own write condition, but by `
        + 'the time it was re-read the cause had gone: it is still owned by this WooCommerce object and no '
        + 'transform blocker remains. Something changed and changed back while this import was running; '
        + 'retrying.',
    )
    this.name = 'WcProductWriteRaceError'
    this.imsProductId = args.imsProductId
    this.sku = args.sku
  }
}

/**
 * Thrown when `wc_settings_version` moved between an import's remote reads and its write
 * transaction (o3d-mlc7) — proof that credentials were rebound, or the product-id cache
 * reset, while this import was in flight.
 *
 * Everything the import is holding describes the OLD store, so none of it may be written:
 * writing it would repopulate store-A external ids on top of a freshly wiped mapping,
 * defeating the wipe and pointing later stock/product operations at unrelated remote
 * objects.
 *
 * Deliberately NOT a permanent conflict. Nothing is wrong with the product — the run was
 * simply overtaken — so the caller records FAILED without the PERMANENT_CONFLICT prefix and
 * the reconcile re-imports it against the new credentials.
 */
export class WcSettingsVersionChangedError extends Error {
  readonly expectedVersion: string
  readonly currentVersion: string

  constructor(expectedVersion: string, currentVersion: string) {
    super(
      `WooCommerce settings changed mid-import (version ${expectedVersion} -> ${currentVersion}): ` +
        'the credentials or product-id cache were replaced while this product was being read, so the ' +
        'data in hand belongs to the previous store and was not written. It will be re-imported.',
    )
    this.name = 'WcSettingsVersionChangedError'
    this.expectedVersion = expectedVersion
    this.currentVersion = currentVersion
  }
}
