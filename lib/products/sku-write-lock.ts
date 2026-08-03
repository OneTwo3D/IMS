import { WC_PRODUCT_WRITE_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

/**
 * THE protocol for serializing writers that create or rename a `Product.sku` (o3d-42hw).
 *
 * o3d-uh2/o3d-fsi gave the WooCommerce product-write transaction a per-SKU advisory lock so
 * two WC syncs could not both take the create branch. But an advisory lock is COOPERATIVE —
 * it only serializes writers that take it — and the other `Product.sku` writers did not:
 * the manual create, the variant create, the product editor and the CSV import all ran a
 * check-then-create with no lock at all.
 *
 * The consequences ran from wasteful to wrong:
 *
 *   - a manual create landing between the WC sync's lookup and its create raised a P2002 on
 *     `Product.sku`. That is SAFE today only because o3d-gtk deliberately keeps a sku P2002
 *     transient, so the retry finds the committed row and adopts it — at the cost of a
 *     wasted retry cycle. It is also the reason a sku P2002 cannot be classified permanent.
 *   - worse, the editor validated structure BEFORE its transaction and then wrote `type` /
 *     `parentId` unconditionally, so a WC import committing in between was overwritten with
 *     structure decided against a state that no longer existed.
 *
 * Every such writer now takes these locks as the FIRST statements of its write transaction
 * and re-checks inside it, which makes the lock actually serialize the whole population.
 *
 * ORDERING IS THE DEADLOCK ARGUMENT. Ids are acquired ascending, and sorting the IDS rather
 * than the SKUs is what makes it work: two payloads whose SKU sets overlap request their
 * shared lock ids in the same sequence, so the second blocks on the first shared id instead
 * of holding one while waiting on another the first already holds. Acquired one statement at
 * a time on purpose — a single set-returning statement would leave the acquisition sequence
 * up to the planner.
 *
 * The namespace is shared with the WooCommerce sync deliberately: one namespace is what
 * makes these writers contend with each other rather than with nobody.
 */

type LockClient = {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
}

/**
 * Resolve SKUs to their advisory-lock ids, deduplicated and sorted ASCENDING — the order
 * they must be acquired in.
 */
export async function resolveProductSkuLockIds(
  client: Pick<LockClient, '$queryRaw'>,
  skus: readonly string[],
): Promise<number[]> {
  const wanted = Array.from(new Set(skus.filter((sku) => sku.length > 0)))
  if (wanted.length === 0) return []

  const rows = (await client.$queryRaw`
    SELECT DISTINCT hashtext(sku) AS lock_id FROM unnest(${wanted}::text[]) AS sku
  `) as Array<{ lock_id: number | bigint }>

  return rows.map((row) => Number(row.lock_id)).sort((a, b) => a - b)
}

/**
 * Take the per-SKU write locks inside `tx`, in the one global order.
 *
 * MUST be the first statements of the transaction that will create or rename these SKUs:
 * taking them after a lookup reopens exactly the window they exist to close. They release
 * when the transaction commits or rolls back.
 */
export async function lockProductSkusForWrite(
  tx: LockClient,
  skus: readonly string[],
): Promise<void> {
  const lockIds = await resolveProductSkuLockIds(tx, skus)
  for (const lockId of lockIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_PRODUCT_WRITE_LOCK_NAMESPACE}::int4, ${lockId}::int4)`
  }
}

/**
 * A create that lost the race for its SKU under the write lock. Distinct from a raw P2002 so
 * callers can report it the same way their pre-transaction uniqueness check does, rather
 * than surfacing a Prisma error to the operator.
 */
export class ProductSkuTakenError extends Error {
  readonly sku: string

  constructor(sku: string) {
    super(`SKU "${sku}" was created by another writer while this one was in progress.`)
    this.name = 'ProductSkuTakenError'
    this.sku = sku
  }
}

/**
 * An update whose structure validation no longer held once re-checked under the write lock
 * (o3d-42hw) — another writer changed this product's type or parentage in between. The
 * caller reports it as a conflict rather than committing a decision made against a state
 * that no longer exists.
 */
export class ProductStructureChangedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductStructureChangedError'
  }
}
