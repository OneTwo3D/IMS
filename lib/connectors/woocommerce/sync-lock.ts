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
 * observes the rows the first committed and takes the update branch.
 *
 * This is a COOPERATIVE lock, and it removes the WC-sync-versus-WC-sync race only.
 * Other `Product` writers — the manual create in app/actions/products.ts, the CSV
 * import — do not take it, so a manual create landing between this transaction's
 * lookup and its create still raises a P2002 on `Product.sku`. That residual is why
 * o3d-gtk keeps a `sku` P2002 TRANSIENT: the retry finds the committed row and
 * adopts it. Making every `Product.sku` writer join this protocol is o3d-42hw.
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
 * Every SKU one product-write transaction touches, deduplicated (o3d-fsi).
 *
 * Order here is NOT the acquisition order — see `resolveWcProductWriteLockIds`.
 * Sorting the SKU strings would be the wrong invariant: the lock identity is
 * `hashtext(sku)`, and string order and 32-bit-hash order are unrelated
 * permutations. Two transactions could each be lexically sorted and still request
 * two shared hashes in opposite orders, which is a deadlock.
 */
export function wcProductWriteLockKeys(
  parentSku: string,
  variationSkus: readonly string[],
): string[] {
  return Array.from(new Set([parentSku, ...variationSkus]))
}

/**
 * Resolve SKUs to the advisory-lock ids they map to, deduplicated and sorted
 * ASCENDING BY ID — the order callers must acquire them in (o3d-fsi).
 *
 * Sorting the ids rather than the SKUs is what actually makes the multi-lock
 * acquisition deadlock-free: two payloads whose SKU sets overlap request their
 * shared LOCK IDS in the same sequence, so the second blocks on the first shared
 * id instead of holding one while waiting on another the first already holds.
 *
 * A genuine `hashtext` collision between two different SKUs collapses to ONE id.
 * That over-serializes two unrelated products, which is harmless, and — unlike
 * ordering by SKU — it cannot produce a crossed acquisition order.
 *
 * `hashtext` is deterministic and side-effect free, so this runs BEFORE the write
 * transaction opens: nothing here needs the transaction's snapshot, and resolving
 * it outside keeps the lock-hold window to the acquisitions themselves.
 */
export async function resolveWcProductWriteLockIds(
  client: { $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> },
  skus: readonly string[],
): Promise<number[]> {
  if (skus.length === 0) return []

  const rows = (await client.$queryRaw`
    SELECT DISTINCT hashtext(sku) AS lock_id FROM unnest(${skus}::text[]) AS sku
  `) as Array<{ lock_id: number | bigint }>

  return rows.map((row) => Number(row.lock_id)).sort((a, b) => a - b)
}
