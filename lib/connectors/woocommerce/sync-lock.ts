/**
 * Coordination primitives shared between WooCommerce credential
 * mutations and in-flight stock syncs.
 *
 * The stock-sync path persists resolved `Product.externalProductId` values
 * incrementally across many `await`s. Without serialization, a
 * concurrent `saveWcCredentials` / `resetWcProductIdCache` could run
 * between a sync reading the version and writing a product row,
 * letting an old-store id land on top of a freshly wiped cache.
 *
 * Two primitives make that race impossible:
 *
 *   1. A Postgres transaction-scoped advisory lock, taken by BOTH the
 *      credential-mutation path and every externalProductId write inside the
 *      stock sync. Holders are serialized; the lock auto-releases on
 *      transaction commit or rollback.
 *
 *   2. A monotonic `wc_settings_version` Setting row. A rebind or
 *      cache reset bumps it inside the same advisory-lock-held
 *      transaction that wipes the cache. Stock sync snapshots this
 *      value at the start of its run (also under the advisory lock)
 *      and refuses to persist any mapping whose transaction observes
 *      a different version — proof that the credentials were mutated
 *      mid-run.
 *
 * Both the lock key and the setting key are referenced in multiple
 * files; they live here so the contract is explicit and the two
 * sides cannot drift out of sync.
 */

export const WC_SYNC_ADVISORY_LOCK_KEY = 918_273_645

export const WC_SETTINGS_VERSION_KEY = 'wc_settings_version'

/**
 * Namespace for the per-SKU advisory locks taken by the WC → IMS product write
 * transaction (o3d-uh2, o3d-fsi).
 *
 * `syncWcProductToIms` resolves each row by SKU and then creates or updates it.
 * Two workers importing the SAME WooCommerce product concurrently (a webhook
 * delivery racing the poll, or two inbox workers on a duplicated event) would
 * both observe "no such SKU" and both take the create branch — one of them then
 * dies on a `P2002` unique-constraint violation on `Product.sku`.
 *
 * That failure is indistinguishable, from the outside, from a genuine
 * deterministic mapping conflict, which is why o3d-gtk could not classify a
 * P2002 as permanent: doing so would discard a legitimate update. Taking
 * `pg_advisory_xact_lock(<this namespace>, hashtext(sku))` as the first
 * statements of the write transaction serializes those workers, so the second one
 * observes the rows the first committed and takes the update branch. A P2002 that
 * survives this is therefore a real conflict, not a race.
 *
 * This relies on the transaction running at READ COMMITTED (Prisma's default): the
 * blocked worker's SKU lookup takes a fresh snapshot after the lock is granted, so
 * it sees the row the other worker just committed. Raising the isolation level to
 * REPEATABLE READ would silently defeat the lock — the second worker would still be
 * reading its pre-lock snapshot and take the create branch anyway.
 *
 * The lock set covers the PARENT sku AND every variation sku the payload writes
 * (o3d-fsi). Keying on the parent alone left two DIFFERENT parents that share a
 * variation SKU taking DIFFERENT locks: both snapshot that variation as absent,
 * both create, and the loser's retry finds the winner's row and takes the UPDATE
 * branch — which overwrites `type`, `parentId` and `externalProductId`, silently
 * reparenting another product's row. Locking the whole set removes the race, and
 * `assertWcRowNotClaimedByAnotherWcObject` refuses the reparent that made the
 * residual damaging rather than merely noisy.
 *
 * Two-argument (int4, int4) form, so it shares no key space with the
 * single-argument (int8) `WC_SYNC_ADVISORY_LOCK_KEY` above.
 */
export const WC_PRODUCT_WRITE_LOCK_NAMESPACE = 918_273_646

/**
 * Every SKU one product-write transaction touches, deduplicated and in a single
 * global order (o3d-fsi).
 *
 * The sort is what makes the multi-lock acquisition deadlock-free: two payloads
 * with overlapping SKU sets request their shared keys in the same sequence, so the
 * second blocks on the first shared key instead of holding one and waiting on
 * another the first already holds. Callers MUST acquire in the returned order.
 */
export function wcProductWriteLockKeys(
  parentSku: string,
  variationSkus: readonly string[],
): string[] {
  return Array.from(new Set([parentSku, ...variationSkus])).sort()
}
