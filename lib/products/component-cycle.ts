import { db } from '@/lib/db'

export type ComponentCycleResult =
  | { kind: 'ok' }
  | { kind: 'self' }
  | { kind: 'cycle' }

/**
 * Detect self-reference or circular references in the product component graph.
 *
 * `self` — one of `componentIds` is `productId` directly.
 * `cycle` — a path through existing `productComponent` rows leads back to `productId`.
 */
export async function detectComponentCycle(
  productId: string,
  componentIds: string[],
  /**
   * Client to walk the graph with. Defaults to the module-level `db`, which is what a
   * pre-transaction preflight uses.
   *
   * A caller deciding whether to WRITE must pass its `tx` (o3d-t0zq). Walking through `db`
   * from inside a transaction reads on a different connection — outside that transaction's
   * snapshot and outside the advisory lock it holds — so the check proves nothing about the
   * graph it is about to commit into. Same reason `validateProductStructureChange` takes a
   * client.
   */
  client: Pick<typeof db, 'productComponent'> = db,
): Promise<ComponentCycleResult> {
  if (componentIds.some((id) => id === productId)) return { kind: 'self' }

  const visited = new Set<string>()
  const queue = [...componentIds]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === productId) return { kind: 'cycle' }
    if (visited.has(current)) continue
    visited.add(current)

    const children = await client.productComponent.findMany({
      where: { productId: current },
      select: { componentId: true },
    })
    for (const child of children) queue.push(child.componentId)
  }

  return { kind: 'ok' }
}
