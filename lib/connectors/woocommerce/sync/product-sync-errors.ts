/**
 * Typed WooCommerce → IMS product-sync failures (o3d-fsi).
 *
 * `syncWcProductToIms` resolves every row it writes BY SKU, then takes an update branch
 * that overwrites `type`, `parentId` and `externalProductId`. That is correct while the
 * SKU it matched belongs to the WooCommerce object being imported. It is silent data
 * corruption when it does not: the import STEALS a row another WooCommerce product or
 * variation already owns, reparenting it and moving its external mapping.
 *
 * o3d-uh2's advisory locks (now covering the parent SKU and every variation SKU) remove
 * the concurrency path into that state. This module refuses the remaining, deterministic
 * path: WooCommerce genuinely holding one SKU on two different objects. Refusing is the
 * conservative direction — the import fails loudly with the two claimants named, instead
 * of succeeding while quietly rewriting a row that was never this payload's to write.
 */

/**
 * A SKU this payload wants is already mapped to a DIFFERENT WooCommerce object.
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
 * Throw unless the matched IMS row is free for this WooCommerce object to write.
 *
 * A row is writable when it is UNCLAIMED (`externalProductId` null — the ordinary
 * adopt-an-existing-IMS-product path on first import) or already claimed by this same
 * object. Any other value means a different WooCommerce product or variation owns it.
 *
 * Residual (deliberate): an unclaimed row is adopted even if it currently sits under a
 * different IMS parent. That is the initial-import path — an IMS-native catalogue being
 * taken over by WooCommerce — and blocking it would break the first sync of every
 * variable product. Only rows another WooCommerce object has already mapped are refused.
 */
export function assertWcRowNotClaimedByAnotherWcObject(
  row: { id: string; sku: string; externalProductId?: bigint | number | string | null },
  incomingWcId: number | bigint,
): void {
  // `== null` on purpose: an unset mapping reaches here as null from Prisma and as
  // undefined from any caller that selected a narrower row shape. Both mean UNCLAIMED,
  // and coercing undefined through BigInt() would throw a TypeError instead.
  if (row.externalProductId == null) return

  const incoming = BigInt(incomingWcId)
  if (BigInt(row.externalProductId) === incoming) return

  throw new WcSkuOwnershipConflictError({
    sku: row.sku,
    claimedByWcId: String(BigInt(row.externalProductId)),
    incomingWcId: String(incoming),
    imsProductId: row.id,
  })
}
