import { db } from '@/lib/db'

export type ComponentCycleResult =
  | { kind: 'ok' }
  | { kind: 'self' }
  | { kind: 'cycle' }

/**
 * Client the reachability query runs on. Deliberately just `$queryRaw` — the walk is ONE
 * statement now, so nothing else is needed.
 */
export type ComponentCycleClient = Pick<typeof db, '$queryRaw'>

/**
 * Detect self-reference or circular references in the product component graph.
 *
 * `self` — one of `componentIds` is `productId` directly.
 * `cycle` — a path through existing `productComponent` rows leads back to `productId`.
 *
 * ONE RECURSIVE QUERY, not a query-per-node BFS (o3d-quia). The BFS this replaces issued one
 * round trip per visited node, unbounded, and o3d-t0zq made it the AUTHORITATIVE check running
 * inside the transaction that holds COMPONENT_GRAPH_WRITE_LOCK_KEY — the global component-write
 * lock. So a deep or wide graph blocked every other component writer for hundreds of sequential
 * round trips and could exceed Prisma's 5s interactive-transaction timeout, failing in a way
 * that looks nothing like "your graph is deep". The CSV import repeated that per row.
 *
 * `UNION`, not `UNION ALL`: it deduplicates the frontier, which is what makes this terminate on
 * a graph that ALREADY contains a cycle. The check exists precisely because such a graph is
 * reachable, so termination must not rest on the graph being acyclic. (The old BFS relied on
 * its `visited` set for the same reason.)
 *
 * Fails CLOSED by construction — there is no node or depth bound to hit. Any bound added later
 * MUST refuse the write when reached rather than answer "no cycle", or the bound becomes a way
 * to smuggle a cycle past the check.
 */
export async function detectComponentCycle(
  productId: string,
  componentIds: string[],
  /**
   * Client to run the reachability query on. Defaults to the module-level `db`, which is what a
   * pre-transaction preflight uses.
   *
   * A caller deciding whether to WRITE must pass its `tx` (o3d-t0zq). Querying through `db`
   * from inside a transaction reads on a different connection — outside that transaction's
   * snapshot and outside the advisory lock it holds — so the check proves nothing about the
   * graph it is about to commit into. Same reason `validateProductStructureChange` takes a
   * client.
   */
  client: ComponentCycleClient = db,
): Promise<ComponentCycleResult> {
  if (componentIds.some((id) => id === productId)) return { kind: 'self' }

  const roots = [...new Set(componentIds.filter(Boolean))]
  if (roots.length === 0) return { kind: 'ok' }

  // Reachability from the proposed components: if `productId` is reachable from any of them,
  // adding these edges closes a loop back to it.
  const rows = await client.$queryRaw<Array<{ reached: boolean }>>`
    WITH RECURSIVE reachable(id) AS (
      SELECT unnest(${roots}::text[])
      UNION
      SELECT pc."componentId"
      FROM product_components pc
      JOIN reachable r ON pc."productId" = r.id
    )
    SELECT TRUE AS reached FROM reachable WHERE id = ${productId} LIMIT 1
  `

  return rows.length > 0 ? { kind: 'cycle' } : { kind: 'ok' }
}
